"""tests/test_hwtest_reset.py - phase R ("reset tiers") of the hardware harness, tested against FAKE boards only.

Nothing here can reach a real device and nothing here can reset one: every run is ``--fake <profile>`` (an in-process
``tools.fakeboard.FakeBoard`` behind ``socket://127.0.0.1``, the bridge as a child process with a stand-in for DTR/RTS) or an
injected stub ``spawn``; the environment is always a dict handed to ``run_hw.main(environ=...)`` (MPY_ALLOW_RESETS is never set
in os.environ); the fake board's own event log (``hard_reset`` / ``soft_reset`` / ``pulse``) is the ledger that counts resets.

    export MPY_SAFE_MODE=1; python3.13 -B -m unittest tests.test_hwtest_reset

Sections: GatingTests (every missing condition refuses, nothing is spawned), ConfinementResetTests (the allowlist table, budget
counted before the send, one reset at a time), TripwireResetTests, FakeResetRunTests (phase R end to end on the fake profiles,
budget, abort paths), DocsTests.
"""
from __future__ import annotations

import concurrent.futures
import datetime
import glob
import json
import os
import re
import shutil
import tempfile
import unittest
from unittest import mock

from tests.support import TimedTestCase
from tests.test_hwtest import ACME_CFG, FAKE_REAL_PATH, SCRATCH, RunResult, TmpMixin, run_main, snapshot
from tools import fakeboard
from tools.hwtest import confine, phases, resetphase, run_hw
from tools.hwtest.config import ConfigError, validate_config
from tools.hwtest.confine import ConfinedClient, ConfinementError, Policy, ResetGate
from tools.hwtest.tripwire import TRIP_PROBE, Tripwire, TripwireTripped

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HWDIR = os.path.join(ROOT, "tools", "hwtest")
ENV_OK = {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": "1"}
CAP, SOFT, MACHINE, HARD = (confine.OP_RESET_CAPABILITY, confine.OP_RESET_SOFT, confine.OP_RESET_MACHINE, confine.OP_RESET_HARD)


def cap_result(hard="likely", method="rts-pulse", machine=True):
    return {"ok": True, "soft": True, "machine": {"available": machine, "reason": "r"},
            "hard": {"state": hard, "method": method, "reason": "r", "basis": "adapter"},
            "cacheKey": {"vid": 1, "pid": 2, "uniqueId": "ab"}}


def refused_spawn_factory(calls):
    def spawn(port, real_port):
        calls.append((port, real_port))
        raise AssertionError("spawn() must not be called when a gate is missing (port=%r)" % (port,))
    return spawn


class ResetRunMixin(TmpMixin):
    """Whole harness runs against a fake board with phase R requested and every gate satisfied (unless told otherwise)."""

    def reset_run(self, profile="esp32", n=5, phases_="A,R", cfg=None, hooks=None, faults=(), extra=(), env=None, wait=0.02,
                  recover=None):
        base = self.tmpdir()
        argv = ["--fake", profile, "--phases", phases_, "--report", os.path.join(base, "reports"),
                "--backup-dir", os.path.join(base, "backup"), "--config", self.write_cfg(ACME_CFG if cfg is None else cfg)]
        if n is not None:
            argv += ["--allow-resets", str(n)]
        for f in faults:
            argv += ["--fake-fault", f]
        argv += list(extra)
        box = {}
        h = dict(hooks or {})
        user_on_board, user_before_stop = h.get("on_board"), h.get("before_stop")

        def on_board(b):
            box["board"] = b
            if user_on_board:
                user_on_board(b)
            box["initial"] = snapshot(b)

        def before_stop(b):
            box["final"] = snapshot(b)
            if user_before_stop:
                user_before_stop(b)

        h["on_board"], h["before_stop"] = on_board, before_stop
        if wait is not None:
            h.setdefault("reset_wait_s", wait)
        if recover is not None:
            h.setdefault("reset_recover_s", recover)
        code, text = run_main(argv, env=dict(ENV_OK) if env is None else env, hooks=h)
        dirs = sorted(glob.glob(os.path.join(base, "reports", "*")))
        report = None
        if dirs:
            with open(os.path.join(dirs[-1], "report.json"), encoding="utf-8") as f:
                report = json.load(f)
        return RunResult(code, text, report, box.get("board"), box.get("initial"), box.get("final"), base)


def resets_of(board, via=None):
    return board.events.count("hard_reset") if via is None else board.events.count("hard_reset", via=via)


def sent_resets(sent):
    return [(op, a) for op, a in sent if op.startswith("reset")]


# ===================================================================================================== gating
class GatingTests(TmpMixin, TimedTestCase):
    DEADLINE_S = 120

    def refuse(self, argv, env=None, cfg=None, lsof=None):
        calls = []
        base = self.tmpdir()
        argv = list(argv) + ["--report", base, "--backup-dir", base]
        if cfg is not None:
            argv += ["--config", self.write_cfg(cfg)]
        with mock.patch("tools.fakeboard.FakeBoard", side_effect=AssertionError("a refused run must not start a fake board")):
            code, text = run_main(argv, spawn=refused_spawn_factory(calls), env=dict(ENV_OK) if env is None else env,
                                  lsof=lsof or (lambda p: calls.append(("lsof", p)) or []))
        return code, text, calls

    def test_phase_r_is_never_a_default_phase_and_is_listed(self):
        self.assertNotIn("R", run_hw.DEFAULT_PHASES.split(","))
        code, text = run_main(["--fake", "esp32", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertNotIn("R  reset tiers", text)
        self.assertNotIn("chip resets budget", text)
        code, text = run_main(["--list-phases"])
        self.assertEqual(code, 0)
        self.assertRegex(text, r"(?m)^  R  ")
        for klass in ("reset-info", "reset-soft", "reset-chip"):
            self.assertIn(klass, text)
        self.assertIn("Never sent by any phase", text)
        spec = [p for p in phases.PHASES if p.id == "R"][0]
        self.assertEqual(set(spec.classes), {"session", "read", "probe", "reset-info", "reset-soft", "reset-chip"})
        self.assertFalse(set(spec.classes) & {"scratch-write", "program", "console", "stop"}, "phase R writes, runs and types nothing")

    def test_every_missing_condition_refuses_with_exit_2_and_spawns_nothing(self):
        fake = ["--fake", "esp32", "--phases", "A,R"]
        cases = [
            ("no --allow-resets", fake, ENV_OK),
            ("--allow-resets 0", fake + ["--allow-resets", "0"], ENV_OK),
            ("--allow-resets 6", fake + ["--allow-resets", "6"], ENV_OK),
            ("--allow-resets 99", fake + ["--allow-resets", "99"], ENV_OK),
            ("--allow-resets -1", fake + ["--allow-resets", "-1"], ENV_OK),
            ("--allow-resets x", fake + ["--allow-resets", "x"], ENV_OK),
            ("abbreviated flag --allow-res", fake + ["--allow-res", "5"], ENV_OK),
            ("env missing", fake + ["--allow-resets", "5"], {"MPY_SAFE_MODE": "1"}),
            ("env 0", fake + ["--allow-resets", "5"], {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": "0"}),
            ("env true", fake + ["--allow-resets", "5"], {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": "true"}),
            ("env yes", fake + ["--allow-resets", "5"], {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": "yes"}),
            ("env ' 1'", fake + ["--allow-resets", "5"], {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": " 1"}),
            ("env '1 '", fake + ["--allow-resets", "5"], {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": "1 "}),
            ("env 11", fake + ["--allow-resets", "5"], {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": "11"}),
            ("env empty", fake + ["--allow-resets", "5"], {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": ""}),
            ("--allow-resets without phase R", ["--fake", "esp32", "--phases", "A,B", "--allow-resets", "3"], ENV_OK),
            ("--allow-resets with the default phases", ["--fake", "esp32", "--allow-resets", "3"], ENV_OK),
        ]
        for name, argv, env in cases:
            for extra in ([], ["--dry-run"]):
                with self.subTest(case=name, extra=extra):
                    code, text, calls = self.refuse(argv + extra, env=env)
                    self.assertEqual(code, 2, text)
                    if name not in ("--allow-resets x", "abbreviated flag --allow-res"):     # (argparse's own usage errors)
                        self.assertIn("REFUSED", text)
                    self.assertEqual(calls, [], "nothing may be spawned or looked up")

    def test_real_device_needs_every_real_port_guard_in_addition(self):
        p = FAKE_REAL_PATH
        base = ["--port", p, "--phases", "A,R", "--allow-resets", "5"]
        full = {"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": p, "MPY_ALLOW_RESETS": "1"}
        cases = [
            ("no --allow-real-port", base, full),
            ("MPY_REAL_PORT missing", base + ["--allow-real-port"], {"MPY_SAFE_MODE": "1", "MPY_ALLOW_RESETS": "1"}),
            ("MPY_REAL_PORT differs", base + ["--allow-real-port"], dict(full, MPY_REAL_PORT=p + "x")),
            ("MPY_REAL_PORT auto", base + ["--allow-real-port"], dict(full, MPY_REAL_PORT="auto")),
            ("no safe mode", base + ["--allow-real-port"], {"MPY_REAL_PORT": p, "MPY_ALLOW_RESETS": "1"}),
            ("MPY_ALLOW_RESETS missing", base + ["--allow-real-port"], {"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": p}),
            ("no --allow-resets", ["--port", p, "--phases", "A,R", "--allow-real-port"], full),
            ("budget 6", ["--port", p, "--phases", "A,R", "--allow-real-port", "--allow-resets", "6"], full),
        ]
        for name, argv, env in cases:
            for extra in ([], ["--dry-run"]):
                with self.subTest(case=name, extra=extra):
                    code, text, calls = self.refuse(argv + extra, env=env)
                    self.assertEqual(code, 2, text)
                    self.assertEqual(calls, [])
        code, text, calls = self.refuse(base + ["--allow-real-port", "--dry-run"], env=full)
        self.assertEqual(code, 0, text)
        self.assertEqual(calls, [])
        self.assertIn("REAL DEVICE", text)
        self.assertIn("chip resets budget 5", text)

    def test_the_config_can_only_lower_the_budget_never_raise_it(self):
        def dry(cfg, n):
            return self.refuse(["--fake", "esp32", "--phases", "A,R", "--allow-resets", str(n), "--dry-run"], cfg=cfg)

        for cfg, n, want in [({}, 5, 5), ({"allow_resets": 2}, 5, 2), ({"allow_resets": 5}, 1, 1), ({"allow_resets": True}, 3, 3),
                             ({"allow_resets": 4}, 4, 4), ({"allow_resets": 1}, 5, 1)]:
            with self.subTest(cfg=cfg, n=n):
                code, text, _c = dry(cfg, n)
                self.assertEqual(code, 0, text)
                self.assertIn("chip resets budget %d" % want, text)
        for cfg in ({"allow_resets": False}, {"allow_resets": 0}):
            with self.subTest(cfg=cfg):
                code, text, _c = dry(cfg, 5)
                self.assertEqual(code, 2, text)
                self.assertIn("config", text)
        for bad in (6, -1, "2", 1.5, None, [1]):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError):
                    validate_config({"allow_resets": bad})
        self.assertIsNone(validate_config({}).allow_resets)
        self.assertEqual(validate_config({"allow_resets": 3}).allow_resets, 3)
        # a config alone never enables anything: without the flags a config with allow_resets is just as refused
        code, text, _c = self.refuse(["--fake", "esp32", "--phases", "A,R", "--dry-run"], cfg={"allow_resets": 5})
        self.assertEqual(code, 2, text)

    def test_dry_run_prints_the_plan_with_the_budget_and_starts_nothing(self):
        base = self.tmpdir()
        reports = os.path.join(base, "reports")
        with mock.patch("tools.fakeboard.FakeBoard", side_effect=AssertionError("a dry run must not start a fake board")), \
                mock.patch.object(run_hw, "default_spawn", side_effect=AssertionError("a dry run must not spawn")):
            code, text = run_main(["--fake", "esp32", "--phases", "A,R", "--allow-resets", "5", "--dry-run", "--report", reports,
                                   "--backup-dir", base], env=dict(ENV_OK))
        self.assertEqual(code, 0, text)
        for needle in ("PLAN", "no bridge spawned", "A  read-only", "R  reset tiers", "chip resets budget 5", "RESET i/N",
                       "MPY_ALLOW_RESETS=1", "exit 5", "5 RESET PHASE ABORTED", "dry run OK"):
            self.assertIn(needle, text)
        self.assertNotIn("B  files in scratch", text)
        self.assertFalse(os.path.exists(reports))
        code, text = run_main(["--fake", "esp32", "--phases", "R", "--allow-resets", "2", "--dry-run"], env=dict(ENV_OK))
        self.assertEqual(code, 0)
        self.assertIn("A  read-only", text)                                   # A always first
        self.assertIn("chip resets budget 2", text)

    def test_real_device_with_every_gate_sends_no_reset_when_phase_a_refuses(self):
        """The 'real' path with stubs only: spawn is called with the real port, the stub board refuses the connect, no reset op is sent."""
        p = FAKE_REAL_PATH
        sent, spawned = [], []

        class Stub(object):
            pid, alive, hello, shutdown, exit_code = 4242, True, {}, "eof", 0

            def __init__(self):
                self._n, self._r = 0, {}

            def send(self, op, **a):
                sent.append((op, a))
                self._n += 1
                self._r[self._n] = ({"id": self._n, "ok": True, "ports": []} if op == "ports.list" else
                                    {"id": self._n, "ok": False, "error": {"code": "E_NO_DEVICE", "message": "stub", "detail": "", "hint": ""}})
                return self._n

            def result(self, rid, timeout=None):
                return self._r.pop(rid)

            def mark(self):
                return 0

            def events_of(self, ev=None, since=0, **m):
                return []

            def states(self, since=0):
                return []

            def close(self, timeout=8.0):
                self.alive = False
                return 0

        stub = Stub()
        base = self.tmpdir()
        code, text = run_main(["--port", p, "--allow-real-port", "--phases", "A,R", "--allow-resets", "5", "--report", base, "--backup-dir", base],
                              spawn=lambda port, real: spawned.append((port, real)) or stub,
                              env={"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": p, "MPY_ALLOW_RESETS": "1"}, lsof=lambda port: [])
        self.assertEqual(code, 4, text)
        self.assertEqual(spawned, [(p, p)])
        self.assertEqual([op for op, _a in sent], ["ports.list", "connect"])
        self.assertEqual(sent_resets(sent), [])


# ===================================================================================================== confinement
class RecInner(object):
    """Stands in for the bridge client: records what would have been sent (and what the gate counted at that moment)."""

    def __init__(self, gate=None):
        self.gate, self.sent, self.counted, self.responses = gate, [], [], {}
        self.next_cap = cap_result()
        self._n = 0

    def send(self, op, **args):
        self.sent.append((op, dict(args)))
        self.counted.append(self.gate.chip_used if self.gate else None)
        self._n += 1
        self.responses[self._n] = dict(self.next_cap, id=self._n) if op == CAP else {"id": self._n, "ok": True}
        return self._n

    def result(self, rid, timeout=None):
        return self.responses.pop(rid)

    default_timeout = 5.0


class ConfinementResetTests(TmpMixin, TimedTestCase):
    DEADLINE_S = 60

    def build(self, budget=2, arm=True):
        tmp = self.tmpdir()
        self.gate = ResetGate(budget)
        self.policy = Policy(SCRATCH, "socket://127.0.0.1:9", backup_remote=["/boot.py"], local_read_roots=[tmp], local_write_roots=[tmp],
                             shadow_names=["acme"], probe_codes=[TRIP_PROBE], reset_gate=self.gate)
        self.inner = RecInner(self.gate)
        self.client = ConfinedClient(self.inner, self.policy)
        if arm:
            self.gate.arm()
        return self.client

    def refused(self, op, **args):
        n = len(self.inner.sent)
        with self.assertRaises(ConfinementError, msg="%s %r" % (op, args)):
            self.client.call(op, **args)
        self.assertEqual(len(self.inner.sent), n, "a refused request must not reach the bridge")

    def sent_ok(self, op, **args):
        self.client.call(op, **args)
        return self.inner.sent[-1]

    def test_the_budget_must_be_1_to_5(self):
        for bad in (0, 6, -1, True, False, "5", None, 2.0, 100):
            with self.assertRaises(ConfinementError, msg=repr(bad)):
                ResetGate(bad)
        for good in range(1, 6):
            self.assertEqual(ResetGate(good).budget, good)
        self.assertEqual(confine.RESET_BUDGET_MAX, 5)

    def test_without_a_gate_or_while_unarmed_every_reset_op_is_refused_as_before(self):
        self.build(arm=False)
        for client_policy in (self.policy, Policy(SCRATCH, "socket://127.0.0.1:9")):
            for op in (CAP, SOFT, MACHINE, HARD, "reset", "reset.soft ", "reset.foo"):
                for args in ({}, {"confirmed": True}, {"confirmed": True, "verify": True}):
                    with self.assertRaises(ConfinementError, msg=(op, args)) as cm:
                        client_policy.check(op, args)
                    self.assertIn(confine.RESET_OPS_MESSAGE, str(cm.exception))
        self.refused(MACHINE, confirmed=True)

    def test_phases_a_to_f_can_never_send_a_reset_even_with_an_armed_gate(self):
        for armed in (False, True):
            self.build(arm=armed)
            self.gate.note_capability(cap_result())
            for spec in phases.PHASES:
                if spec.id == "R":
                    continue
                self.policy.allowed_classes = spec.classes
                for op, args in ((CAP, {}), (SOFT, {}), (MACHINE, {"confirmed": True}), (HARD, {"confirmed": True, "verify": True})):
                    with self.assertRaises(ConfinementError, msg=(armed, spec.id, op)):
                        self.policy.check(op, args)
            self.policy.allowed_classes = None
        self.assertEqual(self.inner.sent, [])

    def test_the_armed_allowlist_table(self):
        self.build(budget=5)
        # capability: nothing, or learned = null / "failed" (never forwarded); never learned = "verified"
        self.assertEqual(self.sent_ok(CAP), (CAP, {}))
        self.assertEqual(self.sent_ok(CAP, learned=None), (CAP, {}))
        self.assertEqual(self.sent_ok(CAP, learned="failed"), (CAP, {}))
        for extra in ({"learned": "verified"}, {"learned": True}, {"learned": ""}, {"force": True}, {"confirmed": True}, {"interrupt": True}):
            self.refused(CAP, **extra)
        # soft: no arguments
        for extra in ({"confirmed": True}, {"interrupt": True}, {"force": True}, {"verify": True}, {"x": 1}):
            self.refused(SOFT, **extra)
        # machine: exactly {confirmed: True}
        for extra in ({}, {"confirmed": False}, {"confirmed": 1}, {"confirmed": "true"}, {"confirmed": None},
                      {"confirmed": True, "interrupt": True}, {"confirmed": True, "force": True}, {"confirmed": True, "method": "rts-pulse"},
                      {"confirmed": True, "learned": "verified"}, {"confirmed": True, "verify": True}, {"confirmed": True, "background": True}):
            self.refused(MACHINE, **extra)
        # hard: exactly {confirmed: True, verify: bool}
        for extra in ({}, {"confirmed": True}, {"verify": True}, {"confirmed": 1, "verify": True}, {"confirmed": True, "verify": 1},
                      {"confirmed": True, "verify": "yes"}, {"confirmed": True, "verify": None}, {"confirmed": True, "verify": True, "force": True},
                      {"confirmed": True, "verify": True, "method": "rts-pulse"}, {"confirmed": True, "verify": True, "method": "usb-jtag"},
                      {"confirmed": True, "verify": False, "learned": "verified"}, {"confirmed": True, "verify": True, "interrupt": True}):
            self.refused(HARD, **extra)
        self.assertEqual(sent_resets(self.inner.sent), [(CAP, {})] * 3, "only the three capability reads went out")
        self.assertEqual(self.gate.chip_used + self.gate.soft_used, 0)
        # the exact allowed shapes
        self.assertEqual(self.sent_ok(SOFT), (SOFT, {}))
        self.gate.recovered()
        self.assertEqual(self.sent_ok(MACHINE, confirmed=True), (MACHINE, {"confirmed": True}))
        self.gate.recovered()
        self.client.call(CAP)
        self.assertEqual(self.sent_ok(HARD, confirmed=True, verify=True), (HARD, {"confirmed": True, "verify": True}))
        self.gate.recovered()
        self.client.call(CAP)
        self.assertEqual(self.sent_ok(HARD, confirmed=True, verify=False), (HARD, {"confirmed": True, "verify": False}))

    def test_a_reset_op_needs_a_capability_read_first(self):
        self.build()
        for op, args in ((SOFT, {}), (MACHINE, {"confirmed": True}), (HARD, {"confirmed": True, "verify": True})):
            self.refused(op, **args)
        self.client.call(CAP)
        self.sent_ok(SOFT)

    def test_machine_needs_the_capability_to_say_available(self):
        self.build()
        self.inner.next_cap = cap_result(machine=False)
        self.client.call(CAP)
        self.refused(MACHINE, confirmed=True)
        self.inner.next_cap = cap_result()
        self.client.call(CAP)
        self.sent_ok(MACHINE, confirmed=True)

    def test_hard_only_when_the_capability_just_read_says_verified_or_likely(self):
        for state, method, ok in (("verified", "rts-pulse", True), ("likely", "usb-jtag", True), ("likely", "rts-pulse", True),
                                  ("unlikely", "none", False), ("unknown", "rts-pulse", False), ("failed", "rts-pulse", False),
                                  ("likely", "none", False), ("verified", "none", False), ("likely", None, False), (None, None, False),
                                  ("LIKELY", "rts-pulse", False)):
            with self.subTest(state=state, method=method):
                self.build()
                self.inner.next_cap = cap_result(hard=state, method=method)
                self.client.call(CAP)
                if ok:
                    self.sent_ok(HARD, confirmed=True, verify=True)
                else:
                    self.refused(HARD, confirmed=True, verify=True)
        self.build()
        self.inner.next_cap = dict(cap_result(), hard="broken")
        self.client.call(CAP)
        self.refused(HARD, confirmed=True, verify=True)

    def test_hard_needs_a_capability_read_after_the_last_chip_reset(self):
        self.build(budget=3)
        self.client.call(CAP)
        self.sent_ok(MACHINE, confirmed=True)
        self.gate.recovered()
        self.refused(HARD, confirmed=True, verify=True)                           # that read predates the machine reset
        self.client.call(CAP)
        self.sent_ok(HARD, confirmed=True, verify=True)

    def test_chip_resets_are_counted_before_the_send_and_the_n_plus_first_is_refused(self):
        for budget in (1, 2, 5):
            with self.subTest(budget=budget):
                self.build(budget=budget)
                self.client.call(CAP)
                for k in range(1, budget + 1):
                    self.client.call(CAP)
                    self.sent_ok(MACHINE, confirmed=True)
                    self.assertEqual(self.inner.counted[-1], k, "the budget must be debited BEFORE the request leaves")
                    self.gate.recovered()
                self.client.call(CAP)
                n = len(self.inner.sent)
                self.refused(MACHINE, confirmed=True)
                self.refused(HARD, confirmed=True, verify=True)
                self.refused(HARD, confirmed=True, verify=False)
                self.assertEqual(len(self.inner.sent), n)
                self.assertEqual(self.gate.chip_used, budget)
                self.assertEqual(len([1 for op, _a in self.inner.sent if op in confine.CHIP_RESET_OPS]), budget)
                self.assertEqual(self.gate.remaining, 0)

    def test_one_reset_at_a_time_a_soft_reset_once_and_abort_is_final(self):
        self.build(budget=5)
        self.client.call(CAP)
        self.sent_ok(SOFT)
        self.refused(SOFT)                                                         # once
        self.refused(MACHINE, confirmed=True)                                      # the soft reset was not declared recovered
        self.gate.recovered()
        self.refused(SOFT)                                                         # still once
        self.sent_ok(MACHINE, confirmed=True)
        self.refused(MACHINE, confirmed=True)                                      # no retry before recovery
        self.gate.abort("test")
        self.gate.recovered()
        for op, args in ((SOFT, {}), (MACHINE, {"confirmed": True}), (CAP, {})):
            self.refused(op, **args)
        self.assertEqual(self.gate.chip_used, 1)

    def test_while_armed_nothing_is_written_run_or_typed(self):
        self.build()
        tmp = self.tmpdir()
        local = os.path.join(tmp, "x.dat")
        with open(local, "wb") as f:
            f.write(b"x")
        for op, args in (("fs.put", {"local": local, "remote": SCRATCH + "/a"}), ("fs.rm", {"path": SCRATCH + "/a"}),
                         ("fs.mkdir", {"path": SCRATCH}), ("fs.rmtree", {"path": SCRATCH}), ("fs.mv", {"src": SCRATCH + "/a", "dst": SCRATCH + "/b"}),
                         ("run", {"local": local}), ("tty.write", {"b64": "YQ=="}), ("stop", {}), ("repl.attach", {}), ("cancel", {"target": 1})):
            self.refused(op, **args)
        self.sent_ok("fs.list", path="/")                                          # reads stay possible
        self.sent_ok("identity")
        self.gate.disarm()
        self.refused(CAP)
        self.sent_ok("fs.mkdir", path=SCRATCH)                                     # the normal rules apply again once disarmed

    def test_reset_op_names_live_only_in_confine(self):
        for path in glob.glob(os.path.join(HWDIR, "*.py")):
            name = os.path.basename(path)
            with open(path, encoding="utf-8") as f:
                text = f.read()
            if name != "confine.py":
                self.assertNotRegex(text, r"""["']reset\.(capability|soft|hard|machine)["']""", name)
            if name not in ("run_hw.py", "confine.py"):
                for bad in ("send_raw", "BridgeClient(", "_inner", ".proc", "Popen", "MPY_REAL_PORT", "openPolicy"):
                    self.assertNotIn(bad, text, "%s uses %s" % (name, bad))


# ===================================================================================================== tripwire
class _Clock(object):
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class _StubClient(object):
    def __init__(self, clock):
        self.clock, self.script, self.events, self.reset_errors = clock, [], [], []

    def request(self, op, _timeout=None, **args):
        ticks, cause = self.script.pop(0)
        return {"ok": True, "out": "@@TRIP %d %d 5\r\n" % (ticks, cause)}

    def mark(self):
        return len(self.events)

    def events_of(self, ev=None, since=0, **m):
        return [e for e in self.events[since:] if ev is None or e.get("ev") == ev]


class TripwireResetTests(TimedTestCase):
    def setUp(self):
        self.clock = _Clock()
        self.client = _StubClient(self.clock)
        self.trip = Tripwire(self.client, session_t0=-1000.0, clock=self.clock)

    def read(self, ticks, cause, advance):
        self.clock.t += advance
        self.client.script.append((ticks, cause))

    def baseline(self):
        self.client.script.append((3_600_000, 1))
        self.trip.baseline()
        self.trip.enter_reset_mode()

    def test_a_restart_the_harness_caused_is_accepted_and_becomes_the_new_baseline(self):
        self.baseline()
        self.clock.t = 10.0
        t_sent = self.clock.t
        self.client.events.append({"ev": "state", "state": "connecting", "reason": "board-reset"})
        self.client.events.append({"ev": "state", "state": "idle", "reason": "board-reset (prompt)"})
        self.read(800, 1, 1.0)
        reading, reasons = self.trip.after_caused_reset("after reset", t_sent)
        self.assertEqual(reasons, [])
        self.assertIs(self.trip.baseline_reading, reading)
        self.assertEqual(self.trip.caused[0]["ticks_ms"], 800)
        self.assertEqual([e["state"] for e in self.trip.caused[0]["bridge_events"]], ["connecting", "idle"])
        self.read(5800, 1, 5.0)                                                     # an ordinary check against the new baseline
        self.assertEqual(self.trip.check("later").ticks, 5800)

    def test_a_board_that_did_not_restart_is_not_accepted_and_nothing_is_rebased(self):
        self.baseline()
        old = self.trip.baseline_reading
        self.clock.t = 10.0
        self.read(3_611_000, 1, 1.0)
        reading, reasons = self.trip.after_caused_reset("after reset", 10.0)
        self.assertTrue(reasons and "did not restart" in reasons[0], reasons)
        self.assertIs(self.trip.baseline_reading, old)
        self.assertEqual(self.trip.caused, [])
        self.clock.t = 20.0
        self.read(14_000, 1, 1.0)                                                   # small, but older than the request: uptime predates it
        _r, reasons = self.trip.after_caused_reset("after reset", 20.0)
        self.assertTrue(reasons and "predates" in reasons[0], reasons)

    def test_a_restart_the_harness_did_not_cause_still_trips_in_reset_expected_mode(self):
        self.baseline()
        self.read(3_605_000, 1, 5.0)
        self.trip.check("fine")
        self.read(900, 1, 5.0)                                                      # ticks went backwards, no reset was issued
        with self.assertRaises(TripwireTripped) as cm:
            self.trip.check("surprise")
        self.assertIn("backwards", str(cm.exception))

    def test_a_board_reset_state_event_after_the_baseline_still_trips(self):
        self.baseline()
        self.client.events.append({"ev": "state", "state": "connecting", "reason": "board-reset"})
        self.read(3_605_000, 1, 5.0)
        with self.assertRaises(TripwireTripped):
            self.trip.check("surprise")

    def test_after_caused_reset_outside_the_mode_is_a_programming_error(self):
        self.client.script.append((3_600_000, 1))
        self.trip.baseline()
        with self.assertRaises(RuntimeError):
            self.trip.after_caused_reset("x", 0.0)


# ===================================================================================================== phase R on the fake boards
class FakeResetRunTests(ResetRunMixin, TimedTestCase):
    DEADLINE_S = 300

    def recorder(self):
        sent = []
        return sent, {"on_send": lambda op, args: sent.append((op, dict(args)))}

    def full_plan_asserts(self, r, sent, tiers=("soft", "machine", "machine", "hard verify", "hard")):
        self.assertEqual(r.code, 0, r.text[-3500:])
        self.assertEqual(r.report["outcome"], "PASS", r.text[-1500:])
        self.assertEqual(r.report["residue"], [], r.report["cleanup"])
        steps = r.report["reset"]["steps"]
        self.assertEqual([s["tier"] for s in steps], list(tiers))
        for i, s in enumerate(steps, 1):
            self.assertEqual((s["i"], s["n"], s["status"]), (i, len(tiers), "ok"), s)
            self.assertEqual(s["announcement"], "RESET %d/%d: %s (a motor may twitch)" % (i, len(tiers), s["tier"]))
            self.assertLess(s["announced_utc"], s["sent_utc"])
            self.assertLessEqual(s["sent_utc"], s["recovered_utc"])
            self.assertIsNotNone(s["ticks_ms_after"])
            self.assertIsNotNone(s["reset_cause_after"])
            if s["chip"]:                                        # (a soft reset from an idle prompt may not change the bridge state)
                self.assertTrue(s["bridge_events"], s)
        for s in steps:
            if s["chip"]:
                self.assertLess(s["ticks_ms_after"], 15000, s)
            else:
                self.assertGreater(s["ticks_ms_after"], 3_600_000, "the soft reset keeps ticks_ms growing")
        self.assertEqual(r.report["phases"][-1]["id"], "R")
        self.assertEqual(r.report["phases"][-1]["status"], "pass")
        summary = r.report["reset"]["summary"]
        chips = len([t for t in tiers if t != "soft"])
        self.assertEqual((summary["chip_resets_sent"], summary["chip_resets_observed"], summary["soft_resets_sent"], summary["budget"]),
                         (chips, chips, 1, 5))
        units = chips + tiers.count("hard verify")                       # a verification reserves 2 budget units, the board saw 1 pulse
        self.assertEqual(summary["chip_budget_units_reserved"], units)
        self.assertEqual(summary["text"], "chip resets performed %d / budget 5 (restarts observed %d; %d chip reset request(s), %d budget "
                         "unit(s) reserved); soft resets 1" % (chips, chips, chips, units))
        self.assertIn("RESET PHASE SUMMARY: " + summary["text"], r.text)
        self.assertEqual(len(r.report["reset"]["ledger"]), len(tiers))
        # every message in order, with exactly the allowed arguments
        want = [(SOFT, {})] + [(MACHINE, {"confirmed": True})] * tiers.count("machine")
        want += [(HARD, {"confirmed": True, "verify": True})] * tiers.count("hard verify")
        want += [(HARD, {"confirmed": True, "verify": False})] * tiers.count("hard")
        self.assertEqual([x for x in sent_resets(sent) if x[0] != CAP], want)
        # the same count on the board's own ledger
        self.assertEqual(r.board.events.count("soft_reset"), 1)
        self.assertEqual(resets_of(r.board), chips)
        self.assertEqual(resets_of(r.board, "machine"), tiers.count("machine"))
        self.assertEqual(resets_of(r.board, "pulse"), tiers.count("hard verify") + tiers.count("hard"))
        self.assertTrue(r.left_as_found)
        self.assertFalse(r.final["running"])
        self.assertEqual(r.report["bridge"]["shutdown"], "eof")
        self.assertEqual(r.report["scratch"]["created"], False)

    def test_esp32_machine_twice_then_hard_with_verify_then_hard(self):
        sent, hooks = self.recorder()
        r = self.reset_run("esp32", hooks=hooks)
        self.full_plan_asserts(r, sent)
        rep = r.report["reset"]
        self.assertEqual(rep["capability"]["hard"]["state"], "likely")                  # the R1 read, in full
        self.assertEqual(rep["capability"]["cacheKey"]["uniqueId"], "30aea4123abc")
        self.assertTrue(rep["capability"]["machine"]["available"])
        self.assertEqual([c["before"] for c in rep["capability_reads"]], ["R1", "RESET 2/5 machine", "RESET 3/5 machine",
                                                                          "RESET 4/5 hard verify", "RESET 5/5 hard"])
        self.assertEqual(rep["capability_reads"][-1]["result"]["hard"]["state"], "verified")   # learned by the verification
        verify = rep["steps"][3]
        self.assertIs(verify["verified"], True)
        self.assertTrue(verify["evidence"])
        self.assertEqual(verify["learned"], "verified")
        self.assertEqual(verify["cacheKey"]["uniqueId"], "30aea4123abc")
        self.assertEqual(verify["method"], "rts-pulse")
        plain = rep["steps"][4]
        self.assertIsNone(plain["verified"])
        for s in rep["steps"][1:3]:
            self.assertIn(["connecting", "board-reset"], [[e["state"], e["reason"]] for e in s["bridge_events"]])
            self.assertFalse(s["portDropped"])
        # console: announced one by one before the request, the budget line, the abort-free end
        for i, tier in enumerate(("soft", "machine", "machine", "hard verify", "hard"), 1):
            self.assertRegex(r.text, r"RESET %d/5: %s \(a motor may twitch\)" % (i, tier))
            ann = r.text.index("RESET %d/5: %s (a motor may twitch)" % (i, tier))
            snd = r.text.index("RESET %d/5 %s: sending exactly one request" % (i, tier))
            self.assertLess(ann, snd)
        self.assertNotIn("ABORTED", r.text)
        self.assertIn("RESULT: PASS (exit 0)", r.text)
        # the tripwire knew about the resets it caused
        self.assertEqual(r.report["tripwire"]["trips"], [])
        self.assertIsNone(r.report["trip"])

    def test_the_other_fake_profiles(self):
        cfg_acme = dict(ACME_CFG, expect={"impl": "micropython", "build": "ACME_BOARD", "version_min": [1, 29, 0]},
                        extra_probes=[{"name": "acme_version", "code": "print('@@PROBE', __import__('_acme').version())", "before_after": True}])

        def one(profile):
            sent, hooks = self.recorder()
            return profile, sent, self.reset_run(profile, hooks=hooks, cfg=cfg_acme if profile == "custom-frozen" else None)

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = {p: (sent, r) for p, sent, r in pool.map(one, ["esp8266", "custom-frozen", "esp32s3-usb", "rp2", "unix-like"])}
        sent, r = results["esp8266"]
        self.full_plan_asserts(r, sent)
        self.assertEqual(r.report["identity"]["caps"]["hash"], "none")
        sent, r = results["custom-frozen"]
        self.full_plan_asserts(r, sent)
        self.assertEqual(r.report["identity"]["build"], "ACME_BOARD")
        sent, r = results["esp32s3-usb"]                                                    # the port drops and the client reconnects
        self.full_plan_asserts(r, sent)
        steps = r.report["reset"]["steps"]
        self.assertEqual(r.report["reset"]["capability"]["hard"]["method"], "usb-jtag")
        for s in steps[1:]:
            self.assertTrue(s["portDropped"], s)
            self.assertTrue(s["reconnect"], s)
            self.assertIn("disconnected", [e["state"] for e in s["bridge_events"]], s)
        self.assertEqual(r.board.events.count("pulse"), 2)
        self.assertEqual(r.board.events.of("pulse")[0]["method"], "usb-jtag")
        sent, r = results["rp2"]                                                            # hard is unlikely: skipped with a note
        self.assertEqual(r.code, 0, r.text[-3000:])
        rep = r.report["reset"]
        self.assertEqual([s["tier"] for s in rep["steps"]], ["soft", "machine", "machine"])
        self.assertTrue(all(s["status"] == "ok" for s in rep["steps"]))
        self.assertEqual(rep["capability"]["hard"]["state"], "unlikely")
        self.assertEqual([s["tier"] for s in rep["skipped"]], ["hard"])
        self.assertIn("never forced", rep["skipped"][0]["reason"])
        self.assertEqual(resets_of(r.board), 2)
        self.assertEqual(r.board.events.count("pulse"), 0)
        self.assertEqual([x for x in sent_resets(sent) if x[0] == HARD], [])
        self.assertEqual((rep["summary"]["chip_resets_sent"], rep["summary"]["chip_resets_observed"]), (2, 2))
        sent, r = results["unix-like"]                                                      # machine unsupported: skipped, no abort
        self.assertEqual(r.code, 0, r.text[-3000:])
        rep = r.report["reset"]
        self.assertEqual([s["tier"] for s in rep["steps"]], ["soft"])
        self.assertEqual(sorted(s["tier"] for s in rep["skipped"]), ["hard", "machine"])
        self.assertIsNone(rep["aborted"])
        self.assertFalse(rep["capability"]["machine"]["available"])
        self.assertEqual((resets_of(r.board), r.board.events.count("soft_reset")), (0, 1))
        self.assertEqual([x for x in sent_resets(sent) if x[0] in confine.CHIP_RESET_OPS], [])

    def test_budget_one_stops_after_the_first_chip_reset(self):
        sent, hooks = self.recorder()
        r = self.reset_run("esp32", n=1, hooks=hooks)
        self.assertEqual(r.code, 0, r.text[-3000:])
        rep = r.report["reset"]
        self.assertEqual([s["tier"] for s in rep["steps"]], ["soft", "machine"])
        self.assertEqual(sorted(s["tier"] for s in rep["skipped"]), ["hard", "hard verify", "machine"])
        self.assertTrue(all("budget 1" in s["reason"] for s in rep["skipped"]), rep["skipped"])
        self.assertEqual(resets_of(r.board), 1)
        self.assertEqual(r.board.events.count("pulse"), 0)
        self.assertEqual(rep["summary"]["text"], "chip resets performed 1 / budget 1 (restarts observed 1; 1 chip reset request(s), 1 budget "
                         "unit(s) reserved); soft resets 1")
        self.assertEqual([op for op, _a in sent_resets(sent) if op in confine.CHIP_RESET_OPS], [MACHINE])
        # the harness itself refuses the next one even if a plan asked for it
        self.assertEqual(len(rep["ledger"]), 2)

    def test_budget_four_leaves_out_the_plain_hard_reset(self):
        r = self.reset_run("esp32", n=4)
        self.assertEqual(r.code, 0, r.text[-3000:])
        self.assertEqual([s["tier"] for s in r.report["reset"]["steps"]], ["soft", "machine", "machine", "hard verify"])
        self.assertEqual(resets_of(r.board), 3)                                              # (one pulse; 4 units were reserved)
        self.assertEqual(r.report["reset"]["summary"]["chip_resets_sent"], 3)
        self.assertEqual(r.report["reset"]["summary"]["chip_budget_units_reserved"], 4)
        self.assertEqual([s["tier"] for s in r.report["reset"]["skipped"]], ["hard"])

    def test_budget_three_cannot_pay_for_the_verification_and_leaves_out_both_hard_resets(self):
        r = self.reset_run("esp32", n=3)
        self.assertEqual(r.code, 0, r.text[-3000:])
        self.assertEqual([s["tier"] for s in r.report["reset"]["steps"]], ["soft", "machine", "machine"])
        self.assertEqual(sorted(s["tier"] for s in r.report["reset"]["skipped"]), ["hard", "hard verify"])
        self.assertEqual(resets_of(r.board), 2)
        self.assertEqual(r.board.events.count("pulse"), 0)

    def test_plan_steps_spends_the_budget_in_units(self):
        cap = cap_result()
        for budget, want in ((1, ["soft", "machine"]), (2, ["soft", "machine", "machine"]), (3, ["soft", "machine", "machine"]),
                             (4, ["soft", "machine", "machine", "hard verify"]), (5, ["soft", "machine", "machine", "hard verify", "hard"])):
            steps, skipped = resetphase.plan_steps(cap, budget)
            self.assertEqual([s.tier for s in steps], want, budget)
            units = sum(confine.chip_cost(s.op, s.args) for s in steps)
            self.assertLessEqual(units, budget)
            self.assertEqual(len(steps) + len(skipped), 5, "every planned tier is either a step or a skip note")
        steps, skipped = resetphase.plan_steps(cap_result(machine=False), 2)                 # no machine: verification needs both units
        self.assertEqual([s.tier for s in steps], ["soft", "hard verify"])
        steps, skipped = resetphase.plan_steps(cap_result(machine=False), 1)
        self.assertEqual([s.tier for s in steps], ["soft"])
        self.assertEqual(sorted(s["tier"] for s in skipped), ["hard", "hard verify", "machine"])

    def test_config_budget_cap_is_enforced_end_to_end(self):
        r = self.reset_run("esp32", n=5, cfg=dict(ACME_CFG, allow_resets=2))
        self.assertEqual(r.code, 0, r.text[-3000:])
        self.assertEqual(r.report["reset"]["budget"], 2)
        self.assertEqual(resets_of(r.board), 2)
        self.assertEqual(r.report["config"]["allow_resets"], 2)

    def test_default_announcement_wait_is_three_seconds_before_each_request(self):
        self.assertEqual(resetphase.ANNOUNCE_WAIT_S, 3.0)
        self.assertEqual(resetphase.RECOVER_S, 20.0)
        r = self.reset_run("esp32", n=1, wait=None)
        self.assertEqual(r.code, 0, r.text[-3000:])

        def utc(text):
            return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ")

        for s in r.report["reset"]["steps"]:
            gap = (utc(s["sent_utc"]) - utc(s["announced_utc"])).total_seconds()
            self.assertGreaterEqual(gap, 2.95, s)
            self.assertLess(gap, 10.0)

    def test_a_verification_that_finds_no_reset_skips_the_plain_hard_reset_without_aborting(self):
        fakeboard.register_profile("esp32-nowire", {}, base="esp32", reset_wiring="none")
        self.addCleanup(fakeboard.PROFILES.pop, "esp32-nowire", None)
        r = self.reset_run("esp32-nowire")
        self.assertEqual(r.code, 0, r.text[-3500:])
        rep = r.report["reset"]
        self.assertEqual([(s["tier"], s["status"]) for s in rep["steps"]],
                         [("soft", "ok"), ("machine", "ok"), ("machine", "ok"), ("hard verify", "not-observed")])
        verify = rep["steps"][3]
        self.assertIs(verify["verified"], False)
        self.assertEqual(verify["learned"], "failed")
        self.assertIn("hard", [s["tier"] for s in rep["skipped"]])
        self.assertEqual(r.board.events.count("pulse"), 1)
        self.assertEqual(r.board.events.of("pulse")[0]["effect"], False)
        self.assertEqual(resets_of(r.board), 2)
        self.assertEqual(rep["summary"]["chip_resets_sent"], 3)                          # counted when sent, observed only 2
        self.assertEqual(rep["summary"]["chip_resets_observed"], 2)

    def test_phases_a_to_f_send_no_reset_and_phase_r_writes_nothing(self):
        seen = {}

        def after_phase(pid, board):
            seen[pid] = (resets_of(board), board.events.count("soft_reset"), board.events.count("pulse"))

        sent, hooks = self.recorder()
        hooks["after_phase"] = after_phase
        r = self.reset_run("esp32", phases_="A,B,R", hooks=hooks)
        self.assertEqual(r.code, 0, r.text[-3500:])
        self.assertEqual(seen["A"], (0, 0, 0))
        self.assertEqual(seen["B"], (0, 0, 0))
        self.assertEqual(seen["R"][0], 4)
        first_reset = min(i for i, (op, _a) in enumerate(sent) if op.startswith("reset"))
        self.assertFalse([op for op, _a in sent[first_reset:] if op in ("fs.put", "fs.rm", "fs.rmtree", "fs.mkdir", "fs.mv", "run", "tty.write")])
        self.assertTrue([op for op, _a in sent[:first_reset] if op == "fs.put"], "phase B did write its scratch files before")
        self.assertTrue(r.left_as_found)
        self.assertNotIn(SCRATCH.strip("/"), r.final["dirs"])
        self.assertEqual([p["id"] for p in r.report["phases"]], ["A", "B", "R"])

    def test_every_reset_request_is_one_message(self):
        r = self.reset_run("esp32")
        self.assertEqual(r.code, 0, r.text[-3000:])
        ops = [e["op"] for e in r.report["ops"]["log"]]
        self.assertEqual(ops.count(SOFT), 1)
        self.assertEqual(ops.count(MACHINE), 2)
        self.assertEqual(ops.count(HARD), 2)
        self.assertEqual(r.report["ops"]["by_class"].get("reset-chip"), 4)
        self.assertEqual(r.report["ops"]["by_class"].get("reset-soft"), 1)

    # ---------------------------------------------------------------- abort paths
    def abort_asserts(self, r, resets_on_board, reason_part, chip_sent, running_ok=False):
        self.assertEqual(r.code, 5, r.text[-3500:])
        self.assertEqual(r.report["outcome"], "RESET_ABORTED")
        self.assertEqual(r.report["exit_code"], 5)
        self.assertFalse(r.report["tripped"])
        rep = r.report["reset"]
        self.assertIsNotNone(rep["aborted"], rep)
        self.assertIn(reason_part, rep["aborted"]["reason"])
        self.assertIn("RESET PHASE ABORTED", r.text)
        self.assertIn("RESULT: RESET PHASE ABORTED (exit 5)", r.text)
        self.assertEqual(resets_of(r.board), resets_on_board, "no further reset after the first surprise")
        self.assertEqual(rep["summary"]["chip_resets_sent"], chip_sent)
        self.assertEqual(r.report["phases"][-1]["status"], "aborted")
        self.assertFalse(r.final["dirs"] and SCRATCH.strip("/") in r.final["dirs"], "scratch none")
        self.assertEqual(r.report["scratch"]["created"], False)
        if not running_ok:
            self.assertFalse(r.final["running"])
        self.assertEqual(r.report["bridge"]["shutdown"], "eof")

    def test_abort_when_the_board_does_not_come_back(self):
        sent, hooks = self.recorder()
        state = {"n": 0}

        def on_send(op, args):
            sent.append((op, dict(args)))
            if op == MACHINE:
                state["n"] += 1
                if state["n"] == 1:
                    state["board"].add_fault(("delay_boot", 60.0))        # the next boot sits in boot.py: no prompt for 60 s

        r = self.reset_run("esp32", hooks={"on_send": on_send, "on_board": lambda b: state.update(board=b)}, recover=4.0)
        self.abort_asserts(r, 1, "", 1, running_ok=True)                     # (the stuck boot.py counts as a running program)
        rep = r.report["reset"]
        self.assertTrue(rep["aborted"]["board_lost"], rep["aborted"])
        self.assertEqual([op for op, _a in sent_resets(sent) if op in confine.CHIP_RESET_OPS], [MACHINE], "never retried, never escalated")
        self.assertEqual([s["status"] for s in rep["steps"]], ["ok", "aborted"])
        self.assertTrue(any("did not come back" in x for x in r.report["residue"]), r.report["residue"])
        self.assertEqual(r.report["tripwire"]["trips"], [])

    def test_abort_when_the_identity_differs_after_a_reset(self):
        state = {"n": 0}

        def on_send(op, args):
            if op == MACHINE:
                state["n"] += 1
                if state["n"] == 2:
                    state["board"].profile["unique_id"] = bytes.fromhex("deadbeef0001")      # another board answers after this reset

        r = self.reset_run("esp32", hooks={"on_send": on_send, "on_board": lambda b: state.update(board=b)})
        self.abort_asserts(r, 2, "identity differs", 2)
        self.assertIn("uniqueId", r.report["reset"]["aborted"]["reason"])
        self.assertFalse(r.report["reset"]["aborted"]["board_lost"])
        self.assertEqual(r.board.events.count("pulse"), 0, "no hard reset after the surprise")

    def test_abort_on_a_restart_the_harness_did_not_cause(self):
        state = {"m": 0, "x": 0, "fired": False}

        def on_send(op, args):
            if op == MACHINE:
                state["m"] += 1
                state["x"] = 0
            elif op == "exec" and state["m"] == 1:
                state["x"] += 1
                if state["x"] == 2 and not state["fired"]:          # the pre-send probe of the next step: a second, uncaused reset
                    state["fired"] = True
                    b = state["board"]
                    mark = b.events.mark()
                    b.hard_reset("surprise")
                    b.events.wait_for("hard_reset", 5.0, since=mark, reason="surprise")

        r = self.reset_run("esp32", hooks={"on_send": on_send, "on_board": lambda b: state.update(board=b)})
        self.assertTrue(state["fired"])
        self.abort_asserts(r, 2, "tripwire", 1)                    # one caused reset + the surprise one; the harness sent only one
        self.assertEqual(r.board.events.count("hard_reset", reason="surprise"), 1)
        self.assertEqual(r.board.events.count("pulse"), 0)

    def test_abort_on_an_unexpected_bridge_error(self):
        state = {"n": 0}

        def on_send(op, args):
            if op == MACHINE:
                state["n"] += 1
                if state["n"] == 1:
                    state["board"].unplug("cable pulled")

        r = self.reset_run("esp32", hooks={"on_send": on_send, "on_board": lambda b: state.update(board=b)}, recover=8.0)
        self.assertEqual(r.code, 5, r.text[-3500:])
        self.assertEqual(r.report["outcome"], "RESET_ABORTED")
        self.assertEqual(r.report["reset"]["summary"]["chip_resets_sent"], 1)
        self.assertEqual(r.report["reset"]["summary"]["soft_resets_sent"], 1)
        self.assertLessEqual(resets_of(r.board), 1)
        self.assertEqual(r.board.events.count("pulse"), 0)
        self.assertEqual(r.report["scratch"]["created"], False)

    def test_abort_when_a_backup_file_changed_during_the_phase(self):
        state = {"n": 0}

        def on_send(op, args):
            if op == HARD and args.get("verify") is False:
                state["board"].write_file("/boot.py", "print('changed behind the harness back')\n")

        r = self.reset_run("esp32", hooks={"on_send": on_send, "on_board": lambda b: state.update(board=b)})
        self.abort_asserts(r, 4, "backup files differ", 4)
        self.assertIn("/boot.py", r.report["reset"]["aborted"]["reason"])
        self.assertTrue(any("backup" in x for x in r.report["residue"]), r.report["residue"])


# ===================================================================================================== documentation
class DocsTests(TimedTestCase):
    def test_readme_documents_phase_r_the_gates_exit_code_5_and_the_real_board_command(self):
        with open(os.path.join(HWDIR, "README.md"), encoding="utf-8") as f:
            text = f.read()
        for needle in ("Phase R", "MPY_ALLOW_RESETS=1", "--allow-resets", "allow_resets", "RESET PHASE ABORTED", "| 5 |",
                       "--phases A,R --allow-resets 5", "--allow-real-port", "reset-expected",
                       "MPY_SAFE_MODE=1 MPY_ALLOW_RESETS=1 MPY_REAL_PORT=<port> python3.13 -B tools/hwtest/run_hw.py --port <port> "
                       "--allow-real-port --config <config> --phases A,R --allow-resets 5"):
            self.assertIn(needle, text)

    def test_run_hw_docstring_lists_exit_code_5(self):
        self.assertIn("5 RESET PHASE ABORTED", run_hw.__doc__)
        self.assertIn("MPY_ALLOW_RESETS", run_hw.__doc__)


if __name__ == "__main__":
    unittest.main()
