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
// Receipt-poll cadence. viem defaults to 4000ms, which dominates perceived confirm time on a
// fast chain. PHAROS_POLL_INTERVAL_MS (e.g. 300 for demos) tightens it; unset → viem default.
const POLL_INTERVAL_MS = process.env.PHAROS_POLL_INTERVAL_MS ? Number(process.env.PHAROS_POLL_INTERVAL_MS) : undefined;

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
  return createPublicClient({ chain: pharosAtlantic, transport, pollingInterval: POLL_INTERVAL_MS });
}

let _publicClient: ReturnType<typeof makePublicClient> | undefined;
/** Shared read client (singleton — safe only in-process, D-1). */
export function getPublicClient() {
  if (!_publicClient) _publicClient = makePublicClient();
  return _publicClient;
}

/** A write client bound to one keystore account (per-call; the account carries the nonceManager). */
export function getWalletClient(account: Account) {
  return createWalletClient({ account, chain: pharosAtlantic, transport, pollingInterval: POLL_INTERVAL_MS });
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
  | { type: "JobCompleted"; blockNumber: bigint; jobId: bigint; provider: Address; payout: bigint; newReputation: bigint }
  | { type: "BondUpdated"; blockNumber: bigint; agent: Address; bondedAmount: bigint; seedEligible: bigint }
  | { type: "MinReputationSet"; blockNumber: bigint; skillId: bigint; minReputation: bigint };

export interface IndexerWatchHandlers {
  onLogs: (events: IndexedEvent[]) => void;
  onError: (err: unknown) => void;
}

export interface IndexerDeps {
  getBlockNumber: () => Promise<bigint>;
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<IndexedEvent[]>;
  watch: (handlers: IndexerWatchHandlers) => () => void;
  now?: () => number;
  /**
   * Max blocks per getLogs call. A catch-up after long downtime — or the genesis backfill
   * (fromBlock=0) — can span a range larger than the RPC provider's eth_getLogs limit; chunking
   * keeps every request bounded so the call never rejects purely on range size. Default 2000.
   */
  maxBlockRange?: bigint;
  /** Backoff sleeper between reconnect attempts (injectable so tests don't actually wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Cap on reconnect retries before parking degraded. Default Infinity (self-heal forever). */
  maxReconnectAttempts?: number;
}

export interface IndexerHealth {
  watching: boolean;
  lastIndexedBlock: string; // stringified bigint (D-6)
  lastEventAt: number | null;
  /** Last reconnect/backfill error message, or null when healthy. Surfaced for ops (DoS visibility). */
  lastError: string | null;
  /** Consecutive failed reconnect attempts since the last successful (re)subscribe. */
  reconnectAttempts: number;
}

export class SkillEventIndexer {
  private lastIndexedBlock: bigint;
  private lastEventAt: number | null = null;
  private watching = false;
  private unwatch?: () => void;
  private readonly now: () => number;
  private readonly maxBlockRange: bigint;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxReconnectAttempts: number;
  // Reconnect resilience (DoS hardening, KARMA-PH1-001): a failed (re)backfill must NEVER escape
  // as an unhandled rejection — KARMA runs in-process (D-1), so an unhandled rejection would crash
  // the whole host. reconnect() therefore catches, backs off, and retries instead of rethrowing.
  private reconnecting = false;
  private stopped = false;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private static readonly BACKOFF_BASE_MS = 1_000;
  private static readonly BACKOFF_MAX_MS = 30_000;

  constructor(
    private readonly deps: IndexerDeps,
    private readonly onEvent: (e: IndexedEvent) => void,
    fromBlock = 0n,
  ) {
    this.lastIndexedBlock = fromBlock;
    this.now = deps.now ?? Date.now;
    this.maxBlockRange = deps.maxBlockRange && deps.maxBlockRange > 0n ? deps.maxBlockRange : 2000n;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxReconnectAttempts = deps.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
  }

  async start(): Promise<void> {
    try {
      await this.backfill();
      this.subscribe();
    } catch (err) {
      // Initial backfill failed (oversized range, RPC down, …). Do NOT throw — callers fire this
      // with `void`, so a rejection would be unhandled and crash the host. Fall into the same
      // resilient reconnect/backoff loop the live watcher uses, so the indexer self-heals.
      await this.reconnect(err);
    }
  }

  // Backfill is paginated: getLogs(from, to) is issued in windows of at most maxBlockRange,
  // advancing (and persisting) lastIndexedBlock after each window so a mid-backfill failure
  // resumes from the last good chunk instead of re-scanning from the start. BM25 upsert is
  // idempotent, so the inclusive lower bound (a 1-block overlap across restarts) is harmless.
  private async backfill(): Promise<void> {
    const head = await this.deps.getBlockNumber();
    if (head < this.lastIndexedBlock) return; // chain reorg/empty — nothing new
    let from = this.lastIndexedBlock;
    while (from <= head) {
      const to = head - from > this.maxBlockRange ? from + this.maxBlockRange : head;
      const logs = await this.deps.getLogs(from, to);
      for (const e of logs) this.process(e);
      if (to > this.lastIndexedBlock) this.lastIndexedBlock = to;
      from = to + 1n;
    }
  }

  private subscribe(): void {
    this.unwatch = this.deps.watch({
      onLogs: (events) => {
        for (const e of events) this.process(e);
      },
      // reconnect() is self-contained (never rejects); the extra .catch is belt-and-suspenders so
      // a future change can't turn this fire-and-forget into a host-crashing unhandled rejection.
      onError: (err) => void this.reconnect(err).catch((e) => console.error("[KARMA] indexer reconnect crashed:", e)),
    });
    this.watching = true;
  }

  // Resilient reconnect: re-backfill the gap then re-watch, retrying with capped exponential
  // backoff. Any rejection is caught and retried, NEVER rethrown. Overlapping calls are coalesced
  // via `reconnecting`; stop() breaks the loop. With the default (Infinity) cap it self-heals as
  // soon as the RPC recovers; a finite cap (tests / strict ops) parks degraded but still alive.
  private async reconnect(err: unknown): Promise<void> {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    this.watching = false;
    this.unwatch?.();
    this.unwatch = undefined;
    this.lastError = err instanceof Error ? err.message : String(err);
    try {
      for (let attempt = 1; !this.stopped && attempt <= this.maxReconnectAttempts; attempt += 1) {
        try {
          await this.backfill();
          this.subscribe();
          this.lastError = null;
          this.reconnectAttempts = 0;
          return;
        } catch (retryErr) {
          this.lastError = retryErr instanceof Error ? retryErr.message : String(retryErr);
          this.reconnectAttempts = attempt;
          const delay = Math.min(
            SkillEventIndexer.BACKOFF_BASE_MS * 2 ** (attempt - 1),
            SkillEventIndexer.BACKOFF_MAX_MS,
          );
          await this.sleep(delay);
        }
      }
      // Only reachable with a finite cap: the retry budget is spent. Park degraded (watching=false,
      // lastError set for karma_health) but alive — the host keeps serving the rest of its tools.
      console.error(`[KARMA] indexer reconnect gave up after ${this.reconnectAttempts} attempts: ${this.lastError}`);
    } finally {
      this.reconnecting = false;
    }
  }

  private process(e: IndexedEvent): void {
    if (e.blockNumber > this.lastIndexedBlock) this.lastIndexedBlock = e.blockNumber;
    this.lastEventAt = this.now();
    this.onEvent(e);
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = undefined;
    this.watching = false;
  }

  health(): IndexerHealth {
    return {
      watching: this.watching,
      lastIndexedBlock: this.lastIndexedBlock.toString(),
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

/** Map a raw viem contract-event log to the indexed shape (null = event we don't track). */
export function mapLog(raw: unknown): IndexedEvent | null {
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
    case "BondUpdated":
      return {
        type: "BondUpdated", blockNumber: bn,
        agent: a.agent as Address,
        bondedAmount: a.bondedAmount as bigint, seedEligible: a.seedEligible as bigint,
      };
    case "MinReputationSet":
      return {
        type: "MinReputationSet", blockNumber: bn,
        skillId: a.skillId as bigint, minReputation: a.minReputation as bigint,
      };
    default:
      return null;
  }
}

/** Map+filter a batch of raw viem logs to tracked IndexedEvents (drops untracked/pending logs). */
export function toIndexedEvents(logs: unknown[]): IndexedEvent[] {
  return logs.map(mapLog).filter((e): e is IndexedEvent => e !== null);
}

/**
 * The narrow subset of a viem public client the indexer wiring depends on. Declaring it
 * structurally is what makes buildViemIndexerDeps unit-testable with a fake client instead of
 * a live chain (closes the indexer half of PD-002).
 */
export interface IndexerEventClient {
  getBlockNumber(): Promise<bigint>;
  getContractEvents(args: {
    address: `0x${string}`;
    abi: typeof agentSkillRegistryAbi;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<unknown[]>;
  watchContractEvent(args: {
    address: `0x${string}`;
    abi: typeof agentSkillRegistryAbi;
    onLogs: (logs: unknown[]) => void;
    onError: (err: unknown) => void;
  }): () => void;
}

/** Build the viem-backed IndexerDeps for a client + contract address. Pure wiring — unit-testable. */
export function buildViemIndexerDeps(client: IndexerEventClient, address: `0x${string}`): IndexerDeps {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getLogs: async (from, to) =>
      toIndexedEvents(
        await client.getContractEvents({ address, abi: agentSkillRegistryAbi, fromBlock: from, toBlock: to }),
      ),
    watch: ({ onLogs, onError }) =>
      client.watchContractEvent({
        address,
        abi: agentSkillRegistryAbi,
        onLogs: (logs) => onLogs(toIndexedEvents(logs)),
        onError,
      }),
  };
}

/** Default eth_getLogs window when KARMA_INDEXER_BLOCK_RANGE is unset (safe for typical RPC limits). */
const DEFAULT_INDEXER_BLOCK_RANGE = 2000n;

/** Production wiring of the indexer over the real Pharos clients; starts immediately. */
export function startSkillIndexer(onEvent: (e: IndexedEvent) => void, fromBlock = 0n): SkillEventIndexer {
  // The viem PublicClient satisfies IndexerEventClient structurally — no cast needed.
  const rawRange = Number(process.env.KARMA_INDEXER_BLOCK_RANGE);
  const maxBlockRange = Number.isFinite(rawRange) && rawRange > 0 ? BigInt(Math.floor(rawRange)) : DEFAULT_INDEXER_BLOCK_RANGE;
  const deps: IndexerDeps = { ...buildViemIndexerDeps(getPublicClient(), getContractAddress()), maxBlockRange };
  const indexer = new SkillEventIndexer(deps, onEvent, fromBlock);
  // start() is internally resilient (its own catch → reconnect loop); the .catch is a final guard so
  // this fire-and-forget can never surface as a host-crashing unhandled rejection (in-process, D-1).
  void indexer.start().catch((err) => console.error("[KARMA] indexer start crashed:", err));
  return indexer;
}
