"""Break-it round 2: state-machine and queue-semantics probes (what a student can trigger by clicking)."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

from tests.bridge_client import BridgeTestCase, BridgeTimeout, b64
from tests.support import wait_until

LOOP = "import time\nprint('go')\nwhile True:\n    time.sleep(0.02)\n"


class QueueBehindRun(BridgeTestCase):
    def _answered_within(self, c, op, seconds, **args):
        rid = c.send(op, **args)
        try:
            return c.result(rid, seconds)
        except BridgeTimeout:
            return None

    def test_disconnect_during_a_run_is_answered(self):
        board, c, _ = self.connected()
        self.start_program(c, LOOP)
        resp = self._answered_within(c, "disconnect", 4)
        c.call("stop", _timeout=15)
        self.assertIsNotNone(resp, "disconnect (class 1) sat in the queue behind a running program; the Disconnect button does nothing until the program ends")

    def test_repl_detach_during_a_run_is_answered(self):
        board, c, _ = self.connected()
        self.start_program(c, LOOP)
        resp = self._answered_within(c, "repl.detach", 4)
        c.call("stop", _timeout=15)
        self.assertIsNotNone(resp, "repl.detach only flips a flag but waits for the end of the running program")


class HeldKeystrokes(BridgeTestCase):
    def test_overflowing_keystrokes_during_a_file_op_are_not_silently_dropped(self):
        board, c, _ = self.connected(faults=["slow:230400"])
        c.call("repl.attach")
        path = self.write_local(self.local_dir(), "big.bin", os.urandom(120 * 1024))
        put = c.send("fs.put", local=path, remote="/big.bin")
        c.wait_event("progress", lambda e: e["id"] == put and e["done"] > 0, 20)
        m = c.mark()
        r1 = c.request("tty.write", b64=b64(b"A" * 3000))
        r2 = c.request("tty.write", b64=b64(b"B" * 3000))      # 6000 > the 4096-byte hold buffer
        r3 = c.request("tty.write", b64=b64(b"C"))
        self.assertTrue(c.result(put, 60)["ok"])
        self.assertTrue(r1["ok"] and r2["ok"] and r3["ok"])
        wait_until(lambda: b"C" in c.repl_bytes(m), 10, "the held keystrokes to be replayed")
        echoed = c.repl_bytes(m)
        self.assertEqual((echoed.count(b"A"), echoed.count(b"B")), (3000, 3000),
                         "tty.write answered ok:true but only %d of 3000 'A' and %d of 3000 'B' keystrokes reached the board" % (echoed.count(b"A"), echoed.count(b"B")))


class SizeLimits(BridgeTestCase):
    DEADLINE_S = 120

    def test_exec_response_respects_the_4mib_line_limit(self):
        board, c, _ = self.connected()
        r = c.request("exec", code="s = 'x' * 1000\nfor i in range(6000):\n    print(s)\n", timeoutMs=60000, _timeout=90)
        raw = len(json.dumps(r))
        self.assertTrue(raw <= 4 * 1024 * 1024 or not r["ok"], "exec answered with a %d byte line (> 4 MiB protocol limit)" % raw)
        c.ping()
        c.assert_clean_stdout()


class StateVersusTheBoard(BridgeTestCase):
    def test_file_ops_work_once_the_board_is_seen_idle_at_a_prompt(self):
        """connect to a board that is still booting (silent) -> state `running`, sync `silent`. The pump later sees the
        friendly prompt, yet the state never moves and every file op answers E_PROGRAM_RUNNING."""
        board = self.new_board(faults=["delay_boot:1.2"])
        c = self.new_bridge()
        resp = c.call("connect", port=board.url)
        c.call("repl.attach")
        wait_until(lambda: c.repl_bytes().count(b">>>") >= 2, 15, "the board to reach its prompt")
        wait_until(lambda: not board.program_running, 5, "the board to idle")
        r = c.request("fs.list", path="/", _timeout=15)
        self.assertTrue(r["ok"], "connect said state=%s sync=%s; the prompt has been on screen since, fs.list says %s"
                        % (resp["state"], resp["sync"], (r.get("error") or {}).get("code")))


class CtrlCWithoutStdin(BridgeTestCase):
    def test_ctrl_c_keystroke_still_interrupts_a_run_started_with_stdin_false(self):
        board, c, _ = self.connected()
        rid = self.start_program(c, LOOP, stdin=False)
        c.tty_write(b"\x03")
        wait_until(lambda: not board.program_running, 4, "Ctrl-C typed in the Run tab to interrupt the program (tty.write \\x03 is a plain interrupt, protocol section 3)")
        c.call("stop", _timeout=15)
        c.result(rid, 15)


if __name__ == "__main__":
    unittest.main()
