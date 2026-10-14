"""Bridge ops that the scenario suites did not reach (exec, introspect.modules), the orphan sweep, and the namespace rule.

Black-box, like tests/test_scenarios.py: a bridge child process (tests/bridge_client.py) against the fake board over
``socket://127.0.0.1``. ``MPY_SAFE_MODE=1`` is forced into the child by tests.support.child_env().

    export MPY_SAFE_MODE=1; timeout 120 python3.13 -B -m unittest tests.test_bridge_ops
"""
from __future__ import annotations

import os
import unittest

from tests.bridge_client import BridgeTestCase, BridgeCallError
from tests.support import wait_until


class ExecAndIntrospectTests(BridgeTestCase):
    def test_exec_returns_out_and_err_and_shares_the_students_namespace(self):
        """Protocol 3 `exec`: {out, err} from the raw REPL without a reset. Unlike the bridge's own snippets it runs in
        __main__ (that is what a diagnostic needs), and fs.* ops in between must not disturb the variable it made."""
        board, c, _ = self.connected("esp32")
        r = c.call("exec", code="zz_probe = 41\nprint(zz_probe + 1)\n")
        self.assertEqual(r["out"].strip(), "42")
        self.assertEqual(r["err"], "")
        c.call("fs.list", path="/")  # a bridge snippet in between
        self.assertEqual(c.call("exec", code="print(zz_probe)\n")["out"].strip(), "41")
        bad = c.call("exec", code="1 / 0\n")
        self.assertIn("ZeroDivisionError", bad["err"])
        self.assertEqual(board.events.count("soft_reset") + board.events.count("hard_reset"), 0)

    def test_exec_timeout_is_E_BOARD_UNRESPONSIVE_and_the_bridge_keeps_serving(self):
        """A.3: an exec stage timeout is E_BOARD_UNRESPONSIVE; the next request is still answered."""
        _board, c, _ = self.connected("esp32")
        resp = c.request("exec", code="while True:\n    pass\n", timeoutMs=300, _timeout=30)
        self.assertFalse(resp["ok"], resp)
        self.assertIn(resp["error"]["code"], ("E_BOARD_UNRESPONSIVE", "E_RAW_REPL_TIMEOUT", "E_PROGRAM_RUNNING"), resp)
        c.call("ping")

    def test_introspect_modules_lists_module_attributes_and_rejects_bad_arguments(self):
        """Protocol 3 `introspect.modules`: inventory {modules: {name: {attrs, ...}}, listing}; names must be strings."""
        _board, c, _ = self.connected("esp32")
        r = c.call("introspect.modules", names=["os", "sys"], _timeout=30)
        self.assertIn("modules", r)
        self.assertIn("listing", r)
        self.assertTrue(set(r["modules"]) <= {"os", "sys"}, r["modules"].keys())
        self.assertIn("os", r["modules"])
        self.assertIn("listdir", r["modules"]["os"]["attrs"])
        with self.assertRaises(BridgeCallError) as ctx:
            c.call("introspect.modules", names="os")
        self.assertEqual(ctx.exception.code, "E_PROTOCOL")


class OrphanSweepTests(BridgeTestCase):
    """A.4: the bridge removes stale `.mpytmp` upload leftovers once per session, after the first file op, never at connect."""

    def test_stale_temp_file_is_removed_once_after_the_first_file_op_not_at_connect(self):
        board = self.new_board("esp32")
        board.write_file("/stale.py.mpytmp", b"half an upload")
        c = self.new_bridge()
        c.call("connect", port=board.url)
        self.assertEqual(board.events.count("raw_enter") + board.events.count("exec"), 0, "connect must not touch the raw REPL")
        self.assertTrue(board.exists("/stale.py.mpytmp"))
        c.call("fs.stat", path="/")
        wait_until(lambda: not board.exists("/stale.py.mpytmp"), 15.0, "the orphan sweep to remove the stale temp file")
        # once per session: a second leftover (made behind the bridge's back) survives later file ops
        board.write_file("/second.py.mpytmp", b"x")
        c.call("fs.stat", path="/")
        c.call("fs.list", path="/", background=True)  # class 4: answered after anything the bridge queued by itself
        self.assertTrue(board.exists("/second.py.mpytmp"))

    def test_sweep_is_skipped_on_a_port_that_runs_on_a_host_os(self):
        """The unix port's '/' is the HOST disk: the sweep must never walk it (it would block every later op and delete
        host files). Profile unix-like reports a host sys.platform."""
        board = self.new_board("unix-like")
        board.write_file("/stale.py.mpytmp", b"must stay")
        c = self.new_bridge()
        c.call("connect", port=board.url)
        c.call("fs.stat", path="/")
        c.call("fs.list", path="/", background=True)  # answered only after the (skipped) sweep
        self.assertTrue(board.exists("/stale.py.mpytmp"))
        self.assertTrue(os.path.isdir(board.root))


if __name__ == "__main__":
    unittest.main()
