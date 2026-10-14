# Adversarial review of `docs/sync-states.md` (D-21 sync spec)

Reviewer: agent sync-spec-critic, 2026-10-13. Read-only review: nothing was run, no serial port or board touched, no GUI launched. Evidence tags as in CLAUDE.md: [S] read from source (file:line), [D] documented, [I] inferred, [U] unverified. Section numbers refer to `docs/sync-states.md`.

## 0. Verdict

The core of the design is sound and I could not break it with the 15 requested scenarios when the compare-and-swap upload (P4 `ifBoardSha`) is in place: a board file that differs from the baseline is never overwritten by an upload without a dialog (scenarios 1, 3, 4 pass). The first-sync review (FSR) also keeps its promise for scenario 2 (nothing replaced without a tick).

The remaining danger is concentrated in five places:

1. **The local side is trusted more than it deserves.** Today an unreadable local file (online-only OneDrive placeholder, locked file) is simply missing from the scan, so it looks like "absent". Absent destinations are overwritten without backup. The spec never closes this and builds the F2 "empty folder" case on the same blind assumption (R-01, R-02).
2. **Boards that cannot hash** silently lose all protection (R-03).
3. **State machine inputs are incomplete**, so several states shown to the student are false: untrusted workspace, program running at connect (the course's own `main.py` case), legacy `ask`, unreadable file, `board-deleted` that is promised to be sent but never is (R-10 to R-14).
4. **The 4 KB/s link is treated as a background detail.** Autosave plus a long in-flight upload blocks Run for minutes; backup/compare caps are minutes long (R-07).
5. **Deletes and renames** race with the create-driven upload and can resurrect a deliberately deleted `main.py` (R-08, R-09).

Section 4 of this file lists the table/consistency findings and testability gaps (C-01 to C-10).

## 1. Scenario walk-through

| # | Scenario | Result against the written rules | Hole IDs |
|---|---|---|---|
| 1 | PC A uploads; PC B (older copy, no baseline for this board) saves, auto-sync ON | Pair unreviewed -> BL-4 -> `waiting`, FSR at connect. If PC B has an OLD baseline (shared lab PC, last week's S) the upload goes out with `ifBoardSha = S`, board has PC A's version, so `E_DEST_CHANGED` (AS-15), nothing lost. PASS in both cases. Weak spots: the H2 hint can mislead the choice (R-14); the one backup of PC A's board copy lives on PC B only (R-05). | R-05, R-14 |
| 2 | Board handed to a partner; first connect to a folder with same-named different files | FSR: differing files left alone, project-only files uploaded, only-on-board not downloaded (non-empty folder). Nothing replaced without a tick. Weak spots: dialog does not say WHICH board (lab with several benches), "Sync as suggested" uploads to it; "Keep mine" destroys the only copy of the partner's file with a backup on this PC only; no "keep both". | R-04, R-05 |
| 3 | Program rewrites `data.csv`, student edits local `data.csv` | `L != S`, board `!= S`, CAS refuses, `both-changed`. PASS. Weak spot: the F1 toast repeats on every Run because the suppression key is (path, board sha) and a log has a new sha each run (R-19). On a board that cannot hash this fails (R-03). | R-03, R-19 |
| 4 | Local edit, board copy edited by a program, both then save | Same as 3: `E_DEST_CHANGED` once per file per session, then silent; status stays `both-changed`. PASS. | |
| 5 | Rename / delete on one side | Local rename = `local-deleted` + `new-local` (ST-6). The create event uploads the new name after 400 ms, before the student can answer the rename offer, so the later `fs.mv` meets an existing destination. A board-side delete of `main.py` followed by a save re-uploads it. Safe-save editors (delete + create) fire the "only exists on the board" toast on every save. | R-08, R-09, R-20 |
| 6 | OneDrive placeholders, churn, conflicted copies | Scan hashes every file with no cache; reading hydrates placeholders; unreadable files become "absent". Watcher events from OneDrive cause hashing of files (re-hydrate loop [U]). Conflicted copies `main-PC (1).py` are `new-local` and auto-uploaded. | R-01, R-06, R-16 |
| 7 | Windows case-insensitivity, path length | Spec mentions case only in the hostile tests. State key and tie of L to B on a case-insensitive host is undefined. Backups under `workspaceStorage\<hash>\...\backups\<ts>\board\<rel>` can exceed MAX_PATH; backup failure aborts the transfer (OW-3), so the student can never replace that file. | R-15 |
| 8 | Clock skew, unset board clock | H1/H2/TS-6 are mostly sound: no decision uses time; H1 is guarded by `clockOk` at both ends and re-checked by CAS. Weak spot: the H2 direction hint is biased (board mtime = upload time, always later than the partner's edit time). | R-14 |
| 9 | Board drops mid-upload | LittleFS: temp then rename, no half file; `.mpytmp` residue is ignored (`src/sync/ignore.ts:29`) and cleaned by the bridge (`bridge/server.py:1160`). FAT (SD/pyboard): remove-then-rename; a drop leaves the destination ABSENT and the temp holding the only copy (`docs/protocol.md:146`). The file then becomes `board-deleted`, which catch-up does not re-send (5.6), contradicting AS-13 "file stays local-ahead". | R-12 |
| 10 | Program running, Run pressed twice | `src/commands/run.ts` has no single-flight guard [S: no flag in the file; lines 40-133]. Two presses during `bringLibrariesUpToDate` (long on a slow upload) run two flush chains and two `run` calls; the second gets `E_PROGRAM_RUNNING` and a Stop dialog for a program the student just started. Spec 9 (J5-7) and AS-12 specify the happy path only. | R-08 |
| 11 | FSR answered Cancel or ignored | Auto-sync stays off for this pair until the student acts; "asks again at the next connect". A lab session is one connect, so in practice off for the whole session, with only a status-bar item and a tooltip. | R-04 |
| 12 | Baseline lost / copied / migrated | Loss -> unreviewed -> FSR (safe, noisy). Wiped or roaming profile on a lab PC -> FSR every session -> click-through habit. A copied baseline cannot happen through OneDrive (it lives in `storageUri`). Migration MG-1..5 sound; v1 -> "reviewed" with a months-old S is covered by CAS. | R-17 |
| 13 | Hundreds of files, 4 KB/s | RF-3 does one on-board hash pass for all unknown files: single uninterruptible op, time [U]. Local side re-hashes every file on every scan. States are `?` until both finish. A Run issued meanwhile waits. | R-06, R-07 |
| 14 | File edited in Thonny / Notepad | Watcher change -> hash -> upload (fine). Dirty VS Code buffer + external save: O1 shows `unsaved` and hides that the disk version differs from the board; AS-17 skips the upload, so the board keeps the old version while the status says "Save and it is sent". Acceptable but the tooltip should mention the file changed on disk. | R-18 |
| 15 | Ignored files and files on the board but ignored locally | E1 returns `ignored` before anything else. The board copy is invisible (no badge), J5 never uploads an ignored module (J5-4) and says nothing, `*.tmp`, `*~`, `*.part` logs are silently never offered. | R-21 |

## 2. Holes (ranked)

### R-01 Unreadable local file counts as "absent", so a download overwrites it (data-loss)
Spec: 2.2 E4 / input `local: absent | {...}` ("unreadable file -> caller passes lastTransfer.failed"), 7 F2/F5, 11 I1(d).
Code [S]: `scanLocal` omits a file that times out or is locked and only adds a warning (`src/sync/localScan.ts:157-159`). The planner then sees `!L && B` and emits `download` (`src/sync/plan.ts:193-199`). The engine backs up the local file only when `item.localSha256 !== undefined` (`src/sync/engine.ts:267-275`), which is false for the "absent" file, then `fs.get` replaces it. An online-only OneDrive placeholder may hold a NEWER version from another PC that was never hydrated.
Spec gap: the "failed" mechanism cannot work here: E4 requires `lastTransfer.localSha` to equal the current L, and an unreadable file has no hash. No state exists for "cannot read my own file".
Rule: add `local: 'unreadable'` as a third value (with reason: timeout, locked, permission). State `unreadable` (badge `!`, "Could not read your file; not copied; mark it Always keep on this device"). An unreadable file is never an upload source and never a download destination; it is not "absent" for T10-T13, for F2 "empty folder", or for T12 baseline forgetting. Test: scan fixture with a hanging file; `Download All` skips it with a message.

### R-02 Download to an "absent" destination is not exclusive (data-loss)
Spec: OW-1 (absent destination needs no confirmation), OW-5 ("checks the local hash and isDirty immediately before replacing").
Code [S]: `engine.ts:271-275` uses `fs.get`, which writes `local.mpytmp` then renames over the destination. Only the D-20 copy path uses an exclusive create (`src/commands/boardCopy.ts:10, 124`). A file that appears between the scan and the rename (OneDrive delivering the other PC's version, Thonny saving, a safe-save editor) is replaced with no backup. `isDirty` sees only VS Code buffers.
Rule: for every download, (a) if the planner said "absent", the final step must fail when the destination exists (hard link / `COPYFILE_EXCL` / rename-no-replace; on Windows `MoveFileEx` without REPLACE_EXISTING), (b) if the planner said "exists", re-hash it after the temp download and before the rename; if it differs from the scanned hash, back it up and say so. There is no atomic compare-and-swap for local files on Windows; state that residual window in the spec (infeasible to close fully) and make the backup unconditional for existing files (already OW-3).

### R-03 Boards that cannot hash lose all protection (wrong-overwrite)
Spec: P4/OW-5, T14/T15, ST-2, 4.
Gap: P4 is defined as "the board hashes the existing destination before writing". `hash:"none"` boards exist by design (`docs/protocol.md:40`, D-15 firmware-agnostic). The baseline then holds a local hash after an upload "verified" by size only (`protocol.md:146`). Board vs S can only be decided by size (T14), so a program that rewrites a fixed-width log with the same size (common: `data.csv` of fixed record count) is invisible, and auto-sync will overwrite it with no CAS.
Rule: BL-7a/OW-7: on a `hash:"none"` board, auto-sync and catch-up upload only when the board file is absent or when size differs from S.size AND a download-compare has shown the board equals S's recorded content (otherwise the file becomes `differs-unknown`). Equivalent simpler rule: on such boards auto-sync overwrites nothing that exists; the student uses Upload with the OW dialog. Say so in the status-bar tooltip ("this board cannot check file contents"). Test: fake board with `hash:none`, same-size rewrite, auto-sync does not overwrite.

### R-04 FSR "Not now" lasts a whole lab session and the dialog hides the board identity (misleading-status / wrong-board)
Spec: 5.2, 3.2 `waiting`, 3.6.
(a) "Not now" leaves auto-sync paused "until the next connect". A student connects once per session, so auto-sync is effectively off for the whole session. The only signals are a status-bar clock and a hover. A student who saves and powers the board expects the new code on it (Run is safe because it pastes the buffer, but `main.py` at power-up is not).
(b) Step A names the project ("Lab 1") but not the board (port, id suffix, board name). In a lab with a bench of identical boards, "Sync as suggested" uploads the project-only files to whichever board is plugged in, possibly the neighbour's.
Rule: FSR-1 the dialog shows the board name/port and the last 4 characters of its id; FSR-2 "Not now" is remembered per connect, and the first time a save happens while the pair is unreviewed (auto-sync on) a one-time non-modal toast `Your file was saved but not sent: the board has not been checked yet. [Review now]`; FSR-3 the safe default button is "Review the files...", not "Sync as suggested"; "Sync as suggested" is offered only when `b` (project-only) plus `c` (board-only download) is non-zero and `d` (different) is zero.

### R-05 Replacing a partner's file leaves the only copy as a backup on this PC (data-loss risk)
Spec: 5.2 default table, 6.2, 6.3 (BK-1, BK-6), 7 F3.
When two students share a board and the board holds a file that exists nowhere else (never synced, written by a program, or auto-sync was off), "Keep mine" replaces it; the board's version is saved only in this PC's `storageUri/backups`. The partner is never told. BK-6 forbids backups in the project, so even a OneDrive user cannot recover it from another machine.
Rule: add a third option on every `differs-unknown` and `both-changed` row and dialog: `Keep both` = download the board copy next to the project file as `name.board.ext` (git-style, added to a built-in ignore pattern `*.board.*` so it is never auto-synced), then upload nothing. Make it the first button when the board file has no baseline entry (it is the unknown-provenance case). Mention in the replace dialog that backups are kept on this computer only.

### R-06 Local scan cost and OneDrive hydration (annoying, can look like a hang)
Spec: 2.1 (L is a hash of every non-ignored file), 4 RF-1/RF-3, 11 I1(d), 13 (scenario).
Code [S]: `scanLocal` hashes every non-ignored file in full on each scan, concurrency 4, 15 s read timeout (`localScan.ts:14-20, 104-128`), cap 5000 files. A OneDrive course folder holds handouts, PDFs, `.docx`, data. The state model includes all of them (virtual rows, T09), so every refresh reads (hydrates, downloads) every file in the folder. Watcher `onDidChange` also hashes any file OneDrive touches (`autosync.ts:136, 187-198, 242`); dehydration/rehydration cycles can re-trigger it [U].
Rules: (a) a (size, mtimeMs, ino) cache for L; re-hash only when it changed; (b) files with a non-board extension or larger than `autoMaxFileKB` are listed `not-for-board` without reading them (allowlist `.py .mpy .json .txt .csv .cfg .ini .bin .dat`, configurable) and are NOT in the F2 emptiness test; (c) skip files with the platform's offline attribute (macOS dataless flag, Windows RECALL_ON_DATA_ACCESS) without opening them [U: needs a spike to read these attributes from Node without native modules]; (d) hash only on the 400 ms debounce, never inline in the watcher callback.

### R-07 The slow link blocks Run, Stop-less ops and compares (annoying, infeasible as written)
Spec: 5.3 AS-8 (512 KB auto limit), 4 RF-3 (one `fs.hash` for all), 6.3 BK-4 (2 MB board backup), 7 F1c (1 MiB/file, 5 MiB/batch), 5.3 AS-6 (400 ms debounce).
At 4 KB/s: 512 KB = 128 s; the 2 MB backup cap = 8.5 min inside a modal flow; 5 MiB batch = 21 min. The bridge never aborts a running op except `stop`/`cancel` (`docs/protocol.md:96`), so a student who has autosave on (VS Code `files.autoSave: afterDelay`) triggers an upload every second or two and a Run waits behind the in-flight `fs.put`. One `fs.hash` over hundreds of files is likewise uninterruptible and RF-6's "k of n" progress needs chunking that is not specified.
Rules: (a) background puts are cancellable and a Run/Stop/explicit op cancels the in-flight background put (re-queued, temp removed); (b) trailing debounce for sending is 1.5 s of quiet, not 400 ms; (c) `fs.hash` in chunks of at most 20 files or 64 KB of hashed data; (d) auto limits: upload 64 KB, automatic board->laptop download 128 KB per file and 512 KB per batch, backup-before-replace 256 KB with an estimate `about N minutes` and an explicit "replace without backup" button above that (the current 2 MB figure is 8.5 min); (e) the dialog and tooltip always show the time estimate when it exceeds 10 s.

### R-08 Rename races the create-driven upload; Run has no single-flight guard (annoying / wrong-overwrite)
Spec: 5.8 AS-18, 9 J5-7, 5.4 AS-12.
Code [S]: `onRenamed` calls `onGone(old)` then `noteChange(new)` (`autosync.ts:384-387`); `noteChange` schedules an upload after the debounce. The offer "Rename it on the board too?" is shown after `reportGone` has loaded the baseline, so the student answers (seconds) after the upload of the new name (0.4 s + transfer). `fs.mv` then fails or, if it wins, the file exists twice. Renaming `main.py` to `robot.py` leaves the old `main.py` on the board, still running at power-up with old code, and its row reads `local-deleted`.
Rule: AS-18b when an old name with an S entry disappears and a new file with the same hash appears (rename or move), do not upload; offer `fs.mv` and hold the new name's upload until the offer is answered; if declined, upload normally. Rename detection by hash also saves a 4 KB/s re-upload.
Run: RUN-1 the Run command is single-flight: while preparing (save, flush, imports, stop) a second press is ignored with a status-bar message `Still getting the board ready for the first Run...`; while a program started by Run is running the AS-12 question applies. Test: two presses 100 ms apart produce one `run` op.

### R-09 Deliberately deleted `main.py` / `boot.py` is re-sent by the next save (wrong-overwrite, safety)
Spec: T08/T09, ST-5, 5.1 AS-5, 5.3 AS-6/AS-9, 7 (delete from board).
A student who removes `main.py` from the board to stop the robot starting at power-up (Files view delete) has the baseline entry forgotten (`engine.ts:287` `forget`) so the file becomes `new-local`, and the next save of the local `main.py` re-creates it on the board with only the one-time disclosure (AS-9). The same applies to `board-deleted` + save (AS-6 sends on save though 5.6 does not on connect).
Rule: BD-1 a delete made through the extension records a tombstone `{rel, deletedAt}` in the baseline file; tombstoned files are `board-deleted` (not `new-local`) and are not sent by save-triggered auto-sync until the student presses Upload now; for `main.py` and `boot.py` (STARTUP_FILES, `engine.ts:238`) auto-sync always asks first, every time, with a modal saying it will run at every power-up. BD-2 `Clear Device Files` writes tombstones for all removed files (see R-12).

### R-10 State inputs are incomplete, so some states are false (misleading-status)
Spec: 2.1, 2.2, 2.4.
Missing or contradicting inputs:
- **Untrusted workspace**: AS-4 makes `on` inert but `state()` has no `trusted` input, so `local-ahead` shows "They are being sent now" while nothing is sent (`autosync.ts:96-98`). Add `trusted` and a state/overlay `waiting` (reason: restricted mode, link `[Trust this folder]`).
- **Program running at connect** (the course case: `main.py` starts a motor loop at power-up; D-17 says it is left running): RF-2 forbids reads, E3 gives `unknown "not checked"`, and the unknown tooltip never says why. Every file stays `?` forever and `waiting` tooltips say "as soon as the program ends", which may never happen. Add `unknown` reason `program-running` with the link `[Stop the program and check]`, and in the status bar `$(debug-pause) A program is running; files are not checked`.
- **Board cannot hash**: needs its own input `boardHash: 'sha256' | 'none'` (T14/T15 refer to it but it is not in the input record).
- **Legacy `ask`**: the input allows `autoSync: 'ask'` but O3/O5 define only `on` and `off`. What does a `local-ahead` file show in `ask` mode before the question is answered? Also `ask` plus FSR gives two first-connect dialogs (5.1 AS-1 keeps `askFirstConnect`, `autosync.ts:338-376`). Rule: `ask` = `off` for state purposes until answered, and FSR replaces the old question (one dialog only).
- **Case-fold / kind mismatch**: see C-05 and R-15.

### R-11 `failed` cannot represent an unreadable local file; `failed` has no way to clear (misleading-status)
Spec: 2.2 E4, AS-16.
E4 compares `lastTransfer.localSha/boardSha` with the current hashes; for a file that cannot be read there is no `localSha`, so E4 never matches and the file silently becomes `unknown` or absent (R-01). Conversely a `failed` transfer (ENOSPC on the board) stays `failed` while L and B are unchanged even after the student has freed space: only "Try again" or reconnect clears it. Rule: store `failed.at` and the cause class; clear `failed` on reconnect, on any successful transfer, on a free-space change event, and on the next explicit refresh; add `unreadable` as in R-01.

### R-12 `board-deleted` is promised to be sent but never is; FAT drop and Clear Device Files (misleading-status / wrong-overwrite)
Spec: 2.4 O3, 5.6, 5.5 AS-13, BL-6, T08/T09.
- O3 turns `board-deleted` into `waiting` ("Your file goes out as soon as the program ends") but 5.6 says catch-up never uploads it, and save-triggered AS-6 does. The tooltip promise is false for the catch-up path. Pick one rule; recommended: `board-deleted` is not in O3's set (it keeps `↑+` and "Upload now").
- `Clear Device Files` calls `forgetDeleted` (`service.ts:531`), after which every project file is `new-local`; 5.6 uploads `new-local` at the next connect. The "cleared board must not be refilled by surprise" intent is defeated. Tombstones (R-09) fix it.
- FAT boards: a drop between remove and rename (`docs/protocol.md:146`) leaves the destination absent; AS-13 claims "the file stays local-ahead", but the state would be `board-deleted`. State the FAT case, or use `os.replace`-style semantics where available.

### R-13 Status bar and folder rollup leave combinations undefined (misleading-status)
Spec: 3.6, 3.4, ST-7/ST-8.
3.6 lists seven situations. Not covered: only `only-on-board`/`local-deleted` (down-plus) files; `new-local`/`board-deleted` with auto-sync on that are not being sent (oversize AS-8, board-deleted per R-12); `unsaved-edits`; `unknown`/`unreadable`; mixed `waiting` + `to send`; disconnected with a snapshot. With the stated priority list the bar falls through to "Board in sync" for those, which is false. Rule: SB-1 "Board in sync" requires every non-ignored file to be `synced`; otherwise a catch-all row `$(info) {n} files differ (see Files)`; add the missing rows to the table; test with the exhaustive U1 product (every combination maps to exactly one bar row).

### R-14 Hint H2 is biased and can steer the student to the wrong file (misleading-status)
Spec: 8.4 H2/H4, 3.2 `differs-unknown`.
The board mtime is the UPLOAD time (8.1), always later than the edit time of the same content. For a partner's board the rule "board newer by at least 120 s" is therefore true almost always when the partner uploaded after the student's last edit, regardless of which content is newer. The local mtime after OneDrive delivery may be the sync time on some clients [U]. The text "so it is probably newer" will be read as an instruction. Also `board-ahead` tooltip shows `{hint}` though H4 says hints never apply to pairs with a baseline (dead placeholder), and 3.2 points to "section 8.5" for hints (they are in 8.4).
Rule: TS-8 remove the "probably newer" claim; show only facts: `Board copy written {date}. Your file saved {date}. Dates can be wrong: copying and syncing change them.` Keep TS-6.

### R-15 Windows path length, case and reserved names (annoying, blocks overwrite)
Spec: OW-3, BK-1, 11 H1 hostile.
(a) Backup path `...\workspaceStorage\<32hex>\<publisher.ext>\backups\<yyyymmdd-hhmmss>\board\<rel>` is about 140 characters before `rel`; a OneDrive-deep `rel` pushes it past 259. OW-3 aborts the transfer if the backup fails, so the file can never be replaced. Rule BK-7: backups use short hashed names (`b/<n>.bak`) plus a `manifest.json` mapping to `rel` and time; Restore reads the manifest; a backup failure offers `Replace without backup` only for files under the BK-4 size.
(b) Case: the board is case-sensitive, Windows and default macOS are not. T-rows and `state(rel)` do not say how L and B pair up when only the case differs, or when the board holds `Main.py` and `main.py`. Existing planner has `key()`/`findCollisions` (`plan.ts:87-91, 142`); the spec must say that collisions are a state (`name-clash`, no transfer in either direction, tooltip names both) and that shadow-guard refusals (`E_SHADOWS_MODULE`, case-only, `protocol.md:163`) are a `failed` with the rename advice of J5-4.
(c) Windows reserved names (`con.py`, `aux.txt`), trailing dots/spaces: the existing `PathMapper`/`BoardCopy` checks are cited for F2 only; state that every download path runs them, including F1 auto and F5.

### R-16 Auto-send of `new-local` accepts anything the watcher sees (annoying, flash fill)
Spec: AS-6, T09, 5.6.
Any new file in the project folder is `new-local` and, with auto-sync on, is uploaded: OneDrive conflicted copies (`main-LAB-PC (1).py`, `data (2).csv`), downloaded PDFs, screenshots, `__pycache__`-like leftovers not in the ignore list. Each costs link time (R-07) and flash. The default ignore list (`ignore.ts:16-37`) does not cover conflict copies.
Rule: AS-19 a `new-local` file is sent automatically only when it came from a VS Code event (`onDidSaveTextDocument`, `onDidCreateFiles`) or has an allowlisted extension and passes the size cap; watcher-only creates keep `↑+` and wait for Upload now. Names with spaces or parentheses get the tooltip `This name has spaces or brackets; MicroPython cannot import it`. A built-in ignore pattern for ` (N).` and `-<COMPUTERNAME>.` OneDrive conflict names is optional and risky (false positives).

### R-17 Baseline loss on wiped or roaming lab-PC profiles causes review fatigue (annoying)
Spec: BL-3/4, 5.2, O-1.
If the lab PCs reset the profile at logout (Deep Freeze, clean profile) the baseline vanishes every session and every session starts with the modal FSR. After a few weeks students click "Sync as suggested" without reading, which is safe by construction (R-04 rule) but trains the click that matters in the rare dangerous review. Rule: when a pair is unreviewed but all differing-file count `d == 0` and no replace is proposed, skip Step A and just record the review with a one-line toast (the spec's FS-5 does this only for the empty board). Count how often it fires in the first week; keep O-1 open until instructors report the lab-PC profile policy.

### R-18 Edits made outside VS Code while a buffer is dirty hide the real state (misleading-status, low)
Spec: 2.4 O1, AS-17.
`unsaved-edits` replaces `local-ahead`; the tooltip says "Save and the file is sent". If the disk version was changed by Thonny/Notepad and differs from the board, saving in VS Code triggers VS Code's own "file is newer" prompt, not a send. Rule: O1 only when the disk version equals S/B; otherwise keep the base state and add the flag `dirty` plus `diskChanged` and say `This file also changed outside VS Code.`

### R-19 F1 toast repeats on every Run for programs that rewrite their log (annoying)
Spec: 7 F1.
Suppression is "Not now suppresses (path, board sha) until the file changes again"; a log changes every run. Rule: F1 shows at most one toast per Run, offers `Don't ask about {file}` (remembered per pair, in the baseline file), and collapses into the status bar when more than one toast per 5 minutes would appear.

### R-20 Deletes by safe-save editors raise "only exists on the board" on every save (annoying)
Spec: 5.8 AS-18.
Editors that save by delete + create/rename (vim, some Notepad++ settings, git checkout) fire `onDidDelete`; `reportGone` (`autosync.ts:389-421`) shows the toast and sets `board-only` immediately. Rule: re-stat the path 1.5 s after a delete event; report only if still absent.

### R-21 Ignored files hide differences that matter (misleading-status)
Spec: 2.2 E1, 9 J5-4, 7 F1.
`ignored` wins over everything, so a file that exists on the board but is ignored locally has no badge and no row text beyond the tooltip; a library the student put on the ignore list is never uploaded by Run, which silently uses the board's older copy or fails with `ImportError`. Rules: IG-1 a project file that is in the import closure of the run target and is ignored produces a Run warning `{name} is on your ignore list, so the board uses its own copy of it`; IG-2 the Files view shows a one-line group `N files on the board are on your ignore list` with a link to the list; IG-3 programs that write `*.tmp`, `*~`, `*.part` logs are hidden from F1; mention that in the toast of the ignore-list rule.

### R-22 Line endings and BOM make identical-looking files differ (misleading-status)
Spec: 2.3 (hash equality), 6.2 Compare.
Hashes are byte hashes. A file saved by Windows Notepad (CRLF) versus the board copy uploaded from a Mac (LF), or a UTF-8 BOM added by an editor, shows `differs-unknown`/`both-changed` with an empty diff. Rule: Compare reports `Only line endings differ` / `Only the BOM differs`; the dialog offers `Treat as the same`, which records S := board hash with `origin:"normalised"` and no transfer. Never automatic.

## 3. Feasibility on the current engine

| Spec item | Today's code [S] | Verdict |
|---|---|---|
| Pure `state()` per file, `SYNC_STATES` table | `SyncStatus` is a map of badges set from the last plan and from auto-sync (`status.ts:11-43`) | Buildable (W1/W5), replaces rather than extends |
| P1-P5 (mtime, `fs.hash`, CAS, `time.set`) | Not in `bridge/devfs.py`; manifest has only `size` (`devfs.py:260`) | Buildable; CAS on `hash:none` boards is not (R-03) |
| Virtual rows for local-only files in the Files view | The view lists board entries only (`filesView.ts:321`) | Buildable, but needs the local scan cache of R-06 first |
| `guardTransfer` as the only caller of `fs.put`/`fs.get` | `uploadFile` builds a plan directly (`service.ts:447-452`); `engine.runItem` calls `fs.put`/`fs.get` for every action | Buildable; the lint test "grep for fs.put" is brittle, test the wrapper instead |
| Background-run board backups | `backupBoardCopy` returns immediately when `background` (`engine.ts:302-305`) | Must change; spec W7 covers it, but R-07 says background puts must also be cancellable, which the bridge does not support today (`protocol.md:96`) |
| Atomic local compare-and-swap before download | No such primitive on Windows | Not fully buildable (R-02); document the residual window |
| MarkdownString tooltips with command links | `FileDecoration` tooltips are plain strings (`decorations.ts:21-28`); TreeItem tooltips can be Markdown | Buildable on the TreeItem; the spec already keeps the decoration plain |
| Offline-file detection without native modules | not present | [U] needs a spike (R-06c) |
| Mid-run reads | RF-2 forbids; the course's autostarting `main.py` makes that permanent | Buildable, but UX gap R-10 |

## 4. Table completeness and consistency (sections 2, 5, 6)

- **C-01** The T01-T15 table has no row for: local file unreadable (R-01); L is a folder and B a file or the reverse (NF-3 handles creation only); symlink or junction in the project (`linkInProject` is cited in tests only); board path outside `rootPath`; directory states (empty folders, NF-4 mkdir items). Add rows or an explicit "out of scope: shown as `unknown`".
- **C-02** `board-deleted` in O3 versus 5.6 (R-12). `new-local` in 5.6 versus Clear Device Files (R-12).
- **C-03** `autoSync: 'ask'` is an input but O3/O5 do not define it (R-10).
- **C-04** `trusted` workspace, `boardHash` capability and `unreadable` are missing from the input record (R-10, R-11).
- **C-05** Case-insensitive pairing is not in the pure function (R-15b).
- **C-06** T05 asserts "unreachable" for L=S=B with L!=B; fine. T08 flags `localEdited = (L != S)` but nothing uses it: a `board-deleted` file with `L != S` still shows the same `↑+`; the Upload is safe. Remove the flag or give it a tooltip sentence.
- **C-07** 3.2 references "section 8.5" for hints (they are in 8.4) and lists `{hint}` in `board-ahead`, where H4 forbids it.
- **C-08** U1 arithmetic: 64 (L,B,S) x dirty x running x disconnected x ignored x autoSync(2) x pairReviewed = 64 x 64 = 4096, not 8192 (the spec says 128 combos). The "exhaustive" product omits `inFlight`, `boardClock`, `hash capability`, `trusted`, `lastTransfer`, `stale` and the `ask` mode; "running and disconnected" cannot occur together. State the real size or call the test "pairwise".
- **C-09** Cross-section: 2.5 BL-5 says `local-ahead`/`board-ahead`/`both-changed` become `differs-unknown` on derived keys while the board read (RF-1) and the T-table do not mention the key type; the pure function needs `boardIdDerived` as an input to be testable.
- **C-10** Section 5 AS-5 says auto-sync never replaces a "protected" board file, while OW-3 says a board file equal to S is replaced WITHOUT backup. Acceptable, but then the tooltip rule UI-8 ("never says overwritten without saying a backup is made") needs an exception for `local-ahead` (nothing is said to be overwritten there; verify wording).

### Testability

Rules that are directly testable as written: ST-1, ST-2, ST-3, OW-1 (truth table), OW-3 (backup failure aborts), OW-6, BL-1, MG-1..5, UI-2, UI-5, TS-1, TS-6, J5-2..J5-5, NF-1..NF-7.
Rules that need rewriting to be testable:
- OW-2 ("no code path writes without `guardTransfer`") as a grep lint is brittle; test the single wrapper and a property test that the fake board and fake local file system receive writes only through it.
- UI-3/UI-12 (colour independence) needs a concrete assertion: every state has a non-empty glyph and a non-empty word and the glyph is unique within `SYNC_STATES`.
- RF-6 ("progress", "cancel leaves the old snapshot") needs the chunk size of R-07c to be observable.
- AS-11 ("rebuilt from the states") needs an explicit statement of what is persisted across a reload (nothing) and the test "reload + reconnect uploads the same set".
- 11 last line "every ID is referenced by a test name" must be scoped (O-1..O-10, W1..W13, T-rows are not rule IDs; TS-3..TS-5 do not exist; numbering gaps).

## 5. What I checked and found sound

- The 3-way compare with CAS closes the board-overwrite window for scenarios 1, 3 and 4 and for stale or lost baselines (a stale S can only produce `E_DEST_CHANGED`, never an overwrite).
- Baseline is outside the project (`baseline.ts:1-9`), keyed by (workspace URI hash, board id) (`baseline.ts:28, 86-88`), written atomically and serialised (`baseline.ts:124-134`): OneDrive cannot carry it to another PC.
- Local backups before every download (`engine.ts:271-273`) exist today; the spec keeps them.
- `*.mpytmp` and common OneDrive/Dropbox/iCloud leftovers are ignored by default (`ignore.ts:26-30`); temp orphans are cleaned by the bridge once per session (`bridge/server.py:1160`).
- Timestamp use: no code path picks a direction from a time (TS-6); H1 is guarded and re-checked by CAS (RF-4).
- FSR defaults never preselect an overwrite; the "empty board" and "empty folder" shortcuts are additive.
- Sending is by saved content, never by the editor buffer (AS-17); `isDirty` blocks a download of a dirty VS Code buffer (`engine.ts:268-270`).
