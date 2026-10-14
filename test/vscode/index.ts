/**
 * Entry of the extension-host tests (`--extensionTestsPath`). VS Code calls run() inside the extension host of the window that
 * the launcher opened (tools/vscode_test/launch.py); when the promise settles VS Code quits. run() ALWAYS resolves: failures are
 * in the results file (UPYBRIDGE_TEST_OUT), not in a rejected promise, so the window can never hang open because of a test.
 * Suites are chosen by UPYBRIDGE_TEST_SUITE: smoke, activation, views, flow (= views, flow), all (= activation, views, flow), python, coexist,
 * exitprobe (a diagnostic about helper processes at exit), intellisense and intellisense-spikes (real Pylance, made-up firmware project).
 */
import * as vscode from 'vscode';
import { runSuites, type SuiteDef } from './runner';
import { activation } from './suites/activation.suite';
import { coexist } from './suites/coexist.suite';
import { exitprobe } from './suites/exitprobe.suite';
import { flow } from './suites/flow.suite';
import { intellisense } from './suites/intellisense.suite';
import { intellisenseSpikes } from './suites/intellisenseSpikes.suite';
import { python } from './suites/python.suite';
import { smoke } from './suites/smoke.suite';
import { views } from './suites/views.suite';

// `flow` is always preceded by `views`: views lists the board root and so fills the Files view's listing cache, and the upload test
// in flow must show the file in a view that already holds an older listing (the stale-view bug of 2026-10-13). Running flow
// without that step used to pass only because nothing had been listed yet.
const SUITES: Record<string, readonly SuiteDef[]> = {
  smoke: [smoke],
  activation: [activation],
  views: [views],
  flow: [views, flow],
  all: [activation, views, flow],
  python: [python],
  coexist: [coexist],
  exitprobe: [exitprobe],
  intellisense: [intellisense],
  'intellisense-spikes': [intellisenseSpikes],
  'intellisense-all': [intellisense, intellisenseSpikes],
};

function facts(): Record<string, unknown> {
  return {
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    extensions: vscode.extensions.all
      .filter((e) => !e.packageJSON?.isBuiltin && !e.extensionPath.includes('/Contents/Resources/app/extensions'))
      .map((e) => ({ id: e.id, version: (e.packageJSON as { version?: string }).version, active: e.isActive, path: e.extensionPath })),
    builtinExtensionCount: vscode.extensions.all.filter((e) => e.extensionPath.includes('/Contents/Resources/app/extensions')).length,
    safeMode: process.env.MPY_SAFE_MODE,
    realPortSet: process.env.MPY_REAL_PORT !== undefined,
  };
}

export async function run(): Promise<void> {
  const outFile = process.env.UPYBRIDGE_TEST_OUT;
  if (!outFile) {
    throw new Error('UPYBRIDGE_TEST_OUT is not set: start this through tools/vscode_test/launch.py');
  }
  const requested = process.env.UPYBRIDGE_TEST_SUITE ?? 'smoke';
  const defs = SUITES[requested];
  if (!defs) {
    throw new Error(`unknown suite "${requested}"; choose one of ${Object.keys(SUITES).join(', ')}`);
  }
  const guardMs = Number(process.env.UPYBRIDGE_TEST_GUARD_MS ?? '150000');
  await runSuites(defs, { outFile, requested, guardMs: Number.isFinite(guardMs) ? guardMs : 150_000, facts });
  if (process.env.UPYBRIDGE_TEST_QUIT === 'command') {
    // Close the window the way a student does (Quit through the workbench: deactivate, extension host terminate). The results
    // file is already written; if the window has not closed after 25 s the normal test exit below takes over.
    void vscode.commands.executeCommand('workbench.action.quit');
    await new Promise<void>((resolve) => setTimeout(resolve, 25_000));
  }
}
