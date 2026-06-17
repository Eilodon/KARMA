// SPDX-License-Identifier: MIT
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

    function setUp() public {
        reg = new AgentSkillRegistry();
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

    // ── Abductive-2: self-deal must not farm agent reputation (both completion paths) ──
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
    }

    // ── PD-003: O(1) dedup index ───────────────────────────────
    function test_JobByTaskHash_DedupIndex() public {
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        assertEq(reg.jobByTaskHash(TASK_HASH), jobId, "taskHash maps to jobId");
        assertEq(reg.jobByTaskHash(keccak256("never")), 0, "unknown taskHash maps to 0");
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
