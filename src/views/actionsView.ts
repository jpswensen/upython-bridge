/**
 * Board Actions view (ported from the old actions.ts): Run file, Open REPL, Stop / Interrupt, Reset board..., Doctor.
 * Every row is a command. The text follows the session: Run file names the file in the editor, Stop says whether anything is
 * running, Doctor flags a Python problem. Rows are never hidden, so the layout stays the same and students learn where things are.
 */
import path from 'node:path';
import * as vscode from 'vscode';
import { BOARD_SCHEME } from '../boardScheme';
import { COMMAND_IDS } from '../contributes';
import type { BoardSession } from '../types/session';
import { RowsTree, type Row } from './rowsTree';
import { summarize } from './sessionView';
import { ACTIONS_TEXT } from './strings';
import type { ViewSettings } from './viewSettings';

/** Name of the file the Run row would run, or null when the editor holds nothing runnable (for example an output panel). */
export function activeFileLabel(editor: vscode.TextEditor | undefined): string | null {
  const doc = editor?.document;
  if (doc === undefined) {
    return null;
  }
  if (doc.uri.scheme === 'untitled') {
    return ACTIONS_TEXT.runUntitled;
  }
  // The read-only board document runs as the project's file with the same name (or offers to copy it first): see RunCommand.
  if (doc.uri.scheme !== 'file' && doc.uri.scheme !== BOARD_SCHEME) {
    return null;
  }
  // `uri.path` always uses "/" (also for Windows paths), so one basename works on both systems.
  return path.posix.basename(doc.uri.path);
}

export class ActionsTree extends RowsTree {
  constructor(private readonly session: BoardSession, private readonly settings: ViewSettings) {
    super();
    this.own(session.onDidChangeState(() => this.refresh()));
    this.own(vscode.window.onDidChangeActiveTextEditor(() => this.refresh()));
    this.own(settings.onDidChange((keys) => {
      if (keys.includes('port')) {
        this.refresh();
      }
    }));
  }

  protected compute(): Row[] {
    const s = summarize(this.session.state, this.session.selectedPort, this.settings.portOverride);
    const file = activeFileLabel(vscode.window.activeTextEditor);
    return [
      {
        id: 'run', label: ACTIONS_TEXT.runLabel, description: file ?? ACTIONS_TEXT.runNoFile, tooltip: ACTIONS_TEXT.runTooltip,
        icon: 'play', color: 'charts.green', command: COMMAND_IDS.runActiveFile,
      },
      {
        id: 'repl', label: ACTIONS_TEXT.replLabel, description: ACTIONS_TEXT.replDescription, tooltip: ACTIONS_TEXT.replTooltip,
        icon: 'terminal', command: COMMAND_IDS.openRepl,
      },
      {
        // Stop stays clickable in every state: the board may be running something this window did not start, and Stop must
        // always reach the board. Only the text and the icon colour say whether there is anything to stop.
        id: 'stop', label: ACTIONS_TEXT.stopLabel, description: s.running ? ACTIONS_TEXT.stopRunning : ACTIONS_TEXT.stopIdle,
        tooltip: ACTIONS_TEXT.stopTooltip, icon: 'debug-stop', color: s.running ? 'charts.red' : 'disabledForeground', command: COMMAND_IDS.stop,
      },
      {
        id: 'reset', label: ACTIONS_TEXT.resetLabel, description: ACTIONS_TEXT.resetDescription, tooltip: ACTIONS_TEXT.resetTooltip,
        icon: 'debug-restart', color: 'charts.blue', command: COMMAND_IDS.resetBoard,
      },
      {
        id: 'intellisense', label: ACTIONS_TEXT.intellisenseLabel, description: ACTIONS_TEXT.intellisenseDescription, tooltip: ACTIONS_TEXT.intellisenseTooltip,
        icon: 'lightbulb', command: COMMAND_IDS.fixIntelliSense,
      },
      {
        id: 'doctor', label: ACTIONS_TEXT.doctorLabel,
        description: s.interpreterProblem ? ACTIONS_TEXT.doctorProblem : ACTIONS_TEXT.doctorOk, tooltip: ACTIONS_TEXT.doctorTooltip,
        icon: s.interpreterProblem ? 'warning' : 'checklist', color: s.interpreterProblem ? 'list.warningForeground' : undefined,
        command: COMMAND_IDS.doctor,
      },
    ];
  }
}
