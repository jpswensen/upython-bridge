"""Cleanup, signals, backups, refusals and time bounds of tools/hwtest (review3, focus tripwire-and-cleanup).  Fake boards only.

    export MPY_SAFE_MODE=1; python3.13 -B -m unittest tests.adversarial3.test_cleanup_signals
"""
from __future__ import annotations

import os
import random
import signal
import stat
import tempfile
import threading
import time
import unittest
from unittest import mock

from tests.support import TimedTestCase, wait_until
from tests.adversarial3._hw import HarnessMixin, at_op, pid_alive
from tools.hwtest import phases

MAIN_THREAD_ONLY = unittest.skipUnless(threading.current_thread() is threading.main_thread() or True, "")


class SignalGuard(object):
    """Late signals (after run_hw restored the handlers) must not kill the test runner."""

    def setUp(self):
        super().setUp()
        self._old = {}
        if threading.current_thread() is threading.main_thread():
            for name in ("SIGTERM", "SIGHUP"):
                self._old[getattr(signal, name)] = signal.signal(getattr(signal, name), signal.SIG_IGN)
        else:
            self.skipTest("signal tests need the main thread")

    def tearDown(self):
        for sig, h in self._old.items():
            signal.signal(sig, h)
        super().tearDown()


class CleanupResidue(HarnessMixin, TimedTestCase):
    DEADLINE_S = 400

    def _inject_at_put(self, n=3, then=None):
        st = {"puts": 0, "tripped": False}

        def on_send(op, args):
            if op == "fs.put":
                st["puts"] += 1
                if st["puts"] == n:
                    st["tripped"] = True
                    raise RuntimeError("injected failure")
            elif st["tripped"] and then:
                then(op, args)
        return {"on_send": on_send}

    def test_a_failed_scratch_removal_is_reported_as_residue(self):
        def then(op, args):
            if op == "fs.rmtree":
                raise RuntimeError("injected: rmtree failed")
        r = self.go("esp32", "A,B", hooks=self._inject_at_put(3, then))
        self.assertNotEqual(r.code, 0)
        self.assertFalse(r.left_as_found, "precondition: the scratch folder must still be on the board for this repro")
        self.assertTrue(any("scratch" in x for x in r.report["residue"]),
                        "scratch folder left on the board but report residue=%r scratch=%r" % (r.report["residue"], r.report["scratch"]))
        self.assertFalse(pid_alive(r.raw.pid))

    def test_a_failed_backup_verification_is_reported(self):
        def then(op, args):
            if op == "fs.get":
                raise RuntimeError("injected: fs.get failed")
        r = self.go("esp32", "A,B", hooks=self._inject_at_put(3, then))
        self.assertTrue(any("backup" in x for x in r.report["residue"]), r.report["residue"])

    def test_failing_cleanup_steps_still_disconnect_and_end_the_bridge(self):
        with mock.patch.object(phases.Ctx, "remove_scratch", side_effect=RuntimeError("boom 1")), \
                mock.patch.object(phases.Ctx, "verify_backups", side_effect=RuntimeError("boom 2")):
            r = self.go("esp32", "A,B", hooks=self._inject_at_put(3))
        names = [s["name"] for s in r.report["cleanup"]["steps"]]
        self.assertIn("disconnect", names)
        self.assertFalse(pid_alive(r.raw.pid))
        self.assertEqual(r.report["bridge"]["shutdown"], "eof")
        self.assertTrue(r.report["residue"], "failed steps must be visible as residue")

    def test_failing_disconnect_still_ends_the_bridge(self):
        with mock.patch.object(phases.Ctx, "disconnect", side_effect=RuntimeError("boom disconnect")):
            r = self.go("esp32", "A,B", hooks=self._inject_at_put(3))
        self.assertFalse(pid_alive(r.raw.pid))
        self.assertIsNotNone(r.report)

    def test_bridge_killed_mid_upload_reports_the_scratch_folder_and_exits_nonzero(self):
        box = {}
        hooks = at_op("fs.put", 3, lambda b: os.kill(box["raw"].pid, signal.SIGKILL))
        r = self.go("esp32", "A,B", hooks=hooks, spawn_wrap=lambda c: box.__setitem__("raw", c))
        self.assertNotEqual(r.code, 0, self.brief(r))
        self.assertIsNotNone(r.report)
        self.assertLess(r.elapsed, 120)
        self.assertTrue(any("scratch" in x for x in r.report["residue"]), r.report["residue"])
        self.assertFalse(pid_alive(r.raw.pid))

    def test_bridge_killed_while_a_harness_program_loops_reports_the_running_program(self):
        box = {}
        hooks = at_op("stop", 1, lambda b: os.kill(box["raw"].pid, signal.SIGKILL))
        r = self.go("esp32", "A,C", hooks=hooks, spawn_wrap=lambda c: box.__setitem__("raw", c))
        self.assertNotEqual(r.code, 0, self.brief(r))
        self.assertTrue(r.final["running"], "precondition: the loop keeps running on the fake board without the bridge")
        self.assertTrue(any("running" in x for x in r.report["residue"]), r.report["residue"])

    def test_unplug_in_the_middle_of_phase_b_is_reported(self):
        r = self.go("esp32", "A,B", hooks=at_op("fs.put", 4, lambda b: b.unplug("adv")))
        self.assertNotEqual(r.code, 0, self.brief(r))
        if not r.left_as_found:
            self.assertTrue(any("scratch" in x for x in r.report["residue"]), r.report["residue"])
        self.assertLess(r.elapsed, 150)
        self.assertFalse(pid_alive(r.raw.pid))

    def test_unwritable_report_folder_does_not_end_in_exit_0(self):
        with tempfile.NamedTemporaryFile() as f:
            r = self.go("esp32", "A", extra=["--report", os.path.join(f.name, "sub")])    # a path below a regular file
        self.assertNotEqual(r.code, 0, "the run exits 0 although no report could be written:\n" + r.text[-600:])

    def test_extra_probes_that_fail_on_the_board_do_not_fail_the_run(self):
        cfg = {"backup_files": [], "probe_modules": ["no_such_mod_xyz"], "extra_probes": [
            {"name": "bad", "code": "print(__import__('no_such_mod_xyz').get_counts())", "before_after": True},
            {"name": "alsobad", "code": "print(len(1))", "before_after": True}]}
        r = self.go("esp32", "A,B,C", cfg=cfg)
        self.assertEqual(r.code, 0, self.brief(r))
        self.assertTrue(r.left_as_found)


class BackupChecks(HarnessMixin, TimedTestCase):
    DEADLINE_S = 300

    def _after(self, pid_wanted, fn):
        def after_phase(pid, board):
            if pid == pid_wanted:
                fn(board)
        return {"after_phase": after_phase}

    def _assert_flagged(self, r, what):
        self.assertNotEqual(r.code, 0, "%s: exit 0\n%s" % (what, self.brief(r)))
        self.assertTrue(any("backup" in x for x in r.report["residue"]), "%s: %r" % (what, r.report["residue"]))

    def test_boot_py_changed_after_the_last_phase_is_flagged(self):
        r = self.go("esp32", "A,B", hooks=self._after("B", lambda b: b.write_file("/boot.py", b"# changed\n")))
        self._assert_flagged(r, "boot.py rewritten")

    def test_boot_py_same_size_different_bytes_is_flagged(self):
        def mutate(b):
            data = bytearray(b.read_file("/boot.py"))
            data[-1] ^= 0x01
            b.write_file("/boot.py", bytes(data))
        r = self.go("esp32", "A,B", hooks=self._after("B", mutate))
        self._assert_flagged(r, "boot.py 1 bit flipped")

    def test_boot_py_deleted_is_flagged(self):
        r = self.go("esp32", "A,B", hooks=self._after("B", lambda b: os.remove(b.host_path("/boot.py"))))
        self._assert_flagged(r, "boot.py deleted")

    def test_missing_boot_py_then_created_is_flagged(self):
        def on_board(b):
            os.remove(b.host_path("/boot.py"))
        r = self.go("esp32", "A,B", hooks=dict(self._after("B", lambda b: b.write_file("/boot.py", b"x=1\n")), on_board=on_board))
        self.assertIn("absent", [x["status"] for x in r.report["backups"]])
        self._assert_flagged(r, "boot.py absent at start, created later")

    def test_missing_boot_py_and_unchanged_passes(self):
        def on_board(b):
            os.remove(b.host_path("/boot.py"))
        r = self.go("esp32", "A,B", hooks={"on_board": on_board})
        self.assertEqual(r.code, 0, self.brief(r))

    @unittest.skipIf(not hasattr(os, "geteuid") or os.geteuid() == 0, "needs a non-root POSIX user")
    def test_unwritable_backup_dir_refuses_before_the_first_write(self):
        d = tempfile.mkdtemp(prefix="adv3-ro ")
        self.addCleanup(lambda: (os.chmod(d, stat.S_IRWXU), os.rmdir(d)))
        os.chmod(d, stat.S_IRUSR | stat.S_IXUSR)
        r = self.go("esp32", "A,B", backup_dir=os.path.join(d, "backup"))
        self.assertEqual(r.code, 4, self.brief(r))
        self.assertFalse(r.report["scratch"]["created"])
        self.assertTrue(r.left_as_found)
        self.assertNotIn("fs.mkdir", {e["op"] for e in r.report["ops"]["log"]})

    def test_backups_are_taken_before_the_first_write_even_for_phase_e_alone(self):
        r = self.go("esp32", "A,E")
        self.assertEqual(r.code, 0, self.brief(r))
        ops = [e["op"] for e in r.report["ops"]["log"]]
        self.assertLess(ops.index("fs.get"), ops.index("fs.mkdir"))


class PhaseARefusal(HarnessMixin, TimedTestCase):
    DEADLINE_S = 200

    def test_silent_running_program_is_left_completely_alone(self):
        box = {}

        def on_board(b):
            b.write_file("/main.py", b"import time\nwhile True:\n    time.sleep(1)\n")
            b.soft_reset("adv: start the silent program")
            wait_until(lambda: b.program_running, 15, "silent main.py to run")
            box["mark"] = len(b.events)
        r = self.go("esp32", "A,B,C,D,E", hooks={"on_board": on_board})
        names = [e["ev"] for e in list(r.board.events)[box["mark"]:]]
        self.assertEqual(r.code, 4, self.brief(r) + "\nboard events: %r" % names)
        for bad in ("interrupt", "soft_reset", "hard_reset", "power_on", "exec", "run", "raw_repl"):
            self.assertNotIn(bad, names, "board saw %r: %r" % (bad, names))
        self.assertTrue(r.final["running"], "the program that was running must still run")
        self.assertEqual([p["id"] for p in r.report["phases"]], ["A"])
        self.assertFalse(pid_alive(r.raw.pid))

    def test_phase_b_never_touches_a_board_that_runs_a_program_after_a_pass_in_a(self):
        def after_phase(pid, board):
            if pid == "A":
                board.write_file("/main.py", b"import time\nwhile True:\n    time.sleep(1)\n")
                board.soft_reset("adv: a program starts between phases")
                wait_until(lambda: board.program_running, 15, "program to run")
        r = self.go("esp32", "A,B", hooks={"after_phase": after_phase})
        self.assertIn(r.code, (3, 4), self.brief(r))
        self.assertNotIn("fs.mkdir", {e["op"] for e in r.report["ops"]["log"]})
        self.assertNotIn("fs.put", {e["op"] for e in r.report["ops"]["log"]})


class SignalSweep(SignalGuard, HarnessMixin, TimedTestCase):
    DEADLINE_S = 540

    def _signal_hook(self, op_name, n, sig, extra=None):
        return at_op(op_name, n, lambda b: os.kill(os.getpid(), sig), extra)

    def _assert_clean_interrupt(self, r, label):
        self.assertEqual(r.code, 130, "%s: %s" % (label, self.brief(r)))
        self.assertIsNotNone(r.report, label)
        self.assertEqual(r.report["outcome"], "INTERRUPTED", label)
        self.assertTrue(r.left_as_found, "%s: board left dirty; residue=%r" % (label, r.report["residue"]))
        self.assertFalse(r.final["running"], "%s: a program still runs" % label)
        self.assertFalse(pid_alive(r.raw.pid), label)
        self.assertEqual(r.report["residue"], [], label)

    def test_sigterm_and_sighup_at_many_protocol_moments(self):
        points = [("connect", 3, "SIGTERM"), ("disconnect", 2, "SIGHUP"), ("exec", 9, "SIGTERM"), ("fs.mkdir", 1, "SIGHUP"),
                  ("fs.put", 3, "SIGTERM"), ("fs.put", 9, "SIGHUP"), ("fs.get", 8, "SIGTERM"), ("fs.mv", 1, "SIGHUP"),
                  ("fs.manifest", 2, "SIGTERM"), ("stop", 1, "SIGHUP"), ("fs.rmtree", 1, "SIGTERM"), ("run", 1, "SIGHUP"),
                  ("run", 3, "SIGTERM"), ("tty.write", 1, "SIGHUP"), ("stop", 2, "SIGTERM"), ("repl.attach", 1, "SIGHUP"),
                  ("fs.put", 60, "SIGTERM"), ("fs.rm", 5, "SIGHUP")]
        for op, n, sname in points:
            with self.subTest(op=op, n=n, sig=sname):
                r = self.go("esp32", "A,B,C,D,E", hooks=self._signal_hook(op, n, getattr(signal, sname)))
                self._assert_clean_interrupt(r, "%s #%d %s" % (op, n, sname))

    def test_signals_at_random_times(self):
        rng = random.Random(20261013)
        for i in range(8):
            delay = rng.uniform(0.3, 11.0)
            sig = (signal.SIGTERM, signal.SIGHUP)[i % 2]
            with self.subTest(i=i, delay=round(delay, 2), sig=int(sig)):
                timer = threading.Timer(delay, os.kill, (os.getpid(), sig))
                timer.daemon = True
                timer.start()
                try:
                    r = self.go("esp32", "A,B,C,D,E")
                finally:
                    timer.cancel()
                if r.code == 0:
                    self.assertTrue(r.left_as_found)
                    continue
                self._assert_clean_interrupt(r, "random %.2fs" % delay)

    def test_a_second_signal_during_the_cleanup_leaves_nothing_unreported(self):
        for k in (1, 2, 3, 4, 6):
            with self.subTest(second_signal_at_send=k):
                st = {"first": False, "after": 0}
                hooks = at_op("fs.put", 3, lambda b: (st.__setitem__("first", True), os.kill(os.getpid(), signal.SIGTERM)))
                inner = hooks["on_send"]

                def on_send(op, args, inner=inner, st=st, k=k):
                    if st["first"]:
                        st["after"] += 1
                        if st["after"] == k:
                            os.kill(os.getpid(), signal.SIGTERM)
                    inner(op, args)
                hooks["on_send"] = on_send
                r = self.go("esp32", "A,B", hooks=hooks)
                self.assertIsNotNone(r.report)
                self.assertFalse(pid_alive(r.raw.pid))
                if not r.left_as_found:
                    self.assertTrue(any("scratch" in x for x in r.report["residue"]),
                                    "scratch left on the board but not in residue=%r" % (r.report["residue"],))


class TimeBounds(SignalGuard, HarnessMixin, TimedTestCase):
    DEADLINE_S = 500

    def _bounded(self, hooks, spawn_wrap, cap=200.0, undo=None):
        box = {}
        done = threading.Event()

        def work():
            try:
                box["r"] = self.go("esp32", "A,B,C,D,E", hooks=hooks, spawn_wrap=spawn_wrap)
            except BaseException as exc:                     # noqa: BLE001
                box["exc"] = exc
            finally:
                done.set()
        t = threading.Thread(target=work, name="harness-under-test", daemon=True)
        t0 = time.monotonic()
        t.start()
        finished = done.wait(cap)
        elapsed = time.monotonic() - t0
        if undo:
            undo()
        t.join(60)
        return finished, elapsed, box

    def test_a_stopped_bridge_cannot_hang_the_harness_for_ever(self):
        holder = {}

        def after_phase(pid, board):
            if pid == "A":
                os.kill(holder["raw"].pid, signal.SIGSTOP)
        finished, elapsed, box = self._bounded({"after_phase": after_phase}, lambda c: holder.__setitem__("raw", c),
                                               undo=lambda: holder["raw"].proc.kill() if holder.get("raw") else None)
        self.assertTrue(finished, "the harness was still blocked %.0f s after the bridge stopped answering (no overall deadline)" % elapsed)

    def test_a_mute_board_cannot_hang_the_harness_for_ever(self):
        def after_phase(pid, board):
            if pid == "A":
                board.faults.add("silent")
        finished, elapsed, box = self._bounded({"after_phase": after_phase}, None)
        self.assertTrue(finished, "the harness was still blocked %.0f s after the board went mute (no overall deadline)" % elapsed)
        r = box.get("r")
        self.assertIsNotNone(r)
        self.assertNotEqual(r.code, 0)


class SetupFailures(HarnessMixin, TimedTestCase):
    DEADLINE_S = 120

    def test_failure_between_spawn_and_client_creation_does_not_leak_the_bridge(self):
        box = {}
        with mock.patch("tools.hwtest.run_hw.confine.ProgramStore", side_effect=OSError("disk full")):
            r = self.go("esp32", "A", spawn_wrap=lambda c: box.__setitem__("raw", c))
        try:
            self.assertNotEqual(r.code, 0)
            self.assertFalse(pid_alive(box["raw"].pid), "the bridge process spawned by the harness is still running after main() returned")
        finally:
            box["raw"].kill()


if __name__ == "__main__":
    unittest.main()
