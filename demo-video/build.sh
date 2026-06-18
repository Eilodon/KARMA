#!/usr/bin/env bash
# One-command KARMA demo video builder.
#
#   demo-video/build.sh                # full build (live capture if KEYSTORE_PASSWORD is set)
#   demo-video/build.sh --no-live      # only the free offline segment + placeholders (no spend)
#   demo-video/build.sh --skip-capture # reuse existing .cast captures, just re-assemble
#   demo-video/build.sh --skip-tts     # reuse existing narration
#
# Pipeline:  preflight → capture(asciinema) → render(agg+ffmpeg) → shoot(pharosscan)
#            → tts(edge-tts) → manifest → assemble(remotion)  →  out/final.mp4
#
# The ONLY manual prerequisites: funded wallets (done) + KEYSTORE_PASSWORD in secrets.env.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source ./config.sh

LIVE=1; SKIP_CAPTURE=0; SKIP_TTS=0; SKIP_SHOT=0
for a in "$@"; do case "$a" in
  --no-live) LIVE=0 ;;
  --skip-capture) SKIP_CAPTURE=1 ;;
  --skip-tts) SKIP_TTS=1 ;;
  --skip-shot) SKIP_SHOT=1 ;;
  *) echo "unknown flag: $a"; exit 2 ;;
esac; done

# No password → can't touch the chain. Degrade to offline build instead of failing.
if [ -z "${KEYSTORE_PASSWORD:-}" ] && [ "$LIVE" = "1" ]; then
  echo "⚠️  KEYSTORE_PASSWORD not set (demo-video/secrets.env) — building OFFLINE (discover only,"
  echo "    on-chain segments stay as 'live capture pending' placeholders). Set it for the full video."
  LIVE=0
fi

hr() { printf '\n\033[36m── %s ─────────────────────────────────────────\033[0m\n' "$1"; }

# 1) Preflight budget gate (only matters when we will actually spend)
if [ "$LIVE" = "1" ] && [ "$SKIP_CAPTURE" = "0" ]; then
  hr "1/6 preflight budget gate"
  BETA_COST_WEI="$BETA_COST_WEI" ALPHA_COST_WEI="$ALPHA_COST_WEI" \
  TRUSTGATE_ALPHA_WEI="$TRUSTGATE_ALPHA_WEI" SAFETY_RUNS="$SAFETY_RUNS" \
  PHAROS_RPC_URL="${PHAROS_RPC_URL:-}" \
    pnpm -s exec tsx "$DV/preflight.mts" || { echo "ABORT: preflight NO-GO (top up the faucet)"; exit 1; }
fi

# 2) Capture terminal segments to .cast (asciinema, real PTY)
if [ "$SKIP_CAPTURE" = "0" ]; then
  hr "2/6 capture"
  if [ "$LIVE" = "1" ]; then ./record.sh discover trust-gate demo verify || true
  else ./record.sh discover || true; fi
else echo "(skip capture — reusing $CAST_DIR)"; fi

# 3) Render .cast → .mp4 clips
hr "3/6 render terminal clips"
./render-casts.sh || true

# 4) Pharosscan screenshots (best-effort)
if [ "$SKIP_SHOT" = "0" ]; then
  hr "4/6 explorer screenshots"
  EXPLORER="$EXPLORER" SHOTS_DIR="$SHOTS_DIR" DEMO_JSON_FILE="$OUT/demo_json.json" \
  CONTRACT="${PHAROS_CONTRACT_ADDRESS:-}" CHROME="$CHROME" \
    node "$REMOTION/scripts/shoot-explorer.mjs" || true
fi

# 5) Narration (regenerate if script changed or missing)
if [ "$SKIP_TTS" = "0" ] && { [ ! -f "$OUT/narration.json" ] || [ "$DV/narration/script.json" -nt "$OUT/narration.json" ]; }; then
  hr "5/6 narration (edge-tts + loudnorm)"
  SCRIPT_JSON="$DV/narration/script.json" AUDIO_DIR="$AUDIO_DIR" \
  NARRATION_OUT="$OUT/narration.json" TTS_VOICE="$TTS_VOICE" \
    "$VENV/bin/python" "$DV/narration/tts.py" || true
else echo "(narration up to date — $OUT/narration.json)"; fi

# 6) Manifest + assemble with Remotion
hr "6/6 manifest + Remotion render"
OUT="$OUT" REMOTION="$REMOTION" EXPLORER="$EXPLORER" CONTRACT="${PHAROS_CONTRACT_ADDRESS:-}" FPS="$FPS" \
  node "$DV/manifest.mjs"

( cd "$REMOTION" && npx remotion render KarmaDemo "out/final.mp4" \
    --browser-executable="$CHROME" --concurrency=2 --log=error ) || { echo "Remotion render failed"; exit 1; }

FINAL="$REMOTION/out/final.mp4"
cp -f "$FINAL" "$OUT/final.mp4" 2>/dev/null || true
hr "done"
echo "🎬  $OUT/final.mp4"
ffprobe -v error -show_entries format=duration:stream=width,height -of default=noprint_wrappers=1 "$OUT/final.mp4" 2>/dev/null
[ "$LIVE" = "0" ] && echo "ℹ️  This was an OFFLINE build — set KEYSTORE_PASSWORD and re-run for the live on-chain segments."
exit 0
