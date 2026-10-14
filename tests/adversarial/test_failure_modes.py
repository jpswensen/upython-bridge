"""Break-it tests: the board vanishes, the caller misbehaves, the link is reused after errors.

Fake board over socket://127.0.0.1 only. ``test_*`` pin defects found by the review.

    export MPY_SAFE_MODE=1
    python3 -B -m unittest tests.adversarial.test_failure_modes -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tests.adversarial._harness import BridgeError, Link, Rig, devfs  # noqa: E402
from bridge import link as linkmod  # noqa: E402
import serial.urlhandler.protocol_socket as _ps  # noqa: E402

_real_time = None


def setUpModule():
    # pyserial's socket:// close() sleeps 0.3 s; the 200-cycle test would otherwise take minutes
    global _real_time
    _real_time = _ps.time
    _ps.time = types.SimpleNamespace(sleep=lambda s: None, time=time.time, monotonic=time.monotonic)


def tearDownModule():
    _ps.time = _real_time


def fd_count():
    try:
        return len(os.listdir("/dev/fd"))
    except OSError:  # Windows
        return -1


def _scratch_file(nbytes):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "f.bin")
    with open(p, "wb") as f:
        f.write(os.urandom(nbytes))
    return d, p


class UnplugDuringEveryOpTests(unittest.TestCase):
    """The socket dies at an arbitrary moment of each op type: a BridgeError (E_NO_DEVICE), never a raw
    exception, never a hang, on_disconnect exactly once, and the Link object can be closed and reopened."""

    DELAYS = (0.0, 0.05, 0.25)

    def _ops(self, r, src, dst):
        link = r.link

        def run_prog():
            with link.session():
                link.enter_raw(soft_reset=True)
                link.exec_stream("import time\nfor i in range(200):\n    print(i)\n    time.sleep(0.02)\n", lambda b: None)
                link.exit_raw()

        return {
            "put": lambda: r.fs(devfs.put_file, src, "/f.bin"),
            "get": lambda: r.fs(devfs.get_file, "/f.bin", dst),
            "manifest": lambda: r.fs(devfs.manifest, "/"),
            "rmtree": lambda: r.fs(devfs.rmtree, "/dir"),
            "run": run_prog,
            "sync": lambda: link.sync_to_prompt(300, 300),
            "exit_raw": lambda: (link.enter_raw(), link.exit_raw()),
        }

    def test_unplug_at_random_moments(self):
        d, src = _scratch_file(200000)
        dst = os.path.join(d, "g.bin")
        with Rig(files={"/dir/a.txt": "x"}) as r:
            with open(src, "rb") as fh:
                r.board.write_file("/f.bin", fh.read())
            for name in ("put", "get", "manifest", "rmtree", "run", "sync", "exit_raw"):
                for delay in self.DELAYS:
                    with self.subTest(op=name, delay=delay):
                        r.link.close()
                        r.board.write_file("/dir/a.txt", "x")
                        for _ in range(50):  # the exclusive fake re-listens asynchronously
                            try:
                                r.link.open(r.board.url)
                                break
                            except BridgeError:
                                time.sleep(0.05)
                        disc = []
                        r.link.on_disconnect = disc.append
                        timer = threading.Timer(delay, r.board.unplug)
                        timer.start()
                        t0 = time.monotonic()
                        try:
                            self._ops(r, src, dst)[name]()
                            outcome = "finished"  # the op beat the unplug (allowed)
                        except BridgeError as exc:
                            outcome = exc.code
                        timer.join()
                        self.assertLess(time.monotonic() - t0, 15, "hang")
                        self.assertIn(outcome, ("finished", "E_NO_DEVICE"), outcome)
                        if outcome == "E_NO_DEVICE":
                            time.sleep(0.05)
                            self.assertFalse(r.link.is_open)
                            self.assertEqual(len(disc), 1, "on_disconnect must fire exactly once")
                            with self.assertRaises(BridgeError) as cm:
                                r.link.write(b"x")
                            self.assertEqual(cm.exception.code, "E_NO_DEVICE")
                        r.link.close()
            self.assertEqual(len(linkmod._HELD & {r.board.url}), 0)

    def test_unplug_while_idle_with_repl_attached_notifies(self):
        with Rig() as r:
            r.connect()
            disc = []
            r.link.on_disconnect = disc.append
            r.link.attach_repl(lambda b: None)
            time.sleep(0.1)
            r.board.unplug()
            deadline = time.monotonic() + 3
            while not disc and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual([e.code for e in disc], ["E_NO_DEVICE"])
            self.assertFalse(r.link.is_open)


class MisuseTests(unittest.TestCase):
    def test_every_call_after_close_is_a_clean_error(self):
        with Rig() as r:
            r.connect()
            r.link.close()
            calls = [
                lambda: r.link.exec("print(1)"), lambda: r.link.write(b"x"), lambda: r.link.interrupt(),
                lambda: r.link.sync_to_prompt(), lambda: r.link.enter_raw(), lambda: r.link.exit_raw(),
                lambda: r.link.attach_repl(lambda b: None), lambda: r.link.hard_reset(),
                lambda: r.link.soft_reset_friendly(), lambda: r.link.read_available(),
            ]
            for call in calls:
                with self.assertRaises(BridgeError) as cm:
                    call()
                self.assertEqual(cm.exception.code, "E_NOT_CONNECTED")
            r.link.close()  # idempotent
            self.assertEqual(r.board.events.count("soft_reset"), 0)

    def test_double_connect_and_second_link_on_same_port(self):
        with Rig(exclusive=False) as r:
            r.connect()
            with self.assertRaises(BridgeError) as cm:
                r.link.open(r.board.url)
            self.assertEqual(cm.exception.code, "E_ALREADY_CONNECTED")
            other = Link()
            with self.assertRaises(BridgeError) as cm:
                other.open(r.board.url)
            self.assertEqual(cm.exception.code, "E_PORT_BUSY")
            self.assertTrue(r.link.is_open, "a refused second open must not disturb the first")
            r.fs(devfs.stat, "/boot.py")

    def test_close_while_an_upload_is_running_does_not_deadlock(self):
        d, src = _scratch_file(1_000_000)
        with Rig() as r:
            r.connect()
            res = {}

            def putter():
                try:
                    r.fs(devfs.put_file, src, "/f.bin")
                    res["r"] = "ok"
                except BridgeError as exc:
                    res["r"] = exc.code
                except BaseException as exc:  # noqa: BLE001
                    res["r"] = "RAW %r" % exc

            th = threading.Thread(target=putter)
            th.start()
            time.sleep(0.3)
            t0 = time.monotonic()
            r.link.close()
            self.assertLess(time.monotonic() - t0, 3)
            th.join(20)
            self.assertFalse(th.is_alive(), "the upload thread is stuck after close()")
            self.assertTrue(res["r"] in ("ok", "E_NOT_CONNECTED", "E_FS_ERRNO"), res)
            self.assertFalse([f for f in os.listdir(r.board.root) if f.endswith(".mpytmp")] and res["r"] == "ok")


class LeakTests(unittest.TestCase):
    def test_200_connect_disconnect_cycles_leak_nothing(self):
        with Rig(exclusive=False) as r:
            r.connect()
            r.link.close()
            fds0, thr0, held0 = fd_count(), threading.active_count(), len(linkmod._HELD)
            for i in range(200):
                r.link.open(r.board.url)
                kind = i % 4
                if kind == 0:
                    r.link.sync_to_prompt(60, 60)
                elif kind == 1:
                    r.link.attach_repl(lambda b: None)
                elif kind == 2:
                    r.fs(devfs.stat, "/boot.py")
                else:
                    r.link.attach_repl(lambda b: None)
                    r.fs(devfs.stat, "/boot.py")
                r.link.close()
            time.sleep(0.2)
            self.assertEqual(threading.active_count(), thr0, [t.name for t in threading.enumerate()])
            self.assertEqual(len(linkmod._HELD), held0)
            if fds0 >= 0:
                self.assertLessEqual(fd_count(), fds0 + 1)
            self.assertEqual(r.board.events.count("soft_reset") + r.board.events.count("hard_reset"), 0)


class IdleClassificationTests(unittest.TestCase):
    def test_program_blocked_in_input_with_a_prompt_lookalike_is_not_idle(self):
        """sync_to_prompt classifies by the tail of the bytes seen. A main.py waiting in input('>>> ') ends
        in '>>> ' exactly like the friendly REPL, so connect reports 'prompt' (idle) for a RUNNING program.
        The bridge would then run file ops (enter_raw sends Ctrl-C) instead of answering E_PROGRAM_RUNNING.
        Expected: not 'prompt' (e.g. 'running-program' or an 'ambiguous' verdict)."""
        main = "name = input('>>> ')\nprint('hello', name)\n"
        with Rig(files={"/main.py": main}, power_on="connect") as r:
            r.link.open(r.board.url)
            verdict = r.link.sync_to_prompt(400, 400)
            self.assertTrue(r.board.program_running, "fixture: main.py must be running")
            self.assertNotEqual(verdict, "prompt")


if __name__ == "__main__":
    unittest.main()
