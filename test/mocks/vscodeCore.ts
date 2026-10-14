/**
 * Value types of the vscode API that the extension uses, as small faithful stand-ins (test/mocks/vscode.ts assembles
 * them into the module that tests alias as `vscode`). Windows flavour: `Uri.file` recognises Windows paths by their shape
 * (drive letter or UNC) on any host, and `fsPath` then uses backslashes and a lower-case drive letter, like VS Code on Windows.
 */
import path from 'node:path';

// ------------------------------------------------------------------ Disposable, events

export class Disposable {
  private fn: (() => unknown) | undefined;

  constructor(callOnDispose: () => unknown) {
    this.fn = callOnDispose;
  }

  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }

  dispose(): void {
    const fn = this.fn;
    this.fn = undefined;
    fn?.();
  }
}

/** Errors thrown by event listeners. VS Code logs them; the mock records them and `mock.reset()` fails the test if any remain. */
export const listenerErrors: unknown[] = [];

export type Listener<T> = (e: T) => unknown;
export type EventFn<T> = (listener: Listener<T>, thisArgs?: unknown, disposables?: { dispose(): unknown }[]) => Disposable;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];

  readonly event: EventFn<T> = (listener, thisArgs, disposables) => {
    const bound: Listener<T> = thisArgs ? listener.bind(thisArgs) : listener;
    this.listeners.push(bound);
    const d = new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== bound);
    });
    disposables?.push(d);
    return d;
  };

  get listenerCount(): number {
    return this.listeners.length;
  }

  fire(data: T): void {
    for (const l of [...this.listeners]) {
      try {
        const r = l(data);
        if (r && typeof (r as Promise<unknown>).catch === 'function') {
          (r as Promise<unknown>).catch((e: unknown) => listenerErrors.push(e));
        }
      } catch (e) {
        listenerErrors.push(e);
      }
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

// ------------------------------------------------------------------ Uri

const WIN_DRIVE = /^[a-zA-Z]:([\\/]|$)/;

function encodePath(p: string): string {
  let out = '';
  for (const ch of p) {
    out += /[A-Za-z0-9\-._~/]/.test(ch) ? ch : [...new TextEncoder().encode(ch)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  }
  return out;
}

export interface UriComponents { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}

  static file(p: string): Uri {
    if (p.startsWith('\\\\') || (p.startsWith('//') && !p.startsWith('///'))) {
      const parts = p.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
      return new Uri('file', parts[0] ?? '', `/${parts.slice(1).join('/')}`, '', '');
    }
    if (WIN_DRIVE.test(p)) {
      return new Uri('file', '', `/${p.replace(/\\/g, '/')}`, '', '');
    }
    return new Uri('file', '', p.startsWith('/') ? p : `/${p}`, '', '');
  }

  static parse(value: string): Uri {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!m) {
      return Uri.file(value);
    }
    const [, scheme = 'file', authority = '', rawPath = '', query = '', fragment = ''] = m;
    const decoded = decodeURIComponent(rawPath);
    return new Uri(scheme, authority, decoded.startsWith('/') || scheme !== 'file' ? decoded : `/${decoded}`, query, fragment);
  }

  static from(c: UriComponents): Uri {
    return new Uri(c.scheme, c.authority ?? '', c.path ?? '', c.query ?? '', c.fragment ?? '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, base.authority, path.posix.join(base.path, ...segments), base.query, base.fragment);
  }

  get fsPath(): string {
    if (this.scheme === 'file' && this.authority) {
      return `\\\\${this.authority}${this.path.replace(/\//g, '\\')}`;
    }
    if (/^\/[a-zA-Z]:/.test(this.path)) {
      return `${this.path.charAt(1).toLowerCase()}${this.path.slice(2)}`.replace(/\//g, '\\');
    }
    return this.path;
  }

  with(change: Partial<UriComponents>): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    let p = this.path;
    if (/^\/[a-zA-Z]:/.test(p)) {
      p = `/${p.charAt(1).toLowerCase()}${p.slice(2)}`;
    }
    const auth = this.authority || this.scheme === 'file' ? `//${this.authority}` : '';
    return `${this.scheme}:${auth}${encodePath(p)}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
  }

  toJSON(): UriComponents & { fsPath: string } {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath };
  }
}

// ------------------------------------------------------------------ positions, tree and decoration types

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number' && typeof b === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c ?? a, d ?? b);
    } else {
      this.start = a as Position;
      this.end = b as Position;
    }
  }
}

export class Selection extends Range {
  constructor(readonly anchor: Position, readonly active: Position) {
    super(anchor, active);
  }
}

export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum UIKind { Desktop = 1, Web = 2 }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2, Three = 3 }
export enum ExtensionMode { Production = 1, Development = 2, Test = 3 }
export enum TerminalExitReason { Unknown = 0, Shutdown = 1, Process = 2, User = 3, Extension = 4 }
export enum QuickPickItemKind { Separator = -1, Default = 0 }
export enum TaskScope { Global = 1, Workspace = 2 }
export enum TaskRevealKind { Always = 1, Silent = 2, Never = 3 }

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');

  constructor(readonly id: string, readonly color?: ThemeColor) {}
}

export class MarkdownString {
  isTrusted?: boolean;
  supportThemeIcons?: boolean;

  constructor(public value = '', supportThemeIcons = false) {
    this.supportThemeIcons = supportThemeIcons;
  }

  appendText(text: string): this {
    this.value += text;
    return this;
  }

  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
}

export class TreeItem {
  label?: string | { label: string };
  resourceUri?: Uri;
  id?: string;
  iconPath?: unknown;
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  command?: { command: string; title: string; arguments?: unknown[] };
  contextValue?: string;

  constructor(labelOrUri: string | Uri | { label: string }, public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    if (labelOrUri instanceof Uri) {
      this.resourceUri = labelOrUri;
    } else {
      this.label = labelOrUri;
    }
  }
}

export class FileDecoration {
  constructor(public badge?: string, public tooltip?: string, public color?: ThemeColor, public propagate?: boolean) {}
}

export class FileSystemError extends Error {
  constructor(message: string | Uri, readonly code = 'Unknown') {
    super(typeof message === 'string' ? message : message.toString());
    this.name = `FileSystemError (${code})`;
  }

  static FileNotFound(m?: string | Uri): FileSystemError { return new FileSystemError(m ?? 'file not found', 'FileNotFound'); }
  static FileExists(m?: string | Uri): FileSystemError { return new FileSystemError(m ?? 'file exists', 'FileExists'); }
  static FileNotADirectory(m?: string | Uri): FileSystemError { return new FileSystemError(m ?? 'not a directory', 'FileNotADirectory'); }
  static FileIsADirectory(m?: string | Uri): FileSystemError { return new FileSystemError(m ?? 'is a directory', 'FileIsADirectory'); }
  static NoPermissions(m?: string | Uri): FileSystemError { return new FileSystemError(m ?? 'no permissions', 'NoPermissions'); }
  static Unavailable(m?: string | Uri): FileSystemError { return new FileSystemError(m ?? 'unavailable', 'Unavailable'); }
}

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>();
  private cancelled = false;

  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };

  cancel(): void {
    if (!this.cancelled) {
      this.cancelled = true;
      this.token.isCancellationRequested = true;
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export class RelativePattern {
  readonly baseUri: Uri;
  readonly base: string;

  constructor(base: string | Uri | { uri: Uri }, readonly pattern: string) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof Uri ? base : base.uri;
    this.base = this.baseUri.fsPath;
  }
}

// ------------------------------------------------------------------ tasks (RQ-TERM-4: real terminals only via tasks + ProcessExecution)

export class ProcessExecution {
  constructor(readonly process: string, readonly args: string[] = [], readonly options?: { cwd?: string; env?: Record<string, string> }) {}
}

export class Task {
  presentationOptions: { reveal?: TaskRevealKind; focus?: boolean; echo?: boolean } = {};

  constructor(
    readonly definition: { type: string; [k: string]: unknown },
    readonly scope: TaskScope | { uri: Uri },
    readonly name: string,
    readonly source: string,
    readonly execution?: ProcessExecution,
  ) {}
}

// ------------------------------------------------------------------ diagnostics and code actions (quick fix on unresolved imports)

export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }

export class Diagnostic {
  source?: string;
  code?: string | number | { value: string | number; target: Uri };

  constructor(readonly range: Range, readonly message: string, readonly severity: DiagnosticSeverity = DiagnosticSeverity.Error) {}
}

export class CodeActionKind {
  static readonly Empty = new CodeActionKind('');
  static readonly QuickFix = new CodeActionKind('quickfix');
  static readonly Refactor = new CodeActionKind('refactor');
  private constructor(readonly value: string) {}
}

export class CodeAction {
  diagnostics?: Diagnostic[];
  command?: { command: string; title: string; arguments?: unknown[] };
  isPreferred?: boolean;

  constructor(public title: string, public kind?: CodeActionKind) {}
}
