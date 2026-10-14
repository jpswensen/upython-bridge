/**
 * "Reset board..." (D-16, RQ-RESET-1..5, docs/protocol-addendum-reset.md): ONE quick pick that lists only the resets that apply.
 *
 *   Restart Python (soft reset)   reset.soft      Ctrl-D: fresh Python session, the chip keeps running; no confirmation
 *   Reboot board (software)       reset.machine   machine.reset() through the REPL; needs no control lines; confirmation
 *   Reset with RTS/DTR line       reset.hard      control line pulse, for a hung board; only when verified/likely
 *                                                 (or unknown AND the user turned on reset.showUnverifiedHardReset); confirmation,
 *                                                 and the first use is a verification whose result is remembered
 *
 * Nothing here is implicit: this file is reached only through the command, every tier above soft shows a confirmation with the
 * firmware profile's warning (generic text without one), and `confirmed: true` is sent only after the user said yes. Stop never
 * calls into this file by itself; it can only offer the command (RQ-SAFE-2/3).
 *
 * This file also keeps the context key `hardResetAvailable` current (RQ-RESET-3).
 */
import * as vscode from 'vscode';
import { COMMAND_IDS, CONTEXT } from '../contributes';
import { IDENTITY } from '../identity';
import { registerGuarded, reportError, reportWarning } from '../repl/commandSupport';
import { showToast } from '../toast';
import type { HardResetCapability, LearnedReset, OpArgs, ResetCacheKey, ResetCapability } from '../types/protocol';
import type { Services } from '../types/services';
import { isBoardError, userMessage } from '../types/session';
import type { MementoLike } from '../types/settings';

export const DEFAULT_RESET_WARNING = 'A reset restarts the board and may move connected hardware.';

export type ResetTier = 'soft' | 'machine' | 'hard';

export const RESET_LABELS: Record<ResetTier, string> = {
  soft: 'Restart Python (soft reset)',
  machine: 'Reboot board (software)',
  hard: 'Reset with RTS/DTR line',
};

const FALLBACK_NOT_OBSERVED_HINT = "Press the board's EN or reset button, or unplug the USB cable and plug it in again.";
const MACHINE_TIMEOUT_MS = 30_000;
const HARD_TIMEOUT_MS = 60_000;

/** Hard reset is offered when it is known or likely to work; `unknown` only when the user asked to see it. */
export function hardResetOffered(hard: HardResetCapability | null, showUnverified: boolean): boolean {
  if (!hard) {
    return false;
  }
  return hard.state === 'verified' || hard.state === 'likely' || (hard.state === 'unknown' && showUnverified);
}

/** The context key `hardResetAvailable`: verified or likely (RQ-RESET-3). */
export function hardResetAvailable(hard: HardResetCapability | null): boolean {
  return hard !== null && (hard.state === 'verified' || hard.state === 'likely');
}

/** The tiers to list for a capability, in menu order. Soft is always there. */
export function resetOptions(cap: ResetCapability, showUnverifiedHardReset: boolean): ResetTier[] {
  const tiers: ResetTier[] = ['soft'];
  if (cap.machine.available) {
    tiers.push('machine');
  }
  if (hardResetOffered(cap.hard, showUnverifiedHardReset)) {
    tiers.push('hard');
  }
  return tiers;
}

/** What the extension knows about this adapter + board from earlier verifications (RQ-RESET-4), in extension storage. */
export class LearnedResetStore {
  private readonly storeKey = `${IDENTITY.prefix}.resetLearned`;

  /** `store` is `context.globalState`. */
  constructor(private readonly store: MementoLike) {}

  static id(key: ResetCacheKey): string {
    return `${key.vid ?? '-'}:${key.pid ?? '-'}:${key.uniqueId ?? '-'}`;
  }

  get(key: ResetCacheKey): LearnedReset {
    const all = this.store.get<Record<string, unknown>>(this.storeKey) ?? {};
    const v = all[LearnedResetStore.id(key)];
    return v === 'verified' || v === 'failed' ? v : null;
  }

  async set(key: ResetCacheKey, value: 'verified' | 'failed'): Promise<void> {
    if (key.vid === null && key.pid === null && key.uniqueId === null) {
      return; // nothing identifies this board: a record would apply to every board
    }
    const all = { ...(this.store.get<Record<string, unknown>>(this.storeKey) ?? {}), [LearnedResetStore.id(key)]: value };
    await this.store.update(this.storeKey, all);
  }
}

/** What the reset command needs from a learned-results store; the session's store (src/session/learnedReset.ts) satisfies it. */
export interface LearnedResults {
  get(key: ResetCacheKey): LearnedReset;
  set(key: ResetCacheKey, value: 'verified' | 'failed'): Promise<void>;
}

export interface ResetDeps {
  /** The firmware profile's `resetWarning`, when a profile is loaded (D-15). Without it the generic text is shown. */
  resetWarning?: () => string | undefined;
  /** Where learned verification results live; the integrator shares the session's store. Default: `context.globalState`. */
  learned?: LearnedResults;
}

interface TierPick extends vscode.QuickPickItem {
  tier: ResetTier;
}

export class ResetCommand {
  private readonly learned: LearnedResults;
  /** Tiers the user said "don't ask again this session" for. Lives and dies with this object (the window). */
  private readonly skipConfirm = new Set<'machine' | 'hard'>();
  private seq = 0;
  private lastSignature = '';

  constructor(private readonly services: Services, private readonly deps: ResetDeps = {}) {
    this.learned = deps.learned ?? new LearnedResetStore(services.context.globalState);
  }

  // ---------------------------------------------------------------- the command

  async run(): Promise<void> {
    const { session, settings } = this.services;
    if (session.state.state === 'disconnected') {
      const choice = await vscode.window.showInformationMessage(
        'No board is connected, so there is nothing to reset. Choose Select Serial Port first.',
        'Select Serial Port',
      );
      if (choice === 'Select Serial Port') {
        await vscode.commands.executeCommand(COMMAND_IDS.selectPort);
      }
      return;
    }
    let cap: ResetCapability;
    try {
      cap = await this.capability();
    } catch (err) {
      await reportError(this.services, 'Could not check which resets this board supports.', err);
      return;
    }
    const items: TierPick[] = resetOptions(cap, settings.showUnverifiedHardReset).map((tier) => this.pickItem(tier, cap));
    const picked = await vscode.window.showQuickPick<TierPick>(items, {
      title: 'Reset board',
      placeHolder: 'How should the board restart?',
      matchOnDetail: true,
    });
    if (!picked) {
      return;
    }
    switch (picked.tier) {
      case 'soft':
        await this.softReset();
        break;
      case 'machine':
        if (await this.confirm('machine', cap)) {
          await this.machineReset();
        }
        break;
      case 'hard':
        if (await this.confirm('hard', cap)) {
          await this.hardReset(cap);
        }
        break;
    }
  }

  private pickItem(tier: ResetTier, cap: ResetCapability): TierPick {
    switch (tier) {
      case 'soft':
        return {
          tier,
          label: RESET_LABELS.soft,
          detail: 'Starts a fresh Python session and runs boot.py and main.py again. The board itself is not restarted.',
        };
      case 'machine':
        return {
          tier,
          label: RESET_LABELS.machine,
          detail: 'Restarts the whole board, like pressing its reset button. Needs no special wiring. Asks first.',
        };
      case 'hard': {
        const how: Record<HardResetCapability['state'], string> = {
          verified: 'Works even when the program ignores Stop. It worked on this board before.',
          likely: 'For a board that does not respond. Should work with this USB adapter; the first use checks that it did.',
          unknown: 'For a board that does not respond. Not known to work with this USB adapter. The first use checks.',
          unlikely: 'Probably not supported by this USB adapter.',
          failed: 'Did not work on this board before.',
        };
        return { tier, label: RESET_LABELS.hard, detail: `${how[cap.hard?.state ?? 'unknown']} Asks first.` };
      }
    }
  }

  /** `reset.capability`; a bridge without it (E_UNSUPPORTED) only offers the soft reset. */
  private async capability(): Promise<ResetCapability> {
    const learned = this.learned.get(this.keyFromState());
    try {
      return await this.services.session.call('reset.capability', learned === null ? {} : { learned });
    } catch (err) {
      if (isBoardError(err, 'E_UNSUPPORTED')) {
        this.services.log.info('The bridge has no reset.capability: offering only the soft reset.');
        return { soft: true, machine: { available: false, reason: 'This version of the connection helper cannot reboot the board.' }, hard: null, cacheKey: this.keyFromState() };
      }
      throw err;
    }
  }

  private keyFromState(): ResetCacheKey {
    const st = this.services.session.state;
    return { vid: st.portInfo?.vid ?? null, pid: st.portInfo?.pid ?? null, uniqueId: st.identity?.uniqueId || null };
  }

  // ---------------------------------------------------------------- confirmation

  private async confirm(tier: 'machine' | 'hard', cap: ResetCapability): Promise<boolean> {
    if (this.skipConfirm.has(tier)) {
      return true;
    }
    const warning = (this.deps.resetWarning?.() ?? '').trim() || DEFAULT_RESET_WARNING;
    const copy =
      tier === 'machine'
        ? {
            title: 'Reboot the board?',
            detail: 'The whole board restarts, like pressing its reset button. The running program stops, then boot.py and main.py run again.',
            go: 'Reboot board',
            quiet: "Reboot, and don't ask again this session",
          }
        : {
            title: 'Reset the board with the RTS/DTR line?',
            detail:
              cap.hard?.state === 'verified'
                ? "This presses the board's reset button through the USB adapter's control lines. It worked on this board before."
                : "This presses the board's reset button through the USB adapter's control lines. Because it has not been tried on this board yet, the extension also checks that it worked and remembers the result.",
            go: 'Reset with RTS/DTR line',
            quiet: "Reset, and don't ask again this session",
          };
    const choice = await vscode.window.showWarningMessage(
      copy.title,
      { modal: true, detail: `${warning}\n\n${copy.detail}` },
      copy.go,
      copy.quiet,
    );
    if (choice === copy.quiet) {
      this.skipConfirm.add(tier);
      return true;
    }
    return choice === copy.go;
  }

  // ---------------------------------------------------------------- the three tiers

  private async softReset(): Promise<void> {
    try {
      await this.services.session.call('reset.soft', {}, { timeoutMs: MACHINE_TIMEOUT_MS });
      vscode.window.setStatusBarMessage('Python restarted on the board.', 5000);
    } catch (err) {
      await this.reportResetError('Could not restart Python.', err);
    }
  }

  private async machineReset(): Promise<void> {
    const { session } = this.services;
    const opts = { timeoutMs: MACHINE_TIMEOUT_MS };
    try {
      let res;
      try {
        res = await session.call('reset.machine', { confirmed: true }, opts);
      } catch (err) {
        if (!(isBoardError(err, 'E_PROGRAM_RUNNING') && err.needsInterrupt)) {
          throw err;
        }
        const ok = await reportWarning(this.services, 'A program is running on the board. Stop it and reboot the board?', 'Stop and reboot');
        if (ok !== 'Stop and reboot') {
          return;
        }
        res = await session.call('reset.machine', { confirmed: true, interrupt: true }, opts);
      }
      await this.announceRestart(res.reconnect || res.portDropped, 'Board rebooted.');
    } catch (err) {
      await this.reportResetError('Could not reboot the board.', err);
    }
  }

  private async hardReset(cap: ResetCapability): Promise<void> {
    const { session, log } = this.services;
    const key = cap.cacheKey ?? this.keyFromState();
    const learned = this.learned.get(key);
    const verify = cap.hard?.state !== 'verified' && learned !== 'verified';
    const args: OpArgs<'reset.hard'> = { confirmed: true, verify, ...(learned === null ? {} : { learned }) };
    try {
      const res = await session.call('reset.hard', args, { timeoutMs: HARD_TIMEOUT_MS });
      if (res.learned) {
        await this.remember(res.cacheKey ?? key, res.learned);
      }
      const hint = (res as { hint?: unknown }).hint;
      if (res.unsafeSequence === true || res.verified === false) {
        await reportWarning(
          this.services,
          typeof hint === 'string' && hint !== '' ? hint : "The chip stayed in the bootloader. Press the board's EN or reset button, or unplug the USB cable and plug it in again.",
        );
        return;
      }
      await this.announceRestart(res.reconnect === true || res.portDropped === true, 'Board reset with the RTS/DTR line.');
    } catch (err) {
      if (isBoardError(err, 'E_RESET_NOT_OBSERVED')) {
        log.warn('Hard reset verification saw no reset: remembering that it does not work for this board', err);
        await this.remember(key, 'failed');
      }
      await this.reportResetError('The reset with the RTS/DTR line did not work.', err);
    }
  }

  private async announceRestart(boardDropsConnection: boolean, done: string): Promise<void> {
    if (boardDropsConnection) {
      // Not awaited: a toast without buttons only settles when it is dismissed (src/toast.ts).
      void showToast(
        this.services.log,
        'info',
        'The board is restarting. The connection comes back by itself in a few seconds. If it does not, choose Select Serial Port.',
      );
    } else {
      vscode.window.setStatusBarMessage(done, 5000);
    }
  }

  /** A hard reset result changes what is offered next time: remember it and refresh the context key. */
  private async remember(key: ResetCacheKey, value: 'verified' | 'failed'): Promise<void> {
    try {
      await this.learned.set(key, value);
    } catch (err) {
      this.services.log.warn('Could not save what was learned about the reset', err);
    }
    this.lastSignature = '';
    await this.refreshContext();
  }

  private async reportResetError(prefix: string, err: unknown): Promise<void> {
    if (isBoardError(err, 'E_UNSUPPORTED')) {
      await reportWarning(this.services, `${prefix} ${userMessage(err)}`);
      return;
    }
    if (isBoardError(err, 'E_RESET_NOT_OBSERVED')) {
      this.services.log.warn(prefix, err);
      const hint = err.hint !== '' ? '' : ` ${FALLBACK_NOT_OBSERVED_HINT}`;
      await reportWarning(this.services, `${userMessage(err)}${hint}`);
      return;
    }
    await reportError(this.services, prefix, err);
  }

  // ---------------------------------------------------------------- context key

  /** Keep `hardResetAvailable` in step with the connection (RQ-RESET-3). Returns what to dispose. */
  watch(): vscode.Disposable {
    const sub = this.services.session.onDidChangeState(() => {
      void this.refreshContext();
    });
    void this.refreshContext();
    return new vscode.Disposable(() => sub.dispose());
  }

  private async refreshContext(): Promise<void> {
    const { session, log } = this.services;
    const st = session.state;
    const link = st.state === 'disconnected' ? 'off' : st.state === 'connecting' ? 'connecting' : 'on';
    const signature = `${link}|${st.port ?? ''}|${st.portInfo?.vid ?? ''}|${st.portInfo?.pid ?? ''}|${st.identity?.uniqueId ?? ''}`;
    if (signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;
    const seq = ++this.seq;
    let available = false;
    if (link === 'on') {
      try {
        const cap = await this.capability();
        available = hardResetAvailable(cap.hard);
      } catch (err) {
        log.debug(`reset.capability: ${userMessage(err)}`);
      }
    }
    if (seq === this.seq) {
      await vscode.commands.executeCommand('setContext', CONTEXT.hardResetAvailable, available);
    }
  }
}

export function registerReset(services: Services, deps: ResetDeps = {}): vscode.Disposable[] {
  const reset = new ResetCommand(services, deps);
  return [registerGuarded(services, COMMAND_IDS.resetBoard, () => reset.run(), undefined), reset.watch()];
}
