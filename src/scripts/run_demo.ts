import { formatEther, type Address } from "viem";
import { keystoreManager } from "../lib/keystore.js";
import { getPublicClient, writeContractBounded } from "../lib/contract.js";
import karmaTools from "../plugins/karma.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";
import { C, banner, step, kv, ok, short } from "./_demo_format.js";

/**
 * Self-referential KARMA demo: Agent Alpha registers the very `discover_skills` tool as a paid
 * skill, Agent Beta escrows a job for it, Alpha delivers, Beta confirms (releasing escrow), and
 * Alpha withdraws. Every step goes through the real KARMA tool handlers → realKarmaService →
 * Pharos Atlantic, so this exercises the full stack end-to-end.
 *
 *   PHAROS_CONTRACT_ADDRESS=0x... KEYSTORE_PASSWORD=... tsx src/scripts/run_demo.ts
 *
 * Demo knobs: PHAROS_POLL_INTERVAL_MS=300 (snappy confirms), DEMO_JSON=1 (emit machine blob),
 * NO_COLOR=1 (plain output).
 */
const PASSWORD = process.env.KEYSTORE_PASSWORD;
const KEYSTORE_PATH = process.env.KEYSTORE_PATH ?? "./keystore.json";
const EXPLORER = (process.env.PHAROS_EXPLORER ?? "https://atlantic.pharosscan.xyz").replace(/\/+$/, "");
const PRICE_WEI = process.env.DEMO_PRICE_WEI ?? "100000000000000"; // 0.0001 PHRS
const RESULT_HASH = `0x${"a1".repeat(32)}` as const;
const NONCE = 1; // fixed so the idempotency replay re-derives the same taskHash within this run

const tool = (name: string): ToolDefinition => {
  const t = karmaTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const txs: Array<{ label: string; hash: string }> = [];

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const res = await tool(name).handler(args, {} as never);
  console.log(`  ${C.green("→")} ${res.content[0]?.text}`);
  return (res.structuredContent ?? {}) as Record<string, unknown>;
}

async function main(): Promise<void> {
  markTrustedRuntime(); // this demo drives karma.tool handlers in-process — declare trust for the canary
  if (!PASSWORD) throw new Error("Set KEYSTORE_PASSWORD.");
  const contractAddr = process.env.PHAROS_CONTRACT_ADDRESS;
  if (!contractAddr) throw new Error("Set PHAROS_CONTRACT_ADDRESS (deploy first).");
  await keystoreManager.load(KEYSTORE_PATH, PASSWORD);

  const pub = getPublicClient();
  const alpha = keystoreManager.getAddress("agent-alpha");
  const beta = keystoreManager.getAddress("agent-beta");
  const bal = async (a: Address) => formatEther(await pub.getBalance({ address: a }));

  console.log(banner("KARMA Skill-Economy — live on Pharos Atlantic"));
  console.log(kv("Contract", C.cyan(short(contractAddr, 10, 8))));
  console.log(kv("Alpha", `${C.magenta(short(alpha, 10, 8))}  ${C.dim("provider")}  balance=${await bal(alpha)} PHRS`));
  console.log(kv("Beta", `${C.blue(short(beta, 10, 8))}  ${C.dim("requester")}  balance=${await bal(beta)} PHRS`));

  console.log(step(1, 5, "Alpha registers 'discover_skills' as a paid skill"));
  const reg = await call("register_skill", {
    agentId: "agent-alpha",
    name: "discover_skills",
    description: "Semantic BM25 skill discovery over the KARMA registry",
    mcpEndpoint: "inproc://karma/discover_skills",
    pricePerCallWei: PRICE_WEI,
  });
  if (reg.status !== "confirmed") throw new Error(`register_skill not confirmed: ${JSON.stringify(reg)}`);
  const skillId = String(reg.skillId);
  txs.push({ label: "register_skill", hash: String(reg.txHash) });

  console.log(step(2, 5, `Beta escrows a job (${PRICE_WEI} wei) against skill #${skillId}`));
  const job = await call("create_job", { agentId: "agent-beta", skillId, idempotencyNonce: NONCE });
  if (job.status !== "confirmed") throw new Error(`create_job not confirmed: ${JSON.stringify(job)}`);
  const jobId = String(job.jobId);
  txs.push({ label: "create_job", hash: String(job.txHash) });

  // Exactly-once (Layer-0): replay the identical request — same (requester, skillId, nonce) →
  // same on-chain taskHash → no second escrow. This is the lost-ack retry an agent would send.
  console.log(`  ${C.yellow("↻ replay identical request (lost-ack retry) — must NOT double-escrow:")}`);
  const replay = await call("create_job", { agentId: "agent-beta", skillId, idempotencyNonce: NONCE });
  if (replay.idempotent !== true || String(replay.jobId) !== jobId) {
    throw new Error(`idempotency broken: ${JSON.stringify(replay)}`);
  }
  console.log(`  ${C.green("✓")} ${C.bold("exactly-once held")} — returned existing job #${jobId}, no second escrow`);

  console.log(step(3, 5, `Alpha delivers the result for job #${jobId}`));
  const del = await call("deliver_result", { agentId: "agent-alpha", jobId, resultHash: RESULT_HASH });
  txs.push({ label: "deliver_result", hash: String(del.txHash) });

  console.log(step(4, 5, "Beta confirms completion → escrow credited to Alpha, reputation bumped"));
  const comp = await call("complete_job", { agentId: "agent-beta", jobId });
  txs.push({ label: "complete_job", hash: String(comp.txHash) });

  console.log(step(5, 5, "Alpha withdraws the escrow payout"));
  const wd = await writeContractBounded(keystoreManager.getAccount("agent-alpha"), {
    functionName: "withdraw",
    args: [],
  });
  console.log(`  ${C.green("→")} withdraw ${wd.status} tx=${short(wd.hash)}`);
  txs.push({ label: "withdraw", hash: wd.hash });

  console.log(`\n${C.bold("Balances")}  Alpha=${C.magenta(await bal(alpha))} PHRS   Beta=${C.blue(await bal(beta))} PHRS`);

  console.log(banner("Explorer — every step is on-chain & verifiable"));
  for (const t of txs) console.log(kv(t.label, C.cyan(`${EXPLORER}/tx/${t.hash}`), 16));

  console.log(banner("Layer-0 hardening enforced this run"));
  console.log(ok("exactly-once create_job (on-chain taskHash dedup; proven above)"));
  console.log(ok("bounded write: single broadcast + pending-safe receipt wait (never double-spends)"));
  console.log(ok("output firewall + JSON-Schema validation on every tool result"));
  console.log(ok("smcp:v4:kms crypto-erasure & in-process keystore (keys never leave the trusted runtime)"));

  if (process.env.DEMO_JSON === "1") {
    console.log("\nDEMO_JSON:" + JSON.stringify({ contract: contractAddr, skillId, jobId, txs }));
  }
}

main().catch((e) => {
  console.error(C.red("DEMO FAIL:"), e);
  process.exit(1);
});
