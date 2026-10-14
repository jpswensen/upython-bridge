/**
 * A scripted stand-in for the bridge process: records what the client writes, lets a test say lines on stdout/stderr, exit, fail
 * to start. `StubLauncher` hands out one stub per launch and (by default) answers with a valid hello.
 */
import { Logger } from '../../../src/log';
import type { ChildHandle, LaunchSpec, ProcessLauncher, SpawnFailure } from '../../../src/bridge/process';

export class MemoryLog {
  readonly lines: string[] = [];
  readonly logger = new Logger({ appendLine: (l: string) => { this.lines.push(l); } }, { level: 'debug' });
  has(re: RegExp): boolean { return this.lines.some((l) => re.test(l)); }
}

export const HELLO = { ev: 'hello', proto: 1, bridge: '1.0-test', python: '3.13.0', pyserial: '3.5', platform: 'darwin', pid: 1234, vendored: { mpremote: '1.29.0' } };

export class StubChild implements ChildHandle {
  pid: number | undefined = 4242;
  readonly writes: string[] = [];
  stdinEnded = false;
  killed = 0;
  exited = false;
  /** Leave on stdin EOF (a polite bridge). */
  exitOnEof = true;
  writeError: Error | undefined;
  /** Called for each request line written; use `reply` inside. */
  onRequest: ((req: Record<string, unknown>) => void) | undefined;
  private outL: ((c: Uint8Array) => void)[] = [];
  private errL: ((c: Uint8Array) => void)[] = [];
  private exitL: ((code: number | null, signal: string | null) => void)[] = [];
  private errorL: ((e: SpawnFailure) => void)[] = [];

  write(data: string): void {
    if (this.writeError) { throw this.writeError; }
    this.writes.push(data);
    this.onRequest?.(JSON.parse(data) as Record<string, unknown>);
  }

  endStdin(): void {
    this.stdinEnded = true;
    if (this.exitOnEof) { queueMicrotask(() => this.exit(0)); }
  }

  onStdout(l: (c: Uint8Array) => void): void { this.outL.push(l); }
  onStderr(l: (c: Uint8Array) => void): void { this.errL.push(l); }
  onExit(l: (code: number | null, signal: string | null) => void): void { this.exitL.push(l); }
  onError(l: (e: SpawnFailure) => void): void { this.errorL.push(l); }

  kill(): void {
    this.killed += 1;
    this.exit(null, 'SIGKILL');
  }

  // ---- driver
  requests(): Record<string, unknown>[] { return this.writes.map((w) => JSON.parse(w) as Record<string, unknown>); }
  requestsOf(op: string): Record<string, unknown>[] { return this.requests().filter((r) => r.op === op); }
  say(obj: unknown): void { this.stdout(`${JSON.stringify(obj)}\n`); }
  stdout(text: string | Uint8Array): void {
    const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
    this.outL.forEach((l) => l(bytes));
  }
  stderr(text: string): void { const b = new TextEncoder().encode(text); this.errL.forEach((l) => l(b)); }
  reply(id: unknown, result: Record<string, unknown> = {}): void { this.say({ id, ok: true, ...result }); }
  fail(id: unknown, code: string, message: string, extra: Record<string, unknown> = {}): void {
    this.say({ id, ok: false, error: { code, message, detail: '', hint: '', ...extra } });
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) { return; }
    this.exited = true;
    this.exitL.forEach((l) => l(code, signal));
  }
  error(err: SpawnFailure): void { this.errorL.forEach((l) => l(err)); }
}

export class StubLauncher implements ProcessLauncher {
  readonly children: StubChild[] = [];
  readonly specs: LaunchSpec[] = [];
  /** Send a hello right after launch (default). */
  autoHello: Record<string, unknown> | null = HELLO;
  /** Customise each new child before it speaks. */
  onLaunch: ((child: StubChild, index: number) => void) | undefined;
  launchError: Error | undefined;

  launch(spec: LaunchSpec): ChildHandle {
    if (this.launchError) { throw this.launchError; }
    const child = new StubChild();
    this.children.push(child);
    this.specs.push(spec);
    this.onLaunch?.(child, this.children.length - 1);
    if (this.autoHello) {
      const hello = this.autoHello;
      queueMicrotask(() => { if (!child.exited) { child.say(hello); } });
    }
    return child;
  }

  get last(): StubChild {
    const c = this.children[this.children.length - 1];
    if (!c) { throw new Error('no child was launched'); }
    return c;
  }
}

/** Wait until `pred` holds (microtasks and short timers), or fail with `what`. */
export async function until(pred: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
    await new Promise((r) => setTimeout(r, 2));
  }
}
