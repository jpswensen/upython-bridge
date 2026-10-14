"""phases.py - phases A-F and the cleanup (docs/hwtest-plan.md "Phases", "Cleanup").

Every phase is a function ``phase_x(ctx)`` that records checks with ``ctx.expect`` and talks to the bridge ONLY through
``ctx.client`` (a ``confine.ConfinedClient``).  ``PHASES`` lists, per phase, the op classes it may send; the policy enforces
that list while the phase runs and ``run_hw.py --list-phases`` prints it.
"""
from __future__ import annotations

import base64
import hashlib
import os
import random
import shutil
import threading
import time
import unicodedata

from tests.bridge_client import BridgeCallError, BridgeGone, BridgeTimeout
from tests.support import wait_until
from tools.hwtest import confine, resetphase
from tools.hwtest.programs import BIG_LINE, BIG_LINES, BIG_OUTPUT_BYTES, PROGRAMS
from tools.hwtest.tripwire import ProbeFailed, TripwireTripped

__all__ = ["PHASES", "PHASE_IDS", "Ctx", "Refuse", "LostBoard", "ResetAbort", "execute_phase", "cleanup", "compare_expect", "CLEANUP_BUDGET_S"]

ResetAbort = resetphase.ResetAbort          # raised by phase R on its first surprise (run_hw.py: cleanup, exit code 5)
CLEANUP_BUDGET_S = 90.0         # the whole cleanup (all steps together) may take this long, then it gives up and reports residue


class Refuse(Exception):
    """The harness refuses to continue and leaves the board alone (exit code 4)."""


class LostBoard(Refuse):
    """The board vanished or is no longer at a prompt AFTER a good tripwire baseline: that is a suspected reset (exit code 3)."""


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _nfc(s):
    return unicodedata.normalize("NFC", s)


def compare_expect(ident, expect):
    """List of mismatches between the bridge's ``identity`` result and the config's ``expect`` block."""
    problems = []
    if "impl" in expect and ident.get("impl") != expect["impl"]:
        problems.append("impl is %r, expected %r" % (ident.get("impl"), expect["impl"]))
    if "build" in expect and ident.get("build") != expect["build"]:
        problems.append("build is %r, expected %r" % (ident.get("build"), expect["build"]))
    if "version_min" in expect:
        have = tuple(ident.get("version") or ())[:3]
        if tuple(have) < tuple(expect["version_min"]):
            problems.append("version is %s, expected at least %s" % (list(have), list(expect["version_min"])))
    return problems


def stream_arrival(client, kind, needle, since):
    """Monotonic arrival time of the event in which ``needle`` first appears in the ``kind`` stream (None if absent)."""
    acc = b""
    for e in client.events_of(kind, since):
        acc += base64.b64decode(e.get("b64", ""))
        if needle in acc:
            return e["_t"]
    return None


class Ctx(object):
    """Everything a phase needs.  Created by run_hw.py; tests may build one around a stub."""

    def __init__(self, client, trip, cfg, store, tmp, backup_dir, console, report, port, fake_board=None,
                 stop_bound_ms=200, port_holders=None, bridge_pid=None):
        self.client, self.trip, self.cfg, self.store = client, trip, cfg, store
        self.tmp, self.backup_dir, self.console, self.report = tmp, backup_dir, console, report
        self.port, self.board = port, fake_board
        self.fake = fake_board is not None
        self.stop_bound_ms = stop_bound_ms
        self.port_holders = port_holders
        self.bridge_pid = bridge_pid
        self.scratch = cfg.scratch
        self.scratch_created = False
        self.scratch_ready = False
        self.backups = []
        self.backups_taken = False
        self.program_started = False
        self.connected = False
        self.hash_kind = "sha256"
        self.caps = {}
        self.ident = {}
        self.phase_id = "-"
        self.checks = []
        self.metrics = {}
        self.files_dir = os.path.join(tmp, "files")
        self.back_dir = os.path.join(tmp, "downloads")
        for d in (self.files_dir, self.back_dir):
            os.makedirs(d, exist_ok=True)
        self._seq = 0
        self.soak_cycles = 20
        self.soak_ops = 50          # iterations of (put, stat, get, rm) = 4 ops each: 200 small ops
        self.reset_wait_s = resetphase.ANNOUNCE_WAIT_S      # phase R: pause between a reset's announcement and its request
        self.reset_recover_s = resetphase.RECOVER_S         # phase R: the board must be back this long after the request
        self.board_lost = False                             # phase R aborted because the board did not come back
        self.reset_abort = None

    # ---- recording
    def log(self, msg):
        self.console.line(msg, tag=self.phase_id)

    def expect(self, name, ok, detail=""):
        ok = bool(ok)
        self.checks.append({"name": name, "ok": ok, "detail": str(detail)[:600]})
        self.console.line(("ok   " if ok else "FAIL ") + name + ((" - %s" % (detail,)) if detail and (not ok or len(str(detail)) < 70) else ""),
                          tag=self.phase_id)
        return ok

    def metric(self, name, value):
        self.metrics[name] = value

    def guard(self, name, fn, *args, **kw):
        """Run ``fn``; a bridge/confinement error becomes a failed check and returns None."""
        try:
            return fn(*args, **kw)
        except (BridgeCallError, confine.ConfinementError, BridgeTimeout) as exc:
            self.expect(name, False, exc)
            return None

    # ---- bridge helpers
    def call(self, op, timeout=None, **args):
        if timeout is None:
            timeout = 300.0 if op in ("fs.put", "fs.get", "run", "fs.manifest") else 60.0
        return self.client.call(op, _timeout=timeout, **args)

    def state(self):
        s = self.client.states()
        return s[-1] if s else None

    def await_idle(self, timeout=10.0):
        try:
            wait_until(lambda: self.state() == "idle", timeout, "state idle")
            return True
        except AssertionError:
            return False

    def connect(self):
        """connect (default open) and demand state idle + sync prompt; otherwise Refuse (nothing else is sent)."""
        end = time.monotonic() + (8.0 if self.fake else 0.0)
        while True:
            resp = self.client.request("connect", _timeout=60.0, port=self.port)
            if resp.get("ok"):
                break
            err = resp.get("error") or {}
            if self.fake and err.get("code") in ("E_NO_DEVICE", "E_PORT_BUSY") and time.monotonic() < end:
                try:
                    wait_until(lambda: self.board.connected == 0, 2.0, "the fake board to release the last client")
                except AssertionError:
                    pass
                continue
            raise (LostBoard if self.trip.baseline_reading is not None else Refuse)(
                "connect failed%s: %s: %s" % (" after a good tripwire baseline (the board re-enumerated or was reset?)"
                                              if self.trip.baseline_reading is not None else "", err.get("code"), err.get("message")))
        self.connected = True
        if resp.get("state") != "idle" or resp.get("sync") != "prompt":
            raise (LostBoard if self.trip.baseline_reading is not None else Refuse)(
                "the board is not at an idle friendly prompt after connect (state=%r sync=%r); the harness leaves it "
                "alone (no Ctrl-C, no interrupt)" % (resp.get("state"), resp.get("sync")))
        return resp

    def disconnect(self):
        r = self.call("disconnect")
        self.connected = False
        return r

    def check_port_free(self, label):
        """Real devices only: nobody except our own bridge may hold the port (CLAUDE.md, hardware authorization item 6)."""
        if self.port_holders is None:
            return
        holders = self.port_holders(self.port)
        others = [h for h in holders if h != self.bridge_pid]
        if others:
            raise Refuse("%s: process(es) %s hold the port besides the bridge; close them first" % (label, others))

    # ---- backups and scratch
    def ensure_backups(self):
        """Download the backup files to the host BEFORE the first write (once)."""
        if self.backups_taken:
            return
        self.backups_taken = True
        for name in self.cfg.backup_files:
            rec = {"name": name, "status": "absent", "bytes": 0, "sha256": None, "local": None, "verified_unchanged": None}
            self.backups.append(rec)
            self.report.data["backups"] = self.backups
            try:
                st = self.call("fs.stat", path=name)
                if not st.get("exists"):
                    continue
                local = os.path.join(self.backup_dir, name.strip("/").replace("/", "__"))
                os.makedirs(self.backup_dir, exist_ok=True)
                r = self.call("fs.get", remote=name, local=local)
                with open(local, "rb") as f:
                    data = f.read()
                host = _sha(data)
                if r.get("sha256") not in (None, host) or r.get("bytes") not in (None, len(data)):
                    raise Refuse("backup of %s is inconsistent (bridge says %s/%s, host has %s/%d)"
                                 % (name, r.get("bytes"), r.get("sha256"), len(data), host))
                rec.update(status="saved", bytes=len(data), sha256=host, local=local)
            except (BridgeCallError, BridgeTimeout, confine.ConfinementError, OSError) as exc:
                raise Refuse("cannot back up %s before the first write: %s" % (name, exc))
        self.expect("backup files saved on the host before the first write", True,
                    ", ".join("%s=%s" % (b["name"], b["status"]) for b in self.backups) or "no backup files configured")

    def ensure_scratch(self):
        if self.scratch_ready:
            return
        self.ensure_backups()
        st = self.call("fs.stat", path=self.scratch)
        if st.get("exists"):
            raise Refuse("the scratch folder %s already exists on the board (left by an earlier run?); the harness will not "
                         "touch or delete a folder it did not create in this run" % self.scratch)
        self.scratch_created = True
        self.call("fs.mkdir", path=self.scratch)
        self.scratch_ready = True
        self.report.data["scratch"].update(path=self.scratch, created=True)

    def remove_scratch(self):
        if not self.scratch_created:
            return True
        st = self.call("fs.stat", path=self.scratch)
        if st.get("exists"):
            self.call("fs.rmtree", path=self.scratch)
        gone = not self.call("fs.stat", path=self.scratch).get("exists")
        self.scratch_ready = not gone
        self.report.data["scratch"].update(removed=gone, residue=not gone)
        return gone

    def verify_backups(self):
        """Backup files on the board still equal the host copies (or are still absent)."""
        bad = []
        for rec in self.backups:
            try:
                st = self.call("fs.stat", path=rec["name"])
                if rec["status"] == "absent":
                    same = not st.get("exists")
                else:
                    local = os.path.join(self.back_dir, "verify-" + os.path.basename(rec["local"]))
                    self.call("fs.get", remote=rec["name"], local=local)
                    with open(local, "rb") as f:
                        same = _sha(f.read()) == rec["sha256"]
                rec["verified_unchanged"] = bool(same)
                if not same:
                    bad.append(rec["name"])
            except (BridgeCallError, BridgeTimeout, confine.ConfinementError, OSError) as exc:
                rec["verified_unchanged"] = None
                bad.append("%s (%s)" % (rec["name"], exc))
        return bad

    # ---- files
    def local_file(self, data, hint="f"):
        self._seq += 1
        path = os.path.join(self.files_dir, "%s%04d.dat" % (hint, self._seq))
        with open(path, "wb") as f:
            f.write(data)
        return path

    def put(self, data, remote, **kw):
        local = self.local_file(data)
        t0 = time.monotonic()
        r = self.call("fs.put", local=local, remote=remote, **kw)
        return r, local, time.monotonic() - t0

    def get_bytes(self, remote):
        local = os.path.join(self.back_dir, "g%04d.dat" % (self._seq + 1))
        self._seq += 1
        r = self.call("fs.get", remote=remote, local=local)
        with open(local, "rb") as f:
            return r, f.read()

    def run_program(self, prog, timeout=120.0):
        self.program_started = True
        self.trip.note_program_run()
        return self.call("run", timeout=timeout, local=prog.path)

    def record_extras(self, label):
        snap = self.trip.extras_snapshot(label)
        if snap["values"]:
            self.report.data["tripwire"]["extras"].append(snap)

    def after_run(self, label):
        idle = self.await_idle()
        self.expect("state returns to idle after %s" % label, idle, "state=%s" % self.state())
        self.trip.check("after %s" % label)
        self.record_extras("after %s" % label)


# ===================================================================================================== phase A
def phase_a(ctx):
    ports = ctx.call("ports.list").get("ports", [])
    ctx.expect("ports.list answers without opening a port", True, "%d port(s) listed" % len(ports))
    ctx.metric("ports_listed", len(ports))
    if ctx.cfg.shadow_names:
        ctx.call("config", shadowGuard=list(ctx.cfg.shadow_names))
    resp = ctx.connect()
    ctx.expect("connect: state idle, sync prompt", True, "state=%s sync=%s kind=%s" % (
        resp.get("state"), resp.get("sync"), (resp.get("portInfo") or {}).get("kind")))
    base = ctx.trip.baseline()
    ctx.expect("tripwire baseline taken", True, "ticks_ms=%d reset_cause=%d" % (base.ticks, base.cause))
    ident = ctx.call("identity")
    ctx.ident = ident
    ctx.caps = ident.get("caps") or {}
    ctx.hash_kind = (ctx.caps.get("hash") or "none")
    ctx.report.data["identity"] = {k: ident.get(k) for k in ("impl", "version", "machine", "build", "mpy", "platform", "uname",
                                                              "uniqueId", "caps", "profileHints")}
    ctx.expect("identity read", bool(ident.get("impl")), "%s %s build=%r hash=%s compile=%s" % (
        ident.get("impl"), ".".join(str(x) for x in (ident.get("version") or [])), ident.get("build"),
        ctx.hash_kind, ctx.caps.get("compile")))
    problems = compare_expect(ident, ctx.cfg.expect)
    if problems:
        ctx.expect("identity matches the config expectations", False, "; ".join(problems))
        raise Refuse("this is not the expected board: " + "; ".join(problems))
    if ctx.cfg.expect:
        ctx.expect("identity matches the config expectations", True, str(ctx.cfg.expect))
    man = ctx.call("fs.manifest", root="/", hash=True)
    ctx.hash_kind = man.get("hash") or ctx.hash_kind
    entries = man.get("entries") or []
    ctx.report.data["identity"]["root_manifest"] = [
        {"path": e.get("path"), "type": e.get("type"), "size": e.get("size"), "sha256": e.get("sha256")} for e in entries][:500]
    ctx.expect("fs.manifest / (read-only)", man.get("truncated") is False,
               "%d entries, hash=%s" % (len(entries), man.get("hash")))
    for i in range(1, 4):
        ctx.disconnect()
        ctx.connect()
        ctx.trip.check("reconnect %d" % i)
        ctx.expect("disconnect/connect cycle %d: idle, prompt, tripwire quiet" % i, True)


# ===================================================================================================== phase B
def phase_b(ctx):
    c = ctx.client
    ctx.ensure_scratch()
    S = ctx.scratch
    rng = random.Random(1013)
    files = [("zero.bin", b""), ("one.bin", b"\x00"), ("4k.bin", rng.randbytes(4096)), ("100k.bin", rng.randbytes(100 * 1024)),
             ("all-bytes.bin", bytes(range(256)))]
    weird = ["with space.txt", "paren (1) [2].txt", "it's quoted.txt", u"unicode-éñπ-日.txt",
             "long-" + "n" * 100 + ".txt", ".hidden-name"]
    for i, name in enumerate(weird):
        files.append((name, ("weird name %d\n" % i).encode("utf-8") * 3))
    expected = {}
    locals_ = {}
    for name, data in files:
        remote = S + "/" + name
        detail = ""
        ok = False
        try:
            r, local, dt = ctx.put(data, remote)
            st = ctx.call("fs.stat", path=remote)
            _g, back = ctx.get_bytes(remote)
            ok = (r.get("bytes") == len(data) and r.get("sha256") in (None, _sha(data)) and st.get("exists")
                  and st.get("type") == "file" and st.get("size") == len(data) and back == data)
            detail = "put %d B in %.2fs (%s), stat size %s" % (len(data), dt, r.get("verified"), st.get("size"))
            expected[remote] = data
            locals_[name] = local
            if name == "100k.bin" and dt > 0:
                ctx.metric("put_100k_bytes_per_s", int(len(data) / dt))
        except (BridgeCallError, BridgeTimeout, confine.ConfinementError) as exc:
            detail = str(exc)
        ctx.expect("put/stat/get round trip %r (%d B)" % (name if len(name) < 30 else name[:20] + "...", len(data)), ok, detail)
    # expectSha
    if ctx.hash_kind == "sha256":
        data4k = dict(files)["4k.bin"]
        r = ctx.guard("expectSha skip", ctx.call, "fs.put", local=locals_["4k.bin"], remote=S + "/4k.bin", expectSha=_sha(data4k))
        ctx.expect("expectSha skips an unchanged upload", bool(r) and r.get("skipped") is True and r.get("sent") == 0, r)
        r = ctx.guard("stale expectSha", ctx.call, "fs.put", local=locals_["4k.bin"], remote=S + "/4k.bin", expectSha="0" * 64)
        ctx.expect("a stale expectSha never skips", bool(r) and r.get("skipped") is False, r)
    else:
        ctx.expect("expectSha skip", True, "n/a: the board has no sha256 (hash=%s); compared by size" % ctx.hash_kind)
    # move
    src, dst = S + "/with space.txt", S + "/moved (renamed).txt"
    ctx.call("fs.mv", src=src, dst=dst)
    expected[dst] = expected.pop(src)
    ok = (not ctx.call("fs.stat", path=src).get("exists")) and ctx.call("fs.stat", path=dst).get("size") == len(expected[dst])
    ctx.expect("fs.mv within scratch", ok)
    # shadow / confinement refusals: asked of the POLICY only (never sent, not even to be refused by it: if the one guard ever
    # failed open, a live self-test would put these requests on the real board)
    sent_before = c.sent
    probe_local = ctx.local_file(b"harness\n")
    bad = ["/machine.py", "/os.py", "/main.py", "/boot.py", "/lib/time.py", S + "/main.py", S + "/boot.py", S + "/MAIN.PY",
           S + "/../boot.py", S + "/../../x.txt", "/x.txt", S + "x/a.txt", S.upper() + "/a.txt"]
    bad += ["/%s.py" % n for n in ctx.cfg.shadow_names]
    refused = 0
    checks = [("fs.put", {"local": probe_local, "remote": path}) for path in bad]
    checks += [("fs.rm", {"path": "/boot.py"}), ("fs.rmtree", {"path": "/"}), ("fs.mkdir", {"path": "/zz"}),
               ("fs.mv", {"src": S + "/one.bin", "dst": "/one.bin"}), ("fs.get", {"remote": "/other.py", "local": probe_local})]
    for op, args in checks:
        try:
            c.policy.check(op, args)
        except confine.ConfinementError:
            refused += 1
    ctx.expect("writes outside scratch / shadowing names / main.py / boot.py are refused by the policy (nothing was sent)",
               refused == len(checks) and c.sent == sent_before,
               "%d of %d refused, requests sent: %d" % (refused, len(checks), c.sent - sent_before))
    shadow_path = S + "/machine.py"
    ctx.put(b"# harness file, never imported\n", shadow_path)
    ok = ctx.call("fs.stat", path=shadow_path).get("exists")
    ctx.call("fs.rm", path=shadow_path)
    ctx.expect("%s is allowed (inside scratch, not an import root)" % shadow_path, ok)
    # manifest vs host
    man = ctx.call("fs.manifest", root=S, hash=True)
    got = {_nfc(e["path"]): e for e in man["entries"] if e.get("type") == "file"}
    want = {_nfc(k): v for k, v in expected.items()}
    miss = sorted(set(want) - set(got))
    extra = sorted(set(got) - set(want))
    wrong = [k for k in want if k in got and (got[k].get("size") != len(want[k]) or
                                              (man.get("hash") == "sha256" and got[k].get("sha256") != _sha(want[k])))]
    ctx.expect("fs.manifest of scratch equals the host files (%s)" % man.get("hash"), not (miss or extra or wrong),
               "missing=%s extra=%s wrong=%s" % (miss[:3], extra[:3], wrong[:3]))
    # cancel a 200 KiB upload with stop
    big = ctx.local_file(rng.randbytes(200 * 1024), "big")
    m = c.mark()
    rid = c.send("fs.put", local=big, remote=S + "/big-cancel.bin")
    c.wait_event("progress", lambda e: e.get("id") == rid, 60.0, since=m)
    st = c.request("stop")
    res = c.result(rid, 300.0)
    cancelled = (not res.get("ok")) and (res.get("error") or {}).get("code") == "E_CANCELLED"
    idle = ctx.await_idle()
    if idle:
        ctx.trip.check("after the upload cancel")
    ctx.expect("stop during a 200 KiB upload: stop answered", bool(st.get("ok")), st.get("error") or "stopped=%s ms=%s" % (st.get("stopped"), st.get("ms")))
    names = [e["name"] for e in ctx.call("fs.list", path=S).get("entries", [])]
    tmpleft = [n for n in names if n.endswith(".mpytmp") or n.startswith("~")]
    detail = "cancelled=%s (%s)" % (cancelled, (res.get("error") or {}).get("detail") if not res.get("ok") else "finished before the stop arrived")
    ctx.metric("upload_cancelled", cancelled)
    ctx.expect("cancelled upload leaves no .mpytmp and no partial target", (res.get("ok") or cancelled) and idle and not tmpleft
               and (not cancelled or "big-cancel.bin" not in names), "%s; leftovers=%s" % (detail, tmpleft))
    if "big-cancel.bin" in names:
        ctx.call("fs.rm", path=S + "/big-cancel.bin")
    # folders
    ctx.call("fs.mkdir", path=S + "/sub/a/b")
    ctx.put(b"deep\n", S + "/sub/a/b/deep.txt")
    ctx.put(b"top\n", S + "/sub/top.txt")
    r = ctx.call("fs.rmtree", path=S + "/sub/a")
    ok = (not ctx.call("fs.stat", path=S + "/sub/a").get("exists")) and ctx.call("fs.stat", path=S + "/sub/top.txt").get("exists")
    ctx.expect("fs.rmtree of a scratch sub folder", ok, "removed=%s" % r.get("removed"))
    ctx.call("fs.rmtree", path=S + "/sub")
    ctx.expect("fs.rmtree of the next sub folder", not ctx.call("fs.stat", path=S + "/sub").get("exists"))
    for remote in list(expected):
        ctx.call("fs.rm", path=remote)
    left = [e for e in ctx.call("fs.manifest", root=S, hash=False)["entries"] if e.get("type") == "file"]
    ctx.expect("fs.rm of every test file", not left, left[:3])
    gone = ctx.remove_scratch()
    ctx.expect("scratch removed with fs.rmtree", gone)
    bad = ctx.verify_backups()
    ctx.expect("backup files on the board are unchanged", not bad, bad)


# ===================================================================================================== phase C
def phase_c(ctx):
    c = ctx.client
    p = {k: ctx.store.author(*v) for k, v in PROGRAMS.items()}
    has_compile = bool(ctx.caps.get("compile"))
    m = c.mark()
    r = ctx.run_program(p["print_ok"])
    ctx.expect("print program: exit ok and output arrives", r.get("exit") == "ok" and b"harness hello" in c.out_bytes(m), r)
    ctx.after_run("print program")
    m = c.mark()
    r = ctx.run_program(p["syntax_error"])
    ctx.expect("syntax error: exit exception with SyntaxError", r.get("exit") == "exception" and b"SyntaxError" in c.err_bytes(m),
               "%s %r" % (r.get("exit"), c.err_bytes(m)[-120:]))
    ctx.after_run("syntax error")
    m = c.mark()
    r = ctx.run_program(p["raise_error"])
    err = c.err_bytes(m)
    ctx.expect("runtime exception: exit exception, message in the traceback", r.get("exit") == "exception" and b"harness boom" in err, err[-160:])
    if has_compile:
        ctx.expect("traceback cites the local path (spaces and parentheses)", p["raise_error"].path.encode("utf-8") in err, err[-200:])
    else:
        ctx.expect("traceback cites the local path", True, "n/a: the board has no compile(); it shows <stdin>")
    ctx.after_run("runtime exception")
    # stdin echo
    m = c.mark()
    ctx.program_started = True
    ctx.trip.note_program_run()
    rid = c.send("run", local=p["stdin_echo"].path)
    c.wait_out(b"READY", 30.0, since=m)
    worst = 0.0
    for key in (b"a", b"b"):
        m2 = c.mark()
        t0 = c.tty_write(key)
        needle = b"key:" + repr(key.decode()).encode()
        c.wait_out(needle, 10.0, since=m2)
        t1 = stream_arrival(c, "out", needle, m2)
        worst = max(worst, (t1 - t0) if t1 else 99.0)
    ctx.metric("stdin_echo_worst_s", round(worst, 3))
    ctx.expect("keystrokes are echoed by the program within 0.5 s", worst <= (0.5 if not ctx.fake else 2.0), "worst %.3f s" % worst)
    c.tty_write(b"q")
    r = c.result(rid, 30.0)
    ctx.expect("stdin program ends on 'q' with exit ok", r.get("ok") and r.get("exit") == "ok" and b"DONE" in c.out_bytes(m), r)
    ctx.after_run("stdin echo")
    # while True stopped by stop
    m = c.mark()
    ctx.program_started = True
    ctx.trip.note_program_run()
    rid = c.send("run", local=p["loop"].path)
    c.wait_out(b"LOOPING", 30.0, since=m)
    t0 = time.monotonic()
    st = c.request("stop")
    wall = time.monotonic() - t0
    r = c.result(rid, 30.0)
    ctx.metric("stop_latency_ms", int(wall * 1000))
    bound = ctx.stop_bound_ms
    ctx.expect("stop interrupts a while True loop within %d ms" % bound,
               st.get("ok") and st.get("stopped") is True and (st.get("ms") or 0) <= bound and wall <= bound / 1000.0 * 5,
               "stopped=%s bridge ms=%s wall %.0f ms" % (st.get("stopped"), st.get("ms"), wall * 1000))
    ctx.expect("the stopped run answers exit interrupted", r.get("ok") and r.get("exit") == "interrupted", r)
    ctx.after_run("stop")
    # 1 MB of output
    m = c.mark()
    t0 = time.monotonic()
    r = ctx.run_program(p["big_output"], timeout=900.0)
    dt = time.monotonic() - t0
    out = c.out_bytes(m)
    ctx.metric("big_output_bytes", len(out))
    ctx.metric("big_output_bytes_per_s", int(len(out) / dt) if dt else 0)
    ctx.expect("program printing 1 MiB: every line arrives", r.get("exit") == "ok" and len(out) >= BIG_OUTPUT_BYTES
               and out.count(b"x" * BIG_LINE) == BIG_LINES, "%d bytes, %d lines" % (len(out), out.count(b"x" * BIG_LINE)))
    ctx.after_run("1 MiB output")
    # run twice
    outs = []
    for i in (1, 2):
        m = c.mark()
        r = ctx.run_program(p["counter"])
        outs.append(c.out_bytes(m))
        ctx.expect("run twice in a row (#%d) exits ok" % i, r.get("exit") == "ok", r)
        ctx.after_run("run #%d" % i)
    ctx.expect("each run starts a fresh VM (same output)", outs[0] == outs[1] and b"count 1" in outs[0], outs)


# ===================================================================================================== phase D
def phase_d(ctx):
    c = ctx.client
    ctx.call("repl.attach")

    def typed(text, needle, label):
        m = c.mark()
        c.tty_write(text.encode("ascii") + b"\r")
        try:
            c.wait_stream("repl", needle, 15.0, since=m)
            ok = True
        except BridgeTimeout:
            ok = False
        ctx.expect(label, ok, c.repl_bytes(m)[-100:])
        return ok

    typed("1+2", b"1+2\r\n3\r\n>>> ", "REPL evaluates an expression (echo and result events)")
    typed("_hw_v = 41", b"_hw_v = 41\r\n>>> ", "REPL sets a variable")
    typed("_hw_v + 1", b"_hw_v + 1\r\n42\r\n>>> ", "REPL reads the variable back")
    r = ctx.call("fs.list", path="/")
    ctx.expect("file op while the REPL is attached", "entries" in r, "%d root entries" % len(r.get("entries", [])))
    typed("_hw_v + 1", b"_hw_v + 1\r\n42\r\n>>> ", "REPL state survives the file op")
    typed("del _hw_v", b"del _hw_v\r\n>>> ", "REPL variable removed")
    ctx.call("repl.detach")
    m = c.mark()
    ctx.call("fs.stat", path="/")
    ctx.expect("repl.detach: no more repl events", not c.events_of("repl", m))
    ctx.expect("state is idle after detach", ctx.await_idle(), ctx.state())


# ===================================================================================================== phase E
def _build_tree(rng):
    dirs = ["", "a", "a/b", "a/b/c", "docs", "my notes (draft)", "data/raw"]
    tree = {}
    sizes = [0, 1, 17, 255, 1024, 4000, 8192]
    for i in range(32):
        d = dirs[i % len(dirs)]
        ext = ["txt", "py", "bin", "json"][i % 4]
        stem = "file%02d" % i
        if i == 5:
            stem = "sp ace %02d" % i
        if i == 9:
            stem = u"ünï-%02d" % i
        rel = (d + "/" if d else "") + stem + "." + ext
        size = sizes[i % 7]
        if ext == "bin":
            data = rng.randbytes(size)
        else:
            data = (("# harness data %02d\n" % i) * 600).encode("ascii")[:size]
        tree[rel] = data
    return tree


def phase_e(ctx):
    c = ctx.client
    ctx.ensure_scratch()
    R = ctx.scratch + "/proj"
    rng = random.Random(2026)
    root = os.path.join(ctx.tmp, "proj (local)")
    tree = _build_tree(rng)

    def write_local(rel, data):
        p = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
        return p

    paths = {rel: write_local(rel, d) for rel, d in tree.items()}
    t0 = time.monotonic()
    nbytes = 0
    for rel in sorted(tree):
        ctx.call("fs.put", local=paths[rel], remote=R + "/" + rel)
        nbytes += len(tree[rel])
    dt = max(time.monotonic() - t0, 1e-6)
    ctx.metric("mirror_upload_files", len(tree))
    ctx.metric("mirror_upload_bytes_per_s", int(nbytes / dt))

    def compare(label):
        man = ctx.call("fs.manifest", root=R, hash=True)
        got = {_nfc(e["path"][len(R) + 1:]): e for e in man["entries"] if e.get("type") == "file"}
        want = {_nfc(k): v for k, v in tree.items()}
        bad = [k for k in want if k not in got or got[k].get("size") != len(want[k]) or
               (man.get("hash") == "sha256" and got[k].get("sha256") != _sha(want[k]))]
        extra = sorted(set(got) - set(want))
        ctx.expect(label, not bad and not extra, "%d files; bad=%s extra=%s" % (len(want), bad[:3], extra[:3]))

    compare("manifest of the uploaded project equals the local tree (%d files)" % len(tree))
    changed = [k for k in sorted(tree) if k.startswith(("a/", "docs/", "data/"))][:3]
    for i, rel in enumerate(changed):
        tree[rel] = tree[rel] + b"changed %d\n" % i
        write_local(rel, tree[rel])
    tree["new/added file.txt"] = b"a new file\n"
    paths["new/added file.txt"] = write_local("new/added file.txt", tree["new/added file.txt"])
    skipped = sent = 0
    for rel in sorted(tree):
        kw = {"expectSha": _sha(tree[rel])} if ctx.hash_kind == "sha256" else {}
        r = ctx.call("fs.put", local=paths[rel], remote=R + "/" + rel, **kw)
        skipped += 1 if r.get("skipped") else 0
        sent += 0 if r.get("skipped") else 1
    if ctx.hash_kind == "sha256":
        ctx.expect("upload only changes with expectSha", sent == len(changed) + 1 and skipped == len(tree) - sent,
                   "sent %d, skipped %d, changed %d + 1 new" % (sent, skipped, len(changed)))
    else:
        ctx.expect("upload only changes with expectSha", True, "n/a: board hash is %s; everything was sent" % ctx.hash_kind)
    compare("manifest equals the local tree after the incremental upload")
    victim = [k for k in sorted(tree) if k.startswith("a/b/")][0]
    ctx.call("fs.rm", path=R + "/" + victim)
    del tree[victim]
    old = sorted(k for k in tree if k.startswith("docs/"))[0]
    new = "docs/renamed (1).txt"
    ctx.call("fs.mv", src=R + "/" + old, dst=R + "/" + new)
    tree[new] = tree.pop(old)
    compare("manifest after one delete and one rename")
    dl = os.path.join(ctx.tmp, "proj (download)")
    man = ctx.call("fs.manifest", root=R, hash=False)
    t0 = time.monotonic()
    ok = True
    got_n = 0
    for e in man["entries"]:
        if e.get("type") != "file":
            continue
        rel = e["path"][len(R) + 1:]
        local = os.path.join(dl, *rel.split("/"))
        ctx.call("fs.get", remote=e["path"], local=local)
        got_n += 1
        want = {_nfc(k): v for k, v in tree.items()}.get(_nfc(rel))
        with open(local, "rb") as f:
            ok = ok and want is not None and f.read() == want
    dt = max(time.monotonic() - t0, 1e-6)
    ctx.metric("mirror_download_bytes_per_s", int(sum(len(v) for v in tree.values()) / dt))
    ctx.expect("download everything back: byte-for-byte equal", ok and got_n == len(tree), "%d files" % got_n)
    ctx.call("fs.rmtree", path=R)
    ctx.expect("project folder removed", not ctx.call("fs.stat", path=R).get("exists"))


# ===================================================================================================== phase F
def phase_f(ctx):
    for i in range(1, ctx.soak_cycles + 1):
        ctx.disconnect()
        ctx.connect()
        ctx.trip.check("soak cycle %d" % i)
    ctx.expect("%d connect/disconnect cycles, tripwire quiet" % ctx.soak_cycles, True)
    ctx.ensure_scratch()
    S = ctx.scratch
    t0 = time.monotonic()
    n = 0
    bad = 0
    for i in range(ctx.soak_ops):
        data = ("soak %d\n" % i).encode("ascii")
        remote = "%s/soak-%02d.txt" % (S, i)
        r, _l, _dt = ctx.put(data, remote)
        st = ctx.call("fs.stat", path=remote)
        _g, back = ctx.get_bytes(remote)
        ctx.call("fs.rm", path=remote)
        n += 4
        bad += 0 if (r.get("bytes") == len(data) and st.get("size") == len(data) and back == data) else 1
    ctx.metric("soak_ops", n)
    ctx.metric("soak_ops_per_s", round(n / max(time.monotonic() - t0, 1e-6), 1))
    ctx.expect("%d small ops in one session" % n, bad == 0, "%d bad round trips" % bad)
    ctx.expect("scratch removed", ctx.remove_scratch())


# ===================================================================================================== registry
class _Spec(object):
    def __init__(self, pid, name, classes, fn, summary):
        self.id, self.name, self.classes, self.fn, self.summary = pid, name, tuple(classes), fn, summary


PHASES = [
    _Spec("A", "read-only", ("session", "read", "probe"), phase_a,
          "ports.list, connect (must give idle + prompt), identity, fs.manifest /, tripwire baseline, 3x disconnect/connect"),
    _Spec("B", "files in scratch", ("session", "read", "scratch-write", "probe", "stop"), phase_b,
          "backup files, mkdir scratch, put/get/stat/mv/rm of odd files, expectSha, shadow refusals, cancel a 200 KiB upload, rmtree"),
    _Spec("C", "run harmless programs", ("session", "program", "console", "stop", "probe"), phase_c,
          "print/syntax error/exception/stdin echo/while True + stop/1 MiB output/run twice, tripwire after each"),
    _Spec("D", "REPL", ("session", "console", "read", "probe"), phase_d,
          "repl.attach, typed expressions and a variable, file op while attached, repl.detach"),
    _Spec("E", "mirror flows", ("session", "read", "scratch-write", "probe"), phase_e,
          "upload a local project tree to scratch/proj, incremental sync with expectSha, delete, rename, download and compare"),
    _Spec("F", "soak (optional)", ("session", "read", "scratch-write", "probe"), phase_f,
          "20 connect/disconnect cycles with tripwire, 200 small ops in one session"),
    _Spec("R", "reset tiers (gated)", confine.RESET_PHASE_CLASSES, resetphase.phase_r,
          "ONLY with --allow-resets N (1..5) and MPY_ALLOW_RESETS=1: capability, soft reset once, machine reset x2, hard reset with and "
          "without verify (if likely/verified); each announced, budgeted, recovered and checked; abort on the first surprise"),
]
PHASE_IDS = [p.id for p in PHASES]
_BY_ID = {p.id: p for p in PHASES}
CLEANUP_CLASSES = ("session", "read", "scratch-write", "probe", "stop")


def execute_phase(ctx, pid):
    """Run one phase; returns its result dict.  Refuse / TripwireTripped / BridgeGone propagate (after being recorded)."""
    spec = _BY_ID[pid]
    ctx.phase_id = pid
    ctx.checks, ctx.metrics = [], {}
    result = {"id": pid, "name": spec.name, "status": "fail", "elapsed_s": 0.0, "classes": list(spec.classes),
              "checks": ctx.checks, "metrics": ctx.metrics}
    ctx.report.data["phases"].append(result)
    t0 = time.monotonic()
    ctx.console.line("phase %s: %s" % (pid, spec.name), tag=pid)
    ctx.client.policy.allowed_classes = spec.classes
    try:
        try:
            if pid != "A":
                ctx.check_port_free("before phase %s" % pid)
                if ctx.state() != "idle":
                    raise Refuse("the board is not idle before phase %s (state=%s)" % (pid, ctx.state()))
                ctx.trip.check("before phase %s" % pid)
                ctx.record_extras("before phase %s" % pid)
            spec.fn(ctx)
            if not ctx.await_idle():
                ctx.expect("board idle at the end of the phase", False, "state=%s" % ctx.state())
            ctx.trip.check("after phase %s" % pid)
            ctx.record_extras("after phase %s" % pid)
            result["status"] = "pass" if all(ch["ok"] for ch in ctx.checks) else "fail"
        except (BridgeCallError, BridgeTimeout, confine.ConfinementError) as exc:
            ctx.expect("phase %s completed without a bridge error" % pid, False, exc)
            result["status"] = "fail"
        except Refuse:
            result["status"] = "refused"
            raise
        except resetphase.ResetAbort:
            result["status"] = "aborted"
            raise
        except (TripwireTripped, ProbeFailed, BridgeGone):
            result["status"] = "fail"
            raise
    finally:
        result["elapsed_s"] = round(time.monotonic() - t0, 3)
        ctx.client.policy.allowed_classes = None
        ctx.console.line("phase %s: %s" % (pid, result["status"].upper()), tag=pid)
    return result


# ===================================================================================================== cleanup
def cleanup(ctx, reverify=True):
    """Best-effort, never raises.  Returns the list of residue strings (empty = clean).  See docs/hwtest-plan.md "Cleanup"."""
    steps = ctx.report.data["cleanup"]["steps"]
    residue = ctx.report.data["cleanup"]["residue"]
    ctx.phase_id = "cleanup"
    pol = ctx.client.policy
    pol.allowed_classes = CLEANUP_CLASSES
    ctx.client.set_deadline(CLEANUP_BUDGET_S)             # the run's own budget is over; the cleanup has its own, then it gives up

    def step(name, fn, on_fail=None):
        """Run one cleanup step.  A step that raises is recorded AND leaves a residue line (``on_fail`` % detail), so a failed
        cleanup can never look like a clean board.  A bridge that stops answering ends all further bridge calls at once."""
        try:
            detail = fn()
            steps.append({"name": name, "ok": True, "detail": str(detail or "")})
            ctx.console.line("cleanup: %s%s" % (name, (" - %s" % detail) if detail else ""), tag="cleanup")
        except BaseException as exc:                      # noqa: BLE001 - cleanup must go on, even after Ctrl-C
            why = "%s: %s" % (type(exc).__name__, str(exc).splitlines()[0][:160] if str(exc) else "")
            steps.append({"name": name, "ok": False, "detail": why})
            ctx.console.line("cleanup: %s FAILED: %s" % (name, why), tag="cleanup")
            if on_fail:
                residue.append(on_fail % why)
            if isinstance(exc, (BridgeTimeout, BridgeGone, confine.DeadlineExceeded)):
                ctx.client.give_up()
            return False
        return True

    client = ctx.client
    if client.alive and ctx.connected and ctx.board_lost:
        # phase R aborted because the board did not come back (or may sit in the ROM bootloader): nothing is asked of it (no probes, no reconnect, no reset)
        why = (getattr(ctx.reset_abort, "reason", None) or "the board did not come back after a reset")
        steps.append({"name": "board work", "ok": False, "detail": "the board is left alone after the aborted reset phase; no board checks were attempted"})
        residue.append("RESET PHASE ABORTED, the board was left alone (%s): backups and board state were NOT verified; check the board by hand" % why)
        step("disconnect", lambda: ctx.disconnect() and "")
        pol.allowed_classes = None
        return residue
    if client.alive and ctx.connected:
        def regain_link():
            if ctx.state() != "disconnected":
                probe = client.request("fs.stat", _timeout=30.0, path="/")      # the bridge only notices a lost port when it uses it
                code = (probe.get("error") or {}).get("code")
                if probe.get("ok") or (code not in ("E_NO_DEVICE", "E_NOT_CONNECTED") and ctx.state() != "disconnected"):
                    return "link up"
            for attempt in range(8):                      # a board that re-enumerates (native USB) is back within seconds
                resp = client.request("connect", _timeout=30.0, port=ctx.port)
                if resp.get("ok"):
                    ctx.connected = True
                    residue.append("the link to the board was lost during the run (cable pulled or board re-enumerated) and had to be "
                                   "re-established by the cleanup; check the board")
                    return "reconnected (attempt %d)" % (attempt + 1)
                threading.Event().wait(1.5)
            raise RuntimeError("the board did not come back after the link was lost")
        if ctx.scratch_created or ctx.program_started:
            step("reconnect if the link was lost", regain_link,
                 "could not reconnect after the link was lost (%s); scratch folder and programs on the board were not cleaned")

        def stop_program():
            if (ctx.program_started or ctx.trip.probe_trouble) and (pol.active_runs or ctx.state() == "running"):
                r = client.request("stop")
                ctx.await_idle(5.0)
                if ctx.state() != "idle":
                    residue.append("a harness program may still be running on the board (state=%s)" % ctx.state())
                return "stop: %s" % ({k: r.get(k) for k in ("ok", "stopped", "ms")},)
            return "no harness program running"
        step("stop any harness program", stop_program, "a harness program may still be running on the board (stop failed: %s)")

        def rm_scratch():
            if not ctx.scratch_created:
                return "scratch was never created"
            gone = ctx.remove_scratch()
            if not gone:
                residue.append("scratch folder %s is still on the board" % ctx.scratch)
            return "removed" if gone else "STILL PRESENT"
        if ctx.state() == "idle" or not ctx.program_started:
            step("remove the scratch folder", rm_scratch, "scratch folder " + ctx.scratch.replace("%", "%%") + " may still be on the board (removal failed: %s)")
        else:
            residue.append("scratch folder %s not removed: the board is not idle" % ctx.scratch if ctx.scratch_created else "board not idle")

        def verify_bk():
            bad = ctx.verify_backups()
            if bad:
                residue.append("backup file(s) differ from the saved copies: %s" % bad)
            return "unchanged" if not bad else "CHANGED %s" % bad
        if ctx.backups:
            step("verify backup files", verify_bk, "backup files were NOT verified against the saved copies (%s)")
        step("disconnect", lambda: ctx.disconnect() and "")
        if reverify:
            def reverify_idle():
                resp = client.request("connect", _timeout=60.0, port=ctx.port)
                if not resp.get("ok"):
                    residue.append("could not reconnect to verify the board: %s" % (resp.get("error") or {}).get("code"))
                    return "connect failed"
                ctx.connected = True
                if resp.get("state") != "idle" or resp.get("sync") != "prompt":
                    residue.append("board not idle at the end (state=%s sync=%s)" % (resp.get("state"), resp.get("sync")))
                gone = not client.call("fs.stat", path=ctx.scratch).get("exists")
                if not gone:
                    residue.append("scratch folder %s present at the end" % ctx.scratch)
                try:
                    ctx.trip.check("after cleanup")
                except TripwireTripped as t:
                    ctx.report.data["trip"] = ctx.report.data["trip"] or {"label": t.label, "reasons": t.reasons}
                    residue.append("tripwire tripped during cleanup: %s" % "; ".join(t.reasons))
                return "state=%s sync=%s scratch_gone=%s" % (resp.get("state"), resp.get("sync"), gone)
            if ctx.board is not None:
                try:
                    wait_until(lambda: ctx.board.connected == 0, 3.0, "the fake board to release the client")
                except AssertionError:
                    pass
            step("verify the board is idle and scratch is gone", reverify_idle, "the board state was NOT verified after the cleanup (%s)")
            if ctx.connected:
                step("disconnect (final)", lambda: ctx.disconnect() and "")
    elif not ctx.scratch_created and not ctx.program_started:
        steps.append({"name": "board work", "ok": True, "detail": "never connected, or nothing was written or run: nothing to clean"})
    else:
        steps.append({"name": "board work", "ok": False, "detail": "bridge not alive or not connected; nothing verified"})
        if ctx.scratch_created:
            residue.append("scratch folder %s may still be on the board (bridge gone)" % ctx.scratch)
        if ctx.program_started:
            residue.append("a harness program may still be running (bridge gone)")
    pol.allowed_classes = None
    return residue
