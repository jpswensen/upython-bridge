// Drives the ISOLATED VS Code started by tools/vscode_test/screenshots.py through Playwright's Electron driver (DevTools
// protocol: no OS-level input, no screen recording) and saves Marketplace screenshots of its window. Every step is logged to
// <out>/steps.log. A failing step is logged and the remaining shots are still attempted; the window is always closed.
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const logFile = path.join(cfg.out, 'steps.log');
const t0 = Date.now();
const log = (msg) => fs.appendFileSync(logFile, `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wanted = (name) => cfg.only.length === 0 || cfg.only.includes(name);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

let app;
let page;

/** Save a PNG of the window, or of `clip` ({x, y, width, height} in CSS pixels, or a function returning one). */
async function shot(name, opts = {}) {
  if (!wanted(name)) { return; }
  await sleep(opts.settle ?? 700);
  const clip = typeof opts.clip === 'function' ? await opts.clip() : opts.clip;
  await page.screenshot({ path: path.join(cfg.out, `${name}.png`), scale: 'css', ...(clip ? { clip } : {}) });
  log(`shot ${name}${clip ? ` clip ${JSON.stringify(clip)}` : ''}`);
}

/** The window from the top-left corner down to the bottom-right corner of `locator` (plus a margin): the sidebar stays in view. */
const toCornerOf = (locator, margin = 16) => async () => {
  const b = await locator.boundingBox();
  if (b === null) { return undefined; }
  return { x: 0, y: 0, width: Math.min(cfg.size.width, Math.ceil(b.x + b.width + margin)), height: Math.min(cfg.size.height, Math.ceil(b.y + b.height + margin)) };
};

/** Answer the dialogs and pickers of Set Up MicroPython IntelliSense with yes; photograph the import question once. */
async function setUpIntelliSense() {
  await command('Set Up MicroPython IntelliSense');
  let quiet = 0;
  for (let i = 0; i < 20 && quiet < 3; i++) {
    await sleep(1200);
    const dialog = page.locator('.monaco-dialog-box');
    if (await dialog.isVisible()) {
      quiet = 0;
      const text = await dialog.innerText();
      log(`  dialog: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
      if (/imports? (it|them) on the board once/.test(text)) {
        await page.mouse.move(700, 120);
        await shot('intellisense-consent', { clip: async () => {
          const b = await dialog.boundingBox();
          return b === null ? undefined : { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 24), width: b.width + 48, height: b.height + 48 };
        } });
      }
      const yes = dialog.locator('.monaco-button', { hasText: /^(Continue|Set up|Yes|OK|Apply)/ }).first();
      if (await yes.count()) { await yes.click(); } else { await dialog.locator('.monaco-button').last().click(); }
      continue;
    }
    const quick = page.locator('.quick-input-widget');
    if (await quick.isVisible()) {
      quiet = 0;
      log(`  quick pick: ${(await quick.innerText()).replace(/\s+/g, ' ').slice(0, 120)}`);
      await page.keyboard.press('Enter');
      continue;
    }
    quiet++;
  }
  await sleep(6000); // Pylance reads the generated configuration
  // close the setup's preview (an untitled Markdown document) without saving it
  for (let i = 0; i < 3; i++) {
    const tab = page.locator('.tabs-container .tab', { hasText: /Untitled|set up MicroPython/ }).first();
    if (!(await tab.count())) { break; }
    await tab.click();
    await command('View: Revert and Close Editor');
    await sleep(600);
  }
}

/** Run a command from the Command Palette by its title. */
async function command(title) {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(`>${title}`);
  await sleep(700);
  await page.keyboard.press('Enter');
  log(`command ${title}`);
}

/** Open a workspace file in an editor (Quick Open). */
async function openFile(name) {
  await page.keyboard.press(`${mod}+P`);
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(name);
  await sleep(800);
  await page.keyboard.press('Enter');
  await sleep(800);
}

async function dismissNotifications() {
  await command('Notifications: Clear All Notifications').catch(() => undefined);
  await sleep(300);
}

/** A row of the Files view by its label. */
const filesRow = (label) => page.locator('.pane .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${label.replace(/[.()]/g, '\\$&')}$`) }) }).first();

async function step(name, fn) {
  try {
    await fn();
    log(`ok   ${name}`);
  } catch (err) {
    log(`FAIL ${name}: ${String(err?.message ?? err).split('\n')[0]}`);
  }
}

async function main() {
  app = await electron.launch({ executablePath: cfg.code, args: cfg.args, env: cfg.env, timeout: 90000 });
  page = await app.firstWindow({ timeout: 90000 });
  log('window open');
  await app.evaluate(({ BrowserWindow }, size) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(size.width, size.height);
    w.center();
  }, cfg.size);
  await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
  await sleep(5000); // extension host and views settle

  if (cfg.details) {
    // a check, not a Marketplace image: the README rendered by VS Code's extension page from the INSTALLED VSIX (check-*.png
    // files go to the report folder, never to images/)
    await step('the extension details page renders the README with its images', async () => {
      await command('Extensions: Show Installed Extensions');
      const item = page.locator('.extensions-viewlet .monaco-list-row', { hasText: 'Python Bridge' }).first();
      await item.click({ timeout: 15000 });
      await sleep(4000);
      await shot('check-details-top');
      const frame = page.frameLocator('iframe.webview.ready').frameLocator('iframe#active-frame');
      const imgs = frame.locator('img');
      const n = await imgs.count().catch(() => -1);
      const loaded = n > 0 ? await imgs.evaluateAll((els) => els.map((e) => `${e.getAttribute('src')?.split('/').pop()}:${e.complete && e.naturalWidth > 0 ? 'loaded' : 'BROKEN'}`)) : [];
      log(`  README images in the details page: ${n} ${JSON.stringify(loaded)}`);
      await frame.locator('h2', { hasText: 'Keeping files in sync' }).scrollIntoViewIfNeeded().catch(() => undefined);
      await sleep(1000);
      await shot('check-details-sync');
    });
    return;
  }
  if (cfg.noFolder) {
    await step('the Open Folder welcome', async () => {
      await page.locator('.activitybar [aria-label*="uPy Bridge"]').first().click({ timeout: 15000 });
      await page.getByText(/needs that folder open/).first().waitFor({ state: 'visible', timeout: 15000 });
      await page.mouse.move(900, 400);
      await shot('open-folder', { clip: { x: 0, y: 0, width: 352, height: 300 } });
    });
    return;
  }
  await step('open the sidebar', async () => {
    await page.locator('.activitybar [aria-label*="uPy Bridge"]').first().click({ timeout: 15000 });
    await sleep(1500);
  });
  await step('connect from the Files view', async () => {
    await page.getByText(/^Connect to /).first().click({ timeout: 20000 });
  });
  await step('first-sync review', async () => {
    const dialog = page.locator('.monaco-dialog-box');
    await dialog.waitFor({ state: 'visible', timeout: 30000 });
    await page.mouse.move(700, 120);
    await shot('first-sync-review', { clip: toCornerOf(dialog) });
    await page.locator('.monaco-dialog-box .monaco-button', { hasText: /^Send my 2 new files to the board$/ }).click({ timeout: 10000 });
    await sleep(3000);
  });
  if (cfg.intellisense) {
    await step('set up IntelliSense from the board', async () => {
      await dismissNotifications();
      await setUpIntelliSense();
    });
  }
  await step('a program on the board changes calibration.json; Refresh compares again', async () => {
    fs.writeFileSync(path.join(cfg.boardRoot, 'calibration.json'), '{\n  "kp": 1.6,\n  "ki": 0.0,\n  "kd": 0.08,\n  "base_speed": 45\n}\n');
    await dismissNotifications();
    await command('uPy Bridge: Refresh Board Files');
    await sleep(3000);
  });
  await step('expand lib', async () => {
    await filesRow('lib').click({ timeout: 10000 });
    await sleep(1200);
  });
  await step('edit main.py without saving', async () => {
    await openFile('main.py');
    await page.keyboard.press(`${mod}+ArrowDown`);
    await page.keyboard.type('\n# tuned for the new track: base_speed 45 -> 50\n');
    await sleep(800);
  });
  await step('marks in the Files view', async () => {
    await page.mouse.move(700, 400);
    await shot('files-and-marks');
  });
  await step('hover help on a file that changed on the board', async () => {
    await filesRow('calibration.json').hover({ timeout: 10000 });
    const link = page.locator('a', { hasText: /Compare with the board's copy/ }).first();
    await link.waitFor({ state: 'visible', timeout: 10000 });
    await shot('hover-help', { settle: 900, clip: async () => {
      const b = await page.locator('.monaco-hover, .workbench-hover, .monaco-hover-content').filter({ has: link }).last().boundingBox();
      return { x: 0, y: 0, width: Math.min(cfg.size.width, Math.ceil((b ? b.x + b.width : 740) + 24)), height: Math.min(cfg.size.height, Math.ceil((b ? b.y + b.height : 390) + 24)) };
    } });
  });
  await step('compare with the board copy (link in the hover)', async () => {
    await page.locator('a', { hasText: /Compare with the board's copy/ }).first().click({ timeout: 10000 });
    await sleep(2500);
    await page.mouse.move(700, 600);
    await shot('compare', { clip: { x: 0, y: 0, width: cfg.size.width, height: 300 } });
  });
  await step('save main.py: auto-sync sends it', async () => {
    await openFile('main.py');
    await page.keyboard.press(`${mod}+S`);
    await sleep(3000);
  });
  await step('run main.py on the board', async () => {
    await dismissNotifications();
    await command('Run Current File on Board');
    await sleep(6000);
    await shot('run');
  });
  if (cfg.intellisense) {
    await step('completion for a module of the board firmware', async () => {
      await dismissNotifications();
      await command('View: Close Panel');
      await openFile('main.py');
      await page.keyboard.press('Control+G');           // Go to Line: the empty line 14, so the list opens below it
      await page.locator('.quick-input-widget input').waitFor({ state: 'visible', timeout: 10000 });
      await page.keyboard.type('14');
      await page.keyboard.press('Enter');
      await sleep(500);
      await page.keyboard.type('left.');
      await sleep(4000);
      await page.keyboard.press('Control+Space');
      await page.locator('.suggest-widget').waitFor({ state: 'visible', timeout: 15000 });
      await shot('intellisense', { settle: 1500, clip: { x: 350, y: 28, width: 900, height: 560 } });
      await page.keyboard.press('Escape');
      await command('File: Revert File');
    });
  }
}

const guard = setTimeout(() => { log('guard: out of time'); void finish(4); }, (cfg.guardMs ?? 300000));
let finishing = false;
async function finish(code) {
  if (finishing) { return; }
  finishing = true;
  clearTimeout(guard);
  try {
    await Promise.race([app?.close(), sleep(15000).then(() => { throw new Error('the window did not close within 15 s'); })]);
  } catch (err) {
    log(`close: ${String(err?.message ?? err).split('\n')[0]}; killing it (screenshots.py also kills the process group)`);
    try { app?.process().kill('SIGKILL'); } catch { /* already gone */ }
  }
  process.exit(code);
}

main().then(() => finish(0), (err) => { log(`FATAL ${String(err?.stack ?? err)}`); void finish(1); });
