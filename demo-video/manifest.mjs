/**
 * Build remotion/src/manifest.json from whatever artifacts exist, and stage media into
 * remotion/public/. This is the single source of truth Remotion reads to lay out the video:
 * per-segment durations are driven by max(clip length, narration length), so narration paces
 * the cut. Real tx hashes come from out/demo_json.json (fallback: DEMO.md).
 *
 *   OUT=... REMOTION=... EXPLORER=... CONTRACT=... node demo-video/manifest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = process.env.OUT || "demo-video/out";
const REMOTION = process.env.REMOTION || "demo-video/remotion";
const EXPLORER = (process.env.EXPLORER || "https://atlantic.pharosscan.xyz").replace(/\/+$/, "");
const FPS = Number(process.env.FPS || 30);
const PAD = 0.4;      // seconds of breathing room after the longer of clip/narration
const MIN_TERMINAL = 6;

const PUBLIC = path.join(REMOTION, "public");
for (const d of ["clips", "audio", "shots"]) fs.mkdirSync(path.join(PUBLIC, d), { recursive: true });

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const probe = (p) => {
  try {
    return parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], { encoding: "utf8" }).trim()) || 0;
  } catch { return 0; }
};
const copy = (src, rel) => { if (exists(src)) { fs.copyFileSync(src, path.join(PUBLIC, rel)); return rel; } return null; };

// editorial structure (the "Prove it, don't tell it" spine)
const SEGMENTS = [
  { id: "title", kind: "title", chapter: "", proof: "" },
  { id: "discover", kind: "terminal", chapter: "Discover", proof: "Proof 1 · Reputation-ranked discovery + prompt-injection sanitized" },
  { id: "trust-gate", kind: "terminal", chapter: "Trust Gate", proof: "Proof 2 · On-chain consensus rejects under-credentialed agent · 0 PHRS" },
  { id: "demo", kind: "terminal", chapter: "Economic Loop", proof: "Proof 3 · Full loop · 5 real transactions", showTxs: true },
  { id: "verify", kind: "terminal", chapter: "Verify", proof: "Proof 4 · On-chain state verified · reputation 50 to 55" },
  { id: "explorer", kind: "shot", chapter: "Receipts", proof: "Every transaction verifiable on Pharosscan" },
  { id: "outro", kind: "outro", chapter: "", proof: "" },
];

const narration = exists(path.join(OUT, "narration.json"))
  ? JSON.parse(fs.readFileSync(path.join(OUT, "narration.json"), "utf8"))
  : { blocks: {} };

let txs = [], contract = process.env.CONTRACT || "";
if (exists(path.join(OUT, "demo_json.json"))) {
  try { const j = JSON.parse(fs.readFileSync(path.join(OUT, "demo_json.json"), "utf8")); txs = j.txs || []; contract = j.contract || contract; } catch {}
}
if (!txs.length) {
  txs = [
    { label: "register_skill", hash: "0xc2f1cbd0488cd3c501db0e6f6c8c11448740a95a8d4e29822d2b7636a8747921" },
    { label: "create_job", hash: "0x3fd1d1cea4690c11711f55fb7c74daa9b6bbf69f5319ab6a1ee27b9354658685" },
    { label: "deliver_result", hash: "0x16651d34260a64c69e2647314cfa732a8f6f973c6e48498e1380ae7185868a43" },
    { label: "complete_job", hash: "0x97e9d08daf711599f33a513a84227c3068e0b8e401b6d73c42799bace1d328c1" },
    { label: "withdraw", hash: "0xc1130d271f87ee4c31684d925ed26ac3816cf0577592d102aad81d8036155dac" },
  ];
  if (!contract) contract = "0x068091d8b982379373a4db377872ffb608a979b4";
}

const segments = [];
for (const s of SEGMENTS) {
  const nb = narration.blocks?.[s.id];
  const narr = nb ? { src: copy(path.join(OUT, "audio", path.basename(nb.file)), `audio/${s.id}.mp3`), duration: nb.duration } : null;
  let clip = null, clipDuration = 0, last = null;
  if (s.kind === "terminal") {
    const mp4 = path.join(OUT, "clips", `${s.id}.mp4`);
    if (exists(mp4)) { clip = copy(mp4, `clips/${s.id}.mp4`); clipDuration = probe(mp4); last = copy(path.join(OUT, "clips", `${s.id}.last.png`), `clips/${s.id}.last.png`); }
  }
  let shot = null;
  if (s.kind === "shot") shot = copy(path.join(OUT, "shots", "tx.png"), "shots/tx.png");
  const contractShot = s.kind === "outro" ? copy(path.join(OUT, "shots", "contract.png"), "shots/contract.png") : null;

  const base = Math.max(clipDuration, narr?.duration || 0, s.kind === "terminal" || s.kind === "shot" ? MIN_TERMINAL : 3);
  const durationInFrames = Math.round((base + PAD) * FPS);
  segments.push({ ...s, narr, clip, clipDuration, clipFrames: Math.round(clipDuration * FPS), last, shot, contractShot, durationInFrames });
}

const manifest = { fps: FPS, width: 1920, height: 1080, explorer: EXPLORER, contract, txs, segments };
fs.mkdirSync(path.join(REMOTION, "src"), { recursive: true });
fs.writeFileSync(path.join(REMOTION, "src", "manifest.json"), JSON.stringify(manifest, null, 2));

const total = segments.reduce((a, s) => a + s.durationInFrames, 0);
console.log(`manifest: ${segments.length} segments, ${total} frames = ${(total / FPS).toFixed(1)}s`);
for (const s of segments) console.log(`  ${s.id.padEnd(11)} ${(s.durationInFrames / FPS).toFixed(1)}s  clip=${s.clip ? "yes" : "—"} narr=${s.narr?.src ? "yes" : "—"}`);
