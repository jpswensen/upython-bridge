/**
 * The student journey "click a board file in the Files view, then press Run" (found on the instructor's machine, 2026-10-13:
 * every file showed a green check, a click opened a read-only board document and Run said "test.py is not a file on this
 * computer"). Mock vscode + FakeSession; the pieces are the real ones, wired like src/extension.ts wires them: click command,
 * Run command, BoardCopy, SyncService, terminal.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COPY_AND_RUN_BUTTON, COPY_BUTTON, BoardCopy } from '../../src/commands/boardCopy';
import { BOARD_SCHEME, boardDocumentUri, registerBoardFileCommands } from '../../src/commands/boardFiles';
import { registerRun, type RunDeps } from '../../src/commands/run';
import { buildManifest, COMMAND_IDS, MENUS } from '../../src/contributes';
import { ReplTerminal } from '../../src/repl/terminal';
import { boardKeyOf } from '../../src/sync/baseline';
import { BoardError } from '../../src/types/session';
import type { BoardNode } from '../../src/types/sync';
import { activeFileLabel } from '../../src/views/actionsView';
import { SyncStatus } from '../../src/sync/status';
import { FilesTree } from '../../src/views/filesView';
import { FILES_TEXT } from '../../src/views/strings';
import { Settings } from '../../src/types/settings';
import { FAKE_IDENTITY, FakeSession } from '../mocks/fakeSession';
import { createTestLogger, mock } from '../mocks/vscode';
import { makeKit, type Kit } from './sync/kit';

let kit: Kit;
let terminal: ReplTerminal;
beforeEach(() => mock.reset());
afterEach(() => {
  terminal?.dispose();
  kit?.dispose();
});

/** Wired like activate(): ONE BoardCopy shared by the click command and Run. `wireRun: false` = Run without board-file support. */
function setup(opts: Parameters<typeof makeKit>[0], wireRun = true): void {
  kit = makeKit({ tricky: true, ...opts });
  terminal = new ReplTerminal(kit.services);
  const copy = new BoardCopy(kit.services, kit.sync);
  const boardFiles: RunDeps['boardFiles'] = wireRun ? { localCounterpart: (p) => kit.sync.localCounterpart(p), copy } : undefined;
  for (const d of registerBoardFileCommands(kit.services, { sync: kit.sync, copy })) { mock.track(d); }
  for (const d of registerRun(kit.services, { terminal, syncGate: kit.sync, boardFiles })) { mock.track(d); }
}

const file = (devicePath: string): BoardNode => ({ devicePath, kind: 'file', name: devicePath.split('/').pop() ?? '', size: 1 });
const click = (devicePath: string): Thenable<unknown> => vscode.commands.executeCommand(COMMAND_IDS.openFileFromBoard, file(devicePath));
const pressRun = (arg?: unknown): Thenable<unknown> => vscode.commands.executeCommand(COMMAND_IDS.runActiveFile, ...(arg === undefined ? [] : [arg]));
const runCalls = (): { local: string; name?: string; reset?: boolean }[] => kit.session.argsOf('run') as unknown as { local: string; name?: string; reset?: boolean }[];
const local = (rel: string): string => path.join(kit.workspace, ...rel.split('/'));
const offers = (text: RegExp): ReturnType<typeof mock.messages> => mock.messages().filter((m) => text.test(m.message));
const activeUri = (): string => mock.activeEditor?.document.uri.toString() ?? '(no editor)';

/** Wait for background work that the test cannot await (the answer to a toast). */
async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Make the info toasts behave like VS Code does with buttons: the promise stays pending until the user answers. Records them as usual. */
async function withPendingToasts<T>(work: () => Promise<T>): Promise<T> {
  const w = vscode.window as unknown as Record<string, unknown>;
  const original = w.showInformationMessage;
  w.showInformationMessage = (message: string, ...rest: unknown[]) => { mock.showMessage('info', message, rest); return new Promise<never>(() => undefined); };
  try { return await work(); } finally { w.showInformationMessage = original; }
}

async function finishesWithin<T>(ms: number, what: string, work: Thenable<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms (it waited for a toast?)`)), ms); });
  try { return await Promise.race([Promise.resolve(work), limit]); } finally { clearTimeout(timer); }
}


/** A tree item tooltip as text (the D-21 hover is a MarkdownString). */
function tipText(tip: string | vscode.MarkdownString | undefined): string {
  return typeof tip === 'string' ? tip : tip?.value ?? '';
}

describe('click a board file: the file in the Files view IS my file', () => {
  it('a synced file opens the file of the project: scheme file, no board document, no board traffic, no toast', async () => {
    setup({ local: { 'test.py': 'print(1)\n' }, board: { '/test.py': 'print(1)\n' } });
    await click('/test.py');
    assert.equal(mock.activeEditor?.document.uri.scheme, 'file', `the editor holds ${activeUri()}`);
    assert.equal(mock.activeEditor?.document.uri.fsPath, local('test.py'));
    assert.deepEqual(mock.calls.showTextDocument.map((c) => c.options), [{ preview: true }]);
    assert.equal([...mock.documents.keys()].filter((k) => k.startsWith(BOARD_SCHEME)).length, 0, 'the board provider was not asked');
    assert.equal(kit.session.callsOf('fs.get').length, 0);
    assert.equal(mock.calls.messages.length, 0, 'no toast');
  });

  it('works without a connected board (the project file needs none) and for files in sub-folders', async () => {
    setup({ session: FakeSession.connected({ state: 'disconnected', port: null }), local: { 'lib/util.py': 'x = 1\n' }, board: {} });
    await click('/lib/util.py');
    assert.equal(mock.activeEditor?.document.uri.fsPath, local('lib/util.py'));
    assert.equal(kit.session.calls.length, 0, 'nothing was asked of the board');
  });

  it('opens the PROJECT file when it differs from the board; "Open the Board\'s Copy" still shows the board version, read-only', async () => {
    setup({ local: { 'x.py': 'my version' }, board: { '/x.py': 'board version' } });
    await click('/x.py');
    assert.equal(mock.activeEditor?.document.getText(), 'my version');
    assert.equal(kit.read('x.py'), 'my version');
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/x.py'));
    assert.equal(activeUri(), boardDocumentUri('/x.py').toString());
    assert.equal(mock.activeEditor?.document.getText(), 'board version');
    assert.equal(mock.calls.messages.length, 0, 'the explicit command is not followed by an offer');
    assert.equal(kit.read('x.py'), 'my version', 'the project file is untouched');
  });

  it('the Board\'s Copy command is declared, hidden from the palette, and sits in the Files-view context menu of files', () => {
    setup({});
    const manifest = buildManifest().contributes as { menus: Record<string, { command: string; when: string }[]>; commands: { command: string; title: string }[] };
    assert.equal(manifest.commands.find((c) => c.command === COMMAND_IDS.openBoardCopy)?.title, "Open the Board's Copy (Read-Only)");
    assert.ok(manifest.menus.commandPalette?.some((e) => e.command === COMMAND_IDS.openBoardCopy && e.when === 'false'));
    const entry = MENUS.find((m) => m.command === 'openBoardCopy');
    assert.equal(entry?.menu, 'view/item/context');
    assert.match(entry?.when ?? '', /viewItem == file$/);
    assert.ok(mock.commandHandlers.has(COMMAND_IDS.openBoardCopy), 'registered');
  });

  it('tells a student who runs the explicit command without a file what to click', async () => {
    setup({});
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy);
    assert.match(mock.messages('info')[0]?.message ?? '', /Right-click a file or folder in the Files view and choose "Open the Board's Copy \(Read-Only\)"/);
  });
});

describe('click a file that is only on the board: read-only copy plus a non-blocking offer', () => {
  it('opens the board document and starts the offer; the command finishes while the toast is still open; nothing is written', async () => {
    setup({ board: { '/lib/sensor.py': 'print(5)\n' } });
    await withPendingToasts(async () => {
      await finishesWithin(2000, 'the click', click('/lib/sensor.py'));
    });
    assert.equal(activeUri(), boardDocumentUri('/lib/sensor.py').toString());
    assert.equal(mock.activeEditor?.document.getText(), 'print(5)\n');
    const offer = offers(/only on the board/);
    assert.equal(offer.length, 1);
    assert.equal(offer[0]?.message, 'sensor.py is only on the board, not in your project folder.');
    assert.deepEqual(offer[0]?.items, [COPY_BUTTON]);
    assert.equal(offer[0]?.level, 'info');
    assert.deepEqual(fs.readdirSync(kit.workspace), [], 'nothing was written into the project');
  });

  it('"Copy it to my project" downloads to the mapped path (parent folders created), opens it, marks it in sync and keeps the history', async () => {
    setup({ board: { '/lib/sub/sensor.py': 'print(5)\n' } });
    mock.answerMessage(/only on the board/, COPY_BUTTON);
    await click('/lib/sub/sensor.py');
    await until('the project file', () => (kit.read('lib/sub/sensor.py') ?? '') !== '');
    assert.equal(kit.read('lib/sub/sensor.py'), 'print(5)\n');
    await until('the project file in the editor', () => mock.activeEditor?.document.uri.scheme === 'file');
    assert.equal(mock.activeEditor?.document.uri.fsPath, local('lib/sub/sensor.py'));
    assert.equal(kit.sync.badgeFor('/lib/sub/sensor.py'), 'in-sync');
    const ctx = await kit.sync.folderContext();
    const baseline = (await ctx?.store.load(boardKeyOf(FAKE_IDENTITY)))?.files ?? {};
    assert.equal(baseline['lib/sub/sensor.py']?.sha256, kit.session.boardFs?.fileHash('/lib/sub/sensor.py'));
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /Copied sensor\.py to your project \(lib\/sub\/sensor\.py\)/);
    const scratch = path.join(kit.ctx.storageUri.fsPath, 'board-files');
    assert.deepEqual(fs.existsSync(scratch) ? fs.readdirSync(scratch) : [], [], 'the temporary download is gone');
    // The next click goes straight to the project file now.
    mock.calls.showTextDocument.length = 0;
    mock.calls.messages.length = 0;
    await click('/lib/sub/sensor.py');
    assert.equal(mock.calls.messages.length, 0);
    assert.equal(mock.calls.showTextDocument[0]?.uri.startsWith('file:'), true);
  });

  it('a dismissed toast copies nothing', async () => {
    setup({ board: { '/a.py': '1' } });
    await click('/a.py');
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(fs.readdirSync(kit.workspace), []);
    assert.equal(kit.session.callsOf('fs.get').length, 1, 'only the read-only document was downloaded');
  });

  it('never overwrites a file that appeared while the toast was open: calm message, the file is untouched, no download', async () => {
    setup({ board: { '/a.py': 'board' } });
    mock.answerMessage(/only on the board/, () => { kit.write('a.py', 'mine, created meanwhile'); return COPY_BUTTON; });
    await click('/a.py');
    await until('the calm message', () => offers(/in your project folder already/).length === 1);
    assert.match(offers(/in your project folder already/)[0]?.message ?? '', /^a\.py is in your project folder already, so nothing was copied and your file was not changed/);
    assert.equal(kit.read('a.py'), 'mine, created meanwhile');
    assert.equal(kit.session.callsOf('fs.get').length, 1, 'no second download');
  });

  it('never overwrites a file that appears DURING the download either (exclusive create): untouched, no leftovers', async () => {
    setup({ board: { '/a.py': 'board' } });
    mock.answerMessage(/only on the board/, COPY_BUTTON);
    let seen = 0;
    kit.session.script('fs.get', (_args, ctx) => {
      if (++seen === 2) { kit.write('a.py', 'mine, created during the download'); } // the 1st call is the read-only document
      return ctx.fallthrough() as never;
    });
    await click('/a.py');
    await until('the calm message', () => offers(/in your project folder already/).length === 1);
    assert.equal(kit.read('a.py'), 'mine, created during the download');
    assert.deepEqual(fs.readdirSync(kit.workspace), ['a.py'], 'no temporary or partial file next to it');
    assert.equal(mock.activeEditor?.document.uri.scheme, BOARD_SCHEME, 'the board copy stays; nothing replaced it');
  });

  it('a failed download says what happened and what to do, and leaves the project exactly as it was (no folders either)', async () => {
    setup({ board: { '/lib/deep/b.py': 'x' } });
    mock.answerMessage(/only on the board/, COPY_BUTTON);
    let seen = 0;
    kit.session.script('fs.get', (_args, ctx) => {
      if (++seen === 2) { throw BoardError.of('E_CALL_TIMEOUT', 'The board did not answer in time.', { hint: 'Check the cable and try again.' }, 'fs.get'); }
      return ctx.fallthrough() as never;
    });
    await click('/lib/deep/b.py');
    await until('the error message', () => mock.messages('error').length === 1);
    const text = mock.messages('error')[0]?.message ?? '';
    assert.match(text, /^Copying b\.py to your project did not work\./);
    assert.match(text, /Check the cable and try again/);
    assert.deepEqual(fs.readdirSync(kit.workspace), [], 'no file, no empty folder');
    assert.match(kit.channel.text, /Copying b\.py to your project failed/);
  });

  it('a project folder that cannot be written leaves no half-written file and says why', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    setup({ board: { '/ro/c.py': 'x' } });
    fs.mkdirSync(local('ro'));
    fs.chmodSync(local('ro'), 0o500);
    try {
      mock.answerMessage(/only on the board/, COPY_BUTTON);
      await click('/ro/c.py');
      await until('the error message', () => mock.messages('error').length === 1);
      assert.match(mock.messages('error')[0]?.message ?? '', /Copying c\.py to your project did not work/);
      assert.deepEqual(fs.readdirSync(local('ro')), []);
    } finally {
      fs.chmodSync(local('ro'), 0o700);
    }
  });

  it('without a workspace folder it says "Open your project folder first" and offers no copy', async () => {
    setup({ board: { '/a.py': '1' } });
    mock.setWorkspaceFolders();
    await click('/a.py');
    assert.equal(activeUri(), boardDocumentUri('/a.py').toString());
    const hint = offers(/Open your project folder first/);
    assert.equal(hint.length, 1);
    assert.deepEqual(hint[0]?.items, []);
    assert.equal(offers(/only on the board/).length, 0);
  });

  it('a file outside the board folder that the project mirrors opens read-only and explains, without an offer', async () => {
    setup({ rootPath: '/app', local: { 'x.py': 'mine' }, board: { '/x.py': 'board root file' } });
    await click('/x.py');
    assert.equal(activeUri(), boardDocumentUri('/x.py').toString(), 'the project\'s x.py is NOT the counterpart of /x.py');
    const hint = offers(/no place in your project folder/);
    assert.equal(hint.length, 1);
    assert.deepEqual(hint[0]?.items, []);
    assert.equal(kit.read('x.py'), 'mine');
  });

  it('a binary file cannot be shown, so there is no half-offer', async () => {
    setup({});
    kit.session.boardFs?.write('/data.bin', new Uint8Array([0xff, 0xfe, 0x80, 0x00]));
    await click('/data.bin');
    assert.match(mock.messages('error').map((m) => m.message).join('\n'), /is not a text file, so it cannot be shown/);
    assert.equal(offers(/only on the board/).length, 0);
  });
});

describe('Run from a board document', () => {
  it('with a project file: runs THAT file (saved first), shows it, and no warning appears', async () => {
    setup({ local: { 'test.py': 'print(1)\n' }, board: { '/test.py': 'print(1)\n' } });
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/test.py'));
    assert.equal(mock.activeEditor?.document.uri.scheme, BOARD_SCHEME);
    const mine = await mock.openDocument(vscode.Uri.file(local('test.py')));
    mine.setText('print(2)\n'); // unsaved edit in the project file
    await pressRun();
    assert.equal(runCalls().length, 1);
    assert.deepEqual(runCalls()[0], { local: local('test.py'), name: local('test.py'), reset: true });
    assert.equal(kit.read('test.py'), 'print(2)\n', 'the normal save path applied to the project file');
    assert.equal(mock.activeEditor?.document.uri.fsPath, local('test.py'), 'the project file is shown');
    assert.equal(mock.messages('warn').length, 0);
    assert.match(mock.terminals[0]?.output ?? '', /\[running test\.py\]/);
  });

  it('works when the board document comes as the menu argument', async () => {
    setup({ local: { 'lib/m.py': 'x' }, board: { '/lib/m.py': 'x' } });
    await pressRun(boardDocumentUri('/lib/m.py'));
    assert.equal(runCalls()[0]?.local, local('lib/m.py'));
    assert.equal(kit.session.callsOf('fs.get').length, 0, 'the board document was never downloaded just to be refused');
  });

  it('without a project file: nothing runs, the offer appears at once (Run does not wait for it), nothing is written', async () => {
    setup({ board: { '/test.py': 'print(1)\n' } });
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/test.py'));
    await withPendingToasts(async () => {
      await finishesWithin(2000, 'Run', pressRun());
    });
    assert.equal(runCalls().length, 0);
    const offer = offers(/only on the board/);
    assert.equal(offer.length, 1);
    assert.equal(offer[0]?.message, 'test.py is only on the board, not in your project folder.');
    assert.deepEqual(offer[0]?.items, [COPY_AND_RUN_BUTTON]);
    assert.deepEqual(fs.readdirSync(kit.workspace), []);
    assert.equal(mock.messages('warn').length, 0, 'no "not a file on this computer" warning');
  });

  it('"Copy it to my project and run it": copies, shows the new file, then runs it', async () => {
    setup({ board: { '/test.py': 'print(1)\n' } });
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/test.py'));
    mock.answerMessage(/only on the board/, COPY_AND_RUN_BUTTON);
    await pressRun();
    await until('the run', () => runCalls().length === 1);
    assert.equal(kit.read('test.py'), 'print(1)\n');
    assert.deepEqual(runCalls()[0], { local: local('test.py'), name: local('test.py'), reset: true });
    assert.equal(mock.activeEditor?.document.uri.fsPath, local('test.py'));
    await until('the footer', () => /\[program finished\]/.test(mock.terminals[0]?.output ?? ''));
  });

  it('cancelling the offer runs nothing and copies nothing', async () => {
    setup({ board: { '/test.py': 'print(1)\n' } });
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/test.py'));
    mock.answerMessage(/only on the board/, undefined);
    await pressRun();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(runCalls().length, 0);
    assert.deepEqual(fs.readdirSync(kit.workspace), []);
  });

  it('a copy that finds a file in the way runs nothing (the calm message appears instead)', async () => {
    setup({ board: { '/test.py': 'print(1)\n' } });
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/test.py'));
    mock.answerMessage(/only on the board/, () => { kit.write('test.py', 'print("mine")'); return COPY_AND_RUN_BUTTON; });
    await pressRun();
    await until('the calm message', () => offers(/in your project folder already/).length === 1);
    assert.equal(runCalls().length, 0);
    assert.equal(kit.read('test.py'), 'print("mine")');
  });

  it('a board document that is not Python is refused like any other non-Python file, without an offer', async () => {
    setup({ board: { '/data/notes.txt': 'hello' } });
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/data/notes.txt'));
    await pressRun();
    assert.match(mock.messages('warn').at(-1)?.message ?? '', /notes\.txt is not a Python file/);
    assert.equal(offers(/only on the board/).length, 0);
    assert.equal(runCalls().length, 0);
  });

  it('without a workspace folder it says "Open your project folder first"', async () => {
    setup({ board: { '/test.py': 'print(1)\n' } });
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/test.py'));
    mock.setWorkspaceFolders();
    await pressRun();
    assert.match(mock.messages('warn').at(-1)?.message ?? '', /^test\.py is only on the board\. Open your project folder first/);
    assert.equal(runCalls().length, 0);
  });

  it('keeps the original explanation for documents that are not files and not board documents', async () => {
    setup({});
    mock.track(vscode.workspace.registerTextDocumentContentProvider('other', { provideTextDocumentContent: () => 'print(1)' }));
    await mock.openEditor(vscode.Uri.parse('other:/a.py'));
    await pressRun();
    assert.match(mock.messages('warn').at(-1)?.message ?? '', /a\.py is not a file on this computer, so it cannot be run\. Open a \.py file from your project folder\./);
    assert.equal(runCalls().length, 0);
  });

  it('Run without board-file support still refuses a board document with the explanation (no silent redirect, no crash)', async () => {
    setup({ local: { 'test.py': 'print(1)\n' }, board: { '/test.py': 'print(1)\n' } }, false);
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/test.py'));
    await pressRun();
    assert.match(mock.messages('warn').at(-1)?.message ?? '', /test\.py is not a file on this computer/);
    assert.equal(runCalls().length, 0);
  });

  it('the Run row of Board Actions names the file for a board document instead of asking for a Python file', async () => {
    setup({ board: { '/test.py': 'print(1)\n' } });
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/test.py'));
    assert.equal(activeFileLabel(mock.activeEditor as unknown as vscode.TextEditor), 'test.py');
  });
});

describe('Upload Current File from a board document', () => {
  it('uploads the project file with the same name', async () => {
    setup({ local: { 'lib/x.py': 'new local text' }, board: { '/lib/x.py': 'old board text' } });
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/lib/x.py'));
    // D-21: the board copy differs and was never synced from here: replaced only on a clear yes (and backed up first)
    mock.answerMessage(/Replace it with your version\?/, 'Replace it (back up the board copy first)', { once: true });
    await kit.sync.uploadFile(undefined);
    assert.equal(kit.session.boardFs?.read('/lib/x.py'), 'new local text');
    // first the guarded attempt (refused: the board copy differs), then the confirmed one; both send the project file
    assert.deepEqual(kit.session.argsOf('fs.put').map((a) => a.local), [local('lib/x.py'), local('lib/x.py')]);
    assert.deepEqual(kit.session.argsOf('fs.put').map((a) => a.ifSha), ['absent', undefined]);
  });

  it('keeps a calm explanation when the project has no such file', async () => {
    setup({ board: { '/x.py': 'board text' } });
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/x.py'));
    await kit.sync.uploadFile(undefined);
    assert.equal(kit.session.callsOf('fs.put').length, 0);
    assert.match(mock.messages('info').at(-1)?.message ?? '', /This is the board's own copy of x\.py, and your project folder does not have that file, so there is nothing to upload\. Click the file in the Files view and choose "Copy it to my project" first\./);
  });
});

describe('the tooltip of a file says what a click does', () => {
  function tree(badges: Record<string, 'in-sync' | 'board-only' | 'conflict'>): FilesTree {
    const session = FakeSession.connected();
    const { log } = createTestLogger();
    const t = new FilesTree({ session, log, settings: new Settings(), extensionUri: vscode.Uri.file('/ext'), syncStatus: { badgeFor: (p) => badges[p] } });
    mock.track(t);
    return t;
  }
  const node = (devicePath: string): BoardNode => file(devicePath);
  const tip = (t: FilesTree, devicePath: string): string => String((t.getTreeItem(node(devicePath)) as vscode.TreeItem).tooltip);

  it('a file that is in the project: "Open your copy in the project"; board-only: "Only on the board: opens a read-only copy"; unknown: both', () => {
    const t = tree({ '/a.py': 'in-sync', '/b.py': 'board-only', '/c.py': 'conflict' });
    assert.match(tip(t, '/a.py'), /Click: Open your copy in the project\./);
    assert.match(tip(t, '/c.py'), /Click: Open your copy in the project\./);
    assert.match(tip(t, '/b.py'), /Click: Only on the board: opens a read-only copy\. A message then offers to copy it into your project\./);
    assert.match(tip(t, '/d.py'), /Click: Opens your copy in the project; a file that is only on the board opens as a read-only copy\./);
    for (const p of ['/a.py', '/b.py', '/d.py']) { assert.match(tip(t, p), /Open the Board's Copy \(Read-Only\)/); }
    assert.equal(FILES_TEXT.fileTooltip('/z.py', '1 B').includes('/z.py'), true);
  });

  it('is worded again when a badge changes it: a file that was just copied stops saying "only on the board"', () => {
    const status = new SyncStatus();
    status.set('/a.py', 'board-only');
    const session = FakeSession.connected();
    const { log } = createTestLogger();
    const t = new FilesTree({ session, log, settings: new Settings(), extensionUri: vscode.Uri.file('/ext'), syncStatus: status });
    mock.track(t);
    const changed: unknown[] = [];
    t.onDidChangeTreeData((e) => { changed.push(e); });
    const n = node('/a.py');
    assert.match(tipText((t.getTreeItem(n) as vscode.TreeItem).tooltip), /Only on the board/);
    status.set('/a.py', 'in-sync');
    assert.deepEqual(changed, [n], 'VS Code is told to ask for this item again');
    const item = t.getTreeItem(n) as vscode.TreeItem;
    assert.match(tipText(item.tooltip), /opens? your copy in the project/i);
    assert.doesNotMatch(tipText(item.tooltip), /Only on the board/);
  });
});
