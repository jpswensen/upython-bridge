/**
 * BridgeClient against a stub child process: framing, correlation, events, timeouts, abort, crash, restart policy, shutdown.
 * The real bridge is exercised in clientIntegration.test.ts.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { BridgeClient, type BridgeClientOptions } from '../../../src/bridge/client';
import type { BridgeEvent, BridgeStatus } from '../../../src/bridge/types';
import { BoardError, isBoardError } from '../../../src/types/session';
import { TempDirs, TRICKY_SEGMENTS } from '../../mocks/fixtures';
import { HELLO, MemoryLog, StubLauncher, until, type StubChild } from './stubChild';

const dirs = new TempDirs();
const clients: BridgeClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  dirs.cleanup();
});

function make(extra: Partial<BridgeClientOptions> = {}) {
  const tmp = dirs.make('upy-bridge-client');
  const launcher = new StubLauncher();
  const log = new MemoryLog();
  const client = new BridgeClient({
    resolvePython: async () => ({ command: '/opt/py/python3', prefixArgs: [] }),
    extensionPath: path.join(tmp, 'ext', ...TRICKY_SEGMENTS), pycacheDir: path.join(tmp, 'pyc'), cwd: path.join(tmp, 'neutral'),
    log: log.logger, launcher, env: { PATH: '/bin' }, startupTimeoutMs: 800, shutdownGraceMs: 150, ...extra,
  });
  clients.push(client);
  return { client, launcher, log, tmp };
}

/** Reply to every request of `op` with `result`. */
function autoReply(child: StubChild, results: Record<string, Record<string, unknown>>): void {
  child.onRequest = (req) => {
    const r = results[String(req.op)];
    if (r) { queueMicrotask(() => child.reply(req.id, r)); }
  };
}

async function rejection(p: Promise<unknown>): Promise<BoardError> {
  try { await p; } catch (e) { assert.ok(e instanceof BoardError, `expected a BoardError, got ${String(e)}`); return e; }
  throw new Error('expected a rejection');
}

describe('starting the process', () => {
  it('is lazy, and uses the documented argv, a neutral cwd and the inherited environment untouched', async () => {
    const { client, launcher, tmp } = make();
    assert.equal(launcher.children.length, 0);
    assert.equal(client.status, 'stopped');
    const hello = await client.start();
    assert.equal(hello.proto, 1);
    const spec = launcher.specs[0];
    assert.ok(spec);
    assert.equal(spec.command, '/opt/py/python3');
    assert.deepEqual(spec.args, ['-I', '-u', '-X', 'utf8', '-X', `pycache_prefix=${path.join(tmp, 'pyc')}`, path.join(tmp, 'ext', ...TRICKY_SEGMENTS, 'bridge', 'mpy_bridge.py')]);
    assert.equal(spec.cwd, path.join(tmp, 'neutral'));
    assert.deepEqual(spec.env, { PATH: '/bin' }, 'nothing is added to the environment (no MPY_SAFE_MODE of ours)');
    assert.equal(client.status, 'ready');
  });

  it('passes MPY_SAFE_MODE on only when the parent has it, and drops the macOS venv launcher variable', async () => {
    const { client, launcher } = make({ env: { PATH: '/bin', MPY_SAFE_MODE: '1', __PYVENV_LAUNCHER__: '/x' } });
    await client.start();
    assert.deepEqual(launcher.specs[0]?.env, { PATH: '/bin', MPY_SAFE_MODE: '1' });
  });

  it('puts the prefix arguments of a launcher such as "py -3" in front', async () => {
    const { client, launcher } = make({ resolvePython: async () => ({ command: 'C:\\Windows\\py.exe', prefixArgs: ['-3'] }) });
    await client.start();
    assert.equal(launcher.specs[0]?.command, 'C:\\Windows\\py.exe');
    assert.deepEqual(launcher.specs[0]?.args.slice(0, 3), ['-3', '-I', '-u']);
  });

  it('reports starting then ready and shares one start between concurrent callers', async () => {
    const { client, launcher } = make();
    const seen: BridgeStatus[] = [];
    client.onStatus((s) => seen.push(s));
    await Promise.all([client.start(), client.start(), client.start()]);
    assert.equal(launcher.children.length, 1);
    assert.deepEqual(seen.slice(0, 2), ['starting', 'ready']);
  });

  it('rejects a protocol version it does not speak and kills that process', async () => {
    const { client, launcher } = make();
    launcher.autoHello = { ...HELLO, proto: 2 };
    const err = await rejection(client.start());
    assert.equal(err.code, 'E_PROTOCOL');
    assert.match(err.message, /protocol version 2/);
    assert.ok(err.hint.length > 0);
    await until(() => launcher.last.killed > 0, 'the kill');
  });

  it('turns "Python cannot be started" into E_NO_PYTHON (spawn error and launch error)', async () => {
    const a = make();
    a.launcher.autoHello = null;
    a.launcher.onLaunch = (child) => queueMicrotask(() => child.error(Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' })));
    const e1 = await rejection(a.client.start());
    assert.equal(e1.code, 'E_NO_PYTHON');
    assert.match(e1.hint, /Doctor/);
    const b = make();
    b.launcher.launchError = new Error('EMFILE');
    assert.equal((await rejection(b.client.start())).code, 'E_NO_PYTHON');
  });

  it('passes an E_NO_PYTHON from discovery through unchanged and spawns nothing', async () => {
    const original = BoardError.of('E_NO_PYTHON', 'Python was not found.', { hint: 'Install it.' });
    const { client, launcher } = make({ resolvePython: async () => { throw original; } });
    const err = await rejection(client.send('ping', {}).result);
    assert.equal(err.code, 'E_NO_PYTHON');
    assert.equal(err.message, 'Python was not found.');
    assert.equal(launcher.children.length, 0);
  });

  it('explains an exit before the hello (stderr tail in the detail) and a fatal event', async () => {
    const a = make();
    a.launcher.autoHello = null;
    a.launcher.onLaunch = (child) => queueMicrotask(() => { child.stderr('SyntaxError: invalid syntax\n'); child.exit(1); });
    const e1 = await rejection(a.client.start());
    assert.equal(e1.code, 'E_BRIDGE_EXITED');
    assert.match(e1.detail, /exit code 1/);
    assert.match(e1.detail, /SyntaxError/);
    const b = make();
    b.launcher.autoHello = null;
    b.launcher.onLaunch = (child) => queueMicrotask(() => { child.say({ ev: 'fatal', message: 'cannot start the bridge: ImportError' }); child.exit(2); });
    const e2 = await rejection(b.client.start());
    assert.equal(e2.code, 'E_INTERNAL');
    assert.match(e2.message, /ImportError/);
  });

  it('gives up waiting for a hello after the startup timeout and kills the process', async () => {
    const { client, launcher } = make({ startupTimeoutMs: 60 });
    launcher.autoHello = null;
    const err = await rejection(client.start());
    assert.equal(err.code, 'E_BRIDGE_EXITED');
    assert.match(err.message, /did not start/);
    await until(() => launcher.last.killed > 0, 'the kill');
  });

  it('sends the setup requests of afterHello before the first queued request', async () => {
    const { client, launcher } = make({
      afterHello: async (api) => { await api.call('config', { stopOnDisconnect: true }); },
    });
    launcher.onLaunch = (child) => autoReply(child, { config: {}, ping: {} });
    await client.send('ping', {}).result;
    assert.deepEqual(launcher.last.requests().map((r) => r.op), ['config', 'ping']);
  });
});

describe('requests and responses', () => {
  it('matches answers to requests by id, in any order, with typed results', async () => {
    const { client, launcher } = make();
    await client.start();
    const child = launcher.last;
    const a = client.send('fs.list', { path: '/' });
    const b = client.send('fs.stat', { path: '/main.py' });
    const c = client.send('ping', {});
    await until(() => child.writes.length === 3, 'three requests');
    assert.ok(a.id < b.id && b.id < c.id);
    child.reply(c.id, {});
    child.reply(b.id, { exists: true, type: 'file', size: 3 });
    child.reply(a.id, { entries: [{ name: 'main.py', type: 'file', size: 3 }] });
    assert.deepEqual(await c.result, {});
    assert.equal((await b.result).exists, true);
    assert.equal((await a.result).entries[0]?.name, 'main.py');
    assert.deepEqual(child.requests().map((r) => r.op), ['fs.list', 'fs.stat', 'ping']);
  });

  it('rejects with a BoardError that carries code, hint, detail and the consent flags', async () => {
    const { client, launcher } = make();
    await client.start();
    const child = launcher.last;
    child.onRequest = (req) => child.fail(req.id, 'E_PROGRAM_RUNNING', 'A program is running.', { hint: 'Press Stop.', detail: 'state=running', needs_interrupt: true, sync: 'running-program' });
    const err = await rejection(client.send('fs.list', { path: '/' }).result);
    assert.equal(err.code, 'E_PROGRAM_RUNNING');
    assert.equal(err.hint, 'Press Stop.');
    assert.equal(err.detail, 'state=running');
    assert.equal(err.needsInterrupt, true);
    assert.equal(err.op, 'fs.list');
    child.onRequest = (req) => child.fail(req.id, 'E_FS_ERRNO', 'No.', { needs_allow_mount: true, mount_reason: 'dev' });
    assert.equal((await rejection(client.send('fs.rmtree', { path: '/flash', confirm: true }).result)).needsAllowMount, true);
  });

  it('handles lines split in the middle of a character and several answers in one chunk', async () => {
    const { client, launcher } = make();
    await client.start();
    const child = launcher.last;
    const p1 = client.send('exec', { code: 'x' });
    const p2 = client.send('exec', { code: 'y' });
    await until(() => child.writes.length === 2, 'requests');
    const text = `${JSON.stringify({ id: p1.id, ok: true, out: 'gr\u00fc\u00dfe \u4e2d', err: '' })}\n${JSON.stringify({ id: p2.id, ok: true, out: 'b', err: '' })}\n`;
    const bytes = new TextEncoder().encode(text);
    child.stdout(bytes.subarray(0, 40));
    child.stdout(bytes.subarray(40, 41));
    child.stdout(bytes.subarray(41));
    assert.equal((await p1.result).out, 'gr\u00fc\u00dfe \u4e2d');
    assert.equal((await p2.result).out, 'b');
  });

  it('refuses to send a request over the 4 MiB limit and writes nothing', async () => {
    const { client, launcher } = make();
    await client.start();
    const err = await rejection(client.send('tty.write', { b64: 'A'.repeat(4 * 1024 * 1024 + 10) }).result);
    assert.equal(err.code, 'E_PROTOCOL');
    assert.equal(launcher.last.writes.length, 0);
  });

  it('turns a broken pipe into E_BRIDGE_EXITED and kills the process', async () => {
    const { client, launcher } = make();
    await client.start();
    launcher.last.writeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const err = await rejection(client.send('ping', {}).result);
    assert.equal(err.code, 'E_BRIDGE_EXITED');
    assert.ok(launcher.last.killed > 0);
  });
});

describe('events', () => {
  it('delivers repl/out/err bytes, state, progress, hello and log events in order, and logs bridge output', async () => {
    const { client, launcher, log } = make();
    const seen: BridgeEvent[] = [];
    client.onEvent((e) => seen.push(e));
    await client.start();
    const child = launcher.last;
    child.say({ ev: 'state', state: 'connecting', prev: 'disconnected', port: '/dev/cu.x' });
    child.say({ ev: 'out', b64: Buffer.from('hello\r\n').toString('base64') });
    child.say({ ev: 'err', b64: Buffer.from('Traceback').toString('base64') });
    child.say({ ev: 'repl', b64: Buffer.from('>>> ').toString('base64') });
    child.say({ ev: 'progress', id: 9, label: 'main.py', done: 1, total: 4 });
    child.say({ ev: 'log', level: 'warn', msg: 'careful' });
    child.stderr('[info] connected to x\n[error] bad thing\nplain line\n');
    assert.deepEqual(seen.map((e) => e.ev), ['hello', 'state', 'out', 'err', 'repl', 'progress', 'log']);
    const out = seen.find((e) => e.ev === 'out');
    assert.ok(out && out.ev === 'out' && new TextDecoder().decode(out.bytes) === 'hello\r\n');
    assert.ok(log.lines.some((l) => /WARN .*careful/.test(l)), 'a bridge log event reaches the log with its level');
    assert.ok(log.lines.some((l) => /INFO .*connected to x/.test(l)));
    assert.ok(log.lines.some((l) => /ERROR .*bad thing/.test(l)));
    assert.ok(log.lines.some((l) => /INFO .*plain line/.test(l)));
  });

  it('isolates a listener that throws: the others still get the event and the failure is logged', async () => {
    const { client, launcher, log } = make();
    const seen: string[] = [];
    client.onEvent(() => { throw new Error('listener bug'); });
    client.onEvent((e) => seen.push(e.ev));
    await client.start();
    launcher.last.say({ ev: 'log', level: 'info', msg: 'x' });
    assert.ok(seen.includes('log'));
    assert.ok(log.has(/listener bug/));
  });

  it('skips malformed output, keeps working, and stops a helper that only sends garbage', async () => {
    const { client, launcher, log } = make({ maxBadLines: 5 });
    await client.start();
    const child = launcher.last;
    child.stdout('this is not json\n{"ev":"nope"}\n[1]\n');
    const p = client.send('ping', {});
    await until(() => child.writes.length === 1, 'request');
    child.reply(p.id);
    assert.deepEqual(await p.result, {});
    assert.ok(log.has(/ignored bad output/));
    const q = client.send('ping', {});
    await until(() => child.writes.length === 2, 'second request');
    child.stdout('x\n'.repeat(10));
    const err = await rejection(q.result);
    assert.equal(err.code, 'E_PROTOCOL');
    assert.ok(child.killed > 0);
  });
});

describe('timeouts and cancellation', () => {
  it('rejects with E_CALL_TIMEOUT, asks the bridge to cancel that request, and ignores the late answer', async () => {
    const { client, launcher, log } = make();
    await client.start();
    const child = launcher.last;
    const p = client.send('fs.manifest', { root: '/' }, { timeoutMs: 40 });
    const err = await rejection(p.result);
    assert.equal(err.code, 'E_CALL_TIMEOUT');
    assert.match(err.hint, /cable/);
    await until(() => child.requestsOf('cancel').length === 1, 'cancel request');
    assert.equal(child.requestsOf('cancel')[0]?.target, p.id);
    child.reply(p.id, { entries: [] }); // late
    assert.ok(log.has(/nobody waits for/));
  });

  it('applies a default limit to quick ops (ping) but none to long ones', async () => {
    const { client, launcher } = make();
    await client.start();
    // no timeout configured for fs.get: it is still pending after a while; resolve it ourselves
    const p = client.send('fs.get', { remote: '/a', local: '/tmp/a' });
    await new Promise((r) => setTimeout(r, 60));
    launcher.last.reply(p.id, { bytes: 1, sha256: 'x', verified: 'sha256' });
    assert.equal((await p.result).bytes, 1);
  });

  it('rejects with E_ABORTED when the signal fires and sends cancel; a signal that is already aborted writes nothing', async () => {
    const { client, launcher } = make();
    await client.start();
    const child = launcher.last;
    const ac = new AbortController();
    const p = client.send('fs.put', { local: '/a', remote: '/a' }, { signal: ac.signal });
    await until(() => child.writes.length === 1, 'request');
    ac.abort();
    assert.equal((await rejection(p.result)).code, 'E_ABORTED');
    await until(() => child.requestsOf('cancel').length === 1, 'cancel');
    const done = new AbortController();
    done.abort();
    const n = child.writes.length;
    assert.equal((await rejection(client.send('ping', {}, { signal: done.signal }).result)).code, 'E_ABORTED');
    assert.equal(child.writes.length, n);
  });
});

describe('crash, restart and shutdown', () => {
  it('rejects pending calls with E_BRIDGE_EXITED when the process dies, reports the exit, and restarts on next use', async () => {
    const { client, launcher } = make();
    const exits: string[] = [];
    client.onStatus((s, info) => { if (s === 'exited') { exits.push(`${String(info?.code)}/${String(info?.expected)}/${info?.stderrTail.join('|') ?? ''}`); } });
    await client.start();
    const first = launcher.last;
    const p = client.send('run', { source: 'print(1)' });
    await until(() => first.writes.length === 1, 'request');
    first.stderr('[error] boom\n');
    first.exit(1);
    const err = await rejection(p.result);
    assert.equal(err.code, 'E_BRIDGE_EXITED');
    assert.match(err.detail, /exit code 1/);
    assert.equal(client.status, 'exited');
    assert.deepEqual(exits, ['1/false/[error] boom']);
    const again = client.send('ping', {});
    await until(() => launcher.children.length === 2, 'the restart');
    await until(() => launcher.last.writes.length === 1, 'the request on the new process');
    launcher.last.reply(again.id);
    await again.result;
    assert.equal(client.status, 'ready');
  });

  it('stops restarting after too many crashes in the window, with the Doctor hint, until the budget is reset', async () => {
    const { client, launcher } = make({ restart: { maxRestarts: 2, windowMs: 60000 } });
    launcher.onLaunch = (child) => queueMicrotask(() => child.exit(3)); // dies right after its hello
    for (let i = 0; i < 3; i++) {
      await client.send('ping', {}).result.catch(() => undefined);
      await until(() => client.status === 'exited', 'exit');
    }
    assert.equal(launcher.children.length, 3);
    const err = await rejection(client.send('ping', {}).result);
    assert.equal(err.code, 'E_INTERNAL');
    assert.match(err.hint, /Doctor/);
    assert.equal(launcher.children.length, 3, 'no fourth process');
    client.resetRestartBudget();
    launcher.onLaunch = undefined;
    await client.start();
    assert.equal(launcher.children.length, 4);
  });

  it('close(): closes stdin, waits for a polite exit without killing, rejects pending calls, and is idempotent', async () => {
    const { client, launcher } = make();
    await client.start();
    const child = launcher.last;
    const p = client.send('run', { source: 'x' });
    await until(() => child.writes.length === 1, 'request');
    await client.close();
    assert.equal(child.stdinEnded, true);
    assert.equal(child.killed, 0);
    assert.equal((await rejection(p.result)).code, 'E_BRIDGE_EXITED');
    assert.equal(client.status, 'stopped');
    await client.close();
    assert.equal((await rejection(client.send('ping', {}).result)).code, 'E_BRIDGE_EXITED');
    assert.equal(launcher.children.length, 1);
  });

  it('close(): kills the tree when the process ignores the end of its input', async () => {
    const { client, launcher } = make({ shutdownGraceMs: 40 });
    await client.start();
    launcher.last.exitOnEof = false;
    await client.close();
    assert.equal(launcher.last.stdinEnded, true);
    assert.equal(launcher.last.killed, 1);
  });

  it('stopProcess() allows a later start; dispose() stops it for good', async () => {
    const { client, launcher } = make();
    await client.start();
    await client.stopProcess();
    assert.equal(client.status, 'stopped');
    await client.start();
    assert.equal(launcher.children.length, 2);
    client.dispose();
    await until(() => launcher.last.exited, 'exit after dispose');
    assert.ok(isBoardError(await client.start().catch((e: unknown) => e), 'E_BRIDGE_EXITED'));
  });
});
