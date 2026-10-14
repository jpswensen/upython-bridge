"""server.py - the bridge's NDJSON server. Implements docs/protocol.md on top of Link (link.py), devfs and BridgeError.

Internal architecture (read this before changing anything)
----------------------------------------------------------
THREADS   reader  : the only reader of stdin. Parses one request per line, validates it, then either answers it itself
                    (bypass ops: ping, tty.write, cancel, config, shutdown), hands it to a short-lived helper thread
                    (stop, ports.list: they may take seconds and must not stall the reader) or puts it on the queue.
          worker  : the PORT OWNER. Pops the highest-priority request (class 1 connect/disconnect/repl.*, 2 run/reset.*,
                    3 explicit file ops, 4 background ops), runs it to completion, answers it. Nothing else ever runs an
                    op that talks to the board in request/response fashion. A running op is never aborted by a new
                    request; only stop/cancel (bypass) and the cancel event reach it.
          pump    : owned by Link (attach_repl). Always on while connected: reads the board only when no op owns the
                    port; its bytes become `repl` events when the REPL view is attached and are dropped otherwise. It is
                    also what notices an unplug while the bridge is idle (Link.on_disconnect -> state:"unplugged").
          main    : waits for quit, then runs shutdown_sequence() (idempotent; the reader runs it on stdin EOF/shutdown).
STATE     disconnected -> connecting -> idle | running -> rawop (a bridge op holds the raw REPL) -> idle ... (section 5).
          `state` events are emitted on every change. `running` also covers "connect found output but no prompt" and
          "prompt-unverified" (conservative: file ops answer E_PROGRAM_RUNNING until the client passes interrupt:true).
          `idle` is only ever claimed on EVIDENCE: a verified prompt at connect, exit_raw seeing the friendly prompt again,
          a Stop that was answered by a prompt (plus a Ctrl-A resync when a raw-REPL conversation was abandoned), or the pump
          seeing the REPL start (banner, then prompt, quiet) AND the board answering a bare newline with a fresh prompt
          (_verify_idle). A cancelled Run or an exec that timed out leaves `running` + `_unsynced` until one of those.
CONCURRENCY  while a Run holds the worker, repl.attach/detach (flag only) and disconnect (helper thread) are answered at once;
          overlapping Stops share one Ctrl-C pair (_StopFlight); a run whose Stop was answered by a prompt but whose end
          never arrives is released by the RUN_END_GRACE watchdog and resynchronised (Ctrl-A path, never a reset).
FILE OPS  _borrow(): Link.session() (pump paused) -> enter_raw WITHOUT soft reset -> exec_fn for devfs -> exit_raw and, when
          the REPL view is attached, redraw its prompt. The REPL view therefore sees nothing of the borrow.
          Device snippets run as exec(<snippet>, {}) in a globals dict of their own, because the raw REPL shares __main__
          with the student's REPL (only the `exec` op runs there). tty.write during a borrow is held; the worker replays it
          after the op's response (_replay_held) and relays the echo to the REPL view while it still owns the port.
SAFETY    only the explicit ops reset.soft, reset.machine and reset.hard (the last two need confirmed:true here AND the
          RESET_CONFIRMED token at the Link) and `run` (soft reset by default) ever reset; connect, disconnect, file ops,
          stop and shutdown never do, and nothing escalates from Stop to a reset (tests/test_reset_tiers.py pins the call
          sites). stdin EOF / shutdown while a program runs interrupts it first (Ctrl-C
          x2, <= 1 s) when config.stopOnDisconnect (default true). Safe mode is enforced by Link before any open.
ERRORS    every failure is a BridgeError (code, message, detail, hint); anything else becomes E_INTERNAL with a traceback.
"""
from __future__ import annotations

import base64
import binascii
import bisect
import contextlib
import json
import os
import re
import signal
import sys
import threading
import time
import traceback

import serial
from serial.tools import list_ports

from . import __version__ as BRIDGE_VERSION
from . import devfs
from . import resetcap
from .errors import BridgeError, describe_exception
from .link import RESET_CONFIRMED, Link, lookup_usb_ids, normalize_port, port_kind, safe_mode_check

PROTO = 1
MAX_LINE = 4 * 1024 * 1024
OUT_CHUNK = 24 * 1024            # raw bytes per out/repl event (base64 makes it ~32 KiB of JSON)
ENTER_RAW_TIMEOUT = 10.0
HELD_TTY_MAX = 64 * 1024         # keystrokes typed while a file op borrows the port; beyond it tty.write is refused whole
EXEC_MAX_BYTES = 256 * 1024      # `exec` returns at most this much of out (head) and of err (tail) per call: even all-escapes
                                 # JSON (6x) stays far below the 4 MiB line limit; the response then has truncated:true
REPLAY_RELAY_MAX_S = 10.0        # upper bound for relaying the echo of replayed keystrokes
RUN_END_GRACE = 3.0              # a Stop reached a prompt but the run's end-of-stream never came: give up following after this
RESYNC_TIMEOUT = 5.0             # Ctrl-A path back to the friendly REPL after an abandoned raw-REPL operation
RECONCILE_QUIET_S = 0.35         # a banner + prompt seen by the pump must stay quiet this long before it is verified
ID_SCAN_PREFIX = 4096            # bytes of an over-long request line searched for its "id" (the rest is scanned in passing)
VENDORED_MPREMOTE = "1.29.0"
BOARD_RESET_WINDOW_S = 20.0      # after a reset was sent, a lost link is reported as `board-reset` (not `unplugged`) for this long
RESET_BOOT_LISTEN_MS = 3000      # after a machine reset: how long the bridge listens for the board to boot and show its prompt
HARD_RESET_LISTEN_S = 5.0        # reset.hard without verify: how long to listen for the board to come back
VERIFY_WINDOW_S = 3.0            # addendum section 3: evidence of a reset must show up within 3 s of the pulse
# the boot text of an ESP chip (the kit's ROM_RE, tools/hwkit/mpy_hwkit.py): evidence (a) of the verification
_ROM_RE = re.compile(rb"ets [A-Z][a-z]{2} +\d+ \d{4}|rst:0x[0-9a-f]+|boot:0x[0-9a-f]+|configsip|load:0x[0-9a-f]+|waiting for download")
_UPTIME_CODE = ("import time\nt = time.ticks_ms()\nc = -1\ntry:\n    import machine\n    c = machine.reset_cause()\n"
                "except Exception:\n    pass\nprint('@@U %d %d' % (t, c))\n")

# op -> (method, kind, priority class, gate). kind: inline (reader thread), thread (helper), queued (worker).
# gate: needs an idle board (E_PROGRAM_RUNNING unless interrupt:true / force:true).
_OPS = {
    "ping": ("op_ping", "inline", 0, False),
    "shutdown": ("op_shutdown", "inline", 0, False),
    "cancel": ("op_cancel", "inline", 0, False),
    "tty.write": ("op_tty_write", "inline", 0, False),
    "config": ("op_config", "inline", 0, False),
    "stop": ("op_stop", "thread", 0, False),
    "ports.list": ("op_ports_list", "thread", 0, False),
    "connect": ("op_connect", "queued", 1, False),
    "disconnect": ("op_disconnect", "queued", 1, False),
    "repl.attach": ("op_repl_attach", "queued", 1, False),
    "repl.detach": ("op_repl_detach", "queued", 1, False),
    "run": ("op_run", "queued", 2, False),
    "reset.soft": ("op_reset_soft", "queued", 2, False),
    "reset.machine": ("op_reset_machine", "queued", 2, True),   # gate: an idle board, or interrupt:true after asking the user
    "reset.hard": ("op_reset_hard", "queued", 2, False),        # works on a hung board: no gate
    "reset.capability": ("op_reset_capability", "inline", 0, False),   # pure: no I/O beyond the cached identity
    "identity": ("op_identity", "queued", 3, True),
    "fs.list": ("op_fs_list", "queued", 3, True),
    "fs.manifest": ("op_fs_manifest", "queued", 3, True),
    "fs.stat": ("op_fs_stat", "queued", 3, True),
    "fs.put": ("op_fs_put", "queued", 3, True),
    "fs.get": ("op_fs_get", "queued", 3, True),
    "fs.rm": ("op_fs_rm", "queued", 3, True),
    "fs.rmtree": ("op_fs_rmtree", "queued", 3, True),
    "fs.mkdir": ("op_fs_mkdir", "queued", 3, True),
    "fs.mv": ("op_fs_mv", "queued", 3, True),
    "exec": ("op_exec", "queued", 3, True),
    "introspect.modules": ("op_introspect", "queued", 3, True),
    "clock.read": ("op_clock_read", "queued", 3, True),        # read-only: time.localtime() + whether machine.RTC exists
    "clock.set": ("op_clock_set", "queued", 3, True),          # D-22: volatile RTC state only, never a file, never a reset
    "_clean_orphans": ("op_clean_orphans", "queued", 4, False),  # internal, never accepted from a client
    "_reconcile": ("op_reconcile", "queued", 1, False),          # internal: verify a banner+prompt the pump saw
}
_BACKGROUND_OPS = ("fs.put", "fs.list", "fs.manifest")

# USB vendor ids: 2 = ports that run MicroPython natively, 1 = USB-UART bridges commonly soldered to MicroPython boards
_VID_SCORE = {
    0x303A: 2, 0x2E8A: 2, 0xF055: 2, 0x0483: 2, 0x239A: 2, 0x1209: 1,
    0x10C4: 1, 0x1A86: 1, 0x0403: 1, 0x2341: 1, 0x16C0: 1, 0x1B4F: 1, 0x2886: 1,
}
_TEXT_HINTS = ("cp210", "ch340", "ch343", "ch9102", "ftdi", "esp32", "espressif", "micropython", "pico", "usb serial", "usb-serial")
_HOST_PLATFORMS = ("linux", "darwin", "win", "cygwin", "freebsd", "openbsd", "netbsd", "sunos", "aix")  # sys.platform of the unix port
_RE_KBD_INT = re.compile(r"(?m)^KeyboardInterrupt\b")
_RE_ID = re.compile(rb'"id"\s*:\s*(-?\d+)')
# the friendly REPL has started: its banner, at most one more line ('Type "help()"...'), then nothing but its own prompts
# (a newline we sent while it booted is echoed as more prompts); any program output after the banner breaks the match
_RE_BANNER_PROMPT = re.compile(rb"MicroPython v[^\r\n]*\r?\n(?:[^\r\n]*\r?\n)?(?:>>> \r?\n)*>>> \Z")
_RUNNING_HINT = "A program is still running on the board. Press Stop first, or confirm that it may be interrupted."
_SILENT_HINT = ("The board did not answer. Check that this is the right port, that no other program (Thonny, Arduino, "
                "PlatformIO, another VS Code window) is using it, and press the board's reset button once.")
# optional attributes of a BridgeError that travel next to code/message/detail/hint (machine-readable, never parsed from prose)
_ERR_EXTRAS = ("needs_allow_mount", "mount_reason", "needs_interrupt", "sync", "cleanup", "tmp_path", "accepted",
               "learned", "cache_key", "evidence", "current")
# verdicts of Link.sync_to_prompt / soft_reset_friendly that are not "prompt" -> why the bridge keeps the state `running`
_WHY_BY_VERDICT = {"running-program": "running-program", "prompt-unverified": "prompt-unverified", "silent": "silent"}
_NO_LINK_OPS = frozenset(("connect", "ports.list", "ping", "config", "cancel", "shutdown"))
_COMPILE_PROBE = "try:\n    compile('0', '<p>', 'eval')\n    print('@@C1')\nexcept Exception:\n    print('@@C0')\n"


# ----------------------------------------------------------------------------- small helpers

def _isolated(code):
    """Wrap a device snippet so it runs in a fresh globals dict (see Server._file_op). Snippets are ASCII-only (devfs lint)."""
    return "exec(%s, {})\n" % repr(code)


def _platform_name():
    p = sys.platform
    return "win32" if p.startswith("win") else ("darwin" if p == "darwin" else "linux")


def _bad(message, detail=None, hint=None):
    return BridgeError("E_PROTOCOL", message, detail=detail, hint=hint)


def _err_dict(exc):
    """The wire form of a BridgeError: code/message/detail/hint plus the optional machine-readable extras it carries."""
    d = exc.to_dict()
    for key in _ERR_EXTRAS:
        v = getattr(exc, key, None)
        if v is not None:
            d[key] = v
    return d


def _control_bytes_error(data):
    """E_PROTOCOL when `data` holds a byte the raw REPL would act on (the Link rejects it too, but only after the board was
    already reset: Run validates first)."""
    bad = [b for b in (3, 4) if bytes([b]) in data]
    if bad:
        return BridgeError(
            "E_PROTOCOL", "The code contains a control character the raw REPL would act on.",
            detail="byte(s) %s present in the source" % ", ".join("0x%02x" % b for b in bad),
            hint="Escape control characters in string literals (\\x03, \\x04).")
    return None


class _StopFlight(object):
    """One Stop in progress. Stops that arrive meanwhile join it and get its answer instead of writing more Ctrl-C bytes."""

    def __init__(self):
        self.done = threading.Event()
        self.stopped = False
        self.error = None


def _a_str(args, key, required=True, default=None):
    v = args.get(key, default)
    if v is None and not required:
        return None
    if not isinstance(v, str) or (required and v == ""):
        raise _bad("The request needs %r as a non-empty string." % key, detail="%s=%r" % (key, v))
    return v


def _a_bool(args, key, default):
    v = args.get(key, default)
    if not isinstance(v, bool):
        raise _bad("The argument %r must be true or false." % key, detail="%s=%r" % (key, v))
    return v


def _a_int(args, key, default, lo, hi):
    v = args.get(key, default)
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise _bad("The argument %r must be an integer from %d to %d." % (key, lo, hi), detail="%s=%r" % (key, v))
    return v


def _a_list_str(args, key):
    v = args.get(key)
    if v is None:
        return []
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise _bad("The argument %r must be a list of strings." % key, detail="%s=%r" % (key, v))
    return v


def _a_b64(args, key="b64"):
    v = args.get(key)
    if not isinstance(v, str):
        raise _bad("The request needs %r (base64 text)." % key)
    try:
        return base64.b64decode(v.encode("ascii"), validate=True)
    except (binascii.Error, UnicodeEncodeError, ValueError) as exc:
        raise _bad("The argument %r is not valid base64." % key, detail=str(exc))


class Request(object):
    def __init__(self, rid, op, args):
        spec = _OPS[op]
        self.id = rid
        self.op = op
        self.args = args
        self.method, self.kind, self.prio, self.gate = spec
        self.background = args.get("background") is True and op in _BACKGROUND_OPS
        if self.background:
            self.prio = 4
        self.cancel = threading.Event()
        self.finished = threading.Event()   # set by the worker when the response was produced (the run watchdog waits on it)
        self.watchdog = False               # the run watchdog (not the client) set `cancel`
        self.wd_armed = False
        self.seq = 0
        self.conn_gen = None                # reset.machine / reset.hard: the connection generation the confirmation was given for

    @property
    def wants_interrupt(self):
        return self.args.get("interrupt") is True or self.args.get("force") is True


class _OpQueue(object):
    """Priority queue (lower class number first, then arrival order) with removal by id and coalescing."""

    def __init__(self):
        self._cv = threading.Condition()
        self._items = []
        self._seq = 0
        self.closed = False

    def put(self, req):
        with self._cv:
            if self.closed:
                return False
            self._seq += 1
            req.seq = self._seq
            bisect.insort(self._items, (req.prio, req.seq, req))
            self._cv.notify()
            return True

    def get(self):
        with self._cv:
            while not self._items:
                if self.closed:
                    return None
                self._cv.wait()
            return self._items.pop(0)[2]

    def take_where(self, pred):
        with self._cv:
            hit = [it for it in self._items if pred(it[2])]
            self._items = [it for it in self._items if not pred(it[2])]
            return [it[2] for it in hit]

    def close(self):
        with self._cv:
            self.closed = True
            self._cv.notify_all()


# ----------------------------------------------------------------------------- the server

class Server(object):
    def __init__(self, out=None, stdin=None, cli=False):
        self.cli = cli
        self._out = out
        self._stdin = stdin
        self._out_lock = threading.Lock()
        self._out_dead = False
        self.cfg = {"shadowGuard": [], "idleListenMs": 400, "stopOnDisconnect": True}
        self.state = "disconnected"
        self._slock = threading.RLock()
        self.link = None
        self.port = None
        self.repl_attached = False
        self.run_active = False
        self.run_stdin = True
        self.current = None
        self.identity_cache = None
        self.caps_compile = None
        self._board_reset_until = 0.0   # monotonic deadline: a reset was sent, a dropped link is `board-reset` until then
        self._learned = {}              # (vid, pid, uniqueId) -> "verified" | "failed": this session's verification results
        self._conn_gen = 0              # bumped by every connect, disconnect and lost link: a queued reset belongs to ONE connection
        self._gen_lock = threading.Lock()
        self._orphans_pending = False
        self._held = bytearray()
        self._hold_lock = threading.Lock()
        self._running_why = ""          # why the state is `running`: run | running-program | prompt-unverified | silent | unconfirmed
        self._unsynced = False          # a raw-REPL conversation was abandoned: the board may still be in raw mode / running code
        self._run_done = threading.Event()
        self._run_done.set()
        self._stop_lock = threading.Lock()
        self._stop_flight = None
        self._pump_win = b""            # last bytes the pump saw (banner + prompt evidence for state `running` -> `idle`)
        self._pump_t = 0.0
        self._rc_lock = threading.Lock()
        self._rc_timer = None
        self.queue = _OpQueue()
        self.quitting = False
        self.quit_event = threading.Event()
        self.quit_reason = "stdin closed"
        self._sd_lock = threading.Lock()
        self._sd_done = False
        self._worker = None
        self._reader = None
        self._aux = []
        self._aux_lock = threading.Lock()
        self._next_cli_id = 0
        self.failed = False
        self._debug = bool(os.environ.get("MPY_BRIDGE_DEBUG"))

    # ------------------------------------------------------------------ output

    def emit(self, obj):
        """Write one NDJSON line (events and responses). Safe from any thread; a dead stdout means the parent is gone."""
        if self.cli:
            self._emit_cli(obj)
            return
        try:
            line = json.dumps(obj, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n"
        except (TypeError, ValueError) as exc:
            line = json.dumps({"ev": "log", "level": "error", "msg": "unserialisable output dropped: %s" % exc}).encode("ascii") + b"\n"
        if len(line) > MAX_LINE:  # section 2: never emit a line the client's reader may refuse
            if "id" in obj and "ev" not in obj:
                line = json.dumps(self._error_resp(obj.get("id"), BridgeError(
                    "E_PROTOCOL", "The answer is larger than the protocol's %d byte line limit." % MAX_LINE,
                    detail="response of %d bytes dropped" % len(line),
                    hint="Ask for less at a time (a smaller folder, fewer names).")), ensure_ascii=True,
                    separators=(",", ":")).encode("ascii") + b"\n"
            else:
                line = json.dumps({"ev": "log", "level": "error", "msg": "over-long %s event dropped (%d bytes)" % (
                    obj.get("ev"), len(line))}).encode("ascii") + b"\n"
        with self._out_lock:
            if self._out_dead or self._out is None:
                return
            try:
                view = memoryview(line)
                while view:
                    n = self._out.write(view)
                    view = view[n:] if n else view
            except (OSError, ValueError):
                self._out_dead = True
                self.quit_reason = "stdout closed"
                self.quit_event.set()  # the parent is gone: same as stdin EOF

    @staticmethod
    def _emit_cli(obj):
        """CLI mode: stdout is reserved for response JSON. Program/REPL text goes to stderr as text, other events as JSON."""
        ev = obj.get("ev")
        if ev == "log":
            return  # already printed as a [level] line
        try:
            if ev in ("out", "err", "repl"):
                sys.stderr.write(base64.b64decode(obj["b64"]).decode("utf-8", "replace"))
            else:
                sys.stderr.write("[event] %s\n" % json.dumps(obj, ensure_ascii=True, separators=(",", ":")))
            sys.stderr.flush()
        except (OSError, ValueError):
            pass

    def log(self, level, msg):
        if level == "debug" and not self._debug:
            return
        try:
            sys.stderr.write("[%s] %s\n" % (level, msg))
            sys.stderr.flush()
        except (OSError, ValueError):
            pass
        if level != "debug":
            self.emit({"ev": "log", "level": level, "msg": msg})

    def _link_log(self, level, msg):
        self.log("debug" if level == "debug" else level, "link: %s" % msg)

    def _emit_bytes(self, ev, data):
        for i in range(0, len(data), OUT_CHUNK):
            self.emit({"ev": ev, "b64": base64.b64encode(data[i:i + OUT_CHUNK]).decode("ascii")})

    def _on_pump_data(self, data):
        if self.repl_attached:
            self._emit_bytes("repl", data)
        self._note_pump(data)

    def hello(self):
        vend = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor", "mpremote")
        return {
            "ev": "hello", "proto": PROTO, "bridge": BRIDGE_VERSION,
            "python": "%d.%d.%d" % sys.version_info[:3], "pyserial": getattr(serial, "__version__", "?"),
            "platform": _platform_name(), "pid": os.getpid(),
            "vendored": {"mpremote": VENDORED_MPREMOTE if os.path.isdir(vend) else None},
        }

    # ------------------------------------------------------------------ state machine (protocol section 5)

    def _set_state(self, new, reason=None, **extra):
        with self._slock:
            prev = self.state
            if new == prev:
                return
            self.state = new
            if new == "idle":
                self._unsynced = False
                self._running_why = ""
        ev = {"ev": "state", "state": new, "prev": prev}
        if reason:
            ev["reason"] = reason
        if self.port:
            ev["port"] = self.port
        ev.update(extra)
        self.emit(ev)

    def _bump_conn(self):
        """The board behind this bridge may be a different one now (connect, disconnect, lost link). A reset.machine / reset.hard
        that was confirmed and queued before this must not run afterwards (op_reset_*: _same_connection)."""
        with self._gen_lock:
            self._conn_gen += 1

    def _on_link_dead(self, err):
        """Link.on_disconnect: the board went away (unplug, re-enumeration). Called from whichever thread noticed."""
        self._bump_conn()
        if self._board_reset_until and time.monotonic() < self._board_reset_until:
            # a reset that WE sent took the port with it (native USB re-enumerates): not an unplug. The Link is already closed
            # (_mark_dead); the client decides whether to reconnect, within a bounded window (addendum section 4).
            self._board_reset_until = 0.0
            self.log("info", "the board reset and dropped the port: %s" % (err.detail or err.message))
            self.repl_attached = False
            self._set_state("disconnected", reason="board-reset")
            link, self.link = self.link, None   # close it for good: later ops say E_NOT_CONNECTED, not "unplugged"
            if link is not None:
                try:
                    link.close()
                except Exception as exc:  # the port is already released by Link._mark_dead; this only resets the object
                    self.log("warn", "closing the Link after a board reset: %s" % describe_exception(exc))
            return
        self.log("warn", "connection to the board lost: %s" % (err.detail or err.message))
        self.repl_attached = False
        self._set_state("disconnected", reason="unplugged", error=err.code)

    def _need_link(self):
        link = self.link
        if link is None:
            raise BridgeError("E_NOT_CONNECTED", "No board is connected.")
        return link

    def _running_error(self, req):
        """Why a gated op was deferred. The hint is for a student; the flag a client sets to consent is in `detail` and in
        the machine-readable `needs_interrupt` (repeat the request with interrupt:true after asking the user)."""
        why = self._running_why or "running-program"
        detail = "state=running; sync=%s; op=%s; repeat with interrupt:true to interrupt it" % (why, req.op)
        # The code stays E_PROGRAM_RUNNING ("the board is not known to be idle; ask the user, then repeat with interrupt:true"):
        # that is the consent path the client already has, and nothing is sent to the board before it. Only the words
        # differ, so a student whose port never answers (wrong COM port, not MicroPython, a board left in the raw REPL after
        # a drop) is not sent looking for a program; `sync` is the machine-readable reason.
        if why == "silent":
            msg, hint = "The board did not answer.", _SILENT_HINT
        else:
            msg = {"prompt-unverified": "The board shows a prompt but a program may still be running.",
                   "unconfirmed": "A program may still be running on the board."}.get(why, "A program is running on the board.")
            hint = _RUNNING_HINT
        err = BridgeError("E_PROGRAM_RUNNING", msg, detail=detail, hint=hint)
        err.needs_interrupt = True
        err.sync = why
        return err

    # ------------------------------------------------------------------ request handling

    def handle(self, req):
        """Run one request to completion on the calling thread and return the response object."""
        try:
            res = getattr(self, req.method)(req)
            resp = {"id": req.id, "ok": True}
            if res:
                resp.update(res)
            return resp
        except BridgeError as exc:
            if exc.code not in ("E_CANCELLED",):
                self.log("warn" if exc.code != "E_PROGRAM_RUNNING" else "info",
                         "%s failed: %s %s" % (req.op, exc.code, exc.detail or exc.message))
            return {"id": req.id, "ok": False, "error": _err_dict(exc)}
        except Exception as exc:  # a bug: report it, keep serving
            tb = traceback.format_exc()
            self.log("error", "%s raised %s\n%s" % (req.op, type(exc).__name__, tb.rstrip()))
            err = BridgeError("E_INTERNAL", "Internal error in %s." % req.op, detail=tb)
            return {"id": req.id, "ok": False, "error": err.to_dict()}

    def _send(self, req, resp):
        if req.id is not None:  # internal requests have no id and no response
            self.emit(resp)

    def _error_resp(self, rid, err):
        return {"id": rid, "ok": False, "error": _err_dict(err)}

    def call(self, msg):
        """Synchronous dispatch for CLI mode and in-process use: validate, run on this thread, return the response."""
        self._next_cli_id += 1
        rid = msg.get("id", self._next_cli_id)
        op = msg.get("op")
        if not isinstance(op, str) or op not in _OPS or op.startswith("_"):
            return self._error_resp(rid, BridgeError("E_UNSUPPORTED", "Unknown operation %r." % (op,)))
        args = {k: v for k, v in msg.items() if k not in ("id", "op")}
        return self.handle(Request(rid, op, args))

    def dispatch_line(self, line):
        """Reader thread: one request line -> answer, helper thread or queue. Never raises."""
        rid = None
        try:
            try:
                msg = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, ValueError, RecursionError) as exc:
                self.emit(self._error_resp(None, _bad("The request is not valid JSON.", detail=str(exc)[:300])))
                return
            if not isinstance(msg, dict):
                self.emit(self._error_resp(None, _bad("A request must be a JSON object.", detail=type(msg).__name__)))
                return
            rid = msg.get("id")
            if "id" not in msg or isinstance(rid, bool) or not isinstance(rid, (int, str)):
                self.emit(self._error_resp(None, _bad("The request needs an \"id\" (integer).", detail="id=%r" % (rid,))))
                return
            op = msg.get("op")
            if not isinstance(op, str) or not op:
                self.emit(self._error_resp(rid, _bad("The request needs an \"op\" (string).", detail="op=%r" % (op,))))
                return
            if op not in _OPS or op.startswith("_"):
                self.emit(self._error_resp(rid, BridgeError(
                    "E_UNSUPPORTED", "Unknown operation %s." % op, detail="op=%s" % op,
                    hint="Update the extension and the bridge to matching versions.")))
                return
            req = Request(rid, op, {k: v for k, v in msg.items() if k not in ("id", "op")})
            if req.kind == "inline":
                self._send(req, self.handle(req))
            elif req.kind == "thread":
                self._spawn_aux(req)
            else:
                self._enqueue(req)
        except Exception as exc:  # the reader must survive anything
            self.log("error", "dispatch failed: %s\n%s" % (exc, traceback.format_exc().rstrip()))
            err = BridgeError("E_INTERNAL", "Internal error while reading a request.", detail=traceback.format_exc())
            self.emit(self._error_resp(rid if isinstance(rid, (int, str)) and not isinstance(rid, bool) else None, err))

    def _spawn_aux(self, req):
        def run():
            self._send(req, self.handle(req))
        t = threading.Thread(target=run, name="op-%s" % req.op, daemon=True)
        with self._aux_lock:
            self._aux = [x for x in self._aux if x.is_alive()]
            self._aux.append(t)
        t.start()

    def _enqueue(self, req):
        """Reader thread. Early answers that must not wait behind a running op, coalescing, then the queue."""
        if self.quitting:
            self._send(req, self._error_resp(req.id, BridgeError("E_CANCELLED", "The bridge is shutting down.")))
            return
        if req.op in ("reset.machine", "reset.hard") and req.args.get("confirmed") is not True:
            self._send(req, self._error_resp(req.id, self._unconfirmed(req.op)))  # same answer in every state; nothing is touched
            return
        if req.op in ("reset.machine", "reset.hard"):
            req.conn_gen = self._conn_gen  # the confirmation is for the connection that exists NOW (checked when it runs)
        if req.gate and self.state == "running" and not req.wants_interrupt \
                and (self.run_active or not self._prompt_candidate()):
            self._send(req, self._error_resp(req.id, self._running_error(req)))  # defers without touching the board
            return
        if self.run_active:
            if req.op in ("repl.attach", "repl.detach"):
                self._send(req, self.handle(req))  # only flips the view flag: the REPL view is plain bytes while a program runs
                return
            if req.op == "disconnect":
                # Answered at once, never queued behind the run. Dropping the port under a Run needs a decision, like a file op:
                # stopFirst:true stops the program and then closes; stopFirst:false closes and leaves it running (the run
                # answers exit:"disconnected"); with neither the request is refused and the port stays open.
                if isinstance(req.args.get("stopFirst"), bool):
                    self._spawn_aux(req)
                else:
                    err = BridgeError(
                        "E_PROGRAM_RUNNING", "A program is running on the board.",
                        detail="state=running; why=run; op=disconnect; repeat with stopFirst:true to stop it and disconnect, "
                               "or stopFirst:false to disconnect and leave it running",
                        hint="A program is still running on the board. Press Stop first, or confirm that it may be interrupted.")
                    err.needs_interrupt = True
                    err.sync = "run"
                    self._send(req, self._error_resp(req.id, err))
                return
            # the worker is inside `run`: ask the program to end so the queued op can start (explicit user intent only)
            if req.op in ("run", "reset.soft") or (req.gate and req.wants_interrupt):
                self._interrupt_async("%s while a program runs" % req.op)
            elif req.op == "reset.hard" and self.current is not None:
                self.current.cancel.set()  # stop following the stream; the hard reset needs the port
        if req.background and req.op == "fs.put" and isinstance(req.args.get("remote"), str):
            remote = req.args["remote"]
            for old in self.queue.take_where(lambda r: r.op == "fs.put" and r.background and r.args.get("remote") == remote):
                self._send(old, self._error_resp(old.id, BridgeError(
                    "E_CANCELLED", "Superseded by a newer write of the same file.",
                    detail="superseded by request %s" % (req.id,), hint="Nothing to do; the newer upload carries the latest content.")))
        if not self.queue.put(req):
            self._send(req, self._error_resp(req.id, BridgeError("E_CANCELLED", "The bridge is shutting down.")))

    def _interrupt_async(self, why):
        link = self.link
        if link is None:
            return

        def run():
            try:
                link.interrupt(timeout=3.0)
            except BridgeError as exc:
                self.log("warn", "interrupt (%s) failed: %s" % (why, exc.code))
        t = threading.Thread(target=run, name="interrupt", daemon=True)
        with self._aux_lock:
            self._aux.append(t)
        t.start()

    # ------------------------------------------------------------------ threads

    def _worker_main(self):
        while True:
            req = self.queue.get()
            if req is None:
                return
            if self.quitting or req.cancel.is_set():
                self._send(req, self._error_resp(req.id, BridgeError(
                    "E_CANCELLED", "The operation was cancelled before it started." if not self.quitting else "The bridge is shutting down.")))
                continue
            self.current = req
            try:
                resp = self.handle(req)
            except BaseException as exc:  # handle() converts everything; this keeps the port owner alive regardless
                self.log("error", "worker: %s: %s" % (type(exc).__name__, exc))
                resp = self._error_resp(req.id, BridgeError("E_INTERNAL", "Internal error in %s." % req.op, detail=traceback.format_exc()))
            finally:
                self.current = None
                req.finished.set()
            self._send(req, resp)
            self._replay_held()

    def _reader_main(self):
        stdin = self._stdin
        try:
            while not self.quitting:
                try:
                    line = stdin.readline(MAX_LINE + 1)
                except (OSError, ValueError):
                    line = b""
                if not line:
                    break
                if len(line) > MAX_LINE and not line.endswith(b"\n"):
                    rest_id = self._skip_rest_of_line(stdin)
                    m = _RE_ID.search(line[:ID_SCAN_PREFIX])  # key order is not part of the contract: also look past the prefix
                    self.emit(self._error_resp(int(m.group(1)) if m else rest_id, _bad(
                        "The request line is longer than %d bytes." % MAX_LINE,
                        hint="Send file contents through local paths, never inside the JSON.")))
                    continue
                line = line.strip()
                if line:
                    self.dispatch_line(line)
        except Exception as exc:  # pragma: no cover - dispatch_line never raises
            self.failed = True
            self.log("error", "reader crashed: %s\n%s" % (exc, traceback.format_exc().rstrip()))
        finally:
            if not self.quitting:
                self.log("info", "stdin closed: shutting down")
            self.shutdown_sequence("stdin closed")
            self.quit_event.set()

    @staticmethod
    def _skip_rest_of_line(stdin):
        """Discard the rest of an over-long line and return the last integer "id" seen in it (None if none): a client that
        serialises {"b64": ..., "id": 7, "op": ...} still gets its request resolved."""
        found, carry = None, b""
        while True:
            try:
                chunk = stdin.readline(65536)
            except (OSError, ValueError):
                return found
            if chunk:
                for m in _RE_ID.finditer(carry + chunk):
                    found = int(m.group(1))
                carry = (carry + chunk)[-48:]
            if not chunk or chunk.endswith(b"\n"):
                return found

    def start(self):
        self._worker = threading.Thread(target=self._worker_main, name="bridge-worker", daemon=True)
        self._worker.start()
        self._reader = threading.Thread(target=self._reader_main, name="bridge-reader", daemon=True)
        self._reader.start()

    def shutdown_sequence(self, reason="shutdown"):
        """Idempotent. RQ-SAFE-4: a running program is interrupted (Ctrl-C x2, <= 1 s) BEFORE the port is closed."""
        with self._sd_lock:
            if self._sd_done:
                return
            self._sd_done = True
            self.quitting = True
            link = self.link
            try:
                if link is not None and link.is_open and self.cfg["stopOnDisconnect"] \
                        and (self.state == "running" or self.run_active):
                    self.log("info", "%s: interrupting the running program before closing the port" % reason)
                    link.interrupt(timeout=1.0)
            except BridgeError as exc:
                self.log("warn", "could not interrupt the program: %s %s" % (exc.code, exc.detail))
            cur = self.current
            if cur is not None:
                cur.cancel.set()
            self._cancel_reconcile()
            self.queue.close()
            w = self._worker
            if w is not None and w is not threading.current_thread():
                w.join(4.0)
                if w.is_alive():
                    self.log("warn", "worker still busy at shutdown; closing the port under it")
            if link is not None:
                self.repl_attached = False
                link.close()
            with self._aux_lock:
                aux = list(self._aux)
            for t in aux:
                if t is not threading.current_thread():
                    t.join(2.0)
            if self.state != "disconnected":
                self._set_state("disconnected", reason=reason)
            self.link = None
            self.log("info", "bridge stopped (%s)" % reason)

    def wait(self):
        """Main thread: block until quit, then shut down. Returns the exit code."""
        try:
            while not self.quit_event.wait(0.5):
                pass
        except KeyboardInterrupt:
            pass
        self.shutdown_sequence(self.quit_reason if self.quit_event.is_set() else "interrupted")
        return 3 if self.failed else 0

    # ------------------------------------------------------------------ bypass / config ops

    def op_ping(self, req):
        return {}

    def op_shutdown(self, req):
        self.log("info", "shutdown requested")
        self.shutdown_sequence("shutdown")
        return {}

    def op_config(self, req):
        a = req.args
        new = dict(self.cfg)
        if "shadowGuard" in a:
            new["shadowGuard"] = _a_list_str(a, "shadowGuard")
        if "idleListenMs" in a:
            new["idleListenMs"] = _a_int(a, "idleListenMs", 400, 0, 60000)
        if "stopOnDisconnect" in a:
            new["stopOnDisconnect"] = _a_bool(a, "stopOnDisconnect", True)
        self.cfg = new
        return {}

    def op_cancel(self, req):
        target = req.args.get("target")
        if isinstance(target, bool) or not isinstance(target, (int, str)):
            raise _bad("cancel needs \"target\" (the id of the request to cancel).", detail="target=%r" % (target,))
        queued = self.queue.take_where(lambda r: r.id == target)
        for old in queued:
            self._send(old, self._error_resp(old.id, BridgeError("E_CANCELLED", "The operation was cancelled.")))
        if queued:
            return {"cancelled": True}
        cur = self.current
        if cur is not None and cur.id == target:
            cur.cancel.set()  # file ops stop at the next chunk; `run` stops following the program (use stop to end it)
            return {"cancelled": True}
        return {"cancelled": False}

    def op_tty_write(self, req):
        data = _a_b64(req.args)
        link = self._need_link()
        if self.run_active and not self.run_stdin:
            # stdin:false = the program gets no keystrokes, but Ctrl-C always means "interrupt" (RQ-RUN-1, RQ-SAFE-3)
            data = b"\x03" * data.count(b"\x03")
            if not data:
                return {}
        refused = None
        with self._hold_lock:
            if self.state == "rawop" or self._held:
                # raw keystrokes must not land inside a bridge-owned raw-REPL conversation; replayed afterwards, in order
                # (also while earlier held bytes still wait for their replay). Only Ctrl-C bytes go through at once ("Stop
                # always reaches the board"); the other bytes of the same write - a Ctrl-B/Ctrl-D that follows a Ctrl-C in a
                # paste - are held like any other keystroke, never smuggled into the conversation behind it. The held part is
                # all or nothing: a write that does not fit is refused whole (the Ctrl-C bytes still went), so what was
                # accepted stays in order and nothing is dropped behind an ok:true.
                interrupts = b"\x03" * data.count(b"\x03")
                rest = data.replace(b"\x03", b"")
                if rest and len(self._held) + len(rest) > HELD_TTY_MAX:
                    refused = _bad("The keystrokes were not sent: too many are waiting for a file operation to finish.",
                                   detail="held=%d new=%d limit=%d accepted=%d" % (len(self._held), len(rest), HELD_TTY_MAX, len(interrupts)),
                                   hint="Wait for the file operation to finish, then type again.")
                    refused.accepted = len(interrupts)
                else:
                    self._held += rest
                data = interrupts
        if data:
            link.write(data)
        if refused is not None:
            raise refused
        return {}

    def _replay_held(self):
        """Worker thread, AFTER the finished op's response has been sent: write the keystrokes that were held during the
        raw operation and relay the board's echo and result to the REPL view while this thread still owns the port. Doing
        it here (not inside the borrow) keeps the echo out of the op's own window and stops the next queued op
        (for example the orphan sweep) from swallowing it."""
        with self._hold_lock:
            if not self._held or self.state == "rawop":
                return
            data, self._held = bytes(self._held), bytearray()
        link = self.link
        if link is None or self.quitting:
            return
        try:
            with link.session():
                link.write(data)
                end = time.monotonic() + REPLAY_RELAY_MAX_S
                while link.relay(0.6, self._on_pump_data, 0.15) and time.monotonic() < end:
                    pass  # the echo of a long type-ahead takes longer than one window: keep relaying while it flows
        except BridgeError as exc:
            self.log("warn", "could not replay %d typed byte(s): %s" % (len(data), exc.code))

    def op_stop(self, req):
        """Ctrl-C x2. Overlapping Stops are coalesced: while one is in flight later ones wait for it and share its answer
        (a hundred impatient clicks put two Ctrl-C bytes on the wire, not two hundred)."""
        timeout = _a_int(req.args, "timeoutMs", 3000, 50, 60000) / 1000.0
        link = self._need_link()
        t0 = time.monotonic()
        with self._stop_lock:
            flight = self._stop_flight
            leader = flight is None
            if leader:
                flight = self._stop_flight = _StopFlight()
        if not leader:
            flight.done.wait(timeout + 3.0)
            if flight.error is not None:
                raise flight.error
            return {"stopped": bool(flight.stopped), "ms": int((time.monotonic() - t0) * 1000)}
        try:
            abandoned = self._abandoned_raw()
            stopped = bool(link.interrupt(timeout=min(timeout, 0.6) if abandoned else timeout))
            if not stopped and abandoned and self._abandoned_raw():
                # No prompt answered the Ctrl-C bytes. After an abandoned raw-REPL conversation that is also what a board
                # sitting silent at the raw prompt does (Ctrl-C prints nothing there); Ctrl-A tells the two apart.
                stopped = self._resync(link, timeout)
                if stopped:
                    self._set_state("idle", reason="stopped")
            elif stopped:
                self._after_stop(link)
            flight.stopped = stopped
        except BridgeError as exc:
            flight.error = exc
            raise
        finally:
            with self._stop_lock:
                self._stop_flight = None
            flight.done.set()
        return {"stopped": stopped, "ms": int((time.monotonic() - t0) * 1000)}

    def _abandoned_raw(self):
        """A raw-REPL conversation was dropped (cancelled Run, op that timed out) and nobody owns the port now: the board may
        still be in the raw REPL, possibly running the code."""
        return self._unsynced and self.state == "running" and not self.run_active and self.current is None

    def _after_stop(self, link):
        """A Stop reached a prompt. During a Run: arm the end-of-stream watchdog. Otherwise `running` -> `idle`, but only once
        the board is really at the friendly prompt: after an abandoned raw-REPL operation it may still be in the raw REPL."""
        if self.run_active:
            self._arm_watchdog()
        elif self.state == "running":
            if self._unsynced and self.current is None:
                if not self._resync(link):
                    return  # stays `running`: the board did not come back to the friendly REPL
            self._set_state("idle", reason="stopped")

    def _arm_watchdog(self):
        """A prompt came back after a Stop, so the run is over on the board; if its end-of-stream marker never reaches the
        worker (a lost trailer, an interrupted epilogue) the run must not wait for it forever: cancel the follow after a
        grace period and let op_run resynchronise (Ctrl-A path, never a reset)."""
        cur = self.current
        if cur is None or cur.op != "run" or cur.wd_armed:
            return
        cur.wd_armed = True

        def watch():
            if not cur.finished.wait(RUN_END_GRACE) and not cur.cancel.is_set():
                cur.watchdog = True
                self.log("warn", "run %s: the board is back at a prompt but the end of the program's output never came; "
                                 "resynchronising" % (cur.id,))
                cur.cancel.set()
        threading.Thread(target=watch, name="run-watchdog", daemon=True).start()

    def _resync(self, link, timeout=RESYNC_TIMEOUT):
        """Bring a board that may still be in the raw REPL back to the friendly one: Ctrl-C, Ctrl-A (re-prints the raw banner,
        never resets), Ctrl-B. Only used after the user pressed Stop. True when the friendly prompt was seen."""
        try:
            with link.session():
                link.enter_raw(soft_reset=False, timeout=min(max(1.0, timeout), RESYNC_TIMEOUT))
                return bool(link.exit_raw(redraw=self.repl_attached))
        except BridgeError as exc:
            self.log("warn", "could not resynchronise the REPL: %s %s" % (exc.code, exc.detail or exc.message))
            return False

    def op_ports_list(self, req):
        try:
            found = list(list_ports.comports())
        except Exception as exc:  # enumeration is OS-specific; never fatal
            raise BridgeError("E_INTERNAL", "Could not list the serial ports.", detail=describe_exception(exc))
        rows = []
        for p in found:
            device = p.device or ""
            if sys.platform == "darwin" and not device.startswith("/dev/cu."):
                continue  # /dev/tty.* is the call-in node: opening it can block (08 failure #5)
            text = " ".join(str(x or "") for x in (p.manufacturer, p.product, p.description)).lower()
            score = _VID_SCORE.get(p.vid, 0) if p.vid is not None else 0
            if not score and any(h in text for h in _TEXT_HINTS):
                score = 1
            rows.append((score, {
                "device": device, "vid": p.vid, "pid": p.pid, "serial": p.serial_number or "",
                "manufacturer": p.manufacturer or "", "product": p.product or "",
                "description": p.description or "", "hwid": p.hwid or "", "likelyBoard": score > 0,
            }))
        rows.sort(key=lambda r: (-r[0], r[1]["device"]))
        return {"ports": [r[1] for r in rows]}

    # ------------------------------------------------------------------ connection ops

    def op_connect(self, req):
        a = req.args
        port = _a_str(a, "port")
        baud = _a_int(a, "baud", 115200, 50, 4000000)
        policy = a.get("openPolicy", "auto")
        if not isinstance(policy, str):
            raise _bad("openPolicy must be a string.", detail="openPolicy=%r" % (policy,))
        if self.link is not None and self.link.is_open:
            raise BridgeError("E_ALREADY_CONNECTED", "Already connected to %s." % self.port)
        safe_mode_check(port)  # E_SAFE_MODE before ANY OS call, including port enumeration (section 8)
        if port.strip().lower() == "auto":
            raise _bad("\"auto\" is a UI choice, never a port name.", hint="Pick one port from ports.list (D-11).")
        norm = normalize_port(port)
        usb_ids = None
        if port_kind(norm) == "device":
            vid, pid = a.get("vid"), a.get("pid")
            ids = (vid, pid) if isinstance(vid, int) and isinstance(pid, int) else lookup_usb_ids(norm)
            usb_ids = ids if ids and ids[0] is not None else None
        self._bump_conn()
        old, self.link = self.link, None
        if old is not None:
            old.close()
        link = Link(log=self._link_log)
        link.on_disconnect = self._on_link_dead
        self.link, self.port = link, port
        self.identity_cache = None
        self.caps_compile = None
        self.run_active = False
        self.repl_attached = False
        self._orphans_pending = True
        self._pump_win, self._unsynced, self._running_why = b"", False, ""
        self._board_reset_until = 0.0
        self._cancel_reconcile()
        self._set_state("connecting", port=port)
        listen = self.cfg["idleListenMs"]
        try:
            info = link.open(port, baud=baud, policy=policy, usb_ids=usb_ids)
            verdict = link.sync_to_prompt(listen_ms=listen, nudge_ms=listen)
            link.attach_repl(self._on_pump_data)  # background pump: unplug detection, REPL bytes when attached
        except Exception:
            link.close()
            self.link = None
            self._bump_conn()
            self._set_state("disconnected", reason="connect-failed")
            raise
        self._bump_conn()  # also for a reset stamped while this connect was in flight: it was not confirmed for THIS board
        new_state = "idle" if verdict == "prompt" else "running"  # unverified/silent: conservative
        self._running_why = _WHY_BY_VERDICT.get(verdict, "running-program")
        self._set_state(new_state, reason=verdict)
        self.log("info", "connected to %s (%s, sync=%s)" % (info["port"], new_state, verdict))
        return {"state": "unknown" if verdict == "silent" else new_state, "sync": verdict, "portInfo": info}

    def op_disconnect(self, req):
        """Close the port. A running program is NOT stopped unless stopFirst:true (section 3). During a Run this executes on a
        helper thread (the worker is inside the run): the port closes under it and the run answers exit:"disconnected"."""
        link = self.link
        if link is None:
            return {}
        if req.args.get("stopFirst") is True and link.is_open and (self.state == "running" or self.run_active):
            try:
                link.interrupt(timeout=1.0)
            except BridgeError as exc:
                self.log("warn", "stopFirst: %s" % exc.code)
            if self.run_active:
                self._run_done.wait(1.0)  # let the run read the end of the program (exit:"interrupted") before the port goes
        self._cancel_reconcile()
        self.repl_attached = False
        link.close()
        self.link = None
        self._bump_conn()
        self._set_state("disconnected", reason="disconnect")
        self.log("info", "disconnected from %s" % self.port)
        return {}

    def op_repl_attach(self, req):
        link = self._need_link()
        link.check_alive()
        self.repl_attached = True
        if self.state == "idle":
            link.write(b"\r")  # redraw the prompt for the new view; harmless at an idle friendly prompt
        return {}

    def op_repl_detach(self, req):
        self.repl_attached = False
        return {}

    # ------------------------------------------------------------------ `running` -> `idle` on evidence

    def _prompt_candidate(self):
        """The pump saw the friendly REPL start (banner, then the prompt, nothing after): worth one harmless verification."""
        return bool(_RE_BANNER_PROMPT.search(self._pump_win))

    def _note_pump(self, data):
        """Every byte the pump (or a relay) saw. Feeds the evidence window and, when a banner+prompt arrives while the bridge
        believes a program runs (a connect-time main.py that ended, a board that finished booting), schedules a verification."""
        self._pump_win = (self._pump_win + data)[-1024:]
        self._pump_t = time.monotonic()
        if self.state == "running" and not self.run_active and not self.cli and not self.quitting \
                and _RE_BANNER_PROMPT.search(self._pump_win):
            self._arm_reconcile()

    def _arm_reconcile(self):
        with self._rc_lock:
            if self._rc_timer is not None:
                self._rc_timer.cancel()
            t = threading.Timer(RECONCILE_QUIET_S, self._queue_reconcile)
            t.daemon = True
            self._rc_timer = t
            t.start()

    def _cancel_reconcile(self):
        with self._rc_lock:
            t, self._rc_timer = self._rc_timer, None
        if t is not None:
            t.cancel()

    def _queue_reconcile(self):
        if not self.quitting:
            self.queue.put(Request(None, "_reconcile", {}))

    def op_reconcile(self, req):
        link = self.link
        if link is None or self.state != "running" or self.run_active or not self._prompt_candidate():
            return {}
        if time.monotonic() - self._pump_t < RECONCILE_QUIET_S * 0.8:
            self._arm_reconcile()  # more bytes arrived meanwhile: wait for quiet again
            return {}
        self._verify_idle(link, "prompt seen")
        return {}

    def _verify_idle(self, link, reason):
        """From `running` to `idle` on evidence, never on a guess: the prompt must have been quiet and the board must answer
        a bare newline with a fresh prompt (Link.sync_to_prompt: no Ctrl-C, no Ctrl-D, no raw REPL). A program blocked in
        input('>>> ') has no banner before its prompt, so it never gets here. Worker thread (or any thread that may take the
        port). True when the state is now idle."""
        if self.run_active:
            return False
        try:
            with link.session():
                if self.state != "running":
                    return self.state == "idle"
                verdict = link.sync_to_prompt(listen_ms=120, nudge_ms=max(200, self.cfg["idleListenMs"]),
                                              on_data=self._on_pump_data)
        except BridgeError as exc:
            self.log("debug", "verification skipped: %s" % exc.code)
            return False
        self._pump_win = b""
        if verdict == "prompt":
            self._set_state("idle", reason=reason)
            return True
        self._running_why = _WHY_BY_VERDICT.get(verdict, "running-program")
        return False

    # ------------------------------------------------------------------ borrowing the port for file ops

    @contextlib.contextmanager
    def _borrow(self, req):
        link = self._need_link()
        link.check_alive()
        if self.state == "running" and not req.wants_interrupt:
            if not (self._prompt_candidate() and self._verify_idle(link, "prompt seen")):
                raise self._running_error(req)
        with link.session():
            prev = self.state
            self._set_state("rawop", reason=req.op)
            entered = confirmed = False
            try:
                link.enter_raw(soft_reset=False, timeout=ENTER_RAW_TIMEOUT)
                entered = True
                yield lambda code, timeout=10.0: link.exec(code, timeout)
            except BridgeError as exc:
                if not entered and exc.code == "E_RAW_REPL_TIMEOUT":
                    prev = "running"  # Ctrl-C and Ctrl-A got no answer: never claim an idle board that does not answer
                    self._running_why = self._running_why or "unconfirmed"
                raise
            finally:
                if entered:
                    try:
                        confirmed = bool(link.exit_raw(redraw=self.repl_attached))
                    except BridgeError as exc:
                        self.log("warn", "could not return to the friendly REPL: %s" % exc.code)
                if self.state == "rawop":
                    if entered and not confirmed:
                        # the friendly prompt did not come back (an exec that timed out leaves its loop running in the raw REPL):
                        # not idle until a Stop or a verified prompt says so
                        self._unsynced, self._running_why = True, "unconfirmed"
                        self._set_state("running", reason="%s: no prompt afterwards" % req.op)
                    else:
                        self._set_state("idle" if entered else prev, reason="%s done" % req.op)

    def _file_op(self, req, fn, isolate=True):
        """Run fn(exec_fn) with the raw REPL borrowed. Device snippets run in a namespace of their own (isolate): the raw
        REPL shares __main__ with the student's REPL, and a snippet that binds `d`, `n` or `p` would silently overwrite the
        student's variables. `exec` (the diagnostic op) is the one op that deliberately runs in the shared namespace."""
        with self._borrow(req) as exec_fn:
            res = fn((lambda code, timeout=10.0: exec_fn(_isolated(code), timeout)) if isolate else exec_fn)
        if self._orphans_pending and not self.cli and not self.quitting and req.op != "_clean_orphans":
            self._orphans_pending = False  # once per session, after the first successful borrow (never on connect)
            self.queue.put(Request(None, "_clean_orphans", {}))
        return res

    def _local(self, args, key):
        """A `local` argument: a non-empty string and ABSOLUTE (section 2). The bridge's working folder is a neutral temp
        folder, so a relative path would silently put the student's file where nobody looks. CLI mode runs in the person's
        own folder, where a relative path is natural: it is resolved against that folder."""
        v = _a_str(args, key)
        if not os.path.isabs(v):
            if self.cli:
                return os.path.abspath(v)
            raise _bad("Local paths must be absolute.", detail="%s=%r" % (key, v),
                       hint="Send the full path of the file, for example C:\\Users\\you\\lab1\\main.py or /Users/you/lab1/main.py.")
        return v

    def _progress(self, req):
        last = [0.0]

        def cb(done, total, label):
            now = time.monotonic()
            if (total and done >= total) or now - last[0] >= 0.1:
                last[0] = now
                self.emit({"ev": "progress", "id": req.id, "label": label, "done": done, "total": total})
        return cb

    def _shadow(self):
        names = list(self.cfg["shadowGuard"])
        roots = None
        ident = self.identity_cache
        if ident:
            names += ident.get("profileHints", {}).get("modules", [])
            sp = ident.get("syspath", [])
            roots = [p for p in sp if isinstance(p, str) and p.startswith("/")]
            if any(p in ("", ".") for p in sp) and "/" not in roots:
                roots.insert(0, "/")  # '' (the working folder) is an import root too
            roots = roots or None
        return sorted(set(names)), roots

    def _precheck_shadow(self, path, kind):
        names, roots = self._shadow()
        if names:
            devfs.check_shadow(devfs._norm(path, allow_root=False), names, roots, kind=kind)  # before the board is touched
        return names, roots

    # ------------------------------------------------------------------ identity and file ops

    def _remember_identity(self, res):
        link = self.link
        res["caps"]["paste"] = bool(link.raw_paste_supported) if link is not None else False  # filled from the Link
        res["caps"]["machine"] = bool(res.get("uniqueId"))  # `import machine; machine.unique_id()` worked: reset.machine can try
        self.identity_cache = res
        self.caps_compile = bool(res["caps"].get("compile"))
        return res

    def op_identity(self, req):
        return self._remember_identity(self._file_op(req, lambda ef: devfs.identity(ef)))

    def op_fs_list(self, req):
        path = _a_str(req.args, "path")
        return self._file_op(req, lambda ef: devfs.list_dir(ef, path))

    def op_fs_manifest(self, req):
        a = req.args
        root, h, ex = _a_str(a, "root"), _a_bool(a, "hash", True), _a_list_str(a, "exclude")
        cb = self._progress(req)
        return self._file_op(req, lambda ef: devfs.manifest(ef, root, hash=h, exclude=ex, progress=cb))

    def op_fs_stat(self, req):
        path = _a_str(req.args, "path")
        return self._file_op(req, lambda ef: devfs.stat(ef, path))

    def op_fs_put(self, req):
        a = req.args
        local, remote = self._local(a, "local"), _a_str(a, "remote")
        mkdirs, expect = _a_bool(a, "mkdirs", True), _a_str(a, "expectSha", required=False)
        if_sha = _a_str(a, "ifSha", required=False)
        if if_sha is not None and if_sha != "absent" and not re.match(r"^[0-9a-fA-F]{64}$", if_sha):
            raise _bad("The argument 'ifSha' must be \"absent\" or a hex sha256.", detail="ifSha=%r" % (if_sha,))
        kw = {}
        if "chunk" in a:
            kw["chunk"] = _a_int(a, "chunk", 1024, 16, 8192)
        names, roots = self._precheck_shadow(remote, "file")
        cb = self._progress(req)
        return self._file_op(req, lambda ef: devfs.put_file(
            ef, local, remote, mkdirs=mkdirs, expect_sha=expect, progress=cb, cancel=req.cancel,
            shadow_guard=names, shadow_roots=roots, if_sha=if_sha, **kw))

    def op_fs_get(self, req):
        a = req.args
        remote, local = _a_str(a, "remote"), self._local(a, "local")
        cb = self._progress(req)
        return self._file_op(req, lambda ef: devfs.get_file(ef, remote, local, progress=cb, cancel=req.cancel))

    def op_fs_rm(self, req):
        path = _a_str(req.args, "path")
        return self._file_op(req, lambda ef: devfs.rm(ef, path))

    def op_fs_rmtree(self, req):
        a = req.args
        path = _a_str(a, "path")
        if a.get("confirm") is not True:
            raise _bad("Deleting a folder needs confirm:true.", detail="confirm=%r" % (a.get("confirm"),),
                       hint="Ask the user to confirm, then repeat the request with confirm:true.")
        allow_mount = _a_bool(a, "allowMount", False)
        cb = self._progress(req)
        return self._file_op(req, lambda ef: devfs.rmtree(ef, path, confirm=True, allow_mount=allow_mount, progress=cb, cancel=req.cancel))

    def op_fs_mkdir(self, req):
        a = req.args
        path, parents = _a_str(a, "path"), _a_bool(a, "parents", True)
        names, roots = self._precheck_shadow(path, "dir")
        return self._file_op(req, lambda ef: devfs.mkdir(ef, path, parents=parents, shadow_guard=names, shadow_roots=roots))

    def op_fs_mv(self, req):
        a = req.args
        src, dst = _a_str(a, "src"), _a_str(a, "dst")
        names, roots = self._shadow()
        if names and src != dst:
            devfs.check_shadow(devfs._norm(dst, allow_root=False), names, roots, kind="any")
        return self._file_op(req, lambda ef: devfs.mv(ef, src, dst, shadow_guard=names, shadow_roots=roots))

    def op_exec(self, req):
        a = req.args
        code = _a_str(a, "code")
        timeout = _a_int(a, "timeoutMs", 10000, 100, 3600000) / 1000.0

        def go(ef):
            out, err = ef(code, timeout)
            # bounded answer (section 2: lines are limited to 4 MiB): the head of stdout, the tail of stderr (the exception
            # is at the end), and truncated:true when either was cut
            cut_out, cut_err = len(out) > EXEC_MAX_BYTES, len(err) > EXEC_MAX_BYTES
            res = {"out": out[:EXEC_MAX_BYTES].decode("utf-8", "replace"),
                   "err": err[-EXEC_MAX_BYTES:].decode("utf-8", "replace")}
            if cut_out or cut_err:
                res["truncated"] = True
                res["outBytes"], res["errBytes"] = len(out), len(err)
            return res
        return self._file_op(req, go, isolate=False)

    def op_introspect(self, req):
        names = _a_list_str(req.args, "names")
        return self._file_op(req, lambda ef: devfs.introspect_modules(ef, names or None))

    def op_clock_read(self, req):
        return self._file_op(req, lambda ef: devfs.clock_read(ef))

    def op_clock_set(self, req):
        t = req.args.get("time")
        if (not isinstance(t, list) or len(t) != 7
                or not all(isinstance(x, int) and not isinstance(x, bool) for x in t)):
            raise _bad("clock.set needs 'time' as [year, month, day, hour, minute, second, weekday] (integers).",
                       detail="time=%r" % (t,))
        try:
            devfs_fields = [int(x) for x in t]
            for v, lo, hi in zip(devfs_fields, (2000, 1, 1, 0, 0, 0, 0), (2099, 12, 31, 23, 59, 59, 6)):
                if not lo <= v <= hi:
                    raise ValueError("%d is outside %d..%d" % (v, lo, hi))
        except ValueError as exc:
            raise _bad("clock.set got a time field out of range.", detail=str(exc))
        return self._file_op(req, lambda ef: devfs.clock_set(ef, devfs_fields))

    def op_clean_orphans(self, req):
        """Once per session, lowest priority, after the first file op. Walks the board's filesystem for stale *.mpytmp files.
        A port that runs on a host OS (the unix port, our test VM) has the HOST disk as its '/': never sweep that."""
        if self.state != "idle" or self.link is None:
            return {}

        def sweep(ef):
            ident = self.identity_cache
            if ident is None:
                ident = self._remember_identity(devfs.identity(ef))
            if ident.get("platform", "").lower().startswith(_HOST_PLATFORMS):
                return {"skipped": ident["platform"]}
            return devfs.clean_orphans(ef, "/")
        try:
            res = self._file_op(req, sweep)
            if res.get("skipped"):
                self.log("info", "orphan sweep skipped: this port runs on a host OS (%s), its '/' is not a board filesystem" % res["skipped"])
            elif res.get("removed"):
                self.log("info", "removed %d leftover upload temp file(s): %s" % (len(res["removed"]), ", ".join(res["removed"][:5])))
        except BridgeError as exc:
            self.log("warn", "orphan cleanup skipped: %s %s" % (exc.code, exc.detail or exc.message))
        return {}

    # ------------------------------------------------------------------ run and resets

    def _read_program(self, args):
        local, source = args.get("local"), args.get("source")
        if (local is None) == (source is None):
            raise _bad("run needs exactly one of \"local\" (a file path) or \"source\" (program text).")
        if local is not None:
            if not isinstance(local, str) or not local:
                raise _bad("\"local\" must be a file path.", detail="local=%r" % (local,))
            local = self._local(args, "local")
            raw = devfs._read_local(local)  # E_LOCAL_IO with the OS reason
            try:
                source = raw.decode("utf-8-sig")
            except UnicodeDecodeError as exc:
                raise BridgeError("E_LOCAL_IO", "%s is not UTF-8 text." % local, detail=str(exc),
                                  hint="Save the file as UTF-8 and run it again.")
        elif not isinstance(source, str):
            raise _bad("\"source\" must be text.", detail=type(source).__name__)
        name = args.get("name")
        if name is not None and not isinstance(name, str):
            raise _bad("\"name\" must be text.", detail="name=%r" % (name,))
        return source, name or (local if local is not None else "<stdin>")

    def _compile_supported(self, link):
        if self.caps_compile is None:
            out, err = link.exec(_COMPILE_PROBE, 10.0)
            self.caps_compile = b"@@C1" in out and not err.strip()
        return self.caps_compile

    def _run_code(self, source, name):
        if self.caps_compile:
            return "exec(compile(%s, %s, \"exec\"), {\"__name__\": \"__main__\"})\n" % (repr(source), repr(name))
        return source

    def _precheck_run(self, link, req, source, name):
        """Reject a program the raw REPL cannot carry BEFORE anything is sent to the board (a rejected Run must not have
        interrupted or soft-reset it). Only a literal Ctrl-C/Ctrl-D in the text can be refused, and only when the board
        cannot compile (the wrapped form escapes them); when that is not known yet it is asked once, without a reset."""
        try:
            data = source.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise _bad("The program text is not valid Unicode.", detail=str(exc)[:200])
        if b"\x03" not in data and b"\x04" not in data:
            return
        if self.caps_compile is None:
            if self.state == "running":
                return  # asking needs the raw REPL, i.e. interrupting a program that may not be ours to stop: decide later
            with link.session():
                link.enter_raw(soft_reset=False, timeout=ENTER_RAW_TIMEOUT, cancel=req.cancel)
                try:
                    self._compile_supported(link)
                finally:
                    link.exit_raw(redraw=False)
        err = _control_bytes_error(self._run_code(source, name).encode("utf-8"))
        if err is not None:
            raise err

    def op_run(self, req):
        a = req.args
        source, name = self._read_program(a)   # every argument is checked before the board is touched
        reset, stdin = _a_bool(a, "reset", True), _a_bool(a, "stdin", True)
        link = self._need_link()
        link.check_alive()
        self._precheck_run(link, req, source, name)
        entered, exit_kind, duration, confirmed = False, "ok", 0, False
        self.run_active, self.run_stdin = True, stdin
        self._run_done.clear()
        self._running_why = "run"
        try:
            if self.state == "running":  # stop whatever runs (RQ-RUN-1); never a reset
                link.interrupt(timeout=3.0)
            with link.session():
                self._set_state("running", reason="run")
                try:
                    boot = link.enter_raw(soft_reset=reset, timeout=ENTER_RAW_TIMEOUT, cancel=req.cancel)
                    entered = True
                    if boot:
                        self._emit_bytes("out", boot)  # boot.py output of the soft reset
                    self._compile_supported(link)
                    code = self._run_code(source, name)
                    t0 = time.monotonic()
                    try:
                        err = link.exec_stream(code, lambda d: self._emit_bytes("out", d), timeout=None, cancel=req.cancel)
                    finally:
                        duration = int((time.monotonic() - t0) * 1000)
                    if err:
                        self._emit_bytes("err", err)
                    text = err.decode("utf-8", "replace")
                    exit_kind = "interrupted" if _RE_KBD_INT.search(text) else ("exception" if text.strip() else "ok")
                except BridgeError as exc:
                    if exc.code in ("E_NO_DEVICE", "E_NOT_CONNECTED"):
                        exit_kind, entered = "disconnected", False  # the state event says why
                    elif exc.code == "E_CANCELLED" and req.watchdog:
                        # a Stop was answered by a prompt but the end of the program's output never arrived: the board is
                        # back at a prompt, in the raw REPL. Resynchronise (Ctrl-A path, no reset); the user asked to stop.
                        entered = False
                        if not self._resync(link):
                            self._unsynced = True
                            raise BridgeError(
                                "E_BOARD_UNRESPONSIVE", "The board did not finish stopping the program.",
                                detail="Stop reached a prompt but the end of the run never arrived; resynchronising failed",
                                hint="Press Stop again. If the board still does not answer, press its reset button.")
                        exit_kind = "interrupted"
                        self._set_state("idle", reason="stopped")
                    elif exc.code == "E_CANCELLED":
                        entered = False  # stopped following the stream: the program may still run, the state stays `running`
                        self._unsynced = True
                        raise
                    else:
                        self._unsynced = True  # framing is in doubt: the board may still be in the raw REPL
                        raise
                finally:
                    if entered:
                        try:
                            confirmed = bool(link.exit_raw(redraw=self.repl_attached))
                        except BridgeError as exc:
                            self.log("warn", "could not return to the friendly REPL: %s" % exc.code)
                    if entered and confirmed and self.state in ("running", "rawop"):
                        self._set_state("idle", reason="program ended")
                    elif entered and not confirmed:
                        # no friendly prompt afterwards (the program may still run): never claim an idle board
                        self._unsynced, self._running_why = True, "unconfirmed"
        finally:
            self.run_active = False
            self._run_done.set()
        return {"exit": exit_kind, "durationMs": duration}

    def op_reset_soft(self, req):
        skip_main = req.args.get("skipMain", False)
        if not isinstance(skip_main, bool):
            raise _bad("reset.soft: skipMain must be true or false.", detail="skipMain=%r" % (skip_main,))
        link = self._need_link()
        link.check_alive()
        if self.state == "running" and not link.interrupt(timeout=3.0):
            raise BridgeError("E_BOARD_UNRESPONSIVE", "The running program did not stop, so the board cannot be restarted from here.",
                              detail="Ctrl-C x2 gave no prompt within 3 s")
        if skip_main:
            # Ctrl-D in the RAW REPL: the ports run boot.py but start main.py only in friendly mode, so a student's main.py
            # (which may drive motors) does not start. Used after the IntelliSense imports, which the student did not ask to run.
            boot = link.enter_raw(soft_reset=True, timeout=10.0)
            if boot:
                self._on_pump_data(boot)
            verdict = "prompt" if link.exit_raw() else "prompt-unverified"
        else:
            verdict = link.soft_reset_friendly(wait=3.0, on_data=self._on_pump_data)
        self._running_why = _WHY_BY_VERDICT.get(verdict, "running-program")
        self._set_state("idle" if verdict == "prompt" else "running", reason="reset.soft (%s)" % verdict)
        return {}

    # ------------------------------------------------------------------ reset tiers above soft (D-16, protocol Appendix D)

    @staticmethod
    def _unconfirmed(op):
        what = "Rebooting the board" if op == "reset.machine" else "A hardware reset"
        return _bad("%s needs confirmed:true." % what, detail="confirmed must be the JSON value true; op=%s" % op,
                    hint="Show the user the reset warning, then repeat the request with confirmed:true.")

    def _need_confirmed(self, req):
        if req.args.get("confirmed") is not True:
            raise self._unconfirmed(req.op)

    def _expect_board_reset(self):
        self._board_reset_until = time.monotonic() + BOARD_RESET_WINDOW_S

    def _same_connection(self, req):
        """The confirmation of a reset is for the board that was connected when the request arrived. A connect, disconnect or
        lost link since then (priority 1 jumps the queue, so it can happen while the request waits behind a slow op) makes it
        stale: refuse, send nothing. The user must confirm again for the board that is connected now."""
        if req.conn_gen is not None and req.conn_gen != self._conn_gen:
            raise BridgeError(
                "E_CANCELLED", "The board connection changed after the reset was confirmed, so nothing was sent.",
                detail="op=%s; the connection generation moved %d -> %d (connect, disconnect or lost link while the request waited)"
                       % (req.op, req.conn_gen, self._conn_gen),
                hint="Check which board is connected now and ask for the reset again.")

    @staticmethod
    def _a_learned(args):
        v = args.get("learned")
        if v is not None and v not in resetcap.LEARNED:
            raise _bad("The argument 'learned' must be \"verified\", \"failed\" or null.", detail="learned=%r" % (v,))
        return v

    def _reset_key(self, link):
        """What the client caches a verification under: (VID, PID, machine.unique_id()). Null parts are unknown."""
        vid, pid = getattr(link, "usb_ids", None) or (None, None)
        uid = (self.identity_cache or {}).get("uniqueId") or None
        return {"vid": vid, "pid": pid, "uniqueId": uid}

    def _hard_capability(self, link, learned=None):
        """resetcap.estimate for the connected board, or None when the link cannot say (a test double). No I/O."""
        info = getattr(link, "port_info", None)
        if not info:
            return None
        key = self._reset_key(link)
        if learned is None and key["uniqueId"] is not None:   # without machine.unique_id() the key is the adapter model alone
            learned = self._learned.get((key["vid"], key["pid"], key["uniqueId"]))
        kind = "device" if getattr(link, "line_driver", None) is not None else info.get("kind", "device")
        return resetcap.estimate(key["vid"], key["pid"], (self.identity_cache or {}).get("platform"), kind, learned)

    def _machine_capability(self):
        if self.link is None or self.state not in ("idle", "running", "rawop"):
            return False, "The board is not connected and ready."
        caps = (self.identity_cache or {}).get("caps") or {}
        if caps.get("machine") is False:
            return False, "This firmware has no machine module (or machine.unique_id()), so it cannot reboot itself."
        why = "Needs no control lines, only a REPL that answers."
        if self.identity_cache is None:
            why += " The board identity has not been read yet; the first attempt will tell."
        if self.state == "running":
            why += " The running program is interrupted first (confirm with interrupt:true)."
        return True, why

    def op_reset_capability(self, req):
        """The three tiers this connection offers (addendum section 2). No I/O: adapter metadata + the cached identity."""
        link = self.link
        if link is None or not link.is_open:
            raise BridgeError("E_NOT_CONNECTED", "No board is connected.")
        learned = self._a_learned(req.args)
        available, why = self._machine_capability()
        hard = self._hard_capability(link, learned)
        return {"soft": True, "machine": {"available": available, "reason": why}, "hard": hard,
                "cacheKey": self._reset_key(link)}

    def _finish_board_reset(self, verdict):
        """The board came back after a reset we sent: idle only on evidence of a prompt, else `running` (conservative)."""
        self._board_reset_until = 0.0
        self._pump_win, self._unsynced = b"", False
        self._running_why = _WHY_BY_VERDICT.get(verdict, "running-program")
        self._set_state("idle" if verdict == "prompt" else "running", reason="board-reset (%s)" % verdict)

    def op_reset_machine(self, req):
        """`import machine; machine.reset()` through the raw REPL (D-16 tier 2): a real chip reset that needs no control lines.
        Requires confirmed:true and an idle board (or interrupt:true after the client asked the user). The command is
        acknowledged, not awaited; the link may drop (native USB re-enumerates): state `disconnected`, reason `board-reset`,
        and the CLIENT reconnects. Otherwise the bridge re-syncs to the prompt on the same link (no further reset)."""
        self._need_confirmed(req)
        self._same_connection(req)
        link = self._need_link()
        link.check_alive()
        caps = (self.identity_cache or {}).get("caps") or {}
        if caps.get("machine") is False:
            raise BridgeError("E_UNSUPPORTED", "This board cannot reboot itself from here.",
                              detail="identity.caps.machine is false: no machine module or no machine.unique_id()",
                              hint="Press the board's reset button, or use Restart Python (soft reset).")
        if self.state == "running" and not req.wants_interrupt:
            if not (self._prompt_candidate() and self._verify_idle(link, "prompt seen")):
                raise self._running_error(req)
        with link.session():
            self._set_state("rawop", reason=req.op)
            entered = False
            try:
                link.enter_raw(soft_reset=False, timeout=ENTER_RAW_TIMEOUT, cancel=req.cancel)
                entered = True
                self._expect_board_reset()  # BEFORE the bytes leave: the port may vanish while they are still being read back
                sent = link.machine_reset(confirm=RESET_CONFIRMED)
            except BridgeError as exc:
                self._board_reset_until = 0.0
                if self.state == "rawop":
                    confirmed = False
                    if entered and exc.code == "E_UNSUPPORTED":  # machine.reset() raised: the board is fine, back to the prompt
                        try:
                            confirmed = bool(link.exit_raw(redraw=self.repl_attached))
                        except BridgeError as exc2:
                            self.log("warn", "could not return to the friendly REPL: %s" % exc2.code)
                    if confirmed:
                        self._set_state("idle", reason="reset.machine unsupported")
                    else:
                        self._unsynced, self._running_why = True, "unconfirmed"
                        self._set_state("running", reason="reset.machine: %s" % exc.code)
                raise
            self.log("info", "reset.machine sent (ack=%s, dropped=%s)" % (sent.get("ack"), sent.get("dropped")))
            if self.state == "disconnected" or sent.get("dropped"):
                return {"phase": "sent", "portDropped": True, "reconnect": True}
            self._set_state("connecting", reason="board-reset")
            listen = max(self.cfg["idleListenMs"], RESET_BOOT_LISTEN_MS)
            try:
                verdict = link.sync_to_prompt(listen_ms=listen, nudge_ms=listen, on_data=self._on_pump_data)
            except BridgeError as exc:
                if exc.code in ("E_NO_DEVICE", "E_NOT_CONNECTED"):  # the port went away while the board booted
                    if self.state != "disconnected":
                        self._set_state("disconnected", reason="board-reset")
                    self._board_reset_until = 0.0
                    return {"phase": "sent", "portDropped": True, "reconnect": True}
                self._board_reset_until = 0.0
                self._unsynced, self._running_why = True, "unconfirmed"
                self._set_state("running", reason="board-reset: %s" % exc.code)
                raise
            self._finish_board_reset(verdict)
        return {"phase": "sent", "portDropped": False, "reconnect": False, "sync": verdict}

    def _read_uptime(self, req):
        """(ticks_ms, reset_cause) read through the normal file-op path, or None (not idle, no answer, no machine module).
        Never interrupts anything: only an idle board is asked."""
        if self.state != "idle":
            return None
        try:
            with self._borrow(req) as exec_fn:
                out, _err = exec_fn(_isolated(_UPTIME_CODE), 5.0)
        except BridgeError as exc:
            self.log("debug", "uptime not read: %s" % exc.code)
            return None
        m = re.search(rb"@@U (-?\d+) (-?\d+)", out)
        return (int(m.group(1)), int(m.group(2))) if m else None

    def _pulse(self, link, method, wait, native):
        """One control line pulse. (verdict, bytes seen, dropped). `dropped` = the port vanished after the pulse. Only a native
        USB board (resetcap.native_usb) re-enumerates on a chip reset: behind a UART bridge a vanished port is an unplug and is
        reported as such (`_on_link_dead` says `unplugged` unless a board reset is expected)."""
        pulsed = []

        def announce():
            pulsed.append(True)
            if native:
                self._expect_board_reset()
            self._set_state("connecting", reason="board-reset")
        try:
            verdict = link.hard_reset(confirm=RESET_CONFIRMED, wait=wait, on_data=self._on_pump_data, method=method,
                                      on_pulse=announce)
        except BridgeError as exc:
            if exc.code in ("E_NO_DEVICE", "E_NOT_CONNECTED") and pulsed:
                return None, b"", True  # _on_link_dead has reported disconnected / board-reset
            self._board_reset_until = 0.0
            raise
        return verdict, bytes(getattr(link, "sync_bytes", b"") or b""), False

    def op_reset_hard(self, req):
        """D-16 tier 3: pulse the control lines. Works on a hung board. E_UNSUPPORTED when the capability estimate is
        `unlikely` / `failed` (unless force:true) or the method is `none`; E_UNSUPPORTED from the Link where there are no
        lines at all (url/pty without a line driver). With verify:true it decides whether the pulse worked (addendum
        section 3) and tells the client what to cache."""
        self._need_confirmed(req)
        self._same_connection(req)
        a = req.args
        link = self._need_link()
        verify, force = _a_bool(a, "verify", False), _a_bool(a, "force", False)
        method = a.get("method")
        if method is not None and method not in resetcap.METHODS:
            raise _bad("The argument 'method' must be one of: %s." % ", ".join(resetcap.METHODS), detail="method=%r" % (method,))
        cap = self._hard_capability(link, self._a_learned(a))
        chosen = method if method is not None else (cap["method"] if cap else None)
        if chosen == "none" or (cap is not None and cap["state"] in ("unlikely", "failed") and not force):
            why = cap["reason"] if cap else "no reset method"
            raise BridgeError(
                "E_UNSUPPORTED", "Hardware reset is not available for this board.",
                detail="hard.state=%s method=%s: %s" % (cap["state"] if cap else "?", chosen, why),
                hint="Use Reboot board (software), or press the board's reset button."
                     + (" To try the lines anyway repeat with force:true." if cap and cap["state"] in ("unlikely", "failed") and chosen != "none" else ""))
        if verify:
            return self._verify_hard_reset(req, link, chosen)
        native = resetcap.native_usb(self._reset_key(link)["vid"])   # before the pulse: a drop closes the Link
        verdict, buf, dropped = self._pulse(link, chosen, HARD_RESET_LISTEN_S, native)
        seen = ["boot-text"] if _ROM_RE.search(buf) else []
        if dropped:
            return {"verified": None, "evidence": seen + (["port-re-enumerated"] if native else []), "portDropped": True,
                    "reconnect": native}
        self._finish_board_reset(self._resync_if_silent(link, verdict))
        return {"verified": None, "evidence": seen}

    def _resync_if_silent(self, link, verdict):
        """A pulse after which NOTHING came back: either no reset happened (an idle board prints nothing) or the board is still
        booting. Ask the REPL itself (a bare newline: no Ctrl-C, no Ctrl-D, no reset) before deciding what state to claim."""
        if verdict != "silent":
            return verdict
        try:
            with link.session():
                return link.sync_to_prompt(listen_ms=100, nudge_ms=max(200, self.cfg["idleListenMs"]), on_data=self._on_pump_data)
        except BridgeError as exc:
            self.log("warn", "re-sync after the pulse failed: %s" % exc.code)
            return verdict

    def _verify_hard_reset(self, req, link, method):
        """Addendum section 3. Before: ticks_ms/reset_cause if the board is idle. Pulse. Evidence within 3 s: (a) boot text,
        (b) ticks_ms restarted, (c) the port re-enumerated. Any one = verified. None = E_RESET_NOT_OBSERVED. A pulse that
        leaves the chip in the ROM bootloader ("waiting for download") is repeated once; if it persists the sequence is unsafe."""
        before = self._read_uptime(req)
        key = self._reset_key(link)  # before the pulse: a native-USB drop closes the Link and forgets its adapter
        native = resetcap.native_usb(key["vid"])
        evidence, download, attempts = [], False, 0
        while True:
            attempts += 1
            verdict, buf, dropped = self._pulse(link, method, VERIFY_WINDOW_S, native)
            download = b"waiting for download" in buf
            if _ROM_RE.search(buf) and "boot-text" not in evidence:
                evidence.append("boot-text")
            if dropped and native and "port-re-enumerated" not in evidence:   # behind a UART bridge a vanished port is an unplug
                evidence.append("port-re-enumerated")
            if not (download and attempts == 1 and not dropped):
                break
            evidence.append("waiting-for-download")  # keep DTR low and pulse once more (our sequences never assert IO0)
        if not dropped:
            self._finish_board_reset(self._resync_if_silent(link, verdict))
            after = self._read_uptime(req) if before is not None else None
            if before is not None and after is not None and after[0] < before[0]:
                evidence.append("uptime-restarted")
        reset_seen = any(e in evidence for e in ("boot-text", "port-re-enumerated", "uptime-restarted"))
        if download and "waiting-for-download" not in evidence:
            evidence.append("waiting-for-download")
        if dropped and not native and not reset_seen and not download:
            # The cable (or the adapter) went away mid-verification: neither a working nor a failing line. Learn nothing.
            return {"verified": None, "evidence": evidence, "method": method, "learned": None, "cacheKey": key,
                    "portDropped": True, "reconnect": False,
                    "hint": "The USB connection disappeared during the check, so it proves nothing. Reconnect the board and try again."}
        learned = "verified" if (reset_seen and not download) else "failed"
        # A result is only worth keeping per board: without machine.unique_id() the key is the adapter model alone and would
        # be handed to every board behind the same adapter. Then nothing is recorded and the client is told to cache nothing.
        cacheable = key["uniqueId"] is not None
        if cacheable:
            self._learned[(key["vid"], key["pid"], key["uniqueId"])] = learned
        else:
            self.log("info", "verification result (%s) not recorded: the board identity (machine.unique_id()) was not read" % learned)
        told = learned if cacheable else None
        if download:
            return {"verified": False, "evidence": evidence, "method": "unsafe-sequence", "learned": told,
                    "unsafeSequence": True, "cacheKey": key,
                    "hint": "The chip stayed in the ROM bootloader. Press the board's EN/reset button or replug it."}
        if not reset_seen:
            err = BridgeError(
                "E_RESET_NOT_OBSERVED", "No sign of a reset was seen after the control line pulse.",
                detail="method=%s window=%.1fs before=%s evidence=%s" % (method, VERIFY_WINDOW_S, before, evidence),
                hint="The board may be hung or its reset wiring absent: press the EN/reset button or replug the USB cable.")
            err.learned, err.cache_key, err.evidence = told, key, []
            raise err
        return {"verified": True, "evidence": evidence, "method": method, "learned": told, "cacheKey": key,
                "portDropped": bool(dropped), "reconnect": bool(dropped)}


# ----------------------------------------------------------------------------- entry points

def _install_quit_signals(srv):
    """SIGTERM, SIGHUP (the terminal VS Code was started from was closed) and SIGBREAK (Windows) end the bridge the same way
    stdin EOF does: shutdown_sequence() interrupts a running program (Ctrl-C x2, <= 1 s) before the port is closed, exit 0
    (RQ-SAFE-4). SIGINT is the main thread's KeyboardInterrupt (Server.wait). SIGPIPE stays ignored (Python's default)."""
    for name in ("SIGTERM", "SIGHUP", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue

        def handler(_signum, _frame, _name=name):
            srv.quit_reason = _name
            srv.quit_event.set()
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError, RuntimeError):  # not the main thread / the platform refuses this signal
            pass


def serve(proto_out, stdin=None):
    """NDJSON server on stdin and the reserved protocol channel. Returns the exit code."""
    srv = Server(out=proto_out, stdin=stdin or sys.stdin.buffer)
    _install_quit_signals(srv)
    srv.emit(srv.hello())
    srv.start()
    rc = srv.wait()
    if srv._reader is not None and srv._reader.is_alive():
        # a daemon thread blocked in stdin.readline() can abort interpreter finalisation; the work is done
        try:
            sys.stderr.flush()
        except (OSError, ValueError):
            pass
        os._exit(rc)
    return rc


_NUMERIC_KEYS = frozenset(("baud", "timeoutMs", "target", "chunk", "idleListenMs", "vid", "pid"))


def _cli_value(key, text):
    if text in ("true", "false", "null") or text[:1] in ("[", "{", '"') or (key in _NUMERIC_KEYS and re.fullmatch(r"-?\d+", text)):
        try:
            return json.loads(text)
        except ValueError:
            return text
    return text


def cli_main(argv):
    """`--cli OP key=value ... [--port P]` and `--script FILE.jsonl [--port P]`: same dispatch as the server."""
    op, port, script, args, i = None, None, None, {}, 0
    while i < len(argv):
        tok = argv[i]
        if tok in ("--cli", "--script", "--port"):
            if i + 1 >= len(argv):
                sys.stderr.write("usage: mpy_bridge.py --cli OP [key=value ...] [--port P] | --script FILE.jsonl [--port P]\n")
                return 2
            val = argv[i + 1]
            i += 1
            if tok == "--cli":
                op = val
            elif tok == "--script":
                script = val
            else:
                port = val
        elif "=" in tok:
            k, v = tok.split("=", 1)
            args[k] = _cli_value(k, v)
        else:
            sys.stderr.write("unexpected argument %r\n" % tok)
            return 2
        i += 1
    for stream in (sys.stdout, sys.stderr):  # a console codepage must never turn a response into a traceback
        try:
            stream.reconfigure(errors="backslashreplace")
        except (AttributeError, ValueError, OSError):
            pass
    msgs = []
    if script is not None:
        try:
            with open(script, "r", encoding="utf-8-sig") as f:  # Notepad / PowerShell write a BOM
                for n, line in enumerate(f, 1):
                    line = line.strip()
                    if line and not line.startswith("#"):
                        msgs.append(json.loads(line))
        except (OSError, ValueError) as exc:
            sys.stderr.write("cannot read script %s: %s\n" % (script, exc))
            return 2
    elif op is not None:
        msgs.append(dict(args, op=op))
    else:
        sys.stderr.write("usage: mpy_bridge.py --cli OP [key=value ...] [--port P] | --script FILE.jsonl [--port P]\n")
        return 2
    srv = Server(cli=True)
    srv.cfg["stopOnDisconnect"] = False  # a one-shot command must not stop a program it did not start
    rc = 0
    try:
        # --port: connect before the first op that needs a board, unless the script connects itself
        implicit = bool(port) and not any(isinstance(m, dict) and m.get("op") == "connect" for m in msgs)
        for m in msgs:
            if not isinstance(m, dict):
                r = {"id": None, "ok": False, "error": _bad("A script line must be a JSON object.").to_dict()}
            else:
                if implicit and m.get("op") not in _NO_LINK_OPS:
                    implicit = False
                    r = srv.call({"op": "connect", "port": port})
                    if not r.get("ok"):
                        print(json.dumps(r, ensure_ascii=True))
                        return 1
                if port and m.get("op") == "connect" and "port" not in m:
                    m = dict(m, port=port)
                r = srv.call(m)
            print(json.dumps(r, ensure_ascii=True))  # ASCII-only JSON is valid whatever the console encoding is
            sys.stdout.flush()
            rc = rc or (0 if r.get("ok") else 1)
    except KeyboardInterrupt:
        srv.cfg["stopOnDisconnect"] = True  # the user hit Ctrl-C while something ran: stop it before leaving
        rc = 130
    finally:
        srv.shutdown_sequence("cli exit")
    return rc
