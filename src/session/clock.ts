/**
 * The board clock (decision D-22). After a connect, as soon as the board is idle at a prompt, the clock is read; when it was
 * never set (a year before 2024: an ESP32 without NTP starts in 2000) it is set from this computer's LOCAL time, so files and
 * data logs that programs write get real dates. A clock that already looks real is left alone unless the setting says
 * `always`. Never while a program runs (the bridge refuses with E_PROGRAM_RUNNING; the check waits for the next idle moment),
 * never a reset, never a file. The command "Set the Board Clock from This Computer" sets it on request.
 */
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../contributes';
import { showToast } from '../toast';
import type { BoardClock } from '../types/protocol';
import type { Services } from '../types/services';
import { isBoardError, type SessionState } from '../types/session';

/** [year, month, day, hour, minute, second, weekday (0 = Monday)] of `now` in this computer's time zone. */
export function localClockFields(now: Date): [number, number, number, number, number, number, number] {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(), (now.getDay() + 6) % 7];
}

/** "2026-10-13 14:25" for messages. */
export function formatClock(t: readonly number[]): string {
  const two = (n: number | undefined): string => String(n ?? 0).padStart(2, '0');
  return `${t[0] ?? 0}-${two(t[1])}-${two(t[2])} ${two(t[3])}:${two(t[4])}`;
}

export class BoardClockKeeper implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** A connect happened and the check has not run for it yet. */
  private due = false;
  private busy = false;
  private last: SessionState['state'];

  constructor(private readonly services: Services, private readonly now: () => Date = () => new Date()) {
    this.last = services.session.state.state;
    this.disposables.push(services.session.onDidChangeState((s) => this.onState(s)));
    this.disposables.push(vscode.commands.registerCommand(COMMAND_IDS.setBoardClock, () => this.setOnRequest()));
  }

  dispose(): void {
    this.disposables.splice(0).forEach((d) => d.dispose());
  }

  private onState(s: SessionState): void {
    const prev = this.last;
    this.last = s.state;
    if (s.state === 'disconnected') { this.due = false; return; }
    if ((prev === 'disconnected' || prev === 'connecting') && s.state !== 'connecting') { this.due = true; }
    if (this.due && s.state === 'idle') { void this.checkAfterConnect(); }
  }

  /** Runs once per connection, the first time the board is idle. Every failure is logged; nothing is shown unless the clock was set. */
  async checkAfterConnect(): Promise<BoardClock | undefined> {
    const { session, settings, log } = this.services;
    const mode = settings.boardClockOnConnect;
    if (mode === 'off' || this.busy || !this.due) { this.due = mode === 'off' ? false : this.due; return undefined; }
    this.busy = true;
    try {
      const before = await session.call('clock.read', { background: true }, { timeoutMs: 15000 });
      this.due = false;
      if (!before.rtc) {
        log.info('clock: this board has no settable real-time clock (no machine.RTC); nothing to do');
        return before;
      }
      if (mode === 'whenUnset' && before.plausible) {
        log.info(`clock: the board clock already looks set (${formatClock(before.time)}); left alone`);
        return before;
      }
      const after = await session.call('clock.set', { time: localClockFields(this.now()), background: true }, { timeoutMs: 15000 });
      log.info(`clock: set the board clock from ${formatClock(before.time)} to ${formatClock(after.time)}`);
      if (!before.plausible) {
        void showToast(log, 'info', `Set the board's clock to ${formatClock(after.time)} from this computer (it showed the year ${before.time[0]}).`);
      }
      return after;
    } catch (err) {
      if (isBoardError(err, 'E_PROGRAM_RUNNING')) {
        log.info('clock: a program is running; the clock is checked the next time the board is idle');
      } else {
        this.due = false;
        log.warn('clock: could not check or set the board clock', err);
      }
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  /** The command: set the clock now (asks for a port when needed), and say what happened. */
  async setOnRequest(): Promise<BoardClock | undefined> {
    const { session, log } = this.services;
    if (session.state.state === 'disconnected' || session.state.state === 'connecting') {
      const ok = await vscode.commands.executeCommand<boolean>(COMMAND_IDS.selectPort, { reuse: true });
      if (ok !== true) { return undefined; }
    }
    try {
      const after = await session.call('clock.set', { time: localClockFields(this.now()) }, { timeoutMs: 15000 });
      this.due = false;
      void showToast(log, 'info', `The board's clock is now ${formatClock(after.time)} (from this computer). A power cycle may reset it; it is set again when you connect.`);
      return after;
    } catch (err) {
      log.warn('clock: setting the board clock on request failed', err);
      const text = isBoardError(err, 'E_PROGRAM_RUNNING')
        ? 'A program is running on the board. Press Stop first, then set the clock again.'
        : isBoardError(err, 'E_UNSUPPORTED')
          ? 'This board has no clock that can be set.'
          : `The board's clock could not be set. ${err instanceof Error ? err.message : String(err)}`;
      void showToast(log, 'warning', text);
      return undefined;
    }
  }
}
