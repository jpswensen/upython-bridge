/**
 * Independent adversarial review of "click a board file, then Run" (review10:open-run). Adds cases the builder's
 * test/unit/openrun.test.ts does not have: path edge cases, copy races, a link that dies half way, the connection gone while a
 * toast is open, multi-root, awkward names, a toast left unanswered while other sync commands run. Mock vscode + FakeSession only:
 * no serial port, no VS Code launch.
 *
 *   npm test -- open-run-review
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { BoardCopy, COPY_AND_RUN_BUTTON, COPY_BUTTON } from '../../../src/commands/boardCopy';
import { boardDocumentUri, registerBoardFileCommands } from '../../../src/commands/boardFiles';
import { registerRun, type RunDeps } from '../../../src/commands/run';
import { COMMAND_IDS, MENUS } from '../../../src/contributes';
import { ReplTerminal } from '../../../src/repl/terminal';
import { boardKeyOf } from '../../../src/sync/baseline';
import { PathMapper } from '../../../src/sync/paths';
import { SyncService } from '../../../src/sync/service';
import { BoardError } from '../../../src/types/session';
import type { BoardNode } from '../../../src/types/sync';
import { FAKE_IDENTITY, FakeSession } from '../../mocks/fakeSession';
import { mock } from '../../mocks/vscode';
import { makeKit, type Kit } from '../sync/kit';

let kit: Kit;
let terminal: ReplTerminal;
beforeEach(() => mock.reset());
afterEach(() => {
  terminal?.dispose();
  kit?.dispose();
});

interface Wired { sync: SyncService; copy: BoardCopy }

function setup(opts: Parameters<typeof makeKit>[0], sync?: (k: Kit) => SyncService): Wired {
  kit = makeKit({ tricky: true, ...opts });
  const s = sync ? sync(kit) : kit.sync;
  terminal = new ReplTerminal(kit.services);
  const copy = new BoardCopy(kit.services, s);
  const boardFiles: RunDeps['boardFiles'] = { localCounterpart: (p) => s.localCounterpart(p), copy };
  for (const d of registerBoardFileCommands(kit.services, { sync: s, copy })) { mock.track(d); }
  for (const d of registerRun(kit.services, { terminal, syncGate: s, boardFiles })) { mock.track(d); }
  return { sync: s, copy };
}

const file = (devicePath: string): BoardNode => ({ devicePath, kind: 'file', name: devicePath.split('/').pop() ?? '', size: 1 });
const dir = (devicePath: string): BoardNode => ({ devicePath, kind: 'dir', name: devicePath.split('/').pop() ?? '' });
const click = (devicePath: string): Thenable<unknown> => vscode.commands.executeCommand(COMMAND_IDS.openFileFromBoard, file(devicePath));
const asBoardDoc = (devicePath: string): Thenable<unknown> => vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file(devicePath));
const pressRun = (arg?: unknown): Thenable<unknown> => vscode.commands.executeCommand(COMMAND_IDS.runActiveFile, ...(arg === undefined ? [] : [arg]));
const runCalls = (): { local: string; name?: string }[] => kit.session.argsOf('run') as unknown as { local: string; name?: string }[];
const local = (rel: string): string => path.join(kit.workspace, ...rel.split('/'));
const offers = (text: RegExp): ReturnType<typeof mock.messages> => mock.messages().filter((m) => text.test(m.message));
const activeUri = (): string => mock.activeEditor?.document.uri.toString() ?? '(no editor)';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(10);
  }
}

async function withPendingToasts<T>(work: () => Promise<T>): Promise<T> {
  const w = vscode.window as unknown as Record<string, unknown>;
  const original = w.showInformationMessage;
  w.showInformationMessage = (message: string, ...rest: unknown[]) => { mock.showMessage('info', message, rest); return new Promise<never>(() => undefined); };
  try { return await work(); } finally { w.showInformationMessage = original; }
}

async function finishesWithin<T>(ms: number, what: string, work: Thenable<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); });
  try { return await Promise.race([Promise.resolve(work), limit]); } finally { clearTimeout(timer); }
}

/** Everything under `root`, relative, sorted (files and folders). */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(root, p));
      if (e.isDirectory()) { walk(p); }
    }
  };
  walk(root);
  return out.sort();
}

describe('review10: click on a synced file whose project copy differs from the board', () => {
  it('opens the project file; neither side is changed; Run then runs the project file (never the board text)', async () => {
    setup({ local: { 'test.py': 'LOCAL\n' }, board: { '/test.py': 'BOARD\n' } });
    await click('/test.py');
    assert.equal(mock.activeEditor?.document.uri.fsPath, local('test.py'));
    assert.equal(mock.activeEditor?.document.getText(), 'LOCAL\n');
    await pressRun();
    assert.equal(runCalls().length, 1);
    assert.equal(runCalls()[0]?.local, local('test.py'));
    assert.equal(kit.read('test.py'), 'LOCAL\n');
    assert.equal(kit.session.boardFs?.read('/test.py'), 'BOARD\n', 'the board was not changed by click + Run');
    assert.equal(kit.session.callsOf('fs.put').length, 0);
  });

  it('board document opened long ago, board file changed since: Run runs the local file, the stale board text is never used', async () => {
    setup({ local: { 'test.py': 'LOCAL\n' }, board: { '/test.py': 'OLD BOARD\n' } });
    await asBoardDoc('/test.py');
    kit.session.boardFs?.write('/test.py', new TextEncoder().encode('NEW BOARD\n'));
    await pressRun();
    assert.equal(runCalls().length, 1);
    assert.equal(runCalls()[0]?.local, local('test.py'));
    assert.equal(mock.activeEditor?.document.uri.scheme, 'file');
  });

  it('Run when the project copy is dirty (unsaved): saved once on disk and run exactly once', async () => {
    setup({ local: { 'test.py': 'print(1)\n' }, board: { '/test.py': 'print(1)\n' } });
    await asBoardDoc('/test.py');
    const mine = await mock.openDocument(vscode.Uri.file(local('test.py')));
    mine.setText('print(99)\n');
    assert.equal(mine.isDirty, true);
    await pressRun();
    assert.equal(runCalls().length, 1);
    assert.equal(kit.read('test.py'), 'print(99)\n');
    assert.equal(mine.isDirty, false);
  });
});

describe('review10: board paths that cannot map into the project', () => {
  it('"..", ".", empty segments and a path outside the root: read-only document plus a calm explanation, nothing written anywhere', async () => {
    setup({ board: { '/lib/ok.py': 'x' } });
    const parent = path.dirname(kit.workspace);
    const before = tree(parent);
    for (const p of ['/lib/../../outside.py', '/lib/./a.py', '/lib//a.py', '/../x.py']) {
      mock.calls.messages.length = 0;
      kit.session.boardFs?.write(p, new TextEncoder().encode('x'));
      await click(p);
      assert.equal(offers(/only on the board/).length, 0, `no copy offer for ${p}`);
      assert.deepEqual(tree(parent), before, `nothing written for ${p}`);
    }
  });

  it('a symlinked folder in the project that points outside: no copy offer, nothing written outside, the board document opens to read (F1)', async () => {
    const { copy } = setup({ board: { '/link/new.py': 'print("hi")\n' } });
    const outside = fs.mkdtempSync(path.join(path.dirname(kit.workspace), 'outside-'));
    fs.symlinkSync(outside, local('link'));
    try {
      mock.answerMessage(/only on the board/, COPY_BUTTON);
      await click('/link/new.py');
      await sleep(200);
      assert.equal(fs.existsSync(path.join(outside, 'new.py')), false, 'a copy must not write outside the project folder through a symlink');
      assert.equal(offers(/only on the board/).length, 0, 'no copy offer');
      assert.equal(offers(/link is a shortcut \(symbolic link\)/).length, 1, 'one calm explanation');
      assert.equal(activeUri(), boardDocumentUri('/link/new.py').toString(), 'opens read-only');
      assert.equal(await copy.copy('/link/new.py'), undefined, 'the copy command refuses as well');
      assert.equal(fs.existsSync(path.join(outside, 'new.py')), false);
      assert.equal(kit.session.callsOf('fs.get').length, 1, 'only the read-only document was downloaded, nothing for a copy');
      await pressRun();
      assert.equal(runCalls().length, 0, 'Run on that board document runs nothing');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a symlinked FILE that points outside the project: the click does not open the outside file, Run runs nothing (F1)', async () => {
    setup({ board: { '/s.py': 'x' } });
    const outside = fs.mkdtempSync(path.join(path.dirname(kit.workspace), 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.py'), 'SECRET');
    fs.symlinkSync(path.join(outside, 'secret.py'), local('s.py'));
    try {
      await click('/s.py');
      assert.equal(activeUri(), boardDocumentUri('/s.py').toString());
      assert.notEqual(mock.activeEditor?.document.getText(), 'SECRET', 'opened a file outside the project through a symlink');
      assert.equal(offers(/s\.py is a shortcut \(symbolic link\)/).length, 1);
      await pressRun();
      assert.equal(runCalls().length, 0);
      assert.equal(fs.readFileSync(path.join(outside, 'secret.py'), 'utf8'), 'SECRET');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a link AT the project folder (an alias of the project) is still followed: click and Run use the file inside it', async () => {
    setup({ local: { 'a.py': 'print(1)\n' }, board: { '/a.py': 'print(1)\n' } });
    const alias = path.join(path.dirname(kit.workspace), 'alias-of-project');
    fs.symlinkSync(kit.workspace, alias);
    try {
      mock.setWorkspaceFolders(alias);
      await click('/a.py');
      assert.equal(mock.activeEditor?.document.uri.fsPath, path.join(alias, 'a.py'));
      await pressRun();
      assert.equal(runCalls().length, 1);
    } finally {
      fs.rmSync(alias, { force: true });
    }
  });

  it('Windows rules (win32 path flavour): reserved names, ":" and trailing dots refuse calmly in click, copy and Run; nothing is created', async () => {
    const names = ['/lib/aux.py', '/lib/CON.txt', '/C:/x.py', '/lib/a:b.py', '/lib/dots.py.', '/lib/q?.py'];
    setup({ board: Object.fromEntries(names.map((n) => [n, 'x'])) }, (k) => new SyncService(k.services, { scheduler: k.scheduler, flavor: path.win32 }));
    const before = tree(kit.workspace);
    for (const n of names) {
      mock.calls.messages.length = 0;
      await click(n);
      assert.equal(activeUri(), boardDocumentUri(n).toString(), `${n} opens read-only`);
      const hint = offers(/no place in your project folder/);
      assert.equal(hint.length, 1, `${n}: one calm explanation, got ${JSON.stringify(mock.messages().map((m) => m.message))}`);
      assert.deepEqual(hint[0]?.items, [], `${n}: no copy button`);
      assert.equal(mock.messages('error').length, 0);
    }
    await pressRun();
    assert.equal(runCalls().length, 0);
    assert.deepEqual(tree(kit.workspace), before);
  });

  it('PathMapper (win32) rejects the same names with a sentence that says what to do', () => {
    const m = new PathMapper('C:\\Users\\Student\\Lab 1', '/', path.win32);
    for (const dev of ['/aux.py', '/lib/nul', '/C:/x.py', '/a<b.py']) {
      const rel = m.deviceToRel(dev);
      assert.ok(rel !== undefined);
      assert.throws(() => m.relToLocal(rel), (e: Error) => /Rename it on the board/.test(e.message));
    }
  });
});

describe('review10: the project path exists but is not a file', () => {
  it('a FOLDER where the file should be: nothing is overwritten, nothing is downloaded, and it says it is a folder (F3)', async () => {
    setup({ board: { '/foo.py': 'print(1)\n' } });
    fs.mkdirSync(local('foo.py'));
    fs.writeFileSync(path.join(local('foo.py'), 'inner.txt'), 'keep');
    mock.answerMessage(/only on the board/, COPY_BUTTON);
    await click('/foo.py');
    await until('the answer', () => offers(/is a folder in your project/).length > 0);
    assert.ok(fs.statSync(local('foo.py')).isDirectory(), 'the folder is still a folder');
    assert.equal(fs.readFileSync(path.join(local('foo.py'), 'inner.txt'), 'utf8'), 'keep');
    assert.equal(mock.messages('error').length, 0, 'no raw error');
    assert.match(offers(/is a folder in your project/)[0]?.message ?? '', /^foo\.py is a folder in your project, but the board has a file with that name\. Rename or move the folder, then try again\.$/);
    assert.doesNotMatch(mock.messages().map((m) => m.message).join('\n'), /is in your project folder already/);
    assert.equal(kit.session.callsOf('fs.get').length, 1, 'only the read-only document was downloaded, not a second time for the copy');
  });

  it('"Copy it to my project and run it" with a FOLDER in the way: says so, runs nothing (F3)', async () => {
    setup({ board: { '/foo.py': 'print(1)\n' } });
    fs.mkdirSync(local('foo.py'));
    await asBoardDoc('/foo.py');
    mock.answerMessage(/only on the board/, COPY_AND_RUN_BUTTON);
    await pressRun();
    await until('the answer', () => offers(/is a folder in your project/).length > 0);
    await sleep(100);
    assert.equal(runCalls().length, 0);
    assert.ok(fs.statSync(local('foo.py')).isDirectory());
  });

  it('a FILE where a parent folder should be: calm English naming the file, no raw errno text, nothing created or downloaded (F2)', async () => {
    setup({ board: { '/lib/x.py': 'print(1)\n' }, local: { lib: 'I am a file' } });
    mock.answerMessage(/only on the board/, COPY_BUTTON);
    await click('/lib/x.py');
    await until('a result', () => offers(/is a file in your project/).length > 0);
    const text = mock.messages().map((m) => `${m.level}: ${m.message}`).join('\n');
    assert.equal(fs.readFileSync(local('lib'), 'utf8'), 'I am a file');
    assert.doesNotMatch(text, /EEXIST|ENOTDIR|mkdir '/, 'raw system error shown to a student');
    assert.match(offers(/is a file in your project/)[0]?.message ?? '', /^lib is a file in your project, but x\.py needs lib to be a folder\. Rename or move lib, then try again\.$/);
    assert.equal(mock.messages('error').length, 0);
    assert.equal(kit.session.callsOf('fs.get').length, 1, 'only the read-only document was downloaded');
  });

  it('a FILE in the middle of a deeper path names the right component (F2)', async () => {
    const { copy } = setup({ board: { '/a/b/c.py': 'print(1)\n' }, local: { 'a/b': 'file b' } });
    assert.equal(await copy.copy('/a/b/c.py'), undefined);
    assert.match(offers(/is a file in your project/)[0]?.message ?? '', /^a\/b is a file in your project, but c\.py needs a\/b to be a folder\./);
    assert.deepEqual(tree(kit.workspace), ['a', 'a/b']);
  });

  it('a folder or file that appears WHILE the download runs is met by the same calm sentences (race)', async () => {
    const { copy } = setup({ board: { '/lib/x.py': 'print(1)\n', '/foo.py': 'print(2)\n' } });
    const late = (what: () => void): void => {
      kit.session.script('fs.get', async (_args, ctx) => { const r = await ctx.fallthrough(); what(); return r as never; });
    };
    late(() => fs.writeFileSync(local('lib'), 'late file'));
    assert.equal(await copy.copy('/lib/x.py'), undefined);
    assert.match(offers(/is a file in your project/)[0]?.message ?? '', /^lib is a file in your project, but x\.py needs lib to be a folder/);
    late(() => fs.mkdirSync(local('foo.py')));
    assert.equal(await copy.copy('/foo.py'), undefined);
    assert.match(offers(/is a folder in your project/)[0]?.message ?? '', /^foo\.py is a folder in your project/);
    assert.equal(fs.readFileSync(local('lib'), 'utf8'), 'late file');
    assert.deepEqual(mock.messages('error'), []);
    assert.deepEqual(tree(kit.workspace), ['foo.py', 'lib']);
  });
});

describe('review10: copy to the project under stress', () => {
  it('two quick answers (double click on the file, both offers accepted): one project file, intact, in sync, no error, no leftovers', async (t) => {
    setup({ board: { '/a.py': 'print(5)\n' } });
    mock.answerMessage(/only on the board/, COPY_BUTTON);
    await Promise.all([click('/a.py'), click('/a.py')]);
    await sleep(400);
    t.diagnostic(`fs.get calls: ${kit.session.callsOf('fs.get').length}; messages: ${JSON.stringify(mock.messages().map((m) => `${m.level}: ${m.message}`))}`);
    assert.equal(kit.read('a.py'), 'print(5)\n');
    assert.deepEqual(mock.messages('error').map((m) => m.message), [], 'no error toast');
    assert.deepEqual(tree(kit.workspace), ['a.py']);
    const scratch = path.join(kit.ctx.storageUri.fsPath, 'board-files');
    assert.deepEqual(fs.existsSync(scratch) ? fs.readdirSync(scratch) : [], []);
    const ctx = await kit.sync.folderContext();
    const baseline = (await ctx?.store.load(boardKeyOf(FAKE_IDENTITY)))?.files ?? {};
    assert.equal(baseline['a.py']?.sha256, kit.session.boardFs?.fileHash('/a.py'));
  });

  it('two copy() calls at the same time: the project file is never empty or partial, no error toast', async (t) => {
    const { copy } = setup({ board: { '/a.py': 'print(5)\n'.repeat(2000) } });
    const results = await Promise.all([copy.copy('/a.py'), copy.copy('/a.py')]);
    await sleep(100);
    t.diagnostic(`results: ${JSON.stringify(results)}; fs.get: ${kit.session.callsOf('fs.get').length}; messages: ${JSON.stringify(mock.messages().map((m) => `${m.level}: ${m.message}`))}`);
    assert.equal(kit.read('a.py'), 'print(5)\n'.repeat(2000));
    assert.deepEqual(mock.messages('error').map((m) => m.message), []);
  });

  it('the link dies half way (partial bytes written, then the bridge fails): no project file, no folders, no scratch leftovers, one clear message', async () => {
    setup({ board: { '/lib/deep/b.py': 'x'.repeat(5000) } });
    mock.answerMessage(/only on the board/, COPY_BUTTON);
    let seen = 0;
    kit.session.script('fs.get', (args, ctx) => {
      if (++seen === 2) {
        fs.mkdirSync(path.dirname(args.local), { recursive: true });
        fs.writeFileSync(args.local, 'xxx'); // the partial download
        throw BoardError.of('E_BRIDGE_EXITED', 'The connection to the board was lost.', { hint: 'Plug the board in again and try again.' }, 'fs.get');
      }
      return ctx.fallthrough() as never;
    });
    await click('/lib/deep/b.py');
    await until('the error', () => mock.messages('error').length === 1);
    assert.deepEqual(tree(kit.workspace), [], 'project untouched');
    const scratch = path.join(kit.ctx.storageUri.fsPath, 'board-files');
    assert.deepEqual(fs.existsSync(scratch) ? fs.readdirSync(scratch) : [], [], 'scratch removed');
    assert.match(mock.messages('error')[0]?.message ?? '', /Plug the board in again/);
  });

  it('copy-and-run: when the copy fails nothing runs', async () => {
    setup({ board: { '/test.py': 'print(1)\n' } });
    await asBoardDoc('/test.py');
    mock.answerMessage(/only on the board/, COPY_AND_RUN_BUTTON);
    kit.session.script('fs.get', () => { throw BoardError.of('E_BRIDGE_EXITED', 'The connection to the board was lost.', {}, 'fs.get'); });
    await pressRun();
    await until('the error', () => mock.messages('error').length === 1);
    await sleep(50);
    assert.equal(runCalls().length, 0);
    assert.deepEqual(tree(kit.workspace), []);
  });

  it('the connection is gone when the offer is answered and the student declines to reconnect: nothing is created, nothing runs, no raw error', async () => {
    setup({ board: { '/test.py': 'print(1)\n' }, selectPortStub: false });
    mock.track(vscode.commands.registerCommand(COMMAND_IDS.selectPort, () => false));
    mock.track(vscode.commands.registerCommand(COMMAND_IDS.refresh, () => undefined));
    await asBoardDoc('/test.py');
    mock.answerMessage(/only on the board/, () => { kit.session.setState({ state: 'disconnected', port: null }); return COPY_AND_RUN_BUTTON; });
    await pressRun();
    await sleep(150);
    assert.equal(runCalls().length, 0);
    assert.deepEqual(tree(kit.workspace), []);
    assert.equal(mock.messages('error').length, 0);
  });

  it('clicking a board-only file while disconnected (and the port question declined) opens nothing and shows no offer', async () => {
    setup({ session: FakeSession.connected({ state: 'disconnected', port: null }), board: { '/a.py': 'x' }, selectPortStub: false });
    mock.track(vscode.commands.registerCommand(COMMAND_IDS.selectPort, () => false));
    await click('/a.py');
    assert.equal(offers(/only on the board/).length, 0);
    assert.equal(mock.messages('error').length, 0);
    assert.deepEqual(tree(kit.workspace), []);
  });
});

describe('review10: toasts never hold anything up', () => {
  it('an unanswered offer, then Upload All and Upload Current File and another click: all finish', async () => {
    setup({ local: { 'mine.py': 'print(2)\n' }, board: { '/only.py': 'print(1)\n' } });
    await withPendingToasts(async () => {
      await finishesWithin(2000, 'the click', click('/only.py'));
      assert.equal(offers(/only on the board/).length, 1);
      mock.answerQuickPick((items) => items as never);
      await finishesWithin(4000, 'Upload All', kit.sync.uploadAll());
      assert.equal(kit.session.boardFs?.read('/mine.py'), 'print(2)\n', 'Upload All really uploaded while the offer was open');
      await finishesWithin(4000, 'Upload Current File', kit.sync.uploadFile(vscode.Uri.file(local('mine.py'))));
      await finishesWithin(2000, 'a second click', click('/only.py'));
      await finishesWithin(2000, 'Run on the board document', pressRun());
      await finishesWithin(2000, 'the explicit read-only command', asBoardDoc('/only.py'));
    });
    assert.deepEqual(fs.readdirSync(kit.workspace).sort(), ['mine.py']);
  });
});

describe('review10: unusual arguments and menus', () => {
  it('the click with no argument, a directory node, a Uri, a string, null or a malformed node never throws and never changes the project', async () => {
    setup({ board: { '/lib/x.py': 'x' } });
    const before = tree(kit.workspace);
    const bad: unknown[] = [undefined, null, 'x', 42, vscode.Uri.file('/tmp/a.py'), { devicePath: 'relative.py', kind: 'file' }, { devicePath: '/x.py' }, {}];
    for (const arg of bad) {
      mock.calls.messages.length = 0;
      await vscode.commands.executeCommand(COMMAND_IDS.openFileFromBoard, ...(arg === undefined ? [] : [arg]));
      assert.equal(mock.messages('error').length, 0, `no error for ${JSON.stringify(arg)}`);
      assert.match(mock.messages('info')[0]?.message ?? '', /Right-click a file or folder in the Files view/);
    }
    mock.calls.messages.length = 0;
    const calls = kit.session.calls.length;
    await vscode.commands.executeCommand(COMMAND_IDS.openFileFromBoard, dir('/lib'));
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, dir('/lib'));
    assert.equal(mock.calls.messages.length, 0, 'a folder node: nothing to say');
    assert.equal(kit.session.calls.length, calls, 'a folder node: no board traffic');
    assert.deepEqual(tree(kit.workspace), before);
  });

  it('the read-only context-menu entry is for files only, in the Files view, and hidden from the palette', () => {
    setup({});
    const entry = MENUS.filter((m) => m.command === 'openBoardCopy');
    assert.equal(entry.length, 1);
    assert.equal(entry[0]?.menu, 'view/item/context');
    assert.match(entry[0]?.when ?? '', /view == [\w.-]*[Ff]iles/i);
    assert.match(entry[0]?.when ?? '', /viewItem == file$/);
    assert.doesNotMatch(entry[0]?.when ?? '', /viewItem == dir|viewItem =~/);
  });
});

describe('review10: awkward names, folders, root path, multi-root', () => {
  const names = ['/lib/Lab 1 – café (v2).py', '/lib/100%.py', '/lib/a#b.py', '/lib/sp ace/ü ñ.py', '/lib/日本語.py'];

  it('synced files with spaces, parentheses, "%", "#" and non-ASCII open the project file and Run runs it', async () => {
    const files = Object.fromEntries(names.map((n) => [n.slice(1), `# ${n}\n`]));
    setup({ local: files, board: Object.fromEntries(names.map((n) => [n, `# ${n}\n`])) });
    for (const n of names) {
      mock.calls.showTextDocument.length = 0;
      await click(n);
      assert.equal(mock.activeEditor?.document.uri.fsPath, local(n.slice(1)), `click ${n}`);
      await asBoardDoc(n);
      assert.equal(mock.activeEditor?.document.uri.scheme, 'upy-bridge-board');
      assert.equal(mock.activeEditor?.document.uri.path, n, 'the device path survives the Uri round trip');
      await pressRun();
      assert.equal(runCalls().at(-1)?.local, local(n.slice(1)), `Run ${n}`);
      assert.equal(mock.messages('warn').length, 0);
    }
    assert.equal(runCalls().length, names.length);
  });

  it('board-only files with the same awkward names copy to exactly that name and the copy is byte for byte the board file', async () => {
    setup({ board: Object.fromEntries(names.map((n) => [n, `# ${n}\n`])) });
    mock.answerMessage(/only on the board/, COPY_BUTTON);
    for (const n of names) { await click(n); }
    // The file exists (empty) a moment before its bytes are written: wait for the whole content, not for the name.
    await until('all copies', () => names.every((n) => kit.read(n.slice(1)) === `# ${n}\n`), 4000);
    for (const n of names) { assert.equal(kit.read(n.slice(1)), `# ${n}\n`); }
    assert.deepEqual(mock.messages('error').map((m) => m.message), []);
  });

  it('a file under a folder (/lib/util.py) opens /lib/util.py of the project; Run works from the board document', async () => {
    setup({ local: { 'lib/util.py': 'u = 1\n' }, board: { '/lib/util.py': 'u = 1\n' } });
    await click('/lib/util.py');
    assert.equal(mock.activeEditor?.document.uri.fsPath, local('lib/util.py'));
    await asBoardDoc('/lib/util.py');
    await pressRun();
    assert.equal(runCalls()[0]?.local, local('lib/util.py'));
  });

  it('with a board folder setting (/app): /app/x.py maps to x.py; click and Run use the project file', async () => {
    setup({ rootPath: '/app', local: { 'x.py': 'mine' }, board: { '/app/x.py': 'board' } });
    await click('/app/x.py');
    assert.equal(mock.activeEditor?.document.uri.fsPath, local('x.py'));
    await asBoardDoc('/app/x.py');
    await pressRun();
    assert.equal(runCalls()[0]?.local, local('x.py'));
  });

  it('multi-root: the same device path in two folders maps to the FIRST folder only, deterministically, for click and Run', async () => {
    setup({ local: { 'x.py': 'first' }, board: { '/x.py': 'board' } });
    const second = path.join(path.dirname(kit.workspace), 'second-root');
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(path.join(second, 'x.py'), 'second');
    try {
      mock.setWorkspaceFolders(kit.workspace, second);
      await click('/x.py');
      assert.equal(mock.activeEditor?.document.uri.fsPath, local('x.py'));
      await asBoardDoc('/x.py');
      await pressRun();
      assert.equal(runCalls().length, 1);
      assert.equal(runCalls()[0]?.local, local('x.py'));
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it('multi-root: a file that only the SECOND folder has is treated as board-only (copy goes to the first folder, never into the second)', async (t) => {
    setup({ board: { '/y.py': 'board' } });
    const second = path.join(path.dirname(kit.workspace), 'second-root');
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(path.join(second, 'y.py'), 'second');
    try {
      mock.setWorkspaceFolders(kit.workspace, second);
      mock.answerMessage(/only on the board/, COPY_BUTTON);
      await click('/y.py');
      await until('copy', () => (kit.read('y.py') ?? '') !== '');
      t.diagnostic('the project has y.py in folder 2 only; a click copied the board file into folder 1 (known: only the first folder is mapped)');
      assert.equal(fs.readFileSync(path.join(second, 'y.py'), 'utf8'), 'second', 'folder 2 untouched');
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});

describe('review10: the sync history after a copy', () => {
  it('after "Copy it to my project", editing the file marks it local-changed and Upload Current File sends the edit', async () => {
    setup({ board: { '/e.py': 'one\n' } });
    mock.answerMessage(/only on the board/, COPY_BUTTON);
    await click('/e.py');
    await until('copy', () => (kit.read('e.py') ?? '') !== '');
    await until('the project file shown', () => mock.activeEditor?.document.uri.scheme === 'file');
    await mock.saveFile(vscode.Uri.file(local('e.py')), 'two\n');
    await kit.sync.uploadFile(vscode.Uri.file(local('e.py')));
    assert.equal(kit.session.boardFs?.read('/e.py'), 'two\n');
  });

  it('a copied file whose name the ignore rules cover is created but not put in the sync history', async () => {
    setup({ board: { '/typings/t.pyi': 'x\n' } });
    mock.answerMessage(/only on the board/, COPY_BUTTON);
    await click('/typings/t.pyi');
    await until('copy', () => (kit.read('typings/t.pyi') ?? '') !== '');
    const ctx = await kit.sync.folderContext();
    const baseline = (await ctx?.store.load(boardKeyOf(FAKE_IDENTITY)))?.files ?? {};
    assert.equal(baseline['typings/t.pyi'], undefined);
  });
});
