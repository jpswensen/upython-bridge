/**
 * The Doctor: "Check My Setup". `buildDoctorReport` turns collected facts into a report (pure, unit-tested with synthetic
 * facts), `renderDoctorMarkdown` prints it, `collectDoctorFacts` gathers the facts from VS Code, the Python discovery and the
 * session, and `registerDoctor` opens the result in an untitled Markdown document. Every problem line carries a one-line
 * "What to do". It starts the bridge (that opens no port) and may read the reset capability of a connected board; it never
 * connects, resets or writes anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import * as vscode from 'vscode';
import { COMMAND_IDS, SETTINGS, type SettingKey } from './contributes';
import { IDENTITY, LEGACY, settingId } from './identity';
import { nodeFs } from './intellisense';
import { gatherIntelliSenseHealth, type IntelliSenseHealth } from './intellisense/health';
import { boardModuleLine } from './intellisense/preview';
import type { Logger } from './log';
import type { PythonDiscovery, PythonResolution } from './python/discovery';
import { classifyCloudPath } from './python/platform';
import type { LearnedEntry, LearnedResetStore } from './session/learnedReset';
import { showToast } from './toast';
import type { HelloEvent, ResetCapability } from './types/protocol';
import { userMessage, type SessionState } from './types/session';
import type { MpySettings, RememberedPort, SettingsReader } from './types/settings';

// ------------------------------------------------------------------ facts (the input of the pure part)

export type BridgeFact = { status: 'ok'; hello: HelloEvent } | { status: 'failed'; message: string } | { status: 'not-checked' };

export interface ResetFact {
  capability: ResetCapability | null;
  error?: string;
  learned: LearnedEntry[];
}

/** What the Doctor knows about MicroPython IntelliSense: the folder's files (pure facts) plus what VS Code says about the language server. */
export interface IntelliSenseFact {
  /** Null when no local folder is open. */
  health: IntelliSenseHealth | null;
  servers: { pylance: boolean; pythonExtension: boolean; basedpyright: boolean; pyright: boolean };
  /** `python.analysis.stubPath/extraPaths/typeCheckingMode` values the user set (any scope): a config file makes the language server ignore them. */
  overrides: { key: string; scope: 'user' | 'workspace' | 'folder'; value: unknown }[];
}

export interface DoctorFacts {
  generatedAt: string;
  extensionVersion: string;
  os: NodeJS.Platform;
  osRelease: string;
  vscodeVersion: string;
  window: {
    remoteName: string | undefined;
    trusted: boolean;
    folder: string | null;
    /** false for virtual workspaces (a folder that is not on this computer's disk). */
    folderIsLocal: boolean;
    folderCount: number;
  };
  python: PythonResolution | null;
  pythonError?: string;
  bridge: BridgeFact;
  tooling: {
    pythonExtensionInstalled: boolean;
    envsExtensionInstalled: boolean;
    /** `python.terminal.activateEnvironment`; undefined when the Python extension is not installed. */
    legacyActivateEnvironment: boolean | undefined;
    /** `python-envs.terminal.autoActivationType`; undefined when the Python Environments extension is not installed. */
    envsAutoActivation: string | undefined;
  };
  legacyExtension: { enabled: boolean; version?: string };
  /** File names directly inside the workspace folder (the folder that is mirrored to the board). */
  rootFiles: string[];
  /** Module names that exist on the board (from the identity probe), added to the built-in list of shadowing names. */
  boardModules: string[];
  session: { state: SessionState; selectedPort: string | null; remembered: RememberedPort | null };
  reset: ResetFact;
  settings: { id: string; value: string }[];
  /** Added with the IntelliSense setup; absent in older synthetic facts (the section is then left out). */
  intellisense?: IntelliSenseFact;
}

// ------------------------------------------------------------------ report

export type Level = 'ok' | 'info' | 'warn' | 'error';

export interface DoctorItem {
  level: Level;
  text: string;
  /** One line: what the student should do about it. Present on every warn and error. */
  todo?: string;
  /** Extra lines (rejected candidates, versions); shown indented. */
  detail?: string[];
}

export interface DoctorSection {
  title: string;
  items: DoctorItem[];
}

export interface DoctorReport {
  title: string;
  generatedAt: string;
  errors: number;
  warnings: number;
  sections: DoctorSection[];
}

/** Names that, as a file in the project folder, hide a module of Python or of the board (RQ-COURSE-5). */
export const SHADOWABLE_MODULES: readonly string[] = [
  'time', 'machine', 'serial', 'os', 'sys', 'json', 'random', 'math', 'socket', 'network', 'gc', 'array', 'struct', 're',
  'collections', 'select', 'binascii', 'hashlib', 'io', 'errno', 'micropython', 'utime', 'ujson', 'uos', 'usys', 'ure', 'ubinascii',
  'uasyncio', 'asyncio', 'esp', 'esp32', 'neopixel', 'bluetooth', 'framebuf', 'heapq', 'ssl', 'cmath', 'platform', 'typing',
  'onewire', 'dht', 'ds18x20', 'rp2', 'pyb', 'stm', 'uctypes', 'usocket', 'ustruct', 'uarray', 'uio', 'uhashlib', 'umachine',
  'mip', 'espnow', 'lwip', 'btree', 'cryptolib', 'deflate', 'vfs', 'webrepl', 'ntptime', 'urequests', 'requests', 'main_module',
];

export interface ShadowFinding {
  file: string;
  module: string;
  onBoardToo: boolean;
}

/** Files `name.py` / `name.mpy` in the project folder whose name is a module that Python or the board already has. */
export function findShadowingFiles(rootFiles: readonly string[], boardModules: readonly string[] = []): ShadowFinding[] {
  const known = new Set(SHADOWABLE_MODULES.map((n) => n.toLowerCase()));
  const board = new Set(boardModules.map((n) => n.toLowerCase()));
  const out: ShadowFinding[] = [];
  for (const file of rootFiles) {
    const m = /^(.+)\.(py|mpy)$/i.exec(file);
    const module = m?.[1]?.toLowerCase();
    if (module && (known.has(module) || board.has(module))) {
      out.push({ file, module, onBoardToo: board.has(module) });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function hex(n: number | null): string {
  return n === null ? '----' : n.toString(16).padStart(4, '0');
}

const OS_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function pythonSection(f: DoctorFacts): DoctorSection {
  const s: DoctorSection = { title: 'Python', items: [] };
  const py = f.python;
  const setting = f.settings.find((x) => x.id === settingId('pythonPath'));
  if (!py) {
    s.items.push({
      level: 'error', text: `Python could not be checked: ${f.pythonError ?? 'unknown reason'}.`,
      todo: 'Run the Doctor again; if this repeats, send the log (Command Palette: "Show Log").',
    });
    return s;
  }
  if (py.chosen) {
    const c = py.chosen;
    s.items.push({
      level: 'ok', text: `Using Python ${c.versionText} (${c.implementation}).`,
      detail: [`Program: ${c.executable}`, `Found as: ${c.label}`],
    });
    if (c.untested) {
      s.items.push({
        level: 'warn', text: `Python ${c.versionText} works but is older than the tested versions (3.12 to 3.15).`,
        todo: 'If you see odd errors, install a current Python from python.org and reload the VS Code window.',
      });
    }
    const cloud = classifyCloudPath(c.executable);
    if (cloud) {
      s.items.push({
        level: 'warn', text: `This Python lives inside a synced folder (${cloud}). Environments in synced folders can be slow, locked or different on another computer.`,
        todo: 'Use a Python installed on this computer (python.org) instead, or choose it with the "pythonPath" setting.',
      });
    }
    if (py.alternatives.length > 0) {
      s.items.push({ level: 'info', text: `Other working Pythons: ${py.alternatives.map((a) => `${a.versionText} (${a.label})`).join('; ')}.` });
    }
  } else {
    s.items.push({
      level: 'error', text: py.failure?.message ?? 'No working Python was found.',
      todo: py.failure?.hint ?? 'Install Python from python.org, then reload the VS Code window.',
    });
  }
  if (setting && setting.value.trim() !== '' && !setting.value.startsWith('(')) {
    s.items.push({ level: 'info', text: `The setting "${setting.id}" is set to ${setting.value}; it is tried first and never skipped.` });
  }
  if (py.rejected.length > 0) {
    s.items.push({
      level: 'info', text: `${py.rejected.length} candidate(s) were not used:`,
      detail: py.rejected.map((r) => `${r.label} [${r.command}]: ${r.message}`),
    });
  }
  for (const n of py.notes) {
    s.items.push({ level: 'info', text: n });
  }
  s.items.push({
    level: 'info', text: 'Python is found by running it, not by looking at PATH, so it does not matter how VS Code was started or which terminal you use.',
  });
  return s;
}

function bridgeSection(f: DoctorFacts): DoctorSection {
  const s: DoctorSection = { title: 'Connection helper', items: [] };
  const b = f.bridge;
  if (b.status === 'ok') {
    const h = b.hello;
    s.items.push({
      level: 'ok', text: `The helper that talks to the board starts and answers (version ${h.bridge}, protocol ${h.proto}).`,
      detail: [
        `Python of the helper: ${h.python}`, `pyserial: ${h.pyserial} (included with the extension)`,
        `mpremote: ${h.vendored.mpremote ?? 'not included'} (included with the extension)`, `Extension: ${f.extensionVersion}`,
      ],
    });
  } else if (b.status === 'failed') {
    s.items.push({ level: 'error', text: `The helper that talks to the board could not start: ${b.message}`, todo: 'Fix the Python problem above, then run the Doctor again.' });
  } else {
    s.items.push({ level: 'info', text: 'The helper was not started for this check.' });
  }
  return s;
}

function resetLines(r: ResetFact): string[] {
  const lines: string[] = [];
  const c = r.capability;
  if (c) {
    lines.push('Restart Python (soft reset): available');
    lines.push(`Reboot board (software): ${c.machine.available ? 'available' : 'not available'} - ${c.machine.reason}`);
    lines.push(c.hard
      ? `Reset with RTS/DTR line: ${c.hard.state} (${c.hard.method}, ${c.hard.basis}) - ${c.hard.reason}`
      : 'Reset with RTS/DTR line: not reported');
  }
  if (r.error) {
    lines.push(`Reset options could not be read: ${r.error}`);
  }
  if (r.learned.length > 0) {
    lines.push(`Learned about boards on this computer: ${r.learned.map((l) => `${l.key} ${l.learned}`).join('; ')}`);
  }
  return lines;
}

function boardSection(f: DoctorFacts): DoctorSection {
  const s: DoctorSection = { title: 'Board', items: [] };
  const st = f.session.state;
  const selected = f.session.selectedPort;
  if (selected === null && st.port === null) {
    s.items.push({
      level: 'info', text: 'No serial port is selected.',
      todo: `Plug in your board and choose "Select Serial Port" in the ${IDENTITY.displayName} view.`,
    });
    if (f.session.remembered) {
      s.items.push({ level: 'info', text: `This workspace remembers ${f.session.remembered.device} (USB ${hex(f.session.remembered.vid)}:${hex(f.session.remembered.pid)}).` });
    }
    return s;
  }
  const info = st.portInfo;
  const lines: string[] = [];
  if (info) {
    lines.push(`Adapter: ${info.adapter || 'unknown'} (USB ${hex(info.vid)}:${hex(info.pid)}), kind ${info.kind}, open policy ${info.policy}`);
  }
  if (st.state === 'disconnected') {
    s.items.push({
      level: 'warn', text: `Port ${selected ?? '(none)'} is selected but the board is not connected (${st.reason || 'no reason recorded'}).`,
      todo: 'Check the cable, close other programs that use the board (Thonny, Arduino, PlatformIO), then choose "Select Serial Port" again.',
    });
  } else {
    s.items.push({ level: 'ok', text: `Connected to ${st.port ?? selected ?? ''} (${st.state}).`, detail: lines });
  }
  const id = st.identity;
  if (id) {
    s.items.push({
      level: 'info', text: `Board: ${id.machine || id.platform} running MicroPython ${id.version.join('.')}${id.build ? ` (build ${id.build})` : ''}.`,
      detail: [`Platform: ${id.platform}`, `Unique id: ${id.uniqueId || 'none'}`, `Hash support: ${id.caps.hash}, compile: ${id.caps.compile}`],
    });
  } else if (st.state !== 'disconnected') {
    s.items.push({ level: 'info', text: 'The board identity has not been read yet (it is read once the board shows its prompt).' });
  }
  const reset = resetLines(f.reset);
  if (reset.length > 0) {
    s.items.push({ level: 'info', text: 'Reset options:', detail: reset });
  }
  return s;
}

function projectSection(f: DoctorFacts): DoctorSection {
  const s: DoctorSection = { title: 'Project folder', items: [] };
  const w = f.window;
  if (w.folder === null) {
    s.items.push({
      level: 'warn', text: 'No project folder is open.',
      todo: 'Use File > Open Folder and choose the folder that holds your MicroPython files.',
    });
  } else {
    s.items.push({ level: 'ok', text: `Project folder: ${w.folder}` });
    const cloud = classifyCloudPath(w.folder);
    if (cloud) {
      s.items.push({
        level: 'info', text: `The project is in a synced folder (${cloud}). That works, but a file that is "online only" or locked by the sync program can fail to upload.`,
        todo: 'Keep the project folder set to "Always keep on this device", and wait for syncing to finish before uploading.',
      });
    }
    if (w.folderCount > 1) {
      s.items.push({ level: 'info', text: `${w.folderCount} folders are open; only the first one is used.` });
    }
  }
  const shadows = findShadowingFiles(f.rootFiles, f.boardModules);
  if (shadows.length > 0) {
    s.items.push({
      level: 'warn', text: `These files have the same name as a built-in module, so they hide it (for your program, for VS Code's checks and on the board): ${shadows.map((x) => x.file).join(', ')}.`,
      todo: `Rename ${shadows.length === 1 ? 'it' : 'them'} (for example my_${shadows[0]?.file ?? 'file.py'}), and delete any matching __pycache__ folder.`,
    });
  }
  return s;
}

function windowSection(f: DoctorFacts): DoctorSection {
  const s: DoctorSection = { title: 'VS Code', items: [] };
  const w = f.window;
  s.items.push({ level: 'info', text: `${OS_NAMES[f.os] ?? f.os} ${f.osRelease}, VS Code ${f.vscodeVersion}, ${IDENTITY.displayName} ${f.extensionVersion}.` });
  if (w.remoteName) {
    s.items.push({
      level: 'error', text: `This window is running remotely (${w.remoteName}), so the board plugged into your computer is out of reach.`,
      todo: 'Open the folder in a normal local window (File > Open Folder), not through WSL, SSH, a container or Codespaces.',
    });
  }
  if (!w.folderIsLocal) {
    s.items.push({
      level: 'error', text: 'The open folder is a virtual workspace, not a folder on this computer.',
      todo: 'Open a folder from your own disk (File > Open Folder).',
    });
  }
  if (!w.trusted) {
    s.items.push({
      level: 'warn', text: 'The folder is not trusted (Restricted Mode), so the workspace Python and port settings and virtual environments in the folder are ignored.',
      todo: 'If you trust the folder, choose "Trust" in the banner or Command Palette: "Workspaces: Manage Workspace Trust".',
    });
  } else {
    s.items.push({ level: 'ok', text: 'The folder is trusted.' });
  }
  const old = f.legacyExtension;
  if (old.enabled) {
    s.items.push({
      level: 'error', text: `The older extension ${LEGACY.extensionId}${old.version ? ` ${old.version}` : ''} is turned on. Both extensions would react when you save and both would try to use the board.`,
      todo: `Open the Extensions view, find "${LEGACY.extensionId.split('.')[1] ?? LEGACY.extensionId}", choose Disable, then reload the window.`,
    });
  } else {
    s.items.push({ level: 'ok', text: 'The older extension is not turned on.' });
  }
  const t = f.tooling;
  const exposed = t.pythonExtensionInstalled && t.legacyActivateEnvironment !== false;
  s.items.push({
    level: 'info',
    text: exposed
      ? 'The Python extension may type an activation command (like "source .../activate") into new terminals. The REPL tab drops such lines before they reach the board.'
      : 'Terminal activation by the Python extension is off or the extension is not installed, so the REPL tab gets no extra text.',
    todo: exposed ? 'If you ever see such a line in the REPL tab, set "python.terminal.activateEnvironment" to false for this folder.' : undefined,
    detail: [
      `Python extension: ${t.pythonExtensionInstalled ? 'installed' : 'not installed'}; python.terminal.activateEnvironment = ${t.legacyActivateEnvironment === undefined ? '(not set)' : String(t.legacyActivateEnvironment)}`,
      `Python Environments extension: ${t.envsExtensionInstalled ? 'installed' : 'not installed'}; python-envs.terminal.autoActivationType = ${t.envsAutoActivation ?? '(not set)'}`,
    ],
  });
  return s;
}

function intellisenseSection(f: DoctorFacts): DoctorSection | null {
  const x = f.intellisense;
  if (x === undefined) { return null; }
  const s: DoctorSection = { title: 'MicroPython IntelliSense', items: [] };
  const setup = `Choose "Set Up MicroPython IntelliSense..." in the Command Palette (or the "Set up IntelliSense" row in Board Actions).`;
  const names = [x.servers.pylance ? 'Pylance' : '', x.servers.pyright ? 'Pyright' : '', x.servers.basedpyright ? 'basedpyright' : ''].filter(Boolean);
  if (names.length > 0) {
    s.items.push({ level: 'ok', text: `Import checking is provided by ${names.join(', ')}.` });
  } else {
    s.items.push({
      level: 'warn', text: `No Python language server (Pylance, Pyright or basedpyright) is installed${x.servers.pythonExtension ? ' next to the Python extension' : ''}, so VS Code cannot check or complete imports.`,
      todo: 'Open the Extensions view, search for "Python" (from Microsoft) and install it; it brings Pylance.',
    });
  }
  const h = x.health;
  if (h === null) {
    s.items.push({ level: 'info', text: 'No project folder is open, so there is nothing to check.' });
    return s;
  }
  if (h.tracker === 'absent') {
    s.items.push({ level: 'info', text: 'MicroPython IntelliSense is not set up in this folder (no files from the setup were found).', todo: `${setup} It shows every file before anything is written.` });
  } else if (h.tracker === 'invalid') {
    s.items.push({ level: 'warn', text: `${IDENTITY.dotDir}/manifest.json is damaged, so the extension cannot tell which files are its own.`, todo: `Delete the ${IDENTITY.dotDir} folder and the generated files, then run the setup again. ${setup}` });
  } else {
    if (h.managed.missing.length === 0) {
      s.items.push({ level: 'ok', text: `All ${h.managed.total} files made by the setup are in place.`, detail: h.managed.edited.length > 0 ? [`Changed by hand: ${h.managed.edited.slice(0, 6).join(', ')}${h.managed.edited.length > 6 ? ', ...' : ''}`] : undefined });
    } else {
      s.items.push({
        level: 'warn', text: `${h.managed.missing.length} of ${h.managed.total} files made by the setup are missing: ${h.managed.missing.slice(0, 4).join(', ')}${h.managed.missing.length > 4 ? ', ...' : ''}.`,
        todo: `Run the setup again to bring them back. ${setup}`,
      });
    }
    if (h.managed.edited.length > 0 && h.managed.missing.length === 0) {
      s.items.push({ level: 'info', text: `${h.managed.edited.length} generated file(s) were changed by hand. The next setup run rewrites them.`, todo: 'Put your own settings in pyrightconfig.json instead; the generated files are not meant to be edited.' });
    }
    const v = h.stubVersions;
    if (v.relation === 'none') {
      s.items.push({ level: 'info', text: 'No stock MicroPython stubs were installed (only what was made from your board, if anything).', todo: 'Connect your board and run the setup again, or name the board family in the setting "intellisenseStubs".' });
    } else if (v.relation === 'same') {
      s.items.push({ level: 'ok', text: `The stubs (${v.stubs}) match the board's MicroPython ${v.board ?? ''}.` });
    } else if (v.relation === 'stubs-older' || v.relation === 'stubs-newer') {
      s.items.push({
        level: 'warn', text: `The stubs (${v.stubs}) are ${v.relation === 'stubs-older' ? 'older' : 'newer'} than the board's MicroPython ${v.board ?? ''}. ${v.relation === 'stubs-older' ? 'New functions can show as unknown.' : 'Functions the board lacks may be accepted.'}`,
        todo: 'This is only a hint for the editor; your program is not affected. Update the extension for newer stubs.',
      });
    } else {
      s.items.push({ level: 'info', text: `Stubs: ${v.stubs || 'installed'}. ${v.relation === 'no-board' ? 'No board is connected, so the versions were not compared.' : 'The versions could not be compared.'}` });
    }
  }
  if (h.tracker === 'valid') {
    const b = h.board;
    const used = (b?.modules ?? []).filter((m) => m.how === 'stub' || m.how === 'copy' || m.how === 'stub-any');
    if (b === null || used.length === 0) {
      s.items.push({ level: 'info', text: `No modules of the board itself are set up${b !== null ? ` (${b.label} has none beyond standard MicroPython)` : ''}.`, todo: b === null ? `If your board has its own modules (for example built into a course firmware), connect it with no program running and run the setup again. ${setup}` : undefined });
    } else {
      s.items.push({
        level: 'ok', text: `Modules of your board (${b.label}, read on ${b.date}): ${used.map((m) => m.name).join(', ')}.`,
        detail: b.modules.map((m) => boardModuleLine(m).replace(/`/g, '')).slice(0, 12),
        todo: used.some((m) => m.how === 'stub-any') ? `Some modules could not be looked at, so the editor accepts anything in them. Run the setup again to retry. ${setup}` : undefined,
      });
    }
  }
  const c = h.userConfig;
  if (!c.exists) {
    if (h.pyprojectPyright) {
      s.items.push({ level: 'warn', text: 'pyproject.toml has a [tool.pyright] section, so pyrightconfig.json would take precedence over it and was not created.', todo: `Add this line to the [tool.pyright] section yourself: extends = "${IDENTITY.dotDir}/pyright.generated.json"` });
    } else if (h.tracker === 'valid') {
      s.items.push({ level: 'warn', text: 'There is no pyrightconfig.json, so the language server does not use the generated settings and MicroPython modules stay unresolved.', todo: `Run the setup again and agree to create pyrightconfig.json. ${setup}` });
    }
  } else if (!c.valid) {
    s.items.push({ level: 'error', text: `pyrightconfig.json cannot be read (${c.error ?? 'invalid'}), so the language server ignores it.`, todo: 'Fix the file (a missing comma or quote is the usual cause), then the editor reloads it by itself.' });
  } else if (c.extendsOurs) {
    if (c.targetExists === false) {
      s.items.push({
        level: 'error', text: `pyrightconfig.json extends ${IDENTITY.dotDir}/pyright.generated.json, but that file does not exist. The language server logs one error and your MicroPython modules show as unresolved again.`,
        todo: `Run the setup again to create it. ${setup}`,
      });
    } else {
      s.items.push({ level: 'ok', text: `pyrightconfig.json extends the generated file ${IDENTITY.dotDir}/pyright.generated.json (it exists).` });
    }
    if (c.overridden.length > 0) {
      s.items.push({
        level: 'warn', text: `pyrightconfig.json sets ${c.overridden.join(', ')} itself. A key there REPLACES the generated one, so the generated ${c.overridden.join('/')} is not used.`,
        todo: 'Remove that key from pyrightconfig.json to use the generated value.',
      });
    }
  } else if (c.extendsValue !== undefined) {
    s.items.push({ level: 'warn', text: `pyrightconfig.json extends ${c.extendsValue}, not the generated file, so MicroPython modules are not resolved.`, todo: `A config can extend only one file: copy the generated values into the file it extends, or point it at ${IDENTITY.dotDir}/pyright.generated.json.` });
  } else if (h.tracker !== 'absent') {
    s.items.push({ level: 'warn', text: 'pyrightconfig.json does not extend the generated file, so MicroPython modules are not resolved.', todo: `Add this line at the top of the object: "extends": "${IDENTITY.dotDir}/pyright.generated.json",` });
  }
  const conflicting = x.overrides.filter(() => c.exists);
  if (conflicting.length > 0) {
    s.items.push({
      level: 'warn', text: `These VS Code settings are ignored while pyrightconfig.json exists: ${conflicting.map((o) => `${o.key} (${o.scope})`).join(', ')}.`,
      todo: 'Put the same values into pyrightconfig.json (typeCheckingMode, stubPath, extraPaths) or delete the settings; two sources only confuse the editor.',
    });
  } else if (x.overrides.length > 0) {
    s.items.push({ level: 'info', text: `These settings are in effect because there is no pyrightconfig.json: ${x.overrides.map((o) => `${o.key} (${o.scope})`).join(', ')}.` });
  }
  if (h.shadowing.length > 0) {
    s.items.push({
      level: 'warn', text: `These files hide a module that IntelliSense resolves from the stubs or the firmware (for the editor and on the board): ${h.shadowing.map((x2) => x2.file).join(', ')}.`,
      todo: `Rename ${h.shadowing.length === 1 ? 'it' : 'them'} (for example my_${h.shadowing[0]?.file ?? 'file.py'}) and delete any __pycache__ folder.`,
    });
  }
  if (h.problems.length > 0) { s.items.push({ level: 'info', text: 'Some parts of this check could not be read:', detail: h.problems.slice(0, 6) }); }
  return s;
}

function settingsSection(f: DoctorFacts): DoctorSection {
  return { title: 'Settings in effect', items: [{ level: 'info', text: 'Values after workspace and user settings are combined:', detail: f.settings.map((x) => `${x.id} = ${x.value}`) }] };
}

export function buildDoctorReport(f: DoctorFacts): DoctorReport {
  const sections = [pythonSection(f), bridgeSection(f), boardSection(f), projectSection(f), intellisenseSection(f), windowSection(f), settingsSection(f)]
    .filter((x): x is DoctorSection => x !== null);
  const all = sections.flatMap((s) => s.items);
  return {
    title: `${IDENTITY.displayName} Doctor`, generatedAt: f.generatedAt,
    errors: all.filter((i) => i.level === 'error').length, warnings: all.filter((i) => i.level === 'warn').length, sections,
  };
}

const MARK: Record<Level, string> = { ok: 'OK', info: 'INFO', warn: 'WARNING', error: 'PROBLEM' };

export function renderDoctorMarkdown(r: DoctorReport): string {
  const out: string[] = [`# ${r.title}`, '', `Checked ${r.generatedAt}.`, ''];
  if (r.errors === 0 && r.warnings === 0) {
    out.push('**Result: everything looks fine.**');
  } else {
    out.push(`**Result: ${r.errors} problem${r.errors === 1 ? '' : 's'} and ${r.warnings} warning${r.warnings === 1 ? '' : 's'}.** Fix the problems first; each one says what to do.`);
  }
  for (const s of r.sections) {
    out.push('', `## ${s.title}`, '');
    for (const i of s.items) {
      out.push(`- **${MARK[i.level]}** ${i.text}`);
      if (i.todo) {
        out.push(`  - What to do: ${i.todo}`);
      }
      for (const d of i.detail ?? []) {
        out.push(`  - ${d}`);
      }
    }
  }
  out.push('');
  return out.join('\n');
}

// ------------------------------------------------------------------ collecting facts (VS Code, discovery, session)

/** The part of the concrete session the Doctor uses. */
export interface DoctorSession {
  readonly state: SessionState;
  readonly selectedPort: string | null;
  bridgeInfo(): Promise<HelloEvent>;
  resetCapability(): Promise<ResetCapability>;
}

export interface DoctorDeps {
  context: vscode.ExtensionContext;
  log: Logger;
  settings: SettingsReader | MpySettings;
  session: DoctorSession;
  discovery: PythonDiscovery;
  learned: LearnedResetStore;
  portMemory?: { get(): RememberedPort | null };
}

function readConfig<T>(section: string, key: string): T | undefined {
  return vscode.workspace.getConfiguration(section).get<T>(key);
}

function settingsInEffect(s: SettingsReader): { id: string; value: string }[] {
  const values: Record<SettingKey, string> = {
    'autoSync': s.autoSync, 'sync.debounceMs': String(s.syncDebounceMs), 'rootPath': s.rootPath,
    'pythonPath': s.pythonPath === '' ? '(empty: find Python automatically)' : s.pythonPath,
    'port': s.portOverride === '' ? '(empty: choose from a list)' : s.portOverride, 'run.freshStart': String(s.runFreshStart),
    'reset.showUnverifiedHardReset': String(s.showUnverifiedHardReset), 'stopOnDisconnect': String(s.stopOnDisconnect),
    'stopOnTerminalClose': String(s.stopOnTerminalClose), 'board.setClockOnConnect': s.boardClockOnConnect, 'logLevel': s.logLevel,
    'intellisenseStubs': s.intellisenseStubs, 'intellisenseOffer': String(s.intellisenseOffer),
  };
  return SETTINGS.map((spec) => ({ id: settingId(spec.key), value: values[spec.key] }));
}

export async function collectDoctorFacts(deps: DoctorDeps): Promise<DoctorFacts> {
  const { context, log, session } = deps;
  const first = vscode.workspace.workspaceFolders?.[0];
  const folder = first && first.uri.scheme === 'file' ? first.uri.fsPath : null;
  deps.discovery.invalidate();
  let python: PythonResolution | null = null;
  let pythonError: string | undefined;
  try {
    python = await deps.discovery.resolve({ exhaustive: true });
  } catch (err) {
    pythonError = userMessage(err);
    log.error('the Doctor could not check Python', err);
  }
  let bridge: BridgeFact;
  if (python && !python.chosen) {
    bridge = { status: 'failed', message: python.failure?.message ?? 'no working Python' };
  } else {
    try {
      bridge = { status: 'ok', hello: await session.bridgeInfo() };
    } catch (err) {
      bridge = { status: 'failed', message: userMessage(err) };
      log.error('the Doctor could not start the connection helper', err);
    }
  }
  const reset: ResetFact = { capability: null, learned: deps.learned.all() };
  if (session.state.state === 'idle' || session.state.state === 'running') {
    try {
      reset.capability = await session.resetCapability();
    } catch (err) {
      reset.error = userMessage(err);
      log.warn('the Doctor could not read the reset options', err);
    }
  }
  let rootFiles: string[] = [];
  if (folder !== null) {
    try {
      rootFiles = await fs.promises.readdir(folder);
    } catch (err) {
      log.warn('the Doctor could not list the project folder', err);
    }
  }
  const intellisense = await collectIntelliSense(deps, folder);
  const legacy = vscode.extensions.getExtension(LEGACY.extensionId);
  const version = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
  return {
    generatedAt: new Date().toISOString(), extensionVersion: version, os: process.platform, osRelease: os.release(), vscodeVersion: vscode.version,
    window: {
      remoteName: vscode.env.remoteName, trusted: vscode.workspace.isTrusted, folder, folderIsLocal: first === undefined || first.uri.scheme === 'file',
      folderCount: vscode.workspace.workspaceFolders?.length ?? 0,
    },
    python, pythonError, bridge,
    tooling: {
      pythonExtensionInstalled: vscode.extensions.getExtension('ms-python.python') !== undefined,
      envsExtensionInstalled: vscode.extensions.getExtension('ms-python.vscode-python-envs') !== undefined,
      legacyActivateEnvironment: readConfig<boolean>('python', 'terminal.activateEnvironment'),
      envsAutoActivation: readConfig<string>('python-envs', 'terminal.autoActivationType'),
    },
    legacyExtension: { enabled: legacy !== undefined, version: (legacy?.packageJSON as { version?: string } | undefined)?.version },
    rootFiles, boardModules: session.state.identity?.profileHints.modules ?? [],
    session: { state: session.state, selectedPort: session.selectedPort, remembered: deps.portMemory?.get() ?? null },
    reset, settings: settingsInEffect(deps.settings), intellisense,
  };
}

const ANALYSIS_KEYS = ['stubPath', 'extraPaths', 'typeCheckingMode'] as const;

async function collectIntelliSense(deps: DoctorDeps, folder: string | null): Promise<IntelliSenseFact> {
  const has = (id: string): boolean => vscode.extensions.getExtension(id) !== undefined;
  const servers = { pylance: has('ms-python.vscode-pylance'), pythonExtension: has('ms-python.python'), basedpyright: has('detachhead.basedpyright'), pyright: has('ms-pyright.pyright') };
  const overrides: IntelliSenseFact['overrides'] = [];
  const analysis = vscode.workspace.getConfiguration('python.analysis');
  for (const key of ANALYSIS_KEYS) {
    const v = analysis.inspect<unknown>(key);
    if (v?.workspaceFolderValue !== undefined) { overrides.push({ key: `python.analysis.${key}`, scope: 'folder', value: v.workspaceFolderValue }); }
    else if (v?.workspaceValue !== undefined) { overrides.push({ key: `python.analysis.${key}`, scope: 'workspace', value: v.workspaceValue }); }
    else if (v?.globalValue !== undefined) { overrides.push({ key: `python.analysis.${key}`, scope: 'user', value: v.globalValue }); }
  }
  let health: IntelliSenseHealth | null = null;
  if (folder !== null) {
    try {
      const fsx = nodeFs();
      health = await gatherIntelliSenseHealth(fsx, {
        workspace: folder, resourcesDir: fsx.path.join(deps.context.extensionUri.fsPath, 'resources', 'stubs'),
        boardVersion: deps.session.state.identity?.version ?? null,
      });
    } catch (err) {
      deps.log.warn('the Doctor could not check the IntelliSense files', err);
    }
  }
  return { health, servers, overrides };
}

/** Run the Doctor once: collect, build, and open the report in an untitled Markdown document. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport | undefined> {
  try {
    const facts = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Checking your setup...' },
      () => collectDoctorFacts(deps),
    );
    const report = buildDoctorReport(facts);
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: renderDoctorMarkdown(report) });
    await vscode.window.showTextDocument(doc, { preview: true });
    deps.log.info(`Doctor finished: ${report.errors} problem(s), ${report.warnings} warning(s)`);
    return report;
  } catch (err) {
    deps.log.error('the Doctor failed', err);
    void showToast(deps.log, 'error', `The Doctor could not finish: ${userMessage(err)} Open the log (Command Palette: "Show Log") for details.`);
    return undefined;
  }
}

export function registerDoctor(deps: DoctorDeps): vscode.Disposable[] {
  return [vscode.commands.registerCommand(COMMAND_IDS.doctor, () => runDoctor(deps))];
}

/**
 * Quick checks for the end of activation (fire and forget, never throws): the older extension being on is a blocking warning,
 * because both extensions would act on every save and both would open the port (D-14, RQ-DIST-3).
 */
export async function runStartupChecks(deps: Pick<DoctorDeps, 'log'>): Promise<string[]> {
  const problems: string[] = [];
  try {
    if (vscode.extensions.getExtension(LEGACY.extensionId)) {
      problems.push('legacy-extension');
      const choice = await vscode.window.showWarningMessage(
        `The older extension ${LEGACY.extensionId} is turned on next to ${IDENTITY.displayName}. Both would react when you save and both would use the board.`,
        'Open Doctor',
      );
      if (choice === 'Open Doctor') {
        await vscode.commands.executeCommand(COMMAND_IDS.doctor);
      }
    }
  } catch (err) {
    deps.log.error('a startup check failed', err);
  }
  return problems;
}
