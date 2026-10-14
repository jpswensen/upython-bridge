/**
 * The concrete BoardSession: owns the bridge client (through the narrow `Bridge` interface), mirrors the bridge's state
 * machine into an immutable `SessionState`, remembers the chosen port as (name, VID, PID), probes the board identity once the
 * prompt is confirmed, reconnects in a bounded way after an unplug or a reset, learns which boards can be reset with the control
 * lines, and routes progress events to a progress notification.
 *
 * Rules kept here: connect, disconnect, refresh and reconnect never reset the board; "auto" is never sent anywhere; the bridge
 * (and so Python) starts lazily on the first real need; every failure is a BoardError the caller can show with `userMessage`.
 * No `vscode` import: the user interface comes in through `SessionUi`.
 */
import type { Bridge, BridgeExitInfo, BridgeStatus } from '../bridge/types';
import type { Logger } from '../log';
import type {
  BoardIdentity, ConnectPortInfo, HelloEvent, OpArgs, OpName, OpResult, PortRow, ResetCacheKey, ResetCapability,
} from '../types/protocol';
import {
  BoardError, initialSessionState, isBoardError, type BoardSession, type CallOptions, type ConnectOptions, type Disposable, type SessionEvent,
  type SessionState,
} from '../types/session';
import type { MpySettings, PortMemory, RememberedPort, SettingsReader } from '../types/settings';
import { withConsent, type ConsentPrompter } from './consent';
import type { LearnedResetStore } from './learnedReset';
import { chooseAutoPort, isAutoPort, isUrlPort, matchRememberedPort, type AutoPortChoice } from './ports';
import { ProgressRouter, type ProgressUi } from './progress';

/** The window the session needs for its own questions and messages. */
export interface SessionUi extends ProgressUi, ConsentPrompter {
  /** A non-blocking warning with optional buttons; resolves with the button pressed (or undefined). */
  warn(message: string, ...actions: string[]): Promise<string | undefined>;
  info(message: string): void;
}

export interface InterpreterCheck {
  ok: boolean;
  message: string;
}

export interface ReconnectPolicy {
  /** Pause before each attempt; the last value repeats. */
  delaysMs: readonly number[];
  maxAttempts: number;
}

export interface SessionDeps {
  log: Logger;
  settings: SettingsReader | MpySettings;
  bridge: Bridge;
  ui: SessionUi;
  learned: LearnedResetStore;
  /** Remembered (port, VID, PID) of this workspace. Written only after a successful connect. */
  portMemory?: Pick<PortMemory, 'get' | 'remember' | 'forget'>;
  /** Looks for a working Python without starting the bridge; sets `state.interpreter`. */
  checkInterpreter?: () => Promise<InterpreterCheck>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  reconnect?: { afterUnplug?: Partial<ReconnectPolicy>; afterReset?: Partial<ReconnectPolicy> };
  /** Disposed together with the session (discovery watchers and so on). */
  extraDisposables?: readonly Disposable[];
}

const DEFAULT_UNPLUG: ReconnectPolicy = { delaysMs: [1000, 2000, 2000, 3000, 3000, 3000, 5000], maxAttempts: 10 };
const DEFAULT_RESET: ReconnectPolicy = { delaysMs: [500, 500, 1000, 1000, 1000, 2000], maxAttempts: 12 };

interface ReconnectTarget {
  device: string;
  vid: number | null;
  pid: number | null;
  /** A socket or pty is not listed by `ports.list`: it is simply tried again by name. */
  kind: ConnectPortInfo['kind'];
}

function sameIds(a: ReconnectTarget, row: PortRow): boolean {
  return (a.vid === null || row.vid === null || a.vid === row.vid) && (a.pid === null || row.pid === null || a.pid === row.pid);
}

export class BridgeBoardSession implements BoardSession {
  private current: SessionState = initialSessionState();
  private readonly stateListeners = new Set<(s: SessionState) => unknown>();
  private readonly eventListeners = new Set<(e: SessionEvent) => unknown>();
  private readonly subscriptions: Disposable[] = [];
  private readonly progress: ProgressRouter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly unplugPolicy: ReconnectPolicy;
  private readonly resetPolicy: ReconnectPolicy;
  private selected: string | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private identityFlight: Promise<void> | undefined;
  private reconnectToken: object | undefined;
  private userDisconnected = false;
  private runsInFlight = 0;
  private lastConnect: OpResult<'connect'> | undefined;
  private extraShadow: string[] = [];
  private disposed = false;

  constructor(private readonly deps: SessionDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => { setTimeout(r, ms); }));
    this.unplugPolicy = { ...DEFAULT_UNPLUG, ...deps.reconnect?.afterUnplug };
    this.resetPolicy = { ...DEFAULT_RESET, ...deps.reconnect?.afterReset };
    this.progress = new ProgressRouter(deps.ui, (err) => deps.log.error('the progress notification failed', err), deps.now);
    this.subscriptions.push(
      deps.bridge.onEvent((ev) => this.onBridgeEvent(ev)),
      deps.bridge.onStatus((status, info) => this.onBridgeStatus(status, info)),
      ...(deps.extraDisposables ?? []),
    );
    if ('onDidChange' in deps.settings) {
      this.subscriptions.push(deps.settings.onDidChange((keys) => {
        if (keys.includes('stopOnDisconnect')) {
          void this.pushConfig();
        }
      }));
    }
  }

  // ------------------------------------------------------------------ BoardSession: state

  get state(): SessionState {
    return this.current;
  }

  readonly onDidChangeState = (listener: (s: SessionState) => unknown): Disposable => {
    this.stateListeners.add(listener);
    return { dispose: () => { this.stateListeners.delete(listener); } };
  };

  onEvent(listener: (ev: SessionEvent) => unknown): Disposable {
    this.eventListeners.add(listener);
    return { dispose: () => { this.eventListeners.delete(listener); } };
  }

  get selectedPort(): string | null {
    return this.selected;
  }

  get isRunning(): boolean {
    return this.current.state === 'running' || this.runsInFlight > 0;
  }

  get pendingSyncCount(): number {
    return this.current.pendingSyncCount;
  }

  setPendingSyncCount(count: number): void {
    this.patch({ pendingSyncCount: count });
  }

  selectPort(port: string | null): void {
    if (port !== null && isAutoPort(port)) {
      throw BoardError.of('E_PROTOCOL', '"auto" is a choice in the port list, not a port name.', { hint: 'Pick one of the ports in the list.' }, 'connect');
    }
    this.selected = port;
    this.patch({}, true);
  }

  private patch(change: Partial<SessionState>, force = false): void {
    const next: SessionState = { ...this.current, ...change };
    const keys = Object.keys(next) as (keyof SessionState)[];
    if (!force && keys.every((k) => next[k] === this.current[k])) {
      return;
    }
    this.current = next;
    for (const l of [...this.stateListeners]) {
      try {
        l(next);
      } catch (err) {
        this.deps.log.error('a session state listener failed', err);
      }
    }
  }

  private emit(ev: SessionEvent): void {
    for (const l of [...this.eventListeners]) {
      try {
        l(ev);
      } catch (err) {
        this.deps.log.error(`a session event listener failed on "${ev.ev}"`, err);
      }
    }
  }

  // ------------------------------------------------------------------ bridge events

  private onBridgeStatus(status: BridgeStatus, info?: BridgeExitInfo): void {
    switch (status) {
      case 'starting':
        this.patch({ bridge: 'starting' });
        break;
      case 'ready':
        this.patch({ bridge: 'ready', interpreter: 'ok' });
        break;
      case 'stopped':
        this.patch({ bridge: 'stopped' });
        this.dropConnection('connection helper stopped');
        break;
      case 'exited': {
        const wasConnected = this.current.state !== 'disconnected';
        this.patch({ bridge: 'exited' });
        this.dropConnection('connection helper exited');
        this.progress.endAll();
        if (wasConnected && !this.disposed) {
          this.deps.ui.warn(
            'The connection helper stopped unexpectedly, so the board was disconnected. Choose "Select Serial Port" to connect again. ' +
            `(${info?.stderrTail.at(-1) ?? 'see the log for details'})`,
          ).catch((err: unknown) => this.deps.log.error('could not show the helper warning', err));
        }
        break;
      }
    }
  }

  private dropConnection(reason: string): void {
    if (this.current.state !== 'disconnected' || this.current.port !== null || this.current.identity !== null) {
      this.patch({ state: 'disconnected', reason, port: null, portInfo: null, sync: null, identity: null });
    }
  }

  private onBridgeEvent(ev: SessionEvent): void {
    if (ev.ev === 'state') {
      this.onStateEvent(ev);
    } else if (ev.ev === 'progress') {
      this.progress.update(ev);
    }
    this.emit(ev);
  }

  private onStateEvent(ev: Extract<SessionEvent, { ev: 'state' }>): void {
    if (ev.state === 'disconnected') {
      const target: ReconnectTarget | null = this.current.port !== null
        ? { device: this.current.port, vid: this.current.portInfo?.vid ?? null, pid: this.current.portInfo?.pid ?? null, kind: this.current.portInfo?.kind ?? 'device' }
        : null;
      this.patch({ state: 'disconnected', reason: ev.reason ?? '', port: null, portInfo: null, sync: null, identity: null });
      this.identityFlight = undefined;
      if (target && !this.userDisconnected && !this.disposed) {
        if (ev.reason === 'unplugged') {
          this.deps.log.warn(`the board on ${target.device} was unplugged; trying to reconnect`);
          void this.reconnect(target, this.unplugPolicy, 'unplugged');
        } else if (ev.reason === 'board-reset') {
          void this.reconnect(target, this.resetPolicy, 'reset');
        }
      }
      return;
    }
    this.patch({ state: ev.state, reason: ev.reason ?? '', port: ev.port ?? this.current.port });
    if (ev.state === 'idle' && this.current.identity === null && this.current.port !== null) {
      this.probeIdentity().catch((err: unknown) => this.deps.log.error('the identity probe failed unexpectedly', err));
    }
  }

  // ------------------------------------------------------------------ calls

  private cacheKeyOfConnected(): ResetCacheKey {
    const info = this.current.portInfo;
    const uid = this.current.identity?.uniqueId ?? '';
    return { vid: info?.vid ?? null, pid: info?.pid ?? null, uniqueId: uid === '' ? null : uid };
  }

  private prepare<K extends OpName>(op: K, args: OpArgs<K>): OpArgs<K> {
    if (op === 'reset.capability' || op === 'reset.hard') {
      const a = args as { learned?: unknown; verify?: boolean; force?: boolean };
      // a verification and a forced reset measure again, so they must not be told the old answer
      if (a.learned === undefined && a.verify !== true && a.force !== true) {
        const learned = this.deps.learned.get(this.cacheKeyOfConnected());
        if (learned !== null) {
          return { ...args, learned } as OpArgs<K>;
        }
      }
    }
    return args;
  }

  async call<K extends OpName>(op: K, args: OpArgs<K>, opts?: CallOptions): Promise<OpResult<K>> {
    if (op === 'connect') {
      const a = args as OpArgs<'connect'>;
      return (await this.connect(a.port, { baud: a.baud, vid: a.vid, pid: a.pid })) as OpResult<K>;
    }
    if (op === 'disconnect') {
      await this.disconnect(args as OpArgs<'disconnect'>);
      return {} as OpResult<K>;
    }
    return this.send(op, this.prepare(op, args), opts);
  }

  /** One request to the bridge with progress routing and bookkeeping of what the answer teaches us. */
  private async send<K extends OpName>(op: K, args: OpArgs<K>, opts?: CallOptions): Promise<OpResult<K>> {
    const { id, result } = this.deps.bridge.send(op, args, opts);
    const background = (args as { background?: boolean }).background === true;
    this.progress.begin(id, op, background);
    if (op === 'run') {
      this.runsInFlight += 1;
      this.patch({}, true);
    }
    try {
      const res = await result;
      await this.learnFromAnswer(op, res);
      return res;
    } catch (err) {
      await this.learnFromFailure(op, err);
      throw err;
    } finally {
      this.progress.end(id);
      if (op === 'run') {
        this.runsInFlight -= 1;
        this.patch({}, true);
      }
    }
  }

  private async learnFromAnswer(op: OpName, res: unknown): Promise<void> {
    switch (op) {
      case 'identity':
        this.patch({ identity: res as BoardIdentity });
        void this.pushConfig();
        break;
      case 'reset.hard': {
        const r = res as OpResult<'reset.hard'>;
        if (r.learned && r.cacheKey) {
          await this.rememberLearned(r.cacheKey, r.learned);
        }
        break;
      }
      default:
        break;
    }
  }

  private async learnFromFailure(op: OpName, err: unknown): Promise<void> {
    if (!isBoardError(err)) {
      this.deps.log.error(`${op} failed with an unexpected error`, err);
      return;
    }
    if (err.code === 'E_NO_PYTHON') {
      this.patch({ interpreter: 'problem' });
    }
    if (op === 'reset.hard' && err.code === 'E_RESET_NOT_OBSERVED') {
      const body = err.body as unknown as { learned?: unknown; cache_key?: ResetCacheKey };
      if (body.learned === 'failed' && body.cache_key) {
        await this.rememberLearned(body.cache_key, 'failed');
      }
    }
  }

  private async rememberLearned(key: ResetCacheKey, learned: 'verified' | 'failed'): Promise<void> {
    try {
      await this.deps.learned.set(key, learned);
      this.deps.log.info(`learned: the control-line reset of this board ${learned === 'verified' ? 'works' : 'did not work'}`);
    } catch (err) {
      this.deps.log.error('could not save what was learned about the reset of this board', err);
    }
  }

  /** The consent flow around `call` for callers that have a prompter at hand. */
  callWithConsent<K extends OpName>(op: K, args: OpArgs<K>, opts?: CallOptions): Promise<OpResult<K>> {
    return withConsent(this, this.deps.ui, op, args, opts);
  }

  // ------------------------------------------------------------------ connect / disconnect

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.then(() => undefined, () => undefined);
    return run;
  }

  connect(port: string, opts: ConnectOptions = {}): Promise<OpResult<'connect'>> {
    if (isAutoPort(port)) {
      return Promise.reject(BoardError.of('E_PROTOCOL', '"auto" is a choice in the port list, not a port name.', { hint: 'Pick one of the ports in the list.' }, 'connect'));
    }
    this.cancelReconnect();
    this.userDisconnected = false;
    return this.serialize(() => this.doConnect(port, opts));
  }

  private async doConnect(port: string, opts: ConnectOptions): Promise<OpResult<'connect'>> {
    this.selected = port;
    if (this.current.state !== 'disconnected') {
      if (this.current.port === port && this.lastConnect) {
        this.patch({}, true);
        return this.lastConnect;
      }
      await this.rawDisconnect({}); // another port: close the old one first (refused during a Run: the caller asks the user)
    }
    this.patch({ state: 'connecting', port, reason: 'connect', portInfo: null, sync: null, identity: null }, true);
    let { vid, pid } = opts;
    if ((vid === undefined || pid === undefined) && !isUrlPort(port)) {
      const row = await this.lookupRow(port);
      if (row && row.vid !== null && row.pid !== null) {
        vid = row.vid;
        pid = row.pid;
      }
    }
    const args: OpArgs<'connect'> = { port };
    if (opts.baud !== undefined) {
      args.baud = opts.baud;
    }
    if (vid !== undefined && pid !== undefined) {
      args.vid = vid;
      args.pid = pid;
    }
    let res: OpResult<'connect'>;
    try {
      res = await this.send('connect', args, undefined);
    } catch (err) {
      // The code goes into `reason` so the status bar can tell a busy port from other failures (E_PORT_BUSY).
      const why = err instanceof BoardError ? `connect-failed: ${err.code}` : 'connect-failed';
      this.patch({ state: 'disconnected', port: null, portInfo: null, sync: null, identity: null, reason: why });
      throw err;
    }
    const actual = res.portInfo.port || port;
    this.selected = actual;
    this.lastConnect = res;
    const stateNow = this.current.state;
    this.patch({
      state: stateNow === 'connecting' || stateNow === 'disconnected' ? (res.state === 'idle' ? 'idle' : 'running') : stateNow,
      reason: this.current.reason || res.sync, port: actual, portInfo: res.portInfo, sync: res.sync, bridge: 'ready',
    });
    this.remember(actual, res.portInfo);
    if (this.current.state === 'idle') {
      this.probeIdentity().catch((err: unknown) => this.deps.log.error('the identity probe failed unexpectedly', err));
    }
    return res;
  }

  private remember(device: string, info: ConnectPortInfo): void {
    const memory = this.deps.portMemory;
    if (!memory) {
      return;
    }
    Promise.resolve(memory.remember({ device, vid: info.vid, pid: info.pid })).catch((err: unknown) => {
      this.deps.log.error('could not remember the chosen port for this workspace', err);
    });
  }

  private async lookupRow(port: string): Promise<PortRow | undefined> {
    try {
      const rows = (await this.send('ports.list', {})).ports;
      return rows.find((r) => r.device === port);
    } catch (err) {
      this.deps.log.warn('could not look up the USB ids of the port; the bridge will look them up itself', err);
      return undefined;
    }
  }

  disconnect(opts: { stopFirst?: boolean } = {}): Promise<void> {
    this.cancelReconnect();
    this.userDisconnected = true;
    return this.serialize(async () => {
      try {
        await this.rawDisconnect(opts);
      } catch (err) {
        this.userDisconnected = false; // refused (a Run is active): the board is still connected, an unplug must still reconnect
        throw err;
      }
    });
  }

  private async rawDisconnect(opts: { stopFirst?: boolean }): Promise<void> {
    if (this.current.state === 'disconnected' || this.deps.bridge.status !== 'ready') {
      this.dropConnection('disconnect');
      return;
    }
    const args: OpArgs<'disconnect'> = opts.stopFirst === undefined ? {} : { stopFirst: opts.stopFirst };
    await this.send('disconnect', args, undefined);
    this.lastConnect = undefined;
    this.identityFlight = undefined;
    this.patch({ state: 'disconnected', reason: 'disconnect', port: null, portInfo: null, sync: null, identity: null });
  }

  // ------------------------------------------------------------------ identity

  /** Resolves when the identity probe that is running (if any) has finished. Never rejects. */
  whenIdentityProbed(): Promise<void> {
    return this.identityFlight ?? Promise.resolve();
  }

  private probeIdentity(): Promise<void> {
    if (this.identityFlight) {
      return this.identityFlight;
    }
    const flight = (async (): Promise<void> => {
      if (this.current.state !== 'idle' || this.current.identity !== null) {
        return;
      }
      try {
        await this.send('identity', {}, undefined);
      } catch (err) {
        if (isBoardError(err) && (err.code === 'E_PROGRAM_RUNNING' || err.code === 'E_NOT_CONNECTED' || err.code === 'E_BRIDGE_EXITED')) {
          this.deps.log.debug(`identity probe skipped: ${err.code}`);
        } else {
          this.deps.log.warn('the board identity could not be read', err);
        }
      }
    })();
    this.identityFlight = flight;
    const clear = (): void => {
      if (this.identityFlight === flight) {
        this.identityFlight = undefined;
      }
    };
    flight.then(clear, clear);
    return flight;
  }

  // ------------------------------------------------------------------ config pushed to the bridge

  /** Names that uploads must not shadow, besides the board's own module list (a firmware profile adds its frozen names). */
  setShadowGuard(names: readonly string[]): void {
    this.extraShadow = [...names];
    void this.pushConfig();
  }

  /** `config` for a fresh bridge process (before the first request) or after a setting changed. */
  buildConfig(): OpArgs<'config'> {
    const modules = this.current.identity?.profileHints.modules ?? [];
    const guard = [...new Set([...this.extraShadow, ...modules])];
    return { stopOnDisconnect: this.deps.settings.stopOnDisconnect, ...(guard.length > 0 ? { shadowGuard: guard } : {}) };
  }

  private async pushConfig(): Promise<void> {
    if (this.deps.bridge.status !== 'ready') {
      return;
    }
    try {
      await this.send('config', this.buildConfig(), undefined);
    } catch (err) {
      this.deps.log.warn('could not send the settings to the connection helper', err);
    }
  }

  // ------------------------------------------------------------------ reconnect

  private cancelReconnect(): void {
    this.reconnectToken = undefined;
  }

  private async reconnect(target: ReconnectTarget, policy: ReconnectPolicy, kind: 'unplugged' | 'reset'): Promise<void> {
    if (this.reconnectToken) {
      return; // one at a time
    }
    const token = {};
    this.reconnectToken = token;
    const active = (): boolean => this.reconnectToken === token && !this.disposed;
    try {
      for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        await this.sleep(policy.delaysMs[Math.min(attempt - 1, policy.delaysMs.length - 1)] ?? 1000);
        if (!active()) {
          return;
        }
        this.patch({ reason: `reconnecting (attempt ${attempt} of ${policy.maxAttempts})` });
        let row: { device: string } | undefined;
        if (target.kind === 'url') {
          row = { device: target.device };
        } else {
          let rows: PortRow[];
          try {
            rows = (await this.send('ports.list', {})).ports;
          } catch (err) {
            this.deps.log.warn('reconnect: could not list the ports', err);
            if (isBoardError(err, 'E_BRIDGE_EXITED') || isBoardError(err, 'E_NO_PYTHON')) {
              return;
            }
            continue;
          }
          row = rows.find((r) => r.device === target.device && sameIds(target, r))
            ?? (() => { const same = rows.filter((r) => target.vid !== null && r.vid === target.vid && r.pid === target.pid); return same.length === 1 ? same[0] : undefined; })();
        }
        if (!row) {
          continue;
        }
        if (!active()) {
          return;
        }
        try {
          this.userDisconnected = false;
          await this.serialize(() => this.doConnect(row.device, {}));
          this.deps.log.info(`reconnected to ${row.device}`);
          return;
        } catch (err) {
          if (isBoardError(err, 'E_PORT_BUSY')) {
            this.patch({ reason: 'port busy' });
            this.offerRetry(row.device, err);
            return;
          }
          if (isBoardError(err, 'E_NO_DEVICE') || isBoardError(err, 'E_NOT_CONNECTED') || isBoardError(err, 'E_RAW_REPL_TIMEOUT')) {
            this.deps.log.info(`reconnect attempt ${attempt} failed (${err.code}); the board may still be starting`);
            continue;
          }
          this.deps.log.error('reconnect stopped', err);
          this.patch({ reason: 'reconnect failed' });
          this.deps.ui.warn(`Could not reconnect to the board: ${err instanceof Error ? err.message : String(err)}`).catch((e: unknown) => this.deps.log.error('could not show the warning', e));
          return;
        }
      }
      this.patch({ reason: 'reconnect gave up' });
      this.deps.log.warn(`gave up reconnecting to ${target.device} after ${policy.maxAttempts} attempts (${kind})`);
      this.deps.ui.warn(
        kind === 'unplugged'
          ? 'The connection to the board was lost and it did not come back. Check the USB cable, then choose "Select Serial Port".'
          : 'The board was rebooted but did not come back on its port. Check the USB cable, then choose "Select Serial Port".',
      ).catch((e: unknown) => this.deps.log.error('could not show the warning', e));
    } finally {
      if (this.reconnectToken === token) {
        this.reconnectToken = undefined;
      }
    }
  }

  private offerRetry(device: string, err: BoardError): void {
    this.deps.ui.warn(`${err.message} ${err.hint}`.trim(), 'Retry').then(
      (choice) => {
        if (choice === 'Retry' && !this.disposed) {
          this.connect(device).catch((e: unknown) => {
            this.deps.log.error('retry failed', e);
            this.deps.ui.warn(e instanceof Error ? e.message : String(e)).catch((x: unknown) => this.deps.log.error('could not show the warning', x));
          });
        }
      },
      (e: unknown) => this.deps.log.error('could not show the busy-port warning', e),
    );
  }

  // ------------------------------------------------------------------ port helpers (UI level "auto")

  /** `ports.list`: metadata only, never opens a port. */
  async listPorts(): Promise<PortRow[]> {
    return (await this.send('ports.list', {})).ports;
  }

  /**
   * "Auto" as a UI choice: exactly one likely board is selected (and shown by the status bar); several or none are returned
   * for the caller's QuickPick. Nothing is connected, remembered or written to settings here.
   */
  async autoSelect(): Promise<AutoPortChoice> {
    const choice = chooseAutoPort(await this.listPorts());
    if (choice.kind === 'one') {
      this.selectPort(choice.port.device);
    }
    return choice;
  }

  /** The remembered port of this workspace if it is plugged in (the same name, or the one port with the same adapter). */
  async findRememberedPort(): Promise<PortRow | null> {
    const remembered: RememberedPort | null = this.deps.portMemory?.get() ?? null;
    if (!remembered) {
      return null;
    }
    return matchRememberedPort(remembered, await this.listPorts());
  }

  // ------------------------------------------------------------------ bridge and interpreter

  /** Start the bridge if needed and return its hello (versions for the Doctor). Rejects with BoardError. */
  async bridgeInfo(): Promise<HelloEvent> {
    try {
      return await this.deps.bridge.start();
    } catch (err) {
      await this.learnFromFailure('ping', err);
      throw err;
    }
  }

  /** Look for a working Python without starting the bridge; updates `state.interpreter`. */
  async checkInterpreter(): Promise<InterpreterCheck> {
    const check = this.deps.checkInterpreter;
    if (!check) {
      return { ok: this.current.interpreter !== 'problem', message: '' };
    }
    const result = await check();
    this.patch({ interpreter: result.ok ? 'ok' : 'problem' });
    return result;
  }

  /** Stop the helper process and allow starting it again (Doctor: "restart the helper"). The board is disconnected. */
  async restartBridge(): Promise<void> {
    this.deps.bridge.resetRestartBudget?.();
    await this.deps.bridge.stopProcess();
  }

  /** What `reset.capability` says for the connected board, with what was learned before taken into account. */
  resetCapability(): Promise<ResetCapability> {
    return this.call('reset.capability', {});
  }

  forgetRememberedPort(): Promise<void> {
    return Promise.resolve(this.deps.portMemory?.forget());
  }

  // ------------------------------------------------------------------ lifetime

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelReconnect();
    this.progress.endAll();
    this.deps.bridge.dispose();
    for (const s of this.subscriptions.splice(0)) {
      try {
        s.dispose();
      } catch (err) {
        this.deps.log.error('error while disposing the session', err);
      }
    }
    this.stateListeners.clear();
    this.eventListeners.clear();
  }
}
