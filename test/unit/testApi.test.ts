/**
 * The extension-host test hook (src/testApi.ts): absent unless the test switch is exactly "1", read-only when present, and the
 * terminal tap records output and input without changing what the terminal does. Production behaviour (no switch) is unchanged:
 * activate() returns nothing, as it did before the hook existed.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { activate } from '../../src/extension';
import { ReplTerminal } from '../../src/repl/terminal';
import { TEST_SWITCH, TestRecorder, testHookEnabled } from '../../src/testApi';
import { FakeSession, enc } from '../mocks/fakeSession';
import { TempDirs } from '../mocks/fixtures';
import type { MockExtensionContext } from '../mocks/extensionContext';
import { createExtensionContext, mock } from '../mocks/vscode';
import { makeHarness, settle } from './repl.helpers';

const dirs = new TempDirs();
let ctx: MockExtensionContext;
let saved: string | undefined;

beforeEach(() => {
  mock.reset();
  saved = process.env[TEST_SWITCH];
  delete process.env[TEST_SWITCH];
  ctx = createExtensionContext();
  mock.setWorkspaceFolders(dirs.make('upy-bridge-hook'));
});

afterEach(() => {
  ctx.dispose();
  dirs.cleanup();
  mock.reset();
  if (saved === undefined) {
    delete process.env[TEST_SWITCH];
  } else {
    process.env[TEST_SWITCH] = saved;
  }
});

describe('the gate', () => {
  it('is on only for exactly "1"', () => {
    assert.equal(testHookEnabled({}), false);
    for (const v of ['0', 'true', 'yes', '', '11', ' 1']) {
      assert.equal(testHookEnabled({ [TEST_SWITCH]: v }), false, `"${v}" does not switch it on`);
    }
    assert.equal(testHookEnabled({ [TEST_SWITCH]: '1' }), true);
  });

  it('activate() returns nothing in production (switch absent)', () => {
    assert.equal(activate(ctx.vscode), undefined);
  });

  it('activate() returns nothing when the switch is set to anything but 1', () => {
    process.env[TEST_SWITCH] = 'true';
    assert.equal(activate(ctx.vscode), undefined);
  });
});

describe('with the switch on', () => {
  it('returns only { test } with the read-only members', async () => {
    process.env[TEST_SWITCH] = '1';
    const api = activate(ctx.vscode);
    assert.ok(api);
    assert.deepEqual(Object.keys(api), ['test']);
    assert.deepEqual(Object.keys(api.test).sort(),
      ['clearTerminal', 'contextKeys', 'filesChildren', 'intellisense', 'state', 'statusBarTexts', 'terminalInputs', 'terminalText', 'waitForState']);
    await settle(30);
    const st = api.test.state();
    assert.equal(st.bridge, 'stopped', 'activation does not start the bridge');
    assert.equal(st.state, 'disconnected');
    assert.match(api.test.statusBarTexts().board, /No board/);
    assert.deepEqual(await api.test.filesChildren(), [], 'no port: the Files view is empty on purpose (welcome text)');
    assert.equal(api.test.terminalText(), '');
    assert.deepEqual(api.test.terminalInputs(), []);
    assert.deepEqual(api.test.contextKeys(), {
      'upy-bridge.hasPort': false, 'upy-bridge.connected': false, 'upy-bridge.running': false, 'upy-bridge.interpreterProblem': false,
    }, 'the keys VS Code accepted, hyphenated prefix included');
    assert.deepEqual(mock.config.updates, [], 'the hook writes no setting');
  });

  it('state() is a copy, and waitForState resolves at once or rejects after the timeout', async () => {
    process.env[TEST_SWITCH] = '1';
    const api = activate(ctx.vscode);
    assert.ok(api);
    const first = api.test.state();
    assert.notEqual(first, api.test.state(), 'a fresh copy every time');
    assert.equal((await api.test.waitForState(['disconnected'], 50)).state, 'disconnected');
    await assert.rejects(api.test.waitForState(['idle'], 30), /timed out after 30 ms waiting for board state idle/);
  });
});

describe('the terminal tap', () => {
  it('records plain output and every input, and leaves the terminal itself unchanged', async () => {
    mock.reset();
    const recorder = new TestRecorder();
    const h = makeHarness(FakeSession.connected());
    const term = new ReplTerminal(h.services, { tap: recorder.tap });
    try {
      term.show();
      const t = mock.terminals[0];
      assert.ok(t);
      await t.opened;
      await settle();
      h.session.emit({ ev: 'out', bytes: enc('hello\n') });
      h.session.emit({ ev: 'err', bytes: enc('boom\r\n') });
      t.type('1+2\r');
      await settle(10);
      assert.match(t.output, /hello/, 'the terminal still shows the output');
      assert.match(t.output, /\x1b\[31m/, 'and still colours errors');
      const tapped = (recorder as unknown as { output: string }).output;
      assert.match(tapped, /hello/);
      assert.match(tapped, /boom/);
      assert.ok(!tapped.includes('\x1b[31m'), 'the tap sees the text before the colour codes are added');
      assert.deepEqual((recorder as unknown as { inputs: string[] }).inputs, ['1+2\r']);
    } finally {
      term.dispose();
      h.session.dispose();
      h.dispose();
    }
  });

  it('a terminal without a tap behaves as before', async () => {
    const h = makeHarness(FakeSession.connected());
    const term = new ReplTerminal(h.services);
    try {
      term.show();
      const t = mock.terminals[0];
      assert.ok(t);
      await t.opened;
      h.session.emit({ ev: 'out', bytes: enc('plain\n') });
      await settle(10);
      assert.match(t.output, /plain/);
    } finally {
      term.dispose();
      h.session.dispose();
      h.dispose();
    }
  });
});
