# 09 - Architecture options and prior art (input to the fix-vs-rewrite decision)

Scope: survey how mature MicroPython tooling talks to boards, score five candidate architectures for the new
extension, recommend one, say what in the old code is worth keeping, give an honest fix-vs-rewrite verdict with an
effort estimate in agent-workflow rounds, and design a hardware-free end-to-end test harness. Everything that could be
executed offline was executed; the attached CP2102 board and every other serial port were never opened.

Companion notes (this file leans on them instead of repeating them): `01-discovery.md` (interpreter/venv),
`02-repl-run.md` (REPL/Run/Stop, ideal design section 10), `03-fs-sync.md` (file layer), `05-cross-platform.md`
(Windows/macOS rulebook), `06-ext-core.md` (core defects, module decomposition), `08-mpremote-research.md`
(mpremote contract, version landscape, daemon checklist). Where I disagree with one of them it says so (section 4.4).

---

## 0. Bottom line

1. **Verdict: rewrite the engine, port the shell.** The new extension lives in `mpy-upgrade/`; it keeps the user-visible
   contract (three sidebar views Files / Board Actions / Sync utilities, command titles, context menus, auto-sync status
   bar item, diff decorations, `.mpyignore`) and replaces everything that touches the board or the Python interpreter.
   Roughly a fifth of the old code (about 1.2 kLOC of 5.8 kLOC) plus the whole `contributes` manifest (as a specification) is
   reusable (section 6); the 1,743-line `mpremote.ts` and the 418-line interpreter resolver are not.
2. **Recommended architecture: C - one long-lived Python "bridge" process owns the serial port**; the VS Code extension
   is pure TypeScript with no native Node modules; they talk newline-delimited JSON; the REPL is a `Pseudoterminal`
   that is only a *view* on the bridge. The bridge ships *inside the VSIX* with its pure-Python dependencies vendored
   (pyserial 90 KB wheel, optionally mpremote 39 KB) and is started as `python -I -u -X utf8 bridge.py`, so a student never
   runs `pip`, never needs a venv, and "I put mpremote in `.venv`" stops mattering. Any Python >= 3.8 will do (tested 3.10-3.15).
3. **Scores (section 4.2), 10 criteria, 1-5 each: C 45, D 34, B 31, A 25, E 21.** C wins under any plausible weighting
   (double-weighting "works out of the box", "port ownership", "testability", "latency": C 63, D 50, B 42, A 32, E 31).
4. **Honest disagreement with `02-repl-run.md` section 10.2**, which prefers Node `serialport` (option D) as the primary
   transport and the Python helper as fallback. I recommend the reverse because D puts a native binary on the critical
   path of a class whose instructor cannot test Windows ARM64, while C ships zero binaries and runs unmodified wherever
   Python runs (which the course needs anyway for Pylance). Both designs share the same skeleton (single port owner,
   state machine, Pseudoterminal view, no shell strings, fake board), so the choice is reversible behind one seam.
   Section 4.4 gives the objective switch criteria and a cheap tie-breaker (one real-board spike on one Mac and one Windows laptop).
5. **Effort:** 7-11 agent rounds to a hardware-validated release, most likely 8-9; first version students can use
   (Files tree, Run, Stop, REPL, sync, no linting yet) after round 4-5. Fixing the old extension in place needs 5-7
   rounds and ends on a lower ceiling (B, 31/50) with `mpremote.ts` still in the tree (section 7).
6. **Hardware-free E2E testing is practical today, and I built the pieces** (section 8): a 416-line fake
   board (TCP, no pty, so it should run on Windows too - not yet run there) that speaks the real raw-REPL protocol over `socket://` (works with the real `mpremote 1.29.0` and with my
   bridge), a real MicroPython 1.29.0 unix-port binary built in the scratchpad in about two minutes, and a WASM MicroPython
   that runs under Node on any OS. Nothing about the recommended architecture needs a board until the final shakedown.
7. **Evidence that matters most (all executed here, macOS 15.7.8 x86_64, Node 26.5.0, Python 3.10-3.15, mpremote 1.29.0):**
   * Syncing 20 small files (42.7 KB, 115200-baud throttled fake board): old per-file-process pattern **31.4 s**
     (**51.1 s** if `boot.py` takes 1 s), best-case stateless **20.5 s / 40.2 s**, one mpremote process **11.3 s / 12.6 s**,
     long-lived bridge **7.5 s / 7.3 s**; the bridge opened the port once, the old pattern 40 times (section 2.3).
   * A bridge on *vendored* pure-Python wheels ran unchanged on stock Python 3.10, 3.11, 3.12, 3.13, 3.14 and 3.15
     (no mpremote installed anywhere), also under `python -I -u -X utf8`.
   * The bridge keeps an interactive REPL open **while** it uploads, lists and hashes files, and the user's REPL variable
     survived (`keepme + 1` -> `124`); Stop took 20 ms; when the parent was `kill -9`'d the bridge exited by itself within
     1.5 s (stdin EOF) and released the port.
   * `validatePythonPath()` of the old extension, run verbatim against a venv that *does* contain mpremote, returns
     `valid:false` (`spawn mpremote ENOENT`); the old per-port "mutex" returns "not busy" immediately after it is set;
     the old Stop command writes `-e ` plus the control bytes on macOS (`2d 65 20 03 03 0a`).

---

## 1. Evidence legend and limits

| Tag | Meaning |
|---|---|
| [E] | I executed it (command or script reproduced in section 12 and the appendices). |
| [S] | I read the source (old extension at git HEAD `7cb90c7`, MicroPico 4.6.1 sources recovered from its source map, mpremote 1.20-1.29 wheels, MicroPython v1.29.0 `pyexec.c`). |
| [D] | Web page or registry text fetched during this task (summaries by a fetch tool, so issue-thread details are second hand). |
| [K] | General knowledge not re-verified here. |
| [I] | Inference. Always says how to refute it. |
| [U] | Needs real hardware, a Windows machine or Apple Silicon. Not verified. |

Limits: single host (Intel Mac, macOS 15.7.8, Node 26.5.0); no Windows, no Apple Silicon, no Windows ARM64; the fake board
has no real latency except the optional baud throttle, no DTR/RTS effects, no USB re-enumeration; WebSearch is US-only
and snippet-based, so some prior-art statements are weaker than the rest (tagged). Line numbers into the old source refer
to git HEAD `7cb90c7` (2026-04-04); `01-discovery.md` section 1 explains how the installed 0.3.2 build differs from HEAD.

---

## 2. The old design in architecture terms

### 2.1 The model

Stateless subprocess-per-operation: every board action is `python -m mpremote connect <port> <command>` (or, in the
installed build, bare `mpremote`), started through a shell string; the REPL is a VS Code terminal whose process *is*
mpremote; "auto-suspend" closes that terminal before a file operation and tries to type the command back afterwards.
Nothing in the extension owns the port, so everything that needs it competes: tree refresh, auto-sync, Run, Stop, the
REPL terminal, and any other program on the PC.

### 2.2 Mechanisms that make this model fail (details live in 01/02/03/06/08; these are the architecture-relevant ones)

| # | Mechanism | Where (HEAD) | Evidence |
|---|---|---|---|
| M1 | Each operation opens the port, enters raw REPL and (mpremote <= 1.29) soft-resets the board, running `boot.py` again; 1.30 pre-release flips that default, so behaviour now depends on which mpremote the student has | `mpremote.ts:142-233`; `08` fact 2 | [E] fake-board log: one `connect`, one `softreset` per `mpremote` call; [S] `main.py:536-553` |
| M2 | The per-port "operation in progress" flag is cleared by `markHealthy()` on the very next line, so nothing serialises mpremote processes; `withAutoSuspend()` resets its queue (`opQueue = Promise.resolve()`) on every call | `mpremote.ts:63-70,165-167`; `extension.ts:278-301` | [E] class text extracted verbatim and run under Node (Appendix F): `isOperationInProgress()` is `false` right after `markOperationStarted()` + `markHealthy()` |
| M3 | Two processes that open an exclusive port: the second fails with `failed to access ... (it may be in use by another program)` - literally the text of upstream issue #5 | n/a | [E] fake board in `--exclusive` mode, two concurrent `mpremote` calls, and a REPL client plus one file op |
| M4 | REPL = `createTerminal({shellPath, shellArgs:["-lc", cmd]})`; suspend = `sendText("\x18")` which *ends* the process, so the terminal vanishes; resume = `sendText(cmd)` into a terminal that no longer exists | `mpremoteCommands.ts:27-49,238-274` | [S]; reproduced in `02` E1-B/C |
| M5 | Interpreter validation tests a global `mpremote` on PATH instead of `<python> -m mpremote`, so a venv interpreter that has mpremote is rejected and the chain falls through to `python3`; `'py -3'` is passed to `execFile` as one filename | `pythonInterpreter.ts:229-249,105,206` | [E] `validate_repro.js` (Appendix F): `{"valid":false,"missingMpremote":false,"error":"spawn mpremote ENOENT"}` for a venv python that runs `-m mpremote` fine |
| M6 | POSIX single-quote escaping fed to `exec` (cmd.exe) and `sendText` (PowerShell) | `mpremote.ts:7-9,170-184`; `mpremoteCommands.ts:8-17` | [S]; upstream issue #30 quotes the exact generated command `'c:\Python314\python.exe' -m mpremote 'connect' 'list'` [D]. HEAD is the commit the issue reports |
| M7 | Commands that are not mpremote commands: `fs mkdir -p`, `fs stat` (silent no-op), `fs mv` (silent no-op), `fs run` (silent no-op) | `mpremote.ts:948,1103,1296,1460,1729` | [E] `fs mkdir -p` -> `fs: error: unrecognized arguments: -p`, rc 2 (this task); the silent no-ops are `08` fact 4 |
| M8 | Stop/Interrupt/Reset are `exec("echo -e '\x03\x03' > <port>")` | `mpremoteCommands.ts:392,453,485` | [E] under macOS `/bin/sh` the bytes written are `2d 65 20 03 03 0a` ("-e " + two Ctrl-C + LF); cmd.exe would write the literal text |
| M9 | Directory listing and sizes are scraped from the box-drawing output of `fs tree`, behind a 30 s whole-board cache | `mpremote.ts:255-370,511-770,1612-1710` | [S]; 03 defect catalogue |
| M10 | `Upload Active File` converts Windows separators with `/\\\\/g` (two backslashes), so `sub\dir\f.py` stays `sub\dir\f.py` | `extension.ts:904,911` | [E] node one-liner |
| M11 | Activation resets the user's port setting to `auto` in global settings every start; Run/REPL/Stop then refuse | `extension.ts:187` | [S]; `06` defect #1 |

### 2.3 What the stateless model costs (measured)

Rig: fake board on loopback (Appendix A), real `mpremote 1.29.0` in a venv on Python 3.15, Intel Mac. The fake board has
no USB or reset latency of its own, so these are **lower bounds** for the process-per-operation designs. A real ESP32
adds a hardware reset on open (possibly), a soft reboot with `boot.py` on every call, and slower USB.

| Measurement | Result |
|---|---|
| one trivial `mpremote exec pass` process | **0.53 s** wall (`python -I -c pass` 0.04 s; `import mpremote.main` 0.17 s total) |
| bridge: spawn + first `connect` / first `ls` after connect | **0.14 s** / 0.02-0.03 s (python3.12 `-I -u -X utf8`) |
| 20 files, 161-201 B each, unthrottled: old pattern (2 processes/file) / best-case stateless (1 process/file) / one mpremote process / bridge | **22.1 s / 11.9 s / 4.4 s / 1.7 s** |

20 files, 42.7 KB total, fake board throttled to 115200 baud in both directions (Appendix D):

| Strategy | `boot.py` empty | `boot.py` sleeps 1 s (stands in for a Wi-Fi connect) | port opens / soft resets for this strategy |
|---|---|---|---|
| S1 old extension's pattern: `fs mkdir -p` (opens the port, then argparse rejects `-p`) + `fs cp -f` per file | 31.4 s | 51.1 s | 40 / 20 |
| S2 stateless best case: one `fs cp` per file | 20.5 s | 40.2 s | 20 / 20 |
| S3 one mpremote process, 20 files in one `fs cp` | 11.3 s | 12.6 s | 1 / 1 |
| S4 bridge session (`put` x 20 on one open port) | **7.5 s** | **7.3 s** | 1 / 0 |

The fake board's event log for each scenario totalled 65 port opens (S1 40, S2 20, S3 1, S4 1, three setup `mkdir`s) and 44 soft resets (S1 20, S2 20, S3 1, S4 0, setup 3).
Two things to take from this: (a) the penalty is per *process*, so it grows with file count and with whatever `boot.py`
does; (b) S4 is dominated by simulated serial time, so on a real board the bridge's advantage is the removed fixed costs
(process start, reset, `boot.py`), not faster bytes. The old extension additionally runs `ensureIdle()` (`mp.ls("/")` =
`fs tree`) before most wrapped operations (`extension.ts:269-277`), which S1 does not count.

### 2.4 Upstream will not rescue this in time [D]

`DanielBustillos/mpy-workbench`: MIT, 63 commits, 18 stars, 10 open issues, 3 open PRs; last maintainer commit 2026-04-04
(`7cb90c7`, the one in this folder). Open and relevant: #5 "COM Port Error" (`failed to access COM8 (it may be in use by
another program)`; maintainer: "MicroPython boards allow only one active serial connection at a time. The Integrated REPL
Terminal locks the port"), #17 "'Run File' issues" (port busy while a script runs; maintainer: abort/release "already in
the pipeline"), #21 `mpremote: command not found` although the Python path setting was set, #30 Windows quoting (reporter:
"fixed with #33", not in this tree), #34 (Jun 2026). No issue about venvs or linting was filed. The "Enhanced Port
Communication" milestone is the same problem this document addresses; it has no assignee. Forking therefore means owning it.

---

## 3. Prior art

### 3.1 Survey table

| Project | How it talks to the board | Native code? | Python needed on the PC? | REPL | Packaging / platforms | Licence | Status / evidence |
|---|---|---|---|---|---|---|---|
| **MPY Workbench** (old) | `mpremote` CLI per operation | none | yes + mpremote | real terminal running mpremote | one VSIX (5.0 MB file, 11.6 MB / 772 files unpacked) | MIT | see 2.4 |
| **MicroPico 4.6.1** (`paulober.pico-w-go`, installed here) | in-process TypeScript raw REPL (`@paulober/pico-mpy-com`) on `@serialport/bindings-cpp` | yes: one 254 KB universal Mach-O in `prebuilds/darwin-x64+arm64/` | only for installing alternative stubs | **virtual REPL**: a `Pseudoterminal` with its own line editor, history, tab-completion; the port stays owned by the extension | per-platform VSIX (`TargetPlatform="darwin-x64"` in `.vsixmanifest`); README matrix: Windows x86 yes, ARM64 "no", macOS x64+arm64 yes | Apache-2.0 (>= 4.4.0; earlier MPL-2.0); built on Pico-Go/Pymakr heritage | 226 issues, very active (newest 2026-10-11); `engines.vscode ^1.137.0`, `node >=24.18`; extension dependency `ms-python.python` |
| **Pymakr 2** (`pycom/pymakr-vsc`, branch `next`) | in-process JS, `micropython-ctl-cont` on `serialport ^10.4.0` + `@serialport/bindings-cpp ^10.7.0` | yes | no (docs say Node.js is required) | extension terminal | VSIX; flagged `preview`; engines `node ^16.13` | GPL-3.0 | v2.22.4, 634 commits, 58 open issues [D] |
| **Thonny** | separate Python **backend process** (`bare_metal_backend.py`, args passed on the command line) using the `minny` library; raw REPL with raw-paste (`\x05A\x01`), block size 127 / 10 ms delay | none | ships its own Python in installers [K] | Shell widget fed by the backend | desktop installers | MIT [K] | de facto standard in schools; interrupts the program for file operations [D partial] |
| **Arduino Lab for MicroPython 0.22.0** | Electron app, `micropython.js` described as "a JavaScript implementation of the functionalities provided by mpremote" | no `serialport` dependency listed; `@electron/rebuild` in scripts | no | in-app | zip per OS, macOS universal, notarized | **AGPL-3.0** | "experimental pre-release software" [D] |
| **Microsoft Serial Monitor 0.13.1** (installed here) | `@serialport/bindings-cpp` **10.8.0** + `usb` | yes | no | monitor webview | **one universal VSIX (15 MB)** carrying every prebuild: android, darwin-x64+arm64, linux x64/arm/arm64, win32 ia32/x64 - **no win32-arm64** | MS | `extensionKind: ["workspace","ui"]` [E] |
| **PlatformIO IDE 3.3.4** (installed here) | Python `pio` CLI; serial monitor = pyserial in a terminal | none in the extension | uses an extension-managed venv (`~/.platformio/penv/bin/python` exists here [E]) | terminal | per-platform VSIX | Apache-2.0 [K] | Python-subprocess-with-pyserial at very large scale |
| **ESP-IDF extension** (not installed) | `idf.py monitor` (Python, pyserial) in a terminal | none | managed | terminal | | Apache-2.0 [K] | same pattern |
| **Mu editor** | Python + pyserial (+ `microfs`) [K] | none | bundled in installers | REPL pane | desktop | GPL-3.0 [K] | web search returned no authoritative architecture page; 2016-2020 forum posts about REPL control keys [D weak] |
| **mpremote** | official CLI; classes `SerialTransport`/`Transport` | none | yes | `repl` needs a real TTY | PyPI, pure Python | MIT | module header: "The API is going to change significantly" [S]; the docs page does not mention library use [D] |

### 3.2 What I could verify about MicroPico locally (it is the closest mature relative)

* **Serial layer** [S]: TypeScript raw REPL in `@paulober/pico-mpy-com`, which is **not on the public npm registry** (`npm view` -> 404;
  its README says to authenticate to GitHub Packages) [E][D]. So option E-as-a-library is out; copying is legal (Apache-2.0) but unattractive.
  It opens with `new SerialPort({path, baudRate:115200, autoOpen:true, lock:true})` (serialport's default `hupcl:true` applies) and, in the
  `open` handler, calls `serialPort.set({dtr:true, rts:true})` (library bundle, offset ~64400) [S]. MicroPico issues #360/#366 (Oct 2026, open)
  report ESP32 boards entering download mode after Reset on Windows and trace it to how DTR/RTS are held after `set()` [D].
* **Virtual REPL** [S: `terminal.mts`]: a `Pseudoterminal` that edits the line itself and submits complete lines; it exists "so the serial
  connection can be used by other parts of the extension while the user isn't executing a command in the REPL". Port ownership is permanent,
  which is the property that matters; the price is re-implementing REPL behaviour (history, multi-line, tab completion) in the extension.
* **Contention** [S: `connectionManager.mts`]: "Failed attempts because another program holds the port. On macOS every attempt disturbs that
  program's connection, so polling stops after a few." Auto-connect polling must be bounded.
* **No public API** [S]: `activate()` returns `Promise<void>` (`extension.mts:17-25`); integration would be `executeCommand("micropico.run")` and
  the `pico:` virtual file system. Not a basis for a product (see E in 4.3).
* **Tests** [D][S]: the bundle contains serialport's `MockBinding`; the `pico-mpy-com` README lists unit tests plus integration tests "against a MicroPython Unix-port
  simulator" - the same two ideas as section 8.
* **Linting** [S: `stubs.mts`]: writes `python.analysis.typeshedPaths` and `python.analysis.extraPaths` into the workspace `.vscode/settings.json`
  and ships `mpy_stubs/` (72 entries, Pico 2 W 1.26.0) in the VSIX. Nothing for firmware-specific modules (complaint 2); see `07`.
* **Platform history** [D]: issue #299 "Windows ARM64 support was removed" (closed Oct 2025): "I added Windows arm64 binaries back in the latest release. **I cannot test it** but they should work." That sentence is the entire argument against putting native code on the critical path when the instructor has no ARM64 laptop.
* **Other reliability signals** [D]: #367 "`Restart and Show Output` intermittently leaves Pico 2 WH in raw REPL" (mode-switch bookkeeping), #334 crash during upload of a large project,
  #341/#313 CH343 USB-serial chips not recognised by VID/PID, #304 "command 'micropico.initialise' not found" on a clean Windows 11 x64 install (cause never found; consistent with an activation failure, possibly but not provably the native module).

### 3.3 Lessons

1. **Everyone who ships to beginners converged on "exactly one component owns the port"** (MicroPico, Pymakr, Thonny, Arduino Lab, PlatformIO/ESP-IDF monitors). The old extension is the outlier, and upstream's own answer to port-busy bugs is "close the REPL first".
2. **Both a passthrough REPL and a virtual REPL are viable** once the owner exists. Passthrough keeps the board's own editing, history and tab completion; virtual avoids ever switching REPL modes. My prototype shows passthrough coexisting with raw-REPL operations (section 8.2), so I recommend passthrough.
3. **DTR/RTS on Windows + ESP32 is a live defect class even in the best TypeScript extension (Oct 2026) and was fixed in mpremote only in 1.27** (`08` section 7.3). Whatever implements the serial layer must copy mpremote's CP210x open sequence and RTS-then-DTR close order, and be tested on a real CP2102 board on Windows.
4. **Native modules turn into a platform matrix to maintain**: MicroPico ships per-platform VSIXs and lost/re-added ARM64; Microsoft's own monitor ships all prebuilds in one VSIX and lacks win32-arm64 in its serialport 10.x; current serialport (13.0.1) has win32-arm64 [E: `npm pack`, 2.2 MB unpacked].
5. **Test with a simulator**: the mature projects mock the binding and run a unix-port MicroPython. Do both.
6. **Licences**: do not copy Pymakr (GPL-3.0) or Arduino Lab (AGPL-3.0). MIT/BSD/Apache code (old extension, mpremote, pyserial, MicroPico) can be reused with attribution.
7. **Activation**: old `onLanguage:python` activates in every Python workspace (upstream #6 complained); MicroPico activates on `workspaceContains:.micropico`. Activate on a marker file or on view visibility.

---

## 4. Candidate architectures for the new extension

### 4.1 Definitions

* **A - stateless `mpremote` subprocess + real VS Code terminal REPL** (the old design).
* **B - A, hardened**: global queue/mutex, `execFile` with an argv array (no shell), interpreter validation fixed, REPL closed and reopened around file operations. A `Pseudoterminal` cannot host `mpremote repl` (it needs a real TTY, `08` fact 6), so B's REPL is either a real terminal started with `shellPath = python` and no shell, or a tiny pipe-based pyserial pump - which is already an owner process, i.e. C. I score B with the real-terminal REPL.
* **C - long-lived Python bridge** that owns the port, JSON lines to a pure-TS extension, REPL bytes streamed to a `Pseudoterminal`, vendored pure-Python deps, `python -I -u -X utf8`.
* **D - pure TypeScript in the extension host**: `serialport` (N-API native binding) + a TypeScript raw-REPL; Python only for linting. Web Serial is not an alternative: the extension host is Node with no `navigator.serial`, and I could find no evidence that VS Code webviews expose it ([D] search returned only Electron docs; [I] webviews are iframes without a serial permission policy; refute by evaluating `'serial' in navigator` in a webview). A `stty`/`mode`-based "serial without native code" hack has no DTR/RTS control and is rejected.
* **E - depend on another extension (MicroPico)**: commands or its `pico:` file system.

### 4.2 Scores (1 = poor, 5 = excellent; justification in 4.3)

| Criterion | A | B | C | D | E |
|---|---|---|---|---|---|
| 1 Works out of the box: macOS Intel+Apple Silicon, Windows x64+ARM64, non-expert students | 2 | 3 | 4 | 3 | 2 |
| 2 No native Node modules / credible packaging story | 5 | 5 | 5 | 2 | 3 |
| 3 Serial-port ownership robustness | 1 | 3 | 5 | 4 | 3 |
| 4 Python-side logic on the host (listing, hashing, sync, stub generation) | 2 | 2 | 5 | 2 | 1 |
| 5 Offline / lab network | 3 | 4 | 5 | 5 | 3 |
| 6 Installability: one VSIX, no Marketplace account | 4 | 4 | 5 | 4 | 2 |
| 7 Testability without hardware | 3 | 3 | 5 | 4 | 1 |
| 8 Maintainability by one ME instructor with AI help | 2 | 3 | 4 | 3 | 1 |
| 9 Latency: startup and per operation | 1 | 2 | 4 | 5 | 4 |
| 10 Behaviour in a Remote/WSL window | 2 | 2 | 3 | 2 | 1 |
| **Total (max 50)** | **25** | **31** | **45** | **34** | **21** |
| Weighted (criteria 1, 3, 7, 9 counted twice; max 70) | 32 | 42 | 63 | 50 | 31 |

These are judgements, not measurements; the justification column below is where to challenge them. Sensitivity: C stays first
unless criterion 2 and 1 are weighted so heavily that "no Python needed" dominates everything else (then D wins); that is the switch condition in 4.4.

### 4.3 Justification

**A.** (1) Needs the right Python *and* mpremote found through PATH/venv logic (complaint 1) and shell quoting that breaks on Windows (M5, M6). (2) No native code. (3) Every operation is a new process that opens the port, so the REPL terminal, auto-sync and Run collide (M2-M4); upstream #5/#17. (4) Only what `mpremote exec` strings can do, parsed from human-readable output (M9). (5) Needs pip unless wheels are pre-staged. (6) One VSIX but extra installation steps. (7) Possible through `socket://` (section 8) but every test pays 0.5 s per call. (8) Text-scraping a CLI whose behaviour changes by version (1.30 flips soft reset; `fs stat`/`mv`/`run` silently do nothing). (9) 0.53 s fixed + soft reset + `boot.py` per call (section 2.3). (10) The manifest says `extensionKind: ["workspace"]`, so in a WSL window the extension runs where no COM port exists and fails quietly.

**B.** (1) Quoting and validation fixed, but still depends on locating a Python that has mpremote unless wheels are vendored (then it is C without the owner). (2) None. (3) Serialised and deterministic, but the REPL must be closed and recreated around every file operation, losing REPL state; Stop still cannot reach a running program except through a second open; each op still soft-resets (<= 1.29). (4) Still string-in/text-out. (5) Vendoring pure-Python wheels would fix it (+1). (6) Same as A. (7) A fake board plus `socket://` works; the extension code still goes through process spawning. (8) The 1.7k-line `mpremote.ts` stays; each new feature needs more CLI-output parsing. (9) Still a process per operation. (10) As A.

**C.** (1) Zero binaries to get wrong: the same VSIX and the same bridge run on every OS/arch for which a Python >= 3.8 exists; ARM64 Windows Python (native or emulated) works because pyserial is pure Python (`ctypes` on Windows). Not a 5 because it adds one dependency (a discoverable interpreter, including the Microsoft Store stub trap) and I could not test Windows here. (2) None. (3) One owner thread, an explicit state machine, Stop that bypasses the queue, REPL that stays attached; prototype results in 8.2. (4) The bridge can run anything on the host: hashing, JSON manifests, stub generation by introspecting the board, optional mpremote `mip`/`mount`/`romfs`. (5) Deps vendored (pyserial 90 KB + mpremote 39 KB, 130 KB; 162 KB with platformdirs). (6) A single universal VSIX, about 1 MB with vendored deps. (7) Fake board + bridge CLI + TS tests; the same bridge binary runs in tests and in production. (8) Two languages, but the hard part (serial protocol and board quirks) is in Python, which is the instructor's language, and the bridge has a CLI mode (`python bridge.py ls --port COM3`) a student can run and paste. The TypeScript is mostly UI glue. Not a 5: vendored-library upkeep and process management. (9) 0.14 s once, then tens of milliseconds per operation. (10) The bridge accepts any pyserial URL, so `rfc2217://` / `socket://` ports are possible for advanced remote setups, but a WSL/SSH window is still unsupported by default.

**D.** (1) No interpreter dependency for board I/O (a real plus), but a native `.node` must load on every student's machine: universal Mach-O (the arm64 slice is ad-hoc linker-signed; the x86_64 slice is unsigned) and Windows x64/ARM64 DLLs. Unverified here: Defender/AppLocker/WDAC policies on lab PCs, Apple Silicon, Windows ARM64, and loading inside VS Code's own Electron rather than Node 26 (`02` E13 only loaded it in Node). (2) Native binding required; either per-target VSIXs or one universal VSIX carrying prebuilds (13.0.1: darwin universal 254 KB, win32-x64 233 KB, win32-arm64 237 KB, win32-ia32 185 KB, linux set; 2.2 MB unpacked [E]). (3) Single in-process owner; the arbitration state machine is identical to C, but the extension host itself now does blocking-style protocol work and must re-implement mpremote's DTR/RTS fixes (MicroPico #360/#366 shows how that goes). (4) Host logic is TypeScript; no `mip`, `mount`, `romfs`, no pip-delivered stub packages without Python. (5) Fully offline. (6) Universal VSIX works; platform-targeted VSIXs must match the machine. (7) `serialport` has a `MockBinding`, and a `net.Socket` transport for the fake board is natural. (8) The raw-REPL protocol, flow control and quirks are owned in TS (MicroPico's equivalent library is about 70 KB minified); one maintainer chasing CP210x/CH343/ESP32-S3 USB-JTAG behaviour without mpremote's community. (9) Best. (10) Same as the others.

**E.** (1) MicroPico targets the Pico (ESP32 "experimental"), requires VS Code >= 1.137 and Node >= 24.18, and its Windows ARM64 binaries are untested by the author. (2) Native code is theirs, outside our control. (3) Whoever owns the port is a black box. (4) None. (5) Needs both extensions and the Python extension offline. (6) Two VSIXs. (7) Nothing to test against: no API, `activate()` returns void [S]. (8) Undocumented command ids and a virtual file system as an interface; breaks when they refactor. (9) Fine. (10) n/a. Licensing is not the obstacle (Apache-2.0), feasibility is.

### 4.4 Where I differ from `02-repl-run.md` (transport A there = D here) and how to settle it

`02` section 10.2 proposes Node `serialport` as the primary transport, the Python helper as fallback, with a phase-0 spike on a
real board. I agree with its principles (single owner, terminal as a view, no shell strings, state machine, fake board) and
with the spike. I rank the transports the other way for these reasons:

1. Zero native code on the critical path; the instructor cannot test Windows ARM64, and the prior art shows the same blind spot (MicroPico #299: "I cannot test it"; Microsoft's monitor ships no win32-arm64 prebuild).
2. The course already requires Python (Pylance, the user's own `.venv`), so the marginal dependency is small, while a failed native load is the more opaque failure for a student ("not a valid Win32 application") than a missing interpreter (which a Doctor command can diagnose).
3. A bridge is debuggable by the instructor without VS Code (`python bridge.py --console`), and it isolates serial driver stalls from the extension host.
4. The vendored mpremote/pyserial code carries years of board quirks; in TS those must be re-learned.

**Switch to D only if** the Windows/macOS spike shows at least one of: Python is not reliably present on student machines or cannot be installed in the lab; Python start-up exceeds about 1 s on lab PCs (Defender); the bridge cannot be made to start reliably under `python -I` - **and** `serialport` loads on all four target platforms with clean DTR/RTS behaviour on the real CP2102 board. If either half fails, stay on C. **Design rule that keeps both open:** the extension talks only to a `Bridge` interface (NDJSON operations in 5.1); a Node implementation of the same interface (TypeScript raw REPL on serialport) can replace the Python process without touching views, state machine or tests. Do not build both.

---

## 5. Recommended design (C)

### 5.1 Process model and protocol

* The extension host (TypeScript, esbuild-bundled, runtime deps only for pure-JS helpers such as `jsonc-parser` and `ignore`) lazily spawns **one bridge per VS Code window** on first board use: `execFile`-style `spawn(python, ["-I","-u","-X","utf8", bridgePath], {stdio:["pipe","pipe","pipe"], windowsHide:true})`. No shell, no quoting, no cwd dependence.
* **stdin EOF = quit.** Verified: after `kill -9` of the parent, the bridge exited by itself in under 1.5 s and the fake board saw the disconnect [E]. No orphan process holding a COM port after a VS Code crash.
* **Reserve fd 1 for the protocol** (`os.dup(1)` then `os.dup2(2,1)`) because mpremote and libraries `print()` (for example `enter_raw_repl` prints the unexpected bytes before raising `could not enter raw repl`). The prototype does this [E, Appendix B].
* **NDJSON, UTF-8, one object per line, binary as base64.** Request `{"id":n,"op":...}`, reply `{"id":n,"ok":true,...}` or `{"id":n,"ok":false,"error":{"code":"E_PORT_BUSY","message":...}}`, events `{"ev":"repl"|"out"|"state"|"progress"|"log", ...}`. First message from the bridge is `hello` with `protocol`, `bridge`, `python`, `pyserial`, `platform`. Error codes are an enum the TS side maps to human text (`E_PORT_BUSY`, `E_NO_DEVICE`, `E_PERMISSION`, `E_RAW_REPL_TIMEOUT`, `E_PROGRAM_RUNNING`, `E_BOARD_RESET`, `E_FS_ERRNO`, `E_UNSUPPORTED`).
* Operations (all idempotent or explicitly confirmed): `ports.list` (pyserial `comports()`: path, vid, pid, serial, product), `connect{port,baud}`, `disconnect`, `fs.list{path}`, `fs.manifest{root}` (path, kind, size, sha256 in one round trip), `fs.put{local,remote,expectSha}`, `fs.get`, `fs.rm`, `fs.rmtree`, `fs.mkdir{parents}`, `fs.mv`, `run{source|local,reset}`, `stop`, `reset.soft`, `reset.hard`, `repl.attach|detach|write`, `introspect.modules` (feeds stub generation), `exec{code}` (diagnostics only), `cancel{id}`.
* Inside the bridge: one **port-owner worker** executes a priority queue (interrupt > user run/stop/reset > explicit file operations > auto-sync coalesced by path > tree refresh/stat probes); a reader thread parses stdin; a **pump thread** forwards serial bytes to the extension while the REPL is attached. `stop` and `repl.write` bypass the queue and take only the write lock (prototype: 20 ms [E]).

### 5.2 Port-ownership state machine (agrees with `02` section 10.3)

`NoBoard -> Connecting -> Idle(friendly REPL, pump on) <-> Running(user program) / RawOp(bridge-owned operation) -> Disconnected (reconnect poll) -> Connecting`.

* **Connecting** opens once and keeps the port. No reset, no interrupt on open; wait for a prompt with a bounded poll instead of sleeping (the upstream-proposed fix for `#13504`, `08` section 6.2 item 8). A board running `main.py` is left alone and its output shown.
* **File operations "borrow" the port**: take the lock, `enter_raw_repl(soft_reset=False)` (this still sends Ctrl-C, so a running program is interrupted - the extension must ask once, or defer and show "N files pending"), run, `exit_raw_repl`, swallow the banner up to the next `>>> `, hand the port back. Verified with the REPL attached: `ls` in 0.11 s, upload while attached, REPL variable preserved [E].
* **Run** = interrupt, enter raw REPL with soft reset (fresh VM, runs `boot.py`; `main.py` does not run because the mode is raw, `08` section 4.5), send the *editor buffer* with raw paste, stream output, return to Idle. To make tracebacks clickable, wrap the source as `exec(compile(src, "<local path>", "exec"), {"__name__":"__main__"})` or rewrite `File "<stdin>"` in the bridge; decide in the run round (needs a real-board check that `compile` exists on the firmware; it does on the standard ESP32 port [K]).
* **Stop** = `\x03` twice 50 ms apart, wait for a prompt, escalate after about 3 s to "Reset board" (RTS pulse, DTR low) and say so. Never `echo` into a device node.
* **Unplug / re-enumeration**: serial exceptions become `state: Disconnected`; poll `comports()` at 1-2 Hz while disconnected (no port open), bounded when the port is held by someone else (MicroPico's macOS observation). Native-USB ESP32 boards renumber after `machine.reset()`; remember the board by VID/PID/serial number, not by `COMx` (Windows renumbers per USB socket).
* **REPL view**: `ExtensionTerminalOptions` with a `Pseudoterminal`: `onDidWrite` <- decoded bridge `repl` events (streaming UTF-8 decoder), `handleInput` -> `repl.write`. Closing the terminal detaches the view; it never closes the port. Do not print progress into the REPL; use a log channel, a status bar spinner and notifications.

### 5.3 Python and dependency delivery (kills complaint 1 by construction)

* Vendor into the VSIX under `bridge/vendor/`: pyserial 3.5 (BSD-3, wheel 90 KB) and, if used as oracle/`mip` runner, mpremote 1.29.0 (MIT, wheel 39 KB). `platformdirs` is **not** needed on the bridge's import path - only `mpremote.main` imports it [E: removed from `vendor/`, bridge still passes]. Keep licence files in `THIRD_PARTY_NOTICES`.
* Insert `vendor/` first on `sys.path` inside `bridge.py` and launch with `-I` (ignores `PYTHON*` variables, user site and the current directory) so a stray `serial.py` or `pyserial`-vs-`serial` clash in the student's folder cannot shadow the vendored copy (`08` fact 10) and `PYTHONIOENCODING=cp1252` cannot break UTF-8 (`08` section 4.7).
* **Interpreter discovery, in order**, every candidate validated by *running it*: explicit setting (with `${workspaceFolder}` expanded; never silently fall through from an explicit setting); the Python extension API (`@vscode/python-extension` `environments.getActiveEnvironmentPath()` + `resolveEnvironment()`; the legacy `settings.getExecutionDetails` is deprecated and reads only the `pythonPath` setting in the installed ms-python.python 2026.8.0 [E: bundle grep]); workspace `.venv/Scripts/python.exe` / `.venv/bin/python` (also `venv/`, `env/`); Windows `py -3` as `spawn("py", ["-3", ...])`; `python3`, `python` on PATH; Homebrew and python.org default locations. The probe is `python -I -c "import json,sys;print(json.dumps({...}))"` and rejects: non-zero exit, empty output (the Microsoft Store alias stub), version < 3.8. Details in `01-discovery.md` section 8.
* Escape hatch: setting `bridge.mpremoteSource = "bundled" | "environment"`; "environment" appends the chosen interpreter's `site-packages` for mpremote-only features. Default bundled. The workspace's own `.venv` is only ever used as a *Python interpreter*, and only after Workspace Trust is granted (a workspace-controlled interpreter path is arbitrary code execution; the old manifest claims `untrustedWorkspaces.supported: true`).

### 5.4 Which serial layer inside the bridge (C1 vs C2)

* **C1** - drive `mpremote.transport_serial.SerialTransport` (what my prototype does). Fast to a first demo; inherits mpremote's DTR/RTS and close ordering. The API surface used (`SerialTransport(device, baudrate, wait, exclusive[, timeout])`, `enter_raw_repl(soft_reset[, timeout_overall])`, `exit_raw_repl`, `exec`, `exec_raw`, `exec_raw_no_follow`, `follow`, `eval`, `read_until`, `close`, and `fs_*` from 1.24) has stable signatures across 1.21-1.29 [E: AST comparison of the wheels] but is explicitly unstable by its own header [S], blocks with polling loops, has fixed 10 s silence timeouts, prints to stdout, and opens the port inside the constructor (no pre-open hook for a DTR/RTS policy).
* **C2** - an in-house link (about 350 lines on pyserial): prompt sync, Ctrl-C/A/B/D, raw paste with flow control, `follow()`, per-stage timeouts, cancellation, progress, explicit open sequence (CP210x on Windows, RTS-then-DTR on close) copied from mpremote (MIT) with attribution. This follows the principle `08` section 6.4 and `02` section 10.2 recommend: own the protocol layer.
* **Recommendation: build C2 as the product, behind a `Link` interface; keep vendored mpremote as the differential-test oracle** (run each scenario through both and compare outputs) **and as the runner for `mip`/`mount`/`romfs`.** C1 already proved the model; do not rebuild the spike. If the first round is behind schedule, start on C1 and swap; the interface makes that a one-file change.

### 5.5 Packaging

One **universal** VSIX built with `vsce package` (no `--target`): `dist/extension.js` (esbuild, a few hundred KB), `bridge/mpy_bridge.py`, `bridge/vendor/`, `media/`, `stubs/` (see 5.6), `NOTICE`, `THIRD_PARTY_NOTICES`. About 1-3 MB without stubs. Install with `code --install-extension x.vsix` or "Extensions: Install from VSIX...", no Marketplace account, no network. A platform-targeted VSIX only installs on the matching platform, which is why D would need either four VSIXs or a universal one carrying every prebuild. Compress the old 1.48 MB `logo.png`. Commit `package-lock.json` but never `node_modules` (upstream #28; the old repo carries 49 MB).

### 5.6 Linting hooks (complaint 2; the content belongs to `07-linting-stubs.md`)

The bridge makes the hard part cheap: `introspect.modules` can list `help('modules')` and `dir()` of every importable module on the actual board, including custom frozen C modules, and the extension writes `.pyi` stubs into `<workspace>/typings/` (Pylance's default `stubPath`, so no settings change is needed) and/or `python.analysis.extraPaths` entries for the firmware repo's `modules/` and frozen-manifest directories, merging into `.vscode/settings.json` with a JSONC-preserving editor. Board-derived stubs are the only source that is correct for *this* firmware; bundled `micropython-esp32-stubs` cover the standard library. Set `reportMissingModuleSource` off as MicroPico does.

### 5.7 Remote/WSL and trust

Detect `vscode.env.remoteName` and refuse to start the bridge with a clear message ("open the folder directly on Windows/macOS, not in WSL/SSH/Container"); do not change `extensionKind` (it would also move the workspace file access). Contribute `capabilities.untrustedWorkspaces: "limited"` and keep the bridge disabled until trust is granted. Activate on `workspaceContains:.mpyignore` / a project marker file / view visibility, not `onLanguage:python`.

### 5.8 Migration and fallback paths

* **M0 (optional stop-gap, 1-2 rounds, on a copy of the old tree inside `mpy-upgrade/legacy-hotfix/`)**: only if a class meets before the rewrite is usable. Minimum patch set: validate `<python> -m mpremote version`, expand `${workspaceFolder}`, `execFile` with argv, drop `mkdir -p`/`stat`/`mv`/`fs run`, remove the activation reset of `connect`, delete the `echo -e` interrupts (send `\x03` through a short-lived mpremote `exec`), serialise calls with a real queue. This yields B-level quality and nothing more.
* **M1 (main line)**: C with C2 link as above; gate G1 after round 1 = instructor runs `python bridge.py ls`, `put`, `run` against the real board on one Mac and one Windows laptop.
* **M2 (fallback if G1 fails on Python start-up or presence)**: implement the same `Bridge` interface with a Node/serialport transport (D) and reuse everything above it.
* **M3 (fallback if the bridge cannot start on a given PC)**: the Doctor command prints interpreter, vendored versions and the exact probe output, and offers "use mpremote CLI mode" for file operations only (degraded B), so a student is never left with a dead sidebar.

---

## 6. Salvage inventory (old TypeScript, 5,782 lines including helpers)

| Old file / function | LOC | Verdict | How |
|---|---|---|---|
| `package.json` `contributes` (3 views, `viewsWelcome`, 33 commands, 20 menu entries, 10 settings) | n/a | **Port as the specification** | Re-implement all of it; delete the ten commands nobody implements (`06` #2), drop the `*FromView` wrappers that exist only for `setSkipIdleOnce()`, rename ids; keep titles/icons so the layout is unchanged |
| `esp32Fs.ts` `Esp32Tree` (tree model, add/remove/reset node) | 259 | **Port** | keep node model and item rendering; `getChildNodes` becomes `bridge.fs.list`; drop `enableRawListForNext`/`pyraw` |
| `decorations.ts` `Esp32DecorationProvider` | 96 | **Port nearly as is** | add tests |
| `actions.ts`, `syncView.ts` (action trees) | 63 + 61 | **Port** | commands call the session directly |
| `localFilesView.ts` | 97 | **Decide** | the view id is never contributed in `package.json` (`extension.ts:197`); contribute it or drop it |
| `sync.ts` `buildManifest`, `diffManifests`, `defaultIgnorePatterns`, `createIgnoreMatcher` | 123 | **Port + upgrade** | content-hash comparison (board-side sha256 from `fs.manifest`) instead of size+mtime; replace `globToRegExp` with the `ignore` package (gitignore semantics, negation); keep `.mpyignore` file name and defaults |
| `boardOperations.ts` `buildDefaultMpyIgnoreContent`, `openFile`, `delete`, outline of `syncBaseline` (dirs first, then files, then save manifest) | 551 | **Port ideas only** | re-implement `syncBaseline` as plan -> confirm -> per-file result -> manifest saved only for files that succeeded (`06` defect #7) |
| `mpremoteCommands.ts` `toLocalRelative`, `toDevicePath`, `localRelToImportName` | ~25 of 509 | **Port** | into `paths.ts` with Windows tests |
| `extension.ts` auto-sync-on-save flow (1093-1128), `workspaceAutoSyncEnabled`, `.mpy-workbench/config.json` convention, status bar items, command registration list | ~300 of 1185 | **Port the behaviour** | not the code: it is entangled with five process-wide singletons |
| `media/` icons (`activitybar.svg`, `file.svg`, `folder.svg`, `trash-red.svg`) | n/a | **Keep** | |
| Changelog 0.2.62 idea (show real file path in tracebacks) | n/a | **Keep the goal** | achieved via `compile(src, path)` or traceback rewriting, not via `import module` |
| `mpremote.ts` (ConnectionManager, tree parsing, retry/backoff, recovery heuristics) | 1743 | **Drop** | |
| `mpremoteOperations.ts` | 99 | **Drop** | re-export wrapper |
| `pythonInterpreter.ts` | 418 | **Rewrite** | keep only the idea of the Windows candidate list |
| `pyraw.ts` (points at nonexistent `thonny_list_files.py`), `monitor.ts` (never started), `control.ts` (unused), `test.ts`, `scripts/*.py`, `src/miniterm_filter.py`, stale `dist/pathUtils*` | ~500 | **Drop** | |
| Committed `node_modules` (49 MB), 5 MB `.vsix`, 31 MB `.git` | n/a | **Do not carry over** | |

Licence: MIT, (c) 2025 Juan Daniel Bustillos Camargo. Keep the notice in `NOTICE` for any ported code.

---

## 7. Fix vs rewrite, and the effort

### 7.1 Verdict

**Rewrite the engine (everything that talks to the board, the interpreter and the shell), keep and port the shell (views, commands, decorations, sync/ignore semantics).** `06-ext-core.md` section 4 reaches the same conclusion from the core side: the product-defining behaviours (interpreter, port, queue, run, REPL) are the structurally wrong ones. Fixing in place means rewriting `mpremote.ts`, `mpremoteCommands.ts`, `pythonInterpreter.ts` and most of `extension.ts` anyway, and ends at architecture B (31/50) with a text-scraping core. The honest argument for fixing instead: it delivers a patched, familiar tool sooner for a *single* near-term class; that is the optional M0 above, not the destination.

### 7.2 Effort in agent rounds

A *round* = one orchestrated workflow: a short plan, 3-6 parallel implementer subagents on disjoint files, then an independent verification stage (tests run, review, defect list), ending with `plan.md` updated. Roughly 1.5-3 kLOC of tested code per round. Human-in-the-loop steps (real board, Windows laptop) are separate gates and cannot be compressed by agents.

| Round | Scope | Exit criterion |
|---|---|---|
| R1 | Repo scaffold (`CLAUDE.md`, `plan.md`, esbuild/tsconfig, lint/test scripts), protocol spec, bridge core + C2 link (connect, list, manifest, put/get/rm/mkdir, run, stop, reset, repl pump), fake board in `tools/`, pytest suite, differential tests against vendored mpremote 1.29 | `python bridge.py` CLI passes the scenario catalogue against fake board and unix VM; **Gate G1**: instructor runs the CLI on the real board (Mac + Windows) |
| R2 | TypeScript core: interpreter discovery and probe, `BridgeClient` (spawn, NDJSON, restart policy), session state machine, settings, status bar, log channel, Doctor, trust/remote guards | extension host activates, connects to the fake board, Doctor output correct |
| R3 | Views: Files tree (lazy list, decorations), Board Actions, Sync utilities; context-menu file operations; hash-based diff | sidebar parity with the old extension on the fake board |
| R4 | Pseudoterminal REPL, Run/Stop/Reset, output and traceback links, auto-sync on save, ignore file, sync-all with plan/confirm/per-file results | the student workflow end to end on the fake board |
| R5 | Linting: bundled stubs, firmware paths, board introspection to `typings/`, settings writer | complaint 2 demonstrably closed on a sample project |
| R6 | Packaging (vendoring, licences, size budget, `vsce`), extension-host e2e tests, CI scripts for macOS and Windows | installable universal VSIX; **Gate G2** |
| R7 | Real-board shakedown on macOS and Windows (CP2102; reset-on-open; Stop; unplug), fix list | **Gate G3** |
| R8 | Hardening, student handout, release, buffer | classroom ready |

* **Rewrite (C): 7-11 rounds, most likely 8-9.** First usable build after R4-R5. Uncertainty drivers: Windows behaviour I could not test here (ConPTY keys, Defender latency, COM renumbering), ESP32 reset-on-open (`08` section 7.3), whether `compile()`-based traceback paths work on the class firmware, and how much of R5 the firmware modules need.
* **Fix in place (B): 5-7 rounds** - hotfix pack (1), real queue and REPL lifecycle (1-2), replace tree scraping with device-side JSON (1), linting (1-2), packaging and tests (1). It converges with a lower ceiling and every later feature costs more.
* **Hybrid (M0 now, C afterwards): +1-2 rounds** to the C total; worth it only if a class starts before R4 completes.

---

## 8. Testing strategy: hardware-free end to end

### 8.1 Pyramid

| Layer | What | Runs on | Tools |
|---|---|---|---|
| L0 | Device-side Python snippets (manifest, hashing, listing, stub dump) executed by a **real MicroPython VM**, no serial at all | macOS/Linux with the built unix port; every OS with the WASM build | `micropython manifest.py` or `@micropython/micropython-webassembly-pyscript` under Node |
| L1 | Pure TypeScript units: paths, ignore matcher, manifest diff, NDJSON codec, interpreter-probe parsing, state machine | all OSes | mocha/vitest |
| L2 | Bridge scenario tests: the real bridge against the **fake board** over `socket://` (no pty, so Windows works) and, on POSIX, against the real unix VM | all OSes / POSIX | pytest, subprocess |
| L3 | Differential tests: same scenario through vendored mpremote and through the bridge, outputs compared (mpremote as oracle) | all OSes | pytest |
| L4 | Extension-host smoke tests with the real bridge and fake board: activate, connect, tree items, Run output in the pseudoterminal, auto-sync | macOS + Windows runners | `@vscode/test-electron` |
| L5 | Real-board checklist (`02` section 13, `08` section 11) and a "doctor" smoke script the instructor runs | by hand | |

### 8.2 The fake board (built and verified)

Appendix A is the full source (416 lines, Python stdlib only). It implements the protocol the host actually sees:
friendly REPL (echo, `>>> `, `... ` continuation, Ctrl-A/B/C/D), raw REPL (`raw REPL; CTRL-B to exit\r\n>`, `OK`, `\x04` stdout/stderr framing, soft reset via empty Ctrl-D, `MPY: soft reboot`), **raw paste** with window flow control (`R\x01` + 128-byte window + `\x01`), `boot.py` on every soft reset and `main.py` only from the friendly REPL (like the ESP32 port), a chrooted `os`/`open` (`/main.py` maps into `--root`), MicroPython-style tracebacks (`OSError: [Errno 2] ENOENT`, which mpremote's `_convert_filesystem_error` needs), `--exclusive` (refuses a second client while one is attached, like an exclusive serial lock), `--baud` throttling, `--log` of connect / soft reset / exec / interrupt events so tests can assert "the port was opened exactly once".

Executed against it:
* **Real mpremote 1.29.0** over `socket://127.0.0.1:<port>`: `exec`, `fs ls`, `fs cp` (both directions), `fs cat`, `fs mkdir`, `fs tree`, `run`, a device exception (traceback + rc 1) all behave as on a board [E].
* **The bridge prototype** (Appendix B/C): connect, 20-file `put`, one-round-trip manifest with sha256, `run` with streamed output, REPL attach, file operations while the REPL is attached (state preserved), Stop, `kill -9` of the parent [E]. Run under Python 3.10, 3.11, 3.12, 3.13, 3.14, 3.15 with only vendored wheels [E].
* Two bugs in my own fake were found by the benchmark and fixed (an input-gate race that dropped the host's first bytes after a prompt; `running` is now set synchronously and cleared before the prompt is sent). Keep a regression test: hundreds of back-to-back raw-paste exchanges.

Honest limits: no DTR/RTS or auto-reset circuit, no USB re-enumeration, no flash/FAT behaviour, no real brown-out; the cooked output is CRLF like a real port, but the traceback text is CPython-derived, so tests must not depend on exact MicroPython wording beyond the errno names. Add scenarios that inject faults: close the socket mid-transfer, emit garbage before the banner, delay `boot.py`, hold `main.py` in a `while True`, ignore Ctrl-C (a `try/except KeyboardInterrupt` loop - `08` section 4.5 shows mpremote then times out after 10 s).

### 8.3 Real MicroPython without hardware

* **Unix port**: `git clone --depth 1 --branch v1.29.0 https://github.com/micropython/micropython`, `make -C mpy-cross`, `make -C ports/unix submodules`, `make -C ports/unix MICROPY_PY_FFI=0 MICROPY_PY_BTREE=0 MICROPY_PY_SSL=0` -> **460 KB `micropython` binary in about two minutes** with Xcode's clang (script: Appendix E) [E]. No pip package exists (`pip download micropython` -> "No matching distribution") [E]; Homebrew has a `micropython` 1.29.0 bottle (`brew info`, not installed) [E]. Unix port quirks: its REPL exits on raw-REPL Ctrl-D instead of printing `MPY: soft reboot`, so mpremote's default `soft_reset=True` entry fails (`could not enter raw repl`); `resume`/`soft_reset=False` entry works. `mpremote fs ls` showed size 0 for every file (the port's `ilistdir` entries carry no size), and there is no chroot, so use relative paths.
* **Through a pty**: `mpunix_relay.py` (Appendix E) bridges TCP to the unix VM on a pty. Real mpremote 1.29.0 in `resume` mode ran `exec` (`micropython 42`), `fs ls`, `run`, a `ZeroDivisionError` traceback, `fs cp` and `fs sha256sum` (matches `shasum -a 256`) against the real VM [E]. This validates the raw-paste handshake of the fake against the firmware's own `pyexec.c`. `08` section 12 built a fuller emulator (real VM + exact framing); prefer it if the two are merged.
* **L0 example**: the manifest snippet from Appendix B run directly as `micropython manifest_dev.py` printed sizes and sha256 values equal to the host's `shasum` [E]. This catches CPython-isms in device-side code (the usual trap when snippets are tested only through a CPython fake).
* **WASM**: `npm i @micropython/micropython-webassembly-pyscript@1.29.0-6` (MIT, 2.4 MB, no compiler) loads in Node 26 and runs `hashlib.sha256`, `os.ilistdir` [E]; its `replInit/replProcessChar` API accepts Ctrl-A and runs raw-REPL code, but my probe **hung on the raw-paste request**, so it is an L0 engine for Windows CI, not a drop-in fake board [E, limited]. Not tried on Windows.

### 8.4 CI matrix

macOS Intel, macOS Apple Silicon, Windows x64, Windows ARM64 (GitHub-hosted Windows ARM64 runners exist for public repositories [K]; verify). L0-L3 need Node and Python only; L4 needs a display-less Electron (`xvfb` on Linux, native on macOS/Windows). If there is no CI, the same scripts run locally; add `npm run verify` that runs L0-L3 in under a minute. The cross-platform guard script and workflow drafts are already in `05-cross-platform.md` appendices C/D.

---

## 9. Port contention advice (PlatformIO, ESP-IDF, Arduino, Thonny, other VS Code windows)

* The port is exclusive: POSIX `flock` by pyserial (advisory), Windows share mode (enforced). The failure text is the same for busy, missing and permission problems, so the bridge must **classify** (`ENOENT`, `EACCES`, `EBUSY`/flock, driver) and the UI must say which, and what to close: "Thonny, Arduino IDE/Serial Monitor, PlatformIO device monitor, ESP-IDF monitor, another VS Code window, `mpremote` in a terminal, a running `esptool`."
* Never poll-open a busy port. After a "busy" failure stop auto-reconnect and show a **Retry** action; MicroPico stops after a few attempts because on macOS each attempt disturbs the other program [S].
* Provide a **Release port** toggle (status bar) so a student can hand the board to esptool/Arduino and take it back, and a **Disconnect on window blur** option for labs.
* On macOS use only `/dev/cu.*` (the `/dev/tty.*` twin blocks waiting for carrier). Rank ESP32-class bridges first (CP210x 10C4:EA60, CH340 1A86:7523, CH343 1A86:55D3, FTDI 0403:6001, Espressif 303A:*) but **list every port** - filtering by VID/PID is what MicroPico's CH343 issues are about.
* A "who has my port?" helper may run `lsof <device>` on macOS/Linux after an open failure (it reads kernel tables and does not open the port); Windows has no built-in equivalent, so give the checklist above.
* Do not run `mpremote connect auto` style probes in the background; they open every USB serial port.

---

## 10. Risks and open questions

Risks (with how to retire them):
1. **Python start-up on lab Windows PCs** (Defender, Store alias, no Python): retire with the G1 spike and the Doctor; switch rule in 4.4.
2. **ESP32 reset-on-open on the user's CP2102** (`08` section 7.3, upstream `#13504` shows the same node name): retire with the `time.ticks_ms()` experiment in `08` section 11; design already waits for a prompt and never assumes the board did not reset.
3. **Vendored library upkeep**: pyserial is stable; the C2 link removes the mpremote dependency from the hot path; keep a version-pinned oracle and a bump checklist.
4. **Apple Silicon and Windows ARM64 are untested here**: C has no per-arch binaries, so the risk is limited to the Python interpreter itself; verify once on each.
5. **Pseudoterminal input fidelity** (Ctrl-C vs copy on Windows, arrow keys, bracketed paste) must be checked in a real VS Code on Windows (`02` section 13 item 7).
6. **Two languages for one maintainer**: mitigated by a small Python bridge, a CLI mode, and tests that run without VS Code.
7. **Scope creep in the bridge** (WebREPL, BLE, `mount`): out of scope for v1.

Open questions for the user: Is Python guaranteed on every student PC, and may the lab install it? Are lab PCs locked down (no admin, AppLocker/WDAC, proxy)? Which exact boards and USB chips (all CP2102, or also CH340/S3 native USB)? Where is the custom-firmware source tree, and are its modules frozen Python, C modules, or both? Do students use WSL or remote windows? Is a Windows ARM64 laptop available for one test? Publish to the Marketplace later, or VSIX only? Any objection to MIT licensing for the new code?

---

## 11. Requirements extracted for `plan.md` / `CLAUDE.md` (architecture level)

1. R-ARCH-1 One port owner (the bridge); nothing else in the extension opens the device; the REPL terminal never owns it.
2. R-ARCH-2 No shell strings anywhere: `spawn`/`execFile` with argv arrays; no `sendText` of commands; no `echo` into device nodes.
3. R-ARCH-3 Bridge starts as `python -I -u -X utf8 bridge.py`, vendored deps first on `sys.path`, protocol on a reserved fd, exits on stdin EOF.
4. R-ARCH-4 Interpreter discovery validates candidates by running a probe; an explicit setting is never silently ignored; Store stubs and Python < 3.8 are rejected; result and reason shown by a Doctor command.
5. R-ARCH-5 State machine with explicit states and a documented transition table; Stop bypasses the queue; file operations never run while a user program is running without consent.
6. R-ARCH-6 Sync decisions use content hashes; per-file results; manifest updated only for files that succeeded; destructive actions confirmed.
7. R-ARCH-7 No native Node modules; one universal VSIX; size budget stated (< 5 MB without stubs); licences shipped.
8. R-ARCH-8 `Bridge` interface in TypeScript so a Node/serialport implementation could replace the Python one without touching views.
9. R-ARCH-9 Hardware-free test suite (L0-L3) runs on macOS and Windows in under a few minutes and gates every round; a regression test pins each defect in section 2.2 that the new code must not reintroduce.
10. R-ARCH-10 Remote/WSL windows and untrusted workspaces get an explicit message, not silent failure.
11. R-ARCH-11 Activation on a project marker or view visibility, not on every Python file.
12. R-ARCH-12 Auto-reconnect is bounded; busy ports are classified and explained.

---

## 12. Evidence index (what I ran) and how to reproduce

Scratch tree: `.../scratchpad/arch/` (session scratchpad). Everything below is reproducible from the appendices.

| # | Experiment | Result |
|---|---|---|
| X1 | Built MicroPython v1.29.0 unix port (`build_mpy.sh`) | success, 460 KB binary, ~2 min |
| X2 | Fake board + real `mpremote 1.29.0` over `socket://` (`exec`, `fs ls/cp/cat/mkdir/tree`, `run`, error) | all correct; one connect and one soft reset per call in the event log |
| X3 | Same via real unix VM on a pty relay with `resume` | `exec`, `fs ls`, `run`, traceback, `cp`, `sha256sum` correct |
| X4 | Bridge prototype vs fake: 20 puts 1.7 s; manifest; run events; REPL + file ops; state preserved; Stop 20 ms | passes; 1 connect, 1 soft reset (the `run`) |
| X5 | Bridge on system Python 3.10-3.15 with vendored wheels only; with `-I -u -X utf8`; without `platformdirs` | passes on all |
| X6 | Orphan test: `kill -9` the parent | bridge exits within 1.5 s |
| X7 | Benchmarks S1-S4 (section 2.3), two scenarios | tables above |
| X8 | `validate_repro.js` (old `validatePythonPath` verbatim vs venv python) | `valid:false`, `spawn mpremote ENOENT` |
| X9 | Old `ConnectionManager` text extracted and run | `isOperationInProgress` false immediately after set |
| X10 | `sh -c "echo -e '\x03\x03' > file"` under macOS `/bin/sh` | bytes `2d 65 20 03 03 0a` |
| X11 | `fs mkdir -p` on mpremote 1.29.0 | argparse error, rc 2 |
| X12 | AST comparison of `SerialTransport` across wheels 1.20-1.29 | stable 1.21-1.29 (constructor gains `timeout` in 1.25, `enter_raw_repl` gains `timeout_overall` in 1.25); 1.20 has `pyboard.py` instead |
| X13 | `npm pack @serialport/bindings-cpp@13.0.1`; list prebuilds; `lipo`/`codesign` on MicroPico's copy | win32-arm64 present; arm64 slice ad-hoc linker-signed, x86_64 unsigned |
| X14 | Local extension inspection: MicroPico 4.6.1, Microsoft Serial Monitor 0.13.1, PlatformIO, Arduino community | see 3.1 |
| X15 | `npm view @paulober/pico-mpy-com` | 404 (GitHub Packages only) |
| X16 | `pip download micropython` | no distribution |
| X17 | WASM MicroPython under Node | `sha256`, `ilistdir` work; raw-paste probe hung |
| X18 | Windows-separator regex from `extension.ts:904,911` | `"/sub\\dir\\file.py"` unchanged |

Reproduce (POSIX):
```
python3 -m venv venv && venv/bin/pip install mpremote==1.29.0
venv/bin/python fakeboard.py --root boardroot --log fb.log      # prints LISTENING socket://127.0.0.1:PORT
venv/bin/mpremote connect socket://127.0.0.1:PORT fs ls
venv/bin/python drive_bridge.py socket://127.0.0.1:PORT          # bridge scenarios (needs vendor/ with pyserial + mpremote wheels extracted)
./bench.sh 115200 1.0                                            # benchmark scenario
```

---

## Appendix A - `fakeboard.py` (final, tested on macOS; Python stdlib only; written to work on Windows because it uses TCP, not a pty - Windows not yet run)

Run: `python fakeboard.py --root DIR [--exclusive] [--baud 115200] [--log FILE] [--run-main-on-connect]`; it prints `LISTENING socket://127.0.0.1:PORT`. Point `mpremote connect`, the bridge, or any pyserial client at that URL.

```python
#!/usr/bin/env python3
"""fakeboard.py - a hardware-free, cross-platform fake MicroPython board.

Speaks the real MicroPython serial REPL protocol over a TCP socket so that
`mpremote connect socket://127.0.0.1:<port> ...` and any pyserial-based bridge
can be tested end to end on macOS, Windows and Linux CI (no pty, no hardware).

Implements: friendly REPL (echo, '>>> ', '... ' continuation, Ctrl-C/D/A/B),
raw REPL (Ctrl-A banner, '>' prompt, 'OK', \x04 framing, soft reset via empty
Ctrl-D, 'MPY: soft reboot'), raw-paste mode (\x05A\x01 with flow control),
boot.py/main.py on soft reset (main.py only from the friendly REPL, like the
ESP32 port), a chrooted `os`/`open` so '/main.py' maps into --root, MicroPython
style tracebacks ('OSError: [Errno 2] ENOENT') and an --exclusive mode that
refuses a second client while one is attached (like an exclusive serial lock).

Usage:  python fakeboard.py --root DIR [--port 0] [--exclusive] [--log FILE]
Prints one line 'LISTENING socket://127.0.0.1:<port>' on stdout when ready.
"""
import argparse, builtins, codeop, ctypes, errno as _errno, json, os, socket
import sys, threading, time, traceback, types
from pathlib import Path

BANNER = (b"MicroPython v1.29.0-fake on 2026-01-01; Fake ESP32 module with ESP32\r\n"
          b'Type "help()" for more information.\r\n')
CTRL_A, CTRL_B, CTRL_C, CTRL_D, CTRL_E = 1, 2, 3, 4, 5


class SoftReset(BaseException):
    pass


class FakeOS:
    """MicroPython-flavoured os rooted in a host directory."""
    sep = "/"

    def __init__(self, root):
        self._root, self._cwd = Path(root).resolve(), "/"

    def _p(self, path):
        path = path or "."
        full = path if path.startswith("/") else (self._cwd.rstrip("/") + "/" + path)
        parts = []
        for seg in full.split("/"):
            if seg in ("", "."):
                continue
            if seg == "..":
                parts and parts.pop()
            else:
                parts.append(seg)
        return self._root.joinpath(*parts)

    def getcwd(self): return self._cwd
    def chdir(self, p): self._cwd = "/" + "/".join(x for x in (p if p.startswith("/") else self._cwd + "/" + p).split("/") if x)
    def listdir(self, p="."): return [e.name for e in sorted(self._p(p).iterdir())]
    def ilistdir(self, p="."):
        for e in sorted(self._p(p).iterdir()):
            d = e.is_dir()
            yield (e.name, 0x4000 if d else 0x8000, 0, 0 if d else e.stat().st_size)
    def stat(self, p):
        s = self._p(p).stat()
        return (s.st_mode, 0, 0, 0, 0, 0, s.st_size, int(s.st_atime), int(s.st_mtime), int(s.st_ctime))
    def mkdir(self, p): self._p(p).mkdir()
    def rmdir(self, p): self._p(p).rmdir()
    def remove(self, p): self._p(p).unlink()
    unlink = remove
    def rename(self, a, b): self._p(a).rename(self._p(b))
    def statvfs(self, p): return (4096, 4096, 256, 128, 128, 0, 0, 0, 0, 255)
    def uname(self):
        return types.SimpleNamespace(sysname="esp32", nodename="esp32", release="1.29.0",
                                     version="v1.29.0-fake", machine="Fake ESP32 module with ESP32")
    def urandom(self, n): return os.urandom(n)


class Board:
    def __init__(self, root, sock, log):
        self.root, self.sock, self.log = Path(root), sock, log
        self.wlock = threading.Lock()
        self.mode = "friendly"          # friendly | raw
        self.line = bytearray()         # raw: pending program; friendly: pending input line
        self.cont = []                  # friendly: continuation lines
        self.paste = None               # raw-paste state dict
        self.worker = None              # currently running exec thread (for async KeyboardInterrupt)
        self.running = False            # True from spawn() until the program hands the prompt back
        self.alive = True
        self.reset_vm()

    # ---------------------------------------------------------------- output
    def tx(self, b):
        if isinstance(b, str):
            b = b.encode()
        with self.wlock:
            try:
                self.sock.sendall(b)
                if BAUD:
                    time.sleep(len(b) * 10.0 / BAUD)     # 8N1 = 10 bit times per byte
            except OSError:
                self.alive = False

    def ev(self, kind, **kw):
        self.log(kind, **kw)

    # -------------------------------------------------------------------- VM
    def reset_vm(self):
        self.fos = FakeOS(self.root)
        self.modules = {}
        board = self

        class Out:
            def write(self_, s):
                s = s if isinstance(s, str) else bytes(s).decode("utf8", "replace")
                board.tx(s.replace("\r\n", "\n").replace("\n", "\r\n"))
                return len(s)
            def flush(self_): pass
        self.out = Out()

        def fake_print(*a, sep=" ", end="\n", file=None, flush=False):
            (file or self.out).write(sep.join(str(x) for x in a) + end)

        def fake_open(p, mode="r", *a, **k):
            if not isinstance(p, int):
                p = str(self.fos._p(p))
            return builtins.open(p, mode, *a, **k)

        def fake_import(name, g=None, l=None, fromlist=(), level=0):
            return self.do_import(name, fromlist)

        b = dict(vars(builtins))
        b.update(print=fake_print, open=fake_open, __import__=fake_import)
        self.ns = {"__name__": "__main__", "__builtins__": b}
        t = time
        self.shims = {
            "os": self.fos, "uos": self.fos,
            "sys": types.SimpleNamespace(
                implementation=types.SimpleNamespace(name="micropython", version=(1, 29, 0)),
                platform="esp32", path=["", "/lib"], modules=self.modules, stdout=self.out,
                stderr=self.out, version="3.4.0; MicroPython v1.29.0-fake", byteorder="little",
                exit=lambda *a: (_ for _ in ()).throw(SoftReset())),
            "time": types.SimpleNamespace(
                sleep=t.sleep, sleep_ms=lambda m: t.sleep(m / 1000), time=t.time,
                ticks_ms=lambda: int(t.monotonic() * 1000) & 0x3FFFFFFF,
                ticks_diff=lambda a, b: a - b),
            "machine": types.SimpleNamespace(
                reset=lambda: (_ for _ in ()).throw(SoftReset()),
                soft_reset=lambda: (_ for _ in ()).throw(SoftReset()),
                unique_id=lambda: b"\xde\xad\xbe\xef\x00\x01", freq=lambda *a: 240000000,
                Pin=type("Pin", (), {"OUT": 1, "IN": 0, "__init__": lambda s, *a, **k: None,
                                     "value": lambda s, v=None: 0, "on": lambda s: None,
                                     "off": lambda s: None})),
            "micropython": types.SimpleNamespace(const=lambda x: x, opt_level=lambda *a: 0,
                                                 mem_info=lambda *a: None),
            "gc": types.SimpleNamespace(collect=lambda: None, mem_free=lambda: 100000,
                                        mem_alloc=lambda: 50000),
            "ubinascii": __import__("binascii"), "ujson": json, "uhashlib": __import__("hashlib"),
        }

    def do_import(self, name, fromlist):
        top = name.split(".")[0]
        if name in self.shims or top in self.shims:
            mod = self.shims.get(name) or self.shims[top]
            return mod
        if name in self.modules:
            return self.modules[name]
        for cand in (name.replace(".", "/") + ".py", name.replace(".", "/") + "/__init__.py",
                     "lib/" + name.replace(".", "/") + ".py"):
            p = self.fos._p("/" + cand)
            if p.is_file():
                m = types.ModuleType(name)
                m.__dict__["__builtins__"] = self.ns["__builtins__"]
                m.__file__ = cand
                self.modules[name] = m
                try:
                    exec(compile(p.read_text(), cand, "exec"), m.__dict__)
                except BaseException:
                    self.modules.pop(name, None)
                    raise
                return m
        return __import__(name)  # stdlib fallback (json, struct, hashlib, binascii, ...)

    def fmt_exc(self):
        et, ev, tb = sys.exc_info()
        lines = ["Traceback (most recent call last):\n"]
        for fr in traceback.extract_tb(tb):
            if fr.filename.startswith("<") or not fr.filename.startswith(("/", "C:")) or str(self.root) in fr.filename:
                lines.append('  File "%s", line %d, in %s\n' % (fr.filename, fr.lineno, fr.name))
        if et is KeyboardInterrupt:
            msg = "KeyboardInterrupt: "
        elif isinstance(ev, OSError) and ev.errno:
            msg = "OSError: [Errno %d] %s" % (ev.errno, _errno.errorcode.get(ev.errno, "?"))
        elif et is NameError:
            msg = "NameError: " + str(ev).replace("name '", "name '").replace("' is not defined", "' isn't defined")
        else:
            msg = "%s: %s" % (et.__name__, ev)
        return "".join(lines) + msg + "\n"

    def run(self, src, filename="<stdin>", eval_print=False):
        """Run source; returns (ok, traceback_text, soft_reset_requested)."""
        try:
            if eval_print:
                try:
                    code = compile(src, filename, "eval")
                except SyntaxError:
                    code = compile(src, filename, "exec"); eval_print = False
                r = eval(code, self.ns)
                if eval_print and r is not None:
                    self.out.write(repr(r) + "\n")
            else:
                exec(compile(src, filename, "exec"), self.ns)
            return True, "", False
        except SoftReset:
            return True, "", True
        except BaseException:
            return False, self.fmt_exc(), False

    def spawn(self, fn):
        self.running = True                  # set synchronously: no window where input is mis-routed
        def target():
            me = threading.current_thread()
            self.worker = me
            try:
                fn()
            finally:
                self.running = False
                if self.worker is me:
                    self.worker = None
        threading.Thread(target=target, daemon=True).start()

    def interrupt_worker(self):
        w = self.worker
        if w and w.ident:
            ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(w.ident), ctypes.py_object(KeyboardInterrupt))

    # ------------------------------------------------------------- lifecycle
    def boot(self, announce=True):
        if threading.current_thread() is self.worker:
            return self._boot(announce)      # already off the input thread
        self.spawn(lambda: self._boot(announce))

    def _boot(self, announce=True):
        """Soft reboot: fresh VM, boot.py, then main.py (friendly REPL only)."""
        self.reset_vm()
        if announce:
            self.tx("MPY: soft reboot\r\n")
        for fn in ("boot.py",) + (("main.py",) if self.mode == "friendly" else ()):
            p = self.root / fn
            if p.is_file():
                ok, tb, sr = self.run(p.read_text(), fn)
                if not ok:
                    self.tx(tb.replace("\n", "\r\n"))
        self.running = False                 # release the input gate BEFORE the host can see the prompt
        if self.mode == "friendly":
            self.tx(BANNER + b">>> ")
        else:
            self.tx(b"raw REPL; CTRL-B to exit\r\n>")

    # ----------------------------------------------------------------- input
    def feed(self, data):
        for c in data:
            if self.running and self.paste is None:
                # a program is running: only Ctrl-C matters
                if c == CTRL_C:
                    self.ev("interrupt")
                    self.interrupt_worker()
                continue
            (self.raw_byte if self.mode == "raw" else self.friendly_byte)(c)

    def finish_raw(self, src):
        def go():
            ok, tb, sr = self.run(src.decode("utf8", "replace"))
            self.tx(b"\x04" + (tb.replace("\n", "\r\n").encode() if not ok else b"") + b"\x04")
            if sr:
                self.boot()
            else:
                self.running = False
                self.tx(b">")
        self.spawn(go)

    def raw_byte(self, c):
        if self.paste is not None:
            p = self.paste
            if c == CTRL_D:
                self.tx(b"\x04")
                src, self.paste = bytes(p["buf"]), None
                self.ev("exec", n=len(src), paste=True)
                return self.finish_raw(src)
            p["buf"].append(c)
            p["remain"] -= 1
            if p["remain"] == 0:
                self.tx(b"\x01")
                p["remain"] = p["win"]
            return
        if c == CTRL_A:
            if bytes(self.line) == b"\x05A":
                win = 128
                self.tx(b"R\x01" + bytes([win & 255, win >> 8, 1]))
                self.paste = {"buf": bytearray(), "win": win, "remain": win}
                self.line.clear()
            else:
                self.line.clear(); self.tx(b"raw REPL; CTRL-B to exit\r\n>")
        elif c == CTRL_B:
            self.mode = "friendly"; self.line.clear()
            self.tx(b"\r\n" + BANNER + b">>> ")
        elif c == CTRL_C:
            self.line.clear()
        elif c == CTRL_D:
            src, self.line = bytes(self.line), bytearray()
            self.tx(b"OK")
            if not src:
                self.ev("softreset")
                self.tx(b"\r\n"); self.boot()
            else:
                self.ev("exec", n=len(src), paste=False)
                self.finish_raw(src)
        else:
            self.line.append(c)

    def friendly_byte(self, c):
        if c == CTRL_A:
            self.mode = "raw"; self.line.clear(); self.cont = []
            self.tx(b"\r\nraw REPL; CTRL-B to exit\r\n>")
        elif c == CTRL_B:
            self.tx(b"\r\n" + BANNER + b">>> ")
        elif c == CTRL_C:
            self.line.clear(); self.cont = []; self.tx(b"\r\n>>> ")
        elif c == CTRL_D:
            self.ev("softreset"); self.tx(b"\r\n"); self.boot()
        elif c in (8, 127):
            if self.line:
                self.line.pop(); self.tx(b"\x08 \x08")
        elif c in (13, 10):
            text = self.line.decode("utf8", "replace"); self.line.clear(); self.tx(b"\r\n")
            self.cont.append(text)
            src = "\n".join(self.cont)
            try:
                incomplete = codeop.compile_command(src + "\n", "<stdin>", "exec") is None and text.strip() != ""
            except SyntaxError:
                incomplete = False
            if incomplete:
                self.tx(b"... "); return
            self.cont = []
            if not src.strip():
                self.tx(b">>> "); return
            def go():
                ok, tb, sr = self.run(src + ("\n" if "\n" in src else ""), eval_print="\n" not in src)
                if not ok:
                    self.tx(tb.replace("\n", "\r\n"))
                if sr:
                    self.boot()
                else:
                    self.running = False
                    self.tx(b">>> ")
            self.spawn(go)
        elif c >= 32:
            self.line.append(c); self.tx(bytes([c]))


BAUD = 0


def serve(args):
    global BAUD
    BAUD = args.baud
    t0 = time.time()
    logf = open(args.log, "a", buffering=1) if args.log else None

    def log(kind, **kw):
        if logf:
            logf.write(json.dumps({"t": round(time.time() - t0, 3), "ev": kind, **kw}) + "\n")

    def listen():
        s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", listen.port)); s.listen(1); listen.port = s.getsockname()[1]
        return s
    listen.port = args.port
    srv = listen()
    print("LISTENING socket://127.0.0.1:%d" % listen.port, flush=True)
    boot_state = {"first": True}
    while True:
        conn, _ = srv.accept()
        if args.exclusive:
            srv.close()                      # port is 'locked' while a client holds it
        log("connect")
        board = Board(args.root, conn, log)
        # ESP32 behaviour: on open (DTR/RTS toggle) many boards reset; we model a plain open
        # as 'no reset' and just leave whatever the VM was doing (nothing) running.
        if args.run_main_on_connect and boot_state["first"]:
            board.boot(announce=False)
        boot_state["first"] = False
        try:
            while board.alive:
                data = conn.recv(4096)
                if not data:
                    break
                if BAUD:
                    time.sleep(len(data) * 10.0 / BAUD)
                board.feed(data)
        except OSError:
            pass
        finally:
            board.alive = False
            board.interrupt_worker()
            conn.close()
            log("disconnect")
            if args.exclusive:
                srv = listen()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--exclusive", action="store_true")
    ap.add_argument("--log")
    ap.add_argument("--baud", type=int, default=0, help="throttle both directions to this UART speed (0 = unlimited)")
    ap.add_argument("--run-main-on-connect", action="store_true",
                    help="run boot.py+main.py once at first connect (simulates a board that powered up with a main.py loop)")
    serve(ap.parse_args())
```

## Appendix B - `bridge_proto.py` (prototype of architecture C using vendored mpremote `SerialTransport`; C2 would replace the `SerialTransport` calls)

Needs `vendor/` next to it containing the extracted wheels (`serial/`, `mpremote/`). The device-side manifest snippet is also the L0 example (run it with a real `micropython`).

```python
#!/usr/bin/env python3
"""bridge_proto.py - proof-of-concept for architecture option C.

A long-lived helper that OWNS the serial port (via mpremote's SerialTransport, so it
inherits mpremote's DTR/RTS and Windows CP210x quirks), speaks JSON lines on
stdin/stdout, and can multiplex file operations with an interactive REPL byte stream
without ever closing the port.

stdin  (one JSON object per line):  {"id":1,"op":"connect","port":"socket://127.0.0.1:1234"}
stdout (one JSON object per line):  {"id":1,"ok":true,...}  |  {"ev":"repl","b64":"..."}
Ops: connect, close, ls, manifest, put, get, rm, run, interrupt, repl_open, repl_close, repl_write
"""
import base64, hashlib, json, os, sys, threading, time, traceback
sys.path.insert(0, os.environ.get('MPY_VENDOR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor'))
# Reserve the real stdout for the protocol; anything mpremote print()s (it does, e.g. on
# "could not enter raw repl") goes to stderr instead of corrupting the JSON-lines stream.
_PROTO = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8", newline="\n")
os.dup2(2, 1)
sys.stdout = sys.stderr
from mpremote.transport_serial import SerialTransport
from mpremote.transport import TransportExecError

MANIFEST_SRC = r'''
import os, hashlib, binascii
def walk(d, out):
    for n, t, *_ in os.ilistdir(d):
        p = (d.rstrip("/") + "/" + n)
        if t & 0x4000:
            out.append((p, 1, 0, "")); walk(p, out)
        else:
            h = hashlib.sha256()
            with open(p, "rb") as f:
                while True:
                    b = f.read(512)
                    if not b: break
                    h.update(b)
            out.append((p, 0, os.stat(p)[6], binascii.hexlify(h.digest()).decode()))
r = []; walk("%s", r); print(repr(r))
'''


class Bridge:
    def __init__(self):
        self.t = None
        self.lock = threading.RLock()       # who may touch the serial port right now
        self.repl = False
        self.out_lock = threading.Lock()
        self.pump_thread = None

    def emit(self, obj):
        with self.out_lock:
            _PROTO.write(json.dumps(obj) + "\n"); _PROTO.flush()

    # ------------------------------------------------------------ port access
    def raw(self):
        """Context manager: take the port, enter raw REPL WITHOUT soft reset, give it back."""
        bridge = self

        class Ctx:
            def __enter__(s):
                bridge.lock.acquire()
                if bridge.repl:
                    time.sleep(0.05)                  # let the pump drain what is in flight
                bridge.t.enter_raw_repl(soft_reset=False)
                return bridge.t
            def __exit__(s, *a):
                try:
                    if bridge.repl:
                        bridge.t.exit_raw_repl()      # back to the friendly REPL the user is looking at
                        # swallow the banner the board prints on Ctrl-B, up to the next prompt
                        bridge.t.read_until(1, b">>> ", timeout=1.0)
                        bridge.t.serial.write(b"\r")  # redraw a fresh prompt for the user
                finally:
                    bridge.lock.release()
        return Ctx()

    def pump(self):
        """Forward REPL bytes from the board to the extension while REPL mode is on."""
        while self.repl:
            with self.lock:
                if not self.repl:
                    break
                n = self.t.serial.inWaiting()
                data = self.t.serial.read(n) if n else b""
            if data:
                self.emit({"ev": "repl", "b64": base64.b64encode(data).decode()})
            else:
                time.sleep(0.01)

    # -------------------------------------------------------------------- ops
    def handle(self, m):
        op = m["op"]
        if op == "connect":
            self.t = SerialTransport(m["port"], baudrate=115200)
            return {"mode": "idle"}
        if op == "close":
            self.repl = False
            self.t.close(); self.t = None
            return {}
        if op == "ls":
            with self.raw() as t:
                return {"entries": [[e.name, bool(e.st_mode & 0x4000), e.st_size] for e in t.fs_listdir(m["path"])]}
        if op == "manifest":
            with self.raw() as t:
                return {"files": eval(t.exec(MANIFEST_SRC % m.get("path", "/")).decode())}
        if op == "put":
            with open(m["local"], "rb") as f:
                data = f.read()
            with self.raw() as t:
                d = os.path.dirname(m["remote"].rstrip("/"))
                parts = [p for p in d.split("/") if p]
                for i in range(1, len(parts) + 1):          # mkdir -p, in the same session
                    try:
                        t.fs_mkdir("/" + "/".join(parts[:i]))
                    except OSError:
                        pass
                t.fs_writefile(m["remote"], data, chunk_size=m.get("chunk", 1024))
            return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        if op == "get":
            with self.raw() as t:
                data = bytes(t.fs_readfile(m["remote"]))
            with open(m["local"], "wb") as f:
                f.write(data)
            return {"bytes": len(data)}
        if op == "rm":
            with self.raw() as t:
                t.fs_rmfile(m["path"])
            return {}
        if op == "run":
            # soft reset first (fresh VM like `mpremote run`), then stream output as events
            with self.lock:
                self.t.enter_raw_repl(soft_reset=m.get("reset", True))
                src = open(m["local"], "rb").read()
                self.t.exec_raw_no_follow(src)
                def consume(b):
                    self.emit({"ev": "out", "b64": base64.b64encode(b).decode()})
                try:
                    out, err = self.t.follow(timeout=m.get("timeout", 60), data_consumer=consume)
                except Exception as e:
                    return {"error": str(e)}
                finally:
                    if self.repl:
                        self.t.exit_raw_repl()
                return {"stderr": err.decode(errors="replace")}
        if op == "interrupt":
            self.t.serial.write(b"\r\x03\x03")          # no lock on purpose: must pre-empt
            return {}
        if op == "repl_open":
            with self.lock:
                self.t.serial.write(b"\r\x03\x03")
                time.sleep(0.05)
                self.t.serial.write(b"\r\x02")           # friendly REPL
                self.repl = True
            self.pump_thread = threading.Thread(target=self.pump, daemon=True)
            self.pump_thread.start()
            return {"mode": "repl"}
        if op == "repl_close":
            self.repl = False
            return {"mode": "idle"}
        if op == "repl_write":
            with self.lock:
                self.t.serial.write(base64.b64decode(m["b64"]))
            return {}
        raise ValueError("unknown op " + op)

    def serve(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            m = json.loads(line)
            if m["op"] in ("interrupt", "repl_write"):     # never queue behind a long op
                threading.Thread(target=self.dispatch, args=(m,), daemon=True).start()
            else:
                self.dispatch(m)

    def dispatch(self, m):
        try:
            r = self.handle(m)
            self.emit({"id": m.get("id"), "ok": True, **r})
        except TransportExecError as e:
            self.emit({"id": m.get("id"), "ok": False, "error": e.error_output.strip().splitlines()[-1]})
        except Exception as e:
            self.emit({"id": m.get("id"), "ok": False, "error": "%s: %s" % (type(e).__name__, e),
                       "tb": traceback.format_exc()})


if __name__ == "__main__":
    Bridge().serve()
```

## Appendix C - `drive_bridge.py` (stand-in for the extension; the scenario list behind section 8.2)

```python
#!/usr/bin/env python3
"""Stand-in for the VS Code extension: drives bridge_proto.py over JSON lines and
checks the behaviours that the stateless design cannot provide."""
import base64, json, os, queue, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
url = sys.argv[1]
proc = subprocess.Popen([os.environ.get("BRIDGE_PY", sys.executable)] + os.environ.get("BRIDGE_FLAGS", "").split() + [os.path.join(HERE, "bridge_proto.py")],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
replies, events = {}, queue.Queue()
nid = [0]

def reader():
    for line in proc.stdout:
        m = json.loads(line)
        if "ev" in m:
            events.put(m)
        else:
            replies[m["id"]] = m

threading.Thread(target=reader, daemon=True).start()

def call(op, timeout=30, **kw):
    nid[0] += 1
    i = nid[0]
    proc.stdin.write(json.dumps({"id": i, "op": op, **kw}) + "\n"); proc.stdin.flush()
    t0 = time.time()
    while i not in replies:
        if time.time() - t0 > timeout:
            raise TimeoutError(op)
        time.sleep(0.005)
    r = replies.pop(i)
    if not r.get("ok"):
        raise RuntimeError("%s failed: %s" % (op, r))
    return r

def drain(until=None, timeout=3.0):
    buf = b""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            e = events.get(timeout=0.05)
        except queue.Empty:
            if until is not None and until in buf:
                break
            continue
        buf += base64.b64decode(e["b64"])
        if until is not None and until in buf:
            break
    return buf

print("connect:", call("connect", port=url))

# 1) 20-file upload + manifest in ONE port session
many = os.path.join(HERE, "many")
t0 = time.time()
for n in sorted(os.listdir(many)):
    call("put", local=os.path.join(many, n), remote="/proj2/" + n)
t_up = time.time() - t0
man = call("manifest", path="/proj2")["files"]
print("uploaded %d files in %.2fs via bridge; manifest entries=%d first=%s" % (len(os.listdir(many)), t_up, len(man), man[0]))

# 2) run a script, streaming events, no REPL open
open(os.path.join(HERE, "loop.py"), "w").write("import time\nfor i in range(3):\n    print('tick', i)\n    time.sleep(0.05)\n")
r = call("run", local=os.path.join(HERE, "loop.py"))
print("run stderr:", repr(r["stderr"]), "| output events:", drain(until=b"tick 2", timeout=2).decode().replace("\r\n", "|"))

# 3) open the REPL, type something, then do FILE OPS WHILE THE REPL IS OPEN, REPL state must survive
call("repl_open")
time.sleep(0.2); drain(timeout=0.5)
call("repl_write", b64=base64.b64encode(b"keepme = 123\r").decode())
print("repl echo 1:", drain(until=b">>> ", timeout=1.5).decode().replace("\r\n", "|"))
t0 = time.time()
ls = call("ls", path="/proj2")
print("ls while REPL open -> %d entries in %.2fs" % (len(ls["entries"]), time.time() - t0))
call("put", local=os.path.join(many, "f1.py"), remote="/while_repl_open.py")
drain(timeout=0.3)
call("repl_write", b64=base64.b64encode(b"keepme + 1\r").decode())
out = drain(until=b"124", timeout=2).decode().replace("\r\n", "|")
print("repl after file ops (state preserved -> expect 124):", out)

# 4) interrupt a long loop typed into the REPL
call("repl_write", b64=base64.b64encode(b"while True: pass\r").decode())
time.sleep(0.2)
t0 = time.time()
call("interrupt")
out = drain(until=b"KeyboardInterrupt", timeout=2).decode().replace("\r\n", "|")
print("interrupt (%.2fs):" % (time.time() - t0), out[-120:])
call("repl_close"); call("close")
proc.stdin.close(); proc.wait(timeout=5)
print("done")
```

## Appendix D - benchmark scripts (section 2.3)

`mp.sh` (connect helper), `bench.sh BAUD BOOT_SLEEP` and `bench_bridge.py`:

```bash
#!/bin/bash
# usage: mp.sh <args...>   (connects to the URL in fb.out)
cd "$(dirname "$0")"
URL=$(sed -n 's/LISTENING //p' ${FBOUT:-fb.out})
exec ./venv/bin/mpremote connect "$URL" "$@"
```

```bash
#!/bin/bash
# usage: bench.sh BAUD BOOT_SLEEP_SECONDS
cd "$(dirname "$0")"
BAUD=$1; BOOT=$2
[ -f fb.pid ] && kill $(cat fb.pid) 2>/dev/null; sleep 0.3
rm -rf bench_root && mkdir bench_root
[ "$BOOT" != "0" ] && printf 'import time\ntime.sleep(%s)\nprint("boot.py done")\n' "$BOOT" > bench_root/boot.py
: > bench.log
./venv/bin/python fakeboard.py --root bench_root --baud $BAUD --log bench.log > bench.out 2>&1 &
echo $! > fb.pid
sleep 0.7
export FBOUT=bench.out
URL=$(sed -n 's/LISTENING //p' bench.out)
t() { local s=$(python3 -c 'import time;print(time.time())'); "$@" >/dev/null 2>&1; python3 -c "import time;print('%.1f' % (time.time()-$s))"; }
echo "baud=$BAUD boot.py sleep=${BOOT}s, 20 files / 42.7 KB"
./mp.sh fs mkdir :/s1 >/dev/null 2>&1; ./mp.sh fs mkdir :/s2 >/dev/null 2>&1; ./mp.sh fs mkdir :/s3 >/dev/null 2>&1
s1() { for i in $(seq 1 20); do ./mp.sh fs mkdir -p :/s1 >/dev/null 2>&1; ./mp.sh fs cp -f many2/m$i.py :/s1/m$i.py >/dev/null 2>&1; done; }
s2() { for i in $(seq 1 20); do ./mp.sh fs cp -f many2/m$i.py :/s2/m$i.py >/dev/null 2>&1; done; }
s3() { ./mp.sh fs cp -f $(ls many2/*.py | tr '\n' ' ') :/s3/ >/dev/null 2>&1; }
s4() { ./venv/bin/python bench_bridge.py "$URL" >/dev/null 2>&1; }
echo "  S1 old-extension pattern (2 processes/file: fs mkdir -p [opens the port, then argparse rejects -p; no soft reset] + fs cp -f): $(t s1) s"
echo "  S2 stateless best case (1 process/file): $(t s2) s"
echo "  S3 one mpremote process for all 20 files: $(t s3) s"
echo "  S4 bridge session (1 port open, 20 puts): $(t s4) s"
echo "  port opens: $(grep -c '"connect"' bench.log)   soft resets: $(grep -c '"softreset"' bench.log)"
kill $(cat fb.pid) 2>/dev/null
```

```python
import json, os, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
url = sys.argv[1]
p = subprocess.Popen([sys.executable, os.path.join(HERE, "bridge_proto.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
def call(**m):
    p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()
    while True:
        r = json.loads(p.stdout.readline())
        if "ev" not in r:
            assert r["ok"], r
            return r
call(op="connect", port=url)
for n in sorted(os.listdir(os.path.join(HERE, "many2"))):
    call(op="put", local=os.path.join(HERE, "many2", n), remote="/s4/" + n, chunk=1024)
call(op="close"); p.stdin.close(); p.wait()
```

## Appendix E - real MicroPython without hardware

`build_mpy.sh` (about 2 minutes; Xcode clang; result `ports/unix/build-standard/micropython`, 460 KB):

```bash
#!/bin/bash
set -x
cd "$(dirname "$0")"
if [ ! -d micropython ]; then
  git clone --depth 1 --branch v1.29.0 https://github.com/micropython/micropython micropython || git clone --depth 1 https://github.com/micropython/micropython micropython
fi
cd micropython
make -C mpy-cross -j4 2>&1 | tail -5
make -C ports/unix submodules 2>&1 | tail -5
make -C ports/unix -j4 MICROPY_PY_FFI=0 MICROPY_PY_BTREE=0 MICROPY_PY_SSL=0 2>&1 | tail -15
ls -la ports/unix/build-standard/micropython
```

`mpunix_relay.py` (POSIX only; TCP to the unix VM on a pty; use real mpremote in `resume` mode against it):

```python
#!/usr/bin/env python3
"""mpunix_relay.py - expose the REAL MicroPython unix port (REPL on a pty) as socket://127.0.0.1:PORT.
POSIX only (pty). Used to validate the protocol assumptions of the fake board against real
MicroPython REPL code (shared/runtime/pyexec.c). Usage: mpunix_relay.py MICROPYTHON_BIN CWD"""
import os, pty, select, socket, subprocess, sys, termios, tty

mp_bin, cwd = sys.argv[1], sys.argv[2]
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", 0)); srv.listen(1)
print("LISTENING socket://127.0.0.1:%d" % srv.getsockname()[1], flush=True)
while True:
    conn, _ = srv.accept()
    master, slave = pty.openpty()
    tty.setraw(slave)  # no ONLCR/echo from the line discipline; MicroPython does its own cooking
    proc = subprocess.Popen([mp_bin], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, close_fds=True)
    os.close(slave)
    try:
        while True:
            r, _, _ = select.select([master, conn], [], [], 0.5)
            if master in r:
                try:
                    d = os.read(master, 4096)
                except OSError:
                    break
                if not d:
                    break
                conn.sendall(d)
            if conn in r:
                d = conn.recv(4096)
                if not d:
                    break
                os.write(master, d)
            if proc.poll() is not None and master not in r:
                break
    finally:
        proc.kill(); proc.wait(); os.close(master); conn.close()
```

L0 example (device-side snippet under the real VM, relative root):

```bash
cd many && ../micropython/ports/unix/build-standard/micropython ../manifest_dev.py | head -c 300
shasum -a 256 f1.py   # equals the sha256 printed for ./f1.py
```

WASM VM under Node (no compiler needed; raw-paste is not supported by its REPL API):

```bash
npm i @micropython/micropython-webassembly-pyscript@1.29.0-6   # local install, in a scratch dir
node t.mjs   # loadMicroPython({stdout, linebuffer:true}); mp.runPython('import hashlib, os ...')
```

## Appendix F - reproductions of defects in the old code (all run without a board)

`validate_repro.js` - old `validatePythonPath()` (pythonInterpreter.ts:229-249) against a venv interpreter that does have mpremote:

```javascript
// Replicates pythonInterpreter.ts validatePythonPath (lines 229-249) verbatim in JS.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
async function validatePythonPath(pythonPath) {
  try {
    await execFileAsync(pythonPath, ['-c', 'import sys; print(sys.version)'], { timeout: 5000 });
    await execFileAsync('mpremote', ['--version'], { timeout: 5000 });   // <-- line 235: GLOBAL mpremote, not `${pythonPath} -m mpremote`
    return { valid: true, missingMpremote: false };
  } catch (error) {
    const m = error.message || String(error);
    if (m.includes('mpremote') && (m.includes('not found') || m.includes('command not found')))
      return { valid: false, missingMpremote: true, error: m };
    return { valid: false, missingMpremote: false, error: m };
  }
}
(async () => {
  const venvPy = process.argv[2];
  console.log('PATH has mpremote?', require('child_process').spawnSync('which', ['mpremote']).status === 0);
  console.log('venv python can run mpremote?', require('child_process').spawnSync(venvPy, ['-m', 'mpremote', '--version']).stdout.toString().trim());
  console.log('validatePythonPath(venvPython) =>', JSON.stringify(await validatePythonPath(venvPy)));
  console.log('fallback "py -3" => ', JSON.stringify(await validatePythonPath('py -3')).slice(0, 120));
})();
```

Result with `node validate_repro.js <venv>/bin/python`: `PATH has mpremote? false`, `venv python can run mpremote? mpremote 1.29.0`, `validatePythonPath(venvPython) => {"valid":false,"missingMpremote":false,"error":"spawn mpremote ENOENT"}`, `"py -3" => ... spawn py -3 ENOENT`.

The old per-port mutex (mpremote.ts:29-128 extracted verbatim into `cm.ts`; call order of lines 163-167):

```typescript
import { ConnectionManager } from "./cm";
const cm = new ConnectionManager();
const port = "/dev/cu.usbserial-0001";   // only a Map key; nothing is opened
// Replicates the exact call order in runMpremote (mpremote.ts:152-168)
console.log("busy before op A:", cm.isOperationInProgress(port));
cm.getConnection(port);                 // :163
cm.markOperationStarted(port);          // :165
cm.markHealthy(port);                   // :167
console.log("busy right after op A started (expect true if mutex works):", cm.isOperationInProgress(port));
cm.stop();
```

Result: `busy before op A: false`, then `busy right after op A started (expect true if mutex works): false`. Compile with the old repo's `node_modules/.bin/tsc` from a scratch copy.

Interrupt command (mpremoteCommands.ts:392,453,485) and Windows separator regex (extension.ts:904,911). Run these against a regular file, never a serial port:

```bash
cat > echo_probe.js <<'EOF'
const { exec } = require('child_process'), fs = require('fs');
const target = process.argv[2];   // a regular file
exec("echo -e '\\x03\\x03' > " + target, () => console.log(fs.readFileSync(target).toString('hex')));  // same string as the old code
EOF
node echo_probe.js /tmp/probe.bin     # macOS /bin/sh prints: 2d652003030a  i.e. 2d 65 20 03 03 0a ("-e " + Ctrl-C Ctrl-C + LF)

cat > sep_probe.js <<'EOF'
const rel = "sub\\dir\\file.py";            // what path.relative() returns on Windows
console.log("/" + rel.replace(/\\\\/g, "/")); // extension.ts:904,911 -> /sub\dir\file.py (unchanged)
console.log("/" + rel.replace(/\\/g, "/"));   // extension.ts:1111   -> /sub/dir/file.py
EOF
node sep_probe.js
```

## Appendix G - scenario catalogue for the bridge/fake-board test suite (seed for `plan.md`)

1. Connect / disconnect / reconnect; a 20-operation session opens the port exactly once (assert on the fake board's event log).
2. `hello` handshake and protocol-version mismatch; unknown op returns an error object, never crashes the bridge.
3. `fs.list`: empty root, nested dirs, unicode names, names with spaces, quotes and `=`; sizes correct.
4. `fs.manifest`: sha256 equals the host's for empty, text, binary and 100 KB files; one round trip for the whole tree.
5. `fs.put`: parent directories created level by level; write to a temporary name then rename; hash verified; read-only filesystem -> `E_FS_ERRNO`.
6. `fs.get` round trip preserves CRLF and non-UTF-8 bytes.
7. `fs.rm`, `fs.rmtree`, `fs.mv`, `fs.mkdir` with parents.
8. `run`: streamed stdout; traceback with the local path mapped back; `__name__ == "__main__"`; infinite loop + `stop`; a program that swallows `KeyboardInterrupt` (stop escalates); blocking `input()`.
9. REPL attached: file operations while attached; REPL variable survives; typed input during a raw operation is buffered, not lost or interleaved.
10. `stop` twice; `stop` when idle; escalation to `reset.hard`.
11. Soft reset: `boot.py` output visible; `main.py` not run from raw mode; Ctrl-D from the friendly REPL runs `main.py`.
12. Port busy (`--exclusive`) -> `E_PORT_BUSY` with a useful message; bounded auto-reconnect.
13. Board vanishes mid-upload (close the socket) -> `E_DISCONNECTED`, state `Disconnected`, no hang, no half-written final file.
14. Garbage before the banner; banner delayed by a 3 s `boot.py`; prompt polling instead of fixed sleeps.
15. Silent long-running operation: per-stage timeouts, progress events, cancellation.
16. stdin EOF and SIGTERM terminate the bridge and release the port; extension-side restart policy with back-off.
17. A library `print()` inside the bridge never corrupts the protocol stream (inject one).
18. Python matrix 3.8-3.15; `-I`; a hostile `serial.py` in the working directory; `PYTHONIOENCODING=cp1252` in the environment.
19. 1 MB output flood does not block the pump or the UI; back-pressure works.
20. Multi-byte UTF-8 characters split across reads decode correctly in the pseudoterminal.
21. Differential: the same scenario through vendored mpremote 1.29.0 and through the bridge yields identical file contents and output.
22. `ports.list` JSON shape; VID/PID ranking; `/dev/tty.*` rewritten to `/dev/cu.*`; `COM10` and above handled.
23. Windows-only, mocked serial class: CP210x open sequence (`dtr=False; rts=False; open; dtr=True; rts=True`), close order RTS then DTR.
24. `reset.hard` uses an RTS pulse with DTR low and waits for the prompt (mocked line recorder).

---

## Follow-up: Reconciled decisions and requirements register, citation fixes

Role: follow-up investigator for gap 10 of `10-completeness-critic.md` (section 9). Purpose: one register that `plan.md` and `CLAUDE.md` can be built from without inheriting the contradictions between notes 01-09. Nothing in `mpy-workbench` was modified; no serial port was opened (the only device-adjacent command was the offline `mpremote connect list`/`version`); nothing was installed; scratch work is in `<scratchpad>/reg/`. Line numbers into the old source refer to git HEAD `7cb90c7`; into the firmware repo to `<course firmware repo>` (abbreviated `FW/`).

Evidence tags as in section 1 of this note: **[E]** executed or observed in this pass, **[S]** read from source or installed bundle, **[D]** fetched web page, **[K]** general knowledge, **[I]** inference, **[U]** unverified. Status vocabulary: **DECIDED** (plan.md may encode it as a requirement), **USER INPUT** (cannot be settled by analysis; question listed in F5), **SPIKE** (settled only by a bounded experiment listed in F5). A row can carry two statuses (a decided default plus an open verification).

Contents: F1 new evidence; F2 where this pass disagrees with earlier notes; F3 decisions register (D-01 to D-14); F4 requirements the notes missed (RQ-*); F5 spikes and user questions; F6 citation fixes; F7 seeds for `CLAUDE.md` and `plan.md`; F8 confidence.

### F1. New evidence gathered in this pass

| # | Finding | Tag | Where |
|---|---|---|---|
| N-1 | **The build the user ran is settled** (04 section 2 and 06 section 9 Q1 call it unknown): installed `danielbucam.mpy-workbench-0.3.2/dist/mpremote.js:182` runs bare `mpremote ...` through `exec` with `env: {...process.env}` (`:144-149`). The user's hand edits are `dist/mpremoteCommands.js:50` and `:246` (mtime 12:37:22; `.bak` 12:33:15, `.bak2` 12:35:38, `.bak2` still has the placeholder `/ABSOLUTE/PATH/TO/.venv/bin/python`). **Line 50 points at `~/src/mpy_remote/.venv/bin/python`, a directory that does not exist** (`ls ~/src/mpy_remote` -> ENOENT); line 246 points at `~/src/mpy_test/.venv/bin/python`. Line 50 is inside `restartReplInExistingTerminal`, which `withAutoSuspend` calls after every auto-suspended file operation (`dist/extension.js:258-282`). So after the hack the first explicit "Open REPL" could work for that one project, while the "bring the REPL back after a sidebar operation" path typed a command with a non-existent interpreter. This is a new, concrete contributor to complaint 1b, in addition to the logged `connect === 'auto'` throw (`window5/exthost/exthost.log:343`, from `mpremoteCommands.js:242:15`). | E | installed extension; `ls` |
| N-2 | The installed extension's sidebar still produced `.mpy-workbench/tree-paths.json` (mtime 12:38:39, 2 entries) although no `mpremote` exists on any global PATH (checked `~/.pyenv/shims`, `/usr/local/bin`, `~/.local/bin`, miniforge, PlatformIO penv: only `~/src/mpy_test/.venv/bin/mpremote` and `~/src/micropicotest/env/bin/mpremote` exist). The writer is `populateFileTreeCache` after a successful `mpremote ... fs tree` (`dist/mpremote.js:236-262`). Candidate explanation **H-env** [I]: that window's extension host inherited a PATH containing the activated `.venv/bin` because VS Code was launched from an activated terminal (`code .`); the VS Code FAQ says a CLI launch inherits the shell environment while a Dock/Start-menu launch resolves it from startup files with a 10 s timeout [D]. Refute: reproduce with a Dock launch versus `source .venv/bin/activate; code .`; the original window environments are gone. Consequence either way: bare-`mpremote`-on-PATH behaviour depends on *how VS Code was launched*, which a classroom cannot control. | E+I | `ls`/`find`; `dist/mpremote.js` |
| N-3 | PyPI today: latest stable `mpremote` **1.29.0** (2026-08-24, `Requires-Python >=3.4`); only newer release is `1.30.0rc0.post101` (2026-10-01). The user's `.venv` has 1.29.0; the class firmware submodule is MicroPython **v1.29.0** (`git describe` in `FW/lib/micropython`). | D+E | PyPI JSON; `mpremote version` |
| N-4 | Python Environments extension 1.38.0 (installed): `shouldSkipTerminalActivation(t)` is `!!t.creationOptions?.hideFromUser \|\| !!t.creationOptions?.pty` (`dist/extension.js`, definition near character offset 560.5k, export declaration near 554k), used in `activate()` and `onDidOpenTerminal`; `isTaskTerminal` terminals are also skipped; the fallback wait before typing the activation command is the shell-integration timeout, **5000 ms** when shell integration is enabled (function `g()`), which matches the 4.4-4.5 s lag the critic measured in `Python.log`. Setting `python-envs.terminal.autoActivationType` has default `command` and **scope `machine`**, so a workspace/course-template `settings.json` cannot switch it off. Legacy `ms-python.python` 2026.8.0: `TerminalAutoActivation.activateTerminal` skips only `hideFromUser` terminals, and `shouldEnvExtHandleActivation()` returns true whenever the Envs extension is installed unless `python.useEnvironmentsExtension` is explicitly `false` in user/workspace settings; `python.terminal.activateEnvironment` (default true) has scope `resource`, i.e. a workspace can set it false. | S | bundles under `~/.vscode/extensions` |
| N-5 | Installed Pylance 2026.4.1 `package.json`: `python.analysis.stubPath` default `typings`, `extraPaths` default `[]`, `typeCheckingMode` default `off`, `diagnosticMode` default `openFilesOnly` (all scope `resource`). Pyright docs: "If a pyproject.toml (with a pyright section) or a pyrightconfig.json exists, any pyright settings in a VS Code settings.json will be ignored"; `stubPath` default `./typings`; `extends` is supported [D]. (07 section 3.2 observed per-key replacement rather than total replacement in pyright-langserver 1.1.414; the 07 follow-up F.8 read Pylance's bundled engine and found `extends`, `ignore` and `stubPath` parsed there [R]; Pylance itself has still never been executed.) | S+D | `package.json`; pyright `configuration.md`; `07-linting-stubs.md:1605-1616` |
| N-6 | Bridge prototype (Appendix B) + fake board (Appendix A) with **only vendored wheels** under **Apple's `/usr/bin/python3` 3.9.6** started as `-I -u -X utf8`: connect, 20-file upload (1.65 s), sha256 manifest, `run` with streamed output, REPL attach, `ls` with REPL open (0.12 s), REPL variable preserved (`keepme + 1` -> `124`), interrupt (20 ms) all pass; the fake board log shows the single connect/disconnect. `ast.parse(feature_version=(3,8))` accepts all 40 files (bridge, vendored `mpremote`, `serial`) - syntax only, no 3.8 interpreter on this Mac. The 09 text "tested 3.10-3.15" is therefore extended to 3.9. | E | `<scratchpad>/reg/` |
| N-7 | **The real class firmware, quoted** (the critic's 2.2/2.3, re-read and extended): board dir `FW/boards/WSU_SHIELD`; `sys.implementation._build` is the board directory name (`lib/micropython/py/mkrules.cmake:28-35` defines `MICROPY_BOARD_BUILD_NAME`, `py/modsys.c:104-111` exposes it), so `_build == "WSU_SHIELD"`; `MICROPY_HW_BOARD_NAME "WSU Motor Shield"`, `MICROPY_HW_MCU_NAME "ESP32"` (`mpconfigboard.h:4-5`). Frozen `shield` package via `manifest.py:2-5`; private C module `_shield` with `ABI` (`cmodules/shield/mod_shield.c:42-44,574`); `python/shield/__init__.py:16-19` raises `ImportError('... flash the matching WSU_SHIELD firmware')` on ABI mismatch; `shield.info()` prints `_machine`, ABI, `_build`, version, heap (`__init__.py:50-62`). Lifecycle hooks: `MICROPY_PORT_DEINIT_FUNC` parks hardware on every soft reset and `MICROPY_BOARD_AFTER_PYTHON_EXEC` stops motors/servos on an uncaught exception or Ctrl-C (`mpconfigboard.h:38-50`; `CLAUDE.md:140-148`); "Soft reset is constant. mpremote and Thonny soft-reset on every run" (`CLAUDE.md:208`). Hard-reset hazard: GPIO15 (motor 2 IN1) -> "Motor 2 runs at full speed for the whole esptool upload, and for ~0.3 s at every reset. Firmware can't prevent it" (`CLAUDE.md:183-186`; `upy_port.md:1249` R2, "CONFIRMED 2026-09-24", lab rule "VBATT off while flashing/resetting"); GPIO12 HIGH at reset bricks boot (`CLAUDE.md:189`); "Thonny's 'Install MicroPython' installs stock firmware and silently removes `_shield`" (`CLAUDE.md:214`). Firmware repo's own rule for its agents: "Flash or open serial ports only when the user asks in the current session" (`CLAUDE.md:162`). Soft-reset safety under mpremote/Thonny key sequences is **not yet hardware-verified by the firmware project**: its acceptance "100 x Ctrl-D and 100 x `mpremote run` ... leave 0 duty after every reset" is an unchecked item (`upy_port.md:627-629`) and risk R16 is open (`upy_port.md:1263`). Student tooling per the firmware plan: "Students use Thonny or mpremote" (`upy_port.md:37`). | S | `FW/` |
| N-8 | **There is no `.pyi` anywhere in the firmware repo** (`find FW -name '*.pyi'` outside the MicroPython submodule: none) and its plan (`upy_port.md` Phase 9 "Distribution and docs") has no stub or IntelliSense deliverable. The `shield`/`_shield` stubs a student's Pylance needs have no owner yet. (Written before reading the parallel 07 follow-up, which has since produced the pack: see N-12; the ownership gap stands.) | E | `find`, `grep` |
| N-9 | **The course demo needs live keyboard input while it runs**: `~/src/mpy_test/test.py:14-16,51-57` (header "type keys in the terminal -- no Enter needed") uses `select.poll()` on `sys.stdin` and `sys.stdin.read(1)`. mpremote's `run` cannot supply that: `_do_execbuffer` (`mpremote/commands.py:482-497`) sends the buffer and then only reads until the two `\x04` markers; nothing forwards host keystrokes. 02 and 09 treat stdin forwarding as a phase-2 nicety (`02` section 10.7 last bullet); for this course it is a v1 requirement. | S+E | `test.py`; mpremote 1.29.0 source |
| N-10 | The instructor's course projects sit in the **macOS File Provider OneDrive path** `~/Library/CloudStorage/OneDrive-WashingtonStateUniversity(email.wsu.edu)/...` (85 occurrences in the VS Code logs, none opened) - the root component already contains parentheses. The old extension's state is not portable: `~/src/mpy_test/.mpy-workbench/esp32sync.json` stores `"root": "~/src/mpy_test"` and (size, mtime) per file; the user's `.vscode/settings.json` holds the macOS-only `"mpyWorkbench.pythonPath": "${workspaceFolder}/.venv/bin/python"` (a Windows student who receives the same folder gets `.venv\Scripts\python.exe`). | E | logs; `~/src/mpy_test` |
| N-11 | The connected CP2102 enumerates as `/dev/cu.usbserial-0001`, serial number **`0001`**, `10c4:ea60` (offline `mpremote connect list`). `0001` is a generic default shared by many CP210x boards [K], so (VID, PID, serial) cannot identify one board among several in a lab. Board identity for sync state should therefore come from the chip (`machine.unique_id()` in the identity probe), not from USB descriptors. | E+K | `mpremote connect list` |
| N-12 | **Findings imported from the parallel 07 follow-up** (`07-linting-stubs.md:1491-1640`, landed 14:23, read before finalising this register; the executed claims are 07's, tagged [E] there, pyright 1.1.414 not Pylance): the user's `test.py` shows 6 errors / (in Pylance's default `off` mode) 1 warning, and 0 diagnostics after the corrected pipeline (F.2, F.5); the board's `_build` is `WSU_SHIELD` from build artifacts (live value [I], F.0 item 2) and falls back to `micropython-esp32-stubs 1.29.0.post1`; the instructor deliverable is a 29 KB `course-stubs/` folder = **verbatim `shield/*.py` sources + generated `_shield.pyi`** (48/48 names), listed in both `extraPaths` and pyright `ignore`; `.pyi` produced by `pyright --createstub` drops re-exports and breaks `shield.Motor` (10 errors, F.6 rule 1); `extends` + generated environment file + user-owned config worked unchanged (F.7). It also **corrects the critic**: `FW/build/unix/micropython` exists (448,296 bytes, Sep 24) - confirmed here, it runs and reports `_shield` ABI 1, version `2930580-dirty` - so hardware-free tests against the real firmware build are available now. | E (07's runs; unix binary re-run here) | `07-linting-stubs.md` F.0-F.8 |
| N-13 | **`compile()` with a local path gives usable tracebacks on the firmware's own unix build** [E]: `exec(compile(src, '/Users/x/OneDrive (Fall)/lab1/test.py', 'exec'), {'__name__': '__main__'})` prints `File "/Users/x/OneDrive (Fall)/lab1/test.py", line 2, in f` (path with spaces and parentheses intact). On the board `compile` is enabled because the esp32 port sets `MICROPY_CONFIG_ROM_LEVEL_EXTRA_FEATURES` (`lib/micropython/ports/esp32/mpconfigport.h:13-14`) and `py/mpconfig.h:1519-1522` enables `MICROPY_PY_BUILTINS_COMPILE` at that level; `boards/WSU_SHIELD/mpconfigboard.h` does not override it [S]. Not yet run on the board. | E (unix) + S (board) | `FW/build/unix/micropython` |

### F2. Where this pass disagrees with, or narrows, earlier notes

1. **01 RC1 ("every sidebar `exec('mpremote ...')` fails in the installed build"; ranked primary) is superseded.** Still true: the installed build never consults the venv or `mpyWorkbench.pythonPath` (`dist/mpremote.js:182`). Not true as stated: the sidebar did list the board at 12:38:39 (N-2). The decision-relevant statement is "success depends on the extension host's inherited PATH, i.e. on how VS Code was launched". The refutation recipe in `01-discovery.md:143` is no longer needed for planning.
2. **04 section 2 and 06 section 9 Q1 / `06-ext-core.md:170` ("which one the user ran is unknown") are superseded** by N-1 (installed 0.3.2 VSIX plus two hand edits, one of them pointing at a non-existent directory).
3. **"mpremote >= 1.26" is superseded everywhere it appears**: `01-discovery.md:318,365` (`mpremote-too-old`, `pip install "mpremote>=1.26,<2"`), `04-ui-inventory.md:378,540` (the old code's `<1.26` check and the proposed pin). `06-ext-core.md` contains no `1.26` string (the critic's list over-attributes it; grep over 06 finds none). See D-08.
4. **01 section 5 (resolver built around the Python extension's API, Envs extension "secondary") is wrong for this user.** `shouldEnvExtHandleActivation()` makes the Envs extension primary for activation whenever it is installed (N-4), consistent with the Python.log line the critic found. The interpreter resolver must try the Envs API first (D-13).
5. **09 section 4.4 item 2 ("the course already requires Python") is an assumption, not evidence.** The only course-side statement is "Students use Thonny or mpremote" (`upy_port.md:37`); Thonny bundles its own Python [K] and Pylance does not need a system interpreter for typeshed-based checking [I]. It stays as the main open question (Q-01) and the reason D-02 is "provisional C".
6. **09 section 0.2 "any Python >= 3.8 will do (tested 3.10-3.15)" is narrowed** to a floor of 3.9 (tested 3.9.6 and 3.10-3.15; 3.8 is grammar-compatible only). See D-09.
7. **02 section 10.5/09 section 5.2 "Hardware reset" button, and any reset-on-connect behaviour, were specified without a safety rule.** On this board a hardware reset spins motor 2 (N-7). Superseded by RQ-SAFE-1 to RQ-SAFE-3. 02 section 10.6 step 6 (`freshStart` soft reset on every Run) is *consistent* with the firmware and stays.
8. **The critic's claim "04 section 10 shows `typings/` is not in the default ignore list, so 04/09's layout would upload stubs" is half right.** The *old* default list lacks it (`sync.ts:73-85`; also `07-linting-stubs.md:111-113`), but 04's own acceptance matrix row 22 (`04-ui-inventory.md:623`) and 07 section 9.2 (`07-linting-stubs.md:564`) both require adding `typings/`; only 09 section 5.6 is silent. The conflict that remained was the *location* of generated stubs; D-05 settles it in favour of 07's layout because the 07 follow-up showed the course pack needs a config file anyway.
9. **The `typings/`-first layout of 04/09 (zero configuration) is superseded by 07's hidden stubs + generated config + `extends`, because of the 07 follow-up evidence** (D-05): the real firmware needs `extraPaths` and `ignore` for `course-stubs/`, and the chain was verified end-to-end with pyright (Pylance unexecuted). The **"state inside `.mpy-workbench/`" assumption of 03/06/07 is narrowed** (D-06): portable files stay in the project under a differently named dot-directory, board- and machine-specific state moves to `context.storageUri`.
10. **09 M7 and 08 section 1 fact 4 cite `mpremote.ts:1296`** for the `fs stat` call; the call is on line 1294 (F6).

### F3. Decisions register

Each row: what the notes say, the resolution, status, evidence, and what would change it. IDs are stable; `plan.md` items should reference them.

| ID | Topic | Conflicting positions (note and place) | Resolution | Status |
|---|---|---|---|---|
| D-01 | Fix versus rewrite | 01-09 converge on "rewrite the engine, port the shell" (09 section 7; 06 section 4); 10 section 8 notes the effort estimate (5-7 versus 7-11 rounds) is judgement and no M0 hotfix was built | **Rewrite the board-facing engine behind a `Bridge`/`Link` seam; port the shell (three views, command titles, menus, decorations, `.mpyignore`, status bar).** The optional M0 hotfix (09 section 5.8) is built only if a class must start before round 4, and is scored against 04 section 16 as it is built. The 10 section 8 triggers (students have no Python; serial libraries fail on the CP2102 on Windows; reset unsafe; complaint 2 trivial) are tracked as S-01/S-02/Q-01 and may reopen D-02, not D-01 | DECIDED (recommendation; user sign-off at plan review) |
| D-02 | Transport and port owner | 02 section 10.2: Node `serialport` primary (D), Python helper fallback. 09 section 4-5: long-lived Python bridge with vendored pyserial (C) primary. 05 (X-02, section 4.7, XP-05): per-operation `python -I -m mpremote` from vendored wheels plus real terminals. 04/06 (and 01 section 8): mpremote CLI behind a queue plus a `setupEnvironment` that creates a `.venv` and pip-installs mpremote. 03/08: long-lived Python helper | **Invariant (all notes agree): exactly one component ever opens the device; no shell strings (argv arrays only); terminals are views; fake-board-first testing.** **Implementation: C (Python bridge, `python -I -u -X utf8 bridge.py`, vendored pyserial 3.5, in-house `Link` on pyserial as product, vendored mpremote only as oracle and `mip`/`mount` runner) is the default, behind the `Bridge` interface so a Node `serialport` implementation can replace it (09 section 4.4 switch rule).** Rejected as architectures: A/B (per-process mpremote, 04/05/06), and venv-plus-pip provisioning (04 `setupEnvironment`, 01 section 8): not needed when dependencies are vendored, and harmful in cloud-synced folders (RQ-CLOUD-2). The switch conditions are made concrete in F5: Q-01 (do students have, or can they install, a Python >= 3.9?), Q-02 (lab restrictions), S-01 (bridge on the real CP2102 on macOS and Windows), S-02 (only if S-01 fails or Q-01 is "no Python": `serialport` inside VS Code's Electron on both OSes). A third option not in the notes - ship a per-platform embedded Python in four target-specific VSIXs - is kept in reserve for the Q-01 "no Python" case | invariant DECIDED; implementation USER INPUT (Q-01, Q-02) + SPIKE (S-01) |
| D-03 | Role of mpremote | 08/09: vendored oracle and `mip`; 05: runtime; 04/06: runtime | **Not on the hot path.** Roles: (a) differential-test oracle pinned to 1.29.0 (Appendix G #21); (b) runner for `mip`/`mount`/`romfs` if ever needed; (c) the degraded "CLI mode" fallback (09 M3) for file operations only. Never `fs stat`/`mv`/`run`/`mkdir -p`, never `connect auto`, never `fs tree` as data (08 section 9, `08-mpremote-research.md:472`) | DECIDED |
| D-04 | REPL surface | 02/09: `Pseudoterminal` that is a view on the owner. 05: real `createTerminal({shellPath: python, shellArgs: [... mpremote ...]})` because `mpremote repl` needs a TTY (08 fact 6) | **`Pseudoterminal` (`ExtensionTerminalOptions`).** 05's real terminal is only needed if the transport were A/B; 08 fact 6 is about `mpremote repl`, which the bridge design never runs. Decisive extra evidence (N-4): the Envs extension skips `pty` terminals, whereas the old real terminal (`zsh -lc "... -m mpremote connect <port>"`, never an interactive shell, so shell integration never appears) receives `source .../activate` after the 5 s timeout, typed into mpremote's stdin and thus into the board REPL (critic 2.1 item 2; mechanism now [S]). Real terminals survive only in M0/M3 and the Doctor shell, via `vscode.tasks` + `ProcessExecution` (RQ-TERM-4) | DECIDED; confirm with S-05 (10 minutes in real VS Code) |
| D-05 | IntelliSense file layout | 07 sections 3.2 and 9.2 and the 07 follow-up F.5-F.6: stock stubs hidden under a project dot-directory, a generated environment file, a user-owned `pyrightconfig.json` that `extends` it, instructor pack in `course-stubs/`. 04 section 15.3 (`generateStubs`) and 09 section 5.6: `.pyi` into `<workspace>/typings/` plus merging `.vscode/settings.json` | **Adopt 07's layout as the v1 design, with three amendments.** (1) The portable generated files live in a project dot-directory with a *new* name (placeholder `.mpybench/`; final name in `plan.md`; not the old extension's `.mpy-workbench/`, see D-06): `pyright.generated.json` (only `pythonPlatform`, `stubPath`, `extraPaths`, `ignore`; relative paths only) and `stubs/active/` (stock stubs unpacked from the VSIX; the picker maps `_build=WSU_SHIELD` to `micropython-esp32-stubs 1.29.0.post1`, 07-F.0 item 2). (2) The user-owned `pyrightconfig.json` (three keys: `extends`, `typeCheckingMode: basic`, `reportMissingModuleSource: none`) is created once with consent or shipped in the course template; the extension never writes a second source of the same key (07 section 3.2 S2: a config `extraPaths` replaces the settings list). (3) The instructor pack is `course-stubs/` holding the **verbatim `shield/*.py` sources plus a generated `_shield.pyi`**, listed in both `extraPaths` and `ignore`; `.pyi` made with `pyright --createstub` is rejected because it drops re-exports (07-F.6 rule 1). **Why this replaces the `typings/`-first layout of 04/09 (whose appeal was zero configuration):** the course pack needs `extraPaths` and `ignore`, i.e. a config file, wherever the stock stubs sit, so the zero-config advantage does not survive complaint 2 on the real firmware; 07-F verified the whole chain on the real firmware with pyright 1.1.414 (0 diagnostics on the user's `test.py`) and found `extends`/`ignore`/`stubPath` parsed in Pylance's bundle [R]. The hidden location also keeps ~129 stub files out of the student's view. `typings/` stays as a **fallback tier** (copy stock stubs to `typings/`, `extraPaths`/`ignore` via settings.json), switched on only if S-04 shows real Pylance does not honour the generated config; a `typings/` the user already has is never touched. **Sync-ignore additions (decided; union of `04-ui-inventory.md:623`, `07-linting-stubs.md:564` and 07-F.6 rule 3): the dot-directory, `course-stubs/`, `typings/`, `pyrightconfig.json`, `*.pyi`, `.venv/`, `venv/`, `env/`.** The old default list (`sync.ts:73-85`) has none of these | layout DECIDED (design); default confirmed or flipped by SPIKE S-04 (real Pylance 2026.4.1) |
| D-06 | State location | 03/06/07: `<project>/.mpy-workbench/` (07 needs project-relative `extends`). 05 X-55: caches and state in `context.storageUri` (OneDrive/Defender lock project files) | **Split by what the file is.** *Project-resident, portable, human-readable or machine-independent* (no absolute paths, no board identity, identical on macOS and Windows): `.mpyignore` at the workspace root (also read from the legacy `.mpy-workbench/.mpyignore`), `pyrightconfig.json`, `course-stubs/`, the generated IntelliSense dot-directory (D-05; 07-F verified a pack with only relative forward-slash paths), workspace settings. *Machine- and board-specific state lives in `context.storageUri`*, never in the project: the sync baseline manifest keyed by (workspace, board `machine.unique_id()`), tree cache, bridge scratch, logs, PID file. Reasons: the old baseline stores an absolute `root` and (size, mtime) (N-10), so it is wrong after the folder syncs to another machine or OS; a baseline describes one *board*, not one project, and students swap boards. This reconciles 03/06/07 (state next to the project, needed for `extends`) with 05 X-55 (OneDrive): both are right for different files. **The dot-directory name differs from `.mpy-workbench/`**: the installed old extension owns that name and its semantics (existence of `esp32sync.json` is its "initialised" gate, `config.json` `autoSyncOnSave: true` would be misread as consent); all 07 path strings read `.mpybench/` (placeholder) instead. Settings that were `config.json`/`esp32sync.json` become VS Code settings (D-10); the hidden "Initialize Workspace" prerequisite (04 section 13 item 2) disappears | DECIDED |
| D-07 | Run semantics | 02 section 10.6: never `import`, raw-paste the editor buffer. 04 section 15.3: `mpremote run` default, `run.mode=import` optional. 03 section 6.5 and 06 section 8: keep `import` of the uploaded copy as an option. 08 section 5.5: `import` runs once per soft reset under mpremote 1.30 | **Run = save; flush the dirty set (library files changed since last sync, so `import mylib` sees current code); interrupt; raw REPL; soft reset (default on, `run.freshStart`); raw-paste the saved editor buffer as `__main__` with `compile(src, <local path>, "exec")` for clickable tracebacks; stream output and forward keystrokes (RQ-RUN-1); return to the friendly prompt.** No `mpremote run`, no `fs run`, no `import`, no hard reset. The `run.mode=import` option is dropped; "run what is on the board" is the separate command "Restart board (runs boot.py and main.py)" (02 section 10.5). A soft reset on every Run is within the firmware's design envelope (N-7: PORT_DEINIT parks hardware; "Soft reset is constant") though not yet hardware-verified by the firmware project. The `compile` traceback technique works on the firmware's unix build (N-13) | DECIDED; SPIKE S-06 (stdin during raw-REPL exec); S-07 reduced to a board check |
| D-08 | mpremote minimum | 01 and 04: `>= 1.26` (`mpremote-too-old`, pip pin). 05: `>= 1.29.0`. 08: floor 1.27, pin 1.29, 1.30 behind a probe. 09: vendor 1.29 | **Vendored mpremote is exactly 1.29.0 and is the only mpremote the product uses by default; no user install is required.** An opt-in setting may use the selected environment's mpremote, accepted only for `>= 1.29.0, < 1.30`; 1.30 pre-releases flip auto-soft-reset (08 fact 2) and are rejected until a probe passes. Why 1.29 and not 1.26/1.27: CP210x/Windows DTR-RTS open and close ordering (1.27, 05:228), non-ASCII output on the Windows console and `=` in shortcut arguments (1.29, 05:187-188, 08:93). 1.29.0 equals the class firmware's MicroPython version and the user's `.venv` (N-3). Everything that said "1.26" is superseded (F2 item 3) | DECIDED |
| D-09 | Python minimum | 01 and 09: 3.8. 05: practical 3.9 (`platformdirs`). 09 tested 3.10-3.15 only | **Floor 3.9, tested matrix 3.9 to 3.15; 3.8 is not claimed.** `platformdirs` is not on the bridge's import path (09 section 5.3), so the 3.9 constraint from 05 does not apply; the floor is set by evidence, not by dependencies: Apple's Xcode-CLT `/usr/bin/python3` 3.9.6 passes the bridge scenario (N-6), and 3.8 is end-of-life [K] with no interpreter to test. Probe rejects: exit code non-zero, empty output (Microsoft Store alias), version < 3.9; on macOS skip `/usr/bin/python3` unless `xcode-select -p` succeeds, because the stub can open an install dialog [K, unverified here]. Recommended for students: current python.org 3.12/3.13 | DECIDED; CI matrix and a clean-Mac check pending (S-08) |
| D-10 | Auto-sync default | 03 section 6.5: default ON with a visible prompt. 04-ui-inventory.md:553: keep `false` unless the course template sets it (:531 and :640 Q3: consider ON for the template, noting that with the old per-process model every save interrupted and soft-reset the running program). Old default `false` and a hidden "Initialize Workspace" gate (`04-ui-inventory.md:337,435`) | **Mechanism decided: setting `mpyBench.autoSync` in {`ask` (extension default), `on`, `off`}; `ask` shows a one-time prompt on the first board connect in a workspace (with the dry-run plan), remembered in `workspaceState`, with "save to workspace settings to share".** Guards decided: debounce and coalesce per path; compare content hashes; **defer uploads while a program is running** and show "N files pending" (an upload interrupts the running program, 09 section 5.2); never delete board files automatically; always-visible status item. **The course template's default (`on` versus `off`) needs the instructor**: recommendation `on`, because the request lists auto-mirroring as the feature the user likes | mechanism DECIDED; template default USER INPUT (Q-03) |
| D-11 | Port selection / "connect auto" | 04 section 6.5.10: offer "Auto-detect" through `connect auto` semantics, shown as the resolved port; 08 and 09 section 9: never use `connect auto` in a classroom (`connect auto` opens every USB serial port until one succeeds, picks neighbours' boards: 08:102) | **No transport call ever receives `auto`.** "Auto" is a UI-level selection over `comports()` metadata, which does not open ports: exactly one candidate (VID/PID-ranked ESP32 bridges first, but all ports listed) -> select it and show the resolved name in the status bar; two or more -> QuickPick; macOS only `/dev/cu.*`. The choice is remembered per workspace as (port name, VID, PID) and never written at startup (the old `extension.ts:181-188` overwrote the Global `mpyWorkbench.connect` with `auto`; critic 2.1 item 1 saw the resulting throw twice). Serial number is **not** part of the key (N-11). After a "busy" failure stop polling and offer Retry (09 section 9) | DECIDED |
| D-12 | What the user ran / which root cause | 01, 02: installed VSIX; 04, 06: unknown; 10: paradox | Settled by N-1 and N-2: installed 0.3.2 plus hand edits; RC1 restated as "PATH-dependent, launch-dependent". Planning consequence: do not rely on PATH or launch method anywhere | DECIDED |
| D-13 | Interpreter discovery order | 01 section 5: Python-extension API first; 09 section 5.3 same | Order: explicit setting (expanded `${workspaceFolder}`, never silently skipped) -> **Python Environments extension API when installed** (primary for this user, N-4), else `@vscode/python-extension` -> workspace `.venv` only after Workspace Trust and only as an *interpreter* (mpremote inside it is irrelevant) -> Windows `py -3` as `spawn("py", ["-3"])` -> `python3`, `python` -> known install directories. Every candidate is validated by running the probe (`-I`, 5 s, `windowsHide`); a venv created on another OS (`bin/` versus `Scripts/`) is reported by Doctor and skipped | DECIDED (static evidence); S-05 covers the Envs API path |
| D-14 | Identity and coexistence with the old extension | 04 section 15.1 (ids), 06 section 9 | New publisher/name and a **distinct prefix for commands, views and settings** (04 proposes `mpyBench.*`); the old ids are `mpyWorkbench.*` and view ids `mpyWorkbenchFsView` etc. (`package.json:64-81`). On activation, if `DanielBucam.mpy-workbench` is enabled, show a blocking Doctor warning (both would act on every save and both would open the port); a registration clash makes the second extension fail to activate [K, test in S-10]. See RQ-DIST | DECIDED; SPIKE S-10 |

Status tally: DECIDED outright D-03, D-06, D-08, D-11, D-12; DECIDED with a named verification D-01, D-04, D-07, D-09, D-13, D-14; DECIDED design with the default pending a spike D-05 (S-04); partly open D-02 (USER INPUT Q-01/Q-02, SPIKE S-01) and D-10 (USER INPUT Q-03 for the template default).

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

Amendments to section 11 of this note: **R-ARCH-3** floor is Python 3.9 (D-09) and the bridge also performs RQ-SAFE-4 on stdin EOF; **R-ARCH-4** discovery is Envs-API-first (D-13) and Doctor reports the PATH independence; **R-ARCH-5** adds "Stop and `repl.write` bypass the queue; no automatic hardware reset"; **R-ARCH-6** manifest keyed by (workspace, `machine.unique_id()`) in `context.storageUri`; **R-ARCH-9** adds Windows runners, the OneDrive-style fixture (RQ-CLOUD-1) and a program-stdin scenario; **R-ARCH-11** unchanged; **R-ARCH-1, 2, 7, 8, 10, 12** unchanged.

### F5. Spikes and user questions

Spikes (bounded; each has a pass criterion; "H" = needs a human with hardware or a Windows machine):

| ID | Question | Method | Pass criterion | Gates |
|---|---|---|---|---|
| S-01 (H) | Does the Python bridge open, list, upload, run and stop on the real CP2102 board on macOS and on Windows, without a reset? | `python -I -u -X utf8 bridge.py` CLI mode on one Mac and one Windows laptop; **motor power (VBATT) off** | All operations succeed; S-03 criterion holds; start-up < 1 s | D-02 implementation (gate G1) |
| S-02 (H, conditional) | Does `serialport` load and open inside VS Code's own Electron on both OSes? | Only if S-01 fails or Q-01 = "no Python": tiny extension that opens the port | Loads on macOS x64/arm64 and Windows x64/arm64 with clean DTR/RTS | D-02 fallback |
| S-03 (H) | Does opening/closing the port reset an ESP32 on macOS and Windows with this CP2102 board? | Device prints `time.ticks_ms()` before and after 20 open/close cycles using the S-01 bridge, VBATT off (08 section 11) | `ticks_ms` never goes backwards; if it does, the open sequence is changed before any release | RQ-SAFE-1 |
| S-04 (H) | Does real Pylance 2026.4.1 behave as pyright 1.1.414 did with the chosen layout? | In VS Code: open copies of the 07-F projects (`<scratchpad>/real/G_fixed_pipeline` and `F2_ignore`, or regenerate) and the real `~/src/mpy_test`; read "Python: Show Language Server Output" for search paths. Check: (a) the generated `stubPath` shadows stdlib `time` (`sleep_ms`, `ticks_*`); (b) `shield` resolves from `course-stubs/`, hover shows docstrings, no squiggles inside the pack (`ignore`); (c) `extends` of a relative generated file is honoured; (d) **what happens when the `extends` target does not exist yet** (template opened before the extension ran); (e) a settings-only workspace (fallback tier); (f) config `extraPaths: ["lib"]` | (a)-(c) pass; (d)-(f) recorded; if (a) or (c) fails, flip D-05's default to the `typings/` fallback tier | D-05 default; RQ-COURSE-2 |
| S-05 (H) | Does a `pty` REPL tab stay free of activation text under the Envs extension, and does the legacy path inject? | Real VS Code 1.141: open the REPL tab with the Envs extension active; repeat with `python.useEnvironmentsExtension: false`; open a plain shell terminal as the control; read the Python Envs and Python logs | No `Send text` for the tab in Envs mode; legacy result recorded (decides whether RQ-TERM-2 is needed or merely defensive) | D-04 |
| S-06 | Do host keystrokes reach `sys.stdin` of a program started through raw paste? | Hardware-free: unix-port VM behind `mpunix_relay.py` (Appendix E) running the `test.py` poll loop, then the real board | The program sees the keys within 100 ms | RQ-RUN-1, D-07 |
| S-07 | Does `compile(src, path, "exec")` give usable tracebacks on the board? | Unix build already passes (N-13); remaining: one run on the real board (human) or on a build of the same configuration | `File "<path>", line N` appears for an exception in user code | RQ-RUN-2 |
| S-08 | Windows and clean-Mac behaviour | The existing Windows 10 VM (needs Q-08): cmd/PowerShell, `py -3`, Store stub, Defender latency, fake board over TCP, parentheses fixture; a clean macOS without Command Line Tools | The Windows kit in `05-cross-platform.md` passes; `/usr/bin/python3` stub handled | D-09, RQ-CLOUD-1 |
| S-09 (H) | OneDrive behaviour | A scratch folder under the OneDrive path: online-only placeholder read, touch-without-change events, rename retries | RQ-CLOUD-4 to -6 hold | RQ-CLOUD |
| S-10 | Coexistence with the old extension | Throwaway `--user-data-dir`/`--extensions-dir`, install both VSIXs, activate | New extension activates; no duplicate-id errors; Doctor warning appears | D-14, RQ-DIST-3 |

User questions (cannot be settled by analysis):

| ID | Question | Why it matters / default if unanswered |
|---|---|---|
| Q-01 | Do students have a system Python >= 3.9 today, or only Thonny's bundled one? May the course require a python.org install? | Decides C versus D versus embedded Python (D-02). Default: proceed with C and gate on S-01 |
| Q-02 | Are lab/managed PCs restricted (no admin, AppLocker/WDAC, Marketplace blocked, VSIX sideloading blocked)? | Install channel (RQ-DIST-2) and whether native or embedded runtimes are viable |
| Q-03 | Course template default for auto-sync: `on` or `off`? | D-10. Default: `on` with deferral while running |
| Q-04 | Distribution: VSIX via LMS/GitHub, or Marketplace; publisher name; MIT licence acceptable? | RQ-DIST-2/3 |
| Q-05 | Who owns the `shield`/`_shield` stubs and how do students receive them (firmware release artifact, template repo, LMS)? Is the firmware repo public? | RQ-COURSE-1 (N-8) |
| Q-06 | Are student project folders in OneDrive or on local disk? Windows Known Folder Move on managed PCs? | Priority of RQ-CLOUD; default: treat as the normal case |
| Q-07 | Do all student boards have the GPIO15 pull-down (ECO #1) fitted? Which USB bridges besides CP2102 (CH340, CH343, S3 native USB)? | Severity of hard-reset hazard; VID/PID ranking list |
| Q-08 | May the Windows 10 VM on this Mac be used for the Windows kit? | S-08 |

### F6. Citation fixes (errata for notes 01-10)

| Where | Wrong | Correct | Evidence |
|---|---|---|---|
| `08-mpremote-research.md:32` (section 1 fact 4) | `mpremote.ts:1296` for the `fs stat` call | **`mpremote.ts:1294`** (`:1296` is the `catch (error: any)` of `fileExists`; `:1288` is the function head). 08 section 5.1 already has it right | `sed -n 1294p`, `sed -n 1296p` [E] |
| `09-architecture-options.md:95` (M7 row) | `mpremote.ts:948,1103,1296,1460,1729` | **`mpremote.ts:416,948,1023,1103,1294,1360,1460,1729`**: `fs stat` at 416, 1023, 1294, 1360; `fs mkdir -p` at 948, 1103; `fs run` at 1460; `fs mv` at 1729 (09 listed one of four `stat` calls; `05-cross-platform.md:88` X-60 lists `948,1294,1360,1460,1729`, omitting 416, 1023, 1103) | `grep -n '"fs", "stat"\|"fs", "run"\|"fs", "mv"\|"-p"' src/*.ts` [E] |
| `02-repl-run.md:340,392` | `mpremote.ts:1296-1313` for "`fileExists` swallows every failure" | Correct as written (the swallowing `catch` starts at 1296); no change | [E] |
| `10-completeness-critic.md` section 5 item 6 and the orchestrator brief | "01/04/06 `mpremote >= 1.26`" | 01 (`:318,365`) and 04 (`:378,540`) only; 06 has no such string | `grep` [E] |
| `01-discovery.md:130,143` (RC1 "primary, this is what the user actually ran") | RC1 as the single root cause | Superseded by F2 item 1 / D-12 / N-2 (launch-dependent PATH) | N-1, N-2 |
| `04-ui-inventory.md` section 2 and `06-ext-core.md:170` | "which build the user ran is unknown" | Installed 0.3.2 VSIX with two hand edits (N-1) | installed files [E] |
| `09-architecture-options.md` section 0.2 and R-ARCH-3 | "any Python >= 3.8 (tested 3.10-3.15)" | Floor 3.9; tested 3.9.6 and 3.10-3.15 (D-09, N-6) | [E] |
| `07-linting-stubs.md:564` and `04-ui-inventory.md:623` versus `09` section 5.6 | ignore list for `typings/` stated in 04/07, silent in 09; and 09 section 5.6 / 04 section 15.3 name `typings/` as the stub location | Single ignore list and the 07 layout in D-05 (07 follow-up F.5-F.6) | [S] |
| `10-completeness-critic.md` section 2.2 ("`build/unix/` ... no `micropython` binary present") | no unix binary | `FW/build/unix/micropython` exists (448,296 bytes, Sep 24) and runs; already corrected in `07-linting-stubs.md` F.4; re-run here (N-12, N-13) | [E] |
| `10-completeness-critic.md` section 5 item 3 (04 and 09 "typings/ would upload stubs") | see F2 item 8 | half right | [S] |
| `upy_port.md:545` (firmware plan) quoted by the critic's identity requirement | `_build == 'ME401_ESP32'` | The board directory is `WSU_SHIELD`; `_build` follows it (N-7). Not a note error; do not copy the stale string into a profile | [S] |

(Notes 01-10 are left untouched except for this appended section; the table above is the correction record. The 09 M7 row at line 95 and the 08 fact at line 32 should be read with these corrections.)

### F7. Seeds for `CLAUDE.md` and `plan.md`

Hard rules for `CLAUDE.md` (each traces to a row above):

1. One owner of the serial port, always the bridge; no other code opens a device (D-02, R-ARCH-1). Never `connect auto`; never shell strings; argv arrays only (D-03, D-11, RQ-TERM-1).
2. Agents and tests never open a serial port unless the human runs a hardware step with `MPY_REAL_PORT` set; never flash; motor power off first (RQ-SAFE-5/6).
3. Dependencies are vendored; pyserial 3.5 and mpremote 1.29.0 pinned; Python floor 3.9; no native Node modules (D-08, D-09, RQ-DIST-1).
4. Board- and machine-specific state outside the project (`context.storageUri`); portable generated files only in the extension's own dot-directory (not `.mpy-workbench/`); instructor pack in `course-stubs/` as verbatim `.py` plus `_shield.pyi`; all of these in the default sync-ignore (D-05, D-06, RQ-COURSE-4).
5. Run semantics fixed (D-07); stdin forwarding is v1 (RQ-RUN-1); resets follow RQ-SAFE-2.
6. Project paths in tests include parentheses and spaces (RQ-CLOUD-1); every behaviour is verified on macOS and Windows or labelled unverified.
7. Evidence discipline: record [E]/[S]/[K]/[U] for any claim about Windows, hardware, Pylance or firmware; the firmware facts in N-7 come from `FW/` v1.29.0 and are re-read when the firmware repo changes.

`plan.md` structure suggested by this register: (0) decisions already made (D-01, D-03, D-04, D-06 to D-08, D-11 to D-14 as checked "decided" lines); (1) gating spikes S-01 to S-05 and questions Q-01 to Q-04 before round 2; (2) per-round checkboxes mirroring 09 section 7.2 (R1-R8) with each RQ acceptance cell as a checkbox under the round that implements it (RQ-SAFE and RQ-ID in R1-R4, RQ-RUN in R4, RQ-COURSE in R5, RQ-DIST and RQ-TERM in R2/R6, RQ-CLOUD across R1-R6, hardware gates G1-G3 at R1/R6/R7); (3) a progress log table updated each round in `plan.md`.

### F8. Confidence

* High (executed or read directly): N-1, N-3, N-6, N-8, N-9, N-11, the firmware facts in N-7, the Envs and Pylance bundle facts in N-4/N-5, the line-number corrections in F6, the rewording of D-08/D-09.
* Medium-high: that the 07 layout (generated config + `extends` + `ignore` + `course-stubs/`) is right for the real firmware (pyright 1.1.414 end-to-end per 07 follow-up; Pylance bundle read, not run: S-04), and that `compile(path)` tracebacks work on the board (unix build executed; esp32 config read).
* Medium: that the Envs extension's skip logic is what protects a `Pseudoterminal` in a live VS Code 1.141 session (read from the shipped bundle, not observed; S-05), that legacy activation text reaches `handleInput` (K), the 5 s timeout explaining the logged 4.4-4.5 s lag (consistent, not proven), D-05's default depending on real Pylance honouring the generated config (S-04).
* Low or unverified: H-env as the explanation of the `tree-paths.json` paradox (N-2), all Windows behaviour, DTR/RTS effects on this board (S-03), soft-reset safety on hardware (the firmware project itself has not checked it), OneDrive Files On-Demand behaviour, the `/usr/bin/python3` install-dialog trap, effort estimates.

---

## Follow-up: Student Python availability and the C-vs-D transport decision

Role: follow-up investigator for gap 4 of `10-completeness-critic.md` section 9 ("establish what students have installed; decide C versus D with two spikes") and for the open items Q-01, S-02 and D-09 of the register above. Nothing in `mpy-workbench` was modified. **No serial port was opened and `serialport`'s `list()` was never called**: the isolated VS Code instance ran under a `sandbox-exec` profile that denies `/dev/cu.*` and `/dev/tty.*` (so a mistake could not have reached the attached CP2102), and the only device the spikes touched is a pty slave `/dev/ttysNNN` that the spike created itself. Nothing was installed globally. Everything downloaded lives in `<scratchpad>/followup/`: `serialport 13.0.0` and `@serialport/bindings-cpp 13.0.1` (`npm install --ignore-scripts` into a throw-away extension folder), CPython 3.8.20 (python-build-standalone via `uv python install` with `UV_PYTHON_INSTALL_DIR` in the scratchpad), the Thonny 5.0.0 macOS `.pkg` (expanded with `pkgutil --expand-full`, **not installed**) and the Thonny 5.0.0 Windows portable zip (unzipped and inspected, **not executed**: this is a Mac). One deviation from "scratchpad only": VS Code needs a `--user-data-dir` shorter than 103 characters (macOS `AF_UNIX` limit; the long scratchpad path failed with `IPC handle ... is longer than 103 chars`), so the isolated instance used `/tmp/mpyf-ud`, deleted afterwards. The user's own VS Code windows were never touched (separate user-data-dir; spike processes were killed by pattern).

Tags as in section 1: **[E]** executed/observed in this pass, **[S]** read from source/installed bundle, **[D]** fetched web page or release metadata, **[K]** general knowledge, **[I]** inference, **[U]** unverified. Contents: G1 answers in brief; G2 what students install today; G3 questions only the user can answer; G4 spike 1 (`serialport` inside VS Code 1.141's own extension host); G5 spike 2 (bridge and vendored mpremote on Python 3.8 and 3.9); G6 start-up measurements; G7 decision table and amended switch rule; G8 where this pass contradicts earlier notes; G9 what is still unknown; G10 confidence; Appendix H (the spike code).

Measurement caveat that applies to every millisecond below: single Intel Mac (macOS 15.7.8) that was shared with other agents; `uptime` showed load averages of 7 to 40 during the runs. Absolute numbers are inflated and noisy; ordering and ratios were stable across three independent runs (for example, the Apple-Python bridge start-up median was 444 ms in the first run and 469 ms in the clean third run). Nothing was measured on Windows, on Apple Silicon, or against a real board.

### G1. Answers in brief

1. **What students install: the documents do not say, and nobody has surveyed.** The only student-tooling statements are "Students use Thonny or mpremote" (`upy_port.md:37`) and a planned host-side Python workflow (`mpremote exec ... > step.csv`, `tools/plot_step.py`, `tools/check_board.py`; none written yet). The lab-machine survey in the firmware plan is an unchecked item (`upy_port.md:423`). 09 section 4.4 item 2 ("the course already requires Python") remains an assumption (G2).
2. **The critic's worry is wrong as stated, and so is 09's assumption.** "Thonny-only students have no Python" is false: Thonny 5.0.0 (latest, 2026-04-25) ships a complete private CPython **3.14.3** with `pip`, `pyserial 3.5`, `esptool 5.2.0` and `platformdirs` on macOS (universal2) and the same layout with Python 3.14 on Windows [E: expanded pkg; unzipped portable layout]. That interpreter ran both prototypes (G5). But it is on no `PATH`, no `py` list and no Python-extension discovery; it is findable only by file path, and it exists only while Thonny does. A student who skips Thonny and installs only VS Code plus the new extension has nothing. That population is unknown (G3).
3. **Spike 1 (`serialport` in VS Code's own Electron): PASS on macOS x64.** In a real VS Code 1.141.0 extension host (`Code Helper (Plugin)`, Electron 43.7.7, Node 24.21.0, module ABI 148, N-API 10) `@serialport/bindings-cpp` 13.0.1 and `serialport` 13.0.0 loaded, opened a pty with `flock`, ran 30 raw-REPL round trips (median 2.4 to 2.7 ms through the relay) and failed cleanly on a second open, in 3 of 3 runs. The same file is rejected by the *main* `Code` binary (no library-validation exemption); the extension host is the helper with `disable-library-validation`, which is why it works. A VSIX with a quarantine flag leaves 0 of 56 extracted files quarantined. Apple Silicon and Windows are not tested (the arm64 slice is ad-hoc linker-signed; the x86_64 slice is completely unsigned) (G4).
4. **DTR/RTS cannot be tested without hardware, and a pty fake board cannot help.** macOS ptys have no modem-control lines: `TIOCMGET/TIOCMBIS/TIOCMBIC` fail with `ENOTTY` on both ends, so every `set({dtr,rts})` and `get()` rejects with "Inappropriate ioctl for device". pyserial and mpremote tolerate that (`serialposix.py:336-341`, `transport_serial.py:122-133`); `serialport` does not, so a Node link must catch it. The reset-on-open question (S-03) is open for C and D alike (G4.3).
5. **Spike 2 (bridge and vendored mpremote on 3.8 and 3.9): PASS.** With only vendored wheels and `-I -u -X utf8`: 09's bridge scenario passed 5 of 5 fresh-board runs on **3.8.20**, 5 of 5 on Apple's **3.9.6** and 5 of 5 on 3.15.0 (3 of 3 on Thonny's 3.14.3); 05's hermetic vendored-mpremote launcher passed an 11-step suite on all four. 09's "tested 3.10-3.15" is now "3.8.20, 3.9.6, 3.14.3, 3.15.0 (plus 3.10-3.15 earlier)" (G5).
6. **New defect in 05/09/D-09 as written: `-I` makes Apple's `/usr/bin/python3` 3 to 4 times slower to start.** Under `-I` (and `-E`) Apple's Python sets `dont_write_bytecode=1` and has no `pycache_prefix`; its stdlib folder is root-owned with no `__pycache__`, so every launch recompiles the standard library. Bridge spawn-to-connect: **469 ms median** (436 min; 1.06 to 1.13 s once, in an earlier run that overlapped a second timing harness) versus **151 ms** with `-X pycache_prefix=<writable dir>` versus 86 ms on 3.8.20 and 133 ms on 3.15. Fix is one flag (G6).
7. **Verdict on the C-versus-D switch rule (09 section 4.4): stay on C; D is cheaper to adopt than 09 assumed.** Triggers 1 and 3 are not met or are unanswerable by measurement; trigger 2 (start-up over about 1 s) is met only by Apple's Python under plain `-I` and is fixed by `pycache_prefix`. The second half of the rule (`serialport` clean on all four platforms with correct DTR/RTS) is unverifiable without hardware and two more OS/arch combinations. The remaining deciding input is user fact Q-01/Q-02 (G3). I give a rule that turns the user's answers into a choice (G7).

### G2. What students install today

**Course-side statements (all of them; searched `CLAUDE.md`, `upy_port.md`, `CHANGES.md`, `README.md` in `<course repos>/` and the sibling `student_helper_code_pio32`):**

| Source | Statement | What it implies |
|---|---|---|
| `upy_port.md:37` | "Students use Thonny or mpremote." | The only student-tooling sentence. Thonny brings its own Python; mpremote needs one plus `pip`. No OS split, no admin, no install procedure. |
| `upy_port.md:83`, `CLAUDE.md:208` | "Thonny and `mpremote` soft-reset constantly." | Both tools are assumed in use on the bench. |
| `CLAUDE.md:214`, `upy_port.md:1011` | "never use Thonny's 'Install MicroPython'" (stock firmware removes `_shield`) | Thonny is on at least some student/TA machines. |
| `upy_port.md:1007-1015`, `:330-331` | Flashing guide: HTTPS **web flasher** (Web Serial, esptool-js), `tools/check_board.py`; "a TA new to it flashes and updates 3 boards on Windows and macOS" | Flashing needs no host Python. `check_board.py` is a *planned* host Python tool. |
| `upy_port.md:645, 911-915, 1026, 1149` | `mpremote exec "import me401; me401.info()"`, `mpremote exec ... dump_csv(1) > step.csv`, `tools/plot_step.py` "plots it", "the mpremote auto-soft-reset + dump_csv workflow" in the student docs | The *planned* course material assumes host Python, mpremote and a plotting script. All unchecked items; `ls tools/` shows only four shell scripts. The names say `me401`, i.e. the senior course; nothing is said about the sophomore course. |
| `upy_port.md:419, 423`; `ESP32_Template/CHANGES.md:44-47` | PlatformIO template needs "git, Python >= 3.10 inside PlatformIO", about 0.8 GB first build. **"Lab machines: collect `pio --version`, `pio system info` (Python), `git --version` and internet access from a real lab machine"** is unchecked | No lab-machine survey exists. ME401 students who built the Arduino template have PlatformIO's private interpreter (on this Mac `~/.platformio/penv/bin/python3` = 3.13.13 with pyserial 3.5 [E]); the sophomore MicroPython course may never have installed PlatformIO. |
| `~/src/mpy_test/.vscode/settings.json` | `"mpyWorkbench.pythonPath": "${workspaceFolder}/.venv/bin/python"` | The instructor's own `.venv`; no student template exists. |
| (absent everywhere) | OS split, Apple Silicon versus Intel, Windows ARM64, admin rights, lab image, AppLocker/WDAC, internet, LMS/Marketplace channel, whether students bring laptops | All open (G3). |

**What "Thonny only" really means (executed on the Thonny 5.0.0 artifacts):**

| | macOS (`thonny-5.0.0-x64.pkg`, 49 MB; an `arm64.pkg` also exists) | Windows (`thonny-5.0.0-x64.exe` / `-arm64.exe` / portable zip) |
|---|---|---|
| Interpreter | `Python.framework/Versions/3.14`, **3.14.3**, Mach-O universal (x86_64 + arm64), hardened runtime; pkg is Developer-ID signed and notarized [E] | `python.exe` + `python314.dll` at the install root [E: portable zip] |
| Path | `/Applications/Thonny.app/Contents/Frameworks/Python.framework/Versions/3.14/bin/python3.14` (`PackageInfo`: `install-location="/Applications"`, `auth="root"`, so installing the pkg needs an administrator) [E] | Inno Setup: `PrivilegesRequired=lowest` with a dialog override, `DefaultDirName={autopf}\Thonny` (per-user: `%LOCALAPPDATA%\Programs\Thonny`; all users: `C:\Program Files\Thonny`), `HKA\...\App Paths\thonny.exe` registry key [S: `packaging/windows/inno_setup.iss:25-26,40,110` in the Thonny repo] |
| Bundled packages | `pip 25.3`, `pyserial 3.5`, `esptool 5.2.0`, `platformdirs 4.9.6` [E] | `pip 26.0.1`, `pyserial 3.5`, `esptool 5.2.0`, `platformdirs 4.9.6` [E] |
| Visibility | not on `PATH`; not registered with any launcher [K] | `thonny_python.ini`: "Python in this directory is private for Thonny" [E] |
| Older Thonny | 4.1.7 (2024-12): universal2 Python 3.10 [D] | 4.1.7: 3.10; a 32-bit variant ships 3.8 [D] |

Consequences: (a) "no Python" is not what a Thonny-only student has; they have an excellent one that discovery must be taught to find (`C2` in G7); (b) the macOS Thonny installer needs admin rights while the Windows one does not by default; (c) the Thonny interpreter's version drifts (3.10 until Dec 2024, 3.14 since Apr 2026), so the path must be globbed, not hard-coded; (d) none of this helps a student who never installed Thonny.

### G3. Questions only the user can answer (supersedes and sharpens Q-01, Q-02, Q-06, Q-08)

| # | Question | Why it decides something | Cheapest way to get the answer |
|---|---|---|---|
| U-1 | Which course(s) must this extension serve in the first semester it ships: the sophomore MicroPython course only, or also ME401? | ME401 students already have PlatformIO's interpreter (G2); the sophomore course may have nothing | One line from the instructor |
| U-2 | Do students bring their own laptops (administrator rights, any OS) or use lab PCs (managed image, no admin, AppLocker/WDAC, reimaged, roaming profile or OneDrive redirection)? Rough split: Apple Silicon / Intel Mac / Windows x64 / Windows ARM64? | Decides whether anything may be installed (C2 versus C3 versus D), whether unsigned native `.node` files and `python.exe` copies in the user profile may run, and which of S-02/S-08 matter | Class poll or IT ticket |
| U-3 | What does the current handout tell students to install to program the board (Thonny? `pip install mpremote`? which Python: python.org, Microsoft Store, Homebrew, Xcode tools)? | If the handout already requires a Python, 09's premise becomes true and C2 is safe. If it says Thonny, discovery of Thonny's Python is mandatory | The handout |
| U-4 | Will Thonny stay a supported alternative next to the extension? Is it acceptable to *require* Thonny (or Python) to be installed, as a one-time per-user step? | Port contention (both use pyserial `flock`, G4.2) and whether Thonny's Python can be the official fallback interpreter | Policy decision |
| U-5 | May students install Python themselves? Windows: python.org "Install Now" is per-user and needs no admin; the 3.14 Windows installer is the per-user "Python install manager"; the Store build needs the Store; macOS: python.org pkg and the Xcode command-line tools both need admin [D/K] | Decides the install instructions the Doctor command prints and whether C2 can promise "one step" | Pilot on 2 student laptops per OS |
| U-6 | Is there internet in the lab at install and first-run time? Must everything be inside one VSIX (LMS delivery), or may the extension download an interpreter or run `pip`? | C3 (managed interpreter) and any first-run download only work with internet; the vendored C2/D designs work offline | Instructor/IT |
| U-7 | Are native add-ons in VS Code allowed on lab PCs? Evidence to collect: does Microsoft's *Serial Monitor* or *PlatformIO* extension (both ship native code) work on a lab PC? | If yes, D is viable on Windows; if WDAC blocks unsigned DLLs, only C is | Ask IT, or try those two extensions on one lab PC |
| U-8 | Do all students use a CP2102 board, or also CH340/CH343/S3 native-USB boards? Is the GPIO15 pull-down fitted everywhere? | DTR/RTS reset behaviour differs by chip and driver; reset hazard (RQ-SAFE) | Bench count |
| U-9 | May the Windows 10 VM on this Mac and a borrowed Windows ARM64 laptop be used for one test each? | Closes the Windows half of G9 | Yes/no |

**A ten-minute probe the instructor can have a few students paste (turns U-2/U-3/U-5 into data).** macOS Terminal (the second line is guarded because `/usr/bin/python3` on a Mac without developer tools opens an install dialog [D]): `sw_vers -productVersion; uname -m` / `xcode-select -p && /usr/bin/python3 --version` / `ls -d /Applications/Thonny.app /Library/Frameworks/Python.framework/Versions/* 2>/dev/null` / `command -v python3` / `id -Gn | tr ' ' '\n' | grep -x admin`. Windows PowerShell [K, not executed here]: `[Environment]::OSVersion.Version; $env:PROCESSOR_ARCHITECTURE` / `Get-Command python,py -ErrorAction SilentlyContinue | Format-List Source` (a `Source` under `...\WindowsApps\` is the Store stub) / `py -0p` / `Test-Path "$env:LOCALAPPDATA\Programs\Thonny\python.exe"; Test-Path "$env:ProgramFiles\Thonny\python.exe"` / `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`.

### G4. Spike 1: `serialport` 13.x inside VS Code 1.141's own extension host, against a pty-backed fake board

**Rig [E].** `pty_board.py` (Appendix H) creates a pty, connects to the TCP fake board of Appendix A and relays bytes, so the slave `/dev/ttysNNN` behaves like a USB-serial port speaking the real raw-REPL protocol. A throw-away extension (`activationEvents: ["*"]`, Appendix H) runs `scenario.js` inside the extension host, writes a JSON result and quits VS Code. VS Code was launched as `sandbox-exec -f serial-deny.sb ".../Visual Studio Code.app/Contents/MacOS/Code" --user-data-dir /tmp/mpyf-ud --extensions-dir <scratch> --extensionDevelopmentPath=<spike-ext> --no-sandbox --disable-workspace-trust ...` (VS Code 1.141.0, commit `2a59476c`, 2026-10-06). The same `scenario.js` was also run under Node 26.5.0 and under Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`) with both the `Code Helper (Plugin)` binary and the main `Code` binary.

**G4.1 Load, ABI, signing [E].**

| Host | Result |
|---|---|
| Real extension host (`Code Helper (Plugin)`, Electron 43.7.7, Node 24.21.0, `process.versions.modules` 148, `napi` 10, V8 15.0.245.31-electron.0, x64), 3 runs | `require('@serialport/bindings-cpp')` 41 to 43 ms, `autoDetect()` returns `DarwinBinding`, open/lock/read/write/close all work, `serialport`'s `SerialPort` class opens (open event 1 to 16 ms; 0.6 ms under Electron-as-Node) |
| `ELECTRON_RUN_AS_NODE` with the **helper** binary, 2 runs | load 12 ms; same results; RTT median 1.83 ms |
| `ELECTRON_RUN_AS_NODE` with the **main `Code`** binary | **fails**: `dlopen(...): code signature ... not valid for use in process: mapped file has no cdhash, completely unsigned? Code has to be at least ad-hoc signed.` |
| Node 26.5.0 (modules 147, napi 10), 3 runs | works; the very first load of the unsigned dylib in this OS session took 319 ms, later loads 17.5 ms |

Why the helper loads and the main binary does not: both are hardened-runtime (`flags=0x10000(runtime)`, TeamIdentifier `UBF8T346G9`), but only `Code Helper (Plugin)` carries `com.apple.security.cs.disable-library-validation` (plus `allow-jit`, `allow-unsigned-executable-memory`); the main binary has only `allow-jit`, `apple-events`, `audio-input`, `camera` [E: `codesign -d --entitlements`]. Extensions always run in the helper, so this is the property third-party native modules depend on. It is also a hidden coupling: a future VS Code change to that entitlement would break every native extension at once [I].

Prebuild: `prebuilds/darwin-x64+arm64/@serialport+bindings-cpp.node`, 254,416 bytes, universal. The **x86_64 slice is "not signed at all"**; the **arm64 slice is `adhoc,linker-signed`** [E: `lipo -thin` + `codesign -dv`]. Loading the x86_64 slice worked inside the helper on this Intel Mac. The arm64 slice could not be loaded here; on Apple Silicon the kernel refuses unsigned arm64 code outright, which an ad-hoc linker signature satisfies, and library validation is off in the helper, so the combination should load [I]. Thousands of MicroPico/Serial Monitor users depend on exactly this [K], but it is **not verified here**.

Gatekeeper/quarantine: a `.vsix` with `com.apple.quarantine` set was installed with `code --install-extension` into a scratch folder: **0 of 56 extracted files carried the quarantine attribute** [E]. A browser- or LMS-downloaded VSIX therefore does not make the extracted `.node` quarantined. (Unzipping by hand with Archive Utility would; VS Code does not.)

**G4.2 Behaviour against the pty [E].** Open with `lock: true` (default; `flock(LOCK_EX|LOCK_NB)`) and `hupcl: true`; raw-REPL handshake (`^C^C`, `^A`) 104 ms (dominated by my own 100 ms sleep); `print(6*7)` returned `OK42\r\n\x04\x04>`; 30 further `exec` round trips min 0.6 to 1.4 ms, median 1.8 to 2.7 ms, max 2 to 21 ms; a 16 KiB source `exec` 6 to 20 ms (these include the Python relay and the fake board's thread hops, so they bound the binding's cost from above only). **Port contention is symmetric between the two stacks:** a second `serialport` open of the same path rejects with `Error Resource temporarily unavailable Cannot lock port`; a pyserial 3.5 process (what Thonny, mpremote and the bridge use) opening the pty while `serialport` holds it fails with `SerialException [Errno 35] Could not exclusively lock port ...`. So Thonny and a D-based extension exclude each other exactly as Thonny and a C-based one do, with two different message texts that the "port busy" classifier of 09 section 9 must both recognise (and `EAGAIN` is 35 on macOS, 11 on Linux).

**G4.3 DTR/RTS: the calls, what happened, and what the source says [E on the pty, S for the rest].**

| Call | Result on the pty | Meaning for hardware |
|---|---|---|
| `set({dtr:true,rts:true})`, `({dtr:false,rts:true})`, `({dtr:false,rts:false})`, `({dtr:true,rts:false})` | all reject: `Error: Inappropriate ioctl for device, cannot set` (`ENOTTY`) | none observable |
| `get()` | `Error: Inappropriate ioctl for device, cannot get` | none |
| `getBaudRate()` | `getBaudRate is not implemented on darwin` (`dist/darwin.js:125-131`) | none |
| `update({baudRate:921600})` | `Error: ... calling ioctl(.., IOSSIOSPEED, 921600 )` (`ENOTTY`); 115200 resolves (standard rate via termios) | none |
| Python `fcntl.ioctl(fd, TIOCMGET/TIOCMBIS/TIOCMBIC)` on master and slave | all `ENOTTY` | confirms the pty has **no modem lines at all** |

Consequences: (1) **no pty-backed fake board can show, or test, reset-on-open, the CP210x quirk, or Stop-escalates-to-RTS-pulse**; those belong to S-03 on a real board with VBATT off. (2) pyserial and mpremote swallow `ENOTTY` (`serial/serialposix.py:336-341`; `mpremote/transport_serial.py:122-133`, comment "Some devices (like QEMU pts) don't support RTS/DTR control"); `serialport` rejects, so a TypeScript link must catch it on pty/QEMU/socket-like targets or its fake-board tests will fail. (3) What the binding does on real hardware, from source (`@serialport/bindings-cpp@13.0.1`):

* POSIX open is `open(O_RDWR|O_NOCTTY|O_NONBLOCK|O_CLOEXEC|O_SYNC)` (`src/serialport_unix.cpp:84`); **it never touches DTR/RTS**; the line states at open are whatever the OS driver does. `hupcl` (default true) sets `HUPCL` (`:254-255`), i.e. the driver drops DTR (and usually RTS) on close.
* `set()` rewrites all four bits from the argument object: `TIOCMGET`, clear RTS/CTS/DTR/DSR, set only the ones passed as true, then `TIOCMSET` (`:366-405`). At binding level a missing key means false, so `binding.set({dtr:true})` also clears RTS. The `SerialPort` class fills defaults `dtr:true, rts:true` first (`@serialport/stream/dist/index.js:18-23`); the raw binding does not. Easy to get wrong when copying mpremote's order.
* Windows: `hupcl:true` gives `DTR_CONTROL_ENABLE`, `hupcl:false` gives `DTR_CONTROL_DISABLE` ("disable DTR to avoid reset"), and `RTS_CONTROL_DISABLE` unless `rtscts` (`src/serialport_win.cpp:123-127,162`); `set()` uses `EscapeCommFunction` (`:251-259`). So the mpremote CP210x mitigation ("clear DTR and RTS, open, then set them in an order that does not reset", `transport_serial.py:71-85`) has a plausible equivalent (`hupcl:false` + explicit `set` order, and RTS-then-DTR on close), but the window between `CreateFile` and `SetCommState` is inside the library and could not be inspected here [U]. MicroPico issues #360/#366 (section 3.2) show the same area failing in a shipping extension.

**G4.4 What spike 1 does and does not close.** It closes the "does a `.node` load inside the real extension host" half of S-02 on **macOS x64** with high confidence, and retires the "loading inside VS Code's own Electron rather than Node 26 is unverified" caveat in 09 section 4.3 (D, criterion 1). It does not touch Apple Silicon, Windows x64/ARM64, AppLocker/WDAC/Defender behaviour, `list()` and VID/PID enumeration, or any DTR/RTS effect on the CP2102. `serialport` still carries more unknowns than the bridge on the three of four platforms I could not run.

### G5. Spike 2: the bridge and the vendored-mpremote launcher on Python 3.8 and 3.9

Interpreters [E]: **3.8.20** (python-build-standalone, macOS x64; 16.9 MiB download, 52 MB installed), **3.9.6** (Apple's `/usr/bin/python3`, which here resolves to `/Applications/Xcode.app/Contents/Developer/usr/bin/python3`, build "Dec 2 2025"), **3.14.3** (Thonny's, extracted), **3.15.0** (Homebrew, baseline). Vendored trees: `v09` = `mpremote 1.29.0` + `pyserial 3.5` (what the bridge needs, 51 files, 556 KB); `v05_pd*` = the same plus `platformdirs` 4.13.0 (what 05 vendored), 4.3.8 or 4.3.6 (what `Requires-Python` allows on 3.9 and 3.8). All launches used `-I -u -X utf8` and the argv of 05's `vendoredMpremoteArgv()` (bootstrap `import sys; sys.path.insert(0, sys.argv.pop(1)); from mpremote.main import main; sys.exit(main())`).

| Check | 3.8.20 | 3.9.6 Apple | 3.14.3 Thonny | 3.15.0 |
|---|---|---|---|---|
| Syntax: every `.py` of the vendored trees compiles (47 to 51 files) | 0 failures | 0 failures | n/a | n/a |
| 05 launcher `mpremote version` with `v09` (no platformdirs) | `ModuleNotFoundError: platformdirs` | same | works (Thonny's own site-packages provides `platformdirs 4.9.6`, which `-I` does not hide) | `ModuleNotFoundError` |
| 05 launcher `version` with `platformdirs` 4.13.0 / 4.3.8 / 4.3.6 | all print `mpremote 1.29.0` | all | n/a | all |
| 11-step suite through the launcher against the fake board (`exec`, `fs mkdir`, `cp` up and down with content check, `ls`, `cat`, `sha256sum` equal to `shasum`, `tree`, `run`, exception with rc 1, `rm`) | **11/11** for all three platformdirs trees | **11/11** | 11/11 (`v09` and `v05_pd436`) | 11/11 |
| 09 bridge scenario (`drive_bridge.py`: connect; 20 `put`; sha256 manifest; `run` streaming; REPL attach; `ls` with REPL open; REPL variable survives; interrupt), **fresh fake board per run** | **5/5**; 20 files in 1.44 to 1.67 s | **5/5**; 1.32 to 1.54 s | 3/3; 1.6 s | 5/5; 1.47 to 1.59 s |
| Interrupt latency | 0.01 to 0.02 s | 0.01 to 0.02 s | 0.01 to 0.02 s | 0.01 to 0.02 s |

Notes. (1) Three early runs failed only the last step (interrupt, `KeyboardInterrupt` not seen within 2 s) on a **reused** fake board (3.8.20, Apple 3.9.6, and one 3.15 baseline); none of 18 fresh-board runs failed. The fake board interrupts a worker thread with `PyThreadState_SetAsyncExc`; I attribute the failure to leftover state in a long-lived fake-board process, not to the host interpreter (the baseline 3.15 run failed too). Keep "fresh board per scenario" in the CI rules. (2) `platformdirs 4.13.0` declares `Requires-Python >=3.11` and still imported and ran on 3.8 and 3.9 here (it uses postponed annotations); that is luck, not support, so pin 4.3.8 (declares >=3.9) or 4.3.6 (>=3.8) if the launcher is kept. The bridge needs no `platformdirs` at all (09 section 5.3, confirmed again by the `v09` runs). (3) `mpremote 1.29.0` declares `Requires-Python >=3.4`; its real constraints on 3.8 are met in practice. (4) `-I` ignores `PYTHON*` variables and user site but **not** the interpreter's own `site-packages`; the vendor directory is inserted at `sys.path[0]`, so it wins over a stray `serial`/`mpremote` there. (5) The bridge was also spawned from the **real extension host** with `child_process.spawn` (no shell, `windowsHide:true`, vendor path in an env variable), 4 trials per interpreter, NDJSON `connect` + `ls`: all 16 trials succeeded (timings in G6).

### G6. Start-up measurements

**A. Python-driven harness (`timing.py`, Appendix H; clean run; median / minimum in ms; bridge = `bridge_proto.py` over `socket://` to the fake board).** "First" = first launch after deleting the vendored `__pycache__`.

| Interpreter (macOS x64) | `-I -c pass` | hermetic `mpremote version`, warm | `mpremote connect ... exec pass`, warm | **bridge: spawn to `connect` reply**, warm (median / min); first | bridge first `ls` |
|---|---|---|---|---|---|
| 3.8.20 standalone | 30 | 112 | 459 | **86 / 83**; 121 | 23 |
| 3.9.6 Apple `/usr/bin/python3`, plain `-I` | 79 | 522 | 903 | **469 / 436**; 673 | 24 |
| 3.9.6 Apple, `-I -X pycache_prefix=<dir>` | 45 | 165 | 506 | **151 / 129**; 188 | 23 |
| 3.14.3 Thonny 5.0.0 | 36 | 139 | 485 | **163 / 135**; 164 | 24 |
| 3.15.0 Homebrew | 48 | 152 | 513 | **133 / 121**; 293 | 23 |

The 450 to 510 ms for `connect ... exec pass` is the cost 09 section 2.3 called "0.53 s per mpremote process": it is mostly the board-side soft reset and raw-REPL entry on the fake board plus the second import of mpremote, and is identical on every interpreter; the bridge pays it once, not per operation.

**B. Spawned by the real extension host (child_process.spawn from `Code Helper (Plugin)`, connect-reply ms; 4 consecutive trials; ls in brackets).**

| Interpreter | Trials |
|---|---|
| 3.8.20 | 186 (34), 125 (23), 151 (23), 169 (36) |
| 3.9.6 Apple, plain `-I` | 625 (62), 606 (47), 631 (22), 761 (45) |
| 3.9.6 Apple, `-I -X pycache_prefix` | **951 (23) on the true first launch** (cache being filled), then 284, 267, 205 |
| 3.15.0 Homebrew | 348 (14), 220 (24), 168 (24), 158 (23) |

**C. Option D in the same extension host (no process spawn).** `require` of the binding 41 to 43 ms (12 ms under Electron-as-Node; 319 ms once for the first-ever load of the unsigned dylib); open of the pty 0.5 ms (11 to 194 ms while the extension host was still starting other extensions); first `exec` round trip 2.4 to 4.9 ms. Roughly 50 ms from `activate()` to the first byte, against 125 to 760 ms for C.

**D. The Apple `-I` finding (reproduced 3 times).** `/usr/bin/python3 -I -c 'import sys; print(sys.flags.dont_write_bytecode, sys.pycache_prefix)'` prints `1 None`; without `-I` it prints `0 ~/Library/Caches/com.apple.python`; `-E -s` behaves like `-I`; the other builds tried (python-build-standalone 3.8.20, Homebrew 3.15.0) print 0 in both modes [E]. Apple's stdlib folder (`.../Python3.framework/Versions/3.9/lib/python3.9`) is `root:wheel` with no `__pycache__` [E]. So under `-I`/`-E` every launch compiles `json`, `ctypes`, `threading`, `argparse`, `asyncio` ... from source: importing `json, ctypes, threading, argparse` takes 245 ms under `-I`, 91 ms without, 89 to 96 ms under `-I -X pycache_prefix=<writable dir>` (the first run fills the cache, a one-time 7 s `compileall` of the whole stdlib is not needed). Mechanism [I]: Apple's patch ties bytecode writing to a cache prefix that normally arrives through the environment, which `-I`/`-E` discard. **Fix [E]: pass `-X pycache_prefix=<context.globalStorageUri>/pycache`** (available since 3.8, harmless elsewhere). It also bounds the worst case against 09's "about 1 s" threshold: plain `-I` on Apple's Python reached 1.06 to 1.13 s once (in an earlier run that overlapped a second timing harness, so inflated); with the flag the worst observed was 0.29 s after the first launch.

### G7. Decision table and amended switch rule

Options (the `Bridge` interface of 09 section 4.4 makes C2/C3/D interchangeable above the seam):

| | **C1** bridge on `PATH` Python (09 as written) | **C2** bridge, discovery extended + `pycache_prefix` + developer-tools guard (recommended C) | **C3** bridge on an extension-managed interpreter | **D** Node `serialport` in the extension host |
|---|---|---|---|---|
| Student must have | a Python 3.9+ on `PATH`/`py` | any of: Python on `PATH`/`py`, **Thonny's Python**, PlatformIO's `penv`, the Python extension's interpreter, `.venv` | nothing (needs the shipped or downloaded runtime) | nothing |
| Student action if none | install Python (admin on macOS; per-user on Windows) | install Thonny *or* Python; else Doctor prints the instructions | none | none |
| Measured start (this Mac) | Apple plain `-I`: **0.44 to 0.76 s**; others 0.09 to 0.2 s | 0.09 to 0.2 s everywhere incl. Apple (0.15 s with the flag; true first launch about 0.95 s once) | not measured: same interpreter classes as 3.8 standalone (0.09 to 0.19 s); runtime 17 MiB download / 52 MB installed (macOS x64, 3.8) [E], Windows embeddable zip roughly 10 MB [K] | about 0.05 s in-process (G6.C) |
| Native code on student PC | none | none | an interpreter binary (per-platform VSIX or first-run download) | one `.node` (254 KB macOS universal, 233/237 KB Windows x64/ARM64 [E: sizes from `npm pack`]) |
| What can block it | no Python; Store stub; missing developer tools; `PATH` differences | same, but fewer cases | AppLocker/WDAC blocking an unsigned exe in the user profile | library validation (fine in the helper, [E]); WDAC/AppLocker/Defender on unsigned DLLs [U]; arm64 slice [U] |
| Verified here | macOS x64: 3.8.20, 3.9.6, 3.14.3, 3.15.0 | same + the flag | no | macOS x64 only, in the real extension host |
| DTR/RTS | via pyserial/mpremote sequence (known) | same | same | must be re-implemented and tested; pty cannot test it |
| Extra capability | mip/mount/romfs, host logic in Python | same | same | none |
| Per-platform VSIX? | no | no | yes, or download | no (universal VSIX carries all prebuilds, about 2.0 MB for all platforms [E: `du`]) |

**Rule (replaces the trigger list in 09 section 4.4; U-n from G3):**

1. If U-3/U-5 show that the handout already requires, or can require, a Python 3.9+ or Thonny installed per user, **and** U-2/U-7 do not forbid running `python.exe`/`python3` from the user profile: **C2**. (This is the default; it is what the evidence supports today.)
2. If a measurable share of students will have neither Python nor Thonny and cannot install anything, **and** native VS Code add-ons are allowed (U-7 yes): **D**, after S-02 passes on Apple Silicon and Windows x64/ARM64 and S-03 shows clean DTR/RTS on a real CP2102. Reuse everything above the `Bridge` seam; do not build both transports.
3. If neither Python can be installed **nor** native add-ons run, but an executable may run from the user profile: **C3** (embedded interpreter).
4. If nothing can run: no extension design helps; tell the instructor to relax a policy.
5. Mixed or unknown: ship **C2**, keep the `Bridge` seam, let the Doctor command report "no interpreter found" with Thonny/Python install steps, and count how often it fires in the first two weeks. That is the cheapest experiment that answers U-3 with data.

D versus C is **not** "reuse mpremote versus rewrite": register decision D-02 already makes the link an in-house `Link` (about 350 lines) whichever language hosts it. D removes the NDJSON/process layer, interpreter discovery and the Python start-up cost; it adds the native-module platform matrix and re-implements mpremote's DTR/RTS sequences without the ability to test them off-hardware. The 09 scores (C 45, D 34) are judgement; criterion 1 ("works out of the box") and criterion 8 (maintainability) are the two that U-3/U-7 can flip, and criterion 2's "D unverified in Electron" penalty is now partly retired for macOS x64.

**Proposed amendments to the register above (not applied; the register is another agent's text):**
* D-02: add this section's rule 1-5; mark S-02 "macOS x64 passed; remaining: Apple Silicon, Windows x64, Windows ARM64".
* D-09 / R-ARCH-3: keep the policy floor 3.9, but change the reason: 3.8.20 *passes* the bridge and the launcher; 3.8 is excluded because it is end-of-life, not because it is untested. Launch as `python -I -X utf8 -X pycache_prefix=<globalStorage>/pycache -u bridge.py`. The macOS probe must run `xcode-select -p` first and use `/usr/bin/python3` only if it succeeds [D: the stub otherwise asks to install the tools; [U] here because Xcode.app is installed on this Mac].
* D-13: after the explicit setting, Envs API, `.venv`, `py -3`, `python3`/`python`, add the Thonny and PlatformIO candidates: macOS `/Applications/Thonny.app/Contents/Frameworks/Python.framework/Versions/3.*/bin/python3.*`; Windows `HKCU/HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\thonny.exe` directory + `\python.exe`, then `%LOCALAPPDATA%\Programs\Thonny\python.exe`, `%ProgramFiles%\Thonny\python.exe`; `~/.platformio/penv/{bin,Scripts}/python`. Probe each; never mutate them.
* Launcher (05 section 4.3): if kept, vendor `platformdirs` 4.3.8; prefer the bridge, which needs none.
* New spike S-11 (the probe in G3, run by students) and S-12 (merge into S-03: `hupcl:false` + explicit `set` order versus mpremote's sequence on a real CP2102 on Windows, only if D is chosen).

### G8. Where this pass contradicts or narrows earlier notes

1. **10 section 8 / register F2 item 5, "if students have no system Python (Thonny-only)":** Thonny-only students *do* have a Python; it is private and undiscoverable by the old logic. The question is therefore whether discovery should look in Thonny (cheap, G7 C2), not whether Python exists. The assumption in 09 section 4.4 item 2 is still unproven *for students who skip Thonny*.
2. **09 section 4.4 item 2 ("Pylance requires Python"):** Pylance runs without a system interpreter (it warns about a missing environment) [K, not run here]. So Pylance is not evidence that students have Python; only mpremote/Thonny/PlatformIO are.
3. **09 section 0.2 / R-ARCH-3 ("any Python >= 3.8, tested 3.10-3.15") and register D-09 ("3.8 is not claimed; no interpreter to test"):** a real 3.8.20 now passes the bridge scenario 5/5 and the 11-step launcher suite. The 3.9 floor can stay as policy; "untested" is no longer its reason.
4. **05 section 4.3 / 4.2 ("practical floor 3.9 because of `platformdirs`", vendored 4.13.0):** that is a metadata statement. 4.13.0 (declares `>=3.11`) ran on 3.8 and 3.9 anyway; the correct pin is 4.3.8 or 4.3.6.
5. **05 section 4.3 and 09 section 5.1/5.3 ("`-I` is free"):** on Apple's Python `-I` disables bytecode caching and costs 300 to 400 ms per launch (G6.D). Neither note, nor the register's D-09, considered it.
6. **02 E13 / 09 section 4.3 D criterion 1 ("loaded only under Node 26; Electron unverified"):** now verified in the real extension host on macOS x64, including the signing/entitlement mechanism and the quarantine non-issue.
7. **09 section 4.4 trigger 3 ("bridge cannot be made to start under `python -I`") is refuted** for 3.8.20, 3.9.6, 3.14.3 and 3.15.0; trigger 2 (over about 1 s) was approached only by the Apple case, now fixed.
8. **Critic section 3 ("Bridge on the Python versions students will actually have ... 3.9.x" never run):** done for 3.8.20 and 3.9.6; register N-6 had already run 3.9.6 once, this pass adds repetitions (5 fresh-board runs), the launcher, a 3.8 interpreter, Thonny's interpreter, in-extension-host spawning, and the start-up costs.

### G9. Still unknown after this pass

* Everything on Windows: `python -I` start-up under Defender, the Store stub, the new Python install manager's `py` semantics (the legacy `py -3` launcher is deprecated in 3.14 [D]; 05's probe must be rechecked), `serialport` DLL load under AppLocker/WDAC, Thonny's per-user path and App Paths key on a real install (read from the installer script, not run).
* Apple Silicon: the arm64 slice of the prebuild, Rosetta behaviour of x86_64-only Pythons, Thonny's arm64 pkg.
* A Mac **without** developer tools: the `/usr/bin/python3` stub behaviour is from search results [D], not observed (Xcode.app is installed here; triggering the dialog on the instructor's screen was not worth the risk).
* Any real-board behaviour: reset-on-open, `hupcl` effects, CP2102 enumeration through `serialport`'s `list()` (deliberately not called), flow control at real 115200 baud.
* The student population itself (G3). No measurement here can substitute for U-2/U-3.

### G10. Confidence

* **High [E]:** spike 1 on macOS x64 (3 real extension-host runs, 3 Electron-as-Node, 3 Node; entitlement and signature facts from `codesign`); pty modem-line `ENOTTY` result; bridge and launcher passing on 3.8.20, 3.9.6, 3.14.3, 3.15.0 (18 fresh-board bridge runs); Apple `-I` bytecode finding and its fix (flag dump, import timings and bridge timings reproduced three times); Thonny 5.0.0 content on both OSes (expanded pkg, unzipped portable layout, release metadata).
* **Medium-high:** the C2 recommendation and the G7 rule (they follow from the measurements plus unanswered questions); the Thonny Windows path logic (read from `inno_setup.iss`, installer not run); the claim that an ad-hoc-signed arm64 slice loads in the helper [I].
* **Low or unverified:** all Windows behaviour, Apple Silicon, no-developer-tools Macs, real DTR/RTS, student population and lab policy. Absolute millisecond values (shared, heavily loaded Mac).
* **Could refute the recommendation:** U-3 showing a large Python-less group with unrestricted native add-ons (flips to D); Windows measurements of `python -I` start-up far above 1 s; a failure of the arm64 slice to load.

### Appendix H. Spike code (all in `<scratchpad>/followup/`; POSIX; written to run unchanged under Node and in the extension host)

`pty_board.py` (pty relay to the TCP fake board of Appendix A; never opens any real device):

```python
#!/usr/bin/env python3
"""pty_board.py - expose the TCP fake board (arch/fakeboard.py) as a pty slave device, like a USB-serial port.
Usage: pty_board.py socket://127.0.0.1:PORT EVENTLOG [--hold-slave]
Prints 'PTY /dev/ttysNNN' once ready. The relay never touches any real serial device.
macOS ptys have no modem-control lines (TIOCMGET/TIOCMBIS return ENOTTY): DTR/RTS are NOT observable here.
"""
import json, os, pty, select, socket, sys, termios, time, tty
url, evlog = sys.argv[1], sys.argv[2]
hold = "--hold-slave" in sys.argv
host, port = url.split("://")[1].split(":")
sock = socket.create_connection((host, int(port)))
master, slave = pty.openpty()
name = os.ttyname(slave)
tty.setraw(slave)
if not hold:
    keep = os.dup(slave)
    os.close(slave)
else:
    keep = slave
log = open(evlog, "a", buffering=1)
def ev(kind, **kw):
    log.write(json.dumps(dict(t=round(time.time(), 3), ev=kind, **kw)) + "\n")
ev("ready", slave=name, hold=hold)
print("PTY " + name, flush=True)
tx = rx = 0
try:
    while True:
        r, _, _ = select.select([master, sock], [], [], 0.5)
        if master in r:
            try:
                d = os.read(master, 4096)
            except OSError as e:
                ev("master_read_error", errno=e.errno, msg=str(e)); time.sleep(0.05); continue
            if d:
                rx += len(d); sock.sendall(d)
        if sock in r:
            d = sock.recv(4096)
            if not d:
                ev("board_closed"); break
            tx += len(d); os.write(master, d)
except KeyboardInterrupt:
    pass
finally:
    ev("bytes", host_to_board=rx, board_to_host=tx)
```

Spike extension: `package.json` `{"name":"serialport-spike","publisher":"spike","version":"0.0.1","engines":{"vscode":"^1.141.0"},"main":"./extension.js","activationEvents":["*"],"contributes":{},"dependencies":{"serialport":"13.0.0"}}` plus `npm install --ignore-scripts @serialport/bindings-cpp@13.0.1`; `cfg.json` holds `{pty, tcp, resultPath, python, pyserialVendor, bridgeScript, pythons:[{name, cmd, flags}]}`.

`extension.js`:

```js
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
exports.activate = async function activate() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'cfg.json'), 'utf8'));
  let R;
  try { R = await require('./scenario').run(cfg); } catch (e) { R = { fatal: String(e && e.stack || e) }; }
  R.host = { vscodeVersion: vscode.version, appName: vscode.env.appName, appHost: vscode.env.appHost, remoteName: vscode.env.remoteName || null, uiKind: vscode.env.uiKind };
  fs.writeFileSync(cfg.resultPath, JSON.stringify(R, null, 2));
  setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 800);
};
```

`scenario.js`:

```js
'use strict';
// Shared spike scenario: runs unchanged inside VS Code's extension host (Electron) and under plain Node.
// It only ever opens cfg.pty (a pty slave created by pty_board.py). It never calls list() and never
// touches /dev/cu.* or /dev/tty.*.
const path = require('path');
const { execFile } = require('child_process');
const hr = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(cfg) {
  const R = { env: {}, steps: [], rtt_ms: [] };
  R.env = {
    versions: Object.fromEntries(['electron', 'node', 'modules', 'napi', 'v8', 'chrome'].map((k) => [k, process.versions[k]])),
    arch: process.arch, platform: process.platform, execPath: process.execPath, pid: process.pid,
    argv0: process.argv0, rss_mb_start: Math.round(process.memoryUsage().rss / 1048576),
  };
  const step = async (name, fn) => {
    const t0 = hr();
    try { const v = await fn(); R.steps.push({ name, ok: true, ms: +(hr() - t0).toFixed(2), v }); return v; }
    catch (e) { R.steps.push({ name, ok: false, ms: +(hr() - t0).toFixed(2), err: String((e && e.message) || e) }); return undefined; }
  };

  // 1. load the native binding (node-gyp-build -> prebuilds/darwin-x64+arm64/*.node via dlopen)
  const bc = await step('require(@serialport/bindings-cpp)', () => {
    const m = require('@serialport/bindings-cpp');
    return { exports: Object.keys(m).filter((k) => /Binding|autoDetect/.test(k)) };
  });
  if (!bc) return R;
  const bindings = require('@serialport/bindings-cpp');
  const Binding = bindings.autoDetect();
  R.env.bindingKind = Binding === bindings.DarwinBinding ? 'DarwinBinding' : Binding === bindings.WindowsBinding ? 'WindowsBinding' : 'other';

  // 2. open the pty
  let port;
  port = await step('open(pty) lock=true hupcl=true', async () => { port = await Binding.open({ path: cfg.pty, baudRate: 115200 }); return { isOpen: port.isOpen, fd: port.fd }; }) && port;
  if (!port || !port.isOpen) return R;

  // 3. DTR/RTS calls (what an extension would use for a hardware reset / bootloader entry)
  const calls = [
    ['set({dtr:true, rts:true})', { dtr: true, rts: true }],
    ['set({dtr:false, rts:true})', { dtr: false, rts: true }],
    ['set({dtr:false, rts:false})', { dtr: false, rts: false }],
    ['set({dtr:true, rts:false})', { dtr: true, rts: false }],
  ];
  for (const [name, arg] of calls) await step(name, async () => { await port.set(arg); return 'resolved'; });
  await step('get()', () => port.get());
  await step('getBaudRate()', () => port.getBaudRate());
  await step('update({baudRate:921600}) [IOSSIOSPEED]', async () => { await port.update({ baudRate: 921600 }); return 'resolved'; });
  await step('update({baudRate:115200}) [standard rate]', async () => { await port.update({ baudRate: 115200 }); return 'resolved'; });

  // 4. raw REPL round trips through the pty
  let acc = Buffer.alloc(0); let pumping = true;
  const pump = (async () => {
    const buf = Buffer.alloc(4096);
    while (pumping && port.isOpen) {
      try { const { bytesRead } = await port.read(buf, 0, buf.length); if (bytesRead) acc = Buffer.concat([acc, buf.subarray(0, bytesRead)]); }
      catch (e) { break; }
    }
  })();
  const waitFor = async (marker, ms) => {
    const t0 = hr();
    for (;;) {
      const i = acc.indexOf(marker);
      if (i >= 0) { const out = acc.subarray(0, i + Buffer.byteLength(marker)); acc = acc.subarray(i + Buffer.byteLength(marker)); return out; }
      if (hr() - t0 > ms) throw new Error('timeout waiting for ' + JSON.stringify(marker) + ' got ' + JSON.stringify(acc.toString('latin1').slice(-80)));
      await sleep(1);
    }
  };
  await step('raw REPL handshake (^C^C ^A)', async () => {
    await port.write(Buffer.from('\r\x03\x03')); await sleep(100); acc = Buffer.alloc(0);
    await port.write(Buffer.from('\x01'));
    await waitFor('raw REPL; CTRL-B to exit\r\n>', 3000);
    return 'entered raw REPL';
  });
  const exec = async (code) => {
    await port.write(Buffer.from(code + '\x04'));
    const out = await waitFor('\x04\x04>', 5000);
    return out.toString('latin1');
  };
  await step('exec print(6*7)', async () => JSON.stringify(await exec('print(6*7)')));
  for (let i = 0; i < 30; i++) {
    const t0 = hr();
    try { const o = await exec('print(%d)'.replace('%d', i)); if (!o.includes('OK' + i)) throw new Error('bad echo ' + JSON.stringify(o)); R.rtt_ms.push(+(hr() - t0).toFixed(2)); }
    catch (e) { R.steps.push({ name: 'rtt loop', ok: false, err: String(e.message) }); break; }
  }
  await step('exec 16 KiB payload round trip', async () => {
    const t0 = hr(); const o = await exec("d=b'" + 'x'.repeat(16384) + "'\nprint(len(d))"); return { ms: +(hr() - t0).toFixed(1), reply: JSON.stringify(o) };
  });
  await port.write(Buffer.from('\x02')); await sleep(100);

  // 5. second open of the same path (flock): what a student sees if Thonny/another VS Code window has the port
  await step('second open() of same pty (expect lock error)', async () => {
    try { const p2 = await Binding.open({ path: cfg.pty, baudRate: 115200 }); await p2.close(); return 'UNEXPECTED: opened twice'; }
    catch (e) { return 'rejected: ' + e.message; }
  });
  // 6. a pyserial process (what Thonny / mpremote / the bridge use) tries to open it while we hold it
  if (cfg.python) await step('pyserial (' + path.basename(cfg.python) + ') open while serialport holds it', () => new Promise((resolve) => {
    execFile(cfg.python, ['-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import serial\ntry:\n    serial.Serial(sys.argv[2], 115200, exclusive=True); print("opened (no exclusion)")\nexcept Exception as e:\n    print("rejected:", type(e).__name__, e)', cfg.pyserialVendor, cfg.pty],
      { timeout: 10000 }, (err, so, se) => resolve((so || '').trim() + (err ? ' ERR ' + err.message : '') + (se ? ' stderr:' + se.trim().slice(-120) : '')));
  }));

  // 7. close + reopen timing; high-level serialport package
  pumping = false;
  await step('close()', async () => { await port.close(); return 'closed'; });
  await step('reopen hupcl=false', async () => { const p = await Binding.open({ path: cfg.pty, baudRate: 115200, hupcl: false }); const o = { isOpen: p.isOpen }; await p.close(); return o; });
  await step('serialport package: new SerialPort -> open event -> close', () => new Promise((resolve, reject) => {
    const { SerialPort } = require('serialport'); const t0 = hr();
    const sp = new SerialPort({ path: cfg.pty, baudRate: 115200 }, (err) => { if (err) return reject(err); const open_ms = +(hr() - t0).toFixed(2); sp.set({ dtr: false, rts: false }, (e2) => { sp.close(() => resolve({ open_ms, setCb: e2 ? 'err: ' + e2.message : 'ok' })); }); });
  }));
  await pump.catch(() => {});

  // 8. architecture C inside this same process: spawn the Python bridge (vendored pyserial+mpremote only) and talk NDJSON.
  if (cfg.pythons && cfg.tcp) {
    const { spawn } = require('child_process');
    R.bridge = [];
    for (const py of cfg.pythons) {
      const rec = { name: py.name, trials: [] };
      for (let i = 0; i < 4; i++) {
        const t0 = hr();
        const res = await new Promise((resolve) => {
          const child = spawn(py.cmd, ['-I'].concat(py.flags || [], ['-u', '-X', 'utf8', cfg.bridgeScript]),
            { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: Object.assign({}, process.env, { MPY_VENDOR: cfg.pyserialVendor }) });
          let buf = ''; let stderr = ''; let tConn = null; let tLs = null; let stage = 0; let done = false;
          const finish = (r) => { if (done) return; done = true; try { child.stdin.end(); } catch (e) {} resolve(r); };
          child.on('error', (e) => finish({ err: 'spawn ' + e.message }));
          child.stderr.on('data', (d) => { stderr += d; });
          child.stdout.on('data', (d) => {
            buf += d; let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl); buf = buf.slice(nl + 1); let m; try { m = JSON.parse(line); } catch (e) { continue; }
              if (m.id === 1) { tConn = hr() - t0; if (!m.ok) return finish({ err: JSON.stringify(m).slice(0, 200) }); stage = 1; child.stdin.write(JSON.stringify({ id: 2, op: 'ls', path: '/' }) + '\n'); }
              if (m.id === 2) { tLs = hr() - t0 - tConn; finish(m.ok ? { connect_ms: +tConn.toFixed(0), ls_ms: +tLs.toFixed(0) } : { err: JSON.stringify(m).slice(0, 200) }); }
            }
          });
          child.stdin.write(JSON.stringify({ id: 1, op: 'connect', port: cfg.tcp }) + '\n');
          setTimeout(() => finish({ err: 'timeout; stderr=' + stderr.slice(-200) }), 15000);
        });
        rec.trials.push(res);
      }
      R.bridge.push(rec);
    }
  }
  R.env.rss_mb_end = Math.round(process.memoryUsage().rss / 1048576);
  const s = R.rtt_ms.slice().sort((a, b) => a - b);
  R.rtt_summary = s.length ? { n: s.length, min: s[0], median: s[s.length >> 1], max: s[s.length - 1] } : null;
  return R;
}
module.exports = { run };
```

Launch of the isolated, serial-sealed VS Code (the sandbox profile is `(version 1) (allow default) (deny file* (regex #"^/dev/(cu|tty)[.]"))`; pty slaves are `/dev/ttysNNN`, which the pattern does not match). `newboard.sh TAG` starts `fakeboard.py` + `pty_board.py` (plus a second, TCP-only fake board for the bridge trials, because the relay occupies the first board's single client slot) and writes `PTY=` and `TCP=` to an env file:

```zsh
env -i HOME=$HOME USER=$USER LOGNAME=$USER SHELL=/bin/zsh LANG=en_US.UTF-8 TMPDIR=$TMPDIR PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  sandbox-exec -f serial-deny.sb "/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  --user-data-dir /tmp/mpyf-ud --extensions-dir $F/exts --extensionDevelopmentPath=$F/spike-ext \
  --no-sandbox --use-mock-keychain --disable-updates --disable-telemetry --disable-workspace-trust --skip-welcome --skip-release-notes \
  --new-window $F/ws &
# standalone variants of the same scenario
node run_node.js result.json                                                          # Node 26.5.0
ELECTRON_RUN_AS_NODE=1 "<VSCode>/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)" run_node.js result.json
ELECTRON_RUN_AS_NODE=1 "<VSCode>/Contents/MacOS/Code" run_node.js result.json           # fails: library validation
```

`mp_scenarios.sh PYTHON VENDOR URL` (the 11-step launcher suite; the fake board must be running):

```zsh
#!/bin/zsh
py=$1; vend=$2; url=$3
BOOT='import sys; sys.path.insert(0, sys.argv.pop(1)); from mpremote.main import main; sys.exit(main())'
mp() { $py -I -X utf8 -u -c "$BOOT" $vend connect $url "$@"; }
W=$(mktemp -d); echo 'print("hello from run", 1+1)' > $W/r.py; echo -n 'data123' > $W/d.txt
fail=0
chk() { if [[ "$3" == *"$2"* && "$4" == "$5" ]]; then echo "  ok   $1"; else echo "  FAIL $1: rc=$5 got: $3"; fail=1; fi; }
o=$(mp exec 'print(6*7)' 2>&1); chk exec 42 "$o" 0 $?
o=$(mp fs mkdir /sc$$ 2>&1); chk mkdir "" "$o" 0 $?
o=$(mp fs cp $W/d.txt :/sc$$/d.txt 2>&1); chk cp-up "" "$o" 0 $?
o=$(mp fs ls /sc$$ 2>&1); chk ls d.txt "$o" 0 $?
o=$(mp fs cat /sc$$/d.txt 2>&1); chk cat data123 "$o" 0 $?
o=$(mp fs cp :/sc$$/d.txt $W/back.txt 2>&1); chk cp-down "" "$o" 0 $?; [[ "$(cat $W/back.txt)" == data123 ]] || { echo "  FAIL cp-down content"; fail=1; }
o=$(mp fs sha256sum /sc$$/d.txt 2>&1); chk sha256 "$(shasum -a 256 $W/d.txt | cut -c1-64)" "$o" 0 $?
o=$(mp fs tree 2>&1); chk tree d.txt "$o" 0 $?
o=$(mp run $W/r.py 2>&1); chk run "hello from run 2" "$o" 0 $?
o=$(mp exec '1/0' 2>&1); chk exc-rc1 ZeroDivisionError "$o" 1 $?
o=$(mp fs rm /sc$$/d.txt 2>&1); chk rm "" "$o" 0 $?
rm -rf $W; echo "  summary: fail=$fail"
```

`timing.py URL [name-filter]` (G6.A; needs `bridge/bridge_proto.py` and `vendors/` laid out as in the run; `PC` is the `pycache_prefix` directory; the Thonny entry points into the expanded pkg):

```python
#!/usr/bin/env python3
"""Measure interpreter / vendored-mpremote / bridge start-up on several Pythons. Usage: timing.py URL [filter]"""
import json, os, shutil, statistics as st, subprocess, sys, time
F = os.path.dirname(os.path.abspath(__file__))
URL = sys.argv[1]
PC = F + "/pycache_prefix_dir"
PYS = {
  "3.8.20 (uv standalone)": (F + "/uvpy/cpython-3.8.20-macos-x86_64-none/bin/python3.8", []),
  "3.9.6 (Apple /usr/bin/python3), plain -I": ("/usr/bin/python3", []),
  "3.9.6 (Apple /usr/bin/python3), -I + -X pycache_prefix": ("/usr/bin/python3", ["-X", "pycache_prefix=" + PC]),
  "3.15.0 (Homebrew)": ("/usr/local/bin/python3", []),
  "3.14.3 (Thonny 5.0.0 bundled, extracted pkg)": (F + "/x_thonny_mac/ThonnyComponent.pkg/Payload/Thonny.app/Contents/Frameworks/Python.framework/Versions/3.14/bin/python3.14", []),
}
if len(sys.argv) > 2: PYS = {k: v for k, v in PYS.items() if sys.argv[2] in k}
BOOT = "import sys; sys.path.insert(0, sys.argv.pop(1)); from mpremote.main import main; sys.exit(main())"
def clear_pyc(v):
    for dp, dn, fn in os.walk(v):
        for d in dn:
            if d == "__pycache__": shutil.rmtree(os.path.join(dp, d), ignore_errors=True)
def timeit(argv, n, env=None, setup=None, timeout=60):
    ts = []
    for _ in range(n):
        if setup: setup()
        t0 = time.perf_counter()
        r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=timeout)
        ts.append(time.perf_counter() - t0)
        if r.returncode != 0: return {"err": r.stderr.decode()[-200:]}
    return ts
def fmt(ts):
    if isinstance(ts, dict): return "ERR " + ts["err"]
    return "min %.0f / med %.0f / max %.0f ms (n=%d)" % (min(ts)*1000, st.median(ts)*1000, max(ts)*1000, len(ts))
def bridge_times(py, vendor, n, xf=[]):
    """spawn -> connect reply, then ls latency, N repeats; stdin EOF to quit"""
    out = []
    for _ in range(n):
        env = dict(os.environ, MPY_VENDOR=vendor)
        t0 = time.perf_counter()
        p = subprocess.Popen([py, "-I"] + xf + ["-u", "-X", "utf8", F + "/bridge/bridge_proto.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True, bufsize=1)
        p.stdin.write(json.dumps({"id": 1, "op": "connect", "port": URL}) + "\n"); p.stdin.flush()
        r1 = json.loads(p.stdout.readline()); t_conn = time.perf_counter() - t0
        t1 = time.perf_counter()
        p.stdin.write(json.dumps({"id": 2, "op": "ls", "path": "/"}) + "\n"); p.stdin.flush()
        r2 = json.loads(p.stdout.readline()); t_ls = time.perf_counter() - t1
        p.stdin.close(); p.wait(timeout=10)
        if not (r1.get("ok") and r2.get("ok")): return {"err": str((r1, r2))}
        out.append((t_conn, t_ls))
    return out
for name, (py, xf) in PYS.items():
    shutil.rmtree(PC, ignore_errors=True)
    print("=== " + name)
    vend = F + "/vendors/v05_pd436"; v09 = F + "/vendors/v09"
    print("  python -I -c pass                         ", fmt(timeit([py, "-I"] + xf + ["-c", "pass"], 15)))
    print("  python -I -X utf8 -c 'import json,ctypes,threading'", fmt(timeit([py, "-I"] + xf + ["-X", "utf8", "-c", "import json, ctypes, threading"], 15)))
    first = timeit([py, "-I"] + xf + ["-X", "utf8", "-u", "-c", BOOT, vend, "version"], 1, setup=lambda: clear_pyc(vend))
    print("  vendored mpremote 'version', FIRST (no .pyc) ", fmt(first))
    print("  vendored mpremote 'version', warm          ", fmt(timeit([py, "-I"] + xf + ["-X", "utf8", "-u", "-c", BOOT, vend, "version"], 15)))
    print("  vendored mpremote connect+exec pass, warm  ", fmt(timeit([py, "-I"] + xf + ["-X", "utf8", "-u", "-c", BOOT, vend, "connect", URL, "exec", "pass"], 10)))
    clear_pyc(v09)
    b = bridge_times(py, v09, 1, xf)
    print("  bridge spawn->connect reply, FIRST (no .pyc) ", "ERR " + b["err"] if isinstance(b, dict) else "%.0f ms (ls %.0f ms)" % (b[0][0]*1000, b[0][1]*1000))
    b = bridge_times(py, v09, 10, xf)
    if isinstance(b, dict): print("  bridge ERR", b["err"]); continue
    print("  bridge spawn->connect reply, warm            ", fmt([x[0] for x in b]))
    print("  bridge first ls after connect                ", fmt([x[1] for x in b]))
```

Reproduce (POSIX): create `vendors/v09` (unpack `mpremote-1.29.0` and `pyserial-3.5` wheels), `bridge/` (copy Appendix B and C), `uvpy/` (`UV_PYTHON_INSTALL_DIR=... uv python install 3.8`), start `fakeboard.py` (Appendix A), run `mp_scenarios.sh`, `timing.py`, `run_node.js`, or the launch line above.

