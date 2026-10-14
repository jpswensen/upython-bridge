/**
 * activate()/deactivate(): build the services in a fixed order, register everything, never throw (docs/extension-design.md s.5).
 *
 * Nothing here touches hardware, spawns Python, opens a port or writes a setting: the bridge starts when the user first
 * needs the board (selecting a port, running, opening the file list), see src/session/index.ts. Everything that must be released
 * goes into ONE Teardown pushed to `context.subscriptions`, which VS Code disposes right after deactivate() returns; its order
 * (auto-sync, board session, then the rest, then the log) is in src/lifecycle.ts. There is no module-level state, so deactivate()
 * has nothing of its own to release.
 */
import * as vscode from 'vscode';
import { BoardCopy } from './commands/boardCopy';
import { registerBoardFileCommands } from './commands/boardFiles';
import { VsCodePrompter } from './commands/intellisensePrompts';
import { registerIntelliSense } from './commands/intellisenseRegister';
import { registerSyncCommands } from './commands/sync';
import { COMMAND_IDS } from './contributes';
import { registerDoctor, runStartupChecks } from './doctor';
import { IDENTITY } from './identity';
import { Teardown } from './lifecycle';
import { createLogger, type Logger } from './log';
import { registerTerminalFeatures } from './repl/register';
import { createBoardSession } from './session';
import { SyncService } from './sync';
import { TestRecorder, testHookEnabled, type TestApi } from './testApi';
import type { Services } from './types/services';
import { PortMemory, Settings } from './types/settings';
import { BoardClockKeeper } from './session/clock';
import { registerViews } from './views';
import { registerRefusal, untrustedGate, windowProblem } from './windowGuards';

/** Returns nothing in production; with the test switch set (src/testApi.ts) it returns the read-only test hook. */
export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const log = createLogger(vscode.window, IDENTITY.outputChannelName);
  const root = new Teardown(log);
  root.addLate(log);
  context.subscriptions.push(root);

  const problem = windowProblem();
  if (problem) {
    log.warn(`this window cannot use the board: ${problem}`);
    root.addAll(registerRefusal(log, problem));
    return undefined;
  }

  const features = new Teardown(log);
  root.add(features);
  try {
    return startFeatures(context, log, features, testHookEnabled() ? new TestRecorder() : undefined);
  } catch (err) {
    // Release what was built so far, then give every command a clear answer instead of "command not found".
    log.error('activation failed', err);
    features.dispose();
    const reason = err instanceof Error ? err.message : String(err);
    const message = `${IDENTITY.displayName} could not start: ${reason} Choose "Show Log" from the Command Palette for details, then reload the window.`;
    root.addAll(registerRefusal(log, message));
    reportInBackground(log, 'showing the activation failure', Promise.resolve(vscode.window.showErrorMessage(message, 'Show log')).then((choice) => {
      if (choice === 'Show log') {
        log.show();
      }
    }));
    return undefined;
  }
}

export function deactivate(): void {
  // Intentionally empty: the Teardown in context.subscriptions disposes the board session (which interrupts a running program
  // and closes the port) and everything else, in order, right after this returns.
}

function startFeatures(context: vscode.ExtensionContext, log: Logger, features: Teardown, recorder: TestRecorder | undefined): TestApi | undefined {
  const settings = features.add(new Settings(undefined, context.workspaceState));
  log.setLevel(settings.logLevel);
  features.add(settings.onDidChange((changed) => {
    if (changed.includes('logLevel')) {
      log.setLevel(settings.logLevel);
    }
  }));

  // Lazy session: no process, no port, no setting written until something needs the board.
  const portMemory = new PortMemory(context.workspaceState);
  const bundle = createBoardSession({ context, log, settings, portMemory, startGate: untrustedGate });
  const { session } = bundle;
  features.addEarly(session);
  const services: Services = { context, log, settings, session, portMemory };

  // Sync before views and commands: it is their SyncStatusSource and SyncGate. Its listeners start at the end.
  const sync = new SyncService(services);
  features.addEarly(sync);

  const viewParts = registerViews(services, { syncStatus: sync, boardChanges: sync, compare: () => sync.refreshStatus('refresh') });
  features.addAll(viewParts);
  // One copy flow for the Files-view click and for Run (a board document runs as the project's file, or is copied first).
  const boardCopy = new BoardCopy(services, sync);
  features.addAll(registerTerminalFeatures(services, {
    syncGate: sync, boardFiles: { localCounterpart: (devicePath) => sync.localCounterpart(devicePath), copy: boardCopy },
    learned: bundle.learned, terminal: recorder ? { tap: recorder.tap } : undefined,
  }));
  features.addAll(registerSyncCommands(services, { sync }));
  features.addAll(registerBoardFileCommands(services, { sync, copy: boardCopy }));
  features.add(vscode.commands.registerCommand(COMMAND_IDS.showLog, () => log.show()));
  features.add(new BoardClockKeeper(services)); // D-22: set an unset board clock after connect, and the command
  features.addAll(registerDoctor({ context, log, settings, session, discovery: bundle.discovery, learned: bundle.learned, portMemory }));

  const intellisense = registerIntelliSense(services, { prompter: recorder ? recorder.intellisense.prompter : new VsCodePrompter(log) });
  features.addAll(intellisense.disposables);

  sync.start();

  // A remembered board is selected (not connected): the Files view then offers "Connect to <port>".
  const remembered = portMemory.get();
  if (remembered) {
    session.selectPort(remembered.device);
  }

  reportInBackground(log, 'the startup checks', runStartupChecks({ log }));
  log.info(`${IDENTITY.shortName} is ready. The board is not touched until you select a port or run a program.`);
  return recorder?.build(services, viewParts, intellisense.controller);
}

/** Run a promise nobody awaits: a failure is logged, never lost and never an unhandled rejection. */
function reportInBackground(log: Logger, what: string, work: Promise<unknown>): void {
  work.catch((err: unknown) => log.error(`${what} failed`, err));
}
