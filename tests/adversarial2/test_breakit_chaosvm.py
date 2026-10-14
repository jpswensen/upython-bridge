"""Break-it round 2: the random storm against the REAL MicroPython VM (unix port behind the relay). Every device path is
under vm.root (the VM's '/' is the host disk)."""
from __future__ import annotations

import os
import random
import threading
import time
import unittest

from tests.bridge_client import BridgeTestCase, BridgeTimeout, b64
from tests.support import wait_until
from tools.mpunix_relay import UnixVM

LOOP = "import time\nprint('go')\nwhile True:\n    print('tick')\n    time.sleep(0.01)\n"
OPS = ("ping", "fs.list", "fs.stat", "fs.put", "fs.get", "fs.mkdir", "fs.rm", "run", "run", "stop", "stop", "cancel", "tty.write",
       "repl.attach", "repl.detach", "connect", "exec", "identity", "fs.manifest")


@unittest.skipIf(UnixVM.skip_reason(), UnixVM.skip_reason() or "")
class ChaosVm(BridgeTestCase):
    DEADLINE_S = 240

    def test_random_storm_on_the_real_vm(self):
        vm = UnixVM()
        vm.start()
        self.addCleanup(vm.stop)
        c = self.new_bridge()
        c.call("connect", port=vm.url)
        base = vm.root.replace(os.sep, "/")
        folder = self.local_dir()
        small = self.write_local(folder, "s.txt", b"hello\n" * 100)
        seed = int(os.environ.get("CHAOS_SEED", "7"))
        rnd = random.Random(seed)
        sent, lock = [], threading.Lock()
        stop_at = time.monotonic() + 8.0

        def request(r):
            op = r.choice(OPS)
            args = {"fs.list": {"path": base}, "fs.stat": {"path": base + "/s0.txt"},
                    "fs.put": {"local": small, "remote": base + "/s%d.txt" % r.randint(0, 3), "background": r.random() < 0.5},
                    "fs.get": {"remote": base + "/s0.txt", "local": os.path.join(folder, "g%d.txt" % r.randint(0, 3))},
                    "fs.mkdir": {"path": base + "/d%d" % r.randint(0, 3)}, "fs.rm": {"path": base + "/s%d.txt" % r.randint(0, 3)},
                    "run": {"source": r.choice(["print(1)", LOOP, "import time\ntime.sleep(0.2)\nprint(2)"])},
                    "stop": {"timeoutMs": 500}, "cancel": {"target": r.randint(1, 200)},
                    "tty.write": {"b64": b64(r.choice([b"a", b"\r", b"\x03", b"x" * 50]))}, "connect": {"port": vm.url},
                    "exec": {"code": "print(1)"}, "fs.manifest": {"root": base}}.get(op, {})
            if op in ("fs.list", "fs.stat", "fs.put", "fs.get", "fs.mkdir", "fs.rm", "exec", "identity", "fs.manifest") and r.random() < 0.3:
                args["interrupt"] = True
            return op, args

        def worker(s):
            r = random.Random(s)
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
        for _ in range(3):
            c.send("stop", timeoutMs=500)
        for rid in [rid for rid, _ in sent if not c.has_result(rid)]:
            c.send("cancel", target=rid)
        unanswered = []
        for rid, op in sent:
            try:
                c.result(rid, 60)
            except BridgeTimeout:
                unanswered.append((rid, op))
        self.assertEqual(unanswered, [], "requests never answered after stop+cancel")
        internal = [(op, c.responses[rid]["error"]["detail"][-400:]) for rid, op in sent
                    if rid in c.responses and not c.responses[rid]["ok"] and c.responses[rid]["error"]["code"] == "E_INTERNAL"]
        self.assertEqual(internal, [], "E_INTERNAL = bridge bug")
        c.assert_clean_stdout()
        self.assertTrue(c.alive)
        first = c.request("fs.list", path=base, interrupt=True, _timeout=30)
        self.assertTrue(first["ok"], first)
        stray = [n for n in os.listdir("/") if n.startswith(("s0.txt", "d0", "d1", "d2", "d3"))]
        self.assertEqual(stray, [], "the storm wrote to the host root")


if __name__ == "__main__":
    unittest.main()
