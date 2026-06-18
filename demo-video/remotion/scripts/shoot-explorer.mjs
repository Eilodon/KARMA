/**
 * Screenshot the real Pharosscan pages (the "money shot" proof) with puppeteer-core,
 * reusing the system Chrome so nothing extra is downloaded.
 *
 * Reads the real tx hashes from out/demo_json.json (falls back to the hashes baked into
 * DEMO.md if a live capture wasn't run). Best-effort: failures are logged, never fatal —
 * the in-terminal explorer URLs are already in the video as the primary receipt.
 *
 *   EXPLORER=... DEMO_JSON_FILE=... SHOTS_DIR=... CONTRACT=... node shoot-explorer.mjs
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const EXPLORER = (process.env.EXPLORER || "https://atlantic.pharosscan.xyz").replace(/\/+$/, "");
const SHOTS_DIR = process.env.SHOTS_DIR || "out/shots";
const DEMO_JSON_FILE = process.env.DEMO_JSON_FILE || "out/demo_json.json";

// Fallback (DEMO.md) so the outro still has a proof shot even with no live capture.
const FALLBACK = {
  contract: process.env.CONTRACT || "0x068091d8b982379373a4db377872ffb608a979b4",
  txs: [
    { label: "register_skill", hash: "0xc2f1cbd0488cd3c501db0e6f6c8c11448740a95a8d4e29822d2b7636a8747921" },
    { label: "create_job", hash: "0x3fd1d1cea4690c11711f55fb7c74daa9b6bbf69f5319ab6a1ee27b9354658685" },
    { label: "complete_job", hash: "0x97e9d08daf711599f33a513a84227c3068e0b8e401b6d73c42799bace1d328c1" },
    { label: "withdraw", hash: "0xc1130d271f87ee4c31684d925ed26ac3816cf0577592d102aad81d8036155dac" },
  ],
};

function loadManifest() {
  try {
    const j = JSON.parse(fs.readFileSync(DEMO_JSON_FILE, "utf8"));
    if (j && Array.isArray(j.txs) && j.txs.length) return j;
  } catch { /* fall through */ }
  console.log(`[shoot] no live demo_json.json — using DEMO.md fallback hashes`);
  return FALLBACK;
}

async function shoot(page, url, outfile) {
  console.log(`[shoot] ${url}`);
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  } catch {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); }
    catch (e) { console.log(`[shoot]   nav failed: ${e.message}`); return false; }
  }
  await new Promise((r) => setTimeout(r, 2500)); // let SPA settle
  await page.screenshot({ path: outfile });
  console.log(`[shoot]   -> ${outfile}`);
  return true;
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const m = loadManifest();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1024, deviceScaleFactor: 2 });

    // The headline tx (withdraw closes the economic loop) + the contract page for the outro.
    const headline = m.txs.find((t) => t.label === "withdraw") || m.txs[m.txs.length - 1];
    if (headline) await shoot(page, `${EXPLORER}/tx/${headline.hash}`, path.join(SHOTS_DIR, "tx.png"));
    if (m.contract) await shoot(page, `${EXPLORER}/address/${m.contract}`, path.join(SHOTS_DIR, "contract.png"));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error("[shoot] FAIL:", e.message); process.exit(0); }); // never fatal
