import { createPublicClient, http, getAddress, type Address } from "viem";
import { keystoreManager } from "../lib/keystore.js";
import { pharosAtlantic } from "../lib/contract.js";
import { realKarmaService } from "../lib/karma_service.js";

/**
 * AgentSkillRegistry v1 → v2 migration (PD-003/PD-005 redeploy, ADR 2026-06-17-agentskillregistry-v2).
 *
 * The contract is immutable, so v2 is a fresh deploy with empty state. This re-registers every ACTIVE
 * v1 skill owned by an agent in our keystore onto the freshly-deployed v2 contract, preserving name/
 * description/endpoint/price and defaulting the new on-chain `minReputationToInvoke` to 0 (open).
 *
 * Order of operations (operator runbook — see spec 2026-06-17-agentskillregistry-v2-design.md §5):
 *   1. KEYSTORE_PASSWORD=… tsx src/scripts/deploy_contract.ts   → note the new address
 *   2. Set PHAROS_CONTRACT_ADDRESS=<new v2 address> in .env
 *   3. KEYSTORE_PASSWORD=… V1_CONTRACT_ADDRESS=<old v1 address> tsx src/scripts/migrate_to_v2.ts
 *   4. Set KARMA_INDEXER_FROM_BLOCK=<v2 deploy block> and restart so the index rebuilds from v2.
 *
 * In-flight v1 jobs (Open/Delivered) settle on v1 — keep a v1 reader alive until they drain before
 * decommissioning it. Escrow already locked in v1 is NOT moved by this script.
 */

/** Minimal v1 `skills()` shape (9-tuple — pre-minReputationToInvoke) for reading the old contract. */
const v1Abi = [
  { type: "function", name: "skillCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "skills", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" }, { name: "name", type: "string" }, { name: "description", type: "string" },
      { name: "mcpEndpoint", type: "string" }, { name: "pricePerCall", type: "uint256" },
      { name: "reputationScore", type: "uint256" }, { name: "totalInvocations", type: "uint256" },
      { name: "active", type: "bool" }, { name: "registeredAt", type: "uint256" },
    ],
  },
] as const;

export interface V1Skill {
  skillId: bigint;
  owner: Address;
  name: string;
  description: string;
  mcpEndpoint: string;
  pricePerCall: bigint;
  active: boolean;
}

export interface MigrationItem {
  oldSkillId: bigint;
  owner: Address;
  name: string;
  description: string;
  mcpEndpoint: string;
  pricePerCall: bigint;
  minReputationToInvoke: bigint; // defaults to 0 (open) — v1 carried no threshold
}

/**
 * Pure migration planner: keep only ACTIVE skills whose owner we can sign for, in stable id order.
 * Defaults the new on-chain threshold to 0. Decoupled from IO so it is unit-tested.
 */
export function planMigration(skills: V1Skill[], ownedAddresses: Iterable<string>): MigrationItem[] {
  const owned = new Set([...ownedAddresses].map(a => a.toLowerCase()));
  return skills
    .filter(s => s.active && owned.has(s.owner.toLowerCase()))
    .sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0))
    .map(s => ({
      oldSkillId: s.skillId,
      owner: s.owner,
      name: s.name,
      description: s.description,
      mcpEndpoint: s.mcpEndpoint,
      pricePerCall: s.pricePerCall,
      minReputationToInvoke: 0n,
    }));
}

async function main(): Promise<void> {
  const password = process.env.KEYSTORE_PASSWORD;
  const v1Address = process.env.V1_CONTRACT_ADDRESS;
  const keystorePath = process.env.KEYSTORE_PATH ?? "./keystore.json";
  if (!password) throw new Error("Set KEYSTORE_PASSWORD to unlock the keystore.");
  if (!v1Address) throw new Error("Set V1_CONTRACT_ADDRESS to the OLD contract to migrate FROM.");
  if (!process.env.PHAROS_CONTRACT_ADDRESS) {
    throw new Error("Set PHAROS_CONTRACT_ADDRESS to the NEW v2 contract (deploy it first).");
  }

  await keystoreManager.load(keystorePath, password);
  const ownedAddresses = keystoreManager.list().map(id => keystoreManager.getAddress(id));

  const rpc = process.env.PHAROS_RPC_URL ?? "https://atlantic.dplabs-internal.com";
  const v1Client = createPublicClient({ chain: pharosAtlantic, transport: http(rpc) });
  const v1 = getAddress(v1Address);

  const count = await v1Client.readContract({ address: v1, abi: v1Abi, functionName: "skillCount" });
  console.log(`v1 ${v1} has ${count} skill(s); keystore owns ${ownedAddresses.length} agent(s).`);

  const skills: V1Skill[] = [];
  for (let id = 1n; id <= count; id += 1n) {
    const t = await v1Client.readContract({ address: v1, abi: v1Abi, functionName: "skills", args: [id] });
    skills.push({
      skillId: id, owner: t[0], name: t[1], description: t[2], mcpEndpoint: t[3],
      pricePerCall: t[4], active: t[7],
    });
  }

  const plan = planMigration(skills, ownedAddresses);
  console.log(`Migrating ${plan.length} active owned skill(s) → v2 ${process.env.PHAROS_CONTRACT_ADDRESS}`);

  for (const item of plan) {
    const account = keystoreManager.getAccount(
      keystoreManager.list().find(id => keystoreManager.getAddress(id).toLowerCase() === item.owner.toLowerCase())!,
    );
    const { skillId, outcome } = await realKarmaService.registerSkill(account, {
      name: item.name,
      description: item.description,
      mcpEndpoint: item.mcpEndpoint,
      pricePerCall: item.pricePerCall,
      minReputationToInvoke: item.minReputationToInvoke,
    });
    console.log(`  v1 #${item.oldSkillId} → v2 #${skillId ?? "(pending)"} tx=${outcome.hash}`);
  }
  console.log("\n✅ Migration broadcast complete. Set KARMA_INDEXER_FROM_BLOCK to the v2 deploy block and restart.");
}

// Only run when invoked directly (so the pure planner can be imported by tests without side effects).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("MIGRATION FAIL:", e);
    process.exit(1);
  });
}
