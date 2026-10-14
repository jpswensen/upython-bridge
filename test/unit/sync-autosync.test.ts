/**
 * Auto-sync (D-10): debounce and coalesce, hash comparison, deferral while a program runs, background flag, ignored paths,
 * first-connect question, deletes and renames that are reported but never propagated, untrusted workspaces, disposal.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { settingId } from '../../src/identity';
import { SYNC_STATE } from '../../src/sync/state';
import { BoardError } from '../../src/types/session';
import { FakeSession } from '../mocks/fakeSession';
import { mock } from '../mocks/vscode';
import { makeKit, settle, sha, waitFor, type Kit } from './sync/kit';

let kit: Kit;
beforeEach(() => mock.reset());
// background uploads of a test must finish before its folders go, or their late warnings land in the next test
afterEach(async () => { await kit?.sync.whenIdle(); kit?.dispose(); });

const uri = (k: Kit, rel: string): vscode.Uri => vscode.Uri.file(`${k.workspace}/${rel}`);

/** Save a file the way an editor does and wait until auto-sync has noticed it. */
async function save(k: Kit, rel: string, text: string, timers = 1): Promise<void> {
  k.write(rel, text);
  await mock.saveFile(uri(k, rel), text);
  await waitFor(() => k.scheduler.size >= timers, `a timer for ${rel}`);
}

const puts = (k: Kit): { remote: string; background?: boolean; expectSha?: string }[] => k.session.argsOf('fs.put') as never;

describe('auto-sync on save', () => {
  it('uploads once after the debounce, with the background flag, and records the baseline', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    await save(kit, 'main.py', 'print(1)');
    assert.equal(kit.session.callsOf('fs.put').length, 0, 'nothing is sent before the debounce ends');
    assert.equal([...kit.scheduler.timers.values()][0]?.ms, 100, 'the delay comes from the debounce setting');
    assert.equal(kit.session.pendingSyncCount, 1, 'the status bar can show 1 file waiting');
    kit.scheduler.runAll();
    await waitFor(() => kit.session.boardFs?.read('/main.py') === 'print(1)', 'the upload');
    assert.equal(puts(kit)[0]?.background, true);
    assert.equal(puts(kit)[0]?.expectSha, sha('print(1)'));
    await waitFor(() => kit.session.pendingSyncCount === 0, 'the count to drop');
    assert.equal(mock.calls.statusMessages.some((m) => /Sent 1 file/.test(m)), true);
    const prep = await kit.sync.prepare('toBoard', kit.sync.newConsent('t'));
    assert.deepEqual(prep?.plan.items.map((i) => [i.path, i.reason]), [['main.py', 'identical']]);
    assert.equal(kit.sync.badgeFor('/main.py'), 'in-sync');
  });

  it('coalesces repeated saves of one file into one upload of the latest content', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    await save(kit, 'a.py', 'v1');
    for (const v of ['v2', 'v3', 'v4']) {
      kit.write('a.py', v);
      await mock.saveFile(uri(kit, 'a.py'), v);
      await settle(15);
    }
    assert.equal(kit.scheduler.size, 1, 'one timer for one path, restarted by each save');
    kit.scheduler.runAll();
    await waitFor(() => kit.session.boardFs?.read('/a.py') === 'v4', 'the upload');
    assert.equal(kit.session.callsOf('fs.put').length, 1);
  });

  it('keeps separate paths separate and sends them one after the other', async () => {
    kit = makeKit({ tricky: true, autoSync: 'on' });
    kit.sync.start();
    await save(kit, 'lib/café (v2).py', 'x');
    await save(kit, 'b.py', 'y', 2);
    kit.scheduler.runAll();
    await waitFor(() => kit.session.callsOf('fs.put').length === 2, 'two uploads');
    assert.deepEqual(puts(kit).map((p) => p.remote).sort(), ['/b.py', '/lib/café (v2).py']);
  });

  it('uploads nothing when a file is only touched (same bytes), e.g. by a cloud-sync client', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    await save(kit, 'a.py', 'same');
    kit.scheduler.runAll();
    await waitFor(() => kit.session.callsOf('fs.put').length === 1, 'the first upload');
    await waitFor(() => kit.session.pendingSyncCount === 0);
    // touched: identical bytes, delivered both as a save and as a watcher event
    await mock.saveFile(uri(kit, 'a.py'), 'same');
    mock.watchers[0]?.fireChange(uri(kit, 'a.py'));
    await waitFor(() => kit.scheduler.size >= 1, 'the debounce timer');
    kit.scheduler.runAll();
    await settle(80);
    assert.equal(kit.session.callsOf('fs.put').length, 1, 'no second upload');
    assert.equal(kit.session.pendingSyncCount, 0);
  });

  it('notices changes made outside the editor (copy-in, git checkout) through the file watcher', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    kit.write('new.py', 'from git');
    mock.watchers[0]?.fireCreate(uri(kit, 'new.py'));
    await waitFor(() => kit.scheduler.size === 1, 'the debounce timer');
    kit.scheduler.runAll();
    await waitFor(() => kit.session.boardFs?.read('/new.py') === 'from git', 'the upload');
  });

  it('never uploads ignored files, the ignore file itself or files outside the project', async () => {
    kit = makeKit({ autoSync: 'on', local: { '.mpyignore': '*.dat\n' } });
    kit.sync.start();
    for (const rel of ['typings/x.pyi', '.venv/lib/a.py', 'Thumbs.db', 'notes.tmp', 'run.dat']) {
      kit.write(rel, 'x');
      await mock.saveFile(uri(kit, rel), 'x');
    }
    await mock.saveFile(uri(kit, '.mpyignore'), '*.dat\n');
    const outside = path.join(kit.dirs.make(), 'outside.py');
    fs.writeFileSync(outside, 'x');
    await mock.saveFile(vscode.Uri.file(outside), 'x');
    await settle(80);
    assert.deepEqual([...(kit.sync.auto as unknown as { timers: Map<string, unknown> }).timers.keys()], [], 'nothing is queued');
    assert.equal(kit.scheduler.size, 0);
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });

  it('re-reads the ignore rules when .mpyignore changes', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    await save(kit, 'data.csv', '1');
    kit.scheduler.timers.clear();
    kit.write('.mpyignore', '*.csv\n');
    await mock.saveFile(uri(kit, '.mpyignore'), '*.csv\n');
    await settle(60);
    await mock.saveFile(uri(kit, 'data.csv'), '2');
    await settle(60);
    assert.equal(kit.scheduler.size, 0, 'data.csv is ignored now');
  });

  it('does nothing in the off and ask modes, and in an untrusted workspace', async () => {
    for (const mode of ['off', 'ask'] as const) {
      kit = makeKit({ autoSync: mode });
      kit.sync.start();
      kit.write('a.py', 'x');
      await mock.saveFile(uri(kit, 'a.py'), 'x');
      await settle(50);
      assert.equal(kit.scheduler.size, 0, mode);
      kit.dispose();
    }
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    mock.setTrusted(false);
    kit.write('a.py', 'x');
    await mock.saveFile(uri(kit, 'a.py'), 'x');
    await settle(50);
    assert.equal(kit.scheduler.size, 0);
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });
});

describe('auto-sync while the board is busy', () => {
  it('waits while a program runs, shows the count, and uploads when the board is idle again', async () => {
    kit = makeKit({ autoSync: 'on', session: FakeSession.connected({ state: 'running' }) });
    kit.sync.start();
    await save(kit, 'lib.py', 'v1');
    kit.scheduler.runAll();
    await waitFor(() => kit.session.pendingSyncCount === 1, 'the pending count');
    await settle(40);
    assert.equal(kit.session.callsOf('fs.put').length, 0, 'no upload (and no interruption) while the program runs');
    assert.equal(mock.messages().filter((m) => m.modal).length, 0, 'no question is asked in the background');
    kit.session.setState({ state: 'idle', reason: 'program ended' });
    await waitFor(() => kit.session.boardFs?.read('/lib.py') === 'v1', 'the deferred upload');
    await waitFor(() => kit.session.pendingSyncCount === 0);
  });

  it('keeps a file waiting when the bridge says a program is running, without asking', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    kit.session.script('fs.put', () => { throw BoardError.of('E_PROGRAM_RUNNING', 'A program is running.', { needs_interrupt: true }, 'fs.put'); });
    await save(kit, 'a.py', 'x');
    kit.scheduler.runAll();
    await waitFor(() => kit.session.callsOf('fs.put').length === 1, 'the attempt');
    await settle(40);
    assert.equal(kit.session.pendingSyncCount, 1, 'still waiting');
    assert.equal(mock.messages('warn').length, 0, 'a deferral is not an error');
    assert.equal((puts(kit)[0] as { interrupt?: boolean }).interrupt, undefined);
  });

  it('waits while disconnected and sends after the board connects', async () => {
    kit = makeKit({ autoSync: 'on', session: new FakeSession() });
    kit.sync.start();
    await save(kit, 'a.py', 'x');
    kit.scheduler.runAll();
    await waitFor(() => kit.session.pendingSyncCount === 1);
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => kit.session.boardFs?.read('/a.py') === 'x', 'the upload after connecting');
  });

  it('reports a real failure once, drops the file from the waiting list and does not retry forever', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    kit.session.fail('fs.put', 'E_FS_ERRNO', 'The board is full.', { detail: 'ENOSPC', hint: 'Delete files you do not need.' });
    await save(kit, 'a.py', 'x');
    kit.scheduler.runAll();
    await waitFor(() => mock.messages('warn').length === 1, 'the warning');
    assert.match(mock.messages('warn')[0]?.message ?? '', /Could not send 1 file to the board\. a\.py: The board is full/);
    assert.equal(kit.session.pendingSyncCount, 0);
    assert.equal(kit.session.callsOf('fs.put').length, 1);
  });
});

describe('SyncGate.flushPending (used by Run)', () => {
  it('sends everything waiting right now, including files still in their debounce', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    await save(kit, 'a.py', 'x');
    assert.equal(kit.sync.pendingCount, 1);
    const r = await kit.sync.flushPending();
    assert.deepEqual(r, { ok: true, uploaded: 1, failed: 0 });
    assert.equal(kit.session.boardFs?.read('/a.py'), 'x');
    assert.equal(kit.sync.pendingCount, 0);
    assert.equal(kit.scheduler.size, 0);
  });

  it('is a quick yes when nothing is waiting, and when auto-sync is not on', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    assert.deepEqual(await kit.sync.flushPending(), { ok: true, uploaded: 0, failed: 0 });
    kit.dispose();
    kit = makeKit({ autoSync: 'off' });
    assert.deepEqual(await kit.sync.flushPending(), { ok: true, uploaded: 0, failed: 0 });
  });

  it('says not ok when the files could not be sent', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    kit.session.fail('fs.put', 'E_FS_ERRNO', 'The board is full.', { detail: 'ENOSPC' });
    await save(kit, 'a.py', 'x');
    const r = await kit.sync.flushPending();
    assert.equal(r.ok, false);
    assert.equal(r.failed, 1);
  });

  it('says not ok when the board is not connected', async () => {
    kit = makeKit({ autoSync: 'on', session: new FakeSession() });
    kit.sync.start();
    await save(kit, 'a.py', 'x');
    assert.deepEqual(await kit.sync.flushPending(), { ok: false, uploaded: 0, failed: 1 });
  });
});

describe('local deletes and renames are reported, never propagated', () => {
  async function withKnownFile(): Promise<void> {
    kit = makeKit({ autoSync: 'on', local: { 'old.py': 'x', 'lib/m.py': 'm' }, board: { '/old.py': 'x', '/lib/m.py': 'm' } });
    kit.sync.start();
    const prep = await kit.sync.prepare('toBoard', kit.sync.newConsent('t'));
    assert.ok(prep);
    kit.session.calls.length = 0;
  }

  it('a deleted file that is on the board is reported and nothing is deleted there', async () => {
    await withKnownFile();
    mock.e.deleted.fire({ files: [uri(kit, 'old.py')] });
    await waitFor(() => mock.messages('info').some((m) => /only exists on the board now/.test(m.message)), 'the message');
    const msg = mock.messages('info').find((m) => /only exists on the board now/.test(m.message))?.message ?? '';
    assert.match(msg, /^1 file only exists on the board now: old\.py\. Nothing was deleted from the board\./);
    assert.equal(kit.session.callsOf('fs.rm').length + kit.session.callsOf('fs.rmtree').length + kit.session.callsOf('fs.mv').length, 0);
    assert.equal(kit.sync.badgeFor('/old.py'), 'board-only');
    assert.equal(kit.session.boardFs?.read('/old.py'), 'x');
  });

  it('a deleted folder reports its files, a rename reports the old name and sends the new one', async () => {
    await withKnownFile();
    mock.e.deleted.fire({ files: [uri(kit, 'lib')] });
    await waitFor(() => mock.messages('info').some((m) => /lib\/m\.py/.test(m.message)), 'the message');
    kit.write('renamed.py', 'x');
    mock.e.renamed.fire({ files: [{ oldUri: uri(kit, 'old.py'), newUri: uri(kit, 'renamed.py') }] });
    await waitFor(() => mock.messages('info').some((m) => /old\.py/.test(m.message)), 'the rename message');
    await waitFor(() => kit.scheduler.size === 1, 'the new name is queued');
    kit.scheduler.runAll();
    await waitFor(() => kit.session.boardFs?.read('/renamed.py') === 'x', 'the new name on the board');
    assert.equal(kit.session.boardFs?.read('/old.py'), 'x', 'the old name stays until the student deletes it');
  });

  it('says nothing about files the board never had', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    mock.e.deleted.fire({ files: [uri(kit, 'never_uploaded.py')] });
    await settle(60);
    assert.equal(mock.messages('info').length, 0);
  });

  it('forgets a queued upload of a file that was deleted before it went out', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    await save(kit, 'temp.py', 'x');
    mock.e.deleted.fire({ files: [uri(kit, 'temp.py')] });
    await waitFor(() => kit.sync.pendingCount === 0, 'the queue to empty');
    kit.scheduler.runAll();
    await settle(40);
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });
});

describe('first connect question (D-10)', () => {
  const QUESTION = /Copy your files to the board automatically/;
  const connectFresh = async (): Promise<void> => {
    kit = makeKit({ autoSync: 'ask', session: new FakeSession(), local: { 'main.py': 'print(1)' } });
    kit.sync.start();
  };

  it('asks once on the first connect and remembers "Turn on" in workspaceState without touching settings', async () => {
    await connectFresh();
    mock.answerMessage(QUESTION, 'Turn on');
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => kit.ctx.workspaceState.get(SYNC_STATE.autoSyncChoice) === 'on', 'the answer');
    assert.equal(mock.config.updates.length, 0, 'no setting is written unless the student asks');
    assert.equal(kit.sync.auto.mode(), 'on');
    await kit.session.disconnect();
    await kit.session.connect('/dev/cu.fake');
    await settle(40);
    assert.equal(mock.messages().filter((m) => QUESTION.test(m.message)).length, 1, 'asked only once');
  });

  it('can save the choice to the workspace settings so it is shared with the folder', async () => {
    await connectFresh();
    mock.answerMessage(QUESTION, 'Turn on and save to workspace settings');
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => mock.config.updates.length === 1, 'the setting write');
    assert.deepEqual(mock.config.updates.map((u) => [u.key, u.value, u.target]), [[settingId('autoSync'), 'on', vscode.ConfigurationTarget.Workspace]]);
  });

  it('"Not now" is remembered and the files are not uploaded', async () => {
    await connectFresh();
    mock.answerMessage(QUESTION, 'Not now');
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => kit.ctx.workspaceState.get(SYNC_STATE.autoSyncChoice) === 'off');
    assert.equal(kit.sync.auto.mode(), 'off');
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });

  it('dismissing the question asks again next time', async () => {
    await connectFresh();
    mock.answerMessage(QUESTION, undefined);
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => mock.messages().some((m) => QUESTION.test(m.message)));
    await settle(30);
    await kit.session.disconnect();
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => mock.messages().filter((m) => QUESTION.test(m.message)).length === 2, 'the second question');
    assert.equal(kit.ctx.workspaceState.get(SYNC_STATE.autoSyncChoice), undefined);
  });

  it('"Show me what would be uploaded" lists the dry-run plan, changes nothing, then asks again', async () => {
    await connectFresh();
    mock.answerMessage(QUESTION, 'Show me what would be uploaded', { once: true });
    mock.answerMessage(QUESTION, 'Not now');
    mock.answerQuickPick(undefined);
    await kit.session.connect('/dev/cu.fake');
    await waitFor(() => kit.ctx.workspaceState.get(SYNC_STATE.autoSyncChoice) === 'off', 'the final answer');
    assert.equal(mock.calls.quickPicks.length, 1);
    assert.ok(mock.calls.quickPicks[0]?.labels.some((l) => l === 'main.py'), 'the file is listed');
    assert.equal(kit.session.callsOf('fs.put').length, 0, 'a dry run uploads nothing');
    assert.equal(mock.messages().filter((m) => QUESTION.test(m.message)).length, 2);
  });

  it('does not ask when the setting already says on or off, or in an untrusted workspace', async () => {
    kit = makeKit({ autoSync: 'on', session: new FakeSession() });
    kit.sync.start();
    await kit.session.connect('/dev/cu.fake');
    await settle(40);
    assert.equal(mock.messages().filter((m) => QUESTION.test(m.message)).length, 0);
    kit.dispose();
    kit = makeKit({ autoSync: 'ask', session: new FakeSession() });
    kit.sync.start();
    mock.setTrusted(false);
    await kit.session.connect('/dev/cu.fake');
    await settle(40);
    assert.equal(mock.messages().filter((m) => QUESTION.test(m.message)).length, 0);
  });
});

describe('the toggle button', () => {
  it('switches between on and off in the workspace settings (an older ask counts as off) and explains each state (D-21)', async () => {
    kit = makeKit({ autoSync: 'ask' });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) { seen.push(await kit.sync.auto.cycleMode()); }
    assert.deepEqual(seen, ['on', 'off', 'on']);
    assert.deepEqual(mock.config.updates.map((u) => u.value), ['on', 'off', 'on']);
    assert.ok(mock.config.updates.every((u) => u.key === settingId('autoSync') && u.target === vscode.ConfigurationTarget.Workspace));
    const text = mock.messages('info').map((m) => m.message);
    assert.match(text[0] ?? '', /Auto-sync is ON/);
    assert.match(text[1] ?? '', /Auto-sync is OFF/);
  });

  it('starts from the remembered answer and clears it so the setting rules', async () => {
    kit = makeKit({ autoSync: 'ask' });
    await kit.ctx.workspaceState.update(SYNC_STATE.autoSyncChoice, 'on');
    assert.equal(await kit.sync.auto.cycleMode(), 'off');
    assert.equal(kit.ctx.workspaceState.get(SYNC_STATE.autoSyncChoice), undefined);
    assert.equal(kit.sync.auto.mode(), 'off');
  });

  it('turning it off drops files that were waiting', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    await save(kit, 'a.py', 'x');
    assert.equal(kit.sync.pendingCount, 1);
    mock.config.set(settingId('autoSync'), 'off');
    await waitFor(() => kit.sync.pendingCount === 0, 'the queue to clear');
    assert.equal(kit.scheduler.size, 0);
  });
});

describe('lifecycle', () => {
  it('disposes its watcher and listeners, and ignores events afterwards', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    assert.equal(mock.watchers.length, 1);
    kit.sync.dispose();
    assert.equal(mock.watchers[0]?.disposed, true);
    kit.write('a.py', 'x');
    await mock.saveFile(uri(kit, 'a.py'), 'x');
    await settle(40);
    assert.equal(kit.scheduler.size, 0);
  });

  it('start is idempotent: one watcher however often it is called', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    kit.sync.start();
    assert.equal(mock.watchers.length, 1);
  });
});
