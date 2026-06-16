import MiniSearch from "minisearch";
import type { SkillDocument } from "./types.js";

/**
 * In-process BM25 skill discovery index (Layer 2).
 *
 * MiniSearch over (name, description), updated incrementally from contract events
 * (SkillRegistered → upsert, SkillDeactivated → discard). Ranking blends text relevance
 * with on-chain reputation via boostDocument. price_per_call_wei stays a string everywhere
 * (D-6 — BigInt-safe) and price/reputation filters compare with BigInt/Number, never coercing
 * a uint256 through a JS number. Indexed text is sanitized so a skill's attacker-controlled
 * name/description cannot smuggle hidden instructions to a discovering agent (Abductive-2).
 *
 * Singleton — safe only because karma.tool runs in-process (D-1).
 */

const STORE_FIELDS = [
  "skill_id",
  "name",
  "description",
  "mcp_endpoint",
  "price_per_call_wei",
  "reputation_score",
  "owner_address",
  "active",
  "min_reputation_to_invoke",
] as const;

/** True for control / zero-width / bidi-override / BOM code points (tab/newline/CR excepted). */
function isDangerous(x: number): boolean {
  if (x === 0x09 || x === 0x0a || x === 0x0d) return false; // keep real whitespace
  return (
    x < 0x20 ||
    x === 0x7f ||
    (x >= 0x200b && x <= 0x200f) ||
    (x >= 0x202a && x <= 0x202e) ||
    x === 0x2060 ||
    x === 0xfeff
  );
}

/** Strip dangerous code points, collapse whitespace, cap length. */
export function sanitizeText(input: string): string {
  let out = "";
  for (const ch of input) {
    if (!isDangerous(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 2000);
}

function sanitizeDoc(doc: SkillDocument): SkillDocument {
  return {
    ...doc,
    id: doc.skill_id,
    name: sanitizeText(doc.name),
    description: sanitizeText(doc.description),
  };
}

export interface SkillSearchHit {
  skill_id: number;
  name: string;
  description: string;
  mcp_endpoint: string;
  price_per_call_wei: string;
  reputation_score: number;
  owner_address: string;
  min_reputation_to_invoke: number; // Trust Gate threshold (0 = no gate)
  score: number;
}

export interface SkillSearchOptions {
  maxPriceWei?: bigint;
  minReputation?: number;
  limit?: number;
}

export class BM25SkillIndex {
  private readonly ms: MiniSearch<SkillDocument>;
  // MiniSearch can't enumerate by a stored field, so we keep a parallel id→doc map to answer
  // getByOwner() without an RPC. Kept in lockstep with the index in upsert()/discard().
  private readonly byId = new Map<number, SkillDocument>();

  constructor() {
    this.ms = new MiniSearch<SkillDocument>({
      idField: "id",
      fields: ["name", "description"],
      storeFields: [...STORE_FIELDS],
      searchOptions: { prefix: true, fuzzy: 0.2, boost: { name: 2 } },
    });
  }

  /** Add or replace a skill (idempotent — keyed by skill_id). */
  upsert(doc: SkillDocument): void {
    const clean = sanitizeDoc(doc);
    // Trust Gate (Phase 1): the threshold is app-layer only, so a chain re-hydration
    // (skillDocFromChain) arrives with it undefined. Only register_skill ever sets it, and a
    // skill's threshold is fixed at registration, so carry a previously-declared value forward
    // instead of letting an indexer re-emit reset the gate. (Does not survive process restart —
    // see plan 2026-06-16-trust-gate-min-reputation, Phase-1 limitation.)
    if (clean.min_reputation_to_invoke === undefined) {
      const prior = this.byId.get(clean.id);
      if (prior?.min_reputation_to_invoke !== undefined) {
        clean.min_reputation_to_invoke = prior.min_reputation_to_invoke;
      }
    }
    if (this.ms.has(clean.id)) this.ms.replace(clean);
    else this.ms.add(clean);
    this.byId.set(clean.id, clean);
  }

  /** Remove a skill from results (e.g. on SkillDeactivated). */
  discard(skillId: number): void {
    if (this.ms.has(skillId)) this.ms.discard(skillId);
    this.byId.delete(skillId);
  }

  /**
   * First indexed skill document owned by `ownerAddress` (case-insensitive), or null.
   * Used by query_social_graph format:"full" to source a reputation_score with no extra RPC.
   * Returns null when the agent has registered no skill — callers fall back to BASE (50).
   */
  getByOwner(ownerAddress: string): SkillDocument | null {
    const target = ownerAddress.toLowerCase();
    for (const doc of this.byId.values()) {
      if (doc.owner_address.toLowerCase() === target) return doc;
    }
    return null;
  }

  /** Indexed skill document by id, or null. */
  getById(skillId: number): SkillDocument | null {
    return this.byId.get(skillId) ?? null;
  }

  /**
   * Trust Gate (Phase 1) requester reputation: the max on-chain reputation across the skills
   * `ownerAddress` owns, or 0 if it owns none (⇒ blocked by any threshold > 0). Index-derived,
   * 0 extra RPC. Phase 2 replaces this with a purpose-built on-chain agentReputation.
   */
  getReputation(ownerAddress: string): number {
    const target = ownerAddress.toLowerCase();
    let max = 0;
    for (const doc of this.byId.values()) {
      if (doc.owner_address.toLowerCase() === target && doc.reputation_score > max) {
        max = doc.reputation_score;
      }
    }
    return max;
  }

  /** Trust Gate threshold declared for a skill (0 = no gate / unknown to this process). */
  getThreshold(skillId: number): number {
    return this.byId.get(skillId)?.min_reputation_to_invoke ?? 0;
  }

  size(): number {
    return this.ms.documentCount;
  }

  search(query: string, opts: SkillSearchOptions = {}): SkillSearchHit[] {
    const results = this.ms.search(query, {
      boostDocument: (_id, _term, stored) => {
        const rep = Number((stored as { reputation_score?: number } | undefined)?.reputation_score ?? 0);
        return 1 + rep / 100; // reputation 0..100 → boost factor 1.0..2.0
      },
      filter: (r) => {
        const row = r as unknown as SkillDocument;
        if (!row.active) return false;
        if (opts.minReputation != null && row.reputation_score < opts.minReputation) return false;
        if (opts.maxPriceWei != null && BigInt(row.price_per_call_wei) > opts.maxPriceWei) return false;
        return true;
      },
    });
    const hits = results.map((r) => {
      const row = r as unknown as SkillDocument & { score: number };
      return {
        skill_id: row.skill_id,
        name: row.name,
        description: row.description,
        mcp_endpoint: row.mcp_endpoint,
        price_per_call_wei: row.price_per_call_wei,
        reputation_score: row.reputation_score,
        owner_address: row.owner_address,
        min_reputation_to_invoke: row.min_reputation_to_invoke ?? 0,
        score: row.score,
      };
    });
    return opts.limit != null ? hits.slice(0, opts.limit) : hits;
  }

  /** Cold-start: page through on-chain skills and index them all. */
  async rebuildFromChain(
    loadPage: (offset: number, limit: number) => Promise<SkillDocument[]>,
    pageSize = 50,
  ): Promise<void> {
    let offset = 0;
    for (;;) {
      const page = await loadPage(offset, pageSize);
      if (page.length === 0) break;
      for (const d of page) this.upsert(d);
      if (page.length < pageSize) break;
      offset += page.length;
    }
  }
}

/** Module singleton — safe only because karma.tool runs in-process (D-1). */
export const skillIndex = new BM25SkillIndex();
