/**
 * Handlers of the Sync utilities commands: uploadActiveFile, syncToBoard, syncFromBoard, clearDevice, toggleAutoSync.
 * Thin on purpose: every flow lives in SyncService (src/sync/service.ts) where it is tested against FakeSession.
 * Each handler reports its own failures (one message plus the log), so the integrator's error boundary never has to.
 */
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../contributes';
import type { Services } from '../types/services';
import type { SyncService } from '../sync/service';

export interface SyncCommandDeps {
  sync: SyncService;
}

export function registerSyncCommands(_services: Services, deps: SyncCommandDeps): vscode.Disposable[] {
  const { sync } = deps;
  const reg = (id: string, what: string, run: (arg: unknown) => Promise<unknown>): vscode.Disposable =>
    vscode.commands.registerCommand(id, (arg?: unknown) => sync.guarded(what, () => run(arg)));
  const disposables: vscode.Disposable[] = [
    // `arg` is a Uri when the command comes from a file context menu; from the toolbar it is undefined (active editor).
    reg(COMMAND_IDS.uploadActiveFile, 'Uploading the file', (arg) => sync.uploadFile(arg instanceof vscode.Uri ? arg : undefined)),
    reg(COMMAND_IDS.syncToBoard, 'Uploading all files', () => sync.uploadAll()),
    reg(COMMAND_IDS.syncFromBoard, 'Downloading all files', () => sync.downloadAll()),
    reg(COMMAND_IDS.clearDevice, 'Clearing the device files', () => sync.clearDevice()),
    reg(COMMAND_IDS.toggleAutoSync, 'Changing auto-sync', () => sync.auto.cycleMode()),
  ];
  disposables.push(reg(COMMAND_IDS.createIgnoreFile, 'Creating the ignore file', () => sync.createIgnoreFile()));
  // D-21: the "?" legend of the Files view and the per-file actions of its context menu (the hover links use them too)
  disposables.push(reg(COMMAND_IDS.syncLegend, 'Showing what the marks mean', () => sync.showLegend()));
  disposables.push(reg(COMMAND_IDS.compareWithBoard, 'Comparing with the board', (arg) => sync.compareWithBoard(arg)));
  disposables.push(reg(COMMAND_IDS.uploadThisFile, 'Uploading the file', (arg) => sync.uploadNode(arg)));
  disposables.push(reg(COMMAND_IDS.downloadThisFile, 'Downloading the file', (arg) => sync.downloadNode(arg)));
  return disposables;
}
