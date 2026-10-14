/**
 * Small helpers shared by the terminal-owned commands (run, stop, reset, repl, ports): one error boundary per command and one
 * way to tell the student that something failed (toast with the next step + the log, CLAUDE.md engineering rule 9).
 */
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../contributes';
import { showToast } from '../toast';
import type { Services } from '../types/services';
import { userMessage } from '../types/session';

const SHOW_LOG = 'Show log';
const RESET_BUTTON = 'Reset board...';
/** The bridge waits up to 3 s for a prompt (plus a resync); the client waits a little longer. */
export const STOP_CALL_TIMEOUT_MS = 10_000;

/**
 * Show an error toast made of `prefix` (what we were doing) and the cause with its next step, plus a "Show log" button and any
 * extra buttons. Always logs. Resolves with the extra button the user chose, if any.
 */
export async function reportError(
  services: Pick<Services, 'log'>,
  prefix: string,
  err: unknown,
  ...buttons: string[]
): Promise<string | undefined> {
  services.log.error(prefix, err);
  const choice = await vscode.window.showErrorMessage(`${prefix} ${userMessage(err)}`.trim(), ...buttons, SHOW_LOG);
  if (choice === SHOW_LOG) {
    services.log.show();
    return undefined;
  }
  return choice;
}

/**
 * Same as {@link reportError} for a warning (the operation did not happen, but nothing is broken). Without buttons it does not
 * wait for the user to dismiss the toast (src/toast.ts), so the command that reports it finishes at once.
 */
export async function reportWarning(services: Pick<Services, 'log'>, message: string, ...buttons: string[]): Promise<string | undefined> {
  services.log.warn(message);
  return showToast(services.log, 'warning', message, ...buttons);
}

/**
 * A Stop that got no answer from the board: say so calmly and OFFER the reset menu. The button only opens the menu; nothing is
 * ever reset from here (RQ-SAFE-2/3, RQ-RESET-5). Resolves when the message is dismissed or the menu command returned.
 */
export async function offerReset(services: Pick<Services, 'log'>, why: string): Promise<void> {
  services.log.warn(`Stop did not reach a prompt: ${why}`);
  const choice = await vscode.window.showErrorMessage(
    `${why} The program may still be running. Try Stop once more. If nothing changes, you can restart the board with Reset board...; its menu lists what works with your board.`,
    RESET_BUTTON,
  );
  if (choice === RESET_BUTTON) {
    await vscode.commands.executeCommand(COMMAND_IDS.resetBoard);
  }
}

/**
 * Register a command whose handler never throws into VS Code ("Running the contributed command failed" tells a beginner
 * nothing): a failure is logged and shown. `fallback` is what the command returns after a failure.
 */
export function registerGuarded<A extends unknown[], R>(
  services: Pick<Services, 'log'>,
  id: string,
  handler: (...args: A) => Promise<R> | R,
  fallback: R,
): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: unknown[]): Promise<R> => {
    try {
      return await handler(...(args as A));
    } catch (err) {
      await reportError(services, 'Something went wrong.', err);
      return fallback;
    }
  });
}
