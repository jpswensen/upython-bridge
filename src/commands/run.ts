/**
 * "Run Current File on Board" (D-07, RQ-RUN-1/2): save the editor's file, make sure a board is connected, bring library files
 * up to date, then let the bridge run the file as `__main__` with the LOCAL path as the file name, so a traceback reads
 * `File "<local path>", line N` and VS Code's terminal link detection makes it clickable. The program's output and keystrokes
 * go through the board terminal; this command only starts the run and reports how it ended.
 *
 * No `mpremote run`, no `import` of a board copy, no hard reset.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { isBoardDocumentUri } from '../boardScheme';
import { COMMAND_IDS } from '../contributes';
import { offerReset, registerGuarded, reportError, reportWarning, STOP_CALL_TIMEOUT_MS } from '../repl/commandSupport';
import type { TerminalPort } from '../repl/terminal';
import type { OpArgs } from '../types/protocol';
import type { SelectPortArgs, Services } from '../types/services';
import { isBoardError, userMessage } from '../types/session';
import type { SyncGate } from '../types/sync';
import { COPY_AND_RUN_BUTTON, NO_FOLDER_TEXT, type BoardCopyPort } from './boardCopy';
import type { LocalCounterpart } from '../sync/service';

const STOP_AND_RUN = 'Stop it and run';

export interface RunDeps {
  terminal: Pick<TerminalPort, 'show' | 'beginRun' | 'endRun' | 'runs'>;
  /** Sync's gate (D-07): pending library files are uploaded before the run. Optional so the command works without sync. */
  syncGate?: Pick<SyncGate, 'pendingCount' | 'flushPending'>;
  /**
   * What a board document (the Files-view click on a file that is only on the board) turns into: its project file, or the offer to
   * copy it. Without it a board document is refused with the old explanation.
   */
  boardFiles?: {
    localCounterpart(devicePath: string): Promise<LocalCounterpart>;
    copy: BoardCopyPort;
  };
}

/** What to run: a Uri passed by a menu, else whatever the active editor shows. */
function targetUri(arg: unknown): vscode.Uri | undefined {
  return arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
}

/** The file to run: a Uri passed by a menu, else the active editor's document. */
async function documentFor(arg: unknown): Promise<vscode.TextDocument | undefined> {
  if (arg instanceof vscode.Uri) {
    return vscode.workspace.openTextDocument(arg);
  }
  return vscode.window.activeTextEditor?.document;
}

const isPython = (doc: vscode.TextDocument): boolean => doc.languageId === 'python' || /\.py$/i.test(doc.fileName);

export class RunCommand {
  constructor(private readonly services: Services, private readonly deps: RunDeps) {}

  async run(arg?: unknown): Promise<void> {
    const { session, settings, log } = this.services;
    const board = targetUri(arg);
    if (isBoardDocumentUri(board) && this.deps.boardFiles !== undefined) {
      // The read-only board document cannot run, but the file it stands for can: run that one (or offer to create it).
      const local = await this.projectFileFor(board);
      if (local === undefined) { return; }
      arg = local;
    }
    const doc = await documentFor(arg);
    if (!doc) {
      await reportWarning(this.services, 'Open the Python file you want to run first, then press Run.');
      return;
    }
    const name = path.posix.basename(doc.uri.path); // Uri.path is always '/'-separated, also for Windows files
    if (doc.isUntitled) {
      await reportWarning(this.services, 'This file has not been saved yet. Save it with a name ending in .py, then press Run.');
      return;
    }
    if (doc.uri.scheme !== 'file') {
      await reportWarning(this.services, `${name} is not a file on this computer, so it cannot be run. Open a .py file from your project folder.`);
      return;
    }
    if (!isPython(doc)) {
      await reportWarning(this.services, `${name} is not a Python file. Only files ending in .py can run on the board.`);
      return;
    }

    if (doc.isDirty && !(await doc.save())) {
      await reportWarning(this.services, `${name} could not be saved, so it was not run. Save it yourself (Ctrl+S or Cmd+S) and try again.`);
      return;
    }

    const connected = await vscode.commands.executeCommand<boolean>(COMMAND_IDS.selectPort, { reuse: true } satisfies SelectPortArgs);
    if (connected !== true) {
      return; // no port chosen or the connection failed: the port command already explained
    }
    // The question comes first: saved files can only be sent to an idle board, so a "yes" also means "stop it before sending".
    const programRunning = session.state.state === 'running';
    if (programRunning && !(await this.confirmStop(name))) {
      return;
    }
    if (!(await this.bringLibrariesUpToDate(programRunning ? name : undefined))) {
      return;
    }

    this.deps.terminal.show(false);
    this.deps.terminal.beginRun(name);
    const local = doc.uri.fsPath;
    const args: OpArgs<'run'> = { local, name: local, reset: settings.runFreshStart };
    try {
      let res;
      try {
        res = await this.runOnBoard(args);
      } catch (err) {
        if (!(isBoardError(err, 'E_PROGRAM_RUNNING') && err.needsInterrupt && (await this.confirmStop(name)))) {
          throw err;
        }
        // The bridge asked for consent first; now it has it. (`interrupt` is not in the typed RunArgs yet.)
        const again = { ...args, interrupt: true };
        res = await this.runOnBoard(again);
      }
      log.info(`Run ${local}: ${res.exit} after ${res.durationMs} ms`);
      this.deps.terminal.endRun({ kind: 'finished', exit: res.exit, durationMs: res.durationMs });
      vscode.window.setStatusBarMessage(this.summary(name, res.exit, res.durationMs), 6000);
    } catch (err) {
      this.deps.terminal.endRun({ kind: 'failed', message: userMessage(err) });
      const choice = await reportError(
        this.services,
        `Could not run ${name}.`,
        err,
        ...(isBoardError(err, 'E_NOT_CONNECTED') ? ['Select Serial Port'] : []),
      );
      if (choice === 'Select Serial Port') {
        await vscode.commands.executeCommand(COMMAND_IDS.selectPort);
      }
    }
  }

  /**
   * A board document stands for a file of the project. Returns that file's Uri (shown in the editor) when it exists. Otherwise
   * returns undefined after telling the student what to do; when the file is only on the board the toast offers to copy it into
   * the project, and the run starts after the copy. Nothing here waits for the toast.
   */
  private async projectFileFor(board: vscode.Uri): Promise<vscode.Uri | undefined> {
    const boardFiles = this.deps.boardFiles;
    if (boardFiles === undefined) { return undefined; }
    const name = path.posix.basename(board.path);
    if (!/\.py$/i.test(name)) {
      await reportWarning(this.services, `${name} is not a Python file. Only files ending in .py can run on the board.`);
      return undefined;
    }
    const where = await boardFiles.localCounterpart(board.path);
    switch (where.kind) {
      case 'file': {
        const uri = vscode.Uri.file(where.abs);
        await vscode.window.showTextDocument(uri, { preview: true });
        return uri;
      }
      case 'missing':
        boardFiles.copy.offer(board.path, COPY_AND_RUN_BUTTON, async (local) => {
          const uri = vscode.Uri.file(local);
          await vscode.window.showTextDocument(uri, { preview: true });
          await this.run(uri);
        });
        return undefined;
      case 'no-folder':
        await reportWarning(this.services, `${name} is only on the board. ${NO_FOLDER_TEXT}`);
        return undefined;
      case 'unmapped':
        await reportWarning(this.services, `${name} cannot run from here because it has no place in your project folder. ${where.why}`);
        return undefined;
    }
  }

  /**
   * One `run` call, bracketed for the terminal (D-17): only while it is in flight is the program on the board ours, so closing
   * the Run tab may stop it. The consent question in between is outside the bracket (the program it asks about is not ours).
   */
  private async runOnBoard(args: OpArgs<'run'>): Promise<{ exit: 'ok' | 'exception' | 'interrupted' | 'disconnected'; durationMs: number }> {
    const { runs } = this.deps.terminal;
    runs.begin();
    try {
      return await this.services.session.call('run', args);
    } finally {
      runs.end();
    }
  }

  /** The question is asked at most once per click. */
  private async confirmStop(name: string): Promise<boolean> {
    const answer = await reportWarning(this.services, `A program may already be running on the board. Stop it and run ${name}?`, STOP_AND_RUN);
    return answer === STOP_AND_RUN;
  }

  /**
   * D-07: library files changed since the last sync are uploaded first, so `import mylib` sees the code on screen. Edited but
   * unsaved files are saved first when auto-sync is on or has work pending. False means: do not run with a stale board.
   */
  private async bringLibrariesUpToDate(stopFirstFor?: string): Promise<boolean> {
    const gate = this.deps.syncGate;
    if (!gate || (this.services.settings.autoSync !== 'on' && gate.pendingCount === 0)) {
      return true;
    }
    try {
      await vscode.workspace.saveAll(false);
      // The student agreed to stop the running program (the bridge refuses uploads to a busy board, and auto-sync never asks).
      if (stopFirstFor !== undefined && gate.pendingCount > 0 && !(await this.stopForUpload(stopFirstFor))) {
        return false;
      }
      const res = await gate.flushPending();
      if (!res.ok) {
        await reportWarning(
          this.services,
          `${res.failed} file(s) could not be uploaded to the board, so the program was not started (it would use old code). The Sync utilities and the log say which files; fix the problem and press Run again.`,
        );
      }
      return res.ok;
    } catch (err) {
      await reportError(this.services, 'Your other files could not be sent to the board before running.', err);
      return false;
    }
  }

  /** Stop (Ctrl-C twice, never a reset) so the waiting files can be sent. False: the program is still running, nothing was started. */
  private async stopForUpload(name: string): Promise<boolean> {
    const { session, log } = this.services;
    try {
      const res = await session.call('stop', {}, { timeoutMs: STOP_CALL_TIMEOUT_MS });
      if (res.stopped) {
        log.info(`Run: stopped the running program in ${res.ms} ms so that the waiting files can be sent`);
        return true;
      }
      await offerReset(this.services, `The board did not react to Stop, so ${name} was not started.`);
    } catch (err) {
      await reportError(this.services, `The program that is running on the board could not be stopped, so ${name} was not started.`, err);
    }
    return false;
  }

  private summary(name: string, exit: 'ok' | 'exception' | 'interrupted' | 'disconnected', durationMs: number): string {
    switch (exit) {
      case 'ok':
        return `${name} finished in ${(durationMs / 1000).toFixed(1)} s`;
      case 'exception':
        return `${name} stopped with an error. See the terminal.`;
      case 'interrupted':
        return `${name} was stopped`;
      case 'disconnected':
        return `The board disconnected while ${name} was running`;
    }
  }
}

export function registerRun(services: Services, deps: RunDeps): vscode.Disposable[] {
  const run = new RunCommand(services, deps);
  return [registerGuarded(services, COMMAND_IDS.runActiveFile, (arg?: unknown) => run.run(arg), undefined)];
}
