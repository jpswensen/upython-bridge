# Sync states, auto-sync and overwrite protection: SPEC (D-21)

Status: **DRAFT rev 2 for the instructor's approval; nothing in this file is implemented.** Author: agent sync-spec-designer, 2026-10-13; revised by agent sync-spec-reviser the same day to close the findings of the adversarial review (`docs/sync-states-review.md`). Section 13 lists every review finding and where it is handled; section 14 is the one list of decisions only the instructor can make.
Implements the instructor's D-21 decisions (`docs/decisions.md`, Amendments). Where this file and the code differ, this file is the target; section 0 lists what the code does today.
Evidence tags: [E] executed, [S] read from source, [D] documented, [K] known, [I] inferred, [U] unverified. Every rule has an ID (ST-1, OW-3, ...) so a test can name it.

## 0. What the code does today (so the spec is a delta, not a fantasy)

| Fact | Where [S] |
|---|---|
| The planner is a pure 3-way compare (local hash L, board hash B, baseline S). Direction-aware: the same pair of files gives `upload` in one plan and `conflict` in the other. | `src/sync/plan.ts:5-20, 211-242` |
| Without a baseline, differing files are `conflict` ("first-sync-differs"); there is NO "direction unknown" state and no first-sync review. | `plan.ts:225-227` |
| Baseline = `{version:1, boardId, files:{rel:{sha256,size,syncedAt}}}`, one file per (workspace folder URI hash, board id) in `storageUri/baselines/`. Any other version is moved aside, not read. Board without `unique_id` gets a derived key shared by all boards of that model. | `src/sync/baseline.ts:16, 28, 33-39, 86-88, 110-114`; `src/types/sync.ts:82-87` |
| Auto-sync (setting `autoSync`, default `ask`) uploads a saved file after comparing the LOCAL hash with the BASELINE only. It never asks the board what is there, so it silently overwrites a board file that a program, a lab partner or another PC changed. | `autosync.ts:237-264`, `engine.ts:260-264` (`expectSha` only skips when the board already equals the new file); `src/contributes.ts:175` |
| "Upload Current File" builds a one-item upload plan with no board comparison at all. | `src/sync/service.ts:447-452` |
| Backups: local files are backed up before a download; a BOARD file is backed up only for a ticked `conflict` item and never in background (auto-sync) runs; 20 backup folders kept. | `engine.ts:22, 257-259, 271-273, 302-305` |
| Badges: `SyncBadge` has 6 values (`in-sync`, `local-changed`, `board-changed`, `conflict`, `board-only`, `local-only`), glyphs `✓ ↑ ↓ ! B ?`; tooltips are plain `FileDecoration` strings; only the Files view (private URI scheme) is decorated; badges come from the last plan or from auto-sync's bookkeeping and are never recomputed. | `src/types/sync.ts:90`, `src/views/decorations.ts:21-28`, `src/sync/status.ts:30-43` |
| Files view lists BOARD files only, so a file that exists only locally has no row. | `src/views/filesView.ts:321` (`listFolder`) |
| `fs.manifest` returns `{path,type,size,sha256?}`; no mtime. `fs.stat` returns `mtime` as the raw `st[8]` of the board (port epoch, not normalised). | `bridge/devfs.py:260` (`os.stat(full)[6]`), `:295` (`st[8]`), `:1506-1515`; `src/types/protocol.ts:93`; `docs/protocol.md:40-41` |
| Run uploads only what auto-sync has pending, and only when `autoSync` is `on` or something is pending; a library that was never saved while auto-sync was on is never sent. | `src/commands/run.ts:94-98, 195-219` |
| "New File on Board" creates an EMPTY file on the board only, then offers "Also create it in my project". | `src/commands/boardFiles.ts:132-181` |
| Files created by a program are discovered only by Upload/Download All; nothing tells the student. | `service.ts:352-377` |
| Only the first workspace folder is synced. | `service.ts:140` |
| `scanLocal` drops a file that times out or cannot be read and only adds a warning. The planner then sees "local absent, board present" and emits `download`; the engine backs up the local file only when `localSha256` is defined, then `fs.get` replaces it. An unreadable local file (OneDrive online-only placeholder, locked file) can therefore be overwritten with no backup. | `src/sync/localScan.ts:150-159`; `plan.ts:193-199`; `engine.ts:267-275` |
| `scanLocal` hashes every non-ignored file on every scan (concurrency 4, no cache), and reading hydrates OneDrive placeholders. Symbolic links are skipped with a warning. | `localScan.ts:100-130` (links), `:150-159` (unconditional hash) |
| A download writes `<dest>.mpytmp` and renames it over the destination: not exclusive. Only the D-20 "Copy to project" path creates exclusively. `isDirty` sees VS Code buffers only. | `engine.ts:267-275`; `src/commands/boardCopy.ts:10, 124` |
| A rename calls `onGone(old)` and then `noteChange(new)`, so the new name is scheduled for upload before any rename offer is answered; a delete event is reported at once (no re-check), also for delete-then-create saves. | `autosync.ts:136-138, 380-389` |
| A board delete through the extension returns `forget`, which removes the baseline entry, so the local file then looks `new-local`; Clear Device Files does the same through `forgetDeleted`. | `engine.ts:287`; `service.ts:518, 531` |
| `run.ts` has no single-flight guard (its only flags are `programRunning` and `pendingCount`; a grep for an in-flight marker finds none), so two presses start two preparations. | `src/commands/run.ts:94, 186-219` |
| The bridge already has `cancel {target}` ("asks a running file op to stop at the next chunk") and a `background:true` flag on `fs.put`/`fs.list`/`fs.manifest`; a higher-class op never aborts a running op except `stop`/`cancel`. | `docs/protocol.md:58, 96` [D] |
| The default ignore list is `DEFAULT_IGNORE_GROUPS`; it holds `*.tmp`, `*~`, `*.part`, `*.mpytmp` but nothing for conflicted copies or for `*.board.*`. | `src/sync/ignore.ts:16-37` |

## 1. Purpose, scope, glossary

**Purpose.** A student must be able to look at one file in the Files view and know, without reading anything, whether the board has their latest code, whether the board has something they do not, and what a click or a right-click will do. Nothing the student wrote may be lost to a sync, however many lab partners, PCs, boards and programs are involved.

**Scope.** Per-file state, its badges and help text, the board-side refresh policy, auto-sync, the first-sync review, overwrite protection and backups, the two board-to-laptop use cases, timestamps as hints, Run uploading imported modules, New File. One workspace folder (as today).

**Not in scope.** Automatic deletes (never; D-21, CLAUDE.md rule 7). Merging text. Syncing more than one workspace folder. Writing marker files onto the board. Git. Explorer (local tree) badges (open decision O-3). Hard-reset or firmware matters. Replacing the ignore rules (`src/sync/ignore.ts`, unchanged).

| Term | Meaning |
|---|---|
| **rel** | workspace-relative POSIX path; maps to a board path under `rootPath` through `PathMapper` (`src/sync/paths.ts`). |
| **L** | sha256 of the project file on disk (absent if no such file). The editor buffer is NOT L; unsaved edits are the `dirty` flag. |
| **B** | sha256 of the board file as of the last board read (absent, or `unknown` when the board cannot hash). |
| **S (baseline)** | the sha256 that BOTH sides were last verified to have, per (workspace, board). Written only after a verified-identical comparison or a successful transfer. |
| **local-ahead / board-ahead** | L differs from B and exactly one side moved away from S. |
| **conflict (both-changed)** | L differs from B and both differ from S. |
| **dirty** | the file is open in an editor with unsaved changes. |
| **protected transfer** | a transfer whose destination exists, differs from the source, and either has no S or differs from S (section 6). |
| **pair** | (workspace folder, board id). **reviewed pair** = the first-sync review has been completed for it. |
| **tombstone** | a record in the baseline file that the student deleted this file from the board through the extension (BD-1). |
| **unreadable** | a project file that exists but could not be read (timeout, lock, permission, OneDrive online-only). It is neither present nor absent for planning (ST-10). |
| **not for board** | a project file whose extension is not on the board allowlist, or that is over the size cap; it is not opened unless the board has a file of the same name (LS-2). |

## 2. The state model

### 2.1 The function

```
state(input) -> { state, flags, primary }          // pure; no I/O, no clock except input.now
input = {
  rel,
  baseline: {sha256, equiv?: [sha256], size, boardMtime?, clockOk, origin} | undefined,
  tombstone: bool,                                   // BD-1: deleted/cleared on the board through the extension
  local:  absent | unreadable{reason: timeout, locked, permission or offline} | {sha256, size, mtime?},
  board:  'not-checked' | absent | {sha256 | 'unknown', size, mtime?},
  boardCheckedAt?: time, boardClock: 'ok' | 'bad' | 'unknown',
  boardHash: 'sha256' | 'none',                      // capability of this board (protocol.md:40)
  boardIdDerived: bool,                              // BL-5
  nameClash: bool,                                   // the caller found a case-fold or file/folder collision for rel (NC-2)
  editorDirty: bool, diskChanged: bool,              // diskChanged: disk hash differs from the one recorded when the buffer became dirty (O1b)
  program: 'idle' | 'running', connection: 'connected' | 'disconnected',
  ignored: false | 'ignore-list' | 'not-for-board',
  autoSync: 'on' | 'off' | 'ask', pairReviewed: bool, trusted: bool,
  inFlight: bool, lastTransfer?: {ok:false, code, message, localSha, boardSha}
}
flags = { dirty, diskChanged, stale, boardChanged, dates? }
```

The caller (not `state()`) pairs the local scan with the board listing by exact name. If two names collide only after case-folding on a case-insensitive host, or one is a folder where the other is a file, it passes `nameClash` for each of them (NC-2). A symlink or junction in the project, a board path outside `rootPath`, and directories never get a per-file state (T18-T20).

### 2.2 Evaluation order (first match wins)

| Step | Condition | Result |
|---|---|---|
| E1 | `ignored` (reason `ignore-list` or `not-for-board`) | `ignored` |
| E2 | `inFlight` | `unknown` (reason "checking") |
| E2a | `local == unreadable` | `unreadable` (T16); decided before any board data is looked at, because the local side cannot be trusted |
| E2b | `nameClash` | `name-clash` (T17) |
| E3 | `board == 'not-checked'` and the local file exists, or `connection == disconnected` and no snapshot | `unknown` with a reason, the first that applies: `restricted-mode` (`!trusted`; link `Trust this folder`), `program-running` (`program == running`; link `Stop the program and check`), `disconnected` (link `Connect the board`), else `not-checked` |
| E4 | `lastTransfer.failed` and its `localSha`/`boardSha` still equal the current L/B | `failed` |
| E5 | the presence/hash table in 2.3 | base state |
| E6 | overlays (2.4) | final state |

Rule ST-1: `state()` has no side effects and gives the same output for the same input (test: call twice, deep-equal; call with a frozen input).
Rule ST-2: an equality that cannot be determined (board cannot hash, same size, download-compare not possible) never yields `synced`, `local-ahead` or `board-ahead`; it yields `differs-unknown` (reason "could not compare"). This is the conservative direction. On a `boardHash == none` board it applies to every pair whose equality was not proven by a bounded download-compare in the current connection (OW-7).
Rule ST-3: `synced` requires L == B (both hashes known), or L and B both equal to S or to S's `equiv` hash when S.origin is `normalised` (RN-1), and nothing else; otherwise S is irrelevant to it.
Rule ST-9 (`ask`): before the call, `autoSync` is reduced to `effective`: `on` when the setting is `on`, or is `ask` and `pairReviewed`; `off` otherwise. So `ask` behaves as `off` until the first-sync review has been answered and as `on` afterwards; the review (5.2) is the only question, there is no second dialog. O3 and O5 use `effective`.
Rule ST-10 (unreadable is not absent): an `unreadable` local file is never an upload source, never a download destination, and never evidence of absence: it does not trigger T10-T13, it never makes the project look empty (F2), and it never causes `forget` (T12). Test: a scan fixture with a hanging file; Download All skips it with a message, F2 is not offered, the baseline entry survives.

### 2.3 Base-state table (E5). Every row is a test.

`=`/`≠` compare hashes. "S" absent means no baseline entry.

| # | L | B | S | L vs B | L vs S | B vs S | Base state | Primary action (click on the arrow / tooltip first link) | Baseline effect |
|---|---|---|---|---|---|---|---|---|---|
| T01 | yes | yes | any | = | any | any | **synced** | none | set S := L (origin `identical`) if S absent or S ≠ L |
| T02 | yes | yes | yes | ≠ | ≠ | = | **local-ahead** ↑ | Upload | none until transfer succeeds |
| T03 | yes | yes | yes | ≠ | = | ≠ | **board-ahead** ↓ | Compare, then Download (backup first) | none |
| T04 | yes | yes | yes | ≠ | ≠ | ≠ | **both-changed** ↕ | Compare, then choose | none |
| T05 | yes | yes | yes | ≠ | = | = | impossible (L=S=B contradicts L≠B); asserted unreachable | - | - |
| T06 | yes | yes | no | = | - | - | **synced** (same as T01) | none | create S := L |
| T07 | yes | yes | no | ≠ | - | - | **differs-unknown** ≠ | Compare, then choose | none |
| T08 | yes | no | yes, or a tombstone | - | any | - | **board-deleted** (glyph ↑+) | Upload now (never sent automatically, AS-20) | none |
| T09 | yes | no | no, and no tombstone | - | - | - | **new-local** ↑+ | Upload now; sent automatically only under AS-19 and AS-9(b) | none |
| T10 | no | yes | yes | - | - | any | **local-deleted** (glyph ↓+); flag `boardChanged` = (B ≠ S) | Copy it to my project | none |
| T11 | no | yes | no | - | - | - | **only-on-board** ↓+ | Copy it to my project | none |
| T12 | no | no | yes | - | - | - | no row (nothing exists); S is deleted at the next fresh full board read, never from a stale or partial read and never while the local scan skipped or could not read `rel` (ST-10); a tombstone for `rel` is kept | - | `forget(rel)` |
| T13 | no | no | no | - | - | - | no row | - | - |
| T14 | yes | yes | any | board cannot hash (`boardHash == none`), sizes differ | - | - | treated as L ≠ B; B vs S is "≠" if size ≠ S.size, else resolved by download-compare (RF-10), else ST-2 | as T02-T04, T07, but an auto-sync upload follows OW-7 | - |
| T15 | yes | yes | any | board cannot hash, sizes equal | - | - | download-compare (bounded, RF-10; the proof is valid for this connection only, OW-7); result feeds T01-T07; over the cap -> ST-2 | - | - |
| T16 | unreadable | any | any | - | - | - | **unreadable** ⊘ (E2a) | Fix the cause, then Try again | none; no transfer in either direction (ST-10) |
| T17 | yes or absent | yes or absent | any | - | - | - | **name-clash** ≈ (E2b): two names that differ only by upper/lower case on a case-insensitive host, or a file and a folder with one name | none: rename one of them | none; no transfer in either direction |
| T18 | symlink or junction | any | any | - | - | - | **unknown**, reason `not-supported` (the scan skips links, `localScan.ts:100-130`); no transfer | none | none |
| T19 | any | board path outside `rootPath` | any | - | - | - | no state, no badge; tooltip `This file is outside the folder your project mirrors.` | none | none |
| T20 | directory | directory | any | - | - | - | no per-file state; only the roll-up (ST-8) and NF-4 `mkdir` items | none | none |

Shortcuts (ST-4): (a) different sizes imply L ≠ B without hashing; (b) L == B wins over any S (T01/T06); (c) the mtime shortcut for B vs S in section 8.4 (H1) is the only place a board hash is inferred, and only with `boardClock == ok` at both times.

Rule ST-5: `board-deleted` and `new-local` never need CONFIRMATION to upload (the destination is absent; OW-1), but auto-sync never sends `board-deleted` (AS-20) and sends `new-local` only under AS-19 and AS-9(b).
Rule ST-6: a local rename shows as `local-deleted` (old name) plus `new-local` (new name); a rename made in VS Code is detected and offered as a move (AS-18); no baseline entry moves by itself.
Rule NC-1 (names): every path that writes a file on either side (upload, download, auto-sync, catch-up, F1, F5, the review, J5, Restore) first runs the `PathMapper` / `BoardCopy` name checks (`..`, backslash, drive letters, Windows reserved names such as `con.py`, trailing dots or spaces, case collisions, no symlinks, `src/sync/paths.ts`, `src/commands/boardCopy.ts`). A failed check skips that file with a message and never aborts the batch. Test: the hostile-name fixtures of H1 run through every entry point.
Rule NC-2 (case and kind): pairing is by exact name first. If two names fold to the same name on a case-insensitive host (Windows, default macOS), or a file and a folder share a name, every involved name is `name-clash` (T17), tooltip names both, and no transfer happens in either direction. A case-only shadow refusal from the bridge (`E_SHADOWS_MODULE`, `protocol.md:163`) is shown as `failed` with the rename advice of J5-4.

### 2.4 Overlays (E6)

| # | Condition | Effect |
|---|---|---|
| O1 | `editorDirty`, not `diskChanged`, and base ∈ {synced, local-ahead, new-local, board-deleted} | final = **unsaved-edits** ● (replaces the base; the base is still in `flags`) |
| O1b | `editorDirty` and `diskChanged` (another program saved the file on disk while the buffer is dirty), base in the same set | keep the base state; `flags.dirty = flags.diskChanged = true`; the tooltip adds `This file also changed outside VS Code. Saving in VS Code will ask which version to keep; nothing is sent until you decide.` Why `diskChanged` and not "disk equals S or B": for `local-ahead` the disk version never equals S or B, so that test would switch O1 off exactly where it matters; `diskChanged` compares the disk hash with the one recorded when the buffer first became dirty. |
| O2 | `editorDirty` and base ∈ {board-ahead, both-changed, differs-unknown, local-deleted, only-on-board, failed, unreadable, name-clash} | keep the base state, `flags.dirty = true`; the tooltip adds "You also have unsaved changes in the editor." |
| O3 | not dirty, base ∈ {local-ahead, new-local}, `effective autoSync == on` (ST-9), and one of: `!trusted` (reason `restricted-mode`), `!pairReviewed` (`unreviewed`), `program == running`, `connection == disconnected` | final = **waiting**, with the first reason in that order. `board-deleted` is NOT in the set: auto-sync never sends it (AS-20), so a tooltip promising "goes out when the program ends" would be false. A `new-local` file that AS-19 or AS-9(b) holds back is not `waiting`; it stays `new-local` and its tooltip says why. |
| O4 | `program == running` or `connection == disconnected` or a board refresh is pending after a run (section 4) | `flags.stale = true` (never a state of its own); the tooltip adds "Board status as of HH:MM." |
| O5 | `effective autoSync == off` | O3 never applies; the state stays `local-ahead` / `new-local` |

Rule ST-7 (rollup order, highest first, used for folders and the status bar): failed, unreadable, name-clash, both-changed, differs-unknown, board-ahead, local-ahead, new-local, board-deleted, waiting, unsaved-edits, local-deleted, only-on-board, unknown, synced. `ignored` and absent files do not take part.
Rule ST-8 (folder badge): a folder shows the glyph of the highest-ranked state among its non-ignored descendants; a folder whose descendants are all `synced` shows ✓; a folder with no descendants shows nothing. The tooltip lists counts per state (section 3.4).

### 2.5 Baseline lifecycle

| Rule | Text |
|---|---|
| BL-1 | An entry is written only (a) when L == B was verified in a comparison (T01/T06), (b) after a successful upload (hash from the `fs.put` result), (c) after a successful download (hash from `fs.get`), (d) when the first-sync review records identical files. Never after a failed, skipped, cancelled or protected-and-declined transfer (CLAUDE.md rule 7). |
| BL-2 | Each entry also records `boardMtime` (board `st_mtime` normalised to Unix seconds, section 8) and `clockOk` (was the board clock plausible when it was read). These two fields exist only to power the cheap change check (H1). |
| BL-3 | The baseline file is keyed by (workspace key, board key) and lives in `context.storageUri` (D-06). A **different board** (different `unique_id`) therefore starts with no baseline: its pair is unreviewed. Swapping boards back and forth keeps both histories. |
| BL-4 | The workspace key is `sha256(workspace folder URI)[:16]` (`baseline.ts:28`). A project folder that was **moved, renamed in the path, copied to another PC or synced by OneDrive to another PC** has a different URI or a different `storageUri`, so it has no baseline: its pair is unreviewed and the first-sync review runs. Safe by construction; the cost is one review per (folder, board, PC). |
| BL-5 | **Derived board keys** (`no-id-...`, `baseline.ts:33-39`, boards without `unique_id`): the pair counts as unreviewed at EVERY connect (the history is shared by identical models, so it cannot prove that this board was ever seen), and states that need S (`local-ahead`, `board-ahead`, `both-changed`) are replaced by `differs-unknown` until the review has been completed in the current connection. `boardIdDerived` is therefore an input of `state()` (2.1), so the rule is testable in the pure function. |
| BL-6 | Entries are dropped by: T12, "Forget sync history for this board" (new command in the Sync utilities view; it also drops tombstones and `quiet`), and `Clear Device Files` (existing `forgetDeleted`, `service.ts:531`), which in addition WRITES a tombstone for every file it removed (BD-1), so a cleared board is not refilled by surprise. |
| BL-7 | Baseline files not opened for 180 days are deleted at activation (bounded: at most 50 files kept, oldest removed first). |
| BL-8 | Everything else about a board (last manifest snapshot, last-checked time, clock offset) is a separate **snapshot** file `storageUri/snapshots/<ws>-<board>.json` that may be deleted at any time without losing safety (section 4). |
| BD-1 | **Tombstones.** A delete made through the extension (Files view `Delete from the board…`, `Clear Device Files`, sync with `allowDeletes`) forgets the entry AND writes a tombstone `{deletedAt}` for that `rel` in the baseline file. With a tombstone and no board file, a local file is `board-deleted` (T08), not `new-local`. A tombstone is removed when the board file exists again (any read), after a successful upload, download or review of that `rel`, or by "Forget sync history". Reason: a student who deletes `main.py` from the board to stop the robot starting at power-up must not have the next save put it back (engine today: `engine.ts:287` forgets the entry, so the file would be `new-local` and re-sent). |
| BD-2 | Auto-sync (save, watcher, catch-up) never sends a `board-deleted` file (AS-20); it needs Upload now. |
| BD-3 | At most 500 tombstones are kept, oldest dropped first (a dropped tombstone turns the file into `new-local`, which AS-19/AS-9 still gate). |

### 2.6 Baseline format v2 and migration from v1

v2 file (`storageUri/baselines/<wsKey>-<boardId>.json`, written atomically as today):

```json
{ "version": 2, "boardId": "30aea4...", "boardIdDerived": false, "workspaceName": "Lab 1",
  "createdAt": "ISO", "reviewedAt": "ISO or null", "lastSeenAt": "ISO",
  "tombstones": { "main.py": { "deletedAt": "ISO" } },
  "quiet": ["log.txt"],
  "files": { "lib/helper.py": { "sha256": "64 hex", "equiv": [], "size": 812, "syncedAt": "ISO",
                                 "origin": "identical, upload, download, review, normalised or legacy",
                                 "boardMtime": 1760000000, "clockOk": true } } }
```
`workspaceName` is the folder name for display in dialogs only; no absolute path is ever stored (D-06). `tombstones` (BD-1, at most 500) and `quiet` (the F1 "Don't ask about" list, at most 100 names) are new in v2. `equiv` (at most one hash) is written only by "Treat as the same" (RN-1).

| Rule | Text |
|---|---|
| MG-1 | Loading a `version: 1` file produces a v2 object in memory: entries copied (`sha256,size,syncedAt`), `origin:"legacy"`, `equiv:[]`, `boardMtime:null`, `clockOk:false`; `tombstones:{}`, `quiet:[]`; `boardIdDerived = boardId.startsWith("no-id-")`; `reviewedAt = max(syncedAt)` when at least one entry exists, else `null`. |
| MG-2 | The v2 file is written atomically on the first mutation, and the original v1 text is kept once as `<file>.v1.bak`. Loading twice gives the same result (idempotent). |
| MG-3 | An entry with a malformed hash is dropped (as `cleanEntries` does today, `baseline.ts:51-63`); a file that is not valid JSON, or has `version > 2`, is moved aside with the existing user message (`baseline.ts:117-121`). |
| MG-4 | An old extension build meeting a v2 file moves it aside (its existing behaviour, `baseline.ts:110`), so a downgrade loses history but never misreads it. |
| MG-5 | A v1 baseline with zero entries migrates to an unreviewed pair; a v1 baseline with entries migrates to a reviewed pair (the student already synced this pair under the old rules), but derived keys stay unreviewed (BL-5). |

## 3. User interface

### 3.1 Badges (decision D-21 (1); colour-independent; 1 or 2 characters)

| State | Badge | ThemeColor | Description word (TreeItem.description, shown after the size) | Why this glyph |
|---|---|---|---|---|
| synced | ✓ | `charts.green` | (none) | instructor |
| local-ahead | ↑ | `charts.orange` | `newer here` | instructor: "needs upload" |
| board-ahead | ↓ | `charts.blue` | `newer on board` | instructor: "needs download" |
| both-changed | ↕ | `charts.red` | `changed on both` | an arrow in both directions; `!` is kept for failures |
| differs-unknown | ≠ | `charts.purple` | `different` | "not equal" says exactly this and nothing more |
| new-local | ↑+ | `descriptionForeground` | `not on board yet` | up = goes to the board, plus = a new file |
| board-deleted | ↑+ | `descriptionForeground` | `missing on board` | same action as new-local (upload); tooltip tells the difference |
| only-on-board | ↓+ | `charts.blue` | `only on board` | down = comes to the project, plus = new here |
| local-deleted | ↓+ | `charts.blue` | `not in project` | same action as only-on-board (copy it back); tooltip tells the difference |
| unsaved-edits | ● | `charts.yellow` | `unsaved` | instructor: dot |
| waiting | … | `descriptionForeground` | `waiting` | "will happen later" |
| failed | ! | `charts.red` | `failed` | |
| unknown | ? | `descriptionForeground` | `checking` / `not checked` | |
| unreadable | ⊘ | `charts.red` | `can't read` | "cannot": the file exists but could not be read; not `!` because `!` means a transfer failed |
| name-clash | ≈ | `charts.orange` | `name clash` | "almost the same name" |
| ignored | (no badge) | - | `ignored` / `not for board` | the absence of a badge is the message; the tooltip explains which of the two reasons applies |

Rules: UI-1 each non-ignored state has a distinct (badge, description word) pair except the two documented pairs; UI-2 badge text is at most 2 characters (VS Code limit; test asserts `badge.length <= 2` for all); UI-3 the glyph and the description word carry the meaning, colour only reinforces it (works in high-contrast and for colour-blind students); UI-4 colours are built-in `charts.*` / `descriptionForeground` theme tokens, present in all themes; UI-5 one table `SYNC_STATES` (glyph, colour, word, title, tooltip builder, legend line) feeds decorations, tree item, legend and status bar, so they cannot disagree (test: legend has every state exactly once).

Local-only files (new-local, board-deleted) have no board row. The Files view therefore shows them as **virtual rows** (dimmed, same glyph rules) inside their folder, merged from the local scan; clicking opens the local file. Rule UI-6: a virtual row never exists for an ignored file.

### 3.2 Mouse-over help (exact text)

The Files-view `TreeItem.tooltip` is a `vscode.MarkdownString` with `isTrusted = { enabledCommands: [<the new command ids below>] }` and `supportThemeIcons = true`; VS Code hovers allow clicking links [K] (to be confirmed in the real-VS-Code suite, step 10). The `FileDecoration.tooltip` stays a one-line plain string (decorations cannot carry Markdown [K]) equal to the first sentence below. Commands are NEW unless named in the repo: `syncUploadFile(devicePath)`, `syncDownloadFile(devicePath)`, `syncCompare(devicePath)`, `syncKeepMine(devicePath)` (= upload with confirmation), `syncKeepBoards(devicePath)` (= download with confirmation), `syncRetry(devicePath)`, `copyToProject(devicePath)` (exists, D-20), `stopAndSend`, `showLog`, `showSyncLegend`.
Further new commands (rev 2): `syncKeepBoth(devicePath)`, `syncTreatAsSame(devicePath)`, `trustFolder`, `stopAndCheck`, `reviewBoard`, `openIgnoreList`.

Layout of every tooltip: line 1 = bold name and title; paragraph = what it means; paragraph "Clicking" = what a click does (always: `Clicking opens your file in the editor.`, D-20, except board-only states: `Clicking shows the board's copy; it is read-only.`); paragraph "What to do" with links. `{t}` is the local time of the last board read. Tokens in braces are filled at run time. `{dates}` (differs-unknown only) comes from section 8.4 (H2, TS-8); no other state has a time-derived sentence.

| State | Tooltip text (after the bold line `**{name}: {title}**`) |
|---|---|
| synced (title "Same on the board") | `Your file and the board's copy are identical. Last checked {t}.` |
| local-ahead, autoSync on, board free (title "Newer on your computer") | `Your file has changes the board does not have yet. They are being sent now.` Normally invisible; if it lingers: `Auto-sync has not sent it. Press **Upload now**, or see the status bar for why.` Links: `[Upload now]` `[Compare with the board]` |
| local-ahead, autoSync off (same title) | `Your file has changes the board does not have. Auto-sync is off, so nothing is sent until you ask.` Links: `[Upload now]` `[Compare with the board]` `[Turn auto-sync on]` |
| board-ahead (title "Newer on the board") | `The board's copy has changes your file does not have (a program may have written to it, or someone uploaded another version). Your file was not changed.` `What to do: look first, then decide. Downloading replaces your file; a backup of it is saved first, on this computer.` Links: `[Compare with the board]` `[Download (replaces my file)]` |
| both-changed (title "Changed on both") | `This file changed on your computer and on the board since they were last the same. Nothing was copied.` `What to do: compare, then keep one, or keep both. The version you do not keep is saved as a backup first, on this computer.` Links: `[Compare with the board]` `[Keep both]` `[Keep mine (replace board)]` `[Keep the board's (replace mine)]` |
| differs-unknown (title "Different, newer side unknown") | `Your file and the board's copy are different, and there is no earlier record to say which one is newer. {dates} Nothing was copied.` `What to do: compare, then keep one, or keep both (the board's copy is saved next to your file). The version you do not keep is saved as a backup first, on this computer.` Links: `[Compare with the board]` `[Keep both]` `[Keep mine (replace board)]` `[Keep the board's (replace mine)]` |
| new-local (title "Not on the board yet") | `This file exists only on your computer.` Sent automatically: `It is sent to the board when you save it, or now: press **Upload now**.` Auto-sync off: `Press **Upload now** to put it on the board.` Held back (AS-19, AS-8, AS-9(b)), one of: `Auto-sync does not send this file by itself because its name has spaces or brackets (MicroPython cannot import such a name)` / `…because it appeared without being saved in VS Code (for example OneDrive delivered it)` / `…because it is {size} (about {minutes} minutes to send)` / `…because main.py and boot.py run every time the board is powered on`, followed by `Press **Upload now** if you want it on the board.` Links: `[Upload now]` |
| board-deleted (title "Missing on the board") | `This file used to be on the board but is gone (it was deleted, or the board was cleared). Your file is fine. Auto-sync does not put it back by itself; press **Upload now** if you want it there.` Links: `[Upload now]` |
| only-on-board (title "Only on the board") | `This file is on the board but not in your project folder (for example a program created it). Clicking shows the board's copy; it is read-only.` Links: `[Copy it to my project]` `[Delete from the board…]` |
| local-deleted (title "Not in your project any more") | `This file was in your project but is gone (deleted or renamed). The board still has it; nothing was deleted from the board.{boardChanged: The board's copy has also changed since.}` Links: `[Copy it to my project]` `[Delete from the board…]` |
| unsaved-edits (title "Unsaved changes") | `You have changes in the editor that are not saved yet. Save (Ctrl+S, or Cmd+S on a Mac) and the file is sent to the board.` (autoSync off: `…and then use Upload now.`) |
| waiting (title "Waiting to be sent") | running: `A program is running on the board, and files cannot be sent while it runs. Your file goes out when the program ends. If your program never ends (for example a main.py that loops forever), press Stop.` Links: `[Stop the program and send now]`. disconnected: `The board is not connected. Your file goes out when it is connected again.` unreviewed pair: `Auto-sync is waiting for you to review this board first.` Links: `[Review the board's files]`. restricted-mode: `This folder is open in Restricted Mode, so nothing is sent automatically.` Links: `[Trust this folder]` |
| failed (title "Could not be copied") | `The last attempt failed: {message}` `Auto-sync will not retry this file by itself.` Links: `[Try again]` `[Show log]` |
| ignored (title "Ignored") | ignore-list: `This file matches your ignore list (.mpyignore), so it is never copied automatically.` not-for-board: `This kind of file (or a file this large) is not copied to the board automatically. You can still send it with **Upload now**.` Links (not-for-board): `[Upload now]` |
| unknown (title "Checking" / "Not checked yet") | `The board has not been compared with this file yet.` Reason-specific second sentence: disconnected: `Connect the board to check.` program-running: `The board is running a program, so its files cannot be read.` Links: `[Stop the program and check]`. restricted-mode: `This folder is open in Restricted Mode.` Links: `[Trust this folder]`. |
| unreadable (title "Could not read your file") | `This file is in your project but could not be read ({reason: it took too long to open / another program has it locked / no permission / it is stored online only by OneDrive}). It was not copied in either direction and the board's copy was not touched.` `What to do: for OneDrive, right-click the file in your folder and choose "Always keep on this device", then try again.` Links: `[Try again]` `[Show log]` |
| name-clash (title "Name clash") | `Two names here differ only by upper and lower case, or one is a file and the other a folder, so they cannot be told apart on this computer: {names}. Nothing is copied in either direction.` `What to do: rename one of them (MicroPython treats Main.py and main.py as different files).` |

Stale suffix (O4), appended as a last line in grey: `Board status as of {t}. {The board is not connected.|A program is running on the board.}`
Footers added to every tooltip when they apply: `flags.diskChanged` (O1b) `This file also changed outside VS Code.`; board with `boardHash == none`: `This board cannot check file contents, so only new files are sent automatically; use Upload now to replace a file.` (OW-7).
Rules UI-7: every state has a tooltip with at least one sentence saying what it means and one saying what to do; UI-8: a tooltip never says a file "will be overwritten" without saying that a backup is made; UI-9: wording uses "your computer / your project" and "the board", never "local / remote / baseline / hash". UI-8 covers protected transfers and downloads; the tooltip of an unprotected upload whose destination equals S says "sent", not "replaced", because that destination is the student's own earlier version (OW-3). SYNC_STATES has 16 states (the 14 of rev 1 plus unreadable and name-clash).

### 3.3 Context menu and click

D-20 stays: a click on a row that has a project file opens the project file; a board-only row opens the read-only board copy and offers "Copy it to my project". `contextValue` = `upy.file.<state>` so right-click entries are shown per state (Upload only for ↑ / ↑+; Download only for ↓ / ↓+ / ≠ / ↕; Compare for ↑ ↓ ↕ ≠; Copy it to my project for ↓+; Keep both / Keep mine / Keep the board's for ↕ ≠; Try again for `!` and ⊘). Right-click always also offers "What does this symbol mean?".

### 3.4 Folder roll-up text

Badge per ST-8. Tooltip: `**{folder}** {n files}` then one line per non-zero state in rollup order, for example:
`2 files to send (↑)`, `1 file changed on the board (↓)`, `1 file changed on both (↕)`, `3 new files only here (↑+)`, `1 file only on the board (↓+)`, `14 in sync (✓)`. Links: `[Upload the files that are ahead]` (only ↑ and new-local, with the protections of section 6) and `[Download new board files]` (section 7).

### 3.5 Legend

`Sync utilities` view gets a first row `What do these symbols mean?` (and a `$(question)` button in the Files view title bar) running `showSyncLegend`, which opens a read-only Markdown preview generated from `SYNC_STATES` (glyph, name, one sentence, what to do). Rule UI-5 keeps it complete.

### 3.6 Status bar (the existing auto-sync item, `src/statusbar.ts`)

| Row (the first that applies) | Situation | Text | Tooltip first line |
|---|---|---|---|
| 1 | any failed, unreadable or name-clash | `$(error) {n} failed` | the first message |
| 2 | any board-ahead, both-changed or differs-unknown | `$(warning) {n} need a look` | `{a} changed on the board, {b} changed on both, {c} differ. Click to review.` |
| 3 | pair unreviewed (auto-sync would be on) | `$(clock) Review the board's files` | `Auto-sync is waiting for you to check this board ({board}, id …{last4}). Click to review.` |
| 4 | workspace not trusted | `$(shield) Trust this folder to send files` | `Restricted Mode: nothing is sent automatically.` |
| 5 | program running and files unknown | `$(debug-pause) A program is running; files are not checked` | `Stop the program to check the files.` |
| 6 | any waiting (disconnected, program running) | `$(clock) {n} waiting` | `{n} files wait for the program to end` / `…for the board to connect` |
| 7 | uploading now | `$(sync~spin) Sending {k} of {n}…` | `Sending your saved files to the board.` |
| 8 | any local-ahead, new-local or board-deleted not covered above (auto-sync off, or held back by AS-8, AS-19, AS-9(b), AS-20) | `$(cloud-upload) {n} to send` | `{n} files are not on the board or are different there. Auto-sync is off or is not sending these. Click to upload.` |
| 9 | any unsaved-edits | `$(circle-filled) {n} unsaved` | `Save the files to send them.` |
| 10 | any only-on-board or local-deleted | `$(cloud-download) {n} only on the board` | `{n} board files are not in your project. Click to download.` |
| 11 | any unknown | `$(question) {n} not checked` | `Connect the board or press Refresh.` |
| 12 | every non-ignored file synced, auto-sync on | `$(check) Board in sync` | `All {n} files match the board (checked {t}).` |
| 13 | every non-ignored file synced, auto-sync off | `$(sync-ignored) Auto-sync off` | `All {n} files match. Click to turn auto-sync on.` |
| 14 | catch-all (should be unreachable: rows 1-11 cover every non-synced state) | `$(info) {n} files differ (see Files)` | `Open the Files view.` |

Click opens the Sync utilities view. A disconnected board shows the last snapshot with the tooltip suffix `Board not connected; status as of {t}.` (O4). A `boardHash == none` board adds the OW-7 sentence to the tooltip.
Rule SB-1: `Board in sync` (row 12) and `Auto-sync off` (row 13) require EVERY non-ignored file to be `synced`; any other combination maps to exactly one of rows 1-11 or 14, never to "in sync". Test U7: `statusBarRow(counts, ctx)` is total and single-valued over all state-count vectors.

### 3.7 Accessibility

UI-10: every tree item sets `accessibilityInformation.label` = `{name}, {title}` and `role = 'treeitem'`; UI-11: the description word duplicates the badge for screen readers and colour-blind users; UI-12: no state is conveyed by colour or animation alone; UI-13: dialogs (section 6) are native modals (keyboard operable) with the safest action as the non-default (Cancel or Compare first).

## 4. Board-side refresh policy

Facts [S]: `fs.manifest` lists with `os.ilistdir`, stats every file, and (when `hash`) sha256-hashes every file in one on-board loop; only paths and hashes cross the link (`bridge/devfs.py:222-278`). Transfers are the slow part (about 4 KB/s on the class link [instructor's figure, U]; a 20 KB file is about 5 s); the on-board hashing speed is [U] and is measured in step 4 of the work breakdown (hardware phase, scratch folder only). Today every refresh hashes everything.

Protocol additions (all small, all in `bridge/devfs.py` + `docs/protocol.md`):
- **P1** manifest entries carry `mtime` (Unix seconds, normalised by the bridge from the board epoch; see 8.1) and the manifest head carries `now` (board `time.time()`, normalised) and `epochYear` (1970 or 2000, from `time.gmtime(0)[0]`). The stat is already done for `size`, so this is free.
- **P2** `fs.hash {paths:[...]}` -> `{hashes:{path: hex|null}}` in one round trip; `fs.manifest {hash:false}` already exists (`hash?=true`).
- **P3** `fs.put` result gains `mtime` of the finished file.
- **P4** `fs.put {ifBoardSha}`: compare-and-swap. `ifBoardSha` is `"absent"`, a hex digest, or a list of them; the board hashes the existing destination before writing and refuses with `E_DEST_CHANGED {boardSha|null}` unless it matches. One call, no race. Available only when `identity` reports `hash: sha256`; a `hash: none` board cannot offer it and is handled by OW-7.
- **P5** `time.set` (set the RTC from the host) and `identity.clock` (section 8.6).
- **P6** cancellation: `cancel {target}` already stops a running file op at the next chunk (`protocol.md:58` [D]). The extension must send it for a `background:true` put or get when a Run, Stop or other explicit board operation is requested (AS-21); `fs.get` and `fs.hash` must honour it too. [U: worst-case latency of one chunk, measured in W4.]
- **P7** `fs.get {local, mode: 'exclusive' or 'replace', expectLocalSha?}`: the bridge writes the temp file next to the destination, then (exclusive) links it into place and fails with `E_LOCAL_EXISTS` if the destination exists, or (replace) re-hashes the destination immediately before the rename and fails with `E_LOCAL_CHANGED {localSha}` unless it equals `expectLocalSha` (OW-5).

| Rule | Text |
|---|---|
| RF-1 | Triggers for a board read: (a) connect completes with an idle board; (b) a Run ends (any exit) and the board is idle; (c) the student presses Refresh in the Files view or the Sync utilities; (d) after a Files-view command that changes the board (new, rename, delete): a targeted `fs.stat`/`fs.hash` of the paths involved, not a full read; (e) a REPL tab closes (the student may have written files there): one refresh. After an upload or download the state of THAT file is set from the transfer result (no read). |
| RF-2 | Never while a program runs and never from a timer. When a Run starts, all board-derived states get `stale` (O4) and keep their last value. Reads that arrive while the board is busy are deferred, not failed. |
| RF-3 | Read in two steps: `fs.manifest {hash:false}` (sizes and mtimes, small), then `fs.hash` for the files that need it, in calls of **at most 20 files or 64 KB of file data each**, so Run/Stop can be served between calls and the progress of RF-6 is real. A file needs hashing unless H1 (8.4) applies: its (size, mtime) equal the baseline's `(size, boardMtime)`, `baseline.clockOk` is true and the board clock is plausible now. `fs.manifest {hash:true}` remains the fallback when `fs.hash` is not supported. |
| RF-4 | Hashes are always read fresh before an overwrite decision: every protected check goes through P4 (`ifBoardSha`) or a fresh hash, never through H1. |
| RF-5 | The result is stored as a snapshot (BL-8) with `checkedAt`; a disconnected window shows the snapshot with `stale`; a snapshot for another board id is never shown. |
| RF-6 | Progress: a status-bar message `Checking the board (k of n)…`; the Files view shows `unknown "checking"` only for files whose result is not in yet, never blanks the tree. Cancel is possible; cancelled leaves the old snapshot. |
| RF-7 | Programs that write files: the end-of-run read (RF-1b) finds them, and section 7 offers them. A program that is killed by unplugging is handled by RF-1a at the next connect. |
| RF-8 | A refresh never resets the board and never interrupts a program (CLAUDE.md rule 5). |
| RF-9 | In an untrusted workspace (Restricted Mode) no automatic board read and no local scan runs; states show `unknown` with reason `restricted-mode`; an explicit Refresh works, but nothing is sent (AS-4). |
| RF-10 | `boardHash == none` boards: a refresh uses sizes only. A bounded download-compare (at most 64 KB per file and 256 KB per refresh, only for an explicit Refresh or Compare, and cancellable) decides equality; a file over the cap stays `differs-unknown` (ST-2). The proof "board equals S" is dropped when a Run starts, a program runs, or the connection ends (OW-7). |

### 4.1 Local scan (the L side)

| Rule | Text |
|---|---|
| LS-1 | L comes from a cache keyed by `(size, mtimeMs, ino)` (`(size, mtimeMs)` where `ino` is unreliable); a file is re-hashed only when its key changed or the cache has no entry. The cache lives in memory and in `storageUri/snapshots/` (BL-8), never in the project. Today every scan hashes everything (`localScan.ts:150-159`). |
| LS-2 | A file whose extension is not on the board allowlist (`upyBridge.sync.boardExtensions`, default `.py .mpy .json .txt .csv .cfg .ini .bin .dat`) or that is larger than `sync.autoMaxFileKB` is `ignored` with reason `not-for-board` and is **not opened**. It is excluded from the F2 emptiness test, the roll-up and the status-bar counts. Exceptions: the board has a file of that exact name (then it is read once and paired normally), or the student presses an explicit Upload on it. |
| LS-3 | A file that carries the operating system's "online only" attribute (macOS dataless flag, Windows `RECALL_ON_DATA_ACCESS`) is `unreadable` with reason `offline` without being opened. [U: reading these attributes from Node without native modules needs a spike, W4b. Until it exists, LS-5 is the only guard.] |
| LS-4 | The file-system watcher only marks a path "touched"; the hash is computed once per path after the debounce (AS-6), through LS-1. Nothing is hashed inside a watcher callback (today `autosync.ts:136, 187-198`). |
| LS-5 | A file that times out (the existing 15 s `readTimeoutMs`), is locked or is denied is returned by `scanLocal` in a new `unreadable[]` list (with the reason) instead of only a warning; it is retried on the next scan, on Try again, or when its cache key changes. |
## 5. Auto-sync

### 5.1 Setting and default

| Rule | Text |
|---|---|
| AS-1 | `upyBridge.autoSync` enum `on` / `ask` / `off`; **default `on`** (D-21 (2); reverses Q-03 "ask"). `contributes.ts:175`, `settings.ts:85-90` change. `ask` stays only as a legacy value with the meaning of ST-9 ("off until the first-sync review has been answered, then on"); the review (5.2) REPLACES the old `askFirstConnect` question (`autosync.ts:338-376` is removed), so a pair never gets two first-connect dialogs. |
| AS-2 | New installs and workspaces with no explicit value get `on`. |
| AS-3 | Existing users: an explicit `ask`/`on`/`off` in any settings scope is honoured unchanged. A workspace whose setting is NOT explicit but whose `workspaceState.autoSyncChoice` is `off` (the student answered "Not now" to the old question, `autosync.ts:366-369`) gets `autoSync: off` written to its workspace settings once (migration flag in `workspaceState`) and one information toast: `Auto-sync stays off in this project because you chose that earlier. You can turn it on in Sync utilities.` |
| AS-4 | `on` is inert in an untrusted workspace (`autosync.ts:96-98` kept) and until the pair is reviewed (5.2). The states say so: `waiting` with reason `restricted-mode` or `unreviewed` (O3), never "being sent now". |
| AS-5 | Only local to board. Auto-sync never downloads, never deletes, never renames on its own, never replaces a board file that is protected (OW-1). |

### 5.2 First-sync review (FSR): required for every unreviewed pair

Trigger: a connect completes (idle board), the pair is unreviewed (BL-3/4/5, MG-5), and the workspace is trusted. Until the review is **completed, deliberately skipped for this connect, or recorded automatically (FS-6)**, auto-sync uploads nothing for this pair (states show `waiting`, O3) and no catch-up runs. Manual Upload Current File / Upload All still work but every differing file is protected (no S, OW-1).

Step A (one modal summary, all counts from one board read with hashes; Escape = Not now):

```
Title:   This board has not been compared with "{workspaceName}" yet
Detail:  Board: {board name or model}, port {port}, id ends …{last4}.  Is this the board you meant?
         Identical: {a} files
         Only in your project: {b} files{list up to 5}
         Only on the board: {c} files{list up to 5}
         Different: {d} files{list up to 5}
         Nothing has been changed yet. Before anything is replaced you will be asked, and a backup of the replaced file is saved on this computer.
Buttons, d > 0:    [Review the files…]  (default)                          (Escape = Not now)
Buttons, d == 0:   [Review the files…]  (default)  [Sync as suggested]      (Escape = Not now)
```
"Review the files…" opens the multi-select list (the existing preview list, `src/sync/preview.ts`, with groups and a **Compare** item button on every row) and is always the default button; "Sync as suggested" applies the default column below and is offered only when nothing differs (`d == 0`), so the one-click path can never touch a file whose direction is unknown. "Not now" leaves the pair unreviewed for THIS connect only (FS-7).

| Class | Default | Why |
|---|---|---|
| identical | nothing to do; recorded as S (origin `review`) | |
| only in your project | **upload** (additive: the destination is absent), except `main.py` and `boot.py`, which are listed unticked (AS-9(b)) | OW-1 allows it; a board handed over keeps the partner's files and gains yours |
| only on the board | **download only when the project has no files other than ignored and not-for-board ones (F2)**; else not selected | empty-folder case (7.2) vs. mixed folder (7.3) |
| different | **do nothing**; each file shows `≠` with Compare; per file the student may choose **Keep both** (listed first; the board's copy is saved next to the project file, KB-1), Keep mine, or Keep the board's | direction unknown, never preselect an overwrite (TS-6); the board copy may exist nowhere else (a partner's file) |

Rules: FS-1 `reviewedAt` is set when Step A is answered with either button or the list is applied; FS-2 the review never replaces a differing file unless the student ticked it, and then OW-3 (backup) applies; FS-3 the dialogs never mention hashes or baselines; FS-4 a file that differs and is left alone stays `≠` and auto-sync skips it (OW-4) without nagging; FS-5 if the board is empty and the project has files, Step A is replaced by one line in the status bar and a non-modal toast `The board is empty. Send your {b} files to it?` [Send them] [Not now] (nothing to protect; the board name and id end are in the toast).
FS-6 **No dialog when nothing would be sent, replaced or downloaded** (lab PCs whose profile is wiped would otherwise repeat the modal every session and train click-through, R-17): when `b == 0` and `d == 0` and the project is not empty-with-board-files (F2), Step A is skipped, the pair is recorded as reviewed, and a one-line toast says `Checked board {name} (…{last4}): {a} files match{; c files are only on the board [Review]}.` If `b > 0` and `d == 0` the dialog is shown (the board name and id end are the guard against a neighbouring bench's board).
FS-7 **"Not now" is per connect, and it is never silent**: the first save while the pair is unreviewed and auto-sync is `on` shows ONE non-modal toast per connect, `Your file was saved but not sent: the board has not been checked yet. [Review now]`; the status bar shows row 3 of 3.6; the question returns at the next connect.
FS-8 The dialog and the review list name the board (name, port, last four characters of the id) every time, so a student with several identical boards on the bench can see which one this is.

### 5.3 Saves, debounce, many files

AS-6 events: save (`onDidSaveTextDocument`), create and rename from VS Code (`onDidCreateFiles`, `onDidRenameFiles`), and file-system watcher create/change. Debounce `sync.debounceMs` = **1500 ms of quiet** per path (was 400 ms, `contributes.ts:182`; with VS Code autosave `afterDelay` the old value kept an upload running all the time and a Run waited behind it, R-07); a path is hashed only after the debounce (LS-4); a file whose hash equals S is dropped silently (touched, not changed; cloud clients, RQ-CLOUD-4, `autosync.ts:254-257`).
AS-7 "Save All" or a generated batch coalesces into ONE flush: files go out sequentially in path order, the status bar shows `Sending k of n…`, one summary toast only when something failed.
AS-8 size limit: a file larger than `sync.autoMaxFileKB` (default **64**, was 512; 512 KB is 128 s at 4 KB/s) is not sent automatically; it stays `↑` (or `↑+`) with the tooltip addition `This file is {size}; sending it would take about {minutes} minutes. Use Upload now.` The estimate is `size / 4 KB/s`. Estimates over 10 s are always shown (dialogs and tooltips).
AS-9 `main.py` / `boot.py` (`STARTUP_FILES`, `engine.ts:238`) run at every power-up. (a) Board copy exists and equals S (`local-ahead`): auto-sync sends it and keeps the existing one-time disclosure (RQ-SAFE-7, `engine.ts:233-246`). (b) Board copy is absent (`new-local`, `board-deleted`, tombstoned): auto-sync does NOT send it; at most once per file per connect a non-modal toast says `main.py runs every time the board is powered on. Put it on the board?` [Send it] [Not now]; [Send it] is an explicit upload. Deviation from the review's wording ("always asks, modal, every time"): a modal on every save of the file students edit most would become click-through noise; the dangerous case is the file appearing at power-up where there was none, which is (b). Open decision O-13.
AS-19 **Which new files are sent by themselves.** A `new-local` file is auto-sent only when ALL hold: (a) it came from a VS Code event (save, create, rename) or the send is the connect-time catch-up (5.6); (b) its extension is on the board allowlist and it is within `autoMaxFileKB` (LS-2); (c) its name uses only letters, digits and `_ - . /` (no spaces, brackets or other punctuation; such names cannot be imported and are typical OneDrive conflicted copies such as `main-LAB-PC (1).py`). A file that appears only through the watcher (OneDrive delivery, a download, a screenshot) stays `new-local` ↑+ until Upload now, and its tooltip says why. This does not apply to files that already have S (a Thonny or Notepad save of a known file is still sent).
AS-20 **Auto-sync sends only `local-ahead` and `new-local`.** `board-deleted` files (tombstoned, or S present and the board file gone) are never sent automatically, not on save, not in the watcher, not at catch-up (BD-2, ST-5); they show ↑+ and count in row 8 of 3.6. Accepted consequence: after a board is re-flashed or cleared, the student presses Upload now (or Upload All) once. Open decision O-12.
AS-21 **Background transfers are cancellable.** Auto-sync uploads, F1c downloads and catch-up are `background:true`. Run, Stop, Upload now, Download and any other explicit board operation first send `cancel` for the in-flight background transfer (P6; the file stays queued; no temp file remains), then run. Test: fake board at 4 KB/s, a 64 KB upload in flight, a Run op starts within one chunk time.

### 5.4 A program is running

AS-10 states `local-ahead`/`new-local` become `waiting` (O3); files are queued by path; when the board becomes idle the queue is flushed (existing `onState`, `autosync.ts:326-331`). Nothing is sent, nothing interrupts the program.
AS-11 The queue is **derived, not stored**: after a window reload or reconnect it is rebuilt from the states (catch-up, 5.6). Test: kill the queue object, reconnect, the same files go out.
AS-12 Run interplay (D-20): when the student presses Run with a program running, the existing question (`run.ts:186-188`) stays the ONLY question, and it names what else will happen: `A program is running on the board. Stop it, send {n} changed file(s), and run {name}?` [Stop it and run]. When n = 0 the text is today's `A program may already be running on the board. Stop it and run {name}?` (`run.ts:186-188`). After "Stop" succeeds, the flush (queue plus imported modules, section 9) runs before the new program starts (`run.ts:221-231`).
RUN-1 **Run is single-flight.** While the extension prepares a run (save, flush, import closure, stop, upload) or is starting one, a second press is ignored and the status bar shows for 4 s `Still getting the board ready for the first Run`; when a program started by Run is already running, the AS-12 question applies as before. Test: two presses 100 ms apart on a fake board produce exactly one flush and one `run` op; a press after the run started shows the AS-12 question. (Today `run.ts:94, 186-219` has no guard.)

### 5.5 Disconnected board

AS-13 `waiting` with the tooltip in 3.2; on reconnect a pair that is reviewed gets catch-up (5.6). An unplug during an upload: on **LittleFS** the bridge writes `.mpytmp` then renames (`docs/protocol.md:42`), so no half-written file exists, the destination keeps its old content, and the file stays `local-ahead`; connection errors are deferrable (`autosync.ts:65`), not failures. On **FAT** (SD cards, pyboard; remove-then-rename, `protocol.md:146`) a drop between the remove and the rename leaves the destination ABSENT with the temp file holding the only copy of the new data: the file then reads `board-deleted` (S present, B absent), which auto-sync never sends (AS-20), and the leftover `.mpytmp` is cleaned by the bridge next session (`bridge/server.py:1160` [S, per the review]). Accepted risk [I: rare]: the student's own file is intact on the computer and Upload now sends it. Replace-in-place where the port allows renaming over an existing file is a possible bridge improvement, not required (open decision O-17).

### 5.6 Catch-up at connect (reviewed pairs only)

After the RF-1a read, auto-sync uploads every `local-ahead` file and every `new-local` file that passes AS-19 (b) and (c) (destination equals S or is absent, so no protection is needed; on a `boardHash == none` board only absent destinations, OW-7), and applies AS-9(b) to startup files. It does NOT upload `board-deleted` files (AS-20: a cleared board must not be refilled by surprise) and never touches `board-ahead`, `both-changed`, `differs-unknown`, `unreadable` or `name-clash`.

### 5.7 Failures and retry

| Rule | Text |
|---|---|
| AS-14 | Deferrable errors (`E_PROGRAM_RUNNING`, connection errors) keep the file queued (`DEFERRABLE`, `autosync.ts:65`). |
| AS-15 | `E_DEST_CHANGED` (P4) is not a failure: the file becomes `board-ahead`/`both-changed`/`differs-unknown` from the returned `boardSha`, with ONE non-modal toast per file per session: `{name} was not sent because the board's copy is different from the one you started from. [Compare] [Keep mine…] [Keep the board's…]`. |
| AS-16 | Every other error (`E_SHADOWS_MODULE`, `ENOSPC`, unreadable local file, `E_LOCAL_IO`) makes the file `failed` and is not retried until the file changes, the student presses Try again, or the board reconnects. At most one failure toast per 60 s; further ones go to the log and the status bar count. |
| AS-17 | A file that is dirty at the moment a transfer would start is not sent (the saved content is what is sent, never the buffer); a download or replace of a dirty file is skipped with E_DIRTY as today (`engine.ts:268-270`). |

### 5.8 Deleting and renaming

AS-18 A local delete or rename never deletes or moves anything on the board by itself.
(a) **Delete.** On a delete event (VS Code or watcher) the path is stat'ed again after 1.5 s and reported only if it is still absent (vim, Notepad++ safe-save and `git checkout` delete and re-create; today `autosync.ts:389-421` reports at once). A path that is really gone becomes `local-deleted` (↓+), toast wording kept.
(b) **Rename in VS Code** (`onDidRenameFiles`, exact old and new names). The new name is NOT scheduled for upload (`noteChange(new)` at `autosync.ts:384-387` is removed). If the old name has an S entry and the board still has the old file equal to S, the offer `You renamed {old} to {new}. Rename it on the board too?` [Rename on the board] [No] is shown. "Rename on the board" runs `fs.mv` (never overwrites, `protocol.md:149`) and moves the baseline entry (`BaselineStore.rename`), so nothing is re-uploaded at 4 KB/s. "No", a dismissed toast, or no answer for 60 s uploads the new name normally (AS-19 applies); the old one stays `local-deleted`, and when the old name was `main.py` or `boot.py` the toast adds `The old {old} is still on the board and still runs when the board is powered on.` If the old board file is not equal to S, no offer is made and the new name is uploaded normally.
(c) **Rename done outside VS Code** (the watcher sees a delete and a create): when within 2 s a path with an S entry vanished and a new path appeared with the same hash, treat it as (b); otherwise as a separate delete and create.
Test: rename `main.py` to `robot.py` against a fake board: no `fs.put` before the offer is answered; "Rename on the board" produces one `fs.mv` and no put; "No" produces one put and the old row reads `local-deleted`; a delete followed by a create of the same path within 1 s produces no report.

### 5.9 Mode button

The Sync utilities toggle cycles on -> off -> on (the legacy `ask` is only reachable through settings.json); its tooltip is `Auto-sync is ON: files you save are copied to the board. Nothing is ever downloaded or deleted automatically.` / `Auto-sync is OFF: ...`.

## 6. Overwrite protection

### 6.1 The one rule

**OW-1.** A transfer replaces its destination without asking only when the destination is absent, or already equals the source, or equals the baseline S. Otherwise (destination exists, differs from the source, and S is absent or differs from the destination) the transfer is **protected**: it needs a confirmation and a backup. A destination that is `unreadable` (local side) is never replaced (ST-10). Test: for every combination of (dest ∈ {absent, =src, =S, other, unreadable}, S ∈ {absent, present}) the function `isProtected()` returns exactly this.
**OW-2** The rule applies identically to: manual Upload Current File, Upload All, Download All, "Keep mine", "Keep the board's", Download (↓), auto-sync, catch-up, Run's own uploads (imported modules), "Copy it to my project", the first-sync review, Restore, and the program-created-files offer. There is no code path that writes a file on either side except through one function, `transfer(dest, source, S)`, which applies `isProtected()`. Test (not a grep): `transfer()` is the only holder of the bridge write handles and the local write functions (they are injected into it); the fake board and the fake local file system throw on a write whose caller token is not `transfer()`; the property test of U3 drives every command through the fake and never trips that guard.
**OW-3** Every protected transfer makes a backup of the destination first and aborts the transfer if the backup fails (existing message, `engine.ts:312`); the backup path cannot be too long (BK-7). Every overwrite of an existing LOCAL file is backed up, protected or not (cheap; today's behaviour, `engine.ts:272`). A BOARD file replaced without protection (destination = S) is not backed up (the cost is a 4 KB/s download and the content is, by definition, an older version of the student's own file). The dialogs say that backups are kept on this computer only.
**OW-4** Auto-sync and catch-up never ask a modal question: a protected transfer is skipped and shown (AS-15). Everything else goes through a dialog.
**OW-5** *Upload side:* enforced on the board by `ifBoardSha` (P4) when the board can hash, so a change between the board read and the write is still caught. *Download side (project destination):* (a) the planner said `absent`: the bridge creates the destination exclusively (P7 `mode: exclusive`; `E_LOCAL_EXISTS` if it exists), so a file that arrived in the meantime (OneDrive delivering another PC's version, Thonny, a safe-save editor) is never replaced; the file is re-planned and shows its new state. Today `engine.ts:267-275` renames over it with no check. (b) the planner said `exists`: the destination is backed up (OW-3), and the bridge re-hashes it after the temp download and immediately before the rename (P7 `mode: replace`, `expectLocalSha` = the hash that was backed up); a different hash aborts that file with `E_LOCAL_CHANGED` and the message `{name} changed on your computer while it was being downloaded, so it was not replaced.` This is stricter than "back up and replace anyway" because the student confirmed replacing a different version. (c) `isDirty` is checked immediately before replacing (VS Code buffers only).
**OW-7** *Boards that cannot hash* (`boardHash == none`, `protocol.md:40`, D-15): P4 is unavailable, so (a) auto-sync and catch-up upload a file only when the board file is absent, or when a bounded download-compare in the CURRENT connection (RF-10) proved the board copy equal to S's content and no Run has started since; (b) every other existing file that differs or cannot be compared is `differs-unknown` (ST-2) and is replaced only through the OW dialog; (c) tooltips and the status-bar tooltip say `This board cannot check file contents, so only new files are sent automatically.` Test: fake board with `hash: none`; a program rewrites `data.csv` with the same size; a save does not produce an `fs.put`; a Run between compare and save invalidates the proof.
**OW-8** *Accepted residual risk.* Two windows cannot be closed: (1) on a `hash: none` board, between the download-compare and the put (no on-board compare-and-swap); (2) for a project destination, between the bridge's final re-hash and the rename (neither Node nor Python offers a local compare-and-swap on NTFS or in a OneDrive folder [K]; the window is milliseconds on macOS and Windows alike, and OneDrive may deliver a file in it). Mitigations: the unconditional local backup (OW-3), the re-hash (OW-5), the 1.5 s debounce. Invariant I1 is therefore worded "no destination content is lost except inside the windows of OW-8", not "no loss". Open decision O-19.

### 6.2 Dialog texts (native modal, English, one dialog per batch; only files that would LOSE changes are listed)

Upload batch / single file (destination = board):
```
Title:  Replace {n} file(s) on the board?
Detail: These files on the board are different from the version you started from. They will be replaced by your project's versions:
          lib/helper.py   (board copy changed {when / "at an unknown time"}, {size})
          main.py
        A copy of the board's version of each file is saved first, on this computer only (not on the board, not in your project folder). [Show where backups are kept]
Buttons: [Keep both]  [Replace {n} file(s)]  [Compare…]  [Skip these]            (Escape = Skip)
```
Download batch / single file (destination = project):
```
Title:  Replace {n} file(s) in your project?
Detail: These files in your project have changes the board does not have. They will be replaced by the board's versions:
          data.csv
        A copy of each of your files is saved first. [Show where backups are kept]
Buttons: [Replace {n} file(s)]  [Compare…]  [Skip these]
```
Unknown direction (no baseline, review or manual) uses the same dialog with the first sentence `These files are different on the two sides and there is no record of which is newer.` Large batches: first 12 names, then `… and {k} more`. "Compare…" with several files opens a pick list, then VS Code's diff editor (board copy left, project file right) for the chosen one, then returns to the dialog. If the dialog stays open nothing changes (OW-6: Escape, close, or "Skip" changes nothing).
Toast after the transfer (non-modal): `Replaced {n} file(s). The previous versions are saved. [Show Backups] [Restore…]`.
KB-1 **Keep both** (offered on every `differs-unknown` and `both-changed` row, in the review list and as the first button of the upload dialog whenever a listed file has no S entry, that is, the board copy has unknown origin such as a lab partner's file that exists nowhere else): the board copy is downloaded next to the project file as `name.board.ext` (`name.board.2.ext` if that exists; exclusive create, NC-1 checks), nothing is uploaded and nothing is replaced. The pair stays `≠` / `↕` until the student decides, and the new file matches the built-in ignore pattern `*.board.*` (added to `DEFAULT_IGNORE_GROUPS`, `ignore.ts:16-37`) so it is never synced. Reason: the board copy may exist nowhere else, and backups live on this computer only (BK-1, BK-6). A board copy over 256 KB shows the time estimate first (BK-4). Test: Keep both leaves the board file byte-identical, creates exactly one new project file, records no S.
RN-1 **Line endings and BOM.** Compare on a pair whose texts are equal after normalising CRLF and CR to LF, or that differ only by a UTF-8 BOM, says `Only the line endings differ` / `Only the BOM differs` and offers `Treat as the same` (never automatic). It writes S := {sha256: L, equiv: [B], origin: `normalised`} and transfers nothing; while L and B stay as they are the file reads `synced` (ST-3); when either side changes later, the pair is judged again by the ordinary rules. Test: CRLF vs LF fixture: no `fs.put`/`fs.get`, state `synced`; a later local edit gives `local-ahead`.

### 6.3 Backups

| Rule | Text |
|---|---|
| BK-1 | Location `storageUri/backups/<yyyymmdd-hhmmss>/` with `p/<n>.bak` (project files) and `b/<n>.bak` (board files), `n` a counter, plus `manifest.json` (`[{n, side, rel, when, sha256, size}]`); `rel` is never part of a path (BK-7). Folders written by earlier builds in the `<rel>` layout (`engine.ts:34-57`) stay readable: Restore reads the manifest when present, else walks the tree. `Show Backups` opens the newest folder. |
| BK-2 | Retention: the newest 20 backup folders (existing `BACKUP_KEEP`, `engine.ts:22`) AND total size at most 200 MB (oldest removed first); a backup folder younger than 24 h is never removed by the size rule. |
| BK-3 | `Restore…` (new command, Sync utilities and toast): pick a file, pick a backup time, then the restore is itself a protected transfer (the file it replaces is backed up). |
| BK-4 | A project file larger than 20 MB, or a BOARD file larger than **256 KB** (about 64 s at 4 KB/s; the old 2 MB figure was 8.5 min), is not backed up automatically: the dialog shows `{name} is {size}; saving a copy would take about {minutes} minutes.` with the buttons `[Back it up first]` and `[Replace without backup]`. Whenever an estimate exceeds 10 s it is shown. |
| BK-5 | Binary files are backed up like any other. Compare for a binary file (null byte in the first 8 KB) or one over 256 KB (board side: more than a minute at 4 KB/s) shows only sizes, times and a message; it never fetches the whole file silently. |
| BK-6 | Backups are never written into the project (OneDrive would sync them) and never to the board. |
| BK-7 | Backup paths are short and hashed (BK-1), so a deep OneDrive `rel` or Windows MAX_PATH (about 260 characters; the old path was about 140 characters before `rel`) cannot make a backup fail. The remaining failures are real I/O errors; OW-3 then aborts the transfer and says why. |

## 7. Board to laptop

| # | Flow | Behaviour (all downloads obey OW-1..OW-3; none runs without the student's click unless stated) |
|---|---|---|
| F1 | Files created or changed by the program (logging) | After a Run ends and the end-of-run read (RF-1b) finishes: **at most one non-modal toast per Run** (BF-4). New files (`only-on-board`): `Your program created data.csv on the board. Download it?` [Download] [Not now] [Don't ask about data.csv]. Several: `Your program created 3 new files on the board: data.csv, log.txt, run2.csv.` [Download all 3] [Choose…] [Not now]. Files whose board copy changed while the project copy equals S (`board-ahead`, L = S) join the same toast (`…and changed log.txt.`). Both-changed files are not in the toast; they show ↕. "Not now" hides the toast for this Run only; "Don't ask about {file}" is remembered per pair in the baseline file (`quiet`, at most 100 names). If more than one F1 toast would appear within 5 minutes, the later ones collapse into the status bar (row 10 of 3.6) and show no toast. Ignored names are not offered, but when the program wrote files that are on the ignore list the toast ends with `{k} more files on the board are on your ignore list. [Show]` (IG-3). |
| F1b | Per-folder action | Files view folder context menu and the folder tooltip: `Download new board files` downloads every `only-on-board` file under that folder (additive only; no existing file is replaced; protected cases are left out and listed). Also in Sync utilities as `Download New Board Files`. |
| F1c | Setting | `upyBridge.sync.newBoardFiles`: `ask` (default: the toasts above), `auto` (download without asking; only files absent from the project and without S; at most **128 KB per file and 512 KB per batch** (about 32 s and 2 min at 4 KB/s), larger ones are offered), `never` (no toasts). **Automatic download is OFF by default.** Automatic downloads are background transfers (AS-21). |
| F2 | Board with files, empty project folder | The first-sync review (5.2) replaces Step A by: `This board has {c} files and your project folder is empty.` Buttons `[Download these {c} files into my project]` `[Review the files…]`, Escape = Not now. Download uses the same path checks as D-20 (`BoardCopy`: scratch download, exclusive create, no symlinks, Windows name checks, `src/commands/boardCopy.ts`) and NC-1. **Empty** = the scan found no file that is neither ignored nor `not-for-board`, AND no `unreadable` file. If any file is `unreadable` (ST-10), F2 is not offered; the review runs as a normal Step A and says `{n} files in your folder could not be read yet; fix that first.` |
| F3 | Partner hand-over, non-empty different project folder | The review (5.2) with its defaults: nothing downloaded unless ticked; the only-on-board files are listed with `Download these {c} files` available in the list. Differing files show ≠ with Compare. |
| F4 | One file | `↓` or `↓+` tooltip link and context menu `Download (replaces my file)` / `Copy it to my project`. |
| F5 | Download All | Existing command (`syncFromBoard`); plan + preview + confirmation as today (`preview.ts`), now with the OW-1 classification, so files that differ with no baseline are listed under "different, tick to replace" (default unticked). `unreadable` and `name-clash` files are skipped with a message that names them (ST-10, NC-2); every path goes through NC-1. |

Rules BF-1 no flow overwrites a project file without OW-3; BF-2 the F1 toast appears only for a Run started by the extension (no polling); BF-3 `auto` never runs for a pair that is unreviewed; BF-4 at most one F1 toast per Run and at most one per 5 minutes (collapse into the status bar); BF-5 every download path runs NC-1 and skips `unreadable` / `name-clash` files with a message instead of failing the batch.

## 8. Timestamps

### 8.1 What the board stores and returns [S]

| Fact | Source |
|---|---|
| **The board does have file timestamps.** LittleFS v2 (the ESP32 port formats and mounts `VfsLfs2`, `lib/micropython/ports/esp32/modules/inisetup.py:41-42`) stores a modification time as a file attribute `LFS_ATTR_MTIME` (64-bit little-endian nanoseconds since 1970, `extmod/vfs_lfs.c:106`), enabled by default (`mtime=True`, `vfs_lfs.c:43`). | firmware tree `lib/micropython/extmod/` |
| The stamp is taken from `mp_hal_time_ns()` when a file is opened for writing and again at every write, i.e. it is the time of the LAST WRITE (`vfs_lfsx_file.c:105-110, 140-142`; `vfs_lfs.c:130-139`). | same |
| `os.stat()[8]` (st_mtime) returns it in the PORT's epoch, not Unix: 2000-01-01 by default (`py/mpconfig.h:1041-1043`), 1970 on the unix port (`ports/unix/mpconfigport.h:129`). A file without the attribute (LFS1, `mtime=False`, directories) returns 0 (`extmod/vfs_lfsx.c:387-411`). The bridge today passes the raw number through (`devfs.py:295`). | same |
| FAT (SD cards, some STM32/RP2 setups) stores date and time with 2-second resolution; the root folder reports 2000-01-01 (`extmod/vfs_fat.c:313, 329-335`). | same |
| MicroPython core has **no NTP**. The clock is whatever the RTC holds; `ntptime` is an optional library that needs Wi-Fi (`lib/micropython-lib/micropython/net/ntptime/ntptime.py`). On ESP32 the RTC is set through `settimeofday` with 2000-based seconds (`ports/esp32/machine_rtc.c:134-144`) and `mp_hal_time_ns` is the raw system time (`ports/esp32/mphalport.c:250-256`), so an unset clock reads 2000-01-01 plus uptime [I, matches the instructor's observation; verify on the real board, work item W4]. The ESP32 has no battery RTC, so the clock is lost on a power cycle [K]; whether it survives a soft reset is [U]. | |
| Our uploads: the bridge writes `remote.mpytmp` and renames (`docs/protocol.md:42`), so the board's mtime is the **upload time by the board clock** (not the time the student edited the file); whether `rename` keeps the attribute is [K/U] and is checked in W4. `mpremote cp` does not preserve times either (`bridge/vendor/mpremote/transport.py:207-241` has no utime). | |
| Our manifest does not ask for mtime (`devfs.py:260`, `types/protocol.ts:93`); only `fs.stat` does, uncorrected for epoch. So the instructor's objection is right: the data exists on the board; this extension simply never read it. | |

### 8.2 Normalisation (TS-1)

The bridge computes `epochOffset = 946684800 if time.gmtime(0)[0] == 2000 else 0` once per connection and returns every mtime as Unix seconds (`mtime = st[8] + epochOffset`), `0` meaning "no stamp". Test: fake board with epoch 2000 and one with 1970 give the same normalised mtime for the same instant.

### 8.3 Plausibility (TS-2)

```
clockPlausible(Tb, Th):          // Tb = board time normalised to Unix seconds, Th = host UTC seconds
   d = Tb - Th; o = round(d / 900) * 900          // nearest quarter hour = the board's time-zone offset
   ok = Tb >= 1735689600 (2025-01-01Z) && |o| <= 50400 && |d - o| <= 300
   return { ok, offset: o }
fileTimeOk(m, o, Th):  m >= 1735689600 + o && m - o <= Th + 300
```
Any consistent offset is accepted: a board set to local time and a board set to UTC both pass; a board that reads year 2000 fails; a board hand-set several hours wrong passes with that offset (which is correct for comparing board times with each other and, after subtracting the offset, with host times). A board whose clock drifted by a non-quarter-hour amount (more than 5 minutes off the grid) fails and gets no hints.

### 8.4 Hint uses (all are hints; none decides a transfer)

| ID | Use | Rule |
|---|---|---|
| H1 | **Change-detection shortcut** (skip on-board hashing in RF-3) | If `baseline.clockOk` and the board clock is plausible now and the file's `(size, mtime)` equal `(baseline.size, baseline.boardMtime)`, then B := S.sha256 without hashing, shown with the same state as if hashed. Anything else hashes. Residual risk: a same-size rewrite within the same second as our own upload; accepted because OW-1/OW-5 re-check the hash before any overwrite (RF-4). Test: shortcut off when `clockOk` is false, when the clock is implausible, when mtime differs by 1 s, when size differs. |
| H2 | **Dates for `differs-unknown`** (facts only, no direction) | If the board clock is plausible and `fileTimeOk` holds for each side's mtime (converted with the offset), `flags.dates` = `Board copy written {date}. Your file saved {date}. Dates can be wrong: copying and syncing change them.` Nothing says or implies which side is newer ("probably newer" is removed: the board's mtime is the UPLOAD time, always later than the partner's edit, so the old rule was true almost whenever the partner uploaded after the student's last edit). If a clock check fails: `The board's clock is not set, so its file dates are not shown.` |
| H3 | Display | Tooltips show `Board copy written {local date time} (board clock)` only when `fileTimeOk`. They never show 2000-01-01 as a date. |
| H4 | What an upload does | An upload sets the board mtime to the upload time (8.1). Hence no text derived from mtimes may say or imply which side is newer (TS-8), and H2 is shown only for `differs-unknown` (T07/T14/T15), never for pairs with a baseline entry (T02-T04 use hashes). |
| TS-6 | Rule | No code path chooses a direction, preselects a checkbox or skips a confirmation because of a hint. Test: flip all mtimes on a fixture; the set of selected items and the dialog contents (other than the hint sentence) do not change. |
| TS-8 | Rule | No user-visible text built from timestamps (the `dates` builder, H3 date display) contains a claim of direction: the words newer, older, probably, latest, earlier, later are forbidden in it. State titles such as "Newer on the board" come from hashes (T02/T03), not from times. Test: build the `dates` text from fixtures with flipped mtimes; no forbidden word, no change in selected items. |

### 8.5 Set the board clock (TS-7, decision D-22)

Command `Set the Board Clock from This Computer` in Board Actions and the Doctor, and an **automatic step after connect** (instructor decision D-22). It writes the RTC with `machine.RTC().datetime((year, month, day, weekday, hour, minute, second, 0))` from the computer's LOCAL time (what students expect `time.localtime()` to print) through the bridge op `time.set` (P5), reads the clock back and reports `Board clock set to {time}.` in a short info toast. Rules:
- **TS-7a (when):** only when the board is idle at a prompt (never while a program runs: wait for Stop or the next idle moment, once per connection), never a reset, skipped quietly when the port has no `machine.RTC`.
- **TS-7b (condition):** automatic only when the board clock is **implausible** (`clockPlausible` false: year before 2024). A plausible clock (NTP, or set by a program) is never overridden automatically; the command forces it.
- **TS-7c (setting):** `upy-bridge.board.setClockOnConnect`: `whenUnset` (default) / `off` / `on` (every idle connect, for classes that want it).
- **TS-7d (what it does not do):** files already on the board keep their old stamps; only later writes (program logs, uploads) get real times; the clock is lost at power-off on most boards [I], hence the check on every connect. Timestamps stay hints (H1-H4, TS-8).
- **TS-7e (test):** fake board with an RTC model (unset year 2000, set, no RTC, program running); read-back asserted; the op is not allowed in the hardware harness until a gated real-board step is approved (it writes volatile board state).

## 9. J5: Run uploads the imported local modules

| Rule | Text |
|---|---|
| J5-1 | Before Run starts the program, the extension computes the **import closure** of the file being run and makes sure every local module in it that is `local-ahead`, `new-local` or `board-deleted` is on the board. This happens whatever `autoSync` says (a Run must run the code on screen, D-07); setting `upyBridge.run.sendImports` (default true) can disable it. |
| J5-2 | Scan (TypeScript, no Python parser): logical lines, comments and string literals stripped, bracketed continuations joined. Recognised: `import a`, `import a.b`, `import a as x, b`, `from a import x`, `from a.b import (x, y)`, `from . import x`, `from .sub import y`, `from ..pkg import z`, imports inside `try/except`, `if`, functions (over-approximation is fine). Not recognised, and documented in the tooltip of the setting: `__import__("x")`, `importlib`, imports built from strings. |
| J5-3 | Resolution against the project (board `sys.path` is `['', '.frozen', '/lib']` plus entries in the identity probe, `importRootsFrom`, `paths.ts:188`): for module `a.b.c` try `a/b/c.py`, `a/b/c/__init__.py` (and `.mpy`) in the project root (the mapped board root) and under `lib/`; every package directory on the way also needs its `__init__.py` (included in the closure). Relative imports resolve from the importing file's package directory. The closure is transitive, depth at most 8, at most 50 files, each file read up to 256 KB. |
| J5-4 | Ignored: modules found nowhere in the project; built-in and frozen modules (from the cached `introspect.modules` inventory and `identity.profileHints.modules`, `protocol.md:38, 55`), unless the project has a file of that name, in which case the bridge's shadow guard refuses the upload (`E_SHADOWS_MODULE`) and the message says `{name}.py has the same name as a module that is built into the board, so the board would keep using the built-in one. Rename your file, for example my_{name}.py.`; files matching the ignore list. |
| J5-5 | What is uploaded: only closure members whose state is `local-ahead`, `new-local` or `board-deleted`. Their states come from one `fs.hash` of the closure paths (P2), a single round trip. The run target itself is not uploaded (it is raw-pasted, D-07). |
| J5-6 | If a closure member's board copy is NOT equal to S (`board-ahead`, `both-changed`, `differs-unknown`) the upload is protected: one modal `{name} on the board is different from your project's {name}. Which one should the program use?` buttons `[Use mine (replace the board's)]` `[Run with the board's version]` `[Compare…]` `[Cancel]`. "Use mine" does OW-3 (backup), "Run with the board's" skips that file, Cancel starts nothing. |
| J5-7 | Order with D-20: save all dirty editors; if a program is running the single "Stop it, send {n} files, and run" question (AS-12), then Stop, then upload the closure (and the auto-sync queue, deduplicated), then run. With auto-sync `on` and nothing pending, J5 costs one `fs.hash` call. |
| J5-8 | Failures: any failed upload means the program is NOT started: `{n} file(s) your program imports could not be sent to the board, so it was not started (it would use old code): {first message}. Fix the problem and press Run again.` [Show log]. A scan problem (unreadable file, depth cap) is a warning that does not block: `Could not read {name} to look for imports; running anyway.` |
| J5-9 | After a run that ends with `ImportError`/`ModuleNotFoundError: no module named 'x'` where `x` is in neither the closure nor the board listing, the terminal summary adds `There is no x.py in your project or on the board. Check the spelling, or create the file.` (best effort, text-matched on the traceback). |
| J5-10 | Run is single-flight (RUN-1). |
| IG-1 | At Run, a module in the import closure (J5-2, J5-3) that is on the ignore list or is `not-for-board` is not uploaded (J5-4) and the Run shows a non-blocking warning: `{name} is on your ignore list, so the board uses its own copy of it (or fails with ImportError if it has none).` [Show ignore list] |
| IG-2 | The Files view shows one line below the tree, `{n} files on the board are on your ignore list`, with a link that opens `.mpyignore`, when the board holds files whose project counterpart (same relative path) is ignored. Those files get no badge. |
| IG-3 | The F1 toast mentions ignored files the program wrote (`{k} more files on the board are on your ignore list`). |

## 10. J4: New File

| Rule | Text |
|---|---|
| NF-1 | `New File` in the Files view (title bar and folder menu) asks for a name (existing `validateNewName`, `boardFiles.ts:75`), maps the chosen board folder to a project folder with `PathMapper.deviceToRel`, creates the folder chain (`mkdir -p`) and the empty file with an exclusive create, then opens it in the editor. It does NOT create anything on the board by itself. |
| NF-2 | The empty file is `new-local`; with auto-sync `on`, a reviewed pair, an idle connected board, the create event uploads it (an explicit user action overrides AS-8's empty-file triviality). Otherwise: toast `Created {rel} in your project. It will be sent to the board {when you save it \| when the board is free \| when you press Upload now}.` |
| NF-3 | A name that already exists in the project opens that file and says so (`{rel} already exists in your project, so it was opened and not changed.`); a name that exists only on the board offers `[Copy it to my project]`. A name that collides with a folder or has a file where a folder should be gets the existing `blockedText` (`boardCopy.ts`). |
| NF-4 | `New Folder` creates the folder in the project; when the board is connected and idle it also runs `fs.mkdir` at once (cheap, explicit), else `mkdir` items are included in catch-up (5.6) and Upload All. |
| NF-5 | No project folder open: nothing is created anywhere. Message with a button: `Open your project folder first (File > Open Folder), so the new file has a place on your computer.` [Open Folder…] (`vscode.openFolder`). The Files view shows a `viewsWelcome` entry for `workbenchState == empty`: `Open your project folder to see your files here and keep them in sync with the board.` + `[Open Folder]` (the existing `NO_FOLDER_TEXT`, `boardCopy.ts:22`, is reworded to match). |
| NF-6 | A board folder outside `rootPath` (`deviceToRel` undefined) gets `{path} is outside {rootPath} on the board, the folder your project mirrors, so a file there has no place in your project.` and nothing is created. |
| NF-7 | The current "empty file on the board only" behaviour (`boardFiles.ts:155-170`) is removed, not kept as an alternative. |

## 11. Test plan

Test files live in `test/unit` (node:test, mocked `vscode`), `test/integration` (real bridge + fake board), `test/vscode/suites` (real VS Code, isolated profile, fake board only, per CLAUDE.md).

| Layer | What | Covers |
|---|---|---|
| U1 table test `sync-state.test.ts` | One case per row T01-T20 and per overlay O1-O5 (incl. O1b), written as data (`{input, expected}`) with an independent oracle (a second, naive implementation using the sentences of 2.3). **Core product, fully enumerated:** L ∈ {absent, unreadable, x, y, z} (5) × B ∈ {absent, x, y, z} (4) × S ∈ {absent, x, y, z} (4) = 80, × dirty (2) × program/connection ∈ {idle and connected, running and connected, disconnected} (3; running and disconnected cannot occur together) × ignored (2) × effective autoSync ∈ {on, off} (2; `ask` is reduced first, ST-9) × pairReviewed (2) × trusted (2) × boardHash (2) × boardIdDerived (2) = 80 × 384 = **30,720 inputs**. The remaining inputs (inFlight, boardClock, lastTransfer, stale, nameClash, tombstone, diskChanged, board `not-checked` and `unknown` hashes, the ignored reason) are covered by a **pairwise** generator (every pair of values of any two inputs occurs at least once) over the whole input record; the test is called "core product plus pairwise", not "exhaustive". Assert (a) equals the oracle, (b) state ∈ the 16 allowed, (c) ST-1..ST-10, (d) an `unreadable` local never yields a transfer-enabling state. | ST-* |
| U2 `sync-baseline.test.ts` | MG-1..MG-5 with real v1 fixtures (reviewed/unreviewed, derived key, malformed entries, version 3), idempotence, `.v1.bak`; BL-1 (no entry after failure/cancel/skip/decline), BL-4 (URI change -> unreviewed), BL-5. | MG, BL |
| U3 `sync-protect.test.ts` | `isProtected()` truth table (OW-1); OW-2 by construction (the guard token, not a grep); dialogs list only files that lose changes; Escape/Skip changes nothing (OW-6); backup failure aborts (OW-3); BK-4 paths (board > 256 KB, project > 20 MB); OW-5 (a)-(c): a file that appears between scan and download is not replaced (`E_LOCAL_EXISTS`), a file changed after the backup is not replaced (`E_LOCAL_CHANGED`); OW-7 (`hash: none`: same-size rewrite not overwritten, a Run invalidates the proof); KB-1; RN-1. **Property test** with a seeded random operation sequence (localEdit, boardEdit by program, autoSave, manualUpload, download, review choices, delete through the extension, rename, swapBoard, reload, disconnect, reconnect, partnerSwap, concurrent write between read and put, unreadableFile, fileAppearsLate, hashNoneBoard) against an in-memory fake board that implements `ifBoardSha` and a fake local file system: after every step, invariant I1 "no destination content is lost unless it was in S, equal to the source, or backed up AND confirmed, except inside the windows of OW-8 (the fakes do not model those windows)"; I2 "no file is deleted by sync"; I3 "auto-sync made no download". 2000 sequences of 40 steps, fixed seeds in the repo, a failing seed printed. | OW-*, AS-5 |
| U4 `sync-timestamps.test.ts` | `clockPlausible` / `fileTimeOk` table (year-2000 board, UTC board, local-time board, hand-set wrong, drift 4 min, drift 6 min, future file); epoch 2000 vs 1970 normalisation; H1 shortcut off in every listed case; TS-6 mtime-flip invariance; H2 text only when all conditions hold. | TS-* |
| U5 `sync-import-scan.test.ts` | every J5-2 syntax form incl. multi-line parentheses, relative imports, `try/except`, strings and comments that look like imports, a package without `__init__.py` on the board, built-in names, shadow names, depth/size caps, cyclic imports. | J5 |
| U6 views | `SYNC_STATES` single table: legend lists every state once; badge length ≤ 2; tooltips contain a meaning and an action sentence (UI-7); no forbidden words (UI-9); `description` word present; contextValue per state; folder rollup order (ST-7/8); virtual rows (UI-6). | UI-* |
| U7 status bar `sync-statusbar.test.ts` | `statusBarRow(counts, ctx)` is total and single-valued: for every vector of state counts ∈ {0,1} over the 15 non-ignored states × autoSync × unreviewed × trusted × programRunning × boardHash, exactly one of rows 1-14 of 3.6 applies; `Board in sync` appears only when every non-ignored file is `synced` (SB-1). | SB-1 |
| I1 fake-board scenarios (integration; `tools/fakeboard.py` + scripted programs) | (a) **lab-partner swap**: board A with partner files, new project folder (empty, then non-empty): F2/F3, nothing overwritten, review defaults as in 5.2; (b) **program-created files** after Run: F1 toast text, `Download all 3`, `newBoardFiles=auto` limits; (c) **clock unset (2000) vs set**: no hints, H1 off, then `time.set`; (d) **OneDrive placeholder**: a local file that hangs on read -> skipped with the existing message, state `failed`, no hang; (e) **rename/delete locally**: AS-18; (f) **big file** (> `autoMaxFileKB`) stays ↑ with the estimate; (g) **link drop mid-transfer**: no `.mpytmp` residue visible, file stays ↑, no `failed`; (h) **two PCs**: second storage dir -> unreviewed pair, review shows identical + one differing; (i) **editor dirty during upload**: saved content sent, dirty flag handled (AS-17); (j) program running: waiting, flush at idle, AS-12 single question; (k) **concurrent board edit** between read and write: `E_DEST_CHANGED` -> state + toast, nothing overwritten; (l) catch-up (5.6) after reload; (m) cleared board does not refill (`board-deleted`); (n) derived-key board (BL-5). | AS, FS, BF, OW |
| I2 fake-board scenarios added by the review | (o) hanging-file fixture: Download All skips it with a message, F2 not offered, baseline entry kept (ST-10, LS-5); (p) a destination file appears between scan and download (OW-5); (q) `hash: none` board and a same-size rewrite (OW-7); (r) first-sync review: board name and id end shown, `Sync as suggested` hidden when `d > 0`, "Not now" then a save shows the one-time toast (FS-7), auto-record when nothing would change (FS-6); (s) Keep both (KB-1) and Treat as the same (RN-1); (t) rename `main.py` to `robot.py` and safe-save delete-then-create (AS-18); (u) delete `main.py` on the board through the extension, then save: not re-sent; Clear Device Files then reconnect: nothing sent (BD-1, AS-20); (v) Run pressed twice (RUN-1); (w) program running at connect gives reason `program-running`, Restricted Mode gives `restricted-mode`, `ask` mode shows `waiting` until the review is answered (ST-9); (x) a OneDrive conflicted copy and a PDF are not auto-sent (AS-19); (y) autosave at 4 KB/s: a Run starts within one chunk (AS-21), `fs.hash` of 300 files runs in chunks (RF-3); (z) a log rewritten on every Run gives one toast per Run, "Don't ask about" works (BF-4); (aa) a very long Windows path: the backup still works (BK-7), a case clash gives `name-clash` and no transfer (NC-2); (ab) a Run whose import is on the ignore list shows the IG-1 warning; (ac) a dirty buffer plus an external save shows O1b; (ad) a thousand-file OneDrive-like folder: the second scan hashes nothing (LS-1), `.pdf` files are not opened (LS-2). | AS, FS, BF, OW, SB, IG, LS |
| V1 real-VS-Code journeys (`test/vscode/suites/sync-*.ts`, fake board) | Hover tooltip text and command links render and run (`Upload now`, `Compare with the board`); badges and description words in the Files view; legend opens; first connect shows the review dialog; default-on migration (AS-3) with a seeded `workspaceState`; New File in an empty window shows the welcome text; Run uploads an imported module and the question flow of AS-12/J5-7. | UI, J5, NF |
| H1 hostile | board names with `..`, `\`, drive letters, trailing dots/spaces, case collisions on a case-insensitive host (existing `PathMapper` guards); manifest with 10 000 entries (`truncated`); garbage hash text; mtime negative/huge/NaN; clock jumps backwards between reads; baseline file with 100 000 entries / duplicate keys differing in case; event storm of 1000 saves; read-only local file; Windows `EBUSY` retry (`atomic.ts`); symlink inside the project (`linkInProject`); `E_DEST_CHANGED` for a file that is now equal. | robustness |
| Hand only (real board, orchestrator, scratch folder only, `tools/hwtest` phase) | on-board hashing time per KB (RF-3 budget); `mtime` really present on the class board and its value after an upload (rename keeps the attribute?); epoch offset; clock after a soft reset; `RTC().datetime` order on the class firmware; real tooltip hover with link click on macOS and Windows (instructor); a real partner hand-over with two boards. No test writes outside `/_mpybench_test/` (CLAUDE.md standing authorization). | W4, O-* |

ID lint: a test reads this file and checks that every rule ID matching `\b(ST|BL|MG|UI|RF|LS|AS|FS|OW|BK|BD|SB|IG|TS|BF|J5|NF|RUN|NC|KB|RN)-[0-9]+[a-z]?\b` appears in at least one test name or `// covers:` comment. IDs are never reused; gaps (TS-3 to TS-5) are intentional and are not required. Labels that are not rule IDs (overlays O1-O5, table rows T01-T20, work items W1-W14, open decisions O-1 and up, flows F1-F5, hints H1-H4) are covered by the table tests (U1) and the I-scenarios, not by this lint.

## 12. Work breakdown (ordered; each step ends green with `npm run verify`)

| # | Step | Size | Exit criterion |
|---|---|---|---|
| W1 | **Pure state model** `src/sync/fileState.ts` (+ `SYNC_STATES`, 16 states), `isProtected()`, `clockPlausible()`, `statusBarRow()`; U1, U4, U7 tests; replace `SyncBadge` by the new state names in `types/sync.ts`. | M | U1 core product plus pairwise passes against the oracle; no behaviour change in the UI yet. |
| W2 | **Baseline v2 + migration** (MG-*, BL-*): `tombstones` (BD-*), `quiet`, `equiv`, snapshot files, `reviewedAt`, retention (BL-7). | M | U2 passes with real v1 fixtures; old data loads; `.v1.bak` written. |
| W3 | **Protocol P1-P7** in `bridge/devfs.py`, `docs/protocol.md`, fake board (including a `hash: none` mode and a slow-link mode), TS types; epoch normalisation; cancel for `fs.get`/`fs.hash`; chunked `fs.hash`; `fs.get` modes. | L | bridge tests (`tests.test_devfs`, `tests.test_fakeboard`) for mtime/epoch/CAS/hash-many/exclusive-get/cancel; the hardware phase W4 is listed and NOT run by agents. |
| W4 | **Hardware facts** (hand): hash speed, mtime presence, rename keeps mtime, epoch, clock after soft reset, cancel latency per chunk. | S | numbers recorded in `docs/spikes-and-questions.md` [E]; thresholds in 4/8 confirmed or changed. |
| W4b | **Offline-file spike** (hand, needs a OneDrive folder on macOS and on Windows): can Node read the dataless / `RECALL_ON_DATA_ACCESS` attribute without native modules (LS-3)? What does opening an online-only file do? | S | decision recorded: LS-3 on, or LS-5 timeout only plus the tooltip advice. |
| W5 | **Refresh policy and local scan** (RF-1..10, LS-1..5): hash cache, allowlist, `unreadable[]`, chunked hashing, state store feeding `state()` for every file, stale handling, snapshot display. | L | I1 (c), (h), (j) and I2 (o), (ad) pass; Files view shows `?` then final states; no read while a program runs. |
| W6 | **Decorations, tooltips, description words, virtual rows, rollup, legend, status bar (3.6 rows 1-14), accessibility** (section 3, TS-8). | L | U6 and U7 pass; V1 hover/legend journeys pass in real VS Code. |
| W7 | **Overwrite protection**: `transfer()` as the one guard, CAS uploads, exclusive / re-hash downloads (OW-5), `hash: none` rules (OW-7), dialogs, Keep both, Treat as the same, backups (BK-1/4/7, Restore), Compare, `uploadFile` and auto-sync routed through it. | L | U3 including the property test passes; I1 (k) and I2 (p), (q), (s), (aa) pass; old-defects rows 03.4, 04.9, 06.10 get `Pinned by`. |
| W8 | **Auto-sync default on + first-sync review + catch-up + queue rules** (section 5): FS-1..8, AS-6..AS-9, AS-18..AS-21, tombstone writing, rename and delete handling, background cancel, debounce 1.5 s; the old `askFirstConnect` removed. | L | I1 (a), (h), (l), (m), (n), I2 (r), (t), (u), (w), (x), (y), (ac) and the V1 default-on migration pass; settings table and `contributes` updated. |
| W9 | **Board-to-laptop flows** (section 7, BF-1..5, quiet list). | M | I1 (a), (b), I2 (z) pass; setting `newBoardFiles`. |
| W10 | **Run imports** (section 9, J5-*, RUN-1, IG-1..3). | M | U5 passes; I1 (j); I2 (v), (ab); V1 Run journey; `run.ts` gate rewritten. |
| W11 | **New File / New Folder / welcome** (section 10). | S | V1 New File journeys; `boardFiles.ts` empty-board-file path removed. |
| W12 | **Clock command + automatic set when unset on connect (D-22)** (8.5, TS-7a..e). | S | unit + fake board; hardware use only with the instructor. |
| W13 | **Docs and journey sweep**: README/help text, `docs/old-defects.md` rows, `plan.md`, D-21 status, `DEVELOPING.md`; full `npm run verify` and `npm run test:vscode`. | S | everything green; plan ticked. |

## 13. Resolved review findings

Source: `docs/sync-states-review.md` (R-xx = hole, C-xx = table/consistency finding). "Resolved" = a testable rule is in this file; "Accepted" = the risk stays and is stated.

| # | Review id | Severity | Finding | Where handled | Status |
|---|---|---|---|---|---|
| 1 | R-01, R-11 | data-loss | Unreadable local file (OneDrive placeholder, lock) looks absent; download overwrites it, F2 sees an empty folder | `local: unreadable`, state `unreadable` (E2a, T16), ST-10, LS-3, LS-5, OW-1, F2, F5, tooltip 3.2, U1 (d), I2 (o) | Resolved (LS-3 detection depends on spike W4b; LS-5 works without it) |
| 2 | R-02 | data-loss | Download to an "absent" destination is not exclusive; a late file is replaced without backup | OW-5 (a)-(c), P7, U3, I2 (p) | Resolved except the window of row 24 |
| 3 | R-03 | wrong-overwrite | `hash: none` board: no compare-and-swap, same-size rewrite invisible | OW-7, ST-2, T14/T15, RF-10, AS-20/5.6, footers in 3.2/3.6, I2 (q) | Resolved (stricter: auto-sync only adds on such boards; O-18) |
| 4 | R-04 | misleading-status | "Not now" lasts a session; dialog hides which board | 5.2 Step A (board name, port, id end), default button, `Sync as suggested` only when `d == 0`, FS-7, FS-8, 3.6 row 3, I2 (r) | Resolved |
| 5 | R-05 | data-loss | A partner's only copy survives only as a backup on this PC | KB-1 (Keep both, first button when no S), 5.2 table, 6.2 dialog, backup text "on this computer only" (OW-3), `*.board.*` ignore | Resolved (O-15) |
| 6 | R-06 | annoying | Full re-hash of OneDrive folder, hydration, watcher hashing | LS-1..LS-4, F2 emptiness, W4b | Resolved; offline attribute detection [U] |
| 7 | R-07 | annoying | 4 KB/s link blocks Run; huge caps | AS-6 (1.5 s), AS-8 (64 KB), AS-21, P6, RF-3 (chunks), BK-4 (256 KB), F1c (128/512 KB), 10 s estimates | Resolved (cancel latency [U], W4; O-6) |
| 8 | R-08 | misleading-status | Rename uploads the new name before the offer; old `main.py` keeps running | AS-18 (b), (c), I2 (t) | Resolved |
| 9 | R-08 | annoying | Run pressed twice | RUN-1, J5-10, I2 (v) | Resolved |
| 10 | R-09 | wrong-overwrite | Deleted `main.py` is re-sent by the next save | BD-1..3, AS-9, AS-20, T08/T09, I2 (u) | Resolved (deviation: toast, not modal, O-13) |
| 11 | R-10 | misleading-status | Missing inputs: trusted, program at connect, hash capability, `ask` | 2.1 inputs, E3 reasons, ST-9, O3/O5, RF-9, AS-1, AS-4, tooltips, I2 (w) | Resolved |
| 12 | R-12 | misleading-status | `board-deleted` promised but not sent; Clear Device Files refills; FAT drop | O3 (no board-deleted), AS-20, BD-1, BL-6, AS-13 (FAT case), 5.6 | Resolved; FAT drop accepted (O-17) |
| 13 | R-13 | misleading-status | Status-bar table falls through to "in sync" | 3.6 rows 1-14, SB-1, U7 | Resolved |
| 14 | R-14 | misleading-status | H2 direction hint is biased; dead `{hint}`; wrong section reference | H2 (facts only), H4, TS-8, board-ahead row without `{hint}`, section reference fixed to 8.4 | Resolved |
| 15 | R-15 | annoying | Windows path length, case clashes, reserved names | BK-1, BK-7, `name-clash` (T17), NC-1, NC-2, I2 (aa) | Resolved (no Windows run yet [U]) |
| 16 | R-16 | annoying | Conflicted copies, PDFs auto-sent | AS-19, LS-2, tooltip new-local, I2 (x) | Resolved (O-14) |
| 17 | R-17 | annoying | Wiped profile means a modal review every session | FS-6, O-11 | Resolved; the lab-PC profile policy is O-11 |
| 18 | R-18 | misleading-status | Dirty buffer plus external save | O1 / O1b, `diskChanged` input, tooltip footer, I2 (ac) | Resolved (rule reworded so it fires for `local-ahead`; reason in O1b) |
| 19 | R-19 | annoying | F1 toast repeats for logs | F1, BF-4, `quiet` in baseline v2, I2 (z) | Resolved |
| 20 | R-20 | annoying | Safe-save editors report "only on the board" | AS-18 (a) | Resolved |
| 21 | R-21 | misleading-status | Ignored modules and logs invisible | IG-1..IG-3, F1 | Resolved |
| 22 | R-22 | misleading-status | CRLF / BOM differences | RN-1, `equiv` (2.6), ST-3 | Resolved (O-16) |
| 23 | C-01..C-10 | annoying | Table completeness and testability | C-01: T16-T20, `unknown not-supported`; C-02: O3 and 5.6; C-03: ST-9; C-04, C-09: new inputs (2.1); C-05: NC-2; C-06: `localEdited` removed from T08; C-07: section reference and `{hint}` fixed; C-08: U1 recount (80 × 384 = 30,720 core plus pairwise; the old "128 combinations, 8192" was wrong: 64 × 64 = 4096) and renamed; C-10: UI-8 note; OW-2 as a guard-token test; ID lint scoped (11) | Resolved |
| 24 | R-02 (residual) | infeasible | No local compare-and-swap on Windows | OW-8, invariant I1 reworded, O-19 | Accepted risk |

## 14. Decisions only the instructor can make (the one open list)

Rows O-1 to O-10 are from rev 1 (changed rows say so); O-11 to O-20 come from the review.

| # | Question | My recommendation |
|---|---|---|
| O-1 | Approve the first-sync review as a hard gate for every new (folder, board, PC) triple, including the cost of one review per PC for OneDrive-synced folders? (FS-6 removes the dialog when nothing would be sent, replaced or downloaded.) | Yes. |
| O-2 | Default for "only on the board" files in a NON-empty project folder at the review: unticked (my default) or ticked? | Unticked; the empty-folder case is ticked. |
| O-3 | Also decorate the project files in the VS Code Explorer (local tree) with the same badges? It would clash visually with git badges. | Not in the first release; Files view with virtual rows only. |
| O-4 | `Run` uploads imported modules even when auto-sync is OFF (my default `run.sendImports=true`)? | Yes, otherwise Run can run stale libraries. |
| O-5 | RESOLVED by the instructor (D-22): set the board clock automatically when it is unset, on connect, when idle. | Done: see 8.5. |
| O-6 (changed) | Limits: automatic upload 64 KB (was 512), automatic board download 128 KB per file and 512 KB per batch (was 1 MiB / 5 MiB), board backup before replace 256 KB (was 2 MB), debounce 1.5 s (was 0.4 s). Is a 64 KB cap too low for any class file? | Keep; raise only with the measured link speed from W4. |
| O-7 | Rename on the board when a file is renamed locally: offer (my default) or do nothing? | Offer. |
| O-8 (changed) | `ask` is kept only as a legacy value meaning "off until the first review is answered" (ST-9) and hidden from the toggle. Remove it entirely? | Keep for existing users. |
| O-9 | Boards without `unique_id` (BL-5): accept a review at every connect? | Yes, safest; course boards have ids. |
| O-10 | Retention: 20 backup folders and 200 MB, 24-hour floor. | Keep. |
| O-11 | Do the lab PCs wipe or roam the VS Code profile at logout? (If yes, every session starts unreviewed; FS-6 only helps when nothing would be sent. A shared per-course profile policy might be worth requesting.) | Ask the lab administrators before W8. |
| O-12 | `board-deleted` files are never sent automatically (AS-20), also after a board was re-flashed or cleared: the student presses Upload now once. Accept? | Yes. |
| O-13 | `main.py` / `boot.py`: when the board copy is absent, a toast offers the upload (no automatic send); when it exists and equals S, the one-time disclosure then automatic sends (AS-9). The review wanted a modal every time. Accept the toast? | Accept; a modal per save of the most-edited file would be click-through noise. |
| O-14 | Auto-send allowlist and name rule for new files (AS-19, LS-2): `.py .mpy .json .txt .csv .cfg .ini .bin .dat`, names with letters, digits, `_ - . /` only. Anything to add or relax (for example `.log`, non-ASCII names)? | Keep; add extensions on request. |
| O-15 | Keep both (KB-1): board copy saved as `name.board.ext`, first button when no baseline entry, ignored by sync. Accept the naming and the default? | Accept. |
| O-16 | Treat as the same (RN-1) records an "equivalent" hash in the baseline. Accept the extra mechanism, or just tell the student that only line endings differ? | Accept; cheap and testable. |
| O-17 | FAT boards: a dropped upload can leave the destination absent (AS-13). Accept (student presses Upload now), or ask for a bridge change to replace in place where the port allows it? | Accept for the first release. |
| O-18 | Boards that cannot hash: auto-sync only adds new files and never replaces an existing one (OW-7). Stricter than the class board needs; accept? | Accept. |
| O-19 | Accept the two residual windows of OW-8 (no compare-and-swap on a hash-less board; milliseconds between final re-hash and rename of a project file) and the invariant wording "no loss except inside these windows"? | Accept; the unconditional backup bounds the damage. |
| O-20 | The OneDrive offline-file spike (W4b) needs a OneDrive folder on a Mac and on a Windows PC. Who runs it, or is the tooltip advice "Always keep on this device" enough? | Run the spike on the instructor's Mac now and on a lab PC later. |
