#!/usr/bin/env python3
"""WCAG 2.x contrast ratios for palette.json (stdlib only).

Reads palette.json, computes (L1 + 0.05) / (L2 + 0.05) for every pair, writes the
ratio back into each pair as "ratio", writes palette-contrast.txt, and exits 1 if a
pair with a numeric "min" falls below it. Run from anywhere: python3 palette-contrast.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def channel(c8):
    c = c8 / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_colour):
    h = hex_colour.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def ratio(fg, bg):
    l1, l2 = luminance(fg), luminance(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def main():
    path = os.path.join(HERE, "palette.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    colors = data["colors"]
    lines = ["WCAG contrast ratios (relative luminance formula, sRGB)", ""]
    failed = False
    for p in data["pairs"]:
        r = ratio(colors[p["fg"]], colors[p["bg"]])
        p["ratio"] = round(r, 2)
        need = p.get("min")
        if need is None:
            verdict = "info"
        elif r >= need:
            verdict = "PASS (>= %.1f)" % need
        else:
            verdict = "FAIL (< %.1f)" % need
            failed = True
        lines.append("%-28s on %-17s %6.2f : 1  %-14s %s" % (
            "%s %s" % (p["fg"], colors[p["fg"]]), "%s %s" % (p["bg"], colors[p["bg"]]), r, verdict, p["use"]))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    text = "\n".join(lines) + "\n"
    with open(os.path.join(HERE, "palette-contrast.txt"), "w", encoding="utf-8") as f:
        f.write(text)
    sys.stdout.write(text)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
