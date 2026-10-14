/**
 * Files view: tree contents (nested, empty, unicode, spaces), lazy listing, refresh without staleness, error and retry rows,
 * placeholders (not connected, connecting, program running), session-driven refreshes, icons and tree item details.
 * Everything runs on the mocked `vscode` and FakeSession; no port, no bridge, no board.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COMMAND_IDS, TREE_CONTEXT, VIEWS } from '../../src/contributes';
import { settingId } from '../../src/identity';
import type { BoardNode } from '../../src/types/sync';
import { Settings } from '../../src/types/settings';
import { BOARD_URI_SCHEME } from '../../src/views/decorations';
import { compareEntries, formatSize, joinDevicePath, parentOf } from '../../src/views/filesModel';
import { FilesTree, type FilesNode } from '../../src/views/filesView';
import { FakeSession, enc } from '../mocks/fakeSession';
import { WINDOWS } from '../mocks/fixtures';
import type { MockExtensionContext } from '../mocks/extensionContext';
import { createExtensionContext, createTestLogger, mock, type MockTreeView } from '../mocks/vscode';

let ctx: MockExtensionContext;
let sessions: FakeSession[] = [];
let trees: FilesTree[] = [];

beforeEach(() => {
  mock.reset();
  // D-24: the extension works only with a project folder open (views and connect)
  mock.setWorkspaceFolders(os.tmpdir());
  ctx = createExtensionContext();
});
afterEach(() => {
  trees.forEach((t) => t.dispose());
  sessions.forEach((s) => s.dispose());
  trees = [];
  sessions = [];
  ctx.dispose();
  mock.reset();
});

interface Harness { session: FakeSession; tree: FilesTree; view: MockTreeView<unknown>; channel: ReturnType<typeof createTestLogger>['channel'] }

function setup(session: FakeSession = FakeSession.connected(), extensionUri: vscode.Uri = ctx.extensionUri): Harness {
  sessions.push(session);
  const { log, channel } = createTestLogger();
  const tree = new FilesTree({ session, log, settings: new Settings(), extensionUri });
  trees.push(tree);
  vscode.window.createTreeView(VIEWS.files, { treeDataProvider: tree });
  const view = mock.treeViews.get(VIEWS.files);
  assert.ok(view, 'the Files tree view was not created');
  return { session, tree, view, channel };
}

const labels = (nodes: readonly ({ label: string } | { name: string })[]): string[] => nodes.map((n) => ('name' in n ? n.name : n.label));
const asBoard = (n: FilesNode | undefined): BoardNode => {
  assert.ok(n && n.kind !== 'status', 'expected a board file or folder node');
  return n;
};

describe('filesModel (pure)', () => {
  it('orders folders first, then files, case-insensitive and natural', () => {
    const names = [
      { name: 'file10.py', kind: 'file' as const }, { name: 'File1.py', kind: 'file' as const }, { name: 'file2.py', kind: 'file' as const },
      { name: 'b', kind: 'dir' as const }, { name: 'A', kind: 'dir' as const }, { name: 'a10', kind: 'dir' as const }, { name: 'a9', kind: 'dir' as const },
    ];
    assert.deepEqual(names.sort(compareEntries).map((n) => n.name), ['A', 'a9', 'a10', 'b', 'File1.py', 'file2.py', 'file10.py']);
  });

  it('is deterministic for names that differ only in case', () => {
    const a = { name: 'a.py', kind: 'file' as const };
    const b = { name: 'A.py', kind: 'file' as const };
    assert.equal(compareEntries(a, b), -compareEntries(b, a));
    assert.notEqual(compareEntries(a, b), 0);
  });

  it('joins and splits device paths without touching the names', () => {
    assert.equal(joinDevicePath('/', 'main.py'), '/main.py');
    assert.equal(joinDevicePath('/lib', 'a b (1).py'), '/lib/a b (1).py');
    assert.equal(joinDevicePath('/', 'a\\b.py'), '/a\\b.py');
    assert.equal(parentOf('/lib/x.py'), '/lib');
    assert.equal(parentOf('/x.py'), '/');
  });

  it('formats sizes', () => {
    assert.deepEqual([0, 512, 1024, 1536, 1048576].map(formatSize), ['0 B', '512 B', '1.0 KB', '1.5 KB', '1.0 MB']);
  });
});

describe('Files view: contents', () => {
  it('shows nested folders and files: folders first, natural case-insensitive order, unicode and spaces intact', async () => {
    const s = FakeSession.connected();
    const board = s.useBoardFs({
      '/boot.py': 'x', '/main.py': 'print(1)\n', '/File10.py': '', '/file2.py': '', '/File1.py': '',
      '/lib/sensor.py': 'abc', '/lib/sub/deep.py': '1', '/Zeta/z.py': '', '/alpha/a.py': '',
      '/Übung (1)/lab 1.py': 'x', '/中文/数据.txt': 'yy', '/dir with space/a b.py': '',
    });
    board.write('/a\\b.py', enc('backslash in a device name'));
    await s.call('fs.mkdir', { path: '/empty' });
    const { view } = setup(s);

    const root = await view.snapshot(1);
    assert.deepEqual(labels(root), [
      'alpha', 'dir with space', 'empty', 'lib', 'Übung (1)', 'Zeta', '中文',
      'a\\b.py', 'boot.py', 'File1.py', 'file2.py', 'File10.py', 'main.py',
    ]);
    assert.deepEqual(root.map((n) => n.contextValue), [
      ...Array(7).fill(TREE_CONTEXT.dir), ...Array(6).fill(TREE_CONTEXT.file),
    ]);

    const deep = await view.snapshot(3);
    const lib = deep.find((n) => n.label === 'lib');
    assert.deepEqual(labels(lib?.children ?? []), ['sub', 'sensor.py']);
    assert.deepEqual(labels(lib?.children?.[0]?.children ?? []), ['deep.py']);
    assert.deepEqual(labels(deep.find((n) => n.label === 'Übung (1)')?.children ?? []), ['lab 1.py']);
    assert.deepEqual(labels(deep.find((n) => n.label === '中文')?.children ?? []), ['数据.txt']);
  });

  it('hands commands a BoardNode with the exact device path, even for odd names', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/dir with space/a b (1).py': 'x', '/Übung/é.py': 'y' });
    const { tree } = setup(s);
    const [spaceDir] = (await tree.getChildren()) as FilesNode[];
    const child = asBoard((await tree.getChildren(spaceDir))[0]);
    assert.deepEqual({ ...child }, { devicePath: '/dir with space/a b (1).py', kind: 'file', name: 'a b (1).py', size: 1 });
    const unicode = asBoard((await tree.getChildren())[1]);
    assert.equal(asBoard((await tree.getChildren(unicode))[0]).devicePath, '/Übung/é.py');
  });

  it('describes files and folders for the menus and the click', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/lib/x.py': 'x'.repeat(1536), '/main.py': 'print(1)\n' });
    const { tree } = setup(s);
    const [lib, main] = await tree.getChildren();
    const dirItem = tree.getTreeItem(lib as FilesNode);
    assert.equal(dirItem.contextValue, TREE_CONTEXT.dir);
    assert.equal(dirItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.equal(dirItem.command, undefined);
    assert.equal(dirItem.id, '/lib');

    const fileItem = tree.getTreeItem(main as FilesNode);
    assert.equal(fileItem.contextValue, TREE_CONTEXT.file);
    assert.equal(fileItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(fileItem.description, '9 B');
    assert.match(String(fileItem.tooltip), /\/main\.py\n9 B \(9 bytes\)/);
    assert.equal(fileItem.command?.command, COMMAND_IDS.openFileFromBoard);
    assert.deepEqual(fileItem.command?.arguments, [main], 'the click passes the node itself');

    const x = tree.getTreeItem(asBoard((await tree.getChildren(lib))[0]));
    assert.equal(x.description, '1.5 KB');
  });

  it('uses the media icons and a private scheme resourceUri for decorations (Windows-shaped extension folder too)', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/lib/x.py': '1' });
    for (const extensionUri of [ctx.extensionUri, vscode.Uri.file(WINDOWS.workspace)]) {
      const tree = new FilesTree({ session: s, log: createTestLogger().log, settings: new Settings(), extensionUri });
      trees.push(tree);
      const [lib] = await tree.getChildren();
      const dir = tree.getTreeItem(lib as FilesNode);
      const file = tree.getTreeItem(asBoard((await tree.getChildren(lib))[0]));
      // Theme icons (they follow the file icon theme and stay visible in dark themes), not SVG files with currentColor.
      assert.equal((dir.iconPath as vscode.ThemeIcon).id, 'folder');
      assert.equal((file.iconPath as vscode.ThemeIcon).id, 'file');
      assert.equal(file.resourceUri?.scheme, BOARD_URI_SCHEME);
      assert.equal(file.resourceUri?.path, '/lib/x.py');
    }
  });

  it('shows a friendly row for an empty board that says what to do next', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({});
    const { tree, view } = setup(s);
    const root = await view.snapshot(1);
    assert.deepEqual(labels(root), ['No files on the board yet']);
    assert.equal(root[0]?.contextValue, undefined, 'a message row has no file menu');
    const item = tree.getTreeItem((await tree.getChildren())[0] as FilesNode);
    assert.match(String(item.description), /Upload All Files/);
    assert.match(String(item.tooltip), /The folder \/ on the board is empty\. Create a file with the New File button/);
    assert.equal(item.command, undefined);
  });

  it('shows "This folder is empty" inside an empty folder', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({});
    await s.call('fs.mkdir', { path: '/empty' });
    const { tree, view } = setup(s);
    assert.deepEqual(labels(await view.snapshot(1)), ['empty']);
    const [dir] = await tree.getChildren();
    assert.deepEqual(labels(await tree.getChildren(dir)), ['This folder is empty']);
    assert.deepEqual((await view.snapshot(2))[0]?.children?.map((c) => c.label), ['This folder is empty']);
  });
});

describe('Files view: lazy listing and calls', () => {
  it('lists a folder only when VS Code asks for it, in the background, without interrupting and with a limit and a signal', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/lib/x.py': '1', '/other/y.py': '2' });
    const { tree } = setup(s);
    const nodes = await tree.getChildren();
    assert.deepEqual(s.argsOf('fs.list'), [{ path: '/', background: true }]);
    await tree.getChildren(nodes[0]);
    assert.deepEqual(s.argsOf('fs.list').map((a) => a.path), ['/', '/lib']);
    for (const call of s.callsOf('fs.list')) {
      assert.ok(call.opts?.timeoutMs && call.opts.timeoutMs >= 10_000, 'a client-side timeout is set');
      assert.ok(call.opts?.signal instanceof AbortSignal, 'a signal is passed so a refresh can cancel it');
      assert.equal((call.args as { interrupt?: boolean }).interrupt, undefined, 'a listing never interrupts a program');
    }
  });

  it('does not list the same folder twice while a listing is in flight', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/a.py': '1' });
    const { tree } = setup(s);
    const gate = s.hold('fs.list');
    const first = tree.getChildren();
    await gate.arrived;
    const second = tree.getChildren();
    gate.release();
    assert.deepEqual(labels((await first)), ['a.py']);
    assert.deepEqual(labels((await second)), ['a.py']);
    assert.equal(s.callsOf('fs.list').length, 1);
  });

  it('honours the rootPath setting and re-reads when it changes', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/top.py': '1', '/lib/x.py': '22' });
    const { tree, view } = setup(s);
    assert.deepEqual(labels(await view.snapshot(1)), ['lib', 'top.py']);
    const before = view.refreshes;
    mock.config.set(settingId('rootPath'), '/lib');
    assert.equal(view.refreshes, before + 1);
    const nodes = await tree.getChildren();
    assert.deepEqual(nodes.map((n) => (n.kind === 'status' ? n.label : n.devicePath)), ['/lib/x.py']);
    assert.deepEqual(s.argsOf('fs.list').map((a) => a.path), ['/', '/lib']);
  });

  it('explains a root folder that does not exist on the board, with a way to try again', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/a.py': '1' });
    const { tree, channel } = setup(s);
    mock.config.set(settingId('rootPath'), '/nope');
    const [row] = await tree.getChildren();
    assert.equal(row?.kind, 'status');
    const item = tree.getTreeItem(row as FilesNode);
    assert.equal(item.label, "Could not read the board's files");
    assert.match(String(item.tooltip), /\/nope does not exist on the board/);
    assert.match(channel.text, /ERROR.*Could not list \/nope on the board \(\[E_FS_ERRNO\]/);
  });
});

describe('Files view: refresh never serves a stale tree (old defect: "Refresh does nothing for 30 s")', () => {
  it('re-lists immediately after a refresh, even one millisecond after the previous listing', async () => {
    const s = FakeSession.connected();
    const board = s.useBoardFs({ '/main.py': '1' });
    const { tree, view } = setup(s);
    assert.deepEqual(labels(await view.snapshot(1)), ['main.py']);

    board.write('/new_file.py', enc('created on the board by a program'));
    assert.deepEqual(labels(await view.snapshot(1)), ['main.py'], 'without a refresh the listing is reused (VS Code does not ask again either)');
    assert.equal(s.callsOf('fs.list').length, 1);

    tree.refresh();
    assert.deepEqual(labels(await view.snapshot(1)), ['main.py', 'new_file.py']);
    assert.equal(s.callsOf('fs.list').length, 2);
  });

  it('re-lists every open folder, not only the root', async () => {
    const s = FakeSession.connected();
    const board = s.useBoardFs({ '/lib/a.py': '1' });
    const { tree, view } = setup(s);
    assert.deepEqual(labels((await view.snapshot(2))[0]?.children ?? []), ['a.py']);
    board.write('/lib/b.py', enc('2'));
    tree.refresh();
    const again = await view.snapshot(2);
    assert.deepEqual(labels(again[0]?.children ?? []), ['a.py', 'b.py']);
    assert.deepEqual(s.argsOf('fs.list').map((a) => a.path), ['/', '/lib', '/', '/lib']);
  });

  it('has no time-based cache at all: a refresh long after the first listing and one right after behave the same', async () => {
    const s = FakeSession.connected();
    const board = s.useBoardFs({ '/a.py': '1' });
    const { tree } = setup(s);
    await tree.getChildren();
    const realNow = Date.now;
    try {
      const start = realNow.call(Date);
      Date.now = () => start + 3_600_000;
      board.write('/b.py', enc('2'));
      tree.refresh();
      assert.deepEqual(labels((await tree.getChildren())), ['a.py', 'b.py']);
    } finally {
      Date.now = realNow;
    }
  });

  it('fires the tree-change event on refresh and on a folder refresh', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/lib/a.py': '1', '/other/z.py': '1' });
    const { tree, view } = setup(s);
    await view.snapshot(2);
    const base = view.refreshes;
    tree.refresh();
    assert.equal(view.refreshes, base + 1);
    await view.snapshot(2);
    tree.refreshFolder('/lib');
    assert.equal(view.refreshes, base + 2);
  });

  it('refreshes one folder only: its listing is dropped, the others stay', async () => {
    const s = FakeSession.connected();
    const board = s.useBoardFs({ '/lib/a.py': '1', '/other/z.py': '1' });
    const { tree, view } = setup(s);
    await view.snapshot(2);
    s.calls.length = 0;
    board.write('/lib/b.py', enc('2'));
    tree.refreshFolder('/lib');
    const [lib, other] = (await tree.getChildren()) as FilesNode[];
    assert.deepEqual(labels((await tree.getChildren(lib))), ['a.py', 'b.py']);
    assert.deepEqual(labels((await tree.getChildren(other))), ['z.py']);
    assert.deepEqual(s.argsOf('fs.list').map((a) => a.path), ['/lib'], 'only /lib was listed again');
  });

  it('understands the refresh command arguments: none, a folder, a file (its folder), garbage', async () => {
    const s = FakeSession.connected();
    const board = s.useBoardFs({ '/lib/a.py': '1' });
    const { tree, view } = setup(s);
    await view.snapshot(2);
    board.write('/lib/b.py', enc('2'));
    tree.refreshFromCommand({ devicePath: '/lib/a.py', kind: 'file' });
    const [lib] = (await tree.getChildren()) as FilesNode[];
    assert.deepEqual(labels((await tree.getChildren(lib))), ['a.py', 'b.py']);

    board.write('/c.py', enc('3'));
    for (const arg of [undefined, null, 'x', 42, { devicePath: 7 }, { devicePath: 'relative/path' }, {}]) {
      s.calls.length = 0;
      tree.refreshFromCommand(arg);
      await tree.getChildren();
      assert.equal(s.callsOf('fs.list').length, 1, `full refresh for ${JSON.stringify(arg)}`);
    }
  });

  it('a refresh during a listing cancels it and the answer comes from the new listing (no error row, no abort message)', async () => {
    const s = FakeSession.connected();
    const board = s.useBoardFs({ '/old.py': '1' });
    const { tree, channel } = setup(s);
    const gate = s.hold('fs.list');
    const pending = tree.getChildren();
    await gate.arrived;
    board.write('/new.py', enc('2'));
    tree.refresh();
    const rows = (await pending);
    assert.deepEqual(labels(rows), ['new.py', 'old.py']);
    gate.release();
    assert.equal(s.callsOf('fs.list')[0]?.aborted, true);
    assert.doesNotMatch(channel.text, /ERROR/);
  });
});

describe('Files view: errors and retry', () => {
  it('shows an error row (never a blank view) with the cause, the fix, and a Try again command; logs it once', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/main.py': '1' });
    s.fail('fs.list', 'E_FS_ERRNO', 'The board could not read that folder.', { detail: 'EIO', hint: 'Unplug the board, plug it in again, and press Refresh.' });
    const { tree, channel } = setup(s);

    const rows = await tree.getChildren();
    assert.equal(rows.length, 1);
    const item = tree.getTreeItem(rows[0] as FilesNode);
    assert.equal(item.label, "Could not read the board's files");
    assert.equal(item.description, 'The board could not read that folder.');
    assert.equal(item.contextValue, undefined);
    assert.match(String(item.tooltip), /could not read that folder\. Unplug the board/);
    assert.match(String(item.tooltip), /Details: EIO/);
    assert.match(String(item.tooltip), /Click to try again\./);
    assert.equal(item.command?.command, COMMAND_IDS.refresh);
    assert.deepEqual(item.command?.arguments, [{ devicePath: '/' }]);
    assert.equal(channel.lines.filter((l) => /ERROR/.test(l) && /E_FS_ERRNO/.test(l)).length, 1);

    // The retry row runs the refresh command with its argument: the listing works the second time.
    tree.refreshFromCommand(item.command?.arguments?.[0]);
    assert.deepEqual(labels((await tree.getChildren())), ['main.py']);
  });

  it('an error in a subfolder does not hide the rest of the tree, and retries just that folder', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/lib/a.py': '1', '/main.py': '1' });
    const { tree } = setup(s);
    const [lib] = (await tree.getChildren()) as FilesNode[];
    s.fail('fs.list', 'E_FS_ERRNO', 'The board could not read that folder.', { detail: 'EIO' });
    const rows = await tree.getChildren(lib);
    const item = tree.getTreeItem(rows[0] as FilesNode);
    assert.equal(item.label, 'Could not read this folder');
    assert.deepEqual(item.command?.arguments, [{ devicePath: '/lib' }]);
    tree.refreshFromCommand(item.command?.arguments?.[0]);
    assert.deepEqual(labels((await tree.getChildren(lib))), ['a.py']);
    assert.deepEqual(labels((await tree.getChildren())), ['lib', 'main.py']);
  });

  it('a timeout is an error row with advice, not a blank view', async () => {
    const s = FakeSession.connected();
    s.fail('fs.list', 'E_CALL_TIMEOUT', 'The board did not answer in time.', { hint: 'Check the cable and try again.' });
    const { tree } = setup(s);
    const [row] = await tree.getChildren();
    const item = tree.getTreeItem(row as FilesNode);
    assert.match(String(item.tooltip), /did not answer in time\. Check the cable/);
    assert.equal(item.command?.command, COMMAND_IDS.refresh);
  });

  it('treats "a program is running" from the bridge as a state, not as an error', async () => {
    const s = FakeSession.connected();
    s.fail('fs.list', 'E_PROGRAM_RUNNING', 'A program is running on the board.', { needs_interrupt: true, hint: 'Press Stop first.' });
    const { tree, channel } = setup(s);
    const rows = await tree.getChildren();
    assert.equal(rows.length, 1);
    assert.equal(tree.getTreeItem(rows[0] as FilesNode).label, 'A program is running on the board');
    assert.doesNotMatch(channel.text, /ERROR/);
  });

  it('turns a late "not connected" into the Connect row', async () => {
    const s = FakeSession.connected();
    s.fail('fs.list', 'E_NOT_CONNECTED', 'No board is connected.', { hint: 'Select a serial port first.' });
    const { tree, channel } = setup(s);
    const [row] = await tree.getChildren();
    assert.equal(tree.getTreeItem(row as FilesNode).label, 'Connect to /dev/cu.fake');
    assert.doesNotMatch(channel.text, /ERROR/);
  });
});

describe('Files view: placeholders', () => {
  it('returns nothing when no port is known, so the manifest welcome text with its button shows', async () => {
    const { tree, session } = setup(new FakeSession());
    assert.deepEqual(await tree.getChildren(), []);
    assert.equal(session.calls.length, 0);
  });

  it('returns nothing when Python is not working, even with a port, so the Doctor welcome shows', async () => {
    const s = new FakeSession({ interpreter: 'problem', port: null });
    s.selectPort('COM3');
    const { tree } = setup(s);
    assert.deepEqual(await tree.getChildren(), []);
    assert.equal(s.calls.length, 0);
  });

  it('shows "Connect to <port>" when a port is selected but not connected, and does not touch the board', async () => {
    const s = new FakeSession();
    s.selectPort(WINDOWS.comPort);
    const { tree } = setup(s);
    const rows = await tree.getChildren();
    assert.equal(rows.length, 1);
    const item = tree.getTreeItem(rows[0] as FilesNode);
    assert.equal(item.label, 'Connect to COM12');
    assert.equal(item.description, 'Not connected');
    assert.equal(item.command?.command, COMMAND_IDS.selectPort);
    assert.deepEqual(item.command?.arguments, [{ reuse: true }]);
    assert.match(String(item.tooltip), /no other program \(Thonny/);
    assert.equal(s.calls.length, 0);
  });

  it('uses the port from the settings when nothing was selected, and never the word auto', async () => {
    mock.config.set(settingId('port'), 'COM7');
    const { tree } = setup(new FakeSession());
    assert.equal(tree.getTreeItem((await tree.getChildren())[0] as FilesNode).label, 'Connect to COM7');

    mock.config.set(settingId('port'), 'auto');
    tree.refresh();
    assert.deepEqual(await tree.getChildren(), []);
  });

  it('shows a spinner row while connecting', async () => {
    const s = new FakeSession({ state: 'connecting', port: 'COM3' });
    s.selectPort('COM3');
    const { tree } = setup(s);
    const item = tree.getTreeItem((await tree.getChildren())[0] as FilesNode);
    assert.equal(item.label, 'Connecting to COM3...');
    assert.equal((item.iconPath as vscode.ThemeIcon).id, 'loading~spin');
    assert.equal(s.calls.length, 0);
  });

  it('while a program runs, shows one explaining row (no listing, no interrupt) when nothing was listed before', async () => {
    const s = FakeSession.connected({ state: 'running' });
    s.useBoardFs({ '/main.py': '1' });
    const { tree } = setup(s);
    const rows = await tree.getChildren();
    assert.equal(rows.length, 1);
    const item = tree.getTreeItem(rows[0] as FilesNode);
    assert.equal(item.label, 'A program is running on the board');
    assert.match(String(item.tooltip), /Press Stop in Board Actions/);
    assert.equal(s.callsOf('fs.list').length, 0);
  });

  it('keeps showing the last listing while a program runs, and re-lists when it stops (it may have written files)', async () => {
    const s = FakeSession.connected();
    const board = s.useBoardFs({ '/main.py': '1' });
    const { tree, view } = setup(s);
    await view.snapshot(1);
    const base = view.refreshes;

    s.setState({ state: 'running', reason: 'run' });
    assert.equal(view.refreshes, base, 'starting a Run does not blank the view');
    assert.deepEqual(labels((await tree.getChildren())), ['main.py']);

    board.write('/log.txt', enc('written by the program'));
    s.setState({ state: 'idle', reason: 'program ended' });
    assert.equal(view.refreshes, base + 1, 'the end of the program refreshes once');
    assert.deepEqual(labels(await view.snapshot(1)), ['log.txt', 'main.py']);
    assert.equal(s.callsOf('fs.list').length, 2);
  });
});

describe('Files view: follows the session', () => {
  it('does not refresh for the bridge\'s own file operations (idle <-> rawop), so there is no flicker or listing storm', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/a.py': '1' });
    const { view } = setup(s);
    await view.snapshot(1);
    const base = view.refreshes;
    for (let i = 0; i < 5; i++) {
      s.setState({ state: 'rawop' });
      s.setState({ state: 'idle' });
    }
    s.setPendingSyncCount(4);
    assert.equal(view.refreshes, base);
    assert.equal(s.callsOf('fs.list').length, 1);
  });

  it('shows the board after connecting and the placeholder after disconnecting, dropping the old listing', async () => {
    const s = new FakeSession();
    s.selectPort('COM3');
    s.useBoardFs({ '/main.py': '1' });
    const { tree, view } = setup(s);
    assert.equal(tree.getTreeItem((await tree.getChildren())[0] as FilesNode).label, 'Connect to COM3');

    const before = view.refreshes;
    await s.connect('COM3');
    assert.ok(view.refreshes > before, 'connecting refreshes the tree');
    assert.deepEqual(labels(await view.snapshot(1)), ['main.py']);

    await s.disconnect();
    const rows = await tree.getChildren();
    assert.equal(tree.getTreeItem(rows[0] as FilesNode).label, 'Connect to COM3');
    const lists = s.callsOf('fs.list').length;
    await tree.getChildren();
    assert.equal(s.callsOf('fs.list').length, lists, 'no listing while disconnected');
  });

  it('never shows the previous board\'s files after switching boards (old defect: cache not keyed by port)', async () => {
    const s = FakeSession.connected({ port: 'COM3' });
    s.script('fs.list', (args) => ({ entries: [{ name: args.path === '/' ? 'board_a.py' : 'x', type: 'file', size: 1 }] }));
    const { tree, view } = setup(s);
    assert.deepEqual(labels(await view.snapshot(1)), ['board_a.py']);

    s.script('fs.list', () => ({ entries: [{ name: 'board_b.py', type: 'file', size: 1 }] }));
    s.setState({ port: 'COM4' });
    assert.deepEqual(labels((await tree.getChildren())), ['board_b.py']);
  });

  it('refreshes when Python becomes unusable and when it recovers', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/a.py': '1' });
    const { tree, view } = setup(s);
    await view.snapshot(1);
    s.setState({ interpreter: 'problem', state: 'disconnected', port: null });
    s.selectPort('COM3');
    assert.deepEqual(await tree.getChildren(), []);
    s.setState({ interpreter: 'ok' });
    assert.equal(tree.getTreeItem((await tree.getChildren())[0] as FilesNode).label, 'Connect to COM3');
  });
});

describe('Files view: lifetime', () => {
  it('cancels the listing in flight when disposed and stops reacting to the session', async () => {
    const s = FakeSession.connected();
    s.useBoardFs({ '/a.py': '1' });
    const { tree } = setup(s);
    const gate = s.hold('fs.list');
    const pending = tree.getChildren();
    await gate.arrived;
    tree.dispose();
    gate.release();
    await pending.catch(() => undefined);
    assert.equal(s.callsOf('fs.list')[0]?.aborted, true);
    s.setState({ state: 'disconnected', port: null });
    s.setState({ state: 'idle', port: 'COM9' });
  });
});
