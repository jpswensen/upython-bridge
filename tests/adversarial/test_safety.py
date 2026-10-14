"""Break-it tests for the reset policy (RQ-SAFE-1..4, CLAUDE.md rule 5) and safe mode (protocol section 8).

Every test talks to a socket://127.0.0.1 fake board (tools/fakeboard.py). No serial port is opened.
Tests named ``test_*`` pin a defect found by the review: they fail until the defect is fixed.

Run from the repo root:
    export MPY_SAFE_MODE=1
    python3 -B -m unittest tests.adversarial.test_safety -v
"""
from __future__ import annotations

import os
import sys
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tests.adversarial._harness import BridgeError, Link, Rig, devfs  # noqa: E402
from bridge import link as linkmod  # noqa: E402


def resets(board):
    return [(e["ev"], e.get("reason")) for e in board.events if e["ev"] in ("soft_reset", "hard_reset")]


class NoImplicitResetTests(unittest.TestCase):
    """Flows that must never reset the board (open, sync, attach, file ops, stop, close)."""

    def test_connect_sync_attach_fileop_stop_close_never_reset(self):
        with Rig(capture=True, files={"/main.py": "print('MAIN')\n"}) as r:
            r.connect()
            r.link.attach_repl(lambda b: None)
            for _ in range(3):
                r.fs(devfs.stat, "/boot.py")
                r.fs(devfs.manifest, "/")
            r.link.interrupt()
            r.link.detach_repl()
            r.link.close()
            r.link.open(r.board.url)
            r.link.sync_to_prompt(100, 100)
            r.link.close()
            self.assertEqual(resets(r.board), [])

    def test_hard_reset_on_a_url_is_refused_without_touching_modem_lines(self):
        with Rig() as r:
            r.connect()
            with self.assertRaises(BridgeError) as cm:
                r.link.hard_reset()
            self.assertEqual(cm.exception.code, "E_UNSUPPORTED")
            self.assertEqual(resets(r.board), [])

    def test_code_with_ctrl_d_or_ctrl_c_is_refused_and_empty_code_is_not_a_reset(self):
        with Rig() as r:
            r.connect()
            with r.link.session():
                r.link.enter_raw()
                for bad in ("print('a\x04b')", "x = '\x03'"):
                    with self.assertRaises(BridgeError) as cm:
                        r.link.exec(bad)
                    self.assertEqual(cm.exception.code, "E_PROTOCOL")
                for empty in ("", "   \n"):
                    out, err = r.link.exec(empty)
                    self.assertEqual(err, b"")
                r.link.exit_raw()
            self.assertEqual(resets(r.board), [])

    def test_sync_against_a_silent_board_sends_only_crlf(self):
        with Rig(capture=True, faults=["silent"]) as r:
            r.link.open(r.board.url)
            self.assertEqual(r.link.sync_to_prompt(100, 100), "silent")
            time.sleep(0.1)
            self.assertEqual(r.board.rx_data(), b"\r\n")

    def test_stdin_style_keystrokes_are_only_forwarded_when_asked(self):
        # write() is the bypass for tty.write: exactly the caller's bytes, nothing added
        with Rig(capture=True) as r:
            r.connect()
            before = len(r.board.rx_data())
            r.link.write(b"abc")
            time.sleep(0.15)
            self.assertEqual(r.board.rx_data()[before:], b"abc")


class BoardResetUnderUsTests(unittest.TestCase):
    """The board resets by itself (button, brown-out, watchdog) between two ops of one raw-REPL session."""

    def _session_then_board_reset(self, faults, how):
        r = Rig(faults=faults, capture=True, files={"/main.py": "print('MAIN RAN')\n"})
        r.__enter__()
        self.addCleanup(r.__exit__, None, None, None)
        r.connect()
        r.link.enter_raw()
        r.link.exec("print(1)\n")
        mark = len(r.board.events)
        getattr(r.board, how)()
        time.sleep(0.4)
        return r, mark

    def test_exec_without_raw_paste_must_not_send_ctrl_d_to_a_friendly_prompt(self):
        """link._send_code (chunked path, used when the board has no raw paste: ESP8266, old ports, any
        profile with no_raw_paste) writes the code and then Ctrl-D. If the board dropped back to the friendly
        REPL after the previous op (reset button, brown-out, watchdog), that Ctrl-D lands on an empty
        friendly line = SOFT RESET, re-running boot.py/main.py (motors!). RQ-SAFE: no implicit reset.
        Expected: exec raises (E_BOARD_RESET or E_RAW_REPL_TIMEOUT) and the board sees NO soft_reset."""
        r, mark = self._session_then_board_reset(["no_raw_paste"], "hard_reset")
        try:
            r.link.exec("print(2)\n", timeout=3)
        except BridgeError:
            pass
        time.sleep(0.4)
        soft = [e for e in list(r.board.events)[mark:] if e["ev"] == "soft_reset"]
        self.assertEqual(soft, [], "link sent Ctrl-D into the friendly REPL: %r" % soft)

    def test_devfs_identity_without_raw_paste_after_board_reset_must_not_soft_reset(self):
        """Same defect through real use: identity() (like put_abort and introspect_modules) ends with a
        top-level statement, so after a board reset between two ops of a session on a no-raw-paste board the
        chunked exec leaves the friendly REPL at an empty prompt and Ctrl-D soft-resets it."""
        r, mark = self._session_then_board_reset(["no_raw_paste"], "hard_reset")
        try:
            r.link.exec(devfs.render("identity"), timeout=3)
        except BridgeError:
            pass
        time.sleep(0.4)
        soft = [e for e in list(r.board.events)[mark:] if e["ev"] == "soft_reset"]
        self.assertEqual(soft, [], "implicit soft reset(s): %r" % soft)


class SafeModeBypassTests(unittest.TestCase):
    def _allowed(self, port):
        try:
            linkmod.safe_mode_check(port, {"MPY_SAFE_MODE": "1"})
            return True
        except BridgeError as exc:
            self.assertEqual(exc.code, "E_SAFE_MODE")
            return False

    def test_loopback_and_fake_boards_allowed_real_ports_refused(self):
        self.assertTrue(self._allowed("socket://127.0.0.1:5000"))
        self.assertTrue(self._allowed("socket://[::1]:5000"))
        self.assertTrue(self._allowed("loop://"))
        for p in ("/dev/cu.usbserial-0001", "/dev/tty.usbserial-0001", "COM3", "/dev/ttys003",
                  "socket://0.0.0.0:1", "spy:///dev/cu.x", "hwgrep://0001", "//dev/cu.usbserial-0001"):
            self.assertFalse(self._allowed(p), p)

    def test_userinfo_and_dns_tricks_do_not_pass_as_loopback(self):
        """_url_is_safe takes everything before the last ':' as the host and accepts anything that starts with
        '127.'. 'socket://127.0.0.1@example.com:80' is parsed by pyserial (urlsplit) as host example.com, and
        '127.0.0.1.example.com' is a public DNS name. Both pass safe mode and would be connected to over the
        network (rfc2217:// can front a real serial port on another machine)."""
        for p in ("socket://127.0.0.1@example.com:80", "socket://127.0.0.1.example.com:80",
                  "rfc2217://127.0.0.1@lab-pc.example.com:2217"):
            self.assertFalse(self._allowed(p), p)


if __name__ == "__main__":
    unittest.main()
