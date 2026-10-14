import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'jsonc-parser';
import { IDENTITY } from '../../../src/identity';
import { addSettingsKeys, removeSettingsKeys } from '../../../src/intellisense/settingsEdit';
import {
  TRACKER_REL, applyPlan, parseTracker, planFix, prepareFixInputs, removeManaged, runFix, type BoardPart, type FixDeps, type FixRequest,
} from '../../../src/intellisense/fix';
import type { BoardInfo } from '../../../src/intellisense/types';
import { FakeClock, MemFs, RESOURCES_STUBS } from './memfs';

const DOT = IDENTITY.dotDir;
const GEN = `${DOT}/pyright.generated.json`;
const esp32: BoardInfo = { impl: 'micropython', version: [1, 29, 0], machine: 'ESP32 module with ESP32', build: 'ACME_BOARD', platform: 'esp32', uniqueId: 'aabb' };
const rp2: BoardInfo = { impl: 'micropython', version: [1, 28, 0], machine: 'Raspberry Pi Pico with RP2040', build: 'RPI_PICO', platform: 'rp2', uniqueId: 'ccdd' };

interface World { mem: MemFs; clock: FakeClock; ws: string; res: string; deps: FixDeps; req: (o?: Partial<FixRequest>) => FixRequest; at: (rel: string) => string }

/** What src/intellisense/board.ts makes for the made-up "acme" firmware: a frozen package, a C module and a copy of /lib/boardhelper.py. */
function fromBoard(over: { stubs?: Record<string, string>; lib?: Record<string, string> } = {}): BoardPart {
  return {
    kind: 'fresh',
    stubs: {
      key: 'ACME_BOARD|1.29.0|0123456789abcdef', label: 'ACME_BOARD, MicroPython 1.29.0', date: '2026-10-13',
      stubs: over.stubs ?? { 'acme/__init__.pyi': 'from typing import Any\nfrom . import motor as motor\n', 'acme/motor.pyi': 'class Motor: ...\n', '_acme.pyi': 'LIMIT: int\n' },
      lib: over.lib ?? { 'boardhelper.py': 'def board_name():\n    return "acme"\n' },
      modules: [
        { name: '_acme', origin: 'firmware', how: 'stub' }, { name: 'acme', origin: 'firmware', how: 'stub' },
        { name: 'boardhelper', origin: 'board-file', how: 'copy', from: '/lib/boardhelper.py' },
      ],
      notes: [], imported: ['acme', 'acme.motor', '_acme'], softReset: true, answer: 'continue',
    },
  };
}

function world(flavour: 'posix' | 'win32' = 'posix', withBoard = false): World {
  const mem = new MemFs(flavour);
  const clock = new FakeClock();
  const win = flavour === 'win32';
  const ws = win ? 'C:\\Users\\Student Name\\OneDrive - Example\\Lab Course (Fall)\\Lab 1' : '/Users/student/OneDrive-Example University(email.example.edu)/Lab Course (Fall)/Lab \u00dcbung 1';
  const res = win ? 'C:\\ext\\stubs' : '/ext/stubs';
  mem.importDir(RESOURCES_STUBS, res);
  mem.put(mem.path.join(ws, 'main.py'), 'print(1)\n');
  return {
    mem, clock, ws, res, deps: { fs: mem, clock },
    req: (o = {}) => ({ workspace: ws, resourcesDir: res, board: esp32, consent: { createUserConfig: true }, ...(withBoard ? { boardStubs: fromBoard() } : {}), ...o }),
    at: (rel) => mem.path.join(ws, ...rel.split('/')),
  };
}

const readGenerated = (w: World): Record<string, unknown> => parse(w.mem.text(w.at(GEN)) ?? '{}') as Record<string, unknown>;

describe('stock-only workspace (nothing from the board)', () => {
  it('plans and writes the layout contract: active stubs, generated config, user config created once', async () => {
    const w = world();
    const { plan, result } = await runFix(w.deps, w.req(), { apply: true });
    assert.equal(result!.errors.length, 0, JSON.stringify(result!.errors));
    const paths = plan.writes.map((x) => x.path);
    assert.ok(paths.includes(GEN) && paths.includes('pyrightconfig.json'));
    assert.ok(paths.includes(`${DOT}/stubs/active/machine.pyi`) && paths.includes(`${DOT}/stubs/active/os/__init__.pyi`));
    assert.ok(plan.writes.filter((x) => x.path.startsWith(`${DOT}/stubs/active/`)).length > 100);
    assert.deepEqual(readGenerated(w), { pythonPlatform: 'Linux', ignore: ['stubs'], stubPath: 'stubs/active', extraPaths: ['../lib'] });
    const user = parse(w.mem.text(w.at('pyrightconfig.json'))!) as Record<string, unknown>;
    assert.deepEqual(user, { extends: `${DOT}/pyright.generated.json`, typeCheckingMode: 'basic', reportMissingModuleSource: 'none' });
    assert.ok(w.mem.has(w.at(`${DOT}/stubs/active/time.pyi`)));
    assert.ok(!w.mem.has(w.at('typings')), 'no typings/ folder is created');
    assert.ok(!w.mem.has(w.at('.vscode')), 'the workspace settings are not touched');
    assert.match(plan.summary, /^write \d+ file\(s\) \(\d+ new, 0 changed\).*esp32 1\.29\.0\.post1/);
    const tracker = parseTracker(w.mem.text(w.at(TRACKER_REL)));
    assert.ok(tracker !== null && GEN in tracker.files && 'pyrightconfig.json' in tracker.createdOnce && !('pyrightconfig.json' in tracker.files));
    assert.equal(tracker!.createdAt, w.clock.now());
  });

  it('is idempotent: the second run has no writes, says unchanged, and touches no bytes', async () => {
    const w = world();
    await runFix(w.deps, w.req(), { apply: true });
    const before = w.mem.list(w.ws).map((f) => [f, w.mem.text(w.at(f))]);
    w.mem.ops.length = 0;
    w.clock.t += 5000;
    const { plan, result } = await runFix(w.deps, w.req(), { apply: true });
    assert.deepEqual(plan.writes, []);
    assert.deepEqual(plan.removes, []);
    assert.ok(plan.unchanged.length > 100 && plan.unchanged.includes(GEN));
    assert.deepEqual(plan.consent, []);
    assert.match(plan.summary, /up to date/);
    assert.deepEqual(result!.written, []);
    assert.deepEqual(w.mem.ops.filter((o) => o.startsWith('write ')), [], 'not a single file was written');
    assert.deepEqual(w.mem.list(w.ws).map((f) => [f, w.mem.text(w.at(f))]), before);
  });

  it('asks for consent before creating the user-owned config and offers the exact text instead', async () => {
    const w = world();
    const { plan } = await runFix(w.deps, w.req({ consent: {} }), { apply: true });
    assert.deepEqual(plan.consent.map((c) => c.id), ['create-user-config']);
    assert.ok(!w.mem.has(w.at('pyrightconfig.json')));
    const warn = plan.warnings.find((x) => x.code === 'W_USER_CONFIG_MISSING')!;
    assert.match(warn.snippet!, /"extends": "\.upy-bridge\/pyright\.generated\.json"/.source.replace('\\.upy-bridge', `\\${DOT}`).length > 0 ? new RegExp(`"extends": "${DOT.replace('.', '\\.')}/pyright\\.generated\\.json"`) : /x/);
    assert.ok(w.mem.has(w.at(GEN)), 'the managed files are still written');
  });

  it('never overwrites a user-owned config: reports and gives the snippet', async () => {
    for (const [name, text, code] of [
      ['no extends', '{ // mine\n  "typeCheckingMode": "strict", "extraPaths": ["x"],\n}\n', 'W_USER_CONFIG_NO_EXTENDS'],
      ['another extends', '{"extends": "../base.json"}', 'W_USER_CONFIG_OTHER_EXTENDS'],
      ['extends ours but sets extraPaths', `{"extends": "./${DOT}/pyright.generated.json", "extraPaths": ["x"]}`, 'W_USER_CONFIG_OVERRIDES'],
      ['invalid JSON', '{ "extends": ', 'W_USER_CONFIG_INVALID'],
    ] as const) {
      const w = world();
      w.mem.put(w.at('pyrightconfig.json'), text);
      const { plan } = await runFix(w.deps, w.req(), { apply: true });
      assert.equal(w.mem.text(w.at('pyrightconfig.json')), text, `${name}: untouched`);
      const warning = plan.warnings.find((x) => x.code === code);
      assert.ok(warning, `${name}: ${code} in ${plan.warnings.map((x) => x.code).join(',')}`);
      if (code === 'W_USER_CONFIG_NO_EXTENDS' || code === 'W_USER_CONFIG_OTHER_EXTENDS') { assert.ok(warning!.snippet!.includes(`${DOT}/pyright.generated.json`)); }
      assert.ok(!plan.writes.some((x) => x.path === 'pyrightconfig.json'));
      assert.deepEqual(parseTracker(w.mem.text(w.at(TRACKER_REL)))!.createdOnce, {});
    }
  });

  it('does not create pyrightconfig.json when pyproject.toml has [tool.pyright]', async () => {
    const w = world();
    w.mem.put(w.at('pyproject.toml'), '[project]\nname="x"\n\n[tool.pyright]\nreportMissingImports = false\n');
    const { plan } = await runFix(w.deps, w.req(), { apply: true });
    assert.ok(!w.mem.has(w.at('pyrightconfig.json')));
    const warning = plan.warnings.find((x) => x.code === 'W_PYPROJECT_PYRIGHT')!;
    assert.match(warning.snippet!, /^extends = ".*pyright\.generated\.json"$/);
  });

  it('a user-owned file that appears between plan and apply is skipped, not replaced', async () => {
    const w = world();
    const plan = planFix(await prepareFixInputs(w.deps, w.req()));
    w.mem.put(w.at('pyrightconfig.json'), '{"mine": true}');
    const result = await applyPlan(plan, w.mem, w.clock);
    assert.equal(w.mem.text(w.at('pyrightconfig.json')), '{"mine": true}');
    assert.deepEqual(result.skipped.map((s) => s.path), ['pyrightconfig.json']);
    assert.deepEqual(parseTracker(w.mem.text(w.at(TRACKER_REL)))!.createdOnce, {});
  });

  it('retries a locked rename (EBUSY) and keeps going when a file stays locked', async () => {
    const w = world();
    w.mem.failures.push({ op: 'rename', match: /pyright\.generated\.json$/, code: 'EBUSY', times: 2 });
    const first = await runFix(w.deps, w.req(), { apply: true });
    assert.deepEqual(first.result!.errors, []);
    assert.deepEqual(w.clock.sleeps, [50, 80]);
    const w2 = world();
    w2.mem.failures.push({ op: 'rename', match: /pyright\.generated\.json$/, code: 'EPERM', times: 99 });
    const second = await runFix(w2.deps, w2.req(), { apply: true });
    assert.deepEqual(second.result!.errors.map((e) => e.path), [GEN]);
    assert.ok(w2.mem.has(w2.at(`${DOT}/stubs/active/machine.pyi`)), 'the other files were written');
    assert.ok(!w2.mem.has(w2.at(`${GEN}.tmp`)), 'no temp file is left behind');
    assert.ok(!(GEN in parseTracker(w2.mem.text(w2.at(TRACKER_REL)))!.files), 'a file that failed is not claimed as ours');
    w2.mem.failures.length = 0;
    const third = await runFix(w2.deps, w2.req(), { apply: true });
    assert.deepEqual(third.plan.writes.map((x) => x.path), [GEN]);
  });

  it('switching to another port removes exactly the files it created and nothing else', async () => {
    const w = world();
    await runFix(w.deps, w.req(), { apply: true });
    w.mem.put(w.at(`${DOT}/stubs/active/mine.pyi`), '# not ours\n');
    const { plan } = await runFix(w.deps, w.req({ board: rp2 }), { apply: true });
    assert.ok(plan.removes.some((r) => r.path === `${DOT}/stubs/active/esp32.pyi`));
    assert.ok(!plan.removes.some((r) => r.path.endsWith('mine.pyi') || r.path.includes('/os/')));
    assert.ok(!w.mem.has(w.at(`${DOT}/stubs/active/esp32.pyi`)));
    assert.ok(w.mem.has(w.at(`${DOT}/stubs/active/rp2/__init__.pyi`)) || w.mem.has(w.at(`${DOT}/stubs/active/rp2.pyi`)) || plan.writes.some((x) => x.path.includes('rp2')));
    assert.equal(w.mem.text(w.at(`${DOT}/stubs/active/mine.pyi`)), '# not ours\n');
    assert.deepEqual(plan.facts.stock?.portId, 'rp2');
  });

  it('degrades to the standard library overlay for a port without a pack, and says so', async () => {
    const w = world();
    const { plan } = await runFix(w.deps, w.req({ board: { ...esp32, platform: 'zephyr', machine: 'FRDM-K64F' } }), { apply: true });
    assert.equal(plan.facts.stock?.coverage, 'stdlib-only');
    assert.ok(w.mem.has(w.at(`${DOT}/stubs/active/os/__init__.pyi`)) && !w.mem.has(w.at(`${DOT}/stubs/active/machine.pyi`)));
    assert.ok(plan.warnings.some((x) => x.code === 'W_STOCK_NOTE' && /zephyr/.test(x.message)));
  });

  it('with stock stubs switched off the generated file has no stubPath', async () => {
    const w = world();
    const { plan } = await runFix(w.deps, w.req({ stubs: 'off' }), { apply: true });
    assert.ok(plan.warnings.some((x) => x.code === 'W_NO_STOCK_STUBS'));
    assert.equal('stubPath' in readGenerated(w), false);
  });

  it('warns when the workspace folder is not the mirror root', async () => {
    const w = world();
    const { plan } = await runFix(w.deps, w.req({ mirrorRoot: w.mem.path.dirname(w.ws) }), { apply: false });
    assert.ok(plan.warnings.some((x) => x.code === 'W_WORKSPACE_NOT_MIRROR_ROOT'));
  });

  it('lists a typings folder and a course pack that exist, and the user-chosen extra paths', async () => {
    const w = world();
    w.mem.put(w.at('typings/own.pyi'), '');
    w.mem.put(w.at('course-stubs/pack/__init__.py'), '');
    w.mem.mkdirp(w.at('lib'));
    const { plan } = await runFix(w.deps, w.req({ settings: { extraPaths: ['vendor', 'sub/dir'] } }), { apply: true });
    assert.deepEqual(readGenerated(w).extraPaths, ['../lib', '../typings', '../course-stubs', '../vendor', '../sub/dir']);
    assert.deepEqual(readGenerated(w).ignore, ['stubs', '../course-stubs']);
    assert.equal(w.mem.text(w.at('typings/own.pyi')), '', 'an existing typings/ is never touched');
    assert.ok(!plan.writes.some((x) => x.path.startsWith('typings/')));
  });
});

describe('with stubs made from the board (frozen package, C module, board library file)', () => {
  it('writes the board stubs next to the stock stubs and the copies to board-lib/ (in extraPaths and ignored), relative with forward slashes', async () => {
    const w = world('posix', true);
    const { plan, result } = await runFix(w.deps, w.req(), { apply: true });
    assert.deepEqual(result!.errors, []);
    const cfg = readGenerated(w) as { extraPaths: string[]; ignore: string[]; stubPath: string };
    assert.equal(cfg.stubPath, 'stubs/active');
    assert.ok(cfg.extraPaths.includes('board-lib') && cfg.ignore.includes('board-lib'), JSON.stringify(cfg));
    assert.ok(cfg.ignore[0] === 'stubs');
    assert.equal(w.mem.text(w.at(`${DOT}/stubs/active/_acme.pyi`)), 'LIMIT: int\n');
    assert.ok(w.mem.has(w.at(`${DOT}/stubs/active/acme/__init__.pyi`)) && w.mem.has(w.at(`${DOT}/stubs/active/acme/motor.pyi`)));
    assert.match(w.mem.text(w.at(`${DOT}/board-lib/boardhelper.py`)) ?? '', /def board_name/);
    assert.ok(w.mem.has(w.at('.upy-bridge/stubs/active/machine.pyi')), 'the stock stubs are still there');
    assert.deepEqual(plan.facts.board?.modules.map((m) => m.name), ['_acme', 'acme', 'boardhelper']);
    assert.match(plan.summary, /3 module\(s\) of your board/);
    const tracker = parseTracker(w.mem.text(w.at(TRACKER_REL)));
    assert.equal(tracker?.board?.key, 'ACME_BOARD|1.29.0|0123456789abcdef');
    assert.deepEqual(tracker?.board?.files.sort(), [`${DOT}/board-lib/boardhelper.py`, `${DOT}/stubs/active/_acme.pyi`, `${DOT}/stubs/active/acme/__init__.pyi`, `${DOT}/stubs/active/acme/motor.pyi`]);
    const again = await runFix(w.deps, w.req(), { apply: true });
    assert.deepEqual(again.plan.writes, [], 'idempotent');
  });

  it('gives Windows the same relative, forward-slash result', async () => {
    const w = world('win32', true);
    const { result } = await runFix(w.deps, w.req(), { apply: true });
    assert.deepEqual(result!.errors, []);
    const text = w.mem.text(w.at(GEN)) ?? '';
    assert.ok(!text.includes('\\\\'), text);
    assert.ok((readGenerated(w) as { extraPaths: string[] }).extraPaths.includes('board-lib'));
  });

  it('a board stub never replaces a stock stub file', async () => {
    const w = world();
    const { plan } = await runFix(w.deps, w.req({ boardStubs: fromBoard({ stubs: { 'machine.pyi': 'X: int\n', '_acme.pyi': 'LIMIT: int\n' } }) }), { apply: true });
    assert.ok(plan.warnings.some((x) => x.code === 'W_BOARD_STUB_STOCK' && x.path === `${DOT}/stubs/active/machine.pyi`));
    assert.notEqual(w.mem.text(w.at(`${DOT}/stubs/active/machine.pyi`)), 'X: int\n');
    assert.ok(!plan.managedAfter.board?.files.includes(`${DOT}/stubs/active/machine.pyi`));
  });

  it('without a board part (board not connected) the earlier board files stay; a fresh read with fewer modules removes the others', async () => {
    const w = world('posix', true);
    await runFix(w.deps, w.req(), { apply: true });
    const kept = await runFix(w.deps, w.req({ boardStubs: { kind: 'keep', note: 'not connected' } }), { apply: true });
    assert.deepEqual(kept.plan.removes, []);
    assert.deepEqual(kept.plan.writes, []);
    assert.ok(w.mem.has(w.at(`${DOT}/stubs/active/_acme.pyi`)) && w.mem.has(w.at(`${DOT}/board-lib/boardhelper.py`)));
    assert.ok((readGenerated(w) as { extraPaths: string[] }).extraPaths.includes('board-lib'), 'the kept copies stay importable');
    assert.equal(kept.plan.facts.board?.kept, true);
    const fewer = await runFix(w.deps, w.req({ boardStubs: fromBoard({ stubs: { '_acme.pyi': 'LIMIT: int\n' }, lib: {} }) }), { apply: true });
    assert.deepEqual(fewer.plan.removes.map((r) => r.path).sort(), [`${DOT}/board-lib/boardhelper.py`, `${DOT}/stubs/active/acme/__init__.pyi`, `${DOT}/stubs/active/acme/motor.pyi`]);
    assert.ok(!(readGenerated(w) as { extraPaths: string[] }).extraPaths.includes('board-lib'));
  });

  it('with stock stubs switched off the board stubs still get a stubPath', async () => {
    const w = world('posix', true);
    await runFix(w.deps, w.req({ stubs: 'off' }), { apply: true });
    assert.equal((readGenerated(w) as { stubPath?: string }).stubPath, 'stubs/active');
  });

  it('a tracker whose board record names a file that is not tracked is rejected as a whole', () => {
    const ok = { schema: 1, files: { '.upy-bridge/stubs/active/_acme.pyi': 'a' }, board: { key: 'k', label: 'l', date: '2026-10-13', files: ['.upy-bridge/stubs/active/_acme.pyi'], modules: [{ name: '_acme', origin: 'firmware', how: 'stub' }] } };
    assert.equal(parseTracker(JSON.stringify(ok))?.board?.files.length, 1);
    assert.equal(parseTracker(JSON.stringify({ ...ok, board: { ...ok.board, files: ['main.py'] } })), null);
    assert.equal(parseTracker(JSON.stringify({ ...ok, board: { ...ok.board, files: ['.upy-bridge/board-lib/x.py'] } })), null);
  });
});

describe('planFix is pure', () => {
  it('does not change its inputs and returns equal plans for equal inputs', async () => {
    const w = world('posix', true);
    const inputs = await prepareFixInputs(w.deps, w.req());
    const { path: _path, ...data } = inputs;
    void _path;
    const copy = structuredClone(data);
    const a = planFix(inputs);
    const b = planFix(inputs);
    const { path: _p2, ...after } = inputs;
    void _p2;
    assert.deepEqual(after, copy);
    assert.deepEqual(a, b);
    assert.ok(a.writes.length > 100);
    assert.equal(w.mem.ops.length, 0, 'planning wrote nothing');
  });
});

describe('removing what the extension created', () => {
  it('deletes exactly the tracked files and the unchanged user config, and prunes empty folders', async () => {
    const w = world('posix', true);
    w.mem.put(w.at('lib/helper.py'), 'x = 1\n');
    await runFix(w.deps, w.req(), { apply: true });
    w.mem.put(w.at(`${DOT}/stubs/active/mine.pyi`), '# not ours\n');
    const res = await removeManaged(w.mem, w.clock, w.ws);
    assert.deepEqual(res.errors, []);
    assert.ok(res.removed.includes('pyrightconfig.json') && res.removed.includes(GEN) && res.removed.includes(TRACKER_REL));
    assert.ok(!w.mem.has(w.at('pyrightconfig.json')) && !w.mem.has(w.at(GEN)) && !w.mem.has(w.at(`${DOT}/stubs/active/_acme.pyi`)));
    assert.ok(!w.mem.has(w.at(`${DOT}/board-lib`)), 'the copies of the board files are removed too');
    assert.equal(w.mem.text(w.at(`${DOT}/stubs/active/mine.pyi`)), '# not ours\n', 'a file we did not create stays');
    assert.equal(w.mem.text(w.at('lib/helper.py')), 'x = 1\n');
    assert.equal(w.mem.text(w.at('main.py')), 'print(1)\n');
    assert.ok(w.mem.has(w.at(`${DOT}/stubs/active`)), 'a folder that still holds a foreign file is kept');
  });

  it('keeps a user config the user has edited, and a second removal has nothing to do', async () => {
    const w = world();
    await runFix(w.deps, w.req(), { apply: true });
    w.mem.put(w.at('pyrightconfig.json'), '{"extends": ".upy-bridge/pyright.generated.json", "typeCheckingMode": "strict"}\n');
    const res = await removeManaged(w.mem, w.clock, w.ws);
    assert.deepEqual(res.keptEdited, ['pyrightconfig.json']);
    assert.ok(w.mem.has(w.at('pyrightconfig.json')));
    assert.ok(!w.mem.has(w.at(DOT)), 'the dot folder is gone');
    assert.equal((await removeManaged(w.mem, w.clock, w.ws)).nothingToDo, true);
  });
});

describe('fallback tier (typings/ and workspace settings, add-only)', () => {
  const SETTINGS = '{\r\n\t// my comment\r\n\t"editor.fontSize": 14, // keep this\r\n\t"files.exclude": { "**/.git": true, },\r\n}\r\n';

  it('copies stock stubs to typings/, adds the two settings with a marker, keeps comments and CRLF, then reverses it', async () => {
    const w = world();
    w.mem.put(w.at('.vscode/settings.json'), SETTINGS);
    const { plan, result } = await runFix(w.deps, w.req({ settings: { fallback: true }, consent: { editSettings: true } }), { apply: true });
    assert.deepEqual(result!.errors, []);
    assert.ok(w.mem.has(w.at('typings/machine.pyi')) && !w.mem.has(w.at(`${DOT}/stubs`)) && !w.mem.has(w.at('pyrightconfig.json')));
    assert.ok(plan.warnings.some((x) => x.code === 'W_PLATFORM_NOT_PINNED'));
    const text = w.mem.text(w.at('.vscode/settings.json'))!;
    assert.ok(text.includes('// my comment') && text.includes('// keep this') && text.includes('"files.exclude"') && text.includes('\r\n') && !/[^\r]\n/.test(text));
    const obj = parse(text) as Record<string, unknown>;
    assert.deepEqual(obj['python.analysis.extraPaths'], ['lib']);
    assert.deepEqual(obj['python.analysis.ignore'], ['typings']);
    assert.equal(obj['editor.fontSize'], 14);
    assert.equal((text.match(/added by the IntelliSense fallback/g) ?? []).length, 2);
    const removed = await removeManaged(w.mem, w.clock, w.ws);
    assert.deepEqual(removed.settingsRemoved.sort(), ['python.analysis.extraPaths', 'python.analysis.ignore']);
    const after = w.mem.text(w.at('.vscode/settings.json'))!;
    assert.ok(after.includes('// my comment') && after.includes('// keep this') && !after.includes('python.analysis') && !after.includes('IntelliSense fallback'));
    assert.deepEqual(parse(after), { 'editor.fontSize': 14, 'files.exclude': { '**/.git': true } });
    assert.ok(!w.mem.has(w.at('typings')));
  });

  it('needs consent for the settings and writes nothing there without it', async () => {
    const w = world();
    const { plan } = await runFix(w.deps, w.req({ settings: { fallback: true } }), { apply: true });
    assert.deepEqual(plan.consent.map((c) => c.id), ['edit-settings']);
    assert.ok(!w.mem.has(w.at('.vscode/settings.json')));
    assert.ok(w.mem.has(w.at('typings/machine.pyi')));
  });

  it('never edits an array the user owns, and says what to add', async () => {
    const w = world();
    const mine = '{\n  "python.analysis.extraPaths": ["mine"] // user array\n}\n';
    w.mem.put(w.at('.vscode/settings.json'), mine);
    const { plan } = await runFix(w.deps, w.req({ settings: { fallback: true }, consent: { editSettings: true } }), { apply: true });
    const edits = Object.fromEntries(plan.settingsEdits.map((e) => [e.key, e.action]));
    assert.deepEqual(edits, { 'python.analysis.extraPaths': 'exists', 'python.analysis.ignore': 'add' });
    const warning = plan.warnings.find((x) => x.code === 'W_SETTING_EXISTS')!;
    assert.match(warning.snippet!, /"python\.analysis\.extraPaths": \["\.\.?\/?lib"\]|"python\.analysis\.extraPaths": \["lib"\]/);
    const text = w.mem.text(w.at('.vscode/settings.json'))!;
    assert.ok(text.includes('["mine"]') && text.includes('// user array'));
    assert.deepEqual((parse(text) as Record<string, unknown>)['python.analysis.extraPaths'], ['mine']);
    await removeManaged(w.mem, w.clock, w.ws);
    assert.ok(w.mem.text(w.at('.vscode/settings.json'))!.includes('["mine"]') && w.mem.text(w.at('.vscode/settings.json'))!.includes('// user array'), 'removal never touches the user\'s array');
  });

  it('never touches a typings/ folder that exists, and warns that a config file disables the settings route', async () => {
    const w = world();
    w.mem.put(w.at('typings/own.pyi'), '# mine\n');
    w.mem.put(w.at('pyrightconfig.json'), '{}');
    const { plan } = await runFix(w.deps, w.req({ settings: { fallback: true }, consent: { editSettings: true } }), { apply: true });
    assert.ok(plan.warnings.some((x) => x.code === 'W_TYPINGS_EXISTS'));
    assert.ok(plan.warnings.some((x) => x.code === 'W_FALLBACK_IGNORED'));
    assert.ok(!plan.writes.some((x) => x.path.startsWith('typings/')));
    assert.deepEqual(w.mem.list(w.at('typings')), ['own.pyi']);
    assert.equal(w.mem.text(w.at('typings/own.pyi')), '# mine\n');
  });

  it('refuses to edit a settings file that is not valid JSON with comments', async () => {
    const w = world();
    w.mem.put(w.at('.vscode/settings.json'), '{ "a": ');
    const { plan } = await runFix(w.deps, w.req({ settings: { fallback: true }, consent: { editSettings: true } }), { apply: true });
    assert.ok(plan.warnings.some((x) => x.code === 'W_SETTINGS_INVALID'));
    assert.equal(w.mem.text(w.at('.vscode/settings.json')), '{ "a": ');
  });
});

describe('settings edits (jsonc-parser)', () => {
  it('handles an absent or empty file, a BOM, tabs and trailing commas', () => {
    const fresh = addSettingsKeys(null, [{ key: 'a.b', value: [1] }]);
    assert.deepEqual(parse(fresh.text), { 'a.b': [1] });
    const bom = addSettingsKeys('\uFEFF{\n\t"x": 1,\n}\n', [{ key: 'a.b', value: 'v' }]);
    assert.equal(bom.text.charCodeAt(0), 0xfeff);
    assert.ok(bom.text.includes('\t"a.b": "v"'));
    assert.deepEqual(parse(bom.text.slice(1)), { x: 1, 'a.b': 'v' });
    const again = addSettingsKeys(bom.text, [{ key: 'a.b', value: 'other' }]);
    assert.deepEqual(again.existing, ['a.b']);
    assert.equal(again.text, bom.text, 'a second add changes nothing');
    const removed = removeSettingsKeys(bom.text, [{ key: 'a.b', value: 'v' }, { key: 'x', value: 2 }]);
    assert.deepEqual(removed.removed, ['a.b']);
    assert.deepEqual(removed.kept, ['x'], 'a key whose value is no longer the one we wrote stays');
  });
});
