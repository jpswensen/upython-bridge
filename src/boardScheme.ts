/**
 * The private URI scheme of the read-only documents that show a file as the BOARD has it (BoardDocumentProvider in
 * src/commands/boardFiles.ts). A leaf module, so that Run, the Board Actions row and the upload command can recognise such a
 * document without depending on the commands that open it.
 */
import * as vscode from 'vscode';
import { IDENTITY } from './identity';

/** Scheme of the read-only documents that show board files. */
export const BOARD_SCHEME = `${IDENTITY.prefix.toLowerCase()}-board`;

export function boardDocumentUri(devicePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BOARD_SCHEME, authority: 'board', path: devicePath });
}

/** True for the Uri of a board document (its `path` is the device path). */
export function isBoardDocumentUri(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return uri !== undefined && uri.scheme === BOARD_SCHEME;
}
