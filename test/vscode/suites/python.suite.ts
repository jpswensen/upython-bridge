/** S-05: with the Python and Python Environments extensions installed and active, nothing is typed into OUR terminal tab. */
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { SuiteDef } from '../runner';
import { api, assert, COMMAND_IDS, ensureConnected, env, openFile, ourExtension, ourTerminal, sleep, waitFor } from '../util';

const PYTHON = 'ms-python.python';
const ENVS = 'ms-python.vscode-python-envs';
const PYLANCE = 'ms-python.vscode-pylance';
const ACTIVATION_LIKE = /activate|conda|source |\.venv|Scripts|virtualenv/i;

export const python: SuiteDef = {
  name: 'python',
  define(s) {
    // What really ran in which terminal (shell integration reports commands that other extensions type into SHELL terminals).
    const opened: string[] = [];
    const executions: string[] = [];
    s.test('start recording terminals and the commands run in them', () => {
      vscode.window.onDidOpenTerminal((x) => { opened.push(`${x.name} @${Date.now() % 100000}`); });
      // Stable since VS Code 1.93, but @types/vscode here is 1.90.
      const onExec = (vscode.window as unknown as { onDidStartTerminalShellExecution?: (l: (e: { terminal: vscode.Terminal; execution: { commandLine: { value: string } } }) => void) => unknown }).onDidStartTerminalShellExecution;
      onExec?.call(vscode.window, (e) => { executions.push(`${e.terminal.name}: ${e.execution.commandLine.value} @${Date.now() % 100000}`); });
      for (const x of vscode.window.terminals) { opened.push(`${x.name} (already open)`); }
    });

    s.test('our extension activates by itself (workspaceContains)', async () => {
      await waitFor(() => ourExtension().isActive, 'activation', 30_000, 100);
    });

    s.test('the Python, Python Environments and Pylance extensions are installed in this profile', (t) => {
      for (const id of [PYTHON, ENVS, PYLANCE]) {
        const ext = vscode.extensions.getExtension(id);
        assert.ok(ext, `${id} is installed`);
        t.note(`${id} ${String((ext.packageJSON as { version?: string }).version)} active=${ext.isActive}`);
      }
      assert.ok(fs.existsSync(`${env.workspace}/.venv/pyvenv.cfg`), 'the workspace has a .venv');
    });

    s.test('opening a .py file activates the Python extensions, as it does for a student', async (t) => {
      await openFile('hello world (1).py');
      await waitFor(() => vscode.extensions.getExtension(PYTHON)?.isActive, 'the Python extension to activate', 90_000, 250);
      await waitFor(() => vscode.extensions.getExtension(ENVS)?.isActive, 'the Python Environments extension to activate', 90_000, 250);
      t.note(`python active=${vscode.extensions.getExtension(PYTHON)?.isActive}, envs active=${vscode.extensions.getExtension(ENVS)?.isActive}, pylance active=${vscode.extensions.getExtension(PYLANCE)?.isActive}`);
    }, 120_000);

    s.test('record the environment the Python Environments extension selected for the workspace (evidence)', async (t) => {
      const envsApi = (await vscode.extensions.getExtension(ENVS)?.activate()) as { getEnvironment?: (s: vscode.Uri) => Promise<unknown> } | undefined;
      if (typeof envsApi?.getEnvironment !== 'function') {
        t.note('the Python Environments API has no getEnvironment');
        return;
      }
      const picked = await Promise.race([envsApi.getEnvironment(vscode.Uri.file(env.workspace)), sleep(15_000).then(() => 'timed out after 15 s')]);
      t.note(`selected environment: ${String(JSON.stringify(picked, (k, v) => (k === 'iconPath' ? undefined : v))).slice(0, 600)}`);
    }, 30_000);

    s.test('Open REPL with those extensions active: no activation command or text reaches our tab', async (t) => {
      const hook = await api();
      await ensureConnected(hook);
      hook.clearTerminal();
      const before = new Set(vscode.window.terminals.map((x) => x.name));
      await vscode.commands.executeCommand(COMMAND_IDS.openRepl);
      const terminal = await waitFor(() => ourTerminal(), 'the board terminal tab', 10_000);
      // A control: an ordinary shell tab, which the same extensions DO activate. Evidence only (the launcher reads their logs).
      const control = vscode.window.createTerminal({ name: 'control shell (S-05)' });
      await sleep(10_000);
      const inputs = hook.terminalInputs();
      const text = hook.terminalText();
      t.note(`terminals before: ${[...before].join(', ') || '(none)'}; now: ${vscode.window.terminals.map((x) => x.name).join(', ')}`);
      t.note(`terminals opened (in order): ${opened.join(' | ')}`);
      t.note(`commands run in shell terminals (shell integration): ${executions.length === 0 ? '(none reported)' : executions.join(' | ')}`);
      t.note(`everything our tab received as input in 10 s: ${JSON.stringify(inputs)}`);
      t.note(`our tab's text: ${JSON.stringify(text.slice(0, 400))}`);
      control.dispose();
      assert.equal(terminal.exitStatus, undefined, 'our tab is still open');
      assert.deepEqual(inputs.filter((x) => ACTIVATION_LIKE.test(x)), [], 'no activation-looking text was sent to our tab');
      assert.deepEqual(inputs, [], 'our tab received no input at all from other extensions');
      assert.ok(!ACTIVATION_LIKE.test(text), 'no activation text shows in our tab');
    }, 90_000);

    s.test('the REPL still works after those extensions had their chance', async () => {
      const hook = await api();
      const terminal = await waitFor(() => ourTerminal(), 'the board terminal tab', 5000);
      hook.clearTerminal();
      terminal.sendText('\r', false);
      await waitFor(() => hook.terminalText().includes('>>> '), 'the prompt', 15_000);
      terminal.sendText('2*21\r', false);
      await waitFor(() => /2\*21\n42\n/.test(hook.terminalText()), 'the answer 42', 15_000);
    });
  },
};
