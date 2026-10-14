/**
 * review10 part 3 (finding F4): does the Files view tell VS Code to re-ask for the tooltip after a copy? VS Code calls
 * resolveTreeItem only for properties that are undefined (vscode.d.ts: "Only properties that were undefined can be resolved"), and
 * getTreeItem sets the tooltip of a file, so the only way the wording can change is another getTreeItem call, which needs
 * onDidChangeTreeData. The tree fires it for the files whose wording changed (and for no other).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { BoardCopy } from '../../../src/commands/boardCopy';
import { Settings } from '../../../src/types/settings';
import type { BoardNode } from '../../../src/types/sync';
import { FilesTree } from '../../../src/views/filesView';
import { createTestLogger, mock } from '../../mocks/vscode';
import { makeKit, type Kit } from '../sync/kit';

let kit: Kit;
beforeEach(() => mock.reset());
afterEach(() => kit?.dispose());


/** A tree item tooltip as text (the D-21 hover is a MarkdownString). */
function tipText(tip: string | vscode.MarkdownString | undefined): string {
  return typeof tip === 'string' ? tip : tip?.value ?? '';
}

describe('review10c: the tooltip of a file after "Copy it to my project"', () => {
  it('a copy that turns "Only on the board" into "in the project" fires a tree change for that file, so the tooltip is asked for again', async (t) => {
    kit = makeKit({ tricky: true, board: { '/a.py': 'print(1)\n' } });
    const { log } = createTestLogger();
    const tree = new FilesTree({ session: kit.session, log, settings: new Settings(), extensionUri: vscode.Uri.file('/ext'), syncStatus: kit.sync });
    mock.track(tree);
    let fired = 0;
    tree.onDidChangeTreeData(() => { fired++; });
    const node: BoardNode = { devicePath: '/a.py', kind: 'file', name: 'a.py', size: 9 };
    kit.sync.status.set('/a.py', 'board-only'); // as after a comparison
    fired = 0;
    const item = tree.getTreeItem(node) as vscode.TreeItem;
    assert.match(tipText(item.tooltip), /Only on the board/);
    assert.notEqual(item.tooltip, undefined, 'VS Code resolves only tooltips that are undefined');
    const copied = await new BoardCopy(kit.services, kit.sync).copy('/a.py');
    assert.ok(copied !== undefined);
    assert.equal(kit.sync.badgeFor('/a.py'), 'in-sync');
    t.diagnostic(`tree change events fired by the copy: ${fired}; tooltip VS Code keeps: ${tipText(item.tooltip).split('\n')[2]}`);
    assert.ok(fired > 0, 'nothing told VS Code to ask for the tooltip again, so it still says "Only on the board" for a file that is now in the project');
    const again = tree.getTreeItem(node) as vscode.TreeItem;
    assert.match(tipText(again.tooltip), /opens? your copy in the project/i);
    assert.doesNotMatch(tipText(again.tooltip), /Only on the board/);
  });

  it('D-21: a mark change re-reads only the files that are shown (their hover names the mark), one event each; never-shown files fire nothing; a refresh forgets what was shown', () => {
    kit = makeKit({ tricky: true, board: { '/a.py': 'x', '/b.py': 'y' } });
    const { log } = createTestLogger();
    const tree = new FilesTree({ session: kit.session, log, settings: new Settings(), extensionUri: vscode.Uri.file('/ext'), syncStatus: kit.sync });
    mock.track(tree);
    const fired: unknown[] = [];
    tree.onDidChangeTreeData((e) => { fired.push(e); });
    const a: BoardNode = { devicePath: '/a.py', kind: 'file', name: 'a.py', size: 1 };
    kit.sync.status.set('/a.py', 'in-sync');
    tree.getTreeItem(a);
    fired.length = 0;
    kit.sync.status.set('/a.py', 'conflict'); // the hover of a shown file names its mark: re-read that one file
    kit.sync.status.set('/b.py', 'board-only'); // never shown: nothing
    assert.deepEqual(fired, [a]);
    kit.sync.status.set('/a.py', 'conflict'); // the same mark again: nothing
    assert.deepEqual(fired, [a]);
    tree.refresh(); // forgets what was shown
    fired.length = 0;
    kit.sync.status.set('/a.py', 'in-sync');
    assert.deepEqual(fired, [], 'nothing is shown after a refresh until VS Code asks again');
  });
});
