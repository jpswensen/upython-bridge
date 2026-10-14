/**
 * Keys under which the sync module remembers things in `workspaceState` (per workspace, never in the project, never synced
 * between machines). Built from the identity prefix so a rename of the product is a one-file change.
 */
import { stateKey } from '../identity';

export { stateKey };

export const SYNC_STATE = {
  /** 'on' | 'off': the answer to the first-connect auto-sync question (D-10). Absent = not asked yet. */
  autoSyncChoice: stateKey('sync.autoSyncChoice'),
  /** true once the one-time notice about main.py/boot.py being uploaded was shown (RQ-SAFE-7). */
  bootNoticeShown: stateKey('sync.bootNoticeShown'),
} as const;

/** The minimal memento surface used (workspaceState). */
export interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** Device files that run by themselves at every power-up. */
export const STARTUP_FILES: readonly string[] = ['/main.py', '/boot.py'];
