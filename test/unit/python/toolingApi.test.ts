/**
 * The VS Code side of discovery against the vscode mock: the two Python APIs as hints (timeouts are "not ready", never "no
 * Python"), and the events that drop a cached result.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { settingId } from '../../../src/identity';
import { PythonDiscovery } from '../../../src/python/discovery';
import {
  ENVS_EXTENSION_ID, PYTHON_EXTENSION_ID, ToolingHintSource, pathOfEnvsEnvironment, pathOfPythonApi, watchDiscoveryInputs,
} from '../../../src/python/toolingApi';
import { mock } from '../../mocks/vscode';
import { MemoryLog } from '../bridge/stubChild';
import { FakeFs, MAC, probeOk, scriptedExec } from './fakes';

beforeEach(() => mock.reset());
afterEach(() => mock.reset());

function install(id: string, api: unknown, activate?: () => Promise<unknown>): void {
  mock.addExtension(id, {}, true);
  const ext = mock.extensions.get(id.toLowerCase());
  assert.ok(ext);
  ext.exports = api;
  ext.activate = activate ?? (async () => api);
}

describe('the answer shapes', () => {
  it('reads the Environments API (executable first; an environment folder is not a program) and the Python API (no placeholders)', () => {
    assert.equal(pathOfEnvsEnvironment({ execInfo: { run: { executable: '/e/bin/python' } } }), '/e/bin/python');
    assert.equal(pathOfEnvsEnvironment({ environmentPath: { fsPath: '/e/bin/python3.13' } }), '/e/bin/python3.13');
    assert.equal(pathOfEnvsEnvironment({ environmentPath: { fsPath: '/e' } }), null);
    assert.equal(pathOfEnvsEnvironment(undefined), null);
    assert.equal(pathOfPythonApi({ id: 'abc', path: '/p/bin/python' }), '/p/bin/python');
    assert.equal(pathOfPythonApi({ id: 'DEFAULT_PYTHON', path: 'python' }), null);
    assert.equal(pathOfPythonApi({ id: 'x', path: 'python3' }), null);
  });
});

describe('ToolingHintSource.getHints', () => {
  it('returns nothing, without error, when neither extension is installed', async () => {
    const src = new ToolingHintSource(new MemoryLog().logger);
    assert.deepEqual(await src.getHints('/w'), { hints: [], notes: [] });
    src.dispose();
  });

  it('asks both extensions for the selection of the folder', async () => {
    const asked: string[] = [];
    install(ENVS_EXTENSION_ID, { getEnvironment: async (u: { fsPath: string }) => { asked.push(u.fsPath); return { execInfo: { run: { executable: '/envs/python' } } }; } });
    install(PYTHON_EXTENSION_ID, { environments: { getActiveEnvironmentPath: () => ({ id: 'x', path: '/pyext/python' }) } });
    const src = new ToolingHintSource(new MemoryLog().logger);
    const r = await src.getHints('/w/Lab 1 (Fall)');
    assert.deepEqual(r.hints.map((h) => [h.source, h.path]), [['envs-api', '/envs/python'], ['python-api', '/pyext/python']]);
    assert.deepEqual(asked, ['/w/Lab 1 (Fall)']);
    src.dispose();
  });

  it('treats a slow, failing or empty extension as "not ready" in the notes, not as "no Python"', async () => {
    install(ENVS_EXTENSION_ID, { getEnvironment: async () => undefined });
    install(PYTHON_EXTENSION_ID, { environments: { getActiveEnvironmentPath: () => ({ id: 'DEFAULT_PYTHON', path: 'python' }) } }, () => new Promise(() => undefined));
    const src = new ToolingHintSource(new MemoryLog().logger, { pythonMs: 30 });
    const r = await src.getHints(null);
    assert.deepEqual(r.hints, []);
    assert.ok(r.notes.some((n) => /Environments extension has not selected/.test(n)));
    assert.ok(r.notes.some((n) => /Python extension is installed but was not ready/.test(n)));
    install(ENVS_EXTENSION_ID, {}, async () => { throw new Error('activation failed'); });
    const r2 = await src.getHints(null);
    assert.ok(r2.notes.some((n) => /activation failed/.test(n)));
    src.dispose();
  });
});

describe('watchDiscoveryInputs', () => {
  it('drops the cached result when the python path setting, trust or the folders change, and calls back', async () => {
    const fs = new FakeFs('posix').add('/opt/homebrew/bin/python3');
    const { exec, calls } = scriptedExec({ '/opt/homebrew/bin/python3': probeOk('/p') });
    const log = new MemoryLog();
    const disc = new PythonDiscovery({ platform: MAC, fs, exec, log: log.logger, context: () => ({ folder: null, trusted: true, pythonPathSetting: '' }) });
    await disc.resolve();
    await disc.resolve();
    assert.equal(calls.filter((c) => c.args.includes('-c')).length, 1);
    const why: string[] = [];
    const subs = watchDiscoveryInputs(disc, undefined, log.logger, (w) => why.push(w));
    mock.config.register('python.defaultInterpreterPath', '');
    mock.config.set('python.defaultInterpreterPath', '/x');
    await disc.resolve();
    assert.equal(calls.filter((c) => c.args.includes('-c')).length, 2, 'setting change');
    mock.setTrusted(false);
    mock.setTrusted(true);
    await disc.resolve();
    assert.equal(calls.filter((c) => c.args.includes('-c')).length, 3, 'trust granted');
    mock.config.set(settingId('port'), '/dev/cu.other'); // unrelated setting: no invalidation
    await disc.resolve();
    assert.equal(calls.filter((c) => c.args.includes('-c')).length, 3);
    assert.ok(why.length >= 2);
    subs.forEach((s) => s.dispose());
  });
});
