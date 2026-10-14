/** The quick fix on unresolved imports (src/commands/intellisenseQuickFix.ts), with scripted diagnostics instead of a language server. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { FIX_TITLE, REPORT_TITLE, diagnosticCode, isFixableDiagnostic, registerQuickFix } from '../../../src/commands/intellisenseQuickFix';
import { COMMAND_IDS } from '../../../src/contributes';
import { nodeFs } from '../../../src/intellisense';
import { TempDirs } from '../../mocks/fixtures';
import { mock } from '../../mocks/vscode';
import { Diagnostic, DiagnosticSeverity, Range, Uri } from '../../mocks/vscodeCore';
import { makeProject, openWorkspace, FIXTURES } from './helpers';

const dirs = new TempDirs();
beforeEach(() => mock.reset());
afterEach(() => {
  mock.reset();
  dirs.cleanup();
});

function diag(code: unknown, source: string | null = 'Pylance', message = 'Import "_acme" could not be resolved'): vscode.Diagnostic {
  const d = new Diagnostic(new Range(0, 0, 0, 5), message, DiagnosticSeverity.Warning);
  if (source !== null) { d.source = source; }
  d.code = code as never;
  return d as unknown as vscode.Diagnostic;
}

const doc = (file: string): vscode.TextDocument => ({ uri: Uri.file(file), languageId: 'python' }) as unknown as vscode.TextDocument;
const provider = (): { provideCodeActions(d: unknown, r: unknown, c: { diagnostics: vscode.Diagnostic[] }, t: unknown): Promise<vscode.CodeAction[]> } => {
  const entry = mock.codeActionProviders[0];
  assert.ok(entry, 'a provider is registered');
  return entry.provider as never;
};
const actions = (file: string, diagnostics: vscode.Diagnostic[]): Promise<vscode.CodeAction[]> => provider().provideCodeActions(doc(file), new Range(0, 0, 0, 5), { diagnostics }, undefined);

describe('which diagnostics count', () => {
  it('reads the rule name from a string or from the { value, target } form Pylance sends', () => {
    assert.equal(diagnosticCode(diag('reportMissingImports')), 'reportMissingImports');
    assert.equal(diagnosticCode(diag({ value: 'reportAttributeAccessIssue', target: Uri.file('/x') })), 'reportAttributeAccessIssue');
    assert.equal(diagnosticCode(diag(undefined)), undefined);
  });

  it('accepts the three rules from Pylance, Pyright and basedpyright and nothing else', () => {
    const attribute = '"sleep_ms" is not a known attribute of module "time"';
    for (const code of ['reportMissingImports', 'reportMissingModuleSource', 'reportAttributeAccessIssue']) {
      for (const source of ['Pylance', 'Pyright', 'basedpyright']) {
        assert.equal(isFixableDiagnostic(diag(code, source, code === 'reportAttributeAccessIssue' ? attribute : undefined)), true, `${code} from ${source}`);
      }
    }
    // review finding F9: ordinary Python libraries and plain attribute errors cannot be fixed by MicroPython stubs
    assert.equal(isFixableDiagnostic(diag('reportMissingImports', 'Pylance', 'Import "numpy" could not be resolved')), false);
    assert.equal(isFixableDiagnostic(diag('reportMissingModuleSource', 'Pylance', 'Import "yaml.constructor" could not be resolved from source')), false);
    assert.equal(isFixableDiagnostic(diag('reportAttributeAccessIssue', 'Pylance', 'Cannot access attribute "foo" for class "str"')), false);
    assert.equal(isFixableDiagnostic(diag('reportMissingImports', 'Pylance', 'Import "acmemotors" could not be resolved')), true, 'a firmware module the list cannot know is still offered');
    assert.equal(isFixableDiagnostic(diag('reportMissingImports', 'flake8')), false);
    assert.equal(isFixableDiagnostic(diag('reportMissingImports', null)), false);
    assert.equal(isFixableDiagnostic(diag('reportCallIssue')), false);
    assert.equal(isFixableDiagnostic(diag('reportUndefinedVariable')), false);
  });
});

describe('the provider', () => {
  it('is registered for Python files and offers the quick fix that runs the command for the folder', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    mock.track(registerQuickFix(nodeFs()));
    const entry = mock.codeActionProviders[0];
    assert.deepEqual(entry?.selector, { language: 'python', scheme: 'file' });
    const result = await actions(path.join(p.ws, 'main.py'), [diag('reportMissingImports'), diag('reportCallIssue')]);
    assert.equal(result.length, 1);
    const a = result[0];
    assert.equal(a?.title, FIX_TITLE);
    assert.equal(a?.kind?.value, 'quickfix');
    assert.equal(a?.diagnostics?.length, 1, 'only the matching diagnostic is attached');
    assert.equal(a?.command?.command, COMMAND_IDS.fixIntelliSense);
    assert.deepEqual(a?.command?.arguments, [{ folder: p.ws, source: 'quickfix' }]);
  });

  it('offers the Doctor report instead once the setup has made its files and the diagnostic persists', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.writeFileSync(path.join(p.ws, '.upy-bridge', 'manifest.json'), '{}');
    mock.track(registerQuickFix(nodeFs()));
    const result = await actions(path.join(p.ws, 'main.py'), [diag('reportAttributeAccessIssue', 'Pylance', '"sleep_ms" is not a known attribute of module "time"')]);
    assert.deepEqual(result.map((a) => [a.title, a.command?.command]), [[REPORT_TITLE, COMMAND_IDS.doctor]]);
  });

  it('offers nothing outside a workspace folder, for untitled files, or without a matching diagnostic', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    mock.track(registerQuickFix(nodeFs()));
    assert.deepEqual(await actions(path.join(FIXTURES, 'student-acme', 'main.py'), [diag('reportMissingImports')]), []);
    assert.deepEqual(await actions(path.join(p.ws, 'main.py'), [diag('reportCallIssue')]), []);
    const untitled = { uri: Uri.from({ scheme: 'untitled', path: 'Untitled-1' }), languageId: 'python' };
    assert.deepEqual(await provider().provideCodeActions(untitled, new Range(0, 0, 0, 1), { diagnostics: [diag('reportMissingImports')] }, undefined), []);
  });

  it('the command it points at runs (the fix command is registered by the feature)', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    let seen: unknown;
    mock.track(vscode.commands.registerCommand(COMMAND_IDS.fixIntelliSense, (arg?: unknown) => { seen = arg; }));
    mock.track(registerQuickFix(nodeFs()));
    const [a] = await actions(path.join(p.ws, 'main.py'), [diag('reportMissingImports')]);
    await vscode.commands.executeCommand(a?.command?.command ?? '', ...(a?.command?.arguments ?? []));
    assert.deepEqual(seen, { folder: p.ws, source: 'quickfix' });
  });
});
