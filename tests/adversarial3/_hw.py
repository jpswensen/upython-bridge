"""Shared helpers for the tripwire-and-cleanup review of tools/hwtest (fake boards only; nothing here can reach a device)."""
from __future__ import annotations

import io
import json
import os
import signal
import sys
import glob
import threading
import time

from tests import test_hwtest as T
from tools.hwtest import run_hw

ACME = T.ACME_CFG
SCRATCH = T.SCRATCH
pid_alive = T.pid_alive


class Result(T.RunResult):
    raw = None
    elapsed = 0.0
    board_events = None

    def event_names_after(self, mark):
        return [e["ev"] for e in list(self.board.events)[mark:]]


class HarnessMixin(T.TmpMixin):
    """go(): run the whole harness in-process against a fake board with hooks; returns a Result with snapshots."""

    def go(self, profile="esp32", phases_="A,B,C,D,E", faults=(), cfg=None, hooks=None, soak=(2, 3), extra=(), backup_dir=None,
           spawn_wrap=None):
        base = self.tmpdir()
        argv = ["--fake", profile, "--phases", phases_, "--report", os.path.join(base, "reports"),
                "--backup-dir", backup_dir or os.path.join(base, "backup"),
                "--config", self.write_cfg(ACME if cfg is None else cfg)]
        for f in faults:
            argv += ["--fake-fault", f]
        argv += list(extra)
        box = {}
        h = dict(hooks or {})
        user_on_board, user_before_stop = h.get("on_board"), h.get("before_stop")

        def on_board(b):
            box["board"] = b
            if user_on_board:
                user_on_board(b)
            box["initial"] = T.snapshot(b)
            box["mark"] = len(b.events)

        def before_stop(b):
            box["final"] = T.snapshot(b)
            if user_before_stop:
                user_before_stop(b)

        h["on_board"], h["before_stop"] = on_board, before_stop
        h.setdefault("soak", soak)

        def spawn(port, real_port):
            assert real_port is None, "a fake run must never get a real port"
            c = run_hw.default_spawn(port, real_port)
            box["raw"] = c
            if spawn_wrap:
                spawn_wrap(c)
            return c

        out = io.StringIO()
        t0 = time.monotonic()
        code = run_hw.main(list(argv), spawn=spawn, environ={"MPY_SAFE_MODE": "1"}, stdout=out, test_hooks=h, lsof=lambda p: [])
        elapsed = time.monotonic() - t0
        dirs = sorted(glob.glob(os.path.join(base, "reports", "*")))
        report = None
        if dirs and os.path.exists(os.path.join(dirs[-1], "report.json")):
            with open(os.path.join(dirs[-1], "report.json"), encoding="utf-8") as f:
                report = json.load(f)
        r = Result(code, out.getvalue(), report, box.get("board"), box.get("initial"), box.get("final"), base)
        r.raw, r.elapsed, r.mark = box.get("raw"), elapsed, box.get("mark", 0)
        return r

    def brief(self, r):
        rep = r.report or {}
        return "code=%s outcome=%s trip=%s refused=%s residue=%s\n%s" % (
            r.code, rep.get("outcome"), rep.get("trip"), rep.get("refused"), rep.get("residue"), r.text[-1800:])


def at_op(op_name, n, action, extra_hooks=None):
    """Hooks that call ``action(board)`` just before the n-th ``op_name`` request leaves the harness."""
    st = {"n": 0}
    hooks = dict(extra_hooks or {})
    prev_on_board = hooks.get("on_board")

    def on_board(b):
        st["board"] = b
        if prev_on_board:
            prev_on_board(b)

    def on_send(op, args):
        if op == op_name:
            st["n"] += 1
            if st["n"] == n:
                action(st["board"])
    hooks["on_board"], hooks["on_send"] = on_board, on_send
    return hooks
