/**
 * Typed mirror of docs/protocol.md (v1 + Appendices A, B, C) and docs/protocol-addendum-reset.md.
 * Wire shapes only: no behaviour. When the protocol changes, change protocol.md first, then this file.
 * Device paths are POSIX and absolute; `local` paths are absolute host paths (backslashes are fine on Windows).
 */

export const PROTOCOL_VERSION = 1;

export const BOARD_STATES = ['disconnected', 'connecting', 'idle', 'running', 'rawop'] as const;
export type BoardState = (typeof BOARD_STATES)[number];

/** Codes the bridge sends (section 3, Appendix A.3, reset addendum). */
export const BRIDGE_ERROR_CODES = [
  'E_PORT_BUSY', 'E_NO_DEVICE', 'E_PERMISSION', 'E_NOT_CONNECTED', 'E_ALREADY_CONNECTED', 'E_RAW_REPL_TIMEOUT',
  'E_PROGRAM_RUNNING', 'E_BOARD_RESET', 'E_BOARD_UNRESPONSIVE', 'E_FS_ERRNO', 'E_LOCAL_IO', 'E_SHADOWS_MODULE',
  'E_UNSUPPORTED', 'E_CANCELLED', 'E_PROTOCOL', 'E_SAFE_MODE', 'E_INTERNAL', 'E_RESET_NOT_OBSERVED', 'E_DEST_CHANGED',
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

/** Codes made by the client (never on the wire): the bridge could not be asked, or did not answer. */
export const CLIENT_ERROR_CODES = ['E_CALL_TIMEOUT', 'E_BRIDGE_EXITED', 'E_ABORTED', 'E_NO_PYTHON'] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export type ErrorCode = BridgeErrorCode | ClientErrorCode;

/** How `connect`/`E_PROGRAM_RUNNING` describe what the bridge found (Appendix B, C). */
export type SyncVerdict = 'prompt' | 'running-program' | 'silent' | 'prompt-unverified' | 'run' | 'unconfirmed';

export type MountReason = 'dev' | 'root' | 'vfs' | 'cwd';

/** `error` object of a failed response. The optional fields are machine-readable; never parse `message`. */
export interface BridgeErrorBody {
  code: ErrorCode;
  /** English, user-readable. */
  message: string;
  /** Raw cause (errno name, traceback for E_INTERNAL, ...). */
  detail: string;
  /** What to do next. */
  hint: string;
  /** Gated E_PROGRAM_RUNNING: ask the user, then repeat the op with `interrupt: true`. */
  needs_interrupt?: boolean;
  sync?: SyncVerdict;
  /** fs.rmtree refused a mount point: ask, then repeat with `allowMount: true`. */
  needs_allow_mount?: boolean;
  mount_reason?: MountReason;
  /** tty.write refused whole: 0 bytes accepted. */
  accepted?: number;
  /** Failed upload could not remove its temp file; `clean_orphans` removes it next session. */
  cleanup?: 'deferred';
  tmp_path?: string;
  /** E_RESET_NOT_OBSERVED (bridge/server.py _ERR_EXTRAS): what an explicit hard-reset verification taught us. */
  learned?: 'verified' | 'failed';
  cache_key?: ResetCacheKey;
  evidence?: string[];
  /** E_DEST_CHANGED (fs.put ifSha, protocol Appendix E): what the board holds now instead of what the precondition expected. */
  current?: { exists: boolean; type: 'file' | 'dir' | null; size: number; sha256: string | null };
}

// ---------------------------------------------------------------- events (no id)

export interface HelloEvent {
  ev: 'hello'; proto: number; bridge: string; python: string; pyserial: string;
  platform: 'darwin' | 'win32' | 'linux' | string; pid: number; vendored: { mpremote: string | null };
}
/** `error` is the error code that caused the transition, when there was one (server.py _set_state(..., error=err.code)). */
export interface StateEvent { ev: 'state'; state: BoardState; prev: BoardState; reason?: string; port?: string; error?: ErrorCode }
/** Bytes events carry base64 on the wire. */
export interface BytesEvent { ev: 'repl' | 'out' | 'err'; b64: string }
export interface ProgressEvent { ev: 'progress'; id: number | string; label: string; done: number; total: number }
export interface LogEvent { ev: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
export interface FatalEvent { ev: 'fatal'; message: string }
export type WireEvent = HelloEvent | StateEvent | BytesEvent | ProgressEvent | LogEvent | FatalEvent;

// ---------------------------------------------------------------- shared result shapes

export interface PortRow {
  device: string; vid: number | null; pid: number | null; serial: string; manufacturer: string; product: string;
  description: string; hwid: string; likelyBoard: boolean;
}
export type OpenPolicy = 'auto' | 'default' | 'win-cp210x' | 'pty' | 'url';
export interface ConnectPortInfo {
  port: string; requested: string; baud: number; kind: 'device' | 'pty' | 'url'; policy: string; platform: string;
  pyserial: string; vid: number | null; pid: number | null; adapter: string; exclusive: boolean; canHardReset: boolean | null;
}
export interface BoardIdentity {
  impl: string; version: [number, number, number]; machine: string; build: string; mpy: number | null; platform: string;
  uname: { sysname: string; nodename: string; release: string; version: string; machine: string };
  /** Hex of machine.unique_id(); empty string when the board has none. Key of the sync baseline (D-06). */
  uniqueId: string;
  syspath: string[]; root: string[];
  caps: { hash: 'sha256' | 'none'; compile: boolean; paste: boolean | null; mem: number };
  profileHints: { modules: string[]; frozen: boolean; fsTotal: number; fsFree: number };
}
export interface FsEntry { name: string; type: 'file' | 'dir'; size: number }
export interface ManifestEntry { path: string; type: 'file' | 'dir'; size: number; sha256?: string; statError?: boolean }
export interface HardResetCapability {
  state: 'verified' | 'likely' | 'unknown' | 'unlikely' | 'failed';
  method: 'rts-pulse' | 'usb-jtag' | 'none';
  reason: string;
  basis: 'learned' | 'adapter' | 'transport';
}
/** What the client caches a hard-reset verification under (RQ-RESET-4): null parts are unknown. */
export interface ResetCacheKey { vid: number | null; pid: number | null; uniqueId: string | null }
export interface ResetCapability {
  soft: true;
  machine: { available: boolean; reason: string };
  /** null when the link cannot say (test doubles). */
  hard: HardResetCapability | null;
  cacheKey: ResetCacheKey;
}
export type LearnedReset = 'verified' | 'failed' | null;

/** Kinds `introspect.modules` reports (bridge/devfs.py _KIND_NAMES). */
export type IntrospectKind = 'function' | 'class' | 'module' | 'property' | 'int' | 'float' | 'str' | 'bool' | 'bytes' | 'None' | 'object';
/** One imported module as seen from the board (names and constant values only: MicroPython keeps no parameter names). */
export interface IntrospectedModule {
  attrs: string[];
  kinds?: Record<string, IntrospectKind | string>;
  consts?: Record<string, unknown>;
  /** Classes of the module: members from dir(cls); a property is reported, never called. */
  classes?: Record<string, { members: string[]; kinds?: Record<string, IntrospectKind | string> }>;
  file?: string;
  error?: string;
}
/** `clock.read` / `clock.set` (D-22). `plausible`: year >= 2024 (an unset ESP32 clock starts in 2000). */
export interface BoardClock {
  rtc: boolean;
  time: [number, number, number, number, number, number, number];
  plausible: boolean;
}

// ---------------------------------------------------------------- operations

/** Set on ops the bridge gates behind an idle board (file ops, identity, exec, introspect). */
export interface Gated { interrupt?: boolean; force?: boolean; background?: boolean }

export type RunArgs = { name?: string; reset?: boolean; stdin?: boolean; interrupt?: boolean } & ({ local: string } | { source: string });

/** op name -> { args, result }. The single table `call()` is typed from. */
export interface OpMap {
  'ping': { args: Record<string, never>; result: Record<string, never> };
  'ports.list': { args: Record<string, never>; result: { ports: PortRow[] } };
  'connect': {
    args: { port: string; baud?: number; openPolicy?: OpenPolicy; vid?: number; pid?: number };
    result: { state: 'idle' | 'running' | 'unknown'; sync: SyncVerdict; portInfo: ConnectPortInfo };
  };
  'disconnect': { args: { stopFirst?: boolean }; result: Record<string, never> };
  'identity': { args: Gated; result: BoardIdentity };
  'fs.list': { args: { path: string } & Gated; result: { entries: FsEntry[] } };
  'fs.manifest': {
    args: { root: string; hash?: boolean; exclude?: string[] } & Gated;
    result: { entries: ManifestEntry[]; hash: 'sha256' | 'none'; truncated: boolean; warnings: { path: string; errno: string }[] };
  };
  'fs.stat': { args: { path: string } & Gated; result: { exists: boolean; type?: 'file' | 'dir'; size?: number; mtime?: number } };
  'fs.put': {
    /** `ifSha`: compare-and-swap on the board's current copy (a hex sha256, or 'absent'); not met = E_DEST_CHANGED (Appendix E). */
    args: { local: string; remote: string; mkdirs?: boolean; expectSha?: string; ifSha?: string; chunk?: number } & Gated;
    result: { bytes: number; sha256: string; skipped: boolean; sent: number; verified: 'sha256' | 'size' };
  };
  'fs.get': { args: { remote: string; local: string } & Gated; result: { bytes: number; sha256: string; verified: 'sha256' | 'size' } };
  'fs.rm': { args: { path: string } & Gated; result: Record<string, never> };
  'fs.rmtree': { args: { path: string; confirm: true; allowMount?: boolean } & Gated; result: { removed: number } };
  'fs.mkdir': { args: { path: string; parents?: boolean } & Gated; result: { created: number } };
  'fs.mv': { args: { src: string; dst: string } & Gated; result: Record<string, never> };
  'run': { args: RunArgs; result: { exit: 'ok' | 'exception' | 'interrupted' | 'disconnected'; durationMs: number } };
  'stop': { args: { timeoutMs?: number }; result: { stopped: boolean; ms: number } };
  /** skipMain: Ctrl-D in the raw REPL, so boot.py runs but main.py does not start (default: at the friendly prompt, both run). */
  'reset.soft': { args: { skipMain?: boolean }; result: Record<string, never> };
  /** Reset tiers (addendum, D-16). Shapes follow bridge/server.py; protocol.md Appendix D is still to be written by the bridge side. */
  'reset.capability': { args: { learned?: LearnedReset }; result: ResetCapability };
  'reset.machine': {
    args: { confirmed: true } & Gated;
    /** `portDropped`/`reconnect`: native-USB boards re-enumerate; the CLIENT reconnects (bounded). */
    result: { phase: 'sent'; portDropped: boolean; reconnect: boolean; sync?: SyncVerdict };
  };
  'reset.hard': {
    args: { confirmed: true; verify?: boolean; method?: 'rts-pulse' | 'usb-jtag' | 'none'; force?: boolean; learned?: LearnedReset };
    /** With `verify`, `learned` and `cacheKey` say what to cache; E_RESET_NOT_OBSERVED means nothing was seen. */
    result: {
      verified: boolean | null; evidence: string[]; method?: string; learned?: 'verified' | 'failed'; cacheKey?: ResetCacheKey;
      unsafeSequence?: boolean; portDropped?: boolean; reconnect?: boolean; hint?: string;
    };
  };
  'repl.attach': { args: Record<string, never>; result: Record<string, never> };
  'repl.detach': { args: Record<string, never>; result: Record<string, never> };
  'tty.write': { args: { b64: string }; result: Record<string, never> };
  'introspect.modules': {
    args: { names?: string[] } & Gated;
    result: { modules: Record<string, IntrospectedModule>; listing: string[] };
  };
  /** D-22: the board clock. `time` = [year, month, day, hour, minute, second, weekday (0 = Monday)]. */
  'clock.read': { args: Gated; result: BoardClock };
  'clock.set': { args: { time: [number, number, number, number, number, number, number] } & Gated; result: BoardClock };
  'exec': {
    args: { code: string; timeoutMs?: number } & Gated;
    result: { out: string; err: string; truncated?: boolean; outBytes?: number; errBytes?: number };
  };
  'config': { args: { shadowGuard?: string[]; idleListenMs?: number; stopOnDisconnect?: boolean }; result: Record<string, never> };
  'cancel': { args: { target: number | string }; result: { cancelled: boolean } };
  'shutdown': { args: Record<string, never>; result: Record<string, never> };
}

export type OpName = keyof OpMap;
export type OpArgs<K extends OpName> = OpMap[K]['args'];
export type OpResult<K extends OpName> = OpMap[K]['result'];

export const OP_NAMES: readonly OpName[] = [
  'ping', 'ports.list', 'connect', 'disconnect', 'identity', 'fs.list', 'fs.manifest', 'fs.stat', 'fs.put', 'fs.get',
  'fs.rm', 'fs.rmtree', 'fs.mkdir', 'fs.mv', 'run', 'stop', 'reset.soft', 'reset.capability', 'reset.machine',
  'reset.hard', 'repl.attach', 'repl.detach', 'tty.write', 'introspect.modules', 'exec', 'config', 'cancel', 'shutdown',
  'clock.read', 'clock.set',
];

/** Ops that bypass the bridge queue (section 6); they stay usable while a program runs. */
export const BYPASS_OPS: readonly OpName[] = ['ping', 'stop', 'tty.write', 'cancel', 'shutdown'];

// ---------------------------------------------------------------- framing

export interface WireRequest { id: number; op: OpName; [arg: string]: unknown }
export type WireResponse =
  | ({ id: number; ok: true } & Record<string, unknown>)
  | { id: number; ok: false; error: BridgeErrorBody };
