"""Tripwire blind spots and reset handling of tools/hwtest (review3, focus tripwire-and-cleanup).  Fake boards only.

    export MPY_SAFE_MODE=1; python3.13 -B -m unittest tests.adversarial3.test_tripwire_blindspots
"""
from __future__ import annotations

import os
import time
import unittest

from tests.support import TimedTestCase
from tests.adversarial3._hw import HarnessMixin, at_op, pid_alive
from tools.hwtest.tripwire import ProbeFailed, Reading, Tripwire, TripwireTripped, evaluate, TICKS_PERIOD

PROFILES = ["esp32", "rp2", "esp8266", "unix-like", "custom-frozen", "esp32s3-usb"]


def rd(label, ticks, cause=2, soft=5, t=100.0, dt=0.1):
    return Reading(label, ticks, cause, soft, t, t + dt)


class EvaluateBlindSpots(unittest.TestCase):
    """Pure-function checks of tripwire.evaluate with realistic numbers."""

    def test_wrap_at_2_30_is_not_a_false_trip(self):
        prev = rd("a", TICKS_PERIOD - 400, t=100.0)
        cur = rd("b", 600, t=101.0)                      # 1 s later, the counter wrapped
        self.assertEqual(evaluate(prev, cur, prev, 0.0, False), [])

    def test_reset_whose_new_ticks_stay_above_the_previous_reading_is_detected(self):
        """A board that is young (2.6 s of uptime at the previous reading) resets 3 s before the next reading, which is 30 s later.
        The counter reads 2.9 s: higher than before, so 'went backwards' does not fire, and it grew by far LESS than the 30 s of
        wall clock, which only the (missing) lower-bound check can notice.  reset_cause is HARD_RESET both times."""
        prev = rd("before", 2600, t=100.0)
        cur = rd("after", 2900, t=130.0)
        self.assertTrue(evaluate(prev, cur, prev, 90.0, False),
                        "tripwire.evaluate misses a chip reset when post-reset ticks_ms > previous ticks_ms and reset_cause is unchanged")

    def test_a_board_that_resets_at_every_connect_is_detected_when_bridge_start_up_is_fast(self):
        """Port open resets the chip every time (the failure V4 is supposed to avoid).  Bridge start-up + ports.list took only 0.4 s,
        the reset happened at connect, boot to the first probe took 2.9 s.  Baseline and 3 reconnects all read ~2.9 s, cause 2."""
        session_t0 = 1000.0
        base = Reading("baseline", 2900, 2, 5, session_t0 + 3.2, session_t0 + 3.3)          # since_start 3.3 s, ticks 2.9 s
        seq = [base] + [Reading("reconnect %d" % i, 2900 + 10 * i, 2, 5, session_t0 + 3.4 + 1.0 * i, session_t0 + 3.5 + 1.0 * i)
                        for i in (1, 2, 3)]
        prev = None
        all_reasons = []
        for cur in seq:
            all_reasons += evaluate(prev, cur, base, session_t0, False)
            prev = cur
        self.assertTrue(all_reasons, "four consecutive resets-at-connect produced no tripwire reason at all")

    def test_zero_ticks_and_negative_values_do_not_crash(self):
        evaluate(rd("a", 0), rd("b", 0, t=101), rd("a", 0), 0.0, False)
        evaluate(None, rd("a", -5), None, 0.0, False)


class StubClient(object):
    def __init__(self, outs):
        self.outs = list(outs)
        self.reset_errors = []

    def request(self, op, _timeout=None, **kw):
        o = self.outs.pop(0)
        return o if isinstance(o, dict) else {"ok": True, "out": o}

    def mark(self):
        return 0

    def events_of(self, *a, **k):
        return []


class ProbeGarbage(unittest.TestCase):
    def test_garbage_probe_outputs_stop_the_harness(self):
        for out in ["", "@@TRIP", "@@TRIP 5", "@@TRIP a b c", "Traceback\n", "@@TRIP 1.5 2 3", "@@TRIP 1 2"]:
            with self.subTest(out=out):
                t = Tripwire(StubClient([out]))
                with self.assertRaises(ProbeFailed):
                    t.baseline()

    def test_probe_error_stops_the_harness(self):
        t = Tripwire(StubClient([{"ok": False, "error": {"code": "E_TIMEOUT"}}]))
        with self.assertRaises(ProbeFailed):
            t.baseline()

    def test_probe_with_garbage_before_and_two_lines_uses_a_consistent_line(self):
        t = Tripwire(StubClient(["noise @@TRIP 100 1 5\n@@TRIP 99999 1 5\n"]), session_t0=time.monotonic() - 0.1, min_uptime_ms=0)
        r = t.baseline()
        self.assertEqual(r.ticks, 100)


class ResetMatrix(HarnessMixin, TimedTestCase):
    DEADLINE_S = 1500

    def _assert_trip(self, r, label):
        self.assertEqual(r.code, 3, "%s: expected exit 3 (TRIPPED)\n%s" % (label, self.brief(r)))
        self.assertEqual(r.report["outcome"], "TRIPPED", label)
        self.assertTrue(r.left_as_found, "%s: board left dirty" % label)
        self.assertFalse(r.final["running"], label)
        self.assertFalse(pid_alive(r.raw.pid), label)

    # The matrix is generated per profile (see the loop after the class) so that a profile is one test: they can be run, timed and
    # reported separately: test_hard_reset_after_each_phase_<profile>, test_hard_reset_after_the_last_phase_<profile>,
    # test_hard_reset_in_the_middle_of_each_phase_<profile>.
    def _after_each_phase(self, profile):
        for boundary in "ABCD":
            with self.subTest(profile=profile, after=boundary):
                def after_phase(pid, board, boundary=boundary):
                    if pid == boundary:
                        board.hard_reset("adversarial")
                r = self.go(profile, "A,B,C,D,E", hooks={"after_phase": after_phase})
                self._assert_trip(r, "%s after %s" % (profile, boundary))

    def _after_the_last_phase(self, profile):
        def after_phase(pid, board):
            if pid == "E":
                board.hard_reset("adversarial")
        r = self.go(profile, "A,B,C,D,E", hooks={"after_phase": after_phase})
        self._assert_trip(r, profile)

    def _in_the_middle_of_each_phase(self, profile):
        for phase, op, n in [("B", "fs.put", 4), ("C", "run", 2), ("D", "tty.write", 2), ("E", "fs.put", 12)]:
            with self.subTest(profile=profile, phase=phase, op=op, n=n):
                r = self.go(profile, "A,B,C,D,E", hooks=at_op(op, n, lambda b: b.hard_reset("adversarial-mid")))
                self._assert_trip(r, "%s mid %s" % (profile, phase))

    def test_hard_reset_at_every_connect(self):
        """Observation + assertion: a board that resets on every open must trip."""
        r = self.go("esp32", "A", hooks=at_op("connect", 1, lambda b: b.hard_reset("on open")))
        self._assert_trip(r, "reset at first connect")

    def test_reset_cause_equal_and_ticks_forward_after_reset(self):
        """Fake: hard reset that keeps reset_cause and restarts ticks so that they stay above the previous reading."""
        def after_phase(pid, board):
            if pid == "A":
                dev = board.device
                dev.t_power = time.monotonic() - 1.0          # a board that has 'just' rebooted: young but ticks look plausible
        r = self.go("esp32", "A,E", hooks={"after_phase": after_phase})
        self.assertEqual(r.code, 3, self.brief(r))


def _add_matrix_tests():
    for profile in PROFILES:
        tag = profile.replace("-", "_")
        for name, helper, deadline in (("test_hard_reset_after_each_phase_%s", "_after_each_phase", 400),
                                       ("test_hard_reset_after_the_last_phase_%s", "_after_the_last_phase", 120),
                                       ("test_hard_reset_in_the_middle_of_each_phase_%s", "_in_the_middle_of_each_phase", 400)):
            def test(self, helper=helper, profile=profile):
                getattr(self, helper)(profile)
            test.__name__ = name % tag
            setattr(ResetMatrix, test.__name__, test)


_add_matrix_tests()


class UnplugMatrix(HarnessMixin, TimedTestCase):
    DEADLINE_S = 1500

    def test_unplug_after_each_phase_is_safe_and_bounded(self):
        for profile in ("esp32", "rp2", "unix-like", "esp32s3-usb"):
            for boundary in "ABCDE":
                with self.subTest(profile=profile, after=boundary):
                    def after_phase(pid, board, boundary=boundary):
                        if pid == boundary:
                            board.unplug("adversarial")
                    r = self.go(profile, "A,B,C,D,E", hooks={"after_phase": after_phase})
                    self.assertNotEqual(r.code, 0, self.brief(r))
                    self.assertIsNotNone(r.report, "no report written")
                    self.assertLess(r.elapsed, 150, "took %.0f s" % r.elapsed)
                    if not r.left_as_found:                      # unplugged before the cleanup could reach the board: must be reported
                        self.assertTrue(any("scratch" in x for x in r.report["residue"]), self.brief(r))
                    self.assertFalse(pid_alive(r.raw.pid))
                    self.assertFalse(r.final["running"])


class ProfilesAllPhases(HarnessMixin, TimedTestCase):
    DEADLINE_S = 1500

    def test_every_phase_on_every_profile(self):
        failures = []
        for profile in PROFILES:
            with self.subTest(profile=profile):
                r = self.go(profile, "A,B,C,D,E,F", soak=(3, 4))
                if r.code != 0 or not r.left_as_found or pid_alive(r.raw.pid):
                    failures.append("%s: exit %s %s" % (profile, r.code, [(p["id"], p["status"]) for p in r.report["phases"]]))
                self.assertEqual(r.code, 0, self.brief(r))
                self.assertTrue(r.left_as_found)
        self.assertEqual(failures, [])


class ProbeValidator(unittest.TestCase):
    def test_setter_style_calls_are_not_accepted_as_read_only_getters(self):
        from tools.hwtest import confine
        accepted = []
        for code in ["print(__import__('_x').get_counts(), __import__('_x').set_counts(1))",
                     "print(__import__('_x').clear_counts())",
                     "print(__import__('_x').set_counts(5))",
                     "print(__import__('_x').stop_motor_info(1))"]:
            try:
                confine.validate_probe_code(code)
                accepted.append(code)
            except confine.ConfinementError:
                pass
        self.assertEqual(accepted, [], "the 'getter-style' grammar accepts calls that change board state")


if __name__ == "__main__":
    unittest.main()
