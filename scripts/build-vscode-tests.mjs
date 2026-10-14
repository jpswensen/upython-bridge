// Bundle the extension-host tests (test/vscode/index.ts, the --extensionTestsPath entry) into out/vscode-tests/index.js:
// platform node, CommonJS, `vscode` external (the real extension host provides it). Nothing is downloaded or run here.
// Usage: node scripts/build-vscode-tests.mjs
import { build } from 'esbuild';
import { baseBuildOptions } from './common.mjs';

await build({
  ...baseBuildOptions(),
  entryPoints: ['test/vscode/index.ts'],
  outfile: 'out/vscode-tests/index.js',
  external: ['vscode'],
  sourcemap: 'inline',
  logLevel: 'info',
});
