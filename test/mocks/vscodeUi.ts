/**
 * UI-side stand-ins that tests inspect: output channels, status bar items, tree views, terminals (with real Pseudoterminal
 * wiring), text documents/editors and file watchers. Created through the mocked `vscode` API, found again through `mock.*`.
 */
import type { ExtensionTerminalOptions, Pseudoterminal, TerminalOptions, TreeDataProvider } from 'vscode';
import { Logger, type LogLevel } from '../../src/log';
import { EventEmitter, Selection, TerminalExitReason, Position, type Uri, type ViewColumn } from './vscodeCore';

// ------------------------------------------------------------------ output channel and logger

export class MockOutputChannel {
  readonly lines: string[] = [];
  private pending = '';
  shown = 0;
  hidden = 0;
  disposed = false;

  constructor(readonly name: string) {}

  append(value: string): void {
    const parts = (this.pending + value).split('\n');
    this.pending = parts.pop() ?? '';
    this.lines.push(...parts);
  }

  appendLine(value: string): void {
    this.append(`${value}\n`);
  }

  replace(value: string): void {
    this.clear();
    this.append(value);
  }

  clear(): void {
    this.lines.length = 0;
    this.pending = '';
  }

  show(): void { this.shown++; }
  hide(): void { this.hidden++; }
  dispose(): void { this.disposed = true; }

  get text(): string {
    return this.lines.concat(this.pending ? [this.pending] : []).join('\n');
  }
}

/** A real Logger over an in-memory channel (for tests of pure modules): `channel.text` holds what the user would see. */
export function createTestLogger(level: LogLevel = 'debug'): { log: Logger; channel: MockOutputChannel } {
  const channel = new MockOutputChannel('test-log');
  return { log: new Logger(channel, { level }), channel };
}

// ------------------------------------------------------------------ status bar

export class MockStatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | { command: string; title?: string; arguments?: unknown[] } | undefined;
  color: unknown;
  backgroundColor: unknown;
  name: string | undefined;
  accessibilityInformation: unknown;
  visible = false;
  disposed = false;

  constructor(readonly alignment: number, readonly priority: number | undefined, readonly id?: string) {}

  show(): void { this.visible = true; }
  hide(): void { this.visible = false; }
  dispose(): void { this.disposed = true; this.visible = false; }
}

// ------------------------------------------------------------------ tree view

export interface TreeSnapshotNode { label: string; description?: string; contextValue?: string; children?: TreeSnapshotNode[] }

export class MockTreeView<T> {
  visible = true;
  selection: T[] = [];
  message: string | undefined;
  title: string | undefined;
  description: string | undefined;
  badge: unknown;
  disposed = false;
  refreshes = 0;
  readonly revealed: T[] = [];
  private readonly visibility = new EventEmitter<{ visible: boolean }>();
  readonly onDidChangeVisibility = this.visibility.event;
  readonly onDidChangeSelection = new EventEmitter<{ selection: T[] }>().event;
  private readonly sub: { dispose(): unknown } | undefined;

  constructor(readonly viewId: string, readonly provider: TreeDataProvider<T>) {
    this.sub = provider.onDidChangeTreeData?.(() => { this.refreshes++; });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.visibility.fire({ visible });
  }

  async reveal(element: T): Promise<void> { this.revealed.push(element); }
  dispose(): void { this.disposed = true; this.sub?.dispose(); }

  /** Children of `element` (root when omitted), as the provider returns them. */
  async children(element?: T): Promise<T[]> {
    return (await this.provider.getChildren(element)) ?? [];
  }

  /** Labels, descriptions and context values of the tree down to `depth` levels, for readable assertions. */
  async snapshot(depth = 3, element?: T): Promise<TreeSnapshotNode[]> {
    const out: TreeSnapshotNode[] = [];
    for (const child of await this.children(element)) {
      const item = await this.provider.getTreeItem(child);
      const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
      const node: TreeSnapshotNode = { label };
      if (typeof item.description === 'string') { node.description = item.description; }
      if (item.contextValue) { node.contextValue = item.contextValue; }
      if (depth > 1 && item.collapsibleState !== undefined && item.collapsibleState !== 0) {
        node.children = await this.snapshot(depth - 1, child);
      }
      out.push(node);
    }
    return out;
  }
}

// ------------------------------------------------------------------ terminals

export type MockTerminalOptions = TerminalOptions | ExtensionTerminalOptions;

export class MockTerminal {
  name: string;
  exitStatus: { code: number | undefined; reason: TerminalExitReason } | undefined;
  readonly pty: Pseudoterminal | undefined;
  /** Everything the extension wrote into the terminal through Pseudoterminal.onDidWrite. */
  readonly written: string[] = [];
  /** `terminal.sendText` calls (the product must never make any: lint rule; extension terminals route them to handleInput). */
  readonly sentText: { text: string; addNewLine: boolean }[] = [];
  shown = 0;
  hiddenCount = 0;
  opened: Promise<void>;
  dimensions: { columns: number; rows: number } | undefined;
  private readonly waiters: { pattern: string | RegExp; resolve: (text: string) => void }[] = [];
  private readonly subs: { dispose(): unknown }[] = [];
  private markOpened: () => void = () => undefined;

  constructor(readonly creationOptions: MockTerminalOptions, private readonly onClosed: (t: MockTerminal) => void, autoOpen: boolean) {
    this.name = creationOptions.name ?? 'terminal';
    this.pty = 'pty' in creationOptions ? creationOptions.pty : undefined;
    this.opened = new Promise<void>((resolve) => { this.markOpened = resolve; });
    const pty = this.pty;
    if (pty) {
      this.subs.push(pty.onDidWrite((s) => { this.written.push(s); this.notifyWaiters(); }));
      if (pty.onDidClose) {
        this.subs.push(pty.onDidClose((code) => this.finish(code === undefined ? undefined : code, TerminalExitReason.Extension)));
      }
      if (pty.onDidChangeName) {
        this.subs.push(pty.onDidChangeName((n) => { this.name = n; }));
      }
      if (autoOpen) {
        queueMicrotask(() => this.open());
      }
    } else {
      this.markOpened();
    }
  }

  /** Call `pty.open` (VS Code does this when the terminal UI is ready). Idempotent. */
  open(columns = 80, rows = 24): void {
    if (this.dimensions || !this.pty) { return; }
    this.dimensions = { columns, rows };
    this.pty.open({ columns, rows });
    this.markOpened();
  }

  get output(): string { return this.written.join(''); }

  sendText(text: string, addNewLine = true): void {
    this.sentText.push({ text, addNewLine });
    this.pty?.handleInput?.(addNewLine ? `${text}\r` : text);
  }

  show(): void { this.shown++; }
  hide(): void { this.hiddenCount++; }

  /** Test helper: the user types `data` into the terminal. */
  type(data: string): void { this.pty?.handleInput?.(data); }

  /** Test helper: the user resizes the terminal. */
  resize(columns: number, rows: number): void {
    this.dimensions = { columns, rows };
    this.pty?.setDimensions?.({ columns, rows });
  }

  /** Test helper: resolves when the output written so far matches `pattern`; rejects after `timeoutMs`. */
  waitForOutput(pattern: string | RegExp, timeoutMs = 2000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Terminal "${this.name}" never showed ${String(pattern)}. Output was: ${JSON.stringify(this.output)}`)), timeoutMs);
      this.waiters.push({ pattern, resolve: (t) => { clearTimeout(timer); resolve(t); } });
      this.notifyWaiters();
    });
  }

  private notifyWaiters(): void {
    const text = this.output;
    for (const w of [...this.waiters]) {
      if (typeof w.pattern === 'string' ? text.includes(w.pattern) : w.pattern.test(text)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(text);
      }
    }
  }

  private finish(code: number | undefined, reason: TerminalExitReason): void {
    if (this.exitStatus) { return; }
    this.exitStatus = { code, reason };
    this.subs.forEach((s) => s.dispose());
    this.onClosed(this);
  }

  dispose(): void {
    if (this.exitStatus) { return; }
    this.pty?.close();
    this.finish(undefined, TerminalExitReason.User);
  }
}

// ------------------------------------------------------------------ documents and editors

export interface DocumentHost {
  writeBack(doc: MockTextDocument): Promise<void>;
  fireSaved(doc: MockTextDocument): void;
  fireChanged(doc: MockTextDocument): void;
}

export class MockTextDocument {
  isDirty = false;
  isClosed = false;
  version = 1;
  private text: string;

  constructor(readonly uri: Uri, text: string, readonly languageId: string, readonly isUntitled: boolean, private readonly host: DocumentHost) {
    this.text = text;
  }

  get fileName(): string { return this.uri.fsPath; }
  get lineCount(): number { return this.text.split('\n').length; }
  getText(): string { return this.text; }

  /** Test helper: the user typed. Marks the document dirty and fires onDidChangeTextDocument. */
  setText(text: string): void {
    this.text = text;
    this.isDirty = true;
    this.version++;
    this.host.fireChanged(this);
  }

  /** Test helper: the file changed on disk. Clean, no save event. */
  reloadFromDisk(text: string): void {
    this.text = text;
    this.isDirty = false;
    this.version++;
  }

  async save(): Promise<boolean> {
    if (this.isUntitled) { return false; }
    await this.host.writeBack(this);
    this.isDirty = false;
    this.host.fireSaved(this);
    return true;
  }
}

export class MockTextEditor {
  selection = new Selection(new Position(0, 0), new Position(0, 0));
  selections = [this.selection];

  constructor(readonly document: MockTextDocument, readonly viewColumn: ViewColumn | undefined) {}
}

// ------------------------------------------------------------------ file watcher

export class MockFileSystemWatcher {
  private readonly create = new EventEmitter<Uri>();
  private readonly change = new EventEmitter<Uri>();
  private readonly del = new EventEmitter<Uri>();
  readonly onDidCreate = this.create.event;
  readonly onDidChange = this.change.event;
  readonly onDidDelete = this.del.event;
  disposed = false;

  constructor(readonly globPattern: unknown, readonly ignoreCreate = false, readonly ignoreChange = false, readonly ignoreDelete = false) {}

  fireCreate(uri: Uri): void { if (!this.ignoreCreate && !this.disposed) { this.create.fire(uri); } }
  fireChange(uri: Uri): void { if (!this.ignoreChange && !this.disposed) { this.change.fire(uri); } }
  fireDelete(uri: Uri): void { if (!this.ignoreDelete && !this.disposed) { this.del.fire(uri); } }
  dispose(): void { this.disposed = true; }
}
