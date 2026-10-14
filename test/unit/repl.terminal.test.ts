/** The REPL / Run tab (src/repl/terminal.ts) against the vscode mock and FakeSession. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IDENTITY } from '../../src/identity';
import { MAX_WRITE_BYTES } from '../../src/repl/inputForwarder';
import { ReplTerminal } from '../../src/repl/terminal';
import { FakeSession, enc } from '../mocks/fakeSession';
import { projectRoot } from '../mocks/fixtures';
import { mock, type MockTerminal } from '../mocks/vscode';
import { decodeWrites, makeHarness, settle, type Harness } from './repl.helpers';

let h: Harness;
let term: ReplTerminal;

beforeEach(() => {
  mock.reset();
  h = makeHarness(FakeSession.connected());
  term = new ReplTerminal(h.services);
});
afterEach(() => {
  term.dispose();
  h.session.dispose();
  h.dispose();
  mock.reset();
});

async function openTerminal(): Promise<MockTerminal> {
  term.show();
  const t = mock.terminals[0];
  assert.ok(t, 'a terminal was created');
  await t.opened;
  await settle();
  return t;
}

describe('terminal lifetime', () => {
  it('creates one terminal named from identity.ts, reuses it, and never types into it', async () => {
    const t = await openTerminal();
    assert.equal(t.name, IDENTITY.terminalName);
    assert.ok(t.pty, 'it is a pseudoterminal (ExtensionTerminalOptions), not a shell');
    term.show();
    term.show(true);
    assert.equal(mock.everCreatedTerminals.length, 1);
    assert.equal(t.shown, 3);
    assert.deepEqual(t.sentText, []);
  });

  it('open attaches the REPL view; closing the tab detaches and does nothing else (no disconnect, no reset, no keys)', async () => {
    const t = await openTerminal();
    assert.equal(h.session.callsOf('repl.attach').length, 1);
    t.dispose(); // the user closes the tab
    await settle();
    assert.deepEqual(h.session.calls.map((c) => c.op), ['repl.attach', 'repl.detach']);
    assert.equal(h.session.state.state, 'idle');
    assert.equal(h.session.state.port, '/dev/cu.fake', 'the port stays open');
    assert.equal(term.isOpen, false);
  });

  it('is created again on demand after the user closed it', async () => {
    const first = await openTerminal();
    first.dispose();
    await settle();
    const second = await openTerminal();
    assert.notEqual(first, second);
    assert.equal(mock.everCreatedTerminals.length, 2);
    assert.equal(h.session.callsOf('repl.attach').length, 2);
  });

  it('shows a clear hint instead of attaching when no board is connected', async () => {
    h.session.setState({ state: 'disconnected', port: null });
    const t = await openTerminal();
    assert.match(t.output, /No board is connected/);
    assert.match(t.output, /Select Serial Port/);
    assert.equal(h.session.callsOf('repl.attach').length, 0);
  });

  it('writes a failed attach into the tab and rejects so a command can also tell the user', async () => {
    h.session.fail('repl.attach', 'E_PORT_BUSY', 'The port is busy.', { hint: 'Close the other program.' });
    const t = await openTerminal();
    assert.match(t.output, /could not connect this terminal to the board: The port is busy\. Close the other program\./);
    await assert.rejects(async () => {
      h.session.fail('repl.attach', 'E_PORT_BUSY', 'again');
      await term.attach();
    }, /again/);
  });

  it('holds output back until VS Code opened the terminal, then shows it after the header', async () => {
    mock.terminalAutoOpen = false;
    term.show();
    const t = mock.terminals[0];
    assert.ok(t);
    h.session.emit({ ev: 'repl', bytes: enc('>>> ') });
    assert.equal(t.output, '');
    t.open();
    assert.match(t.output, />>> /);
    assert.ok(t.output.indexOf('board terminal') < t.output.indexOf('>>> '), 'the header comes first');
  });
});

describe('terminal output', () => {
  it('decodes UTF-8 characters that arrive cut in half across chunks', async () => {
    const t = await openTerminal();
    const all = enc('h\u00e9llo \u2713 \u4e2d\u6587 end\r\n');
    for (let i = 1; i < all.length; i++) {
      h.session.emit({ ev: 'repl', bytes: all.subarray(i - 1, i) });
    }
    h.session.emit({ ev: 'repl', bytes: all.subarray(all.length - 1) });
    assert.ok(t.output.includes('h\u00e9llo \u2713 \u4e2d\u6587 end\r\n'), JSON.stringify(t.output));
    assert.ok(!t.output.includes('\ufffd'));
  });

  it('turns a lone LF in program output into CRLF', async () => {
    const t = await openTerminal();
    h.session.emit({ ev: 'out', bytes: enc('a\nb\r\nc\n') });
    assert.ok(t.output.endsWith('a\r\nb\r\nc\r\n'), JSON.stringify(t.output));
  });

  it('shows error text in red and keeps the File "path", line N form untouched (spaces, parentheses, non-ASCII, Windows)', async () => {
    const t = await openTerminal();
    const paths = [
      '/Users/student/OneDrive-Example University(email.example.edu)/Lab Course (Fall)/Lab 1 \u00dcbung/main.py',
      'c:\\Users\\Student Name\\OneDrive - Example University\\Lab Course (Fall)\\Lab 1\\\u00e9t\u00e9.py',
    ];
    for (const p of paths) {
      const line = `  File "${p}", line 7, in <module>`;
      h.session.emit({ ev: 'err', bytes: enc(`Traceback (most recent call last):\r\n${line}\r\nValueError: boom\r\n`) });
      assert.ok(t.output.includes(line), `link text must stay verbatim: ${line}`);
    }
    assert.ok(t.output.includes('\x1b[31mTraceback'), 'error text is red');
  });

  it('keeps program output and footer on separate lines', async () => {
    const t = await openTerminal();
    h.session.emit({ ev: 'out', bytes: enc('no newline at the end') });
    term.endRun({ kind: 'finished', exit: 'ok', durationMs: 5 });
    assert.match(t.output, /no newline at the end\r\n\x1b\[90m\[program finished\]\x1b\[0m\r\n$/);
  });

  it('writes a footer for every way a program can end', async () => {
    const t = await openTerminal();
    term.beginRun('lab.py');
    for (const exit of ['ok', 'exception', 'interrupted', 'disconnected'] as const) {
      term.endRun({ kind: 'finished', exit, durationMs: 1 });
    }
    term.endRun({ kind: 'failed', message: 'The port is busy.' });
    for (const text of ['[running lab.py]', '[program finished]', '[program finished with an error]', '[program stopped]', '[board disconnected]', '[could not run the program: The port is busy.]']) {
      assert.ok(t.output.includes(text), `missing ${text} in ${JSON.stringify(t.output)}`);
    }
  });

  it('says clearly that the board is gone and what to do next', async () => {
    const t = await openTerminal();
    h.session.setState({ state: 'disconnected', port: null, reason: 'unplugged' });
    assert.match(t.output, /unplugged or stopped answering/);
    assert.match(t.output, /Select Serial Port and Open REPL/);
    const count = t.output.match(/unplugged/g)?.length ?? 0;
    h.session.setState({ reason: 'unplugged' });
    assert.equal(t.output.match(/unplugged/g)?.length ?? 0, count, 'said once per disconnect');
  });

  it('shows a fatal bridge event in the tab with the way out', async () => {
    const t = await openTerminal();
    h.session.emit({ ev: 'fatal', message: 'Python crashed' });
    assert.match(t.output, /\[the connection helper stopped: Python crashed\. Reload the window to start it again\.\]/);
  });

  it('attaches again by itself when the board comes back', async () => {
    await openTerminal();
    h.session.setState({ state: 'disconnected', port: null, reason: 'unplugged' });
    h.session.setState({ state: 'connecting', port: '/dev/cu.fake' });
    h.session.setState({ state: 'idle', reason: 'prompt seen' });
    await settle();
    assert.equal(h.session.callsOf('repl.attach').length, 2);
  });
});

describe('terminal input', () => {
  it('forwards keystrokes raw, one key at a time, without waiting for Enter', async () => {
    const t = await openTerminal();
    t.type('p');
    await settle();
    assert.equal(decodeWrites(h.session), 'p', 'a single key reaches the board at once (no line buffering)');
    t.type('rint(1)');
    t.type('\r');
    await settle();
    assert.equal(decodeWrites(h.session), 'print(1)\r');
  });

  it('batches keys typed in the same turn into one write and keeps their order', async () => {
    const t = await openTerminal();
    t.type('a');
    t.type('b');
    t.type('c');
    await settle();
    assert.equal(h.session.callsOf('tty.write').length, 1);
    assert.equal(decodeWrites(h.session), 'abc');
  });

  it('sends Ctrl-C, Ctrl-D and escape sequences as the bytes they are (Ctrl-D during a run goes to the program)', async () => {
    h.session.setState({ state: 'running' });
    const t = await openTerminal();
    for (const k of ['\x03', '\x04', '\x1b[A', '\t', '\x7f']) {
      t.type(k);
      await settle();
    }
    assert.deepEqual(h.session.ttyWrites.map((b) => Array.from(b)), [[3], [4], [0x1b, 0x5b, 0x41], [9], [0x7f]]);
    assert.equal(h.session.callsOf('reset.soft').length, 0, 'Ctrl-D is a key, not a command');
  });

  it('cuts a long paste into small writes in order, never inside a UTF-8 character', async () => {
    const t = await openTerminal();
    const text = `${'x'.repeat(300)}${'\u2713'.repeat(300)}${'\ud83d\ude00'.repeat(50)}\r`;
    t.type(text);
    await settle(20);
    const writes = h.session.ttyWrites;
    assert.ok(writes.length > 4);
    const strict = new TextDecoder('utf-8', { fatal: true });
    for (const w of writes) {
      assert.ok(w.length <= MAX_WRITE_BYTES);
      assert.doesNotThrow(() => strict.decode(w), 'each write is valid UTF-8 on its own');
    }
    assert.equal(decodeWrites(h.session), text);
  });

  it('lets Ctrl-C through at once even while an earlier write is still in flight', async () => {
    const t = await openTerminal();
    const gate = h.session.hold('tty.write');
    t.type('x');
    await gate.arrived;
    t.type('y'); // waits behind the held write
    t.type('\x03'); // must not
    assert.equal(h.session.callsOf('tty.write').length, 2, 'the Ctrl-C write was issued without waiting');
    assert.deepEqual(Array.from(h.session.ttyWrites.at(-1) ?? []), [0x79, 0x03], 'queued keys go out ahead of it, in order');
    gate.release();
    await settle();
  });

  it('drops activation text typed by another extension in the first seconds, and logs it', async () => {
    const t = await openTerminal();
    t.sendText('source /Users/student/proj/.venv/bin/activate');
    await settle();
    assert.equal(h.session.callsOf('tty.write').length, 0, 'never reaches the board');
    assert.match(h.logChannel.text, /Not sent to the board: text that looks like an environment activation command/);
    t.type('1');
    await settle();
    assert.equal(decodeWrites(h.session), '1');
    t.type('source /x/bin/activate\r');
    await settle();
    assert.equal(decodeWrites(h.session), '1source /x/bin/activate\r', 'after a real keystroke nothing is filtered');
  });

  it('forgets the first-seconds window for a revived terminal (each tab filters on its own)', async () => {
    const first = await openTerminal();
    first.type('1');
    await settle();
    first.dispose();
    await settle();
    const second = await openTerminal();
    second.sendText('conda activate base');
    await settle();
    assert.equal(decodeWrites(h.session), '1', 'the second tab dropped its activation text');
  });

  it('tells the student once (not once per key) when keys cannot be sent, then recovers', async () => {
    const t = await openTerminal();
    h.session.setState({ state: 'disconnected', port: null, reason: 'unplugged' });
    for (const k of ['a', 'b', 'c']) {
      t.type(k);
      await settle();
    }
    assert.equal(t.output.match(/your keys were not sent/g)?.length, 1);
    assert.match(t.output, /Select Serial Port, then Open REPL/);
    h.session.setState({ state: 'idle', port: '/dev/cu.fake' });
    t.type('d');
    await settle();
    assert.equal(decodeWrites(h.session), 'd');
  });

  it('ignores resizing safely', async () => {
    const t = await openTerminal();
    assert.doesNotThrow(() => t.resize(120, 40));
  });
});

describe('source hygiene of the terminal agent', () => {
  it('never calls sendText and never builds a shell command in src/repl or the five command files', () => {
    const root = projectRoot();
    const files = [
      ...fs.readdirSync(path.join(root, 'src', 'repl')).map((f) => path.join(root, 'src', 'repl', f)),
      ...['run', 'stop', 'reset', 'repl', 'ports'].map((n) => path.join(root, 'src', 'commands', `${n}.ts`)),
    ];
    assert.ok(files.length >= 10);
    for (const f of files) {
      const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/\.sendText\s*\(/.test(code), `${f} calls sendText`);
      assert.ok(!/child_process|shell\s*:\s*true/.test(code), `${f} spawns or uses a shell`);
    }
  });
});
