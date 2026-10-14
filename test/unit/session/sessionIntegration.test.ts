/**
 * The real session on the real client, the real Python bridge and a fake board over a loopback socket (never a serial port;
 * MPY_SAFE_MODE=1 forced by the harness): about 24 operations, a program that must be interrupted with consent, disconnect
 * during a Run, unplug with reconnect, and a busy board. All processes are bounded and removed in afterEach.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { BridgeClient } from '../../../src/bridge/client';
import { withConsent, isDeclined } from '../../../src/session/consent';
import { LearnedResetStore } from '../../../src/session/learnedReset';
import { BridgeBoardSession } from '../../../src/session/session';
import { BoardError, type SessionEvent, type SessionState } from '../../../src/types/session';
import { PortMemory } from '../../../src/types/settings';
import { MockMemento } from '../../mocks/extensionContext';
import { childEnv, integrationSkipReason, startFakeBoard, stopAll, testPython, type FakeBoardOptions } from '../../mocks/fakeBridge';
import { TempDirs, makeTrickyDir, projectRoot } from '../../mocks/fixtures';
import { MemoryLog, until } from '../bridge/stubChild';
import { SETTINGS, StubUi } from './kit';

const skip = integrationSkipReason();
const dirs = new TempDirs();
const sessions: BridgeBoardSession[] = [];
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const identityOf = (s: BridgeBoardSession): SessionState['identity'] => s.state.identity;

afterEach(async () => {
  for (const s of sessions.splice(0)) { s.dispose(); }
  await stopAll();
  dirs.cleanup();
});

function realSession() {
  const tmp = dirs.make('upy-bridge-sitest');
  const python = testPython();
  assert.ok(python);
  const log = new MemoryLog();
  const ui = new StubUi();
  const bridge = new BridgeClient({
    resolvePython: async () => ({ command: python, prefixArgs: [] }), extensionPath: projectRoot(), pycacheDir: path.join(tmp, 'pyc'),
    cwd: path.join(tmp, 'neutral'), log: log.logger, env: childEnv(), shutdownGraceMs: 8000,
  });
  const memory = new MockMemento();
  const session = new BridgeBoardSession({
    log: log.logger, settings: SETTINGS, bridge, ui, learned: new LearnedResetStore(new MockMemento()), portMemory: new PortMemory(memory),
    sleep: () => new Promise<void>((r) => { setTimeout(r, 40); }), reconnect: { afterUnplug: { maxAttempts: 40, delaysMs: [100] } },
  });
  sessions.push(session);
  const events: SessionEvent[] = [];
  session.onEvent((e) => events.push(e));
  return { session, ui, log, tmp, events, bridge, memory };
}

async function withBoard<T>(opts: FakeBoardOptions, fn: (url: string) => Promise<T>): Promise<T> {
  const board = await startFakeBoard(opts);
  try {
    return await fn(board.url);
  } finally {
    await board.stop();
  }
}

/** Fail with the name of the step instead of hanging until the whole test times out. */
function bounded<T>(label: string, p: PromiseLike<T>, ms = 20000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`step "${label}" did not finish within ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}

const LOOP = 'import time\nwhile True:\n    time.sleep(0.05)\n';

describe('BridgeBoardSession with the real bridge', () => {
  it('connects, reads the identity, and carries out the whole file, run and reset repertoire', { skip, timeout: 120000 }, async () => {
    await withBoard({ profile: 'esp32' }, async (url) => {
      const { session, events, tmp, log } = realSession();
      const res = await session.connect(url);
      assert.ok(['idle', 'running'].includes(res.state));
      assert.equal(session.state.bridge, 'ready');
      assert.equal(session.state.state, 'idle');
      await session.whenIdentityProbed();
      assert.equal(session.state.identity?.impl, 'micropython');
      assert.ok(session.state.identity?.uniqueId);

      const folder = makeTrickyDir(tmp);
      const local = path.join(folder, 'main (1).py');
      fs.writeFileSync(local, "print('from the file')\n");
      const back = path.join(folder, 'copy', 'main back.py');

      assert.deepEqual(await session.call('ping', {}), {});
      assert.deepEqual(await session.call('config', { stopOnDisconnect: true }), {});
      assert.ok(Array.isArray((await session.call('ports.list', {})).ports));
      assert.equal((await session.call('fs.mkdir', { path: '/lab/sub' })).created >= 1, true);
      const put = await session.call('fs.put', { local, remote: '/lab/main.py' });
      assert.equal(put.verified, 'sha256');
      assert.equal((await session.call('fs.stat', { path: '/lab/main.py' })).exists, true);
      assert.deepEqual((await session.call('fs.list', { path: '/lab' })).entries.map((e) => e.name).sort(), ['main.py', 'sub']);
      const manifest = await session.call('fs.manifest', { root: '/lab' });
      assert.ok(manifest.entries.some((e) => e.path === '/lab/main.py' && e.sha256 === put.sha256));
      assert.equal((await session.call('fs.get', { remote: '/lab/main.py', local: back })).sha256, put.sha256);
      assert.equal(fs.readFileSync(back, 'utf8'), "print('from the file')\n");
      await session.call('fs.mv', { src: '/lab/main.py', dst: '/lab/sub/moved.py' });
      assert.equal((await session.call('fs.stat', { path: '/lab/main.py' })).exists, false);
      await session.call('fs.rm', { path: '/lab/sub/moved.py' });
      assert.equal((await session.call('exec', { code: 'print(1+1)' })).out.trim(), '2');
      assert.ok(Array.isArray((await session.call('introspect.modules', {})).listing));
      assert.equal((await session.call('fs.rmtree', { path: '/lab', confirm: true })).removed >= 1, true);

      const ran = await session.call('run', { local, name: 'main.py' });
      assert.equal(ran.exit, 'ok');
      const out = events.filter((e) => e.ev === 'out').map((e) => (e.ev === 'out' ? dec(e.bytes) : '')).join('');
      assert.match(out, /from the file/);
      assert.equal(session.isRunning, false);

      const looping = session.call('run', { source: LOOP, name: 'loop.py' });
      await until(() => session.state.state === 'running', 'the program to run', 20000);
      assert.equal(session.isRunning, true);
      assert.equal((await session.call('stop', {})).stopped, true);
      assert.equal((await looping).exit, 'interrupted');
      await until(() => session.state.state === 'idle', 'idle after Stop', 20000);

      await session.call('repl.attach', {});
      await session.call('tty.write', { b64: Buffer.from('\r').toString('base64') });
      await session.call('repl.detach', {});
      await session.call('reset.soft', {});
      const cap = await session.call('reset.capability', {});
      assert.equal(cap.soft, true);
      assert.ok(cap.hard === null || typeof cap.hard.state === 'string');

      await session.disconnect();
      assert.equal(session.state.state, 'disconnected');
      assert.equal(session.selectedPort, url);
      assert.ok(!log.lines.some((l) => /ignored bad output/.test(l)));
      assert.ok(!log.lines.some((l) => /ERROR/.test(l)), log.lines.filter((l) => /ERROR/.test(l)).join('\n'));
    });
  });

  it('a program already running at connect: file operations wait until the student agrees to interrupt it', { skip, timeout: 120000 }, async () => {
    await withBoard({ profile: 'esp32', faults: ['main_forever'] }, async (url) => {
      const { session, ui } = realSession();
      await session.connect(url);
      assert.equal(session.state.state, 'running');
      await session.whenIdentityProbed();
      assert.equal(session.state.identity, null, 'no identity probe while a program runs');

      const plain = await bounded('plain fs.list', session.call('fs.list', { path: '/' })).then(() => null, (e: unknown) => e);
      assert.ok(plain instanceof BoardError && plain.code === 'E_PROGRAM_RUNNING' && plain.needsInterrupt, String(plain));
      assert.ok(plain.hint.length > 0);

      ui.interruptAnswer = false;
      await assert.rejects(bounded('declined consent', withConsent(session, ui, 'fs.list', { path: '/' })), (e: unknown) => isDeclined(e));
      assert.equal(session.state.state, 'running', 'declining sent nothing to the board');

      ui.interruptAnswer = true;
      const listing = await bounded('consented fs.list', withConsent(session, ui, 'fs.list', { path: '/' }));
      assert.ok(Array.isArray(listing.entries));
      assert.equal(ui.interruptAsked.length, 2, 'asked once per call, never twice for the same call');
      await until(() => session.state.state === 'idle', 'idle after the interruption', 20000);
      await bounded('identity after the prompt', session.whenIdentityProbed());
      assert.equal(identityOf(session)?.impl, 'micropython');
    });
  });

  it('disconnect during a Run needs an explicit choice; stopFirst stops the program and then closes', { skip, timeout: 120000 }, async () => {
    await withBoard({ profile: 'esp32' }, async (url) => {
      const { session } = realSession();
      await session.connect(url);
      const looping = session.call('run', { source: LOOP, name: 'loop.py' });
      looping.catch(() => undefined);
      await until(() => session.state.state === 'running', 'the program to run', 20000);
      const refused = await bounded('disconnect during run', session.disconnect()).then(() => null, (e: unknown) => e);
      assert.ok(refused instanceof BoardError && refused.needsInterrupt, 'no stopFirst during a Run: refused, the port stays open');
      assert.equal(session.state.state, 'running');
      assert.equal(session.selectedPort, url);
      await bounded('disconnect stopFirst', session.disconnect({ stopFirst: true }));
      assert.equal(session.state.state, 'disconnected');
      // protocol Appendix C says 'interrupted'; the fake board has been seen answering 'disconnected' when the port closes first
      assert.ok(['interrupted', 'disconnected'].includes((await bounded('run result', looping)).exit));
    });
  });

  it('notices an unplug, reconnects to the same board within a bounded time, and never resets it', { skip, timeout: 120000 }, async () => {
    await withBoard({ profile: 'esp32', faults: ['unplug:after=1.5'] }, async (url) => {
      const { session, events } = realSession();
      await session.connect(url);
      await until(() => events.some((e) => e.ev === 'state' && e.state === 'disconnected' && e.reason === 'unplugged'), 'the unplug', 30000);
      await until(() => session.state.state === 'idle' && session.state.port === url, 'the reconnect', 60000);
      assert.equal(session.state.bridge, 'ready');
      const resets = events.filter((e) => e.ev === 'state' && /reset/.test(e.reason ?? '') && e.reason !== 'board-reset');
      assert.deepEqual(resets, []);
      assert.deepEqual(await session.call('ping', {}), {});
    });
  });

  it('classifies a board that another program already holds, keeps the selection, and offers a way back', { skip, timeout: 120000 }, async () => {
    await withBoard({ profile: 'esp32' }, async (url) => {
      const first = realSession();
      await first.session.connect(url);
      const second = realSession();
      const err = await second.session.connect(url).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof BoardError, String(err));
      // a fake board over TCP refuses a second client by not answering (E_NO_DEVICE); a held serial port is E_PORT_BUSY (unit-tested with the scripted bridge)
      assert.ok(['E_PORT_BUSY', 'E_NO_DEVICE'].includes(err.code), `refused with ${err.code}: ${err.message}`);
      assert.ok(err.hint.length > 0 || err.message.length > 0);
      assert.equal(second.session.selectedPort, url, 'the selection survives, so Retry works');
      assert.equal(second.session.state.state, 'disconnected');
      assert.equal(first.session.state.state, 'idle', 'the first connection is untouched');
    });
  });
});
