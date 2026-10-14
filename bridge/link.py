"""link.py - the serial link ("C2" of D-02): the only code that opens a serial port.

Implements docs/protocol.md sections 5-8 on top of pyserial 3.5 (vendored). Nothing else is imported
at runtime (mpremote is an oracle for tests only). Python 3.9 .. 3.15, macOS / Windows / Linux.

PUBLIC INTERFACE (everything a caller needs; the bridge and devfs code against this)
-----------------------------------------------------------------------------------
    from bridge.link import Link, safe_mode_check, OPEN_POLICIES, select_policy
    from bridge.errors import BridgeError            # .code .message .detail .hint .to_dict()

    link = Link(raw_paste=None, log=None, serial_factory=None)
    info = link.open(port, baud=115200, policy="auto", usb_ids=None)  -> PortInfo dict
    link.close()                                       idempotent; policy close sequence; never resets
    link.is_open / link.mode / link.raw_paste_supported / link.port_info
    link.on_disconnect = callable(BridgeError)         called once when the link dies (unplug)

    link.sync_to_prompt(listen_ms=400, nudge_ms=400, on_data=None)
                          -> "prompt"|"prompt-unverified"|"running-program"|"silent"
    link.enter_raw(soft_reset=False, timeout=10.0, cancel=None)    -> bytes (boot.py output if soft_reset)
    link.exit_raw(timeout=2.0, redraw=None)                        -> bool (friendly prompt seen)
    link.exec(code, timeout=10.0, cancel=None)                     -> (out: bytes, err: bytes)
                                  E_BOARD_RESET (nothing sent) if the board reset under the session;
                                  E_CANCELLED (mode stays "raw", resynchronised) if a Stop came while the code was
                                  being submitted - the caller's cleanup exec can run at once
    link.exec_stream(code, on_out, timeout=None, cancel=None)      -> err: bytes
    link.session()                                     context manager: hold the port across several calls
    link.write(data) -> int                            bypass: only the tiny write lock (stop, tty.write)
    link.interrupt(timeout=3.0, presses=2, gap=0.05)   -> bool     Ctrl-C x2, True at the FIRST prompt (<200 ms);
                                  settling is deferred: the next op waits for the quiet deadline (see THREADING)
    link.read_available() -> bytes
    link.attach_repl(on_data) / link.detach_repl()     pump thread: repl bytes while idle
    link.soft_reset_friendly(wait=3.0, on_data=None)   -> "prompt"|"running-program"|"silent"  (Ctrl-D)
    link.hard_reset(confirm=RESET_CONFIRMED, wait=5.0, on_data=None, method=None, on_pulse=None)
                                                       -> same; E_UNSUPPORTED for URLs/pty without a line driver
    link.machine_reset(confirm=RESET_CONFIRMED)         -> {"ack", "dropped"}: `import machine; machine.reset()` through the raw REPL
    link.can_hard_reset()                              -> (bool, reason)
    link.check_alive()                                 cheap unplug watchdog (no data consumed)

Attributes: link.sync_bytes (bytes seen by the last sync_to_prompt / soft_reset_friendly / hard_reset) and
link.sync_evidence ("raw"|"banner"|"echo"|"" - why a "prompt" verdict was trusted; "" with "prompt-unverified"),
tunables link.stage_timeout=10.0 (exec handshake stages), link.interrupt_wait=1.0 (enter_raw: max wait for the
prompt after its Ctrl-C), link.raw_chunk=256 / link.raw_chunk_delay=0.01 (non-paste upload pacing).
usb_ids=(vid, pid) at open() comes from the bridge's ports.list; without it canHardReset is None (unknown)
until hard_reset() looks the adapter up (pyserial enumeration, metadata only, never an open).

TYPICAL FLOWS
    connect       open(port); sync_to_prompt(idleListenMs)                 -> state idle / running / unknown
    file op       with link.session(): enter_raw(); exec(...)...; exit_raw()      (pump paused, REPL restored)
    run           enter_raw(soft_reset=True); exec_stream(src, on_out); exit_raw()
    stop          interrupt()            (any thread; True: prompt back, False: program ignores Ctrl-C)
    tty.write     write(bytes)           (any thread; also forwards keystrokes to a running program)
    reset.soft    soft_reset_friendly() (skipMain: enter_raw(soft_reset=True); exit_raw()); reset.machine machine_reset(); reset.hard  hard_reset()
                  (the last two raise unless the caller passes the RESET_CONFIRMED token: protocol-addendum-reset.md)
    disconnect    close()

Errors are BridgeError with the protocol codes. Unplug / read / write errors raise E_NO_DEVICE
(detail has the raw cause), mark the link closed and call on_disconnect once; later calls raise
the same E_NO_DEVICE until close()/open(); a Link that was closed on purpose raises E_NOT_CONNECTED.

SAFETY INVARIANTS (RQ-SAFE-1, CLAUDE.md rule 5) - enforced here and pinned by tests
-----------------------------------------------------------------------------------
* safe_mode_check() runs before anything touches the OS in open().
* open / close / sync_to_prompt / enter_raw(soft_reset=False) / exit_raw never send Ctrl-D, never
  call machine.reset() and never pulse RTS/DTR. The only line writes in the whole module are the
  steps of the selected open/close policy and the hard_reset() pulse.
* sync_to_prompt sends nothing but one bare "\\r\\n" (only when the board was silent for the whole
  listen window): no Ctrl-C, no Ctrl-A.
* Ctrl-C is sent by enter_raw (once, like mpremote), interrupt() (twice) and write() (caller's bytes).
* Ctrl-D that RESETS is sent only by enter_raw(soft_reset=True), soft_reset_friendly(), and the caller's
  write(). exec() uses Ctrl-D solely as the end-of-code terminator after non-empty code (an empty
  program is sent as "pass" so an empty buffer can never become a soft reset), and only when the last
  prompt seen was not the friendly one (board reset under the session -> E_BOARD_RESET, nothing sent) and
  no Ctrl-C went out while the code was being submitted (Stop -> E_CANCELLED, terminator not sent).
* A friendly-prompt-shaped tail is not proof of an idle REPL (a program in input('>>> ') ends the same way):
  sync_to_prompt answers "prompt-unverified" unless there is banner/echo/raw evidence.

THREADING MODEL
---------------
* ONE op owner at a time. Every operation that talks to the board in request/response fashion
  (sync_to_prompt, enter_raw, exit_raw, exec, exec_stream, read_available, soft_reset_friendly,
  hard_reset) takes the op lock (an RLock, so ops compose; session() holds it across several).
  The op owner is the only reader.
* ONE place reads the serial object: Link._read_chunk (also updates the prompt detector). It must
  be called with the op lock held. Nothing else calls ser.read / ser.in_waiting for data.
* The pump thread (attach_repl) takes the op lock for one short read at a time, so it reads only
  when the REPL is attached and no op is running; it steps aside within one read slice (20 ms)
  when an op is waiting. Its bytes go to the on_data callback (the bridge turns them into `repl`
  events).
* write() takes only the tiny write lock, never the op lock: Stop and keystroke forwarding reach
  the board while an op (a running program!) holds the port.
* STOP vs. THE OP THAT IS BEING STOPPED. A Stop is two Ctrl-C bytes 50 ms apart; the thread whose program
  the first one ended usually starts its next exec (devfs: the cleanup that removes the .mpytmp file) before
  the second arrives. Therefore (1) interrupt() records a quiet deadline (last Ctrl-C + settle) BEFORE the
  first byte is written and replies at the first prompt; (2) every op that is about to write (exec,
  enter_raw, exit_raw, sync_to_prompt, soft_reset_friendly) first waits for that deadline, discarding what
  the board says meanwhile; (3) every Ctrl-C written is counted under the write lock, and code that is
  half way through being submitted stops, without its terminating Ctrl-D, when the count moved
  (E_CANCELLED; a Ctrl-C clears the board's input buffer and Ctrl-D on an empty buffer is a soft reset),
  then re-confirms the raw prompt with Ctrl-A so the Link stays usable for the next exec.
* interrupt() writes Ctrl-C x2 through write(), then waits for a prompt. If another thread is
  reading (op owner or pump) it waits on the prompt condition that _read_chunk signals; if nobody
  is reading it takes the op lock itself and reads. Do not call it from inside an on_out callback.
* close() sets a closing flag (reads stop within one slice), stops the pump, waits up to 1 s for
  the op owner, runs the policy close steps, releases the port.

OPEN / CLOSE POLICY TABLE (protocol section 7; the table is data - see OPEN_POLICIES)
-------------------------------------------------------------------------------------
    default     POSIX and "other" Windows. Open = serial.Serial defaults (pyserial asserts DTR and RTS
                itself; do NOT pre-set them low). Close = RTS=0, DTR=0, close.
                [E] CP2102 + class board: 0/2 resets; forcing DTR/RTS low first and mpremote's CP210x
                sequence reset the chip 2/2 (spikes-and-questions.md, hardware session 1).
    win-cp210x  mpremote 1.29 transport_serial.py:70-85 sequence: dtr=0, rts=0, open, dtr=1, rts=1.
                Selectable by name only. NOT auto-selected until verified on Windows
                (docs/spikes-and-questions.md S-08 [U]); flip AUTO_SELECT_WIN_CP210X after S-08.
    pty         ptys (/dev/ttysN, /dev/pts/N): default open, ordered close, ENOTTY/EINVAL tolerated.
    url         socket:// rfc2217:// loop://: default open, plain close() (no modem-line writes: an
                rfc2217 server would forward them to a real device), tolerant.

ATTRIBUTION (see THIRD_PARTY_NOTICES)
-------------------------------------
The raw-REPL entry sequence (Ctrl-C, Ctrl-A, "raw REPL; CTRL-B to exit", Ctrl-D soft reset), the raw-paste
flow-control algorithm and the Windows CP210x open sequence / RTS-then-DTR close order follow mpremote 1.29.0
`transport_serial.py` (MIT, Copyright (c) 2014-2021 Damien P. George, (c) 2017 Paul Sokolovsky,
(c) 2023 Jim Mussared). The code here is a re-implementation with different timeouts, cancellation and threading.
"""
from __future__ import annotations

import contextlib
import errno as _errno
import ipaddress
import os
import re
import struct
import sys
import threading
import time
from urllib.parse import urlsplit

_VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)  # the bridge runs with -I: pyserial must come from vendor/

import serial  # noqa: E402  (vendored pyserial 3.5)

try:  # imported as bridge.link
    from .errors import BridgeError, classify_open_error, describe_exception
except ImportError:  # imported as top-level `link` with bridge/ itself on sys.path
    from errors import BridgeError, classify_open_error, describe_exception  # type: ignore

__all__ = [
    "Link", "BridgeError", "safe_mode_check", "safe_mode_active", "allow_harness_pty",
    "OPEN_POLICIES", "select_policy", "port_kind", "normalize_port", "lookup_usb_ids",
    "AUTO_SELECT_WIN_CP210X", "RESET_CONFIRMED", "USB_JTAG_RESET_STEPS", "register_line_driver", "unregister_line_driver",
]

CTRL_A = b"\x01"
CTRL_B = b"\x02"
CTRL_C = b"\x03"
CTRL_D = b"\x04"
CTRL_E = b"\x05"
RAW_BANNER = b"raw REPL; CTRL-B to exit\r\n"
RAW_PROMPT = RAW_BANNER + b">"
FRIENDLY_PROMPT = b">>> "
READ_SLICE = 0.02
SETTLE_S = 0.04          # after a prompt: let a trailing prompt from the second Ctrl-C arrive

# ----------------------------------------------------------------------------- policy table

AUTO_SELECT_WIN_CP210X = False  # docs/spikes-and-questions.md S-08 [U]: keep False until verified

OPEN_POLICIES = {
    "default": {
        "open": ("open",),
        "close": ("rts=0", "dtr=0", "close"),
        "tolerate": False,
        "evidence": "[E] macOS CP2102: 0/2 resets (hardware session 1); mpremote 1.29 close order",
    },
    "win-cp210x": {
        "open": ("dtr=0", "rts=0", "open", "dtr=1", "rts=1"),
        "close": ("rts=0", "dtr=0", "close"),
        "tolerate": False,
        "evidence": "[S] mpremote 1.29 transport_serial.py:70-85; Windows effect [U] (S-08); "
                    "on macOS+CP2102 it reset the chip 2/2 [E]",
    },
    "pty": {
        "open": ("open",),
        "close": ("rts=0", "dtr=0", "close"),
        "tolerate": True,
        "evidence": "[S] mpremote tolerates ENOTTY for QEMU/pty modem lines",
    },
    "url": {
        "open": ("open",),
        "close": ("close",),
        "tolerate": True,
        "evidence": "[S] pyserial socket:// ignores modem lines; rfc2217 would forward them",
    },
}

# USB-UART bridges that normally sit behind an EN/IO0 auto-reset circuit (esptool HardReset works).
AUTO_RESET_USB_BRIDGES = {0x10C4: "CP210x", 0x1A86: "CH340/CH343/CH9102", 0x0403: "FTDI"}
# esptool HardReset: DTR low (IO0 high) throughout, RTS high (EN low) ~100 ms, RTS low.
HARD_RESET_STEPS = ("dtr=0", "rts=1", "sleep=0.1", "rts=0")
# Method "usb-jtag" (resetcap.METHODS). DTR (IO0) stays LOW in both sequences: esptool's classic and USBJTAGSerialReset
# sequences assert IO0 while EN is released, i.e. they enter the ROM bootloader ("waiting for download"), which is not
# a reset. "usb-jtag" therefore uses esptool's HardReset(uses_usb_otg=True) timing: a longer EN pulse the
# USB-Serial/JTAG peripheral can follow. [S] esptool reset.py; [U] on hardware.
USB_JTAG_RESET_STEPS = ("dtr=0", "rts=1", "sleep=0.2", "rts=0", "sleep=0.2")


class _ResetConfirmed(object):
    """The type of RESET_CONFIRMED. A reset tier above soft is sent only when the caller hands over THE token object (not
    True, not 1): a reviewer can grep for every place that has it, and a stray truthy variable cannot reset a board."""

    def __repr__(self):
        return "RESET_CONFIRMED"


RESET_CONFIRMED = _ResetConfirmed()

# Test seam for the control lines: {port string: driver}. A driver has `pulse(method, ser)` (and optionally `usb_ids`,
# a (vid, pid) pair the capability estimator should use) and STANDS IN for DTR/RTS, so a fake board can simulate the
# pulse without modem lines (a socket:// URL has none). Without a driver, hard reset on url/pty ports is E_UNSUPPORTED.
_LINE_DRIVERS = {}
_LINE_DRIVERS_LOCK = threading.Lock()


def register_line_driver(port, driver):
    with _LINE_DRIVERS_LOCK:
        _LINE_DRIVERS[port] = driver


def unregister_line_driver(port):
    with _LINE_DRIVERS_LOCK:
        _LINE_DRIVERS.pop(port, None)

_PTY_RE = re.compile(r"^/dev/(?:ttys\d+|pts/\d+)$")
# What an idle friendly REPL answers to our bare "\r\n": newlines and prompts, nothing else.
_NUDGE_ECHO = re.compile(rb"\r?\n(?:\r?\n|>>> )*")


def port_kind(port):
    """'url' | 'pty' | 'device' for a port string (pure)."""
    if "://" in port:
        return "url"
    if _PTY_RE.match(port):
        return "pty"
    return "device"


def normalize_port(port, platform=None):
    """macOS: /dev/tty.X -> /dev/cu.X (08-mpremote-research.md failure #5). Pure."""
    platform = platform or sys.platform
    if platform == "darwin" and port.startswith("/dev/tty."):
        return "/dev/cu." + port[len("/dev/tty."):]
    return port


def select_policy(requested="auto", kind="device", platform=None, vid=None):
    """Pick an OPEN_POLICIES name. Pure; `requested` other than "auto" must be a table key."""
    platform = platform or sys.platform
    if requested not in (None, "", "auto"):
        if requested not in OPEN_POLICIES:
            raise BridgeError(
                "E_PROTOCOL", "Unknown open policy %r." % (requested,),
                detail="known policies: %s" % ", ".join(sorted(OPEN_POLICIES)),
                hint="Use \"auto\" or one of: %s." % ", ".join(sorted(OPEN_POLICIES)),
            )
        return requested
    if kind == "url":
        return "url"
    if kind == "pty":
        return "pty"
    if AUTO_SELECT_WIN_CP210X and platform.startswith("win") and vid == 0x10C4:
        return "win-cp210x"
    return "default"


def _com_key(name):
    """Canonical form of a Windows COM name: COM names are case-insensitive and the Win32 device
    namespace spelling \\\\.\\COM3 names the same port as COM3. Other names are returned unchanged."""
    n = name
    if n.startswith("\\\\.\\"):
        n = n[4:]
    return n.upper() if n.upper().startswith("COM") else name


def _held_key(port):
    """Registry key: COM names are case-insensitive on Windows."""
    return _com_key(port)


def _check_url(port):
    """socket:// and rfc2217:// need host:port; pyserial only notices at connect time with a vague error."""
    scheme = port.split("://", 1)[0].lower()
    if scheme not in ("socket", "rfc2217"):
        return
    try:
        parts = urlsplit(port)
        ok = bool(parts.hostname) and parts.port is not None and 0 < parts.port < 65536
    except ValueError:
        ok = False
    if not ok:
        raise BridgeError(
            "E_PROTOCOL", "The address %s is not host:port." % port,
            hint="Use the form %s://127.0.0.1:PORT." % scheme)


def lookup_usb_ids(device):
    """(vid, pid) of `device` from pyserial's port enumeration, or None. Metadata only: never opens."""
    try:
        from serial.tools import list_ports
        want = _com_key(device)
        for p in list_ports.comports():
            if p.device == device or _com_key(p.device or "") == want:
                return (p.vid, p.pid)
    except Exception:  # enumeration is best effort; callers treat None as "unknown adapter"
        return None
    return None


# ----------------------------------------------------------------------------- safe mode (section 8)

_HARNESS_PTYS = set()
_HELD = set()
_HELD_LOCK = threading.Lock()


def safe_mode_active(environ=None):
    env = os.environ if environ is None else environ
    v = env.get("MPY_SAFE_MODE")
    if v is None:
        return False
    return v.strip().lower() not in ("", "0", "false", "no", "off")


def allow_harness_pty(path):
    """Test harness: declare a pty it created so safe mode lets Link open it."""
    if not _PTY_RE.match(path):
        raise ValueError("not a pty device path: %r" % (path,))
    _HARNESS_PTYS.add(path)


def _url_is_safe(port):
    """True only for loop:// and for socket:// / rfc2217:// URLs whose host IS this machine.

    The host is the one pyserial will connect to: its socket and rfc2217 handlers use
    urllib.parse.urlsplit(url).hostname, so this does too. A '@' anywhere in the authority is
    refused (userinfo makes a prefix test lie: socket://127.0.0.1@lab-pc:23 connects to lab-pc).
    Only the name 'localhost' or a literal loopback IP address is accepted; nothing is resolved
    (127.attacker.example and 127.1 are not loopback literals)."""
    scheme = port.partition("://")[0].lower()
    if scheme == "loop":
        return True
    if scheme not in ("socket", "rfc2217"):
        return False  # spy:// alt:// hwgrep:// cp2110:// resolve to real devices
    try:
        parts = urlsplit(port)
        host = parts.hostname  # a malformed port is _check_url's business (E_PROTOCOL), not the host's
    except ValueError:
        return False
    if not host or "@" in parts.netloc:
        return False
    if host == "localhost":  # urlsplit lower-cases the hostname
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def safe_mode_check(port, environ=None):
    """Protocol section 8. Raises E_SAFE_MODE before any open call; returns None when allowed."""
    env = os.environ if environ is None else environ
    if not safe_mode_active(env):
        return
    real = env.get("MPY_REAL_PORT", "")
    if real and real.strip().lower() != "auto" and real == port:
        return
    if "://" in port:
        if _url_is_safe(port):
            return
    elif _PTY_RE.match(port):
        extra = [p for p in env.get("MPY_HARNESS_PTYS", "").split(os.pathsep) if p]
        if port in _HARNESS_PTYS or port in extra:
            return
    raise BridgeError(
        "E_SAFE_MODE",
        "Safe mode is on (MPY_SAFE_MODE=1): refusing to open %s." % port,
        detail="MPY_REAL_PORT=%r does not equal the requested port exactly" % real,
        hint="Only socket://127.0.0.1:PORT fake boards and harness ptys are allowed. To open one real "
             "port on purpose set MPY_REAL_PORT to exactly that port (never \"auto\").",
    )


# ----------------------------------------------------------------------------- the Link

class _SubmissionInterrupted(BridgeError):
    """E_CANCELLED raised by Link._send_code when a Ctrl-C (Stop) went out while code was being submitted."""


class Link(object):
    """Serial link to one MicroPython board. See the module docstring for the full contract."""

    def __init__(self, raw_paste=None, log=None, serial_factory=None, read_slice=READ_SLICE):
        self._factory = serial_factory or serial.serial_for_url
        self._log_cb = log
        self.read_slice = float(read_slice)
        self.stage_timeout = 10.0       # handshake stages of exec (paste probe, "OK", window, EOFs)
        self.raw_chunk = 256            # non-paste raw exec: mpremote writes 256 bytes ...
        self.raw_chunk_delay = 0.01     # ... every 10 ms (the REPL's stdin buffer is small)
        self.interrupt_wait = 1.0       # enter_raw: max wait for the prompt after its Ctrl-C
        self.raw_paste_pref = raw_paste  # None/True: probe once per session; False: never use raw paste
        self.on_disconnect = None

        self._state_lock = threading.RLock()
        self._op_lock = threading.RLock()
        self._wlock = threading.Lock()
        self._cv = threading.Condition(threading.Lock())
        self._waiting = 0               # ops waiting for the op lock (guarded by _cv)
        self._ser = None
        self._reset_session_state()
        self._tap = None
        self._pump = None
        self._pump_stop = threading.Event()

    # ------------------------------------------------------------------ small helpers

    def _log(self, level, msg):
        cb = self._log_cb
        if cb is not None:
            try:
                cb(level, msg)
            except Exception:  # a broken logger must not break the link
                pass

    def _reset_session_state(self):
        self._port = None
        self._kind = None
        self._policy_name = None
        self._usb_ids = None
        self._info = None
        self._dead_error = None
        self._closing = False
        self._mode = "unknown"
        self._paste = None if self.raw_paste_pref is not False else False
        self._need_prompt = False
        self._in_exec = False
        self._fast_sock = None
        self._pushback = bytearray()
        self._tail = b""
        self._prompt_gen = 0
        self._last_prompt = None        # "friendly" | "raw" | None: kind of the last prompt the detector saw
        self._quiet_until = 0.0         # monotonic: a Stop (interrupt()) is still settling; see _wait_quiet
        self._ctrl_c_count = 0          # Ctrl-C bytes written so far (guarded by _wlock); see _write_unless_stopped
        self.sync_bytes = b""
        self.sync_evidence = ""

    @property
    def is_open(self):
        return self._ser is not None and self._dead_error is None and not self._closing

    @property
    def mode(self):
        """'friendly' | 'raw' | 'unknown' (best knowledge of the REPL mode; resets to unknown on error)."""
        return self._mode

    @property
    def raw_paste_supported(self):
        """None until probed, then True/False."""
        return self._paste

    @property
    def port_info(self):
        return dict(self._info) if self._info else None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def _alive_ser(self):
        e = self._dead_error
        if e is not None:
            raise BridgeError(e.code, e.message, e.detail, e.hint)
        ser = self._ser
        if ser is None or self._closing:
            raise BridgeError("E_NOT_CONNECTED", "No board is connected.")
        return ser

    # ------------------------------------------------------------------ open / close

    def open(self, port, baud=115200, policy="auto", usb_ids=None):
        """Open `port` once and keep it. Never resets the board. Returns the PortInfo dict."""
        if not isinstance(port, str) or not port:
            raise BridgeError("E_PROTOCOL", "A port name is required.", hint="Pick a port from the list.")
        safe_mode_check(port)  # BEFORE anything that could touch a device node
        with self._state_lock:
            if self.is_open:
                raise BridgeError("E_ALREADY_CONNECTED", "Already connected to %s." % self._port)
            self._reset_session_state()
            norm = normalize_port(port)
            kind = port_kind(norm)
            if kind == "url":
                _check_url(norm)
            vid, pid = (usb_ids if usb_ids else (None, None))
            pol_name = select_policy(policy, kind, sys.platform, vid)
            pol = OPEN_POLICIES[pol_name]
            held = _held_key(norm)
            with _HELD_LOCK:
                if held in _HELD:
                    raise BridgeError(
                        "E_PORT_BUSY", "%s is already open in this program." % norm,
                        detail="held by another Link instance in this process",
                    )
                _HELD.add(held)
            ser = None
            try:
                try:
                    ser = self._factory(
                        norm, do_not_open=True, baudrate=baud, timeout=self.read_slice,
                        write_timeout=5.0, exclusive=True,
                    )
                except ValueError as exc:  # serial_for_url: unknown URL scheme
                    raise BridgeError(
                        "E_PROTOCOL", "Unsupported port address %r." % norm,
                        detail=describe_exception(exc),
                        hint="Use a device name such as COM3 or /dev/cu.usbserial-0001, or a socket:// URL.",
                    )
                self._ser = ser
                for step in pol["open"]:
                    self._apply_step(ser, step, pol["tolerate"], strict=True)
            except BaseException as exc:
                self._ser = None
                with _HELD_LOCK:
                    _HELD.discard(held)
                if ser is not None:
                    try:
                        ser.close()
                    except Exception as cexc:
                        self._log("debug", "close after failed open: %s" % describe_exception(cexc))
                if isinstance(exc, BridgeError):
                    raise
                if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                    raise
                raise classify_open_error(exc, norm)
            sock = getattr(ser, "_socket", None) if kind == "url" else None
            self._fast_sock = sock if (sock is not None and hasattr(sock, "recv")) else None
            adapter = AUTO_RESET_USB_BRIDGES.get(vid) if vid is not None else None
            self._port, self._kind, self._policy_name, self._usb_ids = norm, kind, pol_name, (vid, pid)
            self._info = {
                "port": norm, "requested": port, "baud": baud, "kind": kind, "policy": pol_name,
                "platform": sys.platform, "pyserial": getattr(serial, "__version__", "?"),
                "vid": vid, "pid": pid, "adapter": adapter, "exclusive": True,
                "canHardReset": self.can_hard_reset(lookup=False)[0],
            }
            return dict(self._info)

    def _apply_step(self, ser, step, tolerate, strict):
        """Run one policy step. strict=True (open): errors propagate; False (close): logged."""
        try:
            if step == "open":
                ser.open()
            elif step == "close":
                ser.close()
            elif step.startswith("sleep="):
                time.sleep(float(step[6:]))
            else:
                name, val = step.split("=")
                setattr(ser, name, bool(int(val)))
        except (OSError, serial.SerialException) as exc:
            num = getattr(exc, "errno", None)
            benign = num in (getattr(_errno, "ENOTTY", None), getattr(_errno, "EINVAL", None),
                             getattr(_errno, "ENOSYS", None), getattr(_errno, "EOPNOTSUPP", None))
            if step == "open" or (strict and not (tolerate and benign)):
                raise
            self._log("debug" if (tolerate and benign) else "warn",
                      "policy step %s failed: %s" % (step, describe_exception(exc)))

    def close(self):
        """Close with the policy's close sequence. Idempotent. Never sends anything to the program."""
        self._closing = True
        self._tap = None
        try:
            self._stop_pump(join=True)
            got = self._op_lock.acquire(timeout=1.0)
            try:
                self._close_serial()
            finally:
                if got:
                    self._op_lock.release()
        finally:
            with self._state_lock:
                self._reset_session_state()
            with self._cv:
                self._cv.notify_all()

    def _close_serial(self):
        with self._state_lock:
            ser, self._ser = self._ser, None
            port, pol_name = self._port, self._policy_name
        if ser is None:
            return
        pol = OPEN_POLICIES.get(pol_name or "default", OPEN_POLICIES["default"])
        # pyserial 3.5's socket:// close() skips socket.close() when shutdown() raises (peer already
        # gone), leaking the descriptor; keep a handle so we can finish the job.
        leftover = getattr(ser, "_socket", None) if self._kind == "url" else None
        try:
            if getattr(ser, "is_open", True):
                for step in pol["close"]:
                    self._apply_step(ser, step, pol["tolerate"], strict=False)
        finally:
            try:
                if getattr(ser, "is_open", False):
                    ser.close()  # guarantees the port is released even if a policy step failed
                if leftover is not None:
                    leftover.close()
            except Exception as exc:
                self._log("warn", "close: %s" % describe_exception(exc))
            if port:
                with _HELD_LOCK:
                    _HELD.discard(_held_key(port))

    # ------------------------------------------------------------------ failure handling

    def _io_failure(self, op, exc, ser):
        """Turn an exception from a serial call into a BridgeError; mark the link dead if it was lost."""
        if isinstance(exc, serial.SerialTimeoutException):
            return BridgeError(
                "E_BOARD_UNRESPONSIVE", "The board is not accepting data.",
                detail="%s timed out: %s" % (op, describe_exception(exc)),
            )
        if self._closing or self._ser is not ser or isinstance(exc, serial.PortNotOpenError):
            return BridgeError("E_NOT_CONNECTED", "The port was closed.", detail=describe_exception(exc))
        if not isinstance(exc, OSError):  # SerialException is an OSError; anything else is our bug
            return BridgeError("E_INTERNAL", "Unexpected error talking to the serial port.",
                               detail="%s failed: %s" % (op, describe_exception(exc)))
        err = BridgeError(
            "E_NO_DEVICE",
            "The connection to the board was lost (the USB cable was unplugged, or the board "
            "re-enumerated).",
            detail="%s failed: %s" % (op, describe_exception(exc)),
            hint="Check the cable, then reconnect.",
        )
        self._mark_dead(err)
        return err

    def _mark_dead(self, err):
        with self._state_lock:
            if self._dead_error is not None:
                return
            self._dead_error = err
        self._close_serial()
        with self._cv:
            self._cv.notify_all()
        cb = self.on_disconnect
        if cb is not None:
            try:
                cb(err)
            except Exception as exc:
                self._log("warn", "on_disconnect callback failed: %s" % describe_exception(exc))

    def check_alive(self):
        """Cheap unplug watchdog: asks the driver for the input-queue size, consumes nothing."""
        ser = self._alive_ser()
        try:
            ser.in_waiting
        except Exception as exc:
            raise self._io_failure("check", exc, ser)
        return True

    # ------------------------------------------------------------------ writing (bypass)

    def write(self, data, _own=False):
        """Write raw bytes to the board. Serialised by the tiny write lock only (never the op lock).

        A Ctrl-C in `data` is counted (an op that is half way through submitting code notices it and
        stops before its terminating Ctrl-D, see _write_unless_stopped) and, unless it is the Link's own
        (enter_raw), opens a short quiet period so the next op does not run into a second Ctrl-C."""
        if isinstance(data, str):
            data = data.encode("utf-8")
        ser = self._alive_ser()
        with self._wlock:
            if CTRL_C in data:
                self._ctrl_c_count += 1
            try:
                n = ser.write(data)
            except Exception as exc:
                raise self._io_failure("write", exc, ser)
        if CTRL_C in data and not _own:
            self._extend_quiet(0.05 + SETTLE_S)
        return n

    def _write_unless_stopped(self, data, count0):
        """Write part of a program that is being submitted, unless a Ctrl-C went out since the submission began.
        The check and the write are atomic with respect to write(): either the Ctrl-C reaches the board first
        (this raises and nothing more is sent) or the code was already complete. Without it a Stop in the middle of
        a chunked submission clears the board's input buffer and the final Ctrl-D then lands on an EMPTY raw
        buffer, which is a soft reset (RQ-SAFE-1)."""
        ser = self._alive_ser()
        with self._wlock:
            if self._ctrl_c_count != count0:
                raise _SubmissionInterrupted(
                    "E_CANCELLED", "Stopped while the code was being sent to the board.",
                    detail="a Ctrl-C was written during the submission; the rest was not sent")
            try:
                return ser.write(data)
            except Exception as exc:
                raise self._io_failure("write", exc, ser)

    # ------------------------------------------------------------------ the single reader

    def _read_chunk(self, max_wait=None, cancel=None):
        """THE place that reads the serial object. Op lock must be held. Returns b"" on timeout.

        Blocks up to max_wait seconds (None = one read slice; 0 = never block) for the first byte,
        then greedily takes what is already queued. Updates the prompt detector."""
        if self._pushback:
            data = bytes(self._pushback)
            del self._pushback[:]
            return data
        if max_wait is None:
            max_wait = self.read_slice
        deadline = time.monotonic() + max_wait
        while True:
            ser = self._alive_ser()
            if cancel is not None and cancel.is_set():
                raise BridgeError("E_CANCELLED", "The operation was cancelled.")
            try:
                n = ser.in_waiting
                if n <= 0 and max_wait <= 0:
                    return b""
                data = ser.read(n if n > 0 else 1)
                if data:
                    sock = self._fast_sock
                    if sock is not None:
                        # pyserial's socket:// in_waiting is 0/1, so draining through it costs one call
                        # per byte (fake boards, relays). The socket is non-blocking: take the rest at once.
                        while len(data) <= 65536:
                            try:
                                more = sock.recv(65536)
                            except (BlockingIOError, InterruptedError):
                                break
                            if not more:
                                break  # EOF: the next ser.read() raises the proper "disconnected" error
                            data += more
                    else:
                        for _ in range(256):
                            n = ser.in_waiting
                            if n <= 0 or len(data) > 65536:
                                break
                            data += ser.read(n)
            except Exception as exc:
                raise self._io_failure("read", exc, ser)
            if data:
                self._observe(data)
                return data
            if time.monotonic() >= deadline:
                return b""

    def _observe(self, data):
        """Prompt detector, fed by _read_chunk only. Wakes interrupt() waiters."""
        with self._cv:
            self._tail = (self._tail + data)[-64:]
            t = self._tail
            if t.endswith(FRIENDLY_PROMPT):
                self._last_prompt = "friendly"
            elif t.endswith(RAW_PROMPT) or t.endswith(b"\x04>"):
                self._last_prompt = "raw"
            else:
                return
            self._prompt_gen += 1
            self._cv.notify_all()

    def _unread(self, data):
        if data:
            self._pushback[:0] = data

    @staticmethod
    def _prompt_kind(buf):
        if buf.endswith(FRIENDLY_PROMPT):
            return "friendly"
        if buf.endswith(RAW_PROMPT) or buf.endswith(b"\x04>"):
            return "raw"
        return None

    def _expect(self, marker, timeout, cancel=None, stage="", code="E_RAW_REPL_TIMEOUT"):
        """Read until `marker` appears anywhere; return the bytes before it; bytes after go back."""
        buf = bytearray()
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            data = self._read_chunk(max(0.0, min(0.25, left)), cancel)
            if data:
                start = max(0, len(buf) - len(marker) + 1)
                buf += data
                i = buf.find(marker, start)
                if i >= 0:
                    self._unread(bytes(buf[i + len(marker):]))
                    return bytes(buf[:i])
                if len(buf) > (1 << 20):
                    del buf[:-8192]
            elif left <= 0:
                raise self._timeout_error(stage, code, timeout, bytes(buf[-200:]))

    def _try_expect(self, marker, timeout, cancel=None):
        """Like _expect but a timeout is a normal outcome (False) and leaves the mode untouched."""
        saved = self._mode
        try:
            self._expect(marker, timeout, cancel, "", code="E_BOARD_UNRESPONSIVE")
            return True
        except BridgeError as exc:
            if exc.code != "E_BOARD_UNRESPONSIVE":
                raise
            self._mode = saved
            return False

    def _read_exact(self, n, timeout, cancel=None, stage="", code="E_BOARD_UNRESPONSIVE"):
        buf = bytearray()
        deadline = time.monotonic() + timeout
        while len(buf) < n:
            left = deadline - time.monotonic()
            data = self._read_chunk(max(0.0, min(0.25, left)), cancel)
            if data:
                buf += data
            elif left <= 0:
                raise self._timeout_error(stage, code, timeout, bytes(buf))
        if len(buf) > n:
            self._unread(bytes(buf[n:]))
            del buf[n:]
        return bytes(buf)

    def _timeout_error(self, stage, code, timeout, seen):
        self._mode = "unknown"
        detail = "timed out after %.1fs waiting for %s; last bytes seen: %r" % (timeout, stage or "the board", seen)
        if code == "E_RAW_REPL_TIMEOUT":
            return BridgeError(
                "E_RAW_REPL_TIMEOUT",
                "Could not get the board into raw REPL mode.",
                detail=detail,
                hint="A running program may be ignoring Ctrl-C (for example a loop that catches "
                     "KeyboardInterrupt), or the board is not running MicroPython. Press the "
                     "board's reset button (or use Hardware reset) and try again.",
            )
        return BridgeError("E_BOARD_UNRESPONSIVE", "The board stopped answering.", detail=detail)

    def _discard_pending(self):
        """Throw away whatever is queued right now (stale echo / late output); returns what was thrown away."""
        self._pushback.clear()
        out = bytearray()
        while True:
            data = self._read_chunk(0)
            if not data:
                return bytes(out[-4096:])
            out += data

    def _drain(self, quiet=0.03, limit=0.25):
        """Read and discard until the line is quiet for `quiet` s (at most `limit` s)."""
        end = time.monotonic() + limit
        last = time.monotonic()
        while time.monotonic() < end:
            if self._read_chunk(min(self.read_slice, quiet)):
                last = time.monotonic()
            elif time.monotonic() - last >= quiet:
                break

    def _extend_quiet(self, seconds):
        """Remember that Ctrl-C bytes may still be on their way to the board for `seconds` more."""
        with self._cv:
            self._quiet_until = max(self._quiet_until, time.monotonic() + seconds)

    def _wait_quiet(self, cancel=None):
        """Op lock held. Called before an op writes anything: if a Stop (interrupt(), or an exec that ended
        with KeyboardInterrupt) is still settling, wait until its last Ctrl-C has had time to arrive and be
        answered, discarding what the board says meanwhile, then drain until the line is quiet. Without this a
        Stop's second Ctrl-C lands inside the NEXT exec (devfs's cleanup after a cancelled upload) and aborts
        its raw paste, stalling the file op for the whole stage timeout. Costs nothing when no Stop happened."""
        waited = False
        while True:
            with self._cv:
                left = self._quiet_until - time.monotonic()
            if left <= 0:
                break
            waited = True
            self._read_chunk(min(self.read_slice, left), cancel)  # discard
        if waited:
            self._drain(quiet=0.02, limit=0.2)
            self._pushback.clear()

    # ------------------------------------------------------------------ op lock

    @contextlib.contextmanager
    def _op(self):
        with self._cv:
            self._waiting += 1
        try:
            self._op_lock.acquire()
        finally:
            with self._cv:
                self._waiting -= 1
        try:
            yield
        finally:
            self._op_lock.release()

    def session(self):
        """Context manager: hold the port (pump paused) across several calls, e.g.
        `with link.session(): link.enter_raw(); link.exec(...); link.exit_raw()`."""
        return self._op()

    # ------------------------------------------------------------------ listening / sync

    def _listen(self, total, on_data=None, quiet=0.03, cancel=None):
        """Collect bytes for up to `total` s, stopping early once a prompt has been quiet for `quiet` s."""
        buf = bytearray()
        end = time.monotonic() + total
        last_data = time.monotonic()
        while True:
            now = time.monotonic()
            if now >= end:
                break
            data = self._read_chunk(min(self.read_slice, end - now), cancel)
            if data:
                buf += data
                last_data = time.monotonic()
                if on_data is not None:
                    on_data(data)
            elif self._prompt_kind(buf) and time.monotonic() - last_data >= quiet:
                break
        return bytes(buf)

    @staticmethod
    def _repl_evidence(buf, kind, nudged):
        """Why a prompt-shaped tail may be trusted as the REPL's own prompt ("" = it may be a lookalike).
        ">>> " is also what a program prints for input('>>> '), so the shape alone proves nothing:
        the raw-REPL banner / EOF marker are specific enough; for the friendly prompt we need the
        MicroPython banner in the bytes, or nothing but the echo of our own bare CRLF nudge (the REPL
        treats CR and LF as two Enters: "\\r\\n>>> \\r\\n>>> "), with no program output in between."""
        if kind == "raw":
            return "raw"
        if kind == "friendly":
            if b"MicroPython v" in buf or b'Type "help()"' in buf:
                return "banner"
            if nudged and _NUDGE_ECHO.fullmatch(buf):
                return "echo"
        return ""

    def _classify_listen(self, buf, nudged=False):
        kind = self._prompt_kind(buf)
        evidence = self._repl_evidence(buf, kind, nudged)
        self.sync_evidence = evidence
        if kind and not evidence:
            self._mode = "unknown"
            return "prompt-unverified"
        self._mode = kind or "unknown"
        if kind:
            return "prompt"
        return "running-program" if buf else "silent"

    def sync_to_prompt(self, listen_ms=400, nudge_ms=400, on_data=None):
        """Find out what the board is doing without disturbing it (RQ-SAFE-1).

        Listens for listen_ms. A prompt at the tail -> "prompt" when there is evidence that it is the
        REPL's (see below), else "prompt-unverified". Bytes but no prompt -> "running-program" (a program
        such as main.py is producing output; nothing is sent). Nothing at all -> one bare "\\r\\n" nudge,
        then up to nudge_ms: same rules, still nothing -> "silent". No Ctrl-C, no Ctrl-D, no raw REPL.
        The bytes seen are in `link.sync_bytes` (and passed to on_data as they arrive).

        A trailing ">>> " is only a SHAPE: a program blocked in input('>>> ') ends in exactly the same
        four bytes. "prompt" therefore needs evidence, recorded in `link.sync_evidence`: "raw" (the raw
        REPL banner / EOF marker), "banner" (the MicroPython banner is in the bytes) or "echo" (the bytes
        are only newlines and prompts, the REPL's answer to our nudge). A bare prompt-shaped tail with none of
        these is "prompt-unverified": the mode stays "unknown", and the caller must treat the board as
        possibly running a program (the safe default: file ops answer E_PROGRAM_RUNNING and the user is
        asked before any Ctrl-C is sent). It is never classified as idle on a lookalike alone."""
        with self._op():
            self._alive_ser()
            self._wait_quiet()  # the tail of a Stop is not the board's idle state
            buf = self._listen(listen_ms / 1000.0, on_data)
            nudged = not buf
            if nudged:
                self.write(b"\r\n")
                buf = self._listen(nudge_ms / 1000.0, on_data)
            self.sync_bytes = buf
            return self._classify_listen(buf, nudged)

    # ------------------------------------------------------------------ raw REPL

    def enter_raw(self, soft_reset=False, timeout=10.0, cancel=None):
        """Ctrl-C once (like mpremote), Ctrl-A, wait for the raw banner. With soft_reset also Ctrl-D
        and wait for "soft reboot" and the second banner. Returns the boot-time output seen between
        the two (b"" without soft_reset). Raises E_RAW_REPL_TIMEOUT: the first stage (Ctrl-C, wait for the
        interrupted program to hand back the REPL, Ctrl-A, banner) has `timeout` in total, each later stage
        `timeout` again."""
        with self._op():
            self._alive_ser()
            self._wait_quiet(cancel)  # a Stop's second Ctrl-C must not land between our Ctrl-C and Ctrl-A
            t_start = time.monotonic()
            idle_raw = self._mode == "raw" and not self._in_exec and not self._need_prompt
            self._mode = "unknown"
            self._need_prompt = False
            self._pushback.clear()
            self.write(CTRL_C, _own=True)
            if idle_raw:
                self._drain()  # Ctrl-C at an idle raw prompt prints nothing
            else:
                # Let an interrupted program finish unwinding (finally: blocks, hardware parking) and hand
                # the REPL back before Ctrl-A, otherwise that key can be lost. Ends as soon as a prompt has
                # been quiet for 30 ms; a program that ignores Ctrl-C costs the whole window.
                self._listen(min(self.interrupt_wait, timeout / 2.0), quiet=0.03, cancel=cancel)
            self.write(CTRL_A)
            left = max(0.05, timeout - (time.monotonic() - t_start))  # the first stage includes the wait
            self._expect(RAW_PROMPT, left, cancel, "the raw REPL banner (Ctrl-A)")
            boot = b""
            if soft_reset:
                self.write(CTRL_D)
                self._expect(b"soft reboot\r\n", timeout, cancel, "\"soft reboot\" (Ctrl-D)")
                boot = self._expect(RAW_PROMPT, timeout, cancel, "the raw REPL banner after the soft reset")
            self._mode = "raw"
            return boot

    def exit_raw(self, timeout=2.0, redraw=None):
        """Ctrl-B, swallow the friendly banner up to the next ">>> ". With redraw (default: when the
        REPL is attached) send "\\r" afterwards so the prompt is redrawn for the user."""
        with self._op():
            self._alive_ser()
            self._wait_quiet()
            self.write(CTRL_B)
            self._need_prompt = False
            if not self._try_expect(FRIENDLY_PROMPT, timeout):
                self._mode = "unknown"
                self._log("warn", "exit_raw: no friendly prompt within %.1fs" % timeout)
                return False
            self._mode = "friendly"
            if redraw is None:
                redraw = self._tap is not None
            if redraw:
                self.write(b"\r")
            return True

    @staticmethod
    def _code_bytes(code):
        data = code.encode("utf-8") if isinstance(code, str) else bytes(code)
        bad = [b for b in (3, 4) if bytes([b]) in data]
        if bad:
            raise BridgeError(
                "E_PROTOCOL", "The code contains a control character the raw REPL would act on.",
                detail="byte(s) %s present in the source" % ", ".join("0x%02x" % b for b in bad),
                hint="Escape control characters in string literals (\\x03, \\x04).",
            )
        if not data.strip():
            # In the raw REPL Ctrl-D on an EMPTY buffer is a soft reset, and Ctrl-D is how code is submitted:
            # an empty program must never be sent as an empty buffer.
            data = b"pass\n"
        return data

    def exec(self, code, timeout=10.0, cancel=None):
        """Run `code` in the raw REPL and return (stdout bytes, stderr bytes). `timeout` bounds the
        silence in every stage (E_BOARD_UNRESPONSIVE). Requires enter_raw() first (E_INTERNAL else)."""
        out = bytearray()
        stage = self.stage_timeout if timeout is None else timeout
        err = self._run(code, out.extend, timeout, stage, cancel)
        return bytes(out), err

    def exec_stream(self, code, on_out, timeout=None, cancel=None):
        """Like exec but stdout is delivered to on_out(bytes) as it arrives; returns the stderr bytes.
        `timeout` is the allowed silence while the program runs (None: unlimited); handshake stages
        use link.stage_timeout."""
        return self._run(code, on_out, timeout, self.stage_timeout, cancel)

    def _run(self, code, on_out, idle_timeout, stage_timeout, cancel):
        data = self._code_bytes(code)
        with self._op():
            self._alive_ser()
            if self._mode != "raw":
                raise BridgeError("E_INTERNAL", "exec called while not in the raw REPL.",
                                  detail="mode=%s; call enter_raw() first" % self._mode)
            self._in_exec = True
            try:
                if self._need_prompt:
                    self._expect(b">", stage_timeout, cancel, "the raw REPL prompt", code="E_BOARD_UNRESPONSIVE")
                    self._need_prompt = False
                self._wait_quiet(cancel)
                pending = self._discard_pending()
                self._require_raw_prompt(pending)
                self._send_code(data, stage_timeout, cancel)
                return self._follow(on_out, idle_timeout, stage_timeout, cancel)
            except _SubmissionInterrupted:
                # Stop arrived before the code was complete: nothing was executed and nothing more was sent. The
                # board is (almost surely) at its raw prompt with an empty buffer; confirm instead of assuming, so
                # the caller's cleanup exec (devfs put_abort) can run on this very session.
                self._mode = "unknown"
                self._resync_raw(stage_timeout)
                raise
            except BaseException:
                self._mode = "unknown"  # framing is in doubt; enter_raw() resynchronises
                raise
            finally:
                self._in_exec = False

    def _resync_raw(self, timeout):
        """Op lock held. Ctrl-A at the raw prompt only re-prints the raw banner (it never resets); at a friendly prompt
        it enters the raw REPL. Anything else (a program ignoring Ctrl-C) times out and leaves the mode unknown."""
        try:
            self._wait_quiet()
            self._discard_pending()
            self.write(CTRL_A)
            self._expect(RAW_PROMPT, min(timeout, 3.0), None, "the raw REPL banner after a Stop",
                         code="E_BOARD_UNRESPONSIVE")
            self._mode = "raw"
            self._need_prompt = False
        except BridgeError as exc:
            self._mode = "unknown"
            self._log("warn", "resync after Stop failed: %s" % exc.detail)

    def _require_raw_prompt(self, pending):
        """Nothing may be written to the board unless it is still at the raw prompt. The code is submitted with
        Ctrl-D, and Ctrl-D at an empty FRIENDLY prompt is a soft reset (re-runs boot.py/main.py: RQ-SAFE-1).
        If the board reset under the session (button, brown-out, watchdog) the banner and a friendly prompt are
        waiting for us: send nothing, forget the mode, tell the caller to re-synchronise."""
        if self._last_prompt == "friendly" or b"MicroPython v" in pending:
            raise BridgeError(
                "E_BOARD_RESET", "The board restarted while the raw REPL session was open.",
                detail="friendly prompt / banner seen instead of the raw prompt; last bytes: %r" % pending[-120:],
                hint="Nothing was sent. Wait for the board to finish booting, then retry.",
            )

    def _send_code(self, data, timeout, cancel):
        with self._wlock:
            count0 = self._ctrl_c_count
        if self._paste is not False:
            self.write(CTRL_E + b"A" + CTRL_A)
            reply = self._read_exact(2, timeout, cancel, "the raw-paste reply")
            if reply == b"R\x01":
                self._paste = True
                self._paste_write(data, timeout, cancel, count0)
                return
            if reply == b"R\x00":
                self._paste = False  # understood but not supported; the REPL may re-print its prompt
                self._try_expect(b">", min(timeout, 0.3), cancel)
            else:
                # Firmware without raw paste treated Ctrl-E/A/Ctrl-A as a raw REPL reset: wait for its banner
                self._expect(b"w REPL; CTRL-B to exit\r\n>", timeout, cancel, "the raw REPL banner after the paste probe",
                             code="E_BOARD_UNRESPONSIVE")
                self._paste = False
        step = self.raw_chunk
        for i in range(0, len(data), step):
            if cancel is not None and cancel.is_set():
                raise BridgeError("E_CANCELLED", "The operation was cancelled.")
            self._write_unless_stopped(data[i:i + step], count0)
            time.sleep(self.raw_chunk_delay)
        self._write_unless_stopped(CTRL_D, count0)
        ok = self._read_exact(2, timeout, cancel, "\"OK\" after the code")
        if ok != b"OK":
            raise BridgeError("E_PROTOCOL", "The board did not accept the code.",
                              detail="expected b'OK', got %r" % ok,
                              hint="Retry; the next operation re-synchronises the REPL.")

    def _paste_write(self, data, timeout, cancel, count0):
        window = struct.unpack("<H", self._read_exact(2, timeout, cancel, "the raw-paste window size"))[0]
        if window == 0:
            raise BridgeError("E_PROTOCOL", "The board reported a raw-paste window of 0 bytes.")
        remain = window
        i = 0
        n = len(data)
        while i < n:
            while True:
                if remain == 0:
                    chunk = self._read_chunk(timeout, cancel)
                    if not chunk:
                        raise self._timeout_error("a raw-paste flow-control byte", "E_BOARD_UNRESPONSIVE", timeout, b"")
                else:
                    chunk = self._read_chunk(0, cancel)
                    if not chunk:
                        break
                for k, b in enumerate(chunk):
                    if b == 1:
                        remain += window  # device consumed a window: send more
                    elif b == 4:
                        # device ended the paste early; acknowledge and let follow() read the result. NOT when a Stop
                        # (Ctrl-C) went out since the submission began: the 0x04 is then the board's answer to OUR
                        # Ctrl-C, it is already back at its raw prompt, and a Ctrl-D on an empty raw buffer is a soft
                        # reset (RQ-SAFE-1). _write_unless_stopped raises _SubmissionInterrupted; _run resyncs.
                        self._write_unless_stopped(CTRL_D, count0)
                        self._unread(chunk[k + 1:])
                        return
                    else:
                        raise BridgeError("E_PROTOCOL", "Unexpected data from the board during raw paste.",
                                          detail="byte 0x%02x" % b)
                if remain > 0:
                    break
            take = min(remain, n - i)
            self._write_unless_stopped(data[i:i + take], count0)
            remain -= take
            i += take
        self._write_unless_stopped(CTRL_D, count0)
        # the device acknowledges the end of the data with one Ctrl-D (flow bytes may precede it)
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            chunk = self._read_chunk(max(0.0, min(0.25, left)), cancel)
            if chunk:
                j = chunk.find(CTRL_D)
                if j >= 0:
                    self._unread(chunk[j + 1:])
                    return
            elif left <= 0:
                raise self._timeout_error("the raw-paste end acknowledgement", "E_BOARD_UNRESPONSIVE", timeout, b"")

    def _follow(self, on_out, idle_timeout, stage_timeout, cancel):
        state = 0  # 0 stdout, 1 stderr, 2 done
        err = bytearray()
        last = time.monotonic()
        rest = b""
        while state < 2:
            limit = idle_timeout if state == 0 else stage_timeout
            wait = 0.25 if limit is None else max(0.0, min(0.25, limit - (time.monotonic() - last)))
            chunk = self._read_chunk(wait, cancel)
            if not chunk:
                if limit is not None and time.monotonic() - last >= limit:
                    raise self._timeout_error(
                        "the end of the program output" if state == 0 else "the end of the error output",
                        "E_BOARD_UNRESPONSIVE", limit, bytes(err[-200:]))
                continue
            last = time.monotonic()
            data = chunk
            while data and state < 2:
                i = data.find(CTRL_D)
                if state == 0:
                    if i < 0:
                        on_out(data)
                        data = b""
                    else:
                        if i:
                            on_out(data[:i])
                        data = data[i + 1:]
                        state = 1
                else:
                    if i < 0:
                        err += data
                        data = b""
                    else:
                        err += data[:i]
                        data = data[i + 1:]
                        state = 2
            rest = data
        if b"KeyboardInterrupt" in err:
            # A Ctrl-C ended it, and there may be a second one on its way (Stop sends two, 50 ms apart; so does
            # a user hammering the key): the next op waits for it instead of having it land in its own code.
            self._extend_quiet(0.05 + SETTLE_S)
        # the REPL prints ">" right after the second EOF; if it is late the next exec waits for it
        self._need_prompt = True
        self._unread(rest)
        if self._try_expect(b">", min(1.0, stage_timeout), cancel):
            self._need_prompt = False
        else:
            self._log("debug", "prompt after program end not seen yet")
        return bytes(err)

    # ------------------------------------------------------------------ interrupt

    def interrupt(self, timeout=3.0, presses=2, gap=0.05, settle=SETTLE_S):
        """Stop: Ctrl-C `presses` times `gap` s apart, then wait up to `timeout` s for a prompt.

        Bypasses the op lock (works while a program or an op owns the port). True as soon as the FIRST
        friendly or raw prompt came back (the program ended or nothing was running), so the reply takes
        about `gap` + the board's answer (well under 200 ms for an interruptible program); False when the
        board did not answer (a program ignoring Ctrl-C). Never resets.

        Settling is not part of the reply: before the first Ctrl-C is written the Link records a quiet
        deadline (last Ctrl-C + `settle`), and every op that is about to write to the board (exec,
        enter_raw, exit_raw) first waits for it, discarding the trailing prompt/traceback. So the second
        Ctrl-C can never land inside the next exec's code, and the Link is immediately usable: an exec in
        flight on another thread returns its KeyboardInterrupt traceback (devfs raises E_CANCELLED), and a
        new exec issued right after Stop works (it starts <= gap + settle after the first Ctrl-C)."""
        self._alive_ser()
        # Sitting at the raw prompt with no exec in flight: Ctrl-C only clears an empty line, no
        # prompt will be printed, so there is nothing to wait for.
        idle_raw = self._mode == "raw" and not self._in_exec and not self._need_prompt
        presses = max(1, int(presses))
        with self._cv:
            gen0 = self._prompt_gen
            self._quiet_until = max(self._quiet_until, time.monotonic() + gap * (presses - 1) + settle)
        for k in range(presses):
            if k:
                time.sleep(gap)
            self.write(CTRL_C)
            self._extend_quiet(gap * (presses - 1 - k) + settle)
        if idle_raw:
            return True
        return self._wait_prompt(gen0, time.monotonic() + timeout)

    def _wait_prompt(self, gen0, deadline):
        """Wait for _prompt_gen to move past gen0 (None: just pass time). Whoever is reading (op owner
        or pump) signals the condition; if nobody is, read here."""
        while True:
            self._alive_ser()
            with self._cv:
                if gen0 is not None and self._prompt_gen != gen0:
                    return True
            if time.monotonic() >= deadline:
                return False
            if self._op_lock.acquire(False):
                data = b""
                try:
                    data = self._read_chunk(self.read_slice)
                finally:
                    self._op_lock.release()
                self._deliver(data)
            else:
                with self._cv:
                    self._cv.wait(self.read_slice)

    # ------------------------------------------------------------------ misc ops

    def read_available(self):
        """Everything queued right now, without waiting (takes the op lock)."""
        with self._op():
            out = bytearray()
            while True:
                data = self._read_chunk(0)
                if not data:
                    return bytes(out)
                out += data

    def relay(self, wait=0.6, on_data=None, quiet=0.15):
        """Hold the port and pass what the board answers to on_data until a prompt has been quiet for `quiet` s
        (at most `wait` s). The caller wrote keystrokes just before (the bridge replays typed input after a
        raw-REPL operation): their echo and result must reach the REPL view, not be swallowed by the next op."""
        with self._op():
            self._alive_ser()
            return self._listen(wait, on_data, quiet=quiet)

    def soft_reset_friendly(self, wait=3.0, on_data=None):
        """Ctrl-D at the friendly prompt: the board soft-resets, runs boot.py then main.py. Waits up to
        `wait` s; "prompt" (back at >>>), "running-program" (main.py still running) or "silent"."""
        with self._op():
            self._alive_ser()
            self._wait_quiet()  # a Stop's second Ctrl-C must not land in the program this reset starts
            self._mode = "unknown"
            self.write(CTRL_D)
            buf = self._listen(wait, on_data, quiet=0.1)
            self.sync_bytes = buf
            return self._classify_listen(buf)

    @property
    def line_driver(self):
        """The registered stand-in for the control lines of this port (tests), or None."""
        with _LINE_DRIVERS_LOCK:
            return _LINE_DRIVERS.get(self._port) if self._port else None

    @property
    def usb_ids(self):
        """(vid, pid) of the adapter as given to open() (or a line driver's hint); (None, None) when unknown."""
        vid, pid = self._usb_ids or (None, None)
        if vid is None:
            hint = getattr(self.line_driver, "usb_ids", None)
            if hint:
                return (hint[0], hint[1])
        return (vid, pid)

    def can_hard_reset(self, lookup=True):
        """(ok, reason). Hard reset needs a real serial device behind a known auto-reset USB bridge (or a line driver).
        ok is None when the adapter is unknown and lookup=False (no port enumeration is done)."""
        if self._ser is None and self._dead_error is None:
            return (False, "not connected")
        if self.line_driver is not None:
            return (True, "")
        if self._kind in ("url", "pty"):
            return (False, "this connection (%s) has no modem lines" % self._kind)
        vid, _pid = self._usb_ids or (None, None)
        if vid is None and not lookup:
            return (None, "the USB adapter is unknown")
        if vid is None:
            ids = lookup_usb_ids(self._port) if self._port else None
            if ids:
                self._usb_ids = ids
                vid = ids[0]
        if vid is None:
            return (False, "the USB adapter is unknown")
        if vid not in AUTO_RESET_USB_BRIDGES:
            return (False, "USB vendor 0x%04x is not a known auto-reset bridge (native-USB boards have no safe pulse)" % vid)
        return (True, "")

    @staticmethod
    def _require_confirm(confirm, what):
        if confirm is not RESET_CONFIRMED:
            raise BridgeError(
                "E_PROTOCOL", "%s needs the user's confirmation." % what,
                detail="the Link was called without the RESET_CONFIRMED token; nothing was sent",
                hint="Show the user the reset warning, then ask again with confirmed:true.")

    def machine_reset(self, confirm=None, ack_timeout=2.0, settle=0.4):
        """Reboot the chip with `import machine; machine.reset()` through the RAW REPL (needs enter_raw() first). No control
        lines are involved. The command is acknowledged ("OK"), never awaited: the board resets and the link may drop (a
        native-USB board re-enumerates), which is tolerated. Returns {"ack": bool, "dropped": bool}.

        Nothing is sent without the RESET_CONFIRMED token (E_PROTOCOL), nor unless the board is still at the raw prompt
        (the code is submitted with Ctrl-D, which at a friendly prompt is a soft reset: E_BOARD_RESET). A Ctrl-C that goes
        out while the code is being written (Stop) abandons it: E_CANCELLED, no Ctrl-D. A board whose machine.reset()
        raises (no such function) answers with a traceback: E_UNSUPPORTED."""
        self._require_confirm(confirm, "Rebooting the board")
        data = b"import machine\nmachine.reset()\n"
        with self._op():
            self._alive_ser()
            if self._mode != "raw":
                raise BridgeError("E_INTERNAL", "machine_reset called while not in the raw REPL.",
                                  detail="mode=%s; call enter_raw() first" % self._mode)
            if self._need_prompt:
                self._expect(b">", self.stage_timeout, None, "the raw REPL prompt", code="E_BOARD_UNRESPONSIVE")
                self._need_prompt = False
            self._wait_quiet()
            self._require_raw_prompt(self._discard_pending())
            with self._wlock:
                count0 = self._ctrl_c_count
            self._write_unless_stopped(data, count0)
            self._write_unless_stopped(CTRL_D, count0)
            self._mode = "unknown"  # the chip is (about to be) gone: whatever speaks next is a fresh boot
            self._need_prompt = False
            ack, dropped, seen = False, False, bytearray()
            end = time.monotonic() + ack_timeout
            try:
                while time.monotonic() < end:
                    chunk = self._read_chunk(min(self.read_slice, max(0.0, end - time.monotonic())))
                    if chunk:
                        seen += chunk
                        if not ack and b"OK" in seen:
                            ack = True
                            end = min(end, time.monotonic() + settle)  # the reset (or its traceback) follows at once
            except BridgeError as exc:
                if exc.code not in ("E_NO_DEVICE", "E_NOT_CONNECTED"):
                    raise
                dropped = True
            if b"Traceback" in seen:
                raise BridgeError("E_UNSUPPORTED", "This board cannot reboot itself with machine.reset().",
                                  detail=bytes(seen[-300:]).decode("utf-8", "replace"),
                                  hint="Press the board's reset button, or use Restart Python (soft reset).")
            if ack:  # what followed the "OK" is the new boot: give it back to whoever listens next (sync_to_prompt)
                self._unread(bytes(seen[seen.index(b"OK") + 2:]))
            return {"ack": ack, "dropped": dropped}

    def _resolve_pulse(self, method):
        """(method, driver) for a hard reset, or E_UNSUPPORTED. Decides from the transport only; no I/O."""
        if method not in (None, "rts-pulse", "usb-jtag"):
            raise BridgeError("E_UNSUPPORTED", "There is no control line reset method %r." % (method,),
                              detail="method=%r" % (method,), hint="Press the board's reset button instead.")
        drv = self.line_driver
        if drv is None and self._kind in ("url", "pty"):
            raise BridgeError("E_UNSUPPORTED", "Hardware reset is not available here.",
                              detail="this connection (%s) has no modem lines" % self._kind,
                              hint="Press the board's reset button instead.")
        return (method or "rts-pulse"), drv

    def hard_reset(self, confirm=None, wait=5.0, on_data=None, method=None, on_pulse=None):
        """Explicit hardware reset by pulsing the control lines (`method`: "rts-pulse" = esptool HardReset: DTR low, RTS high
        ~100 ms, RTS low; "usb-jtag" = the same with USB-Serial/JTAG timing). The ONLY code in this module that drives
        DTR/RTS apart from the open/close policy. E_UNSUPPORTED where there are no lines (url/pty without a line driver);
        nothing is sent without the RESET_CONFIRMED token (E_PROTOCOL). Whether the adapter is believed to be wired for
        it (resetcap.estimate: likely / verified / force) is the caller's policy, not the Link's.
        Returns the verdict of what the board does afterwards ("prompt" | "running-program" | "silent" | ...);
        `link.sync_bytes` holds what was seen. `on_pulse()` is called once the lines have been driven, before listening
        (the bridge announces the reset there, not earlier: a refused pulse must not look like a reset). A native-USB
        board that drops the port raises E_NO_DEVICE."""
        with self._op():
            ser = self._alive_ser()
            meth, drv = self._resolve_pulse(method)
            self._require_confirm(confirm, "A hardware reset")
            self._mode = "unknown"
            self._need_prompt = False
            try:
                if drv is not None:
                    drv.pulse(meth, ser)
                else:
                    for step in (HARD_RESET_STEPS if meth == "rts-pulse" else USB_JTAG_RESET_STEPS):
                        self._apply_step(ser, step, tolerate=False, strict=True)
            except (OSError, serial.SerialException) as exc:
                raise BridgeError("E_UNSUPPORTED", "The adapter does not allow controlling the reset line.",
                                  detail=describe_exception(exc), hint="Press the board's reset button instead.")
            if on_pulse is not None:
                on_pulse()
            buf = self._listen(wait, on_data, quiet=0.2)
            self.sync_bytes = buf
            return self._classify_listen(buf)

    # ------------------------------------------------------------------ REPL attachment / pump

    def attach_repl(self, on_data):
        """Start forwarding board bytes to on_data(bytes) whenever no op owns the port."""
        self._alive_ser()
        self._tap = on_data
        with self._state_lock:
            if self._pump is not None and self._pump.is_alive():
                return
            self._pump_stop = threading.Event()
            self._pump = threading.Thread(target=self._pump_main, args=(self._pump_stop,),
                                          name="link-pump", daemon=True)
            self._pump.start()

    def detach_repl(self):
        self._tap = None
        self._stop_pump(join=True)

    def _stop_pump(self, join):
        t = self._pump
        self._pump_stop.set()
        if join and t is not None and t is not threading.current_thread():
            t.join(1.0)
        if t is not None and not t.is_alive():
            self._pump = None

    def _deliver(self, data):
        cb = self._tap
        if data and cb is not None:
            try:
                cb(data)
            except Exception as exc:  # a failing consumer must not kill the pump
                self._log("warn", "repl callback failed: %s" % describe_exception(exc))

    def _pump_main(self, stop):
        while not stop.is_set():
            if self._waiting:
                time.sleep(0.002)  # an op wants the port: step aside
                continue
            if not self._op_lock.acquire(timeout=0.05):
                continue
            data = b""
            try:
                if stop.is_set():
                    break
                data = self._read_chunk(self.read_slice)
            except BridgeError:
                break  # closed or lost; _mark_dead has already notified
            except Exception as exc:
                self._log("warn", "pump stopped: %s" % describe_exception(exc))
                break
            finally:
                self._op_lock.release()
            self._deliver(data)

    @staticmethod
    def safe_mode_check(port, environ=None):
        return safe_mode_check(port, environ)
