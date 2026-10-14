/**
 * D-17: closing the Run/REPL tab stops a program that the Run command started (Ctrl-C twice via `stop`, never a reset, one
 * non-blocking toast), and otherwise only detaches. Real ReplTerminal + real Run command over FakeSession and the vscode mock.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { registerRun } from '../../src/commands/run';
import { COMMAND_IDS } from '../../src/contributes';
import { settingId } from '../../src/identity';
import { RunTracker } from '../../src/repl/runTracker';
import { ReplTerminal } from '../../src/repl/terminal';
import { FakeSession, type Gate } from '../mocks/fakeSession';
import { TempDirs, makeTrickyDir } from '../mocks/fixtures';
import { mock, type MockTerminal } from '../mocks/vscode';
import { makeHarness, settle, stubCommand, type Harness } from './repl.helpers';

const TOAST = 'Your program was stopped because the Run window was closed.';
const dirs = new TempDirs();
let h: Harness;
let term: ReplTerminal;

beforeEach(() => {
  mock.reset();
  mock.holdButtonlessToasts = true; // VS Code's behaviour: a toast without buttons never settles by itself
  h = makeHarness(FakeSession.connected());
  term = new ReplTerminal(h.services);
  stubCommand(h, COMMAND_IDS.selectPort, true);
  stubCommand(h, COMMAND_IDS.resetBoard);
  for (const d of registerRun(h.services, { terminal: term })) {
    mock.track(d);
  }
});
afterEach(() => {
  term.dispose();
  h.session.dispose();
  h.dispose();
  dirs.cleanup();
  mock.reset();
});

const ops = (): string[] => h.session.calls.map((c) => c.op);
const resetOps = (): string[] => ops().filter((op) => op.startsWith('reset.') || op === 'disconnect');
const stops = (): number => h.session.callsOf('stop').length;
const menuOpened = (): string[] => h.stubbed.map((s) => s.id).filter((id) => id === COMMAND_IDS.resetBoard);
/** A held call must show up soon; a missing one fails the test at once instead of waiting for the runner's timeout. */
const arrives = (gate: Gate, what: string): Promise<unknown> =>
  Promise.race([gate.arrived, settle(1000).then(() => { throw new Error(`${what} was never made`); })]);
const toasts = (): string[] => mock.messages('info').map((m) => m.message).filter((m) => m === TOAST);

/** The bridge goes idle when Ctrl-C ends the program; the fake does not do that by itself. */
function stopEndsProgram(): void {
  h.session.script('stop', (_args, ctx) => {
    ctx.setState({ state: 'idle', reason: 'stopped' });
    return { stopped: true, ms: 5 };
  });
}

/** Start Run on a file and keep the bridge's `run` call open (the program "is running"). */
async function startRun(): Promise<{ gate: Gate; done: Promise<unknown>; tab: MockTerminal }> {
  const dir = makeTrickyDir(dirs.make());
  const file = path.join(dir, 'loop.py');
  fs.writeFileSync(file, 'while True:\n    pass\n');
  await mock.openEditor(file);
  const gate = h.session.hold('run');
  const done = Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile));
  await gate.arrived;
  h.session.setState({ state: 'running', reason: 'run' }); // the bridge says Running as soon as it starts the Run
  const tab = mock.terminals[0];
  assert.ok(tab, 'Run opened the tab');
  await tab.opened;
  await settle();
  return { gate, done, tab };
}

describe('closing the tab while a program that Run started is running', () => {
  it('stops it once (Ctrl-C twice via `stop`), shows one toast, detaches, resets nothing and keeps the port open', async () => {
    stopEndsProgram();
    const { gate, done, tab } = await startRun();
    tab.dispose(); // the user closes the Run tab
    await settle(20);
    assert.equal(stops(), 1);
    assert.deepEqual(h.session.argsOf('stop'), [{}]);
    assert.deepEqual(ops().filter((op) => op === 'repl.attach' || op === 'stop' || op === 'repl.detach'), ['repl.attach', 'stop', 'repl.detach'], 'stop first, then detach');
    assert.deepEqual(toasts(), [TOAST]);
    assert.deepEqual(resetOps(), [], 'no reset op and no disconnect');
    assert.deepEqual(mock.messages('error'), []);
    assert.equal(h.session.state.port, '/dev/cu.fake', 'the connection stays open');
    gate.release();
    await done;
  });

  it('a stop that took long does not hold the detach back after it answered, and a toast without buttons never blocks', async () => {
    const stopGate = h.session.hold('stop');
    const { gate, done, tab } = await startRun();
    tab.dispose();
    await arrives(stopGate, 'the stop call');
    assert.equal(h.session.callsOf('repl.detach').length, 0, 'detach comes after the stop');
    stopGate.release();
    await settle(20);
    assert.equal(h.session.callsOf('repl.detach').length, 1);
    assert.deepEqual(toasts(), [TOAST]);
    gate.release();
    await done;
  });

  it('closing twice (the same tab, or a new tab opened and closed while the stop is in flight) sends one stop', async () => {
    const stopGate = h.session.hold('stop');
    const { gate, done, tab } = await startRun();
    tab.dispose();
    tab.dispose();
    await arrives(stopGate, 'the stop call');
    term.show(); // the student opens the tab again at once ...
    const second = mock.terminals[0];
    assert.ok(second && second !== tab);
    await second.opened;
    await settle();
    second.dispose(); // ... and closes it again before the first stop answered
    await settle(20);
    stopGate.release();
    await settle(20);
    assert.equal(stops(), 1);
    assert.deepEqual(toasts(), [TOAST]);
    assert.deepEqual(resetOps(), []);
    gate.release();
    await done;
  });

  it('a tab opened again while the stop is in flight keeps its view (the late detach is skipped)', async () => {
    const stopGate = h.session.hold('stop');
    const { gate, done, tab } = await startRun();
    tab.dispose();
    await arrives(stopGate, 'the stop call');
    term.show();
    const second = mock.terminals[0];
    assert.ok(second);
    await second.opened;
    await settle();
    stopGate.release();
    await settle(20);
    assert.equal(h.session.callsOf('repl.attach').length, 2);
    assert.equal(h.session.callsOf('repl.detach').length, 0, 'the new tab is attached; detaching now would blind it');
    gate.release();
    await done;
  });

  it('the setting stopOnTerminalClose = false only detaches', async () => {
    mock.config.set(settingId('stopOnTerminalClose'), false);
    const { gate, done, tab } = await startRun();
    tab.dispose();
    await settle(20);
    assert.equal(stops(), 0);
    assert.deepEqual(toasts(), []);
    assert.equal(h.session.callsOf('repl.detach').length, 1);
    assert.equal(h.session.state.state, 'running', 'the program keeps running');
    gate.release();
    await done;
  });

  it('a failed stop (stopped:false) is a calm error with the Reset board... button, and never resets by itself', async () => {
    h.session.script('stop', { stopped: false, ms: 10_000 });
    const { gate, done, tab } = await startRun();
    tab.dispose();
    await settle(20);
    const err = mock.messages('error').at(-1);
    assert.ok(err, 'an error message was shown');
    assert.ok(err.items.includes('Reset board...'));
    assert.match(err.message, /did not react when the Run window was closed/);
    assert.match(err.message, /may still be running/);
    assert.deepEqual(toasts(), [], 'no "stopped" toast');
    assert.deepEqual(resetOps(), []);
    assert.deepEqual(menuOpened(), [], 'the reset menu did not open without a click');
    assert.equal(h.session.callsOf('repl.detach').length, 1, 'the view is still detached');
    gate.release();
    await done;
  });

  it('the Reset board... button only opens the menu; still no reset op from the close handler', async () => {
    h.session.script('stop', { stopped: false, ms: 10_000 });
    mock.answerMessage(/did not react when the Run window/, 'Reset board...');
    const { gate, done, tab } = await startRun();
    tab.dispose();
    await settle(20);
    assert.equal(menuOpened().length, 1);
    assert.deepEqual(resetOps(), []);
    gate.release();
    await done;
  });

  it('a stop that throws E_BOARD_UNRESPONSIVE offers the reset menu; any other error is shown with its next step; neither resets', async () => {
    h.session.fail('stop', 'E_BOARD_UNRESPONSIVE', 'The board did not answer.', { hint: 'Press its reset button.' });
    const first = await startRun();
    first.tab.dispose();
    await settle(20);
    const err = mock.messages('error').at(-1);
    assert.ok(err);
    assert.ok(err.items.includes('Reset board...'));
    assert.match(err.message, /The board did not answer\. Press its reset button\./);
    first.gate.release();
    await first.done;

    h.session.setState({ state: 'idle' });
    h.session.fail('stop', 'E_INTERNAL', 'Something broke.', { hint: 'Try again.' });
    const second = await startRun();
    second.tab.dispose();
    await settle(20);
    const other = mock.messages('error').at(-1);
    assert.ok(other);
    assert.match(other.message, /could not be stopped after the Run window was closed.*Something broke/);
    assert.deepEqual(resetOps(), []);
    second.gate.release();
    await second.done;
  });
});

describe('closing the tab when the program is not one that Run started, or nothing runs', () => {
  it('no program at all: only detaches', async () => {
    term.show();
    const tab = mock.terminals[0];
    assert.ok(tab);
    await tab.opened;
    await settle();
    tab.dispose();
    await settle(20);
    assert.deepEqual(ops(), ['repl.attach', 'repl.detach']);
    assert.deepEqual(toasts(), []);
  });

  it('a program that was already running at connect (main.py: state running, not started by Run) keeps running', async () => {
    h.session.setState({ state: 'running', reason: 'running-program' });
    term.show();
    const tab = mock.terminals[0];
    assert.ok(tab);
    await tab.opened;
    await settle();
    tab.dispose();
    await settle(20);
    assert.equal(stops(), 0);
    assert.deepEqual(ops(), ['repl.attach', 'repl.detach']);
    assert.deepEqual(toasts(), []);
    assert.equal(h.session.state.state, 'running');
  });

  it('the consent question of Run ("Stop it and run?") is outside the ownership window: closing then stops nothing', async () => {
    h.session.setState({ state: 'running', reason: 'running-program' });
    h.session.fail('run', 'E_PROGRAM_RUNNING', 'A program is running on the board.', { needs_interrupt: true, hint: 'Confirm.' });
    let ownedWhileAsking: boolean | undefined;
    mock.answerMessage(/may already be running/, () => {
      ownedWhileAsking = term.runs.active;
      mock.terminals[0]?.dispose(); // the student closes the tab instead of answering
      return undefined;
    });
    const dir = makeTrickyDir(dirs.make());
    const file = path.join(dir, 'a.py');
    fs.writeFileSync(file, 'print(1)\n');
    await mock.openEditor(file);
    await Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile));
    await settle(20);
    assert.equal(ownedWhileAsking, false);
    assert.equal(stops(), 0);
    assert.deepEqual(toasts(), []);
  });

  it('disconnected: closing does nothing (no stop, no detach)', async () => {
    const { gate, done, tab } = await startRun();
    h.session.setState({ state: 'disconnected', port: null, reason: 'unplugged' });
    tab.dispose();
    await settle(20);
    assert.equal(stops(), 0);
    assert.equal(h.session.callsOf('repl.detach').length, 0);
    assert.deepEqual(toasts(), []);
    assert.deepEqual(mock.messages('error'), []);
    gate.release();
    await done.catch(() => undefined);
  });

  it('the program ended just before the close (state already idle, Run call still returning): no stop', async () => {
    const { gate, done, tab } = await startRun();
    h.session.setState({ state: 'idle', reason: 'program ended' }); // the state event comes before the run result
    tab.dispose();
    await settle(20);
    assert.equal(stops(), 0);
    assert.equal(h.session.callsOf('repl.detach').length, 1);
    assert.deepEqual(toasts(), []);
    gate.release();
    await done;
  });

  it('the program ended long before the close: the Run call returned, nothing is owned any more', async () => {
    const { gate, done, tab } = await startRun();
    gate.release();
    await done;
    assert.equal(term.runs.active, false);
    h.session.setState({ state: 'running', reason: 'something else' }); // a later program that Run did not start
    tab.dispose();
    await settle(20);
    assert.equal(stops(), 0);
  });

  it('disposing the terminal on deactivation never stops the program (the bridge handles window close)', async () => {
    const { gate, done } = await startRun();
    term.dispose();
    await settle(20);
    assert.equal(stops(), 0);
    assert.deepEqual(toasts(), []);
    gate.release();
    await done.catch(() => undefined);
  });
});

describe('RunTracker', () => {
  it('is owned between begin and end, and a close claims the stop once per run', () => {
    const t = new RunTracker();
    assert.equal(t.active, false);
    assert.equal(t.claimStop(), false, 'nothing to stop before a Run');
    t.begin();
    assert.equal(t.active, true);
    assert.equal(t.claimStop(), true);
    assert.equal(t.claimStop(), false);
    t.end();
    assert.equal(t.active, false);
    assert.equal(t.claimStop(), false);
    t.begin();
    assert.equal(t.claimStop(), true, 'a new run can be stopped again');
  });
});
