// Stages EXACTLY what the VSIX ships into a clean folder (an allow-list), so the package contents never depend on how an ignore
// file is interpreted by a particular vsce version, and so junk that appears next to the sources (compiled Python caches,
// macOS .DS_Store files, Python tests) can never leak in.
// Used by scripts/package.mjs; unit-tested by test/unit/package.test.ts.
import fs from 'node:fs';
import path from 'node:path';

/** Top-level files that ship (README.md/LICENSE/NOTICE/THIRD_PARTY_NOTICES are the legal and user-facing minimum). */
export const ROOT_FILES = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES'];
/**
 * Folders that ship, copied recursively with `isShippable`. `resources/` holds the bundled stock MicroPython stub packs
 * (resources/stubs, MIT, with MANIFEST.json and LICENSES/); the extension finds it through its extension path, never the cwd.
 */
export const SHIPPED_DIRS = ['media', 'bridge', 'resources'];
/** The one built file. The source map is never shipped. */
export const BUNDLE = 'dist/extension.js';

const SKIPPED_DIRS = new Set(['__pycache__', 'tests', 'test', '.pytest_cache', '.mypy_cache', '.git', 'node_modules']);
const SKIPPED_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const SKIPPED_EXTENSIONS = ['.pyc', '.pyo', '.map', '.orig', '.rej', '.log'];

/** Should the file or folder `name` (one path segment) be skipped? */
export function isSkipped(name, isDirectory) {
  if (isDirectory) {
    return SKIPPED_DIRS.has(name);
  }
  return SKIPPED_FILES.has(name) || SKIPPED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function copyTree(from, to, rel, out) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (isSkipped(entry.name, entry.isDirectory())) {
      continue;
    }
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    const relPath = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      copyTree(src, dst, relPath, out);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      out.push(relPath);
    }
    // Symbolic links and other special files are never shipped.
  }
}

/**
 * Copy the allow-list from `srcRoot` into `destRoot` (created fresh). Returns the shipped files as POSIX relative paths.
 * Throws a clear error when a required file is missing, so a broken package is never produced silently.
 */
export function stageExtension(srcRoot, destRoot) {
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(destRoot, { recursive: true });
  const out = [];
  for (const file of [...ROOT_FILES, BUNDLE]) {
    const src = path.join(srcRoot, ...file.split('/'));
    if (!fs.existsSync(src)) {
      throw new Error(`Cannot package: ${file} is missing. Run "npm run build" first (and check the file exists).`);
    }
    const dst = path.join(destRoot, ...file.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    out.push(file);
  }
  for (const dir of SHIPPED_DIRS) {
    const src = path.join(srcRoot, dir);
    if (!fs.existsSync(src)) {
      throw new Error(`Cannot package: the folder ${dir}/ is missing.`);
    }
    copyTree(src, path.join(destRoot, dir), dir, out);
  }
  return out.sort();
}
