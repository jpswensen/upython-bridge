#!/usr/bin/env python3
"""bridge_proto.py - proof-of-concept for architecture option C.

A long-lived helper that OWNS the serial port (via mpremote's SerialTransport, so it
inherits mpremote's DTR/RTS and Windows CP210x quirks), speaks JSON lines on
stdin/stdout, and can multiplex file operations with an interactive REPL byte stream
without ever closing the port.

stdin  (one JSON object per line):  {"id":1,"op":"connect","port":"socket://127.0.0.1:1234"}
stdout (one JSON object per line):  {"id":1,"ok":true,...}  |  {"ev":"repl","b64":"..."}
Ops: connect, close, ls, manifest, put, get, rm, run, interrupt, repl_open, repl_close, repl_write
"""
import base64, hashlib, json, os, sys, threading, time, traceback
sys.path.insert(0, os.environ.get('MPY_VENDOR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor'))
# Reserve the real stdout for the protocol; anything mpremote print()s (it does, e.g. on
# "could not enter raw repl") goes to stderr instead of corrupting the JSON-lines stream.
_PROTO = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8", newline="\n")
os.dup2(2, 1)
sys.stdout = sys.stderr
from mpremote.transport_serial import SerialTransport
from mpremote.transport import TransportExecError

MANIFEST_SRC = r'''
import os, hashlib, binascii
def walk(d, out):
    for n, t, *_ in os.ilistdir(d):
        p = (d.rstrip("/") + "/" + n)
        if t & 0x4000:
            out.append((p, 1, 0, "")); walk(p, out)
        else:
            h = hashlib.sha256()
            with open(p, "rb") as f:
                while True:
                    b = f.read(512)
                    if not b: break
                    h.update(b)
            out.append((p, 0, os.stat(p)[6], binascii.hexlify(h.digest()).decode()))
r = []; walk("%s", r); print(repr(r))
'''


class Bridge:
    def __init__(self):
        self.t = None
        self.lock = threading.RLock()       # who may touch the serial port right now
        self.repl = False
        self.out_lock = threading.Lock()
        self.pump_thread = None

    def emit(self, obj):
        with self.out_lock:
            _PROTO.write(json.dumps(obj) + "\n"); _PROTO.flush()

    # ------------------------------------------------------------ port access
    def raw(self):
        """Context manager: take the port, enter raw REPL WITHOUT soft reset, give it back."""
        bridge = self

        class Ctx:
            def __enter__(s):
                bridge.lock.acquire()
                if bridge.repl:
                    time.sleep(0.05)                  # let the pump drain what is in flight
                bridge.t.enter_raw_repl(soft_reset=False)
                return bridge.t
            def __exit__(s, *a):
                try:
                    if bridge.repl:
                        bridge.t.exit_raw_repl()      # back to the friendly REPL the user is looking at
                        # swallow the banner the board prints on Ctrl-B, up to the next prompt
                        bridge.t.read_until(1, b">>> ", timeout=1.0)
                        bridge.t.serial.write(b"\r")  # redraw a fresh prompt for the user
                finally:
                    bridge.lock.release()
        return Ctx()

    def pump(self):
        """Forward REPL bytes from the board to the extension while REPL mode is on."""
        while self.repl:
            with self.lock:
                if not self.repl:
                    break
                n = self.t.serial.inWaiting()
                data = self.t.serial.read(n) if n else b""
            if data:
                self.emit({"ev": "repl", "b64": base64.b64encode(data).decode()})
            else:
                time.sleep(0.01)

    # -------------------------------------------------------------------- ops
    def handle(self, m):
        op = m["op"]
        if op == "connect":
            self.t = SerialTransport(m["port"], baudrate=115200)
            return {"mode": "idle"}
        if op == "close":
            self.repl = False
            self.t.close(); self.t = None
            return {}
        if op == "ls":
            with self.raw() as t:
                return {"entries": [[e.name, bool(e.st_mode & 0x4000), e.st_size] for e in t.fs_listdir(m["path"])]}
        if op == "manifest":
            with self.raw() as t:
                return {"files": eval(t.exec(MANIFEST_SRC % m.get("path", "/")).decode())}
        if op == "put":
            with open(m["local"], "rb") as f:
                data = f.read()
            with self.raw() as t:
                d = os.path.dirname(m["remote"].rstrip("/"))
                parts = [p for p in d.split("/") if p]
                for i in range(1, len(parts) + 1):          # mkdir -p, in the same session
                    try:
                        t.fs_mkdir("/" + "/".join(parts[:i]))
                    except OSError:
                        pass
                t.fs_writefile(m["remote"], data, chunk_size=m.get("chunk", 1024))
            return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        if op == "get":
            with self.raw() as t:
                data = bytes(t.fs_readfile(m["remote"]))
            with open(m["local"], "wb") as f:
                f.write(data)
            return {"bytes": len(data)}
        if op == "rm":
            with self.raw() as t:
                t.fs_rmfile(m["path"])
            return {}
        if op == "run":
            # soft reset first (fresh VM like `mpremote run`), then stream output as events
            with self.lock:
                self.t.enter_raw_repl(soft_reset=m.get("reset", True))
                src = open(m["local"], "rb").read()
                self.t.exec_raw_no_follow(src)
                def consume(b):
                    self.emit({"ev": "out", "b64": base64.b64encode(b).decode()})
                try:
                    out, err = self.t.follow(timeout=m.get("timeout", 60), data_consumer=consume)
                except Exception as e:
                    return {"error": str(e)}
                finally:
                    if self.repl:
                        self.t.exit_raw_repl()
                return {"stderr": err.decode(errors="replace")}
        if op == "interrupt":
            self.t.serial.write(b"\r\x03\x03")          # no lock on purpose: must pre-empt
            return {}
        if op == "repl_open":
            with self.lock:
                self.t.serial.write(b"\r\x03\x03")
                time.sleep(0.05)
                self.t.serial.write(b"\r\x02")           # friendly REPL
                self.repl = True
            self.pump_thread = threading.Thread(target=self.pump, daemon=True)
            self.pump_thread.start()
            return {"mode": "repl"}
        if op == "repl_close":
            self.repl = False
            return {"mode": "idle"}
        if op == "repl_write":
            with self.lock:
                self.t.serial.write(base64.b64decode(m["b64"]))
            return {}
        raise ValueError("unknown op " + op)

    def serve(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            m = json.loads(line)
            if m["op"] in ("interrupt", "repl_write"):     # never queue behind a long op
                threading.Thread(target=self.dispatch, args=(m,), daemon=True).start()
            else:
                self.dispatch(m)

    def dispatch(self, m):
        try:
            r = self.handle(m)
            self.emit({"id": m.get("id"), "ok": True, **r})
        except TransportExecError as e:
            self.emit({"id": m.get("id"), "ok": False, "error": e.error_output.strip().splitlines()[-1]})
        except Exception as e:
            self.emit({"id": m.get("id"), "ok": False, "error": "%s: %s" % (type(e).__name__, e),
                       "tb": traceback.format_exc()})


if __name__ == "__main__":
    Bridge().serve()
