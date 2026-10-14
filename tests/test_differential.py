"""Differential tests: the same operation through the vendored REAL mpremote 1.29.0 (the oracle, D-03) and through the bridge,
against two identical fake boards; the results are compared (Appendix G #21).

mpremote is launched as an argv list ``[python, -I, -B, -X, utf8, -c, <bootstrap>, connect, <socket url>, ...]`` (no shell,
the bootstrap puts bridge/vendor on sys.path); the bridge as a child process through tests/bridge_client.py.

INTENTIONAL DIFFERENCES (they are asserted as differences, not hidden):
  * mpremote soft-resets the board on every command (1.29 default, 08.3); the bridge never resets for a file op
    (RQ-SAFE-1, 02.10).  The tests below assert 1 vs 0 soft resets.
  * mpremote tracebacks name the file `<stdin>`; the bridge compiles with the LOCAL path, so the failing frame cites the
    path (RQ-RUN-2, 08.7), and the bridge's traceback has one extra outer frame (the `exec(compile(...))` wrapper,
    `File "<stdin>", line 1`).  On a board without compile() both execute the raw source and the tracebacks are identical.
  * mpremote prints human text (`ls` columns, `Up to date`, ...); the bridge returns structured JSON.  Only the DATA is compared.
  * mpremote has no `fs mkdir -p`/`fs mv`/`fs stat` (08.1); the bridge does (verified elsewhere).

    export MPY_SAFE_MODE=1
    timeout 600 python3.13 -B -m unittest tests.test_differential
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest

from tests.bridge_client import BridgeTestCase, VENDOR
from tests.support import child_env, deadline
from tests.test_scenarios import pseudo_random, sha

_BOOT = "import sys; sys.path.insert(0, %r); from mpremote.main import main; sys.exit(main())" % VENDOR
_WAIT = threading.Event()                      # never set: a bounded retry back-off, not synchronisation


def snapshot(board):
    """{relative path: 'dir' | sha256} of the fake board's filesystem (the host folder behind the device '/')."""
    snap = {}
    for dirpath, dirs, files in os.walk(board.root):
        rel = os.path.relpath(dirpath, board.root).replace(os.sep, "/")
        if rel != ".":
            snap[rel] = "dir"
        for f in files:
            with open(os.path.join(dirpath, f), "rb") as fh:
                snap[f if rel == "." else rel + "/" + f] = hashlib.sha256(fh.read()).hexdigest()
    return snap


def frames(text, filename):
    """[(line, function)] of the traceback frames whose file is `filename`."""
    return [(int(m.group(1)), m.group(2)) for m in re.finditer(r'File "%s", line (\d+), in ([^\r\n]+)' % re.escape(filename), text)]


class DifferentialCase(BridgeTestCase):
    DEADLINE_S = 120

    def mp(self, board, *args, timeout=90):
        """Run vendored mpremote against `board`; (returncode, stdout bytes, stderr bytes).  The exclusive fake board needs a
        moment to listen again after the previous client, so 'failed to access' is retried."""
        argv = [sys.executable, "-I", "-B", "-X", "utf8", "-c", _BOOT, "connect", board.url] + [str(a) for a in args]
        for _ in range(60):
            r = subprocess.run(argv, capture_output=True, timeout=timeout, env=child_env(), cwd=tempfile.gettempdir(), shell=False)
            if r.returncode != 0 and b"failed to access" in (r.stdout + r.stderr):
                _WAIT.wait(0.05)
                continue
            break
        return r.returncode, r.stdout, r.stderr

    def pair(self, profile="esp32", faults=(), files=None):
        """(board for mpremote, board for the bridge, bridge client already connected to the second one)."""
        a = self.new_board(profile, faults=faults, files=files)
        b = self.new_board(profile, faults=faults, files=files)
        c = self.new_bridge()
        c.call("connect", port=b.url)
        return a, b, c


class ExecAndRunTests(DifferentialCase):
    def test_exec_output_is_byte_identical(self):
        """G#21: the same snippet prints the same bytes (CRLF as received, UTF-8 intact) through mpremote exec and bridge run."""
        a, b, c = self.pair()
        code = "import sys\nprint(sys.implementation.name, 6 * 7)\nprint('héllo 日本語')\nfor i in range(3):\n    print('line', i)\n"
        rc, out, err = self.mp(a, "exec", code)
        self.assertEqual(rc, 0, err)
        m = c.mark()
        self.assertEqual(c.call("run", source=code, name="diff.py", _timeout=30)["exit"], "ok")
        got = c.wait_out(out, 5, since=m)
        self.assertEqual(got, out)

    def test_traceback_text_and_failing_line_agree_apart_from_the_file_name(self):
        """G#21, 08.7, RQ-RUN-2: the exception line is identical; the failing frames carry the same line numbers and function names;
        mpremote says <stdin>, the bridge says the name it was given and adds one outer wrapper frame (intentional)."""
        a, b, c = self.pair()
        code = "def f(x):\n    return 10 / x\n\nprint('go')\nf(0)\n"
        rc, out, err = self.mp(a, "exec", code)
        self.assertEqual(rc, 1)
        mp_text = (out + err).decode("utf-8")
        m = c.mark()
        r = c.call("run", source=code, name="lab (1)/diff.py", _timeout=30)
        self.assertEqual(r["exit"], "exception")
        br_text = c.wait_stream("err", b"ZeroDivisionError", 5, since=m).decode("utf-8")
        self.assertEqual(mp_text.strip().splitlines()[-1], br_text.strip().splitlines()[-1])
        self.assertEqual(frames(mp_text, "<stdin>"), [(5, "<module>"), (2, "f")])
        self.assertEqual(frames(br_text, "lab (1)/diff.py"), frames(mp_text, "<stdin>"))
        self.assertEqual(frames(br_text, "<stdin>"), [(1, "<module>")], "exactly one outer wrapper frame")

    def test_without_compile_both_execute_the_same_source_and_tracebacks_are_identical(self):
        """G#21, protocol 5: on a board without compile() the bridge falls back to the raw source, so the traceback equals
        mpremote's exactly (file <stdin>, same frames, same exception line)."""
        a, b, c = self.pair(faults=["no_compile"])
        code = "def f():\n    raise ValueError('boom')\nf()\n"
        rc, out, err = self.mp(a, "exec", code)
        self.assertEqual(rc, 1)
        m = c.mark()
        c.call("run", source=code, name="whatever.py", _timeout=30)
        br_text = c.wait_stream("err", b"ValueError: boom", 5, since=m).decode("utf-8")
        mp_text = (out + err).decode("utf-8")
        self.assertEqual(frames(br_text, "<stdin>"), frames(mp_text, "<stdin>"))
        self.assertEqual(br_text.strip().splitlines()[-1], mp_text.strip().splitlines()[-1])

    def test_run_file_output_exit_status_and_main_py_handling_agree(self):
        """G#21, 08.14: `mpremote run file` and the bridge's run(local) print the same program output, map a normal end to rc 0 /
        exit ok and an exception to rc 1 / exit exception, run it as __main__, and neither runs main.py from raw mode.
        Intentional: mpremote soft-resets once per command; so does Run (D-07)."""
        files = {"/main.py": "print('MAIN-RAN')\n"}
        a, b, c = self.pair(files=files)
        folder = self.local_dir()
        ok_path = self.write_local(folder, "ok (1).py", "import sys\nprint('name', __name__)\nprint('é')\n")
        bad_path = self.write_local(folder, "bad (2).py", "print('before')\nraise KeyError('k')\n")
        rc, out, err = self.mp(a, "run", ok_path)
        self.assertEqual(rc, 0, err)
        m = c.mark()
        self.assertEqual(c.call("run", local=ok_path, _timeout=30)["exit"], "ok")
        self.assertEqual(c.wait_out(out, 5, since=m), out)
        self.assertIn(b"name __main__", out)
        rc, out, err = self.mp(a, "run", bad_path)
        self.assertEqual(rc, 1)
        self.assertIn(b"before\r\n", out)
        m = c.mark()
        self.assertEqual(c.call("run", local=bad_path, _timeout=30)["exit"], "exception")
        self.assertIn(b"before\r\n", c.wait_out(b"before\r\n", 5, since=m))
        mp_last = (out + err).decode("utf-8").strip().splitlines()[-1]
        br_last = c.wait_stream("err", b"KeyError", 5, since=m).decode("utf-8").strip().splitlines()[-1]
        self.assertEqual(br_last, mp_last)
        for board in (a, b):
            self.assertEqual(board.events.count("program_start", kind="main.py"), 1, "only the power-on run of main.py")


class FileOpTests(DifferentialCase):
    def test_listing_agrees(self):
        """G#21, G#3: mpremote `fs ls` and the bridge's fs.list see the same names and sizes (files and folders), including
        non-ASCII and parenthesised names."""
        files = {"/d/a.txt": "12345", "/d/sub/b.bin": bytes(range(200)), "/d/ünï.txt": "x", "/d/with space (1).py": "yy", "/d/empty": ""}
        a, b, c = self.pair(files=files)
        rc, out, err = self.mp(a, "fs", "ls", ":/d")
        self.assertEqual(rc, 0, err)
        mp_entries = {}
        for line in out.decode("utf-8").splitlines():
            m = re.match(r"^\s*(\d+)\s(.+)$", line)
            if m:
                mp_entries[m.group(2).rstrip("/")] = ("dir" if m.group(2).endswith("/") else "file", int(m.group(1)))
        br = {e["name"]: (e["type"], e["size"]) for e in c.call("fs.list", path="/d")["entries"]}
        self.assertEqual(set(br), set(mp_entries))
        for name, (typ, size) in mp_entries.items():
            self.assertEqual(br[name][0], typ, name)
            if typ == "file":
                self.assertEqual(br[name][1], size, name)

    def test_put_get_bytes_and_sha256_agree(self):
        """G#21, G#4, G#6: uploading a binary file with CRLF/NUL/Ctrl-C/Ctrl-D bytes leaves identical bytes on both boards,
        mpremote's own hash of the board copy equals the bridge's sha256 (put result and manifest) and the host's, and
        downloading gives identical bytes.  Local paths have spaces and parentheses."""
        a, b, c = self.pair()
        data = b"a\r\nb\x00\x03\x04\x1b\xff" * 30 + pseudo_random(30_000, 13)
        src = self.write_local(self.local_dir(), "payload (final).bin", data)
        rc, out, err = self.mp(a, "fs", "cp", src, ":/x.bin")
        self.assertEqual(rc, 0, err)
        res = c.call("fs.put", local=src, remote="/x.bin", _timeout=60)
        self.assertEqual(a.read_file("/x.bin"), data)
        self.assertEqual(b.read_file("/x.bin"), data)
        digest = "import hashlib, binascii\nprint(binascii.hexlify(hashlib.sha256(open('/x.bin', 'rb').read()).digest()).decode())\n"
        rc, out, err = self.mp(a, "exec", digest)
        self.assertEqual(out.decode().strip(), sha(data))
        self.assertEqual(res["sha256"], sha(data))
        man = {e["path"].lstrip("/"): e for e in c.call("fs.manifest", root="/")["entries"]}
        self.assertEqual(man["x.bin"]["sha256"], out.decode().strip())
        mp_back = os.path.join(self.local_dir(), "mp.bin")
        br_back = os.path.join(self.local_dir(), "br.bin")
        rc, out, err = self.mp(a, "fs", "cp", ":/x.bin", mp_back)
        self.assertEqual(rc, 0, err)
        c.call("fs.get", remote="/x.bin", local=br_back, _timeout=60)
        with open(mp_back, "rb") as f1, open(br_back, "rb") as f2:
            self.assertEqual(f1.read(), f2.read())

    def test_same_scenario_leaves_the_same_filesystem_and_only_mpremote_resets(self):
        """G#21, RQ-SAFE-1, 02.10: mkdir, upload into nested folders, upload, remove: both tools end with the same device tree.
        INTENTIONAL difference: mpremote soft-resets (exactly 1), the bridge does not (0)."""
        a, b, c = self.pair()
        folder = self.local_dir()
        f1 = self.write_local(folder, "f1 (a).py", "one = 1\n")
        f2 = self.write_local(folder, "f2 (b).py", "two = 2\n")
        rc, out, err = self.mp(a, "fs", "mkdir", ":/lab", "+", "fs", "mkdir", ":/lab/g", "+", "fs", "cp", f1, ":/lab/f1.py", "+",
                               "fs", "cp", f2, ":/lab/g/f2.py", "+", "fs", "cp", f2, ":/keep.py", "+", "fs", "rm", ":/lab/f1.py")
        self.assertEqual(rc, 0, err)
        c.call("fs.put", local=f1, remote="/lab/f1.py")
        c.call("fs.put", local=f2, remote="/lab/g/f2.py")
        c.call("fs.put", local=f2, remote="/keep.py")
        c.call("fs.rm", path="/lab/f1.py")
        self.assertEqual(snapshot(a), snapshot(b))
        self.assertEqual(a.events.count("soft_reset"), 1, "mpremote 1.29 soft-resets once per invocation")
        self.assertEqual(b.events.count("soft_reset"), 0, "the bridge never resets for file operations")
        self.assertEqual(a.events.count("hard_reset") + b.events.count("hard_reset"), 0)

    @deadline(180)
    def test_other_profiles_agree_on_exec_and_a_small_upload(self):
        """G#21, RQ-GEN-4: on rp2, stm32 (files under /flash), esp8266 (no sha256) and a custom firmware both tools print the same
        sys.platform, the bridge's identity matches what mpremote's exec reports, and an uploaded file has the same bytes."""
        for name in ("rp2", "stm32", "esp8266", "custom-frozen"):
            with self.subTest(profile=name):
                a, b, c = self.pair(name)
                rc, out, err = self.mp(a, "exec", "import sys\nprint(sys.platform, sys.implementation._build if hasattr(sys.implementation, '_build') else '')")
                self.assertEqual(rc, 0, err)
                ident = c.call("identity")
                self.assertEqual(out.decode().split()[0], ident["platform"])
                if len(out.decode().split()) > 1:
                    self.assertEqual(out.decode().split()[1], ident["build"])
                src = self.write_local(self.local_dir(), "s.txt", b"small file\r\n" * 20)
                dest = "/flash/s.txt" if name == "stm32" else "/s.txt"
                rc, out, err = self.mp(a, "fs", "cp", src, ":" + dest)
                self.assertEqual(rc, 0, err)
                c.call("fs.put", local=src, remote=dest)
                self.assertEqual(a.read_file(dest), b.read_file(dest))


if __name__ == "__main__":
    unittest.main()
