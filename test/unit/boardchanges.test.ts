/**
 * "Something on the board changed, so the Files view must show it" (the stale-view bug found in the real VS Code host on
 * 2026-10-13: Upload Current File put the file on the board, but the Files view kept the listing it had cached).
 *
 * One rule, tested in three layers:
 *  1. which engine outcomes announce which board paths (SyncEngine.changes / SyncService.onBoardChanged),
 *  2. which folders the Files view re-lists for a set of changed paths (FilesTree.boardChanged),
 *  3. the whole chain, through the same wiring as the extension (registerViews with the sync service as its change source),
 *     including the regression test for Upload Current File.
 * Mocked `vscode`, FakeSession with an in-memory board; no port, no bridge.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { registerBoardFileCommands } from '../../src/commands/boardFiles';
import { registerSyncCommands } from '../../src/commands/sync';
import { COMMAND_IDS, VIEWS } from '../../src/contributes';
import { settingId } from '../../src/identity';
import type { Prepared } from '../../src/sync';
import { Settings } from '../../src/types/settings';
import type { BoardNode, SyncItem, SyncPlan, SyncResult } from '../../src/types/sync';
import { FilesTree, type FilesNode } from '../../src/views/filesView';
import { registerViews } from '../../src/views';
import { FILES_TEXT } from '../../src/views/strings';
import { FakeSession, enc } from '../mocks/fakeSession';
import { createExtensionContext, createTestLogger, mock, type MockTreeView } from '../mocks/vscode';
import type { MockExtensionContext } from '../mocks/extensionContext';
import { makeKit, waitFor, type Kit } from './sync/kit';

let kit: Kit | undefined;
let trees: FilesTree[] = [];
let sessions: FakeSession[] = [];
let ctx: MockExtensionContext | undefined;
beforeEach(() => {
  mock.reset();
  // D-24: the extension works only with a project folder open (views and connect)
  mock.setWorkspaceFolders(os.tmpdir());
});
afterEach(() => {
  trees.forEach((t) => t.dispose());
  sessions.forEach((s) => s.dispose());
  trees = [];
  sessions = [];
  ctx?.dispose();
  ctx = undefined;
  kit?.dispose();
  kit = undefined;
});

// ------------------------------------------------------------------ layer 1: engine outcome -> announced paths

/** Everything announced by the sync service, one entry per event (paths sorted, so the order of items does not matter). */
function recordEvents(k: Kit): string[][] {
  const events: string[][] = [];
  mock.track(k.sync.onBoardChanged((paths) => { events.push([...paths].sort()); }));
  return events;
}

async function prepared(k: Kit, direction: 'toBoard' | 'fromBoard'): Promise<Prepared> {
  const prep = await k.sync.prepare(direction, k.sync.newConsent('test'));
  assert.ok(prep, 'prepare returned nothing');
  return prep;
}

const run = (k: Kit, prep: Prepared, plan: SyncPlan = prep.plan): Promise<SyncResult> =>
  k.sync.engine.execute(plan, { baseline: prep.ctx.store, board: prep.board, title: 'test', quiet: true });

/** A plan with one hand-made item (delete and mkdir are never produced by the automatic planner, but the engine runs them). */
function withItem(k: Kit, prep: Prepared, item: Partial<SyncItem> & Pick<SyncItem, 'path' | 'action' | 'kind'>): SyncPlan {
  const full: SyncItem = {
    remote: `/${item.path}`, local: path.join(k.workspace, ...item.path.split('/')), reason: 'user-request', size: 0, selected: true, ...item,
  };
  return { ...prep.plan, items: [full] };
}

interface EngineRow {
  readonly name: string;
  readonly kit: Parameters<typeof makeKit>[0];
  readonly act: (k: Kit) => Promise<unknown>;
  /** Expected events: [] means "nothing is announced". */
  readonly events: string[][];
}

const ENGINE_ROWS: readonly EngineRow[] = [
  {
    name: 'upload of a nested file announces that file only (its parent is re-listed, nothing else)',
    kit: { local: { 'lib/pkg/a.py': 'a' } },
    act: async (k) => run(k, await prepared(k, 'toBoard')),
    events: [['/lib/pkg/a.py']],
  },
  {
    name: 'two uploads in one run are ONE event with both paths (coalesced per execute)',
    kit: { local: { 'lib/a.py': 'a', 'lib/b.py': 'b' } },
    act: async (k) => run(k, await prepared(k, 'toBoard')),
    events: [['/lib/a.py', '/lib/b.py']],
  },
  {
    name: 'a failed upload announces nothing',
    kit: { local: { 'a.py': 'a' } },
    act: async (k) => {
      k.session.fail('fs.put', 'E_FS_ERRNO', 'The board is full.', { detail: 'ENOSPC' });
      return run(k, await prepared(k, 'toBoard'));
    },
    events: [],
  },
  {
    name: 'one failed and one good upload announce only the good one',
    kit: { local: { 'a.py': 'a', 'b.py': 'b' } },
    act: async (k) => {
      k.session.fail('fs.put', 'E_FS_ERRNO', 'The board is full.', { detail: 'ENOSPC' });
      return run(k, await prepared(k, 'toBoard'));
    },
    events: [['/b.py']],
  },
  {
    name: 'an upload the board did not need (skipped: same bytes already there) announces nothing',
    kit: { local: { 'a.py': 'a' }, board: { '/a.py': 'a' } },
    act: (k) => k.sync.uploadFile(vscode.Uri.file(path.join(k.workspace, 'a.py'))),
    events: [],
  },
  {
    name: 'Upload Current File of a new file announces it',
    kit: { local: { 'lib/a.py': 'a' } },
    act: (k) => k.sync.uploadFile(vscode.Uri.file(path.join(k.workspace, 'lib', 'a.py'))),
    events: [['/lib/a.py']],
  },
  {
    name: 'a delete on the board announces the deleted path (its parent is re-listed)',
    kit: { board: { '/lib/old.py': 'x' } },
    act: async (k) => {
      const prep = await prepared(k, 'toBoard');
      return run(k, prep, withItem(k, prep, { path: 'lib/old.py', action: 'delete-board', kind: 'file', reason: 'board-only' }));
    },
    events: [['/lib/old.py']],
  },
  {
    name: 'a delete that failed announces nothing',
    kit: { board: { '/lib/old.py': 'x' } },
    act: async (k) => {
      k.session.fail('fs.rm', 'E_FS_ERRNO', 'The file is read-only.', { detail: 'EACCES' });
      const prep = await prepared(k, 'toBoard');
      return run(k, prep, withItem(k, prep, { path: 'lib/old.py', action: 'delete-board', kind: 'file', reason: 'board-only' }));
    },
    events: [],
  },
  {
    name: 'a new folder on the board announces the folder',
    kit: { board: { '/main.py': 'm' } },
    act: async (k) => {
      const prep = await prepared(k, 'toBoard');
      return run(k, prep, withItem(k, prep, { path: 'data', action: 'mkdir', kind: 'dir' }));
    },
    events: [['/data']],
  },
  {
    name: 'a folder that already existed announces nothing',
    kit: { board: { '/data/x.csv': '1' } },
    act: async (k) => {
      const prep = await prepared(k, 'toBoard');
      return run(k, prep, withItem(k, prep, { path: 'data', action: 'mkdir', kind: 'dir' }));
    },
    events: [],
  },
  {
    name: 'a download changes the computer, not the board: nothing is announced',
    kit: { board: { '/lib/a.py': 'a', '/b.py': 'b' } },
    act: async (k) => run(k, await prepared(k, 'fromBoard')),
    events: [],
  },
  {
    name: 'a nothing-to-do run announces nothing',
    kit: { local: { 'a.py': 'a' }, board: { '/a.py': 'a' } },
    act: async (k) => run(k, await prepared(k, 'toBoard')),
    events: [],
  },
  {
    name: 'Clear Device Files announces everything it removed, one event (the root is re-listed)',
    kit: { board: { '/main.py': 'm', '/lib/x.py': 'x' } },
    act: async (k) => {
      mock.answerMessage(/Delete everything in \//, 'Delete 2 items');
      return k.sync.clearDevice();
    },
    events: [['/lib', '/main.py']],
  },
  {
    name: 'Clear Device Files on an empty board announces nothing',
    kit: { board: {} },
    act: (k) => k.sync.clearDevice(),
    events: [],
  },
  {
    name: 'Clear Device Files that the student declines announces nothing',
    kit: { board: { '/main.py': 'm' } },
    act: async (k) => {
      mock.answerMessage(/Delete everything in \//, undefined);
      return k.sync.clearDevice();
    },
    events: [],
  },
  {
    name: 'Clear Device Files in a project folder announces paths inside that folder only',
    kit: { rootPath: '/app', board: { '/app/a.py': 'a', '/other.py': 'o' } },
    act: async (k) => {
      mock.answerMessage(/Delete everything in \/app/, 'Delete 1 item');
      return k.sync.clearDevice();
    },
    events: [['/app/a.py']],
  },
];

describe('engine outcomes -> announced board changes', () => {
  for (const row of ENGINE_ROWS) {
    it(row.name, async () => {
      kit = makeKit({ tricky: true, ...row.kit });
      const events = recordEvents(kit);
      await row.act(kit);
      assert.deepEqual(events, row.events);
    });
  }

  it('an auto-sync upload (background run) announces the file too', async () => {
    kit = makeKit({ autoSync: 'on' });
    kit.sync.start();
    const events = recordEvents(kit);
    const abs = path.join(kit.workspace, 'main.py');
    kit.write('main.py', 'print(1)');
    await mock.saveFile(vscode.Uri.file(abs), 'print(1)');
    await waitFor(() => kit!.scheduler.size >= 1, 'the auto-sync timer');
    assert.deepEqual(events, [], 'nothing is announced before the upload happened');
    kit.scheduler.runAll();
    await waitFor(() => events.length > 0, 'the announcement after the upload');
    assert.deepEqual(events, [['/main.py']]);
  });

  it('a cancelled run announces only what had already been written', async () => {
    kit = makeKit({ local: { 'a.py': 'a', 'b.py': 'b' } });
    const events = recordEvents(kit);
    const prep = await prepared(kit, 'toBoard');
    const gate = kit.session.hold('fs.put');
    const running = run(kit, prep);
    await gate.arrived;
    mock.calls.progress[mock.calls.progress.length - 1]?.cancel();
    const res = await running;
    gate.release();
    assert.deepEqual(res.results.map((r) => r.status), ['cancelled', 'cancelled']);
    assert.deepEqual(events, []);
  });
});

describe('board-file commands announce through the same rule', () => {
  function commands(opts: Parameters<typeof makeKit>[0]): string[][] {
    kit = makeKit({ tricky: true, ...opts });
    for (const d of registerBoardFileCommands(kit.services, { sync: kit.sync })) { mock.track(d); }
    return recordEvents(kit);
  }
  const file = (devicePath: string): BoardNode => ({ devicePath, kind: 'file', name: devicePath.split('/').pop() ?? '', size: 1 });
  const dir = (devicePath: string): BoardNode => ({ devicePath, kind: 'dir', name: devicePath.split('/').pop() ?? '' });
  const exec = (id: string, ...args: unknown[]): Thenable<unknown> => vscode.commands.executeCommand(id, ...args);

  it('New File and New Folder announce the new path', async () => {
    const events = commands({ board: { '/lib/other.py': 'o' } });
    mock.answerInputBox('sensor.py');
    await exec(COMMAND_IDS.newFileOnBoard, dir('/lib'));
    mock.answerInputBox('data');
    await exec(COMMAND_IDS.newFolderOnBoard, dir('/lib'));
    assert.deepEqual(events, [['/lib/sensor.py'], ['/lib/data']]);
  });

  it('a New File that failed (name already taken) announces nothing', async () => {
    const events = commands({ board: { '/lib/sensor.py': 'o' } });
    mock.answerInputBox('sensor.py');
    await exec(COMMAND_IDS.newFileOnBoard, dir('/lib'));
    assert.deepEqual(events, []);
  });

  it('Rename announces the old and the new path', async () => {
    const events = commands({ board: { '/lib/old.py': 'o' } });
    mock.answerInputBox('new.py');
    await exec(COMMAND_IDS.renameOnBoard, file('/lib/old.py'));
    assert.deepEqual(events, [['/lib/new.py', '/lib/old.py']]);
  });

  it('Delete announces the deleted path; a dismissed question announces nothing', async () => {
    const events = commands({ board: { '/lib/old.py': 'o' } });
    await exec(COMMAND_IDS.deleteOnBoard, file('/lib/old.py'));
    assert.deepEqual(events, [], 'the question was dismissed');
    mock.answerMessage(/Delete old\.py from the board/, 'Delete from board');
    await exec(COMMAND_IDS.deleteOnBoard, file('/lib/old.py'));
    assert.deepEqual(events, [['/lib/old.py']]);
  });
});

// ------------------------------------------------------------------ layer 2: changed paths -> folders the Files view re-lists

const BOARD = { '/main.py': 'm', '/lib/a.py': 'a', '/lib/sub/b.py': 'b', '/other/z.py': 'z' } as const;

interface TreeHarness {
  readonly session: FakeSession;
  readonly tree: FilesTree;
  readonly board: NonNullable<FakeSession['boardFs']>;
  /** Folders VS Code was asked to re-read since the last `clear()`: '<root>' or a device path. */
  readonly fired: string[];
  clear(): void;
}

/** A Files tree whose root, /lib and /lib/sub have been listed (cached); /other has not. */
async function listedTree(rootPath?: string, files: Record<string, string> = BOARD): Promise<TreeHarness> {
  mock.reset();
  mock.setWorkspaceFolders(os.tmpdir()); // D-24: the Files view needs a project folder
  ctx = createExtensionContext();
  if (rootPath) { mock.config.set(settingId('rootPath'), rootPath); }
  const session = FakeSession.connected();
  sessions.push(session);
  const board = session.useBoardFs(files);
  const { log } = createTestLogger();
  const tree = new FilesTree({ session, log, settings: new Settings(), extensionUri: ctx.extensionUri });
  trees.push(tree);
  const fired: string[] = [];
  tree.onDidChangeTreeData((e) => { fired.push(e === undefined ? '<root>' : (e as BoardNode).devicePath); });
  const top = (await tree.getChildren()) as FilesNode[];
  const lib = top.find((n) => n.kind === 'dir' && n.name === 'lib');
  if (lib) {
    const inLib = (await tree.getChildren(lib)) as FilesNode[];
    const sub = inLib.find((n) => n.kind === 'dir' && n.name === 'sub');
    if (sub) { await tree.getChildren(sub); }
  }
  session.calls.length = 0;
  return { session, tree, board, fired, clear: () => { fired.length = 0; session.calls.length = 0; } };
}

const names = (nodes: readonly FilesNode[]): string[] => nodes.map((n) => (n.kind === 'status' ? n.label : n.name));
const node = (devicePath: string): BoardNode => ({ devicePath, kind: 'dir', name: devicePath.split('/').pop() ?? '' });
const listedPaths = (h: TreeHarness): string[] => (h.session.argsOf('fs.list') as { path: string }[]).map((a) => a.path);

describe('FilesTree.boardChanged: which folders are re-listed', () => {
  const rows: readonly { name: string; root?: string; changed: string[]; fired: string[] }[] = [
    { name: 'a file in a listed folder: that folder only', changed: ['/lib/sub/new.py'], fired: ['/lib/sub'] },
    { name: 'two files in the same folder: that folder once', changed: ['/lib/sub/new.py', '/lib/sub/new2.py'], fired: ['/lib/sub'] },
    { name: 'files in two folders: each once', changed: ['/lib/new.py', '/lib/sub/new.py', '/lib/other.py'], fired: ['/lib', '/lib/sub'] },
    { name: 'a file in the root: the root only', changed: ['/new.py'], fired: ['<root>'] },
    { name: 'a file in a folder that was never listed: nothing (it is listed fresh when opened)', changed: ['/other/x.py'], fired: [] },
    { name: 'a file in a new folder below a listed one: the listed folder, which lacks the new folder', changed: ['/lib/newdir/x.py'], fired: ['/lib'] },
    { name: 'a file several new folders down: the nearest listed folder that lacks the way', changed: ['/lib/sub/p/q/x.py'], fired: ['/lib/sub'] },
    { name: 'a new top-level folder: the root', changed: ['/brand/new/x.py'], fired: ['<root>'] },
    { name: 'a removed file: its folder', changed: ['/lib/a.py'], fired: ['/lib'] },
    { name: 'a removed folder: its parent', changed: ['/lib/sub'], fired: ['/lib'] },
    { name: 'nothing changed: nothing', changed: [], fired: [] },
    { name: 'the root itself or a path outside the tree: nothing', root: '/lib', changed: ['/lib', '/main.py', '/other/z.py'], fired: [] },
    { name: 'with a project folder on the board: its top level is the root', root: '/lib', changed: ['/lib/new.py'], fired: ['<root>'] },
  ];
  for (const row of rows) {
    it(row.name, async () => {
      const h = await listedTree(row.root);
      h.clear();
      h.tree.boardChanged(row.changed);
      assert.deepEqual([...h.fired].sort(), [...row.fired].sort());
    });
  }

  it('re-lists a changed top-level folder alone: the open sub-folders keep their listing (no listing storm)', async () => {
    const h = await listedTree();
    h.board.write('/new.py', enc('n'));
    h.tree.boardChanged(['/new.py']);
    const top = (await h.tree.getChildren()) as FilesNode[];
    assert.deepEqual(names(top), ['lib', 'other', 'main.py', 'new.py']);
    assert.deepEqual(names((await h.tree.getChildren(top[0])) as FilesNode[]), ['sub', 'a.py']);
    assert.deepEqual(listedPaths(h), ['/'], 'only the root was listed again');
  });

  it('shows a new file in a folder whose listing was cached; without the announcement it would still be the old listing', async () => {
    const h = await listedTree();
    h.board.write('/lib/b.py', enc('b'));
    const lib = node('/lib');
    assert.deepEqual(names((await h.tree.getChildren(lib)) as FilesNode[]), ['sub', 'a.py'], 'the cache keeps its listing until told (this is the bug)');
    h.tree.boardChanged(['/lib/b.py']);
    assert.deepEqual(names((await h.tree.getChildren(lib)) as FilesNode[]), ['sub', 'a.py', 'b.py']);
    assert.deepEqual(listedPaths(h), ['/lib']);
  });

  it('shows a file uploaded into a folder that did not exist when its parent was listed', async () => {
    const h = await listedTree();
    h.board.write('/lib/fresh/x.py', enc('x'));
    h.tree.boardChanged(['/lib/fresh/x.py']);
    const inLib = (await h.tree.getChildren(node('/lib'))) as FilesNode[];
    assert.deepEqual(names(inLib), ['fresh', 'sub', 'a.py']);
    assert.deepEqual(names((await h.tree.getChildren(inLib[0])) as FilesNode[]), ['x.py']);
  });

  it('drops the listings below a removed folder, so a folder created again under that name is listed fresh', async () => {
    const h = await listedTree();
    h.board.write('/lib/sub/b.py', enc('B2'));
    h.tree.boardChanged(['/lib/sub']); // pretend /lib/sub was removed and created again
    h.clear();
    const sub = node('/lib/sub');
    assert.deepEqual(names((await h.tree.getChildren(sub)) as FilesNode[]), ['b.py']);
    assert.deepEqual(listedPaths(h), ['/lib/sub'], 'the old listing of /lib/sub was dropped');
  });

  it('a listing already on its way when the board changes is repeated instead of shown', async () => {
    const h = await listedTree();
    h.tree.refresh();
    h.clear();
    const gate = h.session.hold('fs.list');
    const pending = h.tree.getChildren();
    await gate.arrived;
    h.board.write('/late.py', enc('l'));
    h.tree.boardChanged(['/late.py']);
    gate.release();
    assert.ok(names((await pending) as FilesNode[]).includes('late.py'));
    assert.equal(h.session.callsOf('fs.list').length, 2, 'listed again after the change');
  });

  it('is synchronous and cheap: it asks the board for nothing itself', async () => {
    const h = await listedTree();
    h.board.write('/lib/b.py', enc('b'));
    h.tree.boardChanged(['/lib/b.py', '/lib/c.py', '/new.py']);
    assert.deepEqual(h.session.calls, [], 'no board call happens until VS Code asks for the children');
  });
});

// ------------------------------------------------------------------ layer 3: the whole chain, wired like the extension

/** registerViews with the sync service as the change source (what src/extension.ts does) over a kit with a connected FakeSession. */
function wiredViews(opts: Parameters<typeof makeKit>[0]): { files: MockTreeView<unknown>; kit: Kit } {
  // The kit's stub for the refresh command would collide with the real registration of registerViews.
  kit = makeKit({ selectPortStub: false, ...opts });
  const registered = registerViews(kit.services, { syncStatus: kit.sync, boardChanges: kit.sync });
  mock.track({ dispose: () => registered.forEach((d) => d.dispose()) });
  const files = mock.treeViews.get(VIEWS.files);
  assert.ok(files, 'the Files view exists');
  return { files, kit };
}

const rootLabels = async (files: MockTreeView<unknown>): Promise<string[]> =>
  (await files.snapshot(1)).map((n) => n.label);

describe('the whole chain: engine -> sync service -> Files view', () => {
  it('REGRESSION: Upload Current File shows the new file in a Files view that had already listed the root', async () => {
    const { files, kit: k } = wiredViews({ tricky: true, local: { 'error prog.py': 'raise ValueError()' }, board: { '/main.py': 'm' } });
    assert.deepEqual(await rootLabels(files), ['main.py'], 'the root is listed and cached');
    const base = files.refreshes;
    await k.sync.uploadFile(vscode.Uri.file(path.join(k.workspace, 'error prog.py')));
    assert.ok(files.refreshes > base, 'the Files view was told to re-read');
    assert.deepEqual(await rootLabels(files), ['error prog.py', 'main.py'], 'no Refresh button needed');
  });

  it('REGRESSION: the command Upload Current File does it too (what a student clicks)', async () => {
    const { files, kit: k } = wiredViews({ local: { 'lib/x.py': 'x' }, board: { '/lib/old.py': 'o' } });
    for (const d of registerSyncCommands(k.services, { sync: k.sync })) { mock.track(d); }
    const top = (await files.children()) as FilesNode[];
    assert.deepEqual(names((await files.children(top[0])) as FilesNode[]), ['old.py']);
    await mock.openEditor(vscode.Uri.file(path.join(k.workspace, 'lib', 'x.py')));
    await vscode.commands.executeCommand(COMMAND_IDS.uploadActiveFile);
    assert.deepEqual(names((await files.children(top[0])) as FilesNode[]), ['old.py', 'x.py']);
  });

  it('a skipped upload (the board already has the file) lists nothing; at most the row of that file is re-read (its mark became a check, D-21)', async () => {
    const { files, kit: k } = wiredViews({ local: { 'a.py': 'a' }, board: { '/a.py': 'a' } });
    await rootLabels(files);
    k.session.calls.length = 0;
    const base = files.refreshes;
    await k.sync.uploadFile(vscode.Uri.file(path.join(k.workspace, 'a.py')));
    assert.ok(files.refreshes - base <= 1, 'no flicker: one row at most');
    assert.equal(k.session.callsOf('fs.list').length, 0);
  });

  it('Upload All Files shows the uploaded files in the view, again without Refresh', async () => {
    const { files, kit: k } = wiredViews({ local: { 'a.py': 'a', 'lib/b.py': 'b' }, board: { '/old.py': 'o' } });
    for (const d of registerSyncCommands(k.services, { sync: k.sync })) { mock.track(d); }
    assert.deepEqual(await rootLabels(files), ['old.py']);
    mock.answerQuickPick((items) => (items as { sync?: { selected: boolean } }[]).filter((i) => i.sync?.selected));
    await vscode.commands.executeCommand(COMMAND_IDS.syncToBoard);
    assert.deepEqual(await rootLabels(files), ['lib', 'a.py', 'old.py']);
  });

  it('Clear Device Files leaves a view that says the board is empty', async () => {
    const { files, kit: k } = wiredViews({ board: { '/main.py': 'm', '/lib/x.py': 'x' } });
    assert.deepEqual(await rootLabels(files), ['lib', 'main.py']);
    mock.answerMessage(/Delete everything in \//, 'Delete 2 items');
    await k.sync.clearDevice();
    assert.deepEqual(await rootLabels(files), [FILES_TEXT.emptyRootLabel]);
  });

  it('a new file made with the Files-view command shows without Refresh', async () => {
    const { files, kit: k } = wiredViews({ board: { '/main.py': 'm' } });
    for (const d of registerBoardFileCommands(k.services, { sync: k.sync })) { mock.track(d); }
    assert.deepEqual(await rootLabels(files), ['main.py']);
    mock.answerInputBox('y.py');
    await vscode.commands.executeCommand(COMMAND_IDS.newFileOnBoard, node('/'));
    assert.deepEqual(await rootLabels(files), ['main.py', 'y.py']);
  });
});
