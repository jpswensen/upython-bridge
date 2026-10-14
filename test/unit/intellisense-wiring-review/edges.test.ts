/** Adversarial review: remaining controller edges (identity wait feedback). The remembered firmware-folder yes and the firmwarePaths setting are gone (2026-10-13). */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IntelliSenseController } from '../../../src/commands/intellisense';
import { FakeSession, FAKE_IDENTITY } from '../../mocks/fakeSession';
import { TempDirs } from '../../mocks/fixtures';
import { mock } from '../../mocks/vscode';
import { makeHarness, settle } from '../repl.helpers';
import { exists, makeProject, openWorkspace, stockBoard, type Rig } from '../intellisense-ui/helpers';

const dirs = new TempDirs();
let rig: Rig | undefined;
beforeEach(() => mock.reset());
afterEach(() => { rig?.h.dispose(); rig = undefined; mock.reset(); dirs.cleanup(); });

const ALL = { createUserConfig: true, editSettings: false };

describe('board identity wait', () => {
  it('a connected board whose identity never arrives: the command waits silently (no progress, no message) before anything is shown', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    const session = new FakeSession();
    session.setState({ state: 'idle', port: '/dev/cu.fake', identity: null });
    const h = makeHarness(session);
    const prompter = new (await import('../../../src/testApi')).ScriptedPrompter();
    prompter.set({ consent: null });
    const controller = new IntelliSenseController(h.services, { prompter, identityWaitMs: 800 });
    rig = { h, session, controller, prompter };
    const t0 = Date.now();
    const run = controller.fix();
    await settle(300);
    const feedbackWhileWaiting = mock.calls.progress.length + mock.calls.messages.length;
    await run;
    assert.ok(Date.now() - t0 >= 700, 'it waited for the identity');
    assert.ok(feedbackWhileWaiting > 0, 'the student clicked and saw nothing at all while the command waited for a board identity that never came');
  });

  it('the identity arriving during the wait is used (stubs of that board)', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    const session = stockBoard(new FakeSession());
    session.setState({ state: 'connecting', port: '/dev/cu.fake', identity: null });
    const h = makeHarness(session);
    const prompter = new (await import('../../../src/testApi')).ScriptedPrompter();
    prompter.set({ consent: ALL });
    const controller = new IntelliSenseController(h.services, { prompter, identityWaitMs: 4000 });
    rig = { h, session, controller, prompter };
    const run = controller.fix();
    await settle(100);
    session.setState({ state: 'idle', port: '/dev/cu.fake', identity: FAKE_IDENTITY });
    const outcome = await run;
    assert.equal(outcome.status, 'applied');
    assert.ok(exists(p.ws, '.upy-bridge', 'stubs', 'active', 'machine.pyi'));
  });
});
