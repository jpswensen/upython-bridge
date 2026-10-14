"""tests/test_hwtest.py - the hardware test harness (tools/hwtest/) tested against the FAKE board only.

Nothing here can reach a real device: every guard test uses ``--dry-run`` or an injected ``spawn`` stub (``run_main`` defaults
``spawn`` to a function that fails the test), ``lsof`` is always stubbed, and the only bridge processes are the ones the harness
starts for ``--fake PROFILE`` runs (``socket://127.0.0.1`` fake boards, MPY_SAFE_MODE forced on, no MPY_REAL_PORT).

    export MPY_SAFE_MODE=1; python3.13 -B -m unittest tests.test_hwtest
"""
from __future__ import annotations

import base64
import concurrent.futures
import glob
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

from tests.support import TimedTestCase
from tools.hwtest import confine, phases, run_hw
from tools.hwtest.config import ConfigError, load_config
from tools.hwtest.confine import (ConfinedClient, ConfinementError, Policy, ProgramStore, normalize_device_path, scan_program,
                                  validate_probe_code)
from tools.hwtest.report import Console
from tools.hwtest.tripwire import TRIP_PROBE, Reading, Tripwire, TripwireTripped, evaluate

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HWDIR = os.path.join(ROOT, "tools", "hwtest")
SCRATCH = "/_mpybench_test"
FAKE_REAL_PATH = "/dev/cu.fake-hwtest-0"          # a made-up device name: only ever seen by --dry-run or a stubbed spawn


def forbidden_spawn(port, real_port):
    raise AssertionError("spawn() must not be called in this test (port=%r real_port=%r)" % (port, real_port))


def run_main(argv, spawn=forbidden_spawn, env=None, lsof=None, hooks=None):
    """run_hw.main with the safety rails of this module: stubbed spawn / lsof, injected environment, captured stdout."""
    out = io.StringIO()
    env = {"MPY_SAFE_MODE": "1"} if env is None else dict(env)
    if "--fake" in argv:
        spawn = None
    code = run_hw.main(list(argv), spawn=spawn, environ=env, stdout=out, test_hooks=hooks, lsof=lsof or (lambda p: []))
    return code, out.getvalue()


class TmpMixin(object):
    def tmpdir(self):
        d = tempfile.mkdtemp(prefix="hwtest (t) ")
        self.addCleanup(shutil.rmtree, d, True)
        return d

    def write_cfg(self, data):
        d = self.tmpdir()
        path = os.path.join(d, "cfg.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return path


ACME_CFG = {"backup_files": ["boot.py", "test.py"], "expect": {"impl": "micropython", "version_min": [1, 20, 0]},
            "shadow_names": ["acme", "_acme"], "scratch": SCRATCH, "notes": "generic fake-board config"}


def snapshot(board):
    """Every file and folder under the fake board's root, plus whether a program runs (board state for before/after checks)."""
    root = os.path.dirname(board.host_path("/zz"))
    files, dirs = {}, []
    for d, dnames, names in os.walk(root):
        for n in dnames:
            dirs.append(os.path.relpath(os.path.join(d, n), root))
        for n in names:
            with open(os.path.join(d, n), "rb") as f:
                files[os.path.relpath(os.path.join(d, n), root)] = f.read()
    return {"files": files, "dirs": sorted(dirs), "running": bool(board.program_running)}


class RunResult(object):
    def __init__(self, code, text, report, board, initial, final, base):
        self.code, self.text, self.report, self.board, self.initial, self.final, self.base = code, text, report, board, initial, final, base

    @property
    def left_as_found(self):
        return (self.initial["files"] == self.final["files"] and self.initial["dirs"] == self.final["dirs"])


class FakeRunMixin(TmpMixin):
    """Runs the whole harness against a fake board; the result has the console text, the report and board snapshots taken
    before the bridge connects and after the cleanup (just before the harness stops the fake board)."""

    def fake_run(self, profile="esp32", phases_="A,B,C,D,E", faults=(), cfg=None, hooks=None, soak=(3, 5), extra=()):
        base = self.tmpdir()
        argv = ["--fake", profile, "--phases", phases_, "--report", os.path.join(base, "reports"),
                "--backup-dir", os.path.join(base, "backup"), "--config", self.write_cfg(ACME_CFG if cfg is None else cfg)]
        for f in faults:
            argv += ["--fake-fault", f]
        argv += list(extra)
        box = {}
        h = dict(hooks or {})
        user_on_board, user_before_stop = h.get("on_board"), h.get("before_stop")

        def on_board(b):
            box["board"] = b
            if user_on_board:
                user_on_board(b)
            box["initial"] = snapshot(b)

        def before_stop(b):
            box["final"] = snapshot(b)
            if user_before_stop:
                user_before_stop(b)

        h["on_board"], h["before_stop"] = on_board, before_stop
        h.setdefault("soak", soak)
        code, text = run_main(argv, hooks=h)
        dirs = sorted(glob.glob(os.path.join(base, "reports", "*")))
        report = None
        if dirs:
            with open(os.path.join(dirs[-1], "report.json"), encoding="utf-8") as f:
                report = json.load(f)
        return RunResult(code, text, report, box.get("board"), box.get("initial"), box.get("final"), base)


def pid_alive(pid):
    if not pid or sys.platform == "win32":
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# ===================================================================================================== guards
class GuardTests(TmpMixin, TimedTestCase):
    DEADLINE_S = 60

    def test_classify_port(self):
        env = {"MPY_HARNESS_PTYS": "/dev/ttys042"}
        for port, kind in [("socket://127.0.0.1:5000", "url"), ("socket://localhost:5000", "url"), ("loop://", "url"),
                           ("rfc2217://[::1]:2217", "url"),
                           ("socket://127.0.0.1@example.com:80", "device"), ("socket://example.com:23", "device"),
                           ("socket://127.attacker.example:5", "device"), ("socket://127.1:5", "device"),
                           ("spy:///dev/ttyUSB0", "device"), ("hwgrep://x", "device"),
                           ("/dev/ttys042", "pty"), ("/dev/ttys043", "device"), ("/dev/pts/3", "device"),
                           ("/dev/cu.usbserial-0001", "device"), ("COM3", "device"), ("auto", "invalid"), ("AUTO", "invalid"),
                           ("", "invalid"), ("  ", "invalid")]:
            self.assertEqual(run_hw.classify_port(port, env), kind, port)

    def test_real_port_needs_all_three_guards(self):
        p = FAKE_REAL_PATH
        full = {"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": p}
        cases = [
            (["--port", p], {"MPY_SAFE_MODE": "1"}),                                          # nothing
            (["--port", p, "--allow-real-port"], {"MPY_SAFE_MODE": "1"}),                      # flag only
            (["--port", p], full),                                                             # env only
            (["--port", p, "--allow-real-port"], {"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": p + "x"}),   # env mismatch
            (["--port", p, "--allow-real-port"], {"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": "auto"}),
            (["--port", p, "--allow-real-port"], {"MPY_REAL_PORT": p}),                        # no safe mode
            (["--port", p, "--allow-real-port"], {"MPY_REAL_PORT": p, "MPY_SAFE_MODE": "0"}),
            (["--port", p, "--allow-real-port"], {"MPY_REAL_PORT": p, "MPY_SAFE_MODE": "off"}),
            (["--port", "auto", "--allow-real-port"], {"MPY_REAL_PORT": "auto", "MPY_SAFE_MODE": "1"}),
        ]
        for argv, env in cases:
            for extra in ([], ["--dry-run"]):                     # refused in a dry run too: the plan would not be runnable
                code, text = run_main(argv + extra, env=env)
                self.assertEqual(code, 2, (argv, env, extra, text))
                self.assertIn("REFUSED", text)

    def test_real_port_dry_run_with_all_guards_exits_0_and_spawns_nothing(self):
        p = FAKE_REAL_PATH
        code, text = run_main(["--port", p, "--allow-real-port", "--dry-run"], env={"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": p})
        self.assertEqual(code, 0, text)
        self.assertIn("PLAN", text)
        self.assertIn("REAL DEVICE", text)

    def test_real_port_refused_before_spawn_and_lsof(self):
        calls = []
        code, _t = run_main(["--port", FAKE_REAL_PATH], env={"MPY_SAFE_MODE": "1"}, lsof=lambda p: calls.append(p) or [])
        self.assertEqual(code, 2)
        self.assertEqual(calls, [])

    def test_real_port_with_guards_spawns_with_the_real_port_and_stops_at_a_refused_connect(self):
        """The one 'real' path in the tests: every collaborator is a stub, so no device name is ever opened."""
        p = FAKE_REAL_PATH
        spawned, lsofed = [], []

        class Stub(object):
            pid, alive, hello, shutdown, exit_code = 4242, True, {}, "eof", 0

            def __init__(self):
                self.sent, self._n, self._r = [], 0, {}

            def send(self, op, **a):
                self.sent.append((op, a))
                self._n += 1
                self._r[self._n] = ({"id": self._n, "ok": True, "ports": []} if op == "ports.list" else
                                    {"id": self._n, "ok": False, "error": {"code": "E_NO_DEVICE", "message": "stub", "detail": "", "hint": ""}})
                return self._n

            def result(self, rid, timeout=None):
                return self._r.pop(rid)

            def mark(self):
                return 0

            def events_of(self, ev=None, since=0, **m):
                return []

            def states(self, since=0):
                return []

            def close(self, timeout=8.0):
                self.alive = False
                return 0

        stub = Stub()

        def spawn(port, real_port):
            spawned.append((port, real_port))
            return stub

        base = self.tmpdir()
        code, text = run_main(["--port", p, "--allow-real-port", "--report", base, "--backup-dir", base],
                              spawn=spawn, env={"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": p}, lsof=lambda port: lsofed.append(port) or [])
        self.assertEqual(code, 4, text)
        self.assertEqual(spawned, [(p, p)])
        self.assertEqual(lsofed, [p])
        self.assertEqual([op for op, _a in stub.sent], ["ports.list", "connect"])
        self.assertEqual(stub.sent[1][1], {"port": p})                      # no openPolicy, nothing else

    def test_port_held_by_another_process_refuses_before_spawn(self):
        p = FAKE_REAL_PATH
        code, text = run_main(["--port", p, "--allow-real-port", "--report", self.tmpdir(), "--backup-dir", self.tmpdir()],
                              env={"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": p}, lsof=lambda port: [31337])
        self.assertEqual(code, 4, text)
        self.assertIn("31337", text)

    def test_url_ports_need_no_extra_guards_in_a_dry_run(self):
        for port in ("socket://127.0.0.1:5999", "socket://localhost:5999", "loop://"):
            code, text = run_main(["--port", port, "--dry-run"])
            self.assertEqual(code, 0, (port, text))
        for port in ("socket://example.com:23", "socket://127.0.0.1@example.com:80"):
            code, _t = run_main(["--port", port, "--dry-run"])
            self.assertEqual(code, 2, port)

    def test_registered_pty_is_accepted_unregistered_is_not(self):
        self.assertEqual(run_main(["--port", "/dev/ttys042", "--dry-run"], env={"MPY_SAFE_MODE": "1", "MPY_HARNESS_PTYS": "/dev/ttys042"})[0], 0)
        self.assertEqual(run_main(["--port", "/dev/ttys042", "--dry-run"])[0], 2)

    def test_dry_run_prints_the_plan_and_creates_nothing(self):
        base = self.tmpdir()
        reports = os.path.join(base, "reports")
        cfg = self.write_cfg(ACME_CFG)
        with mock.patch("tools.fakeboard.FakeBoard", side_effect=AssertionError("a dry run must not start a fake board")):
            code, text = run_main(["--fake", "esp32", "--dry-run", "--config", cfg, "--report", reports, "--backup-dir", base])
        self.assertEqual(code, 0, text)
        for needle in ("PLAN", "no bridge spawned", "A  read-only", "E  mirror flows", SCRATCH, "/boot.py", "/test.py", "tripwire",
                       "exit"):
            self.assertIn(needle, text)
        self.assertNotIn("F  soak", text)                                   # F only on request
        self.assertFalse(os.path.exists(reports))
        code, text = run_main(["--fake", "rp2", "--dry-run", "--phases", "C,F"])
        self.assertEqual(code, 0)
        self.assertIn("A  read-only", text)                                 # A always first
        self.assertIn("F  soak", text)

    def test_list_phases_opens_nothing(self):
        with mock.patch("tools.fakeboard.FakeBoard", side_effect=AssertionError("no fake board")):
            code, text = run_main(["--list-phases"])
        self.assertEqual(code, 0)
        for pid in "ABCDEF":
            self.assertRegex(text, r"(?m)^  %s  " % pid)
        self.assertIn("Never sent by any phase", text)
        self.assertIn("scratch-write", text)
        for p in phases.PHASES:
            self.assertTrue(p.classes)

    def test_argument_errors_exit_2(self):
        for argv in (["--dry-run"], ["--fake", "nope", "--dry-run"], ["--fake", "esp32", "--port", "socket://127.0.0.1:1", "--dry-run"],
                     ["--port", "socket://127.0.0.1:1", "--fake-fault", "slow", "--dry-run"], ["--fake", "esp32", "--phases", "Z", "--dry-run"],
                     ["--bogus"]):
            self.assertEqual(run_main(argv)[0], 2, argv)

    def test_bad_config_exits_2_before_anything_starts(self):
        bad = [{"openPolicy": "default"}, {"scratch": "/"}, {"scratch": "/lib"}, {"scratch": "/flash"}, {"scratch": "/lib/_mpybench_x"},
               {"scratch": "/_mpybench_test/../etc"}, {"scratch": "relative"}, {"scratch": "/_mpybench_test/"},
               {"backup_files": "boot.py"}, {"expect": {"version_min": [1, 2]}},
               {"extra_probes": [{"name": "x", "code": "import machine; machine.reset()"}]},
               {"extra_probes": [{"name": "x", "code": "print(__import__('machine').reset_cause())"}]},
               {"shadow_names": [3]}, [], {"notes": 5}]
        for data in bad:
            code, text = run_main(["--fake", "esp32", "--dry-run", "--config", self.write_cfg(data)])
            self.assertEqual(code, 2, (data, text))
            self.assertIn("config", text)
        code, text = run_main(["--fake", "esp32", "--dry-run", "--config", os.path.join(self.tmpdir(), "missing.json")])
        self.assertEqual(code, 2)

    def test_example_style_config_is_accepted(self):
        cfg = {"backup_files": ["boot.py"], "expect": {"impl": "micropython", "build": "ACME_BOARD", "version_min": [1, 29, 0]},
               "extra_probes": [{"name": "counts", "code": "print('@@PROBE', __import__('_acme').get_counts())", "before_after": True}],
               "scratch": "/_mpybench_test", "shadow_names": ["acme", "_acme"], "notes": "n"}
        loaded = load_config(self.write_cfg(cfg))
        self.assertEqual(loaded.backup_files, ["/boot.py"])
        self.assertEqual(loaded.extra_probes[0]["name"], "counts")
        self.assertRaises(ConfigError, load_config, self.write_cfg({"scratch": "/_mpybench_test", "typo_key": 1}))


# ===================================================================================================== confinement
class RecInner(object):
    """Stands in for the BridgeClient: records what would have left the process."""
    pid, alive, hello, shutdown, exit_code = 1, True, {}, "eof", 0

    def __init__(self):
        self.sent, self._n = [], 0

    def send(self, op, **args):
        self.sent.append((op, args))
        self._n += 1
        return self._n

    def result(self, rid, timeout=None):
        return {"id": rid, "ok": True}


class ConfinementTests(TmpMixin, TimedTestCase):
    DEADLINE_S = 60

    def setUp(self):
        self.tmp = self.tmpdir()
        self.store = ProgramStore(os.path.join(self.tmp, "programs"), ["acme"])
        self.policy = Policy(SCRATCH, "socket://127.0.0.1:9", backup_remote=["/boot.py"], local_read_roots=[self.tmp],
                             local_write_roots=[self.tmp], shadow_names=["acme", "_acme"], probe_codes=[TRIP_PROBE], programs=self.store)
        self.inner = RecInner()
        self.client = ConfinedClient(self.inner, self.policy)
        self.local = os.path.join(self.tmp, "up.dat")
        with open(self.local, "wb") as f:
            f.write(b"data")

    def refused(self, op, **args):
        n = len(self.inner.sent)
        with self.assertRaises(ConfinementError, msg="%s %r" % (op, args)):
            self.client.call(op, **args)
        self.assertEqual(len(self.inner.sent), n, "a refused request must not reach the bridge")

    def sent(self, op, **args):
        self.client.call(op, **args)
        return self.inner.sent[-1]

    def test_writes_outside_scratch_are_refused_for_every_writing_op(self):
        outside = ["/x.txt", "/", "/lib/x.py", SCRATCH + "x/a", SCRATCH + ".bak/a", "/other" + SCRATCH + "/a", "/_mpybench",
                   SCRATCH.upper() + "/a.txt", SCRATCH.title() + "/a.txt", "/_MPYBENCH_TEST/a"]
        tricks = [SCRATCH + "/../x.txt", SCRATCH + "/../../x", SCRATCH + "/a/../../x", SCRATCH + "//../x", SCRATCH + "/./../x",
                  "/..", "/../x", SCRATCH + "/a/b/../../../x", "//x", "///", SCRATCH + "/..", SCRATCH + "/a/..//..//y"]
        for path in outside + tricks:
            self.refused("fs.put", local=self.local, remote=path)
            self.refused("fs.rm", path=path)
            self.refused("fs.rmtree", path=path)
            self.refused("fs.mkdir", path=path)
            self.refused("fs.mv", src=path, dst=SCRATCH + "/ok")
            self.refused("fs.mv", src=SCRATCH + "/ok", dst=path)
        self.assertEqual(self.inner.sent, [])

    def test_normalisation_is_what_gets_sent_and_inside_paths_pass(self):
        op, args = self.sent("fs.put", local=self.local, remote=SCRATCH + "//a/./b/../c.txt")
        self.assertEqual(args["remote"], SCRATCH + "/a/c.txt")
        self.assertEqual(self.sent("fs.mkdir", path=SCRATCH)[1]["path"], SCRATCH)
        self.assertEqual(self.sent("fs.rmtree", path=SCRATCH)[1], {"path": SCRATCH, "confirm": True})
        self.assertEqual(self.sent("fs.mv", src=SCRATCH + "/a", dst=SCRATCH + "/b c (1).txt")[1]["dst"], SCRATCH + "/b c (1).txt")
        self.assertEqual(normalize_device_path("/a//b/../c"), "/a/c")
        self.assertEqual(normalize_device_path("/../.."), "/")

    def test_odd_characters_and_fat_traps_are_refused_for_writes(self):
        for bad in (SCRATCH + "/a\x00b", SCRATCH + "/a\nb", SCRATCH + "/a\\b", SCRATCH + "/trailing.", SCRATCH + "/trailing ",
                    SCRATCH + "/... /x", SCRATCH + "/ /x", "relative/x", "", None, 5):
            self.refused("fs.rm", path=bad)
        self.sent("fs.rm", path=SCRATCH + "/ünï (1) 'q'.txt")               # unicode, spaces, parentheses, quotes are fine

    def test_scratch_itself_cannot_be_put_removed_or_moved(self):
        self.refused("fs.rm", path=SCRATCH)
        self.refused("fs.put", local=self.local, remote=SCRATCH)
        self.refused("fs.mv", src=SCRATCH, dst=SCRATCH + "/inside")

    def test_reads_are_allowed_anywhere_but_get_only_of_scratch_and_backups(self):
        for op, args in (("fs.list", {"path": "/"}), ("fs.manifest", {"root": "/", "hash": True}), ("fs.stat", {"path": "/boot.py"}),
                         ("fs.list", {"path": "/lib/../lib"}), ("identity", {}), ("ports.list", {})):
            self.sent(op, **args)
        get_local = os.path.join(self.tmp, "g.dat")
        self.sent("fs.get", remote="/boot.py", local=get_local)
        self.sent("fs.get", remote=SCRATCH + "/f", local=get_local)
        self.refused("fs.get", remote="/main.py", local=get_local)
        self.refused("fs.get", remote="/lib/x.py", local=get_local)
        self.refused("fs.get", remote="/boot.py/../main.py", local=get_local)
        self.refused("fs.get", remote="/boot.py", local="/tmp/outside-the-harness.dat")
        self.refused("fs.put", local="/etc/hosts", remote=SCRATCH + "/h")      # a local file outside the harness folders
        self.refused("fs.put", local=os.path.join(self.tmp, "..", "x"), remote=SCRATCH + "/h")
        self.refused("fs.put", local="relative.dat", remote=SCRATCH + "/h")

    def test_main_and_boot_are_never_written_anywhere(self):
        for name in ("main.py", "boot.py", "MAIN.PY", "Boot.Py", "main.mpy", "boot.mpy"):
            for d in ("", "/sub", "/a/b/c"):
                self.refused("fs.put", local=self.local, remote=SCRATCH + d + "/" + name)
                self.refused("fs.mv", src=SCRATCH + "/ok", dst=SCRATCH + d + "/" + name)
                self.refused("fs.mkdir", path=SCRATCH + d + "/" + name)
            self.refused("fs.put", local=self.local, remote="/" + name)

    def test_shadowing_names_are_refused_at_import_roots_and_allowed_inside_scratch(self):
        for name in ("machine", "os", "sys", "time", "micropython", "gc", "json", "acme", "_acme", "ACME"):
            for root in ("/", "/lib", "/flash", "/flash/lib"):
                self.refused("fs.put", local=self.local, remote=("%s/%s.py" % (root, name)).replace("//", "/"))
                self.refused("fs.mkdir", path=("%s/%s" % (root, name)).replace("//", "/"))
        self.sent("fs.put", local=self.local, remote=SCRATCH + "/machine.py")
        self.sent("fs.put", local=self.local, remote=SCRATCH + "/acme.py")

    def test_reset_ops_unknown_ops_and_forbidden_arguments_are_refused(self):
        for op in ("reset.soft", "reset.hard", "reset.machine", "reset", "reset.soft ", "introspect.modules", "_clean_orphans",
                   "_reconcile", "FS.PUT", "fs.put\n", "", "rm", "exec2", "tty", None):
            self.refused(op)
        self.refused("reset.hard", confirmed=True)
        for op, args in (("fs.list", {"path": "/", "interrupt": True}), ("fs.stat", {"path": "/", "force": True}),
                         ("identity", {"force": True}), ("fs.rmtree", {"path": SCRATCH + "/a", "allowMount": True}),
                         ("fs.rmtree", {"path": SCRATCH + "/a", "confirm": False}), ("fs.manifest", {"root": "/", "background": True}),
                         ("stop", {"reset": True}), ("disconnect", {"stopFirst": "yes"}), ("connect", {"port": "socket://127.0.0.1:9", "vid": 1}),
                         ("fs.put", {"local": self.local, "remote": SCRATCH + "/a", "chunk": 16}), ("ports.list", {"x": 1})):
            self.refused(op, **args)

    def test_connect_only_to_the_configured_port_and_only_with_open_policy_auto(self):
        port = "socket://127.0.0.1:9"
        self.sent("connect", port=port)
        self.sent("connect", port=port, openPolicy="auto")
        self.sent("connect", port=port, baud=115200)
        for pol in ("default", "win-cp210x", "pty", "url", "AUTO", "", None, 1, "v2", "dtr"):
            self.refused("connect", port=port, openPolicy=pol)
        for other in ("/dev/cu.other", "auto", "COM3", port + "0", "socket://127.0.0.1:10"):
            self.refused("connect", port=other)
        self.refused("connect")
        self.refused("connect", port=port, baud=10 ** 9)

    def test_run_executes_only_scanned_harness_programs(self):
        good = self.store.author("ok (1).py", "import time\nprint('hi')\ntime.sleep(0.01)\n")
        self.assertEqual(self.sent("run", local=good.path)[1], {"local": good.path})
        self.refused("run", source="print(1)\n")
        self.refused("run", local=self.local)                                 # a harness file, but not a program
        self.refused("run", local="/etc/hosts")
        self.refused("run", local=os.path.join(self.tmp, "programs", "ok (1).py", "..", "..", "up.dat"))
        self.refused("run")
        os.chmod(good.path, 0o600)                                           # authored files are read-only; a same-user writer can undo that
        with open(good.path, "a") as f:                                      # swapped after authoring
            f.write("import machine\nmachine.reset()\n")
        self.refused("run", local=good.path)
        for name in ("main.py", "boot.py", "x.txt", "../x.py", "a/b.py", ".py", "bad\n.py"):
            with self.assertRaises(ConfinementError):
                self.store.author(name, "print(1)\n")

    def test_program_scanner_refuses_the_spec_list_and_every_import_but_the_allowed_ones(self):
        spec = ["reset", "bootloader", "Pin(", ".Pin", "PWM", "ADC", "DAC", "I2C(", "SPI(", "UART(", "esp.", "esp32.", "network",
                "os.remove", "os.rmdir", "os.rename", "open(", "import " + "sh" + "ield", "import _" + "sh" + "ield", "motor", "servo"]
        for tok in spec + list(confine.FORBIDDEN_PROGRAM_TOKENS):
            text = (tok + "\n") if tok.startswith("import ") else ("x = 1\n# %s\n" % tok)
            self.assertTrue(scan_program(text), tok)
            if not tok.startswith("import "):
                self.assertTrue(scan_program("print('%s')\n" % tok.upper()), tok)
            with self.assertRaises(ConfinementError):
                self.store.author("t.py", text)
        for text in ("import machine\n", "from machine import Pin\n", "import os\n", "import acme\n", "import fancy, sys\n", "from fancy import x\n",
                     "import socket\n", "  import json\n", "x = __import__('os')\n", "exec('1')\n",
                     "print('caf\u00e9')\n", "print(1)\x03\n"):
            self.assertTrue(scan_program(text, ["acme"]), text)
        for text in ("import sys\n", "import time, sys\n", "from time import sleep\n", "import select\nimport sys\n",
                     "while True:\n    pass\n", "print('ok')\nraise ValueError('x')\n", "x = 'acm'\n"):
            self.assertEqual(scan_program(text, ["acme"]), [], text)
        self.assertTrue(scan_program("print('acme here')\n", ["acme"]))       # config shadow_names may not be mentioned either
        from tools.hwtest.programs import PROGRAMS
        for key, (name, text) in PROGRAMS.items():
            self.assertEqual(scan_program(text), [], key)

    def test_exec_accepts_only_registered_probe_code(self):
        self.sent("exec", code=TRIP_PROBE)
        for code in ("import machine; machine.reset()", "print(1)", TRIP_PROBE + " ", "__import__('machine').reset()", "", None,
                     "open('/boot.py','w').write('x')"):
            self.refused("exec", code=code)
        self.refused("exec", code=TRIP_PROBE, interrupt=True)

    def test_probe_validator(self):
        ok = ["print('@@PROBE', __import__('_acme').hook_counts())", "print(__import__('gc').mem_free())",
              "print(__import__('_acme').get_state(), 1 + 2)", "print(__import__('time').ticks_ms())",
              "print(__import__('_acme').version())"]
        bad = ["", "print(1)\nprint(2)", "print(1); print(2)", "import sys", "x = 1", "print(__import__('machine').reset_cause())",
               "print(__import__('os').listdir())", "print(__import__('_acme').motor_on())", "print(__import__('_acme').reset())",
               "print(open('/boot.py').read())", "print(exec('1'))", "print(eval('1'))", "print((lambda: 1)())",
               "print(__import__('_acme')._private)", "print([x for x in range(3)])", "print(f'{1}')", "print(__import__(x))",
               "print(__import__('_acme').set_level(3))", "print('é')", "print(" + "1," * 200 + ")", "print(globals())",
               "print(__import__('network').WLAN())", "print(__import__('esp32').raw_temperature())", "print(1, sep='')"]
        names = ["acme", "_acme", "pkg"]
        for code in ok:
            self.assertEqual(validate_probe_code(code, names), code)
        for code in bad:
            with self.assertRaises(ConfinementError, msg=code):
                validate_probe_code(code, names)
        # review 3: importing a module runs it, so modules are an ALLOWLIST (time, gc, the private _name entries of shadow_names or
        # probe_modules) and main / boot / test / _boot / inisetup and the config's own packages can never be imported
        for code in ("print(__import__('main'))", "print(__import__('boot'))", "print(__import__('test'))", "print(__import__('_boot'))",
                     "print(__import__('acme').version())", "print(__import__('pkg').get_counts())", "print(__import__('_other').get_counts())",
                     "print(__import__('Time').ticks_ms())", "print(__import__('a.b').get_x())"):
            with self.assertRaises(ConfinementError, msg=code):
                validate_probe_code(code, names)
        self.assertEqual(validate_probe_code("print(__import__('_other').get_counts())", names, ["_other"]), "print(__import__('_other').get_counts())")
        with self.assertRaises(ConfinementError):
            validate_probe_code("print(__import__('main').get_x())", names, ["main"])          # probe_modules cannot override the hard deny list
        for name in ("get_counts", "is_ready", "has_x", "hook_counts", "ticks_ms", "mem_free", "boot_info", "unique_id"):
            self.assertTrue(confine.probe_getter_ok(name), name)
        for name in ("sleep_ms", "sleep_us", "delay_ms", "set_state", "set_counts", "clear_counts", "clear_stats", "write_count",
                     "set_id", "read_and_clear", "getsleep", "stop_motor_info", "get_and_clear", "reset", "collect", "get_"):
            self.assertFalse(confine.probe_getter_ok(name), name)

    def test_tty_write_is_printable_text_only_and_only_while_something_runs(self):
        b64 = lambda b: base64.b64encode(b).decode()
        self.refused("tty.write", b64=b64(b"a"))                               # no program, REPL not attached
        self.sent("repl.attach")
        self.sent("tty.write", b64=b64(b"1+2\r"))
        for raw in (b"\t", b"mac\t", b"a\tb", b"\x03", b"a\x03", b"\x04", b"\x01", b"\x02", b"\x05", b"\x1b[A", b"\x18", b"\x7f", b"\xe9", b"", b"x" * 257,
                    b"import machine\r", b"machine.reset()\r", b"__import__('os')\r", b"open('/boot.py')\r"):
            self.refused("tty.write", b64=b64(raw))
        for part in (b"mach", b"ine.res", b"x = __im", b"1+2", b"1+2\rimport os\r", b"open ('/boot.py','w')\r", b"g = open\r"):
            self.refused("tty.write", b64=b64(part))                          # TTY ALLOWLIST: only whole lines of confine.TTY_LINES
        self.refused("tty.write", b64=b64(b"sys.__dict__\r"))
        self.refused("tty.write", b64=b64(b"sys.modules\r"))
        self.refused("tty.write", b64="not base64!")
        self.refused("tty.write")
        self.sent("repl.detach")
        self.refused("tty.write", b64=b64(b"a"))
        good = self.store.author("echo.py", "import sys\nprint(sys.stdin.read(1))\n")
        rid = self.client.send("run", local=good.path)
        self.sent("tty.write", b64=b64(b"abc"))
        for raw in (b"abc\r", b"a.b", b"x" * 17, b"a(b"):
            self.refused("tty.write", b64=b64(raw))                           # a running program only gets letters, digits, spaces
        self.client.result(rid)
        self.refused("tty.write", b64=b64(b"a"))                               # the run ended

    def test_a_phase_may_only_send_its_declared_classes(self):
        for spec in phases.PHASES:
            self.policy.allowed_classes = spec.classes
            for op, klass in confine.OP_CLASSES.items():
                if klass in spec.classes:
                    continue
                n = len(self.inner.sent)
                with self.assertRaises(ConfinementError):
                    self.policy.check(op, {})
                self.assertEqual(len(self.inner.sent), n)
        self.policy.allowed_classes = ("read",)
        self.refused("fs.put", local=self.local, remote=SCRATCH + "/a")
        self.sent("fs.list", path="/")

    def test_client_does_not_expose_raw_access(self):
        for name in ("send_raw", "proc", "stdin", "fail", "request_unchecked"):
            self.assertFalse(hasattr(self.client, name), name)

    def test_scratch_names_are_validated(self):
        for bad in ("/", "", "/lib", "/flash", "/a/b", "/_mpybench_x/..", "/_mpybench_x/", "x", "/lib/_mpybench_x", "/.frozen/_mpybench_x"):
            with self.assertRaises(ConfinementError, msg=bad):
                confine.validate_scratch(bad)
        for good in ("/_mpybench_test", "/flash/_mpybench_test", "/sd/_mpybench_a"):
            self.assertEqual(confine.validate_scratch(good), good)


class SignalTests(TimedTestCase):
    DEADLINE_S = 30

    def test_sigterm_becomes_keyboard_interrupt_so_the_cleanup_runs_under_timeout(self):
        import signal
        import threading
        if threading.current_thread() is not threading.main_thread() or not hasattr(signal, "SIGTERM") or sys.platform == "win32":
            self.skipTest("needs the main thread on POSIX")
        old = run_hw.install_term_handlers()
        self.assertIsNotNone(old)
        try:
            with self.assertRaises(KeyboardInterrupt):
                signal.raise_signal(signal.SIGTERM)
        finally:
            run_hw.restore_term_handlers(old)


class SourceLintTests(TimedTestCase):
    """The harness is generic and can only talk through the confined client."""
    DEADLINE_S = 30

    def sources(self):
        paths = glob.glob(os.path.join(HWDIR, "*.py")) + glob.glob(os.path.join(HWDIR, "*.md"))
        paths.append(os.path.abspath(__file__))
        return paths

    def test_no_board_or_course_specific_strings(self):
        pat = re.compile("|".join(["W" + "SU", "(?i:sh" + "ield)", "(?i:me ?4" + "01)", "(?i:ME 2" + "41)", "(?i:onedr" + "ive)"]))
        for path in self.sources():
            with open(path, encoding="utf-8") as f:
                for n, line in enumerate(f, 1):
                    self.assertIsNone(pat.search(line), "%s:%d: %s" % (path, n, line.strip()))

    def test_only_confine_and_run_hw_touch_the_raw_bridge(self):
        for path in glob.glob(os.path.join(HWDIR, "*.py")):
            name = os.path.basename(path)
            with open(path, encoding="utf-8") as f:
                text = f.read()
            if name not in ("run_hw.py", "confine.py"):
                for bad in ("send_raw", "BridgeClient(", "_inner", ".proc", "Popen", "MPY_REAL_PORT", "openPolicy"):
                    self.assertNotIn(bad, text, "%s uses %s" % (name, bad))
            if name not in ("confine.py",):
                self.assertNotRegex(text, r"""["']reset\.(soft|hard|machine)["']""", name)
                self.assertNotIn("interrupt=True", text)
                self.assertNotIn("force=True", text)


# ===================================================================================================== tripwire
def rd(label, ticks, cause=1, soft=5, t_sent=0.0, t_recv=0.0):
    return Reading(label, ticks, cause, soft, t_sent, t_recv)


class TripwireUnitTests(TimedTestCase):
    DEADLINE_S = 30

    def test_ticks_regression_trips(self):
        prev, cur = rd("p", 100000, t_sent=100.0, t_recv=100.1), rd("c", 5000, t_sent=110.0, t_recv=110.1)
        self.assertTrue(any("backwards" in r for r in evaluate(prev, cur, prev, 0.0, False)))

    def test_ticks_growth_beyond_wall_plus_three_seconds_trips_but_suspension_does_not(self):
        prev = rd("p", 100000, t_sent=100.0, t_recv=100.1)
        jump = rd("c", 100000 + 20000, t_sent=105.0, t_recv=105.1)              # 20 s of ticks in 5 s of wall
        self.assertTrue(any("grew" in r for r in evaluate(prev, jump, prev, 0.0, False)))
        near = rd("c", 100000 + 8000, t_sent=105.0, t_recv=105.1)                # 8 s in 5.0 s: inside wall + 3 s
        self.assertEqual(evaluate(prev, near, prev, 0.0, False), [])
        slow = rd("c", 100000 + 3500, t_sent=105.0, t_recv=105.1)                # 3.5 s in 4.9 s of wall: within the 1.5 s + 1% lag
        self.assertEqual(evaluate(prev, slow, prev, 0.0, False), [])
        restarted = rd("c", 100000 + 1000, t_sent=160.0, t_recv=160.1)           # review 3: 1 s of ticks in 60 s of wall = restarted in between
        self.assertTrue(any("restarted in between" in r for r in evaluate(prev, restarted, prev, 0.0, False)))

    def test_ticks_wrap_is_not_a_regression(self):
        period = 1 << 30
        prev = rd("p", period - 1000, t_sent=100.0, t_recv=100.1)
        cur = rd("c", 1500, t_sent=102.0, t_recv=102.1)
        self.assertEqual(evaluate(prev, cur, prev, 0.0, False), [])

    def test_reset_cause_change_trips_and_soft_cause_is_accepted_after_a_harness_run(self):
        base = rd("b", 50000, cause=1, t_sent=50.0, t_recv=50.1)
        cur = rd("c", 51000, cause=2, t_sent=51.0, t_recv=51.1)
        self.assertTrue(any("reset_cause changed" in r for r in evaluate(base, cur, base, 0.0, False)))
        soft = rd("c", 51000, cause=5, soft=5, t_sent=51.0, t_recv=51.1)
        self.assertTrue(evaluate(base, soft, base, 0.0, False))
        self.assertEqual(evaluate(base, soft, base, 0.0, True), [])
        hard = rd("c", 51000, cause=2, soft=5, t_sent=51.0, t_recv=51.1)
        self.assertTrue(evaluate(base, hard, base, 0.0, True))                     # a hard reset is never expected
        nocause = rd("c", 51000, cause=-1, soft=-1, t_sent=51.0, t_recv=51.1)
        self.assertEqual(evaluate(rd("b", 50000, -1, -1, 50.0, 50.1), nocause, rd("b", 50000, -1, -1, 50.0, 50.1), 0.0, False), [])

    def test_board_younger_than_the_session_trips_at_baseline(self):
        young = rd("c", 1200, t_sent=9.9, t_recv=10.0)                           # 10 s into the session, uptime 1.2 s
        self.assertTrue(any("restarted" in r for r in evaluate(None, young, None, 0.0, False)))
        old = rd("c", 3600000, t_sent=9.9, t_recv=10.0)
        self.assertEqual(evaluate(None, old, None, 0.0, False), [])
        fresh = rd("c", 9900, t_sent=9.9, t_recv=10.0)                           # booted at session start
        self.assertEqual(evaluate(None, fresh, None, 0.0, False, min_uptime_ms=0), [])
        self.assertTrue(any("uptime" in r for r in evaluate(None, fresh, None, 0.0, False)))      # review 3: baseline floor of 60 s

    def test_baseline_soft_cause_trips_only_for_a_young_board(self):
        young = rd("b", 400, cause=5, soft=5, t_sent=0.3, t_recv=0.4)
        self.assertTrue(any("restarted around connect" in r for r in evaluate(None, young, None, 0.0, False)))
        old = rd("b", 7200000, cause=5, soft=5, t_sent=0.3, t_recv=0.4)
        self.assertEqual(evaluate(None, old, None, 0.0, False), [])

    def test_bridge_signals_trip(self):
        class C(object):
            def __init__(self):
                self.reset_errors, self.events, self.out = [], [], "@@TRIP 3600000 1 5\r\n"

            def mark(self):
                return len(self.events)

            def events_of(self, ev=None, since=0, **m):
                return [e for e in self.events[since:] if ev is None or e["ev"] == ev]

            def request(self, op, **a):
                return {"ok": True, "out": self.out}

        c = C()
        t = Tripwire(c)
        t.baseline()
        t.check("fine")
        c.events.append({"ev": "state", "state": "idle", "reason": "board-reset"})
        with self.assertRaises(TripwireTripped) as cm:
            t.check("after event")
        self.assertIn("board-reset", str(cm.exception))
        c2 = C()
        t2 = Tripwire(c2)
        t2.baseline()
        c2.reset_errors.append({"op": "fs.list"})
        with self.assertRaises(TripwireTripped):
            t2.check("after E_BOARD_RESET")
        self.assertEqual(len(t2.trips), 1)


# ===================================================================================================== whole harness on the fake board
class TripwireReviewTests(TimedTestCase):
    """Review 3: a reset whose new ticks stay above the old reading, and a baseline taken after a reset at connect."""
    DEADLINE_S = 30

    def test_restart_with_ticks_above_the_previous_reading_trips(self):
        prev = rd("before", 2600, t_sent=100.0, t_recv=100.1)
        cur = rd("after", 2900, t_sent=130.0, t_recv=130.1)
        self.assertTrue(evaluate(prev, cur, prev, 90.0, False, min_uptime_ms=0))

    def test_restart_at_every_reconnect_trips_against_the_baseline(self):
        base = rd("base", 2900, cause=2, t_sent=3.2, t_recv=3.3)
        r1 = rd("r1", 2910, cause=2, t_sent=4.4, t_recv=4.5)
        r2 = rd("r2", 2920, cause=2, t_sent=5.4, t_recv=5.5)
        self.assertEqual(evaluate(None, base, None, 0.0, False, min_uptime_ms=0), [])
        self.assertEqual(evaluate(base, r1, base, 0.0, False, min_uptime_ms=0), [])
        self.assertTrue(evaluate(r1, r2, base, 0.0, False, min_uptime_ms=0))                  # 2.1 s of wall since the baseline, 20 ms of ticks
        self.assertTrue(evaluate(None, base, None, 0.0, False))                               # and the 60 s floor catches it at once

    def test_the_budget_clamps_every_wait(self):
        from tools.hwtest.confine import DeadlineExceeded
        seen = []

        class Slow(object):
            pid, alive, hello, shutdown, exit_code, default_timeout = 1, True, {}, "eof", 0, 20.0

            def send(self, op, **a):
                return 1

            def result(self, rid, timeout=None):
                seen.append(timeout)
                return {"id": rid, "ok": True}

            def wait_event(self, ev=None, predicate=None, timeout=10.0, since=0):
                seen.append(timeout)

        policy = Policy(SCRATCH, "socket://127.0.0.1:9", probe_codes=[TRIP_PROBE])
        client = ConfinedClient(Slow(), policy)
        client.set_deadline(5.0)
        client.result(1, 300.0)
        client.wait_event("x", None, 60.0)
        self.assertTrue(all(t <= 5.0 for t in seen), seen)
        client.give_up()
        with self.assertRaises(DeadlineExceeded):
            client.send("ping")
        with self.assertRaises(DeadlineExceeded):
            client.result(1, 1.0)


class FakeBoardRunTests(FakeRunMixin, TimedTestCase):
    DEADLINE_S = 300

    def assert_clean(self, r):
        self.assertEqual(r.code, 0, r.text[-3000:])
        self.assertEqual(r.report["outcome"], "PASS", r.text[-1500:])
        self.assertEqual(r.report["residue"], [])
        self.assertEqual(r.board.events.count("hard_reset"), 0)
        self.assertTrue(r.left_as_found, "the board was not left as found: %r -> %r" % (sorted(r.initial["files"]), sorted(r.final["files"])))
        self.assertNotIn(SCRATCH.strip("/"), r.final["dirs"])
        self.assertFalse(r.final["running"])
        self.assertFalse(pid_alive(r.report["bridge"]["pid"]), "the bridge process is still alive")
        self.assertEqual(r.report["bridge"]["shutdown"], "eof")
        for p in r.report["phases"]:
            self.assertEqual(p["status"], "pass", p)

    def test_every_phase_passes_on_four_profiles(self):
        def one(profile):
            cfg = dict(ACME_CFG)
            if profile == "custom-frozen":
                cfg["expect"] = {"impl": "micropython", "build": "ACME_BOARD", "version_min": [1, 29, 0]}
                cfg["extra_probes"] = [{"name": "acme_version", "code": "print('@@PROBE', __import__('_acme').version())", "before_after": True}]
            return self.fake_run(profile, "A,B,C,D,E", cfg=cfg)

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futs = {p: pool.submit(one, p) for p in ("esp32", "rp2", "esp8266", "custom-frozen")}
            results = {p: f.result() for p, f in futs.items()}
        for profile, r in results.items():
            with self.subTest(profile=profile):
                self.assert_clean(r)
                self.assertEqual([p["id"] for p in r.report["phases"]], list("ABCDE"))
                self.assertEqual(r.board.events.count("hard_reset"), 0)
        rep = results["custom-frozen"].report
        values = [e["values"] for e in rep["tripwire"]["extras"] if e["values"]]
        self.assertTrue(values and all("1.2.0" in v["acme_version"] for v in values), rep["tripwire"]["extras"])
        self.assertIn("1.2.0", json.dumps(rep["tripwire"]["readings"]))
        esp8266 = results["esp8266"].report
        self.assertEqual(esp8266["identity"]["caps"]["hash"], "none")
        self.assertTrue(any("n/a" in c["detail"] for p in esp8266["phases"] for c in p["checks"] if "expectSha" in c["name"]))
        rp2 = results["rp2"]
        self.assertEqual({b["name"]: b["status"] for b in rp2.report["backups"]}, {"/boot.py": "absent", "/test.py": "absent"})
        self.assertNotIn("boot.py", rp2.final["files"], "an absent backup file must stay absent (nothing creates boot.py)")
        esp = results["esp32"]
        self.assertEqual({b["name"]: b["status"] for b in esp.report["backups"]}, {"/boot.py": "saved", "/test.py": "absent"})
        self.assertTrue(all(b["verified_unchanged"] for b in esp.report["backups"] if b["status"] == "saved"))
        saved = [b for b in esp.report["backups"] if b["status"] == "saved"][0]
        with open(saved["local"], "rb") as f:
            self.assertEqual(f.read(), esp.initial["files"]["boot.py"])
        self.assertEqual(os.path.dirname(os.path.dirname(saved["local"])), os.path.join(esp.base, "backup"))
        self.assertNotIn("main.py", esp.final["files"])

    def test_optional_soak_phase_f_and_report_schema_and_console(self):
        r = self.fake_run("esp32", "F", soak=(3, 6))
        self.assert_clean(r)
        report = r.report
        self.assertEqual([p["id"] for p in report["phases"]], ["A", "F"])           # A always first
        self.assertEqual(report["phases"][1]["metrics"]["soak_ops"], 24)
        for key in ("schema", "outcome", "exit_code", "tripped", "started_utc", "finished_utc", "elapsed_s", "mode", "port",
                    "phases_requested", "argv", "config", "refused", "trip", "identity", "phases", "tripwire", "backups", "scratch",
                    "cleanup", "ops", "bridge", "residue", "notes"):
            self.assertIn(key, report)
        self.assertEqual(report["schema"], "mpy-hwtest-report/1")
        self.assertEqual(report["mode"], "fake:esp32")
        self.assertEqual(report["notes"], "generic fake-board config")
        self.assertFalse(report["tripped"])
        self.assertTrue(report["scratch"]["created"] and report["scratch"]["removed"] and not report["scratch"]["residue"])
        for ph in report["phases"]:
            for key in ("id", "name", "status", "elapsed_s", "classes", "checks", "metrics"):
                self.assertIn(key, ph)
            for ch in ph["checks"]:
                self.assertEqual(set(ch), {"name", "ok", "detail"})
        self.assertEqual(set(report["tripwire"]), {"baseline", "readings", "trips", "extras"})
        self.assertEqual(set(report["tripwire"]["baseline"]), {"label", "ticks_ms", "reset_cause", "soft_reset_const", "extras"})
        self.assertGreaterEqual(len(report["tripwire"]["readings"]), 5)
        self.assertEqual(set(report["ops"]), {"total", "by_class", "errors", "log"})
        self.assertTrue(set(report["ops"]["by_class"]) <= set(confine.OP_CLASS_NAMES))
        self.assertTrue(all(e["op"] in confine.OP_CLASSES for e in report["ops"]["log"]))
        self.assertFalse([e for e in report["ops"]["log"] if e["op"].startswith("reset")])
        self.assertEqual([s["name"] for s in report["cleanup"]["steps"] if not s["ok"]], [])
        reports = glob.glob(os.path.join(r.base, "reports", "*"))
        self.assertEqual(len(reports), 1)
        self.assertRegex(os.path.basename(reports[0]), r"^\d{8}T\d{6}Z$")
        with open(os.path.join(reports[0], "console.txt"), encoding="utf-8") as f:
            lines = f.read().splitlines()
        self.assertTrue(lines and all(re.match(r"^\d\d:\d\d:\d\d\.\d{3} \+ *\d+\.\d+s ", ln) for ln in lines), lines[:3])
        self.assertIn("RESULT: PASS (exit 0)", lines[-1])
        self.assertLess(len(lines), 400, "console output should stay concise")

    def test_unix_like_and_native_usb_profiles_also_pass_phases_a_to_d(self):
        for profile in ("unix-like", "esp32s3-usb"):
            with self.subTest(profile=profile):
                self.assert_clean(self.fake_run(profile, "A,B,C,D"))

    def test_only_harness_programs_and_probes_reach_the_board_and_no_resets(self):
        r = self.fake_run("esp32", "A,C")
        self.assert_clean(r)
        self.assertTrue(r.board.events.of("exec"))
        ops = {e["op"] for e in r.report["ops"]["log"]}
        self.assertTrue(ops <= set(confine.OP_CLASSES))
        self.assertIn("run", ops)
        self.assertNotIn("fs.put", ops)                                           # phase C writes nothing to the board

    def test_identity_mismatch_refuses_with_exit_4_and_touches_nothing(self):
        cfg = dict(ACME_CFG, expect={"impl": "micropython", "build": "SOME_OTHER_BOARD"})
        r = self.fake_run("esp32", "A,B,C,D,E", cfg=cfg)
        self.assertEqual(r.code, 4, r.text[-1500:])
        self.assertEqual(r.report["outcome"], "REFUSED")
        self.assertIn("build", r.report["refused"]["reason"])
        self.assertTrue(r.left_as_found)
        self.assertEqual(r.report["backups"], [])                                 # nothing was even backed up
        self.assertEqual([p["id"] for p in r.report["phases"]], ["A"])
        self.assertEqual(r.board.events.count("soft_reset"), 0)

    def test_phase_a_refuses_when_the_board_is_running_a_program_and_leaves_it_alone(self):
        r = self.fake_run("esp32", "A,B", faults=["main_forever"])
        self.assertEqual(r.code, 4, r.text[-1500:])
        self.assertEqual(r.report["outcome"], "REFUSED")
        self.assertIn("not at an idle", r.report["refused"]["reason"])
        self.assertEqual(r.board.events.count("interrupt"), 0, "no Ctrl-C may be sent")
        self.assertEqual(r.board.events.count("soft_reset") + r.board.events.count("hard_reset"), 0)
        self.assertTrue(r.final["running"], "the program that was running must still run")
        self.assertTrue(r.left_as_found)
        self.assertNotIn("run", {e["op"] for e in r.report["ops"]["log"]})
        self.assertEqual([p["id"] for p in r.report["phases"]], ["A"])

    def test_an_existing_scratch_folder_is_never_touched(self):
        def on_board(board):
            board.write_file(SCRATCH + "/keep.txt", b"not ours")
        r = self.fake_run("esp32", "A,B", hooks={"on_board": on_board})
        self.assertEqual(r.code, 4, r.text[-1500:])
        self.assertIn("already exists", r.report["refused"]["reason"])
        self.assertEqual(r.final["files"][SCRATCH.strip("/") + "/keep.txt"], b"not ours")
        self.assertTrue(r.left_as_found)


class TripwireIntegrationTests(FakeRunMixin, TimedTestCase):
    DEADLINE_S = 180

    def test_reset_on_connect_trips_exit_3_and_cleans_up(self):
        r = self.fake_run("esp32", "A,B", faults=["reset_on_connect"])
        self.assertEqual(r.code, 3, r.text[-1500:])
        self.assertEqual(r.report["outcome"], "TRIPPED")
        self.assertTrue(r.report["tripped"])
        self.assertTrue(r.report["trip"]["reasons"])
        self.assertIn("TRIPPED", r.text)
        self.assertEqual(r.report["phases"][0]["status"], "fail")
        self.assertTrue(r.left_as_found)
        self.assertFalse(pid_alive(r.report["bridge"]["pid"]))
        self.assertNotIn("fs.put", {e["op"] for e in r.report["ops"]["log"]})     # no hardware work after the trip

    def test_fake_ticks_regression_trips_exit_3(self):
        def after_phase(pid, board):
            if pid == "A":
                board.device.t_power = time.monotonic()                            # ticks_ms starts over, like a power cycle
        r = self.fake_run("esp32", "A,E", hooks={"after_phase": after_phase})
        self.assertEqual(r.code, 3, r.text[-1500:])
        self.assertEqual(r.report["outcome"], "TRIPPED")
        self.assertTrue(any("ticks_ms" in x for x in r.report["trip"]["reasons"]), r.report["trip"])
        self.assertFalse(r.report["scratch"]["created"])                           # phase E never wrote anything
        self.assertNotIn("fs.put", {e["op"] for e in r.report["ops"]["log"]})
        self.assertTrue(r.left_as_found)
        self.assertFalse(pid_alive(r.report["bridge"]["pid"]))

    def test_trip_in_the_middle_of_a_phase_still_removes_scratch(self):
        state = {"puts": 0}

        def on_board(board):
            state["board"] = board

        def on_send(op, args):
            if op == "fs.put":
                state["puts"] += 1
                if state["puts"] == 5:                                           # a chip reset in the middle of phase E
                    state["board"].device.t_power = time.monotonic()
                    state["board"].device.reset_cause = 2
        r = self.fake_run("esp32", "A,E", hooks={"on_board": on_board, "on_send": on_send})
        self.assertEqual(r.code, 3, r.text[-1500:])
        self.assertTrue(r.report["scratch"]["created"])
        self.assertTrue(r.report["scratch"]["removed"], r.report["cleanup"])
        self.assertEqual(r.report["residue"], [])
        self.assertTrue(r.left_as_found)
        self.assertEqual(r.board.events.count("hard_reset"), 0)

    def test_a_fake_hard_reset_is_noticed(self):
        def after_phase(pid, board):
            if pid == "A":
                board.hard_reset("test")
        r = self.fake_run("esp32", "A,E", hooks={"after_phase": after_phase})
        self.assertEqual(r.code, 3, r.text[-1500:])
        self.assertEqual(r.report["outcome"], "TRIPPED")
        self.assertFalse(pid_alive(r.report["bridge"]["pid"]))
        self.assertNotIn("fs.put", {e["op"] for e in r.report["ops"]["log"]})


class CleanupTests(FakeRunMixin, TimedTestCase):
    DEADLINE_S = 180

    def _inject(self, exc_factory, at=3):
        state = {"puts": 0}

        def on_send(op, args):
            if op == "fs.put":
                state["puts"] += 1
                if state["puts"] == at:
                    raise exc_factory()
        return {"on_send": on_send}

    def check_cleaned(self, r):
        self.assertTrue(r.report["scratch"]["created"])
        self.assertTrue(r.report["scratch"]["removed"], r.report["cleanup"])
        self.assertTrue(r.left_as_found, "scratch folder or other changes left on the board")
        self.assertTrue(all(b["verified_unchanged"] for b in r.report["backups"] if b["status"] == "saved"))
        self.assertFalse(pid_alive(r.report["bridge"]["pid"]))
        self.assertEqual(r.report["bridge"]["shutdown"], "eof")
        self.assertIn("remove the scratch folder", [s["name"] for s in r.report["cleanup"]["steps"]])

    def test_cleanup_runs_after_an_injected_exception(self):
        r = self.fake_run("esp32", "A,B", hooks=self._inject(lambda: RuntimeError("injected failure")))
        self.assertEqual(r.code, 1, r.text[-1500:])
        self.assertEqual(r.report["outcome"], "ERROR")
        self.assertIn("injected failure", r.text)
        self.check_cleaned(r)

    def test_cleanup_runs_after_keyboard_interrupt(self):
        r = self.fake_run("esp32", "A,B", hooks=self._inject(KeyboardInterrupt))
        self.assertEqual(r.code, 130, r.text[-1500:])
        self.assertEqual(r.report["outcome"], "INTERRUPTED")
        self.check_cleaned(r)

    def test_cleanup_stops_a_running_harness_program(self):
        state = {}

        def on_send(op, args):
            if op == "stop" and "n" not in state:
                state["n"] = 1                                                     # the first Stop of phase C fails right after the loop started
                raise RuntimeError("injected during the stop")
        r = self.fake_run("esp32", "A,C", hooks={"on_send": on_send})
        self.assertEqual(r.code, 1, r.text[-1500:])
        self.assertFalse(r.final["running"], "the harness loop program must have been stopped by the cleanup")
        steps = {s["name"]: s for s in r.report["cleanup"]["steps"]}
        self.assertTrue(steps["stop any harness program"]["ok"])
        self.assertFalse(pid_alive(r.report["bridge"]["pid"]))
        self.assertEqual(r.report["residue"], [])


if __name__ == "__main__":
    unittest.main()
