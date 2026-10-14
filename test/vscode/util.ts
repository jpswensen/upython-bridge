/** Helpers shared by the extension-host suites. Everything here runs inside the real extension host. */
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { allCommandIds, COMMAND_IDS } from '../../src/contributes';
import { fullExtensionId, IDENTITY, settingId } from '../../src/identity';
import type { FilesRow, TestApi } from '../../src/testApi';

export { assert };

export const OUR_ID = fullExtensionId();

/** What the launcher told us (tools/vscode_test/launch.py). */
export const env = {
  suite: process.env.UPYBRIDGE_TEST_SUITE ?? '',
  workspace: process.env.UPYBRIDGE_TEST_WS ?? '',
  boardUrl: process.env.UPYBRIDGE_TEST_BOARD_URL ?? '',
  boardRoot: process.env.UPYBRIDGE_TEST_BOARD_ROOT ?? '',
  userData: process.env.UPYBRIDGE_TEST_UD ?? '',
  runRoot: process.env.UPYBRIDGE_TEST_RUN_ROOT ?? '',
  activateVia: process.env.UPYBRIDGE_TEST_ACTIVATE_VIA ?? 'view',
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(probe: () => T | Promise<T>, what: string, timeoutMs = 20_000, intervalMs = 50): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await probe();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
    }
    await sleep(intervalMs);
  }
}

export function ourExtension(): vscode.Extension<TestApi | undefined> {
  const ext = vscode.extensions.getExtension<TestApi | undefined>(OUR_ID);
  assert.ok(ext, `extension ${OUR_ID} is installed in this window`);
  return ext;
}

/** Activate our extension (if it is not yet) and return the test hook. */
export async function api(): Promise<TestApi['test']> {
  const exported = await ourExtension().activate();
  assert.ok(exported?.test, 'the extension returned its test hook (the test switch is set in the environment)');
  return exported.test;
}

/** Lines of `ps` that mention `needle` (POSIX only; the launcher's own checks cover Windows later). */
export function psMentioning(needle: string): string[] {
  if (process.platform === 'win32') return [];
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 15_000 });
  return r.stdout.split('\n').filter((l) => l.includes(needle) && !l.includes(' ps -axo'));
}

export function bridgeProcesses(): string[] {
  return psMentioning('mpy_bridge.py').filter((l) => env.runRoot === '' || l.includes(env.runRoot));
}

export function ourTerminal(): vscode.Terminal | undefined {
  return vscode.window.terminals.find((t) => t.name === IDENTITY.terminalName);
}

export async function openFile(rel: string): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(`${env.workspace}/${rel}`);
  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc, { preview: false });
}

/** The Files-view row that connects ("Connect to <port>"), when the board is not connected. */
export async function connectRow(t: TestApi['test']): Promise<FilesRow | undefined> {
  const rows = await t.filesChildren();
  return rows.find((r) => r.command === COMMAND_IDS.selectPort);
}

/** Connect through the same command the Files view row runs. Idempotent. */
export async function ensureConnected(t: TestApi['test']): Promise<void> {
  if (t.state().state !== 'disconnected') {
    await t.waitForState(['idle', 'running', 'rawop'], 30_000);
    return;
  }
  const row = await waitFor(() => connectRow(t), 'the "Connect to <port>" row', 15_000);
  const connected = await vscode.commands.executeCommand<boolean>(row.command ?? COMMAND_IDS.selectPort, ...row.commandArguments);
  assert.equal(connected, true, 'the connect command reports success');
  await t.waitForState(['idle'], 30_000);
}

/** Wait until the terminal text matches. */
export function waitForText(t: TestApi['test'], what: string | RegExp, timeoutMs = 20_000): Promise<string> {
  const matches = (s: string): boolean => (typeof what === 'string' ? s.includes(what) : what.test(s));
  return waitFor(() => (matches(t.terminalText()) ? t.terminalText() : ''), `terminal output ${String(what)}`, timeoutMs, 25).catch((err: unknown) => {
    throw new Error(`${String(err)}\n--- terminal text so far ---\n${t.terminalText().slice(-1500)}`);
  });
}

export const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration();
export { allCommandIds, COMMAND_IDS, IDENTITY, settingId };

// ------------------------------------------------------------------ diagnostics, hovers and definitions (the IntelliSense suites)

export interface Diag { code: string; message: string; line: number; source: string; severity: number }

/** The rule name of a diagnostic (Pylance sends a string or `{ value, target }`). */
export function ruleOf(d: vscode.Diagnostic): string {
  const c = d.code;
  return typeof c === 'object' && c !== null ? String((c as { value: string | number }).value) : c === undefined ? '' : String(c);
}

export function diagnosticsOf(file: string): Diag[] {
  return vscode.languages.getDiagnostics(vscode.Uri.file(file)).map((d) => ({
    code: ruleOf(d), message: d.message.split('\n')[0] ?? '', line: d.range.start.line + 1, source: d.source ?? '', severity: d.severity,
  }));
}

export const IMPORT_RULES = ['reportMissingImports', 'reportMissingModuleSource', 'reportAttributeAccessIssue'];
export const importProblems = (file: string): Diag[] => diagnosticsOf(file).filter((d) => IMPORT_RULES.includes(d.code));
export const describeDiags = (ds: Diag[]): string => (ds.length === 0 ? '(none)' : ds.map((d) => `${d.line}:${d.code || d.source}:${d.message}`).join(' | '));

/** Poll `getDiagnostics` until `predicate` holds; the failure message shows the diagnostics at the end. */
export async function waitForDiagnostics(file: string, predicate: (ds: Diag[]) => boolean, what: string, timeoutMs = 90_000): Promise<Diag[]> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ds = diagnosticsOf(file);
    if (predicate(ds)) return ds;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; diagnostics now: ${describeDiags(ds)}`);
    await sleep(250);
  }
}

/** Show a file without taking the focus from the current editor. */
export async function openBackground(file: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
  return doc;
}

function textOf(c: vscode.MarkdownString | vscode.MarkedString): string {
  return typeof c === 'string' ? c : 'value' in c ? c.value : '';
}

/** Hover text at the first occurrence of `needle` in the file (the position is `into` characters inside it). */
export async function hoverAt(file: string, needle: string, into = 0): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const pos = doc.positionAt(doc.getText().indexOf(needle) + into);
  const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos)) ?? [];
  return hovers.flatMap((h) => h.contents.map(textOf)).join('\n');
}

/** Where "go to definition" lands for the first occurrence of `needle`: file paths with 1-based line numbers. */
export async function definitionAt(file: string, needle: string, into = 0): Promise<string[]> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const pos = doc.positionAt(doc.getText().indexOf(needle) + into);
  const found = (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos)) ?? [];
  return found.map((l) => {
    const uri = 'targetUri' in l ? l.targetUri : l.uri;
    const range = 'targetRange' in l ? l.targetRange : l.range;
    return `${uri.fsPath}:${range.start.line + 1}`;
  });
}

export async function quickFixTitles(file: string, line: number): Promise<string[]> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const range = doc.lineAt(line - 1).range;
  const actions = (await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>('vscode.executeCodeActionProvider', doc.uri, range, vscode.CodeActionKind.QuickFix.value)) ?? [];
  return actions.map((a) => a.title);
}

export const read = (file: string): string => fs.readFileSync(file, 'utf8');
export const wsFile = (...parts: string[]): string => path.join(env.workspace, ...parts);
