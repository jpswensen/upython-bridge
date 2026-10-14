/**
 * Decision D-21 in the Files view: project files that are not on the board yet appear as rows where they will go (context value
 * `localFile`, no board listing for a project-only folder), every file has a hover that names its mark, says what it means and
 * what to do next (with trusted command links), the badges use the instructor's up/down arrows, and a change of the marks
 * re-reads only the rows whose wording changed.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { COMMAND_IDS, TREE_CONTEXT, VIEWS } from '../../src/contributes';
import { SyncStatus } from '../../src/sync/status';
import { Settings } from '../../src/types/settings';
import type { BoardNode, SyncPlan } from '../../src/types/sync';
import { BADGES, decorationFor } from '../../src/views/decorations';
import { FilesTree, type FilesNode } from '../../src/views/filesView';
import { fileHover, legendText } from '../../src/views/syncHelp';
import { FakeSession } from '../mocks/fakeSession';
import type { MockExtensionContext } from '../mocks/extensionContext';
import { createExtensionContext, createTestLogger, mock } from '../mocks/vscode';

let ctx: MockExtensionContext;
let tree: FilesTree | undefined;
let status: SyncStatus | undefined;
beforeEach(() => {
  mock.reset();
  // D-24: the extension works only with a project folder open (views and connect)
  mock.setWorkspaceFolders(os.tmpdir());
  ctx = createExtensionContext();
});
afterEach(() => { tree?.dispose(); status?.dispose(); ctx.dispose(); mock.reset(); });

function plan(items: { path: string; reason: SyncPlan['items'][number]['reason']; size?: number }[]): SyncPlan {
  return {
    direction: 'toBoard', createdAt: '', workspaceRoot: '/ws', rootPath: '/', boardId: null, compare: 'sha256', warnings: [],
    items: items.map((i) => ({ path: i.path, remote: `/${i.path}`, local: `/ws/${i.path}`, kind: 'file', action: 'unchanged', reason: i.reason, size: i.size ?? 0, selected: true })),
  };
}

function setup(): { session: FakeSession; tree: FilesTree; status: SyncStatus } {
  const session = FakeSession.connected();
  session.useBoardFs({ '/main.py': 'print(1)\n', '/boot.py': 'b\n' });
  status = new SyncStatus();
  tree = new FilesTree({ session, log: createTestLogger().log, settings: new Settings(), extensionUri: ctx.extensionUri, syncStatus: status });
  vscode.window.createTreeView(VIEWS.files, { treeDataProvider: tree });
  return { session, tree, status };
}

const asBoard = (n: FilesNode | undefined): BoardNode => {
  assert.ok(n && n.kind !== 'status');
  return n;
};

describe('D-21 project-only rows', () => {
  it('a new project file shows next to the board files, sorted, with its own context value and a click that opens it', async () => {
    const { tree, status } = setup();
    status.fromPlan(plan([{ path: 'main.py', reason: 'identical' }, { path: 'boot.py', reason: 'board-only' }, { path: 'new.py', reason: 'new-local', size: 42 }]));
    const root = await tree.getChildren();
    assert.deepEqual(root.map((n) => asBoard(n).name), ['boot.py', 'main.py', 'new.py']);
    const fresh = asBoard(root[2]);
    assert.equal(fresh.localOnly, true);
    const item = tree.getTreeItem(fresh);
    assert.equal(item.contextValue, TREE_CONTEXT.localFile);
    assert.equal(item.description, 'only on your computer');
    assert.equal(item.command?.command, COMMAND_IDS.openFileFromBoard);
    assert.equal(tree.getTreeItem(asBoard(root[1])).contextValue, TREE_CONTEXT.file);
  });

  it('a project-only folder expands to its files without asking the board', async () => {
    const { session, tree, status } = setup();
    status.fromPlan(plan([{ path: 'lib/helper.py', reason: 'new-local', size: 3 }]));
    const root = await tree.getChildren();
    const lib = asBoard(root.find((n) => n.kind !== 'status' && n.name === 'lib'));
    assert.equal(lib.localOnly, true);
    const lists = session.callsOf('fs.list').length;
    const inside = await tree.getChildren(lib);
    assert.deepEqual(inside.map((n) => asBoard(n).name), ['helper.py']);
    assert.equal(session.callsOf('fs.list').length, lists, 'no board listing for a folder the board does not have');
  });

  it('when a project-only file appears the root is re-read; nothing is listed again', async () => {
    const { session, tree, status } = setup();
    status.fromPlan(plan([{ path: 'main.py', reason: 'identical' }]));
    await tree.getChildren();
    let fired = 0;
    tree.onDidChangeTreeData(() => { fired++; });
    const lists = session.callsOf('fs.list').length;
    status.set('/new.py', 'local-only', { rel: 'new.py', size: 1 });
    assert.ok(fired >= 1, 'the root rows were refreshed');
    const root = await tree.getChildren();
    assert.ok(root.some((n) => n.kind !== 'status' && n.name === 'new.py'));
    assert.equal(session.callsOf('fs.list').length, lists, 'answered from the cached listing');
  });
});

describe('D-21 hover help and badges', () => {
  it('the hover names the mark, explains it and links the next step with trusted commands', async () => {
    const { tree, status } = setup();
    status.fromPlan(plan([{ path: 'main.py', reason: 'board-changed' }]));
    const root = await tree.getChildren();
    const main = asBoard(root.find((n) => n.kind !== 'status' && n.name === 'main.py'));
    const tip = tree.getTreeItem(main).tooltip as vscode.MarkdownString;
    assert.ok(tip instanceof vscode.MarkdownString);
    assert.match(tip.value, /↓ The board has newer changes/);
    assert.match(tip.value, new RegExp(`command:${COMMAND_IDS.downloadThisFile.replace(/\./g, '\\.')}\\?`));
    assert.match(tip.value, new RegExp(`command:${COMMAND_IDS.compareWithBoard.replace(/\./g, '\\.')}\\?`));
    const trusted = tip.isTrusted as { enabledCommands: string[] };
    assert.ok(trusted.enabledCommands.includes(COMMAND_IDS.downloadThisFile));
    assert.ok(!trusted.enabledCommands.includes(COMMAND_IDS.clearDevice), 'only the commands the hover needs');
  });

  it('shows the board path verbatim in a code span (no backslash escapes inside it), even with backticks in the name', async () => {
    const { tree, status } = setup();
    status.fromPlan(plan([{ path: 'main.py', reason: 'board-changed' }]));
    const main = asBoard((await tree.getChildren()).find((n) => n.kind !== 'status' && n.name === 'main.py'));
    const tip = tree.getTreeItem(main).tooltip as vscode.MarkdownString;
    assert.match(tip.value, /`\/main\.py` on the board/);
    assert.doesNotMatch(tip.value, /`[^`]*\\[^`]*` on the board/, 'no backslash escape inside the code span');
    const odd = fileHover({ devicePath: '/a`b (1).py', name: 'a`b (1).py', kind: 'file', size: 3 }, undefined, '3 B');
    assert.match(odd.value, /``\/a`b \(1\)\.py`` on the board/);
  });

  it('a file with no comparison yet says how to get one', async () => {
    const { tree } = setup();
    const root = await tree.getChildren();
    const tip = tree.getTreeItem(asBoard(root[0])).tooltip as vscode.MarkdownString;
    assert.match(tip.value, /Not compared with your computer yet/);
  });

  it('badges use the instructor\'s arrows and stay at most two characters; attention marks propagate to folders', () => {
    assert.equal(BADGES['local-changed'].badge, '↑');
    assert.equal(BADGES['board-changed'].badge, '↓');
    assert.equal(BADGES['in-sync'].badge, '✓');
    assert.equal(BADGES['local-only'].badge, '↑+');
    assert.equal(BADGES['board-only'].badge, '↓+');
    assert.equal(new Set(Object.values(BADGES).map((b) => b.badge)).size, Object.keys(BADGES).length, 'every state has its own badge');
    for (const [k, v] of Object.entries(BADGES)) { assert.ok([...v.badge].length <= 2, k); }
    assert.equal(decorationFor('conflict').propagate, true);
    assert.equal(decorationFor('in-sync').propagate, false);
  });

  it('the legend lists every mark', () => {
    const text = legendText();
    for (const v of Object.values(BADGES)) { assert.ok(text.includes(v.badge), v.badge); }
  });

  it('a mark change re-reads only that file (its hover names the mark)', async () => {
    const { tree, status } = setup();
    status.fromPlan(plan([{ path: 'main.py', reason: 'identical' }, { path: 'boot.py', reason: 'identical' }]));
    const root = await tree.getChildren();
    for (const n of root) { tree.getTreeItem(n); }
    const fired: (FilesNode | undefined)[] = [];
    tree.onDidChangeTreeData((n) => fired.push(n));
    status.set('/main.py', 'local-changed');
    assert.deepEqual(fired.map((n) => (n && n.kind !== 'status' ? n.name : String(n))), ['main.py']);
  });
});
