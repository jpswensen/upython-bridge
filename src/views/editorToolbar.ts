/**
 * Hides the buttons in the top right corner of the editor while one of our sidebar views is open (instructor request, D-27). For a `.py` file the Python extension always shows a "Run Python File" button there; it runs the file in this
 * computer's Python, and students took it for the board's Run. Another extension's button cannot be hidden or redirected from
 * here (its `when` clause is its own), so this uses the one switch VS Code has: `workbench.editor.editorActionsLocation:
 * "hidden"`, which hides every editor toolbar button (split editor, "..." menu, ours too).
 *
 * The value is written to the WORKSPACE settings and only while it is needed: when one of our views is visible and the
 * setting `hideEditorButtons` is on. Before the first write the previous workspace value (or its absence) goes into
 * `workspaceState`, so that it is put back when the views are no longer showing, after a crash (the next start finds the
 * note), and when the setting is turned off. A value the user set themselves is never touched: if the effective value is
 * already "hidden" nothing is written, and if the workspace value is no longer "hidden" when we restore, the user changed it
 * meanwhile and only our note is dropped. Writes are strictly one after the other.
 */
import * as vscode from 'vscode';
import { stateKey } from '../identity';
import type { Logger } from '../log';
import type { MpySettings } from '../types/settings';

const SECTION = 'workbench.editor';
const KEY = 'editorActionsLocation';
const HIDDEN = 'hidden';
/** workspaceState: what the workspace settings held before we wrote "hidden" (present = we own the current value). */
export const RESTORE_STATE_KEY = stateKey('editorActionsRestore');

interface RestoreNote { had: boolean; value?: unknown }

export interface ToolbarGuardDeps {
  /** The three sidebar views; the toolbar is hidden while any of them is visible. */
  readonly views: readonly Pick<vscode.TreeView<unknown>, 'visible' | 'onDidChangeVisibility'>[];
  readonly settings: Pick<MpySettings, 'hideEditorButtons' | 'onDidChange'>;
  readonly state: vscode.Memento;
  readonly log: Logger;
}

export class EditorToolbarGuard implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: ToolbarGuardDeps) {
    for (const view of deps.views) {
      this.subscriptions.push(view.onDidChangeVisibility(() => this.reconcileSoon()));
    }
    this.subscriptions.push(deps.settings.onDidChange((changed) => {
      if (changed.includes('hideEditorButtons')) {
        this.reconcileSoon();
      }
    }));
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.reconcileSoon()));
    this.reconcileSoon(); // also finds the note a crash left behind
  }

  /** Resolves when every queued change has been written (tests). */
  settled(): Promise<void> {
    return this.chain;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const s of this.subscriptions) {
      s.dispose();
    }
    // Put the toolbar back on the way out; if the window closes first, the note makes the next start do it.
    this.chain = this.chain.then(() => this.restore()).catch((err: unknown) => this.deps.log.warn('The editor buttons could not be put back', err));
  }

  private reconcileSoon(): void {
    this.chain = this.chain.then(() => this.reconcile()).catch((err: unknown) => this.deps.log.warn('The editor buttons could not be updated', err));
  }

  private note(): RestoreNote | undefined {
    return this.deps.state.get<RestoreNote>(RESTORE_STATE_KEY);
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const wanted = this.deps.settings.hideEditorButtons
      && (vscode.workspace.workspaceFolders?.length ?? 0) > 0
      && this.deps.views.some((v) => v.visible);
    const owned = this.note() !== undefined;
    if (wanted && !owned) {
      await this.hide();
    } else if (!wanted && owned) {
      await this.restore();
    }
  }

  private async hide(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    if (cfg.get<string>(KEY) === HIDDEN) {
      return; // the user (or a team's settings file) already hides them: not ours to write or to undo
    }
    const own = cfg.inspect<string>(KEY)?.workspaceValue;
    await this.deps.state.update(RESTORE_STATE_KEY, own === undefined ? { had: false } : { had: true, value: own });
    try {
      await cfg.update(KEY, HIDDEN, vscode.ConfigurationTarget.Workspace);
    } catch (err) {
      await this.deps.state.update(RESTORE_STATE_KEY, undefined);
      throw err;
    }
  }

  private async restore(): Promise<void> {
    const note = this.note();
    if (note === undefined) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration(SECTION);
    if (cfg.inspect<string>(KEY)?.workspaceValue === HIDDEN) {
      await cfg.update(KEY, note.had ? note.value : undefined, vscode.ConfigurationTarget.Workspace);
    }
    await this.deps.state.update(RESTORE_STATE_KEY, undefined);
  }
}
