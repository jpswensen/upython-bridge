/**
 * Headless activation (docs/extension-design.md s.5): activate() against the mocked `vscode` with a fake workspace.
 * Process creation is intercepted (child_process is replaced by a recorder that refuses), so "nothing is spawned before the
 * first use" is checked for real, not assumed. Nothing here opens a port, starts Python or launches VS Code.
 */
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { afterEach, beforeEach, describe, it, mock as nodeMock } from 'node:test';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';
import { allCommandIds, COMMAND_IDS, CONTEXT, VIEWS } from '../../src/contributes';
import { IDENTITY, LEGACY, settingId } from '../../src/identity';
import { createExtensionContext, type MockExtensionContext } from '../mocks/extensionContext';
import { TempDirs } from '../mocks/fixtures';
import { mock } from '../mocks/vscode';
import { AUTO_SYNC_CHOICE_KEY, Settings } from '../../src/types/settings';

const dirs = new TempDirs();
let ctx: MockExtensionContext;
let spawned: string[];

const PROCESS_FUNCTIONS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync'] as const;

const settle = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Replace every way of starting a process with a recorder that refuses, so nothing real can start. */
function blockProcesses(): void {
  for (const name of PROCESS_FUNCTIONS) {
    nodeMock.method(cp, name, (...args: unknown[]) => {
      spawned.push(`${name}(${String(args[0])})`);
      throw new Error(`the activation test blocked ${name}`);
    });
  }
}

function openWorkspace(): string {
  const dir = dirs.make('upy-bridge-ws');
  mock.setWorkspaceFolders(dir);
  return dir;
}

function start(context: MockExtensionContext = ctx): void {
  activate(context.vscode);
}

const messages = (level: 'info' | 'warn' | 'error'): string => mock.messages(level).map((m) => m.message).join('\n');

beforeEach(() => {
  mock.reset();
  spawned = [];
  ctx = createExtensionContext();
  blockProcesses();
});

afterEach(() => {
  nodeMock.restoreAll();
  ctx.dispose();
  dirs.cleanup();
  mock.reset();
});

describe('activate() in a normal local window', () => {
  it('registers every declared command exactly once, and nothing else', () => {
    openWorkspace();
    start();
    const contract = mock.commandContract();
    assert.deepEqual(contract.missing, [], 'declared in the manifest but not registered');
    assert.deepEqual(contract.extra, [], 'registered but not declared in the manifest');
    assert.equal(contract.registered.length, allCommandIds().length);
    // registerCommand of an id twice throws in the mock, so reaching this line also proves "exactly once".
  });

  it('creates the three declared views with real content providers', async () => {
    openWorkspace();
    start();
    assert.deepEqual([...mock.treeViews.keys()].sort(), [VIEWS.actions, VIEWS.files, VIEWS.sync].sort());
    const actions = mock.treeViews.get(VIEWS.actions);
    assert.ok(actions);
    const rows = await Promise.resolve(actions.provider.getChildren(undefined));
    assert.ok((rows ?? []).length >= 4, 'Board Actions lists its rows');
  });

  it('sets the four session context keys and creates the status bar items', async () => {
    openWorkspace();
    start();
    await settle();
    for (const key of [CONTEXT.hasPort, CONTEXT.connected, CONTEXT.running, CONTEXT.interpreterProblem]) {
      assert.equal(mock.contextKeys.get(key), false, `${key} is set to false at startup`);
    }
    const board = mock.statusBarItems.find((i) => i.id === `${IDENTITY.prefix}.board`);
    assert.ok(board, 'the board status item exists');
    assert.equal(board.visible, true);
    assert.match(board.text, /No board/);
    assert.ok(mock.statusBarItems.some((i) => i.id === `${IDENTITY.prefix}.autoSync`));
  });

  it('starts no process, opens no port and writes no setting or state before the first use', async () => {
    openWorkspace();
    start();
    await settle(80);
    const files = mock.treeViews.get(VIEWS.files);
    assert.ok(files);
    await Promise.resolve(files.provider.getChildren(undefined)); // the user opens the Files view
    await vscode.commands.executeCommand(COMMAND_IDS.showLog);
    assert.deepEqual(spawned, [], 'no process may be started by activation or by looking at the views');
    assert.deepEqual(mock.config.updates, [], 'no setting is written at startup');
    assert.deepEqual(ctx.workspaceState.writes, []);
    assert.deepEqual(ctx.globalState.writes, []);
  });

  it('starts Python only when the user first needs the board (Select Serial Port)', async () => {
    openWorkspace();
    start();
    await vscode.commands.executeCommand(COMMAND_IDS.selectPort);
    assert.ok(spawned.length > 0, 'the first board command looks for Python');
    assert.match(messages('error'), /serial ports/i, 'the failure is shown to the student');
  });

  it('selects a remembered port without connecting, so the Files view offers "Connect to <port>"', async () => {
    const remembered = { device: '/dev/cu.fakeport', vid: 4292, pid: 60000 };
    ctx.dispose();
    ctx = createExtensionContext({ workspaceState: { [`${IDENTITY.prefix}.rememberedPort`]: remembered } });
    openWorkspace();
    start();
    await settle(80);
    const files = mock.treeViews.get(VIEWS.files);
    assert.ok(files);
    const [row] = (await Promise.resolve(files.provider.getChildren(undefined))) ?? [];
    const item = await Promise.resolve(files.provider.getTreeItem(row as never));
    assert.match(String(item.label), /Connect to \/dev\/cu\.fakeport/);
    assert.deepEqual(spawned, []);
    assert.equal(mock.config.updates.length, 0);
  });

  it('never writes the word auto anywhere', async () => {
    openWorkspace();
    start();
    await settle();
    assert.ok(!mock.config.updates.some((u) => String(u.value).toLowerCase() === 'auto'));
    assert.ok(!ctx.workspaceState.writes.some((w) => JSON.stringify(w.value).toLowerCase().includes('"auto"')));
  });

  it('warns once, with a Doctor button, when the older extension is turned on', async () => {
    openWorkspace();
    mock.addExtension(LEGACY.extensionId);
    mock.answerMessage(/older extension/, 'Open Doctor', { level: 'warn' });
    start();
    await settle(60);
    assert.match(messages('warn'), new RegExp(LEGACY.extensionId.replace('.', '\\.')));
    assert.ok(mock.executedCommands.some((c) => c.id === COMMAND_IDS.doctor), 'the Open Doctor button runs the Doctor');
  });

  it('is quiet when the older extension is not installed', async () => {
    openWorkspace();
    start();
    await settle(60);
    assert.equal(messages('warn'), '');
  });

  it('releases everything when VS Code disposes the subscriptions (deactivate)', async () => {
    openWorkspace();
    start();
    await settle();
    const statusItems = [...mock.statusBarItems];
    const views = [...mock.treeViews.values()];
    const channel = mock.outputChannels.find((c) => c.name === IDENTITY.outputChannelName);
    assert.ok(channel && statusItems.length > 0 && views.length === 3);
    deactivate(); // nothing of its own to release; the Teardown in context.subscriptions does the work
    ctx.dispose();
    assert.deepEqual(mock.commandContract().registered, [], 'all commands are gone');
    assert.ok(statusItems.every((i) => i.disposed), 'status bar items are disposed');
    assert.ok(views.every((v) => v.disposed), 'views are disposed');
    assert.equal(channel.disposed, true, 'the log is released last');
    assert.deepEqual(mock.takeListenerErrors(), []);
  });

  it('puts exactly one entry into context.subscriptions (a single, ordered teardown)', () => {
    openWorkspace();
    start();
    assert.equal(ctx.subscriptions.length, 1);
  });
});

describe('workspace trust (Restricted Mode)', () => {
  it('does not start Python until the folder is trusted, and says so', async () => {
    openWorkspace();
    mock.setTrusted(false);
    start();
    await vscode.commands.executeCommand(COMMAND_IDS.selectPort);
    assert.deepEqual(spawned, [], 'no process in Restricted Mode');
    assert.match(messages('error'), /Restricted Mode/);
    assert.match(messages('error'), /Manage Workspace Trust/);
  });

  it('works as usual once the folder is trusted', async () => {
    openWorkspace();
    mock.setTrusted(false);
    start();
    await vscode.commands.executeCommand(COMMAND_IDS.selectPort);
    assert.deepEqual(spawned, []);
    mock.setTrusted(true);
    await vscode.commands.executeCommand(COMMAND_IDS.selectPort);
    assert.ok(spawned.length > 0, 'after trusting, the first board command looks for Python');
  });
});

describe('windows where the board cannot be used', () => {
  it('Remote, WSL and SSH windows: every command explains what to do and no process starts', async () => {
    openWorkspace();
    mock.setRemote('ssh-remote');
    start();
    const contract = mock.commandContract();
    assert.deepEqual(contract.missing, []);
    assert.deepEqual(contract.extra, []);
    await vscode.commands.executeCommand(COMMAND_IDS.runActiveFile);
    await vscode.commands.executeCommand(COMMAND_IDS.selectPort);
    assert.match(messages('warn'), /Remote, WSL, SSH or Codespaces/);
    assert.deepEqual(spawned, []);
    assert.deepEqual([...mock.treeViews.keys()].sort(), [VIEWS.actions, VIEWS.files, VIEWS.sync].sort(), 'views are registered (empty)');
    assert.deepEqual(await Promise.resolve(mock.treeViews.get(VIEWS.files)?.provider.getChildren(undefined)), []);
    assert.deepEqual(mock.config.updates, []);
  });

  it('virtual folders (not on this computer) are refused with a clear message', async () => {
    mock.setWorkspaceFolders(vscode.Uri.from({ scheme: 'vscode-vfs', authority: 'github', path: '/someone/project' }));
    start();
    await vscode.commands.executeCommand(COMMAND_IDS.openRepl);
    assert.match(messages('warn'), /virtual folder/);
    assert.deepEqual(spawned, []);
  });

  it('Show Log keeps working in a refused window', async () => {
    mock.setRemote('wsl');
    start();
    await vscode.commands.executeCommand(COMMAND_IDS.showLog);
    assert.equal(messages('warn'), '');
    assert.ok((mock.outputChannels.find((c) => c.name === IDENTITY.outputChannelName)?.shown ?? 0) > 0);
  });
});

describe('a failure while activating', () => {
  it('does not throw; every command then answers with the reason instead of "command not found"', async () => {
    openWorkspace();
    const broken = { ...ctx.vscode, globalStorageUri: undefined } as unknown as vscode.ExtensionContext;
    assert.doesNotThrow(() => activate(broken));
    await settle();
    const contract = mock.commandContract();
    assert.deepEqual(contract.missing, [], 'every command is registered');
    assert.match(messages('error'), /could not start/);
    await vscode.commands.executeCommand(COMMAND_IDS.runActiveFile);
    assert.match(messages('warn'), /could not start/);
    assert.deepEqual(spawned, []);
  });
});

describe('the auto-sync mode that the student sees', () => {
  it('is the answer to the first-connect question when the setting is still "ask", and says so in the views and the status bar', async () => {
    openWorkspace();
    mock.config.set(settingId('autoSync'), 'ask'); // the older setting value (the default is 'on' since D-21)
    start();
    await settle();
    const autoItem = mock.statusBarItems.find((i) => i.id === `${IDENTITY.prefix}.autoSync`);
    assert.ok(autoItem);
    assert.match(autoItem.text, /Auto-sync: Ask/);
    await ctx.workspaceState.update(AUTO_SYNC_CHOICE_KEY, 'on'); // what "Turn on" stores
    const sync = new Settings(undefined, ctx.workspaceState);
    assert.equal(sync.autoSync, 'on', 'the effective mode');
    assert.equal(new Settings().autoSync, 'ask', 'without the remembered answer the setting is reported');
    assert.equal(mock.config.updates.length, 0);
  });

  it('notifies listeners when only the remembered answer changed, without a settings edit', () => {
    const settings = new Settings(undefined, ctx.workspaceState);
    const seen: string[][] = [];
    const sub = settings.onDidChange((keys) => seen.push([...keys]));
    settings.notifyChanged(['autoSync']);
    sub.dispose();
    settings.notifyChanged(['autoSync']);
    settings.dispose();
    assert.deepEqual(seen, [['autoSync']]);
  });
});
