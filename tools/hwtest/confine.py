"""confine.py - the harness cannot hurt the board by construction (docs/hwtest-plan.md "Confinement").

Everything the harness sends to the bridge goes through ``ConfinedClient`` -> ``Policy.check``.  The check is an ALLOWLIST:

* only the ops in ``OP_CLASSES`` exist; any other op (every ``reset.*``, ``introspect.modules``, internal ops, typos) is refused;
* every op has an allowlist of argument names, so ``openPolicy`` (other than "auto"), ``interrupt``, ``force``, ``allowMount``,
  ``background``, ``reset``, ``vid``/``pid`` ... cannot be passed at all;
* device paths of WRITING ops (``fs.put``, ``fs.rm``, ``fs.rmtree``, ``fs.mkdir``, ``fs.mv`` source and destination) are
  normalised lexically (``..``, ``.``, ``//``) and must lie under ``scratch + "/"`` (``fs.mkdir`` / ``fs.rmtree`` may also name
  ``scratch`` itself).  The NORMALISED path is what is sent.  Segments ending in a dot or a space (FAT strips them), control
  characters and backslashes are refused.  ``main.py`` / ``boot.py`` (``.mpy`` too, any case, any depth) are never written;
  names that shadow a firmware / stdlib module (``SHADOW_BUILTIN`` plus the config's ``shadow_names``) are refused at an import root;
* reads outside scratch: ``fs.list`` / ``fs.manifest`` / ``fs.stat`` anywhere, ``fs.get`` only of scratch and of the backup files;
* local paths (``fs.put local``, ``fs.get local``, ``run local``) must lie under the harness's own temp / backup folders;
* ``run`` executes only programs authored by the harness itself (``ProgramStore``): the registered file must still hash to the
  registered text, and the text is scanned (``scan_program``);
* ``exec`` accepts only exact code strings registered with the policy: the tripwire probe and config probes that passed
  ``validate_probe_code`` (one read-only ``print(...)`` of allowlisted getter calls on allowlisted modules: ``time``, ``gc`` and
  the config's ``probe_modules``; never main/boot/test/_boot/inisetup, never a frozen package of the firmware);
* ``tty.write`` is limited to printable ASCII + CR/LF (so no Ctrl-C / Ctrl-D / escape sequences / TAB completion), 256 bytes, and
  is an ALLOWLIST: while the REPL view is attached only whole lines from ``TTY_LINES`` (the phase D strings) ending in CR; while a
  harness program runs only up to 16 letters, digits and spaces (keystrokes for its ``sys.stdin``); otherwise nothing;
* ``connect`` goes to the configured port only, with ``openPolicy`` absent or ``"auto"``; ``rmtree`` always carries ``confirm:true``.

``Policy.allowed_classes`` (set per phase) additionally restricts the op classes a phase may send, which is what
``--list-phases`` prints.  Violations raise ``ConfinementError`` BEFORE the request leaves the process.

Reset ops (the reset tiers) are refused exactly as above UNLESS the policy was built with a ``ResetGate`` and that gate is
ARMED, which only phase R does (``resetphase.py``).  The gate is created only when every condition of ``run_hw.py`` holds
(phase R requested, ``--allow-resets N`` with 1 <= N <= 5, env ``MPY_ALLOW_RESETS=1``, the config does not forbid it, and for a
real device all the real-port guards).  While armed the allowlist is exactly: ``reset.capability`` (nothing, or ``learned``
= null / "failed", accepted and never forwarded: the harness never sets it), ``reset.soft`` (no arguments, once), ``reset.machine`` ``{confirmed: true}`` and
``reset.hard`` ``{confirmed: true, verify: bool}`` (no force / method / learned / interrupt, and only when the capability that was
read AFTER the last chip reset says hard.state verified or likely).  Chip resets (machine, hard) are counted against the budget
BEFORE they are sent (``ConfinedClient.send``; ``reset.hard`` with ``verify:true`` costs ``HARD_VERIFY_PULSES`` = 2 units because
the bridge repeats the pulse once when the chip stays in the ROM bootloader, so ``--allow-resets N`` bounds the chips resets the board
can physically see), the request that would exceed the budget is refused, a new reset is refused until the previous one was
declared recovered, and after ``abort()`` none is ever sent again.  While armed only the classes of phase R are allowed, so
the write allowlist is empty (no fs writes, no run, no tty.write).
"""
from __future__ import annotations

import ast
import base64
import hashlib
import os
import re
import threading
import time

__all__ = ["ConfinementError", "DeadlineExceeded", "TTY_LINES", "Policy", "ConfinedClient", "ProgramStore", "Program", "OP_CLASSES", "OP_CLASS_NAMES",
           "ResetGate", "RESET_OP_CLASSES", "RESET_CLASS_NAMES", "RESET_PHASE_CLASSES", "RESET_BUDGET_MAX", "RESET_SOFT_MAX",
           "OP_RESET_CAPABILITY", "OP_RESET_SOFT", "OP_RESET_MACHINE", "OP_RESET_HARD", "CHIP_RESET_OPS", "HARD_VERIFY_PULSES", "chip_cost",
           "normalize_device_path", "scan_program", "validate_probe_code", "validate_scratch", "SHADOW_BUILTIN",
           "FORBIDDEN_PROGRAM_TOKENS", "PROGRAM_IMPORTS", "PROTECTED_BASENAMES"]


class ConfinementError(Exception):
    """A request (or program, or config value) the harness refuses to send."""


class DeadlineExceeded(Exception):
    """The overall time budget of the run (or of the cleanup) is used up; nothing more is sent."""


# the only lines that may be typed into the attached REPL (phase D); a typed line is code, so it is fixed text, not free text
TTY_LINES = ("1+2", "_hw_v = 41", "_hw_v + 1", "del _hw_v")
_TTY_KEYS = re.compile(r"[A-Za-z0-9 ]{1,16}")


# --------------------------------------------------------------------------------------------------- op classes
OP_CLASSES = {
    "ports.list": "session", "connect": "session", "disconnect": "session", "config": "session", "ping": "session",
    "shutdown": "session",
    "identity": "read", "fs.list": "read", "fs.manifest": "read", "fs.stat": "read", "fs.get": "read",
    "fs.put": "scratch-write", "fs.rm": "scratch-write", "fs.rmtree": "scratch-write", "fs.mkdir": "scratch-write",
    "fs.mv": "scratch-write",
    "exec": "probe",
    "run": "program",
    "stop": "stop", "cancel": "stop",
    "tty.write": "console", "repl.attach": "console", "repl.detach": "console",
}
OP_CLASS_NAMES = {
    "session": "connect/disconnect/config/ports.list (never an openPolicy other than auto)",
    "read": "read-only: identity, fs.list, fs.manifest, fs.stat anywhere; fs.get of scratch and backup files",
    "scratch-write": "fs.put/rm/rmtree/mkdir/mv, ONLY under the scratch folder",
    "probe": "exec of the fixed tripwire probe and validated read-only config probes",
    "program": "run of harness-authored, scanned programs from the harness temp folder",
    "stop": "stop / cancel (Ctrl-C x2 via the bridge; no reset)",
    "console": "repl.attach / repl.detach / tty.write of printable text (never control characters)",
}
RESET_OPS_MESSAGE = "reset operations are never sent by the harness"

# The reset tiers.  The names live ONLY here (the source lint of tests/test_hwtest.py keeps them out of every other module);
# phase R refers to them as ``confine.OP_RESET_*``.  They are deliberately NOT in OP_CLASSES: without an armed ResetGate every
# one of them is refused by ``Policy.check`` before any class lookup.
OP_RESET_CAPABILITY = "reset.capability"
OP_RESET_SOFT = "reset.soft"
OP_RESET_MACHINE = "reset.machine"
OP_RESET_HARD = "reset.hard"
RESET_OP_CLASSES = {OP_RESET_CAPABILITY: "reset-info", OP_RESET_SOFT: "reset-soft", OP_RESET_MACHINE: "reset-chip",
                    OP_RESET_HARD: "reset-chip"}
RESET_CLASS_NAMES = {
    "reset-info": "phase R only: reset.capability (read-only estimate, nothing is sent to the board)",
    "reset-soft": "phase R only: reset.soft, at most once (new VM, the chip is not reset)",
    "reset-chip": "phase R only: reset.machine / reset.hard, a CHIP RESET, counted against --allow-resets before it is sent",
}
CHIP_RESET_OPS = (OP_RESET_MACHINE, OP_RESET_HARD)
RESET_PHASE_CLASSES = ("session", "read", "probe", "reset-info", "reset-soft", "reset-chip")
RESET_BUDGET_MAX = 5            # hard cap on chip resets per run, whatever the command line says
RESET_SOFT_MAX = 1
HARD_VERIFY_PULSES = 2          # bridge/server.py _verify_hard_reset repeats the pulse ONCE when the chip reports "waiting for download"


def chip_cost(op, args):
    """Budget units (= the most chip resets the board can see) one request of ``op`` can cost: 0 for anything that cannot reset
    the chip, 1 for ``reset.machine`` and ``reset.hard`` without verification, ``HARD_VERIFY_PULSES`` for ``reset.hard`` with
    ``verify:true`` (the bridge may pulse the lines twice inside that ONE request).  Used by the gate and by the phase R plan."""
    if op == OP_RESET_HARD and isinstance(args, dict) and args.get("verify") is True:
        return HARD_VERIFY_PULSES
    return 1 if op in CHIP_RESET_OPS else 0

PROTECTED_BASENAMES = frozenset(["main.py", "boot.py", "main.mpy", "boot.mpy"])

# modules a file at an import root would hide (the bridge's devfs refuses these too; the harness refuses first)
SHADOW_BUILTIN = frozenset("""machine os sys time gc micropython network esp esp32 array binascii collections errno hashlib
heapq io json math random re select socket struct ssl uos utime usys ubinascii ujson urandom ure uio ustruct uselect usocket
ussl uhashlib asyncio uasyncio framebuf bluetooth btree cryptolib deflate platform vfs _thread onewire neopixel dht ds18x20
rp2 pyb stm uctypes webrepl espnow builtins gc cmath os_path logging""".split())
SHADOW_ROOTS = ("/", "/lib", "/flash", "/flash/lib", "/sd", "/sd/lib")

_CTRL = re.compile(r"[\x00-\x1f\x7f]")


# --------------------------------------------------------------------------------------------------- paths
def normalize_device_path(path, write=False):
    """Lexical normalisation of an absolute device path ('..', '.', '//' resolved, never above '/')."""
    if not isinstance(path, str) or not path:
        raise ConfinementError("device path must be a non-empty string, got %r" % (path,))
    if _CTRL.search(path) or "\\" in path:
        raise ConfinementError("device path %r contains control characters or a backslash" % (path,))
    if not path.startswith("/"):
        raise ConfinementError("device path %r is not absolute" % (path,))
    out = []
    for seg in path.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if out:
                out.pop()
            continue
        if write and (seg != seg.rstrip(". ") or not seg.strip(". ")):
            raise ConfinementError("device path %r has a segment ending in a dot or a space (FAT would strip it)" % (path,))
        out.append(seg)
    return "/" + "/".join(out)


def _under(norm, scratch, allow_equal):
    return norm.startswith(scratch + "/") or (allow_equal and norm == scratch)


def validate_scratch(value):
    """The scratch folder named in a config: absolute, normalised, not a root-like folder, and recognisably the harness's."""
    if not isinstance(value, str):
        raise ConfinementError("scratch must be a string")
    norm = normalize_device_path(value, write=True)
    if norm != value:
        raise ConfinementError("scratch %r must be an absolute, normalised path (no '..', '.', '//', trailing '/')" % (value,))
    segs = norm.strip("/").split("/")
    if not segs or segs == [""]:
        raise ConfinementError("scratch must not be the root folder")
    if not segs[-1].startswith("_mpybench"):
        raise ConfinementError("scratch %r: the last folder name must start with '_mpybench' so that the harness can never "
                               "delete a folder it does not own" % (value,))
    if any(seg.lower() in ("lib", ".frozen") for seg in segs):
        raise ConfinementError("scratch %r must not be inside an import folder (lib or .frozen at any depth)" % (value,))
    return norm


# --------------------------------------------------------------------------------------------------- program scanner
# Case-insensitive substring match.  The first group is the list from docs/hwtest-plan.md; the rest closes obvious holes.
FORBIDDEN_PROGRAM_TOKENS = (
    "reset", "bootloader", "pin(", ".pin", "pwm", "adc", "dac", "i2c(", "spi(", "uart(", "esp.", "esp32.", "network",
    "os.remove", "os.rmdir", "os.rename", "open(", "motor", "servo",
    # extras
    "machine", "micropython", "_thread", "__import__", "exec", "eval", "compile", "getattr", "setattr", "delattr", "globals",
    "locals", "vars(", "builtins", "deepsleep", "lightsleep", "uos", "os.", "socket", "webrepl", "espnow", "bluetooth",
    "mem32", "mem8", "mem16", "sdcard", "i2s", "rtc", "wdt", "timer(", "signal(", "neopixel", "onewire", "unlink", "rmdir",
    "mkdir", "remove(", "rename(", "chdir", "umount", "mount(", "dupterm", "sys.exit", "exit(", "kbd_intr", "freq(",
    "__", "modules",          # no dunder tricks (__dict__, __class__ ...) and no sys.modules route to a hidden module
)
PROGRAM_IMPORTS = frozenset(["sys", "time", "select"])      # a harness program may import nothing else
# whole identifiers that a harness text may not contain anywhere (also as a bare name, so ``g = open`` / ``f = o.remove`` fail)
FORBIDDEN_PROGRAM_WORDS = frozenset("""open exec eval compile getattr setattr delattr globals locals vars breakpoint remove rename
unlink rmdir mkdir chdir umount mount listdir ilistdir pin pwm adc dac reset""".split())
_WORD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# an import ANYWHERE in the text (after ``;``, ``:``, in a one-line suite, in a string), not only at the start of a line
_IMPORT_RE = re.compile(r"\bfrom\s+([\w.]+)\s+import\b[^;\n#]*|\bimport\s+([^;\n#]+)")


def scan_program(text, extra_names=()):
    """Return a list of reasons why ``text`` may not be sent to the board as code (empty list = clean)."""
    problems = []
    low = text.lower()
    squeezed = re.sub(r"\s+(?=\()", "", low)          # ``open ('x')`` is ``open('x')``
    for tok in FORBIDDEN_PROGRAM_TOKENS:
        if tok in squeezed:
            problems.append("contains %r" % tok)
    for word in sorted(set(_WORD_RE.findall(low)) & FORBIDDEN_PROGRAM_WORDS):
        if not any(("contains %r" % t) in problems for t in (word, word + "(")):
            problems.append("uses the name %r" % word)
    for name in extra_names:
        if name and re.search(r"(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])" % re.escape(name.lower()), low):
            problems.append("mentions the protected name %r" % name)
    for m in _IMPORT_RE.finditer(text):
        mods = [m.group(1)] if m.group(1) else [re.split(r"\s+as\s+", x.strip())[0].strip() for x in m.group(2).split(",")]
        for mod in mods:
            if mod.split(".")[0] not in PROGRAM_IMPORTS:
                problems.append("imports %r (allowed: %s)" % (mod, ", ".join(sorted(PROGRAM_IMPORTS))))
    for ch in text:
        if ord(ch) > 126 or (ord(ch) < 32 and ch not in "\r\n\t"):
            problems.append("contains the non-ASCII/control character %r" % ch)
            break
    return problems


class Program(object):
    def __init__(self, name, path, text, sha256):
        self.name, self.path, self.text, self.sha256 = name, path, text, sha256


class ProgramStore(object):
    """Authors harness programs into a private folder and remembers what it wrote (path -> sha256)."""

    def __init__(self, root, extra_names=()):
        self.root = root
        self.extra_names = tuple(extra_names)
        self._by_path = {}
        os.makedirs(root, exist_ok=True)

    def author(self, name, text):
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_ ().-]*\.py", name) \
                or name.lower() in PROTECTED_BASENAMES:
            raise ConfinementError("program file name %r is not allowed" % (name,))
        problems = scan_program(text, self.extra_names)
        if problems:
            raise ConfinementError("program %r refused by the scanner: %s" % (name, "; ".join(problems)))
        path = os.path.join(self.root, name)
        try:
            os.chmod(path, 0o600)                 # a re-authored program replaces a read-only one
        except OSError:
            pass
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        try:
            os.chmod(path, 0o400)                 # read-only once written (narrows the check-to-use window; verify() re-hashes)
        except OSError:
            pass
        prog = Program(name, path, text, hashlib.sha256(text.encode("utf-8")).hexdigest())
        self._by_path[os.path.realpath(path)] = prog
        return prog

    def verify(self, local):
        """The registered program behind ``local``, after re-reading the file and re-scanning (TOCTOU / swapped file)."""
        if not isinstance(local, str) or not os.path.isabs(local):
            raise ConfinementError("run: local must be an absolute path of a harness-authored program")
        prog = self._by_path.get(os.path.realpath(local))
        if prog is None:
            raise ConfinementError("run: %r is not a program authored by the harness" % (local,))
        try:
            with open(prog.path, "rb") as f:
                data = f.read()
        except OSError as exc:
            raise ConfinementError("run: cannot re-read %r: %s" % (local, exc))
        if hashlib.sha256(data).hexdigest() != prog.sha256:
            raise ConfinementError("run: %r was modified after the harness wrote it" % (local,))
        problems = scan_program(prog.text, self.extra_names)
        if problems:
            raise ConfinementError("run: program %r refused by the scanner: %s" % (prog.name, "; ".join(problems)))
        return prog


# --------------------------------------------------------------------------------------------------- probe validator
_PROBE_NAMES = frozenset(["print", "__import__", "len", "str", "repr", "int", "hex", "bool", "float", "list", "tuple",
                          "sorted", "min", "max", "sum", "abs", "round"])
# importing a module RUNS its top level, so a probe may import only an ALLOWLIST of modules: ``time`` and ``gc`` plus the config's
# ``probe_modules``.  These can never be imported by a probe, whatever the config says (user code, boot code, firmware shells).
_PROBE_HARD_DENY = frozenset("""os uos machine umachine esp esp32 esp8266 network socket usocket ssl ussl bluetooth ubluetooth
_thread micropython rp2 pyb stm uctypes webrepl espnow usb builtins sys usys io uio
main boot test _boot inisetup flashbdev webrepl_setup upysh this""".split())
_PROBE_BUILTIN_MODULES = frozenset(["time", "gc"])
_MODNAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,39}")
# attribute calls: an allowlist of shapes, minus any name that contains an action word (``set_counts``, ``clear_counts``)
_PROBE_BAD_WORDS = frozenset("""set clear reset write put send start stop enable disable run load save erase delete remove add update
init deinit sleep delay wait push pop pulse toggle open close flash format mount umount move drive spin motor servo pwm pin exec eval
call trigger fire kick feed power off on read take and fill drain flush sync""".split())
_PROBE_GETTER_PREFIX = re.compile(r"(?:get|is|has)_[a-z0-9_]+")
_PROBE_GETTER_SUFFIX = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*_(?:counts?|stats?|info|status|version)")
_PROBE_GETTER_EXACT = frozenset(["ticks_ms", "ticks_us", "ticks_cpu", "ticks_diff", "mem_free", "mem_alloc", "unique_id", "uname",
                                 "version", "counts", "counters", "status", "stats"])
_PROBE_OK_NODES = (ast.Expression, ast.Expr, ast.Call, ast.Name, ast.Load, ast.Constant, ast.Attribute, ast.Tuple, ast.List,
                   ast.Dict, ast.BinOp, ast.Add, ast.Sub, ast.Mult, ast.Mod, ast.UnaryOp, ast.USub, ast.Not, ast.Compare,
                   ast.Eq, ast.NotEq, ast.Lt, ast.Gt, ast.LtE, ast.GtE, ast.BoolOp, ast.And, ast.Or, ast.IfExp,
                   ast.Subscript, ast.Index if hasattr(ast, "Index") else ast.Constant, ast.Slice)


def probe_getter_ok(name):
    """True for an attribute name that reads like a read-only getter AND has no action word in it."""
    if name in _PROBE_GETTER_EXACT:
        return True
    if not (_PROBE_GETTER_PREFIX.fullmatch(name) or _PROBE_GETTER_SUFFIX.fullmatch(name)):
        return False
    return not (set(name.split("_")) & _PROBE_BAD_WORDS)


def default_probe_modules(shadow_names):
    """Private C modules named in ``shadow_names`` (leading underscore, e.g. ``_acme``) have no Python top level, so a getter probe
    may import them; frozen Python packages (no underscore) never."""
    return [n for n in shadow_names if isinstance(n, str) and n.startswith("_") and _MODNAME.fullmatch(n)
            and n.lower() not in _PROBE_HARD_DENY and not n.lower().startswith("_boot")]


def validate_probe_module(mod, shadow_names=(), probe_modules=None):
    """Raise ConfinementError unless a probe may ``__import__`` ``mod``."""
    if not isinstance(mod, str) or not _MODNAME.fullmatch(mod):
        raise ConfinementError("probe code may only import a plain module name, got %r" % (mod,))
    low = mod.lower()
    if low in _PROBE_HARD_DENY or low.startswith("_boot"):
        raise ConfinementError("probe code may not import %r (it would run board code or touch hardware)" % mod)
    allowed = set(_PROBE_BUILTIN_MODULES)
    allowed.update(default_probe_modules(shadow_names) if probe_modules is None else probe_modules)
    if mod not in allowed:
        raise ConfinementError("probe code may not import %r: not in the allowlist (%s; add private C modules to the config key "
                               "probe_modules)" % (mod, ", ".join(sorted(allowed))))
    if low in set(str(n).lower() for n in shadow_names) and not mod.startswith("_"):
        raise ConfinementError("probe code may not import %r: it is one of the config's shadow_names (a firmware package that "
                               "would run its Python top level)" % mod)
    return mod


def validate_probe_code(code, shadow_names=(), probe_modules=None):
    """A config 'extra probe' is device code, so it is held to a narrow grammar: ONE line, ASCII, exactly one statement
    ``print(<expr>)`` where every call is a harmless builtin, ``__import__('<module>')`` of an ALLOWLISTED module (``time``, ``gc``,
    the config's ``probe_modules``; default: the private ``_name`` entries of ``shadow_names``), or an attribute call whose name is a
    read-only getter shape (``get_*``, ``is_*``, ``has_*``, ``*_count(s)``, ``*_info``, ``ticks_ms``, ``mem_free`` ...) without any
    action word in it.  Raises ConfinementError."""
    if not isinstance(code, str) or not code.strip():
        raise ConfinementError("probe code must be a non-empty string")
    if len(code) > 300 or "\n" in code or "\r" in code or any(ord(c) > 126 or ord(c) < 32 for c in code):
        raise ConfinementError("probe code must be one printable-ASCII line of at most 300 characters")
    problems = scan_program(code)
    problems = [p for p in problems if "__import__" not in p and "'__'" not in p]   # dunders: validated structurally below
    if problems:
        raise ConfinementError("probe code refused by the scanner: %s" % "; ".join(problems))
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        raise ConfinementError("probe code is not valid Python: %s" % exc)
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.Expr):
        raise ConfinementError("probe code must be a single print(...) statement")
    top = tree.body[0].value
    if not (isinstance(top, ast.Call) and isinstance(top.func, ast.Name) and top.func.id == "print"):
        raise ConfinementError("probe code must be a single print(...) statement")
    for node in ast.walk(tree.body[0]):
        if not isinstance(node, _PROBE_OK_NODES):
            raise ConfinementError("probe code uses a construct that is not allowed (%s)" % type(node).__name__)
        if isinstance(node, ast.Constant) and not isinstance(node.value, (str, int, float, bool, type(None))):
            raise ConfinementError("probe code uses a constant that is not allowed")
        if isinstance(node, ast.Name) and node.id not in _PROBE_NAMES:
            raise ConfinementError("probe code uses the name %r (allowed: %s)" % (node.id, ", ".join(sorted(_PROBE_NAMES))))
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise ConfinementError("probe code may not touch private attribute %r" % node.attr)
        if isinstance(node, ast.Call):
            if node.keywords:
                raise ConfinementError("probe calls may not use keyword arguments")
            fn = node.func
            if isinstance(fn, ast.Name):
                if fn.id == "__import__":
                    if len(node.args) != 1 or not isinstance(node.args[0], ast.Constant) or not isinstance(node.args[0].value, str):
                        raise ConfinementError("__import__ needs one string literal")
                    validate_probe_module(node.args[0].value, shadow_names, probe_modules)
            elif isinstance(fn, ast.Attribute):
                if not probe_getter_ok(fn.attr):
                    raise ConfinementError("probe code calls %r, which is not an allowlisted read-only getter name" % fn.attr)
            else:
                raise ConfinementError("probe code makes a call that is not allowed")
    return code


# --------------------------------------------------------------------------------------------------- reset gate
class ResetGate(object):
    """State of the reset allowance of ONE run: budget, counters, the last capability read, armed/aborted flags.  Created by
    ``run_hw.py`` only when every gating condition holds; only phase R arms it.  Thread-safe (``reserve`` is atomic)."""

    def __init__(self, budget):
        if isinstance(budget, bool) or not isinstance(budget, int) or not 1 <= budget <= RESET_BUDGET_MAX:
            raise ConfinementError("the chip reset budget must be an integer in 1..%d, got %r" % (RESET_BUDGET_MAX, budget))
        self.budget = budget
        self.armed = False
        self.chip_used = 0                  # budget units reserved so far (counted BEFORE the request is sent; a hard reset with
                                            # verify:true reserves HARD_VERIFY_PULSES because the bridge may pulse twice)
        self.soft_used = 0
        self.in_flight = None               # (op, n) of a reset that was sent and not yet declared recovered
        self.aborted = None                 # reason once aborted: nothing more is ever sent
        self.capability = None              # the last reset.capability result
        self.cap_chip_mark = None           # chip_used when the request for that capability LEFT (not when its answer arrived)
        self.ledger = []                    # [{n, op, args, chip_n, cost, pulses_max}] one row per reset request that was allowed out
        self._lock = threading.Lock()

    @property
    def remaining(self):
        return self.budget - self.chip_used

    def arm(self):
        with self._lock:
            self.armed = True

    def disarm(self):
        with self._lock:
            self.armed = False

    def abort(self, reason):
        with self._lock:
            if self.aborted is None:
                self.aborted = str(reason)

    def recovered(self):
        with self._lock:
            self.in_flight = None

    def note_capability(self, resp, chip_mark=None):
        """Remember a reset.capability answer.  ``chip_mark`` = ``chip_used`` when its REQUEST left (``ConfinedClient`` records it
        at send time): an answer that was computed before a chip reset must not count as a read after it, and an older answer
        never replaces a newer one.  ``None`` = now (direct callers that read and note in one step)."""
        cap = {k: resp.get(k) for k in ("soft", "machine", "hard", "cacheKey")}
        with self._lock:
            mark = self.chip_used if chip_mark is None else chip_mark
            if self.cap_chip_mark is not None and mark < self.cap_chip_mark:
                return
            self.capability = cap
            self.cap_chip_mark = mark

    def mark(self):
        with self._lock:
            return self.chip_used

    def settle(self, n, pulses):
        """Lower the REPORTED chip reset count of ledger row ``n`` once the response proves how many pulses it caused.  Only the
        report changes: the budget units stay reserved (never refunded)."""
        with self._lock:
            for row in self.ledger:
                if row["n"] == n and row["chip_n"] is not None:
                    row["pulses_max"] = max(1, min(row["pulses_max"], int(pulses)))

    def hard_state(self):
        hard = (self.capability or {}).get("hard")
        return hard.get("state") if isinstance(hard, dict) else None

    def _check_locked(self, op, args=None):
        def refuse(why):
            raise ConfinementError("%s: %s" % (op, why))

        if not self.armed:
            refuse(RESET_OPS_MESSAGE)
        if self.aborted is not None:
            refuse("the reset phase was aborted (%s); no further reset is ever sent" % self.aborted)
        if op == OP_RESET_CAPABILITY:
            return
        if self.capability is None:
            refuse("reset.capability must be read first")
        if self.in_flight is not None:
            refuse("the previous reset (%s, #%d) has not been declared recovered; one reset at a time, never a retry"
                   % self.in_flight)
        if op == OP_RESET_SOFT:
            if self.soft_used >= RESET_SOFT_MAX:
                refuse("the soft reset was already sent once in this run")
            return
        cost = chip_cost(op, args)
        if self.chip_used + cost > self.budget:
            refuse("the chip reset budget (%d) is used up: %d unit(s) spent, this request needs %d%s"
                   % (self.budget, self.chip_used, cost, " (a hard reset with verify can pulse the lines twice)" if cost > 1 else ""))
        machine = self.capability.get("machine")
        hard = self.capability.get("hard")
        if op == OP_RESET_MACHINE:
            if not (isinstance(machine, dict) and machine.get("available") is True):
                refuse("the capability says reset.machine is not available")
        elif op == OP_RESET_HARD:
            if self.cap_chip_mark != self.chip_used:
                refuse("reset.capability must be read again after the last chip reset (the estimate may have changed)")
            state = hard.get("state") if isinstance(hard, dict) else None
            method = hard.get("method") if isinstance(hard, dict) else None
            if state not in ("verified", "likely") or method not in ("rts-pulse", "usb-jtag"):
                refuse("the capability says hard.state=%r method=%r; a hard reset needs verified or likely, and is never forced"
                       % (state, method))
        else:
            refuse(RESET_OPS_MESSAGE)

    def check(self, op, args=None):
        """Non-mutating preconditions of ``op`` (``args`` = the clean arguments: ``verify`` decides the cost); raises ConfinementError."""
        with self._lock:
            self._check_locked(op, args)

    def reserve(self, op, args):
        """Atomically re-check and COUNT a reset request; called right before it is sent.  Raises ConfinementError."""
        with self._lock:
            self._check_locked(op, args)
            cost = chip_cost(op, args)
            row = {"n": len(self.ledger) + 1, "op": op, "args": dict(args), "chip_n": None, "cost": cost, "pulses_max": cost}
            if op == OP_RESET_SOFT:
                self.soft_used += 1
            elif op in CHIP_RESET_OPS:
                self.chip_used += cost
                row["chip_n"] = self.chip_used
            if op != OP_RESET_CAPABILITY:
                self.in_flight = (op, len(self.ledger) + 1)
                self.ledger.append(row)
        return row


# --------------------------------------------------------------------------------------------------- policy
def _bool(v, name):
    if not isinstance(v, bool):
        raise ConfinementError("%s must be a boolean" % name)
    return v


def _str(v, name):
    if not isinstance(v, str):
        raise ConfinementError("%s must be a string" % name)
    return v


def _str_list(v, name, limit=200):
    if not isinstance(v, (list, tuple)) or len(v) > limit or not all(isinstance(x, str) for x in v):
        raise ConfinementError("%s must be a list of at most %d strings" % (name, limit))
    return list(v)


def _true(v, name):
    if v is not True:
        raise ConfinementError("%s must be the boolean true" % name)
    return v


def _int(v, name, lo, hi):
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise ConfinementError("%s must be an integer in %d..%d" % (name, lo, hi))
    return v


class Policy(object):
    """What this harness run may send.  One instance per run; see the module docstring."""

    def __init__(self, scratch, port, backup_remote=(), local_read_roots=(), local_write_roots=(), shadow_names=(),
                 probe_codes=(), programs=None, allowed_classes=None, on_send=None, tty_lines=None, reset_gate=None):
        self.scratch = validate_scratch(scratch)
        self.reset_gate = reset_gate            # None = every reset op is refused, always (phases A-F never get a gate armed)
        self.port = port
        self.backup_remote = frozenset(normalize_device_path(b) for b in backup_remote)
        if "/" in self.backup_remote:
            raise ConfinementError("a backup file may not be the root folder")
        self.tty_lines = frozenset(TTY_LINES if tty_lines is None else tty_lines)
        self.local_read_roots = [os.path.realpath(r) for r in local_read_roots]
        self.local_write_roots = [os.path.realpath(r) for r in local_write_roots]
        self.shadow = frozenset(n.lower() for n in list(SHADOW_BUILTIN) + list(shadow_names))
        self.probe_codes = set(probe_codes)
        self.programs = programs
        self.allowed_classes = None if allowed_classes is None else frozenset(allowed_classes)
        self.on_send = on_send
        self.active_runs = set()
        self.repl_attached = False

    # ---- helpers
    def _local(self, value, roots, what, must_be_file=False):
        if not isinstance(value, str) or not value or "\x00" in value or not os.path.isabs(value):
            raise ConfinementError("%s: local path must be an absolute string" % what)
        real = os.path.realpath(value)
        if not any(real == r or real.startswith(r + os.sep) for r in roots):
            raise ConfinementError("%s: local path %r is outside the harness folders" % (what, value))
        if must_be_file and not os.path.isfile(real):
            raise ConfinementError("%s: %r is not a file" % (what, value))
        return value

    def _write_path(self, value, what, allow_equal=False):
        norm = normalize_device_path(value, write=True)
        base = norm.rsplit("/", 1)[-1]
        if base.lower() in PROTECTED_BASENAMES:
            raise ConfinementError("%s: %r would create or change %s, which the harness never does" % (what, value, base))
        parent = norm.rsplit("/", 1)[0] or "/"
        stem = base.split(".")[0].lower()
        if parent in SHADOW_ROOTS and (stem in self.shadow or base.lower() in self.shadow):
            raise ConfinementError("%s: %r would shadow the module %r" % (what, value, stem))
        if not _under(norm, self.scratch, allow_equal):
            raise ConfinementError("%s: %r is outside the scratch folder %s" % (what, value, self.scratch))
        return norm

    # ---- the check
    def check(self, op, args):
        """Return ``(clean_args, op_class)`` or raise ConfinementError.  ``clean_args`` is what must be sent."""
        if not isinstance(op, str):
            raise ConfinementError("op must be a string")
        gate = self.reset_gate
        if op.startswith("reset"):
            if gate is None or not gate.armed or op not in RESET_OP_CLASSES:
                raise ConfinementError("%s: %s" % (op, RESET_OPS_MESSAGE))
            klass = RESET_OP_CLASSES[op]
        else:
            klass = OP_CLASSES.get(op)
            if klass is None:
                raise ConfinementError("op %r is not in the harness allowlist" % (op,))
        if gate is not None and gate.armed and klass not in RESET_PHASE_CLASSES:
            raise ConfinementError("op %r (class %s) is not allowed in the reset phase: nothing is written, run or typed there"
                                   % (op, klass))
        if self.allowed_classes is not None and klass not in self.allowed_classes:
            raise ConfinementError("op %r (class %s) is not allowed in this phase (allowed: %s)"
                                   % (op, klass, ", ".join(sorted(self.allowed_classes))))
        args = dict(args)
        clean = {}

        def take(name, conv, required=False):
            if name in args:
                clean[name] = conv(args.pop(name))
            elif required:
                raise ConfinementError("%s: argument %r is required" % (op, name))

        if op in ("ports.list", "ping", "identity", "repl.attach", "repl.detach", "shutdown"):
            pass
        elif op == "connect":
            take("port", lambda v: v, True)
            if clean["port"] != self.port:
                raise ConfinementError("connect: %r is not the configured port %r" % (clean["port"], self.port))
            take("baud", lambda v: _int(v, "baud", 1200, 4000000))
            if "openPolicy" in args:
                if args["openPolicy"] != "auto":
                    raise ConfinementError("connect: openPolicy %r refused; only \"auto\" may be sent" % (args["openPolicy"],))
                clean["openPolicy"] = args.pop("openPolicy")
        elif op == "disconnect":
            take("stopFirst", lambda v: _bool(v, "stopFirst"))
        elif op == "config":
            take("shadowGuard", lambda v: self._names(v))
        elif op in ("fs.list", "fs.stat"):
            take("path", normalize_device_path, True)
        elif op == "fs.manifest":
            take("root", normalize_device_path, True)
            take("hash", lambda v: _bool(v, "hash"))
            take("exclude", lambda v: [normalize_device_path(x) for x in _str_list(v, "exclude")])
        elif op == "fs.get":
            take("remote", normalize_device_path, True)
            take("local", lambda v: self._local(v, self.local_write_roots, "fs.get"), True)
            r = clean["remote"]
            if not (r.startswith(self.scratch + "/") or r in self.backup_remote):
                raise ConfinementError("fs.get: %r is neither under scratch nor one of the backup files" % (r,))
        elif op == "fs.put":
            take("remote", lambda v: self._write_path(v, "fs.put"), True)
            take("local", lambda v: self._local(v, self.local_read_roots, "fs.put", True), True)
            take("mkdirs", lambda v: _bool(v, "mkdirs"))
            take("expectSha", lambda v: self._sha(v))
        elif op == "fs.rm":
            take("path", lambda v: self._write_path(v, "fs.rm"), True)
        elif op == "fs.rmtree":
            take("path", lambda v: self._write_path(v, "fs.rmtree", allow_equal=True), True)
            if "confirm" in args and args.pop("confirm") is not True:
                raise ConfinementError("fs.rmtree: confirm must be true")
            clean["confirm"] = True
        elif op == "fs.mkdir":
            take("path", lambda v: self._write_path(v, "fs.mkdir", allow_equal=True), True)
            take("parents", lambda v: _bool(v, "parents"))
        elif op == "fs.mv":
            take("src", lambda v: self._write_path(v, "fs.mv src"), True)
            take("dst", lambda v: self._write_path(v, "fs.mv dst"), True)
        elif op == "run":
            if "source" in args:
                raise ConfinementError("run: inline source is not allowed; only harness-authored program files")
            if self.programs is None:
                raise ConfinementError("run: no program store")
            take("local", lambda v: self.programs.verify(v).path, True)
            take("stdin", lambda v: _bool(v, "stdin"))
        elif op == OP_RESET_CAPABILITY:
            if "learned" in args:                    # the harness never sets it; "failed" can only LOWER the estimate
                if args.pop("learned") not in (None, "failed"):
                    raise ConfinementError("reset.capability: learned may only be null or \"failed\" (the harness never raises a capability)")
            gate.check(op)
        elif op == OP_RESET_SOFT:
            gate.check(op)
        elif op == OP_RESET_MACHINE:
            take("confirmed", lambda v: _true(v, "confirmed"), True)
            gate.check(op)
        elif op == OP_RESET_HARD:
            take("confirmed", lambda v: _true(v, "confirmed"), True)
            take("verify", lambda v: _bool(v, "verify"), True)
            gate.check(op, clean)
        elif op == "stop":
            take("timeoutMs", lambda v: _int(v, "timeoutMs", 100, 60000))
        elif op == "cancel":
            take("target", lambda v: _int(v, "target", 0, 2 ** 31), True)
        elif op == "exec":
            take("code", lambda v: _str(v, "exec code"), True)
            if clean["code"] not in self.probe_codes:
                raise ConfinementError("exec: only registered, validated probe code may be executed")
            take("timeoutMs", lambda v: _int(v, "timeoutMs", 100, 120000))
        elif op == "tty.write":
            take("b64", lambda v: _str(v, "b64"), True)
            try:
                raw = base64.b64decode(clean["b64"], validate=True)
            except Exception:
                raise ConfinementError("tty.write: b64 is not valid base64")
            if not raw or len(raw) > 256:
                raise ConfinementError("tty.write: 1..256 bytes only")
            if any(not (32 <= b <= 126 or b in (10, 13)) for b in raw):
                raise ConfinementError("tty.write: only printable ASCII, CR and LF (no control characters, no TAB completion)")
            # typed text becomes code in the REPL (or input of a harness program): an ALLOWLIST, never free text
            text = raw.decode("ascii")
            if self.active_runs:
                if not _TTY_KEYS.fullmatch(text):
                    raise ConfinementError("tty.write: while a harness program runs only up to 16 letters, digits or spaces may be typed")
            elif self.repl_attached:
                parts = [ln for ln in re.split(r"[\r\n]+", text) if ln != ""]
                if not text.endswith(("\r", "\n")) or not parts or any(ln not in self.tty_lines for ln in parts):
                    raise ConfinementError("tty.write: only whole lines from the harness list (%s) ending in CR may be typed into the REPL"
                                           % ", ".join(sorted(self.tty_lines)))
            else:
                raise ConfinementError("tty.write: neither a harness program is running nor the REPL attached")
        if args:
            raise ConfinementError("%s: argument(s) not allowed: %s" % (op, ", ".join(sorted(args))))
        return clean, klass

    @staticmethod
    def _sha(v):
        if not isinstance(v, str) or not re.fullmatch(r"[0-9a-f]{64}", v):
            raise ConfinementError("expectSha must be 64 lowercase hex digits")
        return v

    @staticmethod
    def _names(v):
        if not isinstance(v, list) or len(v) > 200 or not all(isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", x) for x in v):
            raise ConfinementError("shadowGuard must be a list of module names")
        return list(v)


# --------------------------------------------------------------------------------------------------- the client wrapper
class ConfinedClient(object):
    """The only object harness code uses to talk to the bridge.  Wraps a ``tests.bridge_client.BridgeClient``-like object
    (kept in ``_inner``; ``send_raw``, ``proc`` ... are deliberately not exposed)."""

    def __init__(self, inner, policy):
        self._inner = inner
        self.policy = policy
        self.log = []                 # [{n, op, class, ok, code, ms}]
        self.sent = 0
        self.class_counts = {}
        self.reset_errors = []        # responses that carried E_BOARD_RESET
        self.deadline = None          # time.monotonic() after which nothing more is sent / awaited (None = unbounded)
        self._pending = {}

    # ---- time budget
    def set_deadline(self, seconds_from_now):
        self.deadline = None if seconds_from_now is None else time.monotonic() + seconds_from_now

    def give_up(self):
        """From now on every send / wait raises DeadlineExceeded at once (the bridge is not answering)."""
        self.deadline = time.monotonic() - 1.0

    def _budget(self, timeout, default):
        """``timeout`` (or ``default``) clamped to what is left of the deadline; DeadlineExceeded when nothing is left."""
        if self.deadline is None:
            return timeout
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise DeadlineExceeded("the time budget of this run is used up; nothing more is sent to the bridge")
        base = timeout if timeout is not None else default
        return min(base, left)

    # ---- requests
    def send(self, op, **args):
        self._budget(None, 0.0)
        clean, klass = self.policy.check(op, args)
        if klass in ("reset-soft", "reset-chip"):
            self.policy.reset_gate.reserve(op, clean)        # counted against the budget BEFORE it can leave the process
        if self.policy.on_send is not None:
            self.policy.on_send(op, dict(clean))
        if op == "run":
            self.policy.programs.verify(clean["local"])     # again, as late as possible: the file may not have changed
        rid = self._inner.send(op, **clean)
        self.sent += 1
        self.class_counts[klass] = self.class_counts.get(klass, 0) + 1
        gate = self.policy.reset_gate
        self._pending[rid] = (op, klass, time.monotonic(), gate.mark() if (gate is not None and op == OP_RESET_CAPABILITY) else None)
        if op == "run":
            self.policy.active_runs.add(rid)
        return rid

    def result(self, rid, timeout=None):
        resp = self._inner.result(rid, self._budget(timeout, getattr(self._inner, "default_timeout", 20.0)))
        op, klass, t0, cap_mark = self._pending.pop(rid, ("?", "?", time.monotonic(), None))
        ok = bool(resp.get("ok"))
        err = resp.get("error") or {}
        self.log.append({"n": rid, "op": op, "class": klass, "ok": ok, "code": err.get("code"),
                         "ms": int((time.monotonic() - t0) * 1000)})
        if len(self.log) > 20000:
            del self.log[:5000]
        if err.get("code") == "E_BOARD_RESET":
            self.reset_errors.append({"op": op, "id": rid})
        if op == OP_RESET_CAPABILITY and ok and self.policy.reset_gate is not None:
            self.policy.reset_gate.note_capability(resp, cap_mark)
        if op == "run":
            self.policy.active_runs.discard(rid)
        elif op == "repl.attach" and ok:
            self.policy.repl_attached = True
        elif op in ("repl.detach", "disconnect") and ok:
            self.policy.repl_attached = False
        return resp

    def request(self, op, _timeout=None, **args):
        return self.result(self.send(op, **args), _timeout)

    def call(self, op, _timeout=None, **args):
        resp = self.request(op, _timeout, **args)
        if not resp.get("ok"):
            from tests.bridge_client import BridgeCallError
            raise BridgeCallError(op, resp)
        return resp

    def tty_write(self, data, _timeout=None):
        t0 = time.monotonic()
        self.call("tty.write", _timeout=_timeout, b64=base64.b64encode(data).decode("ascii"))
        return t0

    # ---- read-only views of the inner client
    def mark(self):
        return self._inner.mark()

    def events_of(self, ev=None, since=0, **match):
        return self._inner.events_of(ev, since, **match)

    def wait_event(self, ev=None, predicate=None, timeout=10.0, since=0):
        return self._inner.wait_event(ev, predicate, self._budget(timeout, 10.0), since)

    def states(self, since=0):
        return self._inner.states(since)

    def out_bytes(self, since=0):
        return self._inner.out_bytes(since)

    def err_bytes(self, since=0):
        return self._inner.err_bytes(since)

    def repl_bytes(self, since=0):
        return self._inner.repl_bytes(since)

    def wait_stream(self, kind, needle, timeout=10.0, since=0):
        return self._inner.wait_stream(kind, needle, self._budget(timeout, 10.0), since)

    def wait_out(self, needle, timeout=10.0, since=0):
        return self._inner.wait_stream("out", needle, self._budget(timeout, 10.0), since)

    def stderr_tail(self, n=12):
        return self._inner.stderr_tail(n)

    @property
    def alive(self):
        return self._inner.alive

    @property
    def pid(self):
        return self._inner.pid

    @property
    def hello(self):
        return self._inner.hello

    def close(self, timeout=8.0):
        return self._inner.close(timeout)

    def kill(self):
        return self._inner.kill()

    @property
    def shutdown_mode(self):
        return self._inner.shutdown

    @property
    def exit_code(self):
        return self._inner.exit_code
