"""Review round 2, focus "portability-and-student-path" (Windows facts by injection, first-time student session).

Never opens a serial port: fake boards over socket://127.0.0.1, a pty the test creates (registered through
MPY_HARNESS_PTYS), subprocesses with MPY_SAFE_MODE forced on.  Tests that reproduced defects
when written (findings 17-22 of round 2) are fixed and stay as regression tests; a name with FAILS in it means open.
Set REVIEW2_OUT=<file> to dump every student-visible error object collected by StudentErrorTests as JSON.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest

from tests.bridge_client import BridgeCallError, BridgeClient, BridgeTestCase, BRIDGE_PATH, ROOT, run_cli
from tests.support import TimedTestCase, child_env, wait_until

_DUMP = {}


def tearDownModule():
    out = os.environ.get("REVIEW2_OUT")
    if out and _DUMP:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(_DUMP, f, indent=1, ensure_ascii=False, sort_keys=True)


def _rm(path):
    """rmtree that first makes everything writable again (some tests chmod a copy of the tree read-only)."""
    for dirpath, dirnames, filenames in os.walk(path):
        try:
            os.chmod(dirpath, 0o700)
        except OSError:
            pass
    shutil.rmtree(path, ignore_errors=True)


class RawBridge(object):
    """A bridge process driven with raw bytes (no BridgeClient), so the exact argv, framing and bytes are ours."""

    def __init__(self, argv, cwd, env=None):
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     cwd=cwd, env=env or child_env(), shell=False)
        self.stderr = []
        self._t = threading.Thread(target=self._drain, daemon=True)
        self._t.start()
        self._id = 0

    def _drain(self):
        for line in iter(self.proc.stderr.readline, b""):
            self.stderr.append(line)

    def readline(self):
        return self.proc.stdout.readline()

    def rpc(self, op, **args):
        self._id += 1
        msg = dict(args, id=self._id, op=op)
        self.proc.stdin.write(json.dumps(msg).encode("utf-8") + b"\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise AssertionError("bridge ended; stderr: %r" % (b"".join(self.stderr)[-800:],))
            obj = json.loads(line.decode("utf-8"))
            if obj.get("id") == self._id and "ev" not in obj:
                return obj

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            rc = self.proc.wait(15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            rc = self.proc.wait(5)
        for pipe in (self.proc.stdout, self.proc.stderr):
            try:
                pipe.close()
            except OSError:
                pass
        self._t.join(3)
        return rc


# ------------------------------------------------------------------------------------------------ (a) Windows facts

class HostileInstallPathTests(BridgeTestCase):
    """The extension folder can sit under a path with spaces, parentheses and non-ASCII (a user name such as Jose with an
    accent on Windows) and can be read-only (Program Files, a shared lab image).  The bridge must start with the exact
    argv of protocol section 1 (-I -u -X utf8 -X pycache_prefix=<dir>, NO -B) and must not write into its own tree."""

    DEADLINE_S = 90
    EXT_NAME = "Ext (Jos\u00e9) \u65e5\u672c & Co"

    def _copy(self):
        base = tempfile.mkdtemp(prefix="mpy-rev2-inst-")
        self.addCleanup(_rm, base)
        ext = os.path.join(base, self.EXT_NAME)
        shutil.copytree(os.path.join(ROOT, "bridge"), os.path.join(ext, "bridge"),
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        return base, ext

    def _session(self, ext, prefix):
        board = self.new_board()
        neutral = tempfile.mkdtemp(prefix="mpy-rev2-cwd-")
        self.addCleanup(_rm, neutral)
        argv = [sys.executable, "-I", "-u", "-X", "utf8", "-X", "pycache_prefix=" + prefix,
                os.path.join(ext, "bridge", "mpy_bridge.py")]
        b = RawBridge(argv, neutral)
        self.addCleanup(b.close)
        self.addWatchdogCleanup(b.proc.kill)
        hello = json.loads(b.readline().decode("utf-8"))
        self.assertEqual(hello.get("ev"), "hello", hello)
        self.assertEqual(hello["pyserial"], "3.5")
        local = os.path.join(neutral, "Lab 1 (x) \u00fcber.py")
        with open(local, "wb") as f:
            f.write(b"print('hi')\n")
        self.assertTrue(b.rpc("connect", port=board.url)["ok"])
        r = b.rpc("fs.put", local=local, remote="/lab.py")
        self.assertTrue(r["ok"], r)
        r = b.rpc("fs.list", path="/")
        self.assertTrue(r["ok"] and any(e["name"] == "lab.py" for e in r["entries"]), r)
        self.assertEqual(b.close(), 0, b"".join(b.stderr)[-500:])

    def _pycaches(self, tree):
        return [d for d, names, _f in os.walk(tree) if os.path.basename(d) == "__pycache__"]

    def test_unwritable_and_missing_pycache_prefix_is_harmless(self):
        base, ext = self._copy()
        ro = os.path.join(base, "ro parent")
        os.mkdir(ro)
        os.chmod(ro, 0o500)
        self._session(ext, os.path.join(ro, "does not", "exist"))
        self.assertEqual(self._pycaches(ext), [])

    def test_read_only_install_tree_does_not_get_pycache_when_prefix_is_given(self):
        base, ext = self._copy()
        prefix = os.path.join(base, "pyc cache (\u00e9)")
        for dirpath, dirnames, filenames in os.walk(ext):
            for n in dirnames + filenames:
                p = os.path.join(dirpath, n)
                os.chmod(p, os.stat(p).st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
        os.chmod(ext, 0o500)
        self._session(ext, prefix)
        self.assertEqual(self._pycaches(ext), [])
        written = [f for _d, _n, files in os.walk(prefix) for f in files if f.endswith(".pyc")]
        self.assertTrue(written, "pycache_prefix was ignored: nothing was cached under %s" % prefix)


class ProtocolFramingTests(TimedTestCase):
    """Newline translation on the protocol channel (a Windows pipe may deliver CRLF; stdout must stay LF)."""

    DEADLINE_S = 60

    def test_crlf_requests_and_lf_only_responses_and_unterminated_last_line(self):
        neutral = tempfile.mkdtemp(prefix="mpy-rev2-cwd-")
        self.addCleanup(_rm, neutral)
        b = RawBridge([sys.executable, "-I", "-B", "-u", "-X", "utf8", BRIDGE_PATH], neutral)
        self.addCleanup(b.close)
        self.addWatchdogCleanup(b.proc.kill)
        lines = [b.readline()]
        b.proc.stdin.write(b'{"id":1,"op":"ping"}\r\n{"id":2,"op":"ping"}\r\n\r\n{"id":3,"op":"ping"}')
        b.proc.stdin.flush()
        b.proc.stdin.close()
        lines += [ln for ln in iter(b.readline, b"")]
        for ln in lines:
            self.assertTrue(ln.endswith(b"\n") and not ln.endswith(b"\r\n"), ln)
        ids = [o.get("id") for o in (json.loads(ln.decode("utf-8")) for ln in lines[1:]) if "ev" not in o]
        self.assertEqual(ids, [1, 2, 3], lines)


class CliEncodingTests(TimedTestCase):
    """CLI mode (protocol section 10) is started by a person, WITHOUT -X utf8.  On Windows a piped stdout is cp1252/cp936."""

    DEADLINE_S = 60

    def _cli(self, args, env_extra=None, flags=()):
        neutral = tempfile.mkdtemp(prefix="mpy-rev2-cwd-")
        self.addCleanup(_rm, neutral)
        env = child_env(**(env_extra or {}))
        for k in ("PYTHONUTF8", "PYTHONIOENCODING"):
            env.pop(k, None)
        env.update(env_extra or {})
        r = subprocess.run([sys.executable, "-B"] + list(flags) + [BRIDGE_PATH] + list(args), stdin=subprocess.DEVNULL,
                           capture_output=True, cwd=neutral, env=env, timeout=40, shell=False)
        return r.returncode, r.stdout, r.stderr.decode("utf-8", "replace")

    def test_cli_crashes_when_a_response_has_text_the_console_codepage_cannot_encode(self):
        rc, out, err = self._cli(["--cli", "run", "local=/no/such/folder/\u65e5\u672c\u8a9e.py"],
                                 env_extra={"PYTHONIOENCODING": "cp1252"}, flags=["-X", "utf8=0"])
        self.assertNotIn("Traceback", err)
        self.assertEqual(rc, 1, err[-400:])
        self.assertEqual(json.loads(out.decode("cp1252"))["error"]["code"], "E_LOCAL_IO")

    def test_cli_script_with_crlf_lines(self):
        base = tempfile.mkdtemp(prefix="mpy-rev2-script-")
        self.addCleanup(_rm, base)
        path = os.path.join(base, "s.jsonl")
        with open(path, "wb") as f:
            f.write(b'# comment\r\n{"op":"ping"}\r\n{"op":"ping"}\r\n')
        rc, out, err = self._cli(["--script", path], flags=["-X", "utf8"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(out.decode("utf-8").strip().splitlines()), 2)

    def test_cli_script_saved_with_a_utf8_bom(self):
        """Windows Notepad and PowerShell's Out-File write a BOM; the instructor's --script file must still run."""
        base = tempfile.mkdtemp(prefix="mpy-rev2-script-")
        self.addCleanup(_rm, base)
        path = os.path.join(base, "s.jsonl")
        with open(path, "wb") as f:
            f.write(b'\xef\xbb\xbf{"op":"ping"}\r\n')
        rc, out, err = self._cli(["--script", path], flags=["-X", "utf8"])
        self.assertEqual(rc, 0, err)


class HostileLocalPathTests(BridgeTestCase):
    """Local paths: OneDrive-style folder, spaces, parentheses, non-ASCII, quotes, Windows-looking names, CRLF sources."""

    DEADLINE_S = 120
    NAMES = ["Lab 1 (copy) #2 @home \u2013 \u00fcber \u65e5\u672c\u8a9e.py", "it's \"quoted\".py", "100% $HOME `x`;&|.py",
             "back\\slash\\t\\n.py"]

    def test_put_get_replace_and_run_round_trip_with_hostile_names(self):
        board, c, _ = self.connected()
        src = self.local_dir()
        out = os.path.join(self.local_dir(course=False), "Out dir (2)", "\u00fcn\u00efc\u00f6d\u00e9")
        for i, name in enumerate(self.NAMES):
            body = ("# %s\nprint('caf\u00e9 \u65e5\u672c')\n" % i).encode("utf-8")
            local = self.write_local(src, name, body)
            remote = "/f%d.py" % i
            self.assertTrue(c.call("fs.put", local=local, remote=remote)["bytes"] == len(body))
            dest = os.path.join(out, name)
            self.assertEqual(c.call("fs.get", remote=remote, local=dest)["bytes"], len(body))
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), body)
            board.write_file(remote, body + b"# changed\n")
            c.call("fs.get", remote=remote, local=dest)  # rename over an existing file on the host
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), body + b"# changed\n")
            m = c.mark()
            r = c.call("run", local=local)
            self.assertEqual(r["exit"], "ok", (name, r))
            self.assertIn("caf\u00e9 \u65e5\u672c".encode("utf-8"), c.out_bytes(since=m))
        self.assertEqual([n for n in os.listdir(out) if n.endswith(".mpytmp")], [])

    def test_windows_looking_name_and_crlf_source_in_a_traceback(self):
        board, c, _ = self.connected()
        name = "C:\\Users\\Jos\u00e9\\OneDrive - WSU (email.wsu.edu)\\ME 241 (Fall)\\Lab 1\\new\\t.py"
        m = c.mark()
        r = c.call("run", source="x = 1\r\nraise ValueError('boom')\r\n", name=name)
        self.assertEqual(r["exit"], "exception", r)
        err = c.err_bytes(since=m).decode("utf-8", "replace")
        self.assertIn(name, err)
        self.assertIn("line 2", err)

    def test_relative_local_path_is_silently_written_into_the_bridge_cwd(self):
        """Protocol section 2: local paths are absolute.  The bridge's cwd is a neutral temp folder, so a relative path
        puts the student's file somewhere nobody will look, and reports success."""
        cwd = self.local_dir(course=False)
        board, c, _ = self.connected(cwd=cwd)
        board.write_file("/a.txt", b"data")
        r = c.request("fs.get", remote="/a.txt", local="rel/a.txt")
        self.assertFalse(os.path.exists(os.path.join(cwd, "rel", "a.txt")), "file written under the neutral cwd")
        self.assertFalse(r["ok"], r)
        self.assertEqual(r["error"]["code"], "E_PROTOCOL")

    def test_get_of_a_board_file_whose_local_name_is_250_characters(self):
        """The host temp name is local + '.mpytmp' (+7), so a 249..255 character basename fails with ENAMETOOLONG although
        the final name is legal; the board-side temp name is shortened for exactly this case (Appendix A.4)."""
        board, c, _ = self.connected()
        name = "n" * 250
        board.write_file("/" + name, b"x")
        dest = os.path.join(self.local_dir(course=False), name)
        r = c.request("fs.get", remote="/" + name, local=dest)
        self.assertTrue(r["ok"], r)


# ------------------------------------------------------------------------------------------------ (b) student path

def _lint(err, code):
    problems = []
    if err.get("code") != code:
        problems.append("code %r != %r" % (err.get("code"), code))
    msg, hint = err.get("message") or "", err.get("hint") or ""
    if not msg or not hint:
        problems.append("message or hint empty")
    for bad in ("Traceback", "[Errno", "<class", "None", "b'", "OSError(", "Exception"):
        if bad in msg or bad in hint:
            problems.append("jargon %r in message/hint" % bad)
    if not (msg[:1].isupper() or msg[:1] == "/" or msg[:3] == "COM"):
        problems.append("message does not start like a sentence")
    return problems


class StudentErrorTests(BridgeTestCase):
    """Every error a student can reach through the bridge: English, classified, with a next step."""

    DEADLINE_S = 120

    def _check(self, key, err, code):
        _DUMP[key] = err
        self.assertEqual(_lint(err, code), [], err)

    def test_busy_port_held_by_another_process(self):
        master, slave = os.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        name = os.ttyname(slave)
        holder = self.new_bridge(harness_ptys=[name])
        holder.call("connect", port=name)
        rc, resp, stderr = run_cli("fs.list", "path=/", "--port", name, env_extra={"MPY_HARNESS_PTYS": name})
        self.assertEqual(rc, 1, (resp, stderr[-300:]))
        self._check("E_PORT_BUSY (second process, pty)", resp["error"], "E_PORT_BUSY")
        self.assertIn("Retry", resp["error"]["hint"])

    def test_port_that_disappeared_before_connect(self):
        """The settings still name the port, the cable was pulled yesterday (a pty our own code created, then closed)."""
        master, slave = os.openpty()
        name = os.ttyname(slave)
        os.close(slave)
        os.close(master)
        self.assertFalse(os.path.exists(name), name)
        rc, resp, stderr = run_cli("fs.list", "path=/", "--port", name, env_extra={"MPY_HARNESS_PTYS": name})
        self.assertEqual(rc, 1, (resp, stderr[-300:]))
        self._check("E_NO_DEVICE (device path that no longer exists)", resp["error"], "E_NO_DEVICE")
        self.assertIn(name, resp["error"]["message"])

    def test_board_not_plugged_in_at_connect(self):
        board = self.new_board()
        url = board.url
        board.stop()
        rc, resp, stderr = run_cli("fs.list", "path=/", "--port", url)
        self.assertEqual(rc, 1, (resp, stderr[-300:]))
        self._check("E_NO_DEVICE (connect to a port nobody listens on)", resp["error"], "E_NO_DEVICE")

    def test_board_unplugged_in_the_middle_of_a_session(self):
        board, c, _ = self.connected()
        m = c.mark()
        board.unplug()
        ev = c.wait_event("state", lambda e: e["state"] == "disconnected", timeout=10, since=m)
        self.assertEqual(ev.get("reason"), "unplugged", ev)
        err = c.fail("fs.list", path="/")
        self._check("E_NO_DEVICE (op after unplug)", err, "E_NO_DEVICE")
        err = c.fail("run", source="print(1)")
        self.assertIn(err["code"], ("E_NO_DEVICE", "E_NOT_CONNECTED"), err)
        self._check("%s (run after unplug)" % err["code"], err, err["code"])

    def test_program_running_blocks_file_ops_with_an_explanation(self):
        board = self.new_board(faults=["main_forever"])
        c = self.new_bridge()
        r = c.call("connect", port=board.url)
        self.assertEqual(r["state"], "running", r)
        err = c.fail("fs.list", path="/")
        self._check("E_PROGRAM_RUNNING", err, "E_PROGRAM_RUNNING")
        self.assertEqual(board.events.count("soft_reset"), 0)

    def test_student_hint_for_a_running_program_is_protocol_syntax(self):
        """The student never types JSON; a toast that says 'repeat the request with interrupt:true' is not actionable."""
        board = self.new_board(faults=["main_forever"])
        c = self.new_bridge()
        c.call("connect", port=board.url)
        err = c.fail("fs.list", path="/")
        self.assertNotIn("interrupt:true", err["hint"])

    def test_no_raw_repl_because_a_program_ignores_ctrl_c(self):
        board = self.new_board(faults=["main_forever", "ignore_ctrl_c"])
        c = self.new_bridge()
        c.call("connect", port=board.url)
        err = c.fail("fs.list", path="/", interrupt=True, _timeout=40)
        self.assertIn(err["code"], ("E_RAW_REPL_TIMEOUT", "E_BOARD_UNRESPONSIVE"), err)
        self._check("%s (program ignores Ctrl-C)" % err["code"], err, err["code"])
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_not_connected_and_already_connected(self):
        board = self.new_board()
        c = self.new_bridge()
        self._check("E_NOT_CONNECTED", c.fail("fs.list", path="/"), "E_NOT_CONNECTED")
        c.call("connect", port=board.url)
        self._check("E_ALREADY_CONNECTED", c.fail("connect", port=board.url), "E_ALREADY_CONNECTED")

    def test_file_and_local_errors(self):
        board, c, _ = self.connected()
        src = self.local_dir()
        self._check("E_LOCAL_IO (put of a missing file)", c.fail("fs.put", local=os.path.join(src, "nope.py"), remote="/nope.py"), "E_LOCAL_IO")
        self._check("E_FS_ERRNO (get of a missing board file)", c.fail("fs.get", remote="/nope.py", local=os.path.join(src, "x.py")), "E_FS_ERRNO")
        c.call("config", shadowGuard=["shield"])
        local = self.write_local(src, "shield.py", "x = 1\n")
        self._check("E_SHADOWS_MODULE", c.fail("fs.put", local=local, remote="/shield.py"), "E_SHADOWS_MODULE")

    def test_board_full_and_read_only(self):
        for fault, key in (("disk_full", "disk full"), ("readonly_fs", "read-only board")):
            board = self.new_board(faults=[fault])
            c = self.new_bridge()
            c.call("connect", port=board.url)
            src = self.local_dir()
            local = self.write_local(src, "big.py", "x = 1\n" * 5000)
            err = c.fail("fs.put", local=local, remote="/big.py")
            self.assertEqual(err["code"], "E_FS_ERRNO", err)
            self._check("E_FS_ERRNO (%s)" % key, err, "E_FS_ERRNO")

    def test_safe_mode_message_names_the_variable_and_the_way_out(self):
        c = self.new_bridge()
        err = c.fail("connect", port="COM3")
        self._check("E_SAFE_MODE", err, "E_SAFE_MODE")
        self.assertIn("MPY_SAFE_MODE", err["message"] + err["hint"])


class StudentWrongPortAndReplugTests(BridgeTestCase):
    """The two commonest first-week accidents: the wrong COM port (nothing answers) and replugging the cable."""

    DEADLINE_S = 120

    def test_silent_port_is_not_reported_as_a_running_program(self):
        """A port that never answers (wrong port, not MicroPython) is mapped to internal state `running`, so the first
        file operation tells the student 'A program is running on the board.'  The student then looks for a program."""
        board = self.new_board(faults=["silent"])
        c = self.new_bridge()
        r = c.call("connect", port=board.url, _timeout=30)
        self.assertEqual(r["sync"], "silent", r)
        err = c.fail("fs.list", path="/", _timeout=30)
        _DUMP["silent port, first file op"] = err
        self.assertNotIn("program is running", err["message"].lower(), err)

    def test_connect_again_after_an_unplug_needs_no_disconnect_first(self):
        board, c, _ = self.connected()
        m = c.mark()
        board.unplug()
        c.wait_event("state", lambda e: e["state"] == "disconnected", timeout=10, since=m)
        wait_until(lambda: board.connected == 0, 5.0, "the fake board to notice the closed socket")
        r = self.reconnect(c, board)
        self.assertTrue(r["ok"], r)
        self.assertTrue(c.call("fs.list", path="/")["entries"] is not None)


class IsolatedModeTests(TimedTestCase):
    """`python -I` must make the PYTHON* variables and a hostile working folder irrelevant (D-13, CLAUDE.md rule 4)."""

    DEADLINE_S = 60

    def test_poisoned_environment_and_cwd_do_not_reach_the_bridge(self):
        poison = tempfile.mkdtemp(prefix="mpy-rev2-poison-")
        self.addCleanup(_rm, poison)
        for name in ("json.py", "serial.py", "usercustomize.py", "startup.py"):
            with open(os.path.join(poison, name), "w", encoding="utf-8") as f:
                f.write("raise SystemExit('poisoned %s was imported')\n" % name)
        env = child_env(PYTHONPATH=poison, PYTHONSTARTUP=os.path.join(poison, "startup.py"), PYTHONWARNINGS="error",
                        PYTHONIOENCODING="ascii", PYTHONHOME=os.path.join(poison, "nohome"), PYTHONUTF8="0")
        b = RawBridge([sys.executable, "-I", "-B", "-u", "-X", "utf8", BRIDGE_PATH], poison, env)
        self.addCleanup(b.close)
        self.addWatchdogCleanup(b.proc.kill)
        hello = json.loads(b.readline().decode("utf-8"))
        self.assertEqual(hello.get("ev"), "hello", (hello, b"".join(b.stderr)[-300:]))
        self.assertTrue(b.rpc("ping")["ok"])
        self.assertEqual(b.close(), 0)


class StudentSessionTests(BridgeTestCase):
    """list ports, connect, identity, put main.py, run, stop, disconnect: the first lab, through the CLI."""

    DEADLINE_S = 120

    def _script(self, lines):
        base = tempfile.mkdtemp(prefix="mpy-rev2-student-")
        self.addCleanup(_rm, base)
        path = os.path.join(base, "session.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n")
        return path

    def _run_script(self, path):
        neutral = tempfile.mkdtemp(prefix="mpy-rev2-cwd-")
        self.addCleanup(_rm, neutral)
        r = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", BRIDGE_PATH, "--script", path],
                           stdin=subprocess.DEVNULL, capture_output=True, cwd=neutral, env=child_env(), timeout=60, shell=False)
        out = [json.loads(ln) for ln in r.stdout.decode("utf-8").splitlines() if ln.strip().startswith("{")]
        return r.returncode, out, r.stderr.decode("utf-8", "replace")

    def test_first_lab_session(self):
        rc, resp, _err = run_cli("ports.list")
        self.assertEqual(rc, 0)
        self.assertTrue(resp["ok"] and isinstance(resp["ports"], list))
        board = self.new_board()
        folder = self.local_dir()
        main = self.write_local(folder, "main.py", "print('hello student')\nprint(sum(range(10)))\n")
        copy = os.path.join(folder, "copy of main.py")
        script = self._script([
            {"op": "connect", "port": board.url}, {"op": "identity"},
            {"op": "fs.put", "local": main, "remote": "/main.py"}, {"op": "fs.list", "path": "/"},
            {"op": "run", "local": main}, {"op": "fs.get", "remote": "/main.py", "local": copy}, {"op": "disconnect"}])
        rc, out, err = self._run_script(script)
        self.assertEqual(rc, 0, (out, err[-600:]))
        self.assertEqual([bool(r.get("ok")) for r in out], [True] * 7, out)
        self.assertEqual(out[0]["state"], "idle")
        self.assertEqual(out[1]["impl"], "micropython")
        self.assertIn("hello student", err)
        self.assertEqual(out[4]["exit"], "ok")
        with open(copy, "rb") as f:
            self.assertEqual(f.read(), b"print('hello student')\nprint(sum(range(10)))\n")
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("soft_reset"), 1, "only Run may reset the board (RQ-SAFE-1)")

    def test_stop_from_a_second_cli_call_reaches_a_program_started_by_main_py(self):
        board = self.new_board(faults=["main_forever"])
        rc, resp, err = run_cli("stop", "--port", board.url)
        self.assertEqual(rc, 0, (resp, err[-300:]))
        self.assertTrue(resp["stopped"], resp)
        self.assertEqual(board.events.count("soft_reset") + board.events.count("hard_reset"), 0)
        rc, resp, err = run_cli("fs.list", "path=/", "--port", board.url)
        self.assertEqual(rc, 0, (resp, err[-300:]))


if __name__ == "__main__":
    unittest.main()
