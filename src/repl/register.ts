/**
 * One call for the integrator: creates the board terminal and registers the five terminal-owned commands
 * (selectPort, openRepl, runActiveFile, stop, resetBoard). Returns everything to push into `context.subscriptions`.
 *
 *   context.subscriptions.push(...registerTerminalFeatures(services, { syncGate: engine, resetWarning: () => profile?.resetWarning }));
 */
import type * as vscode from 'vscode';
import { registerPorts } from '../commands/ports';
import { registerRepl } from '../commands/repl';
import { registerReset, type ResetDeps } from '../commands/reset';
import { registerRun, type RunDeps } from '../commands/run';
import { registerStop } from '../commands/stop';
import type { Services } from '../types/services';
import type { SyncGate } from '../types/sync';
import { ReplTerminal, terminalIconPath, type ReplTerminalOptions } from './terminal';

export interface TerminalFeatureDeps extends ResetDeps {
  /** Sync's gate; Run flushes pending library files through it (D-07). */
  syncGate?: SyncGate;
  /** Lets Run follow a board document to the project's file (see RunDeps.boardFiles). */
  boardFiles?: RunDeps['boardFiles'];
  terminal?: ReplTerminalOptions;
}

export function registerTerminalFeatures(services: Services, deps: TerminalFeatureDeps = {}): vscode.Disposable[] {
  const terminal = new ReplTerminal(services, { iconPath: terminalIconPath(services.context.extensionUri), ...deps.terminal });
  return [
    terminal,
    ...registerPorts(services),
    ...registerRepl(services, { terminal }),
    ...registerRun(services, { terminal, syncGate: deps.syncGate, boardFiles: deps.boardFiles }),
    ...registerStop(services),
    ...registerReset(services, deps),
  ];
}
