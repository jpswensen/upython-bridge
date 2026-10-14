#!/usr/bin/env python3
"""mpunix_relay.py - the REAL MicroPython unix VM behind a TCP socket (macOS/Linux only).

A second back end next to tools/fakeboard.py: it runs the stock unix-port `micropython` binary on
a pty and relays it to `socket://127.0.0.1:PORT`, so the bridge, mpremote and the device-side
snippets can be checked against real MicroPython REPL code (shared/runtime/pyexec.c) instead of
CPython shims.  It never touches a serial port: the only device is a pty created here.

    from tools.mpunix_relay import UnixVM
    reason = UnixVM.skip_reason()                    # None when MPY_UNIX_BIN points at a binary
    with UnixVM() as vm:                             # context manager; stop() kills the VM
        url = vm.url                                 # "socket://127.0.0.1:PORT"
        vm.events                                    # connect / disconnect / spawn / exit / soft_reboot / sigint (only)

Differences from a real board that this relay hides or cannot hide:
  * the unix REPL EXITS on a raw-REPL (or friendly) Ctrl-D instead of printing `MPY: soft reboot`.
    With emulate_soft_reboot=True (default) the relay prints `MPY: soft reboot\\r\\n`, starts a
    fresh VM and re-enters the raw REPL if the host was in it, so the host sees what a board does.
    Interpreter state is lost (same as a board) and boot.py / main.py are NOT run (the VM has none).
  * program output uses a bare `\\n`; real boards print `\\r\\n`.  cook=True (default) converts.
  * Ctrl-C works: the VM runs as a session leader on the pty, so the line discipline turns the
    0x03 byte into SIGINT (which MicroPython turns into KeyboardInterrupt).  No Ctrl-C scanning of
    stdin happens, so `micropython.kbd_intr(-1)` has no effect here.  While a program started with
    RAW PASTE (what Run uses) is executing, the unix VM has the terminal in raw mode (ISIG off), so
    the byte would only sit in its stdin: the relay then raises SIGINT itself, once per program
    (and does not forward that one 0x03, like a board's stdin scanner), see _RunTracker.
  * os.ilistdir() has no usable size, there is no os.uname() and no machine.unique_id(); the file
    system is the REAL host directory `vm.root` (cwd of the VM): use paths under it, never '/'.
  * everything runs on the host: do not point the VM at directories you care about.

CLI: python tools/mpunix_relay.py --print-url [--bin PATH] [--cwd DIR] [--max-seconds N]
"""
from __future__ import annotations

import argparse
import os
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

__all__ = ["UnixVM", "find_binary"]

# Runs in a fresh interpreter just before the VM starts: become a session leader and take the pty
# (fd 0) as controlling terminal so that Ctrl-C on the pty delivers SIGINT to the VM.
_LAUNCHER = (
    "import os, sys, fcntl, termios\n"
    "os.setsid()\n"
    "fcntl.ioctl(0, termios.TIOCSCTTY, 0)\n"
    "os.execv(sys.argv[1], [sys.argv[1]])\n"
)


def find_binary():
    """Path from MPY_UNIX_BIN if it is an executable file, else None."""
    p = os.environ.get("MPY_UNIX_BIN")
    if p and os.path.isfile(p) and os.access(p, os.X_OK):
        return p
    return None


def _posix_pty_ok():
    if os.name != "posix":
        return False
    try:
        import pty  # noqa: F401
        import termios  # noqa: F401
        import fcntl  # noqa: F401
    except ImportError:
        return False
    return True


class _Cooker:
    """\\n -> \\r\\n, leaving existing \\r\\n alone (state carried across chunks)."""

    def __init__(self):
        self.prev_cr = False

    def __call__(self, data: bytes) -> bytes:
        if not data:
            return data
        out = bytearray()
        prev = self.prev_cr
        for b in data:
            if b == 10 and not prev:
                out.append(13)
            out.append(b)
            prev = (b == 13)
        self.prev_cr = prev
        return bytes(out)


class _RunTracker:
    """Is a raw-paste program executing?  Followed from both directions of the byte stream.

    client -> VM:  b"\\x05A\\x01" in the raw REPL starts a paste (PASTE), the first 0x04 ends the data (RUN; 0x03 inside
                  the data cancels the paste instead).  RUN: the first 0x03 is the Stop, see take_interrupt().
    VM -> client:  a finished program sends 0x04 (data accepted), 0x04 (stdout end), 0x04 (stderr end) and then the
                  prompt '>'.  After those three the next '>' means the raw REPL is idle again."""

    IDLE, PASTE, RUN, STOPPED = range(4)

    def __init__(self):
        self._lock = threading.Lock()
        self.reset()

    def reset(self):
        with self._lock:
            self.state = self.IDLE
            self._in_tail = b""
            self._eots = 0

    def running(self):
        return self.state in (self.RUN, self.STOPPED)

    def feed_in(self, data, raw_mode, sigint_needed):
        """Scan client bytes.  Returns (bytes to forward, True if SIGINT must be raised for this chunk).
        sigint_needed() is asked only when a Ctrl-C hits a running raw-paste program."""
        out = bytearray()
        kill = False
        with self._lock:
            for b in data:
                st = self.state
                if st == self.PASTE:
                    if b == 4:
                        self.state, self._eots = self.RUN, 0
                    elif b == 3:
                        self.state = self.IDLE
                elif st == self.RUN and b == 3 and sigint_needed():
                    self.state = self.STOPPED
                    kill = True
                    continue                                   # consumed, like a board's stdin scanner
                elif st == self.IDLE:
                    self._in_tail = (self._in_tail + bytes((b,)))[-3:]
                    if self._in_tail == b"\x05A\x01" and raw_mode:
                        self.state, self._in_tail = self.PASTE, b""
                out.append(b)
        return bytes(out), kill

    def feed_out(self, data):
        with self._lock:
            if self.state not in (self.RUN, self.STOPPED):
                return
            for b in data:
                if b == 4:
                    self._eots += 1
                elif b == 62 and self._eots >= 3:               # '>' after the three 0x04: raw REPL idle again
                    self.state, self._in_tail, self._eots = self.IDLE, b"", 0
                    return


class UnixVM:
    """TCP <-> pty relay for the real MicroPython unix VM, same url / events-lite interface as FakeBoard."""

    def __init__(self, binary=None, cwd=None, cook=True, emulate_soft_reboot=True, exclusive=True,
                 host="127.0.0.1", port=0):
        self.binary = binary or find_binary()
        self._cwd_arg = cwd
        self.root = None
        self._own_root = False
        self.cook = cook
        self.emulate_soft_reboot = emulate_soft_reboot
        self.exclusive = exclusive
        self._host = host
        self._req_port = port
        self.port = None
        self.events = []
        self._ev_lock = threading.Lock()
        self._t0 = time.monotonic()
        self._srv = None
        self._stop = threading.Event()
        self._accept_thread = None
        self._threads = []
        self._conn = None
        self._proc = None
        self._master = None
        self._lock = threading.RLock()
        self._started = False
        self._stopped = False
        self._raw_mode = False
        self._run = _RunTracker()

    # ------------------------------------------------------------------ availability
    @staticmethod
    def available():
        """(ok, reason).  reason is a human-readable skip message when not ok."""
        if not _posix_pty_ok():
            return False, "the unix-VM relay needs POSIX ptys (macOS/Linux); skipping on this platform"
        env = os.environ.get("MPY_UNIX_BIN")
        if not env:
            return False, "MPY_UNIX_BIN is not set (point it at the MicroPython unix-port binary to run VM tests)"
        if not (os.path.isfile(env) and os.access(env, os.X_OK)):
            return False, "MPY_UNIX_BIN=%s is not an executable file" % env
        return True, ""

    @classmethod
    def skip_reason(cls):
        ok, reason = cls.available()
        return None if ok else reason

    # ------------------------------------------------------------------ events
    def _ev(self, name, **kw):
        rec = {"t": time.monotonic(), "ev": name}
        rec.update(kw)
        with self._ev_lock:
            rec["seq"] = len(self.events)
            self.events.append(rec)
        return rec

    def event_names(self):
        with self._ev_lock:
            return [e["ev"] for e in self.events]

    def count(self, ev):
        return self.event_names().count(ev)

    def wait_for(self, ev, timeout=5.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            with self._ev_lock:
                for e in self.events:
                    if e["ev"] == ev:
                        return e
            time.sleep(0.01)
        return None

    # ------------------------------------------------------------------ lifecycle
    @property
    def url(self):
        if self.port is None:
            raise RuntimeError("UnixVM not started")
        return "socket://%s:%d" % (self._host, self.port)

    def start(self):
        ok, reason = self.available()
        if not ok:
            raise RuntimeError(reason)
        if self._started:
            return self
        self._started = True
        if self.binary is None:
            self.binary = find_binary()
        if self._cwd_arg is None:
            self.root = tempfile.mkdtemp(prefix="mpunixvm-")
            self._own_root = True
        else:
            self.root = os.fspath(self._cwd_arg)
            os.makedirs(self.root, exist_ok=True)
        self._listen(self._req_port)
        self.port = self._srv.getsockname()[1]
        self._accept_thread = threading.Thread(target=self._accept_loop, name="mpunix-accept", daemon=True)
        self._accept_thread.start()
        return self

    def _listen(self, port):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((self._host, port))
        s.listen(5)
        s.settimeout(0.1)
        self._srv = s

    def stop(self):
        if self._stopped:
            return
        self._stopped = True
        self._stop.set()
        with self._lock:
            srv, self._srv = self._srv, None
        if srv is not None:
            try:
                srv.close()
            except OSError:
                pass
        # wake the serving thread; it tears the session down itself (only one thread owns the pty fd)
        conn = self._conn
        if conn is not None:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self._kill_proc()
        for t in [self._accept_thread] + list(self._threads):
            if t is not None and t is not threading.current_thread():
                t.join(3.0)
        if self._own_root and self.root:
            shutil.rmtree(self.root, ignore_errors=True)

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()
        return False

    def leaked_threads(self):
        return [t for t in [self._accept_thread] + list(self._threads) if t is not None and t.is_alive()]

    # ------------------------------------------------------------------ serving
    def _accept_loop(self):
        while not self._stop.is_set():
            srv = self._srv
            if srv is None:
                with self._lock:
                    for _ in range(100):
                        if self._stop.is_set() or self._srv is not None:
                            break
                        try:
                            self._listen(self.port)
                            break
                        except OSError:
                            time.sleep(0.02)
                continue
            try:
                conn, _peer = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                if self._stop.is_set():
                    return
                time.sleep(0.01)
                continue
            conn.settimeout(None)
            try:
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            if self.exclusive:
                with self._lock:
                    self._srv = None
                try:
                    srv.close()
                except OSError:
                    pass
            self._serve(conn)

    def _spawn_vm(self):
        import pty
        import termios
        master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[0] &= ~(termios.ICRNL | termios.INLCR | termios.IGNCR)   # keep CR/LF as sent
        attrs[1] &= ~termios.OPOST                                       # we cook output ourselves
        attrs[3] &= ~(termios.ECHO | termios.ICANON)                     # MicroPython echoes itself
        termios.tcsetattr(slave, termios.TCSANOW, attrs)                 # ISIG stays on: Ctrl-C -> SIGINT
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": self.root, "LANG": "C"}
        proc = subprocess.Popen([sys.executable, "-I", "-B", "-S", "-c", _LAUNCHER, self.binary],
                                stdin=slave, stdout=slave, stderr=slave, cwd=self.root, env=env,
                                close_fds=True)
        os.close(slave)
        self._run.reset()
        self._ev("spawn", pid=proc.pid)
        return proc, master

    def _serve(self, conn):
        self._ev("connect")
        self._conn = conn
        self._raw_mode = False
        t_in = None
        try:
            self._proc, self._master = self._spawn_vm()
            t_in = threading.Thread(target=self._pump_in, args=(conn,), name="mpunix-in", daemon=True)
            self._threads = [t for t in self._threads if t.is_alive()] + [t_in]
            t_in.start()
            cook = _Cooker() if self.cook else (lambda b: b)
            self._pump_out(conn, cook)
        except Exception as e:                                           # pragma: no cover
            self._ev("error", message=str(e))
        finally:
            self._teardown_session()
            for fn in (lambda: conn.shutdown(socket.SHUT_RDWR), conn.close):
                try:
                    fn()
                except OSError:
                    pass
            if t_in is not None:
                t_in.join(2.0)
            self._ev("disconnect")

    def _pump_out(self, conn, cook):
        """VM -> client.  Handles the VM exiting (soft reset emulation) until the client leaves."""
        while not self._stop.is_set() and self._conn is conn:
            master = self._master
            if master is None:
                return
            try:
                ready, _, _ = select.select([master], [], [], 0.2)      # POSIX only: ptys are selectable
                if not ready:
                    continue                                            # re-check stop / client gone
                data = os.read(master, 4096)
            except (OSError, ValueError):
                data = b""
            if data:
                self._run.feed_out(data)
                try:
                    conn.sendall(cook(data))
                except OSError:
                    return
                continue
            # EOF on the pty: the VM exited
            proc = self._proc
            if proc is None:                      # stop() tore the session down under us
                return
            try:
                rc = proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                rc = proc.wait()
            self._ev("exit", rc=rc)
            if self._stop.is_set() or self._conn is not conn:
                return
            if not (self.emulate_soft_reboot and rc == 0):
                return
            if not self._soft_reboot(conn, cook):
                return

    def _soft_reboot(self, conn, cook):
        try:
            conn.sendall(b"MPY: soft reboot\r\n")
        except OSError:
            return False
        was_raw = self._raw_mode
        with self._lock:
            try:
                os.close(self._master)
            except OSError:
                pass
            self._proc, self._master = self._spawn_vm()
        self._ev("soft_reboot", raw=was_raw)
        if self._conn is not conn or self._stop.is_set():
            self._kill_proc()                    # the client left while the VM was being replaced
            return False
        if was_raw:
            # swallow the friendly banner + first prompt, then enter the raw REPL like the board does
            seen = b""
            end = time.monotonic() + 5.0
            while time.monotonic() < end and not seen.endswith(b">>> "):
                if self._conn is not conn or self._stop.is_set():
                    return False
                try:
                    ready, _, _ = select.select([self._master], [], [], 0.2)
                    if not ready:
                        continue
                    chunk = os.read(self._master, 4096)
                except (OSError, ValueError):
                    return False
                if not chunk:
                    return False
                seen += chunk
            try:
                os.write(self._master, b"\x01")
            except OSError:
                return False
        return True

    def _pump_in(self, conn):
        """client -> VM."""
        try:
            while not self._stop.is_set():
                try:
                    data = conn.recv(4096)
                except OSError:
                    break
                if not data:
                    break
                # track whether the host left the VM in raw REPL (for soft-reboot emulation)
                i1, i2 = data.rfind(b"\x01"), data.rfind(b"\x02")
                if i1 > i2:
                    self._raw_mode = True
                elif i2 > i1:
                    self._raw_mode = False
                with self._lock:                  # a soft-reboot swap of the pty must not interleave
                    master = self._master
                    if master is None:
                        break
                    data, kill = self._run.feed_in(data, self._raw_mode, lambda: not self._isig_on(master))
                    try:
                        if kill:
                            self._sigint_vm()
                        if data:
                            os.write(master, data)
                    except OSError:
                        break
        finally:
            # the client is gone (or the pty is): end the session; _pump_out notices
            self._conn = None
            self._kill_proc()

    @staticmethod
    def _isig_on(master):
        """True when the pty line discipline itself turns 0x03 into SIGINT (then nothing is needed here)."""
        try:
            import termios
            return bool(termios.tcgetattr(master)[3] & termios.ISIG)
        except Exception:                                          # termios.error is not an OSError
            return False

    def _sigint_vm(self):
        proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                os.kill(proc.pid, signal.SIGINT)
                self._ev("sigint", pid=proc.pid)
            except OSError:
                pass

    def _kill_proc(self):
        proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass

    def _teardown_session(self):
        """Called by the serving thread only.  The master is closed BEFORE waiting for the killed VM:
        on macOS an exiting session leader waits for its tty output to drain, which never happens
        while nobody reads the master (that cost half a second per session)."""
        self._conn, conn = None, self._conn
        self._kill_proc()
        with self._lock:
            master, self._master = self._master, None
        if master is not None:
            try:
                os.close(master)
            except OSError:
                pass
        proc, self._proc = self._proc, None
        if proc is not None:
            try:
                proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:                             # pragma: no cover
                pass
        if conn is not None:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                conn.close()
            except OSError:
                pass

    def serve_forever(self, max_seconds=0, stdin_eof=False):
        stop = threading.Event()
        if stdin_eof:
            def watch():
                try:
                    while sys.stdin.read(4096):
                        pass
                except Exception:
                    pass
                stop.set()

            threading.Thread(target=watch, name="mpunix-stdin-watch", daemon=True).start()
        t0 = time.monotonic()
        try:
            while not stop.is_set():
                if max_seconds and time.monotonic() - t0 >= max_seconds:
                    break
                stop.wait(0.2)
        except KeyboardInterrupt:
            pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="Relay the real MicroPython unix VM to socket://127.0.0.1:PORT")
    ap.add_argument("--bin", help="MicroPython unix binary (default: $MPY_UNIX_BIN)")
    ap.add_argument("--cwd", help="working directory / device root of the VM (default: temp dir)")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--print-url", action="store_true")
    ap.add_argument("--no-cook", action="store_true", help="do not convert \\n to \\r\\n")
    ap.add_argument("--no-soft-reboot", action="store_true", help="let the VM exit on Ctrl-D (no emulation)")
    ap.add_argument("--max-seconds", type=float, default=0)
    ap.add_argument("--exit-on-stdin-eof", action="store_true")
    args = ap.parse_args(argv)
    if args.bin:
        os.environ["MPY_UNIX_BIN"] = args.bin
    ok, reason = UnixVM.available()
    if not ok:
        print(reason, file=sys.stderr)
        return 2
    vm = UnixVM(cwd=args.cwd, cook=not args.no_cook, emulate_soft_reboot=not args.no_soft_reboot,
                port=args.port)
    vm.start()
    try:
        print(vm.url if args.print_url else "LISTENING " + vm.url, flush=True)
        vm.serve_forever(args.max_seconds, args.exit_on_stdin_eof)
    finally:
        vm.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
