/**
 * Regression for the rename-review finding "docs/extension-design.md line 178 still names the old temp-folder prefix `mpybench-tests-`".
 * The runner (scripts/run-tests.mjs) is the source of truth for the folder name; the prose must agree with it. Pure Node, no VS Code.
 *
 *   npm test -- rename-review/tempprefix
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { projectRoot } from '../../mocks/fixtures';

const root = projectRoot();
const text = (rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

/** `upy-bridge-tests` out of `path.join(os.tmpdir(), \`upy-bridge-tests-${process.pid}-${Date.now()}\`)`. */
function runnerPrefix(): string {
  const m = /os\.tmpdir\(\),\s*`([\w-]+-tests)-\$\{process\.pid\}/.exec(text('scripts/run-tests.mjs'));
  assert.ok(m, 'scripts/run-tests.mjs creates its bundle folder as <prefix>-${process.pid}-...');
  return m[1];
}

/** The prefix a document states after `os.tmpdir()/`, or undefined when it does not state one. */
function documentedPrefix(rel: string): string | undefined {
  return /os\.tmpdir\(\)\/([\w-]+-tests)-/.exec(text(rel))?.[1];
}

describe('rename review: the test-bundle temp folder prefix', () => {
  it('the runner uses the new product prefix and no old spelling', () => {
    assert.equal(runnerPrefix(), 'upy-bridge-tests');
    assert.doesNotMatch(text('scripts/run-tests.mjs'), /mpy[\s_-]*bench/i);
  });

  it('no live text we own (README, DEVELOPING, CLAUDE, the live docs, scripts, the launcher) states the old prefix', () => {
    const files = [
      'README.md', 'DEVELOPING.md', 'CLAUDE.md', 'docs/requirements.md', 'docs/protocol.md', 'docs/protocol-addendum-reset.md',
      'tools/vscode_test/launch.py', 'tools/vscode_test/README.md',
      ...fs.readdirSync(path.join(root, 'scripts')).filter((n) => /\.(mjs|mts|js)$/.test(n)).map((n) => `scripts/${n}`),
    ];
    for (const f of files) { assert.doesNotMatch(text(f), /mpybench[-_]tests/i, f); }
  });

  // docs/extension-design.md is outside the writable list of the rename-fixer agent: line 178 must be changed by the orchestrator
  // (`os.tmpdir()/mpybench-tests-<pid>-<time>` -> `os.tmpdir()/upy-bridge-tests-<pid>-<time>`). Until then this test reports as TODO
  // (a failing TODO does not fail the run); once the line is fixed it passes and the `todo` option should be removed.
  it('docs/extension-design.md states the folder prefix the runner really uses', () => {
    assert.equal(documentedPrefix('docs/extension-design.md'), runnerPrefix());
  });
});
