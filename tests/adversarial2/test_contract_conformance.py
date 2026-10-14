"""Review 2, focus "contract": line-by-line conformance of bridge/server.py with docs/protocol.md (sections 1-10,
Appendix A and B).  Black-box over NDJSON against the fake board; nothing here opens a real port.

Every test name says which part of the contract it checks.  A test named ``test_FAILS_*`` documents an OPEN deviation (it fails until the code or
the contract changes); none is open today: the ones reproduced when this file was written (round 2 findings 4/13, 10,
14) are fixed, and every test here stays as a regression test.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from bridge import devfs  # noqa: F401  (also puts bridge/vendor on sys.path through bridge.link)
from tests.bridge_client import (BRIDGE_PATH, ROOT, BridgeTestCase, b64, bridge_argv, run_cli)
from tests.support import child_env, wait_until
from tools.fakeboard import PROGRAMS, FakeBoard

LOCAL_NEVER_A_DEVICE = "/dev/cu.review2-nonexistent"      # not a real node; only used to prove E_SAFE_MODE fires first


def _ids(client, *rids):
    return [client.responses[r]["_n"] for r in rids]


class WireAndFramingTests(BridgeTestCase):
    DEADLINE_S = 60

    def test_hello_is_first_line_with_all_fields(self):
        """Section 2: hello is the first line and carries proto, bridge, python, pyserial, platform, pid, vendored."""
        client = self.new_bridge()
        first = client.events[0]
        self.assertEqual(first["ev"], "hello")
        self.assertEqual(first["proto"], 1)
        self.assertIsInstance(first["bridge"], str)
        self.assertEqual(first["python"], "%d.%d.%d" % sys.version_info[:3])
        self.assertEqual(first["pyserial"], "3.5")
        self.assertIn(first["platform"], ("darwin", "win32", "linux"))
        self.assertEqual(first["pid"], client.pid)
        self.assertIn("mpremote", first["vendored"])
        has_dir = os.path.isdir(os.path.join(ROOT, "bridge", "vendor", "mpremote"))
        self.assertEqual(first["vendored"]["mpremote"], "1.29.0" if has_dir else None)

    def test_unknown_and_private_ops_are_e_unsupported_with_the_id_echoed(self):
        client = self.new_bridge()
        for op in ("nonesuch", "_clean_orphans", "reset.nonesuch", "machine.reset"):      # reset.capability / reset.machine became real ops in R1.5
            resp = client.request(op)
            self.assertFalse(resp["ok"], op)
            self.assertEqual(resp["error"]["code"], "E_UNSUPPORTED", op)
            self.assertIn(resp["id"], client.responses)

    def test_malformed_lines_are_e_protocol_and_the_bridge_survives(self):
        client = self.new_bridge()
        m = client.mark()
        client.send_raw(b"this is not json\n")
        client.send_raw(b"[1, 2]\n")
        client.send_raw(b'{"op": "ping"}\n')                     # no id
        client.send_raw(b'{"id": 5.5, "op": "ping"}\n')          # id not an integer
        client.send_raw(b'{"id": 6}\n')                          # no op
        client.send_raw(b'\xff\xfe\n')                           # not UTF-8
        client.ping()
        client.assert_clean_stdout()
        self.assertTrue(client.alive)

    def test_oversize_line_is_rejected_with_the_id_and_the_bridge_keeps_serving(self):
        """Section 2: lines are limited to 4 MiB."""
        client = self.new_bridge()
        client.send_raw(b'{"id": 77, "op": "exec", "code": "' + b"a" * (4 * 1024 * 1024 + 100) + b'"}\n')
        client.result(77, 20)
        self.assertFalse(client.responses[77]["ok"])
        self.assertEqual(client.responses[77]["error"]["code"], "E_PROTOCOL")
        client.ping()

    def test_state_events_form_a_consistent_chain_over_a_whole_session(self):
        """Section 5: every state event's prev is the previous state, no self-transitions, only documented transitions."""
        board, client, _ = self.connected("esp32")
        client.call("repl.attach")
        client.call("fs.list", path="/")
        rid = self.start_program(client, PROGRAMS["spin"], "spin.py")
        self.assertTrue(client.call("stop")["stopped"])
        client.result(rid, 10)
        client.call("fs.list", path="/")
        client.call("repl.detach")
        client.call("disconnect")
        chain = client.events_of("state")
        allowed = {("disconnected", "connecting"), ("connecting", "idle"), ("connecting", "running"),
                   ("connecting", "disconnected"), ("idle", "rawop"), ("rawop", "idle"), ("idle", "running"),
                   ("running", "idle"), ("running", "rawop"), ("rawop", "running"), ("idle", "disconnected"),
                   ("running", "disconnected"), ("rawop", "disconnected")}
        cur = "disconnected"
        for ev in chain:
            self.assertEqual(ev["prev"], cur, chain)
            self.assertNotEqual(ev["state"], cur, chain)
            self.assertIn((ev["prev"], ev["state"]), allowed, ev)
            cur = ev["state"]
        self.assertEqual(cur, "disconnected")
        client.assert_clean_stdout()


class ConnectTests(BridgeTestCase):
    DEADLINE_S = 90

    def test_connect_result_shape_and_no_side_effects(self):
        """Section 3 connect + A.2 portInfo + RQ-SAFE-1: result fields; no reset, no interrupt, no raw REPL entry."""
        board, client, resp = self.connected("esp32")
        self.assertIn(resp["state"], ("idle", "running", "unknown"))
        self.assertIn(resp["sync"], ("prompt", "running-program", "silent", "prompt-unverified"))
        info = resp["portInfo"]
        for key in ("port", "requested", "baud", "kind", "policy", "platform", "pyserial", "vid", "pid", "adapter",
                    "exclusive", "canHardReset"):
            self.assertIn(key, info)
        self.assertEqual(info["kind"], "url")
        self.assertEqual(info["baud"], 115200)
        self.assertIn(info["canHardReset"], (None, False))
        client.call("disconnect")
        for name in ("soft_reset", "hard_reset", "raw_enter", "exec", "interrupt"):
            self.assertEqual(board.events.count(name), 0, name)
        self.assertEqual(self.user_programs_started(board), 0)

    def test_twenty_connect_disconnect_cycles_never_reset_or_interrupt(self):
        """RQ-SAFE-1 acceptance: event log shows 0 soft resets and 0 RTS pulses over 20 connect/disconnect cycles."""
        board = self.new_board("esp32")
        client = self.new_bridge()
        client.call("config", idleListenMs=100)
        for i in range(20):
            self.reconnect(client, board)
            client.call("disconnect")
        for name in ("soft_reset", "hard_reset", "raw_enter", "interrupt"):
            self.assertEqual(board.events.count(name), 0, name)
        self.assertEqual(self.user_programs_started(board), 0)

    def test_connect_argument_errors_and_safe_mode(self):
        board = self.new_board("esp32")
        client = self.new_bridge()
        for args in ({}, {"port": 5}, {"port": board.url, "baud": "fast"}, {"port": board.url, "baud": True},
                     {"port": board.url, "openPolicy": "bogus"}, {"port": board.url, "openPolicy": 5}):
            err = client.fail("connect", "E_PROTOCOL", **args)
            self.assertTrue(err["message"], args)
        m = client.mark()
        for port in (LOCAL_NEVER_A_DEVICE, "COM99", "socket://127.0.0.1@example.com:80", "socket://example.com:80",
                     "spy://%s" % LOCAL_NEVER_A_DEVICE, "hwgrep://x", "socket://127.attacker.example:80", "alt://x"):
            client.fail("connect", "E_SAFE_MODE", port=port)
        self.assertEqual(client.states(m), [], "a refused connect must not even enter 'connecting'")
        client.fail("connect", ("E_PROTOCOL", "E_SAFE_MODE"), port="auto")
        client.call("connect", port=board.url)
        client.fail("connect", "E_ALREADY_CONNECTED", port=board.url)

    def test_reconnect_after_unplug_needs_no_extra_disconnect(self):
        """Section 5: unplug -> disconnected -> connecting (the client's decision).  A connect after the unplug must work."""
        board, client, _ = self.connected("esp32")
        m = client.mark()
        board.unplug()
        ev = client.wait_event("state", lambda e: e["state"] == "disconnected", 10, since=m)
        self.assertEqual(ev.get("reason"), "unplugged")
        client.fail("fs.list", ("E_NO_DEVICE", "E_NOT_CONNECTED"), path="/")
        board2 = self.new_board("esp32")
        resp = client.request("connect", port=board2.url)
        self.assertTrue(resp["ok"], "connect after an unplug was refused: %r" % (resp,))

    def test_running_program_is_left_alone_by_connect_identity_and_disconnect(self):
        """Section 3 connect/identity/disconnect + RQ-ID-1 + R-ARCH-5."""
        board, client, resp = self.connected("esp32", faults=("main_forever",))
        self.assertEqual(resp["state"], "running")
        self.assertEqual(resp["sync"], "running-program")
        client.fail("identity", "E_PROGRAM_RUNNING")
        client.fail("fs.list", "E_PROGRAM_RUNNING", path="/")
        client.fail("fs.put", "E_PROGRAM_RUNNING", local=__file__, remote="/x.py")
        for name in ("interrupt", "soft_reset", "hard_reset", "raw_enter"):
            self.assertEqual(board.events.count(name), 0, name)
        client.call("disconnect")
        self.assertTrue(board.program_running, "disconnect without stopFirst must leave the program running")
        self.assertEqual(board.events.count("interrupt"), 0)


class QueueAndStateTests(BridgeTestCase):
    DEADLINE_S = 90

    def _occupy(self, client, seconds=1.5):
        m = client.mark()
        rid = client.send("exec", code="import time\ntime.sleep(%s)\nprint('slept')" % seconds)
        client.wait_state("rawop", since=m)
        return rid

    def test_file_op_borrows_the_raw_repl_without_reset_and_the_repl_view_sees_only_the_prompt(self):
        """Section 5 (idle -> rawop -> idle, REPL restored with a prompt redraw) + RQ-SAFE-1."""
        board, client, _ = self.connected("esp32")
        client.call("repl.attach")
        client.wait_stream("repl", b">>>", 8)
        m = client.mark()
        client.call("fs.list", path="/")
        # protocol.md (devfs): once per session, right after the FIRST file op, the bridge sweeps stale *.mpytmp files in a
        # second, separate borrow.  Wait for it (a deterministic event) so the counts below do not race with it; the
        # fs.list borrow itself is the first idle->rawop->idle pair and enters the raw REPL exactly once.
        client.wait_event("state", lambda e: e.get("reason") == "_clean_orphans done", 10, since=m)
        evs = client.events_of("state", m)
        self.assertEqual([(e["prev"], e["state"]) for e in evs],
                         [("idle", "rawop"), ("rawop", "idle"), ("idle", "rawop"), ("rawop", "idle")])
        self.assertEqual([e.get("reason") for e in evs][:2], ["fs.list", "fs.list done"])
        client.wait_stream("repl", b">>> ", 8, since=m)
        client.ping()
        seen = client.repl_bytes(m)
        for junk in (b"raw REPL", b"@@", b"MicroPython v", b"OK\x04"):
            self.assertNotIn(junk, seen)
        self.assertEqual(board.events.count("soft_reset"), 0)
        self.assertEqual(board.events.count("raw_enter"), 2)   # fs.list + the one-off orphan sweep, nothing else
        self.assertEqual(board.events.count("raw_exit"), 2)
        self.assertEqual(board.mode, "friendly")

    def test_cancel_a_queued_op_and_unknown_targets(self):
        board, client, _ = self.connected("esp32")
        busy = self._occupy(client)
        victim = client.send("fs.list", path="/")
        resp = client.request("cancel", target=victim)
        self.assertEqual(resp["cancelled"], True)
        self.assertEqual(client.result(victim, 10)["error"]["code"], "E_CANCELLED")
        self.assertEqual(client.call("cancel", target=987654)["cancelled"], False)
        client.fail("cancel", "E_PROTOCOL")
        self.assertTrue(client.result(busy, 10)["ok"])

    def test_priority_classes_and_arrival_order(self):
        """Section 6: connect/disconnect/repl.* (1) before run (2) before explicit file ops (3) before background (4)."""
        board, client, _ = self.connected("esp32")
        busy = self._occupy(client, 1.5)
        bg = client.send("fs.list", path="/", background=True)
        f1 = client.send("fs.list", path="/")
        f2 = client.send("fs.stat", path="/")
        run = client.send("run", source="print('r')", name="r.py")
        attach = client.send("repl.attach")
        for rid in (busy, bg, f1, f2, run, attach):
            self.assertTrue(client.result(rid, 20)["ok"], client.responses[rid])
        order = sorted((bg, f1, f2, run, attach), key=lambda r: client.responses[r]["_n"])
        self.assertEqual(order, [attach, run, f1, f2, bg])

    def test_background_puts_to_one_path_coalesce_last_write_wins(self):
        """Section 6: fs.put background:true is coalesced by remote path, last write wins."""
        board, client, _ = self.connected("esp32")
        folder = self.local_dir()
        paths = [self.write_local(folder, "v%d.py" % i, "x = %d\n" % i) for i in range(3)]
        busy = self._occupy(client, 1.5)
        ids = [client.send("fs.put", local=p, remote="/auto.py", background=True) for p in paths]
        res = [client.result(r, 20) for r in ids]
        self.assertEqual([r["ok"] for r in res], [False, False, True], res)
        self.assertEqual(res[0]["error"]["code"], "E_CANCELLED")
        self.assertEqual(board.read_file("/auto.py"), b"x = 2\n")
        self.assertTrue(client.result(busy, 10)["ok"])

    def test_bypass_ops_answer_while_a_long_op_holds_the_port(self):
        """Section 6: ping and tty.write run on the reader thread and do not wait for the worker."""
        board, client, _ = self.connected("esp32")
        busy = self._occupy(client, 1.5)
        t0 = time.monotonic()
        client.ping()
        client.tty_write(b" ")
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertFalse(client.has_result(busy))
        self.assertTrue(client.result(busy, 10)["ok"])


class RunStopResetTests(BridgeTestCase):
    DEADLINE_S = 90

    def test_run_argument_validation(self):
        board, client, _ = self.connected("esp32")
        client.fail("run", "E_PROTOCOL")
        client.fail("run", "E_PROTOCOL", source="print(1)", local=__file__)
        client.fail("run", "E_PROTOCOL", source="print(1)", reset="yes")
        client.fail("run", "E_PROTOCOL", source="print(1)", stdin=1)
        client.fail("run", "E_PROTOCOL", source=5)
        client.fail("run", "E_PROTOCOL", source="print(1)", name=7)
        client.fail("run", "E_LOCAL_IO", local=os.path.join(tempfile.gettempdir(), "review2-does-not-exist.py"))
        self.assertEqual(board.events.count("soft_reset"), 0)

    def test_run_result_events_and_state_in_the_course_path_fixture(self):
        """Section 5 Run + RQ-RUN-2 + D-07: exit kinds, durationMs, err names the LOCAL path, one soft reset, friendly after."""
        board, client, _ = self.connected("esp32")
        folder = self.local_dir()
        path = self.write_local(folder, "lab (1) é.py", "print('before')\nraise ValueError('boom')\n")
        m = client.mark()
        resp = client.call("run", local=path)
        self.assertEqual(resp["exit"], "exception")
        self.assertIsInstance(resp["durationMs"], int)
        err = client.err_bytes(m).decode("utf-8")
        self.assertIn('File "%s", line 2' % path, err)
        self.assertIn(b"before", client.out_bytes(m))
        self.assertEqual([e["state"] for e in client.events_of("state", m)], ["running", "idle"])
        self.assertEqual(board.events.count("soft_reset"), 1)
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.mode, "friendly")
        m2 = client.mark()
        self.assertEqual(client.call("run", source="print(1)", name="n.py", reset=False)["exit"], "ok")
        self.assertEqual(board.events.count("soft_reset"), 1, "reset:false must not soft-reset")
        self.assertEqual(client.call("run", source="x = 1")["exit"], "ok")
        client.assert_clean_stdout()

    def test_run_without_compile_support_and_control_bytes_in_the_source(self):
        """Section 5 / A.3: no compile -> raw source and '<stdin>' tracebacks; 0x03/0x04 in raw source -> E_PROTOCOL."""
        board, client, _ = self.connected("esp32", faults=("no_compile",))
        m = client.mark()
        self.assertEqual(client.call("run", source="1/0\n", name="x.py")["exit"], "exception")
        self.assertIn(b"<stdin>", client.err_bytes(m))
        client.fail("run", "E_PROTOCOL", source="print('a\x03b')\n")
        client.fail("run", "E_PROTOCOL", source="print('a\x04b')\n")
        self.assertEqual(client.call("run", source="print(2)")["exit"], "ok")

    def test_run_with_compile_survives_control_characters_in_a_string(self):
        board, client, _ = self.connected("esp32")
        resp = client.request("run", source="s = 'a\x03b\x04c'\nprint(len(s))\n")
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(resp["exit"], "ok")

    def test_ctrl_c_through_tty_write_is_dropped_when_run_stdin_is_false(self):
        """Section 3 tty.write: 'raw bytes to the device ... \\x03 here is a plain interrupt'.  With run stdin:false the
        server drops EVERY tty.write byte, including Ctrl-C, so the keyboard cannot interrupt the program (RQ-SAFE-3)."""
        board, client, _ = self.connected("esp32")
        rid = self.start_program(client, PROGRAMS["spin"], "spin.py", stdin=False)
        client.tty_write(b"\x03")
        resp = client.result(rid, 5)
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(resp["exit"], "interrupted")

    def test_keystrokes_including_ctrl_d_reach_the_running_program(self):
        """RQ-RUN-1: raw keystrokes (Ctrl-D too) go to the program's sys.stdin; no extra reset."""
        board, client, _ = self.connected("esp32")
        rid = self.start_program(client, PROGRAMS["echo_keys"], "keys.py", ready=b"READY")
        m = client.mark()
        client.tty_write(b"\x04")
        client.wait_out(b"key:'\\x04'", 5, since=m)
        client.tty_write(b"q")
        self.assertEqual(client.result(rid, 10)["exit"], "ok")
        self.assertEqual(board.events.count("soft_reset"), 1)

    def test_unplug_during_run_answers_disconnected_and_emits_the_state(self):
        board, client, _ = self.connected("esp32")
        rid = self.start_program(client, PROGRAMS["spin"], "spin.py")
        m = client.mark()
        board.unplug()
        resp = client.result(rid, 10)
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(resp["exit"], "disconnected")
        ev = client.wait_event("state", lambda e: e["state"] == "disconnected", 5, since=m)
        self.assertEqual(ev.get("reason"), "unplugged")

    def test_stop_that_cannot_stop_never_escalates_to_a_reset(self):
        """RQ-SAFE-2/3 + section 3 stop: stopped:false, state stays running, no hard reset, no extra soft reset."""
        board, client, _ = self.connected("esp32")
        rid = self.start_program(client, PROGRAMS["swallow_ctrl_c"], "swallow.py", ready=b"loop")
        m = client.mark()
        resp = client.call("stop", timeoutMs=500)
        self.assertEqual(resp["stopped"], False)
        self.assertIsInstance(resp["ms"], int)
        self.assertGreaterEqual(resp["ms"], 400)
        self.assertEqual(client.call("stop", timeoutMs=300)["stopped"], False)
        self.assertNotIn("idle", client.states(m))
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("soft_reset"), 1, "only the Run's own soft reset")
        self.assertFalse(client.has_result(rid))

    def test_stop_at_an_idle_prompt_and_stop_without_connection(self):
        client = self.new_bridge()
        client.fail("stop", "E_NOT_CONNECTED")
        board = self.new_board("esp32")
        client.call("connect", port=board.url)
        resp = client.call("stop")
        self.assertTrue(resp["stopped"])
        self.assertEqual(board.events.count("soft_reset"), 0)

    def test_reset_ops(self):
        """Section 3 reset.soft / reset.hard: soft = one Ctrl-D; hard needs confirmed:true and has no pulse on a URL."""
        board, client, _ = self.connected("esp32")
        client.fail("reset.hard", "E_PROTOCOL")
        client.fail("reset.hard", "E_PROTOCOL", confirmed="true")
        client.fail("reset.hard", "E_PROTOCOL", confirmed=1)
        self.assertEqual(board.events.count("hard_reset"), 0)
        err = client.fail("reset.hard", ("E_UNSUPPORTED", "E_PROTOCOL"), confirmed=True)
        self.assertEqual(err["code"], "E_UNSUPPORTED")
        self.assertEqual(board.events.count("hard_reset"), 0)
        client.call("reset.soft")
        self.assertEqual(board.events.count("soft_reset"), 1)
        self.assertEqual(board.mode, "friendly")
        self.assertEqual(client.states(0)[-1], "idle")

    def test_shutdown_op_replies_exits_zero_and_interrupts_a_running_program_first(self):
        """Section 1 + 3 shutdown + RQ-SAFE-4."""
        board, client, _ = self.connected("esp32")
        self.start_program(client, PROGRAMS["spin"], "spin.py")
        resp = client.request("shutdown")
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(client.wait_exit(10), 0)
        ev_int = board.events.wait_for("interrupt", 5)
        ev_disc = board.events.wait_for("disconnect", 5)
        self.assertIsNotNone(ev_int)
        self.assertIsNotNone(ev_disc)
        self.assertLess(ev_int["seq"], ev_disc["seq"])
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("soft_reset"), 1)

    def test_stdin_eof_interrupts_a_running_program_before_closing_the_port(self):
        board, client, _ = self.connected("esp32")
        self.start_program(client, PROGRAMS["spin"], "spin.py")
        self.assertEqual(client.close(), 0)
        self.assertEqual(client.shutdown, "eof")
        ev_int = board.events.wait_for("interrupt", 5)
        ev_disc = board.events.wait_for("disconnect", 5)
        self.assertLess(ev_int["seq"], ev_disc["seq"])


class GenericBoardTests(BridgeTestCase):
    """RQ-GEN-4: identity, file listing and Run/Stop pass for every fake-board profile; RQ-ID-1 identity shape."""
    DEADLINE_S = 150

    def test_identity_run_and_stop_on_every_profile(self):
        for profile in ("esp32", "esp32-legacy", "esp32s3-usb", "rp2", "rp2350", "stm32", "esp8266", "custom-frozen", "unix-like"):
            with self.subTest(profile=profile):
                board, client, _ = self.connected(profile)
                ident = client.call("identity")
                for key in ("impl", "version", "machine", "build", "mpy", "platform", "uname", "uniqueId", "syspath",
                            "root", "caps", "profileHints"):
                    self.assertIn(key, ident)
                self.assertEqual(len(ident["version"]), 3)
                for key in ("sysname", "nodename", "release", "version", "machine"):
                    self.assertIn(key, ident["uname"])
                for key in ("hash", "compile", "paste", "mem"):
                    self.assertIn(key, ident["caps"])
                self.assertIn(ident["caps"]["hash"], ("sha256", "none"))
                for key in ("modules", "frozen", "fsTotal", "fsFree"):
                    self.assertIn(key, ident["profileHints"])
                man = client.call("fs.manifest", root="/")
                self.assertEqual(man["hash"], ident["caps"]["hash"])
                self.assertIs(man["truncated"], False)
                m = client.mark()
                self.assertEqual(client.call("run", source="print(6*7)", name="t.py")["exit"], "ok")
                self.assertIn(b"42", client.out_bytes(m))
                rid = self.start_program(client, PROGRAMS["spin"], "spin.py")
                self.assertTrue(client.call("stop")["stopped"])
                self.assertEqual(client.result(rid, 10)["exit"], "interrupted")
                self.assertEqual(board.events.count("hard_reset"), 0)
                self.assertEqual(board.events.count("soft_reset"), 2)
                client.close()
                board.stop()


class FsWireTests(BridgeTestCase):
    DEADLINE_S = 120

    def test_put_get_roundtrip_in_the_course_path_with_progress_and_expect_sha(self):
        """Sections 3/4 + RQ-CLOUD-1/4: put/get with the OneDrive-style fixture, progress before the response, expectSha skip."""
        board, client, _ = self.connected("esp32")
        folder = self.local_dir()
        data = bytes(range(256)) * 1200
        local = os.path.join(folder, "däta (1).bin")
        with open(local, "wb") as f:
            f.write(data)
        m = client.mark()
        rid = client.send("fs.put", local=local, remote="/lab (1)/däta.bin")
        resp = client.result(rid, 30)
        self.assertTrue(resp["ok"], resp)
        for key in ("bytes", "sha256", "skipped", "sent", "verified"):
            self.assertIn(key, resp)
        self.assertEqual(resp["bytes"], len(data))
        prog = [e for e in client.events_of("progress", m) if e["id"] == rid]
        self.assertTrue(prog)
        self.assertTrue(all(e["_n"] < resp["_n"] for e in prog))
        for e in prog:
            for key in ("label", "done", "total"):
                self.assertIn(key, e)
            self.assertLessEqual(e["done"], e["total"])
        os.utime(local, (1, 1))                                 # a cloud client touching the file: same bytes
        again = client.call("fs.put", local=local, remote="/lab (1)/däta.bin", expectSha=resp["sha256"])
        self.assertTrue(again["skipped"])
        self.assertEqual(again["sent"], 0)
        with open(local, "ab") as f:
            f.write(b"x")
        changed = client.call("fs.put", local=local, remote="/lab (1)/däta.bin", expectSha=resp["sha256"])
        self.assertFalse(changed["skipped"])
        back = os.path.join(folder, "back.bin")
        got = client.call("fs.get", remote="/lab (1)/däta.bin", local=back)
        self.assertEqual(got["bytes"], len(data) + 1)
        self.assertIn("verified", got)
        with open(back, "rb") as f:
            self.assertEqual(f.read(), data + b"x")

    def test_destructive_op_arguments(self):
        board, client, _ = self.connected("esp32")
        board.write_file("/keep/a.txt", "a")
        client.fail("fs.rmtree", "E_PROTOCOL", path="/keep")
        client.fail("fs.rmtree", "E_PROTOCOL", path="/keep", confirm="yes")
        client.fail("fs.rmtree", "E_PROTOCOL", path="/", confirm=True)
        client.fail("fs.rm", "E_FS_ERRNO", path="/missing.txt")
        client.fail("fs.mkdir", "E_FS_ERRNO", path="/a/b/c", parents=False)
        self.assertTrue(board.exists("/keep/a.txt"))
        self.assertEqual(client.call("fs.rmtree", path="/keep", confirm=True)["removed"], 2)

    def test_mount_refusal_is_not_machine_readable_on_the_wire(self):
        """Appendix B: the rmtree mount refusal 'carries needs_allow_mount and mount_reason so the client can ask again and
        resend with allowMount:true'.  BridgeError.to_dict() serialises only code/message/detail/hint, so on the wire the
        refusal is a bare E_FS_ERRNO/EPERM that cannot be told from any other permission error."""
        board, client, _ = self.connected("stm32")
        board.write_file("/flash/keep/a.txt", "a")
        resp = client.request("fs.rmtree", path="/flash", confirm=True)
        self.assertFalse(resp["ok"], resp)
        err = resp["error"]
        self.assertEqual(err["code"], "E_FS_ERRNO")
        self.assertTrue(board.exists("/flash/keep/a.txt"), "the refusal itself worked")
        self.assertTrue(err.get("needs_allow_mount") is True and err.get("mount_reason") in ("dev", "root", "vfs", "cwd"),
                        "error on the wire has no machine-readable mount marker: %r" % (err,))

    def test_shadow_guard_from_config_refuses_before_touching_the_board(self):
        """Section 3 fs.put + Appendix B shadow guard (config.shadowGuard)."""
        board, client, _ = self.connected("esp32")
        folder = self.local_dir()
        local = self.write_local(folder, "shield.py", "x = 1\n")
        client.call("config", shadowGuard=["shield", "_shield"])
        before = self.user_programs_started(board)
        for remote in ("/shield.py", "/Shield.py", "/shield/__init__.py", "/lib/shield.py", "/_shield.mpy"):
            client.fail("fs.put", "E_SHADOWS_MODULE", local=local, remote=remote)
        client.fail("fs.mkdir", "E_SHADOWS_MODULE", path="/shield")
        board.write_file("/a.py", "1\n")
        client.fail("fs.mv", "E_SHADOWS_MODULE", src="/a.py", dst="/shield.py")
        self.assertEqual(self.user_programs_started(board), before, "the guard must refuse before any exec")
        client.call("fs.put", local=local, remote="/lib/ok.py")
        client.fail("config", "E_PROTOCOL", shadowGuard="shield")
        client.fail("config", "E_PROTOCOL", stopOnDisconnect="yes")
        client.fail("config", "E_PROTOCOL", idleListenMs=-1)

    def test_shadow_guard_learns_the_boards_frozen_modules_from_identity(self):
        """Appendix B + requirements amendment RQ-ID-4: 'The bridge still has to fill the list from ... the profile's frozen
        names and identity.profileHints.modules' so uploads cannot shadow firmware modules on any firmware."""
        board, client, _ = self.connected("custom-frozen")
        ident = client.call("identity")
        frozen = ident["profileHints"]["modules"]
        self.assertTrue(frozen, ident["profileHints"])
        folder = self.local_dir()
        local = self.write_local(folder, "m.py", "x = 1\n")
        name = sorted(frozen)[0]
        client.fail("fs.put", "E_SHADOWS_MODULE", local=local, remote="/%s.py" % name)


class CliModeTests(BridgeTestCase):
    """Section 10."""
    DEADLINE_S = 90

    def test_cli_ping_and_unknown_op(self):
        rc, parsed, err = run_cli("ping")
        self.assertEqual(rc, 0, err)
        self.assertTrue(parsed["ok"])
        rc, parsed, err = run_cli("nonesuch")
        self.assertEqual(rc, 1)
        self.assertEqual(parsed["error"]["code"], "E_UNSUPPORTED")

    def test_cli_against_the_fake_board_with_the_same_code_path_and_no_reset(self):
        board = self.new_board("esp32")
        rc, parsed, err = run_cli("identity", "--port", board.url)
        self.assertEqual(rc, 0, err)
        self.assertTrue(parsed["ok"])
        self.assertIn("uniqueId", parsed)
        rc, parsed, err = run_cli("exec", "code=print(6*7)", "--port", board.url)
        self.assertEqual(rc, 0, err)
        self.assertIn("42", parsed["out"])
        rc, parsed, err = run_cli("fs.mkdir", "path=/a/b", "parents=false", "--port", board.url)
        self.assertEqual(rc, 1)
        self.assertEqual(parsed["error"]["code"], "E_FS_ERRNO")
        rc, parsed, err = run_cli("stop", "timeoutMs=300", "--port", board.url)
        self.assertEqual(rc, 0, err)
        self.assertTrue(parsed["stopped"])
        self.assertEqual(board.events.count("soft_reset"), 0)
        self.assertEqual(board.events.count("hard_reset"), 0)
        wait_until(lambda: board.connected == 0, 5, "the CLI to release the board")

    def test_cli_honours_safe_mode_and_reset_confirmation(self):
        rc, parsed, err = run_cli("identity", "--port", LOCAL_NEVER_A_DEVICE)
        self.assertEqual(rc, 1)
        self.assertEqual(parsed["error"]["code"], "E_SAFE_MODE")
        board = self.new_board("esp32")
        rc, parsed, err = run_cli("reset.hard", "--port", board.url)
        self.assertEqual((rc, parsed["error"]["code"]), (1, "E_PROTOCOL"))
        rc, parsed, err = run_cli("reset.hard", "confirmed=true", "--port", board.url)
        self.assertEqual((rc, parsed["error"]["code"]), (1, "E_UNSUPPORTED"))
        self.assertEqual(board.events.count("hard_reset"), 0)

    def _script(self, board, text):
        folder = self.local_dir(course=False)
        script = self.write_local(folder, "s.jsonl", text)
        r = subprocess.run(bridge_argv(["--script", script, "--port", board.url]), stdin=subprocess.DEVNULL,
                           capture_output=True, timeout=30, cwd=folder, env=child_env(), shell=False)
        lines = [json.loads(x) for x in r.stdout.decode("utf-8").splitlines() if x.strip()]
        return r.returncode, lines, r.stderr.decode("utf-8", "replace")

    def test_cli_script_mode_prints_one_json_per_request(self):
        board = self.new_board("esp32")
        rc, lines, err = self._script(board, '# comment\n{"op": "fs.list", "path": "/"}\n\n{"op": "identity"}\n')
        self.assertEqual(rc, 0, err)
        self.assertEqual([x["ok"] for x in lines], [True, True])

    def test_cli_script_with_port_skips_the_connect_when_the_first_line_is_config_or_ping(self):
        """Section 10: `--script file.jsonl [--port P]` runs the script 'with the same code path'.  A script that starts with
        `config` (the natural way to set shadowGuard) or `ping` silently ignores --port, so every later op is E_NOT_CONNECTED."""
        board = self.new_board("esp32")
        rc, lines, err = self._script(board, '{"op": "config", "shadowGuard": ["os"]}\n{"op": "identity"}\n')
        self.assertEqual([x["ok"] for x in lines], [True, True], (lines, err))


class ArchitectureTests(unittest.TestCase):
    def test_only_link_py_opens_serial_ports_and_no_shell_strings(self):
        """R-ARCH-1 / R-ARCH-2 (static): nothing but bridge/link.py constructs a port; no shell, no subprocess in bridge/."""
        import re
        bad_open = re.compile(r"serial\.Serial\(|serial_for_url|os\.open\(|open\(['\"]/dev")
        bad_shell = re.compile(r"shell\s*=\s*True|os\.system|os\.popen|subprocess|\bPopen\b")
        bridge_dir = os.path.join(ROOT, "bridge")
        for name in sorted(os.listdir(bridge_dir)):
            if not name.endswith(".py"):
                continue
            with open(os.path.join(bridge_dir, name), encoding="utf-8") as f:
                text = f.read()
            if name != "link.py":
                self.assertIsNone(bad_open.search(text), name)
            self.assertIsNone(bad_shell.search(text), name)

    def test_started_like_the_extension_with_pycache_prefix_writes_nothing_into_the_tree(self):
        """R-ARCH-3 / section 1: python -I -u -X utf8 -X pycache_prefix=<dir> bridge.py; hello first; exit 0 on stdin EOF."""
        tmp = tempfile.mkdtemp(prefix="review2-pc-")
        self.addCleanup(shutil.rmtree, tmp, True)
        prefix = os.path.join(tmp, "pc")
        argv = [sys.executable, "-I", "-u", "-X", "utf8", "-X", "pycache_prefix=%s" % prefix, BRIDGE_PATH]
        p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=tmp,
                             env=child_env(), shell=False)
        try:
            first = json.loads(p.stdout.readline().decode("utf-8"))
            self.assertEqual(first["ev"], "hello")
            p.stdin.write(b'{"id": 1, "op": "ping"}\n')
            p.stdin.flush()
            self.assertEqual(json.loads(p.stdout.readline().decode("utf-8")), {"id": 1, "ok": True})
            p.stdin.close()
            self.assertEqual(p.wait(15), 0)
            for line in p.stdout.read().decode("utf-8").splitlines():
                self.assertIn("ev", json.loads(line))              # only events may follow the last response
        finally:
            if p.poll() is None:
                p.kill()
                p.wait(10)
            for pipe in (p.stdin, p.stdout, p.stderr):
                try:
                    pipe.close()
                except (OSError, ValueError):
                    pass
        stray = [d for base in ("bridge", "tools", "tests") for d, _, _ in os.walk(os.path.join(ROOT, base))
                 if os.path.basename(d) == "__pycache__"]
        self.assertEqual(stray, [])
        self.assertTrue(os.path.isdir(prefix) and os.listdir(prefix), "pycache_prefix was not honoured")


class DeviceCodeRuleTests(unittest.TestCase):
    def test_every_device_snippet_obeys_section_9(self):
        """Section 9: lint clean; no f-strings, walrus, os.walk; no application package; no hardware access."""
        import ast
        import re
        self.assertEqual({k: v for k, v in devfs.lint_all().items() if v}, {})
        forbidden = re.compile(r"os\.walk|import\s+_?shield|\bPin\(|\bPWM\(|\bADC\(|machine\.reset|machine\.soft_reset")
        for name, template in devfs.SNIPPETS.items():
            dummy = {m.group(1): "0" for m in devfs._TOKEN.finditer(template)}
            text = devfs._TOKEN.sub(lambda m: dummy[m.group(1)], template)
            tree = ast.parse(text)
            for node in ast.walk(tree):
                self.assertNotIsInstance(node, (ast.JoinedStr, ast.NamedExpr), name)
            self.assertIsNone(forbidden.search(text), name)
            self.assertTrue(text.isascii(), name)


if __name__ == "__main__":
    unittest.main()
