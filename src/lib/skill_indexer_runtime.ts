import {
  startSkillIndexer,
  type IndexedEvent,
  type IndexerHealth,
  type SkillEventIndexer,
} from "./contract.js";
import { realKarmaService, type KarmaService, type OnchainSkill } from "./karma_service.js";
import { skillIndex, legacyReputationBoost, type SkillBoost } from "./bm25_index.js";
import { FlowBoostSource, type FlowEdge } from "./flow_reputation.js";
import type { SkillDocument } from "./types.js";

/**
 * Production wiring that connects the on-chain SkillEventIndexer to the in-process BM25 index,
 * and holds the live indexer so its health() can be surfaced through karma_health.
 *
 * This is the runtime that closes the gap the README maintainer notes flagged (PD-002): the
 * indexer state machine exists in contract.ts, but nothing started it or reconciled its events
 * into the discovery index. Started explicitly from index.ts main() — NOT at module import — so
 * unit tests that import karma.tool never trigger network I/O. Singleton + in-process only (D-1).
 *
 * Event reconciliation (chain → index):
 *   - SkillRegistered   → hydrate the full skill (readSkill) and upsert (event lacks
 *                         description/endpoint, which the BM25 doc needs).
 *   - SkillDeactivated  → discard from the index.
 *   - JobCompleted      → reputation bumped on-chain for the job's skill; the event carries no
 *                         skillId, so resolve jobId → skillId (readJob) and re-hydrate that skill.
 */

/** Build a BM25 SkillDocument from on-chain skill state. All uint256s become D-6-safe strings/numbers.
 *  `repOverride` lets the caller supply the authoritative reputation value from an event (e.g.
 *  JobCompleted.newReputation) instead of trusting a potentially-stale RPC re-read. */
export function skillDocFromChain(skillId: bigint, s: OnchainSkill, repOverride?: bigint): SkillDocument {
  return {
    id: Number(skillId),
    skill_id: Number(skillId),
    name: s.name,
    description: s.description,
    mcp_endpoint: s.mcpEndpoint,
    price_per_call_wei: String(s.pricePerCall),
    reputation_score: Number(repOverride ?? s.reputationScore),
    owner_address: s.owner,
    active: s.active,
  };
}

/**
 * Reconcile one indexed event into the discovery index. Pure over the KarmaService seam (testable).
 * `flow`, when provided, also captures the JobCompleted endorsement edge for Tier-1 flow reputation —
 * passed only when KARMA_DISCOVERY_RANK=flow (see startKarmaIndexer), so default behavior is unchanged.
 */
export async function applyIndexedEvent(
  svc: KarmaService,
  e: IndexedEvent,
  flow?: { record(edge: FlowEdge): void; setBondSeed(agent: string, bondWei: bigint): void },
): Promise<void> {
  switch (e.type) {
    case "SkillRegistered": {
      const s = await svc.readSkill(e.skillId);
      svc.indexUpsert(skillDocFromChain(e.skillId, s));
      return;
    }
    case "SkillDeactivated":
      svc.indexDiscard(Number(e.skillId));
      return;
    case "JobCompleted": {
      const job = await svc.readJob(e.jobId);
      // Self-deal guard (mirrors Tier-0): on-chain didn't change reputationScore/totalInvocations,
      // so there is no BM25 state to update and no flow edge to record — skip both RPC calls.
      if (job.requester.toLowerCase() === job.provider.toLowerCase()) return;
      const s = await svc.readSkill(job.skillId);
      // H1 fix: use e.newReputation (authoritative — carried in the event) instead of trusting
      // s.reputationScore which can be one block behind on a lagging RPC node.
      svc.indexUpsert(skillDocFromChain(job.skillId, s, e.newReputation));
      // Tier-1: record the arm's-length endorsement (requester paid provider) into the flow graph.
      flow?.record({
        from: job.requester,
        to: job.provider,
        valueWei: job.escrowAmount,
        timestamp: Number(job.completedAt),
      });
      return;
    }
    case "BondUpdated":
      // Tier-2: mirror an agent's on-chain seed-eligible bond into the flow-rep seed (0 ⇒ removed).
      // No BM25 doc change — bonds seed trust origination, not the skill text/price/active state.
      flow?.setBondSeed(e.agent, e.seedEligible);
      return;
    case "MinReputationSet":
      // H2 fix: persist the on-chain Trust Gate threshold without a full skill re-read, so
      // replaying this event after restart restores every skill's threshold — closes the Phase-1 gap.
      svc.indexSetMinReputation(Number(e.skillId), Number(e.minReputation));
      return;
  }
}

/** Hybrid boost for flow mode (M3): returns max(legacyReputationBoost, flowBoost) so agents with
 *  no flow-graph history still get the on-chain-rep floor (1.5 for base-50 rep) instead of the
 *  neutral 1.0. Exported as a pure function so it can be unit-tested without starting the indexer. */
export function makeFlowHybridBoost(flowSrc: { boostFor(addr: string): number }): SkillBoost {
  return (doc) => Math.max(legacyReputationBoost(doc), flowSrc.boostFor(doc.owner_address));
}

let indexer: SkillEventIndexer | undefined;
/** Tier-1 flow-reputation source, created only when KARMA_DISCOVERY_RANK=flow. Holds the live edge
 *  graph + cached boosts; wired into skillIndex.setBoost so discovery ranks by propagated trust. */
let flowBoost: FlowBoostSource | undefined;

/**
 * Start the live skill indexer once (idempotent). Backfills from `fromBlock` then watches.
 * Index-apply errors are logged, never thrown into the watcher loop. Returns the singleton.
 *
 * Events are applied STRICTLY in arrival order via a serial promise chain. `applyIndexedEvent`
 * mixes async (readSkill/readJob then upsert) and sync (discard) work; firing them concurrently
 * could let a later SkillDeactivated.discard run before an earlier SkillRegistered.upsert resolves,
 * leaving a deactivated skill in the index. Serializing keeps the index consistent with chain order.
 */
export function startKarmaIndexer(
  svc: KarmaService = realKarmaService,
  fromBlock: bigint = BigInt(process.env.KARMA_INDEXER_FROM_BLOCK ?? 0),
): SkillEventIndexer {
  if (indexer) return indexer;
  // M1 fix: read env at call time (not module load) so tests can set it before calling this function.
  if (process.env.KARMA_DISCOVERY_RANK === "flow") {
    flowBoost = new FlowBoostSource();
    // H3+M3 fix: hybrid boost gives new agents the legacy floor; ?. guards against shutdown race.
    skillIndex.setBoost(makeFlowHybridBoost({ boostFor: (addr) => flowBoost?.boostFor(addr) ?? 1 }));
    console.error("[KARMA] discovery ranking: Tier-1 flow reputation (KARMA_DISCOVERY_RANK=flow)");
  }
  let chain: Promise<void> = Promise.resolve();
  indexer = startSkillIndexer((e) => {
    chain = chain.then(() => applyIndexedEvent(svc, e, flowBoost)).catch((err) => {
      console.error(`[KARMA] skill-index reconcile failed for ${e.type}:`, err);
    });
  }, fromBlock);
  return indexer;
}

/** Indexer health for karma_health, or a not-started marker when the indexer was never wired. */
export function getKarmaIndexerHealth(): IndexerHealth | { started: false } {
  return indexer ? indexer.health() : { started: false };
}

/** Stop and clear the indexer (graceful shutdown / test reset). Restores the legacy boost. */
export function stopKarmaIndexer(): void {
  indexer?.stop();
  indexer = undefined;
  if (flowBoost) {
    skillIndex.setBoost(null);
    flowBoost = undefined;
  }
}
