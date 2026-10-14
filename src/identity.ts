/**
 * The ONLY place where the product's names live (D-14, decisions.md "Working names").
 * Renaming the extension is a change to this file plus `npm run gen:manifest`; the lint test
 * (test/unit/lint.test.ts) fails when a name appears anywhere else in src/, and when an old working name (D-18) appears anywhere in
 * src/, scripts/ or package.json.
 *
 * Pure module: no `vscode` import, so the manifest generator and plain-Node tests can use it.
 */

export const IDENTITY = {
  /** package.json "name" (the part after the publisher). ASCII. */
  extensionId: 'upython-bridge',
  publisher: 'jpswensen',
  /**
   * Product name for the Marketplace title, sidebar title, output channel and terminal tab (D-18). The first letter is U+03BC
   * GREEK SMALL LETTER MU (never the micro sign U+00B5), written as an escape so no editor can swap it for a look-alike.
   */
  displayName: '\u03bcPython Bridge',
  /** Short ASCII form for tight places and logs (D-18). */
  shortName: 'uPy Bridge',
  /** Descriptive only: "MicroPython" is never part of the product name (D-18). */
  description:
    'Run MicroPython programs, use the board REPL, keep your files in sync and get IntelliSense for boards running MicroPython, from VS Code.',
  /** Prefix of every command, view, context key and setting id. Hyphenated on purpose (D-18); valid in `when` clauses. */
  prefix: 'upy-bridge',
  /** Project-resident, portable generated files (D-05, D-06). Machine/board state never goes here. */
  dotDir: '.upy-bridge',
  /** Output channel (the log). */
  outputChannelName: '\u03bcPython Bridge',
  /** Name of the REPL / Run terminal tab. */
  terminalName: '\u03bcPython Bridge',
  /** Ignore file at the workspace root, also a project marker for activation. Renamed in stage 2 (release preparation). */
  ignoreFile: '.mpyignore',
} as const;

/** The old extension, for the coexistence check in Doctor (D-14) and the read-only legacy ignore file (D-06). */
export const LEGACY = {
  extensionId: 'DanielBucam.mpy-workbench',
  dotDir: '.mpy-workbench',
  ignoreFile: '.mpyignore',
} as const;

/** Full marketplace-style id, for `vscode.extensions.getExtension`. */
export function fullExtensionId(): string {
  return `${IDENTITY.publisher}.${IDENTITY.extensionId}`;
}

/** Command id: `<prefix>.<name>`. */
export function commandId(name: string): string {
  return `${IDENTITY.prefix}.${name}`;
}

/** Setting id: `<prefix>.<name>` (name may contain dots, e.g. `run.freshStart`). */
export function settingId(name: string): string {
  return `${IDENTITY.prefix}.${name}`;
}

/** Key in `workspaceState`/`globalState`: `<prefix>.<name>`. Never a setting id; state is per workspace or per machine. */
export function stateKey(name: string): string {
  return `${IDENTITY.prefix}.${name}`;
}

/** Context key id (for `setContext` and `when` clauses): `<prefix>.<name>`. */
export function contextKey(name: string): string {
  return `${IDENTITY.prefix}.${name}`;
}

/** View container id (activity bar). */
export function viewContainerId(): string {
  return IDENTITY.prefix;
}

/** View id: `<prefix><Name>View`, for example `files` gives `<prefix>FilesView`. */
export function viewId(name: string): string {
  return `${IDENTITY.prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}View`;
}
