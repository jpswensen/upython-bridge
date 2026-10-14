/**
 * The narrow interface between the session and "whatever talks to the board" (R-ARCH-8). The Python bridge client
 * (client.ts) is the only implementation today; a Node serial implementation could replace it without touching views.
 * No `vscode` import.
 */
import type { HelloEvent, OpArgs, OpName, OpResult } from '../types/protocol';
import { BoardError, type CallOptions, type Disposable, type SessionEvent } from '../types/session';

/** The typed error of this layer: a protocol error body (or one made by the client) as a real Error. */
export { BoardError as BridgeError };

/** `stopped`: no process (never started, or stopped on purpose); `starting`; `ready`: hello received and checked; `exited`: crashed. */
export type BridgeStatus = 'stopped' | 'starting' | 'ready' | 'exited';

/** Decoded bridge events are exactly the session's events (bytes already decoded, no base64 downstream). */
export type BridgeEvent = SessionEvent;

export interface BridgeExitInfo {
  code: number | null;
  signal: string | null;
  /** true when we asked it to stop (dispose, stopProcess), false for a crash. */
  expected: boolean;
  /** The last stderr lines of the process, for the log and the Doctor. */
  stderrTail: readonly string[];
}

export interface PendingCall<T> {
  /** Request id on the wire: `progress` events and `cancel` refer to it. Known before the request is written. */
  readonly id: number;
  readonly result: Promise<T>;
}

export interface Bridge {
  readonly status: BridgeStatus;
  /** The hello of the running process; null while none is running. */
  readonly hello: HelloEvent | null;
  /** Start the process if needed and wait for a valid hello. Rejects with BridgeError. */
  start(): Promise<HelloEvent>;
  /** Send a request (starting the process first when needed). Never throws; the promise rejects with BridgeError. */
  send<K extends OpName>(op: K, args: OpArgs<K>, opts?: CallOptions): PendingCall<OpResult<K>>;
  onEvent(listener: (ev: BridgeEvent) => unknown): Disposable;
  onStatus(listener: (status: BridgeStatus, info?: BridgeExitInfo) => unknown): Disposable;
  /** Forget earlier crashes so the next start is allowed again (the Doctor and Retry use it). */
  resetRestartBudget?(): void;
  /** Stop the process (stdin EOF, grace period, then kill the tree) but allow starting it again later. */
  stopProcess(): Promise<void>;
  /** Stop for good. Idempotent. */
  close(): Promise<void>;
  dispose(): void;
}
