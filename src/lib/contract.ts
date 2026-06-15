import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  getAddress,
  keccak256,
  encodePacked,
  WaitForTransactionReceiptTimeoutError,
  type Account,
  type Address,
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

// ── Exactly-once guard (P4.2b / Failure-Mode-1) ────────────────────────────────
//
// createJob() has no on-chain idempotency key, so a lost-ack retry could create a second
// escrowed job. We derive a deterministic taskHash from (requester, skillId, nonce) — the
// same nonce always yields the same key — store it as the Job.taskHash, and check-before-
// write by scanning the requester's jobs for that key. No contract change needed.

/** Deterministic dedup key for a job request. Same (requester, skillId, nonce) → same hash. */
export function deriveTaskHash(requester: Address, skillId: bigint, nonce: bigint): Hash {
  return keccak256(
    encodePacked(["address", "uint256", "uint256"], [requester, skillId, nonce]),
  );
}

export interface JobReader {
  getRequesterJobs: (requester: Address) => Promise<readonly bigint[]>;
  getJobTaskHash: (jobId: bigint) => Promise<Hash>;
}

/** Returns an existing jobId carrying `taskHash`, or null if the request is new. */
export async function findJobByTaskHash(
  requester: Address,
  taskHash: Hash,
  reader: JobReader,
): Promise<bigint | null> {
  const jobIds = await reader.getRequesterJobs(requester);
  const target = taskHash.toLowerCase();
  for (const id of jobIds) {
    const th = await reader.getJobTaskHash(id);
    if (th.toLowerCase() === target) return id;
  }
  return null;
}

/** Production JobReader over the real Pharos clients (taskHash is jobs() tuple index 3). */
export function makeOnchainJobReader(): JobReader {
  const publicClient = getPublicClient();
  const address = getContractAddress();
  return {
    getRequesterJobs: (requester) =>
      publicClient.readContract({
        address,
        abi: agentSkillRegistryAbi,
        functionName: "getRequesterJobs",
        args: [requester],
      }),
    getJobTaskHash: async (jobId) => {
      const job = await publicClient.readContract({
        address,
        abi: agentSkillRegistryAbi,
        functionName: "jobs",
        args: [jobId],
      });
      return job[3]; // tuple index 3 = taskHash (bytes32)
    },
  };
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

// ── Event indexer (P4.3 / L4 / L6) ─────────────────────────────────────────────
//
// Keeps the in-process BM25 index reconciled with on-chain truth. On (re)start it backfills
// missed logs via getLogs(lastIndexedBlock, head) — closing the gap a dropped subscription or
// a restart would otherwise leave — then watches live. onError triggers reconnect (re-backfill
// + re-watch). lastIndexedBlock + lastEventAt form a heartbeat surfaced through karma_health.
// Downstream processing must be idempotent (BM25 upsert is) so the 1-block backfill overlap is
// harmless. The state machine below is decoupled from viem for unit testing.

export type IndexedEvent =
  | { type: "SkillRegistered"; blockNumber: bigint; skillId: bigint; owner: Address; name: string; pricePerCall: bigint }
  | { type: "SkillDeactivated"; blockNumber: bigint; skillId: bigint }
  | { type: "JobCompleted"; blockNumber: bigint; jobId: bigint; provider: Address; payout: bigint; newReputation: bigint };

export interface IndexerWatchHandlers {
  onLogs: (events: IndexedEvent[]) => void;
  onError: (err: unknown) => void;
}

export interface IndexerDeps {
  getBlockNumber: () => Promise<bigint>;
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<IndexedEvent[]>;
  watch: (handlers: IndexerWatchHandlers) => () => void;
  now?: () => number;
}

export interface IndexerHealth {
  watching: boolean;
  lastIndexedBlock: string; // stringified bigint (D-6)
  lastEventAt: number | null;
}

export class SkillEventIndexer {
  private lastIndexedBlock: bigint;
  private lastEventAt: number | null = null;
  private watching = false;
  private unwatch?: () => void;
  private readonly now: () => number;

  constructor(
    private readonly deps: IndexerDeps,
    private readonly onEvent: (e: IndexedEvent) => void,
    fromBlock = 0n,
  ) {
    this.lastIndexedBlock = fromBlock;
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    await this.backfill();
    this.subscribe();
  }

  private async backfill(): Promise<void> {
    const head = await this.deps.getBlockNumber();
    if (head < this.lastIndexedBlock) return; // chain reorg/empty — nothing new
    const logs = await this.deps.getLogs(this.lastIndexedBlock, head);
    for (const e of logs) this.process(e);
    if (head > this.lastIndexedBlock) this.lastIndexedBlock = head;
  }

  private subscribe(): void {
    this.unwatch = this.deps.watch({
      onLogs: (events) => {
        for (const e of events) this.process(e);
      },
      onError: (err) => void this.reconnect(err),
    });
    this.watching = true;
  }

  private async reconnect(_err: unknown): Promise<void> {
    this.watching = false;
    this.unwatch?.();
    await this.backfill();
    this.subscribe();
  }

  private process(e: IndexedEvent): void {
    if (e.blockNumber > this.lastIndexedBlock) this.lastIndexedBlock = e.blockNumber;
    this.lastEventAt = this.now();
    this.onEvent(e);
  }

  stop(): void {
    this.unwatch?.();
    this.watching = false;
  }

  health(): IndexerHealth {
    return {
      watching: this.watching,
      lastIndexedBlock: this.lastIndexedBlock.toString(),
      lastEventAt: this.lastEventAt,
    };
  }
}

/** Map a raw viem contract-event log to the indexed shape (null = event we don't track). */
function mapLog(raw: unknown): IndexedEvent | null {
  const log = raw as { eventName?: string; args?: Record<string, unknown>; blockNumber?: bigint | null };
  const bn = log.blockNumber;
  const a = log.args;
  if (bn == null || !log.eventName || !a) return null; // pending log or unrelated
  switch (log.eventName) {
    case "SkillRegistered":
      return {
        type: "SkillRegistered", blockNumber: bn,
        skillId: a.skillId as bigint, owner: a.owner as Address,
        name: a.name as string, pricePerCall: a.pricePerCall as bigint,
      };
    case "SkillDeactivated":
      return { type: "SkillDeactivated", blockNumber: bn, skillId: a.skillId as bigint };
    case "JobCompleted":
      return {
        type: "JobCompleted", blockNumber: bn,
        jobId: a.jobId as bigint, provider: a.provider as Address,
        payout: a.payout as bigint, newReputation: a.newReputation as bigint,
      };
    default:
      return null;
  }
}

/** Production wiring of the indexer over the real Pharos clients; starts immediately. */
export function startSkillIndexer(onEvent: (e: IndexedEvent) => void, fromBlock = 0n): SkillEventIndexer {
  const publicClient = getPublicClient();
  const address = getContractAddress();
  const toEvents = (logs: unknown[]): IndexedEvent[] =>
    logs.map(mapLog).filter((e): e is IndexedEvent => e !== null);
  const deps: IndexerDeps = {
    getBlockNumber: () => publicClient.getBlockNumber(),
    getLogs: async (from, to) =>
      toEvents(
        await publicClient.getContractEvents({
          address,
          abi: agentSkillRegistryAbi,
          fromBlock: from,
          toBlock: to,
        }),
      ),
    watch: ({ onLogs, onError }) =>
      publicClient.watchContractEvent({
        address,
        abi: agentSkillRegistryAbi,
        onLogs: (logs) => onLogs(toEvents(logs as unknown[])),
        onError,
      }),
  };
  const indexer = new SkillEventIndexer(deps, onEvent, fromBlock);
  void indexer.start();
  return indexer;
}
