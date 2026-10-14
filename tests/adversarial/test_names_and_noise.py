"""Break-it tests: hostile names/paths, and a board that sends damaged replies or line noise.

Fake board over socket://127.0.0.1 only. ``test_*`` pin defects found by the review.

    export MPY_SAFE_MODE=1
    python3 -B -m unittest tests.adversarial.test_names_and_noise -v
"""
from __future__ import annotations

import os
import random
import re
import sys
import tempfile
import time
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tests.adversarial._harness import BridgeError, Proxy, Rig, devfs  # noqa: E402
import serial.urlhandler.protocol_socket as _ps  # noqa: E402

_real_time = None


def setUpModule():
    global _real_time
    _real_time = _ps.time
    _ps.time = types.SimpleNamespace(sleep=lambda s: None, time=time.time, monotonic=time.monotonic)


def tearDownModule():
    _ps.time = _real_time


CONTENT = b"hello\r\n\x00\xff\x04\x03 bytes"

ODD_NAMES = [
    "/new\nline.txt", "/a\r\nb", "/tab\tname", "/\x7f", "/\u202e.txt", "/café.txt",
    "/日本語-\U0001f600.py", "/a b/(c) @d.txt", "/sub/\\back.txt", "/..hidden", "/-", "/say \"hi\".py",
    "/it's.py", "/x" * 1 + "y" * 200 + ".py", "/" + "z" * 251, "/" + "é" * 120, "/@@{evil}.txt", "/a//b.txt",
]


class HostileNameTests(unittest.TestCase):
    def test_odd_names_round_trip_and_are_listed_exactly(self):
        d = tempfile.mkdtemp()
        src = os.path.join(d, "src.bin")
        with open(src, "wb") as f:
            f.write(CONTENT)
        with Rig() as r:
            r.connect()
            for name in ODD_NAMES:
                with self.subTest(name=name[:40]):
                    res = r.fs(devfs.put_file, src, name)
                    self.assertEqual(res["bytes"], len(CONTENT))
                    out = os.path.join(d, "out.bin")
                    r.fs(devfs.get_file, name, out)
                    with open(out, "rb") as f:
                        self.assertEqual(f.read(), CONTENT)
            listed = {e["path"] for e in r.fs(devfs.manifest, "/")["entries"]}
            for name in ODD_NAMES:
                norm = "/" + "/".join(p for p in name.split("/") if p)
                self.assertIn(norm, listed)
            self.assertEqual([p for p in listed if p.endswith(".mpytmp")], [])

    def test_bad_paths_are_protocol_errors_and_nothing_reaches_the_board(self):
        with Rig(capture=True) as r:
            r.connect()
            r.link.enter_raw()
            r.link.exit_raw()
            before = r.board.events.count("exec")
            for bad in ("/", "//", "/../x", "/a/./b", "/a/..", "/nul\x00x", "relative", "", "./x", "/lone\ud800"):
                for fn, args in ((devfs.stat, ()), (devfs.list_dir, ()), (devfs.manifest, ())):
                    if bad in ("/", "//") :
                        continue
                    with self.subTest(path=bad, fn=fn.__name__):
                        with self.assertRaises(BridgeError) as cm:
                            r.fs(fn, bad, *args)
                        self.assertEqual(cm.exception.code, "E_PROTOCOL")
                for fn in (devfs.rm, devfs.mkdir):
                    with self.subTest(path=bad, fn=fn.__name__):
                        with self.assertRaises(BridgeError) as cm:
                            r.fs(fn, bad)
                        self.assertEqual(cm.exception.code, "E_PROTOCOL")
            self.assertEqual(r.board.events.count("soft_reset"), 0)

    def test_rmtree_refuses_root_in_every_spelling_and_needs_confirm(self):
        with Rig(files={"/keep/a.txt": "x", "/main.py": "print(1)\n"}) as r:
            r.connect()
            for root in ("/", "//", "///", "", " ", "/.", "/..", "/./", "/keep/..", None):
                with self.subTest(path=root):
                    with self.assertRaises(BridgeError) as cm:
                        r.fs(devfs.rmtree, root)
                    self.assertEqual(cm.exception.code, "E_PROTOCOL")
            for confirm in (False, None, 0, "true", "yes", 1):
                with self.subTest(confirm=confirm):
                    with self.assertRaises(BridgeError) as cm:
                        r.fs(devfs.rmtree, "/keep", confirm=confirm)
                    self.assertEqual(cm.exception.code, "E_PROTOCOL")
            self.assertTrue(r.board.exists("/keep/a.txt") and r.board.exists("/main.py"))
            self.assertEqual(r.fs(devfs.rmtree, "/keep")["removed"], 2)
            self.assertTrue(r.board.exists("/main.py"))


class DamagedReplyTests(unittest.TestCase):
    """What a corrupted serial line can do to the host-side parsers: only BridgeError may come out."""

    def _flaky(self, r, pattern, mutate):
        def exec_fn(code, timeout=10.0):
            out, err = r.link.exec(code, timeout)
            if pattern in code:
                out = mutate(out)
            return out, err
        return exec_fn

    def test_get_with_one_lost_byte_in_a_base64_chunk_raises_bridge_error(self):
        """devfs.get_file calls base64.b64decode(r["b"]) on the board's reply; a dropped/garbled byte on the serial
        line leaves a length that is not a multiple of 4 and binascii.Error (not a BridgeError) escapes, so the
        bridge's error classification ('every failure reaches the user with a code') is bypassed."""
        d = tempfile.mkdtemp()
        with Rig() as r:
            r.connect()
            r.board.write_file("/f.bin", os.urandom(5000))
            with r.link.session():
                r.link.enter_raw()
                # chunk replies are produced by the get_chunk snippet; recognise it by one of its own lines
                marker = devfs.render("get_chunk", P=devfs._hexs("/f.bin"), OFF=0, LEN=16).splitlines()[1]
                flaky = self._flaky(r, marker, lambda out: re.sub(rb'("b":"[A-Za-z0-9+/]{8})[A-Za-z0-9+/]', rb"\1", out, count=1))
                try:
                    devfs.get_file(flaky, "/f.bin", os.path.join(d, "o.bin"), chunk=1024)
                except BridgeError:
                    pass  # expected after the fix
                except Exception as exc:  # noqa: BLE001
                    self.fail("non-BridgeError escaped from get_file: %s: %s" % (type(exc).__name__, exc))
                finally:
                    r.link.exit_raw()

    def test_random_damage_to_replies_only_ever_raises_bridge_error(self):
        d = tempfile.mkdtemp()
        src = os.path.join(d, "f.bin")
        with open(src, "wb") as f:
            f.write(os.urandom(3000))
        ops = {
            "list": lambda x: devfs.list_dir(x, "/"),
            "manifest": lambda x: devfs.manifest(x, "/"),
            "stat": lambda x: devfs.stat(x, "/f.bin"),
            "identity": lambda x: devfs.identity(x),
            "put": lambda x: devfs.put_file(x, src, "/g.bin", chunk=1024),
            "mkdir": lambda x: devfs.mkdir(x, "/q/r"),
            "mv": lambda x: devfs.mv(x, "/f.bin", "/h.bin"),
            "rm": lambda x: devfs.rm(x, "/f.bin"),
        }
        escapes = {}
        with Rig() as r:
            r.connect()
            for name, op in ops.items():
                r.board.write_file("/f.bin", os.urandom(3000))
                rec = []
                with r.link.session():
                    r.link.enter_raw()

                    def recorder(code, timeout=10.0):
                        o = r.link.exec(code, timeout)
                        rec.append(o)
                        return o

                    try:
                        op(recorder)
                    finally:
                        r.link.exit_raw()
                rng = random.Random(11)
                for _ in range(150):
                    seq = []
                    for out, err in rec:
                        b = bytearray(out)
                        if b and rng.random() < 0.6:
                            m = rng.randrange(4)
                            if m == 0:
                                del b[rng.randrange(len(b)):]
                            elif m == 1:
                                b[rng.randrange(len(b))] = rng.randrange(256)
                            elif m == 2:
                                b[rng.randrange(len(b) + 1):0] = bytes(rng.randrange(256) for _ in range(rng.randrange(1, 9)))
                            else:
                                del b[rng.randrange(len(b))]
                        seq.append((bytes(b), err))
                    it = iter(seq)
                    try:
                        op(lambda code, timeout=10.0, _it=it: next(_it, (b"", b"")))
                    except BridgeError:
                        pass
                    except Exception as exc:  # noqa: BLE001
                        escapes.setdefault((name, type(exc).__name__), str(exc)[:80])
        # get/rmtree are covered by the dedicated test above; everything else must already be clean
        self.assertEqual(escapes, {})


class LineNoiseTests(unittest.TestCase):
    """3 % of the board->host bytes are replaced / dropped / duplicated / followed by a lone Ctrl-D / split
    UTF-8. Every op must end with a BridgeError (never a raw exception, never a hang beyond its bounded
    timeouts), no board reset may be provoked, and the Link must work again once the line is clean."""

    def _run(self, seed, faults=()):
        rng = random.Random(seed)

        def mutate(direction, data):
            if direction != "down":
                return data
            out = bytearray()
            for b in data:
                x = rng.random()
                if x < 0.01:
                    out.append(rng.randrange(256))
                elif x < 0.015:
                    pass
                elif x < 0.02:
                    out += bytes([b, 4])
                elif x < 0.025:
                    out += bytes([b, b])
                elif x < 0.03:
                    out += b"\xe2\x82"
                else:
                    out.append(b)
            return bytes(out)

        d = tempfile.mkdtemp()
        src = os.path.join(d, "x.bin")
        with open(src, "wb") as f:
            f.write(os.urandom(3000))
        problems = []
        with Rig(capture=True, faults=faults) as r:
            r.max_timeout = 1.5
            px = Proxy(r.board.port, mutate)
            self.addCleanup(px.close)
            link = r.link
            link.stage_timeout = 1.0
            link.interrupt_wait = 0.3
            for rnd in range(5):
                px.enabled = True
                if not link.is_open:
                    link.close()
                    link.open(px.url)
                for _ in range(3):
                    op = rng.choice(["sync", "raw_exec", "put", "stat"])
                    t0 = time.monotonic()
                    try:
                        if op == "sync":
                            link.sync_to_prompt(100, 100)
                        elif op == "raw_exec":
                            with link.session():
                                link.enter_raw(timeout=2)
                                link.exec("print(1+1)", timeout=1)
                                link.exit_raw()
                        elif op == "put":
                            r.fs(devfs.put_file, src, "/zz.bin", chunk=512)
                        else:
                            r.fs(devfs.stat, "/boot.py")
                    except BridgeError:
                        pass
                    except Exception as exc:  # noqa: BLE001
                        problems.append((op, "raw " + repr(exc)))
                    if time.monotonic() - t0 > 20:
                        problems.append((op, "slow"))
                    if not link.is_open:
                        break
                px.enabled = False
                try:
                    if not link.is_open:
                        link.close()
                        link.open(px.url)
                    with link.session():
                        link.enter_raw(timeout=4)
                        out, _err = link.exec("print(40+2)", timeout=3)
                        link.exit_raw()
                    if out.strip() != b"42":
                        problems.append(("recover", out))
                except BridgeError as exc:
                    problems.append(("recover", exc.code))
            resets = r.board.events.count("soft_reset") + r.board.events.count("hard_reset")
        return problems, resets

    def test_noise_esp32_profile(self):
        problems, resets = self._run(21)
        self.assertEqual(problems, [])
        self.assertEqual(resets, 0)

    def test_noise_no_raw_paste_profile_never_resets(self):
        problems, resets = self._run(22, faults=["no_raw_paste"])
        self.assertEqual(problems, [])
        self.assertEqual(resets, 0)


if __name__ == "__main__":
    unittest.main()
