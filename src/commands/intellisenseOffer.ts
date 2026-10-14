/**
 * The first-connect offer (D-15 item 3): after the first successful connection in a workspace that has no IntelliSense files
 * yet, a non-modal message offers the setup with [Set up] [Not now] [Don't ask again]. It never blocks the connection (it is
 * started from a state event and answered in the background), never appears twice in one window, is off with the setting
 * `intellisenseOffer`, and stays off for good after "Don't ask again" (remembered in workspaceState).
 */
import * as vscode from 'vscode';
import { stateKey } from '../identity';
import { TRACKER_REL } from '../intellisense';
import type { FsLike } from '../intellisense/types';
import type { Logger } from '../log';
import type { BoardSession } from '../types/session';
import type { MementoLike, SettingsReader } from '../types/settings';
import type { IntelliSenseController } from './intellisense';
import type { IntelliSensePrompter } from './intellisensePrompts';

export const OFFER_STATE_KEY = stateKey('intellisense.offer');
/** Extensions that provide import checking for Python; without one the setup would have no visible effect. */
export const LANGUAGE_SERVER_EXTENSIONS = ['ms-python.vscode-pylance', 'ms-python.python', 'detachhead.basedpyright', 'ms-pyright.pyright'] as const;

export function languageServerInstalled(): boolean {
  return LANGUAGE_SERVER_EXTENSIONS.some((id) => vscode.extensions.getExtension(id) !== undefined);
}

export interface OfferDeps {
  session: Pick<BoardSession, 'state' | 'onDidChangeState'>;
  settings: Pick<SettingsReader, 'intellisenseOffer'>;
  state: MementoLike;
  log: Pick<Logger, 'info' | 'error'>;
  fs: Pick<FsLike, 'stat' | 'path'>;
  prompter: Pick<IntelliSensePrompter, 'offer'>;
  controller: Pick<IntelliSenseController, 'fix'>;
}

export class IntelliSenseOffer implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private offered = false;

  constructor(private readonly deps: OfferDeps) {
    this.subscription = deps.session.onDidChangeState((s) => {
      // the identity is read right after the prompt appears; wait for it so the setup can pick the stubs of this board
      if (!this.offered && s.state === 'idle' && s.identity !== null) {
        this.offered = true;
        this.start().catch((err: unknown) => deps.log.error('the IntelliSense offer failed', err));
      }
    });
  }

  dispose(): void { this.subscription.dispose(); }

  /** Decide, ask, act. Public for tests; resolves when the user has answered. */
  async start(): Promise<'not-asked' | 'setup' | 'later' | 'never'> {
    const { deps } = this;
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
    // Restricted Mode: the setup could only run without Python from the firmware tree, and an offer there only invites a click
    if (folder === undefined || !vscode.workspace.isTrusted || !deps.settings.intellisenseOffer || deps.state.get<string>(OFFER_STATE_KEY) === 'never' || !languageServerInstalled()) { return 'not-asked'; }
    const tracker = await deps.fs.stat(deps.fs.path.join(folder.uri.fsPath, ...TRACKER_REL.split('/'))).catch(() => null);
    if (tracker !== null) { return 'not-asked'; }
    const answer = await deps.prompter.offer();
    if (answer === 'setup') {
      deps.log.info('the user accepted the IntelliSense offer');
      await deps.controller.fix({ folder: folder.uri.fsPath, source: 'offer' });
      return 'setup';
    }
    if (answer === 'never') {
      await deps.state.update(OFFER_STATE_KEY, 'never');
      deps.log.info('the user turned the IntelliSense offer off for this workspace');
      return 'never';
    }
    return 'later';
  }
}
