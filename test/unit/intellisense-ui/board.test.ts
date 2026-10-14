/**
 * The command side of the board-based stubs (src/commands/intellisense.ts + src/intellisense/board.ts) against the mocked vscode
 * and a scripted FakeSession shaped like the bridge (test/fixtures/intellisense/acme-board.json): the import question is asked
 * once per firmware, Skip holds for automatic runs, ONE soft reset follows the imports, nothing is read while a program runs,
 * the files are kept while the board is away, and Remove deletes them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IMPORT_ANSWERS_KEY, IntelliSenseController } from '../../../src/commands/intellisense';
import { ScriptedPrompter } from '../../../src/testApi';
import type { BoardIdentity } from '../../../src/types/protocol';
import { FAKE_IDENTITY, FakeSession } from '../../mocks/fakeSession';
import { TempDirs } from '../../mocks/fixtures';
import { mock } from '../../mocks/vscode';
import { makeHarness, type Harness } from '../repl.helpers';
import { FIXTURES, acmeFixture } from '../intellisense/acmeBoard';

const dirs = new TempDirs();
let h: Harness | undefined;
beforeEach(() => mock.reset());
afterEach(() => {
  h?.dispose();
  h = undefined;
  mock.reset();
  dirs.cleanup();
});

const ACME_ID: BoardIdentity = { ...FAKE_IDENTITY, build: 'ACME_BOARD', machine: 'Acme Motor Controller with ESP32', syspath: ['', '.frozen', '/lib'] };

interface Rig { ws: string; session: FakeSession; controller: IntelliSenseController; prompter: ScriptedPrompter; ops(): string[] }

function rig(session = FakeSession.connected({ identity: ACME_ID })): Rig {
  const fx = acmeFixture();
  const base = dirs.make('is-board');
  const ws = path.join(base, 'ws (board)');
  fs.cpSync(path.join(FIXTURES, 'student-board'), ws, { recursive: true });
  mock.setWorkspaceFolders(ws);
  session.useBoardFs({ '/lib/helper.py': fx.files['/lib/helper.py'] as string, '/boot.py': '# boot\n' });
  session.script('introspect.modules', (args) => {
    const modules: Record<string, unknown> = {};
    for (const n of args.names ?? []) { modules[n] = fx.modules[n] ?? { attrs: [], error: `ImportError: no module named '${n}'` }; }
    return { listing: fx.listing, modules } as never;
  });
  h = makeHarness(session);
  const prompter = new ScriptedPrompter();
  prompter.set({ consent: { createUserConfig: true } });
  const controller = new IntelliSenseController(h.services, { prompter, stagingDir: path.join(base, 'staging') });
  const ops = (): string[] => session.calls
    .filter((c) => ['introspect.modules', 'reset.soft', 'fs.get', 'fs.list'].includes(c.op))
    .map((c) => (c.op === 'introspect.modules' ? `introspect${(c.args as { names?: string[] }).names ? `:${(c.args as { names: string[] }).names.join(',')}` : ''}` : c.op === 'fs.get' ? `get:${(c.args as { remote: string }).remote}` : c.op === 'fs.list' ? `list:${(c.args as { path: string }).path}` : c.op));
  return { ws, session, controller, prompter, ops };
}

const exists = (...p: string[]): boolean => fs.existsSync(path.join(...p));

describe('IntelliSense from the board (command)', () => {
  it('asks once, imports the custom modules, soft-resets ONCE afterwards, writes the stubs and the copy, and shows where each came from', async () => {
    const r = rig();
    const out = await r.controller.fix();
    assert.equal(out.status, 'applied');
    assert.deepEqual(r.prompter.record.imports, [['_acme', 'acme']]);
    assert.deepEqual(r.ops(), ['introspect', 'list:/lib', 'get:/lib/helper.py', 'introspect:_acme,acme,acme.motor,acme.pins', 'introspect:acme.extra', 'reset.soft']);
    assert.equal(out.board?.softReset, true);
    assert.deepEqual(r.session.callsOf('reset.soft').map((c) => c.args), [{ skipMain: true }], 'the cleanup reset must not start main.py');
    for (const rel of ['acme/__init__.pyi', 'acme/motor.pyi', 'acme/pins.pyi', 'acme/extra.pyi', '_acme.pyi', 'machine.pyi']) {
      assert.ok(exists(r.ws, '.upy-bridge', 'stubs', 'active', ...rel.split('/')), rel);
    }
    assert.ok(exists(r.ws, '.upy-bridge', 'board-lib', 'helper.py'));
    assert.equal(exists(r.ws, '.upy-bridge', 'stubs', 'active', 'acme_extra.pyi'), false, 'the local typings/acme_extra.pyi wins');
    const preview = (await import('vscode')).workspace.textDocuments.map((d) => d.getText()).join('\n');
    assert.match(preview, /## What comes from your board/);
    assert.match(preview, /`acme_extra` - built into the firmware: not used, because your project has its own acme_extra/);
    assert.match(preview, /`helper` - file on the board \(\/lib\/helper\.py\): a read-only copy/);
    assert.match(preview, /soft-reset afterwards/);
    assert.equal(fs.existsSync(path.join(r.ws, '..', 'staging')), false, 'the download folder is gone');

    // second explicit run: no second question (one per firmware), the board is read again, one more reset, nothing to write
    const again = await r.controller.fix();
    assert.equal(r.prompter.record.imports.length, 1);
    assert.equal(again.status, 'up-to-date');
    assert.equal(r.ops().filter((o) => o === 'reset.soft').length, 2);
  });

  it('Skip: nothing is imported and no reset; automatic runs do not ask again; the command asks again', async () => {
    const r = rig();
    r.prompter.set({ importModules: 'skip' });
    await r.controller.fix();
    assert.ok(!r.ops().some((o) => o.startsWith('introspect:')));
    assert.ok(!r.ops().includes('reset.soft'));
    assert.match(fs.readFileSync(path.join(r.ws, '.upy-bridge', 'stubs', 'active', '_acme.pyi'), 'utf8'), /def __getattr__/);
    await r.controller.fix({ source: 'quickfix' });
    assert.equal(r.prompter.record.imports.length, 1, 'the quick fix keeps the Skip');
    await r.controller.fix({ source: 'palette' });
    assert.equal(r.prompter.record.imports.length, 2, 'running the command asks again');
  });

  it('a program running on the board: says so and stops, nothing is sent to the board', async () => {
    const r = rig(FakeSession.connected({ identity: ACME_ID, state: 'running' }));
    const out = await r.controller.fix();
    assert.equal(out.status, 'board-busy');
    assert.deepEqual(r.ops(), []);
    assert.match(mock.messages('warn').map((m) => m.message).join('\n'), /A program is running on your board/);
    assert.equal(exists(r.ws, '.upy-bridge'), false);
  });

  it('board unplugged later: the files made from it are kept; an automatic run on unchanged firmware only lists the modules', async () => {
    const r = rig();
    await r.controller.fix();
    const before = r.ops().length;
    r.session.setState({ state: 'disconnected', identity: null, port: null });
    const away = await r.controller.fix();
    assert.equal(r.ops().length, before, 'nothing sent while unplugged');
    assert.ok(exists(r.ws, '.upy-bridge', 'stubs', 'active', '_acme.pyi'));
    assert.ok(exists(r.ws, '.upy-bridge', 'board-lib', 'helper.py'));
    assert.notEqual(away.status, 'failed');
    r.session.setState({ state: 'idle', identity: ACME_ID, port: '/dev/cu.fake' });
    const auto = await r.controller.fix({ source: 'quickfix' });
    assert.deepEqual(r.ops().slice(before), ['introspect'], 'the listing only: same firmware');
    // (the stock stubs come back: without a board only the standard library stubs were kept) but no board file is rewritten
    assert.ok(!(auto.written ?? []).some((w) => /_acme|acme\/|board-lib/.test(w)), (auto.written ?? []).join(', '));
    assert.ok(exists(r.ws, '.upy-bridge', 'stubs', 'active', '_acme.pyi'));
  });

  it('Remove deletes every file made from the board and forgets the import answers', async () => {
    const r = rig();
    await r.controller.fix();
    assert.ok(Object.keys(h?.ctx.workspaceState.get<Record<string, string>>(IMPORT_ANSWERS_KEY) ?? {}).length > 0);
    const res = await r.controller.remove();
    assert.ok(res && res.errors.length === 0);
    assert.equal(exists(r.ws, '.upy-bridge'), false);
    assert.equal(h?.ctx.workspaceState.get(IMPORT_ANSWERS_KEY), undefined);
    assert.ok(exists(r.ws, 'typings', 'acme_extra.pyi') && exists(r.ws, 'main.py'));
  });
});
