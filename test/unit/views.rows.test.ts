/**
 * Board Actions view, Sync utilities view, context keys, file decorations and registerViews (the wiring that activate() calls).
 * Mocked `vscode` + FakeSession; nothing touches a port or a board.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COMMAND_IDS, CONTEXT, VIEWS } from '../../src/contributes';
import { settingId } from '../../src/identity';
import { Logger } from '../../src/log';
import type { Services } from '../../src/types/services';
import { PortMemory, Settings } from '../../src/types/settings';
import type { SyncBadge, SyncStatusSource } from '../../src/types/sync';
import { ActionsTree, activeFileLabel } from '../../src/views/actionsView';
import { ContextKeys } from '../../src/views/contextKeys';
import { BOARD_URI_SCHEME, BoardFileDecorations, boardUri, decorationFor } from '../../src/views/decorations';
import { FilesTree } from '../../src/views/filesView';
import { registerViews } from '../../src/views';
import { SyncTree } from '../../src/views/syncView';
import { FakeSession } from '../mocks/fakeSession';
import { TempDirs, WINDOWS, makeTrickyDir } from '../mocks/fixtures';
import type { MockExtensionContext } from '../mocks/extensionContext';
import { createExtensionContext, createTestLogger, mock } from '../mocks/vscode';

const dirs = new TempDirs();
let ctx: MockExtensionContext;
let toDispose: { dispose(): unknown }[] = [];

beforeEach(() => {
  mock.reset();
  // D-24: the extension works only with a project folder open (views and connect)
  mock.setWorkspaceFolders(os.tmpdir());
  ctx = createExtensionContext();
});
afterEach(() => {
  toDispose.splice(0).reverse().forEach((d) => d.dispose());
  toDispose = [];
  ctx.dispose();
  dirs.cleanup();
  mock.reset();
});

function own<T extends { dispose(): unknown }>(d: T): T {
  toDispose.push(d);
  return d;
}

const byId = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

function countChanges(tree: { onDidChangeTreeData: vscode.Event<unknown> }): () => number {
  let n = 0;
  own(tree.onDidChangeTreeData(() => { n++; }));
  return () => n;
}

describe('Board Actions view', () => {
  function actions(session = FakeSession.connected()): { tree: ActionsTree; session: FakeSession } {
    own(session);
    return { tree: own(new ActionsTree(session, new Settings())), session };
  }

  it('lists the rows of the old view in order (plus Set up IntelliSense), each bound to its command', () => {
    const { tree } = actions();
    const rows = tree.rows();
    assert.deepEqual(byId(rows), ['run', 'repl', 'stop', 'reset', 'intellisense', 'doctor']);
    assert.deepEqual(rows.map((r) => r.label), ['Run file', 'Open REPL', 'Stop / Interrupt', 'Reset board...', 'Set up IntelliSense', 'Doctor (check my setup)']);
    assert.deepEqual(rows.map((r) => r.command), [COMMAND_IDS.runActiveFile, COMMAND_IDS.openRepl, COMMAND_IDS.stop, COMMAND_IDS.resetBoard, COMMAND_IDS.fixIntelliSense, COMMAND_IDS.doctor]);
    for (const r of rows) {
      assert.ok(r.tooltip && r.tooltip.length > 20, `${r.id} has a helpful tooltip`);
    }
  });

  it('turns rows into tree items that run the command on click (no arguments, an icon, a stable id)', async () => {
    const { tree } = actions();
    const [run, , stop] = tree.getChildren();
    const runItem = tree.getTreeItem(run!);
    assert.equal(runItem.id, 'run');
    assert.deepEqual(runItem.command, { command: COMMAND_IDS.runActiveFile, title: 'Run file' });
    const icon = runItem.iconPath as vscode.ThemeIcon;
    assert.equal(icon.id, 'play');
    assert.equal((icon.color as { id?: string } | undefined)?.id, 'charts.green');
    assert.equal(tree.getTreeItem(stop!).command?.command, COMMAND_IDS.stop);
    assert.deepEqual(tree.getChildren(run!), [], 'rows have no children');
  });

  it('Run file names the file in the editor (real folder with spaces, parentheses and non-ASCII)', async () => {
    const { tree } = actions();
    assert.equal(tree.rows()[0]?.description, 'Open a Python file first');
    const file = path.join(makeTrickyDir(dirs.make()), 'Übung main (v2).py');
    const fsPromises = await import('node:fs/promises');
    await fsPromises.writeFile(file, 'print(1)\n');
    await mock.openEditor(file);
    assert.equal(tree.rows()[0]?.description, 'Übung main (v2).py');
  });

  it('Run file names a Windows-shaped file by its last segment (injected, not a Windows run)', async () => {
    const { tree } = actions();
    mock.fsMode = 'memory';
    mock.memoryFs.seed({ [WINDOWS.mainPy]: 'print(1)\n' });
    await mock.openEditor(vscode.Uri.file(WINDOWS.mainPy));
    assert.equal(tree.rows()[0]?.description, 'main.py');
    assert.equal(activeFileLabel(mock.activeEditor as unknown as vscode.TextEditor), 'main.py');
  });

  it('Run file asks to save an untitled file and ignores non-file editors', async () => {
    const { tree } = actions();
    await mock.openEditor(await mock.openDocument({ content: 'print(1)', language: 'python' }));
    assert.equal(tree.rows()[0]?.description, 'Untitled (save it first)');
    mock.activeEditor = undefined;
    assert.equal(tree.rows()[0]?.description, 'Open a Python file first');
    assert.equal(activeFileLabel(undefined), null);
  });

  it('refreshes when the active editor changes', async () => {
    const { tree } = actions();
    const changes = countChanges(tree);
    mock.memoryFs.seed({ '/ws/a.py': '1' });
    mock.fsMode = 'memory';
    await mock.openEditor('/ws/a.py');
    assert.equal(changes(), 1);
    assert.equal(tree.rows()[0]?.description, 'a.py');
  });

  it('Stop says whether anything runs; it stays clickable in every state so it always reaches the board', () => {
    const { tree, session } = actions(new FakeSession());
    const expectStop = (description: string, color: string): void => {
      const stop = tree.rows().find((r) => r.id === 'stop');
      assert.equal(stop?.description, description);
      assert.equal(stop?.color, color);
      assert.equal(stop?.command, COMMAND_IDS.stop);
    };
    expectStop('Nothing is running', 'disabledForeground');
    session.setState({ state: 'idle', port: 'COM3' });
    expectStop('Nothing is running', 'disabledForeground');
    session.setState({ state: 'running' });
    expectStop('Stops the running program', 'charts.red');
    session.setState({ state: 'rawop' });
    expectStop('Nothing is running', 'disabledForeground');
  });

  it('Doctor flags a Python problem and returns to normal when it is fixed', () => {
    const { tree, session } = actions();
    const doctor = (): { description?: string; icon: string } => {
      const r = tree.rows().find((x) => x.id === 'doctor');
      return { description: r?.description, icon: r?.icon ?? '' };
    };
    assert.deepEqual(doctor(), { description: 'Check Python, port and board', icon: 'checklist' });
    session.setState({ interpreter: 'problem' });
    assert.deepEqual(doctor(), { description: 'A Python problem was found', icon: 'warning' });
    session.setState({ interpreter: 'ok' });
    assert.equal(doctor().icon, 'checklist');
  });

  it('refreshes on every state change and stops after dispose', () => {
    const session = own(FakeSession.connected());
    const tree = new ActionsTree(session, new Settings());
    const changes = countChanges(tree);
    session.setState({ state: 'running' });
    session.setState({ state: 'idle' });
    assert.equal(changes(), 2);
    tree.dispose();
    session.setState({ state: 'running' });
    assert.equal(changes(), 2);
  });

  it('has the same rows when nothing is connected (the layout never changes)', () => {
    const { tree } = actions(new FakeSession());
    assert.deepEqual(byId(tree.rows()), ['run', 'repl', 'stop', 'reset', 'intellisense', 'doctor']);
  });
});

describe('Sync utilities view', () => {
  function syncView(session = FakeSession.connected()): { tree: SyncTree; session: FakeSession } {
    own(session);
    return { tree: own(new SyncTree(session, new Settings())), session };
  }

  it('lists Auto-sync, Upload all, Download all and Clear device files with their commands', () => {
    const { tree } = syncView();
    const rows = tree.rows();
    assert.deepEqual(byId(rows), ['autoSync', 'uploadAll', 'downloadAll', 'clearDevice']);
    assert.deepEqual(rows.map((r) => r.label), [
      'Auto-sync: On', 'Upload all files (Local → Board)', 'Download all files (Board → Local)', 'Clear device files',
    ]);
    assert.deepEqual(rows.map((r) => r.command), [COMMAND_IDS.toggleAutoSync, COMMAND_IDS.syncToBoard, COMMAND_IDS.syncFromBoard, COMMAND_IDS.clearDevice]);
    assert.equal(rows[3]?.color, 'charts.red');
  });

  it('shows the auto-sync mode from the setting and refreshes when it changes', () => {
    const { tree } = syncView();
    const changes = countChanges(tree);
    const auto = (): { label: string; description?: string; icon: string } => {
      const r = tree.rows()[0];
      return { label: r?.label ?? '', description: r?.description, icon: r?.icon ?? '' };
    };
    assert.deepEqual(auto(), { label: 'Auto-sync: On', description: 'Uploads a file every time you save', icon: 'sync' }, 'the default (D-21)');
    mock.config.set(settingId('autoSync'), 'ask');
    assert.deepEqual(auto(), { label: 'Auto-sync: Ask', description: 'Asks you when a board connects', icon: 'sync' });
    mock.config.set(settingId('autoSync'), 'off');
    assert.deepEqual(auto(), { label: 'Auto-sync: Off', description: 'Nothing is uploaded when you save', icon: 'sync-ignored' });
    assert.equal(changes(), 2);
    mock.config.set(settingId('rootPath'), '/lib');
    assert.equal(changes(), 2, 'unrelated settings do not refresh the view');
  });

  it('shows "N files waiting" only while uploads are pending, and says why they wait while a program runs', () => {
    const { tree, session } = syncView();
    assert.ok(!byId(tree.rows()).includes('pending'));
    session.setPendingSyncCount(1);
    const one = tree.rows()[1];
    assert.deepEqual([one?.id, one?.label, one?.description, one?.command], ['pending', '1 file waiting', 'Not on the board yet', undefined]);
    session.setPendingSyncCount(3);
    assert.equal(tree.rows()[1]?.label, '3 files waiting');
    session.setState({ state: 'running' });
    assert.equal(tree.rows()[1]?.description, 'Waiting for the program to stop');
    session.setPendingSyncCount(0);
    assert.ok(!byId(tree.rows()).includes('pending'));
  });

  it('refreshes when the pending count changes', () => {
    const { tree, session } = syncView();
    const changes = countChanges(tree);
    session.setPendingSyncCount(2);
    session.setPendingSyncCount(0);
    assert.equal(changes(), 2);
  });
});

describe('context keys', () => {
  function keys(session: FakeSession): ContextKeys {
    own(session);
    const { log } = createTestLogger();
    return own(new ContextKeys(session, new Settings(), log));
  }
  const key = (k: string): unknown => mock.contextKeys.get(k);
  const sent = (): number => mock.executedCommands.filter((c) => c.id === 'setContext').length;

  it('reports the values VS Code accepted, keyed by the hyphenated prefix (the extension-host test hook reads them)', async () => {
    const s = new FakeSession();
    const k = keys(s);
    assert.deepEqual(k.acceptedValues(), {}, 'nothing is acknowledged before the setContext commands resolve');
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(k.acceptedValues(), { 'upy-bridge.hasPort': false, 'upy-bridge.connected': false, 'upy-bridge.running': false, 'upy-bridge.interpreterProblem': false });
    await s.connect('COM3');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(k.acceptedValues()[CONTEXT.connected], true);
    assert.equal(k.acceptedValues()[CONTEXT.hasPort], true);
  });

  it('sets all four session keys at construction, with nothing selected', () => {
    keys(new FakeSession());
    assert.deepEqual(
      [key(CONTEXT.hasPort), key(CONTEXT.connected), key(CONTEXT.running), key(CONTEXT.interpreterProblem)],
      [false, false, false, false],
    );
    assert.equal(key(CONTEXT.hardResetAvailable), undefined, 'hardResetAvailable belongs to the terminal module');
  });

  it('follows selecting a port, connecting, running, a bridge file operation and disconnecting', async () => {
    const s = new FakeSession();
    keys(s);
    s.selectPort('COM3');
    assert.deepEqual([key(CONTEXT.hasPort), key(CONTEXT.connected)], [true, false]);
    s.setState({ state: 'connecting', port: 'COM3' });
    assert.equal(key(CONTEXT.connected), false, 'connecting is not connected yet');
    await s.connect('COM3');
    assert.deepEqual([key(CONTEXT.hasPort), key(CONTEXT.connected), key(CONTEXT.running)], [true, true, false]);
    s.setState({ state: 'running' });
    assert.deepEqual([key(CONTEXT.connected), key(CONTEXT.running)], [true, true]);
    s.setState({ state: 'rawop' });
    assert.deepEqual([key(CONTEXT.connected), key(CONTEXT.running)], [true, false]);
    await s.disconnect();
    assert.deepEqual([key(CONTEXT.hasPort), key(CONTEXT.connected), key(CONTEXT.running)], [true, false, false], 'the port stays selected');
    s.selectPort(null);
    assert.equal(key(CONTEXT.hasPort), false);
  });

  it('sets interpreterProblem from the interpreter state', () => {
    const s = new FakeSession();
    keys(s);
    s.setState({ interpreter: 'problem' });
    assert.equal(key(CONTEXT.interpreterProblem), true);
    s.setState({ interpreter: 'ok' });
    assert.equal(key(CONTEXT.interpreterProblem), false);
  });

  it('counts a port from the settings as a port, and never "auto"', () => {
    keys(new FakeSession());
    mock.config.set(settingId('port'), 'COM9');
    assert.equal(key(CONTEXT.hasPort), true);
    mock.config.set(settingId('port'), 'auto');
    assert.equal(key(CONTEXT.hasPort), false);
  });

  it('sends a key again only when its value changed', () => {
    const s = new FakeSession();
    keys(s);
    const base = sent();
    s.setPendingSyncCount(3);
    s.setState({ reason: 'whatever' });
    s.setState({ state: 'rawop' });
    s.setState({ state: 'idle' });
    assert.equal(sent(), base + 1, 'only `connected` changed (disconnected -> rawop)');
  });

  it('offers setHardResetAvailable for the terminal module', () => {
    const k = keys(new FakeSession());
    k.setHardResetAvailable(true);
    assert.equal(key(CONTEXT.hardResetAvailable), true);
    k.setHardResetAvailable(false);
    assert.equal(key(CONTEXT.hardResetAvailable), false);
  });

  it('logs a failure to set a key and tries again on the next change (no swallowed error)', async () => {
    mock.commandHandlers.set('setContext', () => { throw new Error('context service unavailable'); });
    const s = new FakeSession();
    own(s);
    const { log, channel } = createTestLogger();
    own(new ContextKeys(s, new Settings(), log));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(channel.text, /ERROR.*Could not set the context key .*hasPort.*context service unavailable/);
    mock.commandHandlers.delete('setContext');
    s.selectPort('COM3');
    assert.equal(mock.contextKeys.get(CONTEXT.hasPort), true);
  });
});

class FakeSyncStatus implements SyncStatusSource {
  readonly badges = new Map<string, SyncBadge>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = (listener: () => unknown): { dispose(): unknown } => this.changed.event(listener);
  badgeFor(devicePath: string): SyncBadge | undefined { return this.badges.get(devicePath); }
  fire(): void { this.changed.fire(); }
}

describe('file decorations', () => {
  const ALL: SyncBadge[] = ['in-sync', 'local-changed', 'board-changed', 'conflict', 'board-only', 'local-only'];

  it('has a short badge, an English tooltip and a theme colour for every sync state', () => {
    const seen = new Set<string>();
    for (const b of ALL) {
      const d = decorationFor(b);
      assert.ok(d.badge && d.badge.length >= 1 && d.badge.length <= 2, `${b}: badge is 1-2 characters (a VS Code limit)`);
      assert.ok(d.tooltip && /^[A-Z].*\.$/.test(d.tooltip), `${b}: tooltip is a sentence`);
      assert.ok(d.color instanceof vscode.ThemeColor);
      seen.add(d.badge);
    }
    assert.equal(seen.size, ALL.length, 'every state has its own badge');
  });

  it('decorates board items from the sync status source, by device path, and only in this view', () => {
    const source = new FakeSyncStatus();
    source.badges.set('/main.py', 'local-changed').set('/Übung (1)/lab 1.py', 'conflict');
    const provider = own(new BoardFileDecorations(source));
    assert.equal((provider.provideFileDecoration(boardUri('/main.py')) as vscode.FileDecoration).badge, '↑');
    assert.equal((provider.provideFileDecoration(boardUri('/Übung (1)/lab 1.py')) as vscode.FileDecoration).badge, '!');
    assert.equal(provider.provideFileDecoration(boardUri('/unknown.py')), undefined);
    assert.equal(provider.provideFileDecoration(vscode.Uri.file('/main.py')), undefined, 'the Explorer is never decorated');
    assert.equal(provider.provideFileDecoration(vscode.Uri.file(WINDOWS.mainPy)), undefined);
  });

  it('asks VS Code to redraw when the sync status changes', () => {
    const source = new FakeSyncStatus();
    const provider = own(new BoardFileDecorations(source));
    const fired: unknown[] = [];
    own(provider.onDidChangeFileDecorations!((e) => { fired.push(e); }));
    source.fire();
    assert.deepEqual(fired, [undefined]);
    provider.dispose();
    source.fire();
    assert.equal(fired.length, 1);
  });

  it('reaches the tree items end to end: FilesTree item -> resourceUri -> provider', async () => {
    const s = own(FakeSession.connected());
    s.useBoardFs({ '/lib/a b.py': '1' });
    const status = new FakeSyncStatus();
    status.badges.set('/lib/a b.py', 'board-only');
    const provider = own(new BoardFileDecorations(status));
    const tree = own(new FilesTree({ session: s, log: createTestLogger().log, settings: new Settings(), extensionUri: ctx.extensionUri }));
    const [lib] = await tree.getChildren();
    const [file] = await tree.getChildren(lib);
    const uri = tree.getTreeItem(file!).resourceUri!;
    assert.equal(uri.scheme, BOARD_URI_SCHEME);
    assert.equal((provider.provideFileDecoration(uri) as vscode.FileDecoration).badge, '↓+');
  });
});

describe('registerViews', () => {
  function services(session = FakeSession.connected()): Services {
    own(session);
    const channelFactory = createTestLogger();
    return {
      context: ctx.vscode, log: channelFactory.log as Logger, settings: new Settings(), session, portMemory: new PortMemory(ctx.workspaceState),
    };
  }

  it('creates the three declared views, the refresh command, the status bar and the context keys', () => {
    own({ dispose: () => registered.forEach((d) => d.dispose()) });
    const registered = registerViews(services());
    assert.deepEqual([...mock.treeViews.keys()].sort(), [VIEWS.actions, VIEWS.files, VIEWS.sync].sort());
    assert.ok(mock.commandHandlers.has(COMMAND_IDS.refresh));
    assert.deepEqual(mock.commandContract().extra, [], 'no command that the manifest does not declare');
    assert.equal(mock.statusBarItems.length, 2);
    assert.equal(mock.contextKeys.get(CONTEXT.connected), true);
    assert.equal(mock.decorationProviders.length, 0, 'no decorations without a sync status source');
  });

  it('registers decorations when the sync module provides a status source', () => {
    const registered = registerViews(services(), { syncStatus: new FakeSyncStatus() });
    own({ dispose: () => registered.forEach((d) => d.dispose()) });
    assert.equal(mock.decorationProviders.length, 1);
  });

  it('the refresh command re-lists the board (no argument) or one folder (a node or { devicePath })', async () => {
    const s = FakeSession.connected();
    const board = s.useBoardFs({ '/lib/a.py': '1' });
    const registered = registerViews(services(s));
    own({ dispose: () => registered.forEach((d) => d.dispose()) });
    const files = mock.treeViews.get(VIEWS.files)!;
    await files.snapshot(2);
    const base = files.refreshes;

    board.write('/top.py', new TextEncoder().encode('2'));
    await vscode.commands.executeCommand(COMMAND_IDS.refresh);
    assert.equal(files.refreshes, base + 1);
    assert.deepEqual((await files.snapshot(1)).map((n) => n.label), ['lib', 'top.py']);

    board.write('/lib/b.py', new TextEncoder().encode('3'));
    await vscode.commands.executeCommand(COMMAND_IDS.refresh, { devicePath: '/lib', kind: 'dir' });
    assert.deepEqual((await files.snapshot(2))[0]?.children?.map((n) => n.label), ['a.py', 'b.py']);
  });

  it('disposes everything it created', () => {
    const registered = registerViews(services(), { syncStatus: new FakeSyncStatus() });
    registered.forEach((d) => d.dispose());
    assert.ok([...mock.treeViews.values()].every((v) => v.disposed));
    assert.equal(mock.commandHandlers.has(COMMAND_IDS.refresh), false);
    assert.ok(mock.statusBarItems.every((i) => i.disposed));
    assert.equal(mock.decorationProviders.length, 0);
  });

  it('opens no port and starts no process: activation of the views only reads the session state', () => {
    const s = FakeSession.connected();
    const registered = registerViews(services(s));
    own({ dispose: () => registered.forEach((d) => d.dispose()) });
    assert.deepEqual(s.calls, [], 'registering the views makes no bridge call');
  });
});
