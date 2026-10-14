/**
 * "Set Up MicroPython IntelliSense..." and "Remove ... IntelliSense Files..." (D-05, D-15, RQ-GEN-1..4).
 *
 * The library (src/intellisense) is pure; this file is the VS Code side:
 *   collect  workspace folder, board (connected session > setting > unknown); from a connected, IDLE board its own modules
 *            (board.ts: listing + library folders; copies of its .py files; imports only with the student's yes, asked once per
 *            firmware, then one soft reset). Never while a program runs. Firmware source folders on the computer are never used.
 *   plan     planFix (pure), nothing is written yet
 *   preview  an untitled Markdown document: what will be written / removed / left alone, warnings, the exact consent items
 *   consent  the prompter (QuickPick multi-select or one modal button; scripted in tests)
 *   apply    applyPlan, then a toast that does not block, with a "Show what changed" button
 * A second run that finds nothing to do says "Everything is already set up". Files of the user (pyrightconfig.json,
 * pyproject.toml, settings.json) are touched only as the library does it: created once with consent, never rewritten.
 */
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../contributes';
import { IDENTITY, stateKey } from '../identity';
import {
  TRACKER_REL, applyPlan, gatherBoardStubs, localModuleNames, nodeClock, nodeFs, parseTracker, planFix, prepareFixInputs, readWorkspaceState,
  removeManaged, stockModuleNames,
  type ApplyResult, type BoardAccess, type BoardInfo, type BoardPart, type Consent, type FixDeps, type FixRequest, type ImportAnswer,
  type IntelliSensePlan, type PlanInputs, type PlanWarning, type RemoveResult,
} from '../intellisense';
import { errMessage, readTextIfExists, sha256Hex } from '../intellisense/util';
import { renderPlanMarkdown, renderRemoveDetail, renderResultMarkdown, removeToast, resultToast } from '../intellisense/preview';
import type { Logger } from '../log';
import { showToast } from '../toast';
import type { BoardIdentity } from '../types/protocol';
import type { Services } from '../types/services';
import { userMessage } from '../types/session';
import type { IntelliSensePrompter } from './intellisensePrompts';

/** Argument of the fix command (the quick fix and the first-connect offer pass it; a menu or the palette passes nothing). */
export interface FixArgs {
  /** fsPath of the workspace folder (or of a file inside it). */
  folder?: string;
  source?: 'palette' | 'quickfix' | 'offer' | 'row';
}

export type FixStatus = 'no-folder' | 'busy' | 'board-busy' | 'up-to-date' | 'cancelled' | 'applied' | 'failed';

export interface FixOutcome {
  status: FixStatus;
  folder?: string;
  summary?: string;
  written?: string[];
  removed?: string[];
  errors?: { path: string; message: string }[];
  consent?: Consent;
  /** Ids of the consent items the plan asked for (before the answer). */
  asked?: string[];
  warnings?: string[];
  /** What happened on the board: modules imported (with the student's yes) and whether one soft reset followed. */
  board?: { imported: string[]; softReset: boolean; answer: string; modules: string[] };
}

/** workspaceState: per firmware key, the answer to "import these modules on the board to learn what they contain?". */
export const IMPORT_ANSWERS_KEY = stateKey('intellisense.boardImports');
/** Remembered answer of the removed "use the firmware folder next to this project" question; deleted when seen. */
const OLD_FOLDERS_KEY = stateKey('intellisense.agreedFirmwareFolders');

export interface IntelliSenseDeps {
  prompter: IntelliSensePrompter;
  /** Where `resources/stubs` is; defaults to `<extension>/resources/stubs` from the extension context (never the working directory). */
  resourcesDir?: string;
  deps?: FixDeps;
  /** How long to wait for the board identity of a board that is connected but has not been probed yet. Default 6000 ms. */
  identityWaitMs?: number;
  /** Folder for the temporary downloads of board files; default: below the extension's global storage. */
  stagingDir?: string;
}

export function boardInfoFrom(id: BoardIdentity | null): BoardInfo | null {
  if (id === null) { return null; }
  return {
    impl: id.impl, version: id.version, machine: id.machine, build: id.build, platform: id.platform, uniqueId: id.uniqueId,
    uname: { sysname: id.uname.sysname, machine: id.uname.machine, release: id.uname.release },
  };
}

function boardNote(board: BoardInfo | null, stubsSetting: string): string {
  if (board !== null) {
    return `Board: connected, ${board.machine || board.platform || 'unknown'} running MicroPython ${board.version.join('.')}${board.build ? ` (build ${board.build})` : ''}. The matching built-in stubs are chosen from this.`;
  }
  if (stubsSetting === 'off') { return 'Board: none. Built-in stubs are switched off in the settings.'; }
  if (stubsSetting !== 'auto') { return `Board: not connected. The setting names the "${stubsSetting}" family, so those stubs are used.`; }
  return 'Board: not connected, so only the standard MicroPython library stubs are set up. Connect your board and run this again to add the stubs for its family (machine, network, ...), or name the family in the setting "intellisenseStubs".';
}

export class IntelliSenseController {
  private readonly deps: FixDeps;
  /** One flag for both commands: Remove while a setup waits for its answer would be undone by the late yes (and the other way round). */
  private busy: 'fix' | 'remove' | undefined;
  private lastRun: FixOutcome | undefined;

  constructor(private readonly services: Services, private readonly parts: IntelliSenseDeps) {
    this.deps = parts.deps ?? { fs: nodeFs(), clock: nodeClock() };
  }

  get last(): FixOutcome | undefined { return this.lastRun; }
  private get log(): Logger { return this.services.log; }
  private importAnswers(): Record<string, ImportAnswer> {
    const v = this.services.context.workspaceState.get<unknown>(IMPORT_ANSWERS_KEY);
    const out: Record<string, ImportAnswer> = {};
    if (typeof v === 'object' && v !== null) {
      for (const [k, a] of Object.entries(v)) { if (a === 'continue' || a === 'skip') { out[k] = a; } }
    }
    return out;
  }
  private get resourcesDir(): string {
    return this.parts.resourcesDir ?? this.deps.fs.path.join(this.services.context.extensionUri.fsPath, 'resources', 'stubs');
  }

  // ------------------------------------------------------------------ the folder

  private async pickFolder(args: FixArgs | undefined): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    if (folders.length === 0) { return undefined; }
    const containing = (p: string | undefined): vscode.WorkspaceFolder | undefined => (p === undefined ? undefined : vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p)));
    const requested = containing(args?.folder) ?? containing(vscode.window.activeTextEditor?.document.uri.scheme === 'file' ? vscode.window.activeTextEditor.document.uri.fsPath : undefined);
    if (requested !== undefined && requested.uri.scheme === 'file') { return requested; }
    if (folders.length === 1) { return folders[0]; }
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { title: 'Set up MicroPython IntelliSense', placeHolder: 'Which folder holds your MicroPython project (the one mirrored to the board)?' },
    );
    return picked?.folder;
  }

  // ------------------------------------------------------------------ fix

  async fix(args?: FixArgs): Promise<FixOutcome> {
    if (this.busy !== undefined) {
      void showToast(this.log, 'info', this.busy === 'remove' ? 'The MicroPython IntelliSense files are being removed. Wait for it to finish.' : 'MicroPython IntelliSense is already being set up. Wait for it to finish.');
      return { status: 'busy' };
    }
    this.busy = 'fix';
    try {
      const outcome = await this.fixOnce(args);
      this.lastRun = outcome;
      return outcome;
    } catch (err) {
      this.log.error('the IntelliSense setup failed', err);
      void showToast(this.log, 'error', `MicroPython IntelliSense could not be set up: ${userMessage(err)} Choose "Show Log" from the Command Palette for details.`);
      this.lastRun = { status: 'failed', errors: [{ path: '', message: userMessage(err) }] };
      return this.lastRun;
    } finally {
      this.busy = undefined;
    }
  }

  /**
   * The identity is read right after the prompt appears, so a student who connects and at once runs the setup would get stubs for
   * "no board". When a board is connected but not probed yet, wait a few seconds for the answer.
   */
  private async identity(): Promise<BoardIdentity | null> {
    const { session } = this.services;
    const now = session.state;
    if (now.identity !== null || now.port === null || now.state === 'disconnected') { return now.identity; }
    // the wait can last seconds: show that something is happening, or the student clicks again and gets only a "busy" message
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading your board...' }, () => new Promise<BoardIdentity | null>((resolve) => {
      const done = (id: BoardIdentity | null): void => { clearTimeout(timer); subscription.dispose(); resolve(id); };
      const timer = setTimeout(() => { this.log.info('the board identity did not arrive in time; the stubs are chosen without it'); done(session.state.identity); }, this.parts.identityWaitMs ?? 6000);
      const subscription = session.onDidChangeState((s) => { if (s.identity !== null || s.state === 'disconnected') { done(s.identity); } });
    }));
  }

  private async request(workspace: string): Promise<{ req: FixRequest; board: BoardInfo | null; identity: BoardIdentity | null }> {
    const { settings } = this.services;
    const identity = await this.identity();
    const board = boardInfoFrom(identity);
    const stubs = settings.intellisenseStubs === 'off' ? 'off' : board !== null ? 'auto' : settings.intellisenseStubs;
    // Sync mirrors the FIRST workspace folder only (src/sync/service.ts); the language server finds the config in the workspace folder itself
    const first = vscode.workspace.workspaceFolders?.[0];
    const req: FixRequest = {
      workspace, resourcesDir: this.resourcesDir, board, stubs,
      ...(first !== undefined && first.uri.scheme === 'file' ? { mirrorRoot: first.uri.fsPath } : {}),
    };
    return { req, board, identity };
  }

  /** The session as the library sees it (board.ts). Every call goes through the bridge, the only owner of the port. */
  private boardAccess(): BoardAccess {
    const { session } = this.services;
    return {
      introspect: async (names) => session.call('introspect.modules', names === undefined ? {} : { names }, { timeoutMs: 60_000 + 6_000 * (names?.length ?? 0) }),
      list: async (path) => (await session.call('fs.list', { path }, { timeoutMs: 30_000 })).entries,
      get: async (remote, local) => { await session.call('fs.get', { remote, local }, { timeoutMs: 60_000 }); },
      // skipMain: the student's main.py (which may drive motors) must not start as a side effect of setting up IntelliSense
      softReset: async () => { await session.call('reset.soft', { skipMain: true }, { timeoutMs: 30_000 }); },
    };
  }

  /**
   * The modules of the board itself. Needs a connected, IDLE board: while a program runs nothing is read ('busy'). Without a board
   * the files an earlier run made from it are kept. Automatic runs (quick fix, first-connect offer) only read the module listing
   * when the firmware did not change since the last run.
   */
  private async boardPart(inputs: PlanInputs, identity: BoardIdentity | null, board: BoardInfo | null, explicit: boolean): Promise<{ part: BoardPart; warnings: PlanWarning[] } | 'busy'> {
    const { session } = this.services;
    const s = session.state;
    if (identity === null || board === null || (s.state !== 'idle' && s.state !== 'rawop' && s.state !== 'running')) {
      return { part: { kind: 'keep', note: 'Your board is not connected, so the files made from it earlier are kept as they are. Connect it and run this again to update them.' }, warnings: [] };
    }
    if (session.isRunning || s.state === 'running') { return 'busy'; }
    const { fs } = this.deps;
    const tracker = parseTracker(inputs.state.texts[TRACKER_REL] ?? null);
    const workspace = inputs.workspace;
    try {
      const local = await localModuleNames(fs, workspace, new Set(Object.keys(tracker?.files ?? {})));
      const staging = this.parts.stagingDir ?? fs.path.join(this.services.context.globalStorageUri.fsPath, `board-files-${Date.now().toString(36)}`);
      const answers = this.importAnswers();
      const stubs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading the modules of your board...' }, () => gatherBoardStubs(fs, this.boardAccess(), {
        board, syspath: identity.syspath, stock: stockModuleNames(inputs.stock?.pack ?? null), local, stagingDir: staging, now: this.deps.clock.now(),
        previous: tracker?.board ?? null,
        ...(!explicit && tracker?.board != null ? { unchangedKey: tracker.board.key } : {}),
        askImport: async ({ key, label, modules }) => {
          const before = answers[key];
          // one question per firmware; a "Skip" holds until the student runs the command again
          if (before === 'continue' || (before === 'skip' && !explicit)) { return before; }
          const answer = await this.parts.prompter.importModules({ modules, label });
          if (answer !== undefined) { await this.services.context.workspaceState.update(IMPORT_ANSWERS_KEY, { ...answers, [key]: answer }); }
          this.log.info(`importing ${modules.join(', ')} on the board to describe them: ${answer ?? 'dismissed (skipped this time)'}`);
          return answer ?? 'skip';
        },
      }));
      if (stubs === null) { return { part: { kind: 'keep' }, warnings: [] }; }
      this.log.info(`board modules (${stubs.label}): ${stubs.modules.map((m) => `${m.name}=${m.how}`).join(', ') || 'none beyond stock MicroPython'}; imported: ${stubs.imported.join(', ') || 'nothing'}; soft reset: ${stubs.softReset}`);
      return { part: { kind: 'fresh', stubs }, warnings: [] };
    } catch (err) {
      if (/E_PROGRAM_RUNNING/.test(`${(err as { code?: string }).code ?? ''} ${errMessage(err)}`)) { return 'busy'; }
      this.log.warn('the board could not be read for IntelliSense', err);
      return {
        part: { kind: 'keep' },
        warnings: [{ code: 'W_BOARD_UNREADABLE', message: `The modules of your board could not be read (${userMessage(err)}). Files made from it earlier are kept. Check the connection and run this again.` }],
      };
    }
  }

  private async fixOnce(args: FixArgs | undefined): Promise<FixOutcome> {
    const folder = await this.pickFolder(args);
    if (folder === undefined) {
      void showToast(this.log, 'info', `Open the folder that holds your MicroPython files first (File > Open Folder), then run "${COMMAND_TITLE.fix}" again.`);
      return { status: 'no-folder' };
    }
    const workspace = folder.uri.fsPath;
    const memento = this.services.context.workspaceState;
    if (memento.get<unknown>(OLD_FOLDERS_KEY) !== undefined) { await memento.update(OLD_FOLDERS_KEY, undefined); } // firmware folders are no longer used
    const { req, board, identity } = await this.request(workspace);
    const none: Consent = { createUserConfig: false, editSettings: false };
    const inputs = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Looking at your project for MicroPython IntelliSense...' },
      () => prepareFixInputs(this.deps, { ...req, consent: none }),
    );
    const explicit = args?.source === undefined || args.source === 'palette' || args.source === 'row';
    const fromBoard = await this.boardPart(inputs, identity, board, explicit);
    if (fromBoard === 'busy') {
      const text = `A program is running on your board, so MicroPython IntelliSense cannot read the board's modules now. Press Stop (Board Actions), then run "${COMMAND_TITLE.fix}" again.`;
      this.log.info(text);
      void showToast(this.log, 'warning', text);
      return { status: 'board-busy', folder: workspace };
    }
    inputs.board = fromBoard.part;
    inputs.warnings = [...(inputs.warnings ?? []), ...fromBoard.warnings];
    const fresh = fromBoard.part.kind === 'fresh' ? fromBoard.part.stubs : null;
    const boardFacts = fresh === null ? undefined : { imported: fresh.imported, softReset: fresh.softReset, answer: fresh.answer, modules: fresh.modules.map((m) => `${m.name}:${m.how}`) };
    const plan = planFix({ ...inputs, consent: none });
    // A link that the plan would have to write or delete behind: refuse before anything is shown or asked (applyPlan refuses again at the moment of writing)
    const touched = [...plan.writes.map((w) => w.path), ...plan.removes.map((r) => r.path), TRACKER_REL];
    const blocked = (inputs.state.links ?? []).filter((l) => touched.some((t) => t === l || t.startsWith(`${l}/`)));
    if (blocked.length > 0) { return this.refuseLinks(workspace, blocked); }
    const context = { boardNote: boardNote(board, this.services.settings.intellisenseStubs) };
    const base: FixOutcome = {
      status: 'cancelled', folder: workspace, summary: plan.summary, asked: plan.consent.map((c) => c.id), warnings: plan.warnings.map((w) => w.code),
      ...(boardFacts !== undefined ? { board: boardFacts } : {}),
    };
    this.log.info(`IntelliSense plan for ${workspace}: ${plan.summary}`);

    if (plan.writes.length === 0 && plan.removes.length === 0 && plan.settingsEdits.every((e) => e.action !== 'add') && plan.consent.length === 0) {
      const text = 'Everything is already set up for MicroPython IntelliSense. Nothing needed to change.';
      const details = plan.warnings.length > 0 ? 'Show details' : undefined;
      void showToast(this.log, 'info', details ? `${text} ${plan.warnings.length} note(s) are in the details.` : text, ...(details ? [details] : []))
        .then((choice) => (choice === details ? this.openMarkdown(renderPlanMarkdown(plan, context)) : undefined))
        .catch((err: unknown) => this.log.error('could not show the IntelliSense details', err));
      return { ...base, status: 'up-to-date' };
    }

    await this.openMarkdown(renderPlanMarkdown(plan, context));
    const answer = await this.parts.prompter.choose(plan);
    if (answer === undefined) {
      this.log.info('IntelliSense setup cancelled by the user; nothing was written');
      return base;
    }
    const consent: Consent = { ...answer };
    // The answer can change the plan (a user config to create, settings to add), so plan again with it.
    const finalPlan = planFix({ ...inputs, consent });
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Writing the MicroPython IntelliSense files...' },
      () => applyPlan(finalPlan, this.deps.fs, this.deps.clock),
    );
    this.report(finalPlan, result);
    return {
      ...base, status: result.errors.length > 0 && result.written.length === 0 ? 'failed' : 'applied', summary: finalPlan.summary, consent,
      written: result.written, removed: result.removed, errors: result.errors, warnings: finalPlan.warnings.map((w) => w.code),
    };
  }

  private refuseLinks(workspace: string, links: string[]): FixOutcome {
    const text = `MicroPython IntelliSense was not set up: ${links.join(', ')} ${links.length === 1 ? 'is a link' : 'are links'} to another place, and this extension never writes or deletes through a link (that could change files outside your project). Delete the link itself, not the folder it points to, then run "${COMMAND_TITLE.fix}" again.`;
    this.log.error(text);
    void showToast(this.log, 'error', text);
    this.lastRun = { status: 'failed', folder: workspace, errors: links.map((path) => ({ path, message: 'is a link' })), warnings: ['W_LINK_IN_MANAGED_AREA'] };
    return this.lastRun;
  }

  /** The toast after applying: it never holds the command (a toast with a button is answered in the background). */
  private report(plan: IntelliSensePlan, result: ApplyResult): void {
    this.log.info(`IntelliSense applied: ${result.written.length} written, ${result.removed.length} removed, ${result.errors.length} error(s)`);
    for (const e of result.errors) { this.log.error(`IntelliSense could not write ${e.path}: ${e.message}`); }
    const toast = resultToast(plan, result);
    void showToast(this.log, toast.level, toast.text, 'Show what changed')
      .then((choice) => (choice === 'Show what changed' ? this.openMarkdown(renderResultMarkdown(plan, result)) : undefined))
      .catch((err: unknown) => this.log.error('could not show what changed', err));
  }

  private async openMarkdown(content: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
  }

  // ------------------------------------------------------------------ remove

  async remove(args?: FixArgs): Promise<RemoveResult | undefined> {
    if (this.busy !== undefined) {
      void showToast(this.log, 'info', this.busy === 'fix' ? 'MicroPython IntelliSense is being set up. Wait for it to finish, then remove the files.' : 'The MicroPython IntelliSense files are already being removed. Wait for it to finish.');
      return undefined;
    }
    this.busy = 'remove';
    try {
      return await this.removeOnce(args);
    } finally {
      this.busy = undefined;
    }
  }

  private async removeOnce(args: FixArgs | undefined): Promise<RemoveResult | undefined> {
    const folder = await this.pickFolder(args);
    if (folder === undefined) {
      void showToast(this.log, 'info', `Open the folder first (File > Open Folder), then run "${COMMAND_TITLE.remove}" again.`);
      return undefined;
    }
    const workspace = folder.uri.fsPath;
    try {
      const { fs, clock } = this.deps;
      const state = await readWorkspaceState(fs, workspace, clock);
      const tracker = parseTracker(state.texts[TRACKER_REL] ?? null);
      if (tracker === null) {
        const result: RemoveResult = { removed: [], keptEdited: [], settingsRemoved: [], settingsKept: [], errors: [], nothingToDo: true };
        const damaged = (state.texts[TRACKER_REL] ?? null) !== null;
        void showToast(this.log, damaged ? 'warning' : 'info', damaged
          ? `${TRACKER_REL} is damaged, so the extension cannot tell which files are its own and removes nothing. Delete the ${IDENTITY.dotDir} folder yourself if you want it gone.`
          : removeToast(result).text);
        return result;
      }
      // an edited pyrightconfig.json stays (removeManaged compares the text hash); here only the wording of the confirmation
      const edited = await Promise.all(Object.entries(tracker.createdOnce).map(async ([rel, sha]) => {
        const text = await readTextIfExists(fs, fs.path.join(workspace, ...rel.split('/'))).catch(() => null);
        return { path: rel, edited: text !== null && sha256Hex(text) !== sha };
      }));
      // a listed file outside the dot folder (typings/) is deleted only while it still has the recorded content (removeManaged does the same)
      const changed = new Set<string>();
      for (const [rel, sha] of Object.entries(tracker.files)) {
        if (rel.startsWith(`${IDENTITY.dotDir}/`)) { continue; }
        const bytes = await fs.readFile(fs.path.join(workspace, ...rel.split('/'))).catch(() => null);
        if (bytes !== null && sha256Hex(bytes) !== sha) { changed.add(rel); }
      }
      const detail = renderRemoveDetail({
        files: [...Object.keys(tracker.files).filter((rel) => !changed.has(rel)), TRACKER_REL],
        createdOnce: [...edited, ...[...changed].map((path) => ({ path, edited: true }))],
        settings: tracker.settings.map((s) => s.key),
        links: state.links ?? [],
      });
      if (!(await this.parts.prompter.confirmRemove(detail))) {
        this.log.info('IntelliSense removal cancelled by the user');
        return undefined;
      }
      const result = await removeManaged(fs, clock, workspace);
      this.log.info(`IntelliSense removed ${result.removed.length} file(s); kept edited: ${result.keptEdited.join(', ') || 'none'}`);
      for (const e of result.errors) { this.log.error(`IntelliSense could not remove ${e.path}: ${e.message}`); }
      // a removal also withdraws the remembered answers about importing the board's modules: the next setup asks again
      if (result.removed.length > 0) { await this.services.context.workspaceState.update(IMPORT_ANSWERS_KEY, undefined); }
      const toast = removeToast(result);
      void showToast(this.log, toast.level, toast.text);
      return result;
    } catch (err) {
      this.log.error('removing the IntelliSense files failed', err);
      void showToast(this.log, 'error', `The IntelliSense files could not be removed: ${userMessage(err)} Choose "Show Log" from the Command Palette for details.`);
      return undefined;
    }
  }
}

const COMMAND_TITLE = { fix: 'Set Up MicroPython IntelliSense...', remove: `Remove ${IDENTITY.displayName} IntelliSense Files...` } as const;

/** Registers both commands. The command argument is optional: `{ folder, source }`. */
export function registerIntelliSenseCommands(controller: IntelliSenseController): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(COMMAND_IDS.fixIntelliSense, (arg?: unknown) => controller.fix(asArgs(arg))),
    vscode.commands.registerCommand(COMMAND_IDS.removeIntelliSense, (arg?: unknown) => controller.remove(asArgs(arg))),
  ];
}

function asArgs(arg: unknown): FixArgs | undefined {
  if (typeof arg !== 'object' || arg === null) { return undefined; }
  const a = arg as { folder?: unknown; source?: unknown };
  return {
    ...(typeof a.folder === 'string' ? { folder: a.folder } : {}),
    ...(a.source === 'quickfix' || a.source === 'offer' || a.source === 'row' || a.source === 'palette' ? { source: a.source } : {}),
  };
}
