# tools/hwtest - generic hardware test harness

Verifies the bridge (`bridge/mpy_bridge.py`) against a real MicroPython board, or against `tools/fakeboard.py`, through the same
NDJSON protocol the VS Code extension uses. Spec: `docs/hwtest-plan.md`. Authority and limits: `CLAUDE.md`, "Standing hardware
authorization". Tests: `tests/test_hwtest.py` and `tests/test_hwtest_reset.py` (phase R) (fake board only).

Nothing in this folder knows a particular board or course. Board facts (expected build, backup files, probes, names that must not
be shadowed) live in a `--config` JSON file (schema in `config.py`).

## What it will and will not do (enforced in code, `confine.py`)

Will:
- connect once with `openPolicy` absent/`auto` (the bridge picks the default open that is known not to reset the chip);
- read: `ports.list`, `identity`, `fs.list`, `fs.manifest`, `fs.stat` anywhere; `fs.get` only of the configured backup files;
- write the board ONLY inside the scratch folder (default `/_mpybench_test`), and remove it again;
- `run` its own tiny programs (print, sleep, read `sys.stdin`, raise, loop until Stop); type printable text into the REPL;
- read `time.ticks_ms()` and `machine.reset_cause()` (and the config's read-only probes) as a tripwire.

Will not (each refusal is raised before a request leaves the process, and has a test):
- send any reset op (`reset.soft`, `reset.hard`, ...) in phases A-F or without the gates of phase R (below), `interrupt:true`,
  `force:true`, an `openPolicy` other than `auto`, Ctrl-C or other control characters through `tty.write`;
- write, move or delete anything outside the scratch folder (paths are normalised: `..`, `//`, case tricks, trailing dots/spaces);
- create or change `main.py` / `boot.py` anywhere, or a file named like a firmware/stdlib module (`machine`, `os`, `sys`, `time`,
  ... plus the config's `shadow_names`) at an import root;
- run code that it did not author, import anything but `sys`/`time`/`select`, touch pins, files, networks, or flash/erase firmware
  (the scanner looks at every identifier and import anywhere in the text, also after `;`, `:`, in aliases and one-line suites; the
  program files are read-only and are re-hashed again right before the send);
- type anything into the REPL except the fixed lines of `confine.TTY_LINES` (phase D), or, while a harness program runs, up to 16
  letters/digits/spaces for its `stdin`;
- import a module from a probe other than `time`, `gc` and the config's `probe_modules` (importing RUNS a module: never `main`,
  `boot`, `test`, `_boot`, `inisetup`, a frozen package of the firmware, or user code);
- touch a board that is not idle at a prompt (phase A exits 4 and leaves it alone), or a scratch folder that already exists.

## Running it on the real board (orchestrator only)

Preconditions: the motor-power checklist in `CLAUDE.md` was done; nothing else holds the port (the harness checks with `lsof`).
Always set `MPY_SAFE_MODE=1`. A real device path needs ALL of: `--allow-real-port`, env `MPY_REAL_PORT` exactly equal to `--port`
(never `auto`), and `MPY_SAFE_MODE` truthy. Otherwise the harness exits 2 before spawning anything.

```sh
cd <repo root>
export MPY_SAFE_MODE=1
PORT=<the device path, e.g. /dev/cu.<name> on macOS>

# 1. dry run: checks guards and config, prints the plan, spawns and opens nothing (exit 0)
MPY_REAL_PORT=$PORT timeout 60 python3.13 -B tools/hwtest/run_hw.py --port $PORT --allow-real-port --config <config>.json --dry-run

# 2. read-only first (phase A only), then widen
MPY_REAL_PORT=$PORT timeout 300  python3.13 -B tools/hwtest/run_hw.py --port $PORT --allow-real-port --config <config>.json --phases A
MPY_REAL_PORT=$PORT timeout 1800 python3.13 -B tools/hwtest/run_hw.py --port $PORT --allow-real-port --config <config>.json --phases A,B,C,D,E
```

`timeout` sends SIGTERM: the harness turns it (and SIGHUP/SIGBREAK) into Ctrl-C and still runs the cleanup (it needs a few seconds,
so do not use `timeout -s KILL`). Allow roughly 5 to 10 minutes at 115200 baud for A to E (1 MiB of program output, 200 KiB uploads).
`--phases F` adds the soak (20 connect cycles, 200 small ops). Phase A always runs first. Phase R (the reset tiers) is a
separate, gated step: see "Phase R" below; it is never part of the defaults.

Other flags: `--report DIR` (base folder, default `tools/hwtest/reports`), `--backup-dir DIR` (default `tools/hwtest/backup`),
`--list-phases` (what each phase may send; opens nothing), `--fake PROFILE [--fake-fault NAME]` (see below),
`--allow-resets N` (chip reset budget of phase R, 1 to 5, default 0 = no reset is ever sent).

### Exit codes

| code | meaning | what to do |
|---|---|---|
| 0 | every selected phase passed, no trip, no residue | - |
| 1 | a phase failed, residue was left, or an unexpected error | read `report.json` (`phases[].checks`, `residue`, `cleanup`) |
| 2 | refused by a guard, bad arguments or bad config (nothing started) | fix the command line / env / config |
| 3 | TRIPPED: a chip reset is suspected (`TRIPPED` in the report) | stop all hardware work, record the incident in `plan.md` |
| 4 | phase A refuses: board not idle at a prompt, wrong board (`expect`), port held, scratch exists, tripwire unreadable | board was left alone; see `refused.reason` |
| 5 | RESET PHASE ABORTED: phase R met its first surprise (the board did not come back in 20 s, not idle at a prompt, identity or backups or manifest differ, a restart the harness did not cause, an unexpected bridge error) | no further reset was sent; read `reset.aborted` and `reset.steps` in `report.json`; check the board by hand |
| 130 | interrupted | the cleanup ran; check `residue` |

### Tripwire (see `tripwire.py`)

Read right after connect (baseline), before/after every phase and after every Stop/Run. In phase R it runs in reset-expected mode:
after a chip reset the harness caused, the first probe must read a restart (`ticks_ms` < 15 s) and becomes the new baseline; every
other restart still trips. It trips on: `ticks_ms` going backwards,
growing by more than the wall clock + 3 s or by less than the wall clock minus 1.5 s and 1% (a restart whose new ticks are still
above the old reading; the same bounds are applied against the baseline, so a board that restarts at every reconnect falls behind),
a changed `reset_cause` (a soft-reset cause is expected after the harness itself ran a
program), at baseline a board with less than 60 s of uptime (it cannot be told from a reset caused by the connect itself; wait a minute and
run again) or younger than the session or a SOFT_RESET cause with a short uptime, a bridge `board-reset` state or
`E_BOARD_RESET`. A probe that cannot be read after a good baseline (the port re-enumerated, `E_NO_DEVICE`) is also a trip (exit 3),
not a refusal. On a trip the harness removes scratch, verifies the backups, disconnects, exits 3. It does not run the final
"reconnect and verify" step then, to keep the number of port opens at the minimum.

### Cleanup (always, in a `finally`, also after exceptions, Ctrl-C and SIGTERM)

Reconnect (bounded) when the link was lost, e.g. a board that re-enumerates after a reset. Stop a program the harness started
(never one it found), remove scratch, verify the backup files against the host copies,
disconnect, reconnect once to confirm `state idle / sync prompt` and no scratch folder, disconnect, end the bridge (stdin EOF).
Anything left behind is listed under `residue` in the report and printed on the console; a cleanup step that fails is itself a residue
line. The whole run has a time budget (`--max-minutes`, default 25, every wait is clamped to it); the cleanup has its own 90 s, and
the first cleanup step that gets no answer ends all further bridge calls. The report folder is created and test-written before
anything is spawned (exit 2 if that fails); a report that cannot be written at the end turns exit 0 into exit 1.

### Reports

`tools/hwtest/reports/<UTC timestamp>/report.json` (schema in `report.py`) and `console.txt`; backups go to
`tools/hwtest/backup/<same timestamp>/`. Both folders are created at run time; commit nothing from them without looking.

## Phase R: the reset tiers (orchestrator only, with the instructor present)

Phase R is the ONLY code that can make the board restart. It tests the three reset tiers of the bridge (soft, machine, hard;
`docs/protocol.md` Appendix D) and exists because the instructor waived the "no chip reset" rule for the reset tiers, for one
session, with the board's motor power ON (a chip reset can spin a motor; that waiver is used up, see `CLAUDE.md` "Hard rules"). Phases A-F
still refuse every reset op by construction; nothing below changes that.

### Gating: ALL of these must hold, otherwise exit 2 before anything is spawned

| gate | rule |
|---|---|
| explicit request | `--phases` names `R` (e.g. `--phases A,R`). It is never in the defaults. Phase A always runs first, R last |
| budget flag | `--allow-resets N` with 1 <= N <= 5 (hard cap 5). Default 0 = refused. `--allow-resets` without `R` in `--phases` is refused too |
| environment | `MPY_ALLOW_RESETS` exactly `1` (not `true`, not ` 1`) |
| real device | additionally all the real-port guards: `--allow-real-port`, `MPY_REAL_PORT` equal to `--port`, `MPY_SAFE_MODE` truthy |
| config | optional key `allow_resets` (`false`/`0` forbids, an integer 1..5 caps). A config can only LOWER the budget, never raise it or enable anything: the effective budget is min(N, cap) |

`--dry-run` checks the same gates and prints the plan including `chip resets budget N`; it spawns and opens nothing.

### What phase R sends (confinement, `confine.py`)

The allowlist gains exactly four ops, and only while phase R has armed the gate: `reset.capability` (no arguments; `learned` only
as null or "failed", never forwarded), `reset.soft` (no arguments, once), `reset.machine` `{confirmed: true}` and `reset.hard`
`{confirmed: true, verify: true|false}`. No `force`, `method`, `learned`, `interrupt`, no other argument. Each chip reset
(`reset.machine`, `reset.hard`) is debited from the budget BEFORE it is sent; the request that would exceed the budget is refused
inside the harness. Units: machine 1, hard without verify 1, **hard with `verify:true` 2** (the bridge repeats the pulse once when the chip
reports "waiting for download", so one verification can reset the chip twice; `--allow-resets N` therefore bounds what the board can
physically see). The announcement says so. Only one
reset is in flight at a time (the next one is refused until the previous was recovered) and after an abort none is ever sent
again. `reset.hard` is allowed only when a `reset.capability` read AFTER the last chip reset says `hard.state` is `verified` or
`likely` (never `unlikely`, `unknown`, `failed`; never forced). Every request goes out as exactly one message and is never
retried. While phase R is armed the write allowlist is empty: no fs writes, no `run`, no `tty.write`, no `stop`.

### Steps

Each reset is announced `RESET i/N: <tier> (a motor may twitch)` on the console and in the report BEFORE it is sent, then the
harness waits 3 s (time to press Ctrl-C), re-checks that the board is idle at a prompt and the tripwire quiet, and sends one request.

| step | what |
|---|---|
| R0 | read-only baseline: the configured backup files by hash (`fs.get` into the backup dir, compare), root manifest, tripwire baseline in reset-expected mode |
| R1 | `reset.capability`, printed and recorded in full (`reset.capability` in the report; later reads in `capability_reads`) |
| R2 | `reset.soft` once: the chip is NOT reset, `ticks_ms` must keep growing, `reset_cause` may become SOFT_RESET |
| R3 | `reset.machine` twice: the link drops or re-syncs, the board is back within 20 s, `ticks_ms` restarted (< 15 s of uptime at the first probe), identity equal, state idle at a prompt, bridge state events recorded. A port that drops (native USB) is reconnected by the harness (a connect, never a reset). If the capability says machine is unavailable (e.g. the unix port) the step is skipped with a note |
| R4 | `reset.hard` with `verify:true` once, then `reset.hard` without verify once, only if the capability allows hard. Records `verified`, `evidence`, `learned`, `cacheKey`. Skipped with a note when hard is unlikely/unknown/failed, or when the verification found no reset (`E_RESET_NOT_OBSERVED`) |
| R5 | final: identity and root manifest equal to the baseline, backups unchanged, board idle, no program running |

Steps beyond the budget are skipped with a note (not a failure); when the hard verification (2 units) does not fit, the plain hard
reset after it is skipped too (never an unverified hard reset first). With `--allow-resets 5` the expected plan on a CP210x ESP32 is 1
soft + 4 chip requests (machine, machine, hard verify, hard) = 5 budget units; with 4 the plain hard reset is left out, with 3 the
verification too.

### Abort rule (exit 5)

On the FIRST surprise: the board does not come back within 20 s, is not idle at a prompt, its identity differs, the backup files or
the manifest differ, the tripwire sees a restart the harness did not cause (the tripwire knows the resets it caused; any other
`ticks_ms` regression or lag of more than 0.3 s + 1 % (1.5 s outside phase R), changed `reset_cause` or `board-reset` event trips), a reset op reports that nothing restarted, or a bridge
error other than the expected ones (`E_UNSUPPORTED` of a tier, `E_RESET_NOT_OBSERVED` of a verification): the gate is aborted (no reset
is ever sent again, nothing is retried), the normal cleanup runs without reconnect-and-reverify (a board that did not come back is
not asked anything), and the harness exits 5 with `RESET PHASE ABORTED` and the reason in `report.json` (`reset.aborted`). A trip is
reported as exit 5 inside phase R, not 3.

### Report

`report.json` has a `reset` object: `capability`, `capability_reads`, `baseline`, `steps` (per reset: tier, announcement, UTC times
announced / sent / recovered, `recovery_s`, `ticks_ms_after`, `reset_cause_after`, `verified`, `evidence`, `learned`, `cacheKey`,
`method`, `portDropped`, `reconnect`, `bridge_events`, `status`, `note`), `skipped`, `aborted`, `ledger` (every reset request that
was allowed out, with `cost` and `pulses_max`) and `summary` (`chip resets performed N / budget B`, restarts observed, soft resets;
`chip_resets_sent` is what the board can have seen: exact once a response proved how many pulses a verification used, else the worst
case; `chip_budget_units_reserved` is what the gate debited). An abort because of an unsafe verification sequence (the chip may sit
in the ROM bootloader) leaves the board alone like a board that did not come back: the cleanup only disconnects.

### The command for the real board (orchestrator only)

Preconditions: the motor-power checklist of `CLAUDE.md` is done or waived by the instructor for this session, the instructor is
present, nothing else holds the port, the dry run below is OK, and phase R was reviewed. Phases A-E should have passed before.

```sh
cd <repo root>
export MPY_SAFE_MODE=1
# dry run first (checks the same gates, spawns nothing, prints "chip resets budget 5")
MPY_SAFE_MODE=1 MPY_ALLOW_RESETS=1 MPY_REAL_PORT=<port> timeout 60 python3.13 -B tools/hwtest/run_hw.py --port <port> --allow-real-port --config <config> --phases A,R --allow-resets 5 --dry-run
# the real run
MPY_SAFE_MODE=1 MPY_ALLOW_RESETS=1 MPY_REAL_PORT=<port> python3.13 -B tools/hwtest/run_hw.py --port <port> --allow-real-port --config <config> --phases A,R --allow-resets 5
```

Wrap the real run in `timeout 600` (SIGTERM still runs the cleanup). Rehearse it without any hardware:
`MPY_SAFE_MODE=1 MPY_ALLOW_RESETS=1 python3.13 -B tools/hwtest/run_hw.py --fake esp32 --phases A,R --allow-resets 5` (a stand-in for the
control lines, `fakedriver.py`, lets the fake board take a hard reset through the real bridge process; profiles `esp32 esp8266
custom-frozen rp2 esp32s3-usb unix-like`).

## Fake-board mode (development, CI)

`python3.13 -B tools/hwtest/run_hw.py --fake esp32` starts `tools.fakeboard.FakeBoard` in-process and connects the real bridge to its
`socket://127.0.0.1:PORT` URL (profiles: `esp32 rp2 esp8266 unix-like custom-frozen esp32s3-usb ...`; `--fake-fault reset_on_connect`
must trip the tripwire). No real device can be reached this way. Unit tests: `python3.13 -B -m unittest tests.test_hwtest`
(about 3 minutes; the guard, confinement and tripwire unit tests alone take a second).

## Config file

```json
{"backup_files": ["boot.py", "test.py"],
 "expect": {"impl": "micropython", "build": "SOME_BUILD", "version_min": [1, 29, 0]},
 "extra_probes": [{"name": "counts", "code": "print('@@PROBE', __import__('_mod').get_counts())", "before_after": true}],
 "scratch": "/_mpybench_test",
 "shadow_names": ["mymodule", "_mymodule"],
 "probe_modules": ["_mymodule"],
 "allow_resets": 5,
 "notes": "free text copied into the report"}
```

Unknown keys are refused. `scratch` must end in a folder whose name starts with `_mpybench` and may not be inside a `lib` or
`.frozen` folder at any depth. A probe is device code, so it must be a single `print(...)` of allowlisted getter calls
(`get_*`, `is_*`, `has_*`, `*_count(s)`, `*_info`, `*_stats`, `ticks_ms`, `mem_free`, ... and no action word such as `set`, `clear`,
`sleep`, `write`, `read`, `stop` in the name) on the modules `time`, `gc` and `probe_modules`. `probe_modules` defaults to the
private `_name` entries of `shadow_names` (C modules have no Python top level); a name in `shadow_names` without a leading
underscore (a frozen package) can never be imported by a probe, and `main`/`boot`/`test`/`_boot`/`inisetup`, `os`, `machine`,
`network`, sockets ... never, whatever `probe_modules` says. A `backup_files` entry may not be the root folder. `allow_resets` (optional) caps the chip reset budget of phase R
(`false`/`0` forbids it, an integer 1..5 caps it, absent or `true` = no cap); it can only lower what `--allow-resets` asks for. Anything
refused is a config error (exit 2).
