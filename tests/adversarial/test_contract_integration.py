"""Integration guards the suite lacked: Link + devfs against tools/fakeboard.py (the shipped fake board) for every
profile (RQ-GEN-4), RQ-SAFE-1 byte-level evidence, RQ-RUN-1 keystrokes, and the real-VM relay.

Until now Link was only tested against the immutable prototype tools/prototypes/fakeboard_v0.py and devfs only against
a private in-test board and the bare VM, so nothing exercised the product pair against the product fake.

The defects this module once pinned (tests named *_FAILS_TODAY) are fixed; every test here now passes and pins the behaviour.

    export MPY_SAFE_MODE=1 MPY_UNIX_BIN=<unix micropython>      # MPY_UNIX_BIN optional
    python3 -B -m unittest tests.adversarial.test_contract_integration -v
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
for _p in (ROOT, os.path.join(ROOT, "bridge", "vendor")):
    if _p in sys.path:
        sys.path.remove(_p)
    sys.path.insert(0, _p)
os.environ["MPY_SAFE_MODE"] = "1"

from bridge import devfs  # noqa: E402
from bridge.errors import BridgeError  # noqa: E402
from bridge.link import Link  # noqa: E402
from tools.fakeboard import FakeBoard, PROGRAMS, list_profiles  # noqa: E402


class Rig(object):
    def __init__(self, profile="esp32", **kw):
        self.board = FakeBoard(profile=profile, **kw)
        self.link = Link()

    def __enter__(self):
        self.board.start()
        return self

    def __exit__(self, *a):
        try:
            self.link.close()
        finally:
            self.board.stop()

    def connect(self):
        self.link.open(self.board.url)
        return self.link.sync_to_prompt(300, 300)

    def fs(self, fn, *args, **kw):
        lk = self.link
        with lk.session():
            lk.enter_raw()
            try:
                return fn(lk.exec, *args, **kw)
            finally:
                lk.exit_raw()


class ProfileMatrixTests(unittest.TestCase):
    """RQ-GEN-4: identity + a file round trip pass for ESP32, ESP32-S3 native USB, RP2040/RP2350, STM32, ESP8266 and the
    custom frozen+C-module firmware, with 0 resets and 1 connect."""

    def test_every_profile_identity_and_file_roundtrip(self):
        tmp = tempfile.mkdtemp(prefix="review-matrix-")
        self.addCleanup(shutil.rmtree, tmp, True)
        payload = bytes(range(256)) * 20 + b"\r\n\xff\x00end"
        local = os.path.join(tmp, "OneDrive (x)", "ME 241 (Fall)", "é @ (1).bin")
        os.makedirs(os.path.dirname(local))
        with open(local, "wb") as f:
            f.write(payload)
        names = list_profiles()
        for must in ("esp32", "esp32s3-usb", "rp2", "rp2350", "stm32", "esp8266", "custom-frozen"):
            self.assertIn(must, names)
        for prof in names:
            with self.subTest(profile=prof):
                with Rig(prof) as r:
                    self.assertEqual(r.connect(), "prompt")
                    prefix = "/flash" if r.board.profile.get("mount") else ""
                    ident = r.fs(devfs.identity)
                    self.assertEqual(ident["impl"], "micropython")
                    self.assertEqual(ident["machine"], r.board.profile["machine"])
                    self.assertEqual(ident["caps"]["hash"], "none" if prof == "esp8266" else "sha256")
                    self.assertEqual(ident["caps"]["compile"], prof != "esp8266")
                    put = r.fs(devfs.put_file, local, prefix + "/lab/é @ (1).bin")
                    self.assertEqual(put["sha256"], hashlib.sha256(payload).hexdigest())
                    man = r.fs(devfs.manifest, prefix or "/")
                    self.assertEqual(man["hash"], ident["caps"]["hash"])
                    row = [e for e in man["entries"] if e["path"].endswith("é @ (1).bin")][0]
                    self.assertEqual(row["size"], len(payload))
                    back = os.path.join(tmp, "back-" + prof)
                    self.assertEqual(r.fs(devfs.get_file, prefix + "/lab/é @ (1).bin", back)["bytes"], len(payload))
                    with open(back, "rb") as f:
                        self.assertEqual(f.read(), payload)
                    self.assertEqual(r.board.events.count("connect"), 1)
                    self.assertEqual(r.board.events.count("soft_reset"), 0)
                    self.assertEqual(r.board.events.count("hard_reset"), 0)


class NoResetEvidenceTests(unittest.TestCase):
    """RQ-SAFE-1: 20 connect/disconnect cycles, with file operations in between, send nothing but bare newlines at the
    prompt-sync step, never Ctrl-D, never a reset (byte-level and event-level)."""

    def test_twenty_cycles_send_no_control_bytes_and_cause_no_reset(self):
        board = FakeBoard(profile="esp32", capture=True)
        board.start()
        try:
            lk = Link()
            for i in range(20):
                lk.open(board.url)
                lk.sync_to_prompt(150, 150)
                if i % 5 == 0:
                    with lk.session():
                        lk.enter_raw()
                        devfs.stat(lk.exec, "/boot.py")
                        lk.exit_raw()
                lk.close()
                board.events.wait_for("disconnect", timeout=2, since=0)
            sent = board.rx_data()
            self.assertEqual(board.events.count("connect"), 20)
            self.assertEqual(board.events.count("soft_reset"), 0)
            self.assertEqual(board.events.count("hard_reset"), 0)
            self.assertEqual(board.events.count("power_on"), 1)
            # the only Ctrl-D bytes allowed are code terminators inside raw-REPL sessions (4 sessions)
            self.assertLessEqual(sent.count(b"\x04"), 4 * 3)
            self.assertEqual(board.events.count("raw_enter"), 4)
            self.assertEqual(board.events.count("interrupt"), 4)      # enter_raw's single Ctrl-C per file-op session
        finally:
            board.stop()

    def test_connect_to_a_silent_idle_repl_sends_exactly_one_crlf(self):
        board = FakeBoard(profile="esp32", capture=True)
        board.start()
        try:
            lk = Link()
            lk.open(board.url)
            self.assertEqual(lk.sync_to_prompt(150, 300), "prompt")
            lk.close()
            self.assertEqual(board.rx_data(), b"\r\n")
        finally:
            board.stop()


class KeystrokeTests(unittest.TestCase):
    """RQ-RUN-1: bytes written through Link.write (tty.write) reach sys.stdin of a program started in the raw REPL,
    and the program sees them within 100 ms (N-9 demo pattern: select.poll on sys.stdin)."""

    def test_poll_on_stdin_sees_a_key_within_100ms(self):
        with Rig("esp32") as r:
            r.connect()
            lk = r.link
            lk.enter_raw()
            seen = []
            th = threading.Thread(target=lambda: lk.exec_stream(PROGRAMS["course_demo"], seen.append))
            th.daemon = True
            th.start()
            deadline = time.monotonic() + 3
            while not seen and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertTrue(seen)
            time.sleep(0.1)
            t0 = time.monotonic()
            lk.write(b"x")
            while b"pressed x" not in b"".join(seen) and time.monotonic() - t0 < 2:
                time.sleep(0.002)
            self.assertLess(time.monotonic() - t0, 0.1)
            lk.write(b"q")
            th.join(3)
            self.assertFalse(th.is_alive())
            self.assertIn(b"bye", b"".join(seen))


class WrapperTracebackTests(unittest.TestCase):
    """D-07 / RQ-RUN-2 on the shipped fake: the compile() wrapper keeps the local path (spaces, parentheses, non-ASCII)."""

    def test_wrapper_gives_clickable_traceback_and_main_name(self):
        local_path = "C:\\Users\\x\\OneDrive - Washington State University\\Documents\\ME 241 (Fall)\\Lab 1\\prüfung @1.py"
        src = "print(__name__)\ndef f():\n    raise RuntimeError('in f')\nf()\n"
        wrapper = "exec(compile(%r, %r, 'exec'), {'__name__': '__main__'})" % (src, local_path)
        with Rig("esp32") as r:
            r.connect()
            lk = r.link
            lk.enter_raw()
            out, err = lk.exec(wrapper)
            self.assertEqual(out, b"__main__\r\n")
            self.assertIn(('File "%s", line 3, in f' % local_path).encode("utf-8"), err)
            self.assertIn(('File "%s", line 4' % local_path).encode("utf-8"), err)


class UnixVmStopTests(unittest.TestCase):
    """RQ-SAFE-3 on the real VM: Stop of a program started the way Run starts it (raw paste, the Link default)."""

    @classmethod
    def setUpClass(cls):
        from tools.mpunix_relay import UnixVM
        reason = UnixVM.skip_reason()
        if reason:
            raise unittest.SkipTest(reason)

    def test_ctrl_c_stops_a_raw_pasted_program_on_the_relay(self):
        from tools.mpunix_relay import UnixVM
        with UnixVM() as vm:
            lk = Link()
            try:
                lk.open(vm.url)
                lk.sync_to_prompt(500, 500)
                lk.enter_raw()
                got = []
                th = threading.Thread(
                    target=lambda: lk.exec_stream("import time\nwhile True:\n    print('t')\n    time.sleep(0.01)\n", got.append))
                th.daemon = True
                th.start()
                deadline = time.monotonic() + 5
                while not got and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(got)
                self.assertTrue(lk.raw_paste_supported, "this test is about the raw-paste path")
                self.assertTrue(lk.interrupt(timeout=1.5), "Stop did not end a program started with raw paste")
                th.join(3)
                self.assertFalse(th.is_alive())
            finally:
                lk.close()


if __name__ == "__main__":
    unittest.main()
