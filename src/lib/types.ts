import type { Address } from "viem";
import type { privateKeyToAccount } from "viem/accounts";

/** A viem local account with built-in nonce management. */
export type ManagedAccount = ReturnType<typeof privateKeyToAccount>;

export interface AgentIdentity {
  agentId: string;
  address: Address;
  account: ManagedAccount;
  /** Owning tenant, resolved at load: entry.tenant ?? default agent tenant (fail-closed binding). */
  tenant: string;
}

/** Web3 Secret Storage v3 crypto block (scrypt KDF variant). */
export interface CryptoV3 {
  // cipher/kdf are widened to string: parsed from an untrusted file, validated at runtime.
  cipher: string; // expected "aes-128-ctr"
  ciphertext: string; // hex
  cipherparams: { iv: string }; // hex
  kdf: string; // expected "scrypt"
  kdfparams: {
    dklen: number;
    n: number;
    r: number;
    p: number;
    salt: string; // hex
  };
  mac: string; // hex
}

/** KARMA multi-agent keystore file: standard v3 crypto per agent. */
export interface KeystoreFileV3 {
  version: 3;
  agents: Array<{
    agentId: string;
    address?: string;
    /** Owning tenant; absent ⇒ bound to KARMA_DEFAULT_AGENT_TENANT ?? MCP_TENANT_ID (fail-closed). */
    tenant?: string;
    crypto: CryptoV3;
  }>;
}

/**
 * On-chain job lifecycle status (mirrors AgentSkillRegistry.JobStatus enum, in order).
 * `Disputed` (index 4) exists on-chain even though no current tool path produces it — kept
 * so a uint8 status of 4 never silently mis-maps to 'Open'.
 */
export type JobStatus = "Open" | "Delivered" | "Completed" | "Refunded" | "Disputed";

/** A hydrated job edge for query_social_graph format:"full". All uint256s are strings (D-6). */
export interface JobDetail {
  job_id: string; // uint256 as decimal string
  counterpart: string; // the other party's address (requester or provider, by perspective)
  skill_id: string; // uint256 as decimal string
  escrow_amount_phrs: string; // wei / 1e18, 6 decimal places (integer-formatted, no float loss)
  escrow_amount_wei: string; // raw uint256 as decimal string
  status: JobStatus;
  result_hash: string | null; // 0x + 64 hex, or null if not yet delivered (all-zero)
  created_at: number; // unix seconds
}

/** Aggregate stats over an agent's job edges. */
export interface SocialGraphSummary {
  total_jobs_provided: number;
  total_jobs_requested: number;
  total_earned_phrs: string; // sum of escrow on Completed provider jobs
  total_spent_phrs: string; // sum of escrow on all requester jobs
  unique_partners: number; // distinct counterpart addresses
  reputation_score: number; // from BM25 index (0 extra RPC) or BASE fallback (50)
}

/** query_social_graph format:"full" result. */
export interface SocialGraphFullResult {
  focal_agent: string;
  as_provider: JobDetail[];
  as_requester: JobDetail[];
  summary: SocialGraphSummary;
}

/** One indexed skill document for the BM25 search index. */
export interface SkillDocument {
  id: number; // = skill_id (MiniSearch idField)
  skill_id: number;
  name: string;
  description: string;
  mcp_endpoint: string;
  price_per_call_wei: string; // string — BigInt-safe (spec D-6)
  reputation_score: number;
  owner_address: string;
  active: boolean;
  /**
   * Trust Gate (Phase 1): minimum requester reputation (0..100) the owner requires to invoke
   * this skill. App-layer policy only — there is no on-chain field for it yet, so it is absent
   * on docs hydrated from chain (skillDocFromChain) and carried forward across re-index by
   * BM25SkillIndex.upsert. Undefined / 0 ⇒ no gate. Phase 2 moves this on-chain.
   */
  min_reputation_to_invoke?: number;
}
