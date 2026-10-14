/**
 * The REPL / Run tab (D-04, RQ-TERM-1, RQ-RUN-1): an `ExtensionTerminalOptions` terminal whose `Pseudoterminal` is only a VIEW
 * on the board session.
 *
 *  - Output: session events `repl` (friendly prompt), `out` (program output) and `err` (traceback text) are decoded with a
 *    streaming UTF-8 decoder and written; the error text keeps its `File "<path>", line N` form untouched so VS Code's own
 *    terminal link detection can make it clickable (pseudoterminals cannot register link providers).
 *  - Input: keys go to the board raw through `tty.write` (see inputForwarder.ts). Environment-activation text typed by other
 *    extensions is filtered out first (see inputFilter.ts).
 *  - Lifetime: opening the tab attaches the REPL view (`repl.attach`), closing it detaches (`repl.detach`): the port stays open.
 *    One terminal is reused; it is created again on demand. Closing the tab also stops a program that the Run command started
 *    (D-17: `stop` = Ctrl-C twice, a toast says so, setting `stopOnTerminalClose`); a program that Run did not start (a
 *    `main.py` that was running at connect) keeps running. Disposing the terminal on deactivation never stops anything here:
 *    window close and reload are handled by the bridge (RQ-SAFE-4).
 *  - Nothing here ever types a command into a shell, and nothing here resets the board.
 */
import * as vscode from 'vscode';
import { MEDIA } from '../contributes';
import { IDENTITY } from '../identity';
import type { Logger } from '../log';
import type { Services } from '../types/services';
import { showToast } from '../toast';
import { isBoardError, userMessage, type SessionEvent } from '../types/session';
import { offerReset, reportError, STOP_CALL_TIMEOUT_MS } from './commandSupport';
import { ActivationInputFilter } from './inputFilter';
import { InputForwarder } from './inputForwarder';
import { RunTracker } from './runTracker';
import { TerminalTextStream } from './streamText';

const RUN_WINDOW_CLOSED = 'Your program was stopped because the Run window was closed.';

export type NoticeKind = 'info' | 'warn' | 'error';

/** How a Run ended, as the Run command reports it to the terminal. */
export type RunOutcome =
  | { kind: 'finished'; exit: 'ok' | 'exception' | 'interrupted' | 'disconnected'; durationMs: number }
  | { kind: 'failed'; message: string };

const STYLE: Record<NoticeKind, string> = { info: '\x1b[90m', warn: '\x1b[33m', error: '\x1b[31m' };
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const FOOTERS = {
  ok: { text: 'program finished', kind: 'info' },
  exception: { text: 'program finished with an error', kind: 'warn' },
  interrupted: { text: 'program stopped', kind: 'warn' },
  disconnected: { text: 'board disconnected', kind: 'error' },
} as const satisfies Record<string, { text: string; kind: NoticeKind }>;

/** Optional observer of what the tab shows and receives; used only by the extension-host test hook (src/testApi.ts). */
export interface TerminalTap {
  /** Plain text handed to the tab (before colour codes are added). */
  output?(text: string): void;
  /** Data the tab received from VS Code (keys, sendText of other extensions), before the activation-text filter. */
  input?(data: string): void;
}

/** Tab icon, one file per theme kind (D-19: fixed colours; VS Code may not theme a currentColor SVG used as a terminal icon). */
export interface TerminalIcon {
  readonly light: vscode.Uri;
  readonly dark: vscode.Uri;
}

/** The icon files of the tab, found through the extension's own folder (never the working directory). */
export function terminalIconPath(extensionUri: vscode.Uri): TerminalIcon {
  const file = (rel: string): vscode.Uri => vscode.Uri.joinPath(extensionUri, ...rel.split('/'));
  return { light: file(MEDIA.terminalLight), dark: file(MEDIA.terminalDark) };
}

export interface ReplTerminalOptions {
  /** Icon of the tab; registerTerminalFeatures sets it from `context.extensionUri`. No icon when absent (unit tests). */
  iconPath?: TerminalIcon;
  /** Observer for tests; absent in production. */
  tap?: TerminalTap;
  /** Clock for the activation-text window (tests). */
  now?: () => number;
  /** Length of that window; default 10 s. */
  activationWindowMs?: number;
  /** Largest `tty.write` (bytes). */
  maxWriteBytes?: number;
  /** Which program Run started (tests share one with the Run command); default: a private one, see `ReplTerminal.runs`. */
  runs?: RunTracker;
}

/** What the commands need from the terminal (so tests can pass a stand-in). */
export interface TerminalPort {
  /** The Run command brackets each `run` call with `runs.begin()` / `runs.end()`; closing the tab consults it (D-17). */
  readonly runs: RunTracker;
  show(preserveFocus?: boolean): vscode.Terminal;
  attach(): Promise<void>;
  beginRun(label: string): void;
  endRun(outcome: RunOutcome): void;
}

interface PtyCallbacks {
  onOpen(pty: ReplPty): void;
  onClose(pty: ReplPty): void;
  onInput(pty: ReplPty, data: string): void;
}

class ReplPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private opened = false;
  private buffered: string[] = [];

  constructor(private readonly callbacks: PtyCallbacks, readonly filter: ActivationInputFilter, readonly forwarder: InputForwarder) {}

  get isOpen(): boolean {
    return this.opened;
  }

  /** VS Code ignores text fired before open(), so it is held back until then. */
  write(text: string): void {
    if (this.opened) {
      this.writeEmitter.fire(text);
    } else {
      this.buffered.push(text);
    }
  }

  open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.opened = true;
    const held = this.buffered.join('');
    this.buffered = [];
    if (held !== '') {
      this.writeEmitter.fire(held);
    }
    this.callbacks.onOpen(this);
  }

  close(): void {
    this.opened = false;
    this.callbacks.onClose(this);
  }

  handleInput(data: string): void {
    this.callbacks.onInput(this, data);
  }

  setDimensions(_dimensions: vscode.TerminalDimensions): void {
    // The board has no notion of a terminal size; nothing to do.
  }
}

export class ReplTerminal implements TerminalPort, vscode.Disposable {
  readonly runs: RunTracker;
  private readonly session: Services['session'];
  private readonly settings: Services['settings'];
  private readonly log: Logger;
  private terminal: vscode.Terminal | undefined;
  private pty: ReplPty | undefined;
  private attached = false;
  private atLineStart = true;
  private lastInputError: string | undefined;
  private disposed = false;
  private readonly streams = { repl: new TerminalTextStream(), out: new TerminalTextStream(), err: new TerminalTextStream() };
  private readonly subscription: { dispose(): unknown };

  constructor(services: Pick<Services, 'session' | 'log' | 'settings'>, private readonly options: ReplTerminalOptions = {}) {
    this.session = services.session;
    this.settings = services.settings;
    this.runs = options.runs ?? new RunTracker();
    this.log = services.log.child('terminal');
    this.subscription = this.session.onEvent((ev) => this.onSessionEvent(ev));
  }

  /** True while the terminal tab exists. */
  get isOpen(): boolean {
    return this.terminal !== undefined && this.terminal.exitStatus === undefined;
  }

  /** Create the tab when it does not exist (or was closed) and reveal it. */
  show(preserveFocus = false): vscode.Terminal {
    const terminal = this.ensureTerminal();
    terminal.show(preserveFocus);
    return terminal;
  }

  /**
   * Tell the bridge to forward the REPL stream to this view (no reset, nothing typed). Safe to call repeatedly. Failures are
   * logged and written into the tab, then thrown so a command can also show a message.
   */
  async attach(): Promise<void> {
    if (this.attached) {
      return;
    }
    this.attached = true;
    try {
      await this.session.call('repl.attach', {});
    } catch (err) {
      this.attached = false;
      this.log.error('Could not attach the terminal to the board', err);
      this.writeNotice(`could not connect this terminal to the board: ${userMessage(err)}`, 'error');
      throw err;
    }
  }

  /** A grey, bracketed line such as `[program finished]`, always on its own line. No-op when there is no tab. */
  writeNotice(text: string, kind: NoticeKind = 'info'): void {
    if (!this.pty) {
      return;
    }
    this.flushStreams();
    this.ensureLineStart();
    this.emit(`[${text}]\r\n`, STYLE[kind]);
  }

  beginRun(label: string): void {
    this.writeNotice(`running ${label}`);
  }

  endRun(outcome: RunOutcome): void {
    if (outcome.kind === 'failed') {
      this.writeNotice(`could not run the program: ${outcome.message}`, 'error');
      return;
    }
    const footer = FOOTERS[outcome.exit];
    this.writeNotice(footer.text, footer.kind);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.subscription.dispose();
    this.terminal?.dispose();
  }

  // ---------------------------------------------------------------- terminal lifetime

  private ensureTerminal(): vscode.Terminal {
    if (this.terminal && this.terminal.exitStatus === undefined) {
      return this.terminal;
    }
    const forwarder = new InputForwarder((b64) => this.writeToBoard(b64), (err) => this.onInputError(err), this.options.maxWriteBytes);
    const filter = new ActivationInputFilter({ now: this.options.now, windowMs: this.options.activationWindowMs });
    const pty = new ReplPty(
      { onOpen: (p) => this.onPtyOpen(p), onClose: (p) => this.onPtyClose(p), onInput: (p, d) => this.onPtyInput(p, d) },
      filter,
      forwarder,
    );
    this.pty = pty;
    this.atLineStart = true;
    for (const s of Object.values(this.streams)) {
      s.flush();
    }
    this.writeHeader();
    this.terminal = vscode.window.createTerminal({ name: IDENTITY.terminalName, pty, ...(this.options.iconPath ? { iconPath: this.options.iconPath } : {}) });
    return this.terminal;
  }

  private onPtyOpen(pty: ReplPty): void {
    if (pty === this.pty && this.session.state.state !== 'disconnected') {
      void this.attachQuietly();
    }
  }

  /** First lines of a new tab: where it points and what to do. Held back by the pty until VS Code opened the tab. */
  private writeHeader(): void {
    const st = this.session.state;
    if (st.state === 'disconnected') {
      this.emit(
        `${IDENTITY.displayName} board terminal. No board is connected: choose Select Serial Port in the sidebar, then Open REPL.\r\n`,
        STYLE.info,
      );
      return;
    }
    const where = st.port ? ` on ${st.port}` : '';
    this.emit(
      `${IDENTITY.displayName} board terminal${where}. Press Enter to see the Python prompt. Ctrl-C stops a running program.\r\n`,
      STYLE.info,
    );
  }

  /**
   * The tab was closed (by the user, by VS Code or by dispose): detach the view and, when the user closed it while a program
   * that Run started is running, stop that program first (D-17). Never a reset.
   */
  private onPtyClose(pty: ReplPty): void {
    if (pty !== this.pty) {
      return;
    }
    pty.forwarder.close();
    this.pty = undefined;
    this.terminal = undefined;
    const wasAttached = this.attached;
    this.attached = false;
    if (this.shouldStopRun()) {
      this.stopRunThenDetach(wasAttached).catch((err: unknown) => this.log.error('Stopping the program after the Run window was closed failed', err));
    } else if (wasAttached) {
      void this.detachQuietly();
    }
  }

  /** All of: not our own dispose (deactivation), setting on, a program that Run started, and the board says it is running. */
  private shouldStopRun(): boolean {
    if (this.disposed || !this.settings.stopOnTerminalClose) {
      return false;
    }
    // `running` is the bridge state; it turns to `idle` before the Run call returns, so a program that just ended is not stopped.
    return this.session.state.state === 'running' && this.runs.claimStop();
  }

  private async stopRunThenDetach(wasAttached: boolean): Promise<void> {
    this.log.info('The Run window was closed while the program started by Run was running: stopping it (Ctrl-C twice, no reset)');
    let failure: unknown;
    let stopped = false;
    try {
      stopped = (await this.session.call('stop', {}, { timeoutMs: STOP_CALL_TIMEOUT_MS })).stopped;
    } catch (err) {
      failure = err;
    }
    // Detach before any message: a message with a button waits for the student.
    if (wasAttached && !this.attached) {
      await this.detachQuietly();
    }
    if (failure !== undefined) {
      await this.reportFailedStop(failure);
    } else if (stopped) {
      this.log.info('Run window closed: the program was stopped');
      void showToast(this.log, 'info', RUN_WINDOW_CLOSED);
    } else {
      await offerReset({ log: this.log }, 'The board did not react when the Run window was closed.');
    }
  }

  private async reportFailedStop(err: unknown): Promise<void> {
    if (isBoardError(err, 'E_NOT_CONNECTED')) {
      this.log.info('Run window closed: the board was already disconnected, nothing to stop');
    } else if (isBoardError(err, 'E_BOARD_UNRESPONSIVE')) {
      this.log.error('Run window closed: the board is not responding to Stop', err);
      await offerReset({ log: this.log }, userMessage(err));
    } else {
      await reportError({ log: this.log }, 'Your program may still be running: it could not be stopped after the Run window was closed.', err);
    }
  }

  private async detachQuietly(): Promise<void> {
    try {
      await this.session.call('repl.detach', {});
    } catch (err) {
      this.log.debug(`repl.detach after closing the terminal: ${userMessage(err)}`);
    }
  }

  private onPtyInput(pty: ReplPty, data: string): void {
    if (pty !== this.pty) {
      return;
    }
    this.options.tap?.input?.(data);
    if (!pty.filter.accept(data)) {
      this.log.info(`Not sent to the board: text that looks like an environment activation command: ${JSON.stringify(data.slice(0, 120))}`);
      return;
    }
    pty.forwarder.push(data);
  }

  private async writeToBoard(b64: string): Promise<void> {
    await this.session.call('tty.write', { b64 });
    this.lastInputError = undefined;
  }

  /** Tell the student once per kind of problem, not once per key. */
  private onInputError(err: unknown): void {
    this.log.warn('Could not send keys to the board', err);
    const code = isBoardError(err) ? err.code : 'other';
    if (code === this.lastInputError) {
      return;
    }
    this.lastInputError = code;
    this.writeNotice(
      code === 'E_NOT_CONNECTED'
        ? 'no board is connected, so your keys were not sent. Choose Select Serial Port, then Open REPL.'
        : `your keys were not sent to the board: ${userMessage(err)}`,
      'warn',
    );
  }

  private async attachQuietly(): Promise<void> {
    try {
      await this.attach();
    } catch (err) {
      // attach() already logged the failure at error level and wrote it into the tab.
      this.log.debug(`attach did not succeed: ${userMessage(err)}`);
    }
  }

  // ---------------------------------------------------------------- session events

  private onSessionEvent(ev: SessionEvent): void {
    switch (ev.ev) {
      case 'repl':
        this.emit(this.streams.repl.push(ev.bytes));
        break;
      case 'out':
        this.emit(this.streams.out.push(ev.bytes));
        break;
      case 'err':
        this.emit(this.streams.err.push(ev.bytes), RED);
        break;
      case 'state':
        this.onState(ev);
        break;
      case 'fatal':
        this.writeNotice(`the connection helper stopped: ${ev.message}. Reload the window to start it again.`, 'error');
        break;
      default:
        break;
    }
  }

  private onState(ev: Extract<SessionEvent, { ev: 'state' }>): void {
    if (ev.state === 'disconnected') {
      this.attached = false;
      if (ev.prev !== 'disconnected') {
        this.writeNotice(disconnectMessage(ev.reason), ev.reason === 'board-reset' ? 'info' : 'warn');
      }
      return;
    }
    const wasAway = ev.prev === 'disconnected' || ev.prev === 'connecting';
    if (wasAway && (ev.state === 'idle' || ev.state === 'running') && this.pty?.isOpen) {
      void this.attachQuietly();
    }
  }

  // ---------------------------------------------------------------- writing

  private flushStreams(): void {
    this.emit(this.streams.repl.flush());
    this.emit(this.streams.out.flush());
    this.emit(this.streams.err.flush(), RED);
  }

  private ensureLineStart(): void {
    if (!this.atLineStart) {
      this.emit('\r\n');
    }
  }

  /** Write `text` (optionally wrapped in an ANSI colour). Line-start tracking looks at the plain text. */
  private emit(text: string, colour?: string): void {
    if (!this.pty || text === '') {
      return;
    }
    this.options.tap?.output?.(text);
    // The colour ends before the line break, so a coloured line never bleeds into the next one.
    const tail = /[\r\n]+$/.exec(text);
    const body = tail ? text.slice(0, tail.index) : text;
    this.pty.write(colour && body !== '' ? `${colour}${body}${RESET}${tail?.[0] ?? ''}` : text);
    this.atLineStart = text.endsWith('\n');
  }
}

function disconnectMessage(reason: string | undefined): string {
  switch (reason) {
    case 'unplugged':
      return 'the board was unplugged or stopped answering. Plug it in again, then choose Select Serial Port and Open REPL.';
    case 'board-reset':
      return 'the board is restarting. The connection comes back by itself; if it does not, choose Select Serial Port.';
    case 'disconnect':
      return 'disconnected from the board. Choose Open REPL to connect again.';
    default:
      return `disconnected from the board${reason ? ` (${reason})` : ''}. Choose Select Serial Port, then Open REPL.`;
  }
}
