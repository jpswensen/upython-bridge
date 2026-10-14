/**
 * Auto-sync (D-10, D-21): upload a file when the student saves it. `autoSync` is `on` (default since D-21), `off`, or the older
 * `ask`. Uploads go only from this computer to the board, never back. Two guards of D-21: nothing is sent to a board that was
 * never reviewed with this folder on this computer (the first-sync review of SyncService opens the gate with `setReviewed`), and
 * every upload carries a precondition on the board's current copy (fs.put `ifSha`): a board copy that changed since the last
 * sync (a program wrote it, another computer, a lab partner) is never replaced; the file is marked and the host offers choices.
 *
 * Guards, each with a test: debounce and coalesce per path; compare the content hash with the baseline so a file that was only
 * touched (cloud clients do that) uploads nothing (RQ-CLOUD-4); defer while a program is running or the board is not idle and
 * show "N files waiting" through `session.setPendingSyncCount`; background flag so the bridge coalesces; never delete board
 * files; local deletes and renames are reported ("1 file only exists on the board now") and never propagated; nothing at all
 * in an untrusted workspace.
 */
import * as vscode from 'vscode';
import { IDENTITY, LEGACY } from '../identity';
import type { AutoSyncMode } from '../types/settings';
import type { Services } from '../types/services';
import type { SessionState } from '../types/session';
import type { SyncGate, SyncItem, SyncItemResult, SyncPlan } from '../types/sync';
import type { BoardKey } from './baseline';
import type { BaselineStore } from './baseline';
import { CONNECTION_ERRORS } from './boardAccess';
import type { SyncEngine } from './engine';
import type { IgnoreMatcher } from './ignore';
import { sha256File } from './localScan';
import type { PathMapper } from './paths';
import { SYNC_STATE } from './state';
import type { SyncStatus } from './status';

export interface FolderContext {
  folder: vscode.WorkspaceFolder;
  mapper: PathMapper;
  matcher: IgnoreMatcher;
  store: BaselineStore;
}

/** What auto-sync needs from the service that owns the folder, the baseline and the plan builder. */
export interface AutoSyncHost {
  folderContext(): Promise<FolderContext | undefined>;
  /** The board's baseline key. `passive` never talks to the board and may answer from memory. */
  boardKey(opts: { passive: boolean }): Promise<BoardKey | undefined>;
  /** `.mpyignore` was created, changed or deleted: rules must be re-read. */
  ignoreFileChanged(): void;
  /** Show what an upload of everything would do, without changing anything (the "Preview first" button). */
  dryRun(): Promise<void>;
  /** A project file was saved, created or changed (any auto-sync mode): update its mark in the Files view. */
  noteLocalChange?(uri: vscode.Uri): void;
  /** Saved files wait because the connected board has not had its first-sync review: run it, or say why they wait. */
  reviewNeeded?(): void;
  /** Saved files that were NOT sent because the board copy changed since the last sync (E_DEST_CHANGED): offer choices. */
  onDestChanged?(results: readonly SyncItemResult[]): void;
  /** What the board holds now at `remote` after an upload or a refused upload (keeps the instant marks of later saves right). */
  boardCopyIs?(remote: string, copy: { sha256: string | null; size: number; exists: boolean }): void;
}

/** Timer functions, injectable so tests do not wait in real time. */
export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AutoSyncDeps {
  services: Services;
  engine: SyncEngine;
  status: SyncStatus;
  host: AutoSyncHost;
  scheduler?: Scheduler;
}

interface FlushOutcome { uploaded: number; failed: number }

const DEFERRABLE = new Set(['E_PROGRAM_RUNNING', ...CONNECTION_ERRORS]);

export class AutoSync implements SyncGate, vscode.Disposable {
  private readonly pending = new Map<string, string>();
  private readonly timers = new Map<string, { handle: unknown; abs: string }>();
  private readonly reported = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sched: Scheduler;
  private flushChain: Promise<unknown> = Promise.resolve();
  private started = false;
  private asking = false;
  /** D-21: the first-sync review of the connected board is done (set by SyncService); uploads wait until then. */
  private reviewed = false;
  private lastState: SessionState['state'];

  constructor(private readonly deps: AutoSyncDeps) {
    this.sched = deps.scheduler ?? realScheduler;
    this.lastState = deps.services.session.state.state;
  }

  // ------------------------------------------------------------------ mode

  /** The mode in force: the setting, or for `ask` the answer remembered from the first-connect question. */
  mode(): AutoSyncMode {
    const { settings, context } = this.deps.services;
    const setting = settings.autoSync;
    if (setting !== 'ask') {
      return setting;
    }
    const remembered = context.workspaceState.get<string>(SYNC_STATE.autoSyncChoice);
    return remembered === 'on' || remembered === 'off' ? remembered : 'ask';
  }

  private active(): boolean {
    return vscode.workspace.isTrusted && this.mode() === 'on';
  }

  /** Whether saves go to the connected board right now: auto-sync on AND the first-sync review of this board done. */
  sending(): boolean {
    return this.active() && this.reviewed;
  }

  /** SyncService: the first-sync review of the connected board is done (true) or a new board/connection needs one (false). */
  setReviewed(reviewed: boolean): void {
    this.reviewed = reviewed;
    this.deps.status.setAutoSync(this.sending());
    if (reviewed) { void this.guard('send waiting files', () => this.tryFlush()); }
  }

  /** Toggle button: on <-> off (an older `ask` setting counts as off). Writes the workspace setting; the remembered answer is cleared. */
  async cycleMode(): Promise<AutoSyncMode> {
    const current = this.mode();
    const next: AutoSyncMode = current === 'on' ? 'off' : 'on';
    await this.deps.services.settings.update('autoSync', next, vscode.ConfigurationTarget.Workspace);
    await this.deps.services.context.workspaceState.update(SYNC_STATE.autoSyncChoice, undefined);
    this.deps.services.settings.notifyChanged?.(['autoSync']);
    const text = next === 'on'
      ? 'Auto-sync is ON: every file you save is copied to the board.'
      : next === 'off'
        ? 'Auto-sync is OFF: files are only copied when you use Upload All Files or Upload Current File.'
        : 'Auto-sync will ask you the next time a board connects.';
    void vscode.window.showInformationMessage(text);
    this.deps.services.log.info(`sync: auto-sync set to ${next}`);
    this.deps.status.setAutoSync(this.sending());
    if (next === 'on') {
      void this.guard('send waiting files', () => this.tryFlush());
    } else {
      this.dropAll();
    }
    return next;
  }

  // ------------------------------------------------------------------ listeners

  /** Step 10 of activation: start listening. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const d = this.disposables;
    const { session, settings } = this.deps.services;
    d.push(vscode.workspace.onDidSaveTextDocument((doc) => this.noteChange(doc.uri)));
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      d.push(watcher, watcher.onDidCreate((u) => this.noteChange(u)), watcher.onDidChange((u) => this.noteChange(u)), watcher.onDidDelete((u) => this.onGone([u])));
    }
    d.push(vscode.workspace.onDidDeleteFiles((e) => this.onGone(e.files)));
    d.push(vscode.workspace.onDidRenameFiles((e) => this.onRenamed(e.files)));
    d.push(session.onDidChangeState((s) => this.onState(s)));
    d.push(settings.onDidChange((keys) => {
      if (keys.includes('autoSync')) {
        this.deps.status.setAutoSync(this.sending());
        if (this.active()) { void this.guard('send waiting files', () => this.tryFlush()); } else { this.dropAll(); }
      }
    }));
  }

  dispose(): void {
    this.dropAll();
    this.disposables.splice(0).forEach((x) => x.dispose());
    this.started = false;
  }

  private dropAll(): void {
    for (const t of this.timers.values()) { this.sched.clear(t.handle); }
    this.timers.clear();
    this.pending.clear();
    this.updateCount();
  }

  // ------------------------------------------------------------------ bookkeeping

  /** Resolves when the uploads already queued have finished (tests wait for it before they remove their folders). */
  whenIdle(): Promise<void> {
    return this.flushChain.then(() => undefined, () => undefined);
  }

  get pendingCount(): number {
    return new Set([...this.pending.keys(), ...this.timers.keys()]).size;
  }

  private updateCount(): void {
    this.deps.services.session.setPendingSyncCount(this.pendingCount);
  }

  private async guard(what: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.deps.services.log.error(`sync: auto-sync could not ${what}`, err);
      void vscode.window.showWarningMessage(`Auto-sync could not ${what}: ${err instanceof Error ? err.message : String(err)}`, 'Show Log')
        .then((c) => { if (c === 'Show Log') { this.deps.services.log.show(); } });
    }
  }

  // ------------------------------------------------------------------ saves and file events

  private noteChange(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
      return;
    }
    this.deps.host.noteLocalChange?.(uri); // the mark follows every save, whatever the auto-sync mode (D-21)
    if (!this.active()) {
      return;
    }
    void this.guard('check a saved file', async () => {
      const ctx = await this.deps.host.folderContext();
      if (!ctx) { return; }
      const rel = ctx.mapper.localToRel(uri.fsPath);
      if (rel === undefined) { return; }
      if (rel === IDENTITY.ignoreFile || rel === `${LEGACY.dotDir}/${LEGACY.ignoreFile}`) {
        this.deps.host.ignoreFileChanged();
        return;
      }
      if (ctx.matcher.ignores(rel)) { return; }
      this.schedule(rel, uri.fsPath);
    });
  }

  private schedule(rel: string, abs: string): void {
    const old = this.timers.get(rel);
    if (old) { this.sched.clear(old.handle); }
    this.reported.delete(rel);
    const handle = this.sched.set(() => {
      this.timers.delete(rel);
      void this.guard('send a saved file', async () => { this.pending.set(rel, abs); this.updateCount(); await this.tryFlush(); });
    }, this.deps.services.settings.syncDebounceMs);
    this.timers.set(rel, { handle, abs });
    this.updateCount();
  }

  private tryFlush(): Promise<unknown> {
    if (!this.active() || this.pending.size === 0) {
      return Promise.resolve();
    }
    if (this.deps.services.session.state.state !== 'idle' || !this.reviewed) {
      // deferred: the files stay in the waiting list and go out when the board is idle (and reviewed); the Files view says so
      if (this.reviewed) { void this.markWaiting(); } else { this.deps.host.reviewNeeded?.(); }
      return Promise.resolve();
    }
    return this.flush();
  }

  /** The waiting files get the "waiting" mark (a program runs or the board is not connected). */
  private async markWaiting(): Promise<void> {
    const ctx = await this.deps.host.folderContext();
    if (!ctx) { return; }
    for (const rel of this.pending.keys()) { this.deps.status.setWaiting(ctx.mapper.relToDevice(rel), true); }
  }

  private flush(): Promise<FlushOutcome> {
    const run = (): Promise<FlushOutcome> => this.doFlush();
    const next = this.flushChain.then(run, run) as Promise<FlushOutcome>;
    this.flushChain = next.catch(() => undefined); // the caller sees the rejection; the queue keeps going
    return next;
  }

  private async doFlush(): Promise<FlushOutcome> {
    const { engine, status, host, services } = this.deps;
    const ctx = await host.folderContext();
    if (!ctx || this.pending.size === 0) {
      return { uploaded: 0, failed: 0 };
    }
    const board = await host.boardKey({ passive: false });
    if (!board) {
      return { uploaded: 0, failed: this.pending.size }; // not identified yet: keep everything waiting
    }
    const base = (await ctx.store.load(board)).files;
    const items: SyncItem[] = [];
    for (const [rel, abs] of [...this.pending]) {
      let hash: { sha256: string; size: number };
      try {
        hash = await sha256File(abs);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        this.pending.delete(rel);
        if (code !== 'ENOENT' && code !== 'EISDIR') {
          services.log.warn(`sync: could not read ${rel}`, err);
          void vscode.window.showWarningMessage(`Auto-sync could not read ${rel} (${(err as Error).message}). Save it again when it is no longer in use.`);
        }
        continue;
      }
      const remote = ctx.mapper.relToDevice(rel);
      const known = base[rel];
      if (known && known.sha256 === hash.sha256) {
        this.pending.delete(rel); // touched, not changed: nothing to send (RQ-CLOUD-4)
        status.set(remote, 'in-sync');
        continue;
      }
      status.set(remote, known ? 'local-changed' : 'local-only', { rel, size: hash.size });
      items.push({
        path: rel, remote, local: abs, kind: 'file', action: 'upload', reason: known ? 'local-changed' : 'new-local', size: hash.size,
        localSha256: hash.sha256, baseSha256: known?.sha256, selected: true,
        // D-21: replace the board copy only if it is still what we last synced (or there is none yet)
        ifBoardSha: known ? known.sha256 : 'absent',
      });
    }
    this.updateCount();
    if (items.length === 0) {
      return { uploaded: 0, failed: 0 };
    }
    const plan: SyncPlan = {
      direction: 'toBoard', createdAt: new Date().toISOString(), workspaceRoot: ctx.mapper.workspaceRoot, rootPath: ctx.mapper.rootPath,
      boardId: board.derived ? null : board.id, compare: 'sha256', items, warnings: [],
    };
    const result = await engine.execute(plan, { baseline: ctx.store, board, title: 'Sending saved files to the board', background: true, quiet: true });
    let uploaded = 0;
    const failures: string[] = [];
    const changedOnBoard: SyncItemResult[] = [];
    for (const r of result.results) {
      if (r.status === 'ok') {
        uploaded++;
        this.pending.delete(r.item.path);
        if (r.sha256 !== undefined) { this.deps.host.boardCopyIs?.(r.item.remote, { sha256: r.sha256, size: r.item.size, exists: true }); }
        status.set(r.item.remote, 'in-sync');
      } else if (r.status === 'failed' && r.code === 'E_DEST_CHANGED') {
        if (r.current) { this.deps.host.boardCopyIs?.(r.item.remote, r.current); }
        // the board copy changed since the last sync: never replaced here; the file is marked and the host offers choices
        this.pending.delete(r.item.path);
        status.setWaiting(r.item.remote, false);
        status.set(r.item.remote, r.item.baseSha256 !== undefined ? 'conflict' : 'differs');
        changedOnBoard.push(r);
      } else if (r.status === 'failed' && !DEFERRABLE.has(r.code ?? '')) {
        this.pending.delete(r.item.path);
        status.setWaiting(r.item.remote, false);
        status.setFailed(r.item.remote, r.message ?? `${r.item.path} could not be sent.`);
        failures.push(r.message ?? r.item.path);
      } else {
        status.setWaiting(r.item.remote, true); // cancelled and deferrable failures stay in the waiting list
      }
    }
    if (changedOnBoard.length > 0) { this.deps.host.onDestChanged?.(changedOnBoard); }
    this.updateCount();
    if (uploaded > 0) {
      vscode.window.setStatusBarMessage(`Sent ${uploaded} file${uploaded === 1 ? '' : 's'} to the board`, 3000);
    }
    if (failures.length > 0) {
      void vscode.window.showWarningMessage(`Could not send ${failures.length} file${failures.length === 1 ? '' : 's'} to the board. ${failures[0] ?? ''}`, 'Show Log')
        .then((c) => { if (c === 'Show Log') { services.log.show(); } });
    }
    return { uploaded, failed: failures.length };
  }

  /** SyncGate: send everything waiting now (Run calls this before it runs). */
  async flushPending(): Promise<{ ok: boolean; uploaded: number; failed: number }> {
    if (!this.active()) {
      return { ok: true, uploaded: 0, failed: 0 };
    }
    for (const [rel, t] of [...this.timers]) {
      this.sched.clear(t.handle);
      this.timers.delete(rel);
      this.pending.set(rel, t.abs);
    }
    if (this.pending.size === 0) {
      this.updateCount();
      return { ok: true, uploaded: 0, failed: 0 };
    }
    if (this.deps.services.session.state.state === 'disconnected') {
      return { ok: false, uploaded: 0, failed: this.pending.size };
    }
    if (!this.reviewed) {
      // D-21: this board has not had its first-sync review: nothing is sent; the files stay waiting (Run runs the editor buffer)
      return { ok: true, uploaded: 0, failed: 0 };
    }
    let outcome: FlushOutcome;
    try {
      outcome = await this.flush();
    } catch (err) {
      this.deps.services.log.error('sync: could not send waiting files before Run', err);
      return { ok: false, uploaded: 0, failed: this.pending.size };
    }
    return { ok: this.pending.size === 0 && outcome.failed === 0, uploaded: outcome.uploaded, failed: outcome.failed + this.pending.size };
  }

  // ------------------------------------------------------------------ board state

  private onState(s: SessionState): void {
    const prev = this.lastState;
    this.lastState = s.state;
    if (s.state === 'disconnected' && this.reviewed) {
      this.reviewed = false; // the next board (or this one again) is checked at its connect
      this.deps.status.setAutoSync(false);
    }
    if (s.state === 'idle' && prev !== 'idle') {
      void this.guard('send waiting files', () => this.tryFlush());
    }
    if ((prev === 'disconnected' || prev === 'connecting') && (s.state === 'idle' || s.state === 'running')) {
      void this.guard('ask about auto-sync', () => this.askFirstConnect());
    }
  }

  /** D-10: the one-time question on the first board connect in a workspace. Remembered in workspaceState. */
  async askFirstConnect(): Promise<void> {
    if (this.asking || this.mode() !== 'ask' || !vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.[0]) {
      return;
    }
    this.asking = true;
    try {
      const turnOn = 'Turn on';
      const turnOnShared = 'Turn on and save to workspace settings';
      const preview = 'Show me what would be uploaded';
      const notNow = 'Not now';
      for (;;) {
        const choice = await vscode.window.showInformationMessage(
          'Copy your files to the board automatically every time you save?',
          { detail: 'You can change this later with the auto-sync button in Sync utilities.' },
          turnOn, turnOnShared, preview, notNow,
        );
        if (choice === preview) {
          await this.deps.host.dryRun();
          continue;
        }
        if (choice === turnOn || choice === turnOnShared) {
          await this.deps.services.context.workspaceState.update(SYNC_STATE.autoSyncChoice, 'on');
          this.deps.services.settings.notifyChanged?.(['autoSync']);
          if (choice === turnOnShared) {
            await this.deps.services.settings.update('autoSync', 'on', vscode.ConfigurationTarget.Workspace);
          }
          this.deps.services.log.info('sync: auto-sync turned on by the first-connect question');
          void this.guard('send waiting files', () => this.tryFlush());
        } else if (choice === notNow) {
          await this.deps.services.context.workspaceState.update(SYNC_STATE.autoSyncChoice, 'off');
          this.deps.services.settings.notifyChanged?.(['autoSync']);
          this.deps.services.log.info('sync: auto-sync left off by the first-connect question');
        }
        return; // dismissed (undefined): ask again at the next connect
      }
    } finally {
      this.asking = false;
    }
  }

  // ------------------------------------------------------------------ local deletes and renames: reported, never propagated

  private onGone(uris: readonly vscode.Uri[]): void {
    void this.guard('check a deleted file', () => this.reportGone(uris));
  }

  private onRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): void {
    this.onGone(files.map((f) => f.oldUri));
    for (const f of files) { this.noteChange(f.newUri); }
  }

  private async reportGone(uris: readonly vscode.Uri[]): Promise<void> {
    const ctx = await this.deps.host.folderContext();
    if (!ctx) { return; }
    const gone: string[] = [];
    for (const uri of uris) {
      const rel = uri.scheme === 'file' ? ctx.mapper.localToRel(uri.fsPath) : undefined;
      if (rel === undefined) { continue; }
      for (const key of [...this.pending.keys(), ...this.timers.keys()]) {
        if (key === rel || key.startsWith(`${rel}/`)) {
          const t = this.timers.get(key);
          if (t) { this.sched.clear(t.handle); }
          this.timers.delete(key);
          this.pending.delete(key);
        }
      }
      gone.push(rel);
    }
    this.updateCount();
    const board = await this.deps.host.boardKey({ passive: true });
    if (!board || gone.length === 0) { return; }
    const known = Object.keys((await ctx.store.load(board)).files);
    const onBoard = known.filter((k) => gone.some((g) => k === g || k.startsWith(`${g}/`)) && !this.reported.has(k));
    if (onBoard.length === 0) { return; }
    for (const k of onBoard) {
      this.reported.add(k);
      this.deps.status.set(ctx.mapper.relToDevice(k), 'board-only');
    }
    const names = onBoard.length <= 3 ? onBoard.join(', ') : `${onBoard.slice(0, 3).join(', ')} and ${onBoard.length - 3} more`;
    this.deps.services.log.info(`sync: ${onBoard.length} file(s) deleted or renamed locally still exist on the board: ${onBoard.join(', ')}`);
    void vscode.window.showInformationMessage(
      `${onBoard.length === 1 ? '1 file only exists' : `${onBoard.length} files only exist`} on the board now: ${names}. Nothing was deleted from the board. Delete ${onBoard.length === 1 ? 'it' : 'them'} in the Files view if you do not need ${onBoard.length === 1 ? 'it' : 'them'} any more.`,
    );
  }
}
