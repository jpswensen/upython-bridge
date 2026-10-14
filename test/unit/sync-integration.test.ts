/**
 * Sync against the REAL Python bridge and a REAL fake board (tools/fakeboard.py over a loopback socket; never a serial port;
 * MPY_SAFE_MODE=1 is forced by the harness). The board filesystem is a temp folder on the host, so the tests can look at
 * exactly what the bridge wrote. Skipped, with the reason, when no Python >= 3.9 is available.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { registerSyncCommands } from '../../src/commands/sync';
import { COMMAND_IDS } from '../../src/contributes';
import { boardKeyOf } from '../../src/sync/baseline';
import { integrationSkipReason, stopAll, withBridge, type FakeBoardOptions } from '../mocks/fakeBridge';
import { TempDirs } from '../mocks/fixtures';
import { mock } from '../mocks/vscode';
import * as vscode from 'vscode';
import { makeKit, sha, waitFor, type Kit, type KitOptions } from './sync/kit';
import { RawBridgeSession } from './sync/rawSession';

const skip = integrationSkipReason();
const dirs = new TempDirs();
let kit: Kit | undefined;

beforeEach(() => mock.reset());
afterEach(async () => {
  kit?.dispose();
  kit = undefined;
  dirs.cleanup();
  await stopAll();
});

const tickAll = (conflicts: boolean) => (items: readonly unknown[]): unknown[] =>
  (items as { sync?: { selected: boolean; action: string } }[]).filter((i) => i.sync && (i.sync.selected || (conflicts && i.sync.action === 'conflict')));
const stopProgram = (): void => mock.answerMessage(/program is still running/, 'Stop the program and continue');

/** Run `fn` with a kit whose session talks to the real bridge, connected to a fake board whose filesystem is `boardRoot`. */
async function withRealBoard(
  opts: Omit<KitOptions, 'boardSession'> & { profile?: string; board?: FakeBoardOptions },
  seed: Record<string, string>,
  fn: (k: Kit, boardRoot: string, session: RawBridgeSession) => Promise<void>,
): Promise<void> {
  const boardRoot = dirs.make('upy-bridge-board');
  for (const [p, text] of Object.entries(seed)) {
    fs.mkdirSync(path.dirname(path.join(boardRoot, p)), { recursive: true });
    fs.writeFileSync(path.join(boardRoot, p), text);
  }
  await withBridge(async ({ board, bridge }) => {
    const session = new RawBridgeSession(bridge);
    await session.connect(board.url);
    kit = makeKit({ ...opts, boardSession: session, selectPortStub: true });
    for (const d of registerSyncCommands(kit.services, { sync: kit.sync })) { mock.track(d); }
    stopProgram();
    await fn(kit, boardRoot, session);
  }, { profile: opts.profile ?? 'esp32', root: boardRoot, ...opts.board });
}

const onBoard = (root: string, rel: string): string | undefined => {
  const p = path.join(root, ...rel.split('/'));
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
};

describe('sync against the real bridge', { skip }, () => {
  it('uploads a project with awkward names, finds nothing left to do, then sends only what changed', { timeout: 120000 }, async () => {
    await withRealBoard({ tricky: true, local: { 'main.py': 'print(1)', 'lib/café (v2).py': 'x = 2', 'data/readings 1.csv': '1,2\n3,4\n' } }, {}, async (k, root, session) => {
      mock.answerQuickPick(tickAll(false));
      await vscode.commands.executeCommand(COMMAND_IDS.syncToBoard);
      assert.equal(onBoard(root, 'main.py'), 'print(1)');
      assert.equal(onBoard(root, 'lib/café (v2).py'), 'x = 2');
      assert.equal(onBoard(root, 'data/readings 1.csv'), '1,2\n3,4\n');
      assert.match(mock.messages('info').map((m) => m.message).join('\n'), /3 uploaded\./);
      assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.mpytmp')), [], 'no temp files left on the board');

      await vscode.commands.executeCommand(COMMAND_IDS.syncToBoard);
      assert.match(mock.messages('info').map((m) => m.message).join('\n'), /already has every file/);
      assert.equal(mock.calls.quickPicks.length, 1, 'the second run needed no list');

      k.write('main.py', 'print(2)');
      session.calls.length = 0;
      mock.answerQuickPick(tickAll(false));
      await vscode.commands.executeCommand(COMMAND_IDS.syncToBoard);
      assert.equal(onBoard(root, 'main.py'), 'print(2)');
      const puts = session.calls.filter((c) => c.op === 'fs.put').map((c) => (c.args as { remote: string }).remote);
      assert.deepEqual(puts, ['/main.py']);
      assert.equal(session.calls.filter((c) => c.op === 'fs.rm' || c.op === 'fs.rmtree').length, 0);
    });
  });

  it('downloads a change made on the board and keeps a copy of the replaced local file', { timeout: 120000 }, async () => {
    await withRealBoard({ local: { 'a.py': 'v1' } }, { 'a.py': 'v1' }, async (k, root) => {
      await vscode.commands.executeCommand(COMMAND_IDS.syncToBoard); // records the baseline (identical files)
      assert.match(mock.messages('info').map((m) => m.message).join('\n'), /already has every file/);
      fs.writeFileSync(path.join(root, 'a.py'), 'v2 edited on the board');
      mock.answerQuickPick(tickAll(false));
      mock.answerMessage(/Replace files on your computer/, 'Download 1 file(s)');
      await vscode.commands.executeCommand(COMMAND_IDS.syncFromBoard);
      assert.equal(k.read('a.py'), 'v2 edited on the board');
      assert.equal(fs.readFileSync(path.join(k.sync.engine.lastBackupDir ?? '', 'a.py'), 'utf8'), 'v1');
      assert.deepEqual(fs.readdirSync(k.workspace).filter((n) => n.endsWith('.mpytmp')), []);
    });
  });

  it('shows the real bridge refusal for a name that hides a built-in module, in plain words', { timeout: 120000 }, async () => {
    await withRealBoard({ local: { 'alpha.py': 'x', 'ok.py': 'y' } }, {}, async (k, root, session) => {
      await session.call('config', { shadowGuard: ['alpha'] });
      mock.answerQuickPick(tickAll(false));
      await vscode.commands.executeCommand(COMMAND_IDS.syncToBoard);
      assert.equal(onBoard(root, 'alpha.py'), undefined);
      assert.equal(onBoard(root, 'ok.py'), 'y');
      assert.match(mock.messages('warn').map((m) => m.message).join('\n'), /1 uploaded, 1 failed: alpha\.py - this name is used by a module that is built into the board/);
      const ctx = await k.sync.folderContext();
      const identity = session.state.identity;
      assert.ok(ctx && identity);
      assert.deepEqual(Object.keys((await ctx.store.load(boardKeyOf(identity))).files), ['ok.py'], 'the refused file is not in the sync history');
    });
  });

  it('compares by downloading when the board cannot compute sha256 (same size, different content)', { timeout: 120000 }, async () => {
    await withRealBoard(
      { profile: 'esp8266', local: { 'same.py': 'abc', 'diff.py': 'abc', 'new.py': 'n' } },
      { 'same.py': 'abc', 'diff.py': 'abd' },
      async (k, root, session) => {
        mock.answerQuickPick(tickAll(false));
        await vscode.commands.executeCommand(COMMAND_IDS.syncToBoard);
        assert.ok(session.calls.some((c) => c.op === 'fs.get'), 'same-size files were downloaded to be compared');
        const labels = mock.calls.quickPicks[0]?.labels ?? [];
        assert.ok(labels.includes('new.py') && labels.includes('diff.py'));
        assert.ok(!labels.includes('same.py'), 'identical content is not listed');
        assert.equal(onBoard(root, 'new.py'), 'n');
        assert.equal(onBoard(root, 'diff.py'), 'abd', 'a file that differs is only replaced when ticked');
        assert.equal(k.exists('same.py'), true);
      },
    );
  });

  it('clears only the configured board folder, verifies by listing again, and leaves the rest', { timeout: 120000 }, async () => {
    await withRealBoard({ rootPath: '/app' }, { 'keep.txt': 'k', 'app/a.py': 'a', 'app/sub/b.py': 'b' }, async (_k, root, session) => {
      mock.answerMessage(/Delete everything in \/app/, 'Delete 2 items');
      await vscode.commands.executeCommand(COMMAND_IDS.clearDevice);
      assert.equal(onBoard(root, 'keep.txt'), 'k');
      assert.deepEqual(fs.readdirSync(path.join(root, 'app')), [], 'the folder itself stays');
      assert.match(mock.messages('info').map((m) => m.message).join('\n'), /Deleted 2 items from \/app\. The folder is now empty\./);
      const tree = session.calls.filter((c) => c.op === 'fs.rmtree').map((c) => c.args as { path: string; confirm: boolean });
      assert.deepEqual(tree.map((t) => [t.path, t.confirm]), [['/app/sub', true]]);
    });
  });

  it('auto-sync sends a saved file with the background flag and skips a touched one', { timeout: 120000 }, async () => {
    await withRealBoard({ autoSync: 'on' }, {}, async (k, root, session) => {
      k.sync.start();
      k.write('main.py', 'print("hi")');
      await mock.saveFile(vscode.Uri.file(`${k.workspace}/main.py`), 'print("hi")');
      await waitFor(() => k.scheduler.size === 1, 'the debounce timer');
      k.scheduler.runAll();
      await waitFor(() => onBoard(root, 'main.py') === 'print("hi")', 'the upload');
      const first = session.calls.find((c) => c.op === 'fs.put');
      assert.equal((first?.args as { background?: boolean }).background, true);
      assert.equal((first?.args as { expectSha?: string }).expectSha, sha('print("hi")'));
      await waitFor(() => k.sync.pendingCount === 0);
      const before = session.calls.filter((c) => c.op === 'fs.put').length;
      await mock.saveFile(vscode.Uri.file(`${k.workspace}/main.py`), 'print("hi")');
      await waitFor(() => k.scheduler.size === 1, 'the debounce timer');
      k.scheduler.runAll();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(session.calls.filter((c) => c.op === 'fs.put').length, before, 'a touched file is not sent again');
    });
  });
});
