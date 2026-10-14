/**
 * Logger over an output channel. No `vscode` import: the extension passes `vscode.window` to `createLogger`,
 * tests pass the mock (test/mocks/vscode.ts) or a MemoryLogChannel. Every failure that reaches the user
 * must also reach this log (CLAUDE.md engineering rule 9); never use console.* in src/.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** The part of vscode.OutputChannel the logger needs. */
export interface LogChannel {
  appendLine(value: string): void;
  show?(preserveFocus?: boolean): void;
  dispose?(): void;
}

export interface LogChannelFactory {
  createOutputChannel(name: string): LogChannel;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  clock?: () => Date;
}

/** State shared by a logger and all its children, so `setLevel` on the root reaches every scope (internal). */
export interface LogCore {
  channel: LogChannel;
  level: LogLevel;
  clock: () => Date;
  disposed: boolean;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function timestamp(d: Date): string {
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

/** One-line description of an error: `[CODE] message` when it carries a string `code`. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && code ? `[${code}] ${err.message}` : err.message;
  }
  return String(err);
}

export class Logger {
  private readonly core: LogCore;
  private readonly scope: string;

  /** `shared` is internal: `child()` passes the parent's core. */
  constructor(channel: LogChannel, options: LoggerOptions = {}, shared?: LogCore) {
    this.core = shared ?? {
      channel,
      level: options.level ?? 'info',
      clock: options.clock ?? (() => new Date()),
      disposed: false,
    };
    this.scope = options.scope ?? '';
  }

  get level(): LogLevel {
    return this.core.level;
  }

  setLevel(level: LogLevel): void {
    this.core.level = level;
  }

  /** A logger that tags its lines with `[scope]` and shares this logger's channel and level. */
  child(scope: string): Logger {
    return new Logger(this.core.channel, { scope: this.scope ? `${this.scope}.${scope}` : scope }, this.core);
  }

  isEnabled(level: LogLevel): boolean {
    return RANK[level] >= RANK[this.core.level];
  }

  log(level: LogLevel, message: string): void {
    if (this.core.disposed || !this.isEnabled(level)) {
      return;
    }
    const tag = this.scope ? ` [${this.scope}]` : '';
    this.core.channel.appendLine(`${timestamp(this.core.clock())} ${level.toUpperCase().padEnd(5)}${tag} ${message}`);
  }

  debug(message: string): void {
    this.log('debug', message);
  }

  info(message: string): void {
    this.log('info', message);
  }

  warn(message: string, cause?: unknown): void {
    this.log('warn', cause === undefined ? message : `${message} (${describeError(cause)})`);
  }

  error(message: string, cause?: unknown): void {
    this.log('error', cause === undefined ? message : `${message} (${describeError(cause)})`);
    if (cause instanceof Error && cause.stack) {
      this.log('debug', cause.stack);
    }
  }

  /** Reveal the log to the user ("Show log" buttons). */
  show(preserveFocus = false): void {
    this.core.channel.show?.(preserveFocus);
  }

  dispose(): void {
    if (!this.core.disposed) {
      this.core.disposed = true;
      this.core.channel.dispose?.();
    }
  }
}

/** Create the root logger on a new output channel. `factory` is `vscode.window` (or the mock). */
export function createLogger(factory: LogChannelFactory, channelName: string, level: LogLevel = 'info'): Logger {
  return new Logger(factory.createOutputChannel(channelName), { level });
}
