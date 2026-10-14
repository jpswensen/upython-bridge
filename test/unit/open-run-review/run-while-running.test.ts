/**
 * Run while a program is running and saved files are waiting (parity audit J2/J6). With auto-sync on, a file saved while a
 * program runs waits in the pending list (auto-sync only sends to an idle board and never asks). Run used to flush BEFORE it asked
 * about the running program: the bridge answered E_PROGRAM_RUNNING, the file stayed pending and Run stopped with "1 file(s) could
 * not be uploaded" - the normal loop "run a while-True program, edit, save, Run again" was stuck until the student pressed Stop.
 * Now the question comes first and a "yes" stops the program, then the waiting files go out, then the program runs.
 *
 *   npm test -- run-while-running
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { registerRun } from '../../../src/commands/run';
import { COMMAND_IDS } from '../../../src/contributes';
import { ReplTerminal } from '../../../src/repl/terminal';
import { mock } from '../../mocks/vscode';
import { makeKit, waitFor, type Kit } from '../sync/kit';

let kit: Kit;
let terminal: ReplTerminal;
beforeEach(() => mock.reset());
afterEach(() => {
  terminal?.dispose();
  kit?.dispose();
});

const STOP_AND_RUN = 'Stop it and run';

/** A kit whose board runs a program, with `main.py` open in the editor and, when `autoSync` is on, `lib.py` saved and waiting. */
async function setup(autoSync: 'on' | 'off', opts: { stopped?: boolean } = {}): Promise<void> {
  kit = makeKit({ autoSync, tricky: true, local: { 'main.py': 'import lib\n', 'lib.py': 'X = 1\n' }, board: { '/lib.py': 'X = 1\n' } });
  kit.sync.start();
  await kit.sync.refreshStatus('test'); // the comparison at connect records lib.py as synced (D-21: later uploads replace only that copy)
  terminal = new ReplTerminal(kit.services);
  for (const d of registerRun(kit.services, { terminal, syncGate: kit.sync })) { mock.track(d); }
  kit.session.script('stop', (_a, ctx) => {
    if (opts.stopped !== false) { ctx.setState({ state: 'idle', reason: 'stopped' }); }
    return { stopped: opts.stopped !== false, ms: 1 };
  });
  kit.session.setState({ state: 'running' }); // a program was started from the REPL (or main.py at connect)
  await mock.openEditor(path.join(kit.workspace, 'main.py'));
}

async function saveLib(text: string): Promise<void> {
  kit.write('lib.py', text);
  await mock.saveFile(vscode.Uri.file(path.join(kit.workspace, 'lib.py')), text);
  await waitFor(() => kit.scheduler.size >= 1, 'a timer for lib.py');
}

const pressRun = (): Thenable<unknown> => vscode.commands.executeCommand(COMMAND_IDS.runActiveFile);
const order = (): string[] => kit.session.calls.map((c) => c.op).filter((op) => ['stop', 'fs.put', 'run'].includes(op));
const questions = (): number => mock.messages('warn').filter((m) => /already be running/.test(m.message)).length;

describe('Run while a program runs and a saved file waits (auto-sync on)', () => {
  it('asks once, stops the program, sends the waiting file, then runs: in that order, no "could not be uploaded"', async () => {
    await setup('on');
    await saveLib('X = 2\n');
    assert.equal(kit.sync.pendingCount, 1);
    assert.equal(kit.session.callsOf('fs.put').length, 0, 'nothing is sent while the program runs');
    mock.answerMessage(/already be running/, STOP_AND_RUN);
    await pressRun();
    assert.equal(questions(), 1);
    assert.deepEqual(order(), ['stop', 'fs.put', 'run']);
    assert.equal(kit.session.boardFs?.read('/lib.py'), 'X = 2\n', 'the board has the code on screen');
    assert.equal(kit.sync.pendingCount, 0);
    assert.deepEqual(mock.messages('warn').filter((m) => /could not be uploaded/.test(m.message)), []);
    assert.deepEqual(mock.messages('error'), []);
    assert.equal(kit.session.calls.filter((c) => c.op.startsWith('reset.')).length, 0, 'never a reset');
  });

  it('"no" (or no answer): nothing is stopped, sent or run, and the file keeps waiting', async () => {
    await setup('on');
    await saveLib('X = 2\n');
    await pressRun();
    assert.equal(questions(), 1);
    assert.deepEqual(order(), []);
    assert.equal(kit.sync.pendingCount, 1);
    assert.equal(kit.session.boardFs?.read('/lib.py'), 'X = 1\n');
  });

  it('the board does not react to Stop: the student is told (Reset board... is offered), nothing is sent or run', async () => {
    await setup('on', { stopped: false });
    await saveLib('X = 2\n');
    mock.answerMessage(/already be running/, STOP_AND_RUN);
    await pressRun();
    assert.deepEqual(order(), ['stop']);
    assert.match(mock.messages('error').at(-1)?.message ?? '', /did not react to Stop, so main\.py was not started/);
    assert.equal(kit.sync.pendingCount, 1);
  });

  it('nothing waiting: the old behaviour, the run itself interrupts and Run sends no separate stop', async () => {
    await setup('on');
    mock.answerMessage(/already be running/, STOP_AND_RUN);
    await pressRun();
    assert.deepEqual(order(), ['run']);
  });

  it('auto-sync off: nothing is flushed and no separate stop either', async () => {
    await setup('off');
    mock.answerMessage(/already be running/, STOP_AND_RUN);
    await pressRun();
    assert.deepEqual(order(), ['run']);
  });
});
