/**
 * Atomic file writes for everything the sync code writes on the host (baseline, ignore file, backups index):
 * temp file in the SAME folder, then rename, retried on EBUSY/EPERM/EACCES because cloud clients (OneDrive, Dropbox),
 * antivirus and indexers briefly lock files on Windows (CLAUDE.md rule 7, RQ-CLOUD-5). Pure Node, no `vscode`.
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';

/** The few filesystem calls used, injectable so tests can fail them on purpose (for example with EBUSY). */
export interface AtomicIo {
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, data: string | Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export const nodeAtomicIo: AtomicIo = {
  mkdir: async (dir) => { await fsp.mkdir(dir, { recursive: true }); },
  writeFile: (file, data) => fsp.writeFile(file, data),
  rename: (from, to) => fsp.rename(from, to),
  rm: (file) => fsp.rm(file, { force: true }),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);

/** True for errors that usually clear up after a short wait. */
export function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

export interface AtomicOptions {
  /** Retries after the first attempt (default 5, as RQ-CLOUD-5). */
  retries?: number;
  /** Wait before retry n (default 50, 80, 120, 160, 200 ms). */
  delayMs?: (attempt: number) => number;
  io?: AtomicIo;
}

async function withRetries<T>(work: () => Promise<T>, io: AtomicIo, retries: number, delayMs: (attempt: number) => number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (attempt >= retries || !isTransientFsError(err)) {
        throw err;
      }
      await io.sleep(delayMs(attempt));
    }
  }
}

/**
 * Write `data` to `target` so that a reader sees either the old file or the complete new one, never a partial file.
 * Creates the folder when needed. The temp file is removed when the write or the rename finally fails.
 */
export async function writeFileAtomic(target: string, data: string | Uint8Array, options: AtomicOptions = {}): Promise<void> {
  const io = options.io ?? nodeAtomicIo;
  const retries = options.retries ?? 5;
  const delayMs = options.delayMs ?? ((attempt: number) => 50 + 30 * attempt);
  const dir = nodePath.dirname(target);
  const tmp = nodePath.join(dir, `.${nodePath.basename(target)}.${randomBytes(4).toString('hex')}.tmp`);
  await withRetries(() => io.mkdir(dir), io, retries, delayMs);
  try {
    await withRetries(() => io.writeFile(tmp, data), io, retries, delayMs);
    await withRetries(() => io.rename(tmp, target), io, retries, delayMs);
  } catch (err) {
    await io.rm(tmp).catch(() => undefined); // best effort: the original error is what matters
    throw err;
  }
}
