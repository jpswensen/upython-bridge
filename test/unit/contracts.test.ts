/**
 * Contract checks for src/types: compile-time (`@ts-expect-error` lines fail `npm run typecheck` when a bad call stops being an
 * error) and cross-language (the TypeScript mirror against the Python bridge's own op table and error codes).
 * Drift rule: a name that TypeScript declares and the bridge does not know FAILS (typo or removed op); a name the bridge has and
 * TypeScript lacks only prints a diagnostic (a new op waiting to be mirrored must not block everyone else's tests).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BOARD_STATES, BRIDGE_ERROR_CODES, BYPASS_OPS, CLIENT_ERROR_CODES, OP_NAMES, type OpMap, type OpName } from '../../src/types/protocol';
import { initialSessionState, type BoardSession } from '../../src/types/session';
import { projectRoot } from '../mocks/fixtures';

declare const session: BoardSession;

/** Never called: only compiled. Each `@ts-expect-error` must stay an error. */
export function compileTimeContract(): void {
  void session.call('run', { local: '/ws/main.py' });
  void session.call('run', { source: 'print(1)', name: 'main.py', stdin: true });
  void session.call('fs.rmtree', { path: '/old', confirm: true, allowMount: false });
  void session.call('reset.hard', { confirmed: true, verify: true });
  // @ts-expect-error run needs a local path or a source
  void session.call('run', {});
  // @ts-expect-error unknown op
  void session.call('fs.nope', {});
  // @ts-expect-error confirm must be literally true
  void session.call('fs.rmtree', { path: '/old', confirm: false });
  // @ts-expect-error a hard reset needs confirmed
  void session.call('reset.hard', {});
  // @ts-expect-error fs.put needs both paths
  void session.call('fs.put', { local: '/ws/a.py' });
  // @ts-expect-error baud is a number
  void session.connect('COM3', { baud: 'fast' });
}

const ALL_OPS: Record<OpName, true> = {
  'ping': true, 'ports.list': true, 'connect': true, 'disconnect': true, 'identity': true, 'fs.list': true, 'fs.manifest': true,
  'fs.stat': true, 'fs.put': true, 'fs.get': true, 'fs.rm': true, 'fs.rmtree': true, 'fs.mkdir': true, 'fs.mv': true, 'run': true,
  'stop': true, 'reset.soft': true, 'reset.capability': true, 'reset.machine': true, 'reset.hard': true, 'repl.attach': true,
  'repl.detach': true, 'tty.write': true, 'introspect.modules': true, 'exec': true, 'config': true, 'cancel': true, 'shutdown': true,
  'clock.read': true, 'clock.set': true,
};

function read(rel: string): string | undefined {
  const file = path.join(projectRoot(), rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

describe('protocol mirror', () => {
  it('lists every OpMap key in OP_NAMES and the bypass ops are real ops', () => {
    const mapKeys: (keyof OpMap)[] = Object.keys(ALL_OPS) as (keyof OpMap)[];
    assert.deepEqual([...OP_NAMES].sort(), mapKeys.sort());
    for (const op of BYPASS_OPS) { assert.ok(OP_NAMES.includes(op)); }
  });

  it('has the five board states and no overlap between bridge and client error codes', () => {
    assert.deepEqual([...BOARD_STATES], ['disconnected', 'connecting', 'idle', 'running', 'rawop']);
    for (const c of CLIENT_ERROR_CODES) { assert.ok(!(BRIDGE_ERROR_CODES as readonly string[]).includes(c)); }
    assert.equal(initialSessionState().state, 'disconnected');
  });

  it('declares only ops that the Python bridge implements (bridge/server.py op table)', (t) => {
    const src = read('bridge/server.py');
    if (src === undefined) { t.skip('bridge/server.py not found'); return; }
    const bridgeOps = new Set([...src.matchAll(/^\s+"([a-z_.]+)":\s*\("op_/gm)].map((m) => m[1] as string).filter((n) => !n.startsWith('_')));
    assert.ok(bridgeOps.size > 20, `parsed only ${bridgeOps.size} ops from bridge/server.py: the table format changed`);
    const unknown = OP_NAMES.filter((op) => !bridgeOps.has(op));
    assert.deepEqual(unknown, [], `ops declared in src/types/protocol.ts but not implemented by the bridge: ${unknown.join(', ')}`);
    const unmirrored = [...bridgeOps].filter((op) => !OP_NAMES.includes(op as OpName));
    if (unmirrored.length > 0) { t.diagnostic(`bridge ops not yet mirrored in src/types/protocol.ts: ${unmirrored.join(', ')}`); }
  });

  it('declares only error codes that the Python bridge knows (bridge/errors.py)', (t) => {
    const src = read('bridge/errors.py');
    if (src === undefined) { t.skip('bridge/errors.py not found'); return; }
    const bridgeCodes = new Set([...src.matchAll(/"(E_[A-Z_]+)"/g)].map((m) => m[1] as string));
    assert.ok(bridgeCodes.size > 10, `parsed only ${bridgeCodes.size} codes from bridge/errors.py`);
    const unknown = BRIDGE_ERROR_CODES.filter((c) => !bridgeCodes.has(c));
    assert.deepEqual(unknown, [], `codes declared in src/types/protocol.ts but unknown to the bridge: ${unknown.join(', ')}`);
    const unmirrored = [...bridgeCodes].filter((c) => !(BRIDGE_ERROR_CODES as readonly string[]).includes(c));
    if (unmirrored.length > 0) { t.diagnostic(`bridge error codes not yet mirrored: ${unmirrored.join(', ')}`); }
  });

  it('keeps the compile-time contract function in the bundle', () => {
    assert.equal(typeof compileTimeContract, 'function');
  });
});
