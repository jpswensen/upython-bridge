/**
 * Sync utilities view (ported from the old syncView.ts): Auto-sync (click cycles ask, on, off through the toggle command),
 * the number of files waiting, Upload all, Download all and Clear device files. The "Initialize Workspace" row of the old
 * extension is gone: there is no hidden gate any more (D-10).
 */
import { COMMAND_IDS } from '../contributes';
import type { BoardSession } from '../types/session';
import { RowsTree, type Row } from './rowsTree';
import { SYNC_TEXT } from './strings';
import type { ViewSettings } from './viewSettings';

export class SyncTree extends RowsTree {
  constructor(private readonly session: BoardSession, private readonly settings: ViewSettings) {
    super();
    this.own(session.onDidChangeState(() => this.refresh()));
    this.own(settings.onDidChange((keys) => {
      if (keys.includes('autoSync')) {
        this.refresh();
      }
    }));
  }

  protected compute(): Row[] {
    const mode = this.settings.autoSync;
    const pending = this.session.state.pendingSyncCount;
    const rows: Row[] = [
      {
        id: 'autoSync', label: SYNC_TEXT.autoSyncLabel(mode), description: SYNC_TEXT.autoSyncDescription[mode],
        tooltip: SYNC_TEXT.autoSyncTooltip[mode], icon: mode === 'off' ? 'sync-ignored' : 'sync', command: COMMAND_IDS.toggleAutoSync,
      },
    ];
    if (pending > 0) {
      rows.push({
        id: 'pending', label: SYNC_TEXT.pendingLabel(pending),
        description: this.session.state.state === 'running' ? SYNC_TEXT.pendingRunning : SYNC_TEXT.pendingIdle,
        tooltip: SYNC_TEXT.pendingTooltip, icon: 'cloud-upload', color: 'charts.yellow',
      });
    }
    rows.push(
      {
        id: 'uploadAll', label: SYNC_TEXT.uploadAllLabel, tooltip: SYNC_TEXT.uploadAllTooltip, icon: 'cloud-upload',
        command: COMMAND_IDS.syncToBoard,
      },
      {
        id: 'downloadAll', label: SYNC_TEXT.downloadAllLabel, tooltip: SYNC_TEXT.downloadAllTooltip, icon: 'cloud-download',
        command: COMMAND_IDS.syncFromBoard,
      },
      {
        id: 'clearDevice', label: SYNC_TEXT.clearLabel, tooltip: SYNC_TEXT.clearTooltip, icon: 'trash', color: 'charts.red',
        command: COMMAND_IDS.clearDevice,
      },
    );
    return rows;
  }
}
