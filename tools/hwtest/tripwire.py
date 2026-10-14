"""tripwire.py - detects a chip reset under the harness (docs/hwtest-plan.md "Tripwire").

Probe (read-only ``exec``, prints only, leaves no names behind)::

    @@TRIP <time.ticks_ms()> <machine.reset_cause() or -1> <machine.SOFT_RESET or -1>

plus the config's ``extra_probes`` (recorded, never compared).  A reading is taken right after connect (baseline), before and
after every phase, and after every Stop / Run.  It TRIPS when

* ``ticks_ms`` goes backwards (modulo the ticks period), grows by more than the wall-clock time elapsed + 3 s, or grows by less
  than the wall-clock time between the two readings minus 1.5 s and 1% (0.3 s in the reset-expected mode of phase R; a board that restarted in between reads LESS uptime even
  when its new ticks are still above the old reading).  The same two bounds are applied against the BASELINE reading, so a board
  that restarts at every reconnect (each reading only slightly above the last) falls behind the wall clock and trips;
* ``reset_cause`` differs from the baseline (a soft-reset cause is accepted after the HARNESS itself ran a program, because
  ``run`` soft-resets into a fresh VM on ports that report that cause);
* at BASELINE the board's uptime is shorter than the harness session (``ticks_ms`` < time since the harness started, minus
  0.5 s) or shorter than ``BASELINE_MIN_UPTIME_MS`` (60 s): with no earlier reading a restart caused by the connect itself cannot be
  told from a freshly plugged board, and the baseline of a board that resets at every open would be post-reset, so the harness
  trips (exit 3, before anything was written) and the operator retries when the board has been up for a minute;
* at baseline the cause already reads SOFT_RESET although the harness has run nothing AND the board's uptime is under 30 s
  more than the harness session (a restart around connect; a SOFT_RESET cause with a long uptime, e.g. left by an earlier
  session on a port that keeps it, is accepted as the baseline);
* the bridge reports a ``state`` event with a reason containing ``board-reset`` or any response carried ``E_BOARD_RESET``.

``TripwireTripped`` carries the reasons; the orchestrator cleans up, exits 3 and writes TRIPPED in the report.

RESET-EXPECTED mode (phase R only, ``enter_reset_mode``): the harness itself causes chip resets.  After each one it calls
``after_caused_reset``, which reads the probe, requires that the board RESTARTED because of it (``ticks_ms`` below
``RESTART_MAX_UPTIME_MS`` and not larger than the time since the request was sent) and then makes that reading the new
baseline, so the restart is not a trip.  Every other restart (a ticks regression or a lag at a probe when no reset was just
issued, a changed reset_cause, a ``board-reset`` event after the baseline) still trips exactly as before; phase R turns such a
trip into "RESET PHASE ABORTED" (exit 5).
"""
from __future__ import annotations

import re
import time

from tools.hwtest.confine import DeadlineExceeded

__all__ = ["TRIP_PROBE", "Reading", "Tripwire", "TripwireTripped", "ProbeFailed", "evaluate", "TICKS_PERIOD", "BASELINE_MIN_UPTIME_MS",
           "RESTART_MAX_UPTIME_MS"]

TRIP_PROBE = ('print("@@TRIP", __import__("time").ticks_ms(), getattr(__import__("machine"), "reset_cause", lambda: -1)(), '
              'getattr(__import__("machine"), "SOFT_RESET", -1))')
TICKS_PERIOD = 1 << 30
GROWTH_SLACK_MS = 3000
LOWER_SLACK_MS = 1500           # ticks may lag the wall clock by this much + LOWER_SLACK_FRAC (clock rate error), no more
LOWER_SLACK_FRAC = 0.01
LOWER_SLACK_RESET_MS = 300      # phase R (reset-expected mode): the board was just restarted, so its uptime is small and a second
                                # restart within the next seconds must show as lag; the request windows already bound the elapsed
                                # time from below (wall_lo), what is left is ms rounding and clock rate, not seconds
UPTIME_SLACK_MS = 500
BASELINE_MIN_UPTIME_MS = 60000
FRESH_UPTIME_MS = 30000
RESTART_MAX_UPTIME_MS = 15000   # after a reset the harness caused, the first probe must read less uptime than this
RESTART_SLACK_MS = 1000
_RE_TRIP = re.compile(r"@@TRIP (-?\d+) (-?\d+) (-?\d+)")


class TripwireTripped(Exception):
    def __init__(self, reasons, label=""):
        self.reasons = list(reasons)
        self.label = label
        Exception.__init__(self, "TRIPWIRE at %s: %s" % (label, "; ".join(self.reasons)))


class ProbeFailed(Exception):
    """The probe itself could not be read: the safety net is missing, so the harness stops."""


class Reading(object):
    def __init__(self, label, ticks, cause, soft, t_sent, t_recv, extras=None):
        self.label, self.ticks, self.cause, self.soft = label, ticks, cause, soft
        self.t_sent, self.t_recv = t_sent, t_recv
        self.extras = extras or {}

    def as_dict(self):
        return {"label": self.label, "ticks_ms": self.ticks, "reset_cause": self.cause, "soft_reset_const": self.soft,
                "extras": self.extras}


def _pair_reasons(prev, cur, since_baseline=False, lower_slack_ms=LOWER_SLACK_MS):
    """Ticks consistency between two readings: not backwards, not faster than the wall clock + 3 s, not slower than it - 1.5 s - 1%
    (``lower_slack_ms`` 0.3 s in the reset-expected mode: after a caused restart the old uptime is small, so 1.5 s would hide a second one)."""
    where = " since the baseline" if since_baseline else ""
    d = (cur.ticks - prev.ticks) % TICKS_PERIOD
    if d > TICKS_PERIOD // 2:
        return ["ticks_ms went backwards (%d -> %d)%s" % (prev.ticks, cur.ticks, where)]
    wall_hi = (cur.t_recv - prev.t_sent) * 1000.0          # the true sampling times lie inside the two request windows,
    wall_lo = max(0.0, (cur.t_sent - prev.t_recv) * 1000.0)    # so the board's elapsed time lies in [wall_lo, wall_hi]
    if d > wall_hi + GROWTH_SLACK_MS:
        return ["ticks_ms grew by %d ms but only %d ms of wall clock passed%s" % (d, wall_hi, where)]
    if d < wall_lo - (lower_slack_ms + LOWER_SLACK_FRAC * wall_lo):
        return ["ticks_ms advanced only %d ms while at least %d ms of wall clock passed%s: the board restarted in between" % (
            d, wall_lo, where)]
    return []


def evaluate(prev, cur, baseline, session_t0, soft_expected, min_uptime_ms=BASELINE_MIN_UPTIME_MS, lower_slack_ms=LOWER_SLACK_MS):
    """Pure decision function: reasons (empty = fine) for ``cur`` given the previous reading and the baseline."""
    reasons = []
    since_start_ms = (cur.t_recv - session_t0) * 1000.0
    # baseline only (later readings are judged against the previous one and the baseline): a board that is younger than the
    # harness session, or than the floor, was restarted while we were connecting (or cannot be told from a fresh plug-in)
    if prev is None and cur.ticks + UPTIME_SLACK_MS < since_start_ms and since_start_ms < TICKS_PERIOD / 2:
        reasons.append("ticks_ms=%d is smaller than the %d ms since the harness started: the board restarted during this run"
                       % (cur.ticks, since_start_ms))
    elif prev is None and cur.ticks < min_uptime_ms:
        reasons.append("the board's uptime is only %d ms (< %d ms) at baseline: a reset caused by the connect cannot be ruled out "
                       "(wait until the board has been up for a minute and run again)" % (cur.ticks, min_uptime_ms))
    if prev is not None:
        reasons += _pair_reasons(prev, cur, False, lower_slack_ms)
        if baseline is not None and baseline is not prev and baseline is not cur:
            reasons += [r for r in _pair_reasons(baseline, cur, True, lower_slack_ms) if r not in reasons]
    if baseline is not None and cur is not baseline:
        soft_ok = soft_expected and cur.soft >= 0 and cur.cause == cur.soft
        if cur.cause != baseline.cause and not soft_ok:
            reasons.append("reset_cause changed from %d to %d" % (baseline.cause, cur.cause))
    elif baseline is None or cur is baseline:
        if cur.soft >= 0 and cur.cause == cur.soft and not soft_expected and cur.ticks < since_start_ms + FRESH_UPTIME_MS:
            reasons.append("reset_cause is SOFT_RESET (%d) at baseline although the harness ran nothing and the board has been "
                           "up only %d ms: it restarted around connect" % (cur.cause, cur.ticks))
    return reasons


class Tripwire(object):
    def __init__(self, client, extra_probes=(), session_t0=None, clock=time.monotonic, log=None,
                 min_uptime_ms=BASELINE_MIN_UPTIME_MS):
        self.client = client
        self.extra_probes = list(extra_probes)          # [{"name", "code", "before_after"}]
        self.session_t0 = clock() if session_t0 is None else session_t0
        self.clock = clock
        self.log = log or (lambda msg: None)
        self.baseline_reading = None
        self.last = None
        self.readings = []
        self.soft_expected = False
        self.trips = []
        self.min_uptime_ms = min_uptime_ms
        self.probe_trouble = False          # a probe failed or timed out: it may still be running on the board
        self.reset_mode = False             # phase R: restarts the harness causes are expected (see after_caused_reset)
        self.caused = []                    # [{label, ticks_ms, reset_cause, bridge_events}] one row per accepted caused restart
        self._event_mark = 0
        self._err_seen = 0

    # ---- reading
    def probe(self, label, with_extras=True):
        t_sent = self.clock()
        try:
            r = self.client.request("exec", _timeout=30.0, code=TRIP_PROBE, timeoutMs=15000)
        except BaseException:
            self.probe_trouble = True
            raise
        t_recv = self.clock()
        if not r.get("ok"):
            self.probe_trouble = True
            code = (r.get("error") or {}).get("code")
            if code == "E_BOARD_RESET":
                self.trips.append({"label": label, "reasons": ["the bridge answered E_BOARD_RESET to the tripwire probe"]})
                raise TripwireTripped(["the bridge answered E_BOARD_RESET to the tripwire probe"], label)
            raise ProbeFailed("tripwire probe failed at %s: %s" % (label, code))
        m = _RE_TRIP.search(r.get("out") or "")
        if not m:
            raise ProbeFailed("tripwire probe at %s printed no @@TRIP line (out=%r err=%r)" % (label, r.get("out"), r.get("err")))
        extras = {}
        if with_extras:
            for p in self.extra_probes:
                try:
                    e = self.client.request("exec", _timeout=30.0, code=p["code"], timeoutMs=15000)
                    extras[p["name"]] = (e.get("out") or "").strip() if e.get("ok") else "ERROR %s" % (e.get("error") or {}).get("code")
                except DeadlineExceeded:
                    raise
                except Exception as exc:                  # a failing optional probe must not stop the run
                    self.probe_trouble = True
                    extras[p["name"]] = "ERROR %s" % exc
        return Reading(label, int(m.group(1)), int(m.group(2)), int(m.group(3)), t_sent, t_recv, extras)

    def baseline(self, label="baseline"):
        self._event_mark = self.client.mark()
        reading = self.probe(label)
        self.baseline_reading = reading
        self.last = reading
        self.readings.append(reading)
        self.log("tripwire baseline: ticks_ms=%d reset_cause=%d" % (reading.ticks, reading.cause))
        reasons = evaluate(None, reading, None, self.session_t0, self.soft_expected, self.min_uptime_ms)
        reasons += self._bridge_signals()
        self._maybe_trip(reasons, label)
        return reading

    def check(self, label, with_extras=False):
        """Take a reading and compare it; raises TripwireTripped.  The board must be idle (exec is refused otherwise)."""
        if self.baseline_reading is None:
            return self.baseline(label)
        reading = self.probe(label, with_extras)
        reasons = evaluate(self.last, reading, self.baseline_reading, self.session_t0, self.soft_expected, self.min_uptime_ms,
                           LOWER_SLACK_RESET_MS if self.reset_mode else LOWER_SLACK_MS)
        reasons += self._bridge_signals()
        self.readings.append(reading)
        self.last = reading
        self._maybe_trip(reasons, label)
        return reading

    def enter_reset_mode(self):
        self.reset_mode = True

    def note_soft_reset(self):
        """The harness itself sent a soft reset (no chip reset, ticks must keep growing); a SOFT_RESET cause is expected now."""
        self.soft_expected = True

    def after_caused_reset(self, label, t_sent, max_uptime_ms=RESTART_MAX_UPTIME_MS):
        """Probe right after a chip reset THIS harness caused (``t_sent`` = clock reading when the request left).  Returns
        ``(reading, reasons)``.  With no reasons the reading is the new baseline and the bridge's reset state events are consumed;
        reasons mean the board did NOT restart because of that request (nothing is rebased; the caller aborts)."""
        if not self.reset_mode:
            raise RuntimeError("after_caused_reset outside the reset-expected mode")
        reading = self.probe(label)
        since_ms = (reading.t_recv - t_sent) * 1000.0
        reasons = []
        if reading.ticks >= max_uptime_ms:
            reasons.append("ticks_ms=%d (>= %d): the board did not restart" % (reading.ticks, max_uptime_ms))
        elif reading.ticks > since_ms + RESTART_SLACK_MS:
            reasons.append("ticks_ms=%d is larger than the %d ms since the reset was sent: the board's uptime predates the reset"
                           % (reading.ticks, since_ms))
        events = [{"state": e.get("state"), "reason": e.get("reason")} for e in self.client.events_of("state", self._event_mark)]
        if not reasons:
            self.caused.append({"label": label, "ticks_ms": reading.ticks, "reset_cause": reading.cause, "bridge_events": events})
            self.baseline_reading = reading
            self.last = reading
            self.readings.append(reading)
            self._event_mark = self.client.mark()
            self._err_seen = len(self.client.reset_errors)
            self.log("tripwire re-baselined after the reset this harness caused: ticks_ms=%d reset_cause=%d" % (reading.ticks, reading.cause))
        return reading, reasons

    def consume_events(self):
        """The bridge announces the reset op of THIS harness with state events (``board-reset``) even when it found no reset;
        phase R consumes the ones that fall inside the window of its own request.  The ticks/cause comparison still applies."""
        events = [{"state": e.get("state"), "reason": e.get("reason")} for e in self.client.events_of("state", self._event_mark)]
        self._event_mark = self.client.mark()
        self._err_seen = len(self.client.reset_errors)
        return events

    def note_program_run(self):
        """The harness itself soft-reset the board (run); a SOFT_RESET cause is expected from now on."""
        self.soft_expected = True

    def _bridge_signals(self):
        reasons = []
        for e in self.client.events_of("state", self._event_mark):
            if "board-reset" in str(e.get("reason", "")).lower():
                reasons.append("bridge reported state reason %r" % e.get("reason"))
        self._event_mark = self.client.mark()
        n = len(self.client.reset_errors)
        if n > self._err_seen:
            reasons.append("bridge answered E_BOARD_RESET (%d time(s))" % (n - self._err_seen))
            self._err_seen = n
        return reasons

    def _maybe_trip(self, reasons, label):
        if reasons:
            self.trips.append({"label": label, "reasons": reasons})
            raise TripwireTripped(reasons, label)

    def extras_snapshot(self, label):
        """Config probes only (before/after a phase), no comparison."""
        out = {}
        for p in self.extra_probes:
            if not p.get("before_after"):
                continue
            e = self.client.request("exec", _timeout=30.0, code=p["code"], timeoutMs=15000)
            out[p["name"]] = (e.get("out") or "").strip() if e.get("ok") else "ERROR %s" % (e.get("error") or {}).get("code")
        return {"label": label, "values": out}
