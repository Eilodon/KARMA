import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  getAddress,
  type Account,
} from "viem";

/**
 * Pharos Atlantic chain + batched viem clients for the AgentSkillRegistry.
 *
 * Live-verified (src/scripts/check_connectivity.ts): chainId=688689, gasMode=eip1559.
 * Transport uses Batch JSON-RPC (batchSize 100) to collapse the many small reads the
 * indexer / discovery paths make. `multicall` is deliberately OFF — Multicall3 is not
 * verified deployed on Pharos Atlantic (plan Open Decision); batching is the safe reducer.
 *
 * These clients are the single network entrypoint for the in-process KARMA plugin.
 */

const RPC_URL = process.env.PHAROS_RPC_URL ?? "https://atlantic.dplabs-internal.com";
const CHAIN_ID = Number(process.env.PHAROS_CHAIN_ID ?? 688689);

/** MCP execution-lock TTL (src Layer-0). A receipt wait must give up before this. */
export const MCP_LOCK_TTL_MS = 420_000;
/** Bounded receipt wait — strictly < MCP_LOCK_TTL_MS so a slow tx never outlives its lock. */
export const RECEIPT_TIMEOUT_MS = 300_000;

export const pharosAtlantic = defineChain({
  id: CHAIN_ID,
  name: "Pharos Atlantic",
  nativeCurrency: { decimals: 18, name: "Pharos", symbol: "PHRS" },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const transport = http(RPC_URL, { batch: { batchSize: 100 } });

function makePublicClient() {
  return createPublicClient({ chain: pharosAtlantic, transport });
}

let _publicClient: ReturnType<typeof makePublicClient> | undefined;
/** Shared read client (singleton — safe only in-process, D-1). */
export function getPublicClient() {
  if (!_publicClient) _publicClient = makePublicClient();
  return _publicClient;
}

/** A write client bound to one keystore account (per-call; the account carries the nonceManager). */
export function getWalletClient(account: Account) {
  return createWalletClient({ account, chain: pharosAtlantic, transport });
}

/** Deployed AgentSkillRegistry address from env; throws if not yet deployed (plan P2.6 gate). */
export function getContractAddress(): `0x${string}` {
  const addr = process.env.PHAROS_CONTRACT_ADDRESS;
  if (!addr) {
    throw new Error(
      "[KARMA] PHAROS_CONTRACT_ADDRESS not set — deploy AgentSkillRegistry first (plan P2.6).",
    );
  }
  return getAddress(addr);
}
