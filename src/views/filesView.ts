/**
 * Files view: the board's file tree (ported from the old esp32Fs.ts, rebuilt on BoardSession).
 *
 *  - Lazy: a folder is listed (`fs.list`, flagged `background` so Run/Stop/file operations overtake it) when VS Code first
 *    asks for its children.
 *  - Never stale: there is NO time-based cache (the old extension showed a 30 s old tree after Refresh). A listing is reused only
 *    until the next refresh(); refresh() drops every listing, cancels listings still in flight and asks VS Code to re-read all
 *    open folders, so Refresh always re-lists. And a listing is reused only until the board changes under it: whatever we change
 *    on the board is announced (BoardChangeSource) and boardChanged() re-lists exactly the folders that show it.
 *  - Never blank: when the tree cannot show files it says why and what to do (not connected, connecting, a program is running,
 *    empty folder, listing failed with a "try again" row). The only exceptions are "no port selected" and "no working Python",
 *    where it returns nothing on purpose so that the welcome text of the manifest (with its buttons) shows.
 *  - Never interrupts: a listing never passes `interrupt`. While a program runs the tree keeps the last listing it has.
 */
import * as vscode from 'vscode';
import { COMMAND_IDS, TREE_CONTEXT } from '../contributes';
import type { Logger } from '../log';
import type { FsEntry } from '../types/protocol';
import { isBoardError, userMessage, type BoardSession } from '../types/session';
import type { BoardNode, SyncStatusSource } from '../types/sync';
import { boardUri } from './decorations';
import { compareEntries, formatSize, isSameOrInside, joinDevicePath, parentOf } from './filesModel';
import { summarize, treePhase, type Phase, type SessionSummary } from './sessionView';
import { FILES_TEXT } from './strings';
import { fileHover } from './syncHelp';
import { projectFolder } from '../projectFolder';
import type { ViewSettings } from './viewSettings';

/** A row that is not a board file: a message, a placeholder or an error with a way forward. Has no `contextValue`, so no file menus. */
export interface StatusNode {
  readonly kind: 'status';
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  /** Codicon id. */
  readonly icon: string;
  readonly color?: string;
  readonly command?: { readonly command: string; readonly title: string; readonly arguments?: readonly unknown[] };
}

/** What the tree holds: board files and folders (a `BoardNode`, which is what the commands receive) and status rows. */
export type FilesNode = BoardNode | StatusNode;

export interface FilesTreeOptions {
  readonly session: BoardSession;
  readonly log: Logger;
  readonly settings: ViewSettings;
  /** `context.extensionUri` (kept for callers; tree items use theme icons). */
  readonly extensionUri: vscode.Uri;
  /** Client-side limit of one listing (default 60 s: it may wait behind an upload). */
  readonly listTimeoutMs?: number;
  /**
   * Sync's badges; only used to word the tooltip of a file ("Only on the board" says what a click does). With `onDidChange` the
   * tooltip of a file whose wording changed is asked for again.
   */
  readonly syncStatus?: Pick<SyncStatusSource, 'badgeFor'> & Partial<Pick<SyncStatusSource, 'onDidChange' | 'detailFor' | 'localOnlyIn'>>;
}

const DEFAULT_LIST_TIMEOUT_MS = 60_000;
/** A listing that was overtaken by a refresh is repeated; this bounds the repetition. */
const MAX_RELISTS = 3;

interface SeenState { phase: Exclude<Phase, 'working'>; port: string | null; interpreterProblem: boolean }

export class FilesTree implements vscode.TreeDataProvider<FilesNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<FilesNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private readonly session: BoardSession;
  private readonly log: Logger;
  private readonly settings: ViewSettings;
  private readonly listTimeoutMs: number;
  private readonly syncStatus: FilesTreeOptions['syncStatus'];
  /** The files VS Code asked an item for, with how the tooltip was worded (by device path), to notice when a badge changes it. */
  private readonly shownWhere = new Map<string, { node: BoardNode; where: string }>();
  /** Folders whose rows include project-only files (D-21), with the paths shown, to re-read them when that list changes. */
  private readonly shownLocalOnly = new Map<string, string>();
  /** Listings that succeeded, until the next refresh. */
  private readonly cache = new Map<string, readonly BoardNode[]>();
  private readonly inflight = new Map<string, Promise<readonly BoardNode[]>>();
  /** The node objects VS Code currently holds, by device path (so a folder can be refreshed alone). */
  private readonly nodes = new Map<string, BoardNode>();
  private readonly subscriptions: { dispose(): unknown }[] = [];
  private abort = new AbortController();
  private generation = 0;
  private seen: SeenState;

  constructor(options: FilesTreeOptions) {
    this.session = options.session;
    this.log = options.log;
    this.settings = options.settings;
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.syncStatus = options.syncStatus;
    this.seen = this.snapshot();
    this.subscriptions.push(this.session.onDidChangeState(() => this.onSessionChange()));
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()));
    if (options.syncStatus?.onDidChange) {
      this.subscriptions.push(options.syncStatus.onDidChange(() => this.onBadgesChanged()));
    }
    this.subscriptions.push(this.settings.onDidChange((keys) => {
      if (keys.includes('rootPath')) {
        this.refresh();
      } else if (keys.includes('port')) {
        this.onSessionChange();
      }
    }));
  }

  // ------------------------------------------------------------------ public API

  /** Re-list everything: drops all listings, cancels listings in flight, and makes VS Code re-read the root and every open folder. */
  refresh(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.generation++;
    this.cache.clear();
    this.inflight.clear();
    this.nodes.clear();
    this.shownWhere.clear();
    this.shownLocalOnly.clear();
    this.changed.fire(undefined);
  }

  /** Re-list one folder (and anything cached below it), for example after a file was created in it. */
  refreshFolder(devicePath: string): void {
    if (devicePath === this.settings.rootPath) {
      this.refresh();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (isSameOrInside(key, devicePath)) {
        this.cache.delete(key);
      }
    }
    for (const key of [...this.inflight.keys()]) {
      if (isSameOrInside(key, devicePath)) {
        this.inflight.delete(key);
      }
    }
    const node = this.nodes.get(devicePath);
    if (node !== undefined) {
      this.changed.fire(node);
    }
  }

  /**
   * Board paths were created, rewritten, renamed or removed (BoardChangeSource): re-list the folders that show them. This is the
   * ONE rule for every change we make on the board (sync engine, auto-sync, Clear Device Files, board-file commands). Synchronous
   * and cheap: it only drops listings and tells VS Code, which re-reads on its own; nothing waits for a listing.
   *  - A folder is re-listed only if we hold a listing of it (or one in flight). A folder never listed is listed fresh when first
   *    opened, so nothing flickers and no `fs.list` is wasted.
   *  - The folder is the parent of each changed path, or the nearest listed ancestor whose listing does not yet have the way down
   *    (an upload created `/lib/new/` on the way: `/lib` is stale, `/lib/new` was never listed).
   *  - Listings cached below a changed path are dropped (a folder removed or renamed).
   *  - The root alone is re-listed for a change at its top level: open sub-folders keep their cached listing, no listing storm.
   */
  boardChanged(devicePaths: readonly string[]): void {
    const stale = new Set<string>();
    const root = this.settings.rootPath;
    for (const changed of devicePaths) {
      if (changed === root || !isSameOrInside(changed, root)) {
        continue; // the root itself, or something outside what the tree shows
      }
      this.staleFolders(changed).forEach((folder) => stale.add(folder));
      this.dropBelow(changed);
    }
    stale.forEach((folder) => this.relist(folder));
  }

  /**
   * Handler of the `refresh` command. No argument (the view-title button): everything. A board node or `{ devicePath }`
   * (the "try again" row, or another module after changing a folder): that folder, or the folder of a file.
   */
  refreshFromCommand(arg: unknown): void {
    const target = folderOf(arg);
    if (target === undefined) {
      this.refresh();
    } else {
      this.refreshFolder(target);
    }
  }

  /** Drop the listings of `devicePath` and everything inside it (a folder that was removed or renamed). */
  private dropBelow(devicePath: string): void {
    for (const key of [...this.cache.keys()]) {
      if (isSameOrInside(key, devicePath)) {
        this.cache.delete(key);
      }
    }
    for (const key of [...this.inflight.keys()]) {
      if (isSameOrInside(key, devicePath)) {
        this.inflight.delete(key);
      }
    }
  }

  private isListed(folder: string): boolean {
    return this.cache.has(folder) || this.inflight.has(folder);
  }

  /** The folders we hold a listing of that no longer show the truth because `changed` was created, rewritten or removed. */
  private staleFolders(changed: string): string[] {
    const root = this.settings.rootPath;
    const stale: string[] = [];
    const parent = parentOf(changed);
    if (this.isListed(parent)) {
      stale.push(parent);
    }
    // A folder created on the way down (upload with mkdirs): its parent's listing was taken before it existed.
    for (let child = changed; child !== root; child = parentOf(child)) {
      const above = parentOf(child);
      const listing = this.cache.get(above);
      if (listing !== undefined && !listing.some((n) => n.devicePath === child)) {
        stale.push(above);
      }
    }
    return stale;
  }

  /** Drop one folder's own listing and make VS Code ask for it again. The root keeps the listings of its sub-folders. */
  private relist(folder: string): void {
    this.cache.delete(folder);
    if (this.inflight.delete(folder)) {
      this.generation++; // whoever waits for the listing that started before the change asks again instead of showing it
    }
    if (folder === this.settings.rootPath) {
      this.changed.fire(undefined); // VS Code re-reads the root; the open sub-folders answer from their (still valid) listings
      return;
    }
    const node = this.nodes.get(folder);
    if (node !== undefined) {
      this.changed.fire(node);
    }
  }

  // ------------------------------------------------------------------ TreeDataProvider

  getTreeItem(node: FilesNode): vscode.TreeItem {
    if (node.kind === 'status') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon(node.icon, node.color === undefined ? undefined : new vscode.ThemeColor(node.color));
      if (node.command !== undefined) {
        item.command = { command: node.command.command, title: node.command.title, arguments: node.command.arguments === undefined ? undefined : [...node.command.arguments] };
      }
      return item;
    }
    const isDir = node.kind === 'dir';
    const item = new vscode.TreeItem(node.name, isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = node.devicePath;
    item.contextValue = node.localOnly ? (isDir ? undefined : TREE_CONTEXT.localFile) : isDir ? TREE_CONTEXT.dir : TREE_CONTEXT.file;
    item.resourceUri = boardUri(node.devicePath);
    if (node.localOnly) {
      // A project file (or folder) that is not on the board yet: shown where it will go, dimmed by its description.
      item.iconPath = isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
      item.description = FILES_TEXT.localOnlyDescription;
      if (isDir) {
        item.tooltip = FILES_TEXT.localOnlyDirTooltip(node.devicePath);
      } else {
        item.tooltip = this.fileTooltip(node);
        item.command = { command: COMMAND_IDS.openFileFromBoard, title: FILES_TEXT.openTitle, arguments: [node] };
      }
      return item;
    }
    // Theme icons follow the user's file icon theme and stay visible in dark themes (an SVG with currentColor would render black).
    item.iconPath = isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    if (isDir) {
      item.tooltip = FILES_TEXT.dirTooltip(node.devicePath);
    } else {
      const size = formatSize(node.size ?? 0);
      item.description = size;
      item.tooltip = this.fileTooltip(node);
      item.command = { command: COMMAND_IDS.openFileFromBoard, title: FILES_TEXT.openTitle, arguments: [node] };
    }
    return item;
  }

  /**
   * A file's tooltip depends on its badge ("Only on the board" becomes "Open your copy" once the file was copied into the project).
   * VS Code keeps the tooltip it was given until it asks for the item again, and `resolveTreeItem` is only called for properties
   * that were left undefined, so a file whose tooltip became WRONG is announced here (only that item is read again, nothing is
   * listed). The "unknown" wording is true for every state, so a badge appearing or going away never counts as a change: that
   * keeps the view quiet when a comparison or an upload only confirms files.
   */
  private onBadgesChanged(): void {
    const rich = this.syncStatus?.detailFor !== undefined;
    for (const [devicePath, shown] of [...this.shownWhere]) {
      const now = this.whereOf(shown.node);
      // With the hover help (D-21) the tooltip names the mark, so any change of the mark is a change of the tooltip. Without it,
      // the "unknown" wording is true for every state: a badge appearing or going away changes nothing.
      const changedWording = rich ? now !== shown.where : shown.where !== 'unknown' && now !== 'unknown' && now !== shown.where;
      if (changedWording) {
        this.shownWhere.set(devicePath, { node: shown.node, where: now });
        this.changed.fire(shown.node);
      }
    }
    // Project-only rows: a folder whose list of such files changed is read again (from its cached listing: nothing is listed).
    if (this.syncStatus?.localOnlyIn !== undefined) {
      for (const [folder, was] of [...this.shownLocalOnly]) {
        if (this.localOnlyKey(folder) !== was) {
          this.shownLocalOnly.delete(folder);
          if (folder === this.settings.rootPath) {
            this.changed.fire(undefined);
          } else {
            const node = this.nodes.get(folder);
            if (node !== undefined) { this.changed.fire(node); }
          }
        }
      }
    }
  }

  private whereOf(node: BoardNode): string {
    const detail = this.syncStatus?.detailFor?.(node.devicePath);
    if (detail !== undefined) { return detail.badge + (detail.autoSync ? ':auto' : ''); }
    const badge = this.syncStatus?.badgeFor(node.devicePath);
    // A badge is only a hint; the click decides by looking at the project folder. 'board-only' also covers a file whose project copy was deleted.
    return badge === undefined ? 'unknown' : badge === 'board-only' ? 'board-only' : 'mine';
  }

  private fileTooltip(node: BoardNode): string | vscode.MarkdownString {
    const where = this.whereOf(node);
    this.shownWhere.set(node.devicePath, { node, where });
    const sizeText = `${formatSize(node.size ?? 0)} (${node.size ?? 0} bytes)`;
    if (this.syncStatus?.detailFor !== undefined) {
      return fileHover(node, this.syncStatus.detailFor(node.devicePath), sizeText);
    }
    return FILES_TEXT.fileTooltip(node.devicePath, sizeText, where === 'board-only' || where === 'mine' ? where : 'unknown');
  }

  private localOnlyKey(folder: string): string {
    return (this.syncStatus?.localOnlyIn?.(folder) ?? []).map((e) => `${e.kind}:${e.devicePath}`).sort().join('|');
  }

  /** Project-only files and folders directly inside `folder` that the board listing does not have. */
  private localOnlyRows(folder: string, listing: readonly BoardNode[]): BoardNode[] {
    if (this.syncStatus?.localOnlyIn === undefined) { return []; }
    this.shownLocalOnly.set(folder, this.localOnlyKey(folder));
    const onBoard = new Set(listing.map((n) => n.devicePath));
    return this.syncStatus.localOnlyIn(folder)
      .filter((e) => !onBoard.has(e.devicePath))
      .map((e): BoardNode => ({ devicePath: e.devicePath, kind: e.kind, name: e.name, size: e.size, localOnly: true }));
  }

  async getChildren(element?: FilesNode): Promise<FilesNode[]> {
    if (element !== undefined) {
      if (element.kind === 'dir' && element.localOnly) {
        return this.localOnlyRows(element.devicePath, []).sort(compareEntries); // a project folder that is not on the board yet
      }
      return element.kind === 'dir' ? this.listFolder(element.devicePath, false, 0) : [];
    }
    const summary = this.summary();
    if (projectFolder() === undefined || summary.interpreterProblem || !summary.hasPort) {
      return []; // on purpose: the manifest's welcome text (with buttons) shows only while the tree is empty (D-24: no folder)
    }
    const port = summary.port ?? '';
    if (summary.phase === 'disconnected') {
      return [this.connectRow(port)];
    }
    if (summary.phase === 'connecting') {
      return [{
        kind: 'status', id: 'status:connecting', label: FILES_TEXT.connectingLabel(port), tooltip: FILES_TEXT.connectingTooltip,
        icon: 'loading~spin',
      }];
    }
    return this.listFolder(this.settings.rootPath, true, 0);
  }

  dispose(): void {
    this.abort.abort();
    this.subscriptions.splice(0).forEach((s) => s.dispose());
    this.changed.dispose();
  }

  // ------------------------------------------------------------------ listing

  private async listFolder(devicePath: string, isRoot: boolean, attempt: number): Promise<FilesNode[]> {
    const cached = this.cache.get(devicePath);
    if (cached !== undefined) {
      return this.withEmptyRow(cached, devicePath, isRoot);
    }
    if (this.session.state.state === 'running') {
      return [this.runningRow(devicePath)];
    }
    const generation = this.generation;
    try {
      const listing = await this.requestListing(devicePath);
      if (generation !== this.generation && attempt < MAX_RELISTS) {
        return await this.listFolder(devicePath, isRoot, attempt + 1);
      }
      return this.withEmptyRow(listing, devicePath, isRoot);
    } catch (err) {
      if (generation !== this.generation && attempt < MAX_RELISTS) {
        return await this.listFolder(devicePath, isRoot, attempt + 1);
      }
      return this.failureRows(err, devicePath, isRoot);
    }
  }

  private requestListing(devicePath: string): Promise<readonly BoardNode[]> {
    const pending = this.inflight.get(devicePath);
    if (pending !== undefined) {
      return pending;
    }
    const work: Promise<readonly BoardNode[]> = this.session
      .call('fs.list', { path: devicePath, background: true }, { timeoutMs: this.listTimeoutMs, signal: this.abort.signal })
      .then((result) => {
        const listing = toNodes(devicePath, result.entries);
        // Only the listing that is still the current one may be remembered (a refresh in between replaced it).
        if (this.inflight.get(devicePath) === work) {
          this.cache.set(devicePath, listing);
          for (const node of listing) {
            this.nodes.set(node.devicePath, node);
          }
        }
        return listing;
      })
      .finally(() => {
        if (this.inflight.get(devicePath) === work) {
          this.inflight.delete(devicePath);
        }
      });
    this.inflight.set(devicePath, work);
    return work;
  }

  private withEmptyRow(listing: readonly BoardNode[], devicePath: string, isRoot: boolean): FilesNode[] {
    const extra = this.localOnlyRows(devicePath, listing);
    for (const node of extra) { this.nodes.set(node.devicePath, node); }
    if (listing.length > 0 || extra.length > 0) {
      return [...listing, ...extra].sort(compareEntries);
    }
    if (isRoot) {
      return [{
        kind: 'status', id: `status:empty:${devicePath}`, label: FILES_TEXT.emptyRootLabel, description: FILES_TEXT.emptyRootDescription,
        tooltip: FILES_TEXT.emptyRootTooltip(devicePath), icon: 'info',
      }];
    }
    return [{ kind: 'status', id: `status:empty:${devicePath}`, label: FILES_TEXT.emptyDirLabel, icon: 'info' }];
  }

  private failureRows(err: unknown, devicePath: string, isRoot: boolean): FilesNode[] {
    if (isBoardError(err, 'E_PROGRAM_RUNNING')) {
      // A program started between our state check and the listing: not an error, the gate worked.
      return [this.runningRow(devicePath)];
    }
    if (isBoardError(err, 'E_NOT_CONNECTED')) {
      const summary = this.summary();
      return isRoot && summary.hasPort ? [this.connectRow(summary.port ?? '')] : [];
    }
    this.log.error(`Could not list ${devicePath} on the board`, err);
    const message = userMessage(err);
    const detail = isBoardError(err) ? err.detail : '';
    return [{
      kind: 'status', id: `status:error:${devicePath}`, label: isRoot ? FILES_TEXT.errorRootLabel : FILES_TEXT.errorDirLabel,
      description: (err instanceof Error ? err.message : message).split('\n')[0],
      tooltip: FILES_TEXT.errorTooltip(message, detail), icon: 'error', color: 'list.errorForeground',
      command: { command: COMMAND_IDS.refresh, title: FILES_TEXT.retryTitle, arguments: [{ devicePath }] },
    }];
  }

  private connectRow(port: string): StatusNode {
    return {
      kind: 'status', id: 'status:connect', label: FILES_TEXT.connectLabel(port), description: FILES_TEXT.connectDescription,
      tooltip: FILES_TEXT.connectTooltip(port), icon: 'plug',
      command: { command: COMMAND_IDS.selectPort, title: FILES_TEXT.connectLabel(port), arguments: [{ reuse: true }] },
    };
  }

  private runningRow(devicePath: string): StatusNode {
    return {
      kind: 'status', id: `status:running:${devicePath}`, label: FILES_TEXT.runningLabel, description: FILES_TEXT.runningDescription,
      tooltip: FILES_TEXT.runningTooltip, icon: 'play-circle', color: 'charts.green',
    };
  }

  // ------------------------------------------------------------------ reacting to the session

  private summary(): SessionSummary {
    return summarize(this.session.state, this.session.selectedPort, this.settings.portOverride);
  }

  private snapshot(): SeenState {
    const s = this.summary();
    return { phase: treePhase(s.phase), port: s.port, interpreterProblem: s.interpreterProblem };
  }

  /**
   * Re-read the tree when what it shows has changed in kind: a port appeared or changed, Python became (un)usable, the
   * connection came or went, or a program stopped (it may have written files). A file operation of the bridge (`working`)
   * and the start of a Run change nothing visible, so they do not refresh (no flicker, no listing storm).
   */
  private onSessionChange(): void {
    const before = this.seen;
    const now = this.snapshot();
    this.seen = now;
    if (before.interpreterProblem !== now.interpreterProblem || before.port !== now.port) {
      this.refresh();
    } else if (before.phase !== now.phase && !(before.phase === 'ready' && now.phase === 'running')) {
      this.refresh();
    }
  }
}

/** Device entries to nodes: folders first, then files, case-insensitive natural order. Names are used exactly as the board gives them. */
function toNodes(parent: string, entries: readonly FsEntry[]): BoardNode[] {
  return entries
    .map((e): BoardNode => (e.type === 'dir'
      ? { devicePath: joinDevicePath(parent, e.name), kind: 'dir', name: e.name }
      : { devicePath: joinDevicePath(parent, e.name), kind: 'file', name: e.name, size: e.size }))
    .sort(compareEntries);
}

/** The folder a `refresh` argument refers to, or undefined for "everything". */
function folderOf(arg: unknown): string | undefined {
  if (typeof arg !== 'object' || arg === null) {
    return undefined;
  }
  const { devicePath, kind } = arg as { devicePath?: unknown; kind?: unknown };
  if (typeof devicePath !== 'string' || !devicePath.startsWith('/')) {
    return undefined;
  }
  return kind === 'file' ? parentOf(devicePath) : devicePath;
}
