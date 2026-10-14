"""mpy_bridge.py - entry point of the Python bridge (docs/protocol.md section 1).

Started by the extension as  python -I -u -X utf8 [-X pycache_prefix=DIR] bridge/mpy_bridge.py  (cwd = a neutral
folder). Under -I the script's folder and the cwd are NOT on sys.path, so this file builds the import path itself:
bridge/vendor first (pyserial), then the extension root (so `bridge` is a package). It reserves the protocol
channel BEFORE anything else is imported: fd 1 is duplicated for NDJSON and fd 1 itself is pointed at stderr, so a
stray print() from any library can never corrupt the stream. All behaviour lives in bridge/server.py.

    python bridge/mpy_bridge.py                       NDJSON server on stdin/stdout (the extension)
    python bridge/mpy_bridge.py --cli OP k=v ... [--port P]   one op, prints the response JSON (docs/protocol.md s.10)
    python bridge/mpy_bridge.py --script FILE.jsonl [--port P]   one request per line, same dispatch code

Exit codes: 0 clean, 2 fatal startup error (stderr + a final {"ev":"fatal"} line when the channel is up), 3 internal.
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_VENDOR = os.path.join(_HERE, "vendor")


def _reserve_protocol_fd():
    """Return a binary, unbuffered file object on a private duplicate of the original stdout."""
    fd = os.dup(1)
    os.dup2(2, 1)  # library prints now land on stderr
    if os.name == "nt":  # a dup'ed CRT descriptor may be in text mode: "\n" must stay "\n"
        try:
            import msvcrt

            msvcrt.setmode(fd, os.O_BINARY)
        except (ImportError, OSError):
            pass
    return os.fdopen(fd, "wb", buffering=0)


def _fatal(proto, message):
    sys.stderr.write("[error] %s\n" % message)
    sys.stderr.flush()
    if proto is not None:
        try:
            proto.write(('{"ev":"fatal","message":%s}\n' % _json_str(message)).encode("utf-8"))
        except Exception:  # the channel may already be gone; stderr has the message
            pass
    return 2


def _json_str(text):
    import json

    return json.dumps(text)


def main(argv):
    cli = "--cli" in argv or "--script" in argv
    proto = None if cli else _reserve_protocol_fd()
    try:
        sys.path[:0] = [_VENDOR, _ROOT]
        from bridge import server
    except Exception as exc:  # missing or broken file in the install
        return _fatal(proto, "cannot start the bridge: %s: %s" % (type(exc).__name__, exc))
    if cli:
        return server.cli_main(argv)
    return server.serve(proto)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
