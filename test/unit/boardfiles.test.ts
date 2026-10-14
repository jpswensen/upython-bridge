/**
 * Files-view commands that act on the board: open (read-only, no local overwrite), new file/folder, rename (EEXIST explained),
 * delete, delete from board and computer (the local copy goes only after the board delete worked). Mock vscode + FakeSession.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { BOARD_SCHEME, MAX_OPEN_BYTES, boardDocumentUri, registerBoardFileCommands, validateNewName } from '../../src/commands/boardFiles';
import { COMMAND_IDS } from '../../src/contributes';
import { boardKeyOf } from '../../src/sync/baseline';
import { BoardError } from '../../src/types/session';
import type { BoardNode } from '../../src/types/sync';
import { FAKE_IDENTITY, FakeSession } from '../mocks/fakeSession';
import { mock } from '../mocks/vscode';
import { makeKit, sha, type Kit } from './sync/kit';

let kit: Kit;
beforeEach(() => mock.reset());
afterEach(() => kit?.dispose());

function setup(opts: Parameters<typeof makeKit>[0]): Kit {
  kit = makeKit({ tricky: true, ...opts });
  for (const d of registerBoardFileCommands(kit.services, { sync: kit.sync })) { mock.track(d); }
  return kit;
}

const file = (devicePath: string, size = 1): BoardNode => ({ devicePath, kind: 'file', name: devicePath.split('/').pop() ?? '', size });
const dir = (devicePath: string): BoardNode => ({ devicePath, kind: 'dir', name: devicePath.split('/').pop() ?? '' });
const run = (id: string, ...args: unknown[]): Thenable<unknown> => vscode.commands.executeCommand(id, ...args);
const errors = (): string => mock.messages('error').map((m) => m.message).join('\n');

/** Baseline entries for files that are identical on both sides (what a finished sync leaves behind). */
async function baselineOf(): Promise<Record<string, { sha256: string }>> {
  const ctx = await kit.sync.folderContext();
  assert.ok(ctx);
  return (await ctx.store.load(boardKeyOf(FAKE_IDENTITY))).files;
}

describe('open file from board', () => {
  it('shows the board file in a read-only document and never writes into the project', async () => {
    setup({ board: { '/lib/x.py': 'print(5)\n' } });
    await run(COMMAND_IDS.openFileFromBoard, file('/lib/x.py'));
    assert.equal(mock.calls.showTextDocument.length, 1);
    const shown = mock.calls.showTextDocument[0];
    assert.equal(shown?.uri, boardDocumentUri('/lib/x.py').toString());
    assert.match(shown?.uri ?? '', new RegExp(`^${BOARD_SCHEME}://board/lib/x\\.py$`));
    assert.equal(mock.documents.get(shown?.uri ?? '')?.getText(), 'print(5)\n');
    assert.deepEqual(fs.readdirSync(kit.workspace), [], 'nothing was written into the project');
    assert.equal(mock.documents.get(shown?.uri ?? '')?.languageId, 'python');
  });

  it('opens the local file when the project has one (a click never shows the board version instead) and does not touch it', async () => {
    setup({ local: { 'lib/x.py': 'my local version' }, board: { '/lib/x.py': 'board version' } });
    await run(COMMAND_IDS.openFileFromBoard, file('/lib/x.py'));
    assert.equal(kit.read('lib/x.py'), 'my local version');
    const shown = mock.calls.showTextDocument[0]?.uri ?? '';
    assert.match(shown, /^file:/);
    assert.equal(mock.documents.get(shown)?.getText(), 'my local version');
    // The board's own version stays one menu entry away, and never writes into the project either.
    await run(COMMAND_IDS.openBoardCopy, file('/lib/x.py'));
    assert.equal(mock.documents.get(mock.calls.showTextDocument[1]?.uri ?? '')?.getText(), 'board version');
    assert.equal(kit.read('lib/x.py'), 'my local version');
  });

  it('explains that a binary file cannot be shown', async () => {
    setup({});
    kit.session.boardFs?.write('/data.bin', new Uint8Array([0xff, 0xfe, 0x80, 0x00]));
    await run(COMMAND_IDS.openFileFromBoard, file('/data.bin'));
    assert.match(errors(), /is not a text file, so it cannot be shown/);
    assert.equal(mock.calls.showTextDocument.length, 0);
  });

  it('refuses files that are too big for an editor tab and names the alternative', async () => {
    setup({});
    kit.session.boardFs?.write('/big.txt', new Uint8Array(MAX_OPEN_BYTES + 1).fill(97));
    await run(COMMAND_IDS.openFileFromBoard, file('/big.txt'));
    assert.match(errors(), /too big to show here.*Download All Files/);
  });

  it('reports a file that vanished and asks consent when a program is running', async () => {
    setup({ session: FakeSession.connected({ state: 'running' }), board: { '/a.py': 'x' } });
    mock.answerMessage(/program is still running/, undefined, { once: true });
    await run(COMMAND_IDS.openFileFromBoard, file('/a.py'));
    assert.match(errors(), /still running/);
    mock.answerMessage(/program is still running/, 'Stop the program and continue');
    await run(COMMAND_IDS.openFileFromBoard, file('/missing.py'));
    assert.match(errors(), /does not exist on the board any more/);
  });

  it('tells the student what to click when the command comes without a file', async () => {
    setup({});
    await run(COMMAND_IDS.openFileFromBoard);
    assert.match(mock.messages('info')[0]?.message ?? '', /Right-click a file or folder in the Files view/);
  });
});

describe('New File / New Folder: created in the project AND on the board, in sync from the start (D-24)', () => {
  const editorPaths = (): string[] => mock.calls.showTextDocument.map((c) => c.uri);

  it('creates the file in the matching project folder and on the board, opens it editable, and marks it synced', async () => {
    setup({ board: { '/lib/other.py': 'o' }, local: { 'lib/other.py': 'o' } });
    const changes: string[][] = [];
    mock.track(kit.sync.onBoardChanged((paths) => { changes.push([...paths]); }));
    mock.answerInputBox('sensor.py');
    await run(COMMAND_IDS.newFileOnBoard, dir('/lib'));
    assert.equal(kit.read('lib/sensor.py'), '', 'created in the project');
    assert.equal(kit.session.boardFs?.read('/lib/sensor.py'), '', 'and on the board');
    assert.match(String((mock.calls.inputBoxes[0]?.options as { prompt?: string }).prompt), /new file in lib \(it is created in your project and on the board\)/);
    assert.deepEqual(kit.session.argsOf('fs.put').map((a) => a.ifSha), ['absent'], 'nothing on the board can be replaced');
    assert.ok(editorPaths().some((p) => p.includes('sensor.py') && p.startsWith('file:')), 'the project file opens (editable), not a board copy');
    assert.equal(kit.sync.badgeFor('/lib/sensor.py'), 'in-sync');
    assert.deepEqual(changes, [['/lib/sensor.py']], 'the Files view is told which board path is new');
  });

  it('uses the folder of a clicked file, and the folder of the project when started from the title bar', async () => {
    setup({ rootPath: '/app', board: { '/app/sub/b.py': 'b' }, local: { 'sub/b.py': 'b' } });
    mock.answerInputBox('a.py');
    await run(COMMAND_IDS.newFileOnBoard, file('/app/sub/b.py'));
    assert.equal(kit.read('sub/a.py'), '');
    assert.equal(kit.session.boardFs?.read('/app/sub/a.py'), '');
    mock.answerInputBox('top.py');
    await run(COMMAND_IDS.newFileOnBoard);
    assert.equal(kit.read('top.py'), '');
    assert.equal(kit.session.boardFs?.read('/app/top.py'), '');
  });

  it('refuses names that would break on Windows or contain slashes, before anything is made', async () => {
    setup({});
    for (const bad of ['con.py', 'a/b.py', 'what?.py', '', 'trail.']) {
      mock.answerInputBox(bad);
      await run(COMMAND_IDS.newFileOnBoard, dir('/'));
    }
    assert.equal(kit.session.callsOf('fs.put').length, 0);
    const problems = mock.calls.inputBoxes.map((c) => c.validationMessage);
    assert.match(problems[0] ?? '', /reserved name on Windows/);
    assert.match(problems[1] ?? '', /without slashes/);
    assert.match(problems[2] ?? '', /Windows does not allow/);
    assert.match(problems[3] ?? '', /Type a name/);
    assert.equal(validateNewName('main.py'), undefined);
    assert.equal(validateNewName('my notes (1).txt'), undefined);
  });

  it('never replaces a project file: it is opened instead, and the board is not touched', async () => {
    setup({ local: { 'a.py': 'mine' } });
    mock.answerInputBox('a.py');
    await run(COMMAND_IDS.newFileOnBoard, dir('/'));
    assert.equal(kit.read('a.py'), 'mine');
    assert.match(mock.messages('warn')[0]?.message ?? '', /a\.py already exists in your project/);
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });

  it('never replaces a board file: nothing is created anywhere', async () => {
    setup({ board: { '/a.py': 'keep me' } });
    mock.answerInputBox('a.py');
    await run(COMMAND_IDS.newFileOnBoard, dir('/'));
    assert.match(mock.messages('warn')[0]?.message ?? '', /\/a\.py already exists on the board/);
    assert.equal(kit.session.boardFs?.read('/a.py'), 'keep me');
    assert.equal(kit.exists('a.py'), false);
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });

  it('refuses a name that would hide a built-in module of the board, before anything is made', async () => {
    const session = FakeSession.connected({ identity: { ...FAKE_IDENTITY, profileHints: { ...FAKE_IDENTITY.profileHints, modules: ['alpha'] } } });
    setup({ session });
    mock.answerInputBox('alpha.py');
    await run(COMMAND_IDS.newFileOnBoard, dir('/'));
    assert.match(mock.messages('warn')[0]?.message ?? '', /"alpha" is a built-in module/);
    assert.equal(kit.exists('alpha.py'), false);
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });

  it('creates a folder in the project and on the board (with parents)', async () => {
    setup({ board: { '/lib/x.py': 'x' }, local: { 'lib/x.py': 'x' } });
    mock.answerInputBox('sub');
    await run(COMMAND_IDS.newFolderOnBoard, dir('/lib'));
    assert.ok(fs.statSync(`${kit.workspace}/lib/sub`).isDirectory());
    assert.deepEqual(kit.session.argsOf('fs.mkdir'), [{ path: '/lib/sub', parents: true }]);
    assert.ok(kit.session.boardFs?.paths().includes('/lib/sub'));
  });

  it('without a connection: made in the project only, marked as new, and it goes to the board later', async () => {
    setup({ session: new FakeSession() });
    mock.answerInputBox('later.py');
    await run(COMMAND_IDS.newFileOnBoard, dir('/'));
    assert.equal(kit.read('later.py'), '');
    assert.equal(kit.session.callsOf('fs.put').length, 0);
    assert.equal(kit.sync.badgeFor('/later.py'), 'local-only');
    assert.match(mock.messages('info').at(-1)?.message ?? '', /goes to the board when the board is connected/);
  });

  it('without a project folder: offers to open one and makes nothing', async () => {
    setup({});
    mock.setWorkspaceFolders();
    await run(COMMAND_IDS.newFileOnBoard, dir('/'));
    assert.match(mock.messages('warn').at(-1)?.message ?? '', /Open your project folder first/);
    assert.equal(mock.calls.inputBoxes.length, 0);
  });

  it('stops quietly when the name box is cancelled', async () => {
    setup({});
    mock.answerInputBox(undefined);
    await run(COMMAND_IDS.newFolderOnBoard, dir('/'));
    assert.equal(kit.session.callsOf('fs.mkdir').length, 0);
  });
});

describe('rename on board', () => {
  it('renames, moves the sync history along, and can rename the local copy too', async () => {
    setup({ local: { 'old.py': 'x' }, board: { '/old.py': 'x' } });
    await kit.sync.prepare('toBoard', kit.sync.newConsent('t'));
    assert.deepEqual(Object.keys(await baselineOf()), ['old.py']);
    mock.answerInputBox('new.py');
    mock.answerMessage(/Renamed old\.py to new\.py/, 'Rename my copy too');
    await run(COMMAND_IDS.renameOnBoard, file('/old.py'));
    assert.deepEqual(kit.session.argsOf('fs.mv'), [{ src: '/old.py', dst: '/new.py' }]);
    assert.equal(kit.session.boardFs?.read('/new.py'), 'x');
    assert.deepEqual(Object.keys(await baselineOf()), ['new.py']);
    assert.equal(kit.exists('old.py'), false);
    assert.equal(kit.read('new.py'), 'x');
    assert.equal((mock.calls.inputBoxes[0]?.options as { value?: string }).value, 'old.py', 'the box starts with the current name');
  });

  it('warns that the old name would come back when the local copy is left alone', async () => {
    setup({ local: { 'old.py': 'x' }, board: { '/old.py': 'x' } });
    mock.answerInputBox('new.py');
    await run(COMMAND_IDS.renameOnBoard, file('/old.py'));
    const msg = mock.messages('info').find((m) => /Renamed old\.py/.test(m.message));
    assert.match(msg?.message ?? '', /the next upload would put the old name back/);
    assert.deepEqual(msg?.items, ['Rename my copy too']);
    assert.equal(kit.exists('old.py'), true);
  });

  it('explains when the new name is taken', async () => {
    setup({ board: { '/old.py': '1', '/new.py': '2' } });
    mock.answerInputBox('new.py');
    await run(COMMAND_IDS.renameOnBoard, file('/old.py'));
    assert.match(errors(), /Could not rename old\.py: something with this name already exists on the board\. Choose a different name/);
    assert.equal(kit.session.boardFs?.read('/old.py'), '1');
    assert.equal(kit.session.boardFs?.read('/new.py'), '2');
  });

  it('does nothing for the same name or an unusable one', async () => {
    setup({ board: { '/old.py': '1' } });
    mock.answerInputBox('old.py');
    await run(COMMAND_IDS.renameOnBoard, file('/old.py'));
    mock.answerInputBox('a/b.py');
    await run(COMMAND_IDS.renameOnBoard, file('/old.py'));
    assert.equal(kit.session.callsOf('fs.mv').length, 0);
  });

  it('explains a refused module name', async () => {
    setup({ board: { '/old.py': '1' } });
    kit.session.fail('fs.mv', 'E_SHADOWS_MODULE', 'Refused.', { detail: 'module=alpha' });
    mock.answerInputBox('alpha.py');
    await run(COMMAND_IDS.renameOnBoard, file('/old.py'));
    assert.match(errors(), /built into the board/);
  });

  it('renames a folder and everything the sync history knew inside it', async () => {
    setup({ local: { 'lib/a.py': 'a', 'lib/b.py': 'b' }, board: { '/lib/a.py': 'a', '/lib/b.py': 'b' } });
    await kit.sync.prepare('toBoard', kit.sync.newConsent('t'));
    kit.session.script('fs.mv', {}); // the in-memory board only renames files; the bridge renames folders
    mock.answerInputBox('pkg');
    await run(COMMAND_IDS.renameOnBoard, dir('/lib'));
    assert.deepEqual(Object.keys(await baselineOf()).sort(), ['pkg/a.py', 'pkg/b.py']);
  });
});

describe('delete from board', () => {
  it('asks first, deletes only on the board, forgets the sync history and leaves the local copy', async () => {
    setup({ local: { 'old.py': 'x', 'keep.py': 'k' }, board: { '/old.py': 'x', '/keep.py': 'k' } });
    await kit.sync.prepare('toBoard', kit.sync.newConsent('t'));
    mock.answerMessage(/Delete old\.py from the board\?/, 'Delete from board');
    await run(COMMAND_IDS.deleteOnBoard, file('/old.py'));
    const ask = mock.messages('warn').find((m) => /Delete old\.py from the board\?/.test(m.message));
    assert.equal(ask?.modal, true);
    assert.match(ask?.detail ?? '', /Your copy on this computer is not touched/);
    assert.equal(kit.session.boardFs?.read('/old.py'), undefined);
    assert.equal(kit.session.boardFs?.read('/keep.py'), 'k');
    assert.equal(kit.read('old.py'), 'x');
    assert.deepEqual(Object.keys(await baselineOf()), ['keep.py']);
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /Deleted old\.py from the board\..*next upload would copy it back/);
  });

  it('deletes nothing when the question is dismissed', async () => {
    setup({ board: { '/old.py': 'x' } });
    await run(COMMAND_IDS.deleteOnBoard, file('/old.py'));
    assert.equal(kit.session.callsOf('fs.rm').length, 0);
  });

  it('deletes a folder with confirm:true and asks again for a mount point', async () => {
    setup({ board: { '/sd/a.txt': 'a' } });
    kit.session.script('fs.rmtree', (args, ctx) => {
      if ((args as { allowMount?: boolean }).allowMount !== true) {
        throw BoardError.of('E_FS_ERRNO', 'Mount point.', { detail: 'EPERM', needs_allow_mount: true, mount_reason: 'vfs' }, 'fs.rmtree');
      }
      return ctx.fallthrough() as never;
    });
    mock.answerMessage(/Delete sd from the board\?/, 'Delete from board');
    mock.answerMessage(/separate storage/, 'Delete the contents of this storage');
    await run(COMMAND_IDS.deleteOnBoard, dir('/sd'));
    assert.deepEqual((kit.session.argsOf('fs.rmtree') as { confirm: boolean; allowMount?: boolean }[]).map((a) => [a.confirm, a.allowMount === true]), [[true, false], [true, true]]);
    assert.equal(kit.session.boardFs?.paths().length, 0);
  });

  it('keeps a storage device when the student declines the mount question', async () => {
    setup({ board: { '/sd/a.txt': 'a' } });
    kit.session.script('fs.rmtree', () => { throw BoardError.of('E_FS_ERRNO', 'Mount point.', { detail: 'EPERM', needs_allow_mount: true }, 'fs.rmtree'); });
    mock.answerMessage(/Delete sd from the board\?/, 'Delete from board');
    mock.answerMessage(/separate storage/, undefined);
    await run(COMMAND_IDS.deleteOnBoard, dir('/sd'));
    assert.equal(kit.session.callsOf('fs.rmtree').length, 1);
    assert.equal(mock.messages('info').filter((m) => /^Deleted/.test(m.message)).length, 0);
  });

  it('reports a board error and does not claim success', async () => {
    setup({ board: { '/old.py': 'x' } });
    kit.session.fail('fs.rm', 'E_FS_ERRNO', 'The file is read-only.', { detail: 'EACCES', hint: 'Check that it is not in use.' });
    mock.answerMessage(/Delete old\.py/, 'Delete from board');
    await run(COMMAND_IDS.deleteOnBoard, file('/old.py'));
    assert.match(errors(), /Could not delete \/old\.py from the board: The file is read-only\./);
    assert.equal(kit.session.boardFs?.read('/old.py'), 'x');
    assert.equal(mock.messages('info').filter((m) => /^Deleted/.test(m.message)).length, 0);
  });
});

describe('delete from board and computer', () => {
  const ask = 'Delete from board and computer';

  it('deletes both, board first, and says the local copy went to the Trash', async () => {
    setup({ local: { 'lib/old.py': 'x' }, board: { '/lib/old.py': 'x' } });
    mock.answerMessage(/Delete old\.py from the board\?/, ask);
    await run(COMMAND_IDS.deleteOnBoardAndLocal, file('/lib/old.py'));
    const q = mock.messages('warn').find((m) => /Delete old\.py/.test(m.message));
    assert.match(q?.detail ?? '', /moved to the Trash/);
    assert.match(q?.detail ?? '', /lib\/old\.py/);
    assert.equal(kit.session.boardFs?.read('/lib/old.py'), undefined);
    assert.equal(kit.exists('lib/old.py'), false);
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /moved to the Trash/);
  });

  it('keeps the local copy when the board delete failed (the old extension lost it)', async () => {
    setup({ local: { 'old.py': 'precious' }, board: { '/old.py': 'x' } });
    kit.session.fail('fs.rm', 'E_FS_ERRNO', 'The file is read-only.', { detail: 'EACCES' });
    mock.answerMessage(/Delete old\.py/, ask);
    await run(COMMAND_IDS.deleteOnBoardAndLocal, file('/old.py'));
    assert.equal(kit.read('old.py'), 'precious');
    assert.equal(kit.session.boardFs?.read('/old.py'), 'x');
    assert.match(errors(), /Could not delete/);
  });

  it('keeps a local copy that has unsaved changes in an editor', async () => {
    setup({ local: { 'old.py': 'saved' }, board: { '/old.py': 'saved' } });
    const doc = await mock.openDocument(vscode.Uri.file(`${kit.workspace}/old.py`));
    doc.setText('unsaved edit');
    mock.answerMessage(/Delete old\.py/, ask);
    await run(COMMAND_IDS.deleteOnBoardAndLocal, file('/old.py'));
    assert.equal(kit.session.boardFs?.read('/old.py'), undefined);
    assert.equal(kit.read('old.py'), 'saved');
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /not deleted because it has unsaved changes/);
  });

  it('says so when there is no local copy, and still deletes on the board', async () => {
    setup({ board: { '/only_here.py': 'x' } });
    mock.answerMessage(/Delete only_here\.py/, ask);
    await run(COMMAND_IDS.deleteOnBoardAndLocal, file('/only_here.py'));
    const q = mock.messages('warn').find((m) => /Delete only_here/.test(m.message));
    assert.match(q?.detail ?? '', /no matching file in your project folder/);
    assert.equal(kit.session.boardFs?.read('/only_here.py'), undefined);
  });

  it('never reaches outside the project folder: a device path outside rootPath has no local counterpart', async () => {
    setup({ rootPath: '/app', local: { 'x.py': 'mine' }, board: { '/x.py': 'board root file' } });
    mock.answerMessage(/Delete x\.py/, ask);
    await run(COMMAND_IDS.deleteOnBoardAndLocal, file('/x.py'));
    assert.equal(kit.read('x.py'), 'mine', 'the project file with the same name is not the counterpart of /x.py');
    assert.equal(kit.session.boardFs?.read('/x.py'), undefined);
  });

  it('asks nothing and deletes nothing when dismissed', async () => {
    setup({ local: { 'old.py': 'x' }, board: { '/old.py': 'x' } });
    await run(COMMAND_IDS.deleteOnBoardAndLocal, file('/old.py'));
    assert.equal(kit.read('old.py'), 'x');
    assert.equal(kit.session.callsOf('fs.rm').length, 0);
    void sha;
  });
});
