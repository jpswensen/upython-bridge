/**
 * Path mapping, name rules, collisions and the shadow guard (docs/analysis/03-fs-sync.md 6.8, R-FS-25/26/27).
 * Windows behaviour is tested by injecting `path.win32`: it proves the code follows Windows rules, not that it runs on Windows.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  PathError, PathMapper, describeProblem, findCollisions, importRootsFrom, matchKey, nfc, relPathProblem, segmentProblem, shadowedModule,
} from '../../src/sync/paths';
import { MACOS_ONEDRIVE_WORKSPACE, TRICKY_SEGMENTS, WINDOWS } from '../mocks/fixtures';

describe('PathMapper (POSIX host)', () => {
  const m = new PathMapper(MACOS_ONEDRIVE_WORKSPACE, '/', path.posix);

  it('maps a nested file to a relative path and a device path', () => {
    const abs = `${MACOS_ONEDRIVE_WORKSPACE}/lib/sub dir/util (v2).py`;
    assert.equal(m.localToRel(abs), 'lib/sub dir/util (v2).py');
    assert.equal(m.localToDevice(abs), '/lib/sub dir/util (v2).py');
    assert.equal(m.deviceToLocal('/lib/sub dir/util (v2).py'), abs);
  });

  it('keeps non-ASCII names and survives a round trip', () => {
    const rel = `${TRICKY_SEGMENTS[2]}/caf\u00e9 \u4e2d.py`;
    assert.equal(m.deviceToRel(m.relToDevice(rel)), rel);
    assert.equal(m.localToRel(m.relToLocal(rel)), rel);
  });

  it('rejects paths outside the workspace and the workspace itself', () => {
    assert.equal(m.localToRel('/Users/student/other/main.py'), undefined);
    assert.equal(m.localToRel(MACOS_ONEDRIVE_WORKSPACE), undefined);
    assert.equal(m.localToRel(`${MACOS_ONEDRIVE_WORKSPACE}/../escape.py`), undefined);
  });

  it('refuses traversal and absolute names when going from relative to local', () => {
    assert.throws(() => m.relToLocal('../x.py'), (e: unknown) => e instanceof PathError && e.problem === 'traversal');
    assert.throws(() => m.relToLocal('a/../../x.py'), PathError);
    assert.throws(() => m.relToLocal('/etc/passwd'), (e: unknown) => e instanceof PathError && e.problem === 'absolute');
    assert.throws(() => m.relToDevice('a\\b.py'), (e: unknown) => e instanceof PathError && e.problem === 'backslash');
  });

  it('applies rootPath uniformly and never maps the root itself', () => {
    const lib = new PathMapper(MACOS_ONEDRIVE_WORKSPACE, '/lib/', path.posix);
    assert.equal(lib.rootPath, '/lib');
    assert.equal(lib.relToDevice('a.py'), '/lib/a.py');
    assert.equal(lib.deviceToRel('/lib/a.py'), 'a.py');
    assert.equal(lib.deviceToRel('/lib'), undefined);
    assert.equal(lib.deviceToRel('/main.py'), undefined);
    assert.equal(lib.deviceToRel('/library/a.py'), undefined);
    assert.equal(lib.isInsideRoot('/lib'), true);
    assert.equal(lib.isInsideRoot('/other/a.py'), false);
  });

  it('rejects a root path that is not an absolute POSIX folder', () => {
    assert.throws(() => new PathMapper('/w', 'lib', path.posix), PathError);
    assert.throws(() => new PathMapper('/w', '/a/../b', path.posix), PathError);
  });
});

describe('PathMapper (Windows rules, injected path.win32)', () => {
  const m = new PathMapper(WINDOWS.workspace, '/', path.win32);

  it('converts backslashes to a POSIX relative path and back', () => {
    assert.equal(m.localToRel(WINDOWS.nestedPy), 'src/a.py');
    assert.equal(m.localToDevice(WINDOWS.nestedPy), '/src/a.py');
    assert.equal(m.relToLocal('src/a.py'), WINDOWS.nestedPy);
    assert.equal(m.deviceToLocal('/lib/x y.py'), `${WINDOWS.workspace}\\lib\\x y.py`);
  });

  it('is case-insensitive for the drive and folders like Windows', () => {
    assert.equal(m.localToRel(WINDOWS.mainPy.replace('C:', 'c:').replace('Documents', 'documents')), 'main.py');
  });

  it('rejects other drives and UNC paths as outside the workspace', () => {
    assert.equal(m.localToRel('D:\\Other\\main.py'), undefined);
    assert.equal(m.localToRel(WINDOWS.unc), undefined);
  });

  it('refuses names Windows cannot create', () => {
    for (const bad of ['con.py', 'NUL', 'lib/aux.txt', 'com1.py', 'LPT9', 'a:b.py', 'what?.py', 'dir./x.py', 'trail /x.py', 'q"uote.py', 'pipe|.py']) {
      assert.throws(() => m.relToLocal(bad), PathError, bad);
    }
    assert.equal(relPathProblem('my notes.py', { windows: true }), undefined);
    assert.equal(relPathProblem('console.py', { windows: true }), undefined);
    assert.equal(relPathProblem('comm.py', { windows: true }), undefined);
  });

  it('flags paths that are too long for Windows tools', () => {
    const deep = `${WINDOWS.workspace}\\${'x'.repeat(240)}\\a.py`;
    assert.equal(m.tooLongForWindows(deep), true);
    assert.equal(m.tooLongForWindows(WINDOWS.mainPy), false);
    assert.equal(new PathMapper(MACOS_ONEDRIVE_WORKSPACE, '/', path.posix).tooLongForWindows(deep), false);
  });
});

describe('name rules', () => {
  it('names the problem in English for a student', () => {
    assert.match(describeProblem('windows-reserved', 'con.py'), /reserved name on Windows/);
    assert.match(describeProblem('backslash', 'a\\b'), /backslash/);
    assert.match(describeProblem('traversal', '../x'), /leave the project folder/);
  });

  it('rejects backslashes, control characters, dot segments and over-long names on every host', () => {
    assert.equal(segmentProblem('a\\b.py', { windows: false }), 'backslash');
    assert.equal(segmentProblem('a\nb.py', { windows: false }), 'control-char');
    assert.equal(segmentProblem('..', { windows: false }), 'traversal');
    assert.equal(segmentProblem('.', { windows: false }), 'dot-segment');
    assert.equal(segmentProblem('x'.repeat(256), { windows: false }), 'too-long');
    assert.equal(segmentProblem('\u00e9'.repeat(130), { windows: false }), 'too-long'); // two bytes each in UTF-8
    assert.equal(segmentProblem('\u00e9'.repeat(100), { windows: false }), undefined);
  });
});

describe('collisions and normalisation', () => {
  it('detects names that differ only by case on a case-insensitive host', () => {
    assert.deepEqual(findCollisions(['Main.py', 'main.py', 'other.py'], { caseInsensitive: true }), [['Main.py', 'main.py']]);
    assert.deepEqual(findCollisions(['Main.py', 'main.py'], { caseInsensitive: false }), []);
  });

  it('treats NFC and NFD spellings of the same name as one file (macOS)', () => {
    const composed = 'caf\u00e9.py';
    const decomposed = 'cafe\u0301.py';
    assert.notEqual(composed, decomposed);
    assert.equal(nfc(decomposed), composed);
    assert.equal(matchKey(decomposed, false), matchKey(composed, false));
    assert.equal(findCollisions([composed, decomposed], { caseInsensitive: false }).length, 1);
  });
});

describe('shadow guard', () => {
  const guard = { names: ['alpha', 'Beta_mod'], roots: importRootsFrom(['', '.frozen', '/lib', '/flash', '/flash/lib/']) };

  it('lists the import roots from sys.path', () => {
    assert.deepEqual([...guard.roots].sort(), ['/', '/flash', '/flash/lib', '/lib']);
  });

  it('finds files and folders that would hide a module, ignoring case', () => {
    assert.equal(shadowedModule('/alpha.py', guard), 'alpha');
    assert.equal(shadowedModule('/lib/ALPHA.mpy', guard), 'alpha');
    assert.equal(shadowedModule('/lib/alpha/__init__.py', guard), 'alpha');
    assert.equal(shadowedModule('/flash/beta_mod.py', guard), 'Beta_mod');
  });

  it('leaves other names alone', () => {
    assert.equal(shadowedModule('/main.py', guard), undefined);
    assert.equal(shadowedModule('/data/alpha.py', guard), undefined);
    assert.equal(shadowedModule('/alpha_extra.py', guard), undefined);
    assert.equal(shadowedModule('/alpha.py', { names: [], roots: ['/'] }), undefined);
  });
});
