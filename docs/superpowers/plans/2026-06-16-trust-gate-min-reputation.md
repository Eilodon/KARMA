# Plan: Trust Gate (`min_reputation_to_invoke`) — 2-phase

**Status:** Phase 1 IN PROGRESS · Phase 2 DEFERRED (rationale below)
**Date:** 2026-06-16
**Related:** [[karma-app-layer]], ADR 2026-06-16-karma-graph-withdraw-indexer, PD-003 (contract v2 trigger)

## Goal

Let a skill owner declare a minimum requester reputation required to invoke their skill —
the "trust boundary" an institutional/high-value skill needs so a zero-history agent can't
escrow against it. Original request framed it as: add `min_reputation_to_invoke` at
`register_skill`; `createJob` reverts if `requester reputation < threshold`.

## Two hard truths the original framing skipped

1. **"Requester reputation" does not exist yet.** KARMA reputation is per-**skill**
   (`Skill.reputationScore`, bumped in `confirmCompletion`), not per-**agent**. There is no
   value to compare against a threshold. A real gate must first *define and maintain* a
   per-agent reputation. (The app already fakes this at `karma.tool.ts` `handleFullFormat`,
   using the owner's first indexed skill reputation as a proxy.)
2. **The contract is deployed and immutable.** `AgentSkillRegistry` has no proxy/upgrade path.
   Adding a field to the `Skill` struct changes storage layout → requires a **redeploy +
   migration** (re-register every skill, repoint `PHAROS_CONTRACT_ADDRESS`, re-index from the
   new deploy block). Not an in-place edit.

→ Therefore: ship an app-layer gate now (Phase 1), fold the authoritative on-chain gate into
the next planned redeploy (Phase 2).

---

## Phase 1 — App-layer advisory gate (THIS CYCLE, no contract change)

### Scope
- `register_skill` accepts optional `minReputationToInvoke` (0..100, default 0). Stored in the
  in-process BM25 `SkillDocument` as **app-layer policy** (NOT on-chain).
- `create_job` computes the requester's reputation (0-RPC, index-derived) and, if the target
  skill's threshold > 0 and `requesterReputation < threshold`, returns a structured
  `status: "rejected"` **before any escrow / on-chain write**.
- Requester reputation (Phase 1 metric) = **max `reputation_score` across skills the address
  owns**, else `0`. Index-derived (0 extra RPC), consistent with the contract's existing
  reputation semantics. No owned skill ⇒ `0` ⇒ blocked by any threshold > 0 (matches intent).
- Surface the metric: `get_agent_reputation` returns an `agentReputation` field;
  `discover_skills` hits expose `min_reputation_to_invoke` so a requester sees the gate first.

### Threshold durability (the Phase-1 limitation, by design)
The threshold has no on-chain home, so the indexer's chain re-hydration
(`skillDocFromChain`) carries no threshold. `BM25SkillIndex.upsert` **carries forward** a
previously-declared threshold when the incoming doc omits it, so a re-emit/reconnect within
the same process does not wipe it. It does **not** survive a full process restart (cold-start
rebuilds from chain, which has no threshold), and thresholds set by *other* processes/agents
are unknown to this one. These gaps are exactly what Phase 2 closes.

### Files
- `src/lib/types.ts` — `SkillDocument.min_reputation_to_invoke?: number`.
- `src/lib/bm25_index.ts` — store field; `upsert` carry-forward; `getById`,
  `getReputation(owner)`, `getThreshold(skillId)`; `SkillSearchHit.min_reputation_to_invoke`.
- `src/lib/karma_service.ts` — `getSkillThreshold(skillId)`, `getReputation(addr)` (index-backed).
- `src/plugins/karma.tool.ts` — register param + index doc; create_job gate; get_agent_reputation.
- Tests: `bm25_index.test.ts` (carry-forward, getReputation, getThreshold, hit field),
  `karma_tools.test.ts` (gate blocks/allows, register passes threshold, agentReputation).

### Non-goals (Phase 1)
- NOT consensus-enforced: a direct contract caller bypasses it entirely. Advisory only.
- Does NOT change the contract, ABI, or deployed address. ABI drift-guard untouched.

---

## Phase 2 — On-chain enforcement (DEFERRED, next redeploy)

### Scope (design locked, not built)
- Add `mapping(address => uint256) public agentReputation`, lazy-init `BASE_REPUTATION` (50) so
  a fresh ecosystem isn't chicken-and-egg-locked (everyone-at-0 makes any threshold > 0
  un-invokable). Earned via completed jobs.
- `confirmCompletion` bumps `agentReputation` for both roles **only when
  `requester != provider`** (blunts trivial self-deal farming; the existing skill-rep farm has
  the same hole and is also fixed here since we redeploy anyway).
- `Skill` gains `uint8 minReputationToInvoke`, placed adjacent to `bool active` (packs in one
  slot — no extra SSTORE). Set via extended `registerSkill` + a `setMinReputation(skillId, v)`
  owner-only setter.
- `createJob`: `require(agentReputation[msg.sender] >= s.minReputationToInvoke, "insufficient reputation")`.
- App lockstep: `abi.ts` (skills tuple + `agentReputation` getter + setter), drift-guard,
  `karma_service.ts` decode, `karma.tool.ts` preflight (simulate already reverts pre-broadcast).
- Foundry tests: gate blocks under-rep requester, allows at/above, bootstrap, self-deal no-farm.

### Why DEFERRED (record this)
1. **Requires a redeploy + data migration** — immutable contract, storage-layout change. Must
   ride the next planned contract version (see PD-003: `jobByTaskHash` O(1) dedup also waits on
   contract v2). Batching these into one redeploy avoids two migrations.
2. **Reputation is only as strong as it is expensive to earn.** On a free testnet, agent
   reputation is wash-tradeable between two colluding addresses even with the `requester !=
   provider` guard. True Sybil-resistance needs stake/identity — out of scope. Shipping
   on-chain enforcement now would imply a guarantee it can't make. Phase 1's advisory gate is
   the honest level of assurance until staking exists.
3. **Phase 1 validates the UX and metric** at near-zero cost/risk, informing the on-chain
   threshold tuning (and whether the metric should be owned-skill-max vs completed-job-count)
   before paying for immutable storage.

### Phase 2 resolution trigger
Bundle into the next `AgentSkillRegistry` redeploy — whichever fires first: PD-003 (`jobCount()
> 1000` or a requester owns > 100 jobs) OR a concrete institutional-skill customer needs
consensus-level enforcement OR a staking/identity primitive lands that makes reputation
Sybil-costly. At that point, build Phase 2 alongside the other contract-v2 changes, migrate,
and demote Phase 1's index threshold to a cache of the on-chain value.
