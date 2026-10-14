/**
 * Injected facts for Python discovery tests: a fake file system in POSIX or Windows spelling, a scripted exec, and platform
 * descriptions. Windows behaviour here is injected (backslashes, drive letters, %LOCALAPPDATA%), never executed on Windows.
 */
import path from 'node:path';
import type { DiscoveryFs, PlatformFacts } from '../../../src/python/platform';
import type { ExecFn, ExecResult } from '../../../src/python/probe';

export class FakeFs implements DiscoveryFs {
  readonly files = new Set<string>();
  readonly dirs = new Set<string>();
  /** Links whose target is missing: they exist for lstat only. */
  readonly dangling = new Set<string>();
  private readonly p: path.PlatformPath;

  constructor(flavor: 'posix' | 'win32') {
    this.p = flavor === 'win32' ? path.win32 : path.posix;
  }

  add(...paths: string[]): this {
    for (const f of paths) {
      this.files.add(f);
      let d = this.p.dirname(f);
      while (!this.dirs.has(d)) {
        this.dirs.add(d);
        const up = this.p.dirname(d);
        if (up === d) { break; }
        d = up;
      }
    }
    return this;
  }

  remove(f: string): void { this.files.delete(f); }

  async exists(p: string): Promise<boolean> { return this.files.has(p) || this.dirs.has(p); }
  async lexists(p: string): Promise<boolean> { return this.files.has(p) || this.dirs.has(p) || this.dangling.has(p); }
  async isDir(p: string): Promise<boolean> { return this.dirs.has(p); }
  async readdir(p: string): Promise<string[]> {
    const names = new Set<string>();
    for (const x of [...this.files, ...this.dirs]) {
      if (x !== p && this.p.dirname(x) === p) { names.add(this.p.basename(x)); }
    }
    return [...names];
  }
}

export const MAC: PlatformFacts = { os: 'darwin', homedir: '/Users/student', env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' } };
export const WIN: PlatformFacts = {
  os: 'win32', homedir: 'C:\\Users\\Student Name',
  env: {
    PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Users\\Student Name\\AppData\\Local\\Microsoft\\WindowsApps', PATHEXT: '.COM;.EXE;.BAT;.CMD',
    LOCALAPPDATA: 'C:\\Users\\Student Name\\AppData\\Local', ProgramFiles: 'C:\\Program Files', USERPROFILE: 'C:\\Users\\Student Name',
  },
};

export function probeOk(executable: string, version: [number, number, number] = [3, 13, 13], implementation = 'cpython'): ExecResult {
  return { code: 0, signal: null, stdout: `${JSON.stringify({ executable, version, implementation })}\n`, stderr: '', timedOut: false };
}

export const ENOENT: ExecResult = { code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: { code: 'ENOENT', message: 'spawn ENOENT' } };

export interface ExecCall { command: string; args: readonly string[] }

/** A scripted exec: `rules` maps a command (exact) to its result; anything else is ENOENT. Records every call. */
export function scriptedExec(rules: Record<string, ExecResult | ((args: readonly string[]) => ExecResult)>): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args });
    const r = rules[command];
    return typeof r === 'function' ? r(args) : r ?? ENOENT;
  };
  return { exec, calls };
}

export const probeCalls = (calls: ExecCall[]): ExecCall[] => calls.filter((c) => c.args.includes('-c'));
