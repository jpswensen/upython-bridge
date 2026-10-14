"""Shared helpers for the adversarial ("break-it") tests. Never opens a serial port: only socket://127.0.0.1 fake boards."""
from __future__ import annotations

import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VENDOR = os.path.join(ROOT, "bridge", "vendor")
for _p in (ROOT, VENDOR):
    if _p in sys.path:
        sys.path.remove(_p)
    sys.path.insert(0, _p)
os.environ["MPY_SAFE_MODE"] = "1"

from bridge import devfs  # noqa: E402
from bridge.errors import BridgeError  # noqa: E402
from bridge.link import Link  # noqa: E402
from tools.fakeboard import FakeBoard  # noqa: E402

MPY_UNIX_BIN = os.environ.get("MPY_UNIX_BIN", "")


class Rig(object):
    """FakeBoard + Link + a bridge-like file-op driver (raw REPL session around devfs calls)."""

    def __init__(self, profile="esp32", faults=(), **fb_kw):
        self.board = FakeBoard(profile=profile, faults=faults, **fb_kw)
        self.link = Link()
        self.logs = []
        self.max_timeout = None

    def __enter__(self):
        self.board.start()
        return self

    def __exit__(self, *a):
        try:
            self.link.close()
        finally:
            self.board.stop()

    def connect(self):
        info = self.link.open(self.board.url)
        return info, self.link.sync_to_prompt(300, 300)

    def fs(self, fn, *args, **kw):
        """Run a devfs function the way the bridge's file-op handler must: raw REPL session, then back to friendly.
        Rig.max_timeout (seconds) caps every per-exec timeout so a corrupted line cannot stall a test for minutes."""
        link = self.link
        cap = self.max_timeout

        def exec_fn(code, timeout=10.0):
            return link.exec(code, timeout if cap is None else min(timeout, cap))

        with link.session():
            link.enter_raw(timeout=10.0 if cap is None else cap)
            try:
                return fn(exec_fn, *args, **kw)
            finally:
                try:
                    link.exit_raw()
                except BridgeError:
                    pass


class Proxy(object):
    """Loopback TCP man-in-the-middle between a Link and a FakeBoard. `mutate(direction, data) -> bytes`
    may corrupt traffic ("down" = board->host, "up" = host->board); `enabled` toggles it."""

    def __init__(self, upstream_port, mutate=None):
        import socket
        self.upstream_port = upstream_port
        self.mutate = mutate
        self.enabled = True
        self._stop = threading.Event()
        self._srv = socket.socket()
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", 0))
        self._srv.listen(2)
        self._srv.settimeout(0.1)
        self.port = self._srv.getsockname()[1]
        self.url = "socket://127.0.0.1:%d" % self.port
        self._socks = []
        self._threads = [threading.Thread(target=self._accept, name="proxy-accept", daemon=True)]
        self._threads[0].start()

    def _accept(self):
        import socket
        while not self._stop.is_set():
            try:
                c, _ = self._srv.accept()
            except (socket.timeout, OSError):
                continue
            try:
                u = socket.create_connection(("127.0.0.1", self.upstream_port), timeout=2)
            except OSError:
                c.close()
                continue
            self._socks += [c, u]
            for src, dst, direction in ((u, c, "down"), (c, u, "up")):
                t = threading.Thread(target=self._pipe, args=(src, dst, direction), name="proxy-pipe", daemon=True)
                self._threads.append(t)
                t.start()

    def _pipe(self, src, dst, direction):
        import socket
        src.settimeout(0.1)
        while not self._stop.is_set():
            try:
                data = src.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not data:
                break
            if self.mutate is not None and self.enabled:
                data = self.mutate(direction, data)
            try:
                if data:
                    dst.sendall(data)
            except OSError:
                break
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self):
        self._stop.set()
        for s in self._socks + [self._srv]:
            try:
                s.close()
            except OSError:
                pass
        for t in self._threads:
            t.join(1.0)
