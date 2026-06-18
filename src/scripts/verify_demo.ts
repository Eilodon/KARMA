import { keystoreManager } from "../lib/keystore.js";
import karmaTools from "../plugins/karma.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";
import { withRequestContext, defaultRequestContext } from "../security/context.js";

/**
 * Read-only on-chain verification of the post-demo state via the read tools.
 *   PHAROS_CONTRACT_ADDRESS=0x... KEYSTORE_PASSWORD=... tsx src/scripts/verify_demo.ts
 */
const tool = (name: string): ToolDefinition => {
  const t = karmaTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const agentId = (args as { agentId?: string }).agentId;
  const tenantId = agentId ? keystoreManager.getTenant(agentId) : defaultRequestContext().tenantId;
  const res = await withRequestContext(
    { ...defaultRequestContext(), tenantId },
    () => tool(name).handler(args, {} as never),
  );
  return (res.structuredContent ?? {}) as Record<string, unknown>;
}

async function main(): Promise<void> {
  markTrustedRuntime(); // this script drives karma.tool read handlers in-process — declare trust for the canary
  const password = process.env.KEYSTORE_PASSWORD;
  if (!password) throw new Error("Set KEYSTORE_PASSWORD.");
  await keystoreManager.load(process.env.KEYSTORE_PATH ?? "./keystore.json", password);

  const rep = await call("get_agent_reputation", { agentId: "agent-alpha" });
  console.log("ALPHA reputation:", JSON.stringify(rep));

  const graphBeta = await call("query_social_graph", { agentId: "agent-beta" });
  console.log("BETA social graph:", JSON.stringify(graphBeta));

  const graphAlpha = await call("query_social_graph", { agentId: "agent-alpha" });
  console.log("ALPHA social graph:", JSON.stringify(graphAlpha));
}

main().catch((e) => {
  console.error("VERIFY FAIL:", e);
  process.exit(1);
});
