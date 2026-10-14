# 06 - Extension core / lifecycle glue: defect hunt, packaging audit, rewrite blueprint

Scope: `mpy-workbench` v0.3.2 (HEAD `7cb90c7`, 2026-04-04), mainly `src/extension.ts` (1185 lines), plus `src/actions.ts`, `src/syncView.ts`, `src/decorations.ts`, `src/test.ts`, `src/esp32Fs.ts`, `src/localFilesView.ts`, and the parts of `mpremote.ts` / `mpremoteCommands.ts` / `pythonInterpreter.ts` / `sync.ts` that the glue depends on. Other analysts own interpreter discovery, REPL/run, and sync/FS internals. Where my findings overlap theirs, I say so and keep it short.

All paths below are relative to `../mpy-workbench/` unless absolute.

## 0. Method and evidence legend

Nothing in the old tree was modified. No serial port was opened, probed, or listed. No mpremote command touched a device (mpremote is not even installed on this Mac: `which mpremote` -> not found; `python3` is `/usr/local/bin/python3`).

| Tag | Meaning |
|---|---|
| **[EXEC]** | I ran code and observed the result (in the scratchpad, never against hardware). |
| **[SRC]** | I read the source and believe it; not executed. |
| **[VSC]** | I read VS Code's own bundled source (`/Applications/Visual Studio Code.app`, **v1.141.0**) to confirm host behaviour. |
| **[GIT]** | Established from `git log` / `git show` (read-only; `--no-optional-locks`). |
| **[INF]** | Inference from documented platform behaviour; could not be tested on this machine (mostly Windows). |

Environment: macOS 24.6 (Darwin), x64, Node v26.5.0, npm 11.17.0, TypeScript 5.9.2, `@types/vscode` **1.103.0** installed (package.json asks `^1.84.0`), VS Code 1.141.0 installed locally.

### The headless harness (how the [EXEC] results were produced)

Scratchpad: `<scratchpad>/`

* `build/` - copy of old `src/` + tsconfig compiled with the old toolchain (`tsc -p .`, strict). Output is byte-identical to the committed `dist/` for all 17 modules (see 3.10), so the harness runs exactly what ships at HEAD.
* `harness/vscode-stub.js` - a ~100-line fake `vscode` module. It records config writes, view creation, commands, notifications, and **validates view ids and command ids against the real `package.json`** (so a missing contribution behaves the way it would in VS Code).
* `harness/bin/fakepython` - a node script standing in for "the venv python". It answers `-c` and `-m mpremote --version`, and for any other `-m mpremote ...` it logs `{pid,args,t0,t1}` to a JSONL timeline and exits after 400 ms. It never opens a serial port.
* `harness/bin_global/mpremote` - a fake *global* `mpremote` so that interpreter validation can be made to pass/fail on demand.
* `harness/driver.js`, `cancel-test.js`, `refresh-test.js` - the scenarios. Raw output of the main run: `harness/activate-run.txt`.

This pattern (fake interpreter + fake `vscode` + timeline) is cheap and gave strong evidence. I recommend carrying it into the new project's test suite (section 7).

---

## 1. Executive summary

`tsc --strict` is already clean (tsconfig has `"strict": true`) [EXEC]. The compiler is not the problem. The extension fails because of **lifecycle and contract errors that no type checker sees**: it deletes the user's port setting on every start, advertises ten commands that nothing implements, has two "mutexes" that do not mutex, validates the wrong `mpremote`, and uses POSIX-only shell quoting. A beginner experiences all of these as "it just seems so buggy".

Top defects ranked by likelihood of producing the *"it's so buggy"* feeling for a sophomore (P = probability a typical student hits it in the first session; S = severity once hit):

| # | Defect | Where | Evidence | P | S |
|---|---|---|---|---|---|
| 1 | **Activation overwrites `mpyWorkbench.connect` with `"auto"` in the user's *global* settings every start**; Run/REPL/Stop/Interrupt then refuse ("Select a specific serial port first (not 'auto')"), Files view is blank, and a hand-edited settings.json port is silently erased | `src/extension.ts:187`; consumers `mpremoteCommands.ts:170,246,367,427`; `esp32Fs.ts:118-121` | [EXEC] + [SRC] + [GIT] (since initial commit) | very high | high |
| 2 | **Ten contributed commands have no handler**: every tree context-menu action (rename, delete, delete board+local, new file, new folder, sync file L->B, B->L, open from local) and `refreshPorts`. Clicking gives "command 'mpyWorkbench.renameNode' not found" | `package.json` commands vs `extension.ts`; regression introduced by commit `fbb4a16` | [EXEC] + [GIT] | very high | high |
| 3 | **Interpreter validation checks a global `mpremote` on PATH, not `<python> -m mpremote`**, and mis-classifies ENOENT; a `.venv` that has mpremote is rejected and even an explicit `mpyWorkbench.pythonPath` is silently ignored; falls back to `python3` and caches it 30 s (this is the user's complaint #1) | `src/pythonInterpreter.ts:229-246`, `:105-107` | [EXEC] | very high (for venv users) | critical |
| 4 | **No effective serialisation of mpremote calls**: `ConnectionManager.markHealthy()` clears the "in progress" flag right after it is set, and `withAutoSuspend()` resets its queue on every call. Three quick saves -> **3 simultaneous mpremote processes on one port** | `mpremote.ts:63-71,156-167`; `extension.ts:278-301` | [EXEC] | high | high |
| 5 | **Windows quoting regression**: HEAD wraps every argument in POSIX single quotes and runs it via `exec` (cmd.exe on Windows, which does not understand `'`) | `mpremote.ts:7-9,181`; `mpremoteCommands.ts:8-17,253-257` | [SRC]+[GIT]+[INF] | ~certain on Windows | critical |
| 6 | **"Run file" reuses one terminal and `sendText`s the next command into it**; if the previous run is a `while True:` loop (normal in ESP32 class) the new command is never executed | `mpremoteCommands.ts:215-226` | [SRC] | high | high |
| 7 | **Sync-all (L->B) reports success no matter how many files failed**, saves the manifest as if everything uploaded, and "Cancel" kills one child while the loop carries on with the next file | `extension.ts:767-822` | [SRC] | medium | high (data) |
| 8 | **One click on a title-bar icon overwrites all local files from the board** (no confirmation), placed next to the upload icon | `package.json:258-262`; `extension.ts:831-866` | [SRC] | medium | high (loses student work) |
| 9 | **"Refresh" does not refresh**: the 30 s whole-board `fs tree` cache is not invalidated | `extension.ts:333-338`; `mpremote.ts:255-309,778` | [EXEC] | high | medium |
| 10 | **Auto-mirror (the headline feature) needs two hidden prerequisites** (Initialize Workspace, then toggle AutoSync; default off) and, once enabled, every save spams a warning toast if the port is `auto` (which is always after defect 1) | `extension.ts:221-243,1093-1128` | [SRC]+[EXEC] | high | medium |

Further notable items: `createTreeView("mpyWorkbenchLocalFilesView")` for a view that is not contributed -> error toast at every activation [VSC]+[EXEC]; `untrustedWorkspaces.supported: true` while the activation path executes a workspace-settable interpreter path [SRC]; hard-coded extension ID `DanielBucam.mpy-workbench` used for icon URIs [SRC]; Windows path-separator regex bug in "Upload Active File" [EXEC]; stop/interrupt implemented as `echo -e '\x03' > <port>` [EXEC on macOS]; remote windows cannot see USB [analysis in 3.9].

Verdict input for the fix-vs-rewrite decision: see section 4. Short version: **rewrite the core/glue, keep the UX contract** (views, commands, menus, status bar, decorations, ignore-file idea).

---

## 2. Results of execution (summary table)

| Experiment | Command (in `harness/`) | Observed |
|---|---|---|
| Venv-only mpremote: `mpyWorkbench.pythonPath` -> venv python that *does* have mpremote; nothing named `mpremote` on PATH | `PATH=/usr/bin:/bin node driver.js discovery` | `resolved: "python3"` (the explicit setting is ignored, no notification, 1.9 s wasted). **Reproduces complaint #1.** |
| Activation with the user's port preset to `/dev/cu.usbserial-FAKE` | `node driver.js activate` | `connect before activate: /dev/cu.usbserial-FAKE -> after activate: auto`; exactly one config write: `{key:"mpyWorkbench.connect", value:"auto", target:1 (Global)}` |
| View contract | same run | `mpyWorkbenchLocalFilesView contributed:false` -> "No view is registered with id ..." |
| Command contract | same run | 39 commands registered; **10 contributed-but-unregistered** (list in 3.1); invoking `mpyWorkbench.renameNode` -> `command 'mpyWorkbench.renameNode' not found` |
| Concurrency A: three tree listings at once (`autoSuspendLs` x3) | same run | Serialised (max 1 at a time) but **13 mpremote processes** for 3 listings (caveat: my fake returns empty trees, which forces the slow fallbacks; with a real board the count is lower but `ensureIdle` still adds one `fs tree`/`ls` before every operation) |
| Concurrency B: Ctrl+S three times with auto-sync on | same run | `fs tree` x3 at +0 ms, `fs ls` x3 at +~680 ms, `fs cp` x3 at +~1400 ms. **MAX SIMULTANEOUS on the same port = 3** |
| Refresh button | `node refresh-test.js` | first listing spawns 1 process; after `mpyWorkbench.refresh`, second listing spawns **0** (served from the 30 s cache) |
| Cancel | `node cancel-test.js` | On macOS `cancelAll()` kills the child (bash `-c` single-command exec optimisation); the pending promise rejects with a raw "Command failed: '/path/python' -m mpremote ..." message. Windows behaviour not testable here (see 3.6) |
| `uploadActiveFile` regex on a Windows relative path | `node -e` | `'src\\foo.py'.replace(/\\\\/g,'/')` -> `src\foo.py` unchanged. The sibling regex in the save handler (`/\\/g`) works. |
| Stop/Interrupt shell string, redirected to a scratch file instead of a tty | `exec("echo -e '\\x03\\x03' > file")` + `od -c` | bytes are `- e <space> 03 03 \n`: macOS `/bin/sh` echo prints a literal `-e ` before the Ctrl-C bytes |
| Default ignore matcher with no `.mpy-workbench/.mpyignore` | `createIgnoreMatcher` | `.venv/...` **not ignored**, `venv/...` not ignored, `*.pyc` not ignored (only `.git`, `__pycache__`, `.vscode`, `node_modules`, `dist`, `out`, `build`, `.DS_Store`, `.mpy-workbench` are) |
| Compile against the declared engine's API | `tsc --noEmit --skipLibCheck` with `@types/vscode@1.84.0` | clean: no API newer than 1.84 is used |
| Extra strictness (`--noUnusedLocals --noUnusedParameters --noImplicitReturns ...`) | `tsc --noEmit ...` | 68 findings: 62 unused declarations (TS6133), 5 `process.env.X` index-signature (TS4111), 1 unused import list. Saved in `scratchpad/tsc-strict-extra.txt`. Mostly dead code (3.11), not bugs. |
| `vsce package` today | in a scratch copy with a real `node_modules` copy | default run: `ERROR Extension entrypoint(s) missing ... extension/dist/extension.js` (vsce 2.15.0 + npm 11.17 + node 26); `vsce package --no-dependencies`: `DONE Packaged ... (56 files, 2.04MB)`. See 3.10 for caveats. |

---

## 3. Findings in detail

### 3.1 Activation, manifest <-> code contract

**Activation events.** `package.json:24-26` lists only `onLanguage:python`. This is *less harmful than it looks*: VS Code generates `onView:<id>` for every contributed view (confirmed in the 1.141 bundle: the `views` extension point carries an `activationEventsGenerator` that yields `onView:${id}`) and `onCommand:` for contributed commands (engines >= 1.74). So clicking the activity-bar icon does activate the extension [VSC].
What *is* wrong: status-bar items, the save handler and watchers exist only after activation, i.e. after the first `.py` is opened or the sidebar is revealed. Nothing activates on `workspaceContains:` (e.g. `boot.py`, `main.py`, `.mpy-workbench`). Minor, but a "mirror" that silently is not running until you open a view is confusing. Add `workspaceContains:**/{boot,main}.py` and `workspaceContains:.mpy-workbench/**` (or whatever the new config dir is).

**`activate()` is synchronous and returns `void`** - good (no awaits to stall startup). But it does *work with side effects* in the middle of registration: it writes the user's settings (3.2), spawns the interpreter-validation processes (`extension.ts:38` -> `mpremoteCommands.ts:75-108`), and creates a view that does not exist (below).

**Contributed vs registered commands** [EXEC; cross-checked with a script over `package.json` and `src/*.ts`]:

* Contributed in `package.json` but **no handler anywhere** (10): `mpyWorkbench.delete`, `deleteBoardAndLocal`, `newFileBoardAndLocal`, `newFileInTree`, `newFolderInTree`, `openFileFromLocal`, `refreshPorts`, `renameNode`, `syncFileBoardToLocal`, `syncFileLocalToBoard`.
  These are exactly the `view/item/context` menu of the Files view (`package.json:294-355`) minus `openFile`. So **right-clicking a file or folder on the board offers 9 actions of which 1 works.**
  Cause [GIT]: commit `fbb4a16` ("Add local files tree view and upload functionality", 2026-02-12) deleted these `registerCommand` calls from `extension.ts` (362 lines changed) and left the manifest untouched. `src/boardOperations.ts` (551 lines) still has `delete()`, `mkdir()`, `openFile()`, `syncBaseline*()` methods and is instantiated at `extension.ts:204` but never used - the half-finished refactor target.
* Registered but **not contributed** (16, harmless for programmatic use but unreachable from UI): `autoSuspendLs` (internal), `cancelAllTasks` (status-bar only), `debugFilesystemStatus`, `debugTreeParsing`, `refreshFileTreeCache`, `rebuildManifest`, `stopSerial`, `downloadFileFromBoard`, `uploadToBoard`, `localOpen`, `localCut`, `localCopy`, `localCopyPath`, `localCopyRelativePath`, `localRename`, `localDelete`. (`mpyWorkbench.rename` appears in the grep because it lives in a trailing `/* ... */` comment at `extension.ts:1156-1185`; it is not registered.)

**The Local Files view.** `extension.ts:196-197` calls `createTreeView("mpyWorkbenchLocalFilesView", ...)`, but `package.json` contributes only `mpyWorkbenchFsView`, `mpyWorkbenchActionsView`, `mpyWorkbenchSyncView` (`package.json:64-81`). In VS Code 1.141 the main thread handles an unknown tree-view id with `notificationService.error("No view is registered with id: " + id)` [VSC, `$registerTreeViewDataProvider`], so `activate()` does not throw (I initially suspected it would abort activation; the bundle shows it does not) but **every activation shows a red error toast** to the user. The 8 commands that feed this view (`localOpen/Cut/Copy/CopyPath/CopyRelativePath/Rename/Delete` plus `uploadToBoard`) are therefore dead, and `localFilesView.ts` (97 lines) is unreachable.

**Other manifest hygiene** (`package.json`): duplicate key `extensionPack` (lines 12 and 19); `contributes.css` (lines 61-63) is not a VS Code contribution point and `item.className` in `esp32Fs.ts:39` is not a TreeItem property - the "styled Select Serial Port button" never existed; `customEditors: []`; `extensionDependencies: []`; `viewsWelcome` only for the Files view (Actions and Sync views are always populated even with no port/workspace); no `license` field (LICENSE file exists, MIT); `vsce` devDependency is the deprecated `vsce` package, not `@vscode/vsce`.

### 3.2 Port selection, `auto`, and `setContext`

* `extension.ts:181-188`:
  ```ts
  const updatePortContext = () => { const v = getConfiguration().get("mpyWorkbench.connect","auto"); const has = !!v && v!=="auto"; executeCommand('setContext','mpyWorkbench.hasPort',has); };
  // Ensure no port is selected at startup
  vscode.workspace.getConfiguration().update("mpyWorkbench.connect", "auto", vscode.ConfigurationTarget.Global);
  updatePortContext();
  ```
  [GIT] This has been there since the initial commit (it is deliberate: "Ensure no port is selected at startup").
  Consequences:
  1. Writes the **user-level** settings.json on every activation. If that file is read-only, locked by roaming-profile sync, or contains a JSON syntax error (common), the un-awaited promise rejects -> unhandled rejection, no user message.
  2. Every new VS Code window re-activates the extension and resets the port **for all open windows** (it is a global setting). Open a second project and the first one's Run button starts failing.
  3. A port that the student (or the instructor's lab image) put in settings.json is destroyed.
  4. `updatePortContext()` runs immediately after the un-awaited `update()`, so it can read the *old* stored value ([INF]: VS Code's in-memory configuration only changes when the write completes); it is only corrected later by `onDidChangeConfiguration` (`extension.ts:890-893`).
  5. If a workspace-level `mpyWorkbench.connect` exists (`.vscode/settings.json`), `pickPort`/`setPort` still write **Global** (`extension.ts:459,550`), so the effective value does not change and picking a port appears to do nothing.
* `"auto"` means three different things: `mpremote connect auto` for listing/tree operations (works), "hard error" for Run/REPL/Stop/Interrupt (`mpremoteCommands.ts:170-173,246-248,367-370,427-430`; `mp.mkdir/cp*` also throw `"Select a specific serial port first"`), and "empty tree" in `Esp32Tree.getChildNodes` (`esp32Fs.ts:118-121`). A "just works" tool should resolve `auto` to the single recognised board once, remember it, and use it everywhere.
* `hasPort` is the only context key. It gates only the Files view's welcome text. When a port is set but listing fails, the tree returns `[]` (`esp32Fs.ts:238-249`) with no welcome and no message -> **blank panel**. The error toast is suppressed by a substring filter (`message.includes("serial port") || includes("auto")`), which will also swallow unrelated errors that merely contain "auto".
* `Esp32Tree.getChildNodes` also declares a `"no-port"` node type (`esp32Fs.ts:7,28-41`) that is never returned: dead code.
* **No port polling, no hot-plug awareness** (there are no timers for ports; `refreshPorts` is contributed but unimplemented). A board plugged in after VS Code starts is invisible until the user re-runs "Select Serial Port". `listSerialPorts` (`mpremote.ts:849-879`) shells out to `mpremote connect list`; the generic `runMpremote` treats the word `list` as a "port" for its bookkeeping (`mpremote.ts:152-155`, harmless but telling), and if nothing is found it tells the user "Make sure mpremote is installed and available in PATH" (`:872`), which is the wrong advice for the `.venv` case.

### 3.3 Concurrency, queueing, re-entrancy

Intent: "auto-suspend" - close the REPL terminal, run an mpremote op, reopen the REPL. Reality:

1. **`ConnectionManager` mutex is a no-op** (`mpremote.ts:29-131`, used at `:150-168`). Order of calls: `markOperationStarted(port)` (sets `operationInProgress = true`, line 165) then immediately `markHealthy(port)` (line 167), and `markHealthy` *sets `operationInProgress = false`* (line 69). So the flag is false again before anything else can look at it. [EXEC: three concurrent saves ran as three simultaneous processes.]
   Even if it worked, the wait loop `setTimeout(executeCommand, 100)` (line 159) re-enters `executeCommand`, which does `attempt++` first (line 148), so waiting burns the retry budget, and there is no upper bound on waiting.
2. **`withAutoSuspend` "preempt" forgets the queue** (`extension.ts:278-301`): for every caller except `autoSuspendLs` (which passes `preempt:false`), line 281-283 does `opQueue = Promise.resolve()`. That does not cancel anything; it detaches the new operation from whatever is already running. Combined with (1) there is *no* mutual exclusion for saves, uploads, syncs, deletes, mkdirs.
   A second `withAutoSuspend` nested inside the first (`syncBaseline` at `:593` and `:791`) only works because of this reset; with `preempt:false` it would deadlock.
3. **`skipIdleOnce` is a process-global one-shot flag** (`extension.ts:267-268,285-289,1079-1089`). Every sidebar item routes through `mpyWorkbench.runFromView`, which arms the flag, then runs the real command. Of the five Actions items, none of Run/Open REPL/Stop/Soft Reset/Interrupt calls `withAutoSuspend`, so the flag stays armed and is **consumed by the next unrelated operation** (a tree listing, an auto-upload on save), which then skips `ensureIdle`/REPL disconnect and, per line 285, bypasses the queue entirely. Result: occasional "port in use" failures that depend on which button you clicked ten seconds earlier. [SRC]
4. **`ensureIdle()` runs `mp.ls("/")` before every operation** (`extension.ts:269-277`), swallowing its error (`catch {}`). `lsTyped` is implemented via a full `mpremote fs tree` of the *entire* board when the 30 s cache is cold (`mpremote.ts:260-302,772-795`), then falls back to `fs tree` again and `fs ls` for empty directories. So a single upload-on-save costs at least a tree, possibly several lists, then the copy. With real raw-REPL entry cost (~1-2 s per mpremote invocation) a save takes seconds and holds the port the whole time.
5. **Run/REPL/Stop are outside any queue.** `runActiveFile` (`mpremoteCommands.ts:164-227`) calls `mp.fileExists` (an mpremote process) and then types the run command into a terminal; the REPL terminal holds the port as a long-lived `mpremote connect`; the tree/save paths close it with a Ctrl-X keystroke. There is no state machine ("idle / busy(op) / repl / running program"), only "is a terminal object alive".
6. **No timeouts anywhere** on `exec` (`mpremote.ts:184`; `getMpremoteExecOptions` has no `timeout`, no `maxBuffer` beyond the 1 MiB default). A wedged board or a prompt waiting for input blocks the queue forever; the only escape is the cryptic permanent status-bar item "MPY: Cancel".
7. **Cancellation** (`mp.cancelAll`, `mpremote.ts:1574-1577`): kills only `currentChild` (the most recently started process) with SIGKILL on the *shell*; resets `opQueue`; does not stop the calling loops (so `syncBaseline` proceeds to the next file) and rejects the in-flight promise with a raw "Command failed: '<python>' -m mpremote ..." string, which `syncBaseline`'s per-file `catch` merely counts as `failed++`. [EXEC on macOS: child killed. INF on Windows: `exec` runs `cmd.exe /d /s /c "<python> ..."`; Node's `child.kill()` on Windows terminates cmd.exe, not the grandchild python, so mpremote keeps the port open and the next command fails with "may be in use by another program".]
8. `runMpremote` is `new Promise(...)` wrapping an `async executeCommand` invoked with `void`: any synchronous throw inside it (bad `cwd`, spawn failure inside `exec`) is an unhandled rejection and **the outer promise never settles** (`mpremote.ts:142-233`). The UI then waits forever.

### 3.4 Error surfacing, progress, logging, i18n

* ~300 `console.log("[DEBUG] ...")` calls (`mpremote.ts` 159, `extension.ts` 62, `boardOperations.ts` 46, `mpremoteCommands.ts` 30) go to the extension-host console, which students never see; there is no `OutputChannel`/`LogOutputChannel`. When something goes wrong the user has no log to attach. Full `fs tree` output and the entire parsed tree are logged at every listing.
* Empty `catch {}` blocks: `extension.ts` 6 (e.g. `:272` swallowing the very error that says "no board", `:74,:84,:909,:1118,:1145`), `mpremoteCommands.ts` 4 (`:33,:48` REPL disconnect/restart; `:142` soft-reset fallback and `:199` file-exists probe have only a comment inside), `mpremote.ts` 1, `boardOperations.ts` 2, `esp32Fs.ts` 1, `sync.ts` 1.
* `showErrorMessage` vs `console`: mixed. Some failures are toasts, some only console (`restartReplInExistingTerminal` is entirely silent). `syncBaseline` swallows per-file failures (see 3.7).
* **Mixed languages.** User-facing strings in Spanish in the activation path: `mpremoteCommands.ts:82` ("mpremote no encontrado en el interprete Python activo..."), `:92-94` ("Como actualizar"), `:103`; plus Spanish source comments and the whole CHANGELOG. The first thing a US sophomore sees when mpremote is missing is a Spanish warning.
* **Progress UI**: `withProgress(Notification, cancellable:false)` only for Sync-all (up/down) and Clear Device. Everything else, notably **auto-upload on save, single-file upload, tree listing, Run**, has no progress and no success feedback (only a 3-second status-bar message when auto-sync is *off*, `extension.ts:1105`). The student cannot tell whether the board has their latest code. Progress arithmetic in `syncBaseline` overshoots 100 (5+10+80+100).
* No telemetry and no hidden network use [SRC: grep for `http`, `fetch`, `request`, `telemetry`, `analytics`]. The only URLs are `openExternal` on an explicit user click (`mpremoteCommands.ts:71`) and a PyPI URL in a message string. This is a *good* property worth keeping.

### 3.5 Save handler, watchers, mirror semantics

`extension.ts:1093-1128` (`onDidSaveTextDocument`): fires for *every* saved document in the window.
* Per save it runs `fs.access(manifest)` (initialised?), `mkdir -p .mpy-workbench`, reads `config.json`, reads `.mpyignore` and compiles ~30 regexes, then `withAutoSuspend(cpToDevice)`. Cheap compared with the mpremote part, but there is **no debounce, coalescing, or per-file in-flight guard**: Ctrl+S x3 = 3 uploads of the same file, concurrently (defect 4). No `doc.uri.scheme === "file"` check.
* Gating: nothing happens unless `.mpy-workbench/esp32sync.json` exists (i.e. the user ran "Initialize Workspace") **and** auto-sync is enabled (`config.json` or setting, default `false`). The status-bar items are hidden unless initialised (`:221-243`). The manifest itself is *write-only*: `loadManifest`/`diffManifests` are imported but never called (TS6133 in the extra-strict compile; "Check for differences" was removed in 0.3.1), so "initialised" is a vestigial gate on a file nothing reads. It also stores the absolute workspace path (`root:`) and `tree-paths.json` is rewritten on each listing (`mpremote.ts:272-285`), so students will commit machine-specific paths to git.
* When auto-sync is on and the port is `auto` (always, after defect 1), every save shows `Board auto-upload failed for <file>: Select a specific serial port first` (`:1126`).
* Watchers: `.mpystudio/config.json` (`:248`) is a stale name from a rename (the directory is `.mpy-workbench`), so hand-edits of the config never refresh the status bar; the manifest watcher at `:254` is correct. Only the first workspace folder is ever considered (`workspaceFolders?.[0]` throughout) - multi-root workspaces silently use folder 0.
* `uploadActiveFile` (`:895-922`): `rel.replace(/\\\\/g, '/')` at `:904` and `:911` has one backslash too many, so on Windows `src\foo.py` is not converted and the destination becomes `/src\foo.py` (a single file with a backslash in its name, or an mpremote error). [EXEC]
* `openFile` (`:924-973`): "Open File from board" opens the **local** copy if it exists, so board-side changes are never shown. (By design for "mirror", but the label lies.)
* Data safety: `syncBaselineFromBoard` (`:831-866`) overwrites local files with no prompt, reachable from a title-bar icon beside the upload icon (`package.json:258-262`); it has no try/catch and aborts mid-way on the first failure leaving a half-overwritten tree. `syncBaseline` (`:558-829`): per-file failures are counted into `failed` (`:799-800`) but the progress message at `:813` is unconditionally "All files uploaded successfully", the manifest is saved at `:818-819`, and the toast at `:822` says "completed". Cancel does not stop the loop. Default ignores lack `.venv`/`venv`/`*.pyc` (3.10.3), and the `.mpyignore` that adds them is only written by "Initialize Workspace"/"rebuildManifest" (`:77-86`), never by `syncBaseline`, so deleting or never creating that file makes Sync-all try to push the `.venv` into a 4 MB flash.

### 3.6 Disposables, singletons, timers, `deactivate`

* Registered in `context.subscriptions`: four tree views, all commands, config listener, save listener, terminal-close listener, two watchers, two status-bar items, file-decoration provider. Not disposed: the `EventEmitter`s inside the tree providers (trivial).
* `deactivate()` is empty (`extension.ts:1153`). `mp.cleanupConnections()` (`mpremote.ts:1739-1742`) exists and is never called, so on window close/reload: the `setInterval` health-check timer (`mpremote.ts:107`) is created at **module import time** and never cleared (it also does nothing useful - it only prunes a Map); a running mpremote child is not killed.
* Process-wide mutable singletons: `(global as any).esp32Decorations` (`extension.ts:201`, read from `esp32Fs.ts:172` - an untyped back-channel), `currentChild`, `connectionManager`, `globalFileTreeCache`/`lastTreeUpdate` (`mpremote.ts`), `replTerminal`, `runFileTerminal` (`mpremoteCommands.ts`), `PythonInterpreterManager` static cache, and closure variables `opQueue`, `listingInProgress`, `skipIdleOnce`, `lastLocalOnlyNotice` in `activate`. None are tied to the extension's lifetime or to the workspace.
* **REPL terminal lifecycle** [SRC/INF; REPL analyst owns the details]: the REPL is a terminal created with `shellPath` + `shellArgs: ["-lc", cmd]` (or `cmd.exe /d /c cmd`), i.e. the shell *is* mpremote (`mpremoteCommands.ts:254-258`). "Suspend" types Ctrl-X (`:31`), which makes mpremote exit, which ends the terminal's only process. "Resume" (`restartReplInExistingTerminal`, `:37-49`) then `sendText`s `mpremote connect ...` into that now-dead terminal inside an empty `catch {}`. `onDidCloseTerminal` (`extension.ts:1129-1134`) has an empty branch for "ESP32 REPL" and does not clear `replTerminal`. The "auto-suspend then reopen" feature that the whole queue design exists to support therefore most likely cannot reopen.
* `Run file` terminal reuse (`mpremoteCommands.ts:215-226`, added by "Enhance reuse terminal when Run file", PR #18/#19): when the previous run is still alive the new text is queued behind the foreground `mpremote run`, not executed. Students will naturally write `while True:` loops, edit, press Run again, and see nothing happen. **Strong candidate for the "run current file didn't seem to even work" complaint**, in addition to defects 1 and 3.
* Stop/Interrupt/Reset (`mpremoteCommands.ts:392,453,484`): `exec("echo -e '\\x03\\x03' > ${devicePort}")`: POSIX shell syntax, unquoted port, writes to the tty from outside mpremote (opening a tty from a shell redirect toggles modem-control lines, which on common ESP32 dev boards can reset the chip - [INF], not tested because no port may be touched). On macOS `/bin/sh` it also types a literal `-e ` into the REPL [EXEC]. On Windows, cmd.exe's `echo` writes the literal text `-e '\x03\x03'` to `COMn`. `healthCheck` first runs a full `fs tree` (`mpremote.ts:1580-1593`) just to decide whether to print a warning. The sidebar "Stop"/"Interrupt" buttons route here.

### 3.7 Interpreter resolution (overlap with discovery analyst; kept because activation triggers it)

* `validatePythonPath` (`pythonInterpreter.ts:229-246`) runs `<python> -c "import sys..."` and then **`execFile('mpremote', ['--version'])`, i.e. whatever `mpremote` is on VS Code's PATH**, ignoring the interpreter being validated. For a venv that has mpremote but whose `bin/` is not on VS Code's PATH (the normal situation when VS Code is launched from the Dock/Start menu), validation fails with `spawn mpremote ENOENT`. The "missing mpremote" detector requires the text `not found` (`:240-243`), which ENOENT's message does not contain, so the failure is classified as "other error", no install prompt is shown, and every method falls through. After the fallback list is exhausted it returns `'python3'` and **caches that for 30 s** (`:105-107`, `:14`). [EXEC, section 2]
* Consequences chain: `runMpremote` builds `'<python3>' -m mpremote ...` (HEAD) which fails with "No module named mpremote" -> error toast with Python's stderr; `checkMpremoteAvailability` (`mpremoteCommands.ts:75`) shows the Spanish warning.
* The shipped `.vsix` (0.3.2) is older than HEAD: its `dist/mpremote.js` runs bare `mpremote ...` from PATH (line 182 of the vsix's `dist/mpremote.js`; no `shellEscape`), i.e. it **never** looks at the venv. HEAD adds `-m mpremote` via `getPythonPath` but with the broken validation above. So both artefacts fail for a venv-only install; which one the user ran is unknown.
* The "Install mpremote" button (`pythonInterpreter.ts:294`) runs `<pythonPath> -m pip install mpremote` through an unquoted `exec`: breaks on paths with spaces (typical Windows `C:\Users\First Last\...`), does not surface pip's stderr, and on Homebrew/Debian Python hits PEP 668 "externally-managed-environment".
* Fallback list on Windows starts with bare `python` (`:204-206`): on a fresh Windows 10/11 this resolves to the Microsoft Store alias stub, and `'py -3'` is an *argument-bearing string* that `execFile` cannot spawn. On macOS the list includes `/usr/bin/python3`, which on a Mac without Command Line Tools pops the "install developer tools" dialog just from validation. [INF]

### 3.8 Windows parity (cross-cutting, [SRC]/[GIT]/[INF])

* `shellEscape` (`mpremote.ts:7-9`, duplicated in `mpremoteCommands.ts:8-10`) produces `'arg'`; commands are run with `exec` (shell = `cmd.exe` on Windows) and terminals use `cmd.exe /d /c`. `cmd.exe` treats `'` as an ordinary character, so `'C:\...\python.exe' -m mpremote 'connect' 'COM3' 'fs' 'ls'` fails with "'C:\...' is not recognized as an internal or external command" - **every board operation on Windows**. [GIT] The previous commit (before `7cb90c7`) used double quotes, which cmd.exe accepts; HEAD's "Refactor mpremote command execution to use Python interpreter" introduced the regression while fixing the PATH problem. README itself lists "Full Windows validation" as an open roadmap item.
* Only ESP32-S3/C3 were tested by the author (README); the target hardware here is a classic ESP32 with a CP2102 bridge.
* `mvOnDevice` pre-wraps paths in `"..."` before `runMpremote` quotes them again (`mpremote.ts:1727-1729`), so mpremote receives literal quote characters. (FS analyst: confirm; nothing calls it right now because the rename command is unregistered.)
* Hard-coded POSIX assumptions: `echo -e > port`, `/dev/` prefix handling in `normalizeConnect` (`mpremote.ts:11-24`), `SHELL` env use (`mpremoteCommands.ts:256`), `-lc`.
* Correct approach: never build a shell string. `spawn(file, argv, {shell:false, windowsHide:true})`; for terminals, build the command line per OS with a tested quoting function (or use `Pseudoterminal`/`TerminalOptions.shellPath` with argv arrays).

### 3.9 Untrusted / virtual / remote workspaces and `extensionKind`

* **Untrusted workspaces** (`package.json:14-18`): `"untrustedWorkspaces": { "supported": true }` declares the extension safe in Restricted Mode. It is not: at activation `checkMpremoteAvailability` -> `getPythonPath` reads `mpyWorkbench.pythonPath` and `python.defaultInterpreterPath` from **workspace settings** and executes them (`validatePythonPath` runs `execFile(pythonPath, ['-c', ...])` at `pythonInterpreter.ts:232`, and `getPythonPath` tries the `mpyWorkbench.pythonPath` override first at `:27-45`; [SRC], I did not log that spawn in the harness). A cloned assignment repo with `.vscode/settings.json` containing `{"mpyWorkbench.pythonPath": "./x.sh"}` runs code the moment the folder is opened without trust. Students download assignment folders from LMSs all the time. Fix: `supported: "limited"` with `restrictedConfigurations: ["mpyWorkbench.pythonPath", "mpyWorkbench.mpremotePath", ...]`, mark executable-path settings `scope: "machine-overridable"` or `"machine"`, and gate process spawning on `vscode.workspace.isTrusted`.
* **Virtual workspaces**: no `capabilities.virtualWorkspaces`; the code assumes `file:` URIs and `fsPath` everywhere. Declare `{ supported: false, description: ... }` and degrade with a message.
* **`extensionKind: ["workspace"]`** (`package.json:13`): in a *local* window this is irrelevant (single extension host on the same machine as the USB port). It matters in remote windows:
  | Situation | `["workspace"]` (current) | If `["ui"]` | Consequence for the class |
  |---|---|---|---|
  | Lab PC or student laptop, plain local window | works | works | the supported case; both macOS and Windows |
  | Remote-SSH to a campus Linux box | runs on the server; `mpremote connect list` sees the server's ports, not the student's USB; the "No devices detected ... available in PATH" message is misleading | runs locally and sees the board, but all `fs`/`path`/`fsPath` operations then touch the *local* disk with a *remote* path -> wrong or failing | unsupported either way unless I/O goes through `vscode.workspace.fs` |
  | WSL window on Windows | runs in WSL: no `COMn`, WSL2 has no USB without usbipd | local, same problem as above | tell the student to reopen the folder locally ("Reopen Folder Locally") |
  | Dev Container (Docker Desktop on Mac/Win) | no USB passthrough | same | same |
  | Codespaces / github.dev / vscode.dev | extension has no `browser` entry, so it is not even loaded on the web; in desktop-attached Codespaces it runs in the container: no USB | - | MicroPython needs a local install; nothing the extension can do (Web Serial cannot speak mpremote) |
  Therefore my earlier hypothesis "extensionKind should be `ui`" is **only half right**: `ui` fixes device visibility but breaks workspace-file mirroring in the same remote window. The only architecture that supports remote windows is a `["ui","workspace"]` extension that performs all workspace file access via `vscode.workspace.fs` (URI-based) and copies through temp files for `mpremote fs cp`. That is significant extra work for a use case the course does not need. **Recommendation:** keep local-only; detect `vscode.env.remoteName !== undefined` (and non-`file` workspace scheme) at activation and show one clear, localized message ("Serial boards are only reachable from a local VS Code window. Use Remote Explorer > Reopen Folder Locally.") while disabling board commands; list remote support as a later, optional phase.
* **Lab-machine specifics**: roaming profiles share the *User* settings across machines, so a global `mpyWorkbench.connect` set on one PC (`COM3`) follows the student to another PC where it is wrong; this is another reason the port must live in `workspaceState` (per machine) plus a remembered device identity, never in global settings. Locked-down images may have no Python on PATH and forbid system-wide `pip install` (admin), so the extension should prefer/offer creating a workspace `.venv` and installing mpremote there with explicit consent. Antivirus scanning makes each Python process start slow (1-3 s), which makes the "one mpremote per micro-action" design (3.3) painful.

### 3.10 Packaging and repository hygiene

1. **`.vsix` committed to git** (`mpy-workbench-0.3.2.vsix`, 5.0 MB; commit message of `7cb90c7` says it was updated). Contents [EXEC: unzipped to scratchpad]: 772 files, 11.6 MB uncompressed, **including a developer virtualenv `extension/.venv/` (10 MB: Python 3.9.6 from Apple CLT, pip 25.2, `rshell`, `pyboard`, `pyserial`, `pyudev`, no mpremote)** because `.vscodeignore` does not exclude `.venv`. It also contains `scripts/mpremote_tool.py`, which is not in the repo. Its `package.json` equals HEAD's, but its `dist/mpremote.js` and `dist/mpremoteCommands.js` are **older than HEAD** (no `shellEscape`/`-m mpremote`), so the committed binary does not correspond to the committed source.
2. **`node_modules/` (49 MB, 3,174 tracked files) and `dist/` are committed** (`git ls-files | grep -c node_modules` -> 3174), `.git` is 31 MB. `.gitignore` is 65 bytes: `.DS_Store`, `*.py`, `.mpyignore`, `.cursor`, `.mpy-workbench`, `.mpy-workbench-*`. It does **not** ignore `node_modules`, `dist`, `*.vsix`, `.venv`, and it **does** ignore `*.py` - the repo's four Python helpers are tracked only because they were force-added; any new helper script will be silently dropped by `git add`.
3. `.vscodeignore` excludes `src/**` but not `.venv`, `assets/` (676 KB of GIFs only the README uses), `dist/test.js`, `dist/pathUtils*.js` (stale outputs with no source), or `scripts/` (unused). `dist/test.js` ships a developer's home path (`/Users/danielbustillos/Desktop/tmp/...`). The line `!readme.md`/`!changelog.md` are lower-case (case-sensitive match on Linux). `src/miniterm_filter.py` and `scripts/*.py` are not referenced by any compiled module except `pyraw.ts:12`, which points at a script (`thonny_list_files.py`) that does not exist, so `usePyRawList: true` can only fail.
4. **`vsce package` today** [EXEC, scratch copy]: with `vsce@2.15.0` + npm 11.17 + node 26 the default run fails with `Extension entrypoint(s) missing ... extension/dist/extension.js` (its dependency scan via `npm list --production --parseable` yields no usable file list); `vsce package --no-dependencies` succeeds (56 files, 2.04 MB). Caveat: my scratch copy lives under a symlinked `/tmp` path and I could not reproduce in the original location without writing there, so treat the default-run failure as "likely, not guaranteed". Either way: the extension has **zero runtime dependencies**, so the script should be `vsce package --no-dependencies` (or better, bundle with esbuild and drop the scan), using `@vscode/vsce`.
5. Manifest identity: `publisher: "DanielBucam"` (not the GitHub handle `DanielBustillos`), repository `https://github.com/DanielBustillos/mpy-workbench`, README badges point at the Marketplace id and at a different repo name (`mpy-studio`). A fork must change `publisher`/`name`, and then **two hard-coded lookups break**: `esp32Fs.ts:257` (`getExtension("DanielBucam.mpy-workbench")!.extensionUri` is evaluated for every tree item's icon -> `TypeError: Cannot read properties of undefined` -> empty tree) and `pyraw.ts:12`. Use `context.extensionUri`.
6. License: MIT, copyright "Juan Daniel Bustillos Camargo"; forking is fine provided the notice is retained.
7. API compatibility: compiles clean against `@types/vscode@1.84.0` [EXEC], so there is no accidental use of newer APIs; but the lockfile resolves `@types/vscode@1.103.0`, which would let future code do so silently. Node target ES2020; the Electron Node in VS Code 1.84 is Node 18, fine. No removed/deprecated VS Code API is used; the deprecated parts are on the Python-extension side (`pythonApi.settings.getExecutionDetails`, `getActiveInterpreter`, config key `python.pythonPath`).
8. `CHANGELOG.md` top entry is 0.2.62 while the package is 0.3.2, and it is in Spanish. README names a command `MPY Workbench: Open REPL Terminal` that does not exist (the titles are "Open REPL" / "Open Serial Monitor").

### 3.11 Dead and duplicated code, static analysis

Lines that are dead, stubbed, or duplicated: `boardOperations.ts` 551 (instantiated, never used; diverged copy of sync logic), `mpremoteOperations.ts` 99 (**no-op stubs with the same names as real functions** - an accidental import would silently do nothing), `test.ts` 159 (a script with a top-level call, compiled into `dist/`), `monitor.ts` 69 (polling miniterm, commented out; would fight mpremote for the port every 2 s), `control.ts` 28, `pyraw.ts` 29, `localFilesView.ts` 97 (unreachable), plus the stale `dist/pathUtils*`. About 1,000 of 5,497 lines (~18%) are dead. `extension.ts` itself is a 1,150-line closure with ~30 helper functions and ~40 command handlers, all sharing mutable locals - this is what makes the lifecycle bugs hard to see.

The `--noUnusedLocals` list (62 TS6133) is almost entirely this dead code plus unused `connection` locals in `mpremote.ts` (the "connection manager optimisation" computes a value and never uses it - at `:163,886,906,937,1092,1235,1395,1483`).

---

## 4. Input to the fix-in-place vs rewrite decision (core/glue only)

What a patch would have to touch to meet "just works on macOS and Windows":
1. Remove the port reset; redesign port persistence/auto resolution (touches ~10 call sites).
2. Register or delete 10 dead commands; contribute or delete the Local view and 16 unlisted commands.
3. Replace interpreter validation and the entire `shellEscape`/`exec` execution layer (every mpremote call and every terminal).
4. Replace the two non-mutex mutexes with a real session/queue with timeouts and cancellation; rewire REPL suspend/resume, Run, Stop, Interrupt, Reset on top of it.
5. Rebuild sync-all with plan/confirm/per-file results; fix ignore defaults; fix Windows path handling.
6. Replace ~300 console lines with a log channel; i18n the Spanish.
7. Fix packaging/gitignore/manifest, untrusted-workspace declaration, remote handling.

That is essentially every module except the pure data pieces (`sync.ts` glob matcher after fixes, `decorations.ts`, the tree-item/menus in `package.json`). The product-defining behaviours (interpreter, port, queue, run, REPL) are exactly the ones that are structurally wrong, and the code that implements them is entangled through five process-wide singletons and closure state. **My recommendation is to rewrite the core and glue (the new extension is smaller than the dead code in the old one) while keeping the user-visible contract: the three views, the command titles, the context menus, the status-bar auto-sync indicator, decorations, and the `.mpyignore` concept.** Treat the old `package.json` `contributes` block as a specification to implement *completely*, and add a test that enforces it (invariant 9).

Estimated reuse from the old code: `package.json` contributions (as spec), `sync.ts` ignore matcher (with a gitignore-grade replacement), `decorations.ts` (as is), parts of `esp32Fs.ts` (tree model), tree-item icons/media. Everything in `extension.ts`, `mpremote.ts`, `mpremoteCommands.ts`, `pythonInterpreter.ts`, `boardOperations.ts` should be rewritten, not ported.

---

## 5. Recommended module decomposition for the rewrite

TypeScript, bundled with esbuild into a single `dist/extension.js` (no runtime dependencies, so no `npm list` dependency scan is needed in packaging), `@vscode/vsce`, `engines.vscode` pinned to the same minor as `@types/vscode`. Dependency direction is strictly downward; only the top two layers may import `vscode`.

```
src/
  extension.ts            activate()/deactivate() only (< 150 lines): builds services, calls register*(),
                          pushes every disposable. Non-throwing, no awaits before registration.
  composition.ts          (optional) the dependency-injection wiring, so extension.ts stays trivial

  ui/                     [may import vscode]  presentation + command surface; no process spawning
    commands.ts           registers ALL contributed commands from one table; wraps each in an error boundary
                          (log + one actionable toast); a unit test asserts table == package.json
    filesView.ts          board tree (TreeDataProvider) - reads from DeviceFs cache, shows state, never spawns
    actionsView.ts        Run / Stop / REPL / Reset / Interrupt (state-aware enable/disable)
    syncView.ts           upload all / download all / clear / autosync toggle (shows plan before executing)
    statusBar.ts          [board: name+port+state] [autosync] [run/stop]
    decorations.ts        FileDecorationProvider fed by SyncEngine results (no global)
    notify.ts             single funnel for info/warn/error + "Show log" button
    welcome.ts            first-run checklist (interpreter ok? mpremote ok? board found?) as viewsWelcome contexts

  app/                    [may import vscode, thin]  orchestration of use cases
    runService.ts         run file / stop / soft reset / interrupt as one state machine on DeviceSession
    replService.ts        REPL terminal (Pseudoterminal or Terminal) with attach/detach contract
    autoSync.ts           onDidSave -> debounce per path -> SyncEngine.push (low priority, coalesced)
    workspaceModel.ts     workspace folder, trust, remote/virtual detection, config dir location

  config/                 [may import vscode]
    settings.ts           typed getters + change events; never writes settings implicitly
    state.ts              workspaceState: selected board identity {path, vid, pid, serial}, last python

  env/                    [pure core + one vscode adapter]
    pythonResolver.ts     precedence: setting > workspace .venv/venv (Scripts\ on Windows, bin/ elsewhere)
                          > Python extension API > `py -3`/`python3`/`python`; validates each candidate as
                          `<py> -m mpremote --version`; returns {python, mpremoteVersion, source, why};
                          memoised with explicit invalidation (settings, active env, file watcher on .venv)
    venvInstaller.ts      create .venv and `pip install mpremote` with consent, progress and visible stderr

  device/                 [pure Node; no vscode import - testable under node:test]
    mpremoteProcess.ts    spawn(argv, {shell:false, windowsHide}) + timeout + AbortSignal + kill-tree
                          (taskkill /T /F on Windows, process-group on POSIX) + typed errors
                          (NoDevice | PortBusy | RawReplFailed | Timeout | Cancelled | NotInstalled)
    portScanner.ts        `mpremote connect list` parse + VID:PID allow-list (10C4:EA60, 1A86:7523/55D4,
                          303A:*, 0403:6001/6015 ...) ; poll only while a picker/view is visible
    deviceSession.ts      THE owner of the port: FIFO queue with priorities, states
                          Idle | Busy(op) | Repl | Running(program); `run(op, {signal})`; `preempt()` = cancel
                          current then start; REPL attach/detach hooks; emits state events
    boardFs.ts            list/stat/read/write/mkdir/rm/mv/exists via ONE batched mpremote invocation per
                          user action (e.g. a Python helper executed with `exec`), not per file
    runner.ts             run/exec/stop/reset command builders (no `echo > tty`)

  sync/                   [pure Node]
    paths.ts              the only place that converts workspace-relative <-> device paths
    ignore.ts             gitignore-grade matcher; default set includes .venv venv .git __pycache__ *.pyc
                          .mpy-workbench node_modules dist build .DS_Store Thumbs.db CLAUDE.md plan.md docs/
    manifest.ts           content-hash based state (size+mtime fast path), stored under the config dir,
                          relative paths only (no absolute roots)
    syncEngine.ts         plan() -> Plan{upload,download,delete,conflict}; execute(plan,{signal,onProgress})
                          -> per-file Result[]; manifest updated only for successes

  log.ts                  LogOutputChannel wrapper; every spawn logs argv, cwd, exit, duration
  types.ts                shared value types
test/
  unit/                   paths, ignore, quoting, resolver (fake fs), parsers, state machine
  fakes/                  fake-python + fake-mpremote (as in the harness), recorded real outputs
  contract/               package.json <-> registered commands/views, activation in a fake vscode
  e2e/                    @vscode/test-electron smoke (activate, views exist, commands resolve)
```

Rules: (a) `device/` and `sync/` must not import `vscode` (enforced by an ESLint `no-restricted-imports` rule); (b) `ui/` never spawns processes; it calls `app/` use cases; (c) only `deviceSession` talks to `mpremoteProcess`; (d) no module-level mutable state - services are constructed in `activate()` and disposed through `context.subscriptions`; (e) no `global`, no `getExtension("publisher.name")`.

---

## 6. The ten invariants the new core must guarantee

1. **Single owner of the port.** All board access goes through `DeviceSession`; at most one child process or REPL is attached to the serial port at any instant; operations are FIFO with explicit priority; "preempt" means *cancel the current op, then run*, never *forget the queue*. A hung op is bounded by a timeout.
2. **Interpreter and mpremote are resolved as a validated pair, deterministically.** Precedence is documented and shown in the UI/log (`source` and `why`): explicit setting > workspace `.venv`/`venv` (OS-specific executable dir) > Python extension's selected interpreter > launcher/system. A candidate is valid only if `<python> -m mpremote --version` succeeds; a PATH `mpremote` is never consulted. Failure yields one actionable message naming the exact install command for *that* interpreter (and an opt-in "create .venv here").
3. **No shell strings, and identical behaviour on macOS and Windows.** Processes are spawned from argv arrays with `shell:false`; terminals use a per-OS quoting helper covered by unit tests with spaces, quotes, non-ASCII user names, `COM10+`, and `py -3`; all path conversion lives in `sync/paths.ts` (workspace-relative POSIX <-> device) and is tested with Windows inputs.
4. **Never mutate user configuration implicitly; the board selection survives reloads.** Activation writes no settings. The selected board is stored in `workspaceState` as an identity (path + VID:PID + serial) and re-found when the path changes; `auto` means "the single recognised board, else ask once" and is honoured by Run, REPL, Stop, tree and sync alike.
5. **Every user action ends in exactly one visible outcome.** Success (progress completes / status updates) or a failure that states cause and next step. No empty `catch`; everything is logged to a `LogOutputChannel` (argv, exit code, stderr, duration) with a "Show log" button on errors; background failures are aggregated into a status-bar state instead of toast spam.
6. **Every external process has an owner, a timeout, and a way to die.** Cancel and `deactivate()` kill the whole process tree (Windows `taskkill /T`), loops observe an `AbortSignal`, and there are no module-level timers, intervals or process handles.
7. **Run / REPL / Stop are a state machine, not terminal tricks.** Pressing Run while a program is running first stops it (Ctrl-C, wait for exit) and then runs the new file, so a second click always works; opening the REPL detaches/attaches through the session (the REPL is reclaimed after file operations or the UI says it is detached); Stop/Interrupt/Reset use mpremote or the session's transport, never `echo > port`.
8. **File mirroring is explainable and cannot silently lose work.** Sync computes a plan first; destructive directions (Board -> Local overwrite, Clear device, delete both) show what will change and need confirmation; execution reports per-file results ("12 uploaded, 1 failed: boot.py - <reason>"); the manifest is updated only for files that succeeded; the same ignore rules (default set includes `.venv`, `venv`, `.git`, `__pycache__`, `*.pyc`, the config dir) apply to auto-sync, sync-all, tree decoration and run-file, and exist even if no ignore file has been created.
9. **The manifest and the code agree, and a test proves it.** Every contributed command, view, menu target and `when` context key has a registered handler/provider/setter (and vice versa); `activate()` is fast, non-throwing, registers everything through `context.subscriptions`, and a contract test activates the extension against a fake `vscode` and fails CI on any "command not found" or "No view is registered".
10. **Safe and honest in restricted, virtual, and remote contexts.** In an untrusted workspace no process is spawned from workspace-controlled settings (`pythonPath` etc. are `machine`-scoped / listed in `restrictedConfigurations`); in remote or virtual workspaces (`vscode.env.remoteName`, non-`file` scheme) the extension shows one clear message ("open the folder locally") and disables board commands instead of failing opaquely; no network access, no telemetry.

---

## 7. Test strategy implied by this analysis

* **Contract test** (cheap, highest value): load `package.json`, activate against a stub `vscode` that validates view ids and command ids, execute every contributed command with a minimal argument, assert none returns "not found". My `vscode-stub.js` is 100 lines and caught defects 2 and 3 immediately.
* **Fake interpreter / fake mpremote** executables on `PATH`/settings (as `fakepython` here) that log a timeline: assert max concurrency == 1 per port, assert cancel kills the tree, assert timeouts, assert what argv is produced for paths with spaces.
* **Resolver tests** with a fake filesystem for: venv-only mpremote (the user's case), no mpremote anywhere, Windows layout (`Scripts\python.exe`), Store-alias stub, interpreter with spaces.
* **Pure unit tests** for `paths`, `ignore`, quoting, `mpremote connect list` parsing (recorded outputs, no hardware), plan computation.
* **Hardware-in-the-loop checklist** (manual, one board, both OSs) kept separate from CI: pick port, list, upload, run loop, run again, stop, REPL, unplug/replug.

## 8. Behaviours and ideas worth preserving

* The sidebar shape the user likes (Files / Board Actions / Sync utilities), activity-bar container, and the command titles.
* Local<->board **mirroring with workspace-relative paths**, `rootPath` mapping, `.mpyignore` file with sensible defaults, per-workspace auto-sync override, status-bar "AutoSync ON/OFF" item (hidden until relevant is wrong - show it whenever the folder looks like a MicroPython project).
* "Run file" using `exec import module` when the file is already on the board so tracebacks carry real file names (CHANGELOG 0.2.62) - keep as an option, but make the behaviour explicit and verified (soft reset semantics are the REPL/run analyst's call).
* Modal confirmation on "Clear Device Files" and on de-initialise; file decorations (`?`, `D`) for local-only/board-only/changed; the idea of `uploadReplacing` (write to temp then rename) to avoid partial writes while code autostarts.
* No telemetry, no network, MIT licence.

## 9. Open questions (for the orchestrator / user)

1. Which artefact did the user actually run - the Marketplace/committed `.vsix` (bare `mpremote` on PATH; never sees a venv) or a build from HEAD (the "hack")? It changes which half of complaint #1 they saw.
2. Do students' lab machines run Windows natively, or can some be WSL / Remote-SSH sessions? If any, decide between "message and disable" (recommended) and the larger `vscode.workspace.fs`-based remote design.
3. Is a per-project `.venv` with a pinned mpremote the course's blessed setup (then the extension can offer to create it) or do lab images ship a system Python with mpremote?
4. Should the new extension keep the `.mpy-workbench/` directory name and `esp32sync.json` for continuity, or can they change (the manifest is write-only today)?
5. Confirm on a Windows machine: (a) `vsce package` default run vs `--no-dependencies`; (b) `cmd.exe` rejects the single-quoted command line (I am >95% sure but could not run it here).
6. The REPL/auto-suspend claims in 3.6 (terminal closes when mpremote exits, `sendText` after exit is a no-op) are from documented VS Code terminal behaviour; the REPL analyst should confirm on a real board, since no port was touched here.

## 10. Appendix - file:line index of the key claims

| Claim | Location |
|---|---|
| Port reset to `auto` (Global) at activation | `src/extension.ts:181-188` |
| `LocalFilesView` created without contribution | `src/extension.ts:196-197`; `package.json:64-81` |
| Dead `BoardOperations` instance | `src/extension.ts:204` |
| Cancel status-bar item always shown when initialised | `src/extension.ts:213-219,239-242` |
| Watcher on stale `.mpystudio/config.json` | `src/extension.ts:246-253` |
| `skipIdleOnce`, `ensureIdle`, `withAutoSuspend` queue reset | `src/extension.ts:265-301` |
| `refresh` does not clear `mp` tree cache | `src/extension.ts:333-338`; `src/mpremote.ts:255-309,772-795` |
| `pickPort` writes Global | `src/extension.ts:449-465` |
| `syncBaseline` failure counting / unconditional success | `src/extension.ts:767-829` (esp. `:799-800,:813,:818-822`) |
| `syncBaselineFromBoard` no confirm, no try/catch | `src/extension.ts:831-866` |
| Backslash regex bug | `src/extension.ts:904,911` (correct form at `:1111`) |
| `openFile` opens local copy | `src/extension.ts:924-973` |
| Auto-upload on save | `src/extension.ts:1093-1128` |
| Empty `deactivate`, commented-out dead command | `src/extension.ts:1153-1185` |
| Mutex no-op (`markHealthy` clears in-progress) | `src/mpremote.ts:63-71,150-168` |
| Spin-wait consumes retry count | `src/mpremote.ts:148,156-160` |
| `exec` without timeout; POSIX `shellEscape` | `src/mpremote.ts:7-9,181-184` |
| Module-level interval | `src/mpremote.ts:107,131` |
| `cancelAll`, unused `cleanupConnections` | `src/mpremote.ts:1574-1577,1739-1742` |
| `listSerialPorts` | `src/mpremote.ts:849-879` |
| `echo -e ... > port` | `src/mpremoteCommands.ts:392,453,484` |
| `port === auto` hard errors | `src/mpremoteCommands.ts:170-173,246-248,367-370,427-430` |
| Run-file terminal reuse via `sendText` | `src/mpremoteCommands.ts:215-226` |
| REPL terminal as one-shot shell; suspend/resume | `src/mpremoteCommands.ts:27-49,254-258` |
| Spanish strings | `src/mpremoteCommands.ts:82,92-94,103` |
| Validation uses global `mpremote`, ENOENT mis-classified | `src/pythonInterpreter.ts:229-246` |
| `python3` last resort cached 30 s | `src/pythonInterpreter.ts:14,105-107` |
| Install button unquoted `exec` | `src/pythonInterpreter.ts:294` |
| Tree error filter, blank tree, `no-port` dead node | `src/esp32Fs.ts:7,28-41,118-121,238-249` |
| Hard-coded extension id | `src/esp32Fs.ts:257`; `src/pyraw.ts:12` |
| Default ignores lack `.venv`; `*.py[cod]` literal-bracket glob | `src/sync.ts:73-85,87-103` |
| Untrusted `supported:true`, `extensionKind`, duplicate `extensionPack` | `package.json:12-19` |
| Unregistered contributed commands & menus | `package.json:83-355` |
