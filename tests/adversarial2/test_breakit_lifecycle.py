"""Break-it round 2, lifecycle: signals, stdin EOF, unplug during every kind of op, connect/disconnect abuse, leaks.

Spawns the real bridge against fake boards (socket://127.0.0.1). Nothing here opens a serial port.
"""
from __future__ import annotations

import io
import os
import signal
import sys
import threading
import unittest

from tests.adversarial import _harness  # noqa: F401  (puts bridge/vendor on sys.path, forces MPY_SAFE_MODE=1)
from tests.bridge_client import BridgeCallError, BridgeTestCase
from tests.support import shorten_socket_close_sleep, wait_until

LOOP = "import time\nprint('go')\nwhile True:\n    time.sleep(0.02)\n"
POSIX = sys.platform != "win32"


def kinds(board):
    return [(e["ev"], e.get("reason")) for e in board.events if e["ev"] in ("soft_reset", "hard_reset", "interrupt", "disconnect")]


@unittest.skipUnless(POSIX, "POSIX signals")
class Signals(BridgeTestCase):
    def _signal_during_run(self, sig):
        board, c, _ = self.connected()
        self.start_program(c, LOOP)
        before = board.events.count("soft_reset")
        c.proc.send_signal(sig)
        rc = c.wait_exit(15)
        self.assertEqual(rc, 0, "exit code after %s; stderr:\n%s" % (sig, c.stderr_tail(20)))
        self.assertTrue(board.wait_idle(5), "the program must be interrupted before the port closes (RQ-SAFE-4): %r" % kinds(board))
        self.assertGreaterEqual(board.events.count("interrupt"), 1, kinds(board))
        self.assertEqual(board.events.count("soft_reset"), before, "a signal must not add a reset: %r" % kinds(board))
        self.assertEqual(board.events.count("hard_reset"), 0)
        c.assert_clean_stdout()

    def test_sigterm_idle_exits_cleanly(self):
        board, c, _ = self.connected()
        c.proc.send_signal(signal.SIGTERM)
        self.assertEqual(c.wait_exit(10), 0)
        self.assertTrue(board.wait_for_clients(0, 5))
        self.assertNoReset(board)
        c.assert_clean_stdout()

    def test_sigterm_during_run_interrupts_program(self):
        self._signal_during_run(signal.SIGTERM)

    def test_sigint_during_run_interrupts_program(self):
        self._signal_during_run(signal.SIGINT)

    def test_sighup_during_run_interrupts_program(self):
        self._signal_during_run(signal.SIGHUP)

    def test_signal_while_upload_in_flight(self):
        board, c, _ = self.connected(faults=["slow:230400"])
        folder = self.local_dir()
        path = self.write_local(folder, "big.bin", os.urandom(150 * 1024))
        rid = c.send("fs.put", local=path, remote="/big.bin")
        c.wait_event("progress", lambda e: e["id"] == rid and e["done"] > 0, 20)
        c.proc.send_signal(signal.SIGTERM)
        self.assertEqual(c.wait_exit(20), 0, c.stderr_tail(20))
        self.assertTrue(board.wait_idle(5))
        self.assertNoReset(board)
        self.assertEqual([n for n in os.listdir(board.root) if n.endswith(".mpytmp")], [], "temp file left behind")
        c.assert_clean_stdout()


class StdinEof(BridgeTestCase):
    def test_eof_mid_upload_leaves_board_friendly_and_clean(self):
        board, c, _ = self.connected(faults=["slow:230400"])
        folder = self.local_dir()
        path = self.write_local(folder, "big.bin", os.urandom(150 * 1024))
        rid = c.send("fs.put", local=path, remote="/big.bin")
        c.wait_event("progress", lambda e: e["id"] == rid and e["done"] > 0, 20)
        c.proc.stdin.close()
        self.assertEqual(c.wait_exit(20), 0, c.stderr_tail(20))
        self.assertTrue(board.wait_idle(5))
        self.assertEqual(board.mode, "friendly", "bridge exited leaving the board in %s mode" % board.mode)
        self.assertEqual([n for n in os.listdir(board.root) if n.endswith(".mpytmp")], [], "temp file left behind")
        self.assertNoReset(board)
        c.assert_clean_stdout()

    def test_eof_with_queued_ops_answers_or_exits(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        queued = [c.send("repl.attach") for _ in range(5)]
        c.proc.stdin.close()
        self.assertEqual(c.wait_exit(15), 0, c.stderr_tail(20))
        for q in queued:
            self.assertTrue(c.has_result(q), "queued request %d vanished at EOF (no response of any kind)" % q)
        self.assertTrue(board.wait_idle(5))
        self.assertEqual(board.events.count("soft_reset"), 1, kinds(board))   # only the run's own reset
        c.assert_clean_stdout()

    def test_shutdown_op_with_queued_ops(self):
        board, c, _ = self.connected(faults=["slow:230400"])
        folder = self.local_dir()
        path = self.write_local(folder, "big.bin", os.urandom(150 * 1024))
        put = c.send("fs.put", local=path, remote="/big.bin")
        c.wait_event("progress", lambda e: e["id"] == put and e["done"] > 0, 20)
        queued = [c.send("fs.stat", path="/big.bin") for _ in range(30)]
        down = c.send("shutdown")
        resp = c.result(down, 20)
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(c.wait_exit(15), 0)
        for q in queued + [put]:
            self.assertTrue(c.has_result(q), "request %d got no response before the bridge exited" % q)
        self.assertNoReset(board)
        c.assert_clean_stdout()


class UnplugEverywhere(BridgeTestCase):
    def recover(self, board, c):
        """After the unplug the bridge must (1) say so, (2) fail later ops fast, (3) accept a plain connect, (4) work."""
        c.wait_state("disconnected", 10)
        for op, args in (("fs.list", {"path": "/"}), ("fs.stat", {"path": "/"}), ("identity", {}), ("exec", {"code": "print(1)"}),
                         ("repl.attach", {}), ("stop", {"timeoutMs": 200}), ("tty.write", {"b64": "AA=="}),
                         ("run", {"source": "print(1)"})):
            resp = c.request(op, _timeout=15, **args)
            self.assertFalse(resp["ok"], (op, resp))
            self.assertIn(resp["error"]["code"], ("E_NO_DEVICE", "E_NOT_CONNECTED"), (op, resp))
        c.ping()
        self.assertTrue(board.wait_for_clients(0, 5))
        resp = self.reconnect(c, board)           # NO explicit disconnect in between: the unplug already ended the session
        self.assertTrue(resp["ok"], resp)
        first = self.list_root_after_drop(c, phase="after reconnect")
        self.assertTrue(first["ok"])
        c.assert_clean_stdout()

    def test_unplug_idle(self):
        board, c, _ = self.connected()
        board.unplug()
        self.recover(board, c)

    def test_unplug_during_upload(self):
        board, c, _ = self.connected(faults=["slow:230400"])
        path = self.write_local(self.local_dir(), "big.bin", os.urandom(150 * 1024))
        rid = c.send("fs.put", local=path, remote="/big.bin")
        c.wait_event("progress", lambda e: e["id"] == rid and e["done"] > 0, 20)
        board.unplug()
        resp = c.result(rid, 30)
        self.assertFalse(resp["ok"], "the put cannot have succeeded: raise the file size if this fires")
        self.assertIn(resp["error"]["code"], ("E_NO_DEVICE", "E_BOARD_UNRESPONSIVE", "E_NOT_CONNECTED"), resp)
        self.recover(board, c)

    def test_unplug_during_run(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        board.unplug()
        resp = c.result(rid, 30)
        if resp["ok"]:
            self.assertEqual(resp["exit"], "disconnected")
        else:
            self.assertIn(resp["error"]["code"], ("E_NO_DEVICE", "E_NOT_CONNECTED"), resp)
        self.recover(board, c)

    def test_unplug_during_exec(self):
        board, c, _ = self.connected()
        rid = c.send("exec", code="import time\nprint('x')\ntime.sleep(30)\n", timeoutMs=60000)
        wait_until(lambda: board.program_running, 10, "exec to start")
        board.unplug()
        resp = c.result(rid, 30)
        self.assertFalse(resp["ok"], resp)
        self.assertIn(resp["error"]["code"], ("E_NO_DEVICE", "E_BOARD_UNRESPONSIVE", "E_NOT_CONNECTED"), resp)
        self.recover(board, c)

    def test_unplug_during_manifest(self):
        board, c, _ = self.connected()
        for i in range(300):
            board.write_file("/d%d/f%d.txt" % (i % 10, i), b"x" * 200)
        rid = c.send("fs.manifest", root="/")
        c.wait_event("progress", lambda e: e["id"] == rid, 20) if False else None
        wait_until(lambda: board.program_running, 10, "manifest to start")
        board.unplug()
        resp = c.result(rid, 30)
        if not resp["ok"]:
            self.assertIn(resp["error"]["code"], ("E_NO_DEVICE", "E_BOARD_UNRESPONSIVE", "E_NOT_CONNECTED"), resp)
        self.recover(board, c)

    def test_unplug_while_connecting(self):
        board = self.new_board(faults=["unplug:connect"])
        c = self.new_bridge()
        resp = c.request("connect", port=board.url)
        self.assertFalse(resp["ok"], resp)
        c.ping()
        board.remove_fault("unplug")
        resp = self.reconnect(c, board)
        self.assertTrue(resp["ok"])
        c.assert_clean_stdout()

    def test_unplug_then_hard_garbage_then_connect_twice(self):
        board, c, _ = self.connected()
        board.unplug()
        c.wait_state("disconnected", 10)
        board.wait_for_clients(0, 5)
        r1 = self.reconnect(c, board)
        r2 = c.request("connect", port=board.url)
        self.assertFalse(r2["ok"])
        self.assertEqual(r2["error"]["code"], "E_ALREADY_CONNECTED")


class ConnectAbuse(BridgeTestCase):
    def test_op_before_connect_and_after_disconnect(self):
        board = self.new_board()
        c = self.new_bridge()
        for op, args in (("fs.list", {"path": "/"}), ("identity", {}), ("stop", {}), ("tty.write", {"b64": "AA=="}),
                         ("repl.attach", {}), ("run", {"source": "1"}), ("reset.soft", {}), ("exec", {"code": "1"})):
            resp = c.request(op, **args)
            self.assertFalse(resp["ok"], (op, resp))
            self.assertEqual(resp["error"]["code"], "E_NOT_CONNECTED", (op, resp))
        c.call("disconnect")           # idempotent
        c.call("repl.detach")
        c.call("connect", port=board.url)
        c.fail("connect", "E_ALREADY_CONNECTED", port=board.url)
        c.call("fs.list", path="/")
        c.call("disconnect")
        c.call("disconnect")
        c.fail("fs.list", "E_NOT_CONNECTED", path="/")
        c.fail("tty.write", "E_NOT_CONNECTED", b64="AA==")
        self.reconnect(c, board)
        c.call("fs.list", path="/")
        self.assertNoReset(board)
        c.assert_clean_stdout()

    def test_connect_to_a_dead_port_then_a_good_one(self):
        board = self.new_board()
        dead = self.new_board()
        url = dead.url
        dead.stop()
        c = self.new_bridge()
        err = c.fail("connect", ("E_NO_DEVICE", "E_PORT_BUSY"), port=url)
        c.ping()
        c.call("connect", port=board.url)
        c.call("fs.list", path="/")
        self.assertNoReset(board)


class Growth(BridgeTestCase):
    """In-process Server (no stdin loop): thread and descriptor counts must not grow with connect/disconnect cycles."""
    DEADLINE_S = 240

    @staticmethod
    def fd_count():
        try:
            return len(os.listdir("/dev/fd"))
        except OSError:
            return -1

    def make_server(self):
        from bridge.server import Server
        shorten_socket_close_sleep()
        srv = Server(out=io.BytesIO(), stdin=io.BytesIO(b""))
        self.addCleanup(srv.shutdown_sequence, "test")
        return srv

    def test_200_connect_disconnect_cycles_do_not_leak(self):
        board = self.new_board()
        srv = self.make_server()

        def cycle(i):
            wait_until(lambda: board.connected == 0, 5, "board to release client")
            r = srv.call({"op": "connect", "port": board.url})
            self.assertTrue(r["ok"], (i, r))
            if i % 4 == 0:
                self.assertTrue(srv.call({"op": "repl.attach"})["ok"])
            if i % 8 == 0:
                self.assertTrue(srv.call({"op": "fs.stat", "path": "/"})["ok"])
            self.assertTrue(srv.call({"op": "disconnect"})["ok"])

        for i in range(8):
            cycle(i)
        t0, f0 = threading.active_count(), self.fd_count()
        for i in range(200):
            cycle(i)
        t1, f1 = threading.active_count(), self.fd_count()
        self.assertLessEqual(t1 - t0, 2, "threads grew %d -> %d over 200 cycles: %s" % (t0, t1, [t.name for t in threading.enumerate()][-12:]))
        if f0 >= 0:
            self.assertLessEqual(f1 - f0, 3, "file descriptors grew %d -> %d over 200 cycles" % (f0, f1))
        self.assertNoReset(board)

    def test_unplug_reconnect_cycles_do_not_leak(self):
        board = self.new_board()
        srv = self.make_server()

        def cycle(i):
            wait_until(lambda: board.connected == 0, 5, "board to release client")
            r = srv.call({"op": "connect", "port": board.url})
            self.assertTrue(r["ok"], (i, r))
            board.unplug()
            wait_until(lambda: srv.state == "disconnected", 10, "unplug to be noticed")   # pump thread notices
        for i in range(5):
            cycle(i)
        t0, f0 = threading.active_count(), self.fd_count()
        for i in range(60):
            cycle(i)
        t1, f1 = threading.active_count(), self.fd_count()
        self.assertLessEqual(t1 - t0, 2, "threads grew %d -> %d: %s" % (t0, t1, [t.name for t in threading.enumerate()][-12:]))
        if f0 >= 0:
            self.assertLessEqual(f1 - f0, 3, "file descriptors grew %d -> %d" % (f0, f1))
        self.assertNoReset(board)


class ResetBeneathUs(BridgeTestCase):
    """The board resets by itself (watchdog, brown-out, button). The bridge must not answer with a Ctrl-D of its own."""

    def test_board_hard_reset_while_idle_then_file_op(self):
        board, c, _ = self.connected()
        c.call("repl.attach")
        c.call("fs.list", path="/")
        base_soft = board.events.count("soft_reset")
        board.hard_reset()
        board.wait_idle(5)
        mine = board.events.count("soft_reset")
        self.list_root_after_drop(c, phase="after external reset")
        c.call("fs.stat", path="/")
        self.assertEqual(board.events.count("soft_reset"), mine,
                         "the bridge triggered a soft reset after the board reset by itself: %r" % kinds(board))
        c.assert_clean_stdout()

    def test_board_hard_reset_mid_upload(self):
        board, c, _ = self.connected(faults=["slow:230400"])
        path = self.write_local(self.local_dir(), "big.bin", os.urandom(150 * 1024))
        rid = c.send("fs.put", local=path, remote="/big.bin")
        c.wait_event("progress", lambda e: e["id"] == rid and e["done"] > 0, 20)
        board.hard_reset()
        resp = c.result(rid, 40)
        self.assertFalse(resp["ok"], "an upload cannot survive a board reset")
        mine = board.events.count("soft_reset")
        self.list_root_after_drop(c, phase="after reset mid upload")
        self.assertEqual(board.events.count("soft_reset"), mine,
                         "soft reset sent by the bridge after the board reset under it: %r" % kinds(board))
        c.assert_clean_stdout()


if __name__ == "__main__":
    unittest.main()
