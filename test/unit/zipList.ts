/** Minimal zip reader for tests: the central directory of a .vsix (names and sizes), and one entry's bytes; no dependencies. */
import fs from 'node:fs';
import zlib from 'node:zlib';

export interface ZipEntry { name: string; size: number; compressedSize: number; method: number; offset: number }

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function listZip(file: string): ZipEntry[] {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) { throw new Error(`${file} is not a zip file (no end-of-central-directory record)`); }
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== CENTRAL) { throw new Error(`bad central directory entry ${n} in ${file}`); }
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    out.push({ name: buf.toString('utf8', pos + 46, pos + 46 + nameLen), size, compressedSize, method, offset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The uncompressed bytes of one entry (stored or deflated, the two methods vsce writes). */
export function readZipEntry(file: string, name: string): Buffer {
  const entry = listZip(file).find((e) => e.name === name);
  if (!entry) { throw new Error(`${name} is not in ${file}`); }
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(entry.offset) !== LOCAL) { throw new Error(`bad local header for ${name} in ${file}`); }
  const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) { return Buffer.from(data); }
  if (entry.method === 8) { return zlib.inflateRawSync(data); }
  throw new Error(`${name} in ${file} uses zip method ${entry.method}`);
}
