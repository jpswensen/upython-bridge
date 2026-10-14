/**
 * The sync planner: a PURE function from (local files, board manifest, baseline) to a SyncPlan
 * (docs/analysis/03-fs-sync.md section 6.4; CLAUDE.md rule 7). No `vscode`, no I/O, no clock beyond an injectable `now`.
 *
 * Decision table, per file, with L = local content, B = board content, S = baseline (hash at the last verified sync):
 *
 *   L = B                                   unchanged ('identical'); the baseline is refreshed by the engine
 *   L != B, no S                            conflict  ('first-sync-differs')
 *   L != B, L changed (L != S), B = S       Local -> Board: upload   | Board -> Local: conflict (your edits would be lost)
 *   L != B, L = S, B changed                Local -> Board: conflict | Board -> Local: download  (the board was edited)
 *   L != B, both changed                    conflict ('both-changed')
 *   only L, S exists                        Local -> Board: upload ('board-missing') | Board -> Local: unchanged
 *   only L, no S                            Local -> Board: upload ('new-local')     | Board -> Local: unchanged
 *   only B, S exists                        Local -> Board: unchanged ('local-deleted') | Board -> Local: download
 *   only B, no S                            Local -> Board: unchanged ('board-only')    | Board -> Local: download
 *
 * Deletes are never part of a plan unless `allowDeletes` is set, and even then they start unselected. A conflict is never
 * selected by default: ticking it in the preview means "yes, overwrite" for the direction of the plan (the engine backs up
 * the side that is overwritten first). Boards that cannot hash (`hash: 'none'`) are compared by size; equal sizes with no
 * hash are reported in `ambiguous` so the caller can download-compare them and call `buildPlan` again with `downloaded`.
 */
import nodePath from 'node:path';
import type { SyncDirection, SyncItem, SyncPlan, SyncReason, SyncBaseline } from '../types/sync';
import {
  PathMapper, describeProblem, findCollisions, hostIsCaseInsensitive, matchKey, relPathProblem, shadowedModule,
  type PathFlavor, type ShadowGuard,
} from './paths';

export interface PlanLocalFile {
  path: string;
  abs: string;
  size: number;
  sha256: string;
}

export interface PlanBoardEntry {
  /** Device path, absolute POSIX. */
  remote: string;
  type: 'file' | 'dir';
  size: number;
  /** Missing when the board cannot hash, or could not hash this one file. */
  sha256?: string;
}

export interface PlanInput {
  direction: SyncDirection;
  workspaceRoot: string;
  /** Board folder that corresponds to the workspace folder (normalised). */
  rootPath: string;
  boardId: string | null;
  local: readonly PlanLocalFile[];
  /** Non-ignored local folders (workspace-relative POSIX), used to create empty folders. */
  localDirs?: readonly string[];
  board: readonly PlanBoardEntry[];
  /** What `fs.manifest` said about hashing the whole listing. */
  boardHash: 'sha256' | 'none';
  baseline: Readonly<SyncBaseline['files']>;
  /** Board hashes learned by downloading ambiguous files, by workspace-relative path. */
  downloaded?: Readonly<Record<string, string>>;
  /** Include delete items (always unselected). Default false: a plan never deletes. */
  allowDeletes?: boolean;
  shadow?: ShadowGuard;
  /** Predicate for board names the local ignore rules skip when downloading. */
  ignoredOnBoard?: (rel: string, isDir: boolean) => boolean;
  /** `path.win32` in tests for Windows rules; default is the host's. */
  flavor?: PathFlavor;
  localCaseInsensitive?: boolean;
  /** Notes collected earlier (scan warnings, listing warnings). */
  warnings?: readonly string[];
  now?: Date;
}

export interface PlanOutput {
  plan: SyncPlan;
  /** Workspace-relative paths whose comparison needs the board file's content (same size, no hash). */
  ambiguous: string[];
}

const ACTION_ORDER: Record<SyncItem['action'], number> = {
  upload: 0, download: 0, mkdir: 1, 'delete-board': 2, 'delete-local': 2, conflict: 3, unchanged: 4,
};

type Tri = boolean | undefined;

export function buildPlan(input: PlanInput): PlanOutput {
  const flavor = input.flavor ?? nodePath;
  const caseInsensitive = input.localCaseInsensitive ?? hostIsCaseInsensitive();
  const mapper = new PathMapper(input.workspaceRoot, input.rootPath, flavor);
  const warnings = [...(input.warnings ?? [])];
  const downloaded = input.downloaded ?? {};
  const key = (rel: string): string => matchKey(rel, caseInsensitive);
  const toBoard = input.direction === 'toBoard';
  const items: SyncItem[] = [];
  const ambiguous: string[] = [];

  // --- local side (files that can be sent: usable names only)
  const local = new Map<string, PlanLocalFile>();
  for (const f of input.local) {
    const problem = toBoard ? relPathProblem(f.path, { windows: false }) : undefined;
    if (problem) {
      warnings.push(`${describeProblem(problem, f.path)} It was not sent.`);
      continue;
    }
    local.set(key(f.path), f);
  }

  // --- board side: names must be usable on this computer before anything is downloaded
  const boardDirs = new Set<string>();
  const boardFiles = new Map<string, { rel: string; entry: PlanBoardEntry }>();
  const rels: string[] = [];
  let ignoredOnBoardCount = 0;
  for (const e of input.board) {
    const rel = mapper.deviceToRel(e.remote);
    if (rel === undefined) {
      continue; // the root folder itself or something outside it
    }
    if (e.type === 'dir') {
      boardDirs.add(key(rel));
    }
    if (!toBoard) {
      const problem = relPathProblem(rel, { windows: mapper.windows });
      if (problem) {
        warnings.push(`${describeProblem(problem, rel)} It was not downloaded.`);
        continue;
      }
      if (input.ignoredOnBoard?.(rel, e.type === 'dir')) {
        if (e.type === 'file') {
          ignoredOnBoardCount++;
        }
        continue;
      }
    }
    if (e.type === 'file') {
      rels.push(rel);
      boardFiles.set(key(rel), { rel, entry: e });
    }
  }
  if (ignoredOnBoardCount > 0) {
    warnings.push(`${ignoredOnBoardCount} file(s) on the board match your ignore list and were not downloaded.`);
  }
  if (!toBoard) {
    for (const group of findCollisions(rels, { caseInsensitive })) {
      warnings.push(`These board files would become the same file on this computer: ${group.join(', ')}. None of them was downloaded. Rename them on the board.`);
      for (const rel of group) {
        boardFiles.delete(key(rel));
      }
    }
  }

  const baseline = new Map<string, { rel: string; sha256: string; size: number }>();
  for (const [rel, b] of Object.entries(input.baseline)) {
    baseline.set(key(rel), { rel, sha256: b.sha256, size: b.size });
  }

  const make = (
    rel: string, action: SyncItem['action'], reason: SyncReason, size: number, extra: Partial<SyncItem> & { remote?: string } = {},
  ): SyncItem => {
    const { remote, ...rest } = extra;
    return {
      path: rel,
      remote: remote ?? mapper.relToDevice(rel),
      local: safeLocal(mapper, rel),
      kind: 'file',
      action,
      reason,
      size,
      selected: action !== 'conflict' && action !== 'delete-board' && action !== 'delete-local',
      ...rest,
    };
  };

  const allKeys = new Set<string>([...local.keys(), ...boardFiles.keys()]);
  for (const k of [...allKeys].sort()) {
    const L = local.get(k);
    const bf = boardFiles.get(k);
    const B = bf?.entry;
    const S = baseline.get(k);
    const rel = L?.path ?? bf?.rel ?? S?.rel ?? k;
    const base = { localSha256: L?.sha256, baseSha256: S?.sha256 };

    if (L && !B) {
      const reason: SyncReason = S ? 'board-missing' : 'new-local';
      if (toBoard) {
        items.push(make(rel, 'upload', reason, L.size, base));
      } else if (input.allowDeletes) {
        items.push(make(rel, 'delete-local', reason, 0, base));
      } else {
        items.push(make(rel, 'unchanged', reason, 0, base));
      }
      continue;
    }

    if (!L && B && bf) {
      const reason: SyncReason = S ? 'local-deleted' : 'board-only';
      const boardSha = downloaded[rel] ?? B.sha256;
      const extra = { ...base, boardSha256: boardSha, remote: B.remote };
      if (!toBoard) {
        items.push(make(bf.rel, 'download', reason, B.size, extra));
      } else if (input.allowDeletes) {
        items.push(make(bf.rel, 'delete-board', reason, 0, extra));
      } else {
        items.push(make(bf.rel, 'unchanged', reason, 0, extra));
      }
      continue;
    }

    if (!L || !B || !bf) {
      continue; // present only in the baseline: nothing exists on either side now
    }

    // both sides have the file
    const bh = downloaded[rel] ?? downloaded[bf.rel] ?? B.sha256;
    const info = { ...base, boardSha256: bh, remote: B.remote };
    const equal: Tri = bh !== undefined ? bh === L.sha256 : L.size !== B.size ? false : undefined;
    if (equal === true) {
      items.push(make(rel, 'unchanged', 'identical', 0, info));
      continue;
    }
    const shadowItemReason = (a: SyncItem['action'], r: SyncReason): SyncItem => make(rel, a, r, a === 'download' ? B.size : L.size, info);
    if (equal === undefined) {
      ambiguous.push(rel);
      items.push(shadowItemReason('conflict', 'first-sync-differs'));
      continue;
    }
    if (!S) {
      items.push(shadowItemReason('conflict', 'first-sync-differs'));
      continue;
    }
    const localChanged = L.sha256 !== S.sha256;
    const boardChanged: Tri = bh !== undefined ? bh !== S.sha256 : B.size !== S.size ? true : undefined;
    if (boardChanged === undefined) {
      ambiguous.push(rel);
      items.push(shadowItemReason('conflict', 'first-sync-differs'));
    } else if (localChanged && boardChanged) {
      items.push(shadowItemReason('conflict', 'both-changed'));
    } else if (localChanged) {
      items.push(toBoard ? shadowItemReason('upload', 'local-changed') : shadowItemReason('conflict', 'local-changed'));
    } else if (boardChanged) {
      items.push(toBoard ? shadowItemReason('conflict', 'board-changed') : shadowItemReason('download', 'board-changed'));
    } else {
      items.push(shadowItemReason('conflict', 'first-sync-differs'));
    }
  }

  // --- empty folders: created on the other side so the structure matches (files create their own parents)
  const filePaths = [...local.values()].map((f) => f.path).concat([...boardFiles.values()].map((b) => b.rel));
  const hasFilesUnder = (dir: string): boolean => filePaths.some((p) => p.startsWith(`${dir}/`));
  if (toBoard) {
    const dirsHere = input.localDirs ?? [];
    for (const dir of dirsHere) {
      const hasSubdir = dirsHere.some((d) => d.startsWith(`${dir}/`));
      if (!boardDirs.has(key(dir)) && !hasFilesUnder(dir) && !hasSubdir && relPathProblem(dir, { windows: false }) === undefined) {
        items.push(make(dir, 'mkdir', 'new-local', 0, { kind: 'dir' }));
      }
    }
  } else {
    const localDirKeys = new Set((input.localDirs ?? []).map(key));
    const boardDirRels = input.board.filter((e) => e.type === 'dir').map((e) => mapper.deviceToRel(e.remote)).filter((r): r is string => r !== undefined);
    for (const e of input.board) {
      const rel = e.type === 'dir' ? mapper.deviceToRel(e.remote) : undefined;
      if (rel !== undefined && !input.board.some((b) => b.remote.startsWith(`${e.remote}/`)) && !boardDirRels.some((d) => d.startsWith(`${rel}/`)) && !localDirKeys.has(key(rel)) && !hasFilesUnder(rel) && relPathProblem(rel, { windows: mapper.windows }) === undefined
        && !input.ignoredOnBoard?.(rel, true)) {
        items.push(make(rel, 'mkdir', 'board-only', 0, { kind: 'dir', remote: e.remote }));
      }
    }
  }

  // --- guards that depend on the direction
  const kept: SyncItem[] = [];
  for (const it of items) {
    if (toBoard && it.kind === 'file' && (it.action === 'upload' || it.action === 'conflict')) {
      const hit = input.shadow ? shadowedModule(it.remote, input.shadow) : undefined;
      if (hit !== undefined) {
        warnings.push(`${it.path} was not sent: on the board the name "${hit}" belongs to a built-in module, and your file would hide it and break programs. Rename the file (for example to my_${hit}.py).`);
        continue;
      }
    }
    if (!toBoard && (it.action === 'download' || it.action === 'conflict' || it.action === 'mkdir')) {
      if (it.local === '' || mapper.tooLongForWindows(it.local)) {
        warnings.push(`${it.path} was not downloaded: its location on this computer is too long for Windows. Move the project folder closer to the top of the drive.`);
        continue;
      }
    }
    kept.push(it);
  }

  kept.sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (ambiguous.length > 0 && input.boardHash === 'none') {
    warnings.push('This board cannot compute checksums, so files with the same size could not be compared by content.');
  }
  const unresolved = ambiguous.length;
  if (unresolved > 0 && input.boardHash !== 'none') {
    warnings.push(`${unresolved} board file(s) could not be checksummed, so they are listed as different.`);
  }

  return {
    plan: {
      direction: input.direction,
      createdAt: (input.now ?? new Date()).toISOString(),
      workspaceRoot: input.workspaceRoot,
      rootPath: mapper.rootPath,
      boardId: input.boardId,
      compare: input.boardHash === 'sha256' ? 'sha256' : 'size',
      items: kept,
      warnings,
    },
    ambiguous,
  };
}

function safeLocal(mapper: PathMapper, rel: string): string {
  try {
    return mapper.relToLocal(rel);
  } catch {
    return ''; // the name cannot exist on this computer; callers skip items with an empty local path and say why
  }
}

// ------------------------------------------------------------------ helpers for callers

export interface PlanCounts {
  upload: number;
  download: number;
  mkdir: number;
  deleteBoard: number;
  deleteLocal: number;
  conflict: number;
  unchanged: number;
  selected: number;
}

export function countPlan(plan: SyncPlan): PlanCounts {
  const c: PlanCounts = { upload: 0, download: 0, mkdir: 0, deleteBoard: 0, deleteLocal: 0, conflict: 0, unchanged: 0, selected: 0 };
  for (const it of plan.items) {
    if (it.action === 'upload') { c.upload++; }
    else if (it.action === 'download') { c.download++; }
    else if (it.action === 'mkdir') { c.mkdir++; }
    else if (it.action === 'delete-board') { c.deleteBoard++; }
    else if (it.action === 'delete-local') { c.deleteLocal++; }
    else if (it.action === 'conflict') { c.conflict++; }
    else { c.unchanged++; }
    if (it.selected && it.action !== 'unchanged') {
      c.selected++;
    }
  }
  return c;
}

/** Items the engine will act on: selected and not "unchanged". */
export function actionable(plan: SyncPlan): SyncItem[] {
  return plan.items.filter((i) => i.selected && i.action !== 'unchanged');
}

/** What an item will really do given the direction of its plan (a ticked conflict resolves toward the plan's direction). */
export function effectiveAction(plan: SyncPlan, item: SyncItem): 'upload' | 'download' | 'mkdir' | 'delete-board' | 'delete-local' | 'none' {
  switch (item.action) {
    case 'conflict': return plan.direction === 'toBoard' ? 'upload' : 'download';
    case 'unchanged': return 'none';
    default: return item.action;
  }
}

/**
 * The decision table above for ONE file, for the Files-view mark right after a save (D-21): no board traffic, it uses the board
 * entry and the baseline from the last comparison. `board` undefined = not on the board; `local` undefined = not in the project.
 * Equal contents are 'identical' whatever the baseline says. Unknown board hashes (boards that cannot hash) compare by size only:
 * equal sizes are reported as 'first-sync-differs' (not known), exactly like the planner.
 */
export function classifyOne(
  local: { sha256: string; size: number } | undefined,
  board: { sha256?: string; size: number } | undefined,
  base: { sha256: string; size: number } | undefined,
): SyncReason | undefined {
  if (local && !board) { return base ? 'board-missing' : 'new-local'; }
  if (!local && board) { return base ? 'local-deleted' : 'board-only'; }
  if (!local || !board) { return undefined; }
  const bh = board.sha256;
  const equal: Tri = bh !== undefined ? bh === local.sha256 : local.size !== board.size ? false : undefined;
  if (equal === true) { return 'identical'; }
  if (equal === undefined || !base) { return 'first-sync-differs'; }
  const localChanged = local.sha256 !== base.sha256;
  const boardChanged: Tri = bh !== undefined ? bh !== base.sha256 : board.size !== base.size ? true : undefined;
  if (boardChanged === undefined) { return 'first-sync-differs'; }
  if (localChanged && boardChanged) { return 'both-changed'; }
  if (localChanged) { return 'local-changed'; }
  if (boardChanged) { return 'board-changed'; }
  return 'first-sync-differs';
}
