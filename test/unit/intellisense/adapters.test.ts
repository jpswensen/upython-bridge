import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { IDENTITY } from '../../../src/identity';
import { runFix, removeManaged } from '../../../src/intellisense/fix';
import { nodeClock, nodeFs } from '../../../src/intellisense/nodeAdapters';
import { writeIfChanged } from '../../../src/intellisense/atomicFs';
import { TempDirs, makeTrickyDir } from '../../mocks/fixtures';
import { RESOURCES_STUBS } from './memfs';

const dirs = new TempDirs();
afterEach(() => dirs.cleanup());

describe('Node adapters on the real file system', () => {
  it('sets up, re-runs and removes in a OneDrive-style folder with spaces, parentheses and non-ASCII, leaving no temp files', async () => {
    const base = dirs.make('real');
    const ws = makeTrickyDir(nodePath.join(base, 'ws'));
    fs.mkdirSync(nodePath.join(ws, 'lib'), { recursive: true });
    fs.writeFileSync(nodePath.join(ws, 'lib', 'helper.py'), 'X = 1\n');
    fs.writeFileSync(nodePath.join(ws, 'main.py'), 'print(1)\n');
    const deps = { fs: nodeFs(), clock: nodeClock() };
    const board = { impl: 'micropython', version: [1, 29, 0] as [number, number, number], machine: 'x with ESP32', build: 'ACME_BOARD', platform: 'esp32', uniqueId: '1' };
    const req = { workspace: ws, resourcesDir: RESOURCES_STUBS, board, consent: { createUserConfig: true } };
    const first = await runFix(deps, req, { apply: true });
    assert.deepEqual(first.result!.errors, []);
    assert.ok(fs.existsSync(nodePath.join(ws, IDENTITY.dotDir, 'stubs', 'active', 'machine.pyi')));
    assert.ok(fs.existsSync(nodePath.join(ws, 'pyrightconfig.json')));
    const files: string[] = [];
    const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = nodePath.join(d, e.name); if (e.isDirectory()) { walk(p); } else { files.push(p); } } };
    walk(ws);
    assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), [], 'no temp file is left behind');
    const second = await runFix(deps, req, { apply: true });
    assert.deepEqual(second.plan.writes, []);
    assert.deepEqual(second.result!.written, []);
    const removed = await removeManaged(deps.fs, deps.clock, ws);
    assert.deepEqual(removed.errors, []);
    assert.ok(!fs.existsSync(nodePath.join(ws, IDENTITY.dotDir)) && !fs.existsSync(nodePath.join(ws, 'pyrightconfig.json')));
    assert.ok(fs.existsSync(nodePath.join(ws, 'lib', 'helper.py')) && fs.existsSync(nodePath.join(ws, 'main.py')), 'the student files are never touched');
  });

  it('writeIfChanged leaves an identical file alone (same mtime)', async () => {
    const dir = dirs.make('atomic');
    const file = nodePath.join(dir, 'sub', 'x.json');
    const deps = { fs: nodeFs(), clock: nodeClock() };
    assert.equal((await writeIfChanged(deps.fs, deps.clock, file, '{"a":1}\n')).written, true);
    const m1 = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    assert.equal((await writeIfChanged(deps.fs, deps.clock, file, '{"a":1}\n')).written, false);
    assert.equal(fs.statSync(file).mtimeMs, m1);
    assert.equal((await writeIfChanged(deps.fs, deps.clock, file, '{"a":2}\n')).written, true);
  });
});
