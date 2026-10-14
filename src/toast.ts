/**
 * Toasts that never hold up the work they report on.
 *
 * In a real VS Code window the promise of `showInformationMessage(text)` without buttons settles only when the user dismisses the
 * toast. `await`-ing it keeps the whole command pending: the first run in a real extension host showed `executeCommand(Stop)`
 * still pending 60 s after the program had stopped (the mocked `vscode` resolves such messages at once, so unit tests cannot
 * see it). Anything that awaits the command (another command, a test, a keybinding chain) hangs with it.
 *
 * `showToast` calls VS Code immediately, in every case. When the toast offers NO button there is nothing to wait for, so the
 * returned promise is already resolved (with `undefined`). When it offers buttons it is a question: the promise settles with the
 * button the user chose, and the caller decides whether waiting is right.
 */
import * as vscode from 'vscode';
import type { Logger } from './log';

export type ToastLevel = 'info' | 'warning' | 'error';

export function showToast(log: Pick<Logger, 'error'>, level: ToastLevel, message: string, ...buttons: string[]): Promise<string | undefined> {
  const pending = Promise.resolve(
    level === 'error'
      ? vscode.window.showErrorMessage(message, ...buttons)
      : level === 'warning'
        ? vscode.window.showWarningMessage(message, ...buttons)
        : vscode.window.showInformationMessage(message, ...buttons),
  );
  if (buttons.length > 0) {
    return pending;
  }
  pending.catch((err: unknown) => log.error('could not show a message', err));
  return Promise.resolve(undefined);
}
