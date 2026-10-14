/**
 * Shared setup for the sync and board-file tests: a workspace folder on a real temp directory (optionally the awkward
 * OneDrive-style path with spaces, parentheses and non-ASCII), a FakeSession with an in-memory board filesystem, real Settings
 * over the mock configuration, and a SyncService wired like the integrator will wire it. Not a test file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { COMMAND_IDS } from '../../../src/contributes';
import { settingId, stateKey } from '../../../src/identity';
import { SyncService, type Scheduler } from '../../../src/sync';
import type { Services } from '../../../src/types/services';
import { PortMemory, Settings } from '../../../src/types/settings';
import type { BoardSession } from '../../../src/types/session';
import { FAKE_IDENTITY, FakeSession } from '../../mocks/fakeSession';
import { makeTrickyDir, TempDirs } from '../../mocks/fixtures';
import type { MockExtensionContext } from '../../mocks/extensionContext';
import { createExtensionContext, createTestLogger, mock, type MockOutputChannel } from '../../mocks/vscode';
import * as vscode from 'vscode';

export const sha = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

/** A scheduler whose timers only run when the test says so. */
export class ManualScheduler implements Scheduler {
  readonly timers = new Map<number, { fn: () => void; ms: number }>();
  private next = 1;

  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { fn, ms });
    return id;
  }

  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get size(): number { return this.timers.size; }

  /** Run every timer that is waiting (they may schedule more; those run too). */
  runAll(): void {
    for (let guard = 0; guard < 50 && this.timers.size > 0; guard++) {
      const [id, t] = [...this.timers.entries()][0] ?? [];
      if (id === undefined || !t) { return; }
      this.timers.delete(id);
      t.fn();
    }
  }
}

export interface KitOptions {
  session?: FakeSession;
  /** A different BoardSession (for example one over the real bridge); `kit.session` is then an unused FakeSession. */
  boardSession?: BoardSession;
  /** Files on the (fake) board, by absolute device path. */
  board?: Record<string, string>;
  /** Files in the workspace, by workspace-relative POSIX path. */
  local?: Record<string, string>;
  /** Use the OneDrive-style folder name with spaces, parentheses and non-ASCII. */
  tricky?: boolean;
  rootPath?: string;
  autoSync?: 'ask' | 'on' | 'off';
  scheduler?: ManualScheduler;
  /** Register a selectPort stub that reports success (the real one lives in the terminal module). */
  selectPortStub?: boolean;
  /**
   * D-21: the connected board already passed its first-sync review (default true, so tests of the upload mechanics see a board
   * auto-sync may send to). `false`: the review gate is closed, as for a board never synced with this folder on this computer.
   */
  reviewed?: boolean;
}

export interface Kit {
  services: Services;
  session: FakeSession;
  ctx: MockExtensionContext;
  workspace: string;
  dirs: TempDirs;
  channel: MockOutputChannel;
  sync: SyncService;
  scheduler: ManualScheduler;
  write(rel: string, text: string): string;
  read(rel: string): string | undefined;
  exists(rel: string): boolean;
  dispose(): void;
}

export function makeKit(opts: KitOptions = {}): Kit {
  mock.reset();
  const dirs = new TempDirs();
  const base = dirs.make('upy-bridge-sync');
  const workspace = opts.tricky ? makeTrickyDir(base) : path.join(base, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const abs = (rel: string): string => path.join(workspace, ...rel.split('/'));
  for (const [rel, text] of Object.entries(opts.local ?? {})) {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text);
  }
  mock.setWorkspaceFolders(workspace);
  if (opts.rootPath) { mock.config.set(settingId('rootPath'), opts.rootPath); }
  mock.config.set(settingId('autoSync'), opts.autoSync ?? 'ask');
  mock.config.set(settingId('sync.debounceMs'), 100);
  const session = opts.session ?? FakeSession.connected();
  if (!opts.boardSession) { session.useBoardFs(opts.board ?? {}); }
  const ctx = createExtensionContext();
  const { log, channel } = createTestLogger();
  const settings = new Settings();
  const services: Services = { context: ctx.vscode, log, settings, session: opts.boardSession ?? session, portMemory: new PortMemory(ctx.workspaceState) };
  const scheduler = opts.scheduler ?? new ManualScheduler();
  const sync = new SyncService(services, { scheduler });
  if (opts.reviewed !== false) {
    // as if the first-sync review of the fake board (FAKE_IDENTITY.uniqueId) had been answered in an earlier session
    void ctx.workspaceState.update(stateKey(`sync.reviewed.${FAKE_IDENTITY.uniqueId}`), true);
    sync.auto.setReviewed(true);
  }
  if (opts.selectPortStub !== false) {
    mock.track(vscode.commands.registerCommand(COMMAND_IDS.selectPort, async () => {
      if (session.state.state === 'disconnected') { await session.connect('/dev/cu.fake'); }
      return true;
    }));
    mock.track(vscode.commands.registerCommand(COMMAND_IDS.refresh, () => undefined));
  }
  return {
    services, session, ctx, workspace, dirs, channel, sync, scheduler,
    write(rel, text) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), text);
      return abs(rel);
    },
    read(rel) { return fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), 'utf8') : undefined; },
    exists(rel) { return fs.existsSync(abs(rel)); },
    dispose() {
      sync.dispose();
      ctx.dispose();
      dirs.cleanup();
      mock.reset();
    },
  };
}

/** Run `fn` with a kit and always dispose it. */
export async function withKit<T>(opts: KitOptions, fn: (kit: Kit) => Promise<T>): Promise<T> {
  const kit = makeKit(opts);
  try {
    return await fn(kit);
  } finally {
    kit.dispose();
  }
}

/** Poll until `pred` is true (the code under test finishes work in the background). Fails with `what` after `timeoutMs`. */
export async function waitFor(pred: () => boolean, what = 'condition', timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) { throw new Error(`Timed out waiting for ${what}`); }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Let queued promise work finish (a few turns of the event loop). */
export async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
