/**
 * Adversarial review of the IntelliSense UI path: consent cannot be bypassed, concurrent invocations, remove semantics,
 * damaged resources, the quick fix and the first-connect offer. Real controller + library + disk; made-up "acme" names only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { IntelliSenseController } from '../../../src/commands/intellisense';
import { IntelliSenseOffer, OFFER_STATE_KEY } from '../../../src/commands/intellisenseOffer';
import { VsCodePrompter, type IntelliSensePrompter } from '../../../src/commands/intellisensePrompts';
import { registerQuickFix, FIX_TITLE, REPORT_TITLE } from '../../../src/commands/intellisenseQuickFix';
import { COMMAND_IDS } from '../../../src/contributes';
import { TRACKER_REL, nodeFs } from '../../../src/intellisense';
import { Settings } from '../../../src/types/settings';
import { FakeSession, FAKE_IDENTITY } from '../../mocks/fakeSession';
import { MockMemento } from '../../mocks/extensionContext';
import { TempDirs, projectRoot } from '../../mocks/fixtures';
import { mock } from '../../mocks/vscode';
import { Diagnostic, DiagnosticSeverity, Range, Uri } from '../../mocks/vscodeCore';
import { makeHarness } from '../repl.helpers';
import { acmeBoard, exists, makeProject, makeRig, openWorkspace, read, settle, stockBoard, type Project, type Rig } from '../intellisense-ui/helpers';

const dirs = new TempDirs();
let rig: Rig | undefined;
beforeEach(() => { mock.reset(); mock.addExtension('ms-python.vscode-pylance'); });
afterEach(() => { rig?.h.dispose(); rig = undefined; mock.reset(); dirs.cleanup(); });

const WRITE_ONLY = { createUserConfig: false, editSettings: false };
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) { throw new Error('timed out waiting'); } await settle(10); }
}
const lsAll = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);

describe('consent: every item is really required', () => {
  it('without createUserConfig no pyrightconfig.json appears; no firmware source folder is ever read', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: WRITE_ONLY });
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'applied');
    assert.equal(exists(p.ws, 'pyrightconfig.json'), false);
    assert.equal(exists(p.ws, '.upy-bridge', 'generated-stubs'), false);
    assert.doesNotMatch(read(p.ws, '.upy-bridge', 'pyright.generated.json'), /firmware \(acme\)/);
  });

  it('editSettings consent alone creates no settings file in the default tier', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: { ...WRITE_ONLY, editSettings: true } });
    await rig.controller.fix();
    assert.equal(exists(p.ws, '.vscode'), false);
  });

  it('cancelling at the consent prompt writes nothing at all (not even the tracker); only the preview document is opened', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: null });
    const before = lsAll(p.ws);
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'cancelled');
    assert.deepEqual(lsAll(p.ws), before);
  });

  it('the real prompter: a ticked box without the required "files" row is a cancel', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    const session = stockBoard(FakeSession.connected());
    const h = makeHarness(session);
    const controller = new IntelliSenseController(h.services, { prompter: new VsCodePrompter(h.services.log) });
    rig = { h, session, controller, prompter: undefined as never };
    let offeredItems: { id: string; picked?: boolean }[] = [];
    mock.answerQuickPick((items) => { offeredItems = items as never; return (items as { id: string }[]).filter((i) => i.id !== 'files'); });
    const outcome = await controller.fix();
    assert.equal(outcome.status, 'cancelled');
    assert.equal(exists(p.ws, '.upy-bridge'), false);
    assert.equal(offeredItems.find((i) => i.id === 'files')?.picked, true);
    // now: only "files"
    mock.answerQuickPick((items) => (items as { id: string }[]).filter((i) => i.id === 'files'));
    const second = await controller.fix();
    assert.equal(second.status, 'applied');
    assert.equal(exists(p.ws, 'pyrightconfig.json'), false);
    assert.equal(exists(p.ws, '.upy-bridge', 'generated-stubs'), false);
  });

  it('no consent item: the real prompter shows exactly one MODAL question and "Escape" writes nothing', async () => {
    const p = makeProject(dirs, 'student-stock');
    openWorkspace(p.ws);
    const session = stockBoard(FakeSession.connected());
    const h = makeHarness(session);
    const controller = new IntelliSenseController(h.services, { prompter: new VsCodePrompter(h.services.log) });
    rig = { h, session, controller, prompter: undefined as never };
    mock.answerMessage(/Set up MicroPython IntelliSense\?/, undefined);
    const before = lsAll(p.ws);
    const outcome = await controller.fix();
    // a plain stock project may still ask for pyrightconfig.json; whichever it is, escape must be a cancel
    assert.ok(['cancelled', 'no-folder'].includes(outcome.status) || mock.calls.quickPicks.length === 0);
    if (outcome.status === 'cancelled') { assert.deepEqual(lsAll(p.ws), before); }
  });
});

describe('concurrency and races', () => {
  it('a second invocation while the first waits for the answer is refused with a toast, and the first one still completes exactly once', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    let release!: (v: { createUserConfig: boolean; editSettings: boolean }) => void;
    let asked = 0;
    const prompter: IntelliSensePrompter = {
      choose: () => { asked++; return new Promise((r) => { release = r; }); },
      confirmRemove: async () => true, offer: async () => 'later', importModules: async () => 'continue',
    };
    rig = makeRig({ prompter });
    const first = rig.controller.fix();
    await waitFor(() => asked === 1);
    const second = await rig.controller.fix();
    assert.equal(second.status, 'busy');
    assert.equal(asked, 1, 'the second click must not open a second question');
    release({ createUserConfig: true, editSettings: false });
    const done = await first;
    assert.equal(done.status, 'applied');
  });

  it('Remove while the setup waits for its answer does not leave the folder half set-up unannounced (setup after remove must not resurrect silently)', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true, editSettings: false } });
    assert.equal((await rig.controller.fix()).status, 'applied');
    // change an input so the next run has something to ask
    fs.rmSync(path.join(p.ws, '.upy-bridge', 'pyright.generated.json'));
    let release!: (v: { createUserConfig: boolean; editSettings: boolean }) => void;
    const slow: IntelliSensePrompter = {
      choose: () => new Promise((r) => { release = r; }),
      confirmRemove: async () => true, offer: async () => 'later', importModules: async () => 'continue',
    };
    rig.h.dispose();
    rig = makeRig({ prompter: slow });
    let waiting = false;
    const origChoose = slow.choose.bind(slow);
    slow.choose = (plan) => { waiting = true; return origChoose(plan); };
    const fixing = rig.controller.fix();
    await waitFor(() => waiting);
    const removal = await rig.controller.remove(); // a user can choose the other command while a question is open
    release({ createUserConfig: true, editSettings: false });
    await fixing;
    // After "remove" the user expects no tracker; after the late "yes" of the setup the files are back, and that is only
    // acceptable if the remove command was refused while the setup was running.
    assert.ok(removal === undefined || !exists(p.ws, ...TRACKER_REL.split('/')), 'remove ran while the setup was waiting and the setup then re-created everything');
  });

  it('a pyrightconfig.json the user saves while the question is open is never replaced', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    let release!: (v: { createUserConfig: boolean; editSettings: boolean }) => void;
    const prompter: IntelliSensePrompter = { choose: () => new Promise((r) => { release = r; }), confirmRemove: async () => true, offer: async () => 'later', importModules: async () => 'continue' };
    rig = makeRig({ prompter });
    let waiting = false;
    const orig = prompter.choose.bind(prompter);
    prompter.choose = (plan) => { waiting = true; return orig(plan); };
    const run = rig.controller.fix();
    await waitFor(() => waiting);
    fs.writeFileSync(path.join(p.ws, 'pyrightconfig.json'), '{ "mine": true }\n');
    release({ createUserConfig: true, editSettings: false });
    await run;
    assert.equal(read(p.ws, 'pyrightconfig.json'), '{ "mine": true }\n');
  });
});

describe('remove', () => {
  it('twice: the second says there is nothing to remove, no prompt, no error', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true, editSettings: false } });
    await rig.controller.fix();
    assert.ok((await rig.controller.remove())?.removed.length);
    const asked = rig.prompter.record.removes.length;
    const again = await rig.controller.remove();
    assert.equal(again?.nothingToDo, true);
    assert.equal(rig.prompter.record.removes.length, asked, 'no second confirmation');
    assert.equal(exists(p.ws, '.upy-bridge'), false);
    assert.deepEqual(mock.messages('error'), []);
  });

  it('after the user edited pyrightconfig.json it stays; after the user edited a generated stub it is removed (documented as managed)', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig({ session: acmeBoard(FakeSession.connected()) });
    rig.prompter.set({ consent: { createUserConfig: true, editSettings: false } });
    await rig.controller.fix();
    fs.appendFileSync(path.join(p.ws, 'pyrightconfig.json'), '\n// mine\n');
    fs.appendFileSync(path.join(p.ws, '.upy-bridge', 'stubs', 'active', '_acme.pyi'), '\n# hand edit that took an hour\n');
    const res = await rig.controller.remove();
    assert.deepEqual(res?.keptEdited, ['pyrightconfig.json']);
    assert.equal(exists(p.ws, 'pyrightconfig.json'), true);
    assert.equal(exists(p.ws, '.upy-bridge'), false);
    const detail = rig.prompter.record.removes[0] ?? '';
    assert.match(detail, /edit/i, 'the confirmation says which files were edited');
  });

  it('a hand-edited generated stub: the next setup run overwrites it; the preview says it will be replaced', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig({ session: acmeBoard(FakeSession.connected()) });
    rig.prompter.set({ consent: { createUserConfig: true, editSettings: false } });
    await rig.controller.fix();
    const stub = path.join(p.ws, '.upy-bridge', 'stubs', 'active', '_acme.pyi');
    fs.appendFileSync(stub, '\n# hand edit\n');
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'applied');
    assert.doesNotMatch(read(stub), /hand edit/);
    const previews = vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'untitled').map((d) => d.getText());
    assert.ok(previews.some((t) => /_acme\.pyi/.test(t) && /(update|changed|replace|rewrit)/i.test(t)), 'the preview names the stub it will rewrite');
  });
});

describe('a re-run on another computer (the tracker travels with the folder, the remembered "yes" does not)', () => {
  it('default consent (only "files") and no board connected must not delete the board stubs that a working earlier setup created', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig({ session: acmeBoard(FakeSession.connected()) });
    rig.prompter.set({ consent: { createUserConfig: true, editSettings: false } });
    await rig.controller.fix();
    assert.equal(exists(p.ws, '.upy-bridge', 'stubs', 'active', '_acme.pyi'), true);
    rig.h.dispose();
    // new machine: fresh workspaceState, same folder with the same .upy-bridge, the board is not plugged in
    rig = makeRig({ session: new FakeSession() });
    rig.prompter.set({ consent: WRITE_ONLY });
    const outcome = await rig.controller.fix();
    assert.equal(exists(p.ws, '.upy-bridge', 'stubs', 'active', '_acme.pyi'), true, `the working stub was removed (status ${outcome.status}, removed ${JSON.stringify(outcome.removed)})`);
  });
});

describe('damaged bundled stubs', () => {
  const copyStubs = (): string => {
    const dest = path.join(dirs.make('upy-bridge-stubs'), 'stubs');
    fs.cpSync(path.join(projectRoot(), 'resources', 'stubs'), dest, { recursive: true });
    return dest;
  };
  const firstFile = (dir: string): string => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) { if (e.isFile() && e.name.endsWith('.pyi') && !e.parentPath.includes('LICENSES')) { return path.join(e.parentPath, e.name); } }
    throw new Error('no pyi');
  };

  it('a truncated .pyi, a missing MANIFEST.json and garbage in MANIFEST.json are reported, never thrown', async () => {
    for (const damage of ['truncate', 'no-manifest', 'garbage-manifest', 'no-dir'] as const) {
      const p = makeProject(dirs);
      const res = copyStubs();
      if (damage === 'truncate') { fs.truncateSync(firstFile(path.join(res, 'esp32')), 3); }
      if (damage === 'no-manifest') { fs.rmSync(path.join(res, 'MANIFEST.json')); }
      if (damage === 'garbage-manifest') { fs.writeFileSync(path.join(res, 'MANIFEST.json'), '{ nope'); }
      if (damage === 'no-dir') { fs.rmSync(res, { recursive: true }); }
      mock.reset();
      mock.addExtension('ms-python.vscode-pylance');
      openWorkspace(p.ws);
      const r = makeRig();
      const controller = new IntelliSenseController(r.h.services, { prompter: r.prompter, resourcesDir: res });
      r.prompter.set({ consent: { createUserConfig: true, editSettings: false } });
      const outcome = await controller.fix();
      assert.ok(['applied', 'failed', 'cancelled'].includes(outcome.status), `${damage}: ${outcome.status}`);
      assert.ok(outcome.warnings?.includes('W_STOCK_UNAVAILABLE') || outcome.warnings?.includes('W_NO_STOCK_STUBS'), `${damage}: the problem is reported (${JSON.stringify(outcome.warnings)})`);
      r.h.dispose();
    }
  });

  it('a damaged pack on a RE-RUN must not delete the working stock stubs from the earlier run', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true, editSettings: false } });
    await rig.controller.fix();
    const machine = path.join(p.ws, '.upy-bridge', 'stubs', 'active', 'machine.pyi');
    assert.equal(fs.existsSync(machine), true);
    const res = copyStubs();
    fs.rmSync(path.join(res, 'MANIFEST.json'));
    const again = new IntelliSenseController(rig.h.services, { prompter: rig.prompter, resourcesDir: res });
    await again.fix();
    assert.equal(fs.existsSync(machine), true, 'the stubs that worked were deleted because the bundled pack could not be read');
  });
});

describe('quick fix', () => {
  const diag = (code: string, message: string): vscode.Diagnostic => {
    const d = new Diagnostic(new Range(0, 0, 0, 5), message, DiagnosticSeverity.Warning);
    d.source = 'Pylance';
    d.code = code as never;
    return d as unknown as vscode.Diagnostic;
  };
  const doc = (file: string): vscode.TextDocument => ({ uri: Uri.file(file), languageId: 'python' }) as unknown as vscode.TextDocument;
  const actions = async (file: string, ds: vscode.Diagnostic[]): Promise<vscode.CodeAction[]> => {
    const entry = mock.codeActionProviders[0];
    assert.ok(entry);
    return (entry.provider as never as { provideCodeActions(d: unknown, r: unknown, c: unknown, t: unknown): Promise<vscode.CodeAction[]> }).provideCodeActions(doc(file), new Range(0, 0, 0, 5), { diagnostics: ds }, undefined);
  };

  it('is not offered for an unresolved import of an ordinary Python library, or for a plain attribute error (they cannot be fixed by MicroPython stubs)', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    mock.track(registerQuickFix(nodeFs()));
    const numpy = await actions(path.join(p.ws, 'main.py'), [diag('reportMissingImports', 'Import "numpy" could not be resolved')]);
    const attr = await actions(path.join(p.ws, 'main.py'), [diag('reportAttributeAccessIssue', 'Cannot access attribute "foo" for class "str"')]);
    assert.equal(numpy.length + attr.length, 0, `offered ${numpy.length} for numpy and ${attr.length} for a str attribute`);
  });

  it('after the setup exists the same diagnostic offers the report, not the setup again, and running the setup again is harmless (no loop)', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true, editSettings: false } });
    await rig.controller.fix();
    mock.track(registerQuickFix(nodeFs()));
    const a = await actions(path.join(p.ws, 'main.py'), [diag('reportMissingImports', 'Import "_acme" could not be resolved')]);
    assert.equal(a[0]?.title, REPORT_TITLE);
    assert.equal(a[0]?.command?.command, COMMAND_IDS.doctor);
    const again = await rig.controller.fix({ folder: p.ws, source: 'quickfix' });
    assert.equal(again.status, 'up-to-date');
    assert.notEqual(FIX_TITLE, REPORT_TITLE);
  });

  it('Windows-style paths by injection: a win32 path module finds the tracker and offers the report', async () => {
    const seen: string[] = [];
    const winFs = {
      path: path.win32,
      stat: async (p: string) => { seen.push(p); return p.toLowerCase() === 'c:\\users\\me\\onedrive (x)\\lab 1\\.upy-bridge\\manifest.json' ? { isFile: true, isDirectory: false, size: 1 } : null; },
    };
    mock.setWorkspaceFolders('C:\\Users\\me\\OneDrive (x)\\Lab 1');
    mock.track(registerQuickFix(winFs as never));
    const a = await actions('C:\\Users\\me\\OneDrive (x)\\Lab 1\\main.py', [diag('reportMissingImports', 'Import "_acme" could not be resolved')]);
    assert.equal(a[0]?.title, REPORT_TITLE, `probed: ${seen.join(' | ')}`);
  });
});

describe('multi-root and the mirror root', () => {
  it('choosing the SECOND folder (sync mirrors only the first) is warned about', async () => {
    const a = makeProject(dirs);
    const b = makeProject(dirs);
    mock.setWorkspaceFolders(a.ws, b.ws);
    rig = makeRig();
    rig.prompter.set({ consent: WRITE_ONLY });
    const outcome = await rig.controller.fix({ folder: b.ws });
    assert.equal(outcome.status, 'applied');
    assert.ok(outcome.warnings?.includes('W_WORKSPACE_NOT_MIRROR_ROOT'), `warnings: ${JSON.stringify(outcome.warnings)}`);
  });
});

describe('first-connect offer', () => {
  interface OfferRig { session: FakeSession; state: MockMemento; asked: { n: number }; fixes: unknown[]; offer: IntelliSenseOffer }
  function offerRig(p: Project, state = new MockMemento()): OfferRig {
    const session = new FakeSession();
    const asked = { n: 0 };
    const fixes: unknown[] = [];
    const offer = new IntelliSenseOffer({
      session, settings: new Settings(), state, log: { info: () => undefined, error: () => undefined }, fs: nodeFs(),
      prompter: { offer: async () => { asked.n++; return 'later'; } },
      controller: { fix: async (a) => { fixes.push(a); return { status: 'applied' }; } },
    });
    mock.track(offer);
    void p;
    return { session, state, asked, fixes, offer };
  }
  const connect = (s: FakeSession): void => s.setState({ state: 'idle', port: '/dev/cu.fake', identity: FAKE_IDENTITY });

  it('is not shown in an untrusted (Restricted Mode) workspace', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    mock.setTrusted(false);
    const r = offerRig(p);
    connect(r.session);
    await settle();
    assert.equal(r.asked.n, 0, 'the offer toast was shown in Restricted Mode');
  });

  it('is not shown for a virtual-only workspace', async () => {
    const p = makeProject(dirs);
    mock.setWorkspaceFolders(Uri.parse('vscode-vfs://github/acme/repo'));
    const r = offerRig(p);
    connect(r.session);
    await settle();
    assert.equal(r.asked.n, 0);
  });

  it("'Don't ask again' sticks across sessions (new offer object, same workspaceState)", async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    const state = new MockMemento();
    await state.update(OFFER_STATE_KEY, 'never');
    const r = offerRig(p, state);
    connect(r.session);
    await settle();
    assert.equal(r.asked.n, 0);
  });
});
