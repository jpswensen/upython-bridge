"""bridge_client.py - a reusable black-box NDJSON client for the bridge process, plus the shared test base class.

Not a test module (its name does not match ``test*.py``).  Used by tests/test_scenarios.py,
tests/test_scenarios_faults.py, tests/test_differential.py and tests/test_regressions.py.

What it does (docs/protocol.md sections 1, 2, 4)
    * spawns the bridge exactly like the extension does, as an ARGV LIST (no shell):
      ``[sys.executable, "-I", "-B", "-u", "-X", "utf8", <bridge/mpy_bridge.py>]``, neutral cwd, env with
      ``MPY_SAFE_MODE=1`` forced on and ``MPY_REAL_PORT`` removed (a test child may never be handed a real port);
    * one reader thread for stdout (every line must be one JSON object; anything else is recorded in ``bad_stdout``
      and fails ``assert_clean_stdout()``), one for stderr (human log lines, kept in ``stderr_lines``);
    * request ids, per-request timeouts, ``call()`` (raises ``BridgeCallError`` on ``{"ok":false}``; the error dict is
      ``exc.error``), ``request()`` (returns the response either way), ``send()`` + ``result()`` for overlapping
      requests, ``fail()`` (expects an error, returns the error dict);
    * ``wait_event(ev, predicate, timeout)``, ``events_of``, byte-stream helpers for ``out`` / ``err`` / ``repl``
      events (base64 decoded), ``wait_stream``, ``wait_state``;
    * ``close()`` ALWAYS ends the child: stdin EOF -> wait -> terminate -> kill, then joins the reader threads and
      closes the pipes.  ``kill()`` is the immediate, thread-safe variant meant for ``addWatchdogCleanup``.

Nothing here knows the bridge's internals.  Every timestamp is ``time.monotonic()`` (the same clock the fake board
stamps its events with), so ``event["_t"]`` can be compared with ``FakeBoard.events`` entries.

``BridgeTestCase`` (a ``TimedTestCase``) wires the cleanups so a failing or timing-out test cannot leak a bridge, a
fake board or a temp folder: ``new_board()`` / ``new_bridge()`` / ``connected()`` / ``local_dir()``.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from tests.support import TimedTestCase, child_env, wait_until
from tools.fakeboard import FakeBoard

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE_PATH = os.path.join(ROOT, "bridge", "mpy_bridge.py")
VENDOR = os.path.join(ROOT, "bridge", "vendor")
COURSE_SUBPATH = ("OneDrive-Washington State University(email.wsu.edu)", "ME 241 (Fall)", "Lab 1")   # RQ-CLOUD-1

DEFAULT_TIMEOUT = 20.0

__all__ = ["BridgeClient", "BridgeCallError", "BridgeTimeout", "BridgeGone", "BridgeTestCase", "OrphanableBridge",
           "run_cli", "bridge_available", "course_dir", "b64", "BRIDGE_PATH", "VENDOR", "ROOT"]


def bridge_available():
    return os.path.isfile(BRIDGE_PATH)


def b64(data):
    return base64.b64encode(data).decode("ascii")


def course_dir(base):
    """Create (and return) ``<base>/OneDrive-Washington State University(email.wsu.edu)/ME 241 (Fall)/Lab 1``."""
    path = os.path.join(base, *COURSE_SUBPATH)
    os.makedirs(path, exist_ok=True)
    return path


def bridge_argv(extra=()):
    return [sys.executable, "-I", "-B", "-u", "-X", "utf8", BRIDGE_PATH] + list(extra)


class BridgeTimeout(AssertionError):
    """The bridge did not answer / emit the awaited event in time (an ordinary test failure, not a hang)."""


class BridgeGone(AssertionError):
    """The bridge process ended (or its stdout closed) while the test still needed it."""


class BridgeCallError(Exception):
    """``call()`` got ``{"ok": false, "error": {...}}``.  ``.error`` is the error dict, ``.code`` its code."""

    def __init__(self, op, response):
        self.op = op
        self.response = response
        self.error = response.get("error") or {}
        self.code = self.error.get("code")
        Exception.__init__(self, "%s failed: %s: %s (detail=%r)" % (op, self.code, self.error.get("message"),
                                                                    self.error.get("detail")))


class BridgeClient(object):
    """One bridge child process and the NDJSON conversation with it.  See the module docstring."""

    def __init__(self, cwd=None, env_extra=None, harness_ptys=(), argv_extra=(), hello_timeout=25.0,
                 default_timeout=DEFAULT_TIMEOUT, bridge_path=None, autostart=True):
        self.default_timeout = default_timeout
        self.hello_timeout = hello_timeout
        self.events = []                  # every event dict, in arrival order, each with "_n" and "_t"
        self.responses = {}               # id -> response dict (with "_n", "_t")
        self.bad_stdout = []              # stdout lines that were not one JSON object (protocol violation)
        self.stderr_lines = []
        self.exit_code = None
        self.shutdown = None              # "eof" (clean), "terminate" or "kill": how close() had to end it
        self._cv = threading.Condition()
        self._wlock = threading.Lock()
        self._lines = 0
        self._next_id = 0
        self._stdout_eof = False
        self._closed = False
        self._close_lock = threading.Lock()
        self._own_cwd = None
        self._path = bridge_path or BRIDGE_PATH
        if not os.path.isfile(self._path):
            raise AssertionError("bridge/mpy_bridge.py does not exist yet (%s)" % self._path)
        if cwd is None:
            cwd = tempfile.mkdtemp(prefix="bridge-cwd-")            # protocol section 1: a neutral directory
            self._own_cwd = cwd
        self.cwd = cwd
        extra = dict(env_extra or {})
        if harness_ptys:
            extra["MPY_HARNESS_PTYS"] = os.pathsep.join(harness_ptys)
        extra.pop("MPY_REAL_PORT", None)
        argv = [sys.executable, "-I", "-B", "-u", "-X", "utf8", self._path] + list(argv_extra)
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     cwd=cwd, env=child_env(**extra), shell=False)
        self.pid = self.proc.pid
        self._t_out = threading.Thread(target=self._read_stdout, name="bridge-client-stdout", daemon=True)
        self._t_err = threading.Thread(target=self._read_stderr, name="bridge-client-stderr", daemon=True)
        self._t_out.start()
        self._t_err.start()
        self.hello = None
        if autostart:
            try:
                self.hello = self.wait_event("hello", timeout=hello_timeout)
            except BaseException:
                self.kill()
                raise

    # ------------------------------------------------------------------ reader threads
    def _read_stdout(self):
        try:
            for raw in iter(self.proc.stdout.readline, b""):
                now = time.monotonic()
                try:
                    msg = json.loads(raw.decode("utf-8"))
                    if not isinstance(msg, dict):
                        raise ValueError("not an object")
                except ValueError:
                    with self._cv:
                        self.bad_stdout.append(raw)
                        self._cv.notify_all()
                    continue
                with self._cv:
                    self._lines += 1
                    msg["_n"] = self._lines
                    msg["_t"] = now
                    if "ev" in msg:
                        self.events.append(msg)
                    elif "id" in msg:
                        self.responses[msg["id"]] = msg
                    else:
                        self.bad_stdout.append(raw)
                    self._cv.notify_all()
        except (OSError, ValueError):
            pass
        finally:
            with self._cv:
                self._stdout_eof = True
                self._cv.notify_all()

    def _read_stderr(self):
        try:
            for raw in iter(self.proc.stderr.readline, b""):
                with self._cv:
                    self.stderr_lines.append(raw.decode("utf-8", "replace").rstrip("\r\n"))
        except (OSError, ValueError):
            pass

    # ------------------------------------------------------------------ requests
    def send(self, op, **args):
        """Write one request, return its id.  Does not wait."""
        with self._wlock:
            self._next_id += 1
            rid = self._next_id
            msg = dict(args)
            msg["id"] = rid
            msg["op"] = op
            data = (json.dumps(msg) + "\n").encode("utf-8")
            try:
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
            except (OSError, ValueError) as exc:
                raise BridgeGone("could not write %r to the bridge (%s); exit=%r; stderr tail:\n%s"
                                 % (op, exc, self.proc.poll(), self.stderr_tail()))
        return rid

    def send_raw(self, data):
        """Write raw bytes to the bridge's stdin (malformed-input tests)."""
        with self._wlock:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()

    def result(self, rid, timeout=None):
        """Wait for the response with this id (ok or not) and return it."""
        timeout = self.default_timeout if timeout is None else timeout
        end = time.monotonic() + timeout
        with self._cv:
            while rid not in self.responses:
                if self._stdout_eof:
                    raise BridgeGone("the bridge closed stdout before answering request %d; exit=%r; stderr tail:\n%s"
                                     % (rid, self.proc.poll(), self.stderr_tail()))
                left = end - time.monotonic()
                if left <= 0:
                    raise BridgeTimeout("no response to request %d within %.1f s; stderr tail:\n%s"
                                        % (rid, timeout, self.stderr_tail()))
                self._cv.wait(left)
            return self.responses[rid]

    def has_result(self, rid):
        with self._cv:
            return rid in self.responses

    def request(self, op, _timeout=None, **args):
        """Send and wait; returns the response dict whether ok or not."""
        return self.result(self.send(op, **args), _timeout)

    def call(self, op, _timeout=None, **args):
        """Send and wait; returns the response (``ok`` true) or raises ``BridgeCallError``."""
        resp = self.request(op, _timeout, **args)
        if not resp.get("ok"):
            raise BridgeCallError(op, resp)
        return resp

    def fail(self, op, code=None, _timeout=None, **args):
        """Send and wait; the request MUST fail.  Returns the error dict; checks the code when given."""
        resp = self.request(op, _timeout, **args)
        if resp.get("ok"):
            raise AssertionError("%s unexpectedly succeeded: %r" % (op, resp))
        err = resp.get("error") or {}
        for key in ("code", "message", "detail", "hint"):
            if key not in err:
                raise AssertionError("%s error object lacks %r: %r" % (op, key, err))
        if code is not None and err.get("code") != code:
            codes = (code,) if isinstance(code, str) else tuple(code)
            if err.get("code") not in codes:
                raise AssertionError("%s failed with %s, expected %s: %r" % (op, err.get("code"), code, err))
        return err

    def ping(self, timeout=5.0):
        return self.call("ping", _timeout=timeout)

    def tty_write(self, data, _timeout=None):
        """``tty.write`` of raw bytes (keystrokes).  Returns the monotonic time just before the request was written."""
        t0 = time.monotonic()
        self.call("tty.write", _timeout=_timeout, b64=b64(data))
        return t0

    def tty_send(self, data):
        """Like tty_write but does not wait for the response; returns (id, t_before_write)."""
        t0 = time.monotonic()
        return self.send("tty.write", b64=b64(data)), t0

    # ------------------------------------------------------------------ events
    def mark(self):
        """Index to pass as ``since=`` so that only events from now on are considered."""
        with self._cv:
            return len(self.events)

    def events_of(self, ev=None, since=0, **match):
        with self._cv:
            evs = list(self.events[since:])
        return [e for e in evs if (ev is None or e.get("ev") == ev) and all(e.get(k) == v for k, v in match.items())]

    def wait_event(self, ev=None, predicate=None, timeout=10.0, since=0):
        """First event (index >= since) whose name is ``ev`` (None = any) and for which ``predicate(event)`` is true."""
        end = time.monotonic() + timeout
        pos = since
        with self._cv:
            while True:
                while pos < len(self.events):
                    e = self.events[pos]
                    pos += 1
                    if (ev is None or e.get("ev") == ev) and (predicate is None or predicate(e)):
                        return e
                if self._stdout_eof:
                    raise BridgeGone("the bridge closed stdout while waiting for event %r; exit=%r; stderr tail:\n%s"
                                     % (ev, self.proc.poll(), self.stderr_tail()))
                left = end - time.monotonic()
                if left <= 0:
                    raise BridgeTimeout("no %r event within %.1f s (seen: %s); stderr tail:\n%s"
                                        % (ev, timeout, [x.get("ev") for x in self.events[since:]][-12:],
                                           self.stderr_tail()))
                self._cv.wait(left)

    def states(self, since=0):
        return [e.get("state") for e in self.events_of("state", since)]

    def wait_state(self, state, timeout=10.0, since=0):
        return self.wait_event("state", lambda e: e.get("state") == state, timeout, since)

    def stream(self, kind, since=0):
        """Concatenated, base64-decoded bytes of all ``out`` / ``err`` / ``repl`` events from index ``since``."""
        parts = []
        for e in self.events_of(kind, since):
            parts.append(base64.b64decode(e.get("b64", "")))
        return b"".join(parts)

    def out_bytes(self, since=0):
        return self.stream("out", since)

    def err_bytes(self, since=0):
        return self.stream("err", since)

    def repl_bytes(self, since=0):
        return self.stream("repl", since)

    def wait_stream(self, kind, needle, timeout=10.0, since=0):
        """Wait until ``needle`` (bytes) occurs in the stream; returns the accumulated stream bytes."""
        end = time.monotonic() + timeout
        with self._cv:
            while True:
                data = b"".join(base64.b64decode(e.get("b64", "")) for e in self.events[since:] if e.get("ev") == kind)
                if needle in data:
                    return data
                if self._stdout_eof:
                    raise BridgeGone("the bridge closed stdout while waiting for %r in the %s stream (have %r)"
                                     % (needle, kind, data[-200:]))
                left = end - time.monotonic()
                if left <= 0:
                    raise BridgeTimeout("%r never appeared in the %s stream within %.1f s (have %r); stderr tail:\n%s"
                                        % (needle, kind, timeout, data[-300:], self.stderr_tail()))
                self._cv.wait(left)

    def wait_out(self, needle, timeout=10.0, since=0):
        return self.wait_stream("out", needle, timeout, since)

    def stderr_tail(self, n=12):
        with self._cv:
            return "\n".join(self.stderr_lines[-n:])

    def assert_clean_stdout(self):
        """Every stdout line was one JSON object (protocol section 1: library prints never reach the channel)."""
        if self.bad_stdout:
            raise AssertionError("non-protocol lines on the bridge's stdout: %r" % (self.bad_stdout[:3],))

    # ------------------------------------------------------------------ process end
    @property
    def alive(self):
        return self.proc.poll() is None

    def wait_exit(self, timeout=10.0):
        try:
            return self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            raise BridgeTimeout("the bridge did not exit within %.1f s" % timeout)

    def close(self, timeout=8.0):
        """End the bridge for sure: stdin EOF (= quit, protocol section 1), then terminate, then kill.  Joins the reader
        threads, closes the pipes, removes the private cwd.  Idempotent.  Returns the exit code; ``self.shutdown``
        says how it ended ("eof" is the only graceful way)."""
        with self._close_lock:
            if self._closed:
                return self.exit_code
            self._closed = True
        try:
            try:
                self.proc.stdin.close()
            except (OSError, ValueError):
                pass
            try:
                rc = self.proc.wait(timeout)
                self.shutdown = "eof"
            except subprocess.TimeoutExpired:
                self.shutdown = "terminate"
                self.proc.terminate()
                try:
                    rc = self.proc.wait(5)
                except subprocess.TimeoutExpired:
                    self.shutdown = "kill"
                    self.proc.kill()
                    rc = self.proc.wait(10)
            self.exit_code = rc
        finally:
            self._finish()
        return self.exit_code

    def kill(self):
        """Immediate and thread-safe: for ``addWatchdogCleanup``.  Unblocks every waiter (they see BridgeGone)."""
        with self._close_lock:
            first = not self._closed
            self._closed = True
        if self.proc.poll() is None:
            try:
                self.proc.kill()
            except OSError:
                pass
        try:
            rc = self.proc.wait(10)
        except subprocess.TimeoutExpired:
            rc = None
        if first:
            self.shutdown = "kill"
            self.exit_code = rc
        self._finish()
        return rc

    def _finish(self):
        self._t_out.join(5)
        self._t_err.join(5)
        for pipe in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                pipe.close()
            except (OSError, ValueError):
                pass
        if self._own_cwd:
            shutil.rmtree(self._own_cwd, ignore_errors=True)
            self._own_cwd = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# ----------------------------------------------------------------------------------------------------------
# a parent that can be SIGKILLed while the bridge keeps running (RQ-SAFE-4: "kill -9 of the parent")
# ----------------------------------------------------------------------------------------------------------
_PARENT_SCRIPT = r'''
import json, os, subprocess, sys, threading, time
bridge, url, src_path, name = sys.argv[1:5]
p = subprocess.Popen([sys.executable, "-I", "-B", "-u", "-X", "utf8", bridge], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
def send(msg):
    p.stdin.write((json.dumps(msg) + "\n").encode("utf-8")); p.stdin.flush()
def read_until(pred):
    for raw in iter(p.stdout.readline, b""):
        msg = json.loads(raw.decode("utf-8"))
        if pred(msg):
            return msg
    raise SystemExit("bridge closed stdout")
read_until(lambda m: m.get("ev") == "hello")
send({"id": 1, "op": "connect", "port": url})
r = read_until(lambda m: m.get("id") == 1)
if not r.get("ok"):
    print("CONNECT-FAILED %s" % json.dumps(r), flush=True)
    raise SystemExit(2)
with open(src_path, "r", encoding="utf-8") as f:
    src = f.read()
send({"id": 2, "op": "run", "source": src, "name": name})
threading.Thread(target=lambda: [None for _ in p.stdout], daemon=True).start()
print("READY %d" % p.pid, flush=True)
end = time.time() + 120          # a self-limiting parent: it can never outlive a forgotten test by more than 2 minutes
while time.time() < end:
    time.sleep(0.2)
'''


class OrphanableBridge(object):
    """A helper process (the "extension host") that starts the bridge, connects it to ``url`` and starts running
    ``source`` on the board; the test then SIGKILLs the helper with ``kill_parent()``.  The bridge sees its stdin
    close (and its stdout pipe break) exactly like when VS Code crashes.  ``cleanup()`` kills both for sure."""

    def __init__(self, url, source, name="loop.py", ready_timeout=30.0):
        self.dir = tempfile.mkdtemp(prefix="orphan-")
        self.src_path = os.path.join(self.dir, "program.py")
        with open(self.src_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(source)
        argv = [sys.executable, "-I", "-B", "-u", "-X", "utf8", "-c", _PARENT_SCRIPT, BRIDGE_PATH, url, self.src_path, name]
        self.parent = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       cwd=self.dir, env=child_env(), shell=False)
        self.bridge_pid = None
        self.ready_line = None
        self._ready = threading.Event()
        threading.Thread(target=self._read, name="orphan-parent-stdout", daemon=True).start()
        threading.Thread(target=lambda: [None for _ in iter(self.parent.stderr.readline, b"")], daemon=True).start()
        self.ready_timeout = ready_timeout

    def _read(self):
        for raw in iter(self.parent.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").strip()
            if line.startswith("READY ") or line.startswith("CONNECT-FAILED"):
                self.ready_line = line
                if line.startswith("READY "):
                    self.bridge_pid = int(line.split()[1])
                self._ready.set()
                return
        self._ready.set()

    def wait_ready(self):
        if not self._ready.wait(self.ready_timeout) or not (self.ready_line or "").startswith("READY "):
            raise AssertionError("the orphanable parent did not become ready: %r" % (self.ready_line,))
        return self.bridge_pid

    def kill_parent(self):
        """SIGKILL on POSIX (TerminateProcess on Windows): no atexit, no finally, no goodbye."""
        self.parent.kill()
        self.parent.wait(10)

    def bridge_alive(self):
        if self.bridge_pid is None:
            return False
        if sys.platform == "win32":
            return True                                  # no cheap pid probe without ctypes; callers skip this check
        try:
            os.kill(self.bridge_pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def cleanup(self):
        if self.parent.poll() is None:
            self.parent.kill()
        try:
            self.parent.wait(10)
        except subprocess.TimeoutExpired:
            pass
        if self.bridge_pid and self.bridge_alive() and sys.platform != "win32":
            try:
                os.kill(self.bridge_pid, 9)
            except OSError:
                pass
        for pipe in (self.parent.stdout, self.parent.stderr):
            try:
                pipe.close()
            except (OSError, ValueError):
                pass
        shutil.rmtree(self.dir, ignore_errors=True)


def run_cli(*args, timeout=15.0, env_extra=None):
    """``bridge/mpy_bridge.py --cli <args>`` (protocol section 10).  Returns ``(returncode, parsed_json_or_None, stderr)``."""
    argv = bridge_argv(["--cli"] + [str(a) for a in args])
    cwd = tempfile.mkdtemp(prefix="bridge-cli-cwd-")
    try:
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, cwd=cwd,
                           env=child_env(**(env_extra or {})), shell=False)
    finally:
        shutil.rmtree(cwd, ignore_errors=True)
    parsed = None
    for line in reversed(r.stdout.decode("utf-8", "replace").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                parsed = json.loads(line)
                break
            except ValueError:
                continue
    return r.returncode, parsed, r.stderr.decode("utf-8", "replace")


# ----------------------------------------------------------------------------------------------------------
# the shared base class
# ----------------------------------------------------------------------------------------------------------
class BridgeTestCase(TimedTestCase):
    """TimedTestCase with the plumbing every bridge scenario needs.  A hang is a failure (``DEADLINE_S``), a failing
    test cannot leak a process: bridges are closed (EOF, terminate, kill) and fake boards stopped by cleanups, and a
    deadline expiry kills the bridge from the watchdog thread so the blocked call raises ``BridgeGone``."""

    DEADLINE_S = 90

    def new_board(self, profile="esp32", **kw):
        """A started FakeBoard (stopped by a cleanup).  Create the board BEFORE the bridge so cleanups run bridge-first."""
        board = FakeBoard(profile=profile, **kw)
        board.start()
        self.addCleanup(board.stop)
        return board

    def new_bridge(self, **kw):
        client = BridgeClient(**kw)
        self.addCleanup(client.close)
        self.addWatchdogCleanup(client.kill)
        return client

    def connected(self, profile="esp32", faults=(), board_kw=None, port_args=None, **bridge_kw):
        """(board, client, connect_response) with the bridge connected to a fresh fake board."""
        board = self.new_board(profile, faults=faults, **(board_kw or {}))
        client = self.new_bridge(**bridge_kw)
        resp = client.call("connect", port=board.url, **(port_args or {}))
        return board, client, resp

    def reconnect(self, client, board, timeout=8.0, **args):
        """connect again after a disconnect: the exclusive fake board needs a moment to listen again."""
        end = time.monotonic() + timeout
        while True:
            resp = client.request("connect", port=board.url, **args)
            if resp.get("ok"):
                return resp
            if (resp.get("error") or {}).get("code") not in ("E_NO_DEVICE", "E_PORT_BUSY") or time.monotonic() > end:
                raise BridgeCallError("connect", resp)
            wait_until(lambda: board.connected == 0, 2.0, "the fake board to release the previous client")

    def local_dir(self, course=True):
        """A fresh temp folder; by default with the OneDrive-style sub path of RQ-CLOUD-1 (spaces, parentheses)."""
        base = tempfile.mkdtemp(prefix="mpy-scen-")
        self.addCleanup(shutil.rmtree, base, True)
        return course_dir(base) if course else base

    @staticmethod
    def write_local(folder, name, data):
        path = os.path.join(folder, *name.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if isinstance(data, str):
            data = data.encode("utf-8")
        with open(path, "wb") as f:
            f.write(data)
        return path

    def start_program(self, client, source, name="prog.py", ready=b"go", timeout=20.0, **args):
        """Send ``run`` (does not wait for the end) and wait until the program printed ``ready``: proves the stream
        works and the program is really executing.  Returns the request id of the run."""
        m = client.mark()
        rid = client.send("run", source=source, name=name, **args)
        if ready:
            client.wait_out(ready, timeout, since=m)
        return rid

    def list_root_after_drop(self, client, **context):
        """First file op after a reconnect to a board whose link dropped in the middle of a raw-REPL operation.  The board is
        still inside the raw REPL, which the bridge may (safely) report as a running program (E_PROGRAM_RUNNING); the
        documented consent path (`interrupt:true`) must then give the board back without a reset.  Returns the fs.list
        response."""
        first = client.request("fs.list", path="/")
        if not first["ok"]:
            self.assertEqual(first["error"]["code"], "E_PROGRAM_RUNNING", (context, first))
            first = client.request("fs.list", path="/", interrupt=True)
        self.assertTrue(first["ok"], (context, first))
        return first

    @staticmethod
    def user_programs_started(board):
        """Number of user programs (raw-REPL programs, i.e. Run and every file-op snippet) the board has started."""
        return board.events.count("program_start", kind="raw")

    def assertNoReset(self, board, msg=""):
        """RQ-SAFE-1: the fake board's event log shows no soft and no hard reset."""
        self.assertEqual(board.events.count("soft_reset"), 0, "soft reset logged. %s" % msg)
        self.assertEqual(board.events.count("hard_reset"), 0, "hard reset logged. %s" % msg)
