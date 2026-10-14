/**
 * Errors made by the client side (never on the wire): the bridge could not be started, did not answer, or was stopped.
 * Messages are English, say what happened and what to do next. No `vscode` import.
 */
import { COMMANDS } from '../contributes';
import type { BridgeErrorBody, ErrorCode } from '../types/protocol';
import { BoardError } from '../types/session';

/** Title of the Doctor command as shown in the Command Palette (the prefix is not repeated here). */
export const DOCTOR_TITLE: string = COMMANDS.find((c) => c.name === 'doctor')?.title ?? 'Open Doctor';

export const DOCTOR_HINT = `Run "${DOCTOR_TITLE}" from the Command Palette to see what is wrong and how to fix it.`;

export function clientError(code: ErrorCode, message: string, hint = '', detail = '', op?: string, extra: Partial<BridgeErrorBody> = {}): BoardError {
  return BoardError.of(code, message, { hint, detail, ...extra }, op);
}

export function bridgeExited(detail: string, op?: string): BoardError {
  return clientError(
    'E_BRIDGE_EXITED', 'The connection helper stopped unexpectedly, so the board operation was lost.',
    `Try again. If it keeps happening: ${DOCTOR_HINT}`, detail, op,
  );
}

export function bridgeStopped(op?: string): BoardError {
  return clientError(
    'E_BRIDGE_EXITED', 'The connection helper was stopped.', 'Reload the VS Code window (Command Palette: "Developer: Reload Window") to start it again.',
    'closed', op,
  );
}

export function callTimeout(op: string, ms: number): BoardError {
  return clientError(
    'E_CALL_TIMEOUT', `The board did not answer in time (${op}, ${Math.round(ms / 100) / 10} s).`,
    'Check the USB cable and that no other program (Thonny, Arduino, PlatformIO, another VS Code window) is using the board, then try again.',
    `timeout ${ms} ms`, op,
  );
}

export function callAborted(op: string): BoardError {
  return clientError('E_ABORTED', 'The operation was cancelled.', '', 'aborted', op);
}

/** Join an error's message and hint the way a toast shows them. */
export function describeForLog(err: BoardError): string {
  return `${err.code}: ${err.message}${err.detail ? ` [${err.detail}]` : ''}`;
}
