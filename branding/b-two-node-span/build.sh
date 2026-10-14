#!/usr/bin/env bash
# Dev-only: regenerates every PNG in this folder from the SVG sources.
# Needs rsvg-convert and ImageMagick (magick). No network, no fonts, nothing is installed.
# Usage: ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

TMP=".build-tmp"
rm -rf "$TMP"; mkdir "$TMP"
trap 'rm -rf "$TMP"' EXIT

PNG_OPTS=(-strip -define png:compression-level=9 -define png:exclude-chunk=all)

# --- Marketplace icon (tile + mark) ---
timeout 60 rsvg-convert -w 512 -h 512 mark.svg -o "$TMP/icon-512.png"
timeout 60 rsvg-convert -w 256 -h 256 mark.svg -o "$TMP/icon-256.png"
timeout 60 magick "$TMP/icon-512.png" "${PNG_OPTS[@]}" icon-512.png
timeout 60 magick "$TMP/icon-256.png" "${PNG_OPTS[@]}" icon-256.png

# --- preview sheet ---
# currentColor cannot be rendered outside VS Code, so substitute a colour in a temp copy.
tint() { # tint <svg> <colour> <size> <out.png>
  sed "s/currentColor/$2/g" "$1" > "$TMP/t.svg"
  timeout 60 rsvg-convert -w "$3" -h "$3" "$TMP/t.svg" -o "$4"
}
for s in 256 128 64 32; do timeout 60 rsvg-convert -w $s -h $s mark.svg -o "$TMP/i$s.png"; done
for s in 24 32 48; do
  tint activitybar.svg '#c5c5c5' $s "$TMP/ad$s.png"   # light grey on dark sidebar #252526
  tint activitybar.svg '#424242' $s "$TMP/al$s.png"   # dark grey on light sidebar #f3f3f3
done
for s in 16 32; do
  tint terminal-tab.svg '#c5c5c5' $s "$TMP/td$s.png"
  tint terminal-tab.svg '#424242' $s "$TMP/tl$s.png"
done

# canvas 1000x520: left half white / right half near-black for the icon rows; glyph panels below
magick -size 1000x520 xc:'#ffffff' \
  -fill '#1e1e1e' -draw 'rectangle 500,0 999,319' \
  -fill '#252526' -draw 'rectangle 0,320 499,519' \
  -fill '#f3f3f3' -draw 'rectangle 500,320 999,519' \
  "$TMP/i256.png" -geometry +20+20  -composite \
  "$TMP/i128.png" -geometry +300+20 -composite \
  "$TMP/i64.png"  -geometry +300+170 -composite \
  "$TMP/i32.png"  -geometry +390+170 -composite \
  "$TMP/i256.png" -geometry +520+20  -composite \
  "$TMP/i128.png" -geometry +800+20 -composite \
  "$TMP/i64.png"  -geometry +800+170 -composite \
  "$TMP/i32.png"  -geometry +890+170 -composite \
  "$TMP/ad24.png" -geometry +30+408  -composite \
  "$TMP/ad32.png" -geometry +90+404  -composite \
  "$TMP/ad48.png" -geometry +160+396 -composite \
  "$TMP/td16.png" -geometry +270+412 -composite \
  "$TMP/td32.png" -geometry +310+404 -composite \
  "$TMP/al24.png" -geometry +530+408 -composite \
  "$TMP/al32.png" -geometry +590+404 -composite \
  "$TMP/al48.png" -geometry +660+396 -composite \
  "$TMP/tl16.png" -geometry +770+412 -composite \
  "$TMP/tl32.png" -geometry +810+404 -composite \
  "${PNG_OPTS[@]}" preview.png

# --- magnified glyph check (8x, not a deliverable consumer; handy when editing the paths) ---
tint activitybar.svg '#c5c5c5' 192 "$TMP/mag-a.png"
tint terminal-tab.svg '#c5c5c5' 128 "$TMP/mag-t.png"
magick -size 360x220 xc:'#252526' "$TMP/mag-a.png" -geometry +10+10 -composite "$TMP/mag-t.png" -geometry +220+10 -composite \
  "${PNG_OPTS[@]}" glyph-zoom.png

echo "built: icon-512.png icon-256.png preview.png glyph-zoom.png"
