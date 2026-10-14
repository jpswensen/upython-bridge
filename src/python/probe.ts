/**
 * Validating a Python by RUNNING it: `python -I -c <probe>` (isolated mode, so PYTHON* variables, user site-packages and a
 * student's `json.py` next to the script cannot interfere), 5 s timeout, `windowsHide`, no shell. Empty output (the
 * Microsoft Store stub), a non-zero exit and Python < 3.9 are rejections with a reason a student can act on.
 * No `vscode` import.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../log';
import { killProcessTree } from '../bridge/process';

export const MIN_PYTHON: readonly [number, number] = [3, 9];
/** Versions below this work (3.9+) but are not the tested range (D-09). */
export const TESTED_FROM: readonly [number, number] = [3, 12];

/** The program the probe runs. Prints ONE ASCII JSON line so non-ASCII paths round-trip. */
export const PROBE_CODE =
  "import json,sys;i=getattr(sys,'implementation',None);" +
  "print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3]),'implementation':getattr(i,'name','unknown')}))";

export interface PythonLauncher {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export interface ProbeInfo {
  executable: string;
  version: [number, number, number];
  implementation: string;
}

export type RejectKind =
  | 'not-found' | 'not-executable' | 'timeout' | 'store-stub' | 'macos-clt-shim' | 'bad-output' | 'too-old' | 'failed'
  | 'wrong-os' | 'broken-venv' | 'untrusted' | 'setting-invalid' | 'duplicate';

export interface ExecOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The process could not be started at all (ENOENT, EACCES, ...). */
  error?: { code?: string; message: string };
}

export type ExecFn = (command: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;

const MAX_OUTPUT = 64 * 1024;

/** Run a short helper program: argv array, `shell:false`, `windowsHide:true`, killed (with its tree) on timeout. */
export function nodeExec(log: Logger, platform: NodeJS.Platform = process.platform): ExecFn {
  const group = platform !== 'win32'; // own process group on POSIX, so a timeout can kill the whole group
  return (command, args, opts) => new Promise<ExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (r: ExecResult): void => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: group });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: { code: e.code, message: e.message } });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, platform, group, log);
      // do not wait for the pipes to close: a grandchild may keep them open after its parent was killed
      finish({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut: true });
    }, opts.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < MAX_OUTPUT) { stdout += d.toString('utf8'); } });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT) { stderr += d.toString('utf8'); } });
    child.on('error', (e: NodeJS.ErrnoException) => finish({ code: null, signal: null, stdout, stderr, timedOut, error: { code: e.code, message: e.message } }));
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr, timedOut }));
  });
}

export type ProbeOutcome = { ok: true; info: ProbeInfo } | { ok: false; kind: RejectKind; message: string };

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
}

export function versionText(v: readonly number[]): string {
  return v.join('.');
}

export function isBelow(version: readonly number[], min: readonly [number, number]): boolean {
  const [maj = 0, mi = 0] = version;
  return maj < min[0] || (maj === min[0] && mi < min[1]);
}

/** Turn what happened into a verdict. Pure, so every platform's stub behaviour can be tested with canned results. */
export function classifyProbe(res: ExecResult, platform: NodeJS.Platform): ProbeOutcome {
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      return { ok: false, kind: 'not-found', message: 'The program does not exist.' };
    }
    if (res.error.code === 'EACCES' || res.error.code === 'EPERM') {
      return {
        ok: false, kind: 'not-executable',
        message: 'The system did not allow this program to run (permissions or a security policy). Choose another Python.',
      };
    }
    return { ok: false, kind: 'failed', message: `It could not be started: ${res.error.message}` };
  }
  if (res.timedOut) {
    return {
      ok: false, kind: 'timeout',
      message: 'It did not answer within 5 seconds (antivirus software may be scanning it). Try again in a moment.',
    };
  }
  const out = res.stdout.trim();
  const err = res.stderr;
  if (/Microsoft Store|Python was not found; run without arguments/i.test(err + out) || res.code === 9009) {
    return {
      ok: false, kind: 'store-stub',
      message: 'This is the Microsoft Store shortcut, not a real Python. Install Python from python.org and try again.',
    };
  }
  if (/xcode-select|developer tools/i.test(err)) {
    return {
      ok: false, kind: 'macos-clt-shim',
      message: 'This is the macOS shortcut that asks to install developer tools. Install Python from python.org instead.',
    };
  }
  if (res.code !== 0) {
    const why = firstLine(err) || `it exited with code ${String(res.code)}`;
    return { ok: false, kind: 'failed', message: `It could not run the check: ${why}` };
  }
  if (out === '') {
    return platform === 'win32'
      ? {
        ok: false, kind: 'store-stub',
        message: 'It printed nothing, which is how the Microsoft Store shortcut behaves when Python is not installed. Install Python from python.org.',
      }
      : { ok: false, kind: 'bad-output', message: 'It ran but printed nothing, so it is not a usable Python.' };
  }
  const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  let info: unknown;
  try {
    info = line === undefined ? undefined : JSON.parse(line);
  } catch (e) {
    return { ok: false, kind: 'bad-output', message: `Its answer could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const o = info as { executable?: unknown; version?: unknown; implementation?: unknown } | undefined;
  if (!o || typeof o.executable !== 'string' || !Array.isArray(o.version) || o.version.length < 2 || !o.version.every((n) => typeof n === 'number')) {
    return { ok: false, kind: 'bad-output', message: 'Its answer did not have the expected form, so it is not a usable Python.' };
  }
  const v = o.version as number[];
  const version: [number, number, number] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  if (isBelow(version, MIN_PYTHON)) {
    return {
      ok: false, kind: 'too-old',
      message: `It is Python ${versionText(version)}, but ${MIN_PYTHON.join('.')} or newer is needed. Install a current Python from python.org.`,
    };
  }
  return { ok: true, info: { executable: o.executable, version, implementation: typeof o.implementation === 'string' ? o.implementation : 'unknown' } };
}

export interface ProbeOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** After a timeout try once more (the first start of a fresh Python can be slow under antivirus). */
  retryOnTimeout?: boolean;
  platform: NodeJS.Platform;
}

/** `<command> <prefix args> -I -c <probe>`. */
export async function probeInterpreter(launcher: PythonLauncher, exec: ExecFn, options: ProbeOptions): Promise<ProbeOutcome> {
  const args = [...launcher.prefixArgs, '-I', '-c', PROBE_CODE];
  const run = (): Promise<ExecResult> => exec(launcher.command, args, { timeoutMs: options.timeoutMs ?? 5000, env: options.env });
  let res = await run();
  if (res.timedOut && options.retryOnTimeout !== false) {
    res = await run();
  }
  return classifyProbe(res, options.platform);
}
