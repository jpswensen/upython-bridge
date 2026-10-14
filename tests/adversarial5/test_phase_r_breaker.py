"""adversarial5 - independent attack on phase R (reset tiers) of tools/hwtest.  FAKE boards, stubs and --dry-run only.

    export MPY_SAFE_MODE=1; python3.13 -B -m unittest tests.adversarial5.test_phase_r_breaker

Nothing here opens a real port: every harness run is ``--fake <profile>`` with an environment dict handed to ``run_hw.main`` (the
real os.environ is never changed), the real-device cases are ``--dry-run`` with spawn / Popen / lsof patched to raise.
The review findings of the first round were reproduced here as ``expectedFailure`` tests; they were fixed and the markers removed
(2026-10-13, phase-r-fixer), so they are permanent regression tests now.
"""
from __future__ import annotations

import contextlib
import io
import itertools
import json
import os
import re
import signal
import threading
import unittest
from unittest import mock

from tests.support import TimedTestCase
from tests.test_hwtest import ROOT, SCRATCH, TmpMixin, run_main
from tests.test_hwtest_reset import (CAP, ENV_OK, HARD, MACHINE, SOFT, RecInner, ResetRunMixin, cap_result, resets_of, sent_resets)
from tools.hwtest import confine, phases, run_hw
from tools.hwtest.confine import ConfinedClient, ConfinementError, Policy, ResetGate
from tools.hwtest.tripwire import TRIP_PROBE

RESET_OPS = (CAP, SOFT, MACHINE, HARD)


def _boom(*a, **k):
    raise AssertionError("must not be called: %r %r" % (a, k))


# ===================================================================================================== 1. gating matrix
class GateMatrixTests(TmpMixin, TimedTestCase):
    DEADLINE_S = 400

    PHASES = ["A,R", "a,r", "R,R", " R", "A, R ", "r", "A,,R", "A;R", "RR", "A,B,C,D,E,F,R", "A,R,", "A,X", "", "A", "A,B,C,D,E,F",
              "R,A", "A,B,C,D,E", ",", "\tR", "A,r,F"]
    NS = [None, "0", "1", "3", "5", "6", "-1", "5.0", "5 ", " 5", "+5", "abc", "", "99999999999999999999", "1_0", "05", "0x5",
          "٣", "1e0", "True"]
    ENVS = [None, "1", "1 ", " 1", "true", "0", "", "01", "yes", "１", "1\n", "11"]

    def dry(self, phases_, n, envv, cfg_path=None):
        base = self.tmpdir()
        argv = ["--fake", "esp32", "--dry-run", "--phases", phases_, "--report", base, "--backup-dir", base]
        if n is not None:
            argv.append("--allow-resets=%s" % n)
        if cfg_path:
            argv += ["--config", cfg_path]
        env = {"MPY_SAFE_MODE": "1"}
        if envv is not None:
            env["MPY_ALLOW_RESETS"] = envv
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code, text = run_main(argv, env=env)
        return code, text

    @staticmethod
    def parse_n(n):
        if n is None:
            return 0
        try:
            return int(n)
        except ValueError:
            return None

    def check(self, phases_, n, envv, code, text, cap="none"):
        toks = [p.strip().upper() for p in phases_.split(",") if p.strip()]
        label = "phases=%r n=%r env=%r cap=%r -> exit %s" % (phases_, n, envv, cap, code)
        if any(t not in list("ABCDEFR") for t in toks):
            self.assertEqual(code, 2, label)
            return
        nn = self.parse_n(n)
        has_r = "R" in toks
        if nn is None:
            self.assertEqual(code, 2, label)
            self.assertNotIn("RESETS:", text, label)
            return
        if not has_r:
            self.assertNotIn("RESETS:", text, label)
            self.assertEqual(code, 2 if nn else 0, label)
            return
        forbidden = cap in (False, 0) and cap != "none"
        bad_cap = cap not in ("none", True, False, 0, 1, 2, 3, 4, 5)
        if bad_cap or forbidden or not 1 <= nn <= 5 or envv != "1":
            self.assertEqual(code, 2, label)
            self.assertNotIn("RESETS:", text, label)
            self.assertNotIn("chip resets budget", text, label)
            return
        want = nn if (cap == "none" or cap is True) else min(nn, int(cap))
        self.assertEqual(code, 0, label + "\n" + text[-600:])
        self.assertIn("chip resets budget %d" % want, text, label)
        self.assertTrue(1 <= want <= 5)

    def test_cli_matrix_phases_x_n_x_env_never_accepts_without_every_gate_and_spawns_nothing(self):
        accepted = 0
        with mock.patch("tools.fakeboard.FakeBoard", side_effect=AssertionError("FakeBoard started by a dry run")), \
                mock.patch.object(run_hw, "HwBridgeClient", side_effect=AssertionError("bridge spawned by a dry run")), \
                mock.patch("subprocess.Popen", side_effect=AssertionError("process spawned by a dry run")), \
                mock.patch.object(run_hw, "lsof_holders", side_effect=AssertionError("lsof run")):
            for phases_, n, envv in itertools.product(self.PHASES, self.NS, self.ENVS):
                code, text = self.dry(phases_, n, envv)
                self.check(phases_, n, envv, code, text)
                accepted += "chip resets budget" in text
        self.assertGreater(accepted, 0, "the matrix never produced an accepted combination: the oracle is blind")

    def test_config_allow_resets_matrix_can_only_lower(self):
        d = self.tmpdir()
        with mock.patch("tools.fakeboard.FakeBoard", side_effect=AssertionError), \
                mock.patch.object(run_hw, "HwBridgeClient", side_effect=AssertionError), \
                mock.patch("subprocess.Popen", side_effect=AssertionError):
            for i, cap in enumerate([True, False, 0, 1, 2, 5, 6, -1, 5.0, "5", None, [], {}, "true"]):
                path = os.path.join(d, "c%d.json" % i)
                with open(path, "w") as f:
                    json.dump({"allow_resets": cap}, f)
                for phases_, n, envv in (("A,R", "5", "1"), ("A,R", "3", "1"), ("A,R", "1", "1"), ("A", None, "1"), ("A,R", "5", "1 "),
                                         ("A,R", "6", "1"), ("A,R", "0", "1")):
                    code, text = self.dry(phases_, n, envv, path)
                    ok_cap = cap if (isinstance(cap, (bool, int)) and (isinstance(cap, bool) or 0 <= cap <= 5)) else "bad"
                    if ok_cap is True:
                        ok_cap = True
                    if "R" not in phases_:
                        self.assertEqual(code, 0 if ok_cap != "bad" else 2, (cap, phases_, n))
                        continue
                    self.check(phases_, n, envv, code, text, cap=ok_cap if ok_cap != "bad" else 99)

    def test_option_abbreviations_and_odd_spellings_never_stand_in_for_the_gate_flag(self):
        base = self.tmpdir()
        common = ["--fake", "esp32", "--dry-run", "--phases", "A,R", "--report", base, "--backup-dir", base]
        env = {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": "1"}
        with mock.patch("tools.fakeboard.FakeBoard", side_effect=AssertionError), mock.patch.object(run_hw, "HwBridgeClient", side_effect=AssertionError):
            for spelling in (["--allow-res", "5"], ["--allow-r", "5"], ["--allow-resets5"], ["--allow_resets", "5"], ["--ALLOW-RESETS", "5"],
                             ["-allow-resets", "5"], ["--allow-resets"], ["--allow-resets", "5", "--allow-resets", "0"],
                             ["--allow-resets", "0", "--allow-resets", "6"]):
                with contextlib.redirect_stderr(io.StringIO()):
                    code, text = run_main(common + spelling, env=env)
                self.assertEqual(code, 2, (spelling, text[-300:]))
                self.assertNotIn("chip resets budget", text)
            with contextlib.redirect_stderr(io.StringIO()):
                code, text = run_main(common + ["--allow-resets", "0", "--allow-resets", "4"], env=env)      # (last one wins, in range)
            self.assertEqual(code, 0)
            self.assertIn("chip resets budget 4", text)

    def test_real_device_dry_run_with_every_gate_spawns_opens_and_resets_nothing(self):
        port = "/dev/cu.usbserial-0001"
        env = {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": "1", "MPY_REAL_PORT": port}
        base = self.tmpdir()
        opened = []
        real_open = os.open

        def spy(path, *a, **k):
            if isinstance(path, str) and path.startswith("/dev/"):
                opened.append(path)
            return real_open(path, *a, **k)

        out = io.StringIO()
        with mock.patch("subprocess.Popen", side_effect=AssertionError("spawn")), mock.patch("subprocess.run", side_effect=AssertionError("run")), \
                mock.patch.object(run_hw, "HwBridgeClient", side_effect=AssertionError("bridge")), \
                mock.patch("tools.fakeboard.FakeBoard", side_effect=AssertionError("fake")), mock.patch("os.open", spy):
            code = run_hw.main(["--port", port, "--allow-real-port", "--phases", "A,R", "--allow-resets", "5", "--dry-run", "--report", base,
                                "--backup-dir", base], spawn=_boom, environ=env, stdout=out, lsof=_boom)
        self.assertEqual(code, 0, out.getvalue())
        self.assertIn("chip resets budget 5", out.getvalue())
        self.assertEqual(opened, [])
        self.assertEqual(os.listdir(base), [], "a dry run writes nothing")


# ===================================================================================================== 2. the gate and the policy
class GateUnitTests(TmpMixin, TimedTestCase):
    DEADLINE_S = 120

    def build(self, budget=2, arm=True, cap=None):
        tmp = self.tmpdir()
        self.gate = ResetGate(budget)
        self.policy = Policy(SCRATCH, "socket://127.0.0.1:9", backup_remote=["/boot.py"], local_read_roots=[tmp], local_write_roots=[tmp],
                             shadow_names=["acme"], probe_codes=[TRIP_PROBE], reset_gate=self.gate)
        self.inner = RecInner(self.gate)
        if cap is not None:
            self.inner.next_cap = cap
        self.client = ConfinedClient(self.inner, self.policy)
        if arm:
            self.gate.arm()
        return self.client

    def resets_sent(self):
        return [(op, a) for op, a in self.inner.sent if op in (SOFT, MACHINE, HARD)]

    def refused(self, op, **args):
        n = len(self.inner.sent)
        used = (self.gate.chip_used, self.gate.soft_used)
        with self.assertRaises(ConfinementError, msg="%s %r" % (op, args)):
            self.client.send(op, **args)
        self.assertEqual(len(self.inner.sent), n, "a refused request must not reach the bridge: %s %r" % (op, args))
        self.assertEqual((self.gate.chip_used, self.gate.soft_used), used, "a refused request must not be counted")

    def test_threads_racing_for_a_chip_reset_get_exactly_one(self):
        for budget in (1, 5):
            c = self.build(budget)
            c.call(CAP)
            barrier = threading.Barrier(24)
            won, lost, boom = [], [], []

            def worker(i):
                op, args = [(MACHINE, {"confirmed": True}), (HARD, {"confirmed": True, "verify": False}), (SOFT, {})][i % 3]
                barrier.wait(5.0)
                try:
                    c.send(op, **args)
                    won.append(op)
                except ConfinementError:
                    lost.append(op)
                except BaseException as exc:                      # noqa: BLE001
                    boom.append(exc)

            ts = [threading.Thread(target=worker, args=(i,)) for i in range(24)]
            for t in ts:
                t.start()
            for t in ts:
                t.join(10.0)
            self.assertEqual(boom, [])
            self.assertEqual(len(won), 1, "one reset in flight at a time (budget %d): %r" % (budget, won))
            self.assertEqual(len(self.resets_sent()), 1)
            self.assertLessEqual(self.gate.chip_used, 1)

    def test_after_errors_and_recoveries_the_budget_is_never_exceeded_whatever_the_retry_pattern(self):
        for budget in range(1, 6):
            c = self.build(budget)
            c.call(CAP)
            sent = 0
            for attempt in range(40):
                op, args = [(MACHINE, {"confirmed": True}), (SOFT, {}), (MACHINE, {"confirmed": True}),
                            (HARD, {"confirmed": True, "verify": attempt % 2 == 0})][attempt % 4]
                try:
                    c.send(op, **args)
                    sent += 1
                except ConfinementError:
                    pass
                else:
                    # a duplicate right away (same message, no recovery in between) is always refused
                    self.refused(op, **args)
                self.gate.recovered()                             # (the harness declares recovery only after a good probe)
                if attempt % 3 == 0:
                    c.call(CAP)                                   # a fresh capability read lets hard through again
            chips = [x for x in self.resets_sent() if x[0] in confine.CHIP_RESET_OPS]
            self.assertLessEqual(len(chips), budget, "budget %d" % budget)
            self.assertLessEqual(len([x for x in self.resets_sent() if x[0] == SOFT]), 1)

    def test_argument_shapes_beyond_the_allowlist_are_refused_and_not_counted(self):
        c = self.build(5)
        c.call(CAP)
        extra = [{"force": True}, {"interrupt": True}, {"method": "rts-pulse"}, {"learned": "verified"}, {"x": 1}, {"background": True},
                 {"timeoutMs": 10}, {"force": False}, {"method": None}]
        for e in extra:
            self.refused(SOFT, **e)
            self.refused(MACHINE, confirmed=True, **e)
            self.refused(HARD, confirmed=True, verify=False, **e)
            self.refused(HARD, confirmed=True, verify=True, **e)
        self.refused(SOFT, confirmed=True)
        self.refused(MACHINE, verify=True, confirmed=True)
        for conf in (1, "true", "True", None, 0, False, [True], {"a": 1}, 1.0):
            self.refused(MACHINE, confirmed=conf)
            self.refused(HARD, confirmed=conf, verify=False)
        self.refused(MACHINE)
        self.refused(HARD, confirmed=True)
        self.refused(HARD, verify=True)
        for ver in (1, 0, "yes", "false", None, [], 1.0):
            self.refused(HARD, confirmed=True, verify=ver)
        for learned in ("verified", "likely", True, 1, ["failed"], {"state": "verified"}):
            self.refused(CAP, learned=learned)
        for e in ({"force": True}, {"method": "x"}, {"confirmed": True}, {"verify": True}):
            self.refused(CAP, **e)
        self.assertEqual(self.resets_sent(), [])
        for ok_args in ({}, {"learned": None}, {"learned": "failed"}):
            n = len(self.inner.sent)
            c.send(CAP, **ok_args)
            self.assertEqual(self.inner.sent[n][1], {}, "learned is accepted as null / 'failed' and never forwarded")

    def test_odd_op_names_are_refused(self):
        c = self.build(5)
        c.call(CAP)
        for op in ("reset", "reset.", "reset.hard ", " reset.hard", "Reset.hard", "RESET.MACHINE", "reset.hard\x00", "reset\x00.machine",
                   "reset.machine.extra", "reset_machine", "machine.reset", "board.reset", "repl.reset", "reboot", "restart", "soft_reset",
                   "reset.force", "resets", "reset/hard", "рeset.hard", "run.reset", "exec.reset", ""):
            self.refused(op, confirmed=True)
        for op in (5, None, b"reset.hard", ["reset.hard"]):
            n = len(self.inner.sent)
            with self.assertRaises((ConfinementError, TypeError, AttributeError)):
                self.client.send(op, confirmed=True)
            self.assertEqual(len(self.inner.sent), n)

    def test_every_bridge_op_is_allowlisted_by_name_or_refused_in_every_gate_state(self):
        with open(os.path.join(ROOT, "bridge", "server.py"), encoding="utf-8") as f:
            src = f.read()
        ops = set(re.findall(r'^\s+"([a-z][a-z_.]*)": \("op_', src, re.M))
        self.assertIn("reset.hard", ops)
        self.assertGreater(len(ops), 25, ops)
        unknown = sorted(ops - set(confine.OP_CLASSES) - set(confine.RESET_OP_CLASSES))
        self.assertTrue(unknown, "expected some bridge ops outside the harness allowlist")
        for state in ("armed", "unarmed", "aborted", "nogate"):
            c = self.build(5, arm=state in ("armed", "aborted"))
            if state == "aborted":
                self.gate.abort("x")
            if state == "nogate":
                self.policy.reset_gate = None
            for op in unknown:
                self.refused(op) if state != "nogate" else self._refused_nogate(c, op)

    def _refused_nogate(self, c, op):
        with self.assertRaises(ConfinementError, msg=op):
            c.send(op)

    def test_hostile_capability_results_never_unlock_a_hard_or_machine_reset(self):
        hard_bad = [
            cap_result("verified", "none"), cap_result("verified", None), cap_result("verified", "RTS-PULSE"), cap_result("verified", "rts-pulse "),
            cap_result("Verified", "rts-pulse"), cap_result("unlikely", "rts-pulse"), cap_result("unknown", "rts-pulse"),
            cap_result("failed", "usb-jtag"), cap_result(["verified"], "rts-pulse"), cap_result(True, "rts-pulse"),
            cap_result(None, "rts-pulse"), cap_result("likely", ["rts-pulse"]),
            dict(cap_result(), hard="verified"), dict(cap_result(), hard=None), dict(cap_result(), hard=[]), dict(cap_result(), hard=5),
            dict(cap_result(), hard={}), {k: v for k, v in cap_result().items() if k != "hard"},
        ]
        for cap in hard_bad:
            c = self.build(5, cap=cap)
            c.call(CAP)
            self.refused(HARD, confirmed=True, verify=True)
            self.refused(HARD, confirmed=True, verify=False)
        mach_bad = [cap_result(machine=False), cap_result(machine=1), cap_result(machine="true"), cap_result(machine=None),
                    dict(cap_result(), machine="available"), dict(cap_result(), machine={"available": "yes"}), dict(cap_result(), machine=None),
                    {k: v for k, v in cap_result().items() if k != "machine"}]
        for cap in mach_bad:
            c = self.build(5, cap=cap)
            c.call(CAP)
            self.refused(MACHINE, confirmed=True)

    def test_a_failed_capability_read_does_not_refresh_the_gate_and_a_stale_read_cannot_unlock_hard_after_a_chip_reset(self):
        c = self.build(3)
        c.call(CAP)
        c.call(MACHINE, confirmed=True)
        self.gate.recovered()
        self.refused(HARD, confirmed=True, verify=False)                      # no re-read yet
        self.inner.next_cap = {"ok": False, "error": {"code": "E_BUSY"}}
        c.request(CAP)
        self.refused(HARD, confirmed=True, verify=False)                      # a failed read is not a read
        self.inner.next_cap = cap_result("unlikely")
        c.call(CAP)
        self.refused(HARD, confirmed=True, verify=False)
        self.inner.next_cap = cap_result("likely")
        c.call(CAP)
        c.call(HARD, confirmed=True, verify=False)

    def test_capability_requested_before_a_chip_reset_and_answered_after_it_is_a_stale_read(self):
        """FIXED (finding 3): a reset.capability answer that lands AFTER a chip reset was reserved must not count as 'read after the
        last chip reset' for a capability whose request left BEFORE it (the mark is taken when the request leaves)."""
        c = self.build(3)
        c.call(CAP)
        rid_cap = c.send(CAP)                                                 # request leaves while chip_used == 0 ...
        c.call(MACHINE, confirmed=True)                                       # ... a chip reset is reserved ...
        self.gate.recovered()
        c.result(rid_cap)                                                     # ... and only now does the old answer arrive
        with self.assertRaises(ConfinementError):
            c.send(HARD, confirmed=True, verify=False)
        c.call(CAP)                                                           # a read that left after the reset does unlock it
        c.send(HARD, confirmed=True, verify=False)

    def test_an_older_capability_answer_never_replaces_a_newer_one(self):
        c = self.build(3)
        c.call(CAP)
        old = c.send(CAP)                                                     # leaves at mark 0 and will say "unlikely"
        self.inner.responses[old] = dict(cap_result("unlikely"), id=old)
        c.call(MACHINE, confirmed=True)
        self.gate.recovered()
        c.call(CAP)                                                           # leaves at mark 1: "likely"
        c.result(old)                                                         # the stale answer arrives last
        self.assertEqual(self.gate.hard_state(), "likely")
        c.send(HARD, confirmed=True, verify=False)

    def test_a_hard_reset_with_verify_costs_two_units_because_the_bridge_may_pulse_twice(self):
        self.assertEqual(confine.HARD_VERIFY_PULSES, 2)
        self.assertEqual([confine.chip_cost(op, a) for op, a in ((MACHINE, {"confirmed": True}), (HARD, {"confirmed": True, "verify": False}),
                                                                  (HARD, {"confirmed": True, "verify": True}), (SOFT, {}), (CAP, {}), ("identity", {}))],
                         [1, 1, 2, 0, 0, 0])
        for budget in range(1, 6):
            c = self.build(budget)
            c.call(CAP)
            if budget == 1:
                self.refused(HARD, confirmed=True, verify=True)               # 2 units never fit into 1
                self.assertEqual(self.gate.chip_used, 0)
                continue
            c.send(HARD, confirmed=True, verify=True)
            self.assertEqual(self.gate.chip_used, 2)
            self.assertEqual(self.gate.ledger[-1]["cost"], 2)
            self.gate.recovered()
            c.call(CAP)
            for _ in range(budget - 2):
                c.send(MACHINE, confirmed=True)
                self.gate.recovered()
            self.refused(MACHINE, confirmed=True)
            self.refused(HARD, confirmed=True, verify=True)
            self.refused(HARD, confirmed=True, verify=False)
            self.assertEqual(self.gate.chip_used, budget)
        # one unit left: a plain request fits, the verification does not
        c = self.build(3)
        c.call(CAP)
        for _ in range(2):
            c.send(MACHINE, confirmed=True)
            self.gate.recovered()
        c.call(CAP)
        self.refused(HARD, confirmed=True, verify=True)
        c.send(HARD, confirmed=True, verify=False)
        self.assertEqual(self.gate.chip_used, 3)

    def test_settle_lowers_only_the_reported_figure_never_the_reserved_budget(self):
        c = self.build(4)
        c.call(CAP)
        c.send(HARD, confirmed=True, verify=True)
        self.gate.settle(self.gate.ledger[-1]["n"], 1)
        self.assertEqual((self.gate.ledger[-1]["pulses_max"], self.gate.chip_used), (1, 2))
        self.gate.settle(self.gate.ledger[-1]["n"], 0)                        # never below one pulse
        self.assertEqual(self.gate.ledger[-1]["pulses_max"], 1)
        self.gate.settle(self.gate.ledger[-1]["n"], 5)                        # and never raised
        self.assertEqual(self.gate.ledger[-1]["pulses_max"], 1)

    def test_phases_a_to_f_refuse_every_reset_op_armed_unarmed_aborted_or_without_gate(self):
        for spec in phases.PHASES:
            if spec.id == "R":
                continue
            for state in ("armed", "unarmed", "aborted", "nogate"):
                c = self.build(5, arm=state in ("armed", "aborted"))
                if state == "aborted":
                    self.gate.abort("x")
                if state == "nogate":
                    self.policy.reset_gate = None
                self.policy.allowed_classes = spec.classes
                for op, args in ((CAP, {}), (SOFT, {}), (MACHINE, {"confirmed": True}), (HARD, {"confirmed": True, "verify": False}),
                                 (HARD, {"confirmed": True, "verify": True})):
                    n = len(self.inner.sent)
                    with self.assertRaises(ConfinementError, msg="%s %s %s" % (spec.id, state, op)):
                        c.send(op, **args)
                    self.assertEqual(len(self.inner.sent), n)
                self.assertEqual(self.gate.chip_used, 0)
        # and the cleanup's class list, with a gate that someone forgot to disarm
        c = self.build(5, arm=True)
        c.call(CAP)
        self.policy.allowed_classes = phases.CLEANUP_CLASSES
        for op, args in ((CAP, {}), (SOFT, {}), (MACHINE, {"confirmed": True}), (HARD, {"confirmed": True, "verify": False})):
            self.refused(op, **args)

    def test_while_armed_no_write_run_stop_or_typing_and_after_disarm_or_abort_nothing_at_all(self):
        c = self.build(5)
        c.call(CAP)
        for op, args in (("fs.put", {"remote": SCRATCH + "/x", "local": "/nonexistent"}), ("fs.rm", {"path": SCRATCH + "/x"}),
                         ("fs.mkdir", {"path": SCRATCH}), ("fs.rmtree", {"path": SCRATCH, "confirm": True}), ("run", {"local": "/x"}),
                         ("stop", {}), ("cancel", {"target": 1}), ("tty.write", {"b64": "YQ=="}), ("repl.attach", {}), ("exec", {"code": "print(1)"}),
                         ("connect", {"port": "socket://127.0.0.1:9", "openPolicy": "V2"}), ("connect", {"port": "other"}),
                         ("disconnect", {"stopFirst": True}) if False else ("config", {"x": 1})):
            self.refused(op, **args)
        self.gate.disarm()
        for op, args in ((CAP, {}), (SOFT, {}), (MACHINE, {"confirmed": True})):
            self.refused(op, **args)
        self.gate.arm()
        self.gate.abort("surprise")
        for op, args in ((CAP, {}), (SOFT, {}), (MACHINE, {"confirmed": True}), (HARD, {"confirmed": True, "verify": True})):
            self.refused(op, **args)
        c.call("identity")                                                    # reads still work after an abort (the cleanup needs them)


# ===================================================================================================== 3. whole runs on fake boards
class PhaseRRunTests(ResetRunMixin, TimedTestCase):
    DEADLINE_S = 600
    DOWNLOAD_NOISE = (b"ets Jul 29 2019 12:21:46\r\n\r\nrst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n"
                      b"waiting for download\r\n")
    _unsafe = None

    def chip_ops(self, sent):
        return [(op, a) for op, a in sent_resets(sent) if op in confine.CHIP_RESET_OPS]

    def ops_after_last_reset(self, report):
        log = report["ops"]["log"]
        last = max([i for i, e in enumerate(log) if e["op"] in (MACHINE, HARD, SOFT)] or [-1])
        return [e["op"] for e in log[last + 1:]]

    # ---- the budget counts units: the bridge's verify may pulse twice (FIXED, finding 1 and 2)
    def unsafe_run(self, n):
        """``reset.hard`` with verify:true meets a chip that stays in the ROM bootloader after every pulse ('waiting for download')."""
        cache = type(self).__dict__.get("_unsafe_cache") or {}
        type(self)._unsafe_cache = cache
        if n in cache:
            return cache[n]
        sent = []

        def on_send(op, args):
            sent.append((op, dict(args)))
            if op == HARD and args.get("verify") is True:
                b = box["board"]
                for prof in {id(p): p for p in (b.profile, getattr(b.device, "profile", None)) if isinstance(p, dict)}.values():
                    prof["rom_noise"] = self.DOWNLOAD_NOISE            # the chip "stays in the ROM bootloader" after each pulse

        box = {}
        r = self.reset_run("esp32", n=n, hooks={"on_send": on_send, "on_board": lambda b: box.update(board=b)}, recover=6.0)
        cache[n] = (r, sent)
        return cache[n]

    def test_physical_resets_never_exceed_the_budget_even_when_a_verification_repulses(self):
        """--allow-resets 4 -> machine, machine, hard-verify (2 units).  The bridge repeats the pulse once on 'waiting for download'
        (server.py _verify_hard_reset); the gate reserved both pulses, so the board saw exactly 4."""
        r, sent = self.unsafe_run(4)
        physical = resets_of(r.board)
        self.assertEqual(r.code, 5, r.text[-2500:])
        self.assertEqual(r.report["reset"]["summary"]["chip_budget_units_reserved"], 4)
        self.assertLessEqual(physical, 4, "the board saw %d chip resets (pulses=%d machine=%d) but the budget was 4"
                             % (physical, resets_of(r.board, "pulse"), resets_of(r.board, "machine")))
        self.assertEqual(resets_of(r.board, "pulse"), 2, "the scenario must really repulse, or the test proves nothing")

    def test_a_budget_that_cannot_pay_for_a_double_pulse_does_not_send_the_verification(self):
        """The original repro (--allow-resets 3: machine, machine, hard-verify) pulsed 4 times.  Now the verification is not planned."""
        r, sent = self.unsafe_run(3)
        self.assertEqual(r.code, 0, r.text[-2500:])
        self.assertEqual(self.chip_ops(sent), [(MACHINE, {"confirmed": True})] * 2)
        self.assertEqual(resets_of(r.board), 2)
        self.assertEqual(resets_of(r.board, "pulse"), 0)
        rep = r.report["reset"]
        self.assertEqual(sorted(s["tier"] for s in rep["skipped"]), ["hard", "hard verify"])
        self.assertTrue(all("budget 3" in s["reason"] for s in rep["skipped"]), rep["skipped"])
        self.assertIn("twice", [s for s in rep["skipped"] if s["tier"] == "hard verify"][0]["reason"])

    def test_the_report_summary_matches_the_boards_own_reset_count(self):
        r, sent = self.unsafe_run(4)
        summary = r.report["reset"]["summary"]
        self.assertEqual(summary["chip_resets_sent"], resets_of(r.board), "summary %r vs the board's ledger" % summary["text"])
        self.assertEqual(summary["chip_requests_sent"], 3)
        self.assertEqual(summary["chip_budget_units_reserved"], 4)
        self.assertIn("performed 4 / budget 4", summary["text"])
        self.assertEqual([row["cost"] for row in r.report["reset"]["ledger"] if row["chip_n"] is not None], [1, 1, 2])

    def test_after_an_unsafe_sequence_abort_the_cleanup_leaves_the_board_alone(self):
        """The abort reason says 'the chip may sit in the ROM bootloader'; the board is then left alone (only a disconnect)."""
        r, sent = self.unsafe_run(4)
        self.assertEqual(r.code, 5)
        self.assertIn("unsafe", r.report["reset"]["aborted"]["reason"])
        self.assertTrue(r.report["reset"]["aborted"]["board_lost"])
        after = [o for o in self.ops_after_last_reset(r.report) if o not in ("disconnect",)]
        self.assertEqual(after, [], "ops sent to a board that may sit in the ROM bootloader: %s" % after)
        self.assertTrue(any("check the board by hand" in x for x in r.report["residue"]), r.report["residue"])
        self.assertTrue(any("ROM bootloader" in x for x in r.report["residue"]), r.report["residue"])

    def test_the_announcement_says_that_a_verification_can_pulse_twice(self):
        r = self.reset_run("esp32", n=5)
        self.assertEqual(r.code, 0, r.text[-2500:])
        line = [ln for ln in r.text.splitlines() if "RESET 4/5: hard verify" in ln and "motor may twitch" in ln][0]
        self.assertIn("pulse the line twice", line)
        self.assertIn("counts as 2 of the budget", line)
        plain = [ln for ln in r.text.splitlines() if "RESET 5/5: hard (a motor" in ln][0]
        self.assertNotIn("twice", plain)
        summary = r.report["reset"]["summary"]
        self.assertEqual((summary["chip_resets_sent"], summary["chip_budget_units_reserved"], resets_of(r.board)), (4, 5, 4))

    # ---- signals and the time budget
    def _signal_run(self, signame, at_op, nth=1):
        sig = getattr(signal, signame, None)
        if sig is None:
            self.skipTest("%s does not exist here" % signame)
        sent, st = [], {"n": 0, "fired": False}

        def on_send(op, args):
            sent.append((op, dict(args)))
            if op == at_op and not st["fired"]:
                st["n"] += 1
                if st["n"] == nth and callable(signal.getsignal(sig)) and threading.current_thread() is threading.main_thread():
                    st["fired"] = True
                    signal.raise_signal(sig)            # delivered to the harness's own handler -> KeyboardInterrupt in this thread

        r = self.reset_run("esp32", n=5, hooks={"on_send": on_send}, recover=8.0)
        self.assertTrue(st["fired"], "the signal was not delivered (handler not installed?)")
        return r, sent

    def test_sigterm_between_the_debit_and_the_send_of_a_chip_reset_sends_nothing_more(self):
        r, sent = self._signal_run("SIGTERM", MACHINE)
        self.assertEqual(r.code, 130, r.text[-2500:])
        self.assertEqual(resets_of(r.board), 0, "the interrupted reset was never sent")
        self.assertEqual(self.chip_ops(sent), [(MACHINE, {"confirmed": True})])
        self.assertFalse(r.final["running"])
        self.assertEqual(r.report["bridge"]["shutdown"], "eof")
        logged = [e["op"] for e in r.report["ops"]["log"]]
        self.assertNotIn(MACHINE, logged, "the interrupted request never produced a response")
        self.assertNotIn(HARD, logged)

    def test_sighup_right_after_a_chip_reset_was_sent_never_adds_one(self):
        # the first exec after the first MACHINE is the tripwire probe that follows the reset
        sent, st = [], {"m": 0, "fired": False}
        sig = getattr(signal, "SIGHUP", None)
        if sig is None:
            self.skipTest("no SIGHUP")

        def on_send(op, args):
            sent.append((op, dict(args)))
            if op == MACHINE:
                st["m"] += 1
            elif op == "exec" and st["m"] == 1 and not st["fired"] and callable(signal.getsignal(sig)):
                st["fired"] = True
                signal.raise_signal(sig)

        r = self.reset_run("esp32", n=5, hooks={"on_send": on_send}, recover=8.0)
        self.assertTrue(st["fired"])
        self.assertEqual(r.code, 130, r.text[-2500:])
        self.assertEqual(resets_of(r.board), 1)
        self.assertEqual(len(self.chip_ops(sent)), 1)
        self.assertFalse(r.final["running"])
        self.assertEqual(r.report["bridge"]["shutdown"], "eof")
        self.assertEqual(r.report["reset"]["summary"]["chip_resets_sent"], 1)

    def test_the_run_budget_expiring_mid_reset_aborts_without_another_reset(self):
        sent, st, box = [], {"n": 0}, {}
        orig = confine.ConfinedClient.set_deadline

        def spy(self_, seconds):
            box.setdefault("client", self_)
            return orig(self_, seconds)

        def on_send(op, args):
            sent.append((op, dict(args)))
            if op == MACHINE:
                st["n"] += 1
                if st["n"] == 1:
                    box["client"].set_deadline(0.3)          # as if --max-minutes ran out right after this request left

        with mock.patch.object(confine.ConfinedClient, "set_deadline", spy):
            r = self.reset_run("esp32", n=5, hooks={"on_send": on_send}, recover=8.0)
        self.assertEqual(r.code, 5, r.text[-2500:])
        self.assertEqual(resets_of(r.board), 1)
        self.assertEqual(len(self.chip_ops(sent)), 1, "no second reset after the budget ran out")
        self.assertEqual(r.report["outcome"], "RESET_ABORTED")
        self.assertEqual(r.report["reset"]["summary"]["chip_resets_sent"], 1)
        self.assertEqual(r.report["bridge"]["shutdown"], "eof")
        self.assertNotIn(HARD, [op for op, _a in sent])

    # ---- the board comes back wrong
    def test_board_returning_running_a_program_stops_all_resets(self):
        sent, st = [], {"n": 0}

        def on_send(op, args):
            sent.append((op, dict(args)))
            if op == MACHINE:
                st["n"] += 1
                if st["n"] == 1:        # the board boots into a main.py that never ends
                    st["board"].write_file("/main.py", "import time\nwhile True:\n    time.sleep(0.2)\n")

        r = self.reset_run("esp32", n=5, hooks={"on_send": on_send, "on_board": lambda b: st.update(board=b)}, recover=4.0)
        self.assertEqual(r.code, 5, r.text[-2500:])
        self.assertEqual(len(self.chip_ops(sent)), 1)
        self.assertEqual(resets_of(r.board), 1)
        self.assertEqual(r.board.events.count("pulse"), 0)
        self.assertIsNotNone(r.report["reset"]["aborted"])
        self.assertEqual(r.report["outcome"], "RESET_ABORTED")
        self.assertEqual(r.report["bridge"]["shutdown"], "eof")

    def test_port_busy_on_every_reconnect_after_a_native_usb_reset_aborts_and_adds_no_reset(self):
        """esp32s3-usb: the port drops on a reset and the CLIENT reconnects.  Another program grabs the port first and holds it."""
        import socket
        sent, st = [], {"n": 0, "held": threading.Event(), "release": threading.Event(), "thread": None}

        def intruder(port):
            deadline = threading.Event()
            s = None
            for _ in range(400):
                try:
                    s = socket.create_connection(("127.0.0.1", port), 0.2)
                    break
                except OSError:
                    deadline.wait(0.01)
            if s is None:
                return
            st["held"].set()
            st["release"].wait(30.0)
            s.close()

        def on_send(op, args):
            sent.append((op, dict(args)))
            if op == MACHINE:
                st["n"] += 1
                if st["n"] == 1:
                    b = st["board"]
                    t = threading.Thread(target=intruder, args=(int(b.url.rsplit(":", 1)[1]),), daemon=True)
                    st["thread"] = t
                    t.start()

        try:
            r = self.reset_run("esp32s3-usb", n=5, hooks={"on_send": on_send, "on_board": lambda b: st.update(board=b)}, recover=4.0)
        finally:
            st["release"].set()
            if st["thread"] is not None:
                st["thread"].join(5.0)
        if not st["held"].is_set():
            self.skipTest("the intruder did not win the race for the port")
        self.assertEqual(r.code, 5, r.text[-3000:])
        self.assertEqual(len(self.chip_ops(sent)), 1, "no second reset while the port is held by someone else")
        self.assertEqual(r.board.events.count("pulse"), 0)
        self.assertEqual(r.report["outcome"], "RESET_ABORTED")
        self.assertTrue(r.report["reset"]["aborted"]["board_lost"])
        self.assertEqual(r.report["bridge"]["shutdown"], "eof")
        self.assertLess(r.report["elapsed_s"], 120)

    def test_a_default_run_with_the_env_set_but_no_budget_sends_no_reset_op_in_phases_a_to_f(self):
        sent = []
        r = self.reset_run("esp32", n=None, phases_="A,B,C,D,E,F", hooks={"on_send": lambda op, a: sent.append((op, dict(a))), "soak": (1, 2)})
        self.assertEqual(r.code, 0, r.text[-2500:])
        self.assertEqual([op for op, _a in sent if op.startswith("reset")], [])
        self.assertEqual(resets_of(r.board), 0)
        self.assertIsNone(r.report.get("reset"))
        self.assertTrue(r.left_as_found)



# ===================================================================================================== 4. tripwire and recovery timing (stubs, no bridge)
class _Clock(object):
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class _StubClient(object):
    def __init__(self):
        self.script, self.events, self.reset_errors = [], [], []

    def request(self, op, _timeout=None, **args):
        ticks, cause = self.script.pop(0)
        return {"ok": True, "out": "@@TRIP %d %d 5\r\n" % (ticks, cause)}

    def mark(self):
        return len(self.events)

    def events_of(self, ev=None, since=0, **m):
        return [e for e in self.events[since:] if ev is None or e.get("ev") == ev]


class TripwireBlindSpotTests(TimedTestCase):
    def after_a_caused_reset(self):
        from tools.hwtest.tripwire import Tripwire
        self.clock = _Clock()
        self.client = _StubClient()
        trip = Tripwire(self.client, session_t0=-1000.0, clock=self.clock)
        self.client.script.append((3_600_000, 1))
        trip.baseline()
        trip.enter_reset_mode()
        self.clock.t = 10.0
        t_sent = self.clock.t
        self.clock.t += 0.6
        self.client.script.append((527, 1))                       # the first probe after the caused reset: 527 ms of uptime
        _reading, reasons = trip.after_caused_reset("after reset", t_sent)
        self.assertEqual(reasons, [])
        return trip

    def test_outside_the_reset_expected_mode_the_lag_bound_is_unchanged(self):
        """The tightening is for phase R only: phases A-F keep 1.5 s + 1 % (a lag of 1.0 s must not trip there)."""
        from tools.hwtest.tripwire import Tripwire
        self.clock, self.client = _Clock(), _StubClient()
        trip = Tripwire(self.client, session_t0=-1000.0, clock=self.clock)
        self.client.script.append((3_600_000, 1))
        trip.baseline()
        self.clock.t += 3.0
        self.client.script.append((3_600_000 + 2000, 1))                      # 1.0 s behind the wall clock
        trip.check("no trip outside phase R")
        trip.enter_reset_mode()
        self.clock.t += 3.0
        self.client.script.append((3_600_000 + 2000 + 2000, 1))
        from tools.hwtest.tripwire import TripwireTripped
        with self.assertRaises(TripwireTripped):
            trip.check("the same lag trips in the reset-expected mode")

    def test_control_a_restart_one_and_a_half_seconds_after_the_baseline_is_noticed(self):
        from tools.hwtest.tripwire import TripwireTripped
        trip = self.after_a_caused_reset()
        self.clock.t += 3.0
        self.client.script.append((1500, 1))                      # restarted 1.5 s after the last reading, probe 3 s after it
        with self.assertRaises(TripwireTripped):
            trip.check("before the next reset")

    def test_a_restart_the_harness_did_not_cause_half_a_second_after_the_post_reset_baseline_is_noticed(self):
        """FIXED (finding 4): the lag bound was 1.5 s + 1 %, so a board whose baseline uptime is only ~0.5 s could restart (brownout,
        crash) within the next second and the pre-send check of the following reset still passed.  In the reset-expected mode it is
        0.3 s + 1 %."""
        from tools.hwtest.tripwire import TripwireTripped
        trip = self.after_a_caused_reset()
        self.clock.t += 3.0
        self.client.script.append((2500, 1))                      # uncaused restart 0.5 s after the last reading, probe 3 s after it
        with self.assertRaises(TripwireTripped):
            trip.check("before the next reset")


class RecoverDeadlineTests(TimedTestCase):
    def test_a_reconnect_that_succeeds_after_the_recovery_deadline_is_not_accepted(self):
        """FIXED (finding 5): _recover() started a connect while ``left > 0`` with a timeout of max(1.0, left); a board that answered
        0.4 s after the 20 s limit was accepted although the abort rule says it must be back within 20 s."""
        import time
        from tests.bridge_client import BridgeTimeout
        from tools.hwtest import resetphase

        class Client(object):
            def mark(self):
                return 0

            def wait_event(self, *a, **k):
                raise BridgeTimeout("no event")

            def request(self, op, _timeout=None, **a):
                threading.Event().wait(0.4)                       # the reconnect takes 0.4 s ...
                ctx._state = "idle"
                return {"ok": True, "state": "idle", "sync": "prompt"}

        class Ctx(object):
            reset_recover_s = 20.0
            port = "socket://127.0.0.1:9"
            connected = False
            _state = "disconnected"
            client = Client()

            def state(self):
                return self._state

        ctx = Ctx()
        deadline = time.monotonic() + 0.05                       # ... and the deadline falls 0.05 s into it
        with self.assertRaises(resetphase.ResetAbort):
            resetphase._recover(ctx, {"portDropped": True}, 0, deadline)

    def _ctx(self, initial, request):
        from tests.bridge_client import BridgeTimeout

        class Client(object):
            def mark(self):
                return 0

            def wait_event(self, *a, **k):
                raise BridgeTimeout("no event")

        class Ctx(object):
            reset_recover_s = 20.0
            port = "socket://127.0.0.1:9"
            connected = False
            client = Client()
            _state = initial

            def state(self):
                return self._state

        ctx = Ctx()
        ctx.client.request = lambda op, _timeout=None, **a: request(ctx, op, _timeout, **a)
        return ctx

    def test_a_connect_that_does_not_answer_before_the_deadline_aborts_as_a_board_that_did_not_come_back(self):
        import time
        from tests.bridge_client import BridgeTimeout
        from tools.hwtest import resetphase
        seen = []

        def request(ctx, op, timeout, **a):
            seen.append(timeout)
            raise BridgeTimeout("no answer")

        ctx = self._ctx("disconnected", request)
        with self.assertRaises(resetphase.ResetAbort) as cm:
            resetphase._recover(ctx, {"portDropped": False}, 0, time.monotonic() + 0.05)
        self.assertTrue(cm.exception.board_lost)
        self.assertIn("did not come back", cm.exception.reason)
        self.assertLessEqual(seen[0], 0.25, "the connect may not outlast the deadline by seconds: %r" % seen)

    def test_a_board_that_is_idle_only_after_the_deadline_is_not_accepted(self):
        import time
        from tools.hwtest import resetphase
        ctx = self._ctx("idle", lambda *a, **k: self.fail("no connect needed"))
        with self.assertRaises(resetphase.ResetAbort):
            resetphase._recover(ctx, {}, 0, time.monotonic() - 0.01)
        resetphase._recover(ctx, {}, 0, time.monotonic() + 5.0)             # in time: returns


if __name__ == "__main__":
    unittest.main()
