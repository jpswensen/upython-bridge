/**
 * `BoardSession`: the ONE interface every other module (views, commands, REPL, sync, Doctor, status bar) uses to reach
 * the board, and that every test fakes (test/mocks/fakeSession.ts). The real implementation (src/session) wraps the
 * bridge client; it is the only code that knows the bridge exists. See docs/extension-design.md for the contract in prose.
 *
 * No `vscode` import: the Event/Disposable shapes below are structurally compatible with vscode's.
 */
import type {
  BoardIdentity, BoardState, BridgeErrorBody, ConnectPortInfo, ErrorCode, HelloEvent, LogEvent, OpArgs, OpName, OpResult,
  ProgressEvent, SyncVerdict,
} from './protocol';

export interface Disposable { dispose(): unknown }
export type Event<T> = (listener: (e: T) => unknown) => Disposable;

/** Error thrown by `call`/`connect`: a bridge error body (or a client-made one) as a real Error. */
export class BoardError extends Error {
  readonly body: BridgeErrorBody;
  readonly op: string | undefined;

  constructor(body: BridgeErrorBody, op?: string) {
    super(body.message);
    this.name = 'BoardError';
    this.body = body;
    this.op = op;
  }

  get code(): ErrorCode { return this.body.code; }
  get hint(): string { return this.body.hint; }
  get detail(): string { return this.body.detail; }
  /** The user may be asked, then the op repeated with `interrupt: true`. */
  get needsInterrupt(): boolean { return this.body.needs_interrupt === true; }
  /** The user may be asked, then fs.rmtree repeated with `allowMount: true`. */
  get needsAllowMount(): boolean { return this.body.needs_allow_mount === true; }

  static of(code: ErrorCode, message: string, extra: Partial<BridgeErrorBody> = {}, op?: string): BoardError {
    return new BoardError({ code, message, detail: '', hint: '', ...extra }, op);
  }
}

export function isBoardError(err: unknown, code?: ErrorCode): err is BoardError {
  return err instanceof BoardError && (code === undefined || err.code === code);
}

/** The text to show a student for any thrown value: the message plus, for board errors, what to do next. */
export function userMessage(err: unknown): string {
  if (err instanceof BoardError) {
    return err.hint !== '' && err.hint !== err.message ? `${err.message} ${err.hint}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** What the session knows right now. Replaced (never mutated) on every change. */
export interface SessionState {
  /** Bridge process: `stopped` until first use (lazy spawn), `ready` after `hello`, `exited` after a crash. */
  bridge: 'stopped' | 'starting' | 'ready' | 'exited';
  /** Result of Python discovery: `unknown` until the bridge was first needed, `problem` when no working interpreter was found. */
  interpreter: 'unknown' | 'ok' | 'problem';
  /** Board state from the bridge state machine (protocol.md section 5). */
  state: BoardState;
  /** Why the last transition happened (`prompt seen`, `unplugged`, `board-reset`, ...). */
  reason: string;
  /** Port the bridge is connected to (or connecting to); null when disconnected. */
  port: string | null;
  portInfo: ConnectPortInfo | null;
  /** What `connect` found; null when disconnected. */
  sync: SyncVerdict | null;
  /** Result of the identity probe; null until it has run, cleared on disconnect. */
  identity: BoardIdentity | null;
  /** Files the auto-sync has not uploaded yet (set by the sync module through `setPendingSyncCount`). */
  pendingSyncCount: number;
}

/** Events as the session delivers them: byte payloads are decoded once, here (no base64 downstream). */
export type SessionEvent =
  | { ev: 'state'; state: BoardState; prev: BoardState; reason?: string; port?: string }
  | { ev: 'repl' | 'out' | 'err'; bytes: Uint8Array }
  | ({ ev: 'progress' } & Omit<ProgressEvent, 'ev'>)
  | ({ ev: 'log' } & Omit<LogEvent, 'ev'>)
  | ({ ev: 'hello' } & Omit<HelloEvent, 'ev'>)
  | { ev: 'fatal'; message: string };

export interface CallOptions {
  /** Client-side limit; on expiry the call rejects with E_CALL_TIMEOUT and the bridge op is cancelled when possible. */
  timeoutMs?: number;
  /** Aborting rejects with E_ABORTED and sends `cancel` for a queued/running op. */
  signal?: AbortSignal;
}

export interface ConnectOptions { baud?: number; vid?: number; pid?: number }

export interface BoardSession {
  /** Current state; read it, listen with `onDidChangeState`. */
  readonly state: SessionState;
  readonly onDidChangeState: Event<SessionState>;

  /** Bridge events (repl/out/err/state/progress/log), in arrival order. */
  onEvent(listener: (ev: SessionEvent) => unknown): Disposable;

  /** Typed bridge call. Rejects with BoardError (bridge error or client error); never resolves with `ok:false`. */
  call<K extends OpName>(op: K, args: OpArgs<K>, opts?: CallOptions): Promise<OpResult<K>>;

  /** Remember `port` as selected, then connect. Never accepts "auto" (D-11). Does not reset the board. */
  connect(port: string, opts?: ConnectOptions): Promise<OpResult<'connect'>>;
  /** Close the port. During a Run pass `stopFirst` explicitly (protocol Appendix C). */
  disconnect(opts?: { stopFirst?: boolean }): Promise<void>;

  /** The port the user chose for this window (may be set while disconnected, e.g. after a failed connect). */
  readonly selectedPort: string | null;
  /** Choose (or forget, with null) a port without connecting. Fires `onDidChangeState`. */
  selectPort(port: string | null): void;

  /** True while the board state is `running` or a Run is in flight. */
  readonly isRunning: boolean;

  /** Hook for the sync module: shown by the status bar and Sync view; fires `onDidChangeState`. */
  readonly pendingSyncCount: number;
  setPendingSyncCount(count: number): void;

  /** Stop the bridge (shutdown op / stdin EOF) and release listeners. Idempotent. */
  dispose(): void;
}

export function initialSessionState(): SessionState {
  return {
    bridge: 'stopped', interpreter: 'unknown', state: 'disconnected', reason: '', port: null, portInfo: null, sync: null, identity: null,
    pendingSyncCount: 0,
  };
}
