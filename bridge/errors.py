"""errors.py - the bridge's error type and the classifier for port-open failures.

Contract: docs/protocol.md section 2 (error object) and the error-code list in section 3.
This module has no dependency on pyserial so any bridge module (and tests) can import it.

    BridgeError(code, message, detail=None, hint=None)
        .code     one of CODES
        .message  English, user-readable, says what happened
        .detail   raw cause (exception text, errno names, last bytes seen) - for the log channel
        .hint     what the user should do next (every code has a default hint)
        .to_dict() -> {"code", "message", "detail", "hint"}   (the protocol's error object)

    classify_open_error(exc, port=None) -> BridgeError
        Maps what pyserial/the OS raised while OPENING a port to E_PORT_BUSY, E_NO_DEVICE,
        E_PERMISSION or (unclassifiable) E_INTERNAL.

Classification rules (CLAUDE.md rule 9: never depend on English substrings of serial output)
-------------------------------------------------------------------------------------------
1. Walk the exception chain (the exception, then __cause__/__context__): pyserial's socket://
   handler and its POSIX open() both re-raise as SerialException, but the original OSError is
   still the __context__ and carries the errno.
2. If any exception in the chain has a `winerror` (Windows) that is in one of the two small
   tables, it wins: 5 (access denied), 32 (sharing violation) and 33 (lock violation) ->
   E_PORT_BUSY. Access denied is how Windows reports a COM port that another process has open
   [K]; 2/3 (file/path not found), 21, 31, 121 and 1167 -> E_NO_DEVICE. A winerror in NEITHER
   table (1260 policy, 1314 privilege, ...) does not decide anything: the errno that travels
   with it (Python translates every winerror to an errno; the pyserial text path carries it as
   the first number) goes through rule 3, so a PermissionError stays E_PERMISSION.
3. Otherwise `errno`: EBUSY/EAGAIN/EWOULDBLOCK (pyserial's flock failure, "Could not exclusively
   lock port") -> E_PORT_BUSY; ENOENT/ENXIO/ENODEV/ENOTDIR/EIO/ENOTTY and the network errors
   ECONNREFUSED/ECONNRESET/EHOSTUNREACH/ENETUNREACH/ETIMEDOUT (URL transports) -> E_NO_DEVICE;
   EACCES/EPERM -> E_PERMISSION.
4. DOCUMENTED TEXT FALLBACK (only when 1-3 found no number): pyserial's own Windows wording is
   "could not open port 'COM3': PermissionError(13, '<localised text>', None, 5)" - the message
   carries repr(OSError) with the numeric winerror in the 4th slot and the Python class name,
   neither of which is localised. We parse only those numbers/identifiers (never the English
   words), plus the "[Errno N]" / "[WinError N]" tokens that Python's own str(OSError) prints.
   pyserial's "Could not exclusively lock port" has no number when raised without an errno;
   that single known sentence of pyserial's is matched as a last resort.
"""
from __future__ import annotations

import errno as _errno
import re

CODES = (
    "E_PORT_BUSY",
    "E_NO_DEVICE",
    "E_PERMISSION",
    "E_RAW_REPL_TIMEOUT",
    "E_PROGRAM_RUNNING",
    "E_BOARD_RESET",
    "E_BOARD_UNRESPONSIVE",
    "E_FS_ERRNO",
    "E_LOCAL_IO",
    "E_SHADOWS_MODULE",
    "E_UNSUPPORTED",
    "E_CANCELLED",
    "E_PROTOCOL",
    "E_SAFE_MODE",
    "E_INTERNAL",
    "E_NOT_CONNECTED",
    "E_ALREADY_CONNECTED",
)

# Codes added after the v1 list was frozen (protocol-addendum-reset.md section 4; docs/protocol.md Appendix D).
# tests.test_link.ErrorsTests pins CODES to the v1 set, so they live in their own tuple; BridgeError accepts both.
# When that test's expected set grows, move the entries into CODES and delete this tuple.
CODES_V11 = (
    "E_RESET_NOT_OBSERVED",
    "E_DEST_CHANGED",
)

# What to do next, per code. Used when the raiser gives no more specific hint.
HINTS = {
    "E_PORT_BUSY": (
        "Close Thonny, the Arduino IDE or PlatformIO serial monitor, any other VS Code window "
        "and any terminal running mpremote or screen, then press Retry."
    ),
    "E_NO_DEVICE": (
        "Check that the board is plugged in with a data USB cable (some cables only charge), "
        "then pick the port again."
    ),
    "E_PERMISSION": (
        "On Linux add your user to the dialout group (sudo usermod -aG dialout $USER) and log "
        "in again. On macOS or Windows check that the USB driver is installed and that no "
        "other program is using the port."
    ),
    "E_RAW_REPL_TIMEOUT": (
        "The board did not answer like a MicroPython REPL. A running program may be ignoring "
        "Ctrl-C (for example a loop that catches KeyboardInterrupt), or the board is not "
        "running MicroPython. Press the board's reset button (or use Hardware reset) and try again."
    ),
    "E_PROGRAM_RUNNING": "A program is still running on the board. Press Stop first, or confirm that it may be interrupted.",
    "E_BOARD_RESET": "The board restarted. Wait for it to boot, then retry.",
    "E_BOARD_UNRESPONSIVE": (
        "The board stopped answering. Press Stop; if it still does not answer, press the "
        "board's reset button or use Hardware reset."
    ),
    "E_FS_ERRNO": "See the error name in the details; free space or fix the path, then retry.",
    "E_LOCAL_IO": "Check that the local file exists and is not open or locked by another program.",
    "E_SHADOWS_MODULE": "Rename the file; a module with this name is built into the board's firmware.",
    "E_UNSUPPORTED": "This is not available for this board or connection.",
    "E_CANCELLED": "The operation was cancelled.",
    "E_PROTOCOL": "The request or the board's answer was malformed; retry, and report it if it persists.",
    "E_SAFE_MODE": (
        "MPY_SAFE_MODE is set, which only allows test connections (socket:// to this machine). "
        "To allow one real port set MPY_REAL_PORT to exactly that port."
    ),
    "E_INTERNAL": "This is a bug in the extension; please report it with the details.",
    "E_NOT_CONNECTED": "Connect to a board first.",
    "E_ALREADY_CONNECTED": "Disconnect first, then connect again.",
    "E_DEST_CHANGED": (
        "The board's copy changed since the last sync, so it was not replaced. Compare the two copies and choose which "
        "one to keep."
    ),
    "E_RESET_NOT_OBSERVED": (
        "No sign of a reset was seen. The board may be hung or its reset wiring absent: press the board's EN/reset "
        "button or replug the USB cable."
    ),
}


class BridgeError(Exception):
    """Error with a stable protocol code. See the module docstring."""

    def __init__(self, code, message, detail=None, hint=None):
        if code not in CODES and code not in CODES_V11:
            # A typo must never make an error path raise something else.
            detail = "unknown error code %r%s" % (code, ("; " + detail) if detail else "")
            code = "E_INTERNAL"
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.detail = detail or ""
        self.hint = hint if hint is not None else HINTS.get(code, "")

    def to_dict(self):
        return {
            "code": self.code,
            "message": self.message,
            "detail": self.detail,
            "hint": self.hint,
        }

    def __str__(self):
        return "%s: %s" % (self.code, self.message)

    def __repr__(self):
        return "BridgeError(%r, %r, detail=%r)" % (self.code, self.message, self.detail)


# --------------------------------------------------------------------------- classification

_BUSY_WINERRORS = frozenset((5, 32, 33))
_NO_DEVICE_WINERRORS = frozenset((2, 3, 21, 31, 121, 1167))

_BUSY_ERRNOS = frozenset(
    e for e in (
        getattr(_errno, "EBUSY", None),
        getattr(_errno, "EAGAIN", None),
        getattr(_errno, "EWOULDBLOCK", None),
    ) if e is not None
)
_NO_DEVICE_ERRNOS = frozenset(
    e for e in (
        getattr(_errno, name, None)
        for name in (
            "ENOENT", "ENXIO", "ENODEV", "ENOTDIR", "EIO", "ENOTTY",
            "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH",
            "ETIMEDOUT", "EHOSTDOWN", "EADDRNOTAVAIL",
        )
    ) if e is not None
)
_PERMISSION_ERRNOS = frozenset(
    e for e in (getattr(_errno, "EACCES", None), getattr(_errno, "EPERM", None)) if e is not None
)

# Python class names that appear (unlocalised) inside pyserial's Windows messages.
_CLASSNAME_TO_CODE = {
    "FileNotFoundError": "E_NO_DEVICE",
    "NotADirectoryError": "E_NO_DEVICE",
    "ConnectionRefusedError": "E_NO_DEVICE",
    "ConnectionResetError": "E_NO_DEVICE",
    "TimeoutError": "E_NO_DEVICE",
    "PermissionError": "E_PERMISSION",
    "BlockingIOError": "E_PORT_BUSY",
}

# repr(OSError(errno, strerror, filename, winerror)) -> "...Error(13, 'Access is denied.', None, 5)"
# strerror may be single- or double-quoted (localised text can contain an apostrophe).
_RE_REPR_WINERROR = re.compile(
    r"\(\s*(\d+)\s*,\s*(?:'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")\s*,\s*"
    r"(?:None|'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")\s*,\s*(\d+)\s*\)"
)
_RE_REPR_ERRNO = re.compile(r"\b(\w+Error)\(\s*(\d+)\s*,")
_RE_STR_ERRNO = re.compile(r"\[Errno\s+(-?\d+)\]")
_RE_STR_WINERROR = re.compile(r"\[WinError\s+(\d+)\]")
# pyserial 3.5 serialposix.py: "Could not exclusively lock port {}: {}" (SerialException(errno, msg))
_PYSERIAL_LOCK_WORDING = "Could not exclusively lock port"


def _chain(exc, limit=8):
    seen = []
    cur = exc
    while cur is not None and len(seen) < limit and all(cur is not s for s in seen):
        seen.append(cur)
        cur = cur.__cause__ or cur.__context__
    return seen


def _errno_of(e):
    n = getattr(e, "errno", None)
    if isinstance(n, int):
        return n
    # termios.error is a plain Exception whose args are (errno, message)
    if type(e).__name__ == "error" and getattr(type(e), "__module__", "") == "termios":
        a = e.args
        if a and isinstance(a[0], int):
            return a[0]
    return None


def describe_exception(exc):
    """One line for the `detail` field: class, numbers, text."""
    parts = []
    for e in _chain(exc)[:3]:
        bits = [type(e).__name__]
        n = _errno_of(e)
        if n is not None:
            name = _errno.errorcode.get(n)
            bits.append("errno=%d%s" % (n, " (%s)" % name if name else ""))
        w = getattr(e, "winerror", None)
        if w is not None:
            bits.append("winerror=%s" % (w,))
        text = str(e)
        if text:
            bits.append(text)
        parts.append(" ".join(bits))
    return " <- ".join(parts)


def _numbers(exc):
    """(winerror, errno, source) found in the chain, preferring structured attributes.

    errno is returned NEXT TO winerror when both exist (Windows OSError carries both; the text
    form "PermissionError(13, '...', None, 1260)" carries the errno in its first slot), so a
    winerror outside the classification tables can fall through to the errno table."""
    chain = _chain(exc)
    for e in chain:
        w = getattr(e, "winerror", None)
        if isinstance(w, int):
            n = _errno_of(e)
            if n is None:
                for o in chain:
                    n = _errno_of(o)
                    if n is not None:
                        break
            return w, n, "attribute"
    for e in chain:
        n = _errno_of(e)
        if n is not None:
            return None, n, "attribute"
    # documented text fallback (module docstring, rule 4): numbers/identifiers only
    for e in chain:
        text = str(e)
        m = _RE_REPR_WINERROR.search(text)
        if m:
            return int(m.group(2)), int(m.group(1)), "text"
        m = _RE_STR_WINERROR.search(text)
        if m:
            m2 = _RE_STR_ERRNO.search(text)
            return int(m.group(1)), (int(m2.group(1)) if m2 else None), "text"
    for e in chain:
        text = str(e)
        m = _RE_STR_ERRNO.search(text)
        if m:
            return None, int(m.group(1)), "text"
    return None, None, None


def _make(code, port, detail):
    shown = port if port else "the serial port"
    if code == "E_PORT_BUSY":
        msg = "%s is in use by another program." % shown
    elif code == "E_NO_DEVICE":
        if port and "://" in port:
            msg = "Nothing is answering at %s." % shown
            return BridgeError(code, msg, detail=detail,
                               hint="Check that the server or fake board behind this address is running "
                                    "and that the address is right, then connect again.")
        msg = "No serial device was found at %s." % shown
    elif code == "E_PERMISSION":
        msg = "You do not have permission to open %s." % shown
    else:
        msg = "Could not open %s for an unexpected reason." % shown
    return BridgeError(code, msg, detail=detail)


def classify_open_error(exc, port=None):
    """Map an exception raised while opening `port` to a BridgeError. Never raises."""
    if isinstance(exc, BridgeError):
        return exc
    detail = describe_exception(exc)
    try:
        win, num, _src = _numbers(exc)
        if win is not None:
            if win in _BUSY_WINERRORS:
                return _make("E_PORT_BUSY", port, detail)
            if win in _NO_DEVICE_WINERRORS:
                return _make("E_NO_DEVICE", port, detail)
        if num is not None:
            if num in _BUSY_ERRNOS:
                return _make("E_PORT_BUSY", port, detail)
            if num in _PERMISSION_ERRNOS:
                return _make("E_PERMISSION", port, detail)
            if num in _NO_DEVICE_ERRNOS:
                return _make("E_NO_DEVICE", port, detail)
        if num is None:
            # last-resort identifiers from pyserial's / Python's own wording (also reached for a
            # winerror that is in neither table and came without an errno)
            for e in _chain(exc):
                text = str(e)
                if _PYSERIAL_LOCK_WORDING in text:
                    return _make("E_PORT_BUSY", port, detail)
                m = _RE_REPR_ERRNO.search(text)
                if m and m.group(1) in _CLASSNAME_TO_CODE:
                    return _make(_CLASSNAME_TO_CODE[m.group(1)], port, detail)
            # builtin subclasses carry their meaning in their type even without an errno
            for e in _chain(exc):
                if isinstance(e, FileNotFoundError):
                    return _make("E_NO_DEVICE", port, detail)
                if isinstance(e, PermissionError):
                    return _make("E_PERMISSION", port, detail)
    except Exception as inner:  # a classifier must never mask the original problem
        detail = "%s (classifier failed: %r)" % (detail, inner)
    return _make("E_INTERNAL", port, detail)
