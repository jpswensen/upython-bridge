"""Adversarial review 3, focus "confinement-breaker" for tools/hwtest/.

Every test asserts the SAFE behaviour; a failing test is a reproduced finding.  Nothing here opens a port: the Policy/ConfinedClient
tests use a recording stand-in for the bridge client, the guard tests use --dry-run or a spawn stub that raises, and the end-to-end
tests only talk to the harness's own in-process fake board over socket://127.0.0.1.

    export MPY_SAFE_MODE=1; python3.13 -B -m unittest tests.adversarial3.test_confinement_breaker
"""
from __future__ import annotations

import base64
import io
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from tests.support import TimedTestCase
from tests.test_hwtest import ACME_CFG, FakeRunMixin
from tools.hwtest import confine, run_hw
from tools.hwtest.config import ConfigError, validate_config
from tools.hwtest.confine import (ConfinedClient, ConfinementError, Policy, ProgramStore, scan_program, validate_probe_code)
from tools.hwtest.tripwire import TRIP_PROBE

SCRATCH = "/_mpybench_test"
PORT = "socket://127.0.0.1:9"
REAL = "/dev/cu.fake-adv3-0"                 # made-up name: only ever seen by --dry-run or a raising spawn stub
HWDIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tools", "hwtest")


class Rec(object):
    pid, alive, hello, shutdown, exit_code = 1, True, {}, "eof", 0

    def __init__(self):
        self.sent, self._n = [], 0
        self.on_send_read = None

    def send(self, op, **args):
        self.sent.append((op, args))
        self._n += 1
        return self._n

    def result(self, rid, timeout=None):
        return {"id": rid, "ok": True}


class PolicyEnv(object):
    def __init__(self, tc, backups=("/boot.py",)):
        self.tmp = tempfile.mkdtemp(prefix="adv3 (c) ")
        tc.addCleanup(shutil.rmtree, self.tmp, True)
        self.backup = os.path.join(self.tmp, "backup")
        os.makedirs(self.backup)
        self.src = os.path.join(self.tmp, "src.bin")
        with open(self.src, "wb") as f:
            f.write(b"x")
        self.store = ProgramStore(os.path.join(self.tmp, "programs"), ["acme"])
        self.rec = Rec()
        self.policy = Policy(SCRATCH, PORT, backup_remote=list(backups), local_read_roots=[self.tmp],
                             local_write_roots=[self.tmp, self.backup], shadow_names=["acme"], probe_codes=[TRIP_PROBE],
                             programs=self.store)
        self.client = ConfinedClient(self.rec, self.policy)

    def tty(self, text):
        self.client.send("tty.write", b64=base64.b64encode(text.encode("ascii")).decode("ascii"))


def b64(raw):
    return base64.b64encode(raw).decode("ascii")


# ===================================================================================================== path confinement
EVIL_PATHS = [
    "/", "/boot.py", "/main.py", "/lib/x.py", "/machine.py", "/_mpybench_test", "/_mpybench_test/", "/_mpybench_test//",
    "/_mpybench_test/..", "/_mpybench_test/../boot.py", "/_mpybench_test/../../boot.py", "/_mpybench_test/x/../../boot.py",
    "/_mpybench_test/./../boot.py", "//_mpybench_test/../boot.py", "/./_mpybench_test/../boot.py", "///", "/..", "/../..",
    "/_mpybench_test/x/../../../../../boot.py", "/_mpybench_test/x/..//..//boot.py",
    "/_MPYBENCH_TEST/x", "/_Mpybench_Test/main.py", "/_mpybench_testX", "/_mpybench_testX/x", "/_mpybench_test_evil/x",
    "/_mpybench_test.evil/x", "/_mpybench_tes/x", "/_mpybench/x", "_mpybench_test/x", "./_mpybench_test/x", "../_mpybench_test/x",
    "/_mpybench_test\x00/../boot.py", "/_mpybench_test/x\x00", "/_mpybench_test/x\n", "/_mpybench_test/x\r../boot.py",
    "/_mpybench_test/\x7f", "/_mpybench_test/\\..\\boot.py", "\\_mpybench_test\\x", "/_mpybench_test\\..\\boot.py",
    "/_mpybench_test\uff0f..\uff0fboot.py", "/_mpybench_test/\u2025/boot.py", "/_mpybench_test/\uff0e\uff0e/boot.py",
    "/_mpybench_test/%2e%2e/boot.py", "/_mpybench_test/..%2fboot.py", "/_mpybench_test/x/", "/_mpybench_test/x/.",
    "/_mpybench_test/main.py", "/_mpybench_test/MAIN.PY", "/_mpybench_test/Main.Py", "/_mpybench_test/main.py/",
    "/_mpybench_test/main.py ", "/_mpybench_test/main.py.", "/_mpybench_test/main.py. .", "/_mpybench_test/boot.py",
    "/_mpybench_test/sub/boot.PY", "/_mpybench_test/main.mpy", "/_mpybench_test/ main.py", "/_mpybench_test/main.py\t",
    "/_mpybench_test/ ", "/_mpybench_test/.", "/_mpybench_test/ ./x", "/_mpybench_test/x /y", "/_mpybench_test/.../boot.py",
    "/_mpybench_test/" + "a" * 5000, "/_mpybench_test/" + "../" * 5000 + "boot.py", "/" + "a/" * 20000 + "x",
    "/_mpybench_test/x" + "/.." * 3 + "/main.py",
]
NON_STRINGS = [None, 0, 1, True, [], ["/_mpybench_test/x"], {}, {"p": "/_mpybench_test/x"}, b"/_mpybench_test/x", bytearray(b"/x"),
               ("/_mpybench_test/x",), 1.5, object()]
WRITE_SPECS = [("fs.rm", "path"), ("fs.rmtree", "path"), ("fs.mkdir", "path"), ("fs.put", "remote"), ("fs.mv", "src"), ("fs.mv", "dst")]
PATH_KEYS = ("path", "remote", "src", "dst")


def build_args(env, op, key, value):
    args = {key: value}
    if op == "fs.put":
        args["local"] = env.src
    if op == "fs.mv":
        args.setdefault("src", SCRATCH + "/a")
        args.setdefault("dst", SCRATCH + "/b")
    return args


def sent_path_problems(op, args):
    out = []
    for key in PATH_KEYS:
        if key not in args:
            continue
        p = args[key]
        if not isinstance(p, str):
            out.append("%s.%s is %r" % (op, key, p))
            continue
        parts = p.split("/")
        ok = (p.startswith(SCRATCH + "/") or (p == SCRATCH and op in ("fs.mkdir", "fs.rmtree")))
        ok = ok and ".." not in parts and "." not in parts and "" not in parts[1:] and not re.search(r"[\x00-\x1f\x7f\\]", p)
        ok = ok and parts[-1].lower() not in confine.PROTECTED_BASENAMES and parts[-1] == parts[-1].rstrip(". ")
        if not ok:
            out.append("%s.%s=%r" % (op, key, p[:80]))
    return out


class PathConfinementTests(TimedTestCase):
    DEADLINE_S = 60

    def test_write_ops_never_leave_scratch(self):
        env = PolicyEnv(self)
        leaks, odd = [], []
        for path in EVIL_PATHS:
            for op, key in WRITE_SPECS:
                before = len(env.rec.sent)
                try:
                    env.client.send(op, **build_args(env, op, key, path))
                except ConfinementError:
                    continue
                except Exception as exc:                                    # noqa: BLE001
                    odd.append((op, key, path[:40], type(exc).__name__))
                    continue
                for sop, sargs in env.rec.sent[before:]:
                    leaks += sent_path_problems(sop, sargs)
        self.assertEqual(leaks, [], "write op reached the bridge with a path outside scratch / protected name")
        self.assertEqual(odd, [])

    def test_non_string_paths_never_sent(self):
        env = PolicyEnv(self)
        odd = []
        for value in NON_STRINGS:
            for op, key in WRITE_SPECS + [("fs.get", "remote"), ("fs.list", "path"), ("fs.stat", "path"), ("fs.manifest", "root")]:
                args = build_args(env, op, key, value)
                if op == "fs.get":
                    args["local"] = os.path.join(env.tmp, "o")
                if op == "fs.manifest":
                    pass
                before = len(env.rec.sent)
                try:
                    env.client.send(op, **args)
                except ConfinementError:
                    continue
                except Exception as exc:                                    # noqa: BLE001
                    odd.append((op, key, repr(value)[:30], type(exc).__name__))
                    continue
                self.fail("non-string %r accepted for %s.%s: %r" % (value, op, key, env.rec.sent[before:]))
        self.assertEqual(odd, [], "refused, but not with ConfinementError")

    def test_mv_either_side_outside_is_refused(self):
        env = PolicyEnv(self)
        for src, dst in [(SCRATCH + "/a", "/main.py"), ("/boot.py", SCRATCH + "/a"), (SCRATCH + "/a", SCRATCH + "/../boot.py"),
                         (SCRATCH, SCRATCH + "/a"), (SCRATCH + "/a", SCRATCH), (SCRATCH + "/a", SCRATCH + "/main.py"),
                         (SCRATCH + "/a", "/lib/machine.py")]:
            with self.assertRaises(ConfinementError, msg=(src, dst)):
                env.client.send("fs.mv", src=src, dst=dst)
        self.assertEqual(env.rec.sent, [])

    def test_positive_control(self):
        env = PolicyEnv(self)
        env.client.send("fs.put", remote=SCRATCH + "/a/../b.txt", local=env.src)
        env.client.send("fs.mkdir", path=SCRATCH)
        env.client.send("fs.list", path="/lib/../")
        self.assertEqual(env.rec.sent[0][1]["remote"], SCRATCH + "/b.txt")        # the NORMALISED path is what is sent
        self.assertEqual(env.rec.sent[2][1]["path"], "/")

    def test_fs_get_only_scratch_or_backup(self):
        env = PolicyEnv(self)
        out = os.path.join(env.tmp, "o")
        for remote in ["/main.py", "/boot.py/../main.py", "/lib/x", SCRATCH, SCRATCH + "/../main.py", "/", "/etc/../boot.py/."]:
            if remote in ("/boot.py/../main.py", "/etc/../boot.py/."):
                pass
            try:
                env.client.send("fs.get", remote=remote, local=out)
            except ConfinementError:
                continue
            got = env.rec.sent[-1][1]["remote"]
            self.assertTrue(got.startswith(SCRATCH + "/") or got == "/boot.py", (remote, got))

    def test_local_paths_stay_in_harness_folders(self):
        env = PolicyEnv(self)
        outside = tempfile.mkdtemp(prefix="adv3 outside ")
        self.addCleanup(shutil.rmtree, outside, True)
        secret = os.path.join(outside, "secret.txt")
        with open(secret, "w") as f:
            f.write("s")
        link = os.path.join(env.tmp, "link.txt")
        os.symlink(secret, link)
        linkdir = os.path.join(env.tmp, "linkdir")
        os.symlink(outside, linkdir)
        for local in [secret, link, os.path.join(linkdir, "secret.txt"), os.path.join(env.tmp, "..", os.path.basename(outside), "secret.txt"),
                      env.tmp + "-evil/x", "relative.txt", "", None, 5, env.src + "\x00", "/etc/passwd"]:
            with self.assertRaises(ConfinementError, msg=repr(local)):
                env.client.send("fs.put", remote=SCRATCH + "/x", local=local)
        for local in [os.path.join(linkdir, "new.txt"), os.path.join(env.tmp, "..", "escape.txt"), "/etc/hosts", env.tmp + "x/y"]:
            with self.assertRaises(ConfinementError, msg=repr(local)):
                env.client.send("fs.get", remote=SCRATCH + "/x", local=local)


# ===================================================================================================== op / argument allowlist
class OpAllowlistTests(TimedTestCase):
    DEADLINE_S = 60

    def bad_requests(self, env):
        out = os.path.join(env.tmp, "o")
        bad = [(op, {}) for op in ["reset.soft", "reset.hard", "reset.machine", "reset", "RESET.SOFT", " reset.soft", "reset\x00",
                                   "Reset.soft", "introspect.modules", "introspect", "fs", "fs.", "fs.put ", "FS.PUT", "exec ", "Exec",
                                   "run2", "tty", "ports", "mip.install", "mount", "sync", "flash", "erase", "", "reset_soft"]]
        bad += [(None, {}), (b"fs.list", {"path": "/"}), (["fs.list"], {}), (5, {})]
        bad += [("exec", {"code": c}) for c in ["import machine; machine.reset()", "print(1)", TRIP_PROBE + " ", " " + TRIP_PROBE,
                                                 TRIP_PROBE + "\n", TRIP_PROBE.replace("@@TRIP", "@@TRIX"), [TRIP_PROBE], None, 5,
                                                 {"a": 1}, b"print(1)"]]
        bad += [("exec", {"code": TRIP_PROBE, "interrupt": True}), ("exec", {"code": TRIP_PROBE, "background": True}),
                ("exec", {"code": TRIP_PROBE, "timeoutMs": 10 ** 9}), ("exec", {"code": TRIP_PROBE, "timeoutMs": True}),
                ("exec", {"code": TRIP_PROBE, "timeoutMs": "100"}), ("exec", {"code": TRIP_PROBE, "force": True}), ("exec", {})]
        for pol in ["v2", "v3", "V4", "AUTO", "auto ", " auto", "", None, ["auto"], True, 0, {"a": 1}, "dtr", "rts", "pulse", "reset",
                    "pyserial", "hard"]:
            bad.append(("connect", {"port": PORT, "openPolicy": pol}))
        bad += [("connect", dict(port=PORT, **extra)) for extra in
                [{"reset": True}, {"interrupt": True}, {"force": True}, {"dtr": False}, {"rts": True}, {"resetOnConnect": True},
                 {"baud": 1}, {"baud": 10 ** 10}, {"baud": True}, {"baud": "115200"}, {"vid": 1}, {"pid": 2}, {"stopFirst": True}]]
        bad += [("connect", {"port": p}) for p in ["auto", "AUTO", "/dev/cu.usbserial-0001", PORT + " ", " " + PORT, PORT.upper(),
                                                   "socket://127.0.0.1:9@evil", "", None, 5, ["x"], "COM3", "loop://"]]
        bad += [("connect", {}), ("connect", {"openPolicy": "auto"})]
        bad += [("config", {"safeMode": False}), ("config", {"shadowGuard": "machine"}), ("config", {"shadowGuard": ["../x"]}),
                ("config", {"shadowGuard": [""]}), ("config", {"shadowGuard": [1]}), ("config", {"resetPolicy": "hard"}),
                ("config", {"shadowGuard": ["x"] * 201})]
        bad += [("disconnect", {"stopFirst": 1}), ("disconnect", {"stopFirst": "true"}), ("disconnect", {"reset": True}),
                ("stop", {"force": True}), ("stop", {"interrupt": True}), ("stop", {"timeoutMs": 5}), ("stop", {"timeoutMs": 10 ** 9}),
                ("stop", {"reset": True}), ("cancel", {}), ("cancel", {"target": -1}), ("cancel", {"target": "1"}),
                ("cancel", {"target": True}), ("cancel", {"target": 2 ** 40})]
        bad += [("run", {"source": "print(1)"}), ("run", {"source": "import machine"}), ("run", {"local": "/etc/passwd"}),
                ("run", {"local": "relative.py"}), ("run", {"local": None}), ("run", {}), ("run", {"local": env.src}),
                ("run", {"local": env.src, "interrupt": True}), ("run", {"local": env.src, "reset": True})]
        bad += [("fs.rmtree", {"path": SCRATCH + "/x", "confirm": c}) for c in [False, "yes", 1, None, "true", 0]]
        bad += [("fs.rmtree", {"path": SCRATCH + "/x", "allowMount": True}), ("fs.rmtree", {"path": SCRATCH + "/x", "force": True}),
                ("fs.rm", {"path": SCRATCH + "/x", "force": True}), ("fs.rm", {"path": SCRATCH + "/x", "recursive": True}),
                ("fs.mkdir", {"path": SCRATCH + "/a", "interrupt": True}), ("fs.mkdir", {"path": SCRATCH + "/a", "parents": 1}),
                ("fs.put", {"remote": SCRATCH + "/a", "local": env.src, "interrupt": True}),
                ("fs.put", {"remote": SCRATCH + "/a", "local": env.src, "mkdirs": "yes"}),
                ("fs.put", {"remote": SCRATCH + "/a", "local": env.src, "expectSha": "A" * 64}),
                ("fs.put", {"remote": SCRATCH + "/a", "local": env.src, "expectSha": "a" * 63}),
                ("fs.put", {"remote": SCRATCH + "/a", "local": env.src, "expectSha": None}),
                ("fs.put", {"remote": SCRATCH + "/a", "local": env.src, "shadowGuard": []}),
                ("fs.put", {"remote": SCRATCH + "/a", "local": env.src, "mode": 0o777}),
                ("fs.get", {"remote": SCRATCH + "/a", "local": out, "interrupt": True}),
                ("fs.list", {"path": "/", "interrupt": True}), ("fs.stat", {"path": "/", "interrupt": True}),
                ("identity", {"interrupt": True}), ("identity", {"refresh": True}), ("repl.attach", {"x": 1}), ("shutdown", {"y": 1}),
                ("ping", {"reset": 1}), ("ports.list", {"open": True}), ("fs.manifest", {"root": "/", "interrupt": True}),
                ("fs.manifest", {"root": "/", "exclude": 5}), ("fs.manifest", {"root": "/", "exclude": [5]}),
                ("fs.manifest", {"root": "/", "hash": "yes"})]
        for raw in [b"\x03", b"\x04", b"\x01", b"\x02", b"\x05", b"\x1b", b"\t", b"\x08", b"\x7f", b"\x00", b"\xe9", b"a\x03b",
                    b"a" * 257, b""]:
            bad.append(("tty.write", {"b64": b64(raw)}))
        bad += [("tty.write", {"b64": "!!!"}), ("tty.write", {"b64": None}), ("tty.write", {"b64": 5}), ("tty.write", {}),
                ("tty.write", {"b64": b64(b"1")}),                                   # no run, no REPL: refused
                ("tty.write", {"b64": b64(b"1"), "hold": True})]
        return bad

    def test_everything_off_list_is_refused_and_not_sent(self):
        env = PolicyEnv(self)
        survivors, odd = [], []
        for op, args in self.bad_requests(env):
            n = len(env.rec.sent)
            try:
                env.client.send(op, **args) if isinstance(op, str) else env.client.send(op, **args)
            except ConfinementError:
                continue
            except Exception as exc:                                            # noqa: BLE001
                odd.append((op, sorted(args), type(exc).__name__))
                continue
            survivors.append((op, args, env.rec.sent[n:]))
        self.assertEqual([(o, a) for o, a, _ in survivors], [], "accepted although it must be refused")
        self.assertEqual(env.rec.sent, [])
        self.assertEqual(odd, [], "refused with a non-ConfinementError exception (phases only catch ConfinementError)")

    def test_tty_write_even_when_run_active_never_control(self):
        env = PolicyEnv(self)
        env.policy.repl_attached = True
        for raw in [b"\x03", b"\x04", b"\x1b[A", b"\t", b"\x08"]:
            with self.assertRaises(ConfinementError):
                env.client.send("tty.write", b64=b64(raw))
        self.assertEqual(env.rec.sent, [])

    def test_class_restriction_per_phase(self):
        env = PolicyEnv(self)
        env.policy.allowed_classes = frozenset(["read"])
        for op, args in [("fs.mkdir", {"path": SCRATCH}), ("exec", {"code": TRIP_PROBE}), ("stop", {}), ("connect", {"port": PORT}),
                         ("run", {"local": env.src})]:
            with self.assertRaises(ConfinementError):
                env.client.send(op, **args)
        env.client.send("fs.list", path="/")
        self.assertEqual(len(env.rec.sent), 1)


# ===================================================================================================== config
class ConfigAttackTests(TimedTestCase):
    DEADLINE_S = 60

    def test_dangerous_scratch_values_are_refused(self):
        bad = ["/", "", "//", "lib", "/lib", "/lib/", "/_mpybench/..", "/_mpybench_test/", "//_mpybench", "/_mpybench_test/.",
               "/_mpybench_test/../lib", "/lib/_mpybench", "/Lib/_mpybench", "/LIB/_mpybench_x", "/.frozen/_mpybench",
               "/_mpybench\x00", "/_mpybench\n", "/_mpybench_ ", "/_mpybench.", "/_mpybench_test /x", None, 5, ["/_mpybench"], {},
               "/_mybench", "_mpybench_test", "/_MPYBENCH_test", "/boot.py", "/main.py", "/_mpybench_test/..", "/a/../_mpybench",
               "\\_mpybench", "/_mpybench\\x", "C:/_mpybench", "/.._mpybench/..", True, "/_mpybench_test/x/..", "/ _mpybench",
               "/_mpybench_test\u2024", ]
        accepted = []
        for s in bad:
            try:
                cfg = validate_config({"scratch": s})
            except ConfigError:
                continue
            accepted.append((s, cfg.scratch))
        # '/_mpybench_test\u2024' is a plain (odd) name below /, '/ _mpybench' a plain name too: allowed.  Everything else must refuse.
        accepted = [a for a in accepted if a[0] not in ("/_mpybench_test\u2024", "/ _mpybench")]
        self.assertEqual(accepted, [])

    def test_scratch_inside_an_import_folder_is_refused(self):
        # the validator documents "must not be inside an import folder" but only looks at the FIRST segment
        accepted = []
        for s in ["/flash/lib/_mpybench", "/sd/lib/_mpybench", "/flash/.frozen/_mpybench", "/a/lib/_mpybench_x"]:
            try:
                validate_config({"scratch": s})
                accepted.append(s)
            except ConfigError:
                pass
        self.assertEqual(accepted, [], "scratch under /flash/lib etc. is accepted: the folder becomes an importable package")

    def test_unknown_or_malformed_keys(self):
        for cfg in [{"program": "/etc/x"}, {"programs": ["a.py"]}, {"allow": ["reset"]}, {"openPolicy": "v2"}, {"Scratch": "/x"},
                    {"backup_files": "boot.py"}, {"backup_files": [1]}, {"backup_files": [None]}, {"backup_files": [""]},
                    {"backup_files": ["a\x00"]}, {"backup_files": ["a\nb"]}, {"backup_files": ["a\\b"]}, {"backup_files": ["x"] * 21},
                    {"extra_probes": [{"name": "x", "code": "print(1)", "extra": 1}]}, {"extra_probes": "print(1)"},
                    {"extra_probes": [{"name": "../x", "code": "print(1)"}]}, {"extra_probes": [{"name": "x"}]},
                    {"extra_probes": [{"name": "x", "code": 5}]}, {"extra_probes": [{"name": "x", "code": "print(1)", "before_after": 1}]},
                    {"shadow_names": ["a b"]}, {"shadow_names": [1]}, {"shadow_names": "machine"}, {"expect": {"cmd": "x"}},
                    {"expect": {"version_min": [1, 2]}}, {"expect": {"version_min": [True, 1, 1]}}, {"notes": 5}, [], "x", 5, None]:
            with self.assertRaises(ConfigError, msg=repr(cfg)):
                validate_config(cfg)

    def test_backup_files_are_read_only_targets(self):
        cfg = validate_config({"backup_files": ["main.py", "boot.py", "../boot.py", "/lib/../boot.py", "/main.py", "x/../main.py"]})
        env = PolicyEnv(self, backups=cfg.backup_files)
        for name in cfg.backup_files:
            for op, args in [("fs.put", {"remote": name, "local": env.src}), ("fs.rm", {"path": name}), ("fs.mkdir", {"path": name}),
                             ("fs.rmtree", {"path": name}), ("fs.mv", {"src": name, "dst": SCRATCH + "/a"}),
                             ("fs.mv", {"src": SCRATCH + "/a", "dst": name})]:
                with self.assertRaises(ConfinementError, msg=(name, op)):
                    env.client.send(op, **args)
            env.client.send("fs.get", remote=name, local=os.path.join(env.backup, "x"))            # reading them is the point
        self.assertTrue(all(a[0] == "fs.get" for a in env.rec.sent))

    def test_backup_file_local_name_is_never_the_backup_folder_itself(self):
        # phases.ensure_backups derives the host name with name.strip("/").replace("/", "__")
        for raw in ["/", "//", "/.", "/..", "a/..", "/a/../.."]:
            try:
                cfg = validate_config({"backup_files": [raw]})
            except ConfigError:
                continue
            for name in cfg.backup_files:
                local = name.strip("/").replace("/", "__")
                self.assertNotEqual(local, "", "backup_files=%r -> normalised %r -> host file name '' (the backup folder itself)" % (raw, name))

    def test_trailing_newline_is_not_accepted_by_name_regexes(self):
        # re.match(r"^...$") lets 'x\n' through ($ matches before a final newline)
        accepted = []
        for cfg in [{"shadow_names": ["acme\n"]}, {"extra_probes": [{"name": "x\n", "code": "print(1)"}]}]:
            try:
                validate_config(cfg)
                accepted.append(cfg)
            except ConfigError:
                pass
        env = PolicyEnv(self)
        try:
            env.client.send("fs.put", remote=SCRATCH + "/a", local=env.src, expectSha="a" * 64 + "\n")
            accepted.append("expectSha with trailing newline")
        except ConfinementError:
            pass
        try:
            env.client.send("config", shadowGuard=["acme\n"])
            accepted.append("shadowGuard with trailing newline")
        except ConfinementError:
            pass
        self.assertEqual(accepted, [])


# ===================================================================================================== probe validator
class ProbeValidatorTests(TimedTestCase):
    DEADLINE_S = 60

    def accepted(self, codes):
        out = []
        for code in codes:
            try:
                validate_probe_code(code)
                out.append(code)
            except ConfinementError:
                pass
        return out

    def test_obvious_attacks_are_refused(self):
        codes = ["print(__import__('machine').reset())", "print(__import__('mac'+'hine'))", "print(__import__('os'))",
                 "print(__import__('OS'))", "print(__import__('uos').listdir())", "print(getattr(1, 'x'))", "print((lambda: 1)())",
                 "print(f'{1}')", "print(1); print(2)", "print(1)\nprint(2)", "import os", "x = print(1)", "print(open('/boot.py'))",
                 "print(__import__('time').sleep(5))", "print(__import__('time').ticks_ms.__self__)", "print(__import__('sys').modules)",
                 "print(__import__('usys'))", "print(__import__('io'))", "print(__import__(*['os']))", "print(__import__('time', 1))",
                 "print(__import__('time').ticks_ms(**{}))", "print(*[1])", "print(1 if __import__('time') else exec('x'))",
                 "print(eval('1'))", "print(__import__(b'os'))", "print([x for x in (1,)])", "print((x := 1))", "print(1)  \\",
                 "print(__import__('machine\\x00'))", "print(__import__('sys').exit())", "print(__import__('network'))",
                 "print(__import__('esp32'))", "print(__import__('_thread'))", "print(__import__('bluetooth'))",
                 "print(__import__('builtins'))", "print(__import__('time')._x())", "print(().__class__)", "print(__import__('gc').collect())",
                 "print(__import__('vfs').umount('/'))", "print(__import__('vfs').VfsLfs2.mkfs(1))", "print(__import__('gc').threshold(1))",
                 "print('\u00e9')", "print(1)\x00", "p" * 301, "", "   ", None, 5, ["print(1)"], "print(1)  # " + "x" * 300,
                 "print(__import__('time').ticks_ms(), __import__('uctypes'))", "print(__import__('sys') if 1 else 0)",
                 "print(__import__('Machine'))", "print(__import__('os.path'))"]
        self.assertEqual(self.accepted(codes), [])

    def test_user_code_and_boot_modules_cannot_be_imported(self):
        # importing a module RUNS it.  The validator is a deny-list of firmware modules: it cannot see user code on the board.
        codes = ["print(__import__('main'))", "print(__import__('boot'))", "print(__import__('test'))", "print(__import__('_boot'))",
                 "print(__import__('inisetup'))", "print(__import__('flashbdev'))", "print(__import__('webrepl_setup'))",
                 "print(__import__('shield'))", "print(__import__('Main'))", "print(__import__('upysh'))", "print(__import__('this'))"]
        self.assertEqual(self.accepted(codes), [], "probe imports a module that executes on import (main.py, boot.py, test.py, _boot, ...)")

    def test_config_shadow_names_also_protect_against_probe_imports(self):
        # CLAUDE.md rule 5: "Never import shield".  The config lists the firmware's own names in shadow_names, which keeps them out of
        # programs and file names, but validate_config calls validate_probe_code(code) without them.
        for code in ["print(__import__('shield').get_counts())", "print(__import__('shield'))", "print(__import__('acme').version())"]:
            with self.assertRaises(ConfigError, msg=code):
                validate_config({"shadow_names": ["shield", "_shield", "acme"], "extra_probes": [{"name": "p", "code": code}]})

    def test_getter_regex_does_not_match_blocking_or_mutating_names(self):
        codes = ["print(__import__('time').sleep_ms(3600000))", "print(__import__('time').sleep_us(2000000000))",
                 "print(__import__('time').delay_ms(5))", "print(__import__('gc').set_state(1))", "print(__import__('gc').clear_stats())",
                 "print(__import__('gc').start_status())", "print(__import__('gc').write_count(1))", "print(__import__('gc').set_id(1))",
                 "print(__import__('gc').getsleep(1))", "print(__import__('gc').read_and_clear())"]
        self.assertEqual(self.accepted(codes), [], "name pattern accepts calls that block or mutate")

    def test_probe_cannot_fake_the_tripwire_line(self):
        # a probe that prints @@TRIP is allowed to exist, but it must not be able to take the place of the tripwire reading
        validate_config({"extra_probes": [{"name": "spoof", "code": "print('@@TRIP 1 0 0')", "before_after": True}]})
        from tools.hwtest.tripwire import Tripwire

        class Fake(object):
            reset_errors = []

            def __init__(self):
                self.codes = []

            def request(self, op, _timeout=None, **a):
                self.codes.append(a["code"])
                if a["code"] == TRIP_PROBE:
                    return {"ok": True, "out": "@@TRIP 5000 1 2\n"}
                return {"ok": True, "out": "@@TRIP 1 0 0\n"}

            def mark(self):
                return 0

            def events_of(self, *a, **k):
                return []

        f = Fake()
        tw = Tripwire(f, [{"name": "spoof", "code": "print('@@TRIP 1 0 0')", "before_after": True}], session_t0=0.0, clock=lambda: 5.0,
                      min_uptime_ms=0)
        r = tw.baseline()
        self.assertEqual((r.ticks, r.cause, r.soft), (5000, 1, 2))


# ===================================================================================================== program scanner
class ScannerTests(TimedTestCase):
    DEADLINE_S = 60

    def test_scanner_blocks_obvious_things(self):
        for text in ["import machine\n", "from machine import Pin\n", "import os\n", "import sys, os\n", "x = open('/x')\n", "exec('1')\n",
                     "__import__('os')\n", "import time as machine\n", "print(globals())\n", "print(sys.modules)\n", "import network\n",
                     "print('\u00e9')\n", "import sys\nimport os as o\n", "from os import remove\n", "import  \tos\n"]:
            self.assertTrue(scan_program(text), text)

    def test_scanner_blocks_evasions(self):
        # each of these is code a harness program or a typed line must not contain; scan_program says "clean"
        evasions = ["open ('/main.py', 'w').write('x')\n",
                    "g = open\ng('/main.py', 'w')\n",
                    "x = 1; import os\n",
                    "x = 1; import os as o\nf = o.remove\nf('/boot.py')\n",
                    "if 1: import os as o\nf = o.rename\nf('/boot.py', '/x')\n",
                    "try: import os as o\nexcept ImportError: pass\n",
                    "x = 1; from os import rename as r\n"]
        clean = [e for e in evasions if not scan_program(e)]
        self.assertEqual(clean, [], "the scanner reports these as clean")

    def test_tty_write_refuses_the_same_evasions(self):
        env = PolicyEnv(self)
        env.policy.repl_attached = True
        survivors = []
        for lines in [["open ('/main.py', 'w').write('x')\r"], ["g = open\r", "g('/main.py', 'w')\r"],
                      ["x = 1; import os as o\r", "f = o.remove\r", "f('/boot.py')\r"]]:
            try:
                for ln in lines:
                    env.tty(ln)
                survivors.append(lines)
            except ConfinementError:
                pass
        self.assertEqual(survivors, [], "typed text that would delete/create files passed the tty.write check")

    def test_split_token_is_caught(self):
        # review 3: tty.write is an allowlist of whole lines, so the first fragment is already refused
        env = PolicyEnv(self)
        env.policy.repl_attached = True
        with self.assertRaises(ConfinementError):
            env.tty("x = mach")
        with self.assertRaises(ConfinementError):
            env.tty("ine\r")
        env.tty("1+2\r")                                                           # the phase D line is still accepted

    def test_program_toctou(self):
        # Policy.check verified the file, but the bridge reads it later: whoever can write the file in between wins
        env = PolicyEnv(self)
        prog = env.store.author("prog ok.py", 'print("harness hello")\n')
        seen = {}

        def swap(op, args):
            os.chmod(prog.path, 0o600)                       # authored programs are read-only; a same-user writer can undo that
            with open(prog.path, "w") as f:
                f.write("x = 1; import os as o\n")

        env.policy.on_send = swap
        try:
            env.client.send("run", local=prog.path)
            seen["sent"] = True
        except ConfinementError:
            seen["sent"] = False                             # the late re-verification caught the swapped file
        with open(prog.path, "r") as f:
            seen["text"] = f.read()
        self.assertTrue(seen["text"] == prog.text or not seen["sent"],
                        "the program file changed between the check and the send, and the run was sent anyway")
        self.assertEqual([op for op, _ in env.rec.sent if op == "run"], [] if not seen["sent"] else ["run"])

    def test_unregistered_and_modified_programs_are_refused(self):
        env = PolicyEnv(self)
        prog = env.store.author("prog ok.py", 'print(1)\n')
        other = os.path.join(env.tmp, "other.py")
        with open(other, "w") as f:
            f.write("print(2)\n")
        for local in [other, os.path.join(env.tmp, "programs", "..", "other.py"), os.path.dirname(prog.path), prog.path + "x", "/etc/passwd"]:
            with self.assertRaises(ConfinementError, msg=local):
                env.client.send("run", local=local)
        self.assertFalse(os.access(prog.path, os.W_OK) and os.geteuid() != 0, "authored programs are read-only")
        os.chmod(prog.path, 0o600)
        with open(prog.path, "w") as f:
            f.write("print(3)\n")
        with self.assertRaises(ConfinementError):
            env.client.send("run", local=prog.path)
        for name in ["main.py", "BOOT.PY", "../x.py", "a/b.py", "x.txt", ".py", " x.py", "x.py\n"]:
            with self.assertRaises(ConfinementError, msg=name):
                env.store.author(name, "print(1)\n")


# ===================================================================================================== real-port guards
def run_guard(argv, env, spawn_calls, extra_stub=None):
    """run_hw.main with a raising spawn stub (records the call) and reports in a scratch folder.  Returns (code, text)."""
    base = tempfile.mkdtemp(prefix="adv3 guard ")
    out = io.StringIO()

    def spawn(port, real_port):
        spawn_calls.append((port, real_port))
        raise AssertionError("stub spawn: nothing is opened")

    try:
        code = run_hw.main(list(argv) + ["--report", os.path.join(base, "r"), "--backup-dir", os.path.join(base, "b")], spawn=spawn,
                           environ=dict(env), stdout=out, lsof=lambda p: [])
    finally:
        shutil.rmtree(base, ignore_errors=True)
    return code, out.getvalue()


class GuardTests(TimedTestCase):
    DEADLINE_S = 120

    def test_real_device_needs_all_three(self):
        cases = []
        safe = {"MPY_SAFE_MODE": "1"}
        cases.append((["--port", REAL], safe))
        cases.append((["--port", REAL, "--allow-real-port"], safe))
        cases.append((["--port", REAL, "--allow-real-port"], dict(safe, MPY_REAL_PORT=REAL + "x")))
        cases.append((["--port", REAL, "--allow-real-port"], dict(safe, MPY_REAL_PORT=REAL + " ")))
        cases.append((["--port", REAL, "--allow-real-port"], dict(safe, MPY_REAL_PORT=REAL.upper())))
        cases.append((["--port", REAL, "--allow-real-port"], dict(safe, MPY_REAL_PORT="auto")))
        cases.append((["--port", REAL, "--allow-real-port"], dict(safe, MPY_REAL_PORT="")))
        cases.append((["--port", REAL], dict(safe, MPY_REAL_PORT=REAL)))                      # env without flag
        cases.append((["--port", REAL + " ", "--allow-real-port"], dict(safe, MPY_REAL_PORT=REAL)))
        cases.append((["--port", " " + REAL, "--allow-real-port"], dict(safe, MPY_REAL_PORT=REAL)))
        cases.append((["--port", "cu.fake-adv3-0", "--allow-real-port"], dict(safe, MPY_REAL_PORT=REAL)))
        cases.append((["--port", "com3", "--allow-real-port"], dict(safe, MPY_REAL_PORT="COM3")))
        cases.append((["--port", "COM3", "--allow-real-port"], dict(safe, MPY_REAL_PORT="com3")))
        for val in [None, "0", "false", "False", "FALSE", "no", "off", "OFF", "", " ", " 0 ", "\t", "\n"]:
            e = {"MPY_REAL_PORT": REAL}
            if val is not None:
                e["MPY_SAFE_MODE"] = val
            cases.append((["--port", REAL, "--allow-real-port"], e))
        for bad in ["auto", "AUTO", " auto", "auto ", "", "   ", "\x00", REAL + "\x00"]:
            cases.append((["--port", bad, "--allow-real-port"], dict(safe, MPY_REAL_PORT=bad)))
        for url in ["socket://127.0.0.1@evil:80", "socket://evil@127.0.0.1:80", "socket://127.0.0.1.evil.com:80", "socket://localhost.evil.com:80",
                    "socket://127.1:80", "socket://0x7f.0.0.1:80", "socket://2130706433:80", "socket://[::ffff:8.8.8.8]:80", "socket://0.0.0.0:80",
                    "socket://127.0.0.1:80@evil", "socket://127.0.0.1\\@evil.com:80", "socket:///127.0.0.1", "socket://", "SOCKET://EVIL:80",
                    "socket://evil.com#@127.0.0.1:80", "rfc2217://127.0.0.1@evil:2217", "spy://" + REAL, "alt://" + REAL, "hwgrep://0001",
                    "cp2110://x", "loop:/", "loop", "socket:127.0.0.1:80", "socket://127.0.0.1%40evil:80", "socket://localhost@evil:80",
                    "socket://[::1]@evil:80", "http://127.0.0.1:80", "socket://8.8.8.8:80", "socket:// 127.0.0.1:80"]:
            cases.append((["--port", url], safe))
            cases.append((["--port", url, "--allow-real-port"], safe))                          # flag but no MPY_REAL_PORT
        leaks = []
        for argv, env in cases:
            for dry in (True, False):
                calls = []
                code, text = run_guard(argv + (["--dry-run"] if dry else []), env, calls)
                if code != 2 or calls:
                    leaks.append((argv, {k: v for k, v in env.items()}, "dry" if dry else "live", code, calls))
        self.assertEqual(leaks, [], "a guard let a real-device / lookalike port through")

    def test_positive_controls_pass_only_with_all_guards(self):
        calls = []
        code, text = run_guard(["--port", REAL, "--allow-real-port"], {"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": REAL}, calls)
        self.assertEqual(calls, [(REAL, REAL)], text)
        calls = []
        code, text = run_guard(["--port", PORT], {"MPY_SAFE_MODE": "1"}, calls)
        self.assertEqual(calls, [(PORT, None)], text)

    def test_fake_board_never_gets_the_real_port_even_if_env_has_one(self):
        calls = []
        code, text = run_guard(["--fake", "esp32"], {"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": REAL}, calls)
        self.assertEqual(len(calls), 1, text)
        self.assertTrue(calls[0][0].startswith("socket://127.0.0.1:"), calls)
        self.assertIsNone(calls[0][1])
        self.assertNotIn("MPY_REAL_PORT", run_hw.child_env())

    def test_argument_mixes_are_refused(self):
        for argv in [["--fake", "esp32", "--port", REAL], ["--fake", "nope"], ["--fake-fault", "reset_on_connect"], [], ["--phases", "A"],
                     ["--port", PORT, "--phases", "Z"], ["--port", PORT, "--config", "/nonexistent/x.json"]]:
            calls = []
            code, text = run_guard(argv, {"MPY_SAFE_MODE": "1"}, calls)
            self.assertEqual((code, calls), (2, []), (argv, text))

    def test_dry_run_spawns_and_opens_nothing(self):
        def boom(name):
            def f(*a, **k):
                raise AssertionError("dry run called %s" % name)
            return f

        import tools.fakeboard
        argvs = [["--port", PORT], ["--fake", "esp32"], ["--fake", "esp32", "--fake-fault", "reset_on_connect"],
                 ["--port", REAL, "--allow-real-port"], ["--port", PORT, "--phases", "A,B,C,D,E,F"]]
        with mock.patch.object(subprocess, "Popen", boom("Popen")), mock.patch.object(subprocess, "run", boom("run")), \
                mock.patch.object(tempfile, "mkdtemp", boom("mkdtemp")), mock.patch.object(run_hw, "HwBridgeClient", boom("HwBridgeClient")), \
                mock.patch.object(run_hw, "default_spawn", boom("default_spawn")), mock.patch.object(run_hw, "lsof_holders", boom("lsof")), \
                mock.patch.object(tools.fakeboard, "FakeBoard", boom("FakeBoard")), mock.patch.object(os, "makedirs", boom("makedirs")):
            for argv in argvs:
                env = {"MPY_SAFE_MODE": "1", "MPY_REAL_PORT": REAL}
                out = io.StringIO()
                code = run_hw.main(argv + ["--dry-run"], spawn=boom("spawn"), environ=env, stdout=out, lsof=boom("lsof-arg"))
                self.assertEqual(code, 0, (argv, out.getvalue()))
            out = io.StringIO()
            self.assertEqual(run_hw.main(["--list-phases"], spawn=boom("spawn"), environ={}, stdout=out), 0)

    def test_dry_run_does_not_create_report_folders(self):
        base = tempfile.mkdtemp(prefix="adv3 dry ")
        self.addCleanup(shutil.rmtree, base, True)
        out = io.StringIO()
        code = run_hw.main(["--port", PORT, "--dry-run", "--report", os.path.join(base, "r"), "--backup-dir", os.path.join(base, "b")],
                           environ={"MPY_SAFE_MODE": "1"}, stdout=out)
        self.assertEqual(code, 0)
        self.assertEqual(os.listdir(base), [])

    def test_hostile_argv_forms(self):
        for argv in [["--port=" + REAL, "--allow-real-port"], ["--port", REAL, "--allow", "--dry-run"], ["--port", REAL, "--allow-real-port=1"],
                     ["--port", REAL, "--dry"], ["--po", REAL]]:
            calls = []
            code, text = run_guard(argv, {"MPY_SAFE_MODE": "1"}, calls)
            self.assertEqual(calls, [], (argv, text))
            self.assertIn(code, (0, 2), (argv, text))


class ConfigDryRunTests(TimedTestCase):
    """The config is the operator's input, but the harness promises that a config cannot make it send harmful device code."""
    DEADLINE_S = 60

    def dry(self, probes):
        import json
        d = tempfile.mkdtemp(prefix="adv3 cfg ")
        self.addCleanup(shutil.rmtree, d, True)
        path = os.path.join(d, "c.json")
        with open(path, "w") as f:
            json.dump({"extra_probes": [{"name": "p%d" % i, "code": c, "before_after": True} for i, c in enumerate(probes)]}, f)
        calls = []
        code, text = run_guard(["--port", PORT, "--dry-run", "--config", path], {"MPY_SAFE_MODE": "1"}, calls)
        self.assertEqual(calls, [])
        return code, text

    def test_dry_run_refuses_probe_that_runs_board_code(self):
        for c in ["print(__import__('main'))", "print(__import__('boot'))", "print(__import__('test'))", "print(__import__('_boot'))"]:
            code, text = self.dry([c])
            self.assertEqual(code, 2, "config probe %s was accepted: dry run OK" % c)

    def test_dry_run_refuses_probe_that_blocks_the_board(self):
        code, text = self.dry(["print(__import__('time').sleep_ms(3600000))"])
        self.assertEqual(code, 2, "a probe that sleeps for an hour was accepted: dry run OK")


# ===================================================================================================== static structure
class StructureTests(TimedTestCase):
    DEADLINE_S = 30

    def read(self, name):
        with open(os.path.join(HWDIR, name), "r", encoding="utf-8") as f:
            return f.read()

    def test_only_confined_client_reaches_the_bridge(self):
        for name in ["phases.py", "tripwire.py", "programs.py", "report.py", "config.py"]:
            src = self.read(name)
            for bad in ["_inner", "send_raw", ".proc", "subprocess", "import serial", "import socket", "Popen", "os.system", "HwBridgeClient",
                        "BridgeClient(", "shell=True"]:
                self.assertNotIn(bad, src, "%s mentions %s" % (name, bad))

    def test_no_reset_op_is_ever_written_in_phase_code(self):
        for name in ["phases.py", "tripwire.py"]:
            src = self.read(name)
            self.assertIsNone(re.search(r"""(call|request|send)\(\s*["']reset""", src), name)
            self.assertNotIn("openPolicy", src.replace("never an openPolicy", ""), name)

    def test_one_popen_in_run_hw(self):
        src = self.read("run_hw.py")
        self.assertEqual(src.count("subprocess.Popen("), 1)
        self.assertEqual(src.count("MPY_REAL_PORT"), src.count("MPY_REAL_PORT"))
        self.assertIn("shell=False", src)


# ===================================================================================================== end to end (fake board only)
class HostileConfigRunTests(FakeRunMixin, TimedTestCase):
    DEADLINE_S = 240

    def test_hostile_backup_list_never_writes_main_or_boot(self):
        cfg = dict(ACME_CFG, backup_files=["main.py", "boot.py", "../boot.py", "/lib/../test.py", "/main.py"])
        sent = []

        def on_send(op, args):
            sent.append((op, dict(args)))

        r = self.fake_run("esp32", "A,B", cfg=cfg, hooks={"on_send": on_send}, soak=(2, 3))
        self.assertIn(r.code, (0, 1), r.text[-1500:])
        problems = []
        for op, args in sent:
            if op.startswith("reset") or op not in confine.OP_CLASSES:
                problems.append((op, args))
            if op in ("fs.put", "fs.rm", "fs.rmtree", "fs.mkdir", "fs.mv"):
                problems += sent_path_problems(op, args)
        self.assertEqual(problems, [])
        self.assertFalse(any(k.endswith("main.py") for k in r.final["files"]), sorted(r.final["files"]))
        self.assertEqual(r.report["residue"], [], r.report["cleanup"])
        self.assertTrue(r.left_as_found)

    def test_phase_b_does_not_depend_on_the_policy_to_survive_its_own_selftest(self):
        """Phase B sends fs.put /boot.py, /main.py, fs.rm /boot.py, fs.rmtree / ... through the ConfinedClient to PROVE that they are
        refused.  If the one guard (Policy.check) ever failed open, those requests would reach the real board.  Fault injection:
        replace Policy.check by a pass-through and look at what phase B would have sent (on_send runs before the bridge is called)."""
        sent = []

        def passthrough(self, op, args):
            return dict(args), confine.OP_CLASSES.get(op, "read")

        with mock.patch.object(Policy, "check", passthrough):
            try:
                self.fake_run("esp32", "A,B", hooks={"on_send": lambda op, args: sent.append((op, dict(args)))}, soak=(2, 3))
            except Exception:                                                       # noqa: BLE001 - the run may fail; we only read `sent`
                pass
        bad = []
        for op, args in sent:
            if op in ("fs.put", "fs.rm", "fs.rmtree", "fs.mkdir", "fs.mv"):
                bad += sent_path_problems(op, args)
        self.assertEqual(bad, [], "with the guard bypassed, phase B itself sends these destructive requests")

    def test_slash_backup_entry_does_not_break_cleanup(self):
        # review 3: a backup entry that is the root folder is a config error (exit 2, nothing started) instead of a run that ends in
        # exit 4 with the misleading residue "backup file(s) differ ... [/]"
        cfg = dict(ACME_CFG, backup_files=["/", "boot.py"])
        r = self.fake_run("esp32", "A,B", cfg=cfg, soak=(2, 3))
        self.assertEqual(r.code, 2, r.text[-1500:])
        self.assertIn("backup_files", r.text)
        self.assertIsNone(r.board)

    def test_spoofing_probe_does_not_disable_the_tripwire(self):
        cfg = dict(ACME_CFG, extra_probes=[{"name": "spoof", "code": "print('@@TRIP 1 0 0')", "before_after": True}])
        r = self.fake_run("esp32", "A,B", cfg=cfg, faults=["reset_on_connect"], soak=(2, 3))
        self.assertEqual(r.code, 3, r.text[-1500:])
        self.assertTrue(r.left_as_found)


if __name__ == "__main__":
    unittest.main()
