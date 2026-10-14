/**
 * IntelliSense for the modules a board has beyond stock MicroPython, learned from the board itself (decision of 2026-10-13:
 * the extension never looks at firmware source or build folders on the computer; students do not have them).
 *
 *   inventory   `introspect.modules` without names = help('modules') (built-in and frozen names, nothing is imported), plus
 *               `fs.list` of the board's library folders (/lib and the other absolute sys.path folders)
 *   select      (listing + board library modules) - modules the chosen stock pack covers - names the language server knows anyway
 *               - modules that must never be imported - modules the local project provides (local files always win)
 *   copy        board .py/.pyi library files: read-only copies (capped) for the generated config's extraPaths
 *   import      frozen / C / .mpy modules: only with the student's yes (asked once per firmware), then ONE soft reset
 *   stubs       one .pyi per module from what `dir()` showed: constants typed from their values, functions and methods that
 *               accept any arguments (MicroPython keeps no parameter names), classes, properties, submodules
 *
 * Pure apart from the injected `BoardAccess` and `FsLike` (the staging folder of the downloads); no `vscode` import.
 */
import { IDENTITY } from '../identity';
import type { BoardInfo, FsLike, PlanWarning, StubPack } from './types';
import { errMessage, sha256Hex } from './util';

/** Folder below the dot folder that holds the read-only copies of the board's library files (in extraPaths). */
export const BOARD_LIB_DIR = 'board-lib';

export const BOARD_LIMITS = {
  /** A board library file larger than this is not copied. */
  fileBytes: 256 * 1024,
  /** All copies together. */
  totalBytes: 2 * 1024 * 1024,
  /** Modules imported on the board (top level and submodules together). */
  modules: 40,
  /** Files looked at per library folder (packages included). */
  listedFiles: 400,
} as const;

// ------------------------------------------------------------------ what the bridge answers

export type AttrKind = 'function' | 'class' | 'module' | 'property' | 'int' | 'float' | 'str' | 'bool' | 'bytes' | 'None' | 'object';
const KINDS: ReadonlySet<string> = new Set(['function', 'class', 'module', 'property', 'int', 'float', 'str', 'bool', 'bytes', 'None', 'object']);

export interface ClassInfo { members: string[]; kinds: Record<string, AttrKind> }
export interface ModuleInfo {
  attrs: string[];
  kinds: Record<string, AttrKind>;
  consts: Record<string, unknown>;
  classes: Record<string, ClassInfo>;
  file?: string;
  error?: string;
}
export interface Introspection { listing: string[]; modules: Record<string, ModuleInfo> }

/** Board files as `fs.list` reports them. */
export interface BoardEntry { name: string; type: 'file' | 'dir'; size: number }

/** What the library needs from a connected, idle board. Everything is read-only except `introspect` WITH names and `softReset`. */
export interface BoardAccess {
  /** `introspect.modules`: without names nothing is imported; with names exactly those modules are imported. */
  introspect(names?: string[]): Promise<unknown>;
  list(path: string): Promise<BoardEntry[]>;
  /** Download `remote` to the absolute local file `local`. */
  get(remote: string, local: string): Promise<void>;
  softReset(): Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
/** A record keyed by names that come from the board: no prototype, so a name like `__proto__` is only data. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function kindMap(v: unknown): Record<string, AttrKind> {
  const out = dict<AttrKind>();
  if (!isObj(v)) { return out; }
  for (const [k, kind] of Object.entries(v).slice(0, 4000)) { if (isStr(kind) && KINDS.has(kind)) { out[k] = kind as AttrKind; } }
  return out;
}

const strList = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter(isStr).slice(0, max) : []);

/** The bridge answer, checked: data from the board is never trusted to have the documented shape. */
export function parseIntrospection(raw: unknown): Introspection {
  const obj = isObj(raw) ? raw : {};
  const modules = dict<ModuleInfo>();
  if (isObj(obj.modules)) {
    for (const [name, v] of Object.entries(obj.modules).slice(0, 400)) {
      if (!isObj(v)) { continue; }
      const classes = dict<ClassInfo>();
      if (isObj(v.classes)) {
        for (const [c, ci] of Object.entries(v.classes).slice(0, 500)) {
          if (isObj(ci)) { classes[c] = { members: strList(ci.members, 2000), kinds: kindMap(ci.kinds) }; }
        }
      }
      const consts = dict<unknown>();
      if (isObj(v.consts)) { for (const [k, c] of Object.entries(v.consts).slice(0, 4000)) { consts[k] = c; } }
      modules[name] = {
        attrs: strList(v.attrs, 4000), kinds: kindMap(v.kinds), consts, classes,
        ...(isStr(v.file) ? { file: v.file } : {}), ...(isStr(v.error) ? { error: v.error } : {}),
      };
    }
  }
  return { listing: strList(obj.listing, 4000), modules };
}

// ------------------------------------------------------------------ names

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS: ReadonlySet<string> = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield',
]);
/** Names a stub may define: identifiers that are not keywords, not dunders, and not the `Any` the stub imports. */
export const isStubName = (n: string): boolean => IDENT.test(n) && !KEYWORDS.has(n) && !n.startsWith('__') && n !== 'Any';
export const isModuleName = (n: string): boolean => n.split('.').every((p) => IDENT.test(p) && !KEYWORDS.has(p));

/**
 * Never imported, whatever the listing says: the board's own start-up files and modules whose import has effects (`_boot` mounts
 * or even formats the file system, `webrepl_setup` waits for keyboard input, `port_diag` prints a report, `this` prints a poem).
 */
export const NEVER_IMPORT: readonly string[] = ['_boot', 'boot', 'main', 'inisetup', 'flashbdev', 'webrepl_setup', '__main__', 'upip', 'upip_utarfile', 'port_diag', 'this'];

export function neverImport(name: string): boolean {
  const top = name.split('.')[0] ?? name;
  return NEVER_IMPORT.includes(top) || NEVER_IMPORT.includes(name) || top.startsWith('_boot');
}

/**
 * Modules the language server already knows without the board: CPython's standard library (pyright brings typeshed) and stock
 * MicroPython internals that no bundled pack names. Stubs made from `dir()` would only be worse than what is there.
 */
export const KNOWN_ELSEWHERE: ReadonlySet<string> = new Set([
  '__future__', 'abc', 'argparse', 'array', 'asyncio', 'base64', 'binascii', 'bisect', 'builtins', 'calendar', 'cmath', 'collections', 'contextlib',
  'copy', 'csv', 'dataclasses', 'datetime', 'enum', 'errno', 'fnmatch', 'functools', 'gc', 'glob', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http',
  'inspect', 'io', 'itertools', 'json', 'keyword', 'locale', 'logging', 'math', 'operator', 'os', 'pathlib', 'pickle', 'platform', 'pprint', 'queue',
  'random', 're', 'secrets', 'select', 'shutil', 'signal', 'socket', 'ssl', 'statistics', 'string', 'struct', 'subprocess', 'sys', 'tempfile',
  'textwrap', 'threading', 'time', 'traceback', 'types', 'typing', 'unittest', 'urllib', 'uuid', 'warnings', 'weakref', 'zlib',
  '_asyncio', '_thread', '_uasyncio', '_webrepl', '_rp2', '_onewire', '_espnow', 'micropython', 'uasyncio', 'ffi', 'jni', 'termios',
]);

/** Top-level module names a stock pack provides (its file and folder names). */
export function stockModuleNames(pack: StubPack | null): Set<string> {
  const out = new Set<string>();
  for (const f of pack?.files ?? []) {
    const first = f.rel.split('/')[0] ?? '';
    const name = first.replace(/\.pyi?$/, '');
    if (IDENT.test(name)) { out.add(name); }
  }
  return out;
}

export interface ListingTree {
  /** Top-level names. */
  tops: string[];
  /** Top-level names that are packages (the listing names a submodule or an `__init__`). */
  packages: Set<string>;
  /** Submodules the listing names, by package (dotted full names, depth 2 at most). */
  subs: Map<string, string[]>;
}

/**
 * help('modules') prints frozen modules by their file name without `.py` (`acme/__init__`, `acme/motor`) and built-in modules by
 * their name; a bridge may already have turned them into dotted names. Both forms are accepted.
 */
export function normalizeListing(listing: readonly string[]): ListingTree {
  const tops = new Set<string>();
  const packages = new Set<string>();
  const subs = new Map<string, Set<string>>();
  for (const raw of listing) {
    const parts = raw.trim().replace(/\.m?py$/, '').split(/[/.]/).filter((p) => p !== '');
    let pkg = false;
    if (parts[parts.length - 1] === '__init__') { parts.pop(); pkg = true; }
    const top = parts[0];
    if (top === undefined || !parts.every((p) => IDENT.test(p))) { continue; }
    tops.add(top);
    if (pkg || parts.length > 1) { packages.add(top); }
    if (parts.length > 1) {
      const set = subs.get(top) ?? new Set<string>();
      set.add(parts.slice(0, 2).join('.'));
      subs.set(top, set);
    }
  }
  return { tops: [...tops].sort(), packages, subs: new Map([...subs].map(([k, v]) => [k, [...v].sort()])) };
}

// ------------------------------------------------------------------ the board's library folders

export interface BoardLibFile { remote: string; rel: string; size: number }
export interface BoardLibModule {
  name: string;
  /** Board folder it was found in (`/lib`). */
  dir: string;
  /** `py`: .py/.pyi sources (copied); `mpy`: compiled only (imported, with consent). */
  kind: 'py' | 'mpy';
  isPackage: boolean;
  files: BoardLibFile[];
}

/** `/lib` plus the absolute sys.path folders, minus `/` and any folder that holds another one (the files root, which mirrors the project). */
export function libraryFolders(syspath: readonly string[]): string[] {
  const cands = [...new Set(['/lib', ...syspath.filter((p) => p.startsWith('/') && p !== '/').map((p) => p.replace(/\/+$/, ''))])];
  return cands.filter((d) => !cands.some((o) => o !== d && o.startsWith(`${d}/`)));
}

const join = (dir: string, name: string): string => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);

async function listQuiet(access: BoardAccess, dir: string, notes: PlanWarning[]): Promise<BoardEntry[] | null> {
  try {
    return await access.list(dir);
  } catch (err) {
    // a missing /lib is normal on a fresh board
    const detail = typeof err === 'object' && err !== null ? String((err as { detail?: unknown }).detail ?? '') : '';
    if (!/ENOENT|not exist|No such/i.test(`${detail} ${errMessage(err)}`)) {
      notes.push({ code: 'W_BOARD_LIST', path: dir, message: `The board folder ${dir} could not be listed (${errMessage(err)}); modules in it are not included.` });
    }
    return null;
  }
}

/** The modules in the board's library folders. The first folder (sys.path order) that has a name wins, as on the board. */
export async function scanBoardLib(access: BoardAccess, syspath: readonly string[], notes: PlanWarning[]): Promise<BoardLibModule[]> {
  const out = new Map<string, BoardLibModule>();
  for (const dir of libraryFolders(syspath)) {
    const entries = await listQuiet(access, dir, notes);
    if (entries === null) { continue; }
    let budget: number = BOARD_LIMITS.listedFiles;
    const byName = new Map<string, BoardLibModule>();
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (budget-- <= 0) { notes.push({ code: 'W_BOARD_LIB_TRUNCATED', path: dir, message: `${dir} on the board has very many files; only the first ${BOARD_LIMITS.listedFiles} were looked at.` }); break; }
      if (e.type === 'file') {
        const m = /^(.+)\.(py|pyi|mpy)$/.exec(e.name);
        if (m?.[1] === undefined || m[2] === undefined || !isModuleName(m[1]) || m[1].includes('.')) { continue; }
        const mod = byName.get(m[1]) ?? { name: m[1], dir, kind: 'mpy' as const, isPackage: false, files: [] };
        if (m[2] === 'mpy') { if (mod.files.length === 0) { mod.kind = 'mpy'; } } else {
          mod.kind = 'py';
          mod.files.push({ remote: join(dir, e.name), rel: e.name, size: e.size });
        }
        byName.set(m[1], mod);
      } else if (e.type === 'dir' && isModuleName(e.name) && !e.name.includes('.')) {
        const files: BoardLibFile[] = [];
        let mpy = false;
        const walk = async (remoteDir: string, rel: string, depth: number): Promise<void> => {
          const inner = await listQuiet(access, remoteDir, notes);
          for (const f of inner ?? []) {
            if (budget-- <= 0) { return; }
            if (f.type === 'dir' && depth < 3 && IDENT.test(f.name)) { await walk(join(remoteDir, f.name), `${rel}/${f.name}`, depth + 1); }
            else if (f.type === 'file' && /\.(py|pyi)$/.test(f.name)) { files.push({ remote: join(remoteDir, f.name), rel: `${rel}/${f.name}`, size: f.size }); }
            else if (f.type === 'file' && f.name.endsWith('.mpy')) { mpy = true; }
          }
        };
        await walk(join(dir, e.name), e.name, 1);
        if (files.length > 0) { byName.set(e.name, { name: e.name, dir, kind: 'py', isPackage: true, files }); }
        else if (mpy) { byName.set(e.name, { name: e.name, dir, kind: 'mpy', isPackage: true, files: [] }); }
      }
    }
    for (const [name, mod] of byName) { if (!out.has(name)) { out.set(name, mod); } }
  }
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ------------------------------------------------------------------ choosing what to do with each module

export type BoardModuleOrigin = 'firmware' | 'board-file' | 'board-mpy';
export type BoardModuleHow = 'stub' | 'copy' | 'stub-any' | 'local-wins' | 'never-import';

/** One row of the "what came from where" report (preview, Doctor, tracker). */
export interface BoardModuleRow {
  name: string;
  origin: BoardModuleOrigin;
  how: BoardModuleHow;
  /** Board path for copies (`/lib/helper.py`). */
  from?: string;
  note?: string;
}

export interface Selection {
  /** Firmware modules (listing) and compiled board modules that need an import to be described. */
  toImport: { name: string; origin: BoardModuleOrigin; isPackage: boolean; subs: string[] }[];
  /** Board .py/.pyi modules: copied, not imported. */
  toCopy: BoardLibModule[];
  /** Rows for modules that are left out on purpose (a local file wins, never imported). */
  leftOut: BoardModuleRow[];
}

export function selectBoardModules(input: {
  listing: ListingTree; lib: readonly BoardLibModule[]; stock: ReadonlySet<string>; local: ReadonlySet<string>;
}): Selection {
  const sel: Selection = { toImport: [], toCopy: [], leftOut: [] };
  const seen = new Set<string>();
  const covered = (n: string): boolean => input.stock.has(n) || KNOWN_ELSEWHERE.has(n);
  for (const name of input.listing.tops) {
    seen.add(name);
    if (covered(name) || name === '__main__') { continue; } // every listing has __main__: not worth a row
    if (neverImport(name)) { sel.leftOut.push({ name, origin: 'firmware', how: 'never-import' }); continue; }
    if (input.local.has(name)) { sel.leftOut.push({ name, origin: 'firmware', how: 'local-wins' }); continue; }
    sel.toImport.push({ name, origin: 'firmware', isPackage: input.listing.packages.has(name), subs: input.listing.subs.get(name) ?? [] });
  }
  for (const mod of input.lib) {
    if (seen.has(mod.name) || covered(mod.name)) { continue; } // a built-in or frozen module of that name is what the board imports
    seen.add(mod.name);
    const origin: BoardModuleOrigin = mod.kind === 'py' ? 'board-file' : 'board-mpy';
    if (input.local.has(mod.name)) { sel.leftOut.push({ name: mod.name, origin, how: 'local-wins', from: join(mod.dir, mod.name) }); continue; }
    if (neverImport(mod.name)) { sel.leftOut.push({ name: mod.name, origin, how: 'never-import', from: join(mod.dir, mod.name) }); continue; }
    if (mod.kind === 'py') { sel.toCopy.push(mod); } else { sel.toImport.push({ name: mod.name, origin, isPackage: mod.isPackage, subs: [] }); }
  }
  return sel;
}

/** The firmware a consent and a set of generated stubs belong to: board name, MicroPython version and the module listing. */
export function firmwareKey(board: BoardInfo, listing: readonly string[]): string {
  const hash = sha256Hex([...listing].sort().join('\n')).slice(0, 16);
  return `${board.build || board.machine || board.platform || 'board'}|${board.version.join('.')}|${hash}`;
}

export function firmwareLabel(board: BoardInfo): string {
  return `${board.build || board.machine || board.platform || 'board'}, MicroPython ${board.version.join('.')}`;
}

// ------------------------------------------------------------------ stub text

export interface StubContext {
  label: string;
  date: string;
  /** Full dotted names that get a stub file (for `from . import x as x`). */
  stubbed: ReadonlySet<string>;
  /** Top-level module names known anywhere (stock, standard library, listing, board): a module attribute of that name is re-exported. */
  knownTops: ReadonlySet<string>;
  /** Why the module has no member list (then every name is accepted). */
  unknownReason?: string;
}

const TYPE_OF_KIND: Partial<Record<AttrKind, string>> = { int: 'int', float: 'float', str: 'str', bool: 'bool', bytes: 'bytes', None: 'None' };
const ARGS = '*args: Any, **kwargs: Any';
const ascii = (s: string, max: number): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, max);

function valueType(kind: AttrKind | undefined, value: unknown, hasValue: boolean): string | null {
  if (kind !== undefined && TYPE_OF_KIND[kind] !== undefined) { return TYPE_OF_KIND[kind] as string; }
  if (!hasValue) { return null; }
  if (typeof value === 'boolean') { return 'bool'; }
  if (typeof value === 'number') { return Number.isInteger(value) ? 'int' : 'float'; }
  if (typeof value === 'string') { return 'str'; }
  if (value === null) { return 'None'; }
  return null;
}

function valueComment(value: unknown, hasValue: boolean): string {
  if (!hasValue || value === null || typeof value === 'object') { return ''; }
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return `  # = ${ascii(text, 60)}`;
}

function header(name: string, ctx: StubContext): string[] {
  const lines = [
    `# ${name}: made by ${IDENTITY.displayName} from the board (${ascii(ctx.label, 100)}), read on ${ctx.date}.`,
    '# MicroPython does not keep parameter names, so every function here accepts any arguments.',
    '# This file is rewritten when you run "Set Up MicroPython IntelliSense..." again; do not edit it.',
  ];
  if (ctx.unknownReason !== undefined) { lines.push(`# ${ascii(ctx.unknownReason, 200)} Every name in it is accepted.`); }
  return lines;
}

function classLines(name: string, info: ClassInfo | undefined, indent: string): string[] {
  const base = /(Error|Exception)$/.test(name) ? '(Exception)' : '';
  const out = [`${indent}class ${name}${base}:`];
  const inner = `${indent}    `;
  out.push(`${inner}def __init__(self, ${ARGS}) -> None: ...`);
  if (info === undefined) {
    out.push(`${inner}def __getattr__(self, name: str) -> Any: ...`); // nothing is known about the members
    return out;
  }
  for (const m of [...new Set(info.members)].sort()) {
    if (!isStubName(m)) { continue; }
    const kind = info.kinds[m];
    const t = valueType(kind, undefined, false);
    if (kind === 'function') { out.push(`${inner}def ${m}(self, ${ARGS}) -> Any: ...`); }
    else if (kind === 'property') { out.push(`${inner}@property`, `${inner}def ${m}(self) -> Any: ...`); }
    else if (t !== null) { out.push(`${inner}${m}: ${t}`); }
    else { out.push(`${inner}${m}: Any`); }
  }
  return out;
}

/** Text of `<module>.pyi` (or `<package>/__init__.pyi`). `info` undefined = nothing is known (introspection failed or skipped). */
export function renderModuleStub(name: string, info: ModuleInfo | undefined, ctx: StubContext): string {
  const lines = [...header(name, ctx), 'from typing import Any', ''];
  if (info === undefined || info.error !== undefined) {
    lines.push('def __getattr__(name: str) -> Any: ...', '');
    return lines.join('\n');
  }
  const imports: string[] = [];
  const body: string[] = [];
  for (const attr of [...new Set(info.attrs)].sort()) {
    if (!isStubName(attr)) { continue; }
    const kind = info.kinds[attr];
    const hasValue = Object.prototype.hasOwnProperty.call(info.consts, attr);
    const value = hasValue ? info.consts[attr] : undefined;
    const full = `${name}.${attr}`;
    if (kind === 'module') {
      if (ctx.stubbed.has(full)) { imports.push(`from . import ${attr} as ${attr}`); }
      else if (ctx.knownTops.has(attr)) { imports.push(`import ${attr} as ${attr}`); }
      else { body.push(`${attr}: Any`); }
    } else if (kind === 'function') {
      body.push(`def ${attr}(${ARGS}) -> Any: ...`);
    } else if (kind === 'class' || (kind === undefined && info.classes[attr] !== undefined)) {
      body.push('', ...classLines(attr, info.classes[attr], ''), '');
    } else {
      const t = valueType(kind, value, hasValue);
      body.push(`${attr}: ${t ?? 'Any'}${valueComment(value, hasValue)}`);
    }
  }
  if (imports.length > 0) { lines.push(...imports, ''); }
  lines.push(...body, '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ------------------------------------------------------------------ gathering

export type ImportAnswer = 'continue' | 'skip';

export interface BoardGatherOptions {
  board: BoardInfo;
  /** sys.path of the board (identity), for the library folders. */
  syspath: readonly string[];
  stock: ReadonlySet<string>;
  /** Module names the local project provides (project root, lib/, typings/): those always win. */
  local: ReadonlySet<string>;
  /**
   * Called once when modules must be imported to be described. The caller remembers the answer per firmware key (one question
   * per firmware) and may answer without asking.
   */
  askImport(request: { key: string; label: string; modules: string[] }): Promise<ImportAnswer>;
  /** Empty local folder for the downloads; removed again before this returns. */
  stagingDir: string;
  now: number;
  /** The tracker's record of an earlier run: its date is kept when the firmware did not change (no rewrite for a date). */
  previous?: { key: string; date: string } | null;
  /** When the firmware key equals this, stop after the (read-only) listing and return null: nothing changed on the board. */
  unchangedKey?: string;
}

export interface BoardStubs {
  key: string;
  label: string;
  date: string;
  /** Stub files relative to the stub folder (POSIX) -> text. */
  stubs: Record<string, string>;
  /** Copies relative to the board-lib folder -> text. */
  lib: Record<string, string>;
  modules: BoardModuleRow[];
  notes: PlanWarning[];
  /** Modules imported on the board (in the order asked). */
  imported: string[];
  /** Whether a soft reset was sent afterwards. */
  softReset: boolean;
  answer: ImportAnswer | 'not-needed';
}

const stubFileOf = (full: string, isPackage: boolean): string => `${full.split('.').join('/')}${isPackage ? '/__init__' : ''}.pyi`;
const looksLikePackage = (info: ModuleInfo | undefined): boolean => info?.file !== undefined && /__init__\.m?py$/.test(info.file);

async function download(fs: FsLike, access: BoardAccess, stagingDir: string, mods: readonly BoardLibModule[], out: BoardStubs): Promise<void> {
  let total = 0;
  let n = 0;
  for (const mod of mods) {
    let copied = 0;
    for (const f of mod.files) {
      if (f.size > BOARD_LIMITS.fileBytes) {
        out.notes.push({ code: 'W_BOARD_FILE_TOO_BIG', path: f.remote, message: `${f.remote} on the board is larger than ${BOARD_LIMITS.fileBytes / 1024} KB, so it is not copied for the editor.` });
        continue;
      }
      if (total + f.size > BOARD_LIMITS.totalBytes) {
        out.notes.push({ code: 'W_BOARD_FILES_LIMIT', path: f.remote, message: `The board's library files add up to more than ${BOARD_LIMITS.totalBytes / 1024 / 1024} MB; ${f.remote} and the rest are not copied.` });
        break;
      }
      const local = fs.path.join(stagingDir, `${n++}.download`);
      try {
        await access.get(f.remote, local);
        const bytes = await fs.readFile(local);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        out.lib[f.rel] = text;
        total += bytes.length;
        copied++;
      } catch (err) {
        out.notes.push({ code: 'W_BOARD_FILE_COPY', path: f.remote, message: `${f.remote} could not be copied from the board (${errMessage(err)}).` });
      }
    }
    if (copied > 0) { out.modules.push({ name: mod.name, origin: 'board-file', how: 'copy', from: join(mod.dir, mod.isPackage ? `${mod.name}/` : mod.files[0]?.rel ?? mod.name) }); }
  }
}

/**
 * Inventory the board, copy its library files, import the modules that need it (with consent), soft-reset once, and make the
 * stubs. Errors of single steps become notes; an error of the first, read-only inventory call is thrown (the board is not usable).
 */
export async function gatherBoardStubs(fs: FsLike, access: BoardAccess, opts: BoardGatherOptions): Promise<BoardStubs | null> {
  const first = parseIntrospection(await access.introspect());
  const key = firmwareKey(opts.board, first.listing);
  if (opts.unchangedKey !== undefined && opts.unchangedKey === key) { return null; }
  const label = firmwareLabel(opts.board);
  const date = opts.previous?.key === key ? opts.previous.date : new Date(opts.now).toISOString().slice(0, 10);
  const out: BoardStubs = { key, label, date, stubs: dict<string>(), lib: dict<string>(), modules: [], notes: [], imported: [], softReset: false, answer: 'not-needed' };
  const listing = normalizeListing(first.listing);
  const lib = await scanBoardLib(access, opts.syspath, out.notes);
  const sel = selectBoardModules({ listing, lib, stock: opts.stock, local: opts.local });

  // ---- copies of the board's .py/.pyi library files (read-only)
  if (sel.toCopy.length > 0) {
    await fs.mkdir(opts.stagingDir);
    try { await download(fs, access, opts.stagingDir, sel.toCopy, out); } finally {
      await fs.rm(opts.stagingDir, { recursive: true }).catch((err: unknown) => out.notes.push({ code: 'W_STAGING_LEFT', path: opts.stagingDir, message: `A temporary folder could not be deleted (${errMessage(err)}).` }));
    }
  }

  // ---- imports
  const wanted: string[] = [];
  for (const m of sel.toImport) { for (const n of [m.name, ...m.subs]) { if (!neverImport(n) && !wanted.includes(n)) { wanted.push(n); } } }
  const asked = wanted.slice(0, BOARD_LIMITS.modules);
  const results = dict<ModuleInfo>();
  const reasons = dict<string>();
  if (wanted.length > asked.length) {
    out.notes.push({ code: 'W_BOARD_MODULES_LIMIT', message: `The board has ${wanted.length} modules of its own; only ${BOARD_LIMITS.modules} are looked at. The others are accepted by the editor without checking their contents: ${wanted.slice(asked.length).join(', ')}.` });
    for (const n of wanted.slice(asked.length)) { reasons[n] = `${n} was not looked at (too many modules).`; }
  }
  if (asked.length > 0) {
    out.answer = await opts.askImport({ key, label, modules: sel.toImport.map((m) => m.name) });
    if (out.answer === 'skip') {
      for (const n of asked) { reasons[n] = `${n} was not imported on the board (you chose Skip), so its contents are unknown.`; }
    } else {
      try {
        out.imported.push(...asked);
        const r1 = parseIntrospection(await access.introspect(asked));
        Object.assign(results, r1.modules);
        // submodules that a package imported itself (kind "module", not a known top-level module): one more round, depth 2
        const knownTops = new Set([...listing.tops, ...opts.stock, ...KNOWN_ELSEWHERE, ...lib.map((l) => l.name)]);
        const more: string[] = [];
        for (const m of sel.toImport) {
          const info = results[m.name];
          if (info === undefined || info.error !== undefined || !(m.isPackage || looksLikePackage(info))) { continue; }
          for (const a of info.attrs) {
            const full = `${m.name}.${a}`;
            if (info.kinds[a] === 'module' && IDENT.test(a) && !knownTops.has(a) && results[full] === undefined && !asked.includes(full) && !more.includes(full) && !neverImport(full)) { more.push(full); }
          }
        }
        const room = BOARD_LIMITS.modules - asked.length;
        if (more.length > 0 && room > 0) {
          out.imported.push(...more.slice(0, room));
          const r2 = parseIntrospection(await access.introspect(more.slice(0, room)));
          for (const [n, info] of Object.entries(r2.modules)) { if (info.error === undefined) { results[n] = info; } } // a guess that failed is just "Any"
        }
      } catch (err) {
        out.notes.push({ code: 'W_BOARD_IMPORT_FAILED', message: `Reading the board's own modules failed (${errMessage(err)}). They are accepted by the editor without checking their contents. Run the setup again to retry.` });
      } finally {
        // the imports ran the modules' setup code: one soft reset leaves the board as a fresh start (the board was idle)
        try { await access.softReset(); out.softReset = true; } catch (err) {
          out.notes.push({ code: 'W_BOARD_SOFT_RESET', message: `The board could not be soft-reset after reading its modules (${errMessage(err)}). Press "Soft reset" in Board Actions before you run a program.` });
        }
      }
      for (const n of asked) {
        const e = results[n]?.error;
        if (results[n] === undefined) { reasons[n] = `${n} could not be looked at on the board.`; }
        else if (e !== undefined) { reasons[n] = `${n} could not be imported on the board (${ascii(e, 120)}).`; }
      }
    }
  }

  // ---- stub files
  const stubbedNames: string[] = [];
  const packages = new Set<string>();
  for (const m of sel.toImport) {
    stubbedNames.push(m.name);
    if (m.isPackage || looksLikePackage(results[m.name]) || m.subs.length > 0) { packages.add(m.name); }
    for (const s of m.subs) { if (!neverImport(s)) { stubbedNames.push(s); } }
  }
  for (const n of Object.keys(results)) { if (n.includes('.') && results[n]?.error === undefined && !stubbedNames.includes(n)) { stubbedNames.push(n); } }
  for (const n of stubbedNames) { const top = n.split('.')[0] as string; if (n !== top) { packages.add(top); } }
  const stubbed = new Set(stubbedNames);
  const knownTops = new Set([...listing.tops, ...opts.stock, ...KNOWN_ELSEWHERE, ...lib.map((l) => l.name)]);
  const lower = new Set<string>();
  for (const name of stubbedNames.sort()) {
    const rel = stubFileOf(name, packages.has(name));
    if (lower.has(rel.toLowerCase())) {
      out.notes.push({ code: 'W_BOARD_NAME_CASE', message: `The board has two modules whose names differ only in upper/lower case (${name}); only the first gets a stub, because Windows and macOS cannot keep both files.` });
      continue;
    }
    lower.add(rel.toLowerCase());
    const reason = reasons[name];
    const ctx: StubContext = { label, date, stubbed, knownTops, ...(reason !== undefined ? { unknownReason: reason } : {}) };
    out.stubs[rel] = renderModuleStub(name, reason !== undefined ? undefined : results[name], ctx);
  }
  for (const m of sel.toImport) {
    const reason = reasons[m.name];
    out.modules.push({ name: m.name, origin: m.origin, how: reason === undefined ? 'stub' : 'stub-any', ...(reason !== undefined ? { note: reason } : {}) });
  }
  out.modules.push(...sel.leftOut);
  out.modules.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

/** Module names the local project provides: `.py`/`.pyi` files and packages at the project root, in `lib/` and in `typings/`. */
export async function localModuleNames(fs: FsLike, workspace: string, ignoreRel: ReadonlySet<string> = new Set()): Promise<Set<string>> {
  const names = new Set<string>();
  for (const sub of ['', 'lib', 'typings']) {
    const dir = sub === '' ? workspace : fs.path.join(workspace, sub);
    let entries: Awaited<ReturnType<FsLike['readdir']>>;
    try { entries = await fs.readdir(dir); } catch { continue; } // the folder does not exist: nothing provided there
    for (const e of entries.slice(0, 2000)) {
      const rel = sub === '' ? e.name : `${sub}/${e.name}`;
      if (ignoreRel.has(rel)) { continue; }
      const m = /^(.+)\.pyi?$/.exec(e.name);
      if (e.isFile && m?.[1] !== undefined && IDENT.test(m[1])) { names.add(m[1]); }
      else if (e.isDirectory && IDENT.test(e.name)) {
        const inner = await fs.readdir(fs.path.join(dir, e.name)).catch(() => []);
        if (inner.some((x) => x.isFile && /^__init__\.pyi?$/.test(x.name) && !ignoreRel.has(`${rel}/${x.name}`))) { names.add(e.name); }
      }
    }
  }
  return names;
}
