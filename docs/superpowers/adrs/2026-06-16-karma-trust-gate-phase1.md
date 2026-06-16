# ADR: KARMA Trust Gate (`min_reputation_to_invoke`) — Phase 1 (app-layer)

## 1. Title
Add an owner-declared per-skill reputation threshold that `create_job` enforces app-side before
escrow, plus a surfaced per-agent reputation metric — Phase 1 of a 2-phase plan whose Phase 2
(on-chain enforcement) is deliberately deferred to the next contract redeploy.

## 2. Context
A requested differentiator: let an institutional / high-value skill require a minimum requester
reputation so a zero-history agent can't escrow against it ("trust boundary"). The original framing
("add `uint8` to the `Skill` struct, revert in `createJob`, update the ABI drift guard") hid two
hard truths surfaced during research:
1. **"Requester reputation" does not exist.** KARMA reputation is per-**skill**
   (`Skill.reputationScore`, bumped in `confirmCompletion`), never per-**agent**. There is no value
   to gate on; the app already faked one via `getByOwner` (owner's first indexed skill).
2. **The deployed `AgentSkillRegistry` is immutable** (no proxy). Adding a struct field changes
   storage layout → redeploy + skill migration, not an in-place edit.

Carried constraints: in-process trust (D-1), every uint256 crosses the boundary as a string (D-6),
**no contract change this cycle**. Full plan: `plans/2026-06-16-trust-gate-min-reputation.md`.

## 3. Decision
Ship the gate at the app layer (advisory), defer on-chain enforcement to the next redeploy.
- **Threshold as index policy** (`types.ts`, `bm25_index.ts`): `SkillDocument.min_reputation_to_invoke?`
  added to `STORE_FIELDS` and `SkillSearchHit`. `register_skill` accepts `minReputationToInvoke`
  (0..100, default 0) and writes it into the index doc; it is NOT sent on-chain (no field exists).
- **Carry-forward durability** (`bm25_index.ts` `upsert`): the indexer re-hydrates skills from chain
  via `skillDocFromChain`, which has no threshold. `upsert` preserves a previously-declared threshold
  when the incoming doc omits it — only `register_skill` ever sets it and it is fixed at registration,
  so an indexer re-emit/reconnect within the process won't reset the gate.
- **The gate** (`karma.tool.ts` `create_job`): after the `active` check and before deriving the
  task hash / escrowing, if `getSkillThreshold(skillId) > 0` and `getReputation(requester) < threshold`,
  return `{ status: "rejected", reason: "insufficient_reputation", skillId, requesterReputation,
  requiredReputation }` — no on-chain write, no escrow.
- **Reputation metric** (`bm25_index.ts` `getReputation`, `karma_service.ts`): requester reputation =
  max `reputation_score` across skills the address owns (index-derived, 0 extra RPC), else 0 (⇒
  blocked by any threshold > 0). Surfaced via `get_agent_reputation` (`agentReputation` field) and on
  `discover_skills` hits (`min_reputation_to_invoke`) so requesters see the gate before trying.
- **Service seam** (`karma_service.ts`): `getSkillThreshold(skillId)` + `getReputation(addr)` added to
  `KarmaService`, both index-backed; tools unit-test against the fake.

## 4. Status
ACCEPTED

## 5. Consequences
**Improved:** providers can declare a trust threshold; under-reputation requesters are rejected
before any escrow (no wasted tx); the per-agent reputation the gate checks is now a first-class,
surfaced value (replacing the implicit `getByOwner` proxy in display paths); zero contract/ABI/deploy
change, so the drift-guard and live address are untouched and the change is fully reversible.
**Worsened / debt (PD-005):** the gate is **advisory, not consensus** — a direct `createJob` caller
bypasses it. The threshold lives only in the in-process index: it does not survive a process restart
(cold-start rebuilds from chain, which carries no threshold) and is invisible to other processes. The
Phase-1 metric (max owned-skill reputation) differs from Phase 2's planned on-chain `agentReputation`
(base 50, earned on completed jobs), so thresholds may need re-tuning at cutover.

## 6. Alternatives Considered
- **Implement on-chain now (original framing)** — rejected this cycle: requires a redeploy + skill
  migration (immutable contract) and a new per-agent reputation subsystem; and on a free testnet
  reputation is wash-tradeable, so on-chain enforcement would imply a Sybil-resistance guarantee it
  can't make without staking/identity. Designed and deferred as Phase 2 (PD-005).
- **Persist thresholds in an app-layer store (fs/redis) for restart durability** — rejected: that is
  re-inventing on-chain storage off-chain; the authoritative home is the contract (Phase 2). Process-
  lifetime carry-forward is the honest Phase-1 scope.
- **Reputation = owner's first indexed skill (`getByOwner`)** — rejected for the gate: max-over-owned
  is more faithful and still 0-RPC. `getByOwner`'s BASE-50 display fallback left unchanged (cosmetic).
- **Special-case owner self-invoke (bypass gate)** — rejected: a fresh owned skill already gives the
  owner reputation 50 via the index, so an owner can set a threshold ≤ their own reputation; no
  special path needed, fewer surprises.

## 7. Evidence
- `pnpm typecheck` → clean; `pnpm lint` → clean. [verified 2026-06-16]
- `pnpm test` (full `src`): **350 passed | 1 skipped | 0 failed, 52 files**. [verified 2026-06-16]
- New tests: gate rejects below / allows at-or-above / threshold-0 skips (`karma_tools.test.ts`);
  `register_skill` threshold passthrough; `get_agent_reputation` surfaces `agentReputation`;
  index threshold in hits + `getThreshold` + carry-forward + `getReputation` max
  (`bm25_index.test.ts`). [verified 2026-06-16]
- Gate fires before escrow: `create_job` returns `status:"rejected"` with `svc.createJob` not called.
  [verified 2026-06-16 — `karma_tools.test.ts`]
- ABI / deployed contract / drift-guard unchanged (no `.sol` or `abi.ts` edit). [verified 2026-06-16]

## 8. Owner
**KARMA team — gokuderafight@gmail.com**

## 8b. Known Debts (PATTERN-DEBT)
  - PD-005: OPEN (new) — Trust Gate is app-layer advisory, not on-chain enforced; threshold not
    restart-durable; Phase-1 metric ≠ Phase-2 on-chain metric. Phase 2 design locked, not built.
  - PD-003: OPEN (unchanged) — exactly-once guard is an O(n) `getRequesterJobs` scan; bundle Phase 2
    enforcement into the same contract-v2 redeploy to avoid a second migration.
  - PD-002 / PD-004: OPEN (unchanged) — read/write integration coverage; indexer checkpoint.

## 9. Next Cycle Trigger
Build Phase 2 (on-chain `Skill.minReputationToInvoke` + `agentReputation` mapping + `createJob`
require) on the next `AgentSkillRegistry` redeploy — whichever fires first: PD-003 (`jobCount() >
1000` or a requester owns > 100 jobs) OR a concrete institutional-skill customer needs consensus-level
enforcement OR a staking/identity primitive lands that makes reputation Sybil-costly. Then demote the
index threshold to a cache of the on-chain value.

## 10. Cycle Retrospective
- **Assumption corrected:** "requester reputation" was assumed to exist; research showed reputation
  is per-skill only. The gate's hard part is *defining* an agent metric, not adding a struct field —
  verify the data model backs a feature's nouns before scoping it.
- **Constraint surfaced:** the contract is immutable and live; any struct change is a redeploy. The
  honest split is app-layer-now / on-chain-next-redeploy, not "medium effort in-place edit".
- **Debt knowingly created:** threshold durability is process-lifetime only (PD-005) — acceptable for
  an advisory preview, closed by Phase 2's on-chain field.
- **Signal for next cycle:** when a redeploy is scheduled for PD-003, pull Phase 2 in with it.
