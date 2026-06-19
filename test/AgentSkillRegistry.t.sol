// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentSkillRegistry} from "../contracts/AgentSkillRegistry.sol";

contract AgentSkillRegistryTest is Test {
    AgentSkillRegistry internal reg;

    address internal alpha = address(0xA1); // provider (skill owner)
    address internal beta = address(0xB2); // requester
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant DEADLINE_SECS = 1 days;

    bytes32 internal constant TASK_HASH = keccak256("task-params");
    bytes32 internal constant RESULT_HASH = keccak256("result-data");

    // Mirror of the contract event so tests can vm.expectEmit it (Tier-2 bond).
    event BondUpdated(address indexed agent, uint256 bondedAmount, uint256 seedEligible);

    function setUp() public {
        reg = new AgentSkillRegistry(3 days); // DEFAULT_REVIEW_WINDOW
        vm.deal(beta, 10 ether);
        vm.deal(alpha, 10 ether);
    }

    function _registerSkill() internal returns (uint256 skillId) {
        vm.prank(alpha);
        skillId = reg.registerSkill("search", "paid discover_skills", "mcp://alpha", PRICE, 0);
    }

    function _registerSkillGated(uint256 minRep) internal returns (uint256 skillId) {
        vm.prank(alpha);
        skillId = reg.registerSkill("premium", "institutional", "mcp://alpha", PRICE, minRep);
    }

    function _openJob(uint256 skillId) internal returns (uint256 jobId) {
        vm.prank(beta);
        jobId = reg.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);
    }

    // ── Happy path ─────────────────────────────────────────────
    function test_HappyPath_EscrowFlowAndReputation() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);

        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.prank(beta);
        reg.confirmCompletion(jobId);

        uint256 balBefore = alpha.balance;
        vm.prank(alpha);
        reg.withdraw();
        assertEq(alpha.balance, balBefore + PRICE, "provider paid escrow");

        (, , , , , uint256 reputation, uint256 invocations, , , ) = reg.skills(skillId);
        assertEq(reputation, 55, "skill reputation +5 from base 50");
        assertEq(invocations, 1, "one invocation");

        // Arm's-length completion bumps both agents' on-chain reputation (PD-005).
        assertEq(reg.agentReputation(alpha), 55, "provider agent rep +5");
        assertEq(reg.agentReputation(beta), 55, "requester agent rep +5");
    }

    function test_CreateJob_RequiresExactEscrow() public {
        uint256 skillId = _registerSkill();
        vm.prank(beta);
        vm.expectRevert(bytes("escrow must equal price"));
        reg.createJob{value: PRICE - 1}(skillId, TASK_HASH, DEADLINE_SECS);
    }

    // ── Open-state refund (FM1: must remain intact after deadline is repurposed) ──
    function test_Refund_AfterDeadline() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);

        vm.warp(block.timestamp + DEADLINE_SECS + 1);
        vm.prank(beta);
        reg.claimRefund(jobId);

        uint256 balBefore = beta.balance;
        vm.prank(beta);
        reg.withdraw();
        assertEq(beta.balance, balBefore + PRICE, "requester refunded escrow");
    }

    function test_Refund_AtExactDeadline_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        uint256 created = block.timestamp;

        vm.warp(created + DEADLINE_SECS); // == deadline, not strictly after
        vm.prank(beta);
        vm.expectRevert(bytes("before deadline"));
        reg.claimRefund(jobId);
    }

    function test_Refund_AfterDelivered_Reverts() public {
        // Once delivered, claimRefund is closed (status != Open) — resolution moves to dispute/claim.
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + DEADLINE_SECS + 1);
        vm.prank(beta);
        vm.expectRevert(bytes("not refundable"));
        reg.claimRefund(jobId);
    }

    // ── Claim 3: delivered-job resolution (no permanent fund lock) ──
    function test_Delivered_GhostRequester_ProviderClaimsAfterWindow() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 1);
        vm.prank(alpha);
        reg.claimAfterReview(jobId);

        uint256 balBefore = alpha.balance;
        vm.prank(alpha);
        reg.withdraw();
        assertEq(alpha.balance, balBefore + PRICE, "provider paid after review window");
        assertEq(reg.agentReputation(alpha), 55, "claimAfterReview bumps provider rep (arm's-length)");
    }

    function test_Delivered_JunkResult_RequesterDisputesWithinWindow() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.prank(beta);
        reg.disputeResult(jobId);

        uint256 balBefore = beta.balance;
        vm.prank(beta);
        reg.withdraw();
        assertEq(beta.balance, balBefore + PRICE, "requester refunded on dispute");
        assertEq(reg.agentReputation(alpha), 50, "dispute grants no provider rep");
    }

    function test_Dispute_AfterWindow_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 1);
        vm.prank(beta);
        vm.expectRevert(bytes("review window closed"));
        reg.disputeResult(jobId);
    }

    function test_Claim_AtExactWindow_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);
        uint256 delivered = block.timestamp;

        vm.warp(delivered + reg.REVIEW_WINDOW()); // == deadline, not strictly after
        vm.prank(alpha);
        vm.expectRevert(bytes("review window open"));
        reg.claimAfterReview(jobId);
    }

    function test_ConfirmCompletion_StillWorksAfterWindow() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 100);
        vm.prank(beta);
        reg.confirmCompletion(jobId); // requester may always confirm while Delivered
        assertEq(reg.agentReputation(alpha), 55, "late confirm still settles");
    }

    // ── State machine guards ───────────────────────────────────
    function test_DoubleComplete_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);
        vm.prank(beta);
        reg.confirmCompletion(jobId);

        vm.prank(beta);
        vm.expectRevert(bytes("job not delivered"));
        reg.confirmCompletion(jobId);
    }

    // ── On-chain Trust Gate (PD-005) ───────────────────────────
    function test_Gate_BootstrapBase50() public view {
        assertEq(reg.agentReputation(address(0x1234)), 50, "fresh agent bootstraps to BASE");
    }

    function test_Gate_BlocksUnderRepRequester() public {
        uint256 skillId = _registerSkillGated(55);
        vm.prank(beta); // fresh requester, rep 50
        vm.expectRevert(bytes("insufficient reputation"));
        reg.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);
    }

    function test_Gate_AllowsAtOrAboveRep() public {
        // beta earns rep 55 by completing one arm's-length ungated job.
        uint256 ungated = _registerSkill();
        uint256 j1 = _openJob(ungated);
        vm.prank(alpha);
        reg.deliverResult(j1, RESULT_HASH);
        vm.prank(beta);
        reg.confirmCompletion(j1);
        assertEq(reg.agentReputation(beta), 55, "beta earned rep");

        // now beta (rep 55) can invoke a gated skill requiring 55.
        uint256 gated = _registerSkillGated(55);
        vm.prank(beta);
        uint256 j2 = reg.createJob{value: PRICE}(gated, keccak256("task-2"), DEADLINE_SECS);
        assertGt(j2, 0, "gated job created at threshold");
    }

    function test_SetMinReputation_OwnerOnly() public {
        uint256 skillId = _registerSkill();
        vm.prank(beta);
        vm.expectRevert(bytes("not skill owner"));
        reg.setMinReputation(skillId, 70);

        vm.prank(alpha);
        reg.setMinReputation(skillId, 70);
        (, , , , , , , , , uint256 minRep) = reg.skills(skillId);
        assertEq(minRep, 70, "owner updated threshold");
    }

    // ── Abductive-2 + Tier-0: self-deal must not farm ANY trust signal (both completion paths) ──
    function test_SelfDeal_NoRepFarm() public {
        vm.prank(alpha);
        uint256 skillId = reg.registerSkill("self", "self", "mcp://alpha", PRICE, 0);

        // Path 1: confirmCompletion on a self-job (alpha requester == provider).
        vm.prank(alpha);
        uint256 j1 = reg.createJob{value: PRICE}(skillId, keccak256("self-1"), DEADLINE_SECS);
        vm.prank(alpha);
        reg.deliverResult(j1, RESULT_HASH);
        vm.prank(alpha);
        reg.confirmCompletion(j1);
        assertEq(reg.agentReputation(alpha), 50, "self-deal confirm grants no agent rep");

        // Path 2: claimAfterReview on a self-job.
        vm.prank(alpha);
        uint256 j2 = reg.createJob{value: PRICE}(skillId, keccak256("self-2"), DEADLINE_SECS);
        vm.prank(alpha);
        reg.deliverResult(j2, RESULT_HASH);
        vm.warp(block.timestamp + reg.REVIEW_WINDOW() + 1);
        vm.prank(alpha);
        reg.claimAfterReview(j2);
        assertEq(reg.agentReputation(alpha), 50, "self-deal claim grants no agent rep");

        // Tier-0: neither self-deal path may inflate the skill's discovery signals. reputationScore
        // drives the off-chain BM25 boost (1.0..2.0x); totalInvocations is shown as social proof.
        // Both stay at base despite two completed self-jobs — escrow settled, no trust manufactured.
        (, , , , , uint256 reputation, uint256 invocations, , , ) = reg.skills(skillId);
        assertEq(reputation, 50, "self-deal must not inflate skill reputation (BM25 boost input)");
        assertEq(invocations, 0, "self-deal must not inflate invocation count");
    }

    // ── Tier-0 regression: single-wallet discovery-rank pump is neutralized ──
    // Pre-fix, reputationScore bumped unconditionally, so ONE wallet could self-deal price-0 jobs on
    // its own skill, driving reputationScore -> 100 (BM25 boost 2.0x) to drown real skills at zero
    // capital. Now self-deals earn nothing, so the rank cannot be pumped from a closed Sybil set.
    function test_SelfDeal_NoDiscoveryRankPump() public {
        vm.prank(alpha);
        uint256 skillId = reg.registerSkill("pump", "pump", "mcp://alpha", 0, 0); // price 0 = zero capital

        for (uint256 i = 0; i < 5; i++) {
            vm.prank(alpha);
            uint256 jobId = reg.createJob{value: 0}(skillId, keccak256(abi.encode("pump", i)), DEADLINE_SECS);
            vm.prank(alpha);
            reg.deliverResult(jobId, RESULT_HASH);
            vm.prank(alpha);
            reg.confirmCompletion(jobId);
        }

        (, , , , , uint256 reputation, uint256 invocations, , , ) = reg.skills(skillId);
        assertEq(reputation, 50, "5 self-deals cannot raise skill reputation above base");
        assertEq(invocations, 0, "self-deals never count as invocations");
    }

    // ── PD-003: O(1) dedup index ───────────────────────────────
    function test_JobByTaskHash_DedupIndex() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        assertEq(reg.jobByTaskHash(TASK_HASH), jobId, "taskHash maps to jobId");
        assertEq(reg.jobByTaskHash(keccak256("never")), 0, "unknown taskHash maps to 0");
    }

    // ── Fix 5: durable on-chain exactly-once (no double-escrow on lost-ack retry) ──
    // The app derives a deterministic taskHash from (requester, skillId, idempotencyNonce) and
    // does a check-before-write, but that check cannot see a tx still in the mempool. The contract
    // is the source of truth: a second escrow for an already-used taskHash MUST revert, so a retry
    // that re-broadcasts before the first tx mines cannot create a second escrowed job.
    function test_CreateJob_DuplicateTaskHash_Reverts() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId); // first job with TASK_HASH
        assertEq(reg.jobByTaskHash(TASK_HASH), jobId, "first job indexed by taskHash");

        vm.prank(beta);
        vm.expectRevert(bytes("duplicate taskHash"));
        reg.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);

        // Escrow taken exactly once — the registry holds a single PRICE, not two.
        assertEq(address(reg).balance, PRICE, "no double escrow");
        assertEq(reg.jobByTaskHash(TASK_HASH), jobId, "dedup index still points at the first job");
    }

    // ── R1/ADR-1: review window is deploy-time config (immutable), bounded ──
    function test_Constructor_DefaultWindowMatchesConstant() public view {
        assertEq(reg.REVIEW_WINDOW(), reg.DEFAULT_REVIEW_WINDOW(), "setUp deploys the default window");
        assertEq(reg.DEFAULT_REVIEW_WINDOW(), 3 days, "default review window is 3 days");
    }

    function test_Constructor_SetsConfigurableImmutableWindow() public {
        AgentSkillRegistry r = new AgentSkillRegistry(7 days);
        assertEq(r.REVIEW_WINDOW(), 7 days, "review window taken from the constructor arg");
    }

    function test_Constructor_RejectsBelowMin() public {
        uint256 belowMin = reg.MIN_REVIEW_WINDOW() - 1; // read view BEFORE expectRevert latches
        vm.expectRevert(bytes("bad review window"));
        new AgentSkillRegistry(belowMin);
    }

    function test_Constructor_RejectsAboveMax() public {
        uint256 aboveMax = reg.MAX_REVIEW_WINDOW() + 1; // read view BEFORE expectRevert latches
        vm.expectRevert(bytes("bad review window"));
        new AgentSkillRegistry(aboveMax);
    }

    function test_Constructor_ConfiguredWindowDrivesDisputeBoundary() public {
        AgentSkillRegistry r = new AgentSkillRegistry(1 hours);
        vm.prank(alpha);
        uint256 skillId = r.registerSkill("s", "d", "mcp://a", PRICE, 0);
        vm.prank(beta);
        uint256 jobId = r.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);
        vm.prank(alpha);
        r.deliverResult(jobId, RESULT_HASH);
        // dispute reverts just past the configured (short) window — boundary tracks REVIEW_WINDOW
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(beta);
        vm.expectRevert(bytes("review window closed"));
        r.disputeResult(jobId);
    }

    // ── Reentrancy (P2.5 HIGH) ─────────────────────────────────
    function test_Reentrancy_WithdrawBlocked() public {
        ReentrantProvider attacker = new ReentrantProvider(reg);
        vm.deal(beta, 10 ether);

        uint256 skillId = attacker.register(PRICE);
        vm.prank(beta);
        uint256 jobId = reg.createJob{value: PRICE}(skillId, TASK_HASH, DEADLINE_SECS);
        attacker.deliver(jobId, RESULT_HASH);
        vm.prank(beta);
        reg.confirmCompletion(jobId);

        attacker.attack(); // its receive() re-enters withdraw()

        // Attacker must receive escrow exactly once; registry not drained.
        assertEq(address(attacker).balance, PRICE, "attacker paid exactly once");
        assertEq(address(reg).balance, 0, "registry fully settled, not drained");
    }

    // ── Tier-2 Sybil-resistance bond (PD-007) ──────────────────
    function test_Bond_DepositSeedsAndIsPerAgent() public {
        vm.expectEmit(true, false, false, true);
        emit BondUpdated(alpha, 2 ether, 2 ether);
        vm.prank(alpha);
        reg.depositBond{value: 2 ether}();

        assertEq(reg.bondedAmount(alpha), 2 ether, "bond locked");
        assertEq(reg.seedEligibleBond(alpha), 2 ether, "active bond seeds");
        assertEq(reg.bondedAmount(beta), 0, "bond is per-agent: alpha's does not seed beta");
        assertEq(reg.seedEligibleBond(beta), 0, "no bond means no seed (open, no paywall)");
    }

    function test_Bond_DepositZeroReverts() public {
        vm.prank(alpha);
        vm.expectRevert(bytes("no bond"));
        reg.depositBond{value: 0}();
    }

    function test_Bond_RequestUnlockStopsSeedingButKeepsCapitalLocked() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        reg.requestBondUnlock();
        // Flash-seed defense: seed weight drops to 0 immediately, but the capital stays locked.
        assertEq(reg.seedEligibleBond(alpha), 0, "cooling-down bond does not seed");
        assertEq(reg.bondedAmount(alpha), 1 ether, "capital still locked across the cooldown");
    }

    function test_Bond_WithdrawBeforeCooldownReverts() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        reg.requestBondUnlock();
        vm.warp(block.timestamp + reg.BOND_UNLOCK_COOLDOWN() - 1);
        vm.prank(alpha);
        vm.expectRevert(bytes("cooldown active"));
        reg.withdrawBond();
    }

    function test_Bond_WithdrawWithoutRequestReverts() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        vm.expectRevert(bytes("not unlocking"));
        reg.withdrawBond();
    }

    function test_Bond_WithdrawAfterCooldownReturnsCapitalViaPullPayment() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        reg.requestBondUnlock();
        vm.warp(block.timestamp + reg.BOND_UNLOCK_COOLDOWN());
        vm.prank(alpha);
        reg.withdrawBond();
        assertEq(reg.bondedAmount(alpha), 0, "bond cleared");
        assertEq(reg.pendingWithdrawals(alpha), 1 ether, "credited to the audited pull-payment ledger");

        uint256 balBefore = alpha.balance;
        vm.prank(alpha);
        reg.withdraw();
        assertEq(alpha.balance, balBefore + 1 ether, "bond returned to the agent");
    }

    function test_Bond_CancelUnlockReactivatesSeed() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        reg.requestBondUnlock();
        assertEq(reg.seedEligibleBond(alpha), 0, "not seeding while cooling");
        vm.prank(alpha);
        reg.cancelBondUnlock();
        assertEq(reg.seedEligibleBond(alpha), 1 ether, "seeding again after cancel");
    }

    function test_Bond_DepositDuringCooldownReactivatesAndAdds() public {
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        vm.prank(alpha);
        reg.requestBondUnlock();
        vm.prank(alpha);
        reg.depositBond{value: 1 ether}();
        assertEq(reg.bondedAmount(alpha), 2 ether, "added to the existing bond");
        assertEq(reg.seedEligibleBond(alpha), 2 ether, "re-committed: seeds the full amount");
        assertEq(reg.bondUnlockAt(alpha), 0, "pending unlock cleared by re-deposit");
    }

    function test_Bond_RequestUnlockWithoutBondReverts() public {
        vm.prank(beta);
        vm.expectRevert(bytes("no bond"));
        reg.requestBondUnlock();
    }
}

contract ReentrantProvider {
    AgentSkillRegistry public reg;
    bool private reentered;

    constructor(AgentSkillRegistry _reg) {
        reg = _reg;
    }

    function register(uint256 price) external returns (uint256) {
        return reg.registerSkill("evil", "reentrant", "mcp://evil", price, 0);
    }

    function deliver(uint256 jobId, bytes32 resultHash) external {
        reg.deliverResult(jobId, resultHash);
    }

    function attack() external {
        reg.withdraw();
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            // Re-entry attempt — must be blocked by nonReentrant / zeroed balance.
            try reg.withdraw() {} catch {}
        }
    }
}
