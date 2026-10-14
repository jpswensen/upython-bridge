/**
 * In-memory FsLike for the IntelliSense tests, with POSIX or Windows path semantics (so Windows is tested by injection, on any host),
 * recorded operations and injectable failures (EBUSY on rename, ...). Also: helpers to copy a real fixture folder into it.
 */
import fs from 'node:fs';
import nodePath from 'node:path';
import type { Clock, DirEntry, FsLike, PathApi, StatLike } from '../../../src/intellisense/types';

export interface Failure { op: 'readFile' | 'writeFile' | 'rename' | 'rm' | 'mkdir'; match: RegExp; code: string; times: number }

export class MemFs implements FsLike {
  readonly path: PathApi;
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();
  readonly failures: Failure[] = [];
  readonly ops: string[] = [];

  constructor(readonly flavour: 'posix' | 'win32' = 'posix') {
    this.path = flavour === 'win32' ? nodePath.win32 : nodePath.posix;
  }

  private key(p: string): string { return this.path.resolve(p); }

  private maybeFail(op: Failure['op'], p: string): void {
    const f = this.failures.find((x) => x.op === op && x.times > 0 && x.match.test(p));
    if (f) { f.times--; throw Object.assign(new Error(`${f.code}: injected ${op} failure on ${p}`), { code: f.code }); }
  }

  /** Create a file (and its folders) directly. */
  put(file: string, text: string | Uint8Array): void {
    const k = this.key(file);
    this.addDirs(this.path.dirname(k));
    this.files.set(k, typeof text === 'string' ? Buffer.from(text, 'utf8') : text);
  }

  mkdirp(dir: string): void { this.addDirs(this.key(dir)); }

  private addDirs(dir: string): void {
    let d = dir;
    for (let i = 0; i < 64; i++) {
      this.dirs.add(d);
      const parent = this.path.dirname(d);
      if (parent === d) { break; }
      d = parent;
    }
  }

  text(file: string): string | null {
    const v = this.files.get(this.key(file));
    return v === undefined ? null : Buffer.from(v).toString('utf8');
  }

  has(p: string): boolean { return this.files.has(this.key(p)) || this.dirs.has(this.key(p)); }

  list(dir: string): string[] {
    const base = this.key(dir);
    return [...this.files.keys()].filter((f) => f.startsWith(base) && f !== base).map((f) => this.path.relative(base, f).split(/[\\/]/).join('/')).sort();
  }

  async readFile(file: string): Promise<Uint8Array> {
    this.maybeFail('readFile', file);
    const v = this.files.get(this.key(file));
    if (v === undefined) { throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }); }
    return v;
  }

  async writeFile(file: string, data: Uint8Array | string): Promise<void> {
    this.maybeFail('writeFile', file);
    const k = this.key(file);
    if (!this.dirs.has(this.path.dirname(k))) { throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }); }
    this.ops.push(`write ${file}`);
    this.files.set(k, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  async createExclusive(file: string, data: Uint8Array | string): Promise<void> {
    this.maybeFail('writeFile', file);
    const k = this.key(file);
    if (this.files.has(k) || this.dirs.has(k)) { throw Object.assign(new Error(`EEXIST: ${file}`), { code: 'EEXIST' }); }
    if (!this.dirs.has(this.path.dirname(k))) { throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }); }
    this.ops.push(`create ${file}`);
    this.files.set(k, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  async rename(from: string, to: string): Promise<void> {
    this.maybeFail('rename', to);
    const a = this.key(from);
    const v = this.files.get(a);
    if (v === undefined) { throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' }); }
    this.ops.push(`rename ${from} -> ${to}`);
    this.files.delete(a);
    this.files.set(this.key(to), v);
  }

  async rm(target: string, options?: { recursive?: boolean }): Promise<void> {
    this.maybeFail('rm', target);
    const k = this.key(target);
    if (this.files.delete(k)) { this.ops.push(`rm ${target}`); return; }
    if (!this.dirs.has(k)) { return; }
    const inside = [...this.files.keys()].filter((f) => f.startsWith(k + this.path.sep));
    const subdirs = [...this.dirs].filter((d) => d.startsWith(k + this.path.sep));
    if ((inside.length > 0 || subdirs.length > 0) && options?.recursive !== true) { throw Object.assign(new Error(`ENOTEMPTY: ${target}`), { code: 'ENOTEMPTY' }); }
    for (const f of inside) { this.files.delete(f); }
    for (const d of subdirs) { this.dirs.delete(d); }
    this.dirs.delete(k);
    this.ops.push(`rmdir ${target}`);
  }

  async mkdir(dir: string): Promise<void> { this.maybeFail('mkdir', dir); this.addDirs(this.key(dir)); }

  async readdir(dir: string): Promise<DirEntry[]> {
    const k = this.key(dir);
    if (!this.dirs.has(k)) { throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' }); }
    const out = new Map<string, DirEntry>();
    for (const f of this.files.keys()) { if (this.path.dirname(f) === k) { const name = this.path.basename(f); out.set(name, { name, isDirectory: false, isFile: true }); } }
    for (const d of this.dirs) { if (d !== k && this.path.dirname(d) === k) { const name = this.path.basename(d); out.set(name, { name, isDirectory: true, isFile: false }); } }
    return [...out.values()];
  }

  async stat(target: string): Promise<StatLike | null> {
    const k = this.key(target);
    const v = this.files.get(k);
    if (v !== undefined) { return { isFile: true, isDirectory: false, size: v.length }; }
    if (this.dirs.has(k)) { return { isFile: false, isDirectory: true, size: 0 }; }
    return null;
  }

  /** Copy a real folder into this file system below `dest`. */
  importDir(realDir: string, dest: string): void {
    const walk = (src: string, to: string): void => {
      this.mkdirp(to);
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = nodePath.join(src, e.name);
        const t = this.path.join(to, e.name);
        if (e.isDirectory()) { walk(s, t); } else { this.put(t, fs.readFileSync(s)); }
      }
    };
    walk(realDir, dest);
  }
}

export class FakeClock implements Clock {
  t = 1_000_000;
  readonly sleeps: number[] = [];
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.sleeps.push(ms); this.t += ms; }
}

export const FIXTURES = nodePath.join(process.env.UPYBRIDGE_PROJECT_ROOT ?? process.cwd(), 'test', 'fixtures', 'intellisense');
export const RESOURCES_STUBS = nodePath.join(process.env.UPYBRIDGE_PROJECT_ROOT ?? process.cwd(), 'resources', 'stubs');
