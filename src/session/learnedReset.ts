/**
 * What an explicit hard-reset verification taught us about a board (D-16, RQ-RESET-4), kept across workspaces in
 * `context.globalState` and keyed by (VID, PID, machine.unique_id()). The bridge keeps its own copy for one session; this is
 * what makes `reset.capability` remember "verified" or "failed" after a restart. Written only when a verification finished.
 */
import { IDENTITY } from '../identity';
import type { LearnedReset, ResetCacheKey } from '../types/protocol';
import type { MementoLike } from '../types/settings';

export interface LearnedEntry {
  key: string;
  learned: 'verified' | 'failed';
  at: number;
}

type Stored = Record<string, { learned: 'verified' | 'failed'; at: number }>;

export class LearnedResetStore {
  private readonly storageKey = `${IDENTITY.prefix}.learnedReset`;

  /** `store` is `context.globalState`. */
  constructor(private readonly store: MementoLike, private readonly now: () => number = Date.now) {}

  /** null when the board cannot be told apart from others (no USB ids, as on a socket or pty). */
  keyOf(k: ResetCacheKey | null | undefined): string | null {
    if (!k || (k.vid === null && k.pid === null)) {
      return null;
    }
    return `${k.vid ?? '-'}:${k.pid ?? '-'}:${k.uniqueId ?? '-'}`;
  }

  private read(): Stored {
    const v = this.store.get<Stored>(this.storageKey);
    return v && typeof v === 'object' ? v : {};
  }

  get(k: ResetCacheKey | null | undefined): LearnedReset {
    const key = this.keyOf(k);
    const e = key === null ? undefined : this.read()[key];
    return e && (e.learned === 'verified' || e.learned === 'failed') ? e.learned : null;
  }

  async set(k: ResetCacheKey, learned: 'verified' | 'failed'): Promise<void> {
    const key = this.keyOf(k);
    if (key === null) {
      return;
    }
    await this.store.update(this.storageKey, { ...this.read(), [key]: { learned, at: this.now() } });
  }

  async forget(k: ResetCacheKey): Promise<void> {
    const key = this.keyOf(k);
    if (key === null) {
      return;
    }
    const all = { ...this.read() };
    delete all[key];
    await this.store.update(this.storageKey, all);
  }

  /** Everything learned so far, for the Doctor. */
  all(): LearnedEntry[] {
    return Object.entries(this.read()).map(([key, e]) => ({ key, learned: e.learned, at: e.at }));
  }
}
