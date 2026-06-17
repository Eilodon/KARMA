// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AgentSkillRegistry — on-chain skill registry + escrowed job coordination for KARMA.
/// @notice Hardened per spec v3.1 D-8: pull-payment + ReentrancyGuard + checks-effects-interactions
///         + refund-after-deadline (no permanent fund lock).
contract AgentSkillRegistry is ReentrancyGuard {
    // ── Types ──────────────────────────────────────────────────
    struct Skill {
        address owner;
        string name;
        string description;
        string mcpEndpoint;
        uint256 pricePerCall; // wei
        uint256 reputationScore; // 0..100, starts 50
        uint256 totalInvocations;
        bool active;
        uint256 registeredAt;
        uint256 minReputationToInvoke; // Trust Gate (on-chain, PD-005): 0 = open
    }

    struct Job {
        address requester;
        address provider; // skill owner snapshot at creation
        uint256 skillId;
        bytes32 taskHash;
        uint256 escrowAmount;
        uint256 deadline; // absolute unix timestamp
        JobStatus status;
        bytes32 resultHash;
        uint256 createdAt;
        uint256 completedAt;
    }

    enum JobStatus {
        Open,
        Delivered,
        Completed,
        Refunded,
        Disputed
    }

    uint256 public constant BASE_REPUTATION = 50;
    uint256 public constant MAX_REPUTATION = 100;
    uint256 public constant REPUTATION_STEP = 5;
    /// @notice Post-delivery review window — a delivered job auto-settles to the provider after this.
    uint256 public constant REVIEW_WINDOW = 3 days;

    // ── State ──────────────────────────────────────────────────
    uint256 private _skillIdCounter;
    uint256 private _jobIdCounter;

    mapping(uint256 => Skill) public skills;
    mapping(uint256 => Job) public jobs;
    mapping(address => uint256[]) public agentProviderJobs;
    mapping(address => uint256[]) public agentRequesterJobs;
    mapping(address => uint256[]) public agentSkills;
    mapping(address => uint256) public pendingWithdrawals; // pull-payment ledger
    mapping(bytes32 => uint256) public jobByTaskHash; // PD-003: O(1) dedup (taskHash binds requester)
    mapping(address => uint256) private _agentRep; // PD-005: 0 = unset ⇒ BASE_REPUTATION (rep only rises)

    // ── Events ─────────────────────────────────────────────────
    event SkillRegistered(uint256 indexed skillId, address indexed owner, string name, uint256 pricePerCall);
    event SkillDeactivated(uint256 indexed skillId);
    event JobCreated(
        uint256 indexed jobId, address indexed requester, uint256 indexed skillId, uint256 escrow, uint256 deadline
    );
    event ResultDelivered(uint256 indexed jobId, bytes32 resultHash);
    event JobCompleted(uint256 indexed jobId, address indexed provider, uint256 payout, uint256 newReputation);
    event JobRefunded(uint256 indexed jobId, address indexed requester, uint256 amount);
    event ResultDisputed(uint256 indexed jobId, address indexed requester, uint256 amount);
    event MinReputationSet(uint256 indexed skillId, uint256 minReputation);
    event Withdrawn(address indexed who, uint256 amount);

    // ── Skill lifecycle ────────────────────────────────────────
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
            owner: msg.sender,
            name: name,
            description: description,
            mcpEndpoint: mcpEndpoint,
            pricePerCall: pricePerCall,
            reputationScore: BASE_REPUTATION,
            totalInvocations: 0,
            active: true,
            registeredAt: block.timestamp,
            minReputationToInvoke: minReputationToInvoke
        });
        agentSkills[msg.sender].push(skillId);
        emit SkillRegistered(skillId, msg.sender, name, pricePerCall);
    }

    function deactivateSkill(uint256 skillId) external {
        Skill storage s = skills[skillId];
        require(s.owner == msg.sender, "not skill owner");
        require(s.active, "already inactive");
        s.active = false;
        emit SkillDeactivated(skillId);
    }

    /// @notice Owner adjusts the Trust Gate threshold for a skill (PD-005).
    function setMinReputation(uint256 skillId, uint256 minReputation) external {
        Skill storage s = skills[skillId];
        require(s.owner == msg.sender, "not skill owner");
        require(minReputation <= MAX_REPUTATION, "bad threshold");
        s.minReputationToInvoke = minReputation;
        emit MinReputationSet(skillId, minReputation);
    }

    // ── Agent reputation (PD-005) ──────────────────────────────
    /// @notice Earned reputation, lazy-initialized to BASE_REPUTATION. Invariant: rep only ever rises,
    ///         so 0 is a safe "unset" sentinel — do NOT add a decay feature without changing this.
    function agentReputation(address agent) public view returns (uint256) {
        uint256 r = _agentRep[agent];
        return r == 0 ? BASE_REPUTATION : r;
    }

    function _bumpAgentRep(address agent) private {
        uint256 next = agentReputation(agent) + REPUTATION_STEP;
        _agentRep[agent] = next > MAX_REPUTATION ? MAX_REPUTATION : next;
    }

    // ── Job lifecycle ──────────────────────────────────────────
    /// @param deadlineSecs duration (seconds) added to now → absolute deadline (avoids client clock skew).
    function createJob(uint256 skillId, bytes32 taskHash, uint256 deadlineSecs)
        external
        payable
        returns (uint256 jobId)
    {
        Skill storage s = skills[skillId];
        require(s.owner != address(0), "skill not found");
        require(s.active, "skill inactive");
        require(msg.value == s.pricePerCall, "escrow must equal price");
        require(deadlineSecs > 0, "deadline required");
        require(agentReputation(msg.sender) >= s.minReputationToInvoke, "insufficient reputation");

        jobId = ++_jobIdCounter;
        jobs[jobId] = Job({
            requester: msg.sender,
            provider: s.owner,
            skillId: skillId,
            taskHash: taskHash,
            escrowAmount: msg.value,
            deadline: block.timestamp + deadlineSecs,
            status: JobStatus.Open,
            resultHash: bytes32(0),
            createdAt: block.timestamp,
            completedAt: 0
        });
        agentRequesterJobs[msg.sender].push(jobId);
        agentProviderJobs[s.owner].push(jobId);
        jobByTaskHash[taskHash] = jobId; // PD-003: O(1) dedup lookup
        emit JobCreated(jobId, msg.sender, skillId, msg.value, jobs[jobId].deadline);
    }

    function deliverResult(uint256 jobId, bytes32 resultHash) external {
        Job storage j = jobs[jobId];
        require(j.provider == msg.sender, "not provider");
        require(j.status == JobStatus.Open, "job not open");
        j.status = JobStatus.Delivered;
        j.resultHash = resultHash;
        // Repurpose `deadline` as the review-by time (the original create deadline is moot once
        // delivered; claimRefund's status==Open guard prevents any cross-talk — see audit FM1).
        j.deadline = block.timestamp + REVIEW_WINDOW;
        emit ResultDelivered(jobId, resultHash);
    }

    function confirmCompletion(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.requester == msg.sender, "not requester");
        require(j.status == JobStatus.Delivered, "job not delivered");
        // Allowed at ANY time while Delivered — a good-faith requester is never forced to wait out
        // the review window (no `block.timestamp <= deadline` guard here, by design).
        _settleCompletion(j, jobId);
    }

    /// @notice Provider claims payment if the requester neither confirmed nor disputed in the window.
    ///         Resolves the ghosting-requester deadlock (Claim 3) — no permanent fund lock.
    function claimAfterReview(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.provider == msg.sender, "not provider");
        require(j.status == JobStatus.Delivered, "job not delivered");
        require(block.timestamp > j.deadline, "review window open");
        _settleCompletion(j, jobId);
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

    /// @dev Shared completion effects for confirmCompletion + claimAfterReview (CEI, no external call).
    function _settleCompletion(Job storage j, uint256 jobId) private {
        j.status = JobStatus.Completed;
        j.completedAt = block.timestamp;
        pendingWithdrawals[j.provider] += j.escrowAmount;

        Skill storage s = skills[j.skillId];
        s.totalInvocations += 1;
        uint256 rep = s.reputationScore + REPUTATION_STEP;
        s.reputationScore = rep > MAX_REPUTATION ? MAX_REPUTATION : rep;

        // Self-deal guard (audit Abductive-2): only arm's-length jobs earn agent reputation. Applied
        // identically on BOTH completion paths because both call _settleCompletion.
        if (j.requester != j.provider) {
            _bumpAgentRep(j.provider);
            _bumpAgentRep(j.requester);
        }

        emit JobCompleted(jobId, j.provider, j.escrowAmount, s.reputationScore);
    }

    /// @notice Requester reclaims escrow if the provider never delivered past the deadline.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.requester == msg.sender, "not requester");
        require(j.status == JobStatus.Open, "not refundable");
        require(block.timestamp > j.deadline, "before deadline");

        j.status = JobStatus.Refunded;
        pendingWithdrawals[msg.sender] += j.escrowAmount;
        emit JobRefunded(jobId, msg.sender, j.escrowAmount);
    }

    // ── Pull-payment withdrawal (CEI + nonReentrant) ───────────
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0; // effects before interaction
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ── Views for social graph / reputation ────────────────────
    function getProviderJobs(address agent) external view returns (uint256[] memory) {
        return agentProviderJobs[agent];
    }

    function getRequesterJobs(address agent) external view returns (uint256[] memory) {
        return agentRequesterJobs[agent];
    }

    function getAgentSkills(address agent) external view returns (uint256[] memory) {
        return agentSkills[agent];
    }

    function skillCount() external view returns (uint256) {
        return _skillIdCounter;
    }

    function jobCount() external view returns (uint256) {
        return _jobIdCounter;
    }
}
