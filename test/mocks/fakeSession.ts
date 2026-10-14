/**
 * In-memory BoardSession for command, view, status bar, REPL and sync tests. Records every call, answers from scripted
 * responders, emits events on demand, models the two bridge rules that commands must handle (E_NOT_CONNECTED, and gated file
 * ops answering E_PROGRAM_RUNNING with needs_interrupt while a program runs), and can host a small in-memory board filesystem.
 *
 *   const s = FakeSession.connected();                       // idle, port '/dev/cu.fake'
 *   s.script('run', async (args, ctx) => { ctx.emit({ ev: 'out', bytes: enc('hi\r\n') }); return { exit: 'ok', durationMs: 3 }; });
 *   s.fail('fs.list', 'E_FS_ERRNO', 'No such folder.', { detail: 'ENOENT' });   // next fs.list rejects once
 *   const gate = s.hold('fs.put'); const p = s.call('fs.put', {...}); await gate.arrived; gate.release(); await p;
 *   s.useBoardFs({ '/main.py': 'print(1)\n' });              // fs.* ops against an in-memory board
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BridgeErrorBody, ConnectPortInfo, ErrorCode, FsEntry, ManifestEntry, OpArgs, OpName, OpResult, BoardIdentity } from '../../src/types/protocol';
import {
  BoardError, initialSessionState, type BoardSession, type CallOptions, type ConnectOptions, type Disposable, type SessionEvent,
  type SessionState,
} from '../../src/types/session';

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

export interface RecordedCall { seq: number; op: OpName; args: unknown; opts: CallOptions | undefined; stateAtCall: string; aborted: boolean; interrupted: boolean }

export interface CallContext {
  readonly session: FakeSession;
  readonly signal: AbortSignal | undefined;
  emit(ev: SessionEvent): void;
  setState(patch: Partial<SessionState>): void;
  /** Run the built-in/persistent responder for this op (for example the in-memory board filesystem) from inside a custom one. */
  fallthrough(): Promise<unknown>;
}

type Handler = (args: unknown, ctx: CallContext) => unknown;
export type Responder<K extends OpName> = OpResult<K> | BoardError | ((args: OpArgs<K>, ctx: CallContext) => OpResult<K> | Promise<OpResult<K>>);

export interface Gate { readonly arrived: Promise<RecordedCall>; release(): void; fail(err: BoardError): void }

const NO_LINK_OPS: readonly OpName[] = ['connect', 'ports.list', 'ping', 'config', 'cancel', 'shutdown'];
const GATED_OPS: readonly OpName[] = ['identity', 'fs.list', 'fs.manifest', 'fs.stat', 'fs.put', 'fs.get', 'fs.rm', 'fs.rmtree', 'fs.mkdir', 'fs.mv', 'exec', 'introspect.modules', 'clock.read', 'clock.set'];

export const FAKE_PORT_INFO: ConnectPortInfo = {
  port: '/dev/cu.fake', requested: '/dev/cu.fake', baud: 115200, kind: 'device', policy: 'default', platform: 'darwin', pyserial: '3.5',
  vid: 0x10c4, pid: 0xea60, adapter: 'cp210x', exclusive: true, canHardReset: null,
};

export const FAKE_IDENTITY: BoardIdentity = {
  impl: 'micropython', version: [1, 29, 0], machine: 'Generic ESP32 module with ESP32', build: '', mpy: 6, platform: 'esp32',
  uname: { sysname: 'esp32', nodename: 'esp32', release: '1.29.0', version: 'v1.29.0', machine: 'Generic ESP32 module with ESP32' },
  uniqueId: 'aabbccddeeff', syspath: ['', '.frozen', '/lib'], root: ['boot.py'],
  caps: { hash: 'sha256', compile: true, paste: true, mem: 100000 }, profileHints: { modules: [], frozen: false, fsTotal: 1000000, fsFree: 900000 },
};

export class FakeSession implements BoardSession {
  private current: SessionState = initialSessionState();
  private readonly stateListeners = new Set<(s: SessionState) => unknown>();
  private readonly eventListeners = new Set<(e: SessionEvent) => unknown>();
  private readonly persistent = new Map<OpName, Handler>();
  private readonly once = new Map<OpName, Handler[]>();
  private readonly gates = new Map<OpName, { gate: Gate; arrive: (c: RecordedCall) => void; done: Promise<void> }[]>();
  private selected: string | null = null;
  private disposed = false;

  /** Every call in order, including rejected ones. */
  readonly calls: RecordedCall[] = [];
  /** Bytes sent with tty.write, decoded. */
  readonly ttyWrites: Uint8Array[] = [];
  /** Delay (ms) before every answer, to test progress / busy UI. */
  latencyMs = 0;
  /** Model `E_NOT_CONNECTED` for ops that need a connection (default true). */
  requireConnection = true;
  /** Model `E_PROGRAM_RUNNING` + needs_interrupt for gated file ops while the state is `running` (default true). */
  gateFileOps = true;
  boardFs: FakeBoardFs | undefined;
  identity: BoardIdentity = FAKE_IDENTITY;

  constructor(initial: Partial<SessionState> = {}) {
    this.current = { ...initialSessionState(), ...initial };
    this.selected = this.current.port;
  }

  /** A session that is already connected and idle. */
  static connected(patch: Partial<SessionState> = {}): FakeSession {
    return new FakeSession({
      bridge: 'ready', interpreter: 'ok', state: 'idle', port: '/dev/cu.fake', portInfo: FAKE_PORT_INFO, sync: 'prompt', identity: FAKE_IDENTITY, reason: 'prompt', ...patch,
    });
  }

  // ---------------------------------------------------------------- BoardSession

  get state(): SessionState { return this.current; }
  readonly onDidChangeState = (l: (s: SessionState) => unknown): Disposable => this.listen(this.stateListeners, l);
  onEvent(l: (e: SessionEvent) => unknown): Disposable { return this.listen(this.eventListeners, l); }
  get selectedPort(): string | null { return this.selected; }
  get isRunning(): boolean { return this.current.state === 'running'; }
  get pendingSyncCount(): number { return this.current.pendingSyncCount; }

  private listen<T>(set: Set<(v: T) => unknown>, l: (v: T) => unknown): Disposable {
    set.add(l);
    return { dispose: () => { set.delete(l); } };
  }

  selectPort(port: string | null): void {
    this.selected = port;
    this.setState({});
  }

  setPendingSyncCount(count: number): void {
    this.setState({ pendingSyncCount: count });
  }

  async connect(port: string, opts: ConnectOptions = {}): Promise<OpResult<'connect'>> {
    if (/^auto$/i.test(port.trim())) {
      throw BoardError.of('E_PROTOCOL', '"auto" is a UI choice, never a port name.', { hint: 'Pick one port from the list.' }, 'connect');
    }
    this.selected = port;
    this.setState({ bridge: 'ready', state: 'connecting', port, reason: 'connect' });
    try {
      const res = await this.call('connect', { port, ...opts });
      const state = res.state === 'idle' ? 'idle' : 'running';
      this.setState({ state, reason: res.sync, portInfo: res.portInfo, sync: res.sync, port, identity: null });
      return res;
    } catch (err) {
      this.setState({ state: 'disconnected', port: null, portInfo: null, sync: null, reason: 'connect-failed' });
      throw err;
    }
  }

  async disconnect(opts: { stopFirst?: boolean } = {}): Promise<void> {
    if (this.current.state !== 'disconnected') {
      await this.call('disconnect', opts);
    }
    this.setState({ state: 'disconnected', port: null, portInfo: null, sync: null, identity: null, reason: 'disconnect' });
  }

  async call<K extends OpName>(op: K, args: OpArgs<K>, opts?: CallOptions): Promise<OpResult<K>> {
    const rec: RecordedCall = { seq: this.calls.length + 1, op, args, opts, stateAtCall: this.current.state, aborted: false, interrupted: false };
    this.calls.push(rec);
    const work = this.runCall(op, args, opts, rec);
    const guarded = this.withLimits(work, opts, rec, op);
    return (await guarded) as OpResult<K>;
  }

  dispose(): void {
    this.disposed = true;
    this.stateListeners.clear();
    this.eventListeners.clear();
  }

  // ---------------------------------------------------------------- scripting

  /** Persistent answer for `op` (replaces an earlier persistent one). */
  script<K extends OpName>(op: K, responder: Responder<K>): this {
    this.persistent.set(op, this.toHandler(responder));
    return this;
  }

  /** Answer only the next call of `op`. */
  scriptOnce<K extends OpName>(op: K, responder: Responder<K>): this {
    this.queueOnce(op, this.toHandler(responder));
    return this;
  }

  /** Make the next call of `op` reject with a bridge error. */
  fail(op: OpName, code: ErrorCode, message: string, extra: Partial<BridgeErrorBody> = {}): this {
    const err = BoardError.of(code, message, extra, op);
    this.queueOnce(op, () => { throw err; });
    return this;
  }

  private queueOnce(op: OpName, handler: Handler): void {
    this.once.set(op, [...(this.once.get(op) ?? []), handler]);
  }

  /** Hold the next call of `op` until `release()`/`fail()`: `await gate.arrived` tells you the call is in flight. */
  hold(op: OpName): Gate {
    let arrive!: (c: RecordedCall) => void;
    let resolveDone!: () => void;
    let rejectDone!: (e: BoardError) => void;
    const arrived = new Promise<RecordedCall>((r) => { arrive = r; });
    const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; });
    const gate: Gate = { arrived, release: () => resolveDone(), fail: (e) => rejectDone(e) };
    this.gates.set(op, [...(this.gates.get(op) ?? []), { gate, arrive, done }]);
    return gate;
  }

  /** Deliver a bridge event to listeners (state events also update `state`). */
  emit(ev: SessionEvent): void {
    if (ev.ev === 'state') {
      this.current = { ...this.current, state: ev.state, reason: ev.reason ?? this.current.reason };
      this.fireState();
    }
    for (const l of [...this.eventListeners]) { l(ev); }
  }

  /** Change the session state and notify, as the real session does when the bridge reports a transition. */
  setState(patch: Partial<SessionState>): void {
    const prev = this.current.state;
    this.current = { ...this.current, ...patch };
    this.fireState();
    if (patch.state !== undefined && patch.state !== prev) {
      for (const l of [...this.eventListeners]) { l({ ev: 'state', state: patch.state, prev, reason: patch.reason }); }
    }
  }

  callsOf(op: OpName): RecordedCall[] { return this.calls.filter((c) => c.op === op); }
  argsOf<K extends OpName>(op: K): OpArgs<K>[] { return this.callsOf(op).map((c) => c.args as OpArgs<K>); }

  /** Install default `fs.*` handlers over an in-memory board filesystem (and identity/exec stubs stay unscripted). */
  useBoardFs(initial: Record<string, string | Uint8Array> = {}): FakeBoardFs {
    const board = new FakeBoardFs(initial);
    this.boardFs = board;
    return board;
  }

  // ---------------------------------------------------------------- internals

  private fireState(): void {
    for (const l of [...this.stateListeners]) { l(this.current); }
  }

  private toHandler<K extends OpName>(r: Responder<K>): Handler {
    if (typeof r === 'function') { return (a, c) => (r as (x: OpArgs<K>, y: CallContext) => unknown)(a as OpArgs<K>, c); }
    if (r instanceof BoardError) { return () => { throw r; }; }
    return () => r;
  }

  private builtin(op: OpName, args: unknown): unknown {
    switch (op) {
      case 'ping': case 'config': case 'cancel': case 'shutdown': case 'repl.attach': case 'repl.detach': case 'disconnect': return op === 'cancel' ? { cancelled: false } : {};
      case 'ports.list': return { ports: [] };
      case 'stop': return { stopped: true, ms: 1 };
      case 'run': return { exit: 'ok', durationMs: 0 };
      case 'reset.soft': return {};
      case 'tty.write': { this.ttyWrites.push(Uint8Array.from(Buffer.from((args as { b64: string }).b64, 'base64'))); return {}; }
      case 'connect': return { state: 'idle', sync: 'prompt', portInfo: { ...FAKE_PORT_INFO, port: (args as { port: string }).port, requested: (args as { port: string }).port } };
      case 'identity': return this.identity;
      default: return this.boardFs?.handle(op, args);
    }
  }

  private async runCall(op: OpName, args: unknown, opts: CallOptions | undefined, rec: RecordedCall): Promise<unknown> {
    if (this.disposed) { throw BoardError.of('E_BRIDGE_EXITED', 'The connection helper has stopped.', { hint: 'Reload the window.' }, op); }
    const queue = this.gates.get(op);
    const gated = queue?.shift();
    if (gated) {
      gated.arrive(rec);
      await gated.done;
    }
    if (this.latencyMs > 0) { await new Promise((r) => setTimeout(r, this.latencyMs)); }
    if (this.requireConnection && !NO_LINK_OPS.includes(op) && this.current.state === 'disconnected') {
      throw BoardError.of('E_NOT_CONNECTED', 'No board is connected.', { hint: 'Select a serial port first.' }, op);
    }
    if (this.gateFileOps && GATED_OPS.includes(op) && this.current.state === 'running') {
      const a = args as { interrupt?: boolean; force?: boolean };
      if (a.interrupt !== true && a.force !== true) {
        throw BoardError.of('E_PROGRAM_RUNNING', 'A program is running on the board.', {
          needs_interrupt: true, sync: 'running-program', detail: 'repeat with interrupt:true',
          hint: 'A program is still running on the board. Press Stop first, or confirm that it may be interrupted.',
        }, op);
      }
      rec.interrupted = true;
      this.setState({ state: 'idle', reason: 'interrupted by file op' });
    }
    const ctx: CallContext = {
      session: this, signal: opts?.signal, emit: (e) => this.emit(e), setState: (p) => this.setState(p),
      fallthrough: async () => this.builtin(op, args),
    };
    const next = this.once.get(op)?.shift();
    const handler = next ?? this.persistent.get(op);
    const isRun = op === 'run';
    if (isRun) { this.setState({ state: 'running', reason: 'run' }); }
    try {
      if (handler) { return await handler(args, ctx); }
      const fallback = this.builtin(op, args);
      if (fallback === undefined) {
        throw BoardError.of('E_UNSUPPORTED', `FakeSession: no answer scripted for "${op}". Call session.script('${op}', ...) in the test.`, {}, op);
      }
      return fallback;
    } finally {
      if (isRun && this.current.state === 'running') { this.setState({ state: 'idle', reason: 'program ended' }); }
    }
  }

  private withLimits(work: Promise<unknown>, opts: CallOptions | undefined, rec: RecordedCall, op: OpName): Promise<unknown> {
    if (!opts?.signal && !opts?.timeoutMs) { return work; }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => { rec.aborted = true; reject(BoardError.of('E_ABORTED', 'The operation was cancelled.', {}, op)); };
      if (opts.signal?.aborted) { onAbort(); }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.timeoutMs) {
        timer = setTimeout(() => reject(BoardError.of('E_CALL_TIMEOUT', 'The board did not answer in time.', { hint: 'Check the cable and try again.' }, op)), opts.timeoutMs);
      }
      work.then(resolve, reject).finally(() => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); });
    });
  }
}

// ------------------------------------------------------------------ in-memory board filesystem

function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function fsError(errno: string, message: string, op: string): BoardError {
  return BoardError.of('E_FS_ERRNO', message, { detail: errno, hint: 'Check the path on the board and try again.' }, op);
}

export class FakeBoardFs {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(['/']);

  constructor(initial: Record<string, string | Uint8Array>) {
    for (const [p, c] of Object.entries(initial)) { this.write(p, typeof c === 'string' ? enc(c) : c); }
  }

  write(p: string, bytes: Uint8Array): void {
    this.mkdirs(path.posix.dirname(p));
    this.files.set(p, bytes);
  }

  read(p: string): string | undefined { const b = this.files.get(p); return b ? dec(b) : undefined; }
  readBytes(p: string): Uint8Array | undefined { return this.files.get(p); }
  paths(): string[] { return [...this.dirs.keys()].filter((d) => d !== '/').concat([...this.files.keys()]).sort(); }
  fileHash(p: string): string | undefined { const b = this.files.get(p); return b ? sha(b) : undefined; }

  private mkdirs(dir: string): void {
    let cur = '';
    for (const part of dir.split('/').filter(Boolean)) { cur += `/${part}`; this.dirs.add(cur); }
  }

  private children(dir: string): { name: string; type: 'file' | 'dir'; size: number }[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const out: { name: string; type: 'file' | 'dir'; size: number }[] = [];
    for (const d of this.dirs) { if (d !== dir && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) { out.push({ name: d.slice(prefix.length), type: 'dir', size: 0 }); } }
    for (const [f, b] of this.files) { if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) { out.push({ name: f.slice(prefix.length), type: 'file', size: b.length }); } }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The fs.* answers; undefined for ops this model does not handle. */
  handle(op: OpName, raw: unknown): unknown {
    const a = raw as Record<string, string | boolean | string[] | undefined>;
    switch (op) {
      case 'fs.list': {
        const p = a.path as string;
        if (!this.dirs.has(p)) { throw fsError('ENOENT', `The folder ${p} does not exist on the board.`, op); }
        return { entries: this.children(p) satisfies FsEntry[] };
      }
      case 'fs.stat': {
        const p = a.path as string;
        const f = this.files.get(p);
        return f ? { exists: true, type: 'file', size: f.length, mtime: 0 } : this.dirs.has(p) ? { exists: true, type: 'dir', size: 0, mtime: 0 } : { exists: false };
      }
      case 'fs.manifest': {
        const root = a.root as string;
        const prefix = root === '/' ? '/' : `${root}/`;
        const entries: ManifestEntry[] = [];
        for (const d of this.dirs) { if (d !== root && d.startsWith(prefix)) { entries.push({ path: d, type: 'dir', size: 0 }); } }
        for (const [f, b] of this.files) { if (f.startsWith(prefix)) { entries.push({ path: f, type: 'file', size: b.length, sha256: a.hash === false ? undefined : sha(b) }); } }
        return { entries: entries.sort((x, y) => x.path.localeCompare(y.path)), hash: a.hash === false ? 'none' : 'sha256', truncated: false, warnings: [] };
      }
      case 'fs.put': {
        const bytes = new Uint8Array(fs.readFileSync(a.local as string));
        const remote = a.remote as string;
        const h = sha(bytes);
        if (a.expectSha && this.fileHash(remote) === a.expectSha && a.expectSha === h) { return { bytes: bytes.length, sha256: h, skipped: true, sent: 0, verified: 'sha256' }; }
        if (typeof a.ifSha === 'string') {
          // fs.put ifSha (protocol Appendix E): same rule as bridge/devfs.py _check_precondition
          const cur = this.files.get(remote);
          const curSha = cur ? sha(cur) : null;
          if (curSha === h) { return { bytes: bytes.length, sha256: h, skipped: true, sent: 0, verified: 'sha256' }; }
          const ok = a.ifSha === 'absent' ? cur === undefined && !this.dirs.has(remote) : curSha === a.ifSha;
          if (!ok) {
            throw BoardError.of('E_DEST_CHANGED', `${remote} on the board changed since the last sync, so it was not replaced.`, {
              current: { exists: cur !== undefined || this.dirs.has(remote), type: cur ? 'file' : this.dirs.has(remote) ? 'dir' : null, size: cur?.length ?? 0, sha256: curSha },
            }, op);
          }
        }
        if (a.mkdirs === false && !this.dirs.has(path.posix.dirname(remote))) { throw fsError('ENOENT', 'The folder does not exist on the board.', op); }
        this.write(remote, bytes);
        return { bytes: bytes.length, sha256: h, skipped: false, sent: bytes.length, verified: 'sha256' };
      }
      case 'fs.get': {
        const b = this.files.get(a.remote as string);
        if (!b) { throw fsError('ENOENT', `The file ${String(a.remote)} does not exist on the board.`, op); }
        fs.mkdirSync(path.dirname(a.local as string), { recursive: true });
        fs.writeFileSync(a.local as string, b);
        return { bytes: b.length, sha256: sha(b), verified: 'sha256' };
      }
      case 'fs.rm': {
        if (!this.files.delete(a.path as string)) { throw fsError(this.dirs.has(a.path as string) ? 'EISDIR' : 'ENOENT', 'Could not delete that file on the board.', op); }
        return {};
      }
      case 'fs.rmtree': {
        const p = a.path as string;
        if (a.confirm !== true) { throw BoardError.of('E_PROTOCOL', 'Deleting a folder needs confirmation.', {}, op); }
        if (!this.dirs.has(p) && !this.files.has(p)) { throw fsError('ENOENT', 'That folder does not exist on the board.', op); }
        let removed = 0;
        for (const f of [...this.files.keys()]) { if (f === p || f.startsWith(`${p}/`)) { this.files.delete(f); removed++; } }
        for (const d of [...this.dirs]) { if (d === p || d.startsWith(`${p}/`)) { this.dirs.delete(d); removed++; } }
        return { removed };
      }
      case 'fs.mkdir': {
        const before = this.dirs.size;
        this.mkdirs(a.path as string);
        return { created: this.dirs.size - before };
      }
      case 'fs.mv': {
        const src = a.src as string;
        const dst = a.dst as string;
        if (this.files.has(dst) || this.dirs.has(dst)) { throw fsError('EEXIST', 'Something with that name already exists on the board.', op); }
        const b = this.files.get(src);
        if (!b) { throw fsError('ENOENT', 'Nothing with that name exists on the board.', op); }
        this.files.delete(src);
        this.write(dst, b);
        return {};
      }
      default: return undefined;
    }
  }
}
