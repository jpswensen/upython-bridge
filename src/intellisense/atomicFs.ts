/**
 * Atomic file writes for the IntelliSense files (RQ-CLOUD-5, P.4 rule 6): temp file next to the target (suffix `.tmp`, which
 * OneDrive does not sync), then rename; 5 retries of 50 to 200 ms on EBUSY/EPERM/EACCES (cloud clients, antivirus and indexers
 * briefly lock files on Windows); and the write is skipped when the bytes are already there (a language server reloads on any
 * change event, so a rewrite with identical bytes would still cost a reload).
 */
import { randomBytes } from 'node:crypto';
import type { Clock, FsLike } from './types';
import { errCode, errMessage, sha256Hex } from './util';

const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);

export interface AtomicOptions {
  retries?: number;
  delayMs?: (attempt: number) => number;
}

export async function withRetries<T>(clock: Clock, options: AtomicOptions, work: () => Promise<T>): Promise<T> {
  const retries = options.retries ?? 5;
  const delay = options.delayMs ?? ((n: number) => 50 + 30 * n);
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      const code = errCode(err);
      if (attempt >= retries || code === undefined || !TRANSIENT.has(code)) { throw err; }
      await clock.sleep(delay(attempt));
    }
  }
}

export interface AtomicResult { written: boolean }

/** A unique temp name per write (two windows can run a Fix at the same time); still ends in `.tmp`, which OneDrive does not sync. */
function tempName(target: string): string {
  return `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/**
 * Where a write must land: a link is followed (the link stays a link); a link that points nowhere is refused, not replaced.
 * Only files that belong to the user are written this way (settings.json). The managed area is screened by applyPlan beforehand:
 * below the workspace folder nothing is written through a link (links.ts).
 */
async function writeTarget(fs: FsLike, target: string): Promise<string> {
  const st = fs.lstat === undefined ? null : await fs.lstat(target);
  if (st === null || !st.isSymlink) { return target; }
  try {
    return fs.realpath === undefined ? target : await fs.realpath(target);
  } catch {
    throw new Error(`${target} is a link that points nowhere, so it was not replaced. Fix or remove the link first.`);
  }
}

/** Write `data` to `target` (creating folders) unless it already holds exactly these bytes. */
export async function writeIfChanged(fs: FsLike, clock: Clock, requested: string, data: string | Uint8Array, options: AtomicOptions = {}): Promise<AtomicResult> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const target = await writeTarget(fs, requested);
  try {
    const current = await withRetries(clock, options, () => fs.readFile(target));
    if (sha256Hex(current) === sha256Hex(bytes)) { return { written: false }; }
  } catch (err) {
    const code = errCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') { throw Object.assign(new Error(`Cannot read ${target} to compare it: ${errMessage(err)}`), code === undefined ? {} : { code }); }
  }
  const tmp = tempName(target);
  await withRetries(clock, options, () => fs.mkdir(fs.path.dirname(target)));
  try {
    await withRetries(clock, options, () => fs.writeFile(tmp, bytes));
    await withRetries(clock, options, () => fs.rename(tmp, target));
  } catch (err) {
    await fs.rm(tmp).catch(() => undefined); // best effort: the original error is what matters
    throw err;
  }
  return { written: true };
}

/** Remove a file or folder, retrying on transient locks. A missing path is fine. */
export async function removeWithRetries(fs: FsLike, clock: Clock, target: string, recursive = false, options: AtomicOptions = {}): Promise<void> {
  await withRetries(clock, options, () => fs.rm(target, { recursive }));
}

/**
 * Create a file that belongs to the user, once: the create itself is exclusive (O_EXCL), so a file the user saves between our
 * check and our write is never replaced. Returns false when something is already there (a file or a link, even a dangling one).
 */
export async function createIfAbsent(fs: FsLike, clock: Clock, target: string, data: string | Uint8Array, options: AtomicOptions = {}): Promise<boolean> {
  const create = fs.createExclusive?.bind(fs);
  if (create === undefined) { // a file system without exclusive create: check, then the atomic write
    if ((await fs.stat(target)) !== null) { return false; }
    return (await writeIfChanged(fs, clock, target, data, options)).written;
  }
  await withRetries(clock, options, () => fs.mkdir(fs.path.dirname(target)));
  try {
    await withRetries(clock, options, () => create(target, data));
    return true;
  } catch (err) {
    if (errCode(err) === 'EEXIST') { return false; }
    throw err;
  }
}
