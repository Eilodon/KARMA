/**
 * Pharos Atlantic connectivity gate (plan P0.2 / spec v3.1 D-4, AC6).
 *
 * Verifies the LIVE chain id and gas mode before any deploy/write is trusted.
 * Sources disagree (ChainList 688689 vs docs.pharos.xyz 688688) — this resolves it.
 *
 * Usage:
 *   PHAROS_RPC_URL=https://atlantic.dplabs-internal.com \
 *   [DEPLOYER_ADDRESS=0x...] tsx scripts/check_connectivity.ts
 */
import { createPublicClient, http, formatEther } from "viem";

const RPC = process.env.PHAROS_RPC_URL ?? "https://atlantic.dplabs-internal.com";

const client = createPublicClient({
  transport: http(RPC, { batch: { batchSize: 100 } }),
});

async function main(): Promise<void> {
  const chainId = await client.getChainId();
  const block = await client.getBlock();
  // EIP-1559 chains expose baseFeePerGas on the latest block; legacy chains do not.
  const gasMode = block.baseFeePerGas != null ? "eip1559" : "legacy";

  const addr = process.env.DEPLOYER_ADDRESS as `0x${string}` | undefined;
  const balance = addr ? await client.getBalance({ address: addr }) : 0n;

  console.log(
    JSON.stringify(
      {
        rpc: RPC,
        chainId,
        gasMode,
        baseFeePerGas: block.baseFeePerGas?.toString() ?? null,
        latestBlock: block.number?.toString() ?? null,
        deployer: addr ?? "(set DEPLOYER_ADDRESS to check balance)",
        balancePHRS: addr ? formatEther(balance) : "n/a",
      },
      null,
      2,
    ),
  );

  if (addr && balance === 0n) {
    console.error("⚠️  Deployer balance is 0 PHRS — claim from a faucet before deploying.");
  }
  console.error(
    `\n➡️  Record chainId=${chainId} gasMode=${gasMode} into .env (PHAROS_CHAIN_ID) ` +
      "and docs/superpowers/CONTEXT.md before any deploy/write (plan P0.2 gate).",
  );
}

main().catch((error) => {
  console.error("CONNECTIVITY FAIL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
