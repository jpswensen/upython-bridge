"""Tests for tests/support.py: the per-test deadline (TimedTestCase / @deadline) and the child-process helpers.

Every "inner" test case is built inside the test that needs it (never at module level) so unittest discovery
cannot collect a deliberately hanging test.  Waits here are Events, socket calls and the clock itself: no
sleep() is used as synchronisation (tests/README.md).

Run (from the repo root):
    export MPY_SAFE_MODE=1
    /usr/bin/python3 -B -m unittest tests.test_support -v
"""
from __future__ import annotations

import functools
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tests import support  # noqa: E402
from tests.support import (  # noqa: E402
    SCALE_ENV, WATCHDOG_THREAD_PREFIX, DeadlineExceeded, TimedTestCase, child_env, deadline, isolated_python_argv, wait_until)


def _watchdogs():
    return set(t.name for t in threading.enumerate() if t.name.startswith(WATCHDOG_THREAD_PREFIX))


def run_case(cls, *names):
    """Run the named tests of ``cls`` in this thread; return (TestResult, elapsed seconds)."""
    suite = unittest.TestSuite(cls(n) for n in names)
    result = unittest.TestResult()
    t0 = time.monotonic()
    suite.run(result)
    return result, time.monotonic() - t0


class DeadlineTests(TimedTestCase):
    DEADLINE_S = 30                                  # the suite protects itself with its own medicine

    # ------------------------------------------------------------------ the headline behaviour
    def test_a_test_blocked_forever_on_a_socket_recv_is_failed_within_1_5_s_of_the_deadline(self):
        events = []

        class Blocked(TimedTestCase):
            DEADLINE_S = 0.4

            def test_recv(self):
                a, b = socket.socketpair()
                self.addCleanup(a.close)
                self.addCleanup(b.close)

                def unblock():
                    events.append("shutdown")
                    a.shutdown(socket.SHUT_RDWR)

                self.addWatchdogCleanup(unblock)
                a.recv(1)                            # nobody ever sends
                events.append("recv returned")

        before = _watchdogs()
        result, took = run_case(Blocked, "test_recv")
        self.assertEqual(result.testsRun, 1)
        self.assertEqual(result.errors, [], "the induced exception must be folded into the one failure")
        self.assertEqual(len(result.failures), 1, result.failures)
        text = result.failures[0][1]
        self.assertIn("TIMED OUT after 0.4 s", text)
        self.assertIn("DeadlineExceeded", text)
        self.assertIn("test_recv", text, "the report names the line the test thread was blocked on")
        self.assertIn("a.recv(1)", text)
        self.assertGreaterEqual(took, 0.35)
        self.assertLess(took, 0.4 + 1.5, "failed %.2f s after the deadline" % (took - 0.4))
        self.assertEqual(events, ["shutdown", "recv returned"])
        self.assertEqual(_watchdogs() - before, set(), "the watchdog thread leaked")

    @unittest.skipIf(sys.platform == "win32", "a blocking recv is only interruptible by signal on POSIX")
    def test_without_any_cleanup_a_blocked_recv_is_still_interrupted_after_the_grace_period(self):
        if threading.current_thread() is not threading.main_thread():
            self.skipTest("the last-resort interrupt only reaches the main thread")

        socks = []

        class Unregistered(TimedTestCase):
            DEADLINE_S = 0.3
            GRACE_S = 0.3

            def test_recv(self):
                a, b = socket.socketpair()
                socks.extend((a, b))                 # the interrupt skips this test's own cleanups (documented)
                a.recv(1)

        self.addCleanup(lambda: [s.close() for s in socks])

        result, took = run_case(Unregistered, "test_recv")
        self.assertEqual(len(result.failures), 1, (result.failures, result.errors))
        self.assertIn("TIMED OUT after 0.3 s", result.failures[0][1])
        self.assertIn("interrupted it", result.failures[0][1])
        self.assertLess(took, 0.6 + 1.5)

    def test_a_pure_python_spin_with_no_cleanup_is_interrupted_and_the_suite_carries_on(self):
        if threading.current_thread() is not threading.main_thread():
            self.skipTest("the last-resort interrupt only reaches the main thread")
        ran = []

        class Stuck(TimedTestCase):
            DEADLINE_S = 0.3
            GRACE_S = 0.3

            def test_spin(self):
                never = threading.Event()
                while True:
                    never.wait(0.01)

            def test_next(self):
                ran.append("next")

        result, took = run_case(Stuck, "test_spin", "test_next")
        self.assertEqual(result.testsRun, 2)
        self.assertEqual(len(result.failures), 1, (result.failures, result.errors))
        self.assertIn("TIMED OUT after 0.3 s", result.failures[0][1])
        self.assertIn("interrupted it", result.failures[0][1])
        self.assertEqual(ran, ["next"], "the test after the hung one must still run")
        self.assertLess(took, 0.6 + 1.5)

    # ------------------------------------------------------------------ passing tests cost nothing and leave nothing
    def test_a_passing_test_leaves_no_watchdog_thread_and_runs_no_watchdog_cleanup(self):
        seen = {}

        class Fine(TimedTestCase):
            def test_ok(self):
                seen["during"] = _watchdogs()
                self.addWatchdogCleanup(lambda: seen.setdefault("ran", []).append(1))

        before_threads = threading.active_count()
        before = _watchdogs()
        result, _ = run_case(Fine, "test_ok")
        self.assertTrue(result.wasSuccessful(), (result.failures, result.errors))
        self.assertEqual(len(seen["during"] - before), 1, "exactly one watchdog while the test runs")
        self.assertEqual(_watchdogs() - before, set())
        self.assertNotIn("ran", seen, "watchdog cleanups are for the deadline path only")
        self.assertEqual(threading.active_count(), before_threads)
        self.assertIsNone(Fine("test_ok")._dl_state)

    def test_the_watchdog_adds_next_to_nothing_to_a_trivial_test(self):
        class Trivial(TimedTestCase):
            def test_pass(self):
                pass

        t0 = time.monotonic()
        for _ in range(200):
            result = unittest.TestResult()
            Trivial("test_pass").run(result)
            self.assertTrue(result.wasSuccessful())
        took = time.monotonic() - t0
        self.assertLess(took, 3.0, "200 trivial TimedTestCase runs took %.2f s" % took)

    def test_ordinary_failures_errors_and_skips_are_reported_untouched(self):
        class Plain(TimedTestCase):
            def test_fail(self):
                self.fail("plain failure")

            def test_error(self):
                raise ValueError("plain error")

            def test_skip(self):
                self.skipTest("plain skip")

            @unittest.skip("decorator skip")
            def test_skipped_by_decorator(self):
                raise AssertionError("must not run")

        before = _watchdogs()
        result, _ = run_case(Plain, "test_fail", "test_error", "test_skip", "test_skipped_by_decorator")
        self.assertEqual([t.id().rsplit(".", 1)[1] for t, _ in result.failures], ["test_fail"])
        self.assertEqual([t.id().rsplit(".", 1)[1] for t, _ in result.errors], ["test_error"])
        self.assertEqual(len(result.skipped), 2)
        self.assertNotIn("TIMED OUT", result.failures[0][1])
        self.assertEqual(_watchdogs() - before, set())

    def test_default_result_when_run_is_called_without_one(self):
        class Fine(TimedTestCase):
            def test_ok(self):
                pass

        result = Fine("test_ok").run()
        self.assertTrue(result.wasSuccessful())
        self.assertEqual(result.testsRun, 1)

    # ------------------------------------------------------------------ cleanups
    def test_cleanups_run_once_newest_first_with_args_and_a_raising_one_does_not_stop_the_rest(self):
        order = []
        late_ran = []

        class Cleanups(TimedTestCase):
            DEADLINE_S = 0.3

            def test_x(self):
                gate = threading.Event()
                self.addWatchdogCleanup(order.append, "first")
                self.addWatchdogCleanup(lambda: (_ for _ in ()).throw(RuntimeError("boom")))
                self.addWatchdogCleanup(lambda a, b=None: order.append((a, b)), 1, b=2)

                def newest():
                    order.append("newest")
                    gate.set()

                self.addWatchdogCleanup(newest)
                gate.wait()
                late = threading.Event()
                self.addWatchdogCleanup(late.set)
                late_ran.append(late.is_set())          # asserted outside: after expiry the test thread's errors are demoted

        result, _ = run_case(Cleanups, "test_x")
        self.assertEqual(order, ["newest", (1, 2), "first"], "newest first, each exactly once")
        self.assertEqual(late_ran, [True], "a cleanup registered after expiry runs immediately, in the caller")
        self.assertEqual(len(result.failures), 1, (result.failures, result.errors))
        text = result.failures[0][1]
        self.assertIn("TIMED OUT after 0.3 s", text)
        self.assertIn("RuntimeError: boom", text)
        self.assertEqual(text.count("watchdog cleanup"), 5)

    def test_addWatchdogCleanup_outside_a_running_test_is_an_error(self):
        class Idle(TimedTestCase):
            def test_x(self):
                pass

        with self.assertRaises(RuntimeError):
            Idle("test_x").addWatchdogCleanup(lambda: None)

    def test_setUp_and_tearDown_are_under_the_deadline_too(self):
        phases = []

        class Hangs(TimedTestCase):
            DEADLINE_S = 0.3

            def setUp(self):
                gate = threading.Event()
                self.addWatchdogCleanup(gate.set)
                phases.append("setUp")
                gate.wait()

            def test_x(self):
                phases.append("body")

        result, took = run_case(Hangs, "test_x")
        self.assertEqual(len(result.failures), 1, (result.failures, result.errors))
        self.assertIn("TIMED OUT after 0.3 s", result.failures[0][1])
        self.assertLess(took, 0.3 + 1.5)
        self.assertEqual(phases[0], "setUp")

    # ------------------------------------------------------------------ deadlines: class, method, nested, decorated
    def test_deadline_resolution_method_beats_class_and_class_decorator_sets_the_default(self):
        @deadline(7)
        class Decorated(TimedTestCase):
            def test_default(self):
                pass

            @deadline(2.5)
            def test_own(self):
                pass

        class Subclass(Decorated):
            pass

        class Plain(TimedTestCase):
            def test_default(self):
                pass

        self.assertEqual(Decorated("test_default").effective_deadline(), 7.0)
        self.assertEqual(Decorated("test_own").effective_deadline(), 2.5)
        self.assertEqual(Subclass("test_default").effective_deadline(), 7.0, "subclasses inherit DEADLINE_S")
        self.assertEqual(Plain("test_default").effective_deadline(), support.DEFAULT_DEADLINE_S)
        self.assertEqual(support.DEFAULT_DEADLINE_S, 60.0)
        for bad in (0, -1, "x"):
            with self.assertRaises(ValueError):
                deadline(bad)

    def test_deadline_is_order_independent_with_other_decorators(self):
        def passthrough(fn):
            @functools.wraps(fn)
            def wrapper(*a, **kw):
                return fn(*a, **kw)
            return wrapper

        class Stacked(TimedTestCase):
            @deadline(3)
            @passthrough
            def test_outer(self):
                pass

            @passthrough
            @deadline(4)
            def test_inner(self):
                pass

            @unittest.skipIf(False, "never")
            @deadline(5)
            def test_skipif_outer(self):
                pass

            @deadline(6)
            @unittest.skipIf(False, "never")
            def test_skipif_inner(self):
                pass

        got = [Stacked(n).effective_deadline() for n in ("test_outer", "test_inner", "test_skipif_outer", "test_skipif_inner")]
        self.assertEqual(got, [3.0, 4.0, 5.0, 6.0])

    def test_a_longer_method_deadline_lets_a_slow_test_pass_and_the_class_default_fails_the_same_wait(self):
        waited = threading.Event()

        class Mixed(TimedTestCase):
            DEADLINE_S = 0.25

            def test_class_default_hangs(self):
                self.addWatchdogCleanup(waited.set)
                waited.wait()                         # until the watchdog fires

            @deadline(30)
            def test_decorated_is_allowed_to_take_longer(self):
                threading.Event().wait(0.5)           # the clock is the thing under test

        result, took = run_case(Mixed, "test_class_default_hangs", "test_decorated_is_allowed_to_take_longer")
        self.assertEqual(result.testsRun, 2)
        self.assertEqual([t.id().rsplit(".", 1)[1] for t, _ in result.failures], ["test_class_default_hangs"])
        self.assertEqual(result.errors, [])

    def test_nested_timed_cases_each_keep_their_own_deadline_and_the_outer_is_unaffected(self):
        outer_state = self._dl_state
        self.assertIsNotNone(outer_state)

        class Inner(TimedTestCase):
            DEADLINE_S = 0.25

            def test_hangs(self):
                gate = threading.Event()
                self.addWatchdogCleanup(gate.set)
                gate.wait()

        result, _ = run_case(Inner, "test_hangs")
        self.assertEqual(len(result.failures), 1)
        self.assertIs(self._dl_state, outer_state, "an inner run must not replace the outer test's watchdog state")
        self.assertFalse(outer_state.expired)
        self.assertEqual(self.effective_deadline(), 30.0)

    # ------------------------------------------------------------------ environment switches
    def test_env_scale_multiplies_and_zero_disables(self):
        class One(TimedTestCase):
            DEADLINE_S = 10

            def test_x(self):
                pass

        with mock.patch.dict(os.environ, {SCALE_ENV: "3"}):
            self.assertEqual(One("test_x").effective_deadline(), 30.0)
        with mock.patch.dict(os.environ, {SCALE_ENV: "0"}):
            self.assertIsNone(One("test_x").effective_deadline())
            before = _watchdogs()
            seen = {}

            class Watched(TimedTestCase):
                def test_x(self):
                    seen["during"] = _watchdogs()

            result, _ = run_case(Watched, "test_x")
            self.assertTrue(result.wasSuccessful())
            self.assertEqual(seen["during"] - before, set(), "scale 0 starts no watchdog")
        with mock.patch.dict(os.environ, {SCALE_ENV: "not-a-number"}):
            self.assertEqual(One("test_x").effective_deadline(), 10.0)
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(SCALE_ENV, None)
            self.assertEqual(One("test_x").effective_deadline(), 10.0)

    def test_DeadlineExceeded_is_a_failure_not_an_error(self):
        self.assertTrue(issubclass(DeadlineExceeded, AssertionError))


class WaitUntilTests(TimedTestCase):
    DEADLINE_S = 30

    def test_returns_the_value_as_soon_as_the_state_is_reached(self):
        flag = threading.Event()
        t = threading.Thread(target=flag.set, daemon=True)
        t.start()
        self.addCleanup(t.join, 5)
        self.assertEqual(wait_until(lambda: flag.is_set() and "ready", 10, "flag"), "ready")

    def test_a_condition_that_never_holds_fails_with_what_it_was_waiting_for(self):
        t0 = time.monotonic()
        with self.assertRaises(AssertionError) as cm:
            wait_until(lambda: False, 0.2, "the moon")
        self.assertIn("timed out after 0.2 s waiting for the moon", str(cm.exception))
        self.assertLess(time.monotonic() - t0, 0.2 + 1.5)

    def test_a_predicate_that_is_already_true_does_not_wait_at_all(self):
        t0 = time.monotonic()
        self.assertEqual(wait_until(lambda: 5, 10), 5)
        self.assertLess(time.monotonic() - t0, 0.5)


class ChildProcessHelperTests(TimedTestCase):
    DEADLINE_S = 60

    def test_isolated_python_argv_really_gives_isolated_bytecode_free_utf8_children(self):
        code = "import sys; f = sys.flags; print(f.isolated, f.dont_write_bytecode, f.utf8_mode)"
        env = child_env(PYTHONUTF8="0", PYTHONDONTWRITEBYTECODE="")          # -I must make these irrelevant
        r = subprocess.run(isolated_python_argv("-c", code), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           env=env, cwd=tempfile.gettempdir(), timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.decode("ascii").split(), ["1", "1", "1"])

    def test_child_env_forces_safe_mode_and_never_forwards_a_real_port(self):
        with mock.patch.dict(os.environ, {"MPY_SAFE_MODE": "0", "MPY_REAL_PORT": "/dev/cu.fake"}):
            env = child_env(EXTRA="1")
        self.assertEqual(env["MPY_SAFE_MODE"], "1")
        self.assertNotIn("MPY_REAL_PORT", env)
        self.assertEqual(env["EXTRA"], "1")

    def test_every_isolated_launch_line_in_the_adversarial_harness_files_passes_B_and_X_utf8(self):
        """Source lint over the files this suite owns (finding #12): under -I the PYTHON* variables are ignored."""
        here = os.path.dirname(os.path.abspath(__file__))
        paths = [os.path.join(here, "support.py")]
        adv = os.path.join(here, "adversarial")
        paths += [os.path.join(adv, n) for n in sorted(os.listdir(adv)) if n.endswith(".py")]
        offenders = []
        for path in paths:
            with open(path, encoding="utf-8") as f:
                lines = f.read().splitlines()
            for i, line in enumerate(lines):
                if '"-I"' in line and "sys.executable" in line:
                    window = " ".join(lines[i:i + 3])
                    if '"-B"' not in window or '"utf8"' not in window:
                        offenders.append((os.path.basename(path), i + 1, line.strip()))
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
