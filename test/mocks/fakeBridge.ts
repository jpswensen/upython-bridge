/**
 * Helpers to run the REAL Python bridge against a REAL fake board (tools/fakeboard.py, TCP, never a serial port) from Node tests.
 * Mirrors how tests/bridge_client.py starts them, with argv arrays only (`shell:false`, `windowsHide:true`):
 *   fake board : python -B tools/fakeboard.py --profile P --print-url --exit-on-stdin-eof --max-seconds N   (prints socket://127.0.0.1:PORT)
 *   bridge     : python -I -B -u -X utf8 -X pycache_prefix=<tmp> bridge/mpy_bridge.py                      (cwd = a neutral temp folder)
 * Safety: MPY_SAFE_MODE=1 is forced and MPY_REAL_PORT removed in every child; the bridge refuses anything but loopback URLs then.
 * Cleanup: every process is bounded (--max-seconds, stdin EOF = quit) and tracked; call `stopAll()` in afterEach/after, and a
 * process-exit hook kills stragglers if a test run dies.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BridgeErrorBody, OpArgs, OpName, OpResult, WireEvent } from '../../src/types/protocol';
import { makeTempDir, projectRoot, removeDir } from './fixtures';

const live = new Set<ChildProcess>();

process.once('exit', () => {
  for (const child of live) {
    try {
      child.kill('SIGKILL');
    } catch (err) {
      process.stderr.write(`fakeBridge: could not kill pid ${child.pid}: ${String(err)}\n`);
    }
  }
});

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MPY_SAFE_MODE: '1', PYTHONDONTWRITEBYTECODE: '1', ...extra };
  delete env.MPY_REAL_PORT;
  return env;
}

let pythonCache: string | undefined | null = null;

/** A Python >= 3.9: `UPYBRIDGE_TEST_PYTHON`, else python3.13, python3, python (Windows: python). undefined when none works. */
export function testPython(): string | undefined {
  if (pythonCache !== null) { return pythonCache; }
  const candidates = [process.env.UPYBRIDGE_TEST_PYTHON, ...(process.platform === 'win32' ? ['python'] : ['python3.13', 'python3', 'python'])];
  pythonCache = undefined;
  for (const c of candidates) {
    if (!c) { continue; }
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0] * 100 + sys.version_info[1])'], { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
    if (r.status === 0 && Number(r.stdout.trim()) >= 309) { pythonCache = c; break; }
  }
  return pythonCache;
}

/** Why integration tests cannot run here, or false. Use as `test('...', { skip: integrationSkipReason() }, ...)`. */
export function integrationSkipReason(): string | false {
  if (!testPython()) { return 'no Python >= 3.9 found (set UPYBRIDGE_TEST_PYTHON)'; }
  if (!fs.existsSync(path.join(projectRoot(), 'bridge', 'mpy_bridge.py'))) { return 'bridge/mpy_bridge.py is missing'; }
  if (!fs.existsSync(path.join(projectRoot(), 'tools', 'fakeboard.py'))) { return 'tools/fakeboard.py is missing'; }
  return false;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) { return; }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
  } else {
    child.kill('SIGKILL');
  }
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) { return Promise.resolve(true); }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, ms);
    const onExit = (): void => { clearTimeout(timer); resolve(true); };
    child.once('exit', onExit);
  });
}

/** Politely (stdin EOF), then SIGTERM, then kill the tree. Always resolves. */
async function shutDown(child: ChildProcess): Promise<void> {
  try {
    child.stdin?.end();
  } catch (err) {
    process.stderr.write(`fakeBridge: stdin close failed: ${String(err)}\n`);
  }
  if (!(await waitExit(child, 4000))) {
    child.kill('SIGTERM');
    if (!(await waitExit(child, 2000))) {
      killTree(child);
      await waitExit(child, 2000);
    }
  }
  live.delete(child);
}

// ------------------------------------------------------------------ fake board

export interface FakeBoardOptions {
  /** One of tools/fakeboard.py --list-profiles (default esp32). */
  profile?: string;
  /** Fault specs, for example `delay_boot:2`, `main_forever`. */
  faults?: string[];
  /** Host folder acting as the board filesystem (default: the board makes and removes its own). */
  root?: string;
  /** Also write the profile's seed files into `root`. */
  seed?: boolean;
  /** Hard stop for the board process (default 120 s). */
  maxSeconds?: number;
}

export interface FakeBoardHandle {
  /** `socket://127.0.0.1:PORT`: pass it to `connect` as the port. */
  readonly url: string;
  readonly profile: string;
  readonly pid: number;
  stderr(): string;
  stop(): Promise<void>;
}

export async function startFakeBoard(options: FakeBoardOptions = {}): Promise<FakeBoardHandle> {
  const python = testPython();
  if (!python) { throw new Error('No Python >= 3.9 available for the fake board (set UPYBRIDGE_TEST_PYTHON).'); }
  const profile = options.profile ?? 'esp32';
  const argv = ['-B', path.join(projectRoot(), 'tools', 'fakeboard.py'), '--profile', profile, '--print-url', '--exit-on-stdin-eof', '--max-seconds', String(options.maxSeconds ?? 120)];
  if (options.root) { argv.push('--root', options.root); }
  if (options.seed) { argv.push('--seed'); }
  for (const f of options.faults ?? []) { argv.push('--fault', f); }
  const child = spawn(python, argv, { cwd: projectRoot(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  live.add(child);
  let errText = '';
  child.stderr?.on('data', (d: Buffer) => { errText += d.toString('utf8'); });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`Fake board did not print its URL within 15 s. stderr: ${errText}`)), 15000);
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) { clearTimeout(timer); resolve(buf.slice(0, nl).trim()); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Fake board exited early (code ${String(code)}). stderr: ${errText}`)); });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
  }).catch(async (err: unknown) => { await shutDown(child); throw err; });
  if (!url.startsWith('socket://127.0.0.1:')) {
    await shutDown(child);
    throw new Error(`Unexpected fake board URL: ${url}`);
  }
  return { url, profile, pid: child.pid ?? -1, stderr: () => errText, stop: () => shutDown(child) };
}

// ------------------------------------------------------------------ bridge

export class RawBridgeError extends Error {
  constructor(readonly op: string, readonly error: BridgeErrorBody) {
    super(`${op} failed: ${error.code}: ${error.message}`);
    this.name = 'RawBridgeError';
  }

  get code(): string { return this.error.code; }
}

export interface BridgeSpawnSpec { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }

/** How tests start the bridge (the client under test should build the same argv itself in production code). */
export function bridgeSpawnSpec(cwd: string, pycachePrefix: string): BridgeSpawnSpec {
  const python = testPython();
  if (!python) { throw new Error('No Python >= 3.9 available for the bridge (set UPYBRIDGE_TEST_PYTHON).'); }
  return {
    command: python,
    args: ['-I', '-B', '-u', '-X', 'utf8', '-X', `pycache_prefix=${pycachePrefix}`, path.join(projectRoot(), 'bridge', 'mpy_bridge.py')],
    cwd,
    env: childEnv(),
  };
}

type Pending = { op: string; resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Minimal NDJSON client: just enough to prove the contract from Node. The real client is src/bridge (not this). */
export class RawBridge {
  readonly events: WireEvent[] = [];
  readonly stderrLines: string[] = [];
  readonly badStdout: string[] = [];
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters: { pred: (e: WireEvent) => boolean; resolve: (e: WireEvent) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private outBuf = '';
  private errBuf = '';
  private readonly tmp: string;

  private constructor(private readonly child: ChildProcess, tmp: string) {
    this.tmp = tmp;
    child.stdout?.on('data', (d: Buffer) => this.onStdout(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => {
      this.errBuf += d.toString('utf8');
      const lines = this.errBuf.split('\n');
      this.errBuf = lines.pop() ?? '';
      this.stderrLines.push(...lines);
    });
    child.once('exit', () => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`The bridge exited before answering ${p.op} (request ${id}). stderr tail: ${this.stderrLines.slice(-5).join(' | ')}`));
      }
      this.pending.clear();
    });
  }

  static async start(): Promise<RawBridge> {
    const tmp = makeTempDir('upy-bridge-bridge');
    const spec = bridgeSpawnSpec(tmp, path.join(tmp, 'pyc'));
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    live.add(child);
    const bridge = new RawBridge(child, tmp);
    try {
      await bridge.waitEvent((e) => e.ev === 'hello', 20000);
    } catch (err) {
      await bridge.stop();
      throw err;
    }
    return bridge;
  }

  get pid(): number { return this.child.pid ?? -1; }
  get exited(): boolean { return this.child.exitCode !== null || this.child.signalCode !== null; }

  private onStdout(text: string): void {
    this.outBuf += text;
    const lines = this.outBuf.split('\n');
    this.outBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) { continue; }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.badStdout.push(line); // a protocol violation: tests assert this stays empty
        continue;
      }
      if (typeof msg.ev === 'string') {
        const ev = msg as unknown as WireEvent;
        this.events.push(ev);
        for (const w of [...this.waiters]) {
          if (w.pred(ev)) { clearTimeout(w.timer); this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(ev); }
        }
      } else if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg); }
      }
    }
  }

  /** Send a request and resolve with its result fields; rejects with RawBridgeError for `ok:false`. */
  call<K extends OpName>(op: K, args: OpArgs<K>, timeoutMs = 15000): Promise<OpResult<K>> {
    const id = ++this.nextId;
    return new Promise<OpResult<K>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`No answer to ${op} within ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, {
        op, timer, reject,
        resolve: (msg) => {
          if (msg.ok === true) { resolve(msg as unknown as OpResult<K>); } else { reject(new RawBridgeError(op, msg.error as BridgeErrorBody)); }
        },
      });
      this.child.stdin?.write(`${JSON.stringify({ id, op, ...(args as object) })}\n`);
    });
  }

  waitEvent(pred: (e: WireEvent) => boolean, timeoutMs = 10000): Promise<WireEvent> {
    const seen = this.events.find(pred);
    if (seen) { return Promise.resolve(seen); }
    return new Promise<WireEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Expected bridge event did not arrive within ${timeoutMs} ms. stderr tail: ${this.stderrLines.slice(-5).join(' | ')}`)), timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  /** stdin EOF (the bridge quits and closes the port), then terminate if it does not. Removes the temp folder. */
  async stop(): Promise<void> {
    await shutDown(this.child);
    removeDir(this.tmp);
  }
}

// ------------------------------------------------------------------ convenience

/** Start a fake board and a bridge, run `fn`, and ALWAYS stop both. */
export async function withBridge<T>(fn: (ctx: { board: FakeBoardHandle; bridge: RawBridge }) => Promise<T>, board: FakeBoardOptions = {}): Promise<T> {
  const b = await startFakeBoard(board);
  let bridge: RawBridge | undefined;
  try {
    bridge = await RawBridge.start();
    return await fn({ board: b, bridge });
  } finally {
    await bridge?.stop();
    await b.stop();
  }
}

/** Kill everything still alive (safety net for afterEach). */
export async function stopAll(): Promise<void> {
  await Promise.all([...live].map((c) => shutDown(c)));
}

export function liveProcessCount(): number {
  return live.size;
}
