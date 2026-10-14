/**
 * ONE typed table that generates the manifest (`npm run gen:manifest` writes it into package.json; `--check` fails when
 * package.json is out of date). Everything declared here must have a handler/provider in the code and vice versa
 * (test/unit/contributes.test.ts, and the integrator's activation test). Pure module: no `vscode` import.
 *
 * Ported from the old extension's package.json (docs/analysis/04-ui-inventory.md sections 5-8, 15): same three views, same
 * rows, same view-title buttons; every `*FromView` wrapper and dead command is gone.
 */
import { IDENTITY, commandId, contextKey, settingId, viewContainerId, viewId } from './identity';

// ------------------------------------------------------------------ artwork

/**
 * Every file under media/ that the manifest or the code refers to (D-19, branding/final/README.md). Paths are relative to the
 * extension folder, POSIX style. The VSIX ships exactly these files (scripts/stage.mjs + test/unit/package.test.ts).
 */
export const MEDIA = {
  /** Marketplace icon (256 px PNG). */
  icon: 'media/icon.png',
  /** Activity-bar container icon (24 px monochrome SVG, drawn with currentColor). */
  activityBar: 'media/activitybar.svg',
  /** Tab icon of the REPL / Run terminal: fixed colours, so one file per theme kind (a currentColor SVG may not be themed there). */
  terminalLight: 'media/terminal-tab-light.svg',
  terminalDark: 'media/terminal-tab-dark.svg',
  /** Red bin of the destructive commands, one file per theme kind. */
  trashLight: 'media/trash-danger-light.svg',
  trashDark: 'media/trash-danger-dark.svg',
} as const;

/** Colour of the Marketplace page header behind the icon (the tile colour of the mark) and the text theme on it. */
export const GALLERY_BANNER = { color: '#0E5968', theme: 'dark' } as const;

/** Search terms on the Marketplace and in the Extensions view. "micropython" is descriptive here, never the product name (D-18). */
export const KEYWORDS = ['micropython', 'upython', 'esp32', 'rp2040', 'pico', 'repl', 'serial', 'intellisense', 'education'] as const;

export const CATEGORIES = ['Education', 'Other'] as const;

// ------------------------------------------------------------------ commands

interface CommandSpec {
  readonly name: string;
  readonly title: string;
  readonly icon?: string | { readonly light: string; readonly dark: string };
  /** false: hidden from the Command Palette (the command needs a tree node as argument). */
  readonly palette?: boolean;
}

const TRASH = { light: MEDIA.trashLight, dark: MEDIA.trashDark } as const;

export const COMMANDS = [
  { name: 'refresh', title: 'Refresh Board Files', icon: '$(refresh)' },
  { name: 'selectPort', title: 'Select Serial Port', icon: '$(plug)' },
  { name: 'runActiveFile', title: 'Run Current File on Board', icon: '$(play)' },
  { name: 'stop', title: 'Stop Program', icon: '$(debug-stop)' },
  { name: 'openRepl', title: 'Open REPL', icon: '$(terminal)' },
  { name: 'resetBoard', title: 'Reset Board...', icon: '$(debug-restart)' },
  { name: 'uploadActiveFile', title: 'Upload Current File to Board', icon: '$(cloud-upload)' },
  { name: 'syncToBoard', title: 'Upload All Files (Local to Board)', icon: '$(cloud-upload)' },
  { name: 'syncFromBoard', title: 'Download All Files (Board to Local)', icon: '$(cloud-download)' },
  { name: 'clearDevice', title: 'Clear Device Files...', icon: TRASH },
  { name: 'createIgnoreFile', title: `Create ${IDENTITY.ignoreFile} File (Files Not to Copy)`, icon: '$(new-file)' },
  { name: 'toggleAutoSync', title: 'Turn Auto-Sync on Save On or Off', icon: '$(sync)' },
  { name: 'openFileFromBoard', title: 'Open File from Board', palette: false },
  { name: 'openBoardCopy', title: "Open the Board's Copy (Read-Only)", palette: false },
  { name: 'newFileOnBoard', title: 'New File (in Your Project and on the Board)...', icon: '$(new-file)' },
  { name: 'newFolderOnBoard', title: 'New Folder (in Your Project and on the Board)...', icon: '$(new-folder)' },
  { name: 'renameOnBoard', title: 'Rename on Board...', icon: '$(edit)', palette: false },
  { name: 'deleteOnBoard', title: 'Delete from Board', palette: false },
  { name: 'deleteOnBoardAndLocal', title: 'Delete from Board and Local', icon: TRASH, palette: false },
  { name: 'fixIntelliSense', title: 'Set Up MicroPython IntelliSense...', icon: '$(lightbulb)' },
  { name: 'removeIntelliSense', title: `Remove ${IDENTITY.displayName} IntelliSense Files...`, icon: '$(trash)' },
  { name: 'doctor', title: 'Open Doctor (Check My Setup)', icon: '$(checklist)' },
  { name: 'showLog', title: 'Show Log', icon: '$(output)' },
  { name: 'setBoardClock', title: 'Set the Board Clock from This Computer', icon: '$(clock)' },
  { name: 'syncLegend', title: 'What Do the File Marks Mean?', icon: '$(question)' },
  { name: 'compareWithBoard', title: "Compare with the Board's Copy", icon: '$(diff)', palette: false },
  { name: 'uploadThisFile', title: 'Upload This File to the Board', icon: '$(arrow-up)', palette: false },
  { name: 'downloadThisFile', title: 'Download This File to My Project', icon: '$(arrow-down)', palette: false },
] as const satisfies readonly CommandSpec[];

export type CommandName = (typeof COMMANDS)[number]['name'];

/** `COMMAND_IDS.runActiveFile` is the id to register and to execute. */
export const COMMAND_IDS = Object.fromEntries(COMMANDS.map((c) => [c.name, commandId(c.name)])) as Record<CommandName, string>;

/** Every contributed command id, for tests (declared == registered). */
export function allCommandIds(): string[] {
  return COMMANDS.map((c) => commandId(c.name));
}

// ------------------------------------------------------------------ views, context keys

export const VIEWS = {
  files: viewId('files'),
  actions: viewId('actions'),
  sync: viewId('sync'),
} as const;

const VIEW_SPECS = [
  { id: VIEWS.files, name: 'Files', icon: '$(files)' },
  { id: VIEWS.actions, name: 'Board Actions', icon: '$(tools)' },
  { id: VIEWS.sync, name: 'Sync utilities', icon: '$(sync)' },
] as const;

/** Context keys the code may `setContext`; every key used in a `when` below is listed here (manifest test). */
export const CONTEXT = {
  /** A serial port is selected (Files welcome text). */
  hasPort: contextKey('hasPort'),
  /** No working Python could be found (Files welcome text points to Doctor). */
  interpreterProblem: contextKey('interpreterProblem'),
  /** The bridge has an open connection to a board. */
  connected: contextKey('connected'),
  /** A program started from the extension is running on the board. */
  running: contextKey('running'),
  /** `reset.capability.hard.state` is verified or likely (RQ-RESET-3). */
  hardResetAvailable: contextKey('hardResetAvailable'),
} as const;

/** `contextValue` of Files-view tree items (menus below match on it). `localFile`: a project file that is not on the board yet. */
export const TREE_CONTEXT = { file: 'file', dir: 'dir', localFile: 'localFile' } as const;

/** Files whose presence in a workspace root activates the extension (besides opening one of the views). */
export const PROJECT_MARKERS = [IDENTITY.ignoreFile, 'boot.py', 'main.py'] as const;

// ------------------------------------------------------------------ menus

type MenuName = 'view/title' | 'view/item/context';

interface MenuSpec {
  readonly menu: MenuName;
  readonly command: CommandName;
  readonly when: string;
  readonly group: string;
}

const inView = (view: keyof typeof VIEWS): string => `view == ${VIEWS[view]}`;
const onFile = `${inView('files')} && viewItem == ${TREE_CONTEXT.file}`;
const onFileOrDir = `${inView('files')} && (viewItem == ${TREE_CONTEXT.file} || viewItem == ${TREE_CONTEXT.dir})`;
const onAnyFile = `${inView('files')} && (viewItem == ${TREE_CONTEXT.file} || viewItem == ${TREE_CONTEXT.localFile})`;

export const MENUS: readonly MenuSpec[] = [
  { menu: 'view/title', command: 'refresh', when: inView('files'), group: 'navigation@0' },
  { menu: 'view/title', command: 'selectPort', when: inView('files'), group: 'navigation@1' },
  { menu: 'view/title', command: 'newFileOnBoard', when: inView('files'), group: 'navigation@2' },
  { menu: 'view/title', command: 'newFolderOnBoard', when: inView('files'), group: 'navigation@3' },
  { menu: 'view/title', command: 'syncLegend', when: inView('files'), group: 'navigation@4' },
  { menu: 'view/title', command: 'runActiveFile', when: inView('actions'), group: 'navigation@0' },
  { menu: 'view/title', command: 'openRepl', when: inView('actions'), group: 'navigation@1' },
  { menu: 'view/title', command: 'stop', when: inView('actions'), group: 'navigation@2' },
  { menu: 'view/title', command: 'syncToBoard', when: inView('sync'), group: 'navigation@0' },
  { menu: 'view/title', command: 'syncFromBoard', when: inView('sync'), group: 'navigation@1' },
  { menu: 'view/title', command: 'clearDevice', when: inView('sync'), group: 'navigation@9' },
  { menu: 'view/item/context', command: 'newFileOnBoard', when: onFileOrDir, group: '0_create@0' },
  { menu: 'view/item/context', command: 'newFolderOnBoard', when: onFileOrDir, group: '0_create@1' },
  { menu: 'view/item/context', command: 'openFileFromBoard', when: onFile, group: '1_open@1' },
  { menu: 'view/item/context', command: 'openBoardCopy', when: onFile, group: '1_open@2' },
  { menu: 'view/item/context', command: 'compareWithBoard', when: onFile, group: '1_open@3' },
  { menu: 'view/item/context', command: 'uploadThisFile', when: onAnyFile, group: '1_sync@1' },
  { menu: 'view/item/context', command: 'downloadThisFile', when: onFile, group: '1_sync@2' },
  { menu: 'view/item/context', command: 'renameOnBoard', when: onFileOrDir, group: '2_edit@1' },
  { menu: 'view/item/context', command: 'deleteOnBoard', when: onFileOrDir, group: '3_delete@1' },
  { menu: 'view/item/context', command: 'deleteOnBoardAndLocal', when: onFileOrDir, group: '3_delete@2' },
];

// ------------------------------------------------------------------ settings

interface SettingSpec {
  readonly key: string;
  readonly type: 'string' | 'boolean' | 'number' | 'array';
  readonly default: string | boolean | number | readonly string[];
  readonly description: string;
  readonly scope?: 'window' | 'resource' | 'machine' | 'machine-overridable';
  readonly enum?: readonly string[];
  readonly enumDescriptions?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  /** For `type: 'array'`: the type of the entries. */
  readonly items?: { readonly type: 'string' };
  /** Listed in capabilities.untrustedWorkspaces.restrictedConfigurations: ignored in Restricted Mode. */
  readonly restricted?: boolean;
}

export const SETTINGS = [
  {
    key: 'autoSync', type: 'string', default: 'on', scope: 'window', enum: ['on', 'off', 'ask'],
    enumDescriptions: [
      'Upload a file to the board every time you save it. A board that was never synced with this folder on this computer is reviewed first, and a board copy that changed since the last sync is never replaced without asking.',
      'Never upload on save. Use the Sync utilities instead.',
      'Older setting: ask once, the first time you connect a board in a workspace.',
    ],
    description: 'Upload a file to the board automatically when you save it (D-21: on by default).',
  },
  {
    key: 'board.setClockOnConnect', type: 'string', default: 'whenUnset', scope: 'window', enum: ['whenUnset', 'always', 'off'],
    enumDescriptions: [
      'Set the board\'s clock from this computer after connecting, but only when the board\'s clock is not set (it shows a year before 2024).',
      'Set the board\'s clock from this computer after every connect.',
      'Never set the board\'s clock automatically. The command "Set the Board Clock from This Computer" still works.',
    ],
    description: 'Set the board\'s clock from this computer\'s local time after connecting, so files and data logs the board writes get real dates.',
  },
  {
    key: 'sync.debounceMs', type: 'number', default: 400, minimum: 100, maximum: 5000, scope: 'window',
    description: 'How long to wait (in milliseconds) after your last save before uploading, so quick repeated saves send one upload.',
  },
  {
    key: 'rootPath', type: 'string', default: '/', scope: 'window',
    description: 'Folder on the board that matches your workspace folder, for example / or /lib. Must start with a slash.',
  },
  {
    key: 'pythonPath', type: 'string', default: '', scope: 'machine-overridable', restricted: true,
    description: 'Full path of the Python program used to talk to the board. Leave empty to find Python automatically.',
  },
  {
    key: 'port', type: 'string', default: '', scope: 'machine-overridable', restricted: true,
    description: 'Serial port to use, for example COM3 or /dev/cu.usbserial-0001. Leave empty to choose a port from a list.',
  },
  {
    key: 'run.freshStart', type: 'boolean', default: true, scope: 'window',
    description: 'Restart Python on the board (a soft reset) before each run, so every run starts clean.',
  },
  {
    key: 'reset.showUnverifiedHardReset', type: 'boolean', default: false, scope: 'window',
    description: 'Show "Reset with RTS/DTR line" in the reset menu even when it is not known to work with this board\'s USB adapter.',
  },
  {
    key: 'stopOnDisconnect', type: 'boolean', default: true, scope: 'window',
    description: 'Stop the running program on the board when the connection closes or VS Code exits. Recommended when motors or other hardware are attached.',
  },
  {
    key: 'stopOnTerminalClose', type: 'boolean', default: true, scope: 'window',
    description: 'Stop the program started by Run when you close the Run window',
  },
  {
    key: 'intellisenseStubs', type: 'string', default: 'auto', scope: 'window',
    description: 'Which built-in MicroPython stubs the IntelliSense setup uses when no board is connected: auto (use the connected board; standard Python modules only without one), off, or a board family such as esp32, esp8266, rp2, stm32, samd, nrf or mimxrt.',
  },
  {
    key: 'intellisenseOffer', type: 'boolean', default: true, scope: 'window',
    description: 'After the first successful connection in a workspace, offer to set up MicroPython IntelliSense (code completion and import checking). Turn off to never be asked.',
  },
  {
    key: 'logLevel', type: 'string', default: 'info', scope: 'window', enum: ['debug', 'info', 'warn', 'error'],
    description: 'How much detail the log shows. Use debug when you are asked to send a log.',
  },
] as const satisfies readonly SettingSpec[];

export type SettingKey = (typeof SETTINGS)[number]['key'];

export const SETTING_DEFAULTS = Object.fromEntries(SETTINGS.map((s) => [s.key, s.default])) as Record<SettingKey, string | number | boolean | readonly string[]>;

/** Full id of a setting, for `onDidChangeConfiguration.affectsConfiguration`. */
export function settingFullId(key: SettingKey): string {
  return settingId(key);
}

// ------------------------------------------------------------------ manifest generation

export interface ManifestSections {
  name: string;
  displayName: string;
  publisher: string;
  description: string;
  icon: string;
  galleryBanner: { color: string; theme: string };
  categories: string[];
  keywords: string[];
  capabilities: Record<string, unknown>;
  activationEvents: string[];
  contributes: Record<string, unknown>;
}

/** VS Code's own command: without arguments it asks for a folder and opens it in this window (D-24). */
export const OPEN_FOLDER_COMMAND = 'vscode.openFolder';

/** Built-in context key of VS Code (not ours): how many folders the window has open. */
const NO_FOLDER = 'workspaceFolderCount == 0';
const HAS_FOLDER = 'workspaceFolderCount > 0';

function welcome(view: string, when: string, lines: string[]): Record<string, string> {
  return { view, contents: lines.join('\n'), when };
}

/** The sections of package.json that this table owns. Deterministic: same input, same output. */
export function buildManifest(): ManifestSections {
  const doctor = COMMAND_IDS.doctor;
  const properties: Record<string, Record<string, unknown>> = {};
  for (const s of SETTINGS as readonly SettingSpec[]) {
    const p: Record<string, unknown> = { type: s.type, default: Array.isArray(s.default) ? [...s.default] : s.default, description: s.description };
    if (s.enum) {
      p.enum = [...s.enum];
    }
    if (s.enumDescriptions) {
      p.enumDescriptions = [...s.enumDescriptions];
    }
    if (s.items) {
      p.items = { ...s.items };
    }
    if (s.minimum !== undefined) {
      p.minimum = s.minimum;
    }
    if (s.maximum !== undefined) {
      p.maximum = s.maximum;
    }
    if (s.scope) {
      p.scope = s.scope;
    }
    properties[settingId(s.key)] = p;
  }

  const commands = (COMMANDS as readonly CommandSpec[]).map((c) => {
    const entry: Record<string, unknown> = { command: commandId(c.name), title: c.title, category: IDENTITY.shortName };
    if (c.icon) {
      entry.icon = typeof c.icon === 'string' ? c.icon : { ...c.icon };
    }
    return entry;
  });

  const menuEntries = (menu: MenuName): Record<string, string>[] =>
    MENUS.filter((m) => m.menu === menu).map((m) => ({ command: commandId(m.command), when: m.when, group: m.group }));

  const hiddenFromPalette = (COMMANDS as readonly CommandSpec[])
    .filter((c) => c.palette === false)
    .map((c) => ({ command: commandId(c.name), when: 'false' }));

  const restricted = (SETTINGS as readonly SettingSpec[]).filter((s) => s.restricted).map((s) => settingId(s.key));

  return {
    name: IDENTITY.extensionId,
    displayName: IDENTITY.displayName,
    publisher: IDENTITY.publisher,
    description: IDENTITY.description,
    icon: MEDIA.icon,
    galleryBanner: { ...GALLERY_BANNER },
    categories: [...CATEGORIES],
    keywords: [...KEYWORDS],
    capabilities: {
      untrustedWorkspaces: {
        supported: 'limited',
        description:
          'In Restricted Mode the saved Python path and serial port of the workspace are ignored, so nothing from an untrusted folder is run. Trust the folder to use everything.',
        restrictedConfigurations: restricted,
      },
    },
    activationEvents: [
      ...VIEW_SPECS.map((v) => `onView:${v.id}`),
      ...PROJECT_MARKERS.map((f) => `workspaceContains:${f}`),
    ],
    contributes: {
      viewsContainers: {
        activitybar: [{ id: viewContainerId(), title: IDENTITY.shortName, icon: MEDIA.activityBar }],
      },
      views: { [viewContainerId()]: VIEW_SPECS.map((v) => ({ id: v.id, name: v.name, icon: v.icon })) },
      viewsWelcome: [
        // D-24: everything mirrors a folder on this computer, so without one the views only offer to open it
        ...([VIEWS.files, VIEWS.actions, VIEWS.sync] as const).map((view) => welcome(view, NO_FOLDER, [
          `${IDENTITY.displayName} keeps a folder on this computer in sync with your board, so it needs that folder open.`,
          '',
          'Open the folder of your project, or create a new empty folder for it.',
          '',
          `[Open Folder](command:${OPEN_FOLDER_COMMAND})`,
          '',
          `Something not working? [Open Doctor](command:${doctor})`,
        ])),
        welcome(VIEWS.files, `${HAS_FOLDER} && ${CONTEXT.interpreterProblem}`, [
          'Python was not found or is not working, so the board cannot be reached.',
          '',
          'The Doctor checks your setup and tells you what to fix.',
          '',
          `[Open Doctor](command:${doctor})`,
        ]),
        welcome(VIEWS.files, `${HAS_FOLDER} && !${CONTEXT.hasPort} && !${CONTEXT.interpreterProblem}`, [
          'No serial port selected.',
          '',
          'Plug your board into a USB port of this computer, then choose its port.',
          '',
          `[Select Serial Port](command:${COMMAND_IDS.selectPort})`,
        ]),
      ],
      commands,
      menus: {
        'view/title': menuEntries('view/title'),
        'view/item/context': menuEntries('view/item/context'),
        commandPalette: hiddenFromPalette,
      },
      configuration: { type: 'object', title: IDENTITY.displayName, properties },
    },
  };
}
