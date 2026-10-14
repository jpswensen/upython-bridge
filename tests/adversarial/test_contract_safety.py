"""Contract-and-safety review tests (docs/protocol.md section 8, RQ-SAFE-*, CLAUDE.md hard rules).

The deviations the review found here (tests once named *_FAILS_TODAY) are fixed; all of these tests pass and pin
behaviour that nothing else pins.

No test here opens a serial port: targets are socket://127.0.0.1 fake boards, recording stub serial
classes, and a nonexistent device name that safe mode must refuse before any OS call.

    export MPY_SAFE_MODE=1
    python3 -B -m unittest tests.adversarial.test_contract_safety -v
"""
from __future__ import annotations

import ast
import importlib.util
import os
import re
import shutil
import sys
import tempfile
import time
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
for _p in (ROOT, os.path.join(ROOT, "bridge", "vendor")):
    if _p in sys.path:
        sys.path.remove(_p)
    sys.path.insert(0, _p)
os.environ["MPY_SAFE_MODE"] = "1"

from bridge import devfs, link as linkmod  # noqa: E402
from bridge.errors import BridgeError  # noqa: E402
from bridge.link import Link  # noqa: E402
from tools.fakeboard import FakeBoard, PROGRAMS  # noqa: E402


def _py_files(*subdirs):
    for sub in subdirs:
        base = os.path.join(ROOT, sub)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in ("vendor", "__pycache__", "prototypes", "adversarial")]
            for fn in filenames:
                if fn.endswith(".py"):
                    yield os.path.join(dirpath, fn)


class SafeModeHostParsingTests(unittest.TestCase):
    """Protocol section 8: safe mode may only let a socket:// or rfc2217:// URL through when it points at THIS
    machine. The check must use the host pyserial will actually connect to."""

    ENV = {"MPY_SAFE_MODE": "1"}

    def _connects_to(self, url):
        import serial
        ser = serial.serial_for_url(url, do_not_open=True)   # parses only, opens nothing
        return ser.from_url(url)[0]

    def test_userinfo_and_127_prefix_hostnames_do_not_pass_as_loopback(self):
        urls = [
            "socket://127.0.0.1@lab-pc.example:23",          # userinfo says 127.0.0.1, host is lab-pc.example
            "socket://127.0.0.1:9@192.168.1.5:23",
            "rfc2217://127.0.0.1:1@lab-pc:2217",
            "socket://127.attacker.example:23",              # a name that merely starts with "127."
        ]
        leaked = []
        for url in urls:
            host = self._connects_to(url)
            self.assertFalse(host.startswith("127.0.0.") or host == "localhost", (url, host))
            try:
                linkmod.safe_mode_check(url, self.ENV)
                leaked.append("%s -> pyserial connects to %s" % (url, host))
            except BridgeError as exc:
                self.assertEqual(exc.code, "E_SAFE_MODE")
        self.assertEqual(leaked, [], "safe mode let non-loopback hosts through")

    def test_loopback_forms_still_allowed(self):
        for url in ("socket://127.0.0.1:5555", "socket://localhost:5555", "socket://[::1]:5555",
                    "rfc2217://127.0.0.1:2217", "loop://"):
            linkmod.safe_mode_check(url, self.ENV)

    def test_open_never_constructs_the_serial_object_for_a_refused_port(self):
        made = []

        def factory(*a, **k):
            made.append(a)
            raise AssertionError("serial object created in safe mode")

        lk = Link(serial_factory=factory)
        # A name no real machine has: even if safe mode were broken the OS would answer ENOENT.
        for port in ("/dev/cu.mpy-review-nonexistent-9", "COM98", "auto", "hwgrep://10C4:EA60"):
            with self.assertRaises(BridgeError) as cm:
                lk.open(port)
            self.assertEqual(cm.exception.code, "E_SAFE_MODE", port)
        self.assertEqual(made, [])


class HwkitHonoursSafeModeTests(unittest.TestCase):
    """CLAUDE.md: agents and tests set MPY_SAFE_MODE=1 and 'hardware steps happen only with MPY_REAL_PORT=<port>'.
    tools/hwkit/mpy_hwkit.py opens real ports; it must refuse under MPY_SAFE_MODE=1 unless MPY_REAL_PORT equals
    the requested port. The test substitutes a stub serial class, so nothing is ever opened."""

    def _run_kit(self, port, extra_env):
        path = os.path.join(ROOT, "tools", "hwkit", "mpy_hwkit.py")
        spec = importlib.util.spec_from_file_location("review_mpy_hwkit", path)
        kit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(kit)
        kit.list_ports = lambda: []                       # no enumeration either
        opened = []

        class Stub(object):
            def __init__(self):
                self.port = None
                self.dtr = True
                self.rts = True

            def open(self):
                opened.append(self.port)
                raise OSError("STUB: stopped before touching the OS")

        mod = types.ModuleType("review_hwkit_stub")
        mod.Stub = Stub
        sys.modules["review_hwkit_stub"] = mod
        saved = {k: os.environ.get(k) for k in ("MPY_SAFE_MODE", "MPY_REAL_PORT")}
        os.environ["MPY_SAFE_MODE"] = "1"
        os.environ.pop("MPY_REAL_PORT", None)
        os.environ.update(extra_env)
        report_dir = tempfile.mkdtemp(prefix="hwkit-review-")
        self.addCleanup(shutil.rmtree, report_dir, True)
        report = os.path.join(report_dir, "r.json")
        try:
            argv = ["--port", port, "--motors-on-acknowledged", "--force-unknown-adapter", "--stages", "A",
                    "--serial-class", "review_hwkit_stub:Stub", "--report", report]
            devnull = open(os.devnull, "w")
            old_out = sys.stdout
            sys.stdout = devnull
            try:
                kit.main(argv)
            except SystemExit:
                pass
            finally:
                sys.stdout = old_out
                devnull.close()
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            sys.modules.pop("review_hwkit_stub", None)
        return opened

    def test_kit_does_not_open_a_real_device_path_under_safe_mode(self):
        opened = self._run_kit("/dev/cu.mpy-review-nonexistent-9", {})
        self.assertEqual(opened, [], "mpy_hwkit reached serial open() with MPY_SAFE_MODE=1 and no MPY_REAL_PORT")

    def test_kit_may_open_the_port_named_by_MPY_REAL_PORT(self):
        port = "/dev/cu.mpy-review-nonexistent-9"
        opened = self._run_kit(port, {"MPY_REAL_PORT": port})
        self.assertEqual(opened, [port])


class RmtreeMountPointTests(unittest.TestCase):
    """old-defects 03.5: 'refuse mount points and rootPath itself'. On a board whose filesystem is a mount under '/'
    (pyboard: '/flash'), fs.rmtree('/flash') must not wipe boot.py and main.py with a single confirm."""

    def test_rmtree_of_a_top_level_mount_point_is_refused(self):
        board = FakeBoard(profile="stm32")
        board.start()
        lk = Link()
        try:
            lk.open(board.url)
            lk.sync_to_prompt(300, 300)

            def fs(fn, *a, **kw):
                with lk.session():
                    lk.enter_raw()
                    try:
                        return fn(lk.exec, *a, **kw)
                    finally:
                        lk.exit_raw()

            before = sorted(e["name"] for e in fs(devfs.list_dir, "/flash")["entries"])
            self.assertIn("boot.py", before)
            try:
                fs(devfs.rmtree, "/flash")
            except BridgeError:
                pass
            try:
                after = sorted(e["name"] for e in fs(devfs.list_dir, "/flash")["entries"])
            except BridgeError:
                after = []
            self.assertEqual(after, before, "rmtree('/flash') deleted the board's user filesystem")
        finally:
            lk.close()
            board.stop()


class ShadowGuardTests(unittest.TestCase):
    """protocol 3 (fs.put): 'Refuses names that shadow modules in shadowGuard, E_SHADOWS_MODULE'; RQ-ID-4; old-defects 08.15."""

    def test_something_in_bridge_actually_raises_E_SHADOWS_MODULE(self):
        hits = []
        for fn in sorted(os.listdir(os.path.join(ROOT, "bridge"))):
            if fn.endswith(".py") and fn != "errors.py":
                with open(os.path.join(ROOT, "bridge", fn), encoding="utf-8") as f:
                    if "E_SHADOWS_MODULE" in f.read():
                        hits.append(fn)
        self.assertTrue(hits, "no bridge module ever raises E_SHADOWS_MODULE (shadowGuard is not implemented)")


class StopNeverEscalatesTests(unittest.TestCase):
    """RQ-SAFE-2/3, Appendix G #8 and #10: Stop of a program that swallows Ctrl-C ends at 'not responding', never a reset."""

    def test_interrupt_of_a_program_that_swallows_ctrl_c_reports_false_and_resets_nothing(self):
        import threading
        board = FakeBoard(profile="esp32")
        board.start()
        lk = Link()
        try:
            lk.open(board.url)
            self.assertEqual(lk.sync_to_prompt(300, 300), "prompt")
            lk.enter_raw()
            out = []
            def stream():
                try:
                    lk.exec_stream(PROGRAMS["swallow_ctrl_c"], out.append)
                except BridgeError:
                    pass  # the test closes the link while this follower is still reading: that is how it ends

            th = threading.Thread(target=stream)
            th.daemon = True
            th.start()
            deadline = time.monotonic() + 3
            while not out and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(out, "program did not start")
            t0 = time.monotonic()
            self.assertFalse(lk.interrupt(timeout=0.6), "a swallowed Ctrl-C must report stopped:false")
            self.assertLess(time.monotonic() - t0, 2.0)
            self.assertEqual(board.events.count("hard_reset"), 0)
            self.assertEqual(board.events.count("soft_reset"), 0)
        finally:
            lk.close()
            board.stop()

    def test_stop_twice_and_when_idle_are_harmless(self):
        board = FakeBoard(profile="esp32")
        board.start()
        lk = Link()
        try:
            lk.open(board.url)
            lk.sync_to_prompt(300, 300)
            for _ in range(3):
                self.assertTrue(lk.interrupt(timeout=1.0))
            self.assertEqual(board.events.count("soft_reset") + board.events.count("hard_reset"), 0)
        finally:
            lk.close()
            board.stop()


class RealPortHygieneTests(unittest.TestCase):
    """RQ-SAFE-6 acceptance: 'grep test shows no comports()-based open in the default suite'; R-ARCH-2: no shell strings."""

    def test_no_test_or_tool_opens_a_literal_device_name(self):
        """A string literal that names a real device (not a socket/loop/rfc2217 URL) handed to a serial constructor."""
        pat = re.compile(r"(?:\bSerial|serial_for_url)\(\s*[rbu]?['\"](?!socket://|loop://|rfc2217://)")
        offenders = []
        for path in _py_files("tests", "tools", "bridge"):
            if os.sep + "hwkit" + os.sep in path:
                continue                                               # the hardware kit is gated separately
            with open(path, encoding="utf-8") as f:
                for n, text in enumerate(f, 1):
                    if pat.search(text) and not text.lstrip().startswith("#"):
                        offenders.append("%s:%d: %s" % (os.path.relpath(path, ROOT), n, text.strip()))
        self.assertEqual(offenders, [])

    def test_comports_is_never_followed_by_an_open_in_tests(self):
        for path in _py_files("tests"):
            with open(path, encoding="utf-8") as f:
                src = f.read()
            if "comports" in src and "this file" not in src:
                self.assertNotRegex(src, r"comports\(\)[\s\S]{0,400}(\.open\(|serial_for_url\()", path)

    def test_bridge_python_code_has_no_shell_or_process_spawning(self):
        banned = {"subprocess", "pty", "pexpect"}
        for path in _py_files("bridge"):
            with open(path, encoding="utf-8") as f:
                tree = ast.parse(f.read())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names = [a.name.split(".")[0] for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [(node.module or "").split(".")[0]]
                else:
                    if isinstance(node, ast.Attribute) and node.attr in ("system", "popen", "fork", "SIGKILL"):
                        self.fail("%s uses %s" % (path, node.attr))
                    continue
                for n in names:
                    self.assertNotIn(n, banned, path)


class DisconnectDoesNotStopTheProgramTests(unittest.TestCase):
    """protocol 3: 'disconnect: running programs are not stopped by disconnect unless stopFirst:true'; the host dropping the
    link must not send Ctrl-C/Ctrl-D by itself at Link level (that is the bridge's explicit stopOnDisconnect step)."""

    def test_close_leaves_a_running_program_alone_and_sends_no_bytes(self):
        board = FakeBoard(profile="esp32", faults=["main_forever"], capture=True)
        board.start()
        lk = Link()
        try:
            lk.open(board.url)
            self.assertEqual(lk.sync_to_prompt(300, 300), "running-program")
            n_before = len(board.rx_data())
            lk.close()
            time.sleep(0.2)
            self.assertEqual(len(board.rx_data()), n_before)
            self.assertEqual(board.events.count("interrupt"), 0)
            self.assertTrue(board.program_running)
        finally:
            lk.close()
            board.stop()


if __name__ == "__main__":
    unittest.main()
