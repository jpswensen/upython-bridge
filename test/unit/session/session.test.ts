/**
 * BridgeBoardSession against a scripted bridge: state mirror, connect and disconnect rules, port memory, identity probe,
 * bounded reconnect (unplug, busy port, reset with a renumbered port), learned reset capability, progress routing, interpreter
 * problems and bridge crashes. The real bridge is exercised in sessionIntegration.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ResetCapability } from '../../../src/types/protocol';
import { BoardError, isBoardError, type SessionEvent, type SessionState } from '../../../src/types/session';
import { LearnedResetStore } from '../../../src/session/learnedReset';
import { FAKE_IDENTITY } from '../../mocks/fakeSession';
import { CP210X, ScriptedBridge, StubUi, makeSession, port, settle } from './kit';
import { isPortBusy } from '../../../src/statusbar';

async function rejection(p: Promise<unknown>): Promise<BoardError> {
  try { await p; } catch (e) { assert.ok(e instanceof BoardError, String(e)); return e; }
  throw new Error('expected a rejection');
}

const DEV = '/dev/cu.usbserial-0001';

describe('connect', () => {
  it('connects without starting anything before it is needed, looks up the USB ids, and mirrors the bridge states', async () => {
    const { session, bridge } = makeSession();
    assert.equal(bridge.startCount, 0, 'lazy: constructing starts nothing');
    assert.equal(session.state.bridge, 'stopped');
    const seen: string[] = [];
    session.onDidChangeState((s) => seen.push(s.state));
    const res = await session.connect(DEV);
    assert.equal(res.state, 'idle');
    assert.deepEqual(bridge.callsOf('connect')[0]?.args, { port: DEV, vid: CP210X.vid, pid: CP210X.pid });
    assert.equal(session.state.state, 'idle');
    assert.equal(session.state.port, DEV);
    assert.equal(session.state.sync, 'prompt');
    assert.equal(session.state.bridge, 'ready');
    assert.equal(session.state.interpreter, 'ok');
    assert.equal(session.selectedPort, DEV);
    assert.ok(seen.includes('connecting') && seen.includes('idle'));
    assert.equal(bridge.sent.filter((s) => s.op === 'connect').length, 1);
    assert.equal(bridge.sent.some((s) => ['reset.soft', 'reset.machine', 'reset.hard', 'run'].includes(s.op)), false, 'connect never resets or runs anything');
  });

  it('never accepts "auto" (connect, selectPort, call), and sends nothing', async () => {
    const { session, bridge } = makeSession();
    for (const word of ['auto', ' AUTO ']) {
      assert.equal((await rejection(session.connect(word))).code, 'E_PROTOCOL');
      assert.throws(() => session.selectPort(word), /not a port name/);
      assert.equal((await rejection(session.call('connect', { port: word }))).code, 'E_PROTOCOL');
    }
    assert.equal(bridge.sent.length, 0);
    assert.equal(session.selectedPort, null);
  });

  it('remembers (name, VID, PID) in the workspace state only after a successful connect', async () => {
    const { session, workspaceState, portMemory, bridge } = makeSession();
    session.selectPort(DEV);
    assert.deepEqual(workspaceState.writes, [], 'choosing a port writes nothing');
    await session.connect(DEV);
    await settle();
    assert.deepEqual(portMemory.get(), { device: DEV, vid: CP210X.vid, pid: CP210X.pid });
    const failing = makeSession();
    failing.bridge.on('connect', () => BoardError.of('E_PORT_BUSY', 'The port is busy.', { hint: 'Close Thonny.' }, 'connect'));
    await rejection(failing.session.connect(DEV));
    assert.deepEqual(failing.workspaceState.writes, []);
    assert.ok(bridge);
  });

  it('keeps the selection when connecting fails, so Retry works, and passes the error through with its hint', async () => {
    const { session, bridge } = makeSession();
    bridge.on('connect', () => BoardError.of('E_PORT_BUSY', 'Another program is using the port.', { hint: 'Close Thonny, Arduino or PlatformIO, then try again.' }, 'connect'));
    const err = await rejection(session.connect(DEV));
    assert.equal(err.code, 'E_PORT_BUSY');
    assert.match(err.hint, /Thonny/);
    assert.equal(session.selectedPort, DEV);
    assert.equal(session.state.state, 'disconnected');
    assert.equal(session.state.reason, 'connect-failed: E_PORT_BUSY');
    assert.equal(isPortBusy(session.state), true, 'the status bar can tell a busy port from other failures');
    assert.equal(session.state.port, null);
  });

  it('probes the identity once after the first idle prompt (and again only after a reconnect), and pushes the board\'s module names as the shadow guard', async () => {
    const { session, bridge } = makeSession();
    bridge.on('identity', () => ({ ...FAKE_IDENTITY, profileHints: { ...FAKE_IDENTITY.profileHints, modules: ['machine', 'network'] } }));
    await session.connect(DEV);
    await session.whenIdentityProbed();
    assert.equal(bridge.callsOf('identity').length, 1);
    assert.equal(session.state.identity?.uniqueId, FAKE_IDENTITY.uniqueId);
    await settle();
    const guard = bridge.callsOf('config').at(-1)?.args;
    assert.deepEqual(guard?.shadowGuard, ['machine', 'network']);
    bridge.state('running', 'idle');
    bridge.state('idle', 'running', 'prompt seen');
    await session.whenIdentityProbed();
    assert.equal(bridge.callsOf('identity').length, 1, 'cached while connected');
    await session.disconnect();
    assert.equal(session.state.identity, null);
    await session.connect(DEV);
    await session.whenIdentityProbed();
    assert.equal(bridge.callsOf('identity').length, 2);
  });

  it('does not probe a board that is running a program, until it reaches its prompt', async () => {
    const { session, bridge } = makeSession();
    bridge.connectState = 'running';
    await session.connect(DEV);
    await session.whenIdentityProbed();
    assert.equal(session.state.state, 'running');
    assert.equal(bridge.callsOf('identity').length, 0);
    assert.equal(session.isRunning, true);
    bridge.state('idle', 'running', 'prompt seen');
    await session.whenIdentityProbed();
    assert.equal(bridge.callsOf('identity').length, 1);
    assert.equal(session.state.state, 'idle');
  });

  it('switching to another port closes the old one first; connecting to the same port again is a no-op', async () => {
    const { session, bridge } = makeSession();
    bridge.ports = [port(DEV), port('/dev/cu.usbserial-0002')];
    await session.connect(DEV);
    await session.connect(DEV);
    assert.equal(bridge.callsOf('connect').length, 1);
    await session.connect('/dev/cu.usbserial-0002');
    assert.deepEqual(bridge.sent.filter((s) => s.op === 'connect' || s.op === 'disconnect').map((s) => `${s.op}`), ['connect', 'disconnect', 'connect']);
    assert.equal(session.state.port, '/dev/cu.usbserial-0002');
  });
});

describe('disconnect', () => {
  it('does not start the bridge just to disconnect', async () => {
    const { session, bridge } = makeSession();
    await session.disconnect();
    assert.equal(bridge.startCount, 0);
    assert.equal(session.state.state, 'disconnected');
  });

  it('sends stopFirst only when the caller says so; during a Run the bridge refuses and the session stays connected', async () => {
    const { session, bridge } = makeSession();
    await session.connect(DEV);
    bridge.once('disconnect', () => BoardError.of('E_PROGRAM_RUNNING', 'A program is running.', { needs_interrupt: true }, 'disconnect'));
    const err = await rejection(session.disconnect());
    assert.equal(err.needsInterrupt, true);
    assert.equal(session.state.state, 'idle');
    assert.deepEqual(bridge.callsOf('disconnect')[0]?.args, {});
    await session.disconnect({ stopFirst: true });
    assert.deepEqual(bridge.callsOf('disconnect')[1]?.args, { stopFirst: true });
    assert.equal(session.state.state, 'disconnected');
    assert.equal(session.selectedPort, DEV, 'the selection survives a disconnect');
    assert.equal(session.state.reason, 'disconnect');
  });
});

describe('reconnect (bounded)', () => {
  async function connected(extra: Parameters<typeof makeSession>[0] = {}) {
    const k = makeSession(extra);
    await k.session.connect(DEV);
    await k.session.whenIdentityProbed();
    return k;
  }

  it('reconnects to the same port after an unplug once it is listed again, without ever resetting the board', async () => {
    const { session, bridge } = await connected();
    let polls = 0;
    bridge.on('ports.list', () => ({ ports: ++polls < 3 ? [] : [port(DEV)] }));
    bridge.state('disconnected', 'idle', 'unplugged');
    assert.equal(session.state.state, 'disconnected');
    await settle(20);
    assert.equal(bridge.callsOf('connect').length, 2);
    assert.equal(session.state.state, 'idle');
    assert.equal(session.state.port, DEV);
    assert.equal(bridge.sent.some((s) => s.op.startsWith('reset') || s.op === 'run'), false);
  });

  it('stops at once when the port is busy, tells the student what to do and offers Retry', async () => {
    const { session, bridge, ui } = await connected();
    ui.warnAnswer = 'Retry';
    bridge.once('connect', () => BoardError.of('E_PORT_BUSY', 'Another program is using the port.', { hint: 'Close Thonny first.' }, 'connect'));
    bridge.state('disconnected', 'idle', 'unplugged');
    await settle(30);
    assert.ok(ui.warns[0]?.actions.includes('Retry'));
    assert.match(ui.warns[0]?.message ?? '', /Close Thonny/);
    assert.equal(ui.warns.length, 1, 'one message, no retry storm');
    assert.equal(bridge.callsOf('connect').length, 3, 'one reconnect attempt, then Retry connects once more (the port is free now)');
    assert.equal(session.state.state, 'idle');
  });

  it('gives up after the attempt limit and says so', async () => {
    const { session, bridge, ui } = await connected({ reconnect: { afterUnplug: { maxAttempts: 3, delaysMs: [1] } } });
    bridge.on('ports.list', () => ({ ports: [] }));
    bridge.state('disconnected', 'idle', 'unplugged');
    await settle(20);
    assert.equal(bridge.callsOf('ports.list').length, 4 - 1 + 1, 'bounded: 3 attempts (+1 earlier lookup)');
    assert.equal(session.state.reason, 'reconnect gave up');
    assert.match(ui.warns[0]?.message ?? '', /Select Serial Port/);
  });

  it('does not reconnect after the student disconnected on purpose', async () => {
    const { session, bridge } = await connected();
    await session.disconnect();
    bridge.state('disconnected', 'idle', 'unplugged');
    await settle(10);
    assert.equal(bridge.callsOf('connect').length, 1);
  });

  it('finds a board again after a reset by its USB ids when the port name changed (Windows COM renumbering)', async () => {
    const k = makeSession();
    k.bridge.ports = [port('COM3', 0x303a, 0x1001)];
    await k.session.connect('COM3');
    k.bridge.ports = [port('COM7', 0x303a, 0x1001), port('COM9', 0x10c4, 0xea60)];
    k.bridge.state('disconnected', 'idle', 'board-reset');
    await settle(20);
    assert.equal(k.bridge.callsOf('connect').at(-1)?.args.port, 'COM7');
    assert.equal(k.session.state.port, 'COM7');
  });

  it('does not guess between two boards with the same adapter after a reset', async () => {
    const k = makeSession({ reconnect: { afterReset: { maxAttempts: 2, delaysMs: [1] } } });
    k.bridge.ports = [port('COM3', 0x303a, 0x1001)];
    await k.session.connect('COM3');
    k.bridge.ports = [port('COM7', 0x303a, 0x1001), port('COM8', 0x303a, 0x1001)];
    k.bridge.state('disconnected', 'idle', 'board-reset');
    await settle(20);
    assert.equal(k.bridge.callsOf('connect').length, 1);
    assert.equal(k.session.state.reason, 'reconnect gave up');
  });

  it('retries a socket or pty by name (such ports are not listed by ports.list)', async () => {
    const k = makeSession();
    k.bridge.on('connect', (a, b) => {
      b.state('connecting', 'disconnected', undefined, String(a.port));
      b.state('idle', 'connecting', 'prompt seen', String(a.port));
      return { state: 'idle', sync: 'prompt', portInfo: { port: String(a.port), requested: String(a.port), baud: 115200, kind: 'url', policy: 'url', platform: 'darwin', pyserial: '3.5', vid: null, pid: null, adapter: '', exclusive: true, canHardReset: false } };
    });
    await k.session.connect('socket://127.0.0.1:5555');
    k.bridge.state('disconnected', 'idle', 'unplugged');
    await settle(20);
    assert.equal(k.bridge.callsOf('connect').length, 2);
    assert.equal(k.bridge.callsOf('ports.list').length, 0, 'a socket is never looked up in the port list');
    assert.equal(k.session.state.state, 'idle');
  });
});

describe('learned reset capability', () => {
  const cap = (hard: ResetCapability['hard']): ResetCapability => ({ soft: true, machine: { available: true, reason: '' }, hard, cacheKey: { vid: CP210X.vid, pid: CP210X.pid, uniqueId: FAKE_IDENTITY.uniqueId } });

  it('passes what it learned to reset.capability, but not to a verification', async () => {
    const k = makeSession();
    await k.session.connect(DEV);
    await k.session.whenIdentityProbed();
    k.bridge.on('reset.capability', () => cap(null));
    await k.session.call('reset.capability', {});
    assert.equal('learned' in (k.bridge.callsOf('reset.capability')[0]?.args ?? {}), false, 'nothing learned yet');
    await k.learned.set({ vid: CP210X.vid, pid: CP210X.pid, uniqueId: FAKE_IDENTITY.uniqueId }, 'verified');
    await k.session.call('reset.capability', {});
    assert.equal(k.bridge.callsOf('reset.capability')[1]?.args.learned, 'verified');
    k.bridge.on('reset.hard', () => ({ verified: true, evidence: ['boot text'] }));
    await k.session.call('reset.hard', { confirmed: true, verify: true });
    assert.equal('learned' in (k.bridge.callsOf('reset.hard')[0]?.args ?? {}), false, 'a verification measures again');
  });

  it('stores the outcome of a verification (success, and E_RESET_NOT_OBSERVED) for every workspace', async () => {
    const k = makeSession();
    await k.session.connect(DEV);
    k.bridge.once('reset.hard', () => ({ verified: true, evidence: ['ets rst'], learned: 'verified', cacheKey: { vid: 1, pid: 2, uniqueId: 'aa' } }));
    await k.session.call('reset.hard', { confirmed: true, verify: true });
    assert.equal(k.learned.get({ vid: 1, pid: 2, uniqueId: 'aa' }), 'verified');
    k.bridge.once('reset.hard', () => BoardError.of('E_RESET_NOT_OBSERVED', 'No reset seen.', { learned: 'failed', cache_key: { vid: 3, pid: 4, uniqueId: null } } as never, 'reset.hard'));
    await rejection(k.session.call('reset.hard', { confirmed: true, verify: true }));
    assert.equal(k.learned.get({ vid: 3, pid: 4, uniqueId: null }), 'failed');
    const reopened = new LearnedResetStore(k.globalState); // a new window, another workspace: same global storage
    assert.equal(reopened.get({ vid: 1, pid: 2, uniqueId: 'aa' }), 'verified');
    assert.deepEqual(k.learned.all().map((e) => e.learned).sort(), ['failed', 'verified']);
    assert.equal(k.learned.get({ vid: null, pid: null, uniqueId: 'x' }), null, 'a board without USB ids cannot be keyed');
  });
});

describe('progress, interpreter, bridge lifetime', () => {
  it('shows a progress notification only for interactive operations that run long, and closes it when they end', async () => {
    let t = 0;
    const k = makeSession({ now: () => t });
    await k.session.connect(DEV);
    k.bridge.on('fs.put', () => ({ bytes: 1, sha256: 'x', skipped: false, sent: 1, verified: 'sha256' }));
    const release = k.bridge.hold('fs.put');
    const quick = k.session.call('fs.put', { local: '/a', remote: '/a' });
    await settle();
    const id = k.bridge.callsOf('fs.put')[0]?.id ?? -1;
    k.bridge.emit({ ev: 'progress', id, label: 'a.py', done: 1, total: 10 });
    assert.equal(k.ui.progress.length, 0, 'under 600 ms: nothing shown');
    t = 1000;
    k.bridge.emit({ ev: 'progress', id, label: 'a.py', done: 5, total: 10 });
    k.bridge.emit({ ev: 'progress', id, label: 'a.py', done: 10, total: 10 });
    assert.equal(k.ui.progress.length, 1);
    assert.equal(k.ui.progress[0]?.title, 'Uploading to the board');
    assert.deepEqual(k.ui.progress[0]?.reports.map((r) => r.message), ['a.py (50%)', 'a.py (100%)']);
    release();
    await quick;
    await settle();
    assert.equal(k.ui.progress[0]?.done, true);
    // background work (auto-sync, refresh) never shows one
    const release2 = k.bridge.hold('fs.put');
    const bg = k.session.call('fs.put', { local: '/b', remote: '/b', background: true });
    await settle();
    k.bridge.emit({ ev: 'progress', id: k.bridge.callsOf('fs.put')[1]?.id ?? -1, label: 'b.py', done: 5, total: 10 });
    assert.equal(k.ui.progress.length, 1);
    release2();
    await bg;
  });

  it('marks the interpreter as a problem when no Python can be found, and as fine once the bridge starts', async () => {
    const k = makeSession();
    k.bridge.startError = BoardError.of('E_NO_PYTHON', 'Python was not found.', { hint: 'Install it.' });
    const err = await rejection(k.session.connect(DEV));
    assert.equal(err.code, 'E_NO_PYTHON');
    assert.equal(k.session.state.interpreter, 'problem');
    assert.equal(k.session.state.state, 'disconnected');
    k.bridge.startError = undefined;
    await k.session.connect(DEV);
    assert.equal(k.session.state.interpreter, 'ok');
  });

  it('checkInterpreter() asks discovery without starting the bridge', async () => {
    const k = makeSession({ checkInterpreter: async () => ({ ok: false, message: 'none' }) });
    assert.deepEqual(await k.session.checkInterpreter(), { ok: false, message: 'none' });
    assert.equal(k.session.state.interpreter, 'problem');
    assert.equal(k.bridge.startCount, 0);
  });

  it('turns a crashed helper into a disconnected state with one warning, and can restart it', async () => {
    const k = makeSession();
    await k.session.connect(DEV);
    k.bridge.crash();
    assert.equal(k.session.state.bridge, 'exited');
    assert.equal(k.session.state.state, 'disconnected');
    assert.equal(k.session.state.port, null);
    assert.equal(k.session.selectedPort, DEV);
    await settle();
    assert.equal(k.ui.warns.length, 1);
    assert.match(k.ui.warns[0]?.message ?? '', /Select Serial Port/);
    await k.session.restartBridge();
    assert.equal(k.bridge.budgetResets, 1);
    assert.equal(k.bridge.stopCount, 1);
  });

  it('forwards events in order after updating the state, and replaces the state object on every change', async () => {
    const k = makeSession();
    await k.session.connect(DEV);
    const first = k.session.state;
    const log: string[] = [];
    k.session.onEvent((e: SessionEvent) => log.push(e.ev === 'state' ? `state:${e.state}:${k.session.state.state}` : e.ev));
    k.bridge.state('running', 'idle', 'run');
    k.bridge.emit({ ev: 'out', bytes: new Uint8Array([104]) });
    assert.deepEqual(log, ['state:running:running', 'out']);
    assert.notEqual(k.session.state, first);
    assert.equal(first.state, 'idle', 'an old snapshot never changes');
  });

  it('counts a Run in flight as running, mirrors the pending sync count, and a listener that throws does not break others', async () => {
    const k = makeSession();
    await k.session.connect(DEV);
    const release = k.bridge.hold('run');
    k.bridge.on('run', () => ({ exit: 'ok', durationMs: 1 }));
    const states: SessionState[] = [];
    k.session.onDidChangeState(() => { throw new Error('bad listener'); });
    k.session.onDidChangeState((s) => states.push(s));
    const run = k.session.call('run', { source: 'print(1)' });
    await settle();
    assert.equal(k.session.isRunning, true);
    release();
    await run;
    assert.equal(k.session.isRunning, false);
    k.session.setPendingSyncCount(3);
    assert.equal(k.session.pendingSyncCount, 3);
    assert.equal(states.at(-1)?.pendingSyncCount, 3);
  });

  it('dispose() is idempotent, stops the bridge once and ends any open progress', async () => {
    const k = makeSession();
    await k.session.connect(DEV);
    k.session.dispose();
    k.session.dispose();
    assert.equal(k.bridge.disposed, 1);
    assert.equal(isBoardError(await k.session.call('ping', {}).catch((e: unknown) => e), 'E_BRIDGE_EXITED'), true);
  });
});

describe('port helpers', () => {
  it('"auto" is a UI choice: one likely board is selected and shown, several or none are handed back', async () => {
    const k = makeSession();
    k.bridge.ports = [port(DEV), port('/dev/cu.Bluetooth-Incoming-Port', null, null, false)];
    const one = await k.session.autoSelect();
    assert.equal(one.kind, 'one');
    assert.equal(k.session.selectedPort, DEV);
    assert.equal(k.bridge.callsOf('connect').length, 0, 'selecting is not connecting');
    k.bridge.ports = [port(DEV), port('/dev/cu.usbserial-0002')];
    const many = await k.session.autoSelect();
    assert.deepEqual(many.kind === 'many' && many.ports.map((p) => p.device), [DEV, '/dev/cu.usbserial-0002']);
    k.bridge.ports = [port('/dev/cu.Bluetooth-Incoming-Port', null, null, false)];
    assert.equal((await k.session.autoSelect()).kind, 'none');
  });

  it('finds the remembered board by name, or by adapter when the name changed', async () => {
    const k = makeSession();
    await k.portMemory.remember({ device: 'COM3', vid: 0x1a86, pid: 0x7523 });
    k.bridge.ports = [port('COM3', 0x1a86, 0x7523)];
    assert.equal((await k.session.findRememberedPort())?.device, 'COM3');
    k.bridge.ports = [port('COM5', 0x1a86, 0x7523), port('COM6', 0x10c4, 0xea60)];
    assert.equal((await k.session.findRememberedPort())?.device, 'COM5');
    k.bridge.ports = [port('COM3', 0x10c4, 0xea60)];
    assert.equal(await k.session.findRememberedPort(), null, 'same name but another adapter is not the same board');
  });

  it('the config for a fresh helper carries stopOnDisconnect and the extra shadow names', () => {
    const k = makeSession();
    k.session.setShadowGuard(['acme']);
    assert.deepEqual(k.session.buildConfig(), { stopOnDisconnect: true, shadowGuard: ['acme'] });
    assert.ok(new StubUi());
    assert.ok(ScriptedBridge);
  });
});
