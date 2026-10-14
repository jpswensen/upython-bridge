"""Regression tests for the second review round of bridge/server.py (fixer "S: server").

Two kinds of test:
  * in-process tests of Server with a stub Link: deterministic, fast, for logic a fake board cannot reach (the run
    watchdog, the all-or-nothing keystroke buffer, the 4 MiB line guard, the over-long-line id salvage);
  * black-box tests through tests/bridge_client.py against the fake board over TCP for what a client can observe.
Nothing here opens a serial port.  See docs/protocol.md section 3 (disconnect, stop, tty.write, exec) and Appendix B.
"""
from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

import bridge.link  # noqa: F401  (puts bridge/vendor, i.e. pyserial, on sys.path before bridge.server imports it)
from bridge import server
from bridge.errors import BridgeError
from tests.bridge_client import BridgeTestCase, bridge_argv, b64, run_cli
from tests.support import TimedTestCase, child_env, wait_until
from tools.fakeboard import PROGRAMS

LOOP = "import time\nprint('go')\nwhile True:\n    time.sleep(0.02)\n"


class StubLink(object):
    """Just enough of bridge.link.Link for Server's run / stop / tty.write logic (no I/O at all)."""

    def __init__(self):
        self.is_open = True
        self.raw_paste_supported = True
        self.mode = "friendly"
        self.calls = []
        self.exit_ok = True
        self.interrupt_result = True
        self.streaming = threading.Event()
        self._lock = threading.RLock()

    def check_alive(self):
        return True

    def session(self):
        return self._lock

    def interrupt(self, timeout=3.0, **_kw):
        self.calls.append("interrupt")
        return self.interrupt_result

    def enter_raw(self, soft_reset=False, timeout=10.0, cancel=None):
        self.calls.append(("enter_raw", soft_reset))
        return b""

    def exit_raw(self, timeout=2.0, redraw=None):
        self.calls.append("exit_raw")
        return self.exit_ok

    def exec(self, code, timeout=10.0, cancel=None):
        return b"@@C1\r\n", b""

    def exec_stream(self, code, on_out, timeout=None, cancel=None):
        """A run whose end-of-stream never arrives: blocks until cancelled."""
        self.streaming.set()
        cancel.wait(10)
        raise BridgeError("E_CANCELLED", "The operation was cancelled.")

    def write(self, data):
        self.calls.append(("write", bytes(data)))
        return len(data)

    def close(self):
        self.is_open = False


def stub_server(state="idle"):
    srv = server.Server(out=io.BytesIO())
    srv.link, srv.port, srv.state = StubLink(), "stub", state
    return srv


def response_lines(buf):
    return [json.loads(x) for x in buf.getvalue().decode("utf-8").splitlines() if x.strip()]


class RunWatchdogTests(TimedTestCase):
    """#3: a run whose stream was stopped (a prompt answered the Stop) or cancelled cannot wait for ever, and the state
    afterwards says what the board is really doing."""

    DEADLINE_S = 30

    def _start_run(self, srv, rid=1):
        req = server.Request(rid, "run", {"source": "while True: pass\n", "name": "/w/loop.py"})
        srv.current = req
        out = {}

        def go():
            try:
                out["res"] = srv.op_run(req)
            except BridgeError as exc:
                out["err"] = exc
        t = threading.Thread(target=go, daemon=True)
        t.start()
        self.addCleanup(req.cancel.set)
        self.assertTrue(srv.link.streaming.wait(5), "the run never started streaming")
        return req, t, out

    def test_stop_that_reached_a_prompt_but_lost_the_end_of_the_stream_frees_the_run(self):
        srv = stub_server()
        req, t, out = self._start_run(srv)
        with mock.patch.object(server, "RUN_END_GRACE", 0.2):
            self.assertTrue(srv.op_stop(server.Request(2, "stop", {}))["stopped"])
            t.join(10)
        self.assertFalse(t.is_alive(), "the run still waits for an end-of-stream that will never come")
        self.assertEqual(out.get("res", {}).get("exit"), "interrupted", out)
        self.assertTrue(req.watchdog)
        self.assertEqual(srv.state, "idle")
        calls = srv.link.calls
        self.assertIn(("enter_raw", True), calls)                   # the run's own soft reset ...
        self.assertIn(("enter_raw", False), calls)                  # ... then the resync: Ctrl-A path, never a second reset
        self.assertEqual(calls[-1], "exit_raw")

    def test_watchdog_recovery_that_fails_is_reported_and_the_state_stays_running(self):
        srv = stub_server()
        srv.link.exit_ok = False
        req, t, out = self._start_run(srv)
        with mock.patch.object(server, "RUN_END_GRACE", 0.2):
            srv.op_stop(server.Request(2, "stop", {}))
            t.join(10)
        self.assertEqual(out["err"].code, "E_BOARD_UNRESPONSIVE")
        self.assertEqual(srv.state, "running")
        self.assertTrue(srv._unsynced)

    def test_a_stop_that_got_no_prompt_arms_no_watchdog(self):
        srv = stub_server()
        srv.link.interrupt_result = False
        req, t, out = self._start_run(srv)
        with mock.patch.object(server, "RUN_END_GRACE", 0.1):
            self.assertFalse(srv.op_stop(server.Request(2, "stop", {}))["stopped"])
            self.assertFalse(req.finished.wait(0.5))
            self.assertFalse(req.watchdog)
            req.cancel.set()                                         # only an explicit cancel frees it
            t.join(10)
        self.assertEqual(out["err"].code, "E_CANCELLED")

    def test_explicit_cancel_keeps_state_running_and_the_next_stop_resynchronises(self):
        srv = stub_server()
        req, t, out = self._start_run(srv)
        self.assertEqual(srv.op_cancel(server.Request(3, "cancel", {"target": 1})), {"cancelled": True})
        t.join(10)
        self.assertEqual(out["err"].code, "E_CANCELLED")
        srv.current = None
        self.assertEqual(srv.state, "running", "cancel stops following; the program may still run")
        self.assertTrue(srv._unsynced)
        n = len(srv.link.calls)
        self.assertTrue(srv.op_stop(server.Request(4, "stop", {}))["stopped"])
        self.assertEqual(srv.state, "idle")
        self.assertEqual(srv.link.calls[n:], ["interrupt", ("enter_raw", False), "exit_raw"])

    def test_stop_after_a_cancel_whose_program_had_already_ended_still_recovers(self):
        """The raw REPL prints nothing for Ctrl-C when idle, so no prompt answers the Stop: Ctrl-A tells that apart from a
        program that ignores Ctrl-C."""
        srv = stub_server("running")
        srv._unsynced = True
        srv.link.interrupt_result = False
        self.assertTrue(srv.op_stop(server.Request(4, "stop", {}))["stopped"])
        self.assertEqual(srv.state, "idle")
        self.assertEqual(srv.link.calls, ["interrupt", ("enter_raw", False), "exit_raw"])
        srv = stub_server("running")
        srv._unsynced = True
        srv.link.interrupt_result = False
        srv.link.exit_ok = False
        self.assertFalse(srv.op_stop(server.Request(4, "stop", {}))["stopped"])
        self.assertEqual(srv.state, "running")

    def test_stop_after_a_cancel_stays_running_when_the_friendly_prompt_does_not_come_back(self):
        srv = stub_server()
        srv.state, srv._unsynced = "running", True
        srv.link.exit_ok = False
        srv.op_stop(server.Request(4, "stop", {}))
        self.assertEqual(srv.state, "running")

    def test_overlapping_stops_share_one_interrupt(self):
        srv = stub_server("running")
        gate, first = threading.Event(), threading.Event()
        count = []

        def slow_interrupt(timeout=3.0, **_kw):
            count.append(1)
            first.set()
            gate.wait(5)
            return True
        srv.link.interrupt = slow_interrupt
        results = []
        threads = [threading.Thread(target=lambda: results.append(srv.op_stop(server.Request(i, "stop", {}))), daemon=True)
                   for i in range(8)]
        threads[0].start()
        self.assertTrue(first.wait(5))
        for t in threads[1:]:
            t.start()
        gate.set()
        for t in threads:
            t.join(10)
        self.assertEqual(len(results), 8)
        self.assertEqual(sum(count), 1, "every overlapping Stop wrote its own Ctrl-C bytes")
        self.assertTrue(all(r["stopped"] for r in results))


class KeystrokeBufferTests(TimedTestCase):
    """#6 and #4: the hold buffer is all-or-nothing and Ctrl-C always passes."""

    def test_a_write_that_does_not_fit_is_refused_whole_and_order_is_kept(self):
        srv = stub_server("rawop")
        ok = srv.op_tty_write(server.Request(1, "tty.write", {"b64": b64(b"x" * 60000)}))
        self.assertEqual(ok, {})
        with self.assertRaises(BridgeError) as cm:
            srv.op_tty_write(server.Request(2, "tty.write", {"b64": b64(b"y" * 10000)}))
        self.assertEqual(cm.exception.code, "E_PROTOCOL")
        self.assertEqual(cm.exception.accepted, 0)
        self.assertEqual(server._err_dict(cm.exception)["accepted"], 0)
        self.assertEqual(bytes(srv._held), b"x" * 60000, "a refused write must change nothing")
        srv.op_tty_write(server.Request(3, "tty.write", {"b64": b64(b"z")}))
        self.assertEqual(bytes(srv._held), b"x" * 60000 + b"z")
        self.assertEqual(srv.link.calls, [])

    def test_ctrl_c_passes_while_keystrokes_are_held_and_with_stdin_false(self):
        srv = stub_server("rawop")
        srv.op_tty_write(server.Request(1, "tty.write", {"b64": b64(b"abc")}))
        srv.op_tty_write(server.Request(2, "tty.write", {"b64": b64(b"\x03")}))
        self.assertEqual(srv.link.calls, [("write", b"\x03")])
        srv = stub_server("running")
        srv.run_active, srv.run_stdin = True, False
        srv.op_tty_write(server.Request(1, "tty.write", {"b64": b64(b"abc")}))
        self.assertEqual(srv.link.calls, [], "stdin:false drops ordinary keystrokes")
        srv.op_tty_write(server.Request(2, "tty.write", {"b64": b64(b"a\x03b\x03")}))
        self.assertEqual(srv.link.calls, [("write", b"\x03\x03")], "only the Ctrl-C bytes are forwarded")


class LineLimitTests(TimedTestCase):
    """#7 (never emit an over-long line) and #9 (the id of an over-long request survives)."""

    DEADLINE_S = 60

    def test_an_over_long_response_becomes_a_small_error_with_the_same_id(self):
        buf = io.BytesIO()
        srv = server.Server(out=buf)
        srv.emit({"id": 7, "ok": True, "blob": "x" * (server.MAX_LINE + 10)})
        srv.emit({"ev": "out", "b64": "A" * (server.MAX_LINE + 10)})
        lines = response_lines(buf)
        self.assertEqual(len(lines), 2)
        self.assertEqual((lines[0]["id"], lines[0]["ok"], lines[0]["error"]["code"]), (7, False, "E_PROTOCOL"))
        self.assertEqual((lines[1]["ev"], lines[1]["level"]), ("log", "error"))
        self.assertLess(len(buf.getvalue()), 4096)

    def _read(self, data):
        buf = io.BytesIO()
        srv = server.Server(out=buf, stdin=io.BytesIO(data))
        srv._reader_main()
        return response_lines(buf)

    def test_id_is_found_wherever_it_sits_in_an_over_long_line(self):
        pad = b"x" * (server.MAX_LINE + 100)
        cases = {
            41: b'{"pad": "' + pad + b'", "id": 41, "op": "ping"}\n',                   # last key, far beyond any prefix
            42: b'{"a": "' + b"y" * 3000 + b'", "id": 42, "pad": "' + pad + b'"}\n',     # past 512 bytes, inside the prefix
            43: b'{"id": 43, "op": "ping", "pad": "' + pad + b'"}\n',                   # first key
        }
        for rid, line in cases.items():
            with self.subTest(rid=rid):
                lines = self._read(line)
                self.assertEqual([(x.get("id"), x["error"]["code"]) for x in lines if "error" in x], [(rid, "E_PROTOCOL")])

    def test_a_line_without_an_id_still_answers_with_null(self):
        lines = self._read(b'{"pad": "' + b"x" * (server.MAX_LINE + 100) + b'"}\n' + b'{"id": 5, "op": "ping"}\n')
        self.assertEqual([x.get("id") for x in lines if "id" in x], [None, 5])


class DisconnectDuringRunTests(BridgeTestCase):
    """#2: disconnect, repl.attach and repl.detach are answered while a Run holds the worker."""

    DEADLINE_S = 60

    def test_disconnect_without_a_decision_is_refused_at_once_and_the_port_stays_open(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        t0 = time.monotonic()
        err = c.fail("disconnect", "E_PROGRAM_RUNNING", _timeout=3)
        self.assertLess(time.monotonic() - t0, 2.0)
        self.assertIs(err["needs_interrupt"], True)
        self.assertNotIn("stopFirst", err["hint"])
        self.assertTrue(c.call("stop", _timeout=15)["stopped"])
        self.assertEqual(c.result(rid, 15)["exit"], "interrupted")
        c.call("fs.list", path="/")

    def test_disconnect_stopfirst_false_closes_the_port_and_leaves_the_program_running(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        n_int = board.events.count("interrupt")  # (the Run's own entry into the raw REPL sent one Ctrl-C at the idle prompt)
        t0 = time.monotonic()
        c.call("disconnect", stopFirst=False, _timeout=5)
        self.assertLess(time.monotonic() - t0, 3.0, "disconnect must not wait for the program")
        self.assertEqual(c.result(rid, 10)["exit"], "disconnected")
        self.assertEqual(c.states(0)[-1], "disconnected")
        self.assertTrue(board.program_running, "disconnect without stopFirst must not stop the program")
        self.assertEqual(board.events.count("interrupt"), n_int)
        c.fail("stop", "E_NOT_CONNECTED")

    def test_disconnect_stopfirst_true_interrupts_then_closes_within_a_second_or_two(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        t0 = time.monotonic()
        c.call("disconnect", stopFirst=True, _timeout=6)
        self.assertLess(time.monotonic() - t0, 3.5)
        self.assertEqual(c.result(rid, 10)["exit"], "interrupted")
        self.assertGreaterEqual(board.events.count("interrupt"), 1)

    def test_repl_attach_detach_during_a_run_only_flip_the_view(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        n_int = board.events.count("interrupt")
        c.call("repl.attach", _timeout=3)
        c.call("repl.detach", _timeout=3)
        self.assertEqual(board.events.count("interrupt"), n_int)
        self.assertEqual(len(board.events.of("stdin_bytes")), 0, "attach must never type into a running program")
        c.call("stop", _timeout=15)
        c.result(rid, 15)


class StopCoalescingTests(BridgeTestCase):
    DEADLINE_S = 90

    def test_a_storm_of_overlapping_stops_writes_only_a_few_ctrl_c_bytes(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        ids = [c.send("stop", timeoutMs=2000) for _ in range(40)]
        for i in ids:
            self.assertTrue(c.result(i, 30)["ok"])
        self.assertEqual(c.result(rid, 10)["exit"], "interrupted")
        n = board.events.count("interrupt")
        self.assertLessEqual(n, 8, "40 overlapping Stops put %d Ctrl-C bytes on the wire" % n)
        self.assertEqual(board.events.count("soft_reset"), 1)
        self.assertEqual(board.events.count("hard_reset"), 0)


class StateAccuracyTests(BridgeTestCase):
    """#8, #11, #12, #21, #22: the state is only `idle` on evidence, and the error says what a student should do."""

    DEADLINE_S = 90

    def test_a_prompt_lookalike_printed_after_connect_never_becomes_idle_and_is_never_nudged(self):
        src = "import sys, time\ntime.sleep(1.0)\nsys.stdout.write('>>> ')\nwhile True:\n    time.sleep(0.05)\n"
        board, c, r = self.connected(board_kw={"files": {"/main.py": src}, "power_on": "connect"})
        c.call("repl.attach")
        n = len(board.events.of("stdin_bytes"))
        wait_until(lambda: b">>> " in c.repl_bytes(), 10, "the program's lookalike prompt")
        time.sleep(1.0)  # the clock is the thing under test: longer than the quiet period before any verification
        err = c.fail("fs.list", "E_PROGRAM_RUNNING", path="/")
        self.assertEqual(len(board.events.of("stdin_bytes")), n, "the bridge typed into a program that only looked like a prompt")
        self.assertEqual(board.events.count("interrupt"), 0)
        self.assertNotIn("idle", c.states(0))
        self.assertIs(err["needs_interrupt"], True)

    def test_a_board_that_finishes_booting_after_a_silent_connect_becomes_idle_by_itself(self):
        board = self.new_board(faults=["delay_boot:1.2"])
        c = self.new_bridge()
        r = c.call("connect", port=board.url)
        self.assertEqual(r["sync"], "silent")
        ev = c.wait_event("state", lambda e: e["state"] == "idle", 20)
        self.assertEqual(ev["reason"], "prompt seen")
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")
        self.assertEqual([e for e in board.events.of("interrupt") if e.get("delivered")], [], "nothing was running to interrupt")
        self.assertNoReset(board)

    def test_a_connect_time_program_that_ends_by_itself_becomes_idle_by_itself(self):
        src = "import time\nprint('start')\ntime.sleep(1.0)\nprint('end')\n"
        board, c, r = self.connected(board_kw={"files": {"/main.py": src}, "power_on": "connect"})
        self.assertEqual(r["state"], "running")
        ev = c.wait_event("state", lambda e: e["state"] == "idle", 20)
        self.assertEqual(ev["reason"], "prompt seen")
        self.assertNoReset(board)

    def test_program_running_error_is_worded_for_a_student_and_machine_readable(self):
        board = self.new_board(faults=["main_forever"])
        c = self.new_bridge()
        c.call("connect", port=board.url)
        err = c.fail("fs.list", "E_PROGRAM_RUNNING", path="/")
        self.assertEqual(err["hint"], "A program is still running on the board. Press Stop first, or confirm that it may be interrupted.")
        self.assertIn("interrupt:true", err["detail"])
        self.assertIs(err["needs_interrupt"], True)
        self.assertEqual(err["sync"], "running-program")

    def test_silent_port_gets_its_own_message_and_no_ctrl_c_before_consent(self):
        board = self.new_board(faults=["silent"])
        c = self.new_bridge()
        r = c.call("connect", port=board.url, _timeout=30)
        self.assertEqual(r["sync"], "silent")
        err = c.fail("fs.list", "E_PROGRAM_RUNNING", path="/", _timeout=30)   # consent path unchanged; the words differ
        self.assertEqual(err["message"], "The board did not answer.")
        self.assertIn("right port", err["hint"])
        self.assertIn("Thonny", err["hint"])
        self.assertIn("reset button", err["hint"])
        self.assertEqual(err["sync"], "silent")
        self.assertIs(err["needs_interrupt"], True)
        self.assertEqual((board.events.count("interrupt"), board.events.count("raw_enter")), (0, 0))

    def test_exec_that_times_out_does_not_leave_state_idle_and_stop_brings_the_friendly_repl_back(self):
        board, c, _ = self.connected()
        c.call("repl.attach")
        resp = c.request("exec", code="while True:\n    pass\n", timeoutMs=300)
        self.assertEqual(resp["error"]["code"], "E_BOARD_UNRESPONSIVE", resp)
        self.assertEqual(c.states(0)[-1], "running")
        err = c.fail("fs.list", "E_PROGRAM_RUNNING", path="/")
        self.assertIn("may still be running", err["message"])
        self.assertTrue(c.call("stop", _timeout=15)["stopped"])
        wait_until(lambda: c.states(0)[-1] == "idle", 10, "idle after a verified stop")
        self.assertEqual(board.mode, "friendly")
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")


class ArgumentOrderTests(BridgeTestCase):
    """#5, #20: arguments are validated before the board is touched; local paths are absolute."""

    DEADLINE_S = 60

    def test_relative_local_is_refused_by_put_get_and_run_without_touching_the_board(self):
        board, c, _ = self.connected()
        board.write_file("/a.txt", b"data")
        n = len(board.events)
        c.fail("fs.get", "E_PROTOCOL", remote="/a.txt", local="rel/a.txt")
        c.fail("fs.put", "E_PROTOCOL", local="rel/a.txt", remote="/a.txt")
        c.fail("run", "E_PROTOCOL", local="rel/a.py")
        err = c.fail("fs.get", "E_PROTOCOL", remote="/a.txt", local="C:rel.txt")
        self.assertIn("absolute", err["message"])
        self.assertEqual(len(board.events), n, "a rejected request touched the board")

    def test_run_with_a_control_character_is_rejected_before_any_interrupt_or_reset(self):
        board, c, _ = self.connected(faults=("no_compile",))
        n = len(board.events)
        err = c.fail("run", "E_PROTOCOL", source="print(1)\n# \x03\n")
        self.assertIn("control character", err["message"])
        self.assertNoReset(board)
        self.assertEqual([e for e in board.events.of("interrupt") if e.get("delivered")], [], "a program was interrupted")
        self.assertGreaterEqual(len(board.events), n)

    def test_run_with_a_control_character_runs_when_the_board_can_compile(self):
        board, c, _ = self.connected()
        r = c.call("run", source="print('ctl', repr('\x03\x04'))\n")
        self.assertEqual(r["exit"], "ok")

    def test_exec_output_is_cut_with_a_flag_instead_of_overflowing_the_line(self):
        board, c, _ = self.connected()
        code = "s = 'y' * 1000\nfor i in range(600):\n    print(s)\n"
        r = c.call("exec", code=code, timeoutMs=60000, _timeout=60)
        self.assertIs(r.get("truncated"), True)
        self.assertEqual(len(r["out"]), server.EXEC_MAX_BYTES)
        self.assertGreater(r["outBytes"], server.EXEC_MAX_BYTES)
        small = c.call("exec", code="print('hi')")
        self.assertNotIn("truncated", small)
        self.assertEqual(small["out"], "hi\r\n")


class WireExtrasTests(BridgeTestCase):
    def test_mount_refusal_carries_its_marker_and_allow_mount_resends(self):
        board, c, _ = self.connected("stm32")
        board.write_file("/flash/keep/a.txt", "a")
        err = c.fail("fs.rmtree", "E_FS_ERRNO", path="/flash", confirm=True)
        self.assertIs(err["needs_allow_mount"], True)
        self.assertIn(err["mount_reason"], ("dev", "root", "vfs", "cwd"))
        self.assertTrue(board.exists("/flash/keep/a.txt"))


class CliTests(BridgeTestCase):
    """#14, #17, #18, #20 for the CLI."""

    DEADLINE_S = 90

    def _script(self, board, lines, port=True, encoding="utf-8"):
        folder = self.local_dir(course=False)
        script = os.path.join(folder, "s.jsonl")
        with open(script, "wb") as f:
            f.write("\n".join(lines).encode(encoding) + b"\n")
        argv = bridge_argv(["--script", script] + (["--port", board.url] if port else []))
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=60, cwd=folder, env=child_env(), shell=False)
        return r.returncode, [json.loads(x) for x in r.stdout.decode("utf-8").splitlines() if x.strip()], r.stderr.decode("utf-8", "replace")

    def test_port_is_used_for_the_implicit_connect_before_the_first_op_that_needs_a_board(self):
        board = self.new_board()
        rc, lines, err = self._script(board, ['{"op": "ping"}', '{"op": "config", "shadowGuard": ["os"]}', '{"op": "ports.list"}',
                                              '{"op": "fs.list", "path": "/"}'])
        self.assertEqual((rc, [x["ok"] for x in lines]), (0, [True, True, True, True]), (lines, err))

    def test_a_script_that_connects_itself_decides_alone_and_may_leave_out_the_port(self):
        board = self.new_board()
        rc, lines, err = self._script(board, ['{"op": "connect"}', '{"op": "fs.list", "path": "/"}'])
        self.assertEqual((rc, [x["ok"] for x in lines]), (0, [True, True]), (lines, err))
        rc, lines, err = self._script(board, ['{"op": "fs.list", "path": "/"}'], port=False)
        self.assertEqual((rc, lines[0]["error"]["code"]), (1, "E_NOT_CONNECTED"))

    def test_script_with_a_byte_order_mark_and_non_ascii_text_runs(self):
        board = self.new_board()
        rc, lines, err = self._script(board, ['﻿{"op": "ping"}', '{"op": "config", "shadowGuard": ["café"]}'], encoding="utf-8")
        self.assertEqual((rc, [x["ok"] for x in lines]), (0, [True, True]), (lines, err))

    def test_cli_resolves_a_relative_local_against_the_callers_folder(self):
        board = self.new_board()
        board.write_file("/a.txt", b"data")
        rc, resp, err = run_cli("fs.get", "remote=/a.txt", "local=rel-a.txt", "--port", board.url)
        self.assertEqual(rc, 0, (resp, err))
        self.assertEqual(resp["bytes"], 4)


class SignalTests(TimedTestCase):
    def test_quit_signals_are_installed_for_hup_and_term(self):
        if sys.platform == "win32":
            self.skipTest("POSIX signals")
        import signal
        srv = server.Server(out=io.BytesIO())
        old = {n: signal.getsignal(getattr(signal, n)) for n in ("SIGTERM", "SIGHUP")}
        self.addCleanup(lambda: [signal.signal(getattr(signal, n), h) for n, h in old.items()])
        server._install_quit_signals(srv)
        for name in ("SIGTERM", "SIGHUP"):
            sig = getattr(signal, name)
            srv.quit_event.clear()
            signal.getsignal(sig)(sig, None)
            self.assertTrue(srv.quit_event.is_set(), name)
            self.assertEqual(srv.quit_reason, name)


if __name__ == "__main__":
    unittest.main()
