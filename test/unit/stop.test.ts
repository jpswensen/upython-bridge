/** "Stop Program" (src/commands/stop.ts): always reaches the board, never resets by itself (RQ-SAFE-2/3). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../../src/contributes';
import { registerStop } from '../../src/commands/stop';
import { FakeSession } from '../mocks/fakeSession';
import { projectRoot } from '../mocks/fixtures';
import { mock } from '../mocks/vscode';
import { makeHarness, settle, stubCommand, type Harness } from './repl.helpers';

let h: Harness;

function install(session = FakeSession.connected()): void {
  h = makeHarness(session);
  for (const d of registerStop(h.services)) {
    mock.track(d);
  }
  stubCommand(h, COMMAND_IDS.resetBoard);
  stubCommand(h, COMMAND_IDS.selectPort, true);
}

const stop = (): Promise<unknown> => Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.stop));
const resetOps = (): string[] => h.session.calls.map((c) => c.op).filter((op) => op.startsWith('reset.'));

beforeEach(() => mock.reset());
afterEach(() => {
  h.session.dispose();
  h.dispose();
  mock.reset();
});

describe('stop', () => {
  it('stopped:true shows a message and sends only `stop`', async () => {
    install();
    await stop();
    assert.deepEqual(h.session.calls.map((c) => c.op), ['stop']);
    assert.deepEqual(mock.messages('info').map((m) => m.message), ['Program stopped.']);
    assert.deepEqual(mock.messages('error'), []);
  });

  it('stopped:false is an error with a "Reset board..." button, and never resets by itself', async () => {
    install();
    h.session.script('stop', { stopped: false, ms: 3000 });
    await stop();
    const err = mock.messages('error').at(-1);
    assert.ok(err);
    assert.deepEqual(err.items.slice(0, 1), ['Reset board...']);
    assert.match(err.message, /did not react to Stop/);
    assert.deepEqual(resetOps(), [], 'no reset op');
    assert.deepEqual(h.stubbed, [], 'not even the reset menu opened without the click');
  });

  it('the button opens the reset menu (the command), still no reset op from Stop itself', async () => {
    install();
    h.session.script('stop', { stopped: false, ms: 3000 });
    mock.answerMessage(/did not react/, 'Reset board...');
    await stop();
    assert.deepEqual(h.stubbed.map((s) => s.id), [COMMAND_IDS.resetBoard]);
    assert.deepEqual(resetOps(), []);
  });

  it('E_BOARD_UNRESPONSIVE also offers the menu instead of resetting', async () => {
    install();
    h.session.fail('stop', 'E_BOARD_UNRESPONSIVE', 'The board did not answer.', { hint: 'Press its reset button.' });
    await stop();
    const err = mock.messages('error').at(-1);
    assert.ok(err);
    assert.ok(err.items.includes('Reset board...'));
    assert.match(err.message, /The board did not answer\. Press its reset button\./);
    assert.deepEqual(resetOps(), []);
  });

  it('works while a Run is in flight (bypasses the queue) and while a file transfer is held', async () => {
    install();
    h.session.setState({ state: 'running' });
    const gate = h.session.hold('run');
    const running = h.session.call('run', { local: '/x/a.py' });
    await gate.arrived;
    await stop();
    assert.equal(h.session.callsOf('stop').length, 1);
    assert.deepEqual(mock.messages('info').map((m) => m.message), ['Program stopped.']);
    gate.release();
    await running;
  });

  it('with no board it is calm: an information message, no bridge call, no error', async () => {
    install(new FakeSession());
    await stop();
    assert.deepEqual(h.session.calls, []);
    assert.deepEqual(mock.messages('error'), []);
    const info = mock.messages('info').at(-1);
    assert.match(info?.message ?? '', /No board is connected/);
    assert.ok(info?.items.includes('Select Serial Port'));
  });

  it('a board that vanished mid-click gets the same calm message', async () => {
    install();
    h.session.fail('stop', 'E_NOT_CONNECTED', 'No board is connected.');
    await stop();
    assert.deepEqual(mock.messages('error'), []);
    assert.match(mock.messages('info').at(-1)?.message ?? '', /No board is connected/);
  });

  it('any other failure is shown with its cause and logged', async () => {
    install();
    h.session.fail('stop', 'E_CALL_TIMEOUT', 'The board did not answer in time.', { hint: 'Check the cable.' });
    await stop();
    assert.match(mock.messages('error').at(-1)?.message ?? '', /Could not stop the program\. The board did not answer in time\. Check the cable\./);
    assert.match(h.logChannel.text, /Could not stop the program/);
    await settle();
  });

  it('the source of stop.ts contains no reset operation at all', () => {
    const src = fs.readFileSync(path.join(projectRoot(), 'src', 'commands', 'stop.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/['"]reset\.(soft|machine|hard)['"]/.test(src));
    assert.ok(!/confirmed/.test(src));
  });
});
