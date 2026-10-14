# μPython Bridge: brand sheet (final, concept A "Arch mu")

Display name **μPython Bridge** (Greek small mu U+03BC + Python), Marketplace id `upython-bridge`, short ASCII form **uPy Bridge**.
Audience: sophomore engineering students, macOS and Windows. Every shape here is hand-authored SVG path data (no tracing, no font
inside any icon, no raster inside any SVG).

## The idea

The lowercase mu is a U-shaped bowl between two stems, with a descender on the left. A suspension bridge has the same skeleton: two towers
(the stems), a main cable sagging between them (the bowl) and a deck (the road). So the letter *is* the bridge:

- the left tower continues below the deck as the mu's **descender**;
- the right tower lands on the deck, and the deck carries on to the right as the mu's **tail** and as the road that connects the two sides
  (laptop and board), which is the "bridge" in the name;
- the cable is thinner than the towers (thick/thin contrast of a real mu);
- in the colour mark three cream **hangers** join cable and deck (they also read as header pins, the only circuit-board hint).

Teal and amber with a cream deck: warm, friendly, no terminal, hacker or snake imagery.

## What changed from concept A (and why)

| Critic finding | Fix | Measured or looked at |
| --- | --- | --- |
| (a) at 24/16 px "mu / H with a bowl": the deck crossed the left tower making a "+", narrow cable-to-deck gap | Deck now **stops 3 units short of the left tower** (the descender is a clean stem), and runs on past the right tower as a tail. Cable-to-deck gap 2 -> **3 units**. Bowl is a rounder U (inner radius 4) with a flat 2-row bottom that lands on whole pixels. Bridge reads from towers + cable + deck, mu from stem + bowl + descender + tail. | 19 distinct glyph variants rendered and viewed at 24 px, 48 px, 6x nearest-neighbour and 144 px smooth on #252526 and #F3F3F3 (see "What was looked at"). `verify.py` probes the pixel rows/columns: gaps 3.0 units, solid bars 2.0 and 3.0 units. |
| (b) five thin hangers alias below 64 px | **Three bold hangers** (1.5 units wide, 0.9 gap) instead of five thin ones | `verify.py` finds 3 separate cream peaks on the hanger pixel row at 64, 48 and 32 px (luminance swing 0.81, 0.81, 0.78 of a possible 0.81; concept A's same-kind probe: 0.61, 0.38, 0.16 at 64, 48, 32 px). |
| (c) terminal-tab icon must not rely on currentColor | **Two fixed-colour files**, `terminal-tab-light.svg` (#424242) and `terminal-tab-dark.svg` (#C5C5C5); no `currentColor` anywhere in them (checked) | `verify.py` |
| (d) tile edge 2.1:1 on dark surfaces | A **#2A7A8B rim, 10/512 wide** inside the tile edge (3.38:1 on #1E1E1E, 3.10:1 on #252526). Amber and cream untouched, so their contrast on the tile is unchanged. A first rim of 8/512 measured 2.47:1 at 32 px on #252526, so it was widened to 10. A lighter-top gradient was tried and **rejected**: amber against its lightest stop (#1B8497) is only 2.46:1. | Edge pixel measured on the rendered mark: 3.38:1 at 256/128/64 px, 3.29 at 48, 2.85 at 32 px on #1E1E1E; on #252526 3.10 / 3.10 / 3.10 / 3.02 / 2.62. The edge is therefore **not** 3:1 at 32 px on #252526 (2.62:1, still better than 2.1). |

Also new: the colour mark is built from **the same path data as the activity-bar glyph** (`verify.py` checks that the two path strings are
identical), so the two are one design, not two drawings. The mark is a little bigger inside the tile (the glyph box fills 76 % instead of 74 %).

## Files

| File | What | Where it is used in VS Code / the project |
| --- | --- | --- |
| `mark.svg` | colour master: tile (teal, rim) + mark (amber towers and cable, cream deck and hangers), 512 grid, under 1 KB | source of all colour PNGs |
| `icon-512.png` | master raster, RGBA, transparent corners outside the rounded tile (radius 112/512) | archive / store re-uploads |
| `icon-256.png` | about 8 KB | **Marketplace icon**: copy to `media/icon.png`, `package.json` `"icon": "media/icon.png"`. The listing shows about 128 px on the page header and about 32-64 px in lists |
| `icon-128.png` | | README logo / docs |
| `banner-1280x640.png` | the mark on a teal field, wordmark "μPython Bridge" and "Run, stop and sync your MicroPython board from VS Code" | top of README, social card. Only raster that carries text (rendered once from `banner.svg`) |
| `activitybar.svg` | 24x24 mono glyph, one flat colour `currentColor`, two paths, 387 B | **Activity-bar container icon** (`viewsContainers.activitybar[].icon`): copy to `media/activitybar.svg`. VS Code uses it as a mask, so inner detail is transparent gaps |
| `terminal-tab-light.svg`, `terminal-tab-dark.svg` | 16x16, fixed fill #424242 / #C5C5C5, same shape, 358 B each | **Run / REPL terminal tab**: `createTerminal({ iconPath: { light: Uri, dark: Uri } })` |
| `trash-danger-light.svg`, `trash-danger-dark.svg` | 16x16 filled bin, fixed red #D13438 / #F48771, 318 B each | **Danger icon** of "Clear Device Files" and "Delete": `commands[].icon = { "light": "...", "dark": "..." }`. Replaces the old red `trash-red.svg` |
| `palette.json`, `palette-contrast.py`, `palette-contrast.txt` | palette, pairs, WCAG ratios (the script rewrites the ratios into the json) | dev-only |
| `preview.png` | 1280x560 proof sheet, no labels (no fonts). Left: Marketplace icon 256/128/64/48/32 px on white (top) and #1E1E1E (bottom). Right, four bands: #252526 sidebar (glyph 24/48 px in #CCCCCC, dark trash 16/32), #F3F3F3 sidebar (glyph in #616161, light trash 16/32), #1E1E1E (dark terminal icon 16/32), white (light terminal icon 16/32) | dev-only |
| `banner.svg` | source of the banner PNG (contains the only text) | dev-only, **not** shipped |
| `build.sh`, `verify.py` | rebuild all rasters and the proof sheet; check every rule below | dev-only, **not** shipped |

Wiring for later (not done here; **[U]** not tried in a real VS Code, by rule): `package.json` `"icon": "media/icon.png"`,
`"galleryBanner": { "color": "#0E5968", "theme": "dark" }`; copy only `icon-256.png` (as `icon.png`), `activitybar.svg`,
`terminal-tab-*.svg`, `trash-danger-*.svg` into `media/`; keep everything else out of the VSIX (`.vscodeignore`).

## Palette

| Name | Hex | Role |
| --- | --- | --- |
| tile-teal | `#0E5968` | tile; gallery banner colour |
| tile-rim | `#2A7A8B` | 10-unit rim inside the tile edge (dark-surface edge) |
| bridge-amber | `#FFB347` | towers and cable |
| deck-cream | `#FFF1D6` | deck and hangers |
| banner-title / banner-subtitle | `#FFFFFF` / `#CDE7EC` | banner text only |
| terminal-light / terminal-dark | `#424242` / `#C5C5C5` | terminal-tab icon fixed fills |
| danger-light / danger-dark | `#D13438` / `#F48771` | trash icon fixed fills (destructive actions only) |

WCAG 2.x ratios (`palette-contrast.py`): amber on teal **4.45**, cream on teal **7.10**, tile on white **7.93**, rim on #1E1E1E **3.38**,
rim on #252526 **3.10**, plain tile on #1E1E1E 2.10 (why the rim exists), activity glyph #CCCCCC on #252526 **9.54** and #616161 on #F3F3F3 **5.58**
(VS Code chooses the real colour), terminal #424242 on white **10.05** and #C5C5C5 on #1E1E1E **9.66**, trash #D13438 on white **4.93** / on #F3F3F3 **4.44**
and #F48771 on #252526 **6.24** / on #1E1E1E **6.79**, banner title **7.93**, subtitle **6.13**. Amber on teal (4.45) is the weakest pair.

## Construction (so it can be redrawn by hand)

24 grid (activity bar): towers 3 wide, x 2..5 and 16..19, tops at y 2 with 1-unit corners; bowl = inner radius 4 (centres (9,6) and (12,6),
flat bottom y 10 between x 9 and 12), cable 2 thick (outer bottom y 12, outer radius 6); deck y 15..17, x 8..22 with round caps; right tower
ends flush with the deck bottom (y 17); left descender to y 22; gaps: cable to deck 3, descender to deck 3. Content box x 2..22, y 2..22
(the 2-unit padding VS Code asks for).
Colour mark: the same two paths inside `translate(22 22) scale(19.5)` on a 512 tile (radius 112), plus three hangers 1.5 wide at x 9.4, 11.8, 14.2
from y 11 (under the cable) to 15.2 (into the deck), drawn first so the cable covers their tops.
16 grid (terminal tab): towers 2 wide (x 1..3, 10..12), inner bowl radius 3, cable 2 thick, deck y 10..12 from x 5 to 15, descender to y 15, 1-unit padding.
Trash (16 grid): pill lid x 2..14 y 3..5, tab handle x 6..10 y 1..4, straight-sided body x 4..12 y 6..15 with two 1-unit slots; filled, no strokes.

## Minimum sizes and clear space

- Colour tile: **32 px is the floor** (three hangers still separate there, measured; they are only ticks). Not evaluated below 32 px, so do not use it smaller.
- Activity-bar glyph: 24 px (and 48 px for 2x). Terminal-tab icon and trash icon: 16 px.
- Clear space around the tile: at least 1/8 of its width (16 px around a 128 px tile). Bare mark without tile (only on the banner's teal field): one tower width (3 units).

## Do not

- Recolour the amber, cream, teal or rim; add outlines, shadows, glows or further gradients; rotate, skew, stretch or round the tile differently.
- Put the bare amber mark on white or on a busy photo (it is specified only on the teal tile or the teal banner field).
- Replace the mu by a typed "μ" or "u" inside an icon, or put any text in an icon.
- Use the hangers in a mono glyph (they would be thinner than 1.5 units), or the colour tile as a toolbar icon.
- Use `currentColor` in the terminal-tab or trash icons (VS Code takes separate light and dark files; these are fixed colour on purpose).
- Use the red trash icon for anything that is not destructive and confirmed.
- Place the MicroPython or Python logo next to it as if it were the same mark.

## Rebuild and check

```
./build.sh            # needs rsvg-convert and ImageMagick 7 (magick); regenerates icon-*.png, banner PNG, preview.png, palette-contrast.txt
python3 -I verify.py  # XML validity, mono-glyph rules, fixed colours, sizes, PNG dimensions and transparent corners,
                      # contrast >= 3:1 (>= 4.5:1 for text), tile edge on dark, hanger separation at 64/48/32 px, family check
```

The SVG masters are hand-authored and not regenerated by `build.sh`. The banner text is rendered with the system font Helvetica Neue
(falls back to Helvetica or Arial on a machine without it; the shipped PNG does not depend on any font).

## Licence and originality

Copyright (c) 2026 the project owner. Original artwork for this project, MIT like the code.
No MicroPython or Python marks are used: not the MicroPython logo, not the Python logo or its colours or snake motif, nothing from the old extension
(white snake on a PCB, chip-with-side-pins glyph, its red trash can), and nothing from VS Code, Espressif, Raspberry Pi or Arduino marks, nor any school
colours. The names MicroPython and Python appear only as words in the product name and tagline. No trademark search was made.

## What was looked at (evidence)

Rendered with `rsvg-convert` and viewed as PNG after every iteration: 19 distinct glyph variants over four rounds (concept A as reference; deck crossing the
left tower; deck stopping short; thick towers; shorter right tower; deck touching the left tower; lower deck; flat-bottom U cable; wider bowl;
inner radius 3 vs 4), each at 24 px, 48 px, 6x nearest-neighbour and 144 px smooth on #252526 (glyph #CCCCCC) and #F3F3F3 (glyph #616161);
8 colour-mark variants (5 thin hangers; 3 hangers in two widths; 4 hangers; no rim, rim 10, rim 8 with a lighter-top gradient; lighter-top gradient alone) at 256/128/64/48/32 px on white and #1E1E1E; the
final terminal and trash icons magnified 12x (nearest-neighbour) and at 16/32 px; `preview.png` and `banner-1280x640.png` after the final build.
**Not verified:** the icons inside a real VS Code (not launched), on a Windows display or a real Retina screen, the Marketplace listing at real size,
colour-blind simulation, a trademark search.

## What still looks weak (honest list)

- At 24 px the glyph reads first as "a small bridge frame" and only second as a mu: cable and deck are two horizontal bars, and the curved ends of the
  cable show as soft grey pixels at 1x (the flat bottom is crisp). The left descender and the tail carry the letter; the name next to the icon does the rest.
  The 16 px terminal icon is more abstract still.
- The tile rim shows as a visible lighter ring at 256 px, mostly on white: a deliberate cost for the edge on dark surfaces. On #252526 at 32 px the edge is still only 2.62:1.
- The three hangers are short stubs (3 units tall) that look like a comb or header pins; at 32 px they are ticks. They sit right of the bowl centre because
  the deck starts 3 units after the descender.
- Amber on teal (4.45:1) is the weakest palette pair; at a glance teal plus amber could still remind someone of Python's blue plus yellow.
- A suspension bridge is a common pictogram; the mu construction is the differentiator.
- The banner mu comes from the system font (a micro-sign style mu); it is not the mark's own mu, so the wordmark and the mark are related by idea, not by drawing.
- The trash bin is generic by nature; it differs from the old one (filled, straight-sided, pill lid, tab handle, slots) but is only judged at 16/32 px on this Mac's renderer.
