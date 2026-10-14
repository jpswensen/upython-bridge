"""Break-it tests: cancel and Stop (Ctrl-C x2) in the middle of file operations.

Fake board over socket://127.0.0.1 only. ``test_*`` pin defects found by the review.

    export MPY_SAFE_MODE=1
    python3 -B -m unittest tests.adversarial.test_stop_cancel -v
"""
from __future__ import annotations

import os
import random
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tests.adversarial._harness import BridgeError, Rig, devfs  # noqa: E402

OLD = b"OLD CONTENT"


def tmp_files(board):
    out = []
    for dp, _dn, fns in os.walk(board.root):
        out += [os.path.join(dp, f) for f in fns if f.endswith(".mpytmp")]
    return out


class CancelAtEveryPointTests(unittest.TestCase):
    def test_put_cancelled_after_n_progress_calls_leaves_old_file_and_no_temp(self):
        d = tempfile.mkdtemp()
        src = os.path.join(d, "f.bin")
        data = os.urandom(10000)
        with open(src, "wb") as f:
            f.write(data)
        with Rig() as r:
            r.connect()
            for n in range(0, 14):
                r.board.write_file("/keep.bin", OLD)
                ev = threading.Event()
                calls = [0]

                def prog(done, total, label):
                    calls[0] += 1
                    if calls[0] > n:
                        ev.set()

                try:
                    r.fs(devfs.put_file, src, "/keep.bin", chunk=1024, progress=prog, cancel=ev)
                    res = "done"
                except BridgeError as exc:
                    res = exc.code
                with self.subTest(n=n, result=res):
                    self.assertIn(res, ("done", "E_CANCELLED"))
                    self.assertEqual(r.board.read_file("/keep.bin"), data if res == "done" else OLD)
                    self.assertEqual(tmp_files(r.board), [])
            self.assertEqual(r.board.events.count("soft_reset"), 0)

    def test_get_cancelled_at_every_chunk_leaves_no_local_temp(self):
        d = tempfile.mkdtemp()
        data = os.urandom(10000)
        with Rig() as r:
            r.connect()
            r.board.write_file("/big.bin", data)
            out = os.path.join(d, "out.bin")
            for n in range(0, 6):
                ev = threading.Event()
                calls = [0]

                def prog(done, total, label):
                    calls[0] += 1
                    if calls[0] > n:
                        ev.set()

                with self.assertRaises(BridgeError) as cm:
                    r.fs(devfs.get_file, "/big.bin", out, chunk=1024, progress=prog, cancel=ev)
                self.assertEqual(cm.exception.code, "E_CANCELLED")
                self.assertEqual(os.listdir(d), [])


class StopDuringUploadTests(unittest.TestCase):
    def test_stop_during_upload_returns_promptly_and_leaves_no_temp_file(self):
        """link.interrupt() sends Ctrl-C twice 50 ms apart. The first interrupts the running chunk snippet, devfs
        then runs its cleanup (put_abort) - and the SECOND Ctrl-C lands inside that cleanup's raw-paste upload
        (the board aborts the paste). Result: put_file blocks ~10 s (the exec stage timeout, op lock held so
        every queued op is stuck behind it), swallows the failure, and leaves '<name>.mpytmp' on the board.
        Expected: the cancelled put returns in < 3 s and no .mpytmp remains, on every attempt."""
        d = tempfile.mkdtemp()
        src = os.path.join(d, "f.bin")
        with open(src, "wb") as f:
            f.write(os.urandom(20000))
        rng = random.Random(3)
        with Rig(faults=["slow:230400"]) as r:  # slow UART: chunk snippets are in flight for ~60 ms each
            r.connect()
            bad = []
            for attempt in range(6):
                delay = 0.25 + rng.random() * 0.5
                r.board.write_file("/keep.bin", OLD)
                res = {}

                def work():
                    t0 = time.monotonic()
                    try:
                        r.fs(devfs.put_file, src, "/keep.bin", chunk=1024)
                        res["r"] = "ok"
                    except BridgeError as exc:
                        res["r"] = exc.code
                    res["t"] = time.monotonic() - t0

                th = threading.Thread(target=work)
                th.start()
                time.sleep(delay)
                r.link.interrupt(timeout=3)
                th.join(60)
                time.sleep(0.2)
                after_stop = res["t"] - delay
                leftovers = tmp_files(r.board)
                for t in leftovers:
                    os.remove(t)
                if res["r"] != "ok" and (after_stop > 3.0 or leftovers):
                    bad.append((attempt, round(delay, 2), res["r"], round(after_stop, 1), len(leftovers)))
                self.assertIn(r.board.read_file("/keep.bin"), (OLD, open(src, "rb").read()))
            self.assertEqual(bad, [], "stop stalled the file op and/or left temp files: %r" % (bad,))


if __name__ == "__main__":
    unittest.main()
