/**
 * The sync baseline: what a file looked like (content hash and size) the last time it was verified identical on the
 * computer and on the board. One JSON file per (workspace folder, board) inside `context.storageUri`, NEVER in the project
 * (D-06, RQ-CLOUD-3): the old extension kept absolute paths and mtimes in the project folder, which broke as soon as the
 * folder synced to another machine or the student swapped boards.
 *
 * Pure Node (no `vscode`). Writes are atomic (temp + rename with retries, RQ-CLOUD-5) and serialised, so auto-sync and a bulk
 * sync that finish at the same time cannot overwrite each other's entries.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import type { SyncBaseline } from '../types/sync';
import { writeFileAtomic, type AtomicIo } from './atomic';

export const BASELINE_VERSION = 1;

export type BaselineEntry = SyncBaseline['files'][string];

export interface BoardKey {
  /** The id stored in the file; `machine.unique_id()` hex, or a derived `no-id-...` key for boards that have none. */
  id: string;
  /** True when `id` is derived from the board model instead of a real unique id (history is then shared by identical boards). */
  derived: boolean;
}

/** Stable short key for a workspace folder (the URI string), used in file names. */
export function workspaceKeyOf(workspaceFolderUri: string): string {
  return createHash('sha256').update(workspaceFolderUri).digest('hex').slice(0, 16);
}

/** Baseline key of a board: its unique id when it has one, else a hash of what identifies the model. */
export function boardKeyOf(identity: { uniqueId: string; machine: string; build: string; impl: string } | null): BoardKey {
  if (identity && identity.uniqueId !== '') {
    return { id: identity.uniqueId.toLowerCase(), derived: false };
  }
  const text = identity ? `${identity.impl}|${identity.machine}|${identity.build}` : 'unknown';
  return { id: `no-id-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`, derived: true };
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

function emptyBaseline(boardId: string): SyncBaseline {
  return { version: BASELINE_VERSION, boardId, files: {} };
}

function cleanEntries(raw: unknown): Record<string, BaselineEntry> {
  const out: Record<string, BaselineEntry> = {};
  if (typeof raw !== 'object' || raw === null) {
    return out;
  }
  for (const [rel, e] of Object.entries(raw)) {
    const entry = e as Partial<BaselineEntry> | null;
    if (entry && typeof entry.sha256 === 'string' && HEX64.test(entry.sha256) && typeof entry.size === 'number' && entry.size >= 0) {
      out[rel] = { sha256: entry.sha256, size: entry.size, syncedAt: typeof entry.syncedAt === 'string' ? entry.syncedAt : '' };
    }
  }
  return out;
}

export interface BaselineStoreOptions {
  io?: AtomicIo;
  now?: () => Date;
  /** Receives one English line per recoverable problem (unreadable file moved aside, ...). */
  warn?: (message: string) => void;
}

export class BaselineStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;

  /**
   * @param storageDir `context.storageUri.fsPath` (created on first write; VS Code does not create it)
   * @param workspaceKey from `workspaceKeyOf`
   */
  constructor(private readonly storageDir: string, private readonly workspaceKey: string, private readonly options: BaselineStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? (() => undefined);
  }

  fileFor(board: BoardKey): string {
    return nodePath.join(this.storageDir, 'baselines', `${this.workspaceKey}-${board.id.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  }

  /** Read the baseline of a board; an empty one when none exists. An unreadable or newer-format file is moved aside, not lost. */
  async load(board: BoardKey): Promise<SyncBaseline> {
    const file = this.fileFor(board);
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyBaseline(board.id);
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await this.setAside(file, 'it is not valid JSON');
      return emptyBaseline(board.id);
    }
    const doc = parsed as Partial<SyncBaseline> | null;
    if (!doc || typeof doc !== 'object' || doc.version !== BASELINE_VERSION || doc.boardId !== board.id) {
      await this.setAside(file, doc && doc.version !== BASELINE_VERSION ? `its format version is ${String(doc.version)}` : 'it belongs to another board');
      return emptyBaseline(board.id);
    }
    return { version: BASELINE_VERSION, boardId: board.id, files: cleanEntries(doc.files) };
  }

  private async setAside(file: string, why: string): Promise<void> {
    const aside = `${file}.unreadable-${this.now().toISOString().replace(/[:.]/g, '')}`;
    await fsp.rename(file, aside);
    this.warn(`The saved sync history for this board could not be used (${why}). It was kept as ${nodePath.basename(aside)} and a fresh history was started; the next sync will compare both sides file by file.`);
  }

  /** Serialised read-modify-write. `mutate` edits the entries in place. */
  update(board: BoardKey, mutate: (files: Record<string, BaselineEntry>) => void): Promise<SyncBaseline> {
    const run = async (): Promise<SyncBaseline> => {
      const current = await this.load(board);
      mutate(current.files);
      await writeFileAtomic(this.fileFor(board), `${JSON.stringify(current, null, 2)}\n`, { io: this.options.io });
      return current;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined); // keep the queue alive; the caller still gets the rejection from `next`
    return next;
  }

  /** Record files that were verified identical on both sides, and forget files that no longer exist on both. */
  record(board: BoardKey, verified: readonly { path: string; sha256: string; size: number }[], forget: readonly string[] = []): Promise<SyncBaseline> {
    const stamp = this.now().toISOString();
    return this.update(board, (files) => {
      for (const f of verified) {
        files[f.path] = { sha256: f.sha256, size: f.size, syncedAt: stamp };
      }
      for (const rel of forget) {
        delete files[rel];
      }
    });
  }

  /** Forget everything under `rel` (the file itself or a folder prefix). */
  forgetUnder(board: BoardKey, rel: string): Promise<SyncBaseline> {
    return this.update(board, (files) => {
      for (const key of Object.keys(files)) {
        if (key === rel || key.startsWith(`${rel}/`)) {
          delete files[key];
        }
      }
    });
  }

  /** Move entries of a renamed file or folder to the new name. */
  rename(board: BoardKey, from: string, to: string): Promise<SyncBaseline> {
    return this.update(board, (files) => {
      for (const key of Object.keys(files)) {
        const entry = files[key];
        if (entry && (key === from || key.startsWith(`${from}/`))) {
          delete files[key];
          files[`${to}${key.slice(from.length)}`] = entry;
        }
      }
    });
  }
}
