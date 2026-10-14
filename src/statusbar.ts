/**
 * Status bar: two items.
 *  - Board (left): `$(plug) <port or No board> - <state>`. The tooltip names the board (from the identity probe), the click
 *    selects a port (or opens the Doctor when Python is not working). A spinner shows while connecting or while the bridge is
 *    busy with a file operation; a warning colour shows when another program holds the port, with the one-line fix.
 *  - Auto-sync (right): the mode (ask, on, off) and how many files wait for upload. Always shown when a folder is open (D-10).
 * Both follow `BoardSession.onDidChangeState` and the settings; neither touches the board.
 */
import * as vscode from 'vscode';
import { COMMAND_IDS } from './contributes';
import { IDENTITY } from './identity';
import type { BoardIdentity } from './types/protocol';
import type { Services } from './types/services';
import type { BoardSession, SessionState } from './types/session';
import { summarize, type SessionSummary } from './views/sessionView';
import { STATUS_TEXT } from './views/strings';
import type { ViewSettings } from './views/viewSettings';

const BOARD_PRIORITY = 100;
const AUTO_SYNC_PRIORITY = 100;
const WARNING_BACKGROUND = 'statusBarItem.warningBackground';

/**
 * The session reports why it last changed in `reason`. A failed connect because another program holds the port is recognised
 * from it (E_PORT_BUSY is the code; "port busy" covers a free-text reason). See contract_requests: a machine-readable
 * `lastError` in SessionState would make this exact.
 */
export function isPortBusy(state: SessionState): boolean {
  return state.state === 'disconnected' && /E_PORT_BUSY|port[\s_-]*busy/i.test(state.reason);
}

function isUnplugged(state: SessionState): boolean {
  return state.state === 'disconnected' && /unplug/i.test(state.reason);
}

function implementationName(impl: string): string {
  return impl.toLowerCase() === 'micropython' ? 'MicroPython' : impl;
}

/** One line naming the board, from the read-only identity probe: `<machine>, MicroPython 1.29.0`. */
export function identityLine(identity: BoardIdentity): string {
  const version = identity.version.join('.');
  const firmware = [implementationName(identity.impl), version].filter((p) => p !== '').join(' ');
  return [identity.machine, firmware].filter((p) => p !== '').join(', ');
}

export interface BoardStatus {
  readonly text: string;
  readonly tooltip: string;
  readonly command: string;
  readonly warning: boolean;
}

/** Pure: the board item for a state. */
export function boardStatus(state: SessionState, summary: SessionSummary): BoardStatus {
  if (summary.interpreterProblem) {
    return { text: `$(warning) ${STATUS_TEXT.interpreterProblem}`, tooltip: STATUS_TEXT.interpreterTooltip, command: COMMAND_IDS.doctor, warning: true };
  }
  const port = summary.port;
  if (port === null) {
    return { text: `$(plug) ${STATUS_TEXT.noBoard}`, tooltip: STATUS_TEXT.noBoardTooltip, command: COMMAND_IDS.selectPort, warning: false };
  }
  const command = COMMAND_IDS.selectPort;
  switch (summary.phase) {
    case 'connecting':
      return { text: `$(sync~spin) ${port} - ${STATUS_TEXT.states.connecting}`, tooltip: STATUS_TEXT.connectingTooltip(port), command, warning: false };
    case 'working':
      return { text: `$(sync~spin) ${port} - ${STATUS_TEXT.states.working}`, tooltip: withBoard(STATUS_TEXT.workingTooltip, port, state), command, warning: false };
    case 'running':
      return { text: `$(play) ${port} - ${STATUS_TEXT.states.running}`, tooltip: withBoard(STATUS_TEXT.runningTooltip, port, state), command, warning: false };
    case 'ready':
      return { text: `$(plug) ${port} - ${STATUS_TEXT.states.ready}`, tooltip: withBoard(STATUS_TEXT.readyTooltip, port, state), command, warning: false };
    case 'disconnected':
      break;
  }
  if (isPortBusy(state)) {
    return { text: `$(warning) ${port} - ${STATUS_TEXT.busy}`, tooltip: STATUS_TEXT.busyFix(port), command, warning: true };
  }
  if (isUnplugged(state)) {
    return { text: `$(plug) ${port} - ${STATUS_TEXT.unplugged}`, tooltip: STATUS_TEXT.unpluggedTooltip(port), command, warning: false };
  }
  return { text: `$(plug) ${port} - ${STATUS_TEXT.states.disconnected}`, tooltip: STATUS_TEXT.disconnectedTooltip(port), command, warning: false };
}

/** Tooltip of a connected board: what it is (when the identity probe has run), where it is, then what a click does. */
function withBoard(clickText: string, port: string, state: SessionState): string {
  const lines: string[] = [];
  if (state.identity !== null) {
    lines.push(identityLine(state.identity));
    if (state.identity.build !== '') {
      lines.push(`Build: ${state.identity.build}`);
    }
  }
  lines.push(`Port: ${port}`, clickText);
  return lines.join('\n');
}

export class StatusBar implements vscode.Disposable {
  private readonly board: vscode.StatusBarItem;
  private readonly autoSync: vscode.StatusBarItem;
  private readonly subscriptions: { dispose(): unknown }[] = [];

  constructor(private readonly session: BoardSession, private readonly settings: ViewSettings) {
    this.board = vscode.window.createStatusBarItem(`${IDENTITY.prefix}.board`, vscode.StatusBarAlignment.Left, BOARD_PRIORITY);
    this.board.name = `${IDENTITY.shortName} board`;
    this.autoSync = vscode.window.createStatusBarItem(`${IDENTITY.prefix}.autoSync`, vscode.StatusBarAlignment.Right, AUTO_SYNC_PRIORITY);
    this.autoSync.name = `${IDENTITY.shortName} auto-sync`;
    this.autoSync.command = COMMAND_IDS.toggleAutoSync;
    this.subscriptions.push(
      session.onDidChangeState(() => this.update()),
      settings.onDidChange((keys) => {
        if (keys.includes('autoSync') || keys.includes('port')) {
          this.update();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.update()),
    );
    this.update();
  }

  /** Current texts of the items (read-only; the extension-host test hook reads them). */
  get texts(): { board: string; boardTooltip: string; autoSync: string } {
    return { board: this.board.text, boardTooltip: String(this.board.tooltip ?? ''), autoSync: this.autoSync.text };
  }

  /** Redraw both items from the current state. */
  update(): void {
    const state = this.session.state;
    const summary = summarize(state, this.session.selectedPort, this.settings.portOverride);
    const status = boardStatus(state, summary);
    this.board.text = status.text;
    this.board.tooltip = status.tooltip;
    this.board.command = status.command;
    this.board.backgroundColor = status.warning ? new vscode.ThemeColor(WARNING_BACKGROUND) : undefined;
    this.board.show();

    const mode = this.settings.autoSync;
    const pending = state.pendingSyncCount;
    const icon = mode === 'off' ? 'sync-ignored' : mode === 'ask' ? 'question' : pending > 0 ? 'cloud-upload' : 'sync';
    this.autoSync.text = `$(${icon}) ${STATUS_TEXT.autoSync(mode, pending)}`;
    this.autoSync.tooltip = pending > 0
      ? `${STATUS_TEXT.autoSyncTooltip[mode]}\n${STATUS_TEXT.autoSyncPending(pending, summary.running)}`
      : STATUS_TEXT.autoSyncTooltip[mode];
    // Auto-sync mirrors a workspace folder; with no folder open there is nothing to mirror.
    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      this.autoSync.show();
    } else {
      this.autoSync.hide();
    }
  }

  dispose(): void {
    this.subscriptions.splice(0).forEach((s) => s.dispose());
    this.board.dispose();
    this.autoSync.dispose();
  }
}

/** Create the status bar items; the result goes to context.subscriptions. */
export function registerStatusBar(services: Pick<Services, 'session' | 'settings'>): vscode.Disposable[] {
  return [new StatusBar(services.session, services.settings)];
}
