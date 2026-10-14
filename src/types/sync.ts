/**
 * Shapes shared by the sync engine, the sync commands, the Sync view and the file decorations
 * (docs/analysis/03-fs-sync.md section 6; CLAUDE.md rule 7). Pure types, no behaviour.
 * Paths: `path` is workspace-relative POSIX; `remote` is an absolute device path (POSIX); `local` is the absolute host path.
 */

export type SyncDirection = 'toBoard' | 'fromBoard';

/** What the plan will do with one item. Deleting is never part of an automatic plan (CLAUDE.md rule 7). */
export type SyncAction = 'upload' | 'download' | 'conflict' | 'unchanged' | 'delete-board' | 'delete-local' | 'mkdir';

/** The row of the decision table (03 section 6.4) that produced the action; shown to the user in the plan preview. */
export type SyncReason =
  | 'identical'
  | 'new-local'
  | 'local-changed'
  | 'board-changed'
  | 'both-changed'
  | 'board-missing'
  | 'local-deleted'
  | 'board-only'
  | 'first-sync-differs'
  | 'user-request';

export interface SyncItem {
  path: string;
  remote: string;
  local: string;
  kind: 'file' | 'dir';
  action: SyncAction;
  reason: SyncReason;
  /** Bytes that will move (0 for unchanged, dirs and deletes). */
  size: number;
  localSha256?: string;
  boardSha256?: string;
  /** Hash recorded in the baseline at the last successful sync of this file. */
  baseSha256?: string;
  /** The user ticked/unticked this item in the preview; defaults to true except conflicts. */
  selected: boolean;
  /**
   * Upload precondition on the board's CURRENT copy (fs.put `ifSha`, D-21): the baseline hash it must still have, or 'absent' for
   * a file the board must not have yet. Not met: the item fails with E_DEST_CHANGED and nothing on the board is replaced.
   */
  ifBoardSha?: string;
}

export interface SyncPlan {
  direction: SyncDirection;
  createdAt: string;
  workspaceRoot: string;
  /** Device folder that corresponds to the workspace root (`rootPath` setting), normalised. */
  rootPath: string;
  /** machine.unique_id() hex of the board the baseline belongs to; null when the board has none. */
  boardId: string | null;
  /** `sha256` when the board could hash; `size` means contents were compared by size only (report it). */
  compare: 'sha256' | 'size';
  items: SyncItem[];
  /** Human-readable notes: ignored folders, online-only files, shadowed module names refused, ... */
  warnings: string[];
}

export type SyncItemStatus = 'ok' | 'failed' | 'skipped' | 'cancelled';

export interface SyncItemResult {
  item: SyncItem;
  status: SyncItemStatus;
  bytes?: number;
  sha256?: string;
  /** For `failed`/`skipped`: classified code from the bridge (E_FS_ERRNO, E_SHADOWS_MODULE, E_LOCAL_IO, ...). */
  code?: string;
  /** English, actionable. */
  message?: string;
  /** E_DEST_CHANGED: what the board holds now (so a caller can back it up and replace it, or offer a comparison). */
  current?: { exists: boolean; sha256: string | null; size: number };
}

export interface SyncResult {
  plan: SyncPlan;
  results: SyncItemResult[];
  counts: Record<SyncItemStatus, number>;
  /** Paths whose baseline entry was updated: only items that succeeded (CLAUDE.md rule 7). */
  baselineUpdated: string[];
  startedAt: string;
  finishedAt: string;
  cancelled: boolean;
}

/** Per-(workspace, board) record kept in `context.storageUri`, never in the project (D-06). */
export interface SyncBaseline {
  version: 1;
  boardId: string;
  /** workspace-relative POSIX path -> state at the last successful sync. No absolute paths. */
  files: Record<string, { sha256: string; size: number; syncedAt: string }>;
}

/**
 * Badge shown on a Files-view item (decision D-21). Arrows say which way a copy is needed: up = from this computer to the board,
 * down = from the board to this computer.
 *  - `in-sync` (check): the same on both sides.
 *  - `local-changed` (up arrow): this computer has newer changes; `local-only` (plus): a new file only on this computer.
 *  - `board-changed` (down arrow): the board has newer changes; `board-only` (down arrow): only on the board.
 *  - `conflict` (!): changed on both sides since the last sync; `differs` (not-equal): different, and never synced on this computer,
 *    so it is not known which one is newer.
 *  - overlays: `unsaved` (dot, unsaved editor changes), `waiting` (auto-sync will send it when the board is idle), `failed`.
 */
export type SyncBadge =
  | 'in-sync' | 'local-changed' | 'local-only' | 'board-changed' | 'board-only' | 'conflict' | 'differs'
  | 'unsaved' | 'waiting' | 'failed';

/** What the hover help of a Files-view item says about one path (decision D-21). */
export interface SyncStatusDetail {
  badge: SyncBadge;
  /** The comparison underneath the overlays (unsaved/waiting/failed): what a save or a sync would do. */
  base?: SyncBadge;
  /** Workspace-relative path, when known. */
  rel?: string;
  /** When the board side was last compared. */
  checkedAt?: Date;
  /** Why the last upload failed (English). */
  failure?: string;
  /** Auto-sync is on and reviewed for this board: a save sends the file. */
  autoSync?: boolean;
}

/** A file that is only in the project (not on the board yet), shown as a row of the Files view under its board folder. */
export interface LocalOnlyEntry {
  readonly devicePath: string;
  readonly name: string;
  readonly kind: 'file' | 'dir';
  readonly size?: number;
}

// ------------------------------------------------------------------ cross-module contracts (implemented by src/sync, used elsewhere)

/** The argument VS Code passes to Files-view commands (context menu, click): one board file or folder. */
export interface BoardNode {
  /** Absolute device path, POSIX. */
  readonly devicePath: string;
  readonly kind: 'file' | 'dir';
  readonly name: string;
  readonly size?: number;
  /** Not on the board: a project file (or folder) the Files view shows where it will go (D-21). */
  readonly localOnly?: boolean;
}

/** What Run needs from sync (D-07): upload the library files changed since the last sync, so `import mylib` sees current code. */
export interface SyncGate {
  /** Files changed locally and not uploaded yet. Mirrored into `BoardSession.pendingSyncCount`. */
  readonly pendingCount: number;
  /**
   * Upload everything pending now, interrupting nothing (the caller has already stopped any program). Failures are reported to
   * the user by the implementation; `ok:false` means Run should not start with a stale board.
   */
  flushPending(): Promise<{ ok: boolean; uploaded: number; failed: number }>;
}

/**
 * Announces that board paths were created, rewritten, renamed or removed, so the Files view can re-list the folders that hold
 * them. ONE event per operation (an engine run, a board-file command), never while nothing changed. Listeners must not block.
 */
export interface BoardChangeSource {
  readonly onBoardChanged: (listener: (devicePaths: readonly string[]) => unknown) => { dispose(): unknown };
}

/** What the file decorations and the Files view need from sync to show badges. */
export interface SyncStatusSource {
  /** Badge for a board path, or undefined when nothing is known. */
  badgeFor(devicePath: string): SyncBadge | undefined;
  readonly onDidChange: (listener: () => unknown) => { dispose(): unknown };
  /** Everything the hover help says about a path; undefined when nothing is known. */
  detailFor?(devicePath: string): SyncStatusDetail | undefined;
  /** Project files and folders that are not on the board, directly inside the board folder `devicePath`. */
  localOnlyIn?(devicePath: string): readonly LocalOnlyEntry[];
}
