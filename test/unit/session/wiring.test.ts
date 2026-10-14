/**
 * The VS Code adapters of the session (questions, progress) and the wiring function used by activate(), against the vscode mock.
 * Nothing here starts the bridge or opens a port.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createBoardSession, projectFolder } from '../../../src/session';
import { DELETE_ANYWAY, STOP_AND_CONTINUE, VscodeSessionUi } from '../../../src/session/vscodeUi';
import { BoardError } from '../../../src/types/session';
import { PortMemory, Settings } from '../../../src/types/settings';
import { TempDirs, makeTrickyDir } from '../../mocks/fixtures';
import type { MockExtensionContext } from '../../mocks/extensionContext';
import { createExtensionContext, mock } from '../../mocks/vscode';
import { MemoryLog } from '../bridge/stubChild';

const dirs = new TempDirs();
let ctx: MockExtensionContext | undefined;
beforeEach(() => mock.reset());
afterEach(() => {
  ctx?.dispose();
  ctx = undefined;
  mock.reset();
  dirs.cleanup();
});

describe('VscodeSessionUi', () => {
  it('asks to stop a running program in a modal question with the hint as detail; only the button means yes', async () => {
    const ui = new VscodeSessionUi(new MemoryLog().logger);
    const err = BoardError.of('E_PROGRAM_RUNNING', 'A program is running on the board.', { hint: 'Press Stop first, or confirm that it may be interrupted.', needs_interrupt: true });
    mock.answerMessage(/program is running/, STOP_AND_CONTINUE, { once: true });
    assert.equal(await ui.confirmInterrupt('fs.put', err), true);
    const asked = mock.messages('warn')[0];
    assert.ok(asked?.modal);
    assert.match(asked?.detail ?? '', /Ctrl-C is sent to the board/);
    assert.deepEqual(asked?.items, [STOP_AND_CONTINUE]);
    assert.equal(await ui.confirmInterrupt('fs.put', err), false, 'dismissing the question is a no');
  });

  it('names the drive before deleting it, and warns without blocking', async () => {
    const ui = new VscodeSessionUi(new MemoryLog().logger);
    mock.answerMessage(/drive of the board/, DELETE_ANYWAY);
    assert.equal(await ui.confirmAllowMount('/flash', BoardError.of('E_FS_ERRNO', 'Refused.', { needs_allow_mount: true })), true);
    mock.answerMessage(/hello/, 'Retry');
    assert.equal(await ui.warn('hello', 'Retry'), 'Retry');
    ui.info('done');
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(mock.messages('info').some((m) => m.message === 'done'));
  });

  it('shows progress as a notification with increments', async () => {
    const ui = new VscodeSessionUi(new MemoryLog().logger);
    await ui.withProgress('Uploading to the board', async (report) => {
      report('a.py (25%)', 0.25);
      report('a.py (100%)', 1);
      return 1;
    });
    const p = mock.calls.progress[0];
    assert.equal(p?.options.title, 'Uploading to the board');
    assert.deepEqual(p?.reports.map((r) => r.increment), [25, 75]);
    assert.equal(p?.done, true);
  });
});

describe('createBoardSession', () => {
  it('builds the session without starting anything, and checks the interpreter on request', async () => {
    ctx = createExtensionContext();
    const log = new MemoryLog();
    const folder = makeTrickyDir(dirs.make('upy-bridge-wire'));
    mock.setWorkspaceFolders(folder);
    assert.equal(projectFolder(), folder);
    const bundle = createBoardSession({ context: ctx.vscode, log: log.logger, settings: new Settings(), portMemory: new PortMemory(ctx.workspaceState) });
    try {
      assert.equal(bundle.session.state.bridge, 'stopped');
      assert.equal(bundle.client.status, 'stopped');
      assert.equal(bundle.session.state.interpreter, 'unknown');
      assert.equal(bundle.session.selectedPort, null);
      assert.deepEqual(ctx.workspaceState.writes, [], 'nothing is written at startup');
      const check = await bundle.session.checkInterpreter();
      assert.equal(typeof check.ok, 'boolean');
      assert.equal(bundle.session.state.interpreter, check.ok ? 'ok' : 'problem');
      assert.equal(bundle.client.status, 'stopped', 'checking Python does not start the bridge');
    } finally {
      bundle.session.dispose();
    }
  });
});
