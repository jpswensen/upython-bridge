/** Shared setup of the IntelliSense UI tests: a made-up "acme" project, the mocked vscode, a fake board. */
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { IntelliSenseController, type IntelliSenseDeps } from '../../../src/commands/intellisense';
import type { IntelliSensePrompter } from '../../../src/commands/intellisensePrompts';
import { ScriptedPrompter } from '../../../src/testApi';
import { FakeSession } from '../../mocks/fakeSession';
import { TempDirs, projectRoot } from '../../mocks/fixtures';
import { mock } from '../../mocks/vscode';
import { makeHarness, settle, type Harness } from '../repl.helpers';

export { settle };
export const FIXTURES = path.join(projectRoot(), 'test', 'fixtures', 'intellisense');

export interface Project {
  base: string;
  /** The workspace folder (student code). */
  ws: string;
}

/** Copy the student files into a temp folder; the names have spaces and parentheses on purpose. */
export function makeProject(dirs: TempDirs, student = 'student-acme'): Project {
  const base = dirs.make('upy-bridge-is');
  const ws = path.join(base, 'ws (acme)');
  fs.cpSync(path.join(FIXTURES, student), ws, { recursive: true });
  return { base, ws };
}

/** A board with nothing beyond stock MicroPython: the listing is empty and /lib does not exist. */
export function stockBoard(session: FakeSession): FakeSession {
  session.script('introspect.modules', { modules: {}, listing: [] });
  session.useBoardFs({});
  return session;
}

/** What `introspect.modules` reports for the made-up "acme" firmware (frozen package `acme` with `acme.motor`, C module `_acme`). */
export const ACME_MODULES: Record<string, unknown> = {
  acme: {
    attrs: ['ABI', 'Motor', '_acme', 'motor'], kinds: { ABI: 'int', Motor: 'class', _acme: 'module', motor: 'module' }, consts: { ABI: 3 },
    classes: { Motor: { members: ['run', 'stop'], kinds: { run: 'function', stop: 'function' } } }, file: 'acme/__init__.py',
  },
  'acme.motor': {
    attrs: ['Motor', '_acme'], kinds: { Motor: 'class', _acme: 'module' }, consts: {},
    classes: { Motor: { members: ['run', 'stop'], kinds: { run: 'function', stop: 'function' } } }, file: 'acme/motor.py',
  },
  _acme: { attrs: ['ABI', 'set_speed'], kinds: { ABI: 'int', set_speed: 'function' }, consts: { ABI: 3 } },
};

/** A board running the made-up "acme" firmware: help('modules') lists the frozen package and the C module; /lib does not exist. */
export function acmeBoard(session: FakeSession): FakeSession {
  session.script('introspect.modules', (args) => {
    const names = args.names ?? [];
    if (names.length === 0) { return { modules: {}, listing: ['_acme', 'acme/__init__', 'acme/motor', 'machine', 'time'] }; }
    return { modules: Object.fromEntries(names.filter((n) => n in ACME_MODULES).map((n) => [n, ACME_MODULES[n]])), listing: [] } as never;
  });
  session.useBoardFs({});
  return session;
}

export interface Rig {
  h: Harness;
  session: FakeSession;
  controller: IntelliSenseController;
  prompter: ScriptedPrompter;
}

/** The connected session by default answers like a stock board (see stockBoard); pass a session to script something else. */
export function makeRig(opts: { session?: FakeSession; prompter?: IntelliSensePrompter; deps?: Partial<IntelliSenseDeps> } = {}): Rig {
  const session = opts.session ?? stockBoard(FakeSession.connected());
  const h = makeHarness(session);
  const prompter = new ScriptedPrompter();
  const controller = new IntelliSenseController(h.services, { ...(opts.deps ?? {}), prompter: opts.prompter ?? prompter });
  return { h, session, controller, prompter };
}

export function openWorkspace(ws: string): void {
  mock.setWorkspaceFolders(ws);
}

export const read = (...parts: string[]): string => fs.readFileSync(path.join(...parts), 'utf8');
export const exists = (...parts: string[]): boolean => fs.existsSync(path.join(...parts));

/** Text of every untitled document the code opened (previews and reports). */
export function openedDocuments(): string[] {
  return vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'untitled').map((d) => d.getText());
}
