#!/usr/bin/env python3
"""mpy_hwkit.py -- non-destructive, human-run hardware verification kit for the
WSU_SHIELD MicroPython board (ESP32-WROOM-32 + CP2102 + WSU Motor Shield).

It settles the open [U] claims in docs/analysis/08-mpremote-research.md
("Follow-up: Firmware-derived safety and protocol requirements; hardware kit"):
  B  does opening / closing the port reset the chip (DTR/RTS), per open policy
  A  board identity, _shield ABI, exception policy
  C  Ctrl-C / Stop semantics, raw-paste window, hook counters
  D  soft-reset semantics (raw vs friendly), counters, reset_cause
  K  REPL control keys (Ctrl-A/B/D/E, paste mode, CR/LF)
  E  (opt-in) hardware reset by RTS pulse and recovery from an unstoppable loop
  U  (opt-in) unplug behaviour
  M  (automatic when a sentinel main.py is on the board) main.py semantics

What it NEVER does: write or delete a file on the board, call machine.reset(),
machine.bootloader(), touch a GPIO, call any _shield motor/servo function except the
read-only getters, run esptool, or flash anything. Every snippet sent to the board is
passed through audit() first; `--show-snippets` prints them all. The only reset it can
cause is the chip reset it is MEASURING (stage B) and the explicit RTS pulse of stage E.

MOTOR POWER (VBATT / the battery pack / the wall adapter) MUST BE OFF. USB only.
GPIO15 spins motor 2 for ~0.3 s at every chip reset when motor power is on.

Usage:
  python mpy_hwkit.py                      # lists ports, prints the checklist, opens nothing
  python mpy_hwkit.py --list-checks        # Markdown table of every check + expected value
  python mpy_hwkit.py --show-snippets      # every line of code sent to the board
  python mpy_hwkit.py --port COM5 --stages A,B,C,D,K        (Windows)
  python mpy_hwkit.py --port /dev/cu.usbserial-0001 --stages A,B,C,D,K   (macOS)
  ... add  --stages E --allow-hardware-reset   for the RTS-pulse stage
Needs: Python >= 3.8, pyserial >= 3.3 (pip install pyserial). Nothing else.
"""
import argparse
import ast
import importlib
import json
import os
import platform
import re
import sys
import time

KIT_VERSION = "1.0+mpy-upgrade.1"   # 1.0 as audited 2026-10-12; +1 adds --motors-on-acknowledged (see gate())
SENTINEL = "MPY-HWKIT-SENTINEL"
TICKS_PERIOD = 1 << 30

# --------------------------------------------------------------------------------------
# Check registry: the single source of truth for the expected-output table.
# --------------------------------------------------------------------------------------
CHECKS = {}
ORDER = []


def check(cid, stage, claim, expect, source):
    CHECKS[cid] = dict(id=cid, stage=stage, claim=claim, expect=expect, source=source)
    ORDER.append(cid)


check("A1", "A", "Board is the class firmware", "sys.implementation._build == 'WSU_SHIELD'; _machine starts 'WSU Motor Shield with ESP32'; version >= 1.29.0",
      "Makefile BOARD ?= notdir(BOARD_DIR); py/mkrules.cmake; mpconfigboard.h:4-5")
check("A2", "A", "Private C module present, ABI matches the package", "_shield.ABI == 1 (the `shield` package refuses any other value)",
      "mod_shield.c:42,574; python/shield/__init__.py:15-18")
check("A3", "A", "Exception policy default", "_shield.exception_policy() == 2 ('all')", "mod_shield.c:56-67")
check("A4", "A", "Hardware parked until a student starts it", "_shield.motors_ready() is False on a fresh boot", "control.c:731 (stop_all is a no-op before start)")
check("A5", "A", "Root filesystem listing (read-only)", "INFO: list files; flags main.py / boot.py", "ports/esp32/main.c:155,165")
check("B-first", "B", "The very first open after plugging in does not reset the chip (Windows CP210x quirk: only the first open after power-on)", "no ROM text in the first listen window and ticks_ms >= 10000 at the first probe (plug in, wait 20 s, then run)",
      "mpremote transport_serial.py:70-85 comment; PR #18001 [D]")
check("B-open", "B", "Opening the port does not reset the chip (per policy)", "no reset estimated within 0.6 s of the open, no ROM text after open",
      "08 sec 7.3 [U]; esptool: asserting DTR and RTS together does not reset")
check("B-close", "B", "Closing the port does not reset the chip (per policy)", "no reset estimated within 0.6 s of the close",
      "08 sec 7.3 [U]; mpremote 1.29 transport_serial.py:122-133 (RTS then DTR)")
check("B-hold", "B", "No reset while the port stays open", "ticks_ms continuous between probes in one session", "baseline")
check("C1", "C", "Raw REPL entry with one Ctrl-C", "'raw REPL; CTRL-B to exit\\r\\n>' within 3 s", "pyexec.c:552-563; transport_serial.py:177-212")
check("C2", "C", "Raw-paste window", "reply R\\x01 + window 128 (LE 0x0080) + \\x01; ack \\x04; output; \\x04\\x04",
      "pyexec.c:294-308,238-240 (STDIN_BUFFER_MAX 256/2); esp32 does not override")
check("C3", "C", "Ctrl-C at an idle raw REPL does nothing", "no output, hook_counts unchanged", "pyexec.c:586-588 (clear line)")
check("C4", "C", "One Ctrl-C stops a running program and fires the exit hook",
      "Traceback ... KeyboardInterrupt, '>' returns; hook_counts delta (0,+1,+1) when policy == 2", "pyexec.c:128,146-149,226-228; mod_shield.c:536-552; uart.c:115")
check("C5", "C", "Time from Ctrl-C to prompt", "INFO: well under 1 s for a sleeping loop", "measure")
check("C6", "C", "A second Ctrl-C 100 ms later aborts the program's cleanup (finally)", "'cleanup done' ABSENT after Ctrl-C,Ctrl-C; PRESENT after one Ctrl-C",
      "[E] unix port; scheduler.c:49-52 (each 0x03 re-arms the pending exception)")
check("C7", "C", "A program that swallows KeyboardInterrupt cannot be stopped", "no prompt until the loop ends by itself; no exit-hook increments",
      "pyexec.c:128-139 (interrupt armed only during exec); hook only on uncaught exception")
check("C8", "C", "micropython.kbd_intr(-1) disables Stop; re-armed for the next exec", "loop ends by itself; next exec is interruptible again", "pyexec.c:128; modmicropython.c:152-155; uart.c:115")
check("C9", "C", "_thread workers survive Ctrl-C and die at soft reset", "'T' keeps printing after the prompt; stops at once after raw soft reset",
      "scheduler.c:35 (main thread only); mpthreadport.c:211-228")
check("C10", "C", "Ctrl-C during a raw-paste upload aborts it and fires the hook", "\\x04 \\x04 'KeyboardInterrupt' \\x04 '>'; hook delta (0,+1,+1)", "pyexec.c:248-278,146-160")
check("D1", "D", "Raw-REPL soft reset", "'OK\\r\\n', then 'MPY: soft reboot', then raw banner; hook soft_resets +1; reset_cause == 5 (SOFT_RESET); ticks_ms continuous",
      "pyexec.c:389-397; main.c:185-241; modmachine.c:233-235,300-305")
check("D2", "D", "Friendly-REPL Ctrl-D soft reset", "'MPY: soft reboot', MicroPython banner + '>>> '; soft_resets +1 (SKIPPED if /main.py exists, because it would run)",
      "pyexec.c:462-466; main.c:161-169")
check("D3", "D", "boot.py raising skips main.py; mode must be friendly", "INFO (documented from source; not testable without writing files)", "main.c:161-169; pyexec.h:40-48 (ret==0 on exception)")
check("K1", "K", "Ctrl-E on an empty line enters paste mode; Ctrl-D runs; Ctrl-C cancels", "'paste mode; Ctrl-C to cancel, Ctrl-D to finish' + '=== '", "pyexec.c:467-472,686-706")
check("K2", "K", "Ctrl-A on a NON-empty line is 'home', not raw REPL", "no 'raw REPL' text", "readline.c:159-165")
check("K3", "K", "A lone LF is Enter; CR LF is ONE Enter (v1.29.0)", "print(1)\\n runs once; print(2)\\r\\n runs once", "readline.c:141-151 process_nl (new in v1.29; absent in v1.27)")
check("K4", "K", "Ctrl-D on a NON-empty line deletes a character, it does not soft-reset", "no 'MPY: soft reboot'", "readline.c:174-177 (EMACS keys on: mpconfig.h:861-864)")
check("M1", "M", "main.py is NOT run by a raw-REPL soft reset", "sentinel text absent", "main.c:164-169; pyexec.c:665 (mode stays RAW)")
check("M2", "M", "main.py IS run by a friendly-REPL Ctrl-D", "sentinel text present", "main.c:164-169")
check("M3", "M", "A hardware reset DOES run main.py", "sentinel text present after the RTS pulse (stage E with a sentinel main.py)", "main.c:154-169 (mode is friendly after a chip reset)")
check("E1", "E", "RTS pulse (DTR low) is a clean hard reset", "boot, reset_cause == 1 (PWRON_RESET), ticks_ms small, hook_counts back to (0,0,0), no 'waiting for download'",
      "esptool HardReset; modmachine.c:238-241")
check("E2", "E", "RTS pulse recovers a loop that ignores Ctrl-C", "board restarts within 1 s; loop never prints its end marker", "[U]")
check("E3", "E", "Time from RTS release to first byte / to prompt", "INFO", "measure")
check("U1", "U", "Unplug while streaming", "INFO: exception class + message + time", "08 sec 8 row 10 [U]")

# --------------------------------------------------------------------------------------
# Snippets sent to the board + audit
# --------------------------------------------------------------------------------------
PROBE = """\
import time
r = [time.ticks_ms()]
try:
    import machine
    r.append(machine.reset_cause())
except Exception:
    r.append(None)
try:
    import _shield
    r.append(_shield.hook_counts())
except Exception:
    r.append(None)
print('@@' + repr(tuple(r)))
"""

IDENT = """\
import sys, gc
i = sys.implementation
d = {'impl': i.name, 'ver': tuple(i.version)[:3], 'machine': getattr(i, '_machine', None),
     'build': getattr(i, '_build', None)}
try:
    import _shield
    d['abi'] = _shield.ABI
    d['shield_ver'] = _shield.__version__
    d['policy'] = _shield.exception_policy()
    d['ready'] = _shield.motors_ready()
except ImportError:
    d['abi'] = None
except Exception as e:
    d['abi'] = 'err:' + repr(e)
try:
    import os
    d['root'] = sorted(os.listdir('/'))
except Exception as e:
    d['root'] = None
gc.collect()
d['free'] = gc.mem_free()
import time as _t
d['uptime_ms'] = _t.ticks_ms()
print('@@' + repr(d))
"""

MAIN_HEAD = "print('@@' + repr(open('/main.py').read(120)))\n"

RUN_LOOP = "import time\nprint('start')\nwhile True:\n    time.sleep_ms(20)\n"

RUN_FINALLY = """\
import time
try:
    print('running')
    while True:
        time.sleep_ms(10)
finally:
    print('cleanup start')
    time.sleep_ms(400)
    print('cleanup done')
"""

RUN_SWALLOW = """\
import time
n = 0
t0 = time.ticks_ms()
print('start')
while time.ticks_diff(time.ticks_ms(), t0) < 5000:
    try:
        time.sleep_ms(20)
    except KeyboardInterrupt:
        n += 1
print('swallowed', n)
"""

RUN_KBDOFF = """\
import time, micropython
micropython.kbd_intr(-1)
t0 = time.ticks_ms()
print('start')
while time.ticks_diff(time.ticks_ms(), t0) < 3000:
    time.sleep_ms(20)
print('kbd_intr loop ended by itself')
"""

RUN_THREAD = """\
import _thread, time
def w():
    t0 = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), t0) < 3500:
        print('T', end='')
        time.sleep_ms(100)
_thread.start_new_thread(w, ())
print('start')
while True:
    time.sleep_ms(20)
"""

RUN_UNSTOPPABLE = """\
import time, micropython
micropython.kbd_intr(-1)
t0 = time.ticks_ms()
print('start')
while time.ticks_diff(time.ticks_ms(), t0) < 12000:
    time.sleep_ms(20)
print('UNSTOPPABLE-LOOP-ENDED-BY-ITSELF')
"""

RUN_STREAM = "import time\ni = 0\nwhile i < 600:\n    print('S', i)\n    i += 1\n    time.sleep_ms(100)\n"

SNIPPETS = dict(PROBE=PROBE, IDENT=IDENT, MAIN_HEAD=MAIN_HEAD, RUN_LOOP=RUN_LOOP, RUN_FINALLY=RUN_FINALLY,
                RUN_SWALLOW=RUN_SWALLOW, RUN_KBDOFF=RUN_KBDOFF, RUN_THREAD=RUN_THREAD,
                RUN_UNSTOPPABLE=RUN_UNSTOPPABLE, RUN_STREAM=RUN_STREAM)

FORBIDDEN = [
    r"machine\.reset(?!_cause)", r"machine\.soft_reset", r"bootloader", r"\.Pin\b", r"\bPin\(", r"\besp\.", r"esp32\.", r"os\.(remove|rename|mkdir|rmdir|mount|umount|chdir|sync)",
    r"motors_begin", r"motor_(duty|setpoint|gains|enable|brake|coast|limit|direction|set_position|sync)", r"servo_(attach|write|off|detach|freq)", r"stop_all",
    r"session_reset", r"_after_exec", r"exception_policy\((?!\))", r"\bPWM\b", r"\bADC\b", r"flashbdev", r"\bnvs\b", r"network\.", r"\bmip\b",
    r"open\((?!'/main\.py'\))",
]


def audit(code):
    """Refuse to send anything that could write, reset, or drive hardware."""
    for pat in FORBIDDEN:
        m = re.search(pat, code)
        if m:
            raise RuntimeError("audit: refusing to send code matching /%s/: %r" % (pat, m.group(0)))
    return code


# --------------------------------------------------------------------------------------
# Results
# --------------------------------------------------------------------------------------
RESULTS = []
NOTES = []


def record(cid, ok, observed, note=""):
    """ok: True PASS, False FAIL, None INFO, 'skip' SKIP."""
    verdict = "PASS" if ok is True else "FAIL" if ok is False else "SKIP" if ok == "skip" else "INFO"
    RESULTS.append(dict(id=cid, verdict=verdict, observed=str(observed), note=note))
    print("  [%s] %-8s %s%s" % (verdict, cid, str(observed)[:200], (" -- " + note) if note else ""))
    sys.stdout.flush()


def say(msg=""):
    print(msg)
    sys.stdout.flush()


# --------------------------------------------------------------------------------------
# Link: byte-level protocol helper (the same moves the extension's engine will make)
# --------------------------------------------------------------------------------------
class Link(object):
    def __init__(self, ser):
        self.ser = ser
        self.trace = []
        self.t0 = time.monotonic()

    def _log(self, d, b):
        if len(self.trace) < 4000:
            self.trace.append((round(time.monotonic() - self.t0, 3), d, bytes(b)[:200].decode("latin-1")))

    def write(self, b):
        self._log(">", b)
        self.ser.write(b)
        try:
            self.ser.flush()
        except Exception:
            pass

    def avail(self):
        n = self.ser.in_waiting      # may raise OSError/SerialException on unplug: stage U wants to see it
        if n:
            d = self.ser.read(n)
            self._log("<", d)
            return d
        return b""

    def read_for(self, secs):
        end = time.monotonic() + secs
        buf = b""
        first = None
        while time.monotonic() < end:
            d = self.avail()
            if d:
                if first is None:
                    first = time.monotonic()
                buf += d
            else:
                time.sleep(0.004)
        return buf, first

    def read_until(self, marker, timeout, buf=b""):
        end = time.monotonic() + timeout
        while marker not in buf and time.monotonic() < end:
            d = self.avail()
            if d:
                buf += d
            else:
                time.sleep(0.004)
        return buf, (marker in buf)

    def drain(self, quiet=0.15, maxs=2.0):
        end = time.monotonic() + maxs
        last = time.monotonic()
        buf = b""
        while time.monotonic() < end and time.monotonic() - last < quiet:
            d = self.avail()
            if d:
                buf += d
                last = time.monotonic()
            else:
                time.sleep(0.004)
        return buf

    # ---- raw REPL ----
    def enter_raw(self, soft=False, timeout=3.0):
        for attempt in (1, 2):
            self.write(b"\r\x03")
            time.sleep(0.1)
            self.drain()
            self.write(b"\r\x01")
            t = time.monotonic()
            buf, ok = self.read_until(b"raw REPL; CTRL-B to exit\r\n>", timeout)
            if ok:
                if soft:
                    return self.soft_reset_raw()
                return True, time.monotonic() - t, buf
            self.write(b"\x03")
            time.sleep(0.3)
        return False, None, buf

    def exit_raw(self):
        self.write(b"\r\x02")
        buf, ok = self.read_until(b">>> ", 2.0)
        return ok, buf

    def soft_reset_raw(self, timeout=10.0):
        t = time.monotonic()
        self.write(b"\x04")
        buf, ok = self.read_until(b"raw REPL; CTRL-B to exit\r\n>", timeout)
        return ok, time.monotonic() - t, buf

    def paste_open(self):
        """Send Ctrl-E 'A' Ctrl-A. Returns (window or 0/None, header bytes, credit in bytes)."""
        self.write(b"\x05A\x01")
        buf = b""
        end = time.monotonic() + 2.0
        while time.monotonic() < end:
            buf += self.avail()
            i = buf.find(b"R")
            if i >= 0 and len(buf) >= i + 2:
                if buf[i + 1:i + 2] != b"\x01":
                    return 0, buf, 0          # R\x00: raw paste not supported
                if len(buf) >= i + 5:
                    win = buf[i + 2] | (buf[i + 3] << 8)
                    credit = win * (2 if buf[i + 4:i + 5] == b"\x01" else 1)   # window + the trailing 0x01
                    return win, buf[i:i + 5], credit
            time.sleep(0.004)
        return None, buf, 0

    def paste_send(self, code, window, credit):
        data = code.encode() if isinstance(code, str) else code
        remain = credit
        pos = 0
        extra = b""
        while pos < len(data):
            d = self.avail()
            if d:
                remain += d.count(b"\x01") * window
                extra += d.replace(b"\x01", b"")
            if remain <= 0:
                time.sleep(0.003)
                continue
            n = min(remain, len(data) - pos)
            self.write(data[pos:pos + n])
            pos += n
            remain -= n
        self.write(b"\x04")
        return extra

    def run_paste(self, code, timeout=10.0, wait=True):
        """Raw-paste execute. wait=False returns right after the upload ack (program running)."""
        audit(code)
        win, hdr, credit = self.paste_open()
        if not win:
            return dict(ok=False, why="raw-paste unsupported or no reply: %r" % (hdr,), window=win)
        pre = self.paste_send(code, win, credit)
        buf, ok = self.read_until(b"\x04", 3.0, pre)
        if not ok:
            return dict(ok=False, why="no upload ack", window=win, raw=buf)
        rest = buf.split(b"\x04", 1)[1]
        res = dict(ok=True, window=win, hdr=hdr, started=time.monotonic())
        if not wait:
            res["pending"] = rest
            return res
        return self.finish(res, rest, timeout)

    def finish(self, res, rest, timeout):
        buf, ok = self.read_until(b"\x04", timeout, rest)
        if not ok:
            res.update(ok=False, why="program did not finish in %.1fs" % timeout, out=buf)
            return res
        out, tail = buf.split(b"\x04", 1)
        err, ok2 = self.read_until(b"\x04", timeout, tail)
        after = b""
        if ok2:
            err, after = err.split(b"\x04", 1)
        done = time.monotonic()
        after, _ = self.read_until(b">", 2.0, after)
        res.update(out=out, err=err, done=done, tail=after)
        return res

    def probe(self):
        r = self.run_paste(PROBE, 5.0)
        if not r.get("ok"):
            return None, r
        m = re.search(rb"@@(\(.*\))", r["out"])
        if not m:
            return None, r
        try:
            t = ast.literal_eval(m.group(1).decode())
        except Exception:
            return None, r
        return dict(wall=r["done"], ticks=t[0], cause=t[1], hk=t[2]), r


# --------------------------------------------------------------------------------------
# Opening policies (what the extension could do) -- the variants stage B compares
# --------------------------------------------------------------------------------------
VARIANTS = {
    "V1": dict(desc="pyserial default open (DTR then RTS asserted), plain close", pre=None, post=None, close="plain"),
    "V2": dict(desc="DTR=0,RTS=0 before open, left low, plain close", pre="low", post=None, close="plain"),
    "V3": dict(desc="mpremote-1.27 CP210x sequence: low, open, DTR=1 then RTS=1; close RTS=0 then DTR=0", pre="low", post="high", close="ordered"),
    "V4": dict(desc="pyserial default open, ordered close (RTS=0 then DTR=0, as mpremote)", pre=None, post=None, close="ordered"),
    "V5": dict(desc="DTR=0,RTS=0 before open, left low, ordered close", pre="low", post=None, close="ordered"),
    "V6": dict(desc="(POSIX) default open, then clear HUPCL so close leaves the lines alone", pre=None, post="hupcl", close="plain"),
    "V7": dict(desc="real `python -m mpremote connect PORT resume exec pass` (whatever mpremote does)", pre=None, post=None, close="mpremote"),
}


def load_serial_class(spec):
    if not spec:
        import serial
        return serial.Serial
    mod, _, name = spec.partition(":")
    sys.path.insert(0, os.getcwd())
    return getattr(importlib.import_module(mod), name)


def open_port(ctx, variant):
    v = VARIANTS[variant]
    s = ctx.serial_cls()
    s.port = ctx.port
    s.baudrate = 115200
    s.timeout = 0.05
    s.write_timeout = 2
    if v["pre"] == "low":
        try:
            s.dtr = False
            s.rts = False
        except Exception as e:
            ctx.notes.append("modem lines not settable before open: %r" % (e,))
    t_open = time.monotonic()
    s.open()
    t_opened = time.monotonic()
    try:
        if v["post"] == "high":
            s.dtr = True
            s.rts = True
        elif v["post"] == "hupcl":
            import termios
            a = termios.tcgetattr(s.fd)
            a[2] &= ~termios.HUPCL
            termios.tcsetattr(s.fd, termios.TCSANOW, a)
    except Exception as e:
        ctx.notes.append("post-open step %s failed: %r" % (v["post"], e))
    return s, t_open, t_opened


def close_port(ctx, ser, variant):
    v = VARIANTS[variant]
    t = time.monotonic()
    try:
        if v["close"] == "ordered":
            ser.rts = False
            ser.dtr = False
    except Exception as e:
        ctx.notes.append("ordered close: %r" % (e,))
    try:
        ser.close()
    except Exception as e:
        ctx.notes.append("close: %r" % (e,))
    return t


ROM_RE = re.compile(rb"ets [A-Z][a-z]{2} +\d+ \d{4}|rst:0x[0-9a-f]+|boot:0x[0-9a-f]+|configsip|load:0x[0-9a-f]+|waiting for download")


def est_reset_wall(probe):
    if probe is None or probe["ticks"] is None:
        return None
    return probe["wall"] - probe["ticks"] / 1000.0


# --------------------------------------------------------------------------------------
# Context
# --------------------------------------------------------------------------------------
class Ctx(object):
    pass


def new_link(ctx, variant=None):
    variant = variant or ctx.variant
    ser, t_open, t_opened = open_port(ctx, variant)
    ctx.open_ser = ser
    return Link(ser), ser, t_open


def end_session(ctx, link, ser, variant=None, exit_raw=True):
    variant = variant or ctx.variant
    try:
        if exit_raw:
            link.exit_raw()
    except Exception:
        pass
    return close_port(ctx, ser, variant)


# --------------------------------------------------------------------------------------
# Stage A: identity
# --------------------------------------------------------------------------------------
def stage_A(ctx):
    say("== Stage A: identity (read-only)")
    link, ser, _ = new_link(ctx)
    try:
        link.read_for(1.0)
        ok, dt, buf = link.enter_raw()
        if not ok:
            record("A1", False, "could not enter raw REPL: %r" % (buf[-120:],), "press EN once / replug and retry")
            return
        r = link.run_paste(IDENT, 6.0)
        if not r.get("ok"):
            record("A1", False, "ident failed: %r" % (r,))
            return
        m = re.search(rb"@@(\{.*\})", r["out"])
        d = ast.literal_eval(m.group(1).decode()) if m else {}
        ctx.ident = d
        ver = tuple(d.get("ver") or ())
        a1 = (d.get("build") == "WSU_SHIELD" and str(d.get("machine", "")).startswith("WSU Motor Shield with ESP32") and ver >= (1, 29, 0))
        record("A1", a1, "build=%r machine=%r version=%r impl=%r" % (d.get("build"), d.get("machine"), ver, d.get("impl")),
               "" if a1 else "not the class firmware (Thonny 'Install MicroPython' replaces it with stock firmware and removes _shield)")
        record("A2", d.get("abi") == 1, "ABI=%r shield_ver=%r" % (d.get("abi"), d.get("shield_ver")),
               "" if d.get("abi") == 1 else "ABI missing/mismatch: stock firmware or old/new class firmware")
        record("A3", d.get("policy") == 2 if d.get("abi") is not None else "skip", "policy=%r" % (d.get("policy"),))
        # A4 only means something on a freshly reset board; ticks_ms tells us the uptime.  (Session 1, 2026-10-12: the board had been
        # up 4.3 h with 19 soft resets, so motors_ready=True was correct, not a failure.)
        up_ms = None
        try:
            up_ms = int(d.get("uptime_ms")) if d.get("uptime_ms") is not None else None
        except Exception:
            up_ms = None
        fresh = up_ms is not None and up_ms < 60000
        a4 = (d.get("ready") is False) if (d.get("abi") is not None and fresh) else ("skip" if d.get("abi") is None else None)
        record("A4", a4, "motors_ready=%r uptime_ms=%r" % (d.get("ready"), up_ms),
               "judged only when uptime < 60 s; otherwise INFO (an earlier program may have started the motors this session)")
        root = d.get("root") or []
        record("A5", None, "root=%r free=%r" % (root, d.get("free")),
               "main.py PRESENT: kit will not run a friendly Ctrl-D soft reset (D2) unless it is the sentinel" if "main.py" in root else "")
        ctx.has_main = "main.py" in root
        if ctx.has_main:
            r2 = link.run_paste(MAIN_HEAD, 4.0)
            m2 = re.search(rb"@@(.*)", r2.get("out", b""))
            head = ast.literal_eval(m2.group(1).decode()) if m2 else ""
            ctx.main_is_sentinel = SENTINEL in head
            say("     main.py head: %r (sentinel=%s)" % (head[:80], ctx.main_is_sentinel))
    finally:
        end_session(ctx, link, ser)


# --------------------------------------------------------------------------------------
# Stage B: open/close reset matrix
# --------------------------------------------------------------------------------------
def session(ctx, variant):
    """One open -> passive listen -> probe -> hold -> probe -> close cycle under an open policy."""
    link, ser, t_open = new_link(ctx, variant)
    s = dict(variant=variant, t_open=t_open, a=None, b=None, err=None)
    try:
        s["early"], s["first"] = link.read_for(ctx.listen_s)
        ok, dt, buf = link.enter_raw()
        if not ok:
            s["err"] = "could not enter raw REPL (%r)" % (buf[-80:],)
        else:
            s["a"], _ = link.probe()
            time.sleep(1.0)
            s["b"], _ = link.probe()
            if s["a"] is None or s["b"] is None:
                s["err"] = "probe failed"
    finally:
        s["t_close"] = end_session(ctx, link, ser, variant, exit_raw=s["err"] is None)
    return s


def session_mpremote(ctx):
    import subprocess
    try:
        importlib.import_module("mpremote")
    except Exception:
        return None
    cmd = [sys.executable, "-I", "-B", "-X", "utf8", "-u", "-m", "mpremote", "connect", ctx.port, "resume", "exec",
           "import time;print('@@'+repr((time.ticks_ms(),)))"]
    t_open = time.monotonic()
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    t_close = time.monotonic()
    s = dict(variant="V7", t_open=t_open, t_close=t_close, early=b"", first=None, b=None, err=None)
    m = re.search(rb"@@(\(.*\))", p.stdout)
    if not m:
        s["a"] = None
        s["err"] = "mpremote said %r %r" % (p.stdout[-100:], p.stderr[-140:])
    else:
        t = ast.literal_eval(m.group(1).decode())
        s["a"] = dict(wall=t_close - 0.03, ticks=t[0], cause=None, hk=None)
    return s


def judge(prev, s):
    """Return (where, tag): where in none/open/close/n-a; tag is the variant to blame."""
    last = prev and (prev.get("b") or prev.get("a"))
    a = s.get("a")
    if not last or not a:
        return "n/a", None
    er, er0 = est_reset_wall(a), est_reset_wall(last)
    hk_drop = bool(a["hk"] and last["hk"] and any(x < y for x, y in zip(a["hk"], last["hk"])))
    if abs(er - er0) <= 1.0 and not hk_drop:
        return "none", None
    rom = bool(ROM_RE.search(s.get("early") or b""))
    first_ms = None if s.get("first") is None else (s["first"] - s["t_open"]) * 1000
    if rom and first_ms is not None and first_ms < 1500:
        return "open (ROM text %d ms after open)" % first_ms, s["variant"]
    d_open = abs(er - s["t_open"])
    tc = prev.get("t_close")
    d_close = abs(er - tc) if tc is not None else 1e9
    if min(d_open, d_close) > 1.0:
        return "somewhere between the previous probe and this one (not within 1 s of an open or a close)", s["variant"]
    if d_close <= d_open:
        return "close of previous session (%s) (estimated from ticks_ms)" % prev["variant"], prev["variant"]
    return "open (estimated from ticks_ms)", s["variant"]


def stage_B(ctx):
    say("== Stage B: does opening/closing the port reset the chip? (%d cycles per variant, %.1f s listen)" % (ctx.cycles, ctx.listen_s))
    counts = {}
    prev = None
    base_variant = ctx.variants[0] if ctx.variants else "V1"
    if base_variant == "V7":
        base_variant = "V1"
    say("-- baseline session (not judged) with %s" % base_variant)
    try:
        prev = session(ctx, base_variant)
        say("   baseline ticks=%s cause=%s hk=%s err=%s" % (prev["a"] and prev["a"]["ticks"], prev["a"] and prev["a"]["cause"], prev["a"] and prev["a"]["hk"], prev["err"]))
    except Exception as e:
        say("   baseline failed: %r" % (e,))
        prev = None
    if prev is not None and prev.get("a"):
        rom0 = bool(ROM_RE.search(prev.get("early") or b""))
        up = prev["a"]["ticks"]
        record("B-first", (not rom0) and up is not None and up >= ctx.min_uptime_ms,
               "first open after idle (%s): ROM text in first %.1f s = %s ; ticks_ms at first probe = %s ms (needs >= %d: plug the board in and wait 20 s first)" % (
                   base_variant, ctx.listen_s, rom0, up, ctx.min_uptime_ms))
    time.sleep(ctx.gap_s)
    for variant in ctx.variants:
        v = VARIANTS[variant]
        say("-- %s: %s" % (variant, v["desc"]))
        if variant == "V6" and os.name == "nt":
            record("B-open", "skip", "V6: POSIX only")
            continue
        c = counts.setdefault(variant, dict(open=0, close=0, hold=0, err=0, n=0))
        for cyc in range(ctx.cycles):
            try:
                s = session_mpremote(ctx) if variant == "V7" else session(ctx, variant)
            except Exception as e:
                c["err"] += 1
                say("   cycle %d: ERROR %r" % (cyc + 1, e))
                time.sleep(ctx.gap_s)
                continue
            if s is None:
                record("B-open", "skip", "V7: `python -m mpremote` not importable by this Python")
                counts.pop("V7", None)
                break
            c["n"] += 1
            if s["err"]:
                c["err"] += 1
            where, blame = judge(prev, s)
            if where.startswith("open"):
                c["open"] += 1
            elif where != "none" and where != "n/a":
                counts.setdefault(blame, dict(open=0, close=0, hold=0, err=0, n=0))["close"] += 1
            if s.get("a") and s.get("b") and abs(est_reset_wall(s["b"]) - est_reset_wall(s["a"])) > 1.0:
                c["hold"] += 1
                where += " + reset while held open"
            a = s.get("a")
            say("   cycle %d: reset=%s | first_byte=%s ms | ticks=%s cause=%s hk=%s%s" % (
                cyc + 1, where, None if s.get("first") is None else int((s["first"] - s["t_open"]) * 1000),
                a and a["ticks"], a and a["cause"], a and a["hk"], (" | " + s["err"]) if s["err"] else ""))
            prev = s
            time.sleep(ctx.gap_s)
    summary = []
    for variant in ctx.variants:
        c = counts.get(variant)
        if not c:
            continue
        v = VARIANTS[variant]
        record("B-open", c["open"] == 0 and c["n"] > 0 and c["err"] == 0, "%s: resets at open %d/%d%s" % (variant, c["open"], c["n"], (" (ERRORS %d: could not talk to the board; if every probe failed the lines may hold the chip in reset)" % c["err"]) if c["err"] else ""), v["desc"])
        record("B-close", c["close"] == 0 and c["n"] > 0, "%s: resets at close/gap %d/%d" % (variant, c["close"], c["n"]))
        record("B-hold", c["hold"] == 0, "%s: resets while held open %d" % (variant, c["hold"]))
        summary.append(dict(variant=variant, **c))
    say("   policy matrix (resets observed / cycles):")
    say("   %-4s %-9s %-11s %-9s %-7s  %s" % ("var", "at open", "close/gap", "held open", "errors", "policy"))
    for x in summary:
        say("   %-4s %-9s %-11s %-9s %-7s  %s" % (x["variant"], "%d/%d" % (x["open"], x["n"]), "%d/%d" % (x["close"], x["n"]), x["hold"], x["err"], VARIANTS[x["variant"]]["desc"][:70]))
    clean = [x["variant"] for x in summary if x["open"] == 0 and x["close"] == 0 and x["hold"] == 0 and x["err"] == 0 and x["n"] > 0]
    if clean:
        usable = [x for x in clean if x != "V7"]
        if usable and not ctx.variant_forced:
            ctx.variant = usable[0]
        say("   -> reset-free policies on this adapter/OS: %s ; later stages use %s" % (", ".join(clean), ctx.variant))
    else:
        say("   -> NO policy was reset-free (or all errored). Later stages use %s. Treat every connect as a chip reset." % ctx.variant)
    ctx.stageB = summary


# --------------------------------------------------------------------------------------
# Stage C: interrupt / Stop semantics
# --------------------------------------------------------------------------------------
def delta(a, b):
    if not a or not b or not a.get("hk") or not b.get("hk"):
        return None
    return tuple(y - x for x, y in zip(a["hk"], b["hk"]))


def stage_C(ctx):
    say("== Stage C: raw REPL, raw-paste, Ctrl-C / Stop semantics")
    link, ser, _ = new_link(ctx)
    try:
        link.read_for(1.0)
        ok, dt, buf = link.enter_raw()
        record("C1", ok, "entered in %.0f ms" % (dt * 1000) if ok else "failed: %r" % (buf[-100:],))
        if not ok:
            return
        base, _ = link.probe()
        # C2 raw-paste window
        r = link.run_paste("print('rp-ok')\n", 6.0)
        win = r.get("window")
        hdr = r.get("hdr", b"")
        good = r.get("ok") and win == 128 and b"rp-ok" in r.get("out", b"") and r.get("err", b"x") == b""
        record("C2", good, "window=%r header=%r out=%r err=%r" % (win, hdr, r.get("out"), r.get("err")))
        # C3 idle ctrl-C
        a, _ = link.probe()
        link.write(b"\x03")
        extra, _ = link.read_for(0.5)
        b, _ = link.probe()
        d = delta(a, b)
        record("C3", extra == b"" and (d is None or d == (0, 0, 0)) , "echo=%r hook_delta=%r" % (extra, d))
        # C4/C5 stop a sleeping loop with ONE Ctrl-C
        a, _ = link.probe()
        r = link.run_paste(RUN_LOOP, wait=False)
        time.sleep(0.6)
        t = time.monotonic()
        link.write(b"\x03")
        r = link.finish(r, r.get("pending", b""), 5.0)
        dt = time.monotonic() - t
        b, _ = link.probe()
        d = delta(a, b)
        tb = b"KeyboardInterrupt" in r.get("err", b"")
        pol = (ctx.ident or {}).get("policy")
        want = (0, 1, 1) if pol == 2 else None
        record("C4", tb and (d is None or want is None or d == want), "traceback=%s err=%r hook_delta=%r (policy=%r)" % (tb, r.get("err", b"")[:110], d, pol),
               "" if d is not None else "no _shield: hook counters unavailable (stock firmware?)")
        record("C5", None, "Ctrl-C -> prompt in %.0f ms" % (dt * 1000))
        # C6 double vs single Ctrl-C vs cleanup
        res = {}
        for label, gaps in (("double", (0.1,)), ("single", ())):
            r = link.run_paste(RUN_FINALLY, wait=False)
            time.sleep(0.6)
            link.write(b"\x03")
            for g in gaps:
                time.sleep(g)
                link.write(b"\x03")
            r = link.finish(r, r.get("pending", b""), 6.0)
            res[label] = b"cleanup done" in r.get("out", b"")
            time.sleep(0.3)
            link.drain()
        record("C6", (res["double"] is False and res["single"] is True), "cleanup completed: after Ctrl-C,Ctrl-C(100ms)=%s ; after single Ctrl-C=%s" % (res["double"], res["single"]),
               "if both True the second interrupt did not land inside the finally; if single False the first Ctrl-C was lost")
        # C7 swallow
        a, _ = link.probe()
        r = link.run_paste(RUN_SWALLOW, wait=False)
        time.sleep(0.5)
        t = time.monotonic()
        for _i in range(3):
            link.write(b"\x03")
            time.sleep(0.4)
        r = link.finish(r, r.get("pending", b""), 10.0)
        dt = time.monotonic() - t
        b, _ = link.probe()
        d = delta(a, b)
        m = re.search(rb"swallowed (\d+)", r.get("out", b""))
        record("C7", bool(m) and int(m.group(1)) >= 2 and dt > 3.0 and (d is None or d[1:] == (0, 0)),
               "swallowed=%s, returned after %.1f s, hook_delta=%r" % (m.group(1) if m else None, dt, d))
        # C8 kbd_intr(-1)
        r = link.run_paste(RUN_KBDOFF, wait=False)
        time.sleep(0.5)
        link.write(b"\x03")
        time.sleep(0.4)
        link.write(b"\x03")
        r = link.finish(r, r.get("pending", b""), 8.0)
        ended = b"kbd_intr loop ended by itself" in r.get("out", b"") and b"KeyboardInterrupt" not in r.get("err", b"")
        link.drain()
        r2 = link.run_paste(RUN_LOOP, wait=False)
        time.sleep(0.5)
        link.write(b"\x03")
        r2 = link.finish(r2, r2.get("pending", b""), 4.0)
        rearmed = b"KeyboardInterrupt" in r2.get("err", b"")
        record("C8", ended and rearmed, "kbd_intr(-1) ignored Ctrl-C=%s ; next exec interruptible again=%s" % (ended, rearmed))
        # C9 threads
        r = link.run_paste(RUN_THREAD, wait=False)
        time.sleep(0.7)
        link.write(b"\x03")
        r = link.finish(r, r.get("pending", b""), 5.0)
        more, _ = link.read_for(1.5)
        t_after = more.count(b"T")
        no_thread = b"ImportError" in r.get("err", b"") or b"ImportError" in r.get("out", b"")
        # restart thread, interrupt, then raw soft reset
        r = link.run_paste(RUN_THREAD, wait=False)
        time.sleep(0.7)
        link.write(b"\x03")
        r = link.finish(r, r.get("pending", b""), 5.0)
        ok2, dt2, buf2 = link.soft_reset_raw()
        more2, _ = link.read_for(1.2)
        t_after_reset = more2.count(b"T")
        if no_thread:
            record("C9", "skip", "no _thread module on this firmware")
        else:
            record("C9", t_after >= 5 and t_after_reset == 0, "T chars after Ctrl-C prompt: %d ; after raw soft reset: %d" % (t_after, t_after_reset))
        link.drain()
        # C10 abort an upload
        a, _ = link.probe()
        win, hdr, credit = link.paste_open()
        link.write(b"x = 1\n" * 4)
        time.sleep(0.2)
        link.write(b"\x03")
        buf, ok3 = link.read_until(b">", 3.0)
        b, _ = link.probe()
        d = delta(a, b)
        want = (0, 1, 1) if pol == 2 else None
        record("C10", buf.startswith(b"\x04") and b"KeyboardInterrupt" in buf and (d is None or want is None or d == want),
               "reply=%r hook_delta=%r" % (buf[:80], d))
    finally:
        end_session(ctx, link, ser)


# --------------------------------------------------------------------------------------
# Stage D: soft reset
# --------------------------------------------------------------------------------------
def stage_D(ctx):
    say("== Stage D: soft reset semantics")
    link, ser, _ = new_link(ctx)
    try:
        link.read_for(1.0)
        ok, dt, buf = link.enter_raw()
        if not ok:
            record("D1", False, "could not enter raw REPL")
            return
        a, _ = link.probe()
        t = time.monotonic()
        link.write(b"\x04")
        buf, ok = link.read_until(b"raw REPL; CTRL-B to exit\r\n>", 12.0)
        el = time.monotonic() - t
        okfmt = ok and buf.startswith(b"OK\r\n") and b"MPY: soft reboot\r\n" in buf
        b, _ = link.probe()
        d = delta(a, b)
        cont = a and b and abs(((b["ticks"] - a["ticks"]) % TICKS_PERIOD) - (b["wall"] - a["wall"]) * 1000) < 2500
        record("D1", okfmt and (b is not None and b["cause"] in (5, None)) and (d is None or d[0] == 1) and cont,
               "wire=%r in %.0f ms ; hook_delta=%r cause=%r tick_continuous=%s" % (buf[:60], el * 1000, d, b and b["cause"], cont))
        link.exit_raw()
        if ctx.has_main and not getattr(ctx, "main_is_sentinel", False):
            record("D2", "skip", "/main.py exists and is not the sentinel: a friendly Ctrl-D would RUN it")
        else:
            link.drain()
            link.write(b"\x04")
            buf, ok = link.read_until(b">>> ", 12.0)
            okf = ok and b"MPY: soft reboot" in buf and b"MicroPython v" in buf
            c, _ = (None, None)
            if okf:
                ok2, _x, _y = link.enter_raw()
                c, _ = link.probe()
                link.exit_raw()
            d = delta(b, c)
            record("D2", okf and (d is None or d[0] == 1), "wire=%r hook_delta=%r" % (buf[-140:], d))
        record("D3", None, "documented: main.py runs only if REPL mode is friendly AND boot.py ended without an uncaught exception (ret != 0 with EXIT_CODE_HANDLING off)")
    finally:
        end_session(ctx, link, ser)


# --------------------------------------------------------------------------------------
# Stage K: control keys
# --------------------------------------------------------------------------------------
def stage_K(ctx):
    say("== Stage K: REPL control keys (friendly REPL)")
    link, ser, _ = new_link(ctx)
    try:
        link.read_for(0.8)
        link.write(b"\r\x03")
        time.sleep(0.2)
        link.drain()
        link.write(b"\r")
        buf, ok = link.read_until(b">>> ", 3.0)
        if not ok:
            record("K1", False, "no friendly prompt: %r" % (buf[-80:],))
            return
        link.drain()
        link.write(b"\x05")
        buf, ok = link.read_until(b"=== ", 2.0)
        paste_hdr = b"paste mode; Ctrl-C to cancel, Ctrl-D to finish" in buf
        link.write(b"print('pm', 3*4)\r")
        link.read_for(0.2)
        link.write(b"\x04")
        buf2, ok2 = link.read_until(b">>> ", 3.0)
        link.write(b"\x05")
        link.read_until(b"=== ", 2.0)
        link.write(b"print('never')")
        link.write(b"\x03")
        buf3, ok3 = link.read_until(b">>> ", 2.0)
        record("K1", paste_hdr and b"pm 12" in buf2 and b"never" not in buf3.replace(b"print('never')", b"") and ok3,
               "header=%s ran=%s cancelled=%s" % (paste_hdr, b"pm 12" in buf2, ok3))
        link.drain()
        link.write(b"abc\x01")
        buf, _ = link.read_until(b"raw REPL", 0.6)
        link.write(b"\x03")
        link.read_until(b">>> ", 2.0)
        record("K2", b"raw REPL" not in buf, "after typing 'abc' then Ctrl-A: %r" % (buf[-60:],))
        link.drain()
        link.write(b"print('lf', 1)\n")
        b1, _ = link.read_until(b">>> ", 2.0)
        n_lf = b1.count(b"lf 1")
        link.drain()
        link.write(b"print('crlf', 2)\r\n")
        b2, _ = link.read_until(b">>> ", 2.0)
        extra, _ = link.read_for(0.3)
        n_crlf = (b2 + extra).count(b"crlf 2\r\n") + 0
        prompts = (b2 + extra).count(b">>> ")
        link.drain()
        link.write(b"abc\x04")
        b4, _ = link.read_for(0.8)
        link.write(b"\x03")
        link.read_until(b">>> ", 2.0)
        record("K4", b"soft reboot" not in b4, "after 'abc' + Ctrl-D: %r" % (b4[-60:],))
        record("K3", n_lf >= 1 and n_crlf == 1 and prompts == 1, "LF ran %d time(s); CRLF ran %d time(s), %d prompt(s)" % (n_lf, n_crlf, prompts),
               "on v1.27 a bare LF is ignored: that would show LF ran 0 times")
    finally:
        try:
            link.write(b"\x03")
        except Exception:
            pass
        close_port(ctx, ser, ctx.variant)


# --------------------------------------------------------------------------------------
# Stage M: main.py semantics (only with the sentinel main.py)
# --------------------------------------------------------------------------------------
def stage_M(ctx):
    if not (ctx.has_main and getattr(ctx, "main_is_sentinel", False)):
        say("== Stage M skipped: put a main.py whose first line is '# %s' and that prints 'HWKIT main.py ran' (see README); the kit never writes it for you." % SENTINEL)
        record("M1", "skip", "no sentinel main.py")
        record("M2", "skip", "no sentinel main.py")
        return
    say("== Stage M: main.py semantics")
    link, ser, _ = new_link(ctx)
    try:
        link.read_for(1.0)
        ok, dt, buf = link.enter_raw()
        link.write(b"\x04")
        buf, ok = link.read_until(b"raw REPL; CTRL-B to exit\r\n>", 12.0)
        extra, _ = link.read_for(1.0)
        record("M1", ok and b"HWKIT main.py ran" not in (buf + extra), "after raw soft reset: %r" % ((buf + extra)[-100:],))
        link.exit_raw()
        link.drain()
        link.write(b"\x04")
        buf, _ = link.read_for(3.0)
        record("M2", b"HWKIT main.py ran" in buf, "after friendly Ctrl-D: %r" % (buf[-120:],))
    finally:
        try:
            link.write(b"\x03")
            time.sleep(0.3)
        except Exception:
            pass
        close_port(ctx, ser, ctx.variant)


# --------------------------------------------------------------------------------------
# Stage E: hardware reset (opt-in)
# --------------------------------------------------------------------------------------
def rts_pulse(ser, hold=0.1):
    ser.dtr = False   # GPIO0 high: normal boot
    ser.rts = True    # EN low
    time.sleep(hold)
    ser.rts = False   # EN high
    return time.monotonic()


def stage_E(ctx):
    if not ctx.allow_hw_reset:
        say("== Stage E skipped (needs --allow-hardware-reset)")
        return
    say("== Stage E: hardware reset by RTS pulse (DTR kept low). MOTOR POWER MUST BE OFF.")
    link, ser, _ = new_link(ctx)
    try:
        link.read_for(1.0)
        ok, dt, buf = link.enter_raw()
        pre, _ = link.probe()
        link.exit_raw()
        link.drain()
        try:
            t_rel = rts_pulse(ser)
        except Exception as e:
            record("E1", False, "modem lines not controllable on this port: %r" % (e,))
            return
        early, first = link.read_for(3.0)
        rom = ROM_RE.search(early)
        prompt = b">>> " in early
        link.write(b"\r\x03")
        time.sleep(0.2)
        link.drain()
        ok2, dt2, buf2 = link.enter_raw()
        post, _ = link.probe() if ok2 else (None, None)
        waiting = b"waiting for download" in early
        reset_seen = bool(post and pre and abs(est_reset_wall(post) - est_reset_wall(pre)) > 1.0)
        good = reset_seen and not waiting and (post is None or post["cause"] in (1, None)) and (post is None or post["hk"] in (None, (0, 0, 0)) or post["hk"][0] == 0)
        record("E1", good, "reset_seen=%s ROM_text=%s download_mode=%s cause=%r ticks=%r hk=%r" % (
            reset_seen, bool(rom), waiting, post and post["cause"], post and post["ticks"], post and post["hk"]),
            "ROM text absent is normal if GPIO15 has its pull-down fitted (the ROM log is silenced)")
        if ctx.has_main and getattr(ctx, "main_is_sentinel", False):
            record("M3", b"HWKIT main.py ran" in early, "after the RTS pulse: %r" % (early[-100:],))
        record("E3", None, "first byte %s ms after RTS release; friendly prompt %s in 3 s window" % (
            None if first is None else int((first - t_rel) * 1000), prompt))
        # E2: unstoppable loop
        if ok2:
            say("   E2: starting a 12 s loop that ignores Ctrl-C; Ctrl-C will be tried, then the RTS pulse.")
            say("       If the pulse does not work, wait 12 s or press the EN button. Press Enter to go...")
            if not ctx.no_prompt:
                input()
            r = link.run_paste(RUN_UNSTOPPABLE, wait=False)
            time.sleep(1.0)
            link.write(b"\x03")
            nostop, _ = link.read_for(1.5)
            ignored = b"KeyboardInterrupt" not in nostop and b">" not in nostop[-3:]
            t_rel = rts_pulse(ser)
            e2, first2 = link.read_for(3.5)
            ended = b"UNSTOPPABLE-LOOP-ENDED-BY-ITSELF" in e2
            link.write(b"\r\x03")
            time.sleep(0.2)
            link.drain()
            ok3, _x, _y = link.enter_raw()
            c, _ = link.probe() if ok3 else (None, None)
            fresh = bool(c and est_reset_wall(c) > time.monotonic() - 8 and c["ticks"] < 9000)
            record("E2", ignored and fresh and not ended, "Ctrl-C ignored=%s ; recovered by RTS pulse=%s ; loop ended itself=%s ; first byte after pulse %s ms" % (
                ignored, fresh, ended, None if first2 is None else int((first2 - t_rel) * 1000)))
    finally:
        try:
            link.write(b"\r\x02")
        except Exception:
            pass
        close_port(ctx, ser, ctx.variant)


# --------------------------------------------------------------------------------------
# Stage U: unplug (opt-in, interactive)
# --------------------------------------------------------------------------------------
def stage_U(ctx):
    say("== Stage U: unplug behaviour. A counter will stream for %d s; UNPLUG the USB cable after about 5 s." % ctx.unplug_wait)
    link, ser, _ = new_link(ctx)
    try:
        link.read_for(0.8)
        ok, dt, buf = link.enter_raw()
        r = link.run_paste(RUN_STREAM, wait=False)
        t0 = time.monotonic()
        exc = None
        got = 0
        while time.monotonic() - t0 < ctx.unplug_wait:
            try:
                d = link.avail()
                got += len(d)
            except Exception as e:
                exc = e
                break
            time.sleep(0.02)
        if exc is None:
            record("U1", None, "no exception within %d s (%d bytes received); was the cable unplugged?" % (ctx.unplug_wait, got))
        else:
            record("U1", None, "%s: %s after %.1f s" % (type(exc).__name__, exc, time.monotonic() - t0),
                   "errno=%r" % (getattr(exc, "errno", None),))
    finally:
        try:
            ser.close()
        except Exception as e:
            say("   close after unplug raised %r" % (e,))


# --------------------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------------------
CHECKLIST = """\
BEFORE YOU RUN ANYTHING THAT OPENS THE PORT
  [ ] Motor power is OFF: battery pack disconnected / wall adapter unplugged / VBATT switch off.
      The board is powered by the USB cable ONLY. (GPIO15 spins motor 2 ~0.3 s at every chip reset.)
  [ ] Nothing is attached to the motor, servo or J8/J10/J11 headers that could be damaged by a twitch.
  [ ] Close Thonny, Arduino Serial Monitor, PlatformIO monitor, other VS Code windows, mpremote, screen/PuTTY.
  [ ] Use a data-capable USB cable, plugged directly into the computer (no hub for the first run).
  [ ] A spare board is NOT required: the kit writes nothing to the board. If a sentinel main.py is on
      the board it is run only by stage M. Any other main.py is never run by the kit.
  [ ] Windows: note the COM port in Device Manager. macOS: use the /dev/cu.* name, not /dev/tty.*.
  [ ] Keep the EN (reset) button within reach.
  [ ] Run once as: python mpy_hwkit.py --port <PORT> --stages A,B,C,D,K --yes-motors-off
  [ ] Then, still with motor power OFF, optionally: --stages E --allow-hardware-reset  and  --stages U
  [ ] Send hwkit-report-*.json (written next to where you ran it) back with the console output.
"""


def list_ports():
    try:
        from serial.tools import list_ports as lp
    except ImportError:
        say("pyserial not installed: pip install pyserial")
        return []
    rows = []
    for p in sorted(lp.comports(), key=lambda p: p.device):
        rows.append(dict(device=p.device, vid=p.vid, pid=p.pid, serial=p.serial_number, mfr=p.manufacturer, product=p.product, desc=p.description))
    return rows


KNOWN_BRIDGES = {(0x10C4, 0xEA60), (0x1A86, 0x7523), (0x1A86, 0x55D4), (0x0403, 0x6001), (0x0403, 0x6015), (0x303A, 0x1001), (0x303A, 0x0002)}


def kind_of(row):
    k = (row["vid"], row["pid"])
    return {(0x10C4, 0xEA60): "CP210x (auto-reset circuit expected)", (0x1A86, 0x7523): "CH340", (0x1A86, 0x55D4): "CH9102",
            (0x0403, 0x6001): "FTDI", (0x303A, 0x1001): "Espressif USB-Serial/JTAG (native)"}.get(k, "other" if row["vid"] else "not USB (pty/virtual?)")


def list_checks_md():
    out = ["| ID | Stage | What it settles | Expected on WSU_SHIELD v1.29.0 | Source |", "|---|---|---|---|---|"]
    for cid in ORDER:
        c = CHECKS[cid]
        out.append("| %s | %s | %s | %s | %s |" % (c["id"], c["stage"], c["claim"], c["expect"].replace("|", "\\|"), c["source"]))
    return "\n".join(out)


def gate(ctx, row_is_real):
    if not row_is_real:
        return True
    if getattr(ctx, "motors_on_ack", False) and not ctx.yes_motors_off:
        NOTES.append("INSTRUCTOR OVERRIDE: motor power ON acknowledged (--motors-on-acknowledged); checklist item 1 waived for this run")
        say("!! INSTRUCTOR OVERRIDE: motor power is ON. A chip reset can spin motor 2 for ~0.3 s. Checklist item 1 is waived and recorded in the report.")
        say(CHECKLIST)
        return True
    if not ctx.yes_motors_off:
        say("REFUSING: this opens a real USB serial port, which may reset the chip. Re-run with --yes-motors-off after the checklist "
            "(or --motors-on-acknowledged if the instructor has explicitly accepted motor power being ON).")
        return False
    if ctx.no_prompt:
        say("(--no-prompt ignored for a real USB device)")
    say(CHECKLIST)
    try:
        ans = input("Type exactly  MOTORS OFF  to confirm motor power is disconnected: ")
    except EOFError:
        ans = ""
    if ans.strip() != "MOTORS OFF":
        say("Not confirmed. Nothing was opened.")
        return False
    return True


# --------------------------------------------------------------------------------------
# Safe mode (CLAUDE.md rule 5, protocol Appendix A.1).
# The kit is standalone (instructor/student machines have only pyserial), so it must NOT import
# bridge.*: the few lines below deliberately duplicate bridge/link.py safe_mode_active() /
# safe_mode_check(). Keep them in step. Pinned by tests/test_hwkit_guard.py.
# --------------------------------------------------------------------------------------
_SM_PTY_RE = re.compile(r"^/dev/(?:ttys\d+|pts/\d+)$")
_SM_LOOPBACK_HOSTS = ("localhost", "::1")


def safe_mode_active(environ=None):
    """MPY_SAFE_MODE is on for any value except empty, 0, false, no, off (Appendix A.1)."""
    env = os.environ if environ is None else environ
    v = env.get("MPY_SAFE_MODE")
    if v is None:
        return False
    return v.strip().lower() not in ("", "0", "false", "no", "off")


def _sm_url_is_loopback(port):
    """True only for loop:// or socket:// / rfc2217:// to a loopback host, parsed with a real URL parser
    (a string prefix is fooled by socket://127.0.0.1@example.com:80 and '127.'-prefixed hostnames)."""
    try:
        from urllib.parse import urlsplit
        parts = urlsplit(port)
        scheme = (parts.scheme or "").lower()
        if scheme == "loop":
            return True
        if scheme not in ("socket", "rfc2217"):
            return False            # spy:// alt:// hwgrep:// cp2110:// ... can resolve to real devices
        if "@" in parts.netloc:
            return False            # userinfo: pyserial does not use it, so the visible host is not the target
        host = (parts.hostname or "").lower()
        parts.port                  # raises ValueError on a malformed port
    except ValueError:
        return False
    if host in _SM_LOOPBACK_HOSTS:
        return True
    octets = host.split(".")
    return len(octets) == 4 and octets[0] == "127" and all(o.isdigit() and 0 <= int(o) <= 255 for o in octets)


def safe_mode_refusal(port, simulated=False, serial_class_spec=None, environ=None):
    """None when the kit may go on with `port`; otherwise the refusal text. Pure (opens nothing)."""
    env = os.environ if environ is None else environ
    if not safe_mode_active(env):
        return None
    real = env.get("MPY_REAL_PORT", "")
    if real and real.strip().lower() != "auto" and real == port:
        return None                                   # the one deliberate, supervised real port
    if "://" in port:
        if _sm_url_is_loopback(port):
            return None
    elif _SM_PTY_RE.match(port):
        extra = [p for p in env.get("MPY_HARNESS_PTYS", "").split(os.pathsep) if p]
        if port in extra or simulated:
            return None                               # a pty is never a USB device; --simulated dry run on it
    if simulated and serial_class_spec and serial_class_spec.partition(":")[0].split(".")[0] != "serial":
        return None                                   # dry run through a stub class: pyserial is never reached
    return ("REFUSING: MPY_SAFE_MODE is on, so %s will not be opened (MPY_REAL_PORT=%r does not equal the requested port exactly). "
            "For the supervised real-board session set MPY_REAL_PORT to exactly that port (never \"auto\"); "
            "dry runs use --simulated --serial-class module:Class. Nothing was opened." % (port, real))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port")
    ap.add_argument("--stages", default="A,B,C,D,K")
    ap.add_argument("--variants", default="V1,V2,V3,V4,V5,V6,V7")
    ap.add_argument("--variant", help="open policy for stages A,C,D,K,E (default: first reset-free variant from stage B, else V3)")
    ap.add_argument("--cycles", type=int, default=3)
    ap.add_argument("--listen", type=float, default=2.5, help="seconds of passive listening after each open")
    ap.add_argument("--gap", type=float, default=1.5)
    ap.add_argument("--yes-motors-off", action="store_true")
    ap.add_argument("--motors-on-acknowledged", action="store_true",
                    help="INSTRUCTOR OVERRIDE: motor power is ON and the instructor has accepted that a chip reset can spin motor 2 for ~0.3 s. Recorded in the report. Use fewer --cycles/--variants to limit resets.")
    ap.add_argument("--allow-hardware-reset", action="store_true")
    ap.add_argument("--list-checks", action="store_true")
    ap.add_argument("--show-snippets", action="store_true")
    ap.add_argument("--simulated", action="store_true", help="dry-run against a fake board; refused for real USB devices")
    ap.add_argument("--no-prompt", action="store_true", help="only with --simulated")
    ap.add_argument("--serial-class", help="module:Class used instead of serial.Serial (test hook for the dry run)")
    ap.add_argument("--force-unknown-adapter", action="store_true")
    ap.add_argument("--min-uptime-ms", type=int, default=10000, help="stage B first-open check: board must have been up this long before the kit started (0 disables)")
    ap.add_argument("--unplug-wait", type=int, default=60, help="stage U: seconds to wait for you to unplug")
    ap.add_argument("--report", help="JSON report path")
    a = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass

    if a.list_checks:
        say(list_checks_md())
        return 0
    if a.show_snippets:
        for k, v in SNIPPETS.items():
            audit(v)
            say("### %s\n%s" % (k, v))
        return 0

    if a.port:
        refusal = safe_mode_refusal(a.port, a.simulated, a.serial_class)   # BEFORE enumeration, the gate and any open
        if refusal:
            say(refusal)
            return 2

    say("mpy_hwkit %s | Python %s | %s | pyserial %s" % (KIT_VERSION, platform.python_version(), platform.platform(), _pyserial_version()))
    rows = list_ports()
    for r in rows:
        say("  port %-28s vid:pid=%s:%s serial=%s %s | %s" % (r["device"], "%04x" % r["vid"] if r["vid"] else "----", "%04x" % r["pid"] if r["pid"] else "----",
                                                           r["serial"], r["product"] or r["desc"], kind_of(r)))
    if not a.port:
        say("\nNo --port given: nothing was opened.\n")
        say(CHECKLIST)
        return 0

    ctx = Ctx()
    ctx.port = a.port
    ctx.cycles = a.cycles
    ctx.listen_s = a.listen
    ctx.gap_s = a.gap
    ctx.variants = [v.strip() for v in a.variants.split(",") if v.strip() in VARIANTS]
    vid = next((r["vid"] for r in rows if r["device"] == a.port), None)
    ctx.variant = a.variant or ("V3" if (os.name == "nt" and vid == 0x10C4) else "V4")   # what mpremote 1.29 itself does
    ctx.variant_forced = bool(a.variant)
    ctx.yes_motors_off = a.yes_motors_off
    ctx.motors_on_ack = a.motors_on_acknowledged
    ctx.allow_hw_reset = a.allow_hardware_reset
    ctx.no_prompt = a.no_prompt
    ctx.unplug_wait = a.unplug_wait
    ctx.min_uptime_ms = a.min_uptime_ms
    ctx.notes = NOTES
    ctx.serial_cls = load_serial_class(a.serial_class)
    ctx.ident = None
    ctx.has_main = False
    ctx.open_ser = None
    ctx.stageB = []
    real = any(r["device"] == a.port and r["vid"] for r in rows)
    known = any(r["device"] == a.port and (r["vid"], r["pid"]) in KNOWN_BRIDGES for r in rows)
    if not a.simulated and not known and not a.force_unknown_adapter:
        say("REFUSING: %s is not a known ESP32 USB-UART bridge (CP210x, CH340, CH9102, FTDI, Espressif). Wrong port? Add --force-unknown-adapter only if you are sure." % a.port)
        return 2
    if a.simulated and real:
        say("REFUSING --simulated on a real USB device.")
        return 2
    if not a.simulated and not gate(ctx, True):
        return 2
    if a.simulated:
        ctx.no_prompt = True
    stages = [s.strip().upper() for s in a.stages.split(",") if s.strip()]
    if "M" not in stages and "A" in stages:
        stages.append("M")
    runners = dict(A=stage_A, B=stage_B, C=stage_C, D=stage_D, K=stage_K, M=stage_M, E=stage_E, U=stage_U)
    order = [s for s in "ABCDKMEU" if s in stages]
    if "B" in order and "A" not in order:
        say("note: stage A skipped, so main.py/_shield presence is unknown; D2 will run a friendly Ctrl-D only if /main.py is absent (unknown => assumed ABSENT).")
    for s in order:
        try:
            runners[s](ctx)
        except KeyboardInterrupt:
            say("interrupted")
            break
        except Exception as e:
            record(s + "-error", False, repr(e))
    summarize(a, ctx)
    return 0


def _pyserial_version():
    try:
        import serial
        return serial.__version__
    except Exception:
        return "missing"


def summarize(a, ctx):
    say("\n== Summary")
    say("%-8s %-6s %s" % ("check", "result", "observed"))
    for r in RESULTS:
        say("%-8s %-6s %s" % (r["id"], r["verdict"], r["observed"][:150]))
    nf = sum(1 for r in RESULTS if r["verdict"] == "FAIL")
    say("\n%d check(s) FAILED (a FAIL is a finding, not a kit error: read the note), %d recorded." % (nf, len(RESULTS)))
    for n in NOTES[:20]:
        say("note: " + n)
    path = a.report or "hwkit-report-%s.json" % time.strftime("%Y%m%d-%H%M%S")
    try:
        with open(path, "w") as f:
            json.dump(dict(kit=KIT_VERSION, python=platform.python_version(), platform=platform.platform(), port=a.port, variant=ctx.variant,
                           stageB=ctx.stageB, ident=ctx.ident, results=RESULTS, notes=NOTES), f, indent=1, default=str)
        say("report written to " + path)
    except Exception as e:
        say("could not write report: %r" % (e,))


if __name__ == "__main__":
    sys.exit(main())
