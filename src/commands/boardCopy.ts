/**
 * "Copy it to my project": the one place that turns a board-only file into a file of the project. Used by the Files-view click
 * (open) and by Run (a board document is not runnable, its project file is).
 *
 * The students' model is "the file in the Files view IS my file": a click opens the project's file, Run runs it, saving syncs it.
 * A file that exists only on the board has no project file yet, so the board's copy opens read-only and this module offers, in a
 * toast that never holds up the command that showed it, to create the project file from it.
 *
 * Safety: the download goes to a scratch folder first, nothing in the project is created before it succeeded, and the project file
 * is created with an exclusive create (`wx`), so a file that appeared in the meantime is never overwritten.
 */
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { callWithConsent } from '../sync/boardAccess';
import { transferTimeoutMs } from '../sync/engine';
import type { SyncService } from '../sync/service';
import { showToast } from '../toast';
import type { Services } from '../types/services';

export const COPY_BUTTON = 'Copy it to my project';
export const COPY_AND_RUN_BUTTON = 'Copy it to my project and run it';
export const NO_FOLDER_TEXT = 'Open your project folder first (File > Open Folder), then try again.';

export const onlyOnBoardText = (name: string): string => `${name} is only on the board, not in your project folder.`;
const alreadyThereText = (rel: string): string =>
  `${rel} is in your project folder already, so nothing was copied and your file was not changed. Open that file from the Files view or the Explorer.`;
const blockedText = (rel: string): string =>
  `${rel} could not be copied because a file or folder in your project has the same name as one of its folders. Rename or move it, then try again.`;

/** What the other commands need from the copy flow (Run gets it through its dependencies, so tests can pass a small double). */
export interface BoardCopyPort {
  /** Start the "only on the board" toast with `button`; returns at once. After a copy, `then` gets the new project file. */
  offer(devicePath: string, button: string, then?: (localFile: string) => Promise<void>): void;
}

export class BoardCopy implements BoardCopyPort {
  constructor(private readonly services: Services, private readonly sync: SyncService) {}

  /**
   * Show the offer and return at once. The toast has a button, so nobody may await it inside a command or a lock: the answer is
   * handled in the background, and everything that goes wrong reaches the student and the log.
   */
  offer(devicePath: string, button: string, then?: (localFile: string) => Promise<void>): void {
    const { log } = this.services;
    const name = nodePath.posix.basename(devicePath);
    showToast(log, 'info', onlyOnBoardText(name), button)
      .then(async (choice) => {
        if (choice !== button) { return; }
        const copied = await this.sync.guarded(`Copying ${name} to your project`, () => this.copy(devicePath));
        if (copied !== undefined && then !== undefined) { await then(copied); }
      })
      .catch((err: unknown) => { log.error(`board files: the answer to the offer for ${devicePath} failed`, err); });
  }

  /**
   * Download the board file into the project. Returns the absolute path of the new project file, or undefined when nothing was
   * copied (the student has been told why). Throws for failures; `sync.guarded` turns those into one message.
   */
  async copy(devicePath: string): Promise<string | undefined> {
    const { session, log } = this.services;
    const name = nodePath.posix.basename(devicePath);
    const where = await this.sync.localCounterpart(devicePath);
    if (where.kind === 'no-folder') {
      this.say('info', NO_FOLDER_TEXT);
      return undefined;
    }
    if (where.kind === 'unmapped') {
      this.say('warning', `${name} cannot be copied into your project. ${where.why}`);
      return undefined;
    }
    if (where.kind === 'file') {
      this.say('info', alreadyThereText(where.rel));
      return undefined;
    }
    // Before the slow download: a folder where the file should be, or a file where one of its folders should be.
    const inTheWay = await this.placementProblem(where.rel, where.abs, name);
    if (inTheWay !== undefined) {
      this.say('warning', inTheWay);
      return undefined;
    }
    if (!(await this.sync.ensureConnected())) { return undefined; }

    const consent = this.sync.newConsent('Copying the file');
    const scratch = nodePath.join(this.sync.storageDir(), 'board-files', `copy-${process.pid}-${Date.now()}`);
    const tmp = nodePath.join(scratch, 'file');
    let got: { bytes: number; sha256: string };
    try {
      const st = await callWithConsent(session, consent, 'fs.stat', { path: devicePath }, { timeoutMs: 15000 });
      if (!st.exists) { throw new Error(`${devicePath} does not exist on the board any more. Refresh the Files view.`); }
      got = await callWithConsent(session, consent, 'fs.get', { remote: devicePath, local: tmp }, { timeoutMs: transferTimeoutMs(st.size ?? 0) });
      // Only now, with the whole file in hand, does anything in the project change.
      const placed = await this.createNew(where.abs, await fsp.readFile(tmp));
      if (placed !== 'created') {
        // Something appeared (or was in the way) after the check above: say what it is, never overwrite it.
        const why = await this.placementProblem(where.rel, where.abs, name);
        this.say(placed === 'exists' && why === undefined ? 'info' : 'warning', why ?? (placed === 'exists' ? alreadyThereText(where.rel) : blockedText(where.rel)));
        return undefined;
      }
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true }).catch((err: unknown) => log.warn('board files: could not remove the temporary copy', err));
    }

    this.sync.status.set(devicePath, 'in-sync');
    await this.rememberInSync(where.rel, got);
    log.info(`board files: copied ${devicePath} to ${where.abs}`);
    this.say('info', `Copied ${name} to your project (${where.rel}).`);
    return where.abs;
  }

  /**
   * Create `abs` with `bytes` unless something is there already ('exists'), or something with the name of one of its folders is
   * ('blocked'). A failed write leaves no partial file behind.
   */
  private async createNew(abs: string, bytes: Uint8Array): Promise<'created' | 'exists' | 'blocked'> {
    try {
      await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTDIR') { return 'blocked'; }
      throw err;
    }
    let handle: Awaited<ReturnType<typeof fsp.open>>;
    try {
      handle = await fsp.open(abs, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') { return 'exists'; }
      if (code === 'ENOTDIR') { return 'blocked'; }
      throw err;
    }
    try {
      await handle.writeFile(bytes);
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => undefined); // the write error is the one that matters
      await fsp.rm(abs, { force: true }).catch((rmErr: unknown) => this.services.log.warn('board files: could not remove a half-written copy', rmErr));
      throw err;
    }
    return 'created';
  }

  /**
   * What stands in the way of creating the project file `rel` other than a plain file: a FILE where one of its folders should be,
   * or a FOLDER where the file should be. A sentence for the student, or undefined when the way is free (or the plain file is
   * there, which `alreadyThereText` covers).
   */
  private async placementProblem(rel: string, abs: string, name: string): Promise<string | undefined> {
    const parts = rel.split('/');
    const chain: { rel: string; abs: string }[] = [];
    let current = abs;
    for (let k = parts.length; k >= 1; k--) {
      chain.unshift({ rel: parts.slice(0, k).join('/'), abs: current });
      current = nodePath.dirname(current);
    }
    for (const [i, part] of chain.entries()) {
      let isDir: boolean;
      try {
        isDir = (await fsp.lstat(part.abs)).isDirectory();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') { return undefined; } // nothing from here down exists: the way is free
        throw err;
      }
      if (i < chain.length - 1 && !isDir) {
        return `${part.rel} is a file in your project, but ${name} needs ${part.rel} to be a folder. Rename or move ${part.rel}, then try again.`;
      }
      if (i === chain.length - 1 && isDir) {
        return `${part.rel} is a folder in your project, but the board has a file with that name. Rename or move the folder, then try again.`;
      }
    }
    return undefined;
  }

  /** The file is now identical on both sides: that is what a baseline entry means, so a later edit is a plain "local changed". */
  private async rememberInSync(rel: string, got: { bytes: number; sha256: string }): Promise<void> {
    try {
      const ctx = await this.sync.folderContext();
      const board = await this.sync.boardKey({ passive: true });
      if (ctx && board && !ctx.matcher.ignores(rel)) {
        await ctx.store.record(board, [{ path: rel, sha256: got.sha256, size: got.bytes }]);
      }
    } catch (err) {
      this.services.log.warn('board files: could not note the new copy in the sync history', err);
    }
  }

  private say(level: 'info' | 'warning', text: string): void {
    this.services.log.info(text);
    void showToast(this.services.log, level, text);
  }
}
