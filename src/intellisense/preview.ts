/**
 * Text for people: the preview of an IntelliSense plan ("what will be written / removed / left alone"), the report after it was
 * applied and the list shown before removing. Pure functions of the library's data (no `vscode`), so the wording is unit-tested.
 * Written for students: short sentences, no jargon without a word of explanation.
 */
import { IDENTITY } from '../identity';
import type { ApplyResult, RemoveResult } from './fix';
import type { BoardModuleRow } from './board';
import type { ConsentItem, IntelliSensePlan, PlannedWrite, PlanWarning } from './types';

export interface PreviewContext {
  /** One line about where the board information came from ("connected board: ...", "no board connected: ..."). */
  boardNote: string;
}

/** One line per module that came from the board (or was left out on purpose), for the preview and the Doctor. */
export function boardModuleLine(m: BoardModuleRow): string {
  const where = m.origin === 'firmware' ? 'built into the firmware' : m.origin === 'board-mpy' ? `compiled file on the board${m.from ? ` (${m.from})` : ''}` : `file on the board${m.from ? ` (${m.from})` : ''}`;
  switch (m.how) {
    case 'stub': return `\`${m.name}\` - ${where}: stub made from what the board reports (names, classes, constants; any arguments are accepted)`;
    case 'copy': return `\`${m.name}\` - ${where}: a read-only copy is used, so the editor sees the real code`;
    case 'stub-any': return `\`${m.name}\` - ${where}: the import works, but its contents are unknown${m.note ? ` (${m.note})` : ''}`;
    case 'local-wins': return `\`${m.name}\` - ${where}: not used, because your project has its own ${m.name} (your files always win)`;
    case 'never-import': return `\`${m.name}\` - ${where}: left out, because importing it would run the board's start-up code`;
  }
}

/** The folder a write is reported under: stub trees (which have many sub folders) are one bucket. */
function bucket(path: string): string {
  const parts = path.split('/');
  if (parts[0] === 'typings') { return 'typings'; }
  if (parts[0] === IDENTITY.dotDir && parts[1] === 'stubs') { return parts.slice(0, 3).join('/'); }
  return parts.slice(0, -1).join('/');
}

/** Group writes by folder: a folder with many files (the stock stubs) becomes one line. */
export function groupWrites(writes: readonly PlannedWrite[], limit = 8): { label: string; count: number; bytes: number; actions: string; reason: string }[] {
  const byDir = new Map<string, PlannedWrite[]>();
  for (const w of writes) { byDir.set(bucket(w.path), [...(byDir.get(bucket(w.path)) ?? []), w]); }
  const rows: { label: string; count: number; bytes: number; actions: string; reason: string }[] = [];
  for (const [dir, list] of byDir) {
    if (list.length > limit) {
      rows.push({ label: `${dir}/ (stub files)`, count: list.length, bytes: list.reduce((n, w) => n + w.bytes, 0), actions: summarizeActions(list), reason: list[0]?.reason ?? '' });
    } else {
      for (const w of list) { rows.push({ label: w.path, count: 1, bytes: w.bytes, actions: w.action, reason: w.reason }); }
    }
  }
  return rows.sort((a, b) => (a.label < b.label ? -1 : 1));
}

function summarizeActions(list: readonly PlannedWrite[]): string {
  const created = list.filter((w) => w.action === 'create').length;
  const changed = list.length - created;
  return [created > 0 ? `${created} new` : '', changed > 0 ? `${changed} changed` : ''].filter(Boolean).join(', ');
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function warningLines(warnings: readonly PlanWarning[]): string[] {
  const out: string[] = [];
  for (const w of warnings) {
    out.push(`- ${w.message}`);
    if (w.snippet !== undefined) {
      out.push('', '  ```', ...w.snippet.split('\n').map((l) => `  ${l}`), '  ```', '');
    }
  }
  return out;
}

/** Exact wording of the choices (also the labels of the consent prompt). */
export function consentLabel(item: ConsentItem): string {
  switch (item.id) {
    case 'create-user-config': return 'Create pyrightconfig.json';
    case 'edit-settings': return 'Add the entries to .vscode/settings.json';
  }
}

export function renderPlanMarkdown(plan: IntelliSensePlan, ctx: PreviewContext): string {
  const out: string[] = [`# ${IDENTITY.displayName}: set up MicroPython IntelliSense`, '', `Project folder: \`${plan.workspace}\``, '', plan.summary, '', ctx.boardNote];
  const b = plan.facts.board;
  if (b !== null && b.modules.length > 0) {
    out.push('', '## What comes from your board', '', `Board: ${b.label}${b.kept ? `, read on ${b.date} (not read again this time; the files from then stay as they are)` : ''}.`, '');
    for (const m of b.modules) { out.push(`- ${boardModuleLine(m)}`); }
    if (b.imported.length > 0) { out.push('', `To describe them, ${b.imported.join(', ')} ${b.imported.length === 1 ? 'was' : 'were'} imported on the board once${b.softReset ? ', and Python on the board was soft-reset afterwards (without starting main.py)' : ''}.`); }
  } else if (b === null) {
    out.push('', 'Nothing was read from the board for its own modules. If your board has modules beyond standard MicroPython, connect it (with no program running) and run this again.');
  } else {
    out.push('', `Your board (${b.label}) has no modules beyond standard MicroPython, so only the built-in stubs are used.`);
  }
  if (plan.writes.length > 0) {
    out.push('', `## Will be written (${plan.writes.length} ${plan.writes.length === 1 ? 'file' : 'files'})`, '');
    for (const g of groupWrites(plan.writes)) {
      out.push(`- \`${g.label}\`${g.count > 1 ? ` - ${g.count} files` : ''} (${g.actions}, ${kb(g.bytes)}) - ${g.reason}`);
    }
  }
  if (plan.removes.length > 0) {
    out.push('', `## Will be removed (${plan.removes.length})`, '');
    for (const r of plan.removes.slice(0, 30)) { out.push(`- \`${r.path}\` - ${r.reason}`); }
    if (plan.removes.length > 30) { out.push(`- ... and ${plan.removes.length - 30} more`); }
  }
  const adds = plan.settingsEdits.filter((e) => e.action === 'add');
  if (adds.length > 0) {
    out.push('', '## Will be added to the workspace settings', '');
    for (const e of adds) { out.push(`- \`${e.key}\` in \`${e.file}\` - ${e.reason}`); }
  }
  if (plan.unchanged.length > 0) {
    out.push('', `## Already up to date (${plan.unchanged.length} ${plan.unchanged.length === 1 ? 'file' : 'files'})`, '', 'These files already have the right content and are not touched.');
  }
  if (plan.consent.length > 0) {
    out.push('', '## Needs your yes', '');
    for (const c of plan.consent) { out.push(`- **${consentLabel(c)}.** ${c.message}`); }
  }
  if (plan.warnings.length > 0) {
    out.push('', '## Notes', '', ...warningLines(plan.warnings));
  }
  out.push(
    '', '## What is never touched', '',
    '- Your own `.py` files, `pyproject.toml` and an existing `pyrightconfig.json` are never changed.',
    `- Everything the extension creates is listed in \`${IDENTITY.dotDir}/manifest.json\`; the command "Remove ${IDENTITY.displayName} IntelliSense Files..." deletes exactly those files.`,
    `- Nothing here is copied to the board: \`${IDENTITY.dotDir}/\` and \`pyrightconfig.json\` are on the do-not-upload list.`,
    '',
  );
  return out.join('\n');
}

/** After the plan was applied: what actually happened. */
export function renderResultMarkdown(plan: IntelliSensePlan, result: ApplyResult): string {
  const out: string[] = [`# ${IDENTITY.displayName}: what changed`, '', `Project folder: \`${plan.workspace}\``, ''];
  out.push(result.errors.length === 0 ? 'Everything was written.' : `${result.errors.length} problem(s) while writing; the rest was written.`);
  if (result.written.length > 0) {
    out.push('', `## Written (${result.written.length})`, '');
    const writes = plan.writes.filter((w) => result.written.includes(w.path));
    for (const g of groupWrites(writes)) { out.push(`- \`${g.label}\`${g.count > 1 ? ` - ${g.count} files` : ''} (${g.actions})`); }
  }
  if (result.removed.length > 0) {
    out.push('', `## Removed (${result.removed.length})`, '', ...result.removed.slice(0, 30).map((p) => `- \`${p}\``));
  }
  if (result.settingsApplied.length > 0) {
    out.push('', '## Settings added', '', ...result.settingsApplied.map((k) => `- \`${k}\``));
  }
  if (result.skipped.length > 0) {
    out.push('', '## Left as it was', '', ...result.skipped.map((s) => `- \`${s.path}\` - ${s.reason}`));
  }
  if (result.errors.length > 0) {
    out.push('', '## Problems', '', ...result.errors.map((e) => `- \`${e.path}\`: ${e.message}`), '', 'Another program (a sync client or a virus scanner) may be holding a file. Wait a minute and run the setup again.');
  }
  if (plan.warnings.length > 0) { out.push('', '## Notes', '', ...warningLines(plan.warnings)); }
  out.push('', 'If the editor still shows old errors, wait a few seconds: the language server reloads by itself. If nothing changes, run "Developer: Reload Window".', '');
  return out.join('\n');
}

/** Short text for the toast after applying. */
export function resultToast(plan: IntelliSensePlan, result: ApplyResult): { level: 'info' | 'warning' | 'error'; text: string } {
  if (result.errors.length > 0) {
    return { level: 'error', text: `MicroPython IntelliSense was only partly set up: ${result.errors.length} file(s) could not be written (${result.errors[0]?.message ?? 'unknown error'}). Run the setup again in a minute.` };
  }
  const n = result.written.length;
  const bits = [`${n} ${n === 1 ? 'file' : 'files'} written`];
  if (result.removed.length > 0) { bits.push(`${result.removed.length} removed`); }
  const needsCfg = plan.warnings.some((w) => w.code === 'W_USER_CONFIG_MISSING' || w.code === 'W_USER_CONFIG_NO_EXTENDS' || w.code === 'W_USER_CONFIG_OTHER_EXTENDS' || w.code === 'W_PYPROJECT_PYRIGHT');
  return {
    level: needsCfg ? 'warning' : 'info',
    text: `MicroPython IntelliSense is set up (${bits.join(', ')}).${needsCfg ? ' One more step is needed: see the notes in "Show what changed".' : ' Import errors for MicroPython modules should disappear in a few seconds.'}`,
  };
}

export interface RemovePreviewInput {
  files: readonly string[];
  createdOnce: readonly { path: string; edited: boolean }[];
  settings: readonly string[];
  /** Links found in the managed area: Remove deletes nothing behind them. */
  links?: readonly string[];
}

export function renderRemoveDetail(input: RemovePreviewInput): string {
  const lines = [`These files were created by ${IDENTITY.displayName} and will be deleted:`, ''];
  const shown = input.files.slice(0, 12);
  for (const f of shown) { lines.push(`- ${f}`); }
  if (input.files.length > shown.length) { lines.push(`- ... and ${input.files.length - shown.length} more`); }
  for (const c of input.createdOnce) {
    lines.push(c.edited ? `- ${c.path} stays: you edited it after it was created.` : `- ${c.path} (created once; you have not edited it)`);
  }
  for (const s of input.settings) { lines.push(`- the workspace setting ${s} (only if it still has the value that was added)`); }
  for (const l of input.links ?? []) { lines.push(`- ${l} is a link to another place. Nothing behind it is deleted, and the list above may therefore be incomplete: delete the link yourself, then remove again.`); }
  lines.push('', 'Your own files are not touched.');
  return lines.join('\n');
}

export function removeToast(result: RemoveResult): { level: 'info' | 'warning' | 'error'; text: string } {
  if (result.nothingToDo) { return { level: 'info', text: `There is nothing to remove: no ${IDENTITY.displayName} IntelliSense files were found in this folder.` }; }
  if (result.errors.length > 0) {
    return { level: 'error', text: `Some IntelliSense files could not be removed (${result.errors[0]?.path ?? ''}: ${result.errors[0]?.message ?? ''}). If a program is using them, close it and try again.` };
  }
  const kept = result.keptEdited.length > 0 ? ` ${result.keptEdited.join(', ')} was kept because you changed it.` : '';
  return { level: 'info', text: `Removed ${result.removed.length} IntelliSense ${result.removed.length === 1 ? 'file' : 'files'}.${kept}` };
}
