/**
 * Badges on Files-view items ("is this board file the same as my local file?"), fed by the sync module through the
 * `SyncStatusSource` interface (src/types/sync.ts). The tree items carry a `resourceUri` in a private scheme, so only
 * this view is decorated, never the Explorer. Nothing is shown for a path the sync module knows nothing about.
 */
import * as vscode from 'vscode';
import { IDENTITY } from '../identity';
import type { SyncBadge, SyncStatusSource } from '../types/sync';

/** URI scheme of Files-view items. Derived from the product identity, so a rename needs no change here. */
export const BOARD_URI_SCHEME = IDENTITY.prefix.toLowerCase();

/** The `resourceUri` of a board path: scheme + the device path. */
export function boardUri(devicePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BOARD_URI_SCHEME, path: devicePath });
}

interface BadgeStyle { badge: string; tooltip: string; color: string; propagate: boolean }

// Badge text is 1-2 characters (a VS Code limit). Arrows say which way a copy is needed (D-21): up = to the board, down = to
// this computer; a plus marks a file that exists on one side only (new). `propagate` colours the folders above a file that needs attention. The full explanation is the item's hover.
export const BADGES: Record<SyncBadge, BadgeStyle> = {
  'in-sync': { badge: '✓', tooltip: 'Synced: the same on the board and on your computer.', color: 'charts.green', propagate: false },
  'local-changed': { badge: '↑', tooltip: 'Your computer has newer changes. They still need to go to the board.', color: 'charts.orange', propagate: true },
  'local-only': { badge: '↑+', tooltip: 'New file on your computer. It is not on the board yet.', color: 'charts.orange', propagate: true },
  'board-changed': { badge: '↓', tooltip: 'The board has newer changes than your computer.', color: 'charts.blue', propagate: true },
  'board-only': { badge: '↓+', tooltip: 'Only on the board. Your computer does not have this file.', color: 'charts.blue', propagate: false },
  'conflict': { badge: '!', tooltip: 'Changed on both your computer and the board since the last sync.', color: 'charts.red', propagate: true },
  'differs': { badge: '≠', tooltip: 'Different on the board and on your computer, and it is not known which one is newer.', color: 'charts.purple', propagate: true },
  'unsaved': { badge: '●', tooltip: 'Unsaved changes in the editor. Save the file to send them to the board.', color: 'charts.orange', propagate: false },
  'waiting': { badge: '…', tooltip: 'Waiting to be sent to the board (a program is running or the board is not connected).', color: 'charts.yellow', propagate: false },
  'failed': { badge: '✗', tooltip: 'The last upload of this file did not work. Hover for why.', color: 'charts.red', propagate: true },
};

export function decorationFor(badge: SyncBadge): vscode.FileDecoration {
  const style = BADGES[badge];
  const d = new vscode.FileDecoration(style.badge, style.tooltip, new vscode.ThemeColor(style.color));
  d.propagate = style.propagate;
  return d;
}

export class BoardFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscription: { dispose(): unknown };

  constructor(private readonly source: SyncStatusSource) {
    // The source cannot say which paths changed, so every decoration is asked for again (cheap: a map lookup each).
    this.subscription = source.onDidChange(() => this.changed.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== BOARD_URI_SCHEME) {
      return undefined;
    }
    const badge = this.source.badgeFor(uri.path);
    return badge === undefined ? undefined : decorationFor(badge);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
