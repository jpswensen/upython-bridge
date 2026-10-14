# Extension design (TypeScript side)

Written by the scaffold step. It fixes the shared foundation that four feature agents and the integrator build on: module map, the `BoardSession` contract, folder ownership, the activation sequence, test conventions, how to run everything. Sources: `CLAUDE.md` (hard rules), `docs/decisions.md`, `docs/requirements.md`, `docs/protocol.md` (+ addendum), `docs/analysis/04` (UI), `06` (core, the 10 invariants), `02` s.10, `03` s.6. Names come only from `src/identity.ts`.

Evidence labels as in `CLAUDE.md`: [E] executed, [S] read from source, [D] documented, [K] known, [I] inferred, [U] unverified. Everything about Windows, a real board or real VS Code is [U] until a later stage runs it.

## 1. Layers and dependency direction

```
extension.ts                 activate()/deactivate() only; builds Services, calls register*(); integrator
  |
  +-- commands/*  views/*  statusbar.ts  repl/*  sync/* (UI-facing)  doctor.ts     [may import vscode]
  |      |
  |      v  talk to the board ONLY through BoardSession (src/types/session.ts)
  +-- session/  --> bridge/  --> python/                                           [Node only; vscode only via injected adapters]
  |
  +-- types/*  identity.ts  contributes.ts  log.ts                                 [pure; settings.ts is the one vscode user]
```

Rules (enforced where a test can enforce them, otherwise by review):

1. Dependencies point down. A module never imports a sibling feature folder; it uses the interfaces in `src/types/**` and command ids (`COMMAND_IDS`).
2. Only the top layer imports `vscode`. Pure modules (`bridge`, `python` resolver core, `sync` planner/paths/ignore/baseline, `types/*` except `settings.ts`) do not, so their tests need no mock.
3. No module-level mutable state. Services are classes constructed in `activate()` and disposed through `context.subscriptions` (lint rule `no-module-level-state`).
4. One owner of the device: the bridge process. `session/` is the only code that knows it exists. Nothing else opens a port (R-ARCH-1).
5. No shell: `spawn`/`execFile` with argv arrays, `shell:false`, `windowsHide:true`; no `sendText`; no `console.*` (lint).
6. Device paths are `path.posix` strings; local paths go through `path` or `vscode.Uri`. Windows facts (backslashes, drive letters, `COM12`) are injected in tests (`WINDOWS` fixtures, `path.win32`).
7. Every failure reaches the user in English with the next step (`userMessage(err)`) and the log (`Logger.error`). No empty `catch` (lint).
8. Safe defaults: connect, disconnect, refresh, auto-sync never reset the board; Stop never escalates to a reset; reset tiers above soft need `confirmed:true` and a visible confirmation.

How the ten invariants of `06-ext-core.md` s.6 are enforced:

| # | Invariant | Where it is enforced |
|---|---|---|
| 1 | single owner of the port, FIFO with priorities | bridge process (Python, tested); `session` never reorders |
| 2 | interpreter validated by a probe, deterministic order | `python/` (client), D-13 |
| 3 | no shell strings, same on macOS and Windows | lint `no-shell-true`, `no-string-command`, `spawn-needs-windowsHide`, `no-exec-string` |
| 4 | no implicit settings writes; board selection survives reload | `Settings.update` only on user action; `PortMemory` (workspaceState); lint `no-auto-port` |
| 5 | every action ends in one visible outcome | `userMessage`, `Logger`, lint `no-empty-catch` |
| 6 | every process has an owner, a timeout, a way to die | `bridge/` client (`taskkill /T /F` on Windows), `session.dispose()` |
| 7 | Run/REPL/Stop are a state machine | bridge state machine mirrored in `SessionState.state` |
| 8 | mirroring is explainable and cannot lose work | `SyncPlan`/`SyncResult` types, `sync/` (plan, preview, per-file results, baseline only for successes) |
| 9 | manifest and code agree | `test/unit/contributes.test.ts`, `mock.commandContract()`, the mock refuses undeclared views |
| 10 | honest in restricted, virtual, remote windows | `capabilities.untrustedWorkspaces`, `env.remoteName` check in `activate()` |

## 2. Module map (one responsibility each)

Files marked *(scaffold)* exist now. Others are the planned files of each owner; owners may split or merge within their folders but keep the responsibilities.

| Path | One responsibility | Owner |
|---|---|---|
| `src/identity.ts` *(scaffold)* | every product name; helpers `commandId`, `settingId`, `contextKey`, `viewId`, `viewContainerId`, `fullExtensionId` | scaffold |
| `src/contributes.ts` *(scaffold)* | the one table that generates `package.json` (`commands`, `views`, `menus`, `settings`, activation, trust); `COMMAND_IDS`, `VIEWS`, `CONTEXT`, `TREE_CONTEXT`, `SETTING_DEFAULTS`, `allCommandIds()` | scaffold |
| `src/log.ts` *(scaffold)* | `Logger` over an output channel with levels and scopes; no `vscode` import | scaffold |
| `src/types/protocol.ts` *(scaffold)* | typed mirror of `docs/protocol.md`: ops (`OpMap`), events, error codes, error body, states | scaffold |
| `src/types/session.ts` *(scaffold)* | `BoardSession`, `SessionState`, `SessionEvent`, `BoardError`, `userMessage` | scaffold |
| `src/types/settings.ts` *(scaffold)* | `Settings` (typed getters over configuration), `normalizeRootPath`, `PortMemory` | scaffold |
| `src/types/sync.ts` *(scaffold)* | `SyncPlan`/`SyncItem`/`SyncResult`/`SyncBaseline`, `BoardNode`, `SyncGate`, `SyncStatusSource` | scaffold |
| `src/types/services.ts` *(scaffold)* | `Services` bag, `SelectPortArgs` | scaffold |
| `src/extension.ts` *(stub)* | `activate`/`deactivate`: construct services in order, register, never throw | integrator |
| `src/bridge/client.ts` | `BridgeClient`: spawn the one bridge, NDJSON framing, id correlation, event decoding, per-call timeout and abort, bounded restart, kill tree | client |
| `src/bridge/types.ts` | the narrow `Bridge` interface (so a Node serial implementation could replace the Python one, R-ARCH-8) | client |
| `src/python/resolver.ts`, `probe.ts` | interpreter discovery in D-13 order, validation by running a probe (`-I`, 5 s) | client |
| `src/session/boardSession.ts` | `BoardSession` over a `Bridge`: lazy start, state mirror, connect + identity probe, config push, bounded reconnect, `stopFirst` on disconnect during Run | client |
| `src/doctor.ts` | Doctor report and command, startup checks (old extension, remote/virtual, untrusted, cloud folder, terminal activation settings) | client |
| `src/views/filesView.ts` | Files tree (board listing, empty/error rows, `refresh` command) | views |
| `src/views/actionsView.ts`, `syncView.ts` | the two flat row views; rows call commands by id | views |
| `src/views/contextKeys.ts` | sets `hasPort`, `connected`, `running`, `interpreterProblem` from session state | views |
| `src/views/decorations.ts` | `FileDecorationProvider` fed by `SyncStatusSource` | views |
| `src/statusbar.ts` | status bar items: board/port/state, auto-sync, pending count | views |
| `src/repl/replTerminal.ts` | the REPL/Run `Pseudoterminal`: a view on session events, raw keystrokes via `tty.write` | terminal |
| `src/repl/inputFilter.ts` | drops environment-activation lines typed by other extensions (RQ-TERM-2) | terminal |
| `src/repl/links.ts` | traceback link provider (local path of the compiled buffer) | terminal |
| `src/commands/{run,stop,reset,repl,ports}.ts` | handlers of `runActiveFile`, `stop`, `resetBoard`, `openRepl`, `selectPort`; sets `hardResetAvailable` | terminal |
| `src/sync/paths.ts`, `ignore.ts`, `baseline.ts`, `planner.ts` | pure: path mapping, ignore rules (`ignore` package, `.mpyignore`), baseline file, plan from manifests | sync |
| `src/sync/engine.ts`, `autoSync.ts` | execute plans with per-file results; save listener, debounce, defer while running; implements `SyncGate`, `SyncStatusSource` | sync |
| `src/commands/{sync,boardFiles}.ts` | handlers of `syncToBoard`, `syncFromBoard`, `clearDevice`, `toggleAutoSync`, `uploadActiveFile`, `openFileFromBoard`, `newFileOnBoard`, `newFolderOnBoard`, `renameOnBoard`, `deleteOnBoard`, `deleteOnBoardAndLocal` | sync |
| `src/commands/index.ts` | registers everything from one list, wraps each handler in an error boundary (log + one toast); `showLog` | integrator |

Commands are declared once (`COMMANDS` in `contributes.ts`) and registered by their owner: `refresh` (views), `selectPort` `runActiveFile` `stop` `openRepl` `resetBoard` (terminal), the eleven sync/board-file commands above (sync), `doctor` (client), `showLog` (integrator). The activation test fails when a declared id is not registered or the reverse (`mock.commandContract()`).

Context keys (`CONTEXT`): views set `hasPort` (= a port is selected), `connected`, `running`, `interpreterProblem` (= `SessionState.interpreter === 'problem'`); terminal sets `hardResetAvailable` (reset capability `verified`/`likely`, RQ-RESET-3). Nobody else calls `setContext`.

Tree items: `contextValue` is `TREE_CONTEXT.file` or `TREE_CONTEXT.dir`; commands from the tree receive a `BoardNode`. Menus in the manifest match on those two values.

## 3. The BoardSession contract (src/types/session.ts)

`BoardSession` is the only way any feature reaches the board. Tests fake it with `FakeSession` (`test/mocks/fakeSession.ts`); the real one wraps the bridge client.

**State.** `session.state` is an immutable snapshot, replaced on every change; `onDidChangeState` fires after each replacement.

| Field | Meaning |
|---|---|
| `bridge` | `stopped` (not started; the bridge starts lazily on first need), `starting`, `ready` (after `hello`), `exited` (crashed; next use restarts it, bounded) |
| `interpreter` | `unknown`, `ok`, `problem` (no working Python; drives the Doctor welcome text) |
| `state` | bridge state machine: `disconnected`, `connecting`, `idle` (friendly prompt), `running` (user program), `rawop` (a bridge file op holds the REPL) |
| `reason` | why it last changed (`prompt seen`, `unplugged`, `board-reset`, ...); for logs and tooltips, never parsed |
| `port`, `portInfo`, `sync` | connected port, what the open found (`kind`, adapter, `canHardReset`), what connect saw (`prompt`, `running-program`, `silent`, `prompt-unverified`) |
| `identity` | result of the read-only identity probe after the first confirmed idle prompt; null before and after disconnect |
| `pendingSyncCount` | files auto-sync has not uploaded yet (set through `setPendingSyncCount`) |

**Calls.** `call(op, args, opts?)` is typed per op from `OpMap` (`src/types/protocol.ts`). It resolves with the result fields or rejects with `BoardError` (`.code`, `.hint`, `.detail`, `.needsInterrupt`, `.needsAllowMount`, `.body`). `opts.timeoutMs` and `opts.signal` are client-side: expiry gives `E_CALL_TIMEOUT`, abort gives `E_ABORTED`, and the session sends `cancel` for the bridge request when it can. Client-made codes: `E_CALL_TIMEOUT`, `E_BRIDGE_EXITED`, `E_ABORTED`, `E_NO_PYTHON`. Every bridge code is in `BRIDGE_ERROR_CODES`.

**Connection.** `connect(port)` records the port as `selectedPort`, then calls the bridge `connect`. It never resets, interrupts or enters the raw REPL (RQ-SAFE-1), never accepts the word auto (D-11), and on failure leaves `selectedPort` set so Retry works. `disconnect({stopFirst})`: during a Run the caller must pass `stopFirst` explicitly (Appendix C). `selectPort(null)` forgets the selection. Other modules that need a connection call `executeCommand<boolean>(COMMAND_IDS.selectPort, { reuse: true })` (`SelectPortArgs`); terminal's `ports.ts` implements it: reuse the selected/remembered port when present, else exactly one candidate connects, several open a QuickPick, none shows a message.

**Consent flows.** Bridge ops that need an idle board answer `E_PROGRAM_RUNNING` with `needs_interrupt` and a student-readable hint. The caller asks the user once ("Stop the running program?") and repeats with `interrupt: true`. `fs.rmtree` of a mount point answers `needs_allow_mount`; ask, then repeat with `allowMount: true`. Reset ops need `confirmed: true` shown after the confirmation text (profile `resetWarning`, generic default).

**Events.** `onEvent` delivers `state`, `repl`, `out`, `err` (bytes already decoded to `Uint8Array`), `progress`, `log`, `hello`, `fatal`, in arrival order. The REPL/Run terminal is only a listener plus `tty.write`; it never owns the port. Keystrokes go raw (RQ-RUN-1); Stop uses `call('stop', ...)`, which bypasses the bridge queue.

**Background work.** Auto-sync and tree refresh pass `background: true` (fs.put/list/manifest) so user actions overtake them; auto-sync also waits while `isRunning` and shows "N files pending".

**Reconnect policy** lives in the session, bounded, and stops on `E_PORT_BUSY` (message plus Retry). Unplug is `state: disconnected, reason: unplugged`. After `reset.machine` with `reconnect: true` the session reconnects to the same VID/PID within a bounded window (the Windows COM number may change).

**Lifetime.** `dispose()` sends `shutdown` (or closes stdin), kills the process tree on timeout, rejects pending calls with `E_BRIDGE_EXITED`, and is idempotent. With `stopOnDisconnect` (default true) the bridge interrupts a running program when the host goes away (RQ-SAFE-4).

**What `FakeSession` models:** `E_NOT_CONNECTED` while disconnected, the program-running gate with `needs_interrupt`, timeouts and aborts, held calls (`hold(op)`), scripted/once/failing answers, events and state changes, an optional in-memory board filesystem (`useBoardFs`), and `E_UNSUPPORTED` with a clear message for any op nobody scripted.

## 4. Folder ownership for the feature agents

Everyone writes only inside their folders and their tests. Contract changes (anything under `src/types/**`, `src/contributes.ts`, `src/identity.ts`, `test/mocks/**`, `package.json`) go to the integrator as a request; the scaffold owner reconciles.

| Agent | Owns | Tests go in |
|---|---|---|
| **client** | `src/bridge/**`, `src/python/**`, `src/session/**`, `src/doctor.ts` | `test/unit/bridge/**`, `session/**`, `python/**`, `doctor*.test.ts`; integration against the real bridge with `test/mocks/fakeBridge.ts` |
| **views** | `src/views/**`, `src/statusbar.ts` | `test/unit/views/**`, `statusbar.test.ts` |
| **terminal** | `src/repl/**`, `src/commands/{run,stop,reset,repl,ports}.ts` | `test/unit/repl/**`, `commands/{run,...}.test.ts` |
| **sync** | `src/sync/**`, `src/commands/{sync,boardFiles}.ts` | `test/unit/sync/**`, `commands/{sync,boardFiles}.test.ts` |
| **scaffold** | `package.json`, `package-lock.json`, `tsconfig*.json`, `scripts/**`, `test/mocks/**`, `src/identity.ts`, `src/log.ts`, `src/contributes.ts`, `src/types/**`, `src/extension.ts` (stub), `docs/extension-design.md`, `media/**`, licence and ignore files, `test/unit/{lint,mocks,contributes,fakeBridge}.test.ts` | - |
| **integrator** | replaces `src/extension.ts`; `src/commands/index.ts`; end-to-end activation tests | `test/unit/activation.test.ts` |

Cross-feature interfaces (all in `src/types`): sync implements `SyncGate` (Run calls `flushPending()` before it runs, D-07) and `SyncStatusSource` (decorations); views produce `BoardNode`; everything else goes through `BoardSession` and command ids. Feature code that needs a collaborator takes it as a constructor argument typed by the interface, so tests pass a fake.

## 5. Activation sequence (the integrator implements)

`activate(context)` is fast, non-throwing, registers everything through `context.subscriptions`, and does no `await` before registration. Order:

1. `log = createLogger(vscode.window, IDENTITY.outputChannelName)`; push it. Everything below logs through it.
2. `settings = new Settings()`; `log.setLevel(settings.logLevel)`; on `settings.onDidChange` update the level.
3. `portMemory = new PortMemory(context.workspaceState)`.
4. Window checks: if `vscode.env.remoteName` is set or a workspace folder is not `file:`, register every command with a handler that shows the "open the folder locally" message (R-ARCH-10), set the welcome state, and stop. Untrusted workspace: continue, but nothing workspace-controlled is used (restricted settings already read as defaults; a workspace `.venv` interpreter only after trust, D-13).
5. `session = new <client>BoardSession({ context, log, settings })`: lazy, no process yet; push it. If `portMemory.get()` has a port, `session.selectPort(device)`; do not connect.
6. `services = { context, log, settings, session, portMemory }` (`Services`).
7. Sync: construct the engine from `services` (it implements `SyncGate` and `SyncStatusSource`; its save/rename/delete listeners start disabled until step 10).
8. Views: `registerViews(services, { syncStatus })` creates the three tree views with the declared ids, the context-key setter, decorations and status bar items.
9. Commands: each owner's `register...(services, deps)` returns disposables; terminal gets `syncGate`; then `showLog`; then the integrator asserts `declared == registered` in the activation test.
10. Start auto-sync listeners (`onDidSaveTextDocument`, file watcher, rename/delete events).
11. Fire-and-forget startup checks, each with its own `catch` that logs: Doctor's old-extension and environment checks, first-connect auto-sync question (`ask` mode) is asked when the first board connects, not here.
12. `deactivate()` is empty: disposal runs through `context.subscriptions` (reverse order), which sends `shutdown` to the bridge.

No settings are written, no port is opened and no process is spawned during activation. [I] to be verified by the integrator's activation test with the mock, then by the isolated real-VS-Code stage.

## 6. Test conventions

- Runner: `node:test` with `node:assert/strict`, files `test/**/*.test.ts` (outside `test/mocks`), bundled per file by esbuild with `vscode` aliased to `test/mocks/vscode.ts` ([E]: `npm test` here).
- Mock hygiene: `beforeEach(() => mock.reset())` and `afterEach(() => mock.reset())`; `reset()` disposes what the code created and throws if an event listener threw (`mock.takeListenerErrors()` to inspect on purpose).
- Prompts are scripted before the code runs: `mock.answerQuickPick('Reboot board')`, `mock.answerMessage(/Delete/, 'Delete')`, `mock.answerInputBox('lab1.py')`; assert on `mock.calls.*`. Unscripted prompts are dismissed; set `mock.strictPrompts = true` to make them fail.
- The mock copies VS Code's strictness: `createTreeView` of an undeclared view throws, duplicate `registerCommand` throws, unknown `executeCommand` rejects, `update()` of an unregistered setting rejects, restricted settings read as defaults when `mock.setTrusted(false)`.
- Terminals: `vscode.window.createTerminal({ name, pty })` gives a `MockTerminal` in `mock.terminals`: `await t.opened`, `t.type('x')`, `await t.waitForOutput('>>> ')`, `t.output`, `t.sentText` (must stay empty for product code).
- Files: real temp folders through `TempDirs` (clean up in `afterEach`), or `mock.fsMode = 'memory'` for Windows-shaped URIs.
- Paths: fixtures include spaces, parentheses and non-ASCII (`makeTrickyDir`, `TRICKY_SEGMENTS`) and Windows strings (`WINDOWS.*`; `Uri.file('C:\\...')` uses Windows rules on any host). Pure modules take `path.win32`/`path.posix` as a parameter so both run on one machine. Never claim "works on Windows" from these; label as injected.
- Sessions: `FakeSession.connected()`, then `script`, `scriptOnce`, `fail`, `hold`, `emit`, `setState`, `useBoardFs`. `dec`/`enc` helpers for bytes. `expectRejects` accepts the Thenables that the vscode API returns.
- Real bridge, fake board: `withBridge(async ({ board, bridge }) => ...)` from `test/mocks/fakeBridge.ts` starts `tools/fakeboard.py` (TCP, never a serial port) and `bridge/mpy_bridge.py` with argv arrays and `MPY_SAFE_MODE=1`; `integrationSkipReason()` skips without Python >= 3.9. Always bounded and cleaned (`stopAll()` in `afterEach` as a safety net). Do not point anything at `/dev/cu.*`, `/dev/tty.*` or `COMn`; the bridge refuses them in safe mode, but tests must not even try with a real name.
- Lint: `test/unit/lint.test.ts` scans `src/**` (`npm run lint`). Justified exceptions: `// lint-allow: <rule-id> <reason>` on the same or previous line.
- Evidence discipline: say what you ran and observed; do not report a rule as covered unless a test would fail without it.

## 7. Commands (from the repository root; Node >= 20)

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src/**` and `test/**` (strict) |
| `npm test` / `npm test -- <filter>` | bundle and run all tests; `<filter>` is a substring of the test file path (case-insensitive), or a test-name pattern when no file matches; `--name <regex>` (`-t`) forces a name pattern; `--list` prints the files; `--keep` keeps the temp bundles; exit code = node's |
| `npm run lint` | only `test/unit/lint.test.ts` |
| `npm run gen:manifest` | rewrites `name`, `displayName`, `publisher`, `description`, `capabilities`, `activationEvents`, `contributes` of `package.json` from `src/contributes.ts` + `src/identity.ts`; `-- --check` fails (exit 1) when it is out of date |
| `npm run build` | esbuild: `src/extension.ts` to `dist/extension.js` (cjs, node20, `vscode` external, source map); `node scripts/build.mjs --production` minifies |
| `npm run package` | production build then `vsce package --no-dependencies` into `out/<name>-<version>.vsix` |
| `npm run verify` | typecheck, manifest check, tests, build, size budget (5 MiB); `-- --with-python-guard` also runs `tools/check_generic.py --strict` (not required yet) |

Install rules: `npm install --ignore-scripts` only inside this folder, exact versions pinned (`.npmrc` sets `save-exact`, `ignore-scripts`), never global, never `npm audit fix`. Test bundles go to `os.tmpdir()/upy-bridge-tests-<pid>-<time>` so concurrent runs do not clash.

## 8. Open questions

1. **Editor and Explorer entry points.** `04` s.15.2 proposes a Run button in the editor title and "Upload to Board" in the Explorer menu. Not in the manifest yet (the plan lists only the sidebar). Add `editor/title/run` for `resourceLangId == python`?
2. **Reset ops in `protocol.md`.** `reset.capability`, `reset.machine` and the new `reset.hard` options exist in `bridge/server.py` but Appendix D of `protocol.md` was not written when this file was; `src/types/protocol.ts` follows the code. Reconcile when the bridge side finishes (arguments `learned`, results `portDropped`, `reconnect`, `cacheKey`).
3. **Windows `COM` renumbering after native-USB reset.** The session reconnects "to the same VID/PID within a bounded window"; the window length and the QuickPick fallback are the client agent's call.
4. **Multi-root workspaces.** Everything assumes `workspaceFolders[0]`. Show a message for more than one folder, or support them?
5. **Publisher and Marketplace.** Publisher `jpswensen` (D-26; was the placeholder `local`), own icon (D-19). Distribution so far: VSIX on GitHub Releases; publishing on the Marketplace needs a Marketplace publisher with that id (Q-04).
6. **Firmware profile loading.** `profile.json` (D-15) is not read by anything yet; `config { shadowGuard }` should be pushed after connect from profile + `identity.profileHints.modules`. Owner: client (session) with sync (uploader guard).
7. **Auto-sync first-connect question** (D-10) needs `workspaceState` keys; propose `sync` owns them under the extension prefix via a helper like `settingId` (add a `stateKey` helper to `identity.ts` if wanted).
8. **Error toasts.** `userMessage(err)` exists; a shared `reportError(services, action, err)` (log + toast with "Show log") is expected in `src/commands/index.ts` from the integrator. Until then feature code logs and shows `userMessage`.
9. **Min VS Code.** `engines.vscode` is `^1.90.0` with `@types/vscode` `1.90.0`; the instructor runs 1.141 [D]. Raise only if a needed API requires it.
