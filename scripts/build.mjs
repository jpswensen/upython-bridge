// Bundle src/extension.ts into dist/extension.js (one file, `vscode` external, Node 20 target, source map).
// Usage: node scripts/build.mjs [--production]   (--production: minify, no source map)
import { build } from 'esbuild';
import { baseBuildOptions } from './common.mjs';

const production = process.argv.includes('--production');

await build({
  ...baseBuildOptions(),
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});
