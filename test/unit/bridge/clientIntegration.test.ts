/**
 * BridgeClient against the REAL Python bridge and a REAL fake board (tools/fakeboard.py over a loopback socket, never a serial
 * port; MPY_SAFE_MODE=1 is forced and MPY_REAL_PORT removed by the harness). Covers connect, identity, files in a folder with spaces,
 * parentheses and non-ASCII, run and stop, an unplug in the middle of an operation, the bridge killed from outside, and
 * shutting down while a program runs. Every process is bounded and cleaned up in afterEach.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { BridgeClient, type BridgeClientOptions } from '../../../src/bridge/client';
import type { BridgeEvent } from '../../../src/bridge/types';
import { BoardError } from '../../../src/types/session';
import { TempDirs, makeTrickyDir, projectRoot } from '../../mocks/fixtures';
import { childEnv, integrationSkipReason, startFakeBoard, stopAll, testPython, type FakeBoardHandle, type FakeBoardOptions } from '../../mocks/fakeBridge';
import { MemoryLog, until } from './stubChild';

const skip = integrationSkipReason();
const dirs = new TempDirs();
const clients: BridgeClient[] = [];
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await stopAll();
  dirs.cleanup();
});

function realClient(extra: Partial<BridgeClientOptions> = {}) {
  const tmp = dirs.make('upy-bridge-itest');
  const python = testPython();
  assert.ok(python, 'a Python >= 3.9 is needed (the suite skips without one)');
  const log = new MemoryLog();
  const events: BridgeEvent[] = [];
  const client = new BridgeClient({
    resolvePython: async () => ({ command: python, prefixArgs: [] }),
    extensionPath: projectRoot(), pycacheDir: path.join(tmp, 'pyc'), cwd: path.join(tmp, 'neutral'), log: log.logger,
    env: childEnv(), shutdownGraceMs: 8000, ...extra,
  });
  client.onEvent((e) => events.push(e));
  clients.push(client);
  return { client, log, events, tmp };
}

async function withBoard<T>(opts: FakeBoardOptions, fn: (board: FakeBoardHandle) => Promise<T>): Promise<T> {
  const board = await startFakeBoard(opts);
  try {
    return await fn(board);
  } finally {
    await board.stop();
  }
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) { return false; }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('BridgeClient with the real bridge', () => {
  it('starts the bridge, speaks its protocol, connects to the fake board and reads its identity', { skip, timeout: 90000 }, async () => {
    await withBoard({ profile: 'esp32' }, async (board) => {
      const { client, events, log } = realClient();
      const hello = await client.start();
      assert.equal(hello.proto, 1);
      assert.equal(hello.vendored.mpremote, '1.29.0');
      assert.match(hello.python, /^3\.\d+/);
      assert.equal(client.status, 'ready');
      assert.deepEqual(await client.send('ping', {}).result, {});
      assert.ok(Array.isArray((await client.send('ports.list', {}).result).ports));
      const c = await client.send('connect', { port: board.url }).result;
      assert.equal(c.portInfo.kind, 'url');
      assert.ok(['idle', 'running'].includes(c.state));
      const id = await client.send('identity', { interrupt: true }).result;
      assert.equal(id.impl, 'micropython');
      assert.equal(id.platform, 'esp32');
      assert.ok(id.uniqueId.length > 0);
      assert.ok(events.some((e) => e.ev === 'state' && (e.state === 'idle' || e.state === 'running')));
      await client.send('disconnect', {}).result;
      const last = events.filter((e) => e.ev === 'state').at(-1);
      assert.ok(last && last.ev === 'state' && last.state === 'disconnected');
      assert.ok(log.lines.some((l) => /connection helper .* ready/.test(l)));
      assert.ok(!log.lines.some((l) => /ignored bad output/.test(l)), 'the protocol channel carried only JSON lines');
    });
  });

  it('uploads and downloads files whose local paths have spaces, parentheses and non-ASCII, byte for byte', { skip, timeout: 90000 }, async () => {
    await withBoard({ profile: 'esp32' }, async (board) => {
      const { client, tmp } = realClient();
      await client.send('connect', { port: board.url }).result;
      const folder = makeTrickyDir(tmp);
      const local = path.join(folder, 'übung (1) 中.py');
      const content = Buffer.from('# café 中\nprint("hello")\n'.repeat(200), 'utf8');
      fs.writeFileSync(local, content);
      const put = await client.send('fs.put', { local, remote: '/lab/uebung.py', interrupt: true }).result;
      assert.equal(put.bytes, content.length);
      assert.equal(put.skipped, false);
      const listing = await client.send('fs.list', { path: '/lab', interrupt: true }).result;
      assert.deepEqual(listing.entries.map((e) => e.name), ['uebung.py']);
      const back = path.join(folder, 'back (copy)', 'zurück.py');
      const got = await client.send('fs.get', { remote: '/lab/uebung.py', local: back, interrupt: true }).result;
      assert.equal(got.sha256, put.sha256);
      assert.ok(fs.readFileSync(back).equals(content));
      const again = await client.send('fs.put', { local, remote: '/lab/uebung.py', expectSha: put.sha256, interrupt: true }).result;
      assert.equal(again.skipped, true, 'unchanged content is not sent again');
    });
  });

  it('runs a program with output events, and Stop reaches a program that never ends', { skip, timeout: 90000 }, async () => {
    await withBoard({ profile: 'esp32' }, async (board) => {
      const { client, events } = realClient();
      await client.send('connect', { port: board.url }).result;
      const ok = await client.send('run', { source: "print('hello from the board')\n", name: 'main.py' }).result;
      assert.equal(ok.exit, 'ok');
      const text = events.filter((e) => e.ev === 'out').map((e) => (e.ev === 'out' ? dec(e.bytes) : '')).join('');
      assert.match(text, /hello from the board/);
      const loop = client.send('run', { source: 'import time\nwhile True:\n    time.sleep(0.05)\n', name: 'loop.py' });
      await until(() => events.some((e) => e.ev === 'state' && e.state === 'running'), 'the program to start', 20000);
      const stop = await client.send('stop', {}).result;
      assert.equal(stop.stopped, true);
      assert.equal((await loop.result).exit, 'interrupted');
    });
  });

  it('survives an unplug in the middle of an operation: the call fails with a code, the state says unplugged, the helper lives on', { skip, timeout: 90000 }, async () => {
    await withBoard({ profile: 'esp32', faults: ['unplug:exec'] }, async (board) => {
      const { client, events } = realClient();
      await client.send('connect', { port: board.url }).result;
      const err = await client.send('fs.list', { path: '/', interrupt: true }).result.then(() => null, (e: unknown) => e);
      assert.ok(err instanceof BoardError, String(err));
      assert.ok(['E_NO_DEVICE', 'E_BOARD_UNRESPONSIVE', 'E_NOT_CONNECTED'].includes(err.code), err.code);
      await until(() => events.some((e) => e.ev === 'state' && e.state === 'disconnected' && e.reason === 'unplugged'), 'the unplugged state event', 20000);
      assert.equal(client.status, 'ready');
      assert.deepEqual(await client.send('ping', {}).result, {});
      const after = await client.send('fs.list', { path: '/' }).result.then(() => null, (e: unknown) => e);
      assert.ok(after instanceof BoardError && ['E_NO_DEVICE', 'E_NOT_CONNECTED'].includes(after.code), `after the unplug: ${String(after)}`);
    });
  });

  it('reports a bridge killed from outside, then starts a new one on the next call', { skip, timeout: 90000 }, async () => {
    await withBoard({ profile: 'esp32' }, async (board) => {
      const { client, log } = realClient();
      await client.send('connect', { port: board.url }).result;
      const pid = client.pid;
      assert.ok(pid && alive(pid));
      const pending = client.send('run', { source: 'import time\nwhile True:\n    time.sleep(0.05)\n' });
      await new Promise((r) => setTimeout(r, 500));
      process.kill(pid, 'SIGKILL');
      const err = await pending.result.then(() => null, (e: unknown) => e);
      assert.ok(err instanceof BoardError && err.code === 'E_BRIDGE_EXITED', String(err));
      assert.equal(client.status, 'exited');
      assert.ok(log.lines.some((l) => /exited unexpectedly/.test(l)));
      const hello = await client.start();
      assert.notEqual(hello.pid, pid);
      assert.equal(client.status, 'ready');
      assert.deepEqual(await client.send('ping', {}).result, {});
      assert.equal((await client.send('fs.list', { path: '/' }).result.then(() => null, (e: unknown) => e) as BoardError).code, 'E_NOT_CONNECTED', 'a new helper starts disconnected');
    });
  });

  it('answers an unknown operation with a typed error and keeps going', { skip, timeout: 60000 }, async () => {
    const { client } = realClient();
    const err = await client.send('no.such.op' as never, {} as never).result.then(() => null, (e: unknown) => e);
    assert.ok(err instanceof BoardError && err.code === 'E_UNSUPPORTED');
    assert.deepEqual(await client.send('ping', {}).result, {});
  });

  it('close() while a program runs: EOF reaches the bridge, it leaves by itself, nothing is left behind', { skip, timeout: 90000 }, async () => {
    await withBoard({ profile: 'esp32' }, async (board) => {
      const { client, events } = realClient();
      await client.send('connect', { port: board.url }).result;
      const run = client.send('run', { source: 'import time\nwhile True:\n    time.sleep(0.05)\n' });
      run.result.catch(() => undefined);
      await until(() => events.some((e) => e.ev === 'state' && e.state === 'running'), 'the program to start', 20000);
      const pid = client.pid;
      assert.ok(pid);
      await client.close();
      await until(() => !alive(pid), 'the bridge process to be gone', 10000);
      assert.equal(client.status, 'stopped');
    });
  });
});
