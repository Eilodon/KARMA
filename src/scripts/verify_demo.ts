import { keystoreManager } from "../lib/keystore.js";
import karmaTools from "../plugins/karma.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

/**
 * Read-only on-chain verification of the post-demo state via the read tools.
 *   PHAROS_CONTRACT_ADDRESS=0x... KEYSTORE_PASSWORD=... tsx src/scripts/verify_demo.ts
 */
const tool = (name: string): ToolDefinition => {
  const t = karmaTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

async function main(): Promise<void> {
  const password = process.env.KEYSTORE_PASSWORD;
  if (!password) throw new Error("Set KEYSTORE_PASSWORD.");
  await keystoreManager.load(process.env.KEYSTORE_PATH ?? "./keystore.json", password);

  const rep = await tool("get_agent_reputation").handler({ agentId: "agent-alpha" }, {} as never);
  console.log("ALPHA reputation:", JSON.stringify(rep.structuredContent));

  const graphBeta = await tool("query_social_graph").handler({ agentId: "agent-beta" }, {} as never);
  console.log("BETA social graph:", JSON.stringify(graphBeta.structuredContent));

  const graphAlpha = await tool("query_social_graph").handler({ agentId: "agent-alpha" }, {} as never);
  console.log("ALPHA social graph:", JSON.stringify(graphAlpha.structuredContent));
}

main().catch((e) => {
  console.error("VERIFY FAIL:", e);
  process.exit(1);
});
