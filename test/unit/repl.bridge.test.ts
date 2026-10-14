/**
 * The terminal, Run and Stop against the REAL Python bridge and a REAL fake board (tools/fakeboard.py over TCP, never a serial
 * port; MPY_SAFE_MODE is forced by test/mocks/fakeBridge.ts). The session here is a thin test adapter over RawBridge, because
 * src/session belongs to another agent: it only maps the wire to the BoardSession contract the terminal code is written against.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { registerRun } from '../../src/commands/run';
import { registerStop } from '../../src/commands/stop';
import { COMMAND_IDS } from '../../src/contributes';
import { ReplTerminal } from '../../src/repl/terminal';
import type { BoardState, OpArgs, OpName, OpResult } from '../../src/types/protocol';
import {
  BoardError, initialSessionState, type BoardSession, type CallOptions, type ConnectOptions, type Disposable, type SessionEvent, type SessionState,
} from '../../src/types/session';
import { RawBridgeError, integrationSkipReason, stopAll, withBridge, type RawBridge } from '../mocks/fakeBridge';
import { TempDirs, makeTrickyDir } from '../mocks/fixtures';
import { mock } from '../mocks/vscode';
import { makeHarness, stubCommand, type Harness } from './repl.helpers';

/** BoardSession over a RawBridge. Events are delivered in order, and always before the response that follows them. */
class BridgeSession implements BoardSession {
  readonly ops: string[] = [];
  private current: SessionState = { ...initialSessionState(), bridge: 'ready', interpreter: 'ok' };
  private readonly stateListeners = new Set<(s: SessionState) => unknown>();
  private readonly eventListeners = new Set<(e: SessionEvent) => unknown>();
  private cursor: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private selected: string | null = null;

  constructor(private readonly bridge: RawBridge) {
    this.cursor = bridge.events.length;
    this.timer = setInterval(() => this.pump(), 10);
  }

  get state(): SessionState { return this.current; }
  readonly onDidChangeState = (l: (s: SessionState) => unknown): Disposable => { this.stateListeners.add(l); return { dispose: () => this.stateListeners.delete(l) }; };
  onEvent(l: (e: SessionEvent) => unknown): Disposable { this.eventListeners.add(l); return { dispose: () => this.eventListeners.delete(l) }; }
  get selectedPort(): string | null { return this.selected; }
  selectPort(port: string | null): void { this.selected = port; }
  get isRunning(): boolean { return this.current.state === 'running'; }
  get pendingSyncCount(): number { return 0; }
  setPendingSyncCount(): void { /* not used here */ }
  dispose(): void { clearInterval(this.timer); }

  private setState(patch: Partial<SessionState>): void {
    this.current = { ...this.current, ...patch };
    for (const l of [...this.stateListeners]) { l(this.current); }
  }

  private pump(): void {
    while (this.cursor < this.bridge.events.length) {
      const ev = this.bridge.events[this.cursor++];
      if (!ev) { continue; }
      if (ev.ev === 'repl' || ev.ev === 'out' || ev.ev === 'err') {
        const bytes = Uint8Array.from(Buffer.from(ev.b64, 'base64'));
        for (const l of [...this.eventListeners]) { l({ ev: ev.ev, bytes }); }
      } else if (ev.ev === 'state') {
        this.setState({ state: ev.state as BoardState, reason: ev.reason ?? '' });
        for (const l of [...this.eventListeners]) { l({ ev: 'state', state: ev.state, prev: ev.prev, reason: ev.reason }); }
      }
    }
  }

  async call<K extends OpName>(op: K, args: OpArgs<K>, opts?: CallOptions): Promise<OpResult<K>> {
    this.ops.push(op);
    try {
      return await this.bridge.call(op, args, opts?.timeoutMs ?? 60000);
    } catch (err) {
      throw err instanceof RawBridgeError ? new BoardError(err.error, op) : err;
    } finally {
      this.pump();
    }
  }

  async connect(port: string, opts: ConnectOptions = {}): Promise<OpResult<'connect'>> {
    this.selected = port;
    this.setState({ state: 'connecting', port });
    const res = await this.call('connect', { port, ...opts });
    this.setState({ state: res.state === 'idle' ? 'idle' : 'running', sync: res.sync, portInfo: res.portInfo });
    return res;
  }

  async disconnect(opts: { stopFirst?: boolean } = {}): Promise<void> {
    await this.call('disconnect', opts);
    this.setState({ state: 'disconnected', port: null });
  }
}

const dirs = new TempDirs();
let h: Harness | undefined;
let terminal: ReplTerminal | undefined;
let session: BridgeSession | undefined;

beforeEach(() => mock.reset());
afterEach(async () => {
  terminal?.dispose();
  session?.dispose();
  h?.dispose();
  dirs.cleanup();
  mock.reset();
  await stopAll();
  terminal = undefined;
  session = undefined;
  h = undefined;
});

/** A connected session, terminal and registered Run/Stop commands against the fake board. */
async function setUp(bridge: RawBridge, url: string): Promise<{ s: BridgeSession; t: ReplTerminal }> {
  const s = new BridgeSession(bridge);
  session = s;
  await s.connect(url);
  // the adapter implements BoardSession; the cast only bridges the harness's FakeSession-typed parameter
  h = makeHarness(s as unknown as Parameters<typeof makeHarness>[0]);
  const t = new ReplTerminal(h.services);
  terminal = t;
  stubCommand(h, COMMAND_IDS.selectPort, true);
  for (const d of [...registerRun(h.services, { terminal: t }), ...registerStop(h.services)]) { mock.track(d); }
  return { s, t };
}

async function openProgram(source: string): Promise<string> {
  const file = path.join(makeTrickyDir(dirs.make()), 'lab one.py');
  fs.writeFileSync(file, source, 'utf8');
  await mock.openEditor(file);
  return file;
}

const skip = integrationSkipReason();

describe('terminal + Run + Stop against the real bridge and the fake board', { skip, timeout: 90000 }, () => {
  it('the REPL tab shows the friendly prompt output and echoes what the student types', async () => {
    await withBridge(async ({ board, bridge }) => {
      const { s, t } = await setUp(bridge, board.url);
      t.show();
      const tab = mock.terminals[0];
      assert.ok(tab);
      await tab.opened;
      tab.type('1+');
      tab.type('1\r');
      await tab.waitForOutput(/\r\n2\r\n/, 15000);
      assert.deepEqual(s.ops.filter((op) => op.startsWith('reset.')), []);
    });
  });

  it('Run shows unicode output and a traceback that names the local file (spaces, parentheses, non-ASCII) in the File "...", line N form', async () => {
    await withBridge(async ({ board, bridge }) => {
      await setUp(bridge, board.url);
      const file = await openProgram('print("héllo ✓ 中文")\nraise ValueError("boom")\n');
      await vscode.commands.executeCommand(COMMAND_IDS.runActiveFile);
      const tab = mock.terminals[0];
      assert.ok(tab);
      const out = tab.output;
      assert.ok(out.includes('héllo ✓ 中文'), JSON.stringify(out));
      assert.ok(out.includes(`File "${file}", line 2`), `traceback must cite the local path: ${JSON.stringify(out)}`);
      assert.ok(out.includes('ValueError: boom'));
      assert.ok(out.includes('[program finished with an error]'));
      assert.ok(!out.includes('�'));
    });
  });

  it('keystrokes reach a running program (sys.stdin), Ctrl-C and the Stop command end it, and nothing resets the board', async () => {
    await withBridge(async ({ board, bridge }) => {
      const { s, t } = await setUp(bridge, board.url);
      await openProgram('import sys, time\nprint("ready")\nc = sys.stdin.read(1)\nprint("got", c)\nwhile True:\n    time.sleep(0.05)\n');
      const running = Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile));
      const tab = await waitForTab();
      await tab.waitForOutput('ready', 20000);
      tab.type('k');
      await tab.waitForOutput('got k', 15000);
      await vscode.commands.executeCommand(COMMAND_IDS.stop);
      await running;
      assert.ok(tab.output.includes('[program stopped]'), JSON.stringify(tab.output.slice(-300)));
      assert.equal(mock.messages('info').at(-1)?.message, 'Program stopped.');

      // the same with the keyboard: Ctrl-C always means interrupt
      const again = Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.runActiveFile));
      await tab.waitForOutput(/ready[\s\S]*ready/, 20000);
      tab.type('\x03');
      await again;
      assert.equal((tab.output.match(/\[program stopped\]/g) ?? []).length, 2, JSON.stringify(tab.output.slice(-300)));
      assert.deepEqual(s.ops.filter((op) => op.startsWith('reset.')), [], 'neither Stop nor Ctrl-C resets the board');
      assert.equal(t.isOpen, true);
    });
  });
});

async function waitForTab(): Promise<(typeof mock.terminals)[number]> {
  for (let i = 0; i < 200; i++) {
    const tab = mock.terminals[0];
    if (tab) { await tab.opened; return tab; }
    await new Promise<void>((r) => setTimeout(r, 25));
  }
  throw new Error('The terminal never appeared.');
}
