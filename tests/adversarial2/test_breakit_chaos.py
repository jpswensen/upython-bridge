"""Break-it round 2: randomised multi-thread chaos against one bridge + fake board, reset-op guards, closed-stdout parent."""
from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import threading
import time
import unittest

from tests.bridge_client import BRIDGE_PATH, BridgeTestCase, BridgeTimeout, b64
from tests.support import child_env, wait_until

LOOP = "import time\nprint('go')\nwhile True:\n    print('tick')\n    time.sleep(0.01)\n"


class ResetOps(BridgeTestCase):
    def test_reset_hard_needs_exactly_true(self):
        board, c, _ = self.connected()
        for bad in (None, 1, "true", "yes", [], {}, 0, False):
            r = c.request("reset.hard", confirmed=bad) if bad is not None else c.request("reset.hard")
            self.assertFalse(r["ok"], bad)
            self.assertEqual(r["error"]["code"], "E_PROTOCOL", (bad, r))
        self.assertNoReset(board)
        c.ping()

    def test_reset_hard_on_a_socket_port_is_refused_without_side_effects(self):
        board, c, _ = self.connected()
        r = c.request("reset.hard", confirmed=True, _timeout=20)
        self.assertFalse(r["ok"], r)
        self.assertEqual(r["error"]["code"], "E_UNSUPPORTED", r)
        self.assertNoReset(board)
        c.call("fs.list", path="/")

    def test_no_reserved_op_reachable_from_a_client(self):
        board, c, _ = self.connected()
        for op in ("_clean_orphans", "__init__", "op_reset_hard", "op_reset_machine", "machine.reset"):      # reset.capability / reset.machine are real client ops since R1.5 (confirmation-gated)
            r = c.request(op)
            self.assertFalse(r["ok"], op)
            self.assertEqual(r["error"]["code"], "E_UNSUPPORTED", (op, r))
        self.assertNoReset(board)


class Flood2(BridgeTestCase):
    DEADLINE_S = 120

    def test_ports_list_flood_does_not_starve_ping(self):
        c = self.new_bridge()
        ids = [c.send("ports.list") for _ in range(300)]
        t0 = time.monotonic()
        c.ping(timeout=30)
        ping_s = time.monotonic() - t0
        for i in ids:
            self.assertTrue(c.result(i, 90)["ok"])
        self.assertLess(ping_s, 10.0, "ping took %.1f s behind a 300 x ports.list flood" % ping_s)
        c.assert_clean_stdout()


class ParentGone(BridgeTestCase):
    def test_stdout_pipe_closed_while_a_program_runs_stops_the_program(self):
        board = self.new_board()
        proc = subprocess.Popen([sys.executable, "-I", "-B", "-u", "-X", "utf8", BRIDGE_PATH], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=child_env(), shell=False)
        self.addCleanup(proc.kill)
        self.addWatchdogCleanup(proc.kill)

        def send(msg):
            proc.stdin.write((json.dumps(msg) + "\n").encode()); proc.stdin.flush()
        json.loads(proc.stdout.readline())                                    # hello
        send({"id": 1, "op": "connect", "port": board.url})
        while json.loads(proc.stdout.readline()).get("id") != 1:
            pass
        send({"id": 2, "op": "run", "source": LOOP, "name": "loop.py"})
        wait_until(lambda: board.program_running, 10, "program to start")
        proc.stdout.close()                                                   # the reader of our stdout is gone; stdin stays open
        try:
            rc = proc.wait(20)
        except subprocess.TimeoutExpired:
            self.fail("bridge keeps running (stdin still open) although nobody reads its stdout")
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass
        self.assertEqual(rc, 0)
        self.assertTrue(board.wait_idle(5), "the program was left running when the output channel died (RQ-SAFE-4)")
        self.assertEqual(board.events.count("hard_reset"), 0)


class Chaos(BridgeTestCase):
    DEADLINE_S = 200
    OPS = ("ping", "fs.list", "fs.stat", "fs.put", "fs.get", "fs.mkdir", "fs.rm", "run", "run", "stop", "stop", "cancel", "tty.write",
           "repl.attach", "repl.detach", "disconnect", "connect", "exec", "identity", "config", "fs.manifest")

    def test_random_storm_no_deadlock_no_internal_error_no_stray_reset(self):
        board, c, _ = self.connected()
        folder = self.local_dir()
        small = self.write_local(folder, "s.txt", b"hello\n" * 100)
        rnd = random.Random(int(os.environ.get("CHAOS_SEED", "20261012")))
        sent, lock = [], threading.Lock()
        stop_at = time.monotonic() + 8.0
        counts = {"run": 0}

        def request(rnd):
            op = rnd.choice(self.OPS)
            args = {"fs.list": {"path": "/"}, "fs.stat": {"path": "/s.txt"}, "fs.put": {"local": small, "remote": "/s%d.txt" % rnd.randint(0, 3), "background": rnd.random() < 0.5},
                    "fs.get": {"remote": "/s0.txt", "local": os.path.join(folder, "g%d.txt" % rnd.randint(0, 3))}, "fs.mkdir": {"path": "/d%d" % rnd.randint(0, 3)},
                    "fs.rm": {"path": "/s%d.txt" % rnd.randint(0, 3)}, "run": {"source": rnd.choice(["print(1)", LOOP, "import time\ntime.sleep(0.2)\nprint(2)"])},
                    "stop": {"timeoutMs": 500}, "cancel": {"target": rnd.randint(1, 200)}, "tty.write": {"b64": b64(rnd.choice([b"a", b"\r", b"\x03", b"x" * 50]))},
                    "connect": {"port": board.url}, "exec": {"code": "print(1)"}, "config": {"idleListenMs": 100},
                    "fs.manifest": {"root": "/"}}.get(op, {})
            if op in ("fs.list", "fs.stat", "fs.put", "fs.get", "fs.mkdir", "fs.rm", "exec", "identity", "fs.manifest") and rnd.random() < 0.3:
                args["interrupt"] = True
            if op == "run":
                counts["run"] += 1
            return op, args

        def worker(seed):
            r = random.Random(seed)
            while time.monotonic() < stop_at:
                with lock:
                    op, args = request(r)
                rid = c.send(op, **args)
                with lock:
                    sent.append((rid, op))
                if r.random() < 0.3:
                    time.sleep(r.random() * 0.02)
        ts = [threading.Thread(target=worker, args=(rnd.random(),)) for _ in range(6)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(30)
        # drain: a program may still run; stop it, cancel everything that is still pending
        for _ in range(3):
            c.send("stop", timeoutMs=500)
        pending = [rid for rid, _ in sent if not c.has_result(rid)]
        for rid in pending:
            c.send("cancel", target=rid)
        unanswered = []
        for rid, op in sent:
            try:
                c.result(rid, 60)
            except BridgeTimeout:
                unanswered.append((rid, op))
        self.assertEqual(unanswered, [], "requests that were never answered (deadlock or lost) after stop+cancel")
        internal = [(op, c.responses[rid]["error"]["detail"][-400:]) for rid, op in sent
                    if rid in c.responses and not c.responses[rid]["ok"] and c.responses[rid]["error"]["code"] == "E_INTERNAL"]
        self.assertEqual(internal, [], "E_INTERNAL = bridge bug")
        c.assert_clean_stdout()
        self.assertTrue(c.alive)
        self.assertEqual(board.events.count("hard_reset"), 0)
        runs_started = len([1 for rid, op in sent if op == "run" and rid in c.responses and (c.responses[rid]["ok"] or c.responses[rid]["error"]["code"] in ("E_CANCELLED", "E_BOARD_UNRESPONSIVE"))])
        self.assertLessEqual(board.events.count("soft_reset"), runs_started + 1,
                             "more soft resets (%d) than runs the client asked for (%d)" % (board.events.count("soft_reset"), runs_started))
        # the bridge must be usable afterwards
        for op in ("disconnect", "connect"):
            r = c.request(op, **({"port": board.url} if op == "connect" else {}), _timeout=30)
            if op == "connect" and not r["ok"]:
                wait_until(lambda: board.connected == 0, 5, "board to release")
                r = c.request("connect", port=board.url, _timeout=30)
            self.assertTrue(r["ok"], (op, r))
        first = c.request("fs.list", path="/", interrupt=True, _timeout=30)
        self.assertTrue(first["ok"], first)


if __name__ == "__main__":
    unittest.main()
