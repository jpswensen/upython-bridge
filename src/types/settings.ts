/**
 * The settings object the code reads: typed getters over workspace configuration, plus port memory.
 * Defaults come from the SAME table that generates package.json (src/contributes.ts), so they cannot drift.
 * The extension never writes a setting at startup and never writes "auto" anywhere (D-11); `update` is for explicit user actions.
 */
import * as vscode from 'vscode';
import { SETTING_DEFAULTS, settingFullId, type SettingKey } from '../contributes';
import { IDENTITY, stateKey } from '../identity';
import { LOG_LEVELS, type LogLevel } from '../log';

export type AutoSyncMode = 'ask' | 'on' | 'off';
const AUTO_SYNC_MODES: readonly AutoSyncMode[] = ['ask', 'on', 'off'];
export type BoardClockMode = 'whenUnset' | 'always' | 'off';
const BOARD_CLOCK_MODES: readonly BoardClockMode[] = ['whenUnset', 'always', 'off'];

/** What modules read. Tests may pass a plain object literal that satisfies it. */
export interface SettingsReader {
  readonly autoSync: AutoSyncMode;
  readonly syncDebounceMs: number;
  /** Device folder that matches the workspace root: leading `/`, no trailing `/`, no `..` (see `normalizeRootPath`). */
  readonly rootPath: string;
  /** Explicit Python interpreter; '' means "discover". An explicit value is never silently ignored (D-13). */
  readonly pythonPath: string;
  /** Manual port override; '' means "ask / auto-detect in the UI". Never the word auto. */
  readonly portOverride: string;
  readonly runFreshStart: boolean;
  readonly showUnverifiedHardReset: boolean;
  readonly stopOnDisconnect: boolean;
  /** D-17: closing the Run/REPL tab stops a program that Run started (never a reset). */
  readonly stopOnTerminalClose: boolean;
  /** D-22: set the board clock from this computer after a connect: only when it is unset (default), always, or never. */
  readonly boardClockOnConnect: BoardClockMode;
  /** `auto`, `off` or a stub family such as `rp2`: used by the IntelliSense setup when no board is connected. */
  readonly intellisenseStubs: string;
  /** Offer the IntelliSense setup after the first successful connect in a workspace. */
  readonly intellisenseOffer: boolean;
  readonly logLevel: LogLevel;
}

export interface MpySettings extends SettingsReader {
  /** Fires with the keys (relative to the prefix) that changed. */
  onDidChange(listener: (changed: readonly SettingKey[]) => unknown): vscode.Disposable;
  /** Tell listeners that the effective value of `keys` changed without a settings edit (the remembered auto-sync answer). */
  notifyChanged?(keys: readonly SettingKey[]): void;
  /** Explicit user action only (for example "save to workspace settings" after the auto-sync question). */
  update(key: SettingKey, value: string | number | boolean, target?: vscode.ConfigurationTarget): Thenable<void>;
}

/** `rootPath` as the board sees it. Falls back to `/` for anything that is not a plain absolute POSIX folder. */
export function normalizeRootPath(raw: string): string {
  const text = raw.trim().replace(/\\/g, '/');
  if (!text.startsWith('/')) {
    return '/';
  }
  const parts = text.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) {
    return '/';
  }
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

/** workspaceState key of the answer to the first-connect auto-sync question ('on' | 'off'); the sync module writes it. */
export const AUTO_SYNC_CHOICE_KEY = stateKey('sync.autoSyncChoice');

export class Settings implements MpySettings, vscode.Disposable {
  private readonly manual = new vscode.EventEmitter<readonly SettingKey[]>();

  /**
   * `state` is `context.workspaceState`: with it, `autoSync` reports the mode in force. When the setting is `ask` and the
   * student already answered the first-connect question, that answer is the mode (so the views never say "Ask" after "Turn on").
   */
  constructor(private readonly scope?: vscode.Uri, private readonly state?: MementoLike) {}

  notifyChanged(keys: readonly SettingKey[]): void {
    this.manual.fire(keys);
  }

  dispose(): void {
    this.manual.dispose();
  }

  private get<T extends string | number | boolean | readonly string[]>(key: SettingKey): T {
    const cfg = vscode.workspace.getConfiguration(IDENTITY.prefix, this.scope);
    return cfg.get<T>(key, SETTING_DEFAULTS[key] as T);
  }

  get autoSync(): AutoSyncMode {
    const v = this.get<string>('autoSync');
    const setting = (AUTO_SYNC_MODES as readonly string[]).includes(v) ? (v as AutoSyncMode) : (SETTING_DEFAULTS.autoSync as AutoSyncMode);
    if (setting === 'ask') {
      const remembered = this.state?.get<string>(AUTO_SYNC_CHOICE_KEY);
      return remembered === 'on' || remembered === 'off' ? remembered : 'ask';
    }
    return setting;
  }

  get syncDebounceMs(): number {
    const v = this.get<number>('sync.debounceMs');
    return Number.isFinite(v) ? Math.min(5000, Math.max(100, v)) : 400;
  }

  get rootPath(): string {
    return normalizeRootPath(this.get<string>('rootPath'));
  }

  get pythonPath(): string {
    return this.get<string>('pythonPath').trim();
  }

  get portOverride(): string {
    const v = this.get<string>('port').trim();
    return v.toLowerCase() === 'auto' ? '' : v;
  }

  get runFreshStart(): boolean {
    return this.get<boolean>('run.freshStart');
  }

  get showUnverifiedHardReset(): boolean {
    return this.get<boolean>('reset.showUnverifiedHardReset');
  }

  get stopOnDisconnect(): boolean {
    return this.get<boolean>('stopOnDisconnect');
  }

  get stopOnTerminalClose(): boolean {
    return this.get<boolean>('stopOnTerminalClose');
  }

  get boardClockOnConnect(): BoardClockMode {
    const v = this.get<string>('board.setClockOnConnect');
    return (BOARD_CLOCK_MODES as readonly string[]).includes(v) ? (v as BoardClockMode) : 'whenUnset';
  }

  get intellisenseStubs(): string {
    const v = this.get<string>('intellisenseStubs').trim().toLowerCase();
    return v === '' ? 'auto' : v;
  }

  get intellisenseOffer(): boolean {
    return this.get<boolean>('intellisenseOffer');
  }

  get logLevel(): LogLevel {
    const v = this.get<string>('logLevel');
    return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : 'info';
  }

  onDidChange(listener: (changed: readonly SettingKey[]) => unknown): vscode.Disposable {
    const keys = Object.keys(SETTING_DEFAULTS) as SettingKey[];
    const fromConfiguration = vscode.workspace.onDidChangeConfiguration((e) => {
      const changed = keys.filter((k) => e.affectsConfiguration(settingFullId(k), this.scope));
      if (changed.length > 0) {
        listener(changed);
      }
    });
    return vscode.Disposable.from(fromConfiguration, this.manual.event((changed) => listener(changed)));
  }

  update(key: SettingKey, value: string | number | boolean, target = vscode.ConfigurationTarget.Workspace): Thenable<void> {
    if (key === 'port' && typeof value === 'string' && value.trim().toLowerCase() === 'auto') {
      return Promise.reject(new Error('The port setting cannot be "auto": choose a real serial port instead.'));
    }
    return vscode.workspace.getConfiguration(IDENTITY.prefix, this.scope).update(key, value, target);
  }
}

// ------------------------------------------------------------------ port memory (D-11): workspaceState, never settings

/** (name, VID, PID): the serial number is deliberately not part of the key (N-11: `0001` is generic). */
export interface RememberedPort { device: string; vid: number | null; pid: number | null }

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export class PortMemory {
  private readonly key = `${IDENTITY.prefix}.rememberedPort`;

  /** `store` is `context.workspaceState`. */
  constructor(private readonly store: MementoLike) {}

  get(): RememberedPort | null {
    const v = this.store.get<RememberedPort>(this.key);
    if (!v || typeof v.device !== 'string' || v.device === '' || v.device.toLowerCase() === 'auto') {
      return null;
    }
    return { device: v.device, vid: typeof v.vid === 'number' ? v.vid : null, pid: typeof v.pid === 'number' ? v.pid : null };
  }

  remember(port: RememberedPort): Thenable<void> {
    if (port.device === '' || port.device.toLowerCase() === 'auto') {
      return Promise.reject(new Error('Only a real serial port can be remembered, not "auto".'));
    }
    return this.store.update(this.key, port);
  }

  forget(): Thenable<void> {
    return this.store.update(this.key, undefined);
  }
}
