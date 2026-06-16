import { formatEther, type Address } from "viem";
import { keystoreManager } from "../lib/keystore.js";
import { getPublicClient, writeContractBounded } from "../lib/contract.js";
import karmaTools from "../plugins/karma.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

/**
 * Self-referential KARMA demo: Agent Alpha registers the very `discover_skills` tool as a paid
 * skill, Agent Beta escrows a job for it, Alpha delivers, Beta confirms (releasing escrow), and
 * Alpha withdraws. Every step goes through the real KARMA tool handlers → realKarmaService →
 * Pharos Atlantic, so this exercises the full stack end-to-end.
 *
 *   PHAROS_CONTRACT_ADDRESS=0x... KEYSTORE_PASSWORD=... tsx src/scripts/run_demo.ts
 */
const PASSWORD = process.env.KEYSTORE_PASSWORD;
const KEYSTORE_PATH = process.env.KEYSTORE_PATH ?? "./keystore.json";
const EXPLORER = (process.env.PHAROS_EXPLORER ?? "https://atlantic.pharosscan.xyz").replace(/\/+$/, "");
const PRICE_WEI = process.env.DEMO_PRICE_WEI ?? "100000000000000"; // 0.0001 PHRS
const RESULT_HASH = `0x${"a1".repeat(32)}` as const;

const tool = (name: string): ToolDefinition => {
  const t = karmaTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const txs: Array<{ label: string; hash: string }> = [];

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const res = await tool(name).handler(args, {} as never);
  console.log(`  -> ${res.content[0]?.text}`);
  return (res.structuredContent ?? {}) as Record<string, unknown>;
}

async function main(): Promise<void> {
  if (!PASSWORD) throw new Error("Set KEYSTORE_PASSWORD.");
  if (!process.env.PHAROS_CONTRACT_ADDRESS) throw new Error("Set PHAROS_CONTRACT_ADDRESS (deploy first).");
  await keystoreManager.load(KEYSTORE_PATH, PASSWORD);

  const pub = getPublicClient();
  const alpha = keystoreManager.getAddress("agent-alpha");
  const beta = keystoreManager.getAddress("agent-beta");
  const bal = async (a: Address) => formatEther(await pub.getBalance({ address: a }));
  console.log(`Contract ${process.env.PHAROS_CONTRACT_ADDRESS}`);
  console.log(`Alpha ${alpha}  balance=${await bal(alpha)} PHRS`);
  console.log(`Beta  ${beta}  balance=${await bal(beta)} PHRS`);

  console.log("\n[1/5] Alpha registers 'discover_skills' as a paid skill...");
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

  console.log(`\n[2/5] Beta escrows a job (${PRICE_WEI} wei) against skill #${skillId}...`);
  const job = await call("create_job", { agentId: "agent-beta", skillId, idempotencyNonce: Date.now() });
  if (job.status !== "confirmed") throw new Error(`create_job not confirmed: ${JSON.stringify(job)}`);
  const jobId = String(job.jobId);
  txs.push({ label: "create_job", hash: String(job.txHash) });

  console.log(`\n[3/5] Alpha delivers the result for job #${jobId}...`);
  const del = await call("deliver_result", { agentId: "agent-alpha", jobId, resultHash: RESULT_HASH });
  txs.push({ label: "deliver_result", hash: String(del.txHash) });

  console.log(`\n[4/5] Beta confirms completion -> escrow credited to Alpha, reputation bumped...`);
  const comp = await call("complete_job", { agentId: "agent-beta", jobId });
  txs.push({ label: "complete_job", hash: String(comp.txHash) });

  console.log(`\n[5/5] Alpha withdraws the escrow payout...`);
  const wd = await writeContractBounded(keystoreManager.getAccount("agent-alpha"), {
    functionName: "withdraw",
    args: [],
  });
  console.log(`  -> withdraw ${wd.status} tx=${wd.hash}`);
  txs.push({ label: "withdraw", hash: wd.hash });

  console.log(`\nAlpha balance=${await bal(alpha)} PHRS   Beta balance=${await bal(beta)} PHRS`);
  console.log("\n=== Explorer links ===");
  for (const t of txs) console.log(`${t.label.padEnd(16)} ${EXPLORER}/tx/${t.hash}`);
  console.log("\nDEMO_JSON:" + JSON.stringify({ contract: process.env.PHAROS_CONTRACT_ADDRESS, skillId, jobId, txs }));
}

main().catch((e) => {
  console.error("DEMO FAIL:", e);
  process.exit(1);
});
