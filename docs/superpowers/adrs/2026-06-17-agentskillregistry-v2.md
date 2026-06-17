# ADR: AgentSkillRegistry v2 — escrow dispute resolution, O(1) dedup, on-chain trust gate

## 1. Title
Bundle Claim 3 (escrow deadlock fix), PD-003 (O(1) dedup), and PD-005 (on-chain trust gate) into one
`AgentSkillRegistry` v2, implemented + Foundry/TS-tested now; live redeploy stays operator-gated.

## 2. Context
The 2026-06-17 STRIDE audit's Claim 3 (TRUE): once a job is `Delivered`, `claimRefund` (requires
`status==Open`) is closed and the only exit is `confirmCompletion` — a requester who ghosts after
delivery locks the escrow forever; the contract header's "no permanent fund lock" was false. The
contract is deployed + immutable, and KB policy (PD-003, PD-005) mandates batching all contract
changes into a single redeploy. User decision (2026-06-17): "gom trọn v2 luôn" — implement the full
v2 (escrow + dedup + on-chain gate) and its TS lockstep this cycle; defer only the live
redeploy/migration. audit-design (Tier 3) flagged: deadline-overload vs the refund path, ABI/tuple
drift, migration ordering, self-deal farming on both completion paths, and app-gate↔chain-gate
divergence.

## 3. Decision
**Contract (`AgentSkillRegistry.sol`):**
- **Claim 3 (neutral resolution):** `deliverResult` opens a `REVIEW_WINDOW` (3 days) by repurposing
  `Job.deadline`. `confirmCompletion` (requester→provider) allowed any time while `Delivered`.
  `disputeResult` (requester, `now <= deadline`) → `Disputed` + refund. `claimAfterReview` (provider,
  `now > deadline`) → auto-settle to provider. No permanent lock; `claimRefund` unchanged (its
  `status==Open` guard precedes the deadline read, so the overload is safe — FM1).
- **PD-003:** `mapping(bytes32 => uint256) jobByTaskHash` set in `createJob`; O(1) dedup.
- **PD-005:** `mapping(address => uint256) _agentRep` + `agentReputation()` (lazy base-50, rises only);
  `Skill.minReputationToInvoke` + `setMinReputation` (owner-only); `createJob` requires
  `agentReputation(msg.sender) >= s.minReputationToInvoke`. Both completion paths share
  `_settleCompletion`, which bumps agent rep for **both** parties only when `requester != provider`
  (self-deal guard — Abductive-2).

**TS lockstep:** `abi.ts` synced (drift-guard green); `karma_service` decodes the new `skills` field,
adds dispute/claim/setMinReputation/getAgentReputation, and switches `findExistingJob` to O(1)
`jobByTaskHash`; `karma.tool` sends the threshold on-chain at `register_skill`, runs the `create_job`
gate against on-chain values (authoritative; simulate also reverts), exposes `get_agent_reputation`
from on-chain rep, and adds `dispute_result` + `claim_after_review` tools (tenant-threaded per
Workstream A).

## 4. Status
ACCEPTED (code + tests). Live activation PENDING operator redeploy + migration (spec §5 runbook).

## 5. Consequences
**Improved:** no permanent escrow lock (Claim 3 closed); a ghosting requester no longer traps a
provider, and a junk delivery no longer traps a requester; dedup is O(1); the Trust Gate is now
consensus-enforced (a direct `createJob` caller can no longer bypass it) and restart-durable for
enforcement (reads on-chain, not the in-process index).
**Worsened / debt:** the neutral model still lets a malicious requester `disputeResult` good work to
refund (griefs provider) — accepted trade-off, bounded by no rep reward + the review window, not by
an arbiter (no oracle/stake — PD-005 residual). Reputation remains wash-tradeable on a free testnet
even with the self-deal guard. The redeploy + skill migration is a real ops step (FM3) that is NOT
executed here. The index `min_reputation_to_invoke` is now display-only (discover hints); its
restart durability is a minor cosmetic gap, not an enforcement gap.

## 6. Alternatives Considered
- **Protect-provider only (auto-accept after timeout)** — rejected: junk delivery would get paid;
  no requester lever.
- **Protect-requester only (refund-after-grace, audit ADR-2)** — rejected: lets a requester wait out
  and refund good work; the neutral model gives both sides a bounded lever.
- **New `deliveredAt` field instead of reusing `deadline`** — rejected: an extra storage slot for no
  behavioral gain; `claimRefund`'s status guard makes the reuse safe and gas-cheaper.
- **Keep the app-layer (index) gate authoritative** — rejected: it is bypassable and non-durable;
  the whole point of v2 is consensus enforcement. App gate demoted to a preflight over on-chain reads.
- **Standalone redeploy for Claim 3 only** — rejected: KB policy bundles contract changes into one
  migration (PD-003 + PD-005) to avoid repeated re-registration/re-index.

## 7. Evidence
- `forge build` clean; `forge test` → **18 passed / 0 failed** incl. ghost-requester claim, junk-result
  dispute, dispute-after-window revert, claim-at-exact-window revert, late-confirm, open-refund intact
  (FM1), gate block/allow/bootstrap, setMinReputation owner-only, self-deal-no-farm (both paths),
  jobByTaskHash dedup, reentrancy. [verified 2026-06-17]
- `pnpm test` (vitest) → **369 passed / 1 skipped / 0 failed, 53 files** incl. the ABI drift-guard
  (abi.ts ↔ rebuilt artifact) and the updated v2 gate/tool tests. [verified 2026-06-17]
- `pnpm typecheck` clean; `pnpm eslint "src/**/*.ts"` clean. [verified 2026-06-17]
- Live redeploy/migration NOT executed (operator-gated). [ASSUMED — verify post-deploy]
- [G.CDOC 2026-06-17] Spot-checked vs code: `claimRefund` keeps `status==Open` (sol:234) BEFORE the
  deadline read (sol:235) → FM1 safe; both completion paths call `_settleCompletion` (sol:185,195)
  whose self-deal guard is `requester != j.provider` (sol:222); `createJob` gate require (sol:146);
  `deliverResult` sets the review window (sol:175); service `findExistingJob` reads `jobByTaskHash`
  (karma_service:172); plugin gate reads `skill.minReputationToInvoke` + `getAgentReputation`
  (karma.tool:314,316). All VERIFIED.

## 8. Owner
**KARMA team — gokuderafight@gmail.com**

## 8b. Known Debts (PATTERN-DEBT)
  - PD-003: RESOLVED IN CODE (v2) — pending operator redeploy to take effect on-chain.
  - PD-005: RESOLVED IN CODE (v2) for enforcement — residual: wash-trade resistance needs stake/
    identity (out of scope); index threshold now display-only (restart-durability is cosmetic).
  - PD-006 (Workstream A): OPEN — tenant-mismatch telemetry alarm.
  - PD-002 / PD-004: OPEN — network read/write integration coverage; indexer checkpoint. The v2
    decode-path change (skills tuple) is the PD-002 trigger — a forked-anvil integration test for the
    register→create→deliver→dispute/claim→withdraw loop should accompany the redeploy.

## 9. Next Cycle Trigger
Execute the **redeploy + migration runbook** (spec §5) when the operator schedules the next
`AgentSkillRegistry` deployment — whichever fires first: a delivered-job escrow is reported
permanently locked on the live v1 contract, OR `jobCount() > 1000` / a requester owns > 100 jobs
(PD-003), OR a multi-tenant customer onboards needing consensus-level enforcement. At redeploy: add
the PD-002 forked-anvil integration test and demote the index threshold to a pure cache of the
on-chain value.

## 10. Cycle Retrospective
- Escrow without an arbiter cannot tell "junk delivery" from "requester ghosting to avoid payment" —
  every pure-timeout rule favors one side. The neutral dispute+auto-claim is the honest no-oracle
  compromise; document the residual requester-griefs-provider trade-off rather than pretend it's solved.
- Reusing `Job.deadline` for the review window is safe ONLY because `claimRefund` checks
  `status==Open` before reading `deadline` — a future reader must not add a deadline read on a
  non-Open path. Covered by `test_OpenRefund_StillWorks` + the dispute/claim boundary tests.
- `agentReputation`'s `0 ⇒ BASE` sentinel is correct ONLY while reputation never decreases; a decay
  feature would silently reset everyone to BASE. Invariant is commented in the contract.
- The ABI drift-guard auto-compares abi.ts to the rebuilt artifact by shape — it caught the missing
  `REVIEW_WINDOW()` public-constant getter immediately. Always `forge build` before the drift test.
- Self-deal farming would have shipped if the `requester != provider` guard lived only in
  `confirmCompletion`; routing both completion paths through `_settleCompletion` makes the guard
  un-forgettable. Apply shared effects in one private function when two entrypoints must agree.
</content>
