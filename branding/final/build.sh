#!/usr/bin/env bash
# Dev-only: regenerates every PNG of the uPython Bridge brand kit from the SVG sources.
# Needs rsvg-convert and ImageMagick (`magick`). Never part of the extension build or the VSIX.
# SVG masters (mark.svg, activitybar.svg, terminal-tab-*.svg, trash-danger-*.svg, banner.svg) are hand-authored
# and are NOT regenerated; only rasters, the proof sheet and the contrast table are.
# Output: icon-512.png icon-256.png icon-128.png banner-1280x640.png preview.png palette-contrast.txt
set -euo pipefail
cd "$(dirname "$0")"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found" >&2; exit 1; }
command -v magick >/dev/null || { echo "magick (ImageMagick 7) not found" >&2; exit 1; }
TMP="$(mktemp -d "${TMPDIR:-/tmp}/upy-bridge-brand.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# 1. Marketplace icon and README logo: rendered straight from the colour master at each size
#    (not downsampled from 512), RGBA with transparent corners outside the rounded tile.
for s in 512 256 128; do
  rsvg-convert -w $s -h $s mark.svg -o "$TMP/i$s.png"
  magick "$TMP/i$s.png" -strip PNG32:icon-$s.png
done

# 2. Banner (the only raster that carries text; system font, see banner.svg).
rsvg-convert -w 1280 -h 640 banner.svg -o "$TMP/banner.png"
magick "$TMP/banner.png" -strip PNG24:banner-1280x640.png

# 3. preview.png (1280x560), no labels (no fonts used).
#    Left half: Marketplace icon at 256/128/64/48/32 px on white (top) and #1E1E1E (bottom).
#    Right half, four bands of 140 px:
#      #252526 sidebar: activity-bar glyph 24 and 48 px (#CCCCCC), trash-danger-dark 16 and 32 px
#      #F3F3F3 sidebar: activity-bar glyph 24 and 48 px (#616161), trash-danger-light 16 and 32 px
#      #1E1E1E panel:   terminal-tab-dark 16 and 32 px
#      #FFFFFF panel:   terminal-tab-light 16 and 32 px
glyph() { sed "s/currentColor/$3/g" "$1" | rsvg-convert -w "$2" -h "$2" - -o "$4"; }   # glyph svg size colour out
CMD=(magick -size 1280x560 xc:'#ffffff'
  -fill '#1e1e1e' -draw 'rectangle 0,280 639,559'
  -fill '#252526' -draw 'rectangle 640,0 1279,139'
  -fill '#f3f3f3' -draw 'rectangle 640,140 1279,279'
  -fill '#1e1e1e' -draw 'rectangle 640,280 1279,419'
  -fill '#ffffff' -draw 'rectangle 640,420 1279,559')
x=24
for s in 256 128 64 48 32; do
  rsvg-convert -w $s -h $s mark.svg -o "$TMP/m$s.png"
  y=$(( (280 - s) / 2 ))
  CMD+=("$TMP/m$s.png" -geometry "+$x+$y" -composite "$TMP/m$s.png" -geometry "+$x+$((y+280))" -composite)
  x=$(( x + s + 20 ))
done
band() { # band <y0> <activity glyph colour> <trash svg or ''> <terminal svg or ''>
  local y0=$1 col=$2 trash=$3 term=$4 px s
  if [ "$col" != "-" ]; then
    px=690
    for s in 24 48; do
      glyph activitybar.svg $s "$col" "$TMP/ab$s-$y0.png"
      CMD+=("$TMP/ab$s-$y0.png" -geometry "+$px+$(( y0 + (140 - s) / 2 ))" -composite)
      px=$(( px + s + 40 ))
    done
  fi
  if [ -n "$trash" ]; then
    px=900
    for s in 16 32; do
      rsvg-convert -w $s -h $s "$trash" -o "$TMP/tr$s-$y0.png"
      CMD+=("$TMP/tr$s-$y0.png" -geometry "+$px+$(( y0 + (140 - s) / 2 ))" -composite)
      px=$(( px + s + 40 ))
    done
  fi
  if [ -n "$term" ]; then
    px=690
    for s in 16 32; do
      rsvg-convert -w $s -h $s "$term" -o "$TMP/te$s-$y0.png"
      CMD+=("$TMP/te$s-$y0.png" -geometry "+$px+$(( y0 + (140 - s) / 2 ))" -composite)
      px=$(( px + s + 40 ))
    done
  fi
}
band 0   '#cccccc' trash-danger-dark.svg  ''
band 140 '#616161' trash-danger-light.svg ''
band 280 '-'       ''                     terminal-tab-dark.svg
band 420 '-'       ''                     terminal-tab-light.svg
CMD+=(-strip PNG24:preview.png)
"${CMD[@]}"

# 4. Contrast table (also rewrites the ratios into palette.json). Non-zero exit if a pair is below its minimum.
python3 -I palette-contrast.py > palette-contrast.txt || { cat palette-contrast.txt; exit 1; }

ls -l icon-512.png icon-256.png icon-128.png banner-1280x640.png preview.png
