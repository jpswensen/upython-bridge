"""Regression tests for rows of docs/old-defects.md that apply to the BRIDGE PROCESS and are not pinned by the core trio.

One named test per row (`test_<section>_<row>_...`), each docstring starts with `PINS <row ids>` and says what is asserted in a way
that fails against the old (buggy) behaviour.  Black-box: the bridge runs as a child process (tests/bridge_client.py) against
fake boards.

Rows already pinned elsewhere (grep `PINS` in tests/): 02.4 02.7 02.8 02.10 02.13 05.4 05.5 05.11 05.12 08.2 08.5 08.10 08.12 08.13
(core trio + tests/adversarial) and, at the device-code level, 03.1 03.2 03.3 03.5 03.10 03.12 (tests/test_devfs.py).

Rows pinned by tests in the OTHER files of this round (cell text for the docs owner):
    02.2 02.3  tests.test_scenarios.ReplTests.test_file_ops_while_the_repl_is_attached_keep_the_repl_state;
               tests.test_scenarios.ReplTests.test_repl_detach_stops_the_repl_events_and_keeps_the_port
    02.6 02.11 N/A: extension-side (interpreter resolution / settings), not the bridge
    02.12      tests.test_scenarios_faults.StopEscalationTests.test_silent_board_gives_a_bounded_error_not_a_hang
    02.14      N/A: investigation note
    03.7 05.17 08.17  tests.test_scenarios.FileOpTests.test_upload_twenty_files_and_manifest_in_one_port_session
    05.10      tests.test_scenarios.ConnectTests.test_ports_list_shape_and_never_opens
    08.4       N/A: the bridge hosts no TTY; tests.test_scenarios.ReplTests run the REPL over plain pipes
    08.6 01.9  tests.test_scenarios.ConnectTests.test_hostile_working_directory_and_cp1252_environment
    08.9 05.9  same test (cp1252 environment, non-ASCII names) and tests.test_scenarios.FileOpTests.test_weird_file_names_round_trip
    08.14      tests.test_scenarios.StateAtConnectTests.test_soft_reset_runs_boot_and_main_but_run_does_not_run_main
    08.15      tests.test_scenarios.FileOpTests.test_shadow_guard_refuses_module_names_before_touching_the_board
    03.16      N/A here: throughput is measured on hardware (S-xx), not on the fake
Rows N/A at this layer (extension / UI / TypeScript / packaging): 01.x, 02.5-02.6 (in part), 02.16-02.18, 03.9, 03.11, 03.14, 03.15,
04.x, 05.2, 05.6-05.8, 05.13, 05.14, 05.18, 05.20-05.25, 06.x, 07.x, 08.3, 08.16, 08.18, 09.x.

    export MPY_SAFE_MODE=1
    timeout 600 python3.13 -B -m unittest tests.test_regressions
"""
from __future__ import annotations

import os
import sys
import unittest

from tests.bridge_client import BridgeTestCase
from tests.support import wait_until
from tests.test_differential import snapshot
from tests.test_scenarios import pseudo_random, sha, tmp_files

WINDOWS = sys.platform == "win32"


class RunAndSessionRegressions(BridgeTestCase):
    def test_02_01_run_executes_the_editor_buffer_never_the_boards_copy(self):
        """PINS 02.1, D-07: Run sends the LOCAL file: a stale copy on the board is not executed, a file that was never uploaded runs
        (no ImportError), no `import <module>` is ever sent, Run does not write to the board's filesystem."""
        board, c, _ = self.connected("esp32", board_kw=dict(files={"/test.py": "print('STALE BOARD COPY')\n"}, capture=True))
        folder = self.local_dir()
        local = self.write_local(folder, "test.py", "print('LOCAL EDITOR BUFFER', __name__)\n")
        never_uploaded = self.write_local(folder, "never uploaded.py", "print('never uploaded runs')\n")
        m = c.mark()
        self.assertEqual(c.call("run", local=local, _timeout=30)["exit"], "ok")
        out = c.wait_out(b"LOCAL EDITOR BUFFER __main__", 5, since=m)
        self.assertNotIn(b"STALE", out)
        self.assertEqual(c.call("run", local=never_uploaded, _timeout=30)["exit"], "ok")
        c.wait_out(b"never uploaded runs", 5, since=m)
        codes = [e.get("code", "") for e in board.events.of("exec")]
        self.assertTrue(codes)
        self.assertFalse(any("import test" in code or "import never" in code for code in codes))
        self.assertEqual(board.read_file("/test.py"), b"print('STALE BOARD COPY')\n")
        self.assertFalse(board.exists("/never uploaded.py"))

    def test_02_03_sync_with_the_repl_attached_never_closes_or_reopens_the_session(self):
        """PINS 02.3, 03.8: twelve uploads and a listing with the REPL attached: one connect, no disconnect, no state event that
        leaves the session (disconnected / connecting), the REPL variable is still there, no reset."""
        board, c, _ = self.connected("esp32")
        c.call("repl.attach")
        m = c.mark()
        c.tty_write(b"alive = 'yes'\r\n")
        c.wait_stream("repl", b"alive = 'yes'\r\n>>> ", 5, since=m)
        folder = self.local_dir()
        m = c.mark()
        for i in range(12):
            c.call("fs.put", local=self.write_local(folder, "f%d.py" % i, "x = %d\n" % i), remote="/s/f%d.py" % i)
        c.call("fs.list", path="/s")
        self.assertEqual(board.events.count("connect"), 1)
        self.assertEqual(board.events.count("disconnect"), 0)
        self.assertEqual({s for s in c.states(m)} & {"disconnected", "connecting"}, set())
        m = c.mark()
        c.tty_write(b"alive\r\n")
        c.wait_stream("repl", b"'yes'", 5, since=m)
        self.assertNoReset(board)

    def test_02_05_shell_metacharacters_in_local_paths_are_inert(self):
        """PINS 02.5, 05.1, 05.15, 03.13: a local path holding an apostrophe, parentheses, `$(...)`, backticks, `;`, `&` and `%VAR%`
        is passed as data: Run, put and get work and no canary file is created by a shell expansion."""
        bits = "O'Brien (Fall) $(touch CANARY1) `touch CANARY2` ; touch CANARY3 & %PATH%"
        if not WINDOWS:
            bits += " | touch CANARY4 \"quoted\""
        base = self.local_dir(course=False)
        folder = os.path.join(base, bits, "Lab 1")
        os.makedirs(folder)
        board, c, _ = self.connected("esp32")
        path = self.write_local(folder, "t (1).py", "print('shell-free')\n")
        m = c.mark()
        self.assertEqual(c.call("run", local=path, _timeout=30)["exit"], "ok")
        c.wait_out(b"shell-free", 5, since=m)
        c.call("fs.put", local=path, remote="/t.py")
        back = os.path.join(folder, "back.py")
        c.call("fs.get", remote="/t.py", local=back)
        with open(back, "rb") as f:
            self.assertEqual(f.read(), b"print('shell-free')\n")
        for where in (base, folder, c.cwd, os.getcwd()):
            leaked = [n for n in os.listdir(where) if n.startswith("CANARY")]
            self.assertEqual(leaked, [], "a shell expanded the path (found in %s)" % where)

    def test_02_09_soft_reset_is_ctrl_d_never_machine_reset(self):
        """PINS 02.9: `reset.soft` is a Ctrl-D soft reset of the interpreter: exactly one soft reset in the log, no hard reset, the
        board is not powered up again, and the text `machine.reset` never travels to the board."""
        board, c, _ = self.connected("esp32", board_kw=dict(capture=True))
        c.call("reset.soft", _timeout=20)
        wait_until(lambda: board.events.count("soft_reset") == 1, 5, "the soft reset")
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("power_on"), 1)
        self.assertNotIn(b"machine.reset", board.rx_data())
        self.assertNotIn(b"reset()", board.rx_data())

    def test_02_15_every_failure_is_classified_and_reaches_the_log(self):
        """PINS 02.15: failures are not swallowed: each error response has code, message, detail and hint, and the failure is
        also written to the log channel (a `log` event or a stderr line mentioning the code or the errno name)."""
        board, c, _ = self.connected("esp32")
        err = c.fail("fs.rm", "E_FS_ERRNO", path="/definitely-not-here.txt")
        self.assertIn("ENOENT", err["detail"])
        self.assertTrue(err["message"].strip() and err["hint"].strip())

        def logged():
            texts = list(c.stderr_lines) + [e.get("msg", "") for e in c.events_of("log")]
            return any("E_FS_ERRNO" in t or "ENOENT" in t for t in texts)
        wait_until(logged, 5, "the failed fs.rm to appear in the bridge log (stderr or log events)")
        c.assert_clean_stdout()


class FileOpRegressions(BridgeTestCase):
    def test_03_01_exists_mv_and_mkdir_are_real_operations(self):
        """PINS 03.1, 05.3, 08.1: stat of a path that was never uploaded says exists:false (the old `fs stat` always said true);
        mv really renames and a mv of a missing source is an ERROR (the old `fs mv` was an exit-0 no-op); nested mkdir
        creates every level (the old `mkdir -p` was rejected)."""
        board, c, _ = self.connected("esp32", board_kw=dict(files={"/a.txt": "a"}))
        self.assertFalse(c.call("fs.stat", path="/definitely/not/here.py")["exists"])
        self.assertTrue(c.call("fs.stat", path="/a.txt")["exists"])
        c.call("fs.mv", src="/a.txt", dst="/b.txt")
        self.assertEqual((board.exists("/a.txt"), board.read_file("/b.txt")), (False, b"a"))
        self.assertIn("ENOENT", c.fail("fs.mv", "E_FS_ERRNO", src="/a.txt", dst="/c.txt")["detail"])
        c.call("fs.mkdir", path="/x/y/z")
        self.assertTrue(os.path.isdir(board.host_path("/x/y/z")))

    def test_03_04_a_failed_download_keeps_the_existing_local_file(self):
        """PINS 03.4, 05.16: `fs.get` writes to a temp name and renames: when the download fails the user's existing local file
        is untouched and no temp file is left next to it; a successful download replaces it completely."""
        board, c, _ = self.connected("esp32", board_kw=dict(files={"/there.txt": "board version\r\n"}))
        folder = self.local_dir()
        local = self.write_local(folder, "work (1).txt", "MY LOCAL WORK\n")
        c.fail("fs.get", "E_FS_ERRNO", remote="/missing.txt", local=local)
        with open(local, "rb") as f:
            self.assertEqual(f.read(), b"MY LOCAL WORK\n")
        self.assertEqual(sorted(os.listdir(folder)), ["work (1).txt"])
        c.call("fs.get", remote="/there.txt", local=local)
        with open(local, "rb") as f:
            self.assertEqual(f.read(), b"board version\r\n")
        self.assertEqual(sorted(os.listdir(folder)), ["work (1).txt"])

    def test_03_06_a_batch_reports_each_failure_honestly(self):
        """PINS 03.6: of three uploads where the middle one cannot be read, exactly that one answers ok:false (E_LOCAL_IO) and the
        other two are ok and really on the board; nothing is reported as a success that was not."""
        board, c, _ = self.connected("esp32")
        folder = self.local_dir()
        good1 = self.write_local(folder, "g1.py", "g = 1\n")
        good2 = self.write_local(folder, "g2.py", "g = 2\n")
        ids = [c.send("fs.put", local=p, remote="/b/%d.py" % i) for i, p in enumerate((good1, os.path.join(folder, "gone.py"), good2))]
        res = [c.result(i, 30) for i in ids]
        self.assertEqual([r["ok"] for r in res], [True, False, True], res)
        self.assertEqual(res[1]["error"]["code"], "E_LOCAL_IO")
        self.assertEqual((board.read_file("/b/0.py"), board.read_file("/b/2.py")), (b"g = 1\n", b"g = 2\n"))
        self.assertFalse(board.exists("/b/1.py"))

    def test_03_08_overlapping_requests_are_each_answered_once_and_consistently(self):
        """PINS 03.8: forty requests written back to back without waiting (uploads, stats, listings, manifests) are serialised by the
        port owner: every id gets exactly one answer, all succeed, uploads of the same class complete in arrival order, and
        the board holds exactly the uploaded content (no interleaving, no leftover temp)."""
        board, c, _ = self.connected("esp32")
        folder = self.local_dir()
        files = {}
        sent = []
        for i in range(10):
            data = ("module %d\n" % i).encode() * (i + 1)
            files[i] = data
            src = self.write_local(folder, "m%d.py" % i, data)
            sent.append(("put", i, c.send("fs.put", local=src, remote="/o/m%d.py" % i)))
            sent.append(("stat", i, c.send("fs.stat", path="/boot.py")))
            sent.append(("list", i, c.send("fs.list", path="/")))
            sent.append(("man", i, c.send("fs.manifest", root="/")))
        results = [(kind, i, c.result(rid, 60)) for kind, i, rid in sent]
        for kind, i, r in results:
            self.assertTrue(r["ok"], (kind, i, r))
        puts = [r for kind, _i, r in results if kind == "put"]
        self.assertEqual([r["_n"] for r in puts], sorted(r["_n"] for r in puts), "uploads answered out of arrival order")
        self.assertEqual(len({r["id"] for _k, _i, r in results}), 40)
        for i, data in files.items():
            self.assertEqual(board.read_file("/o/m%d.py" % i), data)
        self.assertEqual(tmp_files(board), [])

    def test_03_13_windows_style_device_paths_are_refused(self):
        """PINS 03.13: a device path must be POSIX and absolute: `lab\\x.py`, `C:\\lab\\x.py` and `\\lab` (backslashes leaked from a
        Windows local path) are E_PROTOCOL and create nothing on the board."""
        board, c, _ = self.connected("esp32")
        src = self.write_local(self.local_dir(), "x.py", "x = 1\n")
        before = snapshot(board)
        for bad in ("lab\\x.py", "C:\\lab\\x.py", "\\lab\\x.py"):
            c.fail("fs.put", "E_PROTOCOL", local=src, remote=bad)
        c.fail("fs.list", "E_PROTOCOL", path="\\lab")
        c.fail("fs.mkdir", "E_PROTOCOL", path="lab\\sub")
        self.assertEqual(snapshot(board), before)

    def test_08_11_syncing_a_tree_twice_neither_nests_nor_changes_it(self):
        """PINS 08.11: the old `cp -r` nested folders on repeated syncs (`/lab/lab/...`): uploading the same tree twice leaves the
        identical device tree and manifest."""
        board, c, _ = self.connected("esp32")
        folder = self.local_dir()
        tree = {"lab/a.py": "a\n", "lab/sub/b.py": "b\n", "lab/sub/deep/c.py": "c\n", "top.py": "t\n"}
        for _round in range(2):
            for rel, text in tree.items():
                c.call("fs.put", local=self.write_local(folder, rel, text), remote="/" + rel)
            if _round == 0:
                first = snapshot(board)
                man1 = sorted((e["path"], e["type"], e["size"]) for e in c.call("fs.manifest", root="/")["entries"])
        self.assertEqual(snapshot(board), first)
        self.assertEqual(sorted((e["path"], e["type"], e["size"]) for e in c.call("fs.manifest", root="/")["entries"]), man1)
        self.assertFalse(board.exists("/lab/lab") or board.exists("/lab/sub/sub"))


class OutputClassificationRegressions(BridgeTestCase):
    def test_05_19_and_08_07_program_text_that_looks_like_an_error_is_not_an_error(self):
        """PINS 05.19, 08.7: errors are classified from the protocol (the raw-REPL error channel), never from words in the output:
        a program that PRINTS a traceback, `failed to access`, `no device found`, `could not enter raw repl` and an error
        code ends with exit "ok", an empty err stream and an idle state."""
        board, c, _ = self.connected("esp32")
        src = ("print('Traceback (most recent call last):')\n"
               "print('  File \"<stdin>\", line 1, in <module>')\n"
               "print('OSError: [Errno 13] EACCES')\n"
               "print('failed to access /dev/cu.x')\nprint('no device found')\nprint('could not enter raw repl')\n"
               "print('E_PORT_BUSY E_NO_DEVICE')\n")
        m = c.mark()
        r = c.call("run", source=src, name="words.py", _timeout=30)
        self.assertEqual(r["exit"], "ok", r)
        out = c.wait_out(b"E_PORT_BUSY E_NO_DEVICE", 5, since=m)
        self.assertIn(b"Traceback (most recent call last):", out)
        self.assertEqual(c.err_bytes(m), b"")
        self.assertEqual(c.states(m)[-1], "idle")
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")

    def test_08_01_unknown_operations_are_errors_not_silent_successes(self):
        """PINS 08.1, D-03, D-11: mpremote 1.29 silently accepts unknown `fs` subcommands with exit 0; the bridge answers every unknown
        op with an error object (E_UNSUPPORTED), and `connect auto` is never accepted."""
        c = self.new_bridge()
        for op in ("fs.run", "fs.cp", "fs.tree", "fs.ls", "fs.sha256sum", "mpremote", "fs.stat.", "reset", "reset.machine_x", "FS.LIST"):
            err = c.fail(op, ("E_UNSUPPORTED", "E_PROTOCOL"))
            self.assertTrue(err["message"] and err["hint"], op)
        c.fail("connect", ("E_SAFE_MODE", "E_PROTOCOL", "E_UNSUPPORTED"), port="auto")
        c.ping()

    def test_08_08_all_streamed_output_precedes_the_run_response(self):
        """PINS 08.8: no reordering: every `out` / `err` event of a run is on the wire BEFORE the run response, in program order,
        so a client that finishes on the response never loses or misorders text."""
        board, c, _ = self.connected("esp32")
        src = "for i in range(300):\n    print('line', i)\nraise ValueError('last')\n"
        m = c.mark()
        rid = c.send("run", source=src, name="order.py")
        r = c.result(rid, 30)
        self.assertEqual(r["exit"], "exception")
        out_events = c.events_of("out", m)
        err_events = c.events_of("err", m)
        self.assertTrue(out_events and err_events)
        self.assertTrue(all(e["_n"] < r["_n"] for e in out_events + err_events), "output events after the response")
        expect = b"".join(b"line %d\r\n" % i for i in range(300))
        self.assertEqual(c.out_bytes(m), expect)
        self.assertIn(b"ValueError: last", c.err_bytes(m))


if __name__ == "__main__":
    unittest.main()
