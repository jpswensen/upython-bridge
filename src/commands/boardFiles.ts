/**
 * Files-view commands that act on the board: open a board file, new file, new folder, rename, delete, delete from board and
 * computer. All go through BoardSession; every destructive step asks first.
 *
 * What a click does (the students' model is "the file in the Files view IS my file"): if the project has that file, it opens
 * (so Run, Save and auto-sync work on it like on any file); if the file is only on the board, the board's copy opens read-only and
 * a toast offers to copy it into the project. "Open the Board's Copy (Read-Only)" always shows the board's own version.
 */
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import * as vscode from 'vscode';
import { BOARD_SCHEME, boardDocumentUri } from '../boardScheme';
import { COMMAND_IDS } from '../contributes';
import { callWithConsent, describeFailure, rmtreeWithConsent, type Consent } from '../sync/boardAccess';
import { PathError, describeProblem, importRootsFrom, segmentProblem, shadowedModule } from '../sync/paths';
import { offerOpenFolder } from '../projectFolder';
import type { SyncService } from '../sync/service';
import { showToast } from '../toast';
import type { Services } from '../types/services';
import type { BoardNode } from '../types/sync';
import { BoardCopy, COPY_BUTTON, NO_FOLDER_TEXT } from './boardCopy';

export { BOARD_SCHEME, boardDocumentUri };

export interface BoardFileCommandDeps {
  sync: SyncService;
  /** The copy flow shared with Run; made here when the caller has none. */
  copy?: BoardCopy;
}

/** Largest board file shown in an editor tab. */
export const MAX_OPEN_BYTES = 1024 * 1024;

/** Content provider for board files: downloads on demand, always fresh, read-only by nature of the provider. */
export class BoardDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly services: Services, private readonly sync: SyncService) {}

  invalidate(uri: vscode.Uri): void { this.changed.fire(uri); }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { session } = this.services;
    const consent = this.sync.newConsent('Reading the file');
    const remote = uri.path;
    const st = await callWithConsent(session, consent, 'fs.stat', { path: remote }, { timeoutMs: 15000 });
    if (!st.exists) { throw new Error(`${remote} does not exist on the board any more. Refresh the Files view.`); }
    if ((st.size ?? 0) > MAX_OPEN_BYTES) {
      throw new Error(`${remote} is too big to show here (${Math.round((st.size ?? 0) / 1024)} KB). Download it with Download All Files instead.`);
    }
    const scratch = nodePath.join(this.sync.storageDir(), 'board-files', `${process.pid}-${Date.now()}`);
    const local = nodePath.join(scratch, 'file');
    try {
      await callWithConsent(session, consent, 'fs.get', { remote, local }, { timeoutMs: 60000 });
      const bytes = await fsp.readFile(local);
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`${remote} is not a text file, so it cannot be shown. Download it with Download All Files instead.`);
      }
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true }).catch((err: unknown) => this.services.log.warn('board files: could not remove the temporary copy', err));
    }
  }

  dispose(): void { this.changed.dispose(); }
}

function isBoardNode(arg: unknown): arg is BoardNode {
  const n = arg as Partial<BoardNode> | undefined;
  return typeof n === 'object' && n !== null && typeof n.devicePath === 'string' && n.devicePath.startsWith('/') && (n.kind === 'file' || n.kind === 'dir');
}

/** Name typed by the user for a new item: one name, usable on the board and on Windows and macOS computers too. */
export function validateNewName(raw: string): string | undefined {
  const name = raw.trim();
  if (name === '') { return 'Type a name.'; }
  if (name.includes('/')) { return 'Type only a name here, without slashes. Create folders first, then files inside them.'; }
  const problem = segmentProblem(name, { windows: true });
  return problem ? describeProblem(problem, name) : undefined;
}

export function registerBoardFileCommands(services: Services, deps: BoardFileCommandDeps): vscode.Disposable[] {
  const { sync } = deps;
  const copy = deps.copy ?? new BoardCopy(services, sync);
  const { session, log } = services;
  const provider = new BoardDocumentProvider(services, sync);
  const disposables: vscode.Disposable[] = [provider, vscode.workspace.registerTextDocumentContentProvider(BOARD_SCHEME, provider)];

  const needNode = (arg: unknown, what: string): BoardNode | undefined => {
    if (isBoardNode(arg)) { return arg; }
    void vscode.window.showInformationMessage(`Right-click a file or folder in the Files view and choose "${what}".`);
    return undefined;
  };

  /** The folder a new item goes into: the clicked folder, the folder of the clicked file, or the board folder of the project. */
  const targetFolder = (arg: unknown): string => {
    if (isBoardNode(arg)) { return arg.kind === 'dir' ? arg.devicePath : nodePath.posix.dirname(arg.devicePath); }
    return services.settings.rootPath;
  };

  const localCounterpart = async (devicePath: string): Promise<{ abs: string; rel: string } | undefined> => {
    const ctx = await sync.folderContext();
    if (!ctx) { return undefined; }
    const rel = ctx.mapper.deviceToRel(devicePath);
    if (rel === undefined) { return undefined; }
    try {
      return { abs: ctx.mapper.relToLocal(rel), rel };
    } catch (err) {
      if (err instanceof PathError) { return undefined; }
      throw err;
    }
  };

  const exists = async (abs: string): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(abs));
      return true;
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') { return false; }
      throw err;
    }
  };

  const failure = async (what: string, err: unknown): Promise<void> => {
    log.error(what, err);
    const text = describeFailure(what, err).message;
    const choice = await vscode.window.showErrorMessage(text, 'Show Log');
    if (choice === 'Show Log') { log.show(); }
  };

  /**
   * New File / New Folder (D-24): created in the PROJECT folder (where it belongs in the mirror) and right away on the board, so
   * both sides start in sync and the file opens editable. Nothing that already exists is replaced on either side; a name that
   * would hide a built-in module of the board is refused before anything is made. Without a connection the item is made in the
   * project only and goes to the board later (auto-sync, or Upload).
   */
  const createInProject = async (arg: unknown, kind: 'file' | 'dir'): Promise<void> => {
    const ctx = await sync.folderContext();
    if (!ctx) { offerOpenFolder(log); return; }
    const parent = targetFolder(arg);
    const parentRel = parent === ctx.mapper.rootPath ? '' : ctx.mapper.deviceToRel(parent);
    if (parentRel === undefined) {
      void showToast(log, 'warning', `${parent} on the board is outside ${ctx.mapper.rootPath}, the folder your project mirrors, so nothing can be created there.`);
      return;
    }
    const where = parentRel === '' ? 'your project folder' : parentRel;
    const typed = await vscode.window.showInputBox({
      prompt: kind === 'file' ? `Name of the new file in ${where} (it is created in your project and on the board)` : `Name of the new folder in ${where} (it is created in your project and on the board)`,
      placeHolder: kind === 'file' ? 'for example sensor.py' : 'for example lib',
      validateInput: validateNewName,
      ignoreFocusOut: true,
    });
    if (typed === undefined) { return; }
    const name = typed.trim();
    const rel = parentRel === '' ? name : `${parentRel}/${name}`;
    let abs: string;
    try {
      abs = ctx.mapper.relToLocal(rel);
    } catch (err) {
      if (err instanceof PathError) { void showToast(log, 'warning', err.message); return; }
      throw err;
    }
    const dest = ctx.mapper.relToDevice(rel);
    if (await exists(abs)) {
      void showToast(log, 'warning', `${rel} already exists in your project. Choose a different name.`);
      if (kind === 'file') { await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false }); }
      return;
    }
    const online = session.state.state === 'idle' || session.state.state === 'rawop';
    if (online) {
      const identity = session.state.identity;
      const hidden = identity ? shadowedModule(dest, { names: identity.profileHints.modules, roots: importRootsFrom(identity.syspath) }) : undefined;
      if (hidden !== undefined) {
        void showToast(log, 'warning', `${name} cannot be used: on the board "${hidden}" is a built-in module, and a file with this name would hide it and break programs. Choose a different name (for example my_${name}).`);
        return;
      }
      const consent = sync.newConsent('Creating the item');
      try {
        const already = await callWithConsent(session, consent, 'fs.stat', { path: dest }, { timeoutMs: 15000 });
        if (already.exists) {
          void showToast(log, 'warning', `${dest} already exists on the board. Choose a different name, or right-click it in the Files view and choose Download.`);
          return;
        }
      } catch (err) {
        await failure(`Could not check ${dest} on the board`, err);
        return;
      }
    }
    // 1. the project: the file (or folder) the student works with
    try {
      if (kind === 'dir') {
        await fsp.mkdir(abs, { recursive: true });
      } else {
        await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, '', { flag: 'wx' }); // exclusive: never replaces a file that appeared meanwhile
      }
    } catch (err) {
      await failure(`Could not create ${rel} in your project`, err);
      return;
    }
    if (kind === 'file') { await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false }); }
    // 2. the board, right away, so both sides start in sync
    if (!online) {
      sync.status.set(dest, 'local-only', { rel, size: 0 });
      void showToast(log, 'info', `Created ${rel} in your project. It goes to the board when the board is connected.`);
      return;
    }
    try {
      if (kind === 'dir') {
        await callWithConsent(session, sync.newConsent('Creating the folder'), 'fs.mkdir', { path: dest, parents: true }, { timeoutMs: 15000 });
        sync.boardChanged([dest]);
      } else {
        await sync.sendNewFile(abs, rel);
      }
    } catch (err) {
      await failure(`Created ${rel} in your project, but could not create it on the board`, err);
      return;
    }
    vscode.window.setStatusBarMessage(`Created ${rel} in your project and on the board`, 3000);
  };

  const rename = async (arg: unknown): Promise<void> => {
    const node = needNode(arg, 'Rename on Board...');
    if (!node || !(await sync.ensureConnected())) { return; }
    const typed = await vscode.window.showInputBox({
      prompt: `New name for ${node.name} on the board`, value: node.name, validateInput: validateNewName, ignoreFocusOut: true,
    });
    if (typed === undefined || typed.trim() === node.name) { return; }
    const dst = nodePath.posix.join(nodePath.posix.dirname(node.devicePath), typed.trim());
    const consent = sync.newConsent('Renaming');
    try {
      await callWithConsent(session, consent, 'fs.mv', { src: node.devicePath, dst }, { timeoutMs: 30000 });
    } catch (err) {
      await failure(`Could not rename ${node.name}`, err);
      return;
    }
    const ctx = await sync.folderContext();
    const from = await localCounterpart(node.devicePath);
    const to = await localCounterpart(dst);
    const board = await sync.boardKey({ passive: true });
    if (ctx && board && from && to) {
      await ctx.store.rename(board, from.rel, to.rel).catch((err: unknown) => log.warn('board files: could not update the sync history after a rename', err));
    }
    sync.boardChanged([node.devicePath, dst]);
    const alsoLocal = 'Rename my copy too';
    const offer = from && to && (await exists(from.abs)) && !(await exists(to.abs));
    const choice = await showToast(
      log,
      'info',
      `Renamed ${node.name} to ${typed.trim()} on the board.${offer ? ' Your copy on this computer still has the old name; the next upload would put the old name back on the board.' : ''}`,
      ...(offer ? [alsoLocal] : []),
    );
    if (choice === alsoLocal && from && to) {
      await vscode.workspace.fs.rename(vscode.Uri.file(from.abs), vscode.Uri.file(to.abs), { overwrite: false });
    }
  };

  /** Delete on the board; returns true when the item is gone (false when the user kept a storage device or it failed). */
  const removeFromBoard = async (node: BoardNode, consent: Consent): Promise<boolean> => {
    try {
      if (node.kind === 'dir') {
        const r = await rmtreeWithConsent(session, consent, node.devicePath, { timeoutMs: 120000 });
        if (r.result === 'skipped-mount') { return false; }
      } else {
        await callWithConsent(session, consent, 'fs.rm', { path: node.devicePath }, { timeoutMs: 30000 });
      }
    } catch (err) {
      await failure(`Could not delete ${node.devicePath} from the board`, err);
      return false;
    }
    const ctx = await sync.folderContext();
    const board = await sync.boardKey({ passive: true });
    const rel = ctx?.mapper.deviceToRel(node.devicePath);
    if (ctx && board && rel !== undefined) {
      await ctx.store.forgetUnder(board, rel).catch((err: unknown) => log.warn('board files: could not update the sync history after a delete', err));
    }
    sync.status.set(node.devicePath, undefined);
    sync.boardChanged([node.devicePath]);
    return true;
  };

  const del = async (arg: unknown, alsoLocal: boolean): Promise<void> => {
    const node = needNode(arg, alsoLocal ? 'Delete from Board and Local' : 'Delete from Board');
    if (!node || !(await sync.ensureConnected())) { return; }
    const counterpart = alsoLocal ? await localCounterpart(node.devicePath) : undefined;
    const localThere = counterpart ? await exists(counterpart.abs) : false;
    const lines = [node.kind === 'dir' ? 'The folder and everything inside it will be deleted from the board. This cannot be undone.' : 'The file will be deleted from the board. This cannot be undone.'];
    if (alsoLocal) {
      lines.push(localThere && counterpart ? `Your copy on this computer, ${counterpart.rel}, will be moved to the Trash.` : 'There is no matching file in your project folder, so only the board is changed.');
    } else {
      lines.push('Your copy on this computer is not touched.');
    }
    const button = alsoLocal ? 'Delete from board and computer' : 'Delete from board';
    const choice = await vscode.window.showWarningMessage(`Delete ${node.name} from the board?`, { modal: true, detail: `${node.devicePath}\n\n${lines.join('\n')}` }, button);
    if (choice !== button) { return; }
    const consent = sync.newConsent('Deleting');
    if (!(await removeFromBoard(node, consent))) { return; }
    let note = `Deleted ${node.name} from the board.`;
    if (alsoLocal && localThere && counterpart) {
      const abs = counterpart.abs;
      if (sync.engine.isDirty(abs)) {
        note += ` Your copy was not deleted because it has unsaved changes in the editor.`;
      } else {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(abs), { recursive: true, useTrash: true });
          note += ' Your copy on this computer was moved to the Trash.';
        } catch (err) {
          log.error('board files: could not delete the local copy', err);
          note += ` The board copy is gone, but your copy on this computer could not be deleted (${err instanceof Error ? err.message : String(err)}).`;
        }
      }
    } else if (!alsoLocal) {
      note += ' Your copy on this computer was not touched; the next upload would copy it back.';
    }
    void vscode.window.showInformationMessage(note);
  };

  /** The board's own version in a read-only tab, exactly as the board has it now. */
  const openBoardDocument = async (node: BoardNode): Promise<boolean> => {
    if (!(await sync.ensureConnected())) { return false; }
    const uri = boardDocumentUri(node.devicePath);
    provider.invalidate(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
    return true;
  };

  /** A click in the Files view: the project's file when there is one, else the board's copy plus the offer to copy it. */
  const open = async (arg: unknown): Promise<void> => {
    const node = needNode(arg, 'Open File from Board');
    if (!node) { return; }
    if (node.kind === 'dir') { return; }
    const where = await sync.localCounterpart(node.devicePath);
    if (where.kind === 'file') {
      await vscode.window.showTextDocument(vscode.Uri.file(where.abs), { preview: true });
      return;
    }
    if (!(await openBoardDocument(node))) { return; }
    if (where.kind === 'missing') {
      // A toast with a button: started, never awaited here (the command and the guard must finish while it stays on screen).
      copy.offer(node.devicePath, COPY_BUTTON, async (local) => { await vscode.window.showTextDocument(vscode.Uri.file(local), { preview: true }); });
    } else if (where.kind === 'no-folder') {
      void showToast(log, 'info', `${NO_FOLDER_TEXT} Until then the board's copy of ${node.name} opens here to read.`);
    } else {
      void showToast(log, 'info', `${node.name} has no place in your project folder. ${where.why} It opens here to read.`);
    }
  };

  /** The old click: always the board's version, read-only. */
  const openBoardCopy = async (arg: unknown): Promise<void> => {
    const node = needNode(arg, "Open the Board's Copy (Read-Only)");
    if (!node || node.kind === 'dir') { return; }
    await openBoardDocument(node);
  };

  const reg = (id: string, what: string, run: (arg: unknown) => Promise<unknown>): vscode.Disposable =>
    vscode.commands.registerCommand(id, (arg?: unknown) => sync.guarded(what, () => run(arg)));
  disposables.push(
    reg(COMMAND_IDS.openFileFromBoard, 'Opening the file from the board', open),
    reg(COMMAND_IDS.openBoardCopy, "Opening the board's copy of the file", openBoardCopy),
    reg(COMMAND_IDS.newFileOnBoard, 'Creating the file', (a) => createInProject(a, 'file')),
    reg(COMMAND_IDS.newFolderOnBoard, 'Creating the folder', (a) => createInProject(a, 'dir')),
    reg(COMMAND_IDS.renameOnBoard, 'Renaming on the board', rename),
    reg(COMMAND_IDS.deleteOnBoard, 'Deleting from the board', (a) => del(a, false)),
    reg(COMMAND_IDS.deleteOnBoardAndLocal, 'Deleting from the board and the computer', (a) => del(a, true)),
  );
  return disposables;
}
