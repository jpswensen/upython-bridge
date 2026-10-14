# 10 - Completeness critique of notes 01-09

Role: completeness critic. I read notes 01-09 in full, opened about 40 of their file:line citations in `mpy-workbench` and the installed mpremote 1.29.0, re-ran two of their executed claims, and then looked for evidence on this machine that none of the nine analysts used. Nothing in `mpy-workbench` was modified, no serial port was opened, nothing was installed globally. A request to list the instructor's OneDrive course folder was refused by the permission layer (PII); I did not work around it.

Evidence tags: **[E]** I executed or observed it just now; **[S]** I read source/logs; **[I]** inference; **[U]** unverified.

---

## 1. Citation spot-check (38 locations opened; 37 correct, 1 off by two lines)

Old source, git HEAD `7cb90c7`:

| Claim (note) | Location | Result |
|---|---|---|
| validator tests global `mpremote`, not the candidate (01,04,05,06,09) | `pythonInterpreter.ts:232,235` | correct |
| "not found" substring check cannot match ENOENT (01,05) | `:242` | correct |
| last resort `'python3'` cached (01,06) | `:105-107` | correct |
| Windows fallbacks `python`,`python3`,`'py -3'`, Python39-312 only (01,05) | `:199-224` | correct |
| `mpyWorkbench.pythonPath` fall-through is silent (01) | `:32-50` | correct (line 46 comment) |
| activation resets `mpyWorkbench.connect` to `auto`, Global (02,03,04,06) | `extension.ts:181-188` | correct |
| `createTreeView("mpyWorkbenchLocalFilesView")` (04,06) | `extension.ts:196-197` | correct |
| `markHealthy` clears the in-progress flag (02,06,09) | `mpremote.ts:63-71`, call order `:163-167` | correct |
| `opQueue = Promise.resolve()` on every call (02,06) | `extension.ts:278-301` | correct |
| `runFromView` / `skipIdleOnce` (04,06) | `extension.ts:1076-1092` | correct |
| `openRepl` skips the handshake (02) | `extension.ts:871-874` | correct |
| `echo -e '\x03\x03' > port` (all) | `mpremoteCommands.ts:392` | correct |
| 500 ms Ctrl-C then 100 ms Ctrl-B (01,02,05,08) | `mpremoteCommands.ts:261-271` | correct |
| `fileExists` -> import branch (02,03,05,08) | `mpremoteCommands.ts:196-211`, `mpremote.ts:1288-1300` | correct |
| `fs stat` / `fs run` / `fs mv` / `mkdir -p` | `mpremote.ts:1294 / 1460 / 1729 / 948,1103` | correct, **but 08 section 1 fact 4 and 09 M7 cite `mpremote.ts:1296`; the `fs stat` call is on line 1294** (1296 is the `catch`). 08 section 5.1 has it right. |
| restart REPL types into a dead terminal (02,06) | `mpremoteCommands.ts:27-49` | correct |
| backslash regex bug (02,04,05,06,09) | `extension.ts:904,911` vs `:1111` | correct |
| `PYTHONIOENCODING` is the only env hygiene (05,08) | `mpremote.ts:133-140` | correct |
| listing warning blames PATH (05) | `mpremote.ts:872` | correct |
| hard-coded extension id (04,05,06) | `esp32Fs.ts:257`, `pyraw.ts:12` | correct |
| watcher on stale `.mpystudio/config.json` (04,06) | `extension.ts:245-253` | correct |
| `deactivate() {}` and import-time interval (05,06) | `extension.ts:1153`, `mpremote.ts:107,131` | correct |
| `contributes.css`, duplicate `extensionPack`, `untrustedWorkspaces.supported:true`, `extensionKind`, `onLanguage:python` | `package.json:10-28, 61-63` | correct |
| default ignore list lacks `.venv` (03,04,05,07) | `sync.ts:73-85` | correct |
| Spanish strings (01,04,05,06) | `mpremoteCommands.ts:82,91-94,103` | correct |

Installed mpremote 1.29.0 (`~/src/mpy_test/.venv/lib/python3.13/site-packages/mpremote`): `do_filesystem` has no branch for `stat`/`mv`/`run` and no `else` (`commands.py:380-455`) [E]; `reset` shortcut is `machine.reset()` (`main.py:407-414`) [E]; `_auto_soft_reset = True` and `ensure_raw_repl` (`main.py:536,548-553`) [E]; Ctrl-C once at raw-REPL entry (`transport_serial.py:179`) [E]; KeyboardInterrupt in `_do_execbuffer` is `sys.exit(1)` with no `\x03` (`commands.py:495-496`) [E]; CP210x/Windows open sequence and `rts` then `dtr` close order (`transport_serial.py:71-85,122-133`) [E]; `a0..a3` shortcuts are `range(4)` (`main.py:430`) [E]; Windows UTF-8 console setup (`main.py:562-567`) [E]. All of 02/03/05/08's line references into mpremote were accurate.

Independent re-run of 07's central experiment (pyright 1.1.414 from the scratchpad, fresh project): `extraPaths` containing `time.pyi` with `sleep_ms` still yields `"sleep_ms" is not a known attribute of module "time"`; `stubPath` containing the same file resolves it [E]. Confirmed.

Installed extension: `~/.vscode/extensions/danielbucam.mpy-workbench-0.3.2/dist/mpremote.js` runs bare `mpremote` (`:182`, `:806`) and `mpremoteCommands.js:50,246` carry the user's hand edits (mtime 12:37:22; `.bak` 12:33:15, `.bak2` 12:35:38) [E]. 01's "the user ran the older VSIX build" is confirmed; 06 section 9 Q1 and 04 still list it as unknown.

---

## 2. Evidence on this machine that no analyst used

### 2.1 The user's own VS Code logs from the failing session [S]

`~/Library/Application Support/Code/logs/20261012T114536/` (windows 3, 4, 5 are the `mpy_test` windows; windows were reloaded at 12:11, 12:28, 12:34, 12:37).

1. **R6 / defect "connect reset to auto" was observed in the real session, twice.** `window3/exthost/exthost.log` 12:28:33.884 and `window5/exthost/exthost.log` 12:38:06.438: `Error: Select a specific serial port first (not 'auto')` at `mpremoteCommands.js:242:15` from command `mpyWorkbench.openRepl`, 28 s after each window start (extension activated 12:28:05 / 12:37:38). 02 rated this M and listed it ninth; 06 ranked it first. The log supports 06. It is the only REPL failure mode of 02's list that appears in the user's artifacts.
2. **About a dozen REPL terminals were created in one hour, and each received venv-activation text.** `window3/exthost/ms-python.python/Python.log`: pairs of `Send text to terminal:` with empty text 100 ms apart (12:19:44.350/.452, 12:19:57, 12:20:00, 12:20:06, 12:20:31, 12:28:56; window4 12:34:35, 12:36:47; window5 12:39:28, 12:39:36, 12:39:51, 12:39:54), each followed 4.4-4.5 s later by `Send text to terminal:  source ~/src/mpy_test/.venv/bin/activate`, and `ms-python.vscode-python-envs` logs `Terminal is activated` for the same instants. The empty pairs match the old extension's Ctrl-C/Ctrl-B timers (`mpremoteCommands.ts:261-271`) **[I, attribution unverified]**. If the activation text lands in a terminal whose process is `zsh -lc "... -m mpremote connect <port>"`, it is typed into mpremote's stdin and therefore into the board's REPL, 4.5 s after the REPL opens. Nobody considered this (01 4.5 and 02 section 3.1 only say the Run terminal "may be auto-activated"). It also changes F0 in 02: a *new* "ESP32 Run File" terminal gets `sendText("mpremote ... run")` at t=0 and the activation at t=+4.5 s, so the first click would hit `command not found: mpremote`, the second click would work.
3. **Unexplained paradox in 01's root cause.** `.mpy-workbench/tree-paths.json` has mtime 12:38:39 and contains `/boot.py`, `/test.py`. The installed build writes that file only after `runMpremote(["connect", port, "fs", "tree"])` returned stdout (`dist/mpremote.js:244-257`). So bare `mpremote` *was* reachable from the extension host at 12:38 and a real listing succeeded. Yet `which -a mpremote` is empty, a `find / -name mpremote` (depth 6) finds none, and the running VS Code processes (pids 99696, 883) have a PATH with pyenv shims and miniforge but no `.venv/bin` [E]. 01 states (RC1, section 1.2) that every sidebar `exec` fails. Either the user launched/ran something different at 12:3x, or the port was typed into settings and mpremote was on PATH by a route nobody found. Until reconciled, "RC1 is what the user ran" is true for the REPL/Run path but not proven for the sidebar path.
4. Log line `Environment discovery is managed by the Python Environments extension (ms-python.vscode-python-envs)` (Python.log 12:21:17) while `python.useEnvironmentsExtension` defaults to `false` in the installed `ms-python.python-2026.8.0/package.json:449-451` (tagged `onExP`, i.e. experiment-controlled). 01 section 5 built the resolver around `exports.environments` of the Python extension and called the Envs extension secondary. For this user it is primary.
5. User setting `terminal.integrated.inheritEnv: false` and a custom `terminal.integrated.commandsToSkipShell` exist in User settings (not examined further); both change terminal behaviour and the 02 Ctrl-E analysis.
6. `renderer.log` records `[error] [DanielBucam.mpy-workbench]: The 'css' contribution point is proposed API.` at every window load (04 and 06 call `contributes.css` "ignored"; it is a logged manifest error).
7. Course folder: the Python Environments log (12:12:02) discovered a `.venv` under the instructor's OneDrive course directory for ME241. The instructor's own course project is OneDrive-resident, so 05 X-55/A12 (OneDrive handle contention) and 01's "project `.venv` default" are live concerns, not generic ones. I did not open that folder.

### 2.2 The user's real firmware, and nobody read it [S][E]

`<course firmware repo>` (its `CLAUDE.md` says it serves ME241 MicroPython and ME401):

* Board `boards/WSU_SHIELD` (ESP32-WROOM-32 on a 38-pin DevKitC, WSU Motor Shield), MicroPython **v1.29.0** submodule `lib/micropython`, IDF 5.5.4, custom `mpconfigboard.h/cmake`, `sdkconfig.board`.
* `boards/WSU_SHIELD/manifest.py` is two statements: `include("$(PORT_DIR)/boards/manifest.py")` and `package("shield", base_path="$(BOARD_DIR)/../../python")`. The frozen package `python/shield/{__init__,motor,servo,pins}.py` does `import _shield` and `from . import ...`.
* `cmodules/shield/mod_shield.c` (634 lines) is the private C module `_shield`: `static MP_DEFINE_CONST_FUN_OBJ_{0,1,2,3,VAR_BETWEEN}`, `MP_REGISTER_MODULE(MP_QSTR__shield, ...)` (`:634`), an `ABI` constant (`:574`).
* The student program in `~/src/mpy_test/test.py` does `import shield` (a frozen module on the board, invisible on the student's laptop).
* `tools/build_unix.sh` builds a MicroPython **unix port with `_shield` on a simulated hardware layer** (`sim/me401_hw_sim.c`, tests in `tests/host_py`); `build/unix/` holds objects from Sep 24 (no `micropython` binary present).
* `~/src/micropython/user_modules/dcmotor` (untracked) is an older, different C module (class `DCMotor`, old `mp_obj_type_t` struct style, `STATIC` macros). The target for complaint 2 is `shield`/`_shield`, not `dcmotor`.

So complaint 2 is the combination 07 calls (b) frozen Python package + (c) C user module + a custom `_build` name (`WSU_SHIELD`, which 07's picker maps to the generic `micropython-esp32-stubs`). 07 proved its pipeline on a *fake* firmware; it was never run on this one.

### 2.3 The firmware's own constraints touch the extension's reset and Stop design [S]

From that repo's `CLAUDE.md` (lines 147, 162-163, 183-189, 203-214) and `upy_port.md:37,1011`:

* GPIO15 (motor 2 IN1): "Motor 2 runs at full speed for the whole esptool upload, and for ~0.3 s at every reset. Firmware can't prevent it" (`CLAUDE.md:183-186`).
* GPIO12 (motor 1 IN2) HIGH at reset selects 1.8 V flash and "bricks boot" (`:189`).
* `MICROPY_BOARD_AFTER_PYTHON_EXEC` stops motors on an uncaught exception or Ctrl-C; `MICROPY_PORT_DEINIT_FUNC` parks hardware on every soft reset (`:143-148,203-207`).
* "Students use Thonny or mpremote" (`upy_port.md:37`); "never use Thonny's Install MicroPython" because it removes `_shield` (`CLAUDE.md:214`, `upy_port.md:1011`); a TA flashes boards on Windows and macOS (`upy_port.md:~1014`).

Consequences no analyst drew: (a) DTR/RTS reset-on-open (08 section 7.3, labelled [U]) is on this hardware a physical event: a hardware reset spins motor 2 for about 0.3 s; (b) the "Hardware reset (RTS pulse)" button recommended in 02 section 10.5 and 09 section 5.2, and any "reset on connect" policy, need a safety decision; (c) 02 F5 (Ctrl-C in the Run terminal does not reach the board) means that with the old tool the motors keep running after the student presses Ctrl-C; Stop reaching the board is a safety requirement, not only a UX one; (d) the extension should detect stock firmware (`_shield` absent) and an ABI mismatch (`_shield.ABI` vs the `shield` package) on connect; (e) firmware-side claims in 02 (MicroPython v1.25.0 sources), 08 (local checkout v1.27.0-preview-88) and 09 (v1.29.0 `pyexec.c`) came from three different trees; none was checked against this board's pinned v1.29.0 + custom config.

### 2.4 A Windows machine exists [E]

`<Windows VM folder>` (VMware Fusion installed; UTM also installed). 05 mentions it but nothing was run. Every Windows statement in the nine notes is [R]/[K]/[D]; the only Windows-adjacent execution was PowerShell 7.4.6 on macOS (02 E5).

---

## 3. Modalities of investigation that were not run

| Modality | Status |
|---|---|
| Real VS Code extension host with the old extension (observe terminals, toasts, activation) | Never run. All "[E]" results use a hand-written `vscode` stub; VS Code behaviour came from reading `workbench.desktop.main.js` (02,06) or [K]. |
| The user's own session logs | Not read by anyone (section 2.1). |
| Windows (cmd.exe, PowerShell 5.1, Defender latency, `taskkill /T`, Store stub, `py -3`) | Never run. |
| Pylance itself (not pyright-langserver) | Not run (07 section 11.12 admits it). Settings-vs-config precedence and `extends` in Pylance 2026.4.1 are [U]. |
| The user's real firmware through the 07 pipeline | Not run. |
| Real hardware | Forbidden here. No hardware kit was prepared for the human to run (02 section 13 and 08 section 11 are prose). |
| `serialport` loaded/opened inside VS Code's own Electron (not Node 26), opened against a pty | Only "loads under Node 26" (02 E13). |
| Bridge/vendored mpremote on the Python versions students will actually have | 09 tested 3.10-3.15 although it states a floor of 3.8; Apple's `/usr/bin/python3` is 3.9.x (01 section 8.9 saw Xcode 3.9.6 on this Mac); 08 did not run 3.9. |
| A hotfix prototype to ground "fix = 5-7 rounds, rewrite = 7-11 rounds" (09 section 7.2) | Not built. Estimates are judgement. |
| Student environment facts (Python present? Thonny only? admin rights?) | Never established; all notes list it as an open question. |

---

## 4. Status of the two complaints

| Item | Verified root cause? |
|---|---|
| 1a `.venv` not found | **Yes** for the installed VSIX (bare `mpremote`, `pythonPath` unused; installed files inspected [E]) and for HEAD (validator [E] by 01, 04, 05, 06, 09 independently). One loose end: the 12:38:39 `tree-paths.json` paradox (2.1 item 3). |
| 1b REPL not reliable after the hack | **Partly.** Observed in the user's logs: `connect === auto` throw (R6) twice, about a dozen REPL terminals created, activation text sent 4.5 s after each. Not observed: R1 (lock race), R2 (auto-suspend kills REPL), R3 (Ctrl-C race, reproduced only with a synthetic 0.7 s `.zprofile`), R7, R8 (reset-on-open). The activation-injection mechanism is new and unverified. |
| 1c Run current file | **No.** Two competing explanations (F0 PATH/activation race for the installed build; F1 `fs stat` no-op -> `import` for HEAD). The user ran the installed build, so F1 is not what they saw; F0 now has a plausible timing mechanism (2.1 item 2) but nothing observed. |
| 2 linter vs custom libraries | **No** for the user's real case. 07 verified the generic mechanism (stdlib shadowing, stubPath, extraPaths) on a fake firmware; the real firmware (2.2) was never examined. |

---

## 5. Contradictions between the notes

1. **Who owns the port / primary transport.** 02: Node `serialport` in the extension host (D) with a Python helper as fallback. 09: Python bridge process with vendored pyserial (C) as primary, explicitly reversing 02. 05: per-operation `python -I ... mpremote` from vendored wheels plus real terminals. 04 and 06: mpremote CLI behind a queue (`deviceSession.ts`, `setupEnvironment` that creates `.venv` and pip-installs mpremote). 03 and 08: a long-lived Python helper (SerialTransport or own protocol). Only 09 compares them and only against 02. 04/05/06 were never reconciled with 09.
2. **REPL surface.** 02/09: `Pseudoterminal` view on the owner. 05 (X-02, section 4.7, XP-05): real `createTerminal({shellPath: python, shellArgs: [... mpremote ...]})` because mpremote's REPL needs a TTY (08 fact 6 agrees the TTY is required). These cannot both hold, and the real-terminal choice is the one that exposes the terminal to Python-extension activation text (2.1 item 2) and to port contention.
3. **Where IntelliSense output goes.** 07: `.mpy-workbench/stubs/**` + generated `pyright.generated.json` + user-owned `pyrightconfig.json` with `extends`; settings.json only as fallback (because settings are ignored when a config exists, 07 section 3.2). 04 section 15.3 and 09 section 5.6: `.pyi` into `<workspace>/typings/` and merge into `.vscode/settings.json`. 04 section 10 shows `typings/` is *not* in the default ignore list, so 04/09's layout would upload stubs to the board.
4. **Where state lives.** 03/06/07: `.mpy-workbench/` inside the project (07 needs it there for relative `extends`). 05 X-55: caches and state in `context.storageUri` because OneDrive/Defender lock files in the project, and the instructor's course folder is in OneDrive.
5. **Run semantics.** 02 (section 10.6): never `import`, raw-paste the editor buffer. 04 section 15.3: `mpremote run` by default with `run.mode=import` optional. 06 section 8 and 03 section 6.5: keep `import` as an option / "or import from the uploaded copy". 08 section 5.5 shows `import` runs once per soft reset under mpremote 1.30.
6. **mpremote minimum.** 01 (`>=1.26`, `mpremote-too-old`), 04 (pin `>=1.26`), 06 (README `1.26`) vs 05 (`>=1.29.0`), 08 (floor 1.27, pin 1.29, 1.30 behind a probe), 09 (vendor 1.29). 02/03 describe soft-reset-per-launch as universal; only 08/09 know 1.30rc flips it.
7. **Python floor.** 01/09: 3.8. 05: practical 3.9 (platformdirs). 09 tested 3.10-3.15 only; 08 did not run 3.9.
8. **Auto-sync default.** 03: default ON with a visible prompt. 04: keep `false` unless the course template sets it. Open in both.
9. **Port auto-detection.** 04 section 6.5.10 wants `connect auto` semantics shown as a resolved port; 08/09 say never use `connect auto` in a classroom.
10. **What the user ran.** 06 and 04 treat it as unknown; 01/02 settled it (installed VSIX). Same file now contradicts itself across notes.
11. **Claim vs artifact.** 01 RC1 ("every `exec('mpremote ...')` fails in the installed build") vs `tree-paths.json` 12:38:39 (2.1 item 3). 01 section 5 (`useEnvironmentsExtension` false) vs the Python.log line (2.1 item 4).

---

## 6. Claims resting on memory, inference or secondhand material

* All Windows behaviour: `cmd.exe` and PowerShell 5.1 rejecting the single-quoted commands, `py -3`, Store alias stubs (exit 9009), `taskkill /T` and venv launcher process trees, `windowsHide`, Defender latency, Restricted execution policy [R/K/D].
* DTR/RTS reset-on-open and on-close on this CP2102 board under Apple's `AppleUSBSLCOM` driver and under Windows drivers (08 section 7.3; upstream issue #13504 is secondhand) [U].
* `terminal.sendText()` on a `Pseudoterminal` reaching `handleInput`; Ctrl-E Quick-Open interception on Windows; Ctrl-C-with-selection; bracketed paste -> paste mode (02 section 10.7-10.8) [K].
* Which terminal the Python/Envs extension types the activation text into (2.1 item 2) [I].
* Pylance (not pyright-langserver) precedence rules and `extends`/`stubPath` handling (07) [U].
* `${workspaceFolder}` not expanded by `getConfiguration().get` (01 section 4.1 says the mock is the author's own) [K].
* Firmware-side protocol facts (raw-paste window 128, `main.py` not run after a raw-REPL soft reset, `kbd_intr`, readline control keys) read from MicroPython v1.25.0 (02), v1.27.0-preview-88 (08) and v1.29.0 `pyexec.c` (09), not from the pinned tree of the class firmware [S, wrong tree].
* All timing numbers come from emulators or the unix port; no ESP32 and no Windows (acknowledged in 02, 03, 08, 09).
* 08's VID/PID list (`2E8A:0005` "from memory"), Node CVE-2024-27980 `.cmd` behaviour, GitHub-hosted Windows ARM64 runners (05, 09) [K/D].
* 09's effort estimates and the C-vs-D scores (judgement).

---

## 7. Requirements missing for macOS + Windows students

1. Hardware-safety policy for resets: no reset on connect, hardware reset only on explicit action with a motor-power warning, Stop must reach the board (2.3).
2. Student-side availability of the course package: `shield` is frozen in firmware, so `python/shield` sources and a `_shield.pyi` must reach students (07's `Export Course Stubs` exists on paper only).
3. Board identity/ABI check on connect for the class firmware (`sys.implementation._build == "WSU_SHIELD"`, `_shield.ABI`) and a clear message for stock firmware (Thonny "Install MicroPython").
4. Python availability decision for students who today use Thonny (which bundles its own Python): 09's argument "the course already requires Python" is an assumption.
5. Distribution/identity: VSIX via LMS vs Marketplace, publisher/name, coexistence with `DanielBucam.mpy-workbench` on machines that have it (04 15.1 covers coexistence only for ids).
6. Terminal hygiene against Python/Envs auto-activation text for every terminal the extension creates (2.1 item 2).
7. Project folders in OneDrive/iCloud as the *default* case for this instructor, not an edge case.

---

## 8. What would change the fix-vs-rewrite decision

All nine notes converge on "rewrite the engine, port the shell". That convergence is partly shared reasoning (07 and 04 are independent of the decision; 05, 06, 09 reuse each other's findings). Things that would move it:

* **If a cheap hotfix passes the acceptance matrix.** Nobody built 09's M0 patch set (validate `<python> -m mpremote`, expand variables, argv-only spawns, drop `mkdir -p`/`stat`/`mv`, stop resetting `connect`, delete `echo` interrupts, real queue). Measuring how many of 04 section 16's rows it passes on a fake board would replace the 5-7 vs 7-11 round guess with data, and would give the instructor something usable this semester.
* **If students have no system Python** (Thonny-only): then the dependency on a discoverable interpreter in 05/09/01 fails and either Node `serialport` (02/09's D) or a bundled interpreter becomes mandatory; the "Python bridge" architecture loses its main advantage.
* **If `serialport` or pyserial cannot reliably open the class's CP2102 board on Windows** (hardware spike), or if resetting the board is unsafe in the classroom (2.3), the "own the port, never reset" premise changes.
* **If the logs show the sidebar worked for the user** (2.1 item 3), then complaint 1a is smaller than assumed and the remaining defects are REPL/Run lifecycle, which favours rewriting only the board session layer.
* **If complaint 2 turns out to be a two-line `extraPaths` change on the real firmware** (plus a `_shield.pyi`), it is independent of the decision and the linting effort in 09 R5 can shrink.

Current best judgement (unchanged): a staged rewrite of the board-facing engine behind a `Bridge`/`Link` interface, with the old UI contract as specification, remains the better long-term path; a time-boxed M0 hotfix is a legitimate parallel track if a class starts before round 4. The evidence for the *effort* side is the weakest part of the decision.

---

## 9. Ranked gaps (also in the structured output)

1. Session-log forensics: reconcile the 12:38:39 `tree-paths.json` paradox, build the full timeline from `Code/logs/20261012T114536`, and classify 02's R1-R9 / F0-F7 as observed, refuted or unobserved. (02)
2. Run 07's pipeline on the real WSU_SHIELD firmware and the real `mpy_test` project; ground-truth `_shield` with a rebuilt unix simulator. (07)
3. Firmware-derived safety and protocol requirements from the pinned v1.29.0 tree and board config; produce a human-run, non-destructive hardware kit with a motor-power-off checklist. (08)
4. Establish what students have installed; decide C vs D with two spikes (pty + `serialport` in real Electron; bridge on Python 3.8/3.9). (09)
5. Reproduce 1b/1c in the real VS Code 1.141 extension host with the installed VSIX against a pty fake board. (02)
6. Windows execution kit; run it in the existing Windows 10 VM if the user approves. (05)
7. Build the M0 hotfix in the scratchpad and score it against 04 section 16. (09)
8. Verify Pylance itself and settle the IntelliSense file layout (07 vs 04/09). (07)
9. Resolver ground truth with the Python Environments extension active. (01)
10. Reconciled decisions/requirements register and citation corrections. (09)
