/**
 * Generate a KARMA multi-agent keystore (plan P3.3).
 *
 * Generates a fresh keypair per agent, encrypts each into Web3 Secret Storage v3 (scrypt),
 * writes KEYSTORE_PATH, and prints each agent's ADDRESS so you can fund it from a Pharos
 * faucet (Stakely / gas.zip / Chainlink) before deploying or creating jobs.
 *
 * Usage:
 *   KEYSTORE_PATH=./keystore.json KEYSTORE_PASSWORD=... \
 *   tsx src/scripts/setup_keystore.ts agent-alpha agent-beta
 */
import { writeFileSync, existsSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encryptPrivateKeyV3 } from "../lib/keystore.js";
import type { KeystoreFileV3 } from "../lib/types.js";

async function main(): Promise<void> {
  const path = process.env.KEYSTORE_PATH ?? "./keystore.json";
  const password = process.env.KEYSTORE_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error("Set KEYSTORE_PASSWORD (>= 8 chars) before generating a keystore.");
  }
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite existing keystore at ${path}. Remove it first if intended.`);
  }

  const agentIds = process.argv.slice(2);
  const names = agentIds.length > 0 ? agentIds : ["agent-alpha", "agent-beta"];

  const agents: KeystoreFileV3["agents"] = [];
  const summary: Array<{ agentId: string; address: string }> = [];
  for (const agentId of names) {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    const crypto = await encryptPrivateKeyV3(pk, password);
    agents.push({ agentId, address, crypto });
    summary.push({ agentId, address });
  }

  const file: KeystoreFileV3 = { version: 3, agents };
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });

  console.log(`✅ Wrote keystore (${names.length} agents) → ${path}`);
  console.log("\nFUND THESE ADDRESSES from a Pharos Atlantic faucet before deploy/createJob:");
  for (const { agentId, address } of summary) console.log(`  ${agentId}: ${address}`);
  console.log(
    "\nFaucets: https://stakely.io/faucet/pharos-atlantic-testnet-phrs · " +
      "https://www.gas.zip/faucet/pharos · https://faucets.chain.link/pharos-atlantic-testnet",
  );
}

main().catch((error) => {
  console.error("setup_keystore FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
