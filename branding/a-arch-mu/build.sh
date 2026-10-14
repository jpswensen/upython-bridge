#!/usr/bin/env bash
# Dev-only: regenerates every PNG of concept A "Arch mu" from the SVG sources.
# Needs rsvg-convert and ImageMagick (`magick`). Never part of the extension build.
# Output: icon-512.png, icon-256.png, preview.png (and palette-contrast.txt via python).
set -euo pipefail
cd "$(dirname "$0")"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/arch-mu.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# 1. Marketplace icon: the colour master rendered straight from the SVG at each size.
rsvg-convert -w 512 -h 512 mark.svg -o "$TMP/i512.png"
rsvg-convert -w 256 -h 256 mark.svg -o "$TMP/i256.png"
magick "$TMP/i512.png" -strip PNG32:icon-512.png
magick "$TMP/i256.png" -strip PNG32:icon-256.png

# 2. Mono glyphs rendered with currentColor replaced (what VS Code's mask does).
# glyph <svg> <size> <colour> <out>
glyph() { sed "s/currentColor/$3/g" "$1" | rsvg-convert -w "$2" -h "$2" - -o "$4"; }

# 3. preview.png (1280x600): left = Marketplace icon at 256/128/64/32 px on white and on
#    near-black; right = activity-bar glyph 24/32/48 px and terminal-tab glyph 16/32 px on
#    #252526 (light-grey glyph, top) and #f3f3f3 (dark-grey glyph, bottom).
for s in 256 128 64 32; do rsvg-convert -w $s -h $s mark.svg -o "$TMP/m$s.png"; done
CMD=(magick -size 1280x600 xc:'#ffffff'
  -fill '#1e1e1e' -draw 'rectangle 0,300 639,599'
  -fill '#252526' -draw 'rectangle 640,0 1279,299'
  -fill '#f3f3f3' -draw 'rectangle 640,300 1279,599')
x=24
for s in 256 128 64 32; do
  y=$(( (300 - s) / 2 ))
  CMD+=("$TMP/m$s.png" -geometry "+$x+$y" -composite "$TMP/m$s.png" -geometry "+$x+$((y+300))" -composite)
  x=$(( x + s + 24 ))
done
panel() { # panel <y0> <glyph colour>
  local y0=$1 col=$2 px=680 s
  for s in 24 32 48; do
    glyph activitybar.svg $s "$col" "$TMP/ab$s-$y0.png"
    CMD+=("$TMP/ab$s-$y0.png" -geometry "+$px+$(( y0 + 60 ))" -composite)
    px=$(( px + s + 48 ))
  done
  px=680
  for s in 16 32; do
    glyph terminal-tab.svg $s "$col" "$TMP/tt$s-$y0.png"
    CMD+=("$TMP/tt$s-$y0.png" -geometry "+$px+$(( y0 + 190 ))" -composite)
    px=$(( px + s + 48 ))
  done
}
panel 0 '#cccccc'
panel 300 '#616161'
CMD+=(-strip PNG24:preview.png)
"${CMD[@]}"

python3 palette-contrast.py > palette-contrast.txt
ls -l icon-512.png icon-256.png preview.png mark.svg activitybar.svg terminal-tab.svg
