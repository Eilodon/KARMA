# AgentSkillRegistry v2 — Implementation Plan (Workstream B)

> Execute with `executing-plans`. Foundry-first (contract + `forge test`), then TS lockstep
> (`pnpm test`). Live redeploy + migration is operator-gated — NOT run by this plan.

**Goal:** One contract redeploy bundling Claim 3 (escrow dispute/auto-claim, no permanent lock),
PD-003 (O(1) dedup), PD-005 (on-chain trust gate), with the TS layer in lockstep.
**Architecture:** v2 reuses `Job.deadline` as the post-delivery review window; adds `jobByTaskHash`,
`agentReputation` (lazy base-50), `Skill.minReputationToInvoke` + `setMinReputation`. The app gate is
demoted to an on-chain-sourced preflight; `simulate()` revert is authoritative.
**Audit Gate:** PASS WITH FLAGS (Tier 3). **Risk Flags:** FM1 deadline-overload, FM2 ABI drift, FM3
migration, Abductive-2 self-deal — all HIGH, mitigations below.

## File map
| File | Change |
|---|---|
| `contracts/AgentSkillRegistry.sol` | v2: REVIEW_WINDOW, jobByTaskHash, agentReputation, Skill.minReputationToInvoke, disputeResult, claimAfterReview, setMinReputation, gate in createJob, self-deal-guarded rep bump |
| `test/AgentSkillRegistry.t.sol` | rewrite deadlock test; add dispute/claim/gate/self-deal/dedup/boundary tests |
| `src/lib/abi.ts` | sync to v2 surface (rebuilt artifact) |
| `src/lib/karma_service.ts` | decode skills+minRep; disputeResult/claimAfterReview/setMinReputation; getAgentReputation; O(1) findExistingJob via jobByTaskHash |
| `src/lib/contract.ts` | jobByTaskHash reader; simplify findJobByTaskHash |
| `src/lib/types.ts` | OnchainSkill.minReputationToInvoke |
| `src/plugins/karma.tool.ts` | register_skill on-chain threshold; create_job on-chain preflight; dispute_result + claim_after_review tools |
| Tests (vitest) | karma_tools + bm25 reconciliation |

---

## Task B1 — Contract v2 (Solidity)

**Files:** Modify `contracts/AgentSkillRegistry.sol`

- [ ] **Step 1 — Skill struct + constants + state.** Add to `Skill` struct (append, index 9):
```solidity
uint256 minReputationToInvoke; // Trust Gate (on-chain): 0 = open
```
Add constant + state:
```solidity
uint256 public constant REVIEW_WINDOW = 3 days;
mapping(bytes32 => uint256) public jobByTaskHash;      // PD-003: O(1) dedup (taskHash already binds requester)
mapping(address => uint256) private _agentRep;          // PD-005: 0 = unset ⇒ BASE (rep only rises)
```
Add events:
```solidity
event ResultDisputed(uint256 indexed jobId, address indexed requester, uint256 amount);
event MinReputationSet(uint256 indexed skillId, uint256 minReputation);
```

- [ ] **Step 2 — agentReputation getter + internal bump.**
```solidity
/// @notice Earned reputation, lazy-initialized to BASE_REPUTATION (rep only ever rises).
function agentReputation(address agent) public view returns (uint256) {
    uint256 r = _agentRep[agent];
    return r == 0 ? BASE_REPUTATION : r;
}

function _bumpAgentRep(address agent) private {
    uint256 cur = agentReputation(agent);
    uint256 next = cur + REPUTATION_STEP;
    _agentRep[agent] = next > MAX_REPUTATION ? MAX_REPUTATION : next;
}
```

- [ ] **Step 3 — registerSkill(+minReputationToInvoke) + setMinReputation.** Extend signature:
```solidity
function registerSkill(
    string calldata name,
    string calldata description,
    string calldata mcpEndpoint,
    uint256 pricePerCall,
    uint256 minReputationToInvoke
) external returns (uint256 skillId) {
    require(bytes(name).length > 0, "name required");
    require(minReputationToInvoke <= MAX_REPUTATION, "bad threshold");
    skillId = ++_skillIdCounter;
    skills[skillId] = Skill({
        owner: msg.sender, name: name, description: description, mcpEndpoint: mcpEndpoint,
        pricePerCall: pricePerCall, reputationScore: BASE_REPUTATION, totalInvocations: 0,
        active: true, registeredAt: block.timestamp, minReputationToInvoke: minReputationToInvoke
    });
    agentSkills[msg.sender].push(skillId);
    emit SkillRegistered(skillId, msg.sender, name, pricePerCall);
}

function setMinReputation(uint256 skillId, uint256 minReputation) external {
    Skill storage s = skills[skillId];
    require(s.owner == msg.sender, "not skill owner");
    require(minReputation <= MAX_REPUTATION, "bad threshold");
    s.minReputationToInvoke = minReputation;
    emit MinReputationSet(skillId, minReputation);
}
```

- [ ] **Step 4 — createJob gate + dedup index.** After the existing requires, before `jobId = ...`:
```solidity
require(agentReputation(msg.sender) >= s.minReputationToInvoke, "insufficient reputation");
```
After `agentProviderJobs[s.owner].push(jobId);` add:
```solidity
jobByTaskHash[taskHash] = jobId; // PD-003 O(1) dedup
```

- [ ] **Step 5 — deliverResult opens the review window.** Replace its body's effect:
```solidity
function deliverResult(uint256 jobId, bytes32 resultHash) external {
    Job storage j = jobs[jobId];
    require(j.provider == msg.sender, "not provider");
    require(j.status == JobStatus.Open, "job not open");
    j.status = JobStatus.Delivered;
    j.resultHash = resultHash;
    j.deadline = block.timestamp + REVIEW_WINDOW; // FM1: repurpose deadline as the review-by time
    emit ResultDelivered(jobId, resultHash);
}
```

- [ ] **Step 6 — confirmCompletion: self-deal-guarded dual rep bump (any time while Delivered).**
```solidity
function confirmCompletion(uint256 jobId) external nonReentrant {
    Job storage j = jobs[jobId];
    require(j.requester == msg.sender, "not requester");
    require(j.status == JobStatus.Delivered, "job not delivered");
    _settleCompletion(j, jobId);
}

function _settleCompletion(Job storage j, uint256 jobId) private {
    j.status = JobStatus.Completed;
    j.completedAt = block.timestamp;
    pendingWithdrawals[j.provider] += j.escrowAmount;

    Skill storage s = skills[j.skillId];
    s.totalInvocations += 1;
    uint256 rep = s.reputationScore + REPUTATION_STEP;
    s.reputationScore = rep > MAX_REPUTATION ? MAX_REPUTATION : rep;

    // Abductive-2: only credit agent reputation for arm's-length jobs (blunts self-deal farming).
    if (j.requester != j.provider) {
        _bumpAgentRep(j.provider);
        _bumpAgentRep(j.requester);
    }
    emit JobCompleted(jobId, j.provider, j.escrowAmount, s.reputationScore);
}
```

- [ ] **Step 7 — claimAfterReview (provider, after window) + disputeResult (requester, within window).**
```solidity
/// @notice Provider claims payment if the requester neither confirmed nor disputed before the window closed.
function claimAfterReview(uint256 jobId) external nonReentrant {
    Job storage j = jobs[jobId];
    require(j.provider == msg.sender, "not provider");
    require(j.status == JobStatus.Delivered, "job not delivered");
    require(block.timestamp > j.deadline, "review window open");
    _settleCompletion(j, jobId); // self-deal guard applies identically (Abductive-2)
}

/// @notice Requester rejects a delivered result within the review window and reclaims escrow.
function disputeResult(uint256 jobId) external nonReentrant {
    Job storage j = jobs[jobId];
    require(j.requester == msg.sender, "not requester");
    require(j.status == JobStatus.Delivered, "job not delivered");
    require(block.timestamp <= j.deadline, "review window closed");
    j.status = JobStatus.Disputed;
    pendingWithdrawals[msg.sender] += j.escrowAmount; // no agent-rep change on dispute
    emit ResultDisputed(jobId, msg.sender, j.escrowAmount);
}
```
`claimRefund` is UNCHANGED — its `require(status==Open)` precedes the deadline read (FM1 safe).

- [ ] **Step 8 — `forge build`** → `~/.foundry/bin/forge build` → expected: compiles clean.

## Task B2 — Foundry tests

**Files:** Modify `test/AgentSkillRegistry.t.sol`

- [ ] **Step 1 — update helpers for the new registerSkill arity + add a self-job helper.**
`_registerSkill()` → `reg.registerSkill("search","...","mcp://alpha", PRICE, 0)`. Add
`_registerSkillGated(uint256 minRep)`.
- [ ] **Step 2 — rewrite `test_Refund_AfterDelivered_Reverts`** to assert the new resolution:
```solidity
function test_Delivered_GhostRequester_ProviderClaimsAfterWindow() public {
    uint256 skillId = _registerSkill();
    uint256 jobId = _openJob(skillId);
    vm.prank(alpha); reg.deliverResult(jobId, RESULT_HASH);
    vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 1);
    vm.prank(alpha); reg.claimAfterReview(jobId);
    uint256 bal = alpha.balance; vm.prank(alpha); reg.withdraw();
    assertEq(alpha.balance, bal + PRICE, "provider paid after review window");
}
function test_Delivered_JunkResult_RequesterDisputesWithinWindow() public {
    uint256 skillId = _registerSkill();
    uint256 jobId = _openJob(skillId);
    vm.prank(alpha); reg.deliverResult(jobId, RESULT_HASH);
    vm.prank(beta); reg.disputeResult(jobId);
    uint256 bal = beta.balance; vm.prank(beta); reg.withdraw();
    assertEq(beta.balance, bal + PRICE, "requester refunded on dispute");
}
```
- [ ] **Step 3 — boundary + guard tests:**
  - `test_Dispute_AfterWindow_Reverts` (warp past deadline → `disputeResult` reverts "review window closed").
  - `test_Claim_BeforeWindow_Reverts` (`claimAfterReview` at `deadline` exactly → "review window open").
  - `test_ConfirmCompletion_StillWorksAfterWindow` (requester confirms even after deadline).
  - `test_OpenRefund_StillWorks` (the original Open-state refund path is intact — FM1).
- [ ] **Step 4 — trust-gate tests:**
  - `test_Gate_BlocksUnderRepRequester`: skill with `minRep=55`; fresh requester (rep 50) → `createJob` reverts "insufficient reputation".
  - `test_Gate_AllowsAtOrAboveRep`: requester earns rep to ≥55 (complete an arm's-length job), then createJob passes.
  - `test_Gate_BootstrapBase50`: fresh agent reads `agentReputation == 50`.
  - `test_SetMinReputation_OwnerOnly` (non-owner reverts "not skill owner").
- [ ] **Step 5 — self-deal + dedup tests:**
  - `test_SelfDeal_NoRepFarm`: requester==provider completes a job → `agentReputation` stays 50 (both confirm and claimAfterReview paths).
  - `test_JobByTaskHash_DedupIndex`: after createJob, `jobByTaskHash(TASK_HASH) == jobId`.
- [ ] **Step 6 — run** `~/.foundry/bin/forge test` → expected: ALL pass.
- [ ] **Step 7 — commit** `git commit -am "feat(contract): AgentSkillRegistry v2 escrow dispute + on-chain gate + O(1) dedup [B / Foundry green]"`

## Task B3 — ABI sync + TS decode

**Files:** `src/lib/abi.ts`, `src/lib/types.ts`, `src/lib/karma_service.ts`, `src/lib/contract.ts`

- [ ] **Step 1 — abi.ts:** add `minReputationToInvoke` (uint256) to the `skills` outputs (LAST, index 9);
add `registerSkill` 5th input `minReputationToInvoke uint256`; add functions `disputeResult(uint256)`,
`claimAfterReview(uint256)`, `setMinReputation(uint256,uint256)`, `agentReputation(address)->uint256`,
`jobByTaskHash(bytes32)->uint256`; add events `ResultDisputed`, `MinReputationSet`.
- [ ] **Step 2 — types.ts:** `OnchainSkill.minReputationToInvoke: bigint`.
- [ ] **Step 3 — karma_service.ts:** decode `skills` `t[9]` → `minReputationToInvoke`; add methods
`disputeResult`, `claimAfterReview`, `setMinReputation`, `getAgentReputation(addr): Promise<number>`
(read `agentReputation`, `Number(...)`), and switch `findExistingJob` to read `jobByTaskHash(taskHash)`
(0 ⇒ null) for O(1).
- [ ] **Step 4 — contract.ts:** add `jobByTaskHash` to `makeOnchainJobReader` (or a new reader);
keep `findJobByTaskHash` only as a fallback or remove if unused.
- [ ] **Step 5 — drift guard:** `~/.foundry/bin/forge build` then
`pnpm vitest run src/__tests__/karma_contract.test.ts` → expected: PASS (abi matches artifact).
- [ ] **Step 6 — commit** `git commit -am "feat(karma): v2 ABI + service decode (minRep, dispute, claim, agentReputation, O(1) dedup) [B]"`

## Task B4 — Plugin tools + gate reconciliation

**Files:** `src/plugins/karma.tool.ts`, tests

- [ ] **Step 1 — register_skill:** pass `minReputationToInvoke` to `svc.registerSkill` (on-chain now);
keep the `indexUpsert` with the same value (display cache).
- [ ] **Step 2 — create_job preflight (Abductive-1 reconciliation):** replace the index-derived gate
with on-chain values already at hand — `skill.minReputationToInvoke` (from `readSkill`) and
`svc.getAgentReputation(requester)` — returning the SAME `status:"rejected"` envelope before escrow.
The on-chain `require` is authoritative (simulate reverts pre-broadcast); the preflight only saves a
wasted tx. Drop the `getSkillThreshold`/index path from create_job.
- [ ] **Step 3 — new tools `dispute_result` (requester) + `claim_after_review` (provider):** mirror
`complete_job`'s shape (agentId + jobId, tenant-threaded `svc.account(agentId, tenantId)`,
`writeAnnotations`). Add both to the returned tool array.
- [ ] **Step 4 — tests (karma_tools.test.ts):** fake `getAgentReputation`; gate blocks/allows via
on-chain values; `dispute_result`/`claim_after_review` call the service + stringify; tenant-threaded.
- [ ] **Step 5 — run** `pnpm test` + `pnpm typecheck` + `pnpm lint` → green.
- [ ] **Step 6 — commit** `git commit -am "feat(karma): on-chain trust-gate preflight + dispute/claim tools [B]"`

## Final verification
- [ ] `~/.foundry/bin/forge test` → all pass
- [ ] `pnpm typecheck` clean · `pnpm lint` clean · `pnpm test` green (incl. drift guard)
- [ ] Migration runbook (spec §5) reviewed; redeploy NOT executed (operator-gated)

## Self-review — spec coverage
- B1 escrow (Claim 3) ✓ · B2/B3 PD-003 dedup ✓ · B2/B3/B4 PD-005 gate ✓ · lockstep ✓.
- FM1 deadline-overload: claimRefund unchanged + `test_OpenRefund_StillWorks` ✓.
- FM2 ABI drift: B3.5 drift guard ✓. FM3 migration: runbook gated ✓.
- Abductive-1 gate reconcile: B4.2 on-chain preflight ✓. Abductive-2 self-deal: `_settleCompletion`
  shared by both completion paths + `test_SelfDeal_NoRepFarm` ✓.

## Task Risk Summary (task-risk-score)
<!-- last-run: 2026-06-17 | formula: (S×B)/D, HIGH ≥ 6 -->
| Task | Context | S×B/D | QBR | Risk | Action |
|---|---|---|---|---|---|
| B1 contract v2 | BUSINESS_LOGIC (on-chain value) | 3×3/3 | 3 | MEDIUM | Foundry covers each transition; review deadline-overload + self-deal guard |
| B2 Foundry tests | BUSINESS_LOGIC | 1×1/3 | 0.3 | LOW | n/a (tests) |
| B3 ABI/decode | INFRASTRUCTURE | 3×2/3 | 2 | LOW | drift-guard + decode index pinned |
| B4 plugin tools | BUSINESS_LOGIC | 2×2/3 | 1.3 | LOW | unit-tested |
**Summary:** no HIGH execution tasks (design-level HIGHs mitigated by Foundry coverage); no CROSS.
Migration is an operator-gated ops step, not an execution task.
</content>
