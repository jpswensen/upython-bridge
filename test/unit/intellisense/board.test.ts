/**
 * Stubs made from the board (src/intellisense/board.ts): the inventory, what is chosen (deny list, stock pack, local files win),
 * the copies of board library files, the one-time import with ONE soft reset afterwards, the stub text (parsed by a real
 * Python), and how the planner places, tracks, keeps and removes the files. Fixture: test/fixtures/intellisense/acme-board.json.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  BOARD_LIMITS, KNOWN_ELSEWHERE, NEVER_IMPORT, applyPlan, firmwareKey, gatherBoardStubs, libraryFolders, localModuleNames, neverImport,
  nodeClock, nodeFs, normalizeListing, parseIntrospection, parseTracker, planFix, prepareFixInputs, removeManaged, renderModuleStub,
  selectBoardModules, stockModuleNames, type BoardGatherOptions, type BoardStubs, type ImportAnswer,
} from '../../../src/intellisense';
import { TempDirs, projectRoot } from '../../mocks/fixtures';
import { FIXTURES, acmeFixture, fakeAccess, type FakeAccess } from './acmeBoard';

const dirs = new TempDirs();
afterEach(() => dirs.cleanup());
const RESOURCES = path.join(projectRoot(), 'resources', 'stubs');
const PY = 'python3.13';
const HAVE_PY = spawnSync(PY, ['-V'], { encoding: 'utf8', shell: false }).status === 0;
const NOW = Date.UTC(2026, 9, 13, 12);

function pyParses(src: string): string | null {
  const r = spawnSync(PY, ['-I', '-c', 'import ast,sys\nast.parse(sys.stdin.read())'], { input: src, encoding: 'utf8', shell: false, timeout: 20_000 });
  return r.status === 0 ? null : (r.stderr || String(r.error)).trim().split('\n').slice(-3).join(' | ');
}

/** The esp32 stock pack names, as the command passes them. */
async function esp32Names(): Promise<Set<string>> {
  const inputs = await prepareFixInputs({ fs: nodeFs(), clock: nodeClock() }, { workspace: dirs.make('is-ws'), resourcesDir: RESOURCES, board: acmeFixture().board });
  return stockModuleNames(inputs.stock?.pack ?? null);
}

async function gather(access: FakeAccess, o: Partial<BoardGatherOptions> & { answer?: ImportAnswer } = {}): Promise<{ stubs: BoardStubs | null; asked: string[][] }> {
  const fx = acmeFixture();
  const asked: string[][] = [];
  const stubs = await gatherBoardStubs(nodeFs(), access, {
    board: fx.board, syspath: fx.syspath, stock: await esp32Names(), local: new Set(['acme_extra']), stagingDir: path.join(dirs.make('is-stage'), 'dl'), now: NOW,
    askImport: async (r) => { asked.push(r.modules); return o.answer ?? 'continue'; },
    ...o,
  });
  return { stubs, asked };
}

describe('board inventory: names and choices', () => {
  it('reads help(\'modules\') names of frozen packages (acme/__init__, acme/motor) and dotted names alike', () => {
    const t = normalizeListing(['acme/__init__', 'acme/motor', 'acme.pins', '_acme', 'machine', 'bad name', '9x', 'a/b/c']);
    assert.deepEqual(t.tops, ['_acme', 'a', 'acme', 'machine']);
    assert.ok(t.packages.has('acme') && t.packages.has('a') && !t.packages.has('_acme'));
    assert.deepEqual(t.subs.get('acme'), ['acme.motor', 'acme.pins']);
    assert.deepEqual(t.subs.get('a'), ['a.b'], 'depth 2 at most');
  });

  it('never imports start-up files or modules with effects, whatever the listing says', () => {
    for (const n of ['_boot', 'boot', 'main', 'inisetup', 'flashbdev', 'webrepl_setup', '__main__', 'upip', '_boot_fat', '_bootx', 'port_diag']) {
      assert.equal(neverImport(n), true, n);
    }
    assert.equal(neverImport('acme'), false);
    assert.equal(neverImport('acme.main'), false, 'a submodule called main inside a package is fine');
    assert.ok(NEVER_IMPORT.includes('webrepl_setup'));
  });

  it('takes the stock pack, the standard library and local files away; the rest needs an import', async () => {
    const fx = acmeFixture();
    const sel = selectBoardModules({ listing: normalizeListing(fx.listing), lib: [], stock: await esp32Names(), local: new Set(['acme_extra']) });
    assert.deepEqual(sel.toImport.map((m) => m.name), ['_acme', 'acme'], 'a stock esp32 listing leaves only the custom modules');
    assert.deepEqual(sel.toImport.find((m) => m.name === 'acme')?.subs, ['acme.motor', 'acme.pins']);
    assert.deepEqual(sel.leftOut.map((m) => `${m.name}:${m.how}`), ['acme_extra:local-wins']);
    assert.ok(KNOWN_ELSEWHERE.has('re') && KNOWN_ELSEWHERE.has('_webrepl'));
  });

  it('library folders: /lib plus absolute sys.path folders, never / or a folder that holds another one', () => {
    assert.deepEqual(libraryFolders(['', '.frozen', '/lib']), ['/lib']);
    assert.deepEqual(libraryFolders(['', '/flash', '/flash/lib']), ['/lib', '/flash/lib']);
    assert.deepEqual(libraryFolders(['/', '/sd/lib/']), ['/lib', '/sd/lib']);
  });

  it('a malformed bridge answer is data, not a crash', () => {
    const r = parseIntrospection({ listing: ['a', 3], modules: { x: { attrs: 'no', kinds: { a: 'weird' } }, __proto__: { attrs: ['p'] }, y: 7 } });
    assert.deepEqual(r.listing, ['a']);
    assert.deepEqual(r.modules.x?.attrs, []);
    assert.equal(Object.getPrototypeOf(r.modules), null);
    assert.equal(parseIntrospection(null).listing.length, 0);
  });

  it('the firmware key changes with the listing, the build or the version', () => {
    const fx = acmeFixture();
    const k = firmwareKey(fx.board, fx.listing);
    assert.notEqual(k, firmwareKey(fx.board, [...fx.listing, 'newmod']));
    assert.notEqual(k, firmwareKey({ ...fx.board, version: [1, 30, 0] }, fx.listing));
    assert.equal(k, firmwareKey(fx.board, [...fx.listing].reverse()), 'order does not matter');
  });

  it('local module names: root, lib/ and typings/ files and packages; files the setup owns do not count', async () => {
    const ws = dirs.make('is-local');
    fs.mkdirSync(path.join(ws, 'lib', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'typings', 'acme'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'helper.py'), '');
    fs.writeFileSync(path.join(ws, 'lib', 'pkg', '__init__.py'), '');
    fs.writeFileSync(path.join(ws, 'typings', 'acme', '__init__.pyi'), '');
    fs.writeFileSync(path.join(ws, 'typings', 'mine.pyi'), '');
    assert.deepEqual([...await localModuleNames(nodeFs(), ws)].sort(), ['acme', 'helper', 'mine', 'pkg']);
    assert.deepEqual([...await localModuleNames(nodeFs(), ws, new Set(['typings/acme/__init__.pyi']))].sort(), ['helper', 'mine', 'pkg']);
  });
});

describe('gathering from the board', () => {
  it('lists, copies /lib/helper.py, asks once, imports only the custom modules (and the submodules a package imported), then ONE soft reset', async () => {
    const access = fakeAccess();
    const { stubs, asked } = await gather(access);
    assert.ok(stubs);
    assert.deepEqual(asked, [['_acme', 'acme']], 'one question, naming the modules');
    assert.deepEqual(access.imports, [['_acme', 'acme', 'acme.motor', 'acme.pins'], ['acme.extra']], 'round 2: the submodule acme imported itself');
    assert.equal(access.softResets, 1);
    assert.equal(access.calls[access.calls.length - 1], 'reset.soft', 'the reset comes after the last import');
    assert.equal(access.calls[0], 'introspect', 'the first call imports nothing');
    for (const n of [...NEVER_IMPORT, 'acme_extra', 'machine', 'neopixel']) { assert.ok(!access.imports.flat().includes(n), `${n} was imported`); }
    assert.deepEqual(Object.keys(stubs.stubs).sort(), ['_acme.pyi', 'acme/__init__.pyi', 'acme/extra.pyi', 'acme/motor.pyi', 'acme/pins.pyi']);
    assert.deepEqual(Object.keys(stubs.lib), ['helper.py']);
    assert.match(stubs.lib['helper.py'] ?? '', /def blink\(times: int, delay: float = 0.1\)/, 'the real source, with its real signature');
    const rows = Object.fromEntries(stubs.modules.map((m) => [m.name, m.how]));
    assert.deepEqual(rows, { _acme: 'stub', acme: 'stub', acme_extra: 'local-wins', helper: 'copy' });
    assert.equal(stubs.answer, 'continue');
    assert.equal(stubs.softReset, true);
    assert.equal(stubs.date, '2026-10-13');
  });

  it('the stub text: typed constants, any-argument functions and methods, classes, properties, submodules, keywords skipped', async () => {
    const { stubs } = await gather(fakeAccess());
    const c = stubs?.stubs['_acme.pyi'] ?? '';
    assert.match(c, /^# _acme: made by .+ from the board \(ACME_BOARD, MicroPython 1\.29\.0\), read on 2026-10-13\./);
    assert.match(c, /parameter names/);
    assert.match(c, /^LIMIT: int {2}# = 100$/m);
    assert.match(c, /^ENABLED: bool/m);
    assert.match(c, /^VERSION: str {2}# = "1\.2\.0"$/m);
    assert.match(c, /^def set_speed\(\*args: Any, \*\*kwargs: Any\) -> Any: \.\.\.$/m);
    assert.match(c, /^class Encoder:\n {4}def __init__\(self, \*args: Any, \*\*kwargs: Any\) -> None: \.\.\.\n(.|\n)*def set_limit\(self, \*args: Any, \*\*kwargs: Any\) -> Any: \.\.\.$/m);
    assert.ok(!/lambda|9bad/.test(c), 'a keyword or an invalid name is skipped');
    const a = stubs?.stubs['acme/__init__.pyi'] ?? '';
    assert.match(a, /^from \. import extra as extra$/m);
    assert.match(a, /^from \. import motor as motor$/m);
    assert.match(a, /^from \. import pins as pins$/m);
    assert.match(a, /^import _acme as _acme$/m);
    assert.match(a, / {4}@property\n {4}def speed\(self\) -> Any: \.\.\./);
    assert.match(a, / {4}MAX_SPEED: int/);
    assert.ok(!/__getattr__/.test(a), 'a described module does not accept unknown names');
    assert.ok(!/^class: /m.test(a));
    assert.match(stubs?.stubs['acme/pins.pyi'] ?? '', /^NAME: str {2}# = "acme pins\\nv1"$/m, 'a newline in a value stays inside the comment');
    assert.match(stubs?.stubs['acme/extra.pyi'] ?? '', /^GAIN: float/m);
  });

  it('every generated stub parses with a real Python', { skip: HAVE_PY ? false : `${PY} not found` }, async () => {
    const { stubs } = await gather(fakeAccess(acmeFixture(), { fail: ['acme.pins'] }));
    for (const [rel, text] of Object.entries(stubs?.stubs ?? {})) { assert.equal(pyParses(text), null, rel); }
    const odd = renderModuleStub('odd', { attrs: ['Any', 'x', 'y', 'BadError', 'z'], kinds: { x: 'object', y: 'property', BadError: 'class', z: 'None' }, consts: { z: null }, classes: {} }, { label: 'bé\n', date: 'd', stubbed: new Set(), knownTops: new Set() });
    assert.equal(pyParses(odd), null);
    assert.match(odd, /class BadError\(Exception\):/);
    assert.match(odd, /def __getattr__\(self, name: str\) -> Any/, 'a class without member data accepts any member');
    assert.ok(!/^Any: /m.test(odd), 'a module attribute named Any would hide typing.Any');
  });

  it('a module whose import failed still resolves: __getattr__ and a note in the header', async () => {
    const { stubs } = await gather(fakeAccess(acmeFixture(), { fail: ['acme.pins'] }));
    const p = stubs?.stubs['acme/pins.pyi'] ?? '';
    assert.match(p, /^def __getattr__\(name: str\) -> Any: \.\.\.$/m);
    assert.match(p, /could not be imported on the board \(ImportError/);
    assert.match(stubs?.stubs['acme/__init__.pyi'] ?? '', /^from \. import pins as pins$/m, 'it still has a stub file, so acme.pins resolves');
  });

  it('Skip: nothing is imported, no reset, the modules still resolve (contents unknown)', async () => {
    const access = fakeAccess();
    const { stubs } = await gather(access, { answer: 'skip' });
    assert.deepEqual(access.imports, []);
    assert.equal(access.softResets, 0);
    assert.equal(stubs?.answer, 'skip');
    assert.match(stubs?.stubs['acme/__init__.pyi'] ?? '', /you chose Skip/);
    assert.match(stubs?.stubs['_acme.pyi'] ?? '', /def __getattr__/);
    assert.deepEqual(stubs?.modules.filter((m) => m.how === 'stub-any').map((m) => m.name), ['_acme', 'acme']);
  });

  it('nothing to import (stock firmware): no question, no import, no reset', async () => {
    const fx = acmeFixture();
    fx.listing = fx.listing.filter((n) => !/acme/.test(n));
    fx.files = {};
    const access = fakeAccess(fx);
    const { stubs, asked } = await gather(access);
    assert.deepEqual(asked, []);
    assert.equal(access.softResets, 0);
    assert.deepEqual(access.calls, ['introspect', 'list:/lib']);
    assert.equal(Object.keys(stubs?.stubs ?? { x: 1 }).length, 0);
  });

  it('a failing import call still ends with exactly one soft reset, and the modules fall back to "anything goes"', async () => {
    const access = fakeAccess(acmeFixture(), { throwOn: 'introspect-names' });
    const { stubs } = await gather(access);
    assert.equal(access.softResets, 1);
    assert.ok(stubs?.notes.some((n) => n.code === 'W_BOARD_IMPORT_FAILED'));
    assert.match(stubs?.stubs['_acme.pyi'] ?? '', /def __getattr__/);
  });

  it('a program running on the board: the first (read-only) call fails and nothing else is sent', async () => {
    const access = fakeAccess(acmeFixture(), { throwOn: 'introspect' });
    await assert.rejects(gather(access), /E_PROGRAM_RUNNING/);
    assert.deepEqual(access.calls, ['introspect']);
  });

  it('an unchanged firmware stops after the listing (automatic runs)', async () => {
    const fx = acmeFixture();
    const access = fakeAccess(fx);
    const { stubs } = await gather(access, { unchangedKey: firmwareKey(fx.board, fx.listing) });
    assert.equal(stubs, null);
    assert.deepEqual(access.calls, ['introspect']);
  });

  it('limits: a board file over 256 KB is not copied; at most 40 modules are imported', async () => {
    const fx = acmeFixture();
    fx.files['/lib/big.py'] = `X = 1\n${'#'.repeat(BOARD_LIMITS.fileBytes)}\n`;
    for (let i = 0; i < 45; i++) { fx.listing.push(`custom${String(i).padStart(2, '0')}`); }
    const access = fakeAccess(fx);
    const { stubs } = await gather(access);
    assert.ok(!access.calls.includes('get:/lib/big.py'));
    assert.ok(stubs?.notes.some((n) => n.code === 'W_BOARD_FILE_TOO_BIG'));
    assert.equal(access.imports.flat().length, BOARD_LIMITS.modules);
    assert.ok(stubs?.notes.some((n) => n.code === 'W_BOARD_MODULES_LIMIT'));
    assert.match(stubs?.stubs['custom44.pyi'] ?? '', /too many modules/);
  });

  it('the staging folder of the downloads is removed again', async () => {
    const stage = path.join(dirs.make('is-stage2'), 'dl');
    await gather(fakeAccess(), { stagingDir: stage });
    assert.equal(fs.existsSync(stage), false);
  });
});

describe('planning with the board part', () => {
  async function setup(ws: string, stubs: BoardStubs | null, keep = false): Promise<ReturnType<typeof planFix>> {
    const deps = { fs: nodeFs(), clock: nodeClock() };
    const inputs = await prepareFixInputs(deps, {
      workspace: ws, resourcesDir: RESOURCES, board: acmeFixture().board, consent: { createUserConfig: true },
      ...(stubs !== null ? { boardStubs: { kind: 'fresh' as const, stubs } } : keep ? { boardStubs: { kind: 'keep' as const, note: 'not connected' } } : {}),
    });
    return planFix(inputs);
  }

  it('places board stubs next to the stock stubs, the copies in board-lib (extraPaths + ignore), tracks them, and Remove deletes them', async () => {
    const ws = dirs.make('is-plan');
    fs.cpSync(path.join(FIXTURES, 'student-board'), ws, { recursive: true });
    const { stubs } = await gather(fakeAccess());
    const plan = await setup(ws, stubs);
    const paths = plan.writes.map((w) => w.path);
    assert.ok(paths.includes('.upy-bridge/stubs/active/acme/__init__.pyi') && paths.includes('.upy-bridge/stubs/active/_acme.pyi'));
    assert.ok(paths.includes('.upy-bridge/stubs/active/machine.pyi'), 'the stock stubs are there too');
    assert.ok(paths.includes('.upy-bridge/board-lib/helper.py'));
    assert.ok(plan.facts.extraPaths.includes('board-lib') && plan.facts.ignore.includes('board-lib'));
    assert.deepEqual(plan.managedAfter.board?.files.sort(), ['.upy-bridge/board-lib/helper.py', ...Object.keys(stubs?.stubs ?? {}).map((r) => `.upy-bridge/stubs/active/${r}`)].sort());
    assert.match(plan.summary, /module\(s\) of your board/);
    assert.equal(plan.facts.board?.softReset, true);
    const res = await applyPlan(plan, nodeFs(), nodeClock());
    assert.deepEqual(res.errors, []);
    const tracker = parseTracker(fs.readFileSync(path.join(ws, '.upy-bridge', 'manifest.json'), 'utf8'));
    assert.equal(tracker?.board?.label, 'ACME_BOARD, MicroPython 1.29.0');
    assert.match(fs.readFileSync(path.join(ws, '.upy-bridge', 'pyright.generated.json'), 'utf8'), /"board-lib"/);

    // not connected next time: everything made from the board stays, nothing is removed
    const kept = await setup(ws, null, true);
    assert.deepEqual(kept.removes, []);
    assert.equal(kept.writes.length, 0, 'idempotent');
    assert.ok(kept.facts.extraPaths.includes('board-lib'), 'the copies stay importable');
    assert.equal(kept.facts.board?.kept, true);

    // a board without custom modules now: the earlier board files are removed
    const fresh = await gather(fakeAccess({ ...acmeFixture(), listing: ['machine'], files: {} }));
    const gone = await setup(ws, fresh.stubs);
    assert.ok(gone.removes.some((r) => r.path === '.upy-bridge/board-lib/helper.py'));
    assert.ok(gone.removes.some((r) => r.path === '.upy-bridge/stubs/active/_acme.pyi'));

    const removed = await removeManaged(nodeFs(), nodeClock(), ws);
    assert.deepEqual(removed.errors, []);
    assert.equal(fs.existsSync(path.join(ws, '.upy-bridge')), false);
    assert.ok(fs.existsSync(path.join(ws, 'typings', 'acme_extra.pyi')), 'the student\'s own stub stays');
  });

  it('a board stub never replaces a stock stub file', async () => {
    const ws = dirs.make('is-plan2');
    const { stubs } = await gather(fakeAccess());
    assert.ok(stubs);
    stubs.stubs['machine.pyi'] = '# from the board\n';
    const plan = await setup(ws, stubs);
    const w = plan.writes.find((x) => x.path === '.upy-bridge/stubs/active/machine.pyi');
    assert.ok(w && w.kind === 'copy', 'the stock file is written');
    assert.ok(plan.warnings.some((x) => x.code === 'W_BOARD_STUB_STOCK'));
  });

  it('the tracker refuses a board record that lists a file it does not own', () => {
    const base = { schema: 1, files: { '.upy-bridge/stubs/active/a.pyi': 'x' }, createdOnce: {}, settings: [], stock: null, createdAt: 1 };
    const ok = parseTracker(JSON.stringify({ ...base, board: { key: 'k', label: 'l', date: 'd', files: ['.upy-bridge/stubs/active/a.pyi'], modules: [{ name: 'a', origin: 'firmware', how: 'stub' }] } }));
    assert.equal(ok?.board?.key, 'k');
    assert.equal(parseTracker(JSON.stringify({ ...base, board: { key: 'k', label: 'l', date: 'd', files: ['../outside.py'], modules: [] } })), null);
    assert.equal(parseTracker(JSON.stringify({ ...base, board: { key: 'k', label: 'l', date: 'd', files: ['.upy-bridge/stubs/active/b.pyi'], modules: [] } })), null);
  });
});
