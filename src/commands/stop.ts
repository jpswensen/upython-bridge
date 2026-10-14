/**
 * "Stop Program" (RQ-SAFE-3): interrupt whatever runs on the board. `stop` bypasses the bridge queue, so it works while a Run,
 * a file transfer or anything else is in flight. It NEVER resets the board by itself (RQ-SAFE-2/3, RQ-RESET-5): when the board
 * does not react, the message offers "Reset board..." and the student decides.
 */
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../contributes';
import { offerReset, registerGuarded, reportError, STOP_CALL_TIMEOUT_MS } from '../repl/commandSupport';
import { showToast } from '../toast';
import type { Services } from '../types/services';
import { isBoardError, userMessage } from '../types/session';

const SELECT_PORT = 'Select Serial Port';

export class StopCommand {
  constructor(private readonly services: Services) {}

  async run(): Promise<void> {
    const { session, log } = this.services;
    if (session.state.state === 'disconnected') {
      await this.explainNoBoard();
      return;
    }
    try {
      const res = await session.call('stop', {}, { timeoutMs: STOP_CALL_TIMEOUT_MS });
      if (res.stopped) {
        log.info(`Stop: the board answered after ${res.ms} ms`);
        // Not awaited: a toast without buttons only settles when it is dismissed (src/toast.ts).
        void showToast(log, 'info', 'Program stopped.');
        return;
      }
      await offerReset(this.services, 'The board did not react to Stop.');
    } catch (err) {
      if (isBoardError(err, 'E_NOT_CONNECTED')) {
        await this.explainNoBoard();
      } else if (isBoardError(err, 'E_BOARD_UNRESPONSIVE')) {
        log.error('Stop: the board is not responding', err);
        await offerReset(this.services, userMessage(err));
      } else {
        await reportError(this.services, 'Could not stop the program.', err);
      }
    }
  }

  private async explainNoBoard(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      'No board is connected, so there is nothing to stop. Choose Select Serial Port to connect one.',
      SELECT_PORT,
    );
    if (choice === SELECT_PORT) {
      await vscode.commands.executeCommand(COMMAND_IDS.selectPort);
    }
  }
}

export function registerStop(services: Services): vscode.Disposable[] {
  const stop = new StopCommand(services);
  return [registerGuarded(services, COMMAND_IDS.stop, () => stop.run(), undefined)];
}
