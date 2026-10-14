#!/usr/bin/env bash
# Dev-only. Regenerates every PNG in this folder from the SVGs:
#   icon-512.png, icon-256.png   Marketplace icon (tile + mark), from mark.svg
#   preview.png                  contact sheet: icon on light/dark, glyphs on light/dark sidebars
# Needs rsvg-convert and ImageMagick 7 (magick). No network, no fonts downloaded.
# The SVGs are the source of truth; edit them, then run: bash build.sh
set -euo pipefail
cd "$(dirname "$0")"

for tool in rsvg-convert magick; do
  command -v "$tool" >/dev/null || { echo "build.sh: $tool not found" >&2; exit 1; }
done
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

png() { # png <in.svg> <size> <out.png>   (transparent background)
  rsvg-convert -w "$2" -h "$2" "$1" -o "$3"
}

# 1. Marketplace icon: render straight from the vector at each size (not by downscaling a PNG).
png mark.svg 512 "$TMP/i512.png"
png mark.svg 256 "$TMP/i256.png"
magick "$TMP/i512.png" -strip -define png:compression-level=9 icon-512.png
magick "$TMP/i256.png" -strip -define png:compression-level=9 icon-256.png

# 2. preview.png
FONT=""
for f in /System/Library/Fonts/Helvetica.ttc /System/Library/Fonts/Supplemental/Arial.ttf; do
  [ -f "$f" ] && FONT="$f" && break
done

W=1184; H=592
args=(-size "${W}x${H}" xc:'#808080')
panel() { # panel <colour> <x> <y> <w> <h>
  args+=(-fill "$1" -draw "rectangle $2,$3 $(( $2 + $4 - 1 )),$(( $3 + $5 - 1 ))")
}
put() { # put <png> <x> <y>
  args+=("$1" -geometry "+$2+$3" -composite)
}
label() { # label <colour> <x> <y> <text>
  [ -n "$FONT" ] && args+=(-font "$FONT" -pointsize 13 -fill "$1" -annotate "+$2+$3" "$4")
  return 0
}
glyph() { # glyph <svg> <size> <colour> -> path of the rendered png (currentColor replaced)
  local name="$TMP/g_$(basename "$1" .svg)_${2}_${3#\#}"
  sed "s/currentColor/$3/g" "$1" > "$name.svg"
  png "$name.svg" "$2" "$name.png"
  echo "$name.png"
}

# --- block 1: Marketplace icon at 256/128/64/32 on white and on near-black
Y1=8; H1=316
panel '#FFFFFF' 8 $Y1 580 $H1
panel '#1E1E1E' 596 $Y1 580 $H1
label '#555555' 20 $((Y1 + 24)) "Marketplace icon, 256 / 128 / 64 / 32 px, on white"
label '#AAAAAA' 608 $((Y1 + 24)) "Marketplace icon, 256 / 128 / 64 / 32 px, on near-black"
for s in 128 64 32; do png mark.svg "$s" "$TMP/i$s.png"; done
for base in 8 596; do
  x=$((base + 12)); bottom=$((Y1 + H1 - 14))
  for s in 256 128 64 32; do
    put "$TMP/i$s.png" "$x" $((bottom - s))
    x=$((x + s + 20))
  done
done

# --- block 2: activity-bar glyph at 24/32/48 px, active and inactive colours
Y2=$((Y1 + H1 + 8)); H2=164
panel '#252526' 8 $Y2 580 $H2
panel '#F3F3F3' 596 $Y2 580 $H2
label '#AAAAAA' 20 $((Y2 + 22)) "Activity bar glyph, 24 / 32 / 48 px, on #252526"
label '#555555' 608 $((Y2 + 22)) "Activity bar glyph, 24 / 32 / 48 px, on #F3F3F3"
row=0
for colours in "#C5C5C5:#424242:active" "#858585:#616161:inactive"; do
  IFS=: read -r cd cl nm <<<"$colours"
  cy=$((Y2 + 62 + row * 52))
  for side in dark light; do
    [ "$side" = dark ] && { base=8; col="$cd"; lab='#AAAAAA'; } || { base=596; col="$cl"; lab='#555555'; }
    x=$((base + 20))
    for s in 24 32 48; do
      put "$(glyph activitybar.svg "$s" "$col")" "$x" $((cy - s / 2))
      x=$((x + s + 28))
    done
    label "$lab" $((base + 200)) $((cy + 4)) "$nm  $col"
  done
  row=$((row + 1))
done

# --- block 3: terminal-tab glyph at 16/32 px
Y3=$((Y2 + H2 + 8)); H3=84
panel '#252526' 8 $Y3 580 $H3
panel '#F3F3F3' 596 $Y3 580 $H3
label '#AAAAAA' 20 $((Y3 + 22)) "Terminal-tab glyph, 16 / 32 px, on #252526"
label '#555555' 608 $((Y3 + 22)) "Terminal-tab glyph, 16 / 32 px, on #F3F3F3"
cy=$((Y3 + 56))
for side in dark light; do
  [ "$side" = dark ] && { base=8; col='#C5C5C5'; } || { base=596; col='#424242'; }
  x=$((base + 20))
  for s in 16 32; do
    put "$(glyph terminal-tab.svg "$s" "$col")" "$x" $((cy - s / 2))
    x=$((x + s + 28))
  done
done

magick "${args[@]}" -depth 8 -strip -define png:compression-level=9 preview.png
echo "wrote icon-512.png icon-256.png preview.png"
