"""tools/hwkit/mpy_hwkit.py honours MPY_SAFE_MODE / MPY_REAL_PORT (CLAUDE.md rule 5, protocol Appendix A.1).

Nothing here can open a real port: every test runs the kit's main() in-process with a stub serial class and a
fake `serial` package whose Serial / serial_for_url / comports fail the test if they are ever reached.
The only subprocess test uses a device path that does not exist and `--list-checks`.

Run:  MPY_SAFE_MODE=1 python3 -B -m unittest tests.test_hwkit_guard
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT_PATH = os.path.join(ROOT, "tools", "hwkit", "mpy_hwkit.py")
STUB_MODULE = "hwkit_guard_stub"

REAL_LOOKING_PORTS = ["/dev/cu.usbserial-0001", "/dev/tty.usbserial-0001", "/dev/ttyUSB0", "/dev/ttyACM0", "COM3", "COM12",
                      "\\\\.\\COM12", "auto"]
SAFE_MODE_ON_VALUES = ["1", "true", "TRUE", "yes", "on", "On", "2", "anything", " 1 "]
SAFE_MODE_OFF_VALUES = [None, "", "0", "false", "False", "no", "off", "OFF", " "]


def load_kit():
    spec = importlib.util.spec_from_file_location("hwkit_under_test_%d" % id(object()), KIT_PATH)
    kit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(kit)
    return kit


class _Forbidden(object):
    """Stands in for pyserial's real classes: reaching them is a test failure."""
    def __init__(self, *a, **kw):
        raise AssertionError("REAL pyserial object constructed: %r %r" % (a, kw))


def _fake_serial_package():
    pkg = types.ModuleType("serial")
    pkg.__version__ = "0-fake"
    pkg.Serial = _Forbidden
    pkg.serial_for_url = _Forbidden
    tools = types.ModuleType("serial.tools")
    lp = types.ModuleType("serial.tools.list_ports")

    def comports(*a, **kw):
        raise AssertionError("port enumeration reached")
    lp.comports = comports
    tools.list_ports = lp
    pkg.tools = tools
    return {"serial": pkg, "serial.tools": tools, "serial.tools.list_ports": lp}


class KitHarness(unittest.TestCase):
    """Runs main() in-process. `self.constructed` lists every stub serial object created; `self.opened` every open()."""

    def setUp(self):
        self.kit = load_kit()
        self.constructed = []
        self.opened = []
        self.enumerated = []
        self.loaded_classes = []
        harness = self

        class Stub(object):
            def __init__(self):
                harness.constructed.append(self)
                self.port = None
                self.dtr = True
                self.rts = True

            def open(self):
                harness.opened.append(self.port)
                raise OSError("STUB: stopped before touching the OS")

        mod = types.ModuleType(STUB_MODULE)
        mod.Stub = Stub
        patcher = mock.patch.dict(sys.modules, dict(_fake_serial_package(), **{STUB_MODULE: mod}))
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        # a regression must fail the test, never hang it on the "type MOTORS OFF" prompt (EOF = not confirmed)
        prompt = mock.patch("builtins.input", side_effect=EOFError)
        prompt.start()
        self.addCleanup(prompt.stop)
        for k in ("MPY_SAFE_MODE", "MPY_REAL_PORT", "MPY_HARNESS_PTYS"):
            os.environ.pop(k, None)
        self.rows = []
        self.kit.list_ports = self._list_ports
        real_load = self.kit.load_serial_class

        def load(spec):
            self.loaded_classes.append(spec)
            return real_load(spec)
        self.kit.load_serial_class = load
        self.tmp = tempfile.mkdtemp(prefix="hwkit-guard-")
        self.addCleanup(self._rm, self.tmp)

    @staticmethod
    def _rm(path):
        import shutil
        shutil.rmtree(path, True)

    def _list_ports(self):
        self.enumerated.append(True)
        return list(self.rows)

    def known_row(self, port):
        return dict(device=port, vid=0x10C4, pid=0xEA60, serial="0001", mfr="Silicon Labs", product="CP2102", desc="CP2102")

    def run_kit(self, *argv, **env):
        """Returns (exit code, stdout text). env values of None delete the variable."""
        for k, v in env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        argv = list(argv)
        if "--report" not in argv:
            argv += ["--report", os.path.join(self.tmp, "r.json")]
        if not ({"--list-checks", "--show-snippets"} & set(argv)):
            # short, fast runs: a regressed guard must fail the test quickly, not sit through stage B's open/close cycles
            for flag, value in (("--stages", "A"), ("--cycles", "1"), ("--gap", "0"), ("--listen", "0")):
                if flag not in argv:
                    argv += [flag, value]
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = self.kit.main(argv)
        return code, buf.getvalue()

    def assert_nothing_touched(self, out=""):
        self.assertEqual(self.constructed, [], "a serial object was constructed\n" + out)
        self.assertEqual(self.opened, [], "a port was opened\n" + out)


class SafeModeRefusalTests(KitHarness):
    def test_refuses_every_real_looking_port_without_touching_anything(self):
        for port in REAL_LOOKING_PORTS:
            for flags in (["--yes-motors-off"], ["--motors-on-acknowledged"], ["--motors-on-acknowledged", "--force-unknown-adapter"]):
                with self.subTest(port=port, flags=flags):
                    self.rows = [self.known_row(port)]
                    code, out = self.run_kit("--port", port, "--stages", "A", "--serial-class", STUB_MODULE + ":Stub", *flags,
                                             MPY_SAFE_MODE="1", MPY_REAL_PORT=None)
                    self.assertEqual(code, 2, out)
                    self.assertIn("MPY_SAFE_MODE", out)
                    self.assertIn("Nothing was opened", out)
                    self.assert_nothing_touched(out)
        # the refusal comes first: no enumeration and no serial-class import either
        self.assertEqual(self.enumerated, [])
        self.assertEqual(self.loaded_classes, [])

    def test_refuses_without_serial_class_too(self):
        # default class is pyserial's; the fake package fails the test if it is reached
        for port in ("/dev/cu.usbserial-0001", "COM3"):
            with self.subTest(port=port):
                code, out = self.run_kit("--port", port, "--motors-on-acknowledged", "--force-unknown-adapter",
                                         MPY_SAFE_MODE="1", MPY_REAL_PORT=None)
                self.assertEqual(code, 2, out)
                self.assertEqual(self.loaded_classes, [])

    def test_every_truthy_safe_mode_value_refuses(self):
        for value in SAFE_MODE_ON_VALUES:
            with self.subTest(MPY_SAFE_MODE=value):
                self.rows = [self.known_row("/dev/cu.usbserial-0001")]
                code, out = self.run_kit("--port", "/dev/cu.usbserial-0001", "--motors-on-acknowledged", "--serial-class",
                                         STUB_MODULE + ":Stub", MPY_SAFE_MODE=value, MPY_REAL_PORT=None)
                self.assertEqual(code, 2, out)
                self.assert_nothing_touched(out)

    def test_MPY_REAL_PORT_naming_a_different_port_does_not_help(self):
        for real in ("/dev/cu.usbserial-0002", "/dev/cu.usbserial-000", "/dev/cu.usbserial-0001/", " /dev/cu.usbserial-0001",
                     "/dev/CU.USBSERIAL-0001", "COM4"):
            with self.subTest(real=real):
                self.rows = [self.known_row("/dev/cu.usbserial-0001")]
                code, out = self.run_kit("--port", "/dev/cu.usbserial-0001", "--motors-on-acknowledged", "--serial-class",
                                         STUB_MODULE + ":Stub", MPY_SAFE_MODE="1", MPY_REAL_PORT=real)
                self.assertEqual(code, 2, out)
                self.assert_nothing_touched(out)

    def test_MPY_REAL_PORT_auto_never_matches(self):
        for real in ("auto", "AUTO", " Auto "):
            for port in ("/dev/cu.usbserial-0001", "auto", real):
                with self.subTest(real=real, port=port):
                    self.rows = [self.known_row(port)]
                    code, out = self.run_kit("--port", port, "--motors-on-acknowledged", "--serial-class", STUB_MODULE + ":Stub",
                                             MPY_SAFE_MODE="1", MPY_REAL_PORT=real)
                    self.assertEqual(code, 2, out)
                    self.assert_nothing_touched(out)

    def test_no_port_given_opens_nothing_and_still_works(self):
        code, out = self.run_kit(MPY_SAFE_MODE="1")
        self.assertEqual(code, 0)
        self.assertIn("No --port given", out)
        self.assert_nothing_touched(out)


class SupervisedRealPortStillWorksTests(KitHarness):
    """MPY_REAL_PORT == port: the kit goes on to its normal gate, which still demands an explicit motor attestation."""
    PORT = "/dev/cu.usbserial-0001"

    def setUp(self):
        super().setUp()
        self.rows = [self.known_row(self.PORT)]

    def base(self, *extra):
        return ["--port", self.PORT, "--stages", "A", "--serial-class", STUB_MODULE + ":Stub"] + list(extra)

    def test_proceeds_to_gate_which_refuses_without_attestation(self):
        code, out = self.run_kit(*self.base(), MPY_SAFE_MODE="1", MPY_REAL_PORT=self.PORT)
        self.assertEqual(code, 2, out)
        self.assertIn("REFUSING: this opens a real USB serial port", out)
        self.assertNotIn("MPY_SAFE_MODE", out)          # it got past the safe-mode check and was stopped by the gate
        self.assertTrue(self.enumerated)
        self.assert_nothing_touched(out)

    def test_motors_on_acknowledged_goes_through(self):
        code, out = self.run_kit(*self.base("--motors-on-acknowledged"), MPY_SAFE_MODE="1", MPY_REAL_PORT=self.PORT)
        self.assertEqual(code, 0, out)
        self.assertIn("INSTRUCTOR OVERRIDE", out)
        self.assertEqual(self.opened, [self.PORT])      # the stub (not pyserial) was opened, on exactly that port

    def test_yes_motors_off_still_needs_the_typed_confirmation(self):
        with mock.patch("builtins.input", return_value="no") as inp:
            code, out = self.run_kit(*self.base("--yes-motors-off"), MPY_SAFE_MODE="1", MPY_REAL_PORT=self.PORT)
        self.assertEqual(code, 2, out)
        self.assertEqual(inp.call_count, 1)
        self.assert_nothing_touched(out)
        with mock.patch("builtins.input", return_value="MOTORS OFF"):
            code, out = self.run_kit(*self.base("--yes-motors-off"), MPY_SAFE_MODE="1", MPY_REAL_PORT=self.PORT)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.opened, [self.PORT])

    def test_unknown_adapter_check_still_applies(self):
        self.rows = [dict(self.known_row(self.PORT), vid=0x1234, pid=0x5678)]
        code, out = self.run_kit(*self.base("--motors-on-acknowledged"), MPY_SAFE_MODE="1", MPY_REAL_PORT=self.PORT)
        self.assertEqual(code, 2, out)
        self.assertIn("not a known ESP32 USB-UART bridge", out)
        self.assert_nothing_touched(out)


class SafeModeOffUnchangedTests(KitHarness):
    PORT = "/dev/cu.usbserial-0001"

    def test_not_safe_mode_behaves_as_before(self):
        for value in SAFE_MODE_OFF_VALUES:
            with self.subTest(MPY_SAFE_MODE=value):
                self.constructed[:], self.opened[:] = [], []
                self.rows = [self.known_row(self.PORT)]
                argv = ["--port", self.PORT, "--stages", "A", "--serial-class", STUB_MODULE + ":Stub"]
                # gate still refuses without an attestation
                code, out = self.run_kit(*argv, MPY_SAFE_MODE=value, MPY_REAL_PORT=None)
                self.assertEqual(code, 2, out)
                self.assertIn("REFUSING: this opens a real USB serial port", out)
                self.assert_nothing_touched(out)
                # and goes through with one; MPY_REAL_PORT is irrelevant when safe mode is off
                for real in (None, "auto", "/dev/cu.other"):
                    self.kit.RESULTS[:] = []
                    self.opened[:] = []
                    code, out = self.run_kit(*argv, "--motors-on-acknowledged", MPY_SAFE_MODE=value, MPY_REAL_PORT=real)
                    self.assertEqual(code, 0, out)
                    self.assertEqual(self.opened, [self.PORT], out)

    def test_unset_variable_is_off(self):
        self.rows = [self.known_row(self.PORT)]
        code, out = self.run_kit("--port", self.PORT, "--stages", "A", "--serial-class", STUB_MODULE + ":Stub",
                                 "--motors-on-acknowledged", MPY_SAFE_MODE=None, MPY_REAL_PORT=None)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.opened, [self.PORT])


class SimulatedDryRunTests(KitHarness):
    def test_simulated_with_a_stub_class_is_not_blocked(self):
        code, out = self.run_kit("--port", "/dev/cu.mpy-guard-fake-9", "--stages", "A", "--simulated", "--serial-class",
                                 STUB_MODULE + ":Stub", MPY_SAFE_MODE="1", MPY_REAL_PORT=None)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.opened, ["/dev/cu.mpy-guard-fake-9"])        # the stub, never pyserial

    def test_simulated_does_not_unlock_pyserial_on_a_device_path(self):
        for argv in (["--simulated"], ["--simulated", "--serial-class", "serial:Serial"],
                     ["--simulated", "--serial-class", "serial.serialposix:Serial"]):
            with self.subTest(argv=argv):
                code, out = self.run_kit("--port", "/dev/cu.usbserial-0001", "--stages", "A", *argv,
                                         MPY_SAFE_MODE="1", MPY_REAL_PORT=None)
                self.assertEqual(code, 2, out)
                self.assertEqual(self.loaded_classes, [])

    def test_simulated_is_still_refused_on_a_real_usb_device(self):
        port = "/dev/cu.usbserial-0001"
        self.rows = [self.known_row(port)]
        code, out = self.run_kit("--port", port, "--stages", "A", "--simulated", "--serial-class", STUB_MODULE + ":Stub",
                                 MPY_SAFE_MODE=None)
        self.assertEqual(code, 2, out)
        self.assertIn("REFUSING --simulated on a real USB device", out)
        self.assert_nothing_touched(out)


class SafeModeRefusalFunctionTests(unittest.TestCase):
    """The pure check, mirrored from bridge/link.py safe_mode_check (URL rules of Appendix A.1)."""

    @classmethod
    def setUpClass(cls):
        cls.kit = load_kit()

    def refusal(self, port, **env):
        return self.kit.safe_mode_refusal(port, environ=dict({"MPY_SAFE_MODE": "1"}, **env))

    def test_loopback_urls_the_kit_can_vouch_for(self):
        for url in ("loop://", "socket://127.0.0.1:5000", "socket://127.0.0.1:5000/?logging=debug", "socket://localhost:5000",
                    "socket://LOCALHOST:5000", "socket://[::1]:5000", "rfc2217://127.0.0.1:2217", "socket://127.1.2.3:9"):
            with self.subTest(url=url):
                self.assertIsNone(self.refusal(url))

    def test_urls_that_can_reach_other_hosts_or_real_devices(self):
        for url in ("socket://127.0.0.1@example.com:80", "socket://127.0.0.1:80@example.com:80", "socket://127.0.0.1.evil.example:80",
                    "socket://127.evil.example:80", "socket://example.com:80", "socket://10.0.0.5:80", "rfc2217://192.168.1.2:2217",
                    "spy:///dev/cu.usbserial-0001", "alt:///dev/cu.usbserial-0001", "hwgrep://0403:6001", "cp2110://0",
                    "socket://127.0.0.1:notaport", "socket://127.0.0.1:99999", "socket://", "bogus://127.0.0.1:1", "socket://[::1"):
            with self.subTest(url=url):
                self.assertIsNotNone(self.refusal(url))

    def test_url_equal_to_MPY_REAL_PORT_is_allowed_like_any_port(self):
        self.assertIsNone(self.refusal("spy:///dev/cu.x", MPY_REAL_PORT="spy:///dev/cu.x"))

    def test_ptys_need_registration(self):
        self.assertIsNotNone(self.refusal("/dev/ttys004"))
        self.assertIsNone(self.refusal("/dev/ttys004", MPY_HARNESS_PTYS=os.pathsep.join(["/dev/pts/3", "/dev/ttys004"])))
        self.assertIsNotNone(self.refusal("/dev/ttys005", MPY_HARNESS_PTYS="/dev/ttys004"))
        self.assertIsNotNone(self.refusal("/dev/ttyS0", MPY_HARNESS_PTYS="/dev/ttyS0"))      # not a pty path
        self.assertIsNone(self.kit.safe_mode_refusal("/dev/ttys004", simulated=True, environ={"MPY_SAFE_MODE": "1"}))

    def test_only_exact_match_and_never_auto(self):
        self.assertIsNone(self.refusal("COM3", MPY_REAL_PORT="COM3"))
        self.assertIsNotNone(self.refusal("COM3", MPY_REAL_PORT="com3"))
        self.assertIsNotNone(self.refusal("COM3", MPY_REAL_PORT="auto"))
        self.assertIsNotNone(self.refusal("auto", MPY_REAL_PORT="auto"))
        self.assertIsNotNone(self.refusal("COM3", MPY_REAL_PORT=""))

    def test_off_values_never_refuse(self):
        for value in ("", "0", "false", "no", "off", "OFF", " "):
            self.assertIsNone(self.kit.safe_mode_refusal("COM3", environ={"MPY_SAFE_MODE": value}), value)
        self.assertIsNone(self.kit.safe_mode_refusal("COM3", environ={}))

    def test_same_truthiness_as_the_bridge(self):
        sys.path.insert(0, ROOT)
        try:
            from bridge.link import safe_mode_active as bridge_active
        finally:
            sys.path.remove(ROOT)
        for value in SAFE_MODE_ON_VALUES + SAFE_MODE_OFF_VALUES:
            env = {} if value is None else {"MPY_SAFE_MODE": value}
            self.assertEqual(self.kit.safe_mode_active(env), bridge_active(env), repr(value))

    def test_same_verdict_as_the_bridge_for_urls_the_kit_accepts(self):
        # The kit may be stricter than the bridge (it vouches for fewer URLs), never looser.
        sys.path.insert(0, ROOT)
        try:
            from bridge.link import safe_mode_check
            from bridge.errors import BridgeError
        finally:
            sys.path.remove(ROOT)
        env = {"MPY_SAFE_MODE": "1"}
        for port in ("loop://", "socket://127.0.0.1:5000", "socket://localhost:1", "socket://[::1]:1", "rfc2217://127.0.0.1:1",
                     "socket://example.com:80", "spy:///dev/cu.x", "COM3", "/dev/cu.usbserial-0001", "/dev/ttys004"):
            try:
                safe_mode_check(port, env)
                bridge_allows = True
            except BridgeError:
                bridge_allows = False
            if self.kit.safe_mode_refusal(port, environ=env) is None:
                self.assertTrue(bridge_allows, "kit allows %r but the bridge does not" % port)


class ListChecksAndSnippetsTests(KitHarness):
    def test_list_checks_works_under_safe_mode_and_opens_nothing(self):
        code, out = self.run_kit("--list-checks", MPY_SAFE_MODE="1")
        self.assertEqual(code, 0)
        self.assertIn("| ID | Stage |", out)
        self.assertGreater(out.count("\n"), 10)
        self.assertEqual(self.enumerated, [])
        self.assert_nothing_touched(out)

    def test_show_snippets_works_under_safe_mode_and_every_snippet_passes_audit(self):
        code, out = self.run_kit("--show-snippets", MPY_SAFE_MODE="1")
        self.assertEqual(code, 0)
        for name in self.kit.SNIPPETS:
            self.assertIn("### %s\n" % name, out)
            self.kit.audit(self.kit.SNIPPETS[name])
        self.assert_nothing_touched(out)

    def test_list_checks_and_snippets_ignore_a_port_argument(self):
        for flag in ("--list-checks", "--show-snippets"):
            code, out = self.run_kit(flag, "--port", "COM3", MPY_SAFE_MODE="1")
            self.assertEqual(code, 0, out)
            self.assert_nothing_touched(out)

    def test_audit_still_blocks_resets_and_hardware(self):
        for code in ("import machine\nmachine.reset()", "machine.reset( )", "machine.soft_reset()", "machine.bootloader()",
                     "import esp\nesp.osdebug(None)", "from machine import Pin\nPin(2, Pin.OUT)", "os.remove('/main.py')",
                     "open('/boot.py', 'w')", "motors_begin()", "servo_write(1, 90)", "stop_all()"):
            with self.subTest(code=code):
                with self.assertRaises(RuntimeError):
                    self.kit.audit(code)
        # read-only helpers stay allowed
        self.kit.audit("import machine\nprint(machine.reset_cause())")
        self.kit.audit("print(open('/main.py').read())")


class StandaloneScriptTests(unittest.TestCase):
    """Real subprocess runs: only paths that cannot reach a device (no port, or a path that does not exist)."""

    def run_script(self, *argv, **env):
        e = dict(os.environ)
        e.pop("MPY_REAL_PORT", None)
        e.update(MPY_SAFE_MODE="1")
        e.update(env)
        tmp = tempfile.mkdtemp(prefix="hwkit-guard-sub-")
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, True))
        p = subprocess.run([sys.executable, "-I", "-B", KIT_PATH] + list(argv), cwd=tmp, env=e, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, timeout=60)
        return p.returncode, p.stdout.decode("utf-8", "replace")

    def test_list_checks(self):
        code, out = self.run_script("--list-checks")
        self.assertEqual(code, 0, out)
        self.assertIn("| ID | Stage |", out)

    def test_show_snippets(self):
        code, out = self.run_script("--show-snippets")
        self.assertEqual(code, 0, out)
        self.assertIn("### PROBE", out)

    def test_refuses_a_device_path_under_safe_mode_before_anything_else(self):
        report = os.path.join(tempfile.gettempdir(), "hwkit-guard-never-written.json")
        code, out = self.run_script("--port", "/dev/cu.mpy-guard-nonexistent-9", "--motors-on-acknowledged",
                                    "--force-unknown-adapter", "--stages", "A", "--report", report)
        self.assertEqual(code, 2, out)
        self.assertIn("MPY_SAFE_MODE", out)
        self.assertNotIn("port ", out.split("REFUSING")[0])      # nothing enumerated before the refusal
        self.assertFalse(os.path.exists(report))

    def test_kit_does_not_import_the_bridge(self):
        with open(KIT_PATH, "r", encoding="utf-8") as f:
            text = f.read()
        self.assertNotRegex(text, r"(?m)^\s*(from|import)\s+bridge\b")


if __name__ == "__main__":
    unittest.main()
