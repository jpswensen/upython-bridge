"""Fault-injection scenarios through the BRIDGE process (docs/protocol.md; Appendix G #5, #8, #10, #13, #14, #15).

The fake board (tools/fakeboard.py) injects the faults; the bridge is a black box (tests/bridge_client.py).  A fault test
passes when the bridge answers with the documented error / state, never hangs, never resets the board by itself
(RQ-SAFE-1/2) and the board is usable again afterwards where the fault allows it.

    export MPY_SAFE_MODE=1
    timeout 600 python3.13 -B -m unittest tests.test_scenarios_faults
"""
from __future__ import annotations

import time
import unittest

from tests.bridge_client import BridgeTestCase
from tests.support import deadline, wait_until
from tests.test_scenarios import pseudo_random, sha, tmp_files
from tools.fakeboard import PROGRAMS


class NoiseAtConnectTests(BridgeTestCase):
    def test_garbage_before_the_banner_does_not_wedge_or_corrupt_the_stream(self):
        """G#14: line noise (invalid UTF-8, ROM boot text) before the prompt: connect succeeds, the noise is never mistaken for
        protocol (stdout stays pure JSON, the bytes travel base64 in `repl` events), the board is never reset by the
        bridge; Stop (the explicit way to a verified prompt) and then file ops and Run work."""
        board, c, r = self.connected("esp32", faults=["garbage_before_banner"])
        self.assertIn(r["state"], ("idle", "running", "unknown"), r)
        self.assertIn(r["sync"], ("prompt", "running-program", "prompt-unverified", "silent"), r)
        self.assertNoReset(board)
        c.call("repl.attach")
        self.assertTrue(c.call("stop")["stopped"])
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")
        m = c.mark()
        self.assertEqual(c.call("run", source="print('hi')", name="hi.py")["exit"], "ok")
        c.wait_out(b"hi\r\n", 5, since=m)
        c.assert_clean_stdout()
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_noise_containing_control_bytes_is_never_echoed_back(self):
        """RQ-SAFE-1/3: noise made of Ctrl-C, Ctrl-D, 0xff and CRLF bytes from the board is data, never a command: the bridge does
        not answer it with control bytes (0 soft resets, 0 interrupts from the bridge at connect)."""
        board, c, r = self.connected("esp32", faults=["garbage_before_banner:03040dff0a03040d0a"])
        self.assertEqual(board.events.count("soft_reset") + board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("interrupt"), 0)
        c.assert_clean_stdout()
        self.assertTrue(c.call("stop")["stopped"])
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")

    def test_reset_on_connect_is_the_boards_doing_and_the_bridge_adds_none(self):
        """RQ-SAFE-1 (acceptance: reset_on_connect detection): when the adapter resets the board as the port opens, the log shows
        a soft reset caused by the fake (`reset_on_connect`); the bridge adds NO reset of its own, comes up at the prompt
        and the next operations work."""
        board, c, r = self.connected("esp32", faults=["reset_on_connect"])
        self.assertIn(r["state"], ("idle", "running", "unknown"), r)
        resets = board.events.of("soft_reset")
        self.assertEqual([e for e in resets if e.get("reason") != "reset_on_connect"], [], "a reset the bridge caused")
        self.assertEqual(len(resets), 1)
        self.assertTrue(c.call("stop")["stopped"])
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")
        self.assertEqual(len(board.events.of("soft_reset")), 1)
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_board_reset_under_the_session_is_reported_and_never_turns_into_ctrl_d(self):
        """B (E_BOARD_RESET), A.2 (open defect: chunked exec after a board reset must not send Ctrl-D into a friendly REPL): the board
        resets itself while the bridge is idle; the next op either works or says E_BOARD_RESET (retry works); the bridge
        never adds a soft reset of its own."""
        board, c, _ = self.connected("esp32")
        board.soft_reset("test: external reset under the session")
        self.assertTrue(board.wait_idle(5))
        self.assertEqual(board.events.count("soft_reset"), 1)
        first = c.request("fs.list", path="/", _timeout=30)
        if not first["ok"]:
            self.assertEqual(first["error"]["code"], "E_BOARD_RESET", first)
            first = c.request("fs.list", path="/", _timeout=30)
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["entries"][0]["name"], "boot.py")
        self.assertEqual(board.events.count("soft_reset"), 1, "the bridge sent a Ctrl-D of its own")
        self.assertEqual(board.events.count("hard_reset"), 0)


class StopEscalationTests(BridgeTestCase):
    def test_ignore_ctrl_c_stop_says_not_stopped_and_never_resets(self):
        """RQ-SAFE-2/3, G#8, G#10, 08.2: with a board that swallows Ctrl-C, stop answers stopped:false after its timeout, the program
        keeps running, the state does not claim idle, the board was NOT reset; when the board becomes responsive a
        second stop works and the run ends interrupted."""
        board, c, _ = self.connected("esp32", faults=["ignore_ctrl_c"])
        rid = self.start_program(c, PROGRAMS["spin"], "spin.py")
        soft0 = board.events.count("soft_reset")
        m = c.mark()
        r = c.call("stop", timeoutMs=1000, _timeout=15)
        self.assertFalse(r["stopped"], r)
        self.assertTrue(board.program_running)
        self.assertFalse(c.has_result(rid))
        self.assertEqual(c.events_of("state", m, state="idle"), [], "stop claimed idle while the program still runs")
        self.assertGreaterEqual(board.events.count("interrupt"), 2)
        self.assertEqual(board.events.count("soft_reset"), soft0)
        self.assertEqual(board.events.count("hard_reset"), 0)
        board.remove_fault("ignore_ctrl_c")
        self.assertTrue(c.call("stop", _timeout=15)["stopped"])
        self.assertEqual(c.result(rid, 10)["exit"], "interrupted")
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")

    @deadline(150)
    def test_file_op_cannot_enter_the_raw_repl_while_ctrl_c_is_ignored(self):
        """Protocol 3 (E_RAW_REPL_TIMEOUT), 08.13: a consented file op (interrupt:true) against a program that ignores Ctrl-C ends in
        E_RAW_REPL_TIMEOUT (bounded, with a hint), not in a hang and not in a reset; the program still runs."""
        board, c, r = self.connected("esp32", faults=["main_forever", "ignore_ctrl_c"])
        self.assertEqual(r["state"], "running")
        t0 = time.monotonic()
        err = c.fail("fs.list", ("E_RAW_REPL_TIMEOUT", "E_BOARD_UNRESPONSIVE"), path="/", interrupt=True, _timeout=60)
        self.assertLess(time.monotonic() - t0, 40)
        self.assertTrue(err["hint"])
        self.assertTrue(board.program_running)
        self.assertEqual(board.events.count("hard_reset") + board.events.count("soft_reset"), 0)

    @deadline(150)
    def test_silent_board_gives_a_bounded_error_not_a_hang(self):
        """02.12, 08.10, G#15 (per-stage timeouts): the link goes dead mid-session (nothing is ever answered): the next file op ends
        in a classified error (E_BOARD_UNRESPONSIVE / E_RAW_REPL_TIMEOUT) in bounded time, stop answers stopped:false,
        ping still works, and the bridge still shuts down cleanly on stdin EOF."""
        board, c, _ = self.connected("esp32")
        board.add_fault("silent")
        t0 = time.monotonic()
        err = c.fail("fs.list", ("E_BOARD_UNRESPONSIVE", "E_RAW_REPL_TIMEOUT", "E_NO_DEVICE"), path="/", _timeout=90)
        self.assertLess(time.monotonic() - t0, 60)
        self.assertTrue(err["message"] and err["hint"])
        self.assertFalse(c.call("stop", timeoutMs=800, _timeout=15)["stopped"])
        c.ping()
        self.assertEqual(c.close(15), 0)


class TransferDropTests(BridgeTestCase):
    def test_connection_dropped_mid_upload(self):
        """G#13, 03.10: the board vanishes in the middle of a 40 KB upload (abrupt close after N received bytes, and the
        close_mid_transfer fault): the put answers E_NO_DEVICE (no hang), the state goes disconnected, no half-written
        FINAL file exists, and after a deliberate reconnect the board works and the orphaned .mpytmp is cleaned up."""
        data = pseudo_random(40_000, 21)
        for fault in ("unplug:bytes=3000", "close_mid_transfer:3000"):
            with self.subTest(fault=fault):
                board, c, _ = self.connected("esp32", faults=[fault])
                src = self.write_local(self.local_dir(), "drop.bin", data)
                m = c.mark()
                err = c.fail("fs.put", "E_NO_DEVICE", local=src, remote="/up/drop.bin", _timeout=60)
                self.assertTrue(err["hint"])
                c.wait_state("disconnected", 10, since=m)
                self.assertFalse(board.exists("/up/drop.bin"), "a half-written final file")
                c.call("disconnect")
                wait_until(lambda: board.connected == 0, 5)
                r = self.reconnect(c, board)
                self.assertEqual(self.list_root_after_drop(c, reconnect=r, fault=fault)["entries"][0]["name"], "boot.py")
                wait_until(lambda: tmp_files(board) == [], 15, "orphaned .mpytmp files to be cleaned in the new session (A.4)")
                self.assertFalse(board.exists("/up/drop.bin"))
                self.assertEqual(board.events.count("hard_reset"), 0)

    def test_board_vanishes_while_a_program_runs(self):
        """G#13, protocol 3 (run exit "disconnected"): unplugging during Run ends the run (exit disconnected or E_NO_DEVICE),
        emits state disconnected, and the bridge stays alive and answers."""
        board, c, _ = self.connected("esp32")
        rid = self.start_program(c, PROGRAMS["sleep_loop"], "loop.py")
        m = c.mark()
        board.unplug("test: pulled mid-run")
        res = c.result(rid, 20)
        if res["ok"]:
            self.assertEqual(res["exit"], "disconnected", res)
        else:
            self.assertEqual(res["error"]["code"], "E_NO_DEVICE", res)
        self.assertEqual(c.wait_state("disconnected", 10, since=m).get("reason"), "unplugged")
        c.ping()
        c.fail("run", ("E_NO_DEVICE", "E_NOT_CONNECTED"), source="print(1)")


class FirmwareFeatureTests(BridgeTestCase):
    def test_delayed_boot_py_does_not_break_run(self):
        """G#14: Run's soft reset executes a slow boot.py (delay_boot): the bridge waits for the prompt instead of a fixed sleep,
        the program output arrives, and no hard reset happens."""
        board, c, _ = self.connected("esp32", faults=["delay_boot:1.5"])
        self.assertTrue(c.call("stop", _timeout=15)["stopped"])
        m = c.mark()
        r = c.call("run", source="print('after the slow boot')", name="a.py", _timeout=40)
        self.assertEqual(r["exit"], "ok", r)
        c.wait_out(b"after the slow boot", 5, since=m)
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_board_without_raw_paste_uses_chunked_exec(self):
        """Appendix A.2 (R\\x00 reply selects chunked exec 256 bytes / 10 ms), RQ-GEN: identity says caps.paste false; upload, Run and
        manifest still work and stay byte-exact."""
        board, c, _ = self.connected("esp32", faults=["no_raw_paste"])
        self.assertIs(c.call("identity")["caps"]["paste"], False)
        data = pseudo_random(5_000, 4)
        src = self.write_local(self.local_dir(), "x.bin", data)
        self.assertEqual(c.call("fs.put", local=src, remote="/x.bin", _timeout=60)["sha256"], sha(data))
        self.assertEqual(board.read_file("/x.bin"), data)
        m = c.mark()
        self.assertEqual(c.call("run", source="print(7 * 6)", name="p.py", _timeout=30)["exit"], "ok")
        c.wait_out(b"42\r\n", 5, since=m)
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_board_without_compile_shows_stdin_in_tracebacks(self):
        """Protocol 5 (Run, `caps.compile` false): the raw source is sent instead of the compile() wrapper, so tracebacks show
        <stdin> (documented limitation); Run still works and `identity` says compile:false."""
        board, c, _ = self.connected("esp32", faults=["no_compile"])
        self.assertIs(c.call("identity")["caps"]["compile"], False)
        m = c.mark()
        r = c.call("run", source="print('x')\n1/0\n", name="/home/me/lab.py", _timeout=30)
        self.assertEqual(r["exit"], "exception")
        err = c.wait_stream("err", b"ZeroDivisionError", 5, since=m)
        self.assertIn(b'File "<stdin>", line 2', err)
        c.wait_out(b"x\r\n", 5, since=m)

    @deadline(150)
    def test_slow_baud_connect_upload_run_and_stop(self):
        """G#15, 03.16, 08.10 (size-proportional timeouts): a board throttled to 38400 baud: connect, a 3 KB upload with sha256
        verification, a manifest, Run and Stop all work without a spurious timeout and without a reset."""
        board, c, r = self.connected("esp32", faults=["slow:38400"])
        self.assertEqual((r["state"], r["sync"]), ("idle", "prompt"), r)
        data = pseudo_random(3_000, 8)
        src = self.write_local(self.local_dir(), "slow.bin", data)
        res = c.call("fs.put", local=src, remote="/slow.bin", _timeout=90)
        self.assertEqual(res["sha256"], sha(data))
        man = c.call("fs.manifest", root="/", _timeout=60)
        self.assertEqual([e["sha256"] for e in man["entries"] if e["path"].lstrip("/") == "slow.bin"], [sha(data)])
        rid = self.start_program(c, PROGRAMS["sleep_loop"], "loop.py", timeout=40)
        self.assertTrue(c.call("stop", _timeout=30)["stopped"])
        self.assertEqual(c.result(rid, 20)["exit"], "interrupted")
        self.assertEqual(board.events.count("soft_reset"), 1)
        self.assertEqual(board.events.count("hard_reset"), 0)


if __name__ == "__main__":
    unittest.main()
