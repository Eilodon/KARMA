---
title: AgentSkillRegistry v2 — escrow dispute resolution, O(1) dedup, on-chain trust gate
date: 2026-06-17
author: KARMA team — gokuderafight@gmail.com
SPEC_APPROVED: false
SPEC_ESCALATION: false
ESCALATION_FINDING: ""
status: DESIGN-LOCKED · DEFERRED (redeploy-gated) — execute after Workstream A
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
</content>
