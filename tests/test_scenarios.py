"""Scenario catalogue of docs/analysis/09-architecture-options.md Appendix G as BLACK-BOX tests of the bridge process.

Every test starts ``bridge/mpy_bridge.py`` as a child process (tests/bridge_client.py), speaks the NDJSON protocol of
docs/protocol.md (incl. Appendix A and B, which supersede the earlier text) and checks two things: what the bridge
answers, and what the FAKE BOARD saw (its event log: connect, disconnect, soft_reset, hard_reset, raw_enter, exec,
interrupt, program_start/end, stdin_bytes).  Written from the contract only; no bridge internals are used.

Safety: ``MPY_SAFE_MODE=1`` is forced into every child (tests.support.child_env), ``MPY_REAL_PORT`` is never set.  The
only devices are ``socket://127.0.0.1:PORT`` fake boards, the unix-VM relay, and ptys this file creates itself
(registered through ``MPY_HARNESS_PTYS``).  The real-port-name test first PROVES that the bridge's guard is active with
names that cannot exist and only then sends the real-looking names, which are refused before any open.

Run (repo root)::

    export MPY_SAFE_MODE=1 MPY_UNIX_BIN=<unix-port micropython>
    timeout 600 python3.13 -B -m unittest tests.test_scenarios

Each docstring names the requirement / decision / catalogue item it checks (RQ-*, D-*, "G#n" = Appendix G item n).
"""
from __future__ import annotations

import base64
import hashlib
import os
import sys
import time
import unittest

from tests.bridge_client import BridgeTestCase, BridgeClient, BridgeCallError, b64, bridge_available  # noqa: F401
from tests.support import deadline, wait_until
from tools.fakeboard import FakeBoard, PROFILES, PROGRAMS
from tools.mpunix_relay import UnixVM

ALL_PROFILES = ["esp32", "esp32-legacy", "esp32s3-usb", "rp2", "rp2350", "stm32", "esp8266", "custom-frozen", "unix-like"]
EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
WINDOWS = sys.platform == "win32"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pseudo_random(n, seed=7):
    """Deterministic incompressible-looking bytes (all 256 values occur, incl. 0x00 0x03 0x04 0x1b 0xff)."""
    out = bytearray()
    block = b"%d" % seed
    while len(out) < n:
        block = hashlib.sha256(block).digest()
        out += block
    return bytes(out[:n])


def hex_of(text):
    return text.encode("utf-8").hex()


def tmp_files(board):
    found = []
    for dirpath, _dirs, files in os.walk(board.root):
        found.extend(os.path.join(dirpath, f) for f in files if f.endswith(".mpytmp") or f.startswith("~"))
    return found


def man_paths(manifest):
    """{normalised absolute path: entry} (entries may carry absolute or root-relative paths)."""
    out = {}
    for e in manifest["entries"]:
        p = e["path"]
        out[p if p.startswith("/") else "/" + p] = e
    return out


def first_arrival(client, kind, needle, since):
    """``_t`` of the stream event at which ``needle`` first appears in the concatenated ``kind`` stream."""
    acc = b""
    for e in client.events_of(kind, since):
        acc += base64.b64decode(e["b64"])
        if needle in acc:
            return e["_t"]
    return None


# =====================================================================================================================
# G#1, G#2, G#12, G#16, G#18, G#22: process, connect, safety
# =====================================================================================================================
class ConnectTests(BridgeTestCase):
    def test_hello_is_first_and_unknown_ops_and_garbage_never_crash_the_bridge(self):
        """G#2, protocol 1/2/4: `hello` is the first line; an unknown op is an error object (E_UNSUPPORTED), a malformed
        line is E_PROTOCOL; the bridge keeps answering; stdout carries nothing but JSON lines."""
        c = self.new_bridge()
        self.assertEqual(c.events[0]["ev"], "hello")
        self.assertEqual(c.hello["proto"], 1)
        for key in ("bridge", "python", "pyserial", "platform", "pid", "vendored"):
            self.assertIn(key, c.hello)
        self.assertEqual(c.hello["pid"], c.pid)
        self.assertEqual(c.hello["pyserial"], "3.5")
        self.assertEqual(c.fail("no.such.op", "E_UNSUPPORTED")["code"], "E_UNSUPPORTED")
        c.send_raw(b"this is not json\n")
        c.send_raw(b'{"id": 4242, "op": 5}\n')
        resp = c.result(4242, 5)
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["code"], "E_PROTOCOL")
        c.ping()
        c.assert_clean_stdout()
        self.assertEqual(c.close(), 0)
        self.assertEqual(c.shutdown, "eof")

    def test_connect_without_reset_on_every_profile(self):
        """RQ-SAFE-1, RQ-GEN-4, protocol 3 (connect): connect + disconnect on all nine profiles show exactly 1 connect in the
        fake log and 0 soft resets, 0 hard resets, 0 raw-REPL entries, 0 execs, 0 interrupts."""
        for name in ALL_PROFILES:
            with self.subTest(profile=name):
                board = FakeBoard(profile=name)
                board.start()
                try:
                    c = BridgeClient()
                    try:
                        r = c.call("connect", port=board.url)
                        self.assertEqual((r["state"], r["sync"]), ("idle", "prompt"), r)
                        self.assertEqual(r["portInfo"]["kind"], "url")
                        c.call("disconnect")
                        wait_until(lambda: board.events.count("disconnect") == 1, 5, "the board to see the disconnect")
                    finally:
                        c.close()
                    self.assertEqual(board.events.count("connect"), 1)
                    self.assertNoReset(board, name)
                    for ev in ("raw_enter", "exec", "interrupt"):
                        self.assertEqual(board.events.count(ev), 0, "%s logged after a bare connect on %s" % (ev, name))
                finally:
                    board.stop()

    @deadline(240)
    def test_twenty_connect_disconnect_cycles_never_reset(self):
        """RQ-SAFE-1 (acceptance: 20 cycles), G#1: 20 connect/disconnect cycles in one bridge process; the fake log shows
        20 connects, 20 disconnects, 0 soft resets, 0 hard resets, no REPL entry; the board is at its prompt after each."""
        board = self.new_board("esp32")
        c = self.new_bridge()
        for i in range(20):
            r = c.call("connect", port=board.url) if i == 0 else self.reconnect(c, board)
            self.assertEqual((r["state"], r["sync"]), ("idle", "prompt"), (i, r))
            c.call("disconnect")
            wait_until(lambda: board.events.count("disconnect") == i + 1, 5, "disconnect %d" % (i + 1))
        self.assertEqual(board.events.count("connect"), 20)
        self.assertNoReset(board)
        self.assertEqual(board.events.count("raw_enter") + board.events.count("exec"), 0)
        c.assert_clean_stdout()

    def test_double_connect_and_ops_after_disconnect(self):
        """Protocol 3 error table: a second connect is E_ALREADY_CONNECTED; ops on a disconnected bridge are
        E_NOT_CONNECTED; disconnect is idempotent."""
        board, c, _ = self.connected("esp32")
        c.fail("connect", "E_ALREADY_CONNECTED", port=board.url)
        c.ping()
        c.call("disconnect")
        c.call("disconnect")
        c.fail("fs.list", "E_NOT_CONNECTED", path="/")
        c.fail("run", "E_NOT_CONNECTED", source="print(1)")
        self.assertEqual(board.events.count("connect"), 1)

    @unittest.skipIf(os.name != "posix", "needs a pty and flock")
    def test_busy_port_is_E_PORT_BUSY_and_retry_works_after_release(self):
        """R-ARCH-12, 05.11, 08.12, G#12: a port that another program holds (flock on a pty this test created) is
        classified E_PORT_BUSY with a message and a hint, the state stays disconnected; after the holder lets go the
        same connect succeeds. (A fake TCP board refused by an exclusive listener is ECONNREFUSED = E_NO_DEVICE by A.3, so
        the pty is the honest way to make a really busy port.)"""
        import fcntl
        master, slave = os.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        name = os.ttyname(slave)
        holder = os.open(name, os.O_RDWR | os.O_NOCTTY)
        released = []

        def release():
            if not released:
                released.append(1)
                os.close(holder)
        self.addCleanup(release)
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        c = self.new_bridge(harness_ptys=[name])
        err = c.fail("connect", "E_PORT_BUSY", port=name)
        self.assertTrue(err["message"] and err["hint"], err)
        self.assertEqual(c.events_of("state", state="idle"), [])
        release()
        r = c.call("connect", port=name)
        self.assertIn(r["sync"], ("silent", "prompt", "running-program", "prompt-unverified"), r)
        c.call("disconnect")

    def test_second_bridge_on_an_occupied_board_fails_cleanly(self):
        """G#12, R-ARCH-1: a second bridge process cannot take a board the first one holds: E_PORT_BUSY or E_NO_DEVICE
        (an exclusive socket listener is closed = ECONNREFUSED), the first session keeps working."""
        board, c1, _ = self.connected("esp32")
        c2 = self.new_bridge()
        err = c2.fail("connect", ("E_PORT_BUSY", "E_NO_DEVICE"), port=board.url)
        self.assertTrue(err["hint"])
        self.assertEqual(c1.call("fs.list", path="/")["entries"][0]["name"], "boot.py")
        self.assertEqual(board.events.count("connect"), 1)
        c2.call("ping")

    def test_safe_mode_refuses_real_port_names_before_any_open(self):
        """RQ-SAFE-6, protocol 8 / A.1 / B: with MPY_SAFE_MODE=1 (and no MPY_REAL_PORT) connect refuses real-looking ports with
        E_SAFE_MODE before any OS call. The guard is proven active with names that cannot exist FIRST; only then the
        real-looking names (this Mac has a real ESP32 at /dev/cu.usbserial-0001) are sent, to a guard already proven."""
        c = self.new_bridge()
        for probe in ("/dev/cu.mpy-scenarios-nonexistent-1", "COM98", "auto"):
            c.fail("connect", "E_SAFE_MODE", port=probe)
        for url in ("socket://127.0.0.1@example.invalid:80", "socket://127.attacker.invalid:80", "rfc2217://203.0.113.9:2217",
                    "hwgrep://10C4:EA60", "spy:///dev/cu.mpy-scenarios-nonexistent-2", "alt://nowhere"):
            c.fail("connect", "E_SAFE_MODE", port=url)
        for real in ("/dev/cu.usbserial-0001", "/dev/tty.usbserial-0001", "COM3", r"\\.\COM3", "com3"):
            err = c.fail("connect", "E_SAFE_MODE", port=real)
            self.assertTrue(err["hint"], err)
        c.fail("fs.list", "E_NOT_CONNECTED", path="/")
        self.assertEqual(c.events_of("state", state="connecting"), [])
        c.ping()

    def test_ports_list_shape_and_never_opens(self):
        """Protocol 3 (ports.list), D-11: pure metadata; works disconnected and connected, never touches the fake board,
        every entry has the documented keys, macOS lists only /dev/cu.*."""
        c = self.new_bridge()
        r = c.call("ports.list")
        self.assertIsInstance(r["ports"], list)
        for p in r["ports"]:
            for key in ("device", "vid", "pid", "serial", "manufacturer", "product", "description", "hwid", "likelyBoard"):
                self.assertIn(key, p)
            if sys.platform == "darwin":
                self.assertFalse(p["device"].startswith("/dev/tty."), p)
        board = self.new_board("esp32")
        c.call("connect", port=board.url)
        n_connect = board.events.count("connect")
        c.call("ports.list")
        self.assertEqual(board.events.count("connect"), n_connect)
        self.assertEqual(board.events.count("exec") + board.events.count("raw_enter"), 0)

    def test_hostile_working_directory_and_cp1252_environment(self):
        """G#18, R-ARCH-3, 01.9, 08.6, 05.9: `-I -X utf8`: student files named serial.py / json.py / errno.py in the cwd and a
        poisoned PYTHONPATH / PYTHONIOENCODING=cp1252 change nothing; a non-ASCII file name still round-trips."""
        hostile = self.local_dir(course=False)
        for n in ("serial.py", "json.py", "errno.py", "platformdirs.py", "base64.py", "threading.py"):
            self.write_local(hostile, n, "raise RuntimeError('student file %s was imported')\n" % n)
        board = self.new_board("esp32")
        c = self.new_bridge(cwd=hostile, env_extra={"PYTHONPATH": hostile, "PYTHONIOENCODING": "cp1252",
                                                    "PYTHONSTARTUP": os.path.join(hostile, "serial.py")})
        c.call("connect", port=board.url)
        src = self.write_local(self.local_dir(), "\u00fcnicode \u65e5\u672c.py", "print('\u00e9\u00e8')\n")
        c.call("fs.put", local=src, remote="/\u00fcnicode \u65e5\u672c.py")
        self.assertEqual(board.read_file("/\u00fcnicode \u65e5\u672c.py"), "print('\u00e9\u00e8')\n".encode("utf-8"))
        c.assert_clean_stdout()

    @unittest.skipIf(WINDOWS, "SIGTERM semantics differ on Windows")
    def test_sigterm_releases_the_port(self):
        """G#16, protocol 1: SIGTERM ends the bridge and the board sees the client go (the port is released)."""
        board, c, _ = self.connected("esp32")
        c.proc.terminate()
        c.wait_exit(10)
        wait_until(lambda: board.connected == 0, 5, "the board to see the bridge go away")
        self.assertEqual(board.events.count("hard_reset"), 0)


# =====================================================================================================================
# RQ-ID-1..3, RQ-GEN-4, D-15: identity per profile
# =====================================================================================================================
class IdentityTests(BridgeTestCase):
    def test_identity_per_profile(self):
        """RQ-ID-1, RQ-GEN-4, D-15: the read-only identity probe matches each profile's data (version, machine, build, unique id,
        platform, sys.path, hash/compile/paste caps); a board without os.uname()/unique_id()/_build reports empty strings,
        never absent keys; it imports no application package; it never resets."""
        for name in ALL_PROFILES:
            p = PROFILES[name]
            with self.subTest(profile=name):
                board = FakeBoard(profile=name, capture=True)
                board.start()
                try:
                    c = BridgeClient()
                    try:
                        c.call("connect", port=board.url)
                        ident = c.call("identity")
                    finally:
                        c.close()
                    self.assertEqual(ident["impl"], "micropython")
                    self.assertEqual(ident["version"], list(p["version_tuple"][:3]))
                    self.assertEqual(ident["machine"], p["machine"])
                    self.assertEqual(ident["build"], p["impl_extra"].get("_build") or "")
                    self.assertEqual(ident["platform"], p["platform"])
                    self.assertEqual(ident["uniqueId"], p["unique_id"].hex() if p["unique_id"] else "")
                    self.assertEqual(ident["syspath"], p["sys_path"])
                    self.assertIsInstance(ident["root"], list)
                    for key in ("sysname", "nodename", "release", "version", "machine"):
                        self.assertIn(key, ident["uname"])
                        self.assertIsInstance(ident["uname"][key], str)
                    if p["uname"]:
                        self.assertEqual(ident["uname"]["sysname"], p["sysname"])
                        self.assertEqual(ident["uname"]["release"], p["release"])
                    else:
                        self.assertEqual(set(ident["uname"].values()), {""}, "no os.uname(): empty strings")
                    hashlib_cap = p["caps"]["hashlib"]
                    self.assertEqual(ident["caps"]["hash"], "sha256" if hashlib_cap in (True, "sha256") else "none")
                    self.assertEqual(ident["caps"]["compile"], bool(p["caps"]["compile"]))
                    self.assertIs(ident["caps"]["paste"], bool(p["caps"]["raw_paste"]))
                    self.assertGreater(ident["caps"]["mem"], 0)
                    hints = ident["profileHints"]
                    self.assertIsInstance(hints["modules"], list)
                    self.assertGreater(hints["fsTotal"], 0)
                    codes = "\n".join(e.get("code", "") for e in board.events.of("exec"))
                    self.assertGreater(len(codes), 0)
                    self.assertNotIn("acme", codes.lower(), "the probe must not import application packages")
                    self.assertNoReset(board, name)
                finally:
                    board.stop()

    def test_custom_firmware_identity_lists_its_frozen_package(self):
        """D-15, RQ-ID-4 (amended): a custom firmware is recognised by DATA (build, machine), nothing about it is hard coded;
        the frozen package and the C module show up in profileHints.modules, frozen is true."""
        board, c, _ = self.connected("custom-frozen")
        ident = c.call("identity")
        self.assertEqual(ident["build"], "ACME_BOARD")
        self.assertEqual(ident["machine"], "ACME Motor Controller with ESP32")
        self.assertTrue(ident["profileHints"]["frozen"])
        mods = ident["profileHints"]["modules"]
        self.assertIn("acme", mods)
        self.assertIn("_acme", mods)

    def test_boards_without_sha256_report_hash_none_and_verify_by_size(self):
        """Protocol 3 (fs.manifest `hash:"none"`), RQ-GEN: esp8266 (sha1 only) and a build without hashlib: identity says
        `hash:"none"`, the manifest says `hash:"none"` and carries no sha256, uploads are verified by size and work."""
        for label, kw in (("esp8266", dict(profile="esp8266")), ("no_hashlib", dict(profile="esp32", faults=["no_hashlib"]))):
            with self.subTest(board=label):
                board = FakeBoard(**kw)
                board.start()
                try:
                    c = BridgeClient()
                    try:
                        c.call("connect", port=board.url)
                        self.assertEqual(c.call("identity")["caps"]["hash"], "none")
                        src = self.write_local(self.local_dir(), "x.txt", b"abc" * 100)
                        r = c.call("fs.put", local=src, remote="/x.txt")
                        self.assertEqual(r["verified"], "size")
                        self.assertEqual(board.read_file("/x.txt"), b"abc" * 100)
                        man = c.call("fs.manifest", root="/")
                        self.assertEqual(man["hash"], "none")
                        self.assertTrue(all("sha256" not in e for e in man["entries"]), man)
                        self.assertEqual(man_paths(man)["/x.txt"]["size"], 300)
                    finally:
                        c.close()
                finally:
                    board.stop()


# =====================================================================================================================
# G#3..G#7, RQ-CLOUD-1, RQ-ID-4: file operations
# =====================================================================================================================
class FileOpTests(BridgeTestCase):
    NAMES = ["with space.py", "it's.py", 'dq"uote.py', "eq=ual.py", "\u00fcn\u00ef-\u00e9.py", "\u65e5\u672c\u8a9e.py",
             "emoji-\U0001F600.py", "a;b&c|d$e.py", "100%.py", "#hash.py", "ls", "tree", "UPPER.PY", "dot.dot.dot.txt",
             "  lead.txt", "x" * 90 + ".py"]
    NAMES_POSIX_ONLY = ["tab\there.py", "line\nbreak.py", "back\\slash.py"]

    def test_weird_file_names_round_trip(self):
        """G#3, 03.2, 03.1, RQ-CLOUD-1: names with spaces, quotes, `=`, shell metacharacters, non-ASCII, emoji, newline and
        backslash (and files called `ls` / `tree`) can be put, listed with correct sizes, stat'ed, manifested, fetched
        byte-identical, renamed and removed; local paths have spaces and parentheses."""
        board, c, _ = self.connected("esp32")
        folder = self.local_dir()
        names = self.NAMES + ([] if WINDOWS else self.NAMES_POSIX_ONLY)
        c.call("fs.mkdir", path="/w")
        contents = {}
        for i, name in enumerate(names):
            data = ("content of %r #%d\r\n" % (name, i)).encode("utf-8") + bytes(range(i, i + 20))
            contents[name] = data
            src = self.write_local(folder, "src (%d) \u00e9.bin" % i, data)
            c.call("fs.put", local=src, remote="/w/" + name)
        listing = {e["name"]: e for e in c.call("fs.list", path="/w")["entries"]}
        self.assertEqual(set(listing), set(names))
        man = man_paths(c.call("fs.manifest", root="/w"))
        for name, data in contents.items():
            with self.subTest(name=name):
                self.assertEqual((listing[name]["type"], listing[name]["size"]), ("file", len(data)))
                st = c.call("fs.stat", path="/w/" + name)
                self.assertEqual((st["exists"], st["type"], st["size"]), (True, "file", len(data)))
                self.assertEqual(man["/w/" + name]["sha256"], sha(data))
                back = os.path.join(folder, "back", "r (%d).bin" % names.index(name))
                got = c.call("fs.get", remote="/w/" + name, local=back)
                self.assertEqual((got["bytes"], got["sha256"]), (len(data), sha(data)))
                with open(back, "rb") as f:
                    self.assertEqual(f.read(), data)
        c.call("fs.mv", src="/w/" + names[0], dst="/w/renamed \u00e9 (1).py")
        self.assertTrue(board.exists("/w/renamed \u00e9 (1).py"))
        self.assertFalse(board.exists("/w/" + names[0]))
        for name in names[1:]:
            c.call("fs.rm", path="/w/" + name)
        self.assertEqual([e["name"] for e in c.call("fs.list", path="/w")["entries"]], ["renamed \u00e9 (1).py"])
        self.assertNoReset(board)
        self.assertEqual(tmp_files(board), [])

    def test_fs_stat_shapes(self):
        """Protocol 3 (fs.stat) / A.4: exists/type/size for files and folders; missing and below-a-file are {exists:false}."""
        board, c, _ = self.connected("esp32", board_kw=dict(files={"/d/f.txt": "12345"}))
        f = c.call("fs.stat", path="/d/f.txt")
        self.assertEqual((f["exists"], f["type"], f["size"]), (True, "file", 5))
        self.assertEqual((c.call("fs.stat", path="/d")["exists"], c.call("fs.stat", path="/d")["type"]), (True, "dir"))
        self.assertFalse(c.call("fs.stat", path="/nope")["exists"])
        self.assertFalse(c.call("fs.stat", path="/d/f.txt/below")["exists"])
        c.fail("fs.stat", "E_PROTOCOL", path="relative/path")
        c.fail("fs.stat", "E_PROTOCOL", path="/a/../b")

    def test_upload_twenty_files_and_manifest_in_one_port_session(self):
        """G#1, G#4, 03.7, 03.6, 05.17: 20 files in nested folders (parents created, written to a temp name and renamed,
        hash verified) plus a manifest whose sha256 values equal the host's, all in ONE port session: the fake log has a
        single connect, no disconnect, no soft reset, no leftover .mpytmp."""
        board, c, _ = self.connected("esp32")
        folder = self.local_dir()
        expect = {}
        for i in range(20):
            data = (b"# module %d\r\n" % i) + pseudo_random(i * 150, i)
            rel = "lab/part%d/mod_%02d.py" % (i // 5, i)
            src = self.write_local(folder, rel, data)
            r = c.call("fs.put", local=src, remote="/" + rel)
            self.assertEqual((r["bytes"], r["sha256"], r["skipped"]), (len(data), sha(data), False), r)
            self.assertEqual(r["verified"], "sha256")
            expect["/" + rel] = data
        before = board.events.count("exec")
        man = c.call("fs.manifest", root="/lab")
        self.assertEqual(board.events.count("exec") - before, 1, "the manifest of a whole tree is ONE round trip (G#4)")
        self.assertEqual(man["hash"], "sha256")
        self.assertFalse(man["truncated"])
        entries = man_paths(man)
        for path, data in expect.items():
            self.assertEqual((entries[path]["type"], entries[path]["size"], entries[path]["sha256"]), ("file", len(data), sha(data)))
        dirs = {p for p, e in entries.items() if e["type"] == "dir"}
        self.assertLessEqual({"/lab/part%d" % k for k in range(4)}, dirs)
        for path, data in expect.items():
            self.assertEqual(board.read_file(path), data)
        self.assertEqual(board.events.count("connect"), 1)
        self.assertEqual(board.events.count("disconnect"), 0)
        self.assertNoReset(board)
        self.assertEqual(tmp_files(board), [])
        c.call("disconnect")
        wait_until(lambda: board.events.count("disconnect") == 1, 5)

    def test_put_get_round_trip_keeps_crlf_binary_and_skips_unchanged(self):
        """G#6, G#5, 03.10, protocol 3 (fs.put expectSha): CRLF, NUL, 0x03, 0x04, 0x1b and non-UTF-8 bytes survive both ways; the
        upload goes through a `.mpytmp` temp name and a rename; progress events arrive for a 100 KB file; a second put with
        the matching `expectSha` is skipped (sent 0)."""
        board, c, _ = self.connected("esp32", board_kw=dict(capture=True))
        folder = self.local_dir()
        data = b"line1\r\nline2\r\n\x00\x03\x04\x1b\xff\xfe" * 20 + b"\n" + bytes(range(256)) + pseudo_random(100_000, 3)
        src = self.write_local(folder, "big (copy).bin", data)
        rid = c.send("fs.put", local=src, remote="/a/b/big.bin")
        r = c.result(rid, 60)
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["bytes"], r["sha256"]), (len(data), sha(data)))
        prog = c.events_of("progress", id=rid)
        self.assertTrue(prog, "no progress events for a 100 KB upload")
        self.assertEqual(prog[-1]["total"], len(data))
        self.assertLessEqual(prog[-1]["done"], prog[-1]["total"])
        self.assertEqual(board.read_file("/a/b/big.bin"), data)
        self.assertTrue(any(".mpytmp".encode().hex() in e.get("code", "") or ".mpytmp" in e.get("code", "")
                            for e in board.events.of("exec")), "no .mpytmp temp name seen in the executed snippets")
        self.assertEqual(tmp_files(board), [])
        again = c.call("fs.put", local=src, remote="/a/b/big.bin", expectSha=sha(data))
        self.assertTrue(again["skipped"], again)
        self.assertEqual(again["sent"], 0)
        stale = c.call("fs.put", local=src, remote="/a/b/big.bin", expectSha="0" * 64)
        self.assertFalse(stale["skipped"], "a stale expectSha must never skip (A.4)")
        back = os.path.join(folder, "new dir", "back.bin")
        got = c.call("fs.get", remote="/a/b/big.bin", local=back, _timeout=60)
        self.assertEqual((got["bytes"], got["sha256"]), (len(data), sha(data)))
        with open(back, "rb") as f:
            self.assertEqual(f.read(), data)
        self.assertFalse(os.path.exists(back + ".mpytmp"))

    def test_manifest_hashes_for_empty_text_binary_and_100kb_files(self):
        """G#4: sha256 equals the host's for empty, text, binary and 100 KB files; `exclude` skips a subtree."""
        files = {"/m/empty": b"", "/m/text.txt": "h\u00e9llo\n".encode("utf-8"), "/m/bin.bin": bytes(range(256)) * 3,
                 "/m/big.dat": pseudo_random(100_000, 11), "/m/skip/inner.txt": b"inner"}
        board, c, _ = self.connected("esp32", board_kw=dict(files=files))
        man = c.call("fs.manifest", root="/m")
        entries = man_paths(man)
        for path, data in files.items():
            self.assertEqual(entries[path]["sha256"], sha(data), path)
        self.assertEqual(entries["/m/empty"]["sha256"], EMPTY_SHA)
        man = c.call("fs.manifest", root="/m", exclude=["/m/skip"])
        self.assertNotIn("/m/skip/inner.txt", man_paths(man))
        self.assertNotIn("/m/skip/inner.txt", man_paths(c.call("fs.manifest", root="/m", exclude=["skip"])))
        nohash = c.call("fs.manifest", root="/m", hash=False)
        self.assertTrue(all("sha256" not in e for e in nohash["entries"]))

    def test_mkdir_mv_rm_rmtree_and_their_errors(self):
        """G#7, 03.1, 03.5, 03.12, A.4: mkdir with parents, mv never overwrites, rm of a missing path is an error (not silent
        success), rm of a folder is EISDIR, rmtree needs confirm:true, refuses `/`, counts files and folders; every device
        error is E_FS_ERRNO with the errno NAME in detail."""
        board, c, _ = self.connected("esp32", board_kw=dict(files={"/t/a.txt": "a", "/t/sub/b.txt": "b", "/t/sub/deep/c.txt": "c"}))
        self.assertEqual(c.call("fs.mkdir", path="/m1/m2/m3")["created"], 3)
        self.assertEqual(c.call("fs.mkdir", path="/m1/m2/m3")["created"], 0)
        self.assertIn("ENOENT", c.fail("fs.mkdir", "E_FS_ERRNO", path="/p/q/r", parents=False)["detail"])
        c.call("fs.mv", src="/t/a.txt", dst="/t/sub/a2.txt")
        self.assertTrue(board.exists("/t/sub/a2.txt") and not board.exists("/t/a.txt"))
        self.assertIn("EEXIST", c.fail("fs.mv", "E_FS_ERRNO", src="/t/sub/a2.txt", dst="/t/sub/b.txt")["detail"])
        self.assertEqual(board.read_file("/t/sub/b.txt"), b"b")
        self.assertIn("ENOENT", c.fail("fs.rm", "E_FS_ERRNO", path="/t/missing.txt")["detail"])
        self.assertIn("EISDIR", c.fail("fs.rm", "E_FS_ERRNO", path="/t/sub")["detail"])
        c.call("fs.rm", path="/t/sub/a2.txt")
        c.fail("fs.rmtree", "E_PROTOCOL", path="/t")
        self.assertTrue(board.exists("/t/sub/deep/c.txt"), "rmtree without confirm deleted something")
        for bad in ("/", "", "//", "/."):
            c.fail("fs.rmtree", "E_PROTOCOL", path=bad, confirm=True)
        self.assertIn("ENOENT", c.fail("fs.rmtree", "E_FS_ERRNO", path="/nowhere", confirm=True)["detail"])
        self.assertIn("ENOTDIR", c.fail("fs.rmtree", "E_FS_ERRNO", path="/t/sub/b.txt", confirm=True)["detail"])
        removed = c.call("fs.rmtree", path="/t", confirm=True)["removed"]
        self.assertEqual(removed, 5)               # b.txt, c.txt, deep, sub, t
        self.assertFalse(board.exists("/t"))
        self.assertTrue(board.exists("/boot.py"))

    def test_rmtree_refuses_a_top_level_mount_point(self):
        """03.5 / B (allowMount): on a pyboard `/flash` is a mount point; rmtree of it is refused (E_FS_ERRNO, detail EPERM)
        unless allowMount is passed; nothing is deleted."""
        board, c, _ = self.connected("stm32")
        c.call("identity")
        err = c.fail("fs.rmtree", "E_FS_ERRNO", path="/flash", confirm=True)
        self.assertIn("EPERM", err["detail"])
        self.assertTrue(board.exists("/flash/boot.py"))
        self.assertEqual(board.events.count("hard_reset") + board.events.count("soft_reset"), 0)

    def test_device_and_local_errors_are_classified(self):
        """G#5, 02.15: read-only filesystem -> E_FS_ERRNO EROFS (temp file cleaned), disk full -> ENOSPC, a missing local file
        -> E_LOCAL_IO, an unwritable local target -> E_LOCAL_IO; every error has code/message/detail/hint."""
        folder = self.local_dir()
        src = self.write_local(folder, "ok.txt", b"x" * 10_000)
        board, c, _ = self.connected("esp32", faults=["readonly_fs"])
        err = c.fail("fs.put", "E_FS_ERRNO", local=src, remote="/ro.txt")
        self.assertIn("EROFS", err["detail"])
        self.assertEqual(tmp_files(board), [])
        c.fail("fs.put", "E_LOCAL_IO", local=os.path.join(folder, "does not exist.txt"), remote="/x.txt")
        board2, c2, _ = self.connected("esp32", faults=["disk_full:4096"])
        err = c2.fail("fs.put", "E_FS_ERRNO", local=src, remote="/full.txt")
        self.assertIn("ENOSPC", err["detail"])
        self.assertEqual(tmp_files(board2), [])
        board2.write_file("/small.txt", "hello")
        blocker = self.write_local(folder, "blocker", b"file, not a folder")
        c2.fail("fs.get", "E_LOCAL_IO", remote="/small.txt", local=os.path.join(blocker, "under", "x.txt"))

    def test_shadow_guard_refuses_module_names_before_touching_the_board(self):
        """RQ-ID-4, 08.15, B (shadow guard): with config shadowGuard=[shield, _shield] a put / mkdir / mv that would create
        /shield.py, /shield/__init__.py, /_shield.mpy, /lib/shield.py or /Shield.py is E_SHADOWS_MODULE, refused before ANY
        exec; harmless names and non-import folders are fine."""
        board, c, _ = self.connected("esp32")
        c.call("config", shadowGuard=["shield", "_shield"])
        src = self.write_local(self.local_dir(), "any.py", "x = 1\n")
        n_exec = board.events.count("exec")
        for remote in ("/shield.py", "/shield/__init__.py", "/_shield.mpy", "/lib/shield.py", "/Shield.py"):
            with self.subTest(remote=remote):
                c.fail("fs.put", "E_SHADOWS_MODULE", local=src, remote=remote)
        c.fail("fs.mkdir", "E_SHADOWS_MODULE", path="/shield")
        self.assertEqual(board.events.count("exec"), n_exec, "a refused request must not reach the board")
        for remote in ("/sub/shield.py", "/shields.py", "/lib/other.py"):
            c.call("fs.put", local=src, remote=remote)
        c.fail("fs.mv", "E_SHADOWS_MODULE", src="/shields.py", dst="/shield.py")
        self.assertTrue(board.exists("/shields.py"))
        self.assertFalse(board.exists("/shield.py"))

    def test_shadow_guard_uses_the_boards_own_import_roots_and_module_inventory(self):
        """B (the bridge must fill the guard from identity.syspath and identity.profileHints.modules), RQ-ID-4 amended, D-15: on a
        pyboard the import roots are /flash and /flash/lib; on a custom firmware the frozen package `acme` and stdlib
        names (json) are protected without any client configuration after one identity call."""
        src = self.write_local(self.local_dir(), "any.py", "x = 1\n")
        board, c, _ = self.connected("stm32")
        c.call("config", shadowGuard=["shield"])
        c.call("identity")
        c.fail("fs.put", "E_SHADOWS_MODULE", local=src, remote="/flash/shield.py")
        c.fail("fs.put", "E_SHADOWS_MODULE", local=src, remote="/flash/lib/shield.py")
        board2, c2, _ = self.connected("custom-frozen")
        c2.call("identity")
        c2.fail("fs.put", "E_SHADOWS_MODULE", local=src, remote="/acme.py")
        c2.fail("fs.put", "E_SHADOWS_MODULE", local=src, remote="/json.py")
        c2.call("fs.put", local=src, remote="/lab1.py")


# =====================================================================================================================
# G#8, G#19, G#20, RQ-RUN-1/2, RQ-SAFE-3/4: run, stop, keystrokes
# =====================================================================================================================
class RunTests(BridgeTestCase):
    def test_run_streams_output_and_traceback_cites_the_local_path(self):
        """G#8, D-07, RQ-RUN-2, RQ-CLOUD-1: the program runs as __main__, its output streams as `out` events, the traceback
        (`err`) cites the LOCAL path with spaces and parentheses (clickable), exit is "exception"; the state goes
        running then idle; the soft reset belongs to Run (exactly one) and main.py is not run from raw mode."""
        board, c, _ = self.connected("esp32", board_kw=dict(files={"/main.py": "print('MAIN-RAN')\n"}))
        folder = self.local_dir()
        self.assertIn("OneDrive-Washington State University(email.wsu.edu)", folder)
        src = ("import sys\n" "print('start', __name__)\n" "\n" "def f(x):\n" "    return 10 / x\n" "\n"
               "print('before')\n" "f(0)\n")
        path = self.write_local(folder, "test.py", src)
        m = c.mark()
        r = c.call("run", local=path, _timeout=30)
        self.assertEqual(r["exit"], "exception", r)
        self.assertIsInstance(r["durationMs"], int)
        out = c.wait_out(b"before\r\n", 5, since=m)
        self.assertEqual(out, b"start __main__\r\nbefore\r\n")
        err = c.wait_stream("err", b"ZeroDivisionError", 5, since=m)
        self.assertIn(('File "%s", line 5, in f' % path).encode("utf-8"), err)
        self.assertIn(('File "%s", line 8, in <module>' % path).encode("utf-8"), err)
        states = c.states(m)
        self.assertIn("running", states)
        self.assertEqual(states[-1], "idle")
        self.assertLess(states.index("running"), len(states) - 1)
        self.assertEqual(board.events.count("soft_reset"), 1)
        self.assertEqual(board.events.count("program_start", kind="main.py"), 1, "main.py ran once at power-on, never from raw mode")
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")

    def test_run_source_and_name_and_exit_values(self):
        """Protocol 3 (run `source` + `name`), 5: a traceback cites `name`; clean end is exit "ok"; a missing local file is
        E_LOCAL_IO; `compile` makes __name__ == "__main__"."""
        board, c, _ = self.connected("esp32")
        m = c.mark()
        r = c.call("run", source="print(__name__)\nraise ValueError('boom')\n", name="Lab 1 (final)/test.py")
        self.assertEqual(r["exit"], "exception")
        self.assertIn(b'File "Lab 1 (final)/test.py", line 2', c.wait_stream("err", b"ValueError: boom", 5, since=m))
        m = c.mark()
        self.assertEqual(c.call("run", source="print('fine')")["exit"], "ok")
        c.wait_out(b"fine\r\n", 5, since=m)
        c.fail("run", "E_LOCAL_IO", local=os.path.join(self.local_dir(), "missing.py"))

    def test_keystrokes_reach_the_running_program_within_100ms(self):
        """RQ-RUN-1, N-9: `tty.write` bytes reach a program that reads sys.stdin: each key arrives at the device and the
        program's reaction is on the `out` stream well within 100 ms (median) while the run is still pending."""
        board, c, _ = self.connected("esp32")
        rid = self.start_program(c, PROGRAMS["echo_keys"], "keys.py", ready=b"READY")
        self.assertFalse(c.has_result(rid), "READY streamed while the program is still running (not buffered to the end)")
        dev, react = [], []
        for ch in b"abcde":
            bm, m = board.events.mark(), c.mark()
            t0 = c.tty_write(bytes([ch]))
            e = board.events.wait_for("stdin_bytes", 2.0, since=bm)
            self.assertIsNotNone(e, "key %r never reached the board" % chr(ch))
            dev.append(e["t"] - t0)
            c.wait_out(("key:'%s'" % chr(ch)).encode(), 2.0, since=m)
            react.append(first_arrival(c, "out", ("key:'%s'" % chr(ch)).encode(), m) - t0)
        dev.sort()
        react.sort()
        self.assertLess(dev[len(dev) // 2], 0.1, "median keystroke-to-device latency %s" % dev)
        self.assertLess(dev[-1], 0.5, dev)
        self.assertLess(react[len(react) // 2], 0.1, "median keystroke-to-output latency %s" % react)
        self.assertLess(react[-1], 0.5, react)
        c.tty_write(b"q")
        self.assertEqual(c.result(rid, 10)["exit"], "ok")
        self.assertIn(b"DONE", c.wait_out(b"DONE", 3))

    def test_course_demo_pattern_select_poll_on_stdin(self):
        """RQ-RUN-1, N-9: a program that polls sys.stdin with select.poll() (the course demo pattern) sees the forwarded keys
        and idles in between."""
        board, c, _ = self.connected("esp32")
        rid = self.start_program(c, PROGRAMS["poll_keys"], "poll.py", ready=b"READY")
        c.tty_write(b"x")
        c.tty_write(b"y")
        self.assertEqual(c.result(rid, 10)["exit"], "ok")
        self.assertIn(b"got ['x', 'y']", c.wait_out(b"got ['x', 'y']", 3))

    def test_blocking_input_gets_a_line_from_tty_write(self):
        """G#8 (blocking input()): input() blocks until the client writes a line with tty.write; the prompt text is streamed."""
        board, c, _ = self.connected("esp32")
        rid = self.start_program(c, PROGRAMS["ask_name"], "ask.py", ready=b"name? ")
        self.assertFalse(c.has_result(rid))
        c.tty_write(b"Bob\n")
        self.assertEqual(c.result(rid, 10)["exit"], "ok")
        c.wait_out(b"hi Bob", 3)

    def test_ctrl_c_through_tty_write_is_a_plain_interrupt(self):
        """Protocol 3 (tty.write): `\\x03` written to a running program interrupts it (KeyboardInterrupt, exit "interrupted"),
        the board stays usable and was not reset again."""
        board, c, _ = self.connected("esp32")
        rid = self.start_program(c, PROGRAMS["sleep_loop"], "loop.py")
        c.tty_write(b"\x03")
        self.assertEqual(c.result(rid, 10)["exit"], "interrupted")
        c.wait_state("idle", 5)
        self.assertEqual(board.events.count("soft_reset"), 1)
        self.assertEqual(board.events.count("hard_reset"), 0)
        c.call("fs.list", path="/")

    def test_stop_is_fast_and_the_board_is_usable_afterwards(self):
        """RQ-SAFE-3, G#8, G#10, A.2/B: stop bypasses the queue, the run ends "interrupted", `stopped` is true within 200 ms on an
        interruptible program (wall clock < 1 s), the state returns to idle, file ops and a second run work, and
        Stop never reset the board (one soft reset per Run, no hard reset)."""
        board, c, _ = self.connected("esp32")
        rid = self.start_program(c, PROGRAMS["sleep_loop"], "loop.py")
        m = c.mark()
        t0 = time.monotonic()
        stop = c.call("stop")
        wall = time.monotonic() - t0
        self.assertTrue(stop["stopped"], stop)
        self.assertLessEqual(stop["ms"], 200, stop)
        self.assertLess(wall, 1.0)
        self.assertEqual(c.result(rid, 10)["exit"], "interrupted")
        c.wait_state("idle", 5, since=m)
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")
        self.assertEqual(c.call("run", source="print('again')")["exit"], "ok")
        self.assertEqual(board.events.count("soft_reset"), 2)
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_stop_twice_and_stop_when_idle(self):
        """G#10, RQ-SAFE-3: stop on an idle board answers stopped:true at once and resets nothing; a second stop after a
        stopped run is the same; stop never enters the raw REPL on an idle friendly prompt."""
        board, c, _ = self.connected("esp32")
        r = c.call("stop")
        self.assertTrue(r["stopped"])
        self.assertEqual(board.events.count("raw_enter") + board.events.count("exec"), 0)
        self.assertNoReset(board)
        rid = self.start_program(c, PROGRAMS["sleep_loop"], "loop.py")
        self.assertTrue(c.call("stop")["stopped"])
        self.assertTrue(c.call("stop")["stopped"])
        self.assertEqual(c.result(rid, 10)["exit"], "interrupted")
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")

    def test_stop_of_a_program_that_catches_ctrl_c_says_so_and_does_not_reset(self):
        """RQ-SAFE-2, RQ-SAFE-3, G#8 (a program that swallows KeyboardInterrupt), G#10: stop answers stopped:false after its
        timeout, the program keeps running, and nothing escalates to a reset (soft or hard); the run is still pending."""
        board, c, _ = self.connected("esp32")
        rid = self.start_program(c, PROGRAMS["swallow_ctrl_c"], "swallow.py", ready=b"loop")
        soft_before = board.events.count("soft_reset")
        t0 = time.monotonic()
        r = c.call("stop", timeoutMs=1200, _timeout=15)
        self.assertFalse(r["stopped"], r)
        self.assertLess(time.monotonic() - t0, 6.0)
        self.assertTrue(board.program_running)
        self.assertFalse(c.has_result(rid))
        self.assertGreaterEqual(board.events.count("interrupt"), 2, "Ctrl-C twice")
        self.assertEqual(board.events.count("soft_reset"), soft_before)
        self.assertEqual(board.events.count("hard_reset"), 0)
        c.ping()

    def test_stdin_eof_while_a_program_runs_interrupts_it_before_the_port_closes(self):
        """RQ-SAFE-4, protocol 1 (a)-(c), R-ARCH-3: closing the bridge's stdin while a while-True program runs sends Ctrl-C to
        the board BEFORE the port is closed (the interrupt precedes the disconnect in the fake log), the program ends,
        the bridge exits 0 and nothing is reset beyond Run's own soft reset."""
        board, c, _ = self.connected("esp32")
        self.start_program(c, PROGRAMS["sleep_loop"], "loop.py")
        self.assertTrue(board.program_running)
        mark = len(board.events)
        self.assertEqual(c.close(), 0)
        self.assertEqual(c.shutdown, "eof")
        wait_until(lambda: board.events.count("disconnect") >= 1, 5, "the port to be closed")
        evs = list(board.events)[mark:]
        ints = [e["seq"] for e in evs if e["ev"] == "interrupt"]
        disc = [e["seq"] for e in evs if e["ev"] == "disconnect"]
        self.assertTrue(ints, "no Ctrl-C reached the board")
        self.assertLess(ints[0], disc[0], "the program was interrupted only AFTER the port closed")
        wait_until(lambda: not board.program_running, 3, "the program to end")
        self.assertEqual(board.events.count("hard_reset"), 0)
        self.assertEqual(board.events.count("soft_reset"), 1)

    @unittest.skipIf(WINDOWS, "needs POSIX pid probes")
    def test_parent_kill_9_interrupts_the_running_program(self):
        """RQ-SAFE-4 (acceptance: kill -9 of the parent while a while-True program runs): an extension-host stand-in starts the
        bridge, connects and runs a loop; it is SIGKILLed; the bridge sees stdin EOF, interrupts the program BEFORE the
        disconnect appears in the fake log, and exits (no orphan holding the port)."""
        from tests.bridge_client import OrphanableBridge
        board = self.new_board("esp32")
        orphan = OrphanableBridge(board.url, PROGRAMS["sleep_loop"], "loop.py")
        self.addCleanup(orphan.cleanup)
        self.addWatchdogCleanup(orphan.cleanup)
        orphan.wait_ready()
        wait_until(lambda: board.program_running and self.user_programs_started(board) >= 1, 15, "the loop to run on the board")
        mark = len(board.events)
        orphan.kill_parent()
        wait_until(lambda: board.events.count("disconnect") >= 1, 15, "the bridge to release the port after its parent died")
        evs = list(board.events)[mark:]
        ints = [e["seq"] for e in evs if e["ev"] == "interrupt"]
        disc = [e["seq"] for e in evs if e["ev"] == "disconnect"]
        self.assertTrue(ints, "the orphaned bridge never interrupted the program")
        self.assertLess(ints[0], disc[0])
        wait_until(lambda: not board.program_running, 5, "the program to be gone")
        wait_until(lambda: not orphan.bridge_alive(), 10, "the orphaned bridge to exit")
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_shutdown_op_replies_then_behaves_like_stdin_eof(self):
        """Protocol 3 (shutdown): replies ok, interrupts a running program before closing the port, exits 0."""
        board, c, _ = self.connected("esp32")
        self.start_program(c, PROGRAMS["sleep_loop"], "loop.py")
        mark = len(board.events)
        c.call("shutdown")
        self.assertEqual(c.wait_exit(10), 0)
        wait_until(lambda: board.events.count("disconnect") >= 1, 5)
        evs = list(board.events)[mark:]
        ints = [e["seq"] for e in evs if e["ev"] == "interrupt"]
        disc = [e["seq"] for e in evs if e["ev"] == "disconnect"]
        self.assertTrue(ints and ints[0] < disc[0])

    @deadline(150)
    def test_one_megabyte_of_output_does_not_block_the_bridge(self):
        """G#19: 1 MB of program output arrives complete and in order as `out` events while `ping` keeps being answered quickly
        (back-pressure works, the reader never stalls)."""
        board, c, _ = self.connected("esp32")
        src = "for i in range(10000):\n    print('x' * 99)\n"
        m = c.mark()
        rid = c.send("run", source=src, name="flood.py")
        worst = 0.0
        while not c.has_result(rid):
            t0 = time.monotonic()
            c.ping(5)
            worst = max(worst, time.monotonic() - t0)
        self.assertEqual(c.result(rid, 5)["exit"], "ok")
        self.assertLess(worst, 1.5, "ping latency during the flood")
        c.wait_stream("out", b"x" * 99 + b"\r\n", 5, since=m)
        wait_until(lambda: len(c.out_bytes(m)) >= 10000 * 101, 30, "all output bytes")
        self.assertEqual(c.out_bytes(m), (b"x" * 99 + b"\r\n") * 10000)

    def test_multibyte_output_is_passed_through_as_bytes(self):
        """G#20: UTF-8 output (accents, CJK, emoji) reaches the client byte-exact in base64, so the terminal can decode it even
        when a character is split across reads (the board is throttled to 9600 baud to force splits)."""
        board, c, _ = self.connected("esp32", faults=["slow:19200"])
        text = "h\u00e9llo \u65e5\u672c\u8a9e \U0001F600 " * 6
        m = c.mark()
        self.assertEqual(c.call("run", source="print(%r)" % text, _timeout=30)["exit"], "ok")
        data = c.wait_out((text + "\r\n").encode("utf-8"), 10, since=m)
        self.assertEqual(data.decode("utf-8"), text + "\r\n")


# =====================================================================================================================
# G#9: REPL attached
# =====================================================================================================================
class ReplTests(BridgeTestCase):
    def test_file_ops_while_the_repl_is_attached_keep_the_repl_state(self):
        """G#9, 02.3, 02.10, protocol 5 (idle + file op): with the REPL attached, mkdir/put/list/manifest work without a reset,
        the state goes through rawop and back to idle, the raw-REPL banner never reaches the `repl` stream, the prompt is
        redrawn, and a variable typed before the ops is still there afterwards."""
        board, c, _ = self.connected("esp32")
        c.call("repl.attach")
        m = c.mark()
        c.tty_write(b"keepme = 123\r\n")
        c.wait_stream("repl", b"keepme = 123\r\n>>> ", 5, since=m)
        m2 = c.mark()
        src = self.write_local(self.local_dir(), "x (1).py", b"print('x')\n")
        c.call("fs.mkdir", path="/lab")
        c.call("fs.put", local=src, remote="/lab/x.py")
        self.assertEqual([e["name"] for e in c.call("fs.list", path="/lab")["entries"]], ["x.py"])
        c.call("fs.manifest", root="/")
        self.assertIn("rawop", c.states(m2))
        self.assertEqual(c.states(m2)[-1], "idle")
        repl = c.repl_bytes(m2)
        self.assertNotIn(b"raw REPL", repl)
        self.assertNotIn(b"soft reboot", repl)
        m3 = c.mark()
        c.tty_write(b"keepme + 1\r\n")
        data = c.wait_stream("repl", b"124\r\n>>> ", 5, since=m3)
        self.assertIn(b"keepme + 1", data)
        self.assertNoReset(board)

    def test_repl_detach_stops_the_repl_events_and_keeps_the_port(self):
        """Protocol 3 (repl.detach): after detach no `repl` events arrive, the port stays open (no disconnect), the REPL
        variable survives a second attach."""
        board, c, _ = self.connected("esp32")
        c.call("repl.attach")
        m = c.mark()
        c.tty_write(b"detach_probe = 41\r\n")
        c.wait_stream("repl", b"detach_probe = 41", 5, since=m)
        c.call("repl.detach")
        m = c.mark()
        c.tty_write(b"detach_probe + 1\r\n")
        c.call("fs.list", path="/")
        self.assertEqual(c.events_of("repl", m), [])
        self.assertEqual(board.events.count("disconnect"), 0)
        c.call("repl.attach")
        m = c.mark()
        c.tty_write(b"detach_probe\r\n")
        c.wait_stream("repl", b"41\r\n>>> ", 5, since=m)

    def test_student_variables_with_short_common_names_survive_bridge_snippets(self):
        """G#9 (REPL variable survives), 02.3, RQ-ID-1: the raw REPL shares `__main__` with the student's REPL, so a bridge-owned snippet that
        binds a plain global name (`d`, `e`, `n`, `p`, `t`, `v`, `x`, `st`, `root`, ...) silently overwrites the student's variable.
        After list / stat / manifest / identity / mkdir / rm every one of those short names still holds the student's value."""
        board, c, _ = self.connected("esp32", board_kw=dict(files={"/g.txt": "x"}))
        c.call("repl.attach")
        names = ["d", "e", "n", "p", "t", "v", "x", "h", "st", "sz", "root", "sha", "pre", "full", "un", "u", "o", "mem", "nm", "bad", "ex", "cc"]
        m = c.mark()
        c.tty_write(("; ".join("%s = 'S_%s'" % (n, n) for n in names) + "\r\n").encode())
        c.wait_stream("repl", ("'S_%s'\r\n>>> " % names[-1]).encode(), 5, since=m)
        c.call("fs.list", path="/")
        c.call("fs.stat", path="/g.txt")
        c.call("fs.manifest", root="/")
        c.call("identity")
        c.call("fs.mkdir", path="/dd")
        c.call("fs.rm", path="/g.txt")
        m = c.mark()
        echo = ("print([%s])" % ", ".join(names)).encode()
        c.tty_write(echo + b"\r\n")

        def answer():                   # what the REPL printed after the echo of our line, once the next prompt is back
            seen = c.repl_bytes(m)
            i = seen.find(echo)
            tail = seen[i + len(echo):] if i >= 0 else b""
            return tail if b">>> " in tail else None
        tail = wait_until(answer, 10, "the REPL to answer the print")
        expected = repr(["S_" + n for n in names]).encode()
        self.assertIn(expected, tail, "a bridge snippet overwrote student variables; the REPL printed %r" % tail[-400:])

    def test_typed_input_during_a_raw_operation_is_buffered_not_interleaved(self):
        """G#9: keystrokes written (tty.write) while a long upload owns the raw REPL neither corrupt the upload nor appear
        interleaved in the repl stream; after the operation the REPL evaluates them."""
        board, c, _ = self.connected("esp32", faults=["slow:921600"])
        c.call("repl.attach")
        data = pseudo_random(150_000, 5)
        src = self.write_local(self.local_dir(), "typed.bin", data)
        rid = c.send("fs.put", local=src, remote="/typed.bin")
        c.wait_event("progress", lambda e: e.get("id") == rid, 20)
        m = c.mark()
        c.tty_write(b"2+2\r\n")
        r = c.result(rid, 60)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["sha256"], sha(data))
        self.assertEqual(board.read_file("/typed.bin"), data)
        before = [e for e in c.events_of("repl", m) if e["_n"] < r["_n"]]
        joined = b"".join(base64.b64decode(e["b64"]) for e in before)
        self.assertNotIn(b"2+2", joined, "typed text was interleaved into the repl stream during the raw operation")
        c.wait_stream("repl", b"4\r\n", 10, since=m)


# =====================================================================================================================
# state at connect: main.py running, silent programs, delayed boot, resets, unplug
# =====================================================================================================================
class StateAtConnectTests(BridgeTestCase):
    def test_main_py_running_at_connect_is_left_alone(self):
        """RQ-SAFE-1, protocol 3 (connect) / 5 / R-ARCH-5: a board whose main.py loops forever: connect says state running,
        sync running-program, interrupts nothing, resets nothing; file ops and identity answer E_PROGRAM_RUNNING without
        touching the board; stop ends the loop and then the ops work; interrupt:true is the consent form."""
        board, c, r = self.connected("esp32", faults=["main_forever"])
        self.assertEqual((r["state"], r["sync"]), ("running", "running-program"), r)
        self.assertEqual(board.events.count("interrupt"), 0)
        self.assertNoReset(board)
        n_exec = board.events.count("exec")
        for op, args in (("identity", {}), ("fs.list", {"path": "/"}), ("fs.manifest", {"root": "/"}), ("fs.stat", {"path": "/"})):
            c.fail(op, "E_PROGRAM_RUNNING", **args)
        self.assertEqual((board.events.count("exec"), board.events.count("raw_enter")), (n_exec, 0), "a deferred op touched the board")
        self.assertTrue(board.program_running)
        self.assertTrue(c.call("stop")["stopped"])
        wait_until(lambda: not board.program_running, 3, "main.py to end")
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")
        self.assertEqual(board.events.count("soft_reset"), 0)

    def test_file_op_with_interrupt_true_stops_the_program_and_runs(self):
        """Protocol 5 (running + file op): `interrupt:true` is the client's consent: the program is interrupted (Ctrl-C), the
        op runs, nothing is reset."""
        board, c, _ = self.connected("esp32", faults=["main_forever"])
        r = c.call("fs.list", path="/", interrupt=True)
        self.assertEqual(r["entries"][0]["name"], "boot.py")
        self.assertGreaterEqual(board.events.count("interrupt"), 1)
        self.assertNoReset(board)

    def test_silent_running_program_is_left_alone(self):
        """RQ-SAFE-1: a loop that prints nothing: the bridge waits, sends only a bare newline, state is running or unknown (never
        idle), no interrupt, no raw-REPL entry, no reset; the program keeps running; stop then frees the board."""
        files = {"/main.py": "import time\nwhile True:\n    time.sleep(0.05)\n"}
        board, c, r = self.connected("esp32", board_kw=dict(files=files))
        self.assertEqual(r["sync"], "silent", r)
        self.assertIn(r["state"], ("running", "unknown"), r)
        self.assertTrue(board.program_running)
        self.assertEqual(board.events.count("interrupt") + board.events.count("raw_enter") + board.events.count("exec"), 0)
        self.assertNoReset(board)
        self.assertTrue(c.call("stop")["stopped"])
        wait_until(lambda: not board.program_running, 3)
        c.call("fs.list", path="/")

    def test_prompt_lookalike_is_prompt_unverified_and_treated_as_running(self):
        """B (connect.sync "prompt-unverified"): a running main.py that merely prints `>>> ` is not proof of an idle REPL: sync
        is prompt-unverified, state running, file ops are E_PROGRAM_RUNNING and nothing is sent to the board."""
        files = {"/main.py": "import time, sys\nsys.stdout.write('>>> ')\nwhile True:\n    time.sleep(0.05)\n"}
        board, c, r = self.connected("esp32", board_kw=dict(files=files, power_on="connect"))
        self.assertEqual((r["state"], r["sync"]), ("running", "prompt-unverified"), r)
        n_exec = board.events.count("exec")
        c.fail("fs.list", "E_PROGRAM_RUNNING", path="/")
        self.assertEqual((board.events.count("exec"), board.events.count("raw_enter"), board.events.count("interrupt")), (n_exec, 0, 0))
        self.assertNoReset(board)

    def test_delayed_boot_is_waited_out_not_reset(self):
        """G#14, RQ-SAFE-1: a boot.py that takes a while (delay_boot) at connect: connect succeeds without a reset; once the
        board is at its prompt, stop is harmless and file ops work."""
        board, c, r = self.connected("esp32", faults=["delay_boot:1.0"])
        self.assertIn(r["state"], ("running", "unknown", "idle"), r)
        self.assertEqual(board.events.count("soft_reset") + board.events.count("hard_reset"), 0)
        self.assertTrue(board.wait_idle(10), "boot.py never finished")
        self.assertTrue(c.call("stop")["stopped"])
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")
        self.assertNoReset(board)

    def test_stop_during_a_delayed_boot_interrupts_boot_py_and_frees_the_board(self):
        """G#14, RQ-SAFE-3: Stop works while boot.py is still sleeping: it is interrupted with Ctrl-C (never reset) and the
        board becomes usable."""
        board, c, _ = self.connected("esp32", faults=["delay_boot:30"])
        self.assertTrue(c.call("stop", _timeout=15)["stopped"])
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")
        self.assertNoReset(board)

    def test_soft_reset_runs_boot_and_main_but_run_does_not_run_main(self):
        """G#11, 02.9, 08.14, D-07, D-16: reset.soft is Ctrl-D at the friendly prompt: boot.py then main.py run (their output
        reaches the attached REPL); Run's own soft reset (raw mode) runs boot.py but NOT main.py."""
        files = {"/boot.py": "print('BOOT-RAN')\n", "/main.py": "print('MAIN-RAN')\n"}
        board, c, _ = self.connected("esp32", board_kw=dict(files=files))
        c.call("repl.attach")
        main0 = board.events.count("program_start", kind="main.py")
        soft0 = board.events.count("soft_reset")
        m = c.mark()
        c.call("reset.soft", _timeout=20)
        data = c.wait_stream("repl", b"MAIN-RAN", 10, since=m)
        self.assertIn(b"BOOT-RAN", data)
        self.assertEqual(board.events.count("soft_reset") - soft0, 1)
        self.assertEqual(board.events.count("program_start", kind="main.py") - main0, 1)
        self.assertTrue(board.wait_idle(10), "main.py never finished")
        c.call("repl.detach")
        main1 = board.events.count("program_start", kind="main.py")
        m = c.mark()
        self.assertEqual(c.call("run", source="print('R')")["exit"], "ok")
        self.assertEqual(board.events.count("program_start", kind="main.py"), main1, "Run's raw soft reset must not run main.py")
        self.assertNotIn(b"MAIN-RAN", c.out_bytes(m))
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_soft_reset_skip_main_runs_boot_but_not_main(self):
        """2026-10-13 (IntelliSense cleanup): reset.soft with skipMain:true soft-resets in the raw REPL: boot.py runs, main.py does
        NOT start (it may drive motors), the board is back at the friendly prompt and idle; a non-bool skipMain is refused."""
        files = {"/boot.py": "print('BOOT-RAN')\n", "/main.py": "print('MAIN-RAN')\n"}
        board, c, _ = self.connected("esp32", board_kw=dict(files=files))
        c.fail("reset.soft", ("E_PROTOCOL",), skipMain="yes")
        c.call("repl.attach")
        main0 = board.events.count("program_start", kind="main.py")
        soft0 = board.events.count("soft_reset")
        m = c.mark()
        c.call("reset.soft", skipMain=True, _timeout=20)
        self.assertEqual(board.events.count("soft_reset") - soft0, 1)
        self.assertTrue(board.wait_idle(5))
        self.assertEqual(board.events.count("program_start", kind="main.py"), main0, "skipMain must not start main.py")
        self.assertNotIn(b"MAIN-RAN", c.out_bytes(m))
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")
        c.call("repl.detach")
        self.assertEqual(board.events.count("hard_reset"), 0)

    def test_hard_reset_needs_confirmation_and_stop_never_resets(self):
        """RQ-SAFE-2, D-16, protocol 3 (reset.hard): reset.hard without confirmed:true is refused (E_PROTOCOL / E_UNSUPPORTED); with
        it, a socket transport has no safe pulse (E_UNSUPPORTED); Stop (even twice, even after a program was stopped) never
        produces a hard reset; the log shows 0 hard resets."""
        board, c, _ = self.connected("esp32")
        c.fail("reset.hard", ("E_PROTOCOL", "E_UNSUPPORTED"))
        c.fail("reset.hard", ("E_PROTOCOL", "E_UNSUPPORTED"), confirmed=False)
        c.fail("reset.hard", "E_UNSUPPORTED", confirmed=True)
        rid = self.start_program(c, PROGRAMS["sleep_loop"], "loop.py")
        c.call("stop")
        c.call("stop")
        c.result(rid, 10)
        self.assertEqual(board.events.count("hard_reset"), 0)
        c.ping()

    def test_unplug_mid_operation_is_a_state_event_and_E_NO_DEVICE(self):
        """G#13, 02.13, A.3: the board vanishes at the first exec: the op answers E_NO_DEVICE (no hang), a `state` event says
        disconnected with reason unplugged, later ops say so, disconnect is fine, and a deliberate reconnect works."""
        board, c, _ = self.connected("esp32", faults=["unplug:exec"])
        m = c.mark()
        err = c.fail("fs.list", "E_NO_DEVICE", path="/", _timeout=30)
        self.assertTrue(err["hint"])
        ev = c.wait_state("disconnected", 5, since=m)
        self.assertEqual(ev.get("reason"), "unplugged", ev)
        c.fail("fs.list", ("E_NO_DEVICE", "E_NOT_CONNECTED"), path="/")
        c.call("disconnect")
        wait_until(lambda: board.connected == 0, 5)
        r = self.reconnect(c, board)
        # the drop left the board inside the raw REPL: the bridge may call that a running program (safe); the client's
        # documented consent path (`interrupt:true`, or Stop) must then get the board back without a reset.
        first = c.request("fs.list", path="/")
        if not first["ok"]:
            self.assertEqual(first["error"]["code"], "E_PROGRAM_RUNNING", (r, first))
            first = c.request("fs.list", path="/", interrupt=True)
        self.assertTrue(first["ok"], (r, first))
        self.assertEqual(first["entries"][0]["name"], "boot.py")
        self.assertNoReset(board)


# =====================================================================================================================
# protocol 6: queue and priorities, G#15
# =====================================================================================================================
class QueueTests(BridgeTestCase):
    def block_worker(self, c, board, seconds=1.5):
        """Occupy the port-owner worker with an `exec` that sleeps on the board; returns the request id."""
        rid = c.send("exec", code="import time\ntime.sleep(%s)\n" % seconds, timeoutMs=60000)
        wait_until(lambda: board.program_running, 10, "the blocking exec to start on the board")
        return rid

    def test_background_puts_to_one_path_coalesce_last_write_wins(self):
        """Protocol 6 (class 4): five `background:true` puts to the same remote queued behind a busy worker are coalesced by
        remote path, last write wins: the board ends with the 5th file's content and only ONE upload touched the device
        (the same number of snippets as a single plain upload); every request still gets exactly one answer."""
        board, c, _ = self.connected("esp32", board_kw=dict(capture=True))
        folder = self.local_dir()
        files = [self.write_local(folder, "v%d.py" % i, ("version = %d\n" % i) * 20) for i in range(5)]
        base = hex_of("/base.py")
        c.call("fs.put", local=files[0], remote="/base.py")
        one_put = sum(1 for e in board.events.of("exec") if base in e.get("code", ""))
        self.assertGreater(one_put, 0)
        blocker = self.block_worker(c, board)
        ids = [c.send("fs.put", local=f, remote="/bg.py", background=True) for f in files]
        answers = [c.result(i, 30) for i in ids]
        c.result(blocker, 30)
        self.assertTrue(answers[-1]["ok"], answers[-1])
        for a in answers[:-1]:
            self.assertTrue(a["ok"] or a["error"]["code"] == "E_CANCELLED", a)
        self.assertEqual(board.read_file("/bg.py"), ("version = 4\n" * 20).encode())
        touched = sum(1 for e in board.events.of("exec") if hex_of("/bg.py") in e.get("code", ""))
        self.assertEqual(touched, one_put, "superseded background puts must not be sent to the board")
        self.assertEqual(tmp_files(board), [])

    def test_foreground_file_ops_outrank_queued_background_ops(self):
        """Protocol 6: an explicit file op (class 3) queued AFTER a background put / listing (class 4) is answered first."""
        board, c, _ = self.connected("esp32")
        folder = self.local_dir()
        f = self.write_local(folder, "bg.py", "x = 1\n")
        blocker = self.block_worker(c, board)
        bg_put = c.send("fs.put", local=f, remote="/bgput.py", background=True)
        bg_list = c.send("fs.list", path="/", background=True)
        fg_stat = c.send("fs.stat", path="/boot.py")
        fg_list = c.send("fs.list", path="/")
        res = {k: c.result(v, 30) for k, v in dict(bg_put=bg_put, bg_list=bg_list, fg_stat=fg_stat, fg_list=fg_list, blocker=blocker).items()}
        for k, v in res.items():
            self.assertTrue(v["ok"], (k, v))
        self.assertLess(res["fg_stat"]["_n"], res["bg_put"]["_n"])
        self.assertLess(res["fg_list"]["_n"], res["bg_list"]["_n"])
        self.assertLess(res["fg_stat"]["_n"], res["bg_list"]["_n"])

    def test_run_outranks_queued_file_ops(self):
        """Protocol 6: `run` (class 2) queued after a file op (class 3) is executed first."""
        board, c, _ = self.connected("esp32")
        blocker = self.block_worker(c, board)
        lst = c.send("fs.list", path="/")
        run = c.send("run", source="print('prio')", name="p.py")
        r_run, r_list = c.result(run, 30), c.result(lst, 30)
        c.result(blocker, 30)
        self.assertEqual(r_run["exit"], "ok")
        self.assertTrue(r_list["ok"])
        self.assertLess(r_run["_n"], r_list["_n"])

    def test_bypass_ops_are_not_blocked_by_a_long_upload(self):
        """Protocol 6 (class 0), RQ-SAFE-3, R-ARCH-5: while a long upload owns the worker, ping and stop are answered at once
        (< 1 s) instead of waiting for it; the upload then ends (finished or cancelled by the Ctrl-C), no temp file is
        left, and the board is usable."""
        board, c, _ = self.connected("esp32", faults=["slow:921600"])
        data = pseudo_random(200_000, 9)
        src = self.write_local(self.local_dir(), "long.bin", data)
        rid = c.send("fs.put", local=src, remote="/long.bin")
        c.wait_event("progress", lambda e: e.get("id") == rid, 20)
        for op in ("ping", "stop"):
            t0 = time.monotonic()
            r = c.call(op, _timeout=10)
            self.assertLess(time.monotonic() - t0, 1.0, "%s waited behind the upload" % op)
        res = c.result(rid, 60)
        self.assertTrue(res["ok"] or res["error"]["code"] == "E_CANCELLED", res)
        wait_until(lambda: tmp_files(board) == [], 5, "no .mpytmp left after Stop during an upload")
        if not res["ok"]:
            self.assertFalse(board.exists("/long.bin"), "a cancelled upload left a final file")
        self.assertEqual(c.call("fs.list", path="/")["entries"][0]["name"], "boot.py")
        self.assertEqual(board.events.count("hard_reset") + board.events.count("soft_reset"), 0)

    def test_cancel_of_a_long_upload_leaves_no_temp_file(self):
        """G#15, 03.10, B (upload cancel cleanup): `cancel` of a running upload answers cancelled:true, the put answers
        E_CANCELLED, and no .mpytmp (nor a final file) is left on the board; the board is usable afterwards."""
        board, c, _ = self.connected("esp32", faults=["slow:921600"])
        src = self.write_local(self.local_dir(), "long.bin", pseudo_random(300_000, 2))
        rid = c.send("fs.put", local=src, remote="/dir/long.bin")
        c.wait_event("progress", lambda e: e.get("id") == rid, 20)
        self.assertTrue(c.call("cancel", target=rid)["cancelled"])
        err = c.result(rid, 30)
        self.assertFalse(err["ok"], err)
        self.assertEqual(err["error"]["code"], "E_CANCELLED")
        self.assertNotIn("deferred", err["error"].get("detail", ""), "temp-file cleanup was deferred to the next session")
        wait_until(lambda: tmp_files(board) == [], 5, "the .mpytmp file to be gone")
        self.assertFalse(board.exists("/dir/long.bin"))
        self.assertEqual(c.call("fs.list", path="/dir")["entries"], [])

    def test_cancel_of_a_queued_op_and_of_an_unknown_id(self):
        """Protocol 3 (cancel): a queued op can be cancelled before it starts (cancelled:true, the op answers E_CANCELLED, the
        board never sees it); an unknown id is cancelled:false."""
        board, c, _ = self.connected("esp32", board_kw=dict(capture=True))
        src = self.write_local(self.local_dir(), "q.py", "q = 1\n")
        blocker = self.block_worker(c, board)
        queued = c.send("fs.put", local=src, remote="/queued.py")
        self.assertTrue(c.call("cancel", target=queued)["cancelled"])
        self.assertEqual(c.result(queued, 10)["error"]["code"], "E_CANCELLED")
        c.result(blocker, 30)
        self.assertFalse(c.call("cancel", target=987654)["cancelled"])
        self.assertFalse(any(hex_of("/queued.py") in e.get("code", "") for e in board.events.of("exec")))
        self.assertFalse(board.exists("/queued.py"))


# =====================================================================================================================
# the real MicroPython unix VM behind the relay (skipped without MPY_UNIX_BIN)
# =====================================================================================================================
VM_SKIP = UnixVM.skip_reason()


@unittest.skipIf(VM_SKIP, VM_SKIP or "")
class RealVmScenarios(BridgeTestCase):
    """The same black-box contract against real MicroPython REPL code (shared/runtime/pyexec.c) instead of CPython shims.
    The VM's filesystem is the REAL host folder ``vm.root``: every path used here is under it, never '/'."""

    def vm(self):
        vm = UnixVM()
        vm.start()
        self.addCleanup(vm.stop)
        return vm

    def test_connect_identity_without_reset(self):
        """RQ-SAFE-1, RQ-ID-1, RQ-GEN-4 on the real VM: connect shows no soft reboot, identity reports MicroPython without
        os.uname() / unique_id() as empty strings, the version is 1.x, nothing is reset by connect or identity."""
        vm = self.vm()
        c = self.new_bridge()
        r = c.call("connect", port=vm.url)
        self.assertEqual(r["sync"], "prompt", r)
        ident = c.call("identity")
        self.assertEqual(ident["impl"], "micropython")
        self.assertEqual(ident["version"][0], 1)
        self.assertEqual(ident["uniqueId"], "")
        self.assertEqual(set(ident["uname"].values()), {""})
        self.assertEqual(vm.count("soft_reboot"), 0)

    def test_files_round_trip_under_the_vm_root(self):
        """G#4-G#7 on the real VM: put with a weird name, list, manifest hash, get, mv, rmtree under vm.root; the host folder
        shows exactly the bytes sent; no temp file remains. The bridge queues an orphan sweep after the first file op; on a
        host-OS port ('/' is the host disk) it must be skipped, so this test also pins that the sweep never walks the host."""
        vm = self.vm()
        c = self.new_bridge()
        c.call("connect", port=vm.url)
        root = vm.root.replace(os.sep, "/")
        data = b"a\r\nb\x00\xff" + pseudo_random(5000, 4)
        src = self.write_local(self.local_dir(), "src (1).bin", data)
        remote = root + "/lab (1)/it's \u00e9.bin"
        c.call("fs.put", local=src, remote=remote)
        with open(os.path.join(vm.root, "lab (1)", "it's \u00e9.bin"), "rb") as f:
            self.assertEqual(f.read(), data)
        self.assertEqual([e["name"] for e in c.call("fs.list", path=root + "/lab (1)")["entries"]], ["it's \u00e9.bin"])
        man = c.call("fs.manifest", root=root + "/lab (1)")
        self.assertEqual(man_paths({"entries": man["entries"]})[remote]["sha256"], sha(data))
        back = os.path.join(self.local_dir(), "back.bin")
        self.assertEqual(c.call("fs.get", remote=remote, local=back)["sha256"], sha(data))
        c.call("fs.mv", src=remote, dst=root + "/lab (1)/moved.bin")
        self.assertEqual(c.call("fs.rmtree", path=root + "/lab (1)", confirm=True)["removed"], 2)
        self.assertFalse(os.path.exists(os.path.join(vm.root, "lab (1)")))

    def test_run_traceback_cites_the_local_path_and_stop_works(self):
        """D-07, RQ-RUN-2 (N-13), RQ-SAFE-3 on the real VM: compile() with the local path gives `File "<path>", line N`; a
        while-True program is ended by stop (the relay's SIGINT trick) and the VM stays usable."""
        vm = self.vm()
        c = self.new_bridge()
        c.call("connect", port=vm.url)
        path = self.write_local(self.local_dir(), "test.py", "print(__name__)\ndef f():\n    return 1 / 0\nf()\n")
        m = c.mark()
        r = c.call("run", local=path, _timeout=30)
        self.assertEqual(r["exit"], "exception")
        self.assertIn(('File "%s", line 3, in f' % path).encode(), c.wait_stream("err", b"ZeroDivisionError", 5, since=m))
        self.assertIn(b"__main__", c.out_bytes(m))
        rid = self.start_program(c, PROGRAMS["sleep_loop"], "loop.py")
        self.assertTrue(c.call("stop", _timeout=15)["stopped"])
        self.assertEqual(c.result(rid, 10)["exit"], "interrupted")
        self.assertEqual(c.call("run", source="print(40 + 2)")["exit"], "ok")


if __name__ == "__main__":
    unittest.main()
