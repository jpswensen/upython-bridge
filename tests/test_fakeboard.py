"""Tests for tools/fakeboard.py (the fake MicroPython board) and tools/mpunix_relay.py (real VM relay).

Run from the repo root:
    export MPY_SAFE_MODE=1
    export MPY_UNIX_BIN=<path to the MicroPython unix port binary>      # optional: VM tests skip without it
    python3 -B -m unittest discover -s tests -t . -v

Nothing here opens a serial port: clients talk to 127.0.0.1 sockets (port 0, read back) and to
pty-backed unix VMs created by tools/mpunix_relay.py.  Real mpremote 1.29.0 and pyserial 3.5 (both vendored)
are used as independent clients.
"""
from __future__ import annotations

import ast
import json
import ntpath
import os
import select
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import warnings
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "bridge", "vendor")
for _p in (ROOT, VENDOR):
    if _p in sys.path:
        sys.path.remove(_p)
    sys.path.insert(0, _p)                      # VENDOR ends up first
os.environ["MPY_SAFE_MODE"] = "1"

from tools.fakeboard import (FakeBoard, Faults, _FakeOS, PROFILES, PROGRAMS, derive_profile, list_profiles,  # noqa: E402
                             register_profile)
from tools.mpunix_relay import UnixVM             # noqa: E402

VM_SKIP = UnixVM.skip_reason()
from tests.support import TimedTestCase as _TimedTestCase, shorten_socket_close_sleep  # noqa: E402

shorten_socket_close_sleep()  # pyserial's socket:// close() sleeps 0.3 s per Link.close(); see tests/support.py


class TimedCase(_TimedTestCase):
    """Every test in this module gets a hard per-test deadline (tests/support.py): a hang is a FAIL that names the
    blocked line, never a frozen suite.  Generous on purpose so a slow-but-correct test on a loaded machine is not flaky;
    MPY_TEST_DEADLINE_SCALE multiplies it, 0 disables it."""
    DEADLINE_S = 120.0




# ----------------------------------------------------------------------------------------------
# a tiny host-side client (raw sockets, independent of pyserial / mpremote / the bridge)
# ----------------------------------------------------------------------------------------------
class Client:
    def __init__(self, port, host="127.0.0.1"):
        self.sock = socket.create_connection((host, port), timeout=5.0)
        self.sock.settimeout(0.02)
        self.buf = bytearray()
        self.eof = False

    def send(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.sock.sendall(data)

    def _pump(self):
        try:
            d = self.sock.recv(65536)
        except socket.timeout:
            return
        except OSError:
            self.eof = True
            return
        if d:
            self.buf += d
        else:
            self.eof = True

    def pending(self):
        """Bytes waiting, without blocking (select on a socket is fine on Windows too)."""
        try:
            ready, _, _ = select.select([self.sock], [], [], 0)
        except (OSError, ValueError):
            ready = [self.sock]                 # closed: let _pump() notice the EOF
        if ready:
            self._pump()
        return len(self.buf)

    def read_until(self, token, timeout=5.0):
        if isinstance(token, str):
            token = token.encode()
        end = time.monotonic() + timeout
        while True:
            i = self.buf.find(token)
            if i >= 0:
                out = bytes(self.buf[:i + len(token)])
                del self.buf[:i + len(token)]
                return out
            if self.eof or time.monotonic() > end:
                raise AssertionError("waiting for %r; got %r (eof=%s)" % (token, bytes(self.buf), self.eof))
            self._pump()

    def read_exact(self, n, timeout=5.0):
        end = time.monotonic() + timeout
        while len(self.buf) < n:
            if self.eof or time.monotonic() > end:
                raise AssertionError("waiting for %d bytes; got %r (eof=%s)" % (n, bytes(self.buf), self.eof))
            self._pump()
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def read_for(self, secs):
        end = time.monotonic() + secs
        while time.monotonic() < end and not self.eof:
            self._pump()
        out = bytes(self.buf)
        self.buf.clear()
        return out

    def read_quiet(self, quiet, limit=5.0):
        """Everything that arrives until `quiet` seconds pass without a byte (capped by `limit`)."""
        end = time.monotonic() + limit
        last, n = time.monotonic(), len(self.buf)
        while not self.eof and time.monotonic() < end:
            self._pump()
            if len(self.buf) != n:
                last, n = time.monotonic(), len(self.buf)
            elif time.monotonic() - last >= quiet:
                break
        out = bytes(self.buf)
        self.buf.clear()
        return out

    def read_matching(self, expected, quiet=0.015, limit=5.0):
        """Wait for exactly `expected`: returns as soon as the bytes equal it and nothing more came for `quiet`
        seconds, or at once when they can no longer become it (a mismatch), or at the deadline."""
        end = time.monotonic() + limit
        last, n = time.monotonic(), len(self.buf)
        while not self.eof and time.monotonic() < end:
            self._pump()
            if len(self.buf) != n:
                last, n = time.monotonic(), len(self.buf)
            if not expected.startswith(bytes(self.buf)):
                break                                   # diverged: the caller's assertEqual shows the difference
            if bytes(self.buf) == expected and time.monotonic() - last >= quiet:
                break
        out = bytes(self.buf)
        self.buf.clear()
        return out

    def wait_eof(self, timeout=5.0):
        end = time.monotonic() + timeout
        while not self.eof and time.monotonic() < end:
            self._pump()
        return self.eof

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    # ---- protocol helpers
    def prompt(self, timeout=5.0):
        return self.read_until(b">>> ", timeout)

    def wake(self):
        self.send(b"\r")                          # one Enter (a CRLF pair is TWO Enters on v1.29.0)
        return self.prompt()

    def enter_raw(self, timeout=5.0):
        self.send(b"\r\x03")
        self.send(b"\r\x01")
        return self.read_until(b"raw REPL; CTRL-B to exit\r\n>", timeout)

    def raw_exec(self, code, timeout=10.0):
        """Plain raw REPL exec: returns (stdout, stderr)."""
        if isinstance(code, str):
            code = code.encode("utf-8")
        self.send(code + b"\x04")
        self.read_exact(2, timeout)               # OK
        out = self.read_until(b"\x04", timeout)[:-1]
        err = self.read_until(b"\x04", timeout)[:-1]
        self.read_until(b">", timeout)
        return out, err

    def paste_exec(self, code, timeout=10.0):
        """Raw-paste exec like mpremote does it: returns (stdout, stderr, credits_seen)."""
        if isinstance(code, str):
            code = code.encode("utf-8")
        self.send(b"\x05A\x01")
        assert self.read_exact(2, timeout) == b"R\x01"
        win = struct.unpack("<H", self.read_exact(2, timeout))[0]
        remain = win
        credits = 0
        i = 0
        while i < len(code):
            while remain == 0 or self.pending():
                b = self.read_exact(1, timeout)
                if b == b"\x01":
                    remain += win
                    credits += 1
                else:
                    raise AssertionError("unexpected byte during paste: %r" % b)
            n = min(remain, len(code) - i)
            self.send(code[i:i + n])
            remain -= n
            i += n
        self.send(b"\x04")
        ack = self.read_until(b"\x04", timeout)
        credits += ack.count(b"\x01")
        out = self.read_until(b"\x04", timeout)[:-1]
        err = self.read_until(b"\x04", timeout)[:-1]
        self.read_until(b">", timeout)
        return out, err, credits


def py_eval(client, code):
    """Raw exec `code` (which prints repr of a Python literal) and return the parsed value."""
    out, err = client.raw_exec(code)
    assert not err, err
    return ast.literal_eval(out.decode().strip())


class BoardTestCase(TimedCase):
    """Starts boards/clients with guaranteed cleanup and a thread-leak check."""

    def make(self, *args, **kw):
        b = FakeBoard(*args, **kw)
        self.addCleanup(self._no_leaks, b)
        self.addCleanup(b.stop)
        b.start()
        return b

    def client(self, board):
        c = Client(board.port)
        self.addCleanup(c.close)
        return c

    def _no_leaks(self, board):
        self.assertEqual([t.name for t in board.leaked_threads()], [], "threads leaked after stop()")

    def connect_idle(self, board, **kw):
        """Board + client sitting at a friendly prompt."""
        c = self.client(board)
        c.wake()
        return c


# ----------------------------------------------------------------------------------------------
# friendly REPL
# ----------------------------------------------------------------------------------------------
class FriendlyReplTests(BoardTestCase):
    def test_prompt_after_enter_and_no_output_on_plain_connect(self):
        b = self.make("esp32")
        c = self.client(b)
        self.assertEqual(c.read_for(0.15), b"", "a plain connect must not make the board say anything")
        c.send(b"\r")
        self.assertEqual(c.prompt(), b"\r\n>>> ")

    def test_echo_and_expression_result(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"1+2\r")
        self.assertEqual(c.prompt(), b"1+2\r\n3\r\n>>> ")
        c.send(b"print('a', 'b')\r")
        self.assertEqual(c.prompt(), b"print('a', 'b')\r\na b\r\n>>> ")

    def test_none_result_prints_nothing(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"x = 5\r")
        self.assertEqual(c.prompt(), b"x = 5\r\n>>> ")

    def test_traceback_format_is_micropython_like(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"1/0\r")
        self.assertEqual(c.prompt(), b"1/0\r\nTraceback (most recent call last):\r\n"
                                     b"  File \"<stdin>\", line 1, in <module>\r\nZeroDivisionError: divide by zero\r\n>>> ")
        c.send(b"nosuch\r")
        self.assertIn(b"NameError: name 'nosuch' isn't defined\r\n", c.prompt())
        c.send(b"import nosuchmod\r")
        self.assertIn(b"ImportError: no module named 'nosuchmod'\r\n", c.prompt())
        c.send(b"open('/nope')\r")
        self.assertIn(b"OSError: [Errno 2] ENOENT\r\n", c.prompt())

    def test_syntax_error_does_not_kill_the_repl(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"1 +* 2\r")
        self.assertIn(b"SyntaxError", c.prompt())
        c.send(b"print(7)\r")
        self.assertIn(b"7\r\n", c.prompt())

    def test_continuation_and_auto_indent(self):
        # [E] behaviour measured on the real v1.29.0 unix VM (readline.c): see tools/fakeboard.py
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"for i in range(2):\r")
        self.assertEqual(c.read_until(b"... "), b"for i in range(2):\r\n... ")
        self.assertEqual(c.read_exact(4), b"    ", "auto indent after a colon")
        c.send(b"print(i)\r")
        self.assertEqual(c.read_until(b"... "), b"print(i)\r\n... ")
        self.assertEqual(c.read_exact(4), b"    ", "the indent is repeated")
        c.send(b"\r")                              # an auto-indented blank line does NOT end the block
        self.assertEqual(c.read_until(b"... "), b"\r\n... ")
        self.assertEqual(c.read_exact(4), b"    ")
        c.send(b"\x7f")                            # Backspace removes the whole indent at once
        self.assertEqual(c.read_exact(5), b"\x08\x08\x08\x08\x1b[K"[:5])
        c.read_exact(1)
        c.send(b"\r")                              # a truly empty line ends it
        out = c.prompt()
        self.assertTrue(out.endswith(b"\r\n0\r\n1\r\n>>> "), out)

    def test_typed_indentation_replaces_the_auto_indent_and_empty_line_ends_the_block(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"for i in range(3):\r    print(i)\r    print(i * 10)\r\r")
        out = c.prompt()
        self.assertTrue(out.endswith(b"0\r\n0\r\n1\r\n10\r\n2\r\n20\r\n>>> "), out)
        c.send(b"if 1:\r  x = 1\r  y = 2\r\r")
        c.prompt()
        c.send(b"print(x, y)\r")
        self.assertIn(b"1 2\r\n", c.prompt())

    def test_brackets_and_triple_quotes_continue(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"v = (1,\r")
        c.read_until(b"... ")
        c.send(b"2)\r")
        c.prompt()
        c.send(b"v\r")
        self.assertIn(b"(1, 2)\r\n", c.prompt())
        c.send(b"s = \'\'\'a\r")
        c.read_until(b"... ")
        c.send(b"b\'\'\'\r")
        c.prompt()
        c.send(b"s\r")
        self.assertIn(b"'a\\nb'\r\n", c.prompt())

    def test_ctrl_c_at_prompt(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"partial")
        c.read_until(b"partial")
        c.send(b"\x03")
        self.assertEqual(c.prompt(), b"\r\n>>> ")
        c.send(b"1\r")
        self.assertEqual(c.prompt(), b"1\r\n1\r\n>>> ", "the partial line is gone")

    def test_backspace(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"print(1)x\x7f\r")
        self.assertTrue(c.prompt().endswith(b"1\r\n>>> "))

    def test_escape_sequences_are_swallowed(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"\x1b[A\x1b[B1+1\r")
        self.assertEqual(c.prompt(), b"1+1\r\n2\r\n>>> ")

    def test_ctrl_b_prints_banner(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"\x02")
        out = c.prompt()
        self.assertIn(b"MicroPython v1.29.0 on 2026-05-20; ESP32 module (spiram) with ESP32\r\n"
                      b"Type \"help()\" for more information.\r\n>>> ", out)

    def test_paste_mode(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"\x05")
        c.read_until(b"paste mode; Ctrl-C to cancel, Ctrl-D to finish\r\n=== ")
        c.send(b"def f():\r    return 41\r\rprint(f()+1)\r")
        c.read_until(b"=== ", timeout=3)
        c.send(b"\x04")
        out = c.prompt()
        self.assertIn(b"42\r\n", out)
        self.assertEqual(b.events.count("paste_start", kind="friendly"), 1)

    def test_paste_mode_cancel(self):
        b = self.make("esp32")
        c = self.connect_idle(b)
        c.send(b"\x05")
        c.read_until(b"=== ")
        c.send(b"print(1)\r\x03")
        self.assertIn(b"\r\n>>> ", c.read_until(b">>> "))
        self.assertEqual(b.events.count("exec"), 0)

    def test_help_modules_lists_builtin_and_frozen(self):
        b = self.make("custom-frozen")
        c = self.connect_idle(b)
        c.send(b"help('modules')\r")
        out = c.prompt().decode()
        self.assertIn("acme", out)
        self.assertIn("_acme", out)
        self.assertIn("Plus any modules on the filesystem", out)

    def test_crlf_is_two_enters_like_the_real_v1_29_vm_unless_the_profile_says_otherwise(self):
        for prof, second_prompt in (("esp32", True), (derive_profile("esp32", crlf_single_enter=True), False)):
            b = self.make(prof)
            c = self.client(b)
            c.send(b"\r")
            c.prompt()
            c.send(b"1\r\n")
            self.assertEqual(c.prompt(), b"1\r\n1\r\n>>> ")
            extra = c.read_for(0.15)
            self.assertEqual(extra, b"\r\n>>> " if second_prompt else b"")


# ----------------------------------------------------------------------------------------------
# raw REPL, raw paste, soft reset
# ----------------------------------------------------------------------------------------------
class RawReplTests(BoardTestCase):
    def test_enter_raw_banner_and_exec_framing(self):
        b = self.make("esp32")
        c = self.client(b)
        c.send(b"\r\x03")
        c.send(b"\r\x01")
        self.assertTrue(c.read_until(b"raw REPL; CTRL-B to exit\r\n>").endswith(b"raw REPL; CTRL-B to exit\r\n>"))
        c.send(b"print('hi')\x04")
        self.assertEqual(c.read_exact(2), b"OK")
        self.assertEqual(c.read_until(b">"), b"hi\r\n\x04\x04>")

    def test_exception_goes_to_the_second_channel(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        out, err = c.raw_exec("print('before')\n1/0")
        self.assertEqual(out, b"before\r\n")
        self.assertEqual(err, b"Traceback (most recent call last):\r\n  File \"<stdin>\", line 2, in <module>\r\n"
                              b"ZeroDivisionError: divide by zero\r\n")

    def test_globals_persist_between_raw_commands_and_friendly_repl(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.raw_exec("keepme = 123")
        out, _ = c.raw_exec("print(keepme + 1)")
        self.assertEqual(out, b"124\r\n")
        c.send(b"\x02")
        c.prompt()
        c.send(b"keepme\r")
        self.assertIn(b"123\r\n", c.prompt())

    def test_ctrl_b_leaves_raw_with_banner(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.send(b"\x02")
        out = c.prompt()
        self.assertTrue(out.startswith(b"\r\nMicroPython v1.29.0"), out)
        self.assertEqual(b.events.count("raw_exit"), 1)

    def test_soft_reset_text_and_boot_py_output(self):
        b = self.make("esp32", files={"/boot.py": "print('boot ran')\n", "/main.py": "print('main ran')\n"})
        c = self.client(b)
        c.enter_raw()
        c.send(b"\x04")
        self.assertEqual(c.read_until(b"raw REPL; CTRL-B to exit\r\n>"),
                         b"OK\r\nMPY: soft reboot\r\nboot ran\r\nraw REPL; CTRL-B to exit\r\n>")
        self.assertEqual(b.events.count("soft_reset"), 1)

    def test_main_py_runs_from_friendly_ctrl_d_but_not_from_raw(self):
        b = self.make("esp32", files={"/boot.py": "print('boot')\n", "/main.py": "print('main')\n"})
        c = self.connect_idle(b)
        c.send(b"\x04")
        out = c.prompt()
        self.assertEqual(out, b"\r\nMPY: soft reboot\r\nboot\r\nmain\r\n"
                              b"MicroPython v1.29.0 on 2026-05-20; ESP32 module (spiram) with ESP32\r\n"
                              b"Type \"help()\" for more information.\r\n>>> ")
        c.enter_raw()
        c.send(b"\x04")
        out = c.read_until(b"raw REPL; CTRL-B to exit\r\n>")
        self.assertIn(b"boot\r\n", out)
        self.assertNotIn(b"main", out)

    def test_raising_boot_py_skips_main_py(self):
        b = self.make("esp32", files={"/boot.py": "1/0\n", "/main.py": "print('main')\n"})
        c = self.connect_idle(b)
        c.send(b"\x04")
        out = c.prompt()
        self.assertIn(b"ZeroDivisionError", out)
        self.assertNotIn(b"main\r\n", out)

    def test_ticks_survive_soft_reset_but_not_hard_reset(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.raw_exec("import time")
        t1 = py_eval(c, "print(time.ticks_ms())")
        c.send(b"\x04")
        c.read_until(b"raw REPL; CTRL-B to exit\r\n>")
        c.raw_exec("import time")
        t2 = py_eval(c, "print(time.ticks_ms())")
        self.assertGreaterEqual(t2, t1)
        b.hard_reset()
        c.read_until(b">>> ", timeout=5)
        c.enter_raw()
        c.raw_exec("import time")
        t3 = py_eval(c, "print(time.ticks_ms())")
        self.assertLess(t3, 4000)

    def test_raw_paste_handshake_bytes(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.send(b"\x05A\x01")
        self.assertEqual(c.read_exact(5), b"R\x01\x80\x00\x01")
        c.send(b"print('x')\x04")
        self.assertEqual(c.read_until(b"\x04"), b"\x04")
        self.assertEqual(c.read_until(b">"), b"x\r\n\x04\x04>")
        self.assertEqual(b.events.count("paste_start", kind="raw"), 1)

    def test_raw_paste_flow_control_matches_pyexec(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        for n in (1, 127, 128, 129, 255, 256, 257, 1000):
            code = b"#" * (n - 8) + b"\nprint(1)" if n > 9 else b"print(1)"[:n]
            code = (b"#" * max(0, n - len(b"\nprint(1)"))) + b"\nprint(1)"
            if n < len(b"\nprint(1)"):
                code = b"1"
            out, err, credits = c.paste_exec(code)
            self.assertEqual(err, b"", (n, err))
            self.assertEqual(credits, 1 + len(code) // 128, "credit bytes for %d bytes" % len(code))

    def test_raw_paste_large_program_arrives_intact(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        body = "\n".join("x%d = %d" % (i, i) for i in range(2000)) + "\nprint(x1999 + len(%r))\n" % ("é" * 50)
        out, err, _ = c.paste_exec(body)
        self.assertEqual(err, b"")
        self.assertEqual(out.strip(), b"2049")

    def test_raw_paste_ctrl_c_aborts(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.send(b"\x05A\x01")
        c.read_exact(5)
        c.send(b"print('never')\x03")
        self.assertEqual(c.read_until(b">"), b"\x04\x04KeyboardInterrupt: \r\n\x04>")
        self.assertEqual(b.events.count("paste_abort"), 1)
        out, _ = c.raw_exec("print('alive')")
        self.assertEqual(out, b"alive\r\n")

    def test_no_raw_paste_answers_R0(self):
        for kw in ({"profile": derive_profile("esp32", caps={"raw_paste": False})},
                   {"profile": "esp32", "faults": ["no_raw_paste"]}):
            b = self.make(**kw)
            c = self.client(b)
            c.enter_raw()
            c.send(b"\x05A\x01")
            self.assertEqual(c.read_exact(2), b"R\x00")
            out, _ = c.raw_exec("print(2)")             # normal raw exec still works
            self.assertEqual(out, b"2\r\n")

    def test_stray_ctrl_e_is_program_text(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        out, _ = c.raw_exec("print('a\x05b')")
        self.assertEqual(out, b"a\x05b\r\n")

    def test_ctrl_a_again_in_raw_mode_resets_the_line(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.send(b"garbage\x01")
        c.read_until(b"raw REPL; CTRL-B to exit\r\n>")
        out, _ = c.raw_exec("print(5)")
        self.assertEqual(out, b"5\r\n")

    def test_sys_exit_is_a_soft_reboot(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.send(b"import sys\nsys.exit()\x04")
        c.read_exact(2)
        self.assertEqual(c.read_until(b"raw REPL; CTRL-B to exit\r\n>"),
                         b"\x04\x04MPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>")
        self.assertEqual(b.events.count("soft_reset"), 1)

    def test_machine_reset_is_a_hard_reset_with_rom_noise_on_uart_bridge(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.send(b"import machine\nmachine.reset()\x04")
        c.read_exact(2)
        out = c.read_until(b">>> ", timeout=5)
        self.assertIn(b"POWERON_RESET", out)
        self.assertEqual(b.events.count("hard_reset"), 1)
        self.assertEqual(b.mode, "friendly", "a hard reset leaves raw mode")

    def test_max_source_bytes_gives_memoryerror_on_small_boards(self):
        b = self.make("esp8266")
        c = self.client(b)
        c.enter_raw()
        out, err = c.raw_exec("#" * 9000 + "\nprint(1)")
        self.assertIn(b"MemoryError", err)
        out, err = c.raw_exec("print(1)")
        self.assertEqual(out, b"1\r\n")


# ----------------------------------------------------------------------------------------------
# program stdin (RQ-RUN-1) and interrupts
# ----------------------------------------------------------------------------------------------
ECHO_PROGRAM = PROGRAMS["echo_keys"]
POLL_PROGRAM = PROGRAMS["poll_keys"]


class ProgramStdinTests(BoardTestCase):
    def start_program(self, board, code, paste=False):
        c = self.client(board)
        c.enter_raw()
        if paste:
            c.send(b"\x05A\x01")
            c.read_exact(5)
            c.send(code.encode() + b"\x04")
            c.read_until(b"\x04")
        else:
            c.send(code.encode() + b"\x04")
            c.read_exact(2)
        return c

    def test_echo_program_reads_host_keystrokes(self):
        for paste in (False, True):
            b = self.make("esp32")
            c = self.start_program(b, ECHO_PROGRAM, paste)
            c.read_until(b"READY\r\n")
            c.send(b"a")
            self.assertEqual(c.read_until(b"\r\n"), b"key:'a'\r\n")
            c.send(b"xyq")
            self.assertEqual(c.read_until(b"DONE\r\n"), b"key:'x'\r\nkey:'y'\r\nkey:'q'\r\nDONE\r\n")
            self.assertEqual(c.read_until(b">"), b"\x04\x04>")
            self.assertGreaterEqual(b.events.count("stdin_bytes"), 2)

    def test_poll_program_sees_idle_then_keys(self):
        b = self.make("esp32")
        c = self.start_program(b, POLL_PROGRAM)
        c.read_until(b"READY\r\n")
        time.sleep(0.1)                                  # let it idle a few polls
        c.send(b"k")
        time.sleep(0.05)
        c.send(b"j")
        self.assertEqual(c.read_until(b"\r\n"), b"got ['k', 'j'] idle True\r\n")

    def test_key_press_changes_output_within_100ms(self):
        b = self.make("esp32")
        c = self.start_program(b, ECHO_PROGRAM)
        c.read_until(b"READY\r\n")
        lat = []
        for ch in b"abc":
            t0 = time.monotonic()
            c.send(bytes([ch]))
            c.read_until(b"\r\n")
            lat.append(time.monotonic() - t0)
        self.assertLess(max(lat), 0.1, lat)

    def test_ctrl_c_raises_keyboardinterrupt_in_sleeping_program(self):
        b = self.make("esp32")
        c = self.start_program(b, "import time\nprint('go')\nwhile True:\n    time.sleep(0.01)\n")
        c.read_until(b"go\r\n")
        t0 = time.monotonic()
        c.send(b"\x03")
        err = c.read_until(b"\x04>")
        dt = time.monotonic() - t0
        self.assertIn(b"KeyboardInterrupt: \r\n", err)
        self.assertIn(b"line 4", err)
        self.assertLess(dt, 0.1, "Stop latency on the fake")
        ev = b.events.of("interrupt", state="running")
        self.assertEqual(len(ev), 1)
        self.assertTrue(ev[0]["delivered"])
        self.assertEqual(b.events.of("program_end", kind="raw")[-1]["result"], "interrupted")

    def test_course_demo_pattern_poll_loop(self):
        b = self.make("esp32")
        c = self.start_program(b, PROGRAMS["course_demo"])
        c.read_until(b"press keys, q to quit\r\n")
        for ch in (b"a", b"b", b"q"):
            c.send(ch)
            self.assertEqual(c.read_until(b"\r\n"), b"pressed " + ch + b"\r\n")
        self.assertEqual(c.read_until(b"\x04>"), b"bye\r\n\x04\x04>")

    def test_all_shared_programs_compile(self):
        for name, src in PROGRAMS.items():
            compile(src, name, "exec")

    def test_capture_records_wire_bytes_and_code(self):
        b = self.make("esp32", capture=True)
        c = self.client(b)
        c.enter_raw()
        c.raw_exec("print(7)")
        self.assertEqual(b.rx_data(), b"\r\x03\r\x01print(7)\x04")
        self.assertIn(b"raw REPL; CTRL-B to exit\r\n>OK7\r\n\x04\x04>", b.tx_data())
        self.assertEqual(b.events.of("exec")[0]["code"], "print(7)")
        self.assertEqual(b"\x04".count(b"\x04"), 1)

    def test_ctrl_c_interrupts_a_busy_loop(self):
        b = self.make("esp32")
        c = self.start_program(b, "print('go')\nwhile True:\n    pass\n")
        c.read_until(b"go\r\n")
        c.send(b"\x03")
        self.assertIn(b"KeyboardInterrupt", c.read_until(b"\x04>"))

    def test_ctrl_c_in_the_same_chunk_as_the_program_is_not_lost(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        for _ in range(15):
            c.send(b"while True:\n    pass\n\x04\x03")      # exec and interrupt arrive together
            c.read_exact(2)
            self.assertIn(b"KeyboardInterrupt", c.read_until(b"\x04>", timeout=3))

    def test_ctrl_c_during_input_and_stdin_read(self):
        b = self.make("esp32")
        c = self.start_program(b, "print('ask')\ninput('? ')\n")
        c.read_until(b"? ")
        c.send(b"\x03")
        self.assertIn(b"KeyboardInterrupt", c.read_until(b"\x04>"))

    def test_input_echoes_and_returns_the_line(self):
        b = self.make("esp32")
        c = self.start_program(b, "name = input('name? ')\nprint('hi ' + name)\n")
        c.read_until(b"name? ")
        c.send(b"Bo")
        self.assertEqual(c.read_exact(2), b"Bo")
        c.send(b"b\r")
        self.assertEqual(c.read_until(b"\x04>"), b"b\r\nhi Bob\r\n\x04\x04>")

    def test_kbd_intr_minus_one_delivers_ctrl_c_as_data(self):
        b = self.make("esp32")
        code = ("import sys, micropython\nmicropython.kbd_intr(-1)\nprint('R')\n"
                "d = sys.stdin.buffer.read(4)\nmicropython.kbd_intr(3)\nprint(list(d))\n")
        c = self.start_program(b, code)
        c.read_until(b"R\r\n")                  # Ctrl-C is armed until the program has run kbd_intr(-1)
        c.send(b"\x03\x04\x01\x05")
        self.assertEqual(c.read_until(b"\x04>"), b"[3, 4, 1, 5]\r\n\x04\x04>")
        self.assertEqual(b.events.count("interrupt", state="running"), 0)

    def test_acked_streaming_upload_snippet_from_the_analysis(self):
        b = self.make("esp32")
        data = bytes(range(256)) * 12                            # 3072 bytes incl. 0x03 and 0x04
        snippet = ("import sys, micropython\nmicropython.kbd_intr(-1)\nr=sys.stdin.buffer.read\nw=sys.stdout.write\n"
                   "f=open('/up.tmp','wb')\nn=%d\nw('!')\ntry:\n while n:\n  k=min(n,1024)\n  f.write(r(k)); n-=k\n  w('.')\n"
                   "finally:\n f.close(); micropython.kbd_intr(3)\n" % len(data))
        c = self.start_program(b, snippet)
        self.assertEqual(c.read_exact(1), b"!")                  # ready: Ctrl-C is no longer armed
        for i in range(0, len(data), 1024):
            c.send(data[i:i + 1024])
            self.assertEqual(c.read_exact(1), b".")
        self.assertEqual(c.read_until(b">"), b"\x04\x04>")
        self.assertEqual(b.read_file("/up.tmp"), data)

    def test_close_mid_transfer_during_streaming(self):
        b = self.make("esp32", faults=["close_mid_transfer:1500"])
        snippet = ("import sys\nr=sys.stdin.buffer.read\nf=open('/part.bin','wb')\n"
                   "for i in range(3):\n f.write(r(1024)); sys.stdout.write('.')\nf.close()\n")
        c = self.start_program(b, snippet)
        time.sleep(0.05)
        c.send(b"x" * 1024)
        self.assertEqual(c.read_exact(1), b".")
        c.send(b"y" * 1024)
        self.assertTrue(c.wait_eof())
        self.assertIsNotNone(b.events.wait_for("fault", name="close_mid_transfer"))

    def test_bytes_typed_after_the_program_ended_reach_the_repl(self):
        b = self.make("esp32")
        c = self.start_program(b, "import time\ntime.sleep(0.3)\nprint('end')\n")
        c.send(b"z=9\r")                                         # the program never reads it
        self.assertEqual(c.read_until(b"\x04>"), b"end\r\n\x04\x04>")
        c.send(b"print(z)\x04")                                  # replayed junk is raw-REPL text: z=9\rprint(z)
        out = c.read_until(b"\x04>")
        self.assertIn(b"OK", out)

    def test_main_py_in_friendly_mode_gets_keys_and_ctrl_c(self):
        main = ("import sys\nprint('main up')\nwhile True:\n    c = sys.stdin.read(1)\n"
                "    print('got', repr(c))\n")
        b = self.make("esp32", files={"/main.py": main}, power_on="connect")
        c = self.client(b)
        c.read_until(b"main up\r\n")
        c.send(b"w")
        self.assertEqual(c.read_until(b"\r\n"), b"got 'w'\r\n")
        c.send(b"\x03")
        out = c.prompt()
        self.assertIn(b"KeyboardInterrupt: \r\n", out)
        self.assertIn(b'File "main.py", line 4, in <module>', out)
        self.assertIn(b"MicroPython v1.29.0", out)

    def test_uart_ring_buffer_overflow_drops_and_logs(self):
        b = self.make(derive_profile("esp32", stdin_buffer=8))
        c = self.start_program(b, "import time\nprint('go')\ntime.sleep(0.4)\nimport sys\nprint(len(sys.stdin.read(8)))\n")
        c.read_until(b"go\r\n")
        c.send(b"0123456789ABCDEF")
        out = c.read_until(b"\x04>")
        self.assertEqual(out, b"8\r\n\x04\x04>")
        self.assertEqual(sum(e["dropped"] for e in b.events.of("stdin_overflow")), 8)

    def test_select_select_and_poll_pollout(self):
        b = self.make("esp32")
        code = ("import sys, select\nr, w, x = select.select([sys.stdin], [sys.stdout], [], 0)\n"
                "print(len(r), len(w))\np = select.poll()\np.register(sys.stdout, select.POLLOUT)\n"
                "print(p.poll(0)[0][1] == select.POLLOUT)\n")
        c = self.start_program(b, code)
        self.assertEqual(c.read_until(b"\x04>"), b"0 1\r\nTrue\r\n\x04\x04>")


# ----------------------------------------------------------------------------------------------
# profiles
# ----------------------------------------------------------------------------------------------
IDENT = """\
import sys, os, gc, binascii
d = {}
d['impl'] = [(k, getattr(sys.implementation, k)) for k in ('name', 'version', '_machine', '_build', '_mpy', '_thread') if hasattr(sys.implementation, k)]
d['platform'] = sys.platform
d['path'] = sys.path
try:
    u = os.uname()
    d['uname'] = (u[0], u[1], u[2], u[3], u[4])
except AttributeError:
    d['uname'] = None
try:
    import machine
    d['uid'] = binascii.hexlify(machine.unique_id()).decode()
except (ImportError, AttributeError):
    d['uid'] = None
try:
    import hashlib
    try:
        d['hash'] = binascii.hexlify(hashlib.sha256(b'abc').digest()).decode()[:8]
    except AttributeError:
        d['hash'] = 'nosha256'
except ImportError:
    d['hash'] = 'missing'
try:
    compile('1', 'x', 'eval')
    d['compile'] = True
except NameError:
    d['compile'] = False
d['mem'] = gc.mem_free()
d['root'] = os.listdir('/')
print(repr(d))
"""


class ProfileTests(BoardTestCase):
    def test_all_expected_profiles_are_registered(self):
        for name in ("esp32", "esp32s3-usb", "rp2", "rp2350", "stm32", "esp8266", "esp32-legacy",
                     "custom-frozen", "unix-like"):
            self.assertIn(name, list_profiles())
            self.assertIn("description", PROFILES[name])

    def test_identity_values_match_profile_data(self):
        for name in list_profiles():
            with self.subTest(profile=name):
                prof = PROFILES[name]
                b = self.make(name)
                c = self.client(b)
                c.enter_raw()
                d = py_eval(c, IDENT)
                impl = dict(d["impl"])
                self.assertEqual(impl["name"], "micropython")
                self.assertEqual(impl["version"], tuple(prof["version_tuple"]))
                self.assertEqual(impl["_machine"], prof["machine"])
                for k, v in prof["impl_extra"].items():
                    if v is None:
                        self.assertNotIn(k, impl, name)
                    else:
                        self.assertEqual(impl[k], v, (name, k))
                self.assertEqual(d["platform"], prof["platform"])
                self.assertEqual(d["path"], prof["sys_path"])
                if prof["uname"]:
                    self.assertEqual(d["uname"], (prof["sysname"], prof["nodename"], prof["release"],
                                                  prof["version_full"], prof["machine"]))
                else:
                    self.assertIsNone(d["uname"], "%s must have no os.uname()" % name)
                self.assertEqual(d["uid"], prof["unique_id"].hex() if prof["unique_id"] else None)
                self.assertEqual(d["mem"], prof["caps"]["mem_free"])
                self.assertEqual(sorted(d["root"]), sorted(["flash"] if prof["mount"] else prof["root_files"]))

    def test_banner_comes_from_the_profile(self):
        for name in list_profiles():
            with self.subTest(profile=name):
                b = self.make(name)
                c = self.client(b)
                c.send(b"\x02")
                out = c.prompt()
                self.assertIn(("MicroPython %s; %s\r\n" % (PROFILES[name]["version_full"], PROFILES[name]["machine"])).encode(), out)

    def test_expected_values_for_the_named_boards(self):
        c = None
        want = {
            "esp32": ("ESP32 module (spiram) with ESP32", "ESP32_GENERIC"),
            "esp32s3-usb": ("Generic ESP32S3 module with ESP32S3", "ESP32_GENERIC_S3"),
            "rp2": ("Raspberry Pi Pico with RP2040", "RPI_PICO"),
            "stm32": ("PYBv1.1 with STM32F405RG", "PYBV11"),
            "custom-frozen": ("ACME Motor Controller with ESP32", "ACME_BOARD"),
        }
        for name, (machine, build) in want.items():
            self.assertEqual(PROFILES[name]["machine"], machine)
            self.assertEqual(PROFILES[name]["impl_extra"]["_build"], build)
        self.assertNotIn("_build", {k: v for k, v in PROFILES["esp8266"]["impl_extra"].items() if v is not None})
        self.assertEqual(PROFILES["esp8266"]["caps"]["compile"], False)
        self.assertEqual(PROFILES["rp2"]["caps"]["hashlib"], True)
        self.assertEqual(PROFILES["stm32"]["sysname"], "pyboard")

    def test_usb_adapter_metadata(self):
        self.assertEqual(PROFILES["esp32"]["usb"]["kind"], "uart-bridge")
        self.assertEqual(PROFILES["esp32s3-usb"]["usb"]["kind"], "native-cdc")
        self.assertTrue(PROFILES["rp2"]["usb"]["needs_dtr"])
        self.assertEqual(PROFILES["rp2"]["usb"]["vid"], 0x2E8A)

    def test_esp8266_has_no_sha256_but_has_a_hashlib_module(self):
        b = self.make("esp8266")
        c = self.client(b)
        c.enter_raw()
        d = py_eval(c, IDENT)
        self.assertEqual(d["hash"], "nosha256")
        self.assertFalse(d["compile"])
        out, err = c.raw_exec("import hashlib\nhashlib.sha256")
        self.assertIn(b"AttributeError", err)
        self.assertEqual(py_eval(c, "import hashlib\nprint(hasattr(hashlib, 'sha1'))"), True)

    def test_no_hashlib_fault_and_no_compile_fault(self):
        b = self.make("esp32", faults=["no_hashlib", "no_compile"])
        c = self.client(b)
        c.enter_raw()
        d = py_eval(c, IDENT)
        self.assertEqual(d["hash"], "missing")
        self.assertFalse(d["compile"])
        out, err = c.raw_exec("import hashlib")
        self.assertIn(b"ImportError: no module named 'hashlib'", err)

    def test_rp2_and_stock_boards_have_sha256(self):
        for name in ("esp32", "rp2", "stm32", "unix-like", "esp32s3-usb"):
            b = self.make(name)
            c = self.client(b)
            c.enter_raw()
            d = py_eval(c, IDENT)
            self.assertEqual(d["hash"], "ba7816bf", name)
            self.assertTrue(d["compile"], name)

    def test_unix_like_has_no_uname_no_unique_id_and_3_tuple_ilistdir(self):
        b = self.make("unix-like", files={"/a.txt": b"abc"})
        c = self.client(b)
        c.enter_raw()
        self.assertEqual(py_eval(c, "import os\nprint(list(os.ilistdir('/')))"), [("a.txt", 0x8000, 0)])
        out, err = c.raw_exec("import os\nos.uname()")
        self.assertIn(b"AttributeError", err)
        out, err = c.raw_exec("import machine\nmachine.unique_id()")
        self.assertIn(b"AttributeError", err)

    def test_other_boards_have_4_tuple_ilistdir_with_size(self):
        b = self.make("esp32", files={"/a.txt": b"abc", "/d/x": b"1"})
        c = self.client(b)
        c.enter_raw()
        self.assertEqual(py_eval(c, "import os\nprint(list(os.ilistdir('/')))"),
                         [("a.txt", 0x8000, 0, 3), ("boot.py", 0x8000, 0, len(PROFILES["esp32"]["root_files"]["boot.py"])),
                          ("d", 0x4000, 0, 0)])

    def test_stm32_files_live_under_flash(self):
        b = self.make("stm32")
        c = self.client(b)
        c.enter_raw()
        self.assertEqual(py_eval(c, "import os\nprint(os.listdir('/'))"), ["flash"])
        self.assertEqual(py_eval(c, "import os\nprint((os.getcwd(), sorted(os.listdir())))"),
                         ("/flash", ["README.txt", "boot.py", "main.py", "pybcdc.inf"]))
        c.raw_exec("with open('/flash/new.txt', 'w') as f:\n    f.write('x')")
        self.assertEqual(b.read_file("/flash/new.txt"), b"x")
        out, err = c.raw_exec("open('/new2.txt','w')")
        self.assertIn(b"ENOENT", err)                                 # '/' itself is read-only

    def test_custom_frozen_package_and_c_module(self):
        b = self.make("custom-frozen")
        c = self.client(b)
        c.enter_raw()
        self.assertEqual(py_eval(c, "import os\nprint(sorted(os.listdir('/')))"), ["boot.py"],
                         "frozen/C modules are not files")
        out, err = c.raw_exec("import acme, _acme, sys\nprint(acme.ABI, _acme.ABI, _acme.VERSION)\n"
                              "acme.info()\nm = acme.Motor(1)\nm.run(5)\nprint(m.speed)\n"
                              "print('acme' in sys.modules, 'acme.motor' in sys.modules)")
        self.assertEqual(err, b"")
        self.assertEqual(out, b"3 3 1.2.0\r\nacme ABI 3 build ACME_BOARD\r\n5\r\nTrue True\r\n")
        self.assertIn("_acme", b.device.builtin_names())

    def test_abi_mismatch_is_an_importerror_with_the_flash_hint(self):
        prof = derive_profile("custom-frozen", c_modules={"_acme": "ABI = 2\n"})
        b = self.make(prof)
        c = self.client(b)
        c.enter_raw()
        out, err = c.raw_exec("import acme")
        self.assertIn(b"ImportError: acme ABI 2 does not match this package: flash the matching ACME_BOARD firmware", err)
        self.assertIn(b'File "acme/__init__.py", line 3, in <module>', err)

    def test_root_file_shadows_a_frozen_module_like_on_a_board(self):
        b = self.make("custom-frozen", files={"/acme.py": "WHO = 'student'\n"})
        c = self.client(b)
        c.enter_raw()
        out, err = c.raw_exec("import acme\nprint(acme.WHO, acme.__file__)")
        self.assertEqual((out, err), (b"student acme.py\r\n", b""))

    def test_student_file_named_time_shadows_the_builtin(self):
        b = self.make("esp32", files={"/time.py": "x = 'mine'\n"})
        c = self.client(b)
        c.enter_raw()
        out, err = c.raw_exec("import time\nprint(time.x)")
        self.assertEqual(out, b"mine\r\n")

    def test_os_path_does_not_exist(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        out, err = c.raw_exec("import os.path")
        self.assertIn(b"ImportError: no module named 'os.path'", err)

    def test_micropython_only_names_are_missing(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        out, err = c.raw_exec("FileNotFoundError")
        self.assertIn(b"NameError: name 'FileNotFoundError' isn't defined", err)

    def test_register_and_derive_profile(self):
        p = register_profile("test-board-xyz", {"machine": "Test board"}, base="rp2",
                             impl_extra={"_build": "TESTB"}, caps={"mem_free": 1234})
        try:
            b = self.make("test-board-xyz")
            c = self.client(b)
            c.enter_raw()
            d = py_eval(c, IDENT)
            self.assertEqual(dict(d["impl"])["_machine"], "Test board")
            self.assertEqual(dict(d["impl"])["_build"], "TESTB")
            self.assertEqual(d["mem"], 1234)
            self.assertEqual(d["root"], [])
        finally:
            PROFILES.pop("test-board-xyz", None)
        dprof = derive_profile("esp32", name="mine", impl_extra={"_build": None})
        self.assertNotIn("_build", {k: v for k, v in dprof["impl_extra"].items() if v is not None})
        self.assertIn("esp32", PROFILES)
        self.assertEqual(PROFILES["esp32"]["impl_extra"]["_build"], "ESP32_GENERIC", "derive must not mutate the base")
        b = self.make(dprof)                                           # a dict is accepted as profile
        self.assertEqual(b.profile["name"], "mine")

    def test_unknown_profile_and_fault_raise(self):
        with self.assertRaises(ValueError):
            FakeBoard("no-such-board")
        with self.assertRaises(ValueError):
            FakeBoard("esp32", faults=["nope"])

    def test_unique_id_override(self):
        b = self.make("esp32", unique_id=bytes.fromhex("0102030405060708"))
        c = self.client(b)
        c.enter_raw()
        self.assertEqual(py_eval(c, IDENT)["uid"], "0102030405060708")

    def test_machine_reset_cause_and_freq(self):
        b = self.make("rp2")
        c = self.client(b)
        c.enter_raw()
        self.assertEqual(py_eval(c, "import machine\nprint((machine.reset_cause(), machine.freq()))"), (1, 125000000))
        c.send(b"\x04")
        c.read_until(b"raw REPL; CTRL-B to exit\r\n>")
        self.assertEqual(py_eval(c, "import machine\nprint(machine.reset_cause() == machine.SOFT_RESET)"), True)


# ----------------------------------------------------------------------------------------------
# file system behaviour
# ----------------------------------------------------------------------------------------------
class FilesystemTests(BoardTestCase):
    def setUp(self):
        self.b = self.make("esp32")
        self.c = self.client(self.b)
        self.c.enter_raw()

    def run_py(self, code):
        return self.c.raw_exec(code)

    def test_write_read_rename_remove_roundtrip_and_unicode_names(self):
        out, err = self.run_py(
            "import os\nname = '/caf\\u00e9 (1)=a.txt'\nf = open(name, 'w')\nf.write('h\\u00e9llo\\r\\nworld')\nf.close()\n"
            "print(open(name).read().encode('utf-8'))\nos.rename(name, '/b.txt')\nprint(sorted(os.listdir('/')))\n"
            "os.remove('/b.txt')\nprint(os.listdir('/'))")
        self.assertEqual(err, b"")
        self.assertEqual(out, b"b'h\\xc3\\xa9llo\\r\\nworld'\r\n['b.txt', 'boot.py']\r\n['boot.py']\r\n")

    def test_utf8_output_and_split_input_bytes(self):
        c = self.c
        c.send(b"\x02")
        c.prompt()
        for byte in "print('h\u00e9llo \u65e5\u672c')\r".encode("utf-8"):
            c.send(bytes([byte]))
            time.sleep(0.001)
        out = c.prompt()
        self.assertIn("h\u00e9llo \u65e5\u672c\r\n".encode("utf-8"), out)
        c.enter_raw()
        out, err = self.run_py("import sys\nsys.stdout.buffer.write(b'raw\\n')\nprint('\u00e9')")
        self.assertEqual(out, b"raw\n\xc3\xa9\r\n")

    def test_one_megabyte_of_output_does_not_stall(self):
        t0 = time.monotonic()
        self.c.send(b"for i in range(1000):\n    print('x' * 1023)\n\x04")
        self.c.read_exact(2)
        data = self.c.read_until(b"\x04\x04>", timeout=60)
        self.assertEqual(len(data), 1000 * 1025 + 3)
        self.assertLess(time.monotonic() - t0, 30)

    def test_binary_and_crlf_roundtrip_is_exact(self):
        data = bytes(range(256)) + b"\r\n\r\n\x00\x1a"
        self.run_py("f = open('/bin.dat', 'wb')\nf.write(%r)\nf.close()" % data)
        self.assertEqual(self.b.read_file("/bin.dat"), data)
        self.b.write_file("/crlf.txt", b"a\r\nb\n")
        out, _ = self.run_py("print(repr(open('/crlf.txt').read()))")
        self.assertEqual(out, b"'a\\r\\nb\\n'\r\n", "text mode must not translate newlines")

    def test_errno_names_and_args_like_micropython(self):
        out, err = self.run_py("import os\ntry:\n    os.remove('/nope')\nexcept OSError as e:\n    print(e.args, str(e), e.errno)")
        self.assertEqual(out, b"(2,) [Errno 2] ENOENT 2\r\n")
        out, err = self.run_py("import os\nos.mkdir('/d')\ntry:\n    os.mkdir('/d')\nexcept OSError as e:\n    print(e.args[0])")
        self.assertEqual(out, b"17\r\n")
        out, err = self.run_py("import os, errno\nprint(errno.errorcode[17], errno.EEXIST, errno.ENOENT)")
        self.assertEqual(out, b"EEXIST 17 2\r\n")

    def test_rmdir_nonempty_remove_dir_and_rename_over_existing(self):
        self.b.write_file("/d/x", b"1")
        self.b.write_file("/a", b"A")
        self.b.write_file("/b", b"B")
        out, err = self.run_py(
            "import os, errno\nfor fn in (lambda: os.rmdir('/d'), lambda: os.remove('/d'), lambda: os.rmdir('/a'), lambda: os.listdir('/a')):\n"
            "    try:\n        fn()\n    except OSError as e:\n        print(errno.errorcode[e.args[0]])\n"
            "os.rename('/a', '/b')\nprint(open('/b').read())")
        self.assertEqual(err, b"")
        self.assertEqual(out, b"ENOTEMPTY\r\nEISDIR\r\nENOTDIR\r\nENOTDIR\r\nA\r\n")

    def test_stat_and_statvfs(self):
        self.b.write_file("/s.bin", b"12345")
        out, _ = self.run_py("import os\ns = os.stat('/s.bin')\nprint(len(s), s[0] & 0x8000 != 0, s[6])\nprint(os.stat('/')[0] & 0x4000 != 0)")
        self.assertEqual(out, b"10 True 5\r\nTrue\r\n")
        v = py_eval(self.c, "import os\nprint(os.statvfs('/'))")
        self.assertEqual(v[0], 4096)
        self.assertEqual(v[2], PROFILES["esp32"]["fs_blocks"])

    def test_makedirs_by_hand_and_nested_listing(self):
        out, err = self.run_py("import os\nos.mkdir('/lib')\nos.mkdir('/lib/sub')\nwith open('/lib/sub/m.py', 'w') as f:\n    f.write('X = 1')\n"
                               "import sys\nsys.path.append('/lib/sub')\nimport m\nprint(m.X)")
        self.assertEqual((out, err), (b"1\r\n", b""))

    def test_import_from_lib_and_package(self):
        self.b.write_file("/lib/helper.py", "def f():\n    return 'lib'\n")
        self.b.write_file("/pkg/__init__.py", "from pkg.inner import g\n")
        self.b.write_file("/pkg/inner.py", "def g():\n    return 'pkg'\n")
        out, err = self.run_py("import helper, pkg\nprint(helper.f(), pkg.g())\nfrom pkg import inner\nprint(inner.__name__)")
        self.assertEqual((out, err), (b"lib pkg\r\npkg.inner\r\n", b""))

    def test_traceback_for_imported_module_names_the_file(self):
        self.b.write_file("/bad.py", "x = 1\nraise ValueError('inside')\n")
        out, err = self.run_py("import bad")
        self.assertIn(b'File "<stdin>", line 1, in <module>', err)
        self.assertIn(b'File "bad.py", line 2, in <module>', err)
        self.assertIn(b"ValueError: inside", err)

    def test_compile_with_local_path_keeps_the_path_in_tracebacks(self):
        path = r"C:\Users\x\OneDrive - WSU (email)\ME 241 (Fall)\Lab 1\main.py" if os.name == "nt" else \
            "/Users/x/OneDrive-WSU(email.wsu.edu)/ME 241 (Fall)/Lab 1/main é.py"
        src = "import sys\nprint(__name__)\nraise RuntimeError('boom')\n"
        wrapper = "exec(compile(%r, %r, 'exec'), {'__name__': '__main__'})" % (src, path)
        out, err = self.run_py(wrapper)
        self.assertEqual(out, b"__main__\r\n")
        self.assertIn(('File "%s", line 3, in <module>' % path).encode("utf-8"), err)
        self.assertIn(b"RuntimeError: boom", err)

    def test_readonly_fs_fault_raises_erofs(self):
        b = self.make("esp32", faults=["readonly_fs"])
        c = self.client(b)
        c.enter_raw()
        out, err = c.raw_exec("open('/x', 'w')")
        self.assertIn(b"EROFS", err)
        out, err = c.raw_exec("import os\nos.mkdir('/d')")
        self.assertIn(b"EROFS", err)
        out, err = c.raw_exec("print(open('/boot.py').read()[:1])")
        self.assertEqual(out, b"#\r\n")

    def test_disk_full_fault_raises_enospc_and_keeps_old_data(self):
        b = self.make("esp32", faults=["disk_full:300"])
        c = self.client(b)
        c.enter_raw()
        out, err = c.raw_exec("with open('/big', 'wb') as f:\n    f.write(b'x' * 100)\n    f.write(b'y' * 500)")
        self.assertIn(b"ENOSPC", err)
        self.assertEqual(b.read_file("/big"), b"x" * 100)

    def test_errno_overrides_per_profile(self):
        self.assertEqual(py_eval(self.c, "import errno\nprint(errno.ENOTEMPTY)"), 39)
        b = self.make(derive_profile("esp32", errno_overrides={"ENOTEMPTY": 90}))
        c = self.client(b)
        c.enter_raw()
        self.assertEqual(py_eval(c, "import errno\nprint((errno.ENOTEMPTY, errno.errorcode[90]))"), (90, "ENOTEMPTY"))

    def test_files_survive_soft_reset_open_files_are_closed(self):
        self.run_py("f = open('/keep.txt', 'w')\nf.write('data')\nf.flush()")
        self.c.send(b"\x04")
        self.c.read_until(b"raw REPL; CTRL-B to exit\r\n>")
        out, _ = self.run_py("print(open('/keep.txt').read())")
        self.assertEqual(out, b"data\r\n")

    def test_json_and_struct_and_binascii_are_available(self):
        out, err = self.run_py("import json, struct, binascii\nprint(json.dumps({'a': [1, 2]}), struct.pack('<H', 5), binascii.hexlify(b'\\x01\\xff'))")
        self.assertEqual((out, err), (b"{\"a\": [1, 2]} b'\\x05\\x00' b'01ff'\r\n", b""))

    def test_cpython_only_modules_are_not_importable(self):
        out, err = self.run_py("import subprocess")
        self.assertIn(b"ImportError: no module named 'subprocess'", err)


# ----------------------------------------------------------------------------------------------
# faults
# ----------------------------------------------------------------------------------------------
class FaultTests(BoardTestCase):
    def test_fault_parsing(self):
        f = Faults(["slow", "close_mid_transfer:300", ("delay_boot", 2.5), "garbage_before_banner:ff00"])
        self.assertEqual(f.arg("slow"), 115200)
        self.assertEqual(f.arg("close_mid_transfer"), 300)
        self.assertEqual(f.arg("delay_boot"), 2.5)
        self.assertEqual(f.arg("garbage_before_banner"), b"\xff\x00")
        self.assertTrue(f.has("slow") and not f.has("unplug"))
        self.assertEqual(Faults(f).names(), f.names())
        self.assertEqual(Faults({"disk_full": 10}).arg("disk_full"), 10)

    def test_close_mid_transfer_raw_paste_is_one_shot(self):
        b = self.make("esp32", faults=["close_mid_transfer:300"])
        c = self.client(b)
        c.enter_raw()
        c.send(b"\x05A\x01")
        c.read_exact(5)
        c.send(b"#" * 128)
        c.send(b"#" * 128)
        c.send(b"#" * 128)
        self.assertTrue(c.wait_eof())
        self.assertIsNotNone(b.events.wait_for("disconnect"))
        ev = b.events.of("fault", name="close_mid_transfer")
        self.assertEqual(len(ev), 1)
        self.assertGreaterEqual(ev[0]["bytes"], 300)
        # the board is still alive, still in the middle of the paste: the next client can abort it
        self.assertTrue(b.wait_for_clients(0))
        c2 = self.client(b)
        c2.send(b"\x03")
        c2.send(b"\r\x03\r\x01")
        c2.read_until(b"raw REPL; CTRL-B to exit\r\n>")
        out, err, _ = c2.paste_exec(b"print('recovered')")
        self.assertEqual(out, b"recovered\r\n")
        # one-shot: a second transfer is not cut again
        c2.paste_exec(b"#" * 1000 + b"\nprint(1)")
        b.rearm("close_mid_transfer")
        self.assertEqual(b.faults.fired("close_mid_transfer"), 0)

    def test_garbage_before_banner(self):
        b = self.make("esp32", faults=["garbage_before_banner"])
        c = self.client(b)
        g = c.read_for(0.2)
        self.assertIn(b"\xff\xfe", g)
        self.assertNotIn(b">>>", g)
        c.send(b"\r")
        self.assertEqual(c.prompt(), b"\r\n>>> ")
        c.send(b"\x02")
        out = c.prompt()
        self.assertTrue(out.startswith(b"\r\n\xff\xfe"), out[:20])
        self.assertIn(b"MicroPython v1.29.0", out)
        c.send(b"\x01")
        out = c.read_until(b"raw REPL; CTRL-B to exit\r\n>")
        self.assertIn(b"\xff\xfe", out)

    def test_garbage_custom_bytes(self):
        b = self.make("esp32", faults=["garbage_before_banner:deadbeef"])
        c = self.client(b)
        self.assertEqual(c.read_for(0.2), b"\xde\xad\xbe\xef")

    def test_delay_boot_delays_the_banner_after_connect_and_after_a_soft_reset(self):
        b = self.make("esp32", faults=["delay_boot:0.5"])
        self.assertEqual(b.power_on, "connect")
        c = self.client(b)
        t0 = time.monotonic()
        out = c.prompt()                                     # boot.py "takes" 0.5 s before the banner
        self.assertGreaterEqual(time.monotonic() - t0, 0.45)
        self.assertIn(b"MicroPython v1.29.0", out)
        t0 = time.monotonic()
        c.send(b"\x04")
        self.assertEqual(c.read_until(b"MPY: soft reboot\r\n"), b"\r\nMPY: soft reboot\r\n")
        self.assertLess(time.monotonic() - t0, 0.3, "the soft reboot message comes before boot.py runs")
        c.prompt()
        self.assertGreaterEqual(time.monotonic() - t0, 0.45)

    def test_delay_boot_default_powers_up_on_first_connect_and_is_interruptible(self):
        b = self.make("esp32", faults=["delay_boot:3"])
        self.assertEqual(b.power_on, "connect")
        c = self.client(b)
        self.assertEqual(c.read_for(0.3), b"", "nothing is said while boot.py runs")
        c.send(b"\r\n")                                      # buffered like on a UART
        t0 = time.monotonic()
        c.send(b"\x03")
        out = c.prompt()
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertIn(b"KeyboardInterrupt", out)
        self.assertIn(b'File "boot.py"', out)

    def test_delay_boot_1_5_seconds_default(self):
        self.assertEqual(Faults(["delay_boot"]).arg("delay_boot"), 1.5)

    def test_main_forever_prints_heartbeat_and_blocks_the_repl_until_ctrl_c(self):
        b = self.make("esp32", faults=["main_forever"])
        self.assertTrue(b.exists("/main.py"), "the fault creates a real main.py")
        c = self.client(b)
        data = c.read_for(0.4)
        self.assertIn(b"heartbeat 0\r\n", data)
        self.assertIn(b"heartbeat 3\r\n", data)
        self.assertNotIn(b">>> ", data)
        self.assertTrue(b.program_running)
        c.send(b"\r\n")
        self.assertNotIn(b">>> ", c.read_for(0.2), "no friendly REPL while main.py loops")
        c.send(b"\x03")
        out = c.prompt()
        self.assertIn(b"KeyboardInterrupt: \r\n", out)
        self.assertIn(b"MicroPython v1.29.0", out)
        self.assertFalse(b.program_running)

    def test_hard_reset_restarts_main_forever_from_zero(self):
        b = self.make("esp32", faults=["main_forever"])
        c = self.client(b)
        self.assertIn(b"heartbeat 0\r\n", c.read_for(0.3))
        b.hard_reset()
        data = c.read_until(b"heartbeat 0\r\n", timeout=5)
        self.assertIn(b"POWERON_RESET", data)
        self.assertEqual(b.events.count("hard_reset"), 1)
        self.assertEqual(b.events.count("program_start", kind="main.py"), 2)

    def test_main_forever_survives_a_reconnect(self):
        b = self.make("esp32", faults=["main_forever"])
        c = self.client(b)
        first = c.read_for(0.3)
        c.close()
        self.assertTrue(b.wait_for_clients(0))
        time.sleep(0.2)
        c2 = self.client(b)
        second = c2.read_for(0.3)
        n1 = max(int(x) for x in __import__("re").findall(rb"heartbeat (\d+)", first))
        n2 = min(int(x) for x in __import__("re").findall(rb"heartbeat (\d+)", second))
        self.assertGreater(n2, n1 + 2, "the program kept running while nobody was connected")
        self.assertEqual(b.events.count("soft_reset"), 0)
        self.assertEqual(b.events.count("program_start", kind="main.py"), 1)

    def test_ignore_ctrl_c_swallows_interrupts(self):
        b = self.make("esp32", faults=["ignore_ctrl_c"])
        c = self.client(b)
        c.enter_raw()
        c.send(b"import time\nprint('loop')\nwhile True:\n    time.sleep(0.01)\n\x04")
        c.read_exact(2)
        c.read_until(b"loop\r\n")
        c.send(b"\x03")
        c.send(b"\x03")
        time.sleep(0.2)
        self.assertEqual(c.read_for(0.1), b"")
        self.assertTrue(b.program_running)
        ev = b.events.of("interrupt", state="running")
        self.assertEqual([e["swallowed"] for e in ev], [True, True])
        self.assertEqual([e["delivered"] for e in ev], [False, False])

    def test_program_that_catches_keyboardinterrupt_survives_each_ctrl_c_exactly_once(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.send(b"import time\nprint('loop')\nwhile True:\n    try:\n        time.sleep(0.01)\n"
               b"    except KeyboardInterrupt:\n        print('ignored ^C')\n\x04")
        c.read_exact(2)
        c.read_until(b"loop\r\n")
        for _ in range(3):
            c.send(b"\x03")
            c.read_until(b"ignored ^C\r\n")
        self.assertEqual(c.read_for(0.2), b"", "one Ctrl-C raises one KeyboardInterrupt, not two")
        self.assertTrue(b.program_running)

    def test_faults_can_be_added_and_removed_on_a_running_board(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.send(b"import time\nprint('loop')\nwhile True:\n    time.sleep(0.01)\n\x04")
        c.read_exact(2)
        c.read_until(b"loop\r\n")
        b.add_fault("ignore_ctrl_c")
        c.send(b"\x03")
        time.sleep(0.2)
        self.assertTrue(b.program_running)
        b.remove_fault("ignore_ctrl_c")
        c.send(b"\x03")
        self.assertIn(b"KeyboardInterrupt", c.read_until(b"\x04>"))

    def test_silent_fault_hangs_the_link(self):
        b = self.make("esp32")
        c = self.client(b)
        c.wake()
        b.add_fault("silent")
        c.send(b"print(1)\r")
        self.assertEqual(c.read_for(0.3), b"")
        self.assertFalse(c.eof, "the socket stays open: the board is just not answering")
        b.remove_fault("silent")
        c.send(b"print(2)\r")
        self.assertIn(b"2\r\n", c.prompt())

    def test_ignore_ctrl_c_board_stops_cleanly_anyway(self):
        b = self.make("esp32", faults=["ignore_ctrl_c"])
        c = self.client(b)
        c.enter_raw()
        c.send(b"while True:\n    pass\n\x04")
        c.read_exact(2)
        b.wait_running()
        # stop() runs in cleanup: the busy loop must still be killed, no leaked worker

    def test_unplug_on_exec(self):
        b = self.make("esp32", faults=["unplug"])
        c = self.client(b)
        c.enter_raw()
        c.send(b"print(1)\x04")
        self.assertTrue(c.wait_eof())
        self.assertIsNotNone(b.events.wait_for("fault", name="unplug", trigger="exec"))
        d = b.events.wait_for("disconnect")
        self.assertEqual(d["reason"], "unplug")
        # one-shot, and the board keeps working for the next client
        self.assertTrue(b.wait_for_clients(0))
        c2 = self.client(b)
        c2.enter_raw()
        out, _ = c2.raw_exec("print(2)")
        self.assertEqual(out, b"2\r\n")

    def test_unplug_on_connect_after_and_bytes(self):
        b = self.make("esp32", faults=["unplug:connect"])
        c = self.client(b)
        self.assertTrue(c.wait_eof())
        b2 = self.make("esp32", faults=["unplug:after=0.2"])
        c2 = self.client(b2)
        self.assertFalse(c2.wait_eof(0.05))
        self.assertTrue(c2.wait_eof(3))
        b3 = self.make("esp32", faults=["unplug:bytes=10"])
        c3 = self.client(b3)
        c3.send(b"12345")
        self.assertFalse(c3.wait_eof(0.1))
        c3.send(b"67890")
        self.assertTrue(c3.wait_eof(3))

    def test_unplug_method_resets_connection(self):
        b = self.make("esp32")
        c = self.client(b)
        c.wake()
        b.unplug()
        self.assertTrue(c.wait_eof())
        self.assertEqual(b.events.of("disconnect")[0]["reason"], "unplug")

    def test_slow_throttles_both_directions(self):
        b = self.make("esp32", faults=["slow:9600"])
        self.assertEqual(b.baud, 9600)
        c = self.client(b)
        c.wake()
        t0 = time.monotonic()
        c.send(b"print('x' * 120)\r")
        out = c.prompt(timeout=10)
        dt = time.monotonic() - t0
        # ~16 chars in + ~150 chars out at 960 B/s is well over 0.15 s
        self.assertGreater(dt, 0.15, dt)
        self.assertIn(b"x" * 120, out)

    def test_slow_default_is_115200_and_baud_argument(self):
        self.assertEqual(self.make("esp32", faults=["slow"]).baud, 115200)
        self.assertEqual(self.make("esp32", baud=57600).baud, 57600)
        self.assertEqual(self.make("esp32").baud, 0)

    def test_reset_on_connect_is_detected_in_the_event_log_and_output(self):
        b = self.make("esp32", faults=["reset_on_connect"], files={"/boot.py": "print('booted')\n"})
        c = self.client(b)
        out = c.prompt()
        self.assertIn(b"MPY: soft reboot\r\nbooted\r\n", out)
        self.assertEqual(b.events.count("soft_reset", reason="reset_on_connect"), 1)
        c.close()
        b.wait_for_clients(0)
        c2 = self.client(b)
        c2.prompt()
        self.assertEqual(b.events.count("soft_reset", reason="reset_on_connect"), 2)

    def test_plain_connect_never_resets(self):
        b = self.make("esp32")
        for _ in range(20):
            c = Client(b.port)
            c.send(b"\r\n")
            c.prompt()
            c.close()
            self.assertTrue(b.wait_for_clients(0))
        self.assertEqual(b.events.count("connect"), 20)
        self.assertEqual(b.events.count("disconnect"), 20)
        for ev in ("soft_reset", "hard_reset", "raw_enter", "exec"):
            self.assertEqual(b.events.count(ev), 0, ev)
        self.assertEqual(b.events.count("interrupt"), 0)

    def test_hard_reset_native_usb_drops_the_port_uart_bridge_does_not(self):
        b = self.make("esp32s3-usb")
        c = self.client(b)
        c.wake()
        b.hard_reset()
        self.assertTrue(c.wait_eof())
        self.assertEqual(b.events.of("disconnect")[0]["reason"], "usb re-enumeration after hard reset")
        b2 = self.make("esp32")
        c2 = self.client(b2)
        c2.wake()
        b2.hard_reset()
        self.assertIn(b"POWERON_RESET", c2.read_until(b">>> "))
        self.assertFalse(c2.eof)

    def test_machine_soft_reset_and_reset_while_program_runs_via_api(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.send(b"import time\nwhile True:\n    time.sleep(0.01)\n\x04")
        c.read_exact(2)
        b.wait_running()
        self.assertIsNotNone(b.events.wait_for("program_start", kind="raw"))
        b.soft_reset("test")
        out = c.read_until(b"raw REPL; CTRL-B to exit\r\n>")
        self.assertIn(b"MPY: soft reboot", out)
        self.assertEqual(b.events.count("soft_reset", reason="test"), 1)
        self.assertEqual(b.events.of("program_end", kind="raw")[-1]["result"], "reset")


# ----------------------------------------------------------------------------------------------
# connections: exclusivity, events, lifecycle
# ----------------------------------------------------------------------------------------------
class ConnectionTests(BoardTestCase):
    def test_exclusive_refuses_a_second_client_until_the_first_leaves(self):
        b = self.make("esp32")
        c1 = self.client(b)
        c1.wake()
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", b.port), timeout=2)
        c1.close()
        self.assertTrue(b.wait_for_clients(0))
        for _ in range(100):
            try:
                c2 = Client(b.port)
                break
            except OSError:
                time.sleep(0.02)
        else:
            self.fail("listener did not come back")
        self.addCleanup(c2.close)
        c2.wake()
        self.assertEqual(b.events.count("connect"), 2)

    def test_busy_drop_mode_accepts_and_drops(self):
        b = self.make("esp32", busy="drop")
        c1 = self.client(b)
        c1.wake()
        c2 = Client(b.port)
        self.addCleanup(c2.close)
        self.assertTrue(c2.wait_eof(3))
        self.assertIsNotNone(b.events.wait_for("busy_reject"))
        self.assertEqual(b.connected, 1)
        c1.send(b"1\r")
        self.assertIn(b"1\r\n", c1.prompt())

    def test_non_exclusive_allows_several_clients_and_broadcasts(self):
        b = self.make("esp32", exclusive=False)
        c1, c2 = self.client(b), self.client(b)
        self.assertTrue(b.events.wait_for("connect", client=2))
        c1.send(b"print('both')\r")
        self.assertIn(b"both\r\n", c1.prompt())
        self.assertIn(b"both\r\n", c2.prompt())

    def test_board_state_persists_across_clients(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.raw_exec("marker = 7")
        c.close()
        self.assertTrue(b.wait_for_clients(0))
        for _ in range(100):
            try:
                c2 = Client(b.port)
                break
            except OSError:
                time.sleep(0.02)
        self.addCleanup(c2.close)
        self.assertEqual(b.mode, "raw", "the REPL mode survives a disconnect")
        c2.send(b"\r\x03\r\x01")
        c2.read_until(b"raw REPL; CTRL-B to exit\r\n>")
        out, _ = c2.raw_exec("print(marker)")
        self.assertEqual(out, b"7\r\n")
        self.assertEqual(b.events.count("soft_reset"), 0)

    def test_program_survives_disconnect_and_is_interrupted_by_a_later_client(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.send(b"import time\nwhile True:\n    time.sleep(0.01)\n\x04")
        c.read_exact(2)
        b.wait_running()
        c.close()
        self.assertTrue(b.wait_for_clients(0))
        time.sleep(0.15)
        self.assertTrue(b.program_running, "a board does not stop its program when the host goes away")
        for _ in range(100):
            try:
                c2 = Client(b.port)
                break
            except OSError:
                time.sleep(0.02)
        self.addCleanup(c2.close)
        c2.send(b"\x03\x03")
        self.assertIn(b"KeyboardInterrupt", c2.read_until(b"\x04>"))

    def test_events_are_ordered_timestamped_and_thread_safe(self):
        b = self.make("esp32")
        errors = []

        def spam(n):
            try:
                for i in range(200):
                    b.events.add("spam", n=n, i=i)
            except Exception as e:      # pragma: no cover
                errors.append(e)

        ths = [threading.Thread(target=spam, args=(n,)) for n in range(6)]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        self.assertEqual(errors, [])
        evs = list(b.events)
        self.assertEqual([e["seq"] for e in evs], list(range(len(evs))))
        ts = [e["t"] for e in evs]
        self.assertEqual(ts, sorted(ts))
        self.assertEqual(b.events.count("spam"), 1200)
        for n in range(6):
            self.assertEqual([e["i"] for e in b.events.of("spam", n=n)], list(range(200)))

    def test_exec_event_carries_digest_and_mode(self):
        b = self.make("esp32")
        c = self.client(b)
        c.enter_raw()
        c.raw_exec("print(1)")
        c.paste_exec(b"print(2)")
        evs = b.events.of("exec")
        self.assertEqual([e["mode"] for e in evs], ["raw", "paste"])
        self.assertEqual([e["paste"] for e in evs], [False, True])
        self.assertEqual(evs[0]["head"], "print(1)")
        self.assertEqual(len(evs[0]["digest"]), 10)
        self.assertNotEqual(evs[0]["digest"], evs[1]["digest"])
        self.assertEqual(b.events.count("raw_enter"), 1)
        self.assertEqual(b.events.count("program_start", kind="raw"), 2)
        self.assertEqual(b.events.count("program_end", kind="raw", result="ok"), 2)

    def test_interrupt_event_per_ctrl_c_even_when_idle(self):
        b = self.make("esp32")
        c = self.client(b)
        c.send(b"\x03\x03\x03")
        time.sleep(0.1)
        self.assertEqual(b.events.count("interrupt"), 3)
        self.assertEqual([e["state"] for e in b.events.of("interrupt")], ["idle"] * 3)

    def test_wait_for_and_mark(self):
        b = self.make("esp32")
        m = b.events.mark()
        threading.Timer(0.1, lambda: b.events.add("later", x=1)).start()
        e = b.events.wait_for("later", timeout=3, since=m, x=1)
        self.assertIsNotNone(e)
        self.assertIsNone(b.events.wait_for("never", timeout=0.1))

    def test_event_log_file_is_jsonl(self):
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd)
        self.addCleanup(os.remove, path)
        b = self.make("esp32", log_path=path)
        c = self.client(b)
        c.wake()
        c.close()
        b.wait_for_clients(0)
        b.stop()
        with open(path, encoding="utf-8") as f:
            names = [json.loads(line)["ev"] for line in f if line.strip()]
        self.assertIn("connect", names)
        self.assertIn("disconnect", names)

    def test_stop_is_deterministic_with_client_and_busy_program_and_idempotent(self):
        b = FakeBoard("esp32").start()
        c = Client(b.port)
        c.enter_raw()
        c.send(b"while True:\n    pass\n\x04")
        c.read_exact(2)
        b.wait_running()
        t0 = time.monotonic()
        b.stop()
        b.stop()
        self.assertLess(time.monotonic() - t0, 2.0)
        self.assertEqual(b.leaked_threads(), [])
        self.assertTrue(c.wait_eof(2))
        c.close()
        self.assertFalse(os.path.exists(b.root))
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", b.port), timeout=1)

    def test_url_port_zero_and_two_boards_at_once(self):
        a, b = self.make("esp32"), self.make("rp2")
        self.assertNotEqual(a.port, b.port)
        self.assertTrue(a.url.startswith("socket://127.0.0.1:"))
        self.assertEqual(a.url, "socket://127.0.0.1:%d" % a.port)
        with self.assertRaises(RuntimeError):
            FakeBoard("esp32").url

    def test_context_manager_and_temp_root_cleanup(self):
        with FakeBoard("esp32") as b:
            root = b.root
            self.assertTrue(os.path.isfile(os.path.join(root, "boot.py")))
        self.assertFalse(os.path.exists(root))
        self.assertEqual(b.leaked_threads(), [])

    def test_user_root_is_not_touched_unless_seed(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "sub"))
            with open(os.path.join(d, "mine.txt"), "w") as f:
                f.write("x")
            with FakeBoard("esp32", root=d) as b:
                self.assertEqual(sorted(os.listdir(d)), ["mine.txt", "sub"])
            self.assertTrue(os.path.isdir(d), "a user supplied root is never deleted")
            with FakeBoard("esp32", root=d, seed=True) as b:
                self.assertEqual(sorted(os.listdir(d)), ["boot.py", "mine.txt", "sub"])

    def test_root_with_spaces_parentheses_at_and_unicode(self):
        with tempfile.TemporaryDirectory() as d:
            root = os.path.join(d, "OneDrive-Washington State University(email.wsu.edu)", "ME 241 (Fall)", "Lab 1 \u00e9@")
            with FakeBoard("esp32", root=root, files={"/dir/f\u00fc.txt": "hello"}) as b:
                c = Client(b.port)
                try:
                    c.enter_raw()
                    out, _ = c.raw_exec("print(open('/dir/f\\u00fc.txt').read())")
                    self.assertEqual(out, b"hello\r\n")
                finally:
                    c.close()

    def test_python_api_helpers(self):
        b = self.make("esp32")
        b.write_file("/x/y.txt", "abc")
        self.assertEqual(b.read_file("/x/y.txt"), b"abc")
        self.assertTrue(b.exists("/x/y.txt"))
        self.assertTrue(os.path.isfile(b.host_path("/x/y.txt")))
        st = b.device.state()
        self.assertEqual(st["mode"], "friendly")
        self.assertFalse(st["running"])

    def test_tx_rx_counters(self):
        b = self.make("esp32")
        c = self.client(b)
        c.wake()
        self.assertGreater(b.tx_bytes, 0)
        self.assertEqual(b.rx_bytes, 1)


# ----------------------------------------------------------------------------------------------
# independent clients: pyserial and real mpremote
# ----------------------------------------------------------------------------------------------
class PySerialClientTests(BoardTestCase):
    def test_pyserial_socket_url_reads_and_writes(self):
        import serial
        b = self.make("esp32")
        ser = serial.serial_for_url(b.url, timeout=2)
        self.addCleanup(ser.close)
        ser.write(b"\r")
        got = b""
        end = time.monotonic() + 3
        while not got.endswith(b">>> ") and time.monotonic() < end:
            got += ser.read(ser.in_waiting or 1)
        self.assertEqual(got, b"\r\n>>> ")
        ser.write(b"\x01")
        got = b""
        while not got.endswith(b">") and time.monotonic() < end:
            got += ser.read(ser.in_waiting or 1)
        self.assertTrue(got.endswith(b"raw REPL; CTRL-B to exit\r\n>"))
        self.assertEqual(b.events.count("connect"), 1)

    def test_pyserial_exclusive_second_open_fails(self):
        import serial
        b = self.make("esp32")
        ser = serial.serial_for_url(b.url, timeout=1)
        self.addCleanup(ser.close)
        self.assertIsNotNone(b.events.wait_for("connect"))
        with self.assertRaises(serial.SerialException):
            serial.serial_for_url(b.url, timeout=1)

    def test_pyserial_dtr_rts_are_harmless_on_socket_urls(self):
        import serial
        b = self.make("esp32")
        ser = serial.serial_for_url(b.url, timeout=1, do_not_open=True)
        ser.dtr = False
        ser.rts = False
        ser.open()
        self.addCleanup(ser.close)
        ser.dtr = True
        ser.rts = True
        ser.write(b"\r")
        self.assertEqual(ser.read_until(b">>> "), b"\r\n>>> ")
        ser.close()
        self.assertTrue(b.wait_for_clients(0))
        self.assertEqual(b.events.count("soft_reset") + b.events.count("hard_reset"), 0)


class MpremoteClientTests(BoardTestCase):
    """The vendored mpremote 1.29.0 is an independent client: if it works, the protocol is right."""

    def mp(self, board, *args, timeout=60):
        code = "import sys; sys.path.insert(0, %r); from mpremote.main import main; sys.exit(main())" % VENDOR
        env = dict(os.environ, MPY_SAFE_MODE="1", PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
        for _ in range(50):                       # the exclusive listener comes back right after a disconnect
            r = subprocess.run([sys.executable, "-B", "-X", "utf8", "-I", "-c", code, "connect", board.url] + list(args),
                               capture_output=True, timeout=timeout, env=env, cwd=tempfile.gettempdir())
            if r.returncode != 0 and b"failed to access" in (r.stdout + r.stderr):
                time.sleep(0.05)
                continue
            break
        return r.returncode, r.stdout, r.stderr

    def test_exec(self):
        b = self.make("esp32")
        rc, out, err = self.mp(b, "exec", "print(6 * 7)")
        self.assertEqual((rc, out), (0, b"42\r\n"), err)
        self.assertEqual(b.events.count("connect"), 1)
        self.assertEqual(b.events.count("raw_exit"), 1)

    def test_fs_ls_cp_both_ways_cat_and_run(self):
        b = self.make("esp32")
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "a b (1).txt")
            payload = (b"hello\r\nworld\x00\xff\x03\x04" * 70) + b"\n" + bytes(range(256))
            with open(src, "wb") as f:
                f.write(payload)
            back = os.path.join(d, "back.bin")
            b.write_file("/hello.txt", "line1\nline2\n")
            script = os.path.join(d, "r.py")
            with open(script, "w") as f:
                f.write("import sys\nprint('run', __name__, sys.implementation._build)\n")
            # one mpremote session, five commands (a process start + connect costs ~0.5 s each)
            rc, out, err = self.mp(b, "fs", "cp", src, ":up.bin", "+", "fs", "ls", ":", "+",
                                   "fs", "cp", ":up.bin", back, "+", "fs", "cat", ":hello.txt", "+", "run", script)
            self.assertEqual(rc, 0, err)
            self.assertEqual(b.read_file("/up.bin"), payload)
            self.assertIn(b"up.bin", out)
            self.assertIn(("%d" % len(payload)).encode(), out)
            with open(back, "rb") as f:
                self.assertEqual(f.read(), payload)
            self.assertIn(b"line1\r\nline2\r\n", out)                  # device output and mpremote's own echo lines
            self.assertIn(b"run __main__ ESP32_GENERIC\r\n", out)         # may interleave, but each stays whole

    def test_exception_gives_rc_1_with_traceback(self):
        b = self.make("esp32")
        rc, out, err = self.mp(b, "exec", "raise ValueError('boom')")
        self.assertEqual(rc, 1)
        self.assertIn(b"Traceback (most recent call last):", out + err)
        self.assertIn(b"ValueError: boom", out + err)

    def test_fs_mkdir_rm_and_sha_skip(self):
        b = self.make("esp32")
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "x.py")
            with open(f, "wb") as fh:
                fh.write(b"print('x')\n")
            # one session, five commands; the second cp finds the same hash on the device ("Up to date").
            # Separate connections (reconnect after a disconnect) are covered by the other mpremote tests.
            rc, out, err = self.mp(b, "fs", "mkdir", ":lib", "+", "fs", "cp", f, ":lib/x.py", "+",
                                   "fs", "cp", f, ":lib/x.py", "+", "fs", "rm", ":lib/x.py", "+", "fs", "rmdir", ":lib")
            self.assertEqual(rc, 0, err)
            self.assertFalse(b.exists("/lib"))

    def test_other_profiles_work_with_mpremote(self):
        names = ("rp2", "esp8266", "stm32", "custom-frozen", "unix-like")
        boards = {name: self.make(name) for name in names}
        results = {}

        def one(name):                              # independent boards: no reason to pay five process starts in a row
            results[name] = self.mp(boards[name], "exec", "import sys; print(sys.platform)")

        threads = [threading.Thread(target=one, args=(n,), name="mp-" + n, daemon=True) for n in names]
        for t in threads:
            t.start()
        for t in threads:
            t.join(90)
        for name in names:
            with self.subTest(profile=name):
                rc, out, err = results.get(name, (None, b"", b"mpremote did not finish"))
                self.assertEqual((rc, out.strip()), (0, PROFILES[name]["platform"].encode()), err)

    def test_esp8266_without_sha256_still_copies(self):
        b = self.make("esp8266")
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "x.txt")
            with open(f, "wb") as fh:
                fh.write(b"abc" * 100)
            self.assertEqual(self.mp(b, "fs", "cp", f, ":x.txt")[0], 0)
            self.assertEqual(self.mp(b, "fs", "cp", f, ":x.txt")[0], 0, "the hash fallback downloads and compares")
            self.assertEqual(b.read_file("/x.txt"), b"abc" * 100)

    def test_mpremote_does_not_reset_more_than_its_documented_soft_reset(self):
        b = self.make("esp32")
        self.mp(b, "exec", "pass")
        self.assertEqual(b.events.count("soft_reset"), 1)       # mpremote 1.29 soft-resets on every command
        self.assertEqual(b.events.count("hard_reset"), 0)


class _GatedSock(object):
    """Delegates to a real socket, but sendall() returns only after `gate` is set (the bytes are already out)."""

    def __init__(self, real, gate):
        self._real = real
        self._gate = gate

    def sendall(self, data):
        self._real.sendall(data)
        self._gate.wait(5.0)

    def __getattr__(self, name):
        return getattr(self._real, name)


class CaptureOrderTests(BoardTestCase):
    def test_tx_data_has_every_byte_a_client_already_holds(self):
        """_tx() must record the bytes before (not after) sendall(): a client can react to them at once."""
        gate = threading.Event()
        b = self.make("esp32", capture=True)
        c = self.client(b)
        self.addCleanup(gate.set)                       # cleanups run last-in first-out: open the gate BEFORE b.stop()
        self.assertIsNotNone(b.events.wait_for("connect"))
        c.wake()
        with b._lock:
            (cl,) = list(b._clients)
        cl.sock = _GatedSock(cl.sock, gate)             # sendall() delivers, then hangs: _tx() has not returned
        c.send(b"q")                                    # the friendly REPL echoes it
        self.assertEqual(c.read_exact(1), b"q")
        self.assertTrue(b.tx_data().endswith(b"q"), "bytes the client already holds are missing from the capture")


class HostPathMappingTests(TimedCase):
    """_FakeOS._host(): device names that a Windows host would read as separators / drives stay inside the root."""

    class _NtOs(object):
        path = ntpath

        def __getattr__(self, name):
            return getattr(os, name)

    ROOT_DIR = "D:\\scratch\\fakeboard-abc123"

    def _fos(self, mount=None):
        fos = object.__new__(_FakeOS)
        fos._root = self.ROOT_DIR
        fos._dev = mock.Mock(oserror=lambda name: OSError(name))
        fos._mount = mount
        fos._cwd = "/"
        return fos

    def test_windows_host_refuses_what_could_leave_the_root(self):
        bad = ["/..\\..\\Windows\\win.ini", "/C:/Windows/win.ini", "/lib/C:", "/a\\b", "/x.txt:stream", "/CON", "/nul.txt",
               "/lib/COM1", "/lpt9.log", "/trailing.", "/trailing ", "/a\0b"]
        with mock.patch("tools.fakeboard.os", self._NtOs()):
            for name in bad:
                with self.subTest(name=name):
                    with self.assertRaises(OSError) as cm:
                        self._fos()._host(name)
                    self.assertEqual(str(cm.exception), "ENOENT")

    def test_windows_host_keeps_ordinary_names(self):
        with mock.patch("tools.fakeboard.os", self._NtOs()):
            for name, tail in (("/lib/utils.py", "lib\\utils.py"), ("/main.py", "main.py"), ("/a b (1).txt", "a b (1).txt"),
                               ("/console.py", "console.py"), ("/", "")):
                with self.subTest(name=name):
                    host, virt = self._fos()._host(name)
                    self.assertFalse(virt)
                    self.assertEqual(host, (self.ROOT_DIR + "\\" + tail) if tail else self.ROOT_DIR)
            self.assertEqual(self._fos("/flash")._host("/flash/boot.py")[0], self.ROOT_DIR + "\\boot.py")

    def test_nul_is_refused_on_every_host(self):
        with self.assertRaises(OSError):
            self._fos()._host("/a\0b")

    @unittest.skipIf(os.name == "nt", "a POSIX host really can hold these names")
    def test_posix_host_still_allows_backslash_and_colon_names(self):
        host, _ = self._fos()._host("/a\\b:c")
        self.assertEqual(os.path.basename(host), "a\\b:c")


class ModuleSpecTests(BoardTestCase):
    def test_device_modules_have_no_half_set_import_spec_and_tracebacks_do_not_warn(self):
        prof = derive_profile("custom-frozen", c_modules={"_acme": "ABI = 2\n"})
        b = self.make(prof)
        c = self.client(b)
        c.enter_raw()
        out, err = c.raw_exec("import _acme\nprint(hasattr(_acme, '__spec__'), hasattr(_acme, '__loader__'))")
        self.assertEqual((out.strip(), err), (b"False False", b""))
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            out, err = c.raw_exec("import acme")                    # c_modules ABI check raises inside the frozen package
        self.assertIn(b"ImportError: acme ABI 2", err)
        self.assertEqual([str(w.message) for w in caught if issubclass(w.category, DeprecationWarning)], [])


class CliTests(TimedCase):
    def test_cli_print_url_and_stdin_eof_exit(self):
        env = dict(os.environ, MPY_SAFE_MODE="1", PYTHONDONTWRITEBYTECODE="1")
        p = subprocess.Popen([sys.executable, "-B", os.path.join(ROOT, "tools", "fakeboard.py"), "--profile", "esp32",
                              "--port", "0", "--print-url", "--exit-on-stdin-eof", "--max-seconds", "60"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            line = p.stdout.readline().decode().strip()
            self.assertRegex(line, r"^socket://127\.0\.0\.1:\d+$")
            port = int(line.rsplit(":", 1)[1])
            c = Client(port)
            try:
                c.wake()
                c.send(b"print(2+2)\r")
                self.assertIn(b"4\r\n", c.prompt())
            finally:
                c.close()
            p.stdin.close()
            self.assertEqual(p.wait(timeout=15), 0)
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()
            p.stdout.close()
            p.stderr.close()

    def test_cli_list_profiles_and_faults(self):
        env = dict(os.environ, MPY_SAFE_MODE="1")
        r = subprocess.run([sys.executable, "-B", os.path.join(ROOT, "tools", "fakeboard.py"), "--list-profiles"],
                           capture_output=True, timeout=30, env=env)
        self.assertEqual(r.returncode, 0)
        for name in ("esp32", "rp2", "stm32", "esp8266", "custom-frozen", "unix-like", "esp32s3-usb"):
            self.assertIn(name.encode(), r.stdout)
        p = subprocess.Popen([sys.executable, "-B", os.path.join(ROOT, "tools", "fakeboard.py"), "--profile", "rp2",
                              "--fault", "garbage_before_banner", "--fault", "slow:57600", "--max-seconds", "30",
                              "--exit-on-stdin-eof"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            line = p.stdout.readline().decode().strip()
            self.assertTrue(line.startswith("LISTENING socket://127.0.0.1:"), line)
            c = Client(int(line.rsplit(":", 1)[1]))
            try:
                self.assertIn(b"\xff\xfe", c.read_for(0.3))
            finally:
                c.close()
            p.stdin.close()
            self.assertEqual(p.wait(timeout=15), 0)
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()
            p.stdout.close()
            p.stderr.close()


# ----------------------------------------------------------------------------------------------
# the real MicroPython VM behind the relay
# ----------------------------------------------------------------------------------------------
class RunTrackerTests(TimedCase):
    """tools/mpunix_relay._RunTracker: follows a raw-paste exec from the byte stream (no VM needed)."""

    def setUp(self):
        from tools.mpunix_relay import _RunTracker
        self.t = _RunTracker()

    def feed(self, data, raw=True, isig_off=True):
        return self.t.feed_in(data, raw, lambda: isig_off)

    def start_program(self):
        self.assertEqual(self.feed(b"\x05A\x01print(1)\x04"), (b"\x05A\x01print(1)\x04", False))
        self.assertTrue(self.t.running())

    def test_first_ctrl_c_of_a_running_raw_paste_program_becomes_one_sigint_and_is_not_forwarded(self):
        self.start_program()
        self.assertEqual(self.feed(b"\x03\x03"), (b"\x03", True))        # the first is the Stop, the second goes through
        self.assertEqual(self.feed(b"\x03"), (b"\x03", False))            # and it is one SIGINT per program

    def test_finished_program_returns_to_idle(self):
        self.start_program()
        self.t.feed_out(b"\x04")                                        # data accepted
        self.t.feed_out(b"x>y\x04")                                     # output, end of stdout: a '>' in the output is not the prompt
        self.assertTrue(self.t.running())
        self.t.feed_out(b"\x04>")                                       # end of stderr + prompt
        self.assertFalse(self.t.running())
        self.assertEqual(self.feed(b"\x03"), (b"\x03", False))

    def test_nothing_happens_when_the_pty_delivers_the_signal_itself(self):
        self.start_program()
        self.assertEqual(self.feed(b"\x03", isig_off=False), (b"\x03", False))

    def test_only_a_raw_repl_starts_a_paste(self):
        self.assertEqual(self.feed(b"\x05A\x01x\x04", raw=False)[1], False)
        self.assertFalse(self.t.running())

    def test_ctrl_c_in_the_paste_data_cancels_the_paste(self):
        self.assertEqual(self.feed(b"\x05A\x01print(1)\x03"), (b"\x05A\x01print(1)\x03", False))
        self.assertFalse(self.t.running())
        self.assertEqual(self.feed(b"\x04"), (b"\x04", False))

    def test_markers_split_across_chunks_and_reset_on_a_new_vm(self):
        for chunk in (b"\x05", b"A", b"\x01", b"print(1)", b"\x04"):
            self.feed(chunk)
        self.assertTrue(self.t.running())
        self.t.reset()
        self.assertFalse(self.t.running())
        self.assertEqual(self.feed(b"\x03"), (b"\x03", False))


@unittest.skipIf(VM_SKIP, VM_SKIP or "")
class UnixVmRelayTests(TimedCase):
    def setUp(self):
        self.vm = UnixVM().start()
        self.addCleanup(self._check_leaks)
        self.addCleanup(self.vm.stop)

    def _check_leaks(self):
        self.assertEqual([t.name for t in self.vm.leaked_threads()], [])

    def client(self):
        c = Client(self.vm.port)
        self.addCleanup(c.close)
        return c

    def test_friendly_repl_and_event_lite(self):
        c = self.client()
        out = c.prompt()
        self.assertIn(b"MicroPython v1.29.0", out)
        c.send(b"print(1+1)\r")
        self.assertEqual(c.prompt(), b"print(1+1)\r\n2\r\n>>> ")
        self.assertIsNotNone(self.vm.wait_for("connect"))
        c.close()
        self.assertIsNotNone(self.vm.wait_for("disconnect"))
        self.assertEqual(self.vm.count("connect"), 1)

    def test_raw_repl_framing_and_cooked_newlines(self):
        c = self.client()
        c.prompt()
        c.enter_raw()
        out, err = c.raw_exec("print('a')\nprint('b')")
        self.assertEqual((out, err), (b"a\r\nb\r\n", b""))
        out, err = c.raw_exec("1/0")
        self.assertIn(b"ZeroDivisionError: divide by zero", err)

    def test_raw_paste_works_on_the_real_vm(self):
        c = self.client()
        c.prompt()
        c.enter_raw()
        out, err, credits = c.paste_exec("print(sum(range(10)))")
        self.assertEqual((out, err), (b"45\r\n", b""))

    def test_ctrl_c_stops_a_running_program(self):
        c = self.client()
        c.prompt()
        c.enter_raw()
        c.send(b"import time\nwhile True:\n    time.sleep(0.01)\n\x04")
        c.read_exact(2)
        time.sleep(0.2)
        c.send(b"\x03")
        self.assertIn(b"KeyboardInterrupt", c.read_until(b"\x04>", timeout=5))
        out, _ = c.raw_exec("print('still here')")
        self.assertEqual(out, b"still here\r\n")

    def test_soft_reboot_is_emulated_and_state_is_lost(self):
        c = self.client()
        c.prompt()
        c.enter_raw()
        c.raw_exec("keep = 1")
        c.send(b"\x04")
        out = c.read_until(b"raw REPL; CTRL-B to exit\r\n>", timeout=8)
        self.assertTrue(out.startswith(b"OK\r\nMPY: soft reboot\r\n"), out)
        _, err = c.raw_exec("keep")
        self.assertIn(b"NameError", err)
        self.assertEqual(self.vm.count("soft_reboot"), 1)

    def test_stdin_keystrokes_reach_a_program_through_select_poll_s06(self):
        """S-06 on the real VM: sys.stdin.read(1) and select.poll() see host keystrokes during raw exec."""
        c = self.client()
        c.prompt()
        c.enter_raw()
        c.send(POLL_PROGRAM.encode() + b"\x04")
        c.read_exact(2)
        c.read_until(b"READY\r\n")
        time.sleep(0.1)
        c.send(b"k")
        time.sleep(0.05)
        c.send(b"j")
        self.assertEqual(c.read_until(b"\r\n"), b"got ['k', 'j'] idle True\r\n")

    def test_echo_program_parity_between_fake_and_real_vm(self):
        outs = []
        for kind in ("fake", "vm"):
            if kind == "fake":
                board = FakeBoard("esp32").start()
                self.addCleanup(board.stop)
                c = Client(board.port)
            else:
                c = self.client()
                c.prompt()
            self.addCleanup(c.close)
            c.enter_raw()
            c.send(ECHO_PROGRAM.encode() + b"\x04")
            c.read_exact(2)
            c.read_until(b"READY\r\n")
            c.send(b"a")
            c.read_until(b"\r\n")
            c.send(b"q")
            outs.append(c.read_until(b"\x04\x04>"))
        self.assertEqual(outs[0], outs[1])

    # ---- differential tests: the fake must answer like the real VM (what CPython can reproduce)
    PARITY_SNIPPETS = [
        "print(1)", "print('a', 'b', sep='-', end='!\\n')", "1/0", "undefined_name", "import nosuchmodule",
        "def f(x):\n    return x/0\ndef g():\n    return f(1)\ng()", "raise ValueError('boom')",
        "raise ValueError", "raise KeyError('k')", "raise OSError(2)",
        "import os\nos.stat('/definitely/not/here')", "import os\nos.listdir('/definitely/not/here')",
        "open('/definitely/not/here')", "x = [1,2,3]\nx[10]", "d = {}\nd['k']", "len(5)",
        "import sys\nsys.nothing", "[].nothing", "1 +", "def f(:\n    pass",
        "exec(compile('1/0', '/p/x.py', 'exec'))",
        "exec(compile('def f():\\n    raise RuntimeError(\"in f\")\\nf()', '/p/q r (1)/x.py', 'exec'), {'__name__': '__main__'})",
        "import sys\nprint(repr(sys.stdout.write('abc\\n')))",
        "print(repr(b'\\x00\\xff'), repr('\u00e9'), 1.5, 1e100, 2**70, -0.0)", "print(bytes(range(5)), bytearray(b'ab'))",
        "import gc\ngc.collect()\nprint(type(gc.mem_free()))",
        "import time\nprint(time.ticks_diff(time.ticks_ms(), time.ticks_ms()) <= 0)",
        "import binascii\nprint(binascii.hexlify(b'\\x01\\xab'))",
        "import hashlib\nprint(hashlib.sha256(b'abc').digest()[:4])",
        "import json\nprint(json.dumps({'a': [1, None, True]}))", "import struct\nprint(struct.pack('<hH', -1, 2))",
        "class A:\n    pass\nprint(A().__class__.__name__)",
        "import sys\ntry:\n    {}['x']\nexcept KeyError as e:\n    sys.print_exception(e)",
        "print(sorted({3: 1, 1: 2}.items()))", "print('%d %s %5.2f' % (3, 'x', 2.5))",
        "print('{:>5}|{:<5}|'.format('a', 'b'))", "f = lambda: 1\nprint(f())", "x = 10\ndel x\nx",
        "assert False", "assert False, 'msg'",
    ]

    def test_raw_exec_output_matches_the_fake_board(self):
        board = FakeBoard("esp32").start()
        self.addCleanup(board.stop)
        fc, vc = Client(board.port), self.client()
        self.addCleanup(fc.close)
        vc.prompt()
        fc.enter_raw()
        vc.enter_raw()
        for sn in self.PARITY_SNIPPETS:
            with self.subTest(snippet=sn):
                self.assertEqual(fc.raw_exec(sn), vc.raw_exec(sn))

    FRIENDLY_STEPS = [
        b"1+1\r", b"x = 5\r", b"print(x)\r", b"x\r", b"'abc'\r", b"None\r", b"[1, 2]\r",
        b"for i in range(2):\r", b"print(i)\r", b"\x7f", b"\r",
        b"def f():\r", b"return 1\r", b"\x7f", b"\r", b"f()\r",
        b"if x:\r", b"print('t')\r", b"\x7f", b"\r",
        b"1/0\r", b"nosuch\r", b"abc\x7f\x7fX\r", b"partial\x03",
        b"\x05", b"print('p1')\rprint('p2')\r", b"\x04",
        b"\x05", b"print('never')\r", b"\x03",
        b"v = (1,\r", b"2)\r", b"v\r",
        b"print(1)\r\n", b"\x7f\x7f",
    ]

    def test_friendly_repl_session_matches_the_fake_board_byte_for_byte(self):
        board = FakeBoard("esp32").start()
        self.addCleanup(board.stop)
        fc, vc = Client(board.port), self.client()
        self.addCleanup(fc.close)
        vc.prompt()
        fc.wake()
        vc.send(b"\r")
        vc.prompt()
        for step in self.FRIENDLY_STEPS:
            fc.send(step)
            vc.send(step)
            a = fc.read_quiet(0.03)                    # the in-process fake answers within a millisecond or two
            b = vc.read_matching(a)                    # the real VM: wait until it said exactly the same (or diverged)
            self.assertEqual(a, b, "step %r" % step)

    def test_typed_indentation_gives_the_same_result_as_the_real_repl(self):
        board = FakeBoard("esp32").start()
        self.addCleanup(board.stop)
        fc, vc = Client(board.port), self.client()
        self.addCleanup(fc.close)
        vc.prompt()
        fc.wake()
        vc.send(b"\r")
        vc.prompt()
        for c in (fc, vc):
            c.send(b"for i in range(3):\r    print(i)\r    print(i * 3)\r\r")
        a, b = fc.prompt(), vc.prompt()
        self.assertTrue(a.endswith(b"0\r\n0\r\n1\r\n3\r\n2\r\n6\r\n>>> "), a)
        self.assertTrue(b.endswith(b"0\r\n0\r\n1\r\n3\r\n2\r\n6\r\n>>> "), b)

    def test_exit_code_zero_from_ctrl_d_friendly_prints_reboot_and_banner(self):
        c = self.client()
        c.prompt()
        c.send(b"\x04")
        out = c.prompt(timeout=8)
        self.assertIn(b"MPY: soft reboot\r\n", out)
        self.assertIn(b"MicroPython v1.29.0", out)

    def test_mpremote_exec_and_fs_work_against_the_real_vm(self):
        code = "import sys; sys.path.insert(0, %r); from mpremote.main import main; sys.exit(main())" % VENDOR
        env = dict(os.environ, MPY_SAFE_MODE="1", PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")

        def mp(*args):
            return subprocess.run([sys.executable, "-B", "-X", "utf8", "-I", "-c", code, "connect", self.vm.url] + list(args),
                                  capture_output=True, timeout=60, env=env, cwd=tempfile.gettempdir())

        r = mp("exec", "print(6*7)")
        self.assertEqual((r.returncode, r.stdout), (0, b"42\r\n"), r.stderr)
        with open(os.path.join(self.vm.root, "f.txt"), "w") as f:
            f.write("data")
        r = mp("exec", "print(open('f.txt').read())")
        self.assertEqual((r.returncode, r.stdout), (0, b"data\r\n"), r.stderr)

    def test_ctrl_c_stops_a_raw_pasted_program(self):
        """The way Run starts programs: the unix VM has ISIG off while it executes, so the relay raises SIGINT."""
        c = self.client()
        c.prompt()
        c.enter_raw()
        c.send(b"\x05A\x01")
        self.assertEqual(c.read_exact(2), b"R\x01")
        c.read_exact(2)                                                  # window size
        c.send(b"import time\nwhile True:\n    print('t')\n    time.sleep(0.01)\n\x04")
        c.read_until(b"\x04")                                            # data accepted: the program runs now
        c.read_until(b"t\r\n")
        c.send(b"\x03")
        tail = c.read_until(b"\x04>")
        self.assertIn(b"KeyboardInterrupt", tail)
        self.assertEqual(self.vm.count("sigint"), 1)
        self.assertEqual(c.raw_exec("print('alive')"), (b"alive\r\n", b""))

    def test_url_unavailable_helpers(self):
        ok, reason = UnixVM.available()
        self.assertTrue(ok)
        self.assertEqual(reason, "")
        self.assertIsNone(UnixVM.skip_reason())


class UnixVmAvailabilityTests(TimedCase):
    def test_skip_reason_is_clear_when_the_binary_is_missing(self):
        old = os.environ.pop("MPY_UNIX_BIN", None)
        try:
            reason = UnixVM.skip_reason()
            self.assertIsNotNone(reason)
            self.assertTrue("MPY_UNIX_BIN" in reason or "POSIX" in reason, reason)
            os.environ["MPY_UNIX_BIN"] = "/nonexistent/micropython"
            self.assertIn("not an executable", UnixVM.skip_reason() or "not an executable (non-posix)")
            with self.assertRaises(RuntimeError):
                UnixVM().start()
        finally:
            if old is not None:
                os.environ["MPY_UNIX_BIN"] = old
            else:
                os.environ.pop("MPY_UNIX_BIN", None)


if __name__ == "__main__":
    unittest.main()
