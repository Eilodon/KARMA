# KARMA demo video — automated pipeline

Builds the ~2-minute KARMA hackathon demo video from the **real** terminal demos and **real**
on-chain transactions, with one command. Terminal-native ("Prove it, don't tell it"): no manual
recording, editing, or voiceover.

```
preflight → capture(asciinema) → render(agg+ffmpeg) → shoot(pharosscan)
          → narrate(edge-tts) → manifest → assemble(remotion) → out/final.mp4
```

## One command

```bash
# 1. put the keystore password in a gitignored file (only manual secret)
cp demo-video/secrets.env.example demo-video/secrets.env
$EDITOR demo-video/secrets.env          # set KEYSTORE_PASSWORD=...

# 2. build (live capture of the on-chain segments + assembly)
demo-video/build.sh
#    → demo-video/out/final.mp4
```

No password yet? `demo-video/build.sh --no-live` builds the full video with the real offline
`discover` segment and clean "live capture pending" placeholders for the on-chain ones — useful
for iterating on the edit without spending anything.

## Why this stack (the short version)

| Need | Tool | Why |
|---|---|---|
| Capture terminal faithfully (real color, real tx hashes) | **asciinema** | gives a real PTY, so `process.stdout.isTTY` stays true and the demo keeps its ANSI color; the `.cast` is a re-renderable receipt |
| One recorder for all 4 segments | **asciinema** | consistent theme; and the 5-tx loop is **captured once** then rendered infinitely (Beta's wallet only funds ~3 live runs — see Budget) |
| Compress dead tx-wait time | **agg** `--idle-time-limit` | keeps the run authentic but collapses confirmation pauses |
| Money-shot proof | **puppeteer-core** + system Chrome | screenshots the real Pharosscan tx page automatically |
| Narration | **edge-tts** + ffmpeg `loudnorm` | per-segment neural TTS, normalized (edge-tts is quiet by default) |
| Assembly + "Proof:" overlays | **Remotion** | title card, lower-thirds, chapter pills, the tx-hash panel (auto-filled from the live run's `DEMO_JSON`), explorer shot, outro — all React, fully reproducible |

The whole capture/render loop re-runs for free **except** the live 5-tx loop, so the architecture
captures that once and treats the `.cast` as gold.

## Budget guard ("don't burn the wallet")

`preflight.mts` reads both wallets before any spend and refuses to start a take the wallets can't
finish. Measured per full `demo` run (real receipts):

| Wallet | Per run | Role |
|---|---|---|
| Alpha | ~0.000396 PHRS | register + deliver + withdraw gas |
| **Beta** | **~0.000589 PHRS** | create_job + complete_job gas **+ 0.0001 escrow (not recovered)** — the bottleneck |

Top up Beta from the faucet if preflight says NO-GO. `discover` is free (offline); `trust-gate`
spends only Alpha; `verify` is read-only.

## Customizing

- **Narration text / voice** — edit [narration/script.json](narration/script.json) (`voice` +
  per-block `text`). Re-run picks it up automatically. Voices: `demo-video/.venv/bin/edge-tts --list-voices`.
- **Look** — [remotion/src/theme.ts](remotion/src/theme.ts) (colors/fonts), agg theme via
  `AGG_THEME` (e.g. `monokai`, `dracula`).
- **Structure / overlay copy** — the `SEGMENTS` array in [manifest.mjs](manifest.mjs) (chapter
  names, "Proof N" lines) and the components in `remotion/src/components/`.
- **Preview live** — `cd remotion && npx remotion studio` (scrub the timeline in a browser).

## Flags

| Flag | Effect |
|---|---|
| (none) | full build; live capture if `KEYSTORE_PASSWORD` is set |
| `--no-live` | offline build (real `discover` + placeholders), zero spend |
| `--skip-capture` | reuse existing `.cast` files, just re-assemble |
| `--skip-tts` | reuse existing narration |
| `--skip-shot` | reuse existing Pharosscan screenshots |

## Layout

```
demo-video/
  build.sh            one-command orchestrator
  preflight.mts       wallet budget gate
  record.sh           asciinema capture (+ DEMO_JSON extraction)
  render-casts.sh     agg + ffmpeg  .cast → .mp4 (+ freeze-frame still)
  manifest.mjs        builds remotion/src/manifest.json, stages media
  config.sh           shared, non-secret config
  secrets.env         KEYSTORE_PASSWORD (gitignored)
  lib/ptyrec.py       fixed-size PTY wrapper for asciinema
  narration/          script.json + tts.py
  remotion/           Remotion project (assembly + overlays)
  out/                artifacts (gitignored): cast/ clips/ audio/ shots/ final.mp4
```
