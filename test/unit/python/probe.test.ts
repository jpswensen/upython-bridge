/**
 * The probe: classification of every way a "python" can fail, plus REAL runs of the probe (a real interpreter, a missing program,
 * a hanging program, a launcher script in a folder with spaces, parentheses and non-ASCII). Platform helpers are tested here too.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { classifyCloudPath, expandGlob, expandVariables, samePath, whichInPath } from '../../../src/python/platform';
import { classifyProbe, nodeExec, probeInterpreter, type ExecResult } from '../../../src/python/probe';
import { TempDirs, makeTrickyDir } from '../../mocks/fixtures';
import { integrationSkipReason, testPython } from '../../mocks/fakeBridge';
import { MemoryLog } from '../bridge/stubChild';
import { FakeFs, MAC, WIN, probeOk } from './fakes';

const dirs = new TempDirs();
afterEach(() => dirs.cleanup());

const res = (over: Partial<ExecResult>): ExecResult => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...over });

describe('classifyProbe', () => {
  it('accepts a normal answer and the last JSON line (other output before it is ignored)', () => {
    const r = classifyProbe(res({ stdout: `banner from sitecustomize\n${probeOk('/p/python', [3, 12, 1]).stdout}` }), 'darwin');
    assert.ok(r.ok && r.info.version[1] === 12 && r.info.executable === '/p/python');
  });

  it('keeps a non-ASCII executable path intact (the probe prints ASCII-escaped JSON)', () => {
    const exe = 'C:\\Users\\J\u00fcrgen \u4e2d\\py\\python.exe';
    const r = classifyProbe(res({ stdout: `${JSON.stringify({ executable: exe, version: [3, 13, 0], implementation: 'cpython' })}\n` }), 'win32');
    assert.ok(r.ok && r.info.executable === exe);
  });

  it('names each failure with something a student can act on', () => {
    const table: [Partial<ExecResult>, NodeJS.Platform, string, RegExp][] = [
      [{ error: { code: 'ENOENT', message: 'x' } }, 'darwin', 'not-found', /does not exist/],
      [{ error: { code: 'EACCES', message: 'x' } }, 'win32', 'not-executable', /security policy/],
      [{ error: { code: 'EMFILE', message: 'too many' } }, 'linux', 'failed', /too many/],
      [{ timedOut: true, code: null }, 'darwin', 'timeout', /antivirus/i],
      [{ code: 9009, stderr: 'whatever' }, 'win32', 'store-stub', /python\.org/],
      [{ code: 1, stderr: 'Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut' }, 'win32', 'store-stub', /Store/],
      [{ code: 0, stdout: '' }, 'win32', 'store-stub', /printed nothing/],
      [{ code: 0, stdout: '' }, 'darwin', 'bad-output', /printed nothing/],
      [{ code: 1, stderr: 'xcode-select: note: No developer tools were found, requesting install.' }, 'darwin', 'macos-clt-shim', /developer tools/],
      [{ code: 1, stderr: 'Fatal Python error: init_fs_encoding\nmore' }, 'linux', 'failed', /Fatal Python error/],
      [{ code: 0, stdout: 'not json at all' }, 'linux', 'bad-output', /expected form|could not be read/],
      [{ code: 0, stdout: '{"executable":1}' }, 'linux', 'bad-output', /expected form/],
      [{ code: 0, stdout: probeOk('/p', [3, 8, 18]).stdout }, 'linux', 'too-old', /3\.8\.18.*3\.9 or newer/],
    ];
    for (const [over, platform, kind, re] of table) {
      const r = classifyProbe(res(over), platform);
      assert.ok(!r.ok && r.kind === kind && re.test(r.message), `${kind}: ${JSON.stringify(r)}`);
    }
  });
});

describe('probeInterpreter', () => {
  it('builds argv as [prefix..., -I, -c, <probe>] and retries one timeout', async () => {
    const seen: string[][] = [];
    const out = await probeInterpreter({ command: 'py', prefixArgs: ['-3'] }, async (_c, args) => { seen.push([...args]); return seen.length === 1 ? res({ timedOut: true }) : probeOk('/p'); }, { platform: 'win32' });
    assert.ok(out.ok);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0]?.slice(0, 3), ['-3', '-I', '-c']);
  });
});

describe('real probe runs', () => {
  const skip = integrationSkipReason();

  it('probes a real interpreter and finds its version, program and implementation', { skip }, async () => {
    const python = testPython();
    assert.ok(python);
    const log = new MemoryLog();
    const out = await probeInterpreter({ command: python, prefixArgs: [] }, nodeExec(log.logger), { platform: process.platform, timeoutMs: 15000 });
    assert.ok(out.ok, JSON.stringify(out));
    assert.ok(out.info.version[0] === 3 && out.info.version[1] >= 9);
    assert.equal(out.info.implementation, 'cpython');
    assert.ok(path.isAbsolute(out.info.executable));
  });

  it('reports a program that does not exist as not-found', async () => {
    const out = await probeInterpreter({ command: path.join(dirs.make(), 'no-such-python'), prefixArgs: [] }, nodeExec(new MemoryLog().logger), { platform: process.platform });
    assert.ok(!out.ok && out.kind === 'not-found');
  });

  it('kills a program that hangs and reports a timeout', { skip: process.platform === 'win32' ? 'POSIX shell script fixture' : false }, async () => {
    const dir = dirs.make();
    const script = path.join(dir, 'slowpython');
    fs.writeFileSync(script, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const started = Date.now();
    const out = await probeInterpreter({ command: script, prefixArgs: [] }, nodeExec(new MemoryLog().logger), { platform: process.platform, timeoutMs: 300, retryOnTimeout: false });
    assert.ok(!out.ok && out.kind === 'timeout');
    assert.ok(Date.now() - started < 5000);
  });

  it('runs a launcher that lives in a folder with spaces, parentheses and non-ASCII (argv array, no shell)', { skip: skip || (process.platform === 'win32' ? 'POSIX shell script fixture' : false) }, async () => {
    const python = testPython();
    assert.ok(python);
    const folder = makeTrickyDir(dirs.make());
    const script = path.join(folder, 'my python (3)');
    fs.writeFileSync(script, `#!/bin/sh\nexec "${python}" "$@"\n`, { mode: 0o755 });
    const out = await probeInterpreter({ command: script, prefixArgs: [] }, nodeExec(new MemoryLog().logger), { platform: process.platform, timeoutMs: 15000 });
    assert.ok(out.ok, JSON.stringify(out));
  });
});

describe('platform helpers', () => {
  it('expands the variables of the pythonPath setting and refuses unknown ones', () => {
    assert.deepEqual(expandVariables('${workspaceFolder}/.venv/bin/python', '/w/Lab 1', MAC), { ok: true, value: '/w/Lab 1/.venv/bin/python' });
    assert.deepEqual(expandVariables('~/py', null, MAC), { ok: true, value: '/Users/student/py' });
    assert.deepEqual(expandVariables('${workspaceFolder}\\.venv\\Scripts\\python.exe', 'C:\\Lab (1)', WIN), { ok: true, value: 'C:\\Lab (1)\\.venv\\Scripts\\python.exe' });
    assert.deepEqual(expandVariables('${userHome}${pathSeparator}p', null, WIN), { ok: true, value: 'C:\\Users\\Student Name\\p' });
    const bad = expandVariables('${workspaceFolder}/x', null, MAC);
    assert.ok(!bad.ok && /no folder is open/.test(bad.reason));
    assert.ok(!expandVariables('${what}', '/w', MAC).ok);
  });

  it('finds a program on PATH like `which` (Windows: PATHEXT, quoted entries, first hit wins)', async () => {
    const fs1 = new FakeFs('posix').add('/usr/bin/python3', '/opt/homebrew/bin/python3');
    assert.equal(await whichInPath('python3', MAC, fs1), '/opt/homebrew/bin/python3');
    assert.equal(await whichInPath('nothing', MAC, fs1), null);
    const fs2 = new FakeFs('win32').add('C:\\Windows\\py.exe');
    assert.equal(await whichInPath('py', { ...WIN, env: { ...WIN.env, PATH: '"C:\\Other";"C:\\Windows"' } }, fs2), 'C:\\Windows\\py.exe');
  });

  it('globs one segment at a time, newest first, and only returns files', async () => {
    const f = new FakeFs('win32').add('C:\\Py\\Python39\\python.exe', 'C:\\Py\\Python312\\python.exe', 'C:\\Py\\Python313\\python.exe', 'C:\\Py\\Python313\\Lib\\x.py');
    assert.deepEqual(await expandGlob('C:\\Py\\Python3*\\python.exe', WIN, f), ['C:\\Py\\Python313\\python.exe', 'C:\\Py\\Python312\\python.exe', 'C:\\Py\\Python39\\python.exe']);
    assert.deepEqual(await expandGlob('C:\\Py\\Missing*\\python.exe', WIN, f), []);
  });

  it('recognises cloud-synced folders by their names, on both path styles (RQ-CLOUD-2)', () => {
    const cases: [string, string | null][] = [
      ['/Users/s/Library/CloudStorage/OneDrive-Example University(email.example.edu)/Lab Course (Fall)/.venv/bin/python', 'OneDrive'],
      ['C:\\Users\\Student Name\\OneDrive - Example University\\Documents\\Lab\\python.exe', 'OneDrive'],
      ['/Users/s/Library/CloudStorage/GoogleDrive-x/My Drive/p', 'Google Drive'],
      ['/Users/s/Library/Mobile Documents/com~apple~CloudDocs/p', 'iCloud Drive'],
      ['/Users/s/Dropbox/lab/python', 'Dropbox'],
      ['/Users/s/Library/CloudStorage/Box-Box/x', 'a cloud storage folder (CloudStorage)'],
      ['/opt/homebrew/bin/python3', null],
      ['C:\\Program Files\\Python313\\python.exe', null],
    ];
    for (const [p, expected] of cases) {
      assert.equal(classifyCloudPath(p), expected, p);
    }
  });

  it('compares paths case-insensitively on Windows only', () => {
    assert.ok(samePath('C:\\Users\\X\\python.exe', 'c:\\users\\x\\PYTHON.EXE', WIN));
    assert.ok(!samePath('/a/Python', '/a/python', MAC));
  });
});
