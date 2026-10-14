// Shared helpers for the build/test/manifest scripts. Plain Node (>= 20), no dependencies, no shell: every child process
// is started from an argv array (CLAUDE.md rule 2), also on Windows.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const require = createRequire(import.meta.url);

/** Absolute path of a file inside an installed package, for example `bin('typescript', 'bin/tsc')`. */
export function pkgFile(pkg, file) {
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file);
}

/** esbuild options shared by the extension bundle and the test bundles. */
export function baseBuildOptions() {
  return {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // jsonc-parser's default entry is UMD with dynamic requires that esbuild cannot follow; its ESM entry bundles cleanly.
    mainFields: ['module', 'main'],
    legalComments: 'none',
    absWorkingDir: root,
  };
}

/** Environment for child processes: safe mode forced on, real port never inherited (CLAUDE.md hard rule 1). */
export function safeEnv(extra = {}) {
  const env = { ...process.env, MPY_SAFE_MODE: '1', UPYBRIDGE_PROJECT_ROOT: root, ...extra };
  delete env.MPY_REAL_PORT;
  return env;
}

/**
 * Run `argv` (argv[0] is the executable) in the foreground, inheriting stdio. Resolves with the exit code.
 * SIGINT/SIGTERM sent to this script are forwarded so nothing is left running.
 */
export function run(argv, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd ?? root,
      env: options.env ?? safeEnv(),
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    const forward = (signal) => () => child.kill(signal);
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const done = (code) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(code);
    };
    child.on('error', (err) => {
      console.error(`Could not start ${argv[0]}: ${err.message}`);
      done(127);
    });
    child.on('close', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}
