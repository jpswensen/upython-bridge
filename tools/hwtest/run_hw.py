#!/usr/bin/env python3
"""run_hw.py - the generic hardware test harness (spec: docs/hwtest-plan.md; limits: CLAUDE.md "Hard rules").

    python3.13 -B tools/hwtest/run_hw.py --port <PORT|socket://127.0.0.1:N> [--config file.json] [--phases A,B,C,D,E,F]
                                         [--fake PROFILE [--fake-fault NAME ...]] [--allow-real-port] [--report DIR]
                                         [--backup-dir DIR] [--max-minutes N] [--dry-run] [--list-phases]
                                         [--phases A,R --allow-resets N]            (phase R: the reset tiers, see below)

It drives the real bridge process over NDJSON (tests/bridge_client.py) through ``confine.ConfinedClient``, so every request is
checked before it leaves: writes only inside the scratch folder, only harness-authored programs, no reset op, openPolicy auto.

Guards (exit code 2, BEFORE anything is spawned or opened)
    A port that is not a loopback ``socket://`` / ``rfc2217://`` / ``loop://`` URL and not a pty registered in MPY_HARNESS_PTYS is
    a REAL device.  It needs ALL of: ``--allow-real-port``, env ``MPY_REAL_PORT`` exactly equal to ``--port`` (never "auto"), and
    env ``MPY_SAFE_MODE`` truthy.  ``--dry-run`` checks the same guards and the config, prints the plan and exits 0 without
    spawning a bridge, starting a fake board or opening anything.  ``--list-phases`` prints the phases and the op classes each may
    send and opens nothing.  ``--fake PROFILE`` starts tools.fakeboard.FakeBoard in-process and connects to its socket URL.

Phase R (reset tiers) is the only thing that can restart the board and is NEVER part of the defaults.  ALL of these must hold,
    else exit 2 before anything is spawned: R requested explicitly in --phases, ``--allow-resets N`` with 1 <= N <= 5, env
    ``MPY_ALLOW_RESETS`` exactly "1", the config's optional ``allow_resets`` does not forbid it (it can only lower N), and for a
    real device all the real-port guards above.  ``--dry-run`` checks the same and prints "chip resets budget N".

Exit codes
    0 every selected phase passed, no tripwire trip, no residue      1 a phase failed / residue / unexpected error
    2 refused by a guard, bad arguments or bad config (nothing started)   3 TRIPPED (chip reset suspected; cleanup ran)
    4 phase A refuses to continue (board not idle at a prompt, wrong board, port held, scratch exists; board left alone)
    5 RESET PHASE ABORTED (phase R met its first surprise: no further reset was sent; cleanup ran; reason in the report)
    130 interrupted (Ctrl-C); cleanup ran
A run has an overall time budget (``--max-minutes``, default 25): every wait is clamped to what is left of it, then the cleanup gets
its own 90 s and the bridge is ended whatever happens.  The report folder is created and test-written BEFORE anything is spawned
(exit 2 when it cannot be); a report that cannot be written at the end turns a would-be exit 0 into exit 1.
Reports: ``<report base>/<UTC timestamp>/report.json`` + ``console.txt`` (schema in report.py).
"""
from __future__ import annotations

import argparse
import ipaddress
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from urllib.parse import urlsplit

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(_HERE))
if __name__ == "__main__":
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _HERE]
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tests.bridge_client import BRIDGE_PATH, DEFAULT_TIMEOUT, BridgeClient, BridgeGone, bridge_argv  # noqa: E402
from tests.support import child_env  # noqa: E402
from tools.hwtest import confine, fakedriver, phases, resetphase  # noqa: E402
from tools.hwtest.config import Config, ConfigError, load_config  # noqa: E402
from tools.hwtest.report import Console, Report, utc_stamp  # noqa: E402
from tools.hwtest.tripwire import TRIP_PROBE, ProbeFailed, Tripwire, TripwireTripped  # noqa: E402

DEFAULT_REPORTS = os.path.join(_HERE, "reports")
DEFAULT_BACKUP = os.path.join(_HERE, "backup")
DEFAULT_PHASES = "A,B,C,D,E"
DEFAULT_MAX_MINUTES = 25.0
FAKE_UPTIME_S = 3600.0          # a fake board is made to look like a board that has been up for an hour (the tripwire's baseline floor)
_PTY_RE = re.compile(r"^/dev/(?:ttys\d+|pts/\d+)$")
_FALSY = ("", "0", "false", "no", "off")


class GuardError(Exception):
    """Refused before anything started (exit code 2)."""


# --------------------------------------------------------------------------------------------------- port guards
def safe_mode_on(env):
    v = env.get("MPY_SAFE_MODE")
    return v is not None and v.strip().lower() not in _FALSY


def _loopback_url(port):
    """loop:// or socket:// / rfc2217:// to this machine (same rule as docs/protocol.md Appendix B; nothing is resolved)."""
    scheme = port.partition("://")[0].lower()
    if scheme == "loop":
        return True
    if scheme not in ("socket", "rfc2217"):
        return False
    try:
        parts = urlsplit(port)
        host = parts.hostname
    except ValueError:
        return False
    if not host or "@" in parts.netloc:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def classify_port(port, env):
    """'url' (loopback fake), 'pty' (registered by MPY_HARNESS_PTYS), 'device' (REAL), or 'invalid'."""
    if not isinstance(port, str) or not port.strip() or port.strip().lower() == "auto" or "\x00" in port:
        return "invalid"
    if "://" in port:
        return "url" if _loopback_url(port) else "device"
    if _PTY_RE.match(port) and port in [p for p in env.get("MPY_HARNESS_PTYS", "").split(os.pathsep) if p]:
        return "pty"
    return "device"


def check_guards(port, allow_real, env):
    """Return the port kind or raise GuardError."""
    kind = classify_port(port, env)
    if kind == "invalid":
        raise GuardError("--port %r is not a usable port name (\"auto\" and empty names are refused)" % (port,))
    if kind == "device":
        missing = []
        if not allow_real:
            missing.append("--allow-real-port")
        if env.get("MPY_REAL_PORT", "") != port:
            missing.append("env MPY_REAL_PORT equal to --port")
        if not safe_mode_on(env):
            missing.append("env MPY_SAFE_MODE=1")
        if missing:
            raise GuardError("%r is a REAL device, not a loopback socket:// fake board. Refusing; missing: %s. Nothing was "
                             "spawned or opened." % (port, ", ".join(missing)))
    return kind


# --------------------------------------------------------------------------------------------------- bridge process
class HwBridgeClient(BridgeClient):
    """BridgeClient whose child may receive MPY_REAL_PORT for ONE explicitly guarded run (BridgeClient itself always strips
    it).  Everything else (argv, isolation flags, MPY_SAFE_MODE forced on, reader threads, close()) is the shared client's."""

    def __init__(self, real_port=None, hello_timeout=25.0, default_timeout=DEFAULT_TIMEOUT, fake_env=None):
        self.default_timeout = default_timeout
        self.hello_timeout = hello_timeout
        self.events, self.responses, self.bad_stdout, self.stderr_lines = [], {}, [], []
        self.exit_code = None
        self.shutdown = None
        self._cv = threading.Condition()
        self._wlock = threading.Lock()
        self._lines = 0
        self._next_id = 0
        self._stdout_eof = False
        self._closed = False
        self._close_lock = threading.Lock()
        self._path = BRIDGE_PATH
        self._own_cwd = tempfile.mkdtemp(prefix="bridge-cwd-")
        self.cwd = self._own_cwd
        extra = {"MPY_REAL_PORT": real_port} if real_port else {}
        argv = bridge_argv()
        if fake_env:                    # --fake with phase R: the bridge runs behind fakedriver.py, which registers a line driver
            if real_port:
                raise ValueError("a fake line driver and a real port at the same time")
            extra.update(fake_env)
            argv[-1] = fakedriver.__file__
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     cwd=self.cwd, env=child_env(**extra), shell=False)
        self.pid = self.proc.pid
        self._t_out = threading.Thread(target=self._read_stdout, name="hw-bridge-stdout", daemon=True)
        self._t_err = threading.Thread(target=self._read_stderr, name="hw-bridge-stderr", daemon=True)
        self._t_out.start()
        self._t_err.start()
        self.hello = None
        try:
            self.hello = self.wait_event("hello", timeout=hello_timeout)
        except BaseException:
            self.kill()
            raise


def install_term_handlers():
    """SIGTERM / SIGHUP / SIGBREAK become KeyboardInterrupt so that ``timeout N python run_hw.py`` still runs the cleanup.
    Only in the main thread; returns the previous handlers (or None)."""
    if threading.current_thread() is not threading.main_thread():
        return None
    import signal

    def handler(signum, frame):
        raise KeyboardInterrupt()

    old = {}
    for name in ("SIGTERM", "SIGHUP", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                old[sig] = signal.signal(sig, handler)
            except (ValueError, OSError):
                pass
    return old


def restore_term_handlers(old):
    if old:
        import signal
        for sig, h in old.items():
            try:
                signal.signal(sig, h if h is not None else signal.SIG_DFL)
            except (ValueError, OSError):
                pass


def default_spawn(port, real_port, fake_env=None):
    return HwBridgeClient(real_port=real_port, fake_env=fake_env)


def lsof_holders(port):
    """PIDs that have the device open (macOS / Linux ``lsof -t``).  [] when lsof is not installed (Windows)."""
    if os.name == "nt":
        return []
    try:
        r = subprocess.run(["lsof", "-t", "--", port], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, shell=False)
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(x) for x in r.stdout.decode("ascii", "replace").split() if x.isdigit()]


# --------------------------------------------------------------------------------------------------- text output
def list_phases_text():
    lines = ["Phases and the op classes each may send (nothing is opened by --list-phases):", ""]
    for p in phases.PHASES:
        lines.append("  %s  %-24s classes: %s" % (p.id, p.name, ", ".join(p.classes)))
        lines.append("     %s" % p.summary)
    lines += ["", "Op classes:"]
    for k, v in confine.OP_CLASS_NAMES.items():
        ops = sorted(o for o, c in confine.OP_CLASSES.items() if c == k)
        lines.append("  %-14s %s" % (k, v))
        lines.append("  %-14s ops: %s" % ("", ", ".join(ops)))
    lines += ["", "Reset ops (the reset-* classes) exist only in phase R, behind --allow-resets N (1..5) and env MPY_ALLOW_RESETS=1:",
              "  reset-info    %s" % confine.RESET_CLASS_NAMES["reset-info"],
              "  reset-soft    %s" % confine.RESET_CLASS_NAMES["reset-soft"],
              "  reset-chip    %s" % confine.RESET_CLASS_NAMES["reset-chip"],
              "",
              "Never sent by any phase: reset.soft / reset.hard / any reset op (except in phase R, see above), interrupt:true, force:true,",
              "an openPolicy other than auto, writes outside the scratch folder, inline run source, creating main.py or boot.py.",
              "Phase A always runs first. Default phases: %s (F, the soak, and R, the reset tiers, only when asked for)." % DEFAULT_PHASES]
    return "\n".join(lines)


def plan_text(args, kind, mode, port, cfg, wanted, backup_dir, report_base, budget=0):
    lines = ["mpy-hwtest PLAN (dry run: no bridge spawned, no fake board started, nothing opened, nothing written)",
             "  mode:      %s" % mode,
             "  port:      %s (%s)" % (port, {"url": "loopback fake, no real device", "pty": "registered pty",
                                            "device": "REAL DEVICE: guards satisfied (--allow-real-port, MPY_REAL_PORT, MPY_SAFE_MODE)",
                                            "fake": "started in-process by the harness"}.get(kind, kind)),
             "  open:      connect with openPolicy auto only (the bridge picks the reset-free default open)",
             "  config:    %s" % (cfg.source or "none (defaults)"),
             "  scratch:   %s (the only place the board is written; removed at the end)" % cfg.scratch,
             "  backups:   %s -> %s/<UTC timestamp>/ (downloaded before the first write, re-verified at the end)" % (
                 cfg.backup_files or "none", backup_dir),
             "  expect:    %s" % (cfg.expect or "nothing"),
             "  probes:    tripwire (time.ticks_ms + reset_cause) before/after every phase and after every Stop/Run; extra: %s" % (
                 [p["name"] for p in cfg.extra_probes] or "none"),
             "  report:    %s/<UTC timestamp>/report.json + console.txt (folder created and test-written before anything starts)" % report_base,
             "  budget:    %g minutes for the whole run, then a 90 s cleanup budget" % args.max_minutes,
             "  phases (in order):"]
    for pid in wanted:
        spec = [p for p in phases.PHASES if p.id == pid][0]
        lines.append("    %s  %-22s may send: %s" % (spec.id, spec.name, ", ".join(spec.classes)))
    if budget:
        capped = " (the config's allow_resets caps it; --allow-resets was %d)" % args.allow_resets if budget != args.allow_resets else ""
        lines += ["  RESETS:    phase R is ON: chip resets budget %d%s (hard cap %d); soft reset at most once; env MPY_ALLOW_RESETS=1 present" % (
                      budget, capped, confine.RESET_BUDGET_MAX),
                  "             plan: R0 baseline (backups by hash, manifest, tripwire in reset-expected mode), R1 capability, R2 soft x1,",
                  "             R3 machine x2, R4 hard with verify then hard (only if hard.state is verified/likely; never forced), R5 final checks",
                  "             each reset is announced 'RESET i/N: <tier> (a motor may twitch)', %g s pass, then ONE request; the (N+1)-th chip reset"
                  % resetphase.ANNOUNCE_WAIT_S,
                  "             is refused; the board must be back within %g s; the first surprise stops all resets (exit 5), no fs writes in R" % resetphase.RECOVER_S,
                  "             budget units: machine 1, hard 1, hard WITH verify %d (the bridge may pulse the lines twice); a step that does not fit is skipped"
                  % confine.HARD_VERIFY_PULSES]
    lines += ["  cleanup:   stop harness program, remove scratch, verify backups, disconnect, re-check idle + no scratch, end bridge",
              "  refuses:   reset ops%s, interrupt/force flags, other openPolicy, writes outside scratch, main.py/boot.py, shadowing names"
              % (" (outside phase R and its budget)" if budget else ""),
              "  exit:      0 pass, 1 fail/residue, 2 guard refusal, 3 TRIPPED, 4 phase A refusal, 5 RESET PHASE ABORTED, 130 interrupted",
              "dry run OK: exit 0"]
    return "\n".join(lines)


def build_parser():
    p = argparse.ArgumentParser(prog="run_hw.py", description="Generic hardware test harness for the mpy bridge.",
                                allow_abbrev=False)          # explicit flags only: --allow-res can never stand in for --allow-resets
    p.add_argument("--port", help="device path, COMn, or a loopback socket:// URL")
    p.add_argument("--config", help="hwtest config JSON (board specifics live there)")
    p.add_argument("--phases", default=DEFAULT_PHASES, help="comma list from A,B,C,D,E,F,R (A always runs first; R = reset tiers, "
                   "needs --allow-resets and env MPY_ALLOW_RESETS=1, never a default)")
    p.add_argument("--allow-resets", type=int, default=0, metavar="N",
                   help="chip reset budget of phase R, 1..%d (default 0 = no reset is ever sent); also needs env MPY_ALLOW_RESETS=1"
                   % confine.RESET_BUDGET_MAX)
    p.add_argument("--fake", metavar="PROFILE", help="run against tools.fakeboard.FakeBoard with this profile")
    p.add_argument("--fake-fault", action="append", default=[], metavar="NAME", help="fake board fault (only with --fake)")
    p.add_argument("--allow-real-port", action="store_true", help="required (with env MPY_REAL_PORT) for a real device")
    p.add_argument("--report", metavar="DIR", help="reports base folder (default tools/hwtest/reports)")
    p.add_argument("--backup-dir", metavar="DIR", help="backup base folder (default tools/hwtest/backup)")
    p.add_argument("--max-minutes", type=float, default=DEFAULT_MAX_MINUTES, metavar="N",
                   help="overall time budget of the run in minutes (default %g); the cleanup gets 90 s more" % DEFAULT_MAX_MINUTES)
    p.add_argument("--dry-run", action="store_true", help="validate guards and config, print the plan, exit 0")
    p.add_argument("--list-phases", action="store_true", help="print the phases and what each may send; open nothing")
    return p


def _unique_dir(base, stamp):
    path = os.path.join(base, stamp)
    n = 1
    while os.path.exists(path):
        n += 1
        path = os.path.join(base, "%s-%d" % (stamp, n))
    return path


# --------------------------------------------------------------------------------------------------- main
def main(argv=None, spawn=None, environ=None, stdout=None, test_hooks=None, lsof=None):
    """Entry point.  ``spawn(port, real_port) -> client`` and ``lsof(port) -> [pid]`` are injectable (tests); ``test_hooks`` may
    hold ``on_board(fake_board)``, ``after_phase(pid, fake_board)``, ``on_send(op, args)``, ``before_stop(fake_board)``, ``stop_bound_ms`` and
    ``soak`` = (cycles, ops)."""
    argv = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if environ is None else environ
    out = sys.stdout if stdout is None else stdout
    hooks = test_hooks or {}

    def say(text):
        out.write(text + "\n")
        out.flush()

    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2
    if args.list_phases:
        say(list_phases_text())
        return 0
    try:
        wanted = _parse_phases(args.phases)
        if args.fake_fault and not args.fake:
            raise GuardError("--fake-fault needs --fake")
        if not 0.5 <= args.max_minutes <= 240:
            raise GuardError("--max-minutes must be between 0.5 and 240")
        if args.fake and args.port:
            raise GuardError("use either --fake PROFILE or --port, not both")
        if args.fake:
            from tools import fakeboard
            if args.fake not in fakeboard.list_profiles():
                raise GuardError("unknown fake profile %r (known: %s)" % (args.fake, ", ".join(fakeboard.list_profiles())))
            kind, port, mode = "fake", None, "fake:%s" % args.fake
        else:
            if not args.port:
                raise GuardError("--port is required unless --fake PROFILE is given")
            kind = check_guards(args.port, args.allow_real_port, env)
            port, mode = args.port, {"url": "url", "pty": "pty", "device": "real"}[kind]
        try:
            cfg = load_config(args.config)
        except ConfigError as exc:
            raise GuardError(str(exc))
        budget = resolve_reset_budget(args, wanted, cfg, env)
    except GuardError as exc:
        say("REFUSED: %s" % exc)
        return 2
    report_base = os.path.abspath(args.report) if args.report else DEFAULT_REPORTS
    backup_base = os.path.abspath(args.backup_dir) if args.backup_dir else DEFAULT_BACKUP
    if args.dry_run:
        say(plan_text(args, kind, mode, port or "(fake board socket URL, chosen at start)", cfg, wanted, backup_base, report_base, budget))
        return 0
    return _run_live(args, kind, mode, port, cfg, wanted, report_base, backup_base, argv, env, out,
                     spawn or default_spawn, lsof, hooks, budget)


def resolve_reset_budget(args, wanted, cfg, env):
    """0 when phase R was not requested, else the effective chip reset budget (1..5); GuardError (exit 2) if ANY gate is missing.
    The command line raises the budget from its default of 0, the config can only lower it, never raise it."""
    n = args.allow_resets
    if "R" not in wanted:
        if n:
            raise GuardError("--allow-resets %d was given but phase R was not requested (--phases A,R); refusing to guess" % n)
        return 0
    if not 1 <= n <= confine.RESET_BUDGET_MAX:
        raise GuardError("phase R needs --allow-resets N with 1 <= N <= %d (the default 0 means no reset is ever sent), got %d"
                         % (confine.RESET_BUDGET_MAX, n))
    if env.get("MPY_ALLOW_RESETS") != "1":
        raise GuardError("phase R needs the environment variable MPY_ALLOW_RESETS=1 (exactly \"1\"); it is %s"
                         % ("not set" if "MPY_ALLOW_RESETS" not in env else "%r" % env.get("MPY_ALLOW_RESETS")))
    cap = cfg.allow_resets
    if cap is not None and cap < 1:
        raise GuardError("the config (%s) forbids resets (allow_resets=false/0); a config can only lower the budget" % (cfg.source or "-"))
    return n if cap is None else min(n, cap)


def _parse_phases(text):
    chosen = set()
    for part in str(text).split(","):
        part = part.strip().upper()
        if not part:
            continue
        if part not in phases.PHASE_IDS:
            raise GuardError("unknown phase %r (known: %s)" % (part, ",".join(phases.PHASE_IDS)))
        chosen.add(part)
    chosen.add("A")
    return [p for p in phases.PHASE_IDS if p in chosen]


def _run_live(args, kind, mode, port, cfg, wanted, report_base, backup_base, argv, env, out, spawn, lsof, hooks, budget=0):
    console = Console(out)
    stamp = utc_stamp()
    report_dir = _unique_dir(report_base, stamp)
    report = Report(mode, port or "(fake)", argv, wanted, cfg.as_dict())
    try:                                                    # no hardware run without a place for its report (CLAUDE.md item 8)
        os.makedirs(report_dir)
        probe_file = os.path.join(report_dir, ".writable")
        with open(probe_file, "w", encoding="utf-8") as f:
            f.write("ok\n")
        os.remove(probe_file)
    except OSError as exc:
        console.line("REFUSED: the report folder %s cannot be written (%s); nothing was started" % (report_dir, exc))
        return 2
    tmp = tempfile.mkdtemp(prefix="mpyhw (run) ")           # spaces and parentheses on purpose (tracebacks cite this path)
    backup_dir = os.path.join(backup_base, os.path.basename(report_dir))
    board = client = ctx = raw = pulse_srv = None
    gate = confine.ResetGate(budget) if budget else None        # None: every reset op is refused for the whole run
    if gate is not None:
        report.data["reset"] = resetphase.new_report(budget)
    budget_s = hooks.get("max_s", args.max_minutes * 60.0)
    old_handlers = install_term_handlers()
    exit_code, outcome = 1, "ERROR"
    reverify = True
    tripped = None
    console.line("mpy-hwtest start: mode=%s phases=%s scratch=%s" % (mode, ",".join(wanted), cfg.scratch))
    try:
        try:
            if kind == "fake":
                from tools.fakeboard import FakeBoard
                try:
                    board = FakeBoard(profile=args.fake, faults=list(args.fake_fault))
                except (ValueError, KeyError) as exc:
                    console.line("REFUSED: fake board: %s" % exc)
                    return _finish(report, console, report_dir, "REFUSED", 2, tmp, None, None)
                board.start()
                dev = getattr(board, "device", None)
                if dev is not None and hasattr(dev, "t_power") and "reset_on_connect" not in args.fake_fault:
                    dev.t_power -= FAKE_UPTIME_S        # (that fault is a soft reset at connect; only a young board shows it)
                if hooks.get("on_board"):
                    hooks["on_board"](board)
                if gate is not None:                    # the bridge child gets a stand-in for DTR/RTS, so a hard reset can be rehearsed
                    pulse_srv = fakedriver.PulseServer(board)
                port = board.url
                report.data["port"] = port
            holders = (lsof or lsof_holders) if kind == "device" else None
            if holders is not None:
                held = holders(port)
                if held:
                    raise phases.Refuse("pid(s) %s already hold %s; close Thonny / Arduino / other VS Code windows first" % (held, port))
            session_t0 = time.monotonic()
            if pulse_srv is not None and spawn is default_spawn:
                raw = default_spawn(port, None, fake_env=pulse_srv.child_env())
            else:
                raw = spawn(port, port if kind == "device" else None)
            store_dir = os.path.join(tmp, "programs")
            store = confine.ProgramStore(store_dir, cfg.shadow_names)
            probe_codes = [TRIP_PROBE] + [confine.validate_probe_code(p["code"], cfg.shadow_names, cfg.probe_modules)
                                          for p in cfg.extra_probes]
            policy = confine.Policy(cfg.scratch, port, backup_remote=cfg.backup_files, local_read_roots=[tmp],
                                    local_write_roots=[tmp, backup_dir], shadow_names=cfg.shadow_names,
                                    probe_codes=probe_codes, programs=store, on_send=hooks.get("on_send"), reset_gate=gate)
            client = confine.ConfinedClient(raw, policy)
            client.set_deadline(budget_s)
            report.data["bridge"]["pid"] = getattr(raw, "pid", None)
            trip = Tripwire(client, cfg.extra_probes, session_t0=session_t0,
                            log=lambda m: console.line(m, tag="trip"))
            ctx = phases.Ctx(client, trip, cfg, store, tmp, backup_dir, console, report, port, fake_board=board,
                             stop_bound_ms=hooks.get("stop_bound_ms", 1000 if kind == "fake" else 200),
                             port_holders=holders, bridge_pid=getattr(raw, "pid", None))
            report.data["scratch"]["path"] = cfg.scratch
            ctx.reset_wait_s = hooks.get("reset_wait_s", ctx.reset_wait_s)
            ctx.reset_recover_s = hooks.get("reset_recover_s", ctx.reset_recover_s)
            ctx.soak_cycles, ctx.soak_ops = hooks.get("soak", (ctx.soak_cycles, ctx.soak_ops))
            exit_code, outcome = 0, "PASS"
            for i, pid in enumerate(wanted):
                res = phases.execute_phase(ctx, pid)
                if hooks.get("after_phase"):
                    hooks["after_phase"](pid, board)
                if res["status"] != "pass":
                    exit_code, outcome = 1, "FAIL"
                    for rest in wanted[i + 1:]:
                        report.data["phases"].append({"id": rest, "name": rest, "status": "skipped", "checks": [], "metrics": {},
                                                      "classes": [], "elapsed_s": 0.0})
                    break
        except phases.LostBoard as exc:
            reasons = ["the board was lost after a good baseline: %s" % exc]
            exit_code, outcome, reverify, tripped = 3, "TRIPPED", False, TripwireTripped(reasons, ctx.phase_id if ctx else "?")
            report.data["trip"] = {"label": tripped.label, "reasons": reasons}
            console.line("!!! TRIPPED !!! %s" % tripped)
        except phases.ResetAbort as exc:
            exit_code, outcome, reverify = 5, "RESET_ABORTED", False
            console.line("RESET PHASE ABORTED: %s (no further reset was sent; running the cleanup)" % exc.reason)
        except phases.Refuse as exc:
            exit_code, outcome, reverify = 4, "REFUSED", False
            report.data["refused"] = {"phase": ctx.phase_id if ctx else "A", "reason": str(exc)}
            console.line("REFUSED (board left alone): %s" % exc)
        except TripwireTripped as exc:
            exit_code, outcome, reverify, tripped = 3, "TRIPPED", False, exc
            report.data["trip"] = {"label": exc.label, "reasons": exc.reasons}
            console.line("!!! TRIPPED !!! %s" % exc)
        except ProbeFailed as exc:
            if ctx is not None and ctx.trip.baseline_reading is not None:
                # the safety net went blind AFTER a good baseline (typically a reset: the port re-enumerated): not "board left alone"
                reasons = ["the tripwire went blind after a good baseline: %s" % exc]
                exit_code, outcome, reverify, tripped = 3, "TRIPPED", False, TripwireTripped(reasons, ctx.phase_id)
                report.data["trip"] = {"label": ctx.phase_id, "reasons": reasons}
                console.line("!!! TRIPPED !!! %s" % tripped)
            else:
                exit_code, outcome, reverify = 4, "REFUSED", False
                report.data["refused"] = {"phase": ctx.phase_id if ctx else "A", "reason": "tripwire unavailable: %s" % exc}
                console.line("REFUSED: tripwire unavailable: %s" % exc)
        except confine.DeadlineExceeded as exc:
            exit_code, outcome, reverify = 1, "ERROR", False
            console.line("ERROR: the time budget of %.0f s is used up (%s); running the cleanup" % (budget_s, exc))
        except KeyboardInterrupt:
            exit_code, outcome, reverify = 130, "INTERRUPTED", False
            console.line("INTERRUPTED: running the cleanup")
        except BridgeGone as exc:
            exit_code, outcome, reverify = 1, "ERROR", False
            console.line("ERROR: the bridge went away: %s" % exc)
        except Exception as exc:                                  # noqa: BLE001 - the report must still be written
            exit_code, outcome, reverify = 1, "ERROR", False
            console.line("ERROR: %s: %s" % (type(exc).__name__, exc))
            for ln in traceback.format_exc().splitlines()[-8:]:
                console.line(ln, tag="trace")
    finally:
        residue = []
        try:
            if ctx is not None:
                residue = phases.cleanup(ctx, reverify=reverify)
                if ctx.report.data["trip"] and outcome not in ("TRIPPED", "RESET_ABORTED"):
                    exit_code, outcome = 3, "TRIPPED"
                _fill_report(report, ctx, client)
        except KeyboardInterrupt:
            residue.append("cleanup interrupted by Ctrl-C")
        except Exception as exc:                                  # noqa: BLE001
            residue.append("cleanup failed: %s: %s" % (type(exc).__name__, exc))
        if ctx is not None and ctx.scratch_created and not report.data["scratch"].get("removed") \
                and not any("scratch" in r for r in residue):
            residue.append("scratch folder %s may still be on the board (the cleanup did not confirm its removal)" % cfg.scratch)
        closer = client if client is not None else raw          # a failure between spawn() and the client must not leak the bridge
        if closer is not None:
            try:
                closer.close()
            except Exception as exc:                              # noqa: BLE001
                residue.append("bridge close failed: %s" % exc)
            mode_ = client.shutdown_mode if client is not None else getattr(raw, "shutdown", None)
            report.data["bridge"].update(shutdown=mode_, exit_code=getattr(closer, "exit_code", None))
            if mode_ == "kill":
                residue.append("the bridge had to be killed (did not exit on stdin EOF)")
        if board is not None:
            try:
                if hooks.get("before_stop"):
                    hooks["before_stop"](board)
                board.stop()
            except Exception as exc:                              # noqa: BLE001
                residue.append("fake board stop failed: %s" % exc)
        if pulse_srv is not None:
            pulse_srv.close()
    restore_term_handlers(old_handlers)
    report.data["residue"] = residue
    if residue:
        console.line("RESIDUE: " + "; ".join(residue), tag="!!!")
        if exit_code == 0:
            exit_code, outcome = 1, "FAIL"
    return _finish(report, console, report_dir, outcome, exit_code, tmp, ctx, tripped)


def _fill_report(report, ctx, client):
    d = report.data
    trip = ctx.trip
    d["tripwire"]["baseline"] = trip.baseline_reading.as_dict() if trip.baseline_reading else None
    d["tripwire"]["readings"] = [r.as_dict() for r in trip.readings]
    d["tripwire"]["trips"] = trip.trips
    counts = {}
    errors = {}
    for e in client.log:
        if not e["ok"]:
            errors[(e["op"], e["code"])] = errors.get((e["op"], e["code"]), 0) + 1
    d["ops"] = {"total": len(client.log), "by_class": dict(client.class_counts),
                "errors": [{"op": k[0], "code": k[1], "n": v} for k, v in sorted(errors.items(), key=str)],
                "log": client.log[-5000:]}


def _finish(report, console, report_dir, outcome, exit_code, tmp, ctx, tripped):
    report.finish(outcome, exit_code)
    if outcome == "TRIPPED":
        report.data["trip"] = report.data["trip"] or {"label": "?", "reasons": []}
    console.line("RESULT: %s (exit %d)  report: %s" % ("RESET PHASE ABORTED" if outcome == "RESET_ABORTED" else outcome, exit_code,
                                                         report_dir))
    try:
        report.write(report_dir, console)
    except OSError as exc:
        console.line("could not write the report: %s" % exc)
        if exit_code == 0:                                      # an unwritten report must not look like a clean pass
            exit_code = 1
            console.line("RESULT: FAIL (exit 1): the run passed but its report could not be written")
    shutil.rmtree(tmp, ignore_errors=True)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
