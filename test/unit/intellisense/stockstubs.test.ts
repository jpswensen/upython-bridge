import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import { describe, it } from 'node:test';
import { coverageTable, loadStubManifest, loadStubPack, selectStockStubs } from '../../../src/intellisense/stockStubs';
import { spawnSync } from 'node:child_process';
import { nodeFs } from '../../../src/intellisense/nodeAdapters';
import { portOf } from '../../../src/intellisense/ports';
import type { BoardInfo } from '../../../src/intellisense/types';
import { projectRoot } from '../../mocks/fixtures';
import { MemFs, RESOURCES_STUBS } from './memfs';

const board = (platform: string, machine: string, version: [number, number, number] = [1, 29, 0], build = ''): BoardInfo => ({ impl: 'micropython', version, machine, build, platform, uniqueId: 'aa' });

describe('stock stub selection and coverage', () => {
  it('reads the vendored manifest: 7 port packs and the shared overlay, pinned to exact versions with hashes', async () => {
    const m = await loadStubManifest(nodeFs(), RESOURCES_STUBS);
    assert.deepEqual(m.packs.map((p) => p.id), ['esp32', 'esp8266', 'rp2', 'stm32', 'samd', 'nrf', 'mimxrt', 'stdlib']);
    for (const p of m.packs) {
      assert.match(p.version, /^1\.2\d\.\d+\.post\d+$/);
      assert.match(p.wheelSha256, /^[0-9a-f]{64}$/);
      assert.match(p.contentSha256, /^[0-9a-f]{64}$/);
    }
    const rows = coverageTable(m);
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.find((r) => r.id === 'stm32')!.platforms, ['pyboard', 'stm32']);
  });

  it('keeps the resources folder under the 3 MB budget', () => {
    let total = 0;
    const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = nodePath.join(d, e.name); if (e.isDirectory()) { walk(p); } else { total += fs.statSync(p).size; } } };
    walk(nodePath.join(projectRoot(), 'resources'));
    assert.ok(total < 3_000_000, `resources are ${total} bytes`);
  });

  it('the offline integrity check of the vendoring script passes', async () => {
    const r = spawnSync(process.execPath, [nodePath.join(projectRoot(), 'scripts', 'vendor-stubs.mjs'), '--check'], { timeout: 30000, encoding: 'utf8', shell: false, windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  const table: [string, BoardInfo, string | null][] = [
    ['ESP32 by platform', board('esp32', 'ESP32 module (spiram) with ESP32', [1, 29, 0], 'ESP32_GENERIC-SPIRAM'), 'esp32'],
    ['ESP32-S3 native USB', board('esp32', 'Generic ESP32S3 module with ESP32S3', [1, 28, 0], 'ESP32_GENERIC_S3'), 'esp32'],
    ['a custom ESP32 board name', board('esp32', 'Some Custom Board with ESP32', [1, 29, 0], 'MY_CUSTOM_BOARD'), 'esp32'],
    ['ESP8266', board('esp8266', 'ESP module with ESP8266', [1, 26, 0]), 'esp8266'],
    ['RP2040', board('rp2', 'Raspberry Pi Pico with RP2040', [1, 27, 0], 'RPI_PICO'), 'rp2'],
    ['RP2350 found through the machine text only', board('', 'Raspberry Pi Pico 2 with RP2350', [1, 29, 0]), 'rp2'],
    ['pyboard (platform "pyboard" is the STM32 port)', board('pyboard', 'PYBv1.1 with STM32F405RG', [1, 25, 0], 'PYBV11'), 'stm32'],
    ['Nucleo found through the machine text', board('', 'NUCLEO-F429ZI with STM32F429', [1, 29, 0]), 'stm32'],
    ['SAMD', board('samd', 'Adafruit ItsyBitsy M4 with SAMD51G19A'), 'samd'],
    ['nRF', board('nrf', 'PCA10056 with NRF52840'), 'nrf'],
    ['i.MX RT', board('mimxrt', 'Teensy 4.1 with MIMXRT1062DVJ6A'), 'mimxrt'],
    ['a port without a pack (renesas-ra)', board('renesas-ra', 'RA6M5 with RA6M5'), null],
    ['a port without a pack (zephyr)', board('zephyr', 'FRDM-K64F'), null],
    ['an unrecognised platform', board('quantum', 'Some Computer'), null],
  ];
  for (const [name, b, want] of table) {
    it(`selects for ${name}`, async () => {
      const m = await loadStubManifest(nodeFs(), RESOURCES_STUBS);
      const sel = selectStockStubs(b, m);
      assert.equal(sel.portId, want);
      assert.deepEqual(sel.packs, want === null ? ['stdlib'] : ['stdlib', want]);
      assert.equal(sel.coverage, want === null ? 'stdlib-only' : 'port');
    });
  }

  it('explains version differences and never errors for an unknown board or no board', async () => {
    const m = await loadStubManifest(nodeFs(), RESOURCES_STUBS);
    assert.equal(selectStockStubs(board('esp32', 'x', [1, 29, 0]), m).versionRelation, 'same');
    const older = selectStockStubs(board('esp32', 'x', [1, 19, 1]), m);
    assert.equal(older.versionRelation, 'board-older');
    assert.match(older.notes.join(' '), /1\.19\.1.*1\.29\.0/);
    const newer = selectStockStubs(board('esp32', 'x', [1, 31, 0]), m);
    assert.equal(newer.versionRelation, 'board-newer');
    const none = selectStockStubs(null, m);
    assert.deepEqual(none.packs, ['stdlib']);
    assert.match(none.reason, /No board/);
    assert.equal(selectStockStubs(null, m, { defaultPort: 'rp2' }).portId, 'rp2');
    assert.equal(selectStockStubs(board('esp32', 'x'), m, { portHint: 'rp2' }).portId, 'rp2', 'a profile or setting wins over the board');
    assert.deepEqual(selectStockStubs(board('esp32', 'x'), m, { off: true }).packs, []);
    assert.equal(selectStockStubs(null, m, { portHint: 'nonesuch' }).coverage, 'stdlib-only');
  });

  it('portOf covers every platform value the ports report', () => {
    assert.equal(portOf({ platform: 'linux', machine: '' }), null);
    assert.equal(portOf({ platform: 'WiPy', machine: '' }), 'cc3200');
    assert.equal(portOf({ platform: 'x', machine: '', uname: { sysname: 'rp2', machine: '' } }), 'rp2');
  });
});

describe('loading the bundled packs', () => {
  it('layers the overlay and one port, with the MicroPython stdlib API and the port modules', async () => {
    const real = nodeFs();
    const m = await loadStubManifest(real, RESOURCES_STUBS);
    const pack = await loadStubPack(real, RESOURCES_STUBS, selectStockStubs(board('esp32', 'x'), m), m);
    const rels = pack.files.map((f) => f.rel);
    for (const need of ['machine.pyi', 'time.pyi', 'network.pyi', 'esp32.pyi', 'os/__init__.pyi', 'sys/__init__.pyi', 'asyncio/__init__.pyi', '_mpy_shed/__init__.pyi', 'utime.pyi']) {
      assert.ok(rels.includes(need), `${need} is in the pack`);
    }
    assert.ok(!rels.some((r) => r.endsWith('.md') || r.endsWith('.toml') || r.includes('dist-info')), 'only typing files');
    assert.deepEqual(rels, [...rels].sort(), 'sorted');
    assert.equal(new Set(rels).size, rels.length);
    assert.match(pack.label, /^esp32 1\.29\.0\.post1 \(\+ stdlib 1\.29\.0\.post2 overlay\)$/);
    assert.match(fs.readFileSync(pack.files.find((f) => f.rel === 'time.pyi')!.abs, 'utf8'), /def sleep_ms/);
    assert.match(fs.readFileSync(pack.files.find((f) => f.rel === 'os/__init__.pyi')!.abs, 'utf8'), /def ilistdir/);
  });

  it('a board of an unknown port gets the stdlib overlay only', async () => {
    const real = nodeFs();
    const m = await loadStubManifest(real, RESOURCES_STUBS);
    const pack = await loadStubPack(real, RESOURCES_STUBS, selectStockStubs(board('zephyr', 'x'), m), m);
    const rels = pack.files.map((f) => f.rel);
    assert.ok(rels.includes('os/__init__.pyi') && !rels.includes('machine.pyi'));
  });

  it('refuses a damaged bundle instead of installing it', async () => {
    const mem = new MemFs('posix');
    mem.importDir(RESOURCES_STUBS, '/ext/stubs');
    const m = await loadStubManifest(mem, '/ext/stubs');
    mem.put('/ext/stubs/esp32/machine.pyi', '# tampered');
    await assert.rejects(loadStubPack(mem, '/ext/stubs', selectStockStubs(board('esp32', 'x'), m), m), /does not match/);
  });
});
