/** The student flow against the fake board, through real VS Code commands, editors and terminals. */
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { BOARD_SCHEME } from '../../../src/boardScheme';
import { CONTEXT } from '../../../src/contributes';
import { IDENTITY, settingId } from '../../../src/identity';
import type { SuiteDef } from '../runner';
import { api, assert, COMMAND_IDS, ensureConnected, env, openFile, ourExtension, ourTerminal, sleep, waitFor, waitForText } from '../util';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const flow: SuiteDef = {
  name: 'flow',
  define(s) {
    s.test('the documented port setting is set by a configuration update', async () => {
      await vscode.workspace.getConfiguration().update(settingId('port'), env.boardUrl, vscode.ConfigurationTarget.Workspace);
      assert.equal(vscode.workspace.getConfiguration().get(settingId('port')), env.boardUrl);
    });

    s.test('connect (the Files row command) and reach Ready', async () => {
      const hook = await api();
      await ensureConnected(hook);
      assert.equal(hook.state().state, 'idle');
    });

    s.test('Run on a hello program: output, non-ASCII text and the finished footer reach the Run tab', async (t) => {
      const hook = await api();
      await openFile('hello world (1).py');
      hook.clearTerminal();
      await vscode.commands.executeCommand(COMMAND_IDS.runActiveFile);
      await waitForText(hook, 'hello from the board');
      await waitForText(hook, 'café ✓', 5000);
      await waitForText(hook, '[program finished]', 20_000);
      assert.ok(ourTerminal(), 'the board terminal tab exists');
      assert.deepEqual(hook.terminalInputs().filter((x) => /activate|source |conda/i.test(x)), [], 'no activation text reached the tab');
      t.note(`terminal text: ${JSON.stringify(hook.terminalText().slice(0, 300))}`);
      await hook.waitForState(['idle'], 10_000);
      assert.match(hook.statusBarTexts().board, /Ready/);
    });

    s.test('the Run tab is named with the Greek mu and has a light and a dark icon: fixed-colour SVG files inside the extension folder', (t) => {
      const tab = ourTerminal();
      assert.ok(tab, 'the board terminal tab exists');
      assert.equal(tab.name.codePointAt(0), 0x03bc, 'the tab name starts with U+03BC');
      assert.equal(tab.name, IDENTITY.terminalName);
      assert.equal(tab.name, '\u03bcPython Bridge');
      const icon = (tab.creationOptions as vscode.ExtensionTerminalOptions).iconPath as { light?: vscode.Uri; dark?: vscode.Uri } | undefined;
      assert.ok(icon?.light instanceof vscode.Uri && icon.dark instanceof vscode.Uri, `iconPath is { light: Uri, dark: Uri }, got ${JSON.stringify(icon)}`);
      const root = ourExtension().extensionPath;
      for (const [kind, uri] of [['light', icon.light], ['dark', icon.dark]] as const) {
        assert.ok(uri.fsPath.startsWith(root), `${kind} icon is inside the extension folder`);
        assert.ok(fs.existsSync(uri.fsPath), `${uri.fsPath} exists`);
        assert.equal(path.basename(uri.fsPath), `terminal-tab-${kind}.svg`);
        assert.doesNotMatch(fs.readFileSync(uri.fsPath, 'utf8'), /currentColor/);
      }
      t.note(`tab "${tab.name}"; light ${path.relative(root, icon.light.fsPath)}; dark ${path.relative(root, icon.dark.fsPath)}`);
    });

    s.test('Run on a program with an error: the traceback names the local file and line (clickable form)', async (t) => {
      const hook = await api();
      const editor = await openFile('error prog.py');
      hook.clearTerminal();
      await vscode.commands.executeCommand(COMMAND_IDS.runActiveFile);
      const text = await waitForText(hook, '[program finished with an error]', 20_000);
      const want = new RegExp(`File "${escapeRe(editor.document.uri.fsPath)}", line 3`);
      t.note(`terminal text: ${JSON.stringify(text.slice(0, 500))}`);
      assert.match(text, want, 'File "<abs path>", line 3');
      assert.match(text, /ValueError: boom/);
      assert.match(text, /before the error/);
    });

    s.test('Upload Current File to Board puts the file on the board without a prompt', async () => {
      const hook = await api();
      const editor = await openFile('error prog.py');
      // Precondition of the old bug: the Files view already holds a listing of the root (cached) that does not have the file yet.
      // Without this the result depended on whether VS Code had asked for the listing in the last second.
      const cached = await hook.filesChildren();
      // D-21: the view also shows project files that are not on the board yet (rows marked localOnly); the BOARD rows must not have it
      const boardRow = (r: { label: string; localOnly: boolean }): boolean => r.label === 'error prog.py' && !r.localOnly;
      assert.ok(cached.length > 0 && !cached.some(boardRow), `the cached root listing has no board row "error prog.py" yet: ${JSON.stringify(cached.map((r) => [r.label, r.localOnly]))}`);
      await vscode.commands.executeCommand(COMMAND_IDS.uploadActiveFile);
      const onBoard = `${env.boardRoot}/error prog.py`;
      await waitFor(() => fs.existsSync(onBoard), 'the uploaded file on the board', 15_000);
      assert.equal(fs.readFileSync(onBoard, 'utf8'), editor.document.getText());
      await hook.waitForState(['idle'], 10_000);
      await waitFor(async () => (await hook.filesChildren()).some(boardRow), 'the Files view to show the uploaded file as a board file by itself', 5000, 250);
    });

    let stopSettled = false;
    s.test('Stop ends a looping program in under a second', async (t) => {
      const hook = await api();
      await openFile('loop prog.py');
      hook.clearTerminal();
      const running = Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile));
      await waitForText(hook, 'tick', 20_000);
      await waitFor(() => /Running/.test(hook.statusBarTexts().board), 'the status bar to say Running', 5000);
      t.note(`status while running: ${hook.statusBarTexts().board}`);
      // The hyphenated key `upy-bridge.running` follows the program: true while it runs, false after Stop (VS Code acknowledged both).
      await waitFor(() => hook.contextKeys()[CONTEXT.running] === true, `${CONTEXT.running} to be true while the program runs`, 5000);
      stopSettled = false;
      const t0 = Date.now();
      void Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.stop)).then(() => { stopSettled = true; });
      await waitForText(hook, '[program stopped]', 5000);
      const ms = Date.now() - t0;
      t.note(`Stop to "[program stopped]": ${ms} ms`);
      assert.ok(ms < 1000, `stopped in ${ms} ms`);
      await Promise.race([running, sleep(10_000).then(() => { throw new Error('the Run command did not finish within 10 s after the program stopped'); })]);
      await hook.waitForState(['idle'], 5000);
      await waitFor(() => /Ready/.test(hook.statusBarTexts().board), 'Ready after Stop', 5000);
      await waitFor(() => hook.contextKeys()[CONTEXT.running] === false, `${CONTEXT.running} to be false after Stop`, 5000);
      assert.equal(hook.contextKeys()[CONTEXT.connected], true, 'still connected after Stop');
    });

    s.test('the Stop command itself finishes (it does not wait for the "Program stopped." toast to be dismissed)', async (t) => {
      await waitFor(() => stopSettled, 'the Stop command to settle', 6000).catch(() => undefined);
      t.note(`Stop command settled within about 6 s: ${stopSettled}`);
      assert.equal(stopSettled, true, 'executeCommand(Stop) is still pending although the program stopped long ago');
    }, 15_000);

    s.test('Open REPL, then keys sent to the tab (sendText reaches handleInput) are evaluated by the board', async (t) => {
      const hook = await api();
      hook.clearTerminal();
      await vscode.commands.executeCommand(COMMAND_IDS.openRepl);
      const terminal = await waitFor(() => ourTerminal(), 'the board terminal tab', 10_000);
      await sleep(500);
      terminal.sendText('\r', false);
      await waitForText(hook, '>>> ', 15_000);
      terminal.sendText('1+2\r', false);
      const text = await waitForText(hook, /1\+2\n3\n/, 15_000);
      t.note(`inputs seen by the tab: ${JSON.stringify(hook.terminalInputs())}`);
      t.note(`terminal text: ${JSON.stringify(text.slice(-200))}`);
      assert.ok(hook.terminalInputs().includes('1+2\r'), 'the tab received 1+2 CR through handleInput');
    });

    // D-17. The board is a fake one inside the launcher, so its event log (interrupt, program_end, no reset) cannot be read from
    // here; the launcher writes it to fakeboard-events.json after the run. In the host the test proves what a student can see:
    // the program ends, the session never leaves the connected states (a reset or reconnect would pass through connecting or
    // disconnected), the port stays, and the next Run works.
    s.test('closing the Run tab stops a program that Run started: it ends, nothing resets, the connection stays, the next Run works', async (t) => {
      const hook = await api();
      await openFile('loop prog.py');
      hook.clearTerminal();
      const running = Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile));
      await waitForText(hook, 'tick', 20_000);
      await waitFor(() => /Running/.test(hook.statusBarTexts().board), 'the status bar to say Running', 5000);
      const portBefore = hook.state().port;
      const tab = ourTerminal();
      assert.ok(tab, 'the Run tab is open');
      const seen = new Set<string>();
      const watcher = setInterval(() => seen.add(hook.state().state), 10);
      const t0 = Date.now();
      try {
        tab.dispose(); // what the student does with the x of the tab
        await waitFor(() => hook.state().state === 'idle', 'the board to be idle after the tab was closed', 10_000, 10);
        t.note(`tab closed to idle: ${Date.now() - t0} ms`);
        await Promise.race([running, sleep(10_000).then(() => { throw new Error('the Run command did not finish after the tab was closed'); })]);
        await sleep(300);
      } finally {
        clearInterval(watcher);
      }
      t.note(`session states seen while closing: ${[...seen].join(', ')}`);
      assert.ok(!seen.has('disconnected') && !seen.has('connecting'), `the connection never dropped (saw ${[...seen].join(', ')})`);
      assert.equal(hook.state().port, portBefore, 'same port, still connected');
      assert.equal(hook.state().state, 'idle');
      assert.equal(ourTerminal(), undefined, 'the tab is gone');
      // The next Run: a new tab, the output of a finished program.
      await openFile('hello world (1).py');
      hook.clearTerminal();
      await vscode.commands.executeCommand(COMMAND_IDS.runActiveFile);
      await waitForText(hook, 'hello from the board', 20_000);
      await waitForText(hook, '[program finished]', 20_000);
      await hook.waitForState(['idle'], 10_000);
    }, 90_000);

    s.test('closing the Run tab leaves a program that Run did not start running (a loop typed into the REPL)', async (t) => {
      const hook = await api();
      hook.clearTerminal();
      await vscode.commands.executeCommand(COMMAND_IDS.openRepl);
      const tab = await waitFor(() => ourTerminal(), 'the board terminal tab', 10_000);
      await sleep(500);
      tab.sendText('\r', false);
      await waitForText(hook, '>>> ', 15_000);
      // The student types a loop at the prompt. Run is not involved, so the extension does not own this program.
      tab.sendText(String.raw`exec("import time\nwhile True:\n print('rtick')\n time.sleep(0.1)")` + '\r', false);
      await waitForText(hook, 'rtick', 15_000);
      t.note(`session state while the typed loop runs: ${hook.state().state}`);
      tab.dispose();
      await sleep(2000); // a Stop would have shown up by now (the unit tests cover the exact calls)
      assert.equal(ourTerminal(), undefined, 'the tab is gone');
      assert.notEqual(hook.state().state, 'disconnected');
      // Open the tab again: the loop is still printing.
      hook.clearTerminal();
      await vscode.commands.executeCommand(COMMAND_IDS.openRepl);
      await waitForText(hook, 'rtick', 15_000);
      // Clean up the way a student does: Stop.
      await vscode.commands.executeCommand(COMMAND_IDS.stop);
      await hook.waitForState(['idle'], 10_000);
      await sleep(300);
      hook.clearTerminal();
      await sleep(1000);
      t.note(`terminal text one second after Stop: ${JSON.stringify(hook.terminalText().slice(-120))}`);
      assert.ok(!hook.terminalText().includes('rtick'), 'the typed loop printed nothing more after Stop');
    }, 90_000);

    // The journey that was never tested (found on the instructor's machine): the file in the Files view IS my file. A click opens the
    // project's file, Run runs it. A file that is only on the board opens read-only and Run offers a copy instead of failing.
    s.test('click a synced file in the Files view: the PROJECT file opens (scheme file), then Run runs it and the session returns to idle', async (t) => {
      const hook = await api();
      await hook.waitForState(['idle'], 10_000);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const name = 'hello world (1).py';
      assert.equal(fs.readFileSync(path.join(env.boardRoot, name), 'utf8'), fs.readFileSync(path.join(env.workspace, name), 'utf8'), 'precondition: the board and the project hold the same file (synced)');
      const row = await waitFor(async () => (await hook.filesChildren()).find((r) => r.label === name), `the Files view row "${name}"`, 10_000, 250);
      assert.equal(row.command, COMMAND_IDS.openFileFromBoard, 'the row is clickable with the open command');
      await vscode.commands.executeCommand(row.command, ...row.commandArguments);
      const shown = vscode.window.activeTextEditor?.document.uri;
      t.note(`active editor after the click: ${shown?.toString()}`);
      assert.equal(shown?.scheme, 'file', `the click opened ${shown?.toString()}`);
      assert.equal(shown?.fsPath, path.join(env.workspace, name));
      hook.clearTerminal();
      await vscode.commands.executeCommand(COMMAND_IDS.runActiveFile);
      await waitForText(hook, 'hello from the board', 20_000);
      const text = await waitForText(hook, '[program finished]', 20_000);
      assert.ok(text.includes(`[running ${name}]`), `the Run tab names the file: ${JSON.stringify(text.slice(0, 200))}`);
      await hook.waitForState(['idle'], 10_000);
      assert.match(hook.statusBarTexts().board, /Ready/);
    }, 90_000);

    s.test('click a file that is only on the board: the read-only board copy opens; Run does not throw, runs nothing and copies nothing until the offer is answered', async (t) => {
      const hook = await api();
      await hook.waitForState(['idle'], 10_000);
      // The fake board seeds a boot.py (like a real board); the sample project has none, so it exists only on the board. (No file is
      // created and the Files view is not refreshed here: a refresh in the middle of the suite made VS Code log "Unable to refresh
      // tree view: Canceled" once, which the launcher counts as an error of ours.)
      const name = 'boot.py';
      const inProject = path.join(env.workspace, name);
      assert.equal(fs.existsSync(inProject), false, 'precondition: the project has no boot.py');
      assert.equal(fs.existsSync(path.join(env.boardRoot, name)), true, 'precondition: the board has a boot.py');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const row = await waitFor(async () => (await hook.filesChildren()).find((r) => r.label === name), `the Files view row "${name}"`, 15_000, 250);
      await vscode.commands.executeCommand(row.command ?? COMMAND_IDS.openFileFromBoard, ...row.commandArguments);
      const shown = vscode.window.activeTextEditor?.document;
      t.note(`active editor after the click: ${shown?.uri.toString()}`);
      assert.equal(shown?.uri.scheme, BOARD_SCHEME);
      assert.equal(shown?.uri.path, `/${name}`);
      assert.equal(shown?.getText(), fs.readFileSync(path.join(env.boardRoot, name), 'utf8'), 'the read-only document shows the board file');
      hook.clearTerminal();
      // The offer has buttons, so it is a toast that stays on screen; the Run command must finish anyway (it is not allowed to wait for it).
      const t0 = Date.now();
      await Promise.race([
        Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile)),
        sleep(10_000).then(() => { throw new Error('the Run command did not finish within 10 s: it waits for the offer toast'); }),
      ]);
      t.note(`Run returned after ${Date.now() - t0} ms with the offer still open (the toast buttons cannot be pressed from inside the host; the answer paths are unit-tested)`);
      await sleep(1500);
      assert.equal(hook.state().state, 'idle', 'nothing is running on the board');
      assert.ok(!hook.terminalText().includes('[running'), `the Run tab never started a run: ${JSON.stringify(hook.terminalText().slice(0, 200))}`);
      assert.equal(fs.existsSync(inProject), false, 'nothing was copied into the project before the offer was answered');
      assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, BOARD_SCHEME, 'the board copy stays open');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }, 90_000);

    s.test('a program left running when the window closes (checked by the launcher after exit)', async (t) => {
      const hook = await api();
      await openFile('loop prog.py');
      hook.clearTerminal();
      void Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile));
      await waitForText(hook, 'tick', 20_000);
      await sleep(1500);
      assert.match(hook.statusBarTexts().board, /Running/);
      t.note('loop program running for 1.5 s on the fake board; the launcher checks the board after VS Code quits');
    });
  },
};
