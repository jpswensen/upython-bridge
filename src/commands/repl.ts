/**
 * "Open REPL": make sure a board is connected, show the board terminal and attach it. Opening the REPL never resets, never
 * interrupts a running program and never types anything (RQ-SAFE-1); the terminal just starts to show what the board prints.
 */
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../contributes';
import { registerGuarded, reportError } from '../repl/commandSupport';
import type { TerminalPort } from '../repl/terminal';
import type { SelectPortArgs, Services } from '../types/services';

export interface ReplCommandDeps {
  terminal: Pick<TerminalPort, 'show' | 'attach'>;
}

export class OpenReplCommand {
  constructor(private readonly services: Services, private readonly deps: ReplCommandDeps) {}

  async run(): Promise<void> {
    const st = this.services.session.state;
    const connected = st.port !== null && st.state !== 'disconnected' && st.state !== 'connecting';
    if (!connected) {
      const ok = await vscode.commands.executeCommand<boolean>(COMMAND_IDS.selectPort, { reuse: true } satisfies SelectPortArgs);
      if (ok !== true) {
        return; // the port command already told the user why (or the user cancelled)
      }
    }
    this.deps.terminal.show(false);
    try {
      await this.deps.terminal.attach();
    } catch (err) {
      await reportError(this.services, 'The terminal could not connect to the board.', err);
    }
  }
}

export function registerRepl(services: Services, deps: ReplCommandDeps): vscode.Disposable[] {
  const repl = new OpenReplCommand(services, deps);
  return [registerGuarded(services, COMMAND_IDS.openRepl, () => repl.run(), undefined)];
}
