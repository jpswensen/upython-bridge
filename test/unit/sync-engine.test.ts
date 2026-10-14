/**
 * The engine against FakeSession and an in-memory board: per-file results, continue-on-error, cancellation, the baseline
 * learning only about files that succeeded, consent to interrupt, backups of everything overwritten, the main.py notice.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { SYNC_STATE } from '../../src/sync/state';
import { BoardError } from '../../src/types/session';
import type { SyncPlan, SyncResult } from '../../src/types/sync';
import { mock } from '../mocks/vscode';
import { makeKit, sha, type Kit } from './sync/kit';

let kit: Kit;
beforeEach(() => mock.reset());
afterEach(() => kit?.dispose());

async function plan(k: Kit, direction: 'toBoard' | 'fromBoard', select: (p: SyncPlan) => void = () => undefined): Promise<{ plan: SyncPlan; run: () => Promise<SyncResult>; baseline: () => Promise<Record<string, { sha256: string }>> }> {
  const prep = await k.sync.prepare(direction, k.sync.newConsent('test'));
  assert.ok(prep, 'prepare returned nothing');
  select(prep.plan);
  return {
    plan: prep.plan,
    run: () => k.sync.engine.execute(prep.plan, { baseline: prep.ctx.store, board: prep.board, title: 'test' }),
    baseline: async () => (await prep.ctx.store.load(prep.board)).files,
  };
}

const tickAll = (p: SyncPlan): void => { for (const i of p.items) { if (i.action !== 'unchanged') { i.selected = true; } } };

describe('engine: uploads', () => {
  it('uploads new files, creates folders, records the baseline and reports in one summary', async () => {
    kit = makeKit({ tricky: true, local: { 'main.py': 'print(1)', 'lib/café (v2).py': 'x = 2', 'data/readings 1.csv': '1,2' } });
    const p = await plan(kit, 'toBoard');
    assert.deepEqual(p.plan.items.map((i) => i.action), ['upload', 'upload', 'upload']);
    const res = await p.run();
    assert.deepEqual(res.counts, { ok: 3, failed: 0, skipped: 0, cancelled: 0 });
    assert.equal(kit.session.boardFs?.read('/lib/café (v2).py'), 'x = 2');
    assert.equal(kit.session.boardFs?.read('/main.py'), 'print(1)');
    assert.deepEqual(Object.keys(await p.baseline()).sort(), ['data/readings 1.csv', 'lib/café (v2).py', 'main.py']);
    assert.deepEqual(res.baselineUpdated.sort(), ['data/readings 1.csv', 'lib/café (v2).py', 'main.py']);
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /3 uploaded\./);
  });

  it('passes a timeout and the cancel signal to every transfer, and expectSha so unchanged files skip', async () => {
    kit = makeKit({ local: { 'a.py': 'a' } });
    await (await plan(kit, 'toBoard')).run();
    const call = kit.session.callsOf('fs.put')[0];
    assert.ok((call?.opts?.timeoutMs ?? 0) >= 15000);
    assert.ok(call?.opts?.signal instanceof AbortSignal);
    assert.equal((call?.args as { expectSha?: string }).expectSha, sha('a'));
  });

  it('continues after a failed file, tells which one and why, and records only the successes', async () => {
    kit = makeKit({ local: { 'a.py': 'a', 'b.py': 'b', 'c.py': 'c' } });
    kit.session.fail('fs.put', 'E_FS_ERRNO', 'The board is full.', { detail: 'ENOSPC', hint: 'Delete files you do not need.' });
    const p = await plan(kit, 'toBoard');
    const res = await p.run();
    assert.deepEqual(res.counts, { ok: 2, failed: 1, skipped: 0, cancelled: 0 });
    assert.deepEqual(res.results.map((r) => [r.item.path, r.status]), [['a.py', 'failed'], ['b.py', 'ok'], ['c.py', 'ok']]);
    assert.equal(res.results[0]?.code, 'E_FS_ERRNO');
    assert.deepEqual(Object.keys(await p.baseline()).sort(), ['b.py', 'c.py'], 'a failed file must not enter the baseline');
    assert.deepEqual(res.baselineUpdated.sort(), ['b.py', 'c.py']);
    assert.equal(kit.session.boardFs?.read('/a.py'), undefined);
    const warn = mock.messages('warn').map((m) => m.message).join('\n');
    assert.match(warn, /2 uploaded, 1 failed: a\.py - The board is full\. Delete files you do not need\./);
    assert.ok(kit.channel.text.includes('a.py'), 'the failure is in the log too');
  });

  it('stops after the connection is lost and marks the rest as not done', async () => {
    kit = makeKit({ local: { 'a.py': 'a', 'b.py': 'b', 'c.py': 'c' } });
    kit.session.script('fs.put', (args, ctx) => {
      if ((args as { remote: string }).remote === '/b.py') { throw BoardError.of('E_NO_DEVICE', 'The board was unplugged.', { hint: 'Plug it in again.' }, 'fs.put'); }
      return ctx.fallthrough() as never;
    });
    const res = await (await plan(kit, 'toBoard')).run();
    assert.deepEqual(res.results.map((r) => r.status), ['ok', 'failed', 'cancelled']);
    assert.equal(res.cancelled, true);
    assert.match(res.results[2]?.message ?? '', /connection to the board was lost/);
    assert.match(mock.messages('warn').map((m) => m.message).join('\n'), /1 uploaded, 1 failed: b\.py - The board was unplugged\./);
  });

  it('cancels from the progress notification: the running transfer and the rest are cancelled, nothing is recorded', async () => {
    kit = makeKit({ local: { 'a.py': 'a', 'b.py': 'b' } });
    const gate = kit.session.hold('fs.put');
    const p = await plan(kit, 'toBoard');
    const running = p.run();
    await gate.arrived;
    mock.calls.progress[mock.calls.progress.length - 1]?.cancel();
    const res = await running;
    gate.release();
    assert.deepEqual(res.results.map((r) => r.status), ['cancelled', 'cancelled']);
    assert.equal(res.cancelled, true);
    assert.deepEqual(res.baselineUpdated, []);
    assert.deepEqual(await p.baseline(), {});
    assert.equal(kit.session.callsOf('fs.put').length, 1, 'no further transfer starts after cancelling');
  });

  it('explains a refused module name instead of showing a raw error', async () => {
    kit = makeKit({ local: { 'a.py': 'a' } });
    kit.session.fail('fs.put', 'E_SHADOWS_MODULE', 'Refused.', { detail: 'module=alpha' });
    const res = await (await plan(kit, 'toBoard')).run();
    assert.match(res.results[0]?.message ?? '', /built into the board.*Rename the file/);
    assert.equal(res.results[0]?.code, 'E_SHADOWS_MODULE');
  });
});

describe('engine: a running program', () => {
  const gateUnlessInterrupt = (k: Kit): void => {
    k.session.script('fs.put', (args, ctx) => {
      if ((args as { interrupt?: boolean }).interrupt !== true) {
        throw BoardError.of('E_PROGRAM_RUNNING', 'A program is running.', { needs_interrupt: true, hint: 'Press Stop first.' }, 'fs.put');
      }
      return ctx.fallthrough() as never;
    });
  };

  it('asks once, then repeats with interrupt:true for every file', async () => {
    kit = makeKit({ local: { 'a.py': 'a', 'b.py': 'b', 'c.py': 'c' } });
    gateUnlessInterrupt(kit);
    mock.answerMessage(/program is still running/, 'Stop the program and continue');
    const res = await (await plan(kit, 'toBoard')).run();
    assert.equal(res.counts.ok, 3);
    const questions = mock.messages('warn').filter((m) => /program is still running/.test(m.message));
    assert.equal(questions.length, 1, 'one question for the whole sync');
    assert.equal(questions[0]?.modal, true);
    const puts = kit.session.argsOf('fs.put') as { interrupt?: boolean }[];
    assert.deepEqual(puts.map((a) => a.interrupt === true), [false, true, true, true]);
  });

  it('does nothing when the student says no, and says why', async () => {
    kit = makeKit({ local: { 'a.py': 'a', 'b.py': 'b' } });
    gateUnlessInterrupt(kit);
    mock.answerMessage(/program is still running/, undefined);
    const p = await plan(kit, 'toBoard');
    const res = await p.run();
    assert.equal(res.counts.ok, 0);
    assert.equal(res.counts.failed, 2);
    assert.match(res.results[0]?.message ?? '', /program is running/);
    assert.equal(kit.session.boardFs?.paths().length, 0);
    assert.deepEqual(await p.baseline(), {});
    assert.equal(mock.messages('warn').filter((m) => /program is still running/.test(m.message) && m.modal).length, 1);
  });
});

describe('engine: Board to Local', () => {
  it('replaces a changed local file only after saving a copy of it', async () => {
    kit = makeKit({ local: { 'a.py': 'v1' }, board: { '/a.py': 'v2', '/new.py': 'n' } });
    const k = kit;
    const prep = await k.sync.prepare('fromBoard', k.sync.newConsent('t'));
    assert.ok(prep);
    // the baseline says the last sync saw v1 on both sides, so the board's v2 is a plain board-side change
    await prep.ctx.store.record(prep.board, [{ path: 'a.py', sha256: sha('v1'), size: 2 }]);
    const again = await k.sync.prepare('fromBoard', k.sync.newConsent('t'));
    assert.ok(again);
    assert.deepEqual(again.plan.items.map((i) => [i.path, i.action, i.reason]), [['a.py', 'download', 'board-changed'], ['new.py', 'download', 'board-only']]);
    const res = await k.sync.engine.execute(again.plan, { baseline: again.ctx.store, board: again.board, title: 't' });
    assert.equal(res.counts.ok, 2);
    assert.equal(k.read('a.py'), 'v2');
    assert.equal(k.read('new.py'), 'n');
    const backup = k.sync.engine.lastBackupDir;
    assert.ok(backup, 'a backup folder was made');
    assert.equal(fs.readFileSync(path.join(backup, 'a.py'), 'utf8'), 'v1');
    assert.equal(fs.existsSync(path.join(backup, 'new.py')), false, 'new files need no backup');
    assert.equal((await again.ctx.store.load(again.board)).files['a.py']?.sha256, sha('v2'));
  });

  it('never replaces a file with unsaved changes in an editor', async () => {
    kit = makeKit({ local: { 'a.py': 'v1' }, board: { '/a.py': 'v2' } });
    const p = await plan(kit, 'fromBoard', tickAll);
    const doc = await mock.openDocument(vscode.Uri.file(kit.workspace + '/a.py'));
    doc.setText('typed but not saved');
    const res = await p.run();
    assert.equal(res.results[0]?.status, 'skipped');
    assert.match(res.results[0]?.message ?? '', /unsaved changes/);
    assert.equal(kit.read('a.py'), 'v1');
    assert.deepEqual(res.baselineUpdated, []);
    assert.equal(kit.session.callsOf('fs.get').length, 0);
  });

  it('a ticked conflict downloads the board version after backing up the local one', async () => {
    kit = makeKit({ local: { 'a.py': 'mine' }, board: { '/a.py': 'theirs' } });
    const p = await plan(kit, 'fromBoard');
    assert.equal(p.plan.items[0]?.action, 'conflict');
    assert.equal(p.plan.items[0]?.selected, false);
    tickAll(p.plan);
    const res = await p.run();
    assert.equal(res.counts.ok, 1);
    assert.equal(kit.read('a.py'), 'theirs');
    assert.equal(fs.readFileSync(path.join(kit.sync.engine.lastBackupDir ?? '', 'a.py'), 'utf8'), 'mine');
  });

  it('does not touch anything that was not selected', async () => {
    kit = makeKit({ local: { 'a.py': 'mine' }, board: { '/a.py': 'theirs', '/b.py': 'b' } });
    const p = await plan(kit, 'fromBoard');
    const res = await p.run();
    assert.deepEqual(res.results.map((r) => r.item.path), ['b.py']);
    assert.equal(kit.read('a.py'), 'mine');
  });
});

describe('engine: Local to Board overwrites', () => {
  it('keeps the board copy before a ticked conflict replaces it', async () => {
    kit = makeKit({ local: { 'a.py': 'mine' }, board: { '/a.py': 'theirs' } });
    const p = await plan(kit, 'toBoard', tickAll);
    const res = await p.run();
    assert.equal(res.counts.ok, 1);
    assert.equal(kit.session.boardFs?.read('/a.py'), 'mine');
    const saved = path.join(kit.sync.engine.lastBackupDir ?? '', 'board', 'a.py');
    assert.equal(fs.readFileSync(saved, 'utf8'), 'theirs');
  });

  it('does not overwrite when the backup of the board copy fails', async () => {
    kit = makeKit({ local: { 'a.py': 'mine' }, board: { '/a.py': 'theirs' } });
    kit.session.fail('fs.get', 'E_FS_ERRNO', 'The file could not be read.', { detail: 'EIO' });
    const p = await plan(kit, 'toBoard', tickAll);
    const res = await p.run();
    assert.equal(res.counts.failed, 1);
    assert.match(res.results[0]?.message ?? '', /could not be saved as a backup, so it was not overwritten/);
    assert.equal(kit.session.boardFs?.read('/a.py'), 'theirs');
  });

  it('never deletes board files in a normal upload, whatever is on the board', async () => {
    kit = makeKit({ local: { 'a.py': 'a' }, board: { '/old.py': 'o', '/lib/x.py': 'x' } });
    await (await plan(kit, 'toBoard')).run();
    assert.equal(kit.session.callsOf('fs.rm').length + kit.session.callsOf('fs.rmtree').length, 0);
    assert.equal(kit.session.boardFs?.read('/old.py'), 'o');
  });
});

describe('engine: deletes and folders, only when planned and selected', () => {
  it('runs selected delete items, forgets them in the baseline, and moves local files to the trash', async () => {
    kit = makeKit({ local: { 'gone.py': 'g', 'stay.py': 's' }, board: { '/old.py': 'o', '/stay.py': 's' } });
    const prep = await kit.sync.prepare('toBoard', kit.sync.newConsent('t'));
    assert.ok(prep);
    await prep.ctx.store.record(prep.board, [{ path: 'old.py', sha256: sha('o'), size: 1 }]);
    const items = [
      { path: 'old.py', remote: '/old.py', local: kit.workspace + '/old.py', kind: 'file' as const, action: 'delete-board' as const, reason: 'local-deleted' as const, size: 0, selected: true },
      { path: 'gone.py', remote: '/gone.py', local: kit.workspace + '/gone.py', kind: 'file' as const, action: 'delete-local' as const, reason: 'new-local' as const, size: 0, selected: true },
      { path: 'skip.py', remote: '/stay.py', local: kit.workspace + '/stay.py', kind: 'file' as const, action: 'delete-board' as const, reason: 'local-deleted' as const, size: 0, selected: false },
    ];
    const res = await kit.sync.engine.execute({ ...prep.plan, items }, { baseline: prep.ctx.store, board: prep.board, title: 't' });
    assert.equal(res.counts.ok, 2);
    assert.equal(kit.session.boardFs?.read('/old.py'), undefined);
    assert.equal(kit.session.boardFs?.read('/stay.py'), 's', 'the unselected delete did not run');
    assert.equal(kit.exists('gone.py'), false);
    assert.equal(kit.exists('stay.py'), true);
    assert.equal((await prep.ctx.store.load(prep.board)).files['old.py'], undefined);
  });

  it('creates empty folders on the board', async () => {
    kit = makeKit({ local: {} });
    fs.mkdirSync(path.join(kit.workspace, 'empty', 'inner'), { recursive: true });
    const p = await plan(kit, 'toBoard');
    assert.deepEqual(p.plan.items.map((i) => [i.path, i.action]), [['empty/inner', 'mkdir']]);
    const res = await p.run();
    assert.equal(res.counts.ok, 1);
    assert.ok(kit.session.boardFs?.paths().includes('/empty/inner'));
  });
});

describe('engine: main.py and boot.py notice (RQ-SAFE-7)', () => {
  it('tells the student once that an uploaded main.py runs at every power-up', async () => {
    kit = makeKit({ local: { 'main.py': 'print(1)' } });
    await (await plan(kit, 'toBoard')).run();
    const notes = () => mock.messages('info').filter((m) => /runs by itself every time the board starts/.test(m.message));
    assert.equal(notes().length, 1);
    assert.match(notes()[0]?.message ?? '', /\/main\.py/);
    assert.equal(kit.ctx.workspaceState.get(SYNC_STATE.bootNoticeShown), true);
    kit.write('main.py', 'print(2)');
    await (await plan(kit, 'toBoard')).run();
    assert.equal(notes().length, 1, 'shown only once per workspace');
  });

  it('stays quiet for other files', async () => {
    kit = makeKit({ local: { 'lib/main.py': 'x', 'other.py': 'y' } });
    await (await plan(kit, 'toBoard')).run();
    assert.equal(mock.messages('info').filter((m) => /runs by itself/.test(m.message)).length, 0);
  });
});

describe('engine: summary text', () => {
  it('counts what happened in plain words', async () => {
    kit = makeKit({ local: { 'a.py': 'a', 'b.py': 'b' }, board: { '/c.py': 'c' } });
    const down = await plan(kit, 'fromBoard');
    const up = await plan(kit, 'toBoard');
    const r1 = await up.run();
    assert.equal(kit.sync.engine.summaryText(r1), '2 uploaded.');
    const r2 = await down.run();
    assert.equal(kit.sync.engine.summaryText(r2), '1 downloaded.');
    assert.equal(kit.sync.engine.summaryText({ ...r2, results: [], counts: { ok: 0, failed: 0, skipped: 0, cancelled: 0 } }), 'Nothing needed to be copied.');
  });
});
