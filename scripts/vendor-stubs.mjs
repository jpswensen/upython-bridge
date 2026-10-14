// Vendors the stock MicroPython typing stubs (the PyPI "micropython-*-stubs" packages of the micropython-stubs project, MIT)
// into resources/stubs/ and writes resources/stubs/MANIFEST.json. NOT part of `npm run verify`: it needs wheels that were
// downloaded once by hand, and the result is committed. The extension itself never touches the network (CLAUDE.md, 06 invariant 10).
//
// Reproduce (any machine with Python and network; the wheels land in <dir>, a scratch folder OUTSIDE the repository):
//
//   python3 -m venv <scratch>/venv
//   for each pinned package below:
//     <scratch>/venv/bin/pip download --no-deps --only-binary=:all: "<package>==<version>" -d <dir>
//   node scripts/vendor-stubs.mjs --wheels <dir>      # verifies every wheel's SHA-256 against PINS, unpacks, writes MANIFEST.json
//   node scripts/vendor-stubs.mjs --check             # offline: re-hashes resources/stubs against MANIFEST.json (exit 1 on drift)
//
// What is vendored (layout contract: docs/analysis/07-linting-stubs.md P.4 and section 12.4):
//   resources/stubs/<port>/     every top-level *.pyi file/folder of the port wheel (machine.pyi, time.pyi, network.pyi, ...)
//   resources/stubs/stdlib/     ONE shared overlay from micropython-stdlib-stubs: `_mpy_shed/` (imported by the port stubs) and the
//                               stdlib modules whose MicroPython API differs from CPython's (OVERRIDES). pyright resolves stdlib names
//                               from typeshed BEFORE extraPaths, so these can only win through `stubPath` (07 section 3.1).
//                               Never flattened: builtins, typing, types, abc, enum, _typeshed (not MicroPython API).
//   resources/stubs/LICENSES/   the stubs' MIT licence and typeshed's licence (the stdlib overlay derives from typeshed)
//   resources/stubs/MANIFEST.json
// The installed layout under a workspace is the union of the `stdlib` overlay and ONE port folder (src/intellisense/stockStubs.ts).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'resources', 'stubs');

/** Stdlib names re-defined by micropython-stdlib-stubs with MicroPython-only API (07 section 6.5 allow-list). */
const OVERRIDES = ['os', 'sys', 'json', 'asyncio', 'io', 'collections', 'array', 'struct', 'ssl', '_asyncio'];

/**
 * The pinned list. `platforms` is documentation for MANIFEST.json (what `sys.platform` values the pack serves); the matching rules
 * themselves are code (src/intellisense/stockStubs.ts) and a unit test keeps both in step.
 * Chosen 2026-10-13 as the newest PyPI release below MicroPython 1.30 for every package (`pip download "<pkg>>=1.20,<1.30"`).
 */
const PINS = [
  { id: 'esp32', kind: 'port', package: 'micropython-esp32-stubs', version: '1.29.0.post1', mp: [1, 29, 0], platforms: ['esp32'],
    covers: 'ESP32, ESP32-S2/S3/C3/C6 (all boards of the esp32 port)',
    sha256: 'c0a72410b9924f51b520534de0dc7f1839ff8f108689aa1e935a0c2b9fcbd96b' },
  { id: 'esp8266', kind: 'port', package: 'micropython-esp8266-stubs', version: '1.29.0.post1', mp: [1, 29, 0], platforms: ['esp8266'],
    covers: 'ESP8266', sha256: '3437e07969e87b568c885a2dfe44f657876b6595815b77047f4a838884b32535' },
  { id: 'rp2', kind: 'port', package: 'micropython-rp2-stubs', version: '1.29.0.post1', mp: [1, 29, 0], platforms: ['rp2'],
    covers: 'Raspberry Pi RP2040 / RP2350 (Pico, Pico W, ...)', sha256: 'a26183e4ef7557469fd3387677a8e08cf1bc856a6cbe13acc773e57e94f0625c' },
  { id: 'stm32', kind: 'port', package: 'micropython-stm32-stubs', version: '1.29.0.post1', mp: [1, 29, 0], platforms: ['pyboard', 'stm32'],
    covers: 'STM32 boards (pyboard, Nucleo, Discovery, ...)', sha256: '57ab8e4c2f9b5e1b77e6fad97ba25c6547a679a23c898d616c9a7f5b16dcb4eb' },
  { id: 'samd', kind: 'port', package: 'micropython-samd-stubs', version: '1.29.0.post1', mp: [1, 29, 0], platforms: ['samd'],
    covers: 'Microchip SAMD21 / SAMD51', sha256: '59c0824adc05b7fa0bc0e6982ca875c9bbe76ffeb4d39cbf05bfd922f3e0b7d1' },
  { id: 'nrf', kind: 'port', package: 'micropython-nrf-stubs', version: '1.29.0.post1', mp: [1, 29, 0], platforms: ['nrf'],
    covers: 'Nordic nRF51 / nRF52 / nRF91', sha256: '043a6ffda6033a4a3ed3bd5369c8c347f8f5974ed9dbcc1318c1e64fc79e7942' },
  { id: 'mimxrt', kind: 'port', package: 'micropython-mimxrt-stubs', version: '1.26.1.post1', mp: [1, 26, 1], platforms: ['mimxrt'],
    covers: 'NXP i.MX RT (Teensy 4.x, ...); newest release PyPI has for this port', sha256: 'e585bdd419428a8da538221889e0ff47220709d56ed982fb000c5110318d7083' },
  { id: 'stdlib', kind: 'overlay', package: 'micropython-stdlib-stubs', version: '1.29.0.post2', mp: [1, 29, 0], platforms: [],
    covers: 'shared overlay for every pack, and the whole pack for boards of an unknown port',
    sha256: 'bdcd54d9896d8e1d455b3a99995d82a8399e1e2c9cb94eacabe278e5c2397783' },
];

// ------------------------------------------------------------------ minimal zip reader (wheels are deflate zips)
function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file}: not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: bad central directory`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`${file}: unsupported compression ${method} for ${name}`);
    entries.set(name, data);
  }
  return entries;
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function safeRel(name) {
  const parts = name.split('/');
  if (parts.some((s) => s === '..' || s === '' || s.includes('\\') || s.includes(':'))) throw new Error(`unsafe path in wheel: ${name}`);
  return parts.join('/');
}

/** Files of one pack as Map(relPath -> Buffer), applying the pack's selection rules. */
function selectFiles(pin, entries) {
  const out = new Map();
  for (const [rawName, data] of entries) {
    const name = safeRel(rawName);
    if (name.includes('.dist-info/')) continue;
    if (!name.endsWith('.pyi')) continue; // README.md, pyproject.toml, LICENSE.md, VERSIONS, readme.md: not typing information
    if (pin.kind === 'port') {
      if (name.startsWith('stdlib/') || name.startsWith('stubs/')) continue; // not present in 1.29 port wheels; defensive for older ones
      out.set(name, data);
    } else if (name.startsWith('_mpy_shed/')) {
      out.set(name, data);
    } else if (name.startsWith('stdlib/')) {
      const rel = name.slice('stdlib/'.length);
      const top = rel.split('/')[0].replace(/\.pyi$/, '');
      if (OVERRIDES.includes(top)) out.set(rel, data);
    }
  }
  return out;
}

function contentHash(files) {
  const h = createHash('sha256');
  for (const rel of [...files.keys()].sort()) h.update(`${rel}\0${sha256(files.get(rel))}\n`);
  return h.digest('hex');
}

function listDir(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listDir(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function vendor(wheelDir) {
  const manifest = { schema: 1, generatedBy: 'scripts/vendor-stubs.mjs', licence: 'MIT (micropython-stubs, (c) 2022 Jos Verlinde); stdlib overlay derives from typeshed (Apache-2.0 / MIT), see LICENSES/', overrides: OVERRIDES, packs: [], totalBytes: 0 };
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'LICENSES'), { recursive: true });
  let licenceDone = false;
  for (const pin of PINS) {
    const wheel = fs.readdirSync(wheelDir).find((f) => f.startsWith(pin.package.replace(/-/g, '_') + '-' + pin.version + '-') && f.endsWith('.whl'));
    if (!wheel) throw new Error(`wheel for ${pin.package}==${pin.version} not found in ${wheelDir}`);
    const wheelPath = path.join(wheelDir, wheel);
    const actual = sha256(fs.readFileSync(wheelPath));
    if (actual !== pin.sha256) throw new Error(`${wheel}: SHA-256 ${actual} does not match the pin ${pin.sha256}`);
    const entries = readZip(wheelPath);
    const files = selectFiles(pin, entries);
    if (files.size === 0) throw new Error(`${wheel}: nothing selected`);
    let bytes = 0;
    for (const [rel, data] of files) {
      const dest = path.join(OUT, pin.id, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      bytes += data.length;
    }
    if (!licenceDone && pin.kind === 'port') {
      const lic = [...entries].find(([n]) => n.endsWith('LICENSE.md') && !n.includes('dist-info'));
      if (lic) { fs.writeFileSync(path.join(OUT, 'LICENSES', 'LICENSE-micropython-stubs.md'), lic[1]); licenceDone = true; }
    }
    if (pin.kind === 'overlay') {
      const t = [...entries].find(([n]) => n.endsWith('licenses/LICENSE_typeshed'));
      if (t) fs.writeFileSync(path.join(OUT, 'LICENSES', 'LICENSE-typeshed.txt'), t[1]);
    }
    manifest.packs.push({
      id: pin.id, kind: pin.kind, package: pin.package, version: pin.version, mpVersion: pin.mp, platforms: pin.platforms,
      covers: pin.covers, wheel, wheelSha256: pin.sha256, files: files.size, bytes, contentSha256: contentHash(files),
    });
    manifest.totalBytes += bytes;
  }
  fs.writeFileSync(path.join(OUT, 'README.md'),
    'Stock MicroPython typing stubs, vendored by scripts/vendor-stubs.mjs from the PyPI packages listed in MANIFEST.json\n' +
    '(project: https://github.com/josverl/micropython-stubs, MIT). Do not edit by hand: `node scripts/vendor-stubs.mjs --check` re-hashes them.\n' +
    'The extension copies <stdlib overlay> + <one port folder> into <workspace>/<dot-folder>/stubs/active/ (src/intellisense/stockStubs.ts).\n');
  let licBytes = 0;
  for (const f of listDir(path.join(OUT, 'LICENSES'))) licBytes += fs.statSync(path.join(OUT, 'LICENSES', f)).size;
  manifest.licenceBytes = licBytes;
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`vendored ${manifest.packs.length} packs, ${manifest.totalBytes} bytes of stubs + ${licBytes} bytes of licences into ${path.relative(root, OUT)}`);
}

function check() {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'MANIFEST.json'), 'utf8'));
  let bad = 0;
  for (const pack of manifest.packs) {
    const dir = path.join(OUT, pack.id);
    const files = new Map(listDir(dir).map((rel) => [rel, fs.readFileSync(path.join(dir, ...rel.split('/')))]));
    const h = contentHash(files);
    const ok = h === pack.contentSha256 && files.size === pack.files;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${pack.id} ${pack.package}==${pack.version} (${files.size} files)`);
  }
  process.exit(bad ? 1 : 0);
}

const args = process.argv.slice(2);
if (args[0] === '--wheels' && args[1]) vendor(path.resolve(args[1]));
else if (args[0] === '--check') check();
else {
  console.error('Usage: node scripts/vendor-stubs.mjs --wheels <dir of downloaded wheels> | --check\n(see the comment at the top of this file for the pip commands)');
  process.exit(2);
}
