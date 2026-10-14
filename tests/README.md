# tests/ - how to run them, how to write them

Everything here is stdlib `unittest`. No pytest, no pip. The Python-side tests never open a serial port:
they talk to the in-process fake board over `socket://127.0.0.1:PORT`, to ptys the test creates, to stub serial
objects, or (optionally) to the real MicroPython unix port through a socket relay.

## What is where

| Path | What it is | Expected state |
|---|---|---|
| `tests/test_link.py`, `tests/test_devfs.py`, `tests/test_fakeboard.py` | the **core trio**: `bridge/link.py` + `bridge/errors.py`, `bridge/devfs.py`, `tools/fakeboard.py` / relay / hwkit | all green, ~80 s per interpreter |
| `tests/test_support.py` | tests of `tests/support.py` (per-test deadline, `wait_until`, child-process helpers) | all green, ~4 s |
| `tests/support.py` | shared test infrastructure (not a test module) | - |
| `tests/bridge_client.py` | black-box client for the bridge process (`BridgeClient`, `BridgeTestCase`): spawns `bridge/mpy_bridge.py`, always closes it | - |
| `tests/test_scenarios.py`, `test_scenarios_faults.py`, `test_differential.py`, `test_regressions.py`, `test_bridge_ops.py` | the bridge as a process (NDJSON) against the fake board, the unix VM and ptys: Appendix G scenarios, fault injection, mpremote 1.29 as oracle, old-defect regressions, ops no scenario reached | all green, ~4 min together |
| `tests/test_server_fixes.py`, `tests/test_server_pins.py` | round-2 fixes of `bridge/server.py` (signals, disconnect during a Run, state accuracy, Stop watchdog, CLI, hold buffer, 4 MiB guard) and the black-box pins that kill six server-level mutants | all green, ~1 min together |
| `tests/adversarial/` | break-it tests written by independent reviewers (`_harness.py` is shared plumbing) | all green; `test_contract_bridge_process.py` is the 15-test acceptance gate for the bridge |
| `tests/adversarial2/` | round-2 reviewers (break-it, contract conformance, portability/student path, real-VM student runs): the repros of the 22 round-2 findings plus the checks that passed | all green, ~8 min on its own |

## Environment

* `MPY_SAFE_MODE=1` - **always**, in every shell that runs tests, the bridge, the fake board or a kit. The code refuses
  real device paths and COM ports while it is set, and test subprocesses get it forced on by `tests.support.child_env()`.
  `MPY_REAL_PORT` is for the instructor's attended hardware steps only (never `auto`); a test never sets it.
* `MPY_UNIX_BIN=<path to the unix-port micropython>` - optional. The real-VM tests (`VmContractTests`, the relay tests)
  **skip** without it. Never point anything at `/dev/cu.*`, `/dev/tty.*` or `COMn`.
* `MPY_TEST_DEADLINE_SCALE=<float>` - multiplies every `TimedTestCase` deadline (`3` on a slow machine). `0` turns the
  watchdog off, for stepping through a test in a debugger.

## Python versions

The floor is **3.9** (macOS system Python: `/usr/bin/python3` is 3.9.6 on this Mac); the code is meant to run on 3.9
through 3.15 on macOS and Windows. Run the suites with **both** the floor and the newest interpreter you have (here
`python3` is 3.15) before declaring anything done. Rules that keep it portable: `from __future__ import annotations`,
no `match`, no `X | Y` in runtime positions, no `select()` on pipes (Windows), explicit `encoding=` on every
`open()`/`subprocess` text pipe, no `signal.SIGALRM`, no `fork` assumptions.
Windows status: written to be portable, **executed only on macOS** so far [U on Windows].

Always pass `-B` (do not litter `__pycache__` into `bridge/vendor`).

## Commands (from the repo root)

```sh
export MPY_SAFE_MODE=1
export MPY_UNIX_BIN=/path/to/unix-build/micropython        # optional

# the core trio (what "green" means for a change to bridge/ or tools/)
/usr/bin/python3 -B -m unittest tests.test_link tests.test_devfs tests.test_fakeboard
python3          -B -m unittest tests.test_link tests.test_devfs tests.test_fakeboard

# the test infrastructure itself
/usr/bin/python3 -B -m unittest tests.test_support -v

# the adversarial suite: one module, one class, one test
python3 -B -m unittest tests.adversarial.test_stop_cancel
python3 -B -m unittest tests.adversarial.test_portability.WindowsComNameCase
python3 -B -m unittest tests.adversarial.test_safety.SafeModeBypassTests.test_userinfo_and_dns_tricks_do_not_pass_as_loopback

# everything (core + support + adversarial)
python3 -B -m unittest discover -s tests -t . -v
```

Wrap long runs in `timeout N` so nothing can outlive the command (`timeout 300 python3 -B -m unittest ...`).
Windows PowerShell: `$env:MPY_SAFE_MODE = "1"` and `py -3 -B -m unittest ...` [U].

Before you finish a session, check that you left nothing behind:

```sh
ps -axo pid,etime,command | grep -E "fakeboard|mpy_bridge|mpunix|unix-build/micropython|unittest" | grep -v grep
```

## The adversarial suite is a to-do list

`tests/adversarial/` holds reproductions of defects that reviewers found. A repro is **supposed to fail until the defect
is fixed**, and is named so while it is open:

* `test_FAILS_*` / `test_FAILS_TODAY_*` (methods) and `Defect*` (classes) are open defects. They fail on purpose.
  None are open today: the 15 tests of `tests/adversarial/test_contract_bridge_process.py` (findings #6 and #13) went
  green when `bridge/mpy_bridge.py` and `bridge/server.py` were built.
* Every fixed defect had its marker dropped from the name (`test_FAILS_foo` -> `test_foo`, `DefectFoo` -> `Foo`) and
  stays green as a regression test. So do the "checked and fine" tests.

To list the open items for a module:

```sh
python3 -B -m unittest tests.adversarial.test_contract_bridge_process 2>&1 | grep -E "^(FAIL|ERROR):"
```

Rules for working the list:

1. Fix the **code**, never the assertion. A repro test may be edited only on its launch command line / environment
   handling (the harness plumbing), not to make it pass.
2. When the test goes green, say so in the change and consider dropping the marker from the name (`test_FAILS_foo` ->
   `test_foo`, `DefectFoo` -> `Foo`) so that "FAILS" in a name always means "open". Do that in the same change as the fix.
3. A new defect found by review or by hand gets a repro test here first (named `test_FAILS_...`), then the fix.
4. A regression test that guards a *fixed* old-extension defect belongs in the core trio (see "Adding a regression
   test"), not here.

## No sleeps as synchronisation

`time.sleep(n)` to "give the other side time" makes a test slow when `n` is large and flaky when it is small. Do not add
new ones. Wait for the thing you actually need:

* an `Event`/`Condition`/`Queue` that the other thread sets, `Thread.join(timeout)`, `Popen.wait(timeout)`;
* data on the socket/pty (`recv` with a timeout, the harness read helpers);
* for state you can only observe, `tests.support.wait_until(predicate, timeout, "what")` - it returns the instant the
  predicate holds and fails with a message after `timeout` (never a fixed wait);
* a deterministic hook in the fake board (faults, scripted programs) rather than real elapsed time.

A sleep is fine only when **the clock itself is the thing under test** (a timeout test: "exec(timeout=0.3) gives up after
about 0.3 s") or when it is the fake device simulating latency inside `tools/fakeboard.py`. The existing core trio still
contains old sleeps; convert one when you touch it, but do not mass-rewrite.

## Per-test deadline: hangs must fail, not freeze the suite

A regression test for an unbounded wait that fails by hanging is useless. Derive such tests from
`tests.support.TimedTestCase` (a `unittest.TestCase` with a hard deadline, default 60 s). The core trio is already
converted: `test_link.py`, `test_devfs.py` and `test_fakeboard.py` each define a module-level `TimedCase(TimedTestCase)`
with `DEADLINE_S = 120` and every test class derives from it (generous on purpose; scale it with
`MPY_TEST_DEADLINE_SCALE`). New classes in those modules should do the same:

```python
from tests.support import TimedTestCase, deadline

class StopTests(TimedTestCase):
    DEADLINE_S = 20                                   # class default (optional)

    def test_stop_returns_promptly(self):
        link = Link(); self.addCleanup(link.close)    # normal teardown
        self.addWatchdogCleanup(link.close)           # also run by the watchdog if the deadline expires
        ...

    @deadline(120)                                    # one legitimately slow test
    def test_big_upload(self): ...
```

On expiry a watchdog thread records `TIMED OUT after N s`, prints the stack of the blocked test thread, runs the
registered watchdog cleanups once each (newest first) so the blocked call raises or returns, and - if the test thread is
still stuck after `GRACE_S` (5 s) - interrupts the main thread as a last resort (SIGINT via `pthread_kill` on POSIX,
which also wakes a blocking `recv`; on Windows only a pure-Python wait can be interrupted, so register a cleanup that
closes the socket/link/kills the subprocess). Whatever the unblocked test then raises is folded into the single
failure. The watchdog is joined before the test returns (no leaked thread), costs nothing while the test runs (one
`Event.wait`, no polling), uses no `SIGALRM`, and covers setUp + test + tearDown + `addCleanup` functions (not
`setUpClass`). Existing tests keep working unchanged on `unittest.TestCase`; switch the class base when you add or touch
a test that waits on a device, a socket or a subprocess.

## Test subprocesses

Launch Python children with `tests.support.isolated_python_argv(...)` and `tests.support.child_env(...)`, or write the
same flags by hand: `[sys.executable, "-I", "-B", "-X", "utf8", ...]`.

`-I` (isolated mode) **ignores every `PYTHON*` environment variable**, so `PYTHONDONTWRITEBYTECODE=1` and
`PYTHONUTF8=1` in `env=` do nothing there: the child would write `__pycache__` into `bridge/vendor/` and run in the
locale encoding on Windows. `-B` and `-X utf8` must be command-line flags. `tests/adversarial/test_portability.py`
(`DefectTestSubprocessesIgnoreEnvUnderIsolatedMode`) lints the test sources for this, and `tests/test_support.py`
lints the files this directory owns.

Never leave a process running: no `nohup`, no trailing `&`, no `setsid`, no detached spawn. A test that starts a server
or a subprocess registers `addCleanup(stop)` (and `addWatchdogCleanup(stop)` if it can block).

## Adding a regression test and filling `Pinned by`

`docs/old-defects.md` is the regression checklist: every row that applies to the new design must be pinned by a test or
marked N/A with a reason (R-ARCH-9, CLAUDE.md "Working rules").

1. Find the row id (for example `05.11`) and read its *Finding* and *What the new design does* cells.
2. Put the test next to the code it guards: `tests/test_link.py` for `bridge/link.py` / `errors.py`,
   `tests/test_devfs.py` for `bridge/devfs.py`, `tests/test_fakeboard.py` for the fake board, relay and kit. Use the
   fake board over TCP (`socket://127.0.0.1:PORT`) or a pty; never a real port.
3. Name it for the behaviour, not the bug number, and start the docstring with `PINS <row ids>` plus what is asserted,
   e.g. `"""PINS 05.11, 08.12 (busy vs missing vs permission are distinguished)."""`. Assert the new behaviour in a way
   that fails against the old (buggy) behaviour. Derive from `TimedTestCase` if it can block.
4. Run the module on both interpreters (see Commands).
5. Fill the row's `Pinned by` cell in `docs/old-defects.md`: the unittest dotted id, relative to the repo root, as
   `tests.test_link.ClassName.test_name`; several tests separated by `;`. If the row does not apply, write
   `N/A: <reason>`. (Whoever owns the docs edits that file; a fixer who does not own it lists the exact cell text in its
   hand-off note.) Tick the matching `plan.md` box and add the dated progress-log line in the same change.

## Evidence

Say what you ran: the exact command, the interpreter, and the counts (`Ran 22 tests ... OK`). Label claims about
Windows, hardware, Pylance or the firmware as executed / read / unverified (CLAUDE.md, rule 11).
