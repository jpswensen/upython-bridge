#!/usr/bin/env python3
"""Report board-/course-specific references in files that are meant to ship.

Release rule (instructor, 2026-10-12): board-specific material (the WSU_SHIELD firmware, its `shield`/`_shield` modules,
course names, the motor-shield hardware kit) is removed before the project is released; only the firmware is given to
students.  Generic code must therefore never depend on it.  See docs/board-specific-inventory.md.

    python3 tools/check_generic.py            # report (exit 0)
    python3 tools/check_generic.py --strict   # exit 1 if a MUST-BE-GENERIC file mentions board/course specifics

Stdlib only; reads files, never opens a serial port.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATTERN = re.compile(r"WSU|shield|ME401|ME241|motor shield|GPIO15|me401|WSU_SHIELD", re.IGNORECASE)
SKIP_DIRS = {".git", "node_modules", "__pycache__", "dist", "out"}
EXTS = {".py", ".ts", ".js", ".mjs", ".json", ".md", ".txt", ".yml", ".yaml"}

# Where board-specific material is ALLOWED to live (and is stripped from a release).
ALLOWED_PREFIXES = (
    "private/",                    # board/course-specific code, tests, profiles, hardware kit (to be created at extraction)
    "examples/profiles/wsu_shield/",
    "docs/analysis/",              # internal archive, not shipped
    "tools/prototypes/",           # provenance, not shipped
    "tools/hwkit/",                # WSU hardware kit: moves to private/wsu/hwkit at extraction
    "tools/hwtest/reports/", "tools/hwtest/backup/",
    "bridge/vendor/",
)
INTERNAL_DOCS = ("CLAUDE.md", "plan.md", "docs/decisions.md", "docs/requirements.md", "docs/spikes-and-questions.md",
                 "docs/old-defects.md", "docs/protocol.md", "docs/protocol-addendum-reset.md", "docs/board-specific-inventory.md",
                 "tests/README.md", "THIRD_PARTY_NOTICES", "tools/check_generic.py")
# Must be generic once extraction is done (shipping code and generic tests/tools).
MUST_BE_GENERIC_PREFIXES = ("bridge/", "src/", "tools/fakeboard.py", "tools/mpunix_relay.py", "tools/hwtest/", "tests/")


def classify(rel: str) -> str:
    if rel.startswith(ALLOWED_PREFIXES):
        return "allowed-private"
    if rel in INTERNAL_DOCS:
        return "internal-doc"
    if rel.startswith(MUST_BE_GENERIC_PREFIXES):
        return "MUST-BE-GENERIC"
    return "other"


def scan() -> list:
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if os.path.splitext(fn)[1] not in EXTS and fn not in ("THIRD_PARTY_NOTICES",):
                continue
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    n = sum(len(PATTERN.findall(line)) for line in f)
            except OSError:
                continue
            if n:
                out.append((classify(rel), rel, n))
    return sorted(out, key=lambda t: (t[0], -t[2], t[1]))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args(argv)
    rows = scan()
    bad = [r for r in rows if r[0] == "MUST-BE-GENERIC"]
    for cls in ("MUST-BE-GENERIC", "other", "internal-doc", "allowed-private"):
        sel = [r for r in rows if r[0] == cls]
        if not sel:
            continue
        print("== %s (%d files, %d mentions)" % (cls, len(sel), sum(r[2] for r in sel)))
        for _, rel, n in sel:
            print("   %4d  %s" % (n, rel))
    print("\n%d file(s) that must be generic still mention board/course specifics." % len(bad))
    return 1 if (a.strict and bad) else 0


if __name__ == "__main__":
    sys.exit(main())
