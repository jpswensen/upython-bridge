"""report.py - console transcript and JSON report of one harness run.

Files, in ``<reports base>/<UTC timestamp, e.g. 20261013T041500Z>/``: ``report.json`` and ``console.txt``.

report.json (``"schema": "mpy-hwtest-report/1"``)::

    {
      "schema": "mpy-hwtest-report/1",
      "outcome": "PASS" | "FAIL" | "TRIPPED" | "REFUSED" | "INTERRUPTED" | "ERROR" | "RESET_ABORTED",
      "exit_code": 0 | 1 | 3 | 4 | 5 | 130,      # 2 (guard / config refusal) happens before any report exists; 5 = RESET PHASE ABORTED
      "tripped": bool,                           # true => outcome is TRIPPED and exit_code 3
      "started_utc": "...Z", "finished_utc": "...Z", "elapsed_s": float,
      "mode": "real" | "url" | "pty" | "fake:<profile>",
      "port": str, "phases_requested": ["A", ...], "argv": [...],
      "config": {source, backup_files, expect, extra_probes, scratch, shadow_names, notes},
      "refused": null | {"phase": "A", "reason": str},       # exit 4: the harness left the board alone
      "trip": null | {"label": str, "reasons": [str]},
      "identity": {...} | null,                  # bridge identity result (impl, version, build, uniqueId, caps, ...)
      "phases": [{"id": "A", "name": str, "status": "pass"|"fail"|"skipped"|"refused", "elapsed_s": float,
                  "classes": [op classes this phase may send],
                  "checks": [{"name": str, "ok": bool, "detail": str}],
                  "metrics": {name: number|str}}],
      "tripwire": {"baseline": {...} | null, "readings": [{label, ticks_ms, reset_cause, soft_reset_const, extras}],
                   "trips": [{label, reasons}], "extras": [{label, values}]},
      "backups": [{"name": str, "status": "saved"|"absent", "bytes": int, "sha256": str, "local": str,
                   "verified_unchanged": bool|null}],
      "scratch": {"path": str, "created": bool, "removed": bool, "residue": bool},
      "cleanup": {"steps": [{"name": str, "ok": bool, "detail": str}], "residue": [str]},
      "ops": {"total": int, "by_class": {class: n}, "errors": [{op, code, n}], "log": [{n, op, class, ok, code, ms}]},
      "bridge": {"pid": int|null, "shutdown": "eof"|"terminate"|"kill"|null, "exit_code": int|null},
      "residue": [str],                          # anything left on the board / host; non-empty => exit_code 1 at least
      "notes": str,
      "reset": null | {                          # only when phase R was requested and passed every gate (see resetphase.py)
        "budget": int, "capability": {...} | null,            # the full R1 reset.capability result
        "capability_reads": [{"before": str, "result": {...}}],   # every read (the gate wants a fresh one before each chip reset)
        "baseline": {"identity": {...}, "manifest_entries": int},
        "steps": [{"i": int, "n": int, "tier": "soft"|"machine"|"hard verify"|"hard", "op": str, "args": {...}, "chip": bool,
                   "announcement": str, "announced_utc": str, "sent_utc": str|null, "recovered_utc": str|null,
                   "recovery_s": float|null, "ticks_ms_after": int|null, "reset_cause_after": int|null,
                   "verified": bool|null, "evidence": [str], "learned": str|null, "cacheKey": {...}|null, "method": str|null,
                   "portDropped": bool|null, "reconnect": bool|null, "bridge_events": [{state, reason}], "note": str,
                   "status": "announced"|"ok"|"unsupported"|"not-observed"|"aborted"}],
        "skipped": [{"tier": str, "reason": str}], "aborted": null | {"step": int|null, "reason": str},
        "ledger": [{"n": int, "op": str, "args": {...}, "chip_n": int|null, "cost": int, "pulses_max": int}],
        "summary": {"chip_resets_sent": int (what the board can have seen: sum of pulses_max, exact once a response proved the pulses),
                    "chip_requests_sent": int, "chip_budget_units_reserved": int (hard verify reserves 2), "chip_resets_observed": int,
                    "soft_resets_sent": int, "budget": int, "text": str}
      }
    }
"""
from __future__ import annotations

import datetime
import json
import os
import sys
import time

__all__ = ["Console", "Report", "utc_stamp", "utc_iso", "SCHEMA"]

SCHEMA = "mpy-hwtest-report/1"


def utc_stamp(now=None):
    return (now or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y%m%dT%H%M%SZ")


def utc_iso(now=None):
    return (now or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class Console(object):
    """Concise, time-stamped lines to ``stream`` (None = silent) and kept for console.txt."""

    def __init__(self, stream=None):
        self.stream = stream
        self.lines = []
        self.t0 = time.monotonic()

    def line(self, msg, tag=""):
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%S.%f")[:-3]
        text = "%s +%6.1fs %s%s" % (stamp, time.monotonic() - self.t0, ("[%s] " % tag) if tag else "", msg)
        text = text.encode("ascii", "backslashreplace").decode("ascii")          # any console codepage can print it
        self.lines.append(text)
        if self.stream is not None:
            try:
                self.stream.write(text + "\n")
                self.stream.flush()
            except (OSError, ValueError):
                pass
        return text


class Report(object):
    def __init__(self, mode, port, argv, phases_requested, config):
        self.data = {
            "schema": SCHEMA, "outcome": "ERROR", "exit_code": 1, "tripped": False,
            "started_utc": utc_iso(), "finished_utc": None, "elapsed_s": 0.0,
            "mode": mode, "port": port, "phases_requested": list(phases_requested), "argv": list(argv),
            "config": config, "refused": None, "trip": None, "identity": None, "phases": [],
            "tripwire": {"baseline": None, "readings": [], "trips": [], "extras": []},
            "backups": [], "scratch": {"path": None, "created": False, "removed": False, "residue": False},
            "cleanup": {"steps": [], "residue": []},
            "ops": {"total": 0, "by_class": {}, "errors": [], "log": []},
            "bridge": {"pid": None, "shutdown": None, "exit_code": None},
            "residue": [], "notes": config.get("notes", "") if isinstance(config, dict) else "",
            "reset": None,
        }
        self._t0 = time.monotonic()

    def finish(self, outcome, exit_code):
        self.data["outcome"] = outcome
        self.data["exit_code"] = exit_code
        self.data["tripped"] = outcome == "TRIPPED"
        self.data["finished_utc"] = utc_iso()
        self.data["elapsed_s"] = round(time.monotonic() - self._t0, 3)

    def write(self, directory, console):
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "report.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(self.data, f, indent=2, sort_keys=False, default=str)
            f.write("\n")
        with open(os.path.join(directory, "console.txt"), "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(console.lines) + "\n")
        return directory
