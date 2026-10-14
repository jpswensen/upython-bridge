/**
 * Test hook for the real extension host (tools/vscode_test/launch.py, test/vscode). It exists ONLY when the extension host runs
 * with the test switch below set to 1; without it activate() returns nothing and no code of this file runs, so production
 * behaviour is unchanged (test/unit/testApi.test.ts). The API is read-only introspection plus one waiting helper: it cannot
 * connect, run, write a setting or touch the board. The output tap records what the board terminal shows and receives.
 */
import type * as vscode from 'vscode';
import type { FixOutcome, IntelliSenseController } from './commands/intellisense';
import type { ImportRequest, IntelliSensePrompter, OfferAnswer } from './commands/intellisensePrompts';
import type { Consent, IntelliSensePlan } from './intellisense';
import type { TerminalTap } from './repl/terminal';
import { StatusBar } from './statusbar';
import type { BoardState } from './types/protocol';
import type { Services } from './types/services';
import type { SessionState } from './types/session';
import { ContextKeys } from './views/contextKeys';
import { FilesTree, type FilesNode } from './views/filesView';

export const TEST_SWITCH = 'UPYBRIDGE_TEST'; // lint-allow: identity-names the documented test-only environment switch

export function testHookEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TEST_SWITCH] === '1';
}

/** One row of the Files view as VS Code would draw it. */
export interface FilesRow {
  readonly label: string;
  readonly description: string;
  readonly kind: 'file' | 'dir' | 'status';
  /** Command id run when the row is clicked, if any. */
  readonly command: string | undefined;
  /** Arguments of that command, as given to VS Code. */
  readonly commandArguments: readonly unknown[];
  /** D-21: a project file (or folder) that is not on the board yet, shown where it will go. */
  readonly localOnly: boolean;
}

/** What the scripted prompter answers (modal questions cannot be answered from inside a host test). */
export interface IntelliSenseScript {
  /** The consent given when the setup asks; `null` cancels. Default: nothing is consented to except writing the generated files. */
  consent?: Partial<Consent> | null;
  /** The answer to the first-connect offer; `null` dismisses it. Default `later`. */
  offer?: OfferAnswer | null;
  /** The answer to "remove these files?". Default true. */
  confirmRemove?: boolean;
  /** The answer to "import these modules on the board to learn what they contain?"; `null` dismisses it. Default `continue`. */
  importModules?: 'continue' | 'skip' | null;
}

export interface IntelliSenseCalls {
  /** One entry per time the setup asked for consent, with the plan's summary and the ids it asked about. */
  choose: { summary: string; asked: string[]; writes: string[]; warnings: string[] }[];
  offers: number;
  removes: string[];
  /** One entry per import question: the module names asked about. */
  imports: string[][];
}

/** Test double of the IntelliSense questions: records them and answers as scripted. Used only when the test switch is set. */
export class ScriptedPrompter implements IntelliSensePrompter {
  private script: IntelliSenseScript = {};
  readonly record: IntelliSenseCalls = { choose: [], offers: 0, removes: [], imports: [] };

  /** Later calls add to (and override) earlier ones, so a test can change one answer without losing the others. */
  set(script: IntelliSenseScript): void { this.script = { ...this.script, ...script }; }

  async choose(plan: IntelliSensePlan): Promise<Consent | undefined> {
    this.record.choose.push({ summary: plan.summary, asked: plan.consent.map((c) => c.id), writes: plan.writes.map((w) => w.path), warnings: plan.warnings.map((w) => w.code) });
    if (this.script.consent === null) { return undefined; }
    return { createUserConfig: false, editSettings: false, ...(this.script.consent ?? {}) };
  }

  async importModules(request: ImportRequest): Promise<'continue' | 'skip' | undefined> {
    this.record.imports.push([...request.modules]);
    return this.script.importModules === null ? undefined : this.script.importModules ?? 'continue';
  }

  async confirmRemove(detail: string): Promise<boolean> {
    this.record.removes.push(detail);
    return this.script.confirmRemove ?? true;
  }

  async offer(): Promise<OfferAnswer | undefined> {
    this.record.offers++;
    return this.script.offer === null ? undefined : this.script.offer ?? 'later';
  }
}

export interface TestApi {
  readonly test: {
    /** Script the answers of the IntelliSense questions, read what was asked, and what the last setup run did. */
    readonly intellisense: {
      script(script: IntelliSenseScript): void;
      calls(): IntelliSenseCalls;
      lastRun(): FixOutcome | undefined;
    };
    /** Copy of the board session state (bridge process state, board state, port, identity...). */
    state(): SessionState;
    /** Children of a board folder in the Files view (the root when omitted). */
    filesChildren(devicePath?: string): Promise<FilesRow[]>;
    /** Everything the board terminal wrote since the last clear, without colour codes, line breaks as \n. */
    terminalText(): string;
    /** Everything the board terminal RECEIVED as input (from the keyboard, sendText or other extensions), before filtering. */
    terminalInputs(): string[];
    clearTerminal(): void;
    statusBarTexts(): { board: string; boardTooltip: string; autoSync: string };
    /** The context keys (`<prefix>.connected`, ...) that VS Code accepted through `setContext`, with their values: what the manifest's `when` clauses see. */
    contextKeys(): Record<string, boolean>;
    /** Resolves with the state once the board state is one of `states` (for example `idle`), rejects after `timeoutMs`. */
    waitForState(states: readonly BoardState[], timeoutMs: number): Promise<SessionState>;
  };
}

const MAX_CAPTURE = 400_000;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Collects the terminal tap data and builds the API once the services exist. */
export class TestRecorder {
  private output = '';
  private inputs: string[] = [];

  /** The prompter the extension uses instead of the real questions. */
  readonly intellisense = { prompter: new ScriptedPrompter() };

  /** Pass to the terminal feature as its `tap`. */
  readonly tap: TerminalTap = {
    output: (text) => {
      this.output = (this.output + text).slice(-MAX_CAPTURE);
    },
    input: (data) => {
      this.inputs.push(data);
    },
  };

  build(services: Pick<Services, 'session'>, viewParts: readonly vscode.Disposable[], controller?: Pick<IntelliSenseController, 'last'>): TestApi {
    const files = viewParts.find((p): p is FilesTree => p instanceof FilesTree);
    const bar = viewParts.find((p): p is StatusBar => p instanceof StatusBar);
    const keys = viewParts.find((p): p is ContextKeys => p instanceof ContextKeys);
    if (files === undefined || bar === undefined || keys === undefined) {
      throw new Error('test hook: the Files view, the status bar or the context keys were not created');
    }
    const { session } = services;
    const rowOf = async (node: FilesNode): Promise<FilesRow> => {
      const item = await Promise.resolve(files.getTreeItem(node));
      const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
      return {
        label,
        description: typeof item.description === 'string' ? item.description : '',
        kind: node.kind,
        command: item.command?.command,
        commandArguments: item.command?.arguments ?? [],
        localOnly: node.kind !== 'status' && node.localOnly === true,
      };
    };
    const prompter = this.intellisense.prompter;
    return {
      test: {
        intellisense: {
          script: (script) => { prompter.set(script); },
          calls: () => ({ choose: [...prompter.record.choose], offers: prompter.record.offers, removes: [...prompter.record.removes], imports: prompter.record.imports.map((i) => [...i]) }),
          lastRun: () => controller?.last,
        },
        state: () => ({ ...session.state }),
        filesChildren: async (devicePath) => {
          const parent: FilesNode | undefined = devicePath === undefined
            ? undefined
            : { kind: 'dir', devicePath, name: devicePath.split('/').pop() ?? devicePath };
          const nodes = await files.getChildren(parent);
          return Promise.all(nodes.map(rowOf));
        },
        terminalText: () => this.output.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
        terminalInputs: () => [...this.inputs],
        clearTerminal: () => {
          this.output = '';
          this.inputs = [];
        },
        statusBarTexts: () => bar.texts,
        contextKeys: () => keys.acceptedValues(),
        waitForState: (states, timeoutMs) => new Promise<SessionState>((resolve, reject) => {
          const want = (s: SessionState): boolean => states.includes(s.state);
          if (want(session.state)) {
            resolve({ ...session.state });
            return;
          }
          const timer = setTimeout(() => {
            subscription.dispose();
            reject(new Error(`timed out after ${timeoutMs} ms waiting for board state ${states.join(' or ')}; it is ${session.state.state}`));
          }, timeoutMs);
          const subscription = session.onDidChangeState((s) => {
            if (want(s)) {
              clearTimeout(timer);
              subscription.dispose();
              resolve({ ...s });
            }
          });
        }),
      },
    };
  }
}
