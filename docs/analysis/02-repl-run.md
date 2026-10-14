# 02 - REPL terminal and "Run file" (complaint 1, second half)

Scope: why "Open REPL" did not open reliably and why "Run current file" did not seem to work, how the old extension
really executes these actions, who fights over the serial port, and what the replacement should do instead.

Reference (read-only): `../mpy-workbench`, cited as `old/`. Line numbers are for `old/src/*.ts`
at git HEAD `7cb90c7`. Everything I compiled or ran lives in the scratchpad, never in `old/`.

No serial port was opened. The "board" in every experiment is either a mock, an in-process emulator, or a private pty pair
created by the test script (a pty is not a serial device). The only port-related command run against the real machine was
`mpremote connect list`, which only enumerates.

## Evidence legend

| Tag | Meaning |
|---|---|
| **[E]** | I executed it and observed the output (experiment id in section 1). |
| **[S]** | I read third-party source that is installed or downloadable: mpremote 1.29.0 (and 1.24.1/1.26.0/1.27.0), MicroPython v1.25.0, the installed VS Code 1.141.0 workbench JS. |
| **[R]** | I read the old extension's code and am confident, but did not execute that exact path. |
| **[K]** | From my knowledge of OS/VS Code behaviour, not verified here. Each has a "how to verify" note. |

---

## 0. Executive summary

1. **The REPL and Run features are built on the wrong primitive.** Every action types a shell command string into a VS Code
   terminal (`createTerminal` + `sendText`, or `shellArgs: ["-lc", cmd]`) or `exec()`s one in a child process. There is no
   owner of the serial port, no state, and no feedback channel. Every other problem follows from that: quoting is per-shell,
   errors vanish with the terminal, the port is contended by up to five independent `mpremote` processes, and the extension
   cannot tell whether the board is running, idle, busy or unplugged.
2. **Run file is wrong by construction in HEAD.** It decides between `mpremote run <file>` and `mpremote exec "import <module>"`
   using `mp.fileExists()`, which runs `mpremote fs stat <path>`. **`fs stat` is not an mpremote command**; mpremote 1.24-1.29 accept it
   silently, do nothing, and exit 0 [E2]. So "file exists on board" is true whenever the port is reachable. Run therefore
   `import`s the board's copy: stale code, `ImportError` if the file was never uploaded (auto-sync is off by default), body of
   `if __name__ == "__main__":` skipped, and `SyntaxError` for file names such as `lab 1.py` or `my-file.py` [E1-A]. It never
   runs the code in the editor.
3. **REPL terminal is a one-shot process.** When `mpremote` exits for any reason (port busy, wrong Python, unplug, Ctrl-X) VS Code
   disposes the terminal immediately and the error text is lost; only a generic "terminated with exit code N" toast remains [S: VS Code
   `_onProcessExit`, exit code 0 is silent]. The "auto-suspend" feature relies on that terminal still existing so it can
   type the restart command into it, so after any file operation the REPL is simply gone and never comes back [E1-B/C, S].
4. **A fixed 500 ms Ctrl-C injected with `sendText`** (`mpremoteCommands.ts:261-271`) turns into SIGINT for the whole
   `shell -> python -m mpremote` chain if mpremote has not yet put the tty in raw mode. Reproduced with a 0.7 s slow login profile: the
   terminal shows `^C` and nothing else, exit status SIGINT [E4]. On this fast Mac the race is won (mpremote is up in about 0.25 s), but on a
   classroom Windows laptop with antivirus it will be lost sometimes. That is the "not reliable" signature.
5. **Stop / Interrupt / Soft reset are hacks that mostly do not do what the labels say** (`echo -e '\x03\x03' > /dev/cu.xxx`):
   on macOS `/bin/sh` prints a literal `-e ` before the control bytes [E6], so the Ctrl-D never lands on an empty line and cannot soft-reset
   [S: readline.c]; on Windows `cmd.exe` echoes literal text. "Soft reset" without a REPL open runs mpremote's `reset`, which is a
   **hard** `machine.reset()` [S]. Before sending anything, Stop first runs `mpremote fs tree` as a "health check", which takes seconds,
   fails when the port is held, and soft-resets the board.
6. **Ctrl-C in the Run terminal does not stop the program on the board.** mpremote catches KeyboardInterrupt, sends only
   `\r\x02` (Ctrl-B) and exits 1 [E3, S: commands.py:495]. The script keeps running on the board (confirmed on the protocol level against
   an emulator; real-hardware confirmation is on the checklist in section 13).
7. **The two builds differ.** The user runs the older `.vsix` build with bare `mpremote` (+ a hand edit that hard-codes
   `~/src/mpy_test/.venv/bin/python` for the REPL only). Git HEAD (the source) uses `python -m mpremote` and a resolver that falls through
   to `python3` [E1-A]. HEAD additionally breaks Windows completely because of POSIX-only quoting (PowerShell: `ParserError` [E5]; cmd.exe: [K]).
   Section 2 and `01-discovery.md` cover this; both builds share all of the design flaws above.
8. **Recommendation: rewrite this layer, keep the UI.** The replacement needs one long-lived connection owned by the extension host, a
   `Pseudoterminal` as a view onto it, an explicit state machine, and our own raw-REPL implementation (or mpremote used strictly as a library
   behind the same owner). Details in section 10; numbered requirements in section 11.

---

## 1. Experiments (all offline, all reproducible)

All files are under the scratchpad `.../scratchpad/` (session-specific; the essential scripts are reproduced in Appendix A).
`venv-mpr/` = a venv with `mpremote 1.29.0` + `pyserial 3.5`; `oldext/out` = HEAD `src/` compiled with the old `tsc`
(byte-identical to `old/dist/*.js` for `extension`, `mpremote`, `mpremoteCommands`, `monitor`, `actions`, `control`).

| Id | What | Result (short) |
|---|---|---|
| E1 | Load the **real compiled** old JS with a fake `vscode` module and a recording `child_process`; replay actions. A: `runActiveFile`. B: REPL / softReset / disconnect / restart / Stop / Interrupt / `openReplTerminal`. C: `activate()` then sidebar sequences. | Exact command strings, terminal options and call order (sections 3, 7). |
| E2 | Run the **real mpremote `main()`** for `connect /dev/fake fs stat /does_not_exist.py` with the transport replaced by a recording fake, on 1.24.1, 1.26.0, 1.27.0, 1.29.0. | exit 0, prints `stat :/does_not_exist.py`, does `enter_raw_repl(soft_reset=True)` and nothing else. On 1.29.0 and 1.24-1.27 alike. |
| E3 | Real mpremote 1.29.0 `connect X run loop.py` against an in-process emulation of a board (raw REPL + raw paste); SIGINT after 2 s. | exit 1; host writes only `\r\x02` then closes; **no `\x03`**; emulated script still running. |
| E4 | pty that emulates the VS Code terminal running `/bin/zsh -lc "'<py>' -m mpremote 'connect' '<private pty board>'"`; type `\x03` at 0.5 s. | normal startup: Ctrl-C reaches the board. 0.7 s slow `.zprofile`: terminal shows `^C`, process killed by SIGINT, board saw nothing. Ctrl-C at 0.05 s: Python traceback. |
| E5 | `pwsh` 7.4.6 (downloaded into scratchpad) evaluates the exact strings the old code `sendText`s. | `ParserError: Unexpected token '-m' in expression or statement.` for single-quoted exe followed by args. Same on Windows PowerShell 5.1 [K]. |
| E6 | `exec("echo -e '\\x03\\x03' > file")` through Node on macOS. | file bytes: `2d 65 20 03 03 0a` = `-e ` + Ctrl-C Ctrl-C + LF. Ctrl-D variant: `-e ` + `04` + LF. |
| E7 | Two real mpremote processes on one private pty "board". | 2nd: `mpremote: failed to access /dev/ttys014 (it may be in use by another program)`, exit 1, 0.22 s. |
| E8 | mpremote 1.26.0 and 1.29.0 `_is_disconnect_exception` on unplug-shaped errors. | clean "device disconnected" only for errno 5 (Linux) and Windows `ClearCommError`; **not** for macOS errno 6 (ENXIO) nor pyserial's "device reports readiness to read but returned no data". |
| E9 | Startup timings of `python -m mpremote version` and `zsh -lc true`. | 0.17-0.27 s and 0.06 s on this Mac. |
| E10 | Read the installed VS Code 1.141.0 `workbench.desktop.main.js`: terminal exit handling, `terminal.integrated.commandsToSkipShell` defaults. | Exit with no `waitOnExit` -> terminal is disposed; message only if exit code != 0; `workbench.action.quickOpen` is skip-shell by default. |
| E11 | `mpremote --help` / subcommand `--help` on 1.24.1, 1.26.0, 1.27.0, 1.29.0 and source reading. | Section 6. |
| E12 | `mpremote connect list` (enumeration only). | `/dev/cu.usbserial-0001 0001 10c4:ea60 Silicon Labs CP2102 USB to UART Bridge Controller` plus three Bluetooth `/dev/cu.*` entries with `None 0000:0000`. |
| E13 | `npm pack @serialport/bindings-cpp@13.0.1`, list prebuilds, `require()` it (no port access). | Prebuilds for darwin x64+arm64 (one universal file), win32 x64/arm64/ia32, linux; 2.2 MB unpacked; loads under Node 26 on this Mac. |

---

## 2. Which code the user actually ran

`01-discovery.md` has the full diff. What matters for REPL/Run:

| | Installed `.vsix` build (what the user ran) | Git HEAD `src/` (what I analysed line by line) |
|---|---|---|
| Background `mpremote` calls | `exec('mpremote "connect" "<port>" ...')`, bare `mpremote` from the extension host's PATH, double-quoted args (works in sh and cmd) | `exec("'<py>' -m mpremote 'connect' ...")`, POSIX single quotes (`mpremote.ts:170-181`) |
| REPL terminal | `shellArgs ["-lc", "~/src/mpy_test/.venv/bin/python -m mpremote connect <port>"]` after the user's hand edit (the `.bak`/`.bak2` files show the intermediate placeholder `/ABSOLUTE/PATH/TO/.venv/...`) | `["-lc", "'<py>' -m mpremote 'connect' '<port>'"]` (`mpremoteCommands.ts:253-258`) |
| `restartReplInExistingTerminal` | hard-coded `~/src/mpy_remote/.venv/...` (note `mpy_remote`, not `mpy_test`: a different path from the REPL one) | `buildMpremoteTerminalCommand` |
| Run terminal | `sendText('mpremote connect <port> run "<file>"')` or `exec "import <mod>"` | `sendText("'<py>' -m mpremote 'connect' ... 'run' '<file>'")` (`:188-225`) |
| `fileExists` | `mpremote ... fs stat` with bare `mpremote`: ENOENT if not on the extension host PATH -> swallowed -> `false` -> **always uses `run`** | `fs stat` through `python -m mpremote` -> exit 0 -> `true` -> **always uses `exec import`** |

Consequence worth stating plainly: in the user's actual installed build, Run most likely issued `mpremote connect <port> run "<file>"` into the
"ESP32 Run File" terminal, which only works if `mpremote` is on that terminal's PATH (venv activated in that terminal). The symptom would be
`command not found: mpremote` in that terminal (see section 7.2, F0). In HEAD it would instead hit F1. The user should open the "ESP32 Run File"
terminal and read its first line to tell which one happened (section 7.4).

---

## 3. How each action really executes

### 3.1 Command map

| UI action | Command id | Handler | Mechanism | Shell / quoting |
|---|---|---|---|---|
| Open Repl (sidebar, toolbar) | `mpyWorkbench.runFromView` -> `mpyWorkbench.openRepl` (`actions.ts:28`, `extension.ts:871-874`, `:1079-1085`, `:1089`) | `getReplTerminal` (`mpremoteCommands.ts:238-274`) | `createTerminal({shellPath, shellArgs:["-lc", cmd]})`; macOS/Linux `process.env.SHELL || /bin/bash`; Windows `cmd.exe /d /c <cmd>`; then 2 x `sendText` for Ctrl-C/Ctrl-B | cmd is `'<py>' -m mpremote 'connect' '<port>'` via `shellEscape` (`:8-10`) |
| "Open Serial Monitor" (palette only; not wired to any button) | `mpyWorkbench.openSerial` (`extension.ts:870`) | `openReplTerminal` (`:291-327`) | `strictConnectHandshake` (reset + ls) then `getReplTerminal` | same |
| Run file | `runActiveFileFromView` -> `runActiveFile` (`extension.ts:923`, `:1088`) | `runActiveFile` (`:164-227`) | `fileExists` precheck (child process), then `sendText(cmd, true)` into a reused terminal named "ESP32 Run File" created with `createTerminal({name, cwd})` (default shell profile) | POSIX single quotes into whatever shell the default profile is |
| Stop | `mpyWorkbench.stop` (`extension.ts:467`) | `robustInterruptAndReset` (`:420-510`) | `mpremote fs tree` health check, `exec("echo -e '\\x03\\x03' > <port>")`, `exec("echo -e '\\x04' > <port>")`; fallbacks via mpremote | `/bin/sh` (macOS) or `cmd.exe` (Windows), port name unquoted |
| Interrupt | `mpyWorkbench.serialSendCtrlC` (`:466`) | `robustInterrupt` (`:360-418`) | same as Stop minus the Ctrl-D step | same |
| Soft Reset | `mpyWorkbench.softReset` (`:468`) | `softReset` (`:130-162`) | REPL open: `sendText` Ctrl-C, Ctrl-B, Ctrl-D into the REPL terminal (60/80 ms gaps). REPL closed: `exec("<py> -m mpremote connect <port> reset")` | mpremote `reset` = hard reset, see 6.3 |
| Auto-suspend around file ops | `withAutoSuspend` (`extension.ts:278-301`) | | `disconnectReplTerminal` (Ctrl-X, `:27-35`) -> `ensureIdle` (an extra `fs tree`) -> op -> `restartReplInExistingTerminal` (`sendText(cmd)` into the REPL terminal, `:37-49`) | |

Notes:

- The Run terminal is never created with `shellPath`; it is whatever the user's default terminal profile is: zsh on macOS, **PowerShell** on a
  stock Windows 11, or Git Bash if the student changed it [K]. The REPL terminal ignores the profile and forces `cmd.exe` on Windows.
- `strictConnect` / `interruptOnConnect` are consulted **only** in `openReplTerminal`, i.e. the palette command "Open Serial Monitor". The sidebar
  "Open Repl" goes straight to `getReplTerminal` and ignores both settings (`extension.ts:871-874` vs `:870`).
- `mpyWorkbench.baudRate` (`package.json:401`) is declared but never read; mpremote always uses 115200 (`commands.py:45,57,64` [S]).
- Dead code: `monitor.ts` (import commented out at `extension.ts:17`), `miniterm_filter.py` (nothing references it; its own comment says it
  just `execvp`s miniterm), `control.ts` (`ControlTree` never imported), `mpremoteOperations.ts` (empty stubs), `BoardOperations.withAutoSuspend`
  (`boardOperations.ts:139-148` is a no-op and the class is never invoked from `extension.ts`), `mp.runFile` (`mpremote.ts:1456-1462` uses
  `fs run`, which does not exist), `pyraw.ts:12` points at a nonexistent `scripts/thonny_list_files.py`.

### 3.2 The REPL terminal, step by step (HEAD, macOS) [E1-B, E1-C]

1. `createTerminal({name:"ESP32 REPL", shellPath:"/bin/zsh", shellArgs:["-lc","'<py>' -m mpremote 'connect' '/dev/cu.usbserial-0001'"]})`. No `cwd`, no `env`, no `waitOnExit`.
2. 500 ms later `sendText("\x03", false)`; 100 ms after that `sendText("\x02", false)` (`:261-271`). Unconditional: there is no check that mpremote is running or has printed
   "Connected to MicroPython".
3. mpremote `connect <port>` with no further command defaults to `repl` (`main.py:629`) [S]. `repl` does **not** interrupt the board and does
   not soft-reset (`repl.py:59-61`: `ensure_friendly_repl`), so the extension's Ctrl-C is the only thing that interrupts a running program.
4. mpremote exits when it reads Ctrl-] or Ctrl-X (`repl.py:14`), on an unclassified error (traceback, exit 1), on a classified disconnect (prints
   "device disconnected", exit 0), or when the pty is closed.
5. When the process exits, VS Code disposes the terminal (no `waitOnExit`). Exit code 0 is silent; non-zero shows a generic notification
   `The terminal process "<shell> '-lc', '<cmd>'" terminated with exit code: N.` with no stderr, and only if `terminal.integrated.showExitAlert` is on
   [S: `_onProcessExit` and `uos` in `workbench.desktop.main.js`].

### 3.3 Run file, step by step (HEAD, macOS) [E1-A]

1. `ed.document.save()` (`:167`). This fires `onDidSaveTextDocument` (`extension.ts:1093`), which, if the workspace is initialised and auto-sync is on, starts an `mpremote fs cp`
   concurrently through `withAutoSuspend` (`:1121`). `runActiveFile` does not wait for it.
2. Refuse if `mpyWorkbench.connect` is `auto` (`:169-173`). The setting is **forcibly reset to `auto` on every extension activation**
   (`extension.ts:187`, observed in E1-C), so after each window reload or new window this is the first thing a student hits.
3. If the REPL terminal is open, dispose it, then sleep 400 ms (`:178-183`). The REPL does not come back.
4. `getPythonPath()` (see `01-discovery.md`; in E1-A it made 18 `execFile` probes and returned `python3`).
5. If the file is inside the workspace: map to a device path with `rootPath` and call `mp.fileExists(devicePath)` (`:198`) = a full `mpremote fs stat` process: 0.2 s start, port open, **soft reset of the board**, exit raw REPL, close.
6. Branch: `onBoard` true -> `exec "import <module>"` where `<module>` is the workspace-relative path with `/` -> `.` (`:20-24`, `:202-208`); else `run <absolute local path>`.
7. Reuse or create the "ESP32 Run File" terminal and `sendText(cmd, true)` + `show(true)` (`:215-226`).
8. In the terminal a second `mpremote` process starts, opens the port again, soft-resets the board a **second** time and runs.

So one click = two port opens, two soft resets, two Python start-ups, no progress indication for the first 2-5 s, and the precheck gives the wrong answer.

### 3.4 Stop, Interrupt, Soft reset [E1-B, E6]

- `robustInterruptAndReset` (`:420-510`): `healthCheck` = `mpremote fs tree` (`mpremote.ts:1580-1596`), with `retryOnFailure:false`; if the Run or REPL terminal holds the port this fails instantly with "failed to access" and the user gets
  the toast "Device ... may not be responding properly", but the code carries on anyway.
- Then `exec("echo -e '\\x03\\x03' > /dev/cu.usbserial-0001")`. Node's `exec` uses `/bin/sh`, which on macOS is bash 3.2 in POSIX mode; its `echo` does not know `-e`
  and writes `-e ` literally: bytes `2d 65 20 03 03 0a` [E6]. The leading `-e ` is harmless for Ctrl-C (Ctrl-C cancels a non-empty line).
- Then `exec("echo -e '\\x04' > <port>")`: bytes `-e `, `04`, LF. In MicroPython's readline, Ctrl-A..Ctrl-E are only treated as REPL control keys **when the line is empty**; with text
  on the line Ctrl-D is "delete at cursor" [S: `shared/readline/readline.c:146-165`]. So the "soft reset via echo" toast appears but no reset happens; the LF then executes `-e ` and the REPL prints a SyntaxError. If the board is running a
  program the Ctrl-D is just input.
- Shell redirection opens `/dev/cu.*` with default termios and no flock (mpremote's flock is advisory), and closes it again; on a CP2102 + ESP32 DevKit that changes DTR/RTS, which can reset the ESP32 or latch IO0 [K]. mpremote deliberately orders `rts=False` then `dtr=False` in `close()`
  to avoid exactly that (`transport_serial.py:122-133`).
- Windows: `echo -e '\x03\x03' > COM3` in cmd.exe writes the literal text `-e '\x03\x03'`; the toast still says "Interrupt sent via echo" [K]. COM10 and above also need `\\.\COM10` for redirection [K].
- The mpremote fallback (`:407`) runs `exec --no-follow "import sys; sys.stdin.write(b'\x03\x03')"`; `sys.stdin.write` does not exist on MicroPython, but entering the raw REPL already sends Ctrl-C, so the fallback "works" by accident and soft-resets the board.
- Soft reset with REPL open (`:132-145`) is the only one of these that does the right thing: Ctrl-C (cancel line), Ctrl-B, Ctrl-D on an empty line. It also produces a toast.

### 3.5 Auto-suspend and the other settings

`serialAutoSuspend` (default true; `package.json:371`): "Automatically close the REPL terminal before file ops and reopen after."

What it does (`extension.ts:278-301`):

```
opQueue chain reset if preempt!==false        # so ops are NOT serialised; they all run concurrently
if disabled or skipIdleOnce: run fn directly   # skipIdleOnce is a global one-shot flag
wasOpen = isReplOpen()
if wasOpen: sendText(Ctrl-X); sleep 200ms      # REPL "disconnected"
ensureIdle(): mp.ls("/")  (an extra fs tree) ; if listingInProgress sleep preListDelayMs
fn()
if wasOpen: sendText(<python> -m mpremote connect <port>)  into the REPL terminal
```

Problems, in order of damage:

1. **Restart cannot work.** After Ctrl-X mpremote exits 0, the login shell (`-lc`) exits 0, VS Code disposes the terminal silently [S]. `sendText` on a disposed terminal is a no-op. Result: any listing, upload, download, mkdir,
   or auto-sync-on-save closes the REPL and leaves the user with no REPL. In the (rare) case where the terminal survived, the restart command is typed into mpremote's stdin and goes **to the board**, which tries to execute `'/path/python' -m mpremote ...` as Python.
2. **`skipIdleOnce` leaks.** `runFromView` sets it (`:1080`) before every sidebar/toolbar action. The flag is only cleared by the next `withAutoSuspend`. `openRepl` and `runActiveFile` never call `withAutoSuspend`, so the flag survives; the next unrelated listing or
   auto-sync runs with the REPL still open and no Ctrl-X. Reproduced [E1-C case 1]: after sidebar "Open Repl", `autoSuspendLs` spawns `fs tree` immediately with no Ctrl-X. In real life that mpremote fails with the flock error [E7], is retried twice with 0.5/1.0 s backoff,
   and then the tree shows "ESP32 list error at /: mpremote: failed to access ...".
3. **Not everything is wrapped.** `fileExists`, `healthCheck`, `reset`, `listSerialPorts` and the `softReset` fallback call mpremote directly; they conflict with an open REPL or Run terminal.
4. **`ensureIdle()` doubles the traffic**: an extra `mpremote fs tree` (soft reset, full filesystem walk) before every wrapped operation; results are cached for 30 s only for listing (`mpremote.ts:257`).
5. `preListDelayMs` (default 150) is only applied while a single global boolean `listingInProgress` is true. It cannot make the OS "settle"; mpremote already waits on the raw-REPL banner.
6. `strictConnect` + `interruptOnConnect` (`mpremoteCommands.ts:291-343`): up to two attempts of `mp.reset()` (a **hard** `machine.reset()`, errors swallowed at `mpremote.ts:1471-1475`) followed immediately by `mp.ls("/")`. The board is rebooting, so
   `enter_raw_repl` often waits its full 10 s [S: `transport_serial.py:178-212`]. `strictConnectHandshake` falls out of its loop without throwing when both attempts fail, so the REPL terminal opens anyway. The `ls` on an empty filesystem triggers the fallbacks
   (`fs tree` twice, then `fs ls`: four mpremote processes, [E1-B]).

### 3.6 Background mpremote calls

`runMpremote` (`mpremote.ts:142-233`):

- `exec()` with a quoted string, no `timeout`, default 1 MB `maxBuffer`.
- Per-port "operation in progress" flag (`:152-168`): if set, it re-queues itself every 100 ms **with no upper bound**. The flag is cleared only when the child's callback fires. A hung mpremote (`follow` has no timeout, `transport_serial.py:218-232`) blocks every later call, including
  `fileExists` inside Run, silently and forever. Only the status-bar "MPY: Cancel" kills `currentChild`, and only the most recently started child.
- `attempt++` runs on every re-entry (`:148`), so waiting for the lock burns the retry budget: a call that waited more than about 200 ms gets no retry on transient errors.
- Retries only on strings like "failed to access", "it may be in use by another program", "device not configured" (`:204-214`).
- Terminal-hosted mpremote processes (REPL, Run) are invisible to this lock, so it only serialises background calls against each other.

### 3.7 What leaves the port busy

- The Run terminal's mpremote for the lifetime of the script (an infinite `while True` is the common student program). mpremote `run` holds the port until the script ends or the process is killed.
- The REPL terminal's mpremote.
- Any background `exec` child whose caller was cancelled: `currentChild` tracks only one process (`mpremote.ts:26`, `:1574`).
- An mpremote that was started before "Developer: Reload Window" (children are not killed on deactivate; `deactivate()` is empty at `extension.ts:1153`).
- Other tools: Thonny, Arduino IDE serial monitor, another VS Code window (flock / Windows exclusive open).

---

## 4. Who contends for the port (HEAD)

| Actor | Port user | Lifetime | Protected by |
|---|---|---|---|
| "ESP32 REPL" terminal | `mpremote repl` in a pty | until the terminal dies | nothing |
| "ESP32 Run File" terminal | `mpremote run/exec` | until script ends | nothing |
| Tree listing, upload, download, mkdir, delete, sync | `exec(mpremote fs ...)` | seconds, each soft-resets the board | per-port flag in `runMpremote`; `withAutoSuspend` (only for wrapped ops; leaky) |
| `fileExists` in Run, `healthCheck` in Stop/Interrupt, `reset`, port listing | `exec(mpremote ...)` | seconds | per-port flag only |
| Auto-sync on save | via `withAutoSuspend` | seconds, **triggered by Run's own save** | queue reset on every call |
| `echo > /dev/cu.*` | shell redirect, bypasses flock | milliseconds | nothing |

Every one of these is a separate OS process that opens and closes the tty, drives DTR/RTS, and (for the raw-REPL ones) interrupts and soft-resets the board. Because mpremote soft-resets on the first raw-REPL entry of every process
(`main.py:548-553` [S]), the student's program is killed and `boot.py` re-run each time. On the ESP32 port `main.py` is skipped when the soft reset happens in raw-REPL mode [S: `ports/esp32/main.c:143-150`], so after a sync the board is sitting at the prompt, not running the program.

---

## 5. Shell and quoting matrix (HEAD)

Strings come from `shellEscape` (`mpremoteCommands.ts:8-10`, `mpremote.ts:7-9`): wrap in `'...'`, replace `'` with `'\''`.

| Target | REPL terminal | Run terminal | Background `exec` | Evidence |
|---|---|---|---|---|
| macOS zsh / bash | works, including spaces and apostrophes | works | works | [E1-A, E1-B]; `bash -c` and `zsh -c` on the generated string printed the argv intact |
| fish | works (`\'` outside quotes is a literal quote) [K] | works | n/a (`exec` uses sh) | |
| Windows PowerShell (default VS Code profile) | n/a (REPL forces cmd.exe) | **fails**: `'C:\...\python.exe' -m mpremote ...` is a string expression followed by `-m` -> `ParserError: Unexpected token '-m'`. The POSIX `'\''` escape is also invalid in PowerShell | n/a | [E5] on pwsh 7.4.6; identical behaviour in Windows PowerShell 5.1 [K] |
| Windows cmd.exe | **fails**: `cmd.exe /d /c 'C:\...\python.exe' ...` -> "'C:\Users\Student' is not recognized as an internal or external command" | fails if the profile is cmd | **fails** (`exec` runs `cmd.exe /d /s /c "<string>"`) | [K]; verify on any Windows box with `node -e "require('child_process').exec(\"'python' -V\",(e,o,s)=>console.log(e&&e.message,s))"` |
| Windows Git Bash | REPL still forces `cmd.exe` -> fails | works | fails | |

So in HEAD every mpremote call on Windows fails, not only Run/REPL: the sidebar tree, upload, and everything else go through `exec` with the same quoting. The installed `.vsix` build used double quotes and the bare command, which is why it can work on Windows when `mpremote` is on PATH.

Interpreter handling differs between terminals and child processes. Both call `getPythonPath()`, but the terminal command contains the resolved string, which the terminal's shell then resolves again with the **terminal's** PATH and cwd (`'python3'` can be a different interpreter there than in the extension host), while `exec`/`execFile` resolve with the host's PATH. A bare name such as `py -3`
(Windows fallback list, `pythonInterpreter.ts:204-207`) is shell-escaped into a single token `'py -3'` and cannot work in either place.

---

## 6. mpremote and MicroPython facts these features depend on

All [S] unless noted; verified on 1.29.0 with 1.24.1/1.26.0/1.27.0 spot checks [E11].

1. **Commands and flags used by the old code exist in 1.26.0-1.29.0** (the declared minimum is 1.26): `connect <dev>`, implicit `repl`, `run`, `exec`, `exec --no-follow`, `reset`, `soft-reset`, `resume` (help output identical in 1.24.1, 1.26.0, 1.27.0, 1.29.0), and `fs tree|ls|mkdir|cp|...`. `fs tree` is the exception: it is absent from 1.24.1's `do_filesystem`, where it silently does nothing, which matches the README's warning about 1.24.x. Nothing in the old code needs a newer mpremote than 1.26.
2. **`fs stat` and `fs run` do not exist.** `do_filesystem` (`commands.py:380-455`) has an `if/elif` chain with no `else`, so unknown subcommands do nothing and return 0 [E2]. (`fs run` is only used by the dead `mp.runFile`.)
3. **`reset` is a hard reset.** Shortcut table `main.py:407-414`: `exec --no-follow "import time, machine; time.sleep_ms(100); machine.reset()"`. A real soft reset is the `soft-reset` command, or Ctrl-D at an empty prompt. The old "Soft Reset (no REPL open)" therefore hard-resets; on native-USB boards (S3/C3) that drops and re-enumerates the port.
4. **Every mpremote process soft-resets the board the first time it enters the raw REPL** (`State._auto_soft_reset = True`, `main.py:536,548-553`; `do_disconnect` re-arms it, `commands.py:91`). `resume` suppresses that (`commands.py:530-531`). Entering raw REPL always sends `\r\x03` first (`transport_serial.py:179`), so even `resume` interrupts a running program.
5. **Exclusive port access.** `SerialTransport(..., exclusive=True)` (`transport_serial.py:52,64-65`): a second opener gets `failed to access <port> (it may be in use by another program)`, exit 1 [E7]. On Windows the OS enforces this for COM ports [K].
6. **`mpremote run` + Ctrl-C.** `_do_execbuffer` (`commands.py:482-496`) turns KeyboardInterrupt into `sys.exit(1)`; the finally block calls `exit_raw_repl()` which writes `\r\x02` only (`transport_serial.py:214-216`). The board is never sent `\x03` [E3]. `follow()` has no timeout (`:218-232`).
7. **`mpremote repl` needs a real tty on stdin.** `ConsolePosix.__init__` calls `termios.tcgetattr(stdin)` (`console.py:24`). It cannot be driven through pipes; that is why the old extension had to use a real terminal, and why a `Pseudoterminal` implementation cannot just spawn it.
8. **Disconnect handling in `repl`.** `_is_disconnect_exception` (`repl.py:105-121`) treats as a clean disconnect only `errno 5` and messages containing "Write timeout", "Device disconnected", "ClearCommError failed". Not matched: macOS `ENXIO` (6, "Device not configured") and pyserial's "device reports readiness to read but returned no data (device disconnected or multiple access on port?)" (lower-case d) [E8]. Those propagate as a Python traceback with exit 1. Which of the two a macOS unplug produces needs the physical board (section 13).
9. **DTR/RTS on open.** Only the Windows + CP210x path has special handling (`transport_serial.py:71-85`); everywhere else pyserial's default (assert DTR and RTS) applies. On `close()` mpremote sets `rts=False` then `dtr=False`. Whether open/close of the class's CP2102 boards resets the ESP32 is unverified [K].
10. **MicroPython control keys** (readline.c:146-170, pyexec.c): Ctrl-A (raw REPL), Ctrl-B (friendly REPL / banner), Ctrl-D (soft reset; "finish" in paste mode) and Ctrl-E (paste mode) are control keys **only on an empty line**. On a non-empty line they edit (home, back, delete, end). Ctrl-C always cancels/interrupts.
11. **Soft reset sequence on ESP32** (`ports/esp32/main.c:143-150`): `boot.py` always runs; `main.py` runs only if the REPL mode is friendly. So Ctrl-D at the friendly prompt re-runs `boot.py` and `main.py`, while mpremote's raw-REPL soft reset runs `boot.py` only.

---

## 7. Ranked root causes

Confidence: H = mechanism verified and sufficient to produce the symptom; M = mechanism verified, frequency depends on environment; L = plausible, needs the board or the user.

### 7.1 "REPL did not open reliably"

**R1 (H). The REPL is a disposable process and every failure destroys the evidence.** [E7, S, R]
Failure sequence:
1. User clicks Open Repl while any other mpremote holds the port. This is routine: for several seconds after choosing a port the tree's `fs tree` runs (`pickPort` -> `tree.refreshTree()` -> `autoSuspendLs`); also after every folder expansion, upload, auto-sync save, a Run that is still attached, `fileExists`, `healthCheck`.
2. `getReplTerminal` creates the terminal (no check of any lock).
3. mpremote: `failed to access /dev/cu.usbserial-0001 (it may be in use by another program)`, exit 1 [E7].
4. VS Code disposes the terminal (exit != 0, no `waitOnExit`) and raises a toast with only the shell command line and the exit code. The stderr line is gone with the terminal.
5. The user sees a terminal flash and disappear. Click again 3 s later and it works. That is "not reliable".
Same outcome for a wrong interpreter (R5), a changed port name, or an unplugged board.
Refute/verify: set `terminal.integrated.showExitAlert` true, click Open Repl twice quickly; or run `python -m mpremote connect <port>` in a normal terminal while `fs tree` is running in another.

**R2 (H). Auto-suspend kills the REPL and cannot restore it.** [E1-B/C, S]
1. REPL open. User expands a folder, saves a file with auto-sync on, uploads, or refreshes.
2. `withAutoSuspend`: `isReplOpen()` true -> `sendText("\x18")`.
3. mpremote exits 0, the login shell exits 0, VS Code disposes the terminal silently (exit code 0).
4. 200 ms later the op runs; afterwards `restartReplInExistingTerminal` types `'<py>' -m mpremote 'connect' '<port>'` into a terminal that no longer exists (no-op).
5. REPL tab is gone with no message.
Second variant (R2b): sidebar "Open Repl" leaves `skipIdleOnce` set, so the next listing never sends Ctrl-X and fails on the lock while the REPL is open [E1-C case 1].

**R3 (M). The 500 ms Ctrl-C race.** [E4, R]
1. `createTerminal` returns; the pty is spawned; `zsh -lc` starts (login profile sourced); then Python starts and imports pyserial.
2. At t = 500 ms `sendText("\x03")` writes `0x03` to the pty master.
3. If mpremote is already in raw console mode (`Console.enter`, `repl.py:82`; lflag = 0) the byte is forwarded to the board: fine.
4. If not, the tty line discipline (ISIG) converts it to SIGINT for the whole foreground group: `zsh`/`python` die. The terminal shows `^C` [E4 case B: exit status SIGINT; case C: Python traceback]. Nothing reaches the board; the terminal is disposed (exit != 0).
Margin on this Mac: mpremote is up in about 0.25 s [E9], so case A wins; a slow login profile (conda/nvm/brew init, a 0.7 s `.zprofile` in the test), a cold Python on a classroom laptop, or Defender scanning `python.exe` and `.pyc` on Windows [K] eat the margin. On Windows the same race exists through ConPTY Ctrl-C events [K].
Also: the unconditional Ctrl-C/Ctrl-B is unwanted behaviour (kills a running program on open, prints a banner).

**R4 (H on Windows, HEAD). Command strings cannot run.** [E5, K] PowerShell `ParserError`, cmd.exe "not recognized" (section 5). Windows REPL cannot open at all in HEAD.

**R5 (H, shared with complaint 1a). Wrong or missing interpreter.** [E1-A, `01-discovery.md`] With `mpremote` not on the host PATH every probe fails and the resolver returns `python3` (system Python without mpremote) -> `No module named mpremote` -> exit 1 -> terminal vanishes with a generic toast. The user's hand edit fixed exactly this for the REPL terminal only, which is why they then observed the remaining flakiness (R1-R3).

**R6 (M). `mpyWorkbench.connect` is reset to `auto` at every activation** (`extension.ts:187`, [E1-C]) and `getReplTerminal` throws "Select a specific serial port first (not 'auto')" (`mpremoteCommands.ts:245-248`). `openRepl` is registered without a try/catch (`extension.ts:871`); when invoked through `runFromView` the error is shown as "Board command failed: ...". The setting is `Global`, so a second VS Code window resets the first window's port.

**R7 (M). The REPL closes by itself on any reset or unplug.** [E8, S] mpremote prints a traceback and exits 1 for some unplug errors, or prints "device disconnected" and exits 0 for others; either way the terminal is disposed. A program that calls `machine.reset()`, a brown-out that resets the USB bridge, or a loose cable ends the REPL with no explanation and no reconnect.

**R8 (L). Reset-on-open of the DTR/RTS lines and `strictConnect`'s hard reset.** `strictConnect`/`interruptOnConnect` only apply to the palette command; `mp.reset()` + immediate `ls` hits the boot window and can wait the full 10 s raw-REPL timeout; failures are swallowed. Needs the board.

**R9 (L). Terminal environment.** `zsh -lc` sources login files each time; output from profiles can be interleaved into the REPL; an unusual `$SHELL` (nu, xonsh) cannot run the POSIX quoting. Low frequency for macOS students.

### 7.2 "Run current file did not seem to work"

**F1 (H, HEAD). `fileExists` is always true, so Run imports the board's copy instead of running the editor's.** [E2, E1-A, R]
1. Save; `fileExists('/lab 1/foo.py')` -> `mpremote fs stat ...` -> exit 0 (no-op) [E2].
2. `onBoard` = true -> `exec "import lab 1.foo"` (module name from the path, `:20-24`).
3. Outcomes, all silent or confusing, none of them "ran my current code":
   - file never uploaded (default `autoSyncOnSave:false`, or workspace not initialised, or the file is in `.mpyignore`): `ImportError: no module named 'foo'`;
   - an older copy is on the board: stale code runs, edits "have no effect";
   - student code guarded by `if __name__ == "__main__":` does nothing because `__name__ == "foo"` under import;
   - file names that are not identifiers (`lab 1.py`, `my-file.py`, `2-blink.py`, `v1.2.py`, apostrophes) -> `SyntaxError` [E1-A: `exec 'import lab 1.it'\''s here'`];
   - `rootPath` other than `/`: existence is checked at `<rootPath>/rel` but the import resolves via `sys.path` (`/`, `/lib`);
   - names that collide with built-in or frozen modules (`import test`, `math`, `random`, `time`, `machine`) import the built-in, not the file [K].
Refute/verify: in Run's terminal, look for `import <name>` in the typed command; run `mpremote connect <port> fs stat /nonexistent` once.

**F0 (M-H, installed build). `mpremote` not on the terminal's PATH.** The installed build types `mpremote connect <port> run "<file>"`. `exec`-based `fileExists` fails with ENOENT (swallowed) so it always chooses `run`, which is the right command, but the command only resolves if the
venv is active in that terminal [R, `01-discovery.md` 1.2]. Symptom: `zsh: command not found: mpremote` in "ESP32 Run File". Verify by reading that terminal. The hacked REPL command proves the user knew the venv path; the Run command was not hacked.

**F2 (H). No timeout, no progress, errors swallowed before the terminal even appears.** `mp.fileExists` swallows every failure and returns false (`mpremote.ts:1296-1313`); `runMpremote` waits unboundedly for an in-progress flag (3.6). Run therefore spends 2-5 s (or forever) doing a pointless `fs stat` with no UI. The user perceives "nothing happened".

**F3 (H). Port contention and queued keystrokes.** [E7, R]
1. First Run starts `while True:` code; mpremote holds the port.
2. Second click: `fileExists` -> flock error -> retried twice -> `false` (swallowed, about 1.5 s).
3. `sendText(cmd)` goes into the same terminal where mpremote is still running; the text is echoed by the tty and queued.
4. Nothing visible happens until the first run is stopped; then the queued command starts a surprise second run. Stop (3.4) may or may not interrupt the first one.

**F4 (H on Windows, HEAD). Shell quoting.** Same as R4 for the Run terminal and `exec`.

**F5 (H). Ctrl-C does not stop a Run, Stop does not reliably either.** [E3, E6] After Ctrl-C in the Run terminal the board still runs the script (mpremote sends only Ctrl-B); the next mpremote's `enter_raw_repl` interrupts it, which is why the effect is confusing. Stop is the `echo` path (3.4).

**F6 (M). Run races with its own save and with auto-sync.** `document.save()` triggers the upload through `withAutoSuspend` (`extension.ts:1093-1121`), concurrent with the precheck; with the queue reset on every call there is no ordering between "upload finished" and "import starts".

**F7 (L). Large files and memory.** `mpremote run` raw-pastes the whole source; a `MemoryError` on the board is reported as a traceback only.

**F8 (L). Untitled/unsaved or non-Python editors.** No check of `languageId` or `isUntitled`; `document.save()` on an untitled buffer opens a dialog; `run Untitled-1` fails with "could not read file".

### 7.3 Adjacent: Stop / Interrupt / Soft reset

Section 3.4. Net effect: Stop = slow `fs tree` + a Ctrl-C that works on macOS only because the shell redirect bypasses the lock + a Ctrl-D that does not reset. Windows: neither works. These three buttons should be reimplemented as direct writes on the owned connection (section 10).

### 7.4 What I cannot determine and how to settle it

1. **Which build and which symptom?** Ask the user to open the "ESP32 Run File" terminal after a failed Run and report its first line(s): `command not found: mpremote` (F0), `ImportError`/`SyntaxError` after `import ...` (F1), a flock error (F3), or empty (never ran).
2. **Did REPL fail at launch or die later?** Check whether a toast `The terminal process ... terminated with exit code` appeared (R1/R3/R5 at launch) or the tab vanished after a tree/upload action (R2).
3. **Does a clean install of the HEAD build behave the same on macOS?** Install HEAD into a scratch VS Code profile (`--user-data-dir`), put mpremote on PATH, and click Open Repl twice; R1/R2 reproduce without the hack. (Needs no board for R1/R2; the lock error occurs on any attempt to open a missing or busy port.)

---

## 8. Unplug, replug, and port names

| Situation | Old behaviour | Evidence |
|---|---|---|
| Unplug with REPL open | mpremote either exits 0 with "device disconnected" or crashes with a traceback (macOS ENXIO and the pyserial readiness error are not classified); the terminal is disposed either way, no reconnect, no status | [E8, S, E10] |
| Unplug during Run | mpremote error in the Run terminal; the shell survives so the text is visible; no extension state change | [R] |
| Unplug with only the tree open | next `fs tree` fails with "failed to access" or "no such file"; `fileExists` returns false; `markUnhealthy` flag set but never acted on (`mpremote.ts:56-61`) | [R] |
| Replug at the same name | works again only by clicking | |
| Name change (Windows COM3 -> COM5, Linux ttyUSB0 -> 1) | `mpyWorkbench.connect` still holds the old string; every call errors; the setting is reset to `auto` only at the next activation; `auto` is then refused by Run/REPL | `extension.ts:187`, `mpremoteCommands.ts:245` |
| macOS `/dev/cu.*` vs `/dev/tty.*` | `normalizeConnect` (`mpremote.ts:11-24`) adds `/dev/` to a bare `cu.xxx` but does not map `tty.` to `cu.`; `tty.*` blocks on open waiting for carrier detect on some drivers [K]; mpremote's own listing only reports `cu.*` (E12) | [E12] |
| Port picker | `listSerialPorts` (`mpremote.ts:849-879`) parses `mpremote connect list` and shows every entry, including `/dev/cu.Bluetooth-Incoming-Port`, `/dev/cu.BLTH`, `/dev/cu.thinkplus-GM2pro` (`None 0000:0000`) labelled "Serial Port" | [E12] |
| Identical boards | the class CP2102s report serial number `0001` (E12), and macOS derives `/dev/cu.usbserial-0001` from it, so every board gets the same name; serial number cannot distinguish two boards on one machine | [E12] |

---

## 9. Error visibility audit

| Path | Failure | What the user sees |
|---|---|---|
| REPL launch (`getReplTerminal`) | mpremote exit != 0 | terminal disposed; generic toast (`showExitAlert` permitting) with command line and code, no stderr [S] |
| REPL exit 0 (Ctrl-X, "device disconnected") | | silent disposal |
| Run terminal | any | shell stays open, output visible (the one honest path) |
| `fileExists` | any error incl. no device, busy, timeout | swallowed -> `false` (`mpremote.ts:1296-1313`) |
| `mp.reset` | any | swallowed (`:1471-1475`) |
| `strictConnectHandshake` | both attempts fail | swallowed (`mpremoteCommands.ts:329-343`) |
| `healthCheck` | any | reduced to a boolean; Stop warns and continues |
| `robustInterrupt*` | | up to 3 toasts per click, mixing info and warning |
| `listSerialPorts` | no devices | warning "No ESP32 devices detected. Make sure mpremote is installed and available in PATH." even though the list is non-empty of Bluetooth ports |
| `runMpremote` | hung child | nothing, forever (3.6) |
| `softReset` fallback | mpremote error | error toast with stderr (the good case) |

---

## 10. Ideal design for the new extension

### 10.1 Principles

1. **One owner for the serial port.** One long-lived connection per selected board, owned by the extension host. Nothing else opens the device.
2. **No shell strings.** No `sendText` of commands, no `exec` with quoted strings. Child processes (if any) are started with `execFile(file, argv[])`.
3. **The terminal is a view.** Closing it never closes the port; opening it never reconnects.
4. **Every operation is an explicit state transition** with an expected reply and a timeout. Nothing is swallowed; errors are shown in the status bar, the terminal, a toast with "Show details", and the log channel.
5. **User intent preempts background work.** Tree refresh, auto-sync and status probes yield to Run, Stop and typing.
6. **Student mental model:** Run = "send this file now and show me what it prints"; Stop = "stop it"; Reset = "restart the board like pressing EN"; the REPL is always there and never needs "opening to work".

### 10.2 Components

| Component | Responsibility |
|---|---|
| `PortDiscovery` | Enumerate serial ports with VID/PID/serial/product; rank ESP32-class bridges first (10C4:EA60 CP210x, 1A86:7523 CH340, 0403:6001 FTDI, 303A:* Espressif); hide `vid:pid 0000:0000`/Bluetooth/debug-console by default; on macOS rewrite `/dev/tty.X` -> `/dev/cu.X`; match a remembered board by VID/PID (+serial if unique) rather than by name; poll every 1-2 s while disconnected; auto-select when exactly one candidate. |
| `BoardTransport` (interface) | `open(path, {baud:115200, dtr:false, rts:false, hupcl:false})`, `write`, `onData`, `onClose/onError`, `setSignals`, `close`. Implementations: **A** Node `serialport` (N-API; prebuilds for darwin x64+arm64 and win32 x64/arm64/ia32 exist and load [E13]), **B** Python helper over pyserial (fallback if A fails to load), **C** fake board for tests. |
| `ReplProtocol` | Streaming parser and `expect(pattern, timeout)` machinery: friendly prompt `>>> `, `... `, banner, `raw REPL; CTRL-B to exit`, raw-paste handshake (`\x05A\x01` -> `R\x01` + window size, flow control, `\x04` end markers), paste mode, `soft reboot`. Port the logic of `transport_serial.py:178-312` (read it, do not shell out). |
| `BoardSession` | State machine (10.3), priority queue, ring buffer (last ~64 KB) of everything the board printed, events (state, data, error), reconnect logic. |
| `ReplTerminal` | `ExtensionTerminalOptions` + `Pseudoterminal` (10.6). |
| `RunController`, `FileOps`/`SyncEngine` | Use `BoardSession.runExclusive`. |
| `StatusBar`, `Diagnostics`, `LogChannel` | 10.9-10.10. |

Transport choice: A removes the Python/mpremote/venv dependency for REPL, Run, Stop, Reset and file operations entirely, which is what "just works on macOS and Windows" needs, and directly retires complaint 1a for this area. B keeps using the user's venv. The abstraction costs one interface. The Phase 0 spike must open a real board with A on one Mac and one Windows laptop (section 13) before committing. If A fails the spike, ship B with the same `BoardSession`.

### 10.3 State machine

```
                 +------------+   port appears / user picks   +------------+
   start ------> |  NoBoard   | ----------------------------> | Connecting |
                 +------------+                               +-----+------+
                       ^                                            | open ok (no reset, no interrupt)
                       | user "Forget board"                        v
 +--------------+  unplug / io error                          +---------+   Run / Stop / Reset / file op
 | Disconnected | <------------------------------------------ |  Idle   | -------------------------------+
 | (port known, |   poll finds same VID/PID                    | (REPL   |                                |
 |  reconnecting)| ------------------------------------------> | prompt) | <------------------+           v
 +--------------+        Connecting                            +----+----+                    |      +----------+
                                                                    | main.py/boot output     |      |  Busy    |  raw REPL op
                                                              (Running-unknown shown as Idle   |      | (sync,   |  (sync, list,
                                                               with live output)               |      |  list)   |   stat) 
                                                                    | Run                     |      +----+-----+
                                                                    v                         |           |
                                                              +-----------+   program ends    |           |
                                                              |  Running  | ------------------+<----------+
                                                              +-----+-----+  (Ctrl-B, banner filtered)
                                                                    | Stop (Ctrl-C x2)
                                                                    v
                                                              back to Idle (or Error: "board not responding")
```

Rules:
- `Connecting` opens with DTR and RTS low and hupcl off, performs **no** reset and **no** interrupt, starts the always-on reader, and sends a single `\r` to elicit a prompt only when the user attaches the terminal or runs something. A board running `main.py` is left running and its output is shown.
- `Idle` means "friendly REPL, or output we have not classified". `Running` is entered only by the extension's own Run; unknown output at boot is displayed but does not change the state.
- Any state -> `Disconnected` on an error classified as unplug (below); the terminal shows a red banner; ops in flight are rejected with a clear error.
- Raw-REPL entry (Busy, Running) always starts with Ctrl-C x2 and waits for the expected banner with a timeout, retrying up to 3 times.

### 10.4 Port ownership, who may do what

| Event | Rule |
|---|---|
| Opening the port | Only `BoardTransport` inside `BoardSession`, once per selected board, held until: Disconnect, port change, unplug, extension deactivation, or "Release port" (for flashing with esptool). |
| REPL terminal | Reads the session ring buffer and subscribes to data; writes go to `session.writeUser(bytes)`. While `Busy`, user keystrokes are buffered (cap 4 KB) and flushed afterwards, with the status bar showing why. While `Running`, keystrokes go to the program (stdin). |
| Run | `runExclusive('run')`: highest user priority, preempts background work, interrupts the current program. |
| Stop / Interrupt | Bypass the queue; write `\x03` `\x03` (50 ms apart) directly, then wait for a prompt. |
| Soft reset / Reset | Bypass the queue; defined in 10.5. |
| File ops (sync, upload, download, delete, mkdir, rename) | `runExclusive('files')`: one raw-REPL session per batch (coalesce pending ops), no soft reset on entry (`soft_reset=False` equivalent), Ctrl-B on exit. If a program started by Run or `main.py` is producing output, ask once ("Stop the running program to sync?", with "always"), otherwise defer and show "N files pending". |
| Tree refresh, status probes | `background` priority: run only when `Idle` and no user ops queued; coalesce; never interrupt a running program; the tree shows a stale marker instead. |
| Another process holds the port | Detected on `open` (EBUSY/EACCES/flock failure; Windows "Access is denied") -> state `Error: port in use`, message names likely culprits (Thonny, Arduino IDE, another VS Code window, `screen`, a leftover mpremote) with a "Retry" button. |
| Another VS Code window | Same detection via OS lock; the message says it is probably another window. Do not steal the port. |

### 10.5 Stop, Interrupt, Reset (semantics and buttons)

| Button | Action on the owned connection | Notes |
|---|---|---|
| **Stop** (red square, replaces Run while running) | `\x03` `\x03` 50 ms apart; wait up to 2 s for the friendly prompt `>>> ` (or raw `>`); retry once; if still no response show "Board not responding" with "Hardware reset" and "Show log" | Works in all modes (running, paste mode, partially typed line). |
| **Restart program (soft reset)** | Ensure an empty line (`\x03` first, wait for prompt), then `\x04` at the friendly prompt, stream the boot output, state returns to Idle when the prompt reappears. `boot.py` and `main.py` both run [S]. | Label it "Restart (run main.py)". |
| **Hardware reset** | DTR=false (IO0 high), RTS=true (EN low) 100 ms, RTS=false; then reconnect handling as for a reset. | Works when the VM is wedged or `KeyboardInterrupt` is disabled; ESP32 DevKits with the standard auto-reset circuit only [K]; Phase 0 spike to confirm on the class boards. Never use `machine.reset()` over the REPL as the default. |
| **Interrupt** | Same as Stop but does not wait/escalate and does not change UI state (for advanced users, shown in the context menu, not as a primary button). | The old "Interrupt" and "Stop" collapse to this one verb plus Restart. |

Unplug detection feeds the same path: if the port vanishes during Stop/Reset the state goes to `Disconnected`, not an error toast.

### 10.6 Run pipeline (no mpremote `run`, no `import`)

1. Preconditions: active editor is a saved `.py` file; save it (`document.save()` and await). Otherwise show a specific message (untitled, not Python).
2. If no board is connected: auto-detect (one candidate -> connect; several -> picker; none -> message with "Diagnose").
3. `runExclusive('run')`; reveal the "MicroPython" terminal (create if needed, `preserveFocus`).
4. Flush the **dirty set**: files saved since last sync (mtime/hash cache, `.mpyignore`) are uploaded first so that `import mylib` in the student's program sees the current library code. If the active file itself is part of the workspace mirror it is uploaded as well, as a side effect, not as the thing that runs.
5. Interrupt the current program (`\x03` `\x03`); enter raw REPL (`\r\x01`, expect `raw REPL; CTRL-B to exit`).
6. Optional fresh start (setting `mpy.run.freshStart`, default on): `\x04`, expect `soft reboot`, stream `boot.py` output, expect the raw banner again. `boot.py` may block (Wi-Fi); show "Restarting board..." with a Cancel that sends Stop.
7. Raw-paste the **editor buffer** (not the board's copy). Fallback to 256-byte chunks at 10 ms when raw-paste is unsupported. The program runs as `__main__`, so `if __name__ == "__main__":` works.
8. Stream stdout live to the terminal; the stderr part (after the first `\x04`) is rendered in red. Rewrite `File "<stdin>", line N` to the local file and register a terminal link provider so tracebacks are clickable (this is what the old `import` approach, CHANGELOG 0.2.62, was trying to achieve). Imported board modules (`File "lib/util.py"`) map through `rootPath` to workspace paths.
9. On completion send `\x02` (Ctrl-B), swallow the MicroPython banner that Ctrl-B prints, and leave the friendly prompt so variables are inspectable (a feature mpremote's `run` + `repl` also gives).
10. Footer line: `[finished in 1.8 s]`, `[stopped]`, `[board disconnected]`, or `[error: ...]`. State -> Idle.
Run must not call the board's `import`, must not depend on the board's copy of the file, and must report each failure in the terminal and the status bar.

`mpremote mount` is deliberately not used: it needs the host process to stay attached and slows imports on UART bridges.

### 10.7 Output: which surface

| Option | Verdict |
|---|---|
| Real terminal running `mpremote` (old) | Rejected: shell quoting per OS, PATH/venv activation races, no owner, errors vanish with the terminal, cannot see state, cannot map tracebacks. |
| `OutputChannel` | Use only for the log (protocol trace when `mpy.trace` is on, errors, diagnostics). Cannot take input (Ctrl-C, `input()`), cannot be a REPL. |
| **`Pseudoterminal` (`ExtensionTerminalOptions`)** | **Chosen** for REPL, program output and errors in one tab, like Thonny's Shell. Full control over input, colours, state in the tab title, replay on re-open, links. No shell, so identical on macOS and Windows. |
| Node pty / spawning `mpremote repl` under a pty helper | Rejected: `node-pty` is not available to extensions; a Python `pty` helper does not exist on Windows. |

Pseudoterminal specifics (all verified feasible from API shape; behaviour on Windows to be checked in the spike):
- `terminal.sendText()` on a Pseudoterminal should reach `handleInput` (the last hop is verified in the installed ext host: `ExtHostPseudoterminal.input(e){this._pty.handleInput?.(e)}` [S]; that `sendText` is routed there is [K], confirm in the Phase 0 spike). If so, toolbar/palette buttons can reuse the same path; otherwise call the session directly.
- Normalise lone `\n` from raw-REPL output to `\r\n` (xterm would otherwise stair-step); decode UTF-8 incrementally across chunks; batch writes (about 16 ms) and cap scrollback replay for runaway `print` loops.
- On re-open, replay the session ring buffer so the REPL never looks empty.
- Emit `\x1b[?2004h` (bracketed paste) and, on a multi-line paste, wrap it in the board's paste mode (`\x05` ... `\x04`) so students can paste a block of code into the REPL [K: needs a spike].
- Set the terminal title from state (`MicroPython - COM3 - Running lab1.py`) via `onDidChangeName`.
- While a program is running in raw-REPL mode the board does not echo stdin. Phase 2: local echo with a line buffer during `Running` when the program calls `input()` (detect by the prompt text without newline and no echo).

### 10.8 Keys

| Key | At the friendly prompt (empty line) | Non-empty line | Program running (Run) | Handling in the Pseudoterminal |
|---|---|---|---|---|
| Ctrl-C | KeyboardInterrupt message, new prompt | cancel line | KeyboardInterrupt in program | Pass through. Also marks "stop requested" so the footer reads `[stopped]`. On Windows/Linux, VS Code copies instead when text is selected [K]. |
| Ctrl-D | **soft reset** (boot.py + main.py) | delete at cursor | goes to the program's stdin | Pass through; observe `soft reboot` to update state. Tooltip warns it restarts the board. |
| Ctrl-B | friendly REPL / banner | back one char | stdin | Pass through. |
| Ctrl-E | **paste mode** (`=== `; Ctrl-D finishes, Ctrl-C cancels) | end of line | stdin | Pass through on macOS. **On Windows/Linux VS Code binds Ctrl-E to Quick Open and `workbench.action.quickOpen` is in the default `commandsToSkipShell`** [S: E10; K for the binding], so the key never reaches the terminal. Provide a toolbar/palette/status "Paste mode" command that writes `\x05`, and document `-workbench.action.quickOpen` in `terminal.integrated.commandsToSkipShell` for those who want the key. |
| Ctrl-A | enters raw REPL (output stops echoing; banner `raw REPL; CTRL-B to exit`) | home | stdin | Swallow by default with a one-line grey hint (it confuses students); setting `mpy.terminal.allowRawReplKey` to pass it through. Track the banner either way so state stays correct. |
| Ctrl-X, Ctrl-] | no meaning on the board (mpremote exit keys) | | | Pass Ctrl-X through; ignore Ctrl-]. Disconnect is a command, not a key. |
| Tab, arrows, Backspace | device-side completion/history | | | Pass through. |

Because Ctrl-B/D/E only act on an empty line, Soft reset and Paste mode buttons first send Ctrl-C and wait for the prompt (never type onto a half-typed line).

### 10.9 Disconnect detection and recovery

- Treat as unplug (any state): serial `close`/`error` events; errno 5 (EIO), 6 (ENXIO "Device not configured"), 9, 19 (ENODEV); pyserial "device reports readiness to read but returned no data"; Windows `ClearCommError`, `Access is denied` after an established connection, `The device does not recognize the command`; write timeouts; port disappears from `PortDiscovery`. This is the union of what mpremote classifies [E8] plus the macOS cases it misses.
- On unplug: state `Disconnected`, red banner in the terminal, status item "Board unplugged - waiting...", ops rejected, terminal stays open.
- Reconnect: poll discovery every 1 s; re-match by VID/PID(+serial); reopen without reset; print `[reconnected]`; refresh the tree lazily.
- Sleep/wake: the same error path; a wake-up storm of errors is debounced to one reconnect.
- Hard reset by the program (`machine.reset()`): ESP32 UART bridges keep the port open; show a `[board reset]` marker when the boot banner (`ets ...`, `rst:0x...`, or `MicroPython v...`) arrives unexpectedly. Native-USB boards re-enumerate, which is the unplug path.
- Port names: macOS prefer `cu.*`; Windows `COM10`+ opened as `\\.\COMn` by the library; remember by VID/PID; a name change is not an error.

### 10.10 Student-friendly status

One status-bar item (left, high priority) that is always visible when the workspace contains MicroPython files or a board was ever selected, and a matching row at the top of the Board Actions view:

| State | Text | Colour | Click |
|---|---|---|---|
| No board | `$(circle-slash) No board` | warning background | Select board / Diagnose |
| Connecting | `$(sync~spin) Connecting to COM3` | | cancel |
| Idle | `$(check) ESP32 - COM3` | default | open terminal |
| Running | `$(play) Running lab1.py` | blue | Stop |
| Busy (sync) | `$(sync~spin) Syncing 3 files` | | show log |
| Pending | `$(cloud-upload) 2 changes pending` | | sync now |
| Unplugged | `$(debug-disconnect) Board unplugged` | red | Reconnect / Diagnose |
| Port in use | `$(lock) Port in use` | red | Help (names the likely app) |

Tooltip: port, VID:PID, MicroPython version string captured from the banner, last operation and its duration. Editor title bar: a Run (play) button on `.py` files that turns into Stop while `mpy.running`. Terminal tab title mirrors the state.

`MicroPython: Diagnose connection` prints one report (OS, extension version, chosen transport, ports with VID/PID/driver hints for CP210x/CH340 on Windows and macOS, an open test that does not reset the board, prompt probe, translated error codes) to the log channel and offers "Copy report" for the instructor.

### 10.11 Error surfacing

Every failure becomes: a one-line toast with a primary action ("Show details", "Retry", "Select board"), a red line in the terminal, a state change, and a log entry with the raw bytes/errno. No catch-and-return-false. Timeouts have explicit values: open 3 s; interrupt-to-prompt 2 s x 2; raw-REPL entry 2 s x 3; soft-reset wait 30 s with progress and Cancel; file transfer chunk stall 5 s; Run itself unbounded.

### 10.12 Testability (needed to make "just works" a claim)

- A fake board (Python script exposing a pty on macOS/Linux and a TCP socket for the transport interface on Windows CI) that implements friendly REPL echo, `Ctrl-A/B/C/D/E`, raw REPL, raw paste with window flow control, `soft reboot` with boot output, scripted programs (`while True`, `input()`, exceptions, `machine.reset()` emulation), and unplug (close the fd). The prototype used in E3/E4 (`fakeboard_run.py`, Appendix A) is about 70 lines and already speaks enough of the protocol.
- Unit tests for `ReplProtocol` against the fake; `BoardSession` state-machine tests with the fake transport (C); no VS Code needed.
- A hardware-in-the-loop script (section 13) run by the instructor on one Mac and one Windows laptop before each release.

---

## 11. Requirements (testable)

1. Exactly one component opens the serial device; no `mpremote`, shell redirect, or second process opens it while connected.
2. No code path builds a shell command string for a terminal or `exec`; all child processes use `execFile` with argv arrays; the extension works with paths containing spaces, apostrophes and non-ASCII on macOS and Windows.
3. Opening the REPL never disconnects, resets, or interrupts the board and never fails because a background operation is running.
4. Closing the terminal does not close the connection; re-opening it replays recent output.
5. Run executes the **editor's saved buffer** as `__main__` regardless of whether the file exists on the board, regardless of file name, and without `import`.
6. Before Run, files saved since the last sync are uploaded (or the user is told which are pending).
7. Run shows progress for every step that can take more than 300 ms (upload, interrupt, soft reset, paste) and a footer with the outcome.
8. Run traceback frames for `<stdin>` and board-side module files are clickable and open the local file at the line.
9. Stop interrupts a running program within 2 s on a healthy board, on macOS and Windows, with no `mpremote` involved, and escalates visibly if it does not.
10. "Restart program" soft-resets via Ctrl-D on an empty line and results in `boot.py` + `main.py` running; it never uses `echo`.
11. A hardware reset path exists that does not depend on the Python VM responding.
12. Unplug is detected within 2 s in every state, shown in the terminal and the status bar, and the extension reconnects without user action when the same board returns, on a changed port name as well.
13. macOS `/dev/tty.*` is mapped to `/dev/cu.*`; Bluetooth/debug ports are hidden by default; one candidate is auto-selected.
14. "Port in use" is distinguished from "no device" and from "not responding", each with a specific next step.
15. Background operations (tree refresh, status probes) never interrupt a running program and never delay Run/Stop.
16. Auto-sync on save never races with Run: Run flushes pending uploads; sync-on-save while a program is running is deferred or asks once.
17. Mode keys are documented in the terminal's first line; Ctrl-E has a button equivalent on Windows; Ctrl-A is handled.
18. Multi-line paste into the REPL works (bracketed paste -> paste mode), or the limitation is documented.
19. No setting is forcibly reset by activation (`mpyWorkbench.connect` must not be overwritten); the chosen board is stored per workspace.
20. Every error path produces visible output with the underlying cause; no function returns a default value on error without logging at error level.
21. The extension functions with `terminal.integrated.showExitAlert` on or off, in any default terminal profile (zsh, bash, PowerShell, cmd, Git Bash), because it does not depend on any of them.
22. Python/mpremote presence is not required for REPL, Run, Stop, Reset (transport A); if transport B is used, the interpreter and mpremote/pyserial checks are done by the resolver in `01-discovery.md` and failures are shown in the status bar, never as a vanishing terminal.
23. Output handling copes with 100k lines/minute (batching, bounded buffers) and long single lines.
24. A fake-board test suite covering requirements 3-12 runs without hardware.

---

## 12. What to preserve from the old extension

- The three-view sidebar and its action names (Run file, Open Repl, Stop, Soft Reset, Interrupt) and the editor-to-sidebar ergonomics the user likes.
- Auto-mirroring of local workspace and board filesystem, `.mpyignore`, the sync manifest idea, and the "mirror without opening the REPL" workflow (the new design makes it true by construction: connection is automatic, REPL is a view).
- Wanting tracebacks that point at the right file (the `import` trick, CHANGELOG 0.2.62 / issue #14); implement via link provider instead.
- The auto-suspend idea (never fight the REPL for the port) as a design goal, delivered by ownership instead of by closing the terminal.
- "Select a specific port" being explicit; keep an explicit chosen board, but add auto-detect for the one-board case.
- Per-workspace override file concept (`.mpy-workbench/config.json`), except for the port, which must not be reset on activation.
- Status-bar affordances for auto-sync and cancel; generalise to the single state-driven item.
- The README's honesty about test coverage (ESP32-S3/C3 only, no Windows validation): the new project must test classic ESP32 + CP2102 (the class boards) and Windows.

---

## 13. Hardware verification checklist (for when the board may be used)

None of these were run (the port is off-limits for this analysis). Each is labelled with the claim it settles.

1. Open/close with DTR and RTS low and `hupcl=false`: does the CP2102 ESP32 reset? Compare with pyserial default open. (Claims: R8, connect-without-reset, 10.3.)
2. Unplug with an mpremote REPL open on macOS: capture the exception (ENXIO vs "device reports readiness") and exit code. (R7, section 8.)
3. `mpremote run loop.py`, Ctrl-C in the terminal: does the LED/loop keep running? (F5, section 6.6.)
4. Ctrl-D with `-e ` typed first (the old `echo -e` effect): does the board soft-reset? (Section 3.4; predicted no.)
5. Hardware reset via RTS pulse with DTR high: resets and boots to REPL; also while `while True: pass` with `micropython.kbd_intr(-1)` is active.
6. Raw-paste support and window size on the class firmware (custom firmware with frozen modules); behaviour of `\x05A\x01` on older firmware.
7. Windows laptop: `serialport` opens a COM port; Ctrl-E key reaches or does not reach a Pseudoterminal; PowerShell/Git Bash as default profile; Defender latency.
8. Measure real time-to-prompt after an interrupt, after soft reset with the class's `boot.py`, and after `machine.reset()` on UART-bridge ESP32.
9. Identical boards: two CP2102s with serial `0001` on one Mac; how names behave.
10. Sleep/wake of the laptop with the port open.

---

## 14. Risks and open questions

Risks:
- Transport A (`serialport`) is only proven to load; opening a CP2102 port, signal handling and Windows behaviour are unverified (item 13.1, 13.7). Fallback B exists.
- Pseudoterminal gives up the real tty: no job control, so we own line-editing quirks (local echo during `input()`, bracketed paste). Mitigation: Phase 2 items, documented limits.
- Ctrl-E/Windows interception and Ctrl+C-with-selection are VS Code behaviours outside our control; buttons mitigate.
- Boards with custom firmware may print at boot or run `main.py` forever; the state machine must treat unknown output as Idle and never assume a clean prompt.
- Raw-REPL file operations always interrupt the student's program; the UX (pending-changes indicator, ask-once dialog) needs classroom validation.
- `extensionKind: ["workspace"]` (old `package.json:13`) places the extension on the remote side in WSL/SSH/Dev Containers/Codespaces, where USB serial is not available; the new manifest should declare `ui`-side where possible or document the limitation.

Open questions for the orchestrator/user:
1. Is a Python/mpremote dependency acceptable to remove entirely for the REPL/Run/file layer (transport A), or must students use the venv's mpremote (keep B as default)? This is the main fork between a rewrite of the transport and a smaller rewrite on top of mpremote.
2. Run semantics: should Run default to a fresh soft reset (clean state, runs `boot.py`) or keep the REPL namespace? Recommendation: fresh by default, setting to change.
3. Should Run upload the whole dirty set (needed for `import mylib` of local modules) or only the active file? Recommendation: dirty set.
4. How should auto-sync behave while a program is running: defer, ask once, or force-stop? Recommendation: defer with a visible pending count; Run flushes.
5. Do the class boards run `main.py` on boot, and does `boot.py` block (Wi-Fi)? Affects the soft-reset timeout default.
6. Is Windows PowerShell the default profile on the students' laptops, and are they using VS Code on bare Windows (not WSL)? Affects Ctrl-E guidance and the diagnostics.

---

## Appendix A - Reproduction scripts (condensed from the scratchpad)

Paths below are placeholders: `SP` is the scratchpad, `$PY` = `SP/venv-mpr/bin/python` (mpremote 1.29.0 + pyserial installed).

### A.1 `fs stat` is a no-op (E2)

```python
# usage: python fs_stat_test.py <dir containing the mpremote package> -- connect /dev/fake fs stat /nope.py
import sys
sys.path.insert(0, sys.argv[1]); args = sys.argv[3:]
import mpremote
from mpremote import commands, main as m
calls = []
class FakeT:
    in_raw_repl = False; mounted = False; device_name = "FAKE"
    def enter_raw_repl(self, soft_reset=True): calls.append(("enter_raw_repl", soft_reset)); self.in_raw_repl = True
    def exit_raw_repl(self): calls.append(("exit_raw_repl",)); self.in_raw_repl = False
    def close(self): calls.append(("close",))
    def __getattr__(self, n):
        def f(*a, **k): calls.append((n, a)); raise AssertionError("unexpected transport call " + n)
        return f
commands.SerialTransport = lambda dev, baudrate=115200, **k: (calls.append(("open", dev)), FakeT())[1]
sys.argv = ["mpremote"] + args
print("rc", m.main(), "version", mpremote.__version__, "calls", calls)
# Observed on 1.24.1/1.26.0/1.27.0/1.29.0: prints "stat :/nope.py", rc 0,
# calls == [open, enter_raw_repl(True), exit_raw_repl, close]  -> a silent no-op that still soft-resets the board.
```

### A.2 What `mpremote run` writes on Ctrl-C (E3), core of the emulator

```python
import serial, sys, time, signal, subprocess
class FakeSerial:                      # raw REPL + raw-paste responder; logs every host->board byte
    def __init__(s, log): s.log=open(log,"w"); s.out=bytearray(); s.mode="friendly"; s.running=False; s.paste=None; s.pend=bytearray(); s.t=0; s.n=0; s.is_open=False; s.dtr=s.rts=True
    def L(s,*a): s.log.write(" ".join(map(str,a))+"\n"); s.log.flush()
    def isOpen(s): return s.is_open
    def open(s): s.is_open=True
    def close(s): s.L("CLOSE"); s.is_open=False
    def inWaiting(s): s._pump(); return len(s.out)
    def read(s,n=1): s._pump(); b=bytes(s.out[:n]); del s.out[:n]; return b
    def write(s,d):
        s.L("HOST->BOARD", repr(bytes(d)))
        for b in bytes(d): s._rx(b)
    def _rx(s,b):
        if s.paste is not None:
            if b==4: s.out+=b"\x04"; s.paste=None; s.running=True; s.t=time.monotonic()
            return
        if b==3 and s.running: s.out+=b"Traceback...KeyboardInterrupt: \r\n\x04\x04>"; s.running=False; return
        if b==1: s.mode="raw"; s.out+=b"raw REPL; CTRL-B to exit\r\n>"; return
        if b==2: s.mode="friendly"; s.L("board: friendly REPL; script still running =", s.running); return
        if b==4 and s.mode=="raw" and not s.running: s.out+=b"soft reboot\r\nraw REPL; CTRL-B to exit\r\n>"; return
        if b==5: s.pend=bytearray(b"\x05"); return
        if s.pend:
            s.pend.append(b)
            if len(s.pend)==3: s.out+=b"R\x01"+(128).to_bytes(2,"little"); s.paste=bytearray(); s.pend=bytearray()
    def _pump(s):
        if s.running and time.monotonic()>=s.t+0.2: s.n+=1; s.out+=b"tick %d\r\n"%s.n; s.t=time.monotonic()
# driver: serial.serial_for_url = lambda *a, **k: fake ; run mpremote.main.main() with argv "connect /dev/fake run loop.py";
# after 2 s send SIGINT to the process. Observed log tail:
#   HOST->BOARD b'\r\x02'
#   board: friendly REPL; script still running = True
#   CLOSE      (and the process exits with code 1; no b'\x03' was ever written after the script started)
```

### A.3 Ctrl-C versus mpremote start-up (E4)

```python
import os, pty, sys, time, select, termios, signal
SP, delay = sys.argv[1], float(sys.argv[2]); py = SP + "/venv-mpr/bin/python"
bm, bs = os.openpty(); board = os.ttyname(bs)                     # private pty acting as the board (not a serial device)
a = termios.tcgetattr(bs); a[3] &= ~termios.ECHO; termios.tcsetattr(bs, termios.TCSANOW, a)
pid, term = pty.fork()                                             # the "VS Code terminal"
if pid == 0:
    os.environ["ZDOTDIR"] = SP + "/exp/zdot"                       # zdot/.zprofile contains "sleep 0.7" for case B
    os.execv("/bin/zsh", ["zsh", "-lc", "'%s' -m mpremote 'connect' '%s'" % (py, board)])
t0 = time.monotonic(); sent = False; out = b""; board_rx = b""
while time.monotonic() - t0 < 4:
    if not sent and time.monotonic() - t0 >= delay: os.write(term, b"\x03"); sent = True
    r, _, _ = select.select([term, bm], [], [], 0.02)
    if term in r:
        try: out += os.read(term, 4096)
        except OSError: break
    if bm in r: board_rx += os.read(bm, 4096)
# case A (no padding, Ctrl-C at 0.5 s): terminal shows "Connected to MicroPython at /dev/ttysNN ...", board_rx == b"\x03"
# case B (.zprofile sleeps 0.7 s):       terminal shows "^C", child killed by SIGINT (status -2), board_rx == b""
# case C (Ctrl-C at 0.05 s):             "^C" + Python traceback from runpy, board_rx == b""
```

### A.4 Mock-loading the real compiled extension (E1)

Approach (about 60 lines): `Module._load` hook returning (a) a fake `vscode` whose `window.createTerminal` records `{name, shellPath, shellArgs, cwd}` and whose terminals record `sendText`,
and whose `workspace.getConfiguration().get(key, default)` reads from a JSON settings blob; (b) a fake `node:child_process` whose `exec`/`execFile` record the command and
answer from a handler (including `execFile[util.promisify.custom]`). Then `require('<compiled>/mpremoteCommands.js').runActiveFile()` or
`require('<compiled>/extension.js').activate(fakeContext)` with a permissive proxy for the rest of the `vscode` surface. Scenarios and their printed command strings are quoted in sections 3, 5 and 7.
Note: the compiled extension's `ConnectionManager` has a `setInterval`, so the driver script must call `process.exit()`.

### A.5 Quoting check against PowerShell and POSIX shells (E5)

```
node gen_cmds.js "<stub>/python" "<stub>/py thon"       # prints shellEscape'd command lines
zsh -c "$CMD"; bash -c "$CMD"                            # -> [-m][mpremote][connect][/dev/cu.usbserial-0001][run][/Users/x/My Course/it's here.py]
pwsh -NoProfile -Command "$CMD"                          # -> ParserError: Unexpected token '-m' in expression or statement.
pwsh -NoProfile -Command "& $CMD"                        # call operator fixes the first problem only; the POSIX '\'' escape is still invalid PowerShell
```

---

## Follow-up: Session-log forensics for complaint 1b/1c

Role: follow-up investigator for the gap raised in `10-completeness-critic.md` (sections 2.1 and 9, gap 1). Question: build a timeline of the failing
2026-10-12 session from the user's own logs and file mtimes, resolve the `tree-paths.json` paradox, find out which terminal receives the
`source .venv/bin/activate` text, and re-grade 02's R1-R9 and F0-F8 plus 01's RC1.

No serial port was opened or probed (all "boards" below are private ptys; the one MicroPython executed is the class firmware's own *unix simulator* build, which
needs no hardware). Nothing was installed. Scratch files: `<scratchpad>/forensics/` (`timeline.py`, `race.py`/`race2.py`, `inject.py`, `promptdetect.py`, `mpy_repl_probe.py`).

### F.0-F.3 Sources, verdict and timeline (condensed for the public repository)

The original of this part built a minute-by-minute timeline of the instructor's session of 2026-10-12 from the local VS Code logs (`~/Library/Application Support/Code/logs/<session>/`) and from about 57 lines of the instructor's own shell history. The timeline, the shell-history quotes and the PATH listings stay on the instructor's machine (`private/pre-publication/`, not in the repository). The conclusions that the rest of this archive relies on:

1. **`mpremote` WAS on the extension host's PATH between 12:16 and 12:54**, because the instructor had linked the venv's `mpremote` into `/usr/local/bin` as a workaround ("hack #1"; hand edits of the installed extension's JavaScript at 12:33-12:37 were "hack #2"). The earlier checks that found no `mpremote` anywhere ran after the link had been removed. This also explains the `tree-paths.json` "paradox" (F.3 of the original): the file was written at 12:38:39 by a successful `mpremote ... fs tree` while the link existed.
2. **01's RC1 ("every `exec('mpremote ...')` fails") was true of the starting state and remains a real design defect, but it is NOT the cause of 1b/1c.** In every logged window with a REPL attempt (W3-W5, 12:19-12:40) bare `mpremote` resolved, and those windows contain zero extension-side exec failures. RC1 is the primary cause of complaint 1a only.
3. **The `source .venv/bin/activate` text is typed into the "ESP32 REPL" terminal itself** by the Python Environments extension (ms-python.vscode-python-envs 1.38.0), 12 of 12 times: 11 times 5.00 s after the terminal was created and once 0.69 s after creation (when the board had already printed a prompt), via `terminal.sendText`. mpremote forwards it to the board's REPL. It litters the REPL with a traceback; it does not by itself kill mpremote. [L][S][E]
4. **The "blank pairs 100 ms apart" are Ctrl-C (0x03) and Ctrl-B (0x02)** [E: `cat -v Python.log`]. They appear only because the Python extension patches `Terminal.sendText` on every terminal object in the extension host (F.5), so `Python.log` is an accidental log of all terminal input sent by any extension.
5. **Only 1 of 12 REPL launches shows evidence of a live prompt**; the other 11 show the 5.00 s timeout signature (no prompt-like output in 5 s). Every new REPL terminal also proves that the previous one no longer existed, within about 25 s in 7 of 7 same-host cases. The "REPL not reliable" complaint is real; the logs do not identify a single cause (F.6).
6. **R6 (`connect` reset to `auto` at every activation) was OBSERVED three times** (Open REPL twice, Stop once) and is the only mechanism demonstrably able to stop a Run click before a terminal exists.
7. **No "ESP32 Run File" terminal was ever created** in the session (exactly 12 terminal launches, all REPL). F0, F1, F3, F5 and F6 all need that terminal, so none was observed; 1c remains unverified (F.7).

Evidence tags below: **[L]** log line or file artifact from the instructor's machine (times PDT), **[H]** the instructor's shell history (quoted only in the private original), **[E]** executed here, **[S]** source read, **[I]** inference.

### F.4 The 12 REPL launches

`getReplTerminal` (`dist/mpremoteCommands.js:233-263`) returns the existing terminal if `vscode.window.terminals` still contains it, so **a launch = no live REPL terminal existed at that moment**. Creation time = Ctrl-C time minus 500 ms (`:263`). "Activation lag" = python-envs' `source` text after the Ctrl-C. "Launch log" = `terminal.log` "Latency measurements" line (written after `start()` returns and the window is idle) minus creation time; it is an *upper bound* on process-spawn time.

| # | Host (window) | Created | Ctrl-C -> Ctrl-B | Activation text | Activation lag after Ctrl-C | Launch-log lag | Next launch (same host) after | Command that host loaded |
|---|---|---|---|---|---|---|---|---|
| 1 | 89649 (W3) | 12:19:43.85 | 102 ms | 12:19:48.857 | 4.507 s | 1.17 s | 13.2 s | `mpremote connect <port>` (symlink in place) |
| 2 | 89649 | 12:19:57.02 | 100 ms | 12:20:02.035 | 4.514 s | 0.39 s | 2.7 s | same |
| 3 | 89649 | 12:19:59.77 | 101 ms | 12:20:04.765 | 4.500 s | 0.38 s | 6.2 s | same |
| 4 | 89649 | 12:20:05.93 | 101 ms | 12:20:10.937 | 4.504 s | 0.36 s | 25.1 s | same |
| 5 | 89649 | 12:20:31.01 | 102 ms | 12:20:36.013 | 4.505 s | 0.58 s | (folder closed 12:20:55) | same |
| 6 | 27072 (W3) | 12:28:55.64 | 101 ms | 12:29:00.652 | 4.516 s | 1.42 s | (window closed 12:30:14) | same |
| 7 | 35509 (W4) | 12:34:35.08 | 101 ms | 12:34:40.108 | 4.533 s | 2.24 s | 131.6 s | original or `/ABSOLUTE/PATH/TO/...` (edit made between 12:33:15 and 12:35:38; not knowable). **pty 20 gone by 12:34:36.12** |
| 8 | 35509 | 12:36:46.71 | 101 ms | 12:36:51.711 | 4.502 s | 0.15 s | (reload 12:36:51) | same as #7 |
| 9 | 41528 (W5) | 12:39:27.58 | 101 ms | 12:39:32.581 | 4.506 s | 1.81 s | 8.2 s | `~/src/mpy_test/.venv/bin/python -m mpremote connect <port>` |
| 10 | 41528 | 12:39:35.80 | 100 ms | 12:39:40.809 | 4.509 s | 0.27 s | 15.4 s | same |
| 11 | 41528 | 12:39:51.22 | 102 ms | 12:39:56.221 | 4.504 s | 2.72 s | 2.4 s | same |
| **12** | 41528 | 12:39:53.62 | 100 ms | **12:39:54.305** | **0.185 s** (0.69 s after creation) | 0.35 s | none (no further launch before the folder closed at 12:44:27) | same |

Counts that tie the logs together [L]: 12 Ctrl-C/Ctrl-B pairs (`Python.log`), 12 terminal launches (`terminal.log`), 12 python-envs `sendText` activations (`Python.log` + `Python Environments.log` "Terminal is activated" at the same millisecond). In W5 Pylance additionally logs `virtual workspace: vscode-terminal:/` at 12:39:28.016, 36.132, 51.606, 53.995 (0.33-0.44 s after each creation).

### F.5 Which terminal receives `source .venv/bin/activate`, and what it does

Chain (all [S] unless marked):

1. **Logging:** the Python extension's `TerminalManager` has `function c(e){if(!e.isPatched){const t=e.sendText.bind(e);e.sendText=(e,n=!0)=>(traceLog("Send text to terminal: "+e),t(e,n)),e.isPatched=!0}return e}`, applied to every terminal delivered by `window.onDidOpenTerminal` (`out/client/extension.js`, near char 150341 of the bundle). The extension host hands the *same* `Terminal` object to all extensions, so the patch logs input sent by *any* extension afterwards. A `sendText` made in the same tick as `createTerminal` (e.g. the Run-file command) happens before the open event and is **not** logged; the REPL's timer-driven calls (+0.5 s) are.
2. **Who sends:** `TerminalManagerImpl` in python-envs 1.38.0 does `onTerminalOpened(async e => { if (skipActivationOnOpen.has(e) || shouldSkipTerminalActivation(e)) return; env = getEnvironmentForTerminal(...); autoActivateOnTerminalOpen(e, env) })`.
   `shouldSkipTerminalActivation(e)` is true only for `creationOptions.hideFromUser` or `creationOptions.pty`; a `shellPath/shellArgs` terminal passes. With no `cwd` and one workspace project, the env is the workspace `.venv`. `getAutoActivationType()` defaults to `command` (the user set neither `python-envs.terminal.autoActivationType` nor `python.terminal.activateEnvironment`).
3. **Why 5.00 s:** `autoActivateOnTerminalOpen` first awaits `waitForShellIntegration(e)`: `Promise.race([timeout(5000) -> false, onDidChangeTerminalShellIntegration -> true, onDidWriteTerminalData + 50 ms debounce -> false if the output looks like a prompt])`. `terminal.integrated.shellIntegration.timeout` is unset (-1), shell integration is enabled, so the timeout is **5000 ms**. A REPL terminal never gets shell integration (custom `-lc` args; the workbench even has a telemetry id `terminal/shellIntegrationActivationFailureCustomArgs`), so the timeout is what ends the wait. Observed lags 4.500-4.533 s after Ctrl-C = 5.000-5.033 s after creation, 11 of 11. [L]
4. **How it sends:** `activateInternal(e,t) = e.shellIntegration ? activateUsingShellIntegration(...) : activateLegacy(e,t)`; `activateLegacy` is `e.sendText(" source <venv>/bin/activate")` (leading space for bash/zsh/gitbash). It runs on whatever object it holds, alive or not: `sendText` on a closed terminal is silently dropped in the main thread (`_checkDisposed` only guards an extension-initiated `dispose()`). **The log therefore does not prove the terminal was alive**: #7's pty was gone at 12:34:36.12 and the activation was still logged at 12:34:40.108.
5. **The early case (#12):** if the terminal's output ends in a prompt-looking character, the race resolves after 50 ms. I ported the predicate (`promptdetect.py`) [E]: the mpremote banner alone does **not** match; `...\r\n>>> ` (the board's reply to Ctrl-C/Ctrl-B) **does**; "command not found", "failed to access ... (it may be in use by another program)", "no such file or directory", `^C`, a KeyboardInterrupt traceback do **not**. #12's activation came 85 ms after its Ctrl-B, i.e. the board answered with a prompt. For #1-#11 nothing prompt-like was written in 5 s. This is the strongest first-hand signal in the logs and is used in F.6.
6. **What mpremote and the board do with it** [E, private pty + class firmware's unix MicroPython 1.29.0 built at `.../student_helper_code_micropython/build/unix/micropython`]: mpremote (`repl.py:do_repl_main_loop`) forwards every stdin byte to the port (the "board" pty received `\x03`, `\x02`, then ` source ~/src/mpy_test/.venv/bin/activate\r` at t = 5.006 s) and stayed alive. MicroPython answers `>>>  source ...` / `IndentationError: unexpected indent` (with the leading space; `SyntaxError: invalid syntax` without it, as in #12) and returns to a prompt. So the student sees a Python traceback in their REPL seconds after opening it. This is a visible defect, not a killer. If a program is running or `input()` is pending, those bytes would be consumed by the program (unobserved).
7. **Other terminals are not affected:** the four extra "Terminal is activated" lines without `sendText` (12:12:19, 12:18:24, 12:39:43, 12:40:19) go through the shell-integration path of pre-existing interactive terminals. They are not REPL terminals. Why they fire when they do is unknown and irrelevant here.

Consequence for the critic's F0 variant (new *Run* terminal gets `sendText("mpremote ... run")` at t = 0 and the activation at +5 s): the mechanism is plausible for a shell-integrated Run terminal in general, but no Run terminal was created in this session (F.7), so it is unobserved.

### F.6 What the logs say about "REPL did not open reliably"

Observed (all [L] unless noted):

* 12 launches in 20 minutes; five in 47 s in W3 (12:19:44-12:20:31) and four in 27 s in W5 (12:39:28-12:39:54). Same-host intervals 13.2, 2.7, 6.2, 25.1, 8.2, 15.4, 2.4 s: **no REPL terminal survived more than 25 s before the user had to click again**, except #12.
* 11/12 show the 5.00 s timeout signature (no prompt in 5 s); 1/12 shows a prompt within 0.7 s.
* #7 died within 1.05 s of creation (ptyhost). Launch-log lags (0.15-2.72 s, median 0.49 s, upper bounds on spawn time) vary a lot, including within one burst (#11 2.72 s, #12 0.35 s, 2.4 s apart).
* W5 REPLs (#9-#12) ran while no extension-side mpremote was active: the last successful tree op ended 12:38:39 (mtime), no failure was logged, no file was saved after 12:20:22, no Run terminal existed. The board itself was healthy at 12:16:35, 12:38:39 and 12:39:54 (it answered at the REPL).
* Microsoft Serial Monitor did not hold the port (no connect request in its debug log); the user's own `mpremote ... repl` of 12:30:30/40 had ended before the 12:38:39 `fs tree` (which needs the port).

Candidate causes for the 11 prompt-less launches, with what each predicts:

| Id | Candidate | Fits | Does not fit / unknown | Status |
|---|---|---|---|---|
| H1 | **Ctrl-C delivered before mpremote enters raw mode (R3, sharpened)**. The 500 ms timer starts at `createTerminal`, not at process start, and VS Code's `TerminalProcessManager.write()` awaits process-ready and flushes pre-launch input *at* process-ready (`_preLaunchInputQueue`, [S]). So the Ctrl-C reaches the process at max(500 ms, spawn-ready). My measurement [E] with the real hand-edited command (`zsh -lc`, venv python, private pty): banner at 0.18-0.34 s (40 trials; max 0.375 s with every core busy); **Ctrl-C at <= 0.20 s after spawn kills mpremote 10/10, at 0.25 s 4/10, at >= 0.30 s 0/10.** So the race is won only if the process is spawned within about 0.2 s of `createTerminal`. Observed spawn+idle lags are 0.15-2.72 s | no prompt; the terminal shows `^C`/traceback and exits non-zero (generic toast) ; the 6 launches whose launch-log lag exceeded 500 ms (#1, #5, #6, #7, #9, #11) all had no prompt; Pylance's terminal-open event comes 0.33-0.44 s after createTerminal in W5 | #12 won the race and #2-#4/#8/#10 had short lags yet no prompt (#8 has another explanation, H2); the launch-log is only an upper bound; nobody saw the terminal text | **plausible, not proven.** 02 had it "M, synthetic only"; the precondition is now shown to be common |
| H2 | **Hand-edit artifacts (new, R12)**: `/ABSOLUTE/PATH/TO/.venv/bin/python` placeholder in the file between 12:33:15 and 12:35:38; W4's host loaded the file at 12:34:05 | #7 died < 1.05 s, #8 failed although its launch lag (0.15 s) rules out the Ctrl-C race (lead >= 0.35 s) | I cannot see which text W4's host loaded | **likely for #7/#8** (medium) |
| H3 | Port held by something else (R1 family) | would give "failed to access ..." and exit 1 | W5: no extension-side holder (above), Serial Monitor refuted, user's own REPL ended; W3 #1-#4 and `screen` (11:57) unknown | **refuted for W5, unobserved for W3** |
| H4 | python-envs activation text kills the REPL | - | [E] it does not; it adds a traceback (F.5) | **refuted as a killer**, real as clutter |
| H5 | User closed the tab(s) themselves | explains short intervals | cannot be separated from H1/H2 in the logs | unobserved |
| H6 | `mpremote` not found (RC1) | - | symlink resolved it; no exec failures logged | **refuted for 12:16-12:44** |

Cheapest ways to separate H1/H2/H5: ask what the first line of the vanishing tab said (`^C`, `zsh: no such file or directory`, `failed to access`) and whether a "terminal process ... terminated with exit code" toast appeared; or reproduce in a scratch `--user-data-dir` VS Code with the old VSIX, a fake `mpremote` shim (pty, 0.25 s startup) first on PATH, python-envs installed - no board needed (critic gap 5).

### F.7 Run current file

* **Observed:** zero Run terminals. `terminal.log` has exactly 12 launches (all REPL), none before 12:19:45 (W2 had none), and `Python.log` has no `mpremote ... run` / `exec "import ..."` text. A Run terminal's first `sendText` is not logged (same tick as creation), but its launch would be.
* `runActiveFile` (`dist/mpremoteCommands.js:158-228`) fails *before* `createTerminal` (`:218`) on: no editor (`:161`, toast), `connect == "auto"` (`:167`, toast, no exception so nothing in `exthost.log`), or a hang/failure in `mp.fileExists` (`:193`, swallowed by the `catch`). `showErrorMessage` is not logged, so a refused Run is invisible in the logs by construction.
* The only refusal mechanism *observed* for sibling commands is R6 (3 times, right after each reload). The user reloaded the window four times (12:11, 12:28, 12:33, 12:37); each activation resets `connect`.
* **Correction to 02 section 2:** after the symlink, the installed build's `fileExists` runs `mpremote ... fs stat <path>` successfully (exit 0, mpremote 1.29.0's `fs stat` is a no-op [E2]), so Run would take the **`exec "import test"` branch (F1)**, not `run`. 02 predicted `run` for the installed build because it assumed bare `mpremote` was absent.
* 12:20:22 `test.py` was saved (3536 B) 8 s after `autoSyncOnSave` was enabled. `runActiveFile` begins with `document.save()`, so this could be a Run click that died before creating a terminal, or an ordinary save or auto-save with auto-upload. Not distinguishable.
* Verdict for 1c: no root cause established. Candidates in order of evidence: R6 refusal (observed pattern), pre-terminal failure (F2), then F1 if it got further. F0/F3/F5/F6 are unobserved.

### F.8 Re-grading of 02's R1-R9 and F0-F8

| Item | Grade | Evidence |
|---|---|---|
| R1 port lock race | **unobserved** (refuted for W5 #9-#12) | no extension-side mpremote in W5 around the launches (tree mtime 12:38:39, no failures logged, no saves); Serial Monitor and user REPL ruled out; W3 #1-#4 unknown |
| R2 auto-suspend kills REPL | **unobserved** | one coincidence: auto-sync enabled 12:20:14 and `test.py` saved 12:20:22 between #4 and #5, but #4 had no prompt, so it was not a healthy REPL being killed |
| R3 Ctrl-C race | **unobserved, upgraded to plausible** | Ctrl-C/Ctrl-B timers observed 12 times; survival curve [E]; mechanism sharpened (H1); outcome never seen |
| R4 Windows quoting | **not observable** here (macOS) | unchanged, [E5] only |
| R5 wrong/missing interpreter | **observed as the starting condition, then superseded** | 12:10:41 settings attempt, 12:16:03 symlink; afterwards the hand edit created new interpreter-path defects (H2, `mpy_remote` at `:50`) |
| R6 `connect` reset to auto | **OBSERVED x3** | 12:28:33.884, 12:38:06.438 (Open REPL), 12:38:12.971 (Stop); activation reset `extension.js:170` |
| R7 REPL closes on reset/unplug | **unobserved** | no sign of unplug; port present at 12:18:48, board answered 12:38:39 and 12:39:54 |
| R8 reset-on-open / strictConnect | **unobserved** | stack in `exthost.log` shows sidebar Open REPL = `extension.js:984` (runFromView) -> `:787` -> `getReplTerminal`, i.e. it bypasses `strictConnectHandshake`, as 02 section 3.1 said |
| R9 login-shell noise/latency | **refuted for this user/Mac** | `zsh -lc true` 0.06-0.10 s [E]; `.zprofile`/`.zshenv` print nothing; PATH includes `/usr/local/bin` |
| F0 mpremote not on Run terminal PATH | **refuted for the logged session** | no Run terminal; symlink resolved mpremote from 12:16:03 |
| F1 `fs stat` no-op -> import | **unobserved; now applies to the installed build too** (after 12:16:03) | F.7 |
| F2 no timeout/progress, errors swallowed before terminal | **unobserved, consistent** | zero Run terminals |
| F3 contention / queued keystrokes | **unobserved** | needs a Run terminal |
| F4 Windows quoting | **not observable** | |
| F5 Ctrl-C does not stop Run | **unobserved** | |
| F6 Run races its own save/auto-sync | **unobserved** (one ambiguous 12:20:22) | |
| F7 large files / MemoryError | **unobserved** | `test.py` is 3.5 KB |
| F8 untitled / non-Python editor | **unobserved** | |
| **R10 (new)** python-envs injects `source .../activate` into the REPL terminal | **OBSERVED 12/12** | F.4, F.5 |
| **R11 (new)** timers keyed to `createTerminal`, input flushed at process-ready | **mechanism [S][E]; occurrence unobserved** | H1 |
| **R12 (new)** hand-edit artifacts (placeholder path, `mpy_remote`) | **observed in files; effect likely for #7/#8** | diff of `.bak`, `.bak2`, current |

### F.9 What changes in earlier notes

* **01 RC1** (section 1, lines 26 and 130; "primary - this is what the user actually ran"): keep as the diagnosis of complaint 1a and as a design requirement; **downgrade** as an explanation for 1b/1c; replace "every exec fails" by "fails until mpremote is on the *extension host's* PATH, which a student fixes only with `sudo ln -s` or a global install".
  The user's order of events (settings attempt 12:10:41 -> symlink 12:16:03 -> REPL flaky from 12:19:44 -> JS edits 12:33-12:37) is the story 01 should tell.
* **02 section 2 table** (installed build row `fileExists`) and **F0**: wrong after 12:16:03 on this machine; see F.7/F.8.
* **02 R3 / summary item 4** ("on this fast Mac the race is won (mpremote is up in about 0.25 s)"): that figure is relative to *process start*; the Ctrl-C is relative to `createTerminal` and is delivered at process-ready. Survival needs spawn within about 0.2 s. E4 case A should read "Ctrl-C 0.5 s after spawn".
  My corrected-detection curve also supersedes a naive "died" count (an early run of `race.py` counted a read-EOF as "alive"; `race2.py` fixes it; E4 case C, Ctrl-C at 0.05 s, is confirmed: the process dies).
* **02 R6** ("M", ninth in the critic's reading): now the best-evidenced REPL/Stop/Run failure; 06's ranking (first) is vindicated.
* **10 section 2.1 item 2**: confirmed and completed (target terminal, sender extension, 5 s timeout, early case, patch mechanism, effect on the board). **10 section 2.1 item 3 / section 4 / section 5 contradiction 11**: resolved as in F.3 (its own "either the user launched something different ... or mpremote was on PATH by a route nobody found" - the second, via `/usr/local/bin`). **10 section 2.1 item 5** (`inheritEnv: false`): irrelevant to `zsh -lc` login terminals here.
* **06 / 04 "Q1: which build did the user run?"**: settled (installed VSIX with two hand edits), and the date of each edit is now known (F.2).

### F.10 Requirements this adds for the new extension

1. Do not host the REPL or Run output in a shell terminal. Other extensions act on any `createTerminal` terminal: python-envs auto-activates (and types into it), the Python extension logs it, Pylance indexes it. An `ExtensionTerminalOptions` (`pty`) terminal is skipped by python-envs (`shouldSkipTerminalActivation`) and takes no foreign input.
2. If a real terminal is ever used (e.g. an optional "open in system terminal" action): never send input on a timer after `createTerminal`; wait for the first output; treat activation text as input to the target program; document `python-envs.terminal.autoActivationType: off` for such terminals.
3. Never reset a user setting on activation (R6). Every command that needs a board must show its refusal in a visible, persistent place (status bar + log channel), not only a toast.
4. Ship our own **Output channel with timestamps for every board-facing action** (launch, connect, open, close, exit code, bytes of the first reply). This investigation was possible only because Microsoft extensions happened to log; the old extension logged nothing it could be audited by.
5. Add the three failure modes found here to the acceptance matrix: rapid repeated "Open REPL" clicks (13 s, 2.7 s, 6.2 s, 2.4 s intervals were real); a Python extension + Python Environments extension installed with auto-activation `command`; artificially delayed terminal/process start (0.3-3 s).
6. Any helper that needs `mpremote` must find it without the user editing `/usr/local/bin`, PATH or extension files: the 12:16 symlink and the 12:33-12:37 patches are exactly the fragile workarounds a student cannot be expected to make.

### F.11 Still unknown, and the cheapest test for each

| Unknown | Test |
|---|---|
| Exact text and exit code shown by the 11 prompt-less terminals | Ask the user; or reproduce in VS Code with `waitOnExit`-style capture using a fake-`mpremote` shim (no board) |
| Which `mpremoteCommands.js` text W4's host loaded at 12:34:05 | Only the user can say when the placeholder edit was saved; irrelevant for the rewrite |
| Whether Run was clicked and what the toast said | Ask the user; `Developer: Set Log Level... Trace` + repeat |
| Whether H1 or H5 explains W3 #1-#5 | Same shim reproduction, with CPU load during window reload |
| Whether the board (not the host) ever failed | Not suggested by any artifact; hardware checklist in section 13 stays as is |

### F.12 Reproduction notes (scratchpad `forensics/`)

* `timeline.py START END [include-regex] [exclude-regex]`: merges windows 2-5 logs, `main/terminal/ptyhost.log` and the filtered shell history by local time (the scripts and their output stayed in the session scratchpad) (the table in F.2 and the counts in F.4 come from it).
* `race.py`/`race2.py banner N`, `race2.py ctrlc T N`: spawns `zsh -lc '~/src/mpy_test/.venv/bin/python -m mpremote connect <private pty>'` under `pty.fork`; reports banner time and whether the process survives a Ctrl-C at T seconds. Results: banner 0.18-0.34 s (N = 40), 0.27-0.38 s with all cores busy (N = 25); survival: dies 10/10 for T <= 0.20, 4/10 at 0.25, 0/10 for T >= 0.30 (T = 0.0 is a harness artifact: the signal reaches the pre-exec child).
* `inject.py`: replays Ctrl-C at 0.5 s, Ctrl-B at 0.6 s and python-envs' ` source <venv>/bin/activate\r` at 5.0 s into that command; the pty "board" receives all three; mpremote stays alive.
* `promptdetect.py`: python-envs' prompt predicate on candidate outputs (banner: no; `>>> `: yes; errors: no).
* `mpy_repl_probe.py`: Ctrl-C, Ctrl-B, then the activation text into the class firmware's unix MicroPython 1.29.0 REPL: `IndentationError: unexpected indent` / `SyntaxError: invalid syntax`.
* Nothing in `mpy-workbench` or `~/.vscode/extensions` was modified; no serial device was opened; a runaway set of CPU-burner subshells created by one experiment was killed afterwards (checked with `ps`).

---

## Follow-up: Real VS Code extension-host reproduction

Role: follow-up investigator for the gap in `10-completeness-critic.md` section 3 / section 9 gap 5 ("every [E] ran against a hand-written vscode stub"). Question: run the
installed 0.3.2 build plus the user's hand edit in a **real VS Code 1.141.0 extension host**, with the Python 3.13 `.venv` and the Python / Python Environments extensions enabled, against a
fake board, and observe: (i) Open REPL right after window load, (ii) what is typed into the REPL terminal and what the board receives, (iii) first versus second Run click, (iv) terminal disposal
after Ctrl-X and `showExitAlert`, (v) the "No view is registered" toast, (vi) the raw `getConfiguration().get('mpyWorkbench.pythonPath')`, (vii) `sendText` into a `Pseudoterminal` and whether a
`Pseudoterminal` is exempt from environment-activation text. Then grade 02 R1-R6 / F0-F3 and 06 section 3 as observed versus claimed.

This section runs after "Follow-up: Session-log forensics" (F.x) and cross-references it; where this evidence contradicts F.x or the earlier body of 02, it says so in R.5.

### R.0 Method, harness, deviations

| Tag | Meaning here |
|---|---|
| **[RH]** | Observed by me in the real VS Code 1.141.0 extension host (this follow-up). Each cites the experiment name used in the scratchpad event log. |
| **[S]** | Read in installed source (`ms-python.python-2026.8.0/out/client/extension.js`, `ms-python.vscode-python-envs-1.38.0/dist/extension.js`, installed `danielbucam.mpy-workbench-0.3.2/dist/*.js`). |
| **[L]** | The user's own logs, as already tabulated in F.x. |
| **[K]/[I]** | Knowledge / inference; each says how to refute. |

**What ran.** `/Applications/Visual Studio Code.app` 1.141.0 launched with a scratch `--user-data-dir` (through a short symlink: the 103-character IPC socket limit rejects any path inside the scratchpad) and a scratch
`--extensions-dir` containing *copies* of the user's installed extensions: `danielbucam.mpy-workbench-0.3.2` (including the hand-edited `dist/mpremoteCommands.js`), `ms-python.python 2026.8.0`,
`ms-python.vscode-python-envs 1.38.0`, `ms-python.vscode-pylance 2026.4.1`, `ms-python.debugpy 2026.6.0`. The user's installed directories were not touched.

* **Hand edit.** Reproduced as found (`REPL` command `<venv>/bin/python -m mpremote connect <port>` via `zsh -lc`, line 246; `mpy_remote` variant, line 50). One deviation: the two `~/src/mpy_*/.venv/bin/python` strings were replaced by the absolute
  path of a scratch venv (Python 3.13.13, `mpremote 1.29.0`, `pyserial 3.5`: same versions as `~/src/mpy_test/.venv`), so that nothing in the user's project is executed or written.
* **Workspace and settings.** Copy of the user's project shape: `.vscode/settings.json` = `{"mpyWorkbench.pythonPath": "${workspaceFolder}/.venv/bin/python"}`, `.mpy-workbench/config.json` = `{"autoSyncOnSave": true}` (the user's
  `esp32sync.json` was not copied, so the workspace is "not initialised" and save-triggered uploads were not exercised), `.venv/` in the workspace, `boot.py`, `test.py`. User-level settings copied from the user's `settings.json`:
  `terminal.integrated.inheritEnv: false`, `commandsToSkipShell: ["language-julia.interrupt"]`, `python.languageServer: Pylance`, `python.defaultInterpreterPath: ""`, `mpyWorkbench.connect` = a port. Harness-only additions: workspace trust off,
  `terminal.integrated.gpuAcceleration: off` (DOM renderer, so xterm text can be read), telemetry/updates off, and `python.useEnvironmentsExtension` = `true` (the user's Python.log says environment discovery is "managed by the Python Environments extension") for the "Envs mode"
  runs, `false` for the "legacy mode" runs (the package default; experiment-controlled).
* **Board.** A pty-backed fake MicroPython board (`rx/fakeboard_pty.py`, derived from the 09 fake board: friendly REPL, raw REPL, raw paste, soft reset, boot.py/main.py) that logs every host-to-board byte with a timestamp. A pty is not a serial device.
  **A `socket://` board cannot back `mpremote repl`**: `main.py:630 -> repl.py:91 -> console.py:44 select.select([self.infd, pyb_serial.fd])` raises `AttributeError: 'Serial' object has no attribute 'fd'` [RH, first harness run]. Any fake board used to test a REPL through mpremote (03/05/09 used `socket://`
  for non-interactive commands) must be a pty.
* **Observation.** A throwaway driver extension (`rx.rxdriver`, loaded with `--extensionDevelopmentPath` and `--enable-proposed-api rx.rxdriver`): timestamps `onDidOpenTerminal`, `onDidCloseTerminal` (+ `exitStatus`), `onDidChangeTerminalState`,
  shell-integration events, `window.onDidWriteTerminalData` (proposed; the product allow-list names the Python extensions and a few others, so the flag was needed), and patches `terminal.sendText` on every opened terminal **exactly as the Python extension does** (the extension host hands the same `Terminal` object to every extension),
  so every extension's `sendText` after the open event is logged; a local HTTP `/eval` endpoint drives `vscode.commands.executeCommand`. Chrome DevTools Protocol (`--remote-debugging-port`) read the notification toasts and the xterm DOM text and took screenshots.
* **Safety.** VS Code ran under `sandbox-exec` with `(deny file* (regex #"^/dev/(cu|tty)[.]"))`. From inside the extension host, `fs.statSync("/dev/cu.usbserial-0001")` returned `EPERM` (stat only; nothing was opened), `/dev/ttys*` and `/dev/null` were allowed. Electron needed `--no-sandbox` for that.
  The class board's port was never opened, probed or listed by any process I started. Everything was torn down (VS Code instances, fake board, symlink); only the scratch directory `<scratchpad>/rx/` remains.
* **Caveat that matters for timing.** This Mac was shared with other analysis jobs; `uptime` showed load averages from 5 to 115 on a 16-thread machine during the session. I therefore report race outcomes as a function of load and ran one controlled load test (R.4.2).
  A second session (`VSCODE_CLI=1` so that the extension host PATH is the launch PATH, with a `mpremote` symlink first on both the host and terminal PATH) was used only for F1.

### R.1 Verdict

1. **The old REPL/Run mechanics reproduce in a real extension host without any stub**, including with the Python and Python Environments extensions active: R1, R2, R2b, R3, R6, F0 (PATH-less condition), F1 (reachable condition), F3, F5, the three activation toasts, the 39/33/10/16 command contract, and
   `getConfiguration().get()` returning `${workspaceFolder}` unexpanded. Confidence **high** for each (every item has a timestamped capture).
2. **The Ctrl-C race (R3) is real, silent and load-dependent.** The 500 ms timer is relative to `createTerminal`; the process is ready at 0.23-0.46 s (median 0.28 s, n = 38 idle runs). 43 of 43 launches survived in quiet periods; 7 of 10 with 16 CPU burners on 16 threads; **0 of 20 during bursts of machine load**
   (including the very first command after activation). A killed REPL reports `exitStatus {code: 0, reason: Process}`, so **no toast at all** (even with `showExitAlert` on). Confidence **high** for mechanism and silence, **medium** for how often it happens on the user's Mac (their logged launch-to-idle lags, 0.15-2.72 s, are far above my idle spawn lags).
3. **The activation text lands in the REPL in both Python-extension activation back-ends, but at different times.** Envs mode: ~50 ms after the first prompt-looking output (the detector's 50 ms debounce; 0.567 s after creation, 38/38) or 5.00 s after creation when no prompt appears (the user's 11/12 case). Legacy mode: 0.05 s after creation, typed ahead and delivered to the board as `source <venv>/bin/activate\n`
   *before* Ctrl-C (5/5). Either way the **board receives it** (ii). Confidence **high**.
4. **A `Pseudoterminal` is exempt from activation text only in Envs mode (`shouldSkipTerminalActivation = hideFromUser || pty`, [S]+[RH]); in legacy mode it receives `source <venv>/bin/activate\r` through `sendText` -> `handleInput` 0.10 s after creation** [RH, 1 run; mechanism [S]: the legacy `TerminalAutoActivation.activateTerminal` tests only `hideFromUser`].
   `terminal.sendText()` on a `Pseudoterminal` does reach `handleInput`, verbatim, within about 2 ms (`'world'` + `addNewLine` arrives as `"world\r"`). The 02/09 assumption that the `Pseudoterminal` surface is isolated from foreign input is **false in general**; see R.6. Confidence **high** (sendText path), **medium-high** (legacy non-exemption: one run plus source).
5. **First Run click does nothing useful whenever the venv's `mpremote` is not on the terminal's PATH** (the student condition): `zsh: command not found: mpremote`, then the venv gets activated, then the second click works. [RH] in both back-ends. Whenever `mpremote` *is* reachable (the user's logged window, F.1), the installed build takes the **`exec "import <module>"` branch** (F1): `ModuleNotFoundError`
   if the file is not on the board, the *stale board copy* if it is, and the `if __name__ == "__main__"` block never runs [RH]. The editor's buffer never runs in either condition. Confidence **high**.
6. **Complaint 1b is explained by a stack of independent defects, each reproduced:** (a) the activation reset of `connect` (R6, with a new race); (b) the ^C race (R3); (c) activation text typed into the REPL (new); (d) auto-suspend killing the REPL (R2, R2b); (e) port-held launches vanishing after 0.26 s (R1). None needs hardware to appear.

### R.2 Observed versus claimed: 02 R1-R6, F0-F3 (and neighbours)

| Item | Claimed (02 / F.x) | Observed [RH] | Verdict |
|---|---|---|---|
| **R1** (H) port held -> REPL vanishes, error lost | `mpremote: failed to access ... (it may be in use by another program)`, exit 1, terminal disposed, generic toast, stderr gone | A second process holding the pty (exclusive flock): terminal output `mpremote: failed to access /dev/ttys008 (it may be in use by another program)` at +0.442 s, `onDidCloseTerminal` at +0.701 s with `exitStatus {code: 1, reason: 2}`. The message lives **0.26 s**. Toast (default `showExitAlert`): `The terminal process "/bin/zsh '-lc', '<python> -m mpremote connect <port>'" terminated with exit code: 1.` + "Open Help" button, no stderr. With `showExitAlert: false`: no toast at all. (Launches through the real extension path were killed by Ctrl-C first under load, so this capture uses the same `shellPath/shellArgs` without the timers.) | **Confirmed** (mechanism and wording) |
| **R2** (H) auto-suspend kills REPL, restart impossible | Ctrl-X -> exit 0 -> silent disposal -> restart `sendText` hits a dead terminal | `autoSuspendLs` with a live REPL: `sendText("\x18")` at +0.001 s; `onDidCloseTerminal {code: 0, reason: 2}` at +0.367 s; **no toast**; `sendText("<python> -m mpremote connect <port>", true)` at +0.486 s lands on the disposed terminal, no terminal is created; REPL gone (`terminals` = hidden `zsh` only). The command rejects with the `ls` error (`/bin/sh: mpremote: command not found` here). | **Confirmed**, exact timings |
| **R2b** `skipIdleOnce` leak | Sidebar "Open Repl" leaves the flag armed; next op skips Ctrl-X | REPL opened through `runFromView('mpyWorkbench.openRepl')`; first `autoSuspendLs` sends **no** Ctrl-X and the REPL stays alive; the second one sends `\x18` and kills it | **Confirmed** (was [E1-C] under a stub) |
| **R3** (M) 500 ms Ctrl-C race | Lost on a slow start; "on this fast Mac the race is won"; terminal "shows `^C`, exit status SIGINT, disposed (exit != 0)" | Lost whenever the machine is contended; won when idle (R.4.2). When lost the terminal shows `^C` + a `KeyboardInterrupt` traceback *inside Python's import of mpremote* (`urllib.request`, `ctypes`, `posixpath.realpath`, ... 6 different frames seen), closes 0.3 s later with **`exitStatus {code: 0, reason: 2}`**: SIGINT-killed `zsh -lc` (python was exec'd) reports code 0, so **no "terminated with exit code" toast**. Code 1 appears only when SIGINT lands during interpreter start (`Fatal Python error: init_sys_streams`). | **Confirmed, refined**: more silent than 02 says; "disposed (exit != 0)" is wrong for the common case |
| **R4** Windows quoting | PowerShell/cmd cannot run the strings | Not testable on macOS | **Not tested** |
| **R5** wrong/missing interpreter | Bare `mpremote` in the installed build fails when not on the host PATH; hand edit fixes the REPL only | Host PATH without `mpremote`: activation toast (Spanish, from `checkMpremoteAvailability`, `dist/extension.js:23`) `mpremote no encontrado. Instálalo con: pip install mpremote`; Files view toast `ESP32 list error at /: /bin/sh: mpremote: command not found` and an empty tree; `autoSuspendLs` rejects with the same shell error. The hand-edited REPL command (venv python) does start mpremote. | **Confirmed** for a PATH-less host. Per F.1 the user's logged window had `/usr/local/bin/mpremote`; so this is the *student* condition, not the logged one |
| **R6** (M) `connect` reset to `auto` at activation | Global write at `dist/extension.js:170`; Run/REPL refuse `auto` | After a window reload the Global value of `mpyWorkbench.connect` is `auto` (`inspect().globalValue`). `executeCommand('mpyWorkbench.openRepl')` rejects with `Select a specific serial port first (not 'auto')`; through `runFromView` (what the sidebar item does, `dist/actions.js:21`) the toast is `Board command failed: Select a specific serial port first (not 'auto')`. **New race:** if the first command of the window *is* `openRepl` (it also activates the extension), `getConfiguration().get` still returns the old port for about **0.35 s** (`cfgChange` to `auto` at +0.356 s): no throw, a terminal opens on the old port. | **Confirmed**; race is new. Matches the three real refusals in F.2 |
| **F0** installed build: Run terminal lacks `mpremote` | First click types `mpremote ... run` at t=0; activation later; first click fails, second works | New "ESP32 Run File" terminal, Envs mode: command typed at +0.42 s while the user's interactive zsh was still running its rc files (`zsh -lic exit` takes 2.3-9.2 s on this Mac; first prompt at +9.0 s); activation `sendText` at +5.03 s (timeout path) queued behind it. When zsh reads its input: `zsh: command not found: mpremote`, **then** `source <venv>/bin/activate` -> `(.venv)`. Legacy mode: same order (command +0.07 s, activation +0.057 s, shell ready +1.4 s, `shellExecEnd {code: 127}` then the activation). Second click: terminal reused, `mpremote ... run test.py` works (board saw `\r\x03 \r\x01 \x04 (soft reset) \x05A\x01 <file> \x04 \r\x02`; output printed). The activation can never beat the typed-ahead command because `sendText` is called at t=0 and every activation path waits for a prompt, shell integration or 5 s. | **Confirmed** for "mpremote only in the venv". **Refuted for the logged session** (F.7: symlink on PATH, no Run terminal existed) |
| **F1** (H, HEAD; per F.7 also installed build with reachable `mpremote`) | `fs stat` no-op -> `exec "import <module>"` | Second session, `mpremote` on host and terminal PATH: Run on an editor file `lab1.py` typed `mpremote connect <port> exec "import lab1"`. Board saw `\r\x03\r\x01 \x04 \r\x02` at +0.16 s (the `fs stat` precheck: a no-op that **soft-resets**), then a second soft reset and `import lab1` at +2.16 s. Result `ModuleNotFoundError: No module named 'lab1'` (exit 1). With a stale `lab1.py` on the board: `OLD copy of lab1 on the board`; the editor's new code and its `if __name__ == "__main__":` block never ran. | **Confirmed** (F.7's correction to 02 section 2 is right) |
| **F2** no timeout/progress, 2-5 s precheck | Precheck costs seconds with no UI | PATH-less: the precheck fails instantly and the terminal appears 27 ms after the click. Reachable: terminal at +0.19 s (the fake board soft-resets instantly). A real ESP32 soft reset plus raw-REPL entry (about 0.5-1.5 s) was not measured. | **Not confirmed on a fake board**; timing depends on hardware |
| **F3** queued keystrokes, surprise second run | Second click while running types into the terminal; runs when the first ends | Second click typed the full command into the tty while mpremote ran (visible duplicated command). When the first run **ended on its own** the shell executed it: `board exec #2` at +1.72 s, a second `hello from test.py` run. When the first was stopped with **Ctrl-C the queued line was discarded** (tty input flush on INTR): no second run. | **Confirmed, refined**: surprise run only after a natural finish |
| **F5** Ctrl-C does not stop the board program | mpremote sends only `\r\x02` | `sendText("\x03")` into the Run terminal during `while True`: terminal `^C`, shell back, `shellExecEnd {code: 1}`; the board received **only `\r\x02`** (no `\x03`), the loop kept running on the fake board | **Confirmed** (was [E3] on an emulator) |
| 02 section 3.2 step 2 timers | Ctrl-C at 500 ms, Ctrl-B 100 ms later | Ctrl-C at +0.500-0.503 s, Ctrl-B at +0.599-0.614 s after `createTerminal` returned (idle runs); the user's `Python.log` pairs are 100-102 ms apart | **Confirmed** |
| 02 section 10.7 `terminal.sendText()` reaches `Pseudoterminal.handleInput` [K] | | `sendText("hello", false)` -> `handleInput("hello")`; `sendText("world", true)` -> `"world\r"`; `sendText("\x03\x04\x18", false)` -> one chunk `"\u0003\u0004\u0018"`; latency 2-3 ms; `open(dims)` ran 0.15-0.21 s after creation, with the terminal shown or not | **Confirmed** |
| 10 section 2.1 item 2: activation text typed into the REPL 4.5 s after opening | | Right target, different timing and mechanism: see (ii) in R.4.1 | **Confirmed, refined** (F.5 had the same refinement) |

### R.3 Observed versus claimed: 06 section 3

| 06 | Claimed | Observed [RH] | Verdict |
|---|---|---|---|
| 3.1 activation events | `onCommand` activates for contributed commands; `onLanguage:python` otherwise | Window loaded with no `.py` editor: `isActive` = false. The first `executeCommand('mpyWorkbench.openRepl')` activated it and returned in 130 ms. After a reload with `test.py` restored it was already active when the driver became reachable (about 6 s after the reload). | **Confirmed** |
| 3.1 command contract | 39 registered, 10 contributed-but-unregistered, 16 registered-not-contributed; `renameNode` -> not found | `vscode.commands.getCommands(true)`: **39 / 10 / 16** and `command 'mpyWorkbench.renameNode' not found`, identical lists | **Confirmed exactly** |
| 3.1 Local Files view | `createTreeView("mpyWorkbenchLocalFilesView")` (`dist/extension.js:179`) -> red toast on every activation | Toast `No view is registered with id: mpyWorkbenchLocalFilesView` (red, error) on **every** activation at which I looked (first activation, after the first reload, and in the second session: 3 of 3). It does not abort activation. Shown together with the Spanish warning toast. Screenshot of the three toasts: `<scratchpad>/rx/out/s_ib.png`. | **Confirmed** (was [VSC] source reading) |
| 3.2 reset `connect` to `auto`, Global | `extension.ts:187` | `inspect('mpyWorkbench.connect').globalValue === "auto"` after every activation (User `settings.json` rewritten) | **Confirmed** |
| 3.2 item 4 stale read, `updatePortContext` reads the old value [INF] | | `getConfiguration().get('mpyWorkbench.connect')` returns the pre-reset port for ~0.35 s after activation (the window in which a first command runs): R.2 R6 | **Confirmed**; consequence is wider than `setContext` |
| 3.2 `auto` is a hard error for Run/REPL | `Select a specific serial port first` | Verbatim, both as a rejected command and as `Board command failed: ...` toast | **Confirmed** |
| 3.2 blank Files panel when listing fails | tree returns `[]`, error toast suppressed by substring filter | Files view empty; toast shown here because the message (`/bin/sh: mpremote: command not found`) does not contain "serial port" or "auto" (screenshot `s_sidebar.png`) | **Confirmed** (the filter is not triggered by this error) |
| 3.3 item 3 `skipIdleOnce` leak | armed by `runFromView`, consumed by the next unrelated op | R2b above | **Confirmed** |
| 3.3 items 1, 2, 4-8 (mutex no-op, queue reset, `ensureIdle`, no timeouts, cancel) | | Not exercised: they need a working `mpremote` on the host PATH across concurrent operations; the session with `mpremote` reachable only ran Run clicks | **Not tested** |
| 3.4 Spanish strings, no log channel | | `mpremote no encontrado. Instálalo con: pip install mpremote` appears first-thing at activation; no OutputChannel exists for the extension (the driver's own `sendText` log and the Python extension's `Python.log` were the only audit trail) | **Confirmed** (the `[DEBUG]` console output was not collected) |
| 3.5-3.9 save handler, disposables, interpreter (HEAD), Windows, untrusted/remote | | Not exercised (workspace trust was disabled in the harness; the installed build, not HEAD, ran; no Windows) | **Not tested** |

### R.4 Experiment detail

#### R.4.1 (i)-(vii)

**(i) Open REPL right after window load.**
* Window loaded, `mpyWorkbench.connect` = a port in User settings, extension inactive. `executeCommand('mpyWorkbench.openRepl')` as the very first command: resolved in 130 ms, *no* throw, "ESP32 REPL" created at +0.049 s on the old port, Global `connect` rewritten to `auto` at **+0.356 s**. (That REPL then died of R3 at +0.855 s: it was the first command after activation.)
* After a reload (`test.py` restored, extension activated by `onLanguage:python`): the same command rejects with `Select a specific serial port first (not 'auto')`; through `runFromView` the toast is `Board command failed: Select a specific serial port first (not 'auto')`. The user's log shows the same text 28 s after activation (F.2, 12:28:33.884, 12:38:06.438).
* Verdict: the throw is deterministic once activation has completed (about 0.4 s); the only way to avoid it is the activating-command race above. Confidence **high**.

**(ii) What is typed into the REPL terminal and what the board receives.** Envs mode, idle machine, REPL alive (38/38), terminal creation = t0:

```
+0.04  zsh process          (terminal state shell = zsh)
+0.24  python process       (exec'd by zsh -lc)
+0.28  "Connected to MicroPython at <port>"  (median; 0.23-0.46)       <- mpremote about to enter raw mode
+0.50  sendText "\x03"      (old extension)          board rx: 03
+0.52  board replies "\r\n>>> "  -> python-envs' prompt detector (50 ms debounce)
+0.567 sendText "source <ws>/.venv/bin/activate" + newline  (python-envs, sent by terminal.sendText)    board rx: the text + "\r"
+0.60  sendText "\x02"      (old extension)          board rx: 02          board prints its banner
```
* **The board receives `\x03`, then `source /.../.venv/bin/activate\r`, then `\x02`** (fake board; a real MicroPython answers `NameError`/`SyntaxError`, F.5 item 6). The activation text arrives 0.563-0.580 s after creation in 38/38 runs.
* Mechanism [S] (python-envs 1.38.0, `dist/extension.js` near offset 549642 and 560500): `onTerminalOpened` -> `autoActivateOnTerminalOpen` -> `waitForShellIntegration(e)` = `Promise.race([timeout(5000), onDidChangeTerminalShellIntegration, onDidWriteTerminalData + 50 ms debounce]`; the data branch resolves as soon as
  the accumulated output ends in a prompt-looking character: `/\$\s*$/`, `/#\s*$/`, `/^>>>\s*$/`, `/[>%]\s*$/`, `/❯\s*$/` and two Windows prompt forms. MicroPython's `>>> ` matches (`[>%]\s*$`). Then `activate()` -> `activateLegacy` -> `terminal.sendText(" source <venv>/bin/activate")` (no shell integration on a `-lc` terminal).
* **No prompt-like output (a REPL that died, or one attached to a running `main.py`): the 5 s timeout fires and the text goes to a dead terminal (no effect) or into the running program's stdin.** My lost-race runs: activation `sendText` at +5.00-5.03 s on the already closed terminal (logged by the patched `sendText`, delivered nowhere).
* Legacy mode (`python.useEnvironmentsExtension: false`): the Python extension's `TerminalAutoActivation` (`out/client/extension.js` near offset 891138) sends `source <venv>/bin/activate` at **+0.046-0.069 s**, before mpremote exists. The pty queue holds it (ICRNL turns CR into LF); mpremote's raw-mode switch does **not** flush it; the board received `source <venv>/bin/activate\n`, then `\x03`, then `\x02` (5/5). So the line is executed by the REPL *before* the Ctrl-C.
* In the user's real log (F.4): 11 of 12 launches at +5.00 s (timeout), launch #12 at +0.69 s (prompt) - the two signatures above. The 5 s signature is what a dead terminal, or a live terminal with no prompt, produces; the log cannot tell which.
* [I, not tested] **Hazard.** The user's `~/src/mpy_test/test.py` is a motor demo driven by single keys without Enter (`a/z`, `s/x` motor setpoints, `o/l` gain, `t/g/f/b/v` servos, `q` quit). If a REPL terminal is attached to a board running that program, the 5 s activation text `source /Users/.../.venv/bin/activate` would be delivered as about 50 keystrokes, including `s` (motor 2 setpoint) seven times, `a`, `o`, `t`, `b`, `v`.
  Verify with a pty running the key loop; do not test on hardware without the motor-power checklist (10 section 2.3).

**(iii) First versus second Run click** (Envs mode, mpremote reachable only through the venv):

| | Click 1 (new terminal) | Click 2 (terminal reused) |
|---|---|---|
| `fileExists` | bare `mpremote` -> ENOENT, swallowed -> `false` -> the `run` branch | same |
| Terminal | created at +0.027 s; command typed at +0.42 s: `mpremote connect <port> run "<test.py>"` | `sendText` at +0.035 s |
| Shell | interactive login zsh busy until **+9.0 s** (first start 9.2 s, later 1.4-2.3 s) | already at a prompt, venv active |
| Activation | python-envs `sendText` at +5.03 s, queued behind the command | none |
| Result | at +9 s: `zsh: command not found: mpremote`, then ` source .../activate`, prompt `(.venv)` | `hello from test.py`, `tick 0..2`, soft reset + raw paste on the board |
| Board | untouched (terminal text and exit code 127 in legacy mode; Envs click 1 log lost to a board restart) | `\r\x03 \r\x01 \x04 \x05A\x01 <file> \x04 \r\x02` |

* Legacy mode, click 1: activation at +0.057 s, shell ready at +1.4 s, `shellExecEnd {code: 127}` for the run command, then the activation succeeds. Click 2 works.
* Therefore "first click does nothing visible for several seconds, then `command not found`; second click works" is the observed behaviour for a venv-only `mpremote`; the user's slow interactive shell stretches the silent part to seconds. Confidence **high**.

**(iv) Terminal disposal after Ctrl-X and `showExitAlert`.**
* Live REPL + Ctrl-X: `onDidCloseTerminal {code: 0, reason: 2}` 0.37 s after the keystroke (mpremote exits 0 on Ctrl-X; `zsh -lc` exec'd it), no toast.
* Failing launch (nonexistent port): `exitStatus {code: 1, reason: 2}`, toast `The terminal process "/bin/zsh '-lc', '<python> -m mpremote connect /dev/ttys999'" terminated with exit code: 1.` + "Open Help"; with `terminal.integrated.showExitAlert: false` nothing is shown. In that run Ctrl-C had hit during interpreter start (`Fatal Python error: init_sys_streams`), which is why the exit code was 1.
* `exitStatus.reason` values observed: 2 for process exit, 4 for `terminal.dispose()` by an extension (consistent with `TerminalExitReason` Process = 2, Extension = 4 [K]).
* Verdict: a `-lc` terminal gives the extension no failure channel: exit 0 for Ctrl-X, for "device disconnected" and for SIGINT-killed Python; exit 1 with a generic toast otherwise; stderr survives 0.26 s.

**(v) "No view is registered with id".** Observed as a red toast at every activation (R.3); it does not abort `activate()`; the Board Actions view still renders Run file / Open Repl / Stop / Soft Reset / Interrupt and Sync Utilities (`s_sidebar.png`). `mpyWorkbenchLocalFilesView` is created at `dist/extension.js:179` and not contributed in `package.json`.

**(vi) `getConfiguration().get('mpyWorkbench.pythonPath')`.** `${workspaceFolder}/.venv/bin/python` returned **verbatim** from `getConfiguration().get`, `getConfiguration('mpyWorkbench').get('pythonPath')` and `inspect()` (`workspaceValue` unchanged). Also `python.defaultInterpreterPath` is returned raw (here ""). No variable expansion by VS Code. Confidence **high** (this was [K] in 01 section 4.1).

**(vii) `sendText` into a `Pseudoterminal`; exemption from activation text.** See R.2 last-but-one row and R.1 item 4. Envs mode: two `Pseudoterminal`s (one printing `>>> `, one silent) observed for 10-13 s: no activation `sendText`, no foreign `handleInput`. Legacy mode: one `Pseudoterminal` printing `>>> `: `sendText("source <ws>/.venv/bin/activate", true)` from the Python extension at +0.101 s -> `handleInput("source <ws>/.venv/bin/activate\r")` at +0.116 s.
`shouldSkipTerminalActivation(e) = !!e.creationOptions?.hideFromUser || !!e.creationOptions?.pty` (python-envs); legacy `activateTerminal(e)` tests only `hideFromUser` [S].

#### R.4.2 The Ctrl-C race, measured

Condition (all with the real extension code path, Envs mode unless noted; "alive" = still open at +2.5 s):

| Condition | n | Alive | Notes |
|---|---|---|---|
| Quiet machine, 1 s after the last action | 8 + 20 | 28 / 28 | python at +0.24 s, "Connected" 0.23-0.46 s |
| Immediately after a settings write (`update('mpyWorkbench.connect')`) | 10 | 10 / 10 | no extra delay observed |
| Quiet, legacy activation | 5 | 5 / 5 | |
| First command after extension activation | 1 | 0 / 1 | killed in `import ctypes` (`list_ports_osx.py`) |
| Periods of heavy load from other jobs (`uptime` 7-115; not logged for the first 6) | 19 | 0 / 19 | frames: runpy, `urllib.request`, `ctypes`, `realpath`, bytecode load |
| 16 CPU burners on 16 threads | 10 | 7 / 10 | "Connected" 0.35-0.58 s |

Idle timing (n = 38): zsh at 0.039-0.096 s, python at 0.236-0.279 s, "Connected" 0.228-0.461 s (median 0.276, p90 0.354), Ctrl-C at 0.500-0.503 s: margin 39-272 ms. The F.6 H1 curve (dies for Ctrl-C <= 0.20 s after spawn, survives >= 0.30 s) fits: with the process spawned at +0.05 s the Ctrl-C lands 0.45 s after spawn, but under load spawn and import slip past the deadline.
`sandbox-exec` adds about 20 ms to an `mpremote` start (measured: 0.133 s -> 0.153 s), which biases these runs slightly towards losing.

**Reading for the user's session.** The mechanism is real and its survival margin is thin even on an idle Mac; the user's logged spawn-to-idle lags (0.15-2.72 s) show that their window was often contended, so R3/H1 remains the leading candidate for the 11 prompt-less launches (F.6), still *unproven*. H5 (user closing tabs) and H2 (hand-edit artefacts) are not addressed by this experiment.

### R.5 Contradictions and corrections

1. **02 R3 and section 3.2 step 5** say a lost race leaves a terminal that "is disposed (exit != 0)" with a "generic toast". Observed: the SIGINT death reports `exitStatus.code = 0`; **no toast**. The loss is silent. (E4 in section 1 recorded "exit status SIGINT" from a harness `pty.fork`, which does not go through node-pty's exit-code mapping.)
2. **02 R3 / summary item 4** ("on this fast Mac the race is won"): true only on an idle Mac; the margin is 39-272 ms and it is lost under contention. F.9's reading ("relative to process start") is right; add that the process start itself is 0.04-0.10 s after `createTerminal` and Python is up at 0.24 s.
3. **F.10 item 1** ("an `ExtensionTerminalOptions` (`pty`) terminal ... takes no foreign input") is **only true under python-envs activation**. Under the legacy Python-extension activation back-end a `Pseudoterminal` gets `source <venv>/bin/activate\r` 0.10 s after creation [RH]. And any extension can `sendText` into any terminal. The `Pseudoterminal` surface needs an input guard (R.6).
4. **10 section 2.1 item 2** (activation "4.5 s after the REPL opens") is right for the timeout path only. When the board shows a prompt the text arrives ~50 ms after it (0.567 s after creation in Envs mode); in legacy mode 0.05 s after creation, before mpremote starts.
5. **02 section 2 (installed-build `fileExists` row), F0**: after the user's symlink the installed build takes the F1 branch (F.7). Observed here: PATH-less -> F0, reachable -> F1; the editor buffer never runs in either case. 02's "F0 (M-H, installed build)" stays valid for students without a global `mpremote`.
6. **02 F3** ("then the queued command starts a surprise second run"): only after a natural finish; Ctrl-C flushes the queued line.
7. **F.5 item 4** says `activateLegacy` sends `" source ..."` with a leading space. In my runs the text had a leading space for the 5 s timeout path on REPL terminals (31/31) and none for the prompt-triggered path (47/47) and the legacy back-end (9/9), while the 8 probe terminals (disposed within 1.3 s) received a *space-less* text at +5.0 s. The leading space is therefore not a reliable fingerprint of the path; timing is.
8. **06 3.2 item 4** was [INF]; it is now observed, and its practical consequence is the first-command race (R.2 R6), not just a stale context key.
9. **Harness note for 03/05/09:** a `socket://` fake board cannot run `mpremote repl` (R.0); use a pty for any REPL test of the old design.

### R.6 Consequences for the REPL surface (Pseudoterminal in 02/09 versus real `shellPath` terminal in 05)

| Question | Real terminal running `mpremote repl` (05) | `Pseudoterminal` on an owned connection (02/09) |
|---|---|---|
| Foreign `sendText` | Python/Envs extensions type activation text into it in **both** back-ends (Envs: after the first prompt, or at +5 s into a running program; legacy: +0.05 s, typed ahead, reaches the board) [RH] | Envs: exempt; **legacy: delivered to `handleInput` 0.10 s after creation** [RH]; any other extension can do the same |
| Start-up race | Timers keyed to `createTerminal`, spawn plus Python import 0.24-0.46 s idle, unbounded under load; lost race is a silent exit 0 [RH] | None: no process; `open(dims)` runs 0.15-0.21 s after creation |
| Shell cost | Interactive login zsh 1.4-9.2 s on the user's Mac before the first typed-ahead command runs; `zsh -lc` 0.05-0.2 s [RH] | None (no shell; identical on macOS/Windows) |
| Failure channel | exit code 0 or 1 plus a generic toast, stderr visible 0.26 s [RH] | The extension decides: banner in the tab, status bar, log |
| Programmatic input (toolbar buttons) | `sendText` works, but also lets others in | `sendText` reaches `handleInput` in 2 ms [RH]; use the session API directly for our own buttons so that `handleInput` is treated as untrusted keystrokes |
| tty features | Real tty: mpremote `repl` works, no protocol work | No tty: the extension owns line handling (02 section 6.7, 10.7) |

Decision input: **keep the `Pseudoterminal` surface** (02/09); the evidence strengthens it on the race, shell-cost, failure-channel and Envs-activation axes, and weakens one claim (isolation). Requirements added:
1. Treat `handleInput` as untrusted: drop a chunk that looks like environment activation (`^\s*(source|\.)\s+.*[\\/](activate|activate\.csh|activate\.fish)\s*$`, `Activate.ps1`, `activate.bat`, and the PowerShell `& "..."` form) when it arrives as one multi-character chunk (real typing arrives per key; a deliberate paste is the false-positive case) and show one grey line "ignored environment-activation text from another extension". [I: the Windows forms are unverified; verify on a Windows host by creating a `Pseudoterminal` with the Python extension active.]
2. Document and, where acceptable, write to the course template: `python.terminal.activateEnvironment: false` (legacy back-end) and `python-envs.terminal.autoActivationType: off` for the workspace [K: not tested here; the setting names are from the extensions' source].
3. Never use `sendText` for the extension's own control path.
4. If any real terminal is kept (e.g. an "open in a shell" action): do not send timer-driven input; wait for first output; treat all of the above as expected foreign input.
5. Acceptance tests to add: (a) an Envs-mode and a legacy-mode run with a `Pseudoterminal` and the venv selected, asserting no activation text reaches the board; (b) a launch under CPU load; (c) a first-command-after-activation test.

### R.7 What this does not establish (and how to refute)

* **Windows and ConPTY**: nothing here; Ctrl-C delivery, exit-code mapping for killed processes (R3), `cmd.exe /d /c` and the Python-extension activation scripts differ [K]. Test: the same driver on the Windows 10 VM.
* **Real hardware**: DTR/RTS reset on open, boot time, board output at connect, soft-reset duration (F2), the activation-text hazard with the class `main.py` are not observed.
* **Frequency on the user's Mac**: R3's rate depends on their load; my idle runs never lost, my contended runs always did. Test: the same harness with their full extension set, or the shim experiment in F.6.
* **Legacy non-exemption of a `Pseudoterminal`** is one run plus source reading; **Envs-mode exemption** is two terminals plus source. Refute by creating a `Pseudoterminal` after setting `python.useEnvironmentsExtension` each way and logging `handleInput`.
* **Save-triggered auto-sync, `ensureIdle`, concurrency, cancel (06 3.3 items 1, 2, 4-8)** were not exercised.
* **Workspace trust, remote/virtual workspaces** (06 3.9): trust was disabled in the harness.
* **HEAD (`src/`) build** was not run in the real host; everything here is the installed build plus the hand edit, as the user ran it.

### R.8 Reproduction notes (scratchpad `rx/`, session-specific)

* `launch.sh`: `env -i` environment, `sandbox-exec -f serial-deny.sb`, `Code --user-data-dir /tmp/rxs/ud --extensions-dir rx/exts --extensionDevelopmentPath rx/driver --enable-proposed-api rx.rxdriver --no-sandbox --remote-debugging-port=9333 --use-mock-keychain --disable-updates rx/ws` (`/tmp/rxs` was a symlink to `rx/` for the short socket path; removed afterwards). `VSCODE_CLI=1` in the second session.
* `fakeboard_pty.py --root rx/boardroot --log out/board.jsonl`: prints `LISTENING /dev/ttysNNN`; logs `{"ts", "ev": "rx", "data"}` for every received byte.
* `driver/extension.js` (+ `helpers.js`): `/eval` endpoint on `127.0.0.1:9444`; events in `out/events.jsonl`. `bin/ev.sh`, `bin/cdp.js` (`toasts`, `term`, `shot`, `eval`), `bin/tl.py <MARK>` (merged timeline), `bin/sum.py <prefix>` (per-trial summary).
* Key captures: `out/events.final.jsonl` + `out/board.final.jsonl` (session 1), `out/events.session2.jsonl` + `out/board.session2.jsonl` (F1 session), screenshots `out/s_ib.png` (three toasts), `out/s_sidebar.png` (sidebar + Run terminal).
* Experiment labels in `events.jsonl` MARK events: `exp-i`, `nc-*`, `idle-*`, `wr-*`, `load-*`, `lgc-*`, `iv-A2`, `iv-B1/B2`, `iv-R1`, `iv-R2b`, `vii`, `legacy-vii`, `run-click-1/2`, `legacy-run-click-1`, `F3`, `F3b`, `F1-click-1/2`.
