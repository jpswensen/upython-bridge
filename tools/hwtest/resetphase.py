"""resetphase.py - phase R, "reset tiers" (needs a fresh, explicit instructor waiver: CLAUDE.md "Hard rules"; docs/protocol.md Appendix D).

Phase R is the ONLY code in the harness that can make the board restart.  It exists only when ``run_hw.py`` created a
``confine.ResetGate`` (phase R requested explicitly, ``--allow-resets N`` 1..5, env MPY_ALLOW_RESETS=1, the config does not
forbid it, for a real device all the real-port guards).  The gate is armed here and nowhere else; ``confine.Policy`` then
allows exactly the reset ops of the tiers below, counts each chip reset against the budget BEFORE it is sent, allows one reset
at a time (a new one only after the previous one was declared recovered) and never again after ``abort``.

Steps (each reset is announced as ``RESET i/N: <tier> (a motor may twitch)`` on the console and in the report, then the harness
waits ``ANNOUNCE_WAIT_S`` (3 s), re-checks that the board is idle and the tripwire quiet, and sends exactly ONE message)::

    R0  read-only baseline: backup files by hash, root manifest, tripwire in reset-expected mode
    R1  reset.capability: printed and recorded in full
    R2  soft reset once: the chip is NOT reset, ticks_ms keeps growing, reset_cause may become SOFT_RESET
    R3  machine reset twice: the link drops or re-syncs, the board is back within RECOVER_S (20 s), ticks_ms restarted
        (< 15 s of uptime at the first probe), identity equal, idle at a prompt, bridge state events recorded
    R4  hard reset with verify, then hard reset without verify, ONLY while the capability just read says hard.state is
        verified or likely (never forced; unlikely / unknown / failed is skipped with a note)
    R5  final: identity and manifest equal to the baseline, backups unchanged, board idle, no program running

ABORT RULE: the first surprise (the board does not come back in time, is not idle at a prompt, identity or backups differ, the
tripwire sees a restart this harness did not cause, an unexpected bridge error) raises ``ResetAbort``: the gate is aborted (no
reset is ever sent again, nothing is retried), ``run_hw.py`` runs the normal cleanup and exits 5 "RESET PHASE ABORTED" with the
reason in the report.  A step the board cannot do (reset.machine unsupported, hard not allowed, budget used up) is SKIPPED with a
note; that is not a surprise.

BUDGET UNITS: reset.machine and reset.hard without verify cost 1 chip reset, reset.hard WITH verify costs 2 (the bridge repeats the
pulse once when the chip reports "waiting for download"), so ``--allow-resets N`` bounds what the board can physically see.  The
summary reports the chip resets sent (exact once a response proves how many pulses a verification used, else the worst case) and,
separately, the budget units reserved.

This module never writes to the board and never names a reset op literally (``confine.OP_RESET_*``).
"""
from __future__ import annotations

import json
import threading
import time

from tests.bridge_client import BridgeCallError, BridgeGone, BridgeTimeout
from tools.hwtest import confine
from tools.hwtest.report import utc_iso
from tools.hwtest.tripwire import ProbeFailed, TripwireTripped

__all__ = ["ResetAbort", "phase_r", "new_report", "ANNOUNCE_WAIT_S", "RECOVER_S", "IDENT_KEYS", "plan_steps"]

ANNOUNCE_WAIT_S = 3.0           # after the announcement and before the request leaves (time to hit Ctrl-C)
RECOVER_S = 20.0                # the board must be back (idle at a prompt, probe answered) this long after the request left
IDENT_KEYS = ("impl", "version", "machine", "build", "mpy", "platform", "uname", "uniqueId")
_TIERS = {"soft": "soft", "machine": "machine", "hard-verify": "hard verify", "hard": "hard"}


class ResetAbort(Exception):
    """The first surprise of phase R: no further reset, normal cleanup, exit code 5."""

    def __init__(self, reason, board_lost=False, step=None):
        Exception.__init__(self, reason)
        self.reason = str(reason)
        self.board_lost = bool(board_lost)
        self.step = step


class Step(object):
    def __init__(self, key, op, args, chip):
        self.key, self.op, self.args, self.chip = key, op, dict(args), chip
        self.tier = _TIERS[key]


def new_report(budget):
    return {"budget": budget, "capability": None, "capability_reads": [], "steps": [], "skipped": [], "aborted": None, "ledger": [],
            "baseline": None,
            "summary": {"chip_resets_sent": 0, "chip_requests_sent": 0, "chip_budget_units_reserved": 0, "chip_resets_observed": 0,
                        "soft_resets_sent": 0, "budget": budget, "text": "chip resets performed 0 / budget %d" % budget}}


def plan_steps(cap, budget):
    """(steps to run, skipped notes) for a capability result and a chip reset budget.  Pure; used by phase R and the tests.
    The budget is spent in units (``confine.chip_cost``): a hard reset with verification costs 2, and when it does not fit the plain
    hard reset that would follow it is not planned either (an unverified hard reset is never the first one)."""
    steps = [Step("soft", confine.OP_RESET_SOFT, {}, False)]
    skipped = []
    chips = []
    machine = cap.get("machine") if isinstance(cap.get("machine"), dict) else {}
    if machine.get("available") is True:
        chips += [Step("machine", confine.OP_RESET_MACHINE, {"confirmed": True}, True) for _ in (1, 2)]
    else:
        skipped.append({"tier": "machine", "reason": "reset.machine is not available: %s" % (machine.get("reason") or "no reason given")})
    hard = cap.get("hard") if isinstance(cap.get("hard"), dict) else {}
    if hard.get("state") in ("verified", "likely") and hard.get("method") in ("rts-pulse", "usb-jtag"):
        chips += [Step("hard-verify", confine.OP_RESET_HARD, {"confirmed": True, "verify": True}, True),
                  Step("hard", confine.OP_RESET_HARD, {"confirmed": True, "verify": False}, True)]
    else:
        skipped.append({"tier": "hard", "reason": "hard reset not attempted: hard.state=%r method=%r (%s); it is never forced"
                        % (hard.get("state"), hard.get("method"), hard.get("reason") or "no reason given")})
    used, unverified = 0, False
    for st in chips:
        cost = confine.chip_cost(st.op, st.args)
        if st.key == "hard" and unverified:
            skipped.append({"tier": st.tier, "reason": "chip reset budget %d: the verification before it did not fit, and a hard reset is "
                            "never sent unverified" % budget})
        elif used + cost <= budget:
            steps.append(st)
            used += cost
        else:
            if st.key == "hard-verify":
                unverified = True
            skipped.append({"tier": st.tier, "reason": "chip reset budget %d used up by the earlier steps (%d unit(s) spent, this one needs %d%s)"
                            % (budget, used, cost, "; a hard reset with verification can pulse the lines twice" if cost > 1 else "")})
    return steps, skipped


# --------------------------------------------------------------------------------------------------- helpers
def _wait(seconds):
    if seconds > 0:
        threading.Event().wait(seconds)


def _core(ident):
    return {k: ident.get(k) for k in IDENT_KEYS}


def _lost(ctx):
    try:
        return ctx.state() != "idle"
    except Exception:                                       # noqa: BLE001
        return True


def _manifest(ctx):
    man = ctx.call("fs.manifest", root="/", hash=True)
    if man.get("truncated") is not False:
        raise ResetAbort("the root manifest is truncated or unreadable; it cannot serve as a baseline")
    return {e.get("path"): (e.get("type"), e.get("size"), e.get("sha256")) for e in (man.get("entries") or [])}


def _diff_manifest(a, b):
    out = []
    for path in sorted(set(a) | set(b)):
        if a.get(path) != b.get(path):
            out.append("%s: %s -> %s" % (path, a.get(path, "absent"), b.get(path, "absent")))
    return out


def _events_since(ctx, mark):
    return [{"state": e.get("state"), "reason": e.get("reason")} for e in ctx.client.events_of("state", mark)]


def _check_identity(ctx, base, label):
    now = _core(ctx.call("identity"))
    diff = ["%s: %r -> %r" % (k, base.get(k), now.get(k)) for k in IDENT_KEYS if base.get(k) != now.get(k)]
    if diff:
        raise ResetAbort("identity differs %s: %s" % (label, "; ".join(diff)))
    return now


def _refresh_capability(ctx, rep, label):
    """Read reset.capability; the first read (R1) is kept in full as ``capability``, every read is listed in ``capability_reads``."""
    cap = ctx.call(confine.OP_RESET_CAPABILITY)
    result = {k: cap.get(k) for k in ("soft", "machine", "hard", "cacheKey")}
    if rep["capability"] is None:
        rep["capability"] = result
    rep["capability_reads"].append({"before": label, "result": result})
    return result


def _recover(ctx, rec, mark, deadline):
    """Wait until the board is idle at a prompt again.  The bridge re-syncs on the same link by itself; when the port dropped
    (native USB) or the link was lost the CLIENT reconnects (a connect, never a reset).  ResetAbort at the deadline: a board that
    answers after it (also a reconnect that succeeds after it) is NOT accepted."""
    c = ctx.client
    if rec.get("portDropped"):
        try:                                               # the event may arrive just after the response
            c.wait_event("state", lambda e: e.get("state") == "disconnected", timeout=max(0.1, min(5.0, deadline - time.monotonic())),
                         since=mark)
        except BridgeTimeout:
            pass
    last = None

    def too_late(st):
        return ResetAbort("the board did not come back within %.0f s of the request (state=%s, last connect: %s)"
                          % (ctx.reset_recover_s, st, last), board_lost=True)

    while True:
        st = ctx.state()
        left = deadline - time.monotonic()
        if st == "idle" and left > 0:
            return
        if left <= 0:
            raise too_late(st)
        if st in (None, "disconnected"):
            try:
                resp = c.request("connect", _timeout=max(0.2, min(30.0, left)), port=ctx.port)
            except BridgeTimeout:                          # the connect did not answer before the deadline
                raise too_late(ctx.state())
            if time.monotonic() > deadline:                # an answer after the deadline counts as "not back in time"
                raise too_late(ctx.state())
            if resp.get("ok"):
                ctx.connected = True
                last = "state=%s sync=%s" % (resp.get("state"), resp.get("sync"))
                if resp.get("state") == "idle" and resp.get("sync") == "prompt":
                    return
            else:
                last = (resp.get("error") or {}).get("code")
            _wait(min(0.25, max(0.0, deadline - time.monotonic())))
        else:
            wm = c.mark()
            try:
                c.wait_event("state", timeout=max(0.05, min(0.5, left)), since=wm)
            except BridgeTimeout:
                pass


# --------------------------------------------------------------------------------------------------- one reset
def _announce(ctx, gate, rep, step, i, n):
    text = "RESET %d/%d: %s (a motor may twitch)" % (i, n, step.tier)
    rec = {"i": i, "n": n, "tier": step.tier, "op": step.op, "args": dict(step.args), "chip": step.chip, "announcement": text,
           "announced_utc": utc_iso(), "sent_utc": None, "recovered_utc": None, "recovery_s": None, "ticks_ms_after": None,
           "reset_cause_after": None, "verified": None, "evidence": [], "learned": None, "cacheKey": None, "method": None,
           "portDropped": None, "reconnect": None, "bridge_events": [], "note": "", "status": "announced"}
    rep["steps"].append(rec)
    kind = "soft reset: the chip is not reset" if not step.chip else "CHIP RESET"
    if step.chip and confine.chip_cost(step.op, step.args) > 1:
        kind += ", the verification may pulse the line twice: counts as %d of the budget" % confine.chip_cost(step.op, step.args)
    ctx.console.line("%s  [%s; budget units used so far %d of %d]" % (text, kind, gate.chip_used, gate.budget), tag="RESET")
    _wait(ctx.reset_wait_s)
    return rec


def _skip_note(ctx, rec, rep, status, note):
    rec["status"], rec["note"] = status, note
    rep["skipped"].append({"tier": rec["tier"], "reason": note})
    ctx.console.line("RESET %d/%d: %s - %s" % (rec["i"], rec["n"], rec["tier"], note), tag="RESET")


def _run_step(ctx, gate, rep, step, i, n, base_ident, flags):
    c, trip = ctx.client, ctx.trip
    rec = _announce(ctx, gate, rep, step, i, n)
    label = "RESET %d/%d %s" % (i, n, step.tier)
    # nothing leaves unless the board is idle at a prompt and the tripwire has seen no restart that this harness did not cause
    if ctx.state() != "idle":
        raise ResetAbort("%s: the board is not idle at a prompt before the request (state=%s)" % (label, ctx.state()), step=i)
    ctx.check_port_free("before " + label)
    trip.check("before " + label)
    if not step.chip:
        trip.note_soft_reset()
    mark = c.mark()
    t_sent = time.monotonic()
    rec["sent_utc"], rec["status"] = utc_iso(), "sent"
    ctx.console.line("%s: sending exactly one request (%s)" % (label, step.op), tag="RESET")
    rid = c.send(step.op, **step.args)                      # one message; never retried
    rec["ledger_n"] = len(gate.ledger)                      # (the gate debited it just before; settle() refines the report figure)
    resp = c.result(rid, ctx.reset_recover_s)
    deadline = t_sent + ctx.reset_recover_s
    if not resp.get("ok"):
        err = resp.get("error") or {}
        code = err.get("code")
        rec["error"] = {"code": code, "message": err.get("message")}
        if code == "E_UNSUPPORTED" and step.chip:           # nothing happened: the bridge returned to the prompt
            flags["machine_off" if step.key == "machine" else "hard_off"] = True
            _no_reset_followup(ctx, trip, rec, label, deadline, mark)
            _skip_note(ctx, rec, rep, "unsupported", "%s answered E_UNSUPPORTED (%s); no reset happened, skipping the rest of this tier"
                       % (step.op, err.get("message")))
            gate.recovered()
            return rec
        if code == "E_RESET_NOT_OBSERVED" and step.key == "hard-verify":
            rec.update(verified=False, evidence=list(err.get("evidence") or []), learned=err.get("learned"),
                       cacheKey=err.get("cache_key"))
            detail = err.get("detail")
            if isinstance(detail, str) and "waiting-for-download" not in detail:
                gate.settle(rec["ledger_n"], 1)             # the bridge's detail lists its evidence: no repeated pulse happened
            flags["hard_off"] = True
            _no_reset_followup(ctx, trip, rec, label, deadline, mark)
            _skip_note(ctx, rec, rep, "not-observed", "the verification found no reset (the wiring is probably absent); learned=%r; "
                       "the plain hard reset is skipped" % (err.get("learned"),))
            gate.recovered()
            return rec
        raise ResetAbort("%s: unexpected bridge error %s: %s" % (label, code, err.get("message")), step=i)
    for key in ("verified", "evidence", "learned", "cacheKey", "method", "portDropped", "reconnect"):
        if key in resp:
            rec[key] = resp[key]
    rec["response"] = {k: resp.get(k) for k in resp if k not in ("id", "ok", "_n", "_t")}
    if step.key == "hard-verify" and resp.get("verified") is True and "waiting-for-download" not in (resp.get("evidence") or []):
        gate.settle(rec["ledger_n"], 1)                     # (a verified answer without that marker means exactly one pulse)
    if step.key == "hard-verify" and resp.get("verified") is not True:
        flags["hard_off"] = True
        if resp.get("verified") is False:
            # the chip may sit in the ROM bootloader: the board is left alone from here (no probes, no backup checks, only a disconnect)
            raise ResetAbort("%s: the verification ended in an unsafe sequence (%s); the chip may sit in the ROM bootloader"
                             % (label, resp.get("hint") or resp.get("method")), board_lost=True, step=i)
        rec["note"] = "verification inconclusive (verified=%r, evidence=%r); the plain hard reset will be skipped" % (
            resp.get("verified"), resp.get("evidence"))
    _recover(ctx, rec, mark, deadline)
    rec["bridge_events"] = _events_since(ctx, mark)             # the bridge's state events up to the moment the board was back
    t_back = time.monotonic()
    rec["recovered_utc"], rec["recovery_s"] = utc_iso(), round(t_back - t_sent, 3)
    if step.chip:
        reading, reasons = trip.after_caused_reset("after " + label, t_sent)
        if reasons:
            raise ResetAbort("%s: %s" % (label, "; ".join(reasons)), step=i)
    else:
        reading = trip.check("after " + label)           # ticks_ms must keep growing; a SOFT_RESET cause is expected
        if ctx.state() != "idle":
            raise ResetAbort("%s: the board is not idle at a prompt afterwards (state=%s)" % (label, ctx.state()), step=i)
    rec["ticks_ms_after"], rec["reset_cause_after"] = reading.ticks, reading.cause
    _check_identity(ctx, base_ident, "after " + label)
    rec["status"] = "ok"
    gate.recovered()
    ctx.expect("%s: board back in %.1f s, ticks_ms=%d%s, reset_cause=%d, identity equal, idle at a prompt"
               % (label, rec["recovery_s"], reading.ticks, " (restarted)" if step.chip else " (kept growing)", reading.cause), True,
               "events=%s evidence=%s verified=%s" % ([(e["state"], e["reason"]) for e in rec["bridge_events"]], rec["evidence"], rec["verified"]))
    return rec


def _no_reset_followup(ctx, trip, rec, label, deadline, mark):
    """A reset op that reported 'no reset happened': the board must still be idle and the tripwire quiet (ticks_ms keeps growing).
    The bridge's own state events for this request are recorded and consumed; the comparison of ticks and cause still applies."""
    left = max(1.0, deadline - time.monotonic())
    if not ctx.await_idle(left):
        raise ResetAbort("%s: the board is not idle at a prompt after the refused/unsupported request (state=%s)"
                         % (label, ctx.state()), board_lost=True)
    rec["bridge_events"] = _events_since(ctx, mark)
    trip.consume_events()
    trip.check("after " + label + " (no reset happened)")


# --------------------------------------------------------------------------------------------------- phase R
def phase_r(ctx):
    from tools.hwtest import phases as _phases          # (phases imports this module)
    gate = ctx.client.policy.reset_gate
    rep = ctx.report.data.get("reset")
    if gate is None or rep is None:
        raise ResetAbort("phase R started without a reset gate; nothing was sent")
    gate.arm()
    try:
        _body(ctx, gate, rep)
    except ResetAbort as exc:
        _abort(ctx, gate, rep, exc)
        raise
    except (TripwireTripped, ProbeFailed) as exc:
        raise _abort(ctx, gate, rep, ResetAbort("the tripwire fired: %s" % exc, board_lost=_lost(ctx))) from exc
    except _phases.Refuse as exc:
        raise _abort(ctx, gate, rep, ResetAbort(str(exc), board_lost=_lost(ctx))) from exc
    except BridgeCallError as exc:
        raise _abort(ctx, gate, rep, ResetAbort("unexpected bridge error %s: %s" % (exc.code, exc.error.get("message")),
                                                board_lost=_lost(ctx))) from exc
    except (BridgeTimeout, BridgeGone, confine.DeadlineExceeded) as exc:
        raise _abort(ctx, gate, rep, ResetAbort("no answer from the bridge (%s: %s)" % (type(exc).__name__, exc),
                                                board_lost=True)) from exc
    except confine.ConfinementError as exc:
        raise _abort(ctx, gate, rep, ResetAbort("refused by the harness itself: %s" % exc, board_lost=_lost(ctx))) from exc
    finally:
        gate.disarm()
        _summary(ctx, gate, rep)


def _abort(ctx, gate, rep, exc):
    ctx.reset_abort = exc
    ctx.board_lost = exc.board_lost
    gate.abort(exc.reason)
    rep["aborted"] = {"step": exc.step, "reason": exc.reason, "board_lost": exc.board_lost}
    for rec in rep["steps"]:
        if rec["status"] in ("announced", "sent"):
            rec["status"], rec["note"] = "aborted", exc.reason
    ctx.console.line("!!! RESET PHASE ABORTED !!! %s" % exc.reason, tag="RESET")
    return exc


def _summary(ctx, gate, rep):
    observed = len([s for s in rep["steps"] if s["chip"] and s["status"] == "ok"])
    rep["ledger"] = [dict(r) for r in gate.ledger]
    chip_rows = [r for r in gate.ledger if r["chip_n"] is not None]
    performed = sum(r["pulses_max"] for r in chip_rows)       # what the board can have seen: exact once a response proved the pulses
    rep["summary"] = {"chip_resets_sent": performed, "chip_requests_sent": len(chip_rows), "chip_budget_units_reserved": gate.chip_used,
                      "chip_resets_observed": observed, "soft_resets_sent": gate.soft_used, "budget": gate.budget,
                      "text": "chip resets performed %d / budget %d (restarts observed %d; %d chip reset request(s), %d budget unit(s) reserved); "
                              "soft resets %d" % (performed, gate.budget, observed, len(chip_rows), gate.chip_used, gate.soft_used)}
    ctx.console.line("RESET PHASE SUMMARY: " + rep["summary"]["text"] + ("; skipped: %s" % "; ".join(
        "%s (%s)" % (s["tier"], s["reason"]) for s in rep["skipped"]) if rep["skipped"] else ""), tag="RESET")


def _body(ctx, gate, rep):
    c, trip = ctx.client, ctx.trip
    base_ident = _core(ctx.ident or {})
    if not base_ident.get("impl"):
        raise ResetAbort("phase A left no identity baseline; no reset is sent")
    # ---- R0 read-only baseline
    ctx.log("R0: read-only baseline (nothing is reset yet)")
    trip.enter_reset_mode()
    ctx.ensure_backups()                                    # fs.stat / fs.get of the configured backup files into the backup dir
    bad = ctx.verify_backups()                              # ... and compare by hash
    ctx.expect("R0 backup files on the board equal the host copies (by hash)", not bad,
               ", ".join("%s=%s" % (b["name"], b["status"]) for b in ctx.backups) or "no backup files configured")
    if bad:
        raise ResetAbort("R0: backup files differ from the host copies before any reset: %s" % bad)
    man0 = _manifest(ctx)
    rep["baseline"] = {"identity": base_ident, "manifest_entries": len(man0)}
    trip.check("R0 baseline")
    ctx.expect("R0 tripwire baseline in reset-expected mode", True,
               "ticks_ms=%d reset_cause=%d; %d manifest entries" % (trip.last.ticks, trip.last.cause, len(man0)))
    # ---- R1 capability
    cap = _refresh_capability(ctx, rep, "R1")
    ctx.log("R1 reset.capability = " + json.dumps(cap, sort_keys=True))
    ctx.expect("R1 reset.capability read and recorded", isinstance(cap.get("hard"), dict) and isinstance(cap.get("machine"), dict),
               "hard=%s machine=%s" % ((cap.get("hard") or {}).get("state"), (cap.get("machine") or {}).get("available")))
    steps, skipped = plan_steps(cap, gate.budget)
    rep["skipped"].extend(skipped)
    for s in skipped:
        ctx.log("plan: skip %s - %s" % (s["tier"], s["reason"]))
    n = len(steps)
    ctx.log("plan: %d reset request(s), %d of them chip resets (budget %d); each is announced, then %.1f s pass before it is sent"
            % (n, len([s for s in steps if s.chip]), gate.budget, ctx.reset_wait_s))
    flags = {"machine_off": False, "hard_off": False}
    # ---- R2..R4
    for i, step in enumerate(steps, 1):
        if step.chip:
            cap = _refresh_capability(ctx, rep, "RESET %d/%d %s" % (i, n, step.tier))     # "the capability just read": the gate demands a read after the last chip reset
            if step.op == confine.OP_RESET_MACHINE:
                if flags["machine_off"]:
                    rep["skipped"].append({"tier": step.tier, "reason": "reset.machine answered unsupported earlier"})
                    continue
                if (cap.get("machine") or {}).get("available") is not True:
                    rep["skipped"].append({"tier": step.tier, "reason": "reset.machine is no longer available: %s" % (cap.get("machine") or {}).get("reason")})
                    ctx.log("R3: skip %s - %s" % (step.tier, rep["skipped"][-1]["reason"]))
                    continue
            else:
                hard = cap.get("hard") or {}
                if flags["hard_off"] or hard.get("state") not in ("verified", "likely"):
                    reason = ("the hard reset verification found nothing or was inconclusive" if flags["hard_off"]
                              else "hard.state=%r (%s)" % (hard.get("state"), hard.get("reason")))
                    rep["skipped"].append({"tier": step.tier, "reason": "not attempted: %s; never forced" % reason})
                    ctx.log("R4: skip %s - %s" % (step.tier, rep["skipped"][-1]["reason"]))
                    continue
        _run_step(ctx, gate, rep, step, i, n, base_ident, flags)
    # ---- R5 final
    ctx.log("R5: final checks")
    problems = []
    try:
        _check_identity(ctx, base_ident, "at the end")
    except ResetAbort as exc:
        problems.append(exc.reason)
    diff = _diff_manifest(man0, _manifest(ctx))
    if diff:
        problems.append("the root manifest changed: %s" % "; ".join(diff[:5]))
    bad = ctx.verify_backups()
    if bad:
        problems.append("backup files differ from the host copies: %s" % bad)
    if not ctx.await_idle(5.0):
        problems.append("the board is not idle at the end (state=%s)" % ctx.state())
    if c.policy.active_runs:
        problems.append("a program is running")
    reading = trip.check("R5 final")
    ctx.expect("R5 identity and manifest unchanged, backups unchanged, board idle, no program running", not problems,
               "; ".join(problems) or "ticks_ms=%d" % reading.ticks)
    if problems:
        raise ResetAbort("R5: " + "; ".join(problems))
