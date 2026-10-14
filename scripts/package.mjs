// Build the bundle in production mode, stage the shipped files (scripts/stage.mjs), then package a VSIX into out/ (vsce,
// --no-dependencies: esbuild already bundled them). The VSIX therefore contains exactly the allow-list and nothing else.
// Usage: node scripts/package.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pkgFile, root, run } from './common.mjs';
import { stageExtension } from './stage.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'out');
fs.mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, `${pkg.name}-${pkg.version}.vsix`);
fs.rmSync(target, { force: true });

let code = await run([process.execPath, path.join(root, 'scripts', 'build.mjs'), '--production']);
if (code === 0) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'upy-bridge-stage-'));
  try {
    const files = stageExtension(root, stage);
    console.log(`staged ${files.length} files`);
    const vsceBin = pkgFile('@vscode/vsce', 'vsce');
    // README screenshots are `images/*.png` in the project, NOT in the VSIX: the Marketplace and VS Code's extension page show
    // README images only from https URLs. With a `repository` in package.json (a public repo that holds images/), vsce rewrites
    // the links to it; until then they stay relative (a VSIX installed from a file shows their alt text).
    const links = pkg.repository ? [] : ['--allow-missing-repository', '--no-rewrite-relative-links'];
    code = await run([process.execPath, vsceBin, 'package', '--no-dependencies', ...links, '--out', target], { cwd: stage });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
process.exit(code);
