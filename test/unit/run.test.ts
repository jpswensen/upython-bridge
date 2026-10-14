/** "Run Current File on Board" (src/commands/run.ts): save, connect, flush, consent, exit kinds, errors. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../../src/contributes';
import { settingId } from '../../src/identity';
import { registerRun } from '../../src/commands/run';
import { ReplTerminal } from '../../src/repl/terminal';
import type { OpArgs } from '../../src/types/protocol';
import type { SyncGate } from '../../src/types/sync';
import { FakeSession, enc } from '../mocks/fakeSession';
import { TempDirs, WINDOWS, makeTrickyDir } from '../mocks/fixtures';
import { mock, type MockTextDocument } from '../mocks/vscode';
import { makeHarness, settle, stubCommand, type Harness } from './repl.helpers';

const dirs = new TempDirs();
let h: Harness;
let terminal: ReplTerminal;

beforeEach(() => {
  mock.reset();
  h = makeHarness(FakeSession.connected());
  terminal = new ReplTerminal(h.services);
  stubCommand(h, COMMAND_IDS.selectPort, true);
});
afterEach(() => {
  terminal.dispose();
  h.session.dispose();
  h.dispose();
  dirs.cleanup();
  mock.reset();
});

function install(syncGate?: SyncGate): void {
  for (const d of registerRun(h.services, { terminal, syncGate })) {
    mock.track(d);
  }
}

async function openPython(name = 'lab one.py', content = 'print("hi")\n'): Promise<{ file: string; doc: MockTextDocument }> {
  const dir = makeTrickyDir(dirs.make());
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  const editor = await mock.openEditor(file);
  return { file, doc: editor.document };
}

const run = (): Promise<unknown> => Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile));
const lastRunArgs = (): OpArgs<'run'> => h.session.argsOf('run').at(-1) as OpArgs<'run'>;

describe('run: the happy path', () => {
  it('runs the saved file with its local path as the file name (spaces, parentheses, non-ASCII), fresh start by default', async () => {
    install();
    const { file } = await openPython();
    await run();
    assert.deepEqual(lastRunArgs(), { local: file, name: file, reset: true });
    assert.deepEqual(h.stubbed.map((s) => s.id), [COMMAND_IDS.selectPort]);
    assert.deepEqual(h.stubbed[0]?.args, [{ reuse: true }], 'asks for a connection with reuse');
    const t = mock.terminals[0];
    assert.ok(t, 'the terminal was created and shown');
    assert.ok(t.shown > 0);
  });

  it('honours the run.freshStart setting', async () => {
    install();
    mock.config.set(settingId('run.freshStart'), false);
    await openPython();
    await run();
    assert.equal((lastRunArgs() as { reset?: boolean }).reset, false);
  });

  it('saves a dirty editor first: the board gets the text on screen', async () => {
    install();
    const { file, doc } = await openPython('edit.py', 'print(1)\n');
    doc.setText('print(2)\n');
    let seen = '';
    h.session.script('run', () => {
      seen = fs.readFileSync(file, 'utf8');
      return { exit: 'ok', durationMs: 1 };
    });
    await run();
    assert.equal(seen, 'print(2)\n');
    assert.equal(doc.isDirty, false);
  });

  it('shows streamed output and the error text, then the footer, and a status bar message per exit kind', async () => {
    install();
    await openPython();
    const outcomes = {
      ok: { footer: '[program finished]', status: /finished in 0\.5 s/ },
      exception: { footer: '[program finished with an error]', status: /stopped with an error/ },
      interrupted: { footer: '[program stopped]', status: /was stopped/ },
      disconnected: { footer: '[board disconnected]', status: /board disconnected/ },
    } as const;
    for (const [exit, expected] of Object.entries(outcomes) as [keyof typeof outcomes, (typeof outcomes)[keyof typeof outcomes]][]) {
      h.session.script('run', (_args, ctx) => {
        ctx.emit({ ev: 'out', bytes: enc(`out ${exit}\n`) });
        if (exit === 'exception') {
          ctx.emit({ ev: 'err', bytes: enc('Traceback (most recent call last):\r\n  File "x.py", line 1, in <module>\r\nValueError: boom\r\n') });
        }
        return { exit, durationMs: 500 };
      });
      await run();
      const t = mock.terminals[0];
      assert.ok(t);
      assert.ok(t.output.includes(`out ${exit}\r\n`), `output of ${exit}`);
      assert.ok(t.output.includes(expected.footer), `footer of ${exit}: ${JSON.stringify(t.output.slice(-200))}`);
      assert.match(mock.calls.statusMessages.at(-1) ?? '', expected.status);
    }
    assert.ok(mock.terminals[0]?.output.includes('File "x.py", line 1'));
  });

  it('works for a Windows-shaped path (drive letter, backslashes, spaces) and names the file in messages', async () => {
    install();
    mock.fsMode = 'memory';
    const uri = vscode.Uri.file(WINDOWS.mainPy);
    await mock.fs.writeFile(uri, enc('print(1)\n'));
    await mock.openEditor(uri);
    await run();
    const args = lastRunArgs() as { local: string; name?: string };
    assert.equal(args.local, uri.fsPath);
    assert.ok(args.local.startsWith('c:\\Users\\Student Name\\'), args.local);
    assert.equal(args.name, args.local);
    assert.match(mock.terminals[0]?.output ?? '', /\[running main\.py\]/);
  });
});

describe('run: refusals say what to do', () => {
  it('no editor open', async () => {
    install();
    await run();
    assert.equal(h.session.callsOf('run').length, 0);
    assert.match(mock.messages('warn').at(-1)?.message ?? '', /Open the Python file you want to run/);
  });

  it('a file that is not Python', async () => {
    install();
    await openPython('notes.txt', 'hello');
    await run();
    assert.equal(h.session.callsOf('run').length, 0);
    assert.match(mock.messages('warn').at(-1)?.message ?? '', /notes\.txt is not a Python file/);
  });

  it('an unsaved new file', async () => {
    install();
    const doc = await mock.openDocument({ content: 'print(1)', language: 'python' });
    await mock.openEditor(doc);
    await run();
    assert.equal(h.session.callsOf('run').length, 0);
    assert.match(mock.messages('warn').at(-1)?.message ?? '', /has not been saved yet/);
  });

  it('does nothing more when no board could be connected (the port command explained)', async () => {
    install();
    mock.commandHandlers.delete(COMMAND_IDS.selectPort);
    stubCommand(h, COMMAND_IDS.selectPort, false);
    await openPython();
    await run();
    assert.equal(h.session.callsOf('run').length, 0);
    assert.equal(mock.terminals.length, 0);
  });
});

describe('run: a program is already running', () => {
  it('asks once; no answer means no run', async () => {
    install();
    h.session.setState({ state: 'running' });
    await openPython();
    await run();
    assert.equal(h.session.callsOf('run').length, 0);
    assert.equal(mock.messages('warn').filter((m) => /already be running/.test(m.message)).length, 1);
  });

  it('asks once; "Stop it and run" starts the run (the bridge interrupts, it never resets by itself)', async () => {
    install();
    h.session.setState({ state: 'running' });
    mock.answerMessage(/already be running/, 'Stop it and run');
    await openPython();
    await run();
    assert.equal(h.session.callsOf('run').length, 1);
    assert.equal(mock.messages('warn').filter((m) => /already be running/.test(m.message)).length, 1);
    assert.equal(h.session.calls.filter((c) => c.op.startsWith('reset.')).length, 0);
  });

  it('a bridge that asks for consent itself (E_PROGRAM_RUNNING + needs_interrupt) is answered once, then the run repeats with interrupt', async () => {
    install();
    h.session.fail('run', 'E_PROGRAM_RUNNING', 'A program is running on the board.', { needs_interrupt: true });
    mock.answerMessage(/already be running/, 'Stop it and run');
    await openPython();
    await run();
    const runs = h.session.argsOf('run') as { interrupt?: boolean }[];
    assert.equal(runs.length, 2);
    assert.equal(runs[0]?.interrupt, undefined);
    assert.equal(runs[1]?.interrupt, true);
    assert.equal(mock.messages('warn').filter((m) => /already be running/.test(m.message)).length, 1);
  });
});

describe('run: errors reach the student and the log', () => {
  it('shows the cause with its next step, writes it in the terminal and the log', async () => {
    install();
    h.session.fail('run', 'E_PORT_BUSY', 'The port is in use by another program.', { hint: 'Close Thonny and try again.' });
    await openPython();
    await run();
    const err = mock.messages('error').at(-1);
    assert.ok(err);
    assert.match(err.message, /Could not run lab one\.py\. The port is in use by another program\. Close Thonny and try again\./);
    assert.match(mock.terminals[0]?.output ?? '', /could not run the program: The port is in use/);
    assert.match(h.logChannel.text, /Could not run lab one\.py/);
  });

  it('offers to select a port when the board vanished between the check and the run', async () => {
    install();
    h.session.fail('run', 'E_NOT_CONNECTED', 'No board is connected.', { hint: 'Select a serial port first.' });
    mock.answerMessage(/Could not run/, 'Select Serial Port');
    await openPython();
    await run();
    assert.equal(h.stubbed.filter((s) => s.id === COMMAND_IDS.selectPort).length, 2);
  });
});

describe('run: library files are current before the run (D-07)', () => {
  function gate(pending: number, ok = true): { gate: SyncGate; log: string[] } {
    const log: string[] = [];
    return {
      log,
      gate: {
        get pendingCount() { return pending; },
        flushPending: async () => { log.push('flush'); return { ok, uploaded: ok ? pending : 0, failed: ok ? 0 : pending }; },
      },
    };
  }

  it('saves all dirty files and flushes pending uploads before the run', async () => {
    const g = gate(2);
    install(g.gate);
    const lib = await openPython('lib one.py', 'x = 1\n');
    lib.doc.setText('x = 2\n');
    const main = await openPython('main one.py', 'import x\n');
    h.session.script('run', () => { g.log.push('run'); return { exit: 'ok', durationMs: 1 }; });
    await run();
    assert.deepEqual(g.log, ['flush', 'run']);
    assert.equal(lib.doc.isDirty, false, 'the other dirty file was saved');
    assert.equal(fs.readFileSync(lib.file, 'utf8'), 'x = 2\n');
    assert.equal(main.doc.isDirty, false);
  });

  it('does not run on a stale board when the upload failed', async () => {
    const g = gate(1, false);
    install(g.gate);
    await openPython();
    await run();
    assert.equal(h.session.callsOf('run').length, 0);
    assert.match(mock.messages('warn').at(-1)?.message ?? '', /could not be uploaded to the board/);
  });

  it('skips the flush when auto-sync is off and nothing is pending, and flushes when auto-sync is on', async () => {
    const g = gate(0);
    install(g.gate);
    mock.config.set(settingId('autoSync'), 'off');
    await openPython();
    await run();
    assert.deepEqual(g.log, []);
    mock.config.set(settingId('autoSync'), 'on');
    await run();
    assert.deepEqual(g.log, ['flush']);
    await settle();
  });
});
