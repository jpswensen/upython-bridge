"""Review round 2: what a student sees when Run fails or asks for input, on the REAL MicroPython unix VM (skipped without
MPY_UNIX_BIN).  Only `run` is used: the VM's '/' is the host disk, so no file operation is issued here."""
from __future__ import annotations

import unittest

from tests.bridge_client import BridgeTestCase
from tools.mpunix_relay import UnixVM

VM_SKIP = UnixVM.skip_reason()
WIN_NAME = "C:\\Users\\Jos\u00e9\\OneDrive - WSU (email.wsu.edu)\\ME 241 (Fall)\\Lab 1\\new\\t.py"


@unittest.skipIf(VM_SKIP, VM_SKIP or "")
class StudentRunOnRealVm(BridgeTestCase):
    DEADLINE_S = 120

    def _connect(self):
        vm = UnixVM()
        vm.start()
        self.addCleanup(vm.stop)
        c = self.new_bridge()
        c.call("connect", port=vm.url)
        return vm, c

    def test_syntax_error_names_the_local_file_and_line(self):
        vm, c = self._connect()
        m = c.mark()
        r = c.call("run", source="x = 1\r\n\r\ny = (\r\n", name=WIN_NAME)
        self.assertEqual(r["exit"], "exception", r)
        err = c.err_bytes(since=m).decode("utf-8", "replace")
        self.assertIn("SyntaxError", err)
        self.assertIn(WIN_NAME, err, err)

    def test_runtime_error_in_a_crlf_file_names_the_local_file_and_line(self):
        vm, c = self._connect()
        m = c.mark()
        r = c.call("run", source="x = 1\r\nprint(undefined_name)\r\n", name=WIN_NAME)
        self.assertEqual(r["exit"], "exception", r)
        err = c.err_bytes(since=m).decode("utf-8", "replace")
        self.assertIn("NameError", err)
        self.assertIn(WIN_NAME, err, err)
        self.assertIn("line 2", err)

    def test_input_works_with_the_enter_key_the_terminal_sends(self):
        """VS Code's terminal sends '\\r' for Enter (RQ-RUN-1)."""
        vm, c = self._connect()
        m = c.mark()
        rid = c.send("run", source="name = input('Name? ')\nprint('Hi ' + name + '!')\n", name="ask.py")
        c.wait_out(b"Name? ", 20, since=m)
        c.tty_write(b"Ann\r")
        r = c.result(rid, 20)
        self.assertTrue(r["ok"] and r["exit"] == "ok", r)
        self.assertIn(b"Hi Ann!", c.out_bytes(since=m))

    def test_non_ascii_output_and_source_survive(self):
        vm, c = self._connect()
        m = c.mark()
        r = c.call("run", source="print('caf\u00e9 \u65e5\u672c\u8a9e')  # \u00fcber\n", name="u.py")
        self.assertEqual(r["exit"], "ok", r)
        self.assertIn("caf\u00e9 \u65e5\u672c\u8a9e".encode("utf-8"), c.out_bytes(since=m))


if __name__ == "__main__":
    unittest.main()
