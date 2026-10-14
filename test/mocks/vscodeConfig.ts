/**
 * `workspace.getConfiguration` stand-in with the real layering default < user < workspace < folder.
 *  - Defaults of this extension's settings come from src/contributes.ts (the table that generates package.json), so a getter
 *    that reads a key the manifest does not declare sees `undefined`, like in VS Code.
 *  - `update()` of a key nobody registered rejects, like "... is not a registered configuration".
 *  - In an untrusted workspace the workspace/folder layers of restricted settings are ignored, like Restricted Mode.
 */
import { SETTINGS, SETTING_DEFAULTS } from '../../src/contributes';
import { settingId } from '../../src/identity';
import { ConfigurationTarget, EventEmitter, type Uri } from './vscodeCore';

export interface ConfigChangeEvent { affectsConfiguration(section: string, scope?: Uri): boolean }

export interface ConfigUpdateRecord { key: string; value: unknown; target: ConfigurationTarget }

function affects(changed: string[], section: string): boolean {
  return changed.some((k) => k === section || k.startsWith(`${section}.`) || section.startsWith(`${k}.`));
}

export class MockConfigStore {
  readonly defaults = new Map<string, unknown>();
  readonly global = new Map<string, unknown>();
  readonly workspace = new Map<string, unknown>();
  readonly folder = new Map<string, unknown>();
  /** Every `update()` that went through, in order (assert that nothing wrote a forbidden value). */
  readonly updates: ConfigUpdateRecord[] = [];
  readonly changed = new EventEmitter<ConfigChangeEvent>();
  private readonly restricted = new Set<string>();

  constructor(private readonly trusted: () => boolean) {
    for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
      this.defaults.set(settingId(key), value);
    }
    for (const s of SETTINGS as readonly { key: string; restricted?: boolean }[]) {
      if (s.restricted) { this.restricted.add(settingId(s.key)); }
    }
  }

  /** Declare a setting of another extension or of VS Code (for example `python.defaultInterpreterPath`). */
  register(key: string, defaultValue?: unknown): void {
    this.defaults.set(key, defaultValue);
  }

  /** Scripted override (no registration check, fires the change event). `value === undefined` removes it. */
  set(key: string, value: unknown, target: ConfigurationTarget = ConfigurationTarget.Workspace): void {
    this.write(key, value, target);
    this.fire([key]);
  }

  private layer(target: ConfigurationTarget): Map<string, unknown> {
    return target === ConfigurationTarget.Global ? this.global : target === ConfigurationTarget.WorkspaceFolder ? this.folder : this.workspace;
  }

  private write(key: string, value: unknown, target: ConfigurationTarget): void {
    const layer = this.layer(target);
    if (value === undefined) { layer.delete(key); } else { layer.set(key, value); }
  }

  private fire(keys: string[]): void {
    this.changed.fire({ affectsConfiguration: (section) => affects(keys, section) });
  }

  effective(key: string): unknown {
    const ignoreWorkspace = !this.trusted() && this.restricted.has(key);
    if (!ignoreWorkspace && this.folder.has(key)) { return this.folder.get(key); }
    if (!ignoreWorkspace && this.workspace.has(key)) { return this.workspace.get(key); }
    if (this.global.has(key)) { return this.global.get(key); }
    return this.defaults.get(key);
  }

  private nested(prefix: string): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    for (const k of this.defaults.keys()) {
      if (k.startsWith(`${prefix}.`)) { out[k.slice(prefix.length + 1)] = this.effective(k); }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  getConfiguration(section?: string, _scope?: unknown): MockWorkspaceConfiguration {
    return new MockWorkspaceConfiguration(this, section);
  }

  async update(key: string, value: unknown, target: ConfigurationTarget): Promise<void> {
    if (!this.defaults.has(key) && value !== undefined) {
      throw new Error(`Unable to write to settings because ${key} is not a registered configuration.`);
    }
    this.updates.push({ key, value, target });
    this.write(key, value, target);
    this.fire([key]);
  }

  inspect(key: string): Record<string, unknown> {
    return {
      key,
      defaultValue: this.defaults.get(key),
      globalValue: this.global.get(key),
      workspaceValue: this.workspace.get(key),
      workspaceFolderValue: this.folder.get(key),
    };
  }

  nestedFor(prefix: string): Record<string, unknown> | undefined {
    return this.nested(prefix);
  }
}

export class MockWorkspaceConfiguration {
  constructor(private readonly store: MockConfigStore, private readonly section: string | undefined) {}

  private full(key: string): string {
    return this.section ? `${this.section}.${key}` : key;
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    const full = this.full(key);
    const v = this.store.effective(full);
    if (v !== undefined) { return v as T; }
    return (this.store.nestedFor(full) as T | undefined) ?? defaultValue;
  }

  has(key: string): boolean {
    const full = this.full(key);
    return this.store.effective(full) !== undefined || this.store.nestedFor(full) !== undefined;
  }

  inspect(key: string): Record<string, unknown> {
    return this.store.inspect(this.full(key));
  }

  update(key: string, value: unknown, target?: ConfigurationTarget | boolean | null): Promise<void> {
    const t = target === true ? ConfigurationTarget.Global : typeof target === 'number' ? target : ConfigurationTarget.Workspace;
    return this.store.update(this.full(key), value, t);
  }
}
