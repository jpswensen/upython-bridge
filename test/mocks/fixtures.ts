/**
 * Shared test fixtures: project root, temp folders and the "difficult path" fixtures (RQ-CLOUD-1, CLAUDE.md rule 8):
 * spaces, parentheses, non-ASCII, OneDrive-style names, and Windows paths given as plain strings so Windows behaviour is
 * tested on macOS by injection (no real Windows filesystem is touched).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Repository root. The runner sets UPYBRIDGE_PROJECT_ROOT; started by hand, tests must run from the root. */
export function projectRoot(): string {
  return process.env.UPYBRIDGE_PROJECT_ROOT ?? process.cwd();
}

export function makeTempDir(prefix = 'upy-bridge'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/** Temp folders owned by one test (or one `describe`): `afterEach(() => dirs.cleanup())`. */
export class TempDirs {
  private readonly made: string[] = [];

  make(prefix = 'upy-bridge'): string {
    const dir = makeTempDir(prefix);
    this.made.push(dir);
    return dir;
  }

  cleanup(): void {
    for (const dir of this.made.splice(0)) {
      removeDir(dir);
    }
  }
}

/** A OneDrive-style project path with spaces, parentheses and non-ASCII, built from generic names. */
export const TRICKY_SEGMENTS: readonly string[] = [
  'OneDrive-Example University(email.example.edu)',
  'Lab Course (Fall)',
  'Lab 1 \u00dcbung \u00e9\u4e2d',
];

/** Create (and return) `<base>/<TRICKY_SEGMENTS...>` on the real filesystem. */
export function makeTrickyDir(base: string): string {
  const dir = path.join(base, ...TRICKY_SEGMENTS);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Windows facts as strings (never touch a disk): drive letters, backslashes, COM names, spaces. */
export const WINDOWS = {
  workspace: 'C:\\Users\\Student Name\\OneDrive - Example University\\Documents\\Lab Course (Fall)\\Lab 1',
  mainPy: 'C:\\Users\\Student Name\\OneDrive - Example University\\Documents\\Lab Course (Fall)\\Lab 1\\main.py',
  nestedPy: 'C:\\Users\\Student Name\\OneDrive - Example University\\Documents\\Lab Course (Fall)\\Lab 1\\src\\a.py',
  python: 'C:\\Users\\Student Name\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
  unc: '\\\\fileserver\\share\\Lab 1\\main.py',
  comPort: 'COM12',
} as const;

/** The same workspace in POSIX form (macOS File Provider style). */
export const MACOS_ONEDRIVE_WORKSPACE =
  '/Users/student/Library/CloudStorage/OneDrive-Example University(email.example.edu)/Lab Course (Fall)/Lab 1';

/**
 * `assert.rejects` that also accepts the `Thenable`s the vscode API returns (assert.rejects insists on a real Promise).
 * `expected` is a RegExp for the message or a predicate on the error.
 */
export function expectRejects(work: PromiseLike<unknown>, expected?: RegExp | ((err: unknown) => boolean)): Promise<void> {
  return expected === undefined ? assert.rejects(Promise.resolve(work)) : assert.rejects(Promise.resolve(work), expected);
}
