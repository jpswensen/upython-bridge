/**
 * Hardening of the IntelliSense library after the independent review (round 5): the tracker is untrusted input, user-owned files are
 * created exclusively, the generated config never silences the student's own files.
 * The end-to-end repros of the review itself live in test/unit/intellisense-review/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDENTITY } from '../../../src/identity';
import { createIfAbsent } from '../../../src/intellisense/atomicFs';
import { TRACKER_REL, isTrackedPath, parseTracker, runFix } from '../../../src/intellisense/fix';
import { FakeClock, MemFs, RESOURCES_STUBS } from './memfs';

const DOT = IDENTITY.dotDir;
const tracker = (extra: Record<string, unknown> = {}): string => JSON.stringify({ schema: 1, files: { [`${DOT}/a.pyi`]: 'x' }, createdOnce: {}, settings: [], stock: null, createdAt: 1, ...extra });

describe('tracker paths are untrusted', () => {
  it('accepts only workspace-relative POSIX paths below the dot folder or typings/', () => {
    for (const ok of [`${DOT}/stubs/active/machine.pyi`, `${DOT}/generated-stubs/x.pyi`, 'typings/os.pyi']) { assert.equal(isTrackedPath(ok), true, ok); }
    const bad = ['', '/etc/passwd', '../x', `${DOT}/../x`, `${DOT}/..\\x`, 'C:/x', `${DOT}//x`, `${DOT}/./x`, `${DOT}/... /x`, `${DOT}/a:b`, `${DOT}/a\0b`, 'main.py', 'pyrightconfig.json', TRACKER_REL, DOT, `${DOT}/`, 'typings', '.vscode/settings.json'];
    for (const b of bad) { assert.equal(isTrackedPath(b), false, JSON.stringify(b)); }
    assert.equal(isTrackedPath(5), false);
    assert.equal(isTrackedPath(undefined), false);
  });

  it('a tracker with ANY bad part is invalid as a whole; a good one round-trips', () => {
    const good = parseTracker(tracker({ createdOnce: { 'pyrightconfig.json': 'h' }, settings: [{ file: '.vscode/settings.json', key: 'k', value: [1] }] }));
    assert.ok(good !== null && good.createdOnce['pyrightconfig.json'] === 'h' && good.settings.length === 1);
    for (const bad of [
      tracker({ files: { [`${DOT}/a.pyi`]: 'x', '../y': 'x' } }), tracker({ files: { [`${DOT}/a.pyi`]: 5 } }), tracker({ createdOnce: { 'main.py': 'x' } }),
      tracker({ settings: [{ file: 'other.json', key: 'k', value: 1 }] }), tracker({ settings: [{ file: '.vscode/settings.json', key: 7 }] }), tracker({ files: [] }), tracker({ schema: 2 }), '[]', 'null', '{',
    ]) { assert.equal(parseTracker(bad), null, bad); }
  });

  it('a hostile tracker is reported (W_TRACKER_INVALID) and nothing it lists is removed', async () => {
    const mem = new MemFs('posix');
    mem.put('/w/main.py', 'x');
    mem.put('/w/keep.txt', 'mine');
    mem.put(`/w/${TRACKER_REL}`, tracker({ files: { '../keep.txt': 'x', 'main.py': 'x' } }));
    const { plan, result } = await runFix({ fs: mem, clock: new FakeClock() }, { workspace: '/w', resourcesDir: RESOURCES_STUBS, board: null, stubs: 'off' }, { apply: true });
    assert.ok(plan.warnings.some((w) => w.code === 'W_TRACKER_INVALID'));
    assert.deepEqual(plan.removes, []);
    assert.deepEqual(result?.errors, []);
    assert.equal(mem.text('/w/main.py'), 'x');
    assert.equal(mem.text('/w/keep.txt'), 'mine');
    assert.ok(parseTracker(mem.text(`/w/${TRACKER_REL}`)) !== null, 'the invalid tracker was replaced by a valid one');
  });
});

describe('the generated config never silences the student\'s own files', () => {
  it('a folder that is or contains the workspace goes into extraPaths only, with a warning', async () => {
    const mem = new MemFs('posix');
    mem.put('/fw/labs/lab1/main.py', 'x');
    const req = { workspace: '/fw/labs/lab1', resourcesDir: RESOURCES_STUBS, board: null, stubs: 'off', settings: { customStubDirs: ['../..', '.'] } };
    const { plan } = await runFix({ fs: mem, clock: new FakeClock() }, req, { apply: false });
    assert.deepEqual(plan.facts.ignore, []);
    assert.deepEqual(plan.facts.extraPaths, ['../lib', '../../..', '..']);
    assert.ok(plan.warnings.filter((w) => w.code === 'W_ROOT_CONTAINS_WORKSPACE').length === 2);
  });
});

describe('state files that stay locked', () => {
  it('a user config that cannot be read after the retries is reported and never overwritten', async () => {
    const mem = new MemFs('posix');
    mem.put('/w/main.py', 'x');
    mem.failures.push({ op: 'readFile', match: /pyrightconfig\.json$/, code: 'EBUSY', times: 999 });
    const { plan, result } = await runFix({ fs: mem, clock: new FakeClock() }, { workspace: '/w', resourcesDir: RESOURCES_STUBS, board: null, stubs: 'off', consent: { createUserConfig: true } }, { apply: true });
    assert.ok(plan.warnings.some((w) => w.code === 'W_STATE_UNREADABLE' && w.path === 'pyrightconfig.json'));
    assert.ok(!plan.writes.some((w) => w.path === 'pyrightconfig.json'));
    assert.deepEqual(result?.errors, []);
  });
});

describe('files that belong to the user are created exclusively', () => {
  it('createIfAbsent creates once and never replaces', async () => {
    const mem = new MemFs('posix');
    const clock = new FakeClock();
    assert.equal(await createIfAbsent(mem, clock, '/w/a.json', 'one'), true);
    assert.equal(await createIfAbsent(mem, clock, '/w/a.json', 'two'), false);
    assert.equal(mem.text('/w/a.json'), 'one');
  });
});
