/**
 * The services every feature module receives, constructed once in activate() (docs/extension-design.md, "Activation sequence").
 * Modules export `register<Feature>(services: Services, ...): Disposable[]` (or a class taking `Services`) and never reach
 * for module-level state. Feature-to-feature dependencies are the small interfaces in types/sync.ts and the command ids.
 */
import type { ExtensionContext } from 'vscode';
import type { Logger } from '../log';
import type { BoardSession } from './session';
import type { MpySettings, PortMemory } from './settings';

export interface Services {
  readonly context: ExtensionContext;
  readonly log: Logger;
  readonly settings: MpySettings;
  readonly session: BoardSession;
  /** Remembered (port, VID, PID) in workspaceState; never written to settings (D-11). */
  readonly portMemory: PortMemory;
}

/**
 * Argument of the `selectPort` command, which is also the one entry point for "make sure a board is connected":
 * other modules call `executeCommand<boolean>(COMMAND_IDS.selectPort, { reuse: true })` and get true when connected afterwards.
 * With `reuse` the remembered/selected port is used without asking when it is available; without it the user always picks.
 */
export interface SelectPortArgs {
  reuse?: boolean;
}
