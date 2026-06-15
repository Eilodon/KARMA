import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  getAddress,
  WaitForTransactionReceiptTimeoutError,
  type Account,
  type Hash,
  type TransactionReceipt,
} from "viem";
import { agentSkillRegistryAbi } from "./abi.js";

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

// ── Bounded write helper (P4.2a / D-7 / Abductive-1) ───────────────────────────
//
// A write must broadcast exactly once and then wait for a receipt for a BOUNDED time.
// If the receipt does not arrive before RECEIPT_TIMEOUT_MS (< MCP_LOCK_TTL_MS), the tx is
// still on the wire — we surface a typed `pending` outcome and the caller MUST NOT resend
// (resending double-spends). The policy below is deliberately decoupled from viem so it can
// be unit-tested; `writeContractBounded` wires the real clients (exercised live in P7).

export type WriteOutcome =
  | { status: "confirmed"; hash: Hash; receipt: TransactionReceipt }
  | { status: "pending"; hash: Hash };

export interface BoundedWriteOps {
  /** Static-call the tx; returns the prepared request (throws on revert before any broadcast). */
  simulate: () => Promise<{ request: unknown }>;
  /** Broadcast the prepared request; called AT MOST ONCE. */
  write: (request: unknown) => Promise<Hash>;
  /** Wait for the receipt, rejecting with WaitForTransactionReceiptTimeoutError on timeout. */
  waitReceipt: (hash: Hash, timeoutMs: number) => Promise<TransactionReceipt>;
}

export async function runBoundedWrite(
  ops: BoundedWriteOps,
  timeoutMs: number,
): Promise<WriteOutcome> {
  const { request } = await ops.simulate();
  const hash = await ops.write(request); // single broadcast
  try {
    const receipt = await ops.waitReceipt(hash, timeoutMs);
    return { status: "confirmed", hash, receipt };
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) {
      // Tx is broadcast; the lock may be near expiry. Hand back `pending`, never resend.
      return { status: "pending", hash };
    }
    throw err; // reverts and all other errors propagate
  }
}

/** Production wiring of runBoundedWrite over the real Pharos clients. */
export async function writeContractBounded(
  account: Account,
  call: { functionName: string; args: readonly unknown[]; value?: bigint },
  timeoutMs: number = RECEIPT_TIMEOUT_MS,
): Promise<WriteOutcome> {
  const publicClient = getPublicClient();
  const walletClient = getWalletClient(account);
  const address = getContractAddress();
  return runBoundedWrite(
    {
      simulate: async () => {
        const { request } = await publicClient.simulateContract({
          address,
          abi: agentSkillRegistryAbi,
          functionName: call.functionName,
          args: call.args,
          value: call.value,
          account,
        } as never);
        return { request };
      },
      write: (request) => walletClient.writeContract(request as never),
      waitReceipt: (hash, t) => publicClient.waitForTransactionReceipt({ hash, timeout: t }),
    },
    timeoutMs,
  );
}
