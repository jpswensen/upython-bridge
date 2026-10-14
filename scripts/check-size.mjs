// Size budget (R-ARCH-7 / RQ-DIST-1). Four limits, all in this file so they are stated once:
//   1. the bundle (dist/extension.js)                      <= 5 MB
//   2. the whole VSIX, stock stub packs included            <= 5 MB   (the total budget did not change when resources/ shipped)
//   3. the VSIX WITHOUT resources/stubs (code, bridge, ...) <= 2 MB   (the old "without stubs" limit, now stated explicitly:
//      it keeps the stubs from hiding growth in the code; today the code part is about 0.3 MB)
//   4. media/ inside the VSIX                               <= 24 KiB (D-19: the six artwork files take about 10 KiB; the banner
//      PNG of branding/final is 40 KiB and must stay out of the package)
// Usage: node scripts/check-size.mjs
import fs from 'node:fs';
import path from 'node:path';
import { root } from './common.mjs';

const MB = 1024 * 1024;
const LIMITS = { bundle: 5 * MB, vsix: 5 * MB, vsixWithoutStubs: 2 * MB, media: 24 * 1024 };

/** Entries (name, compressed size) from the zip central directory. Plain parsing, no dependency. */
export function zipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file} is not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: damaged central directory`);
    const nameLen = buf.readUInt16LE(p + 28);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), compressed: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24) });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
let failed = false;
const report = (label, size, limit) => {
  const ok = size <= limit;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} ${kib(size)} (limit ${limit >= MB ? `${limit / MB} MiB` : kib(limit)})`);
  failed = failed || !ok;
};

const bundle = path.join(root, 'dist', 'extension.js');
if (fs.existsSync(bundle)) report(path.relative(root, bundle), fs.statSync(bundle).size, LIMITS.bundle);
else { console.error(`Missing ${path.relative(root, bundle)}. Run: npm run build`); failed = true; }

const outDir = path.join(root, 'out');
const vsixes = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.vsix')) : [];
for (const f of vsixes) {
  const file = path.join(outDir, f);
  const total = fs.statSync(file).size;
  const stubs = zipEntries(file).filter((e) => e.name.startsWith('extension/resources/stubs/')).reduce((n, e) => n + e.compressed, 0);
  report(`out/${f}`, total, LIMITS.vsix);
  report(`out/${f} without resources/stubs (stubs: ${kib(stubs)} compressed)`, total - stubs, LIMITS.vsixWithoutStubs);
  const media = zipEntries(file).filter((e) => e.name.startsWith('extension/media/')).reduce((n, e) => n + e.compressed, 0);
  report(`out/${f} media/`, media, LIMITS.media);
}
process.exit(failed ? 1 : 0);
