/**
 * Fake `vscode.ExtensionContext` for activation and service tests. Storage URIs point at real temp folders (created lazily,
 * removed by `dispose()`), mementos are in-memory, secrets too. Cast to `vscode.ExtensionContext` at the boundary only.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionContext } from 'vscode';
import { makeTempDir, projectRoot, removeDir } from './fixtures';
import { EventEmitter, ExtensionMode, Uri } from './vscodeCore';

export class MockMemento {
  private readonly data = new Map<string, unknown>();
  /** Every `update()` in order, to assert what was persisted. */
  readonly writes: { key: string; value: unknown }[] = [];

  constructor(initial: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries(initial)) { this.data.set(k, v); }
  }

  keys(): readonly string[] { return [...this.data.keys()]; }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.writes.push({ key, value });
    if (value === undefined) { this.data.delete(key); } else { this.data.set(key, value); }
  }

  setKeysForSync(_keys: readonly string[]): void {
    // Settings Sync is not modelled.
  }
}

export class MockSecretStorage {
  private readonly data = new Map<string, string>();
  private readonly changed = new EventEmitter<{ key: string }>();
  readonly onDidChange = this.changed.event;

  async get(key: string): Promise<string | undefined> { return this.data.get(key); }
  async store(key: string, value: string): Promise<void> { this.data.set(key, value); this.changed.fire({ key }); }
  async delete(key: string): Promise<void> { this.data.delete(key); this.changed.fire({ key }); }
}

export interface ContextOptions {
  extensionPath?: string;
  packageJSON?: Record<string, unknown>;
  workspaceState?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
}

export interface MockExtensionContext {
  /** Cast of the fake to the real type, to pass into code under test. */
  readonly vscode: ExtensionContext;
  readonly subscriptions: { dispose(): unknown }[];
  readonly workspaceState: MockMemento;
  readonly globalState: MockMemento;
  readonly secrets: MockSecretStorage;
  readonly storageUri: Uri;
  readonly globalStorageUri: Uri;
  readonly logUri: Uri;
  readonly extensionUri: Uri;
  readonly extensionPath: string;
  asAbsolutePath(relativePath: string): string;
  /** Dispose subscriptions (in reverse order, like VS Code) and delete the temp storage folders. */
  dispose(): void;
}

export function createExtensionContext(options: ContextOptions = {}): MockExtensionContext {
  const extensionPath = options.extensionPath ?? projectRoot();
  const base = makeTempDir('upy-bridge-ctx');
  const dirs = { storage: path.join(base, 'workspaceStorage'), global: path.join(base, 'globalStorage'), log: path.join(base, 'logs') };
  Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
  const subscriptions: { dispose(): unknown }[] = [];
  const workspaceState = new MockMemento(options.workspaceState);
  const globalState = new MockMemento(options.globalState);
  const secrets = new MockSecretStorage();
  const extensionUri = Uri.file(extensionPath);
  const packageJSON = options.packageJSON ?? JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
  const asAbsolutePath = (rel: string): string => path.join(extensionPath, rel);
  const fake = {
    subscriptions, workspaceState, globalState, secrets, extensionUri, extensionPath, asAbsolutePath,
    storageUri: Uri.file(dirs.storage), globalStorageUri: Uri.file(dirs.global), logUri: Uri.file(dirs.log),
    storagePath: dirs.storage, globalStoragePath: dirs.global, logPath: dirs.log,
    extensionMode: ExtensionMode.Test,
    extension: { id: `${String(packageJSON.publisher)}.${String(packageJSON.name)}`, packageJSON, extensionPath, extensionUri },
    environmentVariableCollection: { persistent: true, replace: () => undefined, append: () => undefined, prepend: () => undefined, clear: () => undefined },
  };
  return {
    vscode: fake as unknown as ExtensionContext, // the fake covers the members the extension uses, not the whole interface
    subscriptions, workspaceState, globalState, secrets,
    storageUri: fake.storageUri, globalStorageUri: fake.globalStorageUri, logUri: fake.logUri, extensionUri, extensionPath, asAbsolutePath,
    dispose(): void {
      for (const d of subscriptions.splice(0).reverse()) { d.dispose(); }
      removeDir(base);
    },
  };
}
