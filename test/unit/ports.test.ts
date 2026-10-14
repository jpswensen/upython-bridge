/** "Select Serial Port" (src/commands/ports.ts): ports.list -> QuickPick, the auto shortcut, remembering, busy ports. */
import assert from 'node:assert/strict';
import os from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../../src/contributes';
import { settingId } from '../../src/identity';
import { describePort, rankPorts, registerPorts } from '../../src/commands/ports';
import type { PortRow } from '../../src/types/protocol';
import type { SelectPortArgs } from '../../src/types/services';
import { FakeSession } from '../mocks/fakeSession';
import { mock } from '../mocks/vscode';
import { makeHarness, stubCommand, type Harness } from './repl.helpers';

const row = (device: string, extra: Partial<PortRow> = {}): PortRow => ({
  device, vid: null, pid: null, serial: '', manufacturer: '', product: '', description: 'n/a', hwid: 'n/a', likelyBoard: false, ...extra,
});
const CP210X = { vid: 0x10c4, pid: 0xea60, manufacturer: 'Silicon Labs', product: 'CP2102 USB to UART Bridge Controller', likelyBoard: true };
const BLUETOOTH = row('/dev/cu.Bluetooth-Incoming-Port');
const DEBUG = row('/dev/cu.debug-console');
const BOARD = row('/dev/cu.usbserial-0001', { ...CP210X, serial: '0001' });
const BOARD2 = row('/dev/cu.usbserial-0002', { ...CP210X, serial: '0002' });

let h: Harness;

function install(ports: PortRow[], session = new FakeSession({ bridge: 'ready', interpreter: 'ok' })): void {
  h = makeHarness(session);
  h.session.script('ports.list', { ports });
  stubCommand(h, COMMAND_IDS.doctor);
  for (const d of registerPorts(h.services)) {
    mock.track(d);
  }
}

const select = (args?: SelectPortArgs): Promise<boolean | undefined> => Promise.resolve(vscode.commands.executeCommand<boolean>(COMMAND_IDS.selectPort, args));
const connects = (): string[] => h.session.argsOf('connect').map((a) => a.port);

beforeEach(() => {
  mock.reset();
  // D-24: the extension works only with a project folder open (views and connect)
  mock.setWorkspaceFolders(os.tmpdir());
});
afterEach(() => {
  h?.session.dispose();
  h?.dispose();
  mock.reset();
});

describe('ranking and descriptions (pure)', () => {
  it('likely boards first, then the rest in natural order; nothing is hidden', () => {
    const rows = [row('COM10'), row('COM2'), row('COM3', { likelyBoard: true }), row('COM12', { likelyBoard: true })];
    assert.deepEqual(rankPorts(rows).map((r) => r.device), ['COM3', 'COM12', 'COM2', 'COM10']);
  });

  it('describes a port by VID:PID, product and maker, and ignores n/a', () => {
    assert.equal(describePort(BOARD), '10C4:EA60 - CP2102 USB to UART Bridge Controller (Silicon Labs)');
    assert.equal(describePort(BLUETOOTH), '');
    assert.equal(describePort(row('COM5', { vid: 0x1a86, pid: 0x7523, description: 'USB-SERIAL CH340 (COM5)' })), '1A86:7523 - USB-SERIAL CH340 (COM5)');
  });
});

describe('explicit selection (the Select Serial Port button)', () => {
  it('lists all ports, likely board first, with a refresh row last; the choice is connected and remembered', async () => {
    install([BLUETOOTH, DEBUG, BOARD]);
    mock.answerQuickPick('/dev/cu.usbserial-0001');
    assert.equal(await select(), true);
    const pick = mock.calls.quickPicks[0];
    assert.deepEqual(pick?.labels, ['/dev/cu.usbserial-0001', '/dev/cu.Bluetooth-Incoming-Port', '/dev/cu.debug-console', 'Refresh list']);
    assert.deepEqual(h.session.argsOf('connect'), [{ port: '/dev/cu.usbserial-0001', vid: 0x10c4, pid: 0xea60 }]);
    assert.equal(h.session.selectedPort, '/dev/cu.usbserial-0001');
    assert.deepEqual(h.services.portMemory.get(), { device: '/dev/cu.usbserial-0001', vid: 0x10c4, pid: 0xea60 });
    assert.deepEqual(mock.config.updates, [], 'no setting is written');
  });

  it('shows the picker even for a single likely board (the student may want another port)', async () => {
    install([BOARD]);
    mock.answerQuickPick(undefined);
    assert.equal(await select(), false);
    assert.equal(mock.calls.quickPicks.length, 1);
    assert.deepEqual(connects(), []);
  });

  it('"Refresh list" asks the bridge again and shows the new list', async () => {
    install([BLUETOOTH]);
    let n = 0;
    h.session.script('ports.list', () => ({ ports: ++n === 1 ? [BLUETOOTH] : [BLUETOOTH, BOARD] }));
    mock.answerQuickPick('Refresh list');
    mock.answerQuickPick('/dev/cu.usbserial-0001');
    assert.equal(await select(), true);
    assert.equal(h.session.callsOf('ports.list').length, 2);
    assert.deepEqual(mock.calls.quickPicks[1]?.labels.slice(0, 1), ['/dev/cu.usbserial-0001']);
  });

  it('says what to check when there are no ports at all, and can look again', async () => {
    install([]);
    mock.answerMessage(/No serial ports were found/, 'Check again', { once: true });
    assert.equal(await select(), false, 'the second time nobody clicks, so it ends');
    assert.equal(h.session.callsOf('ports.list').length, 2);
    assert.match(mock.messages('warn')[0]?.message ?? '', /data cable/);
  });

  it('switching from a connected port closes the first connection first; a running program needs consent', async () => {
    install([BOARD, BOARD2], FakeSession.connected({ port: '/dev/cu.usbserial-0001' }));
    mock.answerQuickPick('/dev/cu.usbserial-0002');
    assert.equal(await select(), true);
    assert.deepEqual(h.session.calls.map((c) => c.op), ['ports.list', 'disconnect', 'connect']);

    h.session.setState({ state: 'running', port: '/dev/cu.usbserial-0002' });
    mock.answerQuickPick('/dev/cu.usbserial-0001');
    assert.equal(await select(), false, 'no consent, no switch');
    mock.answerQuickPick('/dev/cu.usbserial-0001');
    mock.answerMessage(/Stop it and switch/, 'Stop it and switch');
    assert.equal(await select(), true);
    assert.deepEqual(h.session.argsOf('disconnect').at(-1), { stopFirst: true });
  });
});

describe('reuse (what Run and Open REPL call)', () => {
  it('already connected: true at once, the bridge is not even asked', async () => {
    install([BOARD], FakeSession.connected());
    assert.equal(await select({ reuse: true }), true);
    assert.deepEqual(h.session.calls, []);
    assert.equal(mock.calls.quickPicks.length, 0);
  });

  it('exactly one likely board: used without asking ("auto" as a shortcut), the real name is what reaches the session', async () => {
    install([BLUETOOTH, DEBUG, BOARD]);
    assert.equal(await select({ reuse: true }), true);
    assert.equal(mock.calls.quickPicks.length, 0);
    assert.deepEqual(connects(), ['/dev/cu.usbserial-0001']);
    assert.ok(connects().every((p) => p.toLowerCase() !== 'auto'));
    assert.deepEqual(mock.config.updates, []);
  });

  it('two likely boards: the list opens (never a guess between neighbours)', async () => {
    install([BOARD, BOARD2]);
    mock.answerQuickPick('/dev/cu.usbserial-0002');
    assert.equal(await select({ reuse: true }), true);
    assert.equal(mock.calls.quickPicks.length, 1);
    assert.deepEqual(connects(), ['/dev/cu.usbserial-0002']);
  });

  it('no likely board: the list shows everything', async () => {
    install([BLUETOOTH, DEBUG]);
    mock.answerQuickPick(undefined);
    assert.equal(await select({ reuse: true }), false);
    assert.deepEqual(mock.calls.quickPicks[0]?.labels, ['/dev/cu.Bluetooth-Incoming-Port', '/dev/cu.debug-console', 'Refresh list']);
  });

  it('a remembered port is used without asking, even with several likely boards', async () => {
    install([BOARD, BOARD2]);
    await h.services.portMemory.remember({ device: '/dev/cu.usbserial-0002', vid: 0x10c4, pid: 0xea60 });
    assert.equal(await select({ reuse: true }), true);
    assert.deepEqual(connects(), ['/dev/cu.usbserial-0002']);
    assert.equal(mock.calls.quickPicks.length, 0);
  });

  it('the port from this window, then the setting, then the remembered one', async () => {
    install([BOARD, BOARD2]);
    await h.services.portMemory.remember({ device: '/dev/cu.usbserial-0001', vid: 0x10c4, pid: 0xea60 });
    mock.config.set(settingId('port'), '/dev/cu.usbserial-0002');
    assert.equal(await select({ reuse: true }), true);
    assert.deepEqual(connects(), ['/dev/cu.usbserial-0002'], 'the explicit setting beats the remembered port');
  });

  it('finds the remembered board again under a new COM number by VID/PID (Windows)', async () => {
    install([row('COM12', { ...CP210X }), row('COM1', { vid: 0x0403, pid: 0x6001 })]);
    await h.services.portMemory.remember({ device: 'COM3', vid: 0x10c4, pid: 0xea60 });
    assert.equal(await select({ reuse: true }), true);
    assert.deepEqual(connects(), ['COM12']);
    assert.match(h.logChannel.text, /COM3 is gone; using COM12/);
  });

  it('a remembered port that is not there and has no unique twin falls back to the list', async () => {
    install([BLUETOOTH, BOARD, BOARD2]);
    await h.services.portMemory.remember({ device: '/dev/cu.gone', vid: 0x1234, pid: 0x5678 });
    mock.answerQuickPick('/dev/cu.usbserial-0001');
    assert.equal(await select({ reuse: true }), true);
    assert.equal(mock.calls.quickPicks.length, 1);
  });

  it('a URL port (fake boards, rfc2217) is connected as is, since it is not in ports.list', async () => {
    install([BOARD]);
    h.session.selectPort('socket://127.0.0.1:5555');
    assert.equal(await select({ reuse: true }), true);
    assert.deepEqual(connects(), ['socket://127.0.0.1:5555']);
  });

  it('two callers at once share one flow (one list, one connect)', async () => {
    install([BOARD]);
    const [a, b] = await Promise.all([select({ reuse: true }), select({ reuse: true })]);
    assert.deepEqual([a, b], [true, true]);
    assert.equal(h.session.callsOf('ports.list').length, 1);
    assert.equal(h.session.callsOf('connect').length, 1);
  });

  it('context objects passed by menus are not mistaken for reuse', async () => {
    install([BOARD]);
    mock.answerQuickPick(undefined);
    await vscode.commands.executeCommand(COMMAND_IDS.selectPort, { some: 'menu context' });
    assert.equal(mock.calls.quickPicks.length, 1);
  });
});

describe('busy and missing ports are explained', () => {
  it('E_PORT_BUSY names the usual culprits, offers Retry, and does not retry by itself', async () => {
    install([BOARD]);
    h.session.fail('connect', 'E_PORT_BUSY', 'The port is busy.');
    assert.equal(await select({ reuse: true }), false);
    const err = mock.messages('error')[0];
    assert.ok(err);
    for (const word of ['Thonny', 'Arduino', 'PlatformIO', 'another VS Code window']) {
      assert.ok(err.message.includes(word), word);
    }
    assert.deepEqual(err.items, ['Retry', 'Choose another port', 'Show log']);
    assert.equal(h.session.callsOf('connect').length, 1, 'one attempt, no automatic retry');
  });

  it('Retry connects again, with the same port', async () => {
    install([BOARD]);
    h.session.fail('connect', 'E_PORT_BUSY', 'The port is busy.');
    mock.answerMessage(/is in use by another program/, 'Retry', { once: true });
    assert.equal(await select({ reuse: true }), true);
    assert.deepEqual(connects(), ['/dev/cu.usbserial-0001', '/dev/cu.usbserial-0001']);
  });

  it('"Choose another port" goes back to the list', async () => {
    install([BOARD, BOARD2]);
    h.session.fail('connect', 'E_PORT_BUSY', 'The port is busy.');
    mock.answerMessage(/is in use by another program/, 'Choose another port', { once: true });
    mock.answerQuickPick('/dev/cu.usbserial-0002');
    await h.services.portMemory.remember({ device: '/dev/cu.usbserial-0001', vid: 0x10c4, pid: 0xea60 });
    assert.equal(await select({ reuse: true }), true);
    assert.deepEqual(connects(), ['/dev/cu.usbserial-0001', '/dev/cu.usbserial-0002']);
  });

  it('E_NO_DEVICE says the port was not found, with the bridge hint', async () => {
    install([BOARD]);
    h.session.fail('connect', 'E_NO_DEVICE', 'The port does not exist.', { hint: 'Plug the board in.' });
    assert.equal(await select({ reuse: true }), false);
    assert.match(mock.messages('error')[0]?.message ?? '', /was not found\. The port does not exist\. Plug the board in\./);
  });

  it('a bridge that cannot start points to the Doctor', async () => {
    install([BOARD]);
    h.session.fail('ports.list', 'E_NO_PYTHON', 'Python was not found.', { hint: 'Install Python 3.12 or newer.' });
    mock.answerMessage(/Python was not found/, 'Open Doctor');
    assert.equal(await select({ reuse: true }), false);
    assert.deepEqual(h.stubbed.map((s) => s.id), [COMMAND_IDS.doctor]);
    assert.match(h.logChannel.text, /Could not look for serial ports/);
  });
});
