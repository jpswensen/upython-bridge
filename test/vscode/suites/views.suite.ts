/** Views and status bar: container and three views reveal, the Files view follows the connection, the status bar follows the state. */
import * as vscode from 'vscode';
import { viewContainerId } from '../../../src/identity';
import { CONTEXT, VIEWS } from '../../../src/contributes';
import type { SuiteDef } from '../runner';
import { api, assert, COMMAND_IDS, connectRow, ensureConnected, env, ourExtension, sleep, waitFor } from '../util';

export const views: SuiteDef = {
  name: 'views',
  define(s) {
    s.test('the container and its three views reveal without error', async (t) => {
      await vscode.commands.executeCommand(`workbench.view.extension.${viewContainerId()}`);
      for (const id of [VIEWS.files, VIEWS.actions, VIEWS.sync]) {
        await vscode.commands.executeCommand(`${id}.focus`);
        t.note(`${id}.focus ok`);
      }
      await sleep(500);
    });

    s.test('before connecting: the Files view offers "Connect to <port>", the status bar says Not connected', async (t) => {
      const hook = await api();
      if (hook.state().state !== 'disconnected') {
        t.note(`skipped the content check: the board is already ${hook.state().state}`);
        return;
      }
      const rows = await hook.filesChildren();
      assert.equal(rows.length, 1, `one row: ${JSON.stringify(rows)}`);
      assert.equal(rows[0]?.label, `Connect to ${env.boardUrl}`);
      assert.equal(rows[0]?.command, COMMAND_IDS.selectPort);
      assert.deepEqual(rows[0]?.commandArguments, [{ reuse: true }]);
      const bar = hook.statusBarTexts();
      t.note(`status bar: "${bar.board}" | "${bar.autoSync}"`);
      assert.ok(bar.board.includes(env.boardUrl) && /Not connected/.test(bar.board), bar.board);
      assert.match(bar.autoSync, /Auto-sync: Off/, 'auto-sync is off in this workspace');
      // (c) The welcome texts and menus of the manifest use `upy-bridge.*` keys in `when` clauses. A host test cannot see whether a
      // welcome text is drawn (no API; VS Code 1.141 registers no command that reads a context key: only getContextKeyInfo and
      // setContext), so this reads what VS Code ACCEPTED through setContext, which is what those clauses are evaluated against.
      const keys = await waitFor(() => (hook.contextKeys()[CONTEXT.connected] === undefined ? undefined : hook.contextKeys()), 'the context keys to be acknowledged', 5000);
      t.note(`context keys accepted by VS Code before connecting: ${JSON.stringify(keys)}`);
      assert.equal(keys[CONTEXT.connected], false, `${CONTEXT.connected} is false while no board is connected`);
      assert.equal(keys[CONTEXT.interpreterProblem], false);
      assert.deepEqual(Object.keys(keys).filter((k) => !k.startsWith('upy-bridge.')), [], 'every key the extension sets has the hyphenated prefix');
    });

    s.test('connect with the row command: the Files view lists the board, the status bar says Ready', async (t) => {
      const hook = await api();
      const row = await connectRow(hook);
      if (row) {
        t.note(`row command ${String(row.command)} with ${JSON.stringify(row.commandArguments)}`);
      }
      await ensureConnected(hook);
      const root = await hook.filesChildren();
      const labels = root.map((r) => `${r.kind}:${r.label}`);
      t.note(`root: ${labels.join(' | ')}`);
      for (const want of ['dir:data', 'dir:lib', 'file:hello world (1).py', 'file:loop prog.py', 'file:boot.py']) {
        assert.ok(labels.includes(want), `${want} is listed; got ${labels.join(', ')}`);
      }
      assert.ok(labels.indexOf('dir:lib') < labels.indexOf('file:boot.py'), 'folders come first');
      const lib = await hook.filesChildren('/lib');
      assert.deepEqual(lib.map((r) => r.label), ['helper (v2).py']);
      const bar = hook.statusBarTexts();
      t.note(`status bar: "${bar.board}"; tooltip: ${JSON.stringify(bar.boardTooltip)}`);
      assert.ok(/Ready/.test(bar.board) && bar.board.includes(env.boardUrl), bar.board);
      assert.ok(bar.boardTooltip.includes(`Port: ${env.boardUrl}`), 'the tooltip names the port');
      const st = hook.state();
      assert.equal(st.bridge, 'ready');
      assert.ok(st.identity !== null, 'the identity probe ran');
      const keys = await waitFor(() => (hook.contextKeys()[CONTEXT.connected] === true ? hook.contextKeys() : undefined), `${CONTEXT.connected} to become true`, 5000);
      t.note(`context keys accepted by VS Code after connecting: ${JSON.stringify(keys)}`);
      assert.equal(keys[CONTEXT.hasPort], true, 'the hyphenated key of the Files welcome text (hasPort) is true with a port selected');
      assert.equal(keys[CONTEXT.running], false);
    });

    s.test('the manifest\'s when clauses name only context keys the extension sets, and VS Code takes a hyphenated key in setContext', async (t) => {
      const hook = await api();
      const contributes = (ourExtension().packageJSON as { contributes: { viewsWelcome: { when: string }[]; menus: Record<string, { when: string }[]> } }).contributes;
      const whens = [...contributes.viewsWelcome.map((w) => w.when), ...Object.values(contributes.menus).flat().map((m) => m.when)];
      const used = new Set(whens.flatMap((w) => [...w.matchAll(/upy-bridge[.][A-Za-z]+/g)].map((m) => m[0])));
      t.note(`context keys used in when clauses of the loaded manifest: ${[...used].join(', ')}`);
      assert.ok(used.size >= 2, 'the manifest uses hyphenated keys in when clauses');
      const known = new Set<string>(Object.values(CONTEXT));
      for (const k of used) { assert.ok(known.has(k), `${k} is a declared context key`); }
      // Keys the extension has set are visible through the hook; the others are set at the latest on first use (hardResetAvailable).
      for (const k of used) { if (k !== CONTEXT.hardResetAvailable) { assert.ok(k in hook.contextKeys(), `${k} was set`); } }
      await vscode.commands.executeCommand('setContext', 'upy-bridge.hostProbe', true);
      await vscode.commands.executeCommand('setContext', 'upy-bridge.hostProbe', false);
    });
  },
};
