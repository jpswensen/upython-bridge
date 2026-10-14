/**
 * "Set Up MicroPython IntelliSense..." and "Remove ... IntelliSense Files..." (src/commands/intellisense.ts) against the mocked
 * vscode, a real temp folder with the made-up "acme" project and the real library: collect, plan, preview, consent, apply, toast.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { registerIntelliSenseCommands } from '../../../src/commands/intellisense';
import { COMMAND_IDS } from '../../../src/contributes';
import { settingId } from '../../../src/identity';
import { TRACKER_REL } from '../../../src/intellisense';
import { IntelliSenseController } from '../../../src/commands/intellisense';
import { ScriptedPrompter } from '../../../src/testApi';
import { FakeSession, FAKE_IDENTITY } from '../../mocks/fakeSession';
import { makeHarness } from '../repl.helpers';
import { TempDirs } from '../../mocks/fixtures';
import { mock } from '../../mocks/vscode';
import { exists, makeProject, makeRig, openWorkspace, openedDocuments, read, settle, stockBoard, type Rig } from './helpers';

const dirs = new TempDirs();
let rig: Rig;
beforeEach(() => mock.reset());
afterEach(() => {
  rig?.h.dispose();
  mock.reset();
  dirs.cleanup();
});

const execute = (arg?: unknown): Promise<unknown> => Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.fixIntelliSense, arg));
const infos = (): string[] => mock.messages('info').map((m) => m.message);

describe('Set Up MicroPython IntelliSense', () => {
  it('previews, asks for the exact consent, writes the files, and offers "Show what changed" without holding the command', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    registerIntelliSenseCommands(rig.controller).forEach((d) => mock.track(d));
    rig.prompter.set({ consent: { createUserConfig: true } });
    mock.answerMessage(/is set up/, 'Show what changed');

    const outcome = (await execute()) as { status: string; written: string[]; asked: string[] };
    await settle(20);

    assert.equal(outcome.status, 'applied');
    assert.deepEqual(rig.prompter.record.choose[0]?.asked.sort(), ['create-user-config']);
    assert.ok(exists(p.ws, '.upy-bridge', 'pyright.generated.json'));
    assert.ok(exists(p.ws, '.upy-bridge', 'stubs', 'active', 'machine.pyi'), 'the connected esp32 board gets the esp32 stubs');
    assert.equal(exists(p.ws, '.upy-bridge', 'generated-stubs'), false, 'no firmware source folder is ever read');
    assert.match(read(p.ws, 'pyrightconfig.json'), /"extends": "\.upy-bridge\/pyright\.generated\.json"/);
    assert.ok(exists(p.ws, ...TRACKER_REL.split('/')));
    const docs = openedDocuments();
    assert.ok(docs.some((d) => /Will be written/.test(d) && /Needs your yes/.test(d) && /Create pyrightconfig\.json/.test(d)), 'the preview lists what is written and the exact consent');
    assert.ok(docs.some((d) => /what changed/i.test(d)), 'the button opens the report');
    assert.match(infos().join('\n'), /MicroPython IntelliSense is set up \(\d+ files written\)/);
    assert.equal(mock.messages().every((m) => !m.modal), true, 'nothing modal in the scripted flow');
  });

  it('a second run says "Everything is already set up" and writes nothing', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true } });
    assert.equal((await rig.controller.fix()).status, 'applied');
    const before = fs.readFileSync(path.join(p.ws, 'pyrightconfig.json'), 'utf8');
    mock.reset();
    openWorkspace(p.ws);
    const again = await rig.controller.fix();
    assert.equal(again.status, 'up-to-date');
    assert.match(infos().join('\n'), /Everything is already set up/);
    assert.equal(rig.prompter.record.choose.length, 1, 'the second run asked nothing');
    assert.equal(read(p.ws, 'pyrightconfig.json'), before);
  });

  it('cancel writes nothing at all', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: null });
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'cancelled');
    assert.equal(exists(p.ws, '.upy-bridge'), false);
    assert.equal(exists(p.ws, 'pyrightconfig.json'), false);
    assert.ok(openedDocuments().some((d) => /Will be written/.test(d)), 'the preview was still shown');
  });

  it('picks stubs from the connected board, else the setting, else standard-library stubs only with a note', async () => {
    const p = makeProject(dirs, 'student-stock');
    openWorkspace(p.ws);
    rig = makeRig({ session: new FakeSession() }); // not connected
    rig.prompter.set({ consent: { createUserConfig: true } });
    await rig.controller.fix();
    assert.equal(exists(p.ws, '.upy-bridge', 'stubs', 'active', 'machine.pyi'), false, 'unknown board: standard library only');
    assert.ok(exists(p.ws, '.upy-bridge', 'stubs', 'active', 'array.pyi'), 'the standard library overlay is there');
    assert.match(openedDocuments().join('\n'), /Board: not connected, so only the standard MicroPython library stubs/);
    rig.h.dispose();

    mock.reset();
    openWorkspace(p.ws);
    mock.config.set(settingId('intellisenseStubs'), 'rp2');
    rig = makeRig({ session: new FakeSession() });
    rig.prompter.set({ consent: {} });
    await rig.controller.fix();
    assert.ok(exists(p.ws, '.upy-bridge', 'stubs', 'active', 'aioble'), 'the declared family (rp2) is used when no board is connected');
    assert.equal(exists(p.ws, '.upy-bridge', 'stubs', 'active', 'aioespnow.pyi'), false, 'and not the esp32 one');
  });

  it('waits for the identity of a board that is connected but not probed yet, instead of choosing stubs for "no board"', async () => {
    const p = makeProject(dirs, 'student-stock');
    openWorkspace(p.ws);
    const session = stockBoard(FakeSession.connected({ identity: null }));
    rig = makeRig({ session });
    rig.prompter.set({ consent: {} });
    const run = rig.controller.fix();
    await settle(50);
    session.setState({ identity: FAKE_IDENTITY });
    await run;
    assert.ok(exists(p.ws, '.upy-bridge', 'stubs', 'active', 'machine.pyi'), 'the esp32 stubs were chosen once the identity arrived');
  });

  it('gives up waiting for the identity after the limit and goes on with the standard library stubs', async () => {
    const p = makeProject(dirs, 'student-stock');
    openWorkspace(p.ws);
    const session = stockBoard(FakeSession.connected({ identity: null }));
    const h = makeHarness(session);
    const prompter = new ScriptedPrompter();
    prompter.set({ consent: {} });
    const controller = new IntelliSenseController(h.services, { prompter, identityWaitMs: 40 });
    rig = { h, session, controller, prompter };
    await controller.fix();
    assert.equal(exists(p.ws, '.upy-bridge', 'stubs', 'active', 'machine.pyi'), false);
    assert.ok(exists(p.ws, '.upy-bridge', 'stubs', 'active', 'array.pyi'));
  });

  it('in an untrusted folder the setup still works and no firmware or Python program is run on this computer', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    mock.setTrusted(false);
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true } });
    assert.equal((await rig.controller.fix()).status, 'applied');
    assert.ok(exists(p.ws, '.upy-bridge', 'pyright.generated.json'));
    assert.doesNotMatch(openedDocuments().join('\n'), /Restricted Mode/);
  });

  it('never touches an existing pyrightconfig.json or a pyproject.toml with [tool.pyright]', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    const mine = '{ "typeCheckingMode": "strict" }\n';
    fs.writeFileSync(path.join(p.ws, 'pyrightconfig.json'), mine);
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true } });
    await rig.controller.fix();
    assert.equal(read(p.ws, 'pyrightconfig.json'), mine, 'the user file is byte-identical');
    assert.match(openedDocuments().join('\n'), /does not extend/);
    assert.match(openedDocuments().join('\n'), /"extends": ".upy-bridge\/pyright.generated.json"/, 'the exact line to paste is shown');

    const q = makeProject(dirs);
    mock.reset();
    openWorkspace(q.ws);
    const toml = '[tool.pyright]\nstrict = ["x"]\n';
    fs.writeFileSync(path.join(q.ws, 'pyproject.toml'), toml);
    rig.h.dispose();
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true } });
    await rig.controller.fix();
    assert.equal(read(q.ws, 'pyproject.toml'), toml);
    assert.equal(exists(q.ws, 'pyrightconfig.json'), false, 'a second config file would silently win over [tool.pyright]');
  });

  it('with no folder open it explains what to do', async () => {
    rig = makeRig();
    const outcome = await rig.controller.fix();
    assert.equal(outcome.status, 'no-folder');
    assert.match(infos().join('\n'), /Open the folder that holds your MicroPython files/);
  });

  it('refuses a second run while one is in progress', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    let release: (v: undefined) => void = () => undefined;
    rig = makeRig();
    const gate = new Promise<undefined>((resolve) => { release = resolve; });
    rig.prompter.choose = async () => { await gate; return undefined; };
    const first = rig.controller.fix();
    await settle(30);
    assert.equal((await rig.controller.fix()).status, 'busy');
    release(undefined);
    assert.equal((await first).status, 'cancelled');
  });

  it('with several folders it asks which one; the quick-fix argument names it', async () => {
    const a = makeProject(dirs);
    const b = makeProject(dirs);
    mock.setWorkspaceFolders(a.ws, b.ws);
    rig = makeRig();
    rig.prompter.set({ consent: {} });
    mock.answerQuickPick((items) => (items as { folder: vscode.WorkspaceFolder }[]).find((i) => i.folder.uri.fsPath === b.ws));
    const outcome = await rig.controller.fix();
    assert.equal(outcome.folder, b.ws);
    assert.ok(exists(b.ws, '.upy-bridge'));
    assert.equal(exists(a.ws, '.upy-bridge'), false);
    assert.equal(mock.calls.quickPicks.length, 1);
    const named = await rig.controller.fix({ folder: path.join(a.ws, 'main.py') });
    assert.equal(named.folder, a.ws, 'a file path inside the folder selects it without asking');
    assert.equal(mock.calls.quickPicks.length, 1);
  });

  it('a failing write is reported (error toast with the cause), the rest is still written', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true } });
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.mkdirSync(path.join(p.ws, '.upy-bridge', 'pyright.generated.json')); // a folder where the file must go
    const outcome = await rig.controller.fix();
    assert.ok((outcome.errors?.length ?? 0) > 0);
    assert.match(mock.messages('error').map((m) => m.message).join('\n'), /only partly set up/);
    assert.ok(exists(p.ws, '.upy-bridge', 'stubs', 'active', 'machine.pyi'));
  });
});

describe('Remove IntelliSense files', () => {
  it('shows the list, deletes exactly what was created, keeps an edited pyrightconfig.json', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    rig.prompter.set({ consent: { createUserConfig: true } });
    await rig.controller.fix();
    fs.appendFileSync(path.join(p.ws, 'pyrightconfig.json'), '// my note\n');
    fs.writeFileSync(path.join(p.ws, 'mine.py'), 'x = 1\n');
    const result = await rig.controller.remove();
    assert.ok(result);
    assert.equal(exists(p.ws, '.upy-bridge'), false);
    assert.deepEqual(result.keptEdited, ['pyrightconfig.json']);
    assert.ok(exists(p.ws, 'pyrightconfig.json'));
    assert.ok(exists(p.ws, 'mine.py') && exists(p.ws, 'main.py'));
    assert.match(rig.prompter.record.removes[0] ?? '', /you edited it/);
    assert.match(infos().join('\n'), /pyrightconfig.json was kept because you changed it/);
  });

  it('declining the confirmation removes nothing; with nothing set up it says so', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    rig = makeRig();
    assert.equal((await rig.controller.remove())?.nothingToDo, true);
    assert.match(infos().join('\n'), /nothing to remove/);
    rig.prompter.set({ consent: { createUserConfig: true } });
    await rig.controller.fix();
    rig.prompter.set({ confirmRemove: false });
    assert.equal(await rig.controller.remove(), undefined);
    assert.ok(exists(p.ws, '.upy-bridge', 'pyright.generated.json'));
  });

  it('a damaged tracker removes nothing and tells the student', async () => {
    const p = makeProject(dirs);
    openWorkspace(p.ws);
    fs.mkdirSync(path.join(p.ws, '.upy-bridge'));
    fs.writeFileSync(path.join(p.ws, '.upy-bridge', 'manifest.json'), '{ not json');
    rig = makeRig();
    await rig.controller.remove();
    assert.match(mock.messages('warn').map((m) => m.message).join('\n'), /damaged/);
    assert.ok(exists(p.ws, '.upy-bridge', 'manifest.json'));
  });
});

