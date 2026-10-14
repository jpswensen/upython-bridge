/**
 * The VS Code implementation of `SessionUi`: the questions the session asks (interrupt a running program, delete a drive of the
 * board), non-blocking warnings and progress notifications. The only file of the session folder that imports `vscode`.
 */
import * as vscode from 'vscode';
import type { Logger } from '../log';
import { showToast } from '../toast';
import type { OpName } from '../types/protocol';
import type { BoardError } from '../types/session';
import type { SessionUi } from './session';

export const STOP_AND_CONTINUE = 'Stop program and continue';
export const DELETE_ANYWAY = 'Delete anyway';

export class VscodeSessionUi implements SessionUi {
  constructor(private readonly log: Logger) {}

  async confirmInterrupt(op: OpName, error: BoardError): Promise<boolean> {
    this.log.info(`asking whether the running program may be interrupted for ${op}`);
    const choice = await vscode.window.showWarningMessage(
      error.message || 'A program is running on the board.',
      { modal: true, detail: `${error.hint}\n\nIf you continue, Ctrl-C is sent to the board to stop the program, and then what you asked for is done.` },
      STOP_AND_CONTINUE,
    );
    return choice === STOP_AND_CONTINUE;
  }

  async confirmAllowMount(path: string, error: BoardError): Promise<boolean> {
    this.log.info(`asking whether ${path} may be deleted although it is a drive of the board`);
    const choice = await vscode.window.showWarningMessage(
      `"${path}" is a drive of the board itself, not an ordinary folder.`,
      { modal: true, detail: `${error.message}\n\nDeleting it removes everything stored on that drive, including files the board needs to start.` },
      DELETE_ANYWAY,
    );
    return choice === DELETE_ANYWAY;
  }

  async warn(message: string, ...actions: string[]): Promise<string | undefined> {
    return showToast(this.log, 'warning', message, ...actions);
  }

  info(message: string): void {
    void showToast(this.log, 'info', message);
  }

  withProgress<T>(title: string, task: (report: (message: string, fraction?: number) => void) => Promise<T>): Promise<T> {
    return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, (progress) => {
      let last = 0;
      return task((message, fraction) => {
        const increment = fraction === undefined ? undefined : Math.max(0, (fraction - last) * 100);
        if (fraction !== undefined) {
          last = fraction;
        }
        progress.report(increment === undefined ? { message } : { message, increment });
      });
    }));
  }
}
