/**
 * Self-tests of the shared test foundation: the vscode mock, the extension-context fake, FakeSession, and the small src modules
 * the mock exercises (log, settings). Feature agents rely on these behaving like VS Code and like the bridge.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COMMAND_IDS, CONTEXT, VIEWS } from '../../src/contributes';
import { IDENTITY, settingId } from '../../src/identity';
import { Logger, createLogger, describeError } from '../../src/log';
import { BoardError, initialSessionState, isBoardError, userMessage, type SessionEvent } from '../../src/types/session';
import { PortMemory, Settings, normalizeRootPath } from '../../src/types/settings';
import { FakeSession, dec, enc } from '../mocks/fakeSession';
import { TempDirs, WINDOWS, expectRejects, makeTrickyDir } from '../mocks/fixtures';
import { createExtensionContext, createTestLogger, mock } from '../mocks/vscode';

const dirs = new TempDirs();
beforeEach(() => mock.reset());
afterEach(() => {
  mock.reset();
  dirs.cleanup();
});

describe('mock: Uri', () => {
  it('uses Windows rules for Windows-shaped paths on any host', () => {
    const u = vscode.Uri.file(WINDOWS.mainPy);
    assert.equal(u.fsPath, 'c:\\Users\\Student Name\\OneDrive - Example University\\Documents\\Lab Course (Fall)\\Lab 1\\main.py');
    assert.ok(u.path.startsWith('/C:/Users/Student Name/'));
    assert.equal(vscode.Uri.file(WINDOWS.unc).fsPath, WINDOWS.unc);
    const joined = vscode.Uri.joinPath(vscode.Uri.file(WINDOWS.workspace), 'src', 'a.py');
    assert.ok(joined.fsPath.endsWith('\\Lab 1\\src\\a.py'));
    assert.equal(joined.fsPath, vscode.Uri.file(WINDOWS.nestedPy).fsPath);
  });

  it('encodes spaces, parentheses and non-ASCII in toString and round-trips through parse', () => {
    const p = '/Users/s/OneDrive (x)/Lab 1/d\u00e9j\u00e0 \u4e2d.py';
    const u = vscode.Uri.file(p);
    assert.equal(u.fsPath, p);
    assert.match(u.toString(), /^file:\/\/\/Users\/s\/OneDrive%20%28x%29\/Lab%201\/d%C3%A9j%C3%A0%20%E4%B8%AD\.py$/);
    assert.equal(vscode.Uri.parse(u.toString()).fsPath, p);
    assert.equal(vscode.Uri.file('C:\\a b\\c').toString(), 'file:///c%3A/a%20b/c');
  });
});

describe('mock: events and commands', () => {
  it('collects listener errors and fails reset() unless they were taken', () => {
    const em = new vscode.EventEmitter<number>();
    em.event(() => { throw new Error('boom'); });
    em.fire(1);
    assert.equal(mock.takeListenerErrors().length, 1);
    em.fire(2);
    assert.throws(() => mock.reset(), /event listener/);
  });

  it('registers, executes, rejects duplicates and unknown ids, and handles setContext', async () => {
    const seen: unknown[][] = [];
    const d = vscode.commands.registerCommand('x.test', (...a: unknown[]) => { seen.push(a); return 42; });
    assert.equal(await vscode.commands.executeCommand('x.test', 1, 'two'), 42);
    assert.deepEqual(seen, [[1, 'two']]);
    assert.throws(() => vscode.commands.registerCommand('x.test', () => undefined), /already exists/);
    await expectRejects(vscode.commands.executeCommand('x.missing'), /not found/);
    await vscode.commands.executeCommand('setContext', CONTEXT.hasPort, true);
    assert.equal(mock.contextKeys.get(CONTEXT.hasPort), true);
    d.dispose();
    await expectRejects(vscode.commands.executeCommand('x.test'), /not found/);
  });

  it('reports declared versus registered command ids', () => {
    vscode.commands.registerCommand(COMMAND_IDS.refresh, () => undefined);
    vscode.commands.registerCommand(`${IDENTITY.prefix}.notDeclared`, () => undefined);
    const c = mock.commandContract();
    assert.equal(c.missing.includes(COMMAND_IDS.refresh), false);
    assert.equal(c.missing.length, c.declared.length - 1);
    assert.deepEqual(c.extra, [`${IDENTITY.prefix}.notDeclared`]);
  });
});

describe('mock: window', () => {
  it('only creates tree views for declared view ids and snapshots them', async () => {
    const provider: vscode.TreeDataProvider<string> = {
      getChildren: (el) => (el === undefined ? ['lib', 'main.py'] : el === 'lib' ? ['util.py'] : []),
      getTreeItem: (el) => {
        const t = new vscode.TreeItem(el, el === 'lib' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        t.contextValue = el === 'lib' ? 'dir' : 'file';
        return t;
      },
    };
    assert.throws(() => vscode.window.createTreeView('nope.view', { treeDataProvider: provider }), /No view is registered with id/);
    vscode.window.createTreeView(VIEWS.files, { treeDataProvider: provider });
    const snap = await mock.treeViews.get(VIEWS.files)?.snapshot();
    assert.deepEqual(snap, [
      { label: 'lib', contextValue: 'dir', children: [{ label: 'util.py', contextValue: 'file' }] },
      { label: 'main.py', contextValue: 'file' },
    ]);
  });

  it('answers quick picks from the script and cancels when nothing is scripted', async () => {
    const items = [{ label: 'Restart Python' }, { label: 'Reboot board' }, { label: 'Reset with RTS/DTR line' }];
    mock.answerQuickPick('Reboot board');
    assert.equal((await vscode.window.showQuickPick(items))?.label, 'Reboot board');
    mock.answerQuickPick(0);
    assert.equal((await vscode.window.showQuickPick(items))?.label, 'Restart Python');
    mock.answerQuickPick(/RTS/);
    assert.equal((await vscode.window.showQuickPick(items))?.label, 'Reset with RTS/DTR line');
    assert.equal(await vscode.window.showQuickPick(items), undefined);
    assert.equal(mock.calls.quickPicks.length, 4);
    assert.equal(mock.calls.quickPicks[3]?.scripted, false);
    mock.answerQuickPick('Typo');
    await expectRejects(vscode.window.showQuickPick(items), /not among/);
  });

  it('clicks message buttons by rule and records modal messages', async () => {
    mock.answerMessage(/Delete/, 'Delete', { level: 'warn' });
    const r = await vscode.window.showWarningMessage('Delete main.py from the board?', { modal: true, detail: 'This cannot be undone.' }, 'Delete', 'Cancel');
    assert.equal(r, 'Delete');
    assert.equal(await vscode.window.showInformationMessage('Delete? (info)', 'Delete'), undefined);
    const m = mock.messages('warn')[0];
    assert.equal(m?.modal, true);
    assert.equal(m?.detail, 'This cannot be undone.');
    mock.answerMessage('Retry?', 'Nope');
    await expectRejects(vscode.window.showErrorMessage('Retry?', 'Retry'), /not a button/);
  });

  it('runs input-box validation and treats an invalid scripted answer as cancelled', async () => {
    mock.answerInputBox('bad name');
    const v = await vscode.window.showInputBox({ prompt: 'Name', validateInput: (x) => (x.includes(' ') ? 'No spaces, please.' : undefined) });
    assert.equal(v, undefined);
    assert.equal(mock.calls.inputBoxes[0]?.validationMessage, 'No spaces, please.');
    mock.answerInputBox((o) => `${o.value ?? ''}ok.py`);
    assert.equal(await vscode.window.showInputBox({ value: 'my' }), 'myok.py');
  });

  it('records progress reports and supports cancellation', async () => {
    const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Uploading', cancellable: true }, async (p, token) => {
      p.report({ message: '1/2', increment: 50 });
      mock.calls.progress[0]?.cancel();
      return token.isCancellationRequested ? 'cancelled' : 'done';
    });
    assert.equal(outcome, 'cancelled');
    assert.deepEqual(mock.calls.progress[0]?.reports, [{ message: '1/2', increment: 50 }]);
    assert.equal(mock.calls.progress[0]?.done, true);
  });

  it('wires a Pseudoterminal: open, writes, input, sendText, close', async () => {
    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<number | void>();
    const inputs: string[] = [];
    let opened = false;
    let closedByHost = false;
    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event, onDidClose: close.event,
      open: () => { opened = true; write.fire('hello\r\n'); },
      close: () => { closedByHost = true; },
      handleInput: (d) => { inputs.push(d); write.fire(d); },
    };
    const closedNames: string[] = [];
    vscode.window.onDidCloseTerminal((t) => closedNames.push(t.name));
    const term = vscode.window.createTerminal({ name: IDENTITY.terminalName, pty });
    const mt = mock.terminals[0];
    assert.ok(mt);
    await mt.opened;
    assert.equal(opened, true);
    await mt.waitForOutput('hello');
    mt.type('x');
    term.sendText('ls');
    assert.deepEqual(inputs, ['x', 'ls\r']);
    assert.deepEqual(mt.sentText, [{ text: 'ls', addNewLine: true }]);
    mt.resize(100, 30);
    assert.deepEqual(mt.dimensions, { columns: 100, rows: 30 });
    await expectRejects(mt.waitForOutput('never', 20), /never showed/);
    close.fire(0);
    assert.deepEqual(closedNames, [IDENTITY.terminalName]);
    assert.equal(mock.terminals.length, 0);
    assert.equal(closedByHost, false);
    write.dispose();
    close.dispose();
  });

  it('tracks status bar items and output channels', () => {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.text = '$(plug) COM3';
    item.show();
    const ch = vscode.window.createOutputChannel(IDENTITY.outputChannelName);
    ch.appendLine('a');
    ch.append('b');
    ch.append('c\nd');
    assert.equal(mock.statusBarItems[0]?.visible, true);
    assert.deepEqual(mock.outputChannels[0]?.lines, ['a', 'bc']);
    assert.equal(mock.outputChannels[0]?.text, 'a\nbc\nd');
  });
});

describe('mock: workspace', () => {
  it('layers configuration (default, user, workspace), validates updates and respects Restricted Mode', async () => {
    const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(IDENTITY.prefix);
    assert.equal(cfg().get('autoSync'), 'on', 'the default (D-21)');
    assert.equal(cfg().get('missing', 'fallback'), 'fallback');
    mock.config.set(settingId('autoSync'), 'on', vscode.ConfigurationTarget.Global);
    assert.equal(cfg().get('autoSync'), 'on');
    mock.config.set(settingId('autoSync'), 'off');
    assert.equal(cfg().get('autoSync'), 'off');
    const changes: boolean[] = [];
    vscode.workspace.onDidChangeConfiguration((e) => changes.push(e.affectsConfiguration(settingId('autoSync')), e.affectsConfiguration('files')));
    await cfg().update('autoSync', 'ask');
    assert.deepEqual(changes, [true, false]);
    await expectRejects(cfg().update('typo', 1), /not a registered configuration/);
    mock.config.set(settingId('pythonPath'), '/from/workspace/python');
    assert.equal(cfg().get('pythonPath'), '/from/workspace/python');
    mock.setTrusted(false);
    assert.equal(cfg().get('pythonPath'), '', 'restricted settings ignore the workspace layer when untrusted');
    assert.equal(cfg().get('autoSync'), 'ask');
    assert.equal(mock.config.updates.length, 1);
  });

  it('reads and writes real files with parent folders, difficult paths and FileSystemError codes', async () => {
    const ws = makeTrickyDir(dirs.make());
    const file = vscode.Uri.file(path.join(ws, 'src', 'a.py'));
    await vscode.workspace.fs.writeFile(file, enc('print(1)\n'));
    assert.equal(dec(await vscode.workspace.fs.readFile(file)), 'print(1)\n');
    assert.equal((await vscode.workspace.fs.stat(file)).type, vscode.FileType.File);
    assert.deepEqual(await vscode.workspace.fs.readDirectory(vscode.Uri.file(ws)), [['src', vscode.FileType.Directory]]);
    await vscode.workspace.fs.delete(file);
    await expectRejects(vscode.workspace.fs.stat(file), (e) => (e as { code?: string }).code === 'FileNotFound');
    assert.ok(mock.fsLog.some((l) => l.op === 'writeFile'));
  });

  it('offers an in-memory filesystem that works with Windows-shaped URIs', async () => {
    mock.fsMode = 'memory';
    const nested = vscode.Uri.file(WINDOWS.nestedPy);
    await vscode.workspace.fs.writeFile(nested, enc('x = 1\n'));
    assert.deepEqual(await vscode.workspace.fs.readDirectory(vscode.Uri.file(WINDOWS.workspace)), [['src', vscode.FileType.Directory]]);
    assert.equal(dec(await vscode.workspace.fs.readFile(nested)), 'x = 1\n');
    await vscode.workspace.fs.rename(nested, vscode.Uri.file(WINDOWS.mainPy));
    await expectRejects(vscode.workspace.fs.stat(nested), /./);
  });

  it('opens, edits, saves and activates documents and relativises paths', async () => {
    const ws = makeTrickyDir(dirs.make());
    mock.setWorkspaceFolders(ws);
    const file = path.join(ws, 'main.py');
    fs.writeFileSync(file, 'x = 1\n');
    const saved: string[] = [];
    vscode.workspace.onDidSaveTextDocument((d) => saved.push(d.fileName));
    const doc = await mock.openDocument(vscode.Uri.file(file));
    assert.equal(doc.languageId, 'python');
    doc.setText('x = 2\n');
    assert.equal(doc.isDirty, true);
    assert.equal(await doc.save(), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'x = 2\n');
    assert.deepEqual(saved, [file]);
    await mock.openEditor(doc);
    assert.equal(vscode.window.activeTextEditor?.document.fileName, file);
    assert.equal(vscode.workspace.asRelativePath(file), 'main.py');
    assert.equal(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.index, 0);
    assert.equal(vscode.workspace.workspaceFolders?.length, 1);
  });

  it('models trust, remote windows and file watchers', () => {
    assert.equal(vscode.workspace.isTrusted, true);
    let granted = 0;
    vscode.workspace.onDidGrantWorkspaceTrust(() => granted++);
    mock.setTrusted(false);
    mock.setTrusted(true);
    assert.equal(granted, 1);
    assert.equal(vscode.env.remoteName, undefined);
    mock.setRemote('ssh-remote');
    assert.equal(vscode.env.remoteName, 'ssh-remote');
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern('/ws', '**/*.py'));
    const events: string[] = [];
    w.onDidChange((u) => events.push(u.fsPath));
    mock.watchers[0]?.fireChange(vscode.Uri.file('/ws/a.py'));
    assert.deepEqual(events, ['/ws/a.py']);
  });
});

describe('mock: extension context', () => {
  it('provides storage folders, mementos, secrets and disposes subscriptions in reverse order', async () => {
    const ctx = createExtensionContext();
    assert.ok(fs.existsSync(ctx.storageUri.fsPath));
    assert.ok(fs.existsSync(ctx.globalStorageUri.fsPath));
    assert.equal(ctx.vscode.extension.packageJSON.name, IDENTITY.extensionId);
    await ctx.workspaceState.update('k', 1);
    assert.equal(ctx.workspaceState.get('k'), 1);
    assert.equal(ctx.workspaceState.get('missing', 7), 7);
    await ctx.secrets.store('s', 'v');
    assert.equal(await ctx.secrets.get('s'), 'v');
    const order: number[] = [];
    ctx.subscriptions.push({ dispose: () => order.push(1) }, { dispose: () => order.push(2) });
    const storage = ctx.storageUri.fsPath;
    ctx.dispose();
    assert.deepEqual(order, [2, 1]);
    assert.equal(fs.existsSync(storage), false);
  });
});

describe('src/log.ts', () => {
  it('filters by level, tags scopes, shares the level with children and reveals the channel', () => {
    const log = createLogger(vscode.window, IDENTITY.outputChannelName, 'info');
    const ch = mock.outputChannels[0];
    assert.equal(ch?.name, IDENTITY.outputChannelName);
    log.debug('hidden');
    log.info('shown');
    const child = log.child('bridge');
    child.warn('careful', Object.assign(new Error('port busy'), { code: 'E_PORT_BUSY' }));
    log.setLevel('debug');
    child.debug('now visible');
    log.show();
    assert.equal(ch?.lines.length, 3);
    assert.match(ch?.lines[0] ?? '', /^\d\d:\d\d:\d\d\.\d{3} INFO  shown$/);
    assert.match(ch?.lines[1] ?? '', /WARN  \[bridge\] careful \(\[E_PORT_BUSY\] port busy\)$/);
    assert.match(ch?.lines[2] ?? '', /DEBUG \[bridge\] now visible$/);
    assert.equal(ch?.shown, 1);
    log.dispose();
    log.error('after dispose');
    assert.equal(ch?.disposed, true);
    assert.equal(ch?.lines.length, 3);
    assert.equal(describeError('plain'), 'plain');
  });

  it('has a test double that needs no vscode API', () => {
    const { log, channel } = createTestLogger('info');
    log.error('failed', new Error('boom'));
    assert.match(channel.text, /ERROR failed \(boom\)/);
    assert.ok(log instanceof Logger);
  });
});

describe('src/types/settings.ts', () => {
  it('reads typed defaults from the same table that generates package.json', () => {
    const s = new Settings();
    assert.deepEqual(
      [s.autoSync, s.syncDebounceMs, s.rootPath, s.pythonPath, s.portOverride, s.runFreshStart, s.showUnverifiedHardReset, s.stopOnDisconnect, s.stopOnTerminalClose, s.logLevel],
      ['on', 400, '/', '', '', true, false, true, true, 'info'],
    );
  });

  it('coerces bad values and never returns auto as a port', () => {
    const s = new Settings();
    mock.config.set(settingId('autoSync'), 'sometimes');
    mock.config.set(settingId('port'), ' AUTO ');
    mock.config.set(settingId('sync.debounceMs'), 5);
    mock.config.set(settingId('logLevel'), 'loud');
    assert.deepEqual([s.autoSync, s.portOverride, s.syncDebounceMs, s.logLevel], ['on', '', 100, 'info'], 'an unknown auto-sync value means the default');
    mock.config.set(settingId('port'), 'COM12');
    assert.equal(s.portOverride, 'COM12');
  });

  it('normalises the board root path', () => {
    assert.equal(normalizeRootPath('/lib/'), '/lib');
    assert.equal(normalizeRootPath('\\lib\\sub'), '/lib/sub');
    assert.equal(normalizeRootPath('lib'), '/');
    assert.equal(normalizeRootPath('/a/../b'), '/');
    assert.equal(normalizeRootPath('   '), '/');
    assert.equal(normalizeRootPath('/'), '/');
  });

  it('reports changed keys, refuses to write auto and ignores restricted values when untrusted', async () => {
    const s = new Settings();
    const seen: string[][] = [];
    s.onDidChange((keys) => seen.push([...keys]));
    await s.update('autoSync', 'on');
    assert.deepEqual(seen, [['autoSync']]);
    assert.equal(s.autoSync, 'on');
    await expectRejects(s.update('port', 'auto'), /cannot be "auto"/);
    mock.config.set(settingId('pythonPath'), '/evil/python');
    mock.setTrusted(false);
    assert.equal(s.pythonPath, '');
  });

  it('remembers a port in workspaceState, never auto', async () => {
    const ctx = createExtensionContext();
    const mem = new PortMemory(ctx.workspaceState);
    assert.equal(mem.get(), null);
    await mem.remember({ device: '/dev/cu.usbserial-0001', vid: 0x10c4, pid: 0xea60 });
    assert.deepEqual(mem.get(), { device: '/dev/cu.usbserial-0001', vid: 0x10c4, pid: 0xea60 });
    await expectRejects(Promise.resolve(mem.remember({ device: 'auto', vid: null, pid: null })), /not "auto"/);
    await mem.forget();
    assert.equal(mem.get(), null);
    ctx.dispose();
  });
});

describe('FakeSession', () => {
  it('connects, records state changes and refuses auto', async () => {
    const s = new FakeSession();
    const states: string[] = [];
    const events: SessionEvent[] = [];
    s.onDidChangeState((st) => states.push(st.state));
    s.onEvent((e) => events.push(e));
    await expectRejects(s.connect('auto'), (e) => isBoardError(e, 'E_PROTOCOL'));
    assert.equal(s.calls.length, 0);
    const res = await s.connect('COM12', { vid: 0x10c4, pid: 0xea60 });
    assert.equal(res.state, 'idle');
    assert.equal(s.selectedPort, 'COM12');
    assert.equal(s.state.port, 'COM12');
    assert.deepEqual(states, ['connecting', 'idle']);
    assert.deepEqual(events.map((e) => (e.ev === 'state' ? e.state : e.ev)), ['connecting', 'idle']);
    await s.disconnect();
    assert.equal(s.state.state, 'disconnected');
    assert.equal(s.selectedPort, 'COM12', 'the selection survives a disconnect');
    s.selectPort(null);
    assert.equal(s.selectedPort, null);
  });

  it('keeps the selection and goes back to disconnected when connect fails', async () => {
    const s = new FakeSession();
    s.fail('connect', 'E_PORT_BUSY', 'Another program is using this port.', { hint: 'Close Thonny and retry.' });
    await expectRejects(s.connect('COM3'), (e) => isBoardError(e, 'E_PORT_BUSY') && e.hint === 'Close Thonny and retry.');
    assert.equal(s.state.state, 'disconnected');
    assert.equal(s.selectedPort, 'COM3');
  });

  it('answers E_NOT_CONNECTED, scripted, once and fallthrough responders, and E_UNSUPPORTED for the unscripted', async () => {
    const s = new FakeSession();
    await expectRejects(s.call('fs.list', { path: '/' }), (e) => isBoardError(e, 'E_NOT_CONNECTED'));
    s.setState({ state: 'idle', port: '/dev/cu.fake' });
    await expectRejects(s.call('fs.list', { path: '/' }), (e) => isBoardError(e, 'E_UNSUPPORTED') && /script/.test(e.message));
    s.script('fs.list', { entries: [{ name: 'main.py', type: 'file', size: 3 }] });
    s.scriptOnce('fs.list', { entries: [] });
    assert.deepEqual((await s.call('fs.list', { path: '/' })).entries, []);
    assert.equal((await s.call('fs.list', { path: '/' })).entries.length, 1);
    s.script('stop', async (_a, ctx) => ({ ...(await ctx.fallthrough() as { stopped: boolean; ms: number }), ms: 7 }));
    assert.deepEqual(await s.call('stop', {}), { stopped: true, ms: 7 });
    assert.equal(s.argsOf('fs.list').length, 4, 'rejected calls are recorded too');
  });

  it('streams events from a run and returns the program to idle', async () => {
    const s = FakeSession.connected();
    const seen: string[] = [];
    s.onEvent((e) => { seen.push(e.ev === 'out' ? dec(e.bytes) : e.ev === 'state' ? `state:${e.state}` : e.ev); });
    s.script('run', async (_a, ctx) => {
      ctx.emit({ ev: 'out', bytes: enc('hello\r\n') });
      assert.equal(ctx.session.isRunning, true);
      return { exit: 'ok', durationMs: 3 };
    });
    assert.deepEqual(await s.call('run', { source: 'print("hello")' }), { exit: 'ok', durationMs: 3 });
    assert.deepEqual(seen, ['state:running', 'hello\r\n', 'state:idle']);
    assert.equal(s.isRunning, false);
  });

  it('models the program-running gate: needs_interrupt first, then interrupt:true succeeds', async () => {
    const s = FakeSession.connected({ state: 'running' });
    s.script('fs.stat', { exists: false });
    await expectRejects(s.call('fs.stat', { path: '/main.py' }), (e) => isBoardError(e, 'E_PROGRAM_RUNNING') && e.needsInterrupt && e.body.sync === 'running-program');
    await s.call('fs.stat', { path: '/main.py', interrupt: true });
    assert.equal(s.callsOf('fs.stat')[1]?.interrupted, true);
    assert.equal(s.state.state, 'idle');
  });

  it('holds calls, times out and aborts', async () => {
    const s = FakeSession.connected();
    const gate = s.hold('fs.stat');
    const slow = s.call('fs.stat', { path: '/' }, { timeoutMs: 25 });
    assert.equal((await gate.arrived).op, 'fs.stat');
    await expectRejects(slow, (e) => isBoardError(e, 'E_CALL_TIMEOUT'));
    gate.release();
    const ac = new AbortController();
    const gate2 = s.hold('stop');
    const p = s.call('stop', {}, { signal: ac.signal });
    await gate2.arrived;
    ac.abort();
    await expectRejects(p, (e) => isBoardError(e, 'E_ABORTED'));
    assert.equal(s.callsOf('stop')[0]?.aborted, true);
    gate2.fail(BoardError.of('E_CANCELLED', 'cancelled'));
  });

  it('keeps tty.write bytes and the pending sync count', async () => {
    const s = FakeSession.connected();
    const counts: number[] = [];
    s.onDidChangeState((st) => counts.push(st.pendingSyncCount));
    s.setPendingSyncCount(3);
    assert.equal(s.pendingSyncCount, 3);
    assert.deepEqual(counts, [3]);
    await s.call('tty.write', { b64: Buffer.from('\x03').toString('base64') });
    assert.deepEqual([...(s.ttyWrites[0] ?? [])], [3]);
  });

  it('hosts an in-memory board filesystem for sync tests, with difficult local paths', async () => {
    const s = FakeSession.connected();
    const board = s.useBoardFs({ '/main.py': 'print(1)\n', '/lib/util.py': 'X = 1\n' });
    const local = path.join(makeTrickyDir(dirs.make()), 'd\u00e9j\u00e0 vu (1).py');
    fs.writeFileSync(local, 'print("local")\n');
    const put = await s.call('fs.put', { local, remote: '/src/d\u00e9j\u00e0 vu (1).py' });
    assert.equal(put.skipped, false);
    assert.equal(board.read('/src/d\u00e9j\u00e0 vu (1).py'), 'print("local")\n');
    const again = await s.call('fs.put', { local, remote: '/src/d\u00e9j\u00e0 vu (1).py', expectSha: put.sha256 });
    assert.equal(again.skipped, true);
    const man = await s.call('fs.manifest', { root: '/' });
    assert.deepEqual(man.entries.filter((e) => e.type === 'file').map((e) => e.path), ['/lib/util.py', '/main.py', '/src/d\u00e9j\u00e0 vu (1).py']);
    assert.equal(man.entries.find((e) => e.path === '/main.py')?.sha256, board.fileHash('/main.py'));
    const back = path.join(path.dirname(local), 'back', 'main.py');
    await s.call('fs.get', { remote: '/main.py', local: back });
    assert.equal(fs.readFileSync(back, 'utf8'), 'print(1)\n');
    assert.deepEqual((await s.call('fs.list', { path: '/' })).entries.map((e) => e.name), ['lib', 'main.py', 'src']);
    await s.call('fs.mv', { src: '/main.py', dst: '/lib/main.py' });
    await expectRejects(s.call('fs.mv', { src: '/lib/util.py', dst: '/lib/main.py' }), (e) => isBoardError(e, 'E_FS_ERRNO') && e.detail === 'EEXIST');
    await expectRejects(s.call('fs.rm', { path: '/gone.py' }), (e) => isBoardError(e, 'E_FS_ERRNO') && e.detail === 'ENOENT');
    assert.equal((await s.call('fs.rmtree', { path: '/lib', confirm: true })).removed, 3);
    assert.deepEqual(board.paths(), ['/src', '/src/d\u00e9j\u00e0 vu (1).py']);
  });

  it('turns any thrown value into a message for the student', () => {
    assert.equal(userMessage(BoardError.of('E_PORT_BUSY', 'Another program is using the port.', { hint: 'Close Thonny and retry.' })), 'Another program is using the port. Close Thonny and retry.');
    assert.equal(userMessage(BoardError.of('E_NO_DEVICE', 'The board was unplugged.', { hint: 'The board was unplugged.' })), 'The board was unplugged.');
    assert.equal(userMessage(new Error('plain')), 'plain');
    assert.equal(userMessage('text'), 'text');
    assert.equal(initialSessionState().interpreter, 'unknown');
  });

  it('rejects after dispose', async () => {
    const s = FakeSession.connected();
    s.dispose();
    await expectRejects(s.call('ping', {}), (e) => isBoardError(e, 'E_BRIDGE_EXITED'));
  });
});
