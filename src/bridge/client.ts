/**
 * BridgeClient: spawns the ONE Python bridge of this window (lazily), speaks NDJSON with it, and turns every failure into a
 * typed `BoardError` with the protocol's code, message and hint. It never throws unhandled: listeners are isolated, bad output
 * is logged and skipped, a dead process rejects every pending call, and restarts are bounded.
 *
 * Process: `[python, ...prefix, -I, -u, -X utf8, -X pycache_prefix=<dir>, <extension>/bridge/mpy_bridge.py]`, cwd = a neutral
 * folder (never the workspace), environment inherited as is (MPY_SAFE_MODE is passed on only when the parent has it),
 * `shell:false`, `windowsHide:true`. stdin EOF means "quit" to the bridge; after a grace period the whole tree is killed.
 * No `vscode` import (docs/protocol.md sections 1, 2, 6).
 */
import fs from 'node:fs';
import os from 'node:os';
import type { Logger } from '../log';
import { PROTOCOL_VERSION, type HelloEvent, type OpArgs, type OpName, type OpResult } from '../types/protocol';
import { BoardError, type CallOptions, type Disposable } from '../types/session';
import { LineDecoder, MAX_LINE_BYTES, decodeWire, encodeRequest, type WireMessage } from './codec';
import { DOCTOR_HINT, bridgeExited, bridgeStopped, callAborted, callTimeout, clientError } from './errors';
import {
  NodeProcessLauncher, buildBridgeArgv, type ChildHandle, type LaunchSpec, type ProcessLauncher, type PythonLauncherSpec, type SpawnFailure,
} from './process';
import type { Bridge, BridgeEvent, BridgeExitInfo, BridgeStatus, PendingCall } from './types';

export interface BridgeClientOptions {
  /** Finds the Python to run the bridge with, every time a process is (re)started. Rejects with a BoardError (E_NO_PYTHON). */
  resolvePython(): Promise<PythonLauncherSpec>;
  /** Folder that contains `bridge/mpy_bridge.py`. */
  extensionPath: string;
  /** `-X pycache_prefix=`: a writable folder (extension global storage), so bytecode never lands in the extension folder. */
  pycacheDir: string;
  /** Neutral working folder of the process (never the workspace). */
  cwd: string;
  log: Logger;
  /** Runs right after a valid hello and before the first queued request: push `config` here. Failures are logged. */
  afterHello?: (api: { call<K extends OpName>(op: K, args: OpArgs<K>): Promise<OpResult<K>> }) => Promise<void>;
  launcher?: ProcessLauncher;
  /** Environment of the process; default `process.env`. Nothing is added: MPY_SAFE_MODE only if the parent has it. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Time to a valid hello (default 30 s: the first start of a fresh Python can be slow under antivirus). */
  startupTimeoutMs?: number;
  /** After stdin EOF, how long to wait for the process to leave on its own before killing the tree (default 4 s). */
  shutdownGraceMs?: number;
  /** At most `maxRestarts` restarts within `windowMs` (default 3 in 5 minutes), then E_INTERNAL with the Doctor hint. */
  restart?: { maxRestarts: number; windowMs: number };
  /** Bad stdout lines tolerated per process before the channel is declared corrupt (default 50). */
  maxBadLines?: number;
  now?: () => number;
}

/** Client-side limits for ops that must answer quickly. Everything else has none unless the caller passes one. */
const DEFAULT_TIMEOUT_MS: Partial<Record<OpName, number>> = {
  'ping': 5000, 'ports.list': 20000, 'connect': 60000, 'disconnect': 30000, 'config': 10000, 'cancel': 5000, 'repl.attach': 10000,
  'repl.detach': 10000, 'tty.write': 10000, 'reset.capability': 10000, 'shutdown': 5000,
};
const STOP_EXTRA_MS = 5000;
const STDERR_TAIL = 30;
const NO_CANCEL: readonly OpName[] = ['cancel', 'ping', 'tty.write', 'shutdown', 'stop'];

interface Pending {
  readonly id: number;
  readonly op: string;
  resolve(value: Record<string, unknown>): void;
  reject(err: BoardError): void;
  timer?: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
}

interface Proc {
  readonly child: ChildHandle;
  readonly stdout: LineDecoder;
  readonly stderr: LineDecoder;
  readonly stderrTail: string[];
  readonly exited: Promise<void>;
  markExited(): void;
  hello: HelloEvent | null;
  fatal: string | null;
  ended: boolean;
  expectedExit: boolean;
  badLines: number;
  startup: { resolve(h: HelloEvent): void; reject(e: BoardError): void } | null;
}

function toBoardError(err: unknown, code: 'E_NO_PYTHON' | 'E_INTERNAL'): BoardError {
  if (err instanceof BoardError) {
    return err;
  }
  const text = err instanceof Error ? err.message : String(err);
  return clientError(code, `Could not start the connection helper: ${text}`, DOCTOR_HINT, text);
}

export class BridgeClient implements Bridge {
  private readonly log: Logger;
  private readonly bridgeLog: Logger;
  private readonly launcher: ProcessLauncher;
  private readonly now: () => number;
  private readonly eventListeners = new Set<(ev: BridgeEvent) => unknown>();
  private readonly statusListeners = new Set<(status: BridgeStatus, info?: BridgeExitInfo) => unknown>();
  private readonly pending = new Map<number, Pending>();
  private proc: Proc | undefined;
  private startPromise: Promise<HelloEvent> | undefined;
  private current: BridgeStatus = 'stopped';
  private lastId = 0;
  private closed = false;
  private spawnTimes: number[] = [];

  constructor(private readonly opts: BridgeClientOptions) {
    this.log = opts.log.child('bridge-client');
    this.bridgeLog = opts.log.child('bridge');
    this.launcher = opts.launcher ?? new NodeProcessLauncher(this.log, opts.platform);
    this.now = opts.now ?? Date.now;
  }

  get status(): BridgeStatus {
    return this.current;
  }

  get hello(): HelloEvent | null {
    return this.proc && !this.proc.ended ? this.proc.hello : null;
  }

  get pid(): number | undefined {
    return this.proc && !this.proc.ended ? this.proc.child.pid : undefined;
  }

  onEvent(listener: (ev: BridgeEvent) => unknown): Disposable {
    this.eventListeners.add(listener);
    return { dispose: () => { this.eventListeners.delete(listener); } };
  }

  onStatus(listener: (status: BridgeStatus, info?: BridgeExitInfo) => unknown): Disposable {
    this.statusListeners.add(listener);
    return { dispose: () => { this.statusListeners.delete(listener); } };
  }

  /** Forget earlier crashes: the next start is allowed again (used by the Doctor and the Retry buttons). */
  resetRestartBudget(): void {
    this.spawnTimes = [];
  }

  // ------------------------------------------------------------------ starting

  start(): Promise<HelloEvent> {
    if (this.closed) {
      return Promise.reject(bridgeStopped());
    }
    const proc = this.proc;
    if (this.current === 'ready' && proc?.hello && !proc.ended) {
      return Promise.resolve(proc.hello);
    }
    if (!this.startPromise) {
      const p = this.startProcess();
      this.startPromise = p;
      const clear = (): void => {
        if (this.startPromise === p) {
          this.startPromise = undefined;
        }
      };
      p.then(clear, clear);
    }
    return this.startPromise;
  }

  private guardRestartBudget(): void {
    const { maxRestarts, windowMs } = this.opts.restart ?? { maxRestarts: 3, windowMs: 5 * 60 * 1000 };
    const now = this.now();
    this.spawnTimes = this.spawnTimes.filter((t) => now - t < windowMs);
    if (this.spawnTimes.length >= maxRestarts + 1) {
      const minutes = Math.round(windowMs / 6000) / 10;
      throw clientError(
        'E_INTERNAL', `The connection helper stopped ${this.spawnTimes.length} times within ${minutes} minutes, so it is not restarted automatically.`,
        `${DOCTOR_HINT} Then reload the VS Code window (Command Palette: "Developer: Reload Window").`, `restarts=${this.spawnTimes.length}`,
      );
    }
  }

  private prepareFolders(): string {
    let cwd = this.opts.cwd;
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch (err) {
      this.log.warn(`could not create the helper's working folder ${cwd}; using the system temp folder`, err);
      cwd = os.tmpdir();
    }
    try {
      fs.mkdirSync(this.opts.pycacheDir, { recursive: true });
    } catch (err) {
      this.log.warn(`could not create the Python cache folder ${this.opts.pycacheDir}; Python will run without cached bytecode`, err);
    }
    return cwd;
  }

  private async startProcess(): Promise<HelloEvent> {
    this.guardRestartBudget();
    this.setStatus('starting');
    let python: PythonLauncherSpec;
    try {
      python = await this.opts.resolvePython();
    } catch (err) {
      this.setStatus('stopped');
      throw toBoardError(err, 'E_NO_PYTHON');
    }
    if (this.closed) {
      this.setStatus('stopped');
      throw bridgeStopped();
    }
    const cwd = this.prepareFolders();
    const args = buildBridgeArgv(python, this.opts.extensionPath, this.opts.pycacheDir);
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env) };
    delete env.__PYVENV_LAUNCHER__; // macOS venv launcher variable: it makes a different Python start in the wrong environment
    const spec: LaunchSpec = { command: python.command, args, cwd, env };
    this.log.info(`starting the connection helper: ${[spec.command, ...spec.args].join(' ')}`);
    this.spawnTimes.push(this.now());
    let child: ChildHandle;
    try {
      child = this.launcher.launch(spec);
    } catch (err) {
      this.setStatus('exited');
      throw clientError('E_NO_PYTHON', `Python could not be started (${python.command}).`, `${DOCTOR_HINT}`, err instanceof Error ? err.message : String(err));
    }
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => { markExited = resolve; });
    const proc: Proc = {
      child, stdout: new LineDecoder(), stderr: new LineDecoder(64 * 1024), stderrTail: [], exited, markExited,
      hello: null, fatal: null, ended: false, expectedExit: false, badLines: 0, startup: null,
    };
    this.proc = proc;
    child.onStdout((chunk) => this.guard(() => this.onStdout(proc, chunk)));
    child.onStderr((chunk) => this.guard(() => this.onStderr(proc, chunk)));
    child.onError((err) => this.guard(() => this.onProcessError(proc, python, err)));
    child.onExit((code, signal) => this.guard(() => this.onExit(proc, code, signal)));

    const timeoutMs = this.opts.startupTimeoutMs ?? 30000;
    const hello = await new Promise<HelloEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (proc.startup) {
          const e = clientError(
            'E_BRIDGE_EXITED', `The connection helper did not start within ${Math.round(timeoutMs / 1000)} seconds.`,
            `Antivirus software may be scanning Python. Wait a moment and try again. ${DOCTOR_HINT}`, `startup timeout; stderr: ${proc.stderrTail.slice(-5).join(' | ')}`,
          );
          proc.startup.reject(e);
        }
      }, timeoutMs);
      proc.startup = {
        resolve: (h) => { clearTimeout(timer); proc.startup = null; resolve(h); },
        reject: (e) => { clearTimeout(timer); proc.startup = null; this.abandon(proc); reject(e); },
      };
    });
    try {
      await this.opts.afterHello?.({
        call: <K extends OpName>(op: K, a: OpArgs<K>): Promise<OpResult<K>> => this.write(++this.lastId, op, a, {}) as Promise<unknown> as Promise<OpResult<K>>,
      });
    } catch (err) {
      this.log.warn('setting up the connection helper failed', err);
    }
    if (proc.ended) {
      throw this.closed ? bridgeStopped() : bridgeExited(`stopped while starting; exit code information in the log`);
    }
    this.setStatus('ready');
    return hello;
  }

  /** A start that failed after the process exists: make sure it is gone. */
  private abandon(proc: Proc): void {
    if (!proc.ended) {
      proc.child.kill();
    }
  }

  // ------------------------------------------------------------------ sending

  send<K extends OpName>(op: K, args: OpArgs<K>, opts: CallOptions = {}): PendingCall<OpResult<K>> {
    const id = ++this.lastId;
    const result = this.dispatch(id, op, args, opts) as Promise<OpResult<K>>;
    return { id, result };
  }

  private async dispatch(id: number, op: OpName, args: unknown, opts: CallOptions): Promise<Record<string, unknown>> {
    if (opts.signal?.aborted) {
      throw callAborted(op);
    }
    if (this.closed) {
      throw bridgeStopped(op);
    }
    await this.raceAbort(this.start(), opts.signal, op);
    return this.write(id, op, args, opts);
  }

  private raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, op: string): Promise<T> {
    if (!signal) {
      return work;
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(callAborted(op));
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }

  private defaultTimeout(op: OpName, args: unknown): number | undefined {
    if (op === 'stop') {
      const t = (args as { timeoutMs?: unknown } | null)?.timeoutMs;
      return (typeof t === 'number' && t > 0 ? t : 3000) + STOP_EXTRA_MS;
    }
    return DEFAULT_TIMEOUT_MS[op];
  }

  private write(id: number, op: OpName, args: unknown, opts: CallOptions): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const proc = this.proc;
      if (!proc || !proc.hello || proc.ended) {
        reject(this.closed ? bridgeStopped(op) : bridgeExited('the helper is not running', op));
        return;
      }
      const line = encodeRequest(id, op, args);
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        reject(clientError('E_PROTOCOL', 'That request is too large to send to the board helper.', 'Send less data at once.', `${op}: ${line.length} characters`, op));
        return;
      }
      const pending: Pending = { id, op, resolve, reject };
      this.pending.set(id, pending);
      const timeoutMs = opts.timeoutMs ?? this.defaultTimeout(op, args);
      if (timeoutMs !== undefined && timeoutMs > 0) {
        pending.timer = setTimeout(() => this.onTimeout(pending, timeoutMs), timeoutMs);
      }
      const signal = opts.signal;
      if (signal) {
        const onAbort = (): void => this.onAbort(pending);
        signal.addEventListener('abort', onAbort, { once: true });
        pending.cleanup = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          this.onAbort(pending);
          return;
        }
      }
      try {
        proc.child.write(line);
      } catch (err) {
        this.settleReject(pending, bridgeExited(err instanceof Error ? err.message : String(err), op));
        this.abandon(proc);
        return;
      }
      if (this.log.isEnabled('debug')) {
        const text = line.length > 300 ? `${line.slice(0, 300)}... (${line.length} chars)` : line.trimEnd();
        this.log.debug(`-> ${text}`);
      }
    });
  }

  private settle(p: Pending): boolean {
    if (this.pending.get(p.id) !== p) {
      return false;
    }
    this.pending.delete(p.id);
    if (p.timer) {
      clearTimeout(p.timer);
    }
    p.cleanup?.();
    return true;
  }

  private settleResolve(p: Pending, value: Record<string, unknown>): void {
    if (this.settle(p)) {
      p.resolve(value);
    }
  }

  private settleReject(p: Pending, err: BoardError): void {
    if (this.settle(p)) {
      p.reject(err);
    }
  }

  private rejectAll(err: BoardError): void {
    for (const p of [...this.pending.values()]) {
      this.settleReject(p, new BoardError(err.body, p.op));
    }
  }

  private onTimeout(p: Pending, ms: number): void {
    if (this.pending.get(p.id) !== p) {
      return;
    }
    this.log.warn(`no answer to ${p.op} (request ${p.id}) within ${ms} ms`);
    this.settleReject(p, callTimeout(p.op, ms));
    this.cancelQuietly(p);
  }

  private onAbort(p: Pending): void {
    if (this.pending.get(p.id) !== p) {
      return;
    }
    this.settleReject(p, callAborted(p.op));
    this.cancelQuietly(p);
  }

  /** Ask the bridge to drop a queued request or stop a running file op at the next chunk. Failures only matter to the log. */
  private cancelQuietly(p: Pending): void {
    const proc = this.proc;
    if (!proc?.hello || proc.ended || (NO_CANCEL as readonly string[]).includes(p.op)) {
      return;
    }
    this.write(++this.lastId, 'cancel', { target: p.id }, {}).catch((err: unknown) => {
      this.log.debug(`could not cancel request ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ------------------------------------------------------------------ receiving

  /** Run `fn`; anything it throws is a bug of ours, not of the caller: log it and carry on. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.error('internal error while handling output of the connection helper', err);
    }
  }

  private onStdout(proc: Proc, chunk: Uint8Array): void {
    if (this.proc !== proc) {
      return;
    }
    for (const line of proc.stdout.push(chunk)) {
      if (line.kind === 'overflow') {
        this.badLine(proc, `a message of ${line.bytes} bytes (limit ${MAX_LINE_BYTES}) was dropped`);
        continue;
      }
      this.onMessage(proc, decodeWire(line.text), line.text);
    }
  }

  private badLine(proc: Proc, why: string): void {
    proc.badLines += 1;
    this.log.warn(`ignored bad output of the connection helper: ${why}`);
    const max = this.opts.maxBadLines ?? 50;
    if (proc.badLines > max && !proc.ended) {
      this.log.error(`the connection helper sent more than ${max} unreadable lines; stopping it`);
      this.rejectAll(clientError(
        'E_PROTOCOL', 'The connection helper is sending unreadable data, so it was stopped.', `${DOCTOR_HINT} Then try again.`, `bad lines: ${proc.badLines}`,
      ));
      proc.expectedExit = false;
      this.abandon(proc);
    }
  }

  private onMessage(proc: Proc, msg: WireMessage, raw: string): void {
    switch (msg.kind) {
      case 'invalid':
        this.badLine(proc, `${msg.reason}: ${raw.length > 200 ? `${raw.slice(0, 200)}...` : raw}`);
        return;
      case 'response': {
        const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
        if (!p) {
          this.log.debug(`answer for request ${String(msg.id)} that nobody waits for (cancelled or timed out)${msg.ok ? '' : `: ${msg.error.code}`}`);
          return;
        }
        if (msg.ok) {
          this.settleResolve(p, msg.result);
        } else {
          this.settleReject(p, new BoardError(msg.error, p.op));
        }
        return;
      }
      case 'event':
        this.handleEvent(proc, msg.event);
        return;
    }
  }

  private handleEvent(proc: Proc, ev: BridgeEvent): void {
    if (ev.ev === 'hello') {
      if (proc.hello) {
        this.log.warn('a second hello from the connection helper was ignored');
        return;
      }
      if (ev.proto !== PROTOCOL_VERSION) {
        const e = clientError(
          'E_PROTOCOL', `The connection helper speaks protocol version ${ev.proto}, but this extension needs version ${PROTOCOL_VERSION}.`,
          'Reinstall or update the extension so its parts match.', `bridge ${ev.bridge}`,
        );
        this.log.error(`${e.message}`);
        proc.startup?.reject(e);
        return;
      }
      proc.hello = ev;
      this.log.info(`connection helper ${ev.bridge} ready (protocol ${ev.proto}, Python ${ev.python}, pyserial ${ev.pyserial}, ${ev.platform}, pid ${ev.pid})`);
      this.emit(ev);
      proc.startup?.resolve(ev);
      return;
    }
    if (!proc.hello && ev.ev !== 'fatal' && ev.ev !== 'log') {
      this.log.warn(`event "${ev.ev}" arrived before hello and was ignored`);
      return;
    }
    switch (ev.ev) {
      case 'log':
        this.bridgeLog.log(ev.level, ev.msg);
        break;
      case 'fatal':
        proc.fatal = ev.message;
        this.log.error(`fatal error reported by the connection helper: ${ev.message}`);
        break;
      default:
        break;
    }
    this.emit(ev);
  }

  private onStderr(proc: Proc, chunk: Uint8Array): void {
    for (const line of proc.stderr.push(chunk)) {
      const text = line.kind === 'line' ? line.text : `(a very long line of ${line.bytes} bytes was dropped)`;
      proc.stderrTail.push(text);
      if (proc.stderrTail.length > STDERR_TAIL) {
        proc.stderrTail.shift();
      }
      const m = /^\[(debug|info|warn|warning|error)\]\s?(.*)$/i.exec(text);
      const level = m?.[1]?.toLowerCase();
      const lv = level === 'debug' ? 'debug' : level === 'warn' || level === 'warning' ? 'warn' : level === 'error' ? 'error' : 'info';
      const body = m ? (m[2] ?? '') : text;
      this.bridgeLog.log(lv, body.length > 2000 ? `${body.slice(0, 2000)}...` : body);
    }
  }

  private onProcessError(proc: Proc, python: PythonLauncherSpec, err: SpawnFailure): void {
    if (this.proc !== proc) {
      return;
    }
    this.log.error(`process error (${err.code ?? 'no code'}) for ${python.command}`, err);
    if (proc.startup && !proc.hello) {
      const missing = err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM';
      proc.startup.reject(missing
        ? clientError('E_NO_PYTHON', `Python could not be started (${python.command}): ${err.message}`, DOCTOR_HINT, `${err.code ?? ''} ${err.message}`.trim())
        : bridgeExited(`${err.code ?? ''} ${err.message}`.trim()));
      return;
    }
    // a broken pipe or similar on a running helper: the exit event follows, make sure it does
    this.abandon(proc);
  }

  private onExit(proc: Proc, code: number | null, signal: string | null): void {
    if (proc.ended) {
      return;
    }
    proc.ended = true;
    proc.markExited();
    // flush a last unterminated stderr line is not needed: the bridge terminates its lines
    const expected = proc.expectedExit || this.closed;
    if (this.proc === proc) {
      this.proc = undefined;
    }
    const info: BridgeExitInfo = { code, signal, expected, stderrTail: [...proc.stderrTail] };
    const detail = `exit code ${String(code)}${signal ? `, signal ${signal}` : ''}${proc.stderrTail.length ? `; last output: ${proc.stderrTail.slice(-5).join(' | ')}` : ''}`;
    if (expected) {
      this.log.info(`connection helper stopped (${detail})`);
    } else {
      this.log.error(`connection helper exited unexpectedly (${detail})`);
    }
    const err = expected ? bridgeStopped() : bridgeExited(detail);
    this.rejectAll(err);
    if (proc.startup) {
      const reason = proc.fatal
        ? clientError('E_INTERNAL', `The connection helper could not start: ${proc.fatal}`, `${DOCTOR_HINT}`, detail)
        : clientError(
          'E_BRIDGE_EXITED', 'The connection helper stopped before it was ready.',
          `The Python being used may be too old or damaged. ${DOCTOR_HINT}`, detail,
        );
      proc.startup.reject(reason);
    }
    this.setStatus(expected ? 'stopped' : 'exited', info);
  }

  // ------------------------------------------------------------------ events out

  private emit(ev: BridgeEvent): void {
    for (const l of [...this.eventListeners]) {
      try {
        l(ev);
      } catch (err) {
        this.log.error(`an event listener failed on "${ev.ev}"`, err);
      }
    }
  }

  private setStatus(status: BridgeStatus, info?: BridgeExitInfo): void {
    if (this.current === status && !info) {
      return;
    }
    this.current = status;
    for (const l of [...this.statusListeners]) {
      try {
        l(status, info);
      } catch (err) {
        this.log.error(`a status listener failed on "${status}"`, err);
      }
    }
  }

  // ------------------------------------------------------------------ stopping

  private waitExit(proc: Proc, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void proc.exited.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  async stopProcess(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.ended) {
      return;
    }
    proc.expectedExit = true;
    const stopped = bridgeStopped();
    this.rejectAll(stopped);
    proc.startup?.reject(stopped);
    proc.child.endStdin(); // EOF = quit: the bridge interrupts a running program, closes the port and exits
    if (await this.waitExit(proc, this.opts.shutdownGraceMs ?? 4000)) {
      return;
    }
    this.log.warn('the connection helper did not leave after its input was closed; killing it');
    proc.child.kill();
    if (!(await this.waitExit(proc, 3000))) {
      this.log.error('the connection helper is still running after it was killed');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopProcess();
    this.rejectAll(bridgeStopped());
    this.setStatus('stopped');
  }

  dispose(): void {
    this.close().then(
      () => { this.eventListeners.clear(); this.statusListeners.clear(); },
      (err: unknown) => this.log.error('error while stopping the connection helper', err),
    );
  }
}
