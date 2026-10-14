/**
 * Interpreter discovery (D-13, D-09). Candidates in this order, each validated by RUNNING it (probe.ts):
 *   1 the explicit setting (variables expanded; never silently skipped: if it is invalid, discovery stops and says why)
 *   2 the Python Environments extension API, 3 the Python extension API (hints, injected; they race a short timeout)
 *   4 workspace .venv / venv / env (only after Workspace Trust; bin/ and Scripts/ layouts; a venv built on another OS is
 *     reported and skipped)
 *   5 Windows `py -3` (argv ["py","-3"]), 6 python3, python on PATH, 7 known install folders,
 *   8 Thonny's bundled Python, 9 PlatformIO's.
 * Nothing depends on PATH being right or on how VS Code was started. The result carries the chosen interpreter AND every
 * rejected candidate with a reason, which the Doctor prints. Pure logic with injected fs/exec/platform: no `vscode` import.
 */
import type { Logger } from '../log';
import { settingId } from '../identity';
import { BoardError } from '../types/session';
import {
  expandGlob, expandVariables, hostPlatform, nodeFs, pathFor, samePath, whichInPath, type DiscoveryFs, type PlatformFacts,
} from './platform';
import {
  MIN_PYTHON, TESTED_FROM, isBelow, nodeExec, probeInterpreter, versionText, type ExecFn, type PythonLauncher, type RejectKind,
} from './probe';

export type CandidateSource = 'setting' | 'envs-api' | 'python-api' | 'workspace-venv' | 'py-launcher' | 'path' | 'known-dir' | 'thonny' | 'platformio';

export interface PythonCandidate {
  launcher: PythonLauncher;
  source: CandidateSource;
  /** What a student recognises: "the folder's .venv", "python3 on PATH", ... */
  label: string;
  /** The user asked for exactly this one: if it fails, discovery stops instead of trying others. */
  authoritative?: boolean;
}

export interface RejectedCandidate {
  source: CandidateSource;
  label: string;
  /** What was tried, for the Doctor: the program and its arguments. */
  command: string;
  kind: RejectKind;
  /** English, says what to do. */
  message: string;
}

export interface ValidInterpreter {
  /** What to start. For `py -3` this is the real program that `py` chose, so no launcher process sits in between. */
  launcher: PythonLauncher;
  /** `sys.executable` as the probe reported it. */
  executable: string;
  version: [number, number, number];
  versionText: string;
  implementation: string;
  source: CandidateSource;
  label: string;
  /** Works, but below the tested range 3.12 to 3.15 (D-09): the Doctor warns. */
  untested: boolean;
}

export type FailureKind = 'setting-invalid' | 'none-found' | 'too-old' | 'store-stub';

export interface ResolutionFailure {
  kind: FailureKind;
  message: string;
  hint: string;
}

export interface PythonResolution {
  chosen: ValidInterpreter | null;
  /** Other working interpreters (only filled by an exhaustive resolve, which the Doctor uses). */
  alternatives: ValidInterpreter[];
  rejected: RejectedCandidate[];
  /** Observations that are not rejections, e.g. "the Python and Python Environments extensions disagree". */
  notes: string[];
  failure: ResolutionFailure | null;
  folder: string | null;
  trusted: boolean;
  platform: NodeJS.Platform;
  exhaustive: boolean;
  resolvedAt: number;
  durationMs: number;
}

/** What the Python Environments extension or the Python extension answered. */
export interface ToolingHint {
  source: 'envs-api' | 'python-api';
  path: string;
  note?: string;
}

export interface ToolingResult {
  hints: ToolingHint[];
  notes: string[];
}

export interface DiscoveryContext {
  /** The folder whose .venv counts (first workspace folder), or null when none is open. */
  folder: string | null;
  trusted: boolean;
  /** The raw `pythonPath` setting ('' = discover). */
  pythonPathSetting: string;
}

export interface DiscoveryDeps {
  platform?: PlatformFacts;
  fs?: DiscoveryFs;
  exec?: ExecFn;
  /** Read at resolve time, so the answer always reflects the current settings and trust. */
  context(): DiscoveryContext;
  /** The two Python APIs, when installed. Failures are notes, never errors. */
  hints?(folder: string | null): Promise<ToolingResult>;
  log: Logger;
  now?: () => number;
  probeTimeoutMs?: number;
}

export interface ResolveOptions {
  /** A background caller (activation, status bar) may be served a failure up to 3 s old; a user action never is. */
  background?: boolean;
  /** Probe every candidate (the Doctor). Skips the cache. */
  exhaustive?: boolean;
  /** Skip the cache. */
  force?: boolean;
}

const VENV_NAMES = ['.venv', 'venv', 'env'] as const;
const HINTS_TIMEOUT_MS = 4000;
const NEGATIVE_TTL_MS = 3000;

function launcherText(l: PythonLauncher): string {
  return [l.command, ...l.prefixArgs].join(' ');
}

function installAdvice(os: NodeJS.Platform): string {
  if (os === 'win32') {
    return 'Install Python from https://www.python.org/downloads/ and tick "Add python.exe to PATH" in the installer, then reload the VS Code window.';
  }
  if (os === 'darwin') {
    return 'Install Python from https://www.python.org/downloads/ (the macOS installer), then reload the VS Code window.';
  }
  return 'Install Python 3.9 or newer with your package manager, then reload the VS Code window.';
}

interface Gathered {
  candidates: PythonCandidate[];
  rejected: RejectedCandidate[];
  notes: string[];
  failure: ResolutionFailure | null;
}

interface CacheEntry {
  resolution: PythonResolution;
  fingerprint: string;
  at: number;
}

/** `py -3` style value of the setting. */
const PY_LAUNCHER = /^py(?:\.exe)?\s+(-\S+(?:\s+-\S+)*)$/i;

export class PythonDiscovery {
  private readonly platform: PlatformFacts;
  private readonly fsx: DiscoveryFs;
  private readonly exec: ExecFn;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<PythonResolution>>();

  constructor(private readonly deps: DiscoveryDeps) {
    this.platform = deps.platform ?? hostPlatform();
    this.fsx = deps.fs ?? nodeFs();
    this.exec = deps.exec ?? nodeExec(deps.log, this.platform.os);
    this.now = deps.now ?? Date.now;
  }

  /** Forget the answer for one folder (or all folders): after a setting, folder, trust or extension change, or a Doctor run. */
  invalidate(folder?: string | null): void {
    if (folder === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(folder ?? '<none>');
    }
  }

  resolve(opts: ResolveOptions = {}): Promise<PythonResolution> {
    const ctx = this.deps.context();
    const key = ctx.folder ?? '<none>';
    const fingerprint = JSON.stringify([ctx.pythonPathSetting, ctx.trusted, ctx.folder, this.platform.os]);
    const flightKey = `${key}|${fingerprint}|${opts.exhaustive === true}`;
    const running = this.inflight.get(flightKey);
    if (running) {
      return running; // single flight: concurrent callers share one resolution
    }
    const work = (async (): Promise<PythonResolution> => {
      const cached = this.cache.get(key);
      if (!opts.force && !opts.exhaustive && cached && cached.fingerprint === fingerprint) {
        if (cached.resolution.chosen) {
          if (await this.fsx.exists(cached.resolution.chosen.launcher.command)) {
            return cached.resolution;
          }
          this.deps.log.info('the cached Python no longer exists; looking again');
        } else if (opts.background && this.now() - cached.at < NEGATIVE_TTL_MS) {
          return cached.resolution;
        }
      }
      const resolution = await this.run(ctx, opts.exhaustive === true);
      this.cache.set(key, { resolution, fingerprint, at: this.now() });
      return resolution;
    })();
    this.inflight.set(flightKey, work);
    const clear = (): void => { this.inflight.delete(flightKey); };
    work.then(clear, clear);
    return work;
  }

  // ------------------------------------------------------------------ one resolution

  private async run(ctx: DiscoveryContext, exhaustive: boolean): Promise<PythonResolution> {
    const started = this.now();
    const log = this.deps.log;
    const g = await this.gather(ctx);
    const rejected = [...g.rejected];
    const notes = [...g.notes];
    let failure = g.failure;
    const accepted: ValidInterpreter[] = [];
    const env = { ...this.platform.env } as NodeJS.ProcessEnv;
    delete env.__PYVENV_LAUNCHER__;

    if (!failure) {
      let cltOk: boolean | undefined;
      for (const cand of g.candidates) {
        const cmd = launcherText(cand.launcher);
        const reject = (kind: RejectKind, message: string): void => {
          rejected.push({ source: cand.source, label: cand.label, command: cmd, kind, message });
        };
        if (this.platform.os === 'darwin' && /^\/usr\/bin\/python3?$/.test(cand.launcher.command)) {
          cltOk ??= await this.hasCommandLineTools();
          if (!cltOk) {
            reject('macos-clt-shim', 'This is the macOS shortcut that asks to install developer tools, so it was not started. Install Python from python.org instead.');
            continue;
          }
        }
        const outcome = await probeInterpreter(cand.launcher, this.exec, { timeoutMs: this.deps.probeTimeoutMs, env, platform: this.platform.os });
        if (!outcome.ok) {
          reject(outcome.kind, outcome.message);
          log.info(`Python candidate rejected: ${cand.label} (${cmd}): ${outcome.kind}: ${outcome.message}`);
          if (cand.authoritative) {
            failure = {
              kind: 'setting-invalid',
              message: `The Python chosen in the setting "${settingId('pythonPath')}" cannot be used: ${outcome.message}`,
              hint: `Fix the path in the setting, or clear it so the extension finds Python by itself. ${DOCTOR_SHORT}`,
            };
            break;
          }
          continue;
        }
        const v = outcome.info;
        if (accepted.some((a) => samePath(a.executable, v.executable, this.platform))) {
          reject('duplicate', `Same program as an earlier candidate (${v.executable}).`);
          continue;
        }
        // `py -3` is only a doorway: run the program it opened, so one process fewer sits between us and the bridge
        const launcher: PythonLauncher = cand.source === 'py-launcher' ? { command: v.executable, prefixArgs: [] } : cand.launcher;
        accepted.push({
          launcher, executable: v.executable, version: v.version, versionText: versionText(v.version), implementation: v.implementation,
          source: cand.source, label: cand.label, untested: isBelow(v.version, TESTED_FROM),
        });
        if (!exhaustive) {
          break;
        }
      }
    }

    const chosen = accepted[0] ?? null;
    if (!chosen && !failure) {
      failure = this.explainNothingFound(rejected);
    }
    const resolution: PythonResolution = {
      chosen, alternatives: accepted.slice(1), rejected, notes, failure, folder: ctx.folder, trusted: ctx.trusted,
      platform: this.platform.os, exhaustive, resolvedAt: this.now(), durationMs: this.now() - started,
    };
    if (chosen) {
      log.info(`Python: using ${chosen.versionText} (${chosen.implementation}) at ${chosen.executable}, found as ${chosen.label}${chosen.untested ? ' (below the tested range 3.12+)' : ''}`);
    } else {
      log.error(`Python: none usable. ${failure?.message ?? ''}`);
    }
    for (const n of notes) {
      log.info(`Python note: ${n}`);
    }
    return resolution;
  }

  private explainNothingFound(rejected: RejectedCandidate[]): ResolutionFailure {
    const advice = installAdvice(this.platform.os);
    const old = rejected.find((r) => r.kind === 'too-old');
    if (old) {
      return {
        kind: 'too-old', message: `The Python found on this computer is too old: ${old.message}`,
        hint: `${advice} ${DOCTOR_SHORT}`,
      };
    }
    const real = rejected.filter((r) => r.kind !== 'not-found' && r.kind !== 'duplicate' && r.kind !== 'untrusted');
    if (real.length > 0 && real.every((r) => r.kind === 'store-stub')) {
      return {
        kind: 'store-stub', message: 'Windows only has the Microsoft Store shortcut for Python, which is not a real Python.',
        hint: `${advice} ${DOCTOR_SHORT}`,
      };
    }
    return {
      kind: 'none-found', message: `Python ${MIN_PYTHON.join('.')} or newer was not found on this computer.`,
      hint: `${advice} ${DOCTOR_SHORT}`,
    };
  }

  private async hasCommandLineTools(): Promise<boolean> {
    const r = await this.exec('xcode-select', ['-p'], { timeoutMs: 5000 });
    return r.code === 0 && r.stdout.trim() !== '';
  }

  // ------------------------------------------------------------------ candidates

  private async gather(ctx: DiscoveryContext): Promise<Gathered> {
    const out: Gathered = { candidates: [], rejected: [], notes: [], failure: null };
    const seen = new Set<string>();
    const add = (c: PythonCandidate): void => {
      const k = launcherText(c.launcher);
      if (!seen.has(k) || c.authoritative) {
        seen.add(k);
        out.candidates.push(c);
      }
    };

    // 1. explicit setting
    if (ctx.pythonPathSetting.trim() !== '') {
      const r = await this.fromSetting(ctx);
      if ('candidate' in r) {
        add(r.candidate);
      } else {
        out.rejected.push({ source: 'setting', label: `the setting ${settingId('pythonPath')}`, command: ctx.pythonPathSetting, kind: 'setting-invalid', message: r.reason });
        out.failure = {
          kind: 'setting-invalid',
          message: `The Python chosen in the setting "${settingId('pythonPath')}" cannot be used: ${r.reason}`,
          hint: `Fix the path in the setting, or clear it so the extension finds Python by itself. ${DOCTOR_SHORT}`,
        };
        return out;
      }
    }

    // 2 and 3. what the Python tooling extensions selected (hints)
    if (this.deps.hints) {
      try {
        const tooling = await Promise.race([
          this.deps.hints(ctx.folder),
          new Promise<ToolingResult>((resolve) => { setTimeout(() => resolve({ hints: [], notes: ['The Python extensions did not answer in time; they were skipped.'] }), HINTS_TIMEOUT_MS).unref?.(); }),
        ]);
        out.notes.push(...tooling.notes);
        const byPath = tooling.hints.filter((h) => pathFor(this.platform).isAbsolute(h.path));
        const envs = byPath.find((h) => h.source === 'envs-api');
        const py = byPath.find((h) => h.source === 'python-api');
        if (envs && py && !samePath(envs.path, py.path, this.platform)) {
          out.notes.push(`The Python Environments extension (${envs.path}) and the Python extension (${py.path}) disagree about which Python is selected. The Environments extension's choice is tried first.`);
        }
        const ordered = [...tooling.hints].sort((a, b) => Number(b.source === 'envs-api') - Number(a.source === 'envs-api'));
        for (const h of ordered) {
          if (!pathFor(this.platform).isAbsolute(h.path)) {
            out.notes.push(`${h.source === 'envs-api' ? 'The Python Environments extension' : 'The Python extension'} gave "${h.path}", which is not a full path, so it was ignored.`);
            continue;
          }
          add({ launcher: { command: h.path, prefixArgs: [] }, source: h.source, label: h.source === 'envs-api' ? 'the Python Environments extension selection' : 'the Python extension selection' });
        }
      } catch (err) {
        out.notes.push(`Asking the Python extensions failed (${err instanceof Error ? err.message : String(err)}); they were skipped.`);
        this.deps.log.warn('asking the Python extensions for the selected interpreter failed', err);
      }
    }

    // 4. workspace virtual environment (after Workspace Trust only)
    if (ctx.folder !== null) {
      await this.gatherVenvs(ctx, out, add);
    }

    // 5. Windows py launcher
    if (this.platform.os === 'win32') {
      const py = await whichInPath('py', this.platform, this.fsx);
      if (py) {
        add({ launcher: { command: py, prefixArgs: ['-3'] }, source: 'py-launcher', label: 'the Python launcher (py -3)' });
      } else {
        out.rejected.push({ source: 'py-launcher', label: 'the Python launcher (py -3)', command: 'py -3', kind: 'not-found', message: 'The Python launcher "py" is not installed.' });
      }
    }

    // 6. python3 / python on PATH (resolved by us, so macOS /usr/bin shims can be recognised before anything runs)
    for (const name of ['python3', 'python']) {
      const found = await whichInPath(name, this.platform, this.fsx);
      if (found) {
        add({ launcher: { command: found, prefixArgs: [] }, source: 'path', label: `${name} on PATH` });
      } else {
        out.rejected.push({ source: 'path', label: `${name} on PATH`, command: name, kind: 'not-found', message: `"${name}" was not found on PATH.` });
      }
    }

    // 7 to 9. well-known places (only files that exist are candidates)
    for (const c of await this.knownPlaces()) {
      add(c);
    }
    return out;
  }

  private async fromSetting(ctx: DiscoveryContext): Promise<{ candidate: PythonCandidate } | { reason: string }> {
    const p = pathFor(this.platform);
    let raw = ctx.pythonPathSetting.trim();
    if (raw.length >= 2 && (raw.startsWith('"') && raw.endsWith('"') || raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1).trim();
    }
    const label = `the setting ${settingId('pythonPath')}`;
    const launcherMatch = PY_LAUNCHER.exec(raw);
    if (launcherMatch) {
      const found = await whichInPath('py', this.platform, this.fsx);
      if (!found) {
        return { reason: 'the Python launcher "py" is not installed on this computer.' };
      }
      return { candidate: { launcher: { command: found, prefixArgs: (launcherMatch[1] ?? '').split(/\s+/) }, source: 'setting', label, authoritative: true } };
    }
    const expanded = expandVariables(raw, ctx.folder, this.platform);
    if (!expanded.ok) {
      return { reason: `${expanded.reason}.` };
    }
    let value = expanded.value;
    if (!/[\\/]/.test(value)) {
      const found = await whichInPath(value, this.platform, this.fsx);
      if (!found) {
        return { reason: `"${value}" was not found on PATH. Give the full path of the Python program instead.` };
      }
      return { candidate: { launcher: { command: found, prefixArgs: [] }, source: 'setting', label, authoritative: true } };
    }
    if (this.platform.os !== 'win32' && /^[A-Za-z]:[\\/]/.test(value)) {
      return { reason: `"${value}" is a Windows path, but this computer is not running Windows. Choose a Python installed on this computer.` };
    }
    if (this.platform.os === 'win32' && value.startsWith('/') && !value.startsWith('//')) {
      return { reason: `"${value}" looks like a macOS or Linux path, but this computer runs Windows. Choose a Python installed on this computer.` };
    }
    if (!p.isAbsolute(value)) {
      if (ctx.folder === null) {
        return { reason: `"${value}" is a relative path, but no folder is open to resolve it against.` };
      }
      value = p.resolve(ctx.folder, value);
    }
    if (!(await this.fsx.exists(value))) {
      const dangling = await this.fsx.lexists(value);
      return { reason: dangling ? `"${value}" is a broken link: the Python it points to is not installed on this computer.` : `the file "${value}" does not exist.` };
    }
    if (await this.fsx.isDir(value)) {
      return { reason: `"${value}" is a folder. Point the setting at the Python program inside it (for example ${p.join(value, this.platform.os === 'win32' ? 'Scripts\\python.exe' : 'bin/python')}).` };
    }
    return { candidate: { launcher: { command: value, prefixArgs: [] }, source: 'setting', label, authoritative: true } };
  }

  private async gatherVenvs(ctx: DiscoveryContext, out: Gathered, add: (c: PythonCandidate) => void): Promise<void> {
    const p = pathFor(this.platform);
    const folder = ctx.folder ?? '';
    const win = this.platform.os === 'win32';
    for (const name of VENV_NAMES) {
      const dir = p.join(folder, name);
      if (!(await this.fsx.exists(p.join(dir, 'pyvenv.cfg')))) {
        continue; // a plain folder called env is not a virtual environment
      }
      const label = `the "${name}" virtual environment in this folder`;
      const reject = (kind: RejectKind, message: string, command = dir): void => {
        out.rejected.push({ source: 'workspace-venv', label, command, kind, message });
      };
      if (!ctx.trusted) {
        reject('untrusted', `Skipped because this folder is not trusted yet, and a virtual environment in it would run programs from the folder. Trust the folder (VS Code "Workspace Trust") to let the extension use it.`);
        continue;
      }
      const own = win ? [p.join(dir, 'Scripts', 'python.exe')] : [p.join(dir, 'bin', 'python'), p.join(dir, 'bin', 'python3')];
      let found: string | undefined;
      for (const f of own) {
        if (await this.fsx.exists(f)) {
          found = f;
          break;
        }
      }
      if (found) {
        add({ launcher: { command: found, prefixArgs: [] }, source: 'workspace-venv', label });
        continue;
      }
      const other = win ? [p.join(dir, 'bin', 'python'), p.join(dir, 'bin', 'python3')] : [p.join(dir, 'Scripts', 'python.exe')];
      const otherExists = (await Promise.all(other.map((f) => this.fsx.lexists(f)))).some(Boolean);
      if (otherExists) {
        reject('wrong-os', `It was created on ${win ? 'macOS or Linux (it has a "bin" folder)' : 'Windows (it has a "Scripts" folder)'}, so it cannot run on this computer. The extension does not need it; you can ignore it, or delete the "${name}" folder and create a new one here.`);
        continue;
      }
      const dangling = (await Promise.all(own.map((f) => this.fsx.lexists(f)))).some(Boolean);
      reject(dangling ? 'broken-venv' : 'not-found', dangling
        ? `Its Python is a link to a program that is not installed on this computer. The extension does not need it; delete the "${name}" folder and create a new one if you use it.`
        : `It has no Python program inside (looked in ${own.join(', ')}).`);
    }
  }

  private async knownPlaces(): Promise<PythonCandidate[]> {
    const e = this.platform.env;
    const home = this.platform.homedir;
    const p = pathFor(this.platform);
    const list: PythonCandidate[] = [];
    const files = async (patterns: string[], source: CandidateSource, label: string): Promise<void> => {
      for (const pattern of patterns) {
        for (const f of /[*?]/.test(pattern) ? await expandGlob(pattern, this.platform, this.fsx) : (await this.fsx.exists(pattern) ? [pattern] : [])) {
          if (!/-config$|-intel64$/.test(f)) {
            list.push({ launcher: { command: f, prefixArgs: [] }, source, label: `${label} (${f})` });
          }
        }
      }
    };
    if (this.platform.os === 'darwin') {
      await files([
        '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
        '/Library/Frameworks/Python.framework/Versions/3*/bin/python3', '/usr/bin/python3',
      ], 'known-dir', 'a known install folder');
      await files(['/Applications/Thonny.app/Contents/Frameworks/Python.framework/Versions/*/bin/python3*'], 'thonny', "Thonny's Python");
      await files([p.join(home, '.platformio', 'penv', 'bin', 'python')], 'platformio', "PlatformIO's Python");
    } else if (this.platform.os === 'win32') {
      const local = e.LOCALAPPDATA;
      const pf = e.ProgramFiles ?? e.PROGRAMFILES;
      const profile = e.USERPROFILE ?? home;
      const w = p; // pathFor() is path.win32 here, whatever system the code runs on
      await files([
        ...(local ? [w.join(local, 'Programs', 'Python', 'Python3*', 'python.exe')] : []),
        ...(pf ? [w.join(pf, 'Python3*', 'python.exe')] : []),
        'C:\\Python3*\\python.exe',
      ], 'known-dir', 'a known install folder');
      await files([
        ...(local ? [w.join(local, 'Programs', 'Thonny', 'python.exe')] : []),
        ...(pf ? [w.join(pf, 'Thonny', 'python.exe')] : []),
      ], 'thonny', "Thonny's Python");
      await files([w.join(profile, '.platformio', 'penv', 'Scripts', 'python.exe')], 'platformio', "PlatformIO's Python");
    } else {
      await files(['/usr/bin/python3', '/usr/local/bin/python3'], 'known-dir', 'a known install folder');
      await files([p.join(home, '.platformio', 'penv', 'bin', 'python')], 'platformio', "PlatformIO's Python");
    }
    return list;
  }
}

const DOCTOR_SHORT = 'The Doctor (Command Palette: "Open Doctor") shows everything that was tried.';

/** The error the session throws when the bridge cannot start because no Python works (E_NO_PYTHON). */
export function noPythonError(resolution: PythonResolution): BoardError {
  const f = resolution.failure;
  const detail = resolution.rejected.map((r) => `${r.label} [${r.command}]: ${r.kind}: ${r.message}`).join('\n');
  return BoardError.of('E_NO_PYTHON', f?.message ?? 'No working Python was found.', { hint: f?.hint ?? installAdvice(resolution.platform), detail });
}
