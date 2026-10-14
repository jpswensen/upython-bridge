#!/usr/bin/env python3
"""fakeboard.py - a hardware-free, cross-platform fake MicroPython board (stdlib only).

Speaks the real MicroPython serial REPL protocol over a TCP socket so that
`mpremote connect socket://127.0.0.1:<port> ...`, a pyserial `socket://` URL and the
Python bridge can be tested end to end on macOS, Windows and Linux CI (no pty, no
hardware).  It is the test fixture for everything else in this repository.

    from tools.fakeboard import FakeBoard
    with FakeBoard(profile="esp32", faults=["slow"]) as board:
        url = board.url                      # "socket://127.0.0.1:PORT" (port 0 bound, read back)
        ...                                  # connect a client to url
        assert board.events.count("connect") == 1 and board.events.count("soft_reset") == 0

What it models:
  * friendly REPL: echo, '>>> ' / '... ' prompts, auto indent, paste mode (Ctrl-E), Ctrl-A/B/C/D,
    expression results, MicroPython-style tracebacks (`OSError: [Errno 2] ENOENT`)
  * raw REPL: `raw REPL; CTRL-B to exit\\r\\n>`, `OK`, `\\x04` framing, soft reset on empty Ctrl-D
    (`OK\\r\\nMPY: soft reboot\\r\\n`), raw paste (`\\x05A\\x01` -> `R\\x01`, window 128, lazy flow
    control like shared/runtime/pyexec.c) or `R\\x00` when the profile has no raw paste
  * boot.py on every soft reset, main.py only when the REPL mode is friendly (ESP32 port rule),
    a raising boot.py skips main.py; ticks survive soft resets; the board outlives TCP clients
    (a program keeps running while nobody is connected, like a real board)
  * a chrooted `os` / `open` (device '/' = a host directory, optional '/flash' mount for pyboard),
    errno behaviour like MicroPython (OSError args == (errno,), `[Errno 2] ENOENT`), `sys.stdin`,
    `select.poll`, `micropython.kbd_intr`: a running program receives host keystrokes (RQ-RUN-1)
    and Ctrl-C raises KeyboardInterrupt in it
  * data-driven board PROFILES (esp32, esp32-legacy, esp32s3-usb, rp2, rp2350, stm32, esp8266,
    custom-frozen, unix-like) and independent FAULTS (close_mid_transfer, garbage_before_banner,
    delay_boot, main_forever, ignore_ctrl_c, unplug, slow, no_hashlib, reset_on_connect, plus
    readonly_fs, disk_full, no_raw_paste, no_compile)
  * a thread-safe `events` log with monotonic timestamps: connect, disconnect, power_on, soft_reset,
    hard_reset, raw_enter, raw_exit, exec, interrupt, paste_start, paste_abort, program_start,
    program_end, stdin_bytes, fault, busy_reject

Device-side code runs in CPython threads with MicroPython-flavoured shims, so snippets that must
work on a real board should ALSO be tested on the real VM (tools/mpunix_relay.py).

Public API for tests
--------------------
FakeBoard(profile="esp32", root=None, exclusive=True, faults=(), baud=None, *, seed=None, power_on=None,
          busy="refuse", log_path=None, unique_id=None, host="127.0.0.1", port=0, files=None, capture=False)
    profile    name, or a profile dict (see get_profile / derive_profile)
    root       host dir used as the device '/' (default: a temp dir removed by stop())
    exclusive  True: a second client while one is connected is refused (event busy_reject)
    faults     iterable of "name", "name:arg", (name, arg) or a Faults; baud throttles both directions
    start() binds port 0 and powers the board up; stop() is deterministic (no leaked threads, see
    leaked_threads()); `with FakeBoard(...) as b:` does both.  b.url / b.port, b.connected, b.mode
    ("friendly" | "raw"), b.wait_for_clients(), b.wait_idle(), b.wait_running(),
    b.program_running, b.unplug(), b.soft_reset(), b.hard_reset(), b.add_fault(spec), b.remove_fault(name),
    b.rearm(), b.write_file/read_file/exists/host_path(devpath), b.rx_data()/tx_data() (capture=True).
Events: b.events is a thread-safe list of dicts {"seq", "t" (time.monotonic()), "ev", ...fields}:
    connect(client, peer) disconnect(client, reason) busy_reject(peer) power_on(reason)
    soft_reset(reason, mode) hard_reset(reason, via) raw_enter(already) raw_exit exec(mode, paste, n, digest, head)
    pulse(method, wiring, effect)   [a control-line pulse reached the board; effect=True also logs ONE hard_reset]
    interrupt(state, delivered, swallowed, byte) paste_start(kind, window?) paste_abort(n)
    program_start(kind, digest, n) program_end(kind, result, ms, reason) stdin_bytes(n, hex)
    fault(name, ...)  stdin_overflow  hashlib.
    Helpers: events.count(ev=None, **match), .of(*names, **match), .names(), .mark(),
    .wait_for(ev, timeout=5.0, since=0, **match) -> event dict or None.
Profiles are plain dicts (_BASE_PROFILE documents every field: sysname, release, version_tuple, machine,
    uname, unique_id, usb{kind,vid,pid,chip,auto_reset_circuit,needs_dtr}, root_files, mount, sys_path,
    caps{hashlib,compile,raw_paste,mem_free,epoch2000,ilistdir_size}, raw_paste_window, max_source_bytes,
    stdin_buffer, errno_overrides, frozen, c_modules, rom_noise, ...).  Built in: esp32, esp32-legacy,
    esp32s3-usb, rp2, rp2350, stm32, esp8266 (sha1 only, no compile), custom-frozen, unix-like (no
    os.uname).  register_profile(name, data, base="esp32", **overrides), derive_profile(base, name, **ov),
    get_profile(name_or_dict), list_profiles().
Reset tiers (docs/protocol-addendum-reset.md, D-16).  Every chip reset is ONE `hard_reset` event whose `via` field says what
    caused it: "machine" (machine.reset() in the REPL or a program; native-USB profiles also drop the client), "pulse" (the
    control-line pulse below) or "test" (b.hard_reset()).  `reason` is "machine.reset" | "rts-pulse" | "usb-jtag" | the test's
    reason.  The profile field `reset_wiring` ("auto-reset" | "none" | "usb-jtag") decides what a pulse does:
    b.pulse(method) resets only a board wired for that method ("rts-pulse" <-> "auto-reset", "usb-jtag" <-> "usb-jtag") and
    logs `pulse` either way (effect False = nothing happened, like pulsing a PCB without the auto-reset transistors).
    b.line_driver() is a driver object for bridge.link.register_line_driver(b.url, driver): it stands in for DTR/RTS on the
    socket:// URL (which has no modem lines) and carries the profile's USB ids.  `machine_reset_cause` / `pulse_reset_cause`
    (default 1 = PWRON_RESET) are what machine.reset_cause() returns afterwards; b.hard_reset() keeps 2 (HARD_RESET).
    Setting the environment variable MPY_FAKEBOARD_RESET_LEDGER=<file> makes every chip reset append one JSON line there
    (also from other processes): the catalogue-wide "no tier above soft" check of tests/test_reset_tiers.py reads it.
Faults (Faults class docstring has the arguments): close_mid_transfer, garbage_before_banner, delay_boot,
    main_forever, ignore_ctrl_c, unplug, slow, no_hashlib, reset_on_connect, readonly_fs, disk_full,
    no_raw_paste, no_compile, silent.
PROGRAMS: ready-made device programs (echo_keys, poll_keys, course_demo, spin, sleep_loop, swallow_ctrl_c,
    heartbeat, raises, ask_name) for stdin / Ctrl-C tests.
Related: tools/mpunix_relay.py `UnixVM()` (context manager; .url, .root, .events, .event_names(), .count(),
    .wait_for(); `UnixVM.skip_reason()` is None or a message: no MPY_UNIX_BIN, or Windows).
Run the tests (from the repo root):
    export MPY_SAFE_MODE=1 MPY_UNIX_BIN=<path of the unix-port micropython>   # MPY_UNIX_BIN optional
    python3 -B -m unittest tests.test_fakeboard -v        # about 45 s; 3.9 to 3.15

CLI:  python tools/fakeboard.py --profile esp32 --port 0 --print-url
"""
from __future__ import annotations

import argparse
import builtins
import calendar
import codeop
import collections
import copy
import ctypes
import errno as host_errno
import hashlib as host_hashlib
import json
import os
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import traceback
import types

__all__ = [
    "FakeBoard", "FakeLineDriver", "Faults", "EventLog", "PROFILES", "PROGRAMS", "register_profile", "get_profile",
    "derive_profile", "list_profiles",
]

CTRL_A, CTRL_B, CTRL_C, CTRL_D, CTRL_E = 1, 2, 3, 4, 5
ESC = 0x1B

# --------------------------------------------------------------------------------------
# errno table.  MicroPython exposes per-port numbers; consumers must classify by NAME.
# Base numbers are Linux/unix-port values; a profile can override single names
# (ESP-IDF newlib differs for ENOTEMPTY, for example).  [K] approximations.
# --------------------------------------------------------------------------------------
_WIN_RESERVED = frozenset(["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
                          + ["COM%d" % i for i in range(1, 10)] + ["LPT%d" % i for i in range(1, 10)])

_ERRNO_BASE = {
    "EPERM": 1, "ENOENT": 2, "EIO": 5, "EBADF": 9, "EAGAIN": 11, "ENOMEM": 12, "EACCES": 13,
    "EBUSY": 16, "EEXIST": 17, "ENODEV": 19, "ENOTDIR": 20, "EISDIR": 21, "EINVAL": 22,
    "ENFILE": 23, "EMFILE": 24, "EFBIG": 27, "ENOSPC": 28, "ESPIPE": 29, "EROFS": 30,
    "ENAMETOOLONG": 36, "ENOTEMPTY": 39, "EOPNOTSUPP": 95, "EADDRINUSE": 98,
    "ECONNABORTED": 103, "ECONNRESET": 104, "ENOBUFS": 105, "ENOTCONN": 107, "ETIMEDOUT": 110,
    "ECONNREFUSED": 111, "EHOSTUNREACH": 113, "EALREADY": 114, "EINPROGRESS": 115,
}


class _Shutdown(BaseException):
    """Injected into a worker thread when the board is stopped."""


class _ResetRequest(BaseException):
    """Injected into a worker thread to make the running program end in a reset."""


class _SoftResetExc(BaseException):
    pass


class _HardResetExc(BaseException):
    pass


class _UOSError(OSError):
    """OSError flavoured like MicroPython's: args == (errno,), str() == '[Errno 2] ENOENT'."""

    def __init__(self, num, name=""):
        OSError.__init__(self, num)
        self.errno = num
        self._name = name

    def __str__(self):
        return "[Errno %d] %s" % (self.errno, self._name)

    def __repr__(self):
        return "OSError(%d,)" % self.errno


# --------------------------------------------------------------------------------------
# Profiles (data).  Every key may be overridden; nested dicts are merged.
# --------------------------------------------------------------------------------------
_NESTED_KEYS = ("caps", "impl_extra", "root_files", "usb", "errno_overrides", "frozen", "c_modules")

_ESP32_BOOT = (
    "# This file is executed on every boot (including wake-boot from deepsleep)\n"
    "#import esp\n#esp.osdebug(None)\n#import webrepl\n#webrepl.start()\n"
)
_ESP_MODULE = (
    "def osdebug(*a, **k):\n    pass\n"
    "def flash_size():\n    return 4194304\n"
)
_ROM_NOISE_ESP32 = (
    b"ets Jul 29 2019 12:21:46\r\n\r\nrst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n"
    b"configsip: 0, SPIWP:0xee\r\nmode:DIO, clock div:2\r\nload:0x3fff0030,len:4568\r\n"
)

_BASE_PROFILE = {
    "name": "base",
    "description": "",
    "sysname": "esp32", "nodename": "esp32", "platform": "esp32",
    "release": "1.29.0", "version_tuple": (1, 29, 0, ""),
    "version_full": "v1.29.0 on 2026-05-20",
    "machine": "ESP32 module (spiram) with ESP32",
    "uname": True,                       # False: os.uname() does not exist
    "machine_api": "full",               # "unix": the sparse unix-port `machine` module
    "impl_extra": {},                    # extra sys.implementation fields (_build, _mpy, _thread)
    "unique_id": bytes.fromhex("30aea4123abc"),   # None: machine.unique_id does not exist
    "freq": 240000000,
    "usb": {"kind": "uart-bridge", "vid": 0x10C4, "pid": 0xEA60, "chip": "CP2102",
            "auto_reset_circuit": True, "needs_dtr": False},
    "rom_noise": _ROM_NOISE_ESP32,       # printed after a hard reset on UART-bridge boards
    "root_files": {"boot.py": _ESP32_BOOT},
    "mount": None,                       # e.g. "/flash": device '/' is virtual, files live under it
    "cwd": None,
    "sys_path": ["", ".frozen", "/lib"],
    "caps": {
        "hashlib": True,                 # True | "sha256" | "sha1" | False
        "compile": True,                 # builtin compile()
        "raw_paste": True,               # False: device answers R\x00 to \x05A\x01
        "mem_free": 4000000,
        "epoch2000": True,               # time.time() counts from 2000-01-01
        "clock_unset": False,            # True: the clock starts at the epoch at power-on (a real board without NTP/RTC set)
        "rtc": True,                     # machine.RTC exists (set by clock.set); the unix machine_api never has one
        "ilistdir_size": True,           # ilistdir yields 4-tuples (False: 3-tuples, like the unix port)
    },
    "raw_paste_window": 128,
    "max_source_bytes": None,            # MemoryError above this (small boards)
    "stdin_buffer": None,                # bytes of UART ring buffer (None = unlimited)
    "errno_overrides": {},
    "frozen": {},                        # {"pkg/__init__.py": source, "pkg/sub.py": source}
    "c_modules": {},                     # {"_name": python source defining the module's attributes}
    "weak_modules": ["array", "binascii", "collections", "errno", "hashlib", "heapq", "io",
                     "json", "math", "os", "random", "re", "select", "struct", "sys", "time"],
    "crlf_single_enter": False,          # True: '\r\n' is ONE Enter.  [E] v1.29.0 unix VM: it is TWO Enters
    "auto_indent": True,
    "fs_blocks": 352,                    # os.statvfs total blocks (4096-byte blocks)
    "reset_wiring": "auto-reset",        # what a control-line pulse does: "auto-reset" (RTS->EN) | "usb-jtag" | "none"
    "machine_reset_cause": 1,            # machine.reset_cause() after machine.reset()  (1 = PWRON_RESET)
    "pulse_reset_cause": 1,              # ... after a control-line pulse (EN toggled: the ROM reports power-on)
}

PROFILES: dict = {}


def _deep_merge(base: dict, over: dict) -> dict:
    """Overlay `over` on a copy of `base`.  Nested dicts merge; a None value deletes the key;
    a nested dict containing "__replace__": True replaces the base dict."""
    out = copy.deepcopy(base)
    for k, v in over.items():
        if k in _NESTED_KEYS and isinstance(v, dict):
            if v.get("__replace__") or not isinstance(out.get(k), dict):
                out[k] = {kk: copy.deepcopy(vv) for kk, vv in v.items()
                          if kk != "__replace__" and vv is not None}
            else:
                for kk, vv in v.items():
                    if vv is None:
                        out[k].pop(kk, None)
                    else:
                        out[k][kk] = copy.deepcopy(vv)
        else:
            out[k] = copy.deepcopy(v)
    return out


def register_profile(name: str, data: dict | None = None, base: str | None = "esp32", **overrides) -> dict:
    """Register (or replace) a board profile and return it.

    `base` names a registered profile to start from (None = the built-in defaults).
    `register_profile("mine", {"machine": "My board"}, base="rp2", caps={"hashlib": False})`.
    Nested-dict values merge into the base; `impl_extra={"_build": None}` removes sys.implementation._build.
    """
    src = dict(data or {})
    src.update(overrides)
    basep = _BASE_PROFILE if base is None else PROFILES[base]
    prof = _deep_merge(basep, src)
    prof["name"] = name
    PROFILES[name] = prof
    return prof


def get_profile(profile) -> dict:
    """Resolve a profile name or dict to a private deep copy."""
    if isinstance(profile, dict):
        out = copy.deepcopy(_BASE_PROFILE)
        out.update(copy.deepcopy(profile))
        return out
    try:
        return copy.deepcopy(PROFILES[profile])
    except KeyError:
        raise ValueError("unknown fake board profile %r (known: %s)" % (profile, ", ".join(sorted(PROFILES))))


def derive_profile(base: str, name: str | None = None, **overrides) -> dict:
    """A modified copy of a registered profile that is NOT registered:
    `FakeBoard(derive_profile("esp32", caps={"compile": False}))`."""
    prof = _deep_merge(get_profile(base), overrides)
    if name:
        prof["name"] = name
    return prof


def list_profiles() -> list:
    return sorted(PROFILES)


register_profile("esp32", dict(
    description="Stock ESP32 (ESP32_GENERIC with SPIRAM) behind a CP210x USB-UART bridge",
    impl_extra={"_build": "ESP32_GENERIC", "_mpy": 11014, "_thread": "GIL"},
    c_modules={"esp": _ESP_MODULE},
), base=None)
register_profile("esp32-legacy", dict(
    description="Old ESP32 firmware (v1.19.1): no sys.implementation._build",
    release="1.19.1", version_tuple=(1, 19, 1, ""), version_full="v1.19.1 on 2022-06-18",
    machine="ESP32 module with ESP32",
    impl_extra={"_build": None, "_mpy": 10246, "_thread": "GIL"},
), base="esp32")
register_profile("esp32s3-usb", dict(
    description="ESP32-S3 on its native USB serial (CDC): the port vanishes on a hardware reset",
    machine="Generic ESP32S3 module with ESP32S3",
    impl_extra={"_build": "ESP32_GENERIC_S3", "_mpy": 11014, "_thread": "GIL"},
    unique_id=bytes.fromhex("7cdfa1e0c2d4"),
    usb={"kind": "native-cdc", "vid": 0x303A, "pid": 0x1001, "chip": "ESP32-S3 USB-Serial/JTAG",
         "auto_reset_circuit": False, "needs_dtr": False},
    reset_wiring="usb-jtag",
    rom_noise=None,
    caps={"mem_free": 8300000},
), base="esp32")
register_profile("rp2", dict(
    description="Raspberry Pi Pico (RP2040), native USB CDC that wants DTR asserted",
    sysname="rp2", nodename="rp2", platform="rp2",
    machine="Raspberry Pi Pico with RP2040",
    impl_extra={"_build": "RPI_PICO", "_mpy": 4870, "_thread": None},
    unique_id=bytes.fromhex("e66118604b123456"),
    freq=125000000,
    usb={"kind": "native-cdc", "vid": 0x2E8A, "pid": 0x0005, "chip": "RP2040 CDC",
         "auto_reset_circuit": False, "needs_dtr": True},
    reset_wiring="none",
    rom_noise=None,
    root_files={"__replace__": True},          # a fresh Pico has an empty filesystem
    caps={"mem_free": 183000},
    c_modules={"__replace__": True},
), base="esp32")
register_profile("rp2350", dict(
    description="Raspberry Pi Pico 2 (RP2350), native USB CDC",
    machine="Raspberry Pi Pico 2 with RP2350",
    impl_extra={"_build": "RPI_PICO2", "_mpy": 7942},
    unique_id=bytes.fromhex("e66118604b987654"),
    freq=150000000,
    caps={"mem_free": 345000},
), base="rp2")
register_profile("stm32", dict(
    description="Original pyboard v1.1: files live under /flash (device '/' is a virtual root)",
    sysname="pyboard", nodename="pyboard", platform="pyboard",
    machine="PYBv1.1 with STM32F405RG",
    impl_extra={"_build": "PYBV11", "_mpy": 7942, "_thread": None},
    unique_id=bytes.fromhex("3a0027000d51353034373033"),
    freq=168000000,
    usb={"kind": "native-cdc", "vid": 0xF055, "pid": 0x9800, "chip": "STM32 CDC+MSC",
         "auto_reset_circuit": False, "needs_dtr": False},
    reset_wiring="none",
    rom_noise=None,
    mount="/flash", cwd="/flash",
    sys_path=["", "/flash", "/flash/lib"],
    root_files={
        "__replace__": True,
        "boot.py": "# boot.py -- run on boot-up\n# can run arbitrary Python, but best to keep it minimal\n",
        "main.py": "# main.py -- put your code here!\n",
        "pybcdc.inf": "; pybcdc.inf (placeholder driver file)\n",
        "README.txt": "This is a MicroPython board\n",
    },
    c_modules={"__replace__": True},
    caps={"mem_free": 100000},
    fs_blocks=256,
), base="esp32")
register_profile("esp8266", dict(
    description="ESP8266: small RAM, no sha256 (hashlib has only sha1), no compile(), no _build",
    sysname="esp8266", nodename="esp8266", platform="esp8266",
    release="1.22.2", version_tuple=(1, 22, 2, ""), version_full="v1.22.2 on 2024-02-22",
    machine="ESP module with ESP8266",
    impl_extra={"_build": None, "_mpy": 9990, "_thread": None},
    unique_id=bytes.fromhex("a1b2c3d4"),
    freq=80000000,
    usb={"kind": "uart-bridge", "vid": 0x1A86, "pid": 0x7523, "chip": "CH340",
         "auto_reset_circuit": True, "needs_dtr": False},
    sys_path=["", "/lib", ".frozen"],
    caps={"hashlib": "sha1", "compile": False, "mem_free": 28000},
    max_source_bytes=8192,
    fs_blocks=200,
), base="esp32")
_ACME_INIT = (
    "import _acme\n"
    "if _acme.ABI != 3:\n"
    "    raise ImportError('acme ABI %d does not match this package: flash the matching ACME_BOARD firmware' % _acme.ABI)\n"
    "from acme.motor import Motor\n"
    "ABI = _acme.ABI\n"
    "def info():\n"
    "    import sys\n"
    "    print('acme ABI', ABI, 'build', sys.implementation._build)\n"
)
_ACME_MOTOR = (
    "import _acme\n"
    "class Motor:\n"
    "    def __init__(self, n):\n"
    "        self.n = n\n"
    "        self.speed = 0\n"
    "    def run(self, speed):\n"
    "        self.speed = speed\n"
    "    def stop(self):\n"
    "        self.speed = 0\n"
)
register_profile("custom-frozen", dict(
    description="Custom firmware: board ACME_BOARD with a frozen package `acme` and a C module `_acme` "
                "(listed by help('modules') and importable, absent from the file listing)",
    machine="ACME Motor Controller with ESP32",
    version_full="v1.29.0-14-g2930580-dirty on 2026-09-24",
    impl_extra={"_build": "ACME_BOARD", "_mpy": 11014, "_thread": "GIL"},
    unique_id=bytes.fromhex("84f3eb70aa01"),
    frozen={"acme/__init__.py": _ACME_INIT, "acme/motor.py": _ACME_MOTOR},
    c_modules={"_acme": "ABI = 3\nVERSION = '1.2.0'\ndef version():\n    return VERSION\n"},
), base="esp32")
register_profile("unix-like", dict(
    description="MicroPython unix port flavour: no os.uname(), no machine.unique_id(), 3-tuple ilistdir",
    sysname="linux", nodename="linux", platform="linux",
    machine="linux [GCC 13.2.0] version",
    uname=False,
    machine_api="unix",
    impl_extra={"_build": "standard", "_mpy": 2822, "_thread": "unsafe"},
    unique_id=None,
    freq=0,
    usb={"kind": None},
    reset_wiring="none",
    rom_noise=None,
    root_files={"__replace__": True},
    c_modules={"__replace__": True},
    sys_path=["", ".frozen", "/usr/lib/micropython"],
    caps={"hashlib": "sha256", "ilistdir_size": False, "epoch2000": False, "mem_free": 2000000},
), base="esp32")


# --------------------------------------------------------------------------------------
# Faults
# --------------------------------------------------------------------------------------
def _hexbytes(s):
    return s if isinstance(s, bytes) else bytes.fromhex(str(s))


_FAULTS = {
    # name: (converter for string args, default arg)
    "close_mid_transfer": (int, 512),         # drop the socket after N bytes of raw-paste / program stdin
    "garbage_before_banner": (_hexbytes, None),
    "delay_boot": (float, 1.5),               # boot.py takes this long
    "main_forever": (None, None),             # main.py is an infinite heartbeat loop
    "ignore_ctrl_c": (None, None),            # Ctrl-C is swallowed while a program runs
    "unplug": (str, "exec"),                  # abrupt close: exec | connect | bytes=N | after=SECONDS
    "slow": (int, 115200),                    # throttle to this baud
    "no_hashlib": (None, None),
    "reset_on_connect": (None, None),         # soft-reboot the interpreter at every connect
    "readonly_fs": (None, None),              # every mutating fs call raises EROFS
    "disk_full": (int, 4096),                 # ENOSPC once the files hold more than N bytes
    "no_raw_paste": (None, None),             # device answers R\x00 to \x05A\x01
    "no_compile": (None, None),               # builtin compile() missing
    "silent": (None, None),                   # link dead: input is ignored, nothing is ever sent back
}
_DEFAULT_GARBAGE = (b"\xff\xfe\x00\x80ets Jun  8 2016 00:22:57\r\n\r\nrst:0x1 (POWERON_RESET),"
                    b"boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n\xfa\xfb\r\n")


class Faults:
    """Parsed fault set.  Accepts "name", "name:arg", ("name", arg), a dict or another Faults.

    close_mid_transfer[:N=512]  drop the socket after N bytes of raw-paste / program stdin (one-shot)
    garbage_before_banner[:hex] noise at connect and before every banner
    delay_boot[:secs=1.5]       boot.py takes that long (interruptible with Ctrl-C)
    main_forever                main.py is an infinite heartbeat loop (the fault WRITES /main.py into the
                                root); no friendly REPL until Ctrl-C
    ignore_ctrl_c               Ctrl-C does not stop a running program
    unplug[:trigger]            abrupt close (RST): exec | connect | bytes=N | after=SECONDS (one-shot)
    slow[:baud=115200]          emulate a UART speed in both directions
    no_hashlib                  `import hashlib` fails
    reset_on_connect            soft-reboot the interpreter on every connect (and log it)
    readonly_fs / disk_full[:bytes] / no_raw_paste / no_compile   extras for scenario tests
    silent                      the link is dead: input is ignored and nothing is sent (use add_fault() on a
                                running board to hang it at the moment you choose)
    """

    def __init__(self, specs=()):
        self._args = {}
        self._fired = collections.Counter()
        if isinstance(specs, Faults):
            specs = specs.as_specs()
        if isinstance(specs, dict):
            specs = list(specs.items())
        if isinstance(specs, str):
            specs = [specs]
        for spec in specs or ():
            self.add(spec)

    def add(self, spec):
        """Add (or replace) one fault: "name", "name:arg" or ("name", arg)."""
        if isinstance(spec, str):
            name, _, rest = spec.partition(":")
            arg = rest if rest != "" else None
        else:
            spec = tuple(spec)
            name, arg = spec[0], (spec[1] if len(spec) > 1 else None)
        if name not in _FAULTS:
            raise ValueError("unknown fault %r (known: %s)" % (name, ", ".join(sorted(_FAULTS))))
        conv, default = _FAULTS[name]
        if arg is None:
            arg = default
        elif conv is not None:
            arg = conv(arg)
        self._args[name] = arg
        self._fired.pop(name, None)

    def remove(self, name):
        self._args.pop(name, None)
        self._fired.pop(name, None)

    def has(self, name):
        return name in self._args

    __contains__ = has

    def arg(self, name, default=None):
        v = self._args.get(name)
        return default if v is None else v

    def names(self):
        return sorted(self._args)

    def as_specs(self):
        return list(self._args.items())

    def once(self, name):
        """True the first time it is asked for after (re)arming: one-shot faults fire once."""
        if name not in self._args or self._fired[name]:
            return False
        self._fired[name] += 1
        return True

    def fired(self, name):
        return self._fired[name]

    def rearm(self, name=None):
        if name is None:
            self._fired.clear()
        else:
            self._fired.pop(name, None)

    def __repr__(self):
        return "Faults(%s)" % ", ".join("%s=%r" % kv for kv in sorted(self._args.items()))


# --------------------------------------------------------------------------------------
# Event log
# --------------------------------------------------------------------------------------
class EventLog(list):
    """Thread-safe list of event dicts: {"seq", "t" (time.monotonic()), "ev", ...fields}.

    NOTE: `count` is overridden: `events.count("connect", client=1)` counts matching events.
    """

    def __init__(self):
        list.__init__(self)
        self._cond = threading.Condition()
        self.t0 = time.monotonic()
        self._sink = None

    def add(self, ev: str, **fields) -> dict:
        with self._cond:
            rec = {"seq": len(self), "t": time.monotonic(), "ev": ev}
            rec.update(fields)
            list.append(self, rec)
            sink = self._sink
            self._cond.notify_all()
        if sink is not None:
            try:
                out = dict(rec)
                out["t"] = round(out["t"] - self.t0, 4)
                sink.write(json.dumps(out, default=lambda o: o.hex() if isinstance(o, bytes) else str(o)) + "\n")
            except Exception:
                pass
        return rec

    def names(self) -> list:
        return [e["ev"] for e in list(self)]

    @staticmethod
    def _match(e, names, match):
        if names and e["ev"] not in names:
            return False
        for k, v in match.items():
            if e.get(k) != v:
                return False
        return True

    def of(self, *names, **match) -> list:
        return [e for e in list(self) if self._match(e, names, match)]

    def count(self, ev=None, **match) -> int:  # type: ignore[override]
        return len(self.of(*((ev,) if ev else ()), **match))

    def mark(self) -> int:
        """Position to pass as `since=` later."""
        with self._cond:
            return len(self)

    def wait_for(self, ev: str, timeout: float = 5.0, since: int = 0, **match):
        """Block until an event of that name (and field values) exists at index >= since; None on timeout."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                for e in self[since:]:
                    if self._match(e, (ev,), match):
                        return e
                rem = deadline - time.monotonic()
                if rem <= 0:
                    return None
                self._cond.wait(min(rem, 0.1))


# --------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------
def _digest(data) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8", "surrogateescape")
    return host_hashlib.sha1(data).hexdigest()[:10]


def _crlf(s: str) -> str:
    return s.replace("\r\n", "\n").replace("\n", "\r\n")


def _async_raise(tid: int, exc) -> int:
    n = ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(tid), ctypes.py_object(exc))
    if n > 1:
        ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(tid), None)
    return n


def _async_clear(tid: int) -> None:
    ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(tid), None)


_THIS_FILE = os.path.abspath(__file__)
if _THIS_FILE.endswith(".pyc"):
    _THIS_FILE = _THIS_FILE[:-1]
_STDLIB_DIR = os.path.dirname(os.path.abspath(traceback.__file__))


def _internal_frame(filename: str) -> bool:
    """Frames of this module and of the host stdlib are not shown (a real board has no such frames)."""
    if filename.startswith("<"):
        return filename.startswith("<frozen")
    ap = os.path.abspath(filename)
    return ap == _THIS_FILE or ap.startswith(_STDLIB_DIR + os.sep)


class _AttrTuple(tuple):
    """MicroPython's attrtuple: a tuple with attribute access that reprs as `(name='micropython', ...)`."""

    def __new__(cls, fields, values):
        self = tuple.__new__(cls, values)
        self._fields = tuple(fields)
        return self

    def __getattr__(self, name):
        try:
            return self[self._fields.index(name)]
        except ValueError:
            raise AttributeError("'tuple' object has no attribute '%s'" % name)

    def __repr__(self):
        return "(" + ", ".join("%s=%r" % kv for kv in zip(self._fields, self)) + ")"


class _Outcome:
    __slots__ = ("kind", "ok", "tb", "reset", "interrupted", "reason", "paste")

    def __init__(self, kind, ok=True, tb="", reset=None, interrupted=False, reason="", paste=False):
        self.kind = kind
        self.ok = ok
        self.tb = tb
        self.reset = reset
        self.interrupted = interrupted
        self.reason = reason
        self.paste = paste


# --------------------------------------------------------------------------------------
# The device-side `os`, stdin/stdout objects
# --------------------------------------------------------------------------------------
class _StdinBuf:
    def __init__(self, cap=None):
        self.cond = threading.Condition()
        self.buf = bytearray()
        self.cap = cap


class _DevFile:
    """File wrapper that enforces the disk_full fault."""

    def __init__(self, f, dev):
        self._f = f
        self._dev = dev

    def write(self, data):
        n = len(data.encode("utf-8", "surrogateescape")) if isinstance(data, str) else len(data)
        self._dev._check_quota(n)
        return self._f.write(data)

    def __getattr__(self, name):
        return getattr(self._f, name)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self._f.close()
        return False

    def __iter__(self):
        return iter(self._f)

    def __next__(self):
        return next(self._f)


class _FakeOS:
    """MicroPython-flavoured `os` rooted in a host directory (optionally mounted at /flash)."""

    sep = "/"

    def __init__(self, dev):
        self._dev = dev
        self._root = dev.root
        self._mount = dev.profile.get("mount")
        self._cwd = dev.profile.get("cwd") or (self._mount or "/")
        self._four = bool(dev.profile["caps"].get("ilistdir_size", True))
        self._epoch = bool(dev.profile["caps"].get("epoch2000", True))

    # ---- path mapping
    def _norm(self, path):
        if not isinstance(path, str):
            raise TypeError("can't convert '%s' object to str implicitly" % type(path).__name__)
        path = path or "."
        full = path if path.startswith("/") else (self._cwd.rstrip("/") + "/" + path)
        parts = []
        for seg in full.split("/"):
            if seg in ("", "."):
                continue
            if seg == "..":
                if parts:
                    parts.pop()
            else:
                parts.append(seg)
        return "/" + "/".join(parts)

    def _host(self, path):
        """-> (host_path or None, virtual).  virtual=True is the synthetic root above a mount."""
        n = self._norm(path)
        m = self._mount
        if m:
            if n == "/":
                return None, True
            if n == m or n.startswith(m + "/"):
                rel = n[len(m):].lstrip("/")
            else:
                raise self._dev.oserror("ENOENT")
        else:
            rel = n.lstrip("/")
        if not rel:
            return self._root, False
        segs = rel.split("/")
        for seg in segs:
            if self._unmappable(seg):
                raise self._dev.oserror("ENOENT")
        return os.path.join(self._root, *segs), False

    @staticmethod
    def _unmappable(seg):
        """True for a device path segment that must not reach the host file system.  A board happily has a file
        called 'a\\b' or 'C:'; a Windows host would read those as a path separator / a drive and leave the board's
        private directory, so they are refused as 'not found' there (NUL can never be a host file name)."""
        if "\0" in seg:
            return True
        if os.path.sep == "/" and not os.path.altsep:          # POSIX host: only '/' and NUL are special
            return False
        if "\\" in seg or ":" in seg or "/" in seg:
            return True
        if seg != seg.rstrip(". "):                            # Windows strips trailing dots/spaces: aliasing
            return True
        return seg.split(".")[0].rstrip(" ").upper() in _WIN_RESERVED

    def _wrap(self, e):
        name = host_errno.errorcode.get(getattr(e, "errno", None) or 0, "EIO")
        return self._dev.oserror(name if name in _ERRNO_BASE else "EIO")

    def _rw(self):
        if self._dev.faults.has("readonly_fs"):
            raise self._dev.oserror("EROFS")

    def _t(self, x):
        x = int(x)
        return max(0, x - 946684800) if self._epoch else x

    # ---- api
    def getcwd(self):
        return self._cwd

    def chdir(self, p):
        h, virt = self._host(p)
        if not virt and not os.path.isdir(h):
            raise self._dev.oserror("ENOENT" if not os.path.exists(h) else "ENOTDIR")
        self._cwd = self._norm(p)

    def listdir(self, p="."):
        h, virt = self._host(p)
        if virt:
            return [self._mount.lstrip("/")]
        try:
            return sorted(os.listdir(h))
        except OSError as e:
            raise self._wrap(e)

    def ilistdir(self, p="."):
        h, virt = self._host(p)
        if virt:
            yield (self._mount.lstrip("/"), 0x4000, 0) + ((0,) if self._four else ())
            return
        try:
            names = sorted(os.listdir(h))
        except OSError as e:
            raise self._wrap(e)
        for name in names:
            full = os.path.join(h, name)
            d = os.path.isdir(full)
            if self._four:
                try:
                    size = 0 if d else os.stat(full).st_size
                except OSError:
                    size = 0
                yield (name, 0x4000 if d else 0x8000, 0, size)
            else:
                yield (name, 0x4000 if d else 0x8000, 0)

    def stat(self, p):
        h, virt = self._host(p)
        if virt:
            return (0x4000, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        try:
            s = os.stat(h)
        except OSError as e:
            raise self._wrap(e)
        d = os.path.isdir(h)
        return (0x4000 if d else 0x8000, 0, 0, 0, 0, 0, 0 if d else s.st_size,
                self._t(s.st_atime), self._t(s.st_mtime), self._t(s.st_ctime))

    def mkdir(self, p):
        self._rw()
        h, virt = self._host(p)
        if virt:
            raise self._dev.oserror("EEXIST")
        try:
            os.mkdir(h)
        except OSError as e:
            raise self._wrap(e)

    def rmdir(self, p):
        self._rw()
        h, virt = self._host(p)
        if virt:
            raise self._dev.oserror("EACCES")
        if os.path.isfile(h):
            raise self._dev.oserror("ENOTDIR")
        try:
            os.rmdir(h)
        except OSError as e:
            raise self._wrap(e)

    def remove(self, p):
        self._rw()
        h, virt = self._host(p)
        if virt or os.path.isdir(h):
            raise self._dev.oserror("EISDIR")
        try:
            os.remove(h)
        except OSError as e:
            raise self._wrap(e)

    unlink = remove

    def rename(self, a, b):
        self._rw()
        ha, va = self._host(a)
        hb, vb = self._host(b)
        if va or vb:
            raise self._dev.oserror("EACCES")
        try:
            os.replace(ha, hb)
        except OSError as e:
            raise self._wrap(e)

    def statvfs(self, p):
        total = int(self._dev.profile.get("fs_blocks", 352))
        used = 0
        for dp, _dn, fns in os.walk(self._root):
            for fn in fns:
                try:
                    used += (os.path.getsize(os.path.join(dp, fn)) + 4095) // 4096
                except OSError:
                    pass
        free = max(0, total - used)
        return (4096, 4096, total, free, free, 0, 0, 0, 0, 255)

    def sync(self):
        pass

    def urandom(self, n):
        return os.urandom(n)

    def uname(self):
        return self._dev.uname_result


class _Out:
    """sys.stdout / sys.stderr of the device."""

    def __init__(self, dev):
        self._dev = dev
        self.buffer = _OutBuf(dev)

    def write(self, s):
        if isinstance(s, (bytes, bytearray, memoryview)):
            self._dev.tx(bytes(s))
            return len(s)
        self._dev.tx(_crlf(str(s)).encode("utf-8", "surrogateescape"))
        return len(s)

    def flush(self):
        pass

    def fileno(self):
        return 1


class _OutBuf:
    def __init__(self, dev):
        self._dev = dev

    def write(self, b):
        self._dev.tx(bytes(b))
        return len(b)

    def flush(self):
        pass


class _InBuf:
    """sys.stdin.buffer"""

    def __init__(self, dev):
        self._dev = dev

    def read(self, n=-1):
        return self._dev._stdin_read(n)

    def readinto(self, buf, n=None):
        want = len(buf) if n is None else n
        data = self._dev._stdin_read(want, exact=False)
        buf[:len(data)] = data
        return len(data)

    def readline(self):
        return self._dev._stdin_readline()

    def fileno(self):
        return 0


class _In:
    """sys.stdin (text)"""

    def __init__(self, dev):
        self._dev = dev
        self.buffer = _InBuf(dev)

    def read(self, n=-1):
        return self._dev._stdin_read(n).decode("utf-8", "replace")

    def readinto(self, buf, n=None):
        return self.buffer.readinto(buf, n)

    def readline(self):
        return self._dev._stdin_readline().decode("utf-8", "replace")

    def fileno(self):
        return 0


# --------------------------------------------------------------------------------------
# Device: the board's interpreter + REPL state machine.  Outlives TCP clients.
# --------------------------------------------------------------------------------------
def _ledger(profile, via, reason):
    """MPY_FAKEBOARD_RESET_LEDGER=<file>: append one JSON line per chip reset (see the module docstring)."""
    path = os.environ.get("MPY_FAKEBOARD_RESET_LEDGER")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"profile": profile, "via": via, "reason": reason, "pid": os.getpid()}) + "\n")
    except OSError:
        pass


class Device:
    _PASSTHROUGH = ("array", "binascii", "collections", "heapq", "io", "json", "math", "random",
                    "re", "struct", "cmath")
    _ALIAS = {"ujson": "json", "ubinascii": "binascii", "uhashlib": "hashlib", "uos": "os",
              "utime": "time", "uselect": "select", "ustruct": "struct", "uio": "io",
              "uerrno": "errno", "urandom": "random", "ure": "re", "uarray": "array",
              "ucollections": "collections", "uheapq": "heapq"}

    def __init__(self, board: "FakeBoard"):
        self.board = board
        self.profile = board.profile
        self.faults = board.faults
        self.root = board.root_str
        self.lock = threading.RLock()
        self.mode = "friendly"           # friendly | raw  (pyexec_mode_kind: survives soft reset)
        self.running = False             # a worker owns the console (program / boot / REPL line)
        self.worker = None
        self._armed = False
        self._ready = False
        self._pending = None
        self._intr_pending = False
        self.dead = False
        self.line = bytearray()
        self.cont = []
        self.paste = None                # raw paste state
        self.fpaste = None               # friendly paste mode lines
        self._e_state = False
        self._e_buf = bytearray()
        self._esc = 0
        self._last_cr = False
        self._auto_ind = 0
        self._user_ind = False
        self.kbd_intr_char = 3
        self.stdin = _StdinBuf(self.profile.get("stdin_buffer"))
        self._nworkers = 0
        self._xfer = 0                   # transfer bytes on the current connection
        self._drop_rest = False
        self._open_files = []            # strong refs: closed explicitly at soft reset / kill
        self.t_power = time.monotonic()
        self.clock_base = None           # (seconds since the port's epoch, monotonic) once machine.RTC().datetime(...) set it
        self.reset_cause = 1             # PWRON_RESET
        self.reset_count = {"soft": 0, "hard": 0}
        self._reset_req = None
        self._deferred_reset = None
        self._open_prog = None
        self.modules = {}
        self._errno = dict(_ERRNO_BASE)
        self._errno.update(self.profile.get("errno_overrides") or {})
        self._build_static()
        self._reset_vm()

    # ------------------------------------------------------------------ static data
    def _build_static(self):
        p = self.profile
        self.banner_line = "MicroPython %s; %s" % (p["version_full"], p["machine"])
        self.banner = (self.banner_line + "\r\nType \"help()\" for more information.\r\n").encode()
        self.uname_result = None
        if p.get("uname", True):
            self.uname_result = _AttrTuple(
                ("sysname", "nodename", "release", "version", "machine"),
                (p["sysname"], p["nodename"], p["release"], p["version_full"], p["machine"]))
        self.garbage = b""
        if self.faults.has("garbage_before_banner"):
            self.garbage = self.faults.arg("garbage_before_banner", _DEFAULT_GARBAGE)

    def oserror(self, name):
        return _UOSError(self._errno.get(name, self._errno["EIO"]), name)

    def ev(self, _event, **kw):
        return self.board.events.add(_event, **kw)

    def state(self) -> dict:
        return {"mode": self.mode, "running": self.running, "kbd_intr": self.kbd_intr_char,
                "resets": dict(self.reset_count), "reset_cause": self.reset_cause,
                "stdin_pending": len(self.stdin.buf)}

    # ------------------------------------------------------------------ output
    def tx(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8", "surrogateescape")
        self.board._tx(data)

    def txs(self, s):
        self.tx(_crlf(s))

    # ------------------------------------------------------------------ fs helpers
    def _check_quota(self, n):
        if not self.faults.has("disk_full"):
            return
        q = self.faults.arg("disk_full", 4096)
        used = 0
        for dp, _dn, fns in os.walk(self.root):
            for fn in fns:
                try:
                    used += os.path.getsize(os.path.join(dp, fn))
                except OSError:
                    pass
        if used + n > q:
            raise self.oserror("ENOSPC")

    def _make_open(self, fos):
        dev = self

        def dev_open(path, mode="r", *a, **k):
            if isinstance(path, int):
                raise dev.oserror("EINVAL")
            if not isinstance(mode, str):
                raise TypeError("mode must be str")
            h, virt = fos._host(path)
            writing = any(c in mode for c in "wax+")
            if writing:
                fos._rw()
            if virt or os.path.isdir(h):
                raise dev.oserror("EISDIR")
            hm = mode.replace("t", "")
            try:
                if "b" in hm:
                    f = open(h, hm)
                else:
                    f = open(h, hm, encoding="utf-8", errors="surrogateescape", newline="")
            except OSError as e:
                raise fos._wrap(e)
            dev._open_files[:] = [x for x in dev._open_files if not x.closed]
            dev._open_files.append(f)
            if writing and dev.faults.has("disk_full"):
                return _DevFile(f, dev)
            return f

        return dev_open

    # ------------------------------------------------------------------ the VM
    def _reset_vm(self):
        """Fresh namespace and module cache (a soft reset); ticks and files persist."""
        self._close_files()
        caps = self.profile["caps"]                  # re-read at every soft reset (faults can change)
        self.has_compile = bool(caps.get("compile", True)) and not self.faults.has("no_compile")
        ha = caps.get("hashlib", True)
        self.hashlib_cap = False if (self.faults.has("no_hashlib") or ha is False) else ha
        self.kbd_intr_char = 3
        self.modules = {}
        self.fos = _FakeOS(self)
        dev = self
        self.out = _Out(self)
        self.stdin_obj = _In(self)

        def dev_print(*a, sep=" ", end="\n", file=None, flush=False):
            (file or dev.out).write(sep.join(str(x) for x in a) + end)

        def dev_input(prompt=""):
            return dev._input(prompt)

        def dev_import(name, g=None, l=None, fromlist=(), level=0):
            return dev.do_import(name, fromlist, level, g)

        def help(obj=None):  # noqa: A001
            dev._help(obj)

        b = dict(vars(builtins))
        for n in ("FileNotFoundError", "FileExistsError", "PermissionError", "IsADirectoryError",
                  "NotADirectoryError", "InterruptedError", "BlockingIOError", "ChildProcessError",
                  "ConnectionError", "ConnectionAbortedError", "ConnectionRefusedError",
                  "ConnectionResetError", "BrokenPipeError", "TimeoutError", "ProcessLookupError",
                  "ModuleNotFoundError", "RecursionError", "breakpoint", "exit", "quit",
                  "copyright", "credits", "license", "aiter", "anext", "ascii", "format",
                  "EncodingWarning", "BaseExceptionGroup", "ExceptionGroup", "PythonFinalizationError"):
            b.pop(n, None)
        if not self.has_compile:
            b.pop("compile", None)
        b.update(print=dev_print, open=self._make_open(self.fos), __import__=dev_import,
                 input=dev_input, help=help)
        self.ns = {"__name__": "__main__", "__builtins__": b}
        self.dev_builtins = b
        self._strong, self._weak = self._build_modules()
        self._frozen = self._build_frozen()

    @staticmethod
    def _newmod(name):
        """A module object without the None __spec__/__loader__ that types.ModuleType() puts in its dict:
        traceback/linecache on Python 3.12+ warns ('Module globals is missing a __spec__.loader') about those."""
        m = types.ModuleType(name)
        m.__dict__.pop("__spec__", None)
        m.__dict__.pop("__loader__", None)
        return m

    @classmethod
    def _mkmod(cls, name, **attrs):
        m = cls._newmod(name)
        m.__dict__.update(attrs)
        return m

    def _build_modules(self):
        p = self.profile
        dev = self
        caps = p["caps"]
        t = time
        e2000 = 946684800 if caps.get("epoch2000", True) else 0

        def now_us():
            return int((time.monotonic() - dev.t_power) * 1000000)

        def board_secs():
            """Seconds since the port's epoch: the host clock, or since power-on when the clock is unset, or the RTC."""
            if dev.clock_base is not None:
                base, mono = dev.clock_base
                return base + (time.monotonic() - mono)
            if caps.get("clock_unset"):
                return time.monotonic() - dev.t_power
            return t.time() - e2000

        def tm_time():
            return int(board_secs())

        def tt(secs=None):
            g = t.gmtime(int(board_secs() if secs is None else secs) + e2000)
            return (g.tm_year, g.tm_mon, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec, g.tm_wday, g.tm_yday)

        class RTC:
            def __init__(s, *a, **k):
                pass

            def init(s, dt):
                s.datetime(dt)

            def datetime(s, dt=None):
                if dt is None:
                    now = board_secs()
                    g = t.gmtime(int(now) + e2000)
                    return (g.tm_year, g.tm_mon, g.tm_mday, g.tm_wday, g.tm_hour, g.tm_min, g.tm_sec,
                            int((now % 1) * 1000000))
                y, mo, d, _wd, h, mi, sec = (int(x) for x in tuple(dt)[:7])
                dev.clock_base = (calendar.timegm((y, mo, d, h, mi, sec, 0, 0, 0)) - e2000, time.monotonic())
                dev.ev("rtc_set", time=[y, mo, d, h, mi, sec])

        timemod = self._mkmod(
            "time",
            sleep=self._sleep, sleep_ms=lambda m: self._sleep(m / 1000.0),
            sleep_us=lambda u: self._sleep(u / 1000000.0), time=tm_time,
            time_ns=lambda: int(board_secs() * 1000000000),
            ticks_ms=lambda: (now_us() // 1000) & 0x3FFFFFFF,
            ticks_us=lambda: now_us() & 0x3FFFFFFF,
            ticks_cpu=lambda: now_us() & 0x3FFFFFFF,
            ticks_diff=lambda a, b: ((a - b + 0x20000000) & 0x3FFFFFFF) - 0x20000000,
            ticks_add=lambda a, d: (a + d) & 0x3FFFFFFF,
            localtime=tt, gmtime=tt,
            mktime=lambda x: calendar.timegm(tuple(x[:6]) + (0, 0, 0)) - e2000)

        fos = self.fos
        osd = dict(listdir=fos.listdir, ilistdir=fos.ilistdir, stat=fos.stat, mkdir=fos.mkdir,
                   rmdir=fos.rmdir, remove=fos.remove, unlink=fos.unlink, rename=fos.rename,
                   getcwd=fos.getcwd, chdir=fos.chdir, statvfs=fos.statvfs, sync=fos.sync,
                   urandom=fos.urandom, sep="/")
        if p.get("uname", True):
            osd["uname"] = fos.uname
        osmod = self._mkmod("os", **osd)

        impl = {"name": "micropython", "version": tuple(p["version_tuple"]), "_machine": p["machine"]}
        for k, v in (p.get("impl_extra") or {}).items():
            if v is not None:
                impl[k] = v
        self.implementation = _AttrTuple(tuple(impl), tuple(impl.values()))

        def sys_exit(code=0):
            raise SystemExit(code)

        def print_exception(exc, file=None):
            (file or dev.out).write(dev._fmt_exc(exc))

        self.sysmod = self._mkmod(
            "sys", implementation=self.implementation, platform=p["platform"],
            path=list(p["sys_path"]), modules=self.modules, stdout=self.out, stderr=self.out,
            stdin=self.stdin_obj, version="3.4.0; MicroPython " + p["version_full"],
            version_info=(3, 4, 0), byteorder="little", maxsize=2 ** 31 - 1, argv=[],
            exit=sys_exit, print_exception=print_exception, executable="")

        def machine_reset():
            raise _HardResetExc()

        def machine_soft_reset():
            raise _SoftResetExc()

        class Pin:
            OUT, IN, OPEN_DRAIN = 1, 0, 2
            PULL_UP, PULL_DOWN = 1, 2
            IRQ_RISING, IRQ_FALLING = 1, 2

            def __init__(s, *a, **k):
                s._v = 0

            def init(s, *a, **k):
                pass

            def value(s, v=None):
                if v is None:
                    return s._v
                s._v = int(bool(v))

            def on(s):
                s._v = 1

            def off(s):
                s._v = 0

            __call__ = value

        if p.get("machine_api") == "unix":
            mach = dict(soft_reset=machine_soft_reset, idle=lambda: dev._sleep(0.001),
                        mem8={}, mem16={}, mem32={})
        else:
            mach = dict(
                reset=machine_reset, soft_reset=machine_soft_reset,
                reset_cause=lambda: dev.reset_cause, freq=lambda *a: p["freq"],
                idle=lambda: dev._sleep(0.001), Pin=Pin, mem32={}, mem8={}, mem16={},
                PWRON_RESET=1, HARD_RESET=2, WDT_RESET=3, DEEPSLEEP_RESET=4, SOFT_RESET=5,
                disable_irq=lambda: 0, enable_irq=lambda s=0: None,
                lightsleep=lambda ms=0: dev._sleep(ms / 1000.0), deepsleep=machine_reset)
            if caps.get("rtc", True):
                mach["RTC"] = RTC
        if p.get("unique_id") is not None:
            uid = bytes(p["unique_id"])
            mach["unique_id"] = lambda: uid
        machine = self._mkmod("machine", **mach)

        def kbd_intr(c):
            dev.kbd_intr_char = int(c)

        micropython = self._mkmod(
            "micropython", const=lambda x: x, opt_level=lambda *a: 0, mem_info=lambda *a: None,
            kbd_intr=kbd_intr, stack_use=lambda: 0, qstr_info=lambda *a: None,
            heap_lock=lambda: None, heap_unlock=lambda: None, schedule=lambda f, a: f(a),
            alloc_emergency_exception_buf=lambda n: None)
        free = int(caps.get("mem_free", 100000))
        gcmod = self._mkmod("gc", collect=lambda: None, mem_free=lambda: free,
                            mem_alloc=lambda: 32000, enable=lambda: None, disable=lambda: None,
                            isenabled=lambda: True, threshold=lambda *a: -1)
        errmod = self._mkmod("errno", errorcode={v: k for k, v in self._errno.items()},
                             **dict(self._errno))
        strong = {"os": osmod, "sys": self.sysmod, "time": timemod, "machine": machine,
                  "micropython": micropython, "gc": gcmod, "errno": errmod,
                  "select": self._make_select()}
        # modules the profile marks weak can be shadowed by a same-named file on sys.path
        weak_names = set(p.get("weak_modules") or [])
        weak = {n: strong.pop(n) for n in list(strong) if n in weak_names}
        self._c_sources = {k: v for k, v in (p.get("c_modules") or {}).items() if v}
        return strong, weak

    def _make_select(self):
        dev = self
        POLLIN, POLLOUT, POLLERR, POLLHUP = 1, 4, 8, 16

        def ready(obj, ev):
            if isinstance(obj, (_In, _InBuf)):
                return POLLIN if (ev & POLLIN and dev.stdin.buf) else 0
            if isinstance(obj, (_Out, _OutBuf)):
                return POLLOUT if ev & POLLOUT else 0
            return ev & (POLLIN | POLLOUT)

        def wait_ready(items, timeout_ms):
            """items: list of (obj, eventmask) -> list of (obj, revents)"""
            deadline = None if (timeout_ms is None or timeout_ms < 0) else time.monotonic() + timeout_ms / 1000.0
            cond = dev.stdin.cond
            with cond:
                while True:
                    res = [(o, r) for o, r in ((o, ready(o, ev)) for o, ev in items) if r]
                    if res:
                        return res
                    if dev.dead:
                        raise _Shutdown()
                    if deadline is None:
                        cond.wait(0.05)
                    else:
                        rem = deadline - time.monotonic()
                        if rem <= 0:
                            return []
                        cond.wait(min(rem, 0.05))

        class Poll:
            def __init__(s):
                s._reg = collections.OrderedDict()

            def register(s, obj, eventmask=POLLIN | POLLOUT):
                s._reg[id(obj)] = (obj, eventmask)

            def modify(s, obj, eventmask):
                s._reg[id(obj)] = (obj, eventmask)

            def unregister(s, obj):
                s._reg.pop(id(obj), None)

            def poll(s, timeout=-1):
                return wait_ready(list(s._reg.values()), timeout)

            def ipoll(s, timeout=-1, flags=0):
                return iter(s.poll(timeout))

        def select_select(rl, wl, xl, timeout=None):
            items = [(o, POLLIN) for o in rl] + [(o, POLLOUT) for o in wl]
            res = wait_ready(items, None if timeout is None else timeout * 1000)
            return ([o for o, r in res if r & POLLIN and o in rl],
                    [o for o, r in res if r & POLLOUT and o in wl], [])

        return self._mkmod("select", poll=Poll, select=select_select, POLLIN=POLLIN,
                           POLLOUT=POLLOUT, POLLERR=POLLERR, POLLHUP=POLLHUP)

    def _build_frozen(self):
        """{module_name: (source, filename, is_pkg)} from the profile's frozen files."""
        out = {}
        for fn, src in (self.profile.get("frozen") or {}).items():
            parts = fn[:-3].split("/")
            if parts[-1] == "__init__":
                out[".".join(parts[:-1])] = (src, fn, True)
            else:
                out[".".join(parts)] = (src, fn, False)
        return out

    def builtin_names(self):
        names = set(self._strong) | set(self._weak) | {"__main__", "builtins"}
        names |= set(self._c_sources)
        # like real MicroPython (py/builtinhelp.c): frozen modules print as their path without '.py', so a frozen package
        # shows as 'pkg/__init__' and 'pkg/sub', never as plain 'pkg'
        names |= {fn[:-3] for fn in (self.profile.get("frozen") or {}) if fn.endswith(".py")}
        names |= {"binascii", "collections", "json", "math", "random", "re", "struct", "array", "heapq", "io"}
        if self.hashlib_cap:
            names.add("hashlib")
        return sorted(names)

    # ------------------------------------------------------------------ imports
    def _hashlib_module(self):
        cap = self.hashlib_cap
        if not cap:
            return None
        names = {True: ("sha256", "sha1", "md5"), "sha256": ("sha256",), "sha1": ("sha1",)}[cap]
        return self._mkmod("hashlib", **{n: getattr(host_hashlib, n) for n in names})

    def do_import(self, name, fromlist=(), level=0, glb=None):
        if level and glb:
            pkg = glb.get("__package__") or glb.get("__name__", "")
            if "__path__" not in glb and "." in pkg:
                pkg = pkg.rpartition(".")[0]
            for _ in range(level - 1):
                pkg = pkg.rpartition(".")[0]
            name = (pkg + "." + name) if name else pkg
        parts = name.split(".")
        leaf = None
        for i in range(1, len(parts) + 1):
            leaf = self._import_one(".".join(parts[:i]))
        if fromlist:
            for item in fromlist:
                if item != "*" and not hasattr(leaf, item) and hasattr(leaf, "__path__"):
                    try:
                        self._import_one(leaf.__name__ + "." + item)
                    except ImportError:
                        pass
            return leaf
        return self.modules[parts[0]]

    def _import_one(self, name):
        if name in self.modules:
            return self.modules[name]
        name_u = self._ALIAS.get(name, name)
        if name_u != name and name_u in self.modules:
            return self.modules[name_u]
        parent, _, last = name.rpartition(".")
        if parent:
            pmod = self.modules.get(parent) or self._import_one(parent)
            paths = getattr(pmod, "__path__", None)
            if paths is None:
                raise ImportError("no module named '%s'" % name)
            mod = self._load_from_dirs(name, paths, last)
            setattr(pmod, last, mod)
            return mod
        # 1. strong builtins and C modules; 2. sys.path in order; 3. weak builtins / stdlib
        if name_u in self._strong:
            return self._register(name, self._strong[name_u])
        if name_u in self._c_sources:
            return self._register(name, self._exec_c_module(name_u))
        for entry in list(self.sysmod.path):
            if entry == ".frozen":
                if name_u in self._frozen:
                    return self._load_frozen(name_u)
                continue
            m = self._try_dir(name, entry, name)
            if m is not None:
                return m
        if name_u in self._weak:
            return self._register(name, self._weak[name_u])
        if name_u == "hashlib":
            hm = self._hashlib_module()
            if hm is not None:
                return self._register(name, hm)
        if name_u in self._PASSTHROUGH:
            return self._register(name, __import__(name_u))
        raise ImportError("no module named '%s'" % name)

    def _register(self, name, mod):
        self.modules[name] = mod
        return mod

    def _exec_c_module(self, name):
        m = self._newmod(name)
        m.__dict__["__builtins__"] = self.dev_builtins
        exec(compile(self._c_sources[name], "<%s>" % name, "exec"), m.__dict__)
        del m.__dict__["__builtins__"]
        return m

    def _load_frozen(self, name):
        src, fn, is_pkg = self._frozen[name]
        return self._exec_module(name, src, fn, is_pkg, None)

    def _load_from_dirs(self, full, dirs, last):
        for d in dirs:
            if d == ".frozen":
                if full in self._frozen:
                    return self._load_frozen(full)
                continue
            m = self._try_dir(full, d, last)
            if m is not None:
                return m
        raise ImportError("no module named '%s'" % full)

    def _try_dir(self, full, d, last):
        """Look for <d>/<last>.py or <d>/<last>/__init__.py on the device filesystem."""
        base = d.rstrip("/") + "/" if d else ""
        rel_py, rel_pkg = base + last + ".py", base + last
        try:
            h, virt = self.fos._host(rel_py)
            hp, virtp = self.fos._host(rel_pkg + "/__init__.py")
        except OSError:
            return None
        if not virt and os.path.isfile(h):
            return self._exec_module(full, self._read_text(h), rel_py, False, None)
        if not virtp and os.path.isfile(hp):
            return self._exec_module(full, self._read_text(hp), rel_pkg + "/__init__.py", True, [rel_pkg])
        return None

    @staticmethod
    def _read_text(h):
        with open(h, "r", encoding="utf-8", errors="surrogateescape", newline="") as f:
            return f.read()

    def _exec_module(self, full, src, filename, is_pkg, path):
        m = self._newmod(full)
        m.__dict__["__builtins__"] = self.dev_builtins
        m.__file__ = filename
        m.__package__ = full if is_pkg else full.rpartition(".")[0]
        if is_pkg:
            m.__path__ = path if path is not None else [".frozen"]
        self.modules[full] = m
        try:
            exec(compile(src, filename, "exec"), m.__dict__)
        except BaseException:
            self.modules.pop(full, None)
            raise
        return m

    # ------------------------------------------------------------------ help()
    def _help(self, obj=None):
        if obj is None:
            self.txs(
                "Welcome to MicroPython!\n\n"
                "For online docs please visit http://docs.micropython.org/\n\n"
                "Control commands:\n  CTRL-A        -- on a blank line, enter raw REPL mode\n"
                "  CTRL-B        -- on a blank line, enter normal REPL mode\n"
                "  CTRL-C        -- interrupt a running program\n"
                "  CTRL-D        -- on a blank line, do a soft reset of the board\n"
                "  CTRL-E        -- on a blank line, enter paste mode\n\n"
                "For further help on a specific object, type help(obj)\n")
        elif obj == "modules":
            names = self.builtin_names()
            lines = ["".join("%-18s" % n for n in names[i:i + 4]).rstrip() for i in range(0, len(names), 4)]
            self.txs("\n".join(lines) + "\nPlus any modules on the filesystem\n")
        else:
            self.txs("object %r is of type %s\n" % (obj, type(obj).__name__))

    # ------------------------------------------------------------------ sleeping / stdin (worker side)
    def _sleep(self, secs):
        end = time.monotonic() + max(0.0, float(secs))
        cond = self.stdin.cond
        with cond:
            while True:
                if self.dead:
                    raise _Shutdown()
                rem = end - time.monotonic()
                if rem <= 0:
                    return
                cond.wait(min(rem, 0.05))

    def _stdin_read(self, n=-1, exact=True):
        """Block for host input.  n<0 returns as soon as anything arrives (a tty never reaches EOF)."""
        cond = self.stdin.cond
        out = bytearray()
        unlimited = n is None or n < 0
        with cond:
            while True:
                buf = self.stdin.buf
                if buf:
                    take = len(buf) if unlimited else min(n - len(out), len(buf))
                    out += buf[:take]
                    del buf[:take]
                    if unlimited or not exact or len(out) >= n:
                        return bytes(out)
                    continue
                if not unlimited and len(out) >= n:
                    return bytes(out)
                if self.dead:
                    raise _Shutdown()
                cond.wait(0.05)

    def _stdin_readline(self):
        out = bytearray()
        while True:
            c = self._stdin_read(1)
            out += c
            if c == b"\n":
                return bytes(out)

    def _input(self, prompt=""):
        if prompt:
            self.out.write(str(prompt))
        line = bytearray()
        while True:
            c = self._stdin_read(1)[0]
            if c in (13, 10):
                self.tx(b"\r\n")
                return line.decode("utf-8", "replace")
            if c == CTRL_D and not line:
                raise EOFError()
            if c in (8, 127):
                if line:
                    line.pop()
                    self.tx(b"\x08\x1b[K")
                continue
            if c >= 32:
                line.append(c)
                self.tx(bytes([c]))

    # ------------------------------------------------------------------ exceptions
    def _fmt_exc(self, e):
        lines = ["Traceback (most recent call last):\n"]
        tb = getattr(e, "__traceback__", None)
        if isinstance(e, SyntaxError):
            lines.append('  File "%s", line %s\n' % (e.filename or "<stdin>", e.lineno or 1))
        for fr in traceback.extract_tb(tb) if tb is not None else []:
            if not _internal_frame(fr.filename):
                lines.append('  File "%s", line %d, in %s\n' % (fr.filename, fr.lineno, fr.name))
        if len(lines) == 1:
            lines = []                    # no frames: MicroPython prints only the exception line
        if isinstance(e, KeyboardInterrupt):
            msg = "KeyboardInterrupt: "
        elif isinstance(e, _UOSError):
            msg = "OSError: " + str(e)
        elif isinstance(e, OSError) and (e.errno or (e.args and isinstance(e.args[0], int))):
            num = e.errno or e.args[0]
            names = {v: k for k, v in self._errno.items()}
            msg = "OSError: [Errno %d] %s" % (num, names.get(num) or host_errno.errorcode.get(num, "?"))
        elif isinstance(e, KeyError):
            msg = "KeyError: " + (str(e.args[0]) if len(e.args) == 1 else str(e.args))
        elif isinstance(e, ModuleNotFoundError):
            msg = "ImportError: " + str(e)
        elif isinstance(e, NameError):
            msg = "NameError: " + str(e).replace("is not defined", "isn't defined")
        elif isinstance(e, ZeroDivisionError):
            msg = "ZeroDivisionError: divide by zero"
        elif isinstance(e, SyntaxError):
            msg = "SyntaxError: " + (e.msg if e.msg else "invalid syntax")
        else:
            msg = "%s: %s" % (type(e).__name__, e)
        lines.append(msg + "\n")
        return "".join(lines)

    # ------------------------------------------------------------------ running user code
    def _exec_user(self, src, filename, kind, eval_print=False):
        """Run source in the device namespace; return an _Outcome.  Raises only _Shutdown."""
        if self.dead:
            raise _Shutdown()
        t0 = time.monotonic()
        self.kbd_intr_char = 3             # pyexec re-arms Ctrl-C before every execution
        self.ev("program_start", kind=kind, digest=_digest(src), n=len(src))
        self._open_prog = (kind, t0)
        exc = None
        try:
            try:
                limit = self.profile.get("max_source_bytes")
                if limit and len(src.encode("utf-8", "surrogateescape")) > limit:
                    raise MemoryError("memory allocation failed, allocating %d bytes" % (len(src) * 3))
                if eval_print:
                    try:
                        code = compile(src, filename, "eval")
                    except SyntaxError:
                        code = compile(src, filename, "exec")
                        eval_print = False
                    r = eval(code, self.ns)
                    if eval_print and r is not None:
                        self.out.write(repr(r) + "\n")
                else:
                    exec(compile(src, filename, "exec"), self.ns)
            except BaseException as e:
                exc = e
        except BaseException as e2:       # an interrupt that landed inside the handler above
            exc = e2
        if isinstance(exc, _Shutdown):
            raise exc
        oc = _Outcome(kind)
        if exc is None:
            pass
        elif isinstance(exc, SystemExit):
            oc.reset, oc.reason = "soft", "sys.exit"
        elif isinstance(exc, _SoftResetExc):
            oc.reset, oc.reason = "soft", "machine.soft_reset"
        elif isinstance(exc, _HardResetExc):
            oc.reset, oc.reason = "hard", "machine.reset"
        elif isinstance(exc, _ResetRequest):
            oc.reset, oc.reason = self._reset_req or ("soft", "requested")
        else:
            oc.ok = False
            oc.interrupted = isinstance(exc, KeyboardInterrupt)
            oc.tb = self._fmt_exc(exc)
        self._end_program(oc)
        return oc

    def _end_program(self, oc):
        """Log program_end for the program that _exec_user started (also after a stray interrupt)."""
        op, self._open_prog = self._open_prog, None
        if op is None:
            return
        kind, t0 = op
        result = "reset" if oc.reset else ("interrupted" if oc.interrupted else ("ok" if oc.ok else "exception"))
        self.ev("program_end", kind=kind, result=result, ms=int((time.monotonic() - t0) * 1000),
                reason=oc.reason)

    # ------------------------------------------------------------------ worker threads
    def _spawn(self, body, name):
        """Start a worker.  Caller holds self.lock.  `body()` returns an _Outcome."""
        if self.dead:
            return
        self.running = True
        self._armed = True
        self._ready = False              # becomes True once the thread is inside _worker_main
        self._pending = None
        self._intr_pending = False
        self._nworkers += 1
        holder = []
        th = threading.Thread(target=self._worker_main, args=(body, holder),
                              name="fakeboard-worker-%d-%s" % (self._nworkers, name), daemon=True)
        holder.append(th)
        self.worker = th
        th.start()

    def _worker_main(self, body, holder):
        me = holder[0]
        try:
            while body is not None:
                with self.lock:
                    # An interrupt that arrived before this thread was running our code is delivered
                    # here: injecting into threading's own bootstrap would kill the thread silently.
                    self._ready = True
                    pend, self._pending = self._pending, None
                try:
                    if self.dead:
                        raise _Shutdown()
                    if pend is not None:
                        raise pend()
                    oc = body()
                except _Shutdown:
                    return
                except BaseException as e:      # an interrupt that landed outside the program text
                    oc = _Outcome("stray", ok=False, interrupted=isinstance(e, KeyboardInterrupt),
                                  tb=self._fmt_exc(e))
                    if isinstance(e, _ResetRequest):
                        oc.ok = True
                        oc.tb = ""
                        oc.reset, oc.reason = self._reset_req or ("soft", "requested")
                    self._end_program(oc)
                self._disarm(me)
                with self.lock:
                    body = self._after(oc)
                    if body is not None:
                        self._armed = True
                        self._intr_pending = False
        except BaseException:                   # _Shutdown or a bug: never leave the console locked
            pass
        finally:
            with self.lock:
                if self.worker is me:
                    self.worker = None
                    self.running = False
                    self._armed = False

    def _disarm(self, me):
        """After this returns no async exception can reach this thread any more."""
        while True:
            try:
                with self.lock:
                    self._armed = False
                    self._intr_pending = False
                    if me.ident:
                        _async_clear(me.ident)
                return
            except (KeyboardInterrupt, _ResetRequest):
                continue

    def _inject(self, exc):
        """Deliver an async exception to the running worker.  Caller holds self.lock."""
        w = self.worker
        if not (w and self._armed):
            return False
        if not self._ready or not w.ident:
            self._pending = exc                  # delivered as soon as the thread enters _worker_main
            return True
        _async_raise(w.ident, exc)
        self._intr_pending = True
        with self.stdin.cond:
            self.stdin.cond.notify_all()
        return True

    # ------------------------------------------------------------------ after-hooks (lock held)
    def _after(self, oc):
        """A worker body finished.  Returns the next body (a reboot) or None."""
        k = oc.kind
        if oc.reset:
            if k == "raw":
                self.tx(b"\x04\x04")
            return self._begin_boot(oc.reset, oc.reason, announce=True)
        self.running = False             # idle BEFORE the host can see the prompt (and the lock is held)
        if k == "stray":
            if self.mode == "raw":
                self.tx(b"\x04" + _crlf(oc.tb).encode() + b"\x04>")
            else:
                self.txs(oc.tb)
                self.tx(b">>> ")
        elif k == "friendly":
            if oc.tb:
                self.txs(oc.tb)
            self.tx(b">>> ")
        elif k == "raw":
            self.tx(b"\x04" + (_crlf(oc.tb).encode("utf-8", "surrogateescape") if oc.tb else b"") + b"\x04>")
        elif k == "boot":
            if self.mode == "raw":
                self.tx(self.garbage + b"raw REPL; CTRL-B to exit\r\n>")
            else:
                self.tx(self.garbage + self.banner + b">>> ")
        self._finish_idle()
        return None

    def _finish_idle(self):
        """Free the console and replay input that arrived while the program ran (as a UART would)."""
        self.running = False
        dr, self._deferred_reset = self._deferred_reset, None
        if dr is not None:
            self._spawn(self._begin_boot(dr[0], dr[1], announce=(dr[0] == "soft")), "reset")
            return
        with self.stdin.cond:
            left = bytes(self.stdin.buf)
            del self.stdin.buf[:]
        if left:
            self._feed_locked(left)

    # ------------------------------------------------------------------ boot / reset
    def _begin_boot(self, kind, reason, announce):
        """Log the reset and return the body that performs it ('soft' | 'hard' | 'power')."""
        if kind == "soft":
            self.reset_count["soft"] += 1
            self.reset_cause = 5
            self.ev("soft_reset", reason=reason, mode=self.mode)
        elif kind == "hard":
            self.reset_count["hard"] += 1
            via = "machine" if reason == "machine.reset" else ("pulse" if reason in ("rts-pulse", "usb-jtag") else "test")
            self.reset_cause = {"machine": self.profile.get("machine_reset_cause", 1),
                                "pulse": self.profile.get("pulse_reset_cause", 1)}.get(via, 2)
            self.t_power = time.monotonic()
            self.clock_base = None       # a chip reset loses a clock that was set (like a power cycle on most boards)
            self.mode = "friendly"
            self.ev("hard_reset", reason=reason, via=via)
            _ledger(self.profile.get("name"), via, reason)
        else:
            self.reset_cause = 1
            self.ev("power_on", reason=reason)
        self.running = True
        return lambda: self._boot_body(kind, announce)

    def _boot_body(self, kind, announce):
        self.line.clear()
        self.cont = []
        self.paste = None
        self.fpaste = None
        self._e_state = False
        self._esc = 0
        self._last_cr = False
        self._auto_ind = 0
        self._user_ind = False
        self._reset_vm()
        if kind == "hard":
            if (self.profile.get("usb") or {}).get("kind") == "native-cdc":
                self.board._schedule_hangup("usb re-enumeration after hard reset")
            elif self.profile.get("rom_noise"):
                self.tx(self.profile["rom_noise"])
        elif kind == "soft" and announce:
            self.tx(b"MPY: soft reboot\r\n")
        ok = True
        if self.faults.has("delay_boot"):
            oc = self._exec_user("import time\ntime.sleep(%r)\n" % self.faults.arg("delay_boot", 1.5),
                                 "boot.py", "boot.py")
            if oc.reset:
                oc.kind = "boot"
                return oc
            if not oc.ok:
                self.txs(oc.tb)
                ok = False
        for fn in ("boot.py", "main.py"):
            if fn == "main.py" and (not ok or self.mode != "friendly"):
                break
            try:
                h, virt = self.fos._host(fn)
            except OSError:
                continue
            if virt or not os.path.isfile(h):
                continue
            oc = self._exec_user(self._read_text(h), fn, fn)
            if oc.reset:
                oc.kind = "boot"
                return oc
            if not oc.ok:
                self.txs(oc.tb)
                ok = False
        return _Outcome("boot")

    def power_up(self, reason="start"):
        with self.lock:
            if self.dead:
                return
            self._spawn(self._begin_boot("power", reason, announce=False), "boot")

    def request_reset(self, kind, reason):
        """Reset the interpreter from outside (test API / faults)."""
        with self.lock:
            if self.dead:
                return
            if self.running and self.worker is not None:
                self._reset_req = (kind, reason)
                if not self._inject(_ResetRequest):          # worker is between programs: reset right after
                    self._deferred_reset = (kind, reason)
                return
            self._spawn(self._begin_boot(kind, reason, announce=(kind == "soft")), "reset")

    def kill(self, timeout=3.0):
        """Stop all interpreter threads (board shutdown)."""
        self.dead = True
        with self.stdin.cond:
            self.stdin.cond.notify_all()
        deadline = time.monotonic() + timeout
        while True:
            w = self.worker
            if w is None or (w.ident is not None and not w.is_alive()):
                break
            if w.ident is not None:
                try:
                    _async_raise(w.ident, _Shutdown)
                except Exception:
                    pass
            with self.stdin.cond:
                self.stdin.cond.notify_all()
            if w.ident is not None:
                w.join(0.05)
            else:
                time.sleep(0.005)               # still being started
            if time.monotonic() > deadline:
                break
        self._close_files()

    def _close_files(self):
        files, self._open_files[:] = list(self._open_files), []
        for f in files:
            try:
                f.close()
            except Exception:
                pass

    # ------------------------------------------------------------------ input from the host
    def on_attach(self):
        self._xfer = 0
        self._drop_rest = False

    def feed(self, data):
        with self.lock:
            self.board.rx_bytes += len(data)
            self._feed_locked(data)

    def _feed_locked(self, data):
        i, n = 0, len(data)
        while i < n:
            if self._drop_rest or self.dead:
                return
            if self.running and self.paste is None:
                # a program owns the console: bytes are its stdin, except the interrupt character
                seg = data[i:]
                ic = self.kbd_intr_char
                j = seg.find(bytes((ic,))) if 0 <= ic < 256 else -1
                if j < 0:
                    self._stdin_put(seg)
                    return
                if j:
                    self._stdin_put(seg[:j])
                self._interrupt_byte(ic, "running")
                i += j + 1
            elif self.paste is not None:
                i = self._paste_bulk(data, i)
            else:
                c = data[i]
                i += 1
                if self.mode == "raw":
                    self._raw_byte(c)
                else:
                    self._friendly_byte(c)

    def _stdin_put(self, data):
        if not data:
            return
        with self.stdin.cond:
            cap = self.stdin.cap
            if cap and len(self.stdin.buf) + len(data) > cap:
                keep = max(0, cap - len(self.stdin.buf))
                self.ev("stdin_overflow", dropped=len(data) - keep)
                data = data[:keep]
            self.stdin.buf += data
            self.stdin.cond.notify_all()
        self.ev("stdin_bytes", n=len(data), hex=bytes(data[:32]).hex())
        self._count_xfer(len(data))

    def _count_xfer(self, n):
        self._xfer += n
        f = self.faults
        if f.has("close_mid_transfer") and self._xfer >= f.arg("close_mid_transfer", 512) \
                and f.once("close_mid_transfer"):
            self.ev("fault", name="close_mid_transfer", bytes=self._xfer)
            self._drop_rest = True
            self.board._schedule_hangup("close_mid_transfer", abrupt=True)

    def _interrupt_byte(self, byte, state):
        delivered = swallowed = False
        if state == "running":
            if self.faults.has("ignore_ctrl_c"):
                swallowed = True
            else:
                delivered = self._inject(KeyboardInterrupt)
        self.ev("interrupt", state=state, delivered=delivered, swallowed=swallowed, byte=byte)

    # ---------------------------------------------------------------- raw REPL
    def _raw_byte(self, c):
        if self._e_state:                       # collecting \x05 A \x01
            self._e_buf.append(c)
            if len(self._e_buf) == 1:
                if c != 0x41:
                    self._flush_e()
            elif c == 1:
                self._e_state = False
                self._e_buf = bytearray()
                self._start_raw_paste()
            else:
                self._flush_e()
            return
        if c == CTRL_E:
            self._e_state = True
            self._e_buf = bytearray()
        elif c == CTRL_A:
            self.ev("raw_enter", already=True)
            self.line.clear()
            self.tx(self.garbage + b"raw REPL; CTRL-B to exit\r\n>")
        elif c == CTRL_B:
            self.mode = "friendly"
            self.line.clear()
            self.ev("raw_exit")
            self.tx(b"\r\n" + self.garbage + self.banner + b">>> ")
        elif c == CTRL_C:
            self._interrupt_byte(c, "idle")
            self.line.clear()
        elif c == CTRL_D:
            src, self.line = bytes(self.line), bytearray()
            self.tx(b"OK")
            if not src:
                self.tx(b"\r\n")
                self._spawn(self._begin_boot("soft", "ctrl-d-raw", announce=True), "reset")
            else:
                self._run_raw(src, paste=False)
        else:
            self.line.append(c)

    def _flush_e(self):
        """A \\x05 that was not a raw-paste request: its bytes are ordinary program text."""
        last = self._e_buf[-1]
        self.line += b"\x05" + bytes(self._e_buf[:-1])
        self._e_state = False
        self._e_buf = bytearray()
        self._raw_byte(last)

    @property
    def has_raw_paste(self):
        return bool(self.profile["caps"].get("raw_paste", True)) and not self.faults.has("no_raw_paste")

    def _start_raw_paste(self):
        if not self.has_raw_paste:
            self.tx(b"R\x00")
            return
        win = int(self.profile.get("raw_paste_window", 128))
        self.ev("paste_start", kind="raw", window=win)
        self.tx(b"R\x01" + bytes([win & 255, win >> 8]) + b"\x01")
        self.paste = {"buf": bytearray(), "win": win, "remain": win}

    def _paste_bulk(self, data, i):
        """Consume raw-paste bytes from data[i:] (flow control as in pyexec.c: the window credit
        byte is sent lazily, when the next byte is needed and the window is used up)."""
        p = self.paste
        n = len(data)
        while i < n and self.paste is p and not self._drop_rest:
            j3, j4 = data.find(b"\x03", i), data.find(b"\x04", i)
            ends = [x for x in (j3, j4) if x >= 0]
            j = min(ends) if ends else n
            while i < j:
                if p["remain"] == 0:
                    self.tx(b"\x01")
                    p["remain"] = p["win"]
                take = min(p["remain"], j - i)
                p["buf"] += data[i:i + take]
                p["remain"] -= take
                i += take
                self._count_xfer(take)
                if self._drop_rest:
                    return n
            if i >= n:
                break
            c = data[i]
            if p["remain"] == 0:
                self.tx(b"\x01")
                p["remain"] = p["win"]
            i += 1
            self.paste = None
            src = bytes(p["buf"])
            self.tx(b"\x04")                    # end of input acknowledged
            if c == CTRL_D:
                self._run_raw(src, paste=True)
            else:                               # Ctrl-C aborts the paste
                self.ev("paste_abort", n=len(src))
                self.ev("interrupt", state="paste", delivered=True, swallowed=False, byte=3)
                self.tx(b"\x04KeyboardInterrupt: \r\n\x04>")
        return i

    def _run_raw(self, src_bytes, paste):
        src = src_bytes.decode("utf-8", "surrogateescape")
        self._log_exec(src, "paste" if paste else "raw", paste=paste)

        def body():
            oc = self._exec_user(src, "<stdin>", "raw")
            oc.paste = paste
            return oc

        self._spawn(body, "raw")

    def _log_exec(self, src, mode, paste=False):
        extra = {"code": src} if self.board.capture else {}
        self.ev("exec", mode=mode, paste=paste, n=len(src.encode("utf-8", "surrogateescape")),
                digest=_digest(src), head=src[:60], **extra)
        self.board._exec_hook()

    # ---------------------------------------------------------------- friendly REPL
    def _friendly_byte(self, c):
        if self.fpaste is not None:
            return self._fpaste_byte(c)
        if self._esc:                           # swallow ESC [ ... final (arrows, Home, End ...)
            if self._esc == 1:
                self._esc = 2 if c in (0x5B, 0x4F) else 0
            elif 0x40 <= c <= 0x7E:
                self._esc = 0
            return
        if c not in (13, 10):
            self._last_cr = False
        if c == ESC:
            self._esc = 1
        elif c == CTRL_A:
            self.mode = "raw"
            self.line.clear()
            self.cont = []
            self.ev("raw_enter", already=False)
            self.tx(b"\r\n" + self.garbage + b"raw REPL; CTRL-B to exit\r\n>")
        elif c == CTRL_B:
            self.tx(b"\r\n" + self.garbage + self.banner + b">>> ")
        elif c == CTRL_C:
            self._interrupt_byte(c, "idle")
            self.line.clear()
            self.cont = []
            self._auto_ind = 0
            self._user_ind = False
            self.tx(b"\r\n>>> ")
        elif c == CTRL_D:
            if self.line or self.cont:
                return
            self.tx(b"\r\n")
            self._spawn(self._begin_boot("soft", "ctrl-d-friendly", announce=True), "reset")
        elif c == CTRL_E:
            self.fpaste = []
            self.line.clear()
            self.ev("paste_start", kind="friendly")
            self.tx(b"\r\npaste mode; Ctrl-C to cancel, Ctrl-D to finish\r\n=== ")
        elif c in (8, 127):
            self._backspace()
        elif c == 9:
            if self.cont and not self.line.strip():       # Tab indents in a block; completion is not modelled
                n = 4 - len(self.line) % 4
                self.line += b" " * n
                self.tx(b" " * n)
                self._user_ind = True
        elif c in (13, 10):
            if c == 10 and self._last_cr and self.profile.get("crlf_single_enter", False):
                self._last_cr = False
                return
            self._last_cr = (c == 13)
            self._enter()
        elif c >= 32:
            if c == 32 and all(b == 32 for b in self.line):          # typing leading whitespace
                if self._auto_ind and len(self.line) == self._auto_ind:
                    # the first typed space replaces the automatic indent (pasting indented code works)
                    n = self._auto_ind
                    del self.line[:]
                    self.tx(b"\x08" * n + b"\x1b[K")
                self._user_ind = True                                # typed indentation is not repeated
            self._auto_ind = 0
            self.line.append(c)
            self.tx(bytes([c]))

    def _backspace(self):
        if not self.line:
            return
        if self.profile.get("auto_indent", True) and self.cont and all(b == 32 for b in self.line):
            n = len(self.line) % 4 or 4          # indentation goes back to the previous 4-column stop
            del self.line[-n:]
            self.tx(b"\x08" * n + b"\x1b[K")
            return
        self.line.pop()
        self.tx(b"\x08\x1b[K")                  # [E] what readline.c of v1.29.0 prints

    _COMPOUND = ("if", "while", "for", "try", "with", "def", "class", "async")

    def _needs_more(self):
        """MicroPython's mp_repl_continue_with_input(): [E] checked against the v1.29.0 unix VM.
        A block ends only on a truly empty line (an auto-indented blank line continues it)."""
        last = self.cont[-1]
        if last == "":
            return False
        first = self.cont[0]
        compound = first.startswith("@") or any(
            first.startswith(k) and (len(first) == len(k) or first[len(k)] in " (:\t") for k in self._COMPOUND)
        if compound:
            if last.rstrip().endswith(":") or last[:1] in (" ", "\t") or last.startswith("@"):
                return True
        try:
            return codeop.compile_command("\n".join(self.cont), "<stdin>", "single") is None \
                and not compound
        except (SyntaxError, ValueError, OverflowError):
            return False

    def _enter(self):
        text = self.line.decode("utf-8", "surrogateescape")
        user_ind = self._user_ind
        self.line.clear()
        self._auto_ind = 0
        self._user_ind = False
        self.tx(b"\r\n")
        self.cont.append(text)
        if self._needs_more():
            self.tx(b"... ")
            if self.profile.get("auto_indent", True):
                base = len(text) - len(text.lstrip(" "))
                if text.rstrip().endswith(":"):
                    ind = base + 4
                elif text.strip() == "":
                    ind = base                       # Enter on an auto-indented blank line: same indent again
                else:
                    ind = 0 if user_ind else base    # typed indentation is not repeated, auto indent is
                if ind:
                    self.line += b" " * ind
                    self._auto_ind = ind
                    self.tx(b" " * ind)
            return
        src = "\n".join(self.cont)
        self.cont = []
        if not src.strip():
            self.tx(b">>> ")
            return
        self._run_friendly(src)

    def _run_friendly(self, src):
        self._log_exec(src, "friendly")
        multi = "\n" in src.strip("\n")
        code = src + "\n" if multi else src
        self._spawn(lambda: self._exec_user(code, "<stdin>", "friendly", eval_print=not multi), "line")

    def _fpaste_byte(self, c):
        if c == CTRL_C:
            self.fpaste = None
            self.line.clear()
            self._interrupt_byte(c, "idle")
            self.tx(b"\r\n>>> ")
        elif c == CTRL_D:
            lines = self.fpaste + ([self.line.decode("utf-8", "surrogateescape")] if self.line else [])
            self.fpaste = None
            self.line.clear()
            self.tx(b"\r\n")
            src = "\n".join(lines).strip("\n")
            if not src.strip():
                self.tx(b">>> ")
                return
            self._log_exec(src, "paste-mode", paste=True)
            self._spawn(lambda: self._exec_user(src + "\n", "<stdin>", "friendly"), "pastemode")
        elif c in (13, 10):
            if c == 10 and self._last_cr:
                self._last_cr = False
                return
            self._last_cr = (c == 13)
            self.fpaste.append(self.line.decode("utf-8", "surrogateescape"))
            self.line.clear()
            self.tx(b"\r\n=== ")
        elif c in (8, 127):
            if self.line:
                self.line.pop()
                self.tx(b"\x08\x1b[K")
        elif c >= 32 or c == 9:
            self._last_cr = False
            self.line.append(c)
            self.tx(bytes([c]))


# --------------------------------------------------------------------------------------
# FakeBoard: TCP server + device
# --------------------------------------------------------------------------------------
class _Client:
    def __init__(self, sock, cid, peer):
        self.sock = sock
        self.id = cid
        self.peer = peer
        self.dead = False
        self.reason = None
        self.thread = None
        self.rx = 0


_HEARTBEAT_MAIN = (
    "# fakeboard main_forever: heartbeat loop, interrupted only by Ctrl-C\n"
    "import time\n"
    "_n = 0\n"
    "while True:\n"
    "    print('heartbeat', _n)\n"
    "    _n += 1\n"
    "    time.sleep_ms(50)\n"
)

# Device-side programs for Run / stdin / Stop scenarios.  They run on the fake board AND on the real
# MicroPython VM (tools/mpunix_relay.py), so they only use MicroPython-safe code.
PROGRAMS = {
    # prints READY, then one line per key read with sys.stdin.read(1); 'q' ends it
    "echo_keys": (
        "import sys\n"
        "print(\"READY\")\n"
        "while True:\n"
        "    c = sys.stdin.read(1)\n"
        "    print(\"key:\" + repr(c))\n"
        "    if c == \"q\":\n"
        "        break\n"
        "print(\"DONE\")\n"),
    # polls sys.stdin with select.poll() (the course demo pattern), idles in between, reads two keys
    "poll_keys": (
        "import sys, select\n"
        "p = select.poll()\n"
        "p.register(sys.stdin, select.POLLIN)\n"
        "print(\"READY\")\n"
        "ticks = 0\n"
        "got = []\n"
        "while len(got) < 2:\n"
        "    if p.poll(10):\n"
        "        got.append(sys.stdin.read(1))\n"
        "    else:\n"
        "        ticks += 1\n"
        "print(\"got\", got, \"idle\", ticks > 0)\n"),
    # like the course's test.py: poll for a key while doing periodic work, 'q' quits
    "course_demo": (
        "import sys, select, time\n"
        "p = select.poll()\n"
        "p.register(sys.stdin, select.POLLIN)\n"
        "print(\"press keys, q to quit\")\n"
        "n = 0\n"
        "while True:\n"
        "    if p.poll(0):\n"
        "        c = sys.stdin.read(1)\n"
        "        print(\"pressed\", c)\n"
        "        if c == \"q\":\n"
        "            break\n"
        "    n += 1\n"
        "    time.sleep(0.01)\n"
        "print(\"bye\")\n"),
    "spin": "print(\"go\")\nwhile True:\n    pass\n",
    "sleep_loop": "import time\nprint(\"go\")\nwhile True:\n    time.sleep(0.01)\n",
    # catches every KeyboardInterrupt and keeps going (the bridge's Stop must escalate)
    "swallow_ctrl_c": (
        "import time\n"
        "print(\"loop\")\n"
        "while True:\n"
        "    try:\n"
        "        time.sleep(0.01)\n"
        "    except KeyboardInterrupt:\n"
        "        print(\"ignored ^C\")\n"),
    "heartbeat": _HEARTBEAT_MAIN,
    "raises": "print(\"before\")\n1/0\n",
    "ask_name": "name = input(\"name? \")\nprint(\"hi \" + name)\n",
}


class FakeLineDriver:
    """Stands in for DTR/RTS on a fake board's socket:// URL (see FakeBoard.line_driver)."""

    def __init__(self, board):
        self.board = board
        usb = board.profile.get("usb") or {}
        self.usb_ids = (usb["vid"], usb["pid"]) if usb.get("vid") is not None else None
        self.pulses = []

    def pulse(self, method, ser=None):
        self.pulses.append(method)
        self.board.pulse(method)


class FakeBoard:
    """A fake MicroPython board listening on 127.0.0.1.

    profile      name or dict (see PROFILES / register_profile / derive_profile)
    root         host directory acting as the device filesystem; None = private temp dir
    exclusive    True: one client at a time; a second connect is refused (the listener is closed
                 while a client is attached: ECONNREFUSED, like an exclusively locked port);
                 busy="drop" keeps listening and accepts-then-drops extra clients instead.
                 False: several clients share the board (output is broadcast).
    faults       iterable of fault specs ("slow", "close_mid_transfer:300", ("delay_boot", 3.0), ...)
    baud         throttle both directions to this UART speed (None/0 = unlimited)
    seed         write the profile's root files into root.  None = only for a temp root
                 (for a user-supplied root only missing files are created when seed=True)
    power_on     "start": the interpreter boots in start(); output is lost until a client attaches.
                 "connect": boots when the first client attaches, so the client sees boot output,
                 delay_boot and main_forever from the start.  None (default): "connect" when delay_boot
                 or main_forever is among the faults, else "start".
    files        {device_path: str|bytes} written after seeding
    capture      True: keep every byte the board received/sent in `transcript` (see rx_data()/tx_data())
                 and put the full source in `exec` events (field "code")
    """

    def __init__(self, profile="esp32", root=None, exclusive=True, faults=(), baud=None, *,
                 seed=None, power_on=None, busy="refuse", log_path=None, unique_id=None,
                 host="127.0.0.1", port=0, files=None, capture=False):
        self.profile = get_profile(profile)
        if unique_id is not None:
            self.profile["unique_id"] = bytes(unique_id)
        self.faults = Faults(faults)
        self.exclusive = bool(exclusive)
        self.busy = busy
        self.baud = baud or (self.faults.arg("slow", 115200) if self.faults.has("slow") else 0)
        self.events = EventLog()
        self._host = host
        self._req_port = port
        self._seed = seed
        self._files = files or {}
        self._root_arg = root
        self._own_root = False
        self.root_str = None
        self.port = None
        self.rx_bytes = 0
        self.tx_bytes = 0
        self.capture = bool(capture)
        self.transcript = []             # capture=True: [("rx"|"tx", time.monotonic(), bytes)]
        if power_on is None:
            power_on = "connect" if (self.faults.has("delay_boot") or self.faults.has("main_forever")) else "start"
        self.power_on = power_on
        self._log_path = log_path
        self._logf = None
        self._srv = None
        self._lock = threading.RLock()
        self._wlock = threading.Lock()
        self._clients = []
        self._cid = 0
        self._stop_evt = threading.Event()
        self._relisten_evt = threading.Event()
        self._accept_thread = None
        self._threads = []
        self._timers = []
        self._powered = False
        self._started = False
        self._stopped = False
        self.device = None

    # ------------------------------------------------------------------ lifecycle
    @property
    def root(self):
        return self.root_str

    @property
    def url(self) -> str:
        if self.port is None:
            raise RuntimeError("FakeBoard not started")
        return "socket://%s:%d" % (self._host, self.port)

    def start(self):
        if self._started:
            return self
        self._started = True
        if self._root_arg is None:
            self.root_str = tempfile.mkdtemp(prefix="fakeboard-")
            self._own_root = True
            seed = True if self._seed is None else self._seed
        else:
            self.root_str = os.fspath(self._root_arg)
            os.makedirs(self.root_str, exist_ok=True)
            seed = bool(self._seed)
        if self._log_path:
            self._logf = open(self._log_path, "a", buffering=1, encoding="utf-8")
            self.events._sink = self._logf
        if seed:
            for name, content in self.profile["root_files"].items():
                self._seed_file(name, content, only_missing=not self._own_root)
        if self.faults.has("main_forever"):
            self._seed_file("main.py", _HEARTBEAT_MAIN, only_missing=False)
        self.device = Device(self)
        for path, content in self._files.items():
            self.write_file(path, content)
        self._listen(self._req_port)
        self.port = self._srv.getsockname()[1]
        self._accept_thread = threading.Thread(target=self._accept_loop,
                                               name="fakeboard-accept-%d" % self.port, daemon=True)
        self._accept_thread.start()
        if self.power_on == "start":
            self._powered = True
            self.device.power_up("start")
            if not (self.faults.has("delay_boot") or self.faults.has("main_forever")):
                self.wait_idle(2.0)          # boot.py / main.py of a normal board finish quickly
        return self

    def _seed_file(self, name, content, only_missing):
        h = os.path.join(self.root_str, *name.split("/"))
        if only_missing and os.path.exists(h):
            return
        self._write_host(h, content)

    @staticmethod
    def _write_host(h, content):
        os.makedirs(os.path.dirname(h), exist_ok=True)
        if isinstance(content, str):
            content = content.encode("utf-8")
        with open(h, "wb") as f:
            f.write(content)

    def _listen(self, port):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if os.name != "nt":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((self._host, port))
        s.listen(5)
        s.settimeout(0.1)
        self._srv = s

    def stop(self):
        """Deterministic shutdown: close the listener and clients, kill the interpreter, join threads."""
        if self._stopped:
            return
        self._stopped = True
        self._stop_evt.set()
        self._relisten_evt.set()
        for t in list(self._timers):
            t.cancel()
        with self._lock:
            srv, self._srv = self._srv, None
            clients = list(self._clients)
        if srv is not None:
            self._wake_acceptor(srv)
            try:
                srv.close()
            except OSError:
                pass
        for c in clients:
            self._hangup(c)
        if self.device is not None:
            self.device.kill()
        for t in [self._accept_thread] + list(self._threads) + list(self._timers):
            if t is not None and t is not threading.current_thread():
                t.join(3.0)
        if self._logf is not None:
            try:
                self._logf.close()
            except OSError:
                pass
        if self._own_root and self.root_str:
            shutil.rmtree(self.root_str, ignore_errors=True)

    @staticmethod
    def _wake_acceptor(srv):
        """accept() runs with a 0.1 s timeout and a close() from another thread does not wake it on every OS, so
        stop() used to cost 0.1 s per board (about a minute over the whole test suite). Knock once so it returns
        at once; _accept_loop drops that connection because the stop flag is already set."""
        try:
            host, port = srv.getsockname()[:2]
            if host in ("", "0.0.0.0"):
                host = "127.0.0.1"
            socket.create_connection((host, port), timeout=0.5).close()
        except OSError:
            pass

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()
        return False

    def leaked_threads(self) -> list:
        """Threads of this board that are still alive (call after stop())."""
        mine = [self._accept_thread] + list(self._threads) + list(self._timers)
        if self.device is not None:
            mine.append(self.device.worker)
        return [t for t in mine if t is not None and t.is_alive()]

    # ------------------------------------------------------------------ accept / clients
    def _accept_loop(self):
        while not self._stop_evt.is_set():
            srv = self._srv
            if srv is None:
                self._relisten_evt.wait(0.01)
                self._relisten_evt.clear()
                if not self.connected:
                    self._try_relisten()
                continue
            try:
                conn, peer = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                if self._stop_evt.is_set():
                    return
                time.sleep(0.01)
                continue
            if self._stop_evt.is_set():             # stop() knocked to wake us (see _wake_acceptor)
                try:
                    conn.close()
                except OSError:
                    pass
                return
            conn.settimeout(None)
            try:
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            self._attach(conn, peer)

    def _try_relisten(self):
        with self._lock:
            if self._srv is not None or self._clients:
                return
            for _ in range(100):
                if self._stop_evt.is_set():
                    return
                try:
                    self._listen(self.port)
                    return
                except OSError:
                    time.sleep(0.02)

    def _attach(self, conn, peer):
        c = None
        with self._lock:
            if not (self.exclusive and self._clients):
                self._cid += 1
                c = _Client(conn, self._cid, peer)
                self._clients.append(c)
                if self.exclusive and self.busy == "refuse":
                    srv, self._srv = self._srv, None
                    if srv is not None:
                        try:
                            srv.close()
                        except OSError:
                            pass
        if c is None:
            self.events.add("busy_reject", peer=peer[1])
            try:
                conn.close()
            except OSError:
                pass
            return
        self.events.add("connect", client=c.id, peer=peer[1])
        self.device.on_attach()
        # line noise, first boot and the injected reset happen BEFORE the client's bytes are read,
        # so their output cannot race ahead of / behind the client's first request
        if self.faults.has("garbage_before_banner"):
            self._tx(self.device.garbage)
        if self.power_on == "connect" and not self._powered:
            self._powered = True
            self.device.power_up("connect")
        if self.faults.has("reset_on_connect"):
            self.device.request_reset("soft", "reset_on_connect")
        t = threading.Thread(target=self._client_loop, args=(c,), name="fakeboard-client-%d" % c.id, daemon=True)
        c.thread = t
        self._threads = [x for x in self._threads if x.is_alive()] + [t]
        t.start()
        self._arm_unplug_triggers()

    def _client_loop(self, c):
        reason = "client"
        try:
            while not self._stop_evt.is_set() and not c.dead:
                try:
                    data = c.sock.recv(4096)
                except OSError:
                    reason = "error"
                    break
                if not data:
                    break
                if self.baud:
                    time.sleep(len(data) * 10.0 / self.baud)
                c.rx += len(data)
                if self.capture:
                    self.transcript.append(("rx", time.monotonic(), data))
                self._on_rx(c)
                if not self.faults.has("silent"):
                    self.device.feed(data)
        finally:
            self._detach(c, c.reason or reason)

    def _detach(self, c, reason):
        try:
            c.sock.close()
        except OSError:
            pass
        with self._lock:                    # one atomic step for observers: gone, logged, listening again
            if c not in self._clients:
                return
            self._clients.remove(c)
            self.events.add("disconnect", client=c.id, reason=reason)
            if not self._clients and self.exclusive and self.busy == "refuse" and not self._stop_evt.is_set():
                self._try_relisten()        # the "lock" is released as soon as the client is gone

    def _hangup(self, c, abrupt=False, reason=None):
        c.dead = True
        if reason and not c.reason:
            c.reason = reason
        try:
            if abrupt:
                c.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                                  struct.pack("hh" if os.name == "nt" else "ii", 1, 0))   # close() sends RST
            else:
                c.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            c.sock.close()
        except OSError:
            pass

    def _schedule_hangup(self, reason, abrupt=True):
        """Drop every client (callable from any thread, including the one inside feed())."""
        with self._lock:
            clients = list(self._clients)
        for c in clients:
            self._hangup(c, abrupt=abrupt, reason=reason)

    @property
    def connected(self) -> int:
        with self._lock:
            return len(self._clients)

    def wait_for_clients(self, n=0, timeout=5.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.connected == n:
                return True
            time.sleep(0.005)
        return self.connected == n

    # ------------------------------------------------------------------ output path
    def _tx(self, data: bytes):
        if not data or self.faults.has("silent"):
            return
        with self._wlock:
            with self._lock:
                clients = list(self._clients)
            self.tx_bytes += len(data)
            if self.capture:
                # recorded BEFORE the bytes leave: a client that already holds them must find them in tx_data()
                self.transcript.append(("tx", time.monotonic(), data))
            for c in clients:
                try:
                    c.sock.sendall(data)
                except OSError:
                    c.dead = True
                    try:
                        c.sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
            if self.baud and clients:
                time.sleep(len(data) * 10.0 / self.baud)

    # ------------------------------------------------------------------ faults that act on I/O
    def _on_rx(self, c):
        f = self.faults
        if f.has("unplug"):
            spec = str(f.arg("unplug", "exec"))
            if spec.startswith("bytes=") and c.rx >= int(spec.split("=", 1)[1]) and f.once("unplug"):
                self._do_unplug("bytes")

    def _exec_hook(self):
        f = self.faults
        if f.has("unplug") and str(f.arg("unplug", "exec")) == "exec" and f.once("unplug"):
            self._do_unplug("exec")

    def _arm_unplug_triggers(self):
        f = self.faults
        if not f.has("unplug"):
            return
        spec = str(f.arg("unplug", "exec"))
        if spec == "connect":
            if f.once("unplug"):
                self._do_unplug("connect")
        elif spec.startswith("after=") and not f.fired("unplug"):
            def fire():
                if f.once("unplug"):
                    self._do_unplug("after")

            t = threading.Timer(float(spec.split("=", 1)[1]), fire)
            t.daemon = True
            t.name = "fakeboard-timer"
            self._timers.append(t)
            t.start()

    def _do_unplug(self, trigger):
        self.events.add("fault", name="unplug", trigger=trigger)
        self._schedule_hangup("unplug", abrupt=True)

    # ------------------------------------------------------------------ test API
    def unplug(self, reason="test"):
        """Abruptly close every client connection (cable pulled).  The board keeps running."""
        self._do_unplug(reason)

    def hard_reset(self, reason="test"):
        """Full reset (RTS/EN pulse or machine.reset()): ticks restart, banner appears, main.py runs.
        Native-USB profiles also drop the client (the port re-enumerates)."""
        self.device.request_reset("hard", reason)

    def soft_reset(self, reason="test"):
        self.device.request_reset("soft", reason)

    WIRING_FOR_METHOD = {"rts-pulse": "auto-reset", "usb-jtag": "usb-jtag"}

    def pulse(self, method="rts-pulse"):
        """A control-line pulse (DTR/RTS sequence) reaches the board.  Resets it ONLY when the profile's `reset_wiring`
        matches the method (a board without the auto-reset transistors ignores the lines).  Returns True if it reset.
        Always logs `pulse(method, wiring, effect)`; a reset adds one `hard_reset` (via="pulse")."""
        wiring = self.profile.get("reset_wiring", "none")
        effect = self.WIRING_FOR_METHOD.get(method) == wiring
        self.events.add("pulse", method=method, wiring=wiring, effect=effect)
        if effect:
            self.device.request_reset("hard", method)
        return effect

    def line_driver(self):
        """A driver for bridge.link.register_line_driver(board.url, driver): the Link calls driver.pulse(method, ser)
        instead of toggling DTR/RTS (a socket:// URL has no modem lines).  No wire traffic: the pulse is delivered
        in-process, which is the out-of-band control message of the addendum."""
        return FakeLineDriver(self)

    def host_path(self, devpath: str) -> str:
        """Host path of a device path ('/main.py'; with a /flash mount use '/flash/main.py')."""
        h, virt = _FakeOS(self.device)._host(devpath)
        if virt:
            raise ValueError("%r is the synthetic root" % devpath)
        return h

    def write_file(self, devpath: str, content) -> str:
        h = self.host_path(devpath)
        self._write_host(h, content)
        return h

    def read_file(self, devpath: str) -> bytes:
        with open(self.host_path(devpath), "rb") as f:
            return f.read()

    def exists(self, devpath: str) -> bool:
        return os.path.exists(self.host_path(devpath))

    @property
    def mode(self) -> str:
        return self.device.mode

    @property
    def program_running(self) -> bool:
        return bool(self.device.running)

    def wait_idle(self, timeout=5.0) -> bool:
        """Wait until no program, boot or REPL line is executing."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.device.running:
                return True
            time.sleep(0.005)
        return not self.device.running

    def wait_running(self, timeout=5.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.device.running:
                return True
            time.sleep(0.005)
        return bool(self.device.running)

    def rx_data(self) -> bytes:
        """Everything the board received (capture=True)."""
        return b"".join(d for k, _t, d in list(self.transcript) if k == "rx")

    def tx_data(self) -> bytes:
        """Everything the board sent while a client was attached (capture=True)."""
        return b"".join(d for k, _t, d in list(self.transcript) if k == "tx")

    def rearm(self, name=None):
        """Re-arm one-shot faults (close_mid_transfer, unplug)."""
        self.faults.rearm(name)

    def add_fault(self, spec):
        """Switch a fault on while the board is running ("ignore_ctrl_c", "silent", "readonly_fs", ...).
        no_hashlib / no_compile / garbage_before_banner take effect at the next soft reset."""
        self.faults.add(spec)
        if self.faults.has("slow"):
            self.baud = self.faults.arg("slow", 115200)
        if self.device is not None and self.faults.has("garbage_before_banner"):
            self.device.garbage = self.faults.arg("garbage_before_banner", _DEFAULT_GARBAGE)

    def remove_fault(self, name):
        self.faults.remove(name)
        if name == "slow":
            self.baud = 0
        if name == "garbage_before_banner" and self.device is not None:
            self.device.garbage = b""

    def serve_forever(self, max_seconds=0, stdin_eof=False):
        stop = threading.Event()
        if stdin_eof:
            def watch():
                try:
                    while sys.stdin.read(4096):
                        pass
                except Exception:
                    pass
                stop.set()

            threading.Thread(target=watch, name="fakeboard-stdin-watch", daemon=True).start()
        t0 = time.monotonic()
        try:
            while not stop.is_set():
                if max_seconds and time.monotonic() - t0 >= max_seconds:
                    break
                stop.wait(0.2)
        except KeyboardInterrupt:
            pass


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description="Fake MicroPython board over TCP (never touches a serial port)")
    ap.add_argument("--profile", default="esp32", help="one of: " + ", ".join(list_profiles()))
    ap.add_argument("--list-profiles", action="store_true")
    ap.add_argument("--root", help="host directory used as the device filesystem (default: temp dir)")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--print-url", action="store_true", help="print only the socket:// URL (one line)")
    ap.add_argument("--exclusive", dest="exclusive", action="store_true", default=True)
    ap.add_argument("--no-exclusive", dest="exclusive", action="store_false")
    ap.add_argument("--busy", choices=("refuse", "drop"), default="refuse")
    ap.add_argument("--fault", action="append", default=[], metavar="NAME[:ARG]")
    ap.add_argument("--baud", type=int, default=0, help="throttle both directions to this UART speed (0 = unlimited)")
    ap.add_argument("--log", help="append events as JSON lines to this file")
    ap.add_argument("--power-on", choices=("start", "connect"), default=None)
    ap.add_argument("--run-main-on-connect", action="store_true", help="alias of --power-on connect")
    ap.add_argument("--seed", action="store_true", help="also write the profile's files into --root")
    ap.add_argument("--max-seconds", type=float, default=0, help="exit after this long (0 = until interrupted)")
    ap.add_argument("--exit-on-stdin-eof", action="store_true", help="exit when stdin closes (parent died)")
    args = ap.parse_args(argv)
    if args.list_profiles:
        for n in list_profiles():
            print("%-14s %s" % (n, PROFILES[n]["description"]))
        return 0
    power_on = "connect" if args.run_main_on_connect else args.power_on
    board = FakeBoard(args.profile, root=args.root, exclusive=args.exclusive, faults=args.fault,
                      baud=args.baud or None, seed=True if args.seed else None, power_on=power_on,
                      busy=args.busy, log_path=args.log, host=args.host, port=args.port)
    board.start()
    try:
        print(board.url if args.print_url else "LISTENING " + board.url, flush=True)
        board.serve_forever(args.max_seconds, args.exit_on_stdin_eof)
    finally:
        board.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
