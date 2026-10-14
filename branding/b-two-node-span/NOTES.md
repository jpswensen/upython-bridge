# Concept B "Span" (b-two-node-span)

Two end nodes joined by a suspension-bridge span. Left node = the laptop (rounded block with a "screen" hole), right node = the board (squarer block with a small socket notch in its outer edge). Between them a sagging cable, three short hangers and a flat deck. Read as a picture: "a bridge between two devices", which is also the product name (μPython Bridge, short form uPy Bridge). No letters, no snake, no chip-with-pins: only rectangles, rounded rectangles and one quadratic Bezier band, authored from scratch as SVG paths.

Why it suits sophomore engineering students: a bridge is a familiar engineering object, so the picture explains the tool ("connects your laptop to the board") without looking like a hacker or terminal tool. Soft rounded shapes, indigo plus mint, no sharp or aggressive forms.

## Files

| File | What | Notes |
|---|---|---|
| `mark.svg` | colour master (tile + mark), 512 grid, 948 bytes | gradient tile allowed here only |
| `icon-512.png`, `icon-256.png` | Marketplace icon (`icon` in package.json uses the 256) | tile has its own rounded-square background (radius 112/512 = 22%), transparent corners |
| `activitybar.svg` | 24x24 monochrome glyph, `fill="currentColor"`, one path, 624 bytes | detail = transparent gaps (hole in the left node, notch in the right node); holes are wound opposite to the outline (nonzero), so overlapping parts of the span union cleanly |
| `terminal-tab.svg` | 16x16 monochrome, simplified (no hole, no notch, two hangers), 465 bytes | |
| `palette.json`, `palette-contrast.py`, `palette-contrast.txt` | named hex values, pairs, WCAG ratios | `python3 palette-contrast.py` recomputes and writes the ratios back into `palette.json` |
| `build.sh` | dev-only: regenerates `icon-512.png`, `icon-256.png`, `preview.png`, `glyph-zoom.png` from the SVGs (rsvg-convert + magick) | |
| `preview.png` | icon at 256/128/64/32 on white and near-black; activity-bar glyph 24/32/48 and terminal glyph 16/32 on #252526 (light grey #c5c5c5) and #f3f3f3 (dark grey #424242) | currentColor substituted in a temp copy |
| `glyph-zoom.png` | the two glyphs at 8x, a helper for editing paths | not shipped |

## Palette (see palette.json for ratios)

- Indigo tile: gradient `#3F3AA3` (top left) to `#27246F` (bottom right), 135 degrees.
- Mint mark: `#6FF2C4`, flat. Contrast on the tile 6.47:1 (lightest), 7.95:1 (middle), 9.68:1 (darkest); requirement was >= 3:1.
- Glyph colours are the host theme's, never ours (`currentColor`). Preview checks: #c5c5c5 on #252526 = 8.87:1, #424242 on #f3f3f3 = 9.06:1 (these are preview colours, not read from a real theme).
- Gallery banner suggestion for package.json: `"galleryBanner": { "color": "#1F1D5E", "theme": "dark" }`. Alternative that makes the tile stand out more: `{ "color": "#E3FBF3", "theme": "light" }`.

## Usage rules

- Minimum sizes: Marketplace icon (tile) 32 px; below that nothing but a smear is left (use the 16x16 terminal glyph instead). Mark without the tile: not smaller than 48 px wide. Activity-bar glyph is designed for 24 px, terminal-tab glyph for 16 px.
- Clear space: keep at least 1/8 of the tile width free around the tile (16 px at 128 px). Inside the tile the mark already sits 10% from the left and right edges; do not enlarge it.
- Always put the mark on its own indigo tile when it appears next to other artwork or on a photo. The bare mint mark is for the README header on a dark indigo field only.
- The Greek mu is not part of the artwork. In the README banner, set the words "μPython Bridge" next to the mark in the system font; never inside the icon.
- Do not: recolour the mark (especially no blue plus yellow, no red/white/gold), rotate or flip it, stretch it, add a drop shadow or outline, add a fourth hanger or more nodes, swap the two nodes, replace the notch with pins, put text in it, or use the activity-bar glyph as an app icon. Do not give the glyphs a colour: VS Code renders them as a mask in the theme foreground.

## Technical facts checked (see the report; all run from this folder)

SVGs parse as XML; the two glyphs contain a single `<path fill="currentColor">` and nothing else (no stroke, gradient, text, image, opacity, clip, style); the ink bounding box is x 2..22, y 6..18 on the 24 grid (padding 2) and x 1..15, y 3.5..13 on the 16 grid; thinnest part is 1.5 units (hangers; the cable is thicker so that its thickness measured perpendicular to the curve is >= 1.5 at the visible end); PNGs are 512x512 and 256x256 RGBA, 256 px file about 7 KB.

## Known weaknesses

- At 32 px the tile reads as "a green bridge-like bar on indigo": the three hangers become a texture and the screen hole and the notch are gone. At 16 px (favicon sizes) it is not recognisable, which is why the terminal glyph is simplified.
- The mark is wide (about 2.4:1), so it fills only the middle band of the square tile; there is empty tile above and below.
- Activity-bar glyph at 24 px looks like a bridge but is dense: cable and hangers are as heavy as the minimum width allows, so it can look like a "gate" or "crown". The 16 px terminal glyph is closer to a crown or castle gate than a bridge.
- The indigo tile's darkest corner (#27246F) has only 1.24:1 contrast against a #1e1e1e surface, so on very dark pages the tile edge is soft (the mint mark still reads).
- Generic subject: a suspension-bridge pictogram is a common icon subject; this drawing is original, but no trademark or similarity search was done.
