/**
 * Local <-> board path mapping for sync (docs/analysis/03-fs-sync.md sections 6.3, 6.8; CLAUDE.md rule 8).
 *
 * Pure module: no `vscode` import. The path flavour (`path.posix` or `path.win32`) is a parameter, so the Windows rules
 * (backslashes, drive letters, reserved names) run in tests on any host. Never claim "works on Windows" from those tests.
 *
 * Representations:
 *   rel     workspace-relative POSIX path with no leading slash, for example `lib/util.py` (what the baseline stores)
 *   device  absolute POSIX path on the board, for example `/lib/util.py` (`rootPath` + rel)
 *   local   absolute host path in the host's own spelling (backslashes on Windows)
 */
import nodePath from 'node:path';

export type PathFlavor = typeof nodePath.posix;

/** Why a name or path cannot be used on the other side. */
export type PathProblem =
  | 'empty'
  | 'absolute'
  | 'dot-segment'
  | 'traversal'
  | 'backslash'
  | 'control-char'
  | 'windows-char'
  | 'windows-reserved'
  | 'trailing-dot-or-space'
  | 'too-long';

/** Longest name most board filesystems accept (littlefs and FAT use 255). */
export const MAX_NAME_BYTES = 255;
/** Windows MAX_PATH including the terminating NUL: longer local paths fail in many tools. */
export const WINDOWS_MAX_PATH = 259;

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_ILLEGAL = /[<>:"|?*]/;

export class PathError extends Error {
  constructor(readonly problem: PathProblem, readonly subject: string, message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/** Unicode NFC, so a name typed on macOS (often NFD) matches the same name on the board. */
export function nfc(text: string): string {
  return text.normalize('NFC');
}

/** Key for "is this the same file": NFC always, lower case when the local filesystem ignores case. */
export function matchKey(rel: string, caseInsensitive: boolean): string {
  const n = nfc(rel);
  return caseInsensitive ? n.toLowerCase() : n;
}

/** Problem with one path segment (a single file or folder name), or undefined when it is usable everywhere we sync to. */
export function segmentProblem(segment: string, opts: { windows: boolean }): PathProblem | undefined {
  if (segment === '') {
    return 'empty';
  }
  if (segment === '.') {
    return 'dot-segment';
  }
  if (segment === '..') {
    return 'traversal';
  }
  if (segment.includes('\\')) {
    return 'backslash';
  }
  if (CONTROL_CHARS.test(segment)) {
    return 'control-char';
  }
  if (Buffer.byteLength(segment, 'utf8') > MAX_NAME_BYTES) {
    return 'too-long';
  }
  if (opts.windows) {
    if (WINDOWS_ILLEGAL.test(segment)) {
      return 'windows-char';
    }
    if (/[. ]$/.test(segment)) {
      return 'trailing-dot-or-space';
    }
    const stem = segment.split('.')[0] ?? segment;
    if (WINDOWS_RESERVED.test(stem.trimEnd())) {
      return 'windows-reserved';
    }
  }
  return undefined;
}

/** Problem with a workspace-relative POSIX path (every segment is checked). */
export function relPathProblem(rel: string, opts: { windows: boolean }): PathProblem | undefined {
  if (rel === '') {
    return 'empty';
  }
  if (rel.startsWith('/')) {
    return 'absolute';
  }
  for (const seg of rel.split('/')) {
    const p = segmentProblem(seg, opts);
    if (p) {
      return p;
    }
  }
  return undefined;
}

/** English sentence for a student: why `name` was not synced and what to do. */
export function describeProblem(problem: PathProblem, name: string): string {
  switch (problem) {
    case 'empty':
    case 'dot-segment':
      return `"${name}" is not a valid file name.`;
    case 'absolute':
      return `"${name}" must be a path inside the project folder.`;
    case 'traversal':
      return `"${name}" tries to leave the project folder, so it was skipped.`;
    case 'backslash':
      return `"${name}" contains a backslash, which is not allowed in file names that are shared between the board and your computer. Rename it.`;
    case 'control-char':
      return `"${name}" contains a hidden control character. Rename it.`;
    case 'windows-char':
      return `"${name}" contains a character that Windows does not allow in file names (one of < > : " | ? *). Rename it on the board.`;
    case 'windows-reserved':
      return `"${name}" is a reserved name on Windows (such as CON, NUL, COM1 or LPT1). Rename it on the board.`;
    case 'trailing-dot-or-space':
      return `"${name}" ends with a dot or a space, which Windows does not allow. Rename it on the board.`;
    case 'too-long':
      return `"${name}" is too long. Use a shorter name (255 bytes at most per name).`;
  }
}

/** Groups of paths that are the same file on a case-insensitive or NFC-normalising filesystem but differ as written. */
export function findCollisions(paths: readonly string[], opts: { caseInsensitive: boolean }): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const p of paths) {
    const key = matchKey(p, opts.caseInsensitive);
    const set = groups.get(key) ?? new Set<string>();
    set.add(p);
    groups.set(key, set);
  }
  return [...groups.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
}

/** Default for the local filesystem: macOS and Windows hosts are case-insensitive in practice. */
export function hostIsCaseInsensitive(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

// ------------------------------------------------------------------ shadow guard (module names on the board)

export interface ShadowGuard {
  /** Names of modules the board already has (frozen, built in, or in the profile). Compared case-insensitively. */
  readonly names: readonly string[];
  /** Absolute device folders that are on the import path, for example `/` and `/lib`. */
  readonly roots: readonly string[];
}

/**
 * The module name that a file or folder at `devicePath` would hide, or undefined. Mirrors the bridge's own refusal
 * (E_SHADOWS_MODULE) so the plan can explain it before anything is sent.
 */
export function shadowedModule(devicePath: string, guard: ShadowGuard): string | undefined {
  const names = new Map(guard.names.map((n) => [n.toLowerCase(), n] as const));
  if (names.size === 0) {
    return undefined;
  }
  for (const root of guard.roots) {
    const base = root === '/' ? '' : root.replace(/\/+$/, '');
    if (!devicePath.startsWith(`${base}/`)) {
      continue;
    }
    const parts = devicePath.slice(base.length + 1).split('/').filter((s) => s !== '');
    const first = parts[0];
    if (first === undefined) {
      continue;
    }
    const stem = parts.length === 1 ? first.replace(/\.(?:py|mpy)$/i, '') : first;
    const hit = names.get(stem.toLowerCase());
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/** Import roots from the board's `sys.path` (absolute entries only) plus the root and `/lib`, which MicroPython always searches. */
export function importRootsFrom(syspath: readonly string[]): string[] {
  const roots = new Set<string>(['/', '/lib']);
  for (const entry of syspath) {
    if (entry.startsWith('/')) {
      roots.add(entry.length > 1 ? entry.replace(/\/+$/, '') : entry);
    }
  }
  return [...roots];
}

// ------------------------------------------------------------------ the mapper

/**
 * Maps between the workspace folder and the board folder `rootPath`. All conversions go through these methods
 * (R-FS-25); nothing else in the code base builds device paths from local ones or the other way round.
 */
export class PathMapper {
  readonly rootPath: string;

  /**
   * @param workspaceRoot absolute host path of the workspace folder
   * @param rootPath board folder that matches the workspace folder (already normalised: leading `/`, no `..`)
   * @param flavor `path.posix` or `path.win32`; defaults to the host's
   */
  constructor(readonly workspaceRoot: string, rootPath: string, private readonly flavor: PathFlavor = nodePath) {
    const raw = rootPath.replace(/\\/g, '/');
    const clean = nodePath.posix.normalize(raw);
    if (!clean.startsWith('/') || raw.split('/').includes('..')) {
      throw new PathError('absolute', rootPath, `The board folder "${rootPath}" must start with a slash and must not contain "..".`);
    }
    this.rootPath = clean.length > 1 ? clean.replace(/\/+$/, '') : clean;
  }

  get windows(): boolean {
    return this.flavor === nodePath.win32;
  }

  /** Workspace-relative POSIX path of an absolute local path, or undefined when it is not inside the workspace folder. */
  localToRel(abs: string): string | undefined {
    const rel = this.flavor.relative(this.workspaceRoot, abs);
    if (rel === '' || this.flavor.isAbsolute(rel)) {
      return undefined;
    }
    const parts = rel.split(this.flavor.sep);
    if (parts[0] === '..') {
      return undefined;
    }
    return parts.join('/');
  }

  /** Absolute local path for a workspace-relative POSIX path. Throws PathError for traversal and unusable names. */
  relToLocal(rel: string): string {
    const problem = relPathProblem(rel, { windows: this.windows });
    if (problem) {
      throw new PathError(problem, rel, describeProblem(problem, rel));
    }
    const abs = this.flavor.join(this.workspaceRoot, ...rel.split('/'));
    if (this.localToRel(abs) !== rel) {
      throw new PathError('traversal', rel, describeProblem('traversal', rel));
    }
    return abs;
  }

  /** Device path for a workspace-relative path: `rootPath` + rel. */
  relToDevice(rel: string): string {
    const problem = relPathProblem(rel, { windows: false });
    if (problem) {
      throw new PathError(problem, rel, describeProblem(problem, rel));
    }
    return this.rootPath === '/' ? `/${rel}` : `${this.rootPath}/${rel}`;
  }

  /** Workspace-relative path of a device path, or undefined when the device path is outside `rootPath` (or is `rootPath`). */
  deviceToRel(device: string): string | undefined {
    const prefix = this.rootPath === '/' ? '/' : `${this.rootPath}/`;
    if (!device.startsWith(prefix) || device.length === prefix.length) {
      return undefined;
    }
    const rel = device.slice(prefix.length);
    return rel.split('/').some((s) => s === '' || s === '.' || s === '..') ? undefined : rel;
  }

  localToDevice(abs: string): string | undefined {
    const rel = this.localToRel(abs);
    return rel === undefined ? undefined : this.relToDevice(rel);
  }

  deviceToLocal(device: string): string | undefined {
    const rel = this.deviceToRel(device);
    return rel === undefined ? undefined : this.relToLocal(rel);
  }

  /** True when the device path is `rootPath` itself or inside it. */
  isInsideRoot(device: string): boolean {
    return device === this.rootPath || this.deviceToRel(device) !== undefined;
  }

  /** Local path too long for Windows tools (only meaningful with the win32 flavour). */
  tooLongForWindows(abs: string): boolean {
    return this.windows && abs.length > WINDOWS_MAX_PATH;
  }
}
