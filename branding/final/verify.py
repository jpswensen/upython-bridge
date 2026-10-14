#!/usr/bin/env python3
"""Dev-only checks for the uPython Bridge brand kit. Stdlib + `rsvg-convert` + `magick` (pixel probes).

Run from anywhere:  python3 -I verify.py
Exit status 1 when a hard rule fails. Lines starting with "info" are measurements, not rules.
"""
import importlib.util
import json
import os
import re
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True  # importing palette-contrast.py must not leave __pycache__ behind
HERE = os.path.dirname(os.path.abspath(__file__))
FAILS = []


def check(ok, what):
    print(("PASS  " if ok else "FAIL  ") + what)
    if not ok:
        FAILS.append(what)


def info(what):
    print("info  " + what)


def path(name):
    return os.path.join(HERE, name)


def read(name):
    with open(path(name), encoding="utf-8") as fh:
        return fh.read()


def png_size(name):
    with open(path(name), "rb") as fh:
        head = fh.read(24)
    return struct.unpack(">II", head[16:24])


def tag(el):
    return el.tag.split("}")[-1]


# ---------------------------------------------------------------- 0. files
SVGS = ["mark.svg", "activitybar.svg", "terminal-tab-light.svg", "terminal-tab-dark.svg",
        "trash-danger-light.svg", "trash-danger-dark.svg", "banner.svg"]
PNGS = ["icon-512.png", "icon-256.png", "icon-128.png", "banner-1280x640.png", "preview.png"]
OTHER = ["palette.json", "palette-contrast.py", "build.sh", "verify.py", "README.md"]
for name in SVGS + PNGS + OTHER:
    check(os.path.isfile(path(name)), "deliverable present: " + name)

# ---------------------------------------------------------------- 1. XML
trees = {}
for name in SVGS:
    try:
        trees[name] = ET.parse(path(name)).getroot()
        check(True, name + " is well-formed XML")
    except (ET.ParseError, OSError) as exc:
        check(False, name + " XML error: " + str(exc))
if FAILS:
    print("\nstopping: files missing or malformed")
    sys.exit(1)

BANNED = ("stroke", "linearGradient", "radialGradient", "<text", "<image", "clipPath", "mask", "filter",
          "<style", "<use", "pattern", "opacity", "font")

# ---------------------------------------------------------------- 2. activity-bar glyph (mono, mask-safe)
src = read("activitybar.svg")
root = trees["activitybar.svg"]
check(root.get("viewBox") == "0 0 24 24", "activitybar.svg viewBox is 0 0 24 24")
check({tag(e) for e in root.iter()} <= {"svg", "path"}, "activitybar.svg uses only <svg> and <path>")
check(all(e.get("fill") == "currentColor" for e in root.iter() if tag(e) == "path"),
      "activitybar.svg: every path has fill=\"currentColor\" (one flat colour)")
check(not any(b in src for b in BANNED), "activitybar.svg: no stroke/gradient/text/image/clip/mask/filter/opacity")
check(not re.search(r"#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(", src), "activitybar.svg: no literal colour")
check(len(src.encode()) <= 2048, "activitybar.svg size %d B <= 2048 B" % len(src.encode()))
ab_paths = [e.get("d") for e in root.iter() if tag(e) == "path"]

# ---------------------------------------------------------------- 3. terminal-tab and trash (fixed colour)
FIXED = {"terminal-tab-light.svg": "#424242", "terminal-tab-dark.svg": "#C5C5C5",
         "trash-danger-light.svg": "#D13438", "trash-danger-dark.svg": "#F48771"}
for name, col in FIXED.items():
    s, r = read(name), trees[name]
    check(r.get("viewBox") == "0 0 16 16", name + " viewBox is 0 0 16 16")
    check("currentColor" not in s, name + " contains no currentColor")
    fills = {e.get("fill") for e in r.iter() if tag(e) == "path"}
    check(fills == {col}, name + " fill is exactly %s (found %s)" % (col, sorted(f or "none" for f in fills)))
    check(not re.search(r"#[0-9a-fA-F]{3,8}\b", s.replace(col, "")), name + " has no other colour")
    check(not any(b in s for b in BANNED), name + " has no stroke/gradient/text/image/clip/mask/filter/opacity")
    check({tag(e) for e in r.iter()} <= {"svg", "path"}, name + " uses only <svg> and <path>")
    limit = 1024
    check(len(s.encode()) <= limit, name + " size %d B <= %d B" % (len(s.encode()), limit))
for a, b in (("terminal-tab-light.svg", "terminal-tab-dark.svg"), ("trash-danger-light.svg", "trash-danger-dark.svg")):
    da = [e.get("d") for e in trees[a].iter() if tag(e) == "path"]
    db = [e.get("d") for e in trees[b].iter() if tag(e) == "path"]
    check(da == db, "%s and %s have identical shapes (only the fill differs)" % (a, b))
old_trash = os.path.join(HERE, "..", "..", "media", "trash-red.svg")
if os.path.isfile(old_trash):
    with open(old_trash, encoding="utf-8") as fh:
        old = fh.read()
    new = read("trash-danger-light.svg")
    old_ds = set(re.findall(r'\bd="([^"]+)"', old))
    new_ds = set(re.findall(r'\bd="([^"]+)"', new))
    check(not (old_ds & new_ds) and "stroke" not in new and "stroke" in old,
          "trash-danger-*.svg shares no path data with the old trash-red.svg and is filled, not stroked")
else:
    info("old media/trash-red.svg not found; skipped the difference check")

# ---------------------------------------------------------------- 4. colour master
src = read("mark.svg")
root = trees["mark.svg"]
check(len(src.encode()) <= 6144, "mark.svg size %d B <= 6144 B" % len(src.encode()))
check("<image" not in src and "<text" not in src and "font" not in src, "mark.svg has no <image>, no <text>, no font")
pal = json.load(open(path("palette.json"), encoding="utf-8"))
used = {c.upper() for c in re.findall(r"#[0-9a-fA-F]{6}", src)}
known = {c.upper() for c in pal["colors"].values()}
check(used <= known, "mark.svg colours %s are all in palette.json" % sorted(used))
check(used == {"#0E5968", "#2A7A8B", "#FFB347", "#FFF1D6"}, "mark.svg uses exactly teal, rim, amber, cream")
mark_ds = [e.get("d") for e in root.iter() if tag(e) == "path"]
check(sorted(mark_ds) == sorted(ab_paths),
      "family check: the amber and cream paths of mark.svg are the same path data as activitybar.svg")
for name in ("mark.svg", "activitybar.svg", "terminal-tab-light.svg", "terminal-tab-dark.svg",
             "trash-danger-light.svg", "trash-danger-dark.svg"):
    t = read(name)
    check("<text" not in t and "font-family" not in t, name + " carries no text and no font (icons are text-free)")
bt = "".join(trees["banner.svg"].itertext())
check("μPython Bridge" in bt, "banner.svg wordmark contains the Greek small mu (U+03BC) followed by Python Bridge")
check("MicroPython" in bt and "VS Code" in bt, "banner.svg subtitle present")

# ---------------------------------------------------------------- 5. PNG sizes
for name, dim in (("icon-512.png", (512, 512)), ("icon-256.png", (256, 256)), ("icon-128.png", (128, 128)),
                  ("banner-1280x640.png", (1280, 640))):
    check(png_size(name) == dim, "%s is %dx%d" % (name, dim[0], dim[1]))
size256 = os.path.getsize(path("icon-256.png"))
check(size256 <= 40 * 1024, "icon-256.png size %d B <= 40 KB" % size256)
w, h = png_size("preview.png")
check((w, h) == (1280, 560), "preview.png is 1280x560 (got %dx%d)" % (w, h))


def run(cmd, data=None):
    return subprocess.run(cmd, input=data, capture_output=True, timeout=60, check=True).stdout


for name in ("icon-512.png", "icon-256.png", "icon-128.png"):
    a_corner = run(["magick", path(name), "-format", "%[fx:p{0,0}.a]", "info:"]).decode().strip()
    a_mid = run(["magick", path(name), "-format", "%[fx:p{w/2,h/2}.a]", "info:"]).decode().strip()
    check(float(a_corner) == 0.0 and float(a_mid) == 1.0,
          "%s has transparent corners (alpha %s) and an opaque centre (alpha %s)" % (name, a_corner, a_mid))

# ---------------------------------------------------------------- 6. contrast (WCAG), recomputed from palette.json
spec = importlib.util.spec_from_file_location("pc", path("palette-contrast.py"))
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)
for pair in pal["pairs"]:
    r = pc.ratio(pal["colors"][pair["fg"]], pal["colors"][pair["bg"]])
    check(r >= pair["min"], "contrast %s on %s = %.2f (min %.1f)" % (pair["fg"], pair["bg"], r, pair["min"]))
for fixed, key in (("terminal-tab-light.svg", "terminal-light"), ("terminal-tab-dark.svg", "terminal-dark"),
                   ("trash-danger-light.svg", "danger-light"), ("trash-danger-dark.svg", "danger-dark")):
    check(FIXED[fixed].upper() == pal["colors"][key].upper(), "%s fill equals palette %s" % (fixed, key))


# ---------------------------------------------------------------- 7. pixel probes: mono glyphs
def alpha_grid(svg, px):
    png = run(["rsvg-convert", "-w", str(px), "-h", str(px), path(svg)])
    out = run(["magick", "png:-", "-alpha", "extract", "-threshold", "50%", "-compress", "none", "pgm:-"],
              png).decode().split()
    wd, ht = int(out[1]), int(out[2])
    vals = [int(v) > 0 for v in out[4:]]
    return [vals[r * wd:(r + 1) * wd] for r in range(ht)]


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
    inner, cur, seen = [], 0, False
    for v in line:
        if v:
            if seen and cur:
                inner.append(cur)
            seen, cur = True, 0
        elif seen:
            cur += 1
    return inner


def u(lst, scale):
    return [round(v / scale, 2) for v in lst]


for svg, grid, scale, pad, minw in (("activitybar.svg", 24, 20, 2, 1.5), ("terminal-tab-light.svg", 16, 30, 1, 1.5)):
    g = alpha_grid(svg, grid * scale)
    rows = [r for r, line in enumerate(g) if any(line)]
    cols = [c for c in range(grid * scale) if any(line[c] for line in g)]
    x0, x1, y0, y1 = cols[0] / scale, (cols[-1] + 1) / scale, rows[0] / scale, (rows[-1] + 1) / scale
    check(min(x0, y0) >= pad - 1e-6 and max(x1, y1) <= grid - pad + 1e-6,
          "%s content box x %.2f..%.2f y %.2f..%.2f keeps %d units padding" % (svg, x0, x1, y0, y1, pad))
    # probes: tower row, flat-cable column, deck row (positions chosen from the construction grid)
    if grid == 24:
        tower_row, cable_col, deck_row = 3.5, 10.5, 16.0
    else:
        tower_row, cable_col, deck_row = 2.5, 6.5, 11.0
    tr = g[int(tower_row * scale)]
    cc = [line[int(cable_col * scale)] for line in g]
    dr = g[int(deck_row * scale)]
    info("%s tower row y=%.1f solid %s gaps %s" % (svg, tower_row, u(runs(tr), scale), u(gaps(tr), scale)))
    info("%s column x=%.1f solid %s gaps %s" % (svg, cable_col, u(runs(cc), scale), u(gaps(cc), scale)))
    info("%s deck row y=%.1f solid %s gaps %s" % (svg, deck_row, u(runs(dr), scale), u(gaps(dr), scale)))
    allv = runs(tr) + runs(cc) + runs(dr) + gaps(tr) + gaps(cc) + gaps(dr)
    check(min(allv) / scale >= minw, "%s thinnest probed solid or gap >= %.1f units (%.2f)" % (svg, minw, min(allv) / scale))
    if grid == 24:
        cg = gaps(cc)
        check(cg and min(cg) / scale >= 2.5, "%s cable-to-deck gap >= 2.5 units (%.2f)" % (svg, min(cg) / scale))
        dg = gaps(dr)
        check(dg and min(dg) / scale >= 2.5, "%s descender-to-deck gap >= 2.5 units (%.2f)" % (svg, min(dg) / scale))
        check(len(runs(tr)) == 2 and all(v / scale >= 3 - 1e-6 for v in runs(tr)), "%s two towers, each >= 3 units wide" % svg)
        check(len(runs(cc)) == 2, "%s centre column x=10.5 shows cable and deck as two separate bars (solid %s)" % (svg, u(runs(cc), scale)))
    else:
        cg = gaps(cc)
        check(cg and min(cg) / scale >= 1.5, "%s cable-to-deck gap >= 1.5 units (%.2f)" % (svg, min(cg) / scale))


# ---------------------------------------------------------------- 8. pixel probes: colour mark at small sizes
def rgba(svg, px):
    raw = run(["rsvg-convert", "-w", str(px), "-h", str(px), path(svg)])
    raw = run(["magick", "png:-", "-depth", "8", "rgba:-"], raw)
    return [[tuple(raw[(y * px + x) * 4:(y * px + x) * 4 + 4]) for x in range(px)] for y in range(px)]


def over(px, bg):
    a = px[3] / 255.0
    return tuple(a * px[i] + (1 - a) * bg[i] for i in range(3))


def hexrgb(hx):
    return tuple(int(hx[i:i + 2], 16) for i in (1, 3, 5))


def lum(rgb):
    return 0.2126 * pc.channel(rgb[0]) + 0.7152 * pc.channel(rgb[1]) + 0.0722 * pc.channel(rgb[2])


def cr(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


# 8a. tile edge on dark surfaces: first pixel of the middle row, composited over #1E1E1E and #252526
for px_size, need in ((256, 3.0), (128, 3.0), (64, 3.0), (48, 2.5), (32, 2.5)):
    grid = rgba("mark.svg", px_size)
    for bgname in ("surface-near-black", "vscode-sidebar-dark"):
        bg = hexrgb(pal["colors"][bgname])
        edge = over(grid[px_size // 2][0], bg)
        r = cr(edge, bg)
        check(r >= need, "tile edge pixel at %d px on %s: %.2f:1 (need >= %.1f; plain tile was 2.10:1)" % (px_size, bgname, r, need))


# 8b. hangers stay distinct (>= 3 separate cream peaks between the cable and the deck) at 64/48/32 px
def hanger_peaks(svg, px_size, y_units, x0_units, x1_units, scale, off):
    grid = rgba(svg, px_size)
    row = int((off + y_units * scale) * px_size / 512.0)
    xa = int((off + x0_units * scale) * px_size / 512.0)
    xb = int((off + x1_units * scale) * px_size / 512.0) + 1
    ys = [lum(over(grid[row][x], (0, 0, 0))) for x in range(xa, xb)]
    teal, cream = lum(hexrgb("#0E5968")), lum(hexrgb("#FFF1D6"))
    rng = cream - teal
    bright = teal + 0.35 * rng
    peaks, cur = [], None
    for i, v in enumerate(ys):
        if v >= bright:
            cur = [i, i, v] if cur is None else [cur[0], i, max(cur[2], v)]
        elif cur is not None:
            peaks.append(cur)
            cur = None
    if cur is not None:
        peaks.append(cur)
    distinct = 0
    for k, pk in enumerate(peaks):
        if k == 0:
            distinct += 1
            continue
        valley = min(ys[peaks[k - 1][1]:pk[0] + 1])
        if valley <= min(peaks[k - 1][2], pk[2]) - 0.15 * rng:
            distinct += 1
    return distinct, row, [round(v, 2) for v in ys]


for px_size in (64, 48, 32):
    n_new, row, prof = hanger_peaks("mark.svg", px_size, 13.7, 8.0, 15.7, 19.5, 22)
    info("mark.svg at %d px, hanger row %d: luminance swing %.2f of a possible 0.81 (3 bold hangers)" % (px_size, row, max(prof) - min(prof)))
    check(n_new >= 3, "mark.svg hangers at %d px: %d distinct cream peaks on pixel row %d (need >= 3)" % (px_size, n_new, row))
old_mark = os.path.join(HERE, "..", "a-arch-mu", "mark.svg")
if os.path.isfile(old_mark):
    teal, cream = lum(hexrgb("#0E5968")), lum(hexrgb("#FFF1D6"))
    for px_size in (64, 48, 32):
        # same kind of probe on concept A (5 thin hangers; row 302.6 and span 186..339 come from its own transform)
        raw = run(["rsvg-convert", "-w", str(px_size), "-h", str(px_size), old_mark])
        raw = run(["magick", "png:-", "-depth", "8", "rgba:-"], raw)
        row = int(302.6 * px_size / 512)
        xa, xb = int(186 * px_size / 512), int(339 * px_size / 512) + 1
        ys = [lum(over(tuple(raw[(row * px_size + x) * 4:(row * px_size + x) * 4 + 4]), (0, 0, 0))) for x in range(xa, xb)]
        info("concept A mark at %d px, hanger row %d: luminance swing %.2f of a possible %.2f (5 thin hangers)" % (
            px_size, row, max(ys) - min(ys), cream - teal))

print()
print("ALL HARD RULES PASS" if not FAILS else "%d FAILURE(S)" % len(FAILS))
sys.exit(1 if FAILS else 0)
