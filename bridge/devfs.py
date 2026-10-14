"""Device-side filesystem and identity code for the bridge (docs/protocol.md sections 3 and 9).

This module is independent of the serial link.  Every public function takes an
``exec_fn(code: str, timeout: float = 10.0) -> (stdout: bytes, stderr: bytes)`` that runs one
snippet in the board's raw REPL (a non-empty stderr means the snippet raised) and returns plain
dicts shaped like the protocol result tables.

Design rules (protocol section 9):

* Device code runs on any MicroPython 1.20+ port: only ``os``, ``sys``, ``gc``, ``errno``,
  ``binascii``/``ubinascii`` and (optional) ``hashlib``/``uhashlib``; ``machine`` only for
  ``unique_id()``.  No f-strings, no walrus, no ``os.walk``, no recursion, buffers <= 512 bytes.
* Every output line starts with the sentinel ``@@`` followed by one JSON object, so banner and
  ``boot.py`` noise is ignored.  JSON is built by hand with ``%`` formatting (the ``json`` module is
  optional on small ports).
* Strings that came from the board (file names, ``sys.path`` ...) are written as ``"key":"text"``
  when they are printable ASCII without quote/backslash, otherwise as ``"keyx":"<hex of utf-8>"``.
  Paths going *to* the board are always hex (``_uh("...")``), so any name works, even one that
  contains a newline.
* Device filesystem errors are reported as ``{"k":"err","n":<errno>,"e":"<NAME>"}`` records and
  become ``BridgeError("E_FS_ERRNO")`` with the errno NAME in ``detail``; local I/O problems are
  ``BridgeError("E_LOCAL_IO")``.

Provenance: the listing/hash snippets descend from the tested snippets in
docs/analysis/03-fs-sync.md Appendix B (iterative walk, ``readinto`` into a small buffer).
"""
from __future__ import annotations

import ast
import base64
import binascii
import errno as _errno
import hashlib
import json
import os
import re
import time
import unicodedata
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

try:  # package import: bridge.devfs
    from .errors import BridgeError  # type: ignore[import-not-found]
except ImportError:  # flat import (bridge/ on sys.path) or errors.py not written yet
    try:
        from errors import BridgeError  # type: ignore[import-not-found,no-redef]
    except ImportError:

        class BridgeError(Exception):  # type: ignore[no-redef]
            """Minimal stand-in used only until bridge/errors.py exists."""

            def __init__(self, code, message="", detail=None, hint=None):
                Exception.__init__(self, "%s: %s" % (code, message))
                self.code = code
                self.message = message
                self.detail = detail
                self.hint = hint

            def to_error(self):
                return {"code": self.code, "message": self.message, "detail": self.detail, "hint": self.hint}


ExecFn = Callable[..., Tuple[bytes, bytes]]
ProgressFn = Callable[[int, int, str], None]

TMP_SUFFIX = ".mpytmp"
SENTINEL = "@@"
_EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def _berr(code: str, message: str, detail: Optional[str] = None, hint: Optional[str] = None) -> Exception:
    try:
        return BridgeError(code, message, detail=detail, hint=hint)
    except TypeError:  # a BridgeError with a different signature; keep at least code+message
        return BridgeError(code, message)  # type: ignore[call-arg]


# ---------------------------------------------------------------------------------------------
# Device-side code.  Templates use <<TOKEN>> placeholders (see render()).  Nothing in here may
# reference an application package or hardware; check_snippet() enforces that in the tests.
# ---------------------------------------------------------------------------------------------

# Smallest prelude: imports, hex decode, error report.  Used by the hot per-chunk snippet.
_PRE_MIN = r"""
import os
try:
    import binascii as _b
except ImportError:
    import ubinascii as _b
def _uh(h):
    return _b.unhexlify(h).decode()
def _en(n):
    try:
        import errno
        return errno.errorcode[n]
    except Exception:
        return ""
def _er(e, w):
    n = 0
    if e.args and isinstance(e.args[0], int):
        n = e.args[0]
    print('@@{"k":"err","n":%d,"e":"%s","w":"%s"}' % (n, _en(n), w))
"""

# Adds the string helpers for output: hex encoder and "plain or hex" JSON member builder.
_PRE = (
    _PRE_MIN
    + r"""
def _hx(s):
    return _b.hexlify(s.encode()).decode()
def _kv(k, s):
    for c in s:
        if c < " " or c > "~" or c == '"' or c == "\\":
            return '"%sx":"%s"' % (k, _hx(s))
    return '"%s":"%s"' % (k, s)
"""
)

# sha256 helpers.  _hf() returns the sha256 constructor or None (no hashlib, no sha256, or a
# broken one: it is self-tested against the empty-string digest).  _hd() hashes a file with a
# 512-byte buffer, so RAM use is constant.
_HF = r"""
def _hf():
    try:
        try:
            import hashlib as h
        except ImportError:
            import uhashlib as h
        s = h.sha256
        if _b.hexlify(s(b"").digest()) == b"%s":
            return s
    except Exception:
        pass
    return None
def _hd(s, p):
    b = bytearray(512)
    m = memoryview(b)
    h = s()
    f = open(p, "rb")
    try:
        while True:
            n = f.readinto(b)
            if not n:
                break
            h.update(m[:n])
    finally:
        f.close()
    return _b.hexlify(h.digest()).decode()
""" % _EMPTY_SHA256

# mkdir -p: stat first, create the missing levels one at a time, refuse a file in the way.
_MKP = r"""
def _mp(path):
    c = 0
    cur = ""
    for seg in path.split("/"):
        if seg:
            cur += "/" + seg
            try:
                st = os.stat(cur)
            except OSError:
                st = None
            if st is None:
                os.mkdir(cur)
                c += 1
            elif st[0] & 0xF000 != 0x4000:
                raise OSError(20, "")
    return c
"""

# Atomic replace.  os.rename() replaces an existing file on littlefs and POSIX; FAT refuses
# (EEXIST).  Only when rename failed AND the target is an existing file do we remove it and retry;
# a "keep" record tells the host not to delete the temp file if the second rename also fails (it
# then holds the only copy of the new content).
_RN = r"""
def _rn(a, b):
    try:
        os.rename(a, b)
    except OSError as e:
        try:
            st = os.stat(b)
        except OSError:
            st = None
        if st is None or st[0] & 0xF000 == 0x4000:
            raise e
        os.remove(b)
        try:
            os.rename(a, b)
        except OSError as e2:
            print('@@{"k":"keep"}')
            raise e2
"""

_LIST = (
    _PRE
    + r"""
d = _uh("<<P>>")
pre = d if d == "/" else d + "/"
try:
    for e in os.ilistdir(d):
        nm = e[0]
        t = e[1]
        sz = 0
        if t != 0x4000:
            try:
                st = os.stat(pre + nm)
                t = st[0] & 0xF000
                sz = st[6]
            except OSError:
                sz = -1
        if t == 0x4000:
            print('@@{"k":"d",%s}' % _kv("n", nm))
        else:
            print('@@{"k":"f",%s,"s":%d}' % (_kv("n", nm), sz))
    print('@@{"k":"end"}')
except OSError as e:
    _er(e, "ls")
"""
)

# Iterative depth-first walk.  Extra RAM = the stack of pending directory paths plus one 512-byte
# buffer, independent of the number of files.  Hashing is per file and streamed.
_MANIFEST = (
    _PRE
    + _HF
    + r"""
import gc
gc.collect()
root = _uh("<<P>>")
ex = [_uh(h) for h in "<<X>>".split(",") if h]
sha = None
if <<HASH>>:
    sha = _hf()
print('@@{"k":"h","h":"%s"}' % ("sha256" if sha else "none"))
stack = [root]
bad = 0
n = 0
while stack:
    d = stack.pop()
    pre = d if d == "/" else d + "/"
    if d.count("/") > 40:
        print('@@{"k":"w","n":0,"e":"DEPTH",%s}' % _kv("p", d))
        continue
    try:
        for e in os.ilistdir(d):
            full = pre + e[0]
            if full in ex:
                continue
            t = e[1]
            if t != 0x4000 and t != 0x8000:
                try:
                    t = os.stat(full)[0] & 0xF000
                except OSError:
                    t = 0x8000
            n += 1
            if t == 0x4000:
                stack.append(full)
                print('@@{"k":"d",%s}' % _kv("p", full))
            else:
                try:
                    sz = os.stat(full)[6]
                except OSError:
                    sz = -1
                hh = ""
                if sha and sz >= 0:
                    try:
                        hh = ',"h":"%s"' % _hd(sha, full)
                    except OSError:
                        hh = ""
                print('@@{"k":"f",%s,"s":%d%s}' % (_kv("p", full), sz, hh))
    except OSError as e:
        if d == root:
            _er(e, "manifest")
            bad = 1
            stack = []
        else:
            nn = 0
            if e.args and isinstance(e.args[0], int):
                nn = e.args[0]
            print('@@{"k":"w","n":%d,"e":"%s",%s}' % (nn, _en(nn), _kv("p", d)))
if not bad:
    print('@@{"k":"end","n":%d}' % n)
"""
)

_STAT = (
    _PRE_MIN
    + r"""
p = _uh("<<P>>")
try:
    st = os.stat(p)
except OSError as e:
    if e.args and e.args[0] in (2, 20):
        print('@@{"k":"s","x":0}')
    else:
        _er(e, "stat")
else:
    print('@@{"k":"s","x":1,"d":%d,"s":%d,"m":%d}' % (1 if st[0] & 0xF000 == 0x4000 else 0, st[6], st[8]))
"""
)

_FILEHASH = (
    _PRE_MIN
    + _HF
    + r"""
p = _uh("<<P>>")
try:
    try:
        st = os.stat(p)
    except OSError as e:
        if e.args and e.args[0] in (2, 20):
            st = None
        else:
            raise e
    if st is None:
        print('@@{"k":"fh","x":0}')
    elif st[0] & 0xF000 == 0x4000:
        print('@@{"k":"fh","x":1,"d":1,"s":0}')
    else:
        hh = ""
        s = _hf() if <<WANT>> else None
        if s:
            try:
                hh = ',"h":"%s"' % _hd(s, p)
            except OSError:
                hh = ""
        print('@@{"k":"fh","x":1,"d":0,"s":%d%s}' % (st[6], hh))
except OSError as e:
    _er(e, "hash")
"""
)

# Upload, step 1: mkdir -p the parent, check free space, (re)create the temp file with chunk 1.
_PUT_HEAD = _PRE_MIN + _HF + _MKP + _RN
_PUT_FIRST_BODY = r"""
tmp = _uh("<<T>>")
par = _uh("<<D>>")
ok = 1
c = 0
try:
    if par:
        c = _mp(par)
    dd = tmp[:tmp.rfind("/")] or "/"
    fr = -1
    try:
        sv = os.statvfs(dd)
        if sv[1] and sv[2]:
            fr = sv[1] * sv[3]
    except Exception:
        pass
    if fr >= 0 and fr < <<SIZE>>:
        raise OSError(28, "")
    f = open(tmp, "wb")
    try:
        f.write(_b.a2b_base64("<<B>>"))
    finally:
        f.close()
except OSError as e:
    _er(e, "put")
    ok = 0
"""

# Upload, last step: verify size (and sha256 when the board can hash), then atomic rename.
_PUT_FINISH_BODY = r"""
if ok:
    dst = _uh("<<R>>")
    sz = <<SIZE>>
    ex = "<<SHA>>"
    vh = ""
    got = -1
    try:
        got = os.stat(tmp)[6]
        if got != sz:
            print('@@{"k":"bad","w":"size","g":"%d"}' % got)
            ok = 0
        elif ex:
            s = _hf()
            if s:
                vh = _hd(s, tmp)
                if vh != ex:
                    print('@@{"k":"bad","w":"sha","g":"%s"}' % vh)
                    ok = 0
        if ok:
            _rn(tmp, dst)
            print('@@{"k":"ok","s":%d,"v":"%s"}' % (got, "sha256" if vh else "size"))
        else:
            os.remove(tmp)
    except OSError as e:
        _er(e, "put")
"""

_PUT_FIRST = _PUT_HEAD + _PUT_FIRST_BODY + r"""
if ok:
    print('@@{"k":"ok","c":%d}' % c)
"""
_PUT_ONE = _PUT_HEAD + _PUT_FIRST_BODY + _PUT_FINISH_BODY

# Hot path: one call per chunk, so keep it tiny.
_PUT_APPEND = (
    _PRE_MIN
    + r"""
tmp = _uh("<<T>>")
try:
    f = open(tmp, "ab")
    try:
        f.write(_b.a2b_base64("<<B>>"))
    finally:
        f.close()
    print('@@{"k":"ok"}')
except OSError as e:
    _er(e, "put")
"""
)

_PUT_FINISH = _PUT_HEAD + r"""
tmp = _uh("<<T>>")
ok = 1
""" + _PUT_FINISH_BODY

# Remove the temp file.  If remove() fails but the file is not there (it was never created; a
# read-only FAT reports EROFS before looking) that is success; a file that is still there after a
# failed remove (EROFS, EBUSY, ...) is reported so the host can retry and, failing that, leave it
# for clean_orphans().
_PUT_ABORT = (
    _PRE_MIN
    + r"""
t = _uh("<<T>>")
try:
    os.remove(t)
except OSError as e:
    try:
        os.stat(t)
        _er(e, "abort")
    except OSError:
        pass
print('@@{"k":"ok"}')
"""
)

_GET_CHUNK = (
    _PRE_MIN
    + r"""
p = _uh("<<P>>")
try:
    f = open(p, "rb")
    try:
        if <<OFF>>:
            f.seek(<<OFF>>)
        n = 0
        while n < <<LEN>>:
            b = f.read(min(510, <<LEN>> - n))
            if not b:
                break
            n += len(b)
            print('@@{"k":"d","b":"%s"}' % _b.b2a_base64(b).decode().strip())
    finally:
        f.close()
    print('@@{"k":"end","n":%d}' % n)
except OSError as e:
    _er(e, "get")
"""
)

_RM = (
    _PRE_MIN
    + r"""
p = _uh("<<P>>")
try:
    if os.stat(p)[0] & 0xF000 == 0x4000:
        raise OSError(21, "")
    os.remove(p)
    print('@@{"k":"ok"}')
except OSError as e:
    _er(e, "rm")
"""
)

# Remove up to <<LIMIT>> entries per call, deepest first, with constant RAM: scan one directory
# (never delete while its iterator is open), collect at most 16 file names and the first
# sub-directory, delete the files, descend into the sub-directory or rmdir the now-empty one.
_RMTREE = (
    _PRE_MIN
    + r"""
root = _uh("<<P>>")
lim = <<LIMIT>>
cnt = 0
more = 0
if root == "/" or root == "":
    print('@@{"k":"err","n":1,"e":"EPERM","w":"refuse"}')
else:
    d = root
    try:
        while True:
            files = []
            sub = None
            for e in os.ilistdir(d):
                if e[1] == 0x4000:
                    if sub is None:
                        sub = e[0]
                elif len(files) < 16:
                    files.append(e[0])
            pre = d + "/"
            for nm in files:
                try:
                    os.remove(pre + nm)
                    cnt += 1
                except OSError:
                    if os.stat(pre + nm)[0] & 0xF000 == 0x4000:
                        sub = nm
                    else:
                        raise
            if cnt >= lim:
                more = 1
                break
            if sub is not None:
                d = pre + sub
            elif not files:
                os.rmdir(d)
                cnt += 1
                if d == root:
                    break
                d = d[:d.rfind("/")]
        print('@@{"k":"rm","n":%d,"more":%d}' % (cnt, more))
    except OSError as e:
        print('@@{"k":"rm","n":%d,"more":0}' % cnt)
        _er(e, "rmtree")
"""
)

# Read-only: is the top-level folder <<P>> a mount point (or the board's working folder)?  Signals,
# in order: st_dev differs from '/' (unix port, hosts), '/' is a virtual root with no filesystem of
# its own while <<P>> has one (pyboard /flash, /sd), statvfs() of <<P>> differs from that of '/'
# (ESP32 + SD card at /sd), <<P>> is os.getcwd().  Answer: {"k":"mnt","w":"<why>"}, "" = none.
_MOUNT = (
    _PRE_MIN
    + r"""
def _sv(q):
    try:
        return tuple(os.statvfs(q))
    except Exception:
        return None
p = _uh("<<P>>")
w = ""
try:
    sp = os.stat(p)
    if sp[0] & 0xF000 == 0x4000:
        dr = os.stat("/")[2]
        if sp[2] != dr:
            w = "dev"
        elif dr == 0:
            a = _sv("/")
            b = _sv(p)
            if a is None or a[2] == 0:
                if b is not None and b[2] != 0:
                    w = "root"
            elif b is not None and a != b:
                w = "vfs"
        if not w:
            try:
                if os.getcwd() == p:
                    w = "cwd"
            except Exception:
                pass
    print('@@{"k":"mnt","w":"%s"}' % w)
except OSError as e:
    _er(e, "mount")
"""
)

_MKDIR_P = _PRE_MIN + _MKP + r"""
try:
    print('@@{"k":"ok","c":%d}' % _mp(_uh("<<P>>")))
except OSError as e:
    _er(e, "mkdir")
"""

_MKDIR_1 = (
    _PRE_MIN
    + r"""
try:
    os.mkdir(_uh("<<P>>"))
    print('@@{"k":"ok","c":1}')
except OSError as e:
    _er(e, "mkdir")
"""
)

# mv never overwrites (FAT and littlefs disagree about rename-over; students should not lose a
# file silently).  A case-only rename of the same file is allowed (case-insensitive FAT).
_MV = (
    _PRE_MIN
    + r"""
a = _uh("<<A>>")
b = _uh("<<B>>")
w = "src"
try:
    sa = os.stat(a)
    w = "dst"
    if a != b:
        try:
            sb = os.stat(b)
        except OSError:
            sb = None
        if sb is not None:
            if not (a.lower() == b.lower() and sa[6] == sb[6] and sa[8] == sb[8]):
                raise OSError(17, "")
        os.rename(a, b)
    print('@@{"k":"ok"}')
except OSError as e:
    _er(e, w)
"""
)

_IDENTITY = (
    _PRE
    + _HF
    + r"""
import sys
import gc
def _g(o, n, d):
    try:
        return getattr(o, n)
    except Exception:
        return d
def _ja(l):
    return "[" + ",".join(["{" + _kv("p", str(x)) + "}" for x in l]) + "]"
print('@@{"k":"hm"}')
try:
    help("modules")
except Exception:
    pass
print('@@{"k":"hme"}')
im = sys.implementation
v = _g(im, "version", (0, 0, 0))
try:
    vs = "%d,%d,%d" % (v[0], v[1], v[2])
except Exception:
    vs = "0,0,0"
mpy = _g(im, "_mpy", None)
un = ["", "", "", "", ""]
try:
    u = os.uname()
    un = [str(u[0]), str(u[1]), str(u[2]), str(u[3]), str(u[4])]
except Exception:
    pass
uid = ""
try:
    import machine
    uid = _b.hexlify(machine.unique_id()).decode()
except Exception:
    pass
sp = []
try:
    sp = [str(x) for x in sys.path]
except Exception:
    pass
rt = []
try:
    rt = [str(x) for x in os.listdir("/")]
except Exception:
    pass
cc = False
try:
    compile("0", "", "eval")
    cc = True
except Exception:
    pass
gc.collect()
try:
    mem = gc.mem_free()
except Exception:
    mem = 0
ft = 0
ff = 0
try:
    sv = os.statvfs("/")
    ft = sv[1] * sv[2]
    ff = sv[1] * sv[3]
except Exception:
    pass
o = ['"k":"id"']
o.append(_kv("impl", str(_g(im, "name", ""))))
o.append('"version":[%s]' % vs)
o.append(_kv("machine", str(_g(im, "_machine", ""))))
o.append(_kv("build", str(_g(im, "_build", ""))))
o.append('"mpy":%s' % (mpy if isinstance(mpy, int) else "null"))
o.append(_kv("platform", str(_g(sys, "platform", ""))))
o.append('"uname":{%s,%s,%s,%s,%s}' % (_kv("sysname", un[0]), _kv("nodename", un[1]), _kv("release", un[2]), _kv("version", un[3]), _kv("machine", un[4])))
o.append(_kv("uid", uid))
o.append('"syspath":%s' % _ja(sp))
o.append('"root":%s' % _ja(rt))
o.append('"caps":{"hash":"%s","compile":%s,"mem":%d}' % ("sha256" if _hf() else "none", "true" if cc else "false", mem))
o.append('"hints":{"frozen":%s,"fsTotal":%d,"fsFree":%d}' % ("true" if ".frozen" in sp else "false", ft, ff))
print("@@{" + ",".join(o) + "}")
"""
)

# Imports ONLY the module names the caller lists (built-in modules are not in sys.modules on
# every port, so the leaf module is taken from the __import__ result) (R5 inventory of a custom firmware).  Reads
# module.__dict__ without calling getattr(), so lazy module __getattr__ hooks cannot create
# hardware objects.
_INTROSPECT = (
    _PRE
    + r"""
import sys
def _kd(v):
    n = type(v).__name__
    if n in ("function", "closure", "bound_method", "builtin_function_or_method", "generator"):
        return "f"
    if n == "type":
        return "c"
    if n == "module":
        return "m"
    if n == "property":
        return "p"
    if n in ("staticmethod", "classmethod"):
        return "f"
    if n == "int":
        return "i"
    if n == "float":
        return "n"
    if n == "str":
        return "s"
    if n == "bool":
        return "b"
    if n == "bytes":
        return "y"
    if n == "NoneType":
        return "z"
    return "o"
print('@@{"k":"hm"}')
try:
    help("modules")
except Exception:
    pass
print('@@{"k":"hme"}')
for nm in [_uh(h) for h in "<<N>>".split(",") if h]:
    try:
        m = __import__(nm, None, None, ("*",))
    except Exception as e:
        print('@@{"k":"m",%s,"t":"","a":"",%s}' % (_kv("n", nm), _kv("err", type(e).__name__ + ": " + str(e))))
        continue
    try:
        dd = m.__dict__
        ks = list(dd)
    except Exception:
        dd = None
        ks = dir(m)
    ks.sort()
    at = []
    kk = ""
    cs = []
    cl = []
    fl = ""
    for k in ks:
        if k == "__file__" and dd is not None:
            fl = str(dd[k])
        if k.startswith("__") and k.endswith("__"):
            continue
        at.append(k)
        c = "o"
        if dd is not None:
            c = _kd(dd[k])
            if c in "inbsy":
                r = repr(dd[k])
                if len(r) <= 80:
                    cs.append(k + "=" + _hx(r))
            if c == "c" and len(cl) < 64:
                mns = []
                mkk = ""
                for mn in sorted(dir(dd[k])):
                    if mn.startswith("__") and mn.endswith("__") and mn != "__init__":
                        continue
                    if len(mns) >= 200:
                        break
                    try:
                        mv = getattr(dd[k], mn)
                    except Exception:
                        mv = None
                    mns.append(mn)
                    mkk += _kd(mv)
                cl.append(k + ":" + ",".join(mns) + ":" + mkk)
        kk += c
    print('@@{"k":"m",%s,%s,%s,%s,%s,%s}' % (_kv("n", nm), _kv("a", ",".join(at)), _kv("t", kk), _kv("c", ",".join(cs)), _kv("f", fl), _kv("cl", ";".join(cl))))
print('@@{"k":"end"}')
"""
)

# Clock (decision D-22). time.localtime() gives the calendar fields whatever the port's epoch (1970 or 2000).
_CLOCK_REPORT = r"""
t = time.localtime()
print('@@{"k":"clk","r":%d,"t":[%d,%d,%d,%d,%d,%d,%d]}' % (r, t[0], t[1], t[2], t[3], t[4], t[5], t[6]))
"""

_CLOCK_READ = (
    _PRE
    + r"""
import time
r = 0
try:
    import machine
    if hasattr(machine, "RTC"):
        r = 1
except Exception:
    pass
"""
    + _CLOCK_REPORT
)

# RTC.datetime takes (year, month, day, weekday, hours, minutes, seconds, subseconds) on esp32, esp8266, rp2, stm32,
# samd, mimxrt and nrf; weekday 0 = Monday (the board recomputes or ignores it on most ports).
_CLOCK_SET = (
    _PRE
    + r"""
import time
import machine
machine.RTC().datetime((<<Y>>, <<MO>>, <<D>>, <<WD>>, <<H>>, <<MI>>, <<S>>, 0))
r = 1
"""
    + _CLOCK_REPORT
)

SNIPPETS: Dict[str, str] = {
    "list": _LIST,
    "manifest": _MANIFEST,
    "stat": _STAT,
    "file_hash": _FILEHASH,
    "put_first": _PUT_FIRST,
    "put_append": _PUT_APPEND,
    "put_finish": _PUT_FINISH,
    "put_one": _PUT_ONE,
    "put_abort": _PUT_ABORT,
    "get_chunk": _GET_CHUNK,
    "rm": _RM,
    "rmtree": _RMTREE,
    "mount_probe": _MOUNT,
    "mkdir_p": _MKDIR_P,
    "mkdir_1": _MKDIR_1,
    "mv": _MV,
    "identity": _IDENTITY,
    "introspect": _INTROSPECT,
    "clock_read": _CLOCK_READ,
    "clock_set": _CLOCK_SET,
}

# Snippets that are allowed a construct the linter normally forbids.
SNIPPET_ALLOW: Dict[str, Tuple[str, ...]] = {
    "identity": ("machine_unique_id",),
    "introspect": ("dynamic_import",),
    "clock_read": ("rtc",),
    "clock_set": ("rtc",),
}

_TOKEN = re.compile(r"<<([A-Z0-9_]+)>>")


def render(name: str, **values: Any) -> str:
    """Fill a snippet template.  String values must already be hex/base64; ints are formatted."""
    template = SNIPPETS[name]

    def sub(m: "re.Match[str]") -> str:
        key = m.group(1)
        if key not in values:
            raise KeyError("snippet %r needs value %r" % (name, key))
        return str(values[key])

    return _TOKEN.sub(sub, template)


def _hexs(s: str) -> str:
    return binascii.hexlify(s.encode("utf-8")).decode("ascii")


# ---------------------------------------------------------------------------------------------
# Snippet linter (used by the tests; also callable from tooling)
# ---------------------------------------------------------------------------------------------

_ALLOWED_IMPORTS = frozenset(
    ["os", "uos", "sys", "usys", "gc", "time", "utime", "errno", "binascii", "ubinascii", "hashlib", "uhashlib"]
)
_FORBIDDEN_NAMES = frozenset(
    [
        "walk",
        "system",
        "popen",
        "exit",
        "reset",
        "soft_reset",
        "hard_reset",
        "bootloader",
        "deepsleep",
        "lightsleep",
        "umount",
        "mount",
        "mkfs",
        "VfsFat",
        "VfsLfs1",
        "VfsLfs2",
        "dupterm",
        "kbd_intr",
        "chdir",
        "exec",
        "eval",
        "input",
        "Pin",
        "ADC",
        "DAC",
        "PWM",
        "I2C",
        "SPI",
        "UART",
        "Timer",
        "WDT",
        "RTC",
        "freq",
        "idle",
        "disable_irq",
    ]
)
_MACHINE_OK = frozenset(["unique_id"])


def _feature_versions() -> List[Tuple[int, int]]:
    return [(3, 4), (3, 5), (3, 6), (3, 7)]


def check_snippet(code: str, allow: Iterable[str] = ()) -> List[str]:
    """Return a list of rule violations (empty = clean) for device-side ``code``.

    Rules: ASCII only; parses with the oldest grammar CPython supports; no f-strings, walrus,
    ``match``, async, annotations, relative imports; imports limited to os/sys/gc/time/errno/
    binascii/hashlib (+u-variants); ``machine`` only as ``machine.unique_id`` (allow
    ``machine_unique_id``); no ``os.walk``, ``exec``/``eval``/``__import__`` (allow
    ``dynamic_import`` for ``__import__``), mount/umount/mkfs, reset/deepsleep/bootloader,
    GPIO/peripheral classes, ``chdir``; no recursion; every ``print`` starts with the ``@@`` sentinel;
    no literal buffer over 512 bytes.
    """
    allow_set = set(allow)
    problems: List[str] = []

    def bad(node: Any, msg: str) -> None:
        problems.append("line %s: %s" % (getattr(node, "lineno", "?"), msg))

    if not code.isascii():
        problems.append("snippet contains non-ASCII characters")
    tree = None
    for fv in _feature_versions():
        try:
            tree = ast.parse(code, feature_version=fv)
            break
        except ValueError:  # feature_version below this Python's minimum
            continue
        except SyntaxError as exc:
            problems.append("syntax error under grammar %s.%s: %s" % (fv[0], fv[1], exc))
            return problems
    if tree is None:
        tree = ast.parse(code)

    banned_nodes = [("JoinedStr", "f-string"), ("NamedExpr", "walrus operator"), ("Match", "match statement"),
                    ("AsyncFunctionDef", "async def"), ("Await", "await"), ("AsyncFor", "async for"),
                    ("AsyncWith", "async with"), ("AnnAssign", "variable annotation"), ("TryStar", "except*"),
                    ("Global", "global statement"), ("Nonlocal", "nonlocal statement")]
    for node in ast.walk(tree):
        for cls_name, label in banned_nodes:
            cls = getattr(ast, cls_name, None)
            if cls is not None and isinstance(node, cls):
                bad(node, label + " is not allowed on device")
        if isinstance(node, (ast.FunctionDef, ast.Lambda)):
            args = node.args
            for a in list(args.args) + list(args.kwonlyargs) + list(getattr(args, "posonlyargs", [])):
                if getattr(a, "annotation", None) is not None:
                    bad(node, "argument annotations are not allowed on device")
            if isinstance(node, ast.FunctionDef) and node.returns is not None:
                bad(node, "return annotations are not allowed on device")
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root == "machine":
                    continue  # attribute use is checked below
                if root not in _ALLOWED_IMPORTS:
                    bad(node, "import of %r is not allowed (only %s)" % (alias.name, sorted(_ALLOWED_IMPORTS)))
        if isinstance(node, ast.ImportFrom):
            if node.level:
                bad(node, "relative import")
            root = (node.module or "").split(".")[0]
            if root == "machine":
                for alias in node.names:
                    if alias.name not in _MACHINE_OK:
                        bad(node, "from machine import %s" % alias.name)
            elif root not in _ALLOWED_IMPORTS:
                bad(node, "from %r import ... is not allowed" % node.module)
            for alias in node.names:
                if alias.name in _FORBIDDEN_NAMES:
                    bad(node, "import of forbidden name %r" % alias.name)
        if isinstance(node, ast.Import) and any(a.name.split(".")[0] == "machine" for a in node.names):
            if "machine_unique_id" not in allow_set and "rtc" not in allow_set:
                bad(node, "import machine is only allowed for unique_id() in the identity snippet and RTC in the clock snippets")
        rtc_ok = "rtc" in allow_set
        if isinstance(node, ast.Attribute):
            if isinstance(node.value, ast.Name) and node.value.id == "machine" and node.attr not in _MACHINE_OK:
                if not (rtc_ok and node.attr == "RTC"):
                    bad(node, "machine.%s is not allowed (hardware access / reset)" % node.attr)
            if node.attr in _FORBIDDEN_NAMES and not (rtc_ok and node.attr == "RTC"):
                bad(node, "attribute %r is not allowed" % node.attr)
        if isinstance(node, ast.Name):
            if node.id in _FORBIDDEN_NAMES:
                bad(node, "name %r is not allowed" % node.id)
            if node.id == "__import__" and "dynamic_import" not in allow_set:
                bad(node, "__import__ is not allowed")
        if isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name) and fn.id == "print":
                first = node.args[0] if node.args else None
                text = None
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    text = first.value
                elif isinstance(first, ast.BinOp) and isinstance(first.op, (ast.Mod, ast.Add)):
                    left = first.left
                    while isinstance(left, ast.BinOp):  # "@@{" + a + b: the leftmost operand starts the line
                        left = left.left
                    if isinstance(left, ast.Constant) and isinstance(left.value, str):
                        text = left.value
                if text is None or not text.startswith(SENTINEL):
                    bad(node, "print() must start with the %r sentinel literal" % SENTINEL)
            if isinstance(fn, ast.Name) and fn.id in ("bytearray", "bytes") and node.args:
                a0 = node.args[0]
                if isinstance(a0, ast.Constant) and isinstance(a0.value, int) and a0.value > 512:
                    bad(node, "buffer of %d bytes exceeds 512" % a0.value)
            if isinstance(fn, ast.Attribute) and fn.attr in ("read", "readinto", "recv") and node.args:
                a0 = node.args[0]
                if isinstance(a0, ast.Constant) and isinstance(a0.value, int) and a0.value > 512:
                    bad(node, "%s(%d) exceeds the 512-byte buffer rule" % (fn.attr, a0.value))
            if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Attribute):
                if fn.value.attr == "stdout":
                    bad(node, "write through print() only (sentinel rule)")
    # recursion: a function that calls itself by name
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name) and sub.func.id == node.name:
                    bad(node, "function %r is recursive (walks must be iterative)" % node.name)
    return problems


def lint_all() -> Dict[str, List[str]]:
    """Run check_snippet over every rendered snippet; returns {name: problems} (empty lists = ok)."""
    result = {}
    for name, template in SNIPPETS.items():
        dummy = {m.group(1): "0" for m in _TOKEN.finditer(template)}
        result[name] = check_snippet(_TOKEN.sub(lambda m: dummy[m.group(1)], template), SNIPPET_ALLOW.get(name, ()))
    return result


def snippet_sizes() -> Dict[str, int]:
    return {name: len(t) for name, t in SNIPPETS.items()}


# ---------------------------------------------------------------------------------------------
# Host-side plumbing: paths, running a snippet, parsing records, error mapping
# ---------------------------------------------------------------------------------------------

_ERRNO_NAMES = {
    # Linux/MicroPython numbering, then a few newlib (ESP-IDF) and macOS values.  Only a fallback:
    # the board reports errno.errorcode[n] itself whenever its errno module has it.
    1: "EPERM", 2: "ENOENT", 5: "EIO", 9: "EBADF", 11: "EAGAIN", 12: "ENOMEM", 13: "EACCES", 16: "EBUSY",
    17: "EEXIST", 18: "EXDEV", 19: "ENODEV", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 23: "ENFILE",
    24: "EMFILE", 27: "EFBIG", 28: "ENOSPC", 30: "EROFS", 36: "ENAMETOOLONG", 39: "ENOTEMPTY",
    63: "ENAMETOOLONG", 66: "ENOTEMPTY", 90: "ENOTEMPTY", 91: "ENAMETOOLONG",
}  # fmt: skip

_ERRNO_TEXT = {
    "ENOENT": ("does not exist on the board", "Refresh the Files view; the file or folder may have been deleted."),
    "ENOTDIR": ("is not a folder (or a parent in the path is a file)", "Pick a different path or delete the file that is in the way."),
    "EISDIR": ("is a folder, not a file", "Use the folder delete command, or pick a file."),
    "EEXIST": ("already exists on the board", "Choose another name, or delete the existing item first."),
    "ENOTEMPTY": ("is a folder that is not empty", "Delete the contents first, or use the delete-folder command."),
    "ENOSPC": ("does not fit: the board's flash is full", "Delete files you no longer need on the board (Files view), then try again."),
    "EROFS": ("cannot be written: the board's filesystem is read-only", "The storage may be mounted read-only (for example a USB drive mode); disconnect it or reset the board."),
    "EACCES": ("cannot be accessed: permission denied", "Check that no other program is using the file, then try again."),
    "EPERM": ("cannot be changed: operation not permitted", "Check the path; system folders and mount points cannot be removed."),
    "EBUSY": ("is busy", "Stop the running program (Stop button), then try again."),
    "EXDEV": ("is on a different filesystem from the destination (for example flash and an SD card)", "Copy the file to the new location, then delete the original."),
    "ENAMETOOLONG": ("has a name that is too long for the board's filesystem", "Use a shorter file name."),
    "ENOMEM": ("could not be processed: the board ran out of memory", "Try again; if it keeps happening, stop the program and soft reset the board to free memory."),
    "EIO": ("hit an input/output error", "Try again; if it repeats, the board's flash may be damaged or the transfer was corrupted."),
    "EMFILE": ("could not be opened: too many files are open on the board", "Soft reset the board to close stray files, then try again."),
}  # fmt: skip


def _norm(path: Any, allow_root: bool = True) -> str:
    """Normalise a device path: absolute, POSIX, no '//' or trailing '/', no '.'/'..'."""
    if not isinstance(path, str) or not path.startswith("/"):
        raise _berr(
            "E_PROTOCOL",
            "Device paths must be absolute and start with '/', got %r." % (path,),
            detail="bad device path",
            hint="Use POSIX paths such as /lib/utils.py.",
        )
    if "\x00" in path:
        raise _berr("E_PROTOCOL", "Device path contains a NUL character.", detail="bad device path")
    parts = [p for p in path.split("/") if p]
    if any(p in (".", "..") for p in parts):
        raise _berr(
            "E_PROTOCOL",
            "Device path %r contains '.' or '..'." % (path,),
            detail="bad device path",
            hint="Use a plain absolute path.",
        )
    norm = "/" + "/".join(parts)
    if norm == "/" and not allow_root:
        raise _berr("E_PROTOCOL", "This operation needs a file or folder path, not '/'.", detail="root not allowed")
    try:
        norm.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise _berr("E_PROTOCOL", "Device path is not valid text.", detail=str(exc))
    return norm


def _parent(path: str) -> str:
    return path[: path.rfind("/")] or "/"


def _as_bytes(x: Any) -> bytes:
    if x is None:
        return b""
    if isinstance(x, str):
        return x.encode("utf-8", "replace")
    return bytes(x)


def _split_output(stdout: Any) -> List[Any]:
    """Split raw output into records (dict) and noise lines (bytes), in order."""
    items: List[Any] = []
    for raw in _as_bytes(stdout).split(b"\n"):
        i = raw.find(b"@@{")
        if i < 0:
            if raw.strip():
                items.append(raw.rstrip(b"\r"))
            continue
        body = raw[i + 2 :].rstrip(b"\r")
        try:
            items.append(json.loads(body.decode("utf-8")))
        except ValueError:
            raise _berr(
                "E_INTERNAL",
                "The board sent a damaged reply. Try the operation again; if it repeats, reset the board.",
                detail="unparseable record: %r" % (body[:200],),
            )
    return items


def _damaged(op: str, what: str, exc: Optional[BaseException] = None) -> Exception:
    """BridgeError for a reply that parsed as JSON but is not what the snippet prints (line noise)."""
    more = ": %s: %s" % (type(exc).__name__, exc) if exc is not None else ""
    return _berr(
        "E_INTERNAL",
        "The board sent a damaged reply while %s. Try again; if it repeats, check the USB cable and reset the board." % op,
        detail="damaged reply: %s%s" % (what, more),
    )


def _int(rec: Any, key: str, op: str = "reading a board reply", default: int = 0) -> int:
    """``int(rec[key])`` where a bad value is a damaged reply (BridgeError), never a ValueError."""
    try:
        return int(rec.get(key, default))
    except (TypeError, ValueError, AttributeError, OverflowError) as exc:
        raise _damaged(op, "field %r" % key, exc)


def _decode_str(rec: Dict[str, Any], key: str, default: str = "") -> str:
    try:
        if key in rec:
            return str(rec[key])
        kx = key + "x"
        if kx in rec:
            return binascii.unhexlify(rec[kx]).decode("utf-8", "replace")
    except (TypeError, ValueError, AttributeError) as exc:  # binascii.Error is a ValueError
        raise _damaged("reading a board reply", "field %r" % key, exc)
    return default


def _damage_guard(op: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator for pure reply-parsing helpers: odd shapes from line noise become BridgeError."""

    def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
        def wrapper(*args: Any, **kw: Any) -> Any:
            try:
                return fn(*args, **kw)
            except (TypeError, ValueError, KeyError, IndexError, AttributeError, OverflowError) as exc:
                raise _damaged(op, "unexpected shape", exc)

        wrapper.__name__ = fn.__name__
        wrapper.__doc__ = fn.__doc__
        return wrapper

    return deco


def _errno_name(num: int, name: str) -> str:
    return name or _ERRNO_NAMES.get(num, "ERRNO_%d" % num if num else "EIO")


def fs_error(name: str, path: Optional[str] = None, op: str = "working", num: int = 0, subject: Optional[str] = None) -> Exception:
    """Build the E_FS_ERRNO BridgeError for errno NAME (``detail`` carries the name)."""
    name = _errno_name(num, name)
    what, hint = _ERRNO_TEXT.get(name, ("failed (%s)" % name, "Try again; if it repeats, reset the board."))
    if subject is None:
        subject = "'%s'" % path if path else "the operation"
    return _berr("E_FS_ERRNO", "Board file error while %s: %s %s." % (op, subject, what), detail=name, hint=hint)


_TRACE_ERRNO = re.compile(r"OSError:\s*(?:\[Errno\s+(\d+)\]\s*([A-Z0-9_]*)|(\d+))")


def _raise_traceback(stderr: bytes, op: str, path: Optional[str]) -> None:
    text = stderr.decode("utf-8", "replace").strip()
    last = text.splitlines()[-1] if text else ""
    m = _TRACE_ERRNO.search(text)
    if m:
        num = int(m.group(1) or m.group(3) or 0)
        raise fs_error(m.group(2) or "", path, op, num)
    if "MemoryError" in last:
        raise fs_error("ENOMEM", path, op)
    if "KeyboardInterrupt" in last:
        raise _berr("E_CANCELLED", "The operation was interrupted on the board.", detail=text[-300:])
    raise _berr(
        "E_INTERNAL",
        "The board raised an unexpected error while running a file-system helper. Reset the board and try again.",
        detail=text[-1000:],
    )


def _run(
    exec_fn: ExecFn,
    code: str,
    timeout: float,
    op: str,
    path: Optional[str] = None,
    subjects: Optional[Dict[str, str]] = None,
) -> List[Any]:
    """Execute a snippet; return parsed items (records and noise lines); raise on error records.

    ``subjects`` maps the error record's ``w`` tag to the wording used in the message (for
    operations with two paths).
    """
    out, err = exec_fn(code, timeout)
    items = _split_output(out)
    for it in items:
        if isinstance(it, dict) and it.get("k") == "err":
            exc = fs_error(str(it.get("e") or ""), path, op, _int(it, "n", op), (subjects or {}).get(str(it.get("w"))))
            # the target was removed and the final rename failed: the temp file holds the only copy
            exc.keep_tmp = any(isinstance(x, dict) and x.get("k") == "keep" for x in items)  # type: ignore[attr-defined]
            raise exc
    if _as_bytes(err).strip():
        _raise_traceback(_as_bytes(err), op, path)
    return items


def _records(items: Sequence[Any]) -> List[Dict[str, Any]]:
    return [it for it in items if isinstance(it, dict)]


def _need(recs: Sequence[Dict[str, Any]], kind: str, op: str) -> Dict[str, Any]:
    for r in recs:
        if r.get("k") == kind:
            return r
    raise _berr(
        "E_INTERNAL",
        "The board did not finish %s (no '%s' reply). Check the connection and try again." % (op, kind),
        detail="missing %s record" % kind,
    )


def _check_cancel(cancel: Any) -> None:
    if cancel is not None and cancel.is_set():
        raise _berr("E_CANCELLED", "Cancelled.", detail="cancelled by request")


def _progress(progress: Optional[ProgressFn], done: int, total: int, label: str) -> None:
    if progress is not None:
        progress(done, total, label)


def _local_error(exc: BaseException, path: str, action: str) -> Exception:
    num = getattr(exc, "errno", None)
    name = _errno.errorcode.get(num, "") if isinstance(num, int) else ""
    win = getattr(exc, "winerror", None)
    if win in (32, 33):
        name = name or "EBUSY"
    reason = getattr(exc, "strerror", None) or str(exc)
    return _berr(
        "E_LOCAL_IO",
        "Could not %s '%s' on this computer: %s." % (action, path, reason),
        detail=name or type(exc).__name__,
        hint="Check that the file exists and is not open or locked by another program (cloud-synced folders: make it 'always keep on this device'), then try again.",
    )


def _read_local(local: str) -> bytes:
    try:
        with open(os.fspath(local), "rb") as f:
            return f.read()
    except OSError as exc:
        raise _local_error(exc, os.fspath(local), "read")


def _replace_retry(src: str, dst: str, attempts: int = 5) -> None:
    """os.replace with short retries on EBUSY/EPERM/EACCES (cloud clients and AV scanners)."""
    delay = 0.05
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except OSError as exc:
            transient = exc.errno in (_errno.EBUSY, _errno.EPERM, _errno.EACCES) or getattr(exc, "winerror", None) in (5, 32, 33)
            if transient and i < attempts - 1:
                time.sleep(delay)
                delay = min(delay * 2, 0.2)
                continue
            raise _local_error(exc, dst, "replace")


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------------------------
# Shadow guard (protocol: E_SHADOWS_MODULE) and mount-point refusal
# ---------------------------------------------------------------------------------------------

# Folders MicroPython searches for imports on a stock board ('' = the working folder, normally '/',
# and /lib).  The bridge passes the board's real absolute sys.path entries (identity.syspath) when it
# has them, for example ['/flash', '/flash/lib'] on a pyboard.
SHADOW_ROOTS = ("/", "/lib")
_MODULE_SUFFIXES = (".py", ".mpy")


def _shadow_table(names: Any) -> Dict[str, str]:
    """{casefolded top-level module name: name as given}.  A bare string is ONE name, not letters."""
    if names is None:
        return {}
    if isinstance(names, str):
        names = [names]
    table: Dict[str, str] = {}
    for n in names:
        if isinstance(n, str) and n.strip():
            top = n.strip().split(".")[0]
            table.setdefault(top.casefold(), top)
    return table


def check_shadow(path: str, names: Any, roots: Optional[Sequence[str]] = None, kind: str = "file") -> None:
    """Raise ``E_SHADOWS_MODULE`` when creating ``path`` would hide a module listed in ``names``.

    Looks at the first name below each import root (``roots``, default ``/`` and ``/lib``):
    ``acme.py``, ``acme.mpy``, a folder ``acme/`` (package, with or without ``__init__.py``) and
    anything inside such a folder all shadow ``acme``.  ``kind`` is ``"file"`` (fs.put), ``"dir"``
    (fs.mkdir) or ``"any"`` (fs.mv destination: either).  A plain file called ``acme`` (no .py) is
    not importable and passes.  Matching is exact first; a name that differs only in letter case is
    refused too (FAT/SD cards and Windows/macOS folders cannot tell ``Acme.py`` from ``acme.py``)
    and the message says so.  Nothing is sent to the board.
    """
    table = _shadow_table(names)
    if not table:
        return
    path = _norm(path, allow_root=False)
    for root in (roots if roots is not None else SHADOW_ROOTS):
        root = _norm(root)
        pre = "/" if root == "/" else root + "/"
        if not path.startswith(pre) or path == root:
            continue
        parts = path[len(pre) :].split("/")
        first = parts[0]
        cands = []  # (module stem as written, suffix as written or "")
        if len(parts) > 1 or kind in ("dir", "any"):
            cands.append((first, ""))  # a folder: package or namespace package
        if len(parts) == 1 and kind in ("file", "any"):
            for suf in _MODULE_SUFFIXES:
                if first.casefold().endswith(suf):
                    cands.append((first[: -len(suf)], first[-len(suf) :]))
        for stem, suf in cands:
            orig = table.get(stem.casefold())
            if orig is None:
                continue
            exact = stem == orig and suf in ("", ".py", ".mpy")
            shown = pre + first
            if exact:
                msg = (
                    "Cannot save '%s': a module named '%s' is already built into or frozen into the board's firmware, "
                    "and '%s' would hide it so that 'import %s' loads this file instead." % (path, orig, shown, orig)
                )
                hint = "Rename it (for example my_%s.py), then try again. Nothing was written to the board." % orig
            else:
                msg = (
                    "Cannot save '%s': '%s' differs from the built-in module '%s' only in capital letters. On SD cards (FAT) "
                    "and in Windows/macOS folders those are the same name, so it could hide the module." % (path, first, orig)
                )
                hint = "Choose a name that is not '%s' in any capitalisation (for example my_%s.py). Nothing was written to the board." % (orig, orig.lower())
            raise _berr(
                "E_SHADOWS_MODULE",
                msg,
                detail="module=%s; match=%s; root=%s; path=%s" % (orig, "exact" if exact else "case-insensitive", root, path),
                hint=hint,
            )


def mount_point_reason(exec_fn: ExecFn, path: str) -> Optional[str]:
    """Why ``path`` (a direct child of ``/``) must not be wiped as an ordinary folder, or None.

    Reasons: ``"dev"`` (different st_dev than ``/``), ``"root"`` (``/`` is a virtual root with no
    filesystem of its own, as on a pyboard where /flash and /sd are the drives), ``"vfs"``
    (statvfs differs from ``/``: an SD card or second flash mounted below ``/``) and ``"cwd"`` (the
    board's working folder).  Read-only.  Other top-level folders (``/lib``, ``/data``) give None.
    Deeper mounts (``/mnt/sd``) are not looked for.  A path that does not exist or is not a folder
    gives None (the real operation reports that itself).
    """
    path = _norm(path, allow_root=False)
    if path.count("/") != 1:
        return None
    try:
        recs = _records(_run(exec_fn, render("mount_probe", P=_hexs(path)), 15.0, "checking", path))
    except Exception as exc:  # noqa: BLE001
        if getattr(exc, "code", None) == "E_FS_ERRNO":
            return None
        raise
    return str(_need(recs, "mnt", "checking %s" % path).get("w") or "") or None


def _mount_refusal(path: str, why: str) -> Exception:
    exc = _berr(
        "E_FS_ERRNO",
        "Refusing to delete '%s': it is a whole storage drive of the board (a mount point such as /flash or /sd, or the board's "
        "working folder), so this would erase everything on it, including boot.py and main.py." % path,
        detail="EPERM",
        hint="Delete the individual files or sub-folders you want to remove instead. To wipe the whole drive on purpose, "
        "ask the user to confirm again and repeat the request with allowMount:true.",
    )
    exc.needs_allow_mount = True  # type: ignore[attr-defined]
    exc.mount_reason = why  # type: ignore[attr-defined]
    return exc


# ---------------------------------------------------------------------------------------------
# Public operations
# ---------------------------------------------------------------------------------------------


def identity(exec_fn: ExecFn) -> Dict[str, Any]:
    """Read-only board identity (RQ-ID-1).  Imports no application package."""
    items = _run(exec_fn, render("identity"), 20.0, "reading the board identity")
    recs = _records(items)
    rec = _need(recs, "id", "reading the board identity")
    return _identity_result(items, rec)


@_damage_guard("reading the board identity")
def _identity_result(items: Sequence[Any], rec: Dict[str, Any]) -> Dict[str, Any]:
    modules: List[str] = []
    inside = False
    for it in items:
        if isinstance(it, dict):
            inside = it.get("k") == "hm"
            continue
        if not inside:
            continue
        line = it.decode("utf-8", "replace")
        if line.startswith("Plus any modules"):
            inside = False
            continue
        for word in line.split():
            # frozen packages print as path names without .py ('acme/__init__', 'acme/motor', py/builtinhelp.c): the
            # importable name that a student file could shadow is the top-level one
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)(?:/[A-Za-z_][A-Za-z0-9_]*)*$", word)
            if m:
                modules.append(m.group(1))
    caps = rec.get("caps") or {}
    un = rec.get("uname") or {}
    ver = list(rec.get("version") or [0, 0, 0])[:3]
    hints = rec.get("hints") or {}
    return {
        "impl": _decode_str(rec, "impl"),
        "version": [int(x) for x in ver],
        "machine": _decode_str(rec, "machine"),
        "build": _decode_str(rec, "build"),
        "mpy": rec.get("mpy"),
        "platform": _decode_str(rec, "platform"),
        "uname": {k: _decode_str(un, k) for k in ("sysname", "nodename", "release", "version", "machine")},
        "uniqueId": _decode_str(rec, "uid"),
        "syspath": [_decode_str(x, "p") for x in rec.get("syspath") or []],
        "root": [_decode_str(x, "p") for x in rec.get("root") or []],
        "caps": {
            "hash": caps.get("hash", "none"),
            "compile": bool(caps.get("compile", False)),
            "paste": None,  # filled in by the link (raw-paste support is a property of the REPL, not the VM)
            "mem": int(caps.get("mem", 0)),
        },
        "profileHints": {
            "modules": sorted(set(modules)),
            "frozen": bool(hints.get("frozen", False)),
            "fsTotal": int(hints.get("fsTotal", 0)),
            "fsFree": int(hints.get("fsFree", 0)),
        },
    }


def list_dir(exec_fn: ExecFn, path: str) -> Dict[str, Any]:
    """``fs.list``: entries of one directory, sizes from os.stat (never from ilistdir)."""
    path = _norm(path)
    recs = _records(_run(exec_fn, render("list", P=_hexs(path)), 20.0, "listing", path))
    _need(recs, "end", "listing %s" % path)
    entries: List[Dict[str, Any]] = []
    for r in recs:
        k = r.get("k")
        if k == "d":
            entries.append({"name": _decode_str(r, "n"), "type": "dir", "size": 0})
        elif k == "f":
            size = _int(r, "s", "listing")
            e = {"name": _decode_str(r, "n"), "type": "file", "size": max(size, 0)}
            if size < 0:
                e["statError"] = True
            entries.append(e)
    entries.sort(key=lambda e: e["name"])
    return {"entries": entries}


def manifest(
    exec_fn: ExecFn,
    root: str,
    hash: bool = True,  # noqa: A002 - protocol argument name
    exclude: Sequence[str] = (),
    progress: Optional[ProgressFn] = None,
    timeout: float = 120.0,
) -> Dict[str, Any]:
    """``fs.manifest``: every file and directory under ``root`` in ONE round trip.

    ``exclude`` lists device paths (absolute, or relative to ``root``) whose whole subtree is
    skipped.  ``hash`` is "sha256" in the result when the board can hash, else "none" and the
    entries carry no ``sha256`` (the client compares by size, then downloads to compare).
    Unreadable sub-directories do not abort the walk; they are reported in ``warnings``.
    """
    root = _norm(root)
    ex = []
    for p in exclude:
        ex.append(_norm(p if p.startswith("/") else root.rstrip("/") + "/" + p))
    code = render("manifest", P=_hexs(root), X=",".join(_hexs(p) for p in ex), HASH=1 if hash else 0)
    recs = _records(_run(exec_fn, code, timeout, "building the file manifest", root))
    head = _need(recs, "h", "building the file manifest")
    _need(recs, "end", "building the file manifest")
    entries: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []
    for r in recs:
        k = r.get("k")
        if k == "d":
            entries.append({"path": _decode_str(r, "p"), "type": "dir", "size": 0})
        elif k == "f":
            size = _int(r, "s", "building the file manifest")
            e: Dict[str, Any] = {"path": _decode_str(r, "p"), "type": "file", "size": max(size, 0)}
            if r.get("h"):
                e["sha256"] = r["h"]
            if size < 0:
                e["statError"] = True
            entries.append(e)
        elif k == "w":
            warnings.append({"path": _decode_str(r, "p"), "errno": _errno_name(_int(r, "n", "building the file manifest"), str(r.get("e") or ""))})
    entries.sort(key=lambda e: e["path"])
    _progress(progress, len(entries), len(entries), root)
    return {"entries": entries, "hash": head.get("h", "none"), "truncated": False, "warnings": warnings}


def stat(exec_fn: ExecFn, path: str) -> Dict[str, Any]:
    """``fs.stat``: ``{exists}`` or ``{exists, type, size, mtime}``.  A missing path is a normal result."""
    path = _norm(path)
    recs = _records(_run(exec_fn, render("stat", P=_hexs(path)), 15.0, "checking", path))
    r = _need(recs, "s", "checking %s" % path)
    if not r.get("x"):
        return {"exists": False}
    if r.get("d"):
        return {"exists": True, "type": "dir", "size": 0, "mtime": _int(r, "m", "checking")}
    return {"exists": True, "type": "file", "size": _int(r, "s", "checking"), "mtime": _int(r, "m", "checking")}


def file_hash(exec_fn: ExecFn, path: str, want_hash: bool = True, timeout: float = 120.0) -> Dict[str, Any]:
    """Existence, type, size and (when the board can hash) sha256 of one path."""
    path = _norm(path)
    code = render("file_hash", P=_hexs(path), WANT=1 if want_hash else 0)
    recs = _records(_run(exec_fn, code, timeout, "hashing", path))
    r = _need(recs, "fh", "hashing %s" % path)
    if not r.get("x"):
        return {"exists": False, "type": None, "size": 0, "sha256": None}
    if r.get("d"):
        return {"exists": True, "type": "dir", "size": 0, "sha256": None}
    return {"exists": True, "type": "file", "size": _int(r, "s", "hashing"), "sha256": r.get("h") or None}


def _check_precondition(remote: str, if_sha: str, cur: Dict[str, Any]) -> None:
    """Raise E_DEST_CHANGED (or E_UNSUPPORTED) when the board's current copy is not what ``if_sha`` says."""
    if if_sha == "absent":
        if not cur["exists"]:
            return
        why = "a folder is there" if cur["type"] == "dir" else "a file is already there"
    elif not cur["exists"]:
        why = "the file is no longer on the board"
    elif cur["type"] != "file":
        why = "a folder is there now"
    elif not cur["sha256"]:
        raise _berr(
            "E_UNSUPPORTED", "The board cannot compute file hashes, so %s cannot be checked before it is replaced." % remote,
            detail="no hashlib on the board")
    elif cur["sha256"] == if_sha:
        return
    else:
        why = "its content changed"
    exc = _berr("E_DEST_CHANGED", "%s on the board changed since the last sync (%s), so it was not replaced." % (remote, why),
                detail="precondition %s failed" % ("absent" if if_sha == "absent" else "sha256=" + if_sha[:12]))
    exc.current = {"exists": cur["exists"], "type": cur["type"], "size": cur["size"], "sha256": cur["sha256"]}  # type: ignore[attr-defined]
    raise exc


def _tmp_name(remote: str) -> str:
    base = remote[remote.rfind("/") + 1 :]
    if len(base.encode("utf-8")) + len(TMP_SUFFIX) > 250:
        # very long names would overflow the filesystem's 255-byte limit with the suffix added
        return _parent(remote).rstrip("/") + "/~" + _sha256_hex(remote.encode("utf-8"))[:16] + TMP_SUFFIX
    return remote + TMP_SUFFIX


# After a failed or cancelled upload the temp file is removed through the same link.  A Stop sends
# Ctrl-C twice, so the first attempt can be hit by the second Ctrl-C; hence a short timeout, one
# retry after a brief wait, and a visible "deferred" marker when it still did not work.
CLEANUP_TIMEOUT = 2.0
CLEANUP_RETRY_WAIT = 0.25


def _cleanup_tmp(exec_fn: ExecFn, tmp: str) -> Optional[str]:
    """Remove the temp file; return None when it is gone, else a short reason (cleanup deferred)."""
    why = ""
    for attempt in (1, 2):
        try:
            recs = _records(_run(exec_fn, render("put_abort", T=_hexs(tmp)), CLEANUP_TIMEOUT, "cleaning up", tmp))
            _need(recs, "ok", "cleaning up %s" % tmp)
            return None
        except Exception as exc:  # noqa: BLE001 - recorded in `why`; the caller attaches it to the original error
            why = "%s%s" % (getattr(exc, "code", None) or type(exc).__name__, (" " + str(getattr(exc, "detail", "") or "")).rstrip())
        if attempt == 1:
            time.sleep(CLEANUP_RETRY_WAIT)
    return why


def _mark_cleanup_deferred(exc: BaseException, tmp: str, why: str) -> None:
    """Tell the caller the temp file is still on the board: attribute plus text in ``detail``."""
    note = 'cleanup:"deferred" tmp=%s (%s)' % (tmp, why)
    try:
        exc.cleanup = "deferred"  # type: ignore[attr-defined]
        exc.tmp_path = tmp  # type: ignore[attr-defined]
        old = getattr(exc, "detail", None)
        if isinstance(old, str) or old is None:
            exc.detail = (old + "; " if old else "") + note  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - an exception type that refuses attributes; nothing more to do
        pass


def put_file(
    exec_fn: ExecFn,
    local: str,
    remote: str,
    mkdirs: bool = True,
    expect_sha: Optional[str] = None,
    chunk: int = 1024,
    progress: Optional[ProgressFn] = None,
    cancel: Any = None,
    shadow_guard: Optional[Iterable[str]] = None,
    shadow_roots: Optional[Sequence[str]] = None,
    if_sha: Optional[str] = None,
) -> Dict[str, Any]:
    """``fs.put``: write ``local`` to ``remote`` atomically (temp file + verify + rename).

    The board only ever sees the final name after the whole content passed the size (and, when the
    board can hash, sha256) check; on failure or cancel the temp file is removed and the old
    ``remote`` is untouched.  ``expect_sha`` (hex sha256 of the content the caller is about to
    send): when the board's current file already has exactly that hash nothing is written and
    ``skipped`` is true.

    ``shadow_guard`` (module names the bridge got from the profile and the board's built-in/frozen
    inventory) makes a target that would hide one of them fail with ``E_SHADOWS_MODULE`` before
    anything is read or sent; see ``check_shadow``.  When the upload fails or is cancelled after the
    board may have created the temp file, it is removed (two attempts); if that fails too the error
    carries ``cleanup:"deferred"`` in ``detail`` (and ``.cleanup``/``.tmp_path``) and
    ``clean_orphans`` removes the file later.

    ``if_sha`` is a precondition on the board's CURRENT copy (compare-and-swap for sync): a hex sha256 means "replace
    only if the board file still has exactly this content", ``"absent"`` means "only if there is no file yet".  When it
    does not hold nothing is written and ``E_DEST_CHANGED`` is raised with ``.current`` = ``{exists, type, size,
    sha256}``; a board that cannot hash gives ``E_UNSUPPORTED`` for a hash precondition.  If the board already holds
    exactly the new content the upload is ``skipped`` (nothing would be lost either way).  Only the bridge talks to the
    board between the check and the final rename (file ops need an idle board), so the check cannot go stale.
    """
    remote = _norm(remote, allow_root=False)
    if if_sha is not None:
        if_sha = if_sha.strip().lower()
        if if_sha != "absent" and not re.match(r"^[0-9a-f]{64}$", if_sha):
            raise ValueError("if_sha must be 'absent' or a hex sha256")
    if not isinstance(chunk, int) or not 16 <= chunk <= 8192:
        raise ValueError("chunk must be between 16 and 8192 bytes")
    check_shadow(remote, shadow_guard, shadow_roots, kind="file")
    local = os.fspath(local)
    data = _read_local(local)
    size = len(data)
    sha = _sha256_hex(data)
    label = remote
    _check_cancel(cancel)
    want_same = bool(expect_sha and expect_sha.strip().lower() == sha)
    if want_same or if_sha is not None:
        cur = file_hash(exec_fn, remote)  # hashed even for "absent": a board that already holds the new bytes is a skip
        if cur["exists"] and cur["type"] == "file" and cur["size"] == size and cur["sha256"] == sha:
            _progress(progress, size, size, label)
            return {"bytes": size, "sha256": sha, "skipped": True, "sent": 0, "verified": "sha256"}
        if if_sha is not None:
            _check_precondition(remote, if_sha, cur)
    tmp = _tmp_name(remote)
    parent = _parent(remote) if mkdirs else ""
    if parent == "/":
        parent = ""
    timeout_finish = 20.0 + size / 8000.0
    verified = "size"
    started = False  # True once a snippet that may create the temp file has been sent
    try:
        _progress(progress, 0, size, label)
        if size <= chunk:
            code = render(
                "put_one", T=_hexs(tmp), D=_hexs(parent) if parent else "", SIZE=size,
                B=base64.b64encode(data).decode("ascii"), R=_hexs(remote), SHA=sha,
            )  # fmt: skip
            started = True
            verified = _finish_result(_run(exec_fn, code, timeout_finish, "uploading", remote), remote)
            _progress(progress, size, size, label)
        else:
            sent = 0
            while sent < size:
                _check_cancel(cancel)
                b64 = base64.b64encode(data[sent : sent + chunk]).decode("ascii")
                if sent == 0:
                    code = render("put_first", T=_hexs(tmp), D=_hexs(parent) if parent else "", SIZE=size, B=b64)
                else:
                    code = render("put_append", T=_hexs(tmp), B=b64)
                started = True
                _need(_records(_run(exec_fn, code, 15.0, "uploading", remote)), "ok", "uploading %s" % remote)
                sent = min(size, sent + chunk)
                _progress(progress, sent, size, label)
            _check_cancel(cancel)
            code = render("put_finish", T=_hexs(tmp), R=_hexs(remote), SIZE=size, SHA=sha)
            verified = _finish_result(_run(exec_fn, code, timeout_finish, "finishing the upload", remote), remote)
    except BaseException as exc:
        if started and not _keeps_tmp(exc):
            why = _cleanup_tmp(exec_fn, tmp)
            if why is not None:
                _mark_cleanup_deferred(exc, tmp, why)
        raise
    return {"bytes": size, "sha256": sha, "skipped": False, "sent": size, "verified": verified}


def _keeps_tmp(exc: BaseException) -> bool:
    return bool(getattr(exc, "keep_tmp", False))


def _finish_result(items: Sequence[Any], remote: str) -> str:
    recs = _records(items)
    for r in recs:
        if r.get("k") == "bad":
            what = "size" if r.get("w") == "size" else "sha256"
            raise _berr(
                "E_FS_ERRNO",
                "The file '%s' was damaged on the way to the board (%s check failed), so it was not saved. Try again." % (remote, what),
                detail="EIO",
                hint="If this repeats, check the USB cable and that the board has free space.",
            )
    return str(_need(recs, "ok", "uploading %s" % remote).get("v", "size"))


# Host-side temp name for fs.get.  The usual form is ``local + ".mpytmp"``; that adds 7 characters,
# so a legal 249..255 byte file name (or a path near Windows' 259) could not even be created.  Such
# names, and any name the filesystem refuses with ENAMETOOLONG, use ``<folder>/~<sha16>.mpytmp``
# instead (24 characters, no characters Windows rejects), the same trick as the board side
# (``_tmp_name``).  Same folder as ``local`` either way, so the final rename stays atomic.
_HOST_NAME_BUDGET = 250  # bytes for name + suffix; filesystems allow 255 (UTF-8 bytes or UTF-16 units)
_WIN_PATH_BUDGET = 259  # MAX_PATH 260 minus the terminating NUL


def _name_bytes(name: str) -> int:
    """Longest encoded size of ``name``: UTF-8 bytes, also after decomposition (HFS+ stores NFD)."""
    plain = name.encode("utf-8", "surrogatepass")  # surrogatepass: a lone surrogate must not crash the length check
    try:
        decomposed = unicodedata.normalize("NFD", name).encode("utf-8", "surrogatepass")
    except (UnicodeError, ValueError):
        return len(plain)
    return max(len(plain), len(decomposed))


def _short_host_tmp(local: str) -> str:
    short = "~" + _sha256_hex(local.encode("utf-8", "surrogatepass"))[:16] + TMP_SUFFIX
    return os.path.join(os.path.dirname(local), short)


def _host_tmp_candidates(local: str) -> List[str]:
    """Temp paths to try for ``local``, best first.  The short form is always the last one."""
    plain = local + TMP_SUFFIX
    short = _short_host_tmp(local)
    if _name_bytes(os.path.basename(plain)) > _HOST_NAME_BUDGET:
        return [short]
    if os.name == "nt" and len(os.path.abspath(plain)) > _WIN_PATH_BUDGET and len(short) < len(plain):
        return [short]
    return [plain, short]


def _name_too_long(exc: OSError) -> bool:
    return exc.errno == _errno.ENAMETOOLONG or getattr(exc, "winerror", None) == 206  # ERROR_FILENAME_EXCED_RANGE


def _open_host_tmp(candidates: Sequence[str], local: str) -> Tuple[str, Any]:
    """Open the first usable temp path for writing; returns ``(path, file)``."""
    for i, cand in enumerate(candidates):
        try:
            return cand, open(cand, "wb")
        except OSError as exc:
            if i + 1 < len(candidates) and _name_too_long(exc):
                continue  # the filesystem refused the long form: try the short hidden name
            # a hashed name means nothing to the student: name the file they asked for
            raise _local_error(exc, cand if cand == local + TMP_SUFFIX else local, "write")
    raise _berr("E_INTERNAL", "No temporary file name for '%s'." % local, detail="no temp candidates")


def get_file(
    exec_fn: ExecFn,
    remote: str,
    local: str,
    chunk: int = 2040,
    progress: Optional[ProgressFn] = None,
    cancel: Any = None,
) -> Dict[str, Any]:
    """``fs.get``: download ``remote`` to ``local`` (written as ``local + '.mpytmp'`` then replaced).

    The temp file lives in the same folder as ``local``.  When ``local``'s name is so long that the
    suffix would overflow the filesystem limit (basename of 244..255 bytes, Windows paths near 259), or
    the filesystem answers ENAMETOOLONG, the temp name is ``~<sha16>.mpytmp`` instead.  The temp file is
    removed when the download fails or is cancelled.
    """
    remote = _norm(remote, allow_root=False)
    if not isinstance(chunk, int) or not 16 <= chunk <= 8192:
        raise ValueError("chunk must be between 16 and 8192 bytes")
    local = os.fspath(local)
    info = file_hash(exec_fn, remote)
    if not info["exists"]:
        raise fs_error("ENOENT", remote, "downloading")
    if info["type"] == "dir":
        raise fs_error("EISDIR", remote, "downloading")
    size = info["size"]
    candidates = _host_tmp_candidates(local)
    tmp = candidates[0]
    parent_dir = os.path.dirname(local)
    try:
        if parent_dir:
            os.makedirs(parent_dir, exist_ok=True)
    except OSError as exc:
        raise _local_error(exc, parent_dir, "create the folder")
    h = hashlib.sha256()
    label = remote
    try:
        tmp, f = _open_host_tmp(candidates, local)
        with f:
            off = 0
            _progress(progress, 0, size, label)
            while off < size:
                _check_cancel(cancel)
                n = min(chunk, size - off)
                recs = _records(_run(exec_fn, render("get_chunk", P=_hexs(remote), OFF=off, LEN=n), 20.0, "downloading", remote))
                end = _need(recs, "end", "downloading %s" % remote)
                try:
                    data = b"".join(base64.b64decode(r["b"], validate=True) for r in recs if r.get("k") == "d")
                except (KeyError, TypeError, ValueError) as exc:  # binascii.Error is a ValueError: a byte was lost or changed
                    raise _damaged("downloading %s" % remote, "chunk data at offset %d" % off, exc)
                if len(data) != _int(end, "n", "downloading %s" % remote, -1) or not data:
                    raise _berr(
                        "E_FS_ERRNO",
                        "The file '%s' changed on the board while it was being downloaded. Try again." % remote,
                        detail="EIO",
                    )
                try:
                    f.write(data)
                except OSError as exc:
                    raise _local_error(exc, tmp if tmp == local + TMP_SUFFIX else local, "write")
                h.update(data)
                off += len(data)
                _progress(progress, off, size, label)
        got = h.hexdigest()
        if off != size or (info["sha256"] and got != info["sha256"]):
            raise _berr(
                "E_FS_ERRNO",
                "The downloaded copy of '%s' does not match the file on the board, so it was not saved. Try again." % remote,
                detail="EIO",
                hint="If this repeats, check the USB cable.",
            )
        _check_cancel(cancel)
        _replace_retry(tmp, local)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass  # temp file never created or already gone; the original error is what matters
        raise
    return {"bytes": size, "sha256": got, "verified": "sha256" if info["sha256"] else "size"}


def rm(exec_fn: ExecFn, path: str, missing_ok: bool = False) -> Dict[str, Any]:
    """``fs.rm``: delete one FILE (a folder gives EISDIR; use rmtree).  Missing file: ENOENT unless ``missing_ok``."""
    path = _norm(path, allow_root=False)
    try:
        _need(_records(_run(exec_fn, render("rm", P=_hexs(path)), 15.0, "deleting", path)), "ok", "deleting %s" % path)
    except Exception as exc:
        if missing_ok and getattr(exc, "detail", None) == "ENOENT":
            return {}
        raise
    return {}


def rmtree(
    exec_fn: ExecFn,
    path: str,
    confirm: bool = True,
    missing_ok: bool = False,
    progress: Optional[ProgressFn] = None,
    cancel: Any = None,
    batch: int = 64,
    allow_mount: bool = False,
) -> Dict[str, Any]:
    """``fs.rmtree``: remove a folder and everything under it, deepest first, in bounded batches.

    Refuses "/" and "" (also "//", "/.").  ``confirm`` mirrors the protocol's ``confirm:true``
    (the bridge handler must reject requests without it; passing False here raises E_PROTOCOL).
    A direct child of "/" that is a mount point or the board's working folder (pyboard /flash, an
    SD card at /sd; see ``mount_point_reason``) is refused with ``E_FS_ERRNO`` / ``EPERM`` (and
    ``.needs_allow_mount``) unless ``allow_mount=True``: one confirm must not wipe a whole drive.
    Ordinary top-level folders such as /lib need no extra flag.
    Returns ``{"removed": n}`` counting files and folders, the folder itself included.
    """
    if confirm is not True:
        raise _berr("E_PROTOCOL", "Deleting a folder needs confirm:true.", detail="confirm missing")
    if not isinstance(path, str) or path.strip("/") == "" or path.strip() == "":
        raise _berr(
            "E_PROTOCOL",
            "Refusing to delete the board's root folder.",
            detail="refused root",
            hint="Delete individual files or sub-folders instead.",
        )
    path = _norm(path, allow_root=False)
    if allow_mount is not True:
        why = mount_point_reason(exec_fn, path)
        if why:
            raise _mount_refusal(path, why)
    removed = 0
    stuck = 0
    while True:
        _check_cancel(cancel)
        try:
            recs = _records(_run(exec_fn, render("rmtree", P=_hexs(path), LIMIT=batch), 60.0, "deleting", path))
        except Exception as exc:
            if missing_ok and removed == 0 and getattr(exc, "detail", None) == "ENOENT":
                return {"removed": 0}
            raise
        r = _need(recs, "rm", "deleting %s" % path)
        n = _int(r, "n", "deleting %s" % path)
        removed += n
        _progress(progress, removed, 0, path)
        if not r.get("more"):
            return {"removed": removed}
        stuck = stuck + 1 if n == 0 else 0
        if stuck >= 3:
            raise fs_error("EBUSY", path, "deleting")


def mkdir(
    exec_fn: ExecFn,
    path: str,
    parents: bool = True,
    shadow_guard: Optional[Iterable[str]] = None,
    shadow_roots: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """``fs.mkdir``: with ``parents`` (default) mkdir -p semantics, else a plain single mkdir.

    ``shadow_guard``: a folder that would hide a listed module (``/lib/acme``) is refused with
    ``E_SHADOWS_MODULE`` before anything is created.
    """
    path = _norm(path, allow_root=False)
    check_shadow(path, shadow_guard, shadow_roots, kind="dir")
    name = "mkdir_p" if parents else "mkdir_1"
    recs = _records(_run(exec_fn, render(name, P=_hexs(path)), 20.0, "creating the folder", path))
    return {"created": _int(_need(recs, "ok", "creating %s" % path), "c", "creating the folder")}


def mkdir_p(
    exec_fn: ExecFn,
    path: str,
    shadow_guard: Optional[Iterable[str]] = None,
    shadow_roots: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """mkdir -p: idempotent; ``created`` counts the levels that did not exist."""
    return mkdir(exec_fn, path, parents=True, shadow_guard=shadow_guard, shadow_roots=shadow_roots)


def mv(
    exec_fn: ExecFn,
    src: str,
    dst: str,
    shadow_guard: Optional[Iterable[str]] = None,
    shadow_roots: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """``fs.mv``: os.rename on one filesystem.  Never overwrites (EEXIST); across mounts EXDEV.

    ``shadow_guard``: a destination that would hide a listed module is refused with
    ``E_SHADOWS_MODULE`` (file or folder), before the board is asked to rename anything.
    """
    src = _norm(src, allow_root=False)
    dst = _norm(dst, allow_root=False)
    if src != dst:
        check_shadow(dst, shadow_guard, shadow_roots, kind="any")
    subjects = {"src": "'%s'" % src, "dst": "the destination '%s' (moving '%s')" % (dst, src)}
    try:
        recs = _records(_run(exec_fn, render("mv", A=_hexs(src), B=_hexs(dst)), 20.0, "moving", src, subjects))
    except Exception as exc:
        if getattr(exc, "detail", None) == "EXDEV":
            raise fs_error("EXDEV", src, "moving", subject="'%s' (moving it to '%s')" % (src, dst))
        raise
    _need(recs, "ok", "moving %s" % src)
    return {}


def clean_orphans(exec_fn: ExecFn, root: str = "/") -> Dict[str, Any]:
    """Delete leftover ``*.mpytmp`` upload temp files under ``root`` (call once per session)."""
    m = manifest(exec_fn, root, hash=False)
    removed = []
    for e in m["entries"]:
        if e["type"] == "file" and e["path"].endswith(TMP_SUFFIX):
            rm(exec_fn, e["path"], missing_ok=True)
            removed.append(e["path"])
    return {"removed": removed}


_KIND_NAMES = {
    "f": "function", "c": "class", "m": "module", "i": "int", "n": "float", "s": "str", "b": "bool",
    "y": "bytes", "z": "None", "o": "object", "p": "property",
}  # fmt: skip


CLOCK_PLAUSIBLE_YEAR = 2024  # a board clock before this year was never set (an unset ESP32 clock starts in 2000)


def _clock_result(items: Sequence[Any], op: str) -> Dict[str, Any]:
    r = _need(_records(items), "clk", op)
    t = r.get("t")
    if not isinstance(t, list) or len(t) != 7 or not all(isinstance(x, int) and not isinstance(x, bool) for x in t):
        raise _berr("E_PROTOCOL", "The board's clock answer was malformed.", detail="t=%r" % (t,))
    return {"rtc": bool(r.get("r")), "time": t, "plausible": t[0] >= CLOCK_PLAUSIBLE_YEAR}


def clock_read(exec_fn: ExecFn) -> Dict[str, Any]:
    """``clock.read``: ``{rtc, time:[year, month, day, hour, minute, second, weekday], plausible}`` (read-only)."""
    return _clock_result(_run(exec_fn, render("clock_read"), 10.0, "reading the clock"), "reading the clock")


def clock_set(exec_fn: ExecFn, fields: Sequence[int]) -> Dict[str, Any]:
    """``clock.set``: set the board's RTC to ``[year, month, day, hour, minute, second, weekday]`` (weekday 0 = Monday)
    and read it back.  Volatile board state only: no file is written and nothing is reset.  ``E_UNSUPPORTED`` when the
    port has no ``machine.RTC``."""
    if not isinstance(fields, (list, tuple)) or len(fields) != 7:
        raise ValueError("clock fields must be [year, month, day, hour, minute, second, weekday]")
    y, mo, d, h, mi, sec, wd = (int(x) for x in fields)
    limits = ((y, 2000, 2099), (mo, 1, 12), (d, 1, 31), (h, 0, 23), (mi, 0, 59), (sec, 0, 59), (wd, 0, 6))
    for v, lo, hi in limits:
        if not lo <= v <= hi:
            raise ValueError("clock field %d is outside %d..%d" % (v, lo, hi))
    if not clock_read(exec_fn)["rtc"]:
        raise _berr("E_UNSUPPORTED", "This board has no real-time clock that can be set (no machine.RTC).",
                    detail="machine.RTC missing")
    code = render("clock_set", Y=y, MO=mo, D=d, WD=wd, H=h, MI=mi, S=sec)
    return _clock_result(_run(exec_fn, code, 10.0, "setting the clock"), "setting the clock")


def introspect_modules(exec_fn: ExecFn, names: Optional[Sequence[str]] = None) -> Dict[str, Any]:
    """``introspect.modules``: ``{modules:{name:{attrs,kinds,consts,file?,error?}}, listing:[...]}``.

    Imports ONLY the names given (nothing when ``names`` is None) and never calls getattr on
    module attributes.  ``listing`` is the board's built-in/frozen module inventory
    (``help('modules')``; empty when the port has no help).
    """
    names = list(names or [])
    for n in names:
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_.]*$", n):
            raise _berr("E_PROTOCOL", "Module name %r is not a valid Python module name." % (n,), detail="bad module name")
    code = render("introspect", N=",".join(_hexs(n) for n in names))
    items = _run(exec_fn, code, 30.0 + 5.0 * len(names), "listing modules")
    recs = _records(items)
    _need(recs, "end", "listing modules")
    return _introspect_result(items, recs)


@_damage_guard("listing modules")
def _introspect_result(items: Sequence[Any], recs: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    listing: List[str] = []
    inside = False
    for it in items:
        if isinstance(it, dict):
            inside = it.get("k") == "hm"
            continue
        if inside:
            line = it.decode("utf-8", "replace")
            if line.startswith("Plus any modules"):
                inside = False
                continue
            # frozen packages print as 'pkg/__init__' and 'pkg/sub' (py/builtinhelp.c strips only '.py'): kept as printed
            listing.extend(w for w in line.split() if re.match(r"^[A-Za-z_][A-Za-z0-9_]*(?:/[A-Za-z_][A-Za-z0-9_]*)*$", w))
    modules: Dict[str, Any] = {}
    for r in recs:
        if r.get("k") != "m":
            continue
        name = _decode_str(r, "n")
        if "err" in r or "errx" in r:
            modules[name] = {"attrs": [], "error": _decode_str(r, "err")}
            continue
        attrs = [a for a in _decode_str(r, "a").split(",") if a]
        kinds = _decode_str(r, "t")
        consts: Dict[str, Any] = {}
        for pair in _decode_str(r, "c").split(","):
            if "=" in pair:
                k, hx = pair.split("=", 1)
                text = binascii.unhexlify(hx).decode("utf-8", "replace")
                try:
                    consts[k] = ast.literal_eval(text)
                except (ValueError, SyntaxError):
                    consts[k] = text
        info: Dict[str, Any] = {"attrs": attrs}
        if len(kinds) == len(attrs):
            info["kinds"] = {a: _KIND_NAMES.get(k, "object") for a, k in zip(attrs, kinds)}
        if consts:
            info["consts"] = consts
        f = _decode_str(r, "f")
        if f:
            info["file"] = f
        classes: Dict[str, Any] = {}
        for entry in _decode_str(r, "cl").split(";"):
            parts = entry.split(":")
            if len(parts) != 3 or not parts[0]:
                continue
            members = [m for m in parts[1].split(",") if m]
            ckinds = parts[2]
            cinfo: Dict[str, Any] = {"members": members}
            if len(ckinds) == len(members):
                cinfo["kinds"] = {m: _KIND_NAMES.get(k, "object") for m, k in zip(members, ckinds)}
            classes[parts[0]] = cinfo
        if classes:
            info["classes"] = classes
        modules[name] = info
    return {"modules": modules, "listing": sorted(set(listing))}
