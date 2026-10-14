# Concept A - "Arch mu" (the Greek letter mu drawn as a suspension bridge)

Designed 2026-10-13 for the product name **μPython Bridge** (`upython-bridge`, short form `uPy Bridge`).
Every shape is authored here as plain SVG path data: nothing traced, nothing copied, no font, no raster.

## The idea

The lowercase mu is a U-shaped bowl with two stems and a descender on the left. A suspension bridge is the same
skeleton: two towers (the stems), a main cable sagging between them (the bowl) and a deck passing through the towers.
So the letter *is* the bridge:

- left tower runs below the deck as the mu's **descender** (this asymmetry is what makes it read as the letter, not an "H");
- right tower stops flush with the underside of the deck (the mu's right stem landing on its baseline);
- the cable is thinner than the towers (calligraphic thick/thin contrast of a real mu);
- five thin cream **hangers** between cable and deck double as a row of header pins (the only circuit-board hint);
- the deck is a rounded bar that runs past both towers, so it reads as a road that connects two sides
  (laptop and board), which is the "bridge" in the name.

Why it suits sophomore engineering students: it is a literal engineering object they already know (a bridge), warm
and friendly (rounded corners, amber and cream on teal), and carries no hacker, terminal or snake imagery.

## Files

| File | What | Notes |
| --- | --- | --- |
| `mark.svg` | colour master, tile + mark, 512 grid | 822 B; three colours only; has a `<title>` and one `transform` (scales the mark to about 74 % of the tile) |
| `icon-512.png`, `icon-256.png` | Marketplace icon (`"icon"` in package.json uses the 256) | RGBA, transparent corners outside the rounded tile (radius 112/512 = 21.9 %); 256 px file is 6.1 KB |
| `activitybar.svg` | 24x24 mono glyph, `fill="currentColor"` | 349 B; 2-unit padding; no strokes, gradients, opacity, clip, text or raster; a mask-safe shape made of two paths (towers plus cable, deck) |
| `terminal-tab.svg` | 16x16 mono glyph, simplified (same mark, no hangers) | 395 B; 1-unit padding |
| `palette.json`, `palette-contrast.py`, `palette-contrast.txt` | palette, pairs, WCAG ratios (the script rewrites the ratios into the json) | stdlib python |
| `preview.png` | 1280x600 proof sheet: left Marketplace icon at 256/128/64/32 px on white and on #1E1E1E; right activity-bar glyph 24/32/48 px and terminal glyph 16/32 px on #252526 (glyph #CCCCCC, top) and #F3F3F3 (glyph #616161, bottom) | no labels (no fonts used) |
| `build.sh` | regenerates the PNGs, preview.png and palette-contrast.txt (dev-only; needs `rsvg-convert` and `magick`) | `TMPDIR` may point to a scratch folder |
| `verify.py` | dev-only checker: XML, mono-glyph rules, sizes, contrast, padding, stroke and gap widths by pixel probe | `python3 -I verify.py` |

## Palette (hex)

| Name | Hex | Role |
| --- | --- | --- |
| tile-teal | `#0E5968` | tile background; also the suggested gallery banner |
| bridge-amber | `#FFB347` | towers and cable |
| deck-cream | `#FFF1D6` | deck and hangers |

Contrast (WCAG 2.x, computed by `palette-contrast.py`): amber on teal **4.45:1**, cream on teal **7.10:1** (rule was >= 3:1);
the mono glyphs on a typical dark sidebar (#CCCCCC on #252526) 9.54:1 and on a typical light one (#616161 on #F3F3F3) 5.58:1,
but VS Code chooses the real colour; tile edge against white 7.93:1, against #1E1E1E only **2.10:1** (informational).
Teal and amber are deliberately not Python's blue/yellow and not the old extension's red/white/gold.

**Gallery banner for package.json:** `"galleryBanner": { "color": "#0E5968", "theme": "dark" }`
(white text on it is 7.9:1).

## Usage rules

- **Minimum size.** Colour tile: 32 px is the floor (silhouette of two towers, bowl and deck survives; the hangers
  turn into texture below about 64 px, which is fine). Never below 24 px. Activity-bar glyph: 24 px. Terminal glyph: 16 px.
- **Clear space.** Keep at least 1/8 of the tile width free on every side (16 px around a 128 px tile). Bare mark
  without tile (rare): clear space = the width of one tower.
- **Always on its tile.** The amber/cream mark is only specified on the teal tile (4.45:1). Do not put the bare amber mark on white.
- **Mono uses** (activity bar, terminal tab, a README line icon): one colour from the theme, the glyph files as they are.
- **Do not:** recolour the amber or cream; add outlines, shadows, gradients or glows; rotate, skew or stretch;
  swap the mu for a typed "μ" or "u"; put the tile on a busy photo; add the MicroPython or Python logo next to it as if
  it were the same mark; round the tile more or less than 22 %; use the hangers in the mono glyphs (they would be thinner than 1.5 units).
- **Words.** The Greek letter lives only in the display name; the artwork carries no text.

## Wiring hints for later (not done here)

- package.json: `"icon": "media/icon.png"` (copy of `icon-256.png`), `"galleryBanner"` as above.
- Activity bar: `activitybar.svg` into `media/` unchanged (viewBox 24, mask-safe).
- Terminal tab: `terminal-tab.svg` follows the same single-colour rule. [U] whether VS Code themes a
  `currentColor` SVG given as terminal `iconPath`; if it renders black on dark themes, ship two copies with fixed fills
  (suggested #C5C5C5 / #424242). The glyph shape does not change.

## What was actually looked at (evidence)

Rendered with `rsvg-convert` and viewed as PNG after every iteration: 11 sketch variants over six rounds (plain mu; mu
with deck inside the bowl; arch variants; suspension with 5 thin hangers, 3 thick hangers, none; symmetric vs asymmetric
towers; three tile teals compared on white, #1E1E1E and #252526); the mono glyphs were checked magnified 8x with
nearest-neighbour scaling to see the 1x pixel result and then snapped to the pixel grid (cable, gap and deck are exactly
2 units; towers 3 units on the 24 grid, 2 units on the 16 grid). Not verified: how it looks inside a real VS Code (not launched,
by rule), nor on a Windows display, nor against a trademark search.

## Honest weaknesses

- At 24 px and especially 16 px the mono glyphs read as "a small bridge" first and as a mu only second; the left descender
  and the flush right tower carry the letter. The name next to the icon does the rest.
- The deck crossing the left tower makes a "+" junction; at 24 px 1x the cable-to-deck gap shows as slightly grey rows.
- Hangers are noise at 32 px (colour tile); the tile still reads as "two amber towers, bowl, cream deck".
- Dark tile on a dark surface has only 2.1:1 edge contrast; it works through hue, not through outline.
- Amber on teal (4.45:1) is the weakest pair in the palette. Teal plus amber is not Python's blue plus yellow, but a
  glance at a tiny size could still remind someone of that pairing.
- A suspension bridge is a common pictogram; the mu construction is the differentiator, and no trademark search was made.
- The mu is hand-built (no hook on the right stem), so it is a stylised letter, not a typographic one.
