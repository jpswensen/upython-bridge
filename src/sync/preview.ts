/**
 * The "dry run" a student sees before any bulk sync: what will be copied, what differs, what will be replaced. Nothing runs
 * until they confirm (R-FS-07). One multi-select list (untick what you do not want) followed, when something will be
 * overwritten, by a modal that names the files.
 */
import * as vscode from 'vscode';
import type { SyncItem, SyncPlan, SyncReason } from '../types/sync';
import { countPlan, effectiveAction } from './plan';

const REASON_TEXT: Record<SyncReason, string> = {
  identical: 'same on both sides',
  'new-local': 'new file',
  'local-changed': 'changed on your computer',
  'board-changed': 'changed on the board',
  'both-changed': 'changed on both sides',
  'board-missing': 'missing on the board',
  'local-deleted': 'deleted on your computer',
  'board-only': 'only on the board',
  'first-sync-differs': 'different on the board',
  'user-request': 'you asked for it',
};

export function formatBytes(n: number): string {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface PickItem extends vscode.QuickPickItem { sync?: SyncItem }

function describeItem(plan: SyncPlan, it: SyncItem): string {
  const act = effectiveAction(plan, it);
  const what = it.action === 'conflict'
    ? plan.direction === 'toBoard' ? 'replace the board version' : 'replace your version'
    : act === 'delete-board' ? 'delete from the board' : act === 'delete-local' ? 'move to trash' : act === 'mkdir' ? 'create folder' : '';
  const size = it.size > 0 ? formatBytes(it.size) : '';
  return [what, REASON_TEXT[it.reason], size].filter((s) => s !== '').join(' - ');
}

/** Rows of the preview list, grouped by what will happen. Exported for tests. */
export function previewRows(plan: SyncPlan): PickItem[] {
  const rows: PickItem[] = [];
  const sep = (label: string): void => { rows.push({ label, kind: vscode.QuickPickItemKind.Separator }); };
  const group = (title: string, pick: (i: SyncItem) => boolean): void => {
    const list = plan.items.filter((i) => i.action !== 'unchanged' && pick(i));
    if (list.length === 0) { return; }
    sep(`${title} (${list.length})`);
    for (const it of list) {
      rows.push({ label: it.path, description: describeItem(plan, it), picked: it.selected, sync: it });
    }
  };
  const notes = plan.warnings.slice(0, 5);
  for (const w of notes) { sep(`Note: ${w}`); }
  if (plan.warnings.length > notes.length) { sep(`... and ${plan.warnings.length - notes.length} more notes (see the log)`); }
  group(plan.direction === 'toBoard' ? 'Will be uploaded' : 'Will be downloaded', (i) => i.action === 'upload' || i.action === 'download');
  group('New folders', (i) => i.action === 'mkdir');
  group(plan.direction === 'toBoard' ? 'Different on the board: tick to replace the board version' : 'Different on your computer: tick to replace your version', (i) => i.action === 'conflict');
  group('Will be deleted', (i) => i.action === 'delete-board' || i.action === 'delete-local');
  return rows;
}

/** Show the dry-run list. Returns the plan with `selected` updated, or undefined when the user cancelled. */
export async function previewPlan(plan: SyncPlan, title: string): Promise<SyncPlan | undefined> {
  const rows = previewRows(plan);
  const c = countPlan(plan);
  const nothing = plan.items.every((i) => i.action === 'unchanged');
  if (nothing) {
    return undefined;
  }
  const same = c.unchanged > 0 ? ` ${c.unchanged} file(s) are already the same.` : '';
  const picked = await vscode.window.showQuickPick(rows, {
    canPickMany: true,
    title,
    placeHolder: `Untick anything you do not want to copy, then press Enter. Press Escape to cancel.${same}`,
    matchOnDescription: true,
    ignoreFocusOut: true,
  }) as readonly PickItem[] | undefined;
  if (picked === undefined) {
    return undefined;
  }
  const chosen = new Set(picked.map((p) => p.sync).filter((s): s is SyncItem => s !== undefined));
  const items = plan.items.map((i) => (i.action === 'unchanged' ? i : { ...i, selected: chosen.has(i) }));
  return { ...plan, items };
}

function listNames(items: readonly SyncItem[], max = 12): string {
  const names = items.slice(0, max).map((i) => `  ${i.path}`);
  if (items.length > max) { names.push(`  ... and ${items.length - max} more`); }
  return names.join('\n');
}

/**
 * Last question before changes happen. Returns true to go ahead. Uploads that only add files need no extra question
 * (the list already was the confirmation); anything that replaces or deletes does.
 */
export async function confirmPlan(plan: SyncPlan, backupNote: string): Promise<boolean> {
  const chosen = plan.items.filter((i) => i.selected && i.action !== 'unchanged');
  if (chosen.length === 0) {
    return false;
  }
  const overwrites = chosen.filter((i) => i.action === 'conflict' || (i.action === 'download' && i.localSha256 !== undefined));
  const deletes = chosen.filter((i) => i.action === 'delete-board' || i.action === 'delete-local');
  const downloading = plan.direction === 'fromBoard';
  if (!downloading && overwrites.length === 0 && deletes.length === 0) {
    return true;
  }
  const lines: string[] = [];
  if (overwrites.length > 0) {
    lines.push(
      downloading
        ? `These files on your computer will be replaced by the board's version. A copy of each is saved first (${backupNote}):`
        : "These files on the board will be replaced by your computer's version:",
      listNames(overwrites),
    );
  }
  if (deletes.length > 0) {
    lines.push(deletes.some((d) => d.action === 'delete-board') ? 'These files will be deleted from the board:' : 'These files will be moved to the trash on your computer:', listNames(deletes));
  }
  const count = chosen.length;
  const button = downloading ? `Download ${count} file(s)` : `Upload ${count} file(s)`;
  const choice = await vscode.window.showWarningMessage(
    downloading ? 'Replace files on your computer with the versions from the board?' : 'Replace files on the board?',
    { modal: true, detail: lines.length > 0 ? lines.join('\n') : undefined },
    button,
  );
  return choice === button;
}
