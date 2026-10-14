/**
 * Platform facts and path helpers for Python discovery. Everything that differs between macOS, Windows and Linux is data or an
 * injected function here, so Windows behaviour (backslashes, drive letters, %LOCALAPPDATA%) is tested on any machine.
 * No `vscode` import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PlatformFacts {
  readonly os: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

export function hostPlatform(): PlatformFacts {
  return { os: process.platform, env: process.env, homedir: os.homedir() };
}

export function pathFor(platform: PlatformFacts): path.PlatformPath {
  return platform.os === 'win32' ? path.win32 : path.posix;
}

/** Read access to the file system, asynchronous so a slow cloud folder never blocks the extension host. */
export interface DiscoveryFs {
  /** Follows symbolic links: a dangling link does not exist. */
  exists(p: string): Promise<boolean>;
  /** Does not follow symbolic links. */
  lexists(p: string): Promise<boolean>;
  isDir(p: string): Promise<boolean>;
  /** Names in the folder; an empty list when it cannot be read. */
  readdir(p: string): Promise<string[]>;
}

export function nodeFs(): DiscoveryFs {
  return {
    exists: async (p) => fs.promises.stat(p).then(() => true, () => false),
    lexists: async (p) => fs.promises.lstat(p).then(() => true, () => false),
    isDir: async (p) => fs.promises.stat(p).then((s) => s.isDirectory(), () => false),
    readdir: async (p) => fs.promises.readdir(p).catch(() => []),
  };
}

// ------------------------------------------------------------------ variables in the pythonPath setting

export type Expanded = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Expand `~`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${env:NAME}` and `${pathSeparator}`.
 * Anything else in `${...}` is an error (never silently left in the path).
 */
export function expandVariables(raw: string, folder: string | null, platform: PlatformFacts): Expanded {
  const p = pathFor(platform);
  let failure: string | null = null;
  let text = raw;
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    text = platform.homedir + text.slice(1);
  }
  text = text.replace(/\$\{([^}]*)\}/g, (whole, name: string) => {
    if (name === 'workspaceFolder') {
      if (folder === null) {
        failure = `${whole} needs an open folder, but no folder is open`;
        return whole;
      }
      return folder;
    }
    if (name === 'workspaceFolderBasename') {
      return folder === null ? '' : p.basename(folder);
    }
    if (name === 'userHome') {
      return platform.homedir;
    }
    if (name === 'pathSeparator' || name === '/') {
      return p.sep;
    }
    if (name.startsWith('env:')) {
      const v = platform.env[name.slice(4)];
      if (v === undefined || v === '') {
        failure = `the environment variable ${name.slice(4)} is not set`;
        return whole;
      }
      return v;
    }
    failure = `${whole} is not a variable this setting understands`;
    return whole;
  });
  return failure === null ? { ok: true, value: text } : { ok: false, reason: failure };
}

// ------------------------------------------------------------------ PATH lookup and small globs

/** Where `name` would be found on PATH (first hit), or null. Mirrors `which`/`where` without running either. */
export async function whichInPath(name: string, platform: PlatformFacts, dirs: DiscoveryFs): Promise<string | null> {
  const p = pathFor(platform);
  const pathVar = platform.env.PATH ?? platform.env.Path ?? platform.env.path ?? '';
  const sep = platform.os === 'win32' ? ';' : ':';
  const exts = platform.os === 'win32' ? (platform.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const names = platform.os === 'win32' && /\.[A-Za-z0-9]+$/.test(name) ? [name] : exts.map((e) => name + e.toLowerCase());
  for (const dir of pathVar.split(sep).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    for (const n of names) {
      const candidate = p.join(dir, n);
      if (await dirs.exists(candidate) && !(await dirs.isDir(candidate))) {
        return candidate;
      }
    }
  }
  return null;
}

function globToRegExp(segment: string, ci: boolean): RegExp {
  const body = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, ci ? 'i' : '');
}

function naturalDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
}

/** Segment-wise `*` glob (no `**`): existing files that match, newest-looking names first. */
export async function expandGlob(pattern: string, platform: PlatformFacts, dirs: DiscoveryFs): Promise<string[]> {
  const p = pathFor(platform);
  const parsed = p.parse(pattern);
  const root = parsed.root;
  const segments = pattern.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let bases: string[] = [root];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? '';
    const next: string[] = [];
    for (const base of bases) {
      if (!/[*?]/.test(seg)) {
        next.push(p.join(base, seg));
        continue;
      }
      const re = globToRegExp(seg, platform.os === 'win32');
      const names = (await dirs.readdir(base)).filter((n) => re.test(n)).sort(naturalDesc);
      for (const n of names) {
        next.push(p.join(base, n));
      }
    }
    bases = next;
  }
  const found: string[] = [];
  for (const b of bases) {
    if (await dirs.exists(b) && !(await dirs.isDir(b))) {
      found.push(b);
    }
  }
  return found;
}

// ------------------------------------------------------------------ cloud-synced folders (RQ-CLOUD-2)

const CLOUD_MARKERS: readonly { re: RegExp; service: string }[] = [
  { re: /onedrive/i, service: 'OneDrive' },
  { re: /icloud|mobile documents/i, service: 'iCloud Drive' },
  { re: /dropbox/i, service: 'Dropbox' },
  { re: /google ?drive|^my drive$/i, service: 'Google Drive' },
  { re: /^cloudstorage$/i, service: 'a cloud storage folder (CloudStorage)' },
];

/** The cloud service whose synced folder contains `p` (judged by its folder names), or null. Works on both path styles. */
export function classifyCloudPath(p: string): string | null {
  const segments = p.split(/[\\/]+/);
  for (const m of CLOUD_MARKERS) { // specific services first: CloudStorage/OneDrive-... is OneDrive
    if (segments.some((s) => m.re.test(s))) {
      return m.service;
    }
  }
  return null;
}

/** Same path on case-insensitive systems: compares after normalising separators (and case on Windows). */
export function samePath(a: string, b: string, platform: PlatformFacts): boolean {
  const norm = (x: string): string => {
    const n = pathFor(platform).normalize(x);
    return platform.os === 'win32' ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}
