#!/usr/bin/env bash
# Shared config for the KARMA demo-video pipeline. Sourced by every script.
# NO SECRETS HERE (safe to commit). Secrets live in demo-video/secrets.env.

KARMA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DV="$KARMA_ROOT/demo-video"
VENV="$DV/.venv"
ASCIINEMA="$VENV/bin/asciinema"
EDGE_TTS="$VENV/bin/edge-tts"
AGG="$DV/bin/agg"
OUT="$DV/out"
CAST_DIR="$OUT/cast"
CLIPS_DIR="$OUT/clips"
AUDIO_DIR="$OUT/audio"
SHOTS_DIR="$OUT/shots"
REMOTION="$DV/remotion"

# --- Public chain facts (from DEMO.md; safe to commit) ---
ALPHA_ADDR="0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec"   # provider
BETA_ADDR="0x00d5f57009279aB0195264Fa2160F43055deD938"    # requester
EXPLORER="${PHAROS_EXPLORER:-https://atlantic.pharosscan.xyz}"
CHROME="/usr/bin/google-chrome"

# --- Per-run cost, measured from the real receipts in DEMO.md (wei) ---
# Beta is the bottleneck: it pays create_job + complete_job gas + the 0.0001 escrow
# that flows to Alpha and is NOT recovered. Alpha pays register+deliver+withdraw gas.
BETA_COST_WEI="588761000000000"     # ~0.000589 PHRS per full `demo` run
ALPHA_COST_WEI="395764000000000"    # ~0.000396 PHRS per full `demo` run
TRUSTGATE_ALPHA_WEI="288055000000000"  # 1 register_skill tx (Beta pays 0; create_job is rejected)
SAFETY_RUNS="1"                     # require this many runs of headroom AFTER the take

# --- Render knobs ---
FPS=30
AGG_THEME="${AGG_THEME:-dracula}"
AGG_FONT_SIZE="${AGG_FONT_SIZE:-28}"
AGG_IDLE_LIMIT="${AGG_IDLE_LIMIT:-2}"   # collapse any idle pause > Ns (kills dead tx-wait time)
AGG_SPEED="${AGG_SPEED:-1}"
TTS_VOICE="${TTS_VOICE:-en-US-GuyNeural}"

# --- Demo runtime knobs (color stays ON because asciinema gives a real pty) ---
export PHAROS_POLL_INTERVAL_MS="${PHAROS_POLL_INTERVAL_MS:-300}"

# Pull non-secret chain config from the repo .env if present (PHAROS_RPC_URL etc.)
if [ -f "$KARMA_ROOT/.env" ]; then
  set -a; # shellcheck disable=SC1091
  . "$KARMA_ROOT/.env" 2>/dev/null || true
  set +a
fi
# Secrets (KEYSTORE_PASSWORD) — sourced separately, never committed.
if [ -f "$DV/secrets.env" ]; then
  set -a; . "$DV/secrets.env"; set +a
fi

mkdir -p "$CAST_DIR" "$CLIPS_DIR" "$AUDIO_DIR" "$SHOTS_DIR"
