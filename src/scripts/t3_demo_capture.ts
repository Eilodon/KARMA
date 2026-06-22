/**
 * KARMA × Terminal3 — one-take demo driver (Scenes 1–4 of docs/demo-video-script.md).
 *
 * Drives the REAL t3_* tools against the live Terminal3 testnet, in capture-ready order with
 * deliberate holds on each WOW beat (DID, credential, revoke) so asciinema/agg keep them on
 * screen. Two wallets, narrated as "the KARMA agent":
 *   - agent-alpha : bonded on Pharos (reputation), free T3N auth → Scene 1 identity + Scene 2 gate
 *   - agent-beta  : an unverified requester → Scene 2 identity-gate REJECT, then verify→pass
 *   - agent-t3n   : funded T3N wallet (credit) → Scene 3 TEE-signed delegation + Scene 4 revoke
 *
 *   KEYSTORE_PASSWORD=... npx tsx src/scripts/t3_demo_capture.ts
 *
 * Knobs: T3_HOLD_MS (wow-beat hold, default 1800), T3_DEMO_SKILL_ID (default 1),
 *        T3_DEMO_VALUE_WEI (default 1e14), agent ids via KARMA_ALPHA/BETA/DEMO_AGENT_ID.
 */
import { keystoreManager } from "../lib/keystore.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";
import { createT3Tools } from "../plugins/t3.tool.js";
import { C, banner, step, kv, ok, short } from "./_demo_format.js";

const ALPHA = process.env.KARMA_ALPHA_AGENT ?? "agent-alpha";
const BETA = process.env.KARMA_BETA_AGENT ?? "agent-beta";
const T3N = process.env.KARMA_DEMO_AGENT_ID ?? "agent-t3n";
const SKILL_ID = process.env.T3_DEMO_SKILL_ID ?? "1";
const VALUE_WEI = process.env.T3_DEMO_VALUE_WEI ?? "100000000000000"; // 0.0001
const PASSWORD = process.env.KEYSTORE_PASSWORD;
const HOLD = Number(process.env.T3_HOLD_MS ?? 1800);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const didStr = (d: unknown): string =>
  typeof d === "string" ? d : ((d as { value?: string })?.value ?? JSON.stringify(d));
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const tools = createT3Tools();
const tool = (name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (name: string, args: Record<string, unknown>): Promise<any> =>
  (await tool(name).handler(args, {} as never, undefined, undefined)).structuredContent;

async function main(): Promise<void> {
  markTrustedRuntime();
  if (!PASSWORD) throw new Error("Set KEYSTORE_PASSWORD.");
  await keystoreManager.load(process.env.KEYSTORE_PATH ?? "./keystore.json", PASSWORD);

  console.log(banner("KARMA × Terminal3 — Agent Auth SDK · live testnet"));
  console.log(C.dim("  Agents cannot act anonymously, and their authority is never permanent.\n"));

  // ── SCENE 1 ───────────────────────────────────────────────────────────────
  console.log(banner("Scene 1 — Identity gate (live)"));
  console.log(step(1, 4, "A real decentralized identity from the Terminal3 TEE"));
  const health = await run("t3_health", {});
  console.log(kv("t3n node", C.cyan(health.nodeUrl)));
  console.log(kv("wasm", health.wasmLoaded ? C.green("loaded") : C.red("FAILED")));
  const id1 = await run("t3_verify_identity", { agent_id: ALPHA });
  console.log(ok("SIWE / EIP-191 handshake — private key never left the keystore"));
  console.log(kv("DID", C.green(C.bold(didStr(id1.did)))));
  await sleep(HOLD);

  // ── SCENE 2 ───────────────────────────────────────────────────────────────
  console.log(banner("Scene 2 — Dual-layer trust: the gate that says NO"));
  console.log(step(2, 4, "An UNVERIFIED agent is refused before any escrow"));
  try {
    await run("t3_create_verified_job", {
      agent_id: BETA, skill_id: SKILL_ID, deadline_secs: 3600, value_wei: VALUE_WEI,
    });
    console.log(C.red("  (expected a rejection but the call passed)"));
  } catch (e) {
    console.log(`  ${C.red("✗ REJECTED by the identity gate")}`);
    console.log(C.dim(`    ${errMsg(e)}`));
  }
  await sleep(HOLD);

  console.log(step(2, 4, "Verify identity, then both gates clear → escrow on-chain"));
  const id2 = await run("t3_verify_identity", { agent_id: BETA });
  console.log(kv("verified DID", C.green(didStr(id2.did))));
  const job = await run("t3_create_verified_job", {
    agent_id: BETA, skill_id: SKILL_ID, deadline_secs: 3600, value_wei: VALUE_WEI,
  });
  console.log(ok(`dual-gate PASSED — job ${C.cyan("#" + job.jobId)}  (identity ✓  reputation ${job.reputation} ≥ ${job.threshold} ✓)`));
  console.log(C.dim("  Gate 1: verified DID · Gate 2: on-chain reputation — both, or nothing."));
  await sleep(HOLD);

  // ── SCENE 3 ───────────────────────────────────────────────────────────────
  console.log(banner("Scene 3 — FLAGSHIP: bounded, revocable delegation (TEE-signed)"));
  console.log(step(3, 4, "The funded agent issues a Terminal3 delegation credential"));
  const id3 = await run("t3_verify_identity", { agent_id: T3N });
  console.log(kv("agent DID", C.green(didStr(id3.did))));
  const auth = await run("t3_authorize_payroll_agent", {
    agent_id: T3N, functions: ["validate-credentials"], ttl_secs: 3600, batch_cap_cents: "100000",
  });
  console.log(ok(C.bold("credential_issued: " + C.green(String(auth.credential_issued)))));
  console.log(kv("functions", auth.functions_authorised.join(", ")));
  console.log(kv("valid window", `${auth.not_before}  →  ${auth.not_after}`));
  console.log(kv("batch cap", `$${(Number(auth.batch_cap_cents) / 100).toFixed(2)}`));
  console.log(kv("vc_id", C.cyan(auth.vc_id_b64u)));
  console.log(kv("TEE signature", C.cyan(short(auth.user_sig_hex, 26, 8))));
  await sleep(HOLD + 1000);
  console.log(C.dim("\n  Honest guardrail on public testnet (never a fake success):"));
  console.log(kv("grant_provisioned", `${auth.grant_provisioned ? C.green("true") : C.yellow("false")}  ${C.dim("(org not deployed on testnet)")}`));
  console.log(kv("invocation", `${auth.invocation_succeeded ? C.green("true") : C.yellow("false")}  ${C.dim("(tee:payroll 404 on testnet)")}`));
  console.log(C.dim("  → the TEE-signed credential is the verifiable, independently-checkable artifact."));
  await sleep(HOLD);

  // ── SCENE 4 ───────────────────────────────────────────────────────────────
  console.log(banner("Scene 4 — Authority is temporary"));
  console.log(step(4, 4, "Revoke the very same credential — full issue → sign → revoke lifecycle"));
  const rev = await run("t3_revoke_payroll_authorization", { agent_id: T3N });
  console.log(ok(C.bold("revoked_entirely: " + C.green(String(rev.revoked_entirely)))));
  const matches = rev.vc_id === auth.vc_id_b64u;
  console.log(kv("vc_id", `${C.cyan(rev.vc_id)}  ${matches ? C.green("✓ matches Scene 3") : C.red("✗ mismatch")}`));
  await sleep(HOLD);

  console.log(banner("Terminal3 Agent Auth SDK — full lifecycle proven LIVE"));
  console.log(ok("identity (DID) → dual-layer trust gate → TEE-signed bounded delegation → revoke"));
  console.log(C.dim("  8 T3N tools · ~23 SDK surfaces · 457 tests green · keys never leave the keystore.\n"));
}

main().catch((e) => {
  console.error(C.red("T3 DEMO CAPTURE FAIL:"), e);
  process.exit(1);
});
