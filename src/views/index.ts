/**
 * Registers the sidebar: the three tree views, the `refresh` command, the context keys, the file decorations and the status
 * bar. Called once from activate() (docs/extension-design.md, step 8). Everything it returns goes to context.subscriptions.
 */
import * as vscode from 'vscode';
import { COMMAND_IDS, VIEWS } from '../contributes';
import { registerStatusBar } from '../statusbar';
import type { Services } from '../types/services';
import { userMessage } from '../types/session';
import type { BoardChangeSource, SyncStatusSource } from '../types/sync';
import { ActionsTree } from './actionsView';
import { ContextKeys } from './contextKeys';
import { BoardFileDecorations } from './decorations';
import { FilesTree } from './filesView';
import { SyncTree } from './syncView';

export interface ViewsDeps {
  /** From the sync module; without it the Files view simply shows no badges. */
  readonly syncStatus?: SyncStatusSource;
  /** From the sync module; without it the Files view only re-lists on Refresh and on connection changes. */
  readonly boardChanges?: BoardChangeSource;
  /** From the sync module: Refresh of the whole view also compares the project with the board again (the marks, D-21). */
  readonly compare?: () => Promise<unknown>;
}

export function registerViews(services: Services, deps: ViewsDeps = {}): vscode.Disposable[] {
  const { context, log, settings, session } = services;
  const out: vscode.Disposable[] = [];

  const files = new FilesTree({ session, log: log.child('files'), settings, extensionUri: context.extensionUri, syncStatus: deps.syncStatus });
  const actions = new ActionsTree(session, settings);
  const sync = new SyncTree(session, settings);
  out.push(files, actions, sync);
  out.push(vscode.window.createTreeView(VIEWS.files, { treeDataProvider: files, showCollapseAll: true }));
  out.push(vscode.window.createTreeView(VIEWS.actions, { treeDataProvider: actions }));
  out.push(vscode.window.createTreeView(VIEWS.sync, { treeDataProvider: sync }));

  // The view-title button and the "try again" row both run this command; other modules call it after they change board files.
  out.push(vscode.commands.registerCommand(COMMAND_IDS.refresh, (arg?: unknown) => {
    try {
      files.refreshFromCommand(arg);
      if (arg === undefined && deps.compare !== undefined) {
        deps.compare().catch((err: unknown) => log.warn('Refresh: the files could not be compared with the board', err));
      }
    } catch (err) {
      log.error('Refresh failed', err);
      void vscode.window.showErrorMessage(`The file list could not be refreshed. ${userMessage(err)}`);
    }
  }));

  // The one rule for "something on the board changed": re-list the folders that show it (never awaited, never blocks a command).
  if (deps.boardChanges !== undefined) {
    out.push(deps.boardChanges.onBoardChanged((paths) => {
      try {
        files.boardChanged(paths);
      } catch (err) {
        log.error('The Files view could not follow a change on the board', err);
      }
    }));
  }

  out.push(new ContextKeys(session, settings, log.child('context')));

  if (deps.syncStatus !== undefined) {
    const decorations = new BoardFileDecorations(deps.syncStatus);
    out.push(decorations, vscode.window.registerFileDecorationProvider(decorations));
  }

  out.push(...registerStatusBar(services));
  return out;
}
