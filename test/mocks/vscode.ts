/**
 * The `vscode` module for unit tests: scripts/run-tests.mjs aliases `vscode` to this file, so `import * as vscode from 'vscode'`
 * in src/ gets these implementations while TypeScript still type-checks against @types/vscode.
 *
 *   import * as vscode from 'vscode';            // the API under test
 *   import { mock } from '../mocks/vscode';       // the control surface: scripted answers, registries, recorded calls
 *   beforeEach(() => mock.reset());               // always: the mock is one shared instance per test file
 *
 * Strictness copied from VS Code on purpose: createTreeView of an undeclared view id throws, registerCommand of a duplicate id
 * throws, executeCommand of an unknown id rejects, update() of an unregistered setting rejects, listener errors are collected
 * and make `mock.reset()` throw. Prompts nobody scripted are cancelled (dismissed) and recorded; set `mock.strictPrompts` to throw.
 */
import type { TreeDataProvider, TreeViewOptions } from 'vscode';
import { allCommandIds, VIEWS } from '../../src/contributes';
import { createTestLogger, MockFileSystemWatcher, MockOutputChannel, MockStatusBarItem, MockTerminal, MockTextDocument, MockTextEditor, MockTreeView, type DocumentHost, type MockTerminalOptions } from './vscodeUi';
import { MockConfigStore } from './vscodeConfig';
import { DiskFileSystem, MemoryFileSystem, type MockFileSystem } from './vscodeFs';
import { IDENTITY } from '../../src/identity';
import { CancellationTokenSource, Disposable, EventEmitter, listenerErrors, Uri, UIKind, ViewColumn, type Diagnostic, type EventFn } from './vscodeCore';

export * from './vscodeCore';
export { createTestLogger, MockOutputChannel, MockStatusBarItem, MockTerminal, MockTextDocument, MockTextEditor, MockTreeView, MockFileSystemWatcher };
export { MockConfigStore } from './vscodeConfig';
export { DiskFileSystem, MemoryFileSystem } from './vscodeFs';
export { createExtensionContext, MockMemento } from './extensionContext';

export const version = '1.90.0';

// ------------------------------------------------------------------ recorded calls

export interface MessageCall { level: 'info' | 'warn' | 'error'; message: string; modal: boolean; detail?: string; items: string[]; answered: string | undefined }
export interface QuickPickCall { labels: string[]; options: unknown; answered: unknown; scripted: boolean }
export interface InputBoxCall { options: unknown; answered: string | undefined; validationMessage?: string; scripted: boolean }
export interface ProgressCall { options: { location?: unknown; title?: string; cancellable?: boolean }; reports: { message?: string; increment?: number }[]; done: boolean; cancel(): void }

type MessageAnswer = string | undefined | ((call: { message: string; items: string[] }) => string | undefined);
interface MessageRule { match: RegExp | string | undefined; level: MessageCall['level'] | undefined; answer: MessageAnswer; once: boolean }

type PickAnswer = undefined | number | string | RegExp | object | ((items: readonly unknown[], options: unknown) => unknown);
type InputAnswer = string | undefined | ((options: { prompt?: string; value?: string }) => string | undefined);

const LANG_BY_EXT: Record<string, string> = { '.py': 'python', '.json': 'json', '.jsonc': 'jsonc', '.md': 'markdown', '.txt': 'plaintext' };

function labelOf(item: unknown): string {
  return typeof item === 'string' ? item : String((item as { label?: unknown }).label ?? '');
}

function titleOf(item: unknown): string {
  return typeof item === 'string' ? item : String((item as { title?: unknown }).title ?? '');
}

/** The control surface of the mock. One shared instance; `reset()` puts everything back to the initial state. */
export class MockHost {
  // configuration, trust, workspace, environment
  config!: MockConfigStore;
  trusted = true;
  workspaceFolders: { uri: Uri; name: string; index: number }[] = [];
  env!: { remoteName: string | undefined; uiKind: UIKind; language: string; appName: string; clipboard: string; openedExternal: string[] };
  strictPrompts = false;
  /**
   * Real VS Code never settles the promise of a message WITHOUT buttons until the user dismisses the toast; this mock resolves it
   * at once, which hid a command that never finished (the first real extension-host run). Set this to `true` to behave like
   * VS Code: such messages are recorded, then stay pending forever. Messages with buttons still follow the scripted answers.
   */
  holdButtonlessToasts = false;
  terminalAutoOpen = true;
  fsMode: 'disk' | 'memory' = 'disk';
  readonly diskFs: MockFileSystem = new DiskFileSystem();
  memoryFs!: MemoryFileSystem;
  fsLog!: { op: string; uri: string }[];

  // registries
  outputChannels!: MockOutputChannel[];
  statusBarItems!: MockStatusBarItem[];
  treeViews!: Map<string, MockTreeView<unknown>>;
  terminals!: MockTerminal[];
  everCreatedTerminals!: MockTerminal[];
  decorationProviders!: { provideFileDecoration(uri: Uri): unknown; onDidChangeFileDecorations?: EventFn<unknown> }[];
  terminalLinkProviders!: unknown[];
  contentProviders!: Map<string, { provideTextDocumentContent(uri: Uri): string | Thenable<string> }>;
  watchers!: MockFileSystemWatcher[];
  /** Code action providers registered through `languages.registerCodeActionsProvider`, with their selector. */
  codeActionProviders!: { selector: unknown; provider: { provideCodeActions(doc: unknown, range: unknown, context: { diagnostics: Diagnostic[] }, token: unknown): unknown }; metadata: unknown }[];
  /** Scripted diagnostics per file (`uri.toString()`), returned by `languages.getDiagnostics`. */
  diagnostics!: Map<string, Diagnostic[]>;
  documents!: Map<string, MockTextDocument>;
  activeEditor: MockTextEditor | undefined;
  extensions!: Map<string, { id: string; extensionPath: string; isActive: boolean; packageJSON: Record<string, unknown>; exports: unknown; activate(): Promise<unknown> }>;
  commandHandlers!: Map<string, (...args: unknown[]) => unknown>;
  executedCommands!: { id: string; args: unknown[] }[];
  contextKeys!: Map<string, unknown>;
  tasksExecuted!: unknown[];

  // scripted answers and recorded calls
  private quickPickQueue!: PickAnswer[];
  private inputQueue!: InputAnswer[];
  private openDialogQueue!: (Uri[] | undefined)[];
  private saveDialogQueue!: (Uri | undefined)[];
  private messageRules!: MessageRule[];
  calls!: {
    messages: MessageCall[]; quickPicks: QuickPickCall[]; inputBoxes: InputBoxCall[]; progress: ProgressCall[];
    showTextDocument: { uri: string; options: unknown }[]; statusMessages: string[]; openDialogs: unknown[]; saveDialogs: unknown[];
  };

  // events
  e!: {
    config: MockConfigStore; saved: EventEmitter<MockTextDocument>; changed: EventEmitter<{ document: MockTextDocument }>;
    opened: EventEmitter<MockTextDocument>; closed: EventEmitter<MockTextDocument>; activeEditor: EventEmitter<MockTextEditor | undefined>;
    terminalClosed: EventEmitter<MockTerminal>; terminalOpened: EventEmitter<MockTerminal>; folders: EventEmitter<unknown>;
    trust: EventEmitter<void>; created: EventEmitter<{ files: Uri[] }>; deleted: EventEmitter<{ files: Uri[] }>;
    renamed: EventEmitter<{ files: { oldUri: Uri; newUri: Uri }[] }>; extensionsChanged: EventEmitter<void>;
  };
  private untitled = 0;
  private disposables: { dispose(): unknown }[] = [];

  constructor() {
    this.init();
  }

  private init(): void {
    this.trusted = true;
    this.workspaceFolders = [];
    this.env = { remoteName: undefined, uiKind: UIKind.Desktop, language: 'en', appName: 'Visual Studio Code', clipboard: '', openedExternal: [] };
    this.strictPrompts = false;
    this.holdButtonlessToasts = false;
    this.terminalAutoOpen = true;
    this.fsMode = 'disk';
    this.memoryFs = new MemoryFileSystem();
    this.fsLog = [];
    this.outputChannels = [];
    this.statusBarItems = [];
    this.treeViews = new Map();
    this.terminals = [];
    this.everCreatedTerminals = [];
    this.decorationProviders = [];
    this.terminalLinkProviders = [];
    this.contentProviders = new Map();
    this.watchers = [];
    this.codeActionProviders = [];
    this.diagnostics = new Map();
    this.documents = new Map();
    this.activeEditor = undefined;
    this.extensions = new Map();
    this.commandHandlers = new Map();
    this.executedCommands = [];
    this.contextKeys = new Map();
    this.tasksExecuted = [];
    this.quickPickQueue = [];
    this.inputQueue = [];
    this.openDialogQueue = [];
    this.saveDialogQueue = [];
    this.messageRules = [];
    this.untitled = 0;
    this.disposables = [];
    this.calls = { messages: [], quickPicks: [], inputBoxes: [], progress: [], showTextDocument: [], statusMessages: [], openDialogs: [], saveDialogs: [] };
    const cfg = new MockConfigStore(() => this.trusted);
    this.config = cfg;
    this.e = {
      config: cfg, saved: new EventEmitter(), changed: new EventEmitter(), opened: new EventEmitter(), closed: new EventEmitter(),
      activeEditor: new EventEmitter(), terminalClosed: new EventEmitter(), terminalOpened: new EventEmitter(), folders: new EventEmitter(),
      trust: new EventEmitter(), created: new EventEmitter(), deleted: new EventEmitter(), renamed: new EventEmitter(), extensionsChanged: new EventEmitter(),
    };
  }

  /**
   * Dispose everything the code under test created and return to the initial state. Throws if a listener threw and nobody
   * called `takeListenerErrors()`; call it in `afterEach` (or `beforeEach`) of every test file that uses the mock.
   */
  reset(): void {
    for (const t of [...this.terminals]) { t.dispose(); }
    this.disposables.splice(0).forEach((d) => d.dispose());
    this.init();
    const errors = listenerErrors.splice(0);
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} event listener(s) threw during the test: ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}`);
    }
  }

  takeListenerErrors(): unknown[] { return listenerErrors.splice(0); }

  /** Track a disposable so `reset()` disposes it. */
  track<T extends { dispose(): unknown }>(d: T): T { this.disposables.push(d); return d; }

  // ---------------------------------------------------------------- filesystem

  get fs(): MockFileSystem {
    const base = this.fsMode === 'memory' ? this.memoryFs : this.diskFs;
    const log = (op: string, uri: Uri): void => { this.fsLog.push({ op, uri: uri.toString() }); };
    return {
      stat: (u) => { log('stat', u); return this.routed(u).stat(u); },
      readDirectory: (u) => { log('readDirectory', u); return this.routed(u).readDirectory(u); },
      readFile: (u) => { log('readFile', u); return this.routed(u).readFile(u); },
      writeFile: (u, c) => { log('writeFile', u); return this.routed(u).writeFile(u, c); },
      delete: (u, o) => { log('delete', u); return this.routed(u).delete(u, o); },
      createDirectory: (u) => { log('createDirectory', u); return this.routed(u).createDirectory(u); },
      rename: (a, b, o) => { log('rename', a); return this.routed(a).rename(a, b, o); },
      copy: (a, b, o) => { log('copy', a); return this.routed(a).copy(a, b, o); },
      isWritableFileSystem: (s) => base.isWritableFileSystem(s),
    };
  }

  private routed(uri: Uri): MockFileSystem {
    return this.fsMode === 'memory' || uri.scheme !== 'file' ? this.memoryFs : this.diskFs;
  }

  // ---------------------------------------------------------------- workspace, trust, environment

  setWorkspaceFolders(...folders: (string | Uri)[]): void {
    this.workspaceFolders = folders.map((f, index) => {
      const uri = typeof f === 'string' ? Uri.file(f) : f;
      const name = uri.path.split('/').filter(Boolean).pop() ?? '';
      return { uri, name, index };
    });
    this.e.folders.fire({ added: this.workspaceFolders, removed: [] });
  }

  setTrusted(trusted: boolean): void {
    const was = this.trusted;
    this.trusted = trusted;
    if (!was && trusted) { this.e.trust.fire(); }
  }

  /** Pretend VS Code runs in a remote window (`env.remoteName`), for example `ssh-remote` or `wsl`. */
  setRemote(name: string | undefined): void { this.env.remoteName = name; }

  addExtension(id: string, packageJSON: Record<string, unknown> = {}, isActive = true): void {
    this.extensions.set(id.toLowerCase(), { id, extensionPath: '', isActive, packageJSON, exports: undefined, activate: async () => undefined });
    this.e.extensionsChanged.fire();
  }

  // ---------------------------------------------------------------- scripted answers

  /** Queue the answer for the next `showQuickPick`: a label, a RegExp, an index, an item, an array (canPickMany), a function or undefined (cancel). */
  answerQuickPick(answer: PickAnswer): void { this.quickPickQueue.push(answer); }

  /** Queue the answer for the next `showInputBox`; undefined cancels. A value rejected by `validateInput` also returns undefined. */
  answerInputBox(answer: InputAnswer): void { this.inputQueue.push(answer); }

  /**
   * Rule for show{Information,Warning,Error}Message: when the message text matches (RegExp, substring or undefined = any) the
   * button with the title `answer` is "clicked" (undefined = dismissed). Rules stay until reset unless `once`.
   */
  answerMessage(match: RegExp | string | undefined, answer: MessageAnswer, opts: { level?: MessageCall['level']; once?: boolean } = {}): void {
    this.messageRules.push({ match, level: opts.level, answer, once: opts.once ?? false });
  }

  answerOpenDialog(uris: Uri[] | undefined): void { this.openDialogQueue.push(uris); }
  answerSaveDialog(uri: Uri | undefined): void { this.saveDialogQueue.push(uri); }
  nextOpenDialog(): Uri[] | undefined { return this.openDialogQueue.shift(); }
  nextSaveDialog(): Uri | undefined { return this.saveDialogQueue.shift(); }

  /** Messages shown so far at a level (all levels when omitted). */
  messages(level?: MessageCall['level']): MessageCall[] { return this.calls.messages.filter((m) => !level || m.level === level); }

  async pickQuickPick(items: readonly unknown[] | Thenable<readonly unknown[]>, options: unknown): Promise<unknown> {
    const resolved = await items;
    const scripted = this.quickPickQueue.length > 0;
    if (!scripted && this.strictPrompts) { throw new Error(`Unscripted showQuickPick with items ${JSON.stringify(resolved.map(labelOf))}`); }
    const a = this.quickPickQueue.shift();
    let answered: unknown;
    if (typeof a === 'function') { answered = a(resolved, options); }
    else if (typeof a === 'number') { answered = resolved[a]; }
    else if (typeof a === 'string' || a instanceof RegExp) {
      answered = resolved.find((i) => (typeof a === 'string' ? labelOf(i) === a : a.test(labelOf(i))));
      if (answered === undefined) { throw new Error(`Scripted quick pick answer ${String(a)} is not among: ${JSON.stringify(resolved.map(labelOf))}`); }
    } else { answered = a; }
    this.calls.quickPicks.push({ labels: resolved.map(labelOf), options, answered, scripted });
    return answered;
  }

  async askInputBox(options: { prompt?: string; value?: string; validateInput?: (v: string) => string | undefined | null | Thenable<string | undefined | null> } = {}): Promise<string | undefined> {
    const scripted = this.inputQueue.length > 0;
    if (!scripted && this.strictPrompts) { throw new Error(`Unscripted showInputBox: ${options.prompt ?? ''}`); }
    const a = this.inputQueue.shift();
    let value = typeof a === 'function' ? a(options) : a;
    const call: InputBoxCall = { options, answered: undefined, scripted };
    if (value !== undefined && options.validateInput) {
      const problem = await options.validateInput(value);
      if (problem) { call.validationMessage = problem; value = undefined; }
    }
    call.answered = value;
    this.calls.inputBoxes.push(call);
    return value;
  }

  showMessage(level: MessageCall['level'], message: string, rest: unknown[]): unknown {
    const first = rest[0];
    const hasOptions = first !== undefined && typeof first === 'object' && first !== null && !('title' in first);
    const options = hasOptions ? (first as { modal?: boolean; detail?: string }) : {};
    const items = hasOptions ? rest.slice(1) : rest;
    const titles = items.map(titleOf);
    let answered: string | undefined;
    for (const rule of [...this.messageRules]) {
      const textOk = rule.match === undefined || (typeof rule.match === 'string' ? message.includes(rule.match) : rule.match.test(message));
      if (!textOk || (rule.level && rule.level !== level)) { continue; }
      answered = typeof rule.answer === 'function' ? rule.answer({ message, items: titles }) : rule.answer;
      if (rule.once) { this.messageRules.splice(this.messageRules.indexOf(rule), 1); }
      break;
    }
    if (answered !== undefined && !titles.includes(answered)) {
      throw new Error(`Scripted answer "${answered}" is not a button of message "${message}" (buttons: ${JSON.stringify(titles)})`);
    }
    if (answered === undefined && this.strictPrompts && titles.length > 0) { throw new Error(`Unscripted message with buttons: ${message}`); }
    this.calls.messages.push({ level, message, modal: options.modal === true, detail: options.detail, items: titles, answered });
    if (this.holdButtonlessToasts && titles.length === 0) { return new Promise<never>(() => undefined); }
    return answered === undefined ? undefined : items[titles.indexOf(answered)];
  }

  // ---------------------------------------------------------------- documents and editors

  readonly documentHost: DocumentHost = {
    writeBack: async (doc) => this.fs.writeFile(doc.uri, new TextEncoder().encode(doc.getText())),
    fireSaved: (doc) => this.e.saved.fire(doc),
    fireChanged: (doc) => this.e.changed.fire({ document: doc }),
  };

  async openDocument(arg: Uri | string | { content?: string; language?: string }): Promise<MockTextDocument> {
    if (typeof arg === 'object' && !(arg instanceof Uri)) {
      const uri = Uri.from({ scheme: 'untitled', path: `Untitled-${++this.untitled}` });
      const doc = new MockTextDocument(uri, arg.content ?? '', arg.language ?? 'plaintext', true, this.documentHost);
      this.documents.set(uri.toString(), doc);
      this.e.opened.fire(doc);
      return doc;
    }
    const uri = typeof arg === 'string' ? Uri.file(arg) : arg;
    const key = uri.toString();
    const existing = this.documents.get(key);
    if (existing) { return existing; }
    const provider = this.contentProviders.get(uri.scheme);
    const text = provider ? await provider.provideTextDocumentContent(uri) : new TextDecoder().decode(await this.fs.readFile(uri));
    const ext = uri.path.slice(uri.path.lastIndexOf('.'));
    const doc = new MockTextDocument(uri, text, LANG_BY_EXT[ext] ?? 'plaintext', false, this.documentHost);
    this.documents.set(key, doc);
    this.e.opened.fire(doc);
    return doc;
  }

  /** Make `docOrUri` the active editor (as if the user clicked its tab). */
  async openEditor(docOrUri: MockTextDocument | Uri | string, column?: ViewColumn): Promise<MockTextEditor> {
    const doc = docOrUri instanceof MockTextDocument ? docOrUri : await this.openDocument(docOrUri);
    this.activeEditor = new MockTextEditor(doc, column ?? ViewColumn.One);
    this.e.activeEditor.fire(this.activeEditor);
    return this.activeEditor;
  }

  /** Close the document (fires onDidCloseTextDocument). */
  closeDocument(doc: MockTextDocument): void {
    doc.isClosed = true;
    this.documents.delete(doc.uri.toString());
    if (this.activeEditor?.document === doc) { this.activeEditor = undefined; this.e.activeEditor.fire(undefined); }
    this.e.closed.fire(doc);
  }

  /** Write the file on disk/memory and fire the save event, as if the user pressed Ctrl+S on new contents. */
  async saveFile(uri: Uri, text: string): Promise<MockTextDocument> {
    const doc = await this.openDocument(uri);
    doc.setText(text);
    await doc.save();
    return doc;
  }

  // ---------------------------------------------------------------- commands contract helper

  /** Declared (package.json table) versus registered (handlers) command ids, for the activation contract test. */
  commandContract(): { declared: string[]; registered: string[]; missing: string[]; extra: string[] } {
    const declared = allCommandIds();
    const own = [...this.commandHandlers.keys()].filter((id) => id.startsWith(`${IDENTITY.prefix}.`));
    return { declared, registered: own, missing: declared.filter((d) => !this.commandHandlers.has(d)), extra: own.filter((r) => !declared.includes(r)) };
  }

  // ---------------------------------------------------------------- terminals

  createTerminal(options: MockTerminalOptions | string, shellPath?: string, shellArgs?: string[]): MockTerminal {
    const opts: MockTerminalOptions = typeof options === 'string' ? { name: options, shellPath, shellArgs } : options;
    const t = new MockTerminal(opts, (closed) => {
      this.terminals = this.terminals.filter((x) => x !== closed);
      this.e.terminalClosed.fire(closed);
    }, this.terminalAutoOpen);
    this.terminals.push(t);
    this.everCreatedTerminals.push(t);
    this.e.terminalOpened.fire(t);
    return t;
  }

  newCancellation(): CancellationTokenSource { return new CancellationTokenSource(); }
}

export const mock = new MockHost();

// ------------------------------------------------------------------ the `vscode` namespaces

const ev = <T>(get: () => EventEmitter<T>): EventFn<T> => (l, t, d) => get().event(l, t, d);

export const window = {
  createOutputChannel(name: string): MockOutputChannel {
    const ch = new MockOutputChannel(name);
    mock.outputChannels.push(ch);
    return ch;
  },
  createStatusBarItem(a?: number | string, b?: number, c?: number): MockStatusBarItem {
    const item = typeof a === 'string' ? new MockStatusBarItem(b ?? 1, c, a) : new MockStatusBarItem(a ?? 1, b);
    mock.statusBarItems.push(item);
    return item;
  },
  setStatusBarMessage(text: string, hideAfterTimeout?: number): Disposable {
    mock.calls.statusMessages.push(text);
    void hideAfterTimeout;
    return new Disposable(() => undefined);
  },
  createTreeView<T>(viewId: string, options: TreeViewOptions<T>): MockTreeView<T> {
    const declared = Object.values(VIEWS) as string[];
    if (!declared.includes(viewId)) {
      throw new Error(`No view is registered with id: ${viewId}`);
    }
    if (mock.treeViews.has(viewId)) { throw new Error(`View ${viewId} already has a tree view`); }
    const view = new MockTreeView<T>(viewId, options.treeDataProvider as TreeDataProvider<T>);
    mock.treeViews.set(viewId, view as MockTreeView<unknown>);
    return view;
  },
  registerTreeDataProvider<T>(viewId: string, provider: TreeDataProvider<T>): Disposable {
    const view = window.createTreeView<T>(viewId, { treeDataProvider: provider });
    return new Disposable(() => view.dispose());
  },
  showQuickPick: (items: readonly unknown[] | Thenable<readonly unknown[]>, options?: unknown): Promise<unknown> => mock.pickQuickPick(items, options),
  showInputBox: (options?: Parameters<MockHost['askInputBox']>[0]): Promise<string | undefined> => mock.askInputBox(options),
  showInformationMessage: async (message: string, ...rest: unknown[]): Promise<unknown> => mock.showMessage('info', message, rest),
  showWarningMessage: async (message: string, ...rest: unknown[]): Promise<unknown> => mock.showMessage('warn', message, rest),
  showErrorMessage: async (message: string, ...rest: unknown[]): Promise<unknown> => mock.showMessage('error', message, rest),
  async showOpenDialog(options?: unknown): Promise<Uri[] | undefined> {
    mock.calls.openDialogs.push(options);
    return mock.nextOpenDialog();
  },
  async showSaveDialog(options?: unknown): Promise<Uri | undefined> {
    mock.calls.saveDialogs.push(options);
    return mock.nextSaveDialog();
  },
  async withProgress<R>(
    options: ProgressCall['options'],
    task: (progress: { report(v: { message?: string; increment?: number }): void }, token: CancellationTokenSource['token']) => Thenable<R>,
  ): Promise<R> {
    const cts = new CancellationTokenSource();
    const rec: ProgressCall = { options, reports: [], done: false, cancel: () => cts.cancel() };
    mock.calls.progress.push(rec);
    try {
      return await task({ report: (v) => { rec.reports.push(v); } }, cts.token);
    } finally {
      rec.done = true;
    }
  },
  createTerminal: (options: MockTerminalOptions | string, shellPath?: string, shellArgs?: string[]): MockTerminal => mock.createTerminal(options, shellPath, shellArgs),
  get terminals(): readonly MockTerminal[] { return mock.terminals; },
  get activeTerminal(): MockTerminal | undefined { return mock.terminals[mock.terminals.length - 1]; },
  onDidCloseTerminal: ev(() => mock.e.terminalClosed),
  onDidOpenTerminal: ev(() => mock.e.terminalOpened),
  registerFileDecorationProvider(provider: MockHost['decorationProviders'][number]): Disposable {
    mock.decorationProviders.push(provider);
    return new Disposable(() => { mock.decorationProviders = mock.decorationProviders.filter((p) => p !== provider); });
  },
  registerTerminalLinkProvider(provider: unknown): Disposable {
    mock.terminalLinkProviders.push(provider);
    return new Disposable(() => { mock.terminalLinkProviders = mock.terminalLinkProviders.filter((p) => p !== provider); });
  },
  get activeTextEditor(): MockTextEditor | undefined { return mock.activeEditor; },
  get visibleTextEditors(): MockTextEditor[] { return mock.activeEditor ? [mock.activeEditor] : []; },
  onDidChangeActiveTextEditor: ev(() => mock.e.activeEditor),
  async showTextDocument(docOrUri: MockTextDocument | Uri, options?: unknown): Promise<MockTextEditor> {
    const doc = docOrUri instanceof MockTextDocument ? docOrUri : await mock.openDocument(docOrUri);
    mock.calls.showTextDocument.push({ uri: doc.uri.toString(), options });
    return mock.openEditor(doc);
  },
};

export const workspace = {
  get workspaceFolders(): MockHost['workspaceFolders'] | undefined { return mock.workspaceFolders.length > 0 ? mock.workspaceFolders : undefined; },
  get name(): string | undefined { return mock.workspaceFolders[0]?.name; },
  get isTrusted(): boolean { return mock.trusted; },
  get textDocuments(): MockTextDocument[] { return [...mock.documents.values()]; },
  get fs(): MockFileSystem { return mock.fs; },
  getWorkspaceFolder(uri: Uri): MockHost['workspaceFolders'][number] | undefined {
    return mock.workspaceFolders.find((f) => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + (f.uri.fsPath.includes('\\') ? '\\' : '/')));
  },
  asRelativePath(pathOrUri: string | Uri): string {
    const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
    const folder = mock.workspaceFolders.find((f) => p.startsWith(f.uri.fsPath));
    return folder ? p.slice(folder.uri.fsPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') : p;
  },
  getConfiguration: (section?: string, scope?: unknown) => mock.config.getConfiguration(section, scope),
  onDidChangeConfiguration: ev(() => mock.e.config.changed),
  onDidChangeWorkspaceFolders: ev(() => mock.e.folders),
  onDidGrantWorkspaceTrust: ev(() => mock.e.trust),
  onDidSaveTextDocument: ev(() => mock.e.saved),
  onDidChangeTextDocument: ev(() => mock.e.changed),
  onDidOpenTextDocument: ev(() => mock.e.opened),
  onDidCloseTextDocument: ev(() => mock.e.closed),
  onDidCreateFiles: ev(() => mock.e.created),
  onDidDeleteFiles: ev(() => mock.e.deleted),
  onDidRenameFiles: ev(() => mock.e.renamed),
  openTextDocument: (arg: Uri | string | { content?: string; language?: string }): Promise<MockTextDocument> => mock.openDocument(arg),
  async saveAll(): Promise<boolean> {
    for (const d of [...mock.documents.values()].filter((x) => x.isDirty && !x.isUntitled)) { await d.save(); }
    return true;
  },
  createFileSystemWatcher(glob: unknown, ignoreCreate?: boolean, ignoreChange?: boolean, ignoreDelete?: boolean): MockFileSystemWatcher {
    const w = new MockFileSystemWatcher(glob, ignoreCreate, ignoreChange, ignoreDelete);
    mock.watchers.push(w);
    return w;
  },
  registerTextDocumentContentProvider(scheme: string, provider: { provideTextDocumentContent(uri: Uri): string | Thenable<string> }): Disposable {
    mock.contentProviders.set(scheme, provider);
    return new Disposable(() => { mock.contentProviders.delete(scheme); });
  },
};

const BUILTIN_COMMAND_PREFIXES = ['vscode.', 'workbench.', 'editor.', 'revealInExplorer', 'setContext', 'list.', 'python.', 'python-envs.'];

export const commands = {
  registerCommand(id: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown): Disposable {
    if (mock.commandHandlers.has(id)) { throw new Error(`command '${id}' already exists`); }
    mock.commandHandlers.set(id, thisArg ? callback.bind(thisArg) : callback);
    return new Disposable(() => { mock.commandHandlers.delete(id); });
  },
  async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
    mock.executedCommands.push({ id, args });
    const handler = mock.commandHandlers.get(id);
    if (handler) { return (await handler(...args)) as T; }
    if (id === 'setContext') { mock.contextKeys.set(String(args[0]), args[1]); return undefined; }
    if (BUILTIN_COMMAND_PREFIXES.some((p) => id.startsWith(p))) { return undefined; }
    throw new Error(`command '${id}' not found`);
  },
  async getCommands(): Promise<string[]> { return [...mock.commandHandlers.keys()]; },
};

export const extensions = {
  getExtension: (id: string) => mock.extensions.get(id.toLowerCase()),
  get all() { return [...mock.extensions.values()]; },
  onDidChange: ev(() => mock.e.extensionsChanged),
};

export const env = {
  get remoteName(): string | undefined { return mock.env.remoteName; },
  get uiKind(): UIKind { return mock.env.uiKind; },
  get language(): string { return mock.env.language; },
  get appName(): string { return mock.env.appName; },
  machineId: 'test-machine',
  sessionId: 'test-session',
  isTelemetryEnabled: false,
  clipboard: {
    readText: async (): Promise<string> => mock.env.clipboard,
    writeText: async (v: string): Promise<void> => { mock.env.clipboard = v; },
  },
  async openExternal(uri: Uri): Promise<boolean> { mock.env.openedExternal.push(uri.toString()); return true; },
};

export const tasks = {
  async executeTask(task: unknown): Promise<unknown> {
    mock.tasksExecuted.push(task);
    return { task, terminate: () => undefined };
  },
};

export const languages = {
  registerCodeActionsProvider(selector: unknown, provider: MockHost['codeActionProviders'][number]['provider'], metadata?: unknown): Disposable {
    const entry = { selector, provider, metadata };
    mock.codeActionProviders.push(entry);
    return new Disposable(() => { mock.codeActionProviders = mock.codeActionProviders.filter((p) => p !== entry); });
  },
  getDiagnostics(uri: Uri): Diagnostic[] { return mock.diagnostics.get(uri.toString()) ?? []; },
};

export const l10n = { t: (message: string): string => message };
