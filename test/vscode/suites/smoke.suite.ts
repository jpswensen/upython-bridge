/** Smoke: the extension host started, is isolated from the real board, and sees our extension. Activates nothing. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SuiteDef } from '../runner';
import { allCommandIds, assert, env, IDENTITY, ourExtension, OUR_ID } from '../util';

export const smoke: SuiteDef = {
  name: 'smoke',
  define(s) {
    s.test('the extension host is up and isolated from the real board', (t) => {
      assert.ok(vscode.version.length > 0, 'vscode.version is set');
      t.note(`VS Code ${vscode.version} (${vscode.env.appName}), Electron ${process.versions.electron ?? '?'}, Node ${process.versions.node}`);
      assert.equal(process.env.MPY_SAFE_MODE, '1', 'safe mode is on');
      assert.equal(process.env.MPY_REAL_PORT, undefined, 'no real port is configured');
      assert.ok(env.userData.includes('mpyvs'), `the profile is in the scratch root: ${env.userData}`);
      assert.ok(env.boardUrl.startsWith('socket://127.0.0.1:'), `the only board is the fake one: ${env.boardUrl}`);
      t.note(`window: ${vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join(', ') ?? '(none)'}`);
    });
    s.test('our extension is installed from the development path', (t) => {
      const ext = ourExtension();
      t.note(`${OUR_ID} ${String((ext.packageJSON as { version?: string }).version)} at ${ext.extensionPath}, active=${ext.isActive}`);
    });

    s.test('the manifest the host loaded carries the final names (D-18) and the artwork (D-19); nothing of the old names', (t) => {
      const ext = ourExtension();
      assert.equal(ext.id.toLowerCase(), 'jpswensen.upython-bridge');
      const pkg = ext.packageJSON as {
        name: string; displayName: string; description: string; icon: string; galleryBanner: { color: string; theme: string }; keywords: string[];
        contributes: { viewsContainers: { activitybar: { id: string; title: string; icon: string }[] }; commands: { command: string; category: string }[] };
      };
      assert.equal(pkg.name, 'upython-bridge');
      assert.match(pkg.name, /^[\x21-\x7e]+$/, 'the package name is ASCII');
      assert.equal(pkg.displayName.codePointAt(0), 0x03bc, 'the display name starts with U+03BC GREEK SMALL LETTER MU');
      assert.equal(pkg.displayName, '\u03bcPython Bridge');
      assert.ok(!pkg.displayName.includes('\u00b5'), 'not the micro sign U+00B5');
      assert.equal(pkg.displayName, IDENTITY.displayName);
      const container = pkg.contributes.viewsContainers.activitybar[0];
      assert.ok(container);
      assert.equal(container.id, 'upy-bridge');
      assert.equal(container.title, 'uPy Bridge', 'the sidebar title is the short ASCII name: VS Code upper-cases it with CSS and the Greek mu would become a capital Mu that looks like a Latin M');
      const onDisk = (rel: string): string => path.join(ext.extensionPath, ...rel.split('/'));
      assert.ok(fs.existsSync(onDisk(container.icon)), `${container.icon} exists`);
      assert.ok(fs.existsSync(onDisk(pkg.icon)), `${pkg.icon} exists`);
      assert.equal(fs.readFileSync(onDisk(pkg.icon)).subarray(1, 4).toString('latin1'), 'PNG');
      assert.deepEqual(pkg.galleryBanner, { color: '#0E5968', theme: 'dark' });
      assert.ok(pkg.keywords.includes('micropython') && pkg.keywords.includes('upython'));
      assert.match(pkg.description, /boards running MicroPython/);
      assert.ok(pkg.contributes.commands.length >= 20 && pkg.contributes.commands.every((c) => c.command.startsWith('upy-bridge.') && c.category === 'uPy Bridge'));
      assert.deepEqual(pkg.contributes.commands.map((c) => c.command), allCommandIds());
      assert.doesNotMatch(JSON.stringify(pkg), /mpy[-_ ]?bench/i, 'no old working name in the loaded manifest');
      t.note(`id ${ext.id}; displayName code points: ${[...pkg.displayName].slice(0, 3).map((c) => 'U+' + c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')).join(' ')}...; sidebar title "${container.title}"; icon ${pkg.icon}; banner ${JSON.stringify(pkg.galleryBanner)}`);
    });
  },
};
