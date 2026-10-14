/** The Doctor's IntelliSense section: the pure facts (src/intellisense/health.ts), the text (src/doctor.ts) and the preview wording. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { buildDoctorReport, collectDoctorFacts, renderDoctorMarkdown, type DoctorFacts, type IntelliSenseFact } from '../../../src/doctor';
import { nodeFs } from '../../../src/intellisense';
import { gatherIntelliSenseHealth, type IntelliSenseHealth } from '../../../src/intellisense/health';
import { groupWrites, renderPlanMarkdown, renderRemoveDetail, renderResultMarkdown, removeToast, resultToast } from '../../../src/intellisense/preview';
import { PythonDiscovery } from '../../../src/python/discovery';
import { LearnedResetStore } from '../../../src/session/learnedReset';
import { MockMemento } from '../../mocks/extensionContext';
import { FakeSession } from '../../mocks/fakeSession';
import { projectRoot, TempDirs } from '../../mocks/fixtures';
import { createExtensionContext, mock } from '../../mocks/vscode';
import { SETTINGS } from '../session/kit';
import { makeProject, makeRig, openWorkspace } from './helpers';
import { runFix, type BoardPart } from '../../../src/intellisense';

const dirs = new TempDirs();
beforeEach(() => mock.reset());
afterEach(() => {
  mock.reset();
  dirs.cleanup();
});

const resourcesDir = path.join(projectRoot(), 'resources', 'stubs');

/** Stubs as the board-based setup makes them (src/intellisense/board.ts): a frozen package, a C module and a board library file. */
const fromBoard = (): BoardPart => ({
  kind: 'fresh',
  stubs: {
    key: 'ACME_BOARD|1.29.0|0123456789abcdef', label: 'ACME_BOARD, MicroPython 1.29.0', date: '2026-10-13',
    stubs: { 'acme/__init__.pyi': 'from typing import Any\nclass Motor: ...\n', '_acme.pyi': 'LIMIT: int\n' },
    lib: { 'boardhelper.py': 'def board_name():\n    return "acme"\n' },
    modules: [
      { name: '_acme', origin: 'firmware', how: 'stub' }, { name: 'acme', origin: 'firmware', how: 'stub' },
      { name: 'boardhelper', origin: 'board-file', how: 'copy', from: '/lib/boardhelper.py' },
    ],
    notes: [], imported: ['acme', '_acme'], softReset: true, answer: 'continue',
  },
});

async function setUp(over: { board?: [number, number, number]; consent?: boolean } = {}): Promise<{ ws: string }> {
  const p = makeProject(dirs);
  const board = { impl: 'micropython', version: over.board ?? [1, 29, 0], machine: 'Acme Board with ESP32', build: 'ACME_BOARD', platform: 'esp32', uniqueId: '0a' };
  const deps = { fs: nodeFs(), clock: { now: () => Date.now(), sleep: async () => undefined } };
  await runFix(deps, { workspace: p.ws, resourcesDir, board, consent: { createUserConfig: true }, boardStubs: fromBoard() }, { apply: true });
  return p;
}

const health = (ws: string, boardVersion: readonly number[] | null = [1, 29, 0]): Promise<IntelliSenseHealth> => gatherIntelliSenseHealth(nodeFs(), { workspace: ws, resourcesDir, boardVersion });

describe('IntelliSense health facts', () => {
  it('a fresh setup is all in place: files ok, stubs match the board, the config extends an existing file', async () => {
    const p = await setUp();
    const h = await health(p.ws);
    assert.equal(h.tracker, 'valid');
    assert.equal(h.managed.missing.length, 0);
    assert.equal(h.managed.edited.length, 0);
    assert.ok(h.managed.total > 50);
    assert.equal(h.stubVersions.relation, 'same');
    assert.equal(h.userConfig.extendsOurs, true);
    assert.equal(h.userConfig.targetExists, true);
    assert.deepEqual(h.userConfig.overridden, []);
    assert.deepEqual(h.createdOnce, [{ path: 'pyrightconfig.json', state: 'ok' }]);
    assert.deepEqual(h.shadowing, []);
    assert.deepEqual(h.problems, []);
  });

  it('reports missing and hand-edited managed files, and a config whose extends target is gone', async () => {
    const p = await setUp();
    fs.rmSync(path.join(p.ws, '.upy-bridge', 'pyright.generated.json'));
    fs.appendFileSync(path.join(p.ws, '.upy-bridge', 'stubs', 'active', 'machine.pyi'), '# mine\n');
    fs.appendFileSync(path.join(p.ws, 'pyrightconfig.json'), '// mine\n');
    const h = await health(p.ws);
    assert.deepEqual(h.managed.missing, ['.upy-bridge/pyright.generated.json']);
    assert.deepEqual(h.managed.edited, ['.upy-bridge/stubs/active/machine.pyi']);
    assert.equal(h.userConfig.targetExists, false);
    assert.deepEqual(h.createdOnce, [{ path: 'pyrightconfig.json', state: 'edited' }]);
  });

  it('compares the stub pack with the board version in both directions, and says no-board without one', async () => {
    const p = await setUp();
    assert.equal((await health(p.ws, [1, 26, 0])).stubVersions.relation, 'stubs-newer');
    assert.equal((await health(p.ws, [1, 31, 0])).stubVersions.relation, 'stubs-older');
    assert.equal((await health(p.ws, null)).stubVersions.relation, 'no-board');
  });

  it('finds student files that hide a stub module or a module made from the board (frozen, C, board library file)', async () => {
    const p = await setUp();
    for (const f of ['time.py', 'machine.py', 'acme.py', '_acme.py', 'boardhelper.py', 'fine.py']) { fs.writeFileSync(path.join(p.ws, f), 'x = 1\n'); }
    const h = await health(p.ws);
    assert.deepEqual(h.shadowing.map((s) => s.file), ['_acme.py', 'acme.py', 'boardhelper.py', 'machine.py', 'time.py']);
  });

  it('knows nothing was set up, a damaged tracker, and a pyproject with [tool.pyright]', async () => {
    const p = makeProject(dirs);
    assert.equal((await health(p.ws)).tracker, 'absent');
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.writeFileSync(path.join(p.ws, '.upy-bridge', 'manifest.json'), 'nope');
    fs.writeFileSync(path.join(p.ws, 'pyproject.toml'), '[tool.pyright]\n');
    const h = await health(p.ws);
    assert.equal(h.tracker, 'invalid');
    assert.equal(h.pyprojectPyright, true);
  });
});

function fact(h: IntelliSenseHealth | null, over: Partial<IntelliSenseFact> = {}): IntelliSenseFact {
  return { health: h, servers: { pylance: true, pythonExtension: true, basedpyright: false, pyright: false }, overrides: [], ...over };
}

function base(h: IntelliSenseHealth, over: Partial<IntelliSenseFact> = {}): DoctorFacts {
  return { ...(minimalFacts()), intellisense: fact(h, over) };
}

function minimalFacts(): DoctorFacts {
  return {
    generatedAt: 'now', extensionVersion: '0.1.0', os: 'darwin', osRelease: '24', vscodeVersion: '1.141.0',
    window: { remoteName: undefined, trusted: true, folder: '/p', folderIsLocal: true, folderCount: 1 },
    python: null, pythonError: 'x', bridge: { status: 'not-checked' },
    tooling: { pythonExtensionInstalled: true, envsExtensionInstalled: false, legacyActivateEnvironment: undefined, envsAutoActivation: undefined },
    legacyExtension: { enabled: false }, rootFiles: [], boardModules: [],
    session: { state: new FakeSession().state, selectedPort: null, remembered: null }, reset: { capability: null, learned: [] }, settings: [],
  };
}

const goodHealth = (): IntelliSenseHealth => ({
  folder: '/p', tracker: 'valid', managed: { total: 80, ok: 80, missing: [], edited: [] }, createdOnce: [{ path: 'pyrightconfig.json', state: 'ok' }],
  stock: { packs: ['stdlib', 'esp32'], label: 'esp32 1.29.0.post1' }, stubVersions: { relation: 'same', stubs: 'esp32 1.29.0.post1', board: '1.29.0' },
  board: {
    key: 'ACME_BOARD|1.29.0|0123456789abcdef', label: 'ACME_BOARD, MicroPython 1.29.0', date: '2026-10-13', files: ['.upy-bridge/stubs/active/acme/__init__.pyi'],
    modules: [{ name: 'acme', origin: 'firmware', how: 'stub' }],
  },
  generated: { exists: true }, userConfig: { exists: true, valid: true, extendsOurs: true, targetExists: true, overridden: [] }, pyprojectPyright: false, shadowing: [], problems: [],
});

const section = (f: DoctorFacts): { level: string; text: string; todo?: string }[] => buildDoctorReport(f).sections.find((s) => s.title === 'MicroPython IntelliSense')?.items ?? [];
const text = (f: DoctorFacts): string => section(f).map((i) => `${i.level}: ${i.text} ${i.todo ?? ''}`).join('\n');

describe('the Doctor section', () => {
  it('is left out when no facts were collected (older synthetic facts) and says OK when everything is fine', () => {
    assert.equal(buildDoctorReport(minimalFacts()).sections.some((s) => s.title === 'MicroPython IntelliSense'), false);
    const items = section(base(goodHealth()));
    assert.deepEqual(items.map((i) => i.level), ['ok', 'ok', 'ok', 'ok', 'ok']);
    assert.match(items[1]?.text ?? '', /All 80 files/);
    assert.match(items[3]?.text ?? '', /Modules of your board \(ACME_BOARD, MicroPython 1\.29\.0, read on 2026-10-13\): acme/);
  });

  it('names every problem with something to do', () => {
    const h = goodHealth();
    h.managed = { total: 80, ok: 78, missing: ['.upy-bridge/pyright.generated.json'], edited: ['.upy-bridge/stubs/active/machine.pyi'] };
    h.userConfig = { exists: true, valid: true, extendsOurs: true, targetExists: false, overridden: ['extraPaths'] };
    h.stubVersions = { relation: 'stubs-older', stubs: 'esp32 1.28.0', board: '1.29.0' };
    h.shadowing = [{ file: 'time.py', module: 'time' }];
    const t = text(base(h, { servers: { pylance: false, pythonExtension: true, basedpyright: false, pyright: false }, overrides: [{ key: 'python.analysis.typeCheckingMode', scope: 'workspace', value: 'strict' }] }));
    assert.match(t, /warn: No Python language server/);
    assert.match(t, /warn: 1 of 80 files made by the setup are missing/);
    assert.match(t, /error: pyrightconfig.json extends \.upy-bridge\/pyright.generated.json, but that file does not exist/);
    assert.match(t, /warn: pyrightconfig.json sets extraPaths itself/);
    assert.match(t, /warn: The stubs \(esp32 1.28.0\) are older than the board's MicroPython 1.29.0/);
    assert.match(t, /warn: These VS Code settings are ignored while pyrightconfig.json exists: python.analysis.typeCheckingMode \(workspace\)/);
    assert.match(t, /warn: These files hide a module that IntelliSense resolves.*time.py/);
    for (const i of section(base(h))) { if (i.level === 'warn' || i.level === 'error') { assert.ok(i.todo && i.todo.length > 10, `"${i.text}" has a "What to do"`); } }
  });

  it('covers: not set up, damaged tracker, no config file, pyproject.toml, other extends, broken json', () => {
    const none = goodHealth();
    none.tracker = 'absent'; none.managed = { total: 0, ok: 0, missing: [], edited: [] }; none.userConfig = { exists: false, valid: true, extendsOurs: false, targetExists: null, overridden: [] }; none.stubVersions.relation = 'none';
    assert.match(text(base(none)), /info: MicroPython IntelliSense is not set up in this folder/);
    const damaged = goodHealth(); damaged.tracker = 'invalid';
    assert.match(text(base(damaged)), /warn: .*manifest.json is damaged/);
    const noCfg = goodHealth(); noCfg.userConfig = { exists: false, valid: true, extendsOurs: false, targetExists: null, overridden: [] };
    assert.match(text(base(noCfg)), /warn: There is no pyrightconfig.json/);
    const toml = goodHealth(); toml.userConfig = { exists: false, valid: true, extendsOurs: false, targetExists: null, overridden: [] }; toml.pyprojectPyright = true;
    assert.match(text(base(toml)), /\[tool.pyright\] section/);
    const other = goodHealth(); other.userConfig = { exists: true, valid: true, extendsOurs: false, extendsValue: 'base.json', targetExists: true, overridden: [] };
    assert.match(text(base(other)), /extends base.json, not the generated file/);
    const bad = goodHealth(); bad.userConfig = { exists: true, valid: false, error: 'JSON error at offset 3', extendsOurs: false, targetExists: null, overridden: [] };
    assert.match(text(base(bad)), /error: pyrightconfig.json cannot be read/);
    const settingsOnly = goodHealth(); settingsOnly.userConfig = { exists: false, valid: true, extendsOurs: false, targetExists: null, overridden: [] }; settingsOnly.tracker = 'absent';
    assert.match(text(base(settingsOnly, { overrides: [{ key: 'python.analysis.extraPaths', scope: 'user', value: ['lib'] }] })), /info: These settings are in effect because there is no pyrightconfig.json: python.analysis.extraPaths \(user\)/);
  });

  it('renders in the Markdown report', () => {
    assert.match(renderDoctorMarkdown(buildDoctorReport(base(goodHealth()))), /## MicroPython IntelliSense/);
  });
});

describe('collecting the facts from VS Code', () => {
  it('reads the language servers and the python.analysis overrides of every scope, and the folder files', async () => {
    const p = await setUp();
    openWorkspace(p.ws);
    mock.addExtension('ms-python.vscode-pylance');
    mock.config.register('python.analysis.typeCheckingMode');
    mock.config.register('python.analysis.extraPaths');
    mock.config.set('python.analysis.typeCheckingMode', 'strict');
    mock.config.set('python.analysis.extraPaths', ['lib'], 1);
    const ctx = createExtensionContext();
    const session = FakeSession.connected();
    const rig = makeRig({ session });
    const facts = await collectDoctorFacts({
      context: ctx.vscode, log: rig.h.services.log, settings: { ...SETTINGS, onDidChange: () => ({ dispose: () => undefined }), update: async () => undefined } as never,
      session: Object.assign(session, { bridgeInfo: async () => { throw new Error('no bridge in this test'); }, resetCapability: async () => { throw new Error('no'); } }) as never,
      discovery: { invalidate: () => undefined, resolve: async () => ({ chosen: null, alternatives: [], rejected: [], notes: [], failure: null }) } as unknown as PythonDiscovery,
      learned: new LearnedResetStore(new MockMemento()),
    });
    ctx.dispose();
    rig.h.dispose();
    const x = facts.intellisense;
    assert.ok(x);
    assert.equal(x.servers.pylance, true);
    assert.deepEqual(x.overrides.map((o) => [o.key, o.scope]).sort(), [['python.analysis.extraPaths', 'user'], ['python.analysis.typeCheckingMode', 'workspace']]);
    assert.equal(x.health?.tracker, 'valid');
    assert.equal(x.health?.stubVersions.relation, 'same');
  });
});

describe('the preview and report wording', () => {
  it('groups many stub files into one line and keeps single files visible', () => {
    const w = (p: string): never => ({ path: p, kind: 'copy', sha256: 'a', bytes: 100, action: 'create', reason: 'stock stubs (esp32 1.29.0.post1)', managed: true }) as never;
    const writes = [...Array.from({ length: 30 }, (_, i) => w(`.upy-bridge/stubs/active/m${i}.pyi`)), w('.upy-bridge/stubs/active/aioble/core.pyi'), w('.upy-bridge/pyright.generated.json')];
    const rows = groupWrites(writes);
    assert.deepEqual(rows.map((r) => r.label), ['.upy-bridge/pyright.generated.json', '.upy-bridge/stubs/active/ (stub files)']);
    assert.equal(rows[1]?.count, 31);
  });

  it('the toast texts say what happened and what to do next', () => {
    const plan = { warnings: [{ code: 'W_USER_CONFIG_MISSING', message: 'x' }] } as never;
    assert.equal(resultToast(plan, { written: ['a'], removed: [], skipped: [], settingsApplied: [], errors: [] }).level, 'warning');
    assert.match(resultToast({ warnings: [] } as never, { written: ['a', 'b'], removed: [], skipped: [], settingsApplied: [], errors: [] }).text, /2 files written/);
    assert.match(resultToast({ warnings: [] } as never, { written: [], removed: [], skipped: [], settingsApplied: [], errors: [{ path: 'a', message: 'EBUSY' }] }).text, /Run the setup again in a minute/);
    assert.match(removeToast({ removed: ['a'], keptEdited: ['pyrightconfig.json'], settingsRemoved: [], settingsKept: [], errors: [], nothingToDo: false }).text, /pyrightconfig.json was kept/);
    assert.match(renderRemoveDetail({ files: ['a', 'b'], createdOnce: [{ path: 'pyrightconfig.json', edited: false }], settings: [] }), /pyrightconfig.json \(created once; you have not edited it\)/);
    void renderPlanMarkdown; void renderResultMarkdown;
  });
});
