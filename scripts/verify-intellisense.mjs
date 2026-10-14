// TRUTH TEST for the IntelliSense library: runs a REAL pyright over scratch workspaces before and after the fix-up.
// Not part of `npm run verify` (it needs pyright, and downloads it with npx the first time).
//
//   MPY_SAFE_MODE=1 node scripts/verify-intellisense.mjs [--scratch <dir>] [--json]
//
// Scenarios (all in the scratch folder, never in the repository; no board, no serial port, no VS Code):
//   acme    student code for a made-up custom firmware; the board itself is a fake built from the bridge-shaped answers in
//           test/fixtures/intellisense/acme-board.json (frozen package acme with motor/pins, C module _acme, /lib/helper.py on
//           the board, a local typings/acme_extra.pyi that must win). The stubs are generated FROM THE BOARD (board.ts), never
//           from firmware source folders -> BEFORE: imports unresolved / stdlib calls flagged; AFTER: 0 errors in main.py
//           (`import acme`, `acme.Motor(1).gains(1, 2, 3)`, `acme.pins.MOT1`, `_acme.LIMIT`, the /lib copy), and the two
//           deliberately misspelled members in wrong.py (`acme.Motr`, `acme.Motor(1).gainz`) ARE flagged.
//   rp2, esp8266   a stock-only workspace.
// pyright: `UPYBRIDGE_PYRIGHT` unset or "1" -> `npx --yes pyright@<PYRIGHT_VERSION>` (cache kept in the scratch folder);
//          a path ending in .js/.mjs/.cjs -> run with this Node; any other path -> run that executable.
// Exit code 0 when every expectation holds.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Pinned: the version the layout contract (docs/analysis/07-linting-stubs.md P.4) was verified with. */
export const PYRIGHT_VERSION = '1.1.414';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const scratch = path.resolve(argValue('--scratch') ?? process.env.UPYBRIDGE_SCRATCH ?? path.join(os.tmpdir(), 'upy-bridge-truth'));
const asJson = args.includes('--json');
const relToRepo = path.relative(root, scratch);
if (!relToRepo.startsWith('..') && !path.isAbsolute(relToRepo)) {
  console.error(`Refusing to use a scratch folder inside the repository (${scratch}). Pass --scratch <dir> elsewhere.`);
  process.exit(2);
}
process.env.MPY_SAFE_MODE = '1';
fs.mkdirSync(scratch, { recursive: true });
for (const name of fs.readdirSync(scratch)) {
  if (name !== 'npm-cache') { fs.rmSync(path.join(scratch, name), { recursive: true, force: true }); } // keep the npm cache between runs
}

// ---------------------------------------------------------------- the library, bundled from source
const bundle = path.join(scratch, 'intellisense.cjs');
await build({ entryPoints: [path.join(root, 'src', 'intellisense', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, mainFields: ['module', 'main'], absWorkingDir: root, logLevel: 'warning' });
const lib = createRequire(import.meta.url)(bundle);
const fixtures = path.join(root, 'test', 'fixtures', 'intellisense');
const resourcesDir = path.join(root, 'resources', 'stubs');

// ---------------------------------------------------------------- pyright
const pyrightCwd = path.join(scratch, 'pyright-run');
fs.mkdirSync(pyrightCwd, { recursive: true });
function pyrightCommand(project) {
  const given = process.env.UPYBRIDGE_PYRIGHT;
  const tail = ['--outputjson', '-p', project];
  if (given && given !== '1') {
    return /\.(c|m)?js$/.test(given) ? [process.execPath, [given, ...tail]] : [given, tail];
  }
  return [process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', `pyright@${PYRIGHT_VERSION}`, ...tail]];
}
function runPyright(project) {
  const [file, argv] = pyrightCommand(project);
  const r = spawnSync(file, argv, {
    cwd: pyrightCwd, encoding: 'utf8', timeout: 300_000, shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MPY_SAFE_MODE: '1', npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_update_notifier: 'false' },
  });
  if (r.error) { throw new Error(`could not run pyright (${file}): ${r.error.message}`); }
  let json;
  try { json = JSON.parse(r.stdout); } catch { throw new Error(`pyright printed no JSON (exit ${r.status}):\n${r.stdout}\n${r.stderr}`); }
  const diags = json.generalDiagnostics.map((d) => ({
    file: path.relative(project, d.file).split(path.sep).join('/'), line: (d.range?.start?.line ?? 0) + 1, severity: d.severity, rule: d.rule ?? '', message: d.message.split('\n')[0],
  }));
  return { version: json.version ?? '?', diags, errors: diags.filter((d) => d.severity === 'error'), warnings: diags.filter((d) => d.severity === 'warning') };
}

// ---------------------------------------------------------------- scenarios
const results = [];
let failed = 0;
const say = (text) => { if (!asJson) { console.log(text); } };
const check = (scenario, name, ok, detail = '') => {
  results.push({ scenario, name, ok, detail });
  if (!ok) { failed++; }
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const show = (label, r, only) => {
  say(`  ${label}: pyright ${r.version}: ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
  for (const d of r.diags.filter((x) => !only || only(x))) { say(`      ${d.file}:${d.line} ${d.severity} ${d.rule ? `[${d.rule}] ` : ''}${d.message}`); }
};
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });
const nodeDeps = () => ({ fs: lib.nodeFs(), clock: lib.nodeClock() });

async function applyTwice(ws, request) {
  const deps = nodeDeps();
  const first = await lib.runFix(deps, request, { apply: true });
  say(`  fix: ${first.plan.summary}`);
  for (const w of first.plan.warnings) { say(`      note [${w.code}] ${w.message.split('\n')[0]}`); }
  if (first.result.errors.length > 0) { say(`      errors: ${JSON.stringify(first.result.errors)}`); }
  const second = await lib.runFix(deps, request, { apply: true });
  return { first, second };
}

/** The fake board of test/fixtures/intellisense/acme-board.json behind the library's BoardAccess (no serial port, no bridge). */
function acmeBoard() {
  const fx = JSON.parse(fs.readFileSync(path.join(fixtures, 'acme-board.json'), 'utf8'));
  const record = { imports: [], softResets: 0 };
  const access = {
    async introspect(names) {
      if (names === undefined) { return { listing: fx.listing, modules: {} }; }
      record.imports.push([...names]);
      return { listing: fx.listing, modules: Object.fromEntries(names.map((n) => [n, fx.modules[n] ?? { attrs: [], error: `ImportError: no module named '${n}'` }])) };
    },
    async list(dir) {
      const entries = new Map();
      for (const [p, text] of Object.entries(fx.files)) {
        if (!p.startsWith(`${dir}/`)) { continue; }
        const rest = p.slice(dir.length + 1).split('/');
        entries.set(rest[0], rest.length > 1 ? { name: rest[0], type: 'dir', size: 0 } : { name: rest[0], type: 'file', size: Buffer.byteLength(text) });
      }
      if (entries.size === 0) { throw Object.assign(new Error(`${dir} does not exist`), { detail: 'ENOENT' }); }
      return [...entries.values()];
    },
    async get(remote, local) { fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, fx.files[remote]); },
    async softReset() { record.softResets++; },
  };
  return { fx, access, record };
}

async function scenarioAcme() {
  const base = path.join(scratch, 'truth-acme');
  const ws = path.join(base, 'ws (acme)');
  copy(path.join(fixtures, 'student-board'), ws);
  say('\n== acme: student code for a custom firmware; stubs generated from the (fake) board ==');
  const before = runPyright(ws);
  show('BEFORE', before, (d) => d.file === 'main.py');
  const unresolved = before.errors.filter((d) => d.rule === 'reportMissingImports' && d.file === 'main.py').map((d) => d.message.match(/"([^"]+)"/)?.[1]);
  check('acme', 'before: machine, _acme, acme and helper are unresolved', ['machine', '_acme', 'acme', 'helper'].every((m) => unresolved.includes(m)), unresolved.join(', '));
  check('acme', 'before: time.sleep_ms is flagged (CPython stub)', before.errors.some((d) => /sleep_ms/.test(d.message)));
  const { fx, access, record } = acmeBoard();
  const deps = nodeDeps();
  const request = { workspace: ws, resourcesDir, board: fx.board, consent: { createUserConfig: true } };
  const gatherOnce = async () => {
    const inputs = await lib.prepareFixInputs(deps, request);
    const tracker = lib.parseTracker(inputs.state.texts[lib.TRACKER_REL] ?? null);
    const local = await lib.localModuleNames(deps.fs, ws, new Set(Object.keys(tracker?.files ?? {})));
    return lib.gatherBoardStubs(deps.fs, access, {
      board: fx.board, syspath: fx.syspath, stock: lib.stockModuleNames(inputs.stock?.pack ?? null), local, stagingDir: path.join(base, 'staging'),
      now: Date.now(), previous: tracker?.board ?? null, askImport: async () => 'continue',
    });
  };
  const stubs = await gatherOnce();
  check('acme', 'the board was asked for the custom modules only, then soft-reset once', JSON.stringify(record.imports) === JSON.stringify([['_acme', 'acme', 'acme.motor', 'acme.pins'], ['acme.extra']]) && record.softResets === 1, JSON.stringify(record.imports));
  const first = await lib.runFix(deps, { ...request, boardStubs: { kind: 'fresh', stubs } }, { apply: true });
  say(`  fix: ${first.plan.summary}`);
  for (const w of first.plan.warnings) { say(`      note [${w.code}] ${w.message.split('\n')[0]}`); }
  check('acme', 'fix wrote without errors', first.result.errors.length === 0, JSON.stringify(first.result.errors));
  const rows = Object.fromEntries((first.plan.facts.board?.modules ?? []).map((m) => [m.name, m.how]));
  check('acme', 'what came from where: acme/_acme stubs, helper copied, acme_extra left to the local typings', rows.acme === 'stub' && rows._acme === 'stub' && rows.helper === 'copy' && rows.acme_extra === 'local-wins', JSON.stringify(rows));
  const second = await lib.runFix(deps, { ...request, boardStubs: { kind: 'fresh', stubs: await gatherOnce() } }, { apply: true });
  check('acme', 'second run is idempotent (no writes)', second.plan.writes.length === 0 && second.result.written.length === 0, second.plan.writes.map((w) => w.path).join(', '));
  const after = runPyright(ws);
  show('AFTER', after);
  check('acme', 'after: main.py has 0 errors (import acme, acme.Motor(1).gains(1, 2, 3), acme.pins.MOT1, _acme.LIMIT, helper, local acme_extra)', after.errors.filter((d) => d.file === 'main.py').length === 0);
  check('acme', 'after: no error anywhere except the deliberate wrong.py lines', after.errors.every((d) => d.file === 'wrong.py'));
  const wrong = after.errors.filter((d) => d.file === 'wrong.py');
  check('acme', 'after: the misspelled module member acme.Motr IS flagged', wrong.some((d) => d.line === 3 && d.rule === 'reportAttributeAccessIssue'), wrong.map((d) => `${d.line}:${d.rule}`).join(' '));
  check('acme', 'after: the misspelled method acme.Motor(1).gainz IS flagged', wrong.some((d) => d.line === 4 && d.rule === 'reportAttributeAccessIssue'));
  check('acme', 'after: exactly those two errors', wrong.length === 2 && after.errors.length === 2);
  check('acme', 'no diagnostics inside the generated stubs or the board copies', after.diags.every((d) => !d.file.startsWith('.upy-bridge/')));
  const generated = fs.readFileSync(path.join(ws, lib.GENERATED_REL), 'utf8');
  check('acme', 'generated config holds relative forward-slash paths only, with board-lib in extraPaths', !generated.includes('\\') && !/"[A-Za-z]:|"\//.test(generated) && /"board-lib"/.test(generated));
}

async function scenarioStock(port, board, extraImport) {
  const base = path.join(scratch, `truth-${port}`);
  const ws = path.join(base, 'Lab 1 (stock)');
  copy(path.join(fixtures, 'student-stock'), ws);
  fs.appendFileSync(path.join(ws, 'main.py'), `${extraImport}\n`);
  say(`\n== ${port}: stock-only workspace ==`);
  const before = runPyright(ws);
  show('BEFORE', before, (d) => d.file === 'main.py');
  check(port, 'before: machine and network are unresolved', before.errors.filter((d) => d.rule === 'reportMissingImports').length >= 2);
  check(port, 'before: time.sleep_ms is flagged', before.errors.some((d) => /sleep_ms/.test(d.message)));
  const { first, second } = await applyTwice(ws, { workspace: ws, resourcesDir, board, consent: { createUserConfig: true } });
  check(port, 'fix chose the matching stock stubs', first.plan.facts.stock?.portId === port, first.plan.facts.stock?.reason ?? '');
  check(port, 'second run is idempotent (no writes)', second.plan.writes.length === 0);
  const after = runPyright(ws);
  show('AFTER', after);
  check(port, 'after: main.py has 0 errors', after.errors.filter((d) => d.file === 'main.py').length === 0);
  const wrong = after.errors.filter((d) => d.file === 'wrong.py');
  check(port, 'after: a deliberately wrong attribute (time.sleep_foo) IS flagged', wrong.length === 1 && wrong[0].rule === 'reportAttributeAccessIssue');
}

try {
  await scenarioAcme();
  await scenarioStock('rp2', { impl: 'micropython', version: [1, 28, 0], machine: 'Raspberry Pi Pico with RP2040', build: 'RPI_PICO', platform: 'rp2', uniqueId: '11' }, 'import rp2');
  await scenarioStock('esp8266', { impl: 'micropython', version: [1, 26, 0], machine: 'ESP module with ESP8266', build: '', platform: 'esp8266', uniqueId: '22' }, 'import esp');
} catch (err) {
  failed++;
  console.error(`truth test aborted: ${err instanceof Error ? err.message : String(err)}`);
}
if (asJson) { console.log(JSON.stringify({ pyright: PYRIGHT_VERSION, failed, results })); }
else { console.log(`\n${failed === 0 ? 'TRUTH TEST PASSED' : `TRUTH TEST FAILED (${failed})`}: ${results.filter((r) => r.ok).length}/${results.length} expectations held (pyright ${PYRIGHT_VERSION}, scratch ${scratch})`); }
process.exit(failed === 0 ? 0 : 1);
