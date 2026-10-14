/**
 * Shared base of the two flat views (Board Actions, Sync utilities): a list of rows, each one a command with an icon, a
 * description and a tooltip. Rows are recomputed from live state on every refresh, so their text never goes stale.
 */
import * as vscode from 'vscode';
import { projectFolder } from '../projectFolder';

export interface Row {
  /** Stable id (also the tree item id and what tests look for). */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  /** Codicon id, for example `play`. */
  readonly icon: string;
  /** Theme colour id for the icon, for example `charts.green`. */
  readonly color?: string;
  /** Command id run when the row is clicked; absent for information rows. */
  readonly command?: string;
}

export abstract class RowsTree implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Row | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: { dispose(): unknown }[] = [vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())];

  /** The rows for the current state. Must not throw and must not touch the board. */
  protected abstract compute(): Row[];

  /** Rows as the view shows them right now (for tests and for other modules that need the same text). */
  rows(): Row[] {
    return this.compute();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(element?: Row): Row[] {
    // D-24: without a project folder the view is empty on purpose, so the manifest's "Open Folder" welcome shows
    return element === undefined && projectFolder() !== undefined ? this.compute() : [];
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.iconPath = new vscode.ThemeIcon(row.icon, row.color === undefined ? undefined : new vscode.ThemeColor(row.color));
    if (row.command !== undefined) {
      item.command = { command: row.command, title: row.label };
    }
    return item;
  }

  /** Keep a listener (or anything disposable) until this view is disposed. */
  protected own<T extends { dispose(): unknown }>(disposable: T): T {
    this.subscriptions.push(disposable);
    return disposable;
  }

  dispose(): void {
    this.subscriptions.splice(0).forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
