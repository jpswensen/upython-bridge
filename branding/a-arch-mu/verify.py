#!/usr/bin/env python3
"""Dev-only checks for concept A "Arch mu". Stdlib + `magick` (for the pixel probes).

Run from anywhere:  python3 -I verify.py
Exit status 1 when a hard rule fails.
"""
import importlib.util
import json
import os
import re
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
FAILS = []


def check(ok, what):
    print(("PASS  " if ok else "FAIL  ") + what)
    if not ok:
        FAILS.append(what)


def path(name):
    return os.path.join(HERE, name)


def png_size(name):
    with open(path(name), "rb") as fh:
        head = fh.read(24)
    return struct.unpack(">II", head[16:24])


# 1. well-formed XML
trees = {}
for name in ("mark.svg", "activitybar.svg", "terminal-tab.svg"):
    try:
        trees[name] = ET.parse(path(name)).getroot()
        check(True, name + " is well-formed XML")
    except ET.ParseError as exc:
        check(False, name + " XML error: " + str(exc))

# 2. mono glyph rules
BANNED = ("stroke", "linearGradient", "radialGradient", "text", "image", "clipPath", "mask",
          "filter", "style", "use", "pattern", "opacity")
for name, vb in (("activitybar.svg", "0 0 24 24"), ("terminal-tab.svg", "0 0 16 16")):
    root = trees[name]
    src = open(path(name), encoding="utf-8").read()
    check(root.get("viewBox") == vb, name + " viewBox is " + vb)
    tags = {el.tag.split("}")[-1] for el in root.iter()}
    check(tags <= {"svg", "path"}, name + " uses only <svg> and <path> (found %s)" % sorted(tags))
    fills = [el.get("fill") for el in root.iter() if el.tag.endswith("path")]
    check(all(f == "currentColor" for f in fills), name + " every path has fill=\"currentColor\"")
    check(not any(b in src for b in BANNED), name + " has no stroke/gradient/text/image/clip/mask/opacity")
    check(not re.search(r"#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(", src), name + " contains no literal colour")
    check(len(src.encode()) <= 2048, name + " size %d B <= 2048 B" % len(src.encode()))

# 3. colour master
src = open(path("mark.svg"), encoding="utf-8").read()
check(len(src.encode()) <= 6144, "mark.svg size %d B <= 6144 B" % len(src.encode()))
check("<image" not in src and "<text" not in src, "mark.svg has no <image> and no <text>")
pal = json.load(open(path("palette.json"), encoding="utf-8"))
used = {c.upper() for c in re.findall(r"#[0-9a-fA-F]{6}", src)}
known = {c.upper() for c in pal["colors"].values()}
check(used <= known, "mark.svg colours %s are all in palette.json" % sorted(used))

# 4. PNG sizes
check(png_size("icon-256.png") == (256, 256), "icon-256.png is 256x256")
check(png_size("icon-512.png") == (512, 512), "icon-512.png is 512x512")
size256 = os.path.getsize(path("icon-256.png"))
check(size256 <= 40 * 1024, "icon-256.png size %d B <= 40 KB" % size256)

# 5. contrast (WCAG), recomputed here from palette.json
spec = importlib.util.spec_from_file_location("pc", path("palette-contrast.py"))
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)
for pair in pal["pairs"]:
    r = pc.ratio(pal["colors"][pair["fg"]], pal["colors"][pair["bg"]])
    check(r >= pair["min"], "contrast %s on %s = %.2f (min %.1f)" % (pair["fg"], pair["bg"], r, pair["min"]))


# 6. pixel probes on the mono glyphs (rendered at 20x / 30x, alpha thresholded)
def alpha_grid(svg, px):
    png = subprocess.run(["rsvg-convert", "-w", str(px), "-h", str(px), path(svg)],
                         capture_output=True, timeout=60, check=True).stdout
    out = subprocess.run(
        ["magick", "png:-", "-alpha", "extract", "-threshold", "50%", "-compress", "none", "pgm:-"],
        input=png, capture_output=True, timeout=60, check=True).stdout.decode().split()
    w, h = int(out[1]), int(out[2])
    vals = [int(v) > 0 for v in out[4:]]
    return [vals[r * w:(r + 1) * w] for r in range(h)]


def runs(line):
    res, cur = [], 0
    for v in line:
        if v:
            cur += 1
        elif cur:
            res.append(cur)
            cur = 0
    if cur:
        res.append(cur)
    return res


def gaps(line):
    inner = []
    cur, seen = 0, False
    for v in line:
        if v:
            if seen and cur:
                inner.append(cur)
            seen, cur = True, 0
        elif seen:
            cur += 1
    return inner


for svg, grid, scale, pad in (("activitybar.svg", 24, 20, 2), ("terminal-tab.svg", 16, 30, 1)):
    g = alpha_grid(svg, grid * scale)
    rows = [r for r, line in enumerate(g) if any(line)]
    cols = [c for c in range(grid * scale) if any(line[c] for line in g)]
    x0, x1, y0, y1 = cols[0] / scale, (cols[-1] + 1) / scale, rows[0] / scale, (rows[-1] + 1) / scale
    check(min(x0, y0) >= pad - 1e-6 and max(x1, y1) <= grid - pad + 1e-6,
          "%s content box x %.2f..%.2f y %.2f..%.2f keeps %d units padding" % (svg, x0, x1, y0, y1, pad))
    mid = grid * scale // 2
    col = [line[mid] for line in g]
    r_c, g_c = runs(col), gaps(col)
    print("      %s centre column: solid runs %s units, gaps %s units" % (
        svg, [round(v / scale, 2) for v in r_c], [round(v / scale, 2) for v in g_c]))
    check(min(r_c + g_c) / scale >= 1.5, "%s centre column: thinnest solid or gap >= 1.5 units" % svg)
    tower_row = g[int(3.5 * scale)]
    print("      %s row y=3.5: solid runs %s units" % (svg, [round(v / scale, 2) for v in runs(tower_row)]))
    check(min(runs(tower_row)) / scale >= 1.5, "%s tower row: thinnest solid >= 1.5 units" % svg)

print()
print("ALL HARD RULES PASS" if not FAILS else "%d FAILURE(S)" % len(FAILS))
sys.exit(1 if FAILS else 0)
