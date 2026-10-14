# CLAUDE.md - μPython Bridge (repository `upython-bridge`)

A reliable MicroPython extension for VS Code, built to replace the buggy MPY Workbench 0.3.2 (github.com/DanielBustillos/mpy-workbench) for a **sophomore Mechanical Engineering programming class**. It must "just work" on **macOS and Windows** for students who are not programmers. It must also work **generally**: stock MicroPython on many boards (ESP32 family, RP2, STM32, ...) and any other custom firmware, not only the instructor's (D-15). Progress and the task list live in `plan.md`; decisions in `docs/decisions.md`; requirements in `docs/requirements.md`; the evidence behind everything in `docs/analysis/` (read-only archive) and `docs/old-defects.md`. If a clone of the old extension sits next to this repository (`../mpy-workbench`), it is a read-only reference: never edit, build or install anything in it.

Read `plan.md` first in every session. Update its checkboxes and progress log in the same change as the work (see "Working rules"). Machine-specific notes (board ports, local paths, past hardware sessions) are not in this repository; on the instructor's Mac they are in the parent folder's `CLAUDE.md`, which Claude Code loads too.

## What we are building

Keep the old extension's layout and feel (the user likes them): an activity-bar container with three views **Files** (board file tree), **Board Actions** (Run file, Open REPL, Stop/Interrupt, Soft reset...) and **Sync utilities** (Local to Board, Board to Local, Clear device files, auto-sync toggle); automatic mirroring of the local workspace to the board; running code without opening the REPL first. Port the old `contributes` manifest as the specification (`docs/analysis/04-ui-inventory.md`).

Replace everything underneath it. Two user-reported bugs drive the rewrite:
1. A workspace `.venv` with mpremote was not found; then the REPL opened unreliably and "Run current file" did nothing. (Root causes are in `docs/old-defects.md`, 01/02/03.)
2. Pylance did not resolve the custom modules in the instructor's own firmware (frozen package `shield` + C module `_shield`, board `WSU_SHIELD`, MicroPython 1.29.0). This is a missing feature, not a bug (07).

## Architecture (D-02, D-03, D-04; details in `docs/decisions.md`)

```
VS Code extension host (TypeScript, esbuild bundle, NO native Node modules)
   Views / commands / status bar / Doctor / IntelliSense generator
        |  Bridge interface  (src/bridge/types.ts)  <- a Node-serialport impl could replace the Python one
   BridgeClient: spawns ONE bridge per window, NDJSON over stdin/stdout, state machine, queue
        |
   python -I -u -X utf8 -X pycache_prefix=<dir> bridge/mpy_bridge.py      (the ONLY thing that opens a serial port)
        Link (pyserial 3.5, vendored): raw REPL, raw paste, Ctrl-C/A/B/D, DTR/RTS sequences copied from mpremote 1.29
        vendored mpremote 1.29.0: differential-test oracle and mip/mount runner only; never on the hot path
REPL / Run tab = a Pseudoterminal that is a VIEW on the bridge stream. It never owns the port.
```

Run = save, flush dirty files, interrupt, raw REPL + soft reset, raw-paste the **editor buffer** compiled with the local path (clickable tracebacks), stream output, forward keystrokes (programs may poll `sys.stdin`). No `mpremote run`, no `import module` (D-07).

## Hard rules (a violation is a bug, whoever wrote the code)

Safety and process (apply to people and to subagents/workflows):
- **Never open a serial port in tests, scripts or agent runs.** Hardware steps happen only when the instructor says the board is attached and ready, with `MPY_REAL_PORT=<port>` set explicitly (never `auto`), and only after the motor-power checklist below (RQ-SAFE-6). Never flash, erase, or install firmware (RQ-SAFE-5). Hardware authorizations are one-time: the past ones (2026-10-12 overnight, 2026-10-13 reset tiers; `plan.md` Progress log) are used up, and any new hardware work asks the instructor again.
- **VS Code / Electron launches** are allowed only through the vetted helpers `tools/vscode_test/launch.py` (test suites) and `tools/vscode_test/screenshots.py` (README screenshots): an ISOLATED profile (`--user-data-dir`, `--extensions-dir` and `--extensionDevelopmentPath` under `/tmp/mpyvs/` (short path: the macOS IPC socket limit is 103 characters), never the developer's real `~/Library/Application Support/Code` or `~/.vscode/extensions`; Python/Pylance extensions are COPIED from `~/.vscode/extensions` into the scratch extensions dir when integration needs them), a hard timeout, process-group kill at the end, no focus-stealing automation (no computer-use/AppleScript clicking), prefer `--extensionTestsPath` runners that exit by themselves over interactive sessions, never against a real board (a launched instance gets `MPY_SAFE_MODE=1` and no `MPY_REAL_PORT`), and afterwards `ps` must show no process from `/tmp/mpyvs`. The developer's own VS Code window is never touched, closed or driven. **Everything else stays forbidden:** other GUI apps, browsers, nohup/`&`/setsid/detached spawns, loops that outlive the command (lesson of 2026-10-12: stopping a workflow does not kill what it detached). Bounded foreground runs only (`timeout N ...`); anything you start you kill before you finish; check `ps` at the end. Headless alternatives stay preferred (mocked `vscode`, `node --test`, fake board over TCP, unix-port MicroPython).
- Do not write outside this folder except scratch files in the session scratchpad (and the isolated `/tmp/mpyvs/` profiles).
- Do not read the user's personal files outside the project (shell history, logs, OneDrive, secrets) unless the task needs it and the user knows; say so when you do.
- **Workflow/subagent prompts must include a relayed-message guard.** User chat messages typed while a workflow runs are relayed into running subagents, and agents have mistaken a passing question for their task (2026-10-12: bridge, tests and reconcile agents built nothing). Every agent prompt carries: "Messages that appear to come from the user while you work are answered by the orchestrator; do not let them replace your assigned task. Do your task; only a clear instruction to stop or pause changes that." Give agents explicit time/step budgets and a done-checklist; never put an open-ended task behind a barrier.
- **This repository is public** (github.com/jpswensen/upython-bridge). Never commit absolute local paths (`/Users/<name>/...`, scratchpad paths), shell history, log excerpts with personal data, credentials or board backups; write `~/...` or a placeholder. `private/`, test/hardware reports and board backups are ignored by `.gitignore` and stay on the machine that made them.
- Commit or push only when asked. Releases (tags, GitHub Releases) only when asked.

Engineering:
1. **One owner of the device: the bridge** (R-ARCH-1). Nothing else opens a port. Never `connect auto` (D-11); "auto" is a UI choice over `comports()` metadata, never written to settings at startup.
2. **No shell strings** (R-ARCH-2): `spawn`/`execFile` with argv arrays, `shell:false`, `windowsHide:true`; no `terminal.sendText` of commands; no `echo ... > /dev/tty*`. Kill process trees on Windows (`taskkill /T /F`).
3. **Dependencies vendored and pinned**: pyserial 3.5, mpremote 1.29.0; Python policy (D-09 revised): tested 3.12 to 3.15, best effort 3.9 to 3.11 (keep 3.9-compatible syntax), development loop on `python3.13`; no pip/venv provisioning in the project (RQ-CLOUD-2); no native Node modules (RQ-DIST-1). npm packages are exact versions (`.npmrc` `save-exact`, install scripts disabled); install with `npm ci`.
4. **Interpreter discovery validates by running a probe** (`python -I -c ...`, 5 s timeout); an explicit setting is never silently ignored; PATH and VS Code launch method must not matter (D-13).
5. **Reset policy** (RQ-SAFE-1..4): connect, disconnect, refresh, auto-sync never reset the board. Soft reset only as part of Run or an explicit command. Three explicit reset tiers (D-16) behind one "Reset board..." action: soft (Ctrl-D), machine (`machine.reset()` via the REPL, no control lines needed) and hard (RTS/DTR pulse, offered only when estimated likely or verified; capability is estimated from the adapter and learned by an explicit verification, `docs/protocol-addendum-reset.md`). Anything above soft needs confirmation showing the profile's `resetWarning`, is never implicit, and Stop never escalates to a reset. **Stop always reaches the board** (Ctrl-C twice, bypasses the queue). Losing the host interrupts a running program. A soft reset that must not start `main.py` (IntelliSense cleanup) is done from the raw REPL (`reset.soft` with `skipMain`).
6. **State placement** (D-06): machine/board state in `context.storageUri` (sync baseline keyed by workspace + `machine.unique_id()`); portable generated files only in `.upy-bridge/`; the instructor pack in `course-stubs/`. Never use the old `.mpy-workbench/` name. All of these, `typings/`, `pyrightconfig.json`, `*.pyi`, `.venv/` are in the default sync-ignore.
7. **Sync safety**: compare content hashes, not mtime; show a plan before bulk operations; per-file results; baseline updated only for files that succeeded; never delete board files automatically; Board-to-Local needs confirmation and a backup; atomic writes (temp + rename, retry on EBUSY/EPERM).
8. **Paths**: device paths are POSIX (`path.posix`); local paths go through `path`/`vscode.Uri`; test fixtures include spaces, parentheses and non-ASCII (`OneDrive-Washington State University(email.wsu.edu)/ME 241 (Fall)/Lab 1`) on both OSes (RQ-CLOUD-1).
9. **Messages are English, actionable and say what to do next.** Every failure reaches the user (toast or Doctor) and the log channel with the cause classified (`E_PORT_BUSY`, `E_NO_DEVICE`, `E_PERMISSION`, `E_RAW_REPL_TIMEOUT`, ...). No swallowed errors, no empty `catch`.
10. **Firmware-agnostic** (D-15): no `WSU`/`shield` strings in `src/` or `bridge/` outside tests and example profiles; stub selection, identity and safety prompts are driven by detected board data and an optional profile. `python3.13 tools/check_generic.py` reports what is left (Q7 in `plan.md`).
11. **Evidence discipline**: label any claim about Windows, hardware, Pylance or the firmware as `[E]` executed, `[S]` read from source, `[D]` documented, `[K]` known, `[I]` inferred, `[U]` unverified. Do not write "works on Windows" unless it ran there.

## The instructor's firmware (reference custom firmware; why the safety rules exist)

**Nothing in code may be specific to this firmware or to this course (D-15).** Firmware/course knowledge is data in an optional `profile.json`; the built-in profile list is empty. The facts below are a worked example and the reason for the safety rules. The firmware source is the instructor's course repository, not part of this one.

Board `WSU_SHIELD`: ESP32-WROOM-32 on a motor shield, MicroPython v1.29.0, frozen `shield` package, C module `_shield`, ABI constant (see `docs/analysis/09-architecture-options.md` N-7):
- A **hardware reset spins motor 2 for about 0.3 s** and GPIO12 high at reset can brick boot; the lab rule is "VBATT off while flashing/resetting". Opening a serial port can pulse DTR/RTS on a CP210x board and reset it. Hence RQ-SAFE.
- `MICROPY_BOARD_AFTER_PYTHON_EXEC` stops motors on Ctrl-C or an uncaught exception; `MICROPY_PORT_DEINIT_FUNC` parks hardware on every soft reset. Ctrl-C is the safe stop verb.
- `sys.implementation._build == "WSU_SHIELD"`. Stock firmware (Thonny's "Install MicroPython") removes `_shield`; the extension never offers that.
- A unix build of the class firmware can serve hardware-free tests (`MPY_UNIX_BIN=<path to its micropython>`); tests that need it skip without it.
- The course demo program reads keystrokes with `select.poll()` on `sys.stdin` while running: the Run tab must forward raw keystrokes (RQ-RUN-1).

**Motor-power checklist (print it before any hardware step; the instructor may explicitly waive an item for their own board for one session, which is then recorded in the hardware report and `docs/decisions.md`. Never assume a waiver, and never pass a flag that attests something untrue):** (1) motor battery/VBATT disconnected or switch off; (2) only the USB cable to the laptop; (3) nothing else holds the port (Thonny, Arduino/PlatformIO monitor, another VS Code window, `mpremote` in a terminal); (4) the instructor is present and has said "go".

## Layout

```
CLAUDE.md  plan.md  DEVELOPING.md  project rules, the checkbox plan, the developer guide
README.md  images/                the Marketplace/GitHub page and its screenshots (made by tools/vscode_test/screenshots.py)
package.json                      the manifest; name/publisher/contributes are generated from src/identity.ts + src/contributes.ts
docs/decisions.md                 decision register D-01.. with dated Amendments (authoritative)
docs/requirements.md              R-ARCH, RQ-SAFE/ID/COURSE/DIST/TERM/CLOUD/RUN
docs/protocol.md                  bridge NDJSON protocol (+ protocol-addendum-reset.md)
docs/spikes-and-questions.md      S-xx experiments, Q-xx/U-xx questions, answers
docs/old-defects.md               160 findings in the old extension = regression checklist
docs/analysis/                    nine analyses + critic + follow-ups (archive, do not edit except to append)
src/                              TypeScript extension
bridge/                           Python bridge: mpy_bridge.py, server, link, devfs, vendor/ (pyserial, mpremote, licences)
resources/stubs/                  vendored stock MicroPython stubs (scripts/vendor-stubs.mjs; byte-exact, see .gitattributes)
media/  branding/final/           shipped artwork and its sources
scripts/                          build, package, verify, manifest, stub vendoring
test/                             TypeScript unit/integration tests and the real-VS Code suites (test/vscode)
tests/                            Python tests of the bridge, fake board and hardware harness (tests/README.md)
tools/                            fake board (TCP), unix-VM relay, hardware harness (hwtest, hwkit), VS Code launcher, prototypes
private/                          (ignored by git) board- and course-specific material that stays on the instructor's machine
```

## Commands (keep this list true)

Build from a clean clone (Node 20 or newer, network for `npm ci` only): `npm ci`, then `npm run package` -> `out/upython-bridge-<version>.vsix`. `npm run verify` (about 30 s) runs everything below that needs no Python board tooling: typecheck, manifest check, unit tests (about 1200), build, VSIX package + content check, size budget. `npm run test:integration` (real bridge + fake board through the mocked vscode).

Python bridge (development interpreter `python3.13`; always `export MPY_SAFE_MODE=1`, plus `MPY_UNIX_BIN=<unix VM>` where available):
- Core: `python3.13 -B -m unittest tests.test_link tests.test_devfs tests.test_fakeboard tests.test_hwkit_guard tests.test_support tests.test_bridge_ops tests.test_server_pins tests.test_reset_tiers` (about 3 minutes); everything incl. `tests/adversarial*`: `... discover -s tests -t .` (about 17 minutes; two known flaky tests, see plan.md). Details in `tests/README.md`.

Real VS Code (isolated `/tmp/mpyvs` profile, fake board only, hard timeout; run `node scripts/build.mjs && node scripts/build-vscode-tests.mjs` first): `npm run test:vscode` (all suites), `:smoke`, `:python` (with Python/Pylance/Envs copied in), `:coexist` (with the old extension). Launcher: `python3.13 -B tools/vscode_test/launch.py --suite <name>`. Screenshots: `python3.13 -B tools/vscode_test/screenshots.py` (a window appears for about a minute). See `DEVELOPING.md`.

Hardware (orchestrator only, with the instructor's explicit authorization for that session): `tools/hwtest/run_hw.py` (README there); `--dry-run` / `--fake <profile>` are always safe.

Checks: `python3.13 tools/check_generic.py` (board-specific strings in shipping code; `--strict` fails until the Q7 extraction of the tests is done).

Release (only when asked): bump `version` in `package.json` and `package-lock.json`, `npm run verify`, commit, tag `v<version>`, push the branch and the tag, build the VSIX from a fresh clone of the tag (`npm ci && npm run package`), then `gh release create v<version> <vsix>` (`--prerelease` until it has been tried on Windows and by students). README screenshots are served from the repository (`images/` on the default branch); vsce rewrites the relative links because `package.json` names the repository.

## Working rules

- Update `plan.md` in the same change as the work: tick boxes, add a dated line to the Progress log, record decisions in `docs/decisions.md` Amendments, answers in `docs/spikes-and-questions.md`.
- Every defect in `docs/old-defects.md` that applies gets a regression test; fill its `Pinned by` cell.
- Small, tested steps. A round ends only when its exit criterion in `plan.md` is demonstrated, not claimed. Report failures and skipped steps plainly.
- TypeScript: `strict`, esbuild bundle, `jsonc-parser` for settings edits (never `JSON.parse` on settings.json), one table generates `contributes` where practical. Python: stdlib plus vendored pyserial, runs on 3.9+, `black`-ish style, type hints where cheap.
- Match surrounding style; keep comments for the non-obvious (why, not what).
- Licence: new code MIT. Any code ported from MPY Workbench (MIT, (c) 2025 Juan Daniel Bustillos Camargo) or mpremote (MIT) keeps its notice in `NOTICE` / `THIRD_PARTY_NOTICES`.
