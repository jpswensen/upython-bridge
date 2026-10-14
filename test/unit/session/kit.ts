/**
 * Test kit for the session: a scripted `Bridge` that behaves like the real one at the level the session sees (state events
 * before the connect answer, errors with codes), and a recording `SessionUi`.
 */
import type { Bridge, BridgeEvent, BridgeExitInfo, BridgeStatus, PendingCall } from '../../../src/bridge/types';
import type { BoardState, HelloEvent, OpArgs, OpName, OpResult, PortRow } from '../../../src/types/protocol';
import { BoardError, type CallOptions, type Disposable } from '../../../src/types/session';
import { MockMemento } from '../../mocks/extensionContext';
import { FAKE_IDENTITY, FAKE_PORT_INFO } from '../../mocks/fakeSession';
import { LearnedResetStore } from '../../../src/session/learnedReset';
import { BridgeBoardSession, type SessionDeps, type SessionUi } from '../../../src/session/session';
import { PortMemory } from '../../../src/types/settings';
import { MemoryLog, HELLO } from '../bridge/stubChild';

export const CP210X = { vid: 0x10c4, pid: 0xea60 };

export function port(device: string, vid: number | null = CP210X.vid, pid: number | null = CP210X.pid, likely = true): PortRow {
  return { device, vid, pid, serial: '0001', manufacturer: 'Silicon Labs', product: 'CP2102', description: 'CP2102 USB to UART', hwid: 'USB VID:PID', likelyBoard: likely };
}

type Handler = (args: Record<string, unknown>, bridge: ScriptedBridge) => unknown;

export class ScriptedBridge implements Bridge {
  status: BridgeStatus = 'stopped';
  hello: HelloEvent | null = null;
  readonly sent: { id: number; op: string; args: Record<string, unknown>; opts: CallOptions | undefined }[] = [];
  ports: PortRow[] = [port('/dev/cu.usbserial-0001')];
  /** What `connect` finds: state idle or running. */
  connectState: 'idle' | 'running' = 'idle';
  startError: BoardError | undefined;
  startCount = 0;
  stopCount = 0;
  disposed = 0;
  budgetResets = 0;
  private id = 0;
  private readonly events = new Set<(e: BridgeEvent) => unknown>();
  private readonly statusL = new Set<(s: BridgeStatus, i?: BridgeExitInfo) => unknown>();
  private readonly handlers = new Map<string, Handler>();
  private readonly onceHandlers = new Map<string, Handler[]>();
  /** Ops held until released (key: op). */
  private readonly holds = new Map<string, Promise<void>>();

  constructor() {
    this.handlers.set('ping', () => ({}));
    this.handlers.set('config', () => ({}));
    this.handlers.set('ports.list', () => ({ ports: this.ports }));
    this.handlers.set('connect', (a, b) => {
      const target = String(a.port);
      b.state('connecting', 'disconnected', undefined, target);
      b.state(b.connectState, 'connecting', b.connectState === 'idle' ? 'prompt seen' : 'running-program', target);
      return { state: b.connectState, sync: b.connectState === 'idle' ? 'prompt' : 'running-program', portInfo: { ...FAKE_PORT_INFO, port: target, requested: target, vid: (a.vid as number | undefined) ?? null, pid: (a.pid as number | undefined) ?? null } };
    });
    this.handlers.set('disconnect', (_a, b) => { b.state('disconnected', 'idle', 'disconnect'); return {}; });
    this.handlers.set('identity', () => FAKE_IDENTITY);
    this.handlers.set('stop', () => ({ stopped: true, ms: 5 }));
  }

  on(op: string, handler: Handler): this { this.handlers.set(op, handler); return this; }
  once(op: string, handler: Handler): this { this.onceHandlers.set(op, [...(this.onceHandlers.get(op) ?? []), handler]); return this; }
  hold(op: string): () => void {
    let release!: () => void;
    this.holds.set(op, new Promise<void>((r) => { release = r; }));
    return release;
  }
  callsOf(op: string): ScriptedBridge['sent'] { return this.sent.filter((s) => s.op === op); }

  state(state: BoardState, prev: BoardState, reason?: string, port?: string): void {
    this.emit({ ev: 'state', state, prev, ...(reason ? { reason } : {}), ...(port ? { port } : {}) });
  }
  emit(ev: BridgeEvent): void { for (const l of [...this.events]) { l(ev); } }
  setStatus(s: BridgeStatus, info?: BridgeExitInfo): void { this.status = s; for (const l of [...this.statusL]) { l(s, info); } }
  crash(): void { this.hello = null; this.setStatus('exited', { code: 1, signal: null, expected: false, stderrTail: ['[error] boom'] }); }

  async start(): Promise<HelloEvent> {
    this.startCount += 1;
    if (this.status === 'ready' && this.hello) { return this.hello; }
    this.setStatus('starting');
    if (this.startError) { this.setStatus('stopped'); throw this.startError; }
    this.hello = HELLO as unknown as HelloEvent;
    this.setStatus('ready');
    return this.hello;
  }

  send<K extends OpName>(op: K, args: OpArgs<K>, opts?: CallOptions): PendingCall<OpResult<K>> {
    const id = ++this.id;
    const a = args as Record<string, unknown>;
    this.sent.push({ id, op, args: a, opts });
    const result = (async (): Promise<OpResult<K>> => {
      if (this.disposed > 0) { throw BoardError.of('E_BRIDGE_EXITED', 'stopped', {}, op); }
      await this.start();
      const held = this.holds.get(op);
      if (held) { await held; }
      const h = this.onceHandlers.get(op)?.shift() ?? this.handlers.get(op);
      if (!h) { throw BoardError.of('E_UNSUPPORTED', `ScriptedBridge: nothing scripted for ${op}`, {}, op); }
      const r = h(a, this);
      if (r instanceof BoardError) { throw r; }
      return r as OpResult<K>;
    })();
    return { id, result };
  }

  onEvent(l: (e: BridgeEvent) => unknown): Disposable { this.events.add(l); return { dispose: () => { this.events.delete(l); } }; }
  onStatus(l: (s: BridgeStatus, i?: BridgeExitInfo) => unknown): Disposable { this.statusL.add(l); return { dispose: () => { this.statusL.delete(l); } }; }
  resetRestartBudget(): void { this.budgetResets += 1; }
  async stopProcess(): Promise<void> { this.stopCount += 1; this.hello = null; this.setStatus('stopped'); }
  async close(): Promise<void> { this.disposed += 1; }
  dispose(): void { this.disposed += 1; }
}

export class StubUi implements SessionUi {
  readonly warns: { message: string; actions: string[] }[] = [];
  readonly infos: string[] = [];
  readonly progress: { title: string; reports: { message: string; fraction?: number }[]; done: boolean }[] = [];
  interruptAnswer = true;
  mountAnswer = true;
  warnAnswer: string | undefined;
  readonly interruptAsked: string[] = [];
  readonly mountAsked: string[] = [];

  async confirmInterrupt(op: OpName): Promise<boolean> { this.interruptAsked.push(op); return this.interruptAnswer; }
  async confirmAllowMount(path: string): Promise<boolean> { this.mountAsked.push(path); return this.mountAnswer; }
  async warn(message: string, ...actions: string[]): Promise<string | undefined> { this.warns.push({ message, actions }); return this.warnAnswer; }
  info(message: string): void { this.infos.push(message); }
  withProgress<T>(title: string, task: (report: (message: string, fraction?: number) => void) => Promise<T>): Promise<T> {
    const entry = { title, reports: [] as { message: string; fraction?: number }[], done: false };
    this.progress.push(entry);
    return task((message, fraction) => entry.reports.push({ message, fraction })).finally(() => { entry.done = true; });
  }
}

export const SETTINGS = {
  autoSync: 'ask', syncDebounceMs: 400, rootPath: '/', pythonPath: '', portOverride: '', runFreshStart: true, showUnverifiedHardReset: false,
  stopOnDisconnect: true, stopOnTerminalClose: true, boardClockOnConnect: 'whenUnset', intellisenseStubs: 'auto', intellisenseOffer: true, logLevel: 'debug',
} as const;

export function makeSession(over: Partial<SessionDeps> & { bridge?: ScriptedBridge; ui?: StubUi } = {}) {
  const bridge = over.bridge ?? new ScriptedBridge();
  const ui = over.ui ?? new StubUi();
  const log = new MemoryLog();
  const workspaceState = new MockMemento();
  const globalState = new MockMemento();
  const portMemory = new PortMemory(workspaceState);
  const learned = new LearnedResetStore(globalState);
  const session = new BridgeBoardSession({
    log: log.logger, settings: SETTINGS, bridge, ui, learned, portMemory, sleep: async () => undefined,
    ...over,
  });
  return { session, bridge, ui, log, workspaceState, globalState, portMemory, learned };
}

export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) { await new Promise((r) => setTimeout(r, 1)); }
}
