"""Adversarial review 4 of the reset tiers (D-16). Fake boards and in-process servers only; never a serial port.

Each test asserts the SAFE behaviour; a failing test is a reproduced finding.
Run: export MPY_SAFE_MODE=1; python3.13 -B -m unittest tests.adversarial4.test_reset_adversarial
"""
from __future__ import annotations

import threading
import time
import unittest

from bridge import resetcap
from tests.bridge_client import BridgeTestCase
from tests.support import TimedTestCase, wait_until
from tests.test_reset_tiers import BoardCase, InProc, resets
from tools.fakeboard import FakeLineDriver, derive_profile


def total_resets(b):
    return b.events.count("hard_reset") + b.events.count("soft_reset") + b.events.count("pulse")


class QueueBindingTests(BridgeTestCase):
    DEADLINE_S = 90

    def test_a_queued_confirmed_machine_reset_must_not_run_on_a_different_board(self):
        """The user confirmed a reboot of board A. Behind a slow op the request waits; disconnect + connect (priority 1) jump
        the queue, so the confirmed reset would run against board B."""
        a = self.new_board("esp32")
        b = self.new_board("esp32")
        c = self.new_bridge()
        c.call("connect", port=a.url)
        c.call("identity")
        rid_exec = c.send("exec", code="import time\ntime.sleep(2.0)\nprint('slept')")
        wait_until(lambda: a.program_running, 8.0, "the slow exec to start on board A")
        rid_reset = c.send("reset.machine", confirmed=True)
        rid_disc = c.send("disconnect")
        rid_conn = c.send("connect", port=b.url)
        res = {n: c.result(r, 40.0) for n, r in (("exec", rid_exec), ("reset", rid_reset), ("disc", rid_disc), ("conn", rid_conn))}
        self.assertEqual(a.events.count("hard_reset"), 0, res)
        self.assertEqual(b.events.count("hard_reset"), 0,
                         "the confirmed reset of board A rebooted board B: %r" % (res,))

    def test_stop_storm_and_cancel_around_a_confirmed_machine_reset_never_add_resets(self):
        board, c, _ = self.connected("esp32")
        c.call("identity")
        rid = c.send("reset.machine", confirmed=True)
        stops = [c.send("stop") for _ in range(30)]
        cid = c.send("cancel", target=rid)
        for s in stops + [cid, rid]:
            c.result(s, 60.0)
        c.ping()
        self.assertLessEqual(board.events.count("hard_reset"), 1)
        self.assertEqual(board.events.count("soft_reset"), 0, "a Ctrl-D landed on an empty raw buffer or friendly prompt")
        self.assertEqual(board.events.count("pulse"), 0)

    def test_eof_while_a_confirmed_reset_waits_behind_a_slow_op_resets_nothing(self):
        board, c, _ = self.connected("esp32")
        c.call("identity")
        c.send("exec", code="import time\ntime.sleep(1.5)\nprint('slept')")
        wait_until(lambda: board.program_running, 8.0, "the slow exec to start")
        c.send("reset.machine", confirmed=True)
        c.close()                                   # stdin EOF: the client died after asking
        self.assertEqual(board.events.count("hard_reset"), 0, "a request from a dead client rebooted the board")

    def test_sigterm_and_sighup_while_a_confirmed_reset_waits_reset_nothing(self):
        import signal
        for sig in (signal.SIGTERM, signal.SIGHUP):
            with self.subTest(sig=sig):
                board, c, _ = self.connected("esp32")
                c.call("identity")
                c.send("exec", code="import time\ntime.sleep(1.5)\nprint('slept')")
                wait_until(lambda: board.program_running, 8.0, "the slow exec to start")
                c.send("reset.machine", confirmed=True)
                c.proc.send_signal(sig)
                c.wait_exit(20.0)
                self.assertEqual(total_resets(board), 0, "a signal shutdown let a queued reset through")

    def test_run_source_with_machine_reset_costs_exactly_one_reset_and_the_resync_adds_none(self):
        board, c, _ = self.connected("esp32")
        c.call("identity")
        c.send("run", source="import machine\nprint('before')\nmachine.reset()\n")
        for _ in range(4):
            c.request("fs.list", path="/", _timeout=40.0)
        c.request("exec", code="print(1)", interrupt=True, _timeout=40.0)
        c.ping()
        self.assertEqual(board.events.count("hard_reset"), 1, "one reset is the program's own; the bridge added more")
        self.assertEqual(board.events.count("pulse"), 0)

    def test_tty_write_control_bytes_at_an_idle_prompt(self):
        board, c, _ = self.connected("esp32")
        c.call("identity")
        c.call("repl.attach")
        for byte in (b"\x01", b"\x02", b"\x03", b"\x05"):
            c.tty_write(byte)
        c.call("exec", code="print(1)")
        self.assertEqual(total_resets(board), 0)

    def test_tty_write_ctrl_c_plus_ctrl_b_ctrl_d_during_a_bridge_owned_raw_op_is_not_a_reset(self):
        """FIXED (review 4, finding 4): tty.write containing a Ctrl-C used to bypass the hold buffer WHOLE, so a trailing
        Ctrl-B + Ctrl-D left the raw REPL and soft-reset the board in the middle of the bridge-owned conversation. Now only
        the Ctrl-C goes through; Ctrl-B/Ctrl-D are held like any typed-ahead key and replayed AFTER the op (the user typed
        them: that soft reset is by design, a chip reset never). The exact bytes are pinned deterministically in
        tests.test_reset_tiers.HardeningTests; this is the end-to-end check."""
        board, c, _ = self.connected("esp32")
        c.call("identity")
        rid = c.send("exec", code="import time\ntime.sleep(2.0)\nprint('slept')")
        wait_until(lambda: board.program_running, 8.0, "the slow exec to start")
        c.tty_write(b"\x03\x02\x04")
        r = c.result(rid, 30.0)
        self.assertTrue(r.get("ok"), r)
        self.assertIn("KeyboardInterrupt", r.get("err", ""), "the exec conversation ended cleanly with its interrupt: %r" % (r,))
        wait_until(lambda: board.events.count("soft_reset") >= 1, 10.0, "the replayed Ctrl-D (after the op)")
        c.request("fs.list", path="/", interrupt=True, _timeout=30.0)
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("soft_reset"), 1, "exactly the one the user typed")
        self.assertEqual(board.events.count("pulse"), 0)


class HardResetTests(BoardCase):
    DEADLINE_S = 90

    def test_pulling_the_cable_during_a_verification_is_not_evidence_that_the_lines_work(self):
        b = self.board(derive_profile("esp32", reset_wiring="none"))
        ip = InProc(self, b, driver=False)

        class Unplug(FakeLineDriver):
            def pulse(self, method, ser=None):
                self.board.pulse(method)          # wiring "none": nothing happens to the chip
                self.board.stop()                 # ... and the cable is pulled
        from bridge import link as linkmod
        linkmod.register_line_driver(b.url, Unplug(b))
        self.addCleanup(linkmod.unregister_line_driver, b.url)
        ip.connect()
        ip.ok("identity")
        r = ip.req("reset.hard", confirmed=True, verify=True, learned=None)
        self.assertEqual(resets(b), 0)
        verified = bool(r.get("ok")) and r.get("verified") is True
        self.assertFalse(verified, "an unplug was cached as 'verified': %r" % (r,))
        self.assertNotEqual(ip.srv._learned.get(next(iter(ip.srv._learned), None)), "verified")

    def test_nonbool_confirmations_never_reach_the_board(self):
        b = self.board("esp32")
        ip = InProc(self, b)
        ip.connect()
        ip.ok("identity")
        for op in ("reset.machine", "reset.hard"):
            for bad in ("true", "True", 1, 1.0, [True], {"confirmed": True}, "yes", None, 0, ""):
                for extra in ({}, {"interrupt": True, "force": True, "verify": True}):
                    with self.subTest(op=op, confirmed=bad, extra=extra):
                        r = ip.req(op, confirmed=bad, **extra)
                        self.assertFalse(r.get("ok"), r)
                        self.assertEqual(r["error"]["code"], "E_PROTOCOL", r)
        self.assertEqual(total_resets(b), 0)

    def test_odd_argument_types_with_a_true_confirmation_are_rejected_not_executed(self):
        b = self.board("esp32")
        ip = InProc(self, b)
        ip.connect()
        ip.ok("identity")
        before = total_resets(b)
        for args in ({"verify": "true"}, {"force": 1}, {"method": ["rts-pulse"]}, {"method": "RTS-PULSE"}, {"method": {"a": 1}},
                     {"learned": ["verified"]}, {"learned": True}, {"learned": "VERIFIED"}, {"method": "none"}):
            with self.subTest(args=args):
                r = ip.req("reset.hard", confirmed=True, **args)
                self.assertFalse(r.get("ok"), r)
        self.assertEqual(total_resets(b), before)

    def test_learned_verified_cannot_enable_a_pulse_on_a_url_transport(self):
        b = self.board("rp2")
        ip = InProc(self, b, driver=False)
        ip.connect()
        ip.ok("identity")
        for args in ({"learned": "verified"}, {"learned": "verified", "force": True}, {"learned": "verified", "method": "rts-pulse", "force": True},
                     {"verify": True, "force": True, "method": "usb-jtag"}):
            with self.subTest(args=args):
                r = ip.req("reset.hard", confirmed=True, **args)
                self.assertFalse(r.get("ok"), r)
                self.assertEqual(r["error"]["code"], "E_UNSUPPORTED", r)
        self.assertEqual(total_resets(b), 0)


class QueueBindingInProcessTests(BoardCase):
    DEADLINE_S = 90

    def test_a_queued_confirmed_hard_reset_must_not_pulse_a_different_board(self):
        """Same race as the machine-reset one, for the RTS tier: the pulse is delivered to whatever board is connected when
        the queued request finally runs."""
        import json
        from bridge import link as linkmod
        a, b = self.board("esp32"), self.board("esp32")
        ip = InProc(self, a)
        linkmod.register_line_driver(b.url, b.line_driver())
        self.addCleanup(linkmod.unregister_line_driver, b.url)
        ip.connect()
        ip.ok("identity")
        srv = ip.srv
        srv._worker = threading.Thread(target=srv._worker_main, daemon=True)
        srv._worker.start()
        self.addCleanup(srv.queue.close)

        def post(rid, op, **args):
            srv.dispatch_line(json.dumps(dict(args, id=rid, op=op)).encode("utf-8"))

        def answer(rid):
            wait_until(lambda: any(e.get("id") == rid for e in ip.sink.events), 40.0, "response %d" % rid)
            return [e for e in ip.sink.events if e.get("id") == rid][0]
        post(101, "exec", code="import time\ntime.sleep(1.5)\nprint('slept')")
        wait_until(lambda: a.program_running, 8.0, "the slow exec to start")
        post(102, "reset.hard", confirmed=True)
        post(103, "disconnect")
        post(104, "connect", port=b.url)
        got = [answer(i) for i in (101, 102, 103, 104)]
        self.assertEqual(resets(a), 0, got)
        self.assertEqual((b.events.count("pulse"), resets(b)), (0, 0), "the confirmed pulse for board A hit board B: %r" % (got,))


class LearnedKeyTests(BoardCase):
    DEADLINE_S = 90

    def test_a_verification_made_before_identity_was_read_must_not_apply_to_other_boards(self):
        """The cache key is (vid, pid, uniqueId); with uniqueId None it is just the adapter, shared by every board that has it."""
        from bridge import link as linkmod
        good = self.board("esp32")                                         # wired for auto-reset
        bad = self.board(derive_profile("esp32", reset_wiring="none"))     # same CP210x ids, no auto-reset transistors
        ip = InProc(self, good)
        ip.connect()
        r = ip.ok("reset.hard", confirmed=True, verify=True)               # identity never read
        self.assertIs(r["verified"], True)
        ip.ok("disconnect")
        linkmod.register_line_driver(bad.url, bad.line_driver())
        self.addCleanup(linkmod.unregister_line_driver, bad.url)
        ip.ok("connect", port=bad.url)
        cap = ip.ok("reset.capability")
        self.assertNotEqual(cap["hard"]["state"], "verified", "the unwired board inherited 'verified': %r" % (cap,))


class OddOpenPolicyTests(BridgeTestCase):
    DEADLINE_S = 90

    def test_odd_open_policies_never_reset_a_url_board(self):
        board = self.new_board("esp32")
        c = self.new_bridge()
        for pol in ("AUTO", " default", "default\n", ["auto"], {}, 5, True, "V2", "v3", "dtr", "reset", "hard", "rts-pulse"):
            with self.subTest(policy=pol):
                resp = c.request("connect", port=board.url, openPolicy=pol)
                if resp.get("ok"):
                    c.call("disconnect")
                    wait_until(lambda: board.connected == 0, 5.0, "the fake board to be free")
        for pol in (None, "", "auto", "default", "url", "pty", "win-cp210x"):
            with self.subTest(policy=pol):
                resp = c.request("connect", port=board.url, openPolicy=pol)
                if resp.get("ok"):
                    c.call("disconnect")
                    wait_until(lambda: board.connected == 0, 5.0, "the fake board to be free")
        self.assertEqual(total_resets(board), 0)


class VerifyFalseNegativeTests(BoardCase):
    DEADLINE_S = 90

    def test_a_working_pulse_is_verified_even_when_the_rom_log_is_unreadable(self):
        """ESP8266 prints its ROM log at 74880 baud (garbage at 115200). The MicroPython banner + a restarted ticks_ms still
        prove the reset; a 'failed' here would hide the rescue tier for a working board."""
        b = self.board(derive_profile("esp32", rom_noise=b"\xfe\xff garbage\r\n"))
        ip = InProc(self, b)
        ip.connect()
        ip.ok("identity")
        b.device.t_power -= 120.0                      # the board has been up for two minutes
        r = ip.req("reset.hard", confirmed=True, verify=True)
        self.assertEqual(resets(b), 1)
        self.assertTrue(r.get("ok") and r.get("verified") is True, "a working pulse was recorded as not observed: %r" % (r,))

    def test_a_working_pulse_on_a_just_started_board_is_not_failed(self):
        """before = a few seconds of uptime: 'after' (boot + listen windows) is not smaller than 'before', and no ROM text."""
        b = self.board(derive_profile("esp32", rom_noise=b"\xfe\xff garbage\r\n"))
        ip = InProc(self, b)
        ip.connect()
        ip.ok("identity")
        r = ip.req("reset.hard", confirmed=True, verify=True)
        self.assertEqual(resets(b), 1)
        self.assertTrue(r.get("ok") and r.get("verified") is True, "a working pulse was recorded as not observed: %r" % (r,))


class CliTests(BridgeTestCase):
    DEADLINE_S = 120

    def test_cli_nonbool_confirmations_do_not_reset(self):
        from tests.bridge_client import run_cli
        board = self.new_board("esp32")
        for op in ("reset.machine", "reset.hard"):
            for val in ("1", "yes", '"true"', "[true]", "True", "null", "", "{}"):
                wait_until(lambda: board.connected == 0, 5.0, "the fake board to be free")
                rc, out, err = run_cli(op, "confirmed=" + val, "--port", board.url, timeout=40.0)
                self.assertNotEqual(rc, 0, (op, val, out, err))
        wait_until(lambda: board.connected == 0, 5.0, "the fake board to be free")
        self.assertEqual(total_resets(board), 0)


class EstimatorProbeTests(TimedTestCase):
    def test_estimator_survives_odd_adapter_values(self):
        for vid in (None, 0, -1, True, False, 2 ** 40, 0x10C4, 0xFFFF, "10c4", 4292.0):     # str/float: review 4 finding 5 (was TypeError)
            for pid in (None, 0, -1, True, 2 ** 40, 0xEA60, "ea60", 60000.0):
                for plat in (None, "", "ESP32", " esp32 ", 5, ["esp32"], b"esp32"):
                    for kind in ("device", "pty", "url", None, "bogus"):
                        with self.subTest(vid=vid, pid=pid, plat=plat, kind=kind):
                            r = resetcap.estimate(vid, pid, plat, kind)
                            self.assertIn(r["state"], resetcap.STATES)

    def test_table_rows_do_not_leak_into_neighbours(self):
        # a CP210x with another PID, an FTDI with another PID, a CH340-family with another PID are NOT in the table
        for vid, pid in ((0x10C4, 0xEA70), (0x0403, 0x6014), (0x1A86, 0x7522), (0x303A, 0x1001)):
            r = resetcap.estimate(vid, pid, "esp32", "device")
            if (vid, pid) != (0x303A, 0x1001):
                self.assertNotEqual(r["state"], "likely", (vid, pid, r))
        # 0xF055 / unknown-vendor boards never get 'likely'
        self.assertNotEqual(resetcap.estimate(0xF055, 0x9802, "esp32", "device")["state"], "likely")


if __name__ == "__main__":
    unittest.main()
