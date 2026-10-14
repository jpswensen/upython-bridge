"""test_reset_tiers.py - the three reset tiers of D-16 / docs/protocol-addendum-reset.md (RQ-RESET-1..5).

Never opens a serial port: fake boards over socket://127.0.0.1:PORT, the fake board's line-driver seam (the stand-in for
DTR/RTS) and the bridge as a child process. Sections:

  EstimatorTableTests       resetcap.estimate: one assertion per row of the addendum's table (pure)
  LinkConfirmTests          the Link itself refuses a reset without the RESET_CONFIRMED token (nothing reaches the board)
  CallSitePinTests          AST pins: no code path from Stop / connect / disconnect / run / auto-sync to any reset
  InProcessHardResetTests   reset.capability and reset.hard (+ verify) against fake boards, server called in-process
  BridgeProcessTests        reset.capability / reset.machine / Stop / consent through the real NDJSON bridge process
  ScenarioCatalogueLedger   OPT-IN (MPY_SLOW_LEDGER=1, ~3.5 min): the whole scenario catalogue causes 0 chip resets

Run:  export MPY_SAFE_MODE=1; python3.13 -B -m unittest tests.test_reset_tiers
"""
from __future__ import annotations

import ast
import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from bridge import link as linkmod
from bridge import resetcap, server
from bridge.errors import CODES, CODES_V11, HINTS, BridgeError
from bridge.link import RESET_CONFIRMED, Link
from tests.bridge_client import BridgeTestCase
from tests.support import TimedTestCase, child_env, wait_until
from tools.fakeboard import PROFILES, PROGRAMS, FakeBoard, FakeLineDriver, derive_profile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (vid, pid) of the addendum's table
CP210X, CH340, CH9102, CH343 = (0x10C4, 0xEA60), (0x1A86, 0x7523), (0x1A86, 0x55D4), (0x1A86, 0x55D3)
FTDI = [(0x0403, 0x6001), (0x0403, 0x6010), (0x0403, 0x6015)]
JTAG = (0x303A, 0x1001)


def _state(r, **kw):
    for k, v in kw.items():
        assert r[k] == v, (k, r)
    return r


# ============================================================================ the estimator table (pure)

class EstimatorTableTests(TimedTestCase):
    def test_uart_bridges_on_esp_platforms_are_likely_rts_pulse(self):
        for vp in [CP210X, CH340, CH9102, CH343] + FTDI:
            for plat in ("esp32", "esp8266", "ESP32"):
                with self.subTest(adapter=vp, platform=plat):
                    r = resetcap.estimate(vp[0], vp[1], plat, "device")
                    self.assertEqual((r["state"], r["method"], r["basis"]), ("likely", "rts-pulse", "adapter"), r)

    def test_uart_bridges_on_other_or_unknown_platforms_are_unknown_rts_pulse(self):
        for vp in [CP210X, CH340, CH9102, CH343] + FTDI:
            for plat in ("rp2", "pyboard", "linux", "", None):
                with self.subTest(adapter=vp, platform=plat):
                    r = resetcap.estimate(vp[0], vp[1], plat, "device")
                    self.assertEqual((r["state"], r["method"], r["basis"]), ("unknown", "rts-pulse", "adapter"), r)

    def test_espressif_usb_serial_jtag(self):
        r = resetcap.estimate(*JTAG, "esp32", "device")
        self.assertEqual((r["state"], r["method"], r["basis"]), ("likely", "usb-jtag", "adapter"))
        for plat in (None, "rp2"):
            r = resetcap.estimate(*JTAG, plat, "device")
            self.assertEqual((r["state"], r["method"]), ("unknown", "usb-jtag"), plat)

    def test_other_espressif_native_usb_is_unknown_with_no_method(self):
        for pid in (0x4001, 0x0002, 0x1000):
            for plat in ("esp32", None, "rp2"):
                r = resetcap.estimate(0x303A, pid, plat, "device")
                self.assertEqual((r["state"], r["method"], r["basis"]), ("unknown", "none", "adapter"), (pid, plat, r))

    def test_native_usb_families_are_unlikely_for_any_platform(self):
        for vid in (0x2E8A, 0x0483, 0x239A, 0x04D8, 0x1915, 0xF055):
            for plat in ("rp2", "esp32", None):
                r = resetcap.estimate(vid, 0x0005, plat, "device")
                self.assertEqual((r["state"], r["method"], r["basis"]), ("unlikely", "none", "adapter"), (vid, plat, r))

    def test_anything_else_is_unknown_rts_pulse(self):
        for vid, pid in [(0x1234, 0x5678), (0x10C4, 0xEA71), (0x1A86, 0x0001), (None, None), (None, 0xEA60)]:
            for plat in ("esp32", None):
                r = resetcap.estimate(vid, pid, plat, "device")
                self.assertEqual((r["state"], r["method"], r["basis"]), ("unknown", "rts-pulse", "adapter"), (vid, pid, plat, r))

    def test_url_and_pty_transports_are_unlikely_whatever_the_adapter_and_whatever_was_learned(self):
        for kind in ("url", "pty"):
            for vp in [CP210X, JTAG, (None, None), (0x2E8A, 5)]:
                for learned in (None, "verified", "failed"):
                    r = resetcap.estimate(vp[0], vp[1], "esp32", kind, learned)
                    self.assertEqual((r["state"], r["method"], r["basis"]), ("unlikely", "none", "transport"), (kind, vp, learned, r))

    def test_learned_wins_over_the_adapter_estimate_for_a_device(self):
        v = resetcap.estimate(*CP210X, "esp32", "device", "verified")
        self.assertEqual((v["state"], v["method"], v["basis"]), ("verified", "rts-pulse", "learned"))
        f = resetcap.estimate(*CP210X, "esp32", "device", "failed")
        self.assertEqual((f["state"], f["method"], f["basis"]), ("failed", "rts-pulse", "learned"))
        # an adapter whose estimate has no method still gets one once the user verified it
        v2 = resetcap.estimate(0x2E8A, 5, "rp2", "device", "verified")
        self.assertEqual((v2["state"], v2["method"]), ("verified", "rts-pulse"))
        # the usb-jtag method is kept
        self.assertEqual(resetcap.estimate(*JTAG, "esp32", "device", "verified")["method"], "usb-jtag")

    def test_every_combination_is_well_formed_and_the_function_is_pure(self):
        seen = []
        for vp in [CP210X, CH340, JTAG, (0x303A, 0x4001), (0x2E8A, 5), (0x1234, 1), (None, None)]:
            for plat in ("esp32", "esp8266", "rp2", None, "  "):
                for kind in ("device", "pty", "url"):
                    for learned in (None, "verified", "failed"):
                        r = resetcap.estimate(vp[0], vp[1], plat, kind, learned)
                        self.assertEqual(set(r), {"state", "method", "reason", "basis"})
                        self.assertIn(r["state"], resetcap.STATES)
                        self.assertIn(r["method"], resetcap.METHODS)
                        self.assertIn(r["basis"], ("learned", "adapter", "transport"))
                        self.assertTrue(r["reason"].strip())
                        seen.append(r)
        r = resetcap.estimate(*CP210X, "esp32", "device")
        r["state"] = "tampered"
        self.assertEqual(resetcap.estimate(*CP210X, "esp32", "device")["state"], "likely")

    def test_an_invalid_learned_value_is_a_programming_error(self):
        with self.assertRaises(ValueError):
            resetcap.estimate(*CP210X, "esp32", "device", "probably")

    def test_the_ui_offers_hard_reset_only_for_verified_or_likely(self):
        self.assertEqual(set(resetcap.HARD_STATES_OFFERED), {"verified", "likely"})

    def test_new_error_code_is_declared_with_a_hint_and_cannot_be_mistyped(self):
        self.assertIn("E_RESET_NOT_OBSERVED", CODES_V11)
        self.assertTrue(HINTS["E_RESET_NOT_OBSERVED"].strip())
        self.assertEqual(BridgeError("E_RESET_NOT_OBSERVED", "x").code, "E_RESET_NOT_OBSERVED")
        self.assertNotIn("E_RESET_NOT_OBSERVED", CODES)  # tests.test_link pins CODES to the v1 list (see errors.py)


# ============================================================================ helpers for board-backed tests

class _Sink(object):
    """Stands in for the protocol channel of an in-process Server: collects the NDJSON lines it emits."""

    def __init__(self):
        self.lock = threading.Lock()
        self.events = []
        self._buf = b""

    def write(self, view):
        with self.lock:
            self._buf += bytes(view)
            while b"\n" in self._buf:
                line, self._buf = self._buf.split(b"\n", 1)
                try:
                    self.events.append(json.loads(line.decode("utf-8")))
                except ValueError:
                    pass
        return len(view)

    def flush(self):
        pass

    def of(self, ev):
        with self.lock:
            return [e for e in self.events if e.get("ev") == ev]


class InProc(object):
    """A bridge Server driven in-process (Server.call: the same op code the worker runs, minus the queue)."""

    def __init__(self, case, board, driver=True):
        self.board = board
        self.sink = _Sink()
        self.srv = server.Server(out=self.sink)
        self.logs = []
        self.srv.log = lambda level, msg: self.logs.append((level, msg))   # keep the test output quiet
        self.url = board.url
        if driver:
            linkmod.register_line_driver(board.url, board.line_driver())
            case.addCleanup(linkmod.unregister_line_driver, board.url)
        case.addCleanup(self.close)
        case.addWatchdogCleanup(self.close)

    def close(self):
        self.srv.shutdown_sequence("test")

    def req(self, op, **args):
        return self.srv.call(dict(args, op=op))

    def ok(self, op, **args):
        r = self.req(op, **args)
        assert r.get("ok"), (op, r)
        return r

    def fail(self, op, code, **args):
        r = self.req(op, **args)
        assert not r.get("ok"), (op, "unexpectedly succeeded", r)
        assert r["error"]["code"] == code, (op, code, r["error"])
        return r["error"]

    def connect(self):
        end = time.monotonic() + 8.0
        while True:
            r = self.req("connect", port=self.url)
            if r.get("ok") or time.monotonic() > end:
                assert r.get("ok"), r
                return r
            wait_until(lambda: self.board.connected == 0, 3.0, "the fake board to release the old client")

    def states(self, since=0):
        return [(e["state"], e.get("reason")) for e in self.sink.of("state")][since:]


def resets(board, **match):
    return board.events.count("hard_reset", **match)


class BoardCase(TimedTestCase):
    DEADLINE_S = 90

    def board(self, profile="esp32", **kw):
        b = FakeBoard(profile=profile, **kw)
        b.start()
        self.addCleanup(b.stop)
        return b


# ============================================================================ Link level: the confirm token

class LinkConfirmTests(BoardCase):
    def link_to(self, board, driver=True):
        if driver:
            linkmod.register_line_driver(board.url, board.line_driver())
            self.addCleanup(linkmod.unregister_line_driver, board.url)
        lk = Link()
        self.addCleanup(lk.close)
        self.addWatchdogCleanup(lk.close)
        lk.open(board.url)
        lk.sync_to_prompt(100, 100)
        return lk

    def test_hard_reset_without_the_token_raises_and_sends_nothing(self):
        b = self.board(capture=True)
        lk = self.link_to(b)
        before = len(b.rx_data())
        for bad in (None, True, 1, "confirmed", "yes", object(), {"confirmed": True}, "RESET_CONFIRMED"):
            with self.subTest(confirm=bad):
                with self.assertRaises(BridgeError) as cm:
                    lk.hard_reset(confirm=bad)
                self.assertEqual(cm.exception.code, "E_PROTOCOL")
        with self.assertRaises(BridgeError) as cm:
            lk.hard_reset()
        self.assertEqual(cm.exception.code, "E_PROTOCOL")
        self.assertEqual(b.events.count("pulse"), 0)
        self.assertEqual(resets(b), 0)
        self.assertEqual(len(b.rx_data()), before, "bytes reached the board")

    def test_machine_reset_without_the_token_raises_and_sends_nothing(self):
        b = self.board(capture=True)
        lk = self.link_to(b, driver=False)
        lk.enter_raw()
        before = len(b.rx_data())
        for bad in (None, True, 1, "confirmed", object()):
            with self.subTest(confirm=bad):
                with self.assertRaises(BridgeError) as cm:
                    lk.machine_reset(confirm=bad)
                self.assertEqual(cm.exception.code, "E_PROTOCOL")
        with self.assertRaises(BridgeError):
            lk.machine_reset()
        self.assertEqual(resets(b), 0)
        self.assertEqual(len(b.rx_data()), before, "bytes reached the board")
        self.assertNotIn(b"machine.reset", b.rx_data())

    def test_machine_reset_needs_the_raw_repl_and_never_sends_ctrl_d_into_a_friendly_prompt(self):
        b = self.board(capture=True)
        lk = self.link_to(b, driver=False)       # friendly mode
        before = len(b.rx_data())
        with self.assertRaises(BridgeError) as cm:
            lk.machine_reset(confirm=RESET_CONFIRMED)
        self.assertEqual(cm.exception.code, "E_INTERNAL")
        self.assertEqual(len(b.rx_data()), before)
        self.assertEqual((resets(b), b.events.count("soft_reset")), (0, 0))

    def test_hard_reset_on_a_url_without_a_line_driver_is_unsupported_even_with_the_token(self):
        b = self.board(capture=True)
        lk = self.link_to(b, driver=False)
        before = len(b.rx_data())
        for method in (None, "rts-pulse", "usb-jtag"):
            with self.assertRaises(BridgeError) as cm:
                lk.hard_reset(confirm=RESET_CONFIRMED, method=method)
            self.assertEqual(cm.exception.code, "E_UNSUPPORTED", method)
        with self.assertRaises(BridgeError) as cm:
            lk.hard_reset(confirm=RESET_CONFIRMED, method="smoke-signals")
        self.assertEqual(cm.exception.code, "E_UNSUPPORTED")
        self.assertEqual((b.events.count("pulse"), resets(b)), (0, 0))
        self.assertEqual(len(b.rx_data()), before)

    def test_with_the_token_and_a_driver_the_pulse_is_exactly_one_hard_reset_of_the_right_kind(self):
        b = self.board()
        lk = self.link_to(b)
        verdict = lk.hard_reset(confirm=RESET_CONFIRMED, wait=3.0)
        self.assertEqual(verdict, "prompt")
        self.assertEqual(b.events.count("pulse", method="rts-pulse", effect=True), 1)
        self.assertEqual(resets(b), 1)
        self.assertEqual(resets(b, via="pulse", reason="rts-pulse"), 1)
        self.assertEqual(b.events.count("soft_reset"), 0)
        self.assertIn(b"POWERON_RESET", lk.sync_bytes)
        self.assertEqual(b.device.reset_cause, 1)

    def test_machine_reset_through_the_raw_repl_is_exactly_one_hard_reset_via_machine(self):
        b = self.board()
        lk = self.link_to(b, driver=False)
        lk.enter_raw()
        res = lk.machine_reset(confirm=RESET_CONFIRMED)
        self.assertTrue(res["ack"])
        self.assertFalse(res["dropped"])
        self.assertEqual(lk.sync_to_prompt(200, 200), "prompt")
        self.assertEqual(resets(b), 1)
        self.assertEqual(resets(b, via="machine", reason="machine.reset"), 1)
        self.assertEqual(b.events.count("pulse"), 0)
        self.assertEqual(b.events.count("soft_reset"), 0)
        self.assertEqual(b.device.reset_cause, 1)

    def test_the_reset_ledger_sees_every_chip_reset_and_only_those(self):
        """The catalogue-wide check below is only worth something if the ledger is not blind."""
        fd, ledger = tempfile.mkstemp(prefix="reset-ledger-unit-", suffix=".jsonl")
        os.close(fd)
        self.addCleanup(os.unlink, ledger)
        with mock.patch.dict(os.environ, {"MPY_FAKEBOARD_RESET_LEDGER": ledger}):
            b = self.board()
            lk = self.link_to(b)
            lk.hard_reset(confirm=RESET_CONFIRMED, wait=3.0)                       # pulse
            lk.soft_reset_friendly(wait=2.0)                                       # soft: not a chip reset
            lk.enter_raw()
            lk.machine_reset(confirm=RESET_CONFIRMED)                              # machine
            lk.sync_to_prompt(200, 200)
            b.hard_reset("manual")                                                 # the test API
            b.wait_idle(5.0)
        with open(ledger, encoding="utf-8") as f:
            vias = [json.loads(x)["via"] for x in f if x.strip()]
        self.assertEqual(vias, ["pulse", "machine", "test"])

    def test_machine_reset_of_a_board_without_machine_reset_is_unsupported_not_a_hang(self):
        b = self.board("unix-like")
        lk = self.link_to(b, driver=False)
        lk.enter_raw()
        with self.assertRaises(BridgeError) as cm:
            lk.machine_reset(confirm=RESET_CONFIRMED)
        self.assertEqual(cm.exception.code, "E_UNSUPPORTED")
        self.assertEqual(resets(b), 0)


# ============================================================================ no path from Stop & friends to a reset

def _calls_by_function(path, cls=None):
    """{function name: set of attribute/function names it calls} for a module (methods of every class, flattened)."""
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    out = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names = set()
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call):
                    fn = sub.func
                    names.add(fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", ""))
                elif isinstance(sub, ast.Name):
                    names.add(sub.id)
                elif isinstance(sub, ast.Attribute):
                    names.add(sub.attr)
            out.setdefault(node.name, set()).update(names)
    return out


class CallSitePinTests(TimedTestCase):
    """RQ-RESET-5 / RQ-SAFE-2: a reset above soft has exactly one road in: the explicit op."""

    SERVER = os.path.join(ROOT, "bridge", "server.py")
    LINK = os.path.join(ROOT, "bridge", "link.py")

    def test_server_calls_the_tier_methods_only_from_the_explicit_ops(self):
        calls = _calls_by_function(self.SERVER)
        for tier in ("hard_reset", "machine_reset"):
            users = sorted(fn for fn, names in calls.items() if tier in names)
            allowed = {"hard_reset": ["_pulse"], "machine_reset": ["op_reset_machine"]}[tier]
            self.assertEqual(users, allowed, "%s is called from %s" % (tier, users))
        self.assertEqual(sorted(fn for fn, names in calls.items() if "_pulse" in names and fn != "_pulse"),
                         ["_verify_hard_reset", "op_reset_hard"])
        self.assertEqual(sorted(fn for fn, names in calls.items() if "_verify_hard_reset" in names and fn != "_verify_hard_reset"),
                         ["op_reset_hard"])
        # the token itself is handled by these functions only
        self.assertEqual(sorted(fn for fn, names in calls.items() if "RESET_CONFIRMED" in names), ["_pulse", "op_reset_machine"])

    def test_nothing_that_stops_connects_disconnects_runs_or_syncs_reaches_a_reset(self):
        calls = _calls_by_function(self.SERVER)
        forbidden = {"hard_reset", "machine_reset", "_pulse", "_verify_hard_reset", "op_reset_hard", "op_reset_machine",
                     "RESET_CONFIRMED"}
        safe = ["op_stop", "_after_stop", "_resync", "_arm_watchdog", "_interrupt_async", "op_connect", "op_disconnect",
                "shutdown_sequence", "op_run", "_borrow", "_file_op", "_verify_idle", "op_reconcile", "_queue_reconcile",
                "op_clean_orphans", "op_tty_write", "_replay_held", "op_repl_attach", "op_repl_detach", "_enqueue",
                "dispatch_line", "_worker_main", "op_reset_soft", "op_exec", "op_identity", "_on_link_dead", "op_config",
                "op_cancel", "op_ping", "op_reset_capability", "_hard_capability", "_machine_capability"]
        for fn in safe:
            self.assertIn(fn, calls, fn)
            self.assertFalse(calls[fn] & forbidden, "%s reaches %s" % (fn, sorted(calls[fn] & forbidden)))

    def test_op_table_marks_only_the_explicit_ops_as_resets(self):
        self.assertIn("reset.machine", server._OPS)
        self.assertIn("reset.hard", server._OPS)
        self.assertEqual(server._OPS["reset.capability"][1:3], ("inline", 0))
        self.assertTrue(server._OPS["reset.machine"][3], "reset.machine must be gated like other ops that need an idle board")
        for op in ("stop", "connect", "disconnect", "run", "reset.soft", "repl.attach"):
            self.assertNotIn(server._OPS[op][0], ("op_reset_machine", "op_reset_hard"), op)

    def test_link_drives_lines_and_sends_machine_reset_only_inside_the_tier_methods(self):
        calls = _calls_by_function(self.LINK)
        # the pulse (line driver or policy steps for the pulse table) lives in hard_reset only
        self.assertEqual(sorted(fn for fn, names in calls.items() if names & {"HARD_RESET_STEPS", "USB_JTAG_RESET_STEPS"}),
                         ["hard_reset"])
        self.assertEqual(sorted(fn for fn, names in calls.items() if "pulse" in names), ["hard_reset"])
        with open(self.LINK, encoding="utf-8") as f:
            src = f.read()
        self.assertEqual(src.count("b\"import machine\\nmachine.reset()\\n\""), 1)
        for fn in ("interrupt", "_wait_prompt", "sync_to_prompt", "enter_raw", "exit_raw", "close", "open", "_run", "_send_code"):
            self.assertFalse(calls[fn] & {"hard_reset", "machine_reset", "HARD_RESET_STEPS", "USB_JTAG_RESET_STEPS", "pulse"}, fn)
        # both tiers check the token before touching the board
        for fn in ("hard_reset", "machine_reset"):
            self.assertIn("_require_confirm", calls[fn], fn)


# ============================================================================ capability + reset.hard, server in-process

class InProcessHardResetTests(BoardCase):
    DEADLINE_S = 120

    def test_capability_per_fake_profile_with_a_line_driver(self):
        expect = {
            "esp32": ("likely", "rts-pulse"), "esp32-legacy": ("likely", "rts-pulse"), "esp8266": ("likely", "rts-pulse"),
            "custom-frozen": ("likely", "rts-pulse"), "esp32s3-usb": ("likely", "usb-jtag"),
            "rp2": ("unlikely", "none"), "rp2350": ("unlikely", "none"), "stm32": ("unlikely", "none"),
        }
        for name, (state, method) in expect.items():
            with self.subTest(profile=name):
                b = self.board(name)
                ip = InProc(self, b)
                ip.connect()
                ip.ok("identity")
                cap = ip.ok("reset.capability")
                self.assertIs(cap["soft"], True)
                self.assertEqual((cap["hard"]["state"], cap["hard"]["method"], cap["hard"]["basis"]),
                                 (state, method, "adapter"), cap)
                self.assertTrue(cap["hard"]["reason"].strip())
                self.assertEqual(cap["machine"]["available"], True, cap)
                self.assertEqual(cap["cacheKey"]["vid"], PROFILES[name]["usb"]["vid"])
                self.assertEqual(cap["cacheKey"]["uniqueId"], PROFILES[name]["unique_id"].hex())
                self.assertEqual((resets(b), b.events.count("pulse")), (0, 0), "capability must not pulse or reset")
                ip.close()

    def test_capability_without_a_line_driver_is_unlikely_by_transport_and_unix_like_has_no_machine_reset(self):
        for name, machine_ok in (("esp32", True), ("unix-like", False)):
            with self.subTest(profile=name):
                b = self.board(name)
                ip = InProc(self, b, driver=False)
                ip.connect()
                cap0 = ip.ok("reset.capability")                    # identity not read yet
                self.assertTrue(cap0["machine"]["available"])
                self.assertIn("identity", cap0["machine"]["reason"])
                ip.ok("identity")
                cap = ip.ok("reset.capability")
                self.assertEqual((cap["hard"]["state"], cap["hard"]["method"], cap["hard"]["basis"]),
                                 ("unlikely", "none", "transport"))
                self.assertEqual(cap["machine"]["available"], machine_ok, cap)
                self.assertEqual(b.events.count("soft_reset") + resets(b), 0)
                ip.close()

    def test_capability_takes_the_clients_learned_value_and_validates_it(self):
        b = self.board("esp32")
        ip = InProc(self, b)
        ip.connect()
        ip.ok("identity")
        cap = ip.ok("reset.capability", learned="failed")["hard"]
        self.assertEqual((cap["state"], cap["basis"]), ("failed", "learned"))
        cap = ip.ok("reset.capability", learned="verified")["hard"]
        self.assertEqual((cap["state"], cap["basis"], cap["method"]), ("verified", "learned", "rts-pulse"))
        self.assertEqual(ip.ok("reset.capability", learned=None)["hard"]["state"], "likely")
        for bad in ("maybe", True, 1, []):
            ip.fail("reset.capability", "E_PROTOCOL", learned=bad)
        ip.close()
        self.assertEqual(ip.req("reset.capability")["error"]["code"], "E_NOT_CONNECTED")

    def test_unconfirmed_resets_are_refused_at_the_protocol_level_before_anything_happens(self):
        b = self.board("esp32")
        ip = InProc(self, b)
        ip.connect()
        n = len(ip.states())
        for op in ("reset.hard", "reset.machine"):
            for extra in ({}, {"confirmed": False}, {"confirmed": "true"}, {"confirmed": 1}, {"confirmed": None},
                          {"confirmed": [True]}, {"verify": True}, {"force": True}, {"interrupt": True}):
                with self.subTest(op=op, args=extra):
                    err = ip.fail(op, "E_PROTOCOL", **extra)
                    self.assertIn("confirmed", err["message"] + err["detail"] + err["hint"])
        self.assertEqual(ip.states()[n:], [])
        self.assertEqual((resets(b), b.events.count("pulse"), b.events.count("soft_reset")), (0, 0, 0))

    def test_reset_hard_with_verify_succeeds_on_auto_reset_wiring_and_returns_the_caching_hint(self):
        b = self.board("esp32")
        ip = InProc(self, b)
        ip.connect()
        ident = ip.ok("identity")
        b.device.t_power -= 120.0                         # the board has been up for two minutes
        n = len(ip.states())
        r = ip.ok("reset.hard", confirmed=True, verify=True)
        self.assertIs(r["verified"], True)
        self.assertIn("boot-text", r["evidence"])
        self.assertIn("uptime-restarted", r["evidence"])
        self.assertEqual(r["learned"], "verified")                   # the caching hint for the client's storage
        self.assertEqual(r["method"], "rts-pulse")
        self.assertEqual(r["cacheKey"], {"vid": 0x10C4, "pid": 0xEA60, "uniqueId": ident["uniqueId"]})
        # exactly one pulse, exactly one chip reset of the right kind
        self.assertEqual(b.events.count("pulse"), 1)
        self.assertEqual(b.events.count("pulse", effect=True), 1)
        self.assertEqual(resets(b), 1)
        self.assertEqual(resets(b, via="pulse"), 1)
        self.assertEqual(b.events.count("soft_reset"), 0)
        # state events: back to `connecting` for the reset (reason board-reset), then an evidence-based idle
        states = ip.states()[n:]
        self.assertIn(("connecting", "board-reset"), states)
        self.assertEqual(states[-1][0], "idle")
        self.assertEqual(ip.srv.state, "idle")
        # the board really restarted and the bridge can talk to it again without any further reset
        out = ip.ok("exec", code="import time\nprint('T', time.ticks_ms())")["out"]
        self.assertLess(int(out.split()[1]), 20000)
        self.assertEqual(resets(b), 1)
        # the session remembers the verification: the capability now says verified
        cap = ip.ok("reset.capability")["hard"]
        self.assertEqual((cap["state"], cap["basis"]), ("verified", "learned"))

    def test_reset_hard_with_verify_finds_no_reset_when_the_wiring_is_absent(self):
        b = self.board(derive_profile("esp32", reset_wiring="none"))
        ip = InProc(self, b)
        ip.connect()
        ident = ip.ok("identity")
        b.device.t_power -= 120.0
        err = ip.fail("reset.hard", "E_RESET_NOT_OBSERVED", confirmed=True, verify=True)
        self.assertEqual(err["learned"], "failed")                   # ... and the hint to cache
        self.assertEqual(err["cache_key"], {"vid": 0x10C4, "pid": 0xEA60, "uniqueId": ident["uniqueId"]})
        self.assertEqual(err["evidence"], [])
        self.assertTrue(err["hint"].strip())
        self.assertEqual(b.events.count("pulse"), 1)
        self.assertEqual(b.events.count("pulse", effect=False), 1)
        self.assertEqual(resets(b), 0)
        self.assertEqual(ip.srv.state, "idle", "the board was never reset and the bridge re-synced to its prompt")
        ip.ok("exec", code="print(1)")
        # learned: failed -> the option is hidden and a plain request is refused without touching the lines
        cap = ip.ok("reset.capability")["hard"]
        self.assertEqual((cap["state"], cap["basis"]), ("failed", "learned"))
        ip.fail("reset.hard", "E_UNSUPPORTED", confirmed=True)
        self.assertEqual(b.events.count("pulse"), 1)

    def test_reset_hard_refusals_by_state_method_and_transport(self):
        b = self.board("rp2")                                            # unlikely / none
        ip = InProc(self, b)
        ip.connect()
        ip.fail("reset.hard", "E_UNSUPPORTED", confirmed=True)
        ip.fail("reset.hard", "E_UNSUPPORTED", confirmed=True, force=True)         # force does not invent a method
        ip.fail("reset.hard", "E_UNSUPPORTED", confirmed=True, method="none", force=True)
        ip.fail("reset.hard", "E_PROTOCOL", confirmed=True, method="smoke")
        ip.fail("reset.hard", "E_PROTOCOL", confirmed=True, verify="yes")
        self.assertEqual((b.events.count("pulse"), resets(b)), (0, 0))
        b2 = self.board("esp32")                                         # likely, but the caller says method none
        ip2 = InProc(self, b2)
        ip2.connect()
        ip2.fail("reset.hard", "E_UNSUPPORTED", confirmed=True, method="none")
        ip2.fail("reset.hard", "E_UNSUPPORTED", confirmed=True, learned="failed")
        self.assertEqual((b2.events.count("pulse"), resets(b2)), (0, 0))
        b3 = self.board("esp32")                                         # URL without a registered driver
        ip3 = InProc(self, b3, driver=False)
        ip3.connect()
        for extra in ({}, {"force": True}, {"method": "rts-pulse", "force": True}, {"verify": True}):
            ip3.fail("reset.hard", "E_UNSUPPORTED", confirmed=True, **extra)
        self.assertEqual((b3.events.count("pulse"), resets(b3), b3.events.count("soft_reset")), (0, 0, 0))

    def test_forced_pulse_on_an_unlikely_board_reaches_the_lines_and_changes_nothing(self):
        b = self.board("rp2")
        ip = InProc(self, b)
        ip.connect()
        with mock.patch.object(server, "HARD_RESET_LISTEN_S", 0.6):
            r = ip.ok("reset.hard", confirmed=True, force=True, method="rts-pulse")
        self.assertIsNone(r["verified"])
        self.assertEqual(r["evidence"], [])
        self.assertEqual((b.events.count("pulse", effect=False), resets(b)), (1, 0))

    def test_native_usb_hard_reset_drops_the_port_and_is_verified_by_reenumeration(self):
        b = self.board("esp32s3-usb")
        ip = InProc(self, b)
        ip.connect()
        ip.ok("identity")
        n = len(ip.states())
        r = ip.ok("reset.hard", confirmed=True, verify=True)
        self.assertIs(r["verified"], True)
        self.assertEqual(r["method"], "usb-jtag")
        self.assertEqual(r["evidence"], ["port-re-enumerated"])
        self.assertTrue(r["reconnect"])
        self.assertEqual(ip.states()[n:][-1], ("disconnected", "board-reset"))
        self.assertNotIn(("disconnected", "unplugged"), ip.states())
        self.assertEqual((b.events.count("pulse", method="usb-jtag", effect=True), resets(b, via="pulse")), (1, 1))
        # the client reconnects (bounded, same port) and finds a restarted board
        ip.connect()
        self.assertLess(int(ip.ok("exec", code="import time\nprint('T', time.ticks_ms())")["out"].split()[1]), 20000)
        self.assertEqual(resets(b), 1)

    def test_a_pulse_that_leaves_the_chip_in_the_rom_bootloader_is_repeated_once_then_marked_unsafe(self):
        b = self.board(derive_profile("esp32", rom_noise=b"rst:0x1 (POWERON_RESET),boot:0x3 (DOWNLOAD_BOOT)\r\nwaiting for download\r\n"))
        ip = InProc(self, b)
        ip.connect()
        ip.ok("identity")                                  # a result is only learned per board (unique id known)
        r = ip.ok("reset.hard", confirmed=True, verify=True)
        self.assertIs(r["verified"], False)
        self.assertIs(r["unsafeSequence"], True)
        self.assertEqual(r["method"], "unsafe-sequence")
        self.assertEqual(r["learned"], "failed")
        self.assertIn("waiting-for-download", r["evidence"])
        self.assertEqual(b.events.count("pulse"), 2)       # one repeat, no more
        self.assertEqual(resets(b), 2)

    def test_reset_hard_without_verify_reports_what_it_saw_but_does_not_claim_verification(self):
        b = self.board("esp32")
        ip = InProc(self, b)
        ip.connect()
        r = ip.ok("reset.hard", confirmed=True)
        self.assertIsNone(r["verified"])
        self.assertIn("boot-text", r["evidence"])
        self.assertEqual((b.events.count("pulse"), resets(b, via="pulse")), (1, 1))
        self.assertEqual(ip.srv.state, "idle")

    def test_hard_reset_works_on_a_hung_board_that_ignores_ctrl_c(self):
        b = self.board("esp32")
        ip = InProc(self, b)
        ip.connect()
        b.add_fault("ignore_ctrl_c")
        b.write_file("/hang.py", "while True:\n    pass\n")
        ip.ok("tty.write", b64=base64.b64encode(b"import hang\r\n").decode("ascii"))   # now the board is stuck in a tight loop
        self.assertTrue(b.wait_running(5.0))
        self.assertFalse(ip.srv.link.interrupt(timeout=0.5), "the loop ignores Ctrl-C")
        r = ip.ok("reset.hard", confirmed=True)
        self.assertEqual(resets(b, via="pulse"), 1)
        self.assertIn("boot-text", r["evidence"])


# ============================================================================ review 4 regressions (adversarial4/test_reset_adversarial.py)

class _RecLink(object):
    """Just enough of a Link for Server.op_tty_write: records what would reach the board."""

    def __init__(self):
        self.writes = []

    def write(self, data):
        self.writes.append(bytes(data))


class ConfirmationBindingTests(BoardCase):
    """A confirmation is for ONE connection: a reset queued behind a slow op never runs on the board that connected after it."""

    def test_a_reset_stamped_before_a_disconnect_and_connect_is_refused_and_sends_nothing(self):
        for op, extra, driver in (("reset.machine", {}, False), ("reset.hard", {}, True), ("reset.hard", {"verify": True}, True)):
            with self.subTest(op=op, extra=extra):
                a, b = self.board("esp32"), self.board("esp32")
                ip = InProc(self, a, driver=False)
                linkmod.register_line_driver(a.url, a.line_driver())
                linkmod.register_line_driver(b.url, b.line_driver())
                self.addCleanup(linkmod.unregister_line_driver, a.url)
                self.addCleanup(linkmod.unregister_line_driver, b.url)
                ip.connect()
                ip.ok("identity")
                req = server.Request(77, op, dict(extra, confirmed=True))
                req.conn_gen = ip.srv._conn_gen        # what Server._enqueue stamps when the request arrives
                ip.ok("disconnect")
                self.assertTrue(ip.req("connect", port=b.url).get("ok"))
                resp = ip.srv.handle(req)              # the worker reaches it only now
                self.assertFalse(resp["ok"], resp)
                self.assertEqual(resp["error"]["code"], "E_CANCELLED", resp)
                self.assertTrue(resp["error"]["hint"].strip())
                self.assertEqual((resets(a), resets(b), a.events.count("pulse"), b.events.count("pulse")), (0, 0, 0, 0))
                ip.close()

    def test_every_connect_disconnect_and_lost_link_invalidates_pending_confirmations(self):
        b = self.board("esp32")
        ip = InProc(self, b)
        seen = [ip.srv._conn_gen]
        ip.connect()
        seen.append(ip.srv._conn_gen)
        ip.srv._on_link_dead(BridgeError("E_NO_DEVICE", "the board went away"))
        seen.append(ip.srv._conn_gen)
        ip.ok("disconnect")
        seen.append(ip.srv._conn_gen)
        self.assertEqual(seen, sorted(set(seen)), "each step must move the generation: %r" % (seen,))
        self.assertEqual(len(set(seen)), 4)

    def test_a_reset_stamped_on_the_current_connection_still_runs(self):
        b = self.board("esp32")
        ip = InProc(self, b)
        ip.connect()
        ip.ok("identity")
        req = server.Request(78, "reset.machine", {"confirmed": True})
        req.conn_gen = ip.srv._conn_gen
        resp = ip.srv.handle(req)
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(resets(b), 1)

    def test_enqueue_stamps_the_reset_ops_and_only_them(self):
        b = self.board("esp32")
        ip = InProc(self, b)
        ip.connect()
        ip.srv.dispatch_line(json.dumps({"id": 1, "op": "reset.machine", "confirmed": True}).encode("utf-8"))
        ip.srv.dispatch_line(json.dumps({"id": 2, "op": "reset.hard", "confirmed": True}).encode("utf-8"))
        ip.srv.dispatch_line(json.dumps({"id": 3, "op": "fs.list", "path": "/"}).encode("utf-8"))
        queued = ip.srv.queue.take_where(lambda r: True)
        self.assertEqual([(r.op, r.conn_gen) for r in queued],
                         [("reset.machine", ip.srv._conn_gen), ("reset.hard", ip.srv._conn_gen), ("fs.list", None)])
        self.assertEqual(resets(b), 0)


class UnplugAndCacheKeyTests(BoardCase):
    """reset.hard verify:true: an unplug is not evidence, and a result is only recorded per board (unique id known)."""

    def unplugging_board(self):
        b = self.board(derive_profile("esp32", reset_wiring="none"))     # CP210x ids, the pulse changes nothing

        class Unplug(FakeLineDriver):
            def pulse(self, method, ser=None):
                self.board.pulse(method)
                self.board.stop()                                        # ... and the cable is pulled
        linkmod.register_line_driver(b.url, Unplug(b))
        self.addCleanup(linkmod.unregister_line_driver, b.url)
        return b

    def test_an_unplug_behind_a_uart_bridge_is_neither_verified_nor_failed(self):
        b = self.unplugging_board()
        ip = InProc(self, b, driver=False)
        ip.connect()
        ip.ok("identity")
        n = len(ip.states())
        r = ip.ok("reset.hard", confirmed=True, verify=True)
        self.assertIsNone(r["verified"], r)
        self.assertIsNone(r["learned"], r)
        self.assertEqual(r["evidence"], [])
        self.assertFalse(r["reconnect"])
        self.assertEqual(ip.srv._learned, {})
        self.assertEqual(ip.states()[n:][-1], ("disconnected", "unplugged"), "a vanished UART bridge is an unplug, not a reset")
        self.assertEqual(resets(b), 0)

    def test_an_unplug_after_a_plain_hard_reset_behind_a_uart_bridge_claims_no_reenumeration(self):
        b = self.unplugging_board()
        ip = InProc(self, b, driver=False)
        ip.connect()
        r = ip.ok("reset.hard", confirmed=True)
        self.assertEqual((r["verified"], r["evidence"], r["portDropped"], r["reconnect"]), (None, [], True, False), r)
        self.assertEqual(ip.states()[-1], ("disconnected", "unplugged"))

    def test_a_verification_is_recorded_only_when_the_board_identity_is_known(self):
        with mock.patch.object(server, "VERIFY_WINDOW_S", 0.6):
            b = self.board("esp32")
            ip = InProc(self, b)
            ip.connect()
            r = ip.ok("reset.hard", confirmed=True, verify=True)                 # identity never read
            self.assertIs(r["verified"], True)
            self.assertIsNone(r["learned"], "a null-uniqueId key would be shared by every board behind this adapter")
            self.assertIsNone(r["cacheKey"]["uniqueId"])
            self.assertEqual(ip.srv._learned, {})
            self.assertEqual(ip.ok("reset.capability")["hard"]["basis"], "adapter")
            ip.ok("identity")
            r = ip.ok("reset.hard", confirmed=True, verify=True)                 # the same, with the identity read
            self.assertEqual((r["verified"], r["learned"]), (True, "verified"))
            self.assertIsNotNone(r["cacheKey"]["uniqueId"])
            cap = ip.ok("reset.capability")["hard"]
            self.assertEqual((cap["state"], cap["basis"]), ("verified", "learned"))

    def test_a_failed_verification_without_identity_tells_the_client_to_cache_nothing(self):
        with mock.patch.object(server, "VERIFY_WINDOW_S", 0.6):
            b = self.board(derive_profile("esp32", reset_wiring="none"))
            ip = InProc(self, b)
            ip.connect()
            err = ip.fail("reset.hard", "E_RESET_NOT_OBSERVED", confirmed=True, verify=True)
            self.assertNotIn("learned", err)
            self.assertEqual(ip.srv._learned, {})
            ip.ok("identity")
            err = ip.fail("reset.hard", "E_RESET_NOT_OBSERVED", confirmed=True, verify=True)
            self.assertEqual(err["learned"], "failed")
            self.assertEqual(ip.ok("reset.capability")["hard"]["state"], "failed")


class HardeningTests(TimedTestCase):
    def test_estimate_treats_non_integer_ids_as_unknown_instead_of_raising(self):
        for vid, pid in (("10c4", "ea60"), (4292.0, 60000.0), (True, False), (-1, 5), (2 ** 40, 1), (None, "x"), ([], {}), (0x10C4, "ea60")):
            with self.subTest(vid=vid, pid=pid):
                r = resetcap.estimate(vid, pid, "esp32", "device")
                self.assertIn(r["state"], resetcap.STATES)
                if vid != 0x10C4:
                    self.assertEqual((r["state"], r["method"]), ("unknown", "rts-pulse"), r)
        self.assertEqual(resetcap.estimate("10c4", "ea60", "esp32", "device", "verified")["state"], "verified")

    def test_native_usb_is_the_set_of_boards_whose_port_vanishes_on_a_chip_reset(self):
        for vid in (0x303A, 0x2E8A, 0x0483, 0xF055, 0x239A, 0x04D8, 0x1915):
            self.assertTrue(resetcap.native_usb(vid), hex(vid))
        for vid in (0x10C4, 0x1A86, 0x0403, 0x1234, None, True, "303a", 0x303A + 2 ** 16, -1, 4.0):
            self.assertFalse(resetcap.native_usb(vid), repr(vid))

    def test_tty_write_in_a_bridge_owned_raw_op_lets_only_ctrl_c_through(self):
        srv = server.Server(out=_Sink())
        srv.log = lambda level, msg: None
        srv.link = rec = _RecLink()
        srv.state = "rawop"

        def write(data):
            return srv.call({"op": "tty.write", "b64": base64.b64encode(data).decode("ascii")})
        self.assertTrue(write(b"ab")["ok"])
        self.assertEqual((rec.writes, bytes(srv._held)), ([], b"ab"))
        self.assertTrue(write(b"\x03\x02\x04")["ok"])                  # a Ctrl-C with a Ctrl-B Ctrl-D behind it
        self.assertEqual(rec.writes, [b"\x03"], "only the Ctrl-C may enter the bridge-owned raw-REPL conversation")
        self.assertEqual(bytes(srv._held), b"ab\x02\x04", "the rest waits for the replay, in order")
        self.assertTrue(write(b"\x03\x03")["ok"])
        self.assertEqual(rec.writes, [b"\x03", b"\x03\x03"])
        srv.state = "idle"                                               # bytes still held: later writes queue behind them
        self.assertTrue(write(b"x\x03y")["ok"])
        self.assertEqual((rec.writes[-1], bytes(srv._held)), (b"\x03", b"ab\x02\x04xy"))
        srv._held = bytearray()
        self.assertTrue(write(b"x\x03\x04")["ok"])                      # idle and nothing held: the whole write goes out
        self.assertEqual(rec.writes[-1], b"x\x03\x04")

    def test_tty_write_that_does_not_fit_the_hold_buffer_still_delivers_its_ctrl_c(self):
        srv = server.Server(out=_Sink())
        srv.log = lambda level, msg: None
        srv.link = rec = _RecLink()
        srv.state = "rawop"
        srv._held = bytearray(b"z" * (server.HELD_TTY_MAX - 1))
        resp = srv.call({"op": "tty.write", "b64": base64.b64encode(b"\x03\x03xy").decode("ascii")})
        self.assertFalse(resp["ok"], resp)
        self.assertEqual(resp["error"]["code"], "E_PROTOCOL")
        self.assertEqual(resp["error"]["accepted"], 2)
        self.assertEqual(rec.writes, [b"\x03\x03"], "Stop always reaches the board")
        self.assertEqual(len(srv._held), server.HELD_TTY_MAX - 1, "nothing of the refused part was kept")


# ============================================================================ the bridge as a process

class BridgeProcessTests(BridgeTestCase):
    DEADLINE_S = 150

    TICKS = "import time\nprint('T', time.ticks_ms())"

    def ticks(self, c):
        return int(c.call("exec", code=self.TICKS)["out"].split()[1])

    def test_capability_over_the_wire(self):
        board, c, _ = self.connected("esp32")
        c.call("identity")
        cap = c.call("reset.capability")
        self.assertIs(cap["soft"], True)
        self.assertEqual(cap["machine"]["available"], True)
        self.assertEqual((cap["hard"]["state"], cap["hard"]["method"], cap["hard"]["basis"]), ("unlikely", "none", "transport"))
        self.assertEqual(c.call("reset.capability", learned="verified")["hard"]["state"], "unlikely")  # a URL has no record
        c.fail("reset.capability", "E_PROTOCOL", learned="sure")
        self.assertEqual(board.events.count("hard_reset") + board.events.count("soft_reset") + board.events.count("pulse"), 0)
        c.call("disconnect")
        c.fail("reset.capability", "E_NOT_CONNECTED")

    def test_machine_reset_on_esp32_restarts_the_board_and_the_bridge_resyncs_without_another_reset(self):
        board, c, _ = self.connected("esp32")
        c.call("identity")
        board.device.t_power -= 120.0
        self.assertGreater(self.ticks(c), 100000)
        m = c.mark()
        r = c.call("reset.machine", confirmed=True, _timeout=30)
        self.assertEqual(r["phase"], "sent")
        self.assertFalse(r["portDropped"])
        self.assertEqual(r["sync"], "prompt")
        sts = [(e["state"], e.get("reason")) for e in c.events_of("state", m)]
        self.assertIn(("connecting", "board-reset"), sts)
        self.assertEqual(sts[-1][0], "idle")
        self.assertNotIn("disconnected", [s for s, _ in sts])
        self.assertEqual(board.events.count("hard_reset"), 1)
        self.assertEqual(board.events.count("hard_reset", via="machine", reason="machine.reset"), 1)
        self.assertEqual((board.events.count("pulse"), board.events.count("soft_reset")), (0, 0))
        self.assertEqual(board.device.reset_cause, 1)
        # "reconnect works": the same link serves file ops, and a clean disconnect + connect also works
        self.assertLess(self.ticks(c), 20000, "uptime restarted")
        c.call("fs.list", path="/")
        c.call("disconnect")
        self.reconnect(c, board)
        self.assertLess(self.ticks(c), 30000)
        self.assertEqual(board.events.count("hard_reset"), 1)
        self.assertGreater(board.events.count("raw_enter"), 0)

    def test_machine_reset_on_a_native_usb_board_drops_the_port_with_reason_board_reset(self):
        board, c, _ = self.connected("esp32s3-usb")
        c.call("identity")
        board.device.t_power -= 120.0
        m = c.mark()
        r = c.call("reset.machine", confirmed=True, _timeout=30)
        self.assertEqual(r["phase"], "sent")
        self.assertTrue(r["portDropped"])
        self.assertTrue(r["reconnect"])
        ev = c.wait_event("state", lambda e: e.get("state") == "disconnected", 10, since=m)
        self.assertEqual(ev.get("reason"), "board-reset")
        self.assertNotIn("unplugged", [e.get("reason") for e in c.events_of("state", m)])
        self.assertEqual(board.events.count("hard_reset", via="machine"), 1)
        self.assertEqual(board.events.count("pulse"), 0)
        c.fail("fs.list", "E_NOT_CONNECTED", path="/")
        self.reconnect(c, board)
        self.assertLess(self.ticks(c), 30000, "the re-enumerated board restarted")
        self.assertEqual(board.events.count("hard_reset"), 1, "reconnecting must not reset again")
        c.call("fs.list", path="/")

    def test_machine_reset_needs_confirmed_true_and_consent_for_a_running_program(self):
        board, c, _ = self.connected("esp32")
        for extra in ({}, {"confirmed": False}, {"confirmed": "true"}, {"confirmed": 1}, {"interrupt": True}):
            c.fail("reset.machine", "E_PROTOCOL", **extra)
        c.fail("reset.hard", "E_PROTOCOL", interrupt=True)
        self.assertEqual(board.events.count("hard_reset"), 0)
        rid = self.start_program(c, PROGRAMS["sleep_loop"], "loop.py")
        err = c.fail("reset.machine", "E_PROGRAM_RUNNING", confirmed=True)       # asks first, like a file op
        self.assertTrue(err.get("needs_interrupt"))
        self.assertEqual(board.events.count("hard_reset"), 0)
        r = c.call("reset.machine", confirmed=True, interrupt=True, _timeout=40)  # consent given
        self.assertEqual(r["phase"], "sent")
        self.assertEqual(c.result(rid, 15)["ok"], True)
        self.assertEqual(board.events.count("hard_reset", via="machine"), 1)
        self.assertEqual(board.events.count("soft_reset"), 1, "the Run's own soft reset only")
        self.assertLess(self.ticks(c), 20000)

    def test_machine_reset_on_a_firmware_without_it_is_unsupported_and_leaves_the_board_idle(self):
        board, c, _ = self.connected("unix-like")
        c.call("identity")
        err = c.fail("reset.machine", "E_UNSUPPORTED", confirmed=True)
        self.assertTrue(err["hint"].strip())
        self.assertEqual(board.events.count("hard_reset"), 0)
        c.call("fs.list", path="/")

    def test_hard_reset_on_a_url_without_a_line_driver_is_unsupported_over_the_wire(self):
        board, c, _ = self.connected("esp32")
        for extra in ({}, {"force": True}, {"verify": True}, {"method": "rts-pulse", "force": True}):
            c.fail("reset.hard", "E_UNSUPPORTED", confirmed=True, **extra)
        self.assertEqual((board.events.count("pulse"), board.events.count("hard_reset")), (0, 0))

    def test_stop_never_escalates_to_a_reset(self):
        board, c, _ = self.connected("esp32")
        for i in range(20):
            rid = self.start_program(c, PROGRAMS["sleep_loop"], "loop%d.py" % i)
            self.assertTrue(c.call("stop")["stopped"])
            self.assertEqual(c.result(rid, 15)["ok"], True)
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("pulse"), 0)
        self.assertEqual(board.events.count("soft_reset"), 20, "one per Run (its fresh VM), nothing from Stop")

    def test_stop_of_a_program_that_ignores_ctrl_c_reports_it_and_still_does_not_reset(self):
        board, c, _ = self.connected("esp32")
        rid = self.start_program(c, PROGRAMS["swallow_ctrl_c"], "swallow.py", ready=b"loop")
        for _ in range(3):
            self.assertFalse(c.call("stop", timeoutMs=300)["stopped"])
        self.assertEqual((board.events.count("hard_reset"), board.events.count("pulse")), (0, 0))
        board.soft_reset("test cleanup")                    # the test (not the bridge) ends the program
        c.result(rid, 15)

    def test_connect_files_run_and_disconnect_never_use_a_tier_above_soft(self):
        board, c, _ = self.connected("esp32")
        d = self.local_dir()
        path = self.write_local(d, "a.py", "print('hello from a')\n")
        c.call("identity")
        c.call("reset.capability")
        c.call("fs.put", local=path, remote="/a.py")
        c.call("fs.manifest", root="/")
        c.call("fs.get", remote="/a.py", local=os.path.join(d, "back.py"))
        self.assertEqual(c.call("run", local=path)["exit"], "ok")
        c.call("repl.attach")
        c.call("tty.write", b64="MQ0=")
        c.call("repl.detach")
        c.call("disconnect")
        self.reconnect(c, board)
        c.call("disconnect")
        self.assertEqual((board.events.count("hard_reset"), board.events.count("pulse")), (0, 0))
        self.assertEqual(board.events.count("soft_reset"), 1, "only the Run's fresh VM")


# ============================================================================ the whole catalogue (opt-in, slow)

@unittest.skipUnless(os.environ.get("MPY_SLOW_LEDGER") == "1",
                     "opt-in (~3.5 min): MPY_SLOW_LEDGER=1 runs tests.test_scenarios and checks the fake board's reset ledger")
class ScenarioCatalogueLedger(TimedTestCase):
    DEADLINE_S = 900

    def test_the_scenario_catalogue_causes_no_chip_reset_and_no_pulse(self):
        fd, ledger = tempfile.mkstemp(prefix="reset-ledger-", suffix=".jsonl")
        os.close(fd)
        self.addCleanup(lambda: os.path.exists(ledger) and os.unlink(ledger))
        proc = subprocess.Popen([sys.executable, "-B", "-X", "utf8", "-m", "unittest", "tests.test_scenarios"], cwd=ROOT,
                                env=child_env(MPY_FAKEBOARD_RESET_LEDGER=ledger), stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        self.addWatchdogCleanup(lambda: proc.poll() is None and proc.kill())
        out, _ = proc.communicate(timeout=800)
        tail = out.decode("utf-8", "replace")[-1500:]
        self.assertEqual(proc.returncode, 0, tail)
        with open(ledger, encoding="utf-8") as f:
            lines = [json.loads(x) for x in f if x.strip()]
        self.assertEqual(lines, [], "the scenario catalogue reset a chip: %r" % (lines[:5],))


if __name__ == "__main__":
    unittest.main()
