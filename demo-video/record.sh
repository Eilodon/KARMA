#!/usr/bin/env bash
# Capture the KARMA demo segments to asciinema .cast files (real PTY → colors + real output).
#
# The 5-tx `demo` loop is captured ONCE (Beta budget is tight); the .cast is the gold,
# re-renderable receipt. discover/verify are free; trust-gate spends only Alpha.
#
#   demo-video/record.sh                       # all four segments
#   demo-video/record.sh discover              # just the free offline one (good for testing)
#   demo-video/record.sh discover verify       # the two free segments
#
# Env: KEYSTORE_PASSWORD (from secrets.env) is required for trust-gate/demo/verify.
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"

export REC_COLS="${REC_COLS:-110}" REC_ROWS="${REC_ROWS:-32}"
PTYREC=("python3" "$DV/lib/ptyrec.py")

# segment -> "needs_secret|timeout|command"  (command runs in $KARMA_ROOT via $SHELL -c)
declare -A SEG=(
  [discover]="0|90|pnpm demo:discover"
  [trust-gate]="1|180|pnpm demo:trust-gate"
  [demo]="1|240|DEMO_JSON=1 pnpm demo"
  [verify]="1|120|pnpm demo:verify"
)
ORDER=(discover trust-gate demo verify)
SEGMENTS=("$@"); [ ${#SEGMENTS[@]} -eq 0 ] && SEGMENTS=("${ORDER[@]}")

capture() {
  local name="$1" spec needs timeout cmd out
  spec="${SEG[$name]:-}"; [ -z "$spec" ] && { echo "unknown segment: $name"; return 2; }
  IFS='|' read -r needs timeout cmd <<<"$spec"
  out="$CAST_DIR/$name.cast"
  if [ "$needs" = "1" ] && [ -z "${KEYSTORE_PASSWORD:-}" ]; then
    echo "SKIP  $name — KEYSTORE_PASSWORD unset (add it to demo-video/secrets.env)"; return 3
  fi
  local tries="${CAPTURE_RETRIES:-2}" i=0
  while :; do
    i=$((i + 1))
    echo ">>> capture [$name] attempt $i/$tries  (pty ${REC_COLS}x${REC_ROWS}, timeout ${timeout}s)"
    if timeout -k 5 "$timeout" \
         "${PTYREC[@]}" "$ASCIINEMA" rec -q --overwrite \
         -c "cd '$KARMA_ROOT' && $cmd" "$out"; then
      echo "OK    $name → $out"
      return 0
    fi
    echo "FAIL  $name (attempt $i)"
    [ "$i" -ge "$tries" ] && return 1
    sleep 3
  done
}

rc=0
for s in "${SEGMENTS[@]}"; do
  capture "$s" || rc=$?
done

# Extract the real tx hashes the demo printed (DEMO_JSON line) for the Remotion overlays.
if [ -f "$CAST_DIR/demo.cast" ]; then
  json="$("$ASCIINEMA" cat "$CAST_DIR/demo.cast" 2>/dev/null | sed -n 's/.*DEMO_JSON:\({.*}\).*/\1/p' | tail -1)"
  if [ -n "$json" ] && echo "$json" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    printf '%s\n' "$json" > "$OUT/demo_json.json"
    echo "OK    extracted real tx hashes → $OUT/demo_json.json"
  else
    echo "WARN  could not extract DEMO_JSON from demo.cast — overlays will use DEMO.md fallback"
  fi
fi

echo "capture done (rc=$rc)"
exit "$rc"
