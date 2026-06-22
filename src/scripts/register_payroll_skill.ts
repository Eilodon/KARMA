/**
 * Registers the payroll_hr_transfer skill on-chain with minReputationToInvoke: 55.
 *
 * Prerequisites: KEYSTORE_PATH, KEYSTORE_PASSWORD, PHAROS_RPC_URL, CONTRACT_ADDRESS in .env
 * Usage: npx tsx src/scripts/register_payroll_skill.ts
 */
import { keystoreManager } from "../lib/keystore.js";
import { realKarmaService } from "../lib/karma_service.js";
import { ENV } from "../config/env.js";

const AGENT_ID = process.env.KARMA_DEMO_AGENT_ID ?? "agent-alpha";
const TENANT_ID = ENV.MCP_TENANT_ID;
const KEYSTORE_PATH = process.env.KEYSTORE_PATH ?? "";
const KEYSTORE_PASSWORD = process.env.KEYSTORE_PASSWORD ?? "";

if (!KEYSTORE_PATH || !KEYSTORE_PASSWORD) {
  console.error("FATAL: Set KEYSTORE_PATH and KEYSTORE_PASSWORD env vars.");
  process.exit(1);
}

await keystoreManager.load(KEYSTORE_PATH, KEYSTORE_PASSWORD);
const account = realKarmaService.account(AGENT_ID, TENANT_ID);

const { skillId, outcome } = await realKarmaService.registerSkill(account, {
  name: "payroll_hr_transfer",
  description:
    "Enterprise HR payroll transfer skill. Requires T3N identity verification + on-chain " +
    "reputation >= 55 (KARMA Trust Gate). Demonstrates dual-layer trust for sensitive financial operations.",
  mcpEndpoint: process.env.MCP_ENDPOINT ?? "https://karma.example.com/mcp",
  pricePerCall: 1_000_000_000_000_000n, // 0.001 PHRS
  minReputationToInvoke: 55n,
});

console.log(`payroll_hr_transfer registered: skillId=${skillId?.toString()}, status=${outcome.status}`);
