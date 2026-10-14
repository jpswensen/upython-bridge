/**
 * Proves the Node-side harness for the real Python bridge: a fake board over TCP and the bridge process, started with argv
 * arrays under MPY_SAFE_MODE=1, talk NDJSON, and both are gone afterwards. Never opens a serial port (the bridge itself refuses
 * anything but a loopback socket URL in safe mode). Skipped, with the reason, when no Python >= 3.9 is available.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { StateEvent } from '../../src/types/protocol';
import { RawBridge, RawBridgeError, bridgeSpawnSpec, childEnv, integrationSkipReason, liveProcessCount, startFakeBoard, stopAll, withBridge } from '../mocks/fakeBridge';

const skip = integrationSkipReason();

afterEach(async () => {
  await stopAll();
});

describe('fakeBridge helpers', () => {
  it('forces safe mode and never passes a real port', () => {
    process.env.MPY_REAL_PORT = '/dev/cu.should-not-leak';
    try {
      const env = childEnv();
      assert.equal(env.MPY_SAFE_MODE, '1');
      assert.equal(env.MPY_REAL_PORT, undefined);
    } finally {
      delete process.env.MPY_REAL_PORT;
    }
  });

  it('builds the bridge argv like the extension will (isolated, unbuffered, UTF-8, pycache prefix, no shell)', { skip }, () => {
    const spec = bridgeSpawnSpec('/tmp/neutral', '/tmp/pyc');
    assert.deepEqual(spec.args.slice(0, 6), ['-I', '-B', '-u', '-X', 'utf8', '-X']);
    assert.equal(spec.args[6], 'pycache_prefix=/tmp/pyc');
    assert.ok(spec.args[7]?.endsWith('mpy_bridge.py'));
    assert.equal(spec.env.MPY_SAFE_MODE, '1');
  });
});

describe('real bridge against a real fake board', () => {
  it('says hello, lists ports, connects over the loopback URL, probes identity, lists files and disconnects', { skip, timeout: 90000 }, async () => {
    await withBridge(async ({ board, bridge }) => {
      const hello = bridge.events.find((e) => e.ev === 'hello');
      assert.ok(hello && hello.ev === 'hello');
      assert.equal(hello.proto, 1);
      assert.match(board.url, /^socket:\/\/127\.0\.0\.1:\d+$/);

      await bridge.call('ping', {});
      assert.ok(Array.isArray((await bridge.call('ports.list', {})).ports));

      const connected = await bridge.call('connect', { port: board.url });
      assert.ok(['idle', 'running', 'unknown'].includes(connected.state));
      assert.equal(connected.portInfo.kind, 'url');

      const id = await bridge.call('identity', { interrupt: true });
      assert.equal(id.impl, 'micropython');
      assert.ok(Array.isArray(id.version) && id.version.length === 3);
      assert.ok(typeof id.uniqueId === 'string');

      const listing = await bridge.call('fs.list', { path: '/', interrupt: true });
      assert.ok(Array.isArray(listing.entries));

      await bridge.call('disconnect', {});
      const states = bridge.events.filter((e): e is StateEvent => e.ev === 'state').map((e) => e.state);
      assert.ok(states.includes('connecting'));
      assert.equal(states[states.length - 1], 'disconnected');
      assert.deepEqual(bridge.badStdout, [], 'the protocol channel must carry only JSON lines');
    });
    assert.equal(liveProcessCount(), 0, 'every started process must be gone');
  });

  it('refuses a device-looking path in safe mode (E_SAFE_MODE) and exits when its stdin closes', { skip, timeout: 60000 }, async () => {
    const bridge = await RawBridge.start();
    try {
      await assert.rejects(
        bridge.call('connect', { port: '/dev/cu.upy-bridge-test-nonexistent' }), // a made-up name: never a real device
        (e: unknown) => e instanceof RawBridgeError && e.code === 'E_SAFE_MODE',
      );
    } finally {
      await bridge.stop();
    }
    assert.equal(bridge.exited, true);
    assert.equal(liveProcessCount(), 0);
  });

  it('starts and stops a fake board on its own', { skip, timeout: 60000 }, async () => {
    const board = await startFakeBoard({ profile: 'esp32' });
    assert.ok(board.pid > 0);
    await board.stop();
    assert.equal(liveProcessCount(), 0);
  });
});
