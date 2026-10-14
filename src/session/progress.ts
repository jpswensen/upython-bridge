/**
 * Routes the bridge's `progress` events to a progress notification (vscode `withProgress`, injected). Quiet by design: nothing is
 * shown for background work (auto-sync, refresh) or for operations that finish quickly; a notification appears only when an
 * interactive operation has already taken `showAfterMs` and reports progress, and it ends with the operation.
 */
import type { OpName } from '../types/protocol';

export interface ProgressUi {
  /** Show a progress notification until `task` settles; `report(message, fraction)` updates it (fraction 0..1). */
  withProgress<T>(title: string, task: (report: (message: string, fraction?: number) => void) => Promise<T>): Promise<T>;
}

const TITLES: Partial<Record<OpName, string>> = {
  'fs.put': 'Uploading to the board', 'fs.get': 'Downloading from the board', 'fs.manifest': 'Reading the board files',
  'fs.rmtree': 'Deleting from the board', 'introspect.modules': 'Reading the board modules',
};

interface Entry {
  op: OpName;
  startedAt: number;
  background: boolean;
  report?: (message: string, fraction?: number) => void;
  finish?: () => void;
}

export class ProgressRouter {
  private readonly entries = new Map<number | string, Entry>();

  constructor(private readonly ui: ProgressUi, private readonly onError: (err: unknown) => void, private readonly now: () => number = Date.now, private readonly showAfterMs = 600) {}

  begin(id: number, op: OpName, background: boolean): void {
    this.entries.set(id, { op, startedAt: this.now(), background });
  }

  update(ev: { id: number | string; label: string; done: number; total: number }): void {
    const e = this.entries.get(ev.id);
    if (!e || e.background) {
      return;
    }
    const fraction = ev.total > 0 ? Math.min(1, Math.max(0, ev.done / ev.total)) : undefined;
    const message = fraction === undefined ? ev.label : `${ev.label} (${Math.round(fraction * 100)}%)`;
    if (!e.report) {
      if (this.now() - e.startedAt < this.showAfterMs) {
        return;
      }
      const title = TITLES[e.op] ?? 'Working with the board';
      this.ui.withProgress(title, (report) => new Promise<void>((resolve) => {
        e.report = report;
        e.finish = resolve;
      })).catch(this.onError);
    }
    e.report?.(message, fraction);
  }

  end(id: number | string): void {
    const e = this.entries.get(id);
    this.entries.delete(id);
    e?.finish?.();
  }

  /** Close every open notification (the session is going away). */
  endAll(): void {
    for (const id of [...this.entries.keys()]) {
      this.end(id);
    }
  }
}
