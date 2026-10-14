"""Review 2, focus "contract", part 2: not-connected behaviour, ports.list, cancel/exec edge states, consent paths,
a program that ends by itself, busy ports, stop latency, tty.write arguments.  Black-box against the fake board.
Deviations reproduced when written (round 2 findings 11, 12) are fixed; a ``test_FAILS_*`` name means open."""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from bridge import devfs  # noqa: F401  (puts bridge/vendor on sys.path)
from tests.bridge_client import BRIDGE_PATH, ROOT, BridgeTestCase
from tests.support import child_env, wait_until
from tools.fakeboard import PROGRAMS


class NotConnectedTests(BridgeTestCase):
    DEADLINE_S = 30

    def test_every_board_op_without_a_connection_is_e_not_connected(self):
        client = self.new_bridge()
        tmp = tempfile.gettempdir()
        calls = [("identity", {}), ("fs.list", {"path": "/"}), ("fs.manifest", {"root": "/"}), ("fs.stat", {"path": "/"}),
                 ("fs.rm", {"path": "/x"}), ("fs.mkdir", {"path": "/x"}), ("fs.mv", {"src": "/a", "dst": "/b"}),
                 ("fs.rmtree", {"path": "/x", "confirm": True}), ("fs.get", {"remote": "/x", "local": tmp + "/review2-x"}),
                 ("fs.put", {"local": __file__, "remote": "/x.py"}), ("run", {"source": "1"}), ("reset.soft", {}),
                 ("reset.hard", {"confirmed": True}), ("repl.attach", {}), ("tty.write", {"b64": "AA=="}), ("stop", {}),
                 ("exec", {"code": "1"}), ("introspect.modules", {})]
        for op, args in calls:
            with self.subTest(op=op):
                resp = client.request(op, **args)          # (fail() cannot carry exec's own `code` argument)
                self.assertFalse(resp["ok"], resp)
                self.assertEqual(resp["error"]["code"], "E_NOT_CONNECTED", resp)
        for op, args in (("disconnect", {}), ("repl.detach", {}), ("ping", {}), ("config", {}), ("cancel", {"target": 1})):
            with self.subTest(op=op):
                self.assertTrue(client.request(op, **args)["ok"], op)


class PortsListTests(unittest.TestCase):
    def test_ports_list_is_metadata_only_cu_only_on_macos_and_ranks_boards(self):
        """Section 3 ports.list: never opens a port; macOS only /dev/cu.*; all listed; likelyBoard ranks known adapters."""
        import bridge.link  # noqa: F401  (puts bridge/vendor on sys.path)
        import serial
        from bridge import server

        class P(object):
            def __init__(self, device, vid=None, pid=None, manufacturer=None, product=None, description="n/a", serial_number=None):
                self.device, self.vid, self.pid = device, vid, pid
                self.manufacturer, self.product, self.description = manufacturer, product, description
                self.serial_number, self.hwid = serial_number, "USB VID:PID=%s:%s" % (vid, pid)

        fake = [P("/dev/tty.usbserial-0001", 0x10C4, 0xEA60, "Silicon Labs", "CP2102"),
                P("/dev/cu.Bluetooth-Incoming-Port"),
                P("/dev/cu.other", 0x046D, 0xC52B, "Logitech", "Receiver"),
                P("/dev/cu.usbmodem1", 0x2E8A, 0x0005, "MicroPython", "Board in FS mode"),
                P("/dev/cu.usbserial-0001", 0x10C4, 0xEA60, "Silicon Labs", "CP2102 USB to UART Bridge Controller", serial_number="0001")]

        def never(*a, **k):
            raise AssertionError("ports.list opened a serial port")

        srv = server.Server()
        with mock.patch.object(server.list_ports, "comports", lambda: fake), mock.patch.object(sys, "platform", "darwin"), \
                mock.patch.object(serial.Serial, "__init__", never), mock.patch.object(serial, "serial_for_url", never):
            res = srv.op_ports_list(None)
        devices = [p["device"] for p in res["ports"]]
        self.assertNotIn("/dev/tty.usbserial-0001", devices)
        self.assertEqual(len(devices), 4)
        for p in res["ports"]:
            for key in ("device", "vid", "pid", "serial", "manufacturer", "product", "description", "hwid", "likelyBoard"):
                self.assertIn(key, p)
        likely = {p["device"]: p["likelyBoard"] for p in res["ports"]}
        self.assertTrue(likely["/dev/cu.usbserial-0001"])
        self.assertTrue(likely["/dev/cu.usbmodem1"])
        self.assertFalse(likely["/dev/cu.other"])
        self.assertFalse(likely["/dev/cu.Bluetooth-Incoming-Port"])
        self.assertTrue(res["ports"][0]["likelyBoard"] and res["ports"][1]["likelyBoard"])


class EdgeStateTests(BridgeTestCase):
    DEADLINE_S = 90

    def test_cancelling_a_run_leaves_the_board_in_the_raw_repl_after_stop(self):
        """Section 5: after cancel + stop the state is idle, so the friendly REPL must be back (REPL view needs its prompt)."""
        board, client, _ = self.connected("esp32")
        rid = self.start_program(client, PROGRAMS["spin"], "spin.py")
        self.assertTrue(client.call("cancel", target=rid)["cancelled"])
        client.result(rid, 5)
        m = client.mark()
        self.assertTrue(client.call("stop")["stopped"])
        wait_until(lambda: not board.program_running, 5, "program to stop")
        states = client.states(m)
        last = client.states(0)[-1]
        self.assertEqual(last, "idle", states)
        self.assertEqual(board.mode, "friendly", "state says idle but the board is still in the raw REPL")

    def test_exec_timeout_leaves_state_idle_while_the_loop_runs(self):
        """A.3: an exec stage timeout is E_BOARD_UNRESPONSIVE; afterwards the bridge's state must not lie about the board."""
        board, client, _ = self.connected("esp32")
        resp = client.request("exec", code="while True:\n    pass\n", timeoutMs=300)
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["code"], "E_BOARD_UNRESPONSIVE", resp)
        last = client.states(0)[-1]
        if last == "idle":
            self.assertFalse(board.program_running, "state idle while the board still executes the exec'd loop")
            self.assertEqual(board.mode, "friendly")
        follow = client.request("fs.list", path="/")
        self.assertTrue(follow["ok"] or follow["error"]["code"] == "E_PROGRAM_RUNNING", follow)

    def test_consent_paths_interrupt_without_a_reset(self):
        """Section 5 running + file op: interrupt:true (or force:true for identity) is the consent path; never a reset."""
        board, client, _ = self.connected("esp32", faults=("main_forever",))
        res = client.call("identity", interrupt=True)
        self.assertIn("uniqueId", res)
        self.assertGreaterEqual(board.events.count("interrupt"), 1)
        self.assertEqual(board.events.count("soft_reset"), 0)
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(client.states(0)[-1], "idle")
        client.call("fs.list", path="/")

    def test_state_stays_running_after_the_connect_time_program_ends_by_itself(self):
        """Section 5: 'running' = a user program executing.  main.py seen at connect finishes on its own; the board is back at
        the prompt, but the bridge keeps answering E_PROGRAM_RUNNING (the client would ask the student to interrupt
        a program that is not running) until somebody presses Stop."""
        src = "import time\nprint('start')\ntime.sleep(1.5)\nprint('end')\n"
        board, client, resp = self.connected("esp32", board_kw={"files": {"/main.py": src}, "power_on": "connect"})
        self.assertEqual(resp["state"] in ("running", "unknown"), True, resp)
        self.assertIsNotNone(board.events.wait_for("program_end", 10), "main.py did not end")
        wait_until(lambda: not board.program_running, 5, "board idle")
        follow = client.request("fs.list", path="/")
        self.assertTrue(follow["ok"], follow)


class MiscBehaviourTests(BridgeTestCase):
    DEADLINE_S = 60

    def test_failed_connect_reports_the_class_and_returns_to_disconnected(self):
        board = self.new_board("esp32")
        port = board.url
        board.stop()
        client = self.new_bridge()
        m = client.mark()
        err = client.fail("connect", "E_NO_DEVICE", port=port)
        self.assertTrue(err["hint"])
        ev = client.events_of("state", m)
        self.assertEqual([(e["state"], e.get("reason")) for e in ev], [("connecting", None), ("disconnected", "connect-failed")])
        client.fail("fs.list", "E_NOT_CONNECTED", path="/")

    def test_stop_latency_bound_for_an_interruptible_program(self):
        """Appendix B: stop replies at the first prompt; bound 200 ms when the program is interruptible."""
        board, client, _ = self.connected("esp32")
        rid = self.start_program(client, PROGRAMS["sleep_loop"], "loop.py")
        t0 = time.monotonic()
        resp = client.call("stop")
        wall = time.monotonic() - t0
        self.assertTrue(resp["stopped"])
        self.assertLessEqual(resp["ms"], 200, resp)
        self.assertLess(wall, 0.4)
        self.assertEqual(client.result(rid, 5)["exit"], "interrupted")

    def test_tty_write_argument_errors(self):
        board, client, _ = self.connected("esp32")
        client.fail("tty.write", "E_PROTOCOL")
        client.fail("tty.write", "E_PROTOCOL", b64="!!!!")
        client.fail("tty.write", "E_PROTOCOL", b64=5)
        self.assertTrue(client.request("tty.write", b64="")["ok"])


class ProcessAndCancelTests(BridgeTestCase):
    DEADLINE_S = 60

    def test_fatal_startup_error_is_exit_2_with_a_fatal_event_and_stderr_line(self):
        """Section 1: exit code 2 = fatal startup error (message on stderr and a final {"ev":"fatal"} line)."""
        tmp = tempfile.mkdtemp(prefix="review2-fatal-")
        self.addCleanup(shutil.rmtree, tmp, True)
        shutil.copytree(os.path.join(ROOT, "bridge"), os.path.join(tmp, "bridge"),
                        ignore=shutil.ignore_patterns("server.py", "__pycache__", "vendor"))
        r = subprocess.run([sys.executable, "-I", "-B", "-u", "-X", "utf8", os.path.join(tmp, "bridge", "mpy_bridge.py")],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=30, cwd=tmp, env=child_env(), shell=False)
        self.assertEqual(r.returncode, 2, r.stderr)
        last = r.stdout.decode("utf-8").strip().splitlines()[-1]
        import json
        self.assertEqual(json.loads(last)["ev"], "fatal")
        self.assertIn(b"[error]", r.stderr)

    @unittest.skipIf(sys.platform == "win32", "POSIX signal")
    def test_sigterm_interrupts_a_running_program_and_exits_zero(self):
        board, client, _ = self.connected("esp32")
        self.start_program(client, PROGRAMS["spin"], "spin.py")
        os.kill(client.pid, signal.SIGTERM)
        self.assertEqual(client.wait_exit(10), 0)
        self.assertIsNotNone(board.events.wait_for("interrupt", 5))
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_cancel_of_a_running_upload_leaves_no_partial_file_and_the_old_one_intact(self):
        """Section 3 cancel + A.4/B: a cancelled put removes its temp file and never replaces the target."""
        board, client, _ = self.connected("esp32", board_kw={"baud": 115200})
        board.write_file("/big.bin", "old")
        folder = self.local_dir()
        local = self.write_local(folder, "big.bin", os.urandom(200000))
        m = client.mark()
        rid = client.send("fs.put", local=local, remote="/big.bin")
        client.wait_event("progress", lambda e: e["id"] == rid and e["done"] > 0, 20, since=m)
        self.assertTrue(client.call("cancel", target=rid)["cancelled"])
        resp = client.result(rid, 30)
        self.assertEqual(resp["error"]["code"], "E_CANCELLED", resp)
        self.assertEqual(board.read_file("/big.bin"), b"old")
        names = [e["name"] for e in client.call("fs.list", path="/")["entries"]]
        self.assertEqual([n for n in names if n.endswith(".mpytmp")], [])
        self.assertEqual(client.states(0)[-1], "idle")
        self.assertEqual(board.mode, "friendly")


class DecisionAndResetTests(BridgeTestCase):
    DEADLINE_S = 90

    def test_connect_auto_never_reaches_the_transport_even_with_safe_mode_off(self):
        """D-11 / CLAUDE.md rule 1: 'auto' is a UI choice.  In-process with safe mode OFF the Link class is replaced by a
        trap, so nothing can open anything: the server itself must refuse 'auto' as E_PROTOCOL before building a Link."""
        import bridge.link  # noqa: F401
        import serial
        from bridge import server
        from bridge.errors import BridgeError

        def trap(*a, **k):
            raise AssertionError("a transport object was built for 'auto'")

        for text in ("auto", "AUTO", "  auto "):
            with mock.patch.dict(os.environ, {"MPY_SAFE_MODE": "0"}), mock.patch.object(server, "Link", trap), \
                    mock.patch.object(serial.Serial, "__init__", trap), mock.patch.object(serial, "serial_for_url", trap):
                srv = server.Server()
                with self.assertRaises(BridgeError) as cm:
                    srv.op_connect(server.Request(1, "connect", {"port": text}))
            self.assertEqual(cm.exception.code, "E_PROTOCOL", text)

    def test_bridge_ignores_shadowing_files_in_the_working_directory(self):
        """08.6: a student folder holding serial.py / json.py / time.py / platformdirs.py must not break the bridge."""
        cwd = tempfile.mkdtemp(prefix="review2-shadow-")
        self.addCleanup(shutil.rmtree, cwd, True)
        for name in ("serial.py", "json.py", "time.py", "platformdirs.py", "threading.py", "base64.py"):
            with open(os.path.join(cwd, name), "w", encoding="utf-8") as f:
                f.write("raise ImportError('shadowed by the workspace: %s')\n" % name)
        board = self.new_board("esp32")
        client = self.new_bridge(cwd=cwd)
        client.call("connect", port=board.url)
        self.assertEqual(client.call("run", source="print(1)")["exit"], "ok")

    def test_board_reset_under_a_running_program_does_not_hang_the_run(self):
        """Section 3 E_BOARD_RESET / 08.5: a reset under us ends the Run promptly and the state leaves 'running'."""
        board, client, _ = self.connected("esp32")
        rid = self.start_program(client, PROGRAMS["spin"], "spin.py")
        board.hard_reset("review2")
        resp = client.result(rid, 10)
        self.assertTrue(resp["ok"] or resp["error"]["code"] in ("E_BOARD_RESET", "E_NO_DEVICE", "E_BOARD_UNRESPONSIVE"), resp)
        wait_until(lambda: client.states(0)[-1] != "running", 5, "state to leave running (states=%r)" % client.states(0))
        first = client.request("fs.list", path="/")
        if not first["ok"]:
            self.assertIn(first["error"]["code"], ("E_BOARD_RESET", "E_PROGRAM_RUNNING"), first)
            first = client.request("fs.list", path="/", interrupt=True)
        self.assertTrue(first["ok"], first)

    def test_board_reset_while_idle_is_reported_or_absorbed(self):
        board, client, _ = self.connected("esp32")
        client.call("fs.list", path="/")
        board.hard_reset("review2")
        first = client.request("fs.list", path="/")
        if not first["ok"]:
            self.assertIn(first["error"]["code"], ("E_BOARD_RESET", "E_PROGRAM_RUNNING"), first)
            first = client.request("fs.list", path="/", interrupt=True)
        self.assertTrue(first["ok"], first)

    def test_repl_attach_never_types_into_a_running_program(self):
        """Section 3 repl.attach: forwards events only.  A CR written into a running program's stdin would be program input."""
        board, client, resp = self.connected("esp32", faults=("main_forever",))
        self.assertEqual(resp["state"], "running")
        client.call("repl.attach")
        client.tty_write(b"z")                                  # ordered after anything the attach might have written
        wait_until(lambda: any(e.get("hex") == "7a" for e in board.events.of("stdin_bytes")), 5, "the z to reach the board")
        self.assertEqual(sum(e["n"] for e in board.events.of("stdin_bytes")), 1, board.events.of("stdin_bytes"))

    def test_failed_stop_of_a_connect_time_program_keeps_the_state_running(self):
        """Section 5 running -> stop: 'if no prompt in timeoutMs: reply stopped:false, state stays running'."""
        board, client, resp = self.connected("esp32", faults=("main_forever", "ignore_ctrl_c"))
        self.assertEqual(resp["state"], "running")
        m = client.mark()
        self.assertEqual(client.call("stop", timeoutMs=300)["stopped"], False)
        self.assertNotIn("idle", client.states(m))
        client.fail("fs.list", "E_PROGRAM_RUNNING", path="/")

    def test_stop_reaches_a_program_that_floods_the_output(self):
        """RQ-SAFE-3: Stop always reaches the board, also while the output stream is saturated."""
        board, client, _ = self.connected("esp32")
        rid = self.start_program(client, "while True:\n    print('x' * 120)\n", "flood.py", ready=b"xxxxxxxx")
        t0 = time.monotonic()
        resp = client.call("stop", _timeout=15)
        self.assertTrue(resp["stopped"], resp)
        self.assertLess(time.monotonic() - t0, 3.0)
        self.assertEqual(client.result(rid, 10)["exit"], "interrupted")
        self.assertEqual(board.events.count("hard_reset"), 0)
        client.assert_clean_stdout()

    def test_disconnect_with_stop_first_ends_the_program_and_closes(self):
        board, client, _ = self.connected("esp32")
        rid = self.start_program(client, PROGRAMS["spin"], "spin.py")
        resp = client.request("disconnect", _timeout=15, stopFirst=True)
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(client.result(rid, 5)["exit"], "interrupted")
        self.assertGreaterEqual(board.events.count("interrupt"), 1)
        self.assertEqual(client.states(0)[-1], "disconnected")
        self.assertEqual(board.events.count("hard_reset"), 0)


if __name__ == "__main__":
    unittest.main()
