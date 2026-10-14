/**
 * The one place that tells the rest of the extension "these board paths changed" (see BoardChangeSource in src/types/sync.ts).
 * The sync engine calls `notify` once per run for everything it created, rewrote or removed on the board; the board-file
 * commands (new, rename, delete) call it through SyncService.boardChanged. The Files view is the listener that re-lists.
 */
import * as vscode from 'vscode';
import type { BoardChangeSource } from '../types/sync';

export class BoardChanges implements BoardChangeSource, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<readonly string[]>();
  readonly onBoardChanged: BoardChangeSource['onBoardChanged'] = this.emitter.event;

  /** One event with the distinct device paths; nothing is fired for an empty list (nothing changed, so no listing, no flicker). */
  notify(devicePaths: Iterable<string>): void {
    const distinct = [...new Set(devicePaths)];
    if (distinct.length > 0) {
      this.emitter.fire(distinct);
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
