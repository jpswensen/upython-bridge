/**
 * Shared set-up for the terminal agent's tests (repl, run, stop, reset, ports): services over a FakeSession and the vscode mock.
 * Not a test file (no `.test.ts`), so the runner does not execute it.
 */
import * as vscode from 'vscode';
import type { Services } from '../../src/types/services';
import { PortMemory, Settings } from '../../src/types/settings';
import type { FakeSession } from '../mocks/fakeSession';
import type { MockExtensionContext } from '../mocks/extensionContext';
import { createExtensionContext, createTestLogger, mock, type MockOutputChannel } from '../mocks/vscode';

export interface Harness {
  readonly services: Services;
  readonly session: FakeSession;
  readonly ctx: MockExtensionContext;
  readonly logChannel: MockOutputChannel;
  /** Registered stand-ins for commands that other agents own, with the arguments they were called with. */
  readonly stubbed: { id: string; args: unknown[] }[];
  dispose(): void;
}

export function makeHarness(session: FakeSession): Harness {
  const ctx = createExtensionContext();
  const { log, channel } = createTestLogger('debug');
  const services: Services = {
    context: ctx.vscode,
    log,
    settings: new Settings(),
    session,
    portMemory: new PortMemory(ctx.workspaceState),
  };
  return { services, session, ctx, logChannel: channel, stubbed: [], dispose: () => ctx.dispose() };
}

/** Register a command that normally belongs to another module (selectPort in run tests, doctor in ports tests, ...). */
export function stubCommand(h: Harness, id: string, result: unknown = undefined): void {
  mock.track(
    vscode.commands.registerCommand(id, (...args: unknown[]) => {
      h.stubbed.push({ id, args });
      return typeof result === 'function' ? (result as (...a: unknown[]) => unknown)(...args) : result;
    }),
  );
}

/** Let queued microtasks and 0 ms timers run (key batching, fire-and-forget calls). */
export function settle(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function decodeWrites(session: FakeSession): string {
  return session.ttyWrites.map((b) => new TextDecoder().decode(b)).join('');
}
