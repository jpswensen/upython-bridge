/**
 * Sets the context keys that the manifest's `when` clauses use (CONTEXT in contributes.ts): hasPort, connected, running and
 * interpreterProblem follow the session. `hardResetAvailable` belongs to the terminal module (docs/extension-design.md s.2),
 * which knows the reset capability; this class only offers `setHardResetAvailable` so that one module can use it.
 * A key is sent again only when its value changed, and a failure to set it is logged (never swallowed).
 */
import * as vscode from 'vscode';
import { CONTEXT } from '../contributes';
import type { Logger } from '../log';
import type { BoardSession } from '../types/session';
import { summarize } from './sessionView';
import type { ViewSettings } from './viewSettings';

export class ContextKeys implements vscode.Disposable {
  private readonly sent = new Map<string, boolean>();
  /** Values VS Code acknowledged: the `setContext` command resolved. */
  private readonly accepted = new Map<string, boolean>();
  private readonly subscriptions: { dispose(): unknown }[] = [];

  constructor(private readonly session: BoardSession, private readonly settings: ViewSettings, private readonly log: Logger) {
    this.subscriptions.push(session.onDidChangeState(() => this.apply()));
    this.subscriptions.push(settings.onDidChange((keys) => {
      if (keys.includes('port')) {
        this.apply();
      }
    }));
    this.apply();
  }

  /** Recompute the four session keys from the current state and send those that changed. */
  apply(): void {
    const s = summarize(this.session.state, this.session.selectedPort, this.settings.portOverride);
    this.set(CONTEXT.hasPort, s.hasPort);
    this.set(CONTEXT.connected, s.connected);
    this.set(CONTEXT.running, s.running);
    this.set(CONTEXT.interpreterProblem, s.interpreterProblem);
  }

  setHardResetAvailable(available: boolean): void {
    this.set(CONTEXT.hardResetAvailable, available);
  }

  private set(key: string, value: boolean): void {
    if (this.sent.get(key) === value) {
      return;
    }
    this.sent.set(key, value);
    vscode.commands.executeCommand('setContext', key, value).then(() => {
      if (this.sent.get(key) === value) {
        this.accepted.set(key, value);
      }
    }, (err: unknown) => {
      this.sent.delete(key);
      this.log.error(`Could not set the context key ${key}`, err);
    });
  }

  /** The values VS Code accepted so far, by key. Read-only view for the extension-host test hook (src/testApi.ts). */
  acceptedValues(): Record<string, boolean> {
    return Object.fromEntries(this.accepted);
  }

  dispose(): void {
    this.subscriptions.splice(0).forEach((s) => s.dispose());
  }
}
