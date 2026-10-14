/** Ignore rules: defaults, `.mpyignore` with gitignore semantics (negation, anchoring, dir-only), legacy file, cloud-folder junk. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { IDENTITY, LEGACY } from '../../src/identity';
import { DEFAULT_IGNORE_PATTERNS, IgnoreMatcher, createDefaultIgnoreFile, defaultIgnoreFileText, loadIgnoreMatcher } from '../../src/sync/ignore';
import { scanLocal } from '../../src/sync/localScan';
import { makeTrickyDir, TempDirs } from '../mocks/fixtures';

const dirs = new TempDirs();
afterEach(() => dirs.cleanup());

describe('default ignore list', () => {
  const m = new IgnoreMatcher();

  it('skips editor, stub and environment folders and files', () => {
    for (const p of [`${IDENTITY.dotDir}/pyright.generated.json`, `${LEGACY.dotDir}/config.json`, 'course-stubs/pkg/__init__.py', 'typings/x/y.pyi',
      'pyrightconfig.json', 'lib/mod.pyi', '.venv/lib/site.py', 'venv/bin/python', 'env/x.py', '.git/config', 'node_modules/a/b.js',
      'src/__pycache__/x.cpython-313.pyc', '.vscode/settings.json', '.DS_Store', 'sub/.DS_Store', 'Thumbs.db', 'desktop.ini', '~$notes.docx',
      'draft.tmp', IDENTITY.ignoreFile, 'main.py.mpytmp', 'a.pyc']) {
      assert.equal(m.ignores(p), true, p);
    }
  });

  it('lets ordinary program files through', () => {
    for (const p of ['main.py', 'boot.py', 'lib/util.py', 'data/readings.csv', 'config.json', 'Lab 1 (final)/robot.py', 'café/中.py', 'environment.py', 'venvs.py', 'typing_helpers.py']) {
      assert.equal(m.ignores(p), false, p);
    }
  });

  it('matches the cloud-client junk names whatever their case (OneDrive, Dropbox, iCloud)', () => {
    for (const p of ['thumbs.db', 'DESKTOP.INI', '.dropbox', '.dropbox.cache/x', 'main.py.icloud', '.~lock.notes.odt#', 'download.crdownload', 'x.swp', 'backup.py~']) {
      assert.equal(m.ignores(p), true, p);
    }
  });

  it('decides folders with a trailing slash and treats impossible paths as ignored', () => {
    assert.equal(m.ignores('typings', true), true);
    assert.equal(m.ignores('lib', true), false);
    assert.equal(m.ignores(''), true);
    assert.equal(m.ignores('/abs.py'), true);
    assert.equal(m.ignores('../out.py'), true);
    assert.equal(m.ignores('a/./b.py'), true);
  });

  it('is built from the identity file, never from hard-coded names', () => {
    assert.ok(DEFAULT_IGNORE_PATTERNS.includes(`${IDENTITY.dotDir}/`));
    assert.ok(DEFAULT_IGNORE_PATTERNS.includes(IDENTITY.ignoreFile));
  });
});

describe('.mpyignore rules (gitignore semantics)', () => {
  it('supports globs, character classes, anchoring and directory-only patterns', () => {
    const m = new IgnoreMatcher(['*.log', 'build/', '/only-root.txt', 'docs/**/*.md', '*.py[cod]'].join('\n'));
    assert.equal(m.ignores('run.log'), true);
    assert.equal(m.ignores('sub/run.log'), true);
    assert.equal(m.ignores('build/x.py'), true);
    assert.equal(m.ignores('lib/build/x.py'), true);
    assert.equal(m.ignores('build', false), false, 'a FILE named build is not the folder build/');
    assert.equal(m.ignores('only-root.txt'), true);
    assert.equal(m.ignores('sub/only-root.txt'), false);
    assert.equal(m.ignores('docs/a/b/readme.md'), true);
    assert.equal(m.ignores('x.pyd'), true, 'the old home-made matcher missed character classes');
  });

  it('supports negation, also to bring back a default-ignored file', () => {
    const m = new IgnoreMatcher('*.csv\n!keep.csv\n!lib/board_helpers.pyi\n!typings/inside.pyi');
    assert.equal(m.ignores('a.csv'), true);
    assert.equal(m.ignores('keep.csv'), false);
    assert.equal(m.ignores('lib/board_helpers.pyi'), false, 'a default file rule (*.pyi) can be undone');
    assert.equal(m.ignores('lib/other.pyi'), true);
    assert.equal(m.ignores('typings/inside.pyi'), true, 'as in git, a file inside an ignored folder cannot be brought back');
  });

  it('applies the legacy file first and the workspace file last (the workspace wins)', () => {
    const m = new IgnoreMatcher(['secret.py\n*.dat', '!secret.py\n']);
    assert.equal(m.ignores('secret.py'), false);
    assert.equal(m.ignores('x.dat'), true);
  });

  it('ignores comments and blank lines', () => {
    const m = new IgnoreMatcher('# comment\n\n  \nvendor/\n');
    assert.equal(m.ignores('vendor/a.py'), true);
    assert.equal(m.ignores('# comment'), false);
  });
});

describe('loading from disk', () => {
  it('reads the workspace file and the legacy file, in a OneDrive-style folder', async () => {
    const ws = makeTrickyDir(dirs.make());
    fs.mkdirSync(path.join(ws, LEGACY.dotDir));
    fs.writeFileSync(path.join(ws, LEGACY.dotDir, LEGACY.ignoreFile), 'legacy_only.py\n');
    fs.writeFileSync(path.join(ws, IDENTITY.ignoreFile), 'workspace_only.py\n');
    const loaded = await loadIgnoreMatcher(ws);
    assert.equal(loaded.sources.length, 2);
    assert.equal(loaded.matcher.ignores('legacy_only.py'), true);
    assert.equal(loaded.matcher.ignores('workspace_only.py'), true);
    assert.equal(loaded.matcher.ignores('main.py'), false);
    assert.deepEqual(loaded.warnings, []);
  });

  it('works without any ignore file', async () => {
    const ws = dirs.make();
    const loaded = await loadIgnoreMatcher(ws);
    assert.deepEqual(loaded.sources, []);
    assert.equal(loaded.matcher.ignores('.venv/x.py'), true);
  });

  it('creates a commented default file once and never overwrites it', async () => {
    const ws = dirs.make();
    const first = await createDefaultIgnoreFile(ws);
    assert.equal(first.created, true);
    const text = fs.readFileSync(first.file, 'utf8');
    assert.equal(text, defaultIgnoreFileText());
    assert.match(text, /\.venv\//);
    assert.match(text, /^# /m);
    fs.writeFileSync(first.file, 'mine\n');
    const second = await createDefaultIgnoreFile(ws);
    assert.equal(second.created, false);
    assert.equal(fs.readFileSync(first.file, 'utf8'), 'mine\n');
    // the generated file must itself be a valid rule set that ignores nothing a student would want to upload
    assert.equal(new IgnoreMatcher(text).ignores('main.py'), false);
  });
});

describe('local scan honours the rules', () => {
  it('skips ignored folders without entering them, python environments and shortcuts, and keeps tricky names', async () => {
    const ws = makeTrickyDir(dirs.make());
    const put = (rel: string, text = 'x'): void => {
      fs.mkdirSync(path.dirname(path.join(ws, ...rel.split('/'))), { recursive: true });
      fs.writeFileSync(path.join(ws, ...rel.split('/')), text);
    };
    put('main.py', 'print(1)');
    put('lib/café (v2).py');
    put('.venv/lib/site.py');
    put('myenv/pyvenv.cfg');
    put('myenv/bin/python');
    put('typings/a.pyi');
    put('Thumbs.db');
    put('empty_dir/.keep_not_ignored', '');
    fs.mkdirSync(path.join(ws, 'really_empty'));
    const scan = await scanLocal(ws, (await loadIgnoreMatcher(ws)).matcher);
    assert.deepEqual(scan.files.map((f) => f.path), ['empty_dir/.keep_not_ignored', 'lib/café (v2).py', 'main.py']);
    assert.ok(scan.dirs.includes('really_empty'));
    assert.ok(scan.warnings.some((w) => /myenv\/ looks like a Python environment/.test(w)));
    assert.ok(scan.ignoredCount >= 3);
    assert.equal(scan.files.find((f) => f.path === 'main.py')?.sha256.length, 64);
  });

  it('caps the number of files and says so', async () => {
    const ws = dirs.make();
    for (let i = 0; i < 6; i++) { fs.writeFileSync(path.join(ws, `f${i}.py`), String(i)); }
    const scan = await scanLocal(ws, new IgnoreMatcher(), { maxFiles: 4 });
    assert.equal(scan.files.length, 4);
    assert.equal(scan.truncated, true);
    assert.ok(scan.warnings.some((w) => /more than 4 files/.test(w)));
  });
});
