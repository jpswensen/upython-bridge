/**
 * Regression tests for the fixes after the adversarial review of the IntelliSense UI path (findings F1..F14), beyond the
 * reviewer's own repros in clobber/consent/edges: the library level (links, permission errors), the
 * wording the user sees, and the neighbours of each fix (a link ABOVE the workspace is still followed, the reverse busy case, ...).
 * Real controller + real disk where a link matters, an in-memory file system where only counting matters. Made-up "acme" names only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IntelliSenseController } from '../../../src/commands/intellisense';
import type { IntelliSensePrompter } from '../../../src/commands/intellisensePrompts';
import {
  TRACKER_REL, applyPlan, nodeClock, nodeFs, planFix, prepareFixInputs, readWorkspaceState, removeManaged, runFix, type Consent,
} from '../../../src/intellisense';
import { TempDirs, projectRoot } from '../../mocks/fixtures';
import { mock } from '../../mocks/vscode';
import { FakeClock, MemFs, RESOURCES_STUBS } from '../intellisense/memfs';
import { exists, makeProject, makeRig, openWorkspace, read, settle, type Rig } from '../intellisense-ui/helpers';

const dirs = new TempDirs();
let rig: Rig | undefined;
beforeEach(() => mock.reset());
afterEach(() => { rig?.h.dispose(); rig = undefined; mock.reset(); dirs.cleanup(); });

const ALL: Consent = { createUserConfig: true, editSettings: false };
const WRITE_ONLY: Consent = { createUserConfig: false, editSettings: false };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const RESOURCES = path.join(projectRoot(), 'resources', 'stubs');

describe('F1-F3 links: the library never reads, writes or deletes through a link below the workspace', () => {
  it('the state lists the links of the managed area and does not list or read what is behind them', async () => {
    const p = makeProject(dirs);
    const outside = path.join(p.base, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.pyi'), 'x');
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.symlinkSync(outside, path.join(p.ws, '.upy-bridge', 'stubs'));
    const state = await readWorkspaceState(nodeFs(), p.ws, nodeClock());
    assert.deepEqual(state.links, ['.upy-bridge/stubs']);
    assert.deepEqual(Object.keys(state.hashes), []);
  });

  it('a linked dot folder is not listed either (it would show the files of the folder it points to)', async () => {
    const p = makeProject(dirs);
    const outside = path.join(p.base, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'manifest.json'), JSON.stringify({ schema: 1, files: { '.upy-bridge/x.pyi': 'h' }, createdOnce: {}, settings: [], stock: null, createdAt: 1 }));
    fs.symlinkSync(outside, path.join(p.ws, '.upy-bridge'));
    const state = await readWorkspaceState(nodeFs(), p.ws, nodeClock());
    assert.deepEqual(state.links, ['.upy-bridge']);
    assert.equal(state.texts[TRACKER_REL], null, 'the tracker behind the link is not read');
  });

  it('planFix names the link, and applyPlan refuses to write behind it (the folder behind it stays empty)', async () => {
    const p = makeProject(dirs);
    const outside = path.join(p.base, 'elsewhere');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.symlinkSync(outside, path.join(p.ws, '.upy-bridge', 'stubs'));
    const deps = { fs: nodeFs(), clock: nodeClock() };
    const plan = planFix(await prepareFixInputs(deps, { workspace: p.ws, resourcesDir: RESOURCES, board: null }));
    assert.ok(plan.warnings.some((w) => w.code === 'W_LINK_IN_MANAGED_AREA' && w.path === '.upy-bridge/stubs'));
    assert.ok(plan.writes.some((w) => w.path.startsWith('.upy-bridge/stubs/')), 'the plan itself still lists them: the refusal is at the moment of writing');
    const result = await applyPlan(plan, deps.fs, deps.clock);
    assert.deepEqual(fs.readdirSync(outside), []);
    const behind = result.errors.filter((e) => e.path.startsWith('.upy-bridge/stubs/'));
    assert.ok(behind.length > 0 && behind.every((e) => /link/.test(e.message)), JSON.stringify(result.errors.slice(0, 2)));
    assert.equal(result.written.some((w) => w.startsWith('.upy-bridge/stubs/')), false);
  });

  it('removeManaged: a file behind a link is left alone with a message, the tracker stays so that Remove can be repeated', async () => {
    const p = makeProject(dirs);
    const victimDir = path.join(p.base, 'documents');
    fs.mkdirSync(victimDir);
    fs.writeFileSync(path.join(victimDir, 'report.txt'), 'MY REPORT');
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.symlinkSync(victimDir, path.join(p.ws, '.upy-bridge', 'stubs'));
    fs.writeFileSync(path.join(p.ws, '.upy-bridge', 'own.pyi'), 'x');
    fs.writeFileSync(path.join(p.ws, ...TRACKER_REL.split('/')), JSON.stringify({ schema: 1, files: { '.upy-bridge/own.pyi': 'h', '.upy-bridge/stubs/report.txt': 'h' }, createdOnce: {}, settings: [], stock: null, createdAt: 1 }));
    const res = await removeManaged(nodeFs(), nodeClock(), p.ws);
    assert.equal(fs.readFileSync(path.join(victimDir, 'report.txt'), 'utf8'), 'MY REPORT');
    assert.deepEqual(res.removed, ['.upy-bridge/own.pyi']);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0]?.message ?? '', /link/);
    assert.equal(exists(p.ws, ...TRACKER_REL.split('/')), true, 'the tracker stays after a problem');
  });

  it('removeManaged: a linked dot folder is refused as a whole', async () => {
    const p = makeProject(dirs);
    const outside = path.join(p.base, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'manifest.json'), JSON.stringify({ schema: 1, files: { '.upy-bridge/manifest.json.bak': 'h' }, createdOnce: {}, settings: [], stock: null, createdAt: 1 }));
    fs.writeFileSync(path.join(outside, 'manifest.json.bak'), 'precious');
    fs.symlinkSync(outside, path.join(p.ws, '.upy-bridge'));
    const res = await removeManaged(nodeFs(), nodeClock(), p.ws);
    assert.equal(res.nothingToDo, false);
    assert.equal(res.removed.length, 0);
    assert.match(res.errors[0]?.message ?? '', /link/);
    assert.deepEqual(fs.readdirSync(outside).sort(), ['manifest.json', 'manifest.json.bak']);
  });

  it('the controller refuses BEFORE any preview or question, with a message that names the link and what to do', async () => {
    const p = makeProject(dirs);
    const outside = path.join(p.base, 'elsewhere');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(p.ws, '.upy-bridge'));
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: ALL });
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(rig.prompter.record.choose, [], 'no question was asked');
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.match(mock.messages('error').map((m) => m.message).join('\n'), /\.upy-bridge is a link[\s\S]*Delete the link itself/);
  });

  it('a link in the managed area that no write or delete goes through does not stop the setup; a linked typings/ is the user\'s business in the default tier', async () => {
    const p = makeProject(dirs);
    const outside = path.join(p.base, 'shared-stubs');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'mine.pyi'), 'def mine() -> int: ...\n');
    fs.symlinkSync(outside, path.join(p.ws, 'typings'));
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.symlinkSync(outside, path.join(p.ws, '.upy-bridge', 'notes'));
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: WRITE_ONLY });
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'applied', JSON.stringify(outcome.errors));
    assert.ok(outcome.warnings?.includes('W_LINK_IN_MANAGED_AREA'), 'the link is mentioned');
    assert.deepEqual(fs.readdirSync(outside), ['mine.pyi'], 'nothing was written through either link');
  });

  it('Remove tells in its confirmation that links are not followed, and removes the rest', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: WRITE_ONLY });
    await rig.controller.fix();
    const outside = path.join(p.base, 'documents');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'report.txt'), 'MY REPORT');
    fs.rmSync(path.join(p.ws, '.upy-bridge', 'board-lib'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(p.ws, '.upy-bridge', 'board-lib'));
    const tracker = JSON.parse(read(p.ws, ...TRACKER_REL.split('/'))) as { files: Record<string, string> };
    tracker.files['.upy-bridge/board-lib/report.txt'] = 'x';
    fs.writeFileSync(path.join(p.ws, ...TRACKER_REL.split('/')), JSON.stringify(tracker));
    const res = await rig.controller.remove();
    assert.match(rig.prompter.record.removes[0] ?? '', /\.upy-bridge\/board-lib is a link/);
    assert.equal(fs.readFileSync(path.join(outside, 'report.txt'), 'utf8'), 'MY REPORT');
    assert.ok((res?.removed.length ?? 0) > 0 && (res?.errors.length ?? 0) === 1);
  });

  it('a link ABOVE the workspace (an alias of the project folder) is still followed: the files land in the real folder', async () => {
    const p = makeProject(dirs);
    const alias = path.join(p.base, 'alias');
    fs.symlinkSync(p.ws, alias);
    openWorkspace(alias);
    rig = makeRig();
    rig.prompter.set({ consent: WRITE_ONLY });
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'applied', JSON.stringify(outcome.errors));
    assert.equal(exists(p.ws, '.upy-bridge', 'pyright.generated.json'), true);
  });
});

describe('F4 a file outside the dot folder is deleted only while it still has the recorded content', () => {
  const typingsRig = (content: string, recorded: string) => {
    const p = makeProject(dirs);
    fs.mkdirSync(path.join(p.ws, 'typings'));
    fs.writeFileSync(path.join(p.ws, 'typings', 'mine.pyi'), content);
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.writeFileSync(path.join(p.ws, ...TRACKER_REL.split('/')), JSON.stringify({ schema: 1, files: { 'typings/mine.pyi': recorded }, createdOnce: {}, settings: [], stock: null, createdAt: 1 }));
    openWorkspace(p.ws);
    rig = makeRig();
    return p;
  };

  it('a different content: kept, listed as "stays" in the confirmation and in the result', async () => {
    const p = typingsRig('def mine() -> int: ...\n', '0'.repeat(64));
    const res = await rig!.controller.remove();
    assert.deepEqual(res?.keptEdited, ['typings/mine.pyi']);
    assert.equal(exists(p.ws, 'typings', 'mine.pyi'), true);
    assert.match(rig!.prompter.record.removes[0] ?? '', /typings\/mine\.pyi stays/);
  });

  it('the recorded content: removed (the extension made it)', async () => {
    const text = 'def mine() -> int: ...\n';
    const p = typingsRig(text, sha(text));
    const res = await rig!.controller.remove();
    assert.deepEqual(res?.keptEdited, []);
    assert.equal(exists(p.ws, 'typings', 'mine.pyi'), false);
  });

  it('the setup plan keeps such a file too (a pack switched, "no longer needed" must not delete a file that changed)', async () => {
    const p = typingsRig('def mine() -> int: ...\n', '0'.repeat(64));
    rig!.prompter.set({ consent: WRITE_ONLY });
    const outcome = await rig!.controller.fix();
    assert.equal(outcome.status, 'applied');
    assert.equal(exists(p.ws, 'typings', 'mine.pyi'), true);
    assert.ok(outcome.warnings?.includes('W_TRACKED_FILE_EDITED'));
  });
});

describe('F5 a folder that cannot be written: the setup gives up after a few files, not after all of them', () => {
  it('EACCES on every write: 3 files x (1 try + 5 retries), one summary error, no removes, no tracker', async () => {
    const mem = new MemFs('posix');
    mem.importDir(RESOURCES_STUBS, '/res');
    mem.mkdirp('/w');
    mem.put('/w/main.py', 'import machine\n');
    const clock = new FakeClock();
    const { plan } = await runFix({ fs: mem, clock }, { workspace: '/w', resourcesDir: '/res', board: null }, { apply: false });
    assert.ok(plan.writes.length > 20, `${plan.writes.length} writes planned`);
    const failure = { op: 'writeFile' as const, match: /\.upy-bridge/, code: 'EACCES', times: 100_000 };
    mem.failures.push(failure);
    const result = await applyPlan(plan, mem, clock);
    const attempts = 100_000 - failure.times;
    assert.ok(attempts <= 3 * 6, `${attempts} attempts`);
    assert.equal(result.written.length, 0);
    assert.ok(result.errors.length <= 4, `${result.errors.length} errors`);
    assert.match(result.errors.at(-1)?.message ?? '', /Stopped: 3 files in a row .*permission denied.*remaining/);
    assert.equal(mem.has(`/w/${TRACKER_REL}`), false);
  });

  it('a single locked file (EBUSY) does not stop the others', async () => {
    const mem = new MemFs('posix');
    mem.importDir(RESOURCES_STUBS, '/res');
    mem.mkdirp('/w');
    const clock = new FakeClock();
    const { plan } = await runFix({ fs: mem, clock }, { workspace: '/w', resourcesDir: '/res', board: null }, { apply: false });
    mem.failures.push({ op: 'writeFile', match: /\.upy-bridge\/pyright\.generated\.json/, code: 'EBUSY', times: 100_000 });
    const result = await applyPlan(plan, mem, clock);
    assert.equal(result.errors.length, 1);
    assert.equal(result.written.length, plan.writes.length - 1);
  });
});

describe('F6 Remove and the setup exclude each other (both directions)', () => {
  it('the setup is refused while the Remove confirmation is open', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: WRITE_ONLY });
    await rig.controller.fix();
    let release!: (v: boolean) => void;
    const slow: IntelliSensePrompter = { choose: async () => undefined, confirmRemove: () => new Promise((r) => { release = r; }), offer: async () => 'later', importModules: async () => 'continue' };
    rig.h.dispose();
    rig = makeRig({ prompter: slow });
    const removing = rig.controller.remove();
    for (let i = 0; i < 500 && release === undefined; i++) { await settle(10); } // until the confirmation is open
    assert.notEqual(release, undefined, 'the confirmation was never asked');
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'busy');
    release(true);
    assert.ok((await removing)?.removed.length);
  });
});

describe('F8 a damaged bundled pack keeps what worked', () => {
  it('stubPath and the ignore entry stay in the generated config, the tracker keeps the stock block, the warning says the stubs were kept', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: ALL });
    await rig.controller.fix();
    const trackerBefore = JSON.parse(read(p.ws, ...TRACKER_REL.split('/'))) as { stock: unknown; files: Record<string, string> };
    const res = path.join(dirs.make('upy-bridge-stubs'), 'stubs');
    fs.cpSync(RESOURCES, res, { recursive: true });
    fs.rmSync(path.join(res, 'MANIFEST.json'));
    const again = new IntelliSenseController(rig.h.services, { prompter: rig.prompter, resourcesDir: res });
    const outcome = await again.fix();
    assert.ok(outcome.warnings?.includes('W_STOCK_UNAVAILABLE') && outcome.warnings.includes('W_STOCK_KEPT'), JSON.stringify(outcome.warnings));
    assert.equal(outcome.warnings?.includes('W_NO_STOCK_STUBS'), false);
    assert.match(read(p.ws, '.upy-bridge', 'pyright.generated.json'), /"stubPath": "stubs\/active"/);
    const trackerAfter = JSON.parse(read(p.ws, ...TRACKER_REL.split('/'))) as { stock: unknown; files: Record<string, string> };
    assert.deepEqual(trackerAfter.stock, trackerBefore.stock);
    assert.ok(Object.keys(trackerAfter.files).some((f) => f.startsWith('.upy-bridge/stubs/active/')));
  });

  it('a FIRST run with a damaged pack still sets up the rest and says no stubs were selected', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    const res = path.join(dirs.make('upy-bridge-stubs'), 'stubs');
    fs.cpSync(RESOURCES, res, { recursive: true });
    fs.rmSync(path.join(res, 'MANIFEST.json'));
    rig = makeRig();
    const controller = new IntelliSenseController(rig.h.services, { prompter: rig.prompter, resourcesDir: res });
    rig.prompter.set({ consent: WRITE_ONLY });
    const outcome = await controller.fix();
    assert.ok(outcome.warnings?.includes('W_STOCK_UNAVAILABLE') && outcome.warnings.includes('W_NO_STOCK_STUBS'));
    assert.doesNotMatch(read(p.ws, '.upy-bridge', 'pyright.generated.json'), /stubPath/);
  });
});

describe('F10 multi-root: the folder the board mirror uses is the first one', () => {
  it('choosing the first folder gives no warning; the second one does', async () => {
    const a = makeProject(dirs);
    const b = makeProject(dirs);
    mock.setWorkspaceFolders(a.ws, b.ws);
    rig = makeRig();
    rig.prompter.set({ consent: WRITE_ONLY });
    const first = await rig.controller.fix({ folder: a.ws });
    assert.equal(first.warnings?.includes('W_WORKSPACE_NOT_MIRROR_ROOT'), false);
    const second = await rig.controller.fix({ folder: b.ws });
    assert.ok(second.warnings?.includes('W_WORKSPACE_NOT_MIRROR_ROOT'));
  });
});
