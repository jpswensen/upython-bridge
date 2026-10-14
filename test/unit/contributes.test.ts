/**
 * The manifest and the table agree (R-ARCH, 06 invariant 9): package.json is exactly what src/contributes.ts generates, every
 * menu/welcome/keybinding refers to something declared, and the activation and trust settings match RQ-DIST-4 / R-ARCH-11.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { allCommandIds, buildManifest, CATEGORIES, COMMANDS, COMMAND_IDS, CONTEXT, GALLERY_BANNER, KEYWORDS, MEDIA, MENUS, SETTINGS, SETTING_DEFAULTS, VIEWS, OPEN_FOLDER_COMMAND } from '../../src/contributes';
import { IDENTITY, commandId, fullExtensionId, settingId, viewContainerId, viewId } from '../../src/identity';
import { projectRoot } from '../mocks/fixtures';

type Json = Record<string, unknown>;
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot(), 'package.json'), 'utf8')) as Json;
const manifest = buildManifest();
const contributes = pkg.contributes as {
  commands: { command: string; title: string; category: string }[];
  menus: Record<string, { command: string; when: string; group?: string }[]>;
  viewsWelcome: { view: string; contents: string; when: string }[];
  views: Record<string, { id: string; name: string }[]>;
  viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
  configuration: { properties: Record<string, { default: unknown; scope?: string }> };
};

describe('package.json is generated from src/contributes.ts', () => {
  it('has exactly the generated sections', () => {
    for (const [key, value] of Object.entries(manifest)) {
      assert.deepEqual(pkg[key], value, `package.json "${key}" differs from the table: run npm run gen:manifest`);
    }
  });

  it('takes name, publisher and display name from the identity', () => {
    assert.equal(pkg.name, IDENTITY.extensionId);
    assert.equal(pkg.publisher, IDENTITY.publisher);
    assert.equal(pkg.displayName, IDENTITY.displayName);
    assert.equal(pkg.description, IDENTITY.description);
    assert.equal(fullExtensionId(), `${IDENTITY.publisher}.${IDENTITY.extensionId}`);
  });

  it('is saved as UTF-8 with the real Greek mu (U+03BC) in the display name and the settings title; the sidebar title and the palette category use the short ASCII name (VS Code upper-cases the sidebar title, which would turn the mu into a capital Mu that looks like a Latin M)', () => {
    const raw = fs.readFileSync(path.join(projectRoot(), 'package.json'), 'utf8');
    assert.ok(raw.includes('"displayName": "\u03bcPython Bridge"'), 'the file holds the character itself');
    assert.ok(!raw.includes('\u00b5'), 'no micro sign anywhere');
    assert.ok(!raw.includes('\\u03bc'), 'and no JSON escape that a text tool could mangle');
    assert.equal(contributes.viewsContainers.activitybar[0]?.title, 'uPy Bridge');
    assert.equal((contributes.configuration as unknown as { title: string }).title, '\u03bcPython Bridge');
    assert.ok(contributes.commands.every((c) => c.category === 'uPy Bridge'));
    assert.match(pkg.name as string, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'the package name is ASCII');
  });

  it('is deterministic', () => {
    assert.deepEqual(buildManifest(), buildManifest());
  });
});

describe('commands', () => {
  it('declares exactly the planned set, with unique ids under the prefix', () => {
    const names = COMMANDS.map((c) => c.name).sort();
    assert.deepEqual(names, [
      'clearDevice', 'createIgnoreFile', 'deleteOnBoard', 'deleteOnBoardAndLocal', 'doctor', 'fixIntelliSense', 'newFileOnBoard', 'newFolderOnBoard', 'openBoardCopy', 'openFileFromBoard',
      'openRepl', 'refresh', 'removeIntelliSense', 'renameOnBoard', 'resetBoard', 'runActiveFile', 'selectPort', 'showLog', 'stop', 'syncFromBoard',
      'syncToBoard', 'toggleAutoSync', 'uploadActiveFile',
      // D-22 board clock, D-21 the marks legend and the per-file actions of the Files view
      'setBoardClock', 'syncLegend', 'compareWithBoard', 'uploadThisFile', 'downloadThisFile',
    ].sort());
    const ids = allCommandIds();
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => id.startsWith(`${IDENTITY.prefix}.`)));
    assert.deepEqual(ids, contributes.commands.map((c) => c.command));
    assert.equal(COMMAND_IDS.runActiveFile, commandId('runActiveFile'));
  });

  it('has no wrapper or dead commands and no IntelliSense commands yet', () => {
    for (const c of allCommandIds()) {
      assert.doesNotMatch(c, /FromView|runFromView|autoSuspend|setPort|refreshPorts|initializeWorkspace|generateStubs|configureLinting/);
    }
  });

  it('gives every command an English title and the short ASCII name as category (typeable in the command palette)', () => {
    for (const c of contributes.commands) {
      assert.match(c.title, /^[A-Z]/);
      assert.equal(c.category, IDENTITY.shortName);
    }
  });

  it('references only declared commands from menus', () => {
    const declared = new Set(allCommandIds());
    for (const [menu, entries] of Object.entries(contributes.menus)) {
      for (const e of entries) { assert.ok(declared.has(e.command), `${menu} references undeclared ${e.command}`); }
    }
    assert.equal(MENUS.length, contributes.menus['view/title']!.length + contributes.menus['view/item/context']!.length);
  });

  it('puts the planned buttons in the view titles', () => {
    const title = contributes.menus['view/title']!;
    const inView = (v: string): string[] => title.filter((e) => e.when === `view == ${v}`).map((e) => e.command);
    assert.deepEqual(inView(VIEWS.sync), [COMMAND_IDS.syncToBoard, COMMAND_IDS.syncFromBoard, COMMAND_IDS.clearDevice]);
    assert.deepEqual(inView(VIEWS.actions), [COMMAND_IDS.runActiveFile, COMMAND_IDS.openRepl, COMMAND_IDS.stop]);
    assert.deepEqual(inView(VIEWS.files).slice(0, 2), [COMMAND_IDS.refresh, COMMAND_IDS.selectPort]);
  });

  it('hides node-argument commands from the palette', () => {
    const hidden = contributes.menus.commandPalette!.map((e) => e.command).sort();
    assert.deepEqual(hidden, [
      COMMAND_IDS.deleteOnBoard, COMMAND_IDS.deleteOnBoardAndLocal, COMMAND_IDS.openBoardCopy, COMMAND_IDS.openFileFromBoard, COMMAND_IDS.renameOnBoard,
      COMMAND_IDS.compareWithBoard, COMMAND_IDS.uploadThisFile, COMMAND_IDS.downloadThisFile,
    ].sort());
  });
});

describe('views, welcome text and context keys', () => {
  it('declares one container with three views', () => {
    assert.deepEqual(contributes.viewsContainers.activitybar.map((c) => c.id), [IDENTITY.prefix]);
    assert.equal(contributes.viewsContainers.activitybar[0]!.icon, 'media/activitybar.svg');
    assert.ok(fs.existsSync(path.join(projectRoot(), 'media', 'activitybar.svg')));
    assert.deepEqual(contributes.views[IDENTITY.prefix]!.map((v) => [v.id, v.name]), [
      [viewId('files'), 'Files'], [viewId('actions'), 'Board Actions'], [viewId('sync'), 'Sync utilities'],
    ]);
  });

  it('shows the port button when no port is selected and the Doctor button for an interpreter problem, both only with a folder open', () => {
    const files = contributes.viewsWelcome.filter((w) => w.view === VIEWS.files);
    assert.equal(files.length, 3);
    assert.ok(files.some((w) => w.contents.includes(`(command:${COMMAND_IDS.selectPort})`) && w.when.includes(`!${CONTEXT.hasPort}`) && w.when.startsWith('workspaceFolderCount > 0')));
    assert.ok(files.some((w) => w.contents.includes(`(command:${COMMAND_IDS.doctor})`) && w.when === `workspaceFolderCount > 0 && ${CONTEXT.interpreterProblem}`));
  });

  it('D-24: without a folder, all three views show only the Open Folder welcome', () => {
    for (const view of [VIEWS.files, VIEWS.actions, VIEWS.sync]) {
      const w = contributes.viewsWelcome.filter((x) => x.view === view && x.when === 'workspaceFolderCount == 0');
      assert.equal(w.length, 1, view);
      assert.ok(w[0]?.contents.includes(`(command:${OPEN_FOLDER_COMMAND})`), view);
    }
  });

  it('uses only declared context keys and views in when clauses', () => {
    const known = new Set<string>(Object.values(CONTEXT));
    const whens = [...Object.values(contributes.menus).flat().map((m) => m.when), ...contributes.viewsWelcome.map((w) => w.when)];
    for (const when of whens) {
      for (const m of when.matchAll(new RegExp(`${IDENTITY.prefix}\\.[A-Za-z]+`, 'g'))) {
        assert.ok(known.has(m[0]), `when "${when}" uses unknown context key ${m[0]}`);
      }
      for (const m of when.matchAll(/view == ([\w-]+)/g)) {
        assert.ok((Object.values(VIEWS) as string[]).includes(m[1]!), `when "${when}" names an undeclared view`);
      }
    }
  });
});

describe('activation, trust and engine', () => {
  it('activates on view visibility and project markers, never on every Python file', () => {
    const events = pkg.activationEvents as string[];
    assert.deepEqual(events.filter((e) => e.startsWith('onView:')).sort(), Object.values(VIEWS).map((v) => `onView:${v}`).sort());
    assert.deepEqual(events.filter((e) => e.startsWith('workspaceContains:')).sort(), ['workspaceContains:.mpyignore', 'workspaceContains:boot.py', 'workspaceContains:main.py']);
    assert.ok(!events.some((e) => e.startsWith('onLanguage') || e === '*' || e === 'onStartupFinished'));
  });

  it('is limited in untrusted workspaces and restricts the workspace-controlled settings', () => {
    const t = (pkg.capabilities as { untrustedWorkspaces: { supported: string; restrictedConfigurations: string[] } }).untrustedWorkspaces;
    assert.equal(t.supported, 'limited');
    assert.deepEqual([...t.restrictedConfigurations].sort(), [settingId('pythonPath'), settingId('port')].sort());
    for (const key of t.restrictedConfigurations) { assert.ok(key in contributes.configuration.properties); }
  });

  it('is a workspace extension on VS Code ^1.90 with a matching @types/vscode', () => {
    assert.deepEqual(pkg.extensionKind, ['workspace']);
    const engine = (pkg.engines as { vscode: string }).vscode;
    assert.equal(engine, '^1.90.0');
    const types = (pkg.devDependencies as Record<string, string>)['@types/vscode'];
    assert.equal(types, engine.replace('^', ''));
    assert.equal(pkg.main, './dist/extension.js');
  });

  it('pins every dependency exactly', () => {
    for (const group of ['dependencies', 'devDependencies'] as const) {
      for (const [name, range] of Object.entries(pkg[group] as Record<string, string>)) {
        assert.match(range, /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly, got ${range}`);
      }
    }
  });
});

describe('settings', () => {
  it('declares every setting under the prefix with a default and a description', () => {
    for (const s of SETTINGS) {
      const entry = contributes.configuration.properties[settingId(s.key)];
      assert.ok(entry, `${s.key} is missing from package.json`);
      assert.deepEqual(entry.default, SETTING_DEFAULTS[s.key]);
    }
    assert.equal(Object.keys(contributes.configuration.properties).length, SETTINGS.length);
  });

  it('never defaults a port-like setting to the word auto', () => {
    for (const s of SETTINGS) {
      if (/port|connect/i.test(s.key)) { assert.notEqual(String(s.default).toLowerCase(), 'auto'); }
    }
  });

  it('has the documented defaults', () => {
    assert.equal(SETTING_DEFAULTS.autoSync, 'on', 'D-21: auto-sync is on by default (behind the first-sync review)');
    assert.equal(SETTING_DEFAULTS['board.setClockOnConnect'], 'whenUnset', 'D-22');
    assert.equal(SETTING_DEFAULTS['run.freshStart'], true);
    assert.equal(SETTING_DEFAULTS['reset.showUnverifiedHardReset'], false);
    assert.equal(SETTING_DEFAULTS.stopOnDisconnect, true);
    assert.equal(SETTING_DEFAULTS.stopOnTerminalClose, true);
    assert.equal(SETTING_DEFAULTS.rootPath, '/');
  });
});

describe('the prefix is hyphenated: every generated id is valid and consistent', () => {
  const P = IDENTITY.prefix;
  const esc = P.replace(/[-.]/g, '\\$&');

  it('uses the prefix for every command, setting, context key, view and the view container', () => {
    assert.equal(P, 'upy-bridge');
    for (const id of allCommandIds()) { assert.match(id, new RegExp(`^${esc}\\.[A-Za-z][A-Za-z0-9]*$`), id); }
    for (const key of Object.keys(contributes.configuration.properties)) { assert.match(key, new RegExp(`^${esc}\\.[A-Za-z][A-Za-z0-9.]*$`), key); }
    for (const key of Object.values(CONTEXT)) { assert.match(key, new RegExp(`^${esc}\\.[A-Za-z][A-Za-z0-9]*$`), key); }
    for (const view of Object.values(VIEWS)) { assert.match(view, new RegExp(`^${esc}[A-Z][A-Za-z]*View$`), view); }
    assert.equal(viewContainerId(), P);
    assert.deepEqual(Object.keys(contributes.views), [P]);
  });

  it('puts no old prefix, old id or old name anywhere in the generated manifest', () => {
    const text = JSON.stringify(pkg);
    assert.doesNotMatch(text, /mpy[-_ ]?bench/i);
    assert.doesNotMatch(text, /mpyWorkbench|mpy-workbench/);
  });

  it('writes the hyphenated ids into activation events, menus, welcome text and trust lists the same way', () => {
    const events = pkg.activationEvents as string[];
    for (const v of Object.values(VIEWS)) { assert.ok(events.includes(`onView:${v}`)); }
    const whens = [...Object.values(contributes.menus).flat().map((m) => m.when), ...contributes.viewsWelcome.map((w) => w.when)];
    const hyphenated = whens.filter((w) => w.includes(`${P}.`));
    assert.ok(hyphenated.length >= 2, 'at least the two welcome texts use a hyphenated context key');
    for (const w of hyphenated) {
      // The only characters VS Code's when-clause lexer takes inside a key are [A-Za-z0-9_<>-./\\:*?+[]^,#@;"%$] and letters, so '-' is fine
      // (read from the workbench bundle of VS Code 1.141: stringRe); the host suite proves it by running with these clauses.
      assert.match(w, /^[A-Za-z0-9_.!&|() =<>-]+$/, w); // '>' / '<': comparison with VS Code's own workspaceFolderCount (D-24)
    }
    assert.ok(contributes.viewsWelcome.some((w) => w.when === `workspaceFolderCount > 0 && !${CONTEXT.hasPort} && !${CONTEXT.interpreterProblem}`));
    for (const r of (pkg.capabilities as { untrustedWorkspaces: { restrictedConfigurations: string[] } }).untrustedWorkspaces.restrictedConfigurations) {
      assert.ok(r.startsWith(`${P}.`));
    }
    for (const w of contributes.viewsWelcome) {
      // ours, or VS Code's own Open Folder command (D-24)
      for (const m of w.contents.matchAll(/\(command:([^)]+)\)/g)) { assert.ok(allCommandIds().includes(m[1]!) || m[1] === OPEN_FOLDER_COMMAND, `${m[1]} is a declared command`); }
    }
  });
});

describe('artwork and Marketplace metadata (D-19)', () => {
  const root = projectRoot();
  const files = (): string[] => fs.readdirSync(path.join(root, 'media')).filter((n) => n !== '.DS_Store').sort();

  const mediaRefs = (value: unknown, out: string[] = []): string[] => {
    if (typeof value === 'string') { if (value.startsWith('media/')) { out.push(value); } } else if (Array.isArray(value)) { value.forEach((v) => mediaRefs(v, out)); } else if (value && typeof value === 'object') { Object.values(value).forEach((v) => mediaRefs(v, out)); }
    return out;
  };

  it('has the Marketplace icon, the gallery banner colour, keywords and categories', () => {
    assert.equal(pkg.icon, 'media/icon.png');
    assert.deepEqual(pkg.galleryBanner, { color: '#0E5968', theme: 'dark' });
    assert.deepEqual(pkg.galleryBanner, { ...GALLERY_BANNER });
    assert.deepEqual(pkg.keywords, [...KEYWORDS]);
    assert.deepEqual(pkg.keywords, ['micropython', 'upython', 'esp32', 'rp2040', 'pico', 'repl', 'serial', 'intellisense', 'education']);
    assert.deepEqual(pkg.categories, [...CATEGORIES]);
    assert.deepEqual(pkg.categories, ['Education', 'Other']);
  });

  it('icon.png is a 256 x 256 PNG (the Marketplace wants a PNG of at least 128 px)', () => {
    const png = fs.readFileSync(path.join(root, ...String(pkg.icon).split('/')));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256]);
  });

  it('every file that package.json refers to exists, and every file in media/ is one the table names', () => {
    const refs = mediaRefs(pkg);
    assert.ok(refs.length >= 5, `package.json refers to the media files (${refs.join(', ')})`);
    for (const rel of refs) { assert.ok(fs.existsSync(path.join(root, ...rel.split('/'))), `${rel} exists`); }
    for (const rel of Object.values(MEDIA)) { assert.ok(fs.existsSync(path.join(root, ...rel.split('/'))), `${rel} exists`); }
    assert.deepEqual(files().map((n) => `media/${n}`), Object.values(MEDIA).slice().sort(), 'media/ holds exactly the artwork of the table (no old trash-red.svg, no banner)');
  });

  it('uses the danger icons for the two destructive commands and the arch-mu glyph for the activity bar', () => {
    for (const name of ['clearDevice', 'deleteOnBoardAndLocal'] as const) {
      const c = contributes.commands.find((e) => e.command === COMMAND_IDS[name]) as { icon?: unknown } | undefined;
      assert.deepEqual(c?.icon, { light: 'media/trash-danger-light.svg', dark: 'media/trash-danger-dark.svg' }, name);
    }
    assert.equal(contributes.viewsContainers.activitybar[0]?.icon, 'media/activitybar.svg');
    const read = (rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    assert.match(read(MEDIA.activityBar), /currentColor/, 'the activity bar glyph is a mask drawn with currentColor');
    for (const rel of [MEDIA.terminalLight, MEDIA.terminalDark, MEDIA.trashLight, MEDIA.trashDark]) {
      assert.doesNotMatch(read(rel), /currentColor/, `${rel} has fixed colours`);
    }
  });
});
