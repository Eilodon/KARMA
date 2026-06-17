---
title: AgentSkillRegistry v2 — escrow dispute resolution, O(1) dedup, on-chain trust gate
date: 2026-06-17
author: KARMA team — gokuderafight@gmail.com
SPEC_APPROVED: true
SPEC_ESCALATION: false
ESCALATION_FINDING: ""
status: APPROVED — implement Solidity + Foundry + TS lockstep now; live redeploy remains operator-gated
related:
  - "Workstream A: 2026-06-17-app-layer-stride-hardening-design.md"
  - "PD-003 (O(1) dedup), PD-005 (on-chain trust gate)"
  - "plan 2026-06-16-trust-gate-min-reputation (Phase 2 design)"
  - "audit: STRIDE Security Architecture (2026-06-17) — Claim 3"
---

# AgentSkillRegistry v2 (Workstream B)

> **Why one bundle.** The deployed `AgentSkillRegistry` is immutable (no proxy). Every change here
> is a storage-layout change → one redeploy + skill migration + re-index. KB policy (PD-003, PD-005,
> trust-gate plan) mandates batching all contract changes into a single v2 redeploy to avoid
> repeated migrations. User decision (2026-06-17): "gom trọn v2 luôn."
>
> **Execution gating.** Solidity + Foundry tests are written and must pass *now*. The live
> **redeploy + migration is a separate, operator-gated ops step** (needs keystore password, deploy
> script, `PHAROS_CONTRACT_ADDRESS` repoint, re-index from the new deploy block). Not auto-run.

## 1. B1 — Escrow dispute resolution (Claim 3) — neutral model

**Problem.** `claimRefund` requires `status == Open` (sol:164). `deliverResult` moves Open→Delivered
(sol:133). Once Delivered, the only exit is `confirmCompletion` (requester pays). A requester who
ghosts after delivery locks the escrow forever; a provider who delivers junk leaves the requester
with no refund path. The `Disputed` enum is never set. The contract header's "no permanent fund
lock" (sol:7–8) is false for the Delivered path. Existing test `test_Refund_AfterDelivered_Reverts`
currently **codifies the deadlock as intended** — it must be rewritten.

**Design (neutral: requester dispute window + provider auto-claim).** No new struct field — repurpose
`Job.deadline`:
- `deliverResult`: on delivery set `j.deadline = block.timestamp + REVIEW_WINDOW` (new constant,
  e.g. 3 days). Original `deadline` (refund-if-never-delivered) is moot once delivered.
- `confirmCompletion`: unchanged (requester → provider), allowed any time while Delivered.
- `disputeResult(jobId)` **(new)**: requester only; `status == Delivered && block.timestamp <=
  j.deadline`; sets `status = Disputed`, refunds requester via `pendingWithdrawals[requester] +=
  escrow`; emits `ResultDisputed`. This is the requester's lever against junk delivery.
- `claimAfterReview(jobId)` **(new)**: provider only; `status == Delivered && block.timestamp >
  j.deadline`; sets `status = Completed`, pays provider, bumps reputation (same effects as
  `confirmCompletion`); emits `JobCompleted`. This is the auto-accept that kills the
  ghosting-requester deadlock.

**Accepted trade-off (user-chosen).** A malicious requester can `disputeResult` good work to refund
(griefs provider). Mitigated by reputation damage (B3 only bumps on non-disputed completion) and the
review window bound, not by an on-chain arbiter (out of scope without an oracle/stake). Documented.

**Foundry tests.** ghost-requester → provider `claimAfterReview` succeeds after window; junk delivery
→ requester `disputeResult` refunds within window; dispute after window reverts; claim before window
reverts; rewrite `test_Refund_AfterDelivered_Reverts` to assert the new dispute/claim paths.

## 2. B2 — O(1) dedup (PD-003)

**Problem.** `findJobByTaskHash` scans `getRequesterJobs` and reads each job's taskHash — O(n) per
create_job (contract.ts:134). `deriveTaskHash = keccak256(requester, skillId, nonce)` is already
globally unique per requester.

**Design.** Add `mapping(bytes32 => uint256) public jobByTaskHash`. In `createJob`, after assigning
`jobId`, set `jobByTaskHash[taskHash] = jobId` (taskHash already binds the requester, so no
cross-requester collision). App `findExistingJob` becomes an O(1) `jobByTaskHash(taskHash)` read
(0 = none). Keep the field `public` (auto-getter) — no extra view needed.

## 3. B3 — On-chain trust gate (PD-005 Phase 2)

**Problem.** The Trust Gate is app-layer advisory only (karma.tool.ts:275–291): a direct `createJob`
caller bypasses it, and the threshold lives only in the in-process index (lost on restart).

**Design.**
- `mapping(address => uint256) private _agentRep` + view `agentReputation(addr) = _agentRep[addr]
  == 0 ? BASE_REPUTATION : _agentRep[addr]` (lazy-init 50; reputation only rises here, so 0 ==
  unset is safe). Internal `_bumpRep(addr)` lazy-inits to BASE then `+= REPUTATION_STEP` capped at
  MAX.
- `Skill` gains `uint256 minReputationToInvoke` (layout change OK in v2; place adjacent to `bool
  active`). Set via extended `registerSkill(..., minReputationToInvoke)` + owner-only
  `setMinReputation(skillId, v)`.
- `createJob`: `require(agentReputation(msg.sender) >= s.minReputationToInvoke, "insufficient
  reputation")` — consensus-enforced; the app preflight (simulate) surfaces the revert pre-broadcast.
- `confirmCompletion` and `claimAfterReview`: bump `agentReputation` for **both** provider and
  requester **only when `requester != provider`** (blunts self-deal farming; also fixes the existing
  skill-rep self-farm hole since we redeploy anyway). `disputeResult` bumps neither.

**Foundry tests.** under-rep requester `createJob` reverts; at/above passes; bootstrap (fresh agent
at BASE 50); self-deal (requester==provider) earns no rep; `setMinReputation` owner-only.

## 4. B4 — App lockstep (TypeScript)

- `src/lib/abi.ts`: extend for `registerSkill(+minReputationToInvoke)`, `skills` tuple
  (+`minReputationToInvoke`), `disputeResult`, `claimAfterReview`, `setMinReputation`,
  `agentReputation`, `jobByTaskHash`; new events `ResultDisputed`. `Job`/`jobs()` tuple unchanged
  (deadline reused).
- ABI **drift-guard** test: update `.sol`↔`abi.ts` shape expectations.
- `src/lib/karma_service.ts`: decode `skills` new field; add `disputeResult`, `claimAfterReview`,
  `setMinReputation`, `getAgentReputation` (read), `getJobByTaskHash`; `findExistingJob` → O(1).
- `src/lib/contract.ts`: `makeOnchainJobReader` no longer needs the O(n) scan; `findJobByTaskHash`
  helper simplified/removed.
- `src/plugins/karma.tool.ts`: `register_skill` sends `minReputationToInvoke` on-chain; keep the
  app-layer gate as a fast preflight; new tools `dispute_result` (requester) and
  `claim_after_review` (provider); `STATUS_MAP`/social-graph already handle `Disputed`.
- `src/lib/types.ts`: `SkillDocument.min_reputation_to_invoke` becomes on-chain-backed (index
  demoted to a cache of the on-chain value, per plan).
- `src/lib/bm25_index.ts`: `getThreshold`/`getReputation` demoted to cache of on-chain values.

## 5. Migration runbook (operator-gated, documented not executed)
1. `forge test` green for v2.
2. Deploy v2 (`deploy_contract.ts`), capture new address.
3. Re-register every active skill on v2 (migration script) — escrowed in-flight jobs on v1 settle on
   v1 (run both readers until drained) — **document the cutover**.
4. Repoint `PHAROS_CONTRACT_ADDRESS`; set `KARMA_INDEXER_FROM_BLOCK` = v2 deploy block; re-index.
5. Demote app-layer threshold to on-chain cache; verify `agentReputation` reads.

## 6. Testing strategy
- `forge test` (Foundry) for B1–B3; vitest for B4 decode/tool/drift-guard; full `pnpm test`.

## 7. Risk notes
- Reputation remains wash-tradeable on a free testnet even with the `requester != provider` guard —
  on-chain enforcement is honest only up to Sybil cost; true resistance needs stake/identity (out of
  scope; recorded in PD-005).
- Repurposing `deadline` for the review window is a semantic overload — must be covered by an
  explicit comment + tests so a future reader doesn't treat it as the original create deadline.

## Risk Assessment (audit-design)
<!-- audit-design: DO NOT DUPLICATE — update this section, do not append a second one -->
<!-- last-run: 2026-06-17 | trigger: NORMAL -->

**Tier:** 3 (on-chain escrow / payments + multi-tenant + immutable-contract migration) | **Date:** 2026-06-17

### Failure Modes
1. **`deadline` field overload corrupts the refund path** — `claimRefund` still reads `j.deadline`
   for the Open-state "provider never delivered" refund, but `deliverResult` now OVERWRITES
   `j.deadline = now + REVIEW_WINDOW`. If any ordering/guard is wrong, a job could become refundable
   on the wrong clock, or the Open refund and the Delivered review windows could interfere. —
   **HIGH** — mitigation in plan: YES
2. **Storage-layout / ABI drift between contract v2 and the TS lockstep** — adding
   `minReputationToInvoke` to the `Skill` struct reshapes the `skills()` tuple; `karma_service.ts`
   decodes tuples positionally (`t[5]`, `t[7]`…). A wrong index silently mis-maps reputation/active/
   threshold with no compile error. The ABI drift-guard must catch shape drift, and decode tests must
   pin positions. — **HIGH** — mitigation in plan: YES
3. **Migration leaves in-flight v1 jobs unsettleable or double-counts reputation** — redeploy points
   `PHAROS_CONTRACT_ADDRESS` at v2 with empty state; escrow locked in v1 Open/Delivered jobs is
   invisible to v2. If the indexer re-points before v1 jobs drain, funds appear lost and reputation
   re-bootstraps. — **HIGH (ops)** — mitigation in plan: YES (runbook: dual-read until drained)

### Layer Signals
- **L1 Logic:** new state transitions must each be guarded: `disputeResult` only `Delivered &&
  now <= deadline`; `claimAfterReview` only `Delivered && now > deadline`; `confirmCompletion` any
  time while `Delivered`. The boundary (`now == deadline`) must be tested (mirror existing
  `test_Refund_AtExactDeadline_Reverts`).
- **L2 Concurrency:** `nonReentrant` already guards withdraw; `disputeResult`/`claimAfterReview` only
  credit `pendingWithdrawals` (no external call) so they need no reentrancy guard, but confirm they
  never `.call` value directly.
- **L3 Data:** `agentReputation` lazy-init via `_agentRep[a]==0 ? BASE : _agentRep[a]` is correct
  ONLY because reputation never drops below BASE; a future decay feature would break the sentinel.
  Document the invariant. `minReputationToInvoke` default 0 = no gate (back-compat with v1 semantics).
- **L5 Security:** `setMinReputation` owner-only (mirror `deactivateSkill`'s `s.owner == msg.sender`).
  `createJob` gate must read `agentReputation(msg.sender)` (the lazy getter), NOT the raw mapping
  (raw is 0 for a fresh agent → would block everyone at any threshold > 0).
- **L6 Observability:** new events `ResultDisputed` (+ reuse `JobRefunded`/`JobCompleted`) so the
  indexer and social graph can show dispute/auto-claim outcomes; without them the off-chain view
  silently diverges.
- **L7 Cross-cutting (L7.11 = YES):** real escrow value + multi-tenant. The app-layer Trust Gate
  (Phase 1) must stay as a pre-broadcast fast-fail and be reconciled with the now-authoritative
  on-chain gate (simulate already reverts pre-broadcast — surface it cleanly, don't double-charge).

### Assumptions to Verify
- **ASSUMED:** `confirmCompletion` is still allowed for the requester at ANY time while `Delivered`
  (even after `deadline`), so a good-faith requester is never forced into the auto-claim path. Verify
  no `now <= deadline` guard is accidentally added to `confirmCompletion`.
- **ASSUMED:** repurposing `deadline` does not break `claimRefund` — because once `status !=
  Open`, `claimRefund` reverts on the status check BEFORE reading `deadline`. Verify the status guard
  precedes the deadline read (it does in v1: `require(status==Open)` then `require(now>deadline)`).
- **ASSUMED:** Multicall3 still OFF (CONTEXT.md / contract.ts) — v2 adds no multicall dependency.

### Abductive Hypotheses
- **Abductive 1 (interaction):** The app-layer Phase-1 Trust Gate reads index-derived reputation
  (max owned-skill rep) while the on-chain gate reads `agentReputation` (base-50 earned-on-completion).
  These two metrics DISAGREE — a requester the app allows could be reverted on-chain (or vice-versa),
  producing a confusing "app says ok, chain says no" or a wasted simulate. Plan must reconcile:
  demote the app gate to advisory/preflight and treat the on-chain revert as authoritative.
- **Abductive 2 (adversarial):** A provider who is ALSO the requester (self-job) could farm via
  `claimAfterReview` to bump `agentReputation` if the `requester != provider` guard is only applied
  in `confirmCompletion` and forgotten in `claimAfterReview`. Both completion paths must apply the
  self-deal guard identically. — **HIGH**

### Gate Result
<!-- PASS | PASS WITH FLAGS | HOLD -->
**PASS WITH FLAGS** — proceed to writing-plans. The plan MUST include:
- **(FM1/HIGH)** keep `claimRefund`'s `require(status==Open)` BEFORE the deadline read; Foundry tests
  for: Open-refund still works post-change, and a Delivered job is never refundable via `claimRefund`.
- **(FM2/HIGH)** update the ABI drift-guard for the new `skills()` tuple + functions/events; add a
  decode test pinning each `skills()` tuple index incl. the new `minReputationToInvoke`.
- **(FM3/HIGH-ops)** migration runbook: dual-read v1+v2 until v1 jobs drain before re-pointing the
  indexer; redeploy/migration stays operator-gated (not run in this cycle).
- **(Abductive-1)** reconcile the app Phase-1 gate with the on-chain gate (app = advisory preflight;
  chain = authoritative); a Foundry + a TS test that the two agree on the bootstrap case.
- **(Abductive-2/HIGH)** apply the `requester != provider` reputation guard in BOTH
  `confirmCompletion` AND `claimAfterReview`; Foundry self-deal no-farm test on both paths.
- **(L1)** boundary test at `now == deadline` for both `disputeResult` and `claimAfterReview`.
</content>
