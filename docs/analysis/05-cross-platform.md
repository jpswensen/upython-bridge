# 05 - Cross-platform audit (macOS / Windows / Linux) of the old MPY Workbench

Scope: every file under `mpy-workbench/src` (5,782 lines: TypeScript plus one 42-line Python filter) and `mpy-workbench/scripts` (3 py), plus `package.json`, `.vscodeignore`, the shipped `.vsix`, and the behaviour of the `mpremote` / `pyserial` it drives.
Audience: whoever decides "fix the old extension vs. write a new one" and whoever writes `CLAUDE.md` / `plan.md`.
Author: cross-platform audit subagent. Date of audit: 2026-10-12. The old tree was treated as read-only; all experiments ran in the session scratchpad.
Related notes in this folder (written in parallel, overlapping findings were confirmed independently): `01-discovery.md` (interpreter/mpremote discovery), `02-repl-run.md` (REPL / Run / Stop; it also executed the exact `sendText` strings in PowerShell 7.4.6 and got `ParserError: Unexpected token '-m'`, which upgrades X-02 from [R,D] to [E] for PowerShell), `04-ui-inventory.md`, `06-ext-core.md`, `07-linting-stubs.md`.

## 0. Bottom line

1. **HEAD of the old repo (commit 7cb90c7, "use Python interpreter") cannot work on Windows at all.** Every `mpremote` call and both terminal flows (Run file, REPL) are built as POSIX single-quoted strings and handed to `cmd.exe` (via `child_process.exec`) or typed into PowerShell. Neither shell understands `'...'` quoting (X-01, X-02, X-03). The published `.vsix` 0.3.2 was built from an *older* commit (2a737da): it used double quotes and a bare `mpremote` on PATH, which plausibly worked on Windows only when `mpremote.exe` happened to be on PATH. HEAD's "avoid PATH" refactor traded the venv problem for a Windows regression.
2. **User complaint 1 (".venv not found") is reproduced by execution (macOS).** The interpreter resolver validates a candidate by running the *global* `mpremote` binary, not `<candidate> -m mpremote`; it also can never report "mpremote missing" because Node's ENOENT text has no "not found" in it. With a working venv that has mpremote installed, and even with `mpyWorkbench.pythonPath` set to it, `getPythonPath()` returned the last-resort literal `python3` in all three configurations I tried (X-10).
3. **"Run current file did not work" has a platform-independent cause that I could also prove by execution:** `fileExists()` is implemented with `mpremote fs stat`, which mpremote 1.26-1.29 does not implement (it exits 0 silently), so it always answers "exists"; `runActiveFile` therefore always takes the `exec "import <module>"` branch (runs whatever stale copy is on the board, or `ImportError` if never uploaded; auto-sync defaults to off). Same contract failure for `fs mv`, `fs run`, and `fs mkdir -p` (argparse error) (X-60).
4. **Stop / Interrupt / Soft-reset-while-running are broken on every OS.** They write `echo -e '\x03\x03' > <port>` through `/bin/sh`. Executed on this Mac: it writes the bytes `2d 65 20 03 03 0a` ("-e " + two Ctrl-C + LF) into the target and exits 0, so the mpremote fallback never runs; on Windows it writes literal text or fails; on dash-based Linux it writes literal `\x03` (X-40).
5. **Process management leaks the serial port.** `cancelAll()` does `child.kill('SIGKILL')` on a `cmd.exe`/`sh` wrapper. On Windows that never kills the `python.exe` underneath (Node docs), so an orphan keeps the COM port open and every later command fails with "Access is denied / failed to access"; I reproduced the same orphaning on macOS for any non-trivial shell wrapper (X-41).
6. **A Windows-only data bug:** `uploadActiveFile` normalises separators with `/\\\\/g` (two backslashes). Executed: `lib\sensor.py` stays `lib\sensor.py`, so the board gets a file literally named `lib\sensor.py` in `/` (X-50).
7. **Where the hazards live:** the process layer (`mpremote.ts` 1,743 + `mpremoteCommands.ts` 509 + `pythonInterpreter.ts` 418 = 2,670 lines, 46% of src) holds 29 of the 47 hazards below and has to be replaced no matter what. The tree views, decorations, sync/ignore helpers and `package.json` contributions are reusable with small fixes. **From a cross-platform standpoint: new extension, same sidebar/layout, reusing the UI shell and a handful of pure helpers.**
8. **What "just works" needs** (details in section 4): argv-only process spawning (no shell string anywhere), an absolute interpreter chosen by a testable resolver, a *pinned* mpremote (vendored pure-Python wheels or managed venv) so DTR/RTS and CLI behaviour are identical on every machine, terminals that run the interpreter directly (no shell, no quoting), tree-kill + a single port owner, port classification/diagnostics instead of English-substring matching, and a "Copy diagnostics" command because nobody here can run Windows in CI yet.

Evidence tags used throughout: **[E]** executed by me; **[R]** read the code, did not execute; **[D]** documented platform behaviour (Node / VS Code / Windows / pyserial docs), not executed here; **[I]** inference that still needs a hardware or Windows check (listed in section 10).

## 1. Method and environment

- Read every line of `src/*.ts` (incl. dead/unused modules), `scripts/*.py`, `src/miniterm_filter.py`, `package.json`, `.vscodeignore`, `.gitattributes`, README/CHANGELOG, `git log` (read-only).
- Compiled `src/` in the scratchpad with the repo's own `tsc` (`node_modules/.bin/tsc`): **no compile errors, and the output is byte-identical to the committed `dist/`** except `dist/pathUtils.*` which has no source (stale artifact). The `.vsix` payload differs from `dist/` in `mpremote.js` and `mpremoteCommands.js` only (X-70).
- Executed experiments (all offline, no serial port opened): Node child-process behaviour, the real compiled `pythonInterpreter.js` with a stubbed `vscode`, the real compiled `sync.js` / `mpremoteCommands.js` pure functions, `mpremote` argparse and `do_filesystem` against a recording fake transport, `mpremote connect list` (enumeration only), a TCP fake board driven by the real mpremote, and tested reference helpers (Appendix A).
- Host: macOS 15.7.8 **x86_64** (Intel), Node v26.5.0, Python 3.15.0, scratch venv with mpremote 1.29.0 + pyserial 3.5 + platformdirs 4.13.0. Older mpremote releases (1.24.1-1.28.0) were unpacked into scratch dirs only to run the contract test. **No Windows machine was available**; every Windows statement is [R]/[D]/[I], and the Windows branches of my reference helpers were exercised only through `path.win32` injection.
- The one connected board (`/dev/cu.usbserial-0001`, CP2102) was never opened. `mpremote connect list` only enumerates ports.

## 2. Lineage and what is actually in the old tree

| Item | Finding |
|---|---|
| HEAD `7cb90c7` (2026-04-04) vs shipped VSIX | The checked-in `mpy-workbench-0.3.2.vsix` still contains the **pre-refactor** `mpremote.js`/`mpremoteCommands.js` (bare `mpremote`, double quotes). HEAD source = `python -m mpremote` + POSIX single quotes. [E] (unzipped, diffed) |
| `dist/` | Matches fresh compile of `src/` except stale `pathUtils.js`, `pathUtils.test.js` (+maps) that have no source. [E] |
| VSIX contents | Ships a macOS Python 3.9 `.venv` (714 entries, 11.6 MB uncompressed), stale `scripts/mpremote_tool.py`, `bench_upload.py`, `dist/test.js` (author's `/Users/danielbustillos/...` path). `.vscodeignore` has no `.venv/**` rule. [E] (X-70) |
| Dead / unused code | `monitor.ts` (import commented out), `pyraw.ts` (default off; points at non-existent `scripts/thonny_list_files.py`), `mpremoteOperations.ts` (empty stubs), `test.ts`, `getPythonCommandForTerminal`, `runFile`, `mvOnDevice`, `fileExistsSha256`, `cleanupConnections`. [R] |
| Declared in `package.json` but never registered | `newFileBoardAndLocal, newFileInTree, newFolderInTree, renameNode, refreshPorts, openFileFromLocal, syncFileLocalToBoard, syncFileBoardToLocal, delete, deleteBoardAndLocal` - i.e. the whole right-click menu of the Files view. Registered but undeclared: 16 commands. `createTreeView("mpyWorkbenchLocalFilesView")` (extension.ts:197) has no matching view in `package.json`. [E] (script cross-checking manifest vs. `registerCommand` calls) |
| Unit tests | None that run. `pathUtils.test.js` exists only in dist. Importing `mpremote.js` in Node **hangs** because `new ConnectionManager()` starts a `setInterval` at import (mpremote.ts:107,131). [E] |

## 3. Hazard register

Severity scale, judged for **a sophomore on Windows 10/11 with a fresh python.org or Store Python** (Win column) and **on a current MacBook with Homebrew or system Python** (mac column): **B** blocker (feature unusable), **H** high (frequent failure or data risk), **M** medium, **L** low, **-** fine/not applicable. Linux is noted only where it differs.

### 3.1 Summary table

| ID | Hazard | Where (old src) | Win | mac | Ev. |
|---|---|---|---|---|---|
| X-01 | POSIX-quoted command string executed by `cmd.exe` | mpremote.ts:7-9,170,181,184 | B | - | R,D |
| X-02 | POSIX-quoted string typed into the user's default terminal (PowerShell parse error) | mpremoteCommands.ts:8-17,46,188-225 | B | - | R,D |
| X-03 | REPL terminal via `cmd.exe /d /c '<posix>'` / `$SHELL -lc` | mpremoteCommands.ts:254-258 | B | L | R,D |
| X-04 | `exec()` shell layer: newline, `%`, 8191-char limit, 1 MiB maxBuffer | mpremote.ts:184 | M | L | D |
| X-05 | Pre-quoted args passed through `shellEscape` (literal `"` reaches argv) | mpremote.ts:1459,1727-1728 | L | L | E |
| X-06 | No `windowsHide` on any spawn (console flashes) | pythonInterpreter.ts:232,235; mpremote.ts:184; mpremoteCommands.ts:80,153; monitor.ts:51; pyraw.ts:18 | M | - | D,I |
| X-07 | Unquoted interpolation (spaces, injection from workspace settings) | mpremoteCommands.ts:392,453,484; pythonInterpreter.ts:269-276,294; package.json:15 | M | M | R |
| X-10 | Interpreter "valid" test uses global `mpremote`, not `python -m mpremote`; "missing" branch unreachable | pythonInterpreter.ts:232-242 | B | B | **E** |
| X-11 | `'py -3'` used as a program name; version list stops at 3.12; no per-machine/Store paths | pythonInterpreter.ts:203-212,232 | H | - | E,R |
| X-12 | Bare `python`/`python3` probes (Store alias stub) and last-resort `'python3'` | pythonInterpreter.ts:105,204-205 | H | L | D |
| X-13 | "Install mpremote" runs `pip install` into system Python (PEP 668, user Scripts not on PATH, unquoted path) | pythonInterpreter.ts:254-334 | M | H | D |
| X-14 | `python.defaultInterpreterPath` used raw (`${workspaceFolder}`, `~`), deprecated API | pythonInterpreter.ts:113-194 | M | M | R |
| X-15 | 30 s cache, no reaction to interpreter change | pythonInterpreter.ts:14-28; extension.ts:892 | M | M | R |
| X-16 | Project `.venv` not portable across OS / machine / synced folders | (design) | M | M | D |
| X-20 | PATH snapshots: GUI launch, installs need a full VS Code restart, `--user` Scripts dir | (design) | H | M | D |
| X-21 | Env hygiene: PYTHONHOME/PYTHONPATH leak; `Path` vs `PATH` duplicates; terminals get no UTF-8 env | mpremote.ts:133-140 | M | L | R,E |
| X-22 | Console code page vs UTF-8 (`PYTHONIOENCODING` alone is not enough) | mpremote.ts:133-140 | H | L | **E** |
| X-23 | Error classification by English substrings (localised Windows) | mpremote.ts:192-210,953,997,1299-1339 | M | L | R |
| X-30 | Port picker shows Bluetooth/pseudo ports above the board | mpremote.ts:849-879 | M | M | **E** |
| X-31 | macOS `cu.*` vs `tty.*` | mpremote.ts:11-24; scripts/bench_upload.py:77 | - | M | E,R |
| X-32 | Exclusive port access + mpremote swallows the cause; retry list is macOS-only | mpremote.ts:192-210 | H | H | R |
| X-33 | No real mutual exclusion; op queue reset on every call | mpremote.ts:154-168; extension.ts:281-283 | H | M | R |
| X-34 | Drivers / permissions / diagnostics absent | mpremote.ts:872 | H | M | D |
| X-36 | Port identity: setting reset to `auto` at every activation; COM renumbering | extension.ts:187 | M | L | R |
| X-37 | DTR/RTS auto-reset behaviour differs by mpremote version x OS x chip | (mpremote 1.26 vs 1.27+) | M | M | R,I |
| X-38 | "Soft Reset" is actually a hard reset (native-USB boards re-enumerate) | mpremoteCommands.ts:150 | M | L | R |
| X-40 | Stop / Interrupt / reset via `echo -e ... > port` | mpremoteCommands.ts:392,407,453,484 | B | B | **E** |
| X-41 | Kill does not kill the process tree; only the last child tracked | mpremote.ts:26,228,1575 | B | M | E,D |
| X-42 | `deactivate()` empty; import-time timer; no cleanup of children | extension.ts:1153; mpremote.ts:107,131,1739 | M | L | E |
| X-43 | Blind timer-based Ctrl-C into a REPL that may still be importing Python | mpremoteCommands.ts:261-271 | H | L | I |
| X-44 | `kill('SIGINT')` is a hard kill on Windows | (design) | M | - | D |
| X-50 | Windows backslash regex matches two backslashes | extension.ts:904,911 | H | - | **E** |
| X-51 | Path mapping has no validation (drives, UNC, `..`, root without slash) | mpremoteCommands.ts:191,345-358 | M | L | E |
| X-52 | Case-insensitive host FS vs case-sensitive board FS | sync.ts:93-123 | M | M | E,D |
| X-53 | Code-level ignore defaults miss `.venv`, `desktop.ini`, `._*`, `Thumbs.db` | sync.ts:73-85 | M | L | E |
| X-54 | Ignore-glob engine bugs (`[cod]`, `**`) | sync.ts:87-103 | M | M | E |
| X-55 | Locked / synced files and non-atomic writes inside the workspace | extension.ts:167,362; sync.ts:57; mpremote.ts:276-283 | M | L | D |
| X-56 | Windows-illegal names and long paths when downloading | extension.ts:854 | M | - | D |
| X-57 | macOS TCC prompts, iCloud placeholders, NFC/NFD names | (design) | - | M | D |
| X-58 | One Python process per sub-step; Windows start-up is several times slower | mpremote.ts:948,1119,... | H | M | E(mac),D |
| X-60 | mpremote contract mismatches (`fs stat/run/mv`, `mkdir -p`; `tree` < 1.26) | mpremote.ts:948,1294,1360,1460,1729 | H | H | **E** |
| X-61 | Substring-filter parsers (`'tree'`, `'ls'`) and heuristics; CRLF handled | mpremote.ts:520,816,1191,1542,1632,601-648 | M | M | R |
| X-62 | `Uri.parse('esp32:'+path)`; hard-coded extension id | esp32Fs.ts:50,257 | L | L | R |
| X-70 | VSIX hygiene (venv inside, stale files, VSIX != HEAD) | .vscodeignore | L | L | E |
| X-71 | `extensionKind: ["workspace"]` breaks in WSL / Remote / Codespaces | package.json:13 | M | - | D |
| X-72 | Untrusted workspaces "supported" while executing workspace-supplied interpreter/port | package.json:15,366,406 | M | M | R |
| X-73 | UI strings partly Spanish | mpremoteCommands.ts:82,91-94,103 | L | L | R |

### 3.2 Details and cross-platform-safe replacement for each hazard

Each entry: **What** (and OS behaviour), **Pattern** (what to do instead), **Verify** (how to confirm or refute).

#### A. Process spawning and quoting

**X-01 - POSIX single quotes through `exec()` (mpremote.ts:7-9, 170, 181, 184) - Win B** [R,D]
- *What:* `cmd = "'<python>' -m mpremote 'connect' 'COM3' 'fs' 'tree'"` is passed to `exec`, which on Windows runs `%ComSpec% /d /s /c "<cmd>"`. `cmd.exe` has no single-quote quoting; the first token becomes the literal `'C:\...\python.exe'`, which cannot be resolved. All of: port list, tree, upload, download, delete, reset fail on Windows. macOS/Linux are fine. Lineage: the shipped VSIX built `mpremote "connect" "COM3" ...` (double quotes) which cmd.exe accepts, so this is a **regression introduced by HEAD**.
- *Pattern:* never build a command string. `spawn(file, argv, { shell: false, windowsHide: true, cwd, env })`; interpreter and mpremote arguments are separate array elements (reference `mpremoteArgv()` in Appendix A). libuv does the Windows `CreateProcess` argv quoting; the shell never sees user data.
- *Verify:* CI lint rule `no-exec` / `no-posix-quote` (Appendix C; against the old src it flags 7 + 2 sites); manual tests T-C1 and T-D1; unit test that every operation's argv contains no quote characters added by us.

**X-02 - Terminal command strings (mpremoteCommands.ts:8-17, 46, 188-225) - Win B** [R,D; PowerShell part executed in 02-repl-run.md E5]
- *What:* `runActiveFile` and `restartReplInExistingTerminal` call `terminal.sendText("'<python>' -m mpremote 'connect' ...", true)` into the default shell. Default on Windows is PowerShell, which parses a line that starts with a quoted string as an expression: `Unexpected token '-m' in expression or statement` (a call needs `& '...'`). cmd.exe: same failure as X-01. Git Bash works; WSL bash cannot see `C:\` or COM ports; fish/zsh/bash work. So "Run file" is dead on Windows.
- *Pattern:* do not type commands into the user's shell. Create the terminal *as* the process: `createTerminal({ name, shellPath: <python>, shellArgs: ['-X','utf8','-m','mpremote', ...args], cwd, env })` (array form: VS Code/node-pty quote per platform; a string form exists on Windows only). It has a real PTY (required by mpremote's REPL: `ConsolePosix` calls `termios.tcgetattr(stdin)`, `ConsoleWindows` uses `msvcrt.kbhit()`, so neither works through plain pipes), no profile, no quoting, and exits when mpremote exits. If run-output post-processing is needed, use a `Pseudoterminal` that owns a spawned child.
- *Verify:* T-D1 and T-D10 (run under PowerShell 5.1, PowerShell 7, cmd, Git Bash as default profile).

**X-03 - REPL terminal (mpremoteCommands.ts:254-258) - Win B, mac L** [R,D]
- *What:* Windows: `shellPath: "cmd.exe", shellArgs: ["/d","/c", cmd]` with a POSIX-quoted `cmd` (X-01) plus cmd's `/c` first-and-last-quote stripping rules. POSIX: `process.env.SHELL -lc cmd` starts a *login* shell: runs profile files (macOS `/etc/zprofile` runs `path_helper`, which reorders PATH so system dirs precede a venv's `bin` - executed: starting from `PATH=/Users/x/venv/bin:/usr/bin:/bin`, `zsh -lc 'echo $PATH'` lists the venv entry at position 20, after `/usr/bin` at position 6), can print banners (conda/nvm), and breaks for non-POSIX shells (nushell). It also adds ~60 ms here [E: `zsh -lc true` = 0.06 s, `python -m mpremote version` = 0.17 s].
- *Pattern:* same as X-02: `shellPath` = interpreter, no shell.

**X-04 - `exec` side effects (mpremote.ts:184) - Win M** [D]
- *What:* a newline inside the command terminates it under cmd.exe; `%NAME%` is expanded; command line limit 8,191 chars (cmd) / 32,767 (CreateProcess); `exec` buffers stdout up to `maxBuffer` = 1 MiB and kills the child with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` beyond it (big `fs tree`, chatty `run`). Multi-line Python passed with `exec` therefore only works on POSIX.
- *Pattern:* `spawn` + streaming; for large device-side scripts write a temp file (in `context.globalStorageUri`) and `run` it, or feed via helper stdin.

**X-05 - Double quoting (mpremote.ts:1459, 1727-1728) - L** [E]
- *What:* `deviceArg = '"' + path + '"'` then `shellEscape` -> the child receives literal `"..."`. Executed with `printf`: argv value is `"/Users/x/my proj/main.py"` including the quotes. Both callers are dead/no-op anyway (X-60).
- *Pattern:* arrays only; contract test (Appendix B).

**X-06 - Console window flashes (all spawn sites) - Win M** [D,I]
- *What:* Electron's extension host is a GUI-subsystem process; launching a console program without `windowsHide: true` opens a console window per call. A 50-file sync = hundreds of flashes.
- *Pattern:* `windowsHide: true` on every spawn; lint rule `need-windowsHide`.
- *Verify:* T-C4 (watch the screen during a sync).

**X-07 - Unquoted interpolation (mpremoteCommands.ts:392,453,484; pythonInterpreter.ts:269-276,294) - Win M, mac M** [R]
- *What:* `echo ... > ${devicePort}` and `${pythonPath} -m pip install mpremote` interpolate raw settings. `C:\Users\Mary Ann\...` or `/Users/Ann Lee/...` break; `mpyWorkbench.connect` / `pythonPath` can be set by a *workspace* `settings.json`, and the manifest declares untrusted workspaces as supported (package.json:15) -> command injection by opening a downloaded project (X-72).
- *Pattern:* argv arrays, validate `connect` against `^(COM\d+|/dev/[\w.\-]+|id:|port:|socket://|rfc2217://)` (the last two only in test mode), mark `pythonPath`/`connect` as `restrictedConfigurations`.

#### B. Interpreter and mpremote discovery

**X-10 - Resolver rejects venvs (pythonInterpreter.ts:232-242) - B on both OS** [E]
- *What:* `validatePythonPath(p)` does `execFile(p, ['-c', ...])` (ok) and then `execFile('mpremote', ['--version'])`, i.e. the **global PATH** `mpremote`, never `p -m mpremote`. A project `.venv` is not on the extension host's PATH (activation is per-terminal), so validation fails. The error handler only reports "missing mpremote" if the message contains `not found`; Node's ENOENT message is `spawn mpremote ENOENT`, so `missingMpremote` is never true and the explicit-setting branch (":44 respect user's choice") is dead. Everything falls through to the literal `'python3'` (line 105). Executed with the real compiled module, PATH=`/usr/bin:/bin:/usr/local/bin`, `proj` containing a venv python that has mpremote 1.29.0:

  ```
  no settings                                      => resolved: python3
  mpyWorkbench.pythonPath = <venv python>          => resolved: python3
  python.defaultInterpreterPath = <venv python>    => resolved: python3
  ```
  The shipped VSIX (bare `mpremote` in a PATH-less extension host) fails the same way for fs operations, and for the REPL terminal when started under `-lc` (login shell reorders PATH).
- *Pattern:* validate with the *same argv you will use*: `<interpreter> [-X utf8] -c "import mpremote, serial; print(mpremote.__version__)"` (or run the vendored copy, X-13). Treat ENOENT as "interpreter not found", exit code != 0 with `No module named mpremote` as "mpremote missing", and **never** silently substitute another interpreter for an explicit setting - show the reason.
- *Verify:* resolver unit tests with injected `exists`/`exec` fakes (Appendix A `venvCandidates`); manual T-A5.

**X-11 - `py -3` (pythonInterpreter.ts:205-206, 232) - Win H** [E,R]
- *What:* the Windows fallback list contains `'py -3'`; `execFile('py -3', ...)` fails with `spawn py -3 ENOENT` [E] because the whole string is a program name. `'py'` alone would work. Only `Python39..Python312` under `%LOCALAPPDATA%\Programs\Python` are tried; Python 3.13/3.14 (current in 2026), `C:\Program Files\Python3xx` (all-users install), and Store Python are missing.
- *Pattern:* model an interpreter as `{ command, preArgs[] }` (`py` + `['-3']`). Windows candidate order: explicit setting -> workspace venv -> Python extension's selected env -> `py -3` (ask it: `py -3 -c "import sys;print(sys.executable)"`, then use the absolute path) -> registry/known dirs (`%LOCALAPPDATA%\Programs\Python\Python3*`, `%ProgramFiles%\Python3*`) via directory listing, not a fixed list.

**X-12 - Bare `python` / `python3` (pythonInterpreter.ts:105, 204-205) - Win H** [D]
- *What:* On Windows 10/11 without a real install, `python.exe`/`python3.exe` in `%LOCALAPPDATA%\Microsoft\WindowsApps` are App Execution Alias stubs: they exit 9009 and/or open the Microsoft Store. A probe at activation can therefore pop the Store in front of a student. `python3` does not exist on a python.org install. The last resort `'python3'` (line 105) is never valid on Windows.
- *Pattern:* never probe bare names on Windows; prefer `py.exe` (real binary) and absolute paths; skip aliases under `WindowsApps` unless the stub is proven real by running it (reportedly the stubs stat as size 0 or fail to stat; verify on a real machine). macOS: `/usr/bin/python3` is a Command Line Tools shim (dialog if CLT missing) - probe `xcode-select -p` first or prefer Homebrew/python.org absolute paths. If nothing is found, show one actionable message ("Install Python 3.x from python.org, tick *Add to PATH*, then restart VS Code") - not a probe cascade.

**X-13 - "Install mpremote" button (pythonInterpreter.ts:254-334) - mac H, Win M** [D]
- *What:* runs `<pythonPath> -m pip install mpremote` unquoted (spaces) in whatever interpreter was found. Homebrew Python (3.12+), Debian/Ubuntu and some Conda setups are PEP 668 "externally-managed-environment" and refuse; Store Python installs to a package-private location; python.org `--user` installs put `mpremote.exe` in `%APPDATA%\Python\Python3x\Scripts` which is rarely on PATH (harmless only if we always run `-m mpremote`).
- *Pattern (decision needed from the architecture owner):* three options, all verified to be pure-Python and platform-neutral at the wheel level [E: `mpremote-1.29.0-py3-none-any`, `pyserial-3.5-py2.py3-none-any`, `platformdirs-4.13.0-py3-none-any`, total ~160 KB]:
  1. **Vendor** the wheels unpacked (keep `*.dist-info`) under `<ext>/vendor/` and run with `PYTHONPATH=<ext>/vendor` on whatever Python >= 3.9 is found: no pip, no network, no PEP 668, no venv creation, identical mpremote on every laptop. `importlib.metadata.version("mpremote")` still works because the dist-info sits on `sys.path`. Pick a platformdirs release that supports the oldest Python you support (pip would pick per-interpreter; I saw 4.13.0 require >= 3.11).
  2. **Managed venv** in `globalStorageUri` (`python -m venv` + `pip install --no-index --find-links <ext>/wheels ...` so labs without internet still work). More moving parts (ensurepip missing on Debian, AV scanning, spaces in profile paths).
  3. **Use the project's `.venv` as-is** (the user's current habit) - keep as a *preference* ("if the selected interpreter can already `import mpremote`, use it"), but do not require it.
  Windows with no Python at all is the real blocker for a class; if that occurs in practice, bundle the CPython *embeddable* zip (~10 MB) for win-x64/arm64 as an escalation (needs `_ctypes`, which the embeddable includes, for pyserial).

**X-14 - Config values used raw (pythonInterpreter.ts:170-194, 113-153) - M** [R]
- *What:* `python.defaultInterpreterPath` may be `${workspaceFolder}/.venv/bin/python` or `~/...`; the code passes the unexpanded string to `execFile` -> ENOENT, silently skipped. A repo shared between macOS and Windows cannot hard-code either `bin/` or `Scripts\`. `settings.getExecutionDetails` is a deprecated Python-extension API and returns bare `python` when nothing is selected.
- *Pattern:* expand `${workspaceFolder}`, `${env:X}`, `~`; use the Python extension's `environments.getActiveEnvironmentPath(uri)` + `resolveEnvironment()`; always also try both `.venv/Scripts/python.exe` and `.venv/bin/python` (reference `venvCandidates`), then validate by running it.

**X-15 - Cache and change events (pythonInterpreter.ts:14-28; extension.ts:892) - M** [R]
- *What:* 30 s TTL; only `mpyWorkbench.pythonPath` clears it. After *Python: Select Interpreter* (or creating `.venv`) the old answer lingers.
- *Pattern:* subscribe to `python.environments.onDidChangeActiveEnvironmentPath` and `workspace.onDidChangeConfiguration('python.*')`; cache key = (workspace, settings hash), invalidate on failure.

**X-16 - `.venv` portability (design) - M** [D]
- *What:* a venv created on macOS (`bin/`, symlinks, absolute `home =` in `pyvenv.cfg`) is unusable on Windows and vice-versa; so is one copied by OneDrive/iCloud to a machine with another user name. Teachers distributing a project folder will hit this.
- *Pattern:* read `pyvenv.cfg`, check `home`/`executable` exist, otherwise report "this .venv was created on a different machine/OS - recreate it" with a one-click command (`python -m venv .venv`); ship a template `.gitignore`/zip rule that excludes `.venv`.

#### C. Environment, PATH, encoding

**X-20 - PATH snapshots - Win H, mac M** [D]
- *What:* Windows: VS Code gets the PATH of the session that started it; after installing Python or `pip install --user`, a *full* VS Code restart (sometimes sign-out) is needed, and `...\Python3x\Scripts` is often absent anyway. macOS: Dock/Spotlight launches get launchd's PATH, but VS Code resolves the login-shell environment at start-up so Homebrew paths are usually present - while a project `.venv/bin` never is (activation is per terminal).
- *Pattern:* never depend on PATH for anything that matters: absolute interpreter, `-m mpremote`, absolute paths for `taskkill`/`powershell` (`%SystemRoot%\System32\...`).

**X-21 - Environment hygiene (mpremote.ts:133-140) - Win M** [R,E]
- *What:* `{...process.env, PYTHONIOENCODING}` is fine for that one variable. Gaps: `PYTHONHOME`/`PYTHONPATH`/`PYTHONSTARTUP` inherited from other tools break venv interpreters; copying `process.env` to a plain object and then setting `PATH` on Windows produces two keys (`Path` and `PATH`) with undefined winner; terminal-hosted mpremote (Run/REPL) never receives the UTF-8 variables.
- *Pattern:* `buildChildEnv(base, platform, set, drop)` (Appendix A; tested: case-insensitive replace on win32, drops `PYTHONHOME`), pass `env` also to `createTerminal`.

**X-22 - Output encoding (mpremote.ts:133-140) - Win H** [E]
- *What:* On Windows the stdout of a piped child uses the ANSI code page (cp1252/cp437); mpremote's `fs tree` prints `├── └── │`, producing `UnicodeEncodeError: 'charmap'` (the fix for upstream PR #11). Executed demonstration of the failure mode and its mitigations: with `PYTHONIOENCODING=cp1252` printing `├── a.py` raises `charmap` error; `python -X utf8` alone does **not** override a pre-set `PYTHONIOENCODING` (still fails); `PYTHONIOENCODING=utf-8` works; `LC_ALL=C` gives `ascii` stdout unless `-X utf8`.
- *Also (REPL, Windows):* in mpremote **1.26-1.28** `ConsoleWindows.write()` is `buf.decode()` (strict UTF-8 on whatever bytes the last serial read returned) followed by `sys.stdout.write(buf)` through the console code page (console.py:118-121 in 1.28.0) - a multibyte character split across two reads, or any character outside cp437/cp1252 (for example `→`), can kill the REPL with a `UnicodeDecodeError`/`UnicodeEncodeError`. **1.29.0** adds `_detect_modern_console()` (true for `TERM_PROGRAM=vscode`, console.py:232-240), writes raw UTF-8 bytes, calls `SetConsoleOutputCP(65001)` (console.py:258) and otherwise uses an incremental decoder. 1.26-1.28 contain none of that (grep for `TERM_PROGRAM|SetConsoleOutputCP|_detect_modern_console` = 0 hits). The old README's "mpremote >= 1.26" is therefore too low for ME students printing `°C` / `µ` / `Ω` on Windows.
- *Pattern:* pass **both** `-X utf8` and `PYTHONIOENCODING=utf-8` for non-PTY runs (and in `createTerminal({ env })`), require **mpremote >= 1.29.0** (vendor it, X-13). Downstream cost to remember: Python on Windows writes `\r\n` even into pipes - keep the old code's `/\r?\n/` splitting everywhere.

**X-23 - Localised error text (mpremote.ts:192-210, 953, 997, 1299-1339) - Win M** [R]
- *What:* classification relies on English substrings (`"device not configured"` is macOS errno 6 text; `"connection timeout"` is not an mpremote message at all). pyserial's Windows errors come from `FormatMessage` and are localised ("Zugriff verweigert").
- *Pattern:* classify by stable tokens: mpremote's own fixed strings (`failed to access`, `no device found`, `could not enter raw repl`), errno numbers/classes in the text (`PermissionError(13`, `[Errno 16]`, `[Errno 35]`, `ClearCommError failed`), and exit codes. Table in section 4.6. Include a localised-Windows fixture in tests.

#### D. Serial ports

**X-30 - Port list noise (mpremote.ts:849-879) - mac M, Win M** [E]
- *What:* `mpremote connect list` on this Mac prints (executed):
  ```
  /dev/cu.BLTH None 0000:0000 None None
  /dev/cu.Bluetooth-Incoming-Port None 0000:0000 None None
  /dev/cu.thinkplus-GM2pro None 0000:0000 None None
  /dev/cu.usbserial-0001 0001 10c4:ea60 Silicon Labs CP2102 USB to UART Bridge Controller
  ```
  The old parser's only filter is `!port.includes('None')` (tests the *port token*), so the picker shows three junk entries named "Serial Port" *above* the board (executed on that output). Windows prints `COM1 None 0000:0000 None None` style legacy/Bluetooth ports likewise. Choosing a Bluetooth port should end in a ~10 s "could not enter raw repl" (expected from `enter_raw_repl`'s timeout; not tested because that needs opening the port).
- *Pattern:* parse `device serial vid:pid manufacturer product` (CRLF-tolerant), hide `0000:0000` by default, rank known USB-UART VIDs (CP210x 10C4, CH340/CH9102 1A86, FTDI 0403, Espressif 303A, RP2 2E8A, Adafruit 239A), auto-select when exactly one candidate (reference `parseConnectList`, tested against the real macOS output, Appendix A). Cheap CP2102 clones share serial `0001` (as here), so `id:` selection is unreliable; persist (vid,pid,port) and match by VID:PID + port when exactly one matches.

**X-31 - `cu.*` vs `tty.*` (mpremote.ts:11-24; bench_upload.py:77) - mac M** [E,R]
- *What:* macOS exposes both nodes (both exist here); pyserial's enumeration returns only `cu.*` (list_ports_osx.py uses `IOCalloutDevice`) [E]. pyserial opens with `O_NONBLOCK` (serialposix.py:322), so mpremote itself does not hang on `tty.*`, but shell redirections do (open() waits for carrier detect) - exactly the X-40 pattern - and docs/scripts in this repo recommend `/dev/tty.usbserial-XXXX`. The two nodes are different inodes, so pyserial's exclusive `flock` does not stop two programs using the same hardware via `cu.X` and `tty.X`.
- *Pattern:* canonicalise to `cu.*` on darwin (`canonicalPort`, tested), never write to ports from shell redirections.

**X-32 - Exclusive access and swallowed causes (mpremote.ts:192-210) - H on all** [R]
- *What:* pyserial takes an exclusive `flock` on POSIX (serialposix.py:381-387: "Could not exclusively lock port ...: [Errno 35] Resource temporarily unavailable" on macOS) and an exclusive handle on Windows (`PermissionError(13, 'Access is denied.')`). mpremote's open loop does `except OSError: if wait == 0: continue` and finally raises `TransportError("failed to access " + device)` (transport_serial.py:92-104), so **busy, unplugged, wrong name, and Linux permission denied all look identical** ("failed to access COM3 (it may be in use by another program)"). The old retry whitelist contains one macOS-only phrase and one phrase mpremote never prints.
- *Pattern:* one component owns the port (section 4.4); before blaming "busy", probe: does the node/COM exist in `connect list`; Linux: `fs.access(dev, R_OK|W_OK)` and `id -nG` for `dialout`; Windows: is another `python.exe` of ours alive (we track pids). Retry only after classification, with jittered backoff (100-500 ms; Windows needs it after a kill).

**X-33 - No mutual exclusion (mpremote.ts:154-168; extension.ts:281-283) - Win H, mac M** [R]
- *What:* the guard calls `markOperationStarted(port)` and immediately `markHealthy(port)`, and `markHealthy` resets `operationInProgress = false` (mpremote.ts:65-71), so the guard never blocks. `withAutoSuspend` sets `opQueue = Promise.resolve()` on every call by default (`preempt` defaults true), discarding the serialisation it just built. Tree refresh, auto-sync-on-save and Run can overlap -> two mpremote processes fight over the port (Windows exclusive open -> "Access is denied"; macOS flock EAGAIN).
- *Pattern:* a single promise-chain mutex per port (queue, not preempt); "cancel" = kill current + fail queued items; a UI "busy" state.

**X-34 - Drivers, permissions, diagnostics - Win H, mac M, Linux H** [D]
- *What:* Windows needs a CP210x or CH340/CH9102 driver; usually delivered by Windows Update but not on offline/locked lab images, and then *no COM port appears at all*; the old message ("No ESP32 devices detected. Make sure mpremote is installed and available in PATH.", mpremote.ts:872) points the student at the wrong thing. macOS: the CP2102 here enumerates as `/dev/cu.usbserial-0001`, which suggests the OS-bundled driver [E, driver attribution unverified]; Apple-silicon Macs on macOS 13+ ask once to "Allow accessory to connect" and enumerate nothing until approved. Linux: user must be in `dialout`/`uucp`; ModemManager/brltty can grab `ttyUSB*/ttyACM*` (CH340 especially).
- *Pattern:* "Why isn't my board listed?" command: run `connect list`; if empty or no known VID, query the OS (Windows: `powershell.exe -NoProfile -Command "Get-PnpDevice -PresentOnly | ? InstanceId -match '^USB\\VID_(10C4|1A86|0403|303A)' | Select Status,FriendlyName,InstanceId | ConvertTo-Json"` via argv array; macOS: `system_profiler SPUSBDataType -json` or `ioreg -p IOUSB -w0`; Linux: `ls -l /dev/serial/by-id`, `id -nG`) and show driver links + the accessory-approval hint. Output goes into the diagnostics bundle (4.9).

**X-36 - Port identity and persistence (extension.ts:187; package.json:366) - Win M** [R]
- *What:* the global `mpyWorkbench.connect` is overwritten with `auto` on every activation (students re-pick the port on every VS Code start, and the Files view is empty until they do). Windows assigns COM numbers per USB port/device instance, so replugging into another port gives another COM number; with native-USB boards a reset can re-enumerate (X-38). pyserial opens `COM10+` correctly (serialwin32.py:49-50 adds the `\\.\` prefix); only shell-style access (`echo > COM10`) would fail.
- *Pattern:* keep the choice in `workspaceState`/`globalState` (not user settings), store VID:PID + last port; on start auto-select if exactly one candidate matches; on "port vanished" show a non-modal "board disconnected - reconnect" state and re-resolve automatically when it re-appears.

**X-37 - DTR/RTS reset behaviour differs by version (mpremote) - M** [R,I]
- *What:* mpremote 1.26.0 (the extension's stated minimum) opens Windows ports with `dtr=False; rts=False` only for VID Espressif or manufacturer != "Microsoft", and `close()` just closes. mpremote 1.27+ instead uses `serial_for_url(..., do_not_open=True)`, special-cases Silicon Labs VID on Windows (clear DTR/RTS, open, set in a reset-safe order) and on **all** OSes sets `rts=False` then `dtr=False` in `close()`; "on all other host/driver combinations we keep the default behaviour (pyserial will set DTR and RTS automatically on open)" (transport_serial.py:67-127 in 1.29.0). Whether a given CP2102 ESP32 board hardware-resets on open/close on macOS vs. Windows therefore depends on the mpremote version *and* the OS/driver. I could not test this without opening the port.
- *Pattern:* pin one mpremote version (vendor, X-13) so all classroom machines behave the same; add manual test T-H2 (does the board's uptime counter survive an `fs ls`?).

**X-38 - "Soft Reset" is a hard reset (mpremoteCommands.ts:150) - M** [R]
- *What:* mpremote's `reset` shortcut is `exec --no-follow "import time, machine; time.sleep_ms(100); machine.reset()"` (main.py `_BUILTIN_COMMAND_EXPANSIONS`), i.e. hard reset. On native-USB ESP32 (S2/S3/C3: the old README's tested boards) the port disappears and re-enumerates; the next command races it (Windows may even assign a new COM number). mpremote has a real `soft-reset` command.
- *Pattern:* "Soft reset" -> `soft-reset`; "Hard reset" -> `reset` + wait-for-port-return loop (poll `connect list` up to ~5 s).

#### E. Interrupt, kill, orphans

**X-40 - `echo -e '\x03\x03' > <port>` (mpremoteCommands.ts:392, 407, 453, 484) - B on all** [E]
- *What:* Executed on this Mac (Node `exec`, target = plain file): bytes written `2d 65 20 03 03 0a`. macOS `/bin/sh` prints the `-e` and interprets `\x03`; exit status 0, so the "fallback to mpremote" branch never runs. Consequences: (a) the REPL receives `-e ` + LF noise; (b) it only interrupts if some other process already holds the port at 115200 baud - a shell open of an idle tty starts at the default 9600, so bytes are garbage to the board; (c) `tty.*` blocks (X-31); (d) Windows: cmd's `echo -e '\x03\x03' > COM3` writes literal text, or fails with access denied while mpremote has the port, and `COM10+` would need `\\.\COM10`; (e) Debian/Ubuntu `/bin/sh` = dash: prints `-e \x03\x03` literally [D]. The fallback itself, `exec --no-follow "import sys; sys.stdin.write(b'\x03\x03')"` cannot work either: it needs the very port that is busy and MicroPython's `sys.stdin` has no `write`.
- *Pattern:* interrupt through the process that owns the port. Terminal-hosted `mpremote run`: `terminal.sendText('\x03', false)` (ConPTY turns it into CTRL_C_EVENT; mpremote's `KeyboardInterrupt` handler then exits cleanly, commands.py `_do_execbuffer`). Extension-owned child: tree-kill (X-41) then reconnect - `enter_raw_repl` itself begins with `\r\x03`, so the next command interrupts whatever the board is running. "Stop" = (1) Ctrl-C into the owner, (2) wait up to ~1.5 s for exit, (3) tree-kill, (4) wait for the port to become free, (5) optionally `soft-reset`.
- *Verify:* T-D3 (infinite-loop program, press Stop 10x).

**X-41 - Kill semantics (mpremote.ts:26, 228, 1575) - Win B, mac M** [E,D]
- *What:* `currentChild.kill('SIGKILL')` where `currentChild` is the `exec`'d shell. Node documents that on Windows `kill` terminates only that process: `cmd.exe` dies, `python.exe` lives on holding the COM port. Executed on macOS (children spawned through a compound command or `zsh -lc`): after `kill('SIGKILL')` the worker `sleep` survives (`workers before=2 after=1`), only the single-simple-command case lets `sh` exec-optimise away the wrapper. `currentChild` is a single global overwritten by each new call, so concurrent children are untracked.
- *Pattern:* spawn with `detached: process.platform !== 'win32'` so POSIX children lead a process group; `killTree()` = Windows `taskkill /pid N /T [/F]`, POSIX `process.kill(-pid, SIGTERM)` then `SIGKILL` after a grace period (tested on macOS with a real grandchild, Appendix A). Track *all* live children in a set; kill all on `deactivate`/dispose; persist pids in `globalStorage` and reap stale ones at start-up (verify command line before killing to avoid PID reuse).

**X-42 - Lifecycle (extension.ts:1153; mpremote.ts:107, 131, 1739) - M** [E]
- *What:* `deactivate()` is empty although `cleanupConnections()` exists; `ConnectionManager` starts a `setInterval` at module import - which also makes the module impossible to unit-test (executed: `node -e "require('./mpremote.js')"` never exits). Window reload on Windows leaves running children alive.
- *Pattern:* no side effects at import; `context.subscriptions.push({ dispose: killAll })`; implement `deactivate()` to kill synchronously.

**X-43 - Blind timers (mpremoteCommands.ts:261-271) - Win H, mac L** [I]
- *What:* after creating the REPL terminal the code sends Ctrl-C at +500 ms and Ctrl-B at +600 ms regardless of state. macOS cold start of `python -m mpremote` is ~0.17 s [E]; on Windows with Defender scanning a fresh venv it is plausibly 0.5-2 s. A Ctrl-C that lands during Python start-up (before mpremote installs its handler) raises `KeyboardInterrupt` during import and the REPL exits immediately: "REPL doesn't open reliably" (matches the user's report; **not reproduced** - no Windows).
- *Pattern:* no blind sends. To get a clean prompt in one process: `mpremote connect <port> soft-reset repl` (interrupts a running program, soft-resets, enters the friendly REPL) or wait for the first output chunk through a `Pseudoterminal`.

**X-44 - `kill('SIGINT')` on Windows (design) - M** [D]
- *What:* Node: on Windows every signal name is "ignored except SIGKILL/SIGTERM/SIGINT/SIGQUIT, and the process will always be killed forcefully". There is no graceful interrupt for a non-console child.
- *Pattern:* graceful interrupt only via a PTY (`sendText('\x03')`) or an in-process helper protocol; otherwise hard-kill and rely on reconnect-time Ctrl-C.

#### F. Paths, case, filesystem, sync

**X-50 - Backslash regex (extension.ts:904, 911) - Win H** [E]
- *What:* `rel.replace(/\\\\/g, '/')` matches two consecutive backslashes. Executed with `path.win32.relative`: `"lib\\sensor.py"` -> `"/lib\\sensor.py"` unchanged. The upload goes to a board path with a literal backslash (a root-level file named `lib\sensor.py`) and the ignore matcher gets a Windows path. The auto-save path (extension.ts:1111) uses the correct `/\\/g`, so only the *Upload Active File* command is affected.
- *Pattern:* `rel.split(path.sep).join('/')`; use `localToRel()` (Appendix A); lint rule `no-win-sep-regex`.

**X-51 - Path mapping (mpremoteCommands.ts:191, 345-358) - Win M** [E]
- *What:* executed: `toDevicePath("sub\\a.py","/")` -> `/sub\a.py`; `("a.py","lib")` -> `lib/a.py` (no leading slash); `("D:/x.py","/")` -> `/D:/x.py`; `("../x.py","/")` -> `/../x.py`. In `runActiveFile`, `path.relative` across drives returns an absolute `D:\...` path that does not start with `..`, so a file on a USB stick is treated as "inside the workspace" and imported as module `D:.x`.
- *Pattern:* `localToRel` (rejects different drive/UNC share/`..`, case-insensitive on win32 via `path.relative`) + `relToDevice`/`deviceToRel` (rejects traversal, normalises root), both pure and unit-tested with `path.win32` injected so the Windows cases run on any CI host. Compare paths with `path.relative`, never `startsWith` (drive-letter case: `uri.fsPath` yields `c:\`, settings may say `C:\`).

**X-52 - Case rules (sync.ts:93-123 and device semantics) - Win M, mac M** [E,D]
- *What:* NTFS/APFS-default are case-insensitive; littlefs/FAT behaviour on the board is case-sensitive (MicroPython: `main.py`, `/lib`). `Main.py` on a laptop uploads as `/Main.py` and never autoruns; local `Lib/` uploads as `/Lib` while libraries live in `/lib`; `import sensor` works on the laptop against `Sensor.py` and fails on the board. The ignore matcher is case-sensitive (executed: pattern `build/` does not ignore `BUILD/x.py`; `Thumbs.db` does not ignore `thumbs.db`).
- *Pattern:* keep device comparisons case-sensitive; **warn** on upload when a basename/top-level dir differs from `main.py`/`boot.py`/`lib` only by case, and when two local paths collide case-insensitively; match ignore patterns with `ignorecase = (platform is win32 or darwin)`.

**X-53 - Junk files and `.venv` (sync.ts:73-85) - Win M, mac L** [E]
- *What:* code-level defaults contain only `.git/ .vscode/ node_modules/ dist/ out/ build/ __pycache__/ .DS_Store .mpy-workbench/`. `.venv/`, `venv/` appear only in the *generated* `.mpyignore`; `Thumbs.db` likewise; `desktop.ini` (present in OneDrive-redirected Documents/Desktop folders), `._*` (AppleDouble from exFAT/network volumes), `$RECYCLE.BIN`, `System Volume Information`, `~$*`, `*.tmp` appear nowhere. Executed: with a `.mpyignore` that lacks the line, `.venv/Scripts/python.exe` and `desktop.ini` are not ignored, so "Upload all" would try to push a venv to a 2 MB flash.
- *Pattern:* ship a single built-in default list (always applied, user file only adds) incl. `.venv/ venv/ env/ .env`, `desktop.ini`, `Thumbs.db`, `._*`, `.DS_Store`, `*.pyc`, `.git/`, editor folders.

**X-54 - Ignore engine (sync.ts:87-103) - M** [E]
- *What:* executed against a CRLF `.mpyignore` (CRLF itself is handled): `*.py[cod]` does not ignore `mod.pyc` (character class escaped as literal); `**/secret.txt` does not match a root-level `secret.txt`; `**` is rewritten to `.*` and then the `*` pass rewrites it again to `.[^/]*`.
- *Pattern:* use the `ignore` npm package (real gitignore semantics, supports `ignorecase`), or `picomatch`; test with fixtures from the table in section 5.1.

**X-55 - Locked / synced files, non-atomic writes (extension.ts:167, 362; sync.ts:57; mpremote.ts:276-283) - Win M** [D]
- *What:* `.mpy-workbench/` lives *inside* the workspace; `tree-paths.json` is rewritten on every listing. On Windows, OneDrive Files-On-Demand, Defender and VS Code's own watchers hold short-lived handles, so `fs.rm(recursive)` (no `maxRetries`) and `writeFile` (truncate-then-write, non-atomic) fail intermittently with `EBUSY/EPERM`, and a crash mid-write leaves an empty manifest. macOS iCloud "Desktop & Documents" has similar sync churn.
- *Pattern:* caches/state in `context.storageUri` (outside the project); the manifest, if kept in the project, is written atomically (temp file in the same dir + `rename`, with 5 retries / 50-200 ms on `EBUSY|EPERM|EACCES` on Windows); `fs.rm(..., { maxRetries: 10, retryDelay: 100 })`.

**X-56 - Windows-illegal names (extension.ts:854) - Win M** [D]
- *What:* downloading `path.join(ws, ...rel.split('/'))` assumes every board name is a legal Windows name. Reserved device names (`aux.py`, `con.py`, `nul`, `com1.txt`, `lpt1`...), `: * ? " < > |`, trailing dot/space, and paths > 260 chars fail with confusing errors mid-sync (and `aux`/`con`/`prn` are plausible student module names created on a Mac or via REPL).
- *Pattern:* validate each name before writing; collect failures into a report ("3 files skipped: reserved name on Windows") instead of aborting; keep a Windows long-path note (`\\?\` is handled by libuv, but Python/`mpremote` argv > 260 may not).

**X-57 - macOS specifics (design) - mac M** [D]
- *What:* first access to `~/Desktop` / `~/Documents` triggers TCC prompts (deny -> `EPERM` in `readdir`); iCloud "Optimize Mac Storage" turns files into dataless placeholders; APFS preserves NFC vs NFD names so a Finder-created `Café.py` (NFD) will not string-compare equal to the same name from the board.
- *Pattern:* normalise to NFC for comparison keys only (never rename); classify `EPERM` on workspace roots into a clear message; detect iCloud/OneDrive paths in diagnostics.

**X-58 - Process-per-substep cost (mpremote.ts:948, 1119, 1294...) - Win H(perf), mac M** [E,D]
- *What:* every `runMpremote` is a new Python process that opens the port, enters raw REPL and by default soft-resets the board (`State._auto_soft_reset = True` in mpremote/main.py:536-553; the `resume` command disables it). Measured on this Mac before touching any device: `python -m mpremote version` = 0.17 s. The old upload does `mkdir -p` (always rejected by argparse, X-60), `cp`, plus existence checks -> 2-3 processes per file. On Windows with AV scanning, process start is typically several times slower, so syncing 50 files plausibly takes minutes. Batching also hits command-line limits (cmd 8,191 / CreateProcess 32,767).
- *Pattern:* one mpremote process per *operation* (chain with `+`: `connect X fs mkdir /a + fs cp f1 :/a/f1 + fs cp f2 :/a/f2`, chunked to ~100 files / 8 KB argv) or a long-lived helper process that imports mpremote as a library and speaks JSON on stdin/stdout; add `resume` when not wanting a soft reset between steps.

#### G. Parsing, contract, identity

**X-60 - mpremote contract mismatches (mpremote.ts:948,1103,1294,1360,1460,1729) - H on all** [E]
- *What:* `fs mkdir -p` -> argparse `unrecognized arguments: -p` (exit 2); `fs stat`, `fs run`, `fs mv` parse but `do_filesystem` has no branch for them, so they **exit 0 doing nothing** (executed with a recording fake transport: no transport method is ever called; stdout is only `stat :/x`). Contract test result per release (Appendix B): 1.24.1/1.25.0 fail `tree, tree -s, mkdir -p, stat, run, mv`; **1.26.0-1.29.0 fail `mkdir -p, stat, run, mv`**. Effects: `fileExists()` and `getFileInfo()` are always "true"/`null` ("exists" even for a path that is not there), so Run file always uses `exec "import <module>"` (X-60 is the best candidate for the user's "run current file" failure once the interpreter problem is hacked around: with bare `mpremote` unreachable, as in the shipped VSIX, `fileExists` fails -> `false` -> always `run`; with HEAD's `python -m mpremote` it succeeds silently -> always `true` -> always `exec import`); `mvOnDevice` (rename) is a silent no-op; every upload logs a failed `mkdir -p` before `cp`.
- *Pattern:* use only verified subcommands; do existence/stat through a tiny device-side `exec` that prints JSON (`import os; ...os.stat/ilistdir`) or the library API; add the contract test to CI against the pinned version **and** latest (drift alarm).

**X-61 - Substring-filter parsers (mpremote.ts:520, 816, 1191, 1542, 1632; heuristics 601-648) - M** [R]
- *What:* lines containing `tree` (e.g. `tree.py`, `entree.txt`) or `ls` (`tools.py`, `pulses.py`, `else.py`, `fills.txt`) are skipped; "is directory" is guessed from the extension or from the next 10 lines because `fs tree` output has no directory marker. (Positive: all splitters use `/\r?\n/`, which is exactly what Windows text-mode stdout needs.)
- *Pattern:* ask the device for structured data (one `exec` that prints JSON from `os.ilistdir`, 0x4000 bit for dirs), no text scraping.

**X-62 - Identity / URI (esp32Fs.ts:50, 257) - L** [R]
- *What:* `vscode.Uri.parse('esp32:' + path)` mis-parses `#`, `?`, `%` in file names; the icon lookup hard-codes `DanielBucam.mpy-workbench`, which fails (`undefined!.extensionUri`) as soon as the id changes (it will for a fork / `mpy-upgrade`).
- *Pattern:* `vscode.Uri.from({ scheme: 'mpy', path })`; `context.extensionUri`.

#### H. Packaging, activation, remote, security

**X-70 - VSIX hygiene - L** [E] - see section 2. Add a CI check that fails on `.venv/`, `node_modules/`, `*.pyc`, absolute home paths and size > ~6 MB (Appendix D, `package` job).

**X-71 - `extensionKind: ["workspace"]` (package.json:13) - Win M** [D]
- *What:* when the folder is opened through WSL / Remote-SSH / Dev Containers / Codespaces the extension runs on the remote side, where there are no COM ports; students see an empty port list with no explanation.
- *Pattern:* detect `vscode.env.remoteName`; show "this window is remote - open the folder locally (or use a UI-side helper)"; declare `["ui","workspace"]` only if the architecture can run the serial part locally.

**X-72 - Untrusted workspaces (package.json:15, 366, 406) - M** [R]
- *What:* `untrustedWorkspaces.supported: true` while the extension executes `mpyWorkbench.pythonPath` and passes `mpyWorkbench.connect` into a shell. A downloaded project's `.vscode/settings.json` can therefore run commands.
- *Pattern:* `"untrustedWorkspaces": { "supported": "limited", "restrictedConfigurations": ["mpyWorkbench.pythonPath","mpyWorkbench.connect"] }` plus argv-only spawning (X-01).

**X-73 - Mixed-language UI text (mpremoteCommands.ts:82,91-94,103) - L** [R] - keep all user-visible strings English (or `l10n`) and out of logic (they double as match keys in places).

### 3.3 Observed outside my area (flagged for the other analysts)

- The right-click menu of the Files view is dead (10 commands declared, never registered) [E]; `createTreeView` for an undeclared view id (extension.ts:197) probably yields an error notification [I].
- Auto-suspend design: `withAutoSuspend` sends Ctrl-X to the REPL terminal (mpremote exits, the `-c` shell exits, VS Code disposes the terminal) and `restartReplInExistingTerminal` then `sendText`s into a terminal that no longer exists (mpremoteCommands.ts:26-49, extension.ts:278-301) [R,I] - the REPL cannot reliably "come back" after any file operation. Auto-sync defaults to off (package.json autoSyncOnSave) so "Run file" does not see edits (compounds X-60).
- `ensureIdle()` runs `mp.ls("/")` before *every* operation (extension.ts:269-277), adding a full mpremote round-trip each time.
- `mpyWorkbench.baudRate` is declared but never read (mpremote always uses 115200).
- `fs tree`/`fs cp` already skip identical files by SHA-256 (cp default, `-f` forces) - useful for incremental sync [E, read of commands.py].

## 4. Cross-platform rulebook (the patterns to build on)

All code referenced here is in Appendix A and was run on macOS (`node --test`, 13 tests green); Windows-specific branches are covered by injecting `path.win32` / `platform: 'win32'`, so the same tests run on a Windows CI host unchanged.

### 4.1 One process-launching module, argv only
- Exactly one module (`proc.ts`) may import `child_process`. It exposes `run(file, args, {cwd, env, timeoutMs, signal})` and `startTerminal(...)`. Everything else passes **arrays**. No `exec`, `execSync`, `shell: true`, `sendText(<command>)`, `echo`, `process.env.SHELL`, bare `python`/`python3` (CI guard in Appendix C).
- Every spawn: `shell:false`, `windowsHide:true`, explicit `env` (via `buildChildEnv`), explicit `cwd`, a timeout, and registration in a global live-children set (for X-41/X-42).
- Never resolve the interpreter or mpremote to a `.bat`/`.cmd`: since the Node security releases for CVE-2024-27980 `spawn` of those without a shell throws `EINVAL` [D]. A conda `conda.bat` must be replaced by that env's `python.exe`.

### 4.2 Interpreter resolution (ordered, each candidate validated by *running it*)
1. `mpyWorkbench.pythonPath` (expand `${workspaceFolder}`, `${env:X}`, `~`). If set and broken: report why, do **not** silently fall back.
2. Workspace virtual env: for `.venv`, `venv`, `env` try **both** layouts (`Scripts\python.exe`, `bin/python`; `venvCandidates`); require `pyvenv.cfg` and a successful probe (X-16).
3. Python extension's selected environment (`environments.getActiveEnvironmentPath(uri)` then `resolveEnvironment`), with change events (X-15).
4. Windows: `py -3` once, converted to the absolute `sys.executable`; then directory scans of `%LOCALAPPDATA%\Programs\Python\Python3*` and `%ProgramFiles%\Python3*`. macOS: `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `/Library/Frameworks/Python.framework/Versions/Current/bin/python3`, last `/usr/bin/python3` (CLT shim). Linux: `python3` via PATH.
5. Nothing found -> one actionable message with the platform-specific install hint; no probing cascade, no Store popups (X-12).

Probe argv: `[interp, ...pre, "-I", "-X", "utf8", "-c", "import sys; print(sys.version_info[:3], sys.executable)"]`, 5 s timeout, `windowsHide`. Minimum supported Python is a decision for the owner; `mpremote 1.29.0` declares `Requires-Python >=3.4` but depends on `platformdirs>=4.3.7` (modern releases need >= 3.9-3.11), so treat **3.9** as the practical floor and test 3.9 and the newest in CI.

### 4.3 Run mpremote hermetically (recommended default)
`vendoredMpremoteArgv()` builds: `<python> [-3] -I -X utf8 -u -c "import sys; sys.path.insert(0, sys.argv.pop(1)); from mpremote.main import main; sys.exit(main())" <vendorDir> <mpremote args...>`.
- **Executed on macOS**: system Python 3.15 with *no* mpremote installed ran `version` and `exec` against the fake board while the environment carried `PYTHONPATH=/nonexistent`, `PYTHONIOENCODING=cp1252`, `PYTHONSTARTUP=/nonexistent/startup.py`. `-I` makes it independent of the student's Python env vars and user-site packages; the vendor directory is a plain argv element (no quoting problems for `C:\Users\Ana María\...`).
- Vendored set = `mpremote 1.29.0` + `pyserial 3.5` + `platformdirs` unpacked **with their `*.dist-info`** (so `importlib.metadata` reports the real version): 76 files, no `.so/.pyd`, i.e. identical on macOS arm64/x64, Windows x64/arm64, Linux. Mark it `[E]` for mac; Windows behaviour of the same pure-Python tree is expected but unverified (`ctypes` is used by pyserial's Windows backend; present in python.org/Store builds and in the embeddable zip).
- Keep "use mpremote from the selected environment" as an opt-in setting, with the `mpremote >= 1.29.0` check (X-22, X-37).

### 4.4 One owner for the serial port
- A `PortBroker` with a promise-chain mutex per port: every board operation is queued, never preempted; "Cancel" fails the queue and tree-kills the current child. The REPL terminal is just another lease holder: acquiring the port for a file operation means *closing the REPL process (Ctrl-]) and re-creating a new terminal afterwards through the API*, never typing into the old one (section 3.3).
- Before reporting "busy": (1) is the node/COM present in `connect list`; (2) do we hold it (pid set); (3) Linux: `access(R_OK|W_OK)` and `dialout` membership; (4) Windows: is the driver present (X-34). Only then retry with 100-500 ms jittered backoff.
- Port choice: store `{vid,pid,lastPort}` per user (not in settings.json), auto-pick when exactly one candidate matches, canonicalise macOS `tty.*` -> `cu.*`, hide `0000:0000` entries (X-30/31/36).
- Stop: Ctrl-C into the owner -> 1.5 s grace -> tree-kill -> wait until the port can be opened -> optional `soft-reset`.

### 4.5 Paths
- Device paths are always POSIX, absolute, normalised, traversal-free (`relToDevice`), produced from local paths **only** through `localToRel` (`path.relative` + `split(path.sep)`; rejects other drive / other UNC share / `..`). No `startsWith` comparisons between `fsPath`s, no string concatenation with `/` or `\`.
- Use `vscode.Uri.file(p).fsPath` / `path` for local paths, `path.posix` for device paths. Unit tests inject `path.win32` for drive letters, UNC, case differences, spaces and non-ASCII.
- Ignore rules: one built-in default list always on (X-53) + user file, evaluated with the `ignore` package, `ignorecase` on win32/darwin.
- State/caches in `context.storageUri`; project-resident files written atomically with retries (X-55).

### 4.6 Error taxonomy (classify on stable tokens, never on prose)
| Signal (regex on stderr / spawn error) | Class | Meaning / user message |
|---|---|---|
| spawn `ENOENT` / `EINVAL` | `INTERPRETER_MISSING` | Interpreter path wrong or a `.cmd` shim (show how it was resolved) |
| `No module named '?mpremote` | `MPREMOTE_MISSING` | Only possible in "installed" mode |
| `failed to access (\S+)` | `PORT_OPEN_FAILED` | busy **or** gone **or** permission: run the probes in 4.4 |
| `Could not exclusively lock port` / `\[Errno (11\|16\|35)\]` / `PermissionError\(13` / `Access is denied` | `PORT_BUSY` | Another process owns the port (REPL/IDE/serial monitor/orphan) |
| `no device found` | `NO_DEVICE` | `connect auto` found no USB serial port |
| `could not enter raw repl` | `NOT_RESPONDING` | Wrong port (Bluetooth), board crashed, other baud, program ignoring Ctrl-C |
| `Device not configured` (macOS errno 6) / `Input/output error` (Linux errno 5) / `ClearCommError failed` / `WriteFile failed` / `device disconnected` | `DEVICE_GONE` | Cable pulled or board re-enumerated |
| `unrecognized arguments` / process exit 2 | `CONTRACT_BROKEN` | Our bug or mpremote drift: report loudly (Appendix B test) |
| device-side `OSError: [Errno 2] ENOENT` / host-formatted `No such file or directory` | `FILE_NOT_FOUND` | (mpremote translates device errnos through `mp_errno.MP_ERRNO_TABLE` and prints the *host* C-library text; on Windows that text is English, but pyserial's `WinError` text is localised, hence the errno-based tokens above) |
| `EEXIST`, `ENOTEMPTY`, `EROFS`, `ENOSPC` | `EXISTS`, `NOT_EMPTY`, `READ_ONLY`, `NO_SPACE` | direct messages |

### 4.7 Terminals
- Run file / REPL: `createTerminal({ name, shellPath: <python>, shellArgs: [...argv], env, cwd })`; closing the terminal kills the pty tree (ConPTY / pty), which also frees the port. Let `onDidCloseTerminal` clear state; re-create instead of reuse when the process has exited.
- `TerminalOptions.shellArgs` may also be a single command-line string, on Windows only; use the array form so VS Code quotes per platform [D].
- Remember mpremote's REPL/console code needs a real console: `ConsolePosix.__init__` calls `termios.tcgetattr(stdin)`, `ConsoleWindows` uses `msvcrt.kbhit()/getch()` (console.py:20-33, 115-134 in 1.29.0), so a REPL can never be hosted on pipes.
- To read output programmatically (e.g. to clear a "running" state when the program ends) use a `Pseudoterminal` that owns a spawned child, or `terminal.shellIntegration` execution events (VS Code >= 1.93) - decision for the REPL/run owner.

### 4.8 Atomic file writes
`atomicWrite(path, data)`: write `path.tmp-<pid>` in the same directory, `fsync`, `rename` over the target; on Windows retry 5x with 50-200 ms backoff on `EBUSY|EPERM|EACCES`. Same retry wrapper for `fs.rm` (`maxRetries`) and for deleting `.mpy-workbench`.

### 4.9 Diagnostics bundle (replaces CI that we do not have on Windows)
A command `MPY: Copy Diagnostics` (also run automatically on first failure) that collects, with no secrets: OS/arch/release, VS Code version, `remoteName`, Node version, default terminal profile, how the interpreter was resolved (each candidate and why it was rejected), `sys.version`/`sys.executable`/`sys.flags.utf8_mode`, vendored or installed mpremote + pyserial versions, the first 5 PATH entries, `connect list` verbatim, OS-level USB listing (4.4/X-34), workspace path properties (spaces, non-ASCII, UNC, OneDrive/iCloud, > 200 chars), results of a 10-step self-test (spawn+kill-tree, atomic write, path round-trip, `version`, `connect list`, and with a board: `exec print(1)`, `fs ls`, upload+hash+delete of a 100-byte file). A student can paste this into an email; the teacher sees the Windows failure without owning a Windows box.

## 5. Automation strategy

### 5.1 What can be automated, by tier
| Tier | What | How | Runs on | Catches |
|---|---|---|---|---|
| 0 Static | Source guard (Appendix C), `tsc --noEmit`, ESLint `no-restricted-imports` for `child_process` | CI script | all | X-01..07, 40, 41, 50 |
| 1 Pure unit | path mapping, argv builders, env builder, interpreter-candidate generation (inject `platform`, `path`, `exists`), `parseConnectList` fixtures (macOS output captured here; Windows/Linux synthesised from mpremote's format string), error classifier fixtures (incl. localised Windows strings), ignore matcher fixtures, version parsing, `killTreeCommand` | `node --test` or vitest, **no `vscode` import** (modules must not have import-time side effects, X-42) | all | X-10..15, 21, 23, 30, 31, 50-54, 61 |
| 2 Real-process unit | `killTree` with a real grandchild (Python sleeping child); spawn with args containing spaces/quotes/`%`/`^`/unicode/newline and assert the child sees them verbatim; atomic write under a concurrent reader; stdout CRLF handling; `windowsHide` smoke | `node --test` | **all three OS** (this is where Windows-only bugs surface) | X-04, 06, 41, 55 |
| 3 mpremote contract | Appendix B: every subcommand/flag the extension emits is accepted and implemented, against the pinned and the latest mpremote | `pytest` with a recording fake transport (no port) | all | X-60 (4 hits today) |
| 3b Fake board e2e | real `mpremote` -> `socket://127.0.0.1:<port>` -> `fakeboard.py` (raw-REPL + raw-paste responder; Appendix A). mpremote >= 1.27 accepts any pyserial URL (`serial_for_url(do_not_open=True)`; 1.26 only `rfc2217://`), so this works on Windows runners too. Executed: `exec print(6*7)` -> rc 0, `42\r\n`. Extend by running a real MicroPython unix-port behind the socket (`socat TCP-LISTEN:...,fork EXEC:micropython,pty,raw` on Linux/macOS only) for `fs` coverage | pytest/node | all (fake) + Linux/macOS (unix port) | end-to-end plumbing, stop/kill, timeouts, CRLF |
| 4 Extension host | `@vscode/test-cli` opens a fixture workspace with spaces + non-ASCII path, activates the extension, runs commands against Tier-3b board, asserts views/commands/terminals exist and no unregistered commands (manifest vs `registerCommand` cross-check - the script I used finds 10 today) | mocha in VS Code | all (xvfb on Linux) | activation errors, dead menu entries, X-62, X-71 |
| 5 Hardware | the manual matrix (section 7), partly scriptable with a CP2102 ESP32 on the teacher's Mac (nightly local run) and a Windows VM with USB pass-through | human / script | mac + Windows VM | X-30, 32, 34, 37, 43 |

### 5.2 Running Windows without a Windows CI box today
- The teacher's Mac is **Intel x86_64** and already has **VMware Fusion** installed with a VM named `Windows 10 x64.vmwarevm` in `~/Virtual Machines.localized` (seen while listing directories; I did not open, start or modify it). A Windows 10/11 **x64** VM with the CP2102 attached via VMware's USB pass-through reproduces the class environment closely (COM port, driver via Windows Update, PowerShell/cmd, ConPTY, Defender). Note that while the board is passed through to the VM, macOS cannot see it (and vice-versa), so run the Windows column and the macOS column in separate sessions. Test the matrix there before each release; keep the VM snapshot "clean Windows + VS Code only" and a second "with python.org 3.12 + PATH".
- When the repo is on GitHub, Tier 0-4 run on `windows-latest` (and `macos-latest` arm64, plus an Intel macOS label if still offered - verify labels at wiring time) via Appendix D.
- Until then the diagnostics bundle (4.9) is the Windows eyes.

### 5.3 Test hygiene rules
- Fixtures containing paths use all of: a space, a parenthesis, an accented letter, a non-BMP character (`😀`), and a 200+ character total path on Windows.
- Run the Windows jobs with the runner's default (non-UTF-8) code page; do **not** set `PYTHONUTF8` in the job env (we want to catch encoding bugs, X-22).
- Every bug found manually on Windows gets a Tier-1/2 regression test before the fix.

## 6. GitHub Actions (proposal, not wired into any repo yet)
See Appendix D for the workflow (YAML syntax-checked with PyYAML). Jobs: `unit` (3 OS x Python 3.9/3.13), `hostile-paths` (macOS + Windows, fixture copied to `.../Ana María Núñez/ME 201 - lab 1 (é)`), `vscode` (3 OS, `xvfb-run` on Linux), `package` (VSIX hygiene: no `.venv`, `node_modules`, `.pyc`, absolute home paths, size cap). Add a weekly scheduled run against **latest mpremote/pyserial** to detect drift (Appendix B).

## 7. Manual test matrix (Windows + macOS)

### 7.1 Setup shared by all rows
- **Machines**: Win10 x64, Win11 x64 (VM acceptable), macOS Intel, macOS Apple silicon (columns W10 / W11 / mI / mA). Optional rows for Linux are marked (L).
- **Board**: ESP32 DevKit with CP2102 (UART bridge) running MicroPython; optional second board with CH340 and an ESP32-S3 (native USB) for B2/D13.
- **Software to record**: OS build, VS Code version, extension build id, Python version and source (python.org / Store / Homebrew / `py`), mpremote version and whether vendored.
- **Fixture workspace `ME 201 - lab 1 (é)`** (create once, copy to each machine; keep a second copy under a OneDrive/iCloud folder for A12):
  ```
  main.py            print("hello °C µs →"); import app; app.run()
  app.py             imports lib.sensor; def run(): ... prints 3 lines and returns
  loop.py            counter loop with time.sleep(0.5), runs forever
  blink.py           prints "done" and exits
  Main.py            (case test; Windows cannot hold both Main.py and main.py - create it only on the board for C9)
  notes tree.py      file name contains "tree" and a space
  tools.py           file name contains "ls"
  lib/sensor.py      def read(): return 42
  data/température.csv   non-ASCII name, CRLF line endings
  desktop.ini  ._junk.py  Thumbs.db  .DS_Store   (must never be uploaded)
  .venv/             created per scenario
  ```
- Mark each cell: P (pass), F (fail, add note), N/A. Screenshot or paste the diagnostics bundle on any F.

### 7.2 A - Environment and interpreter discovery
| ID | Scenario | Steps | Expected | W10 | W11 | mI | mA |
|---|---|---|---|---|---|---|---|
| A1 | Fresh python.org Python, *Add to PATH* ticked, no venv | Install VS Code + extension, open fixture, click Select Port | Interpreter found automatically; vendored mpremote used; no install prompt needed | ☐ | ☐ | n/a | n/a |
| A2 | Microsoft Store Python only | Same | Found (absolute path), works; no Store window opens | ☐ | ☐ | n/a | n/a |
| A3 | python.org Python **without** PATH (only `py`) | Same | Found via `py -3`; works after VS Code restart not required | ☐ | ☐ | n/a | n/a |
| A4 | No Python at all | Open fixture | One actionable message with download link; **no** Microsoft Store popup; no stack trace | ☐ | ☐ | ☐ | ☐ |
| A5 | Project `.venv` created with `python -m venv .venv` and `pip install mpremote` (the user's setup) | Launch VS Code from Start menu / Dock (not from a terminal); open fixture; connect | `.venv` interpreter used (check diagnostics: "resolved via workspace venv"); no PATH dependence | ☐ | ☐ | ☐ | ☐ |
| A6 | `.venv` exists but **without** mpremote | Same | Works with vendored mpremote, or clear "not installed" with fix offered | ☐ | ☐ | ☐ | ☐ |
| A7 | macOS Homebrew Python (PEP 668), no venv | Install flow | No `externally-managed-environment` error shown to the student | n/a | n/a | ☐ | ☐ |
| A8 | Fresh Mac without Command Line Tools | Open fixture | No unexpected "install developer tools" dialog from a probe; clear message if no Python | n/a | n/a | ☐ | ☐ |
| A9 | `python.defaultInterpreterPath = ${workspaceFolder}/.venv/...` committed in `.vscode/settings.json` | Open on each OS | Resolved on both layouts (`Scripts\python.exe`, `bin/python`) | ☐ | ☐ | ☐ | ☐ |
| A10 | Folder with a `.venv` made on the *other* OS (zip from Mac to PC and back) | Open | "venv created on a different OS/machine - recreate" with one-click fix; no cryptic ENOENT | ☐ | ☐ | ☐ | ☐ |
| A11 | User name and project path with spaces and accents (`C:\Users\Ana María\...`, `/Users/Ana Lee/...`) | Run C1, C2, D1 | All pass | ☐ | ☐ | ☐ | ☐ |
| A12 | Workspace under OneDrive (Win) / iCloud Desktop&Documents (mac) | Run C4, C5, D1, F3 | No EBUSY/EPERM loops; cache files not created in the project; diagnostics notes the sync folder | ☐ | ☐ | ☐ | ☐ |
| A13 | Workspace on UNC share or mapped drive (`H:\`, `\\server\share`) | Run C1, D1 | Works (no `cmd.exe` cwd problems) | ☐ | ☐ | n/a | n/a |
| A14 | Change interpreter (`Python: Select Interpreter`) while VS Code is open | Switch venv A -> venv B | Next operation uses B without reload | ☐ | ☐ | ☐ | ☐ |
| A15 | Windows PowerShell policy *Restricted* (default on client SKUs) | Open integrated terminal; Run file | No dependence on `Activate.ps1`; Run/REPL still work | ☐ | ☐ | n/a | n/a |

### 7.3 B - Ports and drivers
| ID | Scenario | Steps | Expected | W10 | W11 | mI | mA |
|---|---|---|---|---|---|---|---|
| B1 | Port picker | Plug board; open picker (on macOS with Bluetooth on) | Board first and labelled; Bluetooth/pseudo ports hidden or last; single candidate auto-selected | ☐ | ☐ | ☐ | ☐ |
| B2 | Board plugged, driver missing (CH340 fresh image / offline PC) | Open picker | "Board not listed" help with driver links and OS-level evidence; no "install mpremote" message | ☐ | ☐ | ☐ | ☐ |
| B3 | COM number >= 10 | Force COM12 in Device Manager | Works for ls/cp/run/REPL | ☐ | ☐ | n/a | n/a |
| B4 | Replug into another USB port | Unplug/plug | Extension re-resolves (new COM / new `cu.usbserial-*`) with no manual reselect when only one board | ☐ | ☐ | ☐ | ☐ |
| B5 | Two serial devices attached | Plug a 2nd board / adapter | Explicit selection required; never silently picks the wrong one | ☐ | ☐ | ☐ | ☐ |
| B6 | Unplug during idle, then during an upload | Pull cable | Clear "disconnected" state; no hung spinner; replug recovers **without restarting VS Code** | ☐ | ☐ | ☐ | ☐ |
| B7 | macOS USB-accessory approval (Apple silicon, macOS 13+) / Linux `dialout` | First plug of a new board | Help text explains the prompt/group; (L) permission error classified as such | n/a | n/a | n/a | ☐ |
| B8 | Persistence | Select port, quit VS Code, reopen | Port auto-restored when the same board is present | ☐ | ☐ | ☐ | ☐ |

### 7.4 C - Files and sync
| ID | Scenario | Steps | Expected | W10 | W11 | mI | mA |
|---|---|---|---|---|---|---|---|
| C1 | List tree | Open Files view; board has `/lib`, `notes tree.py`, `tools.py`, `données.txt` | All entries present incl. names containing "tree"/"ls"; dirs vs files correct | ☐ | ☐ | ☐ | ☐ |
| C2 | Upload nested file | Upload Active File on `lib/sensor.py` (Windows!) | Board shows `/lib/sensor.py` (a folder `lib`), **not** a root file named `lib\sensor.py` (X-50) | ☐ | ☐ | ☐ | ☐ |
| C3 | Download with unicode name and CRLF | Open `data/température.csv` from board | Correct name; bytes unchanged (compare hash) | ☐ | ☐ | ☐ | ☐ |
| C4 | Sync all local -> board, 50 files in 5 folders | Run; note elapsed time; **watch the screen** | Completes; time recorded (target budget in plan.md); no console windows flash (X-06); junk files skipped | ☐ | ☐ | ☐ | ☐ |
| C5 | Sync all board -> local into a path with spaces | Run | Files land under the fixture; reserved/illegal names reported, not fatal | ☐ | ☐ | ☐ | ☐ |
| C6 | Delete non-empty folder on board | Right-click delete | Gone on board and in view | ☐ | ☐ | ☐ | ☐ |
| C7 | Rename file/folder on board | Rename | Actually renamed on board (X-60: `fs mv` is a silent no-op today) | ☐ | ☐ | ☐ | ☐ |
| C8 | Auto-sync on save while REPL is open | Enable, edit+save `app.py` | Uploaded; REPL still usable afterwards | ☐ | ☐ | ☐ | ☐ |
| C9 | Case rules | `Main.py` on board only; local `Lib/` folder | Warning about `main.py` / `/lib` case; no silent mismatch | ☐ | ☐ | ☐ | ☐ |
| C10 | Junk files | Sync all with `desktop.ini`, `Thumbs.db`, `._junk.py`, `.DS_Store`, `.venv/` present | None uploaded | ☐ | ☐ | ☐ | ☐ |
| C11 | Locked local file during download | Open target in another program with exclusive lock (Excel/AV scan) | Clear per-file error, others continue | ☐ | ☐ | n/a | n/a |
| C12 | Large file (200 KB) upload | Upload | Progress; completes; hash matches | ☐ | ☐ | ☐ | ☐ |
| C13 | Reserved Windows name on board (`aux.py`, `con.py`) | Create via REPL; sync down | Skipped with explanation | ☐ | ☐ | n/a | n/a |

### 7.5 D - Run, REPL, Stop
| ID | Scenario | Steps | Expected | W10 | W11 | mI | mA |
|---|---|---|---|---|---|---|---|
| D1 | Run current file (root script) | Open `blink.py`, Run | Output appears in a terminal; `°C µs →` correct; returns to idle | ☐ | ☐ | ☐ | ☐ |
| D2 | Run nested file importing sibling, path with spaces | Run `app.py` | Runs the **saved local** content (edit a string, save, run: new text appears) | ☐ | ☐ | ☐ | ☐ |
| D3 | Infinite loop + Stop x10 | Run `loop.py`, press Stop, repeat 10x quickly | Program halts each time; **no orphan python process** (Task Manager / `ps`); next Run works; port never "busy" | ☐ | ☐ | ☐ | ☐ |
| D4 | Run while REPL is open | Open REPL, then Run | Either works via suspend/resume or a clear message; no hang | ☐ | ☐ | ☐ | ☐ |
| D5 | REPL interaction | Open REPL; `print(1+1)`; Ctrl-C; Ctrl-D; exit with Ctrl-] | Prompt appears without manual Ctrl-C; keys work; clean exit; port released | ☐ | ☐ | ☐ | ☐ |
| D6 | REPL reliability | Open/close REPL 20x (first one right after reboot = cold) | 20/20 show a prompt; record any traceback ("KeyboardInterrupt" at start = X-43) | ☐ | ☐ | ☐ | ☐ |
| D7 | REPL + file operation | Open REPL, upload a file | REPL available again afterwards (new terminal if needed) | ☐ | ☐ | ☐ | ☐ |
| D8 | Non-ASCII output | `print("°C µ Ω → é")` in REPL and in Run | Rendered correctly, no `Unicode*Error` (Windows legacy console / mpremote < 1.29 fails) | ☐ | ☐ | ☐ | ☐ |
| D9 | Interrupt and Soft Reset buttons | During `loop.py` press Interrupt, then Soft Reset | Prompt returns; board reboots softly; uptime counter (`time.ticks_ms()`) does **not** restart | ☐ | ☐ | ☐ | ☐ |
| D10 | Default terminal profile | Set default to PowerShell 5.1, PowerShell 7, cmd, Git Bash (Win) / zsh, bash, fish (mac) and repeat D1+D5 | Identical behaviour (extension never types into the shell) | ☐ | ☐ | ☐ | ☐ |
| D11 | Reload/close window while a program runs | Run `loop.py`; `Developer: Reload Window`; also close VS Code | No surviving `python`/`mpremote` process holding the port; Run works right after | ☐ | ☐ | ☐ | ☐ |
| D12 | Unsynced edit | Auto-sync off; edit `blink.py`, save, Run | Executes the new local code (does not import a stale board copy; X-60) | ☐ | ☐ | ☐ | ☐ |
| D13 | Hard reset of native-USB board (optional ESP32-S3) | Press Hard Reset | Waits for the port to return (possibly a new COM) and reconnects | ☐ | ☐ | ☐ | ☐ |

### 7.6 E - Linting and IntelliSense (platform aspects only; content is another analyst's)
| ID | Scenario | Steps | Expected | W10 | W11 | mI | mA |
|---|---|---|---|---|---|---|---|
| E1 | Generated settings are portable | Inspect `.vscode/settings.json` | Only `${workspaceFolder}`-relative forward-slash paths; open the same folder on the other OS: still resolves | ☐ | ☐ | ☐ | ☐ |
| E2 | Pylance resolves `machine`, `network` and the custom frozen module | Open `main.py` | No unresolved-import squiggles | ☐ | ☐ | ☐ | ☐ |
| E3 | Settings file edit preserves user comments/CRLF | Add a comment to settings.json, regenerate | Comment and line endings preserved | ☐ | ☐ | ☐ | ☐ |

### 7.7 F - Install, lifecycle, security
| ID | Scenario | Steps | Expected | W10 | W11 | mI | mA |
|---|---|---|---|---|---|---|---|
| F1 | Install VSIX in a clean profile | `code --install-extension x.vsix --profile Temp` | Installs; size within cap; no `.venv`/node_modules inside | ☐ | ☐ | ☐ | ☐ |
| F2 | Upgrade keeps settings and chosen port | Install new over old | Settings intact | ☐ | ☐ | ☐ | ☐ |
| F3 | Disable/uninstall while running | Run `loop.py`, disable extension | No orphan process; port free | ☐ | ☐ | ☐ | ☐ |
| F4 | WSL / Remote window (Win) | Open folder via WSL | Explains that serial needs a local window; no silent failure | ☐ | ☐ | n/a | n/a |
| F5 | Untrusted workspace | Open a zip containing `.vscode/settings.json` with `mpyWorkbench.pythonPath` set to a script | Restricted mode: setting ignored, nothing executes | ☐ | ☐ | ☐ | ☐ |

### 7.8 G/H - Locale, hostile environments, performance
| ID | Scenario | Steps | Expected | W10 | W11 | mI | mA |
|---|---|---|---|---|---|---|---|
| G1 | Non-English Windows display language | Cause a busy port (open REPL elsewhere), run an op | Classified as "port busy" (not a raw localised string) | ☐ | ☐ | n/a | n/a |
| G2 | Cold-start / AV load | Reboot, first connect, Defender scanning | Succeeds within timeouts; no spurious KeyboardInterrupt | ☐ | ☐ | n/a | n/a |
| G3 | Locked-down lab PC (no admin, no internet, AppLocker) | Install from VSIX only | Works with vendored mpremote; or precise message about what is blocked | ☐ | ☐ | n/a | n/a |
| H1 | Timing baseline | Time `ls /`, upload 10 KB, run `blink.py` (stopwatch) | Record seconds per OS; compare to budget | ☐ | ☐ | ☐ | ☐ |
| H2 | DTR/RTS reset behaviour | In REPL: `import time; t=time.ticks_ms()`; exit; run `fs ls` via extension; reopen REPL and compare `time.ticks_ms()` | Ticks keep counting (no hardware reset) on every OS. A restart = open/close pulses reset the board (X-37) | ☐ | ☐ | ☐ | ☐ |
| H3 | Diagnostics bundle | Run `Copy Diagnostics` | Contains every field listed in 4.9; no secrets | ☐ | ☐ | ☐ | ☐ |

## 8. Requirements to carry into `plan.md` (cross-platform acceptance criteria)
- [ ] XP-01 No `child_process.exec/execSync`, no `shell:true`, no shell strings typed into terminals anywhere; CI guard (Appendix C) is green.
- [ ] XP-02 One `proc.ts` launches every process: argv arrays, `windowsHide:true`, explicit env, timeout, live-children registry, tree-kill on cancel/deactivate/dispose, stale-pid reaper at start-up.
- [ ] XP-03 Interpreter resolver per 4.2, pure and unit-tested with injected `platform/path/exists/exec`; resolution reason recorded; explicit setting never silently overridden; Store-alias and `py -3` handled.
- [ ] XP-04 mpremote is pinned (>= 1.29.0; vendored pure-Python wheels with dist-info, launched hermetically per 4.3) and the contract test (Appendix B) passes against it; weekly job against latest.
- [ ] XP-05 Run file and REPL terminals use the interpreter as `shellPath` (array `shellArgs`), carry UTF-8 env, work identically under PowerShell/cmd/Git Bash/zsh/bash/fish default profiles.
- [ ] XP-06 Stop = Ctrl-C to owner -> grace -> tree-kill -> verify port free; no write to a device node from a shell, ever; no orphan processes after Stop x10, reload, close, disable.
- [ ] XP-07 Single port broker with queue (no preempt), classification per 4.6, probes for busy/missing/permission/driver, retry only after classification.
- [ ] XP-08 Port picker parses `vid:pid`, hides pseudo/Bluetooth ports, ranks known bridges, canonicalises macOS `tty.*` -> `cu.*`, persists the choice per user, never resets it at activation, recovers after replug.
- [ ] XP-09 Path mapping is pure: `localToRel`, `relToDevice`, `deviceToRel` (Appendix A) with win32/posix tests for drive letters, UNC, case, spaces, unicode, `..`.
- [ ] XP-10 Built-in default ignore list (venv, OS junk, caches) always on; `ignore`-package semantics; case-insensitive on win32/darwin; warnings for `Main.py`/`Lib` case traps.
- [ ] XP-11 No state or cache files written into the user's project except the intentionally shared manifest; those are written atomically with Windows retry; `fs.rm` with `maxRetries`.
- [ ] XP-12 Downloads validate Windows names/lengths and report skips instead of aborting.
- [ ] XP-13 Device inspection through structured `exec` JSON (or library API), not scraping `fs tree`; never rely on `fs stat/run/mv` or `mkdir -p`.
- [ ] XP-14 Batch device operations (one process per operation, argv chunked below 8 KB, `resume` where needed); measured budget per OS recorded (T-H1).
- [ ] XP-15 `MPY: Copy Diagnostics` + self-test per 4.9.
- [ ] XP-16 Drivers/permissions help: "board not listed" flow for Windows, macOS accessory prompt, Linux dialout.
- [ ] XP-17 `untrustedWorkspaces: limited` with restricted configurations; `extensionKind`/remote detection with an explanatory message.
- [ ] XP-18 VSIX hygiene check (no venv/node_modules/pyc/absolute paths, size cap) in CI.
- [ ] XP-19 Tier 0-4 tests running in GitHub Actions on ubuntu/macOS/windows; Windows VM matrix (section 7) executed before each release until CI hardware tests exist.
- [ ] XP-20 All user-visible strings English (or l10n), never used as match keys.

## 9. Worth preserving from the old code
- Sidebar layout and the mirror-then-run workflow (views: Files / Board Actions / Sync utilities) - nothing in the UI shell is platform-hostile (`actions.ts`, `syncView.ts`, `decorations.ts`, `control.ts`, `types.ts`, most of `esp32Fs.ts` modulo X-62).
- The UTF-8 decision for child stdout (`PYTHONIOENCODING=utf-8`, mpremote.ts:133-140) - keep, and add `-X utf8` (X-22).
- `/\r?\n/` line splitting everywhere (correct for Python on Windows).
- POSIX-style manifest keys via `path.posix.join` (sync.ts:25) and `replace(/\\/g,'/')` in the matcher (sync.ts:120).
- The "use the configured interpreter with `-m`, don't depend on PATH" direction of HEAD - right idea, wrong launch layer.
- Pure helpers `toDevicePath`/`toLocalRelative` as a starting point (extend with validation).
- The clickable-traceback idea (`exec "import module"` when the file is on the board, CHANGELOG 0.2.62) - only valid once the existence check is real (X-60).
- Retry-with-backoff and "create missing parent dirs then retry" fallbacks - as behaviour, not as code.
- `mpremote fs cp` already skips identical files by SHA-256; exploit it for incremental sync.

## 10. Open questions and what I could not verify
Questions for the project owner:
1. Do student machines have Python already? Admin rights? Internet during install? (decides vendored-only vs embeddable CPython vs managed venv, X-13)
2. Boards in class: all CP2102/CH340 UART-bridge ESP32 (no native-USB S2/S3/C3)? (X-38, D13)
3. Windows default terminal profile in practice (PowerShell vs Git Bash)? Any WSL/Remote use? (X-02, X-71)
4. Are project folders kept in OneDrive/iCloud/network drives? (X-55, A12, A13)
5. Minimum Python (3.9?) and VS Code (>= 1.93 for shell-integration events?) to support.
6. Apple-silicon vs Intel student Macs, Windows ARM laptops?

Unverified claims (all flagged [D]/[I] above) and the cheapest way to settle them:
- X-01/02/03 on a real Windows host: run `T-C1`, `T-D1`; takes minutes in a Windows VM. (Strongly expected from cmd.exe/PowerShell semantics; not executed.)
- X-06 console flashes, X-12 Store stub behaviour, X-41 orphan python.exe on Windows (watch Task Manager during `T-D3` with the HEAD build).
- X-43 timing of the blind Ctrl-C (`T-D6` on Windows cold start).
- X-37 hardware reset on open/close for CP2102 on macOS/Windows (`T-H2`); needs a board, deliberately not done here.
- `createTreeView` on an undeclared view id: see activation log in an Extension Development Host.
- Whether the SiLabs or Apple driver serves the CP2102 here (name `cu.usbserial-0001` suggests the OS-bundled one).
- Linux dash `echo -e` behaviour (X-40e) - well documented, not run (no Linux host).
- Windows reserved-name/long-path behaviour (X-56) - documented, not run.

## Appendix A - Reference helpers (TypeScript, tested)

Run on macOS with `node --test`: 13 tests passed (path mapping with `path.win32`, env builder, argv builders, port-list parsing against the real macOS output, a real grandchild process-tree kill, hermetic vendored mpremote under a hostile environment). Pure modules: no `vscode` import, no import-time side effects.

### A.1 `xplat.ts`
```ts
// Reference cross-platform helpers (pure; platform/path injected so Windows branches are unit-testable on any OS).
import * as nodePath from "node:path";
import { spawn, ChildProcess } from "node:child_process";

export type PathMod = typeof nodePath.posix;           // posix and win32 share the same shape
export const pathFor = (platform: NodeJS.Platform): PathMod => (platform === "win32" ? nodePath.win32 : nodePath.posix);

/** Local absolute file -> POSIX-style path relative to workspace root, or undefined if outside the workspace. */
export function localToRel(wsRoot: string, file: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const p = pathFor(platform);
  const rel = p.relative(wsRoot, file);                 // case-insensitive on win32, handles drive-letter case
  if (rel === "") return "";
  if (p.isAbsolute(rel)) return undefined;              // different drive (D:\ vs C:\) or UNC share
  const parts = rel.split(p.sep);                       // never a regex on "\\" -> no escaping mistakes
  if (parts[0] === "..") return undefined;
  return parts.join("/");
}

/** POSIX-relative path + device root ("/" or "/lib") -> absolute device path. Throws on traversal. */
export function relToDevice(rel: string, root: string = "/"): string {
  const segs = rel.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) throw new Error(`path escapes device root: ${rel}`);
  const base = nodePath.posix.normalize("/" + root.trim());      // "lib" -> "/lib", "/lib/" -> "/lib/"
  return nodePath.posix.join(base, ...segs);                     // join drops trailing slash when segs present
}

export function deviceToRel(dev: string, root: string = "/"): string | undefined {
  const base = nodePath.posix.normalize("/" + root.trim()).replace(/\/+$/, "") ;
  const d = nodePath.posix.normalize(dev);
  if (base === "") return d.replace(/^\/+/, "");
  if (d === base) return "";
  return d.startsWith(base + "/") ? d.slice(base.length + 1) : undefined;
}

/** Copy env without the footgun of duplicate keys differing only by case on Windows (Path vs PATH). */
export function buildChildEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, set: Record<string, string>, drop: string[] = []): NodeJS.ProcessEnv {
  const ci = platform === "win32";
  const norm = (k: string) => (ci ? k.toUpperCase() : k);
  const dropSet = new Set(drop.map(norm));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !dropSet.has(norm(k))) out[k] = v;
  for (const [k, v] of Object.entries(set)) {
    for (const ek of Object.keys(out)) if (norm(ek) === norm(k)) delete out[ek];
    out[k] = v;
  }
  return out;
}

export interface Interpreter { command: string; preArgs: string[]; }

/** Candidate project-local interpreters, both layouts, so a repo shared between Windows and macOS resolves on each. */
export function venvCandidates(wsRoot: string, platform: NodeJS.Platform): string[] {
  const p = pathFor(platform);
  const rel = platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  return [".venv", "venv", "env"].map((d) => p.join(wsRoot, d, ...rel));
}

/** argv for an *installed* mpremote (user's venv): no shell, no quoting. -X utf8 + env PYTHONIOENCODING (both needed). */
export function mpremoteArgv(py: Interpreter, mpArgs: string[]): { file: string; args: string[] } {
  return { file: py.command, args: [...py.preArgs, "-X", "utf8", "-u", "-m", "mpremote", ...mpArgs] };
}

/** Bootstrap with no interpolated data: vendor dir arrives as argv[1], so nothing needs quoting or escaping. */
export const HERMETIC_BOOT = "import sys; sys.path.insert(0, sys.argv.pop(1)); from mpremote.main import main; sys.exit(main())";

/** argv for the *vendored* mpremote (pure-Python wheels unpacked in <ext>/vendor). -I = ignore PYTHON* env vars and user site,
 *  so a student's PYTHONPATH/PYTHONHOME/PYTHONSTARTUP/PYTHONIOENCODING cannot change behaviour; -X utf8 gives UTF-8 stdio. */
export function vendoredMpremoteArgv(py: Interpreter, vendorDir: string, mpArgs: string[]): { file: string; args: string[] } {
  return { file: py.command, args: [...py.preArgs, "-I", "-X", "utf8", "-u", "-c", HERMETIC_BOOT, vendorDir, ...mpArgs] };
}

/** How to kill a process tree. POSIX needs spawn({detached:true}) so the child leads a process group. */
export function killTreeCommand(pid: number, platform: NodeJS.Platform, force: boolean): { file: string; args: string[] } | { signalGroup: number; signal: "SIGTERM" | "SIGKILL" } {
  if (platform === "win32") return { file: "taskkill", args: ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])] };
  return { signalGroup: -pid, signal: force ? "SIGKILL" : "SIGTERM" };
}

export function killTree(child: ChildProcess, graceMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return resolve();
    const done = () => resolve();
    child.once("exit", done);
    const run = (force: boolean) => {
      const k = killTreeCommand(child.pid!, process.platform, force);
      if ("file" in k) spawn(k.file, k.args, { windowsHide: true, stdio: "ignore" }).on("error", () => {});
      else { try { process.kill(k.signalGroup, k.signal); } catch { /* already gone */ } }
    };
    run(false);
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) run(true); }, graceMs).unref();
  });
}
```

### A.2 `ports.ts`
```ts
export interface PortInfo { device: string; serial: string | null; vid: number; pid: number; description: string; likelyBoard: boolean; }

// VID values of USB-UART bridges / native-USB chips found on MicroPython boards used in classes.
const BOARD_VIDS = new Set([0x10c4 /*CP210x*/, 0x1a86 /*CH340/CH9102*/, 0x0403 /*FTDI*/, 0x303a /*Espressif native USB*/, 0x2e8a /*Raspberry Pi*/, 0x239a /*Adafruit*/, 0x2341 /*Arduino*/, 0xf055 /*MicroPython*/]);

/** Parses `mpremote connect list` ("{device} {serial} {vid:pid} {manufacturer} {product}"), tolerant of CRLF and "None". */
export function parseConnectList(stdout: string): PortInfo[] {
  const out: PortInfo[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const vid = parseInt(m[3], 16), pid = parseInt(m[4], 16);
    const desc = m[5].replace(/\bNone\b/g, "").replace(/\s+/g, " ").trim();
    out.push({ device: m[1], serial: m[2] === "None" ? null : m[2], vid, pid, description: desc || "Serial port", likelyBoard: BOARD_VIDS.has(vid) });
  }
  // USB devices first, known bridges before others, then natural order of the list; vid 0 (Bluetooth, pseudo-ttys) last
  return out.sort((a, b) => Number(b.likelyBoard) - Number(a.likelyBoard) || Number(b.vid !== 0) - Number(a.vid !== 0));
}
/** macOS exposes /dev/cu.X and /dev/tty.X for one device; always use the cu.* (callout) node. */
export function canonicalPort(device: string, platform: NodeJS.Platform): string {
  return platform === "darwin" ? device.replace(/^\/dev\/tty\./, "/dev/cu.") : device;
}
```

### A.3 Tests: `xplat.test.ts`
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { localToRel, relToDevice, deviceToRel, buildChildEnv, venvCandidates, mpremoteArgv, vendoredMpremoteArgv, killTree, killTreeCommand } from "./xplat";
import { execFileSync } from "node:child_process";

test("localToRel: win32 semantics simulated with path.win32", () => {
  assert.equal(localToRel("C:\\Users\\Ann Lee\\proj", "C:\\Users\\Ann Lee\\proj\\lib\\sensor.py", "win32"), "lib/sensor.py");
  assert.equal(localToRel("C:\\Users\\Ann\\proj", "c:\\users\\ann\\PROJ\\Main.py", "win32"), "Main.py");   // drive+dir case differences
  assert.equal(localToRel("C:\\proj", "D:\\usb\\x.py", "win32"), undefined);                                 // other drive
  assert.equal(localToRel("C:\\proj", "C:\\other\\x.py", "win32"), undefined);
  assert.equal(localToRel("\\\\srv\\share\\proj", "\\\\srv\\share\\proj\\a\\b.py", "win32"), "a/b.py");       // UNC
  assert.equal(localToRel("\\\\srv\\share\\proj", "\\\\other\\share\\x.py", "win32"), undefined);
});
test("localToRel: posix", () => {
  assert.equal(localToRel("/Users/ann lee/proj", "/Users/ann lee/proj/lib/é.py", "darwin"), "lib/é.py");
  assert.equal(localToRel("/p", "/p/../q/x.py", "darwin"), undefined);
  assert.equal(localToRel("/p", "/p/..hidden/x.py", "darwin"), "..hidden/x.py");   // not a traversal
});
test("relToDevice / deviceToRel", () => {
  assert.equal(relToDevice("lib/a.py"), "/lib/a.py");
  assert.equal(relToDevice("lib/a.py", "lib"), "/lib/lib/a.py");
  assert.equal(relToDevice("a.py", "/app/"), "/app/a.py");
  assert.throws(() => relToDevice("../x.py"));
  assert.equal(deviceToRel("/app/sub/a.py", "/app"), "sub/a.py");
  assert.equal(deviceToRel("/other/a.py", "/app"), undefined);
  assert.equal(deviceToRel("/a.py", "/"), "a.py");
});
test("buildChildEnv: no duplicate Path/PATH on win32", () => {
  const e = buildChildEnv({ Path: "C:\\x", SystemRoot: "C:\\Windows", PYTHONHOME: "C:\\bad" }, "win32", { PATH: "C:\\y;C:\\x" }, ["pythonhome"]);
  assert.deepEqual(Object.keys(e).sort(), ["PATH", "SystemRoot"]);
  const p = buildChildEnv({ Path: "a", PATH: "b" }, "linux", { PATH: "c" });
  assert.deepEqual(p, { Path: "a", PATH: "c" });                                  // case-sensitive OS keeps both
});
test("venvCandidates", () => {
  assert.equal(venvCandidates("C:\\p", "win32")[0], "C:\\p\\.venv\\Scripts\\python.exe");
  assert.equal(venvCandidates("/p", "darwin")[0], "/p/.venv/bin/python");
});
test("mpremoteArgv keeps py launcher args separate and never builds a string", () => {
  const a = mpremoteArgv({ command: "py", preArgs: ["-3"] }, ["connect", "COM12", "run", "C:\\Users\\Ann Lee\\a b.py"]);
  assert.deepEqual(a, { file: "py", args: ["-3", "-X", "utf8", "-u", "-m", "mpremote", "connect", "COM12", "run", "C:\\Users\\Ann Lee\\a b.py"] });
});
test("killTreeCommand shapes", () => {
  assert.deepEqual(killTreeCommand(42, "win32", true), { file: "taskkill", args: ["/pid", "42", "/T", "/F"] });
  assert.deepEqual(killTreeCommand(42, "linux", false), { signalGroup: -42, signal: "SIGTERM" });
});
test("killTree kills grandchildren (real processes, runs on the host OS)", async () => {
  // parent python spawns a grandchild that sleeps; we then kill the tree and check both pids are gone
  const code = "import subprocess,sys,time;g=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);print(g.pid,flush=True);time.sleep(60)";
  const py = process.env.PY ?? "python3";
  const child = spawn(py, ["-c", code], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const gpid: number = await new Promise((res) => child.stdout!.once("data", (d) => res(parseInt(String(d).trim(), 10))));
  assert.ok(gpid > 0);
  await killTree(child, 500);
  await new Promise((r) => setTimeout(r, 300));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(child.pid!), false, "child should be dead");
  assert.equal(alive(gpid), false, "grandchild must be dead too (it would hold the serial port otherwise)");
});

test("vendoredMpremoteArgv: vendor dir is a plain argv element (spaces/unicode need no quoting)", () => {
  const a = vendoredMpremoteArgv({ command: "py", preArgs: ["-3"] }, "C:\\Users\\Ana María\\ext dir\\vendor", ["connect", "COM3", "fs", "ls"]);
  assert.equal(a.args[0], "-3");
  assert.equal(a.args.indexOf("-c") + 2, a.args.indexOf("C:\\Users\\Ana María\\ext dir\\vendor"));
  assert.ok(!a.args.some((x) => x.includes("'") && x !== a.args[a.args.indexOf("-c") + 1]));
});
test("vendored mpremote really starts under a hostile environment (needs MPY_VENDOR + MPY_TEST_PYTHON)", { skip: !process.env.MPY_VENDOR }, () => {
  const { file, args } = vendoredMpremoteArgv({ command: process.env.MPY_TEST_PYTHON ?? "python3", preArgs: [] }, process.env.MPY_VENDOR!, ["version"]);
  const env = { ...process.env, PYTHONPATH: "/nonexistent", PYTHONIOENCODING: "cp1252", PYTHONSTARTUP: "/nonexistent/x.py" };
  assert.match(execFileSync(file, args, { env, encoding: "utf8" }), /^mpremote \d+\.\d+\.\d+/);
});
```

### A.4 Tests: `ports.test.ts`
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseConnectList, canonicalPort } from "./ports";

// Captured on this Mac with `mpremote connect list` (mpremote 1.29.0, pyserial 3.5), board plugged in.
const MAC = `/dev/cu.BLTH None 0000:0000 None None
/dev/cu.Bluetooth-Incoming-Port None 0000:0000 None None
/dev/cu.thinkplus-GM2pro None 0000:0000 None None
/dev/cu.usbserial-0001 0001 10c4:ea60 Silicon Labs CP2102 USB to UART Bridge Controller
`;
// Synthetic (format taken from mpremote/commands.py do_connect "list"); CRLF because Windows text-mode stdout translates \n.
const WIN = "COM1 None 0000:0000 None None\r\nCOM12 0001 10c4:ea60 Silicon Labs Silicon Labs CP210x USB to UART Bridge\r\nCOM4 5&2A3B 1a86:7523 wch.cn USB-SERIAL CH340\r\n";

test("macOS list: board first, Bluetooth pseudo-ports last and flagged not-board", () => {
  const p = parseConnectList(MAC);
  assert.equal(p[0].device, "/dev/cu.usbserial-0001");
  assert.equal(p[0].likelyBoard, true);
  assert.deepEqual(p.slice(1).map(x => x.likelyBoard), [false, false, false]);
  assert.equal(p[1].description, "Serial port");
});
test("Windows list with CRLF and COM12", () => {
  const p = parseConnectList(WIN);
  assert.deepEqual(p.map(x => x.device), ["COM12", "COM4", "COM1"]);
  assert.equal(p[0].description, "Silicon Labs Silicon Labs CP210x USB to UART Bridge");
});
test("canonicalPort", () => {
  assert.equal(canonicalPort("/dev/tty.usbserial-0001", "darwin"), "/dev/cu.usbserial-0001");
  assert.equal(canonicalPort("/dev/ttyUSB0", "linux"), "/dev/ttyUSB0");
});
```

### A.5 `fakeboard.py` - fake MicroPython board over a TCP socket (works with mpremote >= 1.27 on Windows, macOS, Linux)

Usage: `python fakeboard.py` (self-test), or import `start()` in a test and run `python -m mpremote connect socket://127.0.0.1:<port> exec "print(6*7)"`. Executed: rc 0, stdout `42
`.
```python
"""Minimal fake MicroPython board speaking the raw-REPL / raw-paste protocol over a TCP socket.
mpremote >= 1.27 accepts any pyserial URL, so:  mpremote connect socket://127.0.0.1:<port> exec "print(1+1)"
No serial port is involved, so this runs identically on Windows, macOS and Linux CI runners."""
import contextlib, io, socket, struct, sys, threading

def serve(sock, log):
    conn, _ = sock.accept()
    buf = b""; in_raw = False; pasting = False; paste = b""
    conn.settimeout(0.2)
    def send(b): log.append(("tx", b)); conn.sendall(b)
    try:
        while True:
            try: chunk = conn.recv(4096)
            except socket.timeout: continue
            except OSError: return                      # client closed / reset
            if not chunk: return
            log.append(("rx", chunk)); buf += chunk
            while buf:
                if pasting:
                    if b"\x04" not in buf: paste += buf; buf = b""; break
                    body, _, buf = buf.partition(b"\x04"); paste += body; pasting = False
                    send(b"\x04")                                             # ack end-of-paste
                    out, err = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        try: exec(paste.decode(), {})
                        except Exception as e: print(type(e).__name__, e, file=sys.stderr)
                    send(out.getvalue().replace("\n", "\r\n").encode() + b"\x04" + err.getvalue().encode() + b"\x04>")
                    paste = b""; continue
                if buf.startswith(b"\x05A\x01"): buf = buf[3:]; send(b"R\x01" + struct.pack("<H", 0xFFFF)); pasting = True; continue
                b, buf = buf[:1], buf[1:]
                if b == b"\x01": in_raw = True; send(b"raw REPL; CTRL-B to exit\r\n>")
                elif b == b"\x04" and in_raw: send(b"MPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>")
                elif b == b"\x02": in_raw = False; send(b"\r\nMicroPython fake\r\n>>> ")
                # \r, \x03 and anything else are ignored
    finally:
        conn.close()

def start():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1)
    log = []; t = threading.Thread(target=serve, args=(s, log), daemon=True); t.start()
    return s.getsockname()[1], log

if __name__ == "__main__":
    import subprocess
    port, log = start()
    r = subprocess.run([sys.executable, "-X", "utf8", "-m", "mpremote", "connect", f"socket://127.0.0.1:{port}", "exec", "print(6*7)"],
                       capture_output=True, timeout=30)
    print("rc =", r.returncode, "| stdout =", r.stdout, "| stderr =", r.stderr[-300:])
```

## Appendix B - mpremote contract test (pytest, no serial port)

Result against the old extension's command set (executed): `1.24.1` and `1.25.0` fail `fs tree, fs tree -s, fs mkdir -p, fs stat, fs run, fs mv`; `1.26.0` through `1.29.0` fail `fs mkdir -p, fs stat, fs run, fs mv`. Keep this file in the new project, replace `FS_CALLS` with the commands the new code really emits (generate it from the same table the code uses), run with the pinned and with the latest mpremote.
```python
"""Contract test: every mpremote invocation the extension builds must be (a) accepted by argparse and
(b) actually implemented (not a silent no-op). Uses a recording fake transport: NO serial port is opened.
Runs unchanged on Windows/macOS/Linux; pin MPREMOTE_VERSION in CI and also run against latest to detect drift."""
import contextlib, io
import pytest
from mpremote import main as m, commands as c

class Rec:
    mounted = False; in_raw_repl = True; device_name = "fake"
    def __init__(self): self.calls = []
    def _r(self, name, ret=None):
        self.calls.append(name); return ret
    def fs_exists(self, p): return self._r("fs_exists", False)
    def fs_isdir(self, p): return self._r("fs_isdir", p in ("", "/", "/lib"))   # tree needs a directory root
    def fs_listdir(self, p): return self._r("fs_listdir", [])
    def fs_mkdir(self, p): return self._r("fs_mkdir")
    def fs_rmfile(self, p): return self._r("fs_rmfile")
    def fs_rmdir(self, p): return self._r("fs_rmdir")
    def fs_touchfile(self, p): return self._r("fs_touchfile")
    def fs_hashfile(self, p, a): return self._r("fs_hashfile", b"\0" * 32)
    def fs_readfile(self, p, **k): return self._r("fs_readfile", b"")
    def fs_writefile(self, p, d, **k): return self._r("fs_writefile")
    def fs_printfile(self, p): return self._r("fs_printfile")
    def exec(self, *a, **k): return self._r("exec", b"/")

class St:
    def __init__(self): self.transport = Rec()
    def ensure_raw_repl(self, soft_reset=None): pass
    def did_action(self): pass

# (extension source location, args after "fs") -- everything the old extension passes to `mpremote ... fs ...`
FS_CALLS = [
    ("mpremote.ts:264 fs tree", ["tree"]),
    ("mpremote.ts:1621 fs tree -s", ["tree", "-s"]),
    ("mpremote.ts:805 fs ls", ["ls", "/lib"]),
    ("mpremote.ts:890 fs mkdir", ["mkdir", "/lib"]),
    ("mpremote.ts:948 fs mkdir -p", ["mkdir", "-p", "/lib/x"]),
    ("mpremote.ts:1119 fs cp -f", ["cp", "-f", __file__, ":x.py"]),
    ("mpremote.ts:1209 fs rm", ["rm", "/x.py"]),
    ("mpremote.ts:1250 fs rm -r", ["rm", "-r", "/lib"]),
    ("mpremote.ts:1221 fs rmdir", ["rmdir", "/lib"]),
    ("mpremote.ts:1294 fs stat", ["stat", "/x.py"]),
    ("mpremote.ts:1324 fs sha256sum", ["sha256sum", "/x.py"]),
    ("mpremote.ts:1460 fs run", ["run", "/x.py"]),
    ("mpremote.ts:1729 fs mv", ["mv", "/a.py", "/b.py"]),
]

@pytest.mark.parametrize("where,argv", FS_CALLS, ids=[w for w, _ in FS_CALLS])
def test_fs_subcommand_is_implemented(where, argv):
    p = m.argparse_filesystem(); p.prog = "fs"
    p.add_argument("next_command", nargs=m.argparse.REMAINDER)
    argv = list(argv)
    if argv[0] in ("ls", "tree") and sum(1 for x in argv if not x.startswith("-")) == 1:
        argv.append("")                       # same special case as mpremote.main.main()
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            a = p.parse_args(argv)
    except SystemExit as e:
        pytest.fail(f"{where}: argparse rejects {argv} (exit {e.code})")
    st = St()
    with contextlib.redirect_stdout(io.StringIO()):
        c.do_filesystem(st, a)
    assert st.transport.calls, f"{where}: `fs {argv[0]}` exits 0 but never touches the device (silent no-op)"
```

## Appendix C - Source guard (`check-xplat.mjs`)

Executed against the old `src/`: 25 blocking hits (no-exec 7, no-bare-python 6, no-echo-to-port 3, no-posix-quote 2, no-sendText-cmd 2, no-win-sep-regex 2, no-SIGKILL-only 2, no-env-SHELL 1) plus 1 warning (spawn without windowsHide). Expect a few false positives (for example the `getConfiguration("python")` section name); add an allow-comment mechanism when adopting it.
```js
#!/usr/bin/env node
// Cross-platform guard: fails CI when source reintroduces patterns that break on Windows or depend on the user's shell.
// Usage: node check-xplat.mjs <srcDir>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const RULES = [
  { id: "no-exec",         re: /\b(?:exec|execSync)\s*\(/,                        why: "string commands go through /bin/sh or cmd.exe; use spawn/execFile with an argv array" },
  { id: "no-shell-true",   re: /shell\s*:\s*true/,                                why: "re-introduces shell parsing/quoting differences" },
  { id: "no-sendText-cmd", re: /\.sendText\(\s*(?:`|cmd\b|[a-zA-Z_]*[cC]ommand\b)/, why: "typing a command string into the user's default shell (PowerShell/cmd/zsh/Git Bash) is not portable; set shellPath+shellArgs or use a Pseudoterminal" },
  { id: "no-echo-to-port", re: /echo\s+-e|>\s*\$\{[^}]*(?:port|Port)[^}]*\}/,    why: "POSIX-only, ignores baud/termios, can block on tty.* and corrupts the REPL" },
  { id: "no-posix-quote",  re: /replace\(\s*\/'\/g\s*,\s*"'\\\\''"/,              why: "POSIX single-quote escaping is invalid in cmd.exe and PowerShell" },
  { id: "no-bare-python",  re: /['"]python3?['"]/,                                why: "'python'/'python3' do not exist or are Store stubs on Windows; resolve an absolute interpreter" },
  { id: "no-env-SHELL",    re: /process\.env\.SHELL/,                             why: "undefined on Windows; wrong inside VS Code profiles" },
  { id: "no-win-sep-regex",re: /replace\(\s*\/\\\\\\\\\/g/,                      why: "regex /\\\\\\\\/ matches TWO backslashes; use path.sep split/join" },
  { id: "no-SIGKILL-only", re: /\.kill\(\s*['"]SIG(?:KILL|INT)['"]\s*\)/,         why: "on Windows kill() only ends the direct child; use a process-tree kill" },
  { id: "need-windowsHide",re: /\bspawn\s*\((?![^)]*windowsHide)/,                why: "console window flashes on Windows unless windowsHide:true", warn: true },
];
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : []; });
let bad = 0; const root = process.argv[2];
const tally = {};
for (const f of walk(root)) {
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const r of RULES) if (r.re.test(line)) { bad += r.warn ? 0 : 1; tally[r.id] = (tally[r.id] ?? 0) + 1; console.log(`${relative(root, f)}:${i + 1}: [${r.id}] ${r.why}`); }
  });
}
console.error(`\n${bad} blocking violation(s). Per rule:`, tally);
process.exit(bad ? 1 : 0);
```

## Appendix D - GitHub Actions workflow (proposal)

YAML parsed successfully with PyYAML; runner labels and action versions must be re-verified when it is wired. `npm run lint:xplat` = `node scripts/check-xplat.mjs src`; `npm run test:unit` = `node --test out/**/*.test.js`; `npm run test:vscode` = `vscode-test` (config below).
```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
permissions:
  contents: read

jobs:
  unit:
    name: unit (${{ matrix.os }}, py${{ matrix.python }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]   # add windows-11-arm / an Intel macOS label when available; verify labels at wiring time
        python: ["3.9", "3.13"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: actions/setup-python@v5
        with: { python-version: "${{ matrix.python }}" }
      - run: npm ci
      - run: npm run lint:xplat        # node scripts/check-xplat.mjs src  (blocks exec(), sendText(cmd), echo-to-port, ...)
      - run: npm run compile
      - run: npm run test:unit         # node --test out/**/*.test.js  (pure modules; no vscode import)
        env: { MPY_TEST_PYTHON: python }
      - run: python -m pip install pytest "mpremote==1.29.0"
      - run: python -m pytest python/tests -q   # helper-script tests with a fake transport; no serial port

  hostile-paths:
    name: spaces + unicode paths (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix: { os: [macos-latest, windows-latest] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: npm ci && npm run compile
      - name: copy fixture workspace to a hostile path
        shell: bash
        run: |
          d="$RUNNER_TEMP/Ana María Núñez/ME 201 - lab 1 (é)"
          mkdir -p "$d" && cp -R test/fixtures/workspace/. "$d/"
          echo "MPY_FIXTURE_WS=$d" >> "$GITHUB_ENV"
      - run: npm run test:unit -- --fixtures-from-env

  vscode:
    name: extension host (${{ matrix.os }})
    needs: unit
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix: { os: [ubuntu-latest, macos-latest, windows-latest] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: npm ci && npm run compile
      - name: run @vscode/test-cli
        if: runner.os == 'Linux'
        run: xvfb-run -a npm run test:vscode
      - name: run @vscode/test-cli
        if: runner.os != 'Linux'
        run: npm run test:vscode

  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci && npm run compile && npx vsce package -o ext.vsix
      - name: vsix hygiene
        run: |
          unzip -l ext.vsix | tee listing.txt
          ! grep -E '\.venv/|node_modules/|\.pyc|/Users/|C:\\\\Users' listing.txt
          test "$(stat -c %s ext.vsix)" -lt 6000000
```

`.vscode-test.mjs` for `@vscode/test-cli`:
```js
import { defineConfig } from '@vscode/test-cli';
export default defineConfig({
  files: 'out/test/**/*.vscode-test.js',
  version: 'stable',
  workspaceFolder: process.env.MPY_FIXTURE_WS ?? 'test/fixtures/workspace',
  launchArgs: ['--disable-extensions'],
  mocha: { timeout: 60000 },
});
```

## Appendix E - Raw evidence (condensed transcripts, macOS 15.7.8 x86_64, Node 26.5.0, Python 3.15.0, mpremote 1.29.0, pyserial 3.5)

Reproduction scripts lived in the session scratchpad (`.../scratchpad/exp`, `.../ref`), which is temporary; the essential ones are embedded above.

```text
# X-40  mpremoteCommands.ts:392 pattern, target = plain file instead of a serial device
exit error: null  stderr: ""
bytes written: 2d 65 20 03 03 0a      # "-e " + Ctrl-C Ctrl-C + LF ; macOS /bin/sh printed the -e and interpreted \x03

# X-10  real compiled pythonInterpreter.js, stubbed vscode, PATH=/usr/bin:/bin:/usr/local/bin
venv python runs and has mpremote? -> mpremote 1.29.0
no settings                                      => resolved: python3
mpyWorkbench.pythonPath = <venv python>          => resolved: python3
python.defaultInterpreterPath = <venv python>    => resolved: python3

# X-11 / X-10 side facts
execFile("py -3")           -> ENOENT spawn py -3 ENOENT
execFile(missing).message   -> "spawn definitely-not-a-python3 ENOENT"   (does not contain "not found")

# X-50  extension.ts:911 vs :1111 with path.win32.relative
relative            -> "lib\\sensor.py"
replace(/\\\\/g,"/") -> "/lib\\sensor.py"      (BUG: unchanged)
replace(/\\/g,"/")   -> "/lib/sensor.py"       (correct)

# X-05  pre-quoted argument through shellEscape
child argv: "/Users/x/my proj/main.py"     (literal double quotes survive)

# X-51  mpremoteCommands.ts toDevicePath / ignore matcher (real compiled code)
toDevicePath("sub\\a.py","/")  = "/sub\\a.py"       toDevicePath("a.py","lib") = "lib/a.py"
toDevicePath("D:/x.py","/")    = "/D:/x.py"         toDevicePath("../x.py","/") = "/../x.py"
ignored?  mod.pyc=false  build/x.py=true  .venv/Scripts/python.exe=false  secret.txt(**/secret.txt)=false
          Thumbs.db=true  thumbs.db=false  ._main.py=true  desktop.ini=false  BUILD/x.py=false

# X-30  mpremote connect list (enumeration only)
/dev/cu.BLTH None 0000:0000 None None
/dev/cu.Bluetooth-Incoming-Port None 0000:0000 None None
/dev/cu.thinkplus-GM2pro None 0000:0000 None None
/dev/cu.usbserial-0001 0001 10c4:ea60 Silicon Labs CP2102 USB to UART Bridge Controller
# old parser output: 4 entries, the first three named "Serial Port"; pyserial lists cu.* only, /dev/tty.* also exist

# X-60  recording fake transport, mpremote 1.29.0
['mkdir','-p','/lib/x']  EXIT 2: fs: error: unrecognized arguments: -p
['stat','/x']            exit-0, stdout 'stat :/definitely/not/there.py\n', no transport call
['mv','/a.py','/b.py']   exit-0, stdout 'mv :/a.py\nmv :/b.py\n', no transport call
['run','/x.py']          exit-0, stdout 'run :/x.py\n', no transport call

# X-41  exec() + kill('SIGKILL')
simple cmd   : workers before kill=1 after kill=0
compound cmd : workers before kill=2 after kill=1   <-- ORPHAN SURVIVES
zsh -lc      : workers before kill=2 after kill=1   <-- ORPHAN SURVIVES

# X-22  encodings
PYTHONIOENCODING=cp1252  print('├── a.py')           -> UnicodeEncodeError: 'charmap'
PYTHONIOENCODING=cp1252  python -X utf8 ...           -> still UnicodeEncodeError (env var wins)
PYTHONIOENCODING=utf-8                                -> ├── a.py
LC_ALL=C : stdout.encoding = ascii ; with -X utf8 = utf-8

# X-58 / X-03 baselines
python -X utf8 -m mpremote version   real 0.17 s (x3)        zsh -lc true   real 0.06 s (x3)

# manifest vs code
declared-but-not-registered commands: newFileBoardAndLocal newFileInTree newFolderInTree renameNode refreshPorts
  openFileFromLocal syncFileLocalToBoard syncFileBoardToLocal delete deleteBoardAndLocal
createTreeView ids: Fs, Actions, Sync, LocalFilesView ;  declared views: Fs, Actions, Sync
```

## Follow-up: Windows execution kit and VM run

Author: follow-up investigator (gap 6 of `10-completeness-critic.md`). Date 2026-10-12. Old tree read-only (`git status` in `mpy-workbench` still shows 0 changes); no serial port opened or enumerated; nothing installed globally. Evidence tags as above plus **[S]** = I read the source (file:line given), **[P]** = prediction written down *before* any Windows run (so the VM run can refute it), **[U]** unknown.

### F.0 Status in six lines

1. **Built** one self-contained Windows verification kit (Node + PowerShell + Python, 42 files, ~2,000 lines, 237 KB zip including offline wheels). It needs no serial port: the "board" is a TCP fake on `127.0.0.1` that the real `mpremote` 1.29.0 talks to via `socket://`.
2. **Tested its Node/Python parts on macOS** (full run 137 s, plus a relocated-copy run from a path with spaces and an accent). Every test module ran; the Windows-only tests skip with an explicit "n/a"; the POSIX controls pass; the harness was validated with positive controls (F.3).
3. **Did NOT run anything in the VMware Fusion VM.** The task allows that only with the user's approval. I am a subagent: nothing in my task text is the user's approval, and the user's relayed request never mentions the VM. So the three results tables below have the Windows column empty ("NOT RUN") and a runbook (F.5) lets the user approve and run it in about 30 minutes. Confidence that stopping here was correct: high; it costs the user one decision.
4. **Read-only facts about the VM** (F.5): Windows 10 Education 21H1 (build 19043.1165), *suspended* since 2025-02-24, no snapshots yet, 12 vCPU / 12 GB, NAT, 107 GB on disk, 134 GB free on the Mac.
5. **Reading CPython and mpremote sources changed two claims** in this note (X-41 for the venv-launcher case, X-22 for `fs tree` on mpremote 1.29): F.4. Both are now falsifiable predictions the VM run will settle.
6. The kit lives in the session scratchpad because I may only write notes inside the project: `.../scratchpad/winkit/` and `.../scratchpad/winkit.zip` (sha256 `4e0510a4907223a4a972189463c8b88632a3f5ac36d4b569eaf542d0e7ae4bc3`). **The parent should copy it to `mpy-upgrade/tools/winkit/`** (I was not allowed to).

### F.1 What the kit is

Run on the Windows machine: `run-all.cmd` (bypasses the execution policy) -> `run-all.ps1` -> `node kit.js` (Node.js if installed, otherwise VS Code's own Node via `ELECTRON_RUN_AS_NODE=1` [I, documented Electron switch, not executed here]; `-Runtime both` runs both). Output: `results\<COMPUTER>-<label>-<time>\{node,code}\{report.md,results.json,kit.log}` plus a `.zip`. `report.md` already contains the tables keyed to 01 s6, 05 X-xx and 02 s5. Each test runs in its own try/catch and `results.json` is rewritten after every test, so a crash in one probe cannot lose the others.

| Test | What it executes | Answers |
|---|---|---|
| T00 | `.ps1` file under the default execution policy vs `-Command`; `envinfo.ps1` (Defender state/exclusions, Pythons from `py -0p` and the registry, `WindowsApps` alias stubs: size/attributes/LinkType, Store packages, PATH order, OneDrive env, LongPathsEnabled, VS Code, Git Bash, pwsh, AppLocker) | 01 s6 PowerShell policy; context for every other row |
| T01 | Node `exec()` of the **verbatim old strings** (`shellEscape` copy of `mpremote.ts:7-9`) under the platform shell for: trivial `-c`, `-m mpremote version`, `-m mpremote connect socket://... exec`, python path with/without spaces+accents; the 0.3.2 VSIX double-quote form; bare `mpremote` with/without the venv on PATH; argv-only `spawn` as positive control. T01b: `%USERNAME%`, `&`, `^|`, embedded newline, 9,000-char command, 2 MB stdout vs the default 1 MiB `maxBuffer` | X-01, X-04, X-05, X-07; 02 s5 "Background exec"; 01 s6 Quoting |
| T02 | The old `sendText` line (`mpremoteCommands.ts:8-17`) and the apostrophe `'\''` form fed to Windows PowerShell 5.1, PowerShell 7 (if installed), `cmd.exe` (typed) and Git Bash; the old REPL form `cmd.exe /d /c <line>` (`:254-258`); PowerShell-correct (`& '...'`, `''`) and cmd-correct (double quote) hotfix lines; `spawn(python, argv[])` control | X-02, X-03, 02 s5, D10 |
| T03 | `execFile('py -3')` vs `execFile('py',['-3'])`, `py -0p`; `where python/python3/py/mpremote` order; every `WindowsApps\python*.exe` stub: lstat + `Get-Item` attributes + run with `-c` (exit code, stderr, Store process list before/after; the no-argument run only with `-AllowStorePopup`); `.cmd` shim via `spawn`/`execFile`/`exec` (CVE-2024-27980); **the unmodified old resolver** (`dist/pythonInterpreter.js` @7cb90c7 with a `vscode` stub) in four settings scenarios, every `execFile` it makes logged | X-10, X-11, X-12; 01 s6 py -3 / Aliases / Hard-coded dirs / .cmd |
| T04 | `python -I -X utf8 -m mpremote version` in a fresh venv (cold-1 right after `pip install`, cold-2 after deleting every `__pycache__`, N warm), interpreter-only baseline, vendored hermetic copy, `connect socket:// exec` end to end, `list_ports.comports()` cost on nt; Defender state before/after; `-DefenderExclusion` (elevated) repeats it with a path exclusion; `-ColdPrepare` then reboot then `-ColdMeasure` for the first run after boot | X-43, X-58, 01 s6 Antivirus, G2 |
| T05 | Process tree (CIM `Win32_Process`, parent/child + creation time) of: `exec()` through cmd.exe, `spawn(.venv python)`, `spawn(base python)` hermetic, `py -3`; each killed by `child.kill()`, `taskkill /T`, `taskkill /T /F`; "port released" = the fake board's TCP connection closes (orphans keep it open); survivors listed; `kill('SIGINT')` handler probe | X-41, X-44; 01 s6 Killing processes |
| T06 | `python -m venv` + offline `pip install` in: plain local, OneDrive-**shaped** path, a >260-char path, and (only with `-UseOneDrive`) the real OneDrive folder; timings, file count, directory attributes via `Get-Item`, `rm -rf` without retries (the old behaviour) | X-13, X-16, X-55, A12 |
| T07 | Starts itself **detached** (libuv `DETACHED_PROCESS` => no console, like Electron's GUI-subsystem extension host) and spawns `console_probe.py` via `exec`, `execFile`, `spawn` with/without `windowsHide`; the probe reports `GetConsoleWindow`, `IsWindowVisible`, `GetConsoleProcessList` from inside the child | X-06 |
| T08 | Real `mpremote fs tree` against the fake board's sandbox filesystem (non-ASCII names incl. `Ω→é`, `°C µs.py`) captured through Node pipes, for 8 env/flag combinations; plain `print` of the same glyphs; non-BMP argv round trip | X-22 |

Fake board (`py/fakeboard.py`, 241 lines): extends the Appendix A.5 board with a worker thread per program so EOF/Ctrl-C are seen while a program runs (needed to measure "port released"), a persistent per-connection namespace (mpremote's `fs` commands issue several execs), a MicroPython-style `os.ilistdir/stat/getcwd` shim rooted at a sandbox directory, `board_wait(s)` as an interruptible running "program", and a line protocol (`EV {...}`) for connect/close/exec/interrupt events. Safety guard: every connect target is asserted to match `^socket://127\.0\.0\.1:\d+$`.

### F.2 What I executed on macOS (this host: Intel, macOS 15.7.8, Node 26.5.0, Python 3.15.0)

All **[E]**. These validate the *harness*; they say nothing about Windows except where stated.

* **Full run, 137 s, no crashes**; relocated unzip in `Win Kit (é)/` also runs. `pwsh` 7.4.6 (from the earlier scratchpad) was used as the PowerShell-7 stand-in.
* **T02 / X-02 corroborated and extended.** PowerShell 7.4.6 gives `ParserError` for the old line `'.../python' -m mpremote 'connect' 'socket://...' 'exec' 'print(6*7)'` (same as 02 E5) and for the `'\''` apostrophe form; the PowerShell-correct line `& '.../python' -m mpremote 'connect' ... 'exec' 'print(6*7)'` runs and prints `42`. So the cheapest hotfix for Run-in-PowerShell (prefix `& `, double the apostrophes) works in the parser; whether it survives PSReadLine/ConPTY typing is for the VM. zsh, bash, sh and `zsh -lc` run the old line unchanged (including an apostrophe in an argument).
* **T03d: the real old resolver, traced.** With `PATH` lacking the venv: no settings => `python3`; `mpyWorkbench.pythonPath=<venv python with mpremote 1.29.0>` => `python3`; `python.defaultInterpreterPath=<same>` => `python3`. Only when the venv `bin` directory is on `PATH` (an *activated terminal*, which the extension host never is) does it return the venv python. The call log shows why: for every candidate it runs `<candidate> -c "import sys..."` (succeeds) then `execFile('mpremote',['--version'])` -> `spawn mpremote ENOENT`; eleven `execFile`s, ~200 ms, then the literal `python3`. This is an independent, call-level confirmation of X-10 (previously established by 01/04/05/06/09 without the call trace).
* **T05 harness positive control.** With a POSIX compound wrapper (`sh -c "<mpremote cmd>; echo done"`, the stand-in for Windows' `cmd.exe /c`), `child.kill()` on the shell left Python alive and the board's TCP connection open for the whole 6 s window in 2 of 2 runs (SIGTERM) and 1 of 2 runs (SIGKILL; in the other the orphan died within 0.8 s for a reason I did not isolate). Direct `spawn(python)` killed by `child.kill()` closed the connection in 2-4 ms. So the survivor/port detection works and distinguishes the cases. **New fact:** `child_process.exec()` does not forward `detached:true` (kill(-pid) returned ESRCH), so the POSIX process-group recipe in 4.x/Appendix A only works with `spawn`, and every old kill site used `exec` (`mpremote.ts:184, 1575`).
* **T08 on macOS reproduces 05's encoding demonstration**: `PYTHONIOENCODING=cp1252` (or `cp437`) breaks both a plain `print` and `fs tree` even with `-X utf8`; `-I -X utf8` (the proposed hermetic form) is immune because `-I` ignores the variable. That is a POSIX result: see F.4(b) for why it does not transfer to `fs tree` on Windows.
* **Python 3.15 note.** `sys.flags.utf8_mode` is `1` with no flag and a UTF-8 locale on this 3.15.0 [E]; consistent with PEP 686 making UTF-8 mode the default. If that holds on Windows (not run), X-22 shrinks for any Python >= 3.15 even for non-mpremote code [I]. Students on <= 3.14 are unchanged.
* **Timings (macOS baseline for the Windows comparison).** Two runs, same kit, same machine, different background load: `python -I -X utf8 -m mpremote version` in a fresh venv cold-1 169 ms / 369 ms, cold-2 (no `.pyc`) 236 / 456 ms, warm median 155 / 310 ms (n=4 / n=8); interpreter alone 46 / 124 ms; `connect socket:// exec print(6*7)` warm median 513 / 803 ms (p90 1,147 ms). Consequences: (1) the machine's own noise is x2, so one Windows number means little without n >= 8 and the median; (2) a connect+exec costs 0.36-0.5 s more than `version` even with a zero-latency board [E], so X-58's per-substep cost is real on macOS too; (3) 05's earlier "0.17 s" is the low end of this range. `venv` creation 3.4-13.5 s, offline `pip install` 0.8-2.2 s (1,021 files) in all three path shapes, including a 256-char path (APFS has no MAX_PATH).

### F.3 Windows branches that have NOT executed anywhere

`cmd.exe`/PowerShell 5.1 stdin driving, the CIM process snapshot, `taskkill`, `console_probe.py` (ctypes `GetConsoleWindow`), `Get-MpComputerStatus`, the registry/alias code in `envinfo.ps1`, `Code.exe` as Node. Static checks only: `run-all.ps1` and `envinfo.ps1` parse with `System.Management.Automation.Language.Parser` (0 errors; written to avoid PowerShell 7-only syntax, but not run under 5.1) and all JS modules load. Expect that the first Windows run may expose one or two kit bugs; the per-test isolation and incremental saving are there for that reason. **The kit's Windows verdicts are only as good as the first run's `kit.log`; review it before trusting a table cell.**

### F.4 Evidence from source reading that changes earlier claims

**(a) X-41 / 01 s6 "venv launcher stubs": the venv `python.exe` kills its child when it dies [S, P 70%].** `Lib/venv` on Windows copies `venvlauncher.exe`, built from `PC/launcher.c` with `VENV_REDIRECT` (CPython 3.12 `PCbuild/venvlauncher.vcxproj:94`; in 3.15/main it is `PC/venvlauncher.c`). `run_child()` (3.12 and 3.14 `PC/launcher.c:756-822`; main `PC/venvlauncher.c:385-453`) creates a job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, starts the real interpreter, `AssignProcessToJobObject(job, child)`, sets a Ctrl-C handler that swallows events in the launcher (`:750`), and waits. The only handle to that job belongs to the launcher, so `TerminateProcess(launcher)` (= Node `child.kill()`) closes it and the kernel kills the base `python.exe` and its descendants (including `pip` subprocesses). `py.exe` (`launcher2.c:2573-2609`) does the same. Grepped 3.9, 3.12, 3.13, 3.14 and main: the job object is in all of them. **So the unqualified headline "kill does not kill the tree; python.exe lives on" and 01 s6's `taskkill /T /F ... (venv launcher stubs ...)` are true for the `cmd.exe` wrapper of the OLD design (`exec`) and for terminal/PowerShell chains, but probably not for `spawn('<venv>\Scripts\python.exe', argv)`, which is the proposed design.** Refutation: T05 row `spawn(venv python) + child.kill()` shows a surviving `python.exe` or a connection still open after 6 s. If it holds, the new extension's Stop path is simpler on Windows (direct `spawn` + `kill()`), while keeping `taskkill /T /F` for anything started through a shell. Caveat: a nested job from the parent without breakaway permission is allowed on Windows 8+ so I do not expect interference, but Electron's own job handling is [U].

**(b) X-22: on mpremote 1.29 the Windows `fs tree` case is probably already handled by mpremote itself [S, P 85%].** `main()` calls `ConsoleWindows.configure_unicode_output()` when `sys.platform == "win32"` (`mpremote/main.py:562-567`); it re-wraps any `stdout`/`stderr` whose encoding is not a Unicode one in `TextIOWrapper(..., encoding="utf-8", errors="backslashreplace")` (`console.py:196-230`) and calls `SetConsoleOutputCP(65001)` (`console.py:252-262`). 05's [E] evidence for X-22 (Appendix E, the `cp1252` rows) and my T08 rerun are macOS runs where that function returns on its first line (`console.py:198`), so they cannot show what happens on Windows. **What stays valid:** mpremote 1.26-1.28 (no such function), any Python helper the extension runs itself, user programs' `print` on Python <= 3.14 when piped (ANSI code page), and the advice to pass `-I -X utf8`. **What weakens:** "Win H" for `fs tree` with the pinned 1.29. T08 on Windows settles it (if the `default` and `PYTHONIOENCODING=cp1252 + -X utf8` rows pass for `tree` while the plain `print` rows fail, (b) is confirmed). Side effect to remember: `SetConsoleOutputCP(65001)` changes the attached console's output code page.

**(c) Appendix A `killTree`: `taskkill /pid N /T` without `/F` is probably a no-op for console children [K, P 70%].** Without `/F`, taskkill asks windows to close; a hidden-console `python.exe` has none and taskkill reports "This process can only be terminated forcefully (with /F option)". Appendix A then waits `graceMs` (1.5 s) before the `/F` call, so on Windows the first call is wasted time and the grace period is not a grace period. Harmless because the `/F` fallback exists, but a real graceful stop on Windows needs a PTY Ctrl-C (X-44) or an in-protocol interrupt. T05 records the non-`/F` result and exit code.

**(d) `mpremote` pays a SetupAPI enumeration on every Windows connect [S].** `transport_serial.py:71-73`: `if os.name == "nt": portinfo = list(serial.tools.list_ports.grep(device))` runs for *any* device string, including `socket://`, before opening. That is part of X-58's per-process cost and also means the fake-board test exercises the Windows branch up to (not including) the CP210x DTR/RTS special case (needs an actual `vid:pid` match, `:73`). T04 times `comports()` separately.

**(e) 05 s5.2 and 1 should be corrected:** "No Windows machine was available" - a Windows 10 VM exists (10 s2.4). It is Windows 10 **21H1** (build 19043.1165), which left support in 2022 [K], and Windows 10 itself left support on 2025-10-14 [K]; student laptops in 2026-27 are Windows 11 mostly [I]. Treat Windows 10 results as necessary but not sufficient; a Windows 11 guest for the final acceptance run is cheaper than any argument about it.

### F.5 The VM: read-only facts and the approval-gated runbook

Facts (read from the bundle and `vmrun list`; nothing started, nothing modified) [E]: `<Windows VM folder>/Windows 10 x64.vmx`: `guestOS=windows9-64`, `Windows 10 Education 64-bit (Build 19043.1165)`, EFI, NVMe, 12 vCPU, 12,288 MB, NAT (e1000e), the last log shows Tools running-status 1 => 0 at 2025-02-24 19:22Z, `vmsd` is empty (**no snapshots**), and a `.vmss` + 12.9 GB `.vmem` dated 2025-02-24 are present (**the VM appears to be suspended** [I, ~90%]: it would resume mid-session), 107 GB on disk, 134 GB free on the Mac, `vmrun list` reports 0 running VMs. The VM's Defender signatures are from before 2025-02 unless it updates over NAT on resume [I]. Contents of the guest (Python? Node? VS Code? OneDrive signed in? admin?) are unknown.

**Needs the user's explicit yes before anything below is run.** Steps (the guest account name/password are the user's to supply; do not write them into files):

```
VMX="<Windows VM folder>/Windows 10 x64.vmx"
VMRUN="/Applications/VMware Fusion.app/Contents/Public/vmrun"
"$VMRUN" list                                             # expect: Total running VMs: 0
"$VMRUN" -T fusion snapshot "$VMX" "pre-winkit-2026-10-12" # [U] vmrun may refuse on a suspended VM; if so resume first
                                                           #  (start ... gui) and snapshot from the GUI/vmrun; the snapshot
                                                           #  then includes memory (~13 GB; disk has room)
"$VMRUN" -T fusion start "$VMX" gui
"$VMRUN" -T fusion -gu USER -gp PASS copyFileFromHostToGuest "$VMX" ".../scratchpad/winkit.zip" 'C:\Users\USER\Desktop\winkit.zip'
# in the guest:  Expand-Archive winkit.zip . ; cd winkit ; run-all.cmd -Label vm-clean
"$VMRUN" -T fusion -gu USER -gp PASS copyFileFromGuestToHost "$VMX" 'C:\Users\USER\Desktop\winkit\results\<...>.zip' ./
```
(Drag and drop or a shared folder work as well; `vmrun` guest operations need Tools running and credentials.)

Scenario ladder, each from the previous snapshot so the Store-stub rows are measured *before* Python is installed:
* **S0 clean as found** (whatever is in the guest; if no Python the kit records the discovery attempts and skips the rest). Gives T00/T03b/T07 and the `py -3` row without any install.
* **S1 + Node LTS (or just VS Code) + python.org Python 3.12/3.13 with "Add to PATH" and the `py` launcher.** Full suite. This is the headline run.
* **S2 Store Python instead** (separate snapshot branch): X-12 and X-13 in their real habitat.
* **S3 cold boot:** `run-all.cmd -ColdPrepare`, reboot, `run-all.cmd -ColdMeasure`; and `-DefenderExclusion` (elevated) for the A/B.
* **S4 (optional) signed-in OneDrive** with `-UseOneDrive`, and a Windows 11 guest for acceptance.
Not covered by any scenario: the CP2102/CH340 board through VMware USB pass-through (hardware kit, out of scope here), ConPTY typing into a real VS Code terminal (needs the extension host, see 10 s3).

### F.6 Results tables (Windows column to be filled from `report.md`)

Columns: **Pre-registered Windows prediction [P, confidence]** | **macOS control [E]** | **Win10 VM**. "Refutes if" is what in the Windows cell would contradict the note.

**01 section 6**

| Row | Prediction [P] | macOS control [E] | Refutes if | Win10 VM |
|---|---|---|---|---|
| venv layout `Scripts\python.exe` | `.venv\Scripts\python.exe` exists; old resolver never returns it unless `mpremote.exe` is on PATH, 90% | resolver returns `python3` in 3 of 4 scenarios; venv python only with venv `bin` on PATH | resolver returns the venv python from `pythonPath` alone | NOT RUN |
| `py -3` as one string | `spawn py -3 ENOENT`; `py -3` split works iff the python.org launcher is installed, 99% / 90% | ENOENT (no `py`) | `execFile('py -3')` succeeds | NOT RUN |
| App Execution Aliases | stubs exist in `WindowsApps` even when python.org Python is installed (85%); with no real Python: exit 9009 and the "Python was not found; run without arguments to install from the Microsoft Store" text (75%); `-c` does not open the Store (70%); stub is a size-0 reparse point (80%) | n/a | exit code 0 with nothing installed, or a Store process appears with `-c` | NOT RUN |
| Hard-coded dirs 39..312 | newer installs (3.13/3.14) and `Program Files\Python3xx` are missed by the old list (95%, by construction) | n/a | resolver finds them | NOT RUN |
| Quoting `'...'` | every HEAD-form `exec` string fails under cmd.exe, 95%; double-quote (VSIX) form works, 90% | HEAD form 4/4 pass under sh; VSIX bare `mpremote` without PATH: exit 127 | any HEAD-form row passes | NOT RUN |
| Spaces / OneDrive / non-ASCII | argv spawns fine in `Ana María Núñez\ME 241 (é)`; HEAD strings fail for the quoting reason, not the path | venv+pip fine in 3 shapes | argv spawn fails on the accented path | NOT RUN |
| PowerShell execution policy | `.ps1` file blocked by default policy (Restricted/AllSigned on client SKUs) 80%; `-Command` and `python.exe` unaffected 99% | n/a | `.ps1` runs by default | NOT RUN |
| Antivirus latency | cold-1 `version` 0.6-3 s, warm 0.25-0.6 s, >=1 of 8 runs over 500 ms (50%, wide guess) | cold-1 0.17-0.37 s, warm 0.15-0.31 s, 0 runs over 500 ms | all Windows runs < 0.3 s (X-43's trigger disappears) | NOT RUN |
| Console flashes | without `windowsHide` a console-less parent gives the child its own visible console, 90%; with it none, 95% | n/a | no visible console in the no-hide cases | NOT RUN |
| Killing processes | see X-41 | harness controls | see X-41 | NOT RUN |
| `.cmd` shims | `spawn` of `.cmd` throws `EINVAL` on Node >= 18.20.2/20.12.2, 90% | allowed (POSIX script) | `spawn` runs the `.cmd` | NOT RUN |
| Encoding | see X-22 | see F.2 | see F.4(b) | NOT RUN |

**05 X-01..X-12, X-22, X-41, X-43/44, X-55/58**

| Row | Prediction [P] | Refutes if | Win10 VM |
|---|---|---|---|
| X-01 `exec` POSIX string -> cmd.exe | all HEAD rows fail with "is not recognized as an internal or external command", 95% | any passes | NOT RUN |
| X-02 PowerShell 5.1 / 7 / cmd typed line | ParserError "Unexpected token '-m'" in both PowerShells, 90% (7.4.6 [E] on macOS); cmd "is not recognized" 95%; hotfix `& '...'` runs in both PowerShells, 80% | 5.1 accepts the line | NOT RUN |
| X-03 `cmd.exe /d /c '<posix>'` | fails, 90% | runs | NOT RUN |
| X-04 `exec` shell layer | `%USERNAME%` expanded, `&` splits, newline truncates, 9,000-char line fails (>8,191), 2 MB output kills the child (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) | any not reproduced | NOT RUN |
| X-06 `windowsHide` | see 01 s6 | | NOT RUN |
| X-10 old resolver | falls through to `python3` literal, venv never chosen without PATH, 90% | venv chosen | NOT RUN |
| X-11 / X-12 | see 01 s6 rows | | NOT RUN |
| X-13 offline pip | venv + `pip install --no-index` succeeds in local and OneDrive-shaped path; fails at >260 chars unless `LongPathsEnabled=1`, 80%; real OneDrive adds latency and intermittent EBUSY/EPERM on `rm` without retries, 50% | deep path succeeds with LongPathsEnabled=0 | NOT RUN |
| X-22 | `fs tree` UTF-8 correct in the `default` and stale-`cp1252 + -X utf8` rows on mpremote 1.29, 85% [S]; plain `print` on Python <= 3.14 fails in `default` when piped, 90% | `tree` raises charmap in `default` | NOT RUN |
| X-41 | `exec` via cmd.exe + `kill()`: cmd dies, python survives, connection stays open, 85%; `spawn(.venv python)` + `kill()`: no survivor, connection closes < 1 s, 70% [S]; `taskkill /T` without `/F` fails on the console child, 70%; `taskkill /T /F` leaves nothing and releases the port < 1 s, 90% | rows contradict | NOT RUN |
| X-43 | see Antivirus latency | | NOT RUN |
| X-44 | `kill('SIGINT')` hard-kills; the Python SIGINT handler never runs, 95% | handler ran | NOT RUN |
| X-55 | see X-13 | | NOT RUN |
| X-58 | connect+exec warm 1-3 s on Windows (vs 0.5-0.8 s macOS), 50% | < 0.8 s | NOT RUN |

**02 section 5 (shell and quoting matrix)**

| Cell | Prediction [P] | macOS control [E] | Win10 VM |
|---|---|---|---|
| Windows PowerShell (Run terminal) | `ParserError: Unexpected token '-m'`, 90% | pwsh 7.4.6: ParserError [E] | NOT RUN |
| Windows PowerShell 7 | same, 95% | same [E] | NOT RUN |
| cmd.exe (REPL `/d /c`, typed, `exec`) | "'...' is not recognized as an internal or external command" | n/a | NOT RUN |
| Git Bash | HEAD line runs, 80% (REPL still fails because it forces cmd.exe) | bash runs | NOT RUN |
| macOS zsh/bash | works | works incl. apostrophe [E] | n/a |
| fish | not tested by the kit (no fish here) | | |

### F.7 What this follow-up does and does not change

* **Confidence in the Windows claims is unchanged until the VM runs** (they were all [R]/[K]/[D]; they still are, except the PowerShell-7 parse which is [E] twice now, and the resolver call trace which is [E] on macOS). The new value is that the experiment is written, validated on its POSIX side, and every cell has a refutable prediction.
* **Two claims moved from "stated" to "disputed by source":** X-41 for the venv launcher (F.4a) and X-22 for `fs tree` on 1.29 (F.4b). Both lower the cost of the rewrite design (a direct `spawn` + `kill()` Stop on Windows; no `-X utf8` dependency for mpremote's own output) and neither supports keeping the old extension: the old exec/terminal quoting (X-01..03) and the unreachable-venv resolver (X-10) do not depend on them.
* **Decision relevance.** If T01/T02 confirm (as I expect), HEAD cannot run a single `mpremote` command on Windows under cmd.exe/PowerShell, which is the strongest evidence for the rewrite (or at least for replacing the process layer) that does not rely on judgement. If T01 refutes, the cheap M0 hotfix gets stronger.
* **Cheapest next step for the instructor:** say yes to F.5 (S0 and S1 are ~30 minutes of attended time), then send back the two `.zip` files; I or the next analyst fill F.6 from `report.md`. If a yes is not available, the same kit can be run by anyone on a student's Windows laptop (the kit needs no repository access and no board).
