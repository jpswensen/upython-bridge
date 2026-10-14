/**
 * Shared types of the IntelliSense library (D-05, D-15; layout contract: docs/analysis/07-linting-stubs.md P.4).
 * Pure: no `vscode` import. Everything that touches the outside world is injected through the small interfaces below, so
 * the unit tests need no real VS Code, no network, no Python and no real file system.
 */
import type { BoardModuleRow } from './board';

// ------------------------------------------------------------------ injected dependencies

/** The part of Node's `path` module the library uses. `path.posix` and `path.win32` both fit, so Windows is tested by injection. */
export interface PathApi {
  readonly sep: string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  dirname(p: string): string;
  basename(p: string): string;
  isAbsolute(p: string): boolean;
  normalize(p: string): string;
}

export interface DirEntry { name: string; isDirectory: boolean; isFile: boolean; isSymlink?: boolean }
export interface StatLike { isFile: boolean; isDirectory: boolean; size: number }

/**
 * Minimal async file system. Errors carry a Node-style `code` (`ENOENT`, `EBUSY`, `EPERM`, ...).
 * `stat` follows links and returns `null` when the path does not exist; `rm` ignores a missing path.
 */
export interface FsLike {
  readonly path: PathApi;
  readFile(file: string): Promise<Uint8Array>;
  writeFile(file: string, data: Uint8Array | string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string, options?: { recursive?: boolean }): Promise<void>;
  /** Recursive create. */
  mkdir(dir: string): Promise<void>;
  /** Throws `ENOENT` when `dir` is missing. */
  readdir(dir: string): Promise<DirEntry[]>;
  stat(target: string): Promise<StatLike | null>;
  /** Like `stat` but does not follow a final link: reports `isSymlink` (a dangling link is NOT null). Optional: a file system without links needs none. */
  lstat?(target: string): Promise<(StatLike & { isSymlink: boolean }) | null>;
  /** Create `file` only if nothing (not even a dangling link) is there; throws `EEXIST` otherwise. Used for files that belong to the user. */
  createExclusive?(file: string, data: Uint8Array | string): Promise<void>;
  /** Resolve links (macOS /var, OneDrive folder aliases). Optional: a file system without links needs none. */
  realpath?(target: string): Promise<string>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

// ------------------------------------------------------------------ board identity (subset of the bridge's BoardIdentity)

export interface BoardInfo {
  /** `sys.implementation.name`, normally "micropython". */
  impl: string;
  /** `sys.implementation.version[:3]`. */
  version: [number, number, number];
  /** `sys.implementation._machine`, for example "<board name> with <MCU>". */
  machine: string;
  /** `sys.implementation._build` (board name, may be empty on old firmware). */
  build: string;
  /** `sys.platform`. */
  platform: string;
  uniqueId: string;
  uname?: { sysname: string; machine: string; release?: string };
}

// ------------------------------------------------------------------ stock stubs

export interface StubPackFile { rel: string; abs: string; size: number; sha256: string }

export interface StubPack {
  /** Pack ids in layering order: the shared overlay first, then the port pack; later layers win. */
  ids: string[];
  /** Human text, for example "esp32 1.29.0.post1 (+ stdlib overlay 1.29.0.post2)". */
  label: string;
  files: StubPackFile[];
  bytes: number;
}

export interface StubManifestPack {
  id: string; kind: 'port' | 'overlay'; package: string; version: string; mpVersion: [number, number, number];
  platforms: string[]; covers: string; wheel: string; wheelSha256: string; files: number; bytes: number; contentSha256: string;
}
export interface StubManifest { schema: number; packs: StubManifestPack[]; totalBytes: number; licenceBytes?: number; overrides: string[] }

export interface StockSelection {
  /** Port pack id ("esp32", ...) or null: stdlib overlay only. */
  portId: string | null;
  /** Pack ids to layer, in order. */
  packs: string[];
  coverage: 'port' | 'stdlib-only';
  versionRelation: 'same' | 'board-newer' | 'board-older' | 'unknown';
  exact: boolean;
  reason: string;
  notes: string[];
}

// ------------------------------------------------------------------ the plan

export type PlanAction = 'create' | 'update';

export interface PlannedWrite {
  /** Workspace-relative, POSIX. */
  path: string;
  kind: 'text' | 'copy';
  /** Text content for `kind: 'text'`. */
  content?: string;
  /** Absolute source file for `kind: 'copy'`. */
  from?: string;
  sha256: string;
  bytes: number;
  action: PlanAction;
  reason: string;
  /** True for files the extension owns and tracks (removable by `removeManaged`); false for user-owned files created once. */
  managed: boolean;
  /** Created only when absent at apply time, never replaced (user-owned files). */
  onlyIfAbsent?: boolean;
}

export interface PlannedRemove { path: string; reason: string }

export interface SettingsEdit {
  /** Workspace-relative, POSIX. */
  file: string;
  key: string;
  value: unknown;
  action: 'add' | 'exists';
  reason: string;
}

export interface PlanWarning {
  code: string;
  message: string;
  /** Exact text the user can paste when we may not edit the file ourselves. */
  snippet?: string;
  path?: string;
}

export interface ConsentItem {
  id: 'create-user-config' | 'edit-settings';
  message: string;
  path: string;
  /** Whether the prompt starts with this row ticked; when absent the row starts ticked. */
  picked?: boolean;
}

/** What the tracker file in the dot folder records: exactly what the extension created (RQ-GEN-2 "reversible"). */
export interface ManagedManifest {
  schema: 1;
  /** Files owned by the extension, with the SHA-256 they were written with. */
  files: Record<string, string>;
  /** User-owned files created once, with the SHA-256 of what was written (removed on request only when still unchanged). */
  createdOnce: Record<string, string>;
  /** Settings keys added in fallback mode. */
  settings: { file: string; key: string; value: unknown }[];
  stock: { packs: string[]; label: string } | null;
  /** Stubs and copies made from the board (absent when none were made). */
  board?: BoardRecord | null;
  createdAt: number;
}

/** What the tracker remembers about the files made from the board (src/intellisense/board.ts). */
export interface BoardRecord {
  /** Firmware key: board name, MicroPython version, hash of the module listing. */
  key: string;
  label: string;
  /** Date the board was read (YYYY-MM-DD), shown in the stub headers. */
  date: string;
  /** Workspace-relative paths of the board stubs and copies (all of them are also in `files`). */
  files: string[];
  modules: BoardModuleRow[];
}

export interface PlanFacts {
  stock: StockSelection | null;
  extraPaths: string[];
  ignore: string[];
  /** What came from the board, for the preview; null when the board was not read and nothing earlier was kept. */
  board: { label: string; date: string; kept: boolean; modules: BoardModuleRow[]; imported: string[]; softReset: boolean; answer: string } | null;
}

export interface IntelliSensePlan {
  workspace: string;
  writes: PlannedWrite[];
  removes: PlannedRemove[];
  settingsEdits: SettingsEdit[];
  warnings: PlanWarning[];
  /** Paths that already have the wanted content (idempotency: a second run has `writes: []`). */
  unchanged: string[];
  /** Things that need the user's yes before the plan may be applied in full. */
  consent: ConsentItem[];
  summary: string;
  managedAfter: ManagedManifest;
  facts: PlanFacts;
}
