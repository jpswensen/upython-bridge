/**
 * The IntelliSense fix-up: plan, preview, apply, remove (D-05, D-15, RQ-GEN-1..4; layout contract P.4 of
 * docs/analysis/07-linting-stubs.md).
 *
 *   gather   prepareFixInputs()   reads the file system / runs probes (async, no writes)
 *   plan     planFix()            PURE: inputs -> IntelliSensePlan (writes, removes, settings edits, warnings, consent, summary)
 *   apply    applyPlan()          atomic writes (temp + rename, retries), only when bytes changed
 *   undo     removeManaged()      deletes exactly what .../manifest.json says the extension created
 *
 * Layout written under the workspace folder (which must be the board-mirror root):
 *   <dot>/pyright.generated.json   environment (pythonPlatform, ignore, stubPath, extraPaths); rewritten when inputs change
 *   <dot>/stubs/active/            stock stubs (overlay + one port) = stubPath, plus the stubs made from the board (board.ts) next
 *                                  to them (a board stub never replaces a stock file)
 *   <dot>/board-lib/               read-only copies of the board's own .py/.pyi library files (in extraPaths)
 *   <dot>/manifest.json            what the extension created (for removeManaged and for staleness)
 *   pyrightconfig.json             USER-OWNED: created once, with consent, `extends` the generated file; never modified afterwards
 * Never written: a typings/ folder that exists (tier "fallback" only fills a typings/ it owns), .vscode/settings.json in the
 * default tier, pyproject.toml. Sync interplay: the dot folder, pyrightconfig.json, typings/, course-stubs/ and *.pyi are in the
 * hard-coded default ignore list of src/sync/ignore.ts (DEFAULT_IGNORE_GROUPS), so none of this reaches the board.
 */
import { IDENTITY } from '../identity';
import type {
  BoardInfo, BoardRecord, Clock, ConsentItem, FsLike, IntelliSensePlan, ManagedManifest, PathApi, PlannedRemove, PlannedWrite, PlanWarning,
  SettingsEdit, StockSelection, StubPack,
} from './types';
import { BOARD_LIB_DIR, type BoardModuleRow, type BoardStubs } from './board';
import {
  GENERATED_REL, USER_CONFIG_NAME, analyzeUserConfig, extendsSnippet, pyprojectHasPyright, renderGeneratedConfig, renderUserConfig,
} from './config';
import { SETTINGS_REL, addSettingsKeys, removeSettingsKeys } from './settingsEdit';
import { loadStubManifest, loadStubPack, selectStockStubs } from './stockStubs';
import { createIfAbsent, removeWithRetries, withRetries, writeIfChanged } from './atomicFs';
import { linkMessage, linkOnPath } from './links';
import { errCode, errMessage, isDir, isInside, readTextIfExists, readdirSafe, relPosix, sha256Hex, uniq } from './util';

const DOT = IDENTITY.dotDir;
export const TRACKER_REL = `${DOT}/manifest.json`;
const BOARD_LIB_REL = `${DOT}/${BOARD_LIB_DIR}`;
const ACTIVE_STUBS_DIR = `${DOT}/stubs/active`;
const FALLBACK_STUBS_DIR = 'typings';
const PYPROJECT = 'pyproject.toml';

// ------------------------------------------------------------------ inputs

export interface FixSettings {
  /** Tier "fallback": stock stubs in typings/ and extraPaths/ignore in the workspace settings file (add-only). Off by default. */
  fallback: boolean;
  /** Pinned in the generated file; a Windows host would otherwise flag os.uname() (P.2.4). */
  pythonPlatform: string;
  /** User-chosen extra import roots (workspace-relative or absolute). */
  extraPaths: string[];
  /** Hand-written stub or source folders such as a course pack: importable and ignored by diagnostics. */
  customStubDirs: string[];
}

export const DEFAULT_FIX_SETTINGS: FixSettings = { fallback: false, pythonPlatform: 'Linux', extraPaths: [], customStubDirs: [] };

export interface Consent {
  createUserConfig: boolean;
  editSettings: boolean;
}

/**
 * The part of the setup that comes from the board (board.ts). `fresh`: the board was just read, its stubs and copies replace
 * the earlier ones. `keep`: the board was not read this time (not connected, or nothing changed): what an earlier run made from
 * it stays exactly as it is. Absent = `keep`.
 */
export type BoardPart = { kind: 'fresh'; stubs: BoardStubs } | { kind: 'keep'; note?: string };

/** What is on disk now, as far as planning needs to know. Plain data so planFix can stay pure. */
export interface WorkspaceState {
  /** Text of the few files that matter (null = absent). Keys are workspace-relative POSIX. */
  texts: Record<string, string | null>;
  /** SHA-256 of every file below the dot folder and of every file the tracker lists. */
  hashes: Record<string, string>;
  dirs: { lib: boolean; courseStubs: boolean; typings: boolean };
  /** State files that could not be read even after retries (locked by a sync client?); planning goes on without them. */
  unreadable?: { path: string; message: string }[];
  /**
   * Links (workspace-relative POSIX) found in the managed area: the dot folder itself, anything below it, `typings`, and the
   * paths the tracker lists. The extension never reads, writes or deletes through them (see links.ts).
   */
  links?: string[];
}

export interface PlanInputs {
  /** Absolute workspace folder. */
  workspace: string;
  path: PathApi;
  state: WorkspaceState;
  stock: { selection: StockSelection; pack: StubPack } | null;
  /** Stubs made from the board; absent = keep what an earlier run made from it. */
  board?: BoardPart;
  settings: FixSettings;
  consent: Consent;
  /** Used only when the tracker is created for the first time. */
  now: number;
  /** The folder the board mirror is rooted at, when it is not the workspace folder (P.2.8 w2). */
  mirrorRoot?: string;
  /** Warnings found while gathering (for example damaged bundled stubs). */
  warnings?: PlanWarning[];
}

const STATE_TEXTS = [USER_CONFIG_NAME, PYPROJECT, SETTINGS_REL, GENERATED_REL, TRACKER_REL];

async function hashTree(fs: FsLike, workspace: string, rel: string, out: Record<string, string>, budget: { left: number }, links: string[]): Promise<void> {
  for (const e of await readdirSafe(fs, fs.path.join(workspace, ...rel.split('/')))) {
    if (budget.left-- <= 0) { return; }
    const r = `${rel}/${e.name}`;
    if (e.isSymlink === true) { links.push(r); } // never followed: neither read nor listed
    else if (e.isDirectory) { await hashTree(fs, workspace, r, out, budget, links); }
    else if (e.isFile) {
      try { out[r] = sha256Hex(await fs.readFile(fs.path.join(workspace, ...r.split('/')))); } catch { out[r] = ''; } // unreadable now: planned as "update"
    }
  }
}

const TRACKED_PREFIXES = [`${DOT}/`, `${FALLBACK_STUBS_DIR}/`];

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A path the extension itself may have created, and may therefore delete again. The tracker is a portable file that travels with
 * the folder (OneDrive, zip, git), so it is NOT trusted: only workspace-relative POSIX paths below the dot folder (or the fallback
 * tier's typings/) qualify. No `..`, no empty or dot-only segments (Windows ignores trailing dots and blanks), no backslash, drive
 * letter, colon or NUL, and never the tracker itself.
 */
export function isTrackedPath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel === '' || rel.length > 512 || rel === TRACKER_REL) { return false; }
  if (/[\\\0:]/.test(rel) || rel.startsWith('/')) { return false; }
  if (rel.split('/').some((seg) => seg.replace(/[. ]+$/, '') === '')) { return false; }
  return TRACKED_PREFIXES.some((p) => rel.startsWith(p));
}

/** `workspace/rel`, refusing anything that does not stay below the workspace (defence in depth behind isTrackedPath). */
function absInside(path: PathApi, workspace: string, rel: string): string {
  const abs = path.join(workspace, ...rel.split('/'));
  const root = path.resolve(workspace);
  const resolved = path.resolve(abs);
  if (rel.includes('\\') || resolved === root || !isInside(path, root, resolved)) { throw new Error(`Refusing to touch ${rel}: it is not inside the workspace folder.`); }
  return abs;
}

/** The tracker, or null when it is missing or ANY part of it is malformed (then nothing is removed, see W_TRACKER_INVALID). */
export function parseTracker(text: string | null): ManagedManifest | null {
  if (text === null) { return null; }
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(v) || v.schema !== 1 || !isPlainObject(v.files)) { return null; }
  const files: Record<string, string> = {};
  for (const [k, h] of Object.entries(v.files)) {
    if (!isTrackedPath(k) || typeof h !== 'string') { return null; }
    files[k] = h;
  }
  const createdOnce: Record<string, string> = {};
  if (v.createdOnce !== undefined) {
    if (!isPlainObject(v.createdOnce)) { return null; }
    for (const [k, h] of Object.entries(v.createdOnce)) {
      if (k !== USER_CONFIG_NAME || typeof h !== 'string') { return null; }
      createdOnce[k] = h;
    }
  }
  const settings: ManagedManifest['settings'] = [];
  if (v.settings !== undefined) {
    if (!Array.isArray(v.settings)) { return null; }
    for (const item of v.settings as unknown[]) {
      if (!isPlainObject(item) || item.file !== SETTINGS_REL || typeof item.key !== 'string') { return null; }
      settings.push({ file: SETTINGS_REL, key: item.key, value: item.value });
    }
  }
  const stock = isPlainObject(v.stock) && Array.isArray(v.stock.packs) && typeof v.stock.label === 'string'
    ? { packs: (v.stock.packs as unknown[]).filter((p): p is string => typeof p === 'string'), label: v.stock.label } : null;
  let board: BoardRecord | null = null;
  if (v.board !== undefined && v.board !== null) {
    const b = v.board;
    if (!isPlainObject(b) || typeof b.key !== 'string' || typeof b.label !== 'string' || typeof b.date !== 'string' || !Array.isArray(b.files) || !Array.isArray(b.modules)) { return null; }
    const bFiles = (b.files as unknown[]);
    if (!bFiles.every((f) => isTrackedPath(f) && f in files)) { return null; }
    const modules: BoardModuleRow[] = [];
    for (const m of (b.modules as unknown[]).slice(0, 400)) {
      if (!isPlainObject(m) || typeof m.name !== 'string' || typeof m.origin !== 'string' || typeof m.how !== 'string') { return null; }
      modules.push({
        name: m.name, origin: m.origin as BoardModuleRow['origin'], how: m.how as BoardModuleRow['how'],
        ...(typeof m.from === 'string' ? { from: m.from } : {}), ...(typeof m.note === 'string' ? { note: m.note } : {}),
      });
    }
    board = { key: b.key, label: b.label, date: b.date, files: bFiles as string[], modules };
  }
  return { schema: 1, files, createdOnce, settings, stock, ...(board !== null ? { board } : {}), createdAt: typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) ? v.createdAt : 0 };
}

export async function readWorkspaceState(fs: FsLike, workspace: string, clock?: Clock): Promise<WorkspaceState> {
  const path = fs.path;
  const texts: Record<string, string | null> = {};
  const unreadable: { path: string; message: string }[] = [];
  const links: string[] = [];
  const toRel = (abs: string): string => relPosix(path, workspace, abs) ?? abs;
  const underLink = (rel: string): boolean => links.some((l) => rel === l || rel.startsWith(`${l}/`));
  const hashes: Record<string, string> = {};
  const budget = { left: 5000 };
  // links first: a linked dot folder is neither listed nor read (it would show files that live outside the workspace).
  // A linked typings/ is the user's business unless the tracker lists files in it (checked below) or the fallback tier writes there (applyPlan refuses).
  const dotLink = await linkOnPath(fs, workspace, path.join(workspace, DOT), { includeLast: true });
  if (dotLink !== null) { links.push(toRel(dotLink)); }
  if (!underLink(DOT)) { await hashTree(fs, workspace, DOT, hashes, budget, links); }
  for (const rel of STATE_TEXTS) {
    if (underLink(rel)) { texts[rel] = null; continue; }
    const file = path.join(workspace, ...rel.split('/'));
    try {
      texts[rel] = clock === undefined ? await readTextIfExists(fs, file) : await withRetries(clock, {}, () => readTextIfExists(fs, file));
    } catch (err) {
      texts[rel] = null;
      unreadable.push({ path: rel, message: errMessage(err) });
    }
  }
  const tracker = parseTracker(texts[TRACKER_REL] ?? null);
  for (const rel of Object.keys(tracker?.files ?? {})) {
    if (rel in hashes || underLink(rel)) { continue; }
    const abs = absInside(path, workspace, rel);
    const link = await linkOnPath(fs, workspace, abs, { includeLast: true });
    if (link !== null) { links.push(toRel(link)); continue; }
    if ((await fs.stat(abs))?.isFile === true) { try { hashes[rel] = sha256Hex(await fs.readFile(abs)); } catch { hashes[rel] = ''; } }
  }
  for (const rel of Object.keys(hashes)) { if (underLink(rel)) { delete hashes[rel]; } }
  return {
    texts, hashes, ...(unreadable.length > 0 ? { unreadable } : {}), ...(links.length > 0 ? { links: uniq(links).sort() } : {}),
    dirs: {
      lib: await isDir(fs, path.join(workspace, 'lib')),
      courseStubs: await isDir(fs, path.join(workspace, 'course-stubs')),
      typings: await isDir(fs, path.join(workspace, FALLBACK_STUBS_DIR)),
    },
  };
}

// ------------------------------------------------------------------ the pure planner

interface Desired {
  kind: 'text' | 'copy';
  content?: string;
  from?: string;
  sha256: string;
  bytes: number;
  reason: string;
  managed: boolean;
  onlyIfAbsent?: boolean;
}

function textDesired(content: string, reason: string, extra: Partial<Desired> = {}): Desired {
  return { kind: 'text', content, sha256: sha256Hex(content), bytes: Buffer.byteLength(content), reason, managed: true, ...extra };
}

function dedupe(items: string[]): string[] {
  return uniq(items);
}

export function renderTracker(m: ManagedManifest): string {
  const sorted: ManagedManifest = {
    ...m,
    files: Object.fromEntries(Object.entries(m.files).sort(([a], [b]) => (a < b ? -1 : 1))),
    createdOnce: Object.fromEntries(Object.entries(m.createdOnce).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function planFix(input: PlanInputs): IntelliSensePlan {
  const { path, workspace, state, settings, consent } = input;
  const warnings: PlanWarning[] = [...(input.warnings ?? [])];
  const consentItems: ConsentItem[] = [];
  const desired = new Map<string, Desired>();
  const fallback = settings.fallback;
  const dotAbs = path.join(workspace, DOT);
  const boardPart: BoardPart = input.board ?? { kind: 'keep' };
  const stockPack = input.stock?.pack ?? null;
  const tracker = parseTracker(state.texts[TRACKER_REL] ?? null);
  if ((state.texts[TRACKER_REL] ?? null) !== null && tracker === null) {
    warnings.push({ code: 'W_TRACKER_INVALID', path: TRACKER_REL, message: `${TRACKER_REL} could not be read, so the extension does not know which files are its own. Nothing will be removed; the files are rewritten.` });
  }
  const trackedFiles = tracker?.files ?? {};
  for (const u of state.unreadable ?? []) {
    warnings.push({ code: 'W_STATE_UNREADABLE', path: u.path, message: `${u.path} could not be read (${u.message}). Another program may be holding it (a sync client or a virus scanner). Run the setup again in a minute; this file was treated as absent for now.` });
  }
  const userConfigUnreadable = (state.unreadable ?? []).some((u) => u.path === USER_CONFIG_NAME);
  for (const l of state.links ?? []) {
    warnings.push({ code: 'W_LINK_IN_MANAGED_AREA', path: l, message: `${l} is a link to another place. The extension never writes or deletes through a link (it could change files outside your project), so nothing is done below it. Delete the link itself (not the folder it points to) and run the setup again.` });
  }

  if (input.mirrorRoot !== undefined && path.resolve(input.mirrorRoot) !== path.resolve(workspace)) {
    warnings.push({
      code: 'W_WORKSPACE_NOT_MIRROR_ROOT',
      message: `The workspace folder is ${workspace} but the board mirror is rooted at ${input.mirrorRoot}. The language server only finds ${USER_CONFIG_NAME} in the workspace folder itself, so open the mirror root as the VS Code folder.`,
    });
  }

  // ---- stock stubs
  const stubDir = fallback ? FALLBACK_STUBS_DIR : ACTIVE_STUBS_DIR;
  // The bundled pack could not be loaded THIS time (damaged install?): the stubs an earlier setup wrote still work, so they stay.
  const keepStock = stockPack === null && tracker?.stock != null && warnings.some((w) => w.code === 'W_STOCK_UNAVAILABLE');
  const hasStock = stockPack !== null || keepStock;
  if (stockPack !== null) {
    const trackedTypings = Object.keys(trackedFiles).some((k) => k.startsWith(`${FALLBACK_STUBS_DIR}/`));
    if (fallback && state.dirs.typings && !trackedTypings) {
      warnings.push({ code: 'W_TYPINGS_EXISTS', path: FALLBACK_STUBS_DIR, message: `A ${FALLBACK_STUBS_DIR}/ folder already exists and was not created by the extension, so it is left alone and the stock stubs are not copied. Use the default layout (stubs under ${DOT}/) instead.` });
    } else {
      for (const f of stockPack.files) {
        desired.set(`${stubDir}/${f.rel}`, { kind: 'copy', from: f.abs, sha256: f.sha256, bytes: f.size, reason: `stock stubs (${stockPack.label})`, managed: true });
      }
    }
  } else if (keepStock) {
    warnings.push({ code: 'W_STOCK_KEPT', message: 'The built-in stubs could not be loaded this time, so the stubs from the earlier setup are kept as they are. Reinstall the extension if this message stays.' });
  } else {
    warnings.push({ code: 'W_NO_STOCK_STUBS', message: 'No stock stubs are selected, so modules such as machine will show as unresolved.' });
  }
  for (const n of input.stock?.selection.notes ?? []) { warnings.push({ code: 'W_STOCK_NOTE', message: n }); }

  // ---- stubs and copies made from the board
  const boardFiles: string[] = [];
  let boardRecord: BoardRecord | null = null;
  const keptBoard: Record<string, string> = {};
  if (boardPart.kind === 'fresh') {
    const b = boardPart.stubs;
    for (const [rel, text] of Object.entries(b.stubs).sort(([x], [y]) => (x < y ? -1 : 1))) {
      const target = `${stubDir}/${rel}`;
      if (desired.has(target)) {
        warnings.push({ code: 'W_BOARD_STUB_STOCK', path: target, message: `${target} comes with the stock stubs, so the stub made from the board is not used for it.` });
        continue;
      }
      desired.set(target, textDesired(text, `stub made from the board (${b.label})`));
      boardFiles.push(target);
    }
    for (const [rel, text] of Object.entries(b.lib).sort(([x], [y]) => (x < y ? -1 : 1))) {
      const target = `${BOARD_LIB_REL}/${rel}`;
      desired.set(target, textDesired(text, 'read-only copy of a library file on the board'));
      boardFiles.push(target);
    }
    warnings.push(...b.notes);
    if (boardFiles.length > 0 || b.modules.length > 0) { boardRecord = { key: b.key, label: b.label, date: b.date, files: boardFiles, modules: b.modules }; }
  } else if (tracker?.board != null) {
    // not read this time: what an earlier run made from the board stays as it is
    for (const rel of tracker.board.files) {
      if (rel in state.hashes && trackedFiles[rel] !== undefined) { keptBoard[rel] = trackedFiles[rel] as string; boardFiles.push(rel); }
    }
    boardRecord = { ...tracker.board, files: [...boardFiles] };
    if (boardPart.note !== undefined && boardFiles.length > 0) { warnings.push({ code: 'W_BOARD_KEPT', message: boardPart.note }); }
  }
  const hasBoardLib = boardFiles.some((f) => f.startsWith(`${BOARD_LIB_REL}/`));
  const hasBoardStubs = boardFiles.some((f) => f.startsWith(`${stubDir}/`));

  // ---- import roots
  const extra: string[] = [];
  const ignore: string[] = [];
  const ref = (target: string): string | null => relPosix(path, fallback ? workspace : dotAbs, target);
  const addPath = (target: string, opts: { ignore: boolean; what: string }): void => {
    const r = ref(target);
    if (r === null) {
      warnings.push({ code: 'W_PATH_UNREACHABLE', path: target, message: `${opts.what} (${target}) has no relative form from the workspace (another drive?), so it is left out; generated files only contain relative paths. Copy it into the workspace to use it.` });
      return;
    }
    extra.push(r);
    let wantIgnore = opts.ignore;
    if (wantIgnore && isInside(path, target, workspace)) {
      // a folder that is or contains the workspace in the ignore list would silence every problem in the student's own files
      wantIgnore = false;
      warnings.push({ code: 'W_ROOT_CONTAINS_WORKSPACE', path: target, message: `${opts.what} (${target}) contains your workspace folder, so it is used for imports only and is not added to the ignore list (that would hide every problem in your own files).` });
    }
    if (wantIgnore) { ignore.push(r); }
  };
  addPath(path.join(workspace, 'lib'), { ignore: false, what: 'The lib folder' }); // always: it may be created later (P.2.2 a15)
  if (state.dirs.typings && !fallback) { addPath(path.join(workspace, FALLBACK_STUBS_DIR), { ignore: false, what: 'Your typings folder' }); } // stubPath replaces pyright's default typings (P.2.3)
  if (state.dirs.courseStubs) { addPath(path.join(workspace, 'course-stubs'), { ignore: true, what: 'The course-stubs folder' }); }
  for (const d of settings.customStubDirs) { addPath(path.resolve(workspace, d), { ignore: true, what: `The stub folder ${d}` }); }
  if (hasBoardLib) { addPath(path.join(workspace, ...BOARD_LIB_REL.split('/')), { ignore: true, what: 'The copies of the board\'s library files' }); }
  for (const p of settings.extraPaths) { addPath(path.resolve(workspace, p), { ignore: false, what: `The extra path ${p}` }); }
  const hasStubDir = hasStock || hasBoardStubs;
  if (hasStubDir && !fallback) { const r = ref(path.join(workspace, ...ACTIVE_STUBS_DIR.split('/'))); if (r !== null) { ignore.unshift(r.replace(/\/active$/, '')); } }
  if (hasStubDir && fallback) { ignore.unshift(FALLBACK_STUBS_DIR); }
  const extraPaths = dedupe(extra);
  const ignorePaths = dedupe(ignore);

  // ---- user config / settings
  const settingsEdits: SettingsEdit[] = [];
  const userText = state.texts[USER_CONFIG_NAME] ?? null;
  const createdOnce: Record<string, string> = { ...(tracker?.createdOnce ?? {}) };
  let planUserConfig = false;
  if (!fallback) {
    const generatedStubPath = hasStubDir ? 'stubs/active' : undefined;
    const cfg = { pythonPlatform: settings.pythonPlatform, ignore: ignorePaths, extraPaths, ...(generatedStubPath !== undefined ? { stubPath: generatedStubPath } : {}) };
    desired.set(GENERATED_REL, textDesired(renderGeneratedConfig(cfg), 'environment for the language server (stub path, import roots, platform)'));
    const pyproject = state.texts[PYPROJECT] ?? null;
    if (userText === null && userConfigUnreadable) {
      // already warned (W_STATE_UNREADABLE): it may exist, so nothing is created
    } else if (userText === null) {
      if (pyproject !== null && pyprojectHasPyright(pyproject)) {
        warnings.push({
          code: 'W_PYPROJECT_PYRIGHT', path: PYPROJECT,
          message: `${PYPROJECT} has a [tool.pyright] section, so ${USER_CONFIG_NAME} is not created (it would silently take precedence). Add this line to that section yourself.`,
          snippet: `extends = "${GENERATED_REL}"`,
        });
      } else if (consent.createUserConfig) {
        planUserConfig = true;
        desired.set(USER_CONFIG_NAME, textDesired(renderUserConfig(), `${USER_CONFIG_NAME}: yours to edit, created once, never rewritten`, { managed: false, onlyIfAbsent: true }));
      } else {
        consentItems.push({ id: 'create-user-config', path: USER_CONFIG_NAME, message: `Create ${USER_CONFIG_NAME} (three settings: extends, typeCheckingMode, reportMissingModuleSource). It is yours afterwards and is never rewritten.` });
        warnings.push({ code: 'W_USER_CONFIG_MISSING', path: USER_CONFIG_NAME, message: `There is no ${USER_CONFIG_NAME}, so the language server does not use the generated settings yet.`, snippet: renderUserConfig() });
      }
    } else {
      const a = analyzeUserConfig(userText);
      if (!a.valid) {
        warnings.push({ code: 'W_USER_CONFIG_INVALID', path: USER_CONFIG_NAME, message: `${USER_CONFIG_NAME} is not valid JSON with comments (${a.error ?? 'error'}), so it was not touched. Fix it, then run the setup again.` });
      } else if (a.extendsOurs) {
        if (a.overridden.length > 0) {
          warnings.push({ code: 'W_USER_CONFIG_OVERRIDES', path: USER_CONFIG_NAME, message: `${USER_CONFIG_NAME} sets ${a.overridden.join(', ')} itself. A key there REPLACES the generated one, so the generated ${a.overridden.join('/')} is not used. Remove the key to use the generated value.` });
        }
      } else if (a.extendsValue !== undefined) {
        warnings.push({
          code: 'W_USER_CONFIG_OTHER_EXTENDS', path: USER_CONFIG_NAME,
          message: `${USER_CONFIG_NAME} already extends ${a.extendsValue}; a config can extend only one file, so it was not edited. Merge ${GENERATED_REL} into that file yourself, or copy the generated values.`,
          snippet: extendsSnippet(),
        });
      } else {
        warnings.push({
          code: 'W_USER_CONFIG_NO_EXTENDS', path: USER_CONFIG_NAME,
          message: `${USER_CONFIG_NAME} exists but does not extend ${GENERATED_REL}, so MicroPython modules are not resolved. It was not edited. Add this line at the top of the object${a.overridden.length > 0 ? ` and remove ${a.overridden.join(', ')} (they would replace the generated values)` : ''}.`,
          snippet: extendsSnippet(),
        });
      }
    }
  } else {
    if (userText !== null) {
      warnings.push({ code: 'W_FALLBACK_IGNORED', path: USER_CONFIG_NAME, message: `${USER_CONFIG_NAME} exists, and once a config file exists the language server ignores python.analysis settings (extraPaths, ignore, stubPath). The fallback tier has no effect here; use the default layout.` });
    }
    warnings.push({ code: 'W_PLATFORM_NOT_PINNED', message: 'The settings route cannot pin pythonPlatform to Linux, so on Windows os.uname() is reported as unknown. The default layout does not have this problem.' });
    const items = [{ key: 'python.analysis.extraPaths', value: extraPaths }, { key: 'python.analysis.ignore', value: ignorePaths }];
    const dry = addSettingsKeys(state.texts[SETTINGS_REL] ?? null, items);
    if (dry.error !== undefined) {
      warnings.push({ code: 'W_SETTINGS_INVALID', path: SETTINGS_REL, message: dry.error, snippet: items.map((i) => `"${i.key}": ${JSON.stringify(i.value)}`).join(',\n') });
    } else {
      for (const key of dry.existing) {
        const value = items.find((i) => i.key === key)?.value;
        settingsEdits.push({ file: SETTINGS_REL, key, value, action: 'exists', reason: 'already set by you, left alone' });
        warnings.push({ code: 'W_SETTING_EXISTS', path: SETTINGS_REL, message: `${key} is already set in the workspace settings, so it was not changed. Add these entries to it yourself if needed.`, snippet: `"${key}": ${JSON.stringify(value)}` });
      }
      if (dry.applied.length > 0 && !consent.editSettings) {
        consentItems.push({ id: 'edit-settings', path: SETTINGS_REL, message: `Add ${dry.applied.join(' and ')} to the workspace settings (add-only; your other settings and comments stay).` });
      } else {
        for (const key of dry.applied) {
          settingsEdits.push({ file: SETTINGS_REL, key, value: items.find((i) => i.key === key)?.value, action: 'add', reason: 'import roots for the language server' });
        }
      }
    }
  }

  // ---- diff against disk
  const writes: PlannedWrite[] = [];
  const unchanged: string[] = [];
  for (const [rel, d] of [...desired.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const current = state.hashes[rel];
    const existsNow = rel === USER_CONFIG_NAME ? userText !== null : current !== undefined;
    if (current === d.sha256) { unchanged.push(rel); continue; }
    const w: PlannedWrite = { path: rel, kind: d.kind, sha256: d.sha256, bytes: d.bytes, action: existsNow ? 'update' : 'create', reason: d.reason, managed: d.managed };
    if (d.content !== undefined) { w.content = d.content; }
    if (d.from !== undefined) { w.from = d.from; }
    if (d.onlyIfAbsent === true) { w.onlyIfAbsent = true; }
    writes.push(w);
  }
  if (planUserConfig) { createdOnce[USER_CONFIG_NAME] = (desired.get(USER_CONFIG_NAME) as Desired).sha256; }

  // ---- files the extension created earlier and no longer wants (pack switched, C module removed, tier switched)
  const removes: PlannedRemove[] = [];
  const keptFiles: Record<string, string> = {};
  for (const rel of Object.keys(trackedFiles).sort()) {
    if (desired.has(rel) || !(rel in state.hashes)) { continue; }
    const recorded = trackedFiles[rel] as string;
    // nothing is deleted without a positive reason: the board was not read this time, or the bundled pack failed to load
    if (rel in keptBoard) { keptFiles[rel] = recorded; continue; }
    if (keepStock && (rel.startsWith(`${ACTIVE_STUBS_DIR}/`) || rel.startsWith(`${FALLBACK_STUBS_DIR}/`))) { keptFiles[rel] = recorded; continue; }
    // outside the dot folder (the fallback tier's typings/) the file counts as the user's as soon as its content differs from what was recorded
    if (!rel.startsWith(`${DOT}/`) && state.hashes[rel] !== recorded) {
      warnings.push({ code: 'W_TRACKED_FILE_EDITED', path: rel, message: `${rel} was listed by an earlier setup, but its content is different now, so it is treated as yours and left alone.` });
      continue;
    }
    removes.push({ path: rel, reason: 'created by an earlier setup and no longer needed' });
  }

  // ---- what the tracker will say afterwards
  const files: Record<string, string> = {};
  for (const [rel, d] of desired) { if (d.managed) { files[rel] = d.sha256; } }
  Object.assign(files, keptFiles);
  const settingsTracked = [...(tracker?.settings ?? [])];
  for (const e of settingsEdits) {
    if (e.action === 'add' && !settingsTracked.some((s) => s.key === e.key)) { settingsTracked.push({ file: e.file, key: e.key, value: e.value }); }
  }
  const managedAfter: ManagedManifest = {
    schema: 1, files, createdOnce, settings: settingsTracked,
    stock: stockPack === null ? (keepStock ? tracker?.stock ?? null : null) : { packs: stockPack.ids, label: stockPack.label },
    ...(boardRecord !== null ? { board: boardRecord } : {}),
    createdAt: tracker?.createdAt && tracker.createdAt > 0 ? tracker.createdAt : input.now,
  };

  const fresh = boardPart.kind === 'fresh' ? boardPart.stubs : null;
  const facts = {
    stock: input.stock?.selection ?? null, extraPaths, ignore: ignorePaths,
    board: boardRecord === null ? null : {
      label: boardRecord.label, date: boardRecord.date, kept: fresh === null, modules: boardRecord.modules,
      imported: fresh?.imported ?? [], softReset: fresh?.softReset ?? false, answer: fresh?.answer ?? 'not-needed',
    },
  };
  const boardModules = (boardRecord?.modules ?? []).filter((m) => m.how === 'stub' || m.how === 'copy' || m.how === 'stub-any').length;
  return {
    workspace, writes, removes, settingsEdits, warnings, unchanged, consent: consentItems, managedAfter, facts,
    summary: summarize({ writes, removes, settingsEdits, unchanged, consent: consentItems, stock: stockPack, boardModules, fallback }),
  };
}

function summarize(p: {
  writes: PlannedWrite[]; removes: PlannedRemove[]; settingsEdits: SettingsEdit[]; unchanged: string[]; consent: ConsentItem[];
  stock: StubPack | null; boardModules: number; fallback: boolean;
}): string {
  const bits: string[] = [];
  if (p.stock !== null) { bits.push(`stock stubs ${p.stock.label}`); }
  if (p.boardModules > 0) { bits.push(`${p.boardModules} module(s) of your board`); }
  const adds = p.settingsEdits.filter((e) => e.action === 'add').length;
  const creates = p.writes.filter((w) => w.action === 'create').length;
  const updates = p.writes.length - creates;
  const what = bits.length > 0 ? ` (${bits.join(', ')})` : '';
  if (p.writes.length === 0 && p.removes.length === 0 && adds === 0) {
    return `IntelliSense is up to date: ${p.unchanged.length} file(s) already have the right content, nothing to change${what}.${p.consent.length > 0 ? ' Waiting for your consent: ' + p.consent.map((c) => c.id).join(', ') + '.' : ''}`;
  }
  const parts = [`${p.fallback ? 'Fallback tier: ' : ''}write ${p.writes.length} file(s) (${creates} new, ${updates} changed)`];
  if (p.removes.length > 0) { parts.push(`remove ${p.removes.length} file(s) that are no longer needed`); }
  if (adds > 0) { parts.push(`add ${adds} workspace setting(s)`); }
  if (p.unchanged.length > 0) { parts.push(`${p.unchanged.length} already up to date`); }
  return `${parts.join(', ')}${what}.${p.consent.length > 0 ? ' Needs your consent: ' + p.consent.map((c) => c.message).join(' ') : ''}`;
}

// ------------------------------------------------------------------ applying

export interface ApplyResult {
  written: string[];
  removed: string[];
  /** Files left as they were (for example a pyrightconfig.json that appeared since the plan). */
  skipped: { path: string; reason: string }[];
  settingsApplied: string[];
  errors: { path: string; message: string }[];
}

async function pruneEmpty(fs: FsLike, clock: Clock, workspace: string, rel: string): Promise<void> {
  let dir = fs.path.dirname(fs.path.join(workspace, ...rel.split('/')));
  const stop = fs.path.resolve(workspace);
  for (let i = 0; i < 8 && fs.path.resolve(dir) !== stop && isInside(fs.path, stop, dir); i++) {
    if ((await readdirSafe(fs, dir)).length > 0) { return; }
    await removeWithRetries(fs, clock, dir, false);
    dir = fs.path.dirname(dir);
  }
}

/** After this many files in a row that a permission error stopped, the folder is read-only for us: no point in trying the other 100. */
const PERMISSION_FAILURES_LIMIT = 3;
const isPermissionError = (err: unknown): boolean => errCode(err) === 'EACCES' || errCode(err) === 'EPERM';

/** Execute a plan. Per-file errors are collected, not thrown, so one locked file does not hide the rest. */
export async function applyPlan(plan: IntelliSensePlan, fs: FsLike, clock: Clock): Promise<ApplyResult> {
  const path = fs.path;
  const result: ApplyResult = { written: [], removed: [], skipped: [], settingsApplied: [], errors: [] };
  const abs = (rel: string): string => absInside(path, plan.workspace, rel);
  const failed = new Set<string>();
  /** Writes go to the file itself, never through a link below the workspace; a delete may remove a link but never goes through one. */
  const refuseLink = async (rel: string, includeLast: boolean): Promise<void> => {
    const link = await linkOnPath(fs, plan.workspace, abs(rel), { includeLast });
    if (link !== null) { throw new Error(linkMessage(rel, link)); }
  };
  let permissionFailures = 0;
  let stopped = false;
  for (const [index, w] of plan.writes.entries()) {
    try {
      if (w.onlyIfAbsent === true && (await fs.stat(abs(w.path))) !== null) {
        result.skipped.push({ path: w.path, reason: 'already exists; user-owned files are never replaced' });
        continue;
      }
      if (w.onlyIfAbsent === true) {
        // exclusive create: a file (or link) the user saves after the check above is never replaced
        if (await createIfAbsent(fs, clock, abs(w.path), w.content ?? '')) { result.written.push(w.path); }
        else { result.skipped.push({ path: w.path, reason: 'already exists; user-owned files are never replaced' }); }
        continue;
      }
      await refuseLink(w.path, true);
      let data: string | Uint8Array;
      if (w.kind === 'text') { data = w.content ?? ''; }
      else {
        data = await fs.readFile(w.from ?? '');
        if (sha256Hex(data) !== w.sha256) { throw new Error('the bundled stub file changed since the plan was made'); }
      }
      if ((await writeIfChanged(fs, clock, abs(w.path), data)).written) { result.written.push(w.path); }
      permissionFailures = 0;
    } catch (err) {
      failed.add(w.path);
      result.errors.push({ path: w.path, message: errMessage(err) });
      permissionFailures = isPermissionError(err) ? permissionFailures + 1 : 0;
      const rest = plan.writes.slice(index + 1);
      if (permissionFailures >= PERMISSION_FAILURES_LIMIT && rest.length > 0) {
        // each failed file already cost its retries (about half a second): stop instead of spending a minute on a folder we may not write to
        for (const r of rest) { failed.add(r.path); }
        result.errors.push({ path: (rest[0] as PlannedWrite).path, message: `Stopped: ${PERMISSION_FAILURES_LIMIT} files in a row could not be written (permission denied), so the ${rest.length} remaining file(s) were not tried. Check that the project folder is not read-only and that you may change it.` });
        stopped = true;
        break;
      }
    }
  }
  for (const r of stopped ? [] : plan.removes) {
    try {
      if (!isTrackedPath(r.path)) { throw new Error(`${r.path} is not a file the extension may remove.`); }
      await refuseLink(r.path, false);
      await removeWithRetries(fs, clock, abs(r.path), false);
      result.removed.push(r.path);
      await pruneEmpty(fs, clock, plan.workspace, r.path);
    } catch (err) {
      result.errors.push({ path: r.path, message: errMessage(err) });
    }
  }
  const adds = stopped ? [] : plan.settingsEdits.filter((e) => e.action === 'add');
  if (adds.length > 0) {
    try {
      const file = abs(SETTINGS_REL);
      const edit = addSettingsKeys(await readTextIfExists(fs, file), adds.map((e) => ({ key: e.key, value: e.value })));
      if (edit.error !== undefined) { throw new Error(edit.error); }
      await writeIfChanged(fs, clock, file, edit.text);
      result.settingsApplied.push(...edit.applied);
    } catch (err) {
      result.errors.push({ path: SETTINGS_REL, message: errMessage(err) });
    }
  }
  const after: ManagedManifest = { ...plan.managedAfter, files: { ...plan.managedAfter.files }, createdOnce: { ...plan.managedAfter.createdOnce } };
  for (const p of failed) { delete after.files[p]; }
  for (const s of result.skipped) { delete after.createdOnce[s.path]; }
  after.settings = after.settings.filter((s) => result.settingsApplied.includes(s.key) || !plan.settingsEdits.some((e) => e.key === s.key && e.action === 'add'));
  try {
    const hasAny = Object.keys(after.files).length > 0 || Object.keys(after.createdOnce).length > 0 || after.settings.length > 0;
    if (hasAny) {
      await refuseLink(TRACKER_REL, true);
      await writeIfChanged(fs, clock, abs(TRACKER_REL), renderTracker(after));
    }
  } catch (err) {
    result.errors.push({ path: TRACKER_REL, message: errMessage(err) });
  }
  return result;
}

// ------------------------------------------------------------------ removing

export interface RemoveResult {
  removed: string[];
  /** User-owned files created once that the user has edited since: left in place. */
  keptEdited: string[];
  settingsRemoved: string[];
  settingsKept: string[];
  errors: { path: string; message: string }[];
  nothingToDo: boolean;
}

/**
 * Delete exactly what the tracker lists (RQ-GEN-2 "reversible"). Anything else, including a typings/ of the user, stays.
 * Never through a link below the workspace, and a listed file outside the dot folder (typings/) only while its content is still
 * what was recorded: the tracker travels with the folder and is not trusted to name the user's files.
 */
export async function removeManaged(fs: FsLike, clock: Clock, workspace: string): Promise<RemoveResult> {
  const path = fs.path;
  const res: RemoveResult = { removed: [], keptEdited: [], settingsRemoved: [], settingsKept: [], errors: [], nothingToDo: false };
  const abs = (rel: string): string => absInside(path, workspace, rel);
  const trackerLink = await linkOnPath(fs, workspace, abs(TRACKER_REL), { includeLast: true });
  if (trackerLink !== null) { res.errors.push({ path: TRACKER_REL, message: linkMessage(TRACKER_REL, trackerLink) }); return res; }
  const tracker = parseTracker(await readTextIfExists(fs, abs(TRACKER_REL)));
  if (tracker === null) { res.nothingToDo = true; return res; }
  for (const rel of Object.keys(tracker.files).sort()) {
    try {
      const link = await linkOnPath(fs, workspace, abs(rel), { includeLast: false });
      if (link !== null) { throw new Error(linkMessage(rel, link)); }
      const st = fs.lstat !== undefined ? await fs.lstat(abs(rel)) : await fs.stat(abs(rel));
      if (st === null) { continue; }
      const isLink = 'isSymlink' in st && st.isSymlink;
      if (!rel.startsWith(`${DOT}/`) && !isLink && sha256Hex(await fs.readFile(abs(rel))) !== tracker.files[rel]) {
        res.keptEdited.push(rel);
        continue;
      }
      await removeWithRetries(fs, clock, abs(rel), false);
      res.removed.push(rel);
      await pruneEmpty(fs, clock, workspace, rel);
    } catch (err) { res.errors.push({ path: rel, message: errMessage(err) }); }
  }
  for (const [rel, sha] of Object.entries(tracker.createdOnce)) {
    try {
      const text = await readTextIfExists(fs, abs(rel));
      if (text === null) { continue; }
      if (sha256Hex(text) !== sha) { res.keptEdited.push(rel); continue; }
      await removeWithRetries(fs, clock, abs(rel), false);
      res.removed.push(rel);
    } catch (err) { res.errors.push({ path: rel, message: errMessage(err) }); }
  }
  if (tracker.settings.length > 0) {
    try {
      const text = await readTextIfExists(fs, abs(SETTINGS_REL));
      if (text !== null) {
        const out = removeSettingsKeys(text, tracker.settings.map((s) => ({ key: s.key, value: s.value })));
        res.settingsRemoved.push(...out.removed);
        res.settingsKept.push(...out.kept);
        if (out.removed.length > 0) { await writeIfChanged(fs, clock, abs(SETTINGS_REL), out.text); }
      }
    } catch (err) { res.errors.push({ path: SETTINGS_REL, message: errMessage(err) }); }
  }
  // The tracker is deleted only when everything it lists is gone or deliberately kept: after an error it stays, so Remove can be run again.
  if (res.errors.length === 0) {
    try {
      await removeWithRetries(fs, clock, abs(TRACKER_REL), false);
      res.removed.push(TRACKER_REL);
      await pruneEmpty(fs, clock, workspace, TRACKER_REL);
    } catch (err) { res.errors.push({ path: TRACKER_REL, message: errMessage(err) }); }
  }
  return res;
}

// ------------------------------------------------------------------ gathering the inputs

export interface FixRequest {
  workspace: string;
  /** Folder with MANIFEST.json and the stub packs (<extension>/resources/stubs). */
  resourcesDir: string;
  board: BoardInfo | null;
  settings?: Partial<FixSettings>;
  consent?: Partial<Consent>;
  /** "auto" picks from the board, "off" selects no stock stubs, or a port id such as "rp2". */
  stubs?: string;
  /** Port to use when no board is known. */
  defaultPort?: string;
  /** Stubs made from the board (board.ts, gathered by the caller); absent = keep what an earlier run made. */
  boardStubs?: BoardPart;
  mirrorRoot?: string;
}

export interface FixDeps { fs: FsLike; clock: Clock }

export async function prepareFixInputs(deps: FixDeps, req: FixRequest): Promise<PlanInputs> {
  const { fs } = deps;
  const settings: FixSettings = { ...DEFAULT_FIX_SETTINGS, ...(req.settings ?? {}) };
  const consent: Consent = { createUserConfig: false, editSettings: false, ...(req.consent ?? {}) };
  const state = await readWorkspaceState(fs, req.workspace, deps.clock);
  const gatherWarnings: PlanWarning[] = [];
  let stock: PlanInputs['stock'] = null;
  const stubsChoice = req.stubs ?? 'auto';
  if (stubsChoice !== 'off') {
    try {
      const manifest = await loadStubManifest(fs, req.resourcesDir);
      const selection = selectStockStubs(req.board, manifest, {
        ...(stubsChoice !== 'auto' ? { portHint: stubsChoice } : {}), ...(req.defaultPort !== undefined ? { defaultPort: req.defaultPort } : {}),
      });
      if (selection.packs.length > 0) { stock = { selection, pack: await loadStubPack(fs, req.resourcesDir, selection, manifest) }; }
    } catch (err) {
      gatherWarnings.push({ code: 'W_STOCK_UNAVAILABLE', message: `The bundled stock stubs could not be loaded: ${errMessage(err)}` });
    }
  }
  const inputs: PlanInputs = { workspace: req.workspace, path: fs.path, state, stock, settings, consent, now: deps.clock.now(), warnings: gatherWarnings };
  if (req.boardStubs !== undefined) { inputs.board = req.boardStubs; }
  if (req.mirrorRoot !== undefined) { inputs.mirrorRoot = req.mirrorRoot; }
  return inputs;
}

/** Gather, plan, and optionally apply: the one call the command and the quick fix make. */
export async function runFix(deps: FixDeps, req: FixRequest, options: { apply: boolean }): Promise<{ plan: IntelliSensePlan; result?: ApplyResult }> {
  const plan = planFix(await prepareFixInputs(deps, req));
  if (!options.apply) { return { plan }; }
  return { plan, result: await applyPlan(plan, deps.fs, deps.clock) };
}
