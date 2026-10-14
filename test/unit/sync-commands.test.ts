/**
 * The Sync utilities commands end to end with the mock vscode and FakeSession: the dry-run preview, confirmations, backups,
 * Clear Device Files (scoped to rootPath, mount-point consent), Upload Current File, the toggle, and error reporting.
 * Folder names with spaces, parentheses and non-ASCII are used throughout (RQ-CLOUD-1).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { registerBoardFileCommands } from '../../src/commands/boardFiles';
import { registerSyncCommands } from '../../src/commands/sync';
import { COMMAND_IDS } from '../../src/contributes';
import { settingId } from '../../src/identity';
import { BoardError } from '../../src/types/session';
import { FakeSession } from '../mocks/fakeSession';
import { mock } from '../mocks/vscode';
import { makeKit, sha, type Kit } from './sync/kit';

let kit: Kit;
beforeEach(() => mock.reset());
afterEach(() => kit?.dispose());

function setup(opts: Parameters<typeof makeKit>[0]): Kit {
  kit = makeKit({ tricky: true, ...opts });
  for (const d of registerSyncCommands(kit.services, { sync: kit.sync })) { mock.track(d); }
  return kit;
}

/** Answer the preview list by ticking whatever the plan selected (and conflicts too when `conflicts`). */
const tick = (conflicts = false) => (items: readonly unknown[]): unknown[] =>
  (items as { sync?: { selected: boolean; action: string } }[]).filter((i) => i.sync && (i.sync.selected || (conflicts && i.sync.action === 'conflict')));

const run = (id: string, ...args: unknown[]): Thenable<unknown> => vscode.commands.executeCommand(id, ...args);

describe('Upload All Files', () => {
  it('shows the dry-run list, then uploads what was left ticked', async () => {
    setup({ local: { 'main.py': 'print(1)', 'lib/util.py': 'u = 1', 'lib/skip_me.py': 's' } });
    mock.answerQuickPick((items) => (items as { sync?: { path: string } }[]).filter((i) => i.sync && i.sync.path !== 'lib/skip_me.py'));
    await run(COMMAND_IDS.syncToBoard);
    const pick = mock.calls.quickPicks[0];
    assert.ok(pick);
    assert.equal((pick.options as { canPickMany?: boolean }).canPickMany, true);
    assert.deepEqual(pick.labels.filter((l) => !l.startsWith('Will be')).sort(), ['lib/skip_me.py', 'lib/util.py', 'main.py']);
    assert.equal(kit.session.boardFs?.read('/main.py'), 'print(1)');
    assert.equal(kit.session.boardFs?.read('/lib/util.py'), 'u = 1');
    assert.equal(kit.session.boardFs?.read('/lib/skip_me.py'), undefined, 'an unticked file stays home');
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /2 uploaded\./);
    assert.equal(mock.messages().filter((m) => m.modal).length, 0, 'pure additions need no extra confirmation');
  });

  it('does nothing when the student cancels the list', async () => {
    setup({ local: { 'main.py': 'x' } });
    mock.answerQuickPick(undefined);
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });

  it('says so when everything is already on the board, without a list', async () => {
    setup({ local: { 'main.py': 'x' }, board: { '/main.py': 'x' } });
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(mock.calls.quickPicks.length, 0);
    assert.match(mock.messages('info')[0]?.message ?? '', /already has every file/);
  });

  it('leaves a file that differs on the board unticked, and replaces it (with a backup) only when ticked and confirmed', async () => {
    setup({ local: { 'main.py': 'mine', 'new.py': 'n' }, board: { '/main.py': 'theirs' } });
    mock.answerQuickPick(tick());
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(kit.session.boardFs?.read('/main.py'), 'theirs', 'not replaced unless ticked');
    assert.equal(kit.session.boardFs?.read('/new.py'), 'n');
    const rows = mock.calls.quickPicks[0]?.labels ?? [];
    assert.ok(rows.some((l) => /Different on the board/.test(l)));

    mock.answerQuickPick(tick(true));
    mock.answerMessage(/Replace files on the board/, 'Upload 1 file(s)');
    await run(COMMAND_IDS.syncToBoard);
    const modal = mock.messages('warn').find((m) => /Replace files on the board/.test(m.message));
    assert.equal(modal?.modal, true);
    assert.match(modal?.detail ?? '', /main\.py/);
    assert.equal(kit.session.boardFs?.read('/main.py'), 'mine');
    assert.equal(fs.readFileSync(path.join(kit.sync.engine.lastBackupDir ?? '', 'board', 'main.py'), 'utf8'), 'theirs');
  });

  it('does not replace anything when the confirmation is declined', async () => {
    setup({ local: { 'main.py': 'mine' }, board: { '/main.py': 'theirs' } });
    mock.answerQuickPick(tick(true));
    mock.answerMessage(/Replace files on the board/, undefined);
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(kit.session.boardFs?.read('/main.py'), 'theirs');
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });

  it('connects through the select-port command when no board is connected', async () => {
    setup({ local: { 'a.py': 'a' }, session: new FakeSession() });
    mock.answerQuickPick(tick());
    await run(COMMAND_IDS.syncToBoard);
    assert.ok(mock.executedCommands.some((c) => c.id === COMMAND_IDS.selectPort && (c.args[0] as { reuse?: boolean }).reuse === true));
    assert.equal(kit.session.boardFs?.read('/a.py'), 'a');
  });

  it('stops quietly when no board gets connected', async () => {
    setup({ local: { 'a.py': 'a' }, session: new FakeSession(), selectPortStub: false });
    mock.track(vscode.commands.registerCommand(COMMAND_IDS.selectPort, () => false));
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(kit.session.callsOf('fs.manifest').length, 0);
    assert.equal(mock.messages('error').length, 0);
  });

  it('works on a board folder other than the root (rootPath)', async () => {
    setup({ local: { 'a.py': 'a', 'sub/b.py': 'b' }, rootPath: '/app/code' });
    mock.answerQuickPick(tick());
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(kit.session.boardFs?.read('/app/code/a.py'), 'a');
    assert.equal(kit.session.boardFs?.read('/app/code/sub/b.py'), 'b');
    assert.equal((kit.session.argsOf('fs.manifest')[0] as { root: string }).root, '/app/code');
  });

  it('treats a missing board folder as empty and creates it with the first file', async () => {
    setup({ local: { 'a.py': 'a' }, rootPath: '/does/not/exist' });
    mock.answerQuickPick(tick());
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(kit.session.boardFs?.read('/does/not/exist/a.py'), 'a');
  });

  it('uses download-compare on a board that cannot hash: same size, different content is found', async () => {
    setup({ local: { 'same.py': 'abc', 'diff.py': 'abc' }, board: { '/same.py': 'abc', '/diff.py': 'abd' } });
    kit.session.script('fs.manifest', async (_a, ctx) => {
      const full = (await ctx.fallthrough()) as { entries: { sha256?: string }[] };
      return { ...full, entries: full.entries.map((e) => ({ ...e, sha256: undefined })), hash: 'none' } as never;
    });
    mock.answerQuickPick(tick());
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(kit.session.callsOf('fs.get').length, 2, 'both same-size files were downloaded to be compared');
    const rows = mock.calls.quickPicks[0]?.labels ?? [];
    assert.deepEqual(rows.filter((l) => !/^(Note|Will|Different|New)/.test(l)), ['diff.py'], 'only the file that really differs is listed');
    assert.ok(mock.calls.quickPicks[0]?.labels.some((l) => /Different on the board/.test(l)));
    assert.equal(kit.session.boardFs?.read('/diff.py'), 'abd', 'not replaced: unticked conflict');
  });

  it('reports a failing board in one error message and the log, and does not throw', async () => {
    setup({ local: { 'a.py': 'a' } });
    kit.session.fail('fs.manifest', 'E_PORT_BUSY', 'The port is in use by another program.', { hint: 'Close Thonny or other serial programs, then press Retry.' });
    await run(COMMAND_IDS.syncToBoard);
    const err = mock.messages('error')[0];
    assert.match(err?.message ?? '', /Uploading all files did not work\. The port is in use by another program\. Close Thonny/);
    assert.deepEqual(err?.items, ['Show Log']);
    assert.match(kit.channel.text, /Uploading all files failed/);
  });

  it('offers to stop a running program once, then proceeds', async () => {
    setup({ local: { 'a.py': 'a' }, session: FakeSession.connected({ state: 'running' }) });
    mock.answerMessage(/program is still running/, 'Stop the program and continue');
    mock.answerQuickPick(tick());
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(kit.session.boardFs?.read('/a.py'), 'a');
    assert.equal(mock.messages('warn').filter((m) => /program is still running/.test(m.message)).length, 1);
  });
});

describe('Download All Files', () => {
  it('asks in a modal naming the files it will replace, keeps a copy of each, then downloads', async () => {
    setup({ local: { 'b.py': 'mine' }, board: { '/a.py': 'new from board', '/b.py': 'board version' } });
    mock.answerQuickPick(tick(true));
    mock.answerMessage(/Replace files on your computer/, 'Download 2 file(s)');
    await run(COMMAND_IDS.syncFromBoard);
    const modal = mock.messages('warn').find((m) => /Replace files on your computer/.test(m.message));
    assert.equal(modal?.modal, true);
    assert.match(modal?.detail ?? '', /A copy of each is saved first/);
    assert.match(modal?.detail ?? '', /b\.py/);
    assert.equal(kit.read('a.py'), 'new from board');
    assert.equal(kit.read('b.py'), 'board version');
    const backup = kit.sync.engine.lastBackupDir ?? '';
    assert.equal(fs.readFileSync(path.join(backup, 'b.py'), 'utf8'), 'mine');
    assert.ok(backup.startsWith(kit.ctx.storageUri.fsPath), 'backups live in the extension storage, not in the project');
    assert.equal(fs.readdirSync(kit.workspace).sort().join(), 'a.py,b.py', 'no stray files in the project');
  });

  it('changes nothing when the modal is declined', async () => {
    setup({ local: { 'b.py': 'mine' }, board: { '/b.py': 'board version' } });
    mock.answerQuickPick(tick(true));
    mock.answerMessage(/Replace files on your computer/, undefined);
    await run(COMMAND_IDS.syncFromBoard);
    assert.equal(kit.read('b.py'), 'mine');
    assert.equal(kit.session.callsOf('fs.get').length, 0);
  });

  it('asks even when it only adds files (Board to Local always confirms)', async () => {
    setup({ board: { '/a.py': 'a' } });
    mock.answerQuickPick(tick());
    mock.answerMessage(/Replace files on your computer/, 'Download 1 file(s)');
    await run(COMMAND_IDS.syncFromBoard);
    assert.equal(mock.messages('warn').filter((m) => m.modal).length, 1);
    assert.equal(kit.read('a.py'), 'a');
  });

  it('skips ignored names and a board name Windows cannot store, and says so in the list', async () => {
    setup({ board: { '/ok.py': 'a', '/Thumbs.db': 'b', '/lib/x.pyi': 'c' } });
    mock.answerQuickPick(tick());
    mock.answerMessage(/Replace files on your computer/, 'Download 1 file(s)');
    await run(COMMAND_IDS.syncFromBoard);
    assert.equal(kit.read('ok.py'), 'a');
    assert.equal(kit.exists('Thumbs.db'), false);
    assert.ok(mock.calls.quickPicks[0]?.labels.some((l) => /2 file\(s\) on the board match your ignore list/.test(l)));
  });
});

describe('Clear Device Files', () => {
  const mountAware = (): void => {
    kit.session.script('fs.rmtree', (args, ctx) => {
      const a = args as { path: string; allowMount?: boolean };
      if (a.path === '/sd' && a.allowMount !== true) {
        throw BoardError.of('E_FS_ERRNO', '/sd is a separate storage.', { detail: 'EPERM', needs_allow_mount: true, mount_reason: 'dev' }, 'fs.rmtree');
      }
      return ctx.fallthrough() as never;
    });
  };
  const files = { '/main.py': 'm', '/lib/x.py': 'x', '/sd/data.txt': 'd' };

  it('asks in a modal naming the items, deletes with confirm:true, asks again for a mount point, and verifies', async () => {
    setup({ board: files });
    mountAware();
    mock.answerMessage(/Delete everything in \//, 'Delete 3 items');
    mock.answerMessage(/separate storage/, 'Delete the contents of this storage');
    await run(COMMAND_IDS.clearDevice);
    const modal = mock.messages('warn').find((m) => /Delete everything in \//.test(m.message));
    assert.equal(modal?.modal, true);
    assert.match(modal?.detail ?? '', /lib\/\n.*main\.py\n.*sd\//);
    assert.match(modal?.detail ?? '', /boot\.py and main\.py/);
    const trees = kit.session.argsOf('fs.rmtree') as { path: string; confirm: boolean; allowMount?: boolean }[];
    assert.deepEqual(trees.map((t) => [t.path, t.confirm, t.allowMount === true]), [['/lib', true, false], ['/sd', true, false], ['/sd', true, true]]);
    assert.deepEqual((kit.session.argsOf('fs.rm') as { path: string }[]).map((a) => a.path), ['/main.py']);
    assert.deepEqual(kit.session.boardFs?.paths(), []);
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /Deleted 3 items from \/\. The folder is now empty\./);
    assert.equal(kit.session.callsOf('fs.list').length, 2, 'the board is listed again to verify, no cache');
  });

  it('leaves a storage device alone when the student says no, and reports exactly what remains', async () => {
    setup({ board: files });
    mountAware();
    mock.answerMessage(/Delete everything in \//, 'Delete 3 items');
    mock.answerMessage(/separate storage/, undefined);
    await run(COMMAND_IDS.clearDevice);
    assert.deepEqual(kit.session.boardFs?.paths(), ['/sd', '/sd/data.txt']);
    const text = mock.messages('warn').map((m) => m.message).join('\n');
    assert.match(text, /Deleted 2 items from \//);
    assert.match(text, /Left alone at your request: \/sd\./);
    assert.match(text, /1 item is still on the board\./);
  });

  it('only touches the configured board folder, never the folder itself or anything outside it', async () => {
    setup({ board: { '/main.py': 'm', '/lib/a.py': 'a', '/lib/pkg/b.py': 'b', '/other/c.py': 'c' }, rootPath: '/lib' });
    mock.answerMessage(/Delete everything in \/lib/, 'Delete 2 items');
    await run(COMMAND_IDS.clearDevice);
    const touched = [...(kit.session.argsOf('fs.rm') as { path: string }[]), ...(kit.session.argsOf('fs.rmtree') as { path: string }[])].map((a) => a.path);
    assert.deepEqual(touched.sort(), ['/lib/a.py', '/lib/pkg']);
    assert.deepEqual(kit.session.boardFs?.paths().sort(), ['/lib', '/main.py', '/other', '/other/c.py']);
    assert.ok(touched.every((p) => p.startsWith('/lib/')));
    assert.equal((kit.session.argsOf('fs.list')[0] as { path: string }).path, '/lib');
    const modal = mock.messages('warn').find((m) => /Delete everything in \/lib/.test(m.message));
    assert.doesNotMatch(modal?.detail ?? '', /boot\.py and main\.py/, 'the boot.py warning is only for the root folder');
  });

  it('forgets the sync history of what it deleted', async () => {
    setup({ local: { 'a.py': 'a' }, board: { '/a.py': 'a', '/keep/x.py': 'x' }, rootPath: '/' });
    const prep = await kit.sync.prepare('toBoard', kit.sync.newConsent('t'));
    assert.ok(prep);
    assert.equal(Object.keys((await prep.ctx.store.load(prep.board)).files).length, 1);
    mock.answerMessage(/Delete everything/, 'Delete 2 items');
    await run(COMMAND_IDS.clearDevice);
    assert.deepEqual((await prep.ctx.store.load(prep.board)).files, {});
  });

  it('deletes nothing when the modal is dismissed', async () => {
    setup({ board: files });
    await run(COMMAND_IDS.clearDevice);
    assert.equal(kit.session.callsOf('fs.rm').length + kit.session.callsOf('fs.rmtree').length, 0);
    assert.equal(kit.session.boardFs?.paths().length, 5);
  });

  it('says so when there is nothing to delete', async () => {
    setup({ board: {} });
    await run(COMMAND_IDS.clearDevice);
    assert.match(mock.messages('info')[0]?.message ?? '', /There is nothing to delete/);
  });

  it('reports files it could not delete, with the reason, and keeps going', async () => {
    setup({ board: { '/a.py': 'a', '/b.py': 'b' } });
    kit.session.fail('fs.rm', 'E_FS_ERRNO', 'The file is read-only.', { detail: 'EACCES', hint: 'Check that the file is not in use.' });
    mock.answerMessage(/Delete everything/, 'Delete 2 items');
    await run(COMMAND_IDS.clearDevice);
    assert.deepEqual(kit.session.boardFs?.paths(), ['/a.py']);
    const warn = mock.messages('warn').map((m) => m.message).join('\n');
    assert.match(warn, /Deleted 1 item from \/\. 1 could not be deleted: \/a\.py: The file is read-only\./);
    assert.match(warn, /1 item is still on the board/);
  });
});

describe('Upload Current File', () => {
  it('uploads the file in the editor to the board folder that matches the project, saving it first', async () => {
    setup({ local: { 'lib/main.py': 'old' }, rootPath: '/app' });
    const doc = await mock.openDocument(vscode.Uri.file(`${kit.workspace}/lib/main.py`));
    await mock.openEditor(doc);
    doc.setText('print("typed")');
    await run(COMMAND_IDS.uploadActiveFile);
    assert.equal(kit.read('lib/main.py'), 'print("typed")', 'the dirty editor was saved');
    assert.equal(kit.session.boardFs?.read('/app/lib/main.py'), 'print("typed")', 'rootPath applies to a single file too');
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /Uploaded lib\/main\.py to \/app\/lib\/main\.py/);
    await run(COMMAND_IDS.uploadActiveFile);
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /already up to date/);
  });

  it('tells the student when no file is open or the file is outside the project', async () => {
    setup({});
    await run(COMMAND_IDS.uploadActiveFile);
    assert.match(mock.messages('info')[0]?.message ?? '', /Open the file you want to upload/);
    const outside = path.join(kit.dirs.make(), 'x.py');
    fs.writeFileSync(outside, 'x');
    await mock.openEditor(vscode.Uri.file(outside));
    await run(COMMAND_IDS.uploadActiveFile);
    assert.match(mock.messages('warn')[0]?.message ?? '', /outside your project folder/);
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });

  it('asks before uploading a file that is on the ignore list', async () => {
    setup({ local: { 'typings/a.pyi': 'x' } });
    await mock.openEditor(vscode.Uri.file(`${kit.workspace}/typings/a.pyi`));
    await run(COMMAND_IDS.uploadActiveFile);
    assert.equal(kit.session.callsOf('fs.put').length, 0);
    mock.answerMessage(/on the ignore list/, 'Upload anyway');
    await run(COMMAND_IDS.uploadActiveFile);
    assert.equal(kit.session.boardFs?.read('/typings/a.pyi'), 'x');
  });

  it('explains a refused module name', async () => {
    setup({ local: { 'a.py': 'x' } });
    kit.session.fail('fs.put', 'E_SHADOWS_MODULE', 'Refused.', { detail: 'module=a' });
    await mock.openEditor(vscode.Uri.file(`${kit.workspace}/a.py`));
    await run(COMMAND_IDS.uploadActiveFile);
    assert.match(mock.messages('warn')[0]?.message ?? '', /built into the board/);
  });
});

describe('registration', () => {
  it('registers exactly the sync and board-file commands that the manifest declares for them', async () => {
    setup({});
    for (const d of registerBoardFileCommands(kit.services, { sync: kit.sync })) { mock.track(d); }
    const c = mock.commandContract();
    assert.deepEqual(c.extra, [], 'nothing registered that the manifest does not declare');
    const mine = ['uploadActiveFile', 'syncToBoard', 'syncFromBoard', 'clearDevice', 'toggleAutoSync', 'openFileFromBoard', 'newFileOnBoard', 'newFolderOnBoard', 'renameOnBoard', 'deleteOnBoard', 'deleteOnBoardAndLocal'];
    const prefix = COMMAND_IDS.syncToBoard.slice(0, COMMAND_IDS.syncToBoard.length - 'syncToBoard'.length);
    for (const name of mine) { assert.ok(c.registered.includes(`${prefix}${name}`), name); }
  });

  it('the toggle command cycles the workspace setting', async () => {
    setup({});
    await run(COMMAND_IDS.toggleAutoSync);
    assert.deepEqual(mock.config.updates.map((u) => [u.key, u.value]), [[settingId('autoSync'), 'on']]);
  });

  it('never writes the word auto anywhere', async () => {
    setup({ local: { 'a.py': 'a' } });
    mock.answerQuickPick(tick());
    await run(COMMAND_IDS.syncToBoard);
    await run(COMMAND_IDS.toggleAutoSync);
    assert.ok(mock.config.updates.every((u) => String(u.value).toLowerCase() !== 'auto' || u.key.endsWith('autoSync')));
    assert.equal(kit.session.calls.filter((c) => JSON.stringify(c.args).toLowerCase().includes('"port":"auto"')).length, 0);
    void sha;
  });
});

describe('the ignore file', () => {
  it('creates a commented default .mpyignore once, opens it, and never overwrites it', async () => {
    setup({});
    await kit.sync.createIgnoreFile();
    const text = kit.read('.mpyignore') ?? '';
    assert.match(text, /^# /);
    assert.match(text, /\.venv\//);
    assert.equal(mock.calls.showTextDocument.length, 1);
    kit.write('.mpyignore', 'mine\n');
    await kit.sync.createIgnoreFile();
    assert.equal(kit.read('.mpyignore'), 'mine\n');
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /already exists/);
  });

  it('picks up new rules on the next upload', async () => {
    setup({ local: { 'a.py': 'a', 'notes.txt': 'n' } });
    mock.answerQuickPick(tick());
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(kit.session.boardFs?.read('/notes.txt'), 'n');
    kit.write('.mpyignore', 'notes.txt\nextra.py\n');
    kit.write('extra.py', 'e');
    kit.write('more.py', 'm');
    await kit.sync.createIgnoreFile(); // existing file: only re-reads the rules
    mock.answerQuickPick(tick());
    await run(COMMAND_IDS.syncToBoard);
    assert.equal(kit.session.boardFs?.read('/extra.py'), undefined);
    assert.equal(kit.session.boardFs?.read('/more.py'), 'm');
  });
});
