/**
 * review10 part 2: scratch-folder collisions and stacked "copy and run" answers. Mock vscode + FakeSession only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { BoardCopy, COPY_AND_RUN_BUTTON } from '../../../src/commands/boardCopy';
import { registerBoardFileCommands } from '../../../src/commands/boardFiles';
import { registerRun } from '../../../src/commands/run';
import { COMMAND_IDS } from '../../../src/contributes';
import { ReplTerminal } from '../../../src/repl/terminal';
import type { BoardNode } from '../../../src/types/sync';
import { mock } from '../../mocks/vscode';
import { makeKit, type Kit } from '../sync/kit';

let kit: Kit;
let terminal: ReplTerminal;
beforeEach(() => mock.reset());
afterEach(() => { terminal?.dispose(); kit?.dispose(); });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const file = (devicePath: string): BoardNode => ({ devicePath, kind: 'file', name: devicePath.split('/').pop() ?? '', size: 1 });

function wire(): BoardCopy {
  terminal = new ReplTerminal(kit.services);
  const copy = new BoardCopy(kit.services, kit.sync);
  for (const d of registerBoardFileCommands(kit.services, { sync: kit.sync, copy })) { mock.track(d); }
  for (const d of registerRun(kit.services, { terminal, syncGate: kit.sync, boardFiles: { localCounterpart: (p) => kit.sync.localCounterpart(p), copy } })) { mock.track(d); }
  return copy;
}

describe('review10b: two copies that start in the same millisecond', () => {
  it('(Date.now frozen) share no scratch file: the project file is whole and no error appears', async (t) => {
    kit = makeKit({ tricky: true, board: { '/a.py': 'print(5)\n'.repeat(5000) } });
    const copy = wire();
    kit.session.latencyMs = 5; // the two downloads overlap, as they would on a real link
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    let results: (string | undefined)[];
    try {
      results = await Promise.all([copy.copy('/a.py'), copy.copy('/a.py')]);
    } finally {
      Date.now = realNow;
    }
    await sleep(100);
    t.diagnostic(`results ${JSON.stringify(results)}; messages ${JSON.stringify(mock.messages().map((m) => `${m.level}: ${m.message.slice(0, 120)}`))}`);
    assert.equal(kit.read('a.py'), 'print(5)\n'.repeat(5000));
    assert.deepEqual(mock.messages('error').map((m) => m.message), []);
  });

  it('(natural timing, 5 ms link latency) two copies: whole file, no error', async (t) => {
    kit = makeKit({ tricky: true, board: { '/a.py': 'print(5)\n'.repeat(5000) } });
    const copy = wire();
    kit.session.latencyMs = 5;
    const results = await Promise.all([copy.copy('/a.py'), copy.copy('/a.py')]);
    await sleep(100);
    t.diagnostic(`results ${JSON.stringify(results.map((r) => r !== undefined))}; fs.get calls ${kit.session.callsOf('fs.get').length}`);
    assert.equal(kit.read('a.py'), 'print(5)\n'.repeat(5000));
    assert.deepEqual(mock.messages('error').map((m) => m.message), []);
  });
});

describe('review10b: Run pressed twice with the copy-and-run offer open', () => {
  it('both offers answered: the file is copied once and the program runs once', async (t) => {
    kit = makeKit({ tricky: true, board: { '/test.py': 'print(1)\n' } });
    wire();
    await vscode.commands.executeCommand(COMMAND_IDS.openBoardCopy, file('/test.py'));
    mock.answerMessage(/only on the board/, COPY_AND_RUN_BUTTON);
    await Promise.all([vscode.commands.executeCommand(COMMAND_IDS.runActiveFile), vscode.commands.executeCommand(COMMAND_IDS.runActiveFile)]);
    await sleep(300);
    const runs = kit.session.argsOf('run').length;
    t.diagnostic(`run calls: ${runs}; messages: ${JSON.stringify(mock.messages().map((m) => `${m.level}: ${m.message.slice(0, 100)}`))}`);
    assert.equal(kit.read('test.py'), 'print(1)\n');
    assert.equal(runs, 1);
    assert.deepEqual(fs.readdirSync(kit.workspace), ['test.py']);
    assert.equal(path.basename(mock.activeEditor?.document.uri.fsPath ?? ''), 'test.py');
  });
});
