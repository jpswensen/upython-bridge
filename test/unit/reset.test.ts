/** "Reset board..." (src/commands/reset.ts): one quick pick, three tiers, confirmation, learned hard-reset results (D-16). */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COMMAND_IDS, CONTEXT } from '../../src/contributes';
import { settingId } from '../../src/identity';
import { DEFAULT_RESET_WARNING, LearnedResetStore, RESET_LABELS, hardResetAvailable, hardResetOffered, registerReset, resetOptions, type ResetDeps } from '../../src/commands/reset';
import type { HardResetCapability, ResetCacheKey, ResetCapability } from '../../src/types/protocol';
import { FakeSession } from '../mocks/fakeSession';
import { mock } from '../mocks/vscode';
import { makeHarness, settle, stubCommand, type Harness } from './repl.helpers';

const KEY: ResetCacheKey = { vid: 0x10c4, pid: 0xea60, uniqueId: 'aabbccddeeff' };
const hard = (state: HardResetCapability['state']): HardResetCapability => ({ state, method: 'rts-pulse', reason: 'test', basis: 'adapter' });
const cap = (h: HardResetCapability | null, machine = true): ResetCapability => ({ soft: true, machine: { available: machine, reason: 'test' }, hard: h, cacheKey: KEY });

let h: Harness;
let installed = false;

function install(session: FakeSession, deps: ResetDeps = {}): void {
  installed = true;
  h = makeHarness(session);
  stubCommand(h, COMMAND_IDS.selectPort, true);
  for (const d of registerReset(h.services, deps)) {
    mock.track(d);
  }
}

const reset = (): Promise<unknown> => Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.resetBoard));
const labels = (): string[] => mock.calls.quickPicks.at(-1)?.labels ?? [];
const resetOps = (): { op: string; args: unknown }[] => h.session.calls.filter((c) => /^reset\.(soft|machine|hard)$/.test(c.op)).map((c) => ({ op: c.op, args: c.args }));
const modals = () => mock.messages('warn').filter((m) => m.modal);

beforeEach(() => mock.reset());
afterEach(() => {
  if (installed) {
    h.session.dispose();
    h.dispose();
    installed = false;
  }
  mock.reset();
});

describe('which options are offered (pure)', () => {
  const states: HardResetCapability['state'][] = ['verified', 'likely', 'unknown', 'unlikely', 'failed'];
  it('hard reset: verified and likely always, unknown only when the setting asks, unlikely and failed never', () => {
    const expected: Record<string, [boolean, boolean]> = {
      verified: [true, true], likely: [true, true], unknown: [false, true], unlikely: [false, false], failed: [false, false],
    };
    for (const s of states) {
      assert.equal(hardResetOffered(hard(s), false), expected[s]?.[0], `${s} without the setting`);
      assert.equal(hardResetOffered(hard(s), true), expected[s]?.[1], `${s} with the setting`);
    }
    assert.equal(hardResetOffered(null, true), false);
  });

  it('the context key is true for verified and likely only', () => {
    assert.deepEqual(states.map((s) => hardResetAvailable(hard(s))), [true, true, false, false, false]);
    assert.equal(hardResetAvailable(null), false);
  });

  it('options are soft, then machine when available, then hard when offered', () => {
    assert.deepEqual(resetOptions(cap(hard('likely')), false), ['soft', 'machine', 'hard']);
    assert.deepEqual(resetOptions(cap(hard('likely'), false), false), ['soft', 'hard']);
    assert.deepEqual(resetOptions(cap(null, false), true), ['soft']);
  });
});

describe('the quick pick shows only what applies', () => {
  const cases: [string, ResetCapability | 'unsupported', boolean, string[]][] = [
    ['hard likely + machine', cap(hard('likely')), false, [RESET_LABELS.soft, RESET_LABELS.machine, RESET_LABELS.hard]],
    ['hard verified', cap(hard('verified')), false, [RESET_LABELS.soft, RESET_LABELS.machine, RESET_LABELS.hard]],
    ['hard unknown, setting off', cap(hard('unknown')), false, [RESET_LABELS.soft, RESET_LABELS.machine]],
    ['hard unknown, setting on', cap(hard('unknown')), true, [RESET_LABELS.soft, RESET_LABELS.machine, RESET_LABELS.hard]],
    ['hard unlikely, setting on', cap(hard('unlikely')), true, [RESET_LABELS.soft, RESET_LABELS.machine]],
    ['hard failed, setting on', cap(hard('failed')), true, [RESET_LABELS.soft, RESET_LABELS.machine]],
    ['no machine, no hard (a Pico-like board)', cap(hard('unlikely'), false), false, [RESET_LABELS.soft]],
    ['hard unknown to the link (null)', cap(null), true, [RESET_LABELS.soft, RESET_LABELS.machine]],
    ['old bridge without reset.capability (E_UNSUPPORTED)', 'unsupported', true, [RESET_LABELS.soft]],
  ];
  for (const [name, capability, showUnverified, expected] of cases) {
    it(name, async () => {
      install(FakeSession.connected());
      if (capability !== 'unsupported') {
        h.session.script('reset.capability', capability);
      }
      mock.config.set(settingId('reset.showUnverifiedHardReset'), showUnverified);
      await reset();
      assert.deepEqual(labels(), expected);
      assert.deepEqual(resetOps(), [], 'looking at the menu resets nothing');
    });
  }

  it('with no board: a calm message and the way to connect, no menu', async () => {
    install(new FakeSession());
    await reset();
    assert.equal(mock.calls.quickPicks.length, 0);
    assert.match(mock.messages('info').at(-1)?.message ?? '', /No board is connected/);
  });
});

describe('soft reset (Restart Python)', () => {
  it('needs no confirmation and sends reset.soft', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', cap(hard('likely')));
    mock.answerQuickPick(RESET_LABELS.soft);
    await reset();
    assert.deepEqual(resetOps(), [{ op: 'reset.soft', args: {} }]);
    assert.deepEqual(modals(), []);
    assert.equal(mock.calls.statusMessages.at(-1), 'Python restarted on the board.');
  });

  it('cancelling the menu does nothing', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', cap(hard('likely')));
    mock.answerQuickPick(undefined);
    await reset();
    assert.deepEqual(resetOps(), []);
  });
});

describe('reboot board (machine reset)', () => {
  it('shows a modal with the generic warning, and sends confirmed:true only after yes', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', cap(hard('likely')));
    mock.answerQuickPick(RESET_LABELS.machine);
    mock.answerMessage(/Reboot the board\?/, 'Reboot board');
    h.session.script('reset.machine', { phase: 'sent', portDropped: false, reconnect: false, sync: 'prompt' });
    await reset();
    const m = modals();
    assert.equal(m.length, 1);
    assert.ok(m[0]?.detail?.includes(DEFAULT_RESET_WARNING), m[0]?.detail);
    assert.deepEqual(m[0]?.items, ['Reboot board', "Reboot, and don't ask again this session"]);
    assert.deepEqual(resetOps(), [{ op: 'reset.machine', args: { confirmed: true } }]);
  });

  it('shows the profile warning instead of the generic one when a profile provides it', async () => {
    install(FakeSession.connected(), { resetWarning: () => 'Turn motor power off first: the motors can twitch.' });
    h.session.script('reset.capability', cap(hard('likely')));
    mock.answerQuickPick(RESET_LABELS.machine);
    await reset();
    const detail = modals()[0]?.detail ?? '';
    assert.ok(detail.includes('Turn motor power off first'));
    assert.ok(!detail.includes(DEFAULT_RESET_WARNING));
  });

  it('declining or dismissing the modal sends nothing', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', cap(hard('likely')));
    mock.answerQuickPick(RESET_LABELS.machine);
    await reset();
    assert.equal(modals().length, 1);
    assert.deepEqual(resetOps(), []);
  });

  it('"don\'t ask again" is per tier and per session', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', cap(hard('verified')));
    h.session.script('reset.machine', { phase: 'sent', portDropped: false, reconnect: false });
    h.session.script('reset.hard', { verified: null, evidence: [] });
    mock.answerMessage(/Reboot the board\?/, "Reboot, and don't ask again this session");
    mock.answerQuickPick(RESET_LABELS.machine);
    mock.answerQuickPick(RESET_LABELS.machine);
    await reset();
    await reset();
    assert.equal(modals().length, 1, 'asked once');
    assert.equal(resetOps().filter((o) => o.op === 'reset.machine').length, 2);
    mock.answerQuickPick(RESET_LABELS.hard);
    mock.answerMessage(/Reset the board with the RTS/, 'Reset with RTS/DTR line');
    await reset();
    assert.equal(modals().length, 2, 'the hard tier still asks');
  });

  it('a board that drops its USB port says the connection comes back by itself', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', cap(hard('unlikely')));
    h.session.script('reset.machine', { phase: 'sent', portDropped: true, reconnect: true });
    mock.answerQuickPick(RESET_LABELS.machine);
    mock.answerMessage(/Reboot the board\?/, 'Reboot board');
    await reset();
    assert.match(mock.messages('info').at(-1)?.message ?? '', /comes back by itself/);
  });

  it('E_UNSUPPORTED is "not available", with the hint', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', cap(hard('unlikely')));
    h.session.fail('reset.machine', 'E_UNSUPPORTED', 'This board cannot reboot itself from here.', { hint: "Press the board's reset button." });
    mock.answerQuickPick(RESET_LABELS.machine);
    mock.answerMessage(/Reboot the board\?/, 'Reboot board');
    await reset();
    const w = mock.messages('warn').at(-1);
    assert.match(w?.message ?? '', /This board cannot reboot itself from here\. Press the board's reset button\./);
    assert.deepEqual(mock.messages('error'), []);
  });

  it('asks once more when a program is running, then repeats with interrupt:true', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', cap(hard('unlikely')));
    h.session.fail('reset.machine', 'E_PROGRAM_RUNNING', 'A program is running on the board.', { needs_interrupt: true });
    h.session.script('reset.machine', { phase: 'sent', portDropped: false, reconnect: false });
    mock.answerQuickPick(RESET_LABELS.machine);
    mock.answerMessage(/Reboot the board\?/, 'Reboot board');
    mock.answerMessage(/A program is running on the board\. Stop it/, 'Stop and reboot');
    await reset();
    const calls = resetOps().filter((o) => o.op === 'reset.machine').map((o) => o.args);
    assert.deepEqual(calls, [{ confirmed: true }, { confirmed: true, interrupt: true }]);
  });
});

describe('reset with the RTS/DTR line (hard reset)', () => {
  const learnedFromArgs = (args: { learned?: string }): ResetCapability => cap(hard(args.learned === 'failed' ? 'failed' : args.learned === 'verified' ? 'verified' : 'likely'));

  it('verifies on first use, remembers "verified", and the next time just pulses', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', (args) => learnedFromArgs(args as { learned?: string }));
    h.session.script('reset.hard', { verified: true, evidence: ['boot-text'], method: 'rts-pulse', learned: 'verified', cacheKey: KEY });
    mock.answerMessage(/Reset the board with the RTS/, 'Reset with RTS/DTR line');
    mock.answerQuickPick(RESET_LABELS.hard);
    await reset();
    assert.deepEqual(resetOps(), [{ op: 'reset.hard', args: { confirmed: true, verify: true } }]);
    assert.equal(new LearnedResetStore(h.ctx.globalState).get(KEY), 'verified');
    await settle();
    assert.equal(mock.contextKeys.get(CONTEXT.hardResetAvailable), true);
    assert.match(modals()[0]?.detail ?? '', /checks that it worked/);

    mock.answerQuickPick(RESET_LABELS.hard);
    await reset();
    assert.deepEqual(resetOps().at(-1), { op: 'reset.hard', args: { confirmed: true, verify: false, learned: 'verified' } });
  });

  it('E_RESET_NOT_OBSERVED: tells the student to use the EN button or replug, remembers "failed", and hides the option next time', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', (args) => learnedFromArgs(args as { learned?: string }));
    h.session.fail('reset.hard', 'E_RESET_NOT_OBSERVED', 'No sign of a reset was seen after the control line pulse.', { hint: '' });
    mock.answerMessage(/Reset the board with the RTS/, 'Reset with RTS/DTR line');
    mock.answerQuickPick(RESET_LABELS.hard);
    await reset();
    const w = mock.messages('warn').filter((m) => !m.modal).at(-1);
    assert.match(w?.message ?? '', /No sign of a reset was seen/);
    assert.match(w?.message ?? '', /EN or reset button|plug it in again/);
    assert.equal(new LearnedResetStore(h.ctx.globalState).get(KEY), 'failed');
    await settle();
    assert.equal(mock.contextKeys.get(CONTEXT.hardResetAvailable), false);
    mock.answerQuickPick(RESET_LABELS.machine);
    await reset();
    assert.ok(!labels().includes(RESET_LABELS.hard), `hidden after a failed verification: ${labels().join(', ')}`);
  });

  it('a pulse that left the chip in the bootloader is reported with the bridge hint, and remembered as failed', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', cap(hard('likely')));
    h.session.script('reset.hard', { verified: false, evidence: ['waiting-for-download'], method: 'unsafe-sequence', learned: 'failed', unsafeSequence: true, cacheKey: KEY, hint: 'The chip stayed in the ROM bootloader. Press the EN button.' } as never);
    mock.answerMessage(/Reset the board with the RTS/, 'Reset with RTS/DTR line');
    mock.answerQuickPick(RESET_LABELS.hard);
    await reset();
    assert.match(mock.messages('warn').filter((m) => !m.modal).at(-1)?.message ?? '', /ROM bootloader\. Press the EN button/);
    assert.equal(new LearnedResetStore(h.ctx.globalState).get(KEY), 'failed');
  });
});

describe('LearnedResetStore (RQ-RESET-4)', () => {
  it('remembers per (VID, PID, unique id), is not fooled by another board, and ignores a key that identifies nothing', async () => {
    install(FakeSession.connected());
    const store = new LearnedResetStore(h.ctx.globalState);
    assert.equal(store.get(KEY), null);
    await store.set(KEY, 'verified');
    await store.set({ ...KEY, uniqueId: 'other' }, 'failed');
    await store.set({ vid: null, pid: null, uniqueId: null }, 'verified');
    assert.equal(store.get(KEY), 'verified');
    assert.equal(store.get({ ...KEY, uniqueId: 'other' }), 'failed');
    assert.equal(store.get({ ...KEY, pid: 1 }), null);
    assert.equal(store.get({ vid: null, pid: null, uniqueId: null }), null);
    assert.equal(new LearnedResetStore(h.ctx.globalState).get(KEY), 'verified', 'a new object over the same storage sees it');
  });
});

describe('RQ-RESET-5: nothing is implicit', () => {
  it('no reset op is ever sent without a visible confirmation, for every tier, and the confirmed flag is the literal true', async () => {
    install(FakeSession.connected());
    h.session.script('reset.capability', cap(hard('likely')));
    for (const tier of [RESET_LABELS.machine, RESET_LABELS.hard]) {
      mock.answerQuickPick(tier);
      await reset(); // modal dismissed
    }
    assert.deepEqual(resetOps(), []);
    mock.answerMessage(/Reboot the board\?/, 'Reboot board');
    h.session.script('reset.machine', { phase: 'sent', portDropped: false, reconnect: false });
    mock.answerQuickPick(RESET_LABELS.machine);
    await reset();
    const op = resetOps()[0];
    assert.equal(op?.op, 'reset.machine');
    assert.strictEqual((op?.args as { confirmed: unknown }).confirmed, true);
  });
});

describe('context key hardResetAvailable', () => {
  it('follows the connection and the capability', async () => {
    install(new FakeSession());
    await settle();
    assert.equal(mock.contextKeys.get(CONTEXT.hardResetAvailable), false, 'false with no board');
    h.session.script('reset.capability', cap(hard('likely')));
    h.session.setState({ state: 'idle', port: '/dev/cu.fake' });
    await settle();
    assert.equal(mock.contextKeys.get(CONTEXT.hardResetAvailable), true);
    h.session.setState({ state: 'disconnected', port: null });
    await settle();
    assert.equal(mock.contextKeys.get(CONTEXT.hardResetAvailable), false);
    h.session.script('reset.capability', cap(hard('unknown')));
    h.session.setState({ state: 'idle', port: '/dev/cu.other' });
    await settle();
    assert.equal(mock.contextKeys.get(CONTEXT.hardResetAvailable), false, 'unknown is not available (even with the setting)');
  });

  it('an old bridge (no reset.capability) leaves it false and logs at debug level only', async () => {
    install(FakeSession.connected());
    await settle();
    assert.equal(mock.contextKeys.get(CONTEXT.hardResetAvailable), false);
    assert.deepEqual(mock.messages('error'), []);
  });
});
