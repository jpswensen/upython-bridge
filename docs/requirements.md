# Requirements

Testable requirements for `mpy-upgrade`. Each acceptance cell becomes one checkbox in `plan.md` under the round that implements it.
"Fake" = verifiable on the fake board / CI with no hardware. "HW" = needs a human with the board. Source: `analysis/09-architecture-options.md` sections 11 and F4 (the reconciled register). The register's decision IDs (D-xx) are in `decisions.md`.

## Architecture-level (R-ARCH)

1. R-ARCH-1 One port owner (the bridge); nothing else in the extension opens the device; the REPL terminal never owns it.
2. R-ARCH-2 No shell strings anywhere: `spawn`/`execFile` with argv arrays; no `sendText` of commands; no `echo` into device nodes.
3. R-ARCH-3 Bridge starts as `python -I -u -X utf8 -X pycache_prefix=<writable dir> bridge.py`, vendored deps first on `sys.path`, protocol on a reserved fd, exits on stdin EOF. Python floor 3.9 (D-09); on stdin EOF while a program is running the bridge also interrupts it (RQ-SAFE-4).
4. R-ARCH-4 Interpreter discovery validates candidates by running a probe; an explicit setting is never silently ignored; Store stubs and Python < 3.9 are rejected; result and reason shown by a Doctor command. Discovery is Python-Environments-extension-API first (D-13) and does not depend on PATH or on how VS Code was launched.
5. R-ARCH-5 State machine with explicit states and a documented transition table; Stop and `repl.write` bypass the queue; no automatic hardware reset; file operations never run while a user program is running without consent.
6. R-ARCH-6 Sync decisions use content hashes; per-file results; manifest updated only for files that succeeded; destructive actions confirmed; manifest keyed by (workspace, board `machine.unique_id()`) in `context.storageUri`.
7. R-ARCH-7 No native Node modules; one universal VSIX; size budget stated (< 5 MB without stubs); licences shipped.
8. R-ARCH-8 `Bridge` interface in TypeScript so a Node/serialport implementation could replace the Python one without touching views.
9. R-ARCH-9 Hardware-free test suite (L0-L3) runs on macOS and Windows in under a few minutes and gates every round; a regression test pins each defect in `old-defects.md` that the new code must not reintroduce. CI includes Windows runners, the OneDrive-style path fixture (RQ-CLOUD-1) and a program-stdin scenario.
10. R-ARCH-10 Remote/WSL windows and untrusted workspaces get an explicit message, not silent failure.
11. R-ARCH-11 Activation on a project marker or view visibility, not on every Python file.
12. R-ARCH-12 Auto-reconnect is bounded; busy ports are classified and explained.

### F4. Requirements the notes did not state (new, plus amendments)

Each acceptance cell becomes one checkbox in `plan.md`. "Fake" = verifiable on the fake board/CI with no hardware; "HW" = needs a human with the board.

#### F4.1 Reset and hardware safety (RQ-SAFE)

Basis: N-7. The firmware project's own lab rule is "VBATT off while flashing/resetting" (`upy_port.md:1249`).

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| RQ-SAFE-1 | **Connect, disconnect, tree refresh, auto-sync and reconnect never reset the board.** No Ctrl-D, `machine.reset()`, RTS/EN pulse or bootloader entry as a side effect. The open/close line sequences copy mpremote's (`mpremote/transport_serial.py:70-97` CP210x-on-Windows sequence, `:122-133` RTS-then-DTR close) | Fake: event log shows 0 soft resets and 0 RTS pulses over 20 connect/disconnect cycles. HW (VBATT off): `time.ticks_ms()` monotonic across 20 cycles on macOS and Windows (S-03) | DECIDED; SPIKE S-03 |
| RQ-SAFE-2 | **Two tiers of reset.** Soft reset (Ctrl-D at the friendly prompt, or Run's fresh start) is the only reset used implicitly. Hardware reset exists only as an explicit command and never as an automatic escalation; it opens a confirmation that quotes the lab rule ("turn motor power (VBATT) off first; motor 2 can spin for about 0.3 s at every hardware reset"), with "do not ask again this session" | Unit test: only the `reset.hard` handler can reach the RTS-pulse code. Fake: Stop escalation ends at "board not responding" plus a button, never a reset | DECIDED |
| RQ-SAFE-3 | **Stop always reaches the board.** Stop bypasses the queue, sends Ctrl-C twice, and stays enabled while a program runs (Ctrl-C is the safe verb here: `MICROPY_BOARD_AFTER_PYTHON_EXEC` stops motors and servos on Ctrl-C or an uncaught exception, `CLAUDE.md:147-148`). No prompt within about 3 s -> message plus the explicit hard-reset button (RQ-SAFE-2). This fixes 02 F5 (Ctrl-C in the old Run terminal never reached the board) | Fake: scenarios "ignores Ctrl-C" and "stop twice" (Appendix G #8, #10); Stop latency < 100 ms on the fake | DECIDED |
| RQ-SAFE-4 | **Losing the host stops the program.** Closing the Run/REPL terminal, reloading the window, extension deactivation, or the bridge seeing stdin EOF while a program is Running sends Ctrl-C twice (best effort, 1 s) before closing the port; setting `stopOnDisconnect` default true, so a crashed VS Code does not leave motors running. (09 section 5.1 only says "exit and release the port".) | Fake: `kill -9` of the parent while a `while True` program runs -> the program is interrupted before the bridge exits | DECIDED (default is classroom-safety driven; user may flip) |
| RQ-SAFE-5 | **The extension never flashes, erases or installs firmware**, and never offers "Install MicroPython". A board without `_shield` gets an instruction to ask the TA for the course firmware (`CLAUDE.md:214`; `upy_port.md:1011`) | Review item; identity scenario in RQ-ID-3 | DECIDED |
| RQ-SAFE-6 | **Tests and CI never touch a serial port by default.** Hardware tests need an explicit `MPY_REAL_PORT=<port>` (never auto-selected, never `auto`), and a printed motor-power-off checklist. Mirrors `CLAUDE.md:162` of the firmware repo | CI config has no port variable; grep test shows no `comports()`-based open in the default suite | DECIDED |
| RQ-SAFE-7 | **Auto-uploading `main.py`/`boot.py` is disclosed.** A synced `main.py` runs at every power-up; the first auto-sync that would change `main.py` or `boot.py` shows a one-time notice. A command "Skip main.py (restart to prompt)" exists (raw-mode soft reset does not run `main.py`, 08 section 4.5) | Fake: scenario 11 of Appendix G plus a notice test | DECIDED |

#### F4.2 Board and ABI identity (RQ-ID)

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| RQ-ID-1 | After the first confirmed Idle prompt, one **read-only identity probe**: `sys.implementation` (`name`, `version`, `_machine`, `_build`, `_mpy`), `sys.platform`, `os.uname().machine`, `machine.unique_id()`, `sys.path`, and `os.listdir('/')`. The probe does not import `shield`/`_shield` (hardware is created lazily by the firmware, `CLAUDE.md:140-142`; keep connect free of hardware side effects). It is deferred while a program is running; it never runs on a bare connect that found a running program | Fake: probe against profiles "WSU_SHIELD", "stock ESP32_GENERIC", "no `_build` (old firmware)", "program running" | DECIDED |
| RQ-ID-2 | A **course profile** (`course.json` in the template, built-in default for `WSU_SHIELD`) lists accepted `_build` values (`WSU_SHIELD`), the MicroPython version range (default `1.29.x`) and the frozen module names (`shield`). The built-in default does not use `ME401_ESP32` (stale planning name in `upy_port.md:545`; the board directory is `WSU_SHIELD`) | Unit test of profile matching | DECIDED |
| RQ-ID-3 | Outcomes: match -> status bar "WSU_SHIELD, MicroPython 1.29.0"; stock or other firmware (`_build` not in profile, or `shield` absent) -> non-blocking banner "This board is not running the course firmware; `import shield` will fail. Ask your TA to flash it. Do not use Thonny's Install MicroPython" and generic stubs; out-of-range version -> warning. Never block editing, Run of non-`shield` code, or file sync | Fake scenarios per outcome | DECIDED |
| RQ-ID-4 | **ABI handling.** The frozen package already self-checks (`python/shield/__init__.py:16-19`), so the extension's job is (a) never let a mismatch arise from the sync set: a `shield`/`_shield` name at the board root would shadow the frozen module because `sys.path` is `['', '.frozen', '/lib']` (07 section 1; `''` is first), so the uploader refuses or warns on any local file or folder whose *board path* would be `/shield*`, `/_shield*`, `/lib/shield*` or would otherwise collide with the board's frozen module list (the pack in `course-stubs/` is outside the sync set, RQ-COURSE-4); (b) recognise the ABI `ImportError` text in Run output and show the flash instruction; (c) a "Board info" command runs `shield.info()` (`__init__.py:50-62`) on request only | Fake: local `shield.py` upload -> warning; Run output containing the ABI text -> actionable message | DECIDED |

#### F4.3 Course package and stub distribution (RQ-COURSE)

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| RQ-COURSE-1 | Students never need the firmware tree. **The instructor pack is `course-stubs/`: verbatim copies of `FW/python/shield/*.py` plus a generated `_shield.pyi` (29 KB; 07-F.6).** Hand-off to the firmware repo (N-8): a step in `tools/make_release.sh` (Phase 9 of `upy_port.md`) that regenerates the pack whenever `python/shield/**` or `cmodules/shield/*.c` change and stamps it with `{firmware git describe, SHIELD_ABI, MicroPython tag, _build}` (07-F.6 rule 5). The current build reports `2930580-dirty` (N-12), so release from a clean tag. Until the step exists the instructor runs 07's generator once and commits the result to the course template | Pack on the real project reproduces 07-F.5: 0 diagnostics on `test.py`, `shield.Motor` hover works, wrong calls flagged; stamp present | USER INPUT (Q-05) for ownership; mechanism DECIDED |
| RQ-COURSE-2 | **The vehicle is a course template** (zip or template repository): `course-stubs/`, `pyrightconfig.json` (with `extends` pointing at the extension-generated file), `.mpyignore`, `.vscode/settings.json` (no OS-specific paths; N-10), `.vscode/extensions.json`, an example `main.py`. Stock stubs are *not* in the template: the extension unpacks them from its VSIX (07-F.6 rule 4). The extension also works without the template (bundled stock stubs, guided setup, "Install course stubs from zip/URL"). Stock stubs over-approximate this board (`bluetooth`, `esp32.PCNT` are in the stubs and compiled out of the firmware, 07-F.6 rule 4); that is accepted | Fresh folder + template -> zero unresolved imports; fresh folder without template -> stock modules resolve, `shield` unresolved with a one-click install; template opened before the extension has generated its file -> no hard error (S-04 item d) | DECIDED; SPIKE S-04 |
| RQ-COURSE-3 | Stub packs carry `firmware-version` and `ABI`; Doctor compares them with the identity probe | Fake: mismatch -> Doctor warning | DECIDED |
| RQ-COURSE-4 | Course sources live only in `course-stubs/` and are `ignore`d by pyright (without `ignore` pyright reports the pack's own 9 findings, 07-F.6 rule 2). `course-stubs/`, the dot-directory, `typings/`, `*.pyi` and `pyrightconfig.json` are in the default sync-ignore; the uploader additionally refuses any path whose board path would be `shield*`/`_shield*` (RQ-ID-4) | Fake: upload-all of a template workspace sends no pack file and no config | DECIDED |
| RQ-COURSE-5 | Student files that shadow stdlib or course names (`time.py`, `machine.py`, `shield.py`) are flagged by Doctor, because they break both Pylance and the board (the board root is first on `sys.path`) | Unit test | DECIDED |

#### F4.4 Installation and distribution (RQ-DIST)

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| RQ-DIST-1 | One universal VSIX, no native Node modules, no committed `node_modules`, size budget < 5 MB without stubs, MIT licence, `NOTICE` and third-party notices for pyserial (BSD-3) and mpremote (MIT) (R-ARCH-7) | `vsce package` size check in the verify script | DECIDED |
| RQ-DIST-2 | Primary channel: VSIX file (GitHub release, LMS or OneDrive link) installed by "Extensions: Install from VSIX" or `code --install-extension`, plus `.vscode/extensions.json` recommendations in the template. Marketplace publishing is later and optional | Install steps in the student handout verified on one clean macOS and one clean Windows profile | USER INPUT (Q-04, Q-02) |
| RQ-DIST-3 | **Coexistence with `DanielBucam.mpy-workbench`** (installed on the instructor's machine, possibly on students'): distinct extension id, command ids, view container and view ids, setting prefix and state directory (D-06, D-14); Doctor detects the old extension and asks the user to disable it (both would react to a save and both would open the port) | S-10: both VSIXs in a throwaway `--extensions-dir`, new one activates, no duplicate-command errors | DECIDED; SPIKE S-10 |
| RQ-DIST-4 | `capabilities.untrustedWorkspaces: "limited"` (the old manifest says `supported: true` while executing workspace-chosen interpreter paths); activation on a project marker or view visibility (R-ARCH-11); `extensionKind: ["workspace"]` kept, with a clear message in Remote/WSL windows (R-ARCH-10) | Manifest test | DECIDED |
| RQ-DIST-5 | Version and bridge/vendored versions are shown by Doctor; the course template records `minExtensionVersion` and Doctor warns when the installed extension is older | Unit test | DECIDED |

#### F4.5 Terminal hygiene against Python/Envs auto-activation (RQ-TERM)

Basis: N-4; critic 2.1 item 2.

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| RQ-TERM-1 | No `terminal.sendText` of commands anywhere (R-ARCH-2). The REPL/Run tab is an `ExtensionTerminalOptions` `Pseudoterminal`, which the Envs extension 1.38.0 skips (`creationOptions.pty`) | Lint rule forbids `sendText`; S-05 observes no activation text in the Python Envs log for the REPL tab | DECIDED; SPIKE S-05 |
| RQ-TERM-2 | **Input filter**: the legacy Python extension does not skip `pty` terminals and types activation commands with `sendText`, waiting 500 ms after each (`BaseTerminalActivator`). `handleInput` drops, during the first 10 s after creation and before any user keystroke, a chunk that looks like an environment activation line (a `source`/`.` line ending in `activate`, a path ending in `activate`, `activate.bat`, `Activate.ps1`, `conda activate ...`). It is logged, never forwarded to the board | Unit test with sample activation strings for zsh, bash, cmd and PowerShell | DECIDED |
| RQ-TERM-3 | Because `python-envs.terminal.autoActivationType` has `machine` scope (N-4), the template cannot disable activation; the template may set `python.terminal.activateEnvironment: false` (resource scope) for the legacy path, and Doctor reports the current values and whether the REPL tab is exposed | Doctor output test | DECIDED |
| RQ-TERM-4 | Any real terminal the product still needs (Doctor shell, M0, CLI mode) is a `vscode.tasks` task with `ProcessExecution` (argv, no shell; task terminals are skipped by the Envs extension) | Review item | DECIDED |

#### F4.6 Cloud-synced projects: OneDrive, iCloud, Dropbox (RQ-CLOUD)

Basis: N-10. This is the instructor's default case, not an edge case.

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| RQ-CLOUD-1 | Every process launch and file path is argv-based and tolerant of parentheses, spaces, `@`, `.` and non-ASCII in the project root. Fixture root: `OneDrive-Washington State University(email.wsu.edu)/ME 241 (Fall)/Lab 1` and a Windows analogue `C:\Users\x\OneDrive - Washington State University\Documents\ME 241\Lab 1` | Fake-board and bridge test suites run with this fixture on macOS and Windows | DECIDED |
| RQ-CLOUD-2 | The extension never creates a `.venv` or other per-machine environment in the project (04/06 `setupEnvironment` is dropped); Doctor warns when the selected interpreter lives under a synced folder (path contains `OneDrive`, `CloudStorage`, `iCloud`, `Dropbox`, `Google Drive`), because environments are not portable across machines or OSes (`bin/` versus `Scripts/`) and consist of thousands of small files [K]. No OS-specific interpreter path is ever written to workspace settings | Unit test of the path classifier and of the settings writer | DECIDED |
| RQ-CLOUD-3 | Machine/board state is outside the project (D-06) | Test: the project tree after a full session contains only user-visible files | DECIDED |
| RQ-CLOUD-4 | Change detection by **content hash**, not mtime or watcher events alone; debounce; ignore `desktop.ini`, `~$*`, `*.tmp`, `.DS_Store`, `Thumbs.db`. Cloud clients touch files without content changes [K] | Fake: touching a file without changing bytes causes no upload | DECIDED |
| RQ-CLOUD-5 | Project-resident files the extension writes (`pyrightconfig.json`, the generated IntelliSense dot-directory, `course-stubs/` when installed, `.mpyignore`) are written atomically (temp file in the same directory + rename) with 5 retries of 50-200 ms on `EBUSY`/`EPERM`/`EACCES`, and only when content changed (05 X-55) | Unit test with injected `EBUSY` | DECIDED |
| RQ-CLOUD-6 | Files that are not downloaded yet (Files On-Demand placeholders) must not hang a sync: reads have a timeout and a message ("file is online-only; mark it Always keep on this device"); no whole-project stat at activation; manifest building is bounded to non-ignored paths [K] | S-09 (human, scratch OneDrive folder) | DECIDED; SPIKE S-09 |

#### F4.7 Interactive Run (RQ-RUN) and amendments to R-ARCH-1..12

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| RQ-RUN-1 | While a program runs, the Run/REPL tab forwards keystrokes raw (no line buffering, no local cooked echo unless the program is detected to be in `input()`), so `select.poll()` on `sys.stdin` and `sys.stdin.read(1)` work (N-9). `mpremote run` and the `OutputChannel` are therefore not acceptable Run surfaces. Ctrl-C always means interrupt (copy only when text is selected); Ctrl-D during a run goes to the program | Fake board gains a program-stdin feature; scenario "key press changes the program output within 100 ms" passes on macOS and Windows CI; S-06 repeats it on the unix-port VM and later the real board | DECIDED; SPIKE S-06 |
| RQ-RUN-2 | Run output uses `compile(src, <local path>, "exec")` (or traceback rewriting) so `File "<local path>", line N` is a clickable link; imported board modules map through `rootPath`. Paths with spaces and parentheses must survive (fixture of RQ-CLOUD-1) | Fake scenario; unix-build check already done (N-13); S-07 on the board | DECIDED; SPIKE S-07 (board only) |

## Amendments

- 2026-10-12 (D-15, firmware generality): every `shield`/`WSU_SHIELD`/`course` requirement above is read as "a firmware profile (data), possibly absent". Specifically:
  - RQ-ID-2: no built-in profiles; `profile.json` is optional and comes from a template or `.upy-bridge/`. Without a profile the board is identified generically and gets stock stubs.
  - RQ-ID-3: outcomes become: matches profile -> status bar names board and version; no profile or unknown firmware -> generic status ("MicroPython 1.2x on ESP32 / RP2 / ...") and no warning; a profile that expects frozen modules the board lacks -> banner ("this board does not look like the course firmware"), never blocking.
  - RQ-ID-4 (shadowing frozen modules): applies to the profile's `frozenModules` plus, for any board, to modules listed in the board's own frozen/builtin inventory (from identity/introspection), so uploads cannot shadow firmware modules on any firmware.
  - RQ-SAFE-2: the hard-reset confirmation text comes from the profile's `resetWarning` with a generic default.
  - RQ-COURSE-*: "course pack" = a firmware profile's stub pack; the same mechanism serves any custom firmware.
  - NEW RQ-GEN-1: stock stub selection works for every port that the bundled stub packages cover (list recorded in R5); an unknown port degrades to stdlib-only stubs and never to errors.
  - NEW RQ-GEN-2: the IntelliSense fix-up is idempotent, previewable (shows what it will write), consented, JSONC-safe, and reversible ("Remove μPython Bridge IntelliSense files").
  - NEW RQ-GEN-3: a CodeAction on unresolved-import diagnostics offers the fix-up options relevant to the import (stock stub for the detected board, firmware source folder, generate from board) - verified headlessly with a mocked diagnostics provider; real Pylance behaviour is S-04.
  - NEW RQ-GEN-4: the fake board has profiles for ESP32, ESP32-S3 native USB, RP2040/RP2350, STM32, ESP8266 and a custom frozen+C-module firmware; identity, stub-picker and Run/Stop scenarios pass for each.

## Reset options (D-16, added 2026-10-12) - RQ-RESET

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| RQ-RESET-1 | One "Reset board..." action (Board Actions row + palette) shows only the applicable options: Restart Python (soft), Reboot board (`machine.reset()`), Reset with RTS/DTR line (hard). Labels replace the old misleading "Soft Reset" (which could do `machine.reset()`) | Headless UI test: option list per capability state | DECIDED |
| RQ-RESET-2 | `machine` tier needs no control lines and works through the REPL on any board whose REPL responds; handles the link dropping and native-USB re-enumeration (state `disconnected`, reason `board-reset`, bounded reconnect by the client) | Fake: reset on every profile incl. native-USB port drop; unix VM n/a | DECIDED |
| RQ-RESET-3 | `hard` tier is offered only when `hard.state` is `verified` or `likely` (setting can show `unknown`); hidden for `unlikely`/`failed`; context key `upy-bridge.hardResetAvailable` | Unit test of the estimator table and gating | DECIDED |
| RQ-RESET-4 | Capability is estimated from adapter VID:PID + identity platform, then **learned** by an explicit verification (boot text, `ticks_ms` drop, or re-enumeration); result cached per (VID, PID, `unique_id`) in extension storage; `failed` carries a reason and a hint (EN button / replug) | Fake: verification passes with wiring `auto-reset`, fails with `none`, caching works | DECIDED |
| RQ-RESET-5 | No tier above soft is implicit; Stop never escalates; every confirmation shows the profile's `resetWarning`; `confirmed:true` is required at the protocol level | Fake: no reset events without a confirmed op across the whole scenario suite | DECIDED |
| RQ-RESET-6 | Hardware evidence: instructor board `verified` for the RTS-pulse method (kit stage E, `--allow-hardware-reset`), `machine.reset()` behaviour on the class board, and the reboot-on-reset side effects (motor 2 twitch) recorded | [H] hardware session 2 | USER INPUT (go-ahead) | **Evidence 2026-10-13 [E] (harness phase R, report `tools/hwtest/reports/20261013T171650Z/`): CP2102 (10C4:EA60) + ESP32 class board on macOS: RTS-pulse hard reset VERIFIED (boot text + restarted uptime; the verification pulsed twice); `machine.reset()` works through the REPL with no port drop (back in 0.8 s, reset_cause 2); soft reset keeps ticks (reset_cause 5); hard pulse gives reset_cause 1. Windows, other adapters and the motor behaviour at each reset are still unobserved [U].**

