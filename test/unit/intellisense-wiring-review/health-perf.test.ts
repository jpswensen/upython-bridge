/**
 * Adversarial review: Doctor facts on odd inputs, the stub loader from an INSTALLED location (the packaged VSIX, a relative path,
 * another working directory) and the responsiveness of the setup on a large folder tree. Made-up "acme" names only.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { buildDoctorReport, type DoctorFacts, type IntelliSenseFact } from '../../../src/doctor';
import { nodeClock, nodeFs, prepareFixInputs } from '../../../src/intellisense';
import { gatherIntelliSenseHealth } from '../../../src/intellisense/health';
import { FakeSession } from '../../mocks/fakeSession';
import { TempDirs, projectRoot } from '../../mocks/fixtures';
import { mock } from '../../mocks/vscode';
import { makeProject, makeRig, openWorkspace, type Rig } from '../intellisense-ui/helpers';

const dirs = new TempDirs();
let rig: Rig | undefined;
beforeEach(() => mock.reset());
afterEach(() => { rig?.h.dispose(); rig = undefined; mock.reset(); dirs.cleanup(); });

const resourcesDir = path.join(projectRoot(), 'resources', 'stubs');

function facts(health: Awaited<ReturnType<typeof gatherIntelliSenseHealth>>): DoctorFacts {
  const x: IntelliSenseFact = { health, servers: { pylance: true, pythonExtension: true, basedpyright: false, pyright: false }, overrides: [] };
  return {
    generatedAt: 'now', extensionVersion: '0.1.0', os: 'darwin', osRelease: '24', vscodeVersion: '1.141.0',
    window: { remoteName: undefined, trusted: true, folder: '/p', folderIsLocal: true, folderCount: 1 },
    python: null, pythonError: 'x', bridge: { status: 'not-checked' },
    tooling: { pythonExtensionInstalled: true, envsExtensionInstalled: false, legacyActivateEnvironment: undefined, envsAutoActivation: undefined },
    legacyExtension: { enabled: false }, rootFiles: [], boardModules: [],
    session: { state: new FakeSession().state, selectedPort: null, remembered: null }, reset: { capability: null, learned: [] }, settings: [], intellisense: x,
  };
}

const tracker = (over: Record<string, unknown> = {}): string => JSON.stringify({ schema: 1, files: {}, createdOnce: {}, settings: [], stock: null, createdAt: 1, ...over });

describe('Doctor facts on odd inputs never throw and never print garbage', () => {
  const cases: [string, (ws: string) => void, readonly number[] | null][] = [
    ['tracker is a directory', (ws) => fs.mkdirSync(path.join(ws, '.upy-bridge', 'manifest.json'), { recursive: true }), [1, 29, 0]],
    ['tracker lists a directory as a file', (ws) => { fs.mkdirSync(path.join(ws, '.upy-bridge', 'd'), { recursive: true }); fs.writeFileSync(path.join(ws, '.upy-bridge', 'manifest.json'), tracker({ files: { '.upy-bridge/d': 'x' } })); }, [1, 29, 0]],
    ['extends is a number', (ws) => fs.writeFileSync(path.join(ws, 'pyrightconfig.json'), '{ "extends": 5 }'), [1, 29, 0]],
    ['extends is empty', (ws) => fs.writeFileSync(path.join(ws, 'pyrightconfig.json'), '{ "extends": "" }'), [1, 29, 0]],
    ['extends is a Windows path', (ws) => fs.writeFileSync(path.join(ws, 'pyrightconfig.json'), '{ "extends": "C:\\\\x\\\\y.json" }'), [1, 29, 0]],
    ['extends climbs out of the folder', (ws) => fs.writeFileSync(path.join(ws, 'pyrightconfig.json'), '{ "extends": "../../../../../../../etc/hosts" }'), [1, 29, 0]],
    ['pyrightconfig.json is a directory', (ws) => fs.mkdirSync(path.join(ws, 'pyrightconfig.json')), [1, 29, 0]],
    ['pyrightconfig.json is 3 MB of braces', (ws) => fs.writeFileSync(path.join(ws, 'pyrightconfig.json'), '{'.repeat(3_000_000)), [1, 29, 0]],
    ['board version [0,0,0]', () => undefined, [0, 0, 0]],
    ['board version has NaN', () => undefined, [Number.NaN, 1] as never],
    ['board version has strings', () => undefined, ['a', 'b'] as never],
    ['generated config extraPaths are not strings', (ws) => { fs.mkdirSync(path.join(ws, '.upy-bridge'), { recursive: true }); fs.writeFileSync(path.join(ws, '.upy-bridge', 'pyright.generated.json'), '{ "extraPaths": [1, null, {"a":1}, "/", "C:\\\\"] }'); fs.writeFileSync(path.join(ws, '.upy-bridge', 'manifest.json'), tracker()); }, [1, 29, 0]],
    ['stock block without label', (ws) => { fs.mkdirSync(path.join(ws, '.upy-bridge'), { recursive: true }); fs.writeFileSync(path.join(ws, '.upy-bridge', 'manifest.json'), tracker({ stock: { packs: [1, 'esp32'] } })); }, [1, 29, 0]],
  ];
  for (const [name, setup, boardVersion] of cases) {
    it(name, async () => {
      const p = makeProject(dirs);
      setup(p.ws);
      const h = await gatherIntelliSenseHealth(nodeFs(), { workspace: p.ws, resourcesDir, boardVersion });
      const report = buildDoctorReport(facts(h));
      const body = JSON.stringify(report.sections.find((s) => s.title === 'MicroPython IntelliSense'));
      assert.doesNotMatch(body, /undefined|NaN|\[object|null\b/, body.slice(0, 600));
    });
  }

  it('the folder was deleted under the Doctor: no throw', async () => {
    const h = await gatherIntelliSenseHealth(nodeFs(), { workspace: path.join(dirs.make('upy-bridge-gone'), 'nope'), resourcesDir, boardVersion: [1, 29, 0] });
    assert.equal(h.tracker, 'absent');
  });

  it('a tracker with 40000 entries (hostile or just big) is checked in a bounded time', async () => {
    const p = makeProject(dirs);
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'), { recursive: true });
    const files: Record<string, string> = {};
    for (let i = 0; i < 40000; i++) { files[`.upy-bridge/f${i}.pyi`] = 'x'; }
    fs.writeFileSync(path.join(p.ws, '.upy-bridge', 'manifest.json'), tracker({ files }));
    const t0 = Date.now();
    const h = await gatherIntelliSenseHealth(nodeFs(), { workspace: p.ws, resourcesDir, boardVersion: [1, 29, 0] });
    const ms = Date.now() - t0;
    assert.equal(h.managed.total, 40000);
    assert.ok(ms < 60000, `the Doctor needed ${ms} ms for a 40000-entry tracker`); // linear: 3 to 6 s here, depending on the load
  });
});

describe('the stub packs are found from the INSTALLED location', () => {
  it('extract the real VSIX, change the working directory, use a RELATIVE resources path: the pack loads and verifies', async () => {
    const vsix = path.join(projectRoot(), 'out', 'upython-bridge-0.1.0.vsix');
    if (!fs.existsSync(vsix)) { return; }
    const home = dirs.make('upy-bridge-installed');
    execFileSync('unzip', ['-q', vsix, 'extension/resources/stubs/*', '-d', home], { stdio: 'pipe' });
    const p = makeProject(dirs);
    const cwd = process.cwd();
    try {
      process.chdir(home);
      const inputs = await prepareFixInputs({ fs: nodeFs(), clock: nodeClock() }, {
        workspace: p.ws, resourcesDir: path.join('extension', 'resources', 'stubs'),
        board: { impl: 'micropython', version: [1, 29, 0], machine: 'Acme with ESP32', build: '', platform: 'esp32', uniqueId: 'a', uname: { sysname: 'esp32', machine: 'x', release: '1.29.0' } } as never,
      });
      assert.ok(inputs.stock, `the pack did not load: ${JSON.stringify(inputs.warnings)}`);
      assert.ok(inputs.stock.pack.files.length > 10);
      assert.ok(inputs.stock.pack.files.every((f) => path.isAbsolute(f.abs) || fs.existsSync(f.abs)), 'file paths of the pack must be usable after the working directory changes back');
    } finally {
      process.chdir(cwd);
    }
    const again = await prepareFixInputs({ fs: nodeFs(), clock: nodeClock() }, {
      workspace: p.ws, resourcesDir: path.join(home, 'extension', 'resources', 'stubs'),
      board: { impl: 'micropython', version: [1, 29, 0], machine: 'Acme with ESP32', build: '', platform: 'esp32', uniqueId: 'a', uname: { sysname: 'esp32', machine: 'x', release: '1.29.0' } } as never,
    });
    assert.ok(again.stock, 'absolute path from another cwd');
  });
});

describe('responsiveness on a big folder tree', () => {
  it('node_modules-like tree (20000 files), a 10000-file folder, and 600 sibling folders: bounded time, the event loop is never blocked for long', async () => {
    const p = makeProject(dirs, 'student-stock');
    const mk = (dir: string, n: number): void => { fs.mkdirSync(dir, { recursive: true }); for (let i = 0; i < n; i++) { fs.writeFileSync(path.join(dir, `f${i}.js`), ''); } };
    for (let i = 0; i < 100; i++) { mk(path.join(p.ws, 'node_modules', `pkg${i}`, 'lib'), 200); }
    mk(path.join(p.ws, 'data'), 10000);
    for (let i = 0; i < 600; i++) { mk(path.join(p.base, `sibling${i}`, 'sub'), 5); }
    for (let i = 0; i < 300; i++) { mk(path.join(p.ws, `deep${i}`, 'a', 'b'), 3); } // not in the skip list
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: null });
    let worst = 0;
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
    const t0 = Date.now();
    const outcome = await rig.controller.fix();
    const total = Date.now() - t0;
    clearInterval(timer);
    console.error(`[perf] total ${total} ms, worst event-loop gap ${worst} ms, status ${outcome.status}`);
    assert.ok(total < 20000, `the preparation took ${total} ms`);
    assert.ok(worst < 1500, `the extension host was blocked for ${worst} ms`);
  });

  it('the plan with applying the real stock stubs does not block the event loop for long either', async () => {
    const p = makeProject(dirs, 'student-stock');
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true, editSettings: false } });
    let worst = 0;
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
    await rig.controller.fix();
    clearInterval(timer);
    console.error(`[perf] full run: worst event-loop gap ${worst} ms`);
    assert.ok(worst < 1500, `blocked ${worst} ms`);
    void createHash;
  });
});
