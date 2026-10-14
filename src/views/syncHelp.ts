/**
 * The words of the sync marks (decision D-21): the hover help of every Files-view file and the legend behind the "?" button of
 * the view. Plain English for students who are not programmers; each state says what it means and what to do next. The hover
 * carries trusted command links (only the commands listed in HOVER_COMMANDS) so the next step is one click away.
 */
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../contributes';
import type { BoardNode, SyncBadge, SyncStatusDetail } from '../types/sync';
import { BADGES } from './decorations';

/** The commands a hover may link to. */
export const HOVER_COMMANDS: readonly string[] = [
  COMMAND_IDS.uploadThisFile, COMMAND_IDS.downloadThisFile, COMMAND_IDS.compareWithBoard, COMMAND_IDS.syncLegend,
  COMMAND_IDS.openFileFromBoard, COMMAND_IDS.openBoardCopy, COMMAND_IDS.toggleAutoSync,
];

const MEANING: Record<SyncBadge, string> = {
  'in-sync': 'Synced: the board has exactly the same file as your computer.',
  'local-changed': 'Your computer has newer changes that are not on the board yet.',
  'local-only': 'A new file on your computer. It is not on the board yet.',
  'board-changed': 'The board has newer changes than your computer (for example a program on the board wrote this file).',
  'board-only': 'Only on the board. Your project folder does not have this file (for example a data file your program created).',
  'conflict': 'Changed on both your computer and the board since the last sync. Nothing is replaced until you choose.',
  'differs': 'Different on the board and on your computer, and they were never synced on this computer, so it is not known which one is newer.',
  'unsaved': 'You have unsaved changes in the editor.',
  'waiting': 'Saved, and waiting to be sent to the board: a program is running or the board is not connected right now.',
  'failed': 'The last upload of this file did not work.',
};

function link(label: string, command: string, node: BoardNode): string {
  const args = encodeURIComponent(JSON.stringify([{ devicePath: node.devicePath, kind: node.kind, name: node.name, size: node.size, localOnly: node.localOnly }]));
  return `[${label}](command:${command}?${args})`;
}

/** What to do next, as one sentence plus links. */
function nextStep(detail: SyncStatusDetail, node: BoardNode): string {
  const up = link('Upload it now', COMMAND_IDS.uploadThisFile, node);
  const upLower = link('upload it now', COMMAND_IDS.uploadThisFile, node);
  const down = link('Download it to my project', COMMAND_IDS.downloadThisFile, node);
  const compare = link("Compare with the board's copy", COMMAND_IDS.compareWithBoard, node);
  switch (detail.badge) {
    case 'in-sync':
      return detail.autoSync ? 'Edit and save it: auto-sync sends your changes to the board.' : 'Auto-sync is off: after you edit it, use Upload to send it.';
    case 'local-changed':
    case 'local-only':
      return detail.autoSync ? `It is sent the next time you save it, or ${upLower}.` : `Auto-sync is off. ${up}.`;
    case 'board-changed':
      return `${down} (your copy is backed up first), or ${compare}.`;
    case 'board-only':
      return `${down}.`;
    case 'conflict':
    case 'differs':
      return `${compare}, then keep one: ${up} (the board's copy is backed up first) or ${down} (your copy is backed up first).`;
    case 'unsaved':
      return detail.autoSync ? 'Save the file (Ctrl+S or Cmd+S): auto-sync then sends it to the board.' : `Save the file, then ${upLower}.`;
    case 'waiting':
      return 'Nothing to do: it goes out as soon as the program stops or the board is connected.';
    case 'failed':
      return `${detail.failure ?? ''} ${up} to try again.`.trim();
    default:
      return '';
  }
}

/** The hover of a Files-view file: name, size, the mark and its meaning, what a click does, the next step. */
export function fileHover(node: BoardNode, detail: SyncStatusDetail | undefined, sizeText: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: [...HOVER_COMMANDS] };
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${escapeMd(node.name)}**  \n`);
  md.appendMarkdown(node.localOnly ? `Will go to ${codeSpan(node.devicePath)} on the board  \n` : `${codeSpan(node.devicePath)} on the board, ${escapeMd(sizeText)}  \n\n`);
  if (detail === undefined) {
    md.appendMarkdown('Not compared with your computer yet. Press Refresh in this view to compare.\n\n');
  } else {
    md.appendMarkdown(`${BADGES[detail.badge].badge} ${MEANING[detail.badge]}`);
    if (detail.base !== undefined && detail.base !== detail.badge && detail.badge !== 'failed') {
      md.appendMarkdown(` (${BADGES[detail.base].badge} ${MEANING[detail.base].charAt(0).toLowerCase()}${MEANING[detail.base].slice(1)})`);
    }
    md.appendMarkdown('\n\n');
    const step = nextStep(detail, node);
    if (step !== '') { md.appendMarkdown(`${step}\n\n`); }
  }
  md.appendMarkdown(node.localOnly || detail?.badge !== 'board-only'
    ? 'Click: opens your copy in the project, so you can edit and run it.'
    : "Click: opens a read-only copy of the board's file and offers to copy it into your project.");
  if (detail?.checkedAt !== undefined) {
    md.appendMarkdown(`  \n_Last compared with the board at ${detail.checkedAt.toLocaleTimeString()}._`);
  }
  md.appendMarkdown(`  \n${link('What do the marks mean?', COMMAND_IDS.syncLegend, node)}`);
  return md;
}

/** A Markdown code span. Backslash escapes are literal inside one (the hover showed `/calibration\\.json`), so the text is not
 * escaped; instead the fence is one backtick longer than the longest run of backticks in it. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (c) => `\\${c}`);
}

/** The legend (the "?" button of the Files view), as plain text for a dialog. */
export function legendText(): string {
  const order: SyncBadge[] = ['in-sync', 'local-changed', 'local-only', 'board-changed', 'board-only', 'conflict', 'differs', 'unsaved', 'waiting', 'failed'];
  const lines = order.map((b) => `${BADGES[b].badge}   ${MEANING[b]}`);
  return [
    'Up arrows: a copy from your computer to the board is needed. Down arrows: a copy from the board to your computer is available.',
    '',
    ...lines,
    '',
    'With auto-sync on, saving a file sends it to the board. A board copy that changed since the last sync is never replaced without asking, and anything replaced is backed up first.',
    'Hover over a file to see what to do next. Right-click a file to upload, download or compare it.',
  ].join('\n');
}
