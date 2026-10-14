/**
 * Decision D-22: the board clock is set from this computer after a connect when it is unset (year before 2024), only on an idle
 * board, once per connection; a clock that looks real is left alone unless the setting says `always`; `off` does nothing; the
 * command sets it on request and says what happened.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { settingId } from '../../src/identity';
import { BoardClockKeeper, formatClock, localClockFields } from '../../src/session/clock';
import type { BoardClock } from '../../src/types/protocol';
import type { Services } from '../../src/types/services';
import { BoardError } from '../../src/types/session';
import { PortMemory, Settings } from '../../src/types/settings';
import { FakeSession } from '../mocks/fakeSession';
import { createExtensionContext, createTestLogger, mock } from '../mocks/vscode';
import { COMMAND_IDS } from '../../src/contributes';
import * as vscode from 'vscode';

const UNSET: BoardClock = { rtc: true, time: [2000, 1, 1, 0, 3, 12, 5], plausible: false };
const REAL: BoardClock = { rtc: true, time: [2026, 10, 13, 14, 20, 0, 0], plausible: true };
const NOW = new Date(2026, 9, 13, 14, 25, 30); // a Tuesday, local time

let keeper: BoardClockKeeper | undefined;
let disposeCtx: (() => void) | undefined;
beforeEach(() => mock.reset());
afterEach(() => { keeper?.dispose(); keeper = undefined; disposeCtx?.(); mock.reset(); });

function setup(mode: string, read: BoardClock | BoardError, session = new FakeSession()): { session: FakeSession; keeper: BoardClockKeeper } {
  mock.config.set(settingId('board.setClockOnConnect'), mode);
  const ctx = createExtensionContext();
  disposeCtx = () => ctx.dispose();
  const { log } = createTestLogger();
  const services: Services = { context: ctx.vscode, log, settings: new Settings(), session, portMemory: new PortMemory(ctx.workspaceState) };
  session.script('clock.read', read);
  session.script('clock.set', (args) => ({ rtc: true, time: args.time, plausible: true }));
  keeper = new BoardClockKeeper(services, () => NOW);
  return { session, keeper };
}

async function settle(): Promise<void> { for (let i = 0; i < 20; i++) { await new Promise((r) => setImmediate(r)); } }

describe('D-22 board clock', () => {
  it('local time fields: weekday 0 = Monday, months from 1', () => {
    assert.deepEqual(localClockFields(NOW), [2026, 10, 13, 14, 25, 30, 1]);
    assert.equal(localClockFields(new Date(2026, 9, 18, 9, 0, 0))[6], 6, 'Sunday is 6');
    assert.equal(formatClock([2026, 10, 3, 9, 5, 0, 4]), '2026-10-03 09:05');
  });

  it('an unset clock is set once after connect, from the local time, and the student is told', async () => {
    const { session } = setup('whenUnset', UNSET);
    await session.connect('/dev/cu.fake');
    await settle();
    assert.equal(session.callsOf('clock.set').length, 1);
    assert.deepEqual(session.argsOf('clock.set')[0]?.time, [2026, 10, 13, 14, 25, 30, 1]);
    assert.match(mock.messages('info')[0]?.message ?? '', /Set the board's clock to 2026-10-13 14:25 .*year 2000/);
    session.setState({ state: 'running' });
    session.setState({ state: 'idle' });
    await settle();
    assert.equal(session.callsOf('clock.read').length, 1, 'once per connection, not after every run');
  });

  it('a clock that already looks real is left alone (and nothing is shown)', async () => {
    const { session } = setup('whenUnset', REAL);
    await session.connect('/dev/cu.fake');
    await settle();
    assert.equal(session.callsOf('clock.set').length, 0);
    assert.equal(mock.messages().length, 0);
  });

  it('`always` sets a real-looking clock too, quietly; `off` never reads it', async () => {
    const a = setup('always', REAL);
    await a.session.connect('/dev/cu.fake');
    await settle();
    assert.equal(a.session.callsOf('clock.set').length, 1);
    assert.equal(mock.messages().length, 0);
    keeper?.dispose();
    const b = setup('off', UNSET);
    await b.session.connect('/dev/cu.fake');
    await settle();
    assert.equal(b.session.callsOf('clock.read').length + b.session.callsOf('clock.set').length, 0);
  });

  it('a program running at connect: nothing until the board is idle, then once', async () => {
    const session = new FakeSession();
    session.script('connect', { state: 'running', sync: 'running-program', portInfo: { port: '/dev/cu.fake' } as never });
    setup('whenUnset', UNSET, session);
    await session.connect('/dev/cu.fake');
    await settle();
    assert.equal(session.callsOf('clock.read').length, 0, 'a running main.py is not disturbed');
    session.setState({ state: 'idle' });
    await settle();
    assert.equal(session.callsOf('clock.set').length, 1);
  });

  it('a board without an RTC is left alone', async () => {
    const { session } = setup('whenUnset', { ...UNSET, rtc: false });
    await session.connect('/dev/cu.fake');
    await settle();
    assert.equal(session.callsOf('clock.set').length, 0);
  });

  it('the command sets the clock on request and explains a running program', async () => {
    const session = FakeSession.connected();
    setup('off', REAL, session);
    mock.track(vscode.commands.registerCommand(COMMAND_IDS.selectPort, async () => true));
    await vscode.commands.executeCommand(COMMAND_IDS.setBoardClock);
    assert.equal(session.callsOf('clock.set').length, 1);
    assert.match(mock.messages('info').at(-1)?.message ?? '', /The board's clock is now 2026-10-13 14:25/);
    session.fail('clock.set', 'E_PROGRAM_RUNNING', 'A program is running.');
    await vscode.commands.executeCommand(COMMAND_IDS.setBoardClock);
    assert.match(mock.messages('warn').at(-1)?.message ?? '', /Press Stop first/);
  });
});
