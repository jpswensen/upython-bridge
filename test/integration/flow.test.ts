/**
 * End-to-end flow of the whole extension through the mocked `vscode`: activate(), then what a student does, against the REAL
 * Python bridge and a REAL fake board (tools/fakeboard.py on a loopback socket; never a serial port; MPY_SAFE_MODE=1).
 *
 *   select port -> connect -> see the board files -> upload a file -> run it (output in the terminal) -> run a loop and press
 *   Stop -> deactivate (the bridge process ends).
 *
 * The board is chosen with the documented `port` setting. A socket:// URL is accepted there only because the bridge itself
 * refuses everything but loopback sockets in safe mode and production code never lists URLs in the port picker.
 * Run alone with: npm run test:integration. Skipped, with the reason, when no Python >= 3.9 is available.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';
import { COMMAND_IDS, VIEWS } from '../../src/contributes';
import { IDENTITY } from '../../src/identity';
import { integrationSkipReason, startFakeBoard, stopAll, testPython, type FakeBoardHandle } from '../mocks/fakeBridge';
import { createExtensionContext, type MockExtensionContext } from '../mocks/extensionContext';
import { TempDirs } from '../mocks/fixtures';
import { mock } from '../mocks/vscode';

const skip = integrationSkipReason();
const dirs = new TempDirs();
let ctx: MockExtensionContext | undefined;
let board: FakeBoardHandle | undefined;

beforeEach(() => {
  mock.reset();
  process.env.MPY_SAFE_MODE = '1'; // the extension's bridge inherits this: it then refuses anything but loopback sockets
  delete process.env.MPY_REAL_PORT;
});

afterEach(async () => {
  ctx?.dispose(); // what VS Code does after deactivate(): the Teardown stops the bridge
  ctx = undefined;
  await board?.stop();
  board = undefined;
  await stopAll();
  dirs.cleanup();
  mock.reset();
});

function absolutePython(): string {
  const python = testPython();
  assert.ok(python, 'a Python is available');
  const r = spawnSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000 });
  return r.stdout.trim();
}

/** Bridge processes whose command line mentions `marker` (this test's private pycache folder). Empty on Windows (not checked). */
function bridgeProcesses(marker: string): string[] {
  if (process.platform === 'win32') { return []; }
  const r = spawnSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000 });
  return r.stdout.split('\n').filter((line) => line.includes('mpy_bridge.py') && line.includes(marker));
}

const settle = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(pred: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
    await settle(25);
  }
}

describe('the whole extension against the real bridge and a fake board', { skip }, () => {
  it('select port, connect, list files, upload, run, stop, deactivate', { timeout: 120000 }, async () => {
    // --- a project folder with awkward characters, a board whose filesystem is a host folder with one file on it
    const lab = path.join(dirs.make('upy-bridge-flow'), 'ME 241 (Fall)', 'Lab 1 – café');
    fs.mkdirSync(lab, { recursive: true });
    fs.writeFileSync(path.join(lab, 'main.py'), 'print("main uploaded")\n');
    fs.writeFileSync(path.join(lab, 'hello.py'), 'import sys\nprint("hello from the board")\nprint("café ✓")\n');
    fs.writeFileSync(path.join(lab, 'spin.py'), 'import time\nwhile True:\n    print("tick")\n    time.sleep(0.1)\n');
    const boardRoot = dirs.make('upy-bridge-board');
    fs.writeFileSync(path.join(boardRoot, 'boot.py'), '# boot\n');
    board = await startFakeBoard({ profile: 'esp32', root: boardRoot });

    mock.setWorkspaceFolders(lab);
    mock.config.set(`${IDENTITY.prefix}.pythonPath`, absolutePython());
    mock.config.set(`${IDENTITY.prefix}.port`, board.url);
    mock.config.set(`${IDENTITY.prefix}.autoSync`, 'off'); // no first-connect question in this flow
    ctx = createExtensionContext();
    const marker = ctx.globalStorageUri.fsPath;

    // --- activation starts nothing
    activate(ctx.vscode);
    await settle(50);
    assert.deepEqual(bridgeProcesses(marker), [], 'no bridge before the first use');
    const boardItem = mock.statusBarItems.find((i) => i.id === `${IDENTITY.prefix}.board`);
    assert.ok(boardItem);

    // --- select the port (the setting names it) and connect
    const connected = await vscode.commands.executeCommand<boolean>(COMMAND_IDS.selectPort, { reuse: true });
    assert.equal(connected, true, `connected; errors: ${mock.messages('error').map((m) => m.message).join(' | ')}`);
    assert.equal(bridgeProcesses(marker).length, 1, 'exactly one bridge process now');
    await waitFor(() => /Ready/.test(boardItem.text), 'the status bar to say Ready');
    assert.deepEqual(ctx.workspaceState.get(`${IDENTITY.prefix}.rememberedPort`), { device: board.url, vid: null, pid: null });
    assert.ok(!mock.config.updates.some((u) => String(u.value).toLowerCase() === 'auto'), 'auto is never written');

    // --- the Files view shows what is on the board
    const filesView = mock.treeViews.get(VIEWS.files);
    assert.ok(filesView);
    await vscode.commands.executeCommand(COMMAND_IDS.refresh);
    let labels: string[] = [];
    await waitFor(() => {
      void Promise.resolve(filesView.provider.getChildren(undefined)).then(async (nodes) => {
        const items = await Promise.all((nodes ?? []).map((n) => Promise.resolve(filesView.provider.getTreeItem(n as never))));
        labels = items.map((i) => String(i.label));
      });
      return labels.includes('boot.py');
    }, 'boot.py in the Files view');

    // --- upload the open file
    await mock.openEditor(path.join(lab, 'main.py'));
    await vscode.commands.executeCommand(COMMAND_IDS.uploadActiveFile);
    assert.equal(fs.readFileSync(path.join(boardRoot, 'main.py'), 'utf8'), 'print("main uploaded")\n');

    // --- run a program: its output appears in the terminal
    await mock.openEditor(path.join(lab, 'hello.py'));
    await vscode.commands.executeCommand(COMMAND_IDS.runActiveFile);
    const terminal = mock.terminals.find((t) => t.name === IDENTITY.terminalName);
    assert.ok(terminal, 'the Run tab exists');
    await terminal.waitForOutput('hello from the board', 20000);
    await terminal.waitForOutput('café ✓', 5000);
    await terminal.waitForOutput('[program finished]', 20000);
    assert.deepEqual(terminal.sentText, [], 'no command was ever typed into a terminal');

    // --- run a loop and press Stop
    await mock.openEditor(path.join(lab, 'spin.py'));
    const running = Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile));
    await terminal.waitForOutput('tick', 20000);
    await vscode.commands.executeCommand(COMMAND_IDS.stop);
    await running;
    await terminal.waitForOutput('[program stopped]', 20000);
    await waitFor(() => /Ready/.test(boardItem.text), 'the board to be ready again after Stop');
    assert.deepEqual(mock.messages('error'), [], 'no error was shown in the whole flow');

    // --- deactivate: the bridge process ends and everything is released
    deactivate();
    ctx.dispose();
    ctx = undefined;
    await waitFor(() => bridgeProcesses(marker).length === 0, 'the bridge process to end', 15000);
    assert.deepEqual(mock.commandContract().registered, []);
    assert.deepEqual(mock.takeListenerErrors(), []);
  });

  it('auto-sync (on by default, D-21): an empty project and an empty board need no review; a saved file reaches the board by itself (and nothing else does)', { timeout: 120000 }, async () => {
    const lab = path.join(dirs.make('upy-bridge-flow'), 'ME 241 (Fall)', 'Lab 2 \u2013 caf\u00e9');
    fs.mkdirSync(path.join(lab, 'lib'), { recursive: true });
    const boardRoot = dirs.make('upy-bridge-board');
    board = await startFakeBoard({ profile: 'esp32', root: boardRoot });
    mock.setWorkspaceFolders(lab);
    mock.config.set(`${IDENTITY.prefix}.pythonPath`, absolutePython());
    mock.config.set(`${IDENTITY.prefix}.port`, board.url); // autoSync stays at its default: on (D-21)
    ctx = createExtensionContext();
    activate(ctx.vscode);
    assert.equal(await vscode.commands.executeCommand<boolean>(COMMAND_IDS.selectPort, { reuse: true }), true);

    // The comparison at connect finds nothing to decide (both sides empty): the board is reviewed silently, no question at all.
    const reviewed = (): boolean => (ctx?.workspaceState.keys() ?? []).some((k) => k.startsWith(`${IDENTITY.prefix}.sync.reviewed.`) && ctx?.workspaceState.get(k) === true);
    await waitFor(reviewed, 'the silent first-sync review');
    assert.equal(mock.messages().filter((m) => /never synced with this project folder|Copy your files/.test(m.message)).length, 0);
    assert.deepEqual(mock.config.updates, [], 'nothing is written to the settings');
    assert.deepEqual(fs.readdirSync(boardRoot), [], 'connecting uploaded nothing');

    // Saving a file uploads that file, with its awkward name, into the matching board folder.
    const saved = vscode.Uri.file(path.join(lab, 'lib', 'util (v2).py'));
    fs.writeFileSync(saved.fsPath, ''); // the editor opens an existing file, the student then types and saves
    await mock.saveFile(saved, 'x = 1\n');
    const onBoard = path.join(boardRoot, 'lib', 'util (v2).py');
    await waitFor(() => fs.existsSync(onBoard), 'the saved file to arrive on the board');
    assert.equal(fs.readFileSync(onBoard, 'utf8'), 'x = 1\n');
    const autoItem = mock.statusBarItems.find((i) => i.id === `${IDENTITY.prefix}.autoSync`);
    assert.ok(autoItem && /Auto-sync: On/.test(autoItem.text), `auto-sync indicator: ${autoItem?.text ?? '(missing)'}`);
    await waitFor(() => /Auto-sync: On$/.test(autoItem.text), 'no files left waiting');

    // A file that the default rules ignore never goes to the board.
    fs.mkdirSync(path.join(lab, '.venv'), { recursive: true });
    fs.writeFileSync(path.join(lab, '.venv', 'pyvenv.cfg'), '');
    await mock.saveFile(vscode.Uri.file(path.join(lab, '.venv', 'pyvenv.cfg')), 'home = /usr\n');
    await settle(400);
    assert.ok(!fs.existsSync(path.join(boardRoot, '.venv')), 'ignored files stay local');
    assert.deepEqual(mock.messages('error'), []);
  });

  it('uploading a file while a program runs asks once, stops the program, and then uploads', { timeout: 90000 }, async () => {
    const lab = path.join(dirs.make('upy-bridge-flow'), 'Lab 3 (spin)');
    fs.mkdirSync(lab, { recursive: true });
    fs.writeFileSync(path.join(lab, 'spin.py'), 'import time\nwhile True:\n    print("tick")\n    time.sleep(0.1)\n');
    fs.writeFileSync(path.join(lab, 'data.py'), 'VALUE = 42\n');
    const boardRoot = dirs.make('upy-bridge-board');
    board = await startFakeBoard({ profile: 'esp32', root: boardRoot });
    mock.setWorkspaceFolders(lab);
    mock.config.set(`${IDENTITY.prefix}.pythonPath`, absolutePython());
    mock.config.set(`${IDENTITY.prefix}.port`, board.url);
    mock.config.set(`${IDENTITY.prefix}.autoSync`, 'off');
    mock.answerMessage(/still running/, 'Stop the program and continue');
    ctx = createExtensionContext();
    activate(ctx.vscode);
    assert.equal(await vscode.commands.executeCommand<boolean>(COMMAND_IDS.selectPort, { reuse: true }), true);

    await mock.openEditor(path.join(lab, 'spin.py'));
    const running = Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile));
    await waitFor(() => mock.terminals.some((t) => t.name === IDENTITY.terminalName), 'the Run tab to open');
    const terminal = mock.terminals.find((t) => t.name === IDENTITY.terminalName);
    assert.ok(terminal);
    await terminal.waitForOutput('tick', 20000);

    await mock.openEditor(path.join(lab, 'data.py'));
    await vscode.commands.executeCommand(COMMAND_IDS.uploadActiveFile);
    assert.equal(fs.readFileSync(path.join(boardRoot, 'data.py'), 'utf8'), 'VALUE = 42\n');
    assert.equal(mock.messages('warn').filter((m) => /still running/.test(m.message)).length, 1, 'asked exactly once');
    await running;
    assert.deepEqual(mock.messages('error'), []);
  });
});
