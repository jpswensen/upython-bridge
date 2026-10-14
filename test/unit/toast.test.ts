/**
 * Toasts that never hold up a command (src/toast.ts). Found by the first run in a real extension host: in VS Code the promise of
 * a message WITHOUT buttons settles only when the user dismisses it, so `await showInformationMessage('Program stopped.')` kept
 * `executeCommand(Stop)` pending for good. The mock normally resolves such messages at once; these tests switch on
 * `mock.holdButtonlessToasts`, which behaves like VS Code, and check that the command still finishes.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../../src/contributes';
import { registerReset } from '../../src/commands/reset';
import { registerRun } from '../../src/commands/run';
import { registerStop } from '../../src/commands/stop';
import { ReplTerminal } from '../../src/repl/terminal';
import { reportWarning } from '../../src/repl/commandSupport';
import { showToast } from '../../src/toast';
import { FakeSession } from '../mocks/fakeSession';
import { mock } from '../mocks/vscode';
import { makeHarness, stubCommand, type Harness } from './repl.helpers';
import { makeKit, type Kit } from './sync/kit';

let h: Harness | undefined;
let kit: Kit | undefined;

beforeEach(() => {
  mock.reset();
  mock.holdButtonlessToasts = true;
});
afterEach(() => {
  h?.session.dispose();
  h?.dispose();
  kit?.dispose();
  h = undefined;
  kit = undefined;
  mock.reset();
});

/** Resolves with 'finished' when `work` settles within `ms`, otherwise with 'pending'. */
async function settles(work: Thenable<unknown>, ms = 400): Promise<'finished' | 'pending'> {
  return Promise.race([
    Promise.resolve(work).then(() => 'finished' as const, () => 'finished' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

describe('the mock now behaves like VS Code for toasts without buttons', () => {
  it('a plain await of a buttonless message stays pending (this is what the bug looked like)', async () => {
    h = makeHarness(FakeSession.connected());
    assert.equal(await settles(vscode.window.showInformationMessage('hello')), 'pending');
    assert.equal(await settles(vscode.window.showInformationMessage('question', 'Yes')), 'finished');
  });
});

describe('showToast', () => {
  it('shows the message at once and returns without waiting when there is no button', async () => {
    h = makeHarness(FakeSession.connected());
    const done = showToast(h.services.log, 'info', 'All good.');
    assert.deepEqual(mock.messages('info').map((m) => m.message), ['All good.']);
    assert.equal(await settles(done), 'finished');
  });

  it('keeps the level', async () => {
    h = makeHarness(FakeSession.connected());
    await showToast(h.services.log, 'warning', 'careful');
    await showToast(h.services.log, 'error', 'broken');
    assert.deepEqual(mock.messages('warn').map((m) => m.message), ['careful']);
    assert.deepEqual(mock.messages('error').map((m) => m.message), ['broken']);
  });

  it('with buttons it is a question: it waits for the choice', async () => {
    h = makeHarness(FakeSession.connected());
    mock.answerMessage(/Keep it\?/, 'Keep');
    assert.equal(await showToast(h.services.log, 'info', 'Keep it?', 'Keep', 'Drop'), 'Keep');
    assert.equal(await showToast(h.services.log, 'info', 'Unanswered?', 'Yes'), undefined);
  });
});

describe('commands finish although their toast is never dismissed', () => {
  it('Stop: "Program stopped." (the real bug)', async () => {
    h = makeHarness(FakeSession.connected());
    for (const d of registerStop(h.services)) { mock.track(d); }
    const result = vscode.commands.executeCommand(COMMAND_IDS.stop);
    assert.equal(await settles(result), 'finished', 'executeCommand(Stop) is still pending although the program stopped');
    assert.deepEqual(mock.messages('info').map((m) => m.message), ['Program stopped.']);
  });

  it('Reset: "The board is restarting." (same pattern, a board that drops its USB port)', async () => {
    h = makeHarness(FakeSession.connected());
    h.session.script('reset.capability', { soft: true, machine: { available: true, reason: 'test' }, hard: null, cacheKey: { vid: 0x10c4, pid: 0xea60, uniqueId: 'aabbccddeeff' } });
    h.session.script('reset.machine', { phase: 'sent', portDropped: true, reconnect: true });
    for (const d of registerReset(h.services)) { mock.track(d); }
    mock.answerQuickPick(/machine|Reboot|Restart the board/i);
    mock.answerMessage(/Reboot the board\?/, 'Reboot board');
    const result = vscode.commands.executeCommand(COMMAND_IDS.resetBoard);
    assert.equal(await settles(result), 'finished', 'executeCommand(Reset) is still pending although the board restarted');
    assert.match(mock.messages('info').at(-1)?.message ?? '', /comes back by itself/);
  });

  it('Run: a refusal such as "Open the Python file you want to run first" does not wait for a click', async () => {
    h = makeHarness(FakeSession.connected());
    stubCommand(h, COMMAND_IDS.selectPort, true);
    const terminal = new ReplTerminal(h.services);
    try {
      for (const d of registerRun(h.services, { terminal })) { mock.track(d); }
      const result = vscode.commands.executeCommand(COMMAND_IDS.runActiveFile);
      assert.equal(await settles(result), 'finished', 'executeCommand(Run) is still pending behind a warning toast');
      assert.match(mock.messages('warn').at(-1)?.message ?? '', /Open the Python file you want to run/);
    } finally {
      terminal.dispose();
    }
  });

  it('reportWarning without buttons returns at once; with a button it still returns the choice', async () => {
    h = makeHarness(FakeSession.connected());
    assert.equal(await settles(reportWarning(h.services, 'nothing to click')), 'finished');
    mock.answerMessage(/Stop it/, 'Stop and run');
    assert.equal(await reportWarning(h.services, 'Stop it?', 'Stop and run'), 'Stop and run');
  });

  it('a sync summary without problems does not hold up the sync (Upload all files)', async () => {
    kit = makeKit({ local: { 'a.py': 'a' } });
    const prep = await kit.sync.prepare('toBoard', kit.sync.newConsent('test'));
    assert.ok(prep);
    for (const i of prep.plan.items) { i.selected = true; }
    const done = kit.sync.engine.execute(prep.plan, { baseline: prep.ctx.store, board: prep.board, title: 'test' });
    assert.equal(await settles(done, 2000), 'finished', 'the sync is still pending behind its "1 uploaded." toast');
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /1 uploaded\./);
  });
});
