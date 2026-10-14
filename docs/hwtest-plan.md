# Hardware test harness plan (`tools/hwtest/`)

Purpose: verify the bridge (and later the extension) against a REAL board, safely, including unattended. Authorization and limits: `CLAUDE.md` "Hard rules" (each hardware session needs the instructor's explicit go; the overnight authorization this harness was built under is used up). This file is the brief for building the harness (agents write and unit-test it against the **fake board only**; only the orchestrator ever runs it on the real port).

## Principles
1. **Generic.** No board- or course-specific code (D-15, `board-specific-inventory.md`). Anything specific to one firmware is DATA in a config file (`--config`), e.g. the instructor's `private/wsu/hwtest.json`.
2. **Cannot hurt the board by construction.** Confinement and tripwire are enforced by the harness itself, not by promises.
3. **Bridge-level.** It drives the real bridge process over NDJSON (`tests/bridge_client.py`), so it tests exactly what the extension will use.
4. **Fake-board mode.** `--fake <profile>` runs every phase against `tools/fakeboard.py` (socket URL, `MPY_SAFE_MODE=1`), so the harness itself is unit-tested (`tests/test_hwtest.py`) and the real run holds no surprises.
5. **Reports.** JSON + console transcript under `tools/hwtest/reports/<UTC timestamp>/`; exit code 0 only if every phase passed and no tripwire tripped.

## CLI
`python3.13 tools/hwtest/run_hw.py --port <PORT|socket://...> [--config file.json] [--phases A,B,C,D,E,F] [--fake PROFILE] [--allow-real-port] [--report DIR] [--list-phases]`
- A real device path (anything not a loopback `socket://`/`loop://` URL or a registered pty) requires BOTH `--allow-real-port` and env `MPY_REAL_PORT` equal to `--port`, plus `MPY_SAFE_MODE=1` (the bridge enforces the same). Otherwise refuse with exit code 2 before spawning anything.
- `--list-phases` prints phases and what each may send; opens nothing.

## Config schema (`hwtest.config.json`)
`{"backup_files": ["boot.py", "test.py"], "expect": {"impl": "micropython", "build": "WSU_SHIELD"?, "version_min": [1,29,0]?}, "extra_probes": [{"name": "...", "code": "single-line read-only expression printing a value", "before_after": true}], "scratch": "/_mpybench_test", "notes": "free text copied into the report"}`. Defaults: no backups, scratch `/_mpybench_test`, no expectations.

## Confinement (enforced in the harness client wrapper)
- Every device-path argument (`path`, `remote`, `src`, `dst`, `root`) of any op that **writes** (`fs.put`, `fs.rm`, `fs.rmtree`, `fs.mkdir`, `fs.mv` source and destination) must start with `scratch + "/"` (or equal `scratch`), after normalising `..`, double slashes and case tricks; violations raise before the request leaves the harness.
- Read-only ops outside scratch are allowed only for: `fs.list`/`fs.manifest`/`fs.stat` anywhere, and `fs.get` of the config's `backup_files`.
- `run` accepts only harness-authored programs from the harness's own temp dir; the program text is scanned and refused if it contains any of: `reset`, `bootloader`, `Pin(`, `.Pin`, `PWM`, `ADC`, `DAC`, `I2C(`, `SPI(`, `UART(`, `esp.`, `esp32.`, `network`, `os.remove`, `os.rmdir`, `os.rename`, `open(`, `import shield`, `import _shield`, `motor`, `servo` (the harness's programs only print, sleep, read stdin, raise exceptions, or loop).
- Never `reset.hard`, never any reset op, never `connect` with an `openPolicy` other than `auto`.
- Never creates `main.py` or `boot.py` anywhere; refuses names that shadow modules (`machine`, `os`, `sys`, `time`, ... plus the config's `shadow_names`).

## Tripwire
Probe (read-only exec, no names left behind): `print("@@TRIP", __import__("time").ticks_ms(), __import__("machine").reset_cause())`, plus the config's `extra_probes`. Taken: right after connect (baseline), before and after every phase, and after every Stop/Run. **Trip** if `ticks_ms` decreases, or grows by more than wall-clock elapsed + 3 s (a suspended board is fine; a reset is not), or `reset_cause` differs from the baseline, or the bridge reports `state` reason `board-reset`/E_BOARD_RESET. On trip: record, run the cleanup (remove scratch, verify backups if still possible), disconnect, exit with code 3, and write `TRIPPED` prominently in the report. A fake-board option `reset_on_connect` must trip it in tests.

## Phases
- **A - read-only (always first).** `ports.list` (no open), `connect` (assert sync verdict `prompt`, state `idle`; refuse to continue if `running`/`unknown`/`prompt-unverified` and report it), `identity`, `fs.manifest /` (hash, read-only), compare against `expect`, baseline tripwire, `disconnect`/`connect` x3 with tripwire.
- **B - files in scratch.** Backup `backup_files` via `fs.get` to `tools/hwtest/backup/<ts>/` and record sha256; `fs.mkdir` scratch; put/get/stat/mv/rm of small files (0 B, 1 B, 4 KiB, 100 KiB, binary 0-255, weird names: spaces, parentheses, quotes, unicode, very long within limits), `expectSha` skip, shadow-guard refusal (`/_mpybench_test/machine.py` is allowed, but `/machine.py` is refused by the harness before sending), cancel a 200 KiB upload with `stop` (no `.mpytmp` left), `fs.manifest` of scratch vs host hashes, `fs.rmtree` of scratch subfolders; at the end `fs.rmtree` scratch and verify the backups' hashes are unchanged on the board.
- **C - run (harmless programs).** print + exit ok; syntax error; runtime exception with traceback citing the local path (temp dir path with spaces and parentheses); `tty.write` keystrokes echoed by a stdin-reading program within 0.5 s; `while True` loop stopped with `stop` (latency recorded, bound 200 ms reply); a program printing 1 MB; `run` twice in a row; each followed by a tripwire and a check that state returns to `idle`. Extra probes (e.g. hook counters) recorded before/after.
- **D - REPL.** `repl.attach`, write an expression and read the echo/result events, set a variable, do file ops while attached, evaluate the variable again (state preserved), `repl.detach`.
- **E - mirror flows (against the scratch root).** Create a local temp project tree (nested dirs, 20-50 files), upload to `scratch/proj` with manifests, compare, modify some files, upload only changes (expectSha), delete one, rename one, download everything back into a second temp dir and compare byte-for-byte; time and bytes/s recorded.
- **F - soak (optional, `--phases F`).** 20 connect/disconnect cycles with a tripwire each; 200 small ops in one session.

## Cleanup (always, in a `finally`)
Stop any program (`stop`), remove scratch, verify backups, `disconnect`, terminate the bridge (stdin EOF), verify the board is idle (`sync` = prompt) and no scratch folder remains; report any residue loudly.

## Tests (stdlib unittest, fake board only)
`tests/test_hwtest.py`: argument refusal for real ports without both guards; confinement refusals (paths outside scratch, `..` tricks, case tricks, forbidden program text); tripwire trips on `reset_on_connect` and on a ticks regression; every phase passes against profiles `esp32`, `rp2`, `esp8266` (hash none), `unix-like`; cleanup runs after an injected failure; report JSON schema; `--list-phases` opens nothing.
