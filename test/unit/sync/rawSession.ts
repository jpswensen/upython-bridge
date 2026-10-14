/**
 * A minimal BoardSession over the Node test client of the REAL Python bridge (test/mocks/fakeBridge.ts RawBridge), so the sync
 * code can be exercised against the real bridge and a fake board. It is not the product session (that is src/session, owned by
 * the client agent): no reconnect, no events, no state machine beyond what sync reads. Never connects to anything but the fake
 * board URL it is given. Not a test file.
 */
import type { OpArgs, OpName, OpResult } from '../../../src/types/protocol';
import {
  BoardError, initialSessionState, type BoardSession, type CallOptions, type ConnectOptions, type Disposable, type SessionEvent, type SessionState,
} from '../../../src/types/session';
import { RawBridgeError, type RawBridge } from '../../mocks/fakeBridge';

export class RawBridgeSession implements BoardSession {
  private current: SessionState = { ...initialSessionState(), bridge: 'ready', interpreter: 'ok' };
  private readonly listeners = new Set<(s: SessionState) => unknown>();
  private selected: string | null = null;
  readonly calls: { op: string; args: unknown }[] = [];

  constructor(private readonly bridge: RawBridge) {}

  get state(): SessionState { return this.current; }
  readonly onDidChangeState = (l: (s: SessionState) => unknown): Disposable => {
    this.listeners.add(l);
    return { dispose: () => { this.listeners.delete(l); } };
  };
  onEvent(_listener: (ev: SessionEvent) => unknown): Disposable { return { dispose: () => undefined }; }
  get selectedPort(): string | null { return this.selected; }
  get isRunning(): boolean { return this.current.state === 'running'; }
  get pendingSyncCount(): number { return this.current.pendingSyncCount; }
  setPendingSyncCount(count: number): void { this.set({ pendingSyncCount: count }); }
  selectPort(port: string | null): void { this.selected = port; this.set({}); }
  dispose(): void { this.listeners.clear(); }

  private set(patch: Partial<SessionState>): void {
    this.current = { ...this.current, ...patch };
    for (const l of [...this.listeners]) { l(this.current); }
  }

  async call<K extends OpName>(op: K, args: OpArgs<K>, opts?: CallOptions): Promise<OpResult<K>> {
    this.calls.push({ op, args });
    try {
      return await this.bridge.call(op, args, opts?.timeoutMs ?? 60000);
    } catch (err) {
      if (err instanceof RawBridgeError) { throw new BoardError(err.error, op); }
      throw err;
    }
  }

  async connect(port: string, _opts?: ConnectOptions): Promise<OpResult<'connect'>> {
    this.selected = port;
    const r = await this.call('connect', { port });
    this.set({ state: r.state === 'idle' ? 'idle' : 'running', port, portInfo: r.portInfo, sync: r.sync });
    const identity = await this.call('identity', { interrupt: true });
    this.set({ identity, state: 'idle' });
    return r;
  }

  async disconnect(opts: { stopFirst?: boolean } = {}): Promise<void> {
    await this.call('disconnect', opts);
    this.set({ state: 'disconnected', port: null, portInfo: null, identity: null });
  }
}
