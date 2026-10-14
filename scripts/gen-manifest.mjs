// Writes the generated sections of package.json (name, displayName, publisher, description, icon, galleryBanner, categories,
// keywords, capabilities, activationEvents, contributes) from src/contributes.ts + src/identity.ts. With --check it changes nothing and exits 1 when package.json is
// out of date. Usage: node scripts/gen-manifest.mjs [--check] [--package <file>]   (--package: operate on another package.json)
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { baseBuildOptions, root } from './common.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const pkgFlag = args.indexOf('--package');
const pkgPath = pkgFlag >= 0 ? path.resolve(args[pkgFlag + 1] ?? '') : path.join(root, 'package.json');

// Bundle the (pure) table to ESM in memory and import it; nothing is written to disk.
const result = await build({
  ...baseBuildOptions(),
  format: 'esm',
  entryPoints: ['src/contributes.ts'],
  write: false,
  logLevel: 'silent',
});
const code = result.outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const sections = mod.buildManifest();

const current = fs.readFileSync(pkgPath, 'utf8');
const existing = JSON.parse(current);
// Existing keys keep their position in the file. A key that is new to package.json goes right after its anchor (the first one
// that is present), so the file reads in the usual order: identity, icon, banner, engines, categories, keywords, ...
const PLACE_AFTER = { icon: 'publisher', galleryBanner: 'icon', keywords: 'categories' };
const fresh = Object.keys(sections).filter((key) => !(key in existing));
const pkg = {};
const place = (key) => {
  pkg[key] = key in sections ? sections[key] : existing[key];
  for (const added of fresh.filter((k) => PLACE_AFTER[k] === key)) {
    place(added);
  }
};
for (const key of Object.keys(existing)) {
  place(key);
}
for (const key of fresh) {
  if (!(key in pkg)) {
    place(key); // no anchor in this file: appended at the end
  }
}
const next = `${JSON.stringify(pkg, null, 2)}\n`;

if (next === current) {
  console.log('package.json is up to date.');
} else if (check) {
  console.error('package.json is out of date with src/contributes.ts and src/identity.ts. Run: npm run gen:manifest');
  process.exit(1);
} else {
  fs.writeFileSync(pkgPath, next);
  console.log('package.json updated from src/contributes.ts.');
}
