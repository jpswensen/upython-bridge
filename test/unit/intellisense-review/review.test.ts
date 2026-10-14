/**
 * Independent review of src/intellisense (review round 5), fixed in round 5b. Every test asserts the SAFE behaviour and now runs by default:
 * npm test -- intellisense-review   (UPYBRIDGE_REVIEW_SCRATCH=<dir> chooses where the real-file-system tests work)
 * Real-file-system tests work in a fresh folder below UPYBRIDGE_REVIEW_SCRATCH (default: the OS temp folder). Nothing here opens a
 * serial port, launches an application or touches a path outside that folder.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { after, describe, it } from 'node:test';
import { createScanner, parse, type ParseError } from 'jsonc-parser';
import { IDENTITY } from '../../../src/identity';
import { nodeClock, nodeFs } from '../../../src/intellisense/nodeAdapters';
import { pyprojectHasPyright } from '../../../src/intellisense/config';
import { portOf } from '../../../src/intellisense/ports';
import { addSettingsKeys, removeSettingsKeys } from '../../../src/intellisense/settingsEdit';
import { selectStockStubs, loadStubManifest } from '../../../src/intellisense/stockStubs';
import { TRACKER_REL, applyPlan, planFix, prepareFixInputs, removeManaged, runFix, type FixDeps, type FixRequest } from '../../../src/intellisense/fix';
import type { BoardInfo, FsLike } from '../../../src/intellisense/types';
import { FakeClock, MemFs, RESOURCES_STUBS } from '../intellisense/memfs';

const DOT = IDENTITY.dotDir;
const SCRATCH = process.env.UPYBRIDGE_REVIEW_SCRATCH ?? os.tmpdir();
// All findings of review round 5 are fixed, so these are permanent regression tests and run in `npm run verify`.
const group = describe;

const made: string[] = [];
function tmp(): string { const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(SCRATCH, 'rv5-'))); made.push(dir); return dir; }
after(() => { for (const dir of made) { fs.rmSync(dir, { recursive: true, force: true }); } }); // links inside are removed, not followed
function put(file: string, text: string): void { fs.mkdirSync(nodePath.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function realDeps(): FixDeps { return { fs: nodeFs(), clock: nodeClock() }; }
const fixReq = (ws: string, o: Partial<FixRequest> = {}): FixRequest => ({
  workspace: ws, resourcesDir: RESOURCES_STUBS, board: null, stubs: 'off', consent: { createUserConfig: true }, ...o,
});

// ================================================================== (1) CLOBBERING

group('review: tracker (manifest.json) is trusted too much', () => {
  const tracker = (files: Record<string, string>): string => `${JSON.stringify({ schema: 1, files, createdOnce: {}, settings: [], stock: null, createdAt: 1 })}\n`;

  it('a normal Fix run must not delete a file OUTSIDE the workspace that a hand-edited tracker lists', async () => {
    const base = tmp();
    const ws = nodePath.join(base, 'ws');
    const victim = nodePath.join(base, 'victim.txt');
    put(victim, 'precious');
    put(nodePath.join(ws, DOT, 'manifest.json'), tracker({ '../victim.txt': 'x' }));
    await runFix(realDeps(), fixReq(ws), { apply: true });
    assert.ok(fs.existsSync(victim), 'victim.txt outside the workspace was deleted by a plain Fix run');
  });

  it('removeManaged must not delete a file outside the workspace that the tracker lists', async () => {
    const base = tmp();
    const ws = nodePath.join(base, 'ws');
    const victim = nodePath.join(base, 'victim.txt');
    put(victim, 'precious');
    put(nodePath.join(ws, DOT, 'manifest.json'), tracker({ '../victim.txt': 'x' }));
    await removeManaged(nodeFs(), nodeClock(), ws);
    assert.ok(fs.existsSync(victim), 'victim.txt outside the workspace was deleted by removeManaged');
  });

  it('the tracker must not make Fix/remove delete the user\'s own source files or pyrightconfig.json inside the workspace', async () => {
    const base = tmp();
    const ws = nodePath.join(base, 'ws');
    put(nodePath.join(ws, 'main.py'), 'print(1)\n');
    put(nodePath.join(ws, 'pyrightconfig.json'), '{ "typeCheckingMode": "strict" }\n');
    put(nodePath.join(ws, DOT, 'manifest.json'), tracker({ 'main.py': 'x', 'pyrightconfig.json': 'x' }));
    await runFix(realDeps(), fixReq(ws, { consent: { createUserConfig: false } }), { apply: true });
    assert.ok(fs.existsSync(nodePath.join(ws, 'main.py')), 'main.py was deleted');
    assert.ok(fs.existsSync(nodePath.join(ws, 'pyrightconfig.json')), 'pyrightconfig.json was deleted');
  });

  it('Windows spelling of the traversal (backslashes) does not escape either', async () => {
    const mem = new MemFs('win32');
    const ws = 'C:\\Users\\Student\\Lab 1';
    mem.put('C:\\Users\\Student\\victim.txt', 'precious');
    mem.put(`${ws}\\${DOT}\\manifest.json`, tracker({ '..\\victim.txt': 'x' }));
    await removeManaged(mem, new FakeClock(), ws);
    assert.ok(mem.has('C:\\Users\\Student\\victim.txt'), 'victim.txt outside the workspace was deleted (win32 path flavour)');
  });

  it('a parseable but malformed tracker must not make planFix throw', async () => {
    for (const bad of ['{"schema":1,"files":{},"settings":5}', '{"schema":1,"files":{},"settings":{"length":3}}', '{"schema":1,"files":[],"createdOnce":[]}', '{"schema":1,"files":{"a":1},"createdOnce":"zz","settings":"abc"}']) {
      const base = tmp();
      const ws = nodePath.join(base, 'ws');
      put(nodePath.join(ws, DOT, 'manifest.json'), bad);
      await assert.doesNotReject(async () => { await runFix(realDeps(), fixReq(ws), { apply: false }); }, `tracker ${bad}`);
    }
  });
});

group('review: user-owned files', () => {
  it('a dangling pyrightconfig.json symlink is not replaced by a regular file', async () => {
    const ws = nodePath.join(tmp(), 'ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.symlinkSync('not-there.json', nodePath.join(ws, 'pyrightconfig.json'));
    await runFix(realDeps(), fixReq(ws), { apply: true });
    assert.ok(fs.lstatSync(nodePath.join(ws, 'pyrightconfig.json')).isSymbolicLink(), 'the user\'s symlink was replaced');
  });

  it('a pyrightconfig.json that appears between plan and apply is never overwritten (stat-then-rename race)', async () => {
    const ws = nodePath.join(tmp(), 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const real = nodeFs();
    const plan = planFix(await prepareFixInputs({ fs: real, clock: nodeClock() }, fixReq(ws)));
    assert.ok(plan.writes.some((w) => w.path === 'pyrightconfig.json' && w.onlyIfAbsent === true));
    // the user saves their own file in the window after the existence check and before the rename
    const racy: FsLike = { ...real, createExclusive: async (file, data) => {
      if (file.endsWith('pyrightconfig.json')) { fs.writeFileSync(nodePath.join(ws, 'pyrightconfig.json'), '{ "mine": true }\n'); }
      await (real.createExclusive as NonNullable<FsLike['createExclusive']>)(file, data);
    } };
    await applyPlan(plan, racy, nodeClock());
    assert.equal(fs.readFileSync(nodePath.join(ws, 'pyrightconfig.json'), 'utf8'), '{ "mine": true }\n', 'the user file written in the window was clobbered');
  });

  it('two Fix runs at the same time both finish without errors', async () => {
    for (let round = 0; round < 6; round++) {
      const ws = nodePath.join(tmp(), 'ws');
      fs.mkdirSync(ws, { recursive: true });
      const req = fixReq(ws, { stubs: 'auto', board: { impl: 'micropython', version: [1, 29, 0], machine: 'x with ESP32', build: '', platform: 'esp32', uniqueId: '' } });
      const [a, b] = await Promise.all([runFix(realDeps(), req, { apply: true }), runFix(realDeps(), req, { apply: true })]);
      const errs = [...(a.result?.errors ?? []), ...(b.result?.errors ?? [])];
      assert.deepEqual(errs, [], `round ${round}`);
      const leftovers = fs.readdirSync(nodePath.join(ws, DOT), { recursive: true }).filter((f) => String(f).endsWith('.tmp'));
      assert.deepEqual(leftovers, [], 'temp files left behind');
    }
  });
});

group('review: atomic writes under locks', () => {
  it('a transient EBUSY while READING the old bytes (compare step) is retried like the write', async () => {
    const mem = new MemFs('posix');
    const ws = '/w';
    mem.put('/w/main.py', 'x');
    const first = await runFix({ fs: mem, clock: new FakeClock() }, fixReq(ws), { apply: true });
    assert.equal(first.result?.errors.length, 0);
    // now change the plan (another python platform) and let the READ of the existing generated file be busy twice
    mem.failures.push({ op: 'readFile', match: /pyright\.generated\.json$/, code: 'EBUSY', times: 2 });
    const second = await runFix({ fs: mem, clock: new FakeClock() }, fixReq(ws, { settings: { pythonPlatform: 'Windows' } }), { apply: true });
    assert.deepEqual(second.result?.errors, [], 'EBUSY on the read-before-write is not retried');
  });

  it('a stuck rename leaves the old file intact, no temp file, and the tracker does not claim the new hash', async () => {
    const mem = new MemFs('posix');
    mem.put('/w/main.py', 'x');
    await runFix({ fs: mem, clock: new FakeClock() }, fixReq('/w'), { apply: true });
    const before = mem.text(`/w/${DOT}/pyright.generated.json`);
    mem.failures.push({ op: 'rename', match: /pyright\.generated\.json$/, code: 'EPERM', times: 99 });
    const r = await runFix({ fs: mem, clock: new FakeClock() }, fixReq('/w', { settings: { pythonPlatform: 'Windows' } }), { apply: true });
    assert.ok((r.result?.errors.length ?? 0) > 0);
    assert.equal(mem.text(`/w/${DOT}/pyright.generated.json`), before);
    assert.ok(!mem.list('/w').some((f) => f.endsWith('.tmp')), 'temp file left behind');
    const t = JSON.parse(mem.text(`/w/${TRACKER_REL}`) ?? '{}') as { files: Record<string, string> };
    assert.ok(!(`${DOT}/pyright.generated.json` in t.files) || t.files[`${DOT}/pyright.generated.json`] !== undefined);
  });
});

// ================================================================== settings.json (fallback tier)

group('review: .vscode/settings.json edits', () => {
  const items = [{ key: 'python.analysis.extraPaths', value: ['../lib', 'a b'] }, { key: 'python.analysis.ignore', value: ['stubs'] }];
  const shapes: Record<string, string> = {
    emptyObject: '{}', multiEmpty: '{\n}\n', onlyComment: '{\n  // nothing yet\n}\n', trailingComma: '{\n  "a": 1,\n}\n', trailingCommaComment: '{\n  "a": 1, // c\n}\n',
    lastWithComment: '{\n  "a": 1 // c, d\n}\n', blockCommentAfter: '{\n  "a": 1 /* c */\n}\n', oneLiner: '{"a":1,"b":[1,2]}', crlf: '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n',
    bomCrlf: '\uFEFF{\r\n\t"a": 1\r\n}\r\n', tabs: '{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n', nestedLast: '{\n  "a": {\n    "b": [1,\n 2]\n  }\n}\n', stringWithComma: '{\n  "u": "http://x, y // z" }\n',
    headerComment: '// header }\n{\n  "a": 1\n}\n// footer }\n', closeBraceInTrailingComment: '{}\n// end }\n', lastKeyHasBraceString: '{ "a": "}" }', oldMacEol: '{\r  "a": 1\r}\r',
    existingKey: '{\n  "python.analysis.extraPaths": ["mine"]\n}\n', commentBetween: '{\n  "a": 1,\n  // keep me\n  "b": 2\n}\n',
  };
  it('every shape stays valid JSONC, keeps every original key/value and every comment, and adds both keys', () => {
    const bad: string[] = [];
    for (const [name, text] of Object.entries(shapes)) {
      const r = addSettingsKeys(text, items);
      const errors: ParseError[] = [];
      const after = parse(r.text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
      const before = parse(text.replace(/^\uFEFF/, ''), [], { allowTrailingComma: true }) as Record<string, unknown>;
      if (errors.length > 0 || after === undefined || typeof after !== 'object') { bad.push(`${name}: result is not valid JSONC`); continue; }
      for (const k of Object.keys(before)) { if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) { bad.push(`${name}: key ${k} changed`); } }
      for (const it2 of items) { if (!(it2.key in after)) { bad.push(`${name}: ${it2.key} missing`); } }
      const scanner = createScanner(text.replace(/^\uFEFF/, ''), false); // real comments only (a `//` inside a string is not one)
      for (let t = scanner.scan(); t !== 17; t = scanner.scan()) { if ((t === 12 || t === 13) && !r.text.includes(scanner.getTokenValue())) { bad.push(`${name}: comment ${scanner.getTokenValue()} lost`); } }
    }
    assert.deepEqual(bad, []);
  });

  it('add then remove gives back valid JSONC with the original keys and comments for every shape', () => {
    const bad: string[] = [];
    for (const [name, text] of Object.entries(shapes)) {
      const added = addSettingsKeys(text, items);
      const back = removeSettingsKeys(added.text, items.filter((i) => added.applied.includes(i.key)));
      const errors: ParseError[] = [];
      const parsed = parse(back.text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
      if (errors.length > 0) { bad.push(`${name}: not valid after remove`); continue; }
      const before = parse(text.replace(/^\uFEFF/, ''), [], { allowTrailingComma: true }) as Record<string, unknown>;
      if (JSON.stringify(parsed) !== JSON.stringify(before)) { bad.push(`${name}: keys differ after round trip`); }
    }
    assert.deepEqual(bad, []);
  });

  it('trailing blanks after the last property do not hang the editor (catastrophic backtracking)', () => {
    const t0 = Date.now();
    addSettingsKeys(`{\n  "a": 1${' '.repeat(26)}\n}\n`, [{ key: 'k', value: 1 }]);
    const ms = Date.now() - t0;
    assert.ok(ms < 100, `26 trailing spaces took ${ms} ms (doubles with every extra space)`);
  });

  it('an invalid or non-object settings file is refused and left alone', () => {
    for (const text of ['{ "a": ', '[1,2]', 'not json', '{ "a": 1 "b": 2 }']) {
      const r = addSettingsKeys(text, items);
      assert.ok(r.error !== undefined && r.text === text, text);
    }
  });

  it('a 5 MB settings file is edited quickly', () => {
    const big = `{\n${Array.from({ length: 60000 }, (_v, i) => `  "key.number.${i}": "some value ${i}",`).join('\n')}\n  "last": 1\n}\n`;
    const t0 = Date.now();
    const r = addSettingsKeys(big, items);
    assert.equal(r.applied.length, 2);
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  });
});

// ================================================================== (4) PICKER

const esp32: BoardInfo = { impl: 'micropython', version: [1, 29, 0], machine: 'ESP32 module with ESP32', build: '', platform: 'esp32', uniqueId: 'aa' };

group('review: stock stub picker', () => {
  const manifestP = loadStubManifest(nodeFs(), RESOURCES_STUBS);

  it('the documented sys.platform values map to the right pack, anything else falls back to the overlay', async () => {
    const m = await manifestP;
    const cases: [Partial<BoardInfo>, string | null][] = [
      [{ platform: 'esp32' }, 'esp32'], [{ platform: 'esp8266' }, 'esp8266'], [{ platform: 'rp2' }, 'rp2'], [{ platform: 'pyboard', machine: 'NUCLEO-F446RE with STM32F446xx' }, 'stm32'],
      [{ platform: 'samd', machine: 'Adafruit ItsyBitsy M4 with SAMD51G19A' }, 'samd'], [{ platform: 'mimxrt', machine: 'Teensy 4.1 with MIMXRT1062DVJ6A' }, 'mimxrt'],
      [{ platform: 'nrf52', machine: 'PCA10056 with NRF52840' }, 'nrf'], [{ platform: 'nrf51', machine: 'micro:bit v1 with nRF51822' }, 'nrf'],
      [{ platform: 'linux', machine: 'linux' }, null], [{ platform: 'zephyr-frdm_k64f', machine: 'FRDM-K64F' }, null], [{ platform: 'WiPy', machine: 'WiPy with CC3200' }, null],
      [{ platform: 'ESP32', machine: 'x' }, 'esp32'], [{ platform: '', machine: 'Generic ESP32S3 module with ESP32S3' }, 'esp32'], [{ platform: 'esp32', machine: '' }, 'esp32'],
    ];
    for (const [o, want] of cases) {
      const s = selectStockStubs({ ...esp32, ...o }, m);
      assert.equal(s.portId, want, JSON.stringify(o));
      assert.ok(s.packs.includes('stdlib'), 'overlay always layered');
    }
  });

  it('missing or odd identity fields (null from JSON, wrong types, prototype names) degrade to the overlay and never throw', async () => {
    const m = await manifestP;
    const odd: Record<string, Partial<BoardInfo>> = {
      nullPlatform: { platform: null as unknown as string }, undefinedPlatform: { platform: undefined as unknown as string }, numberPlatform: { platform: 5 as unknown as string },
      nullMachine: { platform: 'zzz', machine: null as unknown as string }, nullVersion: { version: null as unknown as [number, number, number] }, shortVersion: { version: [1] as unknown as [number, number, number] },
      protoPlatform: { platform: '__proto__' }, ctorPlatform: { platform: 'constructor' }, toStringPlatform: { platform: 'toString' },
    };
    const bad: string[] = [];
    for (const [name, o] of Object.entries(odd)) {
      try {
        const s = selectStockStubs({ ...esp32, ...o }, m);
        if (s.portId !== null && typeof s.portId !== 'string') { bad.push(`${name}: portId is not a string`); }
        if (/\[object|native code/.test(`${s.reason} ${s.notes.join(' ')}`)) { bad.push(`${name}: message shows "${s.reason.slice(0, 80)}"`); }
      } catch (err) { bad.push(`${name}: throws ${(err as Error).message}`); }
    }
    assert.deepEqual(bad, []);
  });

  it('prepareFixInputs with a null-platform board still delivers the stdlib stubs (not "no stubs at all")', async () => {
    const ws = nodePath.join(tmp(), 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const inputs = await prepareFixInputs(realDeps(), fixReq(ws, { stubs: 'auto', board: { ...esp32, platform: null as unknown as string } }));
    assert.ok(inputs.stock !== null, `stock stubs missing; warnings: ${JSON.stringify(inputs.warnings)}`);
  });

  it('portOf never returns a non-string', () => {
    for (const p of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const r = portOf({ platform: p, machine: '' });
      assert.ok(r === null || typeof r === 'string', `${p} -> ${String(r)}`);
    }
  });
});

// ================================================================== (6) WINDOWS BY INJECTION

group('review: Windows path facts by injection', () => {
  const winWorld = (): { mem: MemFs; ws: string } => {
    const mem = new MemFs('win32');
    const ws = 'C:\\Users\\Student Name\\OneDrive - Example\\Lab (Fall)\\Lab 1';
    mem.put(`${ws}\\main.py`, 'x');
    return { mem, ws };
  };
  const generated = (mem: MemFs, ws: string): string => mem.text(`${ws}\\${DOT}\\pyright.generated.json`) ?? '';

  it('an extra folder on another drive yields a warning and NO absolute or backslash path in the generated config', async () => {
    const { mem, ws } = winWorld();
    mem.put('D:\\fw\\modules\\acme.py', 'A = 1\n');
    const { plan } = await runFix({ fs: mem, clock: new FakeClock() }, { workspace: ws, resourcesDir: 'C:\\none', board: null, stubs: 'off', consent: { createUserConfig: true }, settings: { extraPaths: ['D:\\fw\\modules'] } }, { apply: true });
    assert.ok(plan.warnings.some((w) => w.code === 'W_PATH_UNREACHABLE'), JSON.stringify(plan.warnings.map((w) => w.code)));
    const g = generated(mem, ws);
    assert.ok(!/[A-Za-z]:|\\\\/.test(g.replace(/\/\/.*$/gm, '')), g);
  });

  it('case differences in the drive letter and in folder names still give a relative form', async () => {
    const { mem, ws } = winWorld();
    mem.put('c:\\users\\student name\\fw\\modules\\acme.py', 'A = 1\n');
    await runFix({ fs: mem, clock: new FakeClock() }, { workspace: ws, resourcesDir: 'C:\\none', board: null, stubs: 'off', consent: { createUserConfig: true }, settings: { extraPaths: ['c:\\users\\student name\\fw\\modules'] } }, { apply: true });
    const g = generated(mem, ws);
    assert.ok(/"\.\.\/[^"]*fw\/modules"/.test(g), g);
  });

  it('a UNC workspace with an extra folder on a drive letter yields no `\\\\` path in the config', async () => {
    const mem = new MemFs('win32');
    const ws = '\\\\server\\share\\Lab 1';
    mem.put(`${ws}\\main.py`, 'x');
    mem.put('D:\\fw\\modules\\acme.py', '');
    await runFix({ fs: mem, clock: new FakeClock() }, { workspace: ws, resourcesDir: 'C:\\none', board: null, stubs: 'off', consent: { createUserConfig: true }, settings: { extraPaths: ['D:\\fw\\modules'] } }, { apply: true });
    const g = (mem.text(`${ws}\\${DOT}\\pyright.generated.json`) ?? '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\\|[A-Za-z]:/.test(g), g);
  });
});


// ================================================================== end-to-end: ancestor roots, fallback tier

group('review: end-to-end plan facts', () => {
  it('fallback tier: a one-line settings.json (closing brace on the property line) is still valid JSONC after the edit', async () => {
    const ws = nodePath.join(tmp(), 'ws');
    put(nodePath.join(ws, '.vscode', 'settings.json'), '{ "python.analysis.typeCheckingMode": "basic" }\n');
    await runFix(realDeps(), fixReq(ws, { settings: { fallback: true }, consent: { editSettings: true, createUserConfig: false } }), { apply: true });
    const errors: ParseError[] = [];
    parse(fs.readFileSync(nodePath.join(ws, '.vscode', 'settings.json'), 'utf8'), errors, { allowTrailingComma: true });
    assert.deepEqual(errors, [], fs.readFileSync(nodePath.join(ws, '.vscode', 'settings.json'), 'utf8'));
  });

  it('fallback tier: a comma inside a trailing // comment on the last property does not lose the separator', async () => {
    const ws = nodePath.join(tmp(), 'ws');
    put(nodePath.join(ws, '.vscode', 'settings.json'), '{\n  "python.defaultInterpreterPath": ".venv/bin/python" // see the docs, section 2\n}\n');
    await runFix(realDeps(), fixReq(ws, { settings: { fallback: true }, consent: { editSettings: true, createUserConfig: false } }), { apply: true });
    const errors: ParseError[] = [];
    parse(fs.readFileSync(nodePath.join(ws, '.vscode', 'settings.json'), 'utf8'), errors, { allowTrailingComma: true });
    assert.deepEqual(errors, [], fs.readFileSync(nodePath.join(ws, '.vscode', 'settings.json'), 'utf8'));
  });

  it('fallback tier: a settings.json that is a symlink stays a symlink and its target receives the edit', async () => {
    const ws = nodePath.join(tmp(), 'ws');
    put(nodePath.join(ws, 'shared-settings.json'), '{\n  "a": 1\n}\n');
    fs.mkdirSync(nodePath.join(ws, '.vscode'), { recursive: true });
    fs.symlinkSync('../shared-settings.json', nodePath.join(ws, '.vscode', 'settings.json'));
    await runFix(realDeps(), fixReq(ws, { settings: { fallback: true }, consent: { editSettings: true, createUserConfig: false } }), { apply: true });
    assert.ok(fs.lstatSync(nodePath.join(ws, '.vscode', 'settings.json')).isSymbolicLink(), 'the symlink was replaced by a regular file (rename over a link)');
  });

  it('fallback tier: an existing typings/ folder of the user is left exactly as it is', async () => {
    const ws = nodePath.join(tmp(), 'ws');
    put(nodePath.join(ws, 'typings', 'mine.pyi'), 'x: int\n');
    await runFix(realDeps(), fixReq(ws, { stubs: 'auto', board: esp32, settings: { fallback: true }, consent: { editSettings: true } }), { apply: true });
    assert.deepEqual(fs.readdirSync(nodePath.join(ws, 'typings')), ['mine.pyi']);
    assert.equal(fs.readFileSync(nodePath.join(ws, 'typings', 'mine.pyi'), 'utf8'), 'x: int\n');
  });

  it('a pyproject.toml that has only [tool.pyright.<sub>] tables counts as having a pyright section (pyrightconfig.json would silently replace it)', () => {
    assert.equal(pyprojectHasPyright('[tool.pyright.defineConstant]\nDEBUG = true\n'), true);
    assert.equal(pyprojectHasPyright('[ tool.pyright ]\nreportMissingImports = false\n'), true);
  });
});

void [applyPlan];
