/** Baseline: atomic writes (injected EBUSY), schema, board keys, serialised updates, per-file records, nothing absolute stored. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { nodeAtomicIo, writeFileAtomic, type AtomicIo } from '../../src/sync/atomic';
import { BASELINE_VERSION, BaselineStore, boardKeyOf, sha256Hex, workspaceKeyOf } from '../../src/sync/baseline';
import { makeTrickyDir, TempDirs } from '../mocks/fixtures';

const dirs = new TempDirs();
afterEach(() => dirs.cleanup());

const noSleep: Partial<AtomicIo> = { sleep: async () => undefined };

function busy(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: resource busy or locked`), { code });
}

describe('writeFileAtomic', () => {
  it('writes through a temp file in the same folder and leaves no temp file behind', async () => {
    const dir = dirs.make();
    const target = path.join(dir, 'sub', 'state.json');
    await writeFileAtomic(target, 'hello');
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), ['state.json']);
  });

  it('retries a locked rename (EBUSY, EPERM) and then succeeds', async () => {
    const dir = dirs.make();
    const target = path.join(dir, 'f.json');
    let failures = 2;
    const io: AtomicIo = { ...nodeAtomicIo, ...noSleep, rename: async (a, b) => {
      if (failures-- > 0) { throw busy(failures === 1 ? 'EBUSY' : 'EPERM'); }
      await nodeAtomicIo.rename(a, b);
    } } as AtomicIo;
    await writeFileAtomic(target, 'v1', { io });
    assert.equal(fs.readFileSync(target, 'utf8'), 'v1');
    assert.equal(failures, -1);
  });

  it('gives up after the retries, keeps the old content and removes the temp file', async () => {
    const dir = dirs.make();
    const target = path.join(dir, 'f.json');
    fs.writeFileSync(target, 'old');
    let attempts = 0;
    const io = { ...nodeAtomicIo, ...noSleep, rename: async () => { attempts++; throw busy('EBUSY'); } } as AtomicIo;
    await assert.rejects(writeFileAtomic(target, 'new', { io, retries: 3 }), /EBUSY/);
    assert.equal(attempts, 4);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), ['f.json']);
  });

  it('does not retry errors that will not go away', async () => {
    const dir = dirs.make();
    let attempts = 0;
    const io = { ...nodeAtomicIo, ...noSleep, writeFile: async () => { attempts++; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } as AtomicIo;
    await assert.rejects(writeFileAtomic(path.join(dir, 'f'), 'x', { io }), /disk full/);
    assert.equal(attempts, 1);
  });
});

describe('board and workspace keys', () => {
  it('uses the unique id when the board has one', () => {
    assert.deepEqual(boardKeyOf({ uniqueId: 'AABB01', machine: 'm', build: '', impl: 'micropython' }), { id: 'aabb01', derived: false });
  });

  it('derives a stable key from the model when there is no unique id, and says so', () => {
    const a = boardKeyOf({ uniqueId: '', machine: 'RP2040', build: '', impl: 'micropython' });
    const b = boardKeyOf({ uniqueId: '', machine: 'RP2040', build: '', impl: 'micropython' });
    const c = boardKeyOf({ uniqueId: '', machine: 'ESP8266', build: '', impl: 'micropython' });
    assert.equal(a.derived, true);
    assert.deepEqual(a, b);
    assert.notEqual(a.id, c.id);
    assert.match(boardKeyOf(null).id, /^no-id-/);
  });

  it('keys a workspace by its folder URI', () => {
    assert.notEqual(workspaceKeyOf('file:///a'), workspaceKeyOf('file:///b'));
    assert.equal(workspaceKeyOf('file:///a').length, 16);
  });
});

describe('BaselineStore', () => {
  const board = { id: 'aabbccddeeff', derived: false };
  const other = { id: '112233445566', derived: false };
  const h = (t: string): string => sha256Hex(t);

  function store(extra: { warn?: (m: string) => void; io?: AtomicIo } = {}): { s: BaselineStore; storage: string } {
    const storage = path.join(makeTrickyDir(dirs.make()), 'storage');
    return { s: new BaselineStore(storage, workspaceKeyOf('file:///ws'), { now: () => new Date('2026-10-13T10:00:00Z'), ...extra }), storage };
  }

  it('starts empty and keeps one file per board', async () => {
    const { s } = store();
    assert.deepEqual((await s.load(board)).files, {});
    await s.record(board, [{ path: 'main.py', sha256: h('a'), size: 1 }]);
    await s.record(other, [{ path: 'main.py', sha256: h('b'), size: 1 }]);
    assert.equal((await s.load(board)).files['main.py']?.sha256, h('a'));
    assert.equal((await s.load(other)).files['main.py']?.sha256, h('b'));
    assert.notEqual(s.fileFor(board), s.fileFor(other));
  });

  it('stores only relative paths, hashes, sizes and times: nothing absolute, no mtime', async () => {
    const { s, storage } = store();
    await s.record(board, [{ path: 'lib/café (v2).py', sha256: h('x'), size: 5 }]);
    const text = fs.readFileSync(s.fileFor(board), 'utf8');
    const doc = JSON.parse(text) as { version: number; boardId: string; files: Record<string, Record<string, unknown>> };
    assert.equal(doc.version, BASELINE_VERSION);
    assert.equal(doc.boardId, board.id);
    assert.deepEqual(Object.keys(doc.files['lib/café (v2).py'] ?? {}).sort(), ['sha256', 'size', 'syncedAt']);
    assert.equal(text.includes(storage), false);
    assert.equal(text.includes('mtime'), false);
    assert.equal(doc.files['lib/café (v2).py']?.syncedAt, '2026-10-13T10:00:00.000Z');
  });

  it('records only the files it is given and forgets only the files it is told to', async () => {
    const { s } = store();
    await s.record(board, [{ path: 'a.py', sha256: h('a'), size: 1 }, { path: 'b.py', sha256: h('b'), size: 1 }]);
    await s.record(board, [{ path: 'a.py', sha256: h('a2'), size: 2 }], ['b.py']);
    const files = (await s.load(board)).files;
    assert.deepEqual(Object.keys(files), ['a.py']);
    assert.equal(files['a.py']?.sha256, h('a2'));
  });

  it('serialises concurrent updates so none is lost', async () => {
    const { s } = store();
    await Promise.all(Array.from({ length: 12 }, (_, i) => s.record(board, [{ path: `f${i}.py`, sha256: h(String(i)), size: i }])));
    assert.equal(Object.keys((await s.load(board)).files).length, 12);
  });

  it('renames and forgets whole folders', async () => {
    const { s } = store();
    await s.record(board, [{ path: 'lib/a.py', sha256: h('a'), size: 1 }, { path: 'lib/x/b.py', sha256: h('b'), size: 1 }, { path: 'main.py', sha256: h('m'), size: 1 }]);
    await s.rename(board, 'lib', 'pkg');
    assert.deepEqual(Object.keys((await s.load(board)).files).sort(), ['main.py', 'pkg/a.py', 'pkg/x/b.py']);
    await s.forgetUnder(board, 'pkg');
    assert.deepEqual(Object.keys((await s.load(board)).files), ['main.py']);
  });

  it('keeps an unreadable file aside instead of losing or trusting it, and warns', async () => {
    const warnings: string[] = [];
    const { s } = store({ warn: (m) => warnings.push(m) });
    await s.record(board, [{ path: 'a.py', sha256: h('a'), size: 1 }]);
    fs.writeFileSync(s.fileFor(board), '{ not json');
    assert.deepEqual((await s.load(board)).files, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /fresh history/);
    const kept = fs.readdirSync(path.dirname(s.fileFor(board))).filter((n) => n.includes('.unreadable-'));
    assert.equal(kept.length, 1);
  });

  it('does not trust a file written by a newer format or for another board', async () => {
    const warnings: string[] = [];
    const { s } = store({ warn: (m) => warnings.push(m) });
    await s.record(board, [{ path: 'a.py', sha256: h('a'), size: 1 }]);
    const doc = JSON.parse(fs.readFileSync(s.fileFor(board), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(s.fileFor(board), JSON.stringify({ ...doc, version: 2 }));
    assert.deepEqual((await s.load(board)).files, {});
    assert.match(warnings[0] ?? '', /format version is 2/);
  });

  it('drops malformed entries but keeps the good ones', async () => {
    const { s } = store();
    await s.record(board, [{ path: 'good.py', sha256: h('g'), size: 1 }]);
    const doc = JSON.parse(fs.readFileSync(s.fileFor(board), 'utf8')) as { files: Record<string, unknown> };
    doc.files['bad.py'] = { sha256: 'xyz', size: 1 };
    doc.files['worse.py'] = 'nope';
    fs.writeFileSync(s.fileFor(board), JSON.stringify(doc));
    assert.deepEqual(Object.keys((await s.load(board)).files), ['good.py']);
  });

  it('survives a locked rename during a save (cloud client or antivirus)', async () => {
    let failures = 2;
    const io = { ...nodeAtomicIo, ...noSleep, rename: async (a: string, b: string) => {
      if (failures-- > 0) { throw busy('EBUSY'); }
      await nodeAtomicIo.rename(a, b);
    } } as AtomicIo;
    const { s } = store({ io });
    await s.record(board, [{ path: 'a.py', sha256: h('a'), size: 1 }]);
    assert.equal((await s.load(board)).files['a.py']?.size, 1);
  });

  it('leaves the old baseline intact when a save finally fails', async () => {
    const { s: good, storage } = store();
    await good.record(board, [{ path: 'a.py', sha256: h('a'), size: 1 }]);
    const io = { ...nodeAtomicIo, ...noSleep, rename: async () => { throw busy('EPERM'); } } as AtomicIo;
    const bad = new BaselineStore(storage, workspaceKeyOf('file:///ws'), { io });
    await assert.rejects(bad.record(board, [{ path: 'a.py', sha256: h('changed'), size: 9 }]), /EPERM/);
    assert.equal((await good.load(board)).files['a.py']?.sha256, h('a'));
  });
});
