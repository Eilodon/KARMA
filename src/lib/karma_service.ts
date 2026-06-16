import { parseEventLogs, type Account, type Address, type Hash } from "viem";
import { keystoreManager } from "./keystore.js";
import { agentSkillRegistryAbi } from "./abi.js";
import {
  deriveTaskHash,
  findJobByTaskHash,
  getContractAddress,
  getPublicClient,
  makeOnchainJobReader,
  writeContractBounded,
  type WriteOutcome,
} from "./contract.js";
import { skillIndex, type SkillSearchHit, type SkillSearchOptions } from "./bm25_index.js";
import type { SkillDocument } from "./types.js";

/**
 * KarmaService — the network/keystore/index boundary the tools depend on.
 *
 * Tools (karma.tool.ts) are pure orchestration over this interface, so they unit-test against
 * a fake. realKarmaService wires the live Pharos clients, keystore, and BM25 index; its methods
 * are exercised end-to-end by the P7 demo. Writes return a WriteOutcome (confirmed|pending);
 * on `pending`, ids are null (no receipt to decode) and the caller surfaces a pending status.
 */

export interface OnchainSkill {
  owner: Address;
  name: string;
  description: string;
  mcpEndpoint: string;
  pricePerCall: bigint;
  reputationScore: bigint;
  totalInvocations: bigint;
  active: boolean;
  registeredAt: bigint;
}

export interface OnchainJob {
  requester: Address;
  provider: Address;
  skillId: bigint;
  taskHash: Hash;
  escrowAmount: bigint;
  deadline: bigint;
  status: number;
  resultHash: Hash;
  createdAt: bigint;
  completedAt: bigint;
}

export interface KarmaService {
  account(agentId: string): Account;
  addressOf(agentId: string): Address;
  registerSkill(
    account: Account,
    p: { name: string; description: string; mcpEndpoint: string; pricePerCall: bigint },
  ): Promise<{ skillId: bigint | null; outcome: WriteOutcome }>;
  readSkill(skillId: bigint): Promise<OnchainSkill>;
  readJob(jobId: bigint): Promise<OnchainJob>;
  deriveTaskHash(requester: Address, skillId: bigint, nonce: bigint): Hash;
  findExistingJob(requester: Address, taskHash: Hash): Promise<bigint | null>;
  createJob(
    account: Account,
    p: { skillId: bigint; taskHash: Hash; deadlineSecs: bigint; value: bigint },
  ): Promise<{ jobId: bigint | null; outcome: WriteOutcome }>;
  deliverResult(account: Account, p: { jobId: bigint; resultHash: Hash }): Promise<WriteOutcome>;
  confirmCompletion(account: Account, p: { jobId: bigint }): Promise<WriteOutcome>;
  getAgentSkills(addr: Address): Promise<readonly bigint[]>;
  getProviderJobs(addr: Address): Promise<readonly bigint[]>;
  getRequesterJobs(addr: Address): Promise<readonly bigint[]>;
  /** Withdrawable balance (released escrow awaiting pull-payment), in wei. */
  getPendingWithdrawal(addr: Address): Promise<bigint>;
  /** Pull the full withdrawable balance. amount is decoded from the Withdrawn event (null if pending). */
  withdraw(account: Account): Promise<{ amount: bigint | null; outcome: WriteOutcome }>;
  indexUpsert(doc: SkillDocument): void;
  /** Remove a skill from the discovery index (e.g. on SkillDeactivated). */
  indexDiscard(skillId: number): void;
  search(query: string, opts: SkillSearchOptions): SkillSearchHit[];
  /** First indexed skill doc for an owner (reputation source, 0 RPC), or null. */
  getByOwner(addr: Address): SkillDocument | null;
  /** Trust Gate (Phase 1): threshold declared for a skill, 0 = no gate. Index-derived (0 RPC). */
  getSkillThreshold(skillId: bigint): number;
  /** Trust Gate (Phase 1): an address's requester reputation (max owned-skill rep, else 0). 0 RPC. */
  getReputation(addr: Address): number;
}

function read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
  // viem infers a literal functionName + tuple args; this dynamic dispatch needs the cast.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return getPublicClient().readContract({
    address: getContractAddress(),
    abi: agentSkillRegistryAbi,
    functionName,
    args,
  } as never) as Promise<T>;
}

/** Decode a uint256 arg from the first matching event in a confirmed receipt; null if pending. */
function extractId(outcome: WriteOutcome, eventName: string, argName: string): bigint | null {
  if (outcome.status !== "confirmed") return null;
  const logs = parseEventLogs({
    abi: agentSkillRegistryAbi,
    eventName: eventName as never,
    logs: outcome.receipt.logs,
  });
  const first = logs[0] as { args?: Record<string, unknown> } | undefined;
  const id = first?.args?.[argName];
  return typeof id === "bigint" ? id : null;
}

export const realKarmaService: KarmaService = {
  account: (agentId) => keystoreManager.getAccount(agentId),
  addressOf: (agentId) => keystoreManager.getAddress(agentId),

  async registerSkill(account, p) {
    const outcome = await writeContractBounded(account, {
      functionName: "registerSkill",
      args: [p.name, p.description, p.mcpEndpoint, p.pricePerCall],
    });
    return { skillId: extractId(outcome, "SkillRegistered", "skillId"), outcome };
  },

  async readSkill(skillId) {
    const t = await read<readonly unknown[]>("skills", [skillId]);
    return {
      owner: t[0] as Address,
      name: t[1] as string,
      description: t[2] as string,
      mcpEndpoint: t[3] as string,
      pricePerCall: t[4] as bigint,
      reputationScore: t[5] as bigint,
      totalInvocations: t[6] as bigint,
      active: t[7] as boolean,
      registeredAt: t[8] as bigint,
    };
  },

  async readJob(jobId) {
    const t = await read<readonly unknown[]>("jobs", [jobId]);
    return {
      requester: t[0] as Address,
      provider: t[1] as Address,
      skillId: t[2] as bigint,
      taskHash: t[3] as Hash,
      escrowAmount: t[4] as bigint,
      deadline: t[5] as bigint,
      status: Number(t[6]),
      resultHash: t[7] as Hash,
      createdAt: t[8] as bigint,
      completedAt: t[9] as bigint,
    };
  },

  deriveTaskHash,
  findExistingJob: (requester, taskHash) => findJobByTaskHash(requester, taskHash, makeOnchainJobReader()),

  async createJob(account, p) {
    const outcome = await writeContractBounded(account, {
      functionName: "createJob",
      args: [p.skillId, p.taskHash, p.deadlineSecs],
      value: p.value,
    });
    return { jobId: extractId(outcome, "JobCreated", "jobId"), outcome };
  },

  deliverResult: (account, p) =>
    writeContractBounded(account, { functionName: "deliverResult", args: [p.jobId, p.resultHash] }),

  confirmCompletion: (account, p) =>
    writeContractBounded(account, { functionName: "confirmCompletion", args: [p.jobId] }),

  getAgentSkills: (addr) => read("getAgentSkills", [addr]),
  getProviderJobs: (addr) => read("getProviderJobs", [addr]),
  getRequesterJobs: (addr) => read("getRequesterJobs", [addr]),
  getPendingWithdrawal: (addr) => read("pendingWithdrawals", [addr]),

  async withdraw(account) {
    const outcome = await writeContractBounded(account, { functionName: "withdraw", args: [] });
    return { amount: extractId(outcome, "Withdrawn", "amount"), outcome };
  },

  indexUpsert: (doc) => skillIndex.upsert(doc),
  indexDiscard: (skillId) => skillIndex.discard(skillId),
  search: (query, opts) => skillIndex.search(query, opts),
  getByOwner: (addr) => skillIndex.getByOwner(addr),
  getSkillThreshold: (skillId) => skillIndex.getThreshold(Number(skillId)),
  getReputation: (addr) => skillIndex.getReputation(addr),
};
