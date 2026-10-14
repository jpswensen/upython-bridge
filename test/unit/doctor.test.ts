/**
 * The Doctor: the report is a pure function of facts (tested with synthetic facts for every problem class), and the command
 * collects the facts from the vscode mock, the Python discovery and a session stub, and opens an untitled Markdown document.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import {
  buildDoctorReport, collectDoctorFacts, findShadowingFiles, registerDoctor, renderDoctorMarkdown, runDoctor, runStartupChecks,
  type DoctorDeps, type DoctorFacts,
} from '../../src/doctor';
import { COMMAND_IDS } from '../../src/contributes';
import { LEGACY, settingId } from '../../src/identity';
import { PythonDiscovery, type PythonResolution } from '../../src/python/discovery';
import { LearnedResetStore } from '../../src/session/learnedReset';
import type { HelloEvent } from '../../src/types/protocol';
import { initialSessionState, type SessionState } from '../../src/types/session';
import { MockMemento } from '../mocks/extensionContext';
import { FAKE_IDENTITY, FAKE_PORT_INFO } from '../mocks/fakeSession';
import { TempDirs, WINDOWS, makeTrickyDir } from '../mocks/fixtures';
import { createExtensionContext, mock } from '../mocks/vscode';
import { MemoryLog, HELLO } from './bridge/stubChild';
import { FakeFs, MAC, probeOk, scriptedExec } from './python/fakes';
import { SETTINGS } from './session/kit';
import fs from 'node:fs';
import path from 'node:path';

const dirs = new TempDirs();
beforeEach(() => mock.reset());
afterEach(() => {
  mock.reset();
  dirs.cleanup();
});

const goodPython: PythonResolution = {
  chosen: {
    launcher: { command: '/opt/homebrew/bin/python3', prefixArgs: [] }, executable: '/opt/homebrew/bin/python3.13', version: [3, 13, 13], versionText: '3.13.13',
    implementation: 'cpython', source: 'path', label: 'python3 on PATH', untested: false,
  },
  alternatives: [], rejected: [{ source: 'path', label: 'python on PATH', command: 'python', kind: 'not-found', message: '"python" was not found on PATH.' }],
  notes: [], failure: null, folder: '/Users/s/proj', trusted: true, platform: 'darwin', exhaustive: true, resolvedAt: 0, durationMs: 5,
};

function connectedState(over: Partial<SessionState> = {}): SessionState {
  return { ...initialSessionState(), bridge: 'ready', interpreter: 'ok', state: 'idle', port: '/dev/cu.usbserial-0001', portInfo: FAKE_PORT_INFO, sync: 'prompt', identity: FAKE_IDENTITY, ...over };
}

function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    generatedAt: '2026-10-13T08:00:00Z', extensionVersion: '0.1.0', os: 'darwin', osRelease: '24.6.0', vscodeVersion: '1.141.0',
    window: { remoteName: undefined, trusted: true, folder: '/Users/s/proj', folderIsLocal: true, folderCount: 1 },
    python: goodPython, bridge: { status: 'ok', hello: HELLO as unknown as HelloEvent },
    tooling: { pythonExtensionInstalled: true, envsExtensionInstalled: true, legacyActivateEnvironment: undefined, envsAutoActivation: 'command' },
    legacyExtension: { enabled: false }, rootFiles: ['main.py', 'helpers.py', '.mpyignore'], boardModules: [],
    session: { state: connectedState(), selectedPort: '/dev/cu.usbserial-0001', remembered: null },
    reset: {
      capability: { soft: true, machine: { available: true, reason: 'Needs no control lines.' }, hard: { state: 'likely', method: 'rts-pulse', reason: 'CP210x on ESP32', basis: 'adapter' }, cacheKey: { vid: 1, pid: 2, uniqueId: null } },
      learned: [],
    },
    settings: [{ id: settingId('pythonPath'), value: '(empty: find Python automatically)' }, { id: settingId('autoSync'), value: 'ask' }],
    ...over,
  };
}

const items = (r: ReturnType<typeof buildDoctorReport>, title?: string) => r.sections.filter((s) => !title || s.title === title).flatMap((s) => s.items);

describe('buildDoctorReport (synthetic facts)', () => {
  it('a healthy setup has no problems and says so, with versions of everything that matters', () => {
    const r = buildDoctorReport(facts());
    assert.equal(r.errors, 0);
    assert.equal(r.warnings, 0);
    const md = renderDoctorMarkdown(r);
    assert.match(md, /everything looks fine/);
    assert.match(md, /Using Python 3\.13\.13/);
    assert.match(md, /version 1\.0-test, protocol 1/);
    assert.match(md, /pyserial: 3\.5/);
    assert.match(md, /mpremote: 1\.29\.0/);
    assert.match(md, /does not matter how VS Code was started/, 'PATH independence is explained');
    assert.match(md, /Reset with RTS\/DTR line: likely/);
    assert.match(md, /Connected to \/dev\/cu\.usbserial-0001/);
    assert.match(md, /Settings in effect/);
  });

  it('no Python: a problem with the advice from discovery, and the rejected candidates listed', () => {
    const py: PythonResolution = {
      ...goodPython, chosen: null,
      rejected: [
        { source: 'workspace-venv', label: 'the ".venv" virtual environment in this folder', command: '/p/.venv', kind: 'wrong-os', message: 'It was created on Windows.' },
        { source: 'path', label: 'python3 on PATH', command: '/usr/bin/python3', kind: 'macos-clt-shim', message: 'shortcut' },
      ],
      failure: { kind: 'none-found', message: 'Python 3.9 or newer was not found on this computer.', hint: 'Install Python from https://www.python.org/downloads/ (the macOS installer), then reload the VS Code window.' },
    };
    const r = buildDoctorReport(facts({ python: py, bridge: { status: 'failed', message: 'no working Python' } }));
    assert.equal(r.errors, 2);
    const md = renderDoctorMarkdown(r);
    assert.match(md, /\*\*PROBLEM\*\* Python 3\.9 or newer was not found/);
    assert.match(md, /What to do: Install Python from https:\/\/www\.python\.org/);
    assert.match(md, /\.venv.*\[\/p\/\.venv\]: It was created on Windows/);
    assert.match(md, /The helper that talks to the board could not start/);
  });

  it('warns about an untested Python version and about an interpreter inside a synced folder', () => {
    const chosen = { ...goodPython.chosen!, versionText: '3.10.9', version: [3, 10, 9] as [number, number, number], untested: true, executable: `${'/Users/s/Library/CloudStorage/OneDrive-Example University(email.example.edu)'}/Lab/.venv/bin/python` };
    const r = buildDoctorReport(facts({ python: { ...goodPython, chosen } }));
    const warns = items(r, 'Python').filter((i) => i.level === 'warn');
    assert.equal(warns.length, 2);
    assert.match(warns[0]?.text ?? '', /older than the tested versions/);
    assert.match(warns[1]?.text ?? '', /synced folder \(OneDrive\)/);
  });

  it('names the old extension, a remote window, a virtual folder and Restricted Mode, each with what to do', () => {
    const r = buildDoctorReport(facts({
      legacyExtension: { enabled: true, version: '0.3.2' },
      window: { remoteName: 'wsl', trusted: false, folder: null, folderIsLocal: false, folderCount: 0 },
    }));
    const texts = items(r).filter((i) => i.level === 'error' || i.level === 'warn');
    const joined = texts.map((i) => i.text).join('\n');
    assert.match(joined, new RegExp(LEGACY.extensionId.replace('.', '\\.')));
    assert.match(joined, /running remotely \(wsl\)/);
    assert.match(joined, /virtual workspace/);
    assert.match(joined, /Restricted Mode/);
    assert.match(joined, /No project folder is open/);
    assert.ok(texts.every((i) => (i.todo ?? '').length > 0), 'every problem says what to do');
  });

  it('flags student files that hide built-in modules (and ones the board reports), not ordinary files', () => {
    const found = findShadowingFiles(['time.py', 'Machine.PY', 'serial.py', 'main.py', 'my_time.py', 'acme.py', 'notes.txt', 'random.mpy', 'utils'], ['acme']);
    assert.deepEqual(found.map((f) => f.file), ['acme.py', 'Machine.PY', 'random.mpy', 'serial.py', 'time.py']);
    assert.equal(found[0]?.onBoardToo, true);
    const r = buildDoctorReport(facts({ rootFiles: ['time.py', 'main.py'] }));
    const w = items(r, 'Project folder').find((i) => i.level === 'warn');
    assert.match(w?.text ?? '', /time\.py/);
    assert.match(w?.todo ?? '', /Rename it/);
    assert.equal(items(r, 'Project folder').some((i) => /main\.py/.test(i.text)), false);
  });

  it('shows the selected port, adapter, identity and reset options; a selected but unplugged port is a warning', () => {
    const md = renderDoctorMarkdown(buildDoctorReport(facts()));
    assert.match(md, /Adapter: cp210x \(USB 10c4:ea60\)/);
    assert.match(md, /MicroPython 1\.29\.0/);
    assert.match(md, /Reboot board \(software\): available/);
    const down = buildDoctorReport(facts({ session: { state: { ...initialSessionState(), reason: 'unplugged' }, selectedPort: '/dev/cu.usbserial-0001', remembered: null }, reset: { capability: null, learned: [] } }));
    const w = items(down, 'Board').find((i) => i.level === 'warn');
    assert.match(w?.text ?? '', /not connected \(unplugged\)/);
    assert.match(w?.todo ?? '', /Select Serial Port/);
    const none = buildDoctorReport(facts({ session: { state: initialSessionState(), selectedPort: null, remembered: { device: 'COM3', vid: 0x1a86, pid: 0x7523 } }, reset: { capability: null, learned: [] } }));
    const md2 = renderDoctorMarkdown(none);
    assert.match(md2, /No serial port is selected/);
    assert.match(md2, /remembers COM3 \(USB 1a86:7523\)/);
  });

  it('reports the Python Environments and terminal activation settings and whether the REPL tab can see activation text', () => {
    const exposed = items(buildDoctorReport(facts({ tooling: { pythonExtensionInstalled: true, envsExtensionInstalled: true, legacyActivateEnvironment: true, envsAutoActivation: 'command' } })), 'VS Code');
    const t = exposed.find((i) => /activation/i.test(i.text));
    assert.match(t?.text ?? '', /REPL tab drops such lines/);
    assert.ok(t?.detail?.some((d) => /python-envs\.terminal\.autoActivationType = command/.test(d)));
    assert.match(t?.todo ?? '', /python\.terminal\.activateEnvironment/);
    const safe = items(buildDoctorReport(facts({ tooling: { pythonExtensionInstalled: true, envsExtensionInstalled: false, legacyActivateEnvironment: false, envsAutoActivation: undefined } })), 'VS Code');
    assert.match(safe.find((i) => /activation/i.test(i.text))?.text ?? '', /gets no extra text/);
  });

  it('every warning and every problem in a pile of bad facts has a one-line "what to do"', () => {
    const bad = buildDoctorReport(facts({
      python: { ...goodPython, chosen: null, failure: { kind: 'store-stub', message: 'Only the Store shortcut.', hint: 'Install Python.' } },
      bridge: { status: 'failed', message: 'x' }, legacyExtension: { enabled: true },
      window: { remoteName: 'ssh-remote', trusted: false, folder: WINDOWS.workspace, folderIsLocal: true, folderCount: 2 },
      rootFiles: ['os.py', 'json.py'], session: { state: { ...initialSessionState(), reason: 'connect-failed' }, selectedPort: 'COM3', remembered: null },
    }));
    const problems = items(bad).filter((i) => i.level === 'error' || i.level === 'warn');
    assert.ok(problems.length >= 6);
    for (const p of problems) {
      assert.ok((p.todo ?? '').length > 0 && !(p.todo ?? '').includes('\n'), p.text);
    }
    assert.equal(bad.errors + bad.warnings, problems.length);
  });
});

describe('the command', () => {
  function deps(over: { rules?: Parameters<typeof scriptedExec>[0]; session?: Partial<DoctorDeps['session']> } = {}): { deps: DoctorDeps; log: MemoryLog } {
    const log = new MemoryLog();
    const fsx = new FakeFs('posix').add('/opt/homebrew/bin/python3');
    const { exec } = scriptedExec(over.rules ?? { '/opt/homebrew/bin/python3': probeOk('/opt/homebrew/bin/python3.13') });
    const ctx = createExtensionContext();
    const discovery = new PythonDiscovery({ platform: MAC, fs: fsx, exec, log: log.logger, context: () => ({ folder: null, trusted: true, pythonPathSetting: '' }) });
    const session: DoctorDeps['session'] = {
      state: initialSessionState(), selectedPort: null, bridgeInfo: async () => HELLO as unknown as HelloEvent,
      resetCapability: async () => { throw new Error('not connected'); }, ...over.session,
    };
    return { deps: { context: ctx.vscode, log: log.logger, settings: SETTINGS, session, discovery, learned: new LearnedResetStore(new MockMemento()) }, log };
  }

  it('is registered under the declared id and opens the report as an untitled Markdown document', async () => {
    const { deps: d } = deps();
    const subs = registerDoctor(d);
    assert.equal(subs.length, 1);
    await vscode.commands.executeCommand(COMMAND_IDS.doctor);
    assert.equal(mock.calls.showTextDocument.length, 1);
    assert.match(mock.calls.showTextDocument[0]?.uri ?? '', /^untitled:/);
    subs.forEach((x) => x.dispose());
  });

  it('collects the facts from VS Code, the discovery and the session', async () => {
    const root = dirs.make('upy-bridge-doctor');
    const folder = makeTrickyDir(root);
    fs.writeFileSync(path.join(folder, 'time.py'), 'x = 1\n');
    fs.writeFileSync(path.join(folder, 'main.py'), 'print(1)\n');
    mock.setWorkspaceFolders(folder);
    mock.addExtension(LEGACY.extensionId, { version: '0.3.2' }, true);
    mock.addExtension('ms-python.python', {}, true);
    mock.config.register('python.terminal.activateEnvironment', true);
    const { deps: d } = deps();
    const f = await collectDoctorFacts(d);
    assert.equal(f.window.folder, folder);
    assert.equal(f.legacyExtension.enabled, true);
    assert.equal(f.legacyExtension.version, '0.3.2');
    assert.deepEqual(f.rootFiles.sort(), ['main.py', 'time.py']);
    assert.equal(f.python?.chosen?.versionText, '3.13.13');
    assert.equal(f.bridge.status, 'ok');
    assert.equal(f.tooling.pythonExtensionInstalled, true);
    assert.equal(f.tooling.legacyActivateEnvironment, true);
    assert.ok(f.settings.some((s) => s.id === settingId('autoSync') && s.value === 'ask'));
    const md = renderDoctorMarkdown(buildDoctorReport(f));
    assert.match(md, /time\.py/);
    assert.match(md, /turned on/);
  });

  it('shows a failure of the bridge or of Python as a report line, not as an exception', async () => {
    const { deps: d } = deps({ rules: {}, session: { bridgeInfo: async () => { throw new Error('should not be asked without Python'); } } });
    const f = await collectDoctorFacts(d);
    assert.equal(f.python?.chosen, null);
    assert.equal(f.bridge.status, 'failed');
    const { deps: d2 } = deps({ session: { bridgeInfo: async () => { throw new Error('helper broke'); } } });
    const f2 = await collectDoctorFacts(d2);
    assert.ok(f2.bridge.status === 'failed' && /helper broke/.test(f2.bridge.message));
  });

  it('reads the reset options only for a connected board', async () => {
    const calls: string[] = [];
    const { deps: d } = deps({ session: { state: connectedState(), selectedPort: '/dev/cu.x', resetCapability: async () => { calls.push('cap'); return facts().reset.capability!; } } });
    const f = await collectDoctorFacts(d);
    assert.deepEqual(calls, ['cap']);
    assert.equal(f.reset.capability?.soft, true);
    const { deps: d2 } = deps();
    assert.equal((await collectDoctorFacts(d2)).reset.capability, null);
  });

  it('runDoctor opens the document; a crash is logged and shown as one message', async () => {
    const { deps: d } = deps();
    const report = await runDoctor(d);
    assert.ok(report);
    assert.equal(mock.calls.showTextDocument.length, 1);
    const bad = deps({ session: { bridgeInfo: async () => HELLO as unknown as HelloEvent } });
    bad.deps.discovery.resolve = async () => { throw new Error('discovery exploded'); };
    const r2 = await runDoctor(bad.deps);
    assert.ok(r2, 'a Python check that throws is a report line');
    assert.match(renderDoctorMarkdown(r2), /Python could not be checked: discovery exploded/);
  });

  it('startup check: the old extension being on is a warning with a button that opens the Doctor', async () => {
    const { deps: d, log } = deps();
    assert.deepEqual(await runStartupChecks(d), []);
    mock.addExtension(LEGACY.extensionId, {}, true);
    const problems = await runStartupChecks({ log: log.logger });
    assert.deepEqual(problems, ['legacy-extension']);
    assert.match(mock.messages('warn').map((m) => m.message).join('\n'), /older extension/);
  });
});
