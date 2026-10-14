/**
 * Decision D-21 (the sync redesign): the marks of the Files view (one-file classifier, status overlays, project-only rows), the
 * comparison at connect, the first-sync review gate (nothing is sent to a board that was never reviewed with this folder), the
 * compare-and-swap of every auto-sync upload (a board copy that changed since the last sync is never replaced), the offer for
 * files a program created on the board, the per-file Upload / Download / Compare commands and the legend.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { classifyOne } from '../../src/sync/plan';
import { SyncStatus, badgeOfReason } from '../../src/sync/status';
import { stateKey } from '../../src/identity';
import type { SyncPlan } from '../../src/types/sync';
import { FAKE_IDENTITY, FakeSession } from '../mocks/fakeSession';
import { mock } from '../mocks/vscode';
import { makeKit, settle, sha, waitFor, type Kit } from './sync/kit';

let kit: Kit;
beforeEach(() => mock.reset());
// background uploads of a test must finish before its folders go, or their late warnings land in the next test
afterEach(async () => { await kit?.sync.whenIdle(); kit?.dispose(); });

const uri = (k: Kit, rel: string): vscode.Uri => vscode.Uri.file(`${k.workspace}/${rel}`);
const REVIEW = /never synced with this project folder/;
const puts = (k: Kit): { remote: string; ifSha?: string }[] => k.session.argsOf('fs.put') as never;
const reviewedKey = stateKey(`sync.reviewed.${FAKE_IDENTITY.uniqueId}`);

/** Save a file the way an editor does; with auto-sync on, wait until its debounce timer is set (so runAll sends it). */
async function save(k: Kit, rel: string, text: string, waitTimer = k.sync.auto.mode() === 'on'): Promise<void> {
  k.write(rel, text);
  const before = k.scheduler.size;
  await mock.saveFile(uri(k, rel), text);
  if (waitTimer) { await waitFor(() => k.scheduler.size > before || k.scheduler.size > 0, `a timer for ${rel}`); }
}

describe('D-21 marks: the one-file classifier mirrors the planner', () => {
  const L = { sha256: 'aa', size: 2 };
  const L2 = { sha256: 'bb', size: 2 };
  const B = { sha256: 'aa', size: 2 };
  const Bx = { sha256: 'cc', size: 2 };
  const S = { sha256: 'aa', size: 2 };
  it('covers every row of the decision table', () => {
    assert.equal(classifyOne(L, B, S), 'identical');
    assert.equal(classifyOne(L, B, undefined), 'identical', 'equal contents are synced whatever the baseline says');
    assert.equal(classifyOne(L, undefined, undefined), 'new-local');
    assert.equal(classifyOne(L, undefined, S), 'board-missing');
    assert.equal(classifyOne(undefined, B, undefined), 'board-only');
    assert.equal(classifyOne(undefined, B, S), 'local-deleted');
    assert.equal(classifyOne(L2, Bx, undefined), 'first-sync-differs', 'never synced here: not known which is newer');
    assert.equal(classifyOne(L2, B, S), 'local-changed');
    assert.equal(classifyOne(L, Bx, S), 'board-changed');
    assert.equal(classifyOne(L2, Bx, S), 'both-changed');
    assert.equal(classifyOne(undefined, undefined, S), undefined);
  });
  it('boards that cannot hash compare by size: equal sizes are not known, different sizes are compared with the baseline size', () => {
    assert.equal(classifyOne(L2, { size: 2 }, S), 'first-sync-differs');
    assert.equal(classifyOne(L2, { size: 5 }, S), 'both-changed');
    assert.equal(classifyOne(L, { size: 5 }, S), 'board-changed');
  });
  it('maps reasons to the marks the instructor chose: up arrow / plus = to the board, down arrow = from the board', () => {
    assert.equal(badgeOfReason('identical'), 'in-sync');
    assert.equal(badgeOfReason('local-changed'), 'local-changed');
    assert.equal(badgeOfReason('new-local'), 'local-only');
    assert.equal(badgeOfReason('board-changed'), 'board-changed');
    assert.equal(badgeOfReason('board-only'), 'board-only');
    assert.equal(badgeOfReason('both-changed'), 'conflict');
    assert.equal(badgeOfReason('first-sync-differs'), 'differs');
  });
});

describe('D-21 marks: the status store', () => {
  it('overlays win in order failed > unsaved > waiting > comparison, and the comparison stays underneath', () => {
    const s = new SyncStatus();
    s.set('/a.py', 'in-sync', { rel: 'a.py' });
    assert.equal(s.badgeFor('/a.py'), 'in-sync');
    s.setWaiting('/a.py', true);
    assert.equal(s.badgeFor('/a.py'), 'waiting');
    s.setDirty('/a.py', true);
    assert.equal(s.badgeFor('/a.py'), 'unsaved');
    s.setFailed('/a.py', 'The board is full.');
    assert.equal(s.badgeFor('/a.py'), 'failed');
    assert.equal(s.detailFor('/a.py')?.failure, 'The board is full.');
    assert.equal(s.detailFor('/a.py')?.base, 'in-sync');
    s.setFailed('/a.py', undefined);
    s.setDirty('/a.py', false);
    s.setWaiting('/a.py', false);
    assert.equal(s.badgeFor('/a.py'), 'in-sync');
    s.dispose();
  });

  it('lists project-only files and folders under their board folder', () => {
    const s = new SyncStatus();
    const plan = {
      direction: 'toBoard', createdAt: '', workspaceRoot: '/ws', rootPath: '/', boardId: null, compare: 'sha256', warnings: [],
      items: [
        { path: 'new.py', remote: '/new.py', local: '/ws/new.py', kind: 'file', action: 'upload', reason: 'new-local', size: 12, selected: true },
        { path: 'lib/helper.py', remote: '/lib/helper.py', local: '/ws/lib/helper.py', kind: 'file', action: 'upload', reason: 'new-local', size: 3, selected: true },
        { path: 'main.py', remote: '/main.py', local: '/ws/main.py', kind: 'file', action: 'unchanged', reason: 'identical', size: 0, selected: true },
      ],
    } satisfies SyncPlan;
    s.fromPlan(plan);
    assert.deepEqual(s.localOnlyIn('/').map((e) => [e.name, e.kind]).sort(), [['lib', 'dir'], ['new.py', 'file']]);
    assert.deepEqual(s.localOnlyIn('/lib').map((e) => [e.name, e.kind, e.size]), [['helper.py', 'file', 3]]);
    assert.equal(s.badgeFor('/main.py'), 'in-sync');
    assert.equal(s.badgeFor('/new.py'), 'local-only');
    s.dispose();
  });
});

describe('D-21 compare at connect and the first-sync review', () => {
  it('a board that matches the project is reviewed silently and auto-sync sends later saves', async () => {
    kit = makeKit({ autoSync: 'on', reviewed: false, session: new FakeSession(), local: { 'main.py': 'print(1)\n' }, board: {} });
    kit.session.useBoardFs({ '/main.py': 'print(1)\n' });
    kit.sync.start();
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => kit.ctx.workspaceState.get(reviewedKey) === true, 'the silent review');
    assert.equal(mock.messages().filter((m) => REVIEW.test(m.message)).length, 0, 'nothing to decide: no dialog');
    assert.equal(kit.sync.badgeFor('/main.py'), 'in-sync');
    await save(kit, 'main.py', 'print(2)\n');
    kit.scheduler.runAll();
    await waitFor(() => kit.session.boardFs?.read('/main.py') === 'print(2)\n', 'the upload of the save');
    assert.equal(puts(kit)[0]?.ifSha, sha('print(1)\n'), 'the upload replaces only the copy that was last synced');
  });

  it('a board with other files asks once; "Send my files" sends only the new ones and touches nothing on the board', async () => {
    kit = makeKit({ autoSync: 'on', reviewed: false, session: new FakeSession(), local: { 'main.py': 'mine\n', 'util.py': 'u\n', 'same.py': 's\n' } });
    kit.session.useBoardFs({ '/boot.py': 'boot\n', '/main.py': 'theirs\n', '/same.py': 's\n' });
    mock.answerMessage(REVIEW, 'Send my 1 file and copy the board\'s 1 file', { once: true });
    kit.sync.start();
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => kit.ctx.workspaceState.get(reviewedKey) === true, 'the answered review');
    const dialog = mock.messages().find((m) => REVIEW.test(m.message));
    assert.ok(dialog?.modal, 'the review is a dialog');
    assert.match(dialog?.detail ?? '', /Only in your project \(1\): util\.py/);
    assert.match(dialog?.detail ?? '', /Only on the board \(1\): boot\.py/);
    assert.match(dialog?.detail ?? '', /Different on the two sides \(1\): main\.py/);
    await waitFor(() => kit.session.boardFs?.read('/util.py') === 'u\n', 'util.py on the board');
    assert.equal(kit.session.boardFs?.read('/main.py'), 'theirs\n', 'a differing board copy is never replaced from the review');
    assert.equal(kit.read('main.py'), 'mine\n', 'nor the project copy');
    await waitFor(() => kit.read('boot.py') === 'boot\n', 'boot.py copied into the project');
    assert.deepEqual(puts(kit).map((p) => [p.remote, p.ifSha]), [['/util.py', 'absent']]);
    await waitFor(() => kit.sync.badgeFor('/main.py') === 'differs', 'the differing file keeps its mark');
  });

  it('a board with files and an empty project folder offers to copy them in; nothing is uploaded', async () => {
    kit = makeKit({ autoSync: 'on', reviewed: false, session: new FakeSession() });
    kit.session.useBoardFs({ '/main.py': 'partner\n', '/data.csv': '1,2\n' });
    mock.answerMessage(REVIEW, 'Copy the board\'s 2 files into my project', { once: true });
    kit.sync.start();
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => kit.read('main.py') === 'partner\n' && kit.read('data.csv') === '1,2\n', 'the copied files');
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });

  it('a postponed review keeps auto-sync from sending anything to that board, and asks again at the next connect', async () => {
    kit = makeKit({ autoSync: 'on', reviewed: false, session: new FakeSession(), local: { 'main.py': 'mine\n' } });
    kit.session.useBoardFs({ '/main.py': 'theirs\n' });
    mock.answerMessage(REVIEW, undefined);
    kit.sync.start();
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => mock.messages().some((m) => REVIEW.test(m.message)), 'the review');
    await save(kit, 'main.py', 'mine 2\n');
    kit.scheduler.runAll();
    await settle(60);
    assert.equal(kit.session.callsOf('fs.put').length, 0, 'nothing is sent to an unreviewed board');
    assert.equal(kit.session.boardFs?.read('/main.py'), 'theirs\n');
    await kit.session.disconnect();
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => mock.messages().filter((m) => REVIEW.test(m.message)).length === 2, 'asked again');
  });
});

describe('D-21 compare-and-swap of auto-sync uploads', () => {
  it('a board copy that a program changed since the last sync is not replaced by a save: marked, and the student is told', async () => {
    kit = makeKit({ autoSync: 'on', local: { 'log.py': 'v1\n' } });
    kit.session.useBoardFs({ '/log.py': 'v1\n' });
    kit.sync.start();
    await kit.sync.refreshStatus('test'); // records the baseline of the identical file
    kit.session.boardFs?.write('/log.py', new TextEncoder().encode('written by the program\n'));
    await save(kit, 'log.py', 'v2 from the student\n');
    kit.scheduler.runAll();
    await waitFor(() => mock.messages('warn').some((m) => /changed on the board since the last sync/.test(m.message)), 'the warning');
    assert.equal(kit.session.boardFs?.read('/log.py'), 'written by the program\n', 'never overwritten');
    assert.equal(kit.sync.badgeFor('/log.py'), 'conflict');
    assert.equal(kit.session.pendingSyncCount, 0, 'not retried forever');
  });

  it('a new file that the board already has with other content is not replaced (no baseline: absent precondition)', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.session.useBoardFs({ '/main.py': 'board version\n' });
    kit.sync.start();
    await save(kit, 'main.py', 'my version\n');
    kit.scheduler.runAll();
    await waitFor(() => kit.sync.badgeFor('/main.py') === 'differs', 'the differs mark');
    assert.equal(kit.session.boardFs?.read('/main.py'), 'board version\n');
    assert.equal(puts(kit)[0]?.ifSha, 'absent');
  });
});

describe('D-21 marks follow saves without board traffic, whatever the auto-sync mode', () => {
  it('auto-sync off: compared at connect, then a save turns the check into an up arrow and nothing is uploaded', async () => {
    kit = makeKit({ autoSync: 'off', session: new FakeSession(), local: { 'a.py': 'x\n' } });
    kit.session.useBoardFs({ '/a.py': 'x\n' });
    kit.sync.start();
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => kit.sync.badgeFor('/a.py') === 'in-sync', 'the comparison at connect');
    const listings = kit.session.callsOf('fs.manifest').length;
    await save(kit, 'a.py', 'y\n');
    await waitFor(() => kit.sync.badgeFor('/a.py') === 'local-changed', 'the up arrow');
    assert.equal(kit.session.callsOf('fs.manifest').length, listings, 'no new board listing for a save');
    assert.equal(kit.session.callsOf('fs.put').length, 0);
    await save(kit, 'a.py', 'x\n');
    await waitFor(() => kit.sync.badgeFor('/a.py') === 'in-sync', 'back to the check when the content is the same again');
  });

  it('an unsaved editor shows the dot until it is saved', async () => {
    kit = makeKit({ autoSync: 'off', local: { 'a.py': 'x\n' } });
    kit.session.useBoardFs({ '/a.py': 'x\n' });
    kit.sync.start();
    await kit.sync.refreshStatus('test');
    const doc = await mock.openDocument(uri(kit, 'a.py'));
    doc.setText('x\ny\n'); // the student typed: dirty, onDidChangeTextDocument fires
    assert.equal(kit.sync.badgeFor('/a.py'), 'unsaved');
    await doc.save();
    assert.notEqual(kit.sync.badgeFor('/a.py'), 'unsaved');
    await waitFor(() => kit.sync.badgeFor('/a.py') === 'local-changed', 'the up arrow after the save');
  });
});

describe('D-21 files a program created on the board', () => {
  it('after a run, new board files are offered for download (never downloaded by themselves)', async () => {
    kit = makeKit({ autoSync: 'on', local: { 'main.py': 'log()\n' } });
    kit.session.useBoardFs({ '/main.py': 'log()\n' });
    kit.sync.start();
    await kit.sync.refreshStatus('test');
    kit.session.setState({ state: 'running' });
    kit.session.boardFs?.write('/data.csv', new TextEncoder().encode('t,v\n0,1\n'));
    mock.answerMessage(/Your program created data\.csv on the board/, 'Download it to my project', { once: true });
    kit.session.setState({ state: 'idle' });
    await waitFor(() => kit.read('data.csv') === 't,v\n0,1\n', 'the download after the answer');
    // the file lands before the engine returns; the mark follows when it has recorded the sync
    await waitFor(() => kit.sync.badgeFor('/data.csv') === 'in-sync', 'the check on the downloaded file');
  });
});

describe('D-21 per-file commands of the Files view', () => {
  it('Download asks before it replaces a project copy that changed since the last sync, and backs it up', async () => {
    kit = makeKit({ autoSync: 'off', local: { 'a.py': 'base\n' } });
    kit.session.useBoardFs({ '/a.py': 'base\n' });
    kit.sync.start();
    await kit.sync.refreshStatus('test');
    kit.write('a.py', 'my edit\n');
    kit.session.boardFs?.write('/a.py', new TextEncoder().encode('board edit\n'));
    mock.answerMessage(/Your copy of a\.py changed since the last sync/, 'Replace my copy (back it up first)', { once: true });
    await kit.sync.downloadNode({ devicePath: '/a.py', kind: 'file', name: 'a.py', size: 11 });
    assert.equal(kit.read('a.py'), 'board edit\n');
    assert.ok(kit.sync.engine.lastBackupDir, 'the project copy was backed up first');
  });

  it('Upload Current File asks before it replaces a board copy that changed, backs it up, and replaces only on yes', async () => {
    kit = makeKit({ autoSync: 'off', local: { 'a.py': 'base\n' } });
    kit.session.useBoardFs({ '/a.py': 'base\n' });
    kit.sync.start();
    await kit.sync.refreshStatus('test');
    kit.write('a.py', 'mine\n');
    kit.session.boardFs?.write('/a.py', new TextEncoder().encode('program wrote this\n'));
    mock.answerMessage(/changed since the last sync\. Replace it with your version\?/, 'Replace it (back up the board copy first)', { once: true });
    await kit.sync.uploadFile(uri(kit, 'a.py'));
    assert.equal(kit.session.boardFs?.read('/a.py'), 'mine\n');
    assert.ok(kit.sync.engine.lastBackupDir, 'the board copy was saved first');
  });

  it('the legend explains every mark', async () => {
    kit = makeKit({});
    await kit.sync.showLegend();
    const m = mock.messages('info').at(-1);
    assert.ok(m?.modal);
    for (const glyph of ['✓', '↑', '+', '↓', '!', '≠', '●']) { assert.ok(m?.detail?.includes(glyph), glyph); }
  });
});

describe('D-21 connect while the board is busy (instructor report 2026-10-13: "2 files waiting", no review until a reconnect)', () => {
  /** Like the real bridge: right after a connect, other readers (Files view, clock, IntelliSense) make the board 'rawop' for a moment. */
  function flickerAfterConnect(session: FakeSession): void {
    let first = true;
    session.onDidChangeState((st) => {
      if (first && st.state === 'idle') {
        first = false;
        // the real order: 'idle' reaches every listener first; a moment later the Files view's listing goes out and the bridge
        // reports 'rawop' until it is answered (100 ms or more on a real board)
        setTimeout(() => session.setState({ state: 'rawop', reason: 'fs.list' }), 0);
        setTimeout(() => session.setState({ state: 'idle', reason: 'fs.list done' }), 80);
      }
    });
  }

  it('the comparison and the review still run when the board is busy with another file operation at that moment', async () => {
    kit = makeKit({ autoSync: 'on', reviewed: false, session: new FakeSession(), local: { 'main.py': 'mine\n', 'test.py': 't\n' } });
    kit.session.useBoardFs({ '/main.py': 'theirs\n' });
    flickerAfterConnect(kit.session);
    mock.answerMessage(REVIEW, 'Send my 1 new file to the board', { once: true });
    kit.sync.start();
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => kit.session.boardFs?.read('/test.py') === 't\n', 'the review and the upload of the new file');
    await waitFor(() => kit.ctx.workspaceState.get(reviewedKey) === true, 'the board marked as reviewed');
  });

  it('a board reviewed before receives saves at once, even if the comparison at connect has to wait', async () => {
    kit = makeKit({ autoSync: 'on', reviewed: false, session: new FakeSession(), local: { 'a.py': 'v1\n' } });
    await kit.ctx.workspaceState.update(reviewedKey, true); // reviewed in an earlier session
    kit.session.useBoardFs({ '/a.py': 'v1\n' });
    flickerAfterConnect(kit.session);
    kit.sync.start();
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => kit.sync.auto.sending(), 'auto-sync to send to this board');
    await save(kit, 'a.py', 'v2\n');
    kit.scheduler.runAll();
    await waitFor(() => kit.session.boardFs?.read('/a.py') === 'v2\n', 'the save on the board');
    assert.equal(mock.messages().filter((m) => REVIEW.test(m.message)).length, 0);
  });

  it('a program running at connect: the review waits for the first idle moment instead of being lost', async () => {
    const session = new FakeSession();
    session.script('connect', { state: 'running', sync: 'running-program', portInfo: { port: '/dev/cu.fake' } as never });
    kit = makeKit({ autoSync: 'on', reviewed: false, session, local: { 'main.py': 'mine\n' } });
    kit.session.useBoardFs({ '/main.py': 'theirs\n' });
    mock.answerMessage(REVIEW, undefined);
    kit.sync.start();
    await kit.session.connect('/dev/cu.fake');
    await settle(40);
    assert.equal(mock.messages().filter((m) => REVIEW.test(m.message)).length, 0, 'not while the program runs');
    kit.session.setState({ state: 'idle', reason: 'stopped' });
    await waitFor(() => mock.messages().some((m) => REVIEW.test(m.message)), 'the review once the board is idle');
  });

  it('saves waiting for a postponed review get one note per connection that explains why, with "Review now"', async () => {
    kit = makeKit({ autoSync: 'on', reviewed: false, session: new FakeSession(), local: { 'main.py': 'mine\n' } });
    kit.session.useBoardFs({ '/main.py': 'theirs\n' });
    mock.answerMessage(REVIEW, undefined, { once: true });
    kit.sync.start();
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => mock.messages().some((m) => REVIEW.test(m.message)), 'the review');
    await settle(20);
    mock.answerMessage(/Your saved files are not sent to this board yet/, 'Review now', { once: true });
    mock.answerMessage(REVIEW, 'Review each file...', { once: true });
    mock.answerQuickPick(() => undefined); // the full list: cancelled
    await save(kit, 'main.py', 'mine 2\n');
    kit.scheduler.runAll();
    await waitFor(() => mock.messages().filter((m) => REVIEW.test(m.message)).length === 2, 'the review again after "Review now"');
    await save(kit, 'main.py', 'mine 3\n');
    kit.scheduler.runAll();
    await settle(40);
    assert.equal(mock.messages().filter((m) => /Your saved files are not sent/.test(m.message)).length, 1, 'one note per connection');
    assert.equal(kit.session.boardFs?.read('/main.py'), 'theirs\n', 'still nothing sent to an unreviewed board');
  });
});

