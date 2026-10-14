#!/usr/bin/env python3
"""WCAG 2.x contrast ratios for palette.json (stdlib only, dev-only).

Reads palette.json, computes (L1 + 0.05) / (L2 + 0.05) for every pair, writes the
rounded ratio and a pass flag back into palette.json and prints a table.
Exit status 1 when a pair is below its own "min".
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "palette.json")


def channel(c):
    c = c / 255.0
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
        pal = json.load(fh)
    colours = pal["colors"]
    ok = True
    print("%-14s on %-20s %7s  %5s  use" % ("foreground", "background", "ratio", "min"))
    for pair in pal["pairs"]:
        r = ratio(colours[pair["fg"]], colours[pair["bg"]])
        pair["ratio"] = round(r, 2)
        pair["pass"] = r >= pair["min"]
        ok = ok and pair["pass"]
        print("%-14s on %-20s %7.2f  %5.1f  %s%s" % (
            pair["fg"], pair["bg"], r, pair["min"], pair["use"], "" if pair["pass"] else "  FAIL"))
    with open(PATH, "w", encoding="utf-8") as fh:
        json.dump(pal, fh, indent=2)
        fh.write("\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
