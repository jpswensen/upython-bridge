#!/usr/bin/env python3
"""WCAG 2.x contrast ratios for the pairs listed in palette.json.

Usage: python3 palette-contrast.py          (prints a table, writes the ratios back into palette.json)
Exit code 1 if a pair with required_min > 0 falls below its minimum.
Formula: L = 0.2126 R + 0.7152 G + 0.0722 B on linearised sRGB; ratio = (L1 + 0.05) / (L2 + 0.05), L1 >= L2.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "palette.json")


def channel(c8):
    c = c8 / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_colour):
    h = hex_colour.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def ratio(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def main():
    with open(PATH, encoding="utf-8") as fh:
        data = json.load(fh)
    colors = data["colors"]
    failed = False
    lines = []
    for p in data["pairs"]:
        r = ratio(colors[p["fg"]], colors[p["bg"]])
        p["ratio"] = round(r, 2)
        need = p.get("required_min", 0)
        ok = r >= need
        p["pass"] = ok if need else None
        failed = failed or not ok
        verdict = ("PASS" if ok else "FAIL") if need else "info"
        lines.append("%-5s %6.2f:1  need >= %-3s  %-14s on %-18s %s" % (
            verdict, r, need if need else "-", "%s %s" % (p["fg"], colors[p["fg"]]),
            "%s %s" % (p["bg"], colors[p["bg"]]), p["use"]))
    print("\n".join(lines))
    with open(PATH, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
