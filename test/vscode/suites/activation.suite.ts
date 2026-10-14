/** Activation (docs/extension-design.md s.5): lazy start, activation by view or command, every command registered, no bridge before use. */
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { viewContainerId } from '../../../src/identity';
import * as path from 'node:path';
import type { SuiteDef } from '../runner';
import { allCommandIds, api, assert, bridgeProcesses, COMMAND_IDS, env, IDENTITY, ourExtension, settingId, sleep, waitFor } from '../util';

const hasMarkers = (): boolean => fs.existsSync(`${env.workspace}/main.py`) || fs.existsSync(`${env.workspace}/.mpyignore`);

export const activation: SuiteDef = {
  name: 'activation',
  define(s) {
    s.test(hasMarkers() ? 'activates by itself (workspaceContains a project marker)' : 'stays asleep in a folder without project markers', async (t) => {
      const ext = ourExtension();
      if (hasMarkers()) {
        await waitFor(() => ext.isActive, 'activation by workspaceContains', 30_000, 100);
        t.note('active without any user action: workspaceContains fired');
      } else {
        await sleep(1500);
        assert.equal(ext.isActive, false, 'no marker file, no view opened, no command run: the extension has not been activated');
        t.note('inactive after 1.5 s in a folder without main.py / boot.py / .mpyignore');
      }
    });

    s.test(`activates when used for the first time (${env.activateVia})`, async (t) => {
      const ext = ourExtension();
      const wasActive = ext.isActive;
      if (env.activateVia === 'command') {
        await vscode.commands.executeCommand(COMMAND_IDS.showLog);
      } else {
        await vscode.commands.executeCommand(`workbench.view.extension.${viewContainerId()}`);
      }
      await waitFor(() => ext.isActive, `activation via ${env.activateVia}`, 30_000, 100);
      t.note(`via ${env.activateVia}; it was ${wasActive ? 'already' : 'not yet'} active before`);
      const exported = await ext.activate();
      assert.ok(exported?.test, 'activate() returned the test hook');
      assert.equal(vscode.extensions.getExtension('jpswensen.upython-bridge')?.isActive, true, 'jpswensen.upython-bridge is active');
    });

    s.test('every declared command id is registered, and no other one', async () => {
      await api();
      const registered = new Set(await vscode.commands.getCommands(true));
      const missing = allCommandIds().filter((id) => !registered.has(id));
      assert.deepEqual(missing, [], 'declared in the manifest but not registered');
      const declared = ((ourExtension().packageJSON as { contributes: { commands: { command: string }[] } }).contributes.commands).map((c) => c.command).sort();
      assert.deepEqual(declared, [...allCommandIds()].sort(), 'the manifest of the loaded extension declares exactly the table');
      const extra = [...registered].filter((id) => id.startsWith('upy-bridge.') && !allCommandIds().includes(id));
      assert.deepEqual(extra, [], 'registered but not declared');
      const ours = [...registered].filter((id) => id.startsWith('upy-bridge.'));
      assert.equal(ours.length, allCommandIds().length, 'every command id this extension registers starts with upy-bridge.');
      assert.deepEqual([...registered].filter((id) => /^(mpyBench|mpy-bench)[.]/i.test(id)), [], 'no command id with the old working-name prefix');
    });

    s.test('settings are read and written through the hyphenated section: getConfiguration("upy-bridge")', async (t) => {
      await api();
      const section = vscode.workspace.getConfiguration(IDENTITY.prefix);
      assert.equal(IDENTITY.prefix, 'upy-bridge');
      assert.equal(section.get('logLevel'), 'debug', 'the launcher wrote upy-bridge.logLevel into the workspace settings');
      assert.equal(section.get('autoSync'), 'off');
      assert.equal(section.inspect('rootPath')?.defaultValue, '/', 'a default declared in package.json is visible through the section');
      assert.equal(section.inspect('sync.debounceMs')?.defaultValue, 400, 'a nested key (sync.debounceMs) works inside the hyphenated section');
      assert.equal(vscode.workspace.getConfiguration().get(settingId('logLevel')), 'debug', 'and through the full id');
      await section.update('sync.debounceMs', 650, vscode.ConfigurationTarget.Workspace);
      try {
        assert.equal(vscode.workspace.getConfiguration(IDENTITY.prefix).get('sync.debounceMs'), 650, 'a write is read back');
        assert.equal(vscode.workspace.getConfiguration().get('upy-bridge.sync.debounceMs'), 650);
      } finally {
        await section.update('sync.debounceMs', undefined, vscode.ConfigurationTarget.Workspace);
      }
      assert.equal(vscode.workspace.getConfiguration(IDENTITY.prefix).get('sync.debounceMs'), 400, 'and removed again');
      t.note('read logLevel/autoSync, defaults of rootPath and sync.debounceMs, wrote and removed sync.debounceMs in the scratch workspace');
    });

    s.test('the output channel has the display name (its log file is named after it), the Greek mu included', async (t) => {
      await api();
      await vscode.commands.executeCommand(COMMAND_IDS.showLog);
      const logsRoot = path.join(env.userData, 'logs');
      const found = await waitFor(() => { const files = findChannelFiles(logsRoot, IDENTITY.outputChannelName); return files.length > 0 ? files : undefined; }, `an output channel log file named after "${IDENTITY.outputChannelName}"`, 15_000, 250);
      t.note(`channel files: ${found.map((f) => path.relative(logsRoot, f)).join(' | ')}`);
      assert.equal(path.basename(found[0] ?? '').replace(/^\d+-/, '').replace(/[.]log$/, '').codePointAt(0), 0x03bc);
    });

    s.test('the test hook exposes only introspection and the scripted answers of the IntelliSense questions', async () => {
      const exported = await ourExtension().activate();
      assert.deepEqual(Object.keys(exported ?? {}), ['test']);
      assert.deepEqual(Object.keys(exported?.test ?? {}).sort(),
        ['clearTerminal', 'contextKeys', 'filesChildren', 'intellisense', 'state', 'statusBarTexts', 'terminalInputs', 'terminalText', 'waitForState']);
    });

    s.test('activation spawned no bridge: nothing starts before the first use', async (t) => {
      const hook = await api();
      const st = hook.state();
      t.note(`session: bridge=${st.bridge} state=${st.state} interpreter=${st.interpreter} port=${String(st.port)}`);
      assert.equal(st.bridge, 'stopped');
      assert.equal(st.state, 'disconnected');
      assert.deepEqual(bridgeProcesses(), [], 'no mpy_bridge.py process of this window');
    });
  },
};

/** Output channels of extensions are files `<logs>/<run>/window1/exthost/output_logging_<ts>/<n>-<channel name>.log`. */
function findChannelFiles(dir: string, channelName: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 7) { return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // a folder that disappeared while VS Code rotates its logs
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); } else if (e.name.replace(/^\d+-/, '') === `${channelName}.log`) { out.push(full); }
    }
  };
  walk(dir, 0);
  return out;
}
