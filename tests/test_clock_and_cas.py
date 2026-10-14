"""Board clock (decision D-22: clock.read / clock.set) and the compare-and-swap precondition of fs.put (ifSha, D-21).

Black-box: a bridge child process (tests/bridge_client.py) against the fake board over ``socket://127.0.0.1``.

    export MPY_SAFE_MODE=1; timeout 300 python3.13 -B -m unittest tests.test_clock_and_cas
"""
from __future__ import annotations

import datetime
import hashlib
import os
import tempfile
import unittest

from tests.bridge_client import BridgeCallError, BridgeTestCase
from tools.fakeboard import derive_profile


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ClockTests(BridgeTestCase):
    def test_read_reports_an_rtc_and_a_plausible_clock_on_a_board_that_follows_real_time(self):
        board, c, _ = self.connected("esp32")
        r = c.call("clock.read")
        self.assertTrue(r["rtc"], r)
        self.assertTrue(r["plausible"], r)
        self.assertEqual(len(r["time"]), 7)
        self.assertGreaterEqual(r["time"][0], 2024)
        self.assertEqual(board.events.count("soft_reset") + board.events.count("hard_reset"), 0, "reading resets nothing")

    def test_an_unset_clock_reads_as_year_2000_and_is_not_plausible_then_set_makes_it_real(self):
        board, c, _ = self.connected(derive_profile("esp32", caps={"clock_unset": True}))
        before = c.call("clock.read")
        self.assertEqual(before["time"][0], 2000, before)
        self.assertFalse(before["plausible"])
        now = datetime.datetime(2026, 10, 13, 14, 25, 30)
        after = c.call("clock.set", time=[now.year, now.month, now.day, now.hour, now.minute, now.second, now.weekday()])
        self.assertTrue(after["plausible"], after)
        self.assertEqual(after["time"][:5], [2026, 10, 13, 14, 25], after)
        self.assertIn(after["time"][5], (30, 31, 32))
        self.assertEqual(after["time"][6], now.weekday())
        self.assertEqual(board.events.count("rtc_set"), 1)
        self.assertEqual(board.events.count("soft_reset") + board.events.count("hard_reset"), 0, "setting resets nothing")
        # the board keeps counting from the time it was given
        again = c.call("clock.read")
        self.assertEqual(again["time"][:4], [2026, 10, 13, 14])

    def test_set_is_refused_without_an_rtc_and_nothing_is_changed(self):
        board, c, _ = self.connected(derive_profile("esp32", caps={"rtc": False, "clock_unset": True}))
        self.assertFalse(c.call("clock.read")["rtc"])
        with self.assertRaises(BridgeCallError) as ctx:
            c.call("clock.set", time=[2026, 10, 13, 14, 25, 30, 0])
        self.assertEqual(ctx.exception.code, "E_UNSUPPORTED")
        self.assertEqual(board.events.count("rtc_set"), 0)

    def test_unix_like_port_has_no_rtc(self):
        _board, c, _ = self.connected("unix-like")
        self.assertFalse(c.call("clock.read")["rtc"])

    def test_bad_time_arguments_are_protocol_errors_before_the_board_is_touched(self):
        board, c, _ = self.connected("esp32")
        for bad in ([2026, 13, 1, 0, 0, 0, 0], [2026, 1, 1, 0, 0, 0], "now", [2026, 1, 1, 0, 0, 0, True], [1999, 1, 1, 0, 0, 0, 0]):
            with self.subTest(bad=bad):
                with self.assertRaises(BridgeCallError) as ctx:
                    c.call("clock.set", time=bad)
                self.assertEqual(ctx.exception.code, "E_PROTOCOL")
        self.assertEqual(board.events.count("rtc_set"), 0)

    def test_a_chip_reset_loses_the_clock_on_a_board_without_a_kept_rtc(self):
        board, c, _ = self.connected(derive_profile("esp32", caps={"clock_unset": True}))
        c.call("clock.set", time=[2026, 10, 13, 14, 25, 30, 0])
        self.assertTrue(c.call("clock.read")["plausible"])
        c.call("reset.machine", confirmed=True, _timeout=60)
        self.assertFalse(c.call("clock.read")["plausible"], "a power cycle or chip reset brings the 2000 clock back")


class PutPreconditionTests(BridgeTestCase):
    def _local(self, data: bytes) -> str:
        fd, path = tempfile.mkstemp(prefix="cas-", suffix=".py")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        self.addCleanup(os.remove, path)
        return path

    def test_absent_precondition_writes_a_new_file_and_refuses_when_one_appeared(self):
        board, c, _ = self.connected("esp32")
        new = b"print('new')\n"
        c.call("fs.put", local=self._local(new), remote="/fresh.py", ifSha="absent")
        self.assertEqual(board.read_file("/fresh.py"), new)
        with self.assertRaises(BridgeCallError) as ctx:
            c.call("fs.put", local=self._local(b"print('other')\n"), remote="/fresh.py", ifSha="absent")
        self.assertEqual(ctx.exception.code, "E_DEST_CHANGED")
        cur = ctx.exception.error.get("current") or {}
        self.assertTrue(cur.get("exists"), ctx.exception.error)
        self.assertEqual(cur.get("sha256"), _sha(new))
        self.assertEqual(board.read_file("/fresh.py"), new, "the board copy is untouched")

    def test_hash_precondition_replaces_only_the_expected_content(self):
        board, c, _ = self.connected("esp32")
        base = b"x = 1\n"
        board.write_file("/main.py", base)
        mine = b"x = 2\n"
        r = c.call("fs.put", local=self._local(mine), remote="/main.py", ifSha=_sha(base))
        self.assertFalse(r.get("skipped"), r)
        self.assertEqual(board.read_file("/main.py"), mine)
        # someone else (a program, another PC) changed the board copy: a stale precondition is refused
        board.write_file("/main.py", b"x = 99  # changed on the board\n")
        with self.assertRaises(BridgeCallError) as ctx:
            c.call("fs.put", local=self._local(b"x = 3\n"), remote="/main.py", ifSha=_sha(mine))
        self.assertEqual(ctx.exception.code, "E_DEST_CHANGED")
        self.assertEqual(board.read_file("/main.py"), b"x = 99  # changed on the board\n")
        leftovers = [f for _d, _s, fs in os.walk(board.host_path("/")) for f in fs if f.endswith(".mpytmp")]
        self.assertEqual(leftovers, [], "no temp file left behind")

    def test_a_board_that_already_holds_the_new_content_is_skipped_whatever_the_precondition(self):
        board, c, _ = self.connected("esp32")
        same = b"print('same')\n"
        board.write_file("/same.py", same)
        r = c.call("fs.put", local=self._local(same), remote="/same.py", ifSha="0" * 64)
        self.assertTrue(r.get("skipped"), r)

    def test_a_deleted_board_file_or_a_folder_in_the_way_fails_a_hash_precondition(self):
        board, c, _ = self.connected("esp32")
        with self.assertRaises(BridgeCallError) as ctx:
            c.call("fs.put", local=self._local(b"a\n"), remote="/gone.py", ifSha="1" * 64)
        self.assertEqual(ctx.exception.code, "E_DEST_CHANGED")
        self.assertFalse((ctx.exception.error.get("current") or {}).get("exists", True))
        os.makedirs(board.host_path("/adir.py"))
        with self.assertRaises(BridgeCallError) as ctx2:
            c.call("fs.put", local=self._local(b"a\n"), remote="/adir.py", ifSha="absent")
        self.assertEqual(ctx2.exception.code, "E_DEST_CHANGED")

    def test_a_board_without_hashlib_cannot_check_a_hash_precondition_but_can_check_absent(self):
        board, c, _ = self.connected(derive_profile("esp32", caps={"hashlib": False}))
        board.write_file("/m.py", b"old\n")
        with self.assertRaises(BridgeCallError) as ctx:
            c.call("fs.put", local=self._local(b"new\n"), remote="/m.py", ifSha=_sha(b"old\n"))
        self.assertEqual(ctx.exception.code, "E_UNSUPPORTED")
        self.assertEqual(board.read_file("/m.py"), b"old\n")
        c.call("fs.put", local=self._local(b"brand new\n"), remote="/n.py", ifSha="absent")
        self.assertEqual(board.read_file("/n.py"), b"brand new\n")

    def test_bad_precondition_values_are_protocol_errors(self):
        _board, c, _ = self.connected("esp32")
        for bad in ("absentx", "abc", "g" * 64, 5):
            with self.subTest(bad=bad):
                with self.assertRaises(BridgeCallError) as ctx:
                    c.call("fs.put", local=self._local(b"a\n"), remote="/p.py", ifSha=bad)
                self.assertEqual(ctx.exception.code, "E_PROTOCOL")


class IntrospectClassesTests(BridgeTestCase):
    def test_classes_report_their_members_and_kinds_without_calling_them(self):
        pkg = (
            "PI = 3\n"
            "class Motor:\n"
            "    LIMIT = 100\n"
            "    def __init__(self, n):\n        self.n = n\n"
            "    def gains(self, kp, ki, kd):\n        pass\n"
            "    @property\n    def position(self):\n        raise RuntimeError('must not be called')\n"
            "def run(main):\n    pass\n"
        )
        prof = derive_profile("esp32", frozen={"acme/__init__.py": pkg})
        _board, c, _ = self.connected(prof)
        r = c.call("introspect.modules", names=["acme"], _timeout=30)
        m = r["modules"]["acme"]
        self.assertIn("acme/__init__", r["listing"], "frozen packages show up like on real MicroPython: 'pkg/__init__'")
        self.assertEqual(m["kinds"]["Motor"], "class")
        self.assertEqual(m["kinds"]["run"], "function")
        self.assertEqual(m["consts"]["PI"], 3)
        motor = m["classes"]["Motor"]
        self.assertIn("gains", motor["members"])
        self.assertIn("__init__", motor["members"])
        self.assertEqual(motor["kinds"]["gains"], "function")
        self.assertEqual(motor["kinds"]["position"], "property")
        self.assertEqual(motor["kinds"]["LIMIT"], "int")


class FrozenPackageNamesTests(BridgeTestCase):
    def test_a_frozen_package_is_listed_as_printed_and_guards_its_top_level_name(self):
        """Real help('modules') prints 'shield/__init__' and 'shield/motor' (py/builtinhelp.c). The inventory keeps those, and the
        identity's shadow-guard names get the importable top-level name, so a student's /acme.py is refused."""
        prof = derive_profile("esp32", frozen={"acme/__init__.py": "X = 1\n", "acme/motor.py": "Y = 2\n", "solo.py": "Z = 3\n"})
        board, c, _ = self.connected(prof)
        listing = c.call("introspect.modules", _timeout=30)["listing"]
        for name in ("acme/__init__", "acme/motor", "solo"):
            self.assertIn(name, listing)
        hints = c.call("identity")["profileHints"]["modules"]
        self.assertIn("acme", hints)
        self.assertIn("solo", hints)
        self.assertFalse(any("/" in n for n in hints), hints)
        fd, path = tempfile.mkstemp(suffix=".py")
        os.close(fd)
        self.addCleanup(os.remove, path)
        with self.assertRaises(BridgeCallError) as ctx:
            c.call("fs.put", local=path, remote="/acme.py")
        self.assertEqual(ctx.exception.code, "E_SHADOWS_MODULE")
        self.assertFalse(board.exists("/acme.py"))


if __name__ == "__main__":
    unittest.main()
