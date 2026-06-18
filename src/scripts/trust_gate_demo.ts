import { keystoreManager } from "../lib/keystore.js";
import karmaTools from "../plugins/karma.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";
import { withRequestContext, defaultRequestContext } from "../security/context.js";
import { C, banner, step, kv, ok } from "./_demo_format.js";

/**
 * Trust Gate demo — on-chain consensus enforcement rejects an undercredentialed
 * agent BEFORE any escrow is attempted. No tx is sent; no PHRS is spent.
 *
 * The gate is set dynamically to Beta's agentReputation + 5, so the rejection
 * holds regardless of prior test runs that already bumped Beta's reputation.
 *
 *   PHAROS_CONTRACT_ADDRESS=0x... KEYSTORE_PASSWORD=... pnpm demo:trust-gate
 */

const PASSWORD = process.env.KEYSTORE_PASSWORD;
const PRICE_WEI = "100000000000000"; // 0.0001 PHRS

const tool = (name: string): ToolDefinition => {
  const t = karmaTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const agentId = (args as { agentId?: string }).agentId;
  const tenantId = agentId
    ? keystoreManager.getTenant(agentId)
    : defaultRequestContext().tenantId;
  const res = await withRequestContext(
    { ...defaultRequestContext(), tenantId },
    () => tool(name).handler(args, {} as never),
  );
  console.log(`  ${C.green("→")} ${res.content[0]?.text}`);
  return (res.structuredContent ?? {}) as Record<string, unknown>;
}

async function main(): Promise<void> {
  markTrustedRuntime();
  if (!PASSWORD) throw new Error("Set KEYSTORE_PASSWORD.");
  if (!process.env.PHAROS_CONTRACT_ADDRESS) throw new Error("Set PHAROS_CONTRACT_ADDRESS.");
  await keystoreManager.load(process.env.KEYSTORE_PATH ?? "./keystore.json", PASSWORD);

  console.log(banner("KARMA Trust Gate — on-chain consensus enforcement"));

  // Step 1: read Beta's actual on-chain agentReputation so the gate is always above it
  console.log(step(1, 3, "Read Beta's on-chain agentReputation"));
  const rep = await call("get_agent_reputation", { agentId: "agent-beta" });
  const betaRep = Number(rep.agentReputation ?? 50);
  console.log(kv("agentReputation", C.yellow(String(betaRep))));
  console.log(C.dim("  (base-50 for a new agent; +5 per arm's-length confirmed job)"));

  const gate = betaRep + 5; // always 5 above Beta's current rep

  // Step 2: Alpha registers a reputation-gated premium skill
  console.log(step(2, 3, `Alpha registers premium skill — minReputationToInvoke: ${gate}`));
  const reg = await call("register_skill", {
    agentId: "agent-alpha",
    name: "premium-analytics",
    description: "Premium on-chain analytics — established agents only",
    mcpEndpoint: "inproc://karma/premium",
    pricePerCallWei: PRICE_WEI,
    minReputationToInvoke: gate,
  });
  console.log(kv("skillId", C.cyan(String(reg.skillId))));
  console.log(kv("Trust Gate", C.red(`minReputationToInvoke = ${gate}`)));

  // Step 3: Beta attempts create_job — rejected before any escrow
  console.log(step(3, 3, `Beta (rep=${betaRep}) attempts create_job on gated skill`));
  const job = await call("create_job", {
    agentId: "agent-beta",
    skillId: String(reg.skillId),
    idempotencyNonce: 9001,
  });

  if (job.status !== "rejected") {
    throw new Error(`Expected rejected, got: ${JSON.stringify(job)}`);
  }

  console.log(`\n  ${C.red("✗ REJECTED")} ${C.bold("by on-chain consensus")} — ${job.reason}`);
  console.log(C.dim(`  Beta agentReputation (${betaRep}) < minReputationToInvoke (${gate})`));
  console.log(C.dim("  No escrow locked. Zero PHRS spent. Contract enforces the same rule."));
  console.log(ok("Consensus-enforced trust gate — not app-layer opinion"));
}

main().catch((e) => {
  console.error(C.red("TRUST GATE DEMO FAIL:"), e);
  process.exit(1);
});
