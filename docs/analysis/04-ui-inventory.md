# 04 - UI inventory and feature specification of MPY Workbench 0.3.2

Scope: the complete user-facing surface of the old extension (`../mpy-workbench`) that the new
`mpy-upgrade` extension must preserve ("same functionality and sidebar options"), plus defects and a proposed manifest for the new one.
Audience: the developer who will build and test the new extension without being able to see the old UI.

Evidence legend used throughout:

| Tag | Meaning |
|---|---|
| **[E]** | I executed code and observed the result (compiled old source in a scratch dir, ran it against a stubbed `vscode` module and a fake `python -m mpremote` shim, or ran mpremote 1.29.0's own argument parser). No serial port and no real device were touched. |
| **[R]** | I read the code and believe it; not executed. |
| **[G]** | Established from git history of the old repo (read-only `git show`). |
| **[I]** | Inference from VS Code or OS behaviour that I could not run here (mostly Windows). Needs a Windows test. |

Citations are `file:line` relative to `mpy-workbench/` (`pkg:` = `package.json`, `ext:` = `src/extension.ts`).

---

## 1. Executive summary (the ten facts that matter most)

1. **Only 1 of 12 Files-view context-menu entries works.** `package.json` declares 33 commands; 10 are never registered anywhere (9 of them are wired into menus), so clicking
   Rename, New File Here, New Folder Here, Delete from Board, Delete from Board and Local, Sync File Local to Board, Sync File Board to Local or Open File from Local gives
   VS Code's "command not found" error (the 9th, New File (Board + Local), sits on an unreachable `!viewItem` menu). Only `mpyWorkbench.openFile` works. The implementations were deleted in commit `fbb4a16` (2026-02-12) while the declarations stayed. [E,G] (section 6.2)
2. **16 commands are registered but never declared** (so they are hidden from the palette), including `cancelAllTasks` (target of a status-bar button), `rebuildManifest`, `debugTreeParsing`, and an entire "Local files" command set for a view (`mpyWorkbenchLocalFilesView`) that is created in code but not declared in `package.json` (on VS Code 1.141 this also raises a red "No view is registered with id" toast at every activation, per `06-ext-core.md`). [E for the counts] (section 6.3)
3. **The `.venv` complaint is reproduced.** Even when `mpyWorkbench.pythonPath` points at a venv Python that has mpremote installed, `getPythonPath()` silently throws that choice away and returns bare `python3`, because
   `validatePythonPath` checks for a *bare `mpremote` on PATH* (`pythonInterpreter.ts:235`) instead of `<python> -m mpremote`. The error text is `spawn mpremote ENOENT`, which does not match the "not found" check on line 242, so no install prompt is shown either. [E] (section 14.1)
4. **There is no IntelliSense/linting feature at all** in the old extension: no stubs, no `python.analysis.*`, no `pyrightconfig.json`, nothing (grep over `src/`, `package.json`, README is empty). The "linter does not know my firmware libraries" complaint is a missing feature, not a bug. [E]
5. **Windows is structurally unsupported in the current source.** Every mpremote call and both terminals are built as POSIX single-quoted command lines (`src/mpremote.ts:7-9,170-181`, `src/mpremoteCommands.ts:8-17`), which `cmd.exe` and PowerShell cannot execute. The *shipped* `.vsix` (older launch code) used bare `mpremote "arg"` and could work on Windows if mpremote was on PATH, so the repo source is a Windows regression. [R,I,E for the diff]
6. **Stop / Interrupt send `echo -e '\x03\x03' > <port>`** (`mpremoteCommands.ts:392,453,484`). On macOS `/bin/sh` that writes the bytes `2d 65 20 03 03 0a` (a literal `-e `) [E]; on Windows it is nonsense; both paths then report "Interrupt sent via echo" as success. And with no port selected the buttons fail with **no message at all** (error only goes to `console.error`, `mpremoteCommands.ts:114-117`). [E for macOS, R,I otherwise]
7. **"Soft Reset" does a hard reset** when the REPL is not open: it runs `mpremote ... reset`, which in mpremote 1.29 is `machine.reset()` ("hard reset the device"); the real soft reset is the separate `soft-reset` command. [E, mpremote source `main.py:407-412`, `commands.py:534`]
8. **Files view correctness is heuristic.** The board tree is parsed from `mpremote fs tree` text; any file or folder whose name contains "tree" is dropped, extension-less files are shown as folders. Reproduced with the real compiled code against canned `fs tree` output: `tree.py` and `lib/tree_utils.py` vanish, `data` (a file) shows as a folder. [E]
9. **The "auto-mirror" the user likes is implemented by:** auto-upload on save (`onDidSaveTextDocument`, `ext:1093-1128`), "open from board downloads into the workspace at the same relative path" (`ext:924-973`), and Upload all / Download all. It is **gated behind a hidden "Initialize Workspace" step** (`.mpy-workbench/esp32sync.json` must exist) and **autosync defaults to OFF**; the toggle shows "ENABLED" even when the gate makes it a no-op. [R]
10. **"Run file" runs the board's copy, via `import`, when the file exists on the board** (`mpremoteCommands.ts:196-208`), so with AutoSync off it can run stale code, and `if __name__ == "__main__":` blocks do not execute (module name is not `__main__`). It also types the next command into the previous run's terminal if the previous run is still going. [R]

Counts: 33 declared commands, 39 registered, 23 both, 10 declared-only, 16 registered-only; 12 `view/item/context` entries (1 works, 3 can never display); 8 `view/title` buttons (all registered); 10 settings (1 never read, 1 broken, 2 reachable only through a palette-only command, 1 ineffective for venvs); 1 context key; 2 status-bar items; 0 keybindings; 0 `commandPalette` filters.

---

## 2. Provenance: which build is "the old extension"

| Artifact | Facts |
|---|---|
| Repo HEAD | `7cb90c7` (2026-04-04) "Refactor mpremote command execution to use Python interpreter". `package.json` version is still `0.3.2` (set in `2a737da`, 2026-02-12). [G] |
| `dist/` vs `src/` | I compiled `src/` with the repo's own `tsc` into the scratchpad: all 17 emitted `.js` files are **byte-identical** to the committed `dist/*.js`. So `dist` is a faithful build of `src`. `dist/pathUtils.js`, `dist/pathUtils.test.js` have no source (stale leftovers). [E] |
| `mpy-workbench-0.3.2.vsix` (committed in repo) | `package.json` **identical** to the repo. 17 of 19 `dist` JS files identical; `mpremote.js` and `mpremoteCommands.js` differ: the vsix launches bare `mpremote` from PATH with `"..."` quoting (no Python-interpreter lookup); the repo launches `'<python>' -m mpremote '...'`. The vsix also contains a stale 10 MB macOS Python 3.9.6 `.venv/` (no `.vscodeignore` rule), and `scripts/mpremote_tool.py` which the repo lacks. [E] |
| README GIFs (`assets/*.gif`) | Show an **older** UI (extracted frames): Sync section had "Check for differences", "Sync changed Files Local to Board / Board to Local", "Delete ALL files on Board"; the workspace folder was `.mpystudio`; REPL output came from pyserial miniterm ("--- Miniterm on /dev/cu.usbmodem101 115200,8,N,1 ---", "raw REPL; CTRL-B to exit >OK0"); the Files view showed local-only files with a `?` badge. "Check for differences" and the sync-changed commands were removed in `9b302fd` (0.3.1). [E,G] |
| `fbb4a16` (2026-02-12) | "Add local files tree view and upload functionality": removed the registrations of 9 commands (list in 6.2) but left `package.json` declarations and menu entries. Reference implementations: `git show fbb4a16^:src/extension.ts` lines 439-537, 970-1032, 1116-1210 (copy saved in scratchpad as `extension_before_fbb4a16.ts`). [G] |
| `CHANGELOG.md` | Last entry 0.2.62; labels it mentions ("Run Active File", "Check for differences (local vs board)", "Delete ALL files on Board") are the old labels. [R] |

Consequence for the fix-vs-rewrite decision: the UI *spec* below is the union of (a) what is live, (b) what `package.json`/menus promise, (c) what git history shows was intended. The new extension should implement (b)+(c) properly, not only (a).

---

## 3. Package-level manifest facts

| Item | Value (cite) | Notes |
|---|---|---|
| id / publisher / name | `DanielBucam.mpy-workbench`, display "MPY Workbench", v0.3.2 (`pkg:2-8`) | The id is **hard-coded in code**: `esp32Fs.ts:257` (`getExtension("DanielBucam.mpy-workbench")!.extensionUri` for the folder/file icons) and `pyraw.ts:12`. A fork under a different id makes every Files-view node throw at `getTreeItem` (non-null assertion on `undefined`) and the tree renders empty. [R] |
| `engines.vscode` | `^1.84.0` (`pkg:9`) | |
| `activationEvents` | `["onLanguage:python"]` (`pkg:24-26`) | With engine >= 1.74, contributed views and commands also activate implicitly, but status-bar items, the save-listener and watchers only exist after activation (any `.py` opened, or a view/command used). |
| `extensionKind` | `["workspace"]` (`pkg:13`) | Serial access therefore only works when the workspace is local (not Remote-SSH/Codespaces); fine for the class. |
| `capabilities.untrustedWorkspaces.supported` | `true` (`pkg:14-18`) | Wrong for this extension: it executes an interpreter path taken from workspace settings (`mpyWorkbench.pythonPath`) and shell-interpolates `mpyWorkbench.connect` unquoted in `echo ... > ${devicePort}` (`mpremoteCommands.ts:392,453,484`). A malicious `.vscode/settings.json` could run commands when "Stop" is clicked. [R] Should be `"limited"` with `restrictedConfigurations`. |
| Duplicate key | `"extensionPack": []` appears twice (`pkg:12,19`) | harmless sloppiness |
| `contributes.css` | `["./media/esp32fs.css"]` (`pkg:61-63`) | **Not a VS Code contribution point; ignored.** The CSS (button-styled "Select Serial Port" row) never applies; the `"no-port"` tree node that used it is never returned (`esp32Fs.ts:28-41` vs `:119-120`). [R] |
| `contributes.customEditors` | `[]` (`pkg:60`) | empty |
| keybindings | none | |
| `commandPalette` menu | none | every declared command shows in the palette, including ones that need a tree-node argument (`openFile`, `setPort`, `runFromView`). |
| categories | Programming Languages, Debuggers | |
| icons | `media/logo.png` 1024x1024 1.4 MB; `media/activitybar.svg` (chip glyph); `media/mpy-studio-logo.svg` is a **0-byte file**; `media/folder.svg`, `media/file.svg` (Feather-style outline icons, `currentColor`), `media/trash-red.svg` (`#ff3b30`) | Tree icons are fixed SVGs, not the user's file-icon theme. |

---

## 4. Visual and interaction layout

### 4.1 Activity bar and container

* One activity-bar container, id `mpyWorkbenchFs`, title **"MPY Workbench"**, icon `./media/activitybar.svg` (a 24x24 microcontroller glyph: rounded square body, three pins left, three right, inner square) (`pkg:51-59`).
* Three views stacked in this order (`pkg:64-82`): **Files** (`mpyWorkbenchFsView`), **Board Actions** (`mpyWorkbenchActionsView`), **Sync utilities** (`mpyWorkbenchSyncView`). (A fourth, `mpyWorkbenchLocalFilesView`, is created in `ext:197` but not declared in `contributes.views`, so it never appears. Per the sibling analysis `06-ext-core.md` (which read the bundled source of VS Code 1.141), the main thread answers an unknown tree-view id with an error notification "No view is registered with id: mpyWorkbenchLocalFilesView", so **every activation shows a red error toast** while `activate()` itself does not throw. [R for the code, VSC-source for the toast via 06-ext-core.md section on the Local Files view; I did not run VS Code])
* Only the Files view has welcome content. Board Actions and Sync utilities always list their rows, whether or not a port or workspace exists.

### 4.2 ASCII mock-ups (state: nothing selected yet; this matches the README GIF frame `run-file.gif`)

```
 ACTIVITY BAR          SIDE BAR ("MPY WORKBENCH")
 [chip icon]           ----------------------------------------------------
                       v FILES                                  [refresh] [plug]
                           No serial port selected.

                           [        Select Serial Port        ]   <- welcome button
                                                                     (command:mpyWorkbench.pickPort)
                       v BOARD ACTIONS                          [play] [terminal] [pause]
                           > Run file                   (green play)
                           > Open Repl                  (terminal)
                           > Stop                       (red stop square)
                           > Soft Reset                 (blue restart arrow)
                           > Interrupt                  (yellow zap)
                       v SYNC UTILITIES                         [cloud-up] [cloud-down] [trash-red]
                           > Initialize Workspace       (folder-opened)      <- becomes "De-initialize Workspace"
                           > Autosync: Off              (sync)               <- "Autosync: On" when enabled
                           > Upload all files (Local -> Board)   (cloud-upload)
                           > Download all files (Board -> Local) (cloud-download)
                           > Clear Device Files         (red trash)
```

View-title (inline) buttons, left to right, from `pkg:252-293` (`navigation@N` ordering):

| View | Buttons (icon, command actually bound) |
|---|---|
| Files | `$(refresh)` -> `mpyWorkbench.refresh` @0; `$(plug)` -> `mpyWorkbench.pickPort` @1 |
| Board Actions | `$(play)` -> `runActiveFileFromView` @0; `$(terminal)` -> `openReplFromView` @1; `$(debug-pause)` -> `serialSendCtrlC` @2. **Stop and Soft Reset have no title button.** |
| Sync utilities | `$(cloud-upload)` -> `syncBaselineFromView` @0; `$(cloud-download)` -> `syncBaselineFromBoardFromView` @1; red trash svg -> `deleteAllBoardFromView` @9 |

Tooltips of these buttons are the command *titles*, which carry the clutter described in 12 (e.g. "MPY Workbench: Run file (View)").

### 4.3 State: port selected, board listing loaded

```
 v FILES                                               [refresh] [plug]
     v lib                       (folder.svg)
         sensor.py               (file.svg)     click = mpyWorkbench.openFile
     boot.py
     main.py
```

* Folders first, then files, each group `localeCompare` sorted (`esp32Fs.ts:234`). Root = `mpyWorkbench.rootPath` (default `/`).
* Left-click a **file** runs `mpyWorkbench.openFile` with the node (`esp32Fs.ts:54-58`). Left-click a folder only expands (Collapsed state).
* Right-click menu (as declared; only the starred item works) - **file node**:
  `0_create` New File Here, New Folder Here | `1_open` *Open File from board*, Open File from Local (default) | `2_edit` Rename File/Folder | `2_sync` Sync File Local -> Board, Sync File Board -> Local | `3_delete` Delete from Board, Delete from Board and Local.
  **dir node:** New File Here, New Folder Here, Rename, Delete from Board, Delete from Board and Local. (`pkg:294-355`)
* The three `view == mpyWorkbenchFsView && !viewItem` entries (New File (Board + Local), New File Here, New Folder Here) target "right-click on empty space"; VS Code `view/item/context` menus only fire on items, and every node has a `contextValue`, so **these three can never be displayed**. [R]

### 4.4 What the README GIFs add (older UI)

`run-file.gif` (83 frames): fresh workspace -> "Select Serial Port" welcome button -> `main.py` appears in Files -> click "Run Active File" -> bottom panel terminal "ESP32 REPL" shows miniterm banner, `raw REPL; CTRL-B to exit`, `>OK`, program output (`0 .. 100`). `sync new files.gif` (144 frames): New file in Files view shows a `?` badge (local only) -> Sync utilities buttons -> toast "Board: Sync Files Local -> Board: Uploading (new) new_file.py (1/1)" -> "Check for differences" toast "Board: Diff check complete (0 changed, 2 local-only, 2 total flagged...)"; Explorer shows `.mpystudio/`, `esp32sync.json`. The `?`/`Δ` badges still exist as code (`decorations.ts`) but nothing feeds them any more (section 9.4).

---

## 5. Views and tree items

| View id | Name | `when` | Provider | Welcome content | Items |
|---|---|---|---|---|---|
| `mpyWorkbenchFsView` | Files | none (always) | `Esp32Tree` (`esp32Fs.ts`), `createTreeView` at `ext:191` | `"No serial port selected.\n\n[Select Serial Port](command:mpyWorkbench.pickPort)"` when `!mpyWorkbench.hasPort` (`pkg:44-50`) | Board directory tree (below) |
| `mpyWorkbenchActionsView` | Board Actions | none | `ActionsTree` (`actions.ts`), `ext:193` | none | 5 flat rows (below) |
| `mpyWorkbenchSyncView` | Sync utilities | none | `SyncTree` (`syncView.ts`), `ext:195` | none | 5 flat rows (below) |
| `mpyWorkbenchLocalFilesView` | (undeclared) | n/a | `LocalFilesTree` (`localFilesView.ts`), `ext:197` | n/a | never rendered: no `contributes.views` entry; causes an error toast at each activation on current VS Code (see 4.1) |

### 5.1 Files tree nodes (`esp32Fs.ts`)

| Property | Value |
|---|---|
| Label | entry name |
| Collapsible | dirs `Collapsed`, files `None` |
| `contextValue` | `"file"` or `"dir"` (`:49`) |
| `resourceUri` | `esp32:<devicePath>` custom scheme (`:50`); only used so `Esp32DecorationProvider` can badge it |
| Icon | `media/folder.svg` / `media/file.svg` (`:51-53`) (not theme-aware) |
| Command (files only) | `mpyWorkbench.openFile` with `[node]` |
| Tooltip | `'?'` only for `isLocalOnly` nodes (which are never created in practice) |
| Empty states | no port or `auto`: returns `[]` (`:118-121`) so welcome shows. Port set but listing fails or is empty: **empty view, no message**; toast `ESP32 list error at <path>: <msg>` only if the message does not contain `"serial port"` or `"auto"` (`:240-247`), i.e. some real errors are swallowed silently. |
| Listing path | `executeCommand("mpyWorkbench.autoSuspendLs", path)` (`:134`) -> `withAutoSuspend(lsTyped)`; `lsTyped` populates a 30 s whole-board cache from one `mpremote fs tree` and filters per directory (`mpremote.ts:259-360,772-847`). Ignore rules from `.mpy-workbench/.mpyignore` are applied (`:146-165`). Local-only injection (`:168-232`) reads decoration sets that are always empty. |
| Cache | node cache per directory (`_nodeCache`, `:63`), plus the mpremote 30 s cache that is **not** invalidated by the Refresh button and is **not keyed by port** (switching boards within 30 s shows the previous board's tree). [R] |

### 5.2 Board Actions rows (`actions.ts:54-62`)

All rows route through the trampoline `mpyWorkbench.runFromView(<commandId>)` (`actions.ts:28`), which sets `skipIdleOnce` then executes the command and shows `Board command failed: <msg>` on exception (`ext:1079-1085`).

| id | Label | Icon (colour) | Command | Behaviour summary |
|---|---|---|---|---|
| `runActive` | Run file | `play` (charts.green) | `mpyWorkbench.runActiveFile` | 6.5.1 |
| `openRepl` | Open Repl | `terminal` | `mpyWorkbench.openRepl` | 6.5.2 |
| `stop` | Stop | `debug-stop` (charts.red) | `mpyWorkbench.stop` | 6.5.3 |
| `softReset` | Soft Reset | `debug-restart` (charts.blue) | `mpyWorkbench.softReset` | 6.5.4 |
| `sendCtrlC` | Interrupt | `zap` (charts.yellow) | `mpyWorkbench.serialSendCtrlC` | 6.5.3 |

Dead icon branches for ids that no longer exist: `killUsers`, `cancelOps`, `deleteAll`, `syncAll`, `syncCurrent` (`actions.ts:40-50`). `contextValue = "action"` is unused by any menu.

### 5.3 Sync utilities rows (`syncView.ts:34-60`)

Labels are computed on every refresh by *synchronously reading* `.mpy-workbench/esp32sync.json` and `config.json` (`fs.existsSync/readFileSync`).

| id | Label (dynamic) | Icon | Command | Notes |
|---|---|---|---|---|
| `initializeWorkspace` | `Initialize Workspace` / `De-initialize Workspace` (if `esp32sync.json` exists) | `folder-opened` | via `runFromView` -> `mpyWorkbench.initializeWorkspace` | 6.5.5 |
| `toggleAutoSync` | `Autosync: On` / `Autosync: Off` | `sync` | **direct** `mpyWorkbench.toggleWorkspaceAutoSync` (not via trampoline) | 6.5.6 |
| `baseline` | `Upload all files (Local -> Board)` | `cloud-upload` | via `runFromView` -> `syncBaseline` | 6.5.7 |
| `baselineFromBoard` | `Download all files (Board -> Local)` | `cloud-download` | via `runFromView` -> `syncBaselineFromBoard` | 6.5.8 |
| `deleteAllBoard` | `Clear Device Files` | `trash` (charts.red) | via `runFromView` -> `deleteAllBoard` | 6.5.9 |

The view refreshes only when `initializeWorkspace` or `toggleWorkspaceAutoSync` call `syncTree.refreshTree()`; it does not react to config or manifest file changes.

---

## 6. Command inventory

### 6.1 Declared and registered (23). "Where" = palette (P), view title (T), item context (C), status bar (S), tree row (R).

All titles in `package.json` are prefixed `MPY Workbench: ` (omitted below). Line refs: `pkg` = declaration, `ext` unless noted = registration.

| Command id | Title | Icon | Where | pkg / reg | What it does (one line; details in 6.5) |
|---|---|---|---|---|---|
| `mpyWorkbench.refresh` | Refresh | `$(refresh)` | P, T (Files @0) | 85 / ext:333 | clear node cache, force re-list, refresh tree (does not clear the 30 s mpremote cache) |
| `mpyWorkbench.initializeWorkspace` | Initialize Workspace | - | P, R | 90 / ext:350 | toggle: create `.mpy-workbench/` (+`.mpyignore`, empty `esp32sync.json`) or modal-confirm and delete it |
| `mpyWorkbench.openFile` | Open File from board | - | P (needs arg), C(file), tree click | 94 / ext:924 | open local copy, downloading from board first if absent |
| `mpyWorkbench.uploadActiveFile` | Upload Active File | - | P only | 98 / ext:895 | save, ignore-check, `fs cp -f` to `"/" + relpath` (ignores `rootPath`) |
| `mpyWorkbench.pickPort` | Select Serial Port | `$(plug)` | P, T (Files @1), welcome link | 122 / ext:449 | QuickPick of `mpremote connect list`, writes global `connect` |
| `mpyWorkbench.setPort` | Use This Port | - | P (needs arg) | 132 / ext:549 | writes global `connect` to the given string |
| `mpyWorkbench.mkdir` | New Folder | - | P only | 136 / ext:999 | InputBox name, `fs mkdir` under node or `/` (creates on board only) |
| `mpyWorkbench.openSerial` | Open Serial Monitor | `$(terminal)` | P only | 140 / ext:870 | `openReplTerminal`: handshake (hard reset + `ls /`) then REPL terminal |
| `mpyWorkbench.openRepl` | Open REPL | `$(terminal)` | P, R | 145 / ext:871 | create/reuse terminal "ESP32 REPL" (no handshake) |
| `mpyWorkbench.runActiveFile` | Run file | `$(play)` | P, R | 150 / ext:923 | save, build run/import command, send to terminal "ESP32 Run File" |
| `mpyWorkbench.stop` | Stop (Ctrl-C/A/D) | `$(debug-stop)` | P, R | 155 / ext:467 | interrupt + soft reset via raw `echo > port` |
| `mpyWorkbench.softReset` | Soft Reset (Ctrl-D) | `$(debug-restart)` | P, R | 160 / ext:468 | via REPL terminal keystrokes if open, else `mpremote reset` (hard) |
| `mpyWorkbench.syncBaseline` | Sync all files (Local -> Board) | `$(cloud-upload)` | P, R | 165 / ext:558 | upload every non-ignored file |
| `mpyWorkbench.syncBaselineFromBoard` | Sync all files (Board -> Local) | `$(cloud-download)` | P, R | 170 / ext:831 | download every non-ignored board file, overwriting local |
| `mpyWorkbench.serialSendCtrlC` | Interrupt (Ctrl-C, Ctrl-B) | `$(debug-pause)` | P, T (Actions @2), R | 175 / ext:466 | raw `echo > port` of two Ctrl-C |
| `mpyWorkbench.deleteAllBoard` | Clear Device Files | red trash svg | P, R | 231 / ext:1007 | modal, then `fs rm -r` of every root entry |
| `mpyWorkbench.toggleWorkspaceAutoSync` | Toggle workspace Auto-Sync on Save | - | P, R, **S** (status bar) | 247 / ext:1137 | flip `autoSyncOnSave` in `.mpy-workbench/config.json` |
| `mpyWorkbench.runFromView` | Run Command (View Wrapper) | - | P (junk), R trampoline | 207 / ext:1079 | `skipIdleOnce = true` then `executeCommand(arg0, ...rest)` |
| `mpyWorkbench.syncBaselineFromView` | Sync all files (Local -> Board) (View) | `$(cloud-upload)` | T (Sync @0) | 211 / ext:1086 | `setSkipIdleOnce(); executeCommand("syncBaseline")` |
| `mpyWorkbench.syncBaselineFromBoardFromView` | ... (Board -> Local) (View) | `$(cloud-download)` | T (Sync @1) | 216 / ext:1087 | same pattern |
| `mpyWorkbench.runActiveFileFromView` | Run file (View) | `$(play)` | T (Actions @0) | 221 / ext:1088 | same pattern |
| `mpyWorkbench.openReplFromView` | Open REPL (View) | `$(terminal)` | T (Actions @1) | 226 / ext:1089 | same pattern |
| `mpyWorkbench.deleteAllBoardFromView` | Clear Device Files (View) | red trash svg | T (Sync @9) | 239 / ext:1075 | `executeCommand("deleteAllBoard")` (no skip flag) |

### 6.2 Declared but NOT registered (10) - broken as shipped

Verified by script: set difference of `package.json` command ids and live `registerCommand` ids in `ext` (excluding the commented block at `ext:1156-1185`). [E]

| Command id | Title | Where it appears | Intended behaviour (from `git show fbb4a16^:src/extension.ts`) [G] |
|---|---|---|---|
| `mpyWorkbench.newFileInTree` | New File Here | C (file, dir), C(`!viewItem`, dead) | InputBox "New file name (in <dir>)" (validate: non-empty, no trailing `/` or `\`); create the file **locally** (mkdir -p parents) and `uploadReplacing` to the board at same relative path; toast "File created: <path>" or warning "File created locally but upload to board failed"; then `mpyWorkbench.refresh` (`:1116-1149`) |
| `mpyWorkbench.newFolderInTree` | New Folder Here | C (file, dir), C(`!viewItem`, dead) | InputBox; `mkdir` on board, then `fs.mkdir -p` locally; toast "Folder created"; refresh (`:1150-1174`) |
| `mpyWorkbench.renameNode` | Rename File/Folder | C (file, dir) | InputBox prefilled (must differ); `mvOnDevice(old,new)` on board first (abort with error on failure), then best-effort `fs.rename` of the local copy; toast "Renamed: old -> new"; refresh (`:1175-1210`) |
| `mpyWorkbench.delete` | Delete from Board | C (file, dir) | modal "Delete <path> from board?" [Delete]; progress notification; `deleteAny` (`fs rm`, `-r` for dirs, manual recursive fallback); `tree.removeNode`; toast success/failure (`:970-995`; also implemented in dead `BoardOperations.delete`, `boardOperations.ts:526-550`) |
| `mpyWorkbench.deleteBoardAndLocal` | Delete from Board and Local | C (file, dir), red trash icon | modal "Delete <path> from board AND local workspace?"; same as above, then `fs.rm(abs,{recursive,force})` locally (`:996-1032`) |
| `mpyWorkbench.syncFileLocalToBoard` | Sync File Local -> Board | C (file) | resolve local path; if missing: modal "Local file not found... Download from board first?" [Download]; `cpToDevice`; toast "Synced local -> board: <rel>" (`:503-521`) |
| `mpyWorkbench.syncFileBoardToLocal` | Sync File Board -> Local | C (file) | `cpFromDevice`, toast "Synced board -> local", opens the file (`:522-537`) |
| `mpyWorkbench.openFileFromLocal` | Open File from Local (default) | C (file) | `fs.access` local copy, open preview; else error "File not found in local workspace: <rel>" (`:489-502`) |
| `mpyWorkbench.newFileBoardAndLocal` | New File (Board + Local) | C (`!viewItem`: dead) | InputBox "New file name (relative to project root)"; create empty local file (`wx`); open it; **on its first save upload to the board** unless ignored (one-shot `onDidSaveTextDocument`) (`:439-487`). This is the feature the README advertises ("Create a new file in the Files view and upload it to the board on first save"). |
| `mpyWorkbench.refreshPorts` | Refresh Ports | P only | never existed in any commit (`git log -S` finds nothing) [G]; `pickPort` already re-lists ports every time |

### 6.3 Registered but NOT declared (16) - not in palette, not in menus

| Command id | reg | Reachable from | Purpose / verdict |
|---|---|---|---|
| `mpyWorkbench.cancelAllTasks` | ext:432 | status-bar item "MPY: Cancel" (`ext:214-218`) | `mp.cancelAll()` (SIGKILL the one tracked child), reset op queue, toast "All tasks have been canceled" (always, even if nothing ran). Keep, but declare. |
| `mpyWorkbench.autoSuspendLs` | ext:880 | `Esp32Tree` internal | wraps listing in `withAutoSuspend({preempt:false})`; internal, make a function not a command |
| `mpyWorkbench.stopSerial` | ext:875 | nothing | closes the REPL terminal, toast "Board: ESP32 REPL closed"; useful as "Close REPL" |
| `mpyWorkbench.downloadFileFromBoard` | ext:974 | nothing | download + open; duplicate of the missing `syncFileBoardToLocal` |
| `mpyWorkbench.uploadToBoard` | ext:470 | nothing (intended for LocalFilesView menu) | upload a local file or folder (recursive `uploadLocalFolderToDevice`, `ext:303-326`) |
| `mpyWorkbench.localOpen` / `localCut` / `localCopy` / `localCopyPath` / `localCopyRelativePath` / `localRename` / `localDelete` | ext:494-547 | nothing | Explorer-clone commands for the undeclared Local Files view; **drop**, VS Code's Explorer already does this |
| `mpyWorkbench.rebuildManifest` | ext:380 | nothing | rescan local files into `esp32sync.json`; toast "Manifest rebuilt successfully (N files)". Drop (manifest is not needed, see 10). |
| `mpyWorkbench.refreshFileTreeCache` | ext:339 | nothing | force the 30 s mpremote tree cache; this is what the Refresh button should do. Fold into `refresh`. |
| `mpyWorkbench.debugTreeParsing`, `debugFilesystemStatus` | ext:410, 421 | nothing | developer diagnostics printing to the extension-host console; drop or move to a "Show diagnostics" command that writes to an Output channel |

Commented-out dead code: `mpyWorkbench.rename` (`ext:1156-1185`).

### 6.4 Why the `*FromView` wrappers exist (and why they should go)

`withAutoSuspend` (`ext:278-301`) is the serialisation/"REPL juggling" helper: unless `serialAutoSuspend` is off **or** the module-level one-shot flag `skipIdleOnce` is set, it (1) closes the REPL terminal if open (Ctrl-X typed into it, `mpremoteCommands.ts:27-35`; mpremote's REPL does quit on 0x18 or 0x1d, `mpremote/repl.py:14` [E, source read]), (2) runs `ensureIdle()` (a full `ls /`, i.e. a whole-board `fs tree` when the cache is cold, `ext:269-277`), (3) runs the operation, (4) "restarts" the REPL by typing the connect command into the same terminal (`restartReplInExistingTerminal`).
The wrappers and the trampoline `runFromView` call `setSkipIdleOnce()` so that a **click in the sidebar** skips steps 1-2 for the next call ("run commands without pre-ops (no kill/Ctrl-C)", `ext:1078`). Problems:

* The flag is a global one-shot consumed by **whichever** `withAutoSuspend` runs next. Commands that never call `withAutoSuspend` (Run, Open REPL, Stop, Soft Reset, Interrupt) leave it set, so the next unrelated operation (a tree listing, an autosync upload on save) silently skips the REPL close and runs against a held port. [R]
* `withAutoSuspend` is non-reentrant by design: with `preempt` (default) it executes `opQueue = Promise.resolve()` first (`ext:281-283`), i.e. it *discards* serialisation, so concurrent operations can overlap and fight over the serial port. mpremote-level `operationInProgress` polling (`mpremote.ts:156-160`) is a second, weaker lock. [R]
* After `disconnectReplTerminal()` the REPL process exits; the terminal was created with `shellArgs: ["-lc", cmd]`, so its shell exits with it and the terminal closes (VS Code closes terminals that exit 0 [I]); `restartReplInExistingTerminal` then `sendText`s into a dead terminal. Result: **any file operation permanently closes an open REPL**. This is the most likely mechanism behind "REPL did not open reliably". [R,I; verify at runtime]

New design: one explicit "board session" object that owns the serial port (queue + REPL suspend/resume), used by every command. No wrapper commands, no trampoline, no global flags.

### 6.5 Step-by-step behaviour of the live commands

Messages are quoted exactly. "(toast)" = `showInformationMessage`; "(warn)" / "(error)" accordingly.

#### 6.5.1 `runActiveFile` (`mpremoteCommands.ts:164-227`)
1. No active text editor -> (error) "No active editor". Stop.
2. `document.save()` (an untitled doc triggers a Save dialog; no check that the file is Python).
3. `connect` setting is empty or `auto` -> (error) "Select a specific serial port first (not 'auto')." Stop.
4. If the REPL terminal is open: dispose it, wait 300 + 400 ms.
5. Build the command: no workspace folder, or file outside the workspace -> `run <abs path>`. Else compute `rel`, `devicePath = rootPath + rel`; run `mpremote fs stat devicePath` (`mp.fileExists`: **any** error, including a dead connection, returns `false`, `mpremote.ts:1288-1314`). If present on board and module name has no `..` -> `exec "import <rel with / -> . and .py stripped>"` (**runs the board copy**, 0.2.62 change so tracebacks show the real path); otherwise `run <abs path>` (streams local file content).
6. Terminal "ESP32 Run File" (cwd = workspace): create if absent; `sendText(cmd, true)`; `show(true)` (preserve editor focus).
Failure modes: wrong python/mpremote -> the error appears *inside the terminal* only; a previous run still running -> the new command text goes to that process's stdin; filenames with `-` or spaces break `import`; `__main__` guard code does not run; Windows quoting (section 14.2).

#### 6.5.2 `openRepl` (`ext:871-874`, `mpremoteCommands.ts:238-274`)
`getReplTerminal()`: reuse live terminal; `connect` auto -> `throw Error("Select a specific serial port first (not 'auto')")` (from the palette the user sees VS Code's generic "Running the contributed command failed"; via the sidebar the trampoline shows "Board command failed: ..."). Else create terminal **"ESP32 REPL"** with `shellPath = $SHELL || /bin/bash`, `shellArgs = ["-lc", "'<python>' -m mpremote 'connect' '<device>'"]` (login shell; Windows: `cmd.exe /d /c <same string with single quotes>`); 500 ms later types Ctrl-C then (100 ms) Ctrl-B. `show(true)`. No handshake, no reset, no check that the port exists.

#### 6.5.3 `stop` and `serialSendCtrlC` (`mpremoteCommands.ts:110-128, 360-510`)
Port from setting; `auto` -> throws, **swallowed** (`console.error` only: user sees nothing). Health check = `mpremote fs tree` (heavy; warn "Device at <p> may not be responding properly."). Interrupt: `exec("echo -e '\\x03\\x03' > <port>")`; success toast "Board: Interrupt sent via echo to <port>"; failure -> warn "Board: Direct serial interrupt failed, trying mpremote fallback..." then `mpremote exec --no-follow "import sys; sys.stdin.write(b'\\x03\\x03')"` (which cannot interrupt anything). `stop` additionally sends `echo -e '\\x04' > <port>` (toast "Board: Soft reset sent via echo to <port>") or falls back to `mpremote reset`. Up to ~4 toasts per click. The raw `echo >` bypasses mpremote and the REPL terminal that may hold the port.

#### 6.5.4 `softReset` (`mpremoteCommands.ts:130-162`)
If REPL terminal is open: type Ctrl-C, Ctrl-B, Ctrl-D into it (toast "Board: Soft reset sent via ESP32 REPL"). Else run `mpremote connect <device> reset` (**hard** reset; toast "Board: Soft reset sent via mpremote connect auto reset" even though the port is explicit); failure -> (error) "Board: Soft reset failed: <stderr>". Works with `auto` (passes `connect auto`).

#### 6.5.5 `initializeWorkspace` (`ext:350-379`)
Toggle on `isLocalSyncInitialized()` = `.mpy-workbench/esp32sync.json` exists. Initialized: modal warning "De-initialize will remove the .mpy-workbench folder and sync state. Continue?" [De-initialize] then `rm -rf .mpy-workbench` (**also destroys the user's `.mpyignore` and `config.json`**), toast "Workspace de-initialized.". Not initialized: create dir, write default `.mpyignore` (if missing), write empty manifest, toast "Workspace initialized for MPY Workbench.". Both refresh status bar + Sync view. No workspace -> (error) "No workspace folder open".

#### 6.5.6 `toggleWorkspaceAutoSync` (`ext:1137-1150`)
Reads `.mpy-workbench/config.json` (creating the folder if needed), flips `autoSyncOnSave`, toast "Workspace auto-sync on save is now ENABLED|DISABLED". **Does not check initialization**, but the save-listener requires it (`ext:1097-1098`), so on a never-initialized workspace the toggle reports ENABLED and does nothing. [R]

#### 6.5.7 `syncBaseline` = "Upload all" (`ext:558-829`)
1. Close REPL if open (+400 ms). 2. No workspace -> (error) "No workspace folder open". 3. Not initialized -> (warn) "Workspace not initialized. Run **MPY Workbench: Initialize Workspace** first." (markdown asterisks in a toast are shown literally [I]). 4. Build manifest (walk local files minus ignore matcher). 5. Progress notification "Uploading all files to board..." (non-cancellable). 6. Collect all parent dirs, create shallowest-first with 3 retries each, verify each with `fs stat`, retry missing, throw `Missing directories after retry: ...`. 7. For each file: local `fs.access`, then `cpToDevice` wrapped in its own `withAutoSuspend` (each call may trigger a cold `fs tree` for `ensureIdle` because every upload clears the cache, plus, for non-root files, a `mkdir -p` that mpremote rejects, plus `cp`: roughly 2-3 mpremote processes per file [R, count not measured]). 8. Per-file failures are only `console.error`'d. 9. Always reports progress "All files uploaded successfully", saves manifest, toast **"Board: Sync all files (Local → Board) completed"** even if files failed. [R] 10. `decorations.clear()`, refresh tree. Any thrown error -> (error) "Upload failed: <msg>".

#### 6.5.8 `syncBaselineFromBoard` = "Download all" (`ext:831-866`)
Close REPL; list board with `listTreeStats(rootPath)`; drop ignored; for each file `mkdir -p` local dir then `cpFromDevice` **overwriting local files with no confirmation**; progress "Board: Sync all files (Board → Local)" with per-file message `Downloading <rel> (i/N)`; toast "Board: Sync all files (Board → Local) completed". No initialization check, no try/catch. `listTreeStats` is only correct when the 30 s `.mpy-workbench/tree-paths.json` file exists; otherwise its fallback parser returns garbage paths (reproduced: `"on /dev/fake-port"`, `"├── sensor.py"`, all `isDir:false`). [E]

#### 6.5.9 `deleteAllBoard` = "Clear Device Files" (`ext:1007-1074`)
Modal warning "This will DELETE ALL files and folders under '<rootPath>' on the board. This cannot be undone." [Delete All]. Progress "Deleting all files from <root>...": list, `fs rm -r` each root entry (root `/` deletes `boot.py`, `main.py`, `lib/`, everything), re-list, toasts: success "Board: Successfully deleted all N files and folders under <root>"; or warn "...but K system files remain (this is normal)" / "...but E failed...". Then `tree.resetDir(rootPath)`. No typed confirmation, red icon, sits directly under the Upload/Download rows and also appears as a title-bar button.

#### 6.5.10 `pickPort` (`ext:449-465`)
`listSerialPorts()` runs `<python> -m mpremote connect list` and parses `{device} {serial} {vid:pid} {manufacturer} {product}` (mpremote source `commands.py:27-37`). QuickPick: first row `auto - Auto-detect device`, then `<port>` with description = manufacturer + product text, or "Serial Port" when mpremote reports `None`. Ports with no USB ids (e.g. macOS `Bluetooth-Incoming-Port`, `debug-console`) are **listed** because the filter tests the port field for "None" instead of the vid/pid. Picking writes the **Global** setting `mpyWorkbench.connect`, refreshes `hasPort`, toast "Board connect set to <port>", clears the node cache, refreshes tree. Picking `auto` sets `hasPort=false`, i.e. the UI goes back to "No serial port selected." Failure/zero devices -> (warn) "No ESP32 devices detected. Make sure mpremote is installed and available in PATH." or "Error executing mpremote to detect ports: <msg>" (and the QuickPick still opens with only `auto`).
Note: mpremote itself supports `connect auto` (first USB serial device with a vid/pid, `commands.py:40-50`); the extension refuses `auto` almost everywhere instead of using it.

#### 6.5.11 `openFile` (`ext:924-973`)
File nodes only. With a workspace: target = `<ws>/<rel to rootPath>`; mkdir -p; if the local file is missing, download it from the board (**no progress UI**, error toast "Failed to copy file from board: <msg>" and abort), else **open the existing local copy without comparing it to the board**; open as non-preview editor; remember path in workspaceState `mpyWorkbench.lastOpenedPath` (written, never read). No workspace: download into `globalStorageUri/<path with / -> _>` and open preview.

#### 6.5.12 Auto-upload on save (`ext:1092-1128`) - the "auto-mirror"
On every `onDidSaveTextDocument` of any file in a workspace folder: (1) skip unless initialized; (2) ensure `.mpy-workbench/` exists; (3) if workspace autosync disabled: status-bar text "Board: Auto sync disabled — saved locally only (workspace)" for 3 s (throttled to once per 5 s) and stop; (4) skip ignored files; (5) `withAutoSuspend(cpToDevice(file, rootPath + rel))`, `tree.addNode`; failure -> (warn) "Board auto-upload failed for <rel>: <msg>". No success feedback, no progress, no debounce, and each save may spawn several mpremote processes (each of which interrupts and soft-resets the running program on the board).

---

## 7. Menu placement matrix

| Menu | Entries (command -> `when`, `group`) | Working? |
|---|---|---|
| `view/title` (`pkg:252-293`) | Sync: `syncBaselineFromView`, `syncBaselineFromBoardFromView`, `deleteAllBoardFromView` (navigation@0/1/9, `view == mpyWorkbenchSyncView`); Actions: `runActiveFileFromView`, `openReplFromView`, `serialSendCtrlC` (@0/1/2); Files: `refresh`, `pickPort` (@0/1) | all 8 work |
| `view/item/context` (`pkg:294-355`) | 12 entries listed in 4.3 | **1 works (`openFile`)**, 8 not registered, 3 `!viewItem` entries unreachable |
| `commandPalette` | none (everything declared is listed) | n/a |
| `editor/title`, `editor/context`, `explorer/context` | none | there is **no Run button in the editor title** and no "Upload to board" in the Explorer |
| status bar | 2 items (9.2) | work (only after init) |
| keybindings | none | |

---

## 8. Configuration settings

Declared in `pkg:357-412`, no `scope` on any (all default to window scope, so a workspace `.vscode/settings.json` can set them, including paths that get executed).

| Key | Default | Read at | Status |
|---|---|---|---|
| `mpyWorkbench.autoSyncOnSave` | `false` | `ext:177`, `syncView.ts:49` | **Used** as the fallback when `.mpy-workbench/config.json` has no boolean. Its description names the wrong folder (`.mpystudio/config.json`, `pkg:364`). The toggle command only writes the workspace override, so this global is just the initial default. |
| `mpyWorkbench.connect` | `"auto"` | everywhere (35 refs; e.g. `esp32Fs.ts:118`, `mpremote.ts:773`, `mpremoteCommands.ts:40,148,169,245,366,426`) | **Used.** Also **written**: reset to `"auto"` at every activation (`ext:187`, Global target), so the user must re-pick the port every VS Code launch, and a window-scoped value would be clobbered anyway. `pickPort`/`setPort` write the Global scope too (one port for all windows). |
| `mpyWorkbench.serialAutoSuspend` | `true` | `ext:279` (+ dead copy `boardOperations.ts:140`) | Used. Internal plumbing; students should not see it. |
| `mpyWorkbench.interruptOnConnect` | `true` | `mpremoteCommands.ts:294` | Only affects `openSerial` (palette-only); `openRepl` ignores it. Effectively dead for the sidebar flow. |
| `mpyWorkbench.strictConnect` | `true` | `mpremoteCommands.ts:295` | Same as above. |
| `mpyWorkbench.preListDelayMs` | `150` | `ext:274` | Used only while a listing is in progress. Internal. |
| `mpyWorkbench.rootPath` | `"/"` | 14 refs (`esp32Fs.ts:122`, `ext:476,573,839,927,985,1008,1110`, `mpremoteCommands.ts:194`) | **Used.** Maps workspace root to a device folder (e.g. `/lib`). `uploadActiveFile` ignores it (`ext:911`) unlike autosync. |
| `mpyWorkbench.usePyRawList` | `false` | `esp32Fs.ts:133`, `ext:883` | **Broken**: `pyraw.ts:11` runs `scripts/thonny_list_files.py`, which does not exist (`scripts/` has `raw_list_files.py`); also needs pyserial and hard-codes 115200. [E: `ls scripts`] |
| `mpyWorkbench.baudRate` | `115200` | **never read** | **Dead.** (mpremote's `connect` hard-codes 115200, `commands.py:45,57,64`; the setting could not be honoured through `connect` anyway.) |
| `mpyWorkbench.pythonPath` | `""` | `pythonInterpreter.ts:159-160` (resource-scoped), cache clear `ext:892` | **Used, but ineffective for venvs**: rejected by the PATH-based validator (section 14.1). |

Other state: workspaceState key `mpyWorkbench.lastOpenedPath` (`ext:958,967`, write-only). `boardOperations.ts:496,509` tries to *update* an undeclared configuration key `mpyWorkbench.lastOpenedPath` (would throw; the class is dead code).

---

## 9. Context keys, status bar, decorations, terminals, listeners

### 9.1 Context keys
`mpyWorkbench.hasPort` only: `true` iff `connect` is non-empty and not `"auto"` (`ext:181-185`); gates the Files welcome content (`pkg:48`). Set at activation and on config change of `mpyWorkbench.connect` (`ext:890-891`). No context key for "workspace initialized", "mpremote available", "REPL open", "operation running".

### 9.2 Status bar (`ext:207-243`)
| Item | Alignment/priority | Text | Click | Visibility |
|---|---|---|---|---|
| AutoSync | right, 100 | `MPY: AutoSync ON` / `MPY: AutoSync OFF` (OFF uses `statusBarItem.warningForeground`) | `mpyWorkbench.toggleWorkspaceAutoSync` | only when a workspace exists **and** `.mpy-workbench/esp32sync.json` exists |
| Cancel | right, 90 | `MPY: Cancel` (warning colour) | `mpyWorkbench.cancelAllTasks` | same condition; **always visible when shown, regardless of whether anything is running** |
Refreshed on activation, after toggle/initialize, and by file watchers on `.mpy-workbench/esp32sync.json` and `.mpystudio/config.json`; the second watcher watches a folder that no longer exists (`ext:245-253`), so hand-edits of `config.json` do not update the item. No indicator for port, connection, environment, or REPL state.

### 9.3 Terminals (all via `vscode.window.createTerminal`)
| Name | Created by | Mechanism |
|---|---|---|
| `ESP32 REPL` | `getReplTerminal` | `shellPath` = login shell, `-lc` + composed command (Windows: `cmd.exe /d /c`) |
| `ESP32 Run File` | `runActiveFile` | default shell, `sendText(composed command)` |
No Output channel exists; all diagnostics are `console.log("[DEBUG] ...")` in the extension-host log, invisible to students. `onDidCloseTerminal` only clears the run terminal reference (`ext:1129-1134`).

### 9.4 File decorations
`Esp32DecorationProvider` (`decorations.ts`), registered for scheme `esp32` only. Badges: `?` (local-only file or folder, `descriptionForeground`), `Δ` red (only-on-board or changed). The setters `setDiffs/setLocalOnly/setBoardOnly/setLocalOnlyDirectories` have **no callers**; only `clear()` is called (`ext:824,864`). So the decoration layer, and the local-only injection in `esp32Fs.ts:168-232` that reads it, is inert since 0.3.1. [E: grep]

### 9.5 Event listeners / watchers
`onDidChangeConfiguration` (port context, python cache), `onDidSaveTextDocument` (autosync), `onDidCloseTerminal`, two `FileSystemWatcher`s (config glob is dead). Uses `workspaceFolders[0]` everywhere: multi-root workspaces are not supported. `deactivate()` is empty (the `ConnectionManager` `setInterval`, `mpremote.ts:107`, is never cleared).

### 9.6 Activation side effects (`activate`, `ext:36-263`)
1. `checkMpremoteAvailability()` (`mpremoteCommands.ts:75-108`): runs `<python> -m mpremote --version`; failure -> (warn, **Spanish**) "mpremote no encontrado en el intérprete Python activo. Instálalo con: python -m pip install mpremote"; too old (<1.26) -> (warn, Spanish) "mpremote X detectado. Esta extensión requiere mpremote >= 1.26 ..." [Cómo actualizar].
2. Overwrites global `mpyWorkbench.connect` with `"auto"`.
3. Creates 4 tree views (the 4th, undeclared, produces the "No view is registered with id: mpyWorkbenchLocalFilesView" error toast on VS Code 1.141 per `06-ext-core.md`), decoration provider (also exported as `global.esp32Decorations`), a never-used `BoardOperations`, 2 status-bar items, 2 watchers, then registers all commands.

---

## 10. `.mpy-workbench/` workspace files and schemas

| Path | Written by | Read by | Schema / content |
|---|---|---|---|
| `.mpy-workbench/esp32sync.json` | `initializeWorkspace` (empty), `syncBaseline` (full), `rebuildManifest` (`ext:371,819,401`); `sync.ts:54-58` | `isLocalSyncInitialized` (**existence = "initialized" flag**), `syncView.ts:37` | `{ "version": 1, "syncId": "<uuid>", "root": "<ABSOLUTE local workspace path>", "generatedAt": <epoch ms>, "files": { "<posix rel path>": { "size": <bytes>, "mtime": <epoch ms int> } } }` (`sync.ts:5-12`). `diffManifests` exists but is unused. The absolute `root` leaks the teacher's path when a starter project is distributed and the mere presence of the file silently "initializes" a student's copy. |
| `.mpy-workbench/config.json` | `toggleWorkspaceAutoSync` (`ext:163-171`) | `ext:153-161`, `syncView.ts:44` | `{ "autoSyncOnSave": true|false }` - the only key. Invalid JSON is read as `{}` silently. |
| `.mpy-workbench/.mpyignore` | `initializeWorkspace` / `ensureWorkbenchIgnoreFile` (`ext:77-150`) | `createIgnoreMatcher` (`sync.ts:105-123`) | gitignore-like lines. Default content (59 lines): `.git/ .svn/ .hg/ .vscode/ .idea/ .vs/ .DS_Store Thumbs.db node_modules/ dist/ out/ build/ .cache/ coverage/ .next/ .nuxt/ .svelte-kit/ .turbo/ .parcel-cache/ *.log npm-debug.log* yarn-... pnpm-debug.log* __pycache__/ *.py[cod] *.pyo *.pyd .venv/ venv/ .env .env.* .mypy_cache/ .pytest_cache/ .coverage coverage.xml *.egg-info/ .tox/ *.swp *.swo .mpy-workbench/ /.mpy-workbench`. Hard-coded defaults always applied in addition: `.git/ .vscode/ node_modules/ dist/ out/ build/ __pycache__/ .DS_Store .mpy-workbench/` (`sync.ts:73-85`). Matcher supports `*`, `**`, `?`, trailing `/`, leading `/` anchor; **no `!` negation and no `[abc]` classes**. Executed against the default file: `lib/foo.pyc` is NOT ignored (the `[cod]` class is escaped to literals), `.venv/...`, `venv/...`, `.env.local`, `notes.log`, `build/out.bin`, `lib/build/mod.py` (any depth) ARE ignored; **`typings/machine.pyi` is NOT ignored** (important once stubs are generated into `typings/`). [E] |
| `.mpy-workbench/tree-paths.json` | `populateFileTreeCache`, only if `esp32sync.json` exists (`mpremote.ts:271-285`) | `listTreeStats` (valid if <30 s old, `mpremote.ts:1486-1520`) | `[ { "fullPath": "/lib/x.py", "name": "x.py", "isDir": false, "depth": 1 }, ... ]` - an undocumented cache file on which "Download all" and "Clear Device Files" silently depend. |
| `.mpyignore` at workspace root | nobody | nobody | `esp32Fs.ts:145` comment claims it is read; `createIgnoreMatcher` only reads `.mpy-workbench/.mpyignore`. |
| `.mpystudio/` | nobody | `ext:245-248` watcher glob, `pkg:364` text | **Stale name** of `.mpy-workbench/` from the pre-0.3 "MPY Studio" era (GIFs show `.mpystudio` + root `esp32sync.json`). |
| `.mpy-workbench/` itself | | `LocalFilesTree` hides it (`localFilesView.ts:15-22`) | `.gitignore`/`.vscodeignore` of the *extension repo* list `.mpy-workbench`, but a student project repo that commits it carries the abs-path manifest. |

---

## 11. Dead code and package.json/code mismatches (inventory)

| Item | Evidence |
|---|---|
| 10 declared-not-registered commands | 6.2 [E] |
| 16 registered-not-declared commands | 6.3 [E] |
| `BoardOperations` class instantiated and never called (`ext:204`; `boardOperations.ts` 551 lines; its `withAutoSuspend` is a no-op) | grep [E] |
| `ControlTree` (`control.ts`) never instantiated; `monitor.ts` (`SerialMonitor`, polling output channel "ESP32 Serial (Polling)") import commented out (`ext:17`); `mpremoteOperations.ts` is placeholder stubs; `test.ts` (a `checkDiffs` scratch script) is compiled into `dist/test.js` | grep [E] |
| `src/miniterm_filter.py`, `scripts/check_python_deps.py`, `scripts/bench_upload.py`, `scripts/raw_list_files.py` unreferenced (the one reference, `pyraw.ts:12`, names a non-existent `thonny_list_files.py`) | grep, `ls` [E] |
| `no-port` tree node + `esp32fs.css` + `contributes.css` | 3 [R] |
| 5 icon branches for non-existent action ids (`actions.ts:40-50`) | [R] |
| Decoration setters with no callers; local-only tree injection inert | 9.4 [E] |
| `mpyWorkbench.rename` commented-out block (`ext:1156-1185`) | [R] |
| `mpyWorkbenchLocalFilesView` created but undeclared | [R] |
| `getPythonCommandForTerminal` unused | [R] |
| Stale `dist/pathUtils*.js` with no source; 0-byte `media/mpy-studio-logo.svg` | [E] |
| README claims: "Create a new file in the Files view and upload it to the board on first save" (command removed), "MPY Workbench: Open REPL Terminal" (actual title "Open REPL"), "Delete all files on board" etc. | README:18,41 vs `pkg` |

---

## 12. Naming and wording inconsistencies

* **Folder name:** `.mpy-workbench` (code) vs `.mpystudio` (stale watcher `ext:248`, `pkg:364`, GIFs) vs repo/badge `mpy-studio` (README:9) vs asset `mpy-studio-logo.svg`.
* **Product prefix in messages:** "Board:" (most toasts), "ESP32 ..." ("ESP32 connect set to", "ESP32 list error", terminals "ESP32 REPL"/"ESP32 Run File"), "MPY:" (status bar), "MPY Workbench" (titles). The product claims to be generic MicroPython but speaks "ESP32".
* **Same action, different names:** Run: "Run file" / "Run Active File" (old GIF/CHANGELOG) / command `runActiveFile`. REPL: "Open Repl" (row) / "Open REPL" (command) / "Open REPL Terminal" (README) / "Open Serial Monitor" (`openSerial`, a different code path). Upload all: row "Upload all files (Local → Board)" vs command "Sync all files (Local → Board)" vs README "Upload all Local → Board". Section: "Sync utilities" (view) vs "Sync Files" (GIF/README heading). "Clear Device Files" vs "Delete ALL files on Board" vs "deleteAllBoard".
* **Titles carry the full prefix and implementation suffixes:** `MPY Workbench: Run file (View)`, `...Run Command (View Wrapper)`; the (View) variants are what users see in toolbar tooltips.
* **Row labels vs command titles:** "Stop" row vs "Stop (Ctrl-C/A/D)"; "Interrupt" vs "Interrupt (Ctrl-C, Ctrl-B)"; "Soft Reset" vs "Soft Reset (Ctrl-D)" (which is not a soft reset when the REPL is closed).
* **Language:** English UI with Spanish strings: `mpremoteCommands.ts:82,90-91,103`, `pythonInterpreter.ts:273,278`, Spanish comments throughout; `CHANGELOG.md` is Spanish.
* **Versions:** package 0.3.2 vs CHANGELOG top entry 0.2.62; repo HEAD (Apr 2026) vs vsix (Feb 2026) both "0.3.2" with different launch code.
* **Port setting naming:** setting `connect`, QuickPick says "Select Board serial port", toast "Board connect set to", welcome says "serial port".

---

## 13. UX problems for beginners (ranked)

0. **A red error toast on every activation** ("No view is registered with id: mpyWorkbenchLocalFilesView", see 4.1) before the student has done anything.
1. **Silent failures:** Stop/Interrupt with no port (nothing shown); Files view empty on connection failure (no retry row, no message; errors containing "auto" or "serial port" are swallowed, `esp32Fs.ts:241-243`); autosync failure only warns, success is invisible; Upload all reports success after per-file failures (6.5.7); `fileExists` converts every error to "not on board".
2. **Hidden prerequisite "Initialize Workspace":** upload-all, autosync and the status bar all need it, yet the sidebar offers autosync/upload rows first-class and answers with a warning toast containing literal `**` markdown. The label flips between "Initialize" and "De-initialize" (the latter deletes the user's ignore rules).
3. **Environment problems are invisible:** no indicator that Python/mpremote/board are OK; failures surface as a Spanish toast at activation, a terminal error, or nothing. No "Set up" action.
4. **Run semantics surprise** (6.5.1): stale board copy, `__main__` guard not run, no auto-upload, next-run typed into running process, runs even on non-Python files.
5. **Destructive actions are one click from routine ones:** "Clear Device Files" (deletes `boot.py`/`main.py`/`lib/`), "Download all" (silently overwrites local edits), "De-initialize". Only the first has a modal, and it is a plain "Delete All" button.
6. **Dead context menu:** 8 of 9 file-node entries throw "command not found" (6.2).
7. **Port handling:** reset to `auto` on every launch; `auto` offered but means "no port"; non-USB ports listed; one global port for all windows; stale tree for 30 s after switching boards.
8. **Two different "open REPL" behaviours** (palette "Open Serial Monitor" hard-resets; sidebar does not), and **any file operation closes an open REPL for good** (6.4).
9. **Toolbar tooltips** read "MPY Workbench: Run file (View)"; palette is polluted with commands that need arguments (`setPort`, `openFile`, `runFromView`).
10. **No Run button in the editor title**, no Explorer context entry to upload a file; users must go to the sidebar.
11. **Slow/noisy operations with no cancel except a status-bar item that is always visible and not tied to a running task**; no Output channel to copy errors for a TA.
12. **Raw error dumps**: "Failed to copy from device: ...\nCommand: mpremote connect ... fs cp ...\nOriginal device path: ..." (names `mpremote` although `python -m mpremote` was run).
13. **Folder/file icons ignore the user's icon theme**; no `description` text (e.g., sizes, Ctrl-keys) on rows; no tooltips on action rows.
14. **Board listing is wrong in edge cases students will hit** (a file named `tree.py`, `decision_tree.py`, extension-less `data`) (section 1 item 8).

---

## 14. Platform-specific findings that surface in the UI

### 14.1 Python / mpremote discovery (complaint 1) [E]
Harness: real compiled `pythonInterpreter.js` with a stubbed `vscode` module; a scratch venv containing `mpremote 1.29.0`; `mpyWorkbench.pythonPath` set to that venv's `bin/python`.

| Case | `getPythonPath()` returned | Messages shown to user |
|---|---|---|
| A. venv python has mpremote, `mpremote` NOT on PATH (the user's situation) | **`python3`** (bare, system) | **none** |
| B. same, but venv `bin` first on PATH | the venv python | none |

Mechanism: `validatePythonPath` (`pythonInterpreter.ts:229-249`) runs `execFile(pythonPath,['-c',...])` then `execFile('mpremote',['--version'])` (bare). In case A the second call fails with `spawn mpremote ENOENT`; the "missing mpremote" branch requires the text "not found" (`:242`), so the result is `{valid:false, missingMpremote:false}`, silently skipping the override (`:46`), then the Python-extension interpreter, `python.defaultInterpreterPath`, and every fallback, ending at `'python3'` (`:104-107`) with no message. All subsequent calls become `python3 -m mpremote ...` -> "No module named mpremote" (visible only in a terminal or console). The validator also accepts any Python when a global `mpremote` exists, even if that Python lacks the module. Other discovery gaps: no probe of `<workspace>/.venv`, `venv`; the Windows fallbacks `'py -3'` can never validate because `execFile('py -3', ...)` treats the whole string as an executable name; no `python.exe` Microsoft-Store-stub detection.
In the harness the Python extension was stubbed as absent; with `ms-python.python` active and the venv selected, Method 1 (`pythonInterpreter.ts:52-67`) hands the same venv path to the same validator, so it fails identically (this part is [R]). Confidence high that the venv is rejected (executed); the exact messages a student sees also depend on what the terminal prints afterwards. Refute/verify: case B passes (executed); or run the proposed fix (`<python> -m mpremote --version` as the probe).

### 14.2 Command-line construction
`runMpremote` builds `'<python>' -m mpremote 'connect' '<port>' 'fs' 'tree'` and `exec`s it (`mpremote.ts:170-184`); both terminals use the same quoting (`mpremoteCommands.ts:8-17`). POSIX shells accept that; `cmd.exe /d /s /c` (Node `exec` on Windows) and PowerShell (default VS Code terminal) do not: `cmd` looks for a program literally named `'C:\...\python.exe'`; PowerShell fails with an unexpected-token error on `-m`. [I, needs a Windows run] The shipped vsix did not have this problem (bare `mpremote "arg"`). Requirement for the new build: never compose command lines. Use `execFile(python, ['-m','mpremote',...args])` for batch calls and `createTerminal({ shellPath: python, shellArgs: ['-m','mpremote','connect',port] })` for terminals.

### 14.3 Other Windows items
* `uploadActiveFile` normalises separators with `/\\\\/g` (two backslashes) at `ext:904,911`; `src\main.py` stays `src\main.py` (executed: `"src\\main.py"`), giving device path `/src\main.py`; the autosync listener uses the correct `/\\/g` (`ext:1111`). [E]
* `echo -e '\x03' > COM3` (Stop/Interrupt) is not a serial write on Windows; the toast still says "Interrupt sent". [I]
* `normalizeConnect` only handles `cu.*` and `serial:` prefixes (`mpremote.ts:11-24`); `COM10+` and `\\.\COM10` forms untested.
* macOS: `/bin/sh -c "echo -e '\x03\x03'"` emits `-e ` + two ETX + newline (executed, bytes `2d65 2003 030a`). [E]

### 14.4 mpremote behaviours that contradict the extension (mpremote 1.29.0, `main.py`/`commands.py`) [E]
* `fs mkdir -p <dir>` is rejected by argparse (`unrecognized arguments: -p`), yet `cpToDevice`/`uploadReplacing` always try it first (`mpremote.ts:948,1103`), swallow the failure, and rely on a slower fallback after `cp` fails.
* `reset` = hard reset (`machine.reset()`); `soft-reset` is separate.
* `fs tree` output header is `:<path> on <device>` when verbose; names are not marked as dirs, hence the extension's heuristics.
* `connect list` prints `0000:0000` / `None` for non-USB ports; `connect auto` exists.
* Baud is fixed at 115200 in `connect`.

---

## 15. Proposed contribution manifest for `mpy-upgrade`

Design goals: identical three-section sidebar and the same rows; everything in the old `package.json` actually works; two new capabilities (Environment/status and IntelliSense stubs); zero shell-quoting; one serialised "board session".

### 15.1 Namespace decision (replace vs coexist)

| Option | What it means | Consequences |
|---|---|---|
| **A. Replace in place:** keep `mpyWorkbench.*` ids, views, config keys | Users' keybindings/tasks keep working; docs match 1:1 | Cannot be installed next to the original (`DanielBucam.mpy-workbench` is not yours to publish under; a fork needs a new publisher/name anyway, and `esp32Fs.ts:257` hard-codes the old id). If both are enabled: VS Code rejects duplicate `registerCommand` ids (second extension partially fails), duplicate view/container ids, both register `onDidSaveTextDocument` (double uploads + serial contention), both write `.mpy-workbench/`. Student machines may have the Marketplace original. |
| **B. Coexist: new publisher.name and new prefix** (recommended) | New ids for commands, views, container, config keys, context keys, terminal names, decoration scheme | Safe side by side. Cost: a rename of ids (mechanical). Keep **suffixes** identical (`runActiveFile`, `openRepl`, `pickPort`, ...) so mapping is trivial. Add a startup check: if `vscode.extensions.getExtension('DanielBucam.mpy-workbench')` exists and is active, show one warning "Disable the old MPY Workbench to avoid double uploads" with a button to open it in the Extensions view. |

Recommendation: **B**, with a single constant for the prefix (placeholder below: `mpyBench`; the user should choose the final name) and `package.json` contributions generated from one TypeScript table so a rename is one line. Do not reuse the names `mpyWorkbench`, `mpyStudio`, `esp32` (URI scheme, terminal names). Keep the folder `.mpy-workbench/` as the *read-compatible* project folder (config + ignore) but make it optional; migrate `esp32sync.json` away (10).

### 15.2 Views and layout (keep the layout; add one conditional view)

| View | id | Keep/add | `when` | Notes |
|---|---|---|---|---|
| Setup | `mpyBench.setupView` | **add** (first) | `!mpyBench.ready` (python, mpremote, board all OK -> view disappears) | rows: Python, mpremote, Board, IntelliSense, Workspace; each failing row has a one-click fix |
| Files | `mpyBench.filesView` | keep | always | welcome states below; tree nodes theme-aware (`resourceUri` = real filename URI + `ThemeIcon.File/Folder` so the user's icon theme applies); view title: Refresh, Select Board, New File, New Folder |
| Board Actions | `mpyBench.actionsView` | keep | always | same 5 rows + "Upload Current File"; add `description` text (`Ctrl-C`, `Ctrl-D`) and tooltips |
| Sync utilities | `mpyBench.syncView` | keep | always | same 5 rows; "Initialize" becomes automatic |

Welcome content (`viewsWelcome`), most specific first:
1. no folder open: "Open a folder to start. [Open Folder](command:vscode.openFolder)"
2. `!mpyBench.envOk`: "Python or mpremote is not set up. [Set Up Python Environment](command:mpyBench.setupEnvironment)"
3. `!mpyBench.hasBoard`: "No board selected. Plug in your board. [Select Board](command:mpyBench.pickPort) [Refresh Ports](command:mpyBench.refreshPorts)"
4. listing failed: show an error row with a Retry button (not an empty view).

Status bar: (1) left item `$(plug) COM3` / `$(warning) MPY: setup needed` / `$(sync~spin) Uploading 3/12`, click -> quick menu (select board, check environment, show log, open REPL); (2) `AutoSync ON/OFF` (keep, always shown in a MicroPython workspace); (3) `Cancel` shown **only while an operation runs**.
Additional contributions: `editor/title/run` button "Run Current File on Board" (`resourceLangId == python`); `explorer/context` "Upload to Board" for files and folders (replaces the Local Files view and its 8 commands); a `walkthroughs` entry (Set up Python -> Plug in and select board -> Run a file -> Turn on AutoSync); an Output channel "MicroPython"; `commandPalette` `when:false` for argument-taking commands; `categories` set per command (`"category": "MicroPython"`) instead of "MPY Workbench: " in every title.

### 15.3 Commands: keep, rename, merge, drop, add (ids use `<p>` = chosen prefix, suffix = old suffix where one exists)

| Old id (suffix) | Decision | New title / notes |
|---|---|---|
| `refresh` | **keep**, fix | "Refresh Board Files": invalidate every cache layer, per-port; show error row on failure |
| `pickPort` | **keep**, change | "Select Board": list only USB ports (vid/pid present), ESP32-bridge VIDs first (10C4, 1A86, 0403, 303A); offer "Auto-detect" implemented via `connect auto` semantics but displayed as the resolved port; remember choice in `workspaceState`; never reset at startup |
| `refreshPorts`, `setPort` | **drop** (`setPort` -> hidden internal function) | |
| `openRepl` | **keep** | "Open REPL": single implementation, no `...FromView`, with handshake optional |
| `openSerial` | **merge** into `openRepl` | |
| `stopSerial` | **keep** as "Close REPL" (declare it) | |
| `runActiveFile` | **keep**, change | "Run Current File on Board": save -> (optional) upload -> `mpremote run`; setting `run.mode` (`run` default, `import`); refuse non-`.py` with a message; if a run is in progress, Ctrl-C it first |
| `stop` | **keep** | "Stop Program (Ctrl-C)" semantic = interrupt then soft reset only if requested; implement via mpremote/serial library, never `echo >` |
| `serialSendCtrlC` | **keep** row "Interrupt"; **rename** `interrupt` | "Interrupt (Ctrl-C)": no soft reset |
| `softReset` | **keep** | "Soft Reset (Ctrl-D)": must really soft-reset (`mpremote soft-reset` or Ctrl-D); separate "Hard Reset" optional |
| `uploadActiveFile` | **keep** | "Upload Current File" (+ editor title, + Explorer); honour `rootPath` |
| `syncBaseline` / `syncBaselineFromBoard` | **keep**, rename display | "Upload All Files (Computer → Board)" / "Download All Files (Board → Computer)"; real progress, partial-failure report, confirmation + "show diff first" for download; ids kept |
| `deleteAllBoard` | **keep** | "Erase Board Files…": typed confirmation, option to keep `boot.py`/`main.py` |
| `initializeWorkspace` | **keep as optional** | auto-initialize lazily; palette command renamed "Reset Project Sync Settings" |
| `toggleWorkspaceAutoSync` | **keep** | status bar + Sync row; must also say when it cannot run; consider default ON for the course template |
| `cancelAllTasks` | **keep, declare** | "Cancel Board Operation" |
| `openFile` | **keep** (internal + tree click) | open local copy; if absent download with progress; if both exist and differ, show a diff-or-overwrite choice |
| `newFileInTree`, `newFolderInTree`, `renameNode`, `delete`, `deleteBoardAndLocal`, `syncFileLocalToBoard`, `syncFileBoardToLocal` | **keep and re-implement** per 6.2 | add file/dir `viewItem` split; no `!viewItem` entries (put New File/New Folder in view title) |
| `newFileBoardAndLocal`, `mkdir`, `openFileFromLocal` | **drop** (duplicates of the above) | |
| `runFromView`, all `*FromView`, `autoSuspendLs` | **drop** | replaced by the board-session queue |
| `uploadToBoard`, `downloadFileFromBoard` | **merge** into `uploadActiveFile` (explorer context) / `syncFileBoardToLocal` | |
| `local*` (7), `rebuildManifest`, `refreshFileTreeCache`, `debugTreeParsing`, `debugFilesystemStatus` | **drop** (diagnostics -> `showLog`) | |
| *(new)* `checkEnvironment` | **add** | "Check Python / mpremote Setup" -> fills Setup view, logs to Output |
| *(new)* `setupEnvironment` | **add** | "Set Up Python Environment": create `.venv` with the best available interpreter (`py -3` / `python3`), `pip install mpremote` (pinned >= 1.26), set `python.defaultInterpreterPath`, store `mpyBench.pythonPath` as resolved absolute path; progress + log |
| *(new)* `selectInterpreter` | **add** | pick another Python/mpremote; probe `<ws>/.venv`, `venv`, Python-extension interpreter, `py -3`, `python3`, `python`, each by running `<python> -m mpremote --version` (never bare `mpremote`) |
| *(new)* `generateStubs` | **add** | "Generate IntelliSense Stubs": (1) install `micropython-<board>-stubs` + `micropython-stdlib-stubs` into `typings/` (Pylance's default `stubPath`), (2) for custom firmware: add folders of frozen `.py` sources to `python.analysis.extraPaths` and/or introspect the connected board (`mpremote exec` over `help('modules')`/`dir()`) to emit `.pyi` skeletons for C modules into `typings/`, (3) write `.vscode/settings.json` / `pyrightconfig.json`, (4) report what was configured |
| *(new)* `addFirmwareModulePath` | **add** | "Add Custom Firmware Modules Folder…" (adds to `extraPaths`, remembers in settings) |
| *(new)* `configureLinting` | **add** | "Configure Pylance for MicroPython" (re-apply settings, silence `reportMissingModuleSource`) |
| *(new)* `showLog` | **add** | open Output channel |
| *(new)* `showStatusMenu` | **add** | status-bar click target |
| *(new)* `uploadFolder` or reuse `uploadToBoard` | **add** (`explorer/context`) | |

### 15.4 Settings: keep / rename / drop (keys under `<p>.`)

| Old key | Decision | Notes |
|---|---|---|
| `autoSyncOnSave` | **keep** | default stays false unless the course template sets true |
| `connect` | **keep** (manual override only), `"auto"` default | scope `machine-overridable`; extension **must not write it at startup**; selected port lives in `workspaceState` |
| `rootPath` | **keep** | validate it starts with `/` |
| `pythonPath` | **keep**, `machine-overridable` | resolved by new discovery order; shown in Setup view |
| `serialAutoSuspend`, `interruptOnConnect`, `strictConnect`, `preListDelayMs` | **drop** | internal behaviour of the board session |
| `usePyRawList`, `baudRate` | **drop** | broken / dead |
| new `mpremotePath` | **add** | explicit executable override (rarely needed) |
| new `run.mode`, `run.uploadFirst` | **add** | default `run`, uploadFirst true when autosync is off |
| new `stubs.board`, `stubs.firmwareModulePaths`, `stubs.autoConfigure` | **add** | drives `generateStubs` |
| new `confirmDestructive` | **add** | default true |
Mark path-valued settings as restricted in untrusted workspaces; set `capabilities.untrustedWorkspaces.supported = "limited"`.

### 15.5 Skeleton of `contributes` (abbreviated; to be generated from one table)

```jsonc
{
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": { "activitybar": [{ "id": "mpyBench", "title": "MicroPython", "icon": "media/activitybar.svg" }] },
    "views": { "mpyBench": [
      { "id": "mpyBench.setupView",   "name": "Setup",          "when": "!mpyBench.ready" },
      { "id": "mpyBench.filesView",   "name": "Files" },
      { "id": "mpyBench.actionsView", "name": "Board Actions" },
      { "id": "mpyBench.syncView",    "name": "Sync utilities" }
    ]},
    "viewsWelcome": [ /* 4 states from 15.2 */ ],
    "commands": [ /* every row of 15.3 with "category": "MicroPython" and short titles */ ],
    "menus": {
      "view/title": [ /* files: refresh, pickPort, newFile, newFolder; actions: run, repl, interrupt; sync: upload, download, erase */ ],
      "view/item/context": [ /* viewItem == file | dir: newFile, newFolder, rename, delete, deleteBoardAndLocal; file: openFile, syncFileLocalToBoard, syncFileBoardToLocal */ ],
      "editor/title/run": [ { "command": "mpyBench.runActiveFile", "when": "resourceLangId == python" } ],
      "explorer/context": [ { "command": "mpyBench.uploadToBoard", "when": "!explorerResourceIsRoot" } ],
      "commandPalette": [ { "command": "mpyBench.openFile", "when": "false" } /* + other arg-taking commands */ ]
    },
    "configuration": { /* 15.4 */ },
    "walkthroughs": [ /* 4 steps */ ]
  },
  "capabilities": { "untrustedWorkspaces": { "supported": "limited", "restrictedConfigurations": ["mpyBench.pythonPath", "mpyBench.mpremotePath", "mpyBench.connect"] } }
}
```

---

## 16. Acceptance-test matrix (what the new build is tested against)

P = platform: M macOS, W Windows. Auto = suggested automation (U unit, I integration with a fake mpremote shim like the scratch harness, V VS Code extension-host test, H needs hardware).

| # | Area | Steps | Expected | P | Auto |
|---|---|---|---|---|---|
| 1 | Env discovery | Workspace with `.venv` containing mpremote, nothing on PATH, Python ext. not selecting it | Setup view shows Python = `.venv` interpreter, mpremote version; no prompts | M,W | I |
| 2 | Env discovery | No Python found | Setup row red with "Set Up Python Environment"; no Spanish text | M,W | V |
| 3 | Env setup | Click Set Up Python Environment on a clean machine | `.venv` created, mpremote installed, status turns green, log in Output | M,W | I/H |
| 4 | Version gate | mpremote 1.24 | Warning with an upgrade action; operations disabled | M,W | I |
| 5 | Port list | `connect list` fixture with Bluetooth/debug-console ports | only USB ports shown; CP210x/CH340/FTDI/Espressif first | M,W | U |
| 6 | Port persistence | Select port, reload window | same port selected; no write to global settings at startup | M,W | V |
| 7 | Files view | Fixture tree with `tree.py`, `decision_tree.py`, `data` (file), empty folder, `my.dir` | all shown with right file/folder type | M,W | U |
| 8 | Files view error | Port busy / board unplugged | error row with Retry, message explains cause | M,W | I |
| 9 | Refresh | Change board contents out-of-band, Refresh | new contents shown immediately | M,W | I |
| 10 | Open from board | Click remote-only file | downloads into workspace at same relative path with progress; opens | M,W | I |
| 11 | Context menu | Right-click file/dir | every entry works (new file/folder, rename, delete, delete both, sync L->B, B->L, open); no `command not found` | M,W | V |
| 12 | Run | Open `main.py` with `if __name__=="__main__":`, click Run | code executes; output visible; no REPL needed; stale board copy impossible | M,W | H |
| 13 | Run twice | Click Run while previous run still active | previous program interrupted first | M,W | H |
| 14 | REPL | Open REPL, then save with autosync ON | REPL is suspended during upload and **resumes automatically** | M,W | H |
| 15 | REPL reliability | Open/close REPL 20 times; unplug/replug once | opens every time or gives a precise error | M,W | H |
| 16 | Stop/Interrupt/Reset | With and without a selected port | Stop interrupts a `while True` loop; no port -> clear message; Soft Reset really soft-resets (REPL banner `soft reboot`) | M,W | H |
| 17 | Upload all | 3 folders / 20 files incl. nested | all present; progress; a forced failure is reported as failure | M,W | I |
| 18 | Download all | Local file modified | confirmation or diff before overwrite | M,W | V |
| 19 | Erase | Click Erase | typed confirmation; boot/main kept when chosen | M,W | V |
| 20 | Autosync | Enable, save nested file `src\a.py` (W) | board has `/src/a.py`; status bar shows brief "Uploaded"; no mpremote storm | M,W | I |
| 21 | Autosync off/uninit | Toggle without prior init | works (no hidden gate) or says exactly why not | M,W | V |
| 22 | Ignore rules | `.venv/`, `typings/`, `__pycache__/`, `*.pyc`, `.git/` | never uploaded; `*.pyc` ignored (class support or explicit patterns) | M,W | U |
| 23 | Upload active file | In `rootPath=/lib` | lands under `/lib/...` | M,W | I |
| 24 | Windows quoting | Python path with spaces (`C:\Users\A B\...`), COM12 | all operations and both terminals work in PowerShell and cmd | W | H |
| 25 | Cancel | Start Upload all, click Cancel | process killed (child tree), UI recovers, no leaked mpremote process | M,W | I |
| 26 | Coexistence | Old extension also installed | one warning; no duplicate-command errors | M,W | V |
| 27 | Untrusted workspace | Open untrusted folder with `pythonPath` set | setting ignored, banner explains | M,W | V |
| 28 | IntelliSense | `import machine; machine.Pin(2)` | no unresolved import, hover docs | M,W | V |
| 29 | IntelliSense custom | Import of a firmware-only module `import mylib` | resolved via configured path/stub; no `reportMissingImports` | M,W | V |
| 30 | Status bar | Connected/disconnected/running | indicator and Cancel visibility follow state | M,W | V |
| 31 | Wording | Search all strings | single language (English), single prefix, no "ESP32"-only wording, no "(View)" | M,W | U |

---

## 17. Open questions (for the user)

1. Final extension name/prefix (placeholder `mpyBench`) and publisher; ship by Marketplace or `.vsix` to students?
2. Is "Initialize Workspace" a concept you want students to see? Recommendation: remove the gate, keep a hidden reset command.
3. Should AutoSync default to ON in the course template? (It makes every save interrupt and soft-reset the running program on the board.)
4. Should "Run file" run the editor content (`mpremote run`) or the board copy (`import`)? Recommendation: `run`, because `import` skips `__main__` guards and can run stale code.
5. Custom firmware libs: are they frozen `.py` modules (sources available locally), C modules (need introspection or hand-written stubs), or both? Do students have the firmware source tree?
6. Boards: are all of them CP2102 UART bridges (like `/dev/cu.usbserial-0001`) or also native-USB S3/C3 (port re-enumerates on reset, which breaks "Soft Reset" via `machine.reset()` and any cached port)?
7. Do you want the old "Check for differences" / `?`/`Δ` badges back (removed in 0.3.1 but still visible in the README GIF)?
8. Windows default terminal on student machines: PowerShell or cmd? Is Python installed from python.org (with `py`), the Microsoft Store, or not at all?

---

## 18. Reproduction notes (all artefacts live in the scratchpad, none in the project)

Scratchpad root: `<scratchpad>/`
* `build/` - copy of `src/` + `tsconfig.json`, compiled with the old repo's `node_modules/.bin/tsc` to `build/out/` (compiles with zero errors; identical to `dist/`).
* `vsix/` - unzipped `mpy-workbench-0.3.2.vsix` (diffs in section 2).
* `stubmods/vscode/index.js` - ~25-line stub of the `vscode` module (settings from `STUB_SETTINGS` JSON env var); `stubmods/run_getPythonPath.js` - section 14.1 harness.
* `venv_mp/` - scratch venv with `mpremote 1.29.0` (pip), used only to read mpremote source and run its argument parser (`argparse_filesystem()`), never to connect to a device.
* `fake/py`, `fake/mpremote`, `fake/tree.txt`, `fake/run_ls.js` - fake `python -m mpremote` shim printing canned `fs tree` output; proves the listing defects in 1 (item 8) and 6.5.8. The shim only ever reads `tree.txt`; no serial port is opened.
* `ignoretest/` - `.mpyignore` matcher check.
* `frames/` - extracted GIF frames used for section 4.4.
* `extension_before_fbb4a16.ts` - the removed command implementations (6.2).
