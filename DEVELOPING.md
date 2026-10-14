# Developing μPython Bridge

Developer notes for the TypeScript extension. User documentation is `README.md`; rules and decisions are in `CLAUDE.md` and
`docs/`. The mocked unit tests (`npm run verify`) and the suites in a real, isolated VS Code (below) are separate things: the
second kind ran for the first time on 2026-10-13 against fake boards only. Windows and any real board are still **unverified**
(see "Not verified yet" at the end).

## Safety rules for every run on a development machine

- Never open a real serial port from tests or scripts. Export `MPY_SAFE_MODE=1` (the test runner and `npm run` scripts force it)
  and never set `MPY_REAL_PORT` except in the reviewed hardware harness (`tools/hwtest/`, orchestrator only).
- `npm test` and `npm run verify` use the fake board (`tools/fakeboard.py`, a TCP socket on 127.0.0.1) and the mocked `vscode`
  module. They never launch VS Code, Electron or a browser. A real VS Code is started only by `tools/vscode_test/launch.py`
  (section "Tests in a real VS Code" below), under the isolation rules of `CLAUDE.md`.
- Foreground, bounded commands only: no `&`, `nohup` or `setsid`. After a session check `ps -axo pid,etime,command | grep -E "fakeboard|mpy_bridge|node " | grep -v grep`.
- npm: `npm ci` (the exact versions of `package-lock.json`; `.npmrc` turns install scripts off), only inside this folder, never
  `npm audit fix`, never global installs. Adding a dependency: `npm install --ignore-scripts --save-exact <pkg>@<version>`.

## Commands (repository root, Node 20 or newer)

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` (strict) |
| `npm test` | bundle every `test/**/*.test.ts` with esbuild (`vscode` aliased to `test/mocks/vscode.ts`) and run them with `node --test` (about 15 s, includes the tests that start the real Python bridge and a fake board) |
| `npm test -- <filter>` | only test files whose path contains `<filter>`; if none matches, `<filter>` is a test-name pattern |
| `npm run test:integration` | only `test/integration/` (the end-to-end flow against the real bridge) |
| `npm run lint` | the source rules of `test/unit/lint.test.ts` (no shell strings, no `console`, no module-level `let`, names only in `src/identity.ts`, ...) |
| `npm run gen:manifest` | regenerate `package.json` (`contributes`, activation, trust) from `src/contributes.ts` and `src/identity.ts`; `-- --check` fails when out of date |
| `npm run build` | bundle `src/extension.ts` to `dist/extension.js` (esbuild, `vscode` external, source map) |
| `npm run package` | production build, stage the allow-listed files (`scripts/stage.mjs`), `vsce package` to `out/upython-bridge-<version>.vsix` |
| `npm run verify` | typecheck, manifest check, all tests, build, package, VSIX content rules (`UPYBRIDGE_REQUIRE_VSIX=1 npm test -- package.test`), size budget. About 30 s |
| `python3.13 -B tools/check_generic.py --strict` | the "no board or course specific strings" guard (D-15); `npm run verify -- --with-python-guard` runs it too |

The Python side (`bridge/`, `tools/`, `tests/`) has its own test loop, see `tests/README.md`.

## Layout

```
src/extension.ts        activate()/deactivate(): builds the services in a fixed order, registers everything
src/lifecycle.ts        Teardown: one entry in context.subscriptions, disposal order (auto-sync, session, rest, log)
src/windowGuards.ts     Remote/virtual refusal, Restricted Mode gate (no bridge until trusted)
src/identity.ts         the ONLY place with product names (extension id, display name, prefix, dot-folder)
src/contributes.ts      ONE table that generates package.json (commands, views, menus, settings, activation events)
src/log.ts              Logger over an output channel
src/types/              protocol mirror (docs/protocol.md), BoardSession contract, Settings, sync types, Services
src/bridge/             BridgeClient: spawns the ONE Python bridge, NDJSON framing, restart budget, kill tree
src/python/             interpreter discovery (probe by running it), Python/Environments extension hints
src/session/            BridgeBoardSession: lazy start, state mirror, connect/identity, reconnect, consent, learned resets
src/views/, statusbar.ts   Files / Board Actions / Sync utilities views, context keys, decorations, status bar
src/repl/, src/commands/   REPL/Run terminal, ports, run, stop, reset, sync and board-file commands
src/boardScheme.ts      the scheme of the read-only board documents (leaf module); src/commands/boardCopy.ts = "Copy it to my project" (Files click and Run)
src/sync/               path mapping, ignore rules, baseline, planner, engine, auto-sync (SyncService), board-change events
src/doctor.ts           Doctor report (incl. the IntelliSense section) and startup checks
src/intellisense/       pure library (planFix/applyPlan/removeManaged, stock stub picker, board.ts: stubs made from the board through an injected BoardAccess); preview.ts (plan -> Markdown) and health.ts (Doctor facts) are the UI-facing pure parts. No firmware source folders are read (decision of 2026-10-13)
src/commands/intellisense*.ts   the VS Code side: command + flow (intellisense.ts), questions (intellisensePrompts.ts), quick fix, first-connect offer, wiring (intellisenseRegister.ts)
resources/stubs/        the stock stub packs shipped in the VSIX (read through context.extensionUri, never the cwd)
src/toast.ts            showToast: messages that never hold up the command that shows them (see "What the real host taught us")
src/testApi.ts          read-only test hook, exists only when the environment variable UPYBRIDGE_TEST is 1 (host suites)
bridge/                 Python bridge (the only code that opens a serial port) with vendored pyserial and mpremote
media/                  the six artwork files of D-19 (Marketplace icon, activity bar glyph, light/dark terminal tab icon, light/dark danger trash icon); nothing else is allowed here (package test)
scripts/                build, package/stage, verify, test runner, manifest generator
test/unit, test/integration, test/mocks   node:test suites, the mocked vscode, fake session, helpers for the real bridge
test/vscode/            suites that run INSIDE a real extension host (bundled to out/vscode-tests/index.js, see below)
tools/vscode_test/      launch.py, the only vetted way to start VS Code (isolated profile, fake board, hard timeout, cleanup)
```

Activation order (`src/extension.ts`): log, window guards (Remote/virtual refuse everything), settings, port memory,
`createBoardSession` (lazy, nothing starts), sync service, views and status bar, terminal commands, sync and board-file commands,
Show Log, Doctor, auto-sync listeners, remembered port selected (not connected), startup checks (older extension warning).
No process is spawned, no port opened and no setting written until the user asks for the board.

How a feature reaches the board: only through `BoardSession` (`src/types/session.ts`); other modules call each other by command
id (`COMMAND_IDS.selectPort` with `{ reuse: true }` is the one way to "make sure a board is connected"). Add a command: add it to
`COMMANDS` in `src/contributes.ts`, run `npm run gen:manifest`, register it (the activation test fails when declared and registered
differ). Rename the product: edit `src/identity.ts`, run `npm run gen:manifest`.

Names and artwork (D-18, D-19). `src/identity.ts` holds every name: display name `\u03bcPython Bridge` (U+03BC GREEK SMALL LETTER MU, written
as an escape so no editor can turn it into the micro sign U+00B5), short ASCII form `uPy Bridge` (status bar item names and the
"is ready" log line), package/extension id `upython-bridge`, prefix `upy-bridge` (commands, settings, context keys, state keys; view ids are
`upy-bridgeFilesView` and so on; the hyphen is valid in `when` clauses), project folder `.upy-bridge/`. The lint test fails on any of the old
working names of D-14 (the "MPY" + "Bench" spellings in every case and separator) in `src/`, `scripts/`, `package.json` and `package-lock.json`.
Not renamed yet (stage 2, release preparation): `.mpyignore`, the safety variables `MPY_SAFE_MODE` / `MPY_REAL_PORT` / `MPY_ALLOW_RESETS` /
`MPY_UNIX_BIN`, the board scratch folder `/_mpybench_test`, the Python module names. Test hooks use `UPYBRIDGE_*`.
The files under `media/` come from `branding/final/` (copy, never edit in place): `icon.png` (= `icon-256.png`, `package.json` `"icon"`),
`activitybar.svg`, `terminal-tab-light|dark.svg` (the Run/REPL tab, `createTerminal({ iconPath: { light, dark } })` in `src/repl/terminal.ts`, fixed
colours because VS Code may not theme a currentColor SVG there), `trash-danger-light|dark.svg` (Clear Device Files, Delete from Board and Local).
`MEDIA` in `src/contributes.ts` is the one list; `package.json` icon, banner colour, keywords and categories come from the same table.
README images are relative links (`images/*.png`, see "Marketplace screenshots"); `vsce` rewrites them to the GitHub repository that
`package.json` names. Without a `repository` it refuses them ("Couldn't detect the repository ... The image will be broken", executed
2026-10-13). The banner (`branding/final/banner-1280x640.png`) is not in the README and must not be shipped in the VSIX (the `media/`
budget in `scripts/check-size.mjs` is 24 KiB, the banner PNG is 40 KiB); it could be shown the same way as the screenshots.

## Tests

- `test/unit/activation.test.ts`: `activate()` against the mock with a fake workspace. `child_process` is replaced by a recorder that
  refuses, so "nothing is started before the first use" and "no process in Restricted/Remote windows" are real checks.
- `test/integration/flow.test.ts`: select port, connect, list files, upload, run, stop, deactivate, through the mocked `vscode`,
  with the extension's own BridgeClient, the real `bridge/` and `tools/fakeboard.py`. Windows facts are never tested here.
- `test/unit/package.test.ts`: the staging allow-list and, when `out/*.vsix` exists, its contents (no sources, tests, caches, source
  maps, `.DS_Store`; bridge with vendor and licences present; under 5 MB). `npm run verify` makes a missing VSIX a failure.
- Prompts are scripted before the code runs (`mock.answerMessage`, `mock.answerQuickPick`); unscripted prompts are dismissed. See
  `docs/extension-design.md` section 6 for the conventions.
- `test/unit/openrun.test.ts` is the student journey "click a board file in the Files view, then Run" with the real click command,
  Run, `BoardCopy` and `SyncService` wired like `activate()` wires them. Toasts with buttons never settle in a real window until
  answered; the test makes that visible with `withPendingToasts` (the command under test must finish while the toast is open).
  `test/unit/open-run-review/` holds the independent review of that journey (path edge cases, links, copy races, folders and files
  in the way, the tooltip) and `run-while-running.test.ts` (Run with a program running and a saved file waiting, real `SyncService`).

### What a click in the Files view does (src/commands/boardFiles.ts, boardCopy.ts, run.ts)

- Click (`openFileFromBoard`): `SyncService.localCounterpart(devicePath)` maps the board path into the project (rootPath, ignore-free,
  Windows-safe names). The project file exists: open THAT file (preview), no board traffic, no toast. Only on the board: open the
  read-only `upy-bridge-board:` document (`BoardDocumentProvider`) and start a non-blocking toast "<name> is only on the board, not in
  your project folder." with **Copy it to my project**. No workspace folder or a path outside `rootPath`: the board document and an
  explanation, no copy button. The toast is never awaited inside `sync.guarded` (a command with an open toast would stay pending).
- `BoardCopy.copy`: stat and download (`fs.get`, same consent flow as every file operation) into a scratch folder first; only then
  create the parent folders and the file with an exclusive create (`wx`), so a file that appeared in the meantime is never replaced;
  a failed write removes its own partial file. Afterwards the badge is `in-sync` and the file is noted in the sync history, so the
  next edit is a plain local change.
- `openBoardCopy` ("Open the Board's Copy (Read-Only)", Files-view context menu, not in the palette): the old click, always the board's
  version.
- Run (`RunCommand.run`): a board document (or a board Uri argument) resolves to its project file and runs that; without one it starts
  the same offer with **Copy it to my project and run it** and returns; after the copy the new file is shown and run. Other
  non-file documents keep the old explanation. `RunDeps.boardFiles` carries this (wired in `src/extension.ts`); without it the old
  message appears. Upload Current File does the same redirect (`SyncService.uploadFile`); the Run row of Board Actions names the file.
- Shortcuts (symbolic links, junctions) INSIDE the project are never followed (`linkInProject` in `src/sync/service.ts`, the same rule as
  the sync scan): `localCounterpart` answers `unmapped` with a sentence, so a copy cannot write outside the project through a linked
  folder and a click cannot open an outside file through a linked file; the board's copy opens read-only instead. A link AT or above
  the project folder (an alias of the whole project) is still followed.
- `BoardCopy.copy` looks for what stands in the way BEFORE the slow download (`placementProblem`): a FILE where one of the folders of
  the new file should be ("lib is a file in your project, but x.py needs lib to be a folder...") or a FOLDER where the file should be
  ("foo.py is a folder in your project..."). The same sentences are used when the thing appears during the download. Nothing is
  ever overwritten and no raw `EEXIST` text reaches the student.
- Run with a program already running (`RunCommand.run`): the "Stop it and run X?" question comes BEFORE the waiting files are sent. A
  yes sends one `stop` (Ctrl-C twice, never a reset) only when files are waiting, because auto-sync and the Run flush upload with
  `background: true` (they never interrupt) and the bridge refuses uploads to a busy board; then the files go out and the run starts.
  Without waiting files Run sends no separate stop (the run itself interrupts), as before.
- The Files-view tooltip uses the sync badge as a hint ("Only on the board" for `board-only`, "Open your copy" for any other known
  badge, both sentences before the first comparison); the click itself always looks at the project folder. `FilesTree` remembers the
  wording it gave each file and fires `onDidChangeTreeData` for a file when a badge change alters it (VS Code keeps a tooltip until it
  asks for the item again, and `resolveTreeItem` only runs for properties left undefined, so there is no `resolveTreeItem`).

## Tests in a real VS Code (extension host)

These run the built extension (`dist/extension.js`) in a real VS Code 1.141 (Electron) on macOS, with a throwaway profile and a
fake board. They are NOT part of `npm run verify` (a window opens for 5 to 20 s). Run them from the repository root, one at a
time, always as a bounded foreground command, and look at `ps` afterwards:

```
export MPY_SAFE_MODE=1            # the launcher sets it for VS Code too; never set MPY_REAL_PORT
timeout 330 npm run test:vscode            # build + suite "all": activation, views, flow (19 tests, about 15 s)
timeout 330 npm run test:vscode:smoke      # build + smoke (2 tests, about 7 s)
timeout 330 npm run test:vscode:python     # build + python, with Python, Pylance and Python Environments copied in (7 tests, about 17 s)
timeout 330 npm run test:vscode:coexist    # build + coexist, with the older MPY Workbench copied in (6 tests, about 7 s)
timeout 330 npm run test:vscode:intellisense          # build + intellisense, real Pylance copied in (10 tests, about 30 s)
timeout 330 npm run test:vscode:intellisense-spikes   # build + S-04 d/e/f/g, real Pylance (5 tests, about 110 s)
timeout 330 python3.13 -B tools/vscode_test/launch.py --suite flow           # one suite, no rebuild (run `npm run build` first)
ps -axo pid,command | grep /tmp/mpyvs | grep -v grep ; ls /tmp/mpyvs        # both must print nothing
```

The launcher prints the verdict and writes `tools/vscode_test/reports/<run-id>/` (results.json, summary.json, copies of the VS Code
logs, the fake board's event list, a process timeline). Exit code 0 means every in-host test and every launcher check passed,
1 test or check failures, 2 hard timeout, 3 harness error. All flags are in `tools/vscode_test/README.md`. The launch is
isolated: profile, extensions and workspace live in `/tmp/mpyvs/<run-id>/` (removed afterwards), `VSCODE_PORTABLE` keeps VS Code
from rewriting `~/.vscode/argv.json`, the only board is a fake one on `socket://127.0.0.1:PORT`, and the process group is killed
(SIGTERM, 5 s, SIGKILL) however the run ends. Windows is coded but has never been run.

What each suite proves (passed in the 2026-10-13 runs, VS Code 1.141, macOS, fake board only; the details are in each report's results.json):

| Suite | Proves |
|---|---|
| `smoke` | The extension host starts, is isolated (safe mode, no real port, profile in the scratch folder), and our extension is found at the development path. Activates nothing. The manifest the host loaded is checked: id `local.upython-bridge`, display name and sidebar title start with U+03BC (not U+00B5), icon and activity bar icon exist on disk, banner colour, every command id starts with `upy-bridge.`, no old name. |
| `activation` | Nothing starts before first use (no bridge process); the extension activates by view and by command; all 23 declared commands are registered and every registered id of ours starts with `upy-bridge.` (none with the old prefix); `getConfiguration('upy-bridge')` reads, defaults and writes settings (a nested key too); the output channel's log file is named μPython Bridge; the test hook exposes only its 9 members (read-only introspection and the scripted answers of the IntelliSense questions). |
| `views` | The μPython Bridge container and its three views open; the Files view follows the connection (Connect row, then the board's files); the status bar says Not connected, Ready and Running; the context keys that the `when` clauses use (`upy-bridge.connected`, `.hasPort`, ...) are accepted by VS Code and follow the connection. |
| `flow` | (Always run after `views`, so the Files view has a cached root listing.) Through real commands, editors and terminals: set the documented `upy-bridge.port` setting, connect, Run (output, non-ASCII text, `[program finished]`), Run with an error (traceback with the local file path and line), Upload Current File (no prompt, Files view updates), Stop (under a second, and the Stop command itself finishes), Open REPL and keystrokes sent to the tab, closing the Run tab while a Run-started loop runs (the program stops, the connection stays, the next Run works) and while a program typed into the REPL runs (it keeps running), the Files-view journey "click, then Run" (a synced file: the click opens the PROJECT file, scheme `file`, and Run runs it and returns to idle; a board-only file, `boot.py` of the fake board: the click opens the read-only board document, Run returns at once, runs nothing and copies nothing; the offer's buttons cannot be pressed from inside the host, so "Copy it to my project (and run it)" is covered by `test/unit/openrun.test.ts` only), and a loop program left running when the window closes; the Run tab is named μPython Bridge and has light and dark icon files that exist in the extension folder; `upy-bridge.running` is true while a program runs and false after Stop. After the window closes the launcher checks that the board is idle again. |
| `python` | With Python, Pylance and Python Environments installed: our tab receives no activation text, only the test's own `sendText` reaches the Python logs, and the control shell is activated (`source .venv/bin/activate`) so the check can see activation at all. Measured with Python 2026.8.0, Envs 1.38.0, Pylance 2026.4.1, one workspace `.venv`, zsh. |
| `coexist` | With the older MPY Workbench installed and activated: both load, ours activates, no duplicate registrations, and the Doctor names the old extension; the two manifests declare no common command, view, container or setting id. It runs none of the old extension's commands. |
| `intellisense` | With the REAL Pylance (2026.4.1): the made-up "acme" project; the custom modules live on the FAKE BOARD (`launch.py` `acme_board_profile`, sources in `test/fixtures/intellisense/fake-board-acme/`: frozen package `acme` with `motor`/`pins`/`extra`, frozen `acme_extra`, C module `_acme`, `/lib/helper.py`). Pylance flags them and `machine` before; the scripted command (answers through the test hook) reads the board through the real bridge (one import question, imports only `_acme`/`acme`, ONE soft reset), writes the files and Pylance resolves them (`time.sleep_ms` into the generated stubPath, `machine.Pin`, the frozen package and its submodules, the C module, the copy of `/lib/helper.py` with its real signature), the misspelled `acme.Motr` and `.gainz` ARE flagged, the student's own `lib/acme_extra.py` wins, no diagnostics inside the generated stubs, the light bulb is offered on a real Pylance diagnostic and turns into the Doctor report when the diagnostic stays, the first-connect offer is made once, the Doctor section, an idempotent second run, Remove. |
| `intellisense-spikes` | S-04 (d), (e), (f), (g) with real Pylance: extends target missing, fallback tier (settings + `typings/`), config `extraPaths`, a config file re-created after deletion. Records what Pylance does in the notes of results.json and `s04-pylance-log.json`. `--suite intellisense-all` runs both in one launch (about 150 s). |
| `exitprobe` | Diagnostic only: shows what happens to helper processes that the extension host started when VS Code exits (see "Closing the window"). |

Not covered by these suites: the Board Actions and Sync rows (only container and view reveal), Restricted Mode, Remote windows,
auto-sync on save, the Reset menu, clickable links in the traceback (only the `File "<path>", line N` text is checked), Windows,
other VS Code versions, and any real board.

Closing the Run tab (D-17): `src/repl/terminal.ts` stops a program that the Run command started when the tab is closed (setting
`stopOnTerminalClose`, default on). Ownership is a `RunTracker` (`src/repl/runTracker.ts`) that the Run command brackets around each
`run` call (`runs.begin()` / `runs.end()`; the consent question "Stop it and run?" is outside the bracket), so a `main.py` that was
already running at connect is never stopped. The close handler stops only when the tracker says "Run's program" AND the bridge state
is `running` (a program that just ended is left alone), claims the stop once per run (a second close sends none), sends `stop`
(Ctrl-C twice, never a reset), detaches the view, then shows a toast (`showToast`, non-blocking) or, when the board does not react,
the error with the **Reset board...** button. Deactivation disposes the terminal without stopping anything (the bridge interrupts on
stdin EOF). Unit tests: `test/unit/repl.closeStops.test.ts`; in the host the two last tests of the `flow` suite (the fake board's
event log cannot be read from inside the host, so `tools/vscode_test/reports/<run>/fakeboard-events.json` is where interrupt,
`program_end` and the absence of any reset can be checked after a launch).

### What the real host taught us about Pylance and the IntelliSense layout (S-04, Pylance 2026.4.1, 2026-10-13)

- `extends` of the relative generated file is honoured, `stubPath` into the dot folder shadows the stdlib `time` (`sleep_ms`
  resolves to `.upy-bridge/stubs/active/time.pyi`), the `ignore` list keeps even OPEN generated stubs free of diagnostics, a changed
  or re-created config file is picked up within seconds without a restart. D-05's default layout stands.
- Pylance's own default `typeCheckingMode` is "off", where `reportAttributeAccessIssue` and wrong-call checks are not reported: before the
  setup only the unresolved imports (warnings) show up; the stricter checks arrive with the `basic` of the generated `pyrightconfig.json`.
- A deleted `extends` target is NOT noticed while Pylance runs; as soon as the config is re-read (edit, save, window reload) every
  board module is unresolved again and the log has one `[error] Config file ... could not be read` line. The Doctor reports this
  as a problem with the fix; the command recreates the file and Pylance recovers within seconds.
- The fallback tier (no config file; `typings/` + `python.analysis.extraPaths`/`ignore` in settings) resolves everything but shows a
  yellow `reportMissingModuleSource` warning on every stub-only import (`machine`, `time`, `_acme`), because the user-owned config's
  `reportMissingModuleSource: none` has no place there; it would need `python.analysis.diagnosticSeverityOverrides` (not built).
- A `pyrightconfig.json` with its own `extraPaths` replaces the generated list (then modules found that way are unresolved, `lib` resolves); the setup
  warns (`W_USER_CONFIG_OVERRIDES`) and the Doctor lists the key.
- The setup chooses the stubs from the connected board's identity, which arrives a moment after the prompt: the command waits up
  to 6 s for it (a student who connects and at once runs the setup would otherwise get stubs for "no board").

### Where custom-module IntelliSense comes from (decision of 2026-10-13; `src/intellisense/board.ts`)

The extension never reads firmware source or build folders on the computer (students never have them, and the earlier discovery
picked a stock MicroPython checkout one folder above the instructor's project). Sources: (a) the bundled stock stub pack chosen from
the board identity, (b) the board itself through the bridge, (c) files of the local project and of the board's file system.

- Inventory (connected, IDLE board only; while a program runs the command says so and stops, `status: 'board-busy'`):
  `introspect.modules` without names = `help('modules')` (built-in and frozen names, nothing imported) and `fs.list` of `/lib` plus
  the absolute `sys.path` folders of the identity (minus `/` and a folder that holds another one).
- Selection = (listing + board library modules) - stock pack names - `KNOWN_ELSEWHERE` (CPython stdlib known to pyright, stock
  internals) - `NEVER_IMPORT` (`_boot*`, `boot`, `main`, `inisetup`, `flashbdev`, `webrepl_setup`, `__main__`, `upip`,
  `upip_utarfile`, `port_diag`, `this`) - modules the project provides (`.py`/`.pyi`/package at the root, `lib/`, `typings/`).
- Board `.py`/`.pyi` library files are copied with `fs.get` (256 KB per file, 2 MB in total) into `.upy-bridge/board-lib/`
  (extraPaths + ignore). Frozen/C/`.mpy` modules need an import: one question per firmware key (build + version + hash of the
  listing; remembered in workspaceState `intellisense.boardImports`, cleared by Remove; a Skip holds for the quick fix and the
  first-connect offer, the command asks again), then `introspect.modules {names}` (submodules a package imported itself are a
  second round; depth 2, 40 modules in total), then exactly ONE `reset.soft`.
- One `.pyi` per module next to the stock stubs (never replacing a stock file): constants typed from their values, functions and
  methods with `*args: Any, **kwargs: Any` (MicroPython keeps no parameter names), classes (always an any-argument `__init__`),
  properties, `from . import sub as sub`; a module that could not be imported (or was skipped) gets `def __getattr__`. The tracker
  records the board part (`board: {key, label, date, files, modules}`) for Remove, the preview and the Doctor. Automatic runs (quick
  fix, offer) on unchanged firmware read only the listing; without a board the earlier board files are kept.
- Real MicroPython prints frozen packages as `acme/__init__`, `acme/motor` in `help('modules')`; `normalizeListing` accepts that
  form and dotted names. The fake board (`tools/fakeboard.py`) lists frozen packages by their top-level name only.
- Truth test: `UPYBRIDGE_PYRIGHT=<pyright index.js or 1> MPY_SAFE_MODE=1 node scripts/verify-intellisense.mjs --scratch <dir>`
  (scenario `acme` gathers from a fake `BoardAccess` built from `test/fixtures/intellisense/acme-board.json`; also run by
  `UPYBRIDGE_PYRIGHT=... npm test -- intellisense/pyright`).

### What the review of the IntelliSense UI path pinned (2026-10-13; tests in `test/unit/intellisense-wiring-review/`)

- **Links.** The tracker and the dot folder travel with a zip or a git checkout, and both can carry links. Below the workspace folder
  nothing is read, written or deleted THROUGH a link (`src/intellisense/links.ts`; `readWorkspaceState` lists them in `state.links`,
  `applyPlan` and `removeManaged` refuse, the command refuses before any preview when a write or delete would have to go behind
  one). A link AT or above the workspace folder (a OneDrive alias of the project) is still followed. Junctions on Windows: [U].
- **Nothing is deleted without a reason.** Files outside the dot folder (`typings/`, fallback tier) that the tracker lists are removed
  only while their content is still the recorded hash. Earlier board stubs and copies are kept while the board is not connected,
  and earlier stock stubs are kept when the bundled pack cannot be loaded this time (`W_STOCK_UNAVAILABLE`).
- **Permission errors.** `EACCES`/`EPERM` is retried like a lock, but after 3 files in a row the setup stops with one summary error
  (a read-only folder took 75 s before). The apply step and the board-identity wait show a progress notification.
- **One busy flag** for Setup and Remove. Remove clears the remembered answers to the board import question.
- The quick fix is not offered for imports of well-known desktop packages or for attribute errors that are not about a module.

### What the real host taught us

- **A message without buttons never settles by itself.** In VS Code the promise of `showInformationMessage(text)` is resolved only
  when the user dismisses the toast, so `await`-ing it kept `executeCommand(Stop)` pending after the program had stopped. The mock
  resolves such messages at once, which hid this. Use `showToast` from `src/toast.ts` for messages that are only information: it
  shows the message and returns at once when no button is offered, and waits for the choice when buttons are offered (a question).
  In unit tests set `mock.holdButtonlessToasts = true` to get VS Code's behaviour (`test/unit/toast.test.ts` does, for Stop, Reset,
  Run, the sync summary). Toasts WITH buttons are still awaited by their commands (a question, or "Show Log" after a problem); a
  command that shows one stays pending until the toast is answered or dismissed. That is not exercised in a real host yet.
- **Closing the window.** `workbench.action.quit` (what a student does) is graceful: the bridge interrupts the running program
  (Ctrl-C twice), leaves the raw REPL and closes the port (board events `interrupt`, `program_end`, `interrupt`, `raw_exit`,
  `disconnect`; the wrapper logs `python ended with status 0`). VS Code's test-mode exit (`--quit-via test-exit`, the runner simply
  returning) is not: the bridge and its shell wrapper vanish together with the window, without any shutdown line, and a looping program
  is left running on the fake board. The `exitprobe` suite shows that VS Code does NOT kill a detached helper of the extension host in
  that exit (a plain shell helper sees the end of its stdin and keeps running for the second it was watched), so the abrupt end is not
  simply "VS Code kills everything below the extension host". What differs for the bridge is not identified, and nothing in our
  extension, in `bridge/` or in VS Code's bundle was found that kills it. Until it is explained, do not use `--quit-via test-exit` to judge shutdown, and treat "the bridge dies without interrupting" as an open
  question for a host that is killed outright (power loss, crash). Use `--bridge-trace` to see how the Python process ended.
- **A cached tree view is stale state, and a suite run alone hides it.** The Files view caches each folder's listing, and Upload
  Current File changed the board without re-listing it, so "the Files view shows the uploaded file by itself" failed in about 40%
  of `--suite all` launches (an earlier step had listed the root; whether VS Code's background re-listing came before the upload
  decided it) and never in `--suite flow` (nothing was cached yet). Now everything that changes the board announces the paths
  (`onBoardChanged`) and the view re-lists only the folders showing them. The test fills the cache first, and `flow` runs after
  `views`: do the same for any test that asserts that a view updates.
- VS Code exits with code 1 after `workbench.action.quit` in test mode even when every test passed; the launcher ignores that code.
- The first launch without `VSCODE_PORTABLE` rewrote `~/.vscode/argv.json` (985 bytes). The launcher now always sets it; every later
  launch reported no change to the real profile (`realProfileChanges: []` in `summary.json`).

## Marketplace screenshots (README.md)

`README.md` is the Marketplace page (D-25). Its screenshots in `images/` are taken from a real VS Code by a script, under the
same isolation as the test launcher (throwaway `/tmp/mpyvs` profile with the built VSIX installed, fake board, hard timeout,
process-group kill, `ps` and real-profile checks). A VS Code window appears for about a minute and is driven only through
Playwright's Electron driver (`playwright-core`, a pinned devDependency; no browser is downloaded, no OS-level input):

```
npm run package                                                               # the VSIX that gets installed and photographed
timeout 420 python3.13 -B tools/vscode_test/screenshots.py --with-python-extensions   # all shots (Pylance needed for the IntelliSense ones)
timeout 200 python3.13 -B tools/vscode_test/screenshots.py --no-folder        # the Open Folder welcome
timeout 200 python3.13 -B tools/vscode_test/screenshots.py --details-check    # check only: the extension page from the installed VSIX
```

The demo material is made up (`tools/vscode_test/demo/`: a line-follower project and a `rover` firmware library). The step log
and any `check-*.png` go to `tools/vscode_test/reports/<run>/`. `--only a,b` re-takes some shots. The package test checks that every
README image is a relative `images/*.png` that exists and that `images/` holds nothing else. Images are not in the VSIX: README
images must be https URLs on the Marketplace and in VS Code's extension page, so they are served from the repository. `package.json`
names github.com/jpswensen/upython-bridge, so `vsce` rewrites each link to `https://github.com/jpswensen/upython-bridge/raw/HEAD/images/<name>.png`
(a package test reads the README inside the VSIX and checks this). New or changed screenshots therefore show up only once they are
pushed to the default branch (`main`).

## Build the extension from a clean clone, install it, make a release

```
git clone https://github.com/jpswensen/upython-bridge.git && cd upython-bridge
npm ci                               # exact versions from package-lock.json; install scripts are off (.npmrc)
npm run package                      # out/upython-bridge-<version>.vsix
code --install-extension out/upython-bridge-0.1.0.vsix   # or: Command Palette, "Extensions: Install from VSIX..."
```
Nothing else is needed for the VSIX: the stub packs (`resources/stubs/`) and the Python libraries (`bridge/vendor/`) are committed,
and `.gitattributes` keeps every file byte for byte on every OS (the stubs keep their CRLF line ends and are hashed in
`resources/stubs/MANIFEST.json`; `node scripts/vendor-stubs.mjs --check` re-hashes them). The Python tests need `python3.13` (any 3.9+
runs the bridge); the suites in a real VS Code need VS Code. Not in the repository (`.gitignore`): `node_modules/`, `dist/`, `out/`,
test and hardware reports, board backups, and `private/` (course- and board-specific material that stays on the instructor's machine).

Making a release (maintainer, only when asked):
1. `npm version <x.y.z> --no-git-tag-version` (updates `package.json` and `package-lock.json`), update the status note in `README.md`,
   `npm run verify`.
2. Commit, `git tag v<x.y.z>`, `git push origin main v<x.y.z>`.
3. Build the VSIX from a fresh clone of the tag (the commands above), so it contains only committed files.
4. `gh release create v<x.y.z> out/upython-bridge-<x.y.z>.vsix --prerelease --title "μPython Bridge <x.y.z>" --notes-file <notes.md>`
   (drop `--prerelease` once it has been tried on Windows and by students).
Do not install into your everyday VS Code profile while an older MPY Workbench is enabled: turn that one off first (the Doctor warns).
For a throwaway profile use `code --user-data-dir <scratch> --extensions-dir <scratch> --install-extension ...`.
The orchestrated, isolated launch is `tools/vscode_test/launch.py` (CLAUDE.md, "VS Code / Electron launches").

## Smoke checklist for a human (needs the VSIX in a real VS Code and, for the starred items, a real board)

Before you start: the motor-power checklist in `CLAUDE.md` (motor battery off, only the USB cable, nothing else holds the port,
instructor present). Use a test folder with `hello.py` (a print) and `loop.py` (`while True:` with a `print` and `time.sleep(0.2)`).

1. Install the VSIX in a clean profile. The μPython Bridge icon appears. Open the folder. The Files view says "No serial port selected".
   *Output channel "μPython Bridge" shows "is ready"; no Python process was started (Activity Monitor / Task Manager).*
2. Open the Doctor (Board Actions). It names the Python in use and shows no red items. With the older extension turned on, a
   warning with an **Open Doctor** button appears at startup.
3. **Select Serial Port** (Files view title bar). *The board appears first in the list; choose it.* The status bar shows
   `<port> - Ready`; the Files view lists the board files. The board did not reset (no restart message, motors quiet).
4. Run `hello.py` with **Run file**: the μPython Bridge terminal tab opens, shows the output and `[program finished]`.
5. Run `loop.py`, type a key in the tab (it reaches the program), press **Stop / Interrupt**: `[program stopped]`, status Ready.
6. Edit and save a file with auto-sync on (answer the first-connect question): the Sync utilities row shows a count and it goes to 0;
   the file is on the board after Refresh. **Upload all files** shows a plan first and a result per file. Try a folder name
   with spaces, parentheses and a non-ASCII letter, and a folder under OneDrive.
7. **Open REPL**: the prompt works; Ctrl-C and Ctrl-D behave; no `source .venv/bin/activate` or `conda activate` line is typed in.
8. **Reset board...**: the menu shows the levels; soft reset restarts Python only; a level above it asks for confirmation first.
   *Do not use the machine or RTS/DTR levels with motor power on.*
9. Unplug the USB cable: status bar `Unplugged`; plug it back in: it reconnects, or Select Serial Port reconnects.
10. Open a second VS Code window on the same folder: the port is "In use" with a clear message and **Retry**.
11. Open the folder in Restricted Mode (untrusted): the Files view and commands say to trust the folder; no Python process starts.
12. Close VS Code while `loop.py` runs: the program on the board stops (watch the board's output or the LED).

## Not verified yet

Checked in a real extension host on 2026-10-13 (fake board only, see "Tests in a real VS Code"): activation by view and by command,
lazy start, the three views and their reveal, the Files view following the connection, status bar texts, the Run tab as a
Pseudoterminal (output, keystrokes, Stop, tracebacks in `File "<path>", line N` form), the Python and Python Environments
extensions not receiving our input, coexistence with the older extension, and a graceful window close.

Still unverified for the IntelliSense setup: Windows (relative paths between drives, `fsPath` case, OneDrive placeholders), the buttons of the first-connect offer and of the "Show what changed" toast in a real window (the host suite answers them through the test hook; the toast text and buttons are only unit-tested), a multi-root workspace, the board-based stubs on the instructor's real board (only the fake board and the bridge-shaped fixture were used; real MicroPython lists frozen packages as `pkg/__init__`, see the section above), and Pylance versions other than 2026.4.1.

Still unverified about the names and icons (D-18, D-19): that a `when` clause with a hyphenated key is EVALUATED as intended (an extension host has no way to read it: VS Code 1.141 has no command that returns a context key, only `getContextKeyInfo`; the tests show that VS Code accepts `setContext` for the hyphenated keys and that the manifest's clauses name only those keys, and the lexer of VS Code 1.141 takes `-` inside a key, read from `workbench.desktop.main.js` `stringRe`); how the Greek mu is DRAWN in the sidebar title (VS Code upper-cases the title with CSS, and the upper case of U+03BC is the Greek capital Mu U+039C, which looks like a Latin M: it may read "MPYTHON BRIDGE"; the short form `uPy Bridge` would read "UPY BRIDGE"); the icons as drawn (activity bar glyph, terminal tab icon in light and dark themes, the danger trash icon, the Marketplace icon at real size; no screenshots were taken); the Marketplace listing.

Still unverified: the Board Actions and Sync utilities rows, tree item identity and expansion state across refreshes, theme icons
and colours as drawn (no screenshots were taken), that the traceback links are actually clickable, Ctrl-E and other keyboard
shortcuts, Workspace Trust and Remote detection in a real window, file decorations, the settings UI, installing the VSIX with
`vsce`/`code --install-extension`, what happens when the extension host is killed outright (see "Closing the window"), and toasts
with buttons that keep a command pending (the offer "Copy it to my project" is such a toast: the host test only checks that the click and Run finish while it is open, never that its button works). Also: Windows in general (`py -3`, the Store stub, `taskkill`, COM renumbering,
backslash paths, `launch.py` itself), and any real board.
