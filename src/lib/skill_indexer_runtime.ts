import {
  startSkillIndexer,
  type IndexedEvent,
  type IndexerHealth,
  type SkillEventIndexer,
} from "./contract.js";
import { realKarmaService, type KarmaService, type OnchainSkill } from "./karma_service.js";
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

/** Build a BM25 SkillDocument from on-chain skill state. All uint256s become D-6-safe strings/numbers. */
export function skillDocFromChain(skillId: bigint, s: OnchainSkill): SkillDocument {
  return {
    id: Number(skillId),
    skill_id: Number(skillId),
    name: s.name,
    description: s.description,
    mcp_endpoint: s.mcpEndpoint,
    price_per_call_wei: String(s.pricePerCall),
    reputation_score: Number(s.reputationScore),
    owner_address: s.owner,
    active: s.active,
  };
}

/** Reconcile one indexed event into the discovery index. Pure over the KarmaService seam (testable). */
export async function applyIndexedEvent(svc: KarmaService, e: IndexedEvent): Promise<void> {
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
      const s = await svc.readSkill(job.skillId);
      svc.indexUpsert(skillDocFromChain(job.skillId, s));
      return;
    }
  }
}

let indexer: SkillEventIndexer | undefined;

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
  let chain: Promise<void> = Promise.resolve();
  indexer = startSkillIndexer((e) => {
    chain = chain.then(() => applyIndexedEvent(svc, e)).catch((err) => {
      console.error(`[KARMA] skill-index reconcile failed for ${e.type}:`, err);
    });
  }, fromBlock);
  return indexer;
}

/** Indexer health for karma_health, or a not-started marker when the indexer was never wired. */
export function getKarmaIndexerHealth(): IndexerHealth | { started: false } {
  return indexer ? indexer.health() : { started: false };
}

/** Stop and clear the indexer (graceful shutdown / test reset). */
export function stopKarmaIndexer(): void {
  indexer?.stop();
  indexer = undefined;
}
