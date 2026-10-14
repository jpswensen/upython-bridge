/**
 * Adversarial review of the IntelliSense UI path (src/commands/intellisense.ts): can the command ever clobber a file of the user?
 * Every test runs the REAL controller + REAL library + real disk against a hostile workspace and compares a hash snapshot of
 * everything outside `.upy-bridge/` before and after. Made-up "acme" names only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parse as parseJsonc } from 'jsonc-parser';
import { TRACKER_REL } from '../../../src/intellisense';
import { TempDirs } from '../../mocks/fixtures';
import { mock } from '../../mocks/vscode';
import { exists, makeProject, makeRig, openWorkspace, read, type Project, type Rig } from '../intellisense-ui/helpers';

const dirs = new TempDirs();
let rig: Rig | undefined;
const restore: (() => void)[] = [];
beforeEach(() => mock.reset());
afterEach(() => {
  for (const r of restore.splice(0)) { try { r(); } catch { /* best effort */ } }
  rig?.h.dispose();
  rig = undefined;
  mock.reset();
  dirs.cleanup();
});

const ALL = { createUserConfig: true, editSettings: true };

/** relative path -> content hash (or `-> target` for links) of everything below `root`, skipping `skip` (workspace-relative prefixes). */
function snapshot(root: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) { continue; }
      if (e.isSymbolicLink()) { out[rel] = `-> ${fs.readlinkSync(abs)}`; }
      else if (e.isDirectory()) { out[rel] = '<dir>'; walk(abs); }
      else { out[rel] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); }
    }
  };
  walk(root);
  return out;
}

async function runFix(p: Project, consent: Record<string, boolean> = ALL): Promise<Awaited<ReturnType<Rig['controller']['fix']>>> {
  openWorkspace(p.ws);
  rig = makeRig();
  rig.prompter.set({ consent });
  return rig.controller.fix();
}

describe('1. hostile pyrightconfig.json / pyproject.toml / settings.json / typings', () => {
  const variants: [string, (ws: string) => void][] = [
    ['comments + BOM, no extends', (ws) => fs.writeFileSync(path.join(ws, 'pyrightconfig.json'), '﻿// mine\n{ /* c */ "typeCheckingMode": "strict", }\n')],
    ['invalid JSON', (ws) => fs.writeFileSync(path.join(ws, 'pyrightconfig.json'), '{ "extends": ')],
    ['extends elsewhere', (ws) => fs.writeFileSync(path.join(ws, 'pyrightconfig.json'), '{ "extends": "../shared/pyrightconfig.json" }\n')],
    ['empty file', (ws) => fs.writeFileSync(path.join(ws, 'pyrightconfig.json'), '')],
    ['a directory with that name', (ws) => fs.mkdirSync(path.join(ws, 'pyrightconfig.json'))],
    ['a dangling link', (ws) => fs.symlinkSync('/nonexistent/acme/target.json', path.join(ws, 'pyrightconfig.json'))],
    ['binary garbage', (ws) => fs.writeFileSync(path.join(ws, 'pyrightconfig.json'), Buffer.from([0xff, 0xfe, 0, 1, 2, 3, 0x80]))],
  ];
  for (const [name, setup] of variants) {
    it(`pyrightconfig.json: ${name} stays byte-for-byte and nothing outside .upy-bridge changes`, async () => {
      const p = makeProject(dirs);
      setup(p.ws);
      const before = snapshot(p.base, ['ws (acme)/.upy-bridge']);
      const outcome = await runFix(p);
      assert.notEqual(outcome.status, 'failed', JSON.stringify(outcome.errors));
      assert.deepEqual(snapshot(p.base, ['ws (acme)/.upy-bridge']), before);
    });
  }

  it('pyproject.toml with [tool.pyright]: no pyrightconfig.json is created even with every consent; the toml is unchanged', async () => {
    const p = makeProject(dirs);
    const toml = '[tool.pyright]\nvenvPath = "."\n';
    fs.writeFileSync(path.join(p.ws, 'pyproject.toml'), toml);
    const outcome = await runFix(p);
    assert.equal(outcome.status, 'applied');
    assert.equal(exists(p.ws, 'pyrightconfig.json'), false);
    assert.equal(read(p.ws, 'pyproject.toml'), toml);
  });

  it('.vscode/settings.json with comments and trailing commas is untouched (default tier), even with editSettings consent', async () => {
    const p = makeProject(dirs);
    fs.mkdirSync(path.join(p.ws, '.vscode'));
    const text = '{\n  // mine\n  "editor.tabSize": 2,\n  "python.analysis.extraPaths": ["x",],\n}\n';
    fs.writeFileSync(path.join(p.ws, '.vscode', 'settings.json'), text);
    await runFix(p);
    assert.equal(read(p.ws, '.vscode', 'settings.json'), text);
  });

  it('no .vscode/settings.json is created when none exists', async () => {
    const p = makeProject(dirs);
    await runFix(p);
    assert.equal(exists(p.ws, '.vscode'), false);
  });

  it('an existing typings/ folder is left alone (and no stock stubs are copied into it)', async () => {
    const p = makeProject(dirs);
    fs.mkdirSync(path.join(p.ws, 'typings'));
    fs.writeFileSync(path.join(p.ws, 'typings', 'mine.pyi'), 'def mine() -> int: ...\n');
    const before = snapshot(p.ws, ['.upy-bridge', 'pyrightconfig.json']);
    await runFix(p);
    assert.deepEqual(snapshot(p.ws, ['.upy-bridge', 'pyrightconfig.json']), before);
  });
});

describe('2. links: the command must not write or delete outside the workspace through a link', () => {
  it('a managed generated file that is a link to a user file elsewhere is not overwritten through the link', async () => {
    const p = makeProject(dirs);
    const outside = path.join(p.base, 'precious.txt');
    fs.writeFileSync(outside, 'PRECIOUS');
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.symlinkSync(outside, path.join(p.ws, '.upy-bridge', 'pyright.generated.json'));
    await runFix(p);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'PRECIOUS', 'the target of the link must stay as it was');
  });

  it('a link .upy-bridge/stubs -> folder outside: nothing is written outside the workspace', async () => {
    const p = makeProject(dirs);
    const outside = path.join(p.base, 'elsewhere');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.symlinkSync(outside, path.join(p.ws, '.upy-bridge', 'stubs'));
    await runFix(p);
    assert.deepEqual(fs.readdirSync(outside), [], 'the folder behind the link must stay empty');
  });

  it('a link .upy-bridge -> folder outside: nothing is written outside the workspace', async () => {
    const p = makeProject(dirs);
    const outside = path.join(p.base, 'elsewhere2');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(p.ws, '.upy-bridge'));
    await runFix(p);
    assert.deepEqual(fs.readdirSync(outside), [], 'the folder behind the link must stay empty');
  });

  it('a hostile tracker (it travels with a zip/git checkout) cannot make Remove delete a file outside the workspace through a link', async () => {
    const p = makeProject(dirs);
    const victimDir = path.join(p.base, 'documents');
    fs.mkdirSync(victimDir);
    fs.writeFileSync(path.join(victimDir, 'report.txt'), 'MY REPORT');
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.symlinkSync(victimDir, path.join(p.ws, '.upy-bridge', 'stubs'));
    fs.writeFileSync(path.join(p.ws, ...TRACKER_REL.split('/')), JSON.stringify({ schema: 1, files: { '.upy-bridge/stubs/report.txt': 'x' }, createdOnce: {}, settings: [], stock: null, createdAt: 1 }));
    openWorkspace(p.ws);
    rig = makeRig();
    await rig.controller.remove();
    assert.equal(fs.existsSync(path.join(victimDir, 'report.txt')), true, 'Remove deleted a file outside the workspace');
  });

  it('a hostile tracker cannot make the setup (fix) delete a file outside the workspace through a link', async () => {
    const p = makeProject(dirs);
    const victimDir = path.join(p.base, 'documents');
    fs.mkdirSync(victimDir);
    fs.writeFileSync(path.join(victimDir, 'report.txt'), 'MY REPORT');
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.symlinkSync(victimDir, path.join(p.ws, '.upy-bridge', 'junk'));
    fs.writeFileSync(path.join(p.ws, ...TRACKER_REL.split('/')), JSON.stringify({ schema: 1, files: { '.upy-bridge/junk/report.txt': 'x' }, createdOnce: {}, settings: [], stock: null, createdAt: 1 }));
    await runFix(p);
    assert.equal(fs.existsSync(path.join(victimDir, 'report.txt')), true, 'the setup deleted a file outside the workspace');
  });
});

describe('2b. the tracker travels with the folder and is not trusted: it must not turn user files into "managed" ones', () => {
  it('Remove keeps a typings/ file of the user that a tracker lists with a hash that does not match the file', async () => {
    const p = makeProject(dirs);
    fs.mkdirSync(path.join(p.ws, 'typings'));
    fs.writeFileSync(path.join(p.ws, 'typings', 'mine.pyi'), 'def mine() -> int: ...\n');
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.writeFileSync(path.join(p.ws, ...TRACKER_REL.split('/')), JSON.stringify({ schema: 1, files: { 'typings/mine.pyi': '0'.repeat(64) }, createdOnce: {}, settings: [], stock: null, createdAt: 1 }));
    openWorkspace(p.ws);
    rig = makeRig();
    await rig.controller.remove();
    assert.equal(exists(p.ws, 'typings', 'mine.pyi'), true, 'a file whose content differs from the recorded hash was deleted as "created by the extension"');
  });
});

describe('3. disk states that make writing fail', () => {
  it('a read-only workspace folder: status failed within seconds (finding F5: it took 75 s), a message with the cause, no half-written tracker, nothing outside changes', async function (t) {
    if (process.getuid?.() === 0 || process.platform === 'win32') { t.skip('needs a non-root POSIX user'); return; }
    const p = makeProject(dirs);
    fs.chmodSync(p.ws, 0o555);
    restore.push(() => fs.chmodSync(p.ws, 0o755));
    const before = snapshot(p.base);
    const t0 = Date.now();
    const outcome = await runFix(p);
    const took = Date.now() - t0;
    assert.equal(outcome.status, 'failed');
    assert.ok((outcome.errors?.length ?? 0) > 0);
    assert.ok((outcome.errors?.length ?? 0) <= 10, `one error per file would bury the cause: ${outcome.errors?.length} errors`);
    assert.ok(took < 20_000, `the setup needed ${took} ms to give up`);
    assert.deepEqual(snapshot(p.base), before, 'nothing may change');
    assert.match(mock.messages('error').map((m) => m.message).join('\n'), /could not|cannot|Cannot|EACCES|permission/i);
  });

  it('.upy-bridge exists as a FILE: a clear error, the file is not replaced, no crash', async () => {
    const p = makeProject(dirs);
    fs.writeFileSync(path.join(p.ws, '.upy-bridge'), 'I am a file');
    const outcome = await runFix(p);
    assert.ok(outcome.status === 'failed' || (outcome.errors?.length ?? 0) > 0, JSON.stringify(outcome));
    assert.equal(fs.readFileSync(path.join(p.ws, '.upy-bridge'), 'utf8'), 'I am a file');
  });

  it('the tracker path is a directory: no crash, status is reported', async () => {
    const p = makeProject(dirs);
    fs.mkdirSync(path.join(p.ws, '.upy-bridge', 'manifest.json'), { recursive: true });
    const outcome = await runFix(p);
    assert.ok(['failed', 'applied', 'up-to-date'].includes(outcome.status), outcome.status);
  });
});

describe('4. where the workspace is', () => {
  it('a workspace INSIDE a bigger folder (a course repo, other projects next to it): only the workspace gets files', async () => {
    const p = makeProject(dirs);
    const inner = path.join(p.base, 'projects', 'acme student');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'main.py'), 'import _acme\n');
    openWorkspace(inner);
    rig = makeRig();
    rig.prompter.set({ consent: ALL });
    const before = snapshot(p.base, ['projects/acme student/.upy-bridge', 'projects/acme student/pyrightconfig.json']);
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'applied', JSON.stringify(outcome.errors));
    assert.deepEqual(snapshot(p.base, ['projects/acme student/.upy-bridge', 'projects/acme student/pyrightconfig.json']), before);
    assert.equal(exists(p.ws, '.upy-bridge'), false);
  });

  it('non-ASCII / parentheses / spaces in the path: a valid generated config with POSIX relative paths', async () => {
    const base = dirs.make('upy-bridge-is');
    const ws = path.join(base, 'Prüfung 日本語 (ä) 100%', 'Lab 1');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'main.py'), 'import machine\n');
    openWorkspace(ws);
    rig = makeRig();
    rig.prompter.set({ consent: ALL });
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'applied', JSON.stringify(outcome.errors));
    const gen = parseJsonc(read(ws, '.upy-bridge', 'pyright.generated.json')) as { extraPaths?: string[]; stubPath?: string };
    assert.equal(typeof gen.stubPath, 'string');
    for (const e of gen.extraPaths ?? []) { assert.doesNotMatch(e, /\\/); }
  });

  it('multi-root: with args.folder the named folder gets the files and the other none', async () => {
    const a = makeProject(dirs);
    const b = makeProject(dirs);
    mock.setWorkspaceFolders(a.ws, b.ws);
    rig = makeRig();
    rig.prompter.set({ consent: ALL });
    const outcome = await rig.controller.fix({ folder: path.join(b.ws, 'main.py') });
    assert.equal(outcome.status, 'applied');
    assert.equal(exists(b.ws, '.upy-bridge'), true);
    assert.equal(exists(a.ws, '.upy-bridge'), false);
  });

  it('multi-root without an argument and without an editor: asks which folder (QuickPick), cancel writes nothing', async () => {
    const a = makeProject(dirs);
    const b = makeProject(dirs);
    mock.setWorkspaceFolders(a.ws, b.ws);
    rig = makeRig();
    rig.prompter.set({ consent: ALL });
    mock.answerQuickPick(undefined);
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'no-folder');
    assert.equal(exists(a.ws, '.upy-bridge') || exists(b.ws, '.upy-bridge'), false);
    assert.equal(mock.calls.quickPicks.length, 1);
  });

  it('multi-root: a folder that is a virtual (non-file) workspace is never chosen', async () => {
    const a = makeProject(dirs);
    const { Uri } = await import('../../mocks/vscodeCore');
    mock.setWorkspaceFolders(Uri.parse('vscode-vfs://github/acme/repo'), a.ws);
    rig = makeRig();
    rig.prompter.set({ consent: ALL });
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'applied');
    assert.equal(outcome.folder, a.ws);
  });

  it('only a virtual workspace: says what to do, writes nothing, no exception', async () => {
    const { Uri } = await import('../../mocks/vscodeCore');
    mock.setWorkspaceFolders(Uri.parse('vscode-vfs://github/acme/repo'));
    rig = makeRig();
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'no-folder');
    const removed = await rig.controller.remove();
    assert.equal(removed, undefined);
    assert.match(mock.messages('info').map((m) => m.message).join('\n'), /Open the folder/);
  });

  it('no workspace folder at all', async () => {
    rig = makeRig();
    assert.equal((await rig.controller.fix()).status, 'no-folder');
    assert.equal(await rig.controller.remove(), undefined);
  });
});
