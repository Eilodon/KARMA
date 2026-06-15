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
        vm.deal(alpha, 1 ether);
    }

    function _registerSkill() internal returns (uint256 skillId) {
        vm.prank(alpha);
        skillId = reg.registerSkill("search", "paid discover_skills", "mcp://alpha", PRICE);
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

        (, , , , , uint256 reputation, uint256 invocations, , ) = reg.skills(skillId);
        assertEq(reputation, 55, "reputation +5 from base 50");
        assertEq(invocations, 1, "one invocation");
    }

    function test_CreateJob_RequiresExactEscrow() public {
        uint256 skillId = _registerSkill();
        vm.prank(beta);
        vm.expectRevert(bytes("escrow must equal price"));
        reg.createJob{value: PRICE - 1}(skillId, TASK_HASH, DEADLINE_SECS);
    }

    // ── Refund (L1 boundary) ───────────────────────────────────
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
        uint256 skillId = _registerSkill();
        uint256 jobId = _openJob(skillId);
        vm.prank(alpha);
        reg.deliverResult(jobId, RESULT_HASH);

        vm.warp(block.timestamp + DEADLINE_SECS + 1);
        vm.prank(beta);
        vm.expectRevert(bytes("not refundable"));
        reg.claimRefund(jobId);
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
        return reg.registerSkill("evil", "reentrant", "mcp://evil", price);
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
