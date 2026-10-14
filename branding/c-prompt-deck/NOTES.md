# Concept C - "Prompt deck"

## Idea

The REPL prompt `>` and its cursor underscore, turned into a bridge. The chevron stands at the left as the pier of the
crossing, the underscore becomes the deck, and a shallow arch is cut out from underneath so the deck visibly rests on
two piers. Message to a student: "type here, it reaches the board". It is the most minimal of the three concepts:
two rounded shapes (a chevron and a slab with one elliptical opening), one colour, no letters, no detail that needs a
second tone. Warm coral on graphite keeps it friendly rather than "hacker green on black".

Built from scratch as SVG paths (rounded polygons plus one elliptical arc). Nothing traced; no snake, chip, pin,
board, or any of the marks the brief lists as off limits. Caveat on originality: a chevron plus a bar is the generic
terminal convention (VS Code's own terminal codicon is also `>_`); the arch-cut slab is what makes this mark ours.

## Files

| File | What | Notes |
|---|---|---|
| `mark.svg` | colour master, 512 grid, tile + mark | 533 bytes; the source of both PNGs |
| `icon-512.png` | master PNG, rounded tile on transparent corners | 15 KB |
| `icon-256.png` | Marketplace icon (`"icon"` in package.json) | 7 KB, limit 40 KB |
| `activitybar.svg` | 24x24 mono glyph, `fill="currentColor"`, one path | 501 bytes, limit 2 KB |
| `terminal-tab.svg` | 16x16 mono glyph, simplified (thicker, fewer details) | 469 bytes |
| `palette.json`, `palette-contrast.py`, `palette-contrast.txt` | colours, pairs, WCAG ratios and their output | run `python3 palette-contrast.py` |
| `build.sh` | dev-only: regenerates `icon-*.png` and `preview.png` from the SVGs | needs `rsvg-convert` and `magick` |
| `preview.png` | icon at 256/128/64/32 on white and near-black; activity glyph 24/32/48 and terminal glyph 16/32 on #252526 and #F3F3F3 (active and inactive greys) | judge quality here |

## Colours

| Name | Hex | Use |
|---|---|---|
| graphite | `#2A2B30` | tile background, `galleryBanner` |
| coral | `#FF8A4C` | the mark (orange-coral, not red) |

Mark on tile is 6.05 : 1 (needs 3 : 1). Tile on white is 14.13 : 1. Coral directly on white is only 2.34 : 1, so the
mark is never used without its graphite tile. Tile on a `#1E1E1E` dark surface is 1.18 : 1: the tile edge nearly
vanishes there, the coral mark stays fully readable.

**package.json suggestion:** `"galleryBanner": { "color": "#2A2B30", "theme": "dark" }`.

## Geometry (for anyone redrawing it)

- Tile: 512 square, corner radius 112 (21.9 %). Mark box 352 x 370 centred (margins 80 left/right, 71 top/bottom).
- Master: chevron arm 80 wide horizontally (57 perpendicular), half-height 120, run 116, foot floats 20 above the deck.
  Deck slab 352 x 110, piers 44 wide, elliptical opening with semi-axes 132 x 72 springing straight from the bottom edge
  (vertical tangent, so the feet are not thin wedges), 38 of deck above the crown. Corner radius 16, apex 20.
- 24 grid (activity bar): chevron y 2..14 from x 3, arm 3.8 horizontal (2.7 perpendicular); slab x 2.5..21.5, y 16..22,
  piers 2.5, opening 7 x 4, 2.0 of deck over the crown. Deck top and bottom edges sit on whole pixels.
- 16 grid (terminal tab): chevron y 1..8 from x 2, arm 3.2; slab x 1..15, y 10..15, piers 2, opening 5 x 3, 2.0 of deck.
  Every part is at least 2 units thick (rule: nothing under 1.5). A morphological-opening test (disk of 1.5 units)
  changed 0.4 % (24 glyph) and 1.7 % (16 glyph) of the ink, corner rounding only.

## Usage rules

- **Minimum sizes.** Marketplace/README icon: 32 px absolute minimum (prefer 64 px and up); below that use the mono
  glyph. Activity-bar glyph: 24 px (VS Code fixes it). Terminal-tab glyph: 16 px.
- **Clear space.** Keep at least 1/8 of the tile width free around the tile when it sits on a page. Inside the tile the
  mark never gets closer than about 13 % of the tile to any edge.
- **Always on its tile** (graphite). On a light page the tile is the contrast; do not recolour the mark to suit the page.
- **Do not**: recolour to red, blue or yellow (red/white/gold is the old extension, blue+yellow is Python); add a
  gradient, shadow, outline or glow; put a letter or the name inside the icon; flip, rotate or squash it; separate the
  chevron from the deck by a different distance; fill in the arch; use the 24 glyph with a second colour or stroke;
  use the old `media/activitybar.svg` or `trash-red.svg`; place the mark on a coral or orange background.
- **Wiring** (later, after the instructor picks): copy `icon-256.png` to `media/icon.png`, set `"icon"` and
  `galleryBanner`; activity bar view container `icon` = `activitybar.svg`; terminal tab = `terminal-tab.svg`.
- **Licence note:** authored for this project from geometric primitives only, no font, no third-party artwork;
  license it with the extension (MIT) unless the instructor decides otherwise.

## Honest weaknesses

1. The arch is the only "bridge" cue. At 32 px and in the 16 px glyph it is a 2-3 px notch, so the small icons read as
   "prompt over a slab / stool"; the bridge story needs the name ("Bridge") to land.
2. Chevron + bar is also the generic terminal motif. The activity-bar glyph is told apart from VS Code's built-in
   terminal icon only by the thick arch-cut slab; at 16 px the two are easy to confuse.
3. At 16 px the chevron arms are 2.3 px diagonals: soft edges, no pixel hinting possible in a mask glyph.
4. Composition is asymmetric (chevron upper-left, empty upper-right); the visual weight sits low-left. It looks neutral
   and technical rather than playful; the friendliness comes only from rounded corners and the warm colour.
5. Not tested in a real VS Code (launches are not allowed in this task). The mask behaviour is emulated by
   substituting colours into temp copies. `[K]` VS Code loads a terminal `iconPath` URI as an image, where
   `currentColor` is not themed (likely black); for the terminal tab plan on two fixed-colour copies
   (`{ light, dark }`, for example `#424242` and `#C5C5C5`) or a `ThemeIcon`. `[U]` until wiring is tested.
6. Dark Marketplace surfaces: the graphite tile edge is nearly invisible (1.18 : 1), so the icon looks like a floating
   coral mark there. Fine for recognition, but it is not a framed tile in dark mode.
7. Out of scope here: replacement for `trash-red.svg`, README banner, a real tray icon (VS Code has none).

## Rebuild

```
bash build.sh                     # icon-512.png, icon-256.png, preview.png
python3 palette-contrast.py       # ratios -> palette.json + palette-contrast.txt
```
