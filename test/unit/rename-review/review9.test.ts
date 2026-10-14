/**
 * Independent review of the rename + branding wiring (stage 1, D-18 / D-19). Adversarial additions only: nothing here duplicates
 * test/unit/identity.test.ts or the D-18 blocks of contributes.test.ts / package.test.ts. Pure Node, no serial port, no VS Code launch.
 *
 *   npm test -- rename-review
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { modify, applyEdits, parse } from 'jsonc-parser';
import { buildManifest, CONTEXT, VIEWS } from '../../../src/contributes';
import { IDENTITY, commandId, settingId, viewContainerId } from '../../../src/identity';
import { IgnoreMatcher } from '../../../src/sync/ignore';
import { projectRoot } from '../../mocks/fixtures';

const root = projectRoot();
const read = (rel: string): Buffer => fs.readFileSync(path.join(root, ...rel.split('/')));

/** The token pattern of VS Code's `when` clause scanner, copied from workbench.desktop.main.js of VS Code 1.141 (Scanner.stringRe). */
const stringRe = /^[a-zA-Z0-9_<>\-./\\:*?+[\]^,#@;"%$\p{L}-]+$/u;

/** Splits a `when` clause the way the scanner does for the shapes this manifest uses: operators and parentheses separate words. */
function whenWords(when: string): string[] {
  const noQuotes = when.replace(/'[^']*'|"[^"]*"/g, ' ');
  const noRegex = noQuotes.replace(/=~\s*\/(?:\\.|[^/\\])+\/[a-z]*/g, ' ');
  return noRegex.split(/\s*(?:&&|\|\||===|!==|==|!=|<=|>=|=~|<|>|!|\(|\))\s*|\s+/).filter((w) => w.length > 0 && !['in', 'not', 'true', 'false'].includes(w));
}

describe('rename review: hyphenated ids against the real VS Code lexer', () => {
  const manifest = buildManifest() as unknown as {
    contributes: {
      menus: Record<string, { when?: string }[]>;
      viewsWelcome: { when: string }[];
      commands: { command: string; title: string; category: string }[];
    };
  };

  it('every word of every when clause (menus and welcome texts) is one token for the 1.141 scanner, and the keys are the declared ones', () => {
    const whens = [
      ...Object.values(manifest.contributes.menus).flat().flatMap((m) => (m.when ? [m.when] : [])),
      ...manifest.contributes.viewsWelcome.map((w) => w.when),
    ];
    assert.ok(whens.length > 20, `found ${whens.length} when clauses`);
    const declared = new Set<string>([...Object.values(CONTEXT), ...Object.values(VIEWS), 'view', 'viewItem', 'config.' + IDENTITY.prefix]);
    let hyphenated = 0;
    for (const when of whens) {
      for (const word of whenWords(when)) {
        assert.match(word, stringRe, `"${word}" in "${when}" is a single scanner token`);
        if (word.includes('-')) { hyphenated++; }
        if (word.startsWith(`${IDENTITY.prefix}.`) || word.startsWith(IDENTITY.prefix)) { assert.ok(declared.has(word), `${word} is a declared key or view id`); }
      }
    }
    assert.ok(hyphenated >= 10, `the hyphen is really exercised (${hyphenated} words)`);
  });

  it('every id the extension declares (commands, views, container, context keys, settings) is a single scanner token and has no look-alike', () => {
    const ids = [
      viewContainerId(), ...Object.values(VIEWS), ...Object.values(CONTEXT), ...manifest.contributes.commands.map((c) => c.command),
      ...Object.keys((buildManifest() as unknown as { contributes: { configuration: { properties: object } } }).contributes.configuration.properties),
    ];
    for (const id of ids) {
      assert.match(id, stringRe, id);
      assert.ok(!/[^\x20-\x7e]/.test(id), `${id} is ASCII`);
    }
    assert.equal(new Set(ids.map((i) => i.toLowerCase())).size, new Set(ids).size, 'no two ids differ only in case');
    assert.equal(commandId('runActiveFile'), manifest.contributes.commands.find((c) => c.command === commandId('runActiveFile'))?.command);
    assert.match(viewContainerId(), /^[a-zA-Z0-9_-]+$/, 'the activity bar container id rule of VS Code (viewsContainers.id)');
  });

  it('no command title or category carries the micro sign, a capital mu or a decomposed form; the category is the short ASCII name', () => {
    for (const c of manifest.contributes.commands) {
      assert.equal(c.category, IDENTITY.shortName);
      assert.ok(!/[µΜ]/.test(c.title + c.category), `${c.command}: no look-alike mu`);
      assert.equal((c.title + c.category).normalize('NFC'), c.title + c.category, `${c.command} is NFC`);
    }
    assert.equal(IDENTITY.displayName.normalize('NFKC'), IDENTITY.displayName, 'NFKC would turn a micro sign into U+03BC: this one is stable');
    assert.equal(IDENTITY.displayName.normalize('NFD'), IDENTITY.displayName, 'macOS file names (the output channel log file) are decomposed: nothing changes');
  });
});

describe('rename review: bytes on disk and in the bundle', () => {
  it('package.json is UTF-8 without BOM, the display name is the two bytes CE BC followed by ASCII, and every other byte of the identity is ASCII', () => {
    const raw = read('package.json');
    assert.notEqual(raw.subarray(0, 3).toString('hex'), 'efbbbf', 'no BOM');
    const text = raw.toString('utf8');
    assert.ok(!text.includes('�'), 'decodes without replacement characters');
    assert.ok(raw.includes(Buffer.from('"displayName": "μPython Bridge"', 'utf8')));
    assert.equal(raw.indexOf(Buffer.from([0xce, 0xbc, 0x50, 0x79, 0x74, 0x68, 0x6f, 0x6e, 0x20, 0x42, 0x72, 0x69, 0x64, 0x67, 0x65])) > 0, true);
    const header = text.slice(0, text.indexOf('"contributes"'));
    const nonAscii = [...header].filter((c) => c.codePointAt(0)! > 0x7e).map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
    assert.deepEqual([...new Set(nonAscii)], ['U+03BC'], 'before "contributes" only the Greek mu is non-ASCII');
  });

  it('the shipped text files (bundle, manifest, README, NOTICE, SVGs, LICENSE) contain no old working name in any spelling', () => {
    const old = /mpy[\s_-]*b[e]?nch|mpyBench|MPYBENCH/i;
    const files = ['package.json', 'README.md', 'NOTICE', 'THIRD_PARTY_NOTICES', 'LICENSE', ...fs.readdirSync(path.join(root, 'media')).filter((n) => n.endsWith('.svg')).map((n) => `media/${n}`)];
    if (fs.existsSync(path.join(root, 'dist', 'extension.js'))) { files.push('dist/extension.js'); }
    for (const f of files) { assert.doesNotMatch(read(f).toString('utf8'), old, f); }
    if (fs.existsSync(path.join(root, 'dist', 'extension.js'))) {
      const bundle = read('dist/extension.js').toString('utf8');
      assert.ok(bundle.includes('.upy-bridge'), 'the bundle writes the new project folder');
      assert.ok(bundle.includes(`'${IDENTITY.prefix}'`) || bundle.includes(`"${IDENTITY.prefix}"`), 'and the new prefix');
    }
  });

  it('a VSIX in out/ has an ASCII file name made from the package name and version', () => {
    const out = path.join(root, 'out');
    const vsix = fs.existsSync(out) ? fs.readdirSync(out).filter((n) => n.endsWith('.vsix')) : [];
    for (const name of vsix) { assert.match(name, /^[A-Za-z0-9._-]+\.vsix$/, name); }
    if (vsix.length > 0) {
      const pkg = JSON.parse(read('package.json').toString('utf8')) as { name: string; version: string };
      assert.deepEqual(vsix, [`${pkg.name}-${pkg.version}.vsix`], 'only the current VSIX is left in out/');
    }
  });

  it('the SVG artwork has no script, style, external reference or embedded data (it is loaded by the workbench)', () => {
    for (const n of fs.readdirSync(path.join(root, 'media')).filter((x) => x.endsWith('.svg'))) {
      const svg = read(`media/${n}`).toString('utf8');
      assert.doesNotMatch(svg, /<script|<style|<image|<foreignObject|\bon[a-z]+=|href=|data:|url\(/i, n);
      assert.match(svg, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, n);
    }
  });
});

describe('rename review: the project folder and the settings file', () => {
  it('the default ignore list covers .upy-bridge/ (and the old extension folder), and gives the abandoned .mpybench no special treatment', () => {
    const ig = new IgnoreMatcher();
    for (const rel of ['.upy-bridge/manifest.json', '.upy-bridge/stubs/active/time.pyi', '.upy-bridge/pyright.generated.json']) { assert.equal(ig.ignores(rel), true, rel); }
    assert.equal(ig.ignores('.upy-bridge', true), true);
    assert.equal(ig.ignores('.mpy-workbench/state.json'), true);
    assert.equal(ig.ignores('.mpybench/own.py'), false, 'the old working name is not a known folder any more');
    assert.equal(ig.ignores('upy-bridge/lib.py'), false, 'a user folder of that name without the dot is not hidden');
  });

  it('jsonc-parser edits settings.json with a dotted, hyphenated key as ONE flat property, keeping comments and neighbours', () => {
    const text = '{\n  // my board\n  "upy-bridge.port": "COM3", // trailing\n  "editor.fontSize": 14,\n}\n';
    const key = settingId('port');
    const edited = applyEdits(text, modify(text, [key], '/dev/cu.usbserial-0001', { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    const parsed = parse(edited) as Record<string, unknown>;
    assert.equal(parsed[key], '/dev/cu.usbserial-0001');
    assert.equal(parsed['editor.fontSize'], 14);
    assert.deepEqual(Object.keys(parsed).sort(), ['editor.fontSize', key].sort(), 'no nested "upy-bridge": { "port" } object was created');
    assert.match(edited, /\/\/ my board/);
    const added = applyEdits('{}\n', modify('{}\n', [settingId('run.freshStart')], true, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    assert.deepEqual(Object.keys(parse(added) as object), ['upy-bridge.run.freshStart']);
  });
});
