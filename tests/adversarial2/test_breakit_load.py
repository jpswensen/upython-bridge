"""Break-it round 2, load and op interplay: floods, concurrent callers, big output, cancel/stop storms, coalescing,
reset-safety of rejected requests. Real bridge process + fake board / the unix VM relay. No serial ports."""
from __future__ import annotations

import base64
import os
import threading
import time
import unittest

from tests.bridge_client import BridgeCallError, BridgeTestCase, b64
from tests.support import wait_until
from tools.mpunix_relay import UnixVM

LOOP = "import time\nprint('go')\nwhile True:\n    time.sleep(0.02)\n"
SLOW = ["slow:230400"]


def kinds(board):
    return [(e["ev"], e.get("reason")) for e in board.events if e["ev"] in ("soft_reset", "hard_reset", "interrupt")]


class Flood(BridgeTestCase):
    DEADLINE_S = 150

    def test_500_small_requests_all_answered(self):
        board, c, _ = self.connected()
        ids = []
        for i in range(500):
            op = ("ping", "fs.stat", "fs.list", "config", "cancel", "repl.detach")[i % 6]
            args = {"fs.stat": {"path": "/"}, "fs.list": {"path": "/"}, "cancel": {"target": 10 ** 9 + i}}.get(op, {})
            ids.append(c.send(op, **args))
        for rid in ids:
            self.assertIn("ok", c.result(rid, 60))
        self.assertTrue(c.alive)
        c.assert_clean_stdout()
        self.assertNoReset(board)

    def test_threads_hammer_mixed_ops(self):
        board, c, _ = self.connected()
        errors, results = [], []

        def worker(n):
            try:
                for i in range(40):
                    op = ("fs.stat", "ping", "fs.list", "tty.write", "cancel", "identity")[(i + n) % 6]
                    args = {"fs.stat": {"path": "/"}, "fs.list": {"path": "/"}, "tty.write": {"b64": b64(b"")},
                            "cancel": {"target": 5000 + i}}.get(op, {})
                    r = c.request(op, _timeout=60, **args)
                    results.append((op, r))
            except BaseException as exc:      # noqa: BLE001 - collected for the assertion
                errors.append(repr(exc))
        ts = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(100)
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 320)
        bad = [(op, r) for op, r in results if not r["ok"]]
        self.assertEqual(bad, [], "no op in this mix may fail")
        c.assert_clean_stdout()
        self.assertNoReset(board)


class RunBehaviour(BridgeTestCase):
    def test_syntax_error_with_and_without_compile(self):
        for faults in ((), ("no_compile",)):
            board, c, _ = self.connected(faults=faults)
            m = c.mark()
            r = c.call("run", source="def f(:\n    pass\n", name="/work/bad.py", _timeout=30)
            self.assertEqual(r["exit"], "exception", (faults, r))
            self.assertIn(b"SyntaxError", c.err_bytes(m), faults)
            self.assertEqual(c.call("run", source="print(7)")["exit"], "ok")
            self.assertEqual(c.state if hasattr(c, "state") else None, None)
            c.call("fs.list", path="/")
            self.assertEqual(board.events.count("soft_reset"), 2, kinds(board))   # one per run, nothing else
            c.close()

    def test_5mb_output_arrives_complete_and_before_the_response(self):
        board, c, _ = self.connected()
        src = "line = 'x' * 2559\nfor i in range(2000):\n    print(line)\nprint('DONE')\n"
        m = c.mark()
        rid = c.send("run", source=src, name="big.py")
        resp = c.result(rid, 120)
        self.assertTrue(resp["ok"], resp)
        out = c.out_bytes(m)
        self.assertEqual(len(out), 2000 * (2559 + 2) + len(b"DONE\r\n"), "output bytes lost or duplicated")
        self.assertTrue(out.endswith(b"DONE\r\n"))
        last_out = max(e["_n"] for e in c.events_of("out", m))
        self.assertLess(last_out, resp["_n"], "an out event arrived after the run response")
        c.assert_clean_stdout()

    def test_run_then_file_ops_and_interrupt_consent(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        c.fail("fs.list", "E_PROGRAM_RUNNING", path="/")
        c.fail("fs.put", "E_PROGRAM_RUNNING", local=__file__, remote="/x.py", background=True)
        c.fail("identity", "E_PROGRAM_RUNNING")
        self.assertTrue(c.request("tty.write", b64=b64(b"abc\n"))["ok"])
        r = c.request("fs.list", path="/", interrupt=True, _timeout=30)
        self.assertTrue(r["ok"], r)
        self.assertEqual(c.result(rid, 30)["exit"], "interrupted")
        self.assertEqual(board.events.count("soft_reset"), 1, kinds(board))
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_repl_attach_and_detach_during_a_run_answer_promptly(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        t0 = time.monotonic()
        a = c.send("repl.attach")
        d = c.send("repl.detach")
        got = {}
        for name, i in (("attach", a), ("detach", d)):
            try:
                got[name] = c.result(i, 3)
            except AssertionError:
                got[name] = None
        waited = time.monotonic() - t0
        c.call("stop", _timeout=15)
        c.result(rid, 15)
        self.assertTrue(got["attach"] is not None and got["detach"] is not None,
                        "repl.attach / repl.detach were not answered within 3 s while a program runs (blocked behind the run in the queue): %r after %.1f s" % (got, waited))

    def test_rejected_run_does_not_reset_the_board(self):
        for faults, src in (("no_compile", "print(1)\n# \x04 control\n"), ("no_compile", "print(1)\n# \x03 control\n")):
            board, c, _ = self.connected(faults=(faults,))
            resp = c.request("run", source=src, name="x.py", _timeout=30)
            self.assertFalse(resp["ok"], resp)
            self.assertEqual(resp["error"]["code"], "E_PROTOCOL")
            self.assertEqual(board.events.count("soft_reset"), 0,
                             "a run that was rejected as invalid still soft-reset the board first: %r" % kinds(board))
            c.close()

    def test_run_of_missing_local_file_does_not_reset(self):
        board, c, _ = self.connected()
        c.fail("run", "E_LOCAL_IO", local=os.path.join(self.local_dir(), "nope.py"))
        c.fail("run", ("E_LOCAL_IO", "E_PROTOCOL"), local="/")
        self.assertNoReset(board)

    def test_reset_false_run_never_resets(self):
        board, c, _ = self.connected()
        self.assertEqual(c.call("run", source="print(1)", reset=False)["exit"], "ok")
        self.assertNoReset(board)

    def test_odd_tty_write_payloads(self):
        board, c, _ = self.connected()
        self.assertTrue(c.request("tty.write", b64="")["ok"])
        for bad in ("@@@@", "AAA", "AA", "A", "AA==AA==", "AA ==", "é", "AA==\n"):
            r = c.request("tty.write", b64=bad)
            self.assertFalse(r["ok"], bad)
            self.assertEqual(r["error"]["code"], "E_PROTOCOL", bad)
        big = c.request("tty.write", b64=b64(b"a" * (2 * 1024 * 1024)), _timeout=60)
        self.assertTrue(big["ok"], big)
        c.ping()
        c.assert_clean_stdout()
        self.assertNoReset(board)


class StopCancel(BridgeTestCase):
    def test_stop_storm_during_run_and_idle(self):
        """10 overlapping Stops while a run streams: the run must still end (fake board: wedges 8 of 8; the unix VM does not)."""
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        ids = [c.send("stop", timeoutMs=2000) for _ in range(10)]
        for i in ids:
            self.assertTrue(c.result(i, 30)["ok"])
        self.assertEqual(c.result(rid, 10)["exit"], "interrupted")
        ids = [c.send("stop", timeoutMs=2000) for _ in range(100)]
        for i in ids:
            self.assertTrue(c.result(i, 30)["ok"])
        self.list_root_after_drop(c)
        self.assertEqual(board.events.count("soft_reset"), 1, kinds(board))
        self.assertEqual(board.events.count("hard_reset"), 0)
        c.assert_clean_stdout()

    def test_stop_during_upload_gives_the_board_back(self):
        board, c, _ = self.connected(faults=SLOW)
        path = self.write_local(self.local_dir(), "big.bin", os.urandom(150 * 1024))
        rid = c.send("fs.put", local=path, remote="/big.bin")
        c.wait_event("progress", lambda e: e["id"] == rid and e["done"] > 0, 20)
        c.call("stop", _timeout=15)
        resp = c.result(rid, 30)
        self.assertFalse(resp["ok"], "an upload that was stopped cannot succeed")
        self.assertEqual(resp["error"]["code"], "E_CANCELLED", resp)
        c.call("fs.list", path="/")
        self.assertEqual(board.mode, "friendly")
        self.assertEqual([n for n in os.listdir(board.root) if n.endswith(".mpytmp")], [])
        self.assertNoReset(board)

    def test_cancel_variants(self):
        board, c, _ = self.connected(faults=SLOW)
        path = self.write_local(self.local_dir(), "big.bin", os.urandom(150 * 1024))
        put = c.send("fs.put", local=path, remote="/big.bin")
        c.wait_event("progress", lambda e: e["id"] == put and e["done"] > 0, 20)
        queued = c.send("fs.stat", path="/")
        me = c.send("cancel", target=0)
        self.assertEqual(c.result(me, 10), c.responses[me])
        self.assertTrue(c.call("cancel", target=queued)["cancelled"])
        self.assertEqual(c.result(queued, 10)["error"]["code"], "E_CANCELLED")
        self.assertFalse(c.call("cancel", target=str(put))["cancelled"], "ids are compared by type: '%s' is not %d" % (put, put))
        self.assertTrue(c.call("cancel", target=put)["cancelled"])
        resp = c.result(put, 30)
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["code"], "E_CANCELLED")
        self.assertFalse(c.call("cancel", target=put)["cancelled"], "cancel of a finished op")
        c.fail("cancel", "E_PROTOCOL", target=None)
        c.fail("cancel", "E_PROTOCOL", target=True)
        c.call("fs.list", path="/")
        self.assertEqual(board.mode, "friendly")
        self.assertEqual([n for n in os.listdir(board.root) if n.endswith(".mpytmp")], [])
        self.assertNoReset(board)

    def test_cancel_a_running_run_leaves_a_stoppable_program(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP)
        self.assertTrue(c.call("cancel", target=rid)["cancelled"])
        resp = c.result(rid, 15)
        self.assertFalse(resp["ok"], resp)
        self.assertEqual(resp["error"]["code"], "E_CANCELLED")
        self.assertTrue(board.program_running, "cancel stops following; it must not end the program (use stop)")
        self.assertTrue(c.call("stop", _timeout=15)["stopped"])
        board.wait_idle(5)
        self.list_root_after_drop(c)
        self.assertEqual(board.events.count("soft_reset"), 1, kinds(board))
        c.assert_clean_stdout()

    def test_background_put_storm_coalesces_and_foreground_goes_first(self):
        board, c, _ = self.connected()
        folder = self.local_dir()
        files = [self.write_local(folder, "v%d.txt" % i, ("version %d\n" % i) * 20) for i in range(60)]
        blocker = c.send("exec", code="import time\ntime.sleep(1.5)\nprint('unblocked')\n", timeoutMs=30000)
        wait_until(lambda: board.program_running, 10, "blocker to start")
        bg = [c.send("fs.put", local=files[i], remote="/same.txt", background=True) for i in range(60)]
        other = [c.send("fs.put", local=files[i], remote="/other%d.txt" % i, background=True) for i in range(10)]
        fg = c.send("fs.stat", path="/")
        c.result(blocker, 30)
        results = [c.result(i, 60) for i in bg]
        ok = [r for r in results if r["ok"]]
        self.assertEqual(len(ok), 1, "exactly the newest background write of one file must survive: %d did" % len(ok))
        self.assertIs(results[-1]["ok"], True)
        self.assertTrue(all(r["error"]["code"] == "E_CANCELLED" for r in results if not r["ok"]))
        for i in other:
            self.assertTrue(c.result(i, 60)["ok"])
        self.assertTrue(c.result(fg, 10)["ok"])
        self.assertLess(c.responses[fg]["_n"], min(c.responses[i]["_n"] for i in other), "foreground op must run before background work")
        self.assertEqual(board.read_file("/same.txt"), ("version 59\n" * 0 + "version 59\n" * 20).encode())
        self.assertNoReset(board)
        c.assert_clean_stdout()


@unittest.skipIf(UnixVM.skip_reason(), UnixVM.skip_reason() or "")
class RealVm(BridgeTestCase):
    def vm(self):
        vm = UnixVM()
        vm.start()
        self.addCleanup(vm.stop)
        return vm

    def test_vm_big_output_syntax_error_stop_storm(self):
        vm = self.vm()
        c = self.new_bridge()
        c.call("connect", port=vm.url)
        m = c.mark()
        r = c.call("run", source="def f(:\n", name="/w/bad.py", _timeout=30)
        self.assertEqual(r["exit"], "exception")
        self.assertIn(b"SyntaxError", c.err_bytes(m))
        m = c.mark()
        r = c.call("run", source="s = 'y' * 1000\nfor i in range(2000):\n    print(s)\n", name="big.py", _timeout=120)
        self.assertEqual(r["exit"], "ok")
        self.assertEqual(len(c.out_bytes(m)), 2000 * 1002 + 2)   # +2: the CRLF the VM prints at its soft reset
        rid = self.start_program(c, LOOP.replace("time.sleep(0.02)", "time.sleep_ms(20)"), "loop.py")
        ids = [c.send("stop", timeoutMs=3000) for _ in range(30)]
        for i in ids:
            self.assertTrue(c.result(i, 30)["ok"])
        self.assertEqual(c.result(rid, 30)["exit"], "interrupted")
        self.assertEqual(c.call("run", source="print(40 + 2)")["exit"], "ok")
        c.assert_clean_stdout()

    def test_vm_hostile_paths_do_not_touch_the_host(self):
        vm = self.vm()
        c = self.new_bridge()
        c.call("connect", port=vm.url)
        for path in ("/etc", "/", "//", "/tmp/..", "/a/../etc"):
            r = c.request("fs.rmtree", path=path, confirm=True)
            self.assertFalse(r["ok"], path)
        self.assertTrue(os.path.isdir("/etc"))
        c.assert_clean_stdout()


if __name__ == "__main__":
    unittest.main()
