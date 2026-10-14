/**
 * What this window can and cannot do (RQ-DIST-4, docs/extension-design.md step 4).
 *  - Remote, WSL, SSH, Codespaces and virtual folders: the board is plugged into the computer the student sits at, not into
 *    the machine VS Code runs on, so the bridge is never started there. Every command explains what to do instead.
 *  - Restricted Mode (untrusted folder): the bridge is not started until the folder is trusted (the gate below), and the
 *    Python interpreter of the folder is not used either (python/discovery.ts reads `trusted`).
 */
import * as vscode from 'vscode';
import { allCommandIds, COMMAND_IDS, VIEWS } from './contributes';
import { IDENTITY } from './identity';
import type { Logger } from './log';
import { BoardError } from './types/session';

/** Why the board cannot be used in this window, or undefined when it can. English, for a beginner. */
export function windowProblem(): string | undefined {
  if (vscode.env.remoteName) {
    return (
      `${IDENTITY.displayName} needs the board to be plugged into the computer you are sitting at, so it cannot work in a ` +
      `Remote, WSL, SSH or Codespaces window. Open the folder in a normal VS Code window on your own computer ` +
      `(File, then Open Folder) and try again.`
    );
  }
  const virtual = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme !== 'file');
  if (virtual) {
    return (
      `${IDENTITY.displayName} works with folders stored on your computer. "${virtual.name}" is a virtual folder ` +
      `(${virtual.uri.scheme}). Download or clone it to your computer and open that folder instead.`
    );
  }
  return undefined;
}

/** The startGate of the session: refuse to start Python while the folder is not trusted. */
export function untrustedGate(): BoardError | undefined {
  if (vscode.workspace.isTrusted) {
    return undefined;
  }
  return BoardError.of(
    'E_PERMISSION',
    `This folder is in Restricted Mode, so ${IDENTITY.displayName} does not start Python or talk to the board.`,
    { hint: 'If you trust this folder, choose "Manage Workspace Trust" (in the Command Palette, or the banner at the top of the window) and trust it, then try again.' },
  );
}

/**
 * Register every declared command with a handler that shows `message`, and the three views with empty content, so nothing
 * says "command not found" or "no data provider". `showLog` stays real. Returns what to dispose.
 */
export function registerRefusal(log: Logger, message: string, buttonLabel = 'Show log'): vscode.Disposable[] {
  const out: vscode.Disposable[] = [];
  for (const id of allCommandIds()) {
    if (id === COMMAND_IDS.showLog) {
      out.push(vscode.commands.registerCommand(id, () => log.show()));
      continue;
    }
    out.push(
      vscode.commands.registerCommand(id, async () => {
        log.warn(`refused ${id}: ${message}`);
        const choice = await vscode.window.showWarningMessage(message, buttonLabel);
        if (choice === buttonLabel) {
          log.show();
        }
      }),
    );
  }
  const empty: vscode.TreeDataProvider<never> = { getTreeItem: () => new vscode.TreeItem(''), getChildren: () => [] };
  for (const viewId of [VIEWS.files, VIEWS.actions, VIEWS.sync]) {
    out.push(vscode.window.createTreeView(viewId, { treeDataProvider: empty }));
  }
  return out;
}
