"""Break-it tests: concurrency, floods and big transfers against the fake board (socket://127.0.0.1 only).

    export MPY_SAFE_MODE=1
    python3 -B -m unittest tests.adversarial.test_load -v
    ADVERSARIAL_SLOW=1 python3 -B -m unittest tests.adversarial.test_load -v     # adds the 10 MB round trip (~60 s)
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tests.adversarial._harness import BridgeError, Rig, devfs  # noqa: E402
from tools.fakeboard import derive_profile  # noqa: E402


class ConcurrencyTests(unittest.TestCase):
    def test_eight_threads_put_get_with_a_bypass_writer_hammering(self):
        d = tempfile.mkdtemp()
        errs = []
        with Rig(capture=True) as r:
            r.connect()
            r.link.attach_repl(lambda b: None)

            def worker(k):
                try:
                    src = os.path.join(d, "w%d.bin" % k)
                    with open(src, "wb") as f:
                        f.write(os.urandom(4000 + k * 1013))
                    for _ in range(4):
                        r.fs(devfs.put_file, src, "/w%d.bin" % k)
                        dst = os.path.join(d, "g%d.bin" % k)
                        r.fs(devfs.get_file, "/w%d.bin" % k, dst)
                        with open(src, "rb") as a, open(dst, "rb") as b:
                            if a.read() != b.read():
                                errs.append((k, "content mismatch"))
                except BaseException as exc:  # noqa: BLE001
                    errs.append((k, repr(exc)[:200]))

            stop = threading.Event()

            def hammer():
                while not stop.is_set():
                    try:
                        r.link.write(b"")  # the tty.write bypass path, zero bytes: must never disturb an op
                    except BridgeError as exc:
                        errs.append(("hammer", exc.code))
                        return
                    time.sleep(0.003)

            ths = [threading.Thread(target=worker, args=(k,)) for k in range(8)]
            h = threading.Thread(target=hammer)
            h.start()
            for t in ths:
                t.start()
            for t in ths:
                t.join(120)
            stop.set()
            h.join(5)
            self.assertEqual(errs, [])
            self.assertFalse([t for t in ths if t.is_alive()])
            self.assertEqual(r.board.events.count("soft_reset"), 0)

    def test_500_small_requests_in_one_session_and_the_pump_stays_quiet(self):
        with Rig() as r:
            r.connect()
            seen = []
            r.link.attach_repl(seen.append)
            t0 = time.monotonic()
            with r.link.session():
                r.link.enter_raw()
                for _ in range(500):
                    self.assertTrue(devfs.stat(r.link.exec, "/boot.py")["exists"])
                r.link.exit_raw()
            self.assertLess(time.monotonic() - t0, 30)
            # nothing but the prompt redraw may have been forwarded as REPL bytes while ops ran
            blob = b"".join(seen)
            self.assertNotIn(b"@@", blob)
            self.assertNotIn(b"raw REPL", blob.replace(b"\r\n>>> ", b""))

    def test_run_and_file_op_serialise_and_stop_ends_the_run(self):
        with Rig() as r:
            r.connect()
            link = r.link
            started = threading.Event()
            res = {}

            def runner():
                with link.session():
                    link.enter_raw(soft_reset=True)
                    started.set()
                    res["err"] = link.exec_stream("import time\nwhile True:\n    time.sleep(0.05)\n    print('t')\n", lambda b: None)
                    link.exit_raw()

            th = threading.Thread(target=runner)
            th.start()
            self.assertTrue(started.wait(10))
            t_file = {}

            def fileop():
                t0 = time.monotonic()
                t_file["r"] = r.fs(devfs.stat, "/boot.py")
                t_file["dt"] = time.monotonic() - t0

            th2 = threading.Thread(target=fileop)
            th2.start()
            time.sleep(0.5)
            self.assertTrue(th2.is_alive(), "the file op must wait for the run, not interleave with it")
            self.assertTrue(link.interrupt(timeout=3))
            th.join(10)
            th2.join(10)
            self.assertIn(b"KeyboardInterrupt", res["err"])
            self.assertTrue(t_file["r"]["exists"])
            self.assertEqual(r.board.events.count("soft_reset"), 1)  # the run's own explicit soft reset only

    def test_run_prints_5_mb_without_buffering_it(self):
        with Rig() as r:
            r.connect()
            n = [0]
            with r.link.session():
                r.link.enter_raw(soft_reset=True)
                err = r.link.exec_stream("s = 'x' * 99 + '\\n'\nfor i in range(52429):\n    print(s, end='')\n",
                                         lambda b: n.__setitem__(0, n[0] + len(b)))
                r.link.exit_raw()
            self.assertEqual(err, b"")
            self.assertEqual(n[0], 52429 * 101)  # 100 chars + CRLF on a board
            self.assertEqual(r.link.mode, "friendly")

    def test_syntax_error_run_reports_on_stderr_and_returns_to_the_prompt(self):
        with Rig() as r:
            r.connect()
            with r.link.session():
                r.link.enter_raw(soft_reset=True)
                out = []
                err = r.link.exec_stream("def (:\n", out.append)
                self.assertTrue(r.link.exit_raw())
            self.assertIn(b"SyntaxError", err)
            self.assertEqual(b"".join(out), b"")


@unittest.skipUnless(os.environ.get("ADVERSARIAL_SLOW") == "1", "set ADVERSARIAL_SLOW=1 for the 10 MB round trip")
class BigTransferTests(unittest.TestCase):
    def test_10_mb_put_get_round_trip(self):
        d = tempfile.mkdtemp()
        data = os.urandom(10_000_000)
        src = os.path.join(d, "big.bin")
        with open(src, "wb") as f:
            f.write(data)
        with Rig(profile=derive_profile("esp32", "bigflash", fs_blocks=8192)) as r:
            r.connect()
            res = r.fs(devfs.put_file, src, "/big.bin")
            self.assertEqual(res["sha256"], hashlib.sha256(data).hexdigest())
            dst = os.path.join(d, "back.bin")
            r.fs(devfs.get_file, "/big.bin", dst)
            with open(dst, "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), res["sha256"])
            self.assertTrue(r.fs(devfs.put_file, src, "/big.bin", expect_sha=res["sha256"])["skipped"])


if __name__ == "__main__":
    unittest.main()
