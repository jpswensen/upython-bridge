/**
 * Executes a SyncPlan through BoardSession: per-file results, continue-on-error, cancellation, backups of anything that gets
 * overwritten, and a baseline that only learns about files that really succeeded (CLAUDE.md rule 7, R-ARCH-6).
 */
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import { showToast } from '../toast';
import type { BoardSession } from '../types/session';
import { BoardError, userMessage } from '../types/session';
import type { SyncItem, SyncItemResult, SyncItemStatus, SyncPlan, SyncResult } from '../types/sync';
import type { BaselineStore, BoardKey } from './baseline';
import { BoardChanges } from './boardChanges';
import {
  Consent, askToInterrupt, callWithConsent, describeFailure, isAborted, isConnectionError, rmtreeWithConsent,
} from './boardAccess';
import { effectiveAction } from './plan';
import { STARTUP_FILES, SYNC_STATE, type StateStore } from './state';

/** How many backup folders are kept (oldest are removed first). */
export const BACKUP_KEEP = 20;

/** Time allowed for one transfer: 2 KB/s worst case plus 10 s of overhead (03 section 6.9). */
export function transferTimeoutMs(size: number): number {
  return Math.max(15000, Math.ceil(size / 2048) * 1000 + 10000);
}

function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Copies of files that are about to be overwritten: `<storage>/backups/<timestamp>/<workspace-relative path>`. */
export class BackupSession {
  private made = false;
  readonly dir: string;

  constructor(private readonly root: string, now: Date) {
    this.dir = nodePath.join(root, stamp(now));
  }

  get used(): boolean { return this.made; }

  /** Where a backup of `rel` goes (the folder is created). */
  async pathFor(rel: string): Promise<string> {
    const dest = nodePath.join(this.dir, ...rel.split('/'));
    await fsp.mkdir(nodePath.dirname(dest), { recursive: true });
    this.made = true;
    return dest;
  }

  async saveLocal(abs: string, rel: string): Promise<string> {
    const dest = await this.pathFor(rel);
    await fsp.copyFile(abs, dest);
    return dest;
  }

  /** Keep only the newest `keep` backup folders. */
  async prune(keep = BACKUP_KEEP): Promise<void> {
    const names = (await fsp.readdir(this.root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const old of names.slice(0, Math.max(0, names.length - keep))) {
      await fsp.rm(nodePath.join(this.root, old), { recursive: true, force: true });
    }
  }
}

export interface ExecuteOptions {
  baseline: BaselineStore;
  board: BoardKey;
  /** Heading of the progress notification, for example "Uploading to the board". */
  title: string;
  /** Auto-sync and other background callers: window progress, no questions, no summary toast on success. */
  background?: boolean;
  signal?: AbortSignal;
  /** Skip the summary toast (the caller shows its own). */
  quiet?: boolean;
}

export interface EngineDeps {
  session: BoardSession;
  log: Logger;
  /** `<storageUri>/backups` */
  backupRoot: string;
  state: StateStore;
  now?: () => Date;
}

const VERB: Record<string, { done: string; doing: string }> = {
  upload: { done: 'uploaded', doing: 'Uploading' },
  download: { done: 'downloaded', doing: 'Downloading' },
  mkdir: { done: 'folders created', doing: 'Creating folder' },
  'delete-board': { done: 'deleted from the board', doing: 'Deleting' },
  'delete-local': { done: 'moved to the trash', doing: 'Deleting' },
};

export class SyncEngine {
  private readonly now: () => Date;
  /** Folder of the backup made by the most recent run, if any. */
  lastBackupDir: string | undefined;
  /**
   * Everything this engine creates, rewrites or removes on the board is announced here, once per `execute()` (and per
   * `removeChildren()`), so the Files view re-lists the folders involved. Skipped, failed and cancelled items announce nothing.
   */
  readonly changes = new BoardChanges();

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** True when an open editor holds unsaved changes for this file (those are never overwritten). */
  isDirty(abs: string): boolean {
    const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
    return vscode.workspace.textDocuments.some((d) => d.isDirty && norm(d.uri.fsPath) === norm(abs));
  }

  /** Run the selected items of `plan`. Never throws for per-file problems: they are in the result. */
  async execute(plan: SyncPlan, opts: ExecuteOptions): Promise<SyncResult> {
    const items = plan.items.filter((i) => i.selected && i.action !== 'unchanged');
    const controller = new AbortController();
    const outer = opts.signal;
    const onOuterAbort = (): void => controller.abort();
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    if (outer?.aborted) {
      controller.abort();
    }
    const run = (progress: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken): Promise<SyncResult> => {
      token?.onCancellationRequested(() => controller.abort());
      return this.runItems(plan, items, opts, controller.signal, progress);
    };
    let result: SyncResult;
    try {
      result = await vscode.window.withProgress(
        {
          location: opts.background ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
          title: opts.title,
          cancellable: opts.background !== true,
        },
        (progress, token) => run(progress, token),
      );
    } finally {
      outer?.removeEventListener('abort', onOuterAbort);
    }
    if (!opts.quiet) {
      await this.report(result, opts.background === true);
    }
    return result;
  }

  private async runItems(
    plan: SyncPlan, items: SyncItem[], opts: ExecuteOptions, signal: AbortSignal, progress: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<SyncResult> {
    const { session, log } = this.deps;
    const startedAt = this.now().toISOString();
    const consent = new Consent(() => askToInterrupt(plan.direction === 'toBoard' ? 'Sending files' : 'Downloading files'), opts.background === true);
    const backup = new BackupSession(this.deps.backupRoot, this.now());
    const results: SyncItemResult[] = [];
    const verified: { path: string; sha256: string; size: number }[] = [];
    const forget: string[] = [];
    const changed: string[] = [];
    let stopReason: { status: SyncItemStatus; message: string } | undefined;

    const listener = session.onEvent((ev) => {
      if (ev.ev === 'progress' && ev.total > 0) {
        progress.report({ message: `${ev.label} ${Math.min(100, Math.round((ev.done / ev.total) * 100))}%` });
      }
    });
    try {
      await this.noticeForStartupFiles(plan, items);
      let index = 0;
      for (const item of items) {
        index++;
        if (stopReason === undefined && signal.aborted) {
          stopReason = { status: 'cancelled', message: 'Cancelled.' };
        }
        if (stopReason) {
          results.push({ item, status: stopReason.status, message: stopReason.message });
          continue;
        }
        const action = effectiveAction(plan, item);
        progress.report({ message: `${VERB[action]?.doing ?? 'Working on'} ${item.path} (${index}/${items.length})`, increment: 100 / Math.max(1, items.length) });
        try {
          const r = await this.runItem(plan, item, action, { consent, backup, signal, background: opts.background === true });
          results.push(r.result);
          if (r.verified) { verified.push(r.verified); }
          if (r.forget) { forget.push(r.forget); }
          if (r.changed) { changed.push(r.changed); }
        } catch (err) {
          const aborted = isAborted(err) || signal.aborted;
          const fail = describeFailure(item.path, err);
          if (aborted) {
            stopReason = { status: 'cancelled', message: 'Cancelled.' };
            results.push({ item, status: 'cancelled', code: 'E_ABORTED', message: 'Cancelled.' });
          } else {
            const current = err instanceof BoardError && err.code === 'E_DEST_CHANGED' ? err.body.current : undefined;
            if (current) {
              log.info(`sync: ${item.path} was not sent: the board copy changed since the last sync`);
            } else {
              log.error(`sync: ${action} ${item.path} failed`, err);
            }
            results.push({
              item, status: 'failed', code: fail.code, message: fail.message,
              ...(current ? { current: { exists: current.exists, sha256: current.sha256, size: current.size } } : {}),
            });
            if (isConnectionError(err)) {
              stopReason = { status: 'cancelled', message: `Not attempted: the connection to the board was lost (${userMessage(err)})` };
            }
          }
        }
      }
    } finally {
      listener.dispose();
      this.changes.notify(changed); // also after an unexpected error: whatever was written is on the board
    }

    const baselineUpdated = [...new Set(verified.map((v) => v.path).concat(forget))];
    if (verified.length > 0 || forget.length > 0) {
      try {
        await opts.baseline.record(opts.board, verified, forget);
      } catch (err) {
        log.error('sync: could not save the sync history', err);
        void vscode.window.showWarningMessage(
          'The files were copied, but the sync history could not be saved, so the next sync will compare every file again. That is safe, only slower.',
        );
      }
    }
    if (backup.used) {
      this.lastBackupDir = backup.dir;
      try {
        await backup.prune();
      } catch (err) {
        log.warn('sync: could not remove old backups', err);
      }
    }

    const counts: Record<SyncItemStatus, number> = { ok: 0, failed: 0, skipped: 0, cancelled: 0 };
    for (const r of results) { counts[r.status]++; }
    return { plan, results, counts, baselineUpdated, startedAt, finishedAt: this.now().toISOString(), cancelled: results.some((r) => r.status === 'cancelled') };
  }

  /** The one-time notice that main.py/boot.py run by themselves at power-up (RQ-SAFE-7). */
  private async noticeForStartupFiles(plan: SyncPlan, items: SyncItem[]): Promise<void> {
    if (plan.direction !== 'toBoard' || this.deps.state.get<boolean>(SYNC_STATE.bootNoticeShown) === true) {
      return;
    }
    const hit = items.find((i) => STARTUP_FILES.includes(i.remote) && i.action !== 'delete-board');
    if (!hit) {
      return;
    }
    await this.deps.state.update(SYNC_STATE.bootNoticeShown, true);
    void vscode.window.showInformationMessage(
      `Note: ${hit.remote} runs by itself every time the board starts (boot.py first, then main.py). Uploading it changes what your board does at power-up. Remove it from the board if you do not want that.`,
    );
  }

  private async runItem(
    plan: SyncPlan, item: SyncItem, action: ReturnType<typeof effectiveAction>,
    env: { consent: Consent; backup: BackupSession; signal: AbortSignal; background: boolean },
  ): Promise<{ result: SyncItemResult; verified?: { path: string; sha256: string; size: number }; forget?: string; changed?: string }> {
    const { session } = this.deps;
    const { consent, backup, signal } = env;
    const ok = (extra: Partial<SyncItemResult> = {}): SyncItemResult => ({ item, status: 'ok', ...extra });
    switch (action) {
      case 'upload': {
        if (item.action === 'conflict' && item.boardSha256 !== undefined) {
          await this.backupBoardCopy(item, backup, consent, signal, env.background);
        }
        const r = await callWithConsent(session, consent, 'fs.put', {
          local: item.local, remote: item.remote, mkdirs: true, expectSha: item.localSha256, background: env.background || undefined,
          ...(item.ifBoardSha !== undefined ? { ifSha: item.ifBoardSha } : {}),
        }, { timeoutMs: transferTimeoutMs(item.size), signal });
        // `skipped`: the board already had these exact bytes, so nothing changed there.
        return { result: ok({ bytes: r.sent, sha256: r.sha256 }), verified: { path: item.path, sha256: r.sha256, size: r.bytes }, changed: r.skipped ? undefined : item.remote };
      }
      case 'download': {
        const exists = item.localSha256 !== undefined;
        if (exists && this.isDirty(item.local)) {
          return { result: { item, status: 'skipped', code: 'E_DIRTY', message: `${item.path} has unsaved changes in the editor, so it was not replaced. Save or close it, then download again.` } };
        }
        if (exists) {
          await backup.saveLocal(item.local, item.path);
        }
        const r = await callWithConsent(session, consent, 'fs.get', { remote: item.remote, local: item.local }, { timeoutMs: transferTimeoutMs(item.size), signal });
        return { result: ok({ bytes: r.bytes, sha256: r.sha256 }), verified: { path: item.path, sha256: r.sha256, size: r.bytes } };
      }
      case 'mkdir': {
        if (plan.direction === 'toBoard') {
          const made = await callWithConsent(session, consent, 'fs.mkdir', { path: item.remote, parents: true }, { signal });
          return { result: ok(), changed: made.created > 0 ? item.remote : undefined };
        }
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(item.local));
        return { result: ok() };
      }
      case 'delete-board': {
        await callWithConsent(session, consent, 'fs.rm', { path: item.remote }, { signal });
        return { result: ok(), forget: item.path, changed: item.remote };
      }
      case 'delete-local': {
        if (this.isDirty(item.local)) {
          return { result: { item, status: 'skipped', code: 'E_DIRTY', message: `${item.path} has unsaved changes in the editor, so it was not deleted.` } };
        }
        await vscode.workspace.fs.delete(vscode.Uri.file(item.local), { useTrash: true });
        return { result: ok(), forget: item.path };
      }
      default:
        return { result: { item, status: 'skipped', message: 'Nothing to do.' } };
    }
  }

  /** Before a ticked conflict overwrites the board's copy, keep that copy (R-FS-11 mirror image). */
  private async backupBoardCopy(item: SyncItem, backup: BackupSession, consent: Consent, signal: AbortSignal, background: boolean): Promise<void> {
    if (background) {
      return;
    }
    const dest = await backup.pathFor(`board/${item.path}`);
    try {
      await callWithConsent(this.deps.session, consent, 'fs.get', { remote: item.remote, local: dest }, { timeoutMs: transferTimeoutMs(item.size), signal });
    } catch (err) {
      if (isAborted(err)) { throw err; }
      const fail = describeFailure(item.path, err);
      throw new Error(`The board's version could not be saved as a backup, so it was not overwritten. ${fail.message}`);
    }
  }

  // ------------------------------------------------------------------ reporting

  /** "12 uploaded, 1 failed: main.py - <hint>" */
  summaryText(result: SyncResult): string {
    const tally = new Map<string, number>();
    for (const r of result.results) {
      if (r.status === 'ok') {
        const key = VERB[effectiveAction(result.plan, r.item)]?.done ?? 'done';
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
    const parts = [...tally.entries()].map(([what, n]) => `${n} ${what}`);
    const failed = result.results.filter((r) => r.status === 'failed');
    if (failed.length > 0) {
      const first = failed[0];
      const prefix = first ? `${first.item.path}: ` : '';
      const reason = first?.message?.startsWith(prefix) ? first.message.slice(prefix.length) : first?.message ?? 'see the log';
      const more = failed.length > 1 ? ` (and ${failed.length - 1} more, see the log)` : '';
      parts.push(`${failed.length} failed: ${first?.item.path ?? ''} - ${reason}${more}`);
    }
    const skipped = result.results.filter((r) => r.status === 'skipped');
    if (skipped.length > 0) {
      parts.push(`${skipped.length} skipped: ${skipped[0]?.message ?? ''}`);
    }
    const cancelled = result.counts.cancelled;
    if (cancelled > 0) {
      parts.push(`${cancelled} not done because it was cancelled or the connection was lost`);
    }
    return parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing needed to be copied.';
  }

  private async report(result: SyncResult, background: boolean): Promise<void> {
    const text = this.summaryText(result);
    const problem = result.counts.failed + result.counts.skipped + result.counts.cancelled > 0;
    const log = this.deps.log;
    log.info(`sync (${result.plan.direction}): ${text}`);
    for (const r of result.results) {
      if (r.status !== 'ok') { log.warn(`sync: ${r.item.path}: ${r.status}: ${r.message ?? ''}`); }
    }
    if (!problem && background) {
      return;
    }
    const buttons: string[] = [];
    if (problem) { buttons.push('Show Log'); }
    if (this.lastBackupDir && result.plan.direction === 'fromBoard') { buttons.push('Show Backups'); }
    const choice = await showToast(log, problem ? 'warning' : 'info', text, ...buttons);
    if (choice === 'Show Log') {
      log.show();
    } else if (choice === 'Show Backups' && this.lastBackupDir) {
      await vscode.env.openExternal(vscode.Uri.file(this.lastBackupDir));
    }
  }

  /** Delete a board folder's contents for Clear Device Files; returns exact counts (R-FS-12). */
  async removeChildren(
    parent: string, names: readonly string[], types: Readonly<Record<string, 'file' | 'dir'>>, consent: Consent, signal?: AbortSignal,
  ): Promise<{ removed: string[]; failed: { path: string; message: string }[]; skipped: string[] }> {
    const out = { removed: [] as string[], failed: [] as { path: string; message: string }[], skipped: [] as string[] };
    try {
      await this.removeEach(out, parent, names, types, consent, signal);
    } finally {
      this.changes.notify(out.removed); // also when cancelled half way: what is gone is gone
    }
    return out;
  }

  private async removeEach(
    out: { removed: string[]; failed: { path: string; message: string }[]; skipped: string[] },
    parent: string, names: readonly string[], types: Readonly<Record<string, 'file' | 'dir'>>, consent: Consent, signal?: AbortSignal,
  ): Promise<void> {
    for (const name of names) {
      const full = parent === '/' ? `/${name}` : `${parent}/${name}`;
      try {
        if (types[name] === 'dir') {
          const r = await rmtreeWithConsent(this.deps.session, consent, full, { signal });
          (r.result === 'removed' ? out.removed : out.skipped).push(full);
        } else {
          await callWithConsent(this.deps.session, consent, 'fs.rm', { path: full }, { signal });
          out.removed.push(full);
        }
      } catch (err) {
        if (isAborted(err)) { throw err; }
        this.deps.log.error(`sync: could not delete ${full}`, err);
        out.failed.push({ path: full, message: describeFailure(full, err).message });
        if (isConnectionError(err)) { break; }
      }
    }
  }
}
