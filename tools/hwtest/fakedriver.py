"""fakedriver.py - lets a FAKE board take a hard reset through the real bridge process (development and CI only).

A ``socket://`` URL has no DTR/RTS lines, so the bridge refuses a hard reset there unless a "line driver" is registered for the
URL (``bridge.link.register_line_driver``, the seam the reset-tier tests use).  The bridge is a child process of the harness while
the fake board lives in the harness process, so this module has two halves:

* ``PulseServer`` (harness process, ``run_hw.py --fake`` with phase R only): a loopback listener; one line ``pulse <method>`` makes
  it call ``FakeBoard.pulse(method)`` and answer ``ok 0|1`` (1 = the profile's wiring reset the chip).
* ``child_main`` (run as a script INSTEAD OF bridge/mpy_bridge.py by ``HwBridgeClient`` when a PulseServer exists): registers a
  line driver for the one fake board URL and then runs the unmodified bridge entry point.  It refuses anything that is not a
  ``socket://127.0.0.1:`` URL, so it cannot be pointed at a real device.

Nothing here is used for a real port.
"""
from __future__ import annotations

import os
import socket
import sys
import threading

__all__ = ["PulseServer", "child_main", "ENV_PORT", "ENV_URL", "ENV_USB"]

ENV_PORT = "MPY_FAKE_PULSE_PORT"
ENV_URL = "MPY_FAKE_PULSE_URL"
ENV_USB = "MPY_FAKE_PULSE_USB"           # "vid:pid" in hex, from the fake profile (the driver's usb_ids hint)


class PulseServer(object):
    """Harness side.  ``pulses`` lists the methods received (the fake board's own event log has the effect)."""

    def __init__(self, board):
        self.board = board
        self.pulses = []
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(2)
        self.port = self._sock.getsockname()[1]
        self._closed = False
        self._thread = threading.Thread(target=self._serve, name="hw-fake-pulse", daemon=True)
        self._thread.start()

    def child_env(self):
        usb = (self.board.profile.get("usb") or {})
        env = {ENV_PORT: str(self.port), ENV_URL: self.board.url}
        if usb.get("vid") is not None:
            env[ENV_USB] = "%x:%x" % (usb["vid"], usb["pid"])
        return env

    def _serve(self):
        while not self._closed:
            try:
                conn, _addr = self._sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), name="hw-fake-pulse-conn", daemon=True).start()

    def _handle(self, conn):
        try:
            conn.settimeout(10.0)
            data = b""
            while not data.endswith(b"\n") and len(data) < 200:
                chunk = conn.recv(64)
                if not chunk:
                    break
                data += chunk
            parts = data.decode("ascii", "replace").split()
            if len(parts) == 2 and parts[0] == "pulse" and parts[1] in ("rts-pulse", "usb-jtag"):
                self.pulses.append(parts[1])
                effect = bool(self.board.pulse(parts[1]))
                conn.sendall(b"ok 1\n" if effect else b"ok 0\n")
            else:
                conn.sendall(b"error\n")
        except (OSError, ValueError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def close(self):
        self._closed = True
        try:
            self._sock.close()
        except OSError:
            pass
        self._thread.join(2.0)


# --------------------------------------------------------------------------------------------------- bridge side
class _Driver(object):
    def __init__(self, port, usb):
        self._port = port
        self.usb_ids = usb

    def pulse(self, method, ser=None):
        with socket.create_connection(("127.0.0.1", self._port), timeout=10.0) as s:
            s.sendall(("pulse %s\n" % method).encode("ascii"))
            reply = b""
            while not reply.endswith(b"\n"):
                chunk = s.recv(64)
                if not chunk:
                    break
                reply += chunk
        if not reply.startswith(b"ok"):
            raise OSError("the fake board did not accept the pulse: %r" % reply)


def child_main():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    sys.path[:0] = [os.path.join(root, "bridge", "vendor"), root]
    url = os.environ.get(ENV_URL, "")
    port = os.environ.get(ENV_PORT, "")
    if not url.startswith("socket://127.0.0.1:") or not port.isdigit():
        sys.stderr.write("fakedriver: refusing to run: %s must be a socket://127.0.0.1: URL and %s a port number\n" % (ENV_URL, ENV_PORT))
        return 2
    usb = None
    if os.environ.get(ENV_USB):
        vid, pid = os.environ[ENV_USB].split(":")
        usb = (int(vid, 16), int(pid, 16))
    from bridge import link
    link.register_line_driver(url, _Driver(int(port), usb))
    import runpy
    runpy.run_path(os.path.join(root, "bridge", "mpy_bridge.py"), run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(child_main())
