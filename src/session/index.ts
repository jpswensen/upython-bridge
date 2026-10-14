/**
 * Wiring of the real session for `activate()` (docs/extension-design.md step 5): Python discovery, the bridge client, the
 * learned-reset store and the VS Code user interface, behind one call. Nothing starts here: no process is spawned, no port
 * is opened and no setting is written until something needs the board.
 */
import path from 'node:path';
import * as vscode from 'vscode';
import { BridgeClient } from '../bridge/client';
import type { Logger } from '../log';
import { PythonDiscovery, noPythonError } from '../python/discovery';
import { ToolingHintSource, watchDiscoveryInputs } from '../python/toolingApi';
import type { MpySettings, PortMemory } from '../types/settings';
import type { BoardError } from '../types/session';
import { LearnedResetStore } from './learnedReset';
import { BridgeBoardSession, type SessionUi } from './session';
import { VscodeSessionUi } from './vscodeUi';

export interface CreateSessionOptions {
  context: vscode.ExtensionContext;
  log: Logger;
  settings: MpySettings;
  portMemory?: PortMemory;
  /** Replace the VS Code user interface (tests). */
  ui?: SessionUi;
  /**
   * Asked before the bridge is started. An error means "do not start it" (for example in Restricted Mode, where nothing from
   * the folder may run until the user trusts it); the error reaches the caller like any other board error.
   */
  startGate?: () => BoardError | undefined;
}

export interface SessionBundle {
  session: BridgeBoardSession;
  discovery: PythonDiscovery;
  hints: ToolingHintSource;
  client: BridgeClient;
  /** What hard-reset verifications taught us (shared with the reset command and the Doctor). */
  learned: LearnedResetStore;
}

/** The workspace folder that owns the project (first folder, local files only), or null. */
export function projectFolder(): string | null {
  const first = vscode.workspace.workspaceFolders?.[0];
  return first && first.uri.scheme === 'file' ? first.uri.fsPath : null;
}

export function createBoardSession(options: CreateSessionOptions): SessionBundle {
  const { context, log, settings } = options;
  const storage = context.globalStorageUri.fsPath;
  const hints = new ToolingHintSource(log.child('python'));
  const discovery = new PythonDiscovery({
    log: log.child('python'),
    context: () => ({ folder: projectFolder(), trusted: vscode.workspace.isTrusted, pythonPathSetting: settings.pythonPath }),
    hints: hints.getHints,
  });
  const client = new BridgeClient({
    log,
    extensionPath: context.extensionPath,
    pycacheDir: path.join(storage, 'pycache'),
    cwd: path.join(storage, 'bridge-cwd'), // a neutral folder: never the workspace, where student files such as time.py live
    resolvePython: async () => {
      const blocked = options.startGate?.();
      if (blocked) {
        throw blocked;
      }
      const resolution = await discovery.resolve();
      if (!resolution.chosen) {
        throw noPythonError(resolution);
      }
      return resolution.chosen.launcher;
    },
    afterHello: async (api) => {
      await api.call('config', session.buildConfig());
    },
  });
  const learned = new LearnedResetStore(context.globalState);
  const session = new BridgeBoardSession({
    log: log.child('session'),
    settings,
    bridge: client,
    ui: options.ui ?? new VscodeSessionUi(log),
    learned,
    portMemory: options.portMemory,
    checkInterpreter: async () => {
      const resolution = await discovery.resolve();
      return resolution.chosen
        ? { ok: true, message: `Python ${resolution.chosen.versionText} at ${resolution.chosen.executable}` }
        : { ok: false, message: resolution.failure?.message ?? 'No working Python was found.' };
    },
    extraDisposables: [
      hints,
      ...watchDiscoveryInputs(discovery, hints, log.child('python'), () => {
        session.checkInterpreter().catch((err: unknown) => log.error('checking the Python interpreter failed', err));
      }),
    ],
  });
  return { session, discovery, hints, client, learned };
}
