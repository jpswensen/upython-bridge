/**
 * Status bar: board item text per state, tooltip with the board's identity, click targets, spinner and warning colour,
 * the auto-sync item (mode, pending count, visibility), and cleanup. Mocked `vscode` + FakeSession.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../../src/contributes';
import { IDENTITY, settingId } from '../../src/identity';
import type { Services } from '../../src/types/services';
import { Settings, PortMemory } from '../../src/types/settings';
import { StatusBar, boardStatus, identityLine, isPortBusy, registerStatusBar } from '../../src/statusbar';
import { summarize } from '../../src/views/sessionView';
import { FAKE_IDENTITY, FakeSession } from '../mocks/fakeSession';
import { TempDirs, WINDOWS } from '../mocks/fixtures';
import type { MockExtensionContext } from '../mocks/extensionContext';
import { createExtensionContext, createTestLogger, mock, type MockStatusBarItem } from '../mocks/vscode';

const dirs = new TempDirs();
let ctx: MockExtensionContext;
let toDispose: { dispose(): unknown }[] = [];

beforeEach(() => {
  mock.reset();
  ctx = createExtensionContext();
});
afterEach(() => {
  toDispose.splice(0).reverse().forEach((d) => d.dispose());
  toDispose = [];
  ctx.dispose();
  dirs.cleanup();
  mock.reset();
});

interface Items { board: MockStatusBarItem; autoSync: MockStatusBarItem; session: FakeSession; bar: StatusBar }

function setup(session: FakeSession = new FakeSession()): Items {
  toDispose.push(session);
  const bar = new StatusBar(session, new Settings());
  toDispose.push(bar);
  const board = mock.statusBarItems.find((i) => i.id === `${IDENTITY.prefix}.board`);
  const autoSync = mock.statusBarItems.find((i) => i.id === `${IDENTITY.prefix}.autoSync`);
  assert.ok(board && autoSync, 'both status bar items were created');
  return { board, autoSync, session, bar };
}

const tip = (item: MockStatusBarItem): string => String(item.tooltip);
// The real ThemeColor type hides `id`; the mock keeps it so tests can see which colour was asked for.
const bg = (item: MockStatusBarItem): string | undefined => (item.backgroundColor as { id?: string } | undefined)?.id;

describe('status bar: board item', () => {
  it('shows "No board" with a click that selects a port when nothing is selected', () => {
    const { board } = setup();
    assert.equal(board.text, '$(plug) No board');
    assert.equal(board.command, COMMAND_IDS.selectPort);
    assert.match(tip(board), /Plug your board into a USB port/);
    assert.equal(board.visible, true);
    assert.equal(board.alignment, vscode.StatusBarAlignment.Left);
    assert.equal(bg(board), undefined);
  });

  it('shows the selected port and "Not connected" after selecting without connecting (Windows COM name by injection)', () => {
    const { board, session } = setup();
    session.selectPort(WINDOWS.comPort);
    assert.equal(board.text, '$(plug) COM12 - Not connected');
    assert.match(tip(board), /Not connected to COM12\. Click to connect/);
  });

  it('shows a spinner while connecting', async () => {
    const { board, session } = setup();
    const gate = session.hold('connect');
    const connecting = session.connect('/dev/cu.fake');
    await gate.arrived;
    assert.equal(board.text, '$(sync~spin) /dev/cu.fake - Connecting');
    assert.match(tip(board), /Connecting to \/dev\/cu\.fake/);
    gate.release();
    await connecting;
    assert.equal(board.text, '$(plug) /dev/cu.fake - Ready');
  });

  it('shows Ready with the board identity in the tooltip, Running, and a spinner while the bridge works', () => {
    const { board, session } = setup(FakeSession.connected());
    assert.equal(board.text, '$(plug) /dev/cu.fake - Ready');
    assert.deepEqual(tip(board).split('\n'), [
      'Generic ESP32 module with ESP32, MicroPython 1.29.0',
      'Port: /dev/cu.fake',
      'Connected and waiting for you. Click to choose a different port.',
    ]);
    assert.equal(board.command, COMMAND_IDS.selectPort);

    session.setState({ state: 'running' });
    assert.equal(board.text, '$(play) /dev/cu.fake - Running');
    assert.match(tip(board), /Press Stop in Board Actions/);

    session.setState({ state: 'rawop' });
    assert.equal(board.text, '$(sync~spin) /dev/cu.fake - Working');
  });

  it('puts the build name from the identity probe in the tooltip, and copes with a missing identity', () => {
    const identity = { ...FAKE_IDENTITY, build: 'LAB_BOARD_V2' };
    const { board, session } = setup(FakeSession.connected({ identity }));
    assert.equal(tip(board).split('\n')[1], 'Build: LAB_BOARD_V2');
    session.setState({ identity: null });
    assert.deepEqual(tip(board).split('\n'), ['Port: /dev/cu.fake', 'Connected and waiting for you. Click to choose a different port.']);
  });

  it('names other firmware as the board reports it', () => {
    assert.equal(identityLine({ ...FAKE_IDENTITY, impl: 'circuitpython', version: [9, 1, 0], machine: 'Pico' }), 'Pico, circuitpython 9.1.0');
    assert.equal(identityLine({ ...FAKE_IDENTITY, impl: '', machine: '' }), '1.29.0');
  });

  it('warns in the warning colour when another program holds the port, with the one-line fix, and recovers', async () => {
    const { board, session } = setup();
    session.selectPort('COM3');
    session.setState({ state: 'disconnected', port: null, reason: 'E_PORT_BUSY' });
    assert.equal(board.text, '$(warning) COM3 - In use');
    assert.equal(bg(board), 'statusBarItem.warningBackground');
    assert.match(tip(board), /COM3 is in use by another program\. Close Thonny, other VS Code windows or terminals/);
    assert.equal(board.command, COMMAND_IDS.selectPort, 'a click tries again');

    await session.connect('COM3');
    assert.equal(board.text, '$(plug) COM3 - Ready');
    assert.equal(bg(board), undefined, 'the warning colour is cleared');
  });

  it('recognises the busy port from a free-text reason, only while disconnected', () => {
    const base = FakeSession.connected().state;
    assert.equal(isPortBusy({ ...base, state: 'disconnected', reason: 'connect failed: port busy' }), true);
    assert.equal(isPortBusy({ ...base, state: 'disconnected', reason: 'port-busy' }), true);
    assert.equal(isPortBusy({ ...base, state: 'disconnected', reason: 'unplugged' }), false);
    assert.equal(isPortBusy({ ...base, state: 'idle', reason: 'E_PORT_BUSY' }), false);
  });

  it('says "Unplugged" when the board was unplugged', () => {
    const { board, session } = setup(FakeSession.connected());
    session.setState({ state: 'disconnected', port: null, reason: 'unplugged' });
    session.selectPort('/dev/cu.fake');
    assert.equal(board.text, '$(plug) /dev/cu.fake - Unplugged');
    assert.match(tip(board), /was unplugged\. Plug it back in/);
    assert.equal(bg(board), undefined);
  });

  it('points to the Doctor when Python does not work, and returns to the port afterwards', () => {
    const { board, session } = setup();
    session.setState({ interpreter: 'problem' });
    assert.equal(board.text, '$(warning) Python problem');
    assert.equal(board.command, COMMAND_IDS.doctor);
    assert.equal(bg(board), 'statusBarItem.warningBackground');
    assert.match(tip(board), /Click to open the Doctor/);
    session.setState({ interpreter: 'ok' });
    assert.equal(board.text, '$(plug) No board');
    assert.equal(board.command, COMMAND_IDS.selectPort);
  });

  it('uses the port from the settings when none was selected, never the word auto', () => {
    const { board } = setup();
    mock.config.set(settingId('port'), 'COM7');
    assert.equal(board.text, '$(plug) COM7 - Not connected');
    mock.config.set(settingId('port'), 'auto');
    assert.equal(board.text, '$(plug) No board');
  });

  it('has a name and an id from the product identity, for the status bar context menu', () => {
    const { board, autoSync } = setup();
    assert.equal(board.name, `${IDENTITY.shortName} board`);
    assert.equal(autoSync.name, `${IDENTITY.shortName} auto-sync`);
    assert.equal(board.id, `${IDENTITY.prefix}.board`);
  });

  it('boardStatus is a pure function of the state (table)', () => {
    const base = { ...FakeSession.connected().state, port: null };
    const rows: [Partial<typeof base>, string | null, string][] = [
      [{ state: 'idle' }, 'COM3', '$(plug) COM3 - Ready'],
      [{ state: 'running' }, 'COM3', '$(play) COM3 - Running'],
      [{ state: 'rawop' }, 'COM3', '$(sync~spin) COM3 - Working'],
      [{ state: 'connecting' }, 'COM3', '$(sync~spin) COM3 - Connecting'],
      [{ state: 'disconnected', reason: '' }, 'COM3', '$(plug) COM3 - Not connected'],
      [{ state: 'disconnected', reason: '' }, null, '$(plug) No board'],
    ];
    for (const [patch, port, text] of rows) {
      const state = { ...base, ...patch };
      assert.equal(boardStatus(state, summarize(state, port, '')).text, text);
    }
  });
});

describe('status bar: auto-sync item', () => {
  function withFolder(session: FakeSession = new FakeSession()): Items {
    mock.setWorkspaceFolders(dirs.make());
    return setup(session);
  }

  it('shows the mode and toggles through the command, shown only when a folder is open', () => {
    const { autoSync, board } = setup();
    assert.equal(autoSync.visible, false, 'no folder, nothing to mirror');
    assert.equal(board.visible, true, 'the board item is always shown');
    mock.setWorkspaceFolders(dirs.make());
    assert.equal(autoSync.visible, true);
    assert.equal(autoSync.command, COMMAND_IDS.toggleAutoSync);
    assert.equal(autoSync.alignment, vscode.StatusBarAlignment.Right);
    mock.setWorkspaceFolders();
    assert.equal(autoSync.visible, false);
  });

  it('follows the autoSync setting: on (the default, D-21), ask, off', () => {
    const { autoSync } = withFolder();
    assert.equal(autoSync.text, '$(sync) Auto-sync: On');
    assert.match(tip(autoSync), /every file you save is uploaded/);
    mock.config.set(settingId('autoSync'), 'ask');
    assert.equal(autoSync.text, '$(question) Auto-sync: Ask');
    assert.match(tip(autoSync), /will ask you the first time a board connects/);
    mock.config.set(settingId('autoSync'), 'off');
    assert.equal(autoSync.text, '$(sync-ignored) Auto-sync: Off');
    assert.match(tip(autoSync), /saving a file does not change the board/);
  });

  it('shows how many files wait, and why they wait while a program runs', () => {
    const { autoSync, session } = withFolder(FakeSession.connected());
    mock.config.set(settingId('autoSync'), 'on');
    session.setPendingSyncCount(2);
    assert.equal(autoSync.text, '$(cloud-upload) Auto-sync: On (2 waiting)');
    assert.match(tip(autoSync), /2 files are waiting to be uploaded\.$/);
    session.setState({ state: 'running' });
    assert.match(tip(autoSync), /2 files are waiting to be uploaded until the running program stops\.$/);
    session.setPendingSyncCount(1);
    assert.match(tip(autoSync), /1 file is waiting/);
    session.setPendingSyncCount(0);
    assert.equal(autoSync.text, '$(sync) Auto-sync: On');
    assert.doesNotMatch(tip(autoSync), /waiting/);
  });
});

describe('status bar: lifetime and registration', () => {
  it('registerStatusBar returns disposables that remove both items and stop listening', () => {
    const session = FakeSession.connected();
    toDispose.push(session);
    const services: Pick<Services, 'session' | 'settings'> = { session, settings: new Settings() };
    const disposables = registerStatusBar(services);
    assert.equal(mock.statusBarItems.length, 2);
    const [board] = mock.statusBarItems;
    session.setState({ state: 'running' });
    assert.match(board!.text, /Running/);
    disposables.forEach((d) => d.dispose());
    assert.ok(mock.statusBarItems.every((i) => i.disposed && !i.visible));
    session.setState({ state: 'idle' });
    assert.match(board!.text, /Running/, 'a disposed status bar no longer updates');
  });

  it('fits into the Services bag used by activate()', () => {
    const session = FakeSession.connected();
    toDispose.push(session);
    const services: Services = {
      context: ctx.vscode, log: createTestLogger().log, settings: new Settings(), session, portMemory: new PortMemory(ctx.workspaceState),
    };
    registerStatusBar(services).forEach((d) => toDispose.push(d));
    assert.equal(mock.statusBarItems.length, 2);
  });

  it('makes no bridge call at all (it only reads the state)', () => {
    const session = FakeSession.connected();
    setup(session);
    session.setState({ state: 'running' });
    assert.deepEqual(session.calls, []);
  });
});
