/** The names of the product (decision D-18): one table in src/identity.ts, ASCII everywhere except the display name. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';
import { BOARD_SCHEME } from '../../src/commands/boardFiles';
import { BOARD_URI_SCHEME } from '../../src/views/decorations';
import { commandId, contextKey, fullExtensionId, IDENTITY, LEGACY, settingId, stateKey, viewContainerId, viewId } from '../../src/identity';

const ASCII = /^[\x20-\x7e]*$/;

describe('identity: the final names (D-18)', () => {
  it('has the Marketplace id upython-bridge: ASCII, lower case, hyphens only', () => {
    assert.equal(IDENTITY.extensionId, 'upython-bridge');
    assert.match(IDENTITY.extensionId, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(fullExtensionId(), 'jpswensen.upython-bridge');
  });

  it('starts the display name with U+03BC GREEK SMALL LETTER MU, never the micro sign U+00B5', () => {
    assert.equal(IDENTITY.displayName.codePointAt(0), 0x03bc);
    assert.equal(IDENTITY.displayName, '\u03bcPython Bridge');
    assert.ok(!IDENTITY.displayName.includes('\u00b5'), 'no micro sign');
    assert.ok(!IDENTITY.displayName.includes('\u039c'), 'no capital mu');
    assert.equal([...IDENTITY.displayName].length, 'uPython Bridge'.length);
    assert.equal(IDENTITY.displayName.normalize('NFC'), IDENTITY.displayName);
  });

  it('uses the display name for the output channel and the terminal tab, and the short ASCII form for tight places', () => {
    assert.equal(IDENTITY.outputChannelName, IDENTITY.displayName);
    assert.equal(IDENTITY.terminalName, IDENTITY.displayName);
    assert.equal(IDENTITY.shortName, 'uPy Bridge');
    assert.match(IDENTITY.shortName, ASCII);
  });

  it('has the hyphenated prefix upy-bridge and the folder .upy-bridge', () => {
    assert.equal(IDENTITY.prefix, 'upy-bridge');
    assert.match(IDENTITY.prefix, /^[a-z]+(-[a-z]+)*$/);
    assert.equal(IDENTITY.dotDir, '.upy-bridge');
  });

  it('keeps the stage-2 names for now: the ignore file stays .mpyignore', () => {
    assert.equal(IDENTITY.ignoreFile, '.mpyignore');
  });

  it('is ASCII everywhere except the three places that show the display name', () => {
    const shown = new Set(['displayName', 'outputChannelName', 'terminalName']);
    for (const [key, value] of Object.entries(IDENTITY)) {
      if (!shown.has(key)) { assert.match(value, ASCII, `IDENTITY.${key} is ASCII`); }
    }
  });

  it('names MicroPython only descriptively: not in any name, once in the description', () => {
    for (const key of ['extensionId', 'displayName', 'shortName', 'prefix', 'dotDir', 'outputChannelName', 'terminalName'] as const) {
      assert.doesNotMatch(IDENTITY[key], /micropython/i, key);
    }
    assert.match(IDENTITY.description, /boards running MicroPython/);
    assert.equal(IDENTITY.description, 'Run MicroPython programs, use the board REPL, keep your files in sync and get IntelliSense for boards running MicroPython, from VS Code.');
  });

  it('builds every id from the prefix, in the documented shape', () => {
    assert.equal(commandId('run'), 'upy-bridge.run');
    assert.equal(settingId('run.freshStart'), 'upy-bridge.run.freshStart');
    assert.equal(stateKey('rememberedPort'), 'upy-bridge.rememberedPort');
    assert.equal(contextKey('connected'), 'upy-bridge.connected');
    assert.equal(viewContainerId(), 'upy-bridge');
    assert.equal(viewId('files'), 'upy-bridgeFilesView');
  });

  it('stays distinct from the old extension, which is only named in LEGACY', () => {
    assert.equal(LEGACY.extensionId, 'DanielBucam.mpy-workbench');
    assert.equal(LEGACY.dotDir, '.mpy-workbench');
    assert.notEqual(IDENTITY.prefix.toLowerCase(), 'mpyworkbench');
    assert.ok(!fullExtensionId().toLowerCase().includes('mpy-workbench'));
  });

  it('derives URI schemes from the prefix that are valid (letters, digits, + - . only, first a letter) and that Uri.from accepts', () => {
    assert.equal(BOARD_URI_SCHEME, 'upy-bridge');
    assert.equal(BOARD_SCHEME, 'upy-bridge-board');
    for (const scheme of [BOARD_URI_SCHEME, BOARD_SCHEME]) {
      assert.match(scheme, /^[a-z][a-z0-9+.-]*$/);
      assert.equal(vscode.Uri.from({ scheme, path: '/lib/x.py' }).scheme, scheme);
    }
  });
});
