#!/usr/bin/env python3
"""Generate per-segment narration with Edge TTS, normalized to broadcast loudness.

Per-segment clips (not one long track) are the reliable way to sync narration to video.
Edge TTS output is quiet, so each clip is run through ffmpeg loudnorm (EBU R128) instead
of a blind volume multiply. Writes out/narration.json mapping each block -> file+duration,
which Remotion uses to pace every segment.

    SCRIPT_JSON=... AUDIO_DIR=... NARRATION_OUT=... [TTS_VOICE=...] \
        demo-video/.venv/bin/python demo-video/narration/tts.py
"""
import asyncio
import json
import os
import subprocess
import sys

import edge_tts

AUDIO_DIR = os.environ["AUDIO_DIR"]
SCRIPT_JSON = os.environ["SCRIPT_JSON"]
NARRATION_OUT = os.environ["NARRATION_OUT"]


async def synth(text: str, voice: str, out_path: str) -> None:
    await edge_tts.Communicate(text, voice).save(out_path)


def duration(path: str) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def main() -> int:
    data = json.load(open(SCRIPT_JSON))
    voice = os.environ.get("TTS_VOICE") or data.get("voice", "en-US-GuyNeural")
    os.makedirs(AUDIO_DIR, exist_ok=True)
    manifest = {"voice": voice, "blocks": {}}

    for b in data["blocks"]:
        bid, text = b["id"], b["text"]
        raw = os.path.join(AUDIO_DIR, f"{bid}.raw.mp3")
        norm = os.path.join(AUDIO_DIR, f"{bid}.mp3")
        try:
            asyncio.run(synth(text, voice, raw))
        except Exception as e:  # network/voice failure — keep going, skip block
            print(f"WARN {bid}: TTS failed ({e})")
            continue
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", raw,
             "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", norm],
            check=True,
        )
        os.remove(raw)
        d = duration(norm)
        manifest["blocks"][bid] = {"file": f"audio/{bid}.mp3", "duration": round(d, 3), "text": text}
        print(f"OK  {bid}: {d:.2f}s")

    json.dump(manifest, open(NARRATION_OUT, "w"), indent=2)
    print(f"wrote {NARRATION_OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
