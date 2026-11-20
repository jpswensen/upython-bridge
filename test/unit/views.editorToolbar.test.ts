/** The editor-toolbar guard (src/views/editorToolbar.ts, D-27): hidden only while one of our sidebar views is open. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { VIEWS } from '../../src/contributes';
import { settingId } from '../../src/identity';
import { EditorToolbarGuard, RESTORE_STATE_KEY } from '../../src/views/editorToolbar';
import { Settings } from '../../src/types/settings';
import { createExtensionContext, createTestLogger, mock, type MockOutputChannel } from '../mocks/vscode';
import type { MockExtensionContext } from '../mocks/extensionContext';
import { ConfigurationTarget } from '../mocks/vscodeCore';
import { makeTempDir, removeDir } from '../mocks/fixtures';

const KEY = 'workbench.editor.editorActionsLocation';
const provider = { getChildren: () => [], getTreeItem: (x: unknown) => x as vscode.TreeItem };

let ctx: MockExtensionContext;
let channel: MockOutputChannel;
let settings: Settings;
let guard: EditorToolbarGuard | undefined;
let folder: string;
const views: ReturnType<typeof mock.treeViews.get>[] = [];

function makeGuard(): EditorToolbarGuard {
  const { log, channel: ch } = createTestLogger('debug');
  channel = ch;
  guard = new EditorToolbarGuard({ views: views as never, settings, state: ctx.workspaceState as unknown as vscode.Memento, log });
  return guard;
}
const workspaceValue = (): unknown => mock.config.workspace.get(KEY);
const showView = (open: boolean): void => { for (const v of views) { v?.setVisible(open); } };

beforeEach(() => {
  mock.reset();
  ctx = createExtensionContext();
  folder = makeTempDir('upy-toolbar');
  mock.setWorkspaceFolders(folder);
  mock.config.register(KEY, 'default');
  views.length = 0;
  for (const id of [VIEWS.files, VIEWS.actions, VIEWS.sync]) {
    vscode.window.createTreeView(id, { treeDataProvider: provider });
    views.push(mock.treeViews.get(id));
  }
  settings = new Settings(undefined, ctx.workspaceState as unknown as vscode.Memento);
});
afterEach(() => {
  guard?.dispose();
  guard = undefined;
  settings.dispose();
  ctx.dispose();
  removeDir(folder);
  mock.reset();
});

describe('the editor toolbar is hidden only while our sidebar is open', () => {
  it('hides when a view is showing and puts the toolbar back when none is (the "Run Python File" button problem)', async () => {
    showView(true);
    await makeGuard().settled();
    assert.equal(workspaceValue(), 'hidden');
    assert.equal(mock.config.updates.at(-1)?.target, ConfigurationTarget.Workspace, 'workspace settings only, never the user settings');
    showView(false);
    await guard!.settled();
    assert.equal(workspaceValue(), undefined, 'the key is removed again');
    assert.equal(ctx.workspaceState.get(RESTORE_STATE_KEY), undefined);
  });

  it('stays hidden while any one of the three views is visible and follows the views in between', async () => {
    showView(false);
    await makeGuard().settled();
    assert.equal(workspaceValue(), undefined, 'nothing written while no view of ours is open');
    views[1]?.setVisible(true);
    await guard!.settled();
    assert.equal(workspaceValue(), 'hidden');
    views[0]?.setVisible(true);
    views[1]?.setVisible(false);
    await guard!.settled();
    assert.equal(workspaceValue(), 'hidden', 'the Files view is still showing');
    views[0]?.setVisible(false);
    await guard!.settled();
    assert.equal(workspaceValue(), undefined);
  });

  it('puts back what the workspace had before, not just "default"', async () => {
    mock.config.set(KEY, 'titleBar', ConfigurationTarget.Workspace);
    showView(true);
    await makeGuard().settled();
    assert.equal(workspaceValue(), 'hidden');
    showView(false);
    await guard!.settled();
    assert.equal(workspaceValue(), 'titleBar');
  });

  it('does nothing when the setting hideEditorButtons is off, and restores when it is switched off while hidden', async () => {
    mock.config.set(settingId('hideEditorButtons'), false);
    showView(true);
    await makeGuard().settled();
    assert.equal(workspaceValue(), undefined);
    mock.config.set(settingId('hideEditorButtons'), true);
    await guard!.settled();
    assert.equal(workspaceValue(), 'hidden');
    mock.config.set(settingId('hideEditorButtons'), false);
    await guard!.settled();
    assert.equal(workspaceValue(), undefined);
  });

  it('never touches a toolbar the user already hides, and never undoes it', async () => {
    mock.config.set(KEY, 'hidden', ConfigurationTarget.Global);
    showView(true);
    await makeGuard().settled();
    showView(false);
    await guard!.settled();
    assert.deepEqual(mock.config.updates.filter((u) => u.key === KEY), []);
    assert.equal(mock.config.global.get(KEY), 'hidden');
  });

  it('leaves a value the user changed while it was hidden alone', async () => {
    showView(true);
    await makeGuard().settled();
    mock.config.set(KEY, 'titleBar', ConfigurationTarget.Workspace); // the user picked their own
    showView(false);
    await guard!.settled();
    assert.equal(workspaceValue(), 'titleBar');
    assert.equal(ctx.workspaceState.get(RESTORE_STATE_KEY), undefined, 'the note is dropped');
  });

  it('finds the note a crash left behind: restores it when no view is showing, keeps the state when one is', async () => {
    await ctx.workspaceState.update(RESTORE_STATE_KEY, { had: false });
    mock.config.set(KEY, 'hidden', ConfigurationTarget.Workspace);
    showView(false);
    await makeGuard().settled();
    assert.equal(workspaceValue(), undefined);
    guard!.dispose();
    await guard!.settled(); // its own shutdown restore must be over before the next scenario starts

    await ctx.workspaceState.update(RESTORE_STATE_KEY, { had: false });
    mock.config.set(KEY, 'hidden', ConfigurationTarget.Workspace);
    showView(true);
    await makeGuard().settled();
    assert.equal(workspaceValue(), 'hidden', 'the sidebar is open, so it stays hidden');
    assert.ok(ctx.workspaceState.get(RESTORE_STATE_KEY));
  });

  it('puts the toolbar back when the extension shuts down', async () => {
    showView(true);
    await makeGuard().settled();
    assert.equal(workspaceValue(), 'hidden');
    const g = guard!;
    g.dispose();
    await g.settled();
    assert.equal(workspaceValue(), undefined);
    guard = undefined;
  });

  it('writes nothing without an open folder (no workspace settings to write to)', async () => {
    mock.setWorkspaceFolders();
    showView(true);
    await makeGuard().settled();
    assert.deepEqual(mock.config.updates.filter((u) => u.key === KEY), []);
  });

  it('logs a warning and keeps no note when the setting cannot be written', async () => {
    mock.config.defaults.delete(KEY); // VS Code build without this setting: update() rejects like VS Code does
    showView(true);
    await makeGuard().settled();
    assert.equal(ctx.workspaceState.get(RESTORE_STATE_KEY), undefined);
    assert.match(channel.lines.join('\n'), /editor buttons could not be updated/);
  });
});
