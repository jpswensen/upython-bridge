/**
 * Sync status per board path (SyncStatusSource: the Files-view badges, hover help and the rows of project files that are not on
 * the board yet; decision D-21). Filled from the last comparison (a plan: local hashes, the board manifest and the baseline),
 * from auto-sync's own bookkeeping, from local saves and from unsaved editors. A badge is a hint, never an input to a decision:
 * decisions always re-hash and uploads check the board copy first (fs.put ifSha, CLAUDE.md rule 7).
 *
 * Two layers: the COMPARISON of a path (what a sync would do) and OVERLAYS that win while they last: unsaved editor changes,
 * waiting for auto-sync, a failed upload.
 */
import * as vscode from 'vscode';
import type { LocalOnlyEntry, SyncBadge, SyncPlan, SyncReason, SyncStatusDetail, SyncStatusSource } from '../types/sync';

/** Comparison reasons (src/sync/plan.ts) -> the badge they show. Direction-neutral: the plan is always built 'toBoard'. */
export function badgeOfReason(reason: SyncReason): SyncBadge | undefined {
  switch (reason) {
    case 'identical': return 'in-sync';
    case 'new-local':
    case 'board-missing': return 'local-only';
    case 'local-changed': return 'local-changed';
    case 'board-changed': return 'board-changed';
    case 'both-changed': return 'conflict';
    case 'first-sync-differs': return 'differs';
    case 'board-only':
    case 'local-deleted': return 'board-only';
    default: return undefined;
  }
}

interface PathFacts {
  base: SyncBadge;
  rel?: string;
  /** For `local-only` rows: size of the project file. */
  size?: number;
}

function parentOf(devicePath: string): string {
  const i = devicePath.lastIndexOf('/');
  return i <= 0 ? '/' : devicePath.slice(0, i);
}

export class SyncStatus implements SyncStatusSource, vscode.Disposable {
  private readonly facts = new Map<string, PathFacts>();
  private readonly dirty = new Set<string>();
  private readonly waiting = new Set<string>();
  private readonly failed = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private checkedAt: Date | undefined;
  private autoSyncOn = false;
  readonly onDidChange = (listener: () => unknown): vscode.Disposable => this.emitter.event(listener);

  // ------------------------------------------------------------------ SyncStatusSource

  badgeFor(devicePath: string): SyncBadge | undefined {
    return this.detailFor(devicePath)?.badge;
  }

  detailFor(devicePath: string): SyncStatusDetail | undefined {
    const f = this.facts.get(devicePath);
    const overlay: SyncBadge | undefined = this.failed.has(devicePath) ? 'failed'
      : this.dirty.has(devicePath) ? 'unsaved'
        : this.waiting.has(devicePath) ? 'waiting' : undefined;
    const badge = overlay ?? f?.base;
    if (badge === undefined) { return undefined; }
    return { badge, base: f?.base, rel: f?.rel, checkedAt: this.checkedAt, failure: this.failed.get(devicePath), autoSync: this.autoSyncOn };
  }

  localOnlyIn(folder: string): readonly LocalOnlyEntry[] {
    const prefix = folder === '/' ? '/' : `${folder}/`;
    const out = new Map<string, LocalOnlyEntry>();
    for (const [devicePath, f] of this.facts) {
      if (f.base !== 'local-only' || !devicePath.startsWith(prefix)) { continue; }
      const rest = devicePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        out.set(devicePath, { devicePath, name: rest, kind: 'file', size: f.size });
      } else {
        const dir = prefix + rest.slice(0, slash);
        if (!out.has(dir)) { out.set(dir, { devicePath: dir, name: rest.slice(0, slash), kind: 'dir' }); }
      }
    }
    return [...out.values()];
  }

  // ------------------------------------------------------------------ updates

  /** Replace every comparison with what `plan` found (overlays stay). */
  fromPlan(plan: SyncPlan, at: Date = new Date()): void {
    this.facts.clear();
    for (const it of plan.items) {
      if (it.kind !== 'file') { continue; }
      const base = badgeOfReason(it.reason);
      if (base) { this.facts.set(it.remote, { base, rel: it.path, size: base === 'local-only' ? it.size : undefined }); }
    }
    this.checkedAt = at;
    this.emitter.fire();
  }

  /** The comparison of one path (after an upload, a save, a copy); `undefined` forgets it. Overlays are cleared by the caller. */
  set(devicePath: string, badge: SyncBadge | undefined, extra: { rel?: string; size?: number } = {}): void {
    if (badge === undefined) {
      this.facts.delete(devicePath);
      this.failed.delete(devicePath);
      this.waiting.delete(devicePath);
    } else if (badge === 'unsaved' || badge === 'waiting' || badge === 'failed') {
      throw new Error(`${badge} is an overlay; use setDirty/setWaiting/setFailed`);
    } else {
      const old = this.facts.get(devicePath);
      this.facts.set(devicePath, { base: badge, rel: extra.rel ?? old?.rel, size: badge === 'local-only' ? (extra.size ?? old?.size) : undefined });
      if (badge === 'in-sync') { this.failed.delete(devicePath); this.waiting.delete(devicePath); }
    }
    this.emitter.fire();
  }

  /** The comparison of a path as last known (without overlays). */
  baseOf(devicePath: string): SyncBadge | undefined {
    return this.facts.get(devicePath)?.base;
  }

  setDirty(devicePath: string, dirty: boolean): void {
    if (dirty === this.dirty.has(devicePath)) { return; }
    if (dirty) { this.dirty.add(devicePath); } else { this.dirty.delete(devicePath); }
    this.emitter.fire();
  }

  setWaiting(devicePath: string, waiting: boolean): void {
    if (waiting === this.waiting.has(devicePath)) { return; }
    if (waiting) { this.waiting.add(devicePath); } else { this.waiting.delete(devicePath); }
    this.emitter.fire();
  }

  setFailed(devicePath: string, message: string | undefined): void {
    if (message === undefined) {
      if (!this.failed.delete(devicePath)) { return; }
    } else {
      this.failed.set(devicePath, message);
    }
    this.emitter.fire();
  }

  /** Whether auto-sync sends saves for the connected board (shown in the hover help). */
  setAutoSync(on: boolean): void {
    if (on === this.autoSyncOn) { return; }
    this.autoSyncOn = on;
    this.emitter.fire();
  }

  /** Board-only paths as last compared (to notice files a program created during a Run). */
  boardOnlyPaths(): Set<string> {
    return new Set([...this.facts].filter(([, f]) => f.base === 'board-only').map(([p]) => p));
  }

  /** Counts for the status bar / summaries. */
  counts(): Record<SyncBadge, number> {
    const c = { 'in-sync': 0, 'local-changed': 0, 'local-only': 0, 'board-changed': 0, 'board-only': 0, conflict: 0, differs: 0, unsaved: 0, waiting: 0, failed: 0 } as Record<SyncBadge, number>;
    for (const p of new Set([...this.facts.keys(), ...this.dirty, ...this.waiting, ...this.failed.keys()])) {
      const b = this.badgeFor(p);
      if (b) { c[b]++; }
    }
    return c;
  }

  /** Paths whose folder rows may have changed (for the Files view): parents of local-only paths. */
  localOnlyFolders(): Set<string> {
    const out = new Set<string>();
    for (const [p, f] of this.facts) {
      if (f.base === 'local-only') { out.add(parentOf(p)); }
    }
    return out;
  }

  clear(): void {
    this.facts.clear();
    this.failed.clear();
    this.waiting.clear();
    this.checkedAt = undefined;
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
    this.facts.clear();
  }
}
