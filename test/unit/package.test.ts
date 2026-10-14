/**
 * What the VSIX contains (RQ-DIST-1). Two parts:
 *  1. the staging step (scripts/stage.mjs) against a fixture project full of junk, always run;
 *  2. the real out/<name>-<version>.vsix, listed from its zip directory. It is built by `npm run package`; this part is skipped
 *     when there is no VSIX, unless UPYBRIDGE_REQUIRE_VSIX=1 (the last step of `npm run verify`), which makes a missing file a failure.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { BUNDLE, isSkipped, ROOT_FILES, stageExtension } from '../../scripts/stage.mjs';
import { MEDIA } from '../../src/contributes';
import { TempDirs, projectRoot } from '../mocks/fixtures';
import { listZip, readZipEntry, type ZipEntry } from './zipList';

const dirs = new TempDirs();
afterEach(() => dirs.cleanup());

function write(root: string, rel: string, text = 'x'): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** The six artwork files of D-19 (src/contributes.ts MEDIA): the only files under media/. */
const ARTWORK: string[] = Object.values(MEDIA);

describe('staging the shipped files', () => {
  const fixture = (): string => {
    const root = dirs.make('upy-bridge-pkg');
    for (const f of ROOT_FILES) { write(root, f); }
    for (const f of [
      BUNDLE, `${BUNDLE}.map`, ...ARTWORK, 'media/.DS_Store',
      'bridge/mpy_bridge.py', 'bridge/server.py', 'bridge/__pycache__/server.cpython-313.pyc', 'bridge/.DS_Store', 'bridge/tests/test_x.py',
      'bridge/vendor/serial/__init__.py', 'bridge/vendor/serial/__pycache__/a.pyc', 'bridge/vendor/licenses/pyserial.txt', 'bridge/vendor/VENDOR.md',
      'resources/stubs/MANIFEST.json', 'resources/stubs/esp32/machine.pyi', 'resources/stubs/stdlib/os/__init__.pyi', 'resources/stubs/LICENSES/LICENSE-typeshed.txt',
      'resources/stubs/.DS_Store', 'resources/stubs/esp32/__pycache__/machine.pyc', 'resources/notes.log',
      'src/extension.ts', 'test/unit/a.test.ts', 'tests/test_link.py', 'docs/plan.md', 'tools/fakeboard.py', 'private/notes.txt', 'node_modules/ignore/index.js',
      'CLAUDE.md', 'plan.md', 'out/old.vsix',
    ]) { write(root, f); }
    return root;
  };

  it('copies exactly the allow-list: package files, bundle, media, bridge with vendor and licences, the stub packs', () => {
    const root = fixture();
    const files = stageExtension(root, path.join(dirs.make('upy-bridge-stage'), 'out'));
    assert.deepEqual(files, [
      'LICENSE', 'NOTICE', 'README.md', 'THIRD_PARTY_NOTICES', 'bridge/mpy_bridge.py', 'bridge/server.py',
      'bridge/vendor/VENDOR.md', 'bridge/vendor/licenses/pyserial.txt', 'bridge/vendor/serial/__init__.py',
      'dist/extension.js', ...ARTWORK.slice().sort(), 'package.json',
      'resources/stubs/LICENSES/LICENSE-typeshed.txt', 'resources/stubs/MANIFEST.json', 'resources/stubs/esp32/machine.pyi', 'resources/stubs/stdlib/os/__init__.pyi',
    ]);
  });

  it('skips caches, tests and editor junk by name', () => {
    assert.equal(isSkipped('__pycache__', true), true);
    assert.equal(isSkipped('tests', true), true);
    assert.equal(isSkipped('vendor', true), false);
    assert.equal(isSkipped('x.cpython-313.pyc', false), true);
    assert.equal(isSkipped('.DS_Store', false), true);
    assert.equal(isSkipped('server.py', false), false);
  });

  it('fails loudly, with the next step, when the bundle or a required file is missing', () => {
    const root = fixture();
    fs.rmSync(path.join(root, 'dist'), { recursive: true });
    assert.throws(() => stageExtension(root, path.join(dirs.make('upy-bridge-stage'), 'o')), /dist\/extension\.js is missing.*npm run build/);
    const root2 = fixture();
    fs.rmSync(path.join(root2, 'THIRD_PARTY_NOTICES'));
    assert.throws(() => stageExtension(root2, path.join(dirs.make('upy-bridge-stage'), 'o')), /THIRD_PARTY_NOTICES is missing/);
  });
});

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot(), 'package.json'), 'utf8')) as { name: string; version: string };
const vsix = path.join(projectRoot(), 'out', `${pkg.name}-${pkg.version}.vsix`);
const required = process.env.UPYBRIDGE_REQUIRE_VSIX === '1';
const vsixSkip = fs.existsSync(vsix) ? false : required ? false : `no ${path.relative(projectRoot(), vsix)} yet (run: npm run package)`;
const SIZE_BUDGET = 5 * 1024 * 1024;
const MEDIA_BUDGET = 24 * 1024; // media/ in the VSIX (scripts/check-size.mjs states the same limit)
const CODE_BUDGET = 2 * 1024 * 1024; // the VSIX without resources/stubs (scripts/check-size.mjs states the same limits)

describe('the VSIX', { skip: vsixSkip }, () => {
  let names: string[] = [];
  let entries: ZipEntry[] = [];
  const load = (): void => {
    assert.ok(fs.existsSync(vsix), `${vsix} is missing: run "npm run package"`);
    entries = listZip(vsix);
    names = entries.map((e) => e.name).filter((n) => !n.endsWith('/'));
  };
  const has = (rel: string): boolean => names.includes(`extension/${rel}`);
  const under = (prefix: string): string[] => names.filter((n) => n.startsWith(`extension/${prefix}`));

  it('exists and stays under the 5 MB budget', () => {
    load();
    assert.ok(fs.statSync(vsix).size < SIZE_BUDGET, `VSIX is ${fs.statSync(vsix).size} bytes`);
  });

  it('contains the stock stub packs, their manifest and licences, file for file as vendored (the IntelliSense setup reads them at run time)', () => {
    load();
    const stubsDir = path.join(projectRoot(), 'resources', 'stubs');
    const manifest = JSON.parse(fs.readFileSync(path.join(stubsDir, 'MANIFEST.json'), 'utf8')) as { packs: { id: string; files: number }[] };
    assert.ok(has('resources/stubs/MANIFEST.json'), 'resources/stubs/MANIFEST.json is in the VSIX');
    assert.ok(under('resources/stubs/LICENSES/').length >= 2, 'the stub licences are shipped');
    assert.ok(manifest.packs.length >= 7, 'the manifest lists the stdlib overlay and the port packs');
    for (const pack of manifest.packs) {
      const shipped = under(`resources/stubs/${pack.id}/`).filter((n) => n.endsWith('.pyi'));
      assert.equal(shipped.length, pack.files, `pack ${pack.id}: ${pack.files} stub files in MANIFEST.json, ${shipped.length} in the VSIX`);
    }
    assert.ok(has('resources/stubs/esp32/machine.pyi') && has('resources/stubs/stdlib/asyncio/__init__.pyi'), 'machine.pyi and the asyncio overlay are in the VSIX');
    const onDisk = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? onDisk(path.join(dir, e.name)) : e.isFile() ? 1 : 0), 0);
    assert.equal(under('resources/stubs/').length, onDisk(stubsDir), 'every vendored stub file is in the VSIX, and nothing else is');
  });

  it('keeps the code part (everything except resources/stubs) small, so the stubs cannot hide growth', () => {
    load();
    const stubs = entries.filter((e) => e.name.startsWith('extension/resources/stubs/')).reduce((n, e) => n + e.compressedSize, 0);
    assert.ok(fs.statSync(vsix).size - stubs < CODE_BUDGET, `code part is ${fs.statSync(vsix).size - stubs} bytes`);
  });

  it('README screenshots are relative images/*.png links that exist in the project, and stay out of the VSIX (https-only at publish)', () => {
    load();
    const readme = fs.readFileSync(path.join(projectRoot(), 'README.md'), 'utf8');
    const shown = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
    assert.ok(shown.length >= 5, 'the README shows the screenshots');
    for (const src of shown) {
      assert.match(src, /^images\/[a-z0-9-]+\.png$/, `${src}: relative, under images/, PNG (vsce rewrites it to the repository at publish; SVG is refused)`);
      assert.ok(fs.existsSync(path.join(projectRoot(), ...src.split('/'))), `${src} exists (tools/vscode_test/screenshots.py makes it)`);
    }
    const onDisk = fs.readdirSync(path.join(projectRoot(), 'images')).filter((n) => n.endsWith('.png')).map((n) => `images/${n}`).sort();
    assert.deepEqual(onDisk, [...new Set(shown)].sort(), 'images/ holds exactly the screenshots the README shows');
    assert.deepEqual(under('images/'), [], 'no screenshots in the VSIX: nothing could display them from there');
  });

  it('README in the VSIX loads the screenshots over https from the GitHub repository that package.json names', () => {
    load();
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot(), 'package.json'), 'utf8')) as { repository?: { url?: string } };
    const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(\.git)?$/.exec(pkg.repository?.url ?? '');
    assert.ok(repo, `package.json names a GitHub repository (${String(pkg.repository?.url)})`);
    const images = (md: string): string[] => [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
    const readme = names.find((n) => /^extension\/readme\.md$/i.test(n));
    assert.ok(readme, 'README is in the VSIX');
    const shipped = images(readZipEntry(vsix, readme).toString('utf8'));
    const project = images(fs.readFileSync(path.join(projectRoot(), 'README.md'), 'utf8'));
    assert.deepEqual(shipped, project.map((src) => `https://github.com/${repo[1]}/raw/HEAD/${src}`), 'vsce rewrote every screenshot link');
  });

  it('contains the bundle, the manifest, the documents and the legal notices', () => {
    load();
    for (const f of ['dist/extension.js', 'package.json', 'NOTICE', 'THIRD_PARTY_NOTICES']) { assert.ok(has(f), `${f} is in the VSIX`); }
    const notices = fs.readFileSync(path.join(projectRoot(), 'THIRD_PARTY_NOTICES'), 'utf8');
    assert.match(notices, /micropython-stubs[^\n]*MIT/);
    assert.match(notices, /typeshed/);
    assert.ok(names.some((n) => /^extension\/readme\.md$/i.test(n)), 'README is in the VSIX');
    assert.ok(names.some((n) => /^extension\/license(\.txt|\.md)?$/i.test(n)), 'LICENSE is in the VSIX');
    assert.ok(has(MEDIA.activityBar), 'the activity bar icon is in the VSIX');
  });

  it('ships exactly the six artwork files of D-19 under media/ and no other branding file', () => {
    load();
    assert.deepEqual(under('media/').sort(), ARTWORK.map((f) => `extension/${f}`).sort());
    const onDisk = fs.readdirSync(path.join(projectRoot(), 'media')).filter((n) => n !== '.DS_Store').map((n) => `media/${n}`).sort();
    assert.deepEqual(onDisk, ARTWORK.slice().sort(), 'media/ in the project holds the same six files (nothing else is parked there)');
    const mediaBytes = entries.filter((e) => e.name.startsWith('extension/media/')).reduce((n, e) => n + e.compressedSize, 0);
    assert.ok(mediaBytes < MEDIA_BUDGET, `media/ is ${mediaBytes} bytes in the VSIX (budget ${MEDIA_BUDGET}, scripts/check-size.mjs)`);
  });

  it('contains every file that package.json refers to (icon, activity bar, command icons)', () => {
    load();
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot(), 'package.json'), 'utf8')) as {
      icon: string;
      contributes: { viewsContainers: { activitybar: { icon: string }[] }; commands: { icon?: string | { light: string; dark: string } }[] };
    };
    const refs = new Set<string>([manifest.icon, ...manifest.contributes.viewsContainers.activitybar.map((c) => c.icon)]);
    for (const c of manifest.contributes.commands) {
      if (typeof c.icon === 'object') { refs.add(c.icon.light); refs.add(c.icon.dark); } else if (c.icon && !c.icon.startsWith('$(')) { refs.add(c.icon); }
    }
    for (const rel of refs) { assert.ok(has(rel), `${rel} is referenced by package.json and must be in the VSIX`); }
    assert.ok(refs.has(MEDIA.icon) && refs.has(MEDIA.trashDark), 'the references include the Marketplace icon and the danger icon');
  });

  it('contains the whole Python bridge with the vendored libraries and their licences', () => {
    load();
    for (const f of ['bridge/mpy_bridge.py', 'bridge/server.py', 'bridge/link.py', 'bridge/devfs.py', 'bridge/errors.py', 'bridge/resetcap.py', 'bridge/vendor/VENDOR.md']) {
      assert.ok(has(f), `${f} is in the VSIX`);
    }
    assert.ok(under('bridge/vendor/serial/').some((n) => n.endsWith('/serialutil.py')), 'pyserial is vendored');
    assert.ok(under('bridge/vendor/mpremote/').some((n) => n.endsWith('/main.py')), 'mpremote is vendored');
    assert.ok(under('bridge/vendor/licenses/').length >= 2, 'the vendored licences are shipped');
  });

  it('contains no sources, tests, docs, tools, private notes or dependencies', () => {
    load();
    const banned = /^extension\/(src|test|tests|docs|tools|private|scripts|node_modules|out)\//;
    assert.deepEqual(names.filter((n) => banned.test(n)), []);
    for (const f of ['plan.md', 'CLAUDE.md', 'tsconfig.json', 'package-lock.json', '.npmrc', '.vscodeignore']) {
      assert.ok(!has(f), `${f} must not be in the VSIX`);
    }
  });

  it('contains no compiled Python caches, source maps, TypeScript files or editor junk', () => {
    load();
    const junk = /(__pycache__|\.pyc$|\.pyo$|\.map$|\.ts$|\.DS_Store$|(^|\/)bridge\/(tests?|test)\/)/;
    assert.deepEqual(names.filter((n) => junk.test(n)), []);
  });

  it('has the bundle that package.json names as main, and a non-trivial size', () => {
    load();
    const main = JSON.parse(fs.readFileSync(path.join(projectRoot(), 'package.json'), 'utf8')).main as string;
    assert.ok(has(main.replace(/^\.\//, '')), `${main} is in the VSIX`);
    const bundle = entries.find((e) => e.name === 'extension/dist/extension.js');
    assert.ok(bundle && bundle.size > 50_000);
  });
});
