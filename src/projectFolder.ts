/**
 * The project folder rule (instructor decision D-24): the extension mirrors a folder on this computer to the board, so it needs
 * that folder open. Without one, the three views show only a welcome with an "Open Folder" button and connecting is refused
 * with the same offer; nothing else changes (the Doctor and the log still work). The first workspace folder on the local disk
 * is the project folder (multi-root: the first one, as sync always did).
 */
import * as vscode from 'vscode';
import { OPEN_FOLDER_COMMAND } from './contributes';
import { IDENTITY } from './identity';
import type { Logger } from './log';
import { showToast } from './toast';

export const NO_FOLDER_TEXT =
  `Open your project folder first: ${IDENTITY.displayName} keeps a folder on this computer in sync with the board. Open the folder ` +
  'of your project, or create a new empty folder for it.';

/** The folder that is mirrored to the board, or undefined when no local folder is open. */
export function projectFolder(): vscode.WorkspaceFolder | undefined {
  const first = vscode.workspace.workspaceFolders?.[0];
  return first !== undefined && first.uri.scheme === 'file' ? first : undefined;
}

/** Says why nothing happens without a folder and offers to open one (non-blocking: the caller returns at once). */
export function offerOpenFolder(log: Pick<Logger, 'error' | 'info'>): void {
  const open = 'Open Folder';
  log.info('no project folder is open: the board is not connected');
  void showToast(log, 'warning', NO_FOLDER_TEXT, open).then((choice) => {
    if (choice === open) { void vscode.commands.executeCommand(OPEN_FOLDER_COMMAND); }
  });
}
