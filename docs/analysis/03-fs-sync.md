# 03 - Board file explorer and local <-> board mirroring: analysis and target design

Scope: `esp32Fs.ts`, `localFilesView.ts`, `sync.ts`, `syncView.ts`, `boardOperations.ts`, `mpremoteOperations.ts`, `pyraw.ts`, `decorations.ts`, `types.ts`,
`scripts/raw_list_files.py`, `scripts/bench_upload.py`, the filesystem half of `mpremote.ts`, and the sync / save / delete / download parts of `extension.ts`.
Subject: MPY Workbench v0.3.2, repo HEAD `7cb90c7` (2026-04-04). Reference mpremote: **1.29.0**.

Paths: `old/` = `../mpy-workbench/`. Citations are `old/src/<file>:<line>` and are written `<file>:<line>` below.

## 0. Evidence legend, test rig, limits

| Tag | Meaning |
|---|---|
| **[E]** | Executed. Either the *real compiled old code* (tsc copy in the scratchpad, `vscode` stubbed, the real `extension.js` activated headlessly), or the real mpremote 1.29.0 CLI/parser, against a simulated board. |
| **[S]** | Read in the mpremote 1.29.0 source (`transport.py`, `commands.py`, `main.py`, `transport_serial.py`). |
| **[R]** | Read in the old source, not executed. |
| **[I]** | Inferred (hardware or platform behaviour I could not test). |

**Rig (no serial port was opened, probed or listed).** A ~50-line Python bridge (Appendix A) listens on `127.0.0.1`, and for each connection spawns the
**MicroPython v1.29.0 unix port** inside a pty (cwd = a sandbox directory, writes confined by `sandbox-exec`). mpremote talks to it through pyserial's
`socket://127.0.0.1:PORT` URL, so the real mpremote 1.29.0 raw-REPL / `fs` code runs unmodified. The bridge emulates the board's `soft reboot` banner and can
throttle to an emulated UART (115200 baud + 2 ms latency). Because the unix port's "/" is the host root, the harness strips the leading `/` from *remote* path
arguments (emulating a board whose cwd is `/`); nothing else about the old code's commands is altered.

**Not covered.** No Windows host, no real ESP32, no VS Code runtime. Unix-port differences vs ESP32: `os.ilistdir` returns 3-tuples (so `fs ls` shows size 0),
errno numbers/strings differ (macOS ENOTEMPTY = 66), no flash-write latency, no UART RX buffer limits, no `main.py`/`boot.py` behaviour. All timings are
**relative** (rig overhead per mpremote launch is about 0.9 s: ~0.17 s Python start, the rest is the emulated reboot). Absolute real-board times are unmeasured.

Artifacts (scratchpad, session-local): `scratchpad/fs-sync/{sim,build,proto}`. The key scripts are inlined in Appendix A/B so this document is self-sufficient.

---

## 1. Bottom line

1. **The "mirror" is a one-way, save-triggered push plus two bulk buttons.** No comparison, no deletes, no renames, no conflict handling. The README's "two-way sync / compare" was
   deleted in 0.3.1 (`git 9b302fd`) and 9 Files-view commands were deleted in 0.3.2-dev (`git fbb4a16`) while `package.json` still declares them (section 2.2).
2. **The device-FS layer is built on text-scraping `mpremote fs tree` / `fs ls` and on mpremote subcommands that do not exist.** `fs stat`, `fs mv` are silent no-ops
   (exit 0) in every mpremote 1.20-1.29 [E][S]; `fs mkdir -p` is rejected by argparse (exit 2) [E]. Consequences are proven below: `fileExists()` returns **true for a path that
   does not exist** [E], `mvOnDevice()` renames nothing [E], and every upload spends one process that is guaranteed to fail [E].
3. **Root cause of complaint 1b ("Run current file didn't seem to even work")** lives in this layer: `runActiveFile` asks `fileExists()`; it is always `true` while the board is reachable,
   so it always runs `exec "import <module>"` against the *board's* copy, which does not exist unless autosync uploaded it. Autosync is silently off by default **and**
   silently does nothing in a workspace that was never "Initialized" [E] (S1/S2 in section 5).
4. **The tree parser is wrong on ordinary boards.** Against the real `fs tree` output of a 30-entry tree it produced 11 discrepancies: extension-less files and every `.mpy` file shown as folders, any
   name containing the substring `tree` (`street.txt`, `streets/`) dropped, their children re-parented to `/` [E]. `.mpy` files are what `mip install` puts in `/lib`.
5. **"Download all" and "Clear Device Files" are unsafe and unreliable.** Download-all overwrites local edits with no prompt/backup and *aborts midway* on the first phantom path; Clear Device
   Files leaves files behind and reports the wrong counts, because both read a 30 s stale `tree-paths.json` through the broken parser [E]. "Upload all" tells the user "completed" when uploads failed [E].
6. **Performance model is process-per-operation.** Each mpremote launch = port open + Ctrl-C + soft reset (kills the running program) + close. Real `syncBaseline` of **7 files / 3 folders = 49
   launches** (33 when nothing changed); one autosave = 3 launches (1 guaranteed failure); "Save All" of 4 files = 4 simultaneous launches on one port [E]. A single session uploads 12 x 1 KiB files in 2.9 s versus 20.0 s for one mpremote process per file (~7x), and a stop-and-wait streaming protocol is 2.3x (text) to 4.9x (binary) faster than `mpremote cp` on an emulated 115200 UART [E].
7. **Concurrency control is dead code.** `markOperationStarted` is immediately undone by `markHealthy`; `withAutoSuspend` resets `opQueue` on every call [E][R]. Operations overlap; saves, listing and Run race.
8. **Windows:** HEAD builds `'<python>' -m mpremote 'connect' ...` and runs it through `exec` (cmd.exe), which has no single-quote quoting, so *every* board operation fails [R][I]
   (cross-checked by `05-cross-platform.md` X-01). Additionally `uploadActiveFile` leaves backslashes in the device path [E].
9. **Recommendation for this area: rewrite, not patch.** Keep the UX (sidebar, autosync toggle, rootPath mapping, ignore file, board tree with incremental updates) but replace
   everything under it with a single long-lived board session that speaks structured JSON (on-device snippets), compares by size+sha256 against a recorded base, writes atomically,
   and never deletes or overwrites without a previewed plan (section 6). About 40 % of the current FS code is dead or unreachable (section 2.3).
10. Prototypes (section 6, Appendix B) verified by execution: JSON listing/hash snippets survive newline/quote/backslash/emoji/space names; a scan+hash+3-way plan takes 3 round trips; upload by acked streaming reaches line rate.

---

## 2. What "auto-mirror" means in the old code

### 2.1 Question-by-question

| Question | Answer in code | Cite |
|---|---|---|
| What triggers a transfer? | (a) `onDidSaveTextDocument` of any file in workspace folder 0 **iff** `.mpy-workbench/esp32sync.json` exists **and** autosync is on; (b) buttons: *Upload all*, *Download all*, *Upload Active File*, *Clear Device Files*; (c) opening a board file that has no local copy downloads it; (d) the local-files view's `uploadToBoard` (unreachable, see the *Local-files tree view* row). Nothing else: no file watcher on content, no Explorer create/rename/delete hooks. | `extension.ts:1093-1128,558-866,895-973`; the only watchers are on `.mpystudio/config.json` (stale name) and `esp32sync.json`, `extension.ts:245-260` |
| What is compared? | **Nothing explicitly.** The only equality test is mpremote's built-in *sha256 "Up to date" skip* inside `fs cp` (on by default; `uploadReplacing`'s `-f` turns it off) [S][E]. `diffManifests`, `loadManifest`, `getBoardFilesAndSizes`, `Esp32DecorationProvider.set*` are **never called**. The removed diff feature compared **size only** (`git 9b302fd^:src/boardOperations.ts:679`), which misses same-size edits. | `sync.ts:41-52,60-63`; `decorations.ts:12-30`; `mpremote.ts:1612` unused |
| Where is state stored? | `<ws>/.mpy-workbench/config.json` `{autoSyncOnSave}`; `esp32sync.json` = "initialised" marker + last Upload-all manifest (`{size, mtime}` per file, absolute local `root`, random `syncId`) **never read back**; `.mpyignore`; `tree-paths.json` = flattened parse of the device tree used as a 30 s cache by `listTreeStats`. VS Code settings: `mpyWorkbench.connect` (written at *Global* scope and reset to `"auto"` on every activation), `rootPath`, `pythonPath`, ... In memory: `Esp32Tree._nodeCache`, `globalFileTreeCache` (30 s). | `extension.ts:67-69,187`; `sync.ts:5-12`; `mpremote.ts:272-289,1486-1525` |
| Deletes? | Never propagate. Local delete/rename in the Explorer does nothing on the board, so renamed/removed modules remain and shadow new ones. Board deletes exist only as *Clear Device Files* (HEAD) and, in history, per-node delete (`delete`, `deleteBoardAndLocal`: the latter `fs.rm(recursive,force)` the local copy even if the board delete failed). | `extension.ts:1007-1074`; `git fbb4a16^:src/extension.ts:970-1031` |
| Renames? | Not at HEAD. Historic `renameNode` called `mvOnDevice` (silent no-op, section 3) then renamed the local file, so board and local diverged silently. | `mpremote.ts:1722-1736`; `git fbb4a16^:src/extension.ts:1175-1215` |
| Conflicts? | None. Last writer wins in both directions. Open-from-board uses the existing local copy without comparing (stale-copy risk). | `extension.ts:941-955` |
| What does `rootPath` do? | Device directory that corresponds to the workspace root. Tree view root = `rootPath`; `toDevicePath(rel)` = `rootPath/rel`; `toLocalRelative(dev)` strips the prefix (and, outside the prefix, silently strips the leading `/` and maps into the workspace). Applied by autosave, Upload all, Download all, Clear, open/download. **Not** applied by `uploadActiveFile` (always `"/"+rel`). No validation or normalisation. | `mpremoteCommands.ts:345-358`; `extension.ts:911` vs `:1119` |
| Ignore rules? | `.mpy-workbench/.mpyignore` (created only by Initialize) + hard-coded defaults, via a home-made glob-to-regex. A root `.mpyignore` is **not** read although `esp32Fs.ts:145` says so. Applied to autosave, Upload all, Download all, active-file upload and to the *board tree display*; **not** applied to `uploadLocalFolderToDevice` or Clear. | `sync.ts:73-123`; `esp32Fs.ts:145-165` |
| Local-files tree view? | Lists workspace files (hides `.git .mpy-workbench node_modules __pycache__ .vscode .idea` at top level only; **not** `.venv`, not `.mpyignore`). Registered in code but not declared in `package.json` (no view, no commands in menus), so it is unreachable; VS Code reports "No view is registered with id" [R][I]. Its commands (`uploadToBoard`, `localOpen`, ...) are undeclared. | `localFilesView.ts:15-22,66`; `extension.ts:197,470-547` |
| Board tree view? | `Esp32Tree`: `getChildNodes` -> `autoSuspendLs` -> `lsTyped` (whole-FS `fs tree`, parsed; 30 s cache) with an extra `_nodeCache` per directory; incremental `addNode/removeNode`; filters ignored names; merges "local-only" nodes from a decorations set that is always empty. | `esp32Fs.ts:117-250` |

### 2.2 Drift between manifest, docs and code (regressions)

* `package.json` declares and menus show **9 Files-view commands with no handler anywhere in `src/` or `dist/`**: `renameNode`, `newFileInTree`, `newFolderInTree`, `newFileBoardAndLocal`, `delete`,
  `deleteBoardAndLocal`, `syncFileLocalToBoard`, `syncFileBoardToLocal`, `openFileFromLocal` (plus `refreshPorts`). Clicking any gives "command not found" [E: static diff of declared vs `registerCommand`].
  `git fbb4a16` ("Add local files tree view", Feb 12) deleted exactly these registrations while adding the local view; `package.json` was not updated.
* `git 9b302fd` (0.3.1) removed `checkDiffs`, `syncDiffsLocalToBoard`, `syncDiffsBoardToLocal`; README (`README.md:14`) and CHANGELOG still advertise "two-way sync: compare ... and sync changed files".
* The published VSIX `mpy-workbench-0.3.2.vsix` contains the *pre-refactor* `mpremote.js` (bare `mpremote`, double-quoted args); HEAD changed to `python -m mpremote` with POSIX single quotes (`7cb90c7`) [E: unzip + diff].
* 16 commands are registered but not declared (unreachable from UI/palette), e.g. `downloadFileFromBoard`, `rebuildManifest`, `uploadToBoard` (a 17th, `rename`, only exists inside a commented-out block at `extension.ts:1156-1185`).

### 2.3 Dead / duplicated code (about 40 % of the FS code)

`mpremoteOperations.ts` (empty stubs), `pyraw.ts` + `scripts/raw_list_files.py` (opt-in, points at non-existent `scripts/thonny_list_files.py`, `pyraw.ts:12`), `scripts/bench_upload.py`
(calls non-existent `scripts/mpremote_tool.py`), `BoardOperations` (instantiated at `extension.ts:204`, never called; duplicates `syncBaseline` which also lives in `extension.ts:558-829`),
`decorations.ts` setters, `diffManifests/loadManifest`, `getBoardFilesAndSizes`, `fileExistsSha256`, `mvOnDevice`, `deleteFile`, `uploadReplacing` (only used by *Upload Active File*), `mpyWorkbench.baudRate` setting (no reader), `healthCheck`/debug helpers that write `test_write.tmp` and `test_dir` to the board root (`mpremote.ts:409-477`).

---

## 3. What mpremote 1.29.0 really does (the contract the old code violated)

| Fact | Evidence |
|---|---|
| `fs` subcommands that do something: `cat cp ls mkdir rm rmdir touch tree` and `*sum` (e.g. `sha256sum`). **`stat` and `mv` parse (free-text `command` arg) but `do_filesystem` has no branch, so they print `stat :/x` / `mv :a` and exit 0, doing nothing.** Same in 1.20 ... 1.29. | [S] `commands.py:380-455`; [E] `fs stat /nope/never` -> exit 0; `fs mv nothing_here other` -> exit 0 |
| `fs mkdir` has no `-p`: `unrecognized arguments: -p`, exit 2. | [E] argparse of the real `argparse_filesystem()`; and via the old code (A1) |
| `fs cp` (no `-f`) hashes the destination on-device and prints `Up to date: <path>` instead of rewriting; `-f` forces rewrite. Falls back to *reading the whole remote file* if the device lacks `hashlib`. | [S] `commands.py:134-195`, `transport.py:fs_hashfile`; [E] |
| `fs cp local :existing_dir` copies **into** the directory (`dirnamed.py/up.py`), no error. | [E] |
| `fs cp` writes the destination directly (`open(dest,'wb')`, 256-byte `repr()` chunks, one raw-REPL transaction per chunk). No temp file, no atomic rename; an interrupted copy leaves a truncated file. | [S] `transport.py:fs_writefile` |
| `fs tree` output = `tree :` line (default verbose), `:<cwd>` line, then `+-- name` lines using box-drawing glyphs (`├── └── │`) with 4-column indent, sorted by name, no sizes unless `-s/-h`, no dir marker. `fs ls` = `{:12} {name}{/ if dir}` plus an `ls :` header line. Both are human formats. | [S] `commands.py:345-377,422-428`; [E] real output in Appendix C |
| Every launch (`State._auto_soft_reset = True`) does Ctrl-C, enters raw REPL and **soft-resets the board** (re-runs `boot.py`), then closes the port. `resume` disables the soft reset. Chained commands (`a + b`) share one connection. | [S] `main.py:536-553`, `transport_serial.py:178-215` |
| Paths without a leading `/` are relative to the device's `os.getcwd()`; the `:` prefix only matters for `cp`. All other `fs` commands treat every positional as remote. | [S] `commands.py:393-410` |
| The internal API (`SerialTransport`, `fs_listdir` via `os.ilistdir` + `ast.literal_eval(repr)`) is robust, but the file header says "the API is going to change significantly". | [S] `transport_serial.py:1-12` |

---

## 4. Defect catalogue

Severity: **C** critical (breaks the user's stated goal), **H** high, **M** medium, **L** low. Confidence tag as in section 0.

### Correctness of device enumeration

**FS-01 (H) [E] `parseTreeLines`/`determineIsDirectory` misclassify and drop entries** - `mpremote.ts:511-649`
* Real `fs tree` output (30 entries, Appendix C) -> 11 discrepancies: `/config` (extension-less file) = dir; `/lib/{foo,bar}.mpy`, `/lib/umqtt/{simple,robust}.mpy` = dirs (not in the 22-entry extension whitelist; lookahead treats *any* next line with `level > 0` as a child); `street.txt`, `streets/`, `streets/a.py`, `streets/b.py` dropped (`line.includes('tree')`, `:520`, `:628`); phantom `/a.py`, `/b.py` appear at the root (children of the dropped dir re-parented).
* Synthetic cases [E]: last top-level directory whose name contains `.` (`app.v2/`) becomes a file and its children move to `/` (the lookahead trims the 4-space prefix, so level reads 0, `:626-632`); extension-less file inside a folder becomes a folder; `data` followed by a sibling dir becomes a folder; names are `trim()`med (`" lead.py"` -> `"lead.py"`); `lines.indexOf(line)` (`:543`) picks the *first identical line* (O(n^2) and wrong for repeated `└── main.py`). CRLF input and a non-`/` cwd header parse fine.
* Fix: never parse human output. Use a JSON listing snippet (section 6.2).

**FS-02 (H) [E] `lsTyped` fallback `fs ls` parser** - `mpremote.ts:810-833`: skips any name containing `ls` (`tools.py`, `false.py`), joins `split(/\s+/)` (collapses double spaces), `isDir = size===0 && endsWith('/')` (wrong for filesystems reporting a non-zero dir size). Empty directories cost three launches (cache-miss: `fs tree`, then `fs ls`) [E: B1: 2 extra launches].

**FS-03 (H) [E] `listTreeStats` is wrong in both branches** - `mpremote.ts:1478-1572`
* Cache branch (`tree-paths.json` < 30 s old): returns `size: 0`, `mtime: Date.now()/1000` for every entry and ignores its `root` argument. Used by Download-all and Clear.
* Fallback branch: runs the *tree* output through `split(/\s+/)`; result is bare names (`"boot.py"`, never `"/lib/x.py"`), `isDir` always false, size 0 [E: T5: 28 entries, 0 dirs].
* `deleteAllInPath("/")` then filters `pathParts.length === 1`, which on the fallback output matches *everything*.

### Existence / stat / rename that do not exist

**FS-04 (C) [E][S] `fileExists`, `getFileInfo`, `mvOnDevice` rely on no-op subcommands** - `mpremote.ts:1288-1314,1354-1388,1722-1736`
* `fileExists('definitely/not/here.py')` -> **true**; unreachable board -> false (all errors swallowed). It is a connectivity probe, not an existence test [E: T1].
* `getFileInfo` parses `stat :/x` (2 tokens, needs 4) -> `null` always [E: T2], so `deleteAny` never adds `-r`; it only works for non-empty dirs on littlefs because the `OSError: 39` fallback exists [I].
* `mvOnDevice` passes literal-quoted args (`"/a"`, X-05 in `05-cross-platform.md`) to a no-op; exit 0, file not renamed [E: A5].
* Callers: `runActiveFile` (`mpremoteCommands.ts:198`) -> complaint 1b; `syncBaseline` "directory verification" (`extension.ts:669,705`) is vacuous; historic `renameNode`.

### Upload path

**FS-05 (H) [E] `mkdir -p` unsupported => every upload burns a failing process** - `mpremote.ts:948,1103`. First save of a file in a new nested folder = **7 launches** (pre-flight `fs tree`, failing `mkdir -p`, failing `cp`, 3x `mkdir`, `cp`); re-save of an existing file = **3 launches** (`fs tree`, failing `mkdir -p`, `cp`) [E: S3/S4]. The recovery branch (`:983-1015`) matches the English string "no such file or directory" and creates `'/' + parts` levels one process at a time.

**FS-06 (H) [S][E] Non-atomic writes; "replacing" claim is false** - `uploadReplacing` only adds `-f` (disable hash skip); `extension.ts:912` comment "avoid partial writes while code may autostart" is wrong. mpremote opens the destination `'wb'` and streams 256-byte chunks, so Ctrl-C, unplugging, power loss or a full flash leaves a truncated `main.py`/`boot.py` (board may then fail to boot cleanly). No free-space check.

**FS-07 (M) [R] Blind destructive recovery** - on "read-only file system" `cpToDevice` soft-resets, then runs `os.umount('/'); os.mount(os.VfsFat(os.sdcard()), '/')` (`mpremote.ts:1018-1070`): on a board without SD this can leave `/` unmounted; also uploads *twice* after reset.

**FS-08 (H) [E] "Upload all" is O(files x 3) launches and lies about failures** - real `extension.js` `syncBaseline`: first run (7 files, 3 dirs) = **49 launches, 44.7 s** in the rig; unchanged re-run = **33 launches, 30.3 s** [E: R1/R2]. Each directory is `mkdir`-ed up to 3x (`File exists` is treated as failure; `extension.ts:628-654`), then "verified" with the no-op `fs stat`, then every file triggers `ensureIdle()` -> `mp.ls("/")` -> a full `fs tree` (cache invalidated by the previous upload, `extension.ts:269-277,791`). When two uploads fail the user still gets **"Board: Sync all files (Local -> Board) completed"** and the manifest is saved as if everything succeeded [E: E3]; failures only reach `console.error` (`:798-811,817-822`).

**FS-09 (H) [E] Autosave is silent, sequential-unsafe and aggressive** - `extension.ts:1093-1128`
* No message at all if the workspace is not "initialised" (never created by default) or autosync is off (default `false`) [E: S1/S2]. The student's first experience is "saved, nothing happens".
* No debounce/coalescing; `files.autoSave: afterDelay` would soft-reset the board on every pause [S][I].
* "Save All" of 4 files = 12 launches with **4 simultaneous processes on one port** [E: S5]. On a real port the 2nd-4th get `failed to access ... in use` and rely on 2 retries (500/1000 ms) [I].
* Not awaited by `runActiveFile` (`mpremoteCommands.ts:167` saves, upload is a fire-and-forget listener) -> Run races the upload and runs the old/absent board copy [R].

### Download / delete

**FS-10 (H) [E] "Download all" overwrites local work with no prompt and aborts midway** - `extension.ts:831-866`. In the real command: local `main.py`/`boot.py` edits were replaced by the board's versions, no backup; the loop has no `try/catch`, so the first bad path (`/a.py` phantom from FS-01) aborts the command after 11 of 23 files; the user sees only a generic command failure (no completion toast) [E: R3]. README: "overwriting local copies".

**FS-11 (H) [E] "Clear Device Files" is incomplete and misreports** - `extension.ts:1007-1074`, `mpremote.ts:1390-1454`: with the fixture it deleted 15 items, failed 2 (phantoms), and **left `/street.txt`, `/streets/*`**; message "Deleted 15 items, but 2 failed. 2 items remain" (real remaining: 3 files + 1 dir) [E: R4]. The "Verifying deletion" step re-reads the same <30 s `tree-paths.json`, so it can report N remaining after everything was deleted ("system files remain, this is normal") [E: D1]. With a non-root `rootPath` it `rm -r`s the root directory itself and does not recreate it [E: A8]. No preview, no backup, no protected paths; modal text is the only guard.

**FS-12 (M) [E] `deleteDirectoryRecursive`** - `mpremote.ts:1179-1228`: text-parses `fs ls`; skips names containing `ls` (`tools.py` survives), collapses double spaces (`double  space.py` -> not found), swallows per-file failures, then `rmdir` fails: **partial delete + exception** [E: A7].

### State, caches, races

**FS-13 (H) [E] Concurrency guard is dead** - `mpremote.ts:164-167` calls `markOperationStarted` then `markHealthy`, which sets `operationInProgress=false` (`:65-71`) [E: B2]; `withAutoSuspend` resets `opQueue = Promise.resolve()` unless `preempt:false` (`extension.ts:281-283`); `cancelAll` kills only `currentChild` (`mpremote.ts:1574-1577`) and on Windows kills the `cmd.exe` wrapper, not `python.exe` [I]. Concurrent operations overlap [E: B3, S5].

**FS-14 (M) [E] Refresh does not refresh** - `mpyWorkbench.refresh` clears the tree cache but `lsTyped` serves its own 30 s `globalFileTreeCache` (`mpremote.ts:305-308,778`); `clearFileTreeCache()` is called only by mutating mpremote helpers, not by `cpFromDevice`, program-created files or other tools; it also does not delete `tree-paths.json`. A file created on the board 1 s ago is invisible after Refresh [E: C1]. An in-flight `populateFileTreeCache` that finishes after `clearFileTreeCache()` re-installs a pre-change snapshot [R].

**FS-15 (M) [E] `Esp32Tree.addNode` on an unlisted parent hides the real contents** - `esp32Fs.ts:77-94` creates `_nodeCache[parent] = [newNode]`; expanding that folder then shows only the new file until Refresh [E: C2]. Triggered by every autosave into a folder the user has not expanded yet.

**FS-16 (L) [R]** `Esp32Tree` swallows listing errors whose text contains `"serial port"` or `"auto"` (`esp32Fs.ts:240-243`); tree item `resourceUri = Uri.parse('esp32:'+path)` mis-parses names with `#`/`?`; every listing runs the whole-filesystem `fs tree`, which will recurse into a mounted SD card with no timeout or exclusion [I].

**FS-17 (M) [R] `esp32sync.json` is write-only and non-portable** - stores the absolute local `root`, `syncId`, per-file `{size,mtime}`; nothing reads it back, so it cannot detect deleted/renamed/changed files; likely to be committed with machine-specific paths; "De-initialize" `rm -rf`s `.mpy-workbench` including a user-edited `.mpyignore` (`extension.ts:362`).

### Platform

**FS-18 (C on Windows) [R][I]** `runMpremote` builds `'<python>' -m mpremote 'connect' 'COM3' ...` and `exec`s it (`mpremote.ts:7-9,170-184`); cmd.exe cannot run it, so every FS operation fails. The VSIX variant (double quotes, bare `mpremote`) breaks on `"`, `%`, `^`, `&`, newlines and a missing PATH. Fix: `spawn`/`execFile` with an argv array, `shell:false`.

**FS-19 (M) [E] Windows path bug in `uploadActiveFile`** - `extension.ts:904,911` use `/\\\\/g` (matches two backslashes). Windows `path.relative` yields `lib\sub\file.py`; the device path becomes `"/lib\sub\file.py"` (a file with backslashes in its name at `/`, no folder) [E: C3 reproduces the regex result]. Autosave uses the correct `/\\/g` (`:1111`).

**FS-20 (M) [R][I] Name safety when mirroring board -> local**: no handling of Windows reserved names/characters (`CON`, `:`, trailing dot/space), backslashes in device names (`path.join(ws, ...rel.split('/'))` would treat them as separators, a path-traversal vector from an untrusted board), case-collisions on case-insensitive local FS, NFC/NFD differences (macOS), or CRLF-vs-LF hash differences (git `autocrlf` on Windows).

### Ignore engine

**FS-21 (M) [E]** `sync.ts:87-123`: `*.py[cod]` does **not** match `x.pyc` (regex escapes `[` `]`, so it matches a file literally named `x.py[cod]`); case-sensitive (`thumbs.db` synced); `isDir` parameter unused; no negation (`!`), no anchoring semantics for mid-path `/`; directory patterns match files of the same name; `build/ out/ dist/` ignored at any depth (`lib/out/x.py` is silently skipped); built-in defaults lack `.venv/`/`venv/` (only the generated `.mpyignore` has them; without it `.venv/lib/x.py` would be uploaded [E: C4b]); root `.mpyignore` not read. The ignore filter is applied to the *board tree display* (hides device `*.log`, `.env`, `build/`) and Download-all, but not to Clear, so students cannot see what Clear deletes. `uploadLocalFolderToDevice` ignores the matcher entirely (`extension.ts:303-326`).

### Misc

**FS-22 (M) [R]** `rootPath` inconsistency (`uploadActiveFile` ignores it) and activation sets `mpyWorkbench.connect` back to `"auto"` on every start (`extension.ts:187`), so each reload turns autosave into "Select a specific serial port first" warnings.
**FS-23 (L) [R]** `raw_list_files.py`: `{PATH}` substituted into an `r"..."` literal (quote injection), hides dot-files, never waits for the raw-REPL prompt (sleeps 100 ms), 5 s hard deadline; `pyraw.ts` points at a missing script. `bench_upload.py` references `mpremote_tool.py` (gone since 0.2.4).

### Data-loss matrix

| Action | Can destroy | Guard today | Verdict |
|---|---|---|---|
| Download all (Board->Local) | any local file that also exists on board (unsaved-to-board edits) | none | **High** [E] |
| Upload active/auto/all | board file edited on board (e.g. calibration, `data.json`), and partially written files on interruption | hash-skip only; no atomicity | Medium |
| Clear Device Files | everything under `rootPath` incl. `boot.py`, calibration, logs; root dir itself when `rootPath != /` | one modal | **High** (and incomplete) |
| `deleteBoardAndLocal` (historic) | local files even when board delete failed; permanent `fs.rm` (no trash) | one modal | High (removed at HEAD) |
| De-initialize | `.mpy-workbench/` incl. custom `.mpyignore` | modal | Low |
| `deleteDirectoryRecursive` | partial deletes then throws | none | Medium |

---

## 5. Measurements (rig, unthrottled unless stated; all via the real old code)

| Scenario | mpremote launches | Rig time | Notes |
|---|---|---|---|
| T1 `fileExists("definitely/not/here.py")` | 1 | 0.9 s | returns **true** |
| A1 `cpToDevice` into missing `/work/a/b/` | 6 (`mkdir -p` FAIL, `cp` FAIL, `mkdir`x3, `cp`) | 5.2 s | result correct |
| A2 re-upload unchanged | 2 (`mkdir -p` FAIL, `cp` -> "Up to date") | 1.5 s | |
| S3 autosave, first save in new folder (real extension) | 7 | ~6 s | incl. pre-flight `fs tree` |
| S4 autosave, existing file (real extension) | **3** | ~2.7 s | one guaranteed failure |
| S5 "Save All" of 4 files | 12, **4 simultaneous** | | |
| R1 `syncBaseline`, 7 files / 3 dirs (real) | **49** | 44.7 s | 23 failed `mkdir`, 7 pre-flight `fs tree` |
| R2 same, nothing changed (real) | **33** | 30.3 s | |
| B1 expand an empty folder | +2 (`fs tree`, `fs ls`) | | |
| Proposed: scan + hash plan (prototype) | **1 connection, 2 execs** | 0.04 s rig | 23 files, exact 3-way plan |

Transfer strategy benchmark, 20 000-byte payloads, **emulated 115200 baud, 2 ms latency, unix-port MicroPython** (relative numbers only; line rate = 11.5 KB/s):

| Strategy | text KB/s | binary KB/s | verified |
|---|---|---|---|
| `mpremote cp` style (256 B/exec, `repr()`) | 4.4 | **2.2** | yes |
| base64, 1 KiB per exec | 5.1 | 5.1 | yes |
| base64, 4 KiB per exec | 5.4 | 5.5 | yes |
| stdin stream + 1-byte ack per 1 KiB block | 10.1 | 10.2 | yes |
| stdin stream + ack per 4 KiB block | 10.7 | 10.7 | yes |
| 12 x 1 KiB files: one `mpremote` process each vs one session | 20.0 s vs **2.9 s** | | yes |

Caveat for stream mode on real ports: raw bytes are scanned for the interrupt character (0x03) by the ESP32 stdin path, so the receiver **must** call `micropython.kbd_intr(-1)` (verified to exist) and restore it; with a stop-and-wait ack per block the host never sends while the device is writing flash, so UART RX buffers cannot overflow. This was not testable here (section 10).

---

## 6. Target design (board file layer)

### 6.1 Architecture

* **One long-lived `BoardSession` per selected port**, a helper process (Python, pyserial; either pinned `mpremote.transport_serial.SerialTransport` or a vendored ~300-line raw-REPL client) driven by the extension over **line-delimited JSON on stdin/stdout** (no shell, argv array, `windowsHide`, UTF-8 forced). Operations are queued FIFO with coalescing (latest content per path wins), explicit cancel (Ctrl-C + resync), per-op timeouts proportional to size, and a generation counter so stale results never overwrite newer UI state.
* The session owns the port; REPL/Run share it (`02-repl-run.md` decides how: either the terminal is a Pseudoterminal bridged to the session, or the session `release()`s the port on demand). FS operations need the raw REPL, therefore **they interrupt a running program** (Ctrl-C burst) - the UI must say so once ("Stop the running program to sync?") and remember the answer; a soft reset is *not* required for FS work (`enter_raw_repl(soft_reset=False)`), which keeps `boot.py` side effects and the running state out of the loop.
* Interrupt strategy for classroom robustness: Ctrl-C burst (e.g. 3 x 50 ms) -> if no prompt in 2 s -> RTS/DTR reset pulse + Ctrl-C burst -> error with advice (program swallowing KeyboardInterrupt with a bare `except:` or `kbd_intr(-1)`).
* Never use time-based caches for correctness. Listing results carry a generation; any mutating op bumps it; Refresh always hits the device.

### 6.2 Enumerating the device FS (tested)

Use an on-device snippet via `exec`, one JSON object per line, iterative DFS (no recursion depth/RAM issues), handling 3- and 4-tuple `ilistdir`, stat errors, mount points. Verified on MicroPython 1.29.0 with names containing spaces, double spaces, leading/trailing spaces, `'`, `"`, `\`, newline, tab, emoji, CJK, 100 kB binary, empty dir, symlink: 25/25 entries parsed, sizes exact (Appendix B.1). `fs ls`/`fs tree` are rejected as machine interfaces (headers, `-v` default, sorted, no mtime, no dir marker, locale/glyph/CRLF dependent, one launch per call). Mount points: also emit `vfs.mount()` (1.19+) and let the plan skip non-root mounts (e.g. `/sd`) unless the user opts in. Emit `os.statvfs('/')` for free space.

### 6.3 Comparing: size first, sha256 second, base for direction

* Local side: stream sha256 in Node (`crypto`); also a **line-ending-normalised** hash for text types (`.py .json .txt .csv`) so Windows `autocrlf` checkouts do not look "changed" forever.
* Board side: after the listing, hash only files whose size equals the local size, in **one** exec (Appendix B.2: `readinto` into a 1 KiB buffer, `hashlib.sha256`, `binascii.hexlify`; verified identical to host hashes incl. empty and 100 kB binary). Device lacking `hashlib` -> report `h:null`, fall back to size + "unknown" (never assume equal). **Do not use mtime**: littlefs on boards without a set RTC stores boot-relative or zero times [I]; it may be displayed, never compared.
* Names are compared NFC-normalised; refuse/flag case-insensitive collisions when the local FS is case-insensitive.

### 6.4 Sync state and the decision table

State file (per workspace *and* board): `{ boardId: machine.unique_id() hex + sys.implementation, files: { "<rel posix path>": { sha256, size, syncedAt } } }`, no absolute paths, auto-added to `.gitignore`. A different `boardId` means a new baseline (first-sync dialog), not a silent continuation.

| Local vs base | Board vs base | Decision (default) |
|---|---|---|
| = (identical to board) | | in sync; refresh base |
| changed | unchanged | **upload** |
| unchanged | changed | **download** (offer diff) |
| changed | changed (different) | **conflict**: keep local / keep board / open diff |
| exists | missing, base exists | board lost it (program/other tool) -> ask, default re-upload |
| missing, base exists | exists | local deletion -> **ask, never auto-delete the board file** |
| exists, no base | missing | new local -> upload |
| missing, no base | exists | board-only -> list; download on request |
| exists both, no base, differ | | conflict (first-sync dialog offers "local wins" for the usual "deploy my project" case) |

Prototype run over a 23-file fixture with 3 deliberate differences produced exactly: 21 same, upload `main.py` (same size, different content - **size-only would miss it**), upload `new_local.py`, ask about `tools.py`.

### 6.5 Triggers

* **On save (autosync):** debounce 300-500 ms, coalesce per path, upload only if hash differs from base/board, never block the UI, status bar shows queued/uploading/failed with retry. Default **ON** for classroom use but only for files inside the project and not ignored; first use of a workspace shows a one-time "Enable board sync for this folder?" instead of the hidden "Initialize" step (initialisation becomes implicit and visible).
* **Workspace events:** `workspace.onDidRenameFiles` -> offer `os.rename` on the board (instead of delete+upload); `onDidDeleteFiles` / `onDidCreateFiles` and a content `FileSystemWatcher` (git checkout, copy-in) only mark items *pending* in the Sync view. **Deletes are never propagated automatically**; an opt-in setting may enable "propagate deletes" with backup.
* **Before Run:** the Run action calls `ensureUploaded(currentFile)` and awaits it, then runs the *local* file (`exec` of its source, or import from the uploaded copy), fixing the save/upload/run race (FS-09).
* **Buttons** (Upload all / Download all / Clear) always open the preview first.

### 6.6 Making mirroring safe

1. **Plan -> preview -> apply.** Every bulk action builds the plan above and shows a TreeView with checkboxes grouped Upload / Download / Delete on board / Delete locally / Conflicts, with counts and sizes and a "Dry run" label; nothing runs until Apply. Uploads that are pure additions may skip the preview after the first use.
2. **Deletes:** modal listing the exact paths, "type DELETE", default = only selected items; board deletes first snapshot to `.mpy-workbench/backups/<ts>/` (size-capped); local deletes use `workspace.fs.delete({useTrash:true})`; Clear refuses mount points and `rootPath` itself, re-lists from the device (no cache) to verify.
3. **Overwrites:** local files that differ from base are never overwritten without the conflict dialog; overwritten local/board copies are saved to the backup ring first; dirty open editors are skipped.
4. **Atomic writes:** upload to `<dest>.mpytmp`, verify size+sha256 on-device, then `os.rename` (atomic on littlefs; on FAT remove-then-rename, accepting a tiny window); orphan `.mpytmp` files are cleaned at session start; pre-check `statvfs` free space with margin.
5. **Parent directories** come from the plan (`mkdirs` for the missing set discovered in the listing), never from try-and-fail.
6. **Errors are results, not logs:** per-item outcome list, final summary ("18 uploaded, 2 failed - details"), manifest/base updated per successful item only.
7. **Protect the dev environment:** auto-exclude any directory containing `pyvenv.cfg`, `.venv/`, `venv/`, `.git/`, `node_modules/`, `__pycache__/`, editor/stub folders produced for the linter (coordinate with the linter design), `*.pyc`, `.DS_Store`, `Thumbs.db`, `.mpy-workbench/`.

### 6.7 Ignore rules

Use the `ignore` npm package (real gitignore semantics: negation, anchoring, dir-only patterns, case option) with root `.mpyignore` (documented) plus built-ins from 6.6.7; read the legacy `.mpy-workbench/.mpyignore` as a fallback. One matcher instance shared by autosave, plan building, the local/board trees and uploads of folders; board entries are never hidden by it (show them dimmed so students see what is on the board).

### 6.8 Paths

Internal representation: workspace-relative **POSIX** strings; device paths absolute, `/`-separated. Conversion only at the edges: `toPosix = p.split(path.sep).join('/')` (not a regex), `fromPosix = path.join(ws, ...rel.split('/'))`. `rootPath`: validate and normalise on read (leading `/`, no trailing `/`, no `..`), apply it uniformly (including Upload Active File and Run). Reject or sanitise device names containing `\`, `..`, drive letters or Windows-reserved names before writing locally. Unit-test with `path.win32`/`path.posix` injected so Windows behaviour is tested on macOS CI.

### 6.9 Large files, slow links, timeouts

Default transfer = base64 in 1-4 KiB execs (works everywhere); after a one-time self-test on the connected board (send all 256 byte values, compare hash) enable **acked streaming** (kbd_intr off, 1-4 KiB blocks, 5 s ack timeout, restore `kbd_intr(3)` in `finally`). Progress by bytes, cancellable, timeout = size / 2 KB/s + 10 s. Remove the `baudRate` setting: REPL baud is fixed by firmware on UART consoles and irrelevant on native USB. Typical re-sync of an unchanged project = listing + one hash batch (2 round trips) instead of 33 process launches.

### 6.10 UI mapping (keep the layout the user likes)

Files view (board tree, built from the JSON listing, with status icons: in sync / local changed / board changed / conflict / board-only / local-only, replacing the dead Δ ? badges), Board Actions, Sync utilities (Autosync toggle, Upload all, Download all, Clear Device Files - all via preview). Restore the lost Files-view context menu (new file/folder, rename, delete from board, delete board+local with trash, sync this file either way, open local / open board version, **compare local vs board** via a read-only `mpy-board:` content provider + `vscode.diff`). Declare every command and view in the manifest and add a CI check that declared == registered.

---

## 7. Requirements (testable)

**Correctness**
- R-FS-01 Device enumeration uses a structured on-device snippet; no parsing of `fs ls`/`fs tree` text anywhere.
- R-FS-02 Listing round-trips names containing space, double space, leading/trailing space, quote, backslash, newline, tab, emoji, CJK, `tree`, `ls`, leading dot, `.mpy`, no extension, empty directory (automated test with the fake board).
- R-FS-03 No code path may call or depend on `fs stat`, `fs mv`, `fs mkdir -p`; existence/stat/rename use snippets; CI greps for them.
- R-FS-04 `exists()` returns false for a non-existent path and true for dirs and files (test).
- R-FS-05 Compare = size, then sha256 for equal sizes; same-size content change is detected (test).
- R-FS-06 Three-way decisions per 6.4, including both-changed conflicts and "deleted locally since last sync".

**Safety**
- R-FS-07 No operation deletes or overwrites a board or local file without it being in a previewed plan the user applied (exceptions: pure additions after first use).
- R-FS-08 Deletes are never auto-propagated; bulk delete requires typed confirmation and a backup is taken first.
- R-FS-09 Uploads are atomic (temp + verify + rename); an interrupted upload leaves the previous file intact; orphan temp files are cleaned.
- R-FS-10 Free-space check before upload; clear error instead of a truncated file.
- R-FS-11 Download never overwrites a locally changed file without conflict resolution; open dirty editors are skipped; overwritten files are backed up.
- R-FS-12 Clear Device Files re-lists from the device, reports exact results, refuses mount points and `rootPath` itself.
- R-FS-13 Every bulk operation ends with a per-item result summary; failures are never reported as success.

**Triggers / consistency**
- R-FS-14 Autosync is debounced, coalesced per path, serialized, non-blocking, and reports failures in the status bar.
- R-FS-15 No hidden "initialize" prerequisite; first save in a new workspace asks once.
- R-FS-16 Run awaits any pending upload of the file it runs.
- R-FS-17 Explorer rename -> offered board rename; Explorer delete/create -> pending items, no auto delete.
- R-FS-18 Refresh always reads the device; listing generations prevent stale overwrites; tree never shows a partial parent (no FS-15 behaviour).

**Performance / robustness**
- R-FS-19 One connection per session; a sync of N unchanged files costs a constant number of round trips (listing + one hash batch).
- R-FS-20 Throughput on an emulated 115200 UART: >= 80 % of line rate in stream mode; base64 mode >= 1.1x `mpremote cp` on text and >= 2x on binary (measured 1.16x / 2.3x); benchmark in CI with the rig.
- R-FS-21 All ops have timeouts, are cancellable, and a cancelled op leaves the REPL usable.
- R-FS-22 Session survives unplug/replug with visible "Disconnected/Reconnecting" state.
- R-FS-23 The dev environment (`.venv`, `pyvenv.cfg` directories, stubs/typings, caches) can never be uploaded by default.

**Cross-platform**
- R-FS-24 No shell: `spawn(argv[])`, `windowsHide`, kill process tree on cancel.
- R-FS-25 All path conversions go through two tested helpers; `path.win32` test matrix (spaces, drive letters, UNC, `..`, reserved names, backslash in device names).
- R-FS-26 Line-ending-insensitive "unchanged" detection for text files; NFC name comparison; case-collision detection.
- R-FS-27 `rootPath` validated/normalised and honoured by every command.
- R-FS-28 State files contain no absolute paths and are git-ignored automatically.

**Manifest hygiene**
- R-FS-29 CI check: every declared command/view has a handler/provider and vice versa; menus reference only declared commands.

---

## 8. Fix-vs-rewrite verdict for the FS layer

Rewrite. The reasons are structural: the enumeration/stat/rename primitives are wrong by construction (no-op subcommands, scraped text), the process-per-operation model is the source of the slowness and races, the sync model has no state to build conflict handling on, ~40 % of the code is dead or unreachable, and `package.json` has drifted from the code. Reusable ideas: rootPath mapping, `.mpyignore` concept, incremental tree updates, autosync toggle + status bar, Initialize/Upload all/Download all/Clear vocabulary, mpremote's hash-skip idea (reimplemented), the decorations idea, the per-file context menu set that existed before `fbb4a16`.

## 9. Test plan

1. **Fake-board CI rig** (Appendix A): unix-port MicroPython behind a pty<->socket bridge for macOS/Linux CI; for Windows CI, a CPython-hosted fake raw-REPL server that executes our own snippets against a rooted `os` shim (the snippets are plain Python by design). Same JSON protocol tests on both.
2. **Unit tests:** path helpers with `path.win32`; ignore matcher table (including `*.py[cod]`, `.venv`, negation, case); decision table; NFC/case-collision; line-ending hashing.
3. **Golden listing test:** the nasty-names directory from section 6.2; assert exact round trip.
4. **Fault injection:** kill the bridge mid-upload (previous file intact, `.mpytmp` cleaned), full filesystem, read-only FS, device that ignores Ctrl-C, unplug during listing.
5. **Benchmark gate:** the section 5 strategy matrix on the throttled bridge.
6. **Manifest-consistency test** (R-FS-29).
7. **Hardware checklist (manual, class laptops):** CP2102 and native-USB boards, macOS + Windows, littlefs and FAT, boards with/without `hashlib`, with an SD card mounted, program using bare `except:`; verify stream-mode self-test, atomic rename on FAT, `kbd_intr`, DTR/RTS reset behaviour.

## 10. Open questions and risks

Questions: (1) Do the class firmwares include `hashlib` and `binascii`? (custom builds) (2) littlefs or FAT on their boards (rename-over-existing semantics, mtime)? (3) SD cards or other mounts in use? (4) Should autosync default to ON for the class, and is "board loses files when students rename" acceptable to handle via prompts? (5) Typical project size/file count (affects preview UX)? (6) Does the class use git on Windows (`autocrlf`)? (7) Preferred dependency: pinned mpremote internals vs vendored client? (8) Is it acceptable that FS sync interrupts a running program (and should Run/sync share one session)? 

Risks: stream mode untested on real UARTs (interrupt char, RX overflow) - mitigated by self-test + fallback; CP2102 DTR/RTS reset behaviour differs by OS; all rig timings are relative; unix-port vs ESP32 differences in errno/ilistdir; mpremote internal API drift if embedded; Windows behaviour is unexecuted in this analysis.

---

## Appendix A - the fake-board rig

(Abridged from the version actually run; the original also drains the pty before respawning.)

```python
# bridge.py MICROPYTHON_BIN SIMROOT PORT [BAUD]  (never touches a serial port)
import os, pty, socket, subprocess, sys, select, time, tty
MP, ROOT, PORT = sys.argv[1], os.path.realpath(sys.argv[2]), int(sys.argv[3])
BAUD = int(sys.argv[4]) if len(sys.argv) > 4 else 0
def throttle(n):
    if BAUD: time.sleep(n * 10.0 / BAUD + 0.002)
def spawn():
    master, slave = pty.openpty(); tty.setraw(slave)
    prof = '(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "%s") (subpath "/dev") (subpath "/private/var/folders"))' % ROOT
    p = subprocess.Popen(["sandbox-exec", "-p", prof, MP], stdin=slave, stdout=slave, stderr=slave, cwd=ROOT, close_fds=True, start_new_session=True)
    os.close(slave); return p, master
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(("127.0.0.1", PORT)); srv.listen(1)
while True:
    conn, _ = srv.accept(); p, master = spawn()
    try:
        while True:
            r, _, _ = select.select([conn, master], [], [], 0.2)
            if conn in r:
                d = conn.recv(4096)
                if not d: break
                throttle(len(d)); os.write(master, d)
            if master in r:
                try: d = os.read(master, 4096)
                except OSError: d = b""
                if d: throttle(len(d)); conn.sendall(d)
            if p.poll() is not None:               # unix port exits on raw-REPL Ctrl-D: emulate a soft reboot
                os.close(master); time.sleep(0.05); conn.sendall(b"soft reboot\r\n")
                p, master = spawn(); time.sleep(0.3); os.write(master, b"\x01")
    except (BrokenPipeError, ConnectionResetError): pass
    finally:
        try: p.kill()
        except Exception: pass
        try: os.close(master)
        except Exception: pass
        conn.close()
```
Use: `mpremote connect socket://127.0.0.1:PORT fs tree`. Old code was run by compiling a copy of `old/src` with `tsc` (outside `old/`), stubbing `vscode` (a permissive module that records `registerCommand`), patching `child_process.exec` to log every launch and strip the leading `/` of remote paths, and calling the real handlers (`syncBaseline`, `syncBaselineFromBoard`, `deleteAllBoard`, `onDidSaveTextDocument` listener).

## Appendix B - tested snippets

### B.1 Listing (JSON lines, iterative, any name)
```python
import os, json
def _ls(root):
    stack = [root]
    while stack:
        d = stack.pop()
        try: it = os.ilistdir(d)
        except OSError as e:
            print(json.dumps({"p": d, "err": str(e)})); continue
        for e in it:
            full = (d.rstrip("/") + "/" + e[0]) if d != "/" else "/" + e[0]
            if e[1] == 0x4000:
                print(json.dumps({"p": full, "k": "d"})); stack.append(full)
            else:
                try:
                    st = os.stat(full); print(json.dumps({"p": full, "k": "f", "s": st[6], "m": st[8]}))
                except OSError as ex: print(json.dumps({"p": full, "err": str(ex)}))
_ls("/")
```
### B.2 Hash batch
```python
import json
try: import hashlib
except ImportError: hashlib = None
try: from binascii import hexlify
except ImportError: from ubinascii import hexlify
def _sha(path, buf=memoryview(bytearray(1024))):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            n = f.readinto(buf)
            if not n: break
            h.update(buf[:n] if n != 1024 else buf)
    return hexlify(h.digest()).decode()
for p in PATHS:                      # PATHS = json list injected by the host
    try: print(json.dumps({"p": p, "h": _sha(p) if hashlib else None}))
    except Exception as e: print(json.dumps({"p": p, "err": str(e)}))
```
### B.3 Acked streaming upload (host side shown with mpremote's `SerialTransport`)
```python
def put_stream(t, tmp, data, blk=1024):
    n = len(data)
    t.exec_raw_no_follow("import sys, micropython\nmicropython.kbd_intr(-1)\nr=sys.stdin.buffer.read\nw=sys.stdout.write\n"
        "f=open(%r,'wb')\nn=%d\ntry:\n while n:\n  k=min(n,%d)\n  f.write(r(k)); n-=k\n  w('.')\nfinally:\n f.close(); micropython.kbd_intr(3)\n" % (tmp, n, blk))
    for i in range(0, n, blk):
        t.serial.write(data[i:i+blk]); assert t.serial.read(1) == b"."
    out, err = t.follow(timeout=10); assert not err
    # then: verify sha256 on device, os.rename(tmp, dest)
```
(`kbd_intr` lines added to the tested version for real-port safety; the unix port does not scan stdin so the benchmark did not need them.)

## Appendix C - real `mpremote 1.29.0 fs tree` output used for the parser comparison

```
tree :
:/            <- the rig prints the sandbox path here; a board prints ":/"
├── .hidden
├── README
├── boot.py
├── café.py
├── config
├── data.bin
├── double  space.py
├── empty.txt
├── emptydir
├── lib
│   ├── a_empty_dir
│   ├── bar.mpy
│   ├── foo.mpy
│   ├── umqtt
│   │   ├── robust.mpy
│   │   └── simple.mpy
│   └── v1.2
│       ├── x.py
│       └── y.py
├── main.py
├── my file.py
├── street.txt
├── streets
│   ├── a.py
│   └── b.py
├── tools.py
├── zz.d
│   ├── inner.py
│   └── inner2.py
└── 日本語.txt
```
Old parser result vs ground truth: `/config`, `/lib/bar.mpy`, `/lib/foo.mpy`, `/lib/umqtt/robust.mpy`, `/lib/umqtt/simple.mpy` -> dir (WRONG); `/street.txt`, `/streets`, `/streets/a.py`, `/streets/b.py` -> MISSING; `/a.py`, `/b.py` -> PHANTOM.

## Appendix D - cross-references

`02-repl-run.md` (Run/REPL, `fileExists` consequence, soft-reset on every launch), `05-cross-platform.md` (X-01 quoting, X-33 guard, X-60 mpremote contract mismatches: independently consistent with FS-04/05/13/18), `04-ui-inventory.md`, `06-ext-core.md`.
