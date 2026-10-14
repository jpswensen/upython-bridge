/** Public surface of the sync module (everything else in src/sync is internal to it). */
export { SyncService, type SyncServiceOptions, type Prepared } from './service';
export { AutoSync, type AutoSyncHost, type FolderContext, type Scheduler } from './autosync';
export { BoardChanges } from './boardChanges';
export { SyncEngine, BackupSession, transferTimeoutMs, type ExecuteOptions } from './engine';
export { SyncStatus } from './status';
export { BaselineStore, boardKeyOf, workspaceKeyOf, type BoardKey } from './baseline';
export { IgnoreMatcher, loadIgnoreMatcher, createDefaultIgnoreFile, DEFAULT_IGNORE_PATTERNS } from './ignore';
export { PathMapper, PathError, shadowedModule, importRootsFrom } from './paths';
export { buildPlan, countPlan, actionable, effectiveAction, type PlanInput, type PlanOutput } from './plan';
export { SYNC_STATE, stateKey } from './state';
