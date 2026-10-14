/**
 * Interpreter discovery with injected file system, platform and exec: order, validation by running a probe, the explicit setting
 * that is never silently skipped, virtual environments (both layouts, trust), Windows `py -3`, Store and macOS shims, Thonny and
 * PlatformIO, version policy, cache with single flight and invalidation. Windows facts are injected strings.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PythonDiscovery, noPythonError, type DiscoveryContext, type ToolingResult } from '../../../src/python/discovery';
import { PROBE_CODE } from '../../../src/python/probe';
import { settingId } from '../../../src/identity';
import { MACOS_ONEDRIVE_WORKSPACE, WINDOWS } from '../../mocks/fixtures';
import { MemoryLog } from '../bridge/stubChild';
import { ENOENT, FakeFs, MAC, WIN, probeCalls, probeOk, scriptedExec } from './fakes';

const ctx = (over: Partial<DiscoveryContext> = {}): (() => DiscoveryContext) => () => ({ folder: null, trusted: true, pythonPathSetting: '', ...over });

function make(opts: { platform: typeof MAC; fs: FakeFs; rules: Parameters<typeof scriptedExec>[0]; context?: () => DiscoveryContext; hints?: () => Promise<ToolingResult>; now?: () => number }) {
  const { exec, calls } = scriptedExec(opts.rules);
  const log = new MemoryLog();
  const disc = new PythonDiscovery({ platform: opts.platform, fs: opts.fs, exec, context: opts.context ?? ctx(), hints: opts.hints, log: log.logger, now: opts.now });
  return { disc, calls, log };
}

describe('order and validation (macOS facts)', () => {
  it('runs `python -I -c <probe>` for the candidate and uses the program it reports', async () => {
    const fs = new FakeFs('posix').add('/opt/homebrew/bin/python3');
    const { disc, calls } = make({ platform: MAC, fs, rules: { '/opt/homebrew/bin/python3': probeOk('/opt/homebrew/Cellar/python@3.13/bin/python3.13') } });
    const r = await disc.resolve();
    assert.equal(r.chosen?.executable, '/opt/homebrew/Cellar/python@3.13/bin/python3.13');
    assert.equal(r.chosen?.launcher.command, '/opt/homebrew/bin/python3');
    assert.equal(r.chosen?.untested, false);
    assert.deepEqual(calls[0]?.args, ['-I', '-c', PROBE_CODE]);
    assert.ok(r.rejected.some((x) => x.kind === 'not-found' && x.command === 'python'), 'python missing on PATH is recorded, not hidden');
  });

  it('prefers a working workspace .venv over python3 on PATH, in a folder with spaces, parentheses and non-ASCII', async () => {
    const folder = MACOS_ONEDRIVE_WORKSPACE;
    const fs = new FakeFs('posix').add(`${folder}/.venv/pyvenv.cfg`, `${folder}/.venv/bin/python`, '/opt/homebrew/bin/python3');
    const { disc, calls } = make({
      platform: MAC, fs, context: ctx({ folder }),
      rules: { [`${folder}/.venv/bin/python`]: probeOk(`${folder}/.venv/bin/python`, [3, 13, 13]), '/opt/homebrew/bin/python3': probeOk('/opt/homebrew/bin/python3') },
    });
    const r = await disc.resolve();
    assert.equal(r.chosen?.source, 'workspace-venv');
    assert.equal(r.chosen?.launcher.command, `${folder}/.venv/bin/python`);
    assert.equal(probeCalls(calls).length, 1, 'stops at the first working candidate');
  });

  it('skips a virtual environment in an untrusted folder and says why', async () => {
    const f = '/Users/student/proj';
    const fs = new FakeFs('posix').add(`${f}/.venv/pyvenv.cfg`, `${f}/.venv/bin/python`, '/opt/homebrew/bin/python3');
    const { disc, calls } = make({ platform: MAC, fs, context: ctx({ folder: f, trusted: false }), rules: { '/opt/homebrew/bin/python3': probeOk('/opt/homebrew/bin/python3') } });
    const r = await disc.resolve();
    assert.equal(r.chosen?.source, 'path');
    const rej = r.rejected.find((x) => x.kind === 'untrusted');
    assert.ok(rej && /trust/i.test(rej.message));
    assert.ok(!calls.some((c) => c.command === `${f}/.venv/bin/python`), 'the untrusted venv was never run');
  });

  it('reports a venv made on Windows (Scripts folder) and a plain "env" folder is not mistaken for a venv', async () => {
    const f = '/Users/student/proj';
    const fs = new FakeFs('posix').add(`${f}/.venv/pyvenv.cfg`, `${f}/.venv/Scripts/python.exe`, `${f}/env/readme.txt`, '/opt/homebrew/bin/python3');
    const { disc } = make({ platform: MAC, fs, context: ctx({ folder: f }), rules: { '/opt/homebrew/bin/python3': probeOk('/opt/homebrew/bin/python3') } });
    const r = await disc.resolve();
    const wrong = r.rejected.find((x) => x.kind === 'wrong-os');
    assert.ok(wrong && /Windows/.test(wrong.message) && /delete/i.test(wrong.message));
    assert.ok(!r.rejected.some((x) => x.command.endsWith('/env')), 'a folder named env without pyvenv.cfg is ignored');
    assert.equal(r.chosen?.source, 'path');
  });

  it('reports a venv whose python link points at a program that is not installed here', async () => {
    const f = '/Users/student/proj';
    const fs = new FakeFs('posix').add(`${f}/venv/pyvenv.cfg`);
    fs.dangling.add(`${f}/venv/bin/python`);
    const { disc } = make({ platform: MAC, fs, context: ctx({ folder: f }), rules: {} });
    const r = await disc.resolve();
    assert.ok(r.rejected.some((x) => x.kind === 'broken-venv'));
  });

  it('does not start the macOS /usr/bin shim unless the Command Line Tools exist', async () => {
    const fs = new FakeFs('posix').add('/usr/bin/python3');
    const platform = { ...MAC, env: { PATH: '/usr/bin:/bin' } };
    const without = make({ platform, fs, rules: { 'xcode-select': { code: 2, signal: null, stdout: '', stderr: 'xcode-select: error: unable to get active developer directory', timedOut: false }, '/usr/bin/python3': probeOk('/usr/bin/python3', [3, 9, 6]) } });
    const r1 = await without.disc.resolve();
    assert.equal(r1.chosen, null);
    assert.ok(r1.rejected.some((x) => x.kind === 'macos-clt-shim'));
    assert.ok(!without.calls.some((c) => c.command === '/usr/bin/python3'), 'the shim was never spawned');
    const withTools = make({ platform, fs, rules: { 'xcode-select': { code: 0, signal: null, stdout: '/Library/Developer/CommandLineTools\n', stderr: '', timedOut: false }, '/usr/bin/python3': probeOk('/Library/Developer/CommandLineTools/usr/bin/python3', [3, 9, 6]) } });
    const r2 = await withTools.disc.resolve();
    assert.equal(r2.chosen?.versionText, '3.9.6');
    assert.equal(r2.chosen?.untested, true, 'works, but below the tested range');
  });

  it('rejects Python below 3.9 (with advice) and warns "untested" for 3.9 to 3.11', async () => {
    const fs = new FakeFs('posix').add('/opt/homebrew/bin/python3');
    const old = make({ platform: MAC, fs, rules: { '/opt/homebrew/bin/python3': probeOk('/x/python', [3, 8, 10]) } });
    const r = await old.disc.resolve();
    assert.equal(r.chosen, null);
    assert.equal(r.failure?.kind, 'too-old');
    assert.match(r.failure?.message ?? '', /3\.8\.10/);
    assert.match(r.failure?.hint ?? '', /python\.org/);
    const mid = make({ platform: MAC, fs, rules: { '/opt/homebrew/bin/python3': probeOk('/x/python', [3, 11, 4]) } });
    assert.equal((await mid.disc.resolve()).chosen?.untested, true);
    const current = make({ platform: MAC, fs, rules: { '/opt/homebrew/bin/python3': probeOk('/x/python', [3, 15, 0]) } });
    assert.equal((await current.disc.resolve()).chosen?.untested, false);
  });

  it('finds Thonny\'s bundled Python (globbed versions, config scripts skipped) and PlatformIO\'s when nothing else exists', async () => {
    const base = '/Applications/Thonny.app/Contents/Frameworks/Python.framework/Versions';
    const fs = new FakeFs('posix').add(`${base}/3.10/bin/python3`, `${base}/3.10/bin/python3.10`, `${base}/3.10/bin/python3.10-config`, '/Users/student/.platformio/penv/bin/python');
    const { disc, calls } = make({
      platform: { ...MAC, env: { PATH: '/bin' } }, fs,
      rules: { [`${base}/3.10/bin/python3`]: probeOk(`${base}/3.10/bin/python3.10`, [3, 10, 11]), '/Users/student/.platformio/penv/bin/python': probeOk('/pio/python', [3, 12, 1]) },
    });
    const r = await disc.resolve({ exhaustive: true });
    assert.equal(r.chosen?.source, 'thonny');
    assert.ok(!calls.some((c) => c.command.endsWith('-config')));
    assert.equal(r.alternatives[0]?.source, 'platformio', 'exhaustive mode lists the other working Pythons');
  });

  it('marks the same program found twice as a duplicate (exhaustive)', async () => {
    const fs = new FakeFs('posix').add('/opt/homebrew/bin/python3', '/usr/local/bin/python3');
    const { disc } = make({
      platform: MAC, fs,
      rules: { '/opt/homebrew/bin/python3': probeOk('/real/python3.13'), '/usr/local/bin/python3': probeOk('/real/python3.13') },
    });
    const r = await disc.resolve({ exhaustive: true });
    assert.ok(r.rejected.some((x) => x.kind === 'duplicate'));
    assert.equal(r.alternatives.length, 0);
  });
});

describe('the explicit setting', () => {
  const S = settingId('pythonPath');

  it('is tried first, with ${workspaceFolder} expanded, and wins over everything else', async () => {
    const f = '/Users/student/My Lab (Fall)/\u00dcbung';
    const fs = new FakeFs('posix').add(`${f}/.venv/bin/python`, '/opt/homebrew/bin/python3');
    const { disc, calls } = make({
      platform: MAC, fs, context: ctx({ folder: f, pythonPathSetting: '${workspaceFolder}/.venv/bin/python' }),
      rules: { [`${f}/.venv/bin/python`]: probeOk(`${f}/.venv/bin/python`), '/opt/homebrew/bin/python3': probeOk('/opt/homebrew/bin/python3') },
    });
    const r = await disc.resolve();
    assert.equal(r.chosen?.source, 'setting');
    assert.equal(r.chosen?.launcher.command, `${f}/.venv/bin/python`);
    assert.equal(probeCalls(calls).length, 1);
  });

  it('expands ~, relative paths and environment variables', async () => {
    const fs = new FakeFs('posix').add('/Users/student/py/bin/python3', '/Users/student/proj/rel/python', '/opt/x/python');
    for (const [value, exe] of [['~/py/bin/python3', '/Users/student/py/bin/python3'], ['rel/python', '/Users/student/proj/rel/python'], ['${env:MYPY}', '/opt/x/python']] as const) {
      const { disc } = make({
        platform: { ...MAC, env: { ...MAC.env, MYPY: '/opt/x/python' } }, fs, context: ctx({ folder: '/Users/student/proj', pythonPathSetting: value }),
        rules: { [exe]: probeOk(exe) },
      });
      assert.equal((await disc.resolve()).chosen?.launcher.command, exe, value);
    }
  });

  it('is never silently skipped: a wrong value stops discovery and explains why, without trying anything else', async () => {
    const fs = new FakeFs('posix').add('/opt/homebrew/bin/python3');
    const { disc, calls } = make({
      platform: MAC, fs, context: ctx({ folder: '/Users/student/proj', pythonPathSetting: '${workspaceFolder}/.venvv/bin/python' }),
      rules: { '/opt/homebrew/bin/python3': probeOk('/opt/homebrew/bin/python3') },
    });
    const r = await disc.resolve();
    assert.equal(r.chosen, null);
    assert.equal(r.failure?.kind, 'setting-invalid');
    assert.ok((r.failure?.message ?? '').includes(S));
    assert.match(r.failure?.message ?? '', /\.venvv/);
    assert.match(r.failure?.hint ?? '', /clear it/);
    assert.equal(calls.length, 0, 'nothing was run');
    assert.equal(r.rejected[0]?.kind, 'setting-invalid');
    const err = noPythonError(r);
    assert.equal(err.code, 'E_NO_PYTHON');
    assert.ok(err.hint.length > 0 && err.detail.includes('setting-invalid'));
  });

  it('stops when the file exists but does not run as Python', async () => {
    const fs = new FakeFs('posix').add('/usr/local/bin/notpython', '/opt/homebrew/bin/python3');
    const { disc } = make({
      platform: MAC, fs, context: ctx({ pythonPathSetting: '/usr/local/bin/notpython' }),
      rules: { '/usr/local/bin/notpython': { code: 1, signal: null, stdout: '', stderr: 'Segmentation fault\n', timedOut: false }, '/opt/homebrew/bin/python3': probeOk('/p') },
    });
    const r = await disc.resolve();
    assert.equal(r.chosen, null);
    assert.equal(r.failure?.kind, 'setting-invalid');
    assert.match(r.failure?.message ?? '', /Segmentation fault/);
  });

  it('explains a Windows path on macOS, a folder instead of a program, an unknown variable and a missing PATH name', async () => {
    const fs = new FakeFs('posix').add('/Users/student/proj/.venv/bin/python');
    const cases: [string, RegExp][] = [
      ['C:\\Users\\x\\python.exe', /Windows path/],
      ['/Users/student/proj/.venv', /is a folder/],
      ['${nonsense}/python', /not a variable/],
      ['python9', /not found on PATH/],
      ['${env:NOPE_NOT_SET}/py', /not set/],
    ];
    for (const [value, re] of cases) {
      const { disc } = make({ platform: MAC, fs, context: ctx({ folder: '/Users/student/proj', pythonPathSetting: value }), rules: {} });
      const r = await disc.resolve();
      assert.equal(r.failure?.kind, 'setting-invalid', value);
      assert.match(r.failure?.message ?? '', re, value);
    }
  });
});

describe('Windows facts (injected)', () => {
  it('runs `py -3` as an argv array and then uses the real program it opened', async () => {
    const py = 'C:\\Windows\\py.exe';
    const real = WINDOWS.python;
    const fs = new FakeFs('win32').add(py);
    const { disc, calls } = make({ platform: WIN, fs, rules: { [py]: (args) => (args[0] === '-3' ? probeOk(real) : ENOENT) } });
    const r = await disc.resolve();
    assert.equal(r.chosen?.source, 'py-launcher');
    assert.deepEqual(calls[0], { command: py, args: ['-3', '-I', '-c', PROBE_CODE] });
    assert.deepEqual(r.chosen?.launcher, { command: real, prefixArgs: [] }, 'py is only a doorway');
  });

  it('rejects the Microsoft Store shortcut (exit 9009 / empty output) and falls through to a real install, newest first', async () => {
    const alias = 'C:\\Users\\Student Name\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe';
    const base = 'C:\\Users\\Student Name\\AppData\\Local\\Programs\\Python';
    const fs = new FakeFs('win32').add(alias, `${base}\\Python312\\python.exe`, `${base}\\Python313\\python.exe`);
    const stub = { code: 9009, signal: null, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store', timedOut: false };
    const { disc, calls } = make({
      platform: WIN, fs,
      rules: { [alias]: stub, [`${base}\\Python313\\python.exe`]: probeOk(`${base}\\Python313\\python.exe`), [`${base}\\Python312\\python.exe`]: probeOk('x') },
    });
    const r = await disc.resolve();
    assert.ok(r.rejected.some((x) => x.kind === 'store-stub' && /python\.org/.test(x.message)));
    assert.equal(r.chosen?.launcher.command, `${base}\\Python313\\python.exe`);
    assert.ok(!calls.some((c) => c.command === `${base}\\Python312\\python.exe`), 'Python313 comes before Python312');
    const empty = make({ platform: WIN, fs: new FakeFs('win32').add(alias), rules: { [alias]: { code: 0, signal: null, stdout: '', stderr: '', timedOut: false } } });
    const r2 = await empty.disc.resolve();
    assert.equal(r2.failure?.kind, 'store-stub');
    assert.match(r2.failure?.hint ?? '', /Add python\.exe to PATH/);
  });

  it('uses Scripts\\python.exe for a venv under a OneDrive-style folder, and reports one built on macOS (bin folder)', async () => {
    const f = WINDOWS.workspace;
    const fs = new FakeFs('win32').add(`${f}\\.venv\\pyvenv.cfg`, `${f}\\.venv\\Scripts\\python.exe`, `${f}\\venv\\pyvenv.cfg`, `${f}\\venv\\bin\\python`);
    const { disc } = make({ platform: WIN, fs, context: ctx({ folder: f }), rules: { [`${f}\\.venv\\Scripts\\python.exe`]: probeOk(`${f}\\.venv\\Scripts\\python.exe`) } });
    const r = await disc.resolve({ exhaustive: true });
    assert.equal(r.chosen?.launcher.command, `${f}\\.venv\\Scripts\\python.exe`);
    const wrong = r.rejected.find((x) => x.kind === 'wrong-os');
    assert.ok(wrong && /macOS or Linux/.test(wrong.message));
  });

  it('knows a Windows path in the setting and a "py -3" value; Thonny and PlatformIO have Windows places', async () => {
    const thonny = 'C:\\Users\\Student Name\\AppData\\Local\\Programs\\Thonny\\python.exe';
    const pio = 'C:\\Users\\Student Name\\.platformio\\penv\\Scripts\\python.exe';
    const fs = new FakeFs('win32').add(thonny, pio, 'C:\\Windows\\py.exe');
    const a = make({ platform: WIN, fs, context: ctx({ pythonPathSetting: `"${thonny}"` }), rules: { [thonny]: probeOk(thonny, [3, 10, 11]) } });
    assert.equal((await a.disc.resolve()).chosen?.source, 'setting', 'quotes are stripped');
    const b = make({ platform: WIN, fs, context: ctx({ pythonPathSetting: 'py -3.12' }), rules: { 'C:\\Windows\\py.exe': (args) => (args[0] === '-3.12' ? probeOk('C:\\P312\\python.exe', [3, 12, 4]) : ENOENT) } });
    assert.equal((await b.disc.resolve()).chosen?.executable, 'C:\\P312\\python.exe');
    const c = make({ platform: { ...WIN, env: { ...WIN.env, PATH: 'C:\\Nothing' } }, fs, rules: { [thonny]: probeOk(thonny, [3, 10, 11]), [pio]: probeOk(pio, [3, 12, 0]) } });
    const r = await c.disc.resolve({ exhaustive: true });
    assert.deepEqual([r.chosen?.source, r.alternatives[0]?.source], ['thonny', 'platformio']);
    const d = make({ platform: WIN, fs, context: ctx({ pythonPathSetting: '/usr/bin/python3' }), rules: {} });
    assert.match((await d.disc.resolve()).failure?.message ?? '', /macOS or Linux path/);
  });
});

describe('Python tooling hints (Environments extension, Python extension)', () => {
  it('tries the Environments selection, then the Python extension\'s, before the folder venv; notes a disagreement', async () => {
    const f = '/Users/student/proj';
    const fs = new FakeFs('posix').add('/envs/python', '/pyext/python', `${f}/.venv/pyvenv.cfg`, `${f}/.venv/bin/python`);
    const { disc, calls } = make({
      platform: MAC, fs, context: ctx({ folder: f }),
      hints: async () => ({ hints: [{ source: 'python-api', path: '/pyext/python' }, { source: 'envs-api', path: '/envs/python' }], notes: [] }),
      rules: { '/envs/python': probeOk('/envs/python') },
    });
    const r = await disc.resolve();
    assert.equal(r.chosen?.source, 'envs-api');
    assert.ok(r.notes.some((n) => /disagree/.test(n)));
    assert.equal(probeCalls(calls).length, 1);
  });

  it('survives hints that fail or are not full paths, and keeps their notes', async () => {
    const fs = new FakeFs('posix').add('/opt/homebrew/bin/python3');
    const bad = make({ platform: MAC, fs, hints: async () => { throw new Error('API exploded'); }, rules: { '/opt/homebrew/bin/python3': probeOk('/p') } });
    const r1 = await bad.disc.resolve();
    assert.equal(r1.chosen?.source, 'path');
    assert.ok(r1.notes.some((n) => /API exploded/.test(n)));
    const bare = make({ platform: MAC, fs, hints: async () => ({ hints: [{ source: 'python-api', path: 'python' }], notes: ['not ready'] }), rules: { '/opt/homebrew/bin/python3': probeOk('/p') } });
    const r2 = await bare.disc.resolve();
    assert.ok(r2.notes.includes('not ready') && r2.notes.some((n) => /not a full path/.test(n)));
  });
});

describe('cache, single flight, invalidation', () => {
  const fs = new FakeFs('posix').add('/opt/homebrew/bin/python3');

  it('answers 5 concurrent callers with one resolution, then from the cache until invalidated', async () => {
    const { disc, calls } = make({ platform: MAC, fs, rules: { '/opt/homebrew/bin/python3': probeOk('/p') } });
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => disc.resolve()));
    assert.ok(all.every((r) => r === all[0]));
    assert.equal(probeCalls(calls).length, 1);
    await disc.resolve();
    assert.equal(probeCalls(calls).length, 1, 'served from the cache');
    disc.invalidate();
    await disc.resolve();
    assert.equal(probeCalls(calls).length, 2);
  });

  it('looks again when a setting, the trust state or the folder changes, or the cached program disappeared', async () => {
    let setting = '';
    let trusted = true;
    const f2 = new FakeFs('posix').add('/opt/homebrew/bin/python3', '/x/py');
    const { disc, calls } = make({
      platform: MAC, fs: f2, context: () => ({ folder: null, trusted, pythonPathSetting: setting }),
      rules: { '/opt/homebrew/bin/python3': probeOk('/opt/homebrew/bin/python3'), '/x/py': probeOk('/x/py') },
    });
    await disc.resolve();
    setting = '/x/py';
    assert.equal((await disc.resolve()).chosen?.source, 'setting');
    trusted = false;
    await disc.resolve();
    assert.equal(probeCalls(calls).length, 3);
    setting = '';
    trusted = true;
    f2.remove('/opt/homebrew/bin/python3');
    await disc.resolve();
    const before = probeCalls(calls).length;
    f2.add('/opt/homebrew/bin/python3');
    f2.remove('/x/py');
    await disc.resolve();
    assert.ok(probeCalls(calls).length >= before, 'no error when files come and go');
  });

  it('never serves a failure to a user action, but a background caller may see one up to 3 s old', async () => {
    let t = 1000;
    const empty = new FakeFs('posix');
    const { disc, calls } = make({ platform: MAC, fs: empty, rules: { 'xcode-select': ENOENT }, now: () => t });
    await disc.resolve();
    const calls1 = calls.length;
    await disc.resolve({ background: true });
    assert.equal(calls.length, calls1, 'background: cached failure');
    t += 2000;
    await disc.resolve({ background: true });
    assert.equal(calls.length, calls1, 'still fresh at 2 s');
    t += 2000;
    empty.add('/opt/homebrew/bin/python3');
    const { exec } = scriptedExec({ '/opt/homebrew/bin/python3': probeOk('/p') });
    assert.ok(exec);
    const user = await disc.resolve(); // user action: probes again (the file now exists but exec still says ENOENT -> still a failure, but it LOOKED)
    assert.equal(user.chosen, null);
    assert.ok(user.rejected.some((x) => x.command === '/opt/homebrew/bin/python3'));
  });

  it('retries a probe that timed out once, and reports a second timeout as a timeout, not as "not found"', async () => {
    const timeout = { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true };
    const { disc, calls } = make({ platform: MAC, fs, rules: { '/opt/homebrew/bin/python3': timeout } });
    const r = await disc.resolve();
    assert.equal(probeCalls(calls).filter((c) => c.command === '/opt/homebrew/bin/python3').length, 2);
    assert.ok(r.rejected.some((x) => x.kind === 'timeout' && /antivirus/i.test(x.message)));
  });
});
