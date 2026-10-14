/**
 * SyncService: the one object the rest of the extension talks to for syncing. It owns the engine, auto-sync and the badges,
 * builds plans (scan the project, ask the board for its manifest, 3-way compare against the baseline) and runs the
 * flows behind the commands: Upload all, Download all, Upload current file, Clear device files, the dry run.
 * Implements SyncGate (Run flushes pending uploads), SyncStatusSource (Files-view badges) and BoardChangeSource (the Files view
 * re-lists the folders whose files the engine or a board-file command changed).
 */
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import * as vscode from 'vscode';
import { boardDocumentUri, isBoardDocumentUri } from '../boardScheme';
import { COMMAND_IDS } from '../contributes';
import { showToast } from '../toast';
import type { BoardIdentity, ManifestEntry } from '../types/protocol';
import type { SelectPortArgs, Services } from '../types/services';
import { BoardError, userMessage } from '../types/session';
import type {
  BoardChangeSource, BoardNode, LocalOnlyEntry, SyncBadge, SyncGate, SyncItem, SyncItemResult, SyncPlan, SyncResult,
  SyncStatusDetail, SyncStatusSource,
} from '../types/sync';
import { AutoSync, type AutoSyncHost, type FolderContext, type Scheduler } from './autosync';
import { BaselineStore, boardKeyOf, workspaceKeyOf, type BoardKey } from './baseline';
import { Consent, askToInterrupt, callWithConsent, isAborted } from './boardAccess';
import { SyncEngine } from './engine';
import { IgnoreMatcher, createDefaultIgnoreFile, loadIgnoreMatcher } from './ignore';
import { scanLocal, sha256File, type ScanOptions, type ScanResult } from './localScan';
import { PathError, PathMapper, hostIsCaseInsensitive, importRootsFrom, type PathFlavor } from './paths';
import { buildPlan, classifyOne, type PlanBoardEntry, type PlanInput } from './plan';
import { confirmPlan, previewPlan, previewRows } from './preview';
import { stateKey } from './state';
import { SyncStatus, badgeOfReason } from './status';
import { legendText } from '../views/syncHelp';

export interface SyncServiceOptions {
  /** Path rules of the "host" for local paths: `path.win32` in tests that check Windows behaviour. */
  flavor?: PathFlavor;
  localCaseInsensitive?: boolean;
  now?: () => Date;
  scheduler?: Scheduler;
  scan?: ScanOptions;
  /** Where baselines, backups and temporary files live. Defaults to `context.storageUri`. */
  storageDir?: string;
}

export interface Prepared {
  ctx: FolderContext;
  board: BoardKey;
  identity: BoardIdentity;
  plan: SyncPlan;
  scan: ScanResult;
}

/**
 * Where the project keeps the file that lives at a board path. `file`: it is there. `missing`: the path is inside the mirrored
 * folder but the project has no such file (a folder of that name counts as missing, so nothing is ever overwritten by mistake).
 */
export type LocalCounterpart =
  | { readonly kind: 'no-folder' }
  | { readonly kind: 'unmapped'; readonly why: string }
  | { readonly kind: 'file'; readonly abs: string; readonly rel: string }
  | { readonly kind: 'missing'; readonly abs: string; readonly rel: string };

/**
 * The first link (symbolic link, junction) on the way from the project folder down to `rel`, as a project-relative path; undefined
 * when there is none or the path ends where nothing exists yet. A link AT or above the project folder (a OneDrive alias of the
 * project) is the student's own business and is followed.
 */
async function linkInProject(root: string, rel: string): Promise<string | undefined> {
  const parts = rel.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = nodePath.join(current, parts[i] ?? '');
    try {
      if ((await fsp.lstat(current)).isSymbolicLink()) { return parts.slice(0, i + 1).join('/'); }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') { return undefined; }
      throw err;
    }
  }
  return undefined;
}

const MAX_COMPARE_FILES = 200;
const MAX_COMPARE_BYTES = 8 * 1024 * 1024;

/** What the last quiet comparison saw on the board (for the mark of a file right after a save, without board traffic). */
interface LastCompare {
  board: BoardKey;
  entries: Map<string, PlanBoardEntry>;
  hash: 'sha256' | 'none';
}

/** The first-sync review counts (D-21), by workspace-relative path. */
export interface ReviewCounts { same: string[]; onlyHere: string[]; onlyBoard: string[]; differ: string[] }

export function reviewCounts(plan: SyncPlan): ReviewCounts {
  const c: ReviewCounts = { same: [], onlyHere: [], onlyBoard: [], differ: [] };
  for (const it of plan.items) {
    if (it.kind !== 'file') { continue; }
    const b = badgeOfReason(it.reason);
    if (b === 'in-sync') { c.same.push(it.path); }
    else if (b === 'local-only') { c.onlyHere.push(it.path); }
    else if (b === 'board-only') { c.onlyBoard.push(it.path); }
    else if (b !== undefined) { c.differ.push(it.path); }
  }
  return c;
}

function listNames(paths: readonly string[], max = 6): string {
  return paths.length <= max ? paths.join(', ') : `${paths.slice(0, max).join(', ')} and ${paths.length - max} more`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export class SyncService implements SyncGate, SyncStatusSource, BoardChangeSource, vscode.Disposable {
  readonly status = new SyncStatus();
  readonly engine: SyncEngine;
  readonly auto: AutoSync;
  private matcher: { root: string; matcher: IgnoreMatcher; warnings: string[] } | undefined;
  private readonly stores = new Map<string, BaselineStore>();
  private readonly flavor: PathFlavor | undefined;
  private readonly now: () => Date;
  private lastCompare: LastCompare | undefined;
  private refreshing: Promise<Prepared | undefined> | undefined;
  /** A connect happened; the comparison + review run at the first idle moment after it. */
  private connectDue = false;
  private connectRunning = false;
  /** This connection: the review dialog was shown (and maybe postponed), and the "files are waiting" note was given. */
  private reviewShown = false;
  private waitingNoteShown = false;
  private lastState: string;
  private reviewing = false;
  /** Boards without a unique id are reviewed for this session only (their history is shared by identical models). */
  private readonly reviewedThisSession = new Set<string>();
  private readonly listeners: vscode.Disposable[] = [];

  constructor(private readonly services: Services, private readonly options: SyncServiceOptions = {}) {
    this.flavor = options.flavor;
    this.now = options.now ?? (() => new Date());
    this.engine = new SyncEngine({
      session: services.session, log: services.log, backupRoot: nodePath.join(this.storageDir(), 'backups'),
      state: services.context.workspaceState, now: this.now,
    });
    const host: AutoSyncHost = {
      folderContext: () => this.folderContext(),
      boardKey: (o) => this.boardKey(o),
      ignoreFileChanged: () => { this.matcher = undefined; },
      dryRun: () => this.dryRun(),
      noteLocalChange: (uri) => { void this.noteLocalChange(uri); },
      reviewNeeded: () => this.reviewNeeded(),
      onDestChanged: (results) => this.offerDestChanged(results),
      boardCopyIs: (remote, copy) => this.boardCopyIs(remote, copy),
    };
    this.auto = new AutoSync({ services, engine: this.engine, status: this.status, host, scheduler: options.scheduler });
    this.lastState = services.session.state.state;
  }

  // ------------------------------------------------------------------ SyncGate, SyncStatusSource (delegation)

  get pendingCount(): number { return this.auto.pendingCount; }
  flushPending(): Promise<{ ok: boolean; uploaded: number; failed: number }> { return this.auto.flushPending(); }
  badgeFor(devicePath: string): SyncBadge | undefined { return this.status.badgeFor(devicePath); }
  detailFor(devicePath: string): SyncStatusDetail | undefined { return this.status.detailFor(devicePath); }
  localOnlyIn(devicePath: string): readonly LocalOnlyEntry[] { return this.status.localOnlyIn(devicePath); }
  readonly onDidChange = (listener: () => unknown): vscode.Disposable => this.status.onDidChange(listener);

  /** BoardChangeSource: the Files view re-lists folders when this fires (see src/sync/boardChanges.ts). */
  readonly onBoardChanged: BoardChangeSource['onBoardChanged'] = (listener) => this.engine.changes.onBoardChanged(listener);

  /** For code that changes the board without the engine (the board-file commands): announce the paths it created, renamed or removed. */
  boardChanged(devicePaths: readonly string[]): void { this.engine.changes.notify(devicePaths); }

  /** Resolves when background work (queued uploads, a comparison in flight) has finished. */
  async whenIdle(): Promise<void> {
    await this.auto.whenIdle();
    await this.refreshing?.catch(() => undefined);
    await this.auto.whenIdle();
  }

  /** Activation step 10: start the save/watch listeners, the comparison at connect and after Run, and the unsaved marks. */
  start(): void {
    this.auto.start();
    const { session } = this.services;
    this.listeners.push(session.onDidChangeState((st) => this.onState(st.state)));
    this.listeners.push(vscode.workspace.onDidChangeTextDocument((e) => this.noteDirty(e.document)));
    this.listeners.push(vscode.workspace.onDidSaveTextDocument((d) => this.noteDirty(d)));
    this.listeners.push(vscode.workspace.onDidCloseTextDocument((d) => this.noteDirty(d, false)));
    for (const doc of vscode.workspace.textDocuments) { this.noteDirty(doc); }
  }

  dispose(): void {
    this.listeners.splice(0).forEach((d) => d.dispose());
    this.auto.dispose();
    this.status.dispose();
    this.engine.changes.dispose();
  }

  // ------------------------------------------------------------------ context pieces

  storageDir(): string {
    if (this.options.storageDir) { return this.options.storageDir; }
    const { storageUri, globalStorageUri } = this.services.context;
    return storageUri?.fsPath ?? nodePath.join(globalStorageUri.fsPath, 'no-workspace');
  }

  /** The first workspace folder with its path mapper, ignore rules and baseline store; undefined without a folder. */
  async folderContext(): Promise<FolderContext | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return undefined; }
    const root = folder.uri.fsPath;
    const mapper = new PathMapper(root, this.services.settings.rootPath, this.flavor);
    if (this.matcher?.root !== root) {
      const loaded = await loadIgnoreMatcher(root, this.options.localCaseInsensitive ?? hostIsCaseInsensitive());
      for (const w of loaded.warnings) { this.services.log.warn(`sync: ${w}`); }
      this.matcher = { root, matcher: loaded.matcher, warnings: loaded.warnings };
    }
    const key = workspaceKeyOf(folder.uri.toString());
    let store = this.stores.get(key);
    if (!store) {
      store = new BaselineStore(this.storageDir(), key, {
        now: this.now,
        warn: (m) => { this.services.log.warn(`sync: ${m}`); void vscode.window.showWarningMessage(m); },
      });
      this.stores.set(key, store);
    }
    return { folder, mapper, matcher: this.matcher.matcher, store };
  }

  /** The file of the project that stands for a board file, and whether it exists (the Files view click and Run use this). */
  async localCounterpart(devicePath: string): Promise<LocalCounterpart> {
    const ctx = await this.folderContext();
    if (!ctx) { return { kind: 'no-folder' }; }
    const rel = ctx.mapper.deviceToRel(devicePath);
    if (rel === undefined) {
      return { kind: 'unmapped', why: `${devicePath} is outside ${ctx.mapper.rootPath} on the board, the folder that your project mirrors.` };
    }
    let abs: string;
    try {
      abs = ctx.mapper.relToLocal(rel);
    } catch (err) {
      if (err instanceof PathError) { return { kind: 'unmapped', why: err.message }; }
      throw err;
    }
    // Like the scan, never go through a shortcut: it may lead outside the project (a copy would write there, a click would open it).
    const link = await linkInProject(ctx.folder.uri.fsPath, rel);
    if (link !== undefined) {
      return { kind: 'unmapped', why: `${link} is a shortcut (symbolic link), and shortcuts are not used for syncing or copying. Replace it with a real file or folder to use it here.` };
    }
    try {
      return (await fsp.stat(abs)).isFile() ? { kind: 'file', abs, rel } : { kind: 'missing', abs, rel };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') { return { kind: 'missing', abs, rel }; }
      throw err;
    }
  }

  newConsent(what: string, background = false): Consent {
    return new Consent(() => askToInterrupt(what), background);
  }

  /** True when a board is connected afterwards; asks for a port through the selectPort command when needed. */
  async ensureConnected(): Promise<boolean> {
    const s = this.services.session.state.state;
    if (s !== 'disconnected' && s !== 'connecting') { return true; }
    const args: SelectPortArgs = { reuse: true };
    const ok = await vscode.commands.executeCommand<boolean>(COMMAND_IDS.selectPort, args);
    return ok === true && this.services.session.state.state !== 'disconnected';
  }

  private rememberBoard(key: BoardKey): void {
    void this.services.context.workspaceState.update(stateKey('sync.lastBoard'), key);
  }

  async boardKey(opts: { passive: boolean }): Promise<BoardKey | undefined> {
    const { session, context, log } = this.services;
    if (session.state.identity) {
      const key = boardKeyOf(session.state.identity);
      this.rememberBoard(key);
      return key;
    }
    if (opts.passive) {
      return context.workspaceState.get<BoardKey>(stateKey('sync.lastBoard'));
    }
    if (session.state.state === 'disconnected') { return undefined; }
    try {
      const identity = await session.call('identity', { background: true });
      const key = boardKeyOf(identity);
      this.rememberBoard(key);
      return key;
    } catch (err) {
      log.warn('sync: could not identify the board for auto-sync', err);
      return undefined;
    }
  }

  async identityFor(consent: Consent): Promise<BoardIdentity> {
    return this.services.session.state.identity ?? callWithConsent(this.services.session, consent, 'identity', {}, { timeoutMs: 30000 });
  }

  /** Run a command body: any failure reaches the user in one message and the log. Cancelling is silent. */
  async guarded<T>(what: string, work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (err) {
      if (isAborted(err)) { return undefined; }
      this.services.log.error(`${what} failed`, err);
      const choice = await vscode.window.showErrorMessage(`${what} did not work. ${userMessage(err)}`, 'Show Log');
      if (choice === 'Show Log') { this.services.log.show(); }
      return undefined;
    }
  }

  // ------------------------------------------------------------------ planning

  /** Scan the project, read the board manifest, compare with the baseline. No change is made except refreshing "identical" in the baseline. */
  async prepare(direction: SyncPlan['direction'], consent: Consent): Promise<Prepared | undefined> {
    const ctx = await this.folderContext();
    if (!ctx) {
      void vscode.window.showInformationMessage('Open your project folder in VS Code first (File > Open Folder), then try again.');
      return undefined;
    }
    if (!(await this.ensureConnected())) { return undefined; }
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Comparing your files with the board' },
      async () => {
        const identity = await this.identityFor(consent);
        const board = boardKeyOf(identity);
        this.rememberBoard(board);
        const scan = await scanLocal(ctx.mapper.workspaceRoot, ctx.matcher, this.options.scan);
        const warnings = [...scan.warnings, ...(this.matcher?.warnings ?? [])];
        let entries: ManifestEntry[] = [];
        let hash: 'sha256' | 'none' = 'sha256';
        try {
          const m = await callWithConsent(this.services.session, consent, 'fs.manifest', { root: ctx.mapper.rootPath, hash: true }, { timeoutMs: 120000 });
          entries = m.entries;
          hash = m.hash;
          for (const w of m.warnings) { warnings.push(`The folder ${w.path} on the board could not be read (${w.errno}), so its files are not included.`); }
          if (m.truncated) { warnings.push('The board has so many files that the list was cut short.'); }
        } catch (err) {
          if (err instanceof BoardError && err.code === 'E_FS_ERRNO' && /ENOENT/.test(err.detail)) {
            warnings.push(`The folder ${ctx.mapper.rootPath} does not exist on the board yet${direction === 'toBoard' ? '; it will be created' : ''}.`);
          } else {
            throw err;
          }
        }
        if (board.derived) {
          warnings.push('This board has no unique id, so sync history is shared by all boards of the same model. Check the list carefully when you switch boards.');
        }
        const baseline = await ctx.store.load(board);
        const input: PlanInput = {
          direction, workspaceRoot: ctx.mapper.workspaceRoot, rootPath: ctx.mapper.rootPath, boardId: board.derived ? null : board.id,
          local: scan.files, localDirs: scan.dirs,
          board: entries.map((e): PlanBoardEntry => ({ remote: e.path, type: e.type, size: e.size, sha256: e.sha256 })),
          boardHash: hash, baseline: baseline.files,
          shadow: { names: identity.profileHints.modules, roots: importRootsFrom(identity.syspath) },
          ignoredOnBoard: (rel, isDir) => ctx.matcher.ignores(rel, isDir),
          flavor: this.flavor, localCaseInsensitive: this.options.localCaseInsensitive, warnings, now: this.now(),
        };
        let out = buildPlan(input);
        if (out.ambiguous.length > 0 && hash === 'none') {
          const downloaded = await this.compareByDownload(out.ambiguous, input, consent);
          out = buildPlan({ ...input, downloaded });
        }
        await this.refreshIdentical(ctx, board, out.plan, scan);
        this.status.fromPlan(out.plan);
        return { ctx, board, identity, plan: out.plan, scan };
      },
    );
  }

  /** Files proven identical on both sides become (or stay) baseline entries: that is what "last verified in sync" means. */
  private async refreshIdentical(ctx: FolderContext, board: BoardKey, plan: SyncPlan, scan: ScanResult): Promise<void> {
    const sizes = new Map(scan.files.map((f) => [f.path, f.size] as const));
    const verified = plan.items
      .filter((i) => i.reason === 'identical' && i.localSha256 !== undefined && i.baseSha256 !== i.localSha256)
      .map((i) => ({ path: i.path, sha256: i.localSha256 ?? '', size: sizes.get(i.path) ?? 0 }));
    if (verified.length === 0) { return; }
    try {
      await ctx.store.record(board, verified);
    } catch (err) {
      this.services.log.warn('sync: could not refresh the sync history', err);
    }
  }

  /** Boards that cannot hash: download same-size files into a scratch folder and hash them here (bounded). */
  private async compareByDownload(ambiguous: readonly string[], input: PlanInput, consent: Consent): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const scratch = nodePath.join(this.storageDir(), `compare-${process.pid}-${Date.now()}`);
    const mapper = new PathMapper(input.workspaceRoot, input.rootPath, input.flavor);
    let bytes = 0;
    try {
      let n = 0;
      for (const rel of ambiguous.slice(0, MAX_COMPARE_FILES)) {
        const remote = mapper.relToDevice(rel);
        const entry = input.board.find((b) => b.remote === remote);
        if (!entry) { continue; }
        bytes += entry.size;
        if (bytes > MAX_COMPARE_BYTES) { break; }
        const dest = nodePath.join(scratch, String(n++));
        await callWithConsent(this.services.session, consent, 'fs.get', { remote, local: dest }, { timeoutMs: 60000 });
        out[rel] = (await sha256File(dest)).sha256;
      }
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true }).catch((err: unknown) => this.services.log.warn('sync: could not remove the comparison folder', err));
    }
    return out;
  }

  // ------------------------------------------------------------------ flows behind the commands

  async uploadAll(): Promise<SyncResult | undefined> {
    return this.bulk('toBoard');
  }

  async downloadAll(): Promise<SyncResult | undefined> {
    return this.bulk('fromBoard');
  }

  private async bulk(direction: SyncPlan['direction']): Promise<SyncResult | undefined> {
    const toBoard = direction === 'toBoard';
    const consent = this.newConsent(toBoard ? 'Comparing your files with the board' : 'Reading the board files');
    const prep = await this.prepare(direction, consent);
    if (!prep) { return undefined; }
    const { plan } = prep;
    if (plan.items.every((i) => i.action === 'unchanged')) {
      const checked = plan.items.length;
      const warn = plan.warnings.length > 0 ? ` Notes: ${plan.warnings.slice(0, 3).join(' ')}` : '';
      void vscode.window.showInformationMessage(
        `${toBoard ? 'The board already has' : 'Your project already has'} every file that can be copied (${checked} checked).${warn}`,
      );
      return undefined;
    }
    const reviewed = await previewPlan(plan, toBoard ? 'Upload files to the board' : 'Download files from the board');
    if (!reviewed) { return undefined; }
    const backupNote = `in ${nodePath.join(this.storageDir(), 'backups')}`;
    if (!(await confirmPlan(reviewed, backupNote))) { return undefined; }
    const result = await this.engine.execute(reviewed, { baseline: prep.ctx.store, board: prep.board, title: toBoard ? 'Uploading to the board' : 'Downloading from the board' });
    this.noteTransfers(result);
    for (const r of result.results) {
      if (r.status === 'ok' && r.item.kind === 'file' && r.item.action !== 'delete-board' && r.item.action !== 'delete-local') {
        this.status.set(r.item.remote, 'in-sync');
      }
    }
    await this.markReviewed(prep.board); // the student looked at the full list: auto-sync may send to this board now
    return result;
  }

  /** The dry run behind the "Show me what would be uploaded" button: lists, changes nothing. */
  async dryRun(): Promise<void> {
    const consent = this.newConsent('Checking the board');
    const prep = await this.guarded('Checking what would be uploaded', () => this.prepare('toBoard', consent));
    if (!prep) { return; }
    if (prep.plan.items.every((i) => i.action === 'unchanged')) {
      void vscode.window.showInformationMessage('Nothing would be uploaded: the board already has every file.');
      return;
    }
    await vscode.window.showQuickPick(previewRows(prep.plan).map((r) => ({ ...r, picked: false })), {
      title: 'This is what auto-sync would upload (nothing has been changed)',
      placeHolder: 'Press Escape to go back.',
    });
  }

  /**
   * The board document in the editor is the board's own copy; the file to upload is the project's file with the same name.
   * Says what to do when the project has none.
   */
  private async localFileOfBoardDocument(doc: vscode.Uri): Promise<vscode.Uri | undefined> {
    const name = nodePath.posix.basename(doc.path);
    const where = await this.localCounterpart(doc.path);
    if (where.kind === 'file') { return vscode.Uri.file(where.abs); }
    void vscode.window.showInformationMessage(
      where.kind === 'no-folder'
        ? 'Open your project folder in VS Code first (File > Open Folder), then try again.'
        : where.kind === 'unmapped'
          ? `This is the board's own copy of ${name}, and it has no place in your project folder, so there is nothing to upload.`
          : `This is the board's own copy of ${name}, and your project folder does not have that file, so there is nothing to upload. Click the file in the Files view and choose "Copy it to my project" first.`,
    );
    return undefined;
  }

  /** Upload one local file now (the toolbar button). */
  async uploadFile(uri: vscode.Uri | undefined): Promise<SyncResult | undefined> {
    let chosen = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (isBoardDocumentUri(chosen)) {
      chosen = await this.localFileOfBoardDocument(chosen);
      if (!chosen) { return undefined; }
    }
    if (!chosen || chosen.scheme !== 'file') {
      void vscode.window.showInformationMessage('Open the file you want to upload in the editor first.');
      return undefined;
    }
    const target = chosen;
    const ctx = await this.folderContext();
    if (!ctx) {
      void vscode.window.showInformationMessage('Open your project folder in VS Code first (File > Open Folder), then try again.');
      return undefined;
    }
    const rel = ctx.mapper.localToRel(target.fsPath);
    if (rel === undefined) {
      void vscode.window.showWarningMessage(`${nodePath.basename(target.fsPath)} is outside your project folder, so there is no matching place for it on the board. Move it into the project folder first.`);
      return undefined;
    }
    if (ctx.matcher.ignores(rel)) {
      const yes = 'Upload anyway';
      const choice = await vscode.window.showWarningMessage(`${rel} is on the ignore list, so it is normally not copied to the board.`, { modal: true }, yes);
      if (choice !== yes) { return undefined; }
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === target.fsPath);
    if (doc?.isDirty) { await doc.save(); }
    if (!(await this.ensureConnected())) { return undefined; }
    const consent = this.newConsent('Sending the file');
    const identity = await this.identityFor(consent);
    const board = boardKeyOf(identity);
    const hash = await sha256File(target.fsPath);
    const remote = ctx.mapper.relToDevice(rel);
    const known = (await ctx.store.load(board)).files[rel];
    const plan: SyncPlan = {
      direction: 'toBoard', createdAt: this.now().toISOString(), workspaceRoot: ctx.mapper.workspaceRoot, rootPath: ctx.mapper.rootPath,
      boardId: board.derived ? null : board.id, compare: 'sha256', warnings: [],
      items: [{
        path: rel, remote, local: target.fsPath, kind: 'file', action: 'upload', reason: 'user-request', size: hash.size, localSha256: hash.sha256,
        baseSha256: known?.sha256, selected: true, ifBoardSha: known ? known.sha256 : 'absent',
      }],
    };
    let result = await this.engine.execute(plan, { baseline: ctx.store, board, title: `Uploading ${rel}`, quiet: true });
    this.noteTransfers(result);
    let r = result.results[0];
    if (r?.status === 'failed' && r.code === 'E_DEST_CHANGED' && r.current?.exists) {
      // D-21: the board copy changed since the last sync (or was never synced from here): replace only on a clear yes, with a backup
      this.status.set(remote, known ? 'conflict' : 'differs', { rel });
      const replace = 'Replace it (back up the board copy first)';
      const compare = 'Compare first';
      const choice = await vscode.window.showWarningMessage(
        known
          ? `The board's copy of ${rel} changed since the last sync. Replace it with your version?`
          : `The board already has a different ${rel}, and it was never synced from this computer. Replace it with your version?`,
        { modal: true, detail: 'The board\'s copy is saved in the sync backups before it is replaced.' },
        replace, compare,
      );
      if (choice === compare) {
        await this.compareWithBoard(remote);
        return result;
      }
      if (choice !== replace) { return result; }
      const forced: SyncPlan = { ...plan, items: [{ ...plan.items[0]!, action: 'conflict', boardSha256: r.current.sha256 ?? undefined, ifBoardSha: undefined, selected: true }] };
      result = await this.engine.execute(forced, { baseline: ctx.store, board, title: `Uploading ${rel}`, quiet: true });
      this.noteTransfers(result);
      r = result.results[0];
    }
    if (r?.status === 'ok') {
      this.status.set(remote, 'in-sync');
      void vscode.window.showInformationMessage(r.bytes === 0 ? `${rel} is already up to date on the board.` : `Uploaded ${rel} to ${remote} on the board.`);
    } else {
      const text = r?.message ?? `${rel} could not be uploaded.`;
      this.services.log.warn(`sync: upload of ${rel} did not finish: ${text}`);
      const choice = await vscode.window.showWarningMessage(text, 'Show Log');
      if (choice === 'Show Log') { this.services.log.show(); }
    }
    return result;
  }

  /** Create `.mpyignore` (the template lists the built-in rules) and open it. */
  async createIgnoreFile(): Promise<void> {
    const ctx = await this.folderContext();
    if (!ctx) {
      void vscode.window.showInformationMessage('Open your project folder in VS Code first (File > Open Folder), then try again.');
      return;
    }
    const { created, file } = await createDefaultIgnoreFile(ctx.mapper.workspaceRoot);
    this.matcher = undefined;
    if (!created) { void vscode.window.showInformationMessage('The ignore file already exists. Opening it.'); }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  /** Clear Device Files: delete everything inside `rootPath` on the board (never the folder itself, never outside it). */
  async clearDevice(): Promise<{ removed: number; failed: number; remaining: number } | undefined> {
    const { session, log } = this.services;
    const ctx = await this.folderContext();
    const rootPath = ctx?.mapper.rootPath ?? new PathMapper('/', this.services.settings.rootPath).rootPath;
    if (!(await this.ensureConnected())) { return undefined; }
    const consent = this.newConsent('Clearing the board');
    const list = async (): Promise<{ name: string; type: 'file' | 'dir' }[] | undefined> => {
      try {
        return (await callWithConsent(session, consent, 'fs.list', { path: rootPath }, { timeoutMs: 30000 })).entries.filter((e) => e.name !== '');
      } catch (err) {
        if (err instanceof BoardError && err.code === 'E_FS_ERRNO' && /ENOENT/.test(err.detail)) { return undefined; }
        throw err;
      }
    };
    const entries = await list();
    if (!entries || entries.length === 0) {
      void vscode.window.showInformationMessage(`There is nothing to delete: ${rootPath} on the board is empty${entries ? '' : ' or does not exist'}.`);
      return { removed: 0, failed: 0, remaining: 0 };
    }
    const shown = entries.slice(0, 15).map((e) => `  ${e.name}${e.type === 'dir' ? '/' : ''}`);
    if (entries.length > 15) { shown.push(`  ... and ${entries.length - 15} more`); }
    const button = `Delete ${entries.length} item${entries.length === 1 ? '' : 's'}`;
    const choice = await vscode.window.showWarningMessage(
      `Delete everything in ${rootPath} on the board?`,
      {
        modal: true,
        detail: `${shown.join('\n')}\n\nThis cannot be undone. Your files on this computer are not touched; Upload All Files copies them back.${rootPath === '/' ? '\nThis includes boot.py and main.py if the board has them.' : ''}`,
      },
      button,
    );
    if (choice !== button) { return undefined; }

    const types = Object.fromEntries(entries.map((e) => [e.name, e.type] as const));
    const done = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Deleting files on the board in ${rootPath}`, cancellable: false },
      () => this.engine.removeChildren(rootPath, entries.map((e) => e.name), types, consent),
    );
    const left = (await list()) ?? [];
    await this.forgetDeleted(ctx, done.removed);
    this.status.clear();
    const parts = [`Deleted ${done.removed.length} item${done.removed.length === 1 ? '' : 's'} from ${rootPath}.`];
    if (done.skipped.length > 0) { parts.push(`Left alone at your request: ${done.skipped.join(', ')}.`); }
    if (done.failed.length > 0) { parts.push(`${done.failed.length} could not be deleted: ${done.failed[0]?.message ?? ''}`); }
    parts.push(left.length === 0 ? 'The folder is now empty.' : `${left.length} item${left.length === 1 ? ' is' : 's are'} still on the board.`);
    log.info(`sync: clear device ${rootPath}: ${parts.join(' ')}`);
    const problem = done.failed.length > 0 || left.length > 0;
    const pick = await showToast(log, problem ? 'warning' : 'info', parts.join(' '), ...(problem ? ['Show Log'] : []));
    if (pick === 'Show Log') { log.show(); }
    return { removed: done.removed.length, failed: done.failed.length, remaining: left.length };
  }

  private async forgetDeleted(ctx: FolderContext | undefined, removed: readonly string[]): Promise<void> {
    if (!ctx || removed.length === 0) { return; }
    const board = await this.boardKey({ passive: true });
    if (!board) { return; }
    try {
      await ctx.store.update(board, (files) => {
        for (const device of removed) {
          const rel = ctx.mapper.deviceToRel(device);
          if (rel === undefined) { continue; }
          for (const key of Object.keys(files)) {
            if (key === rel || key.startsWith(`${rel}/`)) { delete files[key]; }
          }
        }
      });
    } catch (err) {
      this.services.log.warn('sync: could not update the sync history after clearing the board', err);
    }
  }

  // ------------------------------------------------------------------ D-21: marks at connect, first-sync review, after Run

  private onState(state: string): void {
    const prev = this.lastState;
    this.lastState = state;
    if (state === 'disconnected') {
      this.connectDue = false;
      this.lastCompare = undefined;
      this.reviewShown = false;
      this.waitingNoteShown = false;
      this.status.clear();
      return;
    }
    if ((prev === 'disconnected' || prev === 'connecting') && state !== 'connecting') { this.connectDue = true; }
    if (state !== 'idle') { return; }
    if (this.connectDue) {
      if (this.connectRunning) { return; }
      // Right after a connect the board flips between idle and 'rawop' while the Files view, the clock and IntelliSense read
      // it. The work below queues behind them in the bridge; when it cannot finish now (a program runs) it asks to run at the
      // next idle moment, so the review is never lost (instructor's report 2026-10-13: files waited, no review appeared).
      this.connectDue = false;
      this.connectRunning = true;
      void this.quietly('compare your files with the board', async () => {
        try {
          if ((await this.afterConnect()) === 'retry' && this.services.session.state.state !== 'disconnected') { this.connectDue = true; }
        } finally {
          this.connectRunning = false;
        }
      });
    } else if (prev === 'running') {
      void this.quietly('check the board after the program', () => this.afterRun());
    }
  }

  /** Background work: failures go to the log only (the marks simply stay as they were). */
  private async quietly(what: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (err) {
      if (isAborted(err)) { return; }
      this.services.log.warn(`sync: could not ${what}`, err);
    }
  }

  /** The workspaceState key that remembers the first-sync review of a board for this folder. */
  private reviewKey(board: BoardKey): string {
    return stateKey(`sync.reviewed.${board.id}`);
  }

  async isReviewed(board: BoardKey): Promise<boolean> {
    if (board.derived) { return this.reviewedThisSession.has(board.id); }
    return this.services.context.workspaceState.get<boolean>(this.reviewKey(board)) === true;
  }

  async markReviewed(board: BoardKey): Promise<void> {
    if (board.derived) {
      this.reviewedThisSession.add(board.id);
    } else {
      await this.services.context.workspaceState.update(this.reviewKey(board), true);
    }
    const connected = this.services.session.state.identity ? boardKeyOf(this.services.session.state.identity) : undefined;
    if (!connected || connected.id === board.id) { this.auto.setReviewed(true); }
  }

  /**
   * Compare the project with the board WITHOUT questions or notifications (no consent, no interrupt: a running program makes it
   * give up quietly) and update every mark. Concurrent callers share one comparison.
   */
  refreshStatus(why: string): Promise<Prepared | undefined> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(why).finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  private async doRefresh(why: string): Promise<Prepared | undefined> {
    const { session, log } = this.services;
    const ctx = await this.folderContext();
    const state = session.state.state;
    // 'rawop' = another file operation is in progress: ours queues behind it in the bridge. A running program answers E_PROGRAM_RUNNING.
    if (!ctx || !vscode.workspace.isTrusted || (state !== 'idle' && state !== 'rawop')) { return undefined; }
    let identity: BoardIdentity;
    try {
      identity = session.state.identity ?? await session.call('identity', { background: true }, { timeoutMs: 30000 });
    } catch (err) {
      if (err instanceof BoardError && err.code === 'E_PROGRAM_RUNNING') { return undefined; }
      throw err;
    }
    const board = boardKeyOf(identity);
    this.rememberBoard(board);
    const scan = await scanLocal(ctx.mapper.workspaceRoot, ctx.matcher, this.options.scan);
    let entries: ManifestEntry[] = [];
    let hash: 'sha256' | 'none' = identity.caps.hash;
    try {
      const m = await session.call('fs.manifest', { root: ctx.mapper.rootPath, hash: true, background: true }, { timeoutMs: 180000 });
      entries = m.entries;
      hash = m.hash;
    } catch (err) {
      if (err instanceof BoardError && err.code === 'E_PROGRAM_RUNNING') { return undefined; }
      if (!(err instanceof BoardError && err.code === 'E_FS_ERRNO' && /ENOENT/.test(err.detail))) { throw err; }
    }
    const baseline = await ctx.store.load(board);
    const boardEntries = entries.map((e): PlanBoardEntry => ({ remote: e.path, type: e.type, size: e.size, sha256: e.sha256 }));
    const input: PlanInput = {
      direction: 'toBoard', workspaceRoot: ctx.mapper.workspaceRoot, rootPath: ctx.mapper.rootPath, boardId: board.derived ? null : board.id,
      local: scan.files, localDirs: scan.dirs, board: boardEntries, boardHash: hash, baseline: baseline.files,
      shadow: { names: identity.profileHints.modules, roots: importRootsFrom(identity.syspath) },
      ignoredOnBoard: (rel, isDir) => ctx.matcher.ignores(rel, isDir),
      flavor: this.flavor, localCaseInsensitive: this.options.localCaseInsensitive, warnings: [], now: this.now(),
    };
    const { plan } = buildPlan(input);
    await this.refreshIdentical(ctx, board, plan, scan);
    this.lastCompare = { board, entries: new Map(boardEntries.filter((e) => e.type === 'file').map((e) => [e.remote, e])), hash };
    this.status.fromPlan(plan, this.now());
    log.info(`sync: compared ${scan.files.length} project file(s) with ${entries.filter((e) => e.type === 'file').length} board file(s) (${why})`);
    return { ctx, board, identity, plan, scan };
  }

  /**
   * At connect: a board reviewed before may receive saves at once (decided from its id, before the comparison); then compare (the
   * marks), and for a board never reviewed with this folder on this computer, run the first-sync review once. 'retry': it could not
   * finish now (a program runs, the board was busy): run again at the next idle moment.
   */
  private async afterConnect(): Promise<'done' | 'retry'> {
    const { session } = this.services;
    const ctx = await this.folderContext();
    if (!ctx || !vscode.workspace.isTrusted) { return 'done'; }
    let identity: BoardIdentity;
    try {
      identity = session.state.identity ?? await session.call('identity', { background: true }, { timeoutMs: 30000 });
    } catch (err) {
      if (err instanceof BoardError && (err.code === 'E_PROGRAM_RUNNING' || err.code === 'E_NOT_CONNECTED')) { return 'retry'; }
      throw err;
    }
    const board = boardKeyOf(identity);
    const reviewed = await this.isReviewed(board);
    if (reviewed) { this.auto.setReviewed(true); }
    const prep = await this.refreshStatus('connect');
    if (!prep) { return session.state.state === 'disconnected' ? 'done' : 'retry'; }
    if (reviewed) { return 'done'; }
    const counts = reviewCounts(prep.plan);
    if (counts.onlyHere.length === 0 && counts.onlyBoard.length === 0 && counts.differ.length === 0) {
      await this.markReviewed(prep.board); // nothing to decide: the two sides are the same (or both empty)
      return 'done';
    }
    await this.firstSyncReview(prep, counts);
    return 'done';
  }

  /**
   * Auto-sync has saved files for a board that was not reviewed yet. If the review never ran on this connection (it could not, or
   * it is still on its way) it runs now; if the student postponed it, one note per connection says why the files wait.
   */
  private reviewNeeded(): void {
    const state = this.services.session.state.state;
    if (state === 'disconnected' || state === 'connecting' || this.reviewing || this.connectRunning) { return; }
    if (!this.reviewShown) {
      this.connectDue = false;
      this.connectRunning = true;
      void this.quietly('compare your files with the board', async () => {
        try {
          if ((await this.afterConnect()) === 'retry') { this.connectDue = true; }
        } finally {
          this.connectRunning = false;
        }
      });
      return;
    }
    if (this.waitingNoteShown) { return; }
    this.waitingNoteShown = true;
    const review = 'Review now';
    void showToast(this.services.log, 'info',
      'Your saved files are not sent to this board yet: it was never synced with this project folder on this computer, and the review was postponed.',
      review)
      .then((choice) => {
        if (choice !== review) { return; }
        this.reviewShown = false;
        this.reviewNeeded();
      });
  }

  /**
   * D-21 first-sync review: a board that was never synced with this folder on this computer is never written to before the student
   * says what to do (a lab partner's board, another computer, a board with a program's data files). One dialog with the counts and
   * the names; nothing is ever replaced from here: differing files stay marked until the student compares them.
   */
  async firstSyncReview(prep: Prepared, counts: ReviewCounts): Promise<void> {
    if (this.reviewing) { return; }
    this.reviewing = true;
    try {
      const n = counts.onlyHere.length;
      const m = counts.onlyBoard.length;
      const lines: string[] = [];
      if (n > 0) { lines.push(`Only in your project (${n}): ${listNames(counts.onlyHere)}`); }
      if (m > 0) { lines.push(`Only on the board (${m}): ${listNames(counts.onlyBoard)}`); }
      if (counts.differ.length > 0) {
        lines.push(`Different on the two sides (${counts.differ.length}): ${listNames(counts.differ)}. Nothing is replaced: compare them in the Files view, then upload or download each one.`);
      }
      if (counts.same.length > 0) { lines.push(`The same on both sides: ${plural(counts.same.length, 'file')}.`); }
      lines.push('', 'Until you choose, auto-sync does not send anything to this board. The marks in the Files view show what differs.');
      const both = `Send my ${plural(n, 'file')} and copy the board's ${plural(m, 'file')}`;
      const send = `Send my ${plural(n, 'new file')} to the board`;
      const copy = `Copy the board's ${plural(m, 'file')} into my project`;
      const review = 'Review each file...';
      const buttons = [...(n > 0 && m > 0 ? [both] : []), ...(n > 0 ? [send] : []), ...(m > 0 ? [copy] : []), review];
      this.reviewShown = true;
      const choice = await vscode.window.showInformationMessage(
        'This board was never synced with this project folder on this computer.', { modal: true, detail: lines.join('\n') }, ...buttons,
      );
      if (choice === undefined) {
        this.services.log.info('sync: first-sync review postponed; auto-sync does not send to this board until it is reviewed');
        return;
      }
      if (choice === review) {
        await this.bulk('toBoard'); // the full list with ticks; marks the board reviewed when it ran
        return;
      }
      const items: SyncItem[] = [];
      if (choice === both || choice === send) {
        for (const it of prep.plan.items) {
          if (it.kind === 'file' && it.action === 'upload' && badgeOfReason(it.reason) === 'local-only') {
            items.push({ ...it, selected: true, ifBoardSha: 'absent' });
          }
        }
        if (items.length > 0) { await this.execute('toBoard', prep, items, `Sending ${plural(items.length, 'file')} to the board`); }
      }
      if (choice === both || choice === copy) {
        const downloads = prep.plan.items
          .filter((it) => it.kind === 'file' && badgeOfReason(it.reason) === 'board-only' && it.local !== '')
          .map((it): SyncItem => ({ ...it, action: 'download', selected: true }));
        if (downloads.length > 0) { await this.execute('fromBoard', prep, downloads, `Copying ${plural(downloads.length, 'file')} into your project`); }
      }
      await this.markReviewed(prep.board);
      await this.refreshStatus('after the first-sync review');
    } finally {
      this.reviewing = false;
    }
  }

  private async execute(direction: SyncPlan['direction'], prep: Prepared, items: SyncItem[], title: string): Promise<SyncResult> {
    const plan: SyncPlan = { ...prep.plan, direction, createdAt: this.now().toISOString(), items };
    const result = await this.engine.execute(plan, { baseline: prep.ctx.store, board: prep.board, title });
    this.noteTransfers(result);
    for (const r of result.results) {
      if (r.status === 'ok' && r.item.kind === 'file') { this.status.set(r.item.remote, 'in-sync', { rel: r.item.path }); }
    }
    return result;
  }

  /** After a program ran: compare again and offer the files it created on the board (data logs), never downloading by itself. */
  private async afterRun(): Promise<void> {
    if (this.lastCompare === undefined) { return; } // never compared on this connection (no folder, untrusted, a review pending)
    const before = this.status.boardOnlyPaths();
    const prep = await this.refreshStatus('after a program ran');
    if (!prep) { return; }
    const created = prep.plan.items.filter((it) => it.kind === 'file' && it.reason === 'board-only' && !before.has(it.remote) && it.local !== '');
    if (created.length === 0) { return; }
    const names = listNames(created.map((it) => it.path), 3);
    const download = created.length === 1 ? 'Download it to my project' : `Download them to my project`;
    void showToast(this.services.log, 'info', `Your program created ${created.length === 1 ? names : `${created.length} files (${names})`} on the board.`, download)
      .then(async (choice) => {
        if (choice !== download) { return; }
        await this.guarded('Downloading the new files', async () => {
          const fresh = await this.refreshStatus('download new board files');
          if (!fresh) { return; }
          const items = fresh.plan.items
            .filter((it) => created.some((c) => c.remote === it.remote) && it.reason === 'board-only')
            .map((it): SyncItem => ({ ...it, action: 'download', selected: true }));
          if (items.length > 0) { await this.execute('fromBoard', fresh, items, `Downloading ${plural(items.length, 'file')}`); }
        });
      });
  }

  /** Keep the board side of the last comparison current after a transfer, so the instant mark of a later save stays right. */
  private boardCopyIs(remote: string, copy: { sha256: string | null; size: number; exists: boolean }): void {
    const last = this.lastCompare;
    if (!last) { return; }
    if (!copy.exists) { last.entries.delete(remote); return; }
    last.entries.set(remote, { remote, type: 'file', size: copy.size, sha256: copy.sha256 ?? undefined });
  }

  /** After the engine ran: every file that went either way now has the same content on the board as in the project. */
  private noteTransfers(result: SyncResult): void {
    for (const r of result.results) {
      if (r.status === 'ok' && r.item.kind === 'file' && r.sha256 !== undefined && (r.item.action === 'upload' || r.item.action === 'download' || r.item.action === 'conflict')) {
        this.boardCopyIs(r.item.remote, { sha256: r.sha256, size: r.bytes ?? r.item.size, exists: true });
      } else if (r.status === 'failed' && r.current) {
        this.boardCopyIs(r.item.remote, r.current);
      }
    }
  }

  /** The mark of one project file right after it was saved, created or changed, from the last comparison (no board traffic). */
  async noteLocalChange(uri: vscode.Uri): Promise<void> {
    const ctx = await this.folderContext();
    const last = this.lastCompare;
    if (!ctx || !last) { return; }
    const rel = ctx.mapper.localToRel(uri.fsPath);
    if (rel === undefined || ctx.matcher.ignores(rel)) { return; }
    const remote = ctx.mapper.relToDevice(rel);
    let local: { sha256: string; size: number } | undefined;
    try {
      local = await sha256File(uri.fsPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EISDIR') { throw err; }
      local = undefined;
    }
    const base = (await ctx.store.load(last.board)).files[rel];
    const reason = classifyOne(local, last.entries.get(remote), base);
    const badge = reason === undefined ? undefined : badgeOfReason(reason);
    this.status.set(remote, badge, { rel, size: local?.size });
    this.status.setFailed(remote, undefined);
  }

  private noteDirty(doc: vscode.TextDocument, dirty: boolean = doc.isDirty): void {
    if (doc.uri.scheme !== 'file') { return; }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }
    const mapper = new PathMapper(folder.uri.fsPath, this.services.settings.rootPath, this.flavor);
    const rel = mapper.localToRel(doc.uri.fsPath);
    if (rel === undefined || this.matcher?.matcher.ignores(rel)) { return; }
    this.status.setDirty(mapper.relToDevice(rel), dirty);
  }

  /** Auto-sync did not send saved files because their board copies changed since the last sync: say so once, with choices. */
  private offerDestChanged(results: readonly SyncItemResult[]): void {
    const first = results[0];
    if (!first) { return; }
    const what = results.length === 1 ? first.item.path : `${results.length} files (${listNames(results.map((r) => r.item.path), 3)})`;
    const compare = 'Compare';
    const neverSynced = results.every((r) => r.item.baseSha256 === undefined);
    const text = neverSynced
      ? `The board already has a different ${what}, and it was never synced from this computer, so your save was not sent there. Nothing was overwritten. Compare them, then upload or download from the Files view.`
      : `${what} changed on the board since the last sync, so your save was not sent there. Nothing was overwritten. Compare them, then upload or download from the Files view.`;
    void showToast(this.services.log, 'warning', text, ...(results.length === 1 ? [compare] : []))
      .then((choice) => { if (choice === compare) { void this.compareWithBoard(first.item.remote); } });
  }

  // ------------------------------------------------------------------ Files-view commands (D-21)

  private nodeOf(arg: unknown): BoardNode | undefined {
    const n = arg as Partial<BoardNode> | undefined;
    return n && typeof n.devicePath === 'string' && n.devicePath.startsWith('/') ? (n as BoardNode) : undefined;
  }

  /**
   * A file New File just created in the project goes to the board at once (D-24): only if the board has nothing there yet
   * (`ifSha: 'absent'`), quietly, recorded as synced. Throws what the bridge said when it could not be sent.
   */
  async sendNewFile(abs: string, rel: string): Promise<void> {
    const ctx = await this.folderContext();
    if (!ctx) { return; }
    const consent = this.newConsent('Sending the new file');
    const board = boardKeyOf(await this.identityFor(consent));
    const hash = await sha256File(abs);
    const remote = ctx.mapper.relToDevice(rel);
    const plan: SyncPlan = {
      direction: 'toBoard', createdAt: this.now().toISOString(), workspaceRoot: ctx.mapper.workspaceRoot, rootPath: ctx.mapper.rootPath,
      boardId: board.derived ? null : board.id, compare: 'sha256', warnings: [],
      items: [{ path: rel, remote, local: abs, kind: 'file', action: 'upload', reason: 'new-local', size: hash.size, localSha256: hash.sha256, selected: true, ifBoardSha: 'absent' }],
    };
    const result = await this.engine.execute(plan, { baseline: ctx.store, board, title: `Creating ${rel} on the board`, quiet: true });
    this.noteTransfers(result);
    const r = result.results[0];
    if (r?.status !== 'ok') { throw new Error(r?.message ?? `${rel} could not be sent.`); }
    this.status.set(remote, 'in-sync', { rel });
  }

  /** "Upload This File to the Board": the project's copy of a Files-view file. */
  async uploadNode(arg: unknown): Promise<SyncResult | undefined> {
    const node = this.nodeOf(arg);
    if (!node) { return this.uploadFile(undefined); }
    const where = await this.localCounterpart(node.devicePath);
    if (where.kind !== 'file') {
      void vscode.window.showInformationMessage(where.kind === 'no-folder'
        ? 'Open your project folder in VS Code first (File > Open Folder), then try again.'
        : where.kind === 'unmapped' ? where.why : `Your project folder has no ${node.name}, so there is nothing to upload.`);
      return undefined;
    }
    const result = await this.uploadFile(vscode.Uri.file(where.abs));
    return result;
  }

  /** "Download This File to My Project": the board's copy replaces the project's (backed up first, asked first if yours is newer). */
  async downloadNode(arg: unknown): Promise<SyncResult | undefined> {
    const node = this.nodeOf(arg);
    if (!node || node.localOnly) { return undefined; }
    const where = await this.localCounterpart(node.devicePath);
    if (where.kind === 'no-folder' || where.kind === 'unmapped') {
      void vscode.window.showInformationMessage(where.kind === 'no-folder' ? 'Open your project folder in VS Code first (File > Open Folder), then try again.' : where.why);
      return undefined;
    }
    if (!(await this.ensureConnected())) { return undefined; }
    const consent = this.newConsent('Downloading the file');
    const ctx = await this.folderContext();
    if (!ctx) { return undefined; }
    const board = boardKeyOf(await this.identityFor(consent));
    const known = (await ctx.store.load(board)).files[where.rel];
    let localSha: string | undefined;
    if (where.kind === 'file') {
      localSha = (await sha256File(where.abs)).sha256;
      const yoursIsNewer = known === undefined || localSha !== known.sha256;
      if (yoursIsNewer) {
        const replace = 'Replace my copy (back it up first)';
        const choice = await vscode.window.showWarningMessage(
          known ? `Your copy of ${where.rel} changed since the last sync. Replace it with the board's version?` : `Replace your ${where.rel} with the board's version?`,
          { modal: true, detail: 'Your copy is saved in the sync backups before it is replaced.' }, replace, 'Compare first',
        );
        if (choice === 'Compare first') { await this.compareWithBoard(node.devicePath); return undefined; }
        if (choice !== replace) { return undefined; }
      }
    }
    const plan: SyncPlan = {
      direction: 'fromBoard', createdAt: this.now().toISOString(), workspaceRoot: ctx.mapper.workspaceRoot, rootPath: ctx.mapper.rootPath,
      boardId: board.derived ? null : board.id, compare: 'sha256', warnings: [],
      items: [{ path: where.rel, remote: node.devicePath, local: where.abs, kind: 'file', action: 'download', reason: 'user-request', size: node.size ?? 0, localSha256: localSha, baseSha256: known?.sha256, selected: true }],
    };
    const result = await this.engine.execute(plan, { baseline: ctx.store, board, title: `Downloading ${where.rel}`, quiet: true });
    this.noteTransfers(result);
    const r = result.results[0];
    if (r?.status === 'ok') {
      this.status.set(node.devicePath, 'in-sync', { rel: where.rel });
      void showToast(this.services.log, 'info', `Downloaded ${node.devicePath} into your project as ${where.rel}.`);
    } else {
      void showToast(this.services.log, 'warning', r?.message ?? `${where.rel} could not be downloaded.`);
    }
    return result;
  }

  /** "Compare with the Board's Copy": VS Code's diff of the board's file (left, read-only) and the project's (right). */
  async compareWithBoard(arg: unknown): Promise<void> {
    const devicePath = typeof arg === 'string' ? arg : this.nodeOf(arg)?.devicePath;
    if (!devicePath) { return; }
    const where = await this.localCounterpart(devicePath);
    const name = nodePath.posix.basename(devicePath);
    if (where.kind !== 'file') {
      await vscode.window.showTextDocument(boardDocumentUri(devicePath), { preview: true });
      void vscode.window.showInformationMessage(`Your project folder has no ${name}, so this is only the board's copy.`);
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', boardDocumentUri(devicePath), vscode.Uri.file(where.abs), `${name}: board (left) and your computer (right)`);
  }

  /** The "?" button of the Files view: what the marks mean. */
  async showLegend(): Promise<void> {
    await vscode.window.showInformationMessage('What the marks in the Files view mean', { modal: true, detail: legendText() });
  }
}
