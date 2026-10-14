/** Small pure helpers shared by the IntelliSense modules. */
import { createHash } from 'node:crypto';
import type { DirEntry, FsLike, PathApi } from './types';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Generated config must read the same on every OS: forward slashes only. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function errCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** UTF-8 text without a byte order mark (Windows editors add one). */
export function decodeText(data: Uint8Array): string {
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Text of a file, or null when it does not exist. Other errors propagate. */
export async function readTextIfExists(fs: FsLike, file: string): Promise<string | null> {
  try {
    return decodeText(await fs.readFile(file));
  } catch (err) {
    if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') { return null; }
    throw err;
  }
}

export async function exists(fs: FsLike, target: string): Promise<boolean> {
  return (await fs.stat(target)) !== null;
}

export async function isDir(fs: FsLike, target: string): Promise<boolean> {
  return (await fs.stat(target))?.isDirectory === true;
}

export async function isFile(fs: FsLike, target: string): Promise<boolean> {
  return (await fs.stat(target))?.isFile === true;
}

/**
 * Directory listing that treats a folder that is missing or not readable (EPERM/EACCES: protected system folders on the way up
 * from a workspace, cloud placeholders) as empty. A scan must not fail because one neighbour is off limits.
 */
export async function readdirSafe(fs: FsLike, dir: string): Promise<DirEntry[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EPERM' || code === 'EACCES') { return []; }
    throw err;
  }
}

/**
 * `to` relative to `from`, with forward slashes. Null when no relative form exists (another drive on Windows):
 * the generated config never contains absolute paths (P.4 rule 3).
 */
export function relPosix(path: PathApi, from: string, to: string): string | null {
  const rel = path.relative(from, to);
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\\\')) { return null; }
  return toPosix(rel === '' ? '.' : rel);
}

/** True when `child` is `parent` or lies below it. */
export function isInside(path: PathApi, parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') { return true; }
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) { return false; }
  const first = rel.split(/[\\/]/)[0];
  return first !== '..';
}

/** Path of `abs` below `workspace`, POSIX; null when outside. */
export function workspaceRel(path: PathApi, workspace: string, abs: string): string | null {
  if (!isInside(path, workspace, abs)) { return null; }
  return relPosix(path, workspace, abs);
}

export function uniq<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) { if (text.charCodeAt(i) === 10) { line++; } }
  return line;
}
