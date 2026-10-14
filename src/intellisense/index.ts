/**
 * Public API of the IntelliSense library (D-05, D-15). Pure TypeScript with injected dependencies; `vscode` is not imported here.
 * Wiring (command, quick fix on unresolved imports, consent prompts, the board session behind `BoardAccess`) lives in the
 * extension layer and calls `gatherBoardStubs` and `runFix`.
 */
export type * from './types';
export { nodeClock, nodeFs } from './nodeAdapters';
export {
  BOARD_LIB_DIR, BOARD_LIMITS, KNOWN_ELSEWHERE, NEVER_IMPORT, firmwareKey, firmwareLabel, gatherBoardStubs, libraryFolders, localModuleNames,
  neverImport, normalizeListing, parseIntrospection, renderModuleStub, scanBoardLib, selectBoardModules, stockModuleNames,
  type AttrKind, type BoardAccess, type BoardEntry, type BoardGatherOptions, type BoardLibModule, type BoardModuleRow, type BoardStubs,
  type ClassInfo, type ImportAnswer, type Introspection, type ListingTree, type ModuleInfo, type Selection, type StubContext,
} from './board';
export { OVERLAY_ID, coverageTable, loadStubManifest, loadStubPack, selectStockStubs, type CoverageRow, type SelectOptions } from './stockStubs';
export { portOf } from './ports';
export {
  ENVIRONMENT_KEYS, GENERATED_REL, USER_CONFIG_NAME, analyzeUserConfig, extendsSnippet, pyprojectHasPyright, renderGeneratedConfig, renderUserConfig,
  type GeneratedConfig, type UserConfigAnalysis,
} from './config';
export { SETTINGS_REL, addSettingsKeys, removeSettingsKeys } from './settingsEdit';
export { writeIfChanged } from './atomicFs';
export {
  DEFAULT_FIX_SETTINGS, TRACKER_REL, applyPlan, parseTracker, planFix, prepareFixInputs, readWorkspaceState, removeManaged, runFix,
  type ApplyResult, type BoardPart, type Consent, type FixDeps, type FixRequest, type FixSettings, type PlanInputs, type RemoveResult, type WorkspaceState,
} from './fix';
