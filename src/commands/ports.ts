/**
 * "Select Serial Port" (D-11, 02-repl-run.md section 10.2) and the single entry point other commands use to make sure a board
 * is connected: `executeCommand<boolean>(COMMAND_IDS.selectPort, { reuse: true })`.
 *
 *  - `ports.list` only reads metadata; it never opens a port. All ports are shown, the ones that look like a MicroPython board
 *    (`likelyBoard`) first, each with VID:PID and product text.
 *  - "Auto" is a UI shortcut, never a port name: with `reuse` and nothing remembered, exactly one likely board is used at once,
 *    several open the list. The word auto is never sent to the session or written to a setting.
 *  - The choice is remembered per workspace (name + VID + PID), so a changed COM number is found again by VID/PID.
 *  - A busy port is explained (who probably holds it) and offers Retry; nothing keeps retrying by itself.
 */
import { offerOpenFolder, projectFolder } from '../projectFolder';
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../contributes';
import { registerGuarded, reportError, reportWarning } from '../repl/commandSupport';
import type { PortRow } from '../types/protocol';
import type { SelectPortArgs, Services } from '../types/services';
import { isBoardError, userMessage } from '../types/session';

const REFRESH_LABEL = 'Refresh list';
const RETRY = 'Retry';
const CHOOSE_ANOTHER = 'Choose another port';
const STOP_AND_SWITCH = 'Stop it and switch';
const SHOW_LOG = 'Show log';
const LIST_TIMEOUT_MS = 20_000;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A port to connect to: a row from `ports.list`, or just a name (a URL such as the fake boards use). */
interface PortTarget {
  device: string;
  vid?: number | null;
  pid?: number | null;
}

interface PortPick extends vscode.QuickPickItem {
  row?: PortRow;
}

const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');
const clean = (s: string): string => (s.trim().toLowerCase() === 'n/a' ? '' : s.trim());

/** macOS: the bridge lists and opens `/dev/cu.*`; `/dev/tty.*` names from older settings are the same device. */
function normalizeDevice(name: string): string {
  return name.replace(/^\/dev\/tty\.(.+)$/, '/dev/cu.$1');
}

function sameDevice(a: string, b: string): boolean {
  const x = normalizeDevice(a);
  const y = normalizeDevice(b);
  return x === y || (/^com\d+$/i.test(x) && x.toLowerCase() === y.toLowerCase());
}

/** Likely boards first, then the rest; each group sorted by name (COM2 before COM10). */
export function rankPorts(rows: readonly PortRow[]): PortRow[] {
  return [...rows].sort((a, b) => Number(b.likelyBoard) - Number(a.likelyBoard) || a.device.localeCompare(b.device, undefined, { numeric: true }));
}

/** "10C4:EA60 - CP2102 USB to UART Bridge Controller (Silicon Labs)": what a student can match with their board. */
export function describePort(row: PortRow): string {
  const ids = row.vid !== null && row.pid !== null ? `${hex4(row.vid)}:${hex4(row.pid)}` : '';
  const name = clean(row.product) || clean(row.description);
  const maker = clean(row.manufacturer);
  const text = [name, maker && maker !== name ? `(${maker})` : ''].filter((s) => s !== '').join(' ');
  return [ids, text].filter((s) => s !== '').join(' - ');
}

export class PortSelector {
  private inFlight: Promise<boolean> | undefined;

  constructor(private readonly services: Services) {}

  /** Resolves true when a board is connected afterwards. Concurrent callers share one run. */
  select(args: SelectPortArgs = {}): Promise<boolean> {
    if (!this.inFlight) {
      this.inFlight = this.selectOnce(args).finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private get connected(): boolean {
    const st = this.services.session.state;
    return st.port !== null && (st.state === 'idle' || st.state === 'running' || st.state === 'rawop');
  }

  private async selectOnce(args: SelectPortArgs): Promise<boolean> {
    const reuse = args.reuse === true;
    if (reuse && this.connected) {
      return true;
    }
    if (projectFolder() === undefined) {
      offerOpenFolder(this.services.log); // D-24: the board is mirrored to a folder on this computer, so one must be open
      return false;
    }
    const rows = await this.listPorts();
    if (rows === undefined) {
      return false;
    }
    if (reuse) {
      const target = this.findTarget(rows);
      if (target) {
        return this.connectTo(target);
      }
      const likely = rows.filter((r) => r.likelyBoard);
      if (likely.length === 1 && likely[0]) {
        return this.connectTo(likely[0]);
      }
    }
    return this.pickAndConnect(rows);
  }

  /** `undefined` when listing failed (already reported to the user). */
  private async listPorts(): Promise<PortRow[] | undefined> {
    try {
      return (await this.services.session.call('ports.list', {}, { timeoutMs: LIST_TIMEOUT_MS })).ports;
    } catch (err) {
      const needsDoctor = isBoardError(err, 'E_NO_PYTHON') || isBoardError(err, 'E_BRIDGE_EXITED');
      const choice = await reportError(this.services, 'Could not look for serial ports.', err, ...(needsDoctor ? ['Open Doctor'] : []));
      if (choice === 'Open Doctor') {
        await vscode.commands.executeCommand(COMMAND_IDS.doctor);
      }
      return undefined;
    }
  }

  /** The port this window used, the one in the settings, or the remembered one (re-found by VID/PID if its name changed). */
  private findTarget(rows: readonly PortRow[]): PortTarget | undefined {
    const { session, settings, portMemory, log } = this.services;
    const remembered = portMemory.get();
    const names = [session.selectedPort, settings.portOverride, remembered?.device].filter((n): n is string => typeof n === 'string' && n !== '');
    for (const name of names) {
      if (URL_LIKE.test(name)) {
        return { device: name };
      }
      const row = rows.find((r) => sameDevice(r.device, name));
      if (row) {
        return row;
      }
    }
    if (remembered && remembered.vid !== null && remembered.pid !== null) {
      const same = rows.filter((r) => r.vid === remembered.vid && r.pid === remembered.pid);
      if (same.length === 1 && same[0]) {
        log.info(`Port ${remembered.device} is gone; using ${same[0].device}, which has the same USB ids.`);
        return same[0];
      }
    }
    if (names.length > 0) {
      log.info(`The port ${names[0] ?? ''} is not available right now; choosing again.`);
    }
    return undefined;
  }

  private async pickAndConnect(initial: PortRow[]): Promise<boolean> {
    let rows = initial;
    for (;;) {
      if (rows.length === 0) {
        const again = await reportWarning(
          this.services,
          'No serial ports were found. Plug your board into a USB port of this computer with a data cable (some cables only charge). On Windows you may also need the USB driver for the board.',
          'Check again',
        );
        if (again !== 'Check again') {
          return false;
        }
        const fresh = await this.listPorts();
        if (fresh === undefined) {
          return false;
        }
        rows = fresh;
        continue;
      }
      const items: PortPick[] = rankPorts(rows).map((row) => ({
        label: row.device,
        description: describePort(row),
        detail: row.likelyBoard ? 'Looks like a MicroPython board' : undefined,
        row,
      }));
      items.push({ label: REFRESH_LABEL, description: 'Look for ports again' });
      const picked = await vscode.window.showQuickPick<PortPick>(items, {
        title: 'Select Serial Port',
        placeHolder: 'Choose the port of your board (the likely boards are listed first)',
        matchOnDescription: true,
      });
      if (!picked) {
        return false;
      }
      if (picked.row) {
        return this.connectTo(picked.row);
      }
      const fresh = await this.listPorts();
      if (fresh === undefined) {
        return false;
      }
      rows = fresh;
    }
  }

  private async connectTo(target: PortTarget): Promise<boolean> {
    const { session, portMemory, log } = this.services;
    if (session.state.port !== null && sameDevice(session.state.port, target.device) && session.state.state !== 'disconnected') {
      return true;
    }
    if (session.state.state !== 'disconnected' && !(await this.leaveCurrentPort(target.device))) {
      return false;
    }
    for (;;) {
      try {
        await session.connect(target.device, {
          ...(typeof target.vid === 'number' ? { vid: target.vid } : {}),
          ...(typeof target.pid === 'number' ? { pid: target.pid } : {}),
        });
      } catch (err) {
        const choice = await this.reportConnectFailure(target.device, err);
        if (choice === RETRY) {
          continue;
        }
        if (choice === CHOOSE_ANOTHER) {
          const fresh = await this.listPorts();
          return fresh === undefined ? false : this.pickAndConnect(fresh);
        }
        return false;
      }
      try {
        await portMemory.remember({ device: target.device, vid: target.vid ?? null, pid: target.pid ?? null });
      } catch (err) {
        log.warn(`Could not remember the port ${target.device}`, err);
      }
      vscode.window.setStatusBarMessage(`Connected to ${target.device}`, 4000);
      return true;
    }
  }

  /** Switching ports: close the current connection first. A running program is only stopped with the user's consent. */
  private async leaveCurrentPort(next: string): Promise<boolean> {
    const { session } = this.services;
    let stopFirst: boolean | undefined;
    if (session.isRunning || session.state.state === 'running') {
      const answer = await reportWarning(
        this.services,
        `A program is running on the board. Stop it and switch to ${next}?`,
        STOP_AND_SWITCH,
      );
      if (answer !== STOP_AND_SWITCH) {
        return false;
      }
      stopFirst = true;
    }
    try {
      await session.disconnect(stopFirst === undefined ? undefined : { stopFirst });
      return true;
    } catch (err) {
      await reportError(this.services, `Could not close the current connection before switching to ${next}.`, err);
      return false;
    }
  }

  private async reportConnectFailure(device: string, err: unknown): Promise<string | undefined> {
    if (isBoardError(err, 'E_PORT_BUSY')) {
      this.services.log.error(`Port ${device} is busy`, err);
      return this.askAfterFailure(
        `${device} is in use by another program. Close Thonny, the Arduino IDE, PlatformIO, a serial monitor, a terminal running mpremote, or another VS Code window that is using the board. Then press Retry.`,
      );
    }
    const prefix = isBoardError(err, 'E_NO_DEVICE') ? `${device} was not found.` : `Could not connect to ${device}.`;
    this.services.log.error(prefix, err);
    return this.askAfterFailure(`${prefix} ${userMessage(err)}`);
  }

  /** Retry / Choose another port / Show log. Only the first two are returned; Show log opens the log and asks nothing more. */
  private async askAfterFailure(message: string): Promise<string | undefined> {
    const choice = await vscode.window.showErrorMessage(message, RETRY, CHOOSE_ANOTHER, SHOW_LOG);
    if (choice === SHOW_LOG) {
      this.services.log.show();
      return undefined;
    }
    return choice;
  }
}

function parseArgs(raw: unknown): SelectPortArgs {
  // Menus and buttons may pass their own context object; only an explicit `reuse: true` counts.
  return typeof raw === 'object' && raw !== null && (raw as SelectPortArgs).reuse === true ? { reuse: true } : {};
}

export function registerPorts(services: Services): vscode.Disposable[] {
  const selector = new PortSelector(services);
  return [registerGuarded(services, COMMAND_IDS.selectPort, (args?: unknown) => selector.select(parseArgs(args)), false)];
}
