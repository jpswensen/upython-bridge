/**
 * S-04 (d), (e), (f) in a REAL VS Code with the REAL Pylance: what happens when things are not in the ideal state. These tests
 * RECORD what Pylance does (the notes in results.json, and s04-pylance-log.json from the language server log); they assert only
 * what must hold for the product: the editor recovers after the command is run again, and Remove leaves no config behind.
 *   (d) pyrightconfig.json extends a generated file that does not exist yet (a template opened before the extension ran)
 *   (e) a workspace without pyrightconfig.json that only has settings (the fallback tier: typings/ + python.analysis.* settings)
 *   (f) a pyrightconfig.json with its own extraPaths ["lib"] next to the extends
 */
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { boardInfoFrom } from '../../../src/commands/intellisense';
import { nodeClock, nodeFs, runFix } from '../../../src/intellisense';
import type { SuiteDef } from '../runner';
import {
  api, assert, COMMAND_IDS, describeDiags, diagnosticsOf, ensureConnected, importProblems, openBackground, openFile, ourExtension, read, sleep, waitForDiagnostics, wsFile,
} from '../util';

const STUDENT = wsFile('student.py');
const WRONG = wsFile('wrong.py');
const LIBUSER = wsFile('libuser.py');
const unresolved = (file: string): string[] => diagnosticsOf(file).filter((d) => d.code === 'reportMissingImports').map((d) => d.message.match(/"([^"]+)"/)?.[1] ?? d.message);

/**
 * The student file with all imports resolved AND stable: an empty list can be a stale one (the language server has not yet looked
 * at the new config), so the list must stay free of import problems for 5 s in a row.
 */
async function waitResolved(t: { note(s: string): void }, what: string, timeoutMs = 120_000): Promise<void> {
  const t0 = Date.now();
  let cleanSince = 0;
  for (;;) {
    if (importProblems(STUDENT).length === 0) {
      if (cleanSince === 0) cleanSince = Date.now();
      if (Date.now() - cleanSince >= 5000) break;
    } else {
      cleanSince = 0;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`student.py did not become free of import problems within ${timeoutMs} ms (${what}); now: ${describeDiags(diagnosticsOf(STUDENT))}`);
    await sleep(250);
  }
  t.note(`${what}: resolved and stable after ${Math.round((cleanSince - t0) / 100) / 10} s`);
}

export const intellisenseSpikes: SuiteDef = {
  name: 'intellisense-spikes',
  define(s) {
    s.test('setup: the default layout is applied and Pylance resolves the acme modules', async (t) => {
      const hook = await api();
      hook.intellisense.script({ offer: 'later', consent: { createUserConfig: true }, importModules: 'continue', confirmRemove: true });
      await openFile('student.py');
      await openBackground(WRONG);
      await waitForDiagnostics(STUDENT, (ds) => ds.filter((d) => d.code === 'reportMissingImports').length >= 4, 'the unresolved imports before the setup', 120_000);
      await ensureConnected(hook);
      await vscode.commands.executeCommand(COMMAND_IDS.fixIntelliSense);
      assert.equal(hook.intellisense.lastRun()?.status, 'applied');
      await waitResolved(t, 'default layout');
    }, 280_000);

    s.test('S-04 (d): pyrightconfig.json extends a generated file that is missing (dot folder deleted, as after a fresh clone)', async (t) => {
      const hook = await api();
      const summary = (): string => `unresolved=[${unresolved(STUDENT).join(',')}] attribute/import problems=${describeDiags(importProblems(STUDENT)).slice(0, 260)}`;
      t.note(`(d) before deleting: ${summary()}`);
      assert.deepEqual(importProblems(STUDENT), []);
      fs.rmSync(wsFile('.upy-bridge'), { recursive: true, force: true });
      assert.ok(fs.existsSync(wsFile('pyrightconfig.json')), 'the user-owned config stays');
      let sleptMs = 0;
      for (const wait of [3000, 5000, 7000]) {
        await sleep(wait);
        sleptMs += wait;
        t.note(`(d) config not touched, +${sleptMs / 1000} s after deleting the dot folder: ${summary()}`);
      }
      const liveState = importProblems(STUDENT).length === 0 ? 'Pylance kept using the old resolution (the deleted extends target was not noticed while running)' : 'Pylance reports problems again without a restart';
      t.note(`(d) live deletion: ${liveState}`);
      // A fresh start sees the missing target: rewrite pyrightconfig.json with identical bytes so that Pylance re-reads its config
      fs.writeFileSync(wsFile('pyrightconfig.json'), read(wsFile('pyrightconfig.json')));
      for (const wait of [3000, 5000, 7000]) {
        await sleep(wait);
        t.note(`(d) config re-read (same bytes written), +${wait / 1000} s: ${summary()}`);
      }
      t.note(`(d) with the extends target missing and the config re-read: ${importProblems(STUDENT).length === 0 ? 'NO complaint (still resolved)' : `the editor shows complaint 2 again (${unresolved(STUDENT).join(', ') || 'attribute errors only'})`}`);
      // the Doctor says what is wrong
      await vscode.commands.executeCommand(COMMAND_IDS.doctor);
      const doc = vscode.workspace.textDocuments.filter((d) => d.languageId === 'markdown' && d.getText().includes('## MicroPython IntelliSense')).pop();
      const text = doc?.getText() ?? '';
      t.note(`(d) Doctor: ${text.slice(text.indexOf('## MicroPython IntelliSense'), text.indexOf('## ', text.indexOf('## MicroPython IntelliSense') + 5)).replace(/\n+/g, ' / ').slice(0, 700)}`);
      assert.match(text, /extends \.upy-bridge\/pyright\.generated\.json, but that file does not exist/);
      // recovery: the command creates the files again (the user config exists, so no consent for it is needed)
      await vscode.commands.executeCommand(COMMAND_IDS.fixIntelliSense);
      const run = hook.intellisense.lastRun();
      t.note(`(d) recovery run: ${JSON.stringify({ status: run?.status, asked: run?.asked, written: run?.written?.length })}`);
      assert.equal(run?.status, 'applied');
      assert.ok(fs.existsSync(wsFile('.upy-bridge', 'pyright.generated.json')));
      await waitResolved(t, 'after recovery');
    }, 290_000);

    s.test('S-04 (f): a pyrightconfig.json with its own extraPaths ["lib"] replaces the generated list', async (t) => {
      const hook = await api();
      // the default layout is in place and pyrightconfig.json exists (it is only edited below, never deleted: see (g))
      await vscode.commands.executeCommand(COMMAND_IDS.fixIntelliSense);
      assert.equal(hook.intellisense.lastRun()?.status, 'up-to-date');
      fs.mkdirSync(wsFile('lib'), { recursive: true });
      fs.writeFileSync(wsFile('lib', 'mylib.py'), 'def f() -> int:\n    return 1\n');
      fs.writeFileSync(LIBUSER, 'import mylib\n\nprint(mylib.f())\n');
      await openBackground(LIBUSER);
      await waitResolved(t, 'default layout again');
      await waitForDiagnostics(LIBUSER, (ds) => ds.every((d) => d.code !== 'reportMissingImports'), 'mylib to resolve through the generated lib root', 60_000);
      t.note('(f) with the default layout: mylib resolves through the generated extraPaths (lib is always listed)');
      const original = read(wsFile('pyrightconfig.json'));
      fs.writeFileSync(wsFile('pyrightconfig.json'), original.replace('"typeCheckingMode"', '"extraPaths": ["lib"],\n  "typeCheckingMode"'));
      t.note(`(f) pyrightconfig.json now: ${read(wsFile('pyrightconfig.json')).replace(/\s+/g, ' ')}`);
      await sleep(15_000);
      const left = unresolved(STUDENT);
      t.note(`(f) after 15 s: student.py unresolved=[${left.join(',')}]; libuser.py unresolved=[${unresolved(LIBUSER).join(',')}]`);
      t.note(`(f) the config extraPaths ${left.includes('acme') ? 'REPLACED' : 'did NOT replace'} the generated list (acme ${left.includes('acme') ? 'unresolved' : 'still resolved'}); mylib ${unresolved(LIBUSER).includes('mylib') ? 'unresolved' : 'resolves'}`);
      // the setup notices the override and says so (it does not touch the file)
      await vscode.commands.executeCommand(COMMAND_IDS.fixIntelliSense);
      const run = hook.intellisense.lastRun();
      t.note(`(f) rerun: ${JSON.stringify({ status: run?.status, warnings: run?.warnings })}`);
      assert.ok(run?.warnings?.includes('W_USER_CONFIG_OVERRIDES'), 'the plan warns that extraPaths in pyrightconfig.json replaces the generated value');
      assert.match(read(wsFile('pyrightconfig.json')), /"extraPaths": \["lib"\]/, 'the user file was not touched');
      // restore the file and check the editor recovers
      fs.writeFileSync(wsFile('pyrightconfig.json'), original);
      await waitResolved(t, 'after removing the override');
    }, 280_000);
    s.test('S-04 (e): without pyrightconfig.json the fallback tier works through typings/ and the python.analysis settings', async (t) => {
      const hook = await api();
      hook.intellisense.script({ confirmRemove: true });
      await vscode.commands.executeCommand(COMMAND_IDS.removeIntelliSense);
      // after (d) the tracker was rebuilt without the user-owned config (it existed already), so Remove rightly keeps it
      t.note(`(e) pyrightconfig.json after Remove: ${fs.existsSync(wsFile('pyrightconfig.json')) ? 'kept (not created by this setup run)' : 'removed'}`);
      fs.rmSync(wsFile('pyrightconfig.json'), { force: true });
      await waitForDiagnostics(STUDENT, (ds) => ds.some((d) => d.code === 'reportMissingImports'), 'the imports to be unresolved after Remove', 120_000);
      t.note(`(e) workspace settings before: ${read(wsFile('.vscode', 'settings.json')).replace(/\s+/g, ' ')}`);
      const identity = hook.state().identity;
      const result = await runFix(
        { fs: nodeFs(), clock: nodeClock() },
        {
          workspace: env().workspace, resourcesDir: ourExtension().extensionPath + '/resources/stubs', board: boardInfoFrom(identity),
          settings: { fallback: true }, consent: { editSettings: true },
        },
        { apply: true },
      );
      t.note(`(e) fallback run: ${result.plan.summary}`);
      assert.deepEqual(result.result?.errors, []);
      assert.ok(fs.existsSync(wsFile('typings', 'machine.pyi')), 'typings/ holds the stock stubs');
      t.note(`(e) workspace settings after: ${read(wsFile('.vscode', 'settings.json')).replace(/\s+/g, ' ').slice(0, 700)}`);
      await sleep(15_000);
      const left = unresolved(STUDENT);
      t.note(`(e) after 15 s: unresolved=[${left.join(',')}]; attribute/import problems: ${describeDiags(importProblems(STUDENT))}`);
      t.note(`(e) machine.Pin resolves: ${!left.includes('machine')}; time.sleep_ms flagged: ${importProblems(STUDENT).some((d) => /sleep_ms/.test(d.message))}; acme modules resolve (no board stubs in this direct library run): ${!left.includes('acme') && !left.includes('_acme') && !left.includes('helper')}`);
      t.note(`(e) wrong.py: ${describeDiags(diagnosticsOf(WRONG))}`);
      // clean up through the command: the tracker also lists typings/ and the two settings
      await vscode.commands.executeCommand(COMMAND_IDS.removeIntelliSense);
      assert.equal(fs.existsSync(wsFile('typings')), false, 'Remove deletes the typings/ it created');
      t.note(`(e) workspace settings after Remove: ${read(wsFile('.vscode', 'settings.json')).replace(/\s+/g, ' ').slice(0, 500)}`);
    }, 280_000);

    s.test('S-04 (g): a pyrightconfig.json that is re-created after it was deleted (recorded, not asserted)', async (t) => {
      const hook = await api();
      await sleep(10_000);
      assert.equal(fs.existsSync(wsFile('pyrightconfig.json')), false, 'the config was deleted in (e)');
      t.note(`(g) before the command: unresolved=[${unresolved(STUDENT).join(',')}]`);
      await vscode.commands.executeCommand(COMMAND_IDS.fixIntelliSense);
      assert.equal(hook.intellisense.lastRun()?.status, 'applied');
      assert.ok(fs.existsSync(wsFile('pyrightconfig.json')) && fs.existsSync(wsFile('.upy-bridge', 'pyright.generated.json')), 'both files are written');
      for (const wait of [5000, 10_000, 15_000]) {
        await sleep(wait);
        t.note(`(g) +${wait / 1000} s after re-creating pyrightconfig.json: unresolved=[${unresolved(STUDENT).join(',')}] problems=${importProblems(STUDENT).length}`);
      }
      t.note(`(g) Pylance ${importProblems(STUDENT).length === 0 ? 'DID pick up the re-created config file' : 'did NOT pick up the re-created config file within 30 s (a window reload is needed)'}`);
    }, 120_000);
  },
};

function env(): { workspace: string } {
  return { workspace: process.env.UPYBRIDGE_TEST_WS ?? '' };
}
