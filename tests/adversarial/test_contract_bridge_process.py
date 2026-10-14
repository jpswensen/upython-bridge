"""Executable spec for bridge/mpy_bridge.py (docs/protocol.md sections 1-6, 8; RQ-SAFE-1/2/3/4, RQ-ID-1, RQ-RUN-1/2,
R-ARCH-3/5, Appendix G #1, #2, #8, #10, #16, #18).

The review found NO bridge/mpy_bridge.py: only Link/devfs/errors exist. Every test here fails today with
"bridge/mpy_bridge.py does not exist". They are written against the protocol text only, so a different but
conforming implementation passes.

Safety: the bridge is always started with MPY_SAFE_MODE=1 and MPY_REAL_PORT removed. It is only ever pointed at
socket://127.0.0.1:PORT fake boards, or (for the refusal tests) at device names that cannot exist on any machine.

    export MPY_SAFE_MODE=1
    python3 -B -m unittest tests.adversarial.test_contract_bridge_process -v
"""
from __future__ import annotations

import base64
import json
import os
import queue
import shutil
import subprocess
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

from tools.fakeboard import FakeBoard, PROGRAMS  # noqa: E402

BRIDGE = os.path.join(ROOT, "bridge", "mpy_bridge.py")
NOWHERE = "/dev/cu.mpy-review-nonexistent-9"      # cannot exist; safe mode must refuse it before any OS call


class BridgeProc(object):
    """Runs the bridge as the extension would (protocol section 1) and speaks NDJSON to it."""

    def __init__(self, cwd=None, extra_env=None):
        if not os.path.isfile(BRIDGE):
            raise AssertionError("bridge/mpy_bridge.py does not exist (protocol section 1)")
        env = dict(os.environ, MPY_SAFE_MODE="1", PYTHONDONTWRITEBYTECODE="1")
        env.pop("MPY_REAL_PORT", None)
        env.update(extra_env or {})
        self._own_cwd = cwd is None
        self.cwd = cwd or tempfile.mkdtemp(prefix="bridge-cwd-")
        self.proc = subprocess.Popen(
            [sys.executable, "-I", "-B", "-u", "-X", "utf8", BRIDGE],      # -I ignores PYTHON* env: -B/-X must be flags
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self.cwd, env=env)
        self.q = queue.Queue()
        self.stderr_lines = []
        self.events = []
        self._next_id = 1
        self._pumps = [threading.Thread(target=self._pump_out, daemon=True), threading.Thread(target=self._pump_err, daemon=True)]
        for t in self._pumps:
            t.start()

    def _pump_out(self):
        for raw in self.proc.stdout:
            self.q.put(raw)
        self.q.put(None)

    def _pump_err(self):
        for raw in self.proc.stderr:
            self.stderr_lines.append(raw.decode("utf-8", "replace"))

    def read_line(self, timeout=5.0):
        try:
            raw = self.q.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError("no line from the bridge within %.1fs; stderr=%r" % (timeout, self.stderr_lines[-5:]))
        if raw is None:
            raise AssertionError("bridge closed stdout; rc=%r stderr=%r" % (self.proc.poll(), self.stderr_lines[-5:]))
        return json.loads(raw.decode("utf-8"))      # every stdout line must be one JSON object (section 2)

    def send(self, op, **args):
        rid = self._next_id
        self._next_id += 1
        msg = dict(args, id=rid, op=op)
        self.proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        return rid

    def wait_response(self, rid, timeout=10.0):
        deadline = time.monotonic() + timeout
        while True:
            msg = self.read_line(max(0.05, deadline - time.monotonic()))
            if "ev" in msg:
                self.events.append(msg)
                continue
            if msg.get("id") == rid:
                return msg

    def call(self, op, timeout=10.0, **args):
        return self.wait_response(self.send(op, **args), timeout)

    def drain_events(self, wait=0.2):
        end = time.monotonic() + wait
        while time.monotonic() < end:
            try:
                raw = self.q.get(timeout=0.05)
            except queue.Empty:
                continue
            if raw is None:
                break
            msg = json.loads(raw.decode("utf-8"))
            if "ev" in msg:
                self.events.append(msg)
        return list(self.events)

    def out_bytes(self):
        return b"".join(base64.b64decode(e["b64"]) for e in self.events if e.get("ev") == "out")

    def err_bytes(self):
        return b"".join(base64.b64decode(e["b64"]) for e in self.events if e.get("ev") == "err")

    def close(self, timeout=6.0):
        """stdin EOF = quit (section 1). Returns the exit code; kills the process if it does not quit."""
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            return self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(5)
            raise AssertionError("bridge did not exit within %.1fs of stdin EOF" % timeout)

    def kill(self):
        """Test cleanup (idempotent): end the process, let the reader threads see EOF, close the pipes, drop the private cwd."""
        if self.proc.poll() is None:
            self.proc.kill()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            pass
        for t in self._pumps:
            t.join(2.0)
        for pipe in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                pipe.close()
            except (OSError, ValueError):
                pass
        if self._own_cwd:
            shutil.rmtree(self.cwd, ignore_errors=True)


class BridgeTestCase(unittest.TestCase):
    def start(self, **kw):
        b = BridgeProc(**kw)
        self.addCleanup(b.kill)
        return b

    def board(self, **kw):
        fb = FakeBoard(**kw)
        fb.start()
        self.addCleanup(fb.stop)
        return fb

    def connect(self, b, fb, **args):
        r = b.call("connect", port=fb.url, **args)
        self.assertTrue(r.get("ok"), r)
        return r


class ProcessModelTests(BridgeTestCase):
    def test_hello_is_the_first_line_and_stdin_eof_exits_zero(self):
        b = self.start()
        hello = b.read_line()
        self.assertEqual(hello.get("ev"), "hello")
        self.assertEqual(hello.get("proto"), 1)
        for key in ("bridge", "python", "pyserial", "platform", "pid", "vendored"):
            self.assertIn(key, hello)
        self.assertEqual(hello["pyserial"], "3.5")
        self.assertIn(hello["platform"], ("darwin", "win32", "linux"))
        self.assertEqual(hello["pid"], b.proc.pid)
        self.assertEqual(b.close(), 0)

    def test_hostile_files_in_the_working_directory_cannot_hijack_imports(self):
        cwd = tempfile.mkdtemp(prefix="hostile-cwd-")
        for name in ("serial.py", "platformdirs.py", "time.py", "json.py", "errors.py"):
            with open(os.path.join(cwd, name), "w", encoding="utf-8") as f:
                f.write("raise RuntimeError('student file %s was imported')\n" % name)
        b = self.start(cwd=cwd)
        self.assertEqual(b.read_line().get("ev"), "hello")
        self.assertTrue(b.call("ping").get("ok"))
        self.assertEqual(b.close(), 0)

    def test_ping_unknown_op_and_garbage_never_crash_the_bridge(self):
        b = self.start()
        b.read_line()
        self.assertEqual(b.call("ping"), {"id": 1, "ok": True})
        r = b.call("no.such.op")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "E_UNSUPPORTED")
        for key in ("code", "message", "detail", "hint"):
            self.assertIn(key, r["error"])
        b.proc.stdin.write(b"this is not json\n")
        b.proc.stdin.write(json.dumps({"id": 77, "op": 5}).encode() + b"\n")
        b.proc.stdin.flush()
        bad = [b.read_line(), b.read_line()]
        self.assertTrue(all(m.get("ok") is False and m["error"]["code"] == "E_PROTOCOL" for m in bad), bad)
        self.assertTrue(b.call("ping").get("ok"))
        self.assertEqual(b.close(), 0)

    def test_stdout_carries_only_json_lines_even_when_a_library_prints(self):
        # fd 1 must be redirected to stderr after the protocol fd is duplicated (section 1)
        b = self.start()
        b.read_line()
        r = b.call("ports.list")
        self.assertTrue(r["ok"])
        self.assertIsInstance(r["ports"], list)
        for p in r["ports"]:
            self.assertIn("device", p)
            self.assertFalse(p["device"].startswith("/dev/tty.") and sys.platform == "darwin", p)
        self.assertEqual(b.close(), 0)


class SafeModeProtocolTests(BridgeTestCase):
    def test_connect_to_anything_but_a_test_target_is_refused_before_any_os_call(self):
        b = self.start()
        b.read_line()
        for port in (NOWHERE, "COM98", "auto", "hwgrep://10C4:EA60"):
            r = b.call("connect", port=port)
            self.assertFalse(r["ok"], port)
            self.assertEqual(r["error"]["code"], "E_SAFE_MODE", (port, r))
        r = b.call("connect", port=NOWHERE)           # still not connected, state unchanged
        self.assertEqual(r["error"]["code"], "E_SAFE_MODE")
        self.assertEqual(b.close(), 0)

    def test_MPY_REAL_PORT_never_accepts_auto(self):
        b = self.start(extra_env={"MPY_REAL_PORT": "auto"})
        b.read_line()
        self.assertEqual(b.call("connect", port="auto")["error"]["code"], "E_SAFE_MODE")
        b.close()


class ResetPolicyTests(BridgeTestCase):
    def test_hard_reset_needs_confirmed_and_a_safe_pulse_and_stop_never_resets(self):
        fb = self.board(profile="esp32")
        b = self.start()
        b.read_line()
        self.connect(b, fb)
        r = b.call("reset.hard")
        self.assertFalse(r["ok"])
        self.assertIn(r["error"]["code"], ("E_PROTOCOL", "E_UNSUPPORTED"))
        r = b.call("reset.hard", confirmed=True)       # socket:// has no modem lines
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "E_UNSUPPORTED")
        self.assertTrue(b.call("stop")["ok"])
        self.assertEqual(fb.events.count("hard_reset"), 0)
        self.assertEqual(fb.events.count("soft_reset"), 0)
        self.assertEqual(b.close(), 0)

    def test_rmtree_without_confirm_is_a_protocol_error_and_deletes_nothing(self):
        fb = self.board(profile="esp32")
        fb.write_file("/lib/keep.py", "x = 1\n")
        b = self.start()
        b.read_line()
        self.connect(b, fb)
        r = b.call("fs.rmtree", path="/lib")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "E_PROTOCOL")
        self.assertTrue(fb.exists("/lib/keep.py"))
        r = b.call("fs.rmtree", path="/", confirm=True)
        self.assertFalse(r["ok"])
        b.close()


class SessionTests(BridgeTestCase):
    def test_a_twenty_operation_session_opens_the_port_once_and_never_resets(self):
        """Appendix G #1, RQ-SAFE-1."""
        fb = self.board(profile="esp32")
        b = self.start()
        b.read_line()
        r = self.connect(b, fb)
        self.assertIn(r["state"], ("idle", "running", "unknown"))
        self.assertEqual(r["state"], "idle")
        self.assertIn(r["sync"], ("prompt", "running-program", "silent"))
        src = os.path.join(tempfile.mkdtemp(prefix="OneDrive-Washington State University(email.wsu.edu) "), "é @ (1).py")
        with open(src, "w", encoding="utf-8") as f:
            f.write("print('hi')\n")
        back = src + ".back"
        steps = [
            ("identity", {}), ("fs.mkdir", {"path": "/lab/a"}), ("fs.put", {"local": src, "remote": "/lab/a/é @ (1).py"}),
            ("fs.list", {"path": "/lab/a"}), ("fs.stat", {"path": "/lab/a/é @ (1).py"}),
            ("fs.manifest", {"root": "/lab"}), ("fs.get", {"remote": "/lab/a/é @ (1).py", "local": back}),
            ("fs.mv", {"src": "/lab/a/é @ (1).py", "dst": "/lab/b.py"}), ("fs.rm", {"path": "/lab/b.py"}),
            ("fs.rmtree", {"path": "/lab", "confirm": True}),
        ] * 2
        for op, args in steps:
            r = b.call(op, **args)
            if op in ("fs.mkdir", "fs.put", "fs.mv", "fs.rm", "fs.rmtree") and not r["ok"]:
                self.fail((op, r))
        r = b.call("identity")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["impl"], "micropython")
        self.assertEqual(r["caps"]["hash"], "sha256")
        self.assertIsInstance(r["caps"]["paste"], bool)       # protocol 3: caps.paste is a bool, not null
        self.assertTrue(b.call("disconnect")["ok"])
        self.assertEqual(fb.events.count("connect"), 1)
        self.assertEqual(fb.events.count("soft_reset"), 0)
        self.assertEqual(fb.events.count("hard_reset"), 0)
        self.assertEqual(b.close(), 0)

    def test_file_ops_and_identity_wait_for_consent_while_a_program_runs(self):
        """R-ARCH-5, RQ-ID-1: E_PROGRAM_RUNNING unless interrupt:true; identity never probes a running board."""
        fb = self.board(profile="esp32", faults=["main_forever"])
        b = self.start()
        b.read_line()
        r = self.connect(b, fb)
        self.assertEqual(r["state"], "running")
        n_exec = fb.events.count("exec")
        for op, args in (("identity", {}), ("fs.list", {"path": "/"}), ("fs.manifest", {"root": "/"})):
            r = b.call(op, **args)
            self.assertFalse(r["ok"], op)
            self.assertEqual(r["error"]["code"], "E_PROGRAM_RUNNING", op)
        self.assertEqual(fb.events.count("exec"), n_exec, "a deferred op must not touch the board")
        self.assertEqual(fb.events.count("raw_enter"), 0)
        r = b.call("fs.list", path="/", interrupt=True)
        self.assertTrue(r["ok"], r)
        self.assertEqual(fb.events.count("soft_reset"), 0)
        b.close()

    def test_unplug_emits_state_disconnected_and_later_ops_say_so(self):
        fb = self.board(profile="esp32")
        b = self.start()
        b.read_line()
        self.connect(b, fb)
        fb.unplug()
        deadline = time.monotonic() + 5
        seen = None
        while time.monotonic() < deadline and seen is None:
            for e in b.drain_events(0.2):
                if e.get("ev") == "state" and e.get("state") == "disconnected":
                    seen = e
        self.assertIsNotNone(seen, "no state:disconnected event after the board vanished")
        self.assertEqual(seen.get("reason"), "unplugged")
        r = b.call("fs.list", path="/")
        self.assertFalse(r["ok"])
        self.assertIn(r["error"]["code"], ("E_NO_DEVICE", "E_NOT_CONNECTED"))
        b.close()


class RunTests(BridgeTestCase):
    def _local(self, text):
        d = os.path.join(tempfile.mkdtemp(prefix="OneDrive-Washington State University(email.wsu.edu) "), "ME 241 (Fall)", "Lab 1")
        os.makedirs(d)
        p = os.path.join(d, "prüfung @1.py")
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        return p

    def test_run_streams_output_maps_tracebacks_to_the_local_path_and_sets_main(self):
        """D-07, RQ-RUN-2, Appendix G #8."""
        fb = self.board(profile="esp32")
        path = self._local("print(__name__)\nprint('before')\n1/0\n")
        b = self.start()
        b.read_line()
        self.connect(b, fb)
        r = b.call("run", local=path)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["exit"], "exception")
        self.assertIn("durationMs", r)
        b.drain_events(0.3)
        self.assertEqual(b.out_bytes(), b"__main__\r\nbefore\r\n")
        self.assertIn(('File "%s", line 3' % path).encode("utf-8"), b.err_bytes())
        self.assertEqual(fb.events.count("hard_reset"), 0)
        b.close()

    def test_stop_bypasses_the_queue_and_ends_a_running_program(self):
        """RQ-SAFE-3: Ctrl-C twice, reply while run is still pending, no reset."""
        fb = self.board(profile="esp32")
        b = self.start()
        b.read_line()
        self.connect(b, fb)
        run_id = b.send("run", source=PROGRAMS["sleep_loop"], name="loop.py")
        fb.events.wait_for("program_start", timeout=5)
        time.sleep(0.2)
        t0 = time.monotonic()
        stop = b.call("stop")
        self.assertTrue(stop["ok"], stop)
        self.assertTrue(stop["stopped"])
        self.assertLess(time.monotonic() - t0, 1.0)
        run = b.wait_response(run_id, 5)
        self.assertEqual(run["exit"], "interrupted", run)
        self.assertEqual(fb.events.count("hard_reset"), 0)
        b.close()

    def test_tty_write_reaches_the_programs_stdin(self):
        """RQ-RUN-1: raw keystrokes during a run."""
        fb = self.board(profile="esp32")
        b = self.start()
        b.read_line()
        self.connect(b, fb)
        run_id = b.send("run", source=PROGRAMS["echo_keys"], name="keys.py", stdin=True)
        fb.events.wait_for("program_start", timeout=5)
        time.sleep(0.3)
        for ch in (b"a", b"q"):
            self.assertTrue(b.call("tty.write", b64=base64.b64encode(ch).decode())["ok"])
        run = b.wait_response(run_id, 5)
        self.assertEqual(run["exit"], "ok", run)
        b.drain_events(0.3)
        out = b.out_bytes()
        self.assertIn(b"key:'a'", out)
        self.assertIn(b"DONE", out)
        b.close()

    def test_stdin_eof_while_a_program_runs_interrupts_it_before_exit(self):
        """RQ-SAFE-4, protocol 1(a): a crashed parent must not leave a program (motors) running."""
        fb = self.board(profile="esp32")
        b = self.start()
        b.read_line()
        self.connect(b, fb)
        b.send("run", source=PROGRAMS["sleep_loop"], name="loop.py")
        fb.events.wait_for("program_start", timeout=5)
        time.sleep(0.2)
        self.assertTrue(fb.program_running)
        # The Run itself did exactly one soft reset (D-07, protocol section 5: reset defaults to true). The assertion
        # is that quitting adds none: Ctrl-C only, never a reset.
        resets_before_quit = fb.events.count("hard_reset") + fb.events.count("soft_reset")
        t0 = time.monotonic()
        self.assertEqual(b.close(), 0)
        self.assertLess(time.monotonic() - t0, 4.0)
        self.assertFalse(fb.program_running, "bridge exited while the user program was still running")
        self.assertGreaterEqual(fb.events.count("interrupt"), 1)
        self.assertEqual(fb.events.count("hard_reset") + fb.events.count("soft_reset"), resets_before_quit)
        self.assertEqual(fb.events.count("hard_reset"), 0)


if __name__ == "__main__":
    unittest.main()
