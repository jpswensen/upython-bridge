/**
 * Choose and load the bundled stock stub pack for a board (RQ-GEN-1, D-15). The packs are vendored by scripts/vendor-stubs.mjs under
 * resources/stubs/: one shared `stdlib` overlay (MicroPython's os/sys/json/asyncio/io/... and the _mpy_shed helpers) and one folder
 * per port. The installed layout is overlay + ONE port folder, copied to <dot-folder>/stubs/active/ and given to pyright as `stubPath`
 * (stdlib names can only be overridden through stubPath, 07 section 3.1). A board of a port without a pack, or no board at all,
 * degrades to the overlay alone and never to an error.
 */
import type { BoardInfo, FsLike, StockSelection, StubManifest, StubManifestPack, StubPack, StubPackFile } from './types';
import { portOf } from './ports';
import { decodeText, readdirSafe, sha256Hex } from './util';
import { createHash } from 'node:crypto';

export const OVERLAY_ID = 'stdlib';

export async function loadStubManifest(fs: FsLike, resourcesDir: string): Promise<StubManifest> {
  const text = decodeText(await fs.readFile(fs.path.join(resourcesDir, 'MANIFEST.json')));
  const parsed = JSON.parse(text) as StubManifest;
  if (parsed.schema !== 1 || !Array.isArray(parsed.packs)) { throw new Error('resources/stubs/MANIFEST.json has an unknown format.'); }
  return parsed;
}

export interface CoverageRow {
  id: string; package: string; version: string; mpVersion: string; platforms: string[]; covers: string; files: number; bytes: number;
}

/** The coverage table: which boards get which pack. */
export function coverageTable(manifest: StubManifest): CoverageRow[] {
  return manifest.packs.map((p) => ({
    id: p.id, package: p.package, version: p.version, mpVersion: p.mpVersion.join('.'), platforms: p.platforms, covers: p.covers, files: p.files, bytes: p.bytes,
  }));
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d !== 0) { return d; } }
  return 0;
}

export interface SelectOptions {
  /** Port named by a firmware profile or a setting; wins over the board's own report. */
  portHint?: string;
  /** Used only when nothing is known about the board (for example a pack the course template prefers). */
  defaultPort?: string;
  /** Stubs switched off: no selection at all. */
  off?: boolean;
}

export function selectStockStubs(board: BoardInfo | null, manifest: StubManifest, options: SelectOptions = {}): StockSelection {
  const overlay = manifest.packs.find((p) => p.id === OVERLAY_ID);
  const notes: string[] = [];
  const stdlibOnly = (reason: string): StockSelection => ({
    portId: null, packs: overlay ? [OVERLAY_ID] : [], coverage: 'stdlib-only', versionRelation: 'unknown', exact: false, reason, notes,
  });
  if (options.off === true) { return { ...stdlibOnly('Stock stubs are switched off in the settings.'), packs: [] }; }
  let port: string | null = options.portHint ?? null;
  let source = 'the firmware profile or settings';
  const boardLabel = board === null ? '' : (typeof board.platform === 'string' && board.platform !== '' ? board.platform : typeof board.machine === 'string' ? board.machine : '');
  if (port === null && board !== null) { port = portOf(board); source = `the board (${boardLabel || 'unknown platform'})`; }
  if (port === null && board === null && options.defaultPort !== undefined) { port = options.defaultPort; source = 'the default'; notes.push('No board information is available yet, so the default port is used. Connect the board to pick the matching stubs.'); }
  if (port === null) {
    return stdlibOnly(board === null
      ? 'No board is connected or declared, so only the MicroPython standard library stubs are used.'
      : `The port of this board (${boardLabel || 'unknown'}) is not recognised, so only the standard library stubs are used.`);
  }
  const pack = manifest.packs.find((p) => p.kind === 'port' && p.id === port);
  if (pack === undefined) {
    notes.push(`There is no bundled stub pack for the "${port}" port; modules such as machine will show as unresolved.`);
    return stdlibOnly(`No bundled stubs for the "${port}" port (from ${source}), so only the standard library stubs are used.`);
  }
  let relation: StockSelection['versionRelation'] = 'unknown';
  const version = board !== null && Array.isArray(board.version) ? board.version.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : [];
  if (board !== null && version.some((n) => n > 0)) {
    const c = compare(version, pack.mpVersion);
    relation = c === 0 ? 'same' : c > 0 ? 'board-newer' : 'board-older';
    if (c > 0) { notes.push(`The board runs MicroPython ${version.join('.')}; the bundled ${pack.id} stubs describe ${pack.mpVersion.join('.')}. Newer functions can be reported as unknown.`); }
    if (c < 0) { notes.push(`The board runs MicroPython ${version.join('.')}; the bundled ${pack.id} stubs describe ${pack.mpVersion.join('.')}. Functions the board lacks may be accepted.`); }
  }
  return {
    portId: pack.id,
    packs: overlay ? [OVERLAY_ID, pack.id] : [pack.id],
    coverage: 'port', versionRelation: relation, exact: relation === 'same',
    reason: `${pack.id} stubs ${pack.version} for ${source}.`, notes,
  };
}

async function walk(fs: FsLike, base: string, rel: string, out: string[]): Promise<void> {
  for (const e of (await readdirSafe(fs, rel === '' ? base : fs.path.join(base, ...rel.split('/')))).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory) { await walk(fs, base, r, out); } else if (e.isFile) { out.push(r); }
  }
}

function packHash(files: Map<string, string>): string {
  const h = createHash('sha256');
  for (const rel of [...files.keys()].sort()) { h.update(`${rel}\0${files.get(rel) as string}\n`); }
  return h.digest('hex');
}

/** Read the selected packs from the bundle; layers are merged, a later layer wins on the same path. Verifies the vendored hashes. */
export async function loadStubPack(fs: FsLike, resourcesDir: string, selection: StockSelection, manifest: StubManifest): Promise<StubPack> {
  const merged = new Map<string, StubPackFile>();
  const labels: string[] = [];
  for (const id of selection.packs) {
    const meta = manifest.packs.find((p) => p.id === id) as StubManifestPack | undefined;
    if (meta === undefined) { throw new Error(`Stub pack "${id}" is not in resources/stubs/MANIFEST.json.`); }
    const dir = fs.path.join(resourcesDir, id);
    const rels: string[] = [];
    await walk(fs, dir, '', rels);
    const hashes = new Map<string, string>();
    for (const rel of rels) {
      const abs = fs.path.join(dir, ...rel.split('/'));
      const data = await fs.readFile(abs);
      const sha = sha256Hex(data);
      hashes.set(rel, sha);
      merged.set(rel, { rel, abs, size: data.length, sha256: sha });
    }
    if (rels.length !== meta.files || packHash(hashes) !== meta.contentSha256) {
      throw new Error(`The bundled stub pack "${id}" does not match resources/stubs/MANIFEST.json (damaged install?). Reinstall the extension.`);
    }
    labels.push(`${id} ${meta.version}`);
  }
  const files = [...merged.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const label = labels.length === 0 ? 'none' : labels.length === 1 ? labels[0] as string : `${labels[labels.length - 1] as string} (+ ${labels.slice(0, -1).join(', ')} overlay)`;
  return { ids: selection.packs, label, files, bytes: files.reduce((n, f) => n + f.size, 0) };
}
