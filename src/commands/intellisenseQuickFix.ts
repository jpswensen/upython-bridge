/**
 * Quick fix on unresolved imports (RQ-GEN-3, D-15 item 3). When the language server reports `reportMissingImports`,
 * `reportMissingModuleSource` or `reportAttributeAccessIssue` in a Python file of a workspace folder, the light bulb offers
 * "Set up MicroPython IntelliSense for this project". When the setup already created its files and the same diagnostic persists,
 * running the setup again would not help, so it offers the Doctor report instead (which says why).
 */
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../contributes';
import { TRACKER_REL } from '../intellisense';
import type { FsLike } from '../intellisense/types';

export const FIXABLE_CODES: ReadonlySet<string> = new Set(['reportMissingImports', 'reportMissingModuleSource', 'reportAttributeAccessIssue']);
const SERVER_SOURCES = /pylance|pyright/i; // Pylance, Pyright, basedpyright
export const FIX_TITLE = 'Set up MicroPython IntelliSense for this project';
export const REPORT_TITLE = 'Open the IntelliSense report (Doctor)';

/** The rule name of a diagnostic: Pylance sends a string or `{ value, target }`. */
export function diagnosticCode(d: Pick<vscode.Diagnostic, 'code'>): string | undefined {
  const c = d.code;
  if (typeof c === 'string') { return c; }
  if (typeof c === 'object' && c !== null && 'value' in c) { return String((c as { value: string | number }).value); }
  return undefined;
}

/** Pylance's wording for a name a module does not have (`"sleep_ms" is not a known attribute of module "time"`); other attribute errors (on a str, a list...) are the user's own code. */
const MODULE_ATTRIBUTE = /is not a known attribute of module/i;
const UNRESOLVED_IMPORT = /Import "([^"]+)" could not be resolved/i;
/**
 * Well-known packages of ordinary Python that no MicroPython stub or firmware folder can provide. An unresolved import of one of
 * these means "not installed on this computer", and a light bulb that promises MicroPython IntelliSense would mislead. A heuristic
 * on purpose: any name not listed (the firmware's own modules are unknowable) still gets the offer.
 */
const DESKTOP_PACKAGES: ReadonlySet<string> = new Set([
  'numpy', 'scipy', 'pandas', 'matplotlib', 'sympy', 'seaborn', 'plotly', 'sklearn', 'torch', 'tensorflow', 'keras', 'cv2', 'pil',
  'requests', 'flask', 'django', 'fastapi', 'bs4', 'lxml', 'yaml', 'openpyxl', 'xlrd', 'serial', 'pytest', 'tkinter', 'pygame',
]);

/** True when the diagnostic is one that the MicroPython IntelliSense setup could make go away. */
export function isFixableDiagnostic(d: Pick<vscode.Diagnostic, 'code' | 'source'> & { message?: string }): boolean {
  const code = diagnosticCode(d);
  if (code === undefined || !FIXABLE_CODES.has(code) || typeof d.source !== 'string' || !SERVER_SOURCES.test(d.source)) { return false; }
  const message = d.message ?? '';
  if (code === 'reportAttributeAccessIssue') { return MODULE_ATTRIBUTE.test(message); }
  const imported = UNRESOLVED_IMPORT.exec(message)?.[1];
  return imported === undefined || !DESKTOP_PACKAGES.has((imported.split('.')[0] as string).toLowerCase());
}

export class IntelliSenseQuickFix implements vscode.CodeActionProvider {
  static readonly metadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };

  constructor(private readonly fs: Pick<FsLike, 'stat' | 'path'>) {}

  /** True when the setup's tracker file exists in the folder. */
  private async managed(folder: string): Promise<boolean> {
    return (await this.fs.stat(this.fs.path.join(folder, ...TRACKER_REL.split('/'))).catch(() => null))?.isFile === true;
  }

  async provideCodeActions(document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): Promise<vscode.CodeAction[]> {
    if (document.uri.scheme !== 'file') { return []; }
    const matching = context.diagnostics.filter((d) => isFixableDiagnostic(d));
    if (matching.length === 0) { return []; }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder === undefined || folder.uri.scheme !== 'file') { return []; }
    const done = await this.managed(folder.uri.fsPath);
    const action = new vscode.CodeAction(done ? REPORT_TITLE : FIX_TITLE, vscode.CodeActionKind.QuickFix);
    action.diagnostics = matching;
    action.command = done
      ? { command: COMMAND_IDS.doctor, title: REPORT_TITLE }
      : { command: COMMAND_IDS.fixIntelliSense, title: FIX_TITLE, arguments: [{ folder: folder.uri.fsPath, source: 'quickfix' }] };
    return [action];
  }
}

export function registerQuickFix(fs: Pick<FsLike, 'stat' | 'path'>): vscode.Disposable {
  return vscode.languages.registerCodeActionsProvider({ language: 'python', scheme: 'file' }, new IntelliSenseQuickFix(fs), IntelliSenseQuickFix.metadata);
}
