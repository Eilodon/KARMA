import { readFileSync } from "node:fs";
import { keystoreManager } from "../lib/keystore.js";
import { getPublicClient, getWalletClient, pharosAtlantic } from "../lib/contract.js";
import { agentSkillRegistryAbi } from "../lib/abi.js";

/**
 * Deploy AgentSkillRegistry to Pharos Atlantic, signing in-process with a keystore account
 * (the private key never leaves KeystoreManager — same path the runtime/demo use). Bytecode
 * comes from the forge artifact, whose ABI is drift-guarded against src/lib/abi.ts.
 *
 *   KEYSTORE_PASSWORD=... tsx src/scripts/deploy_contract.ts
 * Then record the printed address into .env as PHAROS_CONTRACT_ADDRESS (plan P2.6 gate).
 */
const PASSWORD = process.env.KEYSTORE_PASSWORD;
const KEYSTORE_PATH = process.env.KEYSTORE_PATH ?? "./keystore.json";
const DEPLOYER_AGENT = process.env.DEPLOYER_AGENT ?? "agent-alpha";
const ARTIFACT_PATH = "./out/AgentSkillRegistry.sol/AgentSkillRegistry.json";
// Review window is deploy-time config (immutable afterwards); default 3 days, bounded on-chain to [1h,30d].
const REVIEW_WINDOW_SECS = BigInt(process.env.KARMA_REVIEW_WINDOW_SECS ?? 3 * 24 * 60 * 60);

async function main(): Promise<void> {
  if (!PASSWORD) throw new Error("Set KEYSTORE_PASSWORD to unlock the keystore.");
  await keystoreManager.load(KEYSTORE_PATH, PASSWORD);
  const account = keystoreManager.getAccount(DEPLOYER_AGENT);

  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as { bytecode: { object: `0x${string}` } };
  const bytecode = artifact.bytecode.object;

  const publicClient = getPublicClient();
  const walletClient = getWalletClient(account);

  const bal = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer ${DEPLOYER_AGENT} ${account.address} balance=${bal} wei`);
  if (bal === 0n) throw new Error("Deployer has 0 balance — fund it from a faucet first.");

  console.log(`Deploying AgentSkillRegistry (REVIEW_WINDOW=${REVIEW_WINDOW_SECS}s)...`);
  const hash = await walletClient.deployContract({
    abi: agentSkillRegistryAbi,
    bytecode,
    args: [REVIEW_WINDOW_SECS],
    account,
    chain: pharosAtlantic,
  });
  console.log(`deploy tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(
    JSON.stringify(
      {
        status: receipt.status,
        contractAddress: receipt.contractAddress,
        gasUsed: receipt.gasUsed.toString(),
        block: receipt.blockNumber.toString(),
      },
      null,
      2,
    ),
  );
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error("Deployment reverted.");
  }
  console.log(`\n✅ Set PHAROS_CONTRACT_ADDRESS=${receipt.contractAddress} in .env`);
}

main().catch((e) => {
  console.error("DEPLOY FAIL:", e);
  process.exit(1);
});
