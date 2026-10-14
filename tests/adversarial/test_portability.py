"""Portability review (Windows / Python 3.9..3.15) - adversarial tests.

Windows facts are simulated by injection (winerror attributes, 'COM3' names, ntpath, CRLF); nothing
here opens a serial port.  Tests named `test_*` in the classes marked DEFECT fail today and pin the
defect; the other classes pin behaviour that was checked and is fine.

Run (from the repo root):
    export MPY_SAFE_MODE=1
    /usr/bin/python3 -B -I -m unittest discover -s tests -t . -k test_portability -v
"""
from __future__ import annotations

import errno
import ntpath
import os
import re
import socket
import subprocess
import sys
import threading
import time
import types
import unittest
import warnings
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VENDOR = os.path.join(ROOT, "bridge", "vendor")
for _p in (ROOT, VENDOR):
    if _p in sys.path:
        sys.path.remove(_p)
    sys.path.insert(0, _p)
os.environ["MPY_SAFE_MODE"] = "1"

import serial  # noqa: E402  (vendored pyserial)

from bridge import devfs, link as linkmod  # noqa: E402
from bridge.errors import BridgeError, classify_open_error  # noqa: E402
from tools import fakeboard as fb  # noqa: E402


class _WinPermissionError(PermissionError):
    """What a Windows PermissionError looks like: errno 13 AND a winerror attribute."""

    def __init__(self, winerror, text="denied"):
        PermissionError.__init__(self, errno.EACCES, text)
        self.winerror = winerror


# ----------------------------------------------------------------------------- DEFECT: errors.py


class WindowsUnlistedWinerror(unittest.TestCase):
    """errors.py rule 2 lets ANY winerror win over errno; a winerror outside the two small tables
    then returns E_INTERNAL ("unexpected reason") although the errno (13) / class name say EACCES."""

    def test_permission_error_with_unlisted_winerror_is_still_a_permission_error(self):
        # 1260 = ERROR_ACCESS_DISABLED_BY_POLICY, 1314 = ERROR_PRIVILEGE_NOT_HELD ...
        for win in (1260, 1314, 1450):
            with self.subTest(winerror=win):
                e = classify_open_error(_WinPermissionError(win), "COM3")
                self.assertEqual(e.code, "E_PERMISSION", e.detail)

    def test_pyserial_text_with_unlisted_winerror_falls_back_to_the_class_name(self):
        exc = serial.SerialException("could not open port 'COM3': PermissionError(13, 'Blocked by policy', None, 1260)")
        self.assertEqual(classify_open_error(exc, "COM3").code, "E_PERMISSION")


class WindowsComNameCase(unittest.TestCase):
    """link.py:222 _held_key() knows COM names are case-insensitive; lookup_usb_ids() (link.py:243) does not."""

    def _comports(self):
        p = types.SimpleNamespace(device="COM3", vid=0x10C4, pid=0xEA60)
        return mock.patch("serial.tools.list_ports.comports", return_value=[p])

    def test_lookup_usb_ids_matches_com_names_case_insensitively(self):
        with self._comports():
            self.assertEqual(linkmod.lookup_usb_ids("COM3"), (0x10C4, 0xEA60))  # sanity: exact name works
            self.assertEqual(linkmod.lookup_usb_ids("com3"), (0x10C4, 0xEA60))

    def test_lookup_usb_ids_matches_the_win32_device_namespace_form(self):
        with self._comports():
            self.assertEqual(linkmod.lookup_usb_ids("\\\\.\\COM3"), (0x10C4, 0xEA60))


# ----------------------------------------------------------------------------- DEFECT: fakeboard on a Windows host


class _NtOs(object):
    """`os` as seen on a Windows host as far as fakeboard's path mapping is concerned."""

    path = ntpath

    def __getattr__(self, name):
        return getattr(os, name)


class FakeBoardWindowsHostPaths(unittest.TestCase):
    """tools/fakeboard.py:743 maps device names to the host with os.path.join(root, *segments).  On a Windows
    host a segment holding a backslash or a drive ("C:") escapes the board's private directory."""

    ROOT_DIR = "C:\\Users\\student\\AppData\\Local\\Temp\\fakeboard-abc123"

    def _fos(self, root=None):
        fos = object.__new__(fb._FakeOS)
        fos._root = root or self.ROOT_DIR
        fos._dev = types.SimpleNamespace(oserror=lambda name: OSError(name))
        fos._mount = None
        fos._cwd = "/"
        return fos

    def _inside(self, host, root=None):
        norm = ntpath.normcase(ntpath.normpath(host))
        base = ntpath.normcase(ntpath.normpath(root or self.ROOT_DIR))
        return norm == base or norm.startswith(base + "\\")

    def test_plain_names_map_inside_the_root(self):
        with mock.patch.object(fb, "os", _NtOs()):
            host, virt = self._fos()._host("/lib/utils.py")
        self.assertFalse(virt)
        self.assertEqual(host, self.ROOT_DIR + "\\lib\\utils.py")

    def test_backslash_dotdot_cannot_leave_the_root(self):
        with mock.patch.object(fb, "os", _NtOs()):
            try:
                host, _ = self._fos()._host("/..\\..\\..\\Windows\\win.ini")
            except OSError:
                return                        # refused (ENOENT on the device): fine
        self.assertTrue(self._inside(host), "escaped the board root: %r" % host)

    def test_drive_segment_cannot_leave_the_root(self):
        root = "D:\\scratch\\fakeboard-abc123"       # a temp dir on another drive than the segment's "C:"
        with mock.patch.object(fb, "os", _NtOs()):
            try:
                host, _ = self._fos(root)._host("/C:/Windows/win.ini")
            except OSError:
                return
        self.assertTrue(self._inside(host, root), "escaped the board root: %r" % host)


# ----------------------------------------------------------------------------- DEFECT: fakeboard capture race


class _GatedSock(object):
    """Delegates to a real socket, but sendall() returns only after `gate` is set (data is already sent)."""

    def __init__(self, real, gate):
        self._real = real
        self._gate = gate

    def sendall(self, data):
        self._real.sendall(data)
        self._gate.wait(5.0)

    def __getattr__(self, name):
        return getattr(self._real, name)


class FakeBoardTxTranscript(unittest.TestCase):
    """fakeboard.py:2667-2669 _tx() appends to the capture transcript AFTER sendall().  A client that has
    already received the bytes can call tx_data() and not see them (flaky test_capture_records_wire_bytes_and_code:
    ~25% under `python -I` on 3.9).  Made deterministic here by holding sendall() open after the bytes left."""

    def test_tx_data_contains_every_byte_a_client_has_already_received(self):
        gate = threading.Event()
        self.addCleanup(gate.set)
        board = fb.FakeBoard("esp32", capture=True)
        board.start()
        self.addCleanup(board.stop)
        sock = socket.create_connection(("127.0.0.1", board.port), timeout=5.0)
        self.addCleanup(sock.close)
        self.assertIsNotNone(board.events.wait_for("connect"))
        sock.settimeout(0.05)
        got = b""
        end = time.monotonic() + 5.0
        sock.sendall(b"\r")
        while not got.endswith(b">>> ") and time.monotonic() < end:
            try:
                got += sock.recv(4096)
            except socket.timeout:
                pass
        self.assertTrue(got.endswith(b">>> "), got)
        with board._lock:
            (client,) = list(board._clients)
        client.sock = _GatedSock(client.sock, gate)
        sock.sendall(b"q")                    # the friendly REPL echoes it
        sock.settimeout(5.0)
        reply = sock.recv(4096)               # arrives although _tx() is still inside sendall()
        self.assertEqual(reply, b"q")
        self.assertTrue(board.tx_data().endswith(b"q"), "bytes the client already holds are missing from the capture")


# ----------------------------------------------------------------------------- DEFECT: py3.12+ warning


class FakeBoardModuleSpecWarning(unittest.TestCase):
    """fakeboard.py:1130/1412/1454 build modules with types.ModuleType(name) (__spec__ None, __loader__ None);
    formatting a traceback through them makes linecache warn on Python 3.12+ ("Module globals is missing a
    __spec__.loader"), and `-W error::DeprecationWarning` turns the device's ImportError into that warning."""

    def test_traceback_through_a_frozen_package_emits_no_python_warning(self):
        from tests.test_fakeboard import Client

        prof = fb.derive_profile("custom-frozen", c_modules={"_acme": "ABI = 2\n"})
        board = fb.FakeBoard(prof)
        board.start()
        self.addCleanup(board.stop)
        c = Client(board.port)
        self.addCleanup(c.close)
        c.enter_raw()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            out, err = c.raw_exec("import acme")
        self.assertIn(b"ImportError: acme ABI 2", err)
        bad = [str(w.message) for w in caught if issubclass(w.category, DeprecationWarning)]
        self.assertEqual(bad, [])


# ----------------------------------------------------------------------------- DEFECT: test hygiene (-I)


class TestSubprocessesIgnoreEnvUnderIsolatedMode(unittest.TestCase):
    """`python -I` ignores every PYTHON* variable.  tests/test_fakeboard.py starts mpremote with
    `-I` and env PYTHONUTF8=1 / PYTHONDONTWRITEBYTECODE=1: neither takes effect, so (a) the child is not in UTF-8 mode
    on Windows / Python < 3.15 and (b) it writes __pycache__ into bridge/vendor/ (verified: cpython-310..315 dirs)."""

    def test_every_isolated_test_subprocess_passes_B_and_X_utf8(self):
        src_path = os.path.join(ROOT, "tests", "test_fakeboard.py")
        with open(src_path, encoding="utf-8") as f:
            lines = f.read().splitlines()
        offenders = []
        for i, line in enumerate(lines):
            if '"-I"' in line and "sys.executable" in line:
                window = " ".join(lines[i:i + 3])
                if '"-B"' not in window or '"utf8"' not in window:
                    offenders.append((i + 1, line.strip()))
        self.assertEqual(offenders, [], "python -I without -B and -X utf8 (PYTHON* env vars are ignored by -I)")


# ----------------------------------------------------------------------------- checked and fine


class WindowsFactsThatHold(unittest.TestCase):
    def test_crlf_device_output_is_parsed(self):
        out = b'noise\r\n@@{"k":"s","x":1,"d":0,"s":5,"m":7}\r\n@@{"k":"end"}\r\n'
        items = devfs._split_output(out)
        self.assertEqual([i for i in items if isinstance(i, dict)][0]["s"], 5)
        self.assertEqual(items[0], b"noise")

    def test_known_winerrors_classify_without_errno_text(self):
        for win, code in ((5, "E_PORT_BUSY"), (32, "E_PORT_BUSY"), (2, "E_NO_DEVICE"), (31, "E_NO_DEVICE"), (121, "E_NO_DEVICE")):
            exc = serial.SerialException("could not open port 'COM3': OSError(22, \"L'appareil n'existe pas\", None, %d)" % win)
            self.assertEqual(classify_open_error(exc, "COM3").code, code, win)

    def test_com_names_are_case_folded_for_the_in_process_registry(self):
        self.assertEqual(linkmod._held_key("com3"), linkmod._held_key("COM3"))

    def test_com_port_is_a_device_not_a_pty_or_url(self):
        for p in ("COM3", "com12", "\\\\.\\COM12"):
            self.assertEqual(linkmod.port_kind(p), "device")
            self.assertEqual(linkmod.normalize_port(p, "win32"), p)
            self.assertEqual(linkmod.select_policy("auto", "device", "win32", 0x10C4), "default")

    def test_safe_mode_blocks_com_ports_and_pathsep_is_used_for_harness_ptys(self):
        env = {"MPY_SAFE_MODE": "1"}
        with self.assertRaises(BridgeError) as cm:
            linkmod.safe_mode_check("COM3", env)
        self.assertEqual(cm.exception.code, "E_SAFE_MODE")
        linkmod.safe_mode_check("COM3", dict(env, MPY_REAL_PORT="COM3"))

    def test_replace_retry_treats_winerror_sharing_violations_as_transient(self):
        calls = []

        def flaky(a, b):
            calls.append(1)
            if len(calls) < 3:
                raise _WinPermissionError(32, "The process cannot access the file because it is being used by another process")

        with mock.patch.object(devfs.os, "replace", flaky), mock.patch.object(devfs.time, "sleep"):
            devfs._replace_retry("a.mpytmp", "a")
        self.assertEqual(len(calls), 3)

    def test_local_error_message_with_a_windows_path_is_not_mangled(self):
        path = "C:\\Users\\me\\OneDrive - WSU (email.wsu.edu)\\ME 241 (Fall)\\Lab 1\\main \u00e9.py"
        e = devfs._local_error(_WinPermissionError(32, "in use"), path, "replace")
        self.assertEqual(e.code, "E_LOCAL_IO")
        self.assertIn(path, e.message)

    def test_device_paths_stay_posix_even_with_backslashes_in_names(self):
        self.assertEqual(devfs._norm("/lib/a\\b.py"), "/lib/a\\b.py")
        self.assertEqual(devfs._tmp_name("/lib/a\\b.py"), "/lib/a\\b.py.mpytmp")
        with self.assertRaises(BridgeError):
            devfs._norm("C:\\lib\\a.py")


class SourceHygiene(unittest.TestCase):
    """Static checks over bridge/*.py and tools/fakeboard.py (the files that must run on Windows)."""

    FILES = ("bridge/link.py", "bridge/devfs.py", "bridge/errors.py", "tools/fakeboard.py")

    def _src(self, rel):
        with open(os.path.join(ROOT, *rel.split("/")), encoding="utf-8") as f:
            return f.read()

    def test_future_annotations_first(self):
        for rel in self.FILES:
            self.assertIn("from __future__ import annotations", self._src(rel), rel)

    def test_no_posix_only_modules_or_calls(self):
        import ast

        banned_mods = {"pty", "termios", "fcntl", "resource", "grp", "pwd"}
        banned_calls = {("os", n) for n in ("fork", "dup", "dup2", "setsid", "killpg", "getpgid")}
        banned_calls |= {("select", "select"), ("select", "poll"), ("signal", "SIGKILL")}
        for rel in self.FILES:
            for node in ast.walk(ast.parse(self._src(rel))):
                if isinstance(node, ast.Import):
                    for a in node.names:
                        self.assertNotIn(a.name.split(".")[0], banned_mods, "%s:%d" % (rel, node.lineno))
                elif isinstance(node, ast.ImportFrom) and node.module:
                    self.assertNotIn(node.module.split(".")[0], banned_mods, "%s:%d" % (rel, node.lineno))
                elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                    self.assertNotIn((node.value.id, node.attr), banned_calls, "%s:%d" % (rel, node.lineno))

    def test_every_text_open_names_an_encoding(self):
        import ast

        for rel in self.FILES:
            tree = ast.parse(self._src(rel))
            for node in ast.walk(tree):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "open"):
                    continue
                mode = "r"
                if len(node.args) > 1:
                    mode = node.args[1].value if isinstance(node.args[1], ast.Constant) else "b"  # variable: unknown
                for kw in node.keywords:
                    if kw.arg == "mode":
                        mode = kw.value.value if isinstance(kw.value, ast.Constant) else "b"
                if "b" not in str(mode):
                    self.assertIn("encoding", [kw.arg for kw in node.keywords], "%s:%d text-mode open() without encoding" % (rel, node.lineno))


if __name__ == "__main__":
    unittest.main()
