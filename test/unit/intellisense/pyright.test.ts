/**
 * The truth test with a REAL pyright (scripts/verify-intellisense.mjs): before the fix-up the imports are unresolved/flagged,
 * after it there are 0 errors and the deliberately wrong calls are flagged. Skipped unless UPYBRIDGE_PYRIGHT is set, because it
 * needs pyright (downloaded with npx the first time) and takes about a minute:
 *
 *   UPYBRIDGE_PYRIGHT=1 npm test -- intellisense/pyright            # npx --yes pyright@<pinned version>
 *   UPYBRIDGE_PYRIGHT=/path/to/pyright/index.js npm test -- intellisense/pyright
 *   UPYBRIDGE_SCRATCH=<dir> keeps the scratch workspaces (default: a new temp folder).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { describe, it } from 'node:test';
import { projectRoot } from '../../mocks/fixtures';

const enabled = process.env.UPYBRIDGE_PYRIGHT !== undefined && process.env.UPYBRIDGE_PYRIGHT !== '';

describe('real pyright over scratch workspaces', () => {
  it('resolves board-generated and stock modules, flags the wrong calls, and a second run changes nothing', { skip: enabled ? false : 'set UPYBRIDGE_PYRIGHT=1 to run it with a real pyright', timeout: 600_000 }, async () => {
    const scratch = process.env.UPYBRIDGE_SCRATCH ?? fs.mkdtempSync(nodePath.join(os.tmpdir(), 'upy-bridge-truth-'));
    const r = spawnSync(process.execPath, [nodePath.join(projectRoot(), 'scripts', 'verify-intellisense.mjs'), '--json', '--scratch', scratch], {
      timeout: 550_000, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MPY_SAFE_MODE: '1' },
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const summary = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { pyright: string; failed: number; results: { scenario: string; name: string; ok: boolean }[] };
    assert.equal(summary.failed, 0, JSON.stringify(summary.results.filter((x) => !x.ok)));
    assert.deepEqual([...new Set(summary.results.map((x) => x.scenario))], ['acme', 'rp2', 'esp8266']);
    assert.ok(summary.results.length >= 20);
  });
});
