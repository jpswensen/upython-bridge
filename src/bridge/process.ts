/**
 * Process plumbing for the bridge: the argv, a small `ChildHandle` abstraction (so tests can use a stub child) and the real
 * implementation over `child_process.spawn` (argv array, `shell:false`, `windowsHide:true`). Killing a child kills its
 * tree: `taskkill /PID n /T /F` on Windows, the process group on POSIX (the child is started as a group leader there).
 * No `vscode` import.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Logger } from '../log';

/** The interpreter to run the bridge with: `py -3` is `{ command: 'py', prefixArgs: ['-3'] }`. */
export interface PythonLauncherSpec {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/** `[...prefix, -I, -u, -X utf8, -X pycache_prefix=<dir>, <extension>/bridge/mpy_bridge.py]` (docs/protocol.md section 1). */
export function buildBridgeArgv(python: PythonLauncherSpec, extensionPath: string, pycacheDir: string): string[] {
  return [
    ...python.prefixArgs, '-I', '-u', '-X', 'utf8', '-X', `pycache_prefix=${pycacheDir}`,
    path.join(extensionPath, 'bridge', 'mpy_bridge.py'),
  ];
}

export interface LaunchSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SpawnFailure extends Error {
  code?: string;
}

export interface ChildHandle {
  readonly pid: number | undefined;
  /** Throws when the pipe is already closed. */
  write(data: string): void;
  /** Close stdin: the bridge treats EOF as "quit" (it interrupts a running program and closes the port). */
  endStdin(): void;
  onStdout(listener: (chunk: Uint8Array) => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  /** Fires once, after the output streams drained (or shortly after the exit event if they do not). */
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  /** Spawn failures (ENOENT, EACCES) and broken pipes. */
  onError(listener: (err: SpawnFailure) => void): void;
  /** Hard kill of the whole process tree. */
  kill(): void;
}

export interface ProcessLauncher {
  launch(spec: LaunchSpec): ChildHandle;
}

/** Kill `pid` and everything it started. `group`: the child was started as a POSIX group leader. Errors are logged, never thrown. */
export function killProcessTree(child: ChildProcess, platform: NodeJS.Platform, group: boolean, log: Logger): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.on('error', (err) => log.warn(`taskkill could not run for process ${pid}`, err));
    } catch (err) {
      log.warn(`taskkill could not be started for process ${pid}`, err);
    }
    return;
  }
  try {
    if (group) {
      process.kill(-pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch (err) {
    try {
      child.kill('SIGKILL');
    } catch (err2) {
      log.warn(`could not kill process ${pid}`, err2 instanceof Error ? err2 : err);
    }
  }
}

class NodeChild implements ChildHandle {
  private exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  private errorListeners: ((err: SpawnFailure) => void)[] = [];
  private exitInfo: { code: number | null; signal: string | null } | undefined;
  private exitEmitted = false;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly child: ChildProcess, private readonly platform: NodeJS.Platform, private readonly group: boolean, private readonly log: Logger) {
    child.on('error', (err: SpawnFailure) => this.errorListeners.forEach((l) => l(err)));
    child.stdin?.on('error', (err: SpawnFailure) => this.errorListeners.forEach((l) => l(err)));
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      // 'close' follows once stdout/stderr drained; do not wait forever if something else holds the pipes
      this.exitTimer = setTimeout(() => this.emitExit(), 500);
    });
    child.on('close', (code, signal) => {
      this.exitInfo ??= { code, signal };
      this.emitExit();
    });
  }

  private emitExit(): void {
    if (this.exitEmitted) {
      return;
    }
    this.exitEmitted = true;
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
    }
    const info = this.exitInfo ?? { code: null, signal: null };
    this.exitListeners.forEach((l) => l(info.code, info.signal));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  write(data: string): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error('The connection to the helper process is closed.');
    }
    stdin.write(data, 'utf8');
  }

  endStdin(): void {
    try {
      this.child.stdin?.end();
    } catch (err) {
      this.log.warn('could not close the helper input', err);
    }
  }

  onStdout(listener: (chunk: Uint8Array) => void): void {
    this.child.stdout?.on('data', (d: Buffer) => listener(d));
  }

  onStderr(listener: (chunk: Uint8Array) => void): void {
    this.child.stderr?.on('data', (d: Buffer) => listener(d));
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  onError(listener: (err: SpawnFailure) => void): void {
    this.errorListeners.push(listener);
  }

  kill(): void {
    killProcessTree(this.child, this.platform, this.group, this.log);
  }
}

export class NodeProcessLauncher implements ProcessLauncher {
  constructor(private readonly log: Logger, private readonly platform: NodeJS.Platform = process.platform) {}

  launch(spec: LaunchSpec): ChildHandle {
    // POSIX: start the child as a process-group leader so the whole group can be killed; Windows uses taskkill /T instead.
    const group = this.platform !== 'win32';
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: group,
    });
    return new NodeChild(child, this.platform, group, this.log);
  }
}
