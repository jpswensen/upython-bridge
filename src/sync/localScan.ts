/**
 * Reads the workspace folder for sync: which files exist, how big they are and their sha256, honouring the ignore rules.
 * Pure Node (no `vscode`). Bounded on purpose (RQ-CLOUD-6): ignored folders are never entered, a file that does not open
 * within the timeout (an online-only OneDrive placeholder) is reported instead of hanging the sync, and the file count is capped.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import type { IgnoreMatcher } from './ignore';

export interface LocalFile {
  /** Workspace-relative POSIX path. */
  path: string;
  abs: string;
  size: number;
  sha256: string;
}

export interface ScanResult {
  files: LocalFile[];
  /** Non-ignored folders (workspace-relative POSIX), including empty ones. */
  dirs: string[];
  warnings: string[];
  ignoredCount: number;
  truncated: boolean;
}

export interface ScanOptions {
  /** Stop after this many files (default 5000). */
  maxFiles?: number;
  /** Give up on one file after this long (default 15 s). */
  readTimeoutMs?: number;
  signal?: AbortSignal;
  concurrency?: number;
}

export class ReadTimeoutError extends Error {
  constructor(readonly file: string) {
    super(`Reading ${nodePath.basename(file)} took too long.`);
    this.name = 'ReadTimeoutError';
  }
}

/** Stream a file through sha256. Rejects with ReadTimeoutError when no data arrives in time and with the fs error otherwise. */
export function sha256File(abs: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ sha256: string; size: number }> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream(abs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (timer) {
        clearTimeout(timer);
      }
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const arm = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => { stream.destroy(); finish(() => reject(new ReadTimeoutError(abs))); }, timeoutMs);
    };
    const onAbort = (): void => { stream.destroy(); finish(() => reject(new Error('The scan was cancelled.'))); };
    if (opts.signal?.aborted) {
      stream.destroy();
      reject(new Error('The scan was cancelled.'));
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    arm();
    stream.on('data', (chunk) => { const b = chunk as Buffer; hash.update(b); size += b.length; arm(); });
    stream.once('end', () => finish(() => resolve({ sha256: hash.digest('hex'), size })));
    stream.once('error', (err) => finish(() => reject(err)));
  });
}

/** English warning for a file that could not be read, with the usual cause for cloud folders. */
export function describeReadFailure(rel: string, err: unknown): string {
  if (err instanceof ReadTimeoutError) {
    return `${rel} did not open in time. If it is stored in OneDrive, iCloud or Dropbox, mark it "Always keep on this device" and try again. It was skipped.`;
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return `${rel} is locked by another program (a cloud-sync client or antivirus?), so it was skipped. Try again in a moment.`;
  }
  return `${rel} could not be read (${err instanceof Error ? err.message : String(err)}), so it was skipped.`;
}

export async function scanLocal(root: string, matcher: IgnoreMatcher, opts: ScanOptions = {}): Promise<ScanResult> {
  const maxFiles = opts.maxFiles ?? 5000;
  const result: ScanResult = { files: [], dirs: [], warnings: [], ignoredCount: 0, truncated: false };
  const pending: { rel: string; abs: string }[] = [];

  const walk = async (relDir: string): Promise<void> => {
    const absDir = relDir === '' ? root : nodePath.join(root, ...relDir.split('/'));
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      result.warnings.push(`The folder ${relDir === '' ? 'of your project' : relDir} could not be read (${(err as Error).message}), so it was skipped.`);
      return;
    }
    if (relDir !== '' && entries.some((e) => e.name === 'pyvenv.cfg')) {
      result.warnings.push(`${relDir}/ looks like a Python environment (it contains pyvenv.cfg), so it was skipped.`);
      result.ignoredCount++;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (opts.signal?.aborted) {
        throw new Error('The scan was cancelled.');
      }
      const rel = relDir === '' ? e.name : `${relDir}/${e.name}`;
      if (e.isSymbolicLink()) {
        result.warnings.push(`${rel} is a shortcut (symbolic link), so it was skipped.`);
        continue;
      }
      if (e.isDirectory()) {
        if (matcher.ignores(rel, true)) {
          result.ignoredCount++;
          continue;
        }
        result.dirs.push(rel);
        await walk(rel);
      } else if (e.isFile()) {
        if (matcher.ignores(rel, false)) {
          result.ignoredCount++;
          continue;
        }
        if (pending.length >= maxFiles) {
          result.truncated = true;
          continue;
        }
        pending.push({ rel, abs: nodePath.join(absDir, e.name) });
      }
    }
  };

  await walk('');
  if (result.truncated) {
    result.warnings.push(`Your project has more than ${maxFiles} files. Only the first ${maxFiles} are included; add large folders to your ignore file to skip them.`);
  }

  const queue = [...pending];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        const { sha256, size } = await sha256File(item.abs, { timeoutMs: opts.readTimeoutMs, signal: opts.signal });
        result.files.push({ path: item.rel, abs: item.abs, size, sha256 });
      } catch (err) {
        if (opts.signal?.aborted) {
          throw err;
        }
        result.warnings.push(describeReadFailure(item.rel, err));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, () => worker()));
  result.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}
