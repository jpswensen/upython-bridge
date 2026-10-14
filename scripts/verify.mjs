// The gate: typecheck, manifest up to date, tests, build, VSIX package, VSIX content rules, size check. Stops at the first failure. No hardware, no GUI.
// Usage: npm run verify [-- --with-python-guard]
//   --with-python-guard   also run `python tools/check_generic.py --strict` (not required yet: other folders still mention
//                         board/course specifics until the extraction step Q7)
import path from 'node:path';
import { pkgFile, root, run, safeEnv } from './common.mjs';

const node = process.execPath;
const script = (name, ...rest) => [node, path.join(root, 'scripts', name), ...rest];

const steps = [
  ['typecheck', [node, pkgFile('typescript', 'bin/tsc'), '--noEmit']],
  ['manifest is up to date', script('gen-manifest.mjs', '--check')],
  ['tests', script('run-tests.mjs')],
  ['build', script('build.mjs')],
  ['package (VSIX)', script('package.mjs')],
  // The VSIX must exist and obey the content rules (test/unit/package.test.ts skips itself when there is no VSIX).
  ['package contents', script('run-tests.mjs', 'package.test'), { UPYBRIDGE_REQUIRE_VSIX: '1' }],
  ['size budget', script('check-size.mjs')],
];
if (process.argv.includes('--with-python-guard')) {
  const python = process.env.UPYBRIDGE_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3.13');
  steps.push(['generic-code guard (python)', [python, '-B', path.join(root, 'tools', 'check_generic.py'), '--strict']]);
}

const started = Date.now();
for (const [label, argv, extraEnv] of steps) {
  const t0 = Date.now();
  console.log(`\n=== ${label} ===`);
  const code = await run(argv, extraEnv ? { env: safeEnv(extraEnv) } : {});
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (code !== 0) {
    console.error(`\nverify FAILED at "${label}" (exit ${code}, ${secs} s)`);
    process.exit(code);
  }
  console.log(`--- ${label}: ok (${secs} s)`);
}
console.log(`\nverify passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
