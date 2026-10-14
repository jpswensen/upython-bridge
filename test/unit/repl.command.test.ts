/** "Open REPL" (src/commands/repl.ts) and the one-call registration of all terminal features (src/repl/register.ts). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { registerRepl } from '../../src/commands/repl';
import { COMMAND_IDS, MEDIA } from '../../src/contributes';
import { registerTerminalFeatures } from '../../src/repl/register';
import { ReplTerminal } from '../../src/repl/terminal';
import { FakeSession } from '../mocks/fakeSession';
import { mock } from '../mocks/vscode';
import { makeHarness, settle, stubCommand, type Harness } from './repl.helpers';

let h: Harness;
let disposables: vscode.Disposable[] = [];

function install(session: FakeSession, selectPortResult?: boolean | (() => boolean)): void {
  h = makeHarness(session);
  if (selectPortResult === undefined) {
    disposables = registerTerminalFeatures(h.services);
    return;
  }
  // port selection is replaced by a stand-in, so only the Open REPL command and the terminal are registered
  stubCommand(h, COMMAND_IDS.selectPort, selectPortResult);
  const terminal = new ReplTerminal(h.services);
  disposables = [terminal, ...registerRepl(h.services, { terminal })];
}

const openRepl = (): Promise<unknown> => Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.openRepl));

beforeEach(() => mock.reset());
afterEach(() => {
  disposables.forEach((d) => d.dispose());
  disposables = [];
  h?.session.dispose();
  h?.dispose();
  mock.reset();
});

describe('Open REPL', () => {
  it('connected: shows the terminal and attaches; it does not connect, reset, interrupt or type anything', async () => {
    install(FakeSession.connected({ state: 'running' }));
    await openRepl();
    await settle();
    const tab = mock.terminals[0];
    assert.ok(tab);
    assert.ok(tab.shown > 0);
    assert.deepEqual(h.session.calls.map((c) => c.op).filter((op) => op !== 'reset.capability'), ['repl.attach']);
    assert.equal(h.session.callsOf('repl.attach').length, 1, 'attached once (the tab opening and the command share one attach)');
    for (const op of ['stop', 'reset.soft', 'reset.machine', 'reset.hard', 'tty.write', 'connect', 'run']) {
      assert.equal(h.session.callsOf(op as never).length, 0, op);
    }
    assert.deepEqual(tab.sentText, []);
  });

  it('not connected: makes sure a board is connected first (reuse), then shows the terminal', async () => {
    install(new FakeSession(), () => {
      h.session.setState({ state: 'idle', port: '/dev/cu.fake' });
      return true;
    });
    await openRepl();
    await settle();
    assert.deepEqual(h.stubbed, [{ id: COMMAND_IDS.selectPort, args: [{ reuse: true }] }]);
    assert.equal(mock.terminals.length, 1);
    assert.equal(h.session.callsOf('repl.attach').length, 1);
  });

  it('not connected and no port chosen: no terminal, nothing else happens', async () => {
    install(new FakeSession(), false);
    await openRepl();
    assert.equal(mock.terminals.length, 0);
    assert.deepEqual(h.session.calls.filter((c) => c.op !== 'reset.capability'), []);
  });

  it('a failed attach is shown to the student and written in the tab', async () => {
    install(FakeSession.connected());
    h.session.fail('repl.attach', 'E_PORT_BUSY', 'The port is busy.', { hint: 'Close the other program.' });
    await openRepl();
    await settle();
    assert.match(mock.messages('error').at(-1)?.message ?? '', /The terminal could not connect to the board\. The port is busy\. Close the other program\./);
    assert.match(mock.terminals[0]?.output ?? '', /could not connect this terminal to the board/);
  });
});

describe('registerTerminalFeatures', () => {
  it('registers exactly the five terminal commands, and disposing removes them (and closes the tab)', async () => {
    install(FakeSession.connected());
    const own = mock.commandContract().registered.sort();
    assert.deepEqual(own, [COMMAND_IDS.openRepl, COMMAND_IDS.resetBoard, COMMAND_IDS.runActiveFile, COMMAND_IDS.selectPort, COMMAND_IDS.stop].sort());
    await openRepl();
    await settle();
    disposables.forEach((d) => d.dispose());
    disposables = [];
    assert.deepEqual(mock.commandContract().registered, []);
    assert.equal(mock.terminals.length, 0, 'the tab goes with the extension');
    assert.deepEqual(h.session.calls.map((c) => c.op).filter((op) => op === 'repl.detach'), ['repl.detach']);
  });
});

describe('the tab icon (D-19)', () => {
  it('a tab made through registerTerminalFeatures has a light and a dark icon: fixed-colour SVG files that exist in the extension folder', async () => {
    install(FakeSession.connected());
    await openRepl();
    await settle();
    const tab = mock.terminals[0];
    assert.ok(tab);
    const icon = (tab.creationOptions as { iconPath?: unknown }).iconPath as { light: vscode.Uri; dark: vscode.Uri } | undefined;
    assert.ok(icon && icon.light instanceof vscode.Uri && icon.dark instanceof vscode.Uri, 'iconPath is { light: Uri, dark: Uri }');
    assert.notEqual(icon.light.fsPath, icon.dark.fsPath);
    assert.equal(icon.light.fsPath, path.join(h.ctx.extensionPath, ...MEDIA.terminalLight.split('/')));
    assert.equal(icon.dark.fsPath, path.join(h.ctx.extensionPath, ...MEDIA.terminalDark.split('/')));
    for (const uri of [icon.light, icon.dark]) {
      assert.ok(fs.existsSync(uri.fsPath), `${uri.fsPath} exists`);
      assert.doesNotMatch(fs.readFileSync(uri.fsPath, 'utf8'), /currentColor/, 'a terminal icon is not themed by VS Code, so its colours are fixed');
    }
  });

  it('is found through the extension folder, not the working directory', async () => {
    install(FakeSession.connected());
    const cwd = process.cwd();
    try {
      process.chdir(path.dirname(h.ctx.extensionPath));
      await openRepl();
      await settle();
    } finally {
      process.chdir(cwd);
    }
    const icon = (mock.terminals[0]?.creationOptions as { iconPath?: { light: vscode.Uri } }).iconPath;
    assert.ok(icon && path.isAbsolute(icon.light.fsPath) && fs.existsSync(icon.light.fsPath));
  });
});
