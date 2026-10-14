"""Tests for bridge/devfs.py (device-side filesystem + identity code).

Two boards run the SAME contract tests:

* ``FakeBoard``: the snippets are executed by CPython against an in-memory filesystem with a
  strict import hook (only os/sys/gc/time/errno/binascii/hashlib/machine are importable, so a
  snippet that reached for anything else fails here).  Runs everywhere (macOS, Windows, 3.9-3.15)
  and offers fault injection (read-only flash, full flash, FAT rename, missing hashlib, ...).
* ``VmBoard``: the snippets are executed by the REAL MicroPython unix VM (env ``MPY_UNIX_BIN``;
  these tests skip with a message when it is not set or missing).

How the VM gets a "board filesystem" (the unix port has no chroot): ``VmBoard.exec_fn`` runs
``micropython SHIM SNIPPET ROOT``.  SHIM (``_VM_SHIM`` below, MicroPython code) replaces
``sys.modules["os"]`` with a thin object whose path-taking functions (stat, listdir, ilistdir,
mkdir, rmdir, remove, rename, statvfs) prefix the sandbox ROOT to the absolute device path, and
exec()s the snippet with a module-level ``open`` that does the same.  The snippet itself is the
unmodified production text.  Relative device paths are rejected by the shim, so a snippet that
forgot to use an absolute path fails instead of touching the real working directory.  Hash
fallbacks are simulated by ``sys.modules["hashlib"] = None`` (flag ``nohash``) or a hashlib
without ``sha256`` (flag ``nosha256``).  ``-X heapsize=`` caps the VM heap for the constant-RAM
checks.

Never opens a serial port.  Set ``MPY_SAFE_MODE=1`` when running (harmless here, required by the
project rules for every test run).
"""
from __future__ import annotations

import ast
import base64
import binascii
import builtins
import contextlib
import errno
import hashlib
import io
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
import types
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (ROOT, os.path.join(ROOT, "bridge", "vendor")):  # vendor ends up first
    if _p not in sys.path:
        sys.path.insert(0, _p)

from bridge import devfs  # noqa: E402

BridgeError = devfs.BridgeError
MPY_UNIX_BIN = os.environ.get("MPY_UNIX_BIN", "")
HAVE_VM = bool(MPY_UNIX_BIN) and os.path.isfile(MPY_UNIX_BIN) and os.name == "posix"
VM_SKIP = "MPY_UNIX_BIN is not set to the MicroPython unix binary (or it is missing): real-VM snippet tests skipped"


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


ALL_BYTES = bytes(range(256))
CRLF_BLOB = b"line1\r\nline2\nline3\r\n\x00\xff\xfe not utf-8 \x80\r\n"


def pseudo_random(n: int, seed: int = 1) -> bytes:
    r = random.Random(seed)
    return bytes(r.getrandbits(8) for _ in range(n))


# Names that broke the old extension (spaces, quotes, "tree", "ls", dots) and a few more.
WEIRD_NAMES = [
    "a b.py",
    "double  space.py",
    " lead space.py",
    "it's.py",
    'say "hi".py',
    "paren(1).py",
    "tree",
    "tree.py",
    "ls",
    "tools.py",
    "unicode-é-日本-\U0001f600.txt",
    ".hidden",
    "app.v2",
    "noext",
    "lib.mpy",
    "back\\slash.py",
    "new\nline.py",
    "tab\tname.py",
    "x" * 200 + ".py",
]


# =============================================================================================
# In-memory filesystem and fake board (CPython)
# =============================================================================================


def _oserr(code: int) -> OSError:
    return OSError(code, os.strerror(code))
from tests.support import TimedTestCase as _TimedTestCase, shorten_socket_close_sleep  # noqa: E402

shorten_socket_close_sleep()  # pyserial's socket:// close() sleeps 0.3 s per Link.close(); see tests/support.py


class TimedCase(_TimedTestCase):
    """Every test in this module gets a hard per-test deadline (tests/support.py): a hang is a FAIL that names the
    blocked line, never a frozen suite.  Generous on purpose so a slow-but-correct test on a loaded machine is not flaky;
    MPY_TEST_DEADLINE_SCALE multiplies it, 0 disables it."""
    DEADLINE_S = 120.0




class MemFile:
    def __init__(self, fs: "MemFS", path: str, mode: str):
        self.fs, self.path, self.mode = fs, path, mode
        self.pos = len(fs.files[path]) if "a" in mode else 0
        self.closed = False

    def _buf(self) -> bytearray:
        return self.fs.files[self.path]

    def read(self, n: int = -1) -> bytes:
        b = self._buf()
        end = len(b) if n is None or n < 0 else min(len(b), self.pos + n)
        out = bytes(b[self.pos : end])
        self.pos = end
        return out

    def readinto(self, buf: bytearray) -> int:
        chunk = self.read(len(buf))
        buf[: len(chunk)] = chunk
        return len(chunk)

    def write(self, data: bytes) -> int:
        if "r" in self.mode and "+" not in self.mode:
            raise _oserr(errno.EBADF)
        self.fs.charge(len(data))
        b = self._buf()
        if "a" in self.mode:
            self.pos = len(b)
        end = self.pos + len(data)
        if end > len(b):
            b.extend(bytes(end - len(b)))
        b[self.pos : end] = data
        self.pos = end
        self.fs.mtimes[self.path] = self.fs.tick()
        return len(data)

    def seek(self, off: int, whence: int = 0) -> int:
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else len(self._buf()) + off)
        return self.pos

    def close(self) -> None:
        self.closed = True

    def __enter__(self) -> "MemFile":
        return self

    def __exit__(self, *a: object) -> None:
        self.close()


class MemFS:
    """Just enough of a board filesystem, with the errno behaviour of littlefs/FAT where it matters."""

    def __init__(self, capacity=None, readonly=False, rename_mode=None, write_budget=None, mounts=(), vfs=None, devs=None):
        self.mounts = list(mounts)  # e.g. ["/sd"]: renames between different mounts fail with EXDEV
        self.vfs = dict(vfs or {})  # mount ("/" or "/sd") -> os.statvfs tuple; default: one geometry for everything
        self.devs = dict(devs or {})  # mount -> st_dev reported by os.stat (the unix port fills it, bare metal does not)
        self.dirs = {"/"}
        self.files: dict = {}
        self.mtimes: dict = {}
        self.capacity = capacity
        self.readonly = readonly
        self.rename_mode = rename_mode  # None | "fat" (EEXIST over existing) | "fat_then_fail" (and EIO afterwards)
        self.write_budget = write_budget  # bytes that may still be written before ENOSPC (fault injection)
        self._clock = 1_700_000_000

    def tick(self) -> int:
        self._clock += 1
        return self._clock

    def charge(self, n: int) -> None:
        if self.write_budget is not None:
            if n > self.write_budget:
                raise _oserr(errno.ENOSPC)
            self.write_budget -= n
        if self.capacity is not None and self.used() + n > self.capacity:
            raise _oserr(errno.ENOSPC)

    def used(self) -> int:
        return sum(len(v) for v in self.files.values())

    @staticmethod
    def _p(p: str) -> str:
        if not isinstance(p, str) or not p.startswith("/"):
            raise ValueError("snippet used a non-absolute path: %r" % (p,))
        return p if p == "/" else p.rstrip("/")

    @staticmethod
    def parent(p: str) -> str:
        return p[: p.rfind("/")] or "/"

    def _missing(self, p: str) -> OSError:
        q = self.parent(p)
        while q != "/":
            if q in self.files:
                return _oserr(errno.ENOTDIR)
            q = self.parent(q)
        return _oserr(errno.ENOENT)

    def children(self, p: str):
        pre = "/" if p == "/" else p + "/"
        out = []
        for q in list(self.dirs) + list(self.files):
            if q != "/" and q.startswith(pre) and "/" not in q[len(pre) :]:
                out.append(q[len(pre) :])
        return sorted(out)

    # --- os functions
    def stat(self, p):
        p = self._p(p)
        dev = self.devs.get(self._mount_of(p), 0)
        if p in self.dirs:
            return (0x4000 | 0o755, 0, dev, 1, 0, 0, 0, 0, self.mtimes.get(p, 0), 0)
        if p in self.files:
            return (0x8000 | 0o644, 0, dev, 1, 0, 0, len(self.files[p]), 0, self.mtimes.get(p, 0), 0)
        raise self._missing(p)

    def ilistdir(self, p):
        p = self._p(p)
        if p in self.files:
            raise _oserr(errno.ENOTDIR)
        if p not in self.dirs:
            raise self._missing(p)
        names = self.children(p)
        pre = "/" if p == "/" else p + "/"

        def gen():
            for n in reversed(names):  # device order must not matter to the host
                yield (n, 0x4000 if (pre + n) in self.dirs else 0x8000, 0)

        return gen()

    def listdir(self, p="/"):
        return [e[0] for e in self.ilistdir(p)]

    def mkdir(self, p):
        p = self._p(p)
        if self.readonly:
            raise _oserr(errno.EROFS)
        if p in self.dirs or p in self.files:
            raise _oserr(errno.EEXIST)
        par = self.parent(p)
        if par in self.files:
            raise _oserr(errno.ENOTDIR)
        if par not in self.dirs:
            raise _oserr(errno.ENOENT)
        self.dirs.add(p)
        self.mtimes[p] = self.tick()

    def rmdir(self, p):
        p = self._p(p)
        if self.readonly:
            raise _oserr(errno.EROFS)
        if p in self.files:
            raise _oserr(errno.ENOTDIR)
        if p not in self.dirs:
            raise self._missing(p)
        if p == "/":
            raise _oserr(errno.EBUSY)
        if self.children(p):
            raise _oserr(errno.ENOTEMPTY)
        self.dirs.discard(p)

    def remove(self, p):
        p = self._p(p)
        if self.readonly:
            raise _oserr(errno.EROFS)
        if p in self.dirs:
            raise _oserr(errno.EISDIR)
        if p not in self.files:
            raise self._missing(p)
        del self.files[p]
        self.mtimes.pop(p, None)

    def _mount_of(self, p):
        for m in self.mounts:
            if p == m or p.startswith(m + "/"):
                return m
        return "/"

    def rename(self, a, b):
        a, b = self._p(a), self._p(b)
        if self.readonly:
            raise _oserr(errno.EROFS)
        if self._mount_of(a) != self._mount_of(b):
            raise _oserr(errno.EXDEV)
        if a not in self.files and a not in self.dirs:
            raise self._missing(a)
        par = self.parent(b)
        if par not in self.dirs:
            raise self._missing(b) if par not in self.files else _oserr(errno.ENOTDIR)
        exists = b in self.files or b in self.dirs
        if self.rename_mode == "fat_then_fail" and not exists and a.endswith(devfs.TMP_SUFFIX):
            raise _oserr(errno.EIO)
        if exists:
            if self.rename_mode in ("fat", "fat_then_fail"):
                raise _oserr(errno.EEXIST)
            if b in self.dirs or a in self.dirs:
                raise _oserr(errno.EISDIR if a in self.files else errno.ENOTEMPTY)
            del self.files[b]
        if a in self.files:
            self.files[b] = self.files.pop(a)
            self.mtimes[b] = self.mtimes.pop(a, 0)
        else:
            moved = [d for d in self.dirs if d == a or d.startswith(a + "/")]
            for d in moved:
                self.dirs.discard(d)
                self.dirs.add(b + d[len(a) :])
            for f in [f for f in self.files if f.startswith(a + "/")]:
                self.files[b + f[len(a) :]] = self.files.pop(f)

    def statvfs(self, p):
        p = self._p(p)
        if self._mount_of(p) in self.vfs:
            return self.vfs[self._mount_of(p)]
        if self.capacity is None:
            total = free = 1 << 20
        else:
            total = self.capacity // 512
            free = max(0, (self.capacity - self.used())) // 512
        return (512, 512, total, free, free, 0, 0, 0, 0, 255)

    def open(self, p, mode="r", *a):
        p = self._p(p)
        if "b" not in mode:
            raise ValueError("snippets only open files in binary mode, got %r" % mode)
        if "w" in mode or "a" in mode:
            if self.readonly:
                raise _oserr(errno.EROFS)
            if p in self.dirs:
                raise _oserr(errno.EISDIR)
            par = self.parent(p)
            if par not in self.dirs:
                raise self._missing(p) if par not in self.files else _oserr(errno.ENOTDIR)
            if "w" in mode or p not in self.files:
                self.files[p] = bytearray()
                self.mtimes[p] = self.tick()
        else:
            if p in self.dirs:
                raise _oserr(errno.EISDIR)
            if p not in self.files:
                raise self._missing(p)
        return MemFile(self, p, mode)


class Board:
    """What the contract tests need from a board adapter."""

    calls: list

    def exec_fn(self, code, timeout=10.0):  # pragma: no cover - interface
        raise NotImplementedError

    def put(self, path: str, data: bytes) -> None: ...
    def read(self, path: str): ...
    def mkdir(self, path: str) -> None: ...
    def tree(self) -> dict: ...
    def close(self) -> None: ...


class FakeBoard(Board):
    """CPython executes the real snippets against a MemFS with a strict import hook."""

    def __init__(
        self,
        hash_mode="ok",  # ok | missing (ImportError) | nosha256 (no attribute) | broken (wrong digest)
        has_compile=True,
        has_help=True,
        uname=("esp32", "esp32", "1.29.0", "v1.29.0 on 2026-08-01", "ESP32 module with ESP32"),
        unique_id=b"\xde\xad\xbe\xef\x01\x02",
        mem_free=123456,
        build="STOCK_BOARD",
        machine="ESP32 module with ESP32",
        extra_modules=None,
        cwd=None,
        **fs_kw,
    ):
        self.fs = MemFS(**fs_kw)
        self.cwd = cwd  # None: the port has no os.getcwd (the snippets must cope)
        self.hash_mode = hash_mode
        self.has_compile = has_compile
        self.has_help = has_help
        self.uname = uname
        self.unique_id = unique_id
        self.mem_free = mem_free
        self.extra_modules = dict(extra_modules or {})
        im = types.SimpleNamespace(name="micropython", version=(1, 29, 0, ""), _mpy=6182)
        if machine is not None:
            im._machine = machine
        if build is not None:
            im._build = build
        self.sys = types.SimpleNamespace(implementation=im, platform="esp32", path=["", ".frozen", "/lib"], modules={})
        self.calls: list = []
        self.hook = None  # callable(board, code) -> may raise to simulate a dead link

    # --- adapter API for tests
    def put(self, path, data):
        par = MemFS.parent(path)
        q = ""
        for seg in par.split("/"):
            if seg:
                q += "/" + seg
                self.fs.dirs.add(q)
        self.fs.files[path] = bytearray(data)
        self.fs.mtimes[path] = self.fs.tick()

    def read(self, path):
        return bytes(self.fs.files[path]) if path in self.fs.files else None

    def mkdir(self, path):
        q = ""
        for seg in path.split("/"):
            if seg:
                q += "/" + seg
                self.fs.dirs.add(q)

    def tree(self):
        out = {d: None for d in self.fs.dirs if d != "/"}
        out.update({f: bytes(v) for f, v in self.fs.files.items()})
        return out

    def close(self):
        pass

    # --- execution
    def _os(self):
        fs = self.fs
        ns = types.SimpleNamespace(
            stat=fs.stat, ilistdir=fs.ilistdir, listdir=fs.listdir, mkdir=fs.mkdir, rmdir=fs.rmdir,
            remove=fs.remove, rename=fs.rename, statvfs=fs.statvfs,
        )  # fmt: skip
        if self.uname is not None:
            ns.uname = lambda: self.uname
        if self.cwd is not None:
            ns.getcwd = lambda: self.cwd
        return ns

    def _import(self, name, globals=None, locals=None, fromlist=(), level=0):
        if name == "os":
            mod = self._os()
        elif name == "sys":
            mod = self.sys
        elif name == "gc":
            mod = types.SimpleNamespace(collect=lambda: 0)
            if self.mem_free is not None:
                mod.mem_free = lambda: self.mem_free
        elif name in ("binascii", "errno", "time"):
            mod = __import__(name)
        elif name == "hashlib":
            if self.hash_mode == "missing":
                raise ImportError("no module named 'hashlib'")
            if self.hash_mode == "nosha256":
                mod = types.SimpleNamespace()
            elif self.hash_mode == "broken":
                mod = types.SimpleNamespace(sha256=lambda data=b"": _BrokenHash())
            else:
                mod = types.SimpleNamespace(sha256=hashlib.sha256)
        elif name == "machine":
            if self.unique_id is None:
                raise ImportError("no module named 'machine'")
            mod = types.SimpleNamespace(unique_id=lambda: self.unique_id)
        elif name in self.extra_modules:
            mod = self.extra_modules[name]
        else:
            raise ImportError("no module named %r (the fake board has no such module)" % name)
        self.sys.modules[name] = mod
        return mod

    def _help(self, what=None):
        if what == "modules":
            print("__main__          array             binascii          builtins")
            print("errno             gc                hashlib           os")
            print("Plus any modules on the filesystem")

    def exec_fn(self, code, timeout=10.0):
        self.calls.append(code)
        if self.hook is not None:
            self.hook(self, code)
        b = dict(vars(builtins))
        b["open"] = self.fs.open
        b["__import__"] = self._import
        if self.has_help:
            b["help"] = self._help
        else:
            b.pop("help", None)
        if not self.has_compile:
            b.pop("compile", None)
        ns = {"__name__": "__main__", "__builtins__": b}
        out = io.StringIO()
        err = ""
        try:
            program = compile(code, "<snippet>", "exec")
            with contextlib.redirect_stdout(out):
                exec(program, ns)
        except Exception:  # the raw REPL puts the traceback on stderr
            err = traceback.format_exc()
        return out.getvalue().encode("utf-8"), err.encode("utf-8")


class _BrokenHash:
    def update(self, b):
        pass

    def digest(self):
        return b"\x00" * 32


# =============================================================================================
# Real MicroPython unix VM board
# =============================================================================================

_VM_SHIM = r'''
import sys
import os as _os
_SRC = sys.argv[1]
_ROOT = sys.argv[2]
_FLAGS = sys.argv[3:]
if "nohash" in _FLAGS:
    sys.modules["hashlib"] = None
if "nosha256" in _FLAGS:
    class _NoSha:
        pass
    sys.modules["hashlib"] = _NoSha()
def _t(p):
    if not isinstance(p, str) or not p.startswith("/"):
        raise ValueError("snippet used a non-absolute path: " + repr(p))
    return _ROOT + p
class _Os:
    def __getattr__(self, n):
        return getattr(_os, n)
    def stat(self, p):
        return _os.stat(_t(p))
    def listdir(self, p):
        return _os.listdir(_t(p))
    def ilistdir(self, p):
        return _os.ilistdir(_t(p))
    def mkdir(self, p):
        return _os.mkdir(_t(p))
    def rmdir(self, p):
        return _os.rmdir(_t(p))
    def remove(self, p):
        return _os.remove(_t(p))
    def rename(self, a, b):
        return _os.rename(_t(a), _t(b))
    def statvfs(self, p):
        return _os.statvfs(_t(p))
sys.modules["os"] = _Os()
_open = open
def open(p, mode="r", *a):
    return _open(_t(p), mode, *a)
with _open(_SRC) as _f:
    _code = _f.read()
exec(_code, {"__name__": "__main__", "open": open})
'''


class VmBoard(Board):
    """Runs each snippet in the real MicroPython unix VM against a sandbox directory."""

    def __init__(self, flags=(), heap=None):
        base = tempfile.mkdtemp(prefix="devfs vm (sandbox) ")  # spaces and parentheses on purpose
        self.base = base
        self.root = os.path.join(base, "board root")
        self.scratch = os.path.join(base, "scratch")
        self.cwd = os.path.join(base, "cwd")
        for d in (self.root, self.scratch, self.cwd):
            os.makedirs(d)
        self.shim = os.path.join(self.scratch, "shim.py")
        with open(self.shim, "w", encoding="utf-8") as f:
            f.write(_VM_SHIM)
        self.flags = list(flags)
        self.heap = heap
        self.calls: list = []
        self.hook = None
        self.runs = 0

    def hostpath(self, path: str) -> str:
        return os.path.join(self.root, *[s for s in path.split("/") if s])

    def exec_fn(self, code, timeout=10.0):
        self.calls.append(code)
        if self.hook is not None:
            self.hook(self, code)
        self.runs += 1
        snippet = os.path.join(self.scratch, "snippet.py")
        with open(snippet, "w", encoding="utf-8", newline="\n") as f:
            f.write(code)
        argv = [MPY_UNIX_BIN]
        if self.heap:
            argv += ["-X", "heapsize=%s" % self.heap]
        argv += [self.shim, snippet, self.root] + self.flags
        env = dict(os.environ, MPY_SAFE_MODE="1")
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           cwd=self.cwd, env=env, timeout=timeout + 30)  # fmt: skip
        out, err = r.stdout, r.stderr
        # This unix build prints an uncaught exception's traceback on stdout; the raw REPL sends it
        # on its stderr channel, which is what devfs expects.
        marker = b"Traceback (most recent call last):"
        i = out.find(marker)
        if i >= 0:
            out, err = out[:i], out[i:] + err
        return out, err

    def put(self, path, data):
        hp = self.hostpath(path)
        os.makedirs(os.path.dirname(hp), exist_ok=True)
        with open(hp, "wb") as f:
            f.write(data)

    def read(self, path):
        hp = self.hostpath(path)
        if not os.path.isfile(hp):
            return None
        with open(hp, "rb") as f:
            return f.read()

    def mkdir(self, path):
        os.makedirs(self.hostpath(path), exist_ok=True)

    def tree(self):
        out = {}
        for dp, dns, fns in os.walk(self.root):
            rel = os.path.relpath(dp, self.root)
            prefix = "" if rel == "." else "/" + rel.replace(os.sep, "/")
            for d in dns:
                out[prefix + "/" + d] = None
            for fn in fns:
                with open(os.path.join(dp, fn), "rb") as f:
                    out[prefix + "/" + fn] = f.read()
        return out

    def close(self):
        shutil.rmtree(self.base, ignore_errors=True)


# =============================================================================================
# helpers for fault injection around exec_fn
# =============================================================================================


class LinkDied(BridgeError):
    def __init__(self):
        BridgeError.__init__(self, "E_NOT_CONNECTED", "link died (test)")


def failing_after(board: Board, n_ok: int, forever: bool = True):
    """Make exec_fn raise like a dead link after ``n_ok`` successful calls (forever, or just once)."""
    state = {"n": 0}

    def hook(b, code):
        state["n"] += 1
        if state["n"] > n_ok and (forever or state["n"] == n_ok + 1):
            raise LinkDied()

    board.hook = hook
    return state


def codes(board: Board):
    return board.calls


# =============================================================================================
# The contract tests (mixed into FakeBoard and VmBoard classes below)
# =============================================================================================


class FsContract:
    """Behaviour every board adapter must show.  Subclasses define ``make_board``."""

    def make_board(self, **kw) -> Board:
        raise NotImplementedError

    def make_nohash_board(self) -> Board:
        """A board whose hashlib cannot be imported."""
        raise NotImplementedError

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="devfs test (local) é@ ")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.board = self.make_board()
        self.addCleanup(self.board.close)
        self.x = self.board.exec_fn

    # --- helpers
    def swap_board(self, board: Board) -> Board:
        """Replace the board under test; the old one is closed now, the new one at cleanup."""
        self.board.close()
        self.board = board
        self.addCleanup(board.close)
        self.x = board.exec_fn
        return board

    def local(self, name: str, data: bytes) -> str:
        path = os.path.join(self.tmp, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def assertFs(self, code, detail, fn, *a, **kw):
        with self.assertRaises(BridgeError) as cm:
            fn(*a, **kw)
        self.assertEqual(cm.exception.code, code, cm.exception)
        if detail is not None:
            self.assertEqual(cm.exception.detail, detail, cm.exception)
        return cm.exception

    def names_in(self, path="/"):
        return sorted(e["name"] for e in devfs.list_dir(self.x, path)["entries"])

    def no_temp_files(self):
        left = [p for p in self.board.tree() if p.endswith(devfs.TMP_SUFFIX)]
        self.assertEqual(left, [], "orphan temp files left on the board")

    # --- fs.list
    def test_list_empty_root(self):
        self.assertEqual(devfs.list_dir(self.x, "/"), {"entries": []})

    def test_list_types_sizes_and_nesting(self):
        self.board.put("/main.py", b"print(1)\n")
        self.board.put("/lib/util.py", b"x" * 300)
        self.board.mkdir("/empty")
        self.board.put("/zero.bin", b"")
        got = devfs.list_dir(self.x, "/")["entries"]
        self.assertEqual(
            got,
            [
                {"name": "empty", "type": "dir", "size": 0},
                {"name": "lib", "type": "dir", "size": 0},
                {"name": "main.py", "type": "file", "size": 9},
                {"name": "zero.bin", "type": "file", "size": 0},
            ],
        )
        self.assertEqual(devfs.list_dir(self.x, "/lib")["entries"], [{"name": "util.py", "type": "file", "size": 300}])
        self.assertEqual(devfs.list_dir(self.x, "/empty")["entries"], [])
        self.assertEqual(devfs.list_dir(self.x, "/lib/")["entries"], devfs.list_dir(self.x, "/lib")["entries"])

    def test_list_weird_names_round_trip(self):
        for i, n in enumerate(WEIRD_NAMES):
            if n in ("app.v2",):
                self.board.mkdir("/w/" + n)
            else:
                self.board.put("/w/" + n, bytes([i]) * (i + 1))
        got = {e["name"]: e for e in devfs.list_dir(self.x, "/w")["entries"]}
        self.assertEqual(sorted(got), sorted(WEIRD_NAMES))
        for i, n in enumerate(WEIRD_NAMES):
            if n == "app.v2":
                self.assertEqual(got[n]["type"], "dir")
            else:
                self.assertEqual((got[n]["type"], got[n]["size"]), ("file", i + 1), n)

    #: the macOS/Windows sandbox filesystem used by the VM tests is case-insensitive
    CASE_SENSITIVE = True

    def test_fuzz_names_survive_list_manifest_put_get_rmtree(self):
        """Seeded random names with quotes, backslashes, control chars (incl. \\x04, which would end a
        raw-REPL reply), line separators, CJK and emoji must round-trip through every operation."""
        rnd = random.Random(20261012)
        alphabet = list("abcdefghijklmnopqrstuvwxyz0123456789 !#$%&'()*+,-.;=@[]^_`{}~\"\\\t\n\r\x01\x04\x1b\x7f")
        alphabet += ["\u00e9", "\u65e5", "\U0001f600", "\u2028", "\x85", "\u00a0"]
        if self.CASE_SENSITIVE:
            alphabet += list("ABCXYZ")
        names = set()
        seen_ci = set()
        while len(names) < 120:
            n = "".join(rnd.choice(alphabet) for _ in range(rnd.randint(1, 30)))
            if n in (".", "..") or n.lower() in seen_ci:
                continue
            names.add(n)
            seen_ci.add(n.lower())
        names = sorted(names)
        content = {}
        for i, n in enumerate(names):
            content["/fz/" + n] = n.encode("utf-8") + bytes([i % 256])
            self.board.put("/fz/" + n, content["/fz/" + n])
        listing = {e["name"]: e for e in devfs.list_dir(self.x, "/fz")["entries"]}
        self.assertEqual(sorted(listing), names)
        m = devfs.manifest(self.x, "/fz")
        self.assertEqual(len(m["entries"]), len(names))
        for e in m["entries"]:
            self.assertEqual((e["size"], e["sha256"]), (len(content[e["path"]]), sha(content[e["path"]])), e["path"])
            self.assertEqual(listing[e["path"][4:]]["size"], e["size"])
        for n in rnd.sample(names, 8):
            src = self.local("fz.bin", content["/fz/" + n] * 3)
            devfs.put_file(self.x, src, "/fz2/" + n, chunk=64)
            self.assertEqual(self.board.read("/fz2/" + n), content["/fz/" + n] * 3, repr(n))
            dst = os.path.join(self.tmp, "fz.out")
            devfs.get_file(self.x, "/fz/" + n, dst, chunk=16)
            with open(dst, "rb") as f:
                self.assertEqual(f.read(), content["/fz/" + n], repr(n))
        self.assertEqual(devfs.rmtree(self.x, "/fz")["removed"], len(names) + 1)
        self.assertFalse([p for p in self.board.tree() if p.startswith("/fz/") or p == "/fz"])
        self.no_temp_files()

    def test_list_errors(self):
        self.board.put("/f.txt", b"x")
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.list_dir, self.x, "/nope")
        e = self.assertFs("E_FS_ERRNO", "ENOTDIR", devfs.list_dir, self.x, "/f.txt")
        self.assertIn("/f.txt", e.message)

    def test_path_validation(self):
        for bad in ("lib", "", "/a/../b", "/a/./b", "/x\x00y"):
            self.assertFs("E_PROTOCOL", None, devfs.list_dir, self.x, bad)
        self.assertEqual(self.board.calls, [], "invalid paths must not reach the board")

    # --- fs.stat
    def test_stat(self):
        self.board.put("/d/f.py", b"abc")
        self.assertEqual(devfs.stat(self.x, "/d/f.py")["size"], 3)
        s = devfs.stat(self.x, "/d/f.py")
        self.assertEqual((s["exists"], s["type"]), (True, "file"))
        self.assertIsInstance(s["mtime"], int)
        d = devfs.stat(self.x, "/d")
        self.assertEqual((d["exists"], d["type"]), (True, "dir"))
        root = devfs.stat(self.x, "/")
        self.assertEqual((root["exists"], root["type"]), (True, "dir"))

    def test_pin_03_1_stat_of_missing_path_is_false_not_true(self):
        """old-defects 03.1: the old fileExists('definitely/not/here.py') returned true."""
        self.assertEqual(devfs.stat(self.x, "/definitely/not/here.py"), {"exists": False})
        self.board.put("/afile", b"1")
        self.assertEqual(devfs.stat(self.x, "/afile/below"), {"exists": False})  # a file in the path is not an error

    # --- fs.manifest
    def test_manifest_matches_host_sha256(self):
        big = pseudo_random(100 * 1024)
        self.board.put("/main.py", b"print('hi')\n")
        self.board.put("/zero", b"")
        self.board.put("/data/all.bin", ALL_BYTES)
        self.board.put("/data/big.bin", big)
        self.board.mkdir("/data/empty dir")
        self.board.put("/data/crlf.txt", CRLF_BLOB)
        n = len(self.board.calls)
        m = devfs.manifest(self.x, "/")
        self.assertEqual(len(self.board.calls) - n, 1, "manifest must be one round trip")
        self.assertEqual(m["hash"], "sha256")
        self.assertIs(m["truncated"], False)
        by = {e["path"]: e for e in m["entries"]}
        self.assertEqual(
            sorted(by),
            ["/data", "/data/all.bin", "/data/big.bin", "/data/crlf.txt", "/data/empty dir", "/main.py", "/zero"],
        )
        self.assertEqual(by["/data"], {"path": "/data", "type": "dir", "size": 0})
        self.assertEqual(by["/data/empty dir"]["type"], "dir")
        for p, content in (("/main.py", b"print('hi')\n"), ("/zero", b""), ("/data/all.bin", ALL_BYTES),
                           ("/data/big.bin", big), ("/data/crlf.txt", CRLF_BLOB)):  # fmt: skip
            self.assertEqual(by[p]["type"], "file")
            self.assertEqual(by[p]["size"], len(content), p)
            self.assertEqual(by[p]["sha256"], sha(content), p)
        self.assertEqual(m["warnings"], [])

    def test_manifest_200_files_one_round_trip(self):
        content = {}
        for i in range(200):
            p = "/d%d/sub%d/file %d.py" % (i % 10, i % 3, i)
            content[p] = ("# file %d\n" % i).encode() * (i % 7)
            self.board.put(p, content[p])
        n = len(self.board.calls)
        m = devfs.manifest(self.x, "/")
        self.assertEqual(len(self.board.calls) - n, 1)
        files = {e["path"]: e for e in m["entries"] if e["type"] == "file"}
        self.assertEqual(len(files), 200)
        for p, c in content.items():
            self.assertEqual((files[p]["size"], files[p]["sha256"]), (len(c), sha(c)), p)
        self.assertEqual(len([e for e in m["entries"] if e["type"] == "dir"]), 10 + 30)

    def test_manifest_subtree_exclude_and_no_hash(self):
        self.board.put("/lib/a.py", b"a")
        self.board.put("/lib/.git/config", b"x")
        self.board.put("/lib/.git/objects/ab", b"y")
        self.board.put("/lib/build/out.bin", b"z")
        self.board.put("/other/c.py", b"c")
        m = devfs.manifest(self.x, "/lib", exclude=["/lib/.git", "build"])
        self.assertEqual([e["path"] for e in m["entries"]], ["/lib/a.py"])
        m2 = devfs.manifest(self.x, "/", hash=False)
        self.assertEqual(m2["hash"], "none")
        self.assertTrue(all("sha256" not in e for e in m2["entries"]))
        self.assertEqual(len(m2["entries"]), 10)

    def test_manifest_errors(self):
        self.board.put("/f", b"1")
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.manifest, self.x, "/missing")
        self.assertFs("E_FS_ERRNO", "ENOTDIR", devfs.manifest, self.x, "/f")

    def test_pin_03_2_and_04_8_names_the_old_tree_parser_dropped(self):
        """old-defects 03.2 / 04.8: files named tree/ls, extension-less files, .mpy files, dotted dirs, empty dirs."""
        for p, c in {
            "/tree.py": b"1", "/tree": b"22", "/decision_tree.py": b"333", "/ls": b"4444", "/config": b"5",
            "/street.txt": b"6", "/lib/tree_utils.py": b"7", "/lib/mod.mpy": b"\x4d\x06\x00\x1f",
            "/streets/a.py": b"a", "/streets/b.py": b"b", "/app.v2/main.py": b"m",
        }.items():  # fmt: skip
            self.board.put(p, c)
        self.board.mkdir("/emptydir")
        m = devfs.manifest(self.x, "/")
        types_ = {e["path"]: e["type"] for e in m["entries"]}
        self.assertEqual(
            types_,
            {
                "/tree.py": "file", "/tree": "file", "/decision_tree.py": "file", "/ls": "file", "/config": "file",
                "/street.txt": "file", "/lib": "dir", "/lib/tree_utils.py": "file", "/lib/mod.mpy": "file",
                "/streets": "dir", "/streets/a.py": "file", "/streets/b.py": "file", "/app.v2": "dir",
                "/app.v2/main.py": "file", "/emptydir": "dir",
            },
        )  # fmt: skip
        root = {e["name"]: e["type"] for e in devfs.list_dir(self.x, "/")["entries"]}
        self.assertEqual(root["tree"], "file")
        self.assertEqual(root["config"], "file")
        self.assertEqual(root["app.v2"], "dir")
        self.assertEqual(root["ls"], "file")

    def test_pin_03_3_listing_has_real_sizes_and_full_paths(self):
        """old-defects 03.3: the old listing returned bare names, size 0, isDir=false."""
        self.board.put("/lib/deep/x.py", b"x" * 1234)
        m = devfs.manifest(self.x, "/")
        e = {e["path"]: e for e in m["entries"]}
        self.assertEqual(e["/lib/deep/x.py"]["size"], 1234)
        self.assertEqual(e["/lib"]["type"], "dir")

    def test_deep_tree_and_depth_guard(self):
        path = "/" + "/".join("d%d" % i for i in range(30)) + "/leaf.txt"
        self.board.put(path, b"leaf")
        m = devfs.manifest(self.x, "/")
        self.assertEqual(len(m["entries"]), 31)
        self.assertEqual(m["warnings"], [])

    # --- put / get
    def test_put_get_round_trip_payloads(self):
        payloads = {
            "zero": b"", "one": b"x", "all256": ALL_BYTES, "crlf": CRLF_BLOB, "k1023": pseudo_random(1023, 2),
            "k1024": pseudo_random(1024, 3), "k1025": pseudo_random(1025, 4), "big100k": pseudo_random(100 * 1024, 5),
        }  # fmt: skip
        for name, data in payloads.items():
            src = self.local(name + ".bin", data)
            r = devfs.put_file(self.x, src, "/up/" + name + ".bin")
            self.assertEqual(r, {"bytes": len(data), "sha256": sha(data), "skipped": False, "sent": len(data), "verified": "sha256"}, name)
            self.assertEqual(self.board.read("/up/" + name + ".bin"), data, name)
            dst = os.path.join(self.tmp, "down", name + ".bin")
            g = devfs.get_file(self.x, "/up/" + name + ".bin", dst)
            self.assertEqual((g["bytes"], g["sha256"]), (len(data), sha(data)), name)
            with open(dst, "rb") as f:
                self.assertEqual(f.read(), data, name)
        self.no_temp_files()
        self.assertFalse([f for f in os.listdir(os.path.join(self.tmp, "down")) if f.endswith(devfs.TMP_SUFFIX)])

    def test_put_chunk_sizes(self):
        data = pseudo_random(5000, 9)
        src = self.local("c.bin", data)
        for chunk in (16, 100, 1024, 4096, 5000, 8192):
            self.board.calls.clear()
            devfs.put_file(self.x, src, "/c.bin", chunk=chunk)
            self.assertEqual(self.board.read("/c.bin"), data, chunk)
            expect_calls = 1 if len(data) <= chunk else -(-len(data) // chunk) + 1
            self.assertEqual(len(self.board.calls), expect_calls, chunk)
        with self.assertRaises(ValueError):
            devfs.put_file(self.x, src, "/c.bin", chunk=0)

    def test_put_get_weird_names(self):
        for i, n in enumerate(WEIRD_NAMES):
            if n == "app.v2":
                continue
            data = bytes([i]) * (i * 7 + 3)
            src = self.local("src%d.bin" % i, data)
            devfs.put_file(self.x, src, "/weird dir (1)/" + n)
            self.assertEqual(self.board.read("/weird dir (1)/" + n), data, n)
            dst = os.path.join(self.tmp, "out", "%d.bin" % i)
            devfs.get_file(self.x, "/weird dir (1)/" + n, dst)
            with open(dst, "rb") as f:
                self.assertEqual(f.read(), data, n)
        self.no_temp_files()

    def test_put_name_so_long_the_temp_name_would_not_fit(self):
        name = "n" * 250 + ".py"
        data = b"long name"
        src = self.local("long.bin", data)
        devfs.put_file(self.x, src, "/" + name, chunk=16)  # multi-chunk path as well
        self.assertEqual(self.board.read("/" + name), data)
        self.no_temp_files()

    def test_put_creates_parents_in_the_same_pass(self):
        src = self.local("a.py", b"a = 1\n")
        n = len(self.board.calls)
        devfs.put_file(self.x, src, "/a/b/c/d.py")
        self.assertEqual(len(self.board.calls) - n, 1, "small file with new parents: a single round trip")
        self.assertEqual(self.board.read("/a/b/c/d.py"), b"a = 1\n")
        self.assertIsNone(self.board.tree()["/a/b"])

    def test_put_without_mkdirs_fails_when_parent_missing(self):
        src = self.local("a.py", b"a")
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.put_file, self.x, src, "/missing/dir/a.py", mkdirs=False)
        self.assertEqual(self.board.tree(), {})
        self.board.mkdir("/there")
        devfs.put_file(self.x, src, "/there/a.py", mkdirs=False)
        self.assertEqual(self.board.read("/there/a.py"), b"a")

    def test_put_file_in_the_way_of_a_parent(self):
        self.board.put("/lib", b"i am a file")
        src = self.local("a.py", b"a")
        self.assertFs("E_FS_ERRNO", "ENOTDIR", devfs.put_file, self.x, src, "/lib/a.py")
        self.assertEqual(self.board.read("/lib"), b"i am a file")
        self.no_temp_files()

    def test_put_target_is_directory(self):
        self.board.mkdir("/adir")
        src = self.local("a.py", b"a")
        self.assertFs("E_FS_ERRNO", None, devfs.put_file, self.x, src, "/adir")
        self.assertIn("/adir", self.board.tree())
        self.no_temp_files()

    def test_pin_03_10_put_replaces_atomically_and_leaves_no_temp(self):
        """old-defects 03.10: writes were in place (truncating) and unverified."""
        self.board.put("/main.py", b"OLD" * 1000)
        data = pseudo_random(3000, 6)
        src = self.local("main.py", data)
        seen = []

        def spy(code):  # while the upload is in flight the real target must still be the old file
            seen.append(self.board.read("/main.py"))

        base_hook = self.board.hook
        self.board.hook = lambda b, code: spy(code)
        devfs.put_file(self.x, src, "/main.py", chunk=1000)
        self.board.hook = base_hook
        self.assertTrue(all(s == b"OLD" * 1000 for s in seen[:-1]), "target changed before the final rename")
        self.assertEqual(self.board.read("/main.py"), data)
        self.no_temp_files()

    def test_put_cancel_mid_transfer_keeps_old_file_and_cleans_up(self):
        self.board.put("/keep.py", b"OLD CONTENT")
        src = self.local("keep.py", pseudo_random(10 * 1024, 7))
        cancel = threading.Event()
        ticks = []

        def progress(done, total, label):
            ticks.append((done, total, label))
            if done >= 3 * 1024:
                cancel.set()

        self.assertFs("E_CANCELLED", None, devfs.put_file, self.x, src, "/keep.py", progress=progress, cancel=cancel)
        self.assertEqual(self.board.read("/keep.py"), b"OLD CONTENT")
        self.no_temp_files()
        self.assertLess(ticks[-1][0], ticks[-1][1])

    def test_put_cancel_before_start_touches_nothing(self):
        src = self.local("a.py", b"a")
        cancel = threading.Event()
        cancel.set()
        self.assertFs("E_CANCELLED", None, devfs.put_file, self.x, src, "/a.py", cancel=cancel)
        self.assertEqual(self.board.calls, [])

    def test_put_transient_link_error_cleans_temp_old_file_intact(self):
        self.board.put("/m.py", b"OLD")
        src = self.local("m.py", pseudo_random(8 * 1024, 8))
        failing_after(self.board, 3, forever=False)  # 4th exec raises once, the cleanup call then works
        self.assertFs("E_NOT_CONNECTED", None, devfs.put_file, self.x, src, "/m.py")
        self.assertEqual(self.board.read("/m.py"), b"OLD")
        self.no_temp_files()

    def test_put_dead_link_leaves_old_file_and_clean_orphans_recovers(self):
        self.board.put("/m.py", b"OLD")
        src = self.local("m.py", pseudo_random(8 * 1024, 8))
        failing_after(self.board, 3, forever=True)
        self.assertFs("E_NOT_CONNECTED", None, devfs.put_file, self.x, src, "/m.py")
        self.assertEqual(self.board.read("/m.py"), b"OLD", "unplug must never damage the old file")
        orphans = [p for p in self.board.tree() if p.endswith(devfs.TMP_SUFFIX)]
        self.assertEqual(orphans, ["/m.py" + devfs.TMP_SUFFIX])
        self.board.hook = None
        r = devfs.clean_orphans(self.x, "/")
        self.assertEqual(r, {"removed": ["/m.py" + devfs.TMP_SUFFIX]})
        self.no_temp_files()
        self.assertEqual(self.board.read("/m.py"), b"OLD")

    def test_put_detects_corruption_in_transit(self):
        self.board.put("/m.py", b"OLD")
        data = pseudo_random(4000, 10)
        src = self.local("m.py", data)

        flipped = []

        def tamper(code, timeout=10.0):
            if "<<" not in code and 'open(tmp, "ab")' in code and not flipped:
                i = code.index("a2b_base64(\"") + len("a2b_base64(\"")
                j = code.index('"', i)
                payload = bytearray(base64.b64decode(code[i:j]))
                payload[0] ^= 0xFF
                code = code[:i] + base64.b64encode(bytes(payload)).decode() + code[j:]
                flipped.append(1)
            return self.x(code, timeout)

        e = self.assertFs("E_FS_ERRNO", "EIO", devfs.put_file, tamper, src, "/m.py", chunk=1000)
        self.assertIn("damaged", e.message)
        self.assertEqual(flipped, [1])
        self.assertEqual(self.board.read("/m.py"), b"OLD")
        self.no_temp_files()

    def test_put_without_board_hashing_still_verifies_the_size(self):
        """No hashlib on the board: a chunk that never arrived must still be caught by the size check."""
        self.swap_board(self.make_nohash_board())
        self.board.put("/m.py", b"OLD")
        src = self.local("m.py", pseudo_random(4000, 16))
        dropped = []

        def drop_second_chunk(code, timeout=10.0):
            if 'open(tmp, "ab")' in code and not dropped:
                dropped.append(1)
                return b'@@{"k":"ok"}\n', b""  # claims success, writes nothing
            return self.x(code, timeout)

        self.assertFs("E_FS_ERRNO", "EIO", devfs.put_file, drop_second_chunk, src, "/m.py", chunk=1000)
        self.assertEqual(dropped, [1])
        self.assertEqual(self.board.read("/m.py"), b"OLD")
        self.no_temp_files()

    def test_put_expect_sha_skips_when_board_already_has_it(self):
        data = b"unchanged content\n"
        src = self.local("u.py", data)
        devfs.put_file(self.x, src, "/u.py")
        self.board.calls.clear()
        progress = []
        r = devfs.put_file(self.x, src, "/u.py", expect_sha=sha(data).upper(), progress=lambda *a: progress.append(a))
        self.assertEqual((r["skipped"], r["bytes"], r["sha256"], r["sent"]), (True, len(data), sha(data), 0))
        self.assertEqual(len(self.board.calls), 1, "only the hash probe may run")
        self.assertNotIn("a2b_base64", self.board.calls[0])
        self.assertEqual(progress[-1][:2], (len(data), len(data)))
        # board has different content -> must write
        self.board.put("/u.py", b"different")
        r = devfs.put_file(self.x, src, "/u.py", expect_sha=sha(data))
        self.assertFalse(r["skipped"])
        self.assertEqual(self.board.read("/u.py"), data)
        # file missing on board -> must write
        r = devfs.put_file(self.x, src, "/new.py", expect_sha=sha(data))
        self.assertFalse(r["skipped"])
        # stale expect_sha (local edited since the plan) never skips and never loses the edit
        self.board.put("/stale.py", b"old board content")
        r = devfs.put_file(self.x, src, "/stale.py", expect_sha=sha(b"old board content"))
        self.assertFalse(r["skipped"])
        self.assertEqual(self.board.read("/stale.py"), data)

    def test_put_progress_is_monotonic_and_ends_complete(self):
        data = pseudo_random(5000, 11)
        src = self.local("p.bin", data)
        ticks = []
        devfs.put_file(self.x, src, "/p.bin", chunk=1024, progress=lambda d, t, l: ticks.append((d, t, l)))
        self.assertEqual(ticks[0], (0, 5000, "/p.bin"))
        self.assertEqual(ticks[-1], (5000, 5000, "/p.bin"))
        self.assertEqual([t[0] for t in ticks], sorted(t[0] for t in ticks))
        ticks.clear()
        devfs.get_file(self.x, "/p.bin", os.path.join(self.tmp, "p.out"), chunk=1500, progress=lambda d, t, l: ticks.append((d, t, l)))
        self.assertEqual(ticks[-1], (5000, 5000, "/p.bin"))

    def test_put_local_errors_are_e_local_io(self):
        self.assertFs("E_LOCAL_IO", "ENOENT", devfs.put_file, self.x, os.path.join(self.tmp, "nope.py"), "/x.py")
        d = os.path.join(self.tmp, "adir")
        os.makedirs(d)
        e = self.assertFs("E_LOCAL_IO", None, devfs.put_file, self.x, d, "/x.py")
        self.assertIn("adir", e.message)
        self.assertEqual(self.board.calls, [])

    def test_get_errors(self):
        self.board.mkdir("/adir")
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.get_file, self.x, "/missing.py", os.path.join(self.tmp, "m"))
        self.assertFs("E_FS_ERRNO", "EISDIR", devfs.get_file, self.x, "/adir", os.path.join(self.tmp, "m"))
        self.board.put("/f.py", b"data")
        blocker = self.local("blocker", b"i am a file")
        self.assertFs("E_LOCAL_IO", None, devfs.get_file, self.x, "/f.py", os.path.join(blocker, "sub", "f.py"))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "m")))

    def test_get_keeps_existing_local_file_when_download_dies(self):
        self.board.put("/f.bin", pseudo_random(6000, 12))
        dst = self.local("f.bin", b"LOCAL WORK")
        state = failing_after(self.board, 2, forever=True)  # hash probe + 1 chunk, then the link dies
        self.assertFs("E_NOT_CONNECTED", None, devfs.get_file, self.x, "/f.bin", dst, chunk=1000)
        with open(dst, "rb") as f:
            self.assertEqual(f.read(), b"LOCAL WORK")
        self.assertFalse(os.path.exists(dst + devfs.TMP_SUFFIX))
        self.assertGreater(state["n"], 2)

    def test_get_cancel(self):
        self.board.put("/f.bin", pseudo_random(6000, 12))
        dst = os.path.join(self.tmp, "f.out")
        cancel = threading.Event()
        self.assertFs("E_CANCELLED", None, devfs.get_file, self.x, "/f.bin", dst, chunk=1000,
                      progress=lambda d, t, l: cancel.set() if d >= 2000 else None, cancel=cancel)  # fmt: skip
        self.assertFalse(os.path.exists(dst))
        self.assertFalse(os.path.exists(dst + devfs.TMP_SUFFIX))

    def test_get_detects_corrupt_download(self):
        data = pseudo_random(3000, 13)
        self.board.put("/f.bin", data)
        dst = os.path.join(self.tmp, "f.out")

        def tamper(code, timeout=10.0):
            out, err = self.x(code, timeout)
            if b'"k":"d"' in out:
                i = out.index(b'"b":"') + 5
                out = out[:i] + (b"A" if out[i : i + 1] != b"A" else b"B") + out[i + 1 :]
            return out, err

        self.assertFs("E_FS_ERRNO", "EIO", devfs.get_file, tamper, "/f.bin", dst)
        self.assertFalse(os.path.exists(dst))
        self.assertFalse(os.path.exists(dst + devfs.TMP_SUFFIX))

    def test_paths_with_spaces_parens_at_and_unicode_locally(self):
        nasty = os.path.join(self.tmp, "OneDrive-Washington State University(email.wsu.edu)", "ME 241 (Fall)", "Lab 1")
        os.makedirs(nasty)
        src = os.path.join(nasty, "café @home (1).py")
        with open(src, "wb") as f:
            f.write(b"print('lab')\n")
        devfs.put_file(self.x, src, "/lab/café @home (1).py")
        back = os.path.join(nasty, "downloads", "café copy (2).py")
        devfs.get_file(self.x, "/lab/café @home (1).py", back)
        with open(back, "rb") as f:
            self.assertEqual(f.read(), b"print('lab')\n")

    # --- rm / rmtree / mkdir / mv
    def test_rm(self):
        self.board.put("/a/f.py", b"1")
        self.assertEqual(devfs.rm(self.x, "/a/f.py"), {})
        self.assertNotIn("/a/f.py", self.board.tree())
        self.assertIn("/a", self.board.tree())
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.rm, self.x, "/a/f.py")
        self.assertEqual(devfs.rm(self.x, "/a/f.py", missing_ok=True), {})
        self.assertFs("E_FS_ERRNO", "EISDIR", devfs.rm, self.x, "/a")
        self.assertIn("/a", self.board.tree())
        self.assertFs("E_PROTOCOL", None, devfs.rm, self.x, "/")

    def test_pin_03_5_and_03_12_rmtree_is_complete_and_survives_odd_names(self):
        """old-defects 03.5 / 03.12: Clear Device Files left street.txt and streets/*; names with 'ls' / double spaces survived."""
        keep = {"/lib2/keep.py": b"k", "/lib.py": b"k2", "/libx": b"k3", "/other/x": b"k4"}
        for p, c in keep.items():
            self.board.put(p, c)
        doomed = ["/lib/tools.py", "/lib/double  space.py", "/lib/ls", "/lib/street.txt", "/lib/streets/a.py",
                  "/lib/streets/b.py", "/lib/deep/er/est/file", "/lib/sp ace/new\nline", "/lib/it's/q\"uote"]  # fmt: skip
        for p in doomed:
            self.board.put(p, b"d")
        self.board.mkdir("/lib/empty/deeper")
        self.board.mkdir("/lib/.hidden")
        r = devfs.rmtree(self.x, "/lib")
        left = self.board.tree()
        self.assertFalse([p for p in left if p == "/lib" or p.startswith("/lib/")], left)
        for p, c in keep.items():
            self.assertEqual(left[p], c, "rmtree touched a sibling: " + p)
        # 9 files + dirs: lib, streets, deep, er, est, sp ace, it's, empty, deeper, .hidden
        self.assertEqual(r, {"removed": 9 + 10})

    def test_rmtree_many_files_takes_several_batches(self):
        for i in range(300):
            self.board.put("/big/dir%d/f%d" % (i % 4, i), b"x")
        self.board.put("/big/top", b"t")
        self.board.calls.clear()
        r = devfs.rmtree(self.x, "/big", batch=40)
        self.assertEqual(r["removed"], 301 + 4 + 1)
        self.assertGreater(len(self.board.calls), 5)
        self.assertEqual(self.board.tree(), {})

    def test_rmtree_cancel_between_batches(self):
        for i in range(100):
            self.board.put("/big/f%d" % i, b"x")
        cancel = threading.Event()
        self.assertFs("E_CANCELLED", None, devfs.rmtree, self.x, "/big", batch=10,
                      progress=lambda d, t, l: cancel.set(), cancel=cancel)  # fmt: skip
        self.assertTrue(self.board.tree())  # partially deleted, not corrupted

    def test_rmtree_refuses_root_and_unconfirmed_and_files(self):
        self.board.put("/main.py", b"1")
        for bad in ("/", "", "//", "/.", "///", "  "):
            self.assertFs("E_PROTOCOL", None, devfs.rmtree, self.x, bad)
        self.assertFs("E_PROTOCOL", None, devfs.rmtree, self.x, "/main.py", confirm=False)
        self.assertEqual(self.board.calls, [], "refused requests must never reach the board")
        self.assertFs("E_FS_ERRNO", "ENOTDIR", devfs.rmtree, self.x, "/main.py")
        self.assertEqual(self.board.read("/main.py"), b"1")
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.rmtree, self.x, "/nope")
        self.assertEqual(devfs.rmtree(self.x, "/nope", missing_ok=True), {"removed": 0})

    def test_rmtree_snippet_itself_refuses_root(self):
        """Defence in depth: even if the host check were bypassed, the device code refuses '/'."""
        code = devfs.render("rmtree", P=binascii.hexlify(b"/").decode(), LIMIT=10)
        self.board.put("/keep", b"1")
        out, err = self.x(code, 10.0)
        self.assertIn(b'"EPERM"', out)
        self.assertEqual(self.board.read("/keep"), b"1")

    def test_pin_04_15_mkdir_p_is_idempotent_and_creates_every_level(self):
        """old-defects 04.15 / 03.7: `fs mkdir -p` never worked; parents are created level by level."""
        self.assertEqual(devfs.mkdir_p(self.x, "/a/b/c"), {"created": 3})
        self.assertEqual(devfs.mkdir_p(self.x, "/a/b/c"), {"created": 0})
        self.assertEqual(devfs.mkdir_p(self.x, "/a/b/c/d/e"), {"created": 2})
        self.assertEqual(sorted(self.board.tree()), ["/a", "/a/b", "/a/b/c", "/a/b/c/d", "/a/b/c/d/e"])
        self.assertEqual(devfs.mkdir(self.x, "/a/b/c")["created"], 0)
        self.board.put("/file", b"1")
        self.assertFs("E_FS_ERRNO", "ENOTDIR", devfs.mkdir_p, self.x, "/file/sub")
        self.assertFs("E_FS_ERRNO", "ENOTDIR", devfs.mkdir_p, self.x, "/file")
        self.assertFs("E_PROTOCOL", None, devfs.mkdir_p, self.x, "/")

    def test_mkdir_without_parents(self):
        self.assertEqual(devfs.mkdir(self.x, "/one", parents=False), {"created": 1})
        self.assertFs("E_FS_ERRNO", "EEXIST", devfs.mkdir, self.x, "/one", parents=False)
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.mkdir, self.x, "/x/y", parents=False)

    def test_pin_03_1_mv_really_renames(self):
        """old-defects 03.1: `fs mv` was an exit-0 no-op that renamed nothing."""
        self.board.put("/old name.py", b"payload")
        self.assertEqual(devfs.mv(self.x, "/old name.py", "/new name.py"), {})
        self.assertIsNone(self.board.read("/old name.py"))
        self.assertEqual(self.board.read("/new name.py"), b"payload")
        self.board.mkdir("/sub")
        devfs.mv(self.x, "/new name.py", "/sub/moved.py")
        self.assertEqual(self.board.read("/sub/moved.py"), b"payload")
        self.board.put("/d1/inner.py", b"i")
        devfs.mv(self.x, "/d1", "/d2")
        self.assertEqual(self.board.read("/d2/inner.py"), b"i")
        self.assertNotIn("/d1", self.board.tree())

    def test_mv_errors(self):
        self.board.put("/a", b"A")
        self.board.put("/b", b"B")
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.mv, self.x, "/missing", "/c")
        e = self.assertFs("E_FS_ERRNO", "EEXIST", devfs.mv, self.x, "/a", "/b")
        self.assertEqual((self.board.read("/a"), self.board.read("/b")), (b"A", b"B"))
        self.assertIn("'/b'", e.message)
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.mv, self.x, "/a", "/nodir/a")
        self.assertEqual(devfs.mv(self.x, "/a", "/a"), {})
        self.assertEqual(self.board.read("/a"), b"A")

    # --- hash fallback behaviour (uses the board's hash switches)
    def _check_no_hash_behaviour(self):
        m = devfs.manifest(self.x, "/")
        self.assertEqual(m["hash"], "none")
        self.assertTrue(m["entries"] and all("sha256" not in e for e in m["entries"] if e["type"] == "file"))
        self.assertEqual({e["path"]: e["size"] for e in m["entries"] if e["type"] == "file"}, {"/a.bin": 5, "/d/b.bin": 256})
        data = pseudo_random(3000, 14)
        src = self.local("n.bin", data)
        r = devfs.put_file(self.x, src, "/n.bin", chunk=1000)
        self.assertEqual((r["sha256"], r["verified"], r["skipped"]), (sha(data), "size", False))
        self.assertEqual(self.board.read("/n.bin"), data)
        # expect_sha cannot be honoured without a board hash: it writes instead of skipping
        r = devfs.put_file(self.x, src, "/n.bin", expect_sha=sha(data))
        self.assertFalse(r["skipped"])
        g = devfs.get_file(self.x, "/n.bin", os.path.join(self.tmp, "n.out"))
        self.assertEqual((g["sha256"], g["verified"]), (sha(data), "size"))
        self.assertEqual(devfs.file_hash(self.x, "/n.bin")["sha256"], None)
        self.assertEqual(devfs.identity(self.x)["caps"]["hash"], "none")
        self.no_temp_files()

    # --- introspection
    def test_introspect_without_names_imports_nothing(self):
        r = devfs.introspect_modules(self.x)
        self.assertEqual(r["modules"], {})
        self.assertIn("os", r["listing"])
        self.assertNotIn("<<", self.board.calls[-1])
        self.assertIn('for nm in [_uh(h) for h in "".split(",") if h]', self.board.calls[-1])

    def test_introspect_bad_name_rejected_on_host(self):
        self.assertFs("E_PROTOCOL", None, devfs.introspect_modules, self.x, ["os; import shield"])
        self.assertEqual(self.board.calls, [])

    # --- tolerance of noise around the records
    def test_noise_banner_crlf_and_glued_prefix_are_ignored(self):
        self.board.put("/a/x.py", b"1")
        plain = devfs.manifest(self.x, "/")

        def noisy(code, timeout=10.0):
            out, err = self.x(code, timeout)
            lines = out.split(b"\n")
            first = lines[0]
            body = b"\r\n".join(lines[1:])
            return b"MicroPython v1.29.0 boot noise\r\nboot.py ran\r\nglued-garbage" + first + b"\r\n" + body + b"trailing noise\r\n", err

        self.assertEqual(devfs.manifest(noisy, "/"), plain)
        self.assertEqual(devfs.list_dir(noisy, "/a"), devfs.list_dir(self.x, "/a"))

    def test_damaged_record_is_a_clear_error(self):
        def damaged(code, timeout=10.0):
            return b'@@{"k":"h","h":"sha256"\r\n', b""

        e = self.assertFs("E_INTERNAL", None, devfs.manifest, damaged, "/")
        self.assertIn("damaged", e.message)

    def test_missing_end_marker_is_an_error_not_a_partial_result(self):
        def truncated(code, timeout=10.0):
            return b'@@{"k":"h","h":"sha256"}\n@@{"k":"f","p":"/a","s":1}\n', b""

        self.assertFs("E_INTERNAL", None, devfs.manifest, truncated, "/")

    def test_traceback_on_stderr_is_classified(self):
        def tb(text):
            def fn(code, timeout=10.0):
                return b"", text.encode()

            return fn

        hdr = "Traceback (most recent call last):\n  File \"<stdin>\", line 3, in <module>\n"
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.stat, tb(hdr + "OSError: [Errno 2] ENOENT\n"), "/x")
        self.assertFs("E_FS_ERRNO", "ENOSPC", devfs.stat, tb(hdr + "OSError: [Errno 28] ENOSPC\n"), "/x")
        self.assertFs("E_FS_ERRNO", "EIO", devfs.stat, tb(hdr + "OSError: 5\n"), "/x")
        self.assertFs("E_FS_ERRNO", "ENOMEM", devfs.stat, tb(hdr + "MemoryError: memory allocation failed, allocating 4096 bytes\n"), "/x")
        self.assertFs("E_CANCELLED", None, devfs.stat, tb(hdr + "KeyboardInterrupt: \n"), "/x")
        e = self.assertFs("E_INTERNAL", None, devfs.stat, tb(hdr + "NameError: name 'foo' isn't defined\n"), "/x")
        self.assertIn("NameError", e.detail)

    def test_exec_fn_may_return_str(self):
        self.board.put("/a", b"1")

        def as_str(code, timeout=10.0):
            out, err = self.x(code, timeout)
            return out.decode("utf-8"), err.decode("utf-8")

        self.assertEqual(devfs.stat(as_str, "/a")["size"], 1)


# =============================================================================================
# Concrete suites
# =============================================================================================

    # ---- damaged replies (finding 5): line noise may only ever produce a BridgeError
    def damage(self, pattern, repl):
        """exec_fn that rewrites the first match of regex ``pattern`` in the board's output (once)."""
        inner = self.x
        left = [1]

        def fn(code, timeout=10.0):
            out, err = inner(code, timeout)
            if left[0] and re.search(pattern, out):
                out = re.sub(pattern, repl, out, count=1)
                left[0] = 0
            return out, err

        return fn

    def assertDamaged(self, fn, *a, **kw):
        e = self.assertFs("E_INTERNAL", None, fn, *a, **kw)
        self.assertTrue(e.detail.startswith("damaged reply"), e.detail)
        self.assertTrue(e.message and e.hint)
        return e

    def test_get_with_a_lost_or_garbled_base64_byte_is_a_damaged_reply(self):
        self.board.put("/f.bin", pseudo_random(5000, 31))
        dest = os.path.join(self.tmp, "out", "f.bin")
        for label, repl in (("lost byte", rb"\1"), ("garbage byte", rb"\1!")):
            with self.subTest(label):
                flaky = self.damage(rb'("b":"[A-Za-z0-9+/]{8})[A-Za-z0-9+/]', repl)
                self.assertDamaged(devfs.get_file, flaky, "/f.bin", dest, chunk=1024)
                self.assertFalse(os.path.exists(dest))
                self.assertFalse(os.path.exists(dest + devfs.TMP_SUFFIX), "local temp file left behind")
        # and the very same download works once the line is clean
        self.assertEqual(devfs.get_file(self.x, "/f.bin", dest, chunk=1024)["bytes"], 5000)

    def test_get_with_a_garbled_length_field_is_a_damaged_reply(self):
        self.board.put("/f.bin", pseudo_random(700, 32))
        flaky = self.damage(rb'("k":"end","n":)\d+', rb'\1"zz"')
        self.assertDamaged(devfs.get_file, flaky, "/f.bin", os.path.join(self.tmp, "g.bin"))

    def test_rmtree_with_a_garbled_count_is_a_damaged_reply(self):
        self.board.put("/d/a.py", b"1")
        flaky = self.damage(rb'("k":"rm","n":)\d+', rb'\1"x"')
        self.assertDamaged(devfs.rmtree, flaky, "/d")

    def test_garbled_numbers_and_names_in_other_replies_are_damaged_replies(self):
        self.board.put("/é.py", b"12345")
        cases = [
            ("list size", rb'("s":)\d+', rb'\1"q"', devfs.list_dir, ("/",)),
            ("stat size", rb'("s":)\d+', rb"\1null", devfs.stat, ("/é.py",)),
            ("manifest size", rb'("s":)\d+', rb'\1[1]', devfs.manifest, ("/",)),
            ("hash size", rb'("s":)\d+', rb'\1{}', devfs.file_hash, ("/é.py",)),
            ("list hex name", rb'("nx":"[0-9a-f]+)', rb"\1zz", devfs.list_dir, ("/",)),
            ("mkdir count", rb'("k":"ok","c":)\d+', rb'\1"n"', devfs.mkdir, ("/q/r",)),
            ("identity version", rb'("version":\[)\d+', rb'\1"v"', devfs.identity, ()),
        ]
        for label, pat, repl, fn, args in cases:
            with self.subTest(label):
                self.assertDamaged(fn, self.damage(pat, repl), *args)

    # ---- mount points (finding 16)
    def test_rmtree_of_an_ordinary_top_level_folder_needs_no_extra_flag(self):
        # Decision: only mount points and the working folder are special; /lib, /data, /app are not.
        for top in ("/lib", "/data"):
            self.board.put(top + "/a.py", b"1")
            self.board.put(top + "/sub/b.py", b"2")
            self.assertEqual(devfs.rmtree(self.x, top), {"removed": 4})
            self.assertNotIn(top, self.board.tree())

    def test_mount_point_reason_is_none_for_plain_missing_and_nested_paths(self):
        self.board.put("/lib/a.py", b"1")
        self.board.put("/f.py", b"1")
        self.assertIsNone(devfs.mount_point_reason(self.x, "/lib"))
        self.assertIsNone(devfs.mount_point_reason(self.x, "/nope"))
        self.assertIsNone(devfs.mount_point_reason(self.x, "/f.py"))
        before = len(self.board.calls)
        self.assertIsNone(devfs.mount_point_reason(self.x, "/lib/sub"))  # deeper than a direct child: never probed
        self.assertEqual(len(self.board.calls), before)
        self.assertFs("E_PROTOCOL", None, devfs.mount_point_reason, self.x, "/")

    def test_rmtree_of_a_missing_top_level_folder_is_still_enoent(self):
        self.assertFs("E_FS_ERRNO", "ENOENT", devfs.rmtree, self.x, "/nope")
        self.assertEqual(devfs.rmtree(self.x, "/nope", missing_ok=True), {"removed": 0})

    def test_mount_probe_snippet_is_read_only(self):
        code = devfs.render("mount_probe", P=devfs._hexs("/lib"))
        for word in ("remove", "rmdir", "rename", "mkdir", "open(", "write"):
            self.assertNotIn(word, code)

    # ---- shadow guard (finding 17)
    GUARD = ["shield", "_shield", "machine"]

    def assertShadow(self, fn, *a, match="exact", **kw):
        before_calls, before_tree = len(self.board.calls), self.board.tree()
        e = self.assertFs("E_SHADOWS_MODULE", None, fn, *a, **kw)
        self.assertIn("match=" + match, e.detail)
        self.assertTrue(e.hint and e.message)
        self.assertEqual(len(self.board.calls), before_calls, "the board must not be asked anything")
        self.assertEqual(self.board.tree(), before_tree)
        return e

    def test_put_refuses_every_spelling_that_hides_a_guarded_module(self):
        src = self.local("x.py", b"print(1)\n")
        for remote in ("/shield.py", "/shield.mpy", "/_shield.mpy", "/shield/__init__.py", "/shield/sub/x.py", "/lib/shield.py",
                       "/lib/shield/__init__.py", "/lib/_shield.mpy", "/machine.py"):  # fmt: skip
            with self.subTest(remote):
                e = self.assertShadow(devfs.put_file, self.x, src, remote, shadow_guard=self.GUARD)
                self.assertIn("built into", e.message)
                self.assertIn(remote, e.message)
                mod = e.detail.split(";")[0].split("=")[1]
                self.assertIn(mod, self.GUARD)

    def test_put_lets_other_names_through_and_writes_them(self):
        src = self.local("x.py", b"print(1)\n")
        for remote in ("/shielding.py", "/my_shield.py", "/shield", "/shield.txt", "/shield.py.bak", "/lib/sub/shield.py",
                       "/app/shield.py", "/lib/shieldx/a.py", "/lib2/shield.py", "/mach.py", "/sub/machine.py"):  # fmt: skip
            with self.subTest(remote):
                self.assertTrue(devfs.put_file(self.x, src, remote, shadow_guard=self.GUARD)["bytes"])
                self.assertEqual(self.board.read(remote), b"print(1)\n")

    def test_shadow_guard_is_off_when_empty_or_missing(self):
        src = self.local("x.py", b"1")
        for g in (None, [], (), [""], ""):
            with self.subTest(g):
                devfs.put_file(self.x, src, "/shield.py", shadow_guard=g)

    def test_shadow_guard_case_variants_are_refused_and_say_why(self):
        src = self.local("x.py", b"1")
        for remote in ("/Shield.py", "/SHIELD/x.py", "/lib/_SHIELD.MPY", "/shield.PY", "/lib/Shield/__init__.py"):
            with self.subTest(remote):
                e = self.assertShadow(devfs.put_file, self.x, src, remote, shadow_guard=self.GUARD, match="case-insensitive")
                self.assertIn("capital letters", e.message)
                self.assertIn("same name", e.message)

    def test_shadow_guard_bare_string_is_one_name_and_dots_use_the_top_module(self):
        src = self.local("x.py", b"1")
        devfs.put_file(self.x, src, "/sh.py", shadow_guard="shield")  # not the letters s, h, i ...
        self.assertShadow(devfs.put_file, self.x, src, "/shield.py", shadow_guard="shield")
        self.assertShadow(devfs.put_file, self.x, src, "/machine.py", shadow_guard=["machine.Pin"])

    def test_shadow_roots_can_name_other_import_folders(self):
        src = self.local("x.py", b"1")
        roots = ["/flash", "/flash/lib"]
        self.assertShadow(devfs.put_file, self.x, src, "/flash/shield.py", shadow_guard=["shield"], shadow_roots=roots)
        self.assertShadow(devfs.put_file, self.x, src, "/flash/lib/shield/__init__.py", shadow_guard=["shield"], shadow_roots=roots)
        devfs.put_file(self.x, src, "/shield.py", shadow_guard=["shield"], shadow_roots=roots)  # '/' is not an import folder here
        self.assertFs("E_PROTOCOL", None, devfs.put_file, self.x, src, "/a.py", shadow_guard=["shield"], shadow_roots=["lib"])

    def test_put_with_a_matching_expect_sha_is_still_guarded(self):
        data = b"print(1)\n"
        src = self.local("x.py", data)
        self.assertShadow(devfs.put_file, self.x, src, "/shield.py", shadow_guard=self.GUARD, expect_sha=sha(data))

    def test_mkdir_refuses_folders_that_would_hide_a_module(self):
        for path in ("/lib/shield", "/shield/sub", "/_shield"):
            with self.subTest(path):
                self.assertShadow(devfs.mkdir, self.x, path, shadow_guard=self.GUARD)
        self.assertShadow(devfs.mkdir_p, self.x, "/lib/shield", shadow_guard=self.GUARD)
        self.assertShadow(devfs.mkdir, self.x, "/Shield", shadow_guard=self.GUARD, match="case-insensitive")
        # a FOLDER called shield.py cannot be imported, so it is allowed; so is everything unrelated
        self.assertEqual(devfs.mkdir(self.x, "/shield.py", shadow_guard=self.GUARD), {"created": 1})
        self.assertEqual(devfs.mkdir(self.x, "/lib/other", shadow_guard=self.GUARD)["created"], 2)

    def test_mv_refuses_destinations_that_would_hide_a_module(self):
        self.board.put("/a.py", b"1")
        self.board.put("/pkg/x.py", b"1")
        for dst in ("/shield.py", "/lib/shield", "/lib/shield/__init__.py", "/_shield.mpy"):
            with self.subTest(dst):
                self.assertShadow(devfs.mv, self.x, "/a.py", dst, shadow_guard=self.GUARD)
        self.assertShadow(devfs.mv, self.x, "/pkg", "/shield", shadow_guard=self.GUARD)
        self.assertShadow(devfs.mv, self.x, "/a.py", "/Shield.py", shadow_guard=self.GUARD, match="case-insensitive")
        devfs.mv(self.x, "/a.py", "/b.py", shadow_guard=self.GUARD)
        self.assertEqual(self.board.read("/b.py"), b"1")
        # moving a module away, or renaming a file onto its own name, is not creating a shadow
        self.board.put("/shield.py", b"1")
        self.assertEqual(devfs.mv(self.x, "/shield.py", "/shield.py", shadow_guard=self.GUARD), {})

    def test_check_shadow_is_usable_on_its_own(self):
        devfs.check_shadow("/ok.py", ["shield"])
        devfs.check_shadow("/shield.py", None)
        with self.assertRaises(BridgeError) as cm:
            devfs.check_shadow("/lib/shield.mpy", ["shield"])
        self.assertEqual(cm.exception.code, "E_SHADOWS_MODULE")
        with self.assertRaises(BridgeError) as cm:
            devfs.check_shadow("lib/shield.mpy", ["shield"])  # relative device path
        self.assertEqual(cm.exception.code, "E_PROTOCOL")

    # ---- upload temp file cleanup (finding 1)
    def test_cleanup_tmp_removes_an_existing_file_and_ignores_a_missing_one(self):
        self.board.put("/x.py.mpytmp", b"partial")
        self.assertIsNone(devfs._cleanup_tmp(self.x, "/x.py.mpytmp"))
        self.assertIsNone(devfs._cleanup_tmp(self.x, "/x.py.mpytmp"))
        self.assertIsNone(devfs._cleanup_tmp(self.x, "/no/such/dir/x.mpytmp"))
        self.no_temp_files()


class FakeBoardContractTests(FsContract, TimedCase):
    def make_board(self, **kw):
        return FakeBoard(**kw)

    def make_nohash_board(self):
        return FakeBoard(hash_mode="missing")

    # ---- behaviours that need fault injection (CPython fake only)
    def test_identity_esp32_like_profile(self):
        r = devfs.identity(self.x)
        self.assertEqual(r["impl"], "micropython")
        self.assertEqual(r["version"], [1, 29, 0])
        self.assertEqual(r["machine"], "ESP32 module with ESP32")
        self.assertEqual(r["build"], "STOCK_BOARD")
        self.assertEqual(r["mpy"], 6182)
        self.assertEqual(r["platform"], "esp32")
        self.assertEqual(r["uname"], {"sysname": "esp32", "nodename": "esp32", "release": "1.29.0",
                                       "version": "v1.29.0 on 2026-08-01", "machine": "ESP32 module with ESP32"})  # fmt: skip
        self.assertEqual(r["uniqueId"], "deadbeef0102")
        self.assertEqual(r["syspath"], ["", ".frozen", "/lib"])
        self.assertEqual(r["root"], [])
        self.assertEqual(r["caps"], {"hash": "sha256", "compile": True, "paste": None, "mem": 123456})
        self.assertEqual(r["profileHints"]["modules"], ["__main__", "array", "binascii", "builtins", "errno", "gc", "hashlib", "os"])
        self.assertTrue(r["profileHints"]["frozen"])
        self.assertGreater(r["profileHints"]["fsTotal"], 0)
        self.assertEqual(len(self.board.calls), 1, "identity is one round trip")

    def test_identity_lists_root_entries(self):
        self.board.put("/main.py", b"1")
        self.board.put("/lib/x.py", b"1")
        self.board.put("/ünï cödé", b"1")
        self.assertEqual(sorted(devfs.identity(self.x)["root"]), sorted(["main.py", "lib", "ünï cödé"]))

    def test_identity_minimal_old_firmware(self):
        """RQ-ID-1 'no _build (old firmware)': nothing but sys.implementation.name/version; still answers."""
        b = FakeBoard(build=None, machine=None, uname=None, unique_id=None, mem_free=None, hash_mode="missing",
                      has_compile=False, has_help=False)  # fmt: skip
        r = devfs.identity(b.exec_fn)
        self.assertEqual((r["build"], r["machine"], r["uniqueId"]), ("", "", ""))
        self.assertEqual(r["uname"], {k: "" for k in ("sysname", "nodename", "release", "version", "machine")})
        self.assertEqual(r["caps"], {"hash": "none", "compile": False, "paste": None, "mem": 0})
        self.assertEqual(r["profileHints"]["modules"], [])
        self.assertEqual(r["version"], [1, 29, 0])

    def test_identity_never_imports_application_packages(self):
        b = FakeBoard(extra_modules={"shield": types.ModuleType("shield"), "_shield": types.ModuleType("_shield")})
        devfs.identity(b.exec_fn)
        self.assertNotIn("shield", b.sys.modules)
        self.assertNotIn("_shield", b.sys.modules)
        self.assertTrue(set(b.sys.modules) <= {"binascii", "errno", "gc", "hashlib", "machine", "os", "sys"}, b.sys.modules)

    def test_introspect_named_modules(self):
        mod = types.ModuleType("fancy")
        mod.ABI = 7
        mod.NAME = "fw"
        mod.FLAG = True
        mod.ratio = 0.5
        mod.blob = b"\x00\x01"
        mod.helper = lambda: 1
        mod.Motor = type("Motor", (), {})
        mod.sub = types.ModuleType("sub")
        mod.__file__ = "fancy.py"
        b = FakeBoard(extra_modules={"fancy": mod})
        r = devfs.introspect_modules(b.exec_fn, ["fancy", "missing_mod"])
        info = r["modules"]["fancy"]
        self.assertEqual(info["attrs"], ["ABI", "FLAG", "Motor", "NAME", "blob", "helper", "ratio", "sub"])
        self.assertEqual(info["kinds"], {"ABI": "int", "FLAG": "bool", "Motor": "class", "NAME": "str", "blob": "bytes",
                                         "helper": "function", "ratio": "float", "sub": "module"})  # fmt: skip
        self.assertEqual(info["consts"], {"ABI": 7, "FLAG": True, "NAME": "fw", "blob": b"\x00\x01", "ratio": 0.5})
        self.assertEqual(info["file"], "fancy.py")
        self.assertIn("ImportError", r["modules"]["missing_mod"]["error"])
        self.assertIn("os", r["listing"])

    def test_introspect_does_not_trigger_lazy_attributes(self):
        class Lazy(types.ModuleType):
            touched = []

            def __getattr__(self, name):
                Lazy.touched.append(name)
                raise AttributeError(name)

        mod = Lazy("lazy")
        mod.real = 1
        b = FakeBoard(extra_modules={"lazy": mod})
        r = devfs.introspect_modules(b.exec_fn, ["lazy"])
        self.assertEqual(r["modules"]["lazy"]["attrs"], ["real"])
        self.assertEqual(Lazy.touched, [])

    def test_hash_missing_import_error(self):
        self.swap_board(FakeBoard(hash_mode="missing"))
        self.board.put("/a.bin", b"12345")
        self.board.put("/d/b.bin", ALL_BYTES)
        self._check_no_hash_behaviour()

    def test_hash_module_without_sha256(self):
        self.swap_board(FakeBoard(hash_mode="nosha256"))
        self.board.put("/a.bin", b"12345")
        self.board.put("/d/b.bin", ALL_BYTES)
        self._check_no_hash_behaviour()

    def test_hash_broken_sha256_is_detected_by_self_test(self):
        self.swap_board(FakeBoard(hash_mode="broken"))
        self.board.put("/a.bin", b"12345")
        self.board.put("/d/b.bin", ALL_BYTES)
        self._check_no_hash_behaviour()

    def test_full_flash_is_detected_before_writing(self):
        self.swap_board(FakeBoard(capacity=4096))
        src = self.local("big.bin", pseudo_random(10_000, 15))
        e = self.assertFs("E_FS_ERRNO", "ENOSPC", devfs.put_file, self.x, src, "/big.bin")
        self.assertIn("full", e.message)
        self.assertEqual(self.board.tree(), {})
        # the first call fails the free-space pre-check before writing; the second is the temp cleanup
        self.assertEqual(len(self.board.calls), 2)
        self.assertNotIn("a2b_base64", self.board.calls[1])

    def test_flash_fills_up_mid_transfer_cleans_temp(self):
        self.swap_board(FakeBoard(write_budget=3000))  # statvfs says plenty, writes run out
        self.board.put("/keep", b"K")
        self.board.fs.write_budget = 3000
        src = self.local("big.bin", pseudo_random(10_000, 15))
        self.assertFs("E_FS_ERRNO", "ENOSPC", devfs.put_file, self.x, src, "/big.bin", chunk=1024)
        self.assertEqual(set(self.board.tree()), {"/keep"})

    def test_read_only_filesystem(self):
        self.swap_board(FakeBoard(readonly=True))
        self.board.put("/m.py", b"OLD")
        src = self.local("m.py", b"NEW")
        e = self.assertFs("E_FS_ERRNO", "EROFS", devfs.put_file, self.x, src, "/m.py")
        self.assertIn("read-only", e.message)
        self.assertEqual(self.board.read("/m.py"), b"OLD")
        self.assertFs("E_FS_ERRNO", "EROFS", devfs.rm, self.x, "/m.py")
        self.assertFs("E_FS_ERRNO", "EROFS", devfs.mkdir_p, self.x, "/new/dir")

    def test_fat_style_rename_over_existing_target(self):
        self.swap_board(FakeBoard(rename_mode="fat"))
        self.board.put("/m.py", b"OLD")
        src = self.local("m.py", b"NEW CONTENT")
        r = devfs.put_file(self.x, src, "/m.py")
        self.assertEqual(self.board.read("/m.py"), b"NEW CONTENT")
        self.assertEqual(r["verified"], "sha256")
        self.no_temp_files()
        # a target that is a directory is never removed to make room
        self.board.mkdir("/adir")
        self.assertFs("E_FS_ERRNO", None, devfs.put_file, self.x, src, "/adir")
        self.assertIn("/adir", self.board.tree())

    def test_move_across_mounts_gives_a_clear_error(self):
        self.swap_board(FakeBoard(mounts=["/sd"]))
        self.board.put("/flash.py", b"F")
        self.board.mkdir("/sd")
        e = self.assertFs("E_FS_ERRNO", "EXDEV", devfs.mv, self.x, "/flash.py", "/sd/flash.py")
        self.assertIn("different filesystem", e.message)
        self.assertIn("Copy", e.hint)
        self.assertEqual(self.board.read("/flash.py"), b"F")
        self.assertIsNone(self.board.read("/sd/flash.py"))
        # a temp-file upload into the same mount still works (temp and target share the directory)
        src = self.local("s.py", b"on the card")
        devfs.put_file(self.x, src, "/sd/s.py")
        self.assertEqual(self.board.read("/sd/s.py"), b"on the card")

    def test_second_rename_failure_keeps_the_temp_file(self):
        """FAT path: target removed, then the rename fails -> the temp file holds the only copy and must stay."""
        self.swap_board(FakeBoard(rename_mode="fat_then_fail"))
        self.board.put("/m.py", b"OLD")
        src = self.local("m.py", b"NEW CONTENT")
        self.assertFs("E_FS_ERRNO", "EIO", devfs.put_file, self.x, src, "/m.py")
        self.assertEqual(self.board.read("/m.py" + devfs.TMP_SUFFIX), b"NEW CONTENT")
        self.assertIsNone(self.board.read("/m.py"))

    def test_only_allowed_modules_are_imported_by_every_snippet(self):
        """The fake board's import hook raises ImportError for anything else; run every op once."""
        self.board.put("/a/x.py", b"1")
        src = self.local("s.py", b"s")
        devfs.list_dir(self.x, "/")
        devfs.manifest(self.x, "/")
        devfs.stat(self.x, "/a")
        devfs.file_hash(self.x, "/a/x.py")
        devfs.put_file(self.x, src, "/p/s.py")
        devfs.put_file(self.x, src, "/p/s2.py", chunk=16)
        devfs.get_file(self.x, "/a/x.py", os.path.join(self.tmp, "o"))
        devfs.mkdir_p(self.x, "/m/n")
        devfs.mv(self.x, "/a/x.py", "/a/y.py")
        devfs.rm(self.x, "/a/y.py")
        devfs.rmtree(self.x, "/m")
        devfs.identity(self.x)
        devfs.introspect_modules(self.x)
        used = set()
        for code in self.board.calls:
            for node in ast.walk(ast.parse(code)):
                if isinstance(node, ast.Import):
                    used.update(a.name for a in node.names)
        self.assertTrue(used <= {"os", "binascii", "ubinascii", "errno", "hashlib", "uhashlib", "gc", "sys", "machine"}, used)


    # ---- mount points (finding 16): boards whose statvfs/st_dev/cwd differ per mount
    PYBOARD_VFS = {"/": (0, 0, 0, 0, 0, 0, 0, 0, 0, 255), "/flash": (512, 512, 4000, 3000, 3000, 0, 0, 0, 0, 255)}

    def pyboard(self):
        """A pyboard: '/' is a virtual root (empty statvfs), the drive is /flash."""
        b = self.swap_board(FakeBoard(mounts=["/flash"], vfs=self.PYBOARD_VFS, cwd="/flash"))
        b.put("/flash/boot.py", b"# boot")
        b.put("/flash/main.py", b"# main")
        b.put("/flash/lib/util.py", b"x")
        return b

    def test_rmtree_refuses_the_pyboard_drive_before_deleting_anything(self):
        b = self.pyboard()
        before = b.tree()
        e = self.assertFs("E_FS_ERRNO", "EPERM", devfs.rmtree, self.x, "/flash")
        self.assertTrue(e.needs_allow_mount)
        self.assertEqual(e.mount_reason, "root")
        self.assertIn("allowMount", e.hint)
        self.assertIn("boot.py", e.message)
        self.assertEqual(b.tree(), before)
        self.assertEqual(len(b.calls), 1, "only the read-only probe ran")
        for bad in ("yes", 1, None):  # only an explicit True lifts the guard
            self.assertFs("E_FS_ERRNO", "EPERM", devfs.rmtree, self.x, "/flash", allow_mount=bad)
        self.assertEqual(b.tree(), before)

    def test_rmtree_inside_the_drive_and_with_allow_mount(self):
        b = self.pyboard()
        calls = len(b.calls)
        self.assertEqual(devfs.rmtree(self.x, "/flash/lib"), {"removed": 2})  # depth 2: no probe, no flag
        self.assertFalse(any("mnt" in c for c in b.calls[calls:]))
        self.assertEqual(devfs.rmtree(self.x, "/flash", allow_mount=True), {"removed": 3})  # boot.py, main.py, /flash
        self.assertEqual([p for p in b.tree() if p.startswith("/flash/")], [])

    def test_confirm_and_root_checks_come_before_the_mount_check(self):
        b = self.pyboard()
        self.assertFs("E_PROTOCOL", None, devfs.rmtree, self.x, "/flash", confirm=False)
        self.assertFs("E_PROTOCOL", None, devfs.rmtree, self.x, "/", allow_mount=True)
        self.assertEqual(b.calls, [])

    def test_rmtree_refuses_an_sd_card_mounted_below_a_real_root(self):
        sd = (512, 512, 2_000_000, 1_999_000, 1_999_000, 0, 0, 0, 0, 255)
        b = self.swap_board(FakeBoard(mounts=["/sd"], vfs={"/sd": sd}))
        b.put("/lib/a.py", b"1")
        b.put("/sd/log.txt", b"1")
        e = self.assertFs("E_FS_ERRNO", "EPERM", devfs.rmtree, self.x, "/sd")
        self.assertEqual(e.mount_reason, "vfs")
        self.assertEqual(b.read("/sd/log.txt"), b"1")
        self.assertEqual(devfs.rmtree(self.x, "/lib"), {"removed": 2})  # an ordinary top-level folder
        self.assertEqual(devfs.rmtree(self.x, "/sd", allow_mount=True), {"removed": 2})

    def test_rmtree_refuses_a_folder_on_another_device(self):
        b = self.swap_board(FakeBoard(mounts=["/mnt"], devs={"/": 3, "/mnt": 9}))
        b.put("/mnt/x.txt", b"1")
        b.put("/lib/a.py", b"1")
        e = self.assertFs("E_FS_ERRNO", "EPERM", devfs.rmtree, self.x, "/mnt")
        self.assertEqual(e.mount_reason, "dev")
        self.assertEqual(devfs.rmtree(self.x, "/lib"), {"removed": 2})  # same st_dev as '/': plain folder
        self.assertEqual(b.read("/mnt/x.txt"), b"1")

    def test_rmtree_refuses_the_boards_working_folder(self):
        b = self.swap_board(FakeBoard(cwd="/app"))
        b.put("/app/main.py", b"1")
        b.put("/lib/a.py", b"1")
        e = self.assertFs("E_FS_ERRNO", "EPERM", devfs.rmtree, self.x, "/app")
        self.assertEqual(e.mount_reason, "cwd")
        self.assertEqual(devfs.rmtree(self.x, "/lib"), {"removed": 2})
        self.assertEqual(devfs.rmtree(self.x, "/app", allow_mount=True), {"removed": 2})

    def test_a_garbled_mount_probe_reply_is_a_bridge_error(self):
        b = self.pyboard()
        real = b.exec_fn
        self.x = lambda code, timeout=10.0: (b"", b"") if "mnt" in code else real(code, timeout)
        self.assertFs("E_INTERNAL", None, devfs.rmtree, self.x, "/flash")  # no 'mnt' reply: refuse to guess
        self.assertEqual(len(b.read("/flash/boot.py")), 6)

    # ---- upload temp file cleanup after Stop / errors (finding 1)
    def cancelling_after(self, n_appends, abort_fails=0, abort_error="E_CANCELLED"):
        """exec_fn that raises E_CANCELLED on the n-th chunk append, then fails ``abort_fails`` cleanup calls."""
        state = {"appends": 0, "aborts": 0, "abort_timeouts": []}
        inner = self.board.exec_fn

        def fn(code, timeout=10.0):
            if '_er(e, "abort")' in code:
                state["aborts"] += 1
                state["abort_timeouts"].append(timeout)
                if state["aborts"] <= abort_fails:
                    raise BridgeError(abort_error, "Stopped (test)")
            elif 'open(tmp, "ab")' in code:
                state["appends"] += 1
                if state["appends"] == n_appends:
                    raise BridgeError("E_CANCELLED", "Stopped (test)")
            return inner(code, timeout)

        self.x = fn
        return state

    def test_stop_during_an_upload_removes_the_temp_file(self):
        self.board.put("/m.py", b"OLD")
        src = self.local("m.py", pseudo_random(8 * 1024, 21))
        state = self.cancelling_after(3)
        e = self.assertFs("E_CANCELLED", None, devfs.put_file, self.x, src, "/m.py", chunk=1024)
        self.assertFalse(hasattr(e, "cleanup"))
        self.assertNotIn("deferred", e.detail)
        self.assertEqual(state["aborts"], 1)
        self.assertEqual(self.board.read("/m.py"), b"OLD")
        self.no_temp_files()

    def test_cleanup_is_retried_once_when_the_first_attempt_is_hit_by_a_late_ctrl_c(self):
        self.board.put("/m.py", b"OLD")
        src = self.local("m.py", pseudo_random(8 * 1024, 22))
        state = self.cancelling_after(2, abort_fails=1)
        with mock.patch.object(devfs, "CLEANUP_RETRY_WAIT", 0.01):
            e = self.assertFs("E_CANCELLED", None, devfs.put_file, self.x, src, "/m.py", chunk=1024)
        self.assertEqual(state["aborts"], 2)
        self.assertNotIn("deferred", e.detail)
        self.no_temp_files()
        self.assertEqual(self.board.read("/m.py"), b"OLD")

    def test_cleanup_that_keeps_failing_is_deferred_and_visible_in_the_error(self):
        self.board.put("/m.py", b"OLD")
        src = self.local("m.py", pseudo_random(8 * 1024, 23))
        state = self.cancelling_after(2, abort_fails=99, abort_error="E_BOARD_UNRESPONSIVE")
        with mock.patch.object(devfs, "CLEANUP_RETRY_WAIT", 0.01):
            e = self.assertFs("E_CANCELLED", None, devfs.put_file, self.x, src, "/m.py", chunk=1024)
        self.assertEqual(state["aborts"], 2, "one retry, not a loop")
        self.assertEqual(e.cleanup, "deferred")
        self.assertEqual(e.tmp_path, "/m.py" + devfs.TMP_SUFFIX)
        self.assertIn('cleanup:"deferred"', e.detail)
        self.assertIn("/m.py" + devfs.TMP_SUFFIX, e.detail)
        self.assertIn("E_BOARD_UNRESPONSIVE", e.detail)
        self.assertEqual(e.to_dict()["detail"], e.detail)
        self.assertEqual(self.board.read("/m.py"), b"OLD")
        # ... and the file the cleanup could not remove is what clean_orphans() is for
        self.assertEqual([p for p in self.board.tree() if p.endswith(devfs.TMP_SUFFIX)], ["/m.py" + devfs.TMP_SUFFIX])
        self.assertEqual(devfs.clean_orphans(self.board.exec_fn, "/"), {"removed": ["/m.py" + devfs.TMP_SUFFIX]})
        self.no_temp_files()

    def test_cleanup_attempts_are_short(self):
        src = self.local("m.py", pseudo_random(4 * 1024, 24))
        state = self.cancelling_after(2, abort_fails=1)
        with mock.patch.object(devfs, "CLEANUP_RETRY_WAIT", 0.01):
            self.assertFs("E_CANCELLED", None, devfs.put_file, self.x, src, "/m.py", chunk=1024)
        self.assertEqual(len(state["abort_timeouts"]), 2)
        for t in state["abort_timeouts"]:
            self.assertTrue(0 < t <= devfs.CLEANUP_TIMEOUT <= 5.0, t)

    def test_cancel_before_the_first_byte_sends_nothing_at_all(self):
        src = self.local("m.py", b"x" * 100)
        ev = threading.Event()
        ev.set()
        self.assertFs("E_CANCELLED", None, devfs.put_file, self.x, src, "/m.py", cancel=ev)
        self.assertEqual(self.board.calls, [], "no temp file can exist yet, so no cleanup round trip either")

    def test_cleanup_that_cannot_remove_an_existing_temp_file_is_deferred(self):
        b = self.swap_board(FakeBoard(readonly=True))
        b.put("/m.py" + devfs.TMP_SUFFIX, b"stale")  # a temp file a read-only filesystem refuses to remove
        src = self.local("m.py", b"x" * 100)
        with mock.patch.object(devfs, "CLEANUP_RETRY_WAIT", 0.01):
            e = self.assertFs("E_FS_ERRNO", None, devfs.put_file, self.x, src, "/m.py")
        self.assertEqual(e.cleanup, "deferred")
        self.assertTrue(e.detail.startswith("EROFS;"), e.detail)

    def test_dead_link_during_an_upload_marks_the_cleanup_as_deferred(self):
        self.board.put("/m.py", b"OLD")
        src = self.local("m.py", pseudo_random(8 * 1024, 8))
        failing_after(self.board, 3, forever=True)
        with mock.patch.object(devfs, "CLEANUP_RETRY_WAIT", 0.01):
            e = self.assertFs("E_NOT_CONNECTED", None, devfs.put_file, self.x, src, "/m.py")
        self.assertEqual(e.cleanup, "deferred")
        self.assertIn('cleanup:"deferred"', e.detail)

    # ---- random line noise on every reply (findings 5): only BridgeError may come out
    def test_random_damage_to_any_reply_only_ever_raises_bridge_error(self):
        self.board.put("/f.bin", pseudo_random(3000, 41))
        self.board.put("/d/e.py", b"1")
        src = self.local("g.bin", pseudo_random(3000, 42))
        dest = os.path.join(self.tmp, "dl", "f.bin")
        ops = {
            "list": lambda x: devfs.list_dir(x, "/"),
            "manifest": lambda x: devfs.manifest(x, "/"),
            "stat": lambda x: devfs.stat(x, "/f.bin"),
            "file_hash": lambda x: devfs.file_hash(x, "/f.bin"),
            "identity": devfs.identity,
            "introspect": lambda x: devfs.introspect_modules(x, ["os"]),
            "put": lambda x: devfs.put_file(x, src, "/g.bin", chunk=1024),
            "get": lambda x: devfs.get_file(x, "/f.bin", dest, chunk=1024),
            "mkdir": lambda x: devfs.mkdir(x, "/q/r"),
            "mv": lambda x: devfs.mv(x, "/f.bin", "/h.bin"),
            "rm": lambda x: devfs.rm(x, "/f.bin"),
            "rmtree": lambda x: devfs.rmtree(x, "/d", batch=1),
            "mount": lambda x: devfs.mount_point_reason(x, "/d"),
        }
        escapes = {}
        for name, op in ops.items():
            rec = []

            def recorder(code, timeout=10.0, _rec=rec):
                o = self.board.exec_fn(code, timeout)
                _rec.append(o)
                return o

            op(recorder)
            self.board.put("/f.bin", pseudo_random(3000, 41))
            self.board.put("/d/e.py", b"1")
            rng = random.Random(7)
            for _ in range(120):
                seq = []
                for out, err in rec:
                    b = bytearray(out)
                    if b and rng.random() < 0.6:
                        m = rng.randrange(4)
                        if m == 0:
                            del b[rng.randrange(len(b)) :]
                        elif m == 1:
                            b[rng.randrange(len(b))] = rng.randrange(256)
                        elif m == 2:
                            b[rng.randrange(len(b) + 1) : 0] = bytes(rng.randrange(256) for _ in range(rng.randrange(1, 9)))
                        else:
                            del b[rng.randrange(len(b))]
                    seq.append((bytes(b), err))
                it = iter(seq)
                try:
                    with mock.patch.object(devfs, "CLEANUP_RETRY_WAIT", 0):
                        op(lambda code, timeout=10.0, _it=it: next(_it, (b"", b"")))
                except BridgeError:
                    pass
                except Exception as exc:  # noqa: BLE001
                    escapes.setdefault((name, type(exc).__name__), str(exc)[:80])
        self.assertEqual(escapes, {})


@unittest.skipUnless(HAVE_VM, VM_SKIP)
class VmContractTests(FsContract, TimedCase):
    CASE_SENSITIVE = False

    def make_board(self, **kw):
        return VmBoard(**kw)

    def make_nohash_board(self):
        return VmBoard(flags=["nohash"])

    def test_identity_on_the_unix_vm(self):
        r = devfs.identity(self.x)
        self.assertEqual(r["impl"], "micropython")
        self.assertEqual(r["version"][:2], [1, 29])
        self.assertTrue(r["platform"])
        self.assertEqual(r["caps"]["hash"], "sha256")
        self.assertIs(r["caps"]["compile"], True)
        self.assertIsNone(r["caps"]["paste"])
        self.assertGreater(r["caps"]["mem"], 0)
        # the unix port has no os.uname and no machine.unique_id: both fall back to empty strings
        self.assertEqual(r["uname"]["sysname"], "")
        self.assertEqual(r["uniqueId"], "")
        self.assertIn("os", r["profileHints"]["modules"])
        self.assertIn(".frozen", r["syspath"])
        self.assertEqual(r["root"], [])
        self.assertGreater(r["profileHints"]["fsTotal"], 0)

    def test_identity_does_not_import_application_modules(self):
        # The VM build lists a frozen "_shield" in help('modules'); identity must only LIST it.
        r = devfs.identity(self.x)
        self.assertNotIn("shield", [m for m in r["profileHints"]["modules"] if m == "shield"])
        for code in self.board.calls:
            self.assertNotIn("import shield", code)
            self.assertNotIn("__import__", code)

    def test_introspect_real_module(self):
        r = devfs.introspect_modules(self.x, ["errno", "math", "nonexistent_zzz"])  # (not "os": the harness shims it)
        e = r["modules"]["errno"]
        self.assertEqual(e["consts"]["ENOENT"], 2)
        self.assertEqual(e["kinds"]["ENOENT"], "int")
        self.assertIn("errorcode", e["attrs"])
        self.assertIn("sin", r["modules"]["math"]["attrs"])
        self.assertEqual(r["modules"]["math"]["kinds"]["sin"], "function")
        self.assertEqual(r["modules"]["math"]["kinds"]["pi"], "float")
        self.assertAlmostEqual(r["modules"]["math"]["consts"]["pi"], 3.14159265, places=6)
        self.assertIn("ImportError", r["modules"]["nonexistent_zzz"]["error"])
        self.assertIn("os", r["listing"])

    def test_vm_without_hashlib_uses_size_only(self):
        self.swap_board(VmBoard(flags=["nohash"]))
        self.board.put("/a.bin", b"12345")
        self.board.put("/d/b.bin", ALL_BYTES)
        self._check_no_hash_behaviour()

    def test_vm_hashlib_without_sha256_uses_size_only(self):
        self.swap_board(VmBoard(flags=["nosha256"]))
        self.board.put("/a.bin", b"12345")
        self.board.put("/d/b.bin", ALL_BYTES)
        self._check_no_hash_behaviour()

    def test_constant_ram_small_heap(self):
        """A 128 KiB-class heap hashes/lists/transfers far more data than fits in RAM."""
        self.swap_board(VmBoard(heap="96k"))
        for i in range(300):
            self.board.put("/many/dir%d/file %03d.txt" % (i % 7, i), b"%d\n" % i * (i % 20))
        big = pseudo_random(600 * 1024, 21)
        self.board.put("/big.bin", big)
        m = devfs.manifest(self.x, "/")
        by = {e["path"]: e for e in m["entries"]}
        self.assertEqual(by["/big.bin"]["sha256"], sha(big))
        self.assertEqual(len([e for e in m["entries"] if e["type"] == "file"]), 301)
        # download and upload 600 KiB through the same tiny heap
        out = os.path.join(self.tmp, "big.out")
        devfs.get_file(self.x, "/big.bin", out, chunk=8192)
        with open(out, "rb") as f:
            self.assertEqual(sha(f.read()), sha(big))
        devfs.put_file(self.x, out, "/copy/big2.bin", chunk=4096)
        self.assertEqual(sha(self.board.read("/copy/big2.bin")), sha(big))
        devfs.rmtree(self.x, "/many")
        self.assertFalse([p for p in self.board.tree() if p.startswith("/many")])

    def test_uncaught_micropython_tracebacks_are_classified(self):
        """Real MicroPython traceback text (not hand-written samples) through the stderr classifier."""
        e = self.assertFs("E_FS_ERRNO", "ENOENT", devfs._run, self.x, 'import os\nos.stat("/nonexistent")\n', 10.0, "testing", "/nonexistent")
        self.assertIn("/nonexistent", e.message)
        self.assertFs("E_INTERNAL", None, devfs._run, self.x, "undefined_name_zz\n", 10.0, "testing")
        self.swap_board(VmBoard(heap="96k"))
        self.assertFs("E_FS_ERRNO", "ENOMEM", devfs._run, self.x, "b = bytearray(5000000)\n", 10.0, "testing")

    def test_harness_rejects_relative_paths(self):
        """Sanity check of the sandbox shim itself: a snippet must never reach the real cwd."""
        out, err = self.x('import os\nprint(os.stat("relative.txt"))\n')
        self.assertIn(b"non-absolute", err)

    def test_sandbox_confines_writes(self):
        src = self.local("w.bin", b"payload")
        devfs.put_file(self.x, src, "/confined.bin")
        self.assertTrue(os.path.isfile(os.path.join(self.board.root, "confined.bin")))
        self.assertEqual(os.listdir(self.board.cwd), [])


# =============================================================================================
# Snippet audit tests (no board needed)
# =============================================================================================

    def test_mount_probe_sees_another_device_on_the_unix_vm(self):
        # /dev is a different filesystem from the sandbox on macOS and Linux; the probe itself is read-only.
        link = os.path.join(self.board.root, "mnt")
        try:
            os.symlink("/dev", link)
            other = os.stat("/dev").st_dev != os.stat(self.board.root).st_dev
        except (OSError, NotImplementedError):
            other = False
        if not other:
            self.skipTest("cannot create a folder on another device here")
        self.assertEqual(devfs.mount_point_reason(self.x, "/mnt"), "dev")
        self.assertIsNone(devfs.mount_point_reason(self.x, "/lib"))
        self.board.mkdir("/lib")
        self.assertIsNone(devfs.mount_point_reason(self.x, "/lib"))


class SnippetAuditTests(TimedCase):
    def test_every_snippet_passes_the_linter(self):
        result = devfs.lint_all()
        self.assertEqual(sorted(result), sorted(devfs.SNIPPETS))
        for name, problems in result.items():
            self.assertEqual(problems, [], "%s: %s" % (name, problems))

    def test_every_snippet_is_ascii_small_and_has_no_stray_tokens(self):
        for name, template in devfs.SNIPPETS.items():
            self.assertTrue(template.isascii(), name)
            self.assertLessEqual(len(template), 4096, "%s is %d bytes" % (name, len(template)))
            self.assertNotIn("\t", template, name)
            for line in template.splitlines():
                self.assertLessEqual(len(line), 200, "%s: long line %r" % (name, line[:60]))

    def test_every_snippet_compiles_under_old_grammar_and_cpython(self):
        for name, template in devfs.SNIPPETS.items():
            tokens = {m.group(1): "0" for m in devfs._TOKEN.finditer(template)}
            code = devfs._TOKEN.sub(lambda m: tokens[m.group(1)], template)
            compile(code, name, "exec")
            parsed = None
            for fv in ((3, 4), (3, 5), (3, 6), (3, 7)):
                try:
                    parsed = ast.parse(code, feature_version=fv)
                    break
                except ValueError:
                    continue
            self.assertIsNotNone(parsed, name)
            for node in ast.walk(parsed):
                self.assertNotIsInstance(node, ast.JoinedStr, name + ": f-string")
                self.assertNotIsInstance(node, getattr(ast, "NamedExpr", ()), name + ": walrus")

    def test_render_substitutes_and_complains(self):
        code = devfs.render("rm", P="2f78")
        self.assertIn('_uh("2f78")', code)
        self.assertNotIn("<<", code)
        with self.assertRaises(KeyError):
            devfs.render("rm")
        # ints are formatted, not quoted
        self.assertIn("lim = 12", devfs.render("rmtree", P="2f78", LIMIT=12))

    def test_linter_rejects_forbidden_constructs(self):
        bad = {
            "f-string": 'x = 1\nprint(f"@@{x}")',
            "walrus": 'if (n := 1):\n    print("@@x")',
            "os.walk": 'import os\nfor x in os.walk("/"):\n    pass',
            "shield import": "import shield",
            "from shield import": "from shield import Motor",
            "_shield import": "import _shield",
            "machine.reset": "import machine\nmachine.reset()",
            "machine.soft_reset": "import machine\nmachine.soft_reset()",
            "machine.Pin": "import machine\nmachine.Pin(2)",
            "from machine import Pin": "from machine import Pin",
            "from machine import reset": "from machine import reset",
            "machine.bootloader": "import machine\nmachine.bootloader()",
            "deepsleep": "import machine\nmachine.deepsleep()",
            "umount": 'import os\nos.umount("/")',
            "mount": 'import os\nos.mount(None, "/")',
            "mkfs": 'import os\nos.mkfs(None)',
            "sys.exit": "import sys\nsys.exit()",
            "exec": 'exec("1")',
            "eval": 'eval("1")',
            "dynamic import": '__import__("shield")',
            "unsentineled print": 'print("hello")',
            "print of variable": "x = '@@'\nprint(x)",
            "recursion": "def f(n):\n    return f(n - 1)\n",
            "big buffer": "b = bytearray(4096)",
            "big read": "f.read(1024)",
            "non-ascii": 'print("@@é")',
            "async": "async def f():\n    pass",
            "annotation": "x: int = 1",
            "relative import": "from . import x",
            "chdir": 'import os\nos.chdir("/")',
            "kbd_intr": "import micropython\nmicropython.kbd_intr(3)",
            "network": "import socket",
            "json": "import json",
            "stdout write": "import sys\nsys.stdout.write('@@')",
        }
        for label, code in bad.items():
            self.assertTrue(devfs.check_snippet(code), "linter missed: " + label)

    def test_linter_accepts_allowed_constructs(self):
        ok = 'import os\nimport errno\nprint("@@{}")\nprint(\'@@{"k":"x"}\' % 1)\nprint("@@{" + ",".join([]) + "}")\n'
        self.assertEqual(devfs.check_snippet(ok), [])
        self.assertEqual(devfs.check_snippet('import machine\nx = machine.unique_id()', allow=("machine_unique_id",)), [])
        self.assertTrue(devfs.check_snippet("import machine\nx = machine.unique_id()"))
        self.assertEqual(devfs.check_snippet('__import__("os")', allow=("dynamic_import",)), [])
        self.assertTrue(devfs.check_snippet("x = bytearray(512)\n") == [])

    def test_only_the_identity_snippet_touches_machine_and_only_introspect_imports_dynamically(self):
        """Only `identity` (unique_id) and the two clock snippets (D-22: machine.RTC and nothing else) touch machine."""
        for name, template in devfs.SNIPPETS.items():
            self.assertEqual("machine" in template, name in ("identity", "clock_read", "clock_set"), name)
            if name.startswith("clock_"):
                uses = set(re.findall(r"machine\.([A-Za-z_]+)", template))
                self.assertLessEqual(uses, {"RTC"}, "%s may only use machine.RTC, uses %s" % (name, sorted(uses)))
            self.assertEqual("__import__" in template, name == "introspect", name)
            self.assertNotIn("walk", template.replace("walks", ""), name)
            self.assertNotIn("shield", template.lower(), name)
            for word in ("reset", "bootloader", "deepsleep", "umount", "mkfs", "Pin("):
                self.assertNotIn(word, template, "%s mentions %s" % (name, word))

    def test_every_output_line_is_sentinel_prefixed(self):
        """Static check is the linter's print() rule; here: run each op and look at the raw stdout."""
        board = FakeBoard()
        board.put("/a/b.py", b"1")
        src = os.path.join(tempfile.mkdtemp(), "s.py")
        self.addCleanup(shutil.rmtree, os.path.dirname(src), True)
        with open(src, "wb") as f:
            f.write(b"x")
        outputs = []

        def spy(code, timeout=10.0):
            out, err = board.exec_fn(code, timeout)
            outputs.append((out, err))
            return out, err

        devfs.manifest(spy, "/")
        devfs.list_dir(spy, "/a")
        devfs.stat(spy, "/a")
        devfs.file_hash(spy, "/a/b.py")
        devfs.identity(spy)
        devfs.put_file(spy, src, "/n/s.py")
        devfs.put_file(spy, src, "/n/s2.py", chunk=16)
        devfs.get_file(spy, "/a/b.py", src + ".out")
        devfs.mkdir_p(spy, "/q/r")
        devfs.mv(spy, "/q/r", "/q/s")
        devfs.rmtree(spy, "/q")
        devfs.introspect_modules(spy, ["os"])
        self.assertGreaterEqual(len(outputs), 12)
        for out, err in outputs:
            self.assertEqual(err, b"")
            inside_help = False
            for line in out.decode().splitlines():
                if line.startswith("@@"):
                    inside_help = line.startswith('@@{"k":"hm"}')
                    continue
                self.assertTrue(inside_help, "unprefixed output line: %r" % line)

    def test_default_hex_paths_cannot_inject_code(self):
        evil = '/a"); import shield #\'\n\\'
        board = FakeBoard()
        board.put(evil, b"1")
        self.assertEqual(devfs.stat(board.exec_fn, evil)["size"], 1)
        self.assertEqual(devfs.list_dir(board.exec_fn, "/")["entries"][0]["name"], evil[1:])
        for code in board.calls:
            self.assertNotIn("import shield", code)


class LocalWriteTests(TimedCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="devfs local (replace) ")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_replace_retries_transient_errors_then_succeeds(self):
        from unittest import mock

        src = os.path.join(self.tmp, "a.mpytmp")
        dst = os.path.join(self.tmp, "a")
        with open(src, "wb") as f:
            f.write(b"new")
        real = os.replace
        calls = []

        def flaky(a, b):
            calls.append(1)
            if len(calls) < 3:
                raise PermissionError(errno.EACCES, "locked by a cloud client")
            return real(a, b)

        with mock.patch.object(devfs.os, "replace", flaky), mock.patch.object(devfs.time, "sleep") as sleep:
            devfs._replace_retry(src, dst)
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleep.call_count, 2)
        with open(dst, "rb") as f:
            self.assertEqual(f.read(), b"new")

    def test_replace_gives_up_with_e_local_io(self):
        from unittest import mock

        def always(a, b):
            raise PermissionError(errno.EPERM, "denied")

        with mock.patch.object(devfs.os, "replace", always), mock.patch.object(devfs.time, "sleep"):
            with self.assertRaises(BridgeError) as cm:
                devfs._replace_retry("a", "b", attempts=3)
        self.assertEqual((cm.exception.code, cm.exception.detail), ("E_LOCAL_IO", "EPERM"))

    def test_non_transient_replace_error_is_not_retried(self):
        from unittest import mock

        calls = []

        def missing(a, b):
            calls.append(1)
            raise FileNotFoundError(errno.ENOENT, "gone")

        with mock.patch.object(devfs.os, "replace", missing), mock.patch.object(devfs.time, "sleep") as sleep:
            with self.assertRaises(BridgeError):
                devfs._replace_retry("a", "b")
        self.assertEqual((len(calls), sleep.call_count), (1, 0))


class HostTempNameTests(TimedCase):
    """fs.get writes ``local + '.mpytmp'`` next to the target; names too long for that (finding 19) use a short hidden
    ``~<sha16>.mpytmp`` in the same folder.  put_file only reads the local file, so it has no host temp name."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="devfs host tmp ")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.board = FakeBoard()
        self.addCleanup(self.board.close)
        self.x = self.board.exec_fn
        self.dest_dir = os.path.join(self.tmp, "down (1)")

    @contextlib.contextmanager
    def opened_for_write(self):
        """Patch devfs's open(); yields the list of paths it opened for writing."""
        opened = []
        real = builtins.open

        def spy(path, mode="r", *a, **kw):
            if "w" in mode:
                opened.append(os.fspath(path))
            return real(path, mode, *a, **kw)

        with mock.patch.object(devfs, "open", spy, create=True):
            yield opened

    def assertOnly(self, folder, names):
        self.assertEqual(sorted(os.listdir(folder)), sorted(names), "temp or stray files left in %s" % folder)

    def require_name(self, folder, name):
        """Skip when this machine's filesystem cannot hold ``name`` at all (the final name must be legal)."""
        os.makedirs(folder, exist_ok=True)
        probe = os.path.join(folder, name)
        try:
            with open(probe, "wb"):
                pass
        except OSError as exc:
            self.skipTest("this filesystem cannot hold a %d byte name: %s" % (len(name.encode("utf-8")), exc))
        os.remove(probe)

    def test_long_ascii_basenames_download_and_leave_no_temp(self):
        for n in (200, 243, 244, 248, 249, 250, 255):
            name = ("n%d_" % n).ljust(n, "x")
            self.assertEqual(len(name), n)
            self.require_name(self.dest_dir, name)
            data = pseudo_random(2500, n)
            self.board.put("/long.bin", data)
            dest = os.path.join(self.dest_dir, name)
            with self.opened_for_write() as opened:
                r = devfs.get_file(self.x, "/long.bin", dest, chunk=1000)
            self.assertEqual(r["bytes"], 2500, n)
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), data, n)
            self.assertOnly(self.dest_dir, [name])
            self.assertEqual(len(opened), 1, opened)
            tmp = opened[0]
            self.assertEqual(os.path.dirname(tmp), self.dest_dir)
            if n <= 243:  # name + 7 stays within the 250 byte budget: the documented form
                self.assertEqual(tmp, dest + devfs.TMP_SUFFIX, n)
            else:
                base = os.path.basename(tmp)
                self.assertRegex(base, r"^~[0-9a-f]{16}\.mpytmp$", n)
                self.assertLessEqual(len(base), 255)
            os.remove(dest)

    def test_non_ascii_names_are_measured_in_bytes_not_characters(self):
        # 80 chars but 200 bytes (240 decomposed): the plain temp name still fits the 250 byte budget
        # 125 x e-acute = 125 chars, 250 bytes: a legal final name whose plain temp name (257 bytes) is not
        # 84 x CJK = 84 chars, 252 bytes: the same for three-byte characters
        cases = [("\u00e9" * 40 + "\u65e5" * 40, True), ("\u00e9" * 125, False), ("\u65e5" * 84, False), ("\u00fc" * 122 + ".py", False)]
        for i, (name, plain_ok) in enumerate(cases):
            folder = os.path.join(self.dest_dir, "\u00fcn\u00efc\u00f6d\u00e9 (%d)" % i)
            self.require_name(folder, name)
            data = pseudo_random(1500, len(name))
            self.board.put("/u.bin", data)
            dest = os.path.join(folder, name)
            with self.opened_for_write() as opened:
                devfs.get_file(self.x, "/u.bin", dest)
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), data, name)
            self.assertOnly(folder, [name])
            self.assertEqual(opened[0] == dest + devfs.TMP_SUFFIX, plain_ok, (len(name), len(name.encode("utf-8")), opened))

    def test_decomposed_form_counts_too(self):
        # HFS+ stores names decomposed: 100 x e-acute is 200 bytes composed but 300 decomposed
        local = os.path.join(self.tmp, "\u00e9" * 100)
        self.assertEqual(len(devfs._host_tmp_candidates(local)), 1)
        self.assertEqual(devfs._host_tmp_candidates(local)[0], devfs._short_host_tmp(local))
        plain_ok = os.path.join(self.tmp, "e" * 100)
        self.assertEqual(devfs._host_tmp_candidates(plain_ok), [plain_ok + devfs.TMP_SUFFIX, devfs._short_host_tmp(plain_ok)])

    def test_short_name_is_deterministic_hidden_and_windows_safe(self):
        a = os.path.join(self.tmp, "a" * 250)
        b = os.path.join(self.tmp, "a" * 251)
        sa, sb = devfs._short_host_tmp(a), devfs._short_host_tmp(b)
        self.assertEqual(sa, devfs._short_host_tmp(a))
        self.assertNotEqual(sa, sb)
        self.assertEqual(os.path.dirname(sa), self.tmp)
        base = os.path.basename(sa)
        self.assertRegex(base, r"^~[0-9a-f]{16}\.mpytmp$")
        self.assertFalse(set('<>:"/\\|?*') & set(base))
        self.assertLessEqual(len(base), 30)
        # a lone surrogate (a POSIX file name with undecodable bytes) must not crash the length check
        weird = os.path.join(self.tmp, "x\udcff" * 3)
        self.assertEqual(devfs._host_tmp_candidates(weird)[0], weird + devfs.TMP_SUFFIX)
        # a relative local with no folder keeps the temp in the same (current) folder
        rel = "r" * 250
        self.assertEqual(os.path.dirname(devfs._host_tmp_candidates(rel)[0]), "")

    def test_windows_path_near_max_path_prefers_the_shorter_name(self):
        # os.name is patched, the path itself is built with the host's separators so dirname() works here too
        folder = os.sep + os.sep.join(["d" * 40] * 6)  # 246 characters
        with mock.patch.object(devfs.os, "name", "nt"), mock.patch.object(devfs.os.path, "abspath", lambda p: p):
            tiny = os.path.join(folder, "lab.py")  # 'lab.py.mpytmp' is 260 characters: over, but the hidden name is longer still
            self.assertEqual(devfs._host_tmp_candidates(tiny), [tiny + devfs.TMP_SUFFIX, devfs._short_host_tmp(tiny)])
            longer = os.path.join(folder, "k" * 30 + ".py")  # the 24 character hidden name saves 9 characters
            self.assertEqual(devfs._host_tmp_candidates(longer), [devfs._short_host_tmp(longer)])
            fine = os.path.join(os.sep + "d" * 40, "lab.py")
            self.assertEqual(devfs._host_tmp_candidates(fine)[0], fine + devfs.TMP_SUFFIX)

    def test_enametoolong_on_the_plain_name_falls_back_to_the_short_name(self):
        data = pseudo_random(3000, 3)
        self.board.put("/s.bin", data)
        dest = os.path.join(self.dest_dir, "\u00fcn\u00efc\u00f6d\u00e9 (1).bin")
        real = builtins.open
        opened = []

        def picky(path, mode="r", *a, **kw):
            if "w" in mode:
                opened.append(os.fspath(path))
                if os.fspath(path).endswith(".bin" + devfs.TMP_SUFFIX):
                    raise OSError(errno.ENAMETOOLONG, os.strerror(errno.ENAMETOOLONG))
            return real(path, mode, *a, **kw)

        with mock.patch.object(devfs, "open", picky, create=True):
            devfs.get_file(self.x, "/s.bin", dest, chunk=1000)
        self.assertEqual(len(opened), 2)
        self.assertEqual(os.path.basename(opened[1]), os.path.basename(devfs._short_host_tmp(dest)))
        with open(dest, "rb") as f:
            self.assertEqual(f.read(), data)
        self.assertOnly(self.dest_dir, [os.path.basename(dest)])

    def test_enametoolong_everywhere_is_e_local_io_naming_the_requested_file(self):
        self.board.put("/s.bin", b"data")
        dest = os.path.join(self.dest_dir, "wanted.bin")

        def refuse(path, mode="r", *a, **kw):
            if "w" in mode:
                raise OSError(errno.ENAMETOOLONG, os.strerror(errno.ENAMETOOLONG))
            return builtins.open(path, mode, *a, **kw)

        with mock.patch.object(devfs, "open", refuse, create=True):
            with self.assertRaises(BridgeError) as cm:
                devfs.get_file(self.x, "/s.bin", dest)
        self.assertEqual((cm.exception.code, cm.exception.detail), ("E_LOCAL_IO", "ENAMETOOLONG"))
        self.assertIn("wanted.bin", cm.exception.message)
        self.assertNotIn("~", cm.exception.message)
        self.assertOnly(self.dest_dir, [])
        self.assertFalse(os.path.exists(dest))

    def test_failures_remove_the_short_temp_and_keep_an_existing_file(self):
        name = "k" * 252
        self.require_name(self.dest_dir, name)
        dest = os.path.join(self.dest_dir, name)
        with open(dest, "wb") as f:
            f.write(b"LOCAL WORK")
        self.board.put("/f.bin", pseudo_random(6000, 12))
        # 1. the link dies after one chunk
        failing_after(self.board, 2, forever=True)
        with self.assertRaises(BridgeError) as cm:
            devfs.get_file(self.x, "/f.bin", dest, chunk=1000)
        self.assertEqual(cm.exception.code, "E_NOT_CONNECTED")
        self.board.hook = None
        self.assertOnly(self.dest_dir, [name])
        # 2. cancelled in the middle
        cancel = threading.Event()
        with self.assertRaises(BridgeError) as cm:
            devfs.get_file(self.x, "/f.bin", dest, chunk=1000,
                           progress=lambda d, t, l: cancel.set() if d >= 2000 else None, cancel=cancel)  # fmt: skip
        self.assertEqual(cm.exception.code, "E_CANCELLED")
        self.assertOnly(self.dest_dir, [name])
        # 3. damaged data
        def tamper(code, timeout=10.0):
            out, err = self.x(code, timeout)
            if b'"k":"d"' in out:
                i = out.index(b'"b":"') + 5
                out = out[:i] + (b"A" if out[i : i + 1] != b"A" else b"B") + out[i + 1 :]
            return out, err

        with self.assertRaises(BridgeError) as cm:
            devfs.get_file(tamper, "/f.bin", dest)
        self.assertEqual((cm.exception.code, cm.exception.detail), ("E_FS_ERRNO", "EIO"))
        self.assertOnly(self.dest_dir, [name])
        # 4. the final replace fails
        with mock.patch.object(devfs.os, "replace", side_effect=FileNotFoundError(errno.ENOENT, "gone")):
            with self.assertRaises(BridgeError) as cm:
                devfs.get_file(self.x, "/f.bin", dest)
        self.assertEqual(cm.exception.code, "E_LOCAL_IO")
        self.assertOnly(self.dest_dir, [name])
        with open(dest, "rb") as f:
            self.assertEqual(f.read(), b"LOCAL WORK")
        # and a later success replaces the file atomically
        devfs.get_file(self.x, "/f.bin", dest)
        self.assertEqual(os.path.getsize(dest), 6000)
        self.assertOnly(self.dest_dir, [name])

    def test_put_of_a_long_local_name_creates_no_host_files(self):
        name = "p" * 255
        self.require_name(self.dest_dir, name)
        src = os.path.join(self.dest_dir, name)
        with open(src, "wb") as f:
            f.write(b"print('long')\n")
        r = devfs.put_file(self.x, src, "/p.py")
        self.assertEqual(r["bytes"], 14)
        self.assertEqual(self.board.read("/p.py"), b"print('long')\n")
        self.assertOnly(self.dest_dir, [name])


class ImportTests(TimedCase):
    def test_uses_the_real_bridge_error_when_errors_py_exists(self):
        if not os.path.isfile(os.path.join(ROOT, "bridge", "errors.py")):
            self.skipTest("bridge/errors.py not written yet; devfs is using its stand-in")
        from bridge import errors

        self.assertIs(devfs.BridgeError, errors.BridgeError)
        e = devfs.fs_error("ENOENT", "/x", "testing")
        self.assertIn("E_FS_ERRNO", errors.CODES)
        self.assertEqual(e.to_dict()["code"], "E_FS_ERRNO")
        self.assertEqual(e.to_dict()["detail"], "ENOENT")


class ErrorMappingTests(TimedCase):
    def test_fs_error_wording(self):
        e = devfs.fs_error("ENOSPC", "/main.py", "uploading")
        self.assertEqual((e.code, e.detail), ("E_FS_ERRNO", "ENOSPC"))
        self.assertIn("/main.py", e.message)
        self.assertTrue(e.hint)
        # an unnamed errno falls back to the numeric table, then to a generic name
        self.assertEqual(devfs.fs_error("", "/x", "x", num=2).detail, "ENOENT")
        self.assertEqual(devfs.fs_error("", "/x", "x", num=66).detail, "ENOTEMPTY")
        self.assertEqual(devfs.fs_error("", "/x", "x", num=9999).detail, "ERRNO_9999")

    def test_cross_device_move_message(self):
        class Fake:
            def __call__(self, code, timeout=10.0):
                return b'@@{"k":"err","n":18,"e":"EXDEV","w":"mv"}\n', b""

        with self.assertRaises(BridgeError) as cm:
            devfs.mv(Fake(), "/flash/a.py", "/sd/a.py")
        self.assertEqual((cm.exception.code, cm.exception.detail), ("E_FS_ERRNO", "EXDEV"))
        self.assertIn("different filesystem", cm.exception.message)
        self.assertIn("/sd/a.py", cm.exception.message)


if __name__ == "__main__":
    unittest.main()
