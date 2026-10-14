#!/usr/bin/env python3
"""fakeboard.py - a hardware-free, cross-platform fake MicroPython board.

Speaks the real MicroPython serial REPL protocol over a TCP socket so that
`mpremote connect socket://127.0.0.1:<port> ...` and any pyserial-based bridge
can be tested end to end on macOS, Windows and Linux CI (no pty, no hardware).

Implements: friendly REPL (echo, '>>> ', '... ' continuation, Ctrl-C/D/A/B),
raw REPL (Ctrl-A banner, '>' prompt, 'OK', \x04 framing, soft reset via empty
Ctrl-D, 'MPY: soft reboot'), raw-paste mode (\x05A\x01 with flow control),
boot.py/main.py on soft reset (main.py only from the friendly REPL, like the
ESP32 port), a chrooted `os`/`open` so '/main.py' maps into --root, MicroPython
style tracebacks ('OSError: [Errno 2] ENOENT') and an --exclusive mode that
refuses a second client while one is attached (like an exclusive serial lock).

Usage:  python fakeboard.py --root DIR [--port 0] [--exclusive] [--log FILE]
Prints one line 'LISTENING socket://127.0.0.1:<port>' on stdout when ready.
"""
import argparse, builtins, codeop, ctypes, errno as _errno, json, os, socket
import sys, threading, time, traceback, types
from pathlib import Path

BANNER = (b"MicroPython v1.29.0-fake on 2026-01-01; Fake ESP32 module with ESP32\r\n"
          b'Type "help()" for more information.\r\n')
CTRL_A, CTRL_B, CTRL_C, CTRL_D, CTRL_E = 1, 2, 3, 4, 5


class SoftReset(BaseException):
    pass


class FakeOS:
    """MicroPython-flavoured os rooted in a host directory."""
    sep = "/"

    def __init__(self, root):
        self._root, self._cwd = Path(root).resolve(), "/"

    def _p(self, path):
        path = path or "."
        full = path if path.startswith("/") else (self._cwd.rstrip("/") + "/" + path)
        parts = []
        for seg in full.split("/"):
            if seg in ("", "."):
                continue
            if seg == "..":
                parts and parts.pop()
            else:
                parts.append(seg)
        return self._root.joinpath(*parts)

    def getcwd(self): return self._cwd
    def chdir(self, p): self._cwd = "/" + "/".join(x for x in (p if p.startswith("/") else self._cwd + "/" + p).split("/") if x)
    def listdir(self, p="."): return [e.name for e in sorted(self._p(p).iterdir())]
    def ilistdir(self, p="."):
        for e in sorted(self._p(p).iterdir()):
            d = e.is_dir()
            yield (e.name, 0x4000 if d else 0x8000, 0, 0 if d else e.stat().st_size)
    def stat(self, p):
        s = self._p(p).stat()
        return (s.st_mode, 0, 0, 0, 0, 0, s.st_size, int(s.st_atime), int(s.st_mtime), int(s.st_ctime))
    def mkdir(self, p): self._p(p).mkdir()
    def rmdir(self, p): self._p(p).rmdir()
    def remove(self, p): self._p(p).unlink()
    unlink = remove
    def rename(self, a, b): self._p(a).rename(self._p(b))
    def statvfs(self, p): return (4096, 4096, 256, 128, 128, 0, 0, 0, 0, 255)
    def uname(self):
        return types.SimpleNamespace(sysname="esp32", nodename="esp32", release="1.29.0",
                                     version="v1.29.0-fake", machine="Fake ESP32 module with ESP32")
    def urandom(self, n): return os.urandom(n)


class Board:
    def __init__(self, root, sock, log):
        self.root, self.sock, self.log = Path(root), sock, log
        self.wlock = threading.Lock()
        self.mode = "friendly"          # friendly | raw
        self.line = bytearray()         # raw: pending program; friendly: pending input line
        self.cont = []                  # friendly: continuation lines
        self.paste = None               # raw-paste state dict
        self.worker = None              # currently running exec thread (for async KeyboardInterrupt)
        self.running = False            # True from spawn() until the program hands the prompt back
        self.alive = True
        self.reset_vm()

    # ---------------------------------------------------------------- output
    def tx(self, b):
        if isinstance(b, str):
            b = b.encode()
        with self.wlock:
            try:
                self.sock.sendall(b)
                if BAUD:
                    time.sleep(len(b) * 10.0 / BAUD)     # 8N1 = 10 bit times per byte
            except OSError:
                self.alive = False

    def ev(self, kind, **kw):
        self.log(kind, **kw)

    # -------------------------------------------------------------------- VM
    def reset_vm(self):
        self.fos = FakeOS(self.root)
        self.modules = {}
        board = self

        class Out:
            def write(self_, s):
                s = s if isinstance(s, str) else bytes(s).decode("utf8", "replace")
                board.tx(s.replace("\r\n", "\n").replace("\n", "\r\n"))
                return len(s)
            def flush(self_): pass
        self.out = Out()

        def fake_print(*a, sep=" ", end="\n", file=None, flush=False):
            (file or self.out).write(sep.join(str(x) for x in a) + end)

        def fake_open(p, mode="r", *a, **k):
            if not isinstance(p, int):
                p = str(self.fos._p(p))
            return builtins.open(p, mode, *a, **k)

        def fake_import(name, g=None, l=None, fromlist=(), level=0):
            return self.do_import(name, fromlist)

        b = dict(vars(builtins))
        b.update(print=fake_print, open=fake_open, __import__=fake_import)
        self.ns = {"__name__": "__main__", "__builtins__": b}
        t = time
        self.shims = {
            "os": self.fos, "uos": self.fos,
            "sys": types.SimpleNamespace(
                implementation=types.SimpleNamespace(name="micropython", version=(1, 29, 0)),
                platform="esp32", path=["", "/lib"], modules=self.modules, stdout=self.out,
                stderr=self.out, version="3.4.0; MicroPython v1.29.0-fake", byteorder="little",
                exit=lambda *a: (_ for _ in ()).throw(SoftReset())),
            "time": types.SimpleNamespace(
                sleep=t.sleep, sleep_ms=lambda m: t.sleep(m / 1000), time=t.time,
                ticks_ms=lambda: int(t.monotonic() * 1000) & 0x3FFFFFFF,
                ticks_diff=lambda a, b: a - b),
            "machine": types.SimpleNamespace(
                reset=lambda: (_ for _ in ()).throw(SoftReset()),
                soft_reset=lambda: (_ for _ in ()).throw(SoftReset()),
                unique_id=lambda: b"\xde\xad\xbe\xef\x00\x01", freq=lambda *a: 240000000,
                Pin=type("Pin", (), {"OUT": 1, "IN": 0, "__init__": lambda s, *a, **k: None,
                                     "value": lambda s, v=None: 0, "on": lambda s: None,
                                     "off": lambda s: None})),
            "micropython": types.SimpleNamespace(const=lambda x: x, opt_level=lambda *a: 0,
                                                 mem_info=lambda *a: None),
            "gc": types.SimpleNamespace(collect=lambda: None, mem_free=lambda: 100000,
                                        mem_alloc=lambda: 50000),
            "ubinascii": __import__("binascii"), "ujson": json, "uhashlib": __import__("hashlib"),
        }

    def do_import(self, name, fromlist):
        top = name.split(".")[0]
        if name in self.shims or top in self.shims:
            mod = self.shims.get(name) or self.shims[top]
            return mod
        if name in self.modules:
            return self.modules[name]
        for cand in (name.replace(".", "/") + ".py", name.replace(".", "/") + "/__init__.py",
                     "lib/" + name.replace(".", "/") + ".py"):
            p = self.fos._p("/" + cand)
            if p.is_file():
                m = types.ModuleType(name)
                m.__dict__["__builtins__"] = self.ns["__builtins__"]
                m.__file__ = cand
                self.modules[name] = m
                try:
                    exec(compile(p.read_text(), cand, "exec"), m.__dict__)
                except BaseException:
                    self.modules.pop(name, None)
                    raise
                return m
        return __import__(name)  # stdlib fallback (json, struct, hashlib, binascii, ...)

    def fmt_exc(self):
        et, ev, tb = sys.exc_info()
        lines = ["Traceback (most recent call last):\n"]
        for fr in traceback.extract_tb(tb):
            if fr.filename.startswith("<") or not fr.filename.startswith(("/", "C:")) or str(self.root) in fr.filename:
                lines.append('  File "%s", line %d, in %s\n' % (fr.filename, fr.lineno, fr.name))
        if et is KeyboardInterrupt:
            msg = "KeyboardInterrupt: "
        elif isinstance(ev, OSError) and ev.errno:
            msg = "OSError: [Errno %d] %s" % (ev.errno, _errno.errorcode.get(ev.errno, "?"))
        elif et is NameError:
            msg = "NameError: " + str(ev).replace("name '", "name '").replace("' is not defined", "' isn't defined")
        else:
            msg = "%s: %s" % (et.__name__, ev)
        return "".join(lines) + msg + "\n"

    def run(self, src, filename="<stdin>", eval_print=False):
        """Run source; returns (ok, traceback_text, soft_reset_requested)."""
        try:
            if eval_print:
                try:
                    code = compile(src, filename, "eval")
                except SyntaxError:
                    code = compile(src, filename, "exec"); eval_print = False
                r = eval(code, self.ns)
                if eval_print and r is not None:
                    self.out.write(repr(r) + "\n")
            else:
                exec(compile(src, filename, "exec"), self.ns)
            return True, "", False
        except SoftReset:
            return True, "", True
        except BaseException:
            return False, self.fmt_exc(), False

    def spawn(self, fn):
        self.running = True                  # set synchronously: no window where input is mis-routed
        def target():
            me = threading.current_thread()
            self.worker = me
            try:
                fn()
            finally:
                self.running = False
                if self.worker is me:
                    self.worker = None
        threading.Thread(target=target, daemon=True).start()

    def interrupt_worker(self):
        w = self.worker
        if w and w.ident:
            ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(w.ident), ctypes.py_object(KeyboardInterrupt))

    # ------------------------------------------------------------- lifecycle
    def boot(self, announce=True):
        if threading.current_thread() is self.worker:
            return self._boot(announce)      # already off the input thread
        self.spawn(lambda: self._boot(announce))

    def _boot(self, announce=True):
        """Soft reboot: fresh VM, boot.py, then main.py (friendly REPL only)."""
        self.reset_vm()
        if announce:
            self.tx("MPY: soft reboot\r\n")
        for fn in ("boot.py",) + (("main.py",) if self.mode == "friendly" else ()):
            p = self.root / fn
            if p.is_file():
                ok, tb, sr = self.run(p.read_text(), fn)
                if not ok:
                    self.tx(tb.replace("\n", "\r\n"))
        self.running = False                 # release the input gate BEFORE the host can see the prompt
        if self.mode == "friendly":
            self.tx(BANNER + b">>> ")
        else:
            self.tx(b"raw REPL; CTRL-B to exit\r\n>")

    # ----------------------------------------------------------------- input
    def feed(self, data):
        for c in data:
            if self.running and self.paste is None:
                # a program is running: only Ctrl-C matters
                if c == CTRL_C:
                    self.ev("interrupt")
                    self.interrupt_worker()
                continue
            (self.raw_byte if self.mode == "raw" else self.friendly_byte)(c)

    def finish_raw(self, src):
        def go():
            ok, tb, sr = self.run(src.decode("utf8", "replace"))
            self.tx(b"\x04" + (tb.replace("\n", "\r\n").encode() if not ok else b"") + b"\x04")
            if sr:
                self.boot()
            else:
                self.running = False
                self.tx(b">")
        self.spawn(go)

    def raw_byte(self, c):
        if self.paste is not None:
            p = self.paste
            if c == CTRL_D:
                self.tx(b"\x04")
                src, self.paste = bytes(p["buf"]), None
                self.ev("exec", n=len(src), paste=True)
                return self.finish_raw(src)
            p["buf"].append(c)
            p["remain"] -= 1
            if p["remain"] == 0:
                self.tx(b"\x01")
                p["remain"] = p["win"]
            return
        if c == CTRL_A:
            if bytes(self.line) == b"\x05A":
                win = 128
                self.tx(b"R\x01" + bytes([win & 255, win >> 8, 1]))
                self.paste = {"buf": bytearray(), "win": win, "remain": win}
                self.line.clear()
            else:
                self.line.clear(); self.tx(b"raw REPL; CTRL-B to exit\r\n>")
        elif c == CTRL_B:
            self.mode = "friendly"; self.line.clear()
            self.tx(b"\r\n" + BANNER + b">>> ")
        elif c == CTRL_C:
            self.line.clear()
        elif c == CTRL_D:
            src, self.line = bytes(self.line), bytearray()
            self.tx(b"OK")
            if not src:
                self.ev("softreset")
                self.tx(b"\r\n"); self.boot()
            else:
                self.ev("exec", n=len(src), paste=False)
                self.finish_raw(src)
        else:
            self.line.append(c)

    def friendly_byte(self, c):
        if c == CTRL_A:
            self.mode = "raw"; self.line.clear(); self.cont = []
            self.tx(b"\r\nraw REPL; CTRL-B to exit\r\n>")
        elif c == CTRL_B:
            self.tx(b"\r\n" + BANNER + b">>> ")
        elif c == CTRL_C:
            self.line.clear(); self.cont = []; self.tx(b"\r\n>>> ")
        elif c == CTRL_D:
            self.ev("softreset"); self.tx(b"\r\n"); self.boot()
        elif c in (8, 127):
            if self.line:
                self.line.pop(); self.tx(b"\x08 \x08")
        elif c in (13, 10):
            text = self.line.decode("utf8", "replace"); self.line.clear(); self.tx(b"\r\n")
            self.cont.append(text)
            src = "\n".join(self.cont)
            try:
                incomplete = codeop.compile_command(src + "\n", "<stdin>", "exec") is None and text.strip() != ""
            except SyntaxError:
                incomplete = False
            if incomplete:
                self.tx(b"... "); return
            self.cont = []
            if not src.strip():
                self.tx(b">>> "); return
            def go():
                ok, tb, sr = self.run(src + ("\n" if "\n" in src else ""), eval_print="\n" not in src)
                if not ok:
                    self.tx(tb.replace("\n", "\r\n"))
                if sr:
                    self.boot()
                else:
                    self.running = False
                    self.tx(b">>> ")
            self.spawn(go)
        elif c >= 32:
            self.line.append(c); self.tx(bytes([c]))


BAUD = 0


def serve(args):
    global BAUD
    BAUD = args.baud
    t0 = time.time()
    logf = open(args.log, "a", buffering=1) if args.log else None

    def log(kind, **kw):
        if logf:
            logf.write(json.dumps({"t": round(time.time() - t0, 3), "ev": kind, **kw}) + "\n")

    def listen():
        s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", listen.port)); s.listen(1); listen.port = s.getsockname()[1]
        return s
    listen.port = args.port
    srv = listen()
    print("LISTENING socket://127.0.0.1:%d" % listen.port, flush=True)
    boot_state = {"first": True}
    while True:
        conn, _ = srv.accept()
        if args.exclusive:
            srv.close()                      # port is 'locked' while a client holds it
        log("connect")
        board = Board(args.root, conn, log)
        # ESP32 behaviour: on open (DTR/RTS toggle) many boards reset; we model a plain open
        # as 'no reset' and just leave whatever the VM was doing (nothing) running.
        if args.run_main_on_connect and boot_state["first"]:
            board.boot(announce=False)
        boot_state["first"] = False
        try:
            while board.alive:
                data = conn.recv(4096)
                if not data:
                    break
                if BAUD:
                    time.sleep(len(data) * 10.0 / BAUD)
                board.feed(data)
        except OSError:
            pass
        finally:
            board.alive = False
            board.interrupt_worker()
            conn.close()
            log("disconnect")
            if args.exclusive:
                srv = listen()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--exclusive", action="store_true")
    ap.add_argument("--log")
    ap.add_argument("--baud", type=int, default=0, help="throttle both directions to this UART speed (0 = unlimited)")
    ap.add_argument("--run-main-on-connect", action="store_true",
                    help="run boot.py+main.py once at first connect (simulates a board that powered up with a main.py loop)")
    serve(ap.parse_args())
