/**
 * Disposal in a known order, in one place. `context.subscriptions` gets ONE entry (the root Teardown), so the order does not
 * depend on how VS Code walks the array: first the "early" items (auto-sync, then the board session, whose dispose interrupts a
 * running program and closes the port, RQ-SAFE-4), then everything else in reverse order of creation, then the "late" items
 * (the log). A failing dispose is logged and never stops the rest.
 */
import type { Logger } from './log';

interface Disposable { dispose(): unknown }

export class Teardown implements Disposable {
  private readonly early: Disposable[] = [];
  private readonly normal: Disposable[] = [];
  private readonly late: Disposable[] = [];
  private done = false;

  constructor(private readonly log: Pick<Logger, 'error'>) {}

  get disposed(): boolean {
    return this.done;
  }

  /** Disposed after the early items, in reverse order of adding. Returns the item. */
  add<T extends Disposable>(item: T): T {
    this.normal.push(item);
    return item;
  }

  addAll(items: readonly Disposable[]): void {
    for (const item of items) {
      this.add(item);
    }
  }

  /** Disposed before everything else; of several early items the one added LAST goes first. */
  addEarly<T extends Disposable>(item: T): T {
    this.early.unshift(item);
    return item;
  }

  /** Disposed after everything else (the log). */
  addLate<T extends Disposable>(item: T): T {
    this.late.push(item);
    return item;
  }

  dispose(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    for (const item of [...this.early, ...[...this.normal].reverse(), ...this.late]) {
      try {
        item.dispose();
      } catch (err) {
        this.log.error('releasing a resource failed', err);
      }
    }
  }
}
