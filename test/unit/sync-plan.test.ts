/**
 * The planner's decision table (docs/analysis/03-fs-sync.md 6.4), both directions, hash-less boards, guards.
 * Pure data in, plan out: no board, no disk, no vscode.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { actionable, buildPlan, countPlan, effectiveAction, type PlanBoardEntry, type PlanInput, type PlanLocalFile } from '../../src/sync/plan';
import type { SyncDirection, SyncItem } from '../../src/types/sync';
import { WINDOWS } from '../mocks/fixtures';
import { sha } from './sync/kit';

const WS = '/work/project';
const lf = (rel: string, text: string): PlanLocalFile => ({ path: rel, abs: `${WS}/${rel}`, size: Buffer.byteLength(text), sha256: sha(text) });
const bf = (rel: string, text: string | undefined, root = '', hash = true): PlanBoardEntry => ({
  remote: `${root}/${rel}`, type: 'file', size: text === undefined ? 0 : Buffer.byteLength(text), sha256: hash && text !== undefined ? sha(text) : undefined,
});
const base = (text: string): { sha256: string; size: number; syncedAt: string } => ({ sha256: sha(text), size: Buffer.byteLength(text), syncedAt: 't' });

function plan(direction: SyncDirection, over: Partial<PlanInput>): ReturnType<typeof buildPlan> {
  return buildPlan({
    direction, workspaceRoot: WS, rootPath: '/', boardId: 'abc', local: [], board: [], boardHash: 'sha256', baseline: {},
    flavor: path.posix, localCaseInsensitive: false, now: new Date('2026-10-13T00:00:00Z'), ...over,
  });
}

function one(direction: SyncDirection, over: Partial<PlanInput>): SyncItem {
  const out = plan(direction, over);
  assert.equal(out.plan.items.length, 1, JSON.stringify(out.plan.items.map((i) => [i.path, i.action, i.reason])));
  return out.plan.items[0] as SyncItem;
}

const row = (it: SyncItem): [string, string, boolean] => [it.action, it.reason, it.selected];

describe('plan: Local to Board', () => {
  const up = (over: Partial<PlanInput>): SyncItem => one('toBoard', over);

  it('same content on both sides is unchanged', () => {
    assert.deepEqual(row(up({ local: [lf('a.py', 'x')], board: [bf('a.py', 'x')] })), ['unchanged', 'identical', true]);
  });
  it('a new local file is uploaded', () => {
    assert.deepEqual(row(up({ local: [lf('a.py', 'x')] })), ['upload', 'new-local', true]);
  });
  it('a file the baseline knew but the board lost is uploaded again', () => {
    assert.deepEqual(row(up({ local: [lf('a.py', 'x')], baseline: { 'a.py': base('x') } })), ['upload', 'board-missing', true]);
  });
  it('local changed, board unchanged since the baseline: upload', () => {
    assert.deepEqual(row(up({ local: [lf('a.py', 'v2')], board: [bf('a.py', 'v1')], baseline: { 'a.py': base('v1') } })), ['upload', 'local-changed', true]);
  });
  it('board changed, local unchanged: a conflict that is not selected (never overwrites the board silently)', () => {
    assert.deepEqual(row(up({ local: [lf('a.py', 'v1')], board: [bf('a.py', 'edited on board')], baseline: { 'a.py': base('v1') } })), ['conflict', 'board-changed', false]);
  });
  it('both changed: a conflict', () => {
    assert.deepEqual(row(up({ local: [lf('a.py', 'mine')], board: [bf('a.py', 'theirs')], baseline: { 'a.py': base('v1') } })), ['conflict', 'both-changed', false]);
  });
  it('different with no history (first sync): a conflict', () => {
    assert.deepEqual(row(up({ local: [lf('a.py', 'mine')], board: [bf('a.py', 'theirs')] })), ['conflict', 'first-sync-differs', false]);
  });
  it('a file only on the board is left alone, with or without history', () => {
    assert.deepEqual(row(up({ board: [bf('a.py', 'x')] })), ['unchanged', 'board-only', true]);
    assert.deepEqual(row(up({ board: [bf('a.py', 'x')], baseline: { 'a.py': base('x') } })), ['unchanged', 'local-deleted', true]);
  });
  it('nothing is ever deleted unless the flag is set, and then the delete starts unselected', () => {
    const none = plan('toBoard', { board: [bf('a.py', 'x')], baseline: { 'a.py': base('x') } });
    assert.equal(none.plan.items.some((i) => i.action === 'delete-board'), false);
    const flagged = plan('toBoard', { board: [bf('a.py', 'x')], baseline: { 'a.py': base('x') }, allowDeletes: true });
    assert.deepEqual(flagged.plan.items.map(row), [['delete-board', 'local-deleted', false]]);
    assert.equal(actionable(flagged.plan).length, 0, 'unselected deletes are not actionable');
  });
  it('a same-size content change is detected (size-only comparison would miss it)', () => {
    assert.deepEqual(row(up({ local: [lf('a.py', 'abc')], board: [bf('a.py', 'abd')], baseline: { 'a.py': base('abd') } })), ['upload', 'local-changed', true]);
  });
});

describe('plan: Board to Local', () => {
  const down = (over: Partial<PlanInput>): SyncItem => one('fromBoard', over);

  it('board changed, local unchanged: download', () => {
    assert.deepEqual(row(down({ local: [lf('a.py', 'v1')], board: [bf('a.py', 'v2')], baseline: { 'a.py': base('v1') } })), ['download', 'board-changed', true]);
  });
  it('local changed, board unchanged: a conflict (your edits would be lost)', () => {
    assert.deepEqual(row(down({ local: [lf('a.py', 'mine')], board: [bf('a.py', 'v1')], baseline: { 'a.py': base('v1') } })), ['conflict', 'local-changed', false]);
  });
  it('both changed and first-sync differences are conflicts', () => {
    assert.deepEqual(row(down({ local: [lf('a.py', 'mine')], board: [bf('a.py', 'theirs')], baseline: { 'a.py': base('v1') } })), ['conflict', 'both-changed', false]);
    assert.deepEqual(row(down({ local: [lf('a.py', 'mine')], board: [bf('a.py', 'theirs')] })), ['conflict', 'first-sync-differs', false]);
  });
  it('a file only on the board is downloaded; one deleted locally since the last sync comes back', () => {
    assert.deepEqual(row(down({ board: [bf('a.py', 'x')] })), ['download', 'board-only', true]);
    assert.deepEqual(row(down({ board: [bf('a.py', 'x')], baseline: { 'a.py': base('x') } })), ['download', 'local-deleted', true]);
  });
  it('a file only on the computer is left alone; deleting it needs the flag and is unselected', () => {
    assert.deepEqual(row(down({ local: [lf('a.py', 'x')] })), ['unchanged', 'new-local', true]);
    assert.deepEqual(plan('fromBoard', { local: [lf('a.py', 'x')], allowDeletes: true }).plan.items.map(row), [['delete-local', 'new-local', false]]);
  });
  it('identical files are unchanged', () => {
    assert.deepEqual(row(down({ local: [lf('a.py', 'x')], board: [bf('a.py', 'x')] })), ['unchanged', 'identical', true]);
  });
});

describe('plan: boards that cannot hash', () => {
  const none = (over: Partial<PlanInput>): ReturnType<typeof buildPlan> => plan('toBoard', { boardHash: 'none', ...over });

  it('different sizes are certainly different', () => {
    const out = none({ local: [lf('a.py', 'longer content')], board: [bf('a.py', 'short', '', false)] });
    assert.equal(out.plan.compare, 'size');
    assert.deepEqual(out.plan.items.map(row), [['conflict', 'first-sync-differs', false]]);
    assert.deepEqual(out.ambiguous, [], 'no download needed: the sizes already prove a difference');
  });
  it('equal sizes without a hash are ambiguous and reported for a download-compare, never assumed equal', () => {
    const out = none({ local: [lf('a.py', 'abc')], board: [bf('a.py', 'abd', '', false)] });
    assert.deepEqual(out.ambiguous, ['a.py']);
    assert.equal(out.plan.items[0]?.action, 'conflict');
    assert.match(out.plan.warnings.join(' '), /cannot compute checksums/);
  });
  it('the downloaded hash settles it: identical', () => {
    const out = none({ local: [lf('a.py', 'abc')], board: [bf('a.py', 'abc', '', false)], downloaded: { 'a.py': sha('abc') } });
    assert.deepEqual(out.ambiguous, []);
    assert.deepEqual(out.plan.items.map(row), [['unchanged', 'identical', true]]);
  });
  it('the downloaded hash settles it: the board still has the baseline version, so local wins', () => {
    const out = none({ local: [lf('a.py', 'abc')], board: [bf('a.py', 'xyz', '', false)], baseline: { 'a.py': base('xyz') }, downloaded: { 'a.py': sha('xyz') } });
    assert.deepEqual(out.plan.items.map(row), [['upload', 'local-changed', true]]);
  });
  it('a board file whose size differs from the baseline has certainly changed', () => {
    const out = none({ local: [lf('a.py', 'abc')], board: [bf('a.py', 'edited!!', '', false)], baseline: { 'a.py': base('abc') } });
    assert.deepEqual(out.plan.items.map(row), [['conflict', 'board-changed', false]]);
  });
});

describe('plan: guards', () => {
  it('does not upload a file whose board name would hide a built-in module, and says why', () => {
    const out = plan('toBoard', { local: [lf('alpha.py', 'x'), lf('lib/Alpha/__init__.py', 'y'), lf('main.py', 'z')], shadow: { names: ['alpha'], roots: ['/', '/lib'] } });
    assert.deepEqual(out.plan.items.map((i) => i.path), ['main.py']);
    assert.equal(out.plan.warnings.filter((w) => /built-in module/.test(w)).length, 2);
    assert.match(out.plan.warnings[0] ?? '', /Rename the file/);
  });

  it('applies rootPath to every device path', () => {
    const out = plan('toBoard', { rootPath: '/lib', local: [lf('a.py', 'x')], board: [bf('b.py', 'y', '/lib'), bf('outside.py', 'z', '/other')] });
    assert.deepEqual(out.plan.items.map((i) => [i.path, i.remote, i.action]), [['a.py', '/lib/a.py', 'upload'], ['b.py', '/lib/b.py', 'unchanged']]);
    assert.equal(out.plan.rootPath, '/lib');
  });

  it('does not upload names that cannot be shared (backslash)', () => {
    const out = plan('toBoard', { local: [lf('bad\\name.py', 'x'), lf('ok.py', 'y')] });
    assert.deepEqual(out.plan.items.map((i) => i.path), ['ok.py']);
    assert.match(out.plan.warnings.join(' '), /backslash/);
  });

  it('creates folders that exist only as empty folders, in both directions', () => {
    const up = plan('toBoard', { local: [lf('lib/a.py', 'x')], localDirs: ['lib', 'empty', 'empty/inner'] });
    assert.deepEqual(up.plan.items.filter((i) => i.action === 'mkdir').map((i) => i.path), ['empty/inner']);
    const down = plan('fromBoard', { board: [{ remote: '/data', type: 'dir', size: 0 }, bf('lib/a.py', 'x')], localDirs: [] });
    assert.deepEqual(down.plan.items.filter((i) => i.action === 'mkdir').map((i) => i.path), ['data']);
  });

  it('carries direction, board id, compare mode and time into the plan', () => {
    const out = plan('toBoard', { boardId: null, now: new Date('2026-10-13T01:02:03Z') });
    assert.equal(out.plan.direction, 'toBoard');
    assert.equal(out.plan.boardId, null);
    assert.equal(out.plan.compare, 'sha256');
    assert.equal(out.plan.createdAt, '2026-10-13T01:02:03.000Z');
  });

  it('orders actions first, then conflicts, then unchanged, by path', () => {
    const out = plan('toBoard', { local: [lf('z.py', '1'), lf('a.py', '2'), lf('m.py', 'mine')], board: [bf('m.py', 'theirs'), bf('same.py', 's')] });
    assert.deepEqual(out.plan.items.map((i) => i.path), ['a.py', 'z.py', 'm.py', 'same.py']);
    const c = countPlan(out.plan);
    assert.deepEqual([c.upload, c.conflict, c.unchanged, c.selected], [2, 1, 1, 2]);
  });

  it('a ticked conflict resolves toward the direction of the plan', () => {
    const toBoard = plan('toBoard', { local: [lf('m.py', 'mine')], board: [bf('m.py', 'theirs')] }).plan;
    const fromBoard = plan('fromBoard', { local: [lf('m.py', 'mine')], board: [bf('m.py', 'theirs')] }).plan;
    assert.equal(effectiveAction(toBoard, toBoard.items[0] as SyncItem), 'upload');
    assert.equal(effectiveAction(fromBoard, fromBoard.items[0] as SyncItem), 'download');
  });
});

describe('plan: names on the way down (Windows rules injected)', () => {
  const win = (over: Partial<PlanInput>): ReturnType<typeof buildPlan> => buildPlan({
    direction: 'fromBoard', workspaceRoot: WINDOWS.workspace, rootPath: '/', boardId: 'abc', local: [], board: [], boardHash: 'sha256', baseline: {},
    flavor: path.win32, localCaseInsensitive: true, ...over,
  });

  it('skips board names Windows cannot store and says which', () => {
    const out = win({ board: [bf('con.py', 'a'), bf('what?.py', 'b'), bf('ok file (1).py', 'c'), bf('ends.', 'd'), bf('back\\slash.py', 'e')] });
    assert.deepEqual(out.plan.items.map((i) => i.path), ['ok file (1).py']);
    assert.equal(out.plan.warnings.length, 4);
    assert.ok(out.plan.warnings.every((w) => /not downloaded/.test(w)));
  });

  it('ignores board entries that try to leave the project folder, whatever the host', () => {
    for (const flavor of [path.posix, path.win32]) {
      const out = buildPlan({
        direction: 'fromBoard', workspaceRoot: flavor === path.win32 ? WINDOWS.workspace : WS, rootPath: '/', boardId: 'abc', local: [], boardHash: 'sha256',
        baseline: {}, flavor, board: [bf('../../evil.py', 'x'), bf('a/../../evil2.py', 'x'), bf('a/..\\..\\evil3.py', 'x'), bf('fine.py', 'ok')],
      });
      assert.deepEqual(out.plan.items.map((i) => i.path), ['fine.py']);
      assert.ok(out.plan.items.every((i) => i.local.startsWith(flavor === path.win32 ? WINDOWS.workspace : WS)));
    }
  });

  it('builds local paths with backslashes under the Windows workspace', () => {
    const out = win({ board: [bf('lib/sub/x.py', 'a')] });
    assert.equal(out.plan.items[0]?.local, `${WINDOWS.workspace}\\lib\\sub\\x.py`);
    assert.equal(out.plan.items[0]?.remote, '/lib/sub/x.py');
  });

  it('refuses to download two board files that would become one file on a case-insensitive computer', () => {
    const out = win({ board: [bf('Main.py', 'a'), bf('main.py', 'b'), bf('other.py', 'c')] });
    assert.deepEqual(out.plan.items.map((i) => i.path), ['other.py']);
    assert.match(out.plan.warnings.join(' '), /Main\.py, main\.py/);
  });

  it('matches a local file to the board file whatever the case, on a case-insensitive host', () => {
    const out = win({ board: [bf('Main.py', 'a')], local: [{ path: 'main.py', abs: `${WINDOWS.workspace}\\main.py`, size: 1, sha256: sha('a') }] });
    assert.deepEqual(out.plan.items.map(row), [['unchanged', 'identical', true]]);
  });

  it('skips paths that would be too long for Windows tools', () => {
    const deep = `${'d'.repeat(120)}/${'e'.repeat(120)}/f.py`;
    const out = win({ board: [bf(deep, 'a'), bf('short.py', 'b')] });
    assert.deepEqual(out.plan.items.map((i) => i.path), ['short.py']);
    assert.match(out.plan.warnings.join(' '), /too long for Windows/);
  });

  it('does not download what the ignore rules skip, and counts it', () => {
    const out = win({ board: [bf('keep.py', 'a'), bf('Thumbs.db', 'b'), bf('x.pyi', 'c')], ignoredOnBoard: (rel) => /\.pyi$|Thumbs\.db$/i.test(rel) });
    assert.deepEqual(out.plan.items.map((i) => i.path), ['keep.py']);
    assert.match(out.plan.warnings.join(' '), /2 file\(s\) on the board match your ignore list/);
  });
});
