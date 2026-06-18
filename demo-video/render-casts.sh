#!/usr/bin/env bash
# Render captured .cast files to .mp4 clips.
#   .cast --(agg: theme + idle-time compression)--> .gif --(ffmpeg)--> .mp4
#
# --idle-time-limit collapses long pauses (e.g. on-chain tx confirmation) to N seconds,
# so the real run stays authentic but the dead time doesn't bloat the 2-minute cut.
#
#   demo-video/render-casts.sh [segment ...]   # default: every .cast in out/cast
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"

SEGMENTS=("$@")
if [ ${#SEGMENTS[@]} -eq 0 ]; then
  for c in "$CAST_DIR"/*.cast; do [ -e "$c" ] && SEGMENTS+=("$(basename "$c" .cast)"); done
fi
[ ${#SEGMENTS[@]} -eq 0 ] && { echo "no .cast files in $CAST_DIR — run record.sh first"; exit 1; }

rc=0
for name in "${SEGMENTS[@]}"; do
  cast="$CAST_DIR/$name.cast"
  gif="$CLIPS_DIR/$name.gif"
  mp4="$CLIPS_DIR/$name.mp4"
  [ -f "$cast" ] || { echo "SKIP $name — no cast"; rc=1; continue; }

  echo ">>> render [$name]  agg(theme=$AGG_THEME idle<=${AGG_IDLE_LIMIT}s speed=${AGG_SPEED}x)"
  "$AGG" \
    --theme "$AGG_THEME" \
    --font-size "$AGG_FONT_SIZE" \
    --idle-time-limit "$AGG_IDLE_LIMIT" \
    --speed "$AGG_SPEED" \
    --fps-cap "$FPS" \
    --last-frame-duration 2 \
    "$cast" "$gif" || { echo "FAIL agg $name"; rc=1; continue; }

  # GIF -> H.264 mp4 (even dims, yuv420p for broad playback; constant 30fps for Remotion)
  ffmpeg -y -loglevel error -i "$gif" \
    -vf "fps=$FPS,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos" \
    -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart \
    "$mp4" || { echo "FAIL ffmpeg $name"; rc=1; continue; }

  # Last frame as a still — Remotion holds it (freeze-frame) while narration finishes,
  # so a fast clip stays readable instead of ending early.
  ffmpeg -y -loglevel error -sseof -0.2 -i "$mp4" -frames:v 1 "$CLIPS_DIR/$name.last.png" 2>/dev/null || true

  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$mp4" 2>/dev/null)"
  echo "OK    $name → $mp4  (${dur}s)  + last-frame still"
done
exit "$rc"
