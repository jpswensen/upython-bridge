/**
 * IntelliSense health facts for the Doctor (RQ-GEN-2, RQ-COURSE-3, RQ-COURSE-5): what the setup created and whether it is still
 * intact, whether the stub pack matches the board's MicroPython version, whether the user's pyrightconfig.json still extends the
 * generated file, and which of the student's files hide a module that the setup resolves. Pure facts (no `vscode`): the Doctor
 * turns them into text, the VS Code specific facts (installed extensions, python.analysis settings) are added by src/doctor.ts.
 */
import { parse } from 'jsonc-parser';
import { IDENTITY } from '../identity';
import { GENERATED_REL, USER_CONFIG_NAME, analyzeUserConfig, pyprojectHasPyright } from './config';
import { TRACKER_REL, parseTracker } from './fix';
import { loadStubManifest } from './stockStubs';
import type { BoardRecord, FsLike, ManagedManifest } from './types';
import { errMessage, readTextIfExists, readdirSafe, sha256Hex } from './util';

export type FileState = 'ok' | 'missing' | 'edited';

export interface IntelliSenseHealth {
  folder: string;
  /** `absent`: never set up (or removed); `invalid`: the tracker file is damaged, nothing can be removed by the extension. */
  tracker: 'absent' | 'valid' | 'invalid';
  managed: { total: number; ok: number; missing: string[]; edited: string[] };
  /** Files created once for the user (pyrightconfig.json): state compared with what was written. */
  createdOnce: { path: string; state: FileState }[];
  stock: ManagedManifest['stock'];
  /** What the setup made from the board (stubs and copies), from the tracker; null when nothing was made from it. */
  board: BoardRecord | null;
  /** Stub packs of the setup versus the board; `no-board` when none is connected, `none` when no stock stubs were installed. */
  stubVersions: { relation: 'same' | 'stubs-older' | 'stubs-newer' | 'unknown' | 'no-board' | 'none'; stubs: string; board: string | null };
  generated: { exists: boolean };
  userConfig: {
    exists: boolean; valid: boolean; error?: string; extendsValue?: string; extendsOurs: boolean;
    /** Does the file that `extends` points at exist? Null when there is no extends. */
    targetExists: boolean | null; overridden: string[];
  };
  pyprojectPyright: boolean;
  /** Student files in the project root whose names hide a module the setup resolves (module -> file). */
  shadowing: { file: string; module: string }[];
  /** Set when a part of the check itself failed (it never throws). */
  problems: string[];
}

export interface HealthOptions {
  workspace: string;
  /** `<extension>/resources/stubs`, to compare pack versions with the board. May be missing in tests. */
  resourcesDir?: string;
  /** MicroPython version of the connected board, when known. */
  boardVersion?: readonly number[] | null;
}

function cmp(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d !== 0) { return d; } }
  return 0;
}

async function stateOf(fs: FsLike, workspace: string, rel: string, expected: string): Promise<FileState> {
  const text = await fs.stat(fs.path.join(workspace, ...rel.split('/')));
  if (text === null) { return 'missing'; }
  try {
    return sha256Hex(await fs.readFile(fs.path.join(workspace, ...rel.split('/')))) === expected ? 'ok' : 'edited';
  } catch {
    return 'edited'; // unreadable now: reported as changed rather than hiding the file
  }
}

/** Module names the setup makes importable: top level of the stub folder (stock and board stubs) and of the generated import roots. */
async function resolvedModuleNames(fs: FsLike, workspace: string, generatedText: string | null, problems: string[]): Promise<Set<string>> {
  const names = new Set<string>();
  const addDir = async (dir: string): Promise<void> => {
    for (const e of (await readdirSafe(fs, dir)).slice(0, 400)) {
      const m = /^(.+)\.(pyi?|mpy)$/i.exec(e.name);
      if (e.isDirectory && /^[A-Za-z_]\w*$/.test(e.name) && e.name !== '__pycache__') { names.add(e.name.toLowerCase()); }
      else if (e.isFile && m?.[1] !== undefined && /^[A-Za-z_]\w*$/.test(m[1])) { names.add(m[1].toLowerCase()); }
    }
  };
  await addDir(fs.path.join(workspace, IDENTITY.dotDir, 'stubs', 'active'));
  if (generatedText !== null) {
    const cfg = parse(generatedText, [], { allowTrailingComma: true }) as { extraPaths?: unknown } | undefined;
    const dotDir = fs.path.join(workspace, IDENTITY.dotDir);
    const roots = Array.isArray(cfg?.extraPaths) ? (cfg?.extraPaths as unknown[]).filter((p): p is string => typeof p === 'string') : [];
    for (const rel of roots.slice(0, 20)) {
      const abs = fs.path.resolve(dotDir, ...rel.split('/'));
      // the workspace itself and its own lib/ folder are the student's code, never "provided by the setup"
      if (abs === fs.path.resolve(workspace) || abs === fs.path.resolve(workspace, 'lib')) { continue; }
      try { await addDir(abs); } catch (err) { problems.push(`${rel}: ${errMessage(err)}`); }
    }
  }
  return names;
}

export async function gatherIntelliSenseHealth(fs: FsLike, options: HealthOptions): Promise<IntelliSenseHealth> {
  const { workspace } = options;
  const problems: string[] = [];
  const abs = (rel: string): string => fs.path.join(workspace, ...rel.split('/'));
  const trackerText = await readTextIfExists(fs, abs(TRACKER_REL)).catch((err: unknown) => { problems.push(`${TRACKER_REL}: ${errMessage(err)}`); return null; });
  const tracker = parseTracker(trackerText);
  const health: IntelliSenseHealth = {
    folder: workspace,
    tracker: trackerText === null ? 'absent' : tracker === null ? 'invalid' : 'valid',
    managed: { total: 0, ok: 0, missing: [], edited: [] },
    createdOnce: [],
    stock: tracker?.stock ?? null,
    board: tracker?.board ?? null,
    stubVersions: { relation: 'none', stubs: '', board: options.boardVersion ? options.boardVersion.join('.') : null },
    generated: { exists: (await fs.stat(abs(GENERATED_REL)))?.isFile === true },
    userConfig: { exists: false, valid: true, extendsOurs: false, targetExists: null, overridden: [] },
    pyprojectPyright: false,
    shadowing: [],
    problems,
  };
  if (tracker !== null) {
    for (const [rel, sha] of Object.entries(tracker.files)) {
      health.managed.total++;
      const state = await stateOf(fs, workspace, rel, sha).catch((err: unknown) => { problems.push(`${rel}: ${errMessage(err)}`); return 'ok' as FileState; });
      if (state === 'ok') { health.managed.ok++; } else if (state === 'missing') { health.managed.missing.push(rel); } else { health.managed.edited.push(rel); }
    }
    for (const [rel, sha] of Object.entries(tracker.createdOnce)) {
      health.createdOnce.push({ path: rel, state: await stateOf(fs, workspace, rel, sha).catch(() => 'edited' as FileState) });
    }
  }
  // stub pack versus the board
  if (tracker?.stock !== null && tracker?.stock !== undefined) {
    health.stubVersions.stubs = tracker.stock.label;
    if (options.resourcesDir !== undefined && options.boardVersion && options.boardVersion.some((n) => n > 0)) {
      try {
        const manifest = await loadStubManifest(fs, options.resourcesDir);
        const port = manifest.packs.filter((p) => p.kind === 'port' && tracker.stock?.packs.includes(p.id));
        const mp = port[0]?.mpVersion;
        health.stubVersions.relation = mp === undefined ? 'unknown' : cmp(mp, options.boardVersion) === 0 ? 'same' : cmp(mp, options.boardVersion) < 0 ? 'stubs-older' : 'stubs-newer';
        if (mp !== undefined) { health.stubVersions.stubs = `${tracker.stock.label}, describes MicroPython ${mp.join('.')}`; }
      } catch (err) {
        problems.push(`stub manifest: ${errMessage(err)}`);
        health.stubVersions.relation = 'unknown';
      }
    } else {
      health.stubVersions.relation = options.boardVersion ? 'unknown' : 'no-board';
    }
  }
  // the user's config file
  const userText = await readTextIfExists(fs, abs(USER_CONFIG_NAME)).catch((err: unknown) => { problems.push(`${USER_CONFIG_NAME}: ${errMessage(err)}`); return null; });
  if (userText !== null) {
    const a = analyzeUserConfig(userText);
    health.userConfig = { exists: true, valid: a.valid, extendsOurs: a.extendsOurs, targetExists: null, overridden: a.overridden };
    if (a.error !== undefined) { health.userConfig.error = a.error; }
    if (a.extendsValue !== undefined) {
      health.userConfig.extendsValue = a.extendsValue;
      // pyright resolves `extends` relative to the config file; an absolute path is used as it is
      const target = fs.path.isAbsolute(a.extendsValue) ? a.extendsValue : fs.path.resolve(workspace, ...a.extendsValue.replace(/\\/g, '/').split('/'));
      health.userConfig.targetExists = (await fs.stat(target))?.isFile === true;
    }
  }
  const pyproject = await readTextIfExists(fs, abs('pyproject.toml')).catch(() => null);
  health.pyprojectPyright = pyproject !== null && pyprojectHasPyright(pyproject);
  // student files that hide a module the setup resolves
  if (health.tracker === 'valid') {
    const generatedText = await readTextIfExists(fs, abs(GENERATED_REL)).catch(() => null);
    const names = await resolvedModuleNames(fs, workspace, generatedText, problems);
    for (const e of await readdirSafe(fs, workspace)) {
      const m = /^(.+)\.(py|mpy)$/i.exec(e.name);
      if (e.isFile && m?.[1] !== undefined && names.has(m[1].toLowerCase())) { health.shadowing.push({ file: e.name, module: m[1] }); }
    }
    health.shadowing.sort((a, b) => a.file.localeCompare(b.file));
  }
  return health;
}
