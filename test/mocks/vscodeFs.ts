/**
 * `workspace.fs` stand-ins. DiskFileSystem works on real files (use temp folders from fixtures.ts); MemoryFileSystem keeps
 * everything in a Map so Windows-shaped URIs (`Uri.file('C:\\...')`) can be used without touching a disk.
 * Both follow the real API: writeFile creates parent folders, createDirectory has mkdir -p semantics, errors are FileSystemError.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileSystemError, FileType, Uri } from './vscodeCore';

export interface FileStat { type: FileType; ctime: number; mtime: number; size: number }

export interface MockFileSystem {
  stat(uri: Uri): Promise<FileStat>;
  readDirectory(uri: Uri): Promise<[string, FileType][]>;
  readFile(uri: Uri): Promise<Uint8Array>;
  writeFile(uri: Uri, content: Uint8Array): Promise<void>;
  delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void>;
  createDirectory(uri: Uri): Promise<void>;
  rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void>;
  copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void>;
  isWritableFileSystem(scheme: string): boolean | undefined;
}

function mapError(err: unknown, uri: Uri): never {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT': throw FileSystemError.FileNotFound(uri);
    case 'EEXIST': throw FileSystemError.FileExists(uri);
    case 'ENOTDIR': throw FileSystemError.FileNotADirectory(uri);
    case 'EISDIR': throw FileSystemError.FileIsADirectory(uri);
    case 'EACCES':
    case 'EPERM': throw FileSystemError.NoPermissions(uri);
    default: throw err;
  }
}

function typeOf(s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType {
  return s.isSymbolicLink() ? FileType.SymbolicLink : s.isDirectory() ? FileType.Directory : s.isFile() ? FileType.File : FileType.Unknown;
}

export class DiskFileSystem implements MockFileSystem {
  async stat(uri: Uri): Promise<FileStat> {
    try {
      const s = await fs.lstat(uri.fsPath);
      return { type: typeOf(s), ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
    } catch (e) { return mapError(e, uri); }
  }

  async readDirectory(uri: Uri): Promise<[string, FileType][]> {
    try {
      const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((d): [string, FileType] => [d.name, typeOf(d)]);
    } catch (e) { return mapError(e, uri); }
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    try { return new Uint8Array(await fs.readFile(uri.fsPath)); } catch (e) { return mapError(e, uri); }
  }

  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    try {
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, content);
    } catch (e) { mapError(e, uri); }
  }

  async delete(uri: Uri, options?: { recursive?: boolean }): Promise<void> {
    try {
      const s = await fs.lstat(uri.fsPath);
      if (s.isDirectory() && !options?.recursive) {
        const inside = await fs.readdir(uri.fsPath);
        if (inside.length > 0) { throw Object.assign(new Error('not empty'), { code: 'EPERM' }); }
      }
      await fs.rm(uri.fsPath, { recursive: true, force: false });
    } catch (e) { mapError(e, uri); }
  }

  async createDirectory(uri: Uri): Promise<void> {
    try { await fs.mkdir(uri.fsPath, { recursive: true }); } catch (e) { mapError(e, uri); }
  }

  async rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
    try {
      if (!options?.overwrite && (await fs.lstat(target.fsPath).then(() => true, () => false))) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
      await fs.rename(source.fsPath, target.fsPath);
    } catch (e) { mapError(e, source); }
  }

  async copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
    try {
      if (!options?.overwrite && (await fs.lstat(target.fsPath).then(() => true, () => false))) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
      await fs.cp(source.fsPath, target.fsPath, { recursive: true });
    } catch (e) { mapError(e, source); }
  }

  isWritableFileSystem(): boolean { return true; }
}

interface MemNode { type: FileType; data: Uint8Array; ctime: number; mtime: number }

export class MemoryFileSystem implements MockFileSystem {
  private readonly nodes = new Map<string, MemNode>();
  private clock = 1;

  private key(uri: Uri): string {
    const p = path.posix.normalize(uri.path || '/');
    return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  }

  private tick(): number {
    return this.clock++;
  }

  /** Test helper: create files (and parent folders) from a { path: text | bytes } map of URI paths or fsPaths. */
  seed(files: Record<string, string | Uint8Array>): void {
    for (const [name, content] of Object.entries(files)) {
      const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      this.putSync(Uri.file(name), data);
    }
  }

  /** Test helper: all file URIs path keys, sorted. */
  list(): string[] {
    return [...this.nodes.entries()].filter(([, n]) => n.type === FileType.File).map(([k]) => k).sort();
  }

  private mkdirp(dir: string): void {
    let cur = '';
    for (const part of dir.split('/').filter(Boolean)) {
      cur += `/${part}`;
      const n = this.nodes.get(cur);
      if (n && n.type !== FileType.Directory) { throw FileSystemError.FileNotADirectory(cur); }
      if (!n) { const t = this.tick(); this.nodes.set(cur, { type: FileType.Directory, data: new Uint8Array(), ctime: t, mtime: t }); }
    }
  }

  private putSync(uri: Uri, data: Uint8Array): void {
    const k = this.key(uri);
    this.mkdirp(path.posix.dirname(k));
    if (this.nodes.get(k)?.type === FileType.Directory) { throw FileSystemError.FileIsADirectory(uri); }
    const t = this.tick();
    this.nodes.set(k, { type: FileType.File, data, ctime: this.nodes.get(k)?.ctime ?? t, mtime: t });
  }

  async stat(uri: Uri): Promise<FileStat> {
    const k = this.key(uri);
    const n = this.nodes.get(k) ?? (k === '/' ? { type: FileType.Directory, data: new Uint8Array(), ctime: 0, mtime: 0 } : undefined);
    if (!n) { throw FileSystemError.FileNotFound(uri); }
    return { type: n.type, ctime: n.ctime, mtime: n.mtime, size: n.data.length };
  }

  async readDirectory(uri: Uri): Promise<[string, FileType][]> {
    const k = this.key(uri);
    if (k !== '/' && this.nodes.get(k)?.type !== FileType.Directory) {
      throw this.nodes.has(k) ? FileSystemError.FileNotADirectory(uri) : FileSystemError.FileNotFound(uri);
    }
    const prefix = k === '/' ? '/' : `${k}/`;
    return [...this.nodes.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && p !== k)
      .map(([p, n]): [string, FileType] => [p.slice(prefix.length), n.type]);
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    const n = this.nodes.get(this.key(uri));
    if (!n) { throw FileSystemError.FileNotFound(uri); }
    if (n.type === FileType.Directory) { throw FileSystemError.FileIsADirectory(uri); }
    return n.data.slice();
  }

  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    this.putSync(uri, content.slice());
  }

  async delete(uri: Uri, options?: { recursive?: boolean }): Promise<void> {
    const k = this.key(uri);
    const n = this.nodes.get(k);
    if (!n) { throw FileSystemError.FileNotFound(uri); }
    const kids = [...this.nodes.keys()].filter((p) => p.startsWith(`${k}/`));
    if (n.type === FileType.Directory && kids.length > 0 && !options?.recursive) { throw FileSystemError.NoPermissions(uri); }
    for (const p of [k, ...kids]) { this.nodes.delete(p); }
  }

  async createDirectory(uri: Uri): Promise<void> {
    this.mkdirp(this.key(uri));
  }

  async rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
    const from = this.key(source);
    const to = this.key(target);
    if (!this.nodes.has(from)) { throw FileSystemError.FileNotFound(source); }
    if (this.nodes.has(to) && !options?.overwrite) { throw FileSystemError.FileExists(target); }
    this.mkdirp(path.posix.dirname(to));
    for (const p of [...this.nodes.keys()].filter((q) => q === from || q.startsWith(`${from}/`))) {
      const node = this.nodes.get(p);
      if (node) { this.nodes.set(to + p.slice(from.length), node); this.nodes.delete(p); }
    }
  }

  async copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
    const from = this.key(source);
    const to = this.key(target);
    if (!this.nodes.has(from)) { throw FileSystemError.FileNotFound(source); }
    if (this.nodes.has(to) && !options?.overwrite) { throw FileSystemError.FileExists(target); }
    this.mkdirp(path.posix.dirname(to));
    for (const p of [...this.nodes.keys()].filter((q) => q === from || q.startsWith(`${from}/`))) {
      const node = this.nodes.get(p);
      if (node) { this.nodes.set(to + p.slice(from.length), { ...node, data: node.data.slice() }); }
    }
  }

  isWritableFileSystem(): boolean { return true; }
}
