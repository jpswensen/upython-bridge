/**
 * How sync code talks to the board: one wrapper around `BoardSession.call` that implements the consent flows of the contract
 * (docs/extension-design.md section 3) and turns bridge errors into sentences for students.
 *
 *   E_PROGRAM_RUNNING + needs_interrupt  -> ask the user ONCE per operation, then repeat the call with `interrupt: true`
 *   fs.rmtree + needs_allow_mount        -> ask explicitly, then repeat with `allowMount: true` (see `rmtreeWithConsent`)
 *
 * Background callers (auto-sync, tree refresh) never ask: they get the error and defer.
 */
import * as vscode from 'vscode';
import type { OpArgs, OpName, OpResult } from '../types/protocol';
import { BoardError, isBoardError, userMessage, type BoardSession, type CallOptions } from '../types/session';

/** Error codes that mean "the connection itself is gone": there is no point in trying the next file. */
export const CONNECTION_ERRORS: readonly string[] = [
  'E_NOT_CONNECTED', 'E_NO_DEVICE', 'E_BRIDGE_EXITED', 'E_NO_PYTHON', 'E_PORT_BUSY', 'E_PERMISSION', 'E_BOARD_UNRESPONSIVE', 'E_RAW_REPL_TIMEOUT',
];

export function isConnectionError(err: unknown): boolean {
  return err instanceof BoardError && CONNECTION_ERRORS.includes(err.code);
}

export function isAborted(err: unknown): boolean {
  return isBoardError(err, 'E_ABORTED') || isBoardError(err, 'E_CANCELLED');
}

/** Per-operation memory of what the user agreed to, so one Upload all asks "stop the program?" at most once. */
export class Consent {
  interrupt = false;
  declined = false;
  private question: Promise<boolean> | undefined;

  /** @param background auto-sync and refresh: never ask, never interrupt */
  constructor(private readonly ask: () => Thenable<boolean>, readonly background = false) {}

  async obtain(): Promise<boolean> {
    if (this.interrupt) {
      return true;
    }
    if (this.declined || this.background) {
      return false;
    }
    this.question ??= Promise.resolve(this.ask()).then((ok) => {
      this.interrupt = ok;
      this.declined = !ok;
      return ok;
    });
    return this.question;
  }
}

/** The standard question (modal, so it cannot be missed while a student is looking at the board). */
export function askToInterrupt(what: string): Thenable<boolean> {
  const stop = 'Stop the program and continue';
  return vscode.window
    .showWarningMessage(
      `A program is still running on the board. ${what} needs the board to be idle, so the program has to be stopped first.`,
      { modal: true, detail: 'Press Stop in the Board Actions view if you would rather stop it yourself.' },
      stop,
    )
    .then((choice) => choice === stop);
}

/** `session.call` with the interrupt consent flow. Rejects with the original BoardError when the user says no. */
export async function callWithConsent<K extends OpName>(
  session: BoardSession, consent: Consent, op: K, args: OpArgs<K>, opts?: CallOptions,
): Promise<OpResult<K>> {
  const withFlags = (a: OpArgs<K>, extra: Record<string, unknown>): OpArgs<K> => ({ ...a, ...extra }) as OpArgs<K>; // extra flags are Gated fields
  try {
    return await session.call(op, consent.interrupt ? withFlags(args, { interrupt: true }) : args, opts);
  } catch (err) {
    if (err instanceof BoardError && err.code === 'E_PROGRAM_RUNNING' && err.needsInterrupt && !consent.interrupt) {
      if (await consent.obtain()) {
        return session.call(op, withFlags(args, { interrupt: true }), opts);
      }
    }
    throw err;
  }
}

/**
 * Remove a board folder tree. A mount point (for example an SD card) is only removed after the user agrees explicitly.
 * Returns 'removed' or 'skipped-mount' (the user said no); anything else is thrown.
 */
export async function rmtreeWithConsent(
  session: BoardSession, consent: Consent, devicePath: string, opts?: CallOptions,
): Promise<{ result: 'removed'; removed: number } | { result: 'skipped-mount' }> {
  try {
    const r = await callWithConsent(session, consent, 'fs.rmtree', { path: devicePath, confirm: true }, opts);
    return { result: 'removed', removed: r.removed };
  } catch (err) {
    if (err instanceof BoardError && err.needsAllowMount) {
      const yes = 'Delete the contents of this storage';
      const choice = await vscode.window.showWarningMessage(
        `${devicePath} is a separate storage (for example an SD card) that is attached to the board.`,
        { modal: true, detail: 'Deleting it removes everything on that storage, not only files from your project. This cannot be undone.' },
        yes,
      );
      if (choice !== yes) {
        return { result: 'skipped-mount' };
      }
      const r = await callWithConsent(session, consent, 'fs.rmtree', { path: devicePath, confirm: true, allowMount: true }, opts);
      return { result: 'removed', removed: r.removed };
    }
    throw err;
  }
}

/** A student-readable sentence for a failure while handling `what` (a file name or a short action). */
export function describeFailure(what: string, err: unknown): { code: string; message: string } {
  if (err instanceof BoardError) {
    if (err.code === 'E_SHADOWS_MODULE') {
      return {
        code: err.code,
        message: `${what}: this name is used by a module that is built into the board, so sending it would hide that module and break programs. Rename the file and try again.`,
      };
    }
    if (err.code === 'E_FS_ERRNO' && /EEXIST/.test(err.detail)) {
      return { code: err.code, message: `${what}: something with this name already exists on the board. Choose a different name, or delete the existing one first.` };
    }
    return { code: err.code, message: `${what}: ${userMessage(err)}` };
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return { code: typeof code === 'string' ? code : 'E_LOCAL_IO', message: `${what}: ${userMessage(err)}` };
}
