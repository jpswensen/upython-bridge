/**
 * The VS Code side of Python discovery: asks the Python Environments extension (ms-python.vscode-python-envs) and the Python
 * extension (ms-python.python) which interpreter they selected, as HINTS (D-13). Both answers race a short timeout, a missing
 * answer is "not ready" (never "no Python"), a bare name such as `python` is ignored, and every hint is validated by the same
 * probe as every other candidate. Capability is detected per call (`getExtension`), never from a setting. Also wires the
 * events that make a cached discovery result stale. This is the only file of the python folder that imports `vscode`.
 */
import * as vscode from 'vscode';
import { settingId } from '../identity';
import type { Logger } from '../log';
import type { PythonDiscovery, ToolingHint, ToolingResult } from './discovery';

export const ENVS_EXTENSION_ID = 'ms-python.vscode-python-envs';
export const PYTHON_EXTENSION_ID = 'ms-python.python';

const TIMED_OUT = Symbol('timed out');

function race<T>(work: PromiseLike<T> | T, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    Promise.resolve(work).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** `env.execInfo.run.executable`, else an `environmentPath` that is itself a python program (not an environment folder). */
export function pathOfEnvsEnvironment(env: unknown): string | null {
  if (!isRecord(env)) {
    return null;
  }
  const run = isRecord(env.execInfo) && isRecord(env.execInfo.run) ? env.execInfo.run.executable : undefined;
  if (typeof run === 'string' && run !== '') {
    return run;
  }
  const ep = isRecord(env.environmentPath) ? env.environmentPath.fsPath : undefined;
  return typeof ep === 'string' && /(^|[\\/])python[\d.]*(\.exe)?$/i.test(ep) ? ep : null;
}

/** The Python extension's active environment path, unless it is the placeholder `DEFAULT_PYTHON` or a bare command name. */
export function pathOfPythonApi(active: unknown): string | null {
  if (!isRecord(active) || active.id === 'DEFAULT_PYTHON') {
    return null;
  }
  const p = active.path;
  return typeof p === 'string' && /[\\/]/.test(p) ? p : null;
}

export interface ToolingTimeouts {
  /** Time for the Python Environments extension to activate and answer (default 1500 ms: it caps its own wait at 1 s). */
  envsMs?: number;
  /** Time for the Python extension (default 3000 ms). */
  pythonMs?: number;
}

export class ToolingHintSource implements vscode.Disposable {
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private attached = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly log: Logger, private readonly timeouts: ToolingTimeouts = {}) {
    this.subscriptions.push(vscode.extensions.onDidChange(() => this.changed('an extension was installed, removed, enabled or disabled')));
  }

  /** Fires (after a short pause, once per burst) when the selected interpreter or the Python extensions may have changed. */
  onDidChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private changed(why: string): void {
    this.log.debug(`Python tooling changed: ${why}`);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const l of [...this.listeners]) {
        try {
          l();
        } catch (err) {
          this.log.error('a Python tooling listener failed', err);
        }
      }
    }, 250);
  }

  private listen(id: string, subscribe: () => vscode.Disposable | undefined): void {
    if (this.attached.has(id)) {
      return;
    }
    this.attached.add(id);
    try {
      const d = subscribe();
      if (d) {
        this.subscriptions.push(d);
      }
    } catch (err) {
      this.log.warn(`could not watch ${id}`, err);
    }
  }

  readonly getHints = async (folder: string | null): Promise<ToolingResult> => {
    const hints: ToolingHint[] = [];
    const notes: string[] = [];
    const scope = folder === null ? undefined : vscode.Uri.file(folder);

    const envs = vscode.extensions.getExtension(ENVS_EXTENSION_ID);
    if (envs) {
      try {
        const api = await race(envs.activate() as PromiseLike<unknown>, this.timeouts.envsMs ?? 1500);
        if (api === TIMED_OUT) {
          notes.push('The Python Environments extension is installed but was not ready in time (its answer is not needed to continue).');
        } else if (isRecord(api) && typeof api.getEnvironment === 'function') {
          const getEnvironment = api.getEnvironment as (s: vscode.Uri | undefined) => PromiseLike<unknown>;
          this.listen(ENVS_EXTENSION_ID, () => {
            const ev = api.onDidChangeEnvironment;
            return typeof ev === 'function' ? (ev as (l: () => void) => vscode.Disposable)(() => this.changed('Python Environments selection changed')) : undefined;
          });
          const env = await race(getEnvironment.call(api, scope), this.timeouts.envsMs ?? 1500);
          const p = env === TIMED_OUT ? null : pathOfEnvsEnvironment(env);
          if (p) {
            hints.push({ source: 'envs-api', path: p });
          } else {
            notes.push('The Python Environments extension has not selected a Python yet (or did not answer in time).');
          }
        }
      } catch (err) {
        notes.push(`The Python Environments extension failed to answer (${err instanceof Error ? err.message : String(err)}).`);
        this.log.warn('the Python Environments extension failed to answer', err);
      }
    }

    const py = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
    if (py) {
      try {
        const api = await race(py.activate() as PromiseLike<unknown>, this.timeouts.pythonMs ?? 3000);
        const environments = isRecord(api) ? api.environments : undefined;
        if (api === TIMED_OUT) {
          notes.push('The Python extension is installed but was not ready in time.');
        } else if (isRecord(environments) && typeof environments.getActiveEnvironmentPath === 'function') {
          this.listen(PYTHON_EXTENSION_ID, () => {
            const ev = environments.onDidChangeActiveEnvironmentPath;
            return typeof ev === 'function' ? (ev as (l: () => void) => vscode.Disposable)(() => this.changed('Python extension selection changed')) : undefined;
          });
          const active = (environments.getActiveEnvironmentPath as (s: vscode.Uri | undefined) => unknown)(scope);
          const p = pathOfPythonApi(active);
          if (p) {
            hints.push({ source: 'python-api', path: p });
          }
        }
      } catch (err) {
        notes.push(`The Python extension failed to answer (${err instanceof Error ? err.message : String(err)}).`);
        this.log.warn('the Python extension failed to answer', err);
      }
    }
    return { hints, notes };
  };

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.listeners.clear();
    for (const s of this.subscriptions.splice(0)) {
      s.dispose();
    }
  }
}

/** Settings whose change makes a cached discovery result stale. */
export const DISCOVERY_SETTINGS: readonly string[] = [
  settingId('pythonPath'), 'python.defaultInterpreterPath', 'python.useEnvironmentsExtension', 'python-envs.defaultEnvManager',
  'python-envs.pythonProjects', 'python-envs.workspaceSearchPaths', 'python-envs.globalSearchPaths',
];

/**
 * Drop the cached discovery result when a setting, the workspace folders, Workspace Trust or the Python tooling changed.
 * `onChange` runs after the invalidation (the session re-checks the interpreter, the Doctor refreshes).
 */
export function watchDiscoveryInputs(discovery: PythonDiscovery, hints: ToolingHintSource | undefined, log: Logger, onChange?: (why: string) => void): vscode.Disposable[] {
  const stale = (why: string): void => {
    log.debug(`Python discovery result dropped: ${why}`);
    discovery.invalidate();
    onChange?.(why);
  };
  const subs: vscode.Disposable[] = [
    vscode.workspace.onDidChangeConfiguration((e) => {
      const hit = DISCOVERY_SETTINGS.find((s) => e.affectsConfiguration(s));
      if (hit) {
        stale(`setting ${hit} changed`);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => stale('the workspace folders changed')),
    vscode.workspace.onDidGrantWorkspaceTrust(() => stale('the workspace was trusted')),
  ];
  if (hints) {
    subs.push(hints.onDidChange(() => stale('the Python tooling selection changed')));
  }
  return subs;
}
