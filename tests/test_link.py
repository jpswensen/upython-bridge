"""Tests for bridge/errors.py and bridge/link.py (the serial link).

No real serial port is ever opened: targets are an in-process fake board behind socket://127.0.0.1:PORT
(the immutable snapshot tools/prototypes/fakeboard_v0.py, loaded by path), ptys created by this file,
recording stub serial objects, and (optional) the real MicroPython unix VM behind a socket relay.

Row ids of docs/old-defects.md pinned here are listed in each docstring as "PINS ...".

Run (from the repo root):
    export MPY_SAFE_MODE=1
    export MPY_UNIX_BIN=<path to the unix micropython>      # optional: real-VM tests skip without it
    python3 -B -m unittest discover -s tests -t . -v
"""
from __future__ import annotations

import ctypes
import errno
import importlib.util
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "bridge", "vendor")
for _p in (ROOT, VENDOR):  # vendor ends up first
    if _p in sys.path:
        sys.path.remove(_p)
    sys.path.insert(0, _p)

os.environ.setdefault("MPY_SAFE_MODE", "1")

import serial  # noqa: E402  (vendored pyserial)
import serial.urlhandler.protocol_socket as _protocol_socket  # noqa: E402

from bridge import link as linkmod  # noqa: E402
from bridge.errors import BridgeError, CODES, HINTS, classify_open_error  # noqa: E402
from bridge.link import Link  # noqa: E402

MPY_BIN = os.environ.get("MPY_UNIX_BIN", "")
FAKE_PATH = os.path.join(ROOT, "tools", "prototypes", "fakeboard_v0.py")
IS_WINDOWS = os.name == "nt"


def _mpy_interrupt_board(mod):
    """The v0 Board of `mod` with MicroPython's Ctrl-C semantics, which v0 only approximates.

    The race this replaces (the 3 % flake of InterruptTests.test_interrupt_friendly_main_py_without_pump, 11 % under
    6-way load): v0 delivers every Ctrl-C with PyThreadState_SetAsyncExc into the worker for as long as the worker is
    alive, including while it is already handling the previous KeyboardInterrupt. A Stop is two Ctrl-C 50 ms apart and
    a program doing `sleep(0.05)` wakes up (and raises the first KeyboardInterrupt) right when the second one arrives,
    so the second one regularly landed inside `run`'s unprotected `except` clause (fmt_exc) and killed the worker
    thread: no traceback, no ">>> " prompt, ever. A real board cannot do that. pyexec disables the interrupt
    character the moment the uncaught exception is caught and clears any pending one; a later Ctrl-C is just a REPL
    character. Here: the worker is armed only while it executes user code (`run`), `interrupt_worker` and the
    disarm exclude each other, and the disarm is the first thing the handlers do and retries if a pending
    KeyboardInterrupt fires inside it. After that no async exception can reach the worker."""
    base, SoftReset = mod.Board, mod.SoftReset
    set_async_exc = ctypes.pythonapi.PyThreadState_SetAsyncExc

    class Board(base):
        def __init__(self, *args, **kw):
            self._ilock = threading.Lock()
            self._armed = False
            base.__init__(self, *args, **kw)

        def interrupt_worker(self):
            with self._ilock:
                if self._armed:
                    base.interrupt_worker(self)

        def _quiesce(self):
            """One disarm attempt, on the worker thread: no new interrupt after this, none pending."""
            with self._ilock:
                self._armed = False
                set_async_exc(ctypes.c_ulong(threading.get_ident()), None)

        def run(self, src, filename="<stdin>", eval_print=False):
            # Every disarm below is an inline loop around the call: a pending KeyboardInterrupt fires at the first
            # check point (the callee's entry), which must be inside a `try` of this frame.
            try:
                with self._ilock:
                    self._armed = True
                if eval_print:
                    try:
                        code = compile(src, filename, "eval")
                    except SyntaxError:
                        code = compile(src, filename, "exec")
                        eval_print = False
                    r = eval(code, self.ns)
                    if eval_print and r is not None:
                        self.out.write(repr(r) + "\n")
                else:
                    exec(compile(src, filename, "exec"), self.ns)
                while True:     # ended by itself; a KeyboardInterrupt in here is a Ctrl-C that came too late
                    try:
                        self._quiesce()
                        break
                    except KeyboardInterrupt:
                        pass
                return True, "", False
            except SoftReset:
                while True:
                    try:
                        self._quiesce()
                        break
                    except KeyboardInterrupt:
                        pass
                return True, "", True
            except BaseException:
                while True:
                    try:
                        self._quiesce()
                        break
                    except KeyboardInterrupt:
                        pass
                return False, self.fmt_exc(), False

    return Board


def _load_fake():
    # a private module name: other test files must not share (or clobber) this module's globals such as BAUD
    spec = importlib.util.spec_from_file_location("linktest_fakeboard_v0", FAKE_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["linktest_fakeboard_v0"] = mod
    spec.loader.exec_module(mod)
    mod.BAUD = 0
    mod.Board = _mpy_interrupt_board(mod)           # the snapshot file itself stays untouched
    return mod


FB = _load_fake()
BANNER_PROMPT = FB.BANNER + b">>> "

_real_proto_time = None
_real_excepthook = None


def setUpModule():
    # pyserial's socket:// close() sleeps 0.3 s "for quick reconnects"; skip that idle sleep so the
    # 20-cycle tests are fast. Nothing else in that module uses time.
    global _real_proto_time, _real_excepthook
    # The fake board delivers Ctrl-C as an asynchronous KeyboardInterrupt; at teardown it can land in the
    # fake's own worker thread after the program ended. That is fake-board noise, not a Link problem.
    _real_excepthook = threading.excepthook

    def hook(args):
        if args.exc_type is not KeyboardInterrupt:
            _real_excepthook(args)

    threading.excepthook = hook
    _real_proto_time = _protocol_socket.time
    _protocol_socket.time = types.SimpleNamespace(
        sleep=lambda s: None, time=time.time, monotonic=time.monotonic)


def tearDownModule():
    _protocol_socket.time = _real_proto_time
    threading.excepthook = _real_excepthook
from tests.support import TimedTestCase as _TimedTestCase, shorten_socket_close_sleep, wait_until  # noqa: E402

shorten_socket_close_sleep()  # pyserial's socket:// close() sleeps 0.3 s per Link.close(); see tests/support.py


class TimedCase(_TimedTestCase):
    """Every test in this module gets a hard per-test deadline (tests/support.py): a hang is a FAIL that names the
    blocked line, never a frozen suite.  Generous on purpose so a slow-but-correct test on a loaded machine is not flaky;
    MPY_TEST_DEADLINE_SCALE multiplies it, 0 disables it."""
    DEADLINE_S = 120.0




# ============================================================================ test doubles

class FakeServer(object):
    """The fakeboard_v0 Board served over a loopback socket, in this process, with an event log,
    a record of every byte the host sent, and hooks to subclass the board."""

    def __init__(self, root, board_factory=None, exclusive=False, run_main_on_connect=False, greeting=b""):
        self.root = root
        self.board_factory = board_factory or (lambda r, s, l: FB.Board(r, s, l))
        self.exclusive = exclusive
        self.run_main = run_main_on_connect
        self.greeting = greeting
        self.events = []
        self.rx = bytearray()
        self.rx_log = []          # (monotonic time, bytes)
        self.boards = []
        self.conn = None
        self.srv = None
        self.port = 0
        self.listening = threading.Event()
        self._stop = threading.Event()
        self._listen()
        self.url = "socket://127.0.0.1:%d" % self.port
        self.thread = threading.Thread(target=self._serve, name="fakeserver", daemon=True)
        self.thread.start()

    @property
    def board(self):
        return self.boards[-1] if self.boards else None

    def count(self, ev):
        return sum(1 for e in self.events if e["ev"] == ev)

    def log(self, kind, **kw):
        self.events.append(dict(ev=kind, **kw))

    def _listen(self):
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", self.port))
        s.listen(1)
        self.port = s.getsockname()[1]
        self.srv = s
        self.listening.set()

    def _serve(self):
        first = True
        while not self._stop.is_set():
            srv = self.srv
            if srv is None:
                time.sleep(0.01)
                continue
            srv.settimeout(0.1)
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            conn.settimeout(0.1)
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            if self.exclusive:      # like an exclusive serial lock: refuse others while a client holds it
                self.listening.clear()
                srv.close()
                self.srv = None
            self.conn = conn
            board = self.board_factory(self.root, conn, self.log)
            real_feed = board.feed

            def feed(data, _real=real_feed):
                self.rx += data
                self.rx_log.append((time.monotonic(), bytes(data)))
                _real(data)

            board.feed = feed
            self.boards.append(board)
            self.log("connect")
            if self.greeting:
                # pyserial's open() flushes the input queue right after connecting; wait until the client
                # is certainly past that, or the greeting can be swallowed (a real race under load)
                time.sleep(0.25)
                board.tx(self.greeting)
            if self.run_main and first:
                board.boot(announce=False)
            first = False
            try:
                while board.alive and not self._stop.is_set():
                    try:
                        data = conn.recv(4096)
                    except socket.timeout:
                        continue
                    if not data:
                        break
                    board.feed(data)
            except OSError:
                pass
            finally:
                board.alive = False
                board.interrupt_worker()
                try:
                    conn.close()
                except OSError:
                    pass
                self.conn = None
                self.log("disconnect")
                if self.exclusive and not self._stop.is_set():
                    self._listen()

    def wait_connected(self, timeout=2.0):
        deadline = time.monotonic() + timeout
        while self.conn is None and time.monotonic() < deadline:
            time.sleep(0.005)
        return self.conn is not None

    def wait_count(self, ev, n, timeout=2.0):
        deadline = time.monotonic() + timeout
        while self.count(ev) < n and time.monotonic() < deadline:
            time.sleep(0.005)
        return self.count(ev) >= n

    def kick(self):
        """Simulate an unplug: drop the connection from the board side."""
        self.wait_connected()
        c = self.conn
        if c is not None:
            try:
                c.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            c.close()

    def stop(self):
        self._stop.set()
        for b in self.boards:
            b.alive = False      # the serve loop's own cleanup interrupts the program (once)
        for s in (self.srv, self.conn):
            if s is not None:
                try:
                    s.close()
                except OSError:
                    pass
        self.thread.join(2.0)
        for s in (self.srv, self.conn):   # the serve loop may have re-listened while we were stopping
            if s is not None:
                try:
                    s.close()
                except OSError:
                    pass


class OldFirmwareBoard(FB.Board):
    """Firmware without raw paste: Ctrl-E A Ctrl-A just restarts the raw REPL (prints the banner)."""
    def raw_byte(self, c):
        if c == FB.CTRL_A and bytes(self.line) == b"\x05A":
            self.line.clear()
            self.tx(b"raw REPL; CTRL-B to exit\r\n>")
            return
        FB.Board.raw_byte(self, c)


class PasteR0Board(FB.Board):
    """Firmware that understands the raw-paste request but answers 'not supported' (R\\x00)."""
    def raw_byte(self, c):
        if c == FB.CTRL_A and bytes(self.line) == b"\x05A":
            self.line.clear()
            self.tx(b"R\x00")
            return
        FB.Board.raw_byte(self, c)


class IgnoreCtrlCBoard(FB.Board):
    """A program that swallows KeyboardInterrupt: Ctrl-C never reaches the VM."""
    def interrupt_worker(self):
        pass


class SecondCtrlCInHandlerBoard(FB.Board):
    """Forces the interleaving behind the old Stop flake without any timing luck: the worker is parked inside the
    handler of the first KeyboardInterrupt (before the traceback is formatted) until the SECOND Ctrl-C has reached
    the board. On a board that keeps accepting interrupts while it handles one, that Ctrl-C kills the worker
    thread and the prompt is never printed."""
    def __init__(self, *args, **kw):
        self.handler_entered = threading.Event()
        self.second_ctrl_c = threading.Event()
        self.ctrl_c_count = 0
        FB.Board.__init__(self, *args, **kw)

    def interrupt_worker(self):
        FB.Board.interrupt_worker(self)
        self.ctrl_c_count += 1
        if self.ctrl_c_count >= 2:
            self.second_ctrl_c.set()

    def fmt_exc(self):
        self.handler_entered.set()
        self.second_ctrl_c.wait(10)
        return FB.Board.fmt_exc(self)


class GarbageBoard(FB.Board):
    """Line noise and a stray partial banner before the real raw REPL banner."""
    def friendly_byte(self, c):
        if c == FB.CTRL_A:
            self.tx(b"\xff\xfe\x00noise\r\nraw REPL; CTRL-B\r\n>>> \x07junk")
        FB.Board.friendly_byte(self, c)


class ByteWiseBoard(FB.Board):
    """Every output byte is its own TCP segment, so every marker (banner, \\x04, >) can split across reads."""
    def tx(self, b):
        if isinstance(b, str):
            b = b.encode()
        with self.wlock:
            try:
                for i in range(len(b)):
                    self.sock.sendall(b[i:i + 1])
                    if i % 5 == 0:
                        time.sleep(0.0004)
            except OSError:
                self.alive = False


def slow_banner_board(delay):
    class SlowBannerBoard(FB.Board):
        def friendly_byte(self, c):
            if c == FB.CTRL_A:
                time.sleep(delay)
            FB.Board.friendly_byte(self, c)
    return lambda r, s, l: SlowBannerBoard(r, s, l)


def drop_after_board(nbytes):
    class DropBoard(FB.Board):
        seen = 0
        def feed(self, data):
            self.seen += len(data)
            if self.seen > nbytes:
                try:
                    self.sock.shutdown(socket.SHUT_RDWR)
                    self.sock.close()
                except OSError:
                    pass
                self.alive = False
                return
            FB.Board.feed(self, data)
    return lambda r, s, l: DropBoard(r, s, l)


class StubSerial(object):
    """Recording stand-in for a pyserial object (policy sequencing tests). Never touches the OS."""
    def __init__(self, port=None, **kw):
        self.port = port
        self.kw = kw
        self.events = []
        self.is_open = False
        self._dtr = True
        self._rts = True
        self.fail = {}        # step name -> exception to raise
        self.in_waiting = 0

    def _maybe_fail(self, key):
        exc = self.fail.get(key)
        if exc is not None:
            raise exc

    @property
    def dtr(self):
        return self._dtr

    @dtr.setter
    def dtr(self, v):
        self.events.append(("dtr", bool(v)))
        self._maybe_fail("dtr")
        self._dtr = v

    @property
    def rts(self):
        return self._rts

    @rts.setter
    def rts(self, v):
        self.events.append(("rts", bool(v)))
        self._maybe_fail("rts")
        self._rts = v

    def open(self):
        self.events.append(("open",))
        self._maybe_fail("open")
        self.is_open = True

    def close(self):
        self.events.append(("close",))
        self.is_open = False

    def read(self, n=1):
        time.sleep(0.001)
        return b""

    def write(self, data):
        self.events.append(("write", bytes(data)))
        return len(data)


def stub_factory(created, **fail):
    def factory(port, **kw):
        s = StubSerial(port, **kw)
        s.fail = dict(fail)
        created.append(s)
        return s
    return factory


class PtyFake(object):
    """The fake board on a pty we create (POSIX). Link opens the slave path like a real serial port."""
    def __init__(self, root):
        import pty
        self.master, self.slave = pty.openpty()
        self.path = os.ttyname(self.slave)
        linkmod.allow_harness_pty(self.path)
        self.events = []
        self.rx = bytearray()
        self.board = FB.Board(root, self, lambda kind, **kw: self.events.append(dict(ev=kind, **kw)))
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def sendall(self, b):
        while b:
            n = os.write(self.master, b)
            b = b[n:]

    def _run(self):
        import select
        while not self._stop.is_set():
            try:
                r, _, _ = select.select([self.master], [], [], 0.05)
                if r:
                    data = os.read(self.master, 4096)
                    if not data:
                        break
                    self.rx += data
                    self.board.feed(data)
            except OSError:
                break

    def stop(self):
        self._stop.set()
        self.board.alive = False
        self.board.interrupt_worker()
        self.thread.join(1.0)
        for fd in (self.master, self.slave):
            try:
                os.close(fd)
            except OSError:
                pass
        linkmod._HARNESS_PTYS.discard(self.path)


class RealVM(object):
    """The real MicroPython unix port on a pty, relayed to socket://127.0.0.1:PORT (see mpunix_relay_v0)."""
    def __init__(self, mp_bin, cwd):
        self.mp_bin, self.cwd = mp_bin, cwd
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        self.url = "socket://127.0.0.1:%d" % self.srv.getsockname()[1]
        self.proc = None
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        import pty
        import select
        import termios
        import tty
        self.srv.settimeout(0.1)
        conn = None
        while conn is None and not self._stop.is_set():
            try:
                conn, _ = self.srv.accept()
            except socket.timeout:
                continue
            except OSError:
                return
        if conn is None:
            return
        master, slave = pty.openpty()
        tty.setraw(slave)        # no echo / newline translation: MicroPython cooks its own bytes
        attrs = termios.tcgetattr(slave)
        attrs[3] |= termios.ISIG  # the port saves this as "orig" and restores it while running code
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        self.proc = subprocess.Popen([self.mp_bin], stdin=slave, stdout=slave, stderr=slave,
                                     cwd=self.cwd, close_fds=True)
        os.close(slave)
        try:
            # let the VM reach its first prompt before relaying anything (a ^C into a half-started
            # unix port would kill it); the banner is delivered to the client afterwards
            boot = b""
            t_end = time.monotonic() + 10
            while not boot.endswith(b">>> ") and time.monotonic() < t_end and not self._stop.is_set():
                if select.select([master], [], [], 0.05)[0]:
                    boot += os.read(master, 4096)
            if boot:
                conn.sendall(boot)
            while not self._stop.is_set():
                r, _, _ = select.select([master, conn], [], [], 0.1)
                if master in r:
                    try:
                        d = os.read(master, 4096)
                    except OSError:
                        break
                    if not d:
                        break
                    conn.sendall(d)
                if conn in r:
                    d = conn.recv(4096)
                    if not d:
                        break
                    if b"\x03" in d and termios.tcgetattr(master)[3] & termios.ISIG:
                        # The unix port only reacts to SIGINT. A real tty line discipline raises it for ^C
                        # whenever ISIG is set (the port sets it while running code, clears it at the
                        # prompt); this relay has no controlling terminal, so do that part here.
                        self.proc.send_signal(signal.SIGINT)
                        d = d.replace(b"\x03", b"")
                    if d:
                        os.write(master, d)
                if self.proc.poll() is not None and master not in r:
                    break
        except OSError:
            pass
        finally:
            self.proc.kill()
            self.proc.wait()
            os.close(master)
            conn.close()

    def stop(self):
        self._stop.set()
        self.thread.join(3.0)
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.srv.close()


class LinkTestCase(TimedCase):
    """Common helpers: a temp root, servers, links; everything is cleaned up."""

    def setUp(self):
        import tempfile
        self._tmp = tempfile.mkdtemp(prefix="linktest-")
        self.addCleanup(self._rmtree)
        self.root = self._tmp

    def _rmtree(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def write_file(self, name, text):
        with open(os.path.join(self.root, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)

    def server(self, **kw):
        s = FakeServer(self.root, **kw)
        self.addCleanup(s.stop)
        return s

    def new_link(self, **kw):
        lk = Link(**kw)
        self.addCleanup(lk.close)
        return lk

    def connected(self, srv=None, **kw):
        srv = srv or self.server()
        lk = self.new_link(**kw)
        lk.open(srv.url)
        return srv, lk


LOOP_MAIN = "import time\nwhile True:\n    print('tick')\n    time.sleep(0.05)\n"
SILENT_MAIN = "import time\nwhile True:\n    time.sleep(0.05)\n"


# ============================================================================ pure tests

class ErrorsTests(TimedCase):
    def test_codes_match_protocol_and_have_hints(self):
        expected = {
            "E_PORT_BUSY", "E_NO_DEVICE", "E_PERMISSION", "E_RAW_REPL_TIMEOUT", "E_PROGRAM_RUNNING",
            "E_BOARD_RESET", "E_BOARD_UNRESPONSIVE", "E_FS_ERRNO", "E_LOCAL_IO", "E_SHADOWS_MODULE",
            "E_UNSUPPORTED", "E_CANCELLED", "E_PROTOCOL", "E_SAFE_MODE", "E_INTERNAL", "E_NOT_CONNECTED",
            "E_ALREADY_CONNECTED"}
        self.assertEqual(set(CODES), expected)
        for c in CODES:
            self.assertTrue(HINTS[c].strip(), c)

    def test_to_dict_shape_and_unknown_code(self):
        e = BridgeError("E_NO_DEVICE", "gone", detail="d", hint="h")
        self.assertEqual(e.to_dict(), {"code": "E_NO_DEVICE", "message": "gone", "detail": "d", "hint": "h"})
        self.assertEqual(str(e), "E_NO_DEVICE: gone")
        bad = BridgeError("E_TYPO", "x")
        self.assertEqual(bad.code, "E_INTERNAL")
        self.assertIn("E_TYPO", bad.detail)
        self.assertTrue(BridgeError("E_PORT_BUSY", "x").hint)  # default hint filled in

    def test_every_code_used_in_link_is_declared(self):
        with open(os.path.join(ROOT, "bridge", "link.py"), encoding="utf-8") as f:
            used = set(re.findall(r'"(E_[A-Z_]+)"', f.read()))
        self.assertTrue(used)
        self.assertFalse(used - set(CODES), used - set(CODES))


def _os_error(err, text="x", winerror=None, cls=OSError):
    e = cls(err, text)
    if winerror is not None:
        e.winerror = winerror   # only real on Windows; instance attribute stands in on other OSes
    return e


class ClassifyOpenErrorTests(TimedCase):
    """PINS 05.11, 08.12 (busy vs missing vs permission are distinguished), 05.19 (no English substrings)."""

    def code(self, exc, port="COM3"):
        return classify_open_error(exc, port).code

    def test_posix_errnos(self):
        self.assertEqual(self.code(_os_error(errno.EBUSY), "/dev/cu.x"), "E_PORT_BUSY")
        self.assertEqual(self.code(_os_error(errno.EAGAIN), "/dev/cu.x"), "E_PORT_BUSY")
        self.assertEqual(self.code(_os_error(errno.EWOULDBLOCK), "/dev/cu.x"), "E_PORT_BUSY")
        for n in (errno.ENOENT, errno.ENXIO, errno.ENODEV):
            self.assertEqual(self.code(_os_error(n), "/dev/cu.x"), "E_NO_DEVICE", n)
        for n in (errno.EACCES, errno.EPERM):
            self.assertEqual(self.code(_os_error(n), "/dev/ttyUSB0"), "E_PERMISSION", n)

    def test_windows_winerror_values(self):
        # Windows reports a COM port held by another process as ACCESS_DENIED (5) / sharing violation (32)
        for w in (5, 32, 33):
            self.assertEqual(self.code(_os_error(13, "Access is denied.", w, PermissionError)), "E_PORT_BUSY", w)
        for w in (2, 3):
            self.assertEqual(self.code(_os_error(2, "no such file", w, FileNotFoundError)), "E_NO_DEVICE", w)
        # winerror wins over a (different) errno
        self.assertEqual(self.code(_os_error(errno.EACCES, "x", 5)), "E_PORT_BUSY")

    def test_serial_exception_with_errno_and_with_context(self):
        # pyserial POSIX: SerialException(errno, "Could not exclusively lock port ...")
        self.assertEqual(self.code(serial.SerialException(errno.EAGAIN, "Could not exclusively lock port x: y")), "E_PORT_BUSY")
        self.assertEqual(self.code(serial.SerialException(errno.ENOENT, "could not open port x")), "E_NO_DEVICE")
        # pyserial socket://: the errno is only on __context__
        try:
            try:
                raise ConnectionRefusedError(errno.ECONNREFUSED, "refused")
            except OSError:
                raise serial.SerialException("Could not open port socket://h:1: refused")
        except serial.SerialException as exc:
            self.assertEqual(classify_open_error(exc, "socket://h:1").code, "E_NO_DEVICE")

    def test_message_text_is_irrelevant_when_a_number_is_present(self):
        # same errno, localised / empty / misleading text -> same answer (no English substrings)
        for text in ("", "Das Gerät ist belegt", "ポートは使用中です", "device not found"):
            self.assertEqual(self.code(serial.SerialException(errno.EBUSY, text)), "E_PORT_BUSY", text)
            self.assertEqual(self.code(serial.SerialException(errno.ENOENT, text)), "E_NO_DEVICE", text)

    def test_pyserial_windows_wording_fallback(self):
        # pyserial 3.5 serialwin32.py:64 -> "could not open port 'COM3': <repr(WinError())>"; text is localised,
        # the numbers and class names are not
        busy = serial.SerialException("could not open port 'COM3': PermissionError(13, 'Access is denied.', None, 5)")
        self.assertEqual(self.code(busy), "E_PORT_BUSY")
        french = serial.SerialException("could not open port 'COM3': PermissionError(13, \"L'accès est refusé.\", None, 5)")
        self.assertEqual(self.code(french), "E_PORT_BUSY")
        missing = serial.SerialException(
            "could not open port 'COM99': FileNotFoundError(2, 'The system cannot find the file specified.', None, 2)")
        self.assertEqual(self.code(missing, "COM99"), "E_NO_DEVICE")
        self.assertEqual(self.code(serial.SerialException("[WinError 5] whatever")), "E_PORT_BUSY")
        self.assertEqual(self.code(serial.SerialException("[Errno 16] Resource busy: '/dev/cu.x'")), "E_PORT_BUSY")

    def test_unclassifiable_is_internal_with_detail(self):
        err = classify_open_error(serial.SerialException("something odd"), "COM3")
        self.assertEqual(err.code, "E_INTERNAL")
        self.assertIn("something odd", err.detail)
        self.assertIsInstance(classify_open_error(BridgeError("E_CANCELLED", "x")), BridgeError)

    def test_messages_name_the_port_and_say_what_to_do(self):
        e = classify_open_error(_os_error(errno.EBUSY), "COM7")
        self.assertIn("COM7", e.message)
        self.assertIn("Retry", e.hint)
        e = classify_open_error(_os_error(errno.ENOENT), "/dev/cu.usbserial-0001")
        self.assertIn("cable", e.hint)
        self.assertIn("errno=", e.detail)


class OpenPolicyTableTests(TimedCase):
    """The protocol section 7 table as data (pure)."""

    def test_table_contents(self):
        P = linkmod.OPEN_POLICIES
        self.assertEqual(set(P), {"default", "win-cp210x", "pty", "url"})
        self.assertEqual(P["default"]["open"], ("open",))                       # pyserial defaults
        self.assertEqual(P["default"]["close"], ("rts=0", "dtr=0", "close"))    # RTS then DTR
        self.assertEqual(P["win-cp210x"]["open"], ("dtr=0", "rts=0", "open", "dtr=1", "rts=1"))
        self.assertEqual(P["win-cp210x"]["close"], ("rts=0", "dtr=0", "close"))
        self.assertEqual(P["url"]["close"], ("close",))
        self.assertTrue(P["pty"]["tolerate"] and P["url"]["tolerate"])
        for name, pol in P.items():
            self.assertIn("evidence", pol, name)
            i_rts = pol["close"].index("rts=0") if "rts=0" in pol["close"] else -1
            if i_rts >= 0:
                self.assertLess(i_rts, pol["close"].index("dtr=0"), name)

    def test_auto_selection(self):
        sel = linkmod.select_policy
        self.assertEqual(sel("auto", "device", "darwin"), "default")
        self.assertEqual(sel("auto", "device", "linux"), "default")
        self.assertEqual(sel("auto", "device", "win32"), "default")
        self.assertEqual(sel("auto", "device", "win32", vid=0x10C4), "default")   # NOT auto until S-08
        self.assertEqual(sel("auto", "url", "darwin"), "url")
        self.assertEqual(sel("auto", "pty", "linux"), "pty")
        self.assertEqual(sel("win-cp210x", "device", "darwin"), "win-cp210x")      # selectable by name
        self.assertFalse(linkmod.AUTO_SELECT_WIN_CP210X)
        old = linkmod.AUTO_SELECT_WIN_CP210X
        try:
            linkmod.AUTO_SELECT_WIN_CP210X = True
            self.assertEqual(sel("auto", "device", "win32", vid=0x10C4), "win-cp210x")
            self.assertEqual(sel("auto", "device", "win32", vid=0x1A86), "default")
            self.assertEqual(sel("auto", "device", "darwin", vid=0x10C4), "default")
        finally:
            linkmod.AUTO_SELECT_WIN_CP210X = old
        with self.assertRaises(BridgeError) as cm:
            sel("bogus", "device")
        self.assertEqual(cm.exception.code, "E_PROTOCOL")

    def test_port_kind_and_normalize(self):
        self.assertEqual(linkmod.port_kind("socket://127.0.0.1:1"), "url")
        self.assertEqual(linkmod.port_kind("rfc2217://h:2217"), "url")
        self.assertEqual(linkmod.port_kind("/dev/ttys004"), "pty")
        self.assertEqual(linkmod.port_kind("/dev/pts/3"), "pty")
        self.assertEqual(linkmod.port_kind("/dev/cu.usbserial-0001"), "device")
        self.assertEqual(linkmod.port_kind("/dev/ttyS0"), "device")        # a real UART, not a pty
        self.assertEqual(linkmod.port_kind("COM10"), "device")
        self.assertEqual(linkmod.normalize_port("/dev/tty.usbserial-0001", "darwin"), "/dev/cu.usbserial-0001")
        self.assertEqual(linkmod.normalize_port("/dev/ttyUSB0", "linux"), "/dev/ttyUSB0")
        self.assertEqual(linkmod.normalize_port("COM3", "win32"), "COM3")


class SourceHygieneTests(TimedCase):
    """The bridge's own code imports only the stdlib and pyserial (CLAUDE.md rule 3); no firmware names."""

    def test_imports(self):
        import ast
        allowed = {"__future__", "contextlib", "errno", "os", "re", "struct", "sys", "threading", "time",
                   "serial", "errors", "urllib", "ipaddress"}
        for name in ("link.py", "errors.py"):
            with open(os.path.join(ROOT, "bridge", name), encoding="utf-8") as f:
                tree = ast.parse(f.read())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    mods = [a.name.split(".")[0] for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    mods = [] if node.level else [(node.module or "").split(".")[0]]
                else:
                    continue
                for m in mods:
                    self.assertIn(m, allowed, "%s imports %s" % (name, m))

    def test_no_firmware_specific_strings(self):
        for name in ("link.py", "errors.py"):
            with open(os.path.join(ROOT, "bridge", name), encoding="utf-8") as f:
                text = f.read().lower()
            for word in ("wsu", "shield"):
                self.assertNotIn(word, text, name)

    def test_held_key_is_case_insensitive_for_com_ports(self):
        self.assertEqual(linkmod._held_key("com3"), linkmod._held_key("COM3"))
        self.assertNotEqual(linkmod._held_key("/dev/cu.A"), linkmod._held_key("/dev/cu.a"))


class SafeModeTests(TimedCase):
    def check(self, port, **env):
        linkmod.safe_mode_check(port, environ=env)

    def test_off_when_unset_or_zero(self):
        self.check("/dev/cu.usbserial-0001")
        self.check("COM3", MPY_SAFE_MODE="0")
        self.check("COM3", MPY_SAFE_MODE="")

    def test_refuses_real_ports(self):
        for port in ("/dev/cu.usbserial-0001", "/dev/ttyUSB0", "COM3", "/dev/tty.usbserial-0001", "auto"):
            with self.assertRaises(BridgeError) as cm:
                self.check(port, MPY_SAFE_MODE="1")
            self.assertEqual(cm.exception.code, "E_SAFE_MODE", port)
            self.assertIn(port, cm.exception.message)

    def test_real_port_must_match_exactly_and_never_auto(self):
        self.check("/dev/cu.usbserial-0001", MPY_SAFE_MODE="1", MPY_REAL_PORT="/dev/cu.usbserial-0001")
        for real in ("auto", "AUTO", "/dev/cu.usbserial-0002", "/dev/cu.usbserial-0001 ", ""):
            with self.assertRaises(BridgeError):
                self.check("/dev/cu.usbserial-0001", MPY_SAFE_MODE="1", MPY_REAL_PORT=real)
        with self.assertRaises(BridgeError):
            self.check("auto", MPY_SAFE_MODE="1", MPY_REAL_PORT="auto")

    def test_urls_to_this_machine_are_allowed(self):
        for port in ("socket://127.0.0.1:5555", "socket://localhost:5555", "rfc2217://127.0.0.1:2217",
                     "loop://", "socket://[::1]:5555"):
            self.check(port, MPY_SAFE_MODE="1")

    def test_urls_that_may_reach_real_devices_are_refused(self):
        for port in ("socket://192.168.1.20:5555", "rfc2217://lab-pc:2217", "spy:///dev/cu.usbserial-0001",
                     "hwgrep://10C4:EA60", "alt:///dev/ttyUSB0"):
            with self.assertRaises(BridgeError) as cm:
                self.check(port, MPY_SAFE_MODE="1")
            self.assertEqual(cm.exception.code, "E_SAFE_MODE", port)

    def test_ptys_only_when_registered_by_the_harness(self):
        with self.assertRaises(BridgeError):
            self.check("/dev/ttys777", MPY_SAFE_MODE="1")
        self.check("/dev/ttys777", MPY_SAFE_MODE="1", MPY_HARNESS_PTYS=os.pathsep.join(["/dev/ttys1", "/dev/ttys777"]))
        with self.assertRaises(ValueError):
            linkmod.allow_harness_pty("/dev/cu.usbserial-0001")      # a real port can never be registered
        with self.assertRaises(BridgeError):                          # ... nor smuggled in through the env var
            self.check("/dev/cu.usbserial-0001", MPY_SAFE_MODE="1", MPY_HARNESS_PTYS="/dev/cu.usbserial-0001")

    def test_open_refuses_before_any_serial_call(self):
        created = []
        lk = Link(serial_factory=stub_factory(created))
        for port in ("/dev/cu.usbserial-0001", "COM3", "/dev/ttys999"):
            with self.assertRaises(BridgeError) as cm:
                lk.open(port)
            self.assertEqual(cm.exception.code, "E_SAFE_MODE")
        self.assertEqual(created, [], "safe mode must refuse before the serial object is even constructed")
        self.assertFalse(lk.is_open)

    def test_is_active_helper(self):
        self.assertTrue(linkmod.safe_mode_active({"MPY_SAFE_MODE": "1"}))
        self.assertTrue(linkmod.safe_mode_active({"MPY_SAFE_MODE": "yes"}))
        self.assertFalse(linkmod.safe_mode_active({}))
        self.assertFalse(linkmod.safe_mode_active({"MPY_SAFE_MODE": "0"}))


# ============================================================================ policy sequencing (stub serial)

class PolicySequenceTests(TimedCase):
    """PINS 08.5 (software side): the open/close line sequences are exactly the table's; no resets."""

    def open_link(self, port="socket://127.0.0.1:9", policy="auto", **fail):
        created = []
        lk = Link(serial_factory=stub_factory(created, **fail))
        info = lk.open(port, policy=policy)
        self.addCleanup(lk.close)
        return lk, created[0], info

    def test_default_policy_posix_device(self):
        # not a real device: the stub factory stands in; MPY_REAL_PORT is not needed because we use
        # a harness-registered pty-looking name and force the policy
        linkmod.allow_harness_pty("/dev/ttys881")
        self.addCleanup(linkmod._HARNESS_PTYS.discard, "/dev/ttys881")
        lk, ser, info = self.open_link("/dev/ttys881", policy="default")
        self.assertEqual(info["policy"], "default")
        self.assertEqual(ser.events, [("open",)])           # open touches no modem line
        lk.close()
        self.assertEqual(ser.events, [("open",), ("rts", False), ("dtr", False), ("close",)])
        self.assertEqual(ser.kw["exclusive"], True)
        self.assertEqual(ser.kw["baudrate"], 115200)

    def test_cp210x_windows_sequence_is_selectable_by_name(self):
        linkmod.allow_harness_pty("/dev/ttys882")
        self.addCleanup(linkmod._HARNESS_PTYS.discard, "/dev/ttys882")
        lk, ser, info = self.open_link("/dev/ttys882", policy="win-cp210x")
        self.assertEqual(ser.events, [("dtr", False), ("rts", False), ("open",), ("dtr", True), ("rts", True)])
        lk.close()
        self.assertEqual(ser.events[5:], [("rts", False), ("dtr", False), ("close",)])

    def test_url_policy_close_is_plain(self):
        lk, ser, info = self.open_link()
        self.assertEqual(info["policy"], "url")
        lk.close()
        self.assertEqual(ser.events, [("open",), ("close",)])      # no modem-line writes at all

    def test_twenty_cycles_never_pulse_lines(self):
        linkmod.allow_harness_pty("/dev/ttys883")
        self.addCleanup(linkmod._HARNESS_PTYS.discard, "/dev/ttys883")
        created = []
        lk = Link(serial_factory=stub_factory(created))
        for _ in range(20):
            lk.open("/dev/ttys883", policy="default")
            lk.close()
        self.assertEqual(len(created), 20)
        for ser in created:
            lines = [e for e in ser.events if e[0] in ("dtr", "rts")]
            self.assertEqual(lines, [("rts", False), ("dtr", False)])
            self.assertNotIn(("rts", True), ser.events)
            self.assertFalse([e for e in ser.events if e[0] == "write"])    # nothing sent to the board

    def test_pty_tolerates_unsupported_modem_lines(self):
        linkmod.allow_harness_pty("/dev/ttys884")
        self.addCleanup(linkmod._HARNESS_PTYS.discard, "/dev/ttys884")
        enotty = OSError(errno.ENOTTY, "Inappropriate ioctl for device")
        lk, ser, info = self.open_link("/dev/ttys884", rts=enotty, dtr=enotty)
        self.assertEqual(info["policy"], "pty")
        lk.close()                                   # must not raise and must still close the port
        self.assertEqual(ser.events[-1], ("close",))
        self.assertFalse(ser.is_open)

    def test_close_always_closes_even_if_a_line_write_fails(self):
        linkmod.allow_harness_pty("/dev/ttys885")
        self.addCleanup(linkmod._HARNESS_PTYS.discard, "/dev/ttys885")
        logs = []
        created = []
        lk = Link(serial_factory=stub_factory(created, rts=OSError(errno.EIO, "gone")),
                  log=lambda level, msg: logs.append((level, msg)))
        lk.open("/dev/ttys885", policy="default")
        lk.close()
        self.assertFalse(created[0].is_open)
        self.assertTrue([l for l in logs if l[0] == "warn"], "a failed line write is logged, not swallowed")

    def test_open_failure_is_classified_and_releases_everything(self):
        created = []
        lk = Link(serial_factory=stub_factory(created, open=serial.SerialException(errno.EAGAIN, "Could not exclusively lock port x")))
        with self.assertRaises(BridgeError) as cm:
            lk.open("socket://127.0.0.1:9")
        self.assertEqual(cm.exception.code, "E_PORT_BUSY")
        self.assertFalse(lk.is_open)
        self.assertEqual(linkmod._HELD & {"socket://127.0.0.1:9"}, set())
        self.assertEqual(created[0].events[-1], ("close",))

    def test_bad_url_is_protocol_error(self):
        def factory(port, **kw):
            raise ValueError("invalid URL, protocol 'loopy' not known")
        lk = Link(serial_factory=factory)
        with self.assertRaises(BridgeError) as cm:
            lk.open("socket://127.0.0.1:9")
        self.assertEqual(cm.exception.code, "E_PROTOCOL")
        self.assertIn("loopy", cm.exception.detail)
        self.assertFalse(lk.is_open)
        self.assertEqual(linkmod._HELD & {"socket://127.0.0.1:9"}, set())
        with self.assertRaises(BridgeError) as cm:        # and a real unknown scheme is refused by safe mode first
            Link().open("loopy://nowhere")
        self.assertEqual(cm.exception.code, "E_SAFE_MODE")

    def test_hard_reset_sequence_and_refusals(self):
        created = []
        # a CP210x behind a device path: use a pty-looking name so safe mode lets the stub through
        linkmod.allow_harness_pty("/dev/ttys886")
        self.addCleanup(linkmod._HARNESS_PTYS.discard, "/dev/ttys886")
        lk = Link(serial_factory=stub_factory(created))
        lk.open("/dev/ttys886", policy="default", usb_ids=(0x10C4, 0xEA60))
        self.addCleanup(lk.close)
        # the "pty" kind has no modem lines, so hard reset refuses even with usb ids
        with self.assertRaises(BridgeError) as cm:
            lk.hard_reset(wait=0.05)
        self.assertEqual(cm.exception.code, "E_UNSUPPORTED")
        self.assertEqual([e for e in created[0].events if e[0] in ("dtr", "rts")], [])

    def test_hard_reset_pulse_on_known_adapter(self):
        created = []
        lk = Link(serial_factory=stub_factory(created))
        lk.open("socket://127.0.0.1:9", usb_ids=(0x10C4, 0xEA60))
        self.addCleanup(lk.close)
        lk._kind = "device"          # pretend a real device behind the stub (the stub touches no OS resource)
        ok, why = lk.can_hard_reset()
        self.assertTrue(ok, why)
        res = lk.hard_reset(confirm=linkmod.RESET_CONFIRMED, wait=0.05)      # tiers above soft need the explicit confirm token
        self.assertEqual(res, "silent")
        lines = [e for e in created[0].events if e[0] in ("dtr", "rts")]
        self.assertEqual(lines, [("dtr", False), ("rts", True), ("rts", False)])   # esptool HardReset
        saved = linkmod.lookup_usb_ids
        linkmod.lookup_usb_ids = lambda d: None           # never enumerate real ports in tests
        self.addCleanup(setattr, linkmod, "lookup_usb_ids", saved)
        for vid in (0x303A, 0x2E8A, None):
            lk._usb_ids = (vid, None)
            ok, why = lk.can_hard_reset()
            self.assertFalse(ok, vid)            # informational: not a known auto-reset UART bridge
            # NOTE (D-16, 2026-10-13): which adapters are believed wired for a pulse is POLICY and lives in bridge/resetcap.py
            # (the estimator) and the server (`reset.hard` answers E_UNSUPPORTED for unlikely/failed/method none unless
            # force:true).  The Link only needs the confirm token and usable lines; see tests/test_reset_tiers.py.

    def test_only_hard_reset_can_reach_the_rts_pulse(self):
        with open(os.path.join(ROOT, "bridge", "link.py"), encoding="utf-8") as f:
            src = f.read()
        uses = [m.start() for m in re.finditer(r"HARD_RESET_STEPS", src)]
        self.assertEqual(len(uses), 2, "definition + the single use in hard_reset()")
        use_line = src[:uses[1]].count("\n")
        defs = [i for i, l in enumerate(src.splitlines()) if l.startswith("    def hard_reset")]
        nxt = [i for i, l in enumerate(src.splitlines()) if l.startswith("    def ") and i > defs[0]][0]
        self.assertTrue(defs[0] < use_line < nxt)


# ============================================================================ sync_to_prompt

class SyncToPromptTests(LinkTestCase):
    """PINS 02.4, 05.12 (no blind Ctrl-C into a starting REPL), 02.10 (connect does not reset), 08.5."""

    def test_prompt_already_visible_sends_nothing(self):
        srv = self.server(greeting=BANNER_PROMPT)
        lk = self.new_link()
        lk.open(srv.url)
        # the window ends early once a prompt has been quiet for 30 ms, so a long window costs nothing
        self.assertEqual(lk.sync_to_prompt(listen_ms=3000, nudge_ms=300), "prompt")
        self.assertEqual(bytes(srv.rx), b"")
        self.assertEqual(lk.mode, "friendly")
        self.assertTrue(lk.sync_bytes.endswith(b">>> "))

    def test_silent_idle_repl_is_woken_with_a_bare_newline_only(self):
        srv, lk = self.connected()
        t0 = time.monotonic()
        self.assertEqual(lk.sync_to_prompt(listen_ms=100, nudge_ms=500), "prompt")
        self.assertLess(time.monotonic() - t0, 0.5)
        self.assertEqual(bytes(srv.rx), b"\r\n")
        self.assertEqual(srv.count("softreset"), 0)

    def test_running_program_is_left_alone(self):
        self.write_file("main.py", LOOP_MAIN)
        srv, lk = self.connected(self.server(run_main_on_connect=True))
        self.assertEqual(lk.sync_to_prompt(listen_ms=250, nudge_ms=250), "running-program")
        self.assertEqual(bytes(srv.rx), b"", "nothing at all may be sent to a running program")
        self.assertIn(b"tick", lk.sync_bytes)
        self.assertEqual(srv.count("interrupt"), 0)
        self.assertEqual(srv.count("softreset"), 0)

    def test_silent_program_gets_only_the_nudge(self):
        self.write_file("main.py", SILENT_MAIN)
        srv, lk = self.connected(self.server(run_main_on_connect=True))
        self.assertEqual(lk.sync_to_prompt(listen_ms=100, nudge_ms=200), "silent")
        self.assertEqual(bytes(srv.rx), b"\r\n")
        self.assertEqual(srv.count("interrupt"), 0)

    def test_sync_streams_bytes_to_callback(self):
        srv = self.server(greeting=b"hello\r\n" + BANNER_PROMPT)
        lk = self.new_link()
        lk.open(srv.url)
        seen = []
        self.assertEqual(lk.sync_to_prompt(listen_ms=3000, on_data=seen.append), "prompt")
        self.assertTrue(b"".join(seen).startswith(b"hello"))


# ============================================================================ raw REPL

class RawReplTests(LinkTestCase):
    """PINS 02.10 (file ops do not soft-reset), 08.14 (raw soft reset runs boot.py, not main.py)."""

    def test_enter_and_exit_without_soft_reset(self):
        srv, lk = self.connected()
        lk.sync_to_prompt(listen_ms=50)
        srv.rx.clear()
        self.assertEqual(lk.enter_raw(soft_reset=False), b"")
        self.assertEqual(lk.mode, "raw")
        self.assertEqual(bytes(srv.rx), b"\x03\x01")             # Ctrl-C once, Ctrl-A; no Ctrl-D
        self.assertEqual(srv.count("softreset"), 0)
        self.assertEqual(lk.exec("print(6*7)"), (b"42\r\n", b""))
        srv.rx.clear()
        self.assertTrue(lk.exit_raw())
        self.assertEqual(lk.mode, "friendly")
        self.assertEqual(bytes(srv.rx), b"\x02")                  # no redraw: REPL not attached
        self.assertEqual(srv.count("softreset"), 0)

    def test_enter_raw_twice_and_from_inside_raw(self):
        srv, lk = self.connected()
        lk.enter_raw()
        lk.enter_raw()          # already raw: Ctrl-C clears the line, Ctrl-A prints the banner again
        self.assertEqual(lk.exec("print('ok')")[0], b"ok\r\n")

    def test_enter_raw_with_soft_reset_runs_boot_not_main(self):
        self.write_file("boot.py", "print('boot-ran')\n")
        self.write_file("main.py", "print('main-ran')\n")
        srv, lk = self.connected()
        boot = lk.enter_raw(soft_reset=True)
        self.assertIn(b"boot-ran", boot)
        self.assertNotIn(b"main-ran", boot)
        self.assertEqual(srv.count("softreset"), 1)
        self.assertEqual(lk.exec("print(1)")[0], b"1\r\n")
        self.assertTrue(lk.exit_raw())
        # Ctrl-D at the friendly prompt DOES run main.py
        seen = []
        self.assertEqual(lk.soft_reset_friendly(wait=1.0, on_data=seen.append), "prompt")
        out = b"".join(seen)
        self.assertIn(b"boot-ran", out)
        self.assertIn(b"main-ran", out)
        self.assertEqual(srv.count("softreset"), 2)

    def test_board_left_in_raw_repl_by_someone_else(self):
        srv = self.server(greeting=b"raw REPL; CTRL-B to exit\r\n>")
        lk = self.new_link()
        lk.open(srv.url)
        self.assertEqual(lk.sync_to_prompt(listen_ms=3000), "prompt")
        self.assertEqual(lk.mode, "raw")

    def test_soft_reset_friendly_reports_running_program(self):
        self.write_file("main.py", LOOP_MAIN)
        srv, lk = self.connected()
        lk.sync_to_prompt(listen_ms=50)
        seen = []
        self.assertEqual(lk.soft_reset_friendly(wait=0.6, on_data=seen.append), "running-program")
        self.assertIn(b"tick", b"".join(seen))
        self.assertEqual(srv.count("softreset"), 1)
        self.assertTrue(lk.interrupt())                 # the explicit Stop still works afterwards

    def test_exit_raw_redraws_when_repl_attached(self):
        srv, lk = self.connected()
        lk.enter_raw()
        seen = []
        lk.attach_repl(seen.append)
        self.assertTrue(lk.exit_raw())
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline and not b"".join(seen).endswith(b">>> "):
            time.sleep(0.01)
        self.assertTrue(b"".join(seen).endswith(b">>> "), seen)
        self.assertTrue(bytes(srv.rx).endswith(b"\x02\r"))

    def test_garbage_before_banner(self):
        srv = self.server(board_factory=lambda r, s, l: GarbageBoard(r, s, l))
        lk = self.new_link()
        lk.open(srv.url)
        lk.enter_raw()
        self.assertEqual(lk.exec("print('after garbage')")[0], b"after garbage\r\n")

    def test_delayed_banner_and_timeout(self):
        srv = self.server(board_factory=slow_banner_board(0.5))
        lk = self.new_link()
        lk.open(srv.url)
        lk.enter_raw(timeout=3.0)                    # waits for the banner, no fixed sleep
        lk.exit_raw()
        t0 = time.monotonic()
        with self.assertRaises(BridgeError) as cm:
            lk.enter_raw(timeout=0.2)
        self.assertEqual(cm.exception.code, "E_RAW_REPL_TIMEOUT")
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_exec_outside_raw_mode_is_a_programming_error(self):
        srv, lk = self.connected()
        with self.assertRaises(BridgeError) as cm:
            lk.exec("1")
        self.assertEqual(cm.exception.code, "E_INTERNAL")

    def test_empty_code_is_never_sent_as_an_empty_buffer(self):
        """Ctrl-D on an empty raw-REPL buffer is a soft reset; exec("") must not become one (both paths)."""
        for factory in (None, lambda r, s_, l: OldFirmwareBoard(r, s_, l)):
            srv = self.server(board_factory=factory)
            lk = self.new_link()
            lk.open(srv.url)
            lk.enter_raw()
            for code in ("", "   \n", b""):
                self.assertEqual(lk.exec(code), (b"", b""))
            self.assertEqual(srv.count("softreset"), 0)
            lk.close()

    def test_control_characters_in_code_are_rejected_not_hung(self):
        srv, lk = self.connected()
        lk.enter_raw()
        for bad in ("x = '\x04'", b"print(1)\x03"):
            with self.assertRaises(BridgeError) as cm:
                lk.exec(bad)
            self.assertEqual(cm.exception.code, "E_PROTOCOL")
        self.assertEqual(lk.exec("print(2)")[0], b"2\r\n")      # link still healthy


class IgnoresCtrlCTests(LinkTestCase):
    """PINS 08.13 (swallowed KeyboardInterrupt: classified, bounded, no traceback, hint), 02.12 (no unbounded wait)."""

    def test_enter_raw_times_out_with_hint_within_bound(self):
        self.write_file("main.py", SILENT_MAIN)
        srv = self.server(board_factory=lambda r, s, l: IgnoreCtrlCBoard(r, s, l), run_main_on_connect=True)
        lk = self.new_link()
        lk.open(srv.url)
        t0 = time.monotonic()
        with self.assertRaises(BridgeError) as cm:
            lk.enter_raw(timeout=0.6)
        took = time.monotonic() - t0
        self.assertLess(took, 0.6 + 0.6)
        self.assertGreaterEqual(took, 0.55)
        e = cm.exception
        self.assertEqual(e.code, "E_RAW_REPL_TIMEOUT")
        self.assertIn("Ctrl-C", e.hint)
        self.assertIn("timed out", e.detail)
        self.assertEqual(lk.mode, "unknown")
        self.assertEqual(srv.count("softreset"), 0)
        self.assertTrue(lk.is_open)                      # still usable
        self.assertFalse(lk.interrupt(timeout=0.4))      # Stop reports "not stopped" instead of hanging


# ============================================================================ exec

class ExecTests(LinkTestCase):
    def raw(self):
        srv, lk = self.connected()
        lk.enter_raw()
        return srv, lk

    def test_basic_output_and_state_between_calls(self):
        srv, lk = self.raw()
        self.assertEqual(lk.exec("x = 41"), (b"", b""))
        self.assertEqual(lk.exec("print(x + 1)"), (b"42\r\n", b""))
        self.assertEqual(lk.exec("import os\nprint(os.listdir('/'))")[1], b"")
        self.assertEqual(lk.exec("print('naïve ✓')")[0].decode("utf-8"), "naïve ✓\r\n")
        self.assertTrue(lk.raw_paste_supported)

    def test_error_framing_traceback_goes_to_err(self):
        srv, lk = self.raw()
        out, err = lk.exec("1/0")
        self.assertEqual(out, b"")
        self.assertIn(b"Traceback", err)
        self.assertIn(b"ZeroDivisionError", err)
        out, err = lk.exec("print('before')\nundefined_name")
        self.assertEqual(out, b"before\r\n")
        self.assertIn(b"NameError", err)
        out, err = lk.exec("def f(:\n  pass")
        self.assertIn(b"SyntaxError", err)
        self.assertEqual(lk.exec("print('still fine')"), (b"still fine\r\n", b""))

    def test_large_code_through_raw_paste_flow_control(self):
        srv, lk = self.raw()
        blob = "".join(chr(97 + (i * 7) % 26) for i in range(40000))
        code = "s = %r\nprint(len(s), sum(map(ord, s)))\n" % blob
        out, err = lk.exec(code, timeout=10)
        self.assertEqual(err, b"")
        self.assertEqual(out.decode().split(), [str(len(blob)), str(sum(map(ord, blob)))])
        self.assertTrue(lk.raw_paste_supported)

    def test_raw_paste_requested_per_command_when_supported(self):
        srv, lk = self.raw()
        for i in range(3):
            lk.exec("print(%d)" % i)
        # supported: raw paste is requested per command (the request is part of the protocol)
        self.assertEqual(bytes(srv.rx).count(b"\x05A\x01"), 3)
        self.assertTrue(lk.raw_paste_supported)

    def test_without_raw_paste_old_firmware(self):
        srv = self.server(board_factory=lambda r, s, l: OldFirmwareBoard(r, s, l))
        lk = self.new_link()
        lk.open(srv.url)
        lk.enter_raw()
        self.assertEqual(lk.exec("print(7)"), (b"7\r\n", b""))
        self.assertFalse(lk.raw_paste_supported)
        blob = "z" * 3000
        out, err = lk.exec("s = %r\nprint(len(s))" % blob)
        self.assertEqual((out, err), (b"3000\r\n", b""))
        self.assertIn(b"ZeroDivisionError", lk.exec("1/0")[1])
        self.assertEqual(bytes(srv.rx).count(b"\x05A\x01"), 1)       # probed once, then never again

    def test_without_raw_paste_r0_reply(self):
        srv = self.server(board_factory=lambda r, s, l: PasteR0Board(r, s, l))
        lk = self.new_link()
        lk.open(srv.url)
        lk.enter_raw()
        self.assertEqual(lk.exec("print('r0')"), (b"r0\r\n", b""))
        self.assertFalse(lk.raw_paste_supported)
        self.assertEqual(lk.exec("print('again')"), (b"again\r\n", b""))

    def test_raw_paste_can_be_disabled(self):
        srv = self.server()
        lk = self.new_link(raw_paste=False)
        lk.open(srv.url)
        lk.enter_raw()
        self.assertEqual(lk.exec("print('np')"), (b"np\r\n", b""))
        self.assertNotIn(b"\x05A", bytes(srv.rx))
        self.assertFalse(lk.raw_paste_supported)

    def test_exec_timeout_is_bounded_and_recoverable(self):
        """PINS 08.10 (silent device op dies by timeout, not forever), 02.12."""
        srv, lk = self.raw()
        t0 = time.monotonic()
        with self.assertRaises(BridgeError) as cm:
            lk.exec("import time\ntime.sleep(1.5)\nprint('late')", timeout=0.3)
        self.assertEqual(cm.exception.code, "E_BOARD_UNRESPONSIVE")
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertEqual(lk.mode, "unknown")
        with self.assertRaises(BridgeError):                 # framing in doubt: must re-enter raw mode
            lk.exec("print(1)")
        time.sleep(1.4)                                      # let the fake's sleep finish
        lk.enter_raw()
        self.assertEqual(lk.exec("print('recovered')")[0], b"recovered\r\n")

    def test_cancel_event(self):
        srv, lk = self.raw()
        cancel = threading.Event()
        threading.Timer(0.2, cancel.set).start()
        t0 = time.monotonic()
        with self.assertRaises(BridgeError) as cm:
            lk.exec_stream("import time\nwhile True:\n    time.sleep(0.01)", lambda b: None, cancel=cancel)
        self.assertEqual(cm.exception.code, "E_CANCELLED")
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertTrue(lk.interrupt())                      # the program is still running: stop it
        lk.enter_raw()
        self.assertEqual(lk.exec("print('ok')")[0], b"ok\r\n")

    def test_exec_stream_is_incremental(self):
        srv, lk = self.raw()
        stamps = []
        code = "import time\nprint('first')\ntime.sleep(0.3)\nprint('second')\ntime.sleep(0.3)\nprint('third')\n"
        t0 = time.monotonic()
        err = lk.exec_stream(code, lambda b: stamps.append((time.monotonic() - t0, b)))
        total = time.monotonic() - t0
        self.assertEqual(err, b"")
        text = b"".join(b for _, b in stamps)
        self.assertEqual(text, b"first\r\nsecond\r\nthird\r\n")
        first_t = next(t for t, b in stamps if b"first" in b)
        second_t = next(t for t, b in stamps if b"second" in b)
        self.assertLess(first_t, 0.25, "first line must arrive long before the program ends")
        self.assertGreater(second_t - first_t, 0.2)
        self.assertGreater(total - first_t, 0.5)

    def test_exception_in_consumer_leaves_link_resyncable(self):
        srv, lk = self.raw()

        def bad(b):
            raise RuntimeError("consumer bug")

        with self.assertRaises(RuntimeError):
            lk.exec_stream("print('x')\nprint('y')", bad)
        self.assertEqual(lk.mode, "unknown")
        lk.enter_raw()
        self.assertEqual(lk.exec("print('fine')")[0], b"fine\r\n")

    def test_non_oserror_from_the_serial_object_is_internal_not_unplug(self):
        class BuggySerial(StubSerial):
            def read(self, n=1):
                raise TypeError("a bug in the serial layer")
        created = []
        lk = self.new_link(serial_factory=lambda port, **kw: created.append(BuggySerial(port, **kw)) or created[-1])
        lk.open("socket://127.0.0.1:9")
        with self.assertRaises(BridgeError) as cm:
            lk.sync_to_prompt(listen_ms=30)
        self.assertEqual(cm.exception.code, "E_INTERNAL")
        self.assertTrue(lk.is_open, "a bug must not be reported as an unplug")

    def test_exec_stream_returns_traceback_and_keeps_prompt_sync(self):
        srv, lk = self.raw()
        got = []
        err = lk.exec_stream("print('x')\nraise ValueError('boom')", got.append)
        self.assertEqual(b"".join(got), b"x\r\n")
        self.assertIn(b"ValueError: boom", err)
        self.assertEqual(lk.exec("print('next')")[0], b"next\r\n")

    def test_read_available_is_nonblocking(self):
        srv, lk = self.connected()
        t0 = time.monotonic()
        self.assertEqual(lk.read_available(), b"")
        self.assertLess(time.monotonic() - t0, 0.1)
        lk.write(b"\r")
        time.sleep(0.15)
        self.assertEqual(lk.read_available(), b"\r\n>>> ")
        self.assertEqual(lk.read_available(), b"")


class ChunkBoundaryTests(LinkTestCase):
    def test_markers_split_across_reads(self):
        self.write_file("boot.py", "print('boot-line')\n")
        srv = self.server(board_factory=lambda r, s_, l: ByteWiseBoard(r, s_, l))
        lk = self.new_link()
        lk.open(srv.url)
        self.assertEqual(lk.sync_to_prompt(listen_ms=50, nudge_ms=1000), "prompt")
        self.assertIn(b"boot-line", lk.enter_raw(soft_reset=True, timeout=5))
        self.assertEqual(lk.exec("print('a'*50)", timeout=5), (b"a" * 50 + b"\r\n", b""))
        self.assertIn(b"ZeroDivisionError", lk.exec("1/0", timeout=5)[1])
        got = []
        self.assertEqual(lk.exec_stream("print('streamed')", got.append, timeout=5), b"")
        self.assertEqual(b"".join(got), b"streamed\r\n")
        self.assertTrue(lk.exit_raw(timeout=5))

    def test_utf8_split_across_chunks_arrives_intact_as_bytes(self):
        srv = self.server(board_factory=lambda r, s_, l: ByteWiseBoard(r, s_, l))
        lk = self.new_link()
        lk.open(srv.url)
        lk.enter_raw(timeout=5)
        out, _ = lk.exec("print('é✓日本')", timeout=5)
        self.assertEqual(out.decode("utf-8"), "é✓日本\r\n")


class FloodTests(LinkTestCase):
    """Appendix G #19: a large output stream is read promptly (no per-byte slow path, no stall)."""

    def test_half_a_megabyte_of_output(self):
        srv, lk = self.connected()
        lk.enter_raw()
        n = [0]

        def count(b):
            n[0] += len(b)

        t0 = time.monotonic()
        err = lk.exec_stream("for i in range(500):\n    print('x' * 1022)\n", count, timeout=10)
        took = time.monotonic() - t0
        self.assertEqual(err, b"")
        self.assertEqual(n[0], 500 * 1024)
        self.assertLess(took, 5.0)
        self.assertEqual(lk.exec("print('after')")[0], b"after\r\n")


# ============================================================================ interrupt / pump / write

class InterruptTests(LinkTestCase):
    """PINS 02.7, 02.8, 05.4, 08.2 (Stop writes Ctrl-C on the owned connection; no echo/-e/tty hacks), 02.15."""

    def test_interrupt_running_program_in_raw_repl_fast(self):
        srv, lk = self.connected()
        lk.enter_raw()
        result = {}
        stream_out = []

        def run():
            try:
                result["err"] = lk.exec_stream("import time\nwhile True:\n    print('spin')\n    time.sleep(0.01)\n",
                                               stream_out.append)
            except BridgeError as e:           # pragma: no cover - reported by the assertion below
                result["exc"] = e

        th = threading.Thread(target=run)
        th.start()
        deadline = time.monotonic() + 3
        while not stream_out and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(stream_out, "program never started")
        srv.rx.clear()
        srv.rx_log[:] = []
        t0 = time.monotonic()
        stopped = lk.interrupt()
        latency = time.monotonic() - t0
        th.join(3)
        self.assertFalse(th.is_alive())
        self.assertTrue(stopped)
        self.assertLess(latency, 0.2, "interrupt latency")
        self.assertNotIn("exc", result)
        self.assertIn(b"KeyboardInterrupt", result["err"])
        # exactly two Ctrl-C bytes, ~50 ms apart, nothing else (no "-e ", no CR/LF from a shell echo).
        # interrupt() now replies on the FIRST prompt, so the server may still be reading the second byte.
        end = time.monotonic() + 1.0
        while len(srv.rx) < 2 and time.monotonic() < end:
            time.sleep(0.005)
        self.assertEqual(bytes(srv.rx), b"\x03\x03")
        gaps = [t for t, d in srv.rx_log]
        self.assertEqual(len(gaps), 2)
        self.assertTrue(0.04 <= gaps[1] - gaps[0] <= 0.15, gaps)
        self.assertEqual(srv.count("softreset"), 0)
        # the program ended with a traceback (normal framing): still in raw mode, usable immediately
        self.assertEqual(lk.mode, "raw")
        self.assertEqual(lk.exec("print('alive')")[0], b"alive\r\n")

    def test_interrupt_friendly_main_py_without_pump(self):
        self.write_file("main.py", LOOP_MAIN)
        srv, lk = self.connected(self.server(run_main_on_connect=True))
        self.assertEqual(lk.sync_to_prompt(listen_ms=200), "running-program")
        t0 = time.monotonic()
        self.assertTrue(lk.interrupt())
        self.assertLess(time.monotonic() - t0, 0.2)
        self.assertEqual(lk.sync_to_prompt(listen_ms=100, nudge_ms=300), "prompt")    # idle again
        self.assertEqual(srv.count("softreset"), 0)

    def test_interrupt_when_second_ctrl_c_arrives_while_the_first_is_being_handled(self):
        """PINS RQ-SAFE-3 (Stop always reaches the board). Regression for the flaky
        test_interrupt_friendly_main_py_without_pump (2 of 60 runs alone, 2 of 18 under 6-way load): the second Ctrl-C of a
        Stop arrived while the board was still handling the first KeyboardInterrupt, killed the fake board's worker
        thread, and no prompt was ever printed, so interrupt() timed out. A real MicroPython disables the interrupt
        character when it catches the exception, so the second Ctrl-C is just a REPL keystroke and the prompt always
        comes. Here the worker is held in the handler until the second Ctrl-C has been delivered (deterministic)."""
        self.write_file("main.py", LOOP_MAIN)
        srv, lk = self.connected(self.server(board_factory=lambda r, s, l: SecondCtrlCInHandlerBoard(r, s, l),
                                             run_main_on_connect=True))
        self.assertEqual(lk.sync_to_prompt(listen_ms=200), "running-program")
        t0 = time.monotonic()
        self.assertTrue(lk.interrupt(timeout=2.0))
        self.assertLess(time.monotonic() - t0, 1.0)
        board = srv.board
        self.assertTrue(board.handler_entered.is_set(), "the interleaving was not forced")
        self.assertTrue(board.second_ctrl_c.is_set(), "the interleaving was not forced")
        self.assertEqual(lk.sync_to_prompt(listen_ms=100, nudge_ms=300), "prompt")    # idle again
        self.assertEqual(srv.count("softreset"), 0)

    def test_raw_exec_stop_when_second_ctrl_c_arrives_while_the_first_is_being_handled(self):
        """Same interleaving for a program started by exec in the raw REPL: the framing (EOF marker, traceback,
        EOF marker, prompt) must still complete and the Link must be usable right away."""
        srv, lk = self.connected(self.server(board_factory=lambda r, s, l: SecondCtrlCInHandlerBoard(r, s, l)))
        lk.enter_raw()
        result = {}
        started = threading.Event()

        def run():
            try:
                result["err"] = lk.exec_stream("import time\nwhile True:\n    print('spin')\n    time.sleep(0.05)\n",
                                               lambda d: started.set(), timeout=1.5)
            except BridgeError as e:           # pragma: no cover - reported by the assertion below
                result["exc"] = e.code

        th = threading.Thread(target=run)
        th.start()
        self.assertTrue(started.wait(3), "program never started")
        self.assertTrue(lk.interrupt(timeout=2.0))
        th.join(5)
        self.assertFalse(th.is_alive())
        self.assertNotIn("exc", result)
        self.assertIn(b"KeyboardInterrupt", result["err"])
        self.assertTrue(srv.board.second_ctrl_c.is_set(), "the interleaving was not forced")
        self.assertEqual(lk.mode, "raw")
        self.assertEqual(lk.exec("print('alive')")[0], b"alive\r\n")
        self.assertEqual(srv.count("softreset"), 0)

    def test_interrupt_twice_and_when_idle(self):
        """Stop twice, stop when idle: both succeed quickly and never reset (Appendix G #10)."""
        srv, lk = self.connected()
        lk.sync_to_prompt(listen_ms=50)
        for _ in range(2):
            t0 = time.monotonic()
            self.assertTrue(lk.interrupt())
            self.assertLess(time.monotonic() - t0, 0.2)
        lk.enter_raw()
        t0 = time.monotonic()
        self.assertTrue(lk.interrupt())                   # idle raw prompt: nothing to wait for
        self.assertLess(time.monotonic() - t0, 0.1)
        self.assertEqual(srv.count("softreset"), 0)

    def test_interrupt_goes_through_while_a_session_holds_the_port(self):
        self.write_file("main.py", LOOP_MAIN)
        srv, lk = self.connected(self.server(run_main_on_connect=True))
        with lk.session():
            t = threading.Thread(target=lambda: lk.sync_to_prompt(listen_ms=100))
            t.start()                                       # waits for the op lock held by this thread
            time.sleep(0.05)
            t0 = time.monotonic()
            lk.write(b"\x03")                               # bypass path works while the op lock is taken
            self.assertLess(time.monotonic() - t0, 0.05)
        t.join(2)
        self.assertIn(b"\x03", bytes(srv.rx))

    def test_write_is_serialised_and_does_not_need_the_op_lock(self):
        srv, lk = self.connected()
        with lk.session():                                 # an op owns the port ...
            t0 = time.monotonic()
            lk.write(b"A" * 2000)                          # ... write() must not block on it
            self.assertLess(time.monotonic() - t0, 0.5)
        deadline = time.monotonic() + 2
        while len(srv.rx) < 2000 and time.monotonic() < deadline:
            time.sleep(0.01)
        a, b = b"A" * 1500, b"B" * 1500
        ts = [threading.Thread(target=lk.write, args=(x,)) for x in (a, b, a, b)]
        srv.rx.clear()
        for t in ts:
            t.start()
        for t in ts:
            t.join(2)
        deadline = time.monotonic() + 2
        while len(srv.rx) < 6000 and time.monotonic() < deadline:
            time.sleep(0.01)
        runs = re.findall(rb"A+|B+", bytes(srv.rx))
        self.assertTrue(all(len(r) % 1500 == 0 for r in runs), [len(r) for r in runs])   # no interleaving inside a write

    def test_stdin_style_write_while_program_runs(self):
        srv, lk = self.connected()
        lk.enter_raw()
        th = threading.Thread(target=lambda: lk.exec_stream("import time\nfor i in range(30):\n    time.sleep(0.02)\n", lambda b: None))
        th.start()
        time.sleep(0.1)
        srv.rx.clear()
        t0 = time.monotonic()
        lk.write(b"k")
        self.assertLess(time.monotonic() - t0, 0.05)
        th.join(5)
        self.assertEqual(bytes(srv.rx), b"k")


class PumpTests(LinkTestCase):
    """Pump thread: reads only while the REPL is attached and no op is running (Appendix G #9)."""

    def test_pump_forwards_and_pauses_for_ops(self):
        self.write_file("main.py", LOOP_MAIN)
        srv, lk = self.connected(self.server(run_main_on_connect=True))
        seen = []
        stamps = []

        def tap(data):
            seen.append(data)
            stamps.append(time.monotonic())

        lk.attach_repl(tap)
        time.sleep(0.4)
        self.assertIn(b"tick", b"".join(seen))
        n_before = len(seen)
        # an op takes over: the pump must not read while the session is held
        with lk.session():
            started = time.monotonic()
            time.sleep(0.4)
            ended = time.monotonic()
        late = [t for t in stamps if started + 0.05 < t < ended]
        self.assertEqual(late, [], "pump delivered bytes while an op owned the port")
        # ops preempt the pump promptly even though the board is spamming
        t0 = time.monotonic()
        lk.enter_raw()
        self.assertLess(time.monotonic() - t0, 1.5)
        self.assertEqual(lk.exec("print('x')")[0], b"x\r\n")
        lk.exit_raw()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and b">>> " not in b"".join(seen[n_before:]):
            time.sleep(0.01)
        self.assertIn(b">>> ", b"".join(seen[n_before:]), "pump resumes after the op and shows the redrawn prompt")
        lk.detach_repl()

    def test_interrupt_with_repl_attached_uses_the_pump_as_the_reader(self):
        """PINS 02.7/05.4 with the REPL tab open: Stop works and the REPL sees the traceback and prompt."""
        self.write_file("main.py", LOOP_MAIN)
        srv, lk = self.connected(self.server(run_main_on_connect=True))
        seen = []
        lk.attach_repl(seen.append)
        time.sleep(0.2)
        t0 = time.monotonic()
        self.assertTrue(lk.interrupt())
        self.assertLess(time.monotonic() - t0, 0.25)
        time.sleep(0.1)
        text = b"".join(seen)
        self.assertIn(b"KeyboardInterrupt", text)
        self.assertTrue(text.rstrip(b"\r\n").endswith(b">>>") or text.endswith(b">>> "), text[-80:])
        self.assertTrue(lk.interrupt(), "stop twice")
        lk.detach_repl()

    def test_keystrokes_written_while_attached_echo_through_the_pump(self):
        srv, lk = self.connected()
        seen = []
        lk.attach_repl(seen.append)
        lk.write(b"1+1\r")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not b"".join(seen).endswith(b"2\r\n>>> "):
            time.sleep(0.01)
        self.assertTrue(b"".join(seen).endswith(b"2\r\n>>> "), seen)
        lk.detach_repl()

    def test_unplug_while_pump_runs_notifies_once(self):
        srv, lk = self.connected()
        events = []
        lk.on_disconnect = events.append
        lk.attach_repl(lambda d: None)
        time.sleep(0.1)
        srv.kick()
        deadline = time.monotonic() + 2
        while not events and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].code, "E_NO_DEVICE")
        self.assertFalse(lk.is_open)
        with self.assertRaises(BridgeError) as cm:
            lk.write(b"x")
        self.assertEqual(cm.exception.code, "E_NO_DEVICE")


# ============================================================================ open / close / busy / unplug

class OpenCloseTests(LinkTestCase):
    def test_second_open_while_open(self):
        srv, lk = self.connected()
        with self.assertRaises(BridgeError) as cm:
            lk.open(srv.url)
        self.assertEqual(cm.exception.code, "E_ALREADY_CONNECTED")

    def test_calls_before_open_and_after_close(self):
        lk = self.new_link()
        for fn in (lambda: lk.write(b"x"), lambda: lk.sync_to_prompt(10), lambda: lk.enter_raw(),
                   lambda: lk.interrupt(), lambda: lk.check_alive(), lambda: lk.read_available()):
            with self.assertRaises(BridgeError) as cm:
                fn()
            self.assertEqual(cm.exception.code, "E_NOT_CONNECTED")
        srv, lk2 = self.connected()
        lk2.close()
        lk2.close()                                        # idempotent
        with self.assertRaises(BridgeError) as cm:
            lk2.write(b"x")
        self.assertEqual(cm.exception.code, "E_NOT_CONNECTED")

    def test_port_info(self):
        srv = self.server()
        lk = self.new_link()
        info = lk.open(srv.url, baud=57600)
        self.assertEqual(info["policy"], "url")
        self.assertEqual(info["kind"], "url")
        self.assertEqual(info["baud"], 57600)
        self.assertEqual(info["pyserial"], serial.__version__)
        self.assertEqual(info["port"], srv.url)
        self.assertFalse(info["canHardReset"])
        self.assertEqual(lk.port_info, info)

    def test_malformed_urls_are_protocol_errors(self):
        lk = self.new_link()
        for url in ("socket://127.0.0.1", "socket://127.0.0.1:99999", "rfc2217://localhost"):
            with self.assertRaises(BridgeError) as cm:
                lk.open(url)
            self.assertEqual(cm.exception.code, "E_PROTOCOL", url)
            self.assertIn("host:port", cm.exception.message)
        with self.assertRaises(BridgeError) as cm:
            lk.open("")
        self.assertEqual(cm.exception.code, "E_PROTOCOL")
        with self.assertRaises(BridgeError) as cm:
            lk.open(None)
        self.assertEqual(cm.exception.code, "E_PROTOCOL")

    def test_nothing_listening_is_no_device(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        lk = self.new_link()
        with self.assertRaises(BridgeError) as cm:
            lk.open("socket://127.0.0.1:%d" % port)
        self.assertEqual(cm.exception.code, "E_NO_DEVICE")
        self.assertIn("127.0.0.1", cm.exception.message)

    def test_exclusive_fake_second_link_is_busy_and_close_releases(self):
        """PINS 05.5 (partially: close() really releases the port), 08.12/05.11 (busy is diagnosed)."""
        srv = self.server(exclusive=True)
        a = self.new_link()
        a.open(srv.url)
        self.assertTrue(srv.wait_connected())
        b = self.new_link()
        with self.assertRaises(BridgeError) as cm:
            b.open(srv.url)
        self.assertEqual(cm.exception.code, "E_PORT_BUSY")
        self.assertIn("Retry", cm.exception.hint)
        self.assertFalse(b.is_open)
        a.close()
        self.assertTrue(srv.listening.wait(2.0))
        b.open(srv.url)                                    # released: the next Link gets in
        self.assertTrue(b.is_open)

    def test_exclusive_fake_seen_from_another_process_is_connection_refused(self):
        """Without our in-process registry (i.e. a second bridge process) a refused socket:// connection
        is indistinguishable from 'nothing listening'; it is classified from errno, as E_NO_DEVICE."""
        srv = self.server(exclusive=True)
        a = self.new_link()
        a.open(srv.url)
        self.assertTrue(srv.wait_connected())
        with linkmod._HELD_LOCK:
            saved = set(linkmod._HELD)
            linkmod._HELD.clear()
        try:
            b = self.new_link()
            with self.assertRaises(BridgeError) as cm:
                b.open(srv.url)
            self.assertEqual(cm.exception.code, "E_NO_DEVICE")
            self.assertIn("errno=", cm.exception.detail)
        finally:
            with linkmod._HELD_LOCK:
                linkmod._HELD.update(saved)

    def test_mid_transfer_socket_drop_is_no_device(self):
        """PINS 02.13 (unplug classified, no hang). Appendix G #13."""
        srv = self.server(board_factory=drop_after_board(900))
        lk = self.new_link()
        lk.open(srv.url)
        events = []
        lk.on_disconnect = events.append
        lk.enter_raw()
        blob = "".join(chr(97 + (i * 5) % 26) for i in range(20000))
        t0 = time.monotonic()
        with self.assertRaises(BridgeError) as cm:
            lk.exec("s = %r\nprint(len(s))" % blob, timeout=5)
        self.assertLess(time.monotonic() - t0, 3.0, "must not hang")
        e = cm.exception
        self.assertEqual(e.code, "E_NO_DEVICE")
        self.assertTrue(e.detail)
        self.assertFalse(lk.is_open)
        self.assertEqual([x.code for x in events], ["E_NO_DEVICE"])
        with self.assertRaises(BridgeError) as cm:
            lk.exec("print(1)")
        self.assertEqual(cm.exception.code, "E_NO_DEVICE")      # the cause stays visible until close()
        lk.close()
        with self.assertRaises(BridgeError) as cm:
            lk.write(b"x")
        self.assertEqual(cm.exception.code, "E_NOT_CONNECTED")
        self.assertEqual(len(events), 1)

    def test_kick_during_interrupt_wait_raises_no_device(self):
        self.write_file("main.py", SILENT_MAIN)
        srv = self.server(board_factory=lambda r, s_, l: IgnoreCtrlCBoard(r, s_, l), run_main_on_connect=True)
        lk = self.new_link()
        lk.open(srv.url)
        threading.Timer(0.2, srv.kick).start()
        t0 = time.monotonic()
        with self.assertRaises(BridgeError) as cm:
            lk.interrupt(timeout=5.0)
        self.assertEqual(cm.exception.code, "E_NO_DEVICE")
        self.assertLess(time.monotonic() - t0, 2.0)

    def test_check_alive_notices_an_unplug_without_traffic(self):
        class UnpluggableSerial(StubSerial):
            gone = False
            @property
            def in_waiting(self):
                if self.gone:
                    raise OSError(errno.EIO, "Input/output error")
                return 0
            @in_waiting.setter
            def in_waiting(self, v):
                pass
        created = []
        def factory(port, **kw):
            s_ = UnpluggableSerial(port, **kw)
            created.append(s_)
            return s_
        lk = self.new_link(serial_factory=factory)
        events = []
        lk.on_disconnect = events.append
        lk.open("socket://127.0.0.1:9")
        self.assertTrue(lk.check_alive())
        created[0].gone = True
        with self.assertRaises(BridgeError) as cm:
            lk.check_alive()
        self.assertEqual(cm.exception.code, "E_NO_DEVICE")
        self.assertIn("EIO", cm.exception.detail)
        self.assertEqual(len(events), 1)
        self.assertFalse(lk.is_open)

    def test_reconnect_after_unplug(self):
        srv, lk = self.connected()
        srv.kick()
        time.sleep(0.1)
        with self.assertRaises(BridgeError) as cm:
            lk.sync_to_prompt(listen_ms=50)
        self.assertEqual(cm.exception.code, "E_NO_DEVICE")
        lk.close()
        lk.open(srv.url)
        self.assertTrue(lk.is_open)
        lk.enter_raw()
        self.assertEqual(lk.exec("print(5)")[0], b"5\r\n")

    def test_twenty_connect_disconnect_cycles_never_reset(self):
        """PINS RQ-SAFE-1 acceptance (fake): 0 soft resets, 0 Ctrl-C/Ctrl-D, 0 line pulses over 20 cycles."""
        srv = self.server()
        for i in range(20):
            lk = Link()
            lk.open(srv.url)
            self.assertEqual(lk.sync_to_prompt(listen_ms=30, nudge_ms=300), "prompt")
            lk.close()
        self.assertTrue(srv.wait_count("disconnect", 20))
        self.assertEqual(srv.count("connect"), 20)
        self.assertEqual(srv.count("softreset"), 0)
        self.assertEqual(srv.count("interrupt"), 0)
        self.assertEqual(bytes(srv.rx), b"\r\n" * 20)             # the only bytes ever sent: the nudge

    def test_twenty_full_cycles_with_raw_ops_zero_soft_resets(self):
        srv = self.server()
        for i in range(20):
            lk = Link()
            lk.open(srv.url)
            lk.sync_to_prompt(listen_ms=30, nudge_ms=300)
            lk.enter_raw(soft_reset=False)
            self.assertEqual(lk.exec("print(%d)" % i)[0], ("%d\r\n" % i).encode())
            self.assertTrue(lk.exit_raw())
            lk.close()
        self.assertTrue(srv.wait_count("disconnect", 20))
        self.assertEqual(srv.count("connect"), 20)
        self.assertEqual(srv.count("softreset"), 0)


@unittest.skipIf(IS_WINDOWS, "ptys are POSIX only")
class PtyTests(LinkTestCase):
    def pty(self):
        p = PtyFake(self.root)
        self.addCleanup(p.stop)
        return p

    def test_roundtrip_over_a_pty(self):
        p = self.pty()
        lk = self.new_link()
        info = lk.open(p.path)
        self.assertEqual(info["policy"], "pty")
        self.assertEqual(info["kind"], "pty")
        self.assertEqual(lk.sync_to_prompt(listen_ms=50, nudge_ms=500), "prompt")
        lk.enter_raw()
        self.assertEqual(lk.exec("print('over a pty')"), (b"over a pty\r\n", b""))
        blob = "q" * 5000
        self.assertEqual(lk.exec("s = %r\nprint(len(s))" % blob)[0], b"5000\r\n")
        self.assertTrue(lk.exit_raw())
        lk.close()
        self.assertEqual([e for e in p.events if e["ev"] == "softreset"], [])

    def test_pty_busy_comes_from_the_os_lock_not_from_text(self):
        """PINS 05.11, 08.12: a second opener of a locked port is E_PORT_BUSY (errno), message text irrelevant."""
        p = self.pty()
        holder = serial.Serial(p.path, exclusive=True)
        self.addCleanup(holder.close)
        lk = self.new_link()
        with self.assertRaises(BridgeError) as cm:
            lk.open(p.path)
        e = cm.exception
        self.assertEqual(e.code, "E_PORT_BUSY")
        self.assertIn("errno=", e.detail)
        self.assertFalse(lk.is_open)
        holder.close()
        lk.open(p.path)                                     # released lock -> opens
        self.assertTrue(lk.is_open)

    def test_unregistered_pty_is_refused_by_safe_mode(self):
        p = self.pty()
        linkmod._HARNESS_PTYS.discard(p.path)
        lk = self.new_link()
        with self.assertRaises(BridgeError) as cm:
            lk.open(p.path)
        self.assertEqual(cm.exception.code, "E_SAFE_MODE")

    def test_pty_interrupt(self):
        p = self.pty()
        lk = self.new_link()
        lk.open(p.path)
        lk.enter_raw()
        th = threading.Thread(target=lambda: lk.exec_stream("import time\nwhile True:\n    time.sleep(0.01)\n", lambda b: None))
        th.start()
        time.sleep(0.2)
        t0 = time.monotonic()
        self.assertTrue(lk.interrupt())
        self.assertLess(time.monotonic() - t0, 0.25)
        th.join(3)
        self.assertFalse(th.is_alive())


# ============================================================================ real MicroPython VM

@unittest.skipUnless(MPY_BIN and os.path.exists(MPY_BIN) and not IS_WINDOWS,
                     "set MPY_UNIX_BIN to the unix-port micropython binary to run the real-VM tests")
class RealVMTests(LinkTestCase):
    """Protocol behaviour against the real MicroPython REPL code (pyexec.c) instead of the fake.
    Quirks of the stock unix build: no os.uname; Ctrl-D in the raw REPL exits the process (no soft reboot)."""

    def vm(self):
        vm = RealVM(MPY_BIN, self.root)
        self.addCleanup(vm.stop)
        lk = self.new_link()
        lk.open(vm.url)
        return vm, lk

    def test_sync_enter_exec_exit(self):
        vm, lk = self.vm()
        self.assertEqual(lk.sync_to_prompt(listen_ms=200, nudge_ms=1000), "prompt")
        lk.enter_raw(soft_reset=False)
        self.assertEqual(lk.exec("print(6*7)"), (b"42\n", b""))        # the unix port prints bare \n
        self.assertTrue(lk.raw_paste_supported, "the real REPL supports raw paste")
        out, err = lk.exec("print('a')\n1/0")
        self.assertEqual(out, b"a\n")
        self.assertIn(b"ZeroDivisionError", err)
        self.assertTrue(lk.exit_raw(timeout=3))
        self.assertEqual(lk.mode, "friendly")

    def test_large_code_via_raw_paste_and_unicode(self):
        vm, lk = self.vm()
        lk.enter_raw()
        blob = "".join(chr(97 + (i * 11) % 26) for i in range(60000))
        out, err = lk.exec("s = %r\nprint(len(s), sum(map(ord, s)))\nprint('é✓')" % blob, timeout=20)
        self.assertEqual(err, b"")
        lines = out.decode("utf-8").splitlines()
        self.assertEqual(lines[0].split(), [str(len(blob)), str(sum(map(ord, blob)))])
        self.assertEqual(lines[1], "é✓")

    def test_syntax_error_early_in_a_large_paste_aborts_cleanly(self):
        """The real REPL compiles while it receives; on an early SyntaxError it sends Ctrl-D mid-upload
        (the 'abrupt end' of raw paste) and discards the rest of the upload."""
        vm, lk = self.vm()
        lk.enter_raw()
        out, err = lk.exec("def f(:\n" + "x = 1\n" * 30000, timeout=20)
        self.assertEqual(out, b"")
        self.assertIn(b"SyntaxError", err)
        self.assertEqual(lk.mode, "raw")
        self.assertEqual(lk.exec("print('in sync')")[0], b"in sync\n")

    def test_exec_stream_and_interrupt_on_real_vm(self):
        # Chunked exec on purpose: the unix port runs a raw-pasted program with its tty still in raw mode
        # (no ISIG), so a tty-style ^C never becomes SIGINT there. MCU ports read ^C from the byte stream.
        vm = RealVM(MPY_BIN, self.root)
        self.addCleanup(vm.stop)
        lk = self.new_link(raw_paste=False)
        lk.open(vm.url)
        lk.enter_raw()
        got = []
        res = {}
        code = "import time\ni = 0\nwhile True:\n    print('n', i)\n    i += 1\n    time.sleep(0.02)\n"
        th = threading.Thread(target=lambda: res.setdefault("err", lk.exec_stream(code, got.append)))
        th.start()
        deadline = time.monotonic() + 5
        while len(b"".join(got)) < 20 and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertGreater(len(b"".join(got)), 10)
        t0 = time.monotonic()
        self.assertTrue(lk.interrupt(timeout=3.0))
        self.assertLess(time.monotonic() - t0, 0.5)
        th.join(5)
        self.assertFalse(th.is_alive())
        self.assertIn(b"KeyboardInterrupt", res["err"])
        lk.enter_raw()
        self.assertEqual(lk.exec("print('after')")[0], b"after\n")

    def test_chunked_exec_without_paste_on_real_vm(self):
        vm = RealVM(MPY_BIN, self.root)
        self.addCleanup(vm.stop)
        lk = self.new_link(raw_paste=False)
        lk.open(vm.url)
        lk.enter_raw()
        self.assertEqual(lk.exec("print('np', 1+1)"), (b"np 2\n", b""))
        big = "x" * 2000
        self.assertEqual(lk.exec("s = %r\nprint(len(s))" % big)[0], b"2000\n")
        self.assertFalse(lk.raw_paste_supported)

    def test_real_vm_matches_fake_framing(self):
        """The fake board and the real REPL give the same (stdout, stderr) framing for the same snippets."""
        vm, lk = self.vm()
        lk.enter_raw()
        srv, lk2 = self.connected()
        lk2.enter_raw()
        for code in ("print(1)", "print('x'*10)\nprint('y')", "x = 5", "import os\nprint(type(os.listdir('/')).__name__)"):
            real_out, real_err = lk.exec(code)
            fake_out, fake_err = lk2.exec(code)
            # the stock unix build ends lines with \n, boards with \r\n; everything else must be identical
            self.assertEqual(real_out.replace(b"\r\n", b"\n"), fake_out.replace(b"\r\n", b"\n"), code)
            self.assertEqual((real_err, fake_err), (b"", b""))


# ============================================================================ oracle: vendored mpremote

class MpremoteOracleTests(LinkTestCase):
    """Differential check against mpremote 1.29.0 (the oracle; imported by tests only)."""

    def test_same_output_and_framing_as_mpremote(self):
        try:
            from mpremote.transport_serial import SerialTransport
        except Exception as exc:   # pragma: no cover
            self.skipTest("vendored mpremote not importable here: %r" % (exc,))
        srv = self.server()
        snippets = ["print(6*7)", "import os\nprint(sorted(os.listdir('/')))", "print('a')\nundefined_thing",
                    "1/0", "x = 1"]
        t = SerialTransport(srv.url, baudrate=115200)
        try:
            t.enter_raw_repl(soft_reset=False)
            oracle = [t.exec_raw(s) for s in snippets]
            t.exit_raw_repl()
        finally:
            t.close()
        lk = self.new_link()
        lk.open(srv.url)
        lk.enter_raw()
        mine = [lk.exec(s) for s in snippets]
        self.assertEqual(mine, oracle)


# ============================================================================ review fixes (fixer A)

def _new_fakeboard(**kw):
    """The current tools/fakeboard.py (socket://127.0.0.1 only), not the v0 snapshot used above."""
    from tools.fakeboard import FakeBoard
    return FakeBoard(**kw)


class NewBoardCase(TimedCase):
    def rig(self, link_kw=None, **board_kw):
        board = _new_fakeboard(**board_kw)
        board.start()
        self.addCleanup(board.stop)
        lk = Link(**(link_kw or {}))
        self.addCleanup(lk.close)
        lk.open(board.url)
        return board, lk

    @staticmethod
    def spin_in_thread(lk, result):
        """Run an endless program with exec_stream on a thread; returns (thread, list of stdout chunks)."""
        out = []

        def run():
            try:
                result["err"] = lk.exec_stream("import time\nwhile True:\n    print('spin')\n    time.sleep(0.01)\n",
                                               out.append)
            except BridgeError as exc:
                result["exc"] = exc

        th = threading.Thread(target=run)
        th.start()
        end = time.monotonic() + 3
        while not out and time.monotonic() < end:
            time.sleep(0.01)
        return th, out


class StopSettlingTests(NewBoardCase):
    """Review #1 and #19: a Stop (Ctrl-C x2, 50 ms apart) must not stall the next exec of the op that was
    stopped (devfs cleanup after a cancelled upload), and its reply must not wait for the settle period."""

    def test_exec_issued_right_after_stop_is_not_hit_by_the_second_ctrl_c(self):
        """The thread that was stopped runs its cleanup exec the moment the first Ctrl-C has ended its program,
        i.e. while interrupt() is still waiting out its 50 ms gap: the second Ctrl-C used to land inside that exec."""
        board, lk = self.rig()
        lk.enter_raw()
        res = {}
        started = threading.Event()

        def work():
            try:
                res["err"] = lk.exec_stream("import time\nwhile True:\n    print('spin')\n    time.sleep(0.01)\n",
                                            lambda d: started.set())
                t = time.monotonic()
                # runs 0.3 s, so a Ctrl-C 50 ms after the first one would abort it (or its raw paste: ~10 s stall)
                res["cleanup"] = lk.exec("import time\ntime.sleep(0.3)\nprint('done')\n", timeout=3)
                res["cleanup_s"] = time.monotonic() - t
            except BridgeError as exc:
                res["exc"] = exc.code

        th = threading.Thread(target=work)
        th.start()
        self.assertTrue(started.wait(3), "program never started")
        self.assertTrue(lk.interrupt(timeout=3))
        th.join(5)
        self.assertFalse(th.is_alive())
        self.assertNotIn("exc", res)
        self.assertIn(b"KeyboardInterrupt", res["err"])
        self.assertEqual(res["cleanup"], (b"done\r\n", b""))
        self.assertLess(res["cleanup_s"], 1.5)
        self.assertEqual(lk.mode, "raw")
        self.assertEqual(lk.exec("print(1)")[0], b"1\r\n")
        self.assertEqual(board.events.count("soft_reset"), 0)

    def test_stop_reply_is_prompt_but_the_next_op_waits_for_the_quiet_deadline(self):
        board, lk = self.rig()
        lk.enter_raw()
        result = {}
        th, out = self.spin_in_thread(lk, result)
        self.assertTrue(out)
        t0 = time.monotonic()
        self.assertTrue(lk.interrupt(timeout=3, settle=0.8))
        reply = time.monotonic() - t0
        self.assertLess(reply, 0.4, "the reply must not include the settle period")
        th.join(2)
        o, e = lk.exec("print('next')", timeout=3)
        total = time.monotonic() - t0
        self.assertEqual((o, e), (b"next\r\n", b""))
        # last Ctrl-C was written ~50 ms after t0; the next exec may write only after + settle
        self.assertGreaterEqual(total, 0.8)
        self.assertLess(total, 3.0)

    def test_exec_that_ends_with_keyboard_interrupt_makes_the_next_op_wait_a_moment(self):
        board, lk = self.rig()
        lk.enter_raw()
        o, e = lk.exec("raise KeyboardInterrupt", timeout=3)
        self.assertIn(b"KeyboardInterrupt", e)
        t0 = time.monotonic()
        self.assertEqual(lk.exec("print(2)", timeout=3)[0], b"2\r\n")
        self.assertGreaterEqual(time.monotonic() - t0, 0.08)

    def test_no_stop_no_delay(self):
        board, lk = self.rig()
        lk.enter_raw()
        t0 = time.monotonic()
        for _ in range(5):
            lk.exec("print(1)", timeout=3)
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_stop_during_a_stream_of_small_execs_never_stalls_or_resets(self):
        """Stop at many different moments of a stream of small execs (a file op's chunk loop) followed at once by
        the cancelled op's cleanup exec: every attempt ends within 3 s, the Link is still in raw mode, the cleanup
        works, nothing resets. An exec that was being submitted when the Stop came raises E_CANCELLED."""
        for faults in (["slow:230400"], ["slow:230400", "no_raw_paste"]):
            board, lk = self.rig(faults=faults)
            lk.enter_raw()
            for k in range(8):
                res = {}
                halt = threading.Event()

                def work():
                    try:
                        try:
                            while not halt.is_set():
                                _o, e = lk.exec("x = bytes(900)\nprint(len(x))\n" + "# pad" * 60 + "\n", timeout=5)
                                if b"KeyboardInterrupt" in e:
                                    break
                        except BridgeError as exc:
                            if exc.code != "E_CANCELLED":
                                raise
                            res["cancelled"] = True
                        res["mode"] = lk.mode
                        res["cleanup"] = lk.exec("print('clean')", timeout=5)[0]
                    except BridgeError as exc:
                        res["exc"] = exc.code
                    res["end"] = time.monotonic()

                th = threading.Thread(target=work)
                th.start()
                time.sleep(0.15 + 0.037 * k)
                t_stop = time.monotonic()
                lk.interrupt(timeout=3)
                halt.set()
                th.join(20)
                self.assertFalse(th.is_alive())
                with self.subTest(faults=faults, k=k, res=res):
                    self.assertNotIn("exc", res)
                    self.assertEqual(res.get("mode"), "raw")
                    self.assertEqual(res.get("cleanup"), b"clean\r\n")
                    self.assertLess(res["end"] - t_stop, 3.0)
            self.assertEqual(board.events.count("soft_reset"), 0, faults)

    def test_stop_right_after_the_paste_window_is_not_acknowledged_with_a_ctrl_d(self):
        """A Stop that lands between the raw-paste window reply and the first data byte makes the board end the paste
        with its own 0x04. The Link used to answer that 0x04 with an unconditional Ctrl-D, which arrives at an EMPTY
        raw buffer = soft reset (RQ-SAFE-1, 'Stop never resets'). It happened ~2 in 100 under load (round-2 reconcile:
        test_bypass_ops_are_not_blocked_by_a_long_upload). Deterministic here: the Ctrl-C is written, and the board's
        answer is already waiting, at the moment the Link looks for flow-control bytes."""
        board, lk = self.rig()
        lk.enter_raw()
        real = lk._read_exact

        def landing(n, timeout, cancel=None, stage="", code="E_BOARD_UNRESPONSIVE"):
            got = real(n, timeout, cancel, stage, code)
            if stage == "the raw-paste window size":
                del lk._pushback[:]   # the window credit byte has not arrived yet (TCP may split the board's reply)
                lk.write(b"\x03")
                wait_until(lambda: board.events.count("paste_abort") == 1, 5, "the board to abort the paste")
                wait_until(lambda: lk._alive_ser().in_waiting > 0, 5, "the board's end-of-data byte to arrive")
            return got

        lk._read_exact = landing
        with self.assertRaises(BridgeError) as cm:
            lk.exec("print('x')\n" * 40, timeout=5)
        self.assertEqual(cm.exception.code, "E_CANCELLED")
        del lk._read_exact
        self.assertEqual(lk.mode, "raw", "resynchronised at the raw prompt")
        self.assertEqual(lk.exec("print('after')", timeout=5)[0], b"after\r\n")
        self.assertEqual(board.events.count("soft_reset"), 0)

    def test_stop_in_the_middle_of_submitting_code_sends_no_terminating_ctrl_d(self):
        """The final Ctrl-D of a submission lands on an EMPTY raw buffer if a Ctrl-C cleared it half way = soft
        reset (motors). Chunked path: 16-byte chunks every 50 ms; raw-paste path: 9600 baud. Stop mid-way."""
        code = "x = 1\n" + "y = 2  # padding padding padding\n" * 30
        for name, faults, setup in (("chunked", ["no_raw_paste"], lambda lk: (setattr(lk, "raw_chunk", 16),
                                                                              setattr(lk, "raw_chunk_delay", 0.05))),
                                    ("paste", ["slow:9600"], lambda lk: None)):
            board, lk = self.rig(faults=faults)
            setup(lk)
            lk.enter_raw()
            res = {}

            def work():
                try:
                    lk.exec(code, timeout=5)
                    res["r"] = "done"
                except BridgeError as exc:
                    res["r"] = exc.code

            th = threading.Thread(target=work)
            th.start()
            time.sleep(0.3)
            t0 = time.monotonic()
            lk.interrupt(timeout=3)
            th.join(10)
            with self.subTest(name):
                self.assertFalse(th.is_alive())
                self.assertEqual(res.get("r"), "E_CANCELLED")
                self.assertLess(time.monotonic() - t0, 1.5)
                self.assertEqual(lk.mode, "raw", "resynchronised at the raw prompt")
                self.assertEqual(lk.exec("print('after')", timeout=5)[0], b"after\r\n")
                time.sleep(0.2)
                self.assertEqual(board.events.count("soft_reset"), 0)


class BoardResetUnderSessionTests(NewBoardCase):
    """Review #2: after the board reset under an open raw-REPL session the Link must not write Ctrl-D into
    the friendly REPL (= implicit soft reset)."""

    def _reset_under_session(self, faults):
        board, lk = self.rig(faults=faults, files={"/main.py": "print('MAIN RAN')\n"})
        lk.sync_to_prompt(300, 300)
        lk.enter_raw()
        lk.exec("print(1)\n")
        mark = len(board.events)
        board.hard_reset()
        time.sleep(0.4)
        return board, lk, mark

    def _soft_resets(self, board, mark):
        return [e for e in list(board.events)[mark:] if e["ev"] == "soft_reset"]

    def test_chunked_exec_raises_board_reset_and_sends_nothing(self):
        board, lk, mark = self._reset_under_session(["no_raw_paste"])
        with self.assertRaises(BridgeError) as cm:
            lk.exec("print(2)\n", timeout=3)
        self.assertEqual(cm.exception.code, "E_BOARD_RESET")
        time.sleep(0.3)
        self.assertEqual(self._soft_resets(board, mark), [])
        self.assertEqual(lk.mode, "unknown")

    def test_raw_paste_exec_raises_board_reset_too(self):
        board, lk, mark = self._reset_under_session([])
        t0 = time.monotonic()
        with self.assertRaises(BridgeError) as cm:
            lk.exec("print(2)\n", timeout=3)
        self.assertEqual(cm.exception.code, "E_BOARD_RESET")
        self.assertLess(time.monotonic() - t0, 1.0, "no waiting for a stage timeout")
        self.assertEqual(self._soft_resets(board, mark), [])

    def test_resynchronising_with_enter_raw_recovers(self):
        board, lk, mark = self._reset_under_session(["no_raw_paste"])
        with self.assertRaises(BridgeError):
            lk.exec("print(2)\n", timeout=3)
        lk.enter_raw()
        self.assertEqual(lk.exec("print(3)\n", timeout=3)[0], b"3\r\n")
        self.assertEqual(self._soft_resets(board, mark), [])

    def test_a_late_lookalike_prompt_in_program_output_does_not_trip_the_check(self):
        board, lk = self.rig()
        lk.enter_raw()
        self.assertEqual(lk.exec("print('>>> ')", timeout=3)[0], b">>> \r\n")
        self.assertEqual(lk.exec("print('again')", timeout=3)[0], b"again\r\n")


class SafeModeHostParsingFixTests(TimedCase):
    """Review #3 and #14: the loopback test parses the URL the way pyserial does."""

    def check(self, port):
        linkmod.safe_mode_check(port, environ={"MPY_SAFE_MODE": "1"})

    def test_userinfo_and_lookalike_hosts_are_refused(self):
        for port in ("socket://127.0.0.1@lab-pc.example:23", "socket://127.0.0.1:9@192.168.1.5:23",
                     "rfc2217://127.0.0.1:1@lab-pc:2217", "socket://127.attacker.example:23",
                     "socket://127.0.0.1.example.com:80", "socket://localhost@example.com:80",
                     "socket://localhost.example.com:80", "socket://127.1:80", "socket://0x7f.0.0.1:80",
                     "socket://2130706433:80", "socket://@127.0.0.1:80", "socket://:@127.0.0.1:80",
                     "socket://127.0.0.1\\@evil.example:80", "socket://evil.example#@127.0.0.1:80",
                     "socket://:80", "socket://", "socket://[::ffff:8.8.8.8]:80",
                     "socket://10.0.0.1:80", "socket://0.0.0.0:80", "SOCKS://127.0.0.1:80", "socket:///127.0.0.1:80"):
            with self.subTest(port=port):
                with self.assertRaises(BridgeError) as cm:
                    self.check(port)
                self.assertEqual(cm.exception.code, "E_SAFE_MODE")

    def test_real_loopback_forms_are_allowed(self):
        for port in ("socket://127.0.0.1:5555", "socket://127.1.2.3:5555", "socket://localhost:5555",
                     "socket://LOCALHOST:5555", "socket://[::1]:5555", "rfc2217://127.0.0.1:2217",
                     "rfc2217://[::1]:2217/", "socket://127.0.0.1:5555?logging=debug", "loop://", "LOOP://"):
            with self.subTest(port=port):
                self.check(port)

    def test_the_host_checked_is_the_host_pyserial_connects_to(self):
        import ipaddress

        def loopback(host):
            if host == "localhost":
                return True
            try:
                return ipaddress.ip_address(host).is_loopback
            except ValueError:
                return False

        for port in ("socket://127.0.0.1@lab-pc.example:23", "socket://127.0.0.1:5555", "socket://localhost:5555",
                     "socket://[::1]:5555", "rfc2217://127.0.0.1:1@lab-pc:2217", "socket://LocalHost:7"):
            ser = serial.serial_for_url(port, do_not_open=True)  # parses only; nothing is opened
            host = ser.from_url(port)[0]
            try:
                self.check(port)
                allowed = True
            except BridgeError:
                allowed = False
            self.assertEqual(allowed, loopback(host), (port, host))

    def test_malformed_port_is_still_a_protocol_error_not_a_safe_mode_error(self):
        lk = Link(serial_factory=stub_factory([]))
        with self.assertRaises(BridgeError) as cm:
            lk.open("socket://127.0.0.1:99999")
        self.assertEqual(cm.exception.code, "E_PROTOCOL")


class PromptEvidenceTests(NewBoardCase):
    """Review #4: a prompt-shaped tail is only a shape (a program in input('>>> ') ends in the same bytes)."""

    def classify(self, buf, nudged=False):
        lk = Link()
        verdict = lk._classify_listen(buf, nudged)
        return verdict, lk.mode, lk.sync_evidence

    def test_bare_prompt_shape_is_unverified(self):
        self.assertEqual(self.classify(b">>> "), ("prompt-unverified", "unknown", ""))
        self.assertEqual(self.classify(b"name?\r\n>>> "), ("prompt-unverified", "unknown", ""))
        # after a nudge, program output in between is not the REPL's echo either
        self.assertEqual(self.classify(b"\r\nhello\r\n>>> ", nudged=True)[0], "prompt-unverified")
        # without a nudge the echo shape proves nothing
        self.assertEqual(self.classify(b"\r\n>>> ", nudged=False)[0], "prompt-unverified")

    def test_banner_echo_and_raw_marker_are_evidence(self):
        self.assertEqual(self.classify(BANNER_PROMPT), ("prompt", "friendly", "banner"))
        self.assertEqual(self.classify(b"MPY: soft reboot\r\n" + BANNER_PROMPT)[0], "prompt")
        self.assertEqual(self.classify(b"\r\n>>> ", nudged=True), ("prompt", "friendly", "echo"))
        self.assertEqual(self.classify(b"\r\n>>> \r\n>>> ", nudged=True), ("prompt", "friendly", "echo"))
        self.assertEqual(self.classify(linkmod.RAW_PROMPT), ("prompt", "raw", "raw"))
        self.assertEqual(self.classify(b"OK\x04\x04>")[0], "prompt")

    def test_other_verdicts_unchanged(self):
        self.assertEqual(self.classify(b"tick\r\n")[0], "running-program")
        self.assertEqual(self.classify(b"")[0], "silent")

    def test_main_py_blocked_in_input_is_not_idle(self):
        board, lk = self.rig(files={"/main.py": "name = input('>>> ')\nprint('hello', name)\n"}, power_on="connect")
        verdict = lk.sync_to_prompt(400, 400)
        self.assertTrue(board.program_running, "fixture: main.py must be running")
        self.assertEqual(verdict, "prompt-unverified")
        self.assertEqual(lk.mode, "unknown")
        self.assertEqual(lk.sync_evidence, "")

    def test_idle_repl_is_still_a_verified_prompt(self):
        board, lk = self.rig()
        self.assertEqual(lk.sync_to_prompt(200, 400), "prompt")
        self.assertEqual(lk.sync_evidence, "echo")
        self.assertEqual(lk.mode, "friendly")

    def test_soft_reset_to_the_repl_shows_the_banner(self):
        board, lk = self.rig()
        lk.sync_to_prompt(200, 400)
        self.assertEqual(lk.soft_reset_friendly(wait=3.0), "prompt")
        self.assertEqual(lk.sync_evidence, "banner")


class WindowsPortNameTests(TimedCase):
    """Review #9: COM names are case-insensitive and \\\\.\\COM3 names COM3."""

    def comports(self, *devices):
        ports = [types.SimpleNamespace(device=d, vid=0x10C4, pid=0xEA60) for d in devices]
        from unittest import mock
        return mock.patch("serial.tools.list_ports.comports", return_value=ports)

    def test_com_names_match_in_any_spelling(self):
        with self.comports("COM3"):
            for name in ("COM3", "com3", "Com3", "\\\\.\\COM3", "\\\\.\\com3"):
                self.assertEqual(linkmod.lookup_usb_ids(name), (0x10C4, 0xEA60), name)
            self.assertIsNone(linkmod.lookup_usb_ids("COM4"))
            self.assertIsNone(linkmod.lookup_usb_ids("\\\\.\\COM30"))

    def test_enumerated_name_in_any_case_matches_too(self):
        with self.comports("com3"):
            self.assertEqual(linkmod.lookup_usb_ids("COM3"), (0x10C4, 0xEA60))

    def test_posix_names_stay_case_sensitive(self):
        with self.comports("/dev/cu.usbserial-0001"):
            self.assertEqual(linkmod.lookup_usb_ids("/dev/cu.usbserial-0001"), (0x10C4, 0xEA60))
            self.assertIsNone(linkmod.lookup_usb_ids("/dev/cu.USBSERIAL-0001"))

    def test_held_key_ignores_the_device_namespace_prefix(self):
        self.assertEqual(linkmod._held_key("\\\\.\\com3"), linkmod._held_key("COM3"))
        self.assertEqual(linkmod._held_key("/dev/cu.X"), "/dev/cu.X")


class UnlistedWinerrorTests(TimedCase):
    """Review #8: a winerror outside the two tables falls through to the errno that travels with it."""

    class WinErr(OSError):
        def __init__(self, num, winerror, cls_text="denied"):
            OSError.__init__(self, num, cls_text)
            self.winerror = winerror

    def code(self, exc):
        return classify_open_error(exc, "COM3").code

    def test_unlisted_winerror_uses_errno(self):
        for win in (1260, 1314, 1450, 87):
            self.assertEqual(self.code(self.WinErr(errno.EACCES, win)), "E_PERMISSION", win)
            self.assertEqual(self.code(self.WinErr(errno.EPERM, win)), "E_PERMISSION", win)
            self.assertEqual(self.code(self.WinErr(errno.ENOENT, win)), "E_NO_DEVICE", win)
            self.assertEqual(self.code(self.WinErr(errno.EBUSY, win)), "E_PORT_BUSY", win)

    def test_listed_winerror_still_wins_over_errno(self):
        self.assertEqual(self.code(self.WinErr(errno.EACCES, 5)), "E_PORT_BUSY")
        self.assertEqual(self.code(self.WinErr(errno.EACCES, 2)), "E_NO_DEVICE")

    def test_unlisted_winerror_without_any_known_errno_is_internal(self):
        self.assertEqual(self.code(self.WinErr(9999, 1260)), "E_INTERNAL")

    def test_pyserial_text_form(self):
        exc = serial.SerialException("could not open port 'COM3': PermissionError(13, 'Blocked by policy', None, 1260)")
        self.assertEqual(self.code(exc), "E_PERMISSION")
        exc = serial.SerialException("could not open port 'COM3': FileNotFoundError(2, 'Le fichier', None, 1168)")
        self.assertEqual(self.code(exc), "E_NO_DEVICE")
        exc = serial.SerialException("could not open port 'COM3': PermissionError(13, 'Access is denied.', None, 5)")
        self.assertEqual(self.code(exc), "E_PORT_BUSY")
        exc = serial.SerialException("could not open port 'COM3': OSError(22, 'x', None, 1260)")
        self.assertEqual(self.code(exc), "E_INTERNAL")

    def test_numbers_returns_errno_next_to_winerror(self):
        from bridge import errors
        self.assertEqual(errors._numbers(self.WinErr(errno.EACCES, 1260))[:2], (1260, errno.EACCES))
        self.assertEqual(errors._numbers(serial.SerialException(
            "PermissionError(13, 'x', None, 1260)"))[:2], (1260, 13))
        self.assertEqual(errors._numbers(serial.SerialException("[WinError 1260] x [Errno 13]"))[:2], (1260, 13))


if __name__ == "__main__":
    unittest.main()
