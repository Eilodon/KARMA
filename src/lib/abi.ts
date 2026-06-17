/**
 * Typed ABI for AgentSkillRegistry.sol, transcribed from the compiled forge artifact
 * (out/AgentSkillRegistry.sol/AgentSkillRegistry.json). `as const` gives viem full type
 * inference on read/write/event calls. A structural drift-guard test
 * (src/__tests__/karma_contract.test.ts) re-reads the artifact and fails if the .sol
 * surface changes without a matching update here.
 */
export const agentSkillRegistryAbi = [
  // ── constructor (review window is deploy-time config, then immutable) ──
  { type: "constructor", stateMutability: "nonpayable", inputs: [{ name: "reviewWindowSecs", type: "uint256" }] },

  // ── constants ──
  { type: "function", name: "BASE_REPUTATION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "DEFAULT_REVIEW_WINDOW", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_REPUTATION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_REVIEW_WINDOW", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MIN_REVIEW_WINDOW", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "REPUTATION_STEP", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "REVIEW_WINDOW", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },

  // ── public array-mapping getters (index access) ──
  { type: "function", name: "agentProviderJobs", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "agentRequesterJobs", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "agentSkills", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },

  // ── job lifecycle ──
  { type: "function", name: "claimRefund", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "confirmCompletion", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "createJob", stateMutability: "payable", inputs: [{ name: "skillId", type: "uint256" }, { name: "taskHash", type: "bytes32" }, { name: "deadlineSecs", type: "uint256" }], outputs: [{ name: "jobId", type: "uint256" }] },
  { type: "function", name: "deliverResult", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "resultHash", type: "bytes32" }], outputs: [] },

  // ── skill lifecycle ──
  { type: "function", name: "deactivateSkill", stateMutability: "nonpayable", inputs: [{ name: "skillId", type: "uint256" }], outputs: [] },
  { type: "function", name: "registerSkill", stateMutability: "nonpayable", inputs: [{ name: "name", type: "string" }, { name: "description", type: "string" }, { name: "mcpEndpoint", type: "string" }, { name: "pricePerCall", type: "uint256" }, { name: "minReputationToInvoke", type: "uint256" }], outputs: [{ name: "skillId", type: "uint256" }] },
  { type: "function", name: "setMinReputation", stateMutability: "nonpayable", inputs: [{ name: "skillId", type: "uint256" }, { name: "minReputation", type: "uint256" }], outputs: [] },

  // ── job resolution (v2) ──
  { type: "function", name: "claimAfterReview", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "disputeResult", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },

  // ── views ──
  { type: "function", name: "agentReputation", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "jobByTaskHash", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getAgentSkills", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256[]" }] },
  { type: "function", name: "getProviderJobs", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256[]" }] },
  { type: "function", name: "getRequesterJobs", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256[]" }] },
  { type: "function", name: "jobCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "skillCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "pendingWithdrawals", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "jobs", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "requester", type: "address" },
      { name: "provider", type: "address" },
      { name: "skillId", type: "uint256" },
      { name: "taskHash", type: "bytes32" },
      { name: "escrowAmount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "status", type: "uint8" },
      { name: "resultHash", type: "bytes32" },
      { name: "createdAt", type: "uint256" },
      { name: "completedAt", type: "uint256" },
    ],
  },
  {
    type: "function", name: "skills", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "name", type: "string" },
      { name: "description", type: "string" },
      { name: "mcpEndpoint", type: "string" },
      { name: "pricePerCall", type: "uint256" },
      { name: "reputationScore", type: "uint256" },
      { name: "totalInvocations", type: "uint256" },
      { name: "active", type: "bool" },
      { name: "registeredAt", type: "uint256" },
      { name: "minReputationToInvoke", type: "uint256" },
    ],
  },

  // ── pull-payment ──
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [], outputs: [] },

  // ── events ──
  { type: "event", name: "SkillRegistered", inputs: [{ name: "skillId", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true }, { name: "name", type: "string", indexed: false }, { name: "pricePerCall", type: "uint256", indexed: false }] },
  { type: "event", name: "SkillDeactivated", inputs: [{ name: "skillId", type: "uint256", indexed: true }] },
  { type: "event", name: "JobCreated", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "requester", type: "address", indexed: true }, { name: "skillId", type: "uint256", indexed: true }, { name: "escrow", type: "uint256", indexed: false }, { name: "deadline", type: "uint256", indexed: false }] },
  { type: "event", name: "ResultDelivered", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "resultHash", type: "bytes32", indexed: false }] },
  { type: "event", name: "JobCompleted", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "provider", type: "address", indexed: true }, { name: "payout", type: "uint256", indexed: false }, { name: "newReputation", type: "uint256", indexed: false }] },
  { type: "event", name: "JobRefunded", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "requester", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "ResultDisputed", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "requester", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "MinReputationSet", inputs: [{ name: "skillId", type: "uint256", indexed: true }, { name: "minReputation", type: "uint256", indexed: false }] },
  { type: "event", name: "Withdrawn", inputs: [{ name: "who", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
] as const;
