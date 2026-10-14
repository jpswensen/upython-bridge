// Test runner: bundles every test/**/*.test.ts with esbuild (alias vscode -> test/mocks/vscode.ts) into a per-invocation
// temp folder, then runs `node --test` on the bundles. Exit code = node's. Concurrent runs do not clash (own temp folder).
//
// Usage: npm test -- [filter] [--name <pattern>] [--keep] [--list]
//   filter        substring of the test file path (case-insensitive), e.g. `lint` or `mocks`. If no file matches, the filter
//                 is used as a test-name pattern instead (node --test-name-pattern).
//   --name, -t    test-name pattern (regular expression), passed to node --test-name-pattern
//   --keep        do not delete the temp folder (prints its path)
//   --list        print the test files and exit
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseBuildOptions, root, run, safeEnv } from './common.mjs';

const args = process.argv.slice(2);
let filter = '';
let namePattern = '';
let keep = false;
let list = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--keep') keep = true;
  else if (a === '--list') list = true;
  else if (a === '--name' || a === '-t') namePattern = args[++i] ?? '';
  else if (!a.startsWith('-')) filter = a;
  else {
    console.error(`Unknown option ${a}. Usage: npm test -- [filter] [--name <pattern>] [--keep] [--list]`);
    process.exit(2);
  }
}

function findTests(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'mocks' && entry.name !== 'node_modules') out.push(...findTests(full));
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

const testRoot = path.join(root, 'test');
const all = fs.existsSync(testRoot) ? findTests(testRoot) : [];
const rel = (f) => path.relative(root, f).split(path.sep).join('/');
let selected = all;
if (filter) {
  const needle = filter.toLowerCase();
  const byFile = all.filter((f) => rel(f).toLowerCase().includes(needle));
  if (byFile.length > 0) {
    selected = byFile;
  } else {
    namePattern = namePattern || filter;
  }
}
if (list) {
  for (const f of selected) console.log(rel(f));
  process.exit(0);
}
if (selected.length === 0) {
  console.error('No test files found under test/ (*.test.ts).');
  process.exit(2);
}

const tmp = path.join(os.tmpdir(), `upy-bridge-tests-${process.pid}-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
const cleanup = () => {
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
};
process.on('exit', cleanup);

let code = 1;
try {
  await build({
    ...baseBuildOptions(),
    entryPoints: selected,
    outdir: tmp,
    outbase: root,
    outExtension: { '.js': '.cjs' },
    alias: { vscode: path.join(root, 'test', 'mocks', 'vscode.ts') },
    sourcemap: 'inline',
    logLevel: 'warning',
  });
  const bundles = selected.map((f) => path.join(tmp, rel(f).replace(/\.ts$/, '.cjs')));
  const nodeArgs = ['--test', '--test-reporter=spec', '--enable-source-maps', '--test-timeout=120000'];
  if (namePattern) nodeArgs.push(`--test-name-pattern=${namePattern}`);
  if (keep) console.log(`Test bundles kept in ${tmp}`);
  code = await run([process.execPath, ...nodeArgs, ...bundles], { env: safeEnv() });
} catch (err) {
  console.error(`Test build failed: ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
}
process.exitCode = code;
