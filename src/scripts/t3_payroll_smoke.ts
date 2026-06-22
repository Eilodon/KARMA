/**
 * Live smoke test for t3_authorize_payroll_agent against the real T3N testnet.
 *
 * Prerequisites: KEYSTORE_PATH (default ./keystore.json), KEYSTORE_PASSWORD in env.
 * Usage: KEYSTORE_PASSWORD=... npx tsx src/scripts/t3_payroll_smoke.ts
 */
import { keystoreManager } from "../lib/keystore.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";
import { createT3Tools } from "../plugins/t3.tool.js";

const AGENT_ID = process.env.KARMA_DEMO_AGENT_ID ?? "agent-alpha";
const KEYSTORE_PATH = process.env.KEYSTORE_PATH ?? "./keystore.json";
const KEYSTORE_PASSWORD = process.env.KEYSTORE_PASSWORD ?? "";

if (!KEYSTORE_PASSWORD) {
  console.error("FATAL: Set KEYSTORE_PASSWORD env var.");
  process.exit(1);
}

markTrustedRuntime();
await keystoreManager.load(KEYSTORE_PATH, KEYSTORE_PASSWORD);
console.log(`[smoke] keystore loaded, agents: ${keystoreManager.list().join(", ")}`);

const account = keystoreManager.getAccount(AGENT_ID);
console.log(`[smoke] account.address: ${account.address}`);
console.log(`[smoke] account.publicKey present: ${typeof (account as { publicKey?: unknown }).publicKey === "string"}`);

const tools = createT3Tools();
const call = async (name: string, args: Record<string, unknown>) => {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  const res = await tool.handler(args, {} as never, undefined, undefined);
  console.log(JSON.stringify(res.structuredContent, null, 2));
  return res.structuredContent;
};

try {
  await call("t3_health", {});
  await call("t3_verify_identity", { agent_id: AGENT_ID });
  const authResult = await call("t3_authorize_payroll_agent", { agent_id: AGENT_ID }) as Record<string, unknown>;
  await call("t3_revoke_payroll_authorization", { agent_id: AGENT_ID });

  console.log("\n[smoke] PASS — full lifecycle (issue → sign → provision-attempt → invoke-attempt → revoke) executed without throwing.");
  console.log(`[smoke] grant_provisioned=${authResult.grant_provisioned} invocation_succeeded=${authResult.invocation_succeeded}`);
  if (authResult.grant_provisioning_error) console.log(`[smoke] grant_provisioning_error: ${authResult.grant_provisioning_error}`);
  if (authResult.invocation_error) console.log(`[smoke] invocation_error: ${authResult.invocation_error}`);
  process.exit(0);
} catch (err) {
  console.error("\n[smoke] FAIL:", err);
  process.exit(1);
}
