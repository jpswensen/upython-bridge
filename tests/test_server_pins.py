"""Pins for server-level behaviours of bridge/server.py that no other test noticed when they were broken.

Review 2 mutation-tested the bridge: six deliberate breakages of bridge/server.py survived the whole suite
(finding #15).  Each class below kills one of them.  Everything is black-box over NDJSON against the fake board
(tests/bridge_client.py), except where the contract is "the server refuses before any transport object exists"
(D-11), which is checked in-process with the transport replaced by a trap.  Nothing here opens a real port: the
bridge child is forced into safe mode by tests.support.child_env(), and the in-process test keeps MPY_SAFE_MODE as it
is and replaces ``Link`` with an object that fails the test if it is ever constructed.

    mutant                                                       killed by
    M06 a second worker thread                                   OneWorkerTests
    M09 reset.hard without the confirmed:true check              HardResetConfirmationTests
    M10 no prompt redraw to the REPL view after a file op        ReplViewRedrawTests
    M19 connect "auto" accepted (masked by safe mode)            ConnectAutoRefusedByTheServerTests
    M23 repl.attach writes CR into a running program's stdin     ReplAttachNeverTypesTests (a Run is a worker op, so
                                                                 attach is queued behind it: only a connect-time
                                                                 program can be running when attach executes)
    M24 a failed stop marks the state idle                       FailedStopKeepsRunningTests
(SecondRunTests is not a mutant kill: it pins old-defects 06.6, which had no bridge-level test.)
"""
from __future__ import annotations

import types
import unittest
from unittest import mock

import bridge.link  # noqa: F401  (puts bridge/vendor on sys.path, so `import serial` works below)
from tests.bridge_client import BridgeTestCase
from tests.support import TimedTestCase, wait_until
from tools.fakeboard import PROGRAMS


class OneWorkerTests(BridgeTestCase):
    """PINS 03.8, RQ-SAFE-3 (docs/protocol.md section 6): ONE port-owner worker.  Two workers would let a second op
    leave the queue (and so escape coalescing and priorities) while the first one still holds the port."""
    DEADLINE_S = 90

    def _occupy(self, client, seconds=1.5):
        """A file op (exec) that holds the port for about ``seconds``; returns its request id once the board is in rawop."""
        m = client.mark()
        rid = client.send("exec", code="import time\ntime.sleep(%s)\nprint('slept')" % seconds)
        client.wait_state("rawop", since=m)
        return rid

    def test_background_puts_to_one_path_coalesce_last_write_wins(self):
        """PINS 03.8: three background puts to one remote path queued behind a running op: the first two are answered
        E_CANCELLED (superseded), only the last reaches the board.  With a second worker thread the first put leaves the
        queue the moment it arrives, so it can no longer be superseded and runs, too."""
        board, client, _ = self.connected("esp32")
        folder = self.local_dir()
        paths = [self.write_local(folder, "v%d.py" % i, "x = %d\n" % i) for i in range(3)]
        busy = self._occupy(client)
        ids = []
        for p in paths:
            ids.append(client.send("fs.put", local=p, remote="/auto.py", background=True))
            client.ping()                       # the reader has queued it; a stray second worker has had its chance to take it
        res = [client.result(r, 30) for r in ids]
        self.assertEqual([r["ok"] for r in res], [False, False, True], res)
        for r in res[:2]:
            self.assertEqual(r["error"]["code"], "E_CANCELLED", r)
        self.assertEqual(board.read_file("/auto.py"), b"x = 2\n")
        self.assertTrue(client.result(busy, 20)["ok"])
        self.assertEqual(client.responses[ids[0]]["error"]["code"], "E_CANCELLED")

    def test_priority_classes_and_arrival_order_behind_a_busy_op(self):
        """PINS 03.8: repl.* (1) before run (2) before explicit file ops (3) in arrival order before background (4);
        every request answered exactly once."""
        board, client, _ = self.connected("esp32")
        busy = self._occupy(client)
        sent = []
        for op, args in (("fs.list", {"path": "/", "background": True}), ("fs.list", {"path": "/"}),
                         ("fs.stat", {"path": "/"}), ("run", {"source": "print('r')", "name": "r.py"}),
                         ("repl.attach", {})):
            sent.append(client.send(op, **args))
            client.ping()
        bg, f1, f2, run, attach = sent
        for rid in [busy] + sent:
            self.assertTrue(client.result(rid, 30)["ok"], client.responses[rid])
        order = sorted(sent, key=lambda r: client.responses[r]["_n"])
        self.assertEqual(order, [attach, run, f1, f2, bg])
        client.assert_clean_stdout()


class HardResetConfirmationTests(BridgeTestCase):
    """PINS RQ-RESET-5, RQ-SAFE-2 (section 3 reset.hard): the hardware reset is reachable only with confirmed:true.  The
    check must live in the server: on a URL port the transport answers E_UNSUPPORTED to a reset anyway, which would hide
    its absence from any test that only looks at ``ok``."""
    DEADLINE_S = 60

    def test_unconfirmed_hard_reset_is_a_protocol_error_never_a_transport_attempt(self):
        board, client, _ = self.connected("esp32")
        m = client.mark()
        for extra in ({}, {"confirmed": False}, {"confirmed": "true"}, {"confirmed": 1}, {"confirmed": "yes"},
                      {"confirmed": None}, {"confirmed": [True]}):
            with self.subTest(args=extra):
                err = client.fail("reset.hard", "E_PROTOCOL", **extra)         # not E_UNSUPPORTED: the guard comes first
                self.assertIn("confirmed", err["message"] + err["detail"] + err["hint"])
        self.assertEqual(client.states(m), [], "a refused reset must not touch the state")
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("soft_reset"), 0)

    def test_confirmed_hard_reset_reaches_the_transport_which_has_no_pulse_on_a_url(self):
        board, client, _ = self.connected("esp32")
        err = client.fail("reset.hard", "E_UNSUPPORTED", confirmed=True)
        self.assertTrue(err["hint"] or err["message"])
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_the_guard_is_in_the_server_not_in_the_transport(self):
        """In-process, with a link double that would happily pulse: no confirmed -> no hard_reset call at all."""
        from bridge import server
        from bridge.errors import BridgeError

        calls = []
        link = types.SimpleNamespace(is_open=True, hard_reset=lambda **kw: calls.append(kw) or "prompt",
                                     check_alive=lambda: None)
        srv = server.Server()
        srv.link = link
        for extra in ({}, {"confirmed": "true"}, {"confirmed": 1}, {"confirmed": False}):
            with self.assertRaises(BridgeError) as cm:
                srv.op_reset_hard(server.Request(1, "reset.hard", dict(extra)))
            self.assertEqual(cm.exception.code, "E_PROTOCOL", extra)
        self.assertEqual(calls, [], "hard_reset was called without confirmed:true")
        srv.op_reset_hard(server.Request(2, "reset.hard", {"confirmed": True}))
        self.assertEqual(len(calls), 1)


class ReplViewRedrawTests(BridgeTestCase):
    """PINS 02.3 (section 5 idle -> rawop -> idle): a file op borrows the raw REPL; the attached REPL view sees none of the
    borrow, only the prompt redrawn afterwards, every time."""
    DEADLINE_S = 90

    @staticmethod
    def _settle_first_borrow(client):
        """The first file op of a session queues one housekeeping borrow (``_clean_orphans``, once per session) behind
        itself; wait for it so that the state events and repl bytes measured afterwards are the measured op's alone."""
        m = client.mark()
        client.call("fs.list", path="/")
        client.wait_event("state", lambda e: e.get("reason") == "_clean_orphans done", 20, since=m)

    def test_the_repl_view_gets_its_prompt_back_after_each_file_op_and_nothing_else(self):
        board, client, _ = self.connected("esp32")
        client.call("repl.attach")
        client.wait_stream("repl", b">>>", 8)
        self._settle_first_borrow(client)
        for round_ in range(2):
            m = client.mark()
            client.call("fs.list", path="/")
            self.assertEqual([(e["prev"], e["state"]) for e in client.events_of("state", m)],
                             [("idle", "rawop"), ("rawop", "idle")])
            client.wait_stream("repl", b">>> ", 8, since=m)               # the redraw: absent when exit_raw(redraw=False)
            client.ping()
            seen = client.repl_bytes(m)
            for junk in (b"raw REPL", b"@@", b"MicroPython v", b"OK\x04"):
                self.assertNotIn(junk, seen, (round_, seen))
        self.assertEqual(board.events.count("soft_reset"), 0)
        self.assertEqual(board.mode, "friendly")

    def test_a_detached_view_receives_nothing_from_a_file_op(self):
        board, client, _ = self.connected("esp32")
        client.call("repl.attach")
        client.wait_stream("repl", b">>>", 8)
        self._settle_first_borrow(client)
        client.call("repl.detach")
        m = client.mark()
        client.call("fs.list", path="/")
        client.ping()
        self.assertEqual(client.repl_bytes(m), b"")
        client.call("repl.attach")                                           # attaching again redraws a prompt
        client.wait_stream("repl", b">>>", 8, since=m)


class ConnectAutoRefusedByTheServerTests(TimedTestCase):
    """PINS D-11 (CLAUDE.md hard rule 1: never `connect auto`): "auto" is a UI choice over ports.list.  In a bridge process
    safe mode answers E_SAFE_MODE first and hides a missing server check, so the server's own refusal is tested
    in-process, past the safe-mode gate, with the transport replaced by a trap."""
    DEADLINE_S = 30

    def test_auto_is_refused_as_e_protocol_before_any_transport_object_exists(self):
        import serial
        from bridge import server
        from bridge.errors import BridgeError

        built = []

        def trap(*a, **k):
            built.append((a, k))
            raise AssertionError("a transport object was built for 'auto'")

        for text in ("auto", "AUTO", "  auto ", "Auto\t"):
            with mock.patch.object(server, "safe_mode_check", lambda port: None), \
                    mock.patch.object(server, "Link", trap), \
                    mock.patch.object(serial.Serial, "__init__", trap), \
                    mock.patch.object(serial, "serial_for_url", trap):
                srv = server.Server()
                with self.assertRaises(BridgeError) as cm:
                    srv.op_connect(server.Request(1, "connect", {"port": text}))
            self.assertEqual(cm.exception.code, "E_PROTOCOL", text)
            self.assertEqual(built, [])
            self.assertEqual(srv.state, "disconnected")
            self.assertIsNone(srv.link)


class ReplAttachNeverTypesTests(BridgeTestCase):
    """PINS RQ-RUN-1, RQ-SAFE-3 (section 3 repl.attach: "start forwarding repl events ... does not reset"): attaching the
    REPL view to a board whose program is running must not write a byte; a CR would be the program's input."""
    DEADLINE_S = 60

    def test_attach_to_a_connect_time_program_writes_nothing(self):
        board, client, resp = self.connected("esp32", faults=("main_forever",))
        self.assertEqual(resp["state"], "running")
        client.call("repl.attach")
        client.tty_write(b"z")                  # ordered after anything the attach might have written
        wait_until(lambda: any(e.get("hex") == "7a" for e in board.events.of("stdin_bytes")), 5, "the z to reach the board")
        self.assertEqual(sum(e["n"] for e in board.events.of("stdin_bytes")), 1, board.events.of("stdin_bytes"))

    def test_attach_at_an_idle_prompt_redraws_it(self):
        board, client, _ = self.connected("esp32")
        m = client.mark()
        client.call("repl.attach")
        client.wait_stream("repl", b">>>", 8, since=m)
        self.assertEqual(board.events.count("soft_reset"), 0)


class FailedStopKeepsRunningTests(BridgeTestCase):
    """PINS RQ-SAFE-3, 02.7 (section 5 running -> stop): "if no prompt in timeoutMs: reply stopped:false, state stays
    running".  Only a stop that reached a prompt may move a connect-time program's state to idle."""
    DEADLINE_S = 60

    def test_failed_stop_of_a_connect_time_program_keeps_the_state_running(self):
        board, client, resp = self.connected("esp32", faults=("main_forever", "ignore_ctrl_c"))
        self.assertEqual(resp["state"], "running")
        m = client.mark()
        self.assertEqual(client.call("stop", timeoutMs=300)["stopped"], False)
        self.assertEqual(client.call("stop", timeoutMs=300)["stopped"], False)
        self.assertNotIn("idle", client.states(m))
        client.fail("fs.list", "E_PROGRAM_RUNNING", path="/")
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("soft_reset"), 0)

    def test_successful_stop_of_a_connect_time_program_moves_to_idle_and_unblocks_file_ops(self):
        board, client, resp = self.connected("esp32", faults=("main_forever",))
        self.assertEqual(resp["state"], "running")
        client.fail("fs.list", "E_PROGRAM_RUNNING", path="/")
        m = client.mark()
        self.assertTrue(client.call("stop")["stopped"])
        self.assertEqual(client.states(m), ["idle"])
        client.call("fs.list", path="/")
        self.assertEqual(board.events.count("soft_reset"), 0)
        self.assertEqual(board.events.count("hard_reset"), 0)


class SecondRunTests(BridgeTestCase):
    """PINS 06.6 (section 6: a queued `run` while a program runs asks the program to end): the old Run typed the next command
    into a terminal that a `while True` program still occupied, so it never executed.  Now the running program is
    interrupted (Ctrl-C, never a reset beyond the Run's own soft reset) and the second Run starts."""
    DEADLINE_S = 60

    def test_a_second_run_interrupts_the_first_and_then_executes(self):
        board, client, _ = self.connected("esp32")
        first = self.start_program(client, PROGRAMS["spin"], "spin.py")
        m = client.mark()
        second = client.send("run", source="print('second-ran')", name="second.py")
        r1, r2 = client.result(first, 30), client.result(second, 30)
        self.assertEqual(r1["exit"], "interrupted", r1)
        self.assertEqual(r2["exit"], "ok", r2)
        self.assertLess(r1["_n"], r2["_n"])
        self.assertIn(b"second-ran", client.out_bytes(m))
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("soft_reset"), 2, "one soft reset per Run, none for the interrupt")


if __name__ == "__main__":
    unittest.main()
