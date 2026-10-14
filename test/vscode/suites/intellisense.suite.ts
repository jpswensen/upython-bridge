/**
 * S-04 and RQ-GEN-3 in a REAL VS Code with the REAL Pylance (started with --with-python-extensions by tools/vscode_test/launch.py).
 * The workspace is a made-up "acme" project: student.py / wrong.py / bad.py and the student's own lib/acme_extra.py. The custom
 * modules live ON THE FAKE BOARD (tools/vscode_test/launch.py acme_board_profile: frozen package acme with motor/pins/extra, frozen
 * acme_extra, C module _acme, /lib/helper.py); there is no firmware folder on the computer. The setup learns them through the
 * bridge (introspect.modules, fs.list, fs.get) and soft-resets once after importing them. Modal questions cannot be answered from
 * a host test, so the answers come from the scripted prompter of the test hook.
 *
 * What is asserted (a)-(c) and what is only recorded as evidence (the notes in results.json):
 *   (a) the generated stubPath shadows the standard library `time` (sleep_ms resolves into .upy-bridge/stubs/active/time.pyi)
 *   (b) the board's frozen package, its submodules, its C module and the copy of /lib/helper.py resolve; no squiggles inside them
 *   (c) `extends` of the relative generated file is honoured by Pylance (the unresolved imports disappear), the misspelled members
 *       in wrong.py (acme.Motr, acme.Motor(1).gainz) ARE flagged
 */
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { FIX_TITLE, REPORT_TITLE } from '../../../src/commands/intellisenseQuickFix';
import type { SuiteDef } from '../runner';
import {
  api, assert, COMMAND_IDS, definitionAt, describeDiags, diagnosticsOf, ensureConnected, hoverAt, importProblems, openBackground, openFile, quickFixTitles, read, sleep,
  waitFor, waitForDiagnostics, wsFile,
} from '../util';

const PYLANCE = 'ms-python.vscode-pylance';
const STUDENT = wsFile('student.py');
const WRONG = wsFile('wrong.py');
const BAD = wsFile('bad.py');
const unresolved = (file: string): string[] => diagnosticsOf(file).filter((d) => d.code === 'reportMissingImports').map((d) => d.message.match(/"([^"]+)"/)?.[1] ?? d.message);

export const intellisense: SuiteDef = {
  name: 'intellisense',
  define(s) {
    s.test('the extension is active and Pylance is installed', async (t) => {
      const ext = vscode.extensions.getExtension(PYLANCE);
      assert.ok(ext, 'Pylance is installed in this profile (--with-python-extensions)');
      t.note(`Pylance ${String((ext.packageJSON as { version?: string }).version)}`);
      const hook = await api();
      hook.intellisense.script({ offer: 'later', consent: { createUserConfig: true }, importModules: 'continue' });
      assert.ok(fs.existsSync(wsFile('lib', 'acme_extra.py')), 'the student\'s own acme_extra is in lib/');
      assert.equal(fs.existsSync(wsFile('.upy-bridge')), false, 'nothing is set up yet');
      assert.equal(fs.existsSync(wsFile('pyrightconfig.json')), false);
    }, 60_000);

    s.test('BEFORE: Pylance flags the board\'s modules and machine as unresolved', async (t) => {
      await openFile('student.py');
      await openBackground(WRONG);
      await openBackground(BAD);
      await waitForDiagnostics(STUDENT, (ds) => ds.filter((d) => d.code === 'reportMissingImports').length >= 4, 'Pylance to report the unresolved imports of student.py', 120_000);
      const missing = unresolved(STUDENT);
      t.note(`student.py unresolved imports: ${missing.join(', ')}`);
      t.note(`student.py diagnostics before: ${describeDiags(diagnosticsOf(STUDENT))}`);
      for (const m of ['machine', '_acme', 'acme', 'helper']) assert.ok(missing.includes(m), `${m} is reported as unresolved before the setup`);
      // Pylance's own default typeCheckingMode is "off", where reportAttributeAccessIssue is not reported: recorded, not asserted
      t.note(`time.sleep_ms is flagged before the setup (default typeCheckingMode): ${diagnosticsOf(STUDENT).some((d) => d.code === 'reportAttributeAccessIssue' && /sleep_ms/.test(d.message))}`);
    }, 150_000);

    s.test('RQ-GEN-3: the real light bulb offers the setup on a real Pylance diagnostic', async (t) => {
      const line = diagnosticsOf(STUDENT).find((d) => d.code === 'reportMissingImports')?.line ?? 1;
      const titles = await quickFixTitles(STUDENT, line);
      t.note(`quick fixes on line ${line}: ${titles.join(' | ')}`);
      assert.ok(titles.includes(FIX_TITLE), `"${FIX_TITLE}" is among the quick fixes`);
      assert.ok(!titles.includes(REPORT_TITLE), 'the report is not offered before the setup');
    }, 60_000);

    s.test('D-15: the first successful connect makes the offer once (never modal, never blocking)', async (t) => {
      const hook = await api();
      assert.equal(hook.intellisense.calls().offers, 0);
      await ensureConnected(hook);
      await waitFor(() => hook.intellisense.calls().offers >= 1, 'the offer after the first connect', 20_000);
      await sleep(2500);
      t.note(`offers made: ${hook.intellisense.calls().offers}; board identity: ${JSON.stringify({ v: hook.state().identity?.version, platform: hook.state().identity?.platform })}`);
      assert.equal(hook.intellisense.calls().offers, 1, 'exactly one offer');
    }, 60_000);

    s.test('S-04 (a)-(c): the command reads the board (one question, one soft reset), writes the files and Pylance resolves everything', async (t) => {
      const hook = await api();
      const t0 = Date.now();
      await vscode.commands.executeCommand(COMMAND_IDS.fixIntelliSense);
      const run = hook.intellisense.lastRun();
      t.note(`outcome: ${JSON.stringify({ status: run?.status, asked: run?.asked, consent: run?.consent, board: run?.board, warnings: run?.warnings, errors: run?.errors })}`);
      assert.equal(run?.status, 'applied');
      assert.deepEqual([...(run?.asked ?? [])].sort(), ['create-user-config']);
      assert.deepEqual(hook.intellisense.calls().imports, [['_acme', 'acme']], 'one import question, naming only the custom modules');
      assert.ok(run?.board?.imported.includes('acme') && run.board.imported.includes('_acme') && !run.board.imported.includes('acme_extra'), 'the local acme_extra wins: never imported');
      assert.equal(run?.board?.softReset, true, 'one soft reset after the imports');
      for (const f of ['.upy-bridge/pyright.generated.json', '.upy-bridge/manifest.json', '.upy-bridge/stubs/active/machine.pyi', '.upy-bridge/stubs/active/time.pyi',
        '.upy-bridge/stubs/active/_acme.pyi', '.upy-bridge/stubs/active/acme/__init__.pyi', '.upy-bridge/stubs/active/acme/pins.pyi', '.upy-bridge/board-lib/helper.py', 'pyrightconfig.json']) {
        assert.ok(fs.existsSync(wsFile(...f.split('/'))), `${f} exists`);
      }
      assert.equal(fs.existsSync(wsFile('.upy-bridge', 'stubs', 'active', 'acme_extra.pyi')), false, 'no stub for a module the project has itself');
      t.note(`acme/__init__.pyi: ${read(wsFile('.upy-bridge', 'stubs', 'active', 'acme', '__init__.pyi')).replace(/\n/g, ' / ').slice(0, 900)}`);
      t.note(`pyright.generated.json: ${read(wsFile('.upy-bridge', 'pyright.generated.json')).replace(/\s+/g, ' ')}`);
      t.note(`pyrightconfig.json: ${read(wsFile('pyrightconfig.json')).replace(/\s+/g, ' ')}`);
      const preview = vscode.workspace.textDocuments.find((d) => d.languageId === 'markdown' && d.getText().includes('Will be written'));
      assert.ok(preview, 'the preview document was opened');
      assert.match(preview.getText(), /## What comes from your board/);
      assert.match(preview.getText(), /`helper` - file on the board \(\/lib\/helper\.py\)/);

      const after = await waitForDiagnostics(STUDENT, (ds) => ds.every((d) => !['reportMissingImports', 'reportMissingModuleSource', 'reportAttributeAccessIssue'].includes(d.code)), 'the import errors of student.py to disappear', 120_000);
      t.note(`student.py diagnostics after (${Math.round((Date.now() - t0) / 100) / 10} s after the command started): ${describeDiags(after)}`);
      await sleep(4000);
      assert.deepEqual(importProblems(STUDENT), [], 'still no import or attribute errors after 4 more seconds');
      // positive evidence that the new config was analysed (not just a cleared list): the wrong calls ARE flagged
      const wrong = await waitForDiagnostics(WRONG, (ds) => ds.filter((d) => d.code === 'reportAttributeAccessIssue').length >= 2, 'the misspelled members in wrong.py to be flagged', 60_000);
      t.note(`wrong.py diagnostics: ${describeDiags(wrong)}`);
      assert.ok(wrong.some((d) => d.code === 'reportAttributeAccessIssue' && /Motr/.test(d.message)), 'acme.Motr is flagged');
      assert.ok(wrong.some((d) => d.code === 'reportAttributeAccessIssue' && /gainz/.test(d.message)), 'acme.Motor(1).gainz is flagged');
      // (a) time.sleep_ms resolves into the generated stubPath, (b) the frozen package and the C module resolve, hover shows signatures
      const sleepDef = await definitionAt(STUDENT, 'sleep_ms');
      t.note(`(a) definition of time.sleep_ms: ${sleepDef.join(', ')}`);
      assert.ok(sleepDef.some((d) => d.includes('.upy-bridge') && d.includes('time.pyi')), 'time.sleep_ms resolves into .upy-bridge/stubs/active/time.pyi');
      const pinDef = await definitionAt(STUDENT, 'Pin(pins');
      t.note(`machine.Pin definition: ${pinDef.join(', ')}; hover: ${(await hoverAt(STUDENT, 'Pin(pins')).replace(/\s+/g, ' ').slice(0, 200)}`);
      assert.ok(pinDef.some((d) => d.includes('machine.pyi')), 'machine.Pin resolves into the stock stub');
      const motorDef = await definitionAt(STUDENT, 'Motor(1)');
      t.note(`(b) definition of the frozen acme.Motor: ${motorDef.join(', ')}`);
      assert.ok(motorDef.some((d) => d.includes('.upy-bridge') && d.includes('__init__.pyi')), 'acme.Motor resolves into the stub made from the board');
      const gainsHover = await hoverAt(STUDENT, 'gains(1', 1);
      t.note(`(b) hover on Motor.gains: ${gainsHover.replace(/\s+/g, ' ').slice(0, 240)}`);
      assert.match(gainsHover, /gains/);
      const cDef = await definitionAt(STUDENT, 'set_speed(1', 1);
      t.note(`(b) definition of _acme.set_speed: ${cDef.join(', ')}`);
      assert.ok(cDef.some((d) => d.includes('.upy-bridge') && d.includes('_acme.pyi')), 'the C module function resolves into the stub made from the board');
      const pinsDef = await definitionAt(STUDENT, 'MOT1', 1);
      t.note(`(b) definition of acme.pins.MOT1: ${pinsDef.join(', ')}`);
      assert.ok(pinsDef.some((d) => d.includes('pins.pyi')), 'acme.pins.MOT1 resolves into the submodule stub');
      const helperHover = await hoverAt(STUDENT, 'blink(2', 1);
      t.note(`(b) hover on helper.blink (copy of the board's /lib/helper.py): ${helperHover.replace(/\s+/g, ' ').slice(0, 240)}`);
      assert.match(helperHover, /times: int/, 'the real signature from the board file');
    }, 280_000);

    s.test('S-04 (b): no squiggles inside the generated stubs even when they are open (the ignore list works)', async (t) => {
      const machine = wsFile('.upy-bridge', 'stubs', 'active', 'machine.pyi');
      const acme = wsFile('.upy-bridge', 'stubs', 'active', 'acme', '__init__.pyi');
      const helper = wsFile('.upy-bridge', 'board-lib', 'helper.py');
      const doc = await openBackground(machine);
      await openBackground(acme);
      await openBackground(helper);
      await sleep(8000);
      t.note(`machine.pyi diagnostics: ${describeDiags(diagnosticsOf(machine))}; acme/__init__.pyi: ${describeDiags(diagnosticsOf(acme))}; board-lib/helper.py: ${describeDiags(diagnosticsOf(helper))}; machine.pyi lines: ${doc.lineCount}`);
      assert.deepEqual(diagnosticsOf(machine), [], 'no diagnostics inside machine.pyi');
      assert.deepEqual(diagnosticsOf(acme), [], 'no diagnostics inside the stub made from the board');
      assert.deepEqual(diagnosticsOf(helper), [], 'no diagnostics inside the copy of the board file');
    }, 60_000);

    s.test('RQ-GEN-3: a diagnostic that stays after the setup gets the Doctor report, not the setup again', async (t) => {
      const bad = await waitForDiagnostics(BAD, (ds) => ds.some((d) => d.code === 'reportMissingImports'), 'bad.py to keep its unresolved import', 60_000);
      const titles = await quickFixTitles(BAD, bad.find((d) => d.code === 'reportMissingImports')?.line ?? 1);
      t.note(`quick fixes on bad.py after the setup: ${titles.join(' | ')}`);
      assert.ok(titles.includes(REPORT_TITLE), `"${REPORT_TITLE}" is offered`);
      assert.ok(!titles.includes(FIX_TITLE), 'the setup is not offered a second time');
    }, 90_000);

    s.test('Doctor: the IntelliSense section describes the folder', async (t) => {
      await vscode.commands.executeCommand(COMMAND_IDS.doctor);
      const doc = await waitFor(() => vscode.workspace.textDocuments.find((d) => d.languageId === 'markdown' && d.getText().includes('## MicroPython IntelliSense')), 'the Doctor report', 60_000);
      const text = doc.getText();
      const part = text.slice(text.indexOf('## MicroPython IntelliSense'), text.indexOf('## ', text.indexOf('## MicroPython IntelliSense') + 5));
      t.note(part.replace(/\n+/g, ' / ').slice(0, 900));
      assert.match(part, /Import checking is provided by Pylance/);
      assert.match(part, /All \d+ files made by the setup are in place/);
      assert.match(part, /extends the generated file/);
      assert.match(part, /Modules of your board \(ACME_BOARD, MicroPython 1\.29\.0/);
    }, 90_000);

    s.test('a second run says everything is set up and does not rewrite the generated config', async () => {
      const hook = await api();
      const file = wsFile('.upy-bridge', 'pyright.generated.json');
      const before = fs.statSync(file).mtimeMs;
      await vscode.commands.executeCommand(COMMAND_IDS.fixIntelliSense);
      assert.equal(hook.intellisense.lastRun()?.status, 'up-to-date');
      assert.equal(fs.statSync(file).mtimeMs, before, 'the generated file was not touched');
      assert.equal(hook.intellisense.calls().imports.length, 1, 'the import question was asked once for this firmware');
    }, 60_000);

    s.test('Remove: the confirmation lists the files and only what the extension made is deleted', async (t) => {
      const hook = await api();
      fs.writeFileSync(wsFile('mine.py'), 'x = 1\n');
      hook.intellisense.script({ confirmRemove: true });
      await vscode.commands.executeCommand(COMMAND_IDS.removeIntelliSense);
      t.note(`confirmation text: ${hook.intellisense.calls().removes[0]?.replace(/\n+/g, ' / ').slice(0, 400)}`);
      assert.equal(fs.existsSync(wsFile('.upy-bridge')), false);
      assert.equal(fs.existsSync(wsFile('pyrightconfig.json')), false, 'the untouched pyrightconfig.json created by the setup is removed');
      assert.ok(fs.existsSync(wsFile('mine.py')) && fs.existsSync(wsFile('student.py')), 'student files stay');
      await waitForDiagnostics(STUDENT, (ds) => ds.some((d) => d.code === 'reportMissingImports'), 'the imports to be unresolved again after Remove', 120_000);
    }, 160_000);
  },
};
