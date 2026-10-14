# 08 - mpremote: the tool everything depends on (authoritative reference)

Scope: command grammar, exact behaviour and output contracts, programmatic (library) use, cost model, failure modes,
and how to invoke it from Node. Everything the new extension (`mpy-upgrade`) builds on top of `mpremote` should be checked against this file.
Written for the "just works on macOS and Windows for sophomore ME students" requirement.

---

## 0. Evidence legend and honest limits

| Tag | Meaning |
|---|---|
| **[S]** | I read the source (mpremote 1.20.0 ... 1.29.0 and the 1.30.0rc0.post101 pre-release, unpacked from the PyPI wheels; pyserial 3.5; the local MicroPython checkout v1.27.0-preview-88 for `pyexec.c` / `ports/esp32/main.c`). |
| **[E]** | I executed it. All executed mpremote runs were against a **protocol-level board emulator** (section 12): the real `unix` MicroPython interpreter executes the code, and a small bridge reproduces the exact `pyexec.c` / `ports/esp32/main.c` raw-REPL framing (including raw-paste, `OK`, `\x04` markers, `MPY: soft reboot`, CRLF "cooking"). The host side (mpremote, pyserial) is the real thing, over a real pty device node (`/dev/ttysNNN`), and over `socket://` for >= 1.27. |
| **[D]** | Official docs / GitHub issue pages / PyPI JSON fetched from the web (summaries, so treat issue-thread details as second hand). |
| **[I]** | Inference or estimate. Always says how to refute it. |
| **[U]** | Needs the real board / a real Windows machine. Not verified. |

Limits (stated once, applies everywhere):
* **No serial port was opened; the attached CP2102 board (`/dev/cu.usbserial-0001`) was never touched.** Only offline enumeration (`connect list`, `serial.tools.list_ports`, `ioreg -r`) was done on the host.
* The emulator **cannot** show DTR/RTS auto-reset, USB re-enumeration, flash/FAT quirks, or real baud-rate timing. Those are marked [U] or [D].
* No Windows machine was available. Windows statements are [S] (code paths) or [D] (issue tracker). The cross-platform audit is `05-cross-platform.md`; the REPL/run root causes are `02-repl-run.md`; the file layer is `03-fs-sync.md`. This file is the mpremote contract those documents lean on. Where they agree with a fact here I say so; where this file adds something they do not have, it is flagged **NEW**.
* Host used: macOS 15 (Darwin 24.6), Python 3.15.0, pyserial 3.5, platformdirs 4.13.0. mpremote 1.20.0-1.29.0 and 1.30.0rc0.post101 were installed in scratch venvs (never in `mpy-workbench`, never globally). The board's CP2102 is bound to Apple's built-in **`AppleUSBSLCOM`** DriverKit driver on this Mac (`ioreg`, read-only), not to Silicon Labs' VCP kext, and has the generic USB serial number `0001`.

---

## 1. Executive summary (the 14 facts that drive design)

1. **There is no persistent mpremote session across invocations.** Every `python -m mpremote ...` process opens the port, does its job, and closes it. `resume` is only meaningful *within* one process chain or to skip the auto soft-reset of the next process (section 5.5). [S][E]
2. **Up to and including 1.29.0 every invocation soft-resets the board** (`Ctrl-C`, `Ctrl-A`, `Ctrl-D`), re-running `boot.py` but **not** `main.py`; afterwards it leaves the board in the *friendly* REPL with nothing running. **NEW: the 1.30 pre-release (PyPI `1.30.0rc0.post101`, 2026-10-01) flips this: no soft-reset unless `auto_soft_reset = True` in the user's `config.py`; `resume` is a deprecated no-op.** State then persists between invocations (cached imports, globals, running timers). Tooling must say `soft-reset` explicitly when it wants a clean interpreter and must not rely on either default. [S][E] (sections 5.5, 9.5)
3. **Output contract (executed, identical in every version 1.20-1.30):** a MicroPython exception raised by `exec`/`eval`/`run` is printed to **stdout** (CRLF line endings, file name always `<stdin>`), stderr stays empty, exit code **1**. `mpremote:`-prefixed errors go to stderr with exit 1; argparse usage errors exit **2**; `sys.exit(n)` on the board is swallowed (exit 0). [E] (section 4.1)
4. **Unknown `fs` subcommands are silent no-ops with exit 0** (`fs stat`, `fs mv`, `fs run`, anything not in the `if/elif` chain at `commands.py:420-451`). The old extension uses all three (`mpremote.ts:1296`, `:1729`, `:1460`), which explains "Run current file did not work" and "rename does nothing" (see also 02 section 7.2 F1, 03 section 4). [S][E]
5. **There is no `mkdir -p`, no `mv`, no `stat`, no `fs exists`, no JSON output.** Parent directories must be created one level at a time by the caller; `fs cp -r` only creates the *last* destination level. [S][E]
6. **`mpremote repl` requires a real TTY on stdin** (`console.py:24` `termios.tcgetattr`; Windows uses `msvcrt`). It dies with a Python traceback under pipes. A VS Code `Pseudoterminal` cannot host it; a real `createTerminal` can. [S][E]
7. **Killing or Ctrl-C-ing an `mpremote run` does not stop the program on the board.** mpremote swallows `KeyboardInterrupt` and only writes `Ctrl-B`. Proven with a heartbeat file: the board kept writing after mpremote exited, and only the *next* invocation's `Ctrl-C` stopped it. [E] Stop must be a direct `\x03` write by a port owner, or "kill + next invocation".
8. **The default port-open path asserts DTR then RTS (pyserial `open()`, `serialposix.py:335-338`) and the OS driver may toggle the lines too.** On ESP32 dev boards with the two-transistor auto-reset circuit this can hard-reset the chip on every open and, in the wrong sequence, leave it in ROM download mode. GitHub #13504 (open) reports exactly "macOS, ESP32, `/dev/cu.usbserial-0001`, MicroPython v1.27.0: `could not enter raw repl`" - the same node name and stack as the user's board. [D][S] Whether this specific board does it is [U] (verification protocol in section 11).
9. **Port exclusivity is advisory on POSIX** (`flock`, `serialposix.py:383-388`), enforced by the OS on Windows. Every open failure - missing node, no permission, busy, not a tty - is collapsed into the same message `failed to access <dev> (it may be in use by another program)` (`transport_serial.py:92,104`; `commands.py:66-70`). The wrapper has to diagnose which one it is. [S][E]
10. **`python -m mpremote` puts the current directory first on `sys.path`.** A student file named `serial.py` (or `platformdirs.py`) in the working directory breaks mpremote at import. Use `python -I` (or `-P`/`PYTHONSAFEPATH`), a neutral `cwd`, and `-X utf8`. **NEW.** [E]
11. **stdout ordering inverts when piped without `-u`**: mpremote's own `print()` text is block-buffered but device bytes go straight to `sys.stdout.buffer`, so `fs cat -v x.py` yields `<file bytes>cat :x.py`. Always run Python with `-u`. **NEW.** [E]
12. **Encoding:** with a cp1252 stdout (Windows pipe default), `fs tree` and any non-ASCII file name raises `UnicodeEncodeError` (<= 1.28; 1.29 patches `main()` on win32 only). `python -I -X utf8` neutralises hostile environments. [E][S]
13. **mpremote CLI has two different timeout regimes**: `exec/eval/run` wait forever (`follow(timeout=None)`), while every `fs` helper goes through `transport.exec` with a 10 s *silence* timeout (`timeout waiting for first EOF reception`). A wrapper needs its own wall-clock timeout and a way to stop a hung process. [S][E]
14. **A single long-lived owner of the port beats spawning mpremote per operation** in cost (measured 25 ms/op in-session vs 170-210 ms/op per process on the emulator, before any real soft reset), in correctness (no DTR/RTS toggling, no soft reset, real Stop, REPL passthrough), and in testability. `mpremote`'s Python classes make a daemon feasible (section 6), but they self-describe as unstable, so own a thin protocol layer on pyserial and keep mpremote for `mip`/`mount`/`romfs`/fallback. [S][E][I]

Minimum version recommendation, short form: **pin and vendor 1.29.0**, accept >= 1.27.0 only when the user opts into their own install, treat >= 1.30 as "requires explicit `soft-reset`" (section 9.4). The old README's ">= 1.26" is too low (section 9.4).

---

## 2. Version landscape

PyPI upload dates [D, `pypi.org/pypi/mpremote/json`]: 1.20.0 2023-04-26, 1.21.0 2023-10-05, 1.22.0 2023-12-27, 1.23.0 2024-05-31, 1.24.0 2024-10-25, 1.24.1 2024-11-29, 1.25.0 2025-04-15, 1.26.0 2025-08-09, 1.26.1 2025-09-11, 1.27.0 2025-12-09, 1.28.0 2026-04-06, **1.29.0 2026-08-24 (latest stable)**, 1.30.0rc0.post101 (pre-release) 2026-10-01. `Requires-Python >=3.4` (metadata, not realistic: f-strings, `bytes.hex(':')`, `platformdirs>=4.3.7`; 03/05 recommend a 3.9 floor), dependencies `pyserial>=3.3`, `platformdirs>=4.3.7`.

What changed, from the unpacked wheels (`diff -r` between consecutive releases) [S]:

| Release | Relevant changes |
|---|---|
| 1.20.0 | Old architecture: `pyboard.py` + `pyboardextended.py` (`Pyboard` class). `fs`: cat, ls, cp, rm, mkdir, rmdir, touch(, df shortcut). `cp -r` only with destination exactly `:` and **local** sources, auto-creates intermediate directories. No `sha256sum`, `rm -r`, `tree`, `rtc`, `sleep`, `reset`/`bootloader` shortcuts. `fs` errors are Python tracebacks on stdout, not `mpremote: cmd: path: strerror.` |
| 1.21.0 | New `transport_serial.py`/`transport.py` split (`SerialTransport`), `rtc`, `sleep`, `reset`/`bootloader` shortcuts, `repl --escape-non-printable`, `serial_for_url` for rfc2217. |
| 1.24.0/.1 | New recursive `cp` (`do_filesystem_recursive_cp`), **`sha256sum`**, **skip-if-identical (`Up to date: <path>`) and `-f/--force`**, `touch` via `fs_touchfile`, `mpremote: cp: destination is not a directory`, `Transport.fs_*` helpers moved to the base class (and renamed `fs_rmfile`, `fs_touchfile`, `fs_hashfile`...). `fs tree <path>` parses (the `command` positional is free text) but is not implemented: silent no-op; `fs tree` with no path or with `-s` is an argparse error (executed). |
| 1.25.0 | **`rm -r`**, `romfs`, `enter_raw_repl(timeout_overall=10)` (an *overall* 10 s bound per stage instead of per-character), `SerialTransport(timeout=)`. |
| 1.26.0/.1 | **`fs tree` (+`-s/--size`, `-h/--human`)**, `mp_errno.py` (device errno -> host `OSError`), `fs --help`, the "no path" special case widened from `fs ls` alone (present since 1.20) to `ls`/`tree` plus option-only forms (`main.py:603-610`). Windows: `has_espressif_dtr_quirk()` clears DTR/RTS before open for any non-Microsoft driver; no ordering fix on close. |
| **1.27.0** | **DTR/RTS rework** (PR #18001): Windows+CP210x special open sequence, `close()` clears RTS then DTR (`transport_serial.py:122-133`), `serial_for_url(..., do_not_open=True)` for *all* device strings (so `socket://` and `rfc2217://` both work; <= 1.26 only handled rfc2217), `backslashreplace` in mount hooks. |
| 1.28.0 | Only a docstring change in `mip.py` (behaviourally identical to 1.27.0). |
| **1.29.0** | `_quote_path()` (`repr`) for every remote path (fixes `'` in file names, #18657; the `cp`/`ls` **shortcuts** no longer choke on `=` in names, #18658), Windows UTF-8 console handling (`ConsoleWindows.configure_unicode_output`, `main.py:562-567`), `romfs deploy` rework. |
| 1.30.0rc0 | **`auto_soft_reset` config option, default off; `resume` demoted to `_DEPRECATED_COMMANDS`.** `State.__init__(auto_soft_reset=False)`. |

Feature-by-version matrix, **executed** against the emulator (pty device node, every row identical across 1.24.1 ... 1.30rc unless stated) [E]:

| Probe | 1.20.0 / 1.22.0 | 1.24.1 / 1.25.0 | 1.26.1 - 1.30rc |
|---|---|---|---|
| `fs cp local :remote` second time | rewrites | `Up to date: x` | `Up to date: x` |
| `fs cp -r dir :dest` | error `'cp -r' destination must be ':'` | works | works |
| `fs cp -r dir :` | copies `dir/...` file by file | works | works |
| `fs sha256sum` | `'sha256sum' is not a filesystem command` (rc 1) | works | works |
| `fs tree`, `fs tree -s` | argparse rc 2 | argparse rc 2 (not implemented) | works |
| `fs rm -r dir` | `'-r' only supported for 'cp'` | 1.24.1 traceback / 1.25.0 works | works |
| `fs stat x`, `fs mv a b` | `'stat' is not a filesystem command` (rc 1) | **silent no-op rc 0** | **silent no-op rc 0** |
| `fs mkdir -p a/b` | argparse rc 2 | rc 2 | rc 2 |
| `fs ls nonexist` | Python traceback on stdout, rc 1 | `mpremote: ls: nonexist: No such file or directory.` rc 1 | same |
| `rtc` | not a command | works | works |
| `soft-reset` as only command | falls into REPL (traceback without tty) | works | works |
| `exec` / `run` traceback | stdout, rc 1 | same | same |

Caveat on the `1.20/1.22 fs cp down` row in the first matrix run: it failed only because my emulator initially emitted `\n` instead of the `\r\n` real ports produce; after adding the cooking it passes in every version. Real ports always cook (`mp_hal_stdout_tx_strn_cooked`), so expect CRLF in everything the device prints (section 4.2).

---

## 3. Complete command grammar (mpremote 1.29.0; deltas called out)

### 3.1 Global grammar [S: `main.py`]

* `mpremote [command [args...]]...` - commands run **sequentially in one process on one connection**. A lone `+` terminates the previous command's argument list (`main.py:578-580`, `592-601`). Without it, `argparse.REMAINDER` hands everything after a command's own args to the *next command* (`main.py:616-625`).
* **No command at all** -> `repl`. A device command without a prior `connect` -> implicit `connect auto` (`State.ensure_connected`, `main.py:544-546`). **If no command counts as an "action" the process finishes by running `repl`** (`state.run_repl_on_completion()`, `main.py:627-634`); `connect <device>` (but not `connect list`), `mount`, `umount`, `resume`, `disconnect`, `sleep` do not set `did_action`, so e.g. `mpremote connect P` alone is a REPL.
* **Shortcut expansion** (`main.py:365-426`, `487-529`): `devs` = `connect list`; `cat cp ls mkdir rm rmdir sha256sum touch tree` = `fs <same>`; `df`, `reset`, `bootloader`; `--help` = `help`; `--version` = `version`; **`a0..a3` = `connect /dev/ttyACM0..3`, `u0..u3` = `/dev/ttyUSB0..3`, `c0..c3` = `COM0..3`** (`range(4)` at `main.py:430`; the task text said 0..9, it is 0..3). User shortcuts live in `config.py` (below). Quirk: shortcut args containing `=` are parsed as `name=value` (`main.py:503-506`, `522-525`), so `mpremote cp a=b.txt :a=b.txt` failed with "Command cp given unexpected argument a" in <= 1.28 [E]; fixed in 1.29, and `fs cp` never had the problem.
* **User config**: `platformdirs.user_config_dir("mpremote", appauthor=False)/config.py` is `exec()`'d at startup (`main.py:438-462`): `~/Library/Application Support/mpremote/` (macOS), `%LOCALAPPDATA%\mpremote\` (Windows), `~/.config/mpremote/` (Linux). It can add `commands = {...}`; in 1.30 it can set `auto_soft_reset`. It is arbitrary code run on every invocation: a student's stale `config.py` can change tooling behaviour and the wrapper cannot disable it (except by relocating HOME/APPDATA) [S, low risk].
* Exit codes: `main()` returns 0 normally, 1 for `CommandError` (message `mpremote: <msg>` on **stderr**, `main.py:637-642`); argparse errors `SystemExit(2)`; `sys.exit(1)` inside `_do_execbuffer`; anything else is an uncaught Python exception (traceback on stderr, exit 1). `finally: do_disconnect(state)` always runs (`main.py:643-644`).

### 3.2 Connection commands [S: `commands.py:20-91`, `main.py:101-107`]

| Form | Behaviour |
|---|---|
| `connect list` | Prints one line per `serial.tools.list_ports.comports()` entry, **sorted**: `{device} {serial_number} {vid:04x}:{pid:04x} {manufacturer} {product}`, with `None`/`0000:0000` for missing fields (`commands.py:25-39`). Executed here: `/dev/cu.usbserial-0001 0001 10c4:ea60 Silicon Labs CP2102 USB to UART Bridge Controller`, plus three Bluetooth `cu.*` nodes with `None` fields. Fields contain spaces, so `manufacturer`/`product` cannot be separated reliably; **use pyserial directly for enumeration** (it is guaranteed present: `python -I -c "import json, serial.tools.list_ports as lp; ..."`, no port is opened). Sets `did_action` (`commands.py:38-39`: "Don't do implicit REPL command"), so a bare `mpremote connect list` / `mpremote devs` never opens a port - safe to run while a board is attached (that is how I enumerated here). |
| `connect auto` | First port in sorted order with non-None `vid` **and** `pid` whose open does not fail with a "failed to access" error (`commands.py:40-50`). `no device found` if none. **Ambiguous with two boards and picks lab neighbours' boards**; always pass an explicit port. [E] with a monkeypatched `comports()`: `mpremote: no device found`, rc 1. |
| `connect id:<serial>` | First port whose `serial_number` equals the string (`commands.py:51-59`); error `mpremote: no device with serial number X`. CP210x boards ship with the same serial `0001`, so this is useless in a classroom. |
| `connect port:<dev>` / any other string | Passed to `SerialTransport(dev, baudrate=115200)` (the baud is hard-coded; irrelevant for USB CDC). `COM3`, `/dev/cu.usbserial-0001`, `/dev/ttyUSB0`, `rfc2217://host:port`, `socket://host:port` (>= 1.27 for the latter). Windows `COM10`+ are handled by pyserial. |
| `connect` while connected | `do_connect` calls `do_disconnect` first (closes the port, re-arms the auto soft-reset), then opens the new one. |
| `disconnect` | Unmounts if mounted, leaves raw REPL (`\r\x02`), closes the port (`rts=False; dtr=False; close`), `transport=None`. A later command reconnects, **re-opening the port** (and soft-resetting in <= 1.29). |
| `resume` | Sets `_auto_soft_reset = False` for the current chain (`commands.py:530-531`). <= 1.29: documented in `help`. 1.30: deprecated no-op accepted for scripts. Because each invocation is a fresh process, `resume` only means "do not soft-reset when this process first enters the raw REPL". It does **not** keep any connection or REPL state alive between processes; the previous process closed the port and the next one re-opens it (and still sends `\r\x03` first, so a running program is interrupted anyway - `transport_serial.py:179`). [S][E] |
| `soft-reset` | `ensure_raw_repl(soft_reset=True)`; sets `did_action`. In 1.20.0 it did not set `did_action` (so it fell through to `repl`). Idiom for "exactly one reset, then run": `soft-reset run f.py` (executed on 1.29 and 1.30rc; the second command sees `in_raw_repl` and does not reset again). |
| `reset` | Shortcut for `exec --no-follow "import time, machine; time.sleep_ms(100); machine.reset()"` (`main.py:407-414`): enters raw REPL (with the auto soft-reset), then **hard-resets** the chip (`machine.reset()`), then the process exits while the board reboots. On native-USB boards the port vanishes and re-enumerates. The old extension labels this "Soft Reset" (02 section 3.4). `bootloader` is the same with `machine.bootloader()`. |
| `sleep <n>` | `time.sleep(args.ms[0])` (`main.py:49-50`): the argparse help says "milliseconds", but the float is handed straight to `time.sleep`, i.e. **seconds** (executed: `connect P sleep 1 exec pass` took 1.22 s vs 0.20 s without; the official docs also say seconds). Does not set `did_action`, so `mpremote sleep 1` *alone* would end in `connect auto` + `repl`. |
| `rtc [--set]` | Prints `machine.RTC().datetime()` or sets it from the host clock (`commands.py:539-561`). |

### 3.3 `repl` [S: `repl.py`, `console.py`, `main.py:134-152`]

`repl [--escape-non-printable|-e] [--capture FILE] [--inject-code STR] [--inject-file PATH]`.
* Calls `ensure_friendly_repl()` (connect if needed, `\r\x02` only if it was in raw REPL) - **it does not send Ctrl-C, does not soft-reset, does not print a prompt**. You see whatever the board prints; on a quiet board you see nothing until you press Enter. Banner printed by mpremote itself: `Connected to MicroPython at <dev>` / `Use Ctrl-] or Ctrl-x to exit this shell` (`repl.py:68-69`).
* Keys: `Ctrl-]` and `Ctrl-X` exit (rc 0), `Ctrl-D` goes through `write_ctrl_d` (special handling only when a local dir is mounted), `Ctrl-J` injects `--inject-code` (`\n` -> `\r\n`), `Ctrl-K` runs `--inject-file` by entering raw REPL without soft reset, then `Ctrl-B` (`repl.py:14-33`).
* Disconnect detection: `OSError` with `errno 5` or text containing `Write timeout`, `Device disconnected`, `ClearCommError failed` ends the loop and prints `device disconnected`; **anything else (macOS `ENXIO`/"Device not configured", pyserial's "device reports readiness to read...") is a Python traceback** (`repl.py:51-56`, `105-121`) (also in 02 section 6.8).
* **Requires a TTY on stdin on POSIX** (`ConsolePosix.__init__`: `termios.tcgetattr(sys.stdin.fileno())`, `console.py:14-24`). Executed under three non-tty stdins: `termios.error: (19, 'Operation not supported by device')` (`/dev/null`), `(25, 'Inappropriate ioctl for device')` (pipe), `(102, 'Operation not supported on socket')`; exit 1 after printing the two banner lines. [E] Windows uses `msvcrt.kbhit()/getch()` (`console.py:114-134`) which reads the console, not stdin, so it also cannot be driven through a pipe. `waitchar` selects on `pyb_serial.fd` (`console.py:42-44`); pyserial's `socket://` object has `fileno()` but no `fd` attribute (`urlhandler/protocol_socket.py:342`), so `repl` over `socket://` cannot work (consistent with issue #18660 [D]); the fake board for tests must therefore be driven through a pty device node when `repl` is under test.

### 3.4 `eval`, `exec`, `run` [S: `commands.py:482-515`]

* `eval EXPR` = `exec "print(EXPR)"` with follow (`do_eval`, `:503-505`). `exec [--follow|--no-follow] CODE`, `run [--follow|--no-follow] FILE.py`. `-f/--follow` is the default; `--no-follow` sends the code and returns immediately (then `Ctrl-B` at disconnect; the code keeps running and its output is lost).
* **`run` sends the file's bytes as an anonymous `<stdin>` module.** The local file name has no meaning, tracebacks say `File "<stdin>", line N, in <module>`, `__file__` is undefined, imports resolve on the *board*. `do_run` reads the file before touching the board (`could not read file 'x'`, rc 1) - but an explicit `connect` earlier in the line has already opened the port by then.
* Execution path: `ensure_raw_repl()` -> `exec_raw_no_follow` (raw-paste if the firmware supports it: `\x05A\x01`, window flow control; else legacy 256 B writes with 10 ms gaps) -> `follow(timeout=None)` which streams stdout to `stdout_write_bytes` and returns `(stdout, stderr)` where "stderr" is the text after the second `\x04` (MicroPython prints the traceback there). If that is non-empty it is **written to our stdout** and the process does `sys.exit(1)` (`commands.py:489-492`). Hence "exception => stdout + rc 1".
* `KeyboardInterrupt` in the host process -> `sys.exit(1)`; **no `\x03` is sent to the board** (`commands.py:495-496`); `finally: do_disconnect` writes `\r\x02` only.
* `exec` of code that ends the program with `sys.exit()` on the board: pyexec treats `SystemExit` as `PYEXEC_FORCED_EXIT` (`pyexec.c:145`), prints `\x04\x04` and the port soft-reboots (`ports/esp32/main.c:172-202`); mpremote sees clean end-of-output and exits 0. [E: exit status 0, no output]

### 3.5 `fs` and the shortcuts [S: `commands.py:380-455`, `main.py:185-228`]

Usage: `fs [-r] [-f] [-v|--no-verbose] [-s|-h] <command> <path>...` (1.26+: `--help` is explicit and `-h` means `--human` for `tree`).

* **Flags must come before `<command>` or right after it** - but `fs -v ls` fails (`the following arguments are required: path`) because the "ls/tree with no path" special case only looks at `command_args[0]` (`main.py:603-610`); `fs ls -v` works. [E]
* **`:` prefix**: only `cp` distinguishes local from remote (`:x` remote, `x` local). Every other subcommand treats every positional as remote and strips a leading `:` (`commands.py:403-405`). Paths without a leading `/` are relative to the device's `os.getcwd()`.
* **Verbosity**: on by default for everything except `cat` (`commands.py:387-391`). Each path prints a header line first to **stdout**: `ls :dir`, `cp src dst`, `rm :x`, `mkdir :x`, `touch :x`, `sha256sum :x`, `tree :x`. `--no-verbose` suppresses it (and is the only safe way to parse `ls`/`sha256sum`).
* **Subcommands** (anything else is a silent no-op, rc 0, in 1.24-1.30; "not a filesystem command" rc 1 in 1.20-1.23):

| Subcommand | Output / behaviour (executed unless marked [S]) |
|---|---|
| `ls [path...]` | `ls :path` header (unless `--no-verbose`) then one line per entry `"{size:12} {name}{'/' if dir}"`, in `os.ilistdir` order (**not sorted**). Size is 0 for directories and, on ports whose `ilistdir` gives 3-tuples, for files too (the unix emulator; real FAT/LFS ports give 4-tuples with sizes - upstream `test_filesystem.sh.exp` shows `30 a.py`). Error: `mpremote: ls: nonexistent: No such file or directory.` rc 1. |
| `cat path...` | Raw file text streamed to stdout via `f.read(256)` / `print(b, end='')` in **text mode**: `\n` in the file arrives as `\r\n`; not binary safe (bytes `0x04` are stripped by `stdout_write_bytes`). Use `cp` for anything else. No header. |
| `cp src... dest` | See below. |
| `rm [-r] path...` | File: `os.remove`; a directory without `-r` fails (`rm: lib: Operation not permitted.` on the unix port; EACCES-ish on real FS). `-r` (1.25+) walks depth-first and prints `removed: 'path'` / `removed directory: 'path'` only when `-v` was passed explicitly... `args.verbose` here is the tri-state default `None`, so it prints nothing by default [S: `commands.py:322,333`]. Refuses to recurse into `/remote` when a dir is mounted. |
| `mkdir path...` | `os.mkdir`; **no `-p`** (`unrecognized arguments: -p`, rc 2), `File exists.` on repeat (`mkdir: sub: File exists.`), `No such file or directory.` when the parent is missing. |
| `rmdir path...` | `os.rmdir`; errors mapped through `MP_ERRNO_TABLE`; host-specific errno values that are not in the table fall through to `mpremote: Error with transport:\n<traceback>` (e.g. unix port on macOS: `OSError: 66`). |
| `touch path...` | `open(path,'a').close()`. |
| `sha256sum path...` (any `<algo>sum` with a digit at `[-4]`) | Prints header then the lower-case hex digest on its own line; uses `hashlib` on the device and **falls back to reading the whole file** over the wire when `hashlib.sha256` is absent (`transport.py:249-264`). Cost: 2-3 execs + O(file size) device CPU; because it is a single `exec` it is subject to the 10 s silence limit (section 4.6). |
| `tree [path] [-s|-h] [-v]` | Header `tree :path`, then a line `:<abs path>` (`:/` on a real ESP32; the cwd of the unix emulator), then box-drawing lines `├── ` / `└── ` / `│   ` sorted by name, one line per entry. **Directories carry no marker**; with `-s` files show `[<size>:>9]  name`, `-h` shows `[<human>:>6]  name`, and entries with size 0 that are directories are printed bare, so "bracket => file" is the only disambiguation (`commands.py:345-377`). Names with `[`, leading spaces, or glyph characters make it ambiguous; uses UTF-8 glyphs (see encoding trap, section 4.7). `not a directory` -> `mpremote: tree: 'x' is not a directory`. Round trips: one `ilistdir` exec per directory + 3 stat execs. **Do not parse it** (03 section 6.2 designs a JSON-lines lister instead). |
| `stat`, `mv`, `run`, ... | **Silent no-op**: prints `stat :/does/not/exist.py` and exits 0, even for nonexistent paths (executed for 1.24.1-1.30rc). `mv :a` / `mv :b` header lines are printed per positional and nothing is renamed. |

**`cp` rules** [S: `commands.py:134-301`; E; upstream `test_filesystem.sh.exp` and `test_recursive_cp.sh.exp`]
* `cp A B`: last argument is the destination; `cp a b c :dir/` requires an existing directory (`mpremote: cp: destination does not exist` / `destination is not a directory`). A trailing `/` on a *remote* destination forces directory semantics. `cp local :existing_dir` copies **into** the directory.
* Local->remote: reads the file fully into memory, `fs_exists`/`fs_isdir` on the destination (4 execs), then (unless `-f`) hashes the *remote* file and prints `Up to date: <path>` instead of copying, then `fs_writefile` (`open(...,'wb')`, 256-byte `repr(bytes)` chunks, one raw-REPL transaction per chunk, `close`). **Not atomic**: an interrupted copy leaves a truncated file; no temp-file/rename. Remote->local: `fs_stat` (when a progress callback is given), `open(...,'rb')`, `r(256)` per chunk via `eval`, writes locally.
* Progress bar only when `sys.stdout.isatty()` (`commands.py:95`): **there is no progress output when piped**.
* `-r`: source trailing `/` ignored. If the destination exists, the source directory is copied **into** it under its own name; if it does not exist, the destination is created and receives the *contents* (only the last level is created: `cp -r proj/lib :a/b/lib` fails with `cp: a/b/lib: No such file or directory.` when `a/b` is missing, executed). Therefore **repeating `cp -r dir :dir` nests (`dir/dir/...`)** (executed). `cp -r dir :` copies `dir` as `:dir` on real boards (upstream test), but flattened its contents into the root on the unix emulator because `os.stat('')` raises there (issue #18662 [D]) - never rely on `:` or `""` as a destination; always give an explicit existing parent. 1.20.0-1.23: destination must be exactly `:`, sources local only, intermediate directories auto-created.
* Errors: `OSError` from the host side -> `mpremote: cp: <strerror>: <strerror>.` (for local errors the two halves duplicate, e.g. `cp: No such file or directory: No such file or directory.`); remote -> `mpremote: <cmd>: <path>: <host strerror>.`; unmapped -> `mpremote: Error with transport:\n<device traceback>`. The `errno.errorcode` name match in `_convert_filesystem_error` (`transport.py:111-129`) means the device's `ENOENT`/`EEXIST`/`EISDIR`/`ENOSPC`/`EROFS` names are what is actually matched; the host `strerror` text is **localised on Windows**, so classify on the errno names in your own helper, not on the printed prose.

### 3.6 Other commands

* `mount [-l|--unsafe-links] LOCALDIR` mounts the host directory at `/remote` on the board through a VFS hook that the host serves over the serial link; unmounted on disconnect. Implicit `repl` follows. Needs the process to stay alive; unreliable on ESP32-S3/C3/C5/C6 USB-Serial/JTAG (issues #17560, #19651) [D]. Not exercised here ([U]).
* `edit FILES...` downloads, runs `$EDITOR`, uploads. Needs a TTY-less editor to be of use in VS Code; ignore.
* `mip install [--target T] [--index I] [--no-mpy] PKG...` - the **host** downloads from `https://micropython.org/pi/v2` (or `github:`, `gitlab:`, `codeberg:` URLs) and writes via `fs_writefile`; needs host internet; default target = first `.../lib` in the board's `sys.path` (`mip.py:150-188`). Candidate for offering "install library" in the sidebar. Issue #18461: hangs during upload at random [D].
* `romfs query|build|deploy` (1.25+; deployment protocol reworked in 1.29). Not needed.
* `df` shortcut: an `exec` script printing `filesystem size used avail use% mounted on` (`main.py:382-405`) - handy for "free space" in the sidebar.
* `help`, `version` (`mpremote 1.29.0`, rc 0; pre-release prints `mpremote 1.30.0rc0.post101`; both go to stdout and call `sys.exit(0)`). `--version` is an alias.

---

## 4. Behaviour and output contracts a wrapper depends on

### 4.1 Streams and exit codes (executed table)

| Situation | stdout | stderr | rc |
|---|---|---|---|
| `exec`/`eval`/`run` OK | program output, CRLF | empty | 0 |
| program raises (NameError, ZeroDivisionError, SyntaxError, KeyboardInterrupt, ImportError) | program output + `Traceback (most recent call last):\r\n  File "<stdin>", line N, in <module>\r\nXxxError: msg\r\n` | empty | **1** |
| `sys.exit(3)` on the board | empty | empty | **0** (board soft-reboots) |
| `run nonexistent.py` | empty | `mpremote: could not read file 'nonexistent.py'` | 1 |
| `fs` OSError (ENOENT, EEXIST, ...) | header line unless `--no-verbose` | `mpremote: <cmd>: <path>: <strerror>.` | 1 |
| argparse problems (`mkdir -p`, missing args, unknown flag) | empty | `usage: ...` + `<cmd>: error: ...` | **2** |
| unknown command (`mpremote bogus`) | empty | `mpremote: 'bogus' is not a command` | 1 |
| port cannot be opened (any reason) | empty | `mpremote: failed to access <dev> (it may be in use by another program)` | 1 |
| `connect auto`, nothing suitable | empty | `mpremote: no device found` | 1 |
| `connect id:X`, no match | empty | `mpremote: no device with serial number X` | 1 |
| raw REPL cannot be entered | `b'...'` (a Python `bytes` repr of whatever the board sent) | **full Python traceback ending** `mpremote.transport.TransportError: could not enter raw repl` (it is not wrapped in `CommandError`: `ensure_raw_repl()` is called before the `try` in both `_do_execbuffer`, `commands.py:483`, and `do_filesystem`, `:381`; "Error with transport" wrapping applies only to errors raised *inside* the helper) | 1 |
| silent > 10 s inside an `fs` helper | empty | `mpremote: Error with transport:\ntimeout waiting for first EOF reception` | 1 |
| SIGINT to mpremote while following a program | whatever was streamed | empty | 1 |
| unknown `fs` subcommand | header line | empty | **0** |
| `repl` without a tty | the two banner lines | Python traceback ending `termios.error: ...` | 1 |

Stream notes: `stdout_write_bytes` (`transport.py:36-84`) removes every `\x04`, holds back incomplete UTF-8 sequences across reads, and writes through `sys.stdout.buffer` then flushes. `mpremote`'s own text goes through `print()`. The two paths are buffered differently (section 4.8).

### 4.2 Line endings and the `<stdin>` file name
* Everything originating on the board (`print`, tracebacks, `cat`) uses CRLF (the port "cooks" `\n`), also on macOS/Linux; mpremote's own `print()` lines use the host newline (`\n`, or `\r\n` on Windows text mode). **A wrapper must split on `\r?\n` and tolerate chunk boundaries inside a CRLF pair or inside a multi-byte UTF-8 sequence** (observed chunks like `b'li'`, `b'ne 0\r'`, `b'\n'`).
* Tracebacks name `<stdin>` for `run`/`exec`, and a real path (`File "main.py", line 3`) only for imported modules. To get clickable errors in VS Code the extension must map `<stdin>` back to the file it sent (or run via `import`, which has other costs; see 02 section 10.6).

### 4.3 What `connect list` and `devs` print
`{device} {serial} {vid:04x}:{pid:04x} {manufacturer} {product}` (section 3.2). Use `serial.tools.list_ports` for structured data (executed above for this machine): fields `device, name, description, hwid, vid, pid, serial_number, location, manufacturer, product, interface`. `description` for the CP2102 is doubled (`"CP2102 USB to UART Bridge Controller - CP2102 USB to UART Bridge Controller"`). macOS lists only `/dev/cu.*`, which is what you want; Windows lists `COMn`. Known VID:PIDs worth special-casing: CP2102 `10C4:EA60` (verified here), CH340 `1A86:7523`, CH9102 `1A86:55D4`, FTDI FT232 `0403:6001`, Espressif USB-Serial/JTAG `303A:1001` (appears as a constant in 1.26.1 source), MicroPython RP2 CDC `2E8A:0005` ([I], from memory).

### 4.4 `fs cp` progress and `-v` output
Only header lines (`cp A B`, plus `Up to date: path`). There is **no per-chunk or percentage output when stdout is not a tty** (`commands.py:95`). To show upload progress per file the wrapper must run one `cp` per file (and pay the process cost) or own the transfer loop (daemon).

### 4.5 Raw REPL entry, what the board sees, what it is left in
Wire trace captured from the host side for `mpremote connect <port> exec "print(1)"` (1.29.0, [E]; framing matches `pyexec.c`/`ports/esp32/main.c` [S]):

```
host -> \r\x03                      Ctrl-C (single!) : interrupt the running program
        (host drains input until quiet)
host -> \r\x01                      Ctrl-A : enter raw REPL
dev  -> raw REPL; CTRL-B to exit\r\n>
host -> \x04                        Ctrl-D : soft reset            (only if soft_reset=True, the default in <= 1.29)
dev  -> OK\r\n  MPY: soft reboot\r\n   (ESP32 prints this; boot.py runs here; main.py does NOT run)
dev  -> raw REPL; CTRL-B to exit\r\n>
host -> \x05A\x01                   raw-paste request
dev  -> R\x01 <window u16 LE=0x80> \x01     (window = MICROPY_REPL_STDIN_BUFFER_MAX/2 = 128 by default, ports may override; pyexec.c:190-191,270-275)
host -> <code bytes, honouring the window; dev sends \x01 per consumed window> \x04
dev  -> \x04                        end of upload acknowledged
dev  -> <stdout>\x04<traceback>\x04 then ">"       (pyexec.c:124,138,174 "2 EOF chars: 1 after normal output, 1 after exception output")
host -> \r\x02                      Ctrl-B at exit (disconnect): back to friendly REPL, banner printed
host closes the port (RTS=False, DTR=False)
```

* **Ctrl-C is sent once** (`b"\r\x03"`, `transport_serial.py:179`), not twice. If the program catches `KeyboardInterrupt` (bare `except:` or `except KeyboardInterrupt:` in a loop) nothing answers `Ctrl-A` and, after the 10 s `read_until` bound, mpremote raises `could not enter raw repl`. Executed: board running `main.py` with `except KeyboardInterrupt: print('ignored ^C')` -> `rc=1 after 10.58 s`, stdout `b'ignored ^C\n'`, Python traceback on stderr. A tight `while True: pass` or `time.sleep` loop is interrupted fine. [E]
* Stage bounds (>= 1.25): up to 10 s each for the first raw-REPL banner, `soft reboot`, and the second banner (`transport_serial.py:178-212`); a stuck `boot.py` (WiFi connect loop, `input()`) therefore costs 10-30 s then fails.
* `main.py` is **not** re-run after an mpremote soft reset because the REPL mode is "raw" (`ports/esp32/main.c:151` runs `main.py` only `if (pyexec_mode_kind == PYEXEC_MODE_FRIENDLY_REPL ...)`). `boot.py` always runs. A board that normally runs `main.py` at power-up is therefore **idle** after any mpremote operation (<= 1.29: also after `run`). Pressing the board's EN button or `reset` starts `main.py` again. [S][E]
* **After exit** the board sits in the friendly REPL, output buffer holds a banner, no program runs. (`exec --no-follow` leaves the code running; see 4.6.)
* Ctrl-D from the *friendly* REPL does a soft reset that **does** run `main.py` (02 section 6.11); mpremote's `soft-reset` command goes via raw REPL, so it does not.

### 4.6 Busy device, hangs and timeouts

| Where | Bound |
|---|---|
| `exec`, `eval`, `run` (`follow(timeout=None)`) | **none**: a program that never prints and never ends blocks mpremote forever; a vanished device may too (executed: after the emulator's pty master disappeared, `exec "time.sleep(4)"` hung > 25 s with no error [E]; real unplugs more often raise `OSError`, see 4.8). |
| `read_until` default | 10 s of *silence* (inter-character) in <= 1.24; 10 s per stage overall for the entry handshake in >= 1.25 |
| any `fs` helper / `Transport.exec` | 10 s of silence per `exec` (`exec_raw(timeout=10)`): a long single device-side operation without output - `sha256sum` of a multi-hundred-KB file, `fs rm -r` of a big tree in one exec, `mkdir` on a slow SD card - dies with `timeout waiting for first EOF reception`. Executed through a FIFO that blocks `open()`: rc 1 after 10.55 s, message `mpremote: Error with transport:\ntimeout waiting for first EOF reception`; the device-side call is still blocked, so the **next** command fails to enter raw REPL unless Ctrl-C interrupts it (it does). [E] |
| process | no overall timeout, no heartbeat; `-r` copies of large trees are minutes long |

Wrapper rules that follow: own wall-clock timeouts per operation class; on timeout stop the process (SIGINT, then SIGKILL; Windows: tree-kill), then **send a fresh interrupt** (a new short mpremote call or the daemon's `\x03`), because the board keeps running whatever was in flight.

### 4.7 Encoding
* All device bytes are UTF-8 (`stdout_write_bytes` validates incrementally). Host-side `print()` uses `sys.stdout.encoding`.
* With `PYTHONIOENCODING=cp1252` (what Windows pipes default to for a UTF-8-unaware locale) executed on 1.26.1, 1.28.0 and 1.29.0 (non-Windows platform so 1.29's patch did not apply): `fs tree` -> `UnicodeEncodeError: 'charmap' codec can't encode characters in position 0-2` rc 1. With `PYTHONIOENCODING=utf-8`, or `python -I -X utf8`, it works - and `-I -X utf8` still works when the environment is hostile (`PYTHONIOENCODING=cp1252` set): UTF-8 mode is a command-line option and is honoured under `-I`. [E] 1.29.0 only reconfigures `sys.stdout/stderr` when `sys.platform == "win32"` (`main.py:562-567`, `console.py:196-229`), so pin + `-X utf8` rather than trust it.

### 4.8 Buffering and ordering (NEW)
Piped stdout without `-u`: `fs cat -v main.py` printed `b'print("main")\r\ncat :main.py\n'` (device bytes first, mpremote header last); with `python -u`: `b'cat :main.py\nprint("main")\r\n'`. Use `-u` (or `PYTHONUNBUFFERED=1`; `-I` ignores env vars, so pass `-u`). Streaming itself is fine: bytes arrive as the board produces them (checked with a 4-line script sleeping 0.5 s between lines: arrival times 0.19, 0.69, 1.19, 1.69 s). [E]

---

## 5. Silent no-ops, traps and cheat sheet

### 5.1 The things the old extension asks of mpremote that mpremote does not do
| Old call | Reality (1.24-1.30, executed) | Source |
|---|---|---|
| `fs stat <path>` (`mpremote.ts:416,1023,1294,1360`) | no-op, rc 0 -> `fileExists()` always true; `getFileInfo` parses a stat line that never appears | `commands.py:420-451` |
| `fs mv a b` (`mpremote.ts:1729`) | no-op, rc 0 -> rename silently does nothing | same |
| `fs run x` (`mpremote.ts:1460`) | no-op (dead code) | same |
| `fs mkdir -p dir` (`mpremote.ts:948,1103`) | argparse error rc 2 *after* the port was opened and closed (a wasted open/close, possibly a board reset) on every single upload | `main.py:615-619`; `-p` unknown |
| error match `"no such file"` on stderr of `fs stat` | stderr is empty | n/a |
| `exec "import sys; sys.stdin.write(b'\x03\x03')"` as an "interrupt" (`mpremoteCommands.ts:407,469`) | `sys.stdin.write` does not exist on a MicroPython device; the real interrupt is the `\r\x03` that `enter_raw_repl` sends before anything else | `transport_serial.py:179` |
| `echo -e '\x03\x03' > /dev/cu.xxx` (`mpremoteCommands.ts:392,453,484`) | POSIX-only; on macOS `/bin/sh` prints `-e ` (02 section 3.4); no baud/flow setup; bypasses the lock | n/a |
| the `fs ls` fallback parser that treats `size == 0 && endsWith('/')` as a directory | fine for `ls` output format, but sizes of 0 for files on 3-tuple `ilistdir` ports | `commands.py:423-428` |

### 5.2 Filename and module hazards
* Names containing `'` break <= 1.28 (`SyntaxError`), `=` break `cp` **shortcuts** <= 1.28 [E]. Fixed in 1.29 (`_quote_path`, `transport.py:101-106`).
* **A file named like a built-in module in the board's root shadows it** (`sys.path` begins with `''`; MicroPython "weak links" `os`, `time`, `json`, `struct`, `re`, `random`, `hashlib`, ...). mpremote's own helper code does `import os` on the device, so after a student's `os.py` lands on the board **every `fs` operation fails with a `SyntaxError`/`ImportError` traceback** (issue #19475, 33 comments, closed without a fix; maintainers suggested mpremote switch to `uos`) [D]. The sync layer must refuse or warn on `os.py`, `time.py`, `json.py`, `machine.py`, `random.py`, `hashlib.py`, `binascii.py`, `struct.py`, `re.py`, `gc.py`, `io.py`, `errno.py`, `collections.py`... at the board root (or deploy them under `/lib` only where intentional).
* **A file named `serial.py` / `platformdirs.py` / `mpremote.py` in the *host* working directory breaks `python -m mpremote`** (executed: `ModuleNotFoundError: No module named 'serial.tools'; 'serial' is not a package`, plus the student's `print` output). Fixes that work: `python -I`, `python -P` (3.11+), `PYTHONSAFEPATH=1`. [E] This is plausible in a programming class ("serial.py" for a UART lab).
* MSYS2/Git-Bash path mangling of `/foo` arguments (issue #17093 open) only matters when mpremote is launched from those shells; `spawn()` with argv avoids it [D].

### 5.3 Remote path discipline
Prefer absolute remote paths starting with `/` for `ls/cat/rm/mkdir/tree/touch/sha256sum`; for `cp` use the explicit `:` prefix, forward slashes, no trailing slash unless a directory is intended; never `:` or `""` as a `cp -r` destination (see 3.5). `fs tree` and `df` print the cwd (`os.getcwd()`), which is `/` on ESP32.

### 5.4 Things `mpremote` cannot do (so the new extension must)
`mkdir -p`, `mv/rename`, `stat/exists`, `diff`, recursive listing with sizes in a machine format, atomic upload, upload progress when piped, interrupting a running program from another process, hard reset when the REPL is dead, port enumeration with structure, detection of *why* a port cannot be opened, cancellation.

### 5.5 `resume`, `disconnect`, chaining - how state really flows
* One process, several commands = one connection, one soft reset (before the first raw-REPL command): `mpremote connect P exec "a=5" + exec "print(a)"` prints 5 [E, 1.29 and 1.30rc].
* `disconnect` then another command in the same line: the port is closed and re-opened (upstream `test_resume.sh.exp`: `eval "1+2" disconnect eval "2+3"` -> `3`, `5`).
* Across processes (executed, emulator): 1.29.0: `exec "counter=41"` then `exec "print(globals().get('counter'))"` -> `GONE (soft reset happened)`; with `resume` -> `7`. 1.30.0rc: state persists without `resume` (`41`); `resume` still accepted; `soft-reset exec ...` clears state in both versions.
* Consequences for tooling: **(a)** "Run current file" implemented as `import module` (the old extension's logic, `mpremoteCommands.ts:200-207`) works exactly once per soft reset: under 1.30 the second run is a no-op (module cached) - another reason not to use it. **(b)** Cleanliness must be explicit: `soft-reset run file.py`. **(c)** Under 1.30 a program started by an earlier `run` (timers, `_thread`, IRQs) keeps running when the next command executes unless that command's entry `Ctrl-C` stops it; the `Ctrl-C` is still sent first (`transport_serial.py:179`).

---

## 6. Using mpremote's Python API from a long-lived helper (the daemon option)

### 6.1 API surface and stability [S]
`mpremote.transport_serial.SerialTransport(device, baudrate=115200, wait=0, exclusive=True[, timeout=None])`; the 1.25+ `timeout` kwarg is the only constructor change since 1.21. Stable core, 1.21.0 -> 1.30rc (signature-compared with `ast`): `enter_raw_repl(soft_reset=True[, timeout_overall=10])`, `exit_raw_repl()`, `exec_raw_no_follow(cmd)`, `follow(timeout, data_consumer=None)`, `exec_raw(cmd, timeout=10, data_consumer=None)`, `exec(cmd, data_consumer=None)`, `eval(expr, parse=True)`, `execfile`, `read_until(...)`, `close()`, `mount_local/umount_local/write_ctrl_d`; attributes `serial` (a pyserial object), `in_raw_repl`, `device_name`, `mounted`, `use_raw_paste`. The `fs_*` helpers live on `Transport` since 1.24 and are stable through 1.30rc: `fs_listdir(src="")`, `fs_stat`, `fs_exists`, `fs_isdir`, `fs_readfile(src, chunk_size=256, progress_callback=None)`, `fs_writefile(dest, data, chunk_size=256, progress_callback=None)`, `fs_mkdir`, `fs_rmdir`, `fs_rmfile`, `fs_touchfile`, `fs_hashfile(path, algo)`, `fs_printfile`. In 1.21-1.23 the same helpers were on `SerialTransport` with different names (`fs_ls`, `fs_get`, `fs_put`, `fs_rm`, ...); 1.20 has `pyboard.Pyboard` with `exec_`. The module header says: *"The API is going to change significantly"* (`transport_serial.py:29-36`). Verdict: usable pinned (vendored 1.29.0), risky unpinned. **Only `commands.py`/`main.py` behaviours are covered by the upstream test-suite (`tools/mpremote/tests`); the library classes are not a public API.**

### 6.2 What a daemon must handle (checklist)
1. **One owner of the port**; one worker that serialises all board transactions; a second thread/loop that may only *write* (`\x03`, REPL keystrokes) - pyserial permits a writer concurrent with the worker's blocking read.
2. **Mode switching**: friendly REPL (pass-through) <-> raw REPL (transactions). Entering raw REPL without soft reset: `enter_raw_repl(soft_reset=False)`; leaving: `exit_raw_repl()` -> the board re-prints the banner. Avoid ping-ponging: stay in raw REPL between back-to-back ops, return to friendly only when a REPL view needs the prompt.
3. **REPL passthrough while idle**: pump `serial.read(inWaiting())` -> UI, UI keystrokes -> `serial.write`. While a transaction runs the pump must be paused (a lock), and an incoming transaction should pause the pump rather than be rejected (prototype below does this).
4. **Reentrancy / cancellation**: `interrupt` must not queue behind the operation it is meant to stop. `\x03` once is not enough if the program catches KeyboardInterrupt in a loop (twice with a short gap is the usual practical answer); if still unresponsive after N s, offer the hardware reset.
5. **Binary safety**: base64 (or length-prefixed binary) on the JSON-lines pipe; strip the `\x04` terminators the `follow()` data consumer sees.
6. **No console**: never import `mpremote.console` features; the VS Code `Pseudoterminal` receives `\r\n`-terminated text (the board already sends CRLF; normalise lone `\n` from host-side messages), feeds keystrokes (`handleInput`) back as bytes (UTF-8 encode, including escape sequences for arrows), decodes with a streaming UTF-8 decoder. Terminal resize is irrelevant to MicroPython (no SIGWINCH concept); ignore `setDimensions`. Windows needs no `msvcrt`/`termios` at all, which removes the whole class of console problems in `console.py`.
7. **Cleanup**: on stdin EOF/SIGTERM/exception: leave raw REPL, `rts=False` **then** `dtr=False`, close (the order matters on Windows: PR #18001 [D]). On unplug: catch `OSError`/`SerialException`, emit a `disconnected` event, release the port.
8. **Reset-on-open handling**: after `connect`, wait for boot (poll for `>>> ` after `\r\x03`, up to ~5 s) instead of a blind sleep (this is what the upstream-proposed fix for #13504 does: "poll for friendly REPL prompt before entering raw mode", unmerged as of the issue page [D]).
9. **Unplug/re-enumeration watcher** with `list_ports.comports()` at 1-2 Hz while connected (cheap, no port open); native USB boards re-enumerate after `machine.reset()`.
10. **Version guard**: refuse (or degrade) when `mpremote.__version__` is not in the tested set.

### 6.3 Prototype (executed against the emulator via a real pty; ~220 lines, condensed here)

```python
#!/usr/bin/env python3
# JSON lines on stdin/stdout. Requests: {"id":N,"op":...}. Events: {"ev":"out"|"repl","b64":...}
import base64, json, queue, sys, threading, time, traceback
from mpremote.transport import TransportError, TransportExecError
from mpremote.transport_serial import SerialTransport

out_lock = threading.Lock()
def emit(o):
    with out_lock: sys.stdout.write(json.dumps(o, separators=(",", ":")) + "\n"); sys.stdout.flush()

class Daemon:
    def __init__(s): s.t=None; s.jobs=queue.Queue(); s.repl=False; s.stop_pump=threading.Event(); s.busy=threading.Lock()
    def _raw(s, soft=False):
        if not s.t.in_raw_repl: s.t.enter_raw_repl(soft_reset=soft)
    def _friendly(s):
        if s.t.in_raw_repl: s.t.exit_raw_repl()

    def op_connect(s, r):                       # opening the port is the ONLY place DTR/RTS are touched
        s.t = SerialTransport(r["port"], baudrate=115200)
        time.sleep(r.get("boot_wait", 0))      # better: poll for the prompt
        return {}
    def op_exec(s, r):
        with s.busy:
            s._raw(r.get("soft_reset", False)); s.t.exec_raw_no_follow(r["code"])
            consumer = lambda b: emit({"ev":"out","id":r["id"],"b64":base64.b64encode(b.replace(b"\x04", b"")).decode()})
            ret, err = s.t.follow(timeout=None, data_consumer=consumer)    # blocks; interrupt() unblocks via KeyboardInterrupt traceback
            s._friendly()
        return {"stderr": err.decode("utf-8", "replace"), "exit": 1 if err else 0}
    def op_interrupt(s, r): s.t.serial.write(b"\x03\x03"); return {}        # runs on the reader thread, not queued
    def op_ls(s, r):
        with s.busy: s._raw(); e = s.t.fs_listdir(r.get("path", "")); s._friendly()
        return {"entries": [{"name": x.name, "dir": bool(x.st_mode & 0x4000), "size": x.st_size} for x in e]}
    def op_get(s, r):    # binary roundtrip
        with s.busy: s._raw(); d = s.t.fs_readfile(r["path"]); s._friendly()
        return {"b64": base64.b64encode(bytes(d)).decode()}
    def op_put(s, r):
        with s.busy: s._raw(); s.t.fs_writefile(r["path"], base64.b64decode(r["b64"])); s._friendly()
        return {}
    def op_mkdirs(s, r):                         # mkdir -p, which mpremote lacks
        with s.busy:
            s._raw(); cur = "/" if r["path"].startswith("/") else ""
            for p in filter(None, r["path"].split("/")):
                cur = cur.rstrip("/") + "/" + p if cur else p
                if not s.t.fs_exists(cur): s.t.fs_mkdir(cur)
            s._friendly()
        return {}
    def op_rename(s, r):                         # mpremote has no 'fs mv'
        with s.busy: s._raw(); s.t.exec("import os; os.rename(%r, %r)" % (r["src"], r["dst"])); s._friendly()
        return {}
    def op_stat(s, r):                           # mpremote 'fs stat' is a silent no-op
        with s.busy:
            s._raw()
            try: st = s.t.fs_stat(r["path"]); res = {"exists": True, "dir": bool(st.st_mode & 0x4000), "size": st.st_size}
            except OSError: res = {"exists": False}
            s._friendly()
        return res
    def op_repl_attach(s, r):                    # friendly-REPL view; auto-paused by other jobs and resumed after
        s.repl = True; s.stop_pump.clear()
        with s.busy:
            s._friendly()
            if not r.get("auto"): s.t.serial.write(b"\r")
            while not s.stop_pump.is_set():
                n = s.t.serial.inWaiting()
                if n: emit({"ev":"repl","b64":base64.b64encode(s.t.serial.read(n)).decode()})
                time.sleep(0.01)
        return {}
    # worker(): pops jobs, calls op_*, maps TransportExecError/TransportError/OSError to {"ok":false,"kind":...}
    # run(): reads stdin; 'interrupt' and 'repl_write' handled inline; any other op while repl-attached sets
    #        stop_pump, enqueues the job, then re-enqueues {"op":"repl_attach","auto":True,"id":-1}.
```

Observed results (emulator, pty, mpremote 1.29.0 classes) [E]:
* `exec` state is kept across calls (no soft reset): `zz=5` then `print(zz)` -> `5`.
* Exception: `exit=1`, `stderr` holds the CRLF traceback; stdout events carry the `\x04` markers that the consumer must strip.
* `put` 5000 random bytes then `get`: byte-identical; `sha256` on-device equals the local digest.
* `interrupt` during `while True: sleep(0.01)` returned in 0 ms and the pending `exec` completed with `KeyboardInterrupt` traceback; the next `exec` worked immediately.
* REPL attach -> `print(1+2)` typed through `repl_write` -> `3`; `exec` issued while attached produced its output into the same event stream, then the REPL view resumed and accepted more keystrokes.
* **30 sequential `ls` calls: 25 ms/op in-session vs 171 ms/op with one `mpremote` process per call** (emulator; the real board adds a genuine soft reset and, possibly, a hardware reset to every process, none of which the daemon pays). 
* Rough edges the prototype shows and a real implementation must fix: the banner re-printed into the REPL view each time `exit_raw_repl` runs (stay in raw REPL between ops or swallow until `>>> `), no per-op timeouts, no unplug watcher, no version guard, no `boot_wait` polling.

### 6.4 The alternative: a thin protocol layer on pyserial
The raw REPL protocol is small and old (raw paste since MicroPython 1.14): ~150 lines cover prompt-sync, `Ctrl-C/A/B/D`, raw-paste with window control, `follow()`, and the framing of errors. It removes the dependency on mpremote's unstable classes, lets the extension choose DTR/RTS policy (section 7.3), per-stage timeouts, cancellation, progress, and a single `stat/listdir` JSON snippet instead of `ilistdir`+`literal_eval`. Keep mpremote (vendored, pinned) for `mip install`, `mount`, `romfs`, and as the compatibility fallback. This is consistent with 02 section 8/10 and 03 section 6 recommendations.

---

## 7. Cost model and the ESP32 reset-on-open problem

### 7.1 What one mpremote process costs
Measured here, macOS, Python 3.15, SSD, emulator for the board (so no baud limit and a ~40 ms fake soft reset) [E]:

| Step | Time |
|---|---|
| `python -I -c pass` | 46 ms |
| + `import serial.tools.list_ports` | 61 ms |
| `python -m mpremote version` (imports argparse, platformdirs, zlib, hashlib, importlib.metadata...) | **167 ms** |
| `mpremote connect <pty> exec pass` | 210 ms |
| `mpremote connect <pty> fs ls` | 208 ms |
| same with `resume` (no soft reset) | 199 ms |

On a real ESP32 add (all [I], refute by timing `mpremote connect P exec pass` 10x): Windows Python start with Defender 0.3-0.8 s; port open **plus possible auto-reset boot 1-2 s**; `Ctrl-C/Ctrl-A` handshake 50-150 ms; **soft reboot 0.1-0.5 s + `boot.py` runtime** (a `boot.py` that connects WiFi can add seconds); then the operation: `fs ls` one raw-paste round trip (~20-50 ms); `fs cp` per 256-byte chunk three turnarounds + `repr(bytes)` expansion (1.1x for text, up to 4x for binary) + on-device compile: **~35-130 ms per chunk, i.e. ~2-7 KB/s effective** (baud is 115200 = 11.5 KB/s raw). A 20 KB `.py` therefore takes 3-10 s of transfer. Native USB boards do not run at 115200 baud but pay the same per-chunk turnaround.

### 7.2 How many processes the old extension spawns (from code) [S]
* **Refresh** of the Files view: `lsTyped` -> `populateFileTreeCache` -> **1** `fs tree` process (30 s cache `TREE_CACHE_DURATION`, `mpremote.ts:257`); but every wrapped action first runs `ensureIdle()` = `mp.ls("/")` (`extension.ts:270-277`) -> another `fs tree` unless cached; empty parse -> 2 more (`fs tree`, `fs ls`); retry-on-transient-error up to 3 attempts each (`mpremote.ts:144,203-214`).
* **Upload of one file** (`uploadReplacing`, `mpremote.ts:1090-1160`): `fs mkdir -p <parent>` (**always fails with argparse rc 2**, but only after the port was opened and closed) + `fs cp -f` = **2 processes, 2 port opens, 1 soft reset**; on any "No such file" a mkdir per path level + retry.
* **Board->local sync of N files**: N x `fs cp` + 1 `fs tree -s` (`boardOperations.ts:419-440`).
* **Local->board sync of N changed files**: 2N processes.
* So 20 changed files ~= 40 process spawns, 40 port opens, 20 soft resets; at 1-3 s of fixed cost each that is **~0.7-2 minutes of pure overhead** before any byte is transferred. With reset-on-open it also reboots the board ~40 times and runs `boot.py` each time.
* The dead `monitor.ts` (spawns `miniterm` every 2 s for 400 ms with SIGKILL) is never started (`monitor.start` has no caller) but would have opened/closed the port 30x/min; `pyraw.ts` points at `scripts/thonny_list_files.py`, which does not exist (the file is `raw_list_files.py`).
* The `ConnectionManager` in `mpremote.ts:29-131` is bookkeeping only: it never keeps a connection open; "reuse" is a flag nobody reads.

### 7.3 DTR/RTS, auto-reset, native USB [S][D][U]
* **Classic ESP32 dev boards (CP2102/CH340 + two transistors)**: RTS drives EN (reset), DTR drives GPIO0 (boot mode). Both lines are active-low; "if both RTS and DTR are asserted together, this doesn't reset the chip" (esptool docs [D]). A transition through (DTR=1,RTS=0) or (0,1) during open/close pulses reset and, if GPIO0 is held low as EN is released, the ROM bootloader starts (`waiting for download`) instead of MicroPython. esptool docs: "Some OS and/or drivers may activate RTS and or DTR automatically when opening the serial port" [D].
* **pyserial POSIX `open()`**: `os.open(O_RDWR|O_NOCTTY|O_NONBLOCK)` (`serialposix.py:322`), `flock(LOCK_EX|LOCK_NB)` if `exclusive` (`:383-388`), then `_update_dtr_state()` **before** `_update_rts_state()` (`:335-338`), both defaulting to asserted (`serialutil.py:216-217`). The kernel/driver may already raise DTR/RTS at `open(2)` (HUPCL semantics), so the actual line sequence is driver specific.
* **mpremote 1.29** adds only: Windows + VID `10C4` (CP210x): `dtr=False; rts=False; open(); dtr=True; rts=True` (`transport_serial.py:71-85`); on `close()` `rts=False` then `dtr=False` (`:122-133`) to stop Windows from clearing DTR first and hard-resetting the chip at exit (#9659, fixed by PR #18001 merged 2025-09-30, in 1.27.0). **No special handling on macOS/Linux, none for CH340/FTDI.** The PR author's note: "mpremote already asserts DTR and RTS on Linux and macOS, so such boards already fail there."
* **This Mac**: CP2102 on `AppleUSBSLCOM` (Apple's DriverKit driver), node `/dev/cu.usbserial-0001`, serial `0001`. Issue **#13504** (open since 2024-01-24; reports on macOS 13/14 with mpremote 1.22/1.24.1 and, in the latest comment, MicroPython v1.27.0 on `/dev/cu.usbserial-0001`) shows `could not enter raw repl` on ESP32 while plain `mpremote` (REPL) works; maintainer theory: "on macOS it switches RTS when connecting to the converter and resets the ESP32"; workarounds: `time.sleep(2)` before the Ctrl-A write, `mpremote connect <port> + sleep 2 + ls` (the `connect` opens the port, the sleep lets the chip boot), a different USB-UART adapter. Unmerged proposal: poll for the friendly prompt before entering raw mode. [D]
* **How this produces "REPL did not open reliably"** [I, medium]: the old REPL terminal sends Ctrl-C at 500 ms and Ctrl-B at 600 ms (`mpremoteCommands.ts:261-270`). If opening the port reset the chip, the bootloader/ROM is running at 500 ms and ignores them; `main.py` then starts at ~1-1.5 s and the terminal shows program output or boot log but never a prompt. Refute/verify: the verification protocol below (a changing `time.ticks_ms()` base proves a hardware reset).
* **Native USB boards (ESP32-S3/C3/C6)**: *USB-Serial/JTAG* (VID:PID `303A:1001`) interprets DTR/RTS line-state sequences itself (reset/bootloader), can reset on port close, and re-enumerates after `machine.reset()` (esp32.com threads [D]); *TinyUSB CDC* uses DTR as "host connected": output while no host has the port open can fill buffers and **hang the board** (#18000, fixed by #17960 in 1.26.1+ firmware) [D]. macOS file-corruption and REPL-wedge bugs on S3/C6 (#17865, #17560, #18321) were firmware/TinyUSB problems fixed in 1.26.1-1.27 firmware [D]. Advice: require MicroPython firmware >= 1.27 on native-USB boards.
* **What does not help**: `stty -hupcl` is a known Linux/Arduino workaround to avoid DTR dropping on close (#9659 thread), but the kernel's `open()` behaviour on macOS differs; I could not test it without opening the port. [U]
* **What does help regardless of hardware**: (1) open the port **once** per connection (daemon) and keep it; (2) after the single open wait for a prompt before the first command; (3) expose "Hard reset" (RTS pulse, then wait) for the swallowed-Ctrl-C and download-mode cases; (4) detect that a reset happened (`time.ticks_ms()` smaller than expected / `machine.reset_cause()`), and tell the student "the board restarted when VS Code connected; that is normal for this board".

---

## 8. Failure modes students will hit and how to detect/message them

Detection must not rely on prose that Windows localises (pyserial/`WinError` text). Use: spawn error codes, regex on the **stable tokens** below, errno names, enumeration, and your own probes.

| # | Failure | Signature (executed unless marked) | Detect | Message |
|---|---|---|---|---|
| 1 | Port held by another tool (Thonny, Arduino IDE serial monitor, `screen`, another VS Code window, **our own REPL tab**, orphaned mpremote) | `mpremote: failed to access COM3 (it may be in use by another program)` rc 1 [E] (also with an advisory `flock` held by a second mpremote) | port is enumerated + we hold no lease; macOS/Linux `lsof <port>` names the holder; Windows has no cheap equivalent | "COM3 is open in another program (REPL tab? Thonny? Arduino Serial Monitor?). Close it and press Retry." Never retry blindly more than once. |
| 2 | Board not plugged in / cable is charge-only / wrong port | **same string as #1** [E: `/dev/doesnotexist`, `COM99`] | port absent from `list_ports` | "No board found on COM3. Check the USB cable (some cables are charge-only)." |
| 3 | Permission denied (Linux `dialout`) | same string [S] | `access(R_OK \| W_OK)` | (not a macOS/Windows issue) "Add yourself to the dialout group." |
| 4 | Windows driver missing (CH340/CP210x) | port never enumerates; `list_ports` has no entry; Device Manager shows an unknown device | no `COMn` for a known VID:PID, or PnP error state | link to the driver for the lab's board; show VID:PID if seen |
| 5 | macOS `tty.*` vs `cu.*` | pyserial lists `cu.*` only; both nodes work (non-blocking open) but are distinct devices for flock | canonicalise `tty.X` -> `cu.X` | n/a (normalise silently) |
| 6 | Board resets/stays in ROM bootloader on open (`rst:0x1 (POWERON_RESET)`, `boot:0x3 (DOWNLOAD_BOOT...)`, `waiting for download` in the dump) | `could not enter raw repl` after up to 10-30 s; stdout `b'...ets Jun 8 2016...waiting for download...'` [S/D, U] | search the failure dump; or no prompt after boot_wait | "Board is in bootloader mode / just reset. Press EN (RST) once, then retry." + "Hard reset" button |
| 7 | Program ignores Ctrl-C (bare `except:`, `except KeyboardInterrupt:` loop, `micropython.kbd_intr(-1)`) | `could not enter raw repl` after 10 s; stdout dump contains the program's own output (`ignored ^C`) [E] | failure + dump shows output | "Your program caught Ctrl-C. Press the board's EN button (or use Hard Reset), then fix the loop." |
| 8 | Not MicroPython (Arduino sketch, bootloader menu, blank flash) | `could not enter raw repl` and dump without `>>>`/MicroPython markers [S] | dump empty or not MicroPython | "No MicroPython REPL found. Is firmware installed?" |
| 9 | Deep sleep | CP2102 boards: port exists, board silent -> #7 signature; native USB: port disappears [I] | combos of 2/7 | "Board seems asleep; press EN." |
| 10 | Unplug/re-enumerate mid-operation | exec/run: possibly hangs forever (pty emulation) or raises `OSError: [Errno 6] Device not configured` (macOS), `ClearCommError failed`/`PermissionError(13)` (Windows), pyserial `device reports readiness to read but returned no data` [S][D, U on hardware] | `list_ports` poll while an op runs; no output for N s | "Board disconnected." Kill the process (section 9.2), release the port, offer Reconnect |
| 11 | Silent long device operation | `mpremote: Error with transport:\ntimeout waiting for first EOF reception` after 10.5 s [E] | token | "Board stopped answering (large file hash/delete?)"; the daemon avoids with chunked work |
| 12 | Filesystem full / read-only | `mpremote: cp: x: No space left on device.` / `Read-only file system.` (errno names ENOSPC/EROFS, `transport.py:111-129`) [S] | errno-name token on the device traceback | direct messages |
| 13 | Board `os.py`/`time.py`... shadow | any `fs` op: `SyntaxError`/`ImportError` traceback inside mpremote's helper (#19475) [D] | traceback text contains `import os` / our helper source | "A file called os.py on the board hides MicroPython's os. Delete it." |
| 14 | Host `serial.py` shadow | `ModuleNotFoundError: No module named 'serial.tools'` [E] | token | covered by `-I` |
| 15 | Wrong mpremote/Python | spawn `ENOENT`, `No module named mpremote`, `unrecognized arguments` (rc 2) | exit code 2 or token | "Tooling problem: Show diagnostics" |
| 16 | Encoding crash | `UnicodeEncodeError: 'charmap'` [E] | token | covered by `-X utf8` |
| 17 | Two VS Code windows / two boards | #1 signature from our own lock; `connect auto` picks the wrong board | per-port lock file in `os.tmpdir()` | name the window/board |
| 18 | Student's `main.py` floods the port with `print` | enter_raw_repl drains until quiet (`transport_serial.py:182-185`); only stops after Ctrl-C | n/a | n/a |

---

## 9. Recommendations

### 9.1 Invoking mpremote from Node (if the CLI is used at all)
```ts
// argv array, never a shell string. `python` is an absolute interpreter path validated by running it.
const argv = [python, "-I", "-X", "utf8", "-u", "-m", "mpremote", "connect", port, ...cmd];
spawn(argv[0], argv.slice(1), {
  cwd: neutralDir,                // NOT the workspace: `-I` already drops cwd from sys.path, belt and braces
  env: { ...minimalEnv },         // `-I` ignores PYTHON* vars anyway; keep PATH, SystemRoot/WINDIR/TEMP on Windows, HOME/USERPROFILE/APPDATA
  stdio: ["ignore", "pipe", "pipe"],   // `ignore` => NUL/dev/null; fine for everything except repl/mount/edit
  windowsHide: true, shell: false,
});
```
* **Flags**: `-I` (isolated: ignore `PYTHON*` env, user site, cwd on `sys.path`), `-X utf8` (UTF-8 stdio regardless of locale), `-u` (unbuffered, preserves ordering). `python -m mpremote` works in every version >= 1.20 (`__main__.py`); a vendored copy may use `-c "from mpremote.main import main; sys.exit(main())"` (05 section 4.3). All three flags were executed together on 1.26.1 under a hostile `PYTHONIOENCODING=cp1252`.
* **Why not the `mpremote(.exe)` shim**: PATH/activation dependence, `.cmd` shims cannot be spawned without a shell on current Node, and Windows venv launchers add a process hop.
* **Chaining**: use `+`-free chains for atomic sequences: `connect P soft-reset run f.py`, `connect P resume fs ls` (1.30 accepts `resume`, as a no-op), `connect P fs cp -f a :a + fs cp -f b :b` to amortise one open/reset over many files (cuts N processes to 1 and 2N opens to 1; each `cp` still does its own hash checks; **mkdirs must precede** the copies in the same chain, one `fs mkdir` per level; an existing directory is an error and **a failing step aborts the rest of the chain** (`CommandError` -> exit 1), so pre-check with your own listing and keep chains short enough that a failure's blast radius is acceptable).
* **One mutex per port in the extension host.** FIFO queue, no pre-emption except Stop. Treat `failed to access` while the queue is idle as *foreign* ownership (table row 1/2): diagnose, tell the user, do not retry in a loop.
* **Timeouts**: classify ops. Interactive fs ops 15-20 s wall clock; `ls/tree` 15 s; `sha256sum` scale with size; `run` none (user-driven Stop). On timeout: SIGINT, 2 s grace, then kill the whole process tree: `process.kill(-pid)` for a detached group on POSIX, `taskkill /PID <pid> /T /F` on Windows (a venv `python.exe` is a launcher that spawns the real interpreter [I, Python 3.7+ venvs on Windows]; killing only the child process can leave the real one holding the COM port. Verify in Task Manager.). Afterwards the board may still be running the old command: **send an interrupt** (new `soft-reset` call or daemon `\x03`) before the next operation.
* **Parsing rules**: split on `\r?\n`; treat chunk boundaries as arbitrary; decode with a streaming UTF-8 decoder; ignore header lines starting `ls :`/`cp `/`rm `... or pass `--no-verbose`; match errors on `^mpremote: ` lines and on the tokens in section 8; exit code 2 means "our command line is wrong" (contract break, show loudly); detect device exceptions by `^Traceback \(most recent call last\):` on stdout with rc 1; map `<stdin>` back to the source file.
* **Enumerate ports** with a tiny `python -I -c` that prints `json.dumps` of `serial.tools.list_ports.comports()` - not by parsing `connect list`.
* **Never** use `connect auto` in a classroom; never `fs tree` as a data source; never `fs stat/mv/run`; never `mkdir -p`; never pass `:` as a recursive destination; never `cp` into a directory that does not exist; never rely on `sys.exit` codes from the device.

### 9.2 Process control specifics
`python -m mpremote` on POSIX is a single process: SIGINT triggers the clean path (`KeyboardInterrupt` -> `sys.exit(1)` -> `finally: do_disconnect` -> `rts=False; dtr=False; close()`), SIGTERM/SIGKILL skip it (the kernel closes the fd; with HUPCL the lines drop and a reset-on-close board resets). Prefer SIGINT first. On Windows, Node's `kill()` is `TerminateProcess` (no cleanup) - hence the importance of the RTS-before-DTR close ordering being skipped there, and of preferring a daemon whose protocol has a real `stop` message.

### 9.3 Daemon vs CLI decision input (for the architecture owner)
| Criterion | CLI per operation (fixed old extension) | Long-lived owner + own protocol layer (new) |
|---|---|---|
| Port opens per refresh/sync | 1 per process; N or 2N for a sync | 1 per connection |
| Soft reset / hardware reset per op | 1 soft (<= 1.29), possibly 1 hard | none unless asked |
| Stop button | impossible without a second open; board keeps running (executed) | one byte |
| REPL while running ops | needs closing the REPL terminal | `Pseudoterminal` view, auto-paused |
| Upload progress / cancel | none when piped | per chunk |
| Windows console/quoting/encoding traps | all of sections 4.7, 5.2, 9.1 apply | gone (no shell, no console, UTF-8 by construction) |
| Dependence on unstable mpremote internals | CLI contract only (still has silent-no-op traps) | own ~150-line protocol layer on pyserial; mpremote vendored only for `mip/mount/romfs` |
| Testability without hardware | fake board over `socket://` works for >= 1.27 | same fake board speaks the same protocol |
| Risk | slow, flaky on reset-on-open boards | more code to own; must handle unplug/resize/threads |
Recommendation: **own the port in a long-lived helper**; keep a thin mpremote CLI adapter for the commands mpremote does well (`mip`, `mount`, `romfs`, device `df`) and as a fallback when the helper cannot start. (Matches 02 section 10.)

### 9.4 Minimum version
* **Floor: 1.27.0** (DTR/RTS close ordering + Windows CP210x open sequence + `serial_for_url` for all URLs, so a `socket://` fake board works). **Recommended and pinned: 1.29.0** (adds `_quote_path`, Windows UTF-8 console handling, correct `=` handling in shortcuts, `romfs` rework). The old README's "mpremote >= 1.26" is too low: 1.26.x predates the Windows hard-reset-on-exit fix and has no `socket://`. 1.24.x silently ignores `fs tree`; <= 1.23 lacks `sha256sum`/`rm -r`/`tree`/`Up to date`.
* **Ceiling**: validated through 1.29.0; run `1.30.x` only behind a capability probe because of `auto_soft_reset`; always issue `soft-reset` explicitly where a clean interpreter matters.
* **Python**: mpremote declares >= 3.4 but needs f-strings and `platformdirs`; follow 05's practical floor (3.9). 3.15 worked here with 1.20-1.30rc.
* **Delivery**: vendor `mpremote`, `pyserial`, `platformdirs` (pure Python, ~1 MB, with `*.dist-info` so `importlib.metadata` works) and run them hermetically (05 section 4.3). Avoids "I created a `.venv` and the extension did not find it" entirely; keep "use my environment" as an advanced setting that validates the version by running `-m mpremote version`.

### 9.5 Behavioural defaults to adopt (independent of CLI vs daemon)
* Treat the board as **idle after tooling operations unless the user starts the program**; do not promise `main.py` autorun after a sync. Offer "Reset board" (hard reset) to start `main.py`.
* Run = send the editor buffer (not the board's copy) as `<stdin>`; wrap with `soft-reset` for a clean interpreter or document that state is kept; set `__name__ == "__main__"`; map `<stdin>` in tracebacks.
* Stop = `\x03` (twice), wait for the prompt, escalate to hard reset after ~3 s.
* Reject/warn on board-root names that shadow built-ins; create parent directories level by level; no `-r` for repeated syncs.

---

## 10. Mapping to the user's two complaints (mpremote-side contribution only)

| Complaint | mpremote-side facts that matter | Confidence |
|---|---|---|
| 1a ".venv with mpremote was not found" | Not an mpremote property; `python -m mpremote` from the venv interpreter is the robust call (`python -I -X utf8 -u -m mpremote`), no PATH/activation needed. `mpremote.exe` lives in `.venv/Scripts` (Windows) or `.venv/bin`; its absence from PATH is normal. See 01/05. | H |
| 1b "REPL not opening reliably" | (i) mpremote's `repl` needs a real TTY and prints nothing until the board speaks - quiet boards look dead [S][E]; (ii) opening the port can reset the ESP32 and the old code's 500 ms/600 ms keystrokes land in the bootloader [I]; (iii) `failed to access` when any other mpremote process holds the port (flock) [E]; (iv) wrong-quoting in Windows shells (02/05). Same node name and stack as upstream #13504 [D]. | M-H |
| 1c "Run current file did not seem to work" | `fs stat` is a no-op so `fileExists()` is always true and Run takes the `import <module>` branch [E]; `import` hides `__main__` code, shows ImportError for non-uploaded files, runs only once per soft reset under 1.30 [S][E]; Ctrl-C in the terminal does not stop the board's program [E]; `mpremote` is not on PATH in that terminal (02 F0). | H |
| 2 "Linter does not know my firmware's custom libraries" | Out of scope here (07). mpremote-side note: custom frozen modules are discoverable *from the device* (`sys.modules`/`help('modules')` via `exec`) and `mpremote mip` installs into `/lib`, but Pylance needs `.pyi` stubs/extraPaths built host-side from the firmware's `modules/` or manifest. | n/a |

---

## 11. Open questions and the hardware verification protocol (nothing here was run on the real board)

To be executed by a human, one command at a time, **never in parallel with other tools, with the board's USB cable plugged in and no other program holding the port**:

1. *Does opening the port reset the board on this Mac?* `python -I -c "import serial,time; s=serial.Serial('/dev/cu.usbserial-0001',115200); time.sleep(0.2); s.close()"` repeated 10x with, between runs, a quick `mpremote ... exec "import time; print(time.ticks_ms())"` using `resume` (1.29) or no flags (1.30rc). If `ticks_ms()` drops back near 0-1500 after each open, the chip is hardware-reset by the open. (`machine.reset_cause()` prints `PWRON_RESET`/`HARD_RESET` vs `SOFT_RESET`.)
2. *Does the reset happen on close, too?* Compare `ticks_ms()` before close and after the next open with a 5 s gap.
3. *Which line sequence does the Apple driver produce?* Observe DTR/RTS with a USB serial line-state probe or a scope on EN/IO0; or simply compare opening with `dtr=False`/`rts=False` pre-set in pyserial (`s=serial.Serial(); s.port=...; s.dtr=False; s.rts=False; s.open()`) vs default.
4. *Does `stty -f /dev/cu.usbserial-0001 -hupcl` change (1)?*
5. *How long from open to `>>> ` on the real board* (boot time with the student's `boot.py`)? Poll `\r\x03` until `>>> `.
6. *Real per-chunk cost* of `fs cp` for a 5 KB and a 50 KB file (to replace the estimates in 7.1).
7. *Unplug behaviour* during `run` on macOS and Windows: which exception, how long until it surfaces, does `follow()` hang?
8. *Windows only*: venv `python.exe` launcher process tree and `taskkill /T` behaviour; Defender start-up penalty; CH340 vs CP210x open/close resets; COM port numbers > 9; `py -3` vs Store alias.
9. *Confirm on hardware that `main.py` does not run after an mpremote soft reset and does run after `reset`.* (Source says so; [S] `ports/esp32/main.c:151`.)
10. Is the 1.30 `auto_soft_reset` change going to ship as described? Re-check `pypi.org/project/mpremote` at implementation time.

Other open items: mpremote's behaviour on Python 3.9 (floor) with 1.29 - not executed here; `mount` and `romfs` untested; `edit` untested; ESP32-S3/C3/C6 behaviours are all [D].

---

## 12. Appendix A - the emulator (how the [E] evidence was produced)

Files lived under the session scratchpad (`.../scratchpad/fakeboard/{bridge2.py,agent.py,exp.py,matrix.py,restart.sh}`, `.../daemon/{daemon_proto.py,client_test.py}`, `.../venvs/<version>/`, `.../src/<version>/mpremote/`); they will not outlive the session. Re-creating them takes an afternoon; 05 Appendix A.5 and 03 Appendix A contain independent fake-board rigs built on the same idea and should be preferred for the repo.

Design (for anyone reproducing):
* Back end: `ports/unix` MicroPython built from the local checkout copy (`make CWARN=-Wall`, clang needed `-Wno-error`), running `agent.py`: a loop that reads `[kind:1][len:4 LE][code]` frames from stdin, `exec(compile(code))`s them in one persistent globals dict, writes program output on stdout, writes `\x04` + `sys.print_exception` text + `\x04` for `X`-kind frames (pyexec's two-EOF framing), treats `SystemExit` like `PYEXEC_FORCED_EXIT` (`\x04\x04`, then soft reboot), and signals `READY`/`DONE`/`RESET` on stderr.
* Front end `bridge2.py`: a state machine for friendly vs raw REPL (`Ctrl-A/B/C/D`, `raw REPL; CTRL-B to exit`, `OK`, `MPY: soft reboot`, raw-paste `R\x01` + window `0x0080` + flow-control `\x01`), `\n` -> `\r\n` cooking of agent output, SIGINT to the agent on `\x03` while busy (so `while True` loops and swallowed-KeyboardInterrupt loops behave like a board), host bytes arriving while busy queued until the prompt (as a UART buffer would), soft reboot = kill + restart agent (state lost, `boot.py` run, `main.py` not run in raw mode), hard reset via `machine.reset()` stub (state lost, `boot.py` + `main.py`), TCP (`socket://`) and a pty slave (a real device node for `serial.Serial` and for `flock`/exclusivity tests).
* What it cannot do: baud limits, DTR/RTS, USB, flash/FAT (`os.ilistdir` on the unix port returns 3-tuples, so sizes are 0; `os.stat('')` raises, flattening `cp -r dir :`), ESP32 error-number spellings beyond what MicroPython's `OSError` formatting provides, native-USB behaviours.

## 13. Appendix B - GitHub issue themes (micropython/micropython; summaries of the pages, second hand)

| Theme | Issues | Takeaway for us |
|---|---|---|
| ESP reset on connect/disconnect (DTR/RTS) | #9659 (closed 2023-01, 25 comments), PR #10347 (pyboard.py Windows DTR), PR #17776/#17800/#17999/**#18001** (merged 2025-09-30, shipped 1.27.0) | Hard resets on exit were a Windows ordering bug; opening still asserts lines everywhere else. Don't open per operation. |
| Raw REPL entry fails | **#13504** (open; macOS; includes `/dev/cu.usbserial-0001`, v1.27.0), **#17918** (open; ESP32-S3, Windows 11; Ctrl-D must be first on a line), #16142/#8002 duplicates | Wait for boot; poll for prompt; offer hard reset; keep failure dump. |
| REPL unresponsive on native USB | #18321 (closed, fixed in firmware 1.27: ZLP wedge on macOS), #18000 (closed; TinyUSB hang without a CDC host; #17960), #17865/#17560 (macOS file corruption on S3/S2, fixed by #17960) | Require firmware >= 1.27 for native-USB boards. |
| File names / quoting / shadowing | #18657 (apostrophe), #18658 (`=`), #19475 (a copied `os` module breaks mpremote), #17093 (Git Bash path mangling) | Pin >= 1.29, validate names, block built-in shadowing, no shell. |
| Windows paths/config | #9132, #7415, #9689, #7390 (old `os` import bug) | Old; fixed. |
| Transfer integrity/speed | #18420 (checksum verification proposal, open), #18461 (`mip install` hangs, open), #8386 | Verify with `sha256sum` after upload (we hash anyway); chunked own loop with acks (03 Appendix B.3). |
| mount | #17560, #19651 (closed 2026-08), #18660 (socket/RFC2217 REPL/mount, open) | Avoid `mount` as a core feature on USB-JTAG boards. |
| `os.stat('')` on stand-alone ports | #18662 (open) | Explains the `cp -r dir :` difference between emulator and hardware. |

## 14. Appendix C - cross-references into the old source (file:line)

| Topic | Location |
|---|---|
| POSIX-only `shellEscape` (`'...'`), command strings | `mpremote.ts:7-9,170-184`; `mpremoteCommands.ts:9-17` |
| `exec(cmd)` with no timeout, retry on "failed to access" up to 2x | `mpremote.ts:142-233` (`maxRetries` `:144`, retry `:203-214`) |
| `PYTHONIOENCODING=utf-8` (the only env hygiene; no `-I`, `-u`, `-X utf8`) | `mpremote.ts:133-140` |
| `fs tree` as a parsed data source | `mpremote.ts:264,380,795,1532,1586,1621` |
| `fs stat` existence/info | `mpremote.ts:416,1023,1294,1360`; consumer `mpremoteCommands.ts:198-211` |
| `fs mkdir -p` before each upload | `mpremote.ts:948,1103` |
| `fs mv`, `fs run` | `mpremote.ts:1729`, `:1460` |
| REPL terminal creation and the 500/600 ms keystrokes | `mpremoteCommands.ts:253-270` |
| Run-file terminal and import logic | `mpremoteCommands.ts:170-228` |
| Interrupt via `echo -e` / fake `sys.stdin.write` | `mpremoteCommands.ts:392,407,453,469,484` |
| `ensureIdle` = `ls /`, `withAutoSuspend` | `extension.ts:270-296` |
| Dead polling monitor (miniterm every 2 s) | `monitor.ts:8-60` (no caller) |
| Missing helper script name | `pyraw.ts:12` vs `scripts/raw_list_files.py` |
| Declared minimum mpremote | `package.json` description, `mpremoteCommands.ts:55` (`[1,26,0]`) |

## 15. Appendix D - mpremote 1.29.0 source map (for quick lookup)

| What | File:lines |
|---|---|
| Shortcuts / expansions | `main.py:365-435`, `487-529` |
| Per-command argparse | `main.py:101-278` (`fs` `:185-228`, `repl` `:134-152`, `mount` `:121-131`) |
| `State`, auto soft-reset, implicit repl | `main.py:532-558`, `627-634` |
| Config loading | `main.py:438-462` |
| Win32 stdout reconfiguration | `main.py:561-567`, `console.py:195-229` |
| `connect`, `disconnect` | `commands.py:20-91` |
| `cp` / recursive `cp` / `rm -r` / `tree` | `commands.py:134-301`, `304-334`, `345-377` |
| `fs` dispatcher (no `else`) | `commands.py:380-455` |
| exec/eval/run | `commands.py:482-515` |
| open / DTR / RTS | `transport_serial.py:52-108` (CP210x `:71-85`), `122-133` |
| raw REPL | `transport_serial.py:178-232` (entry `:178-212`, follow `:218-232`) |
| raw paste | `transport_serial.py:234-308` |
| fs helpers, error conversion | `transport.py:101-264` (`_quote_path` `:101-106`, `_convert_filesystem_error` `:111-129`) |
| stdout writer | `transport.py:36-84` |
| repl loop, disconnect classification | `repl.py:6-56`, `105-121` |
| tty requirement | `console.py:14-24`, Windows `:57-134` |
| MicroPython side | `shared/runtime/pyexec.c:63,114,124,138,145,174,265-275,319,342-351`; `ports/esp32/main.c:146-159,172,202` |
| pyserial | `serialposix.py:311-374` (open), `383-388` (flock), `703-715` (DTR/RTS) |

---

## Follow-up: Firmware-derived safety and protocol requirements; hardware kit

Role: follow-up investigator for gap 3 of `10-completeness-critic.md` (sections 2.3 and 9). Nothing in `mpy-workbench` or in the firmware repo was modified. **No serial port was opened**: the real CP2102 board on `/dev/cu.usbserial-0001` appears in the kit's port listing (the same offline `comports()` enumeration this note already used) and nothing else; the kit refuses to open a real USB port without a motor-power gate that I did not pass (tested, section F5.7). Nothing was installed anywhere; the Python used for the dry runs is the pre-existing `~/src/mpy_test/.venv` (pyserial 3.5, mpremote 1.29.0), executed but not modified.

Pins used throughout. `FW/` = `<course firmware repo>`, git HEAD `591a1a2` (2026-10-01). `MP/` = `FW/lib/micropython`, which is **exactly tag `v1.29.0`** (`git describe --tags --exact-match` prints `v1.29.0`, commit `0fd6c57`, `git status` clean, i.e. the unmodified tree `FW/CLAUDE.md:96` demands). Old extension = git `7cb90c7`. Evidence tags: **[E]** executed here, **[S]** read from the pinned source, **[D]** fetched web page, **[I]** inference, **[U]** unverified until the kit runs on hardware.

### F0. What this follow-up changes (read first)

1. **The old extension resets the board on purpose in four places** [S], not only by DTR/RTS accident: `mpyWorkbench.openSerial` -> `strictConnectHandshake` -> `mp.reset()` with both guarding settings defaulting to `true` (`package.json:376-385`, `mpremoteCommands.ts:290-338`); the "Soft Reset" button with the REPL closed runs `mpremote connect P reset` = `machine.reset()` (`mpremoteCommands.ts:146-157`; 08 section 3.2); `cpToDevice` answers a failed upload with `reset`, a 2 s wait and a retry (`mpremote.ts:1032-1044`); `robustInterruptAndReset` falls back to `mpremote reset` (`mpremoteCommands.ts:496-505`). On this hardware each of those is a motor-2 twitch with VBATT on, and `openSerial`'s reset-then-immediate-`ls` is a source-proven mechanism for "REPL not opening reliably" that does not need any DTR/RTS theory (08 section 7.3 and 02 R8 had it as [U]/[L]).
2. **A chip reset has two physical effects, not one.** GPIO15 spins motor 2 for about 0.3 s (FW-1), and the reset leaves the REPL in friendly mode, so **`main.py` starts** (FW-9): the student's robot program may begin driving. The old "Soft Reset" with the REPL open (Ctrl-C, Ctrl-B, Ctrl-D into a friendly REPL, `mpremoteCommands.ts:132-141`) is a *soft* reset that also runs `main.py`.
3. **08 section 7.3's DTR/RTS statement is imprecise and the "pre-clear the lines" idea is not universally safe.** Only the state (DTR=0, RTS=1) holds EN low. (DTR=1, RTS=0) selects the ROM download strap but does not reset by itself. A driver that asserts both lines at `open(2)` followed by pyserial clearing DTR first creates (0,1) and **causes** a reset; mpremote therefore applies its pre-clear sequence only on Windows+CP210x and keeps pyserial's default elsewhere (`transport_serial.py:70-97`). RQ-SAFE-1 in 09 ("copy mpremote's open/close sequences") must be read OS-conditionally. Details in F3.1, executed on a truth-table adapter in F5.7.
4. **Rest state matters.** A port left open in (DTR=1, RTS=0) makes the next press of the board's EN button boot the ROM bootloader. The engine must rest in a neutral state ((1,1) or (0,0)).
5. **Stop must not send two Ctrl-C bytes back to back.** 02 section 10.5, 08 sections 6.2/9.5, 09 section 5.1 and RQ-SAFE-3 all say "Ctrl-C twice". Every 0x03 re-arms a pending KeyboardInterrupt (`MP/py/scheduler.c:49-52`); a second one lands inside the program's `finally:` and aborts its cleanup. **[E]** on the real VM: cleanup finished after one Ctrl-C and was cut off after two 100 ms apart. New ladder in F3.4.
6. **"Soft reset = Ctrl-D at the friendly prompt" (RQ-SAFE-2) is not safe as an implicit reset.** It runs `main.py`. Implicit resets must be **raw-REPL** soft resets (Ctrl-A, Ctrl-D), which park the hardware and skip `main.py` (FW-4, FW-9).
7. **The exit hook is narrower than "Ctrl-C stops the motors".** It fires on any *uncaught* exception at top level (KeyboardInterrupt, SystemExit, an aborted raw-paste upload) and on nothing else: a program that ends normally leaves motors and servos running; a caught KeyboardInterrupt leaves them running; `_thread` workers survive Ctrl-C (it is delivered to the main thread only) and die only at a soft reset; the student can lower the policy to `'scripts'`/`'never'` (FW-3, FW-8).
8. **Flash writes stall the control task** (FW-6): uploading while outputs are active leaves motors at their last effort for up to hundreds of ms. File writes need a parked, idle board.
9. `main.py` is skipped not only in raw mode but also when `boot.py` ended with an uncaught exception (`ret == 0` with exit-code handling off on ESP32): a Ctrl-C during `boot.py` skips `main.py` (FW-9).
10. v1.29.0 changed Enter handling (`process_nl`): a lone LF is Enter and CRLF is one Enter; v1.27 ignored LF (FW-15). The REPL view need not translate pasted `\n`.
11. **The firmware ships its own instruments**: `_shield.ABI`, `_shield.__version__`, `exception_policy()`, `motors_ready()` and `hook_counts()` (soft resets, uncaught exceptions, exit stops since power-on; they survive soft resets and zero on a hard reset) are read-only and `stop_all()` is a no-op before the motors are started (FW-12). They make resets and Stop observable without a scope and are what the kit and the future Doctor use.
12. A single, non-destructive, human-run kit now exists and has been dry-run against a fake board whose VM is the real unix MicroPython with the `_shield` simulator (F5).

### F1. Firmware facts (pinned v1.29.0 and the class firmware)

| ID | Fact | Evidence | Tag |
|---|---|---|---|
| FW-1 | **GPIO15 (MOT2_IN1) spins motor 2 at full speed during the whole esptool upload and for about 0.3 s at every reset/power-up when VBATT is on**; 342 coast-down counts were logged after an EN reset on the author's bench. Firmware cannot prevent it (the app claims the pin only after ROM+bootloader: `MICROPY_BOARD_STARTUP`). Fix: 4.7-10 kOhm pull-down on GPIO15 (ECO #1); boards with it fitted are unaffected, which the extension cannot detect, so assume unfitted. Lab rule: "VBATT off while flashing/resetting". | `FW/CLAUDE.md:163,183-188`; `FW/upy_port.md:1010,1249` (R2); `FW/cmodules/shield/mod_shield.c:556-566`; `FW/../shared/esp32_shield/lib/me401_hw/src/board.c:21-47`; `boards/WSU_SHIELD/mpconfigboard.h:38-41,47` | S (hardware measurement by the firmware author, not by us) |
| FW-2 | GPIO12 (MOT1_IN2) HIGH at reset selects 1.8 V flash and bricks boot; the H-bridge pull-down keeps it LOW. GPIO0/2/5/12/15 are straps. | `FW/CLAUDE.md:189-190,241-249`; `boards/WSU_SHIELD/pins.csv:2` | S |
| FW-3 | `MICROPY_BOARD_AFTER_PYTHON_EXEC(input_kind, exec_flags, ret_val, &ret)` runs after **every** top-level execution (REPL line, paste mode, raw-REPL command, raw-paste, `boot.py`, `main.py`). `shield_after_python_exec` does nothing when `ret_val == NULL`; otherwise it counts, and unless the policy is `never` (or `scripts` and the execution was a typed REPL line, flag `1<<2`) it calls `shield_stop_outputs()` (all motors COAST, every pulsing servo off). Default policy `all`; `import shield` re-sets it to `all`. A clean program exit stops nothing. | `MP/shared/runtime/pyexec.c:226-228`; `FW/cmodules/shield/mod_shield.c:56-67,505-516,536-552`; `mpconfigboard.h:44-50`; `FW/python/shield/motor.py:35`; **[E]** counters on the unix simulator: clean exit (0,0,0); script KeyboardInterrupt (0,1,1); policy `scripts` + REPL line (0,+1,+0); `never` (0,+1,+0) | S, E |
| FW-4 | `MICROPY_PORT_DEINIT_FUNC` = `shield_deinit_all()` runs in `mp_deinit` **after** `gc_sweep_all` on every soft reset: motors coast, servos stop pulsing, policy back to `all`; the hardware is parked, never deleted, so a soft reset produces **no pin glitch** (no GPIO15 hazard). `MPY: soft reboot` is printed *before* `mp_deinit` (a few ms earlier). | `mod_shield.c:518-532`; `MP/ports/esp32/main.c:185-241` (`:216` sweep, `:221` banner, `:238` deinit); `FW/upy_port.md:191-193` | S |
| FW-5 | Identity: `sys.implementation._build` is the board directory name, `"WSU_SHIELD"`; `_machine` is `"WSU Motor Shield with ESP32"`; `_shield.ABI == 1` and `_shield.__version__`; the frozen `shield` package raises `ImportError` on an ABI mismatch. Thonny's "Install MicroPython" installs stock firmware and silently removes `_shield`. | `MP/ports/esp32/Makefile` (`BOARD ?= $(notdir $(BOARD_DIR))`); `MP/py/mkrules.cmake:28-35`; `MP/py/modsys.c:104-111`; `MP/py/mpconfig.h:2290-2292`; `mpconfigboard.h:4-5`; `mod_shield.c:42-44,574`; `FW/python/shield/__init__.py:15-18`; `FW/CLAUDE.md:214`; `FW/upy_port.md:1011` | S |
| FW-6 | Flash writes disable the cache on both cores for up to hundreds of ms; the control task pauses and **motors hold their last effort**. The course's own real-time rule: no file writes while driving. | `FW/CLAUDE.md:210-211`; `FW/upy_port.md:194-200,1021` | S |
| FW-7 | The interrupt character (0x03) is armed only while code executes: set at `pyexec.c:128`, cleared at `:139`/`:148`. The ESP32 UART RX ISR **swallows** it while armed (`uart.c:115-116`) and otherwise queues it; idle REPL handling is then in `readline`/raw REPL. REPL is UART0 at 115200 on the classic ESP32 (no USB peripheral), through the CP2102. | `MP/shared/runtime/pyexec.c:127-139,146-149`; `MP/ports/esp32/uart.c:108-121`; `uart.h:33,42-43`; `mpconfigport.h:267-268` | S |
| FW-8 | KeyboardInterrupt is scheduled on the **main thread only** (`MP_STATE_MAIN_THREAD(mp_pending_exception)`); `_thread` workers keep running and are deleted only by `mp_thread_deinit()` at soft reset. | `MP/py/scheduler.c:34-36`; `MP/ports/esp32/mpthreadport.c:211-228`; **[E]** unix port: worker kept counting after Ctrl-C | S, E |
| FW-9 | `boot.py` always runs; `main.py` runs only if `pyexec_mode_kind == FRIENDLY` **and** `boot.py` did not end in an uncaught exception (`ret != 0`; with `MICROPY_PYEXEC_ENABLE_EXIT_CODE_HANDLING == 0` on ESP32, an exception gives `ret == 0`). `pyexec_mode_kind` is a C global initialised to FRIENDLY, set to RAW by Ctrl-A, back to FRIENDLY by Ctrl-B, and **survives soft reset**; a chip reset re-initialises it. Hence: raw-REPL soft reset skips `main.py`; friendly Ctrl-D, a chip reset and an EN pulse run it; mpremote's exit (`\r\x02`) returns the board to friendly, so a later Ctrl-D runs `main.py`. | `MP/ports/esp32/main.c:154-169`; `MP/shared/runtime/pyexec.c:43,581-585,665`; `pyexec.h:40-48`; `MP/py/mpconfig.h:1217-1219` | S |
| FW-10 | `machine.reset()` is `esp_restart()` (`HARD_RESET`, 2 after the reboot); an EN pulse or power-up reports `PWRON_RESET` (1); anything after a soft reset reports `SOFT_RESET` (5) because `machine_deinit()` sets a flag. `time.ticks_ms()` is `esp_timer_get_time()/1000`, i.e. since chip reset, unaffected by soft reset. These make resets detectable without ROM text (which a fitted GPIO15 pull-down silences, `FW/CLAUDE.md:187-188`). | `MP/ports/esp32/modmachine.c:233-258,300-305,346-348`; `mphalport.c:193-195` | S |
| FW-11 | The unix simulator `_shield` (built from `FW/tools/build_unix.sh`) exposes the same module table as the board; `_after_exec(flags, exc)` stands in for the hook the unix port never calls. | `mod_shield.c:493-503`; `real/unix-build/` in the scratchpad | S, E |
| FW-12 | Read-only/safe module calls: `ABI`, `__version__`, `exception_policy()`, `motors_ready()`, `motors_config()`, `hook_counts()`. `stop_all()` and `session_reset()` return immediately before `motors_begin` (`s_state != STATE_READY`). | `mod_shield.c:211-238,363-368,478-503`; `control.c:731-746`; **[E]** `stop_all()`, `motors_ready()`, `motors_config()` on a fresh simulator: `None False None` | S, E |
| FW-13 | Raw REPL / raw paste: entered by Ctrl-A at an empty friendly line; `\x05A\x01` (the line must be exactly Ctrl-E, `A`) gives `R\x01`, a u16 LE window **128** (`MICROPY_REPL_STDIN_BUFFER_MAX` defaults to 256, window = half, ESP32 does not override) and a trailing `\x01` (a second free window, so the initial credit is 256 bytes); Ctrl-D ends, Ctrl-C aborts (then `\x04`, KeyboardInterrupt, hook fires). | `pyexec.c:238-240,248-325,552-617` | S |
| FW-14 | Control keys in the friendly REPL (v1.29.0, EMACS keys on at ROM level EXTRA): Ctrl-A..Ctrl-E are commands **only when the current line is empty**; otherwise Ctrl-A home, Ctrl-B left, Ctrl-D delete, Ctrl-E end; Ctrl-C always cancels. Paste mode: Ctrl-E, Ctrl-D runs, Ctrl-C cancels. | `MP/shared/readline/readline.c:153-181`; `pyexec.c:462-472,682-706`; `MP/ports/esp32/mpconfigport.h:13-14`; `MP/py/mpconfig.h:861-864` | S |
| FW-15 | v1.29.0 `readline` treats a lone `\n` as Enter and `\r\n` as one Enter (`process_nl`, `last_nl` persists across prompts); v1.27-preview accepted only `\r`. | `readline.c:104,141-151`; diff against `~/src/micropython` (v1.27.0-preview-88) | S, E (diff) |
| FW-16 | No Bluetooth; UART2/SPI/I2C defaults re-pointed off the shield pins; `MPY: soft reboot` and the raw-REPL banner are unchanged from stock. | `mpconfigboard.h:11-36` | S |

### F2. Requirements derived (RQ-HW-*)

MUST/SHOULD in the RFC sense. "Verify" names the fake-board scenario (a fake that models FW-3..FW-10, see RQ-HW-17) and/or the kit check (F5). "Amends" lists what in notes 01-09 changes.

| ID | Requirement | Facts | Verify | Amends |
|---|---|---|---|---|
| RQ-HW-1 | **Reset inventory.** The only operations allowed to cause a chip reset are the explicit, confirmed "Hardware reset" (RQ-HW-7) and the user's own EN button/power cycle. Forbidden everywhere else, including "recovery" and "retry": `machine.reset()`, mpremote `reset`/`bootloader`, RTS/EN pulses, ROM-bootloader entry, esptool. The four old paths in F0 item 1 are not ported. | FW-1, FW-10 | Fake: zero EN-low events and zero `RESET` control lines in every scenario except the hardware-reset scenario; static check: the only module that may contain an RTS pulse is `hardwareReset`. | 02 sec 3.4, 10.5; 06 `softReset`; extends RQ-SAFE-1 |
| RQ-HW-2 | **Three reset verbs, never conflated.** *Reset interpreter* = raw-REPL soft reset (Ctrl-A, Ctrl-D): `boot.py` runs, hardware parked, `main.py` does not run. *Reboot (run main.py)* = friendly Ctrl-D, explicit command only, confirmation when `/main.py` exists. *Hardware reset* = RTS pulse. The old "Soft Reset" button becomes *Reset interpreter*, never `reset`. Run's fresh start and Stop's follow-up use *Reset interpreter* only. | FW-4, FW-9, FW-10 | Fake: sentinel `main.py` not run after Reset interpreter, run after Reboot and after Hardware reset; kit M1-M3 on hardware. | **Amends RQ-SAFE-2** (it named friendly Ctrl-D the implicit soft reset); 02 sec 10.5 |
| RQ-HW-3 | **Connect is passive.** Opening the port sends nothing. State is inferred from output (banner/prompt seen = Idle; stream flowing = Running(unknown); silence = Unknown). The only unsolicited byte allowed is one bare `\r` after at least 1 s of silence, to elicit a prompt (risk: a program blocked in `input()` consumes it). Anything stronger needs RQ-HW-9 consent. | FW-7, FW-3 | Fake log: bytes sent on connect = none or one `\r`. | extends RQ-SAFE-1 |
| RQ-HW-4 | **Open policy is a per-(OS, VID:PID) profile, defaults conservative, values replaced by kit results.** Defaults: macOS/Linux = pyserial default open (DTR then RTS) + ordered close; Windows with VID 10C4 = mpremote 1.27 sequence (`dtr=False; rts=False; open; dtr=True; rts=True`) + ordered close; other Windows adapters = pyserial default + ordered close. **Never pre-clear the lines on POSIX unless the kit proved it safe there.** | F3.1 | Kit stage B per OS; fake: truth-table adapter profiles (F5.7). | **Qualifies RQ-SAFE-1**; 08 sec 7.3, 02 sec 13.1 |
| RQ-HW-5 | **Reset detector.** After every open/reconnect and after any operation that can restart the board, run the read-only probe (`ticks_ms`, `reset_cause`, `hook_counts`) and compare: a restart happened when the estimate `wall - ticks_ms/1000` moved by more than 1 s or a counter went down, or ROM text (`ets `, `rst:0x`, `boot:0x`) arrived. Raise `board-restarted(source)`; distinguish ones the engine caused (Hardware reset) from unexpected ones, and for unexpected ones show the one-time notice "The board restarted when VS Code connected. With motor power on, motor 2 can twitch for about 0.3 s. Turn motor power off before connecting." | FW-1, FW-10 | Dry run: stage B detects resets with and without ROM text (F5.7); fake: detector unit tests. | new |
| RQ-HW-6 | **Neutral rest state.** While the port is open and no reset is being performed, (DTR, RTS) must be (1,1) or (0,0): never (1,0) (a later EN press would enter the ROM download mode) and never (0,1) (holds the chip in reset). Hardware reset keeps DTR=0 for the whole pulse. | F3.1 | Fake adapter log of line states; kit E1 asserts no `waiting for download`. | new |
| RQ-HW-7 | **Hardware reset command** per F3.2 (explicit, modal confirmation every time, disabled where the adapter profile says it cannot work). | FW-1, FW-9 | Unit test: only reachable via the confirmed handler; kit E1-E3. | **Amends RQ-SAFE-2** ("do not ask again this session" is removed) |
| RQ-HW-8 | **Stop ladder** per F3.4: one Ctrl-C, wait up to 1.5 s for a prompt, repeat at most twice more at 1.5 s spacing, then offer Hardware reset. Stop bypasses the queue. | FW-3, FW-7, FW-8 | Fake scenarios "swallows KeyboardInterrupt", "kbd_intr(-1)", "slow finally"; kit C4-C8. | **Amends RQ-SAFE-3 and RQ-SAFE-4** ("Ctrl-C twice") and 02/08/09 Stop rows |
| RQ-HW-9 | **Interrupt consent** per F3.3: a modal consent is mandatory before the engine interrupts a program it did not start, and before Reboot (run main.py) and Hardware reset. Background work never interrupts: it waits. | FW-3, FW-9 | Fake: "board running unknown main.py at connect" scenario; no byte `\x03` sent before consent. | new |
| RQ-HW-10 | **Park step (SHOULD).** After Stop and before the first file write of a batch, when `_shield` is importable, run the allow-listed snippet `try: import shield; shield.stop_all()` (motors coast, servos off) . It is a no-op before the motors start. It does not replace Reset interpreter when a `_thread` worker may exist. | FW-3, FW-8, FW-12 | Fake with `_shield`; kit A4 shows `motors_ready`. | new |
| RQ-HW-11 | **No filesystem write while outputs may be active.** Uploads, deletes, renames and mkdirs run only in state Idle after the Park step; in state Running they wait ("paused while the program runs"). | FW-6 | Fake: write attempted in Running is queued and logged. | extends 03 sync rules |
| RQ-HW-12 | **Host-loss stop (extends RQ-SAFE-4).** One Ctrl-C (not two) before closing the port; the close itself may reset the chip, so the close order follows RQ-HW-4/6. | FW-3 | Fake: `kill -9` of the parent. | **Amends RQ-SAFE-4** |
| RQ-HW-13 | **Identity probe.** One allow-listed read-only snippet at first raw-REPL use per connection and after each detected restart, importing only `_shield` (not `shield`, whose import sets the exception policy): `sys.implementation` (`_build`, `_machine`, version), `_shield.ABI/__version__/exception_policy()/motors_ready()`, root listing. Classification: OK (`WSU_SHIELD`, ABI = pack stamp); *stock firmware* (no `_shield`: "this board has plain MicroPython; ask your TA to flash the course firmware; do not use Thonny's Install MicroPython"); *ABI mismatch*; *other build*. Generic MicroPython operation continues on stock boards; Park and the hook diagnostics are disabled. Never offers to flash. | FW-5, FW-12 | Kit A1-A5; fake: `--stock` scenario. | extends RQ-SAFE-5, RQ-ID-3 |
| RQ-HW-14 | **Probe discipline.** Every snippet the engine sends outside user code is a constant, reviewed, and passes an allow-list audit (no GPIO, no `motors_begin`/duty/setpoint/servo calls, no file writes, no `machine.reset`). The kit's `audit()` is the reference implementation. | FW-1, FW-2 | Unit test over the snippet table. | new |
| RQ-HW-15 | **Doctor shows the counters** (SHOULD): "since power-on: N soft resets, N uncaught exceptions, N exit-stops" from `hook_counts()`, and the reset cause. It is a free, teachable instrument and the only way to see that Stop reached the interpreter. | FW-3, FW-10, FW-12 | Kit C4. | new |
| RQ-HW-16 | **No GPIO features.** No pin toggling UI, no generated code that drives straps (0, 2, 5, 12, 15). Optional course lint rule (SHOULD): flag `machine.Pin(n, ...)` on shield pins and straps using `pins.csv`. | FW-2 | Review item. | new |
| RQ-HW-17 | **The CI fake board models the firmware, not just the framing:** interrupt armed only during exec and 0x03 swallowed; `kbd_intr(-1)`; `pyexec_mode_kind` surviving soft reset; the boot.py/main.py rule including a raising `boot.py`; raw-paste window 128 with 256-byte initial credit; Ctrl-C during an upload; the exit hook and `hook_counts`; `reset_cause` values; ticks continuity; an EN truth-table adapter; a HAZARD log line for any chip reset with VBATT on. The scratchpad `fwsim.py` is a seed (F5.6). | FW-3..FW-10 | self | extends 09 Appendix A |
| RQ-HW-18 | **Hardware tests are gated** like RQ-SAFE-6 plus the kit's own gate (typed phrase, unknown-adapter refusal). | FW-1 | Kit gate test (F5.7). | extends RQ-SAFE-6 |

### F3. Decisions

#### F3.1 DTR/RTS on open (decision)

**Circuit facts** [D]: on ESP32 dev boards RTS drives EN and DTR drives GPIO0 through a two-transistor network; "if both RTS and DTR are asserted together, this doesn't reset the chip" (esptool docs, boot-mode-selection); PR #18001: `(DTR && !RTS)` = IO0 low, `(!DTR && RTS)` = "trigger reset". With pyserial semantics (True = asserted):

| (DTR, RTS) | Effect |
|---|---|
| (0,0) | neutral |
| (1,1) | neutral |
| (1,0) | EN high, **IO0 low** (download strap armed; harmless until EN rises) |
| (0,1) | **EN low: chip held in reset**; releasing into (0,0) or (1,1) boots normally, releasing into (1,0) enters the ROM bootloader |

So an EN pulse is *any dwell in (0,1)*. Safe sequences: open (0,0)->(1,0)->(1,1) (DTR then RTS: pyserial's order, `serialposix.py:335-338`); close (1,1)->(1,0)->(0,0) (RTS then DTR: mpremote's close, `transport_serial.py:122-133`). Unsafe: open via (0,1) (a driver that asserts RTS before DTR: Windows CP210x quirk, `transport_serial.py:70-85`), close via (0,1) (DTR dropped first: Windows default, issue #9659), and, **on a driver that asserts both lines at open(2), pyserial clearing DTR before RTS** (the "pre-low" idea): (1,1)->(0,1)->(0,0). Whether macOS's `AppleUSBSLCOM` and the Windows CP210x/CH340 drivers do any of these on this board is exactly what is still [U]; the kit measures it per policy (stage B variants V1-V7).

**Decision**

1. Opening is a function of a profile record `{os, vid, pid, driver?, open: default|preclear-then-set, close: ordered, verified: bool, resetsOnOpen: bool?, resetsOnClose: bool?}`. Ship defaults per RQ-HW-4; replace them with kit results for the class's adapters on macOS and Windows; unknown adapters get the default profile with `verified: false`.
2. Close is always `rts=False; dtr=False; close()` (harmless where unneeded, required where Windows clears DTR first). Never close by killing the process (SIGKILL/TerminateProcess skip it; 08 section 9.2).
3. Rest state neutral (RQ-HW-6). Reopen only on explicit user action or after an unplug; never as "recovery".
4. **Connect mode.** `connect.mode = auto | ask`. Until the profile for the student's (OS, VID:PID) is marked `verified` with `resetsOnOpen == false`, the first connect in a VS Code session is a non-blocking notification with [Connect] / [Not now] and the text "Connecting may restart the board. If motor power is on, motor 2 can twitch for about 0.3 s." Once verified reset-free, silent auto-connect (the behaviour the instructor likes) is allowed. If the kit shows reset-on-open for the class adapter, connect stays `ask` and the lab rule "motor power off before plugging in or connecting" goes into the course handout (the firmware's own rule, `FW/upy_port.md:1249`).
5. The detector (RQ-HW-5) runs regardless, so a profile that is wrong for some student's laptop shows up as a notice rather than as silent motor twitching.

How to read the kit's stage B (per OS):

| Observation | Meaning | Policy |
|---|---|---|
| V1 and V4 clean | pyserial's default does not enter (0,1) | use V4 (default open, ordered close) |
| V1 resets at open; V2/V3 clean | driver asserts RTS first or late (Windows CP210x pattern) | pre-clear sequence V3 on that OS+VID |
| V2/V3/V5 reset at open; V1/V4 clean | driver asserts both lines at open(2); clearing DTR first creates (0,1) | **do not pre-clear** on that OS |
| resets appear only as "close of previous session" for V1/V2 but not V4/V5 | driver drops DTR before RTS on close | ordered close fixes it |
| V4 still resets at close; V6 clean (POSIX) | kernel drops the lines at last close regardless of order | clear HUPCL after open (V6) |
| every variant resets | no safe sequence on this adapter/OS | connect = restart; `ask` mode, lab rule, tell the instructor |
| nothing resets, even V1 | board has no auto-reset network or the lines are not wired | any profile; Hardware reset button cannot work (E1 fails): disable it |
| B-hold FAIL | something resets an idle open board (cable, hub, brown-out) | investigate hardware, not software |
| V7 (real mpremote) differs from V4 | mpremote's own handling differs on this OS | irrelevant to the bridge, but explains old-extension behaviour |

#### F3.2 Is a hardware-reset (RTS pulse) button allowed? **Yes, as an explicit last resort, with these constraints**

- One command, named **Hardware reset (restarts the board and runs main.py)**; not available as a toolbar-level one-click; reachable from the command palette, the Board Actions view and from the "program is ignoring Ctrl-C" notification.
- **Modal confirmation every time, no "don't ask again"** (this removes the "do not ask again this session" in RQ-SAFE-2: the action is rare, it is the only physical one, and it also starts `main.py`). Text: "Hardware reset restarts the board and runs main.py. If motor power is on, motor 2 can spin for about 0.3 s. Turn motor power off or lift the robot, then press Reset. [Reset] [Cancel]". Buttons are not the first/default focus.
- Sequence: `dtr=False; rts=True; sleep 0.1; rts=False` (esptool `HardReset`, DTR low throughout so GPIO0 stays high), then restore the rest state (RQ-HW-6), wait for ROM text or the banner (bounded 5 s), run the identity probe and mark the restart as engine-caused.
- Disabled (with "press the board's EN button") when the adapter profile has `canPulseEN == false`, when the modem lines are not controllable (OSError), when the VID is Espressif native USB (303A), or when kit E1 found `waiting for download`.
- Never an automatic escalation (RQ-SAFE-2 already says so) and never used for connect/recovery.
- The Stop ladder ends at a notification that *offers* it.

#### F3.3 Where an ask-before-interrupt dialog is mandatory

Definition: an *interrupt* is any Ctrl-C (or reset) that terminates a program the engine did not start in this connection (typically `main.py` running since power-up), or any action whose physical effect is a restart of `main.py`.

| Action | Board state | Consent |
|---|---|---|
| Connect, tree refresh, listing, download, diff | any | none; **no interrupt is sent**; if the operation needs raw REPL while Running/Unknown the operation waits (state shown) |
| Auto-sync upload, explicit upload/delete/rename | Idle | none |
| same | Running a program started by this engine's Run | none, but the operation **waits** (RQ-HW-11); a status-bar action "Stop and sync" |
| same | Running/Unknown program the engine did not start | **mandatory, once per connection**: "The board is running a program (probably main.py). Syncing needs to stop it, which stops the motors. [Stop program and sync] [Not now]"; a "Not now" leaves the board alone and pauses auto-sync |
| Run current file | Idle, or Running a program started by Run | none (Run means replace) |
| Run current file | Running/Unknown foreign program | none beyond the Run gesture itself, but the first step is the Stop ladder, never a reset |
| Stop | Running | **never asks** (the safe direction) |
| Reset interpreter (raw soft reset) | any | none |
| Reboot (run main.py) | `/main.py` exists or unknown | **mandatory**: "main.py will start. Make sure the robot is safe." |
| Hardware reset | any | **mandatory every time** (F3.2) |
| Window close/reload/extension deactivation with a program started by this engine | Running | no dialog; single Ctrl-C best effort (RQ-HW-12) |

#### F3.4 Stop ladder and the verbs

1. Send exactly one `\x03` (no leading `\r`: in raw REPL idle a `\r` would join the line buffer).
2. Wait up to 1.5 s for a prompt marker (`>>> `, raw `>`, or the end of a traceback). No second byte before that unless the user presses Stop again.
3. At 1.5 s and 3.0 s send one more `\x03` each. At 4.5 s stop and show "The program is ignoring Ctrl-C (it catches KeyboardInterrupt, disabled it with micropython.kbd_intr(-1), or is blocked in C code)" with [Wait] [Hardware reset...].
4. On a prompt: Park step (RQ-HW-10); if the user chose "Stop and reset" or a `_thread` worker is suspected, Reset interpreter.
5. Evidence needed from hardware: C4/C5 (single Ctrl-C works and how fast), C6 (double aborts cleanup), C7/C8 (swallowed and disabled cases need the ladder), C9 (threads).

### F4. Re-verification of the firmware-side claims in 02, 08 and 09 against the pinned v1.29.0 tree

Line numbers in the older notes came from MicroPython v1.25.0 (02), the local checkout v1.27.0-preview-88 (08) and a v1.29.0 clone (09). I diffed `pyexec.c`, `main.c` and `readline.c` of v1.27-preview against the pinned tree (**[E]** `diff`) and read the pinned v1.29.0 files for each claim. Differences that matter: v1.29 adds `process_nl` in readline, VM-abort/`___file__`/exit-code plumbing and `mp_hal_stdio_mode_*` stubs in pyexec (no effect on ESP32), a `machine_uart_deinit_all()`/CSI deinit in `main.c`, and drops the USB-only `usb.h` block; the raw-REPL, raw-paste, main.py and hook paths are unchanged.

| # | Claim (where) | Verdict on v1.29.0 | Pinned evidence / correction |
|---|---|---|---|
| 1 | Raw-paste: `\x05A\x01` -> `R\x01` + window 128 LE + `\x01`; flow-control `\x01` per window (08 sec 4.5; 09 fake board; 02 sec 13.6 [U]) | **Confirmed [S]** | `pyexec.c:238-240,294-325`; ESP32 does not define `MICROPY_REPL_STDIN_BUFFER_MAX`. Reply bytes are exactly `52 01 80 00 01`; credit at start = 2 windows. Line refs in 08 (`:190-191,270-275`) are v1.27 numbers. Remaining [U] only "on the real board" (kit C2). |
| 2 | After a raw-REPL soft reset `boot.py` runs and `main.py` does not (08 sec 1.2, 4.5; 09 sec 5.1; 02 sec 6.11) | **Confirmed, refined [S]** | `main.c:154-169`; `pyexec.c:43,581-585,665`. Also skipped when `boot.py` raised (FW-9); a friendly Ctrl-D, a chip reset and mpremote-exit-then-Ctrl-D run it. Kit M1/M2. |
| 3 | Ctrl-C interrupts the running program; only one `\r\x03` is sent at raw-REPL entry (08 sec 4.5) | **Confirmed [S]** | `pyexec.c:127-139`; `uart.c:115`. The byte is swallowed by the ISR while armed. |
| 4 | "Ctrl-C twice" is the right Stop (02 sec 10.5 Stop row, 08 sec 6.2(4)/9.5, 09 sec 5.1, RQ-SAFE-3) | **Contradicted as a default [E][S]** | `scheduler.c:49-52` re-arms on every byte. **[E]** unix VM: program with `finally: print('cleanup start'); sleep 400 ms; print('cleanup done')`: one SIGINT -> `cleanup done`; two SIGINTs 100 ms apart -> KeyboardInterrupt inside the `finally`, no `cleanup done`. The hook still stops outputs afterwards, but the student's own cleanup is lost. New ladder F3.4; kit C6. |
| 5 | When KeyboardInterrupt is disabled (`kbd_intr(-1)`) only a hardware reset helps (02 sec 10.5, 13.5) | **Confirmed, narrowed [S]** | `modmicropython.c:152-155`; the interrupt char is re-armed at the start of every top-level exec (`pyexec.c:127-129`), so the effect lasts for that one execution; Ctrl-C bytes sent meanwhile are queued (`uart.c:117-119`) and consumed afterwards (raw REPL: clear line; friendly: break). Kit C8. |
| 6 | Readline control keys: Ctrl-A/B/D/E act only on an empty line, otherwise edit; Ctrl-C always cancels (02 sec 6.10) | **Confirmed [S]** | `readline.c:153-181`; EMACS keys on (`mpconfigport.h:13-14`, `mpconfig.h:861-864`). Kit K1/K2/K4. |
| 7 | Enter handling: `\r` is Enter (implicit in 02 sec 10.7, 08 sec 6.2 item 6) | **Changed in v1.29.0 [S][E]** | `process_nl`: `\n` is Enter too, `\r\n` is one Enter. v1.27 ignored a bare LF. Kit K3. |
| 8 | `reset` shortcut is `machine.reset()`; real soft reset is `soft-reset` (08 sec 3.2, 02 sec 6.3, 04) | **Confirmed [S]** plus the physical consequence | `modmachine.c:346-348` -> `esp_restart()`; reset cause becomes `HARD_RESET`(2), an EN pulse `PWRON_RESET`(1), soft `SOFT_RESET`(5) (`:233-258`). On this board: GPIO15 twitch + `main.py` start (FW-1, FW-9). |
| 9 | `OK\r\n`, `MPY: soft reboot\r\n`, raw banner order after raw Ctrl-D (08 sec 4.5) | **Confirmed [S]** | `pyexec.c:389-397`; `main.c:221`; `pyexec.c:559-563`. Kit D1. |
| 10 | `sys.exit()` in a program ends in a soft reboot (08 sec 3.4, 4.1) | **Confirmed [S], plus** | `pyexec.c:166-185`: SystemExit is `PYEXEC_FORCED_EXIT`; `ret_val` is non-NULL so **the exit hook fires and stops the outputs** (FW-3). With `main.py` ending in `sys.exit()` the board reboots into `main.py` again (a restart loop). |
| 11 | Ctrl-D at the friendly prompt re-runs `boot.py` and `main.py` (02 sec 6.11, 08 sec 4.5) | **Confirmed [S]** (line refs `main.c:143-150` are v1.27) | `main.c:154-169`. Basis of RQ-HW-2. |
| 12 | `MICROPY_BOARD_AFTER_PYTHON_EXEC` stops motors on Ctrl-C and exceptions (critic 2.3, RQ-SAFE-3) | **Confirmed, narrowed [S][E]** | FW-3, FW-8: uncaught only; clean exit/caught exception/threads not covered; policy-dependent. Counters [E] on the simulator. |
| 13 | `PORT_DEINIT` parks on soft reset (critic 2.3) | **Confirmed [S]** | FW-4; ordering: banner, then deinit. |
| 14 | DTR/RTS: "a transition through (1,0) or (0,1) pulses reset" (08 sec 7.3) | **Imprecise [D][S]** | Only (0,1) holds EN low; (1,0) arms IO0. F3.1. |
| 15 | "Hardware reset via RTS pulse with DTR high" (02 sec 13 item 5) | **Wrong as written in pyserial terms** | DTR must be **low**: from (1,0) or (1,1) an RTS 0->1->0 pulse never enters (0,1). 02 sec 10.5 and 09 sec 5.2 already say DTR low; only 02 sec 13 item 5 is wrong. |
| 16 | `main.py` "idle after any mpremote operation" (08 sec 9.5) | **Confirmed [S]** | consequence of FW-9. |
| 17 | Raw-REPL normal mode needs 256 B chunks with 10 ms gaps (08 sec 4.5 fallback) | **Not re-verified** | irrelevant: raw paste is available (claim 1). |

Not re-verified because they are host-side or need a board: mpremote behaviours (08 itself), VS Code terminal behaviours (02), timing numbers, `fs cp` per-chunk cost (needs file writes; excluded from the non-destructive kit), and everything about Windows process trees.

<!-- hwkit-part-1-end -->

