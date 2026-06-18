import { keystoreManager } from "../lib/keystore.js";
import { getPublicClient, getWalletClient, getContractAddress, pharosAtlantic } from "../lib/contract.js";
import { agentSkillRegistryAbi } from "../lib/abi.js";

/**
 * Deposit a Sybil-resistance bond (Tier-2, PD-007) from a keystore agent, signing in-process — the
 * private key never leaves KeystoreManager (same path deploy/migrate use). A bonded agent becomes a
 * flow-reputation SEED, so this is the step that makes `KARMA_DISCOVERY_RANK=flow` non-bootstrappable
 * instead of seedless. The bond is locked (withdrawable only by this agent after a 7-day cooldown),
 * so it is real capital-at-risk, not a fee.
 *
 *   KEYSTORE_PASSWORD=… BOND_AGENT=agent-alpha BOND_AMOUNT_WEI=1000000000000000000 \
 *     tsx src/scripts/deposit_bond.ts
 *
 * Requires PHAROS_CONTRACT_ADDRESS to point at the deployed (bonded) contract. To later unlock, call
 * requestBondUnlock then withdrawBond after the cooldown (the seed drops to 0 immediately on request).
 */
const PASSWORD = process.env.KEYSTORE_PASSWORD;
const KEYSTORE_PATH = process.env.KEYSTORE_PATH ?? "./keystore.json";
const AGENT = process.env.BOND_AGENT ?? "agent-alpha";
const AMOUNT_WEI = BigInt(process.env.BOND_AMOUNT_WEI ?? "0");

async function main(): Promise<void> {
  if (!PASSWORD) throw new Error("Set KEYSTORE_PASSWORD to unlock the keystore.");
  if (AMOUNT_WEI <= 0n) throw new Error("Set BOND_AMOUNT_WEI to the bond amount (wei, > 0).");
  await keystoreManager.load(KEYSTORE_PATH, PASSWORD);
  const account = keystoreManager.getAccount(AGENT);

  const address = getContractAddress();
  const publicClient = getPublicClient();
  const walletClient = getWalletClient(account);

  const bal = await publicClient.getBalance({ address: account.address });
  console.log(`Bonding agent ${AGENT} ${account.address} balance=${bal} wei → contract ${address}`);
  if (bal < AMOUNT_WEI) throw new Error(`Balance ${bal} < bond ${AMOUNT_WEI} wei — fund the agent first.`);

  const hash = await walletClient.writeContract({
    address,
    abi: agentSkillRegistryAbi,
    functionName: "depositBond",
    value: AMOUNT_WEI,
    account,
    chain: pharosAtlantic,
  });
  console.log(`depositBond tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("depositBond reverted.");

  const seed = await publicClient.readContract({
    address,
    abi: agentSkillRegistryAbi,
    functionName: "seedEligibleBond",
    args: [account.address],
  });
  console.log(`\n✅ Bond deposited (block ${receipt.blockNumber}). seedEligibleBond=${seed} wei.`);
  console.log(`   ${account.address} now seeds flow reputation — flip KARMA_DISCOVERY_RANK=flow and restart.`);
}

main().catch((e) => {
  console.error("DEPOSIT BOND FAIL:", e);
  process.exit(1);
});
