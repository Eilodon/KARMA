import { z } from "zod/v4";
import type { Address, Hash } from "viem";
import type { ToolDefinition, ToolResult } from "../mcp/adapter/tool_registry.js";
import { jsonSafe } from "../lib/serialize.js";
import { realKarmaService, type KarmaService } from "../lib/karma_service.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";
import { getRequestContext } from "../security/context.js";
import { getKarmaIndexerHealth } from "../lib/skill_indexer_runtime.js";
import { ENV } from "../config/env.js";
import type { JobDetail, JobStatus, SocialGraphFullResult } from "../lib/types.js";

/**
 * KARMA Skill-Economy plugin (Layer 1).
 *
 * MUST run in-process as a trusted built-in (see isTrustedBuiltInPlugin / spec D-1).
 * Module-level singletons (keystoreManager, skillIndex) and process.env access (PHAROS_*,
 * KEYSTORE_*) only survive in-process — the external child-process worker forks per call
 * and strips env via workerEnv(). `assertInProcess()` is the fail-fast canary for that.
 *
 * The canary is FAIL-CLOSED: it requires positive proof that this is the trusted runtime
 * (isTrustedRuntime(), set only by PluginLoader.loadAll in the parent). A future runner that
 * loads karma.tool without marking trust is denied by default — the legacy KARMA_PLUGIN_WORKER
 * env var stays as a secondary signal, but absence of it no longer implies in-process.
 *
 * Tools are pure orchestration over a KarmaService (the network/keystore/index boundary), so
 * they unit-test against a fake; createKarmaTools(realKarmaService) wires the live system.
 */
function assertInProcess(): void {
  if (!isTrustedRuntime() || process.env.KARMA_PLUGIN_WORKER === "1") {
    throw new Error(
      "[KARMA] karma.tool.ts must run in the trusted in-process runtime (trusted built-in), not the " +
        "external worker. Ensure PluginLoader.loadAll marks the runtime trusted, keep karma.tool in " +
        "isTrustedBuiltInPlugin(), and use MCP_PLUGIN_ISOLATION_MODE=policy.",
    );
  }
}

const PHASES = ["intake", "execution", "review", "completed"] as const;
const RESULT_HASH = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x + 64 hex chars");
const WEI = z.string().regex(/^[0-9]+$/, "expected a base-10 wei string");

/** Build the result envelope, stringifying every BigInt in structuredContent (D-6). */
function reply(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: jsonSafe(structured) };
}

const karmaHealth: ToolDefinition = {
  name: "karma_health",
  description:
    "Report KARMA plugin runtime: in-process mode and presence of Pharos RPC configuration. " +
    "Canary that a network-capability tool loads under MCP_SAFE_MODE=false + in-process isolation.",
  inputSchema: { ping: z.string().optional().describe("Optional echo string.") },
  capabilities: ["network"],
  allowedPhases: [...PHASES],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execution: { taskSupport: "forbidden" },
  handler: async (args) => {
    assertInProcess();
    const ping = (args as { ping?: string }).ping;
    const hasRpcEnv = Boolean(process.env.PHAROS_RPC_URL);
    const hasContractEnv = Boolean(process.env.PHAROS_CONTRACT_ADDRESS);
    const indexer = getKarmaIndexerHealth();
    const indexerSummary =
      "watching" in indexer ? `watching=${indexer.watching} block=${indexer.lastIndexedBlock}` : "started=false";
    return reply(
      `[KARMA] health: in-process=true rpcEnv=${hasRpcEnv} contractEnv=${hasContractEnv} indexer[${indexerSummary}]` +
        (ping ? ` ping=${ping}` : ""),
      { inProcess: true, hasRpcEnv, hasContractEnv, indexer },
    );
  },
};

/**
 * Resolve a target address from either an agentId (keystore, tenant-checked) or a raw address.
 * The agentId path asserts the calling tenant owns the agent (STRIDE-S); the raw-address path is
 * unauthenticated on purpose — an address is public on-chain data.
 */
function resolveAddress(svc: KarmaService, a: { agentId?: string; address?: string }, tenantId: string): Address {
  if (a.agentId) return svc.addressOf(a.agentId, tenantId);
  if (a.address) return a.address as Address;
  throw new Error("[KARMA] provide either agentId or address");
}

/** JobStatus enum order from AgentSkillRegistry.sol (index 4 = Disputed). */
const STATUS_MAP: readonly JobStatus[] = ["Open", "Delivered", "Completed", "Refunded", "Disputed"];
const ZERO_HASH = `0x${"0".repeat(64)}`;
const WEI_PER_PHRS = 10n ** 18n;

/** Format wei → PHRS with exactly 6 decimals using integer math (no float precision loss). */
function weiToPhrs6(wei: bigint): string {
  const neg = wei < 0n;
  const w = neg ? -wei : wei;
  const whole = w / WEI_PER_PHRS;
  const frac6 = (w % WEI_PER_PHRS) / 10n ** 12n; // keep 6 of the 18 fractional digits
  return `${neg ? "-" : ""}${whole}.${frac6.toString().padStart(6, "0")}`;
}

/** Hydrate job ids in sequential chunks (matches the viem batchSize) to bound in-flight reads + memory. */
async function readJobsChunked(
  ids: string[],
  svc: KarmaService,
  chunk = 100,
): Promise<Array<Awaited<ReturnType<KarmaService["readJob"]>>>> {
  const out: Array<Awaited<ReturnType<KarmaService["readJob"]>>> = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    out.push(...(await Promise.all(slice.map((id) => svc.readJob(BigInt(id))))));
  }
  return out;
}

/**
 * query_social_graph format:"full" — hydrate each job edge into a JobDetail + a summary block.
 * RPC cost: getProviderJobs + getRequesterJobs (1 batched round-trip) + N×jobs() (batched, chunked
 * by 100) ≈ 2 round-trips for N ≤ 100. Reputation comes from the in-process BM25 index (0 RPC).
 * DoS cap (A3): at most KARMA_SOCIAL_GRAPH_MAX_JOBS edges are hydrated — beyond that the most-recent
 * subset is kept and `summary.truncated` is set (detail arrays + earned/spent become PARTIAL).
 */
async function handleFullFormat(address: Address, svc: KarmaService): Promise<SocialGraphFullResult> {
  const [providerIds, requesterIds] = await Promise.all([
    svc.getProviderJobs(address),
    svc.getRequesterJobs(address),
  ]);

  const allUnique = [...new Set([...providerIds, ...requesterIds].map(String))];
  const cap = ENV.KARMA_SOCIAL_GRAPH_MAX_JOBS;
  const truncated = allUnique.length > cap;
  // Job ids are monotonic — keep the most-recent `cap` (numeric desc, never lexicographic).
  const uniqueIds = truncated
    ? [...allUnique].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : BigInt(a) > BigInt(b) ? -1 : 0)).slice(0, cap)
    : allUnique;
  const hydratedSet = new Set(uniqueIds);
  const jobs = await readJobsChunked(uniqueIds, svc, 100);
  const jobById = new Map(uniqueIds.map((id, i) => [id, jobs[i]] as const));

  const toDetail = (id: bigint, counterpart: "requester" | "provider"): JobDetail => {
    const j = jobById.get(String(id));
    if (!j) throw new Error(`[KARMA] job #${id} missing from hydration batch`);
    return {
      job_id: String(id),
      counterpart: counterpart === "requester" ? j.requester : j.provider,
      skill_id: String(j.skillId),
      escrow_amount_phrs: weiToPhrs6(j.escrowAmount),
      escrow_amount_wei: String(j.escrowAmount),
      status: STATUS_MAP[j.status] ?? "Open",
      result_hash: j.resultHash.toLowerCase() === ZERO_HASH ? null : j.resultHash,
      created_at: Number(j.createdAt),
    };
  };

  // When truncated, only edges in the hydrated subset get a detail (avoids the hydration-miss throw).
  const asProvider = providerIds
    .filter((id) => hydratedSet.has(String(id)))
    .map((id) => toDetail(id, "requester"));
  const asRequester = requesterIds
    .filter((id) => hydratedSet.has(String(id)))
    .map((id) => toDetail(id, "provider"));

  const totalEarnedWei = asProvider
    .filter((j) => j.status === "Completed")
    .reduce((sum, j) => sum + BigInt(j.escrow_amount_wei), 0n);
  const totalSpentWei = asRequester.reduce((sum, j) => sum + BigInt(j.escrow_amount_wei), 0n);
  const uniquePartners = new Set(
    [...asProvider, ...asRequester].map((j) => j.counterpart.toLowerCase()),
  ).size;

  return {
    focal_agent: address,
    as_provider: asProvider,
    as_requester: asRequester,
    summary: {
      total_jobs_provided: providerIds.length, // full count (detail arrays may be capped — see truncated)
      total_jobs_requested: requesterIds.length,
      total_earned_phrs: weiToPhrs6(totalEarnedWei),
      total_spent_phrs: weiToPhrs6(totalSpentWei),
      unique_partners: uniquePartners,
      reputation_score: svc.getByOwner(address)?.reputation_score ?? 50,
      truncated,
      total_unique_jobs: allUnique.length,
    },
  };
}

export function createKarmaTools(svc: KarmaService): ToolDefinition[] {
  const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  const registerSkill: ToolDefinition = {
    name: "register_skill",
    description:
      "Register a callable skill on-chain (name, description, MCP endpoint, price per call in wei) and index it for discovery. " +
      "Optionally set minReputationToInvoke — a Trust Gate (Phase 1, app-layer) blocking create_job from requesters below that reputation.",
    inputSchema: {
      agentId: z.string().describe("Keystore agent id that owns/signs for this skill."),
      name: z.string().min(1),
      description: z.string().default(""),
      mcpEndpoint: z.string().default(""),
      pricePerCallWei: WEI.describe("Price per call in wei, as a base-10 string."),
      minReputationToInvoke: z.number().int().min(0).max(100).default(0)
        .describe("Trust Gate: min requester reputation (0..100) to invoke this skill. 0 = open. App-layer only (Phase 1)."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        name: z.string().min(1),
        description: z.string().default(""),
        mcpEndpoint: z.string().default(""),
        pricePerCallWei: WEI,
        minReputationToInvoke: z.number().int().min(0).max(100).default(0),
      }).parse(args);
      const { tenantId } = getRequestContext();
      const account = svc.account(a.agentId, tenantId);
      const { skillId, outcome } = await svc.registerSkill(account, {
        name: a.name,
        description: a.description,
        mcpEndpoint: a.mcpEndpoint,
        pricePerCall: BigInt(a.pricePerCallWei),
        minReputationToInvoke: BigInt(a.minReputationToInvoke), // v2: authoritative on-chain threshold
      });
      if (outcome.status === "pending" || skillId == null) {
        return reply(`[KARMA] register_skill broadcast; receipt pending tx=${outcome.hash}`, {
          status: "pending",
          txHash: outcome.hash,
        });
      }
      svc.indexUpsert({
        id: Number(skillId),
        skill_id: Number(skillId),
        name: a.name,
        description: a.description,
        mcp_endpoint: a.mcpEndpoint,
        price_per_call_wei: a.pricePerCallWei,
        reputation_score: 50,
        owner_address: account.address,
        active: true,
        min_reputation_to_invoke: a.minReputationToInvoke,
      });
      return reply(`[KARMA] registered skill #${skillId} tx=${outcome.hash}`, {
        status: "confirmed",
        skillId,
        txHash: outcome.hash,
        minReputationToInvoke: a.minReputationToInvoke,
      });
    },
  };

  const discoverSkills: ToolDefinition = {
    name: "discover_skills",
    description: "Search indexed skills by free text, ranked by relevance and on-chain reputation; optionally filter by max price (wei) and min reputation.",
    inputSchema: {
      query: z.string(),
      maxPriceWei: WEI.optional(),
      minReputation: z.number().int().min(0).max(100).optional(),
      limit: z.number().int().positive().max(50).optional(),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: { ...readAnnotations, openWorldHint: false },
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        query: z.string(),
        maxPriceWei: WEI.optional(),
        minReputation: z.number().int().min(0).max(100).optional(),
        limit: z.number().int().positive().max(50).optional(),
      }).parse(args);
      const skills = svc.search(a.query, {
        maxPriceWei: a.maxPriceWei != null ? BigInt(a.maxPriceWei) : undefined,
        minReputation: a.minReputation,
        limit: a.limit,
      });
      return reply(`[KARMA] discover_skills found ${skills.length} match(es)`, { count: skills.length, skills });
    },
  };

  const createJob: ToolDefinition = {
    name: "create_job",
    description: "Escrow a job against a skill. Idempotent per (requester, skillId, idempotencyNonce): a repeat returns the existing job instead of double-escrowing.",
    inputSchema: {
      agentId: z.string().describe("Keystore agent id of the requester."),
      skillId: WEI.describe("Target skill id."),
      idempotencyNonce: z.number().int().positive().describe("Caller-chosen nonce making this request replay-safe."),
      deadlineSecs: z.number().int().positive().max(2_592_000).optional().describe("Seconds until refund deadline (default 86400)."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: { ...writeAnnotations, idempotentHint: true },
    execution: { taskSupport: "optional" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        skillId: WEI,
        idempotencyNonce: z.number().int().positive(),
        deadlineSecs: z.number().int().positive().max(2_592_000).optional(),
      }).parse(args);
      const { tenantId } = getRequestContext();
      const account = svc.account(a.agentId, tenantId);
      const requester = account.address;
      const skillId = BigInt(a.skillId);
      const skill = await svc.readSkill(skillId);
      if (!skill.active) throw new Error(`[KARMA] skill #${skillId} is inactive`);

      // Trust Gate (v2, on-chain authoritative): preflight against the SAME on-chain values the
      // contract's createJob require checks (skill.minReputationToInvoke + agentReputation), so we
      // reject before broadcasting a tx that would revert. The on-chain require is the source of truth;
      // simulate() would also catch it, but this returns a structured reason without a wasted round-trip.
      const requiredReputation = Number(skill.minReputationToInvoke);
      if (requiredReputation > 0) {
        const requesterReputation = await svc.getAgentReputation(requester);
        if (requesterReputation < requiredReputation) {
          return reply(
            `[KARMA] create_job rejected: requester reputation ${requesterReputation} < required ` +
              `${requiredReputation} for skill #${skillId}`,
            {
              status: "rejected",
              reason: "insufficient_reputation",
              skillId,
              requesterReputation,
              requiredReputation,
            },
          );
        }
      }

      const taskHash = svc.deriveTaskHash(requester, skillId, BigInt(a.idempotencyNonce));
      const existing = await svc.findExistingJob(requester, taskHash);
      if (existing != null) {
        return reply(`[KARMA] create_job idempotent: existing job #${existing}`, {
          status: "exists",
          idempotent: true,
          jobId: existing,
        });
      }
      const { jobId, outcome } = await svc.createJob(account, {
        skillId,
        taskHash,
        deadlineSecs: BigInt(a.deadlineSecs ?? 86_400),
        value: skill.pricePerCall,
      });
      if (outcome.status === "pending" || jobId == null) {
        return reply(`[KARMA] create_job broadcast; receipt pending tx=${outcome.hash}`, {
          status: "pending",
          txHash: outcome.hash,
        });
      }
      return reply(`[KARMA] created job #${jobId} tx=${outcome.hash}`, {
        status: "confirmed",
        jobId,
        escrowWei: skill.pricePerCall,
        txHash: outcome.hash,
      });
    },
  };

  const deliverResult: ToolDefinition = {
    name: "deliver_result",
    description: "Provider submits the result hash (bytes32) for an open job.",
    inputSchema: {
      agentId: z.string().describe("Keystore agent id of the provider."),
      jobId: WEI,
      resultHash: RESULT_HASH,
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: WEI, resultHash: RESULT_HASH }).parse(args);
      const { tenantId } = getRequestContext();
      const outcome = await svc.deliverResult(svc.account(a.agentId, tenantId), {
        jobId: BigInt(a.jobId),
        resultHash: a.resultHash as Hash,
      });
      return reply(`[KARMA] deliver_result job #${a.jobId} ${outcome.status} tx=${outcome.hash}`, {
        status: outcome.status,
        jobId: a.jobId,
        txHash: outcome.hash,
      });
    },
  };

  const completeJob: ToolDefinition = {
    name: "complete_job",
    description: "Requester confirms a delivered job, releasing escrow to the provider's withdrawable balance and bumping reputation.",
    inputSchema: { agentId: z.string().describe("Keystore agent id of the requester."), jobId: WEI },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: WEI }).parse(args);
      const { tenantId } = getRequestContext();
      const outcome = await svc.confirmCompletion(svc.account(a.agentId, tenantId), { jobId: BigInt(a.jobId) });
      return reply(`[KARMA] complete_job job #${a.jobId} ${outcome.status} tx=${outcome.hash}`, {
        status: outcome.status,
        jobId: a.jobId,
        txHash: outcome.hash,
      });
    },
  };

  const disputeResult: ToolDefinition = {
    name: "dispute_result",
    description:
      "Requester rejects a delivered result within the review window and reclaims the escrow " +
      "(moves the job to Disputed). Reverts on-chain if the review window has already closed.",
    inputSchema: { agentId: z.string().describe("Keystore agent id of the requester."), jobId: WEI },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: WEI }).parse(args);
      const { tenantId } = getRequestContext();
      const outcome = await svc.disputeResult(svc.account(a.agentId, tenantId), { jobId: BigInt(a.jobId) });
      return reply(`[KARMA] dispute_result job #${a.jobId} ${outcome.status} tx=${outcome.hash}`, {
        status: outcome.status,
        jobId: a.jobId,
        txHash: outcome.hash,
      });
    },
  };

  const claimAfterReview: ToolDefinition = {
    name: "claim_after_review",
    description:
      "Provider claims payment for a delivered job after the review window closes and the requester " +
      "neither confirmed nor disputed (anti-deadlock). Reverts on-chain while the window is still open.",
    inputSchema: { agentId: z.string().describe("Keystore agent id of the provider."), jobId: WEI },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: WEI }).parse(args);
      const { tenantId } = getRequestContext();
      const outcome = await svc.claimAfterReview(svc.account(a.agentId, tenantId), { jobId: BigInt(a.jobId) });
      return reply(`[KARMA] claim_after_review job #${a.jobId} ${outcome.status} tx=${outcome.hash}`, {
        status: outcome.status,
        jobId: a.jobId,
        txHash: outcome.hash,
      });
    },
  };

  const getAgentReputation: ToolDefinition = {
    name: "get_agent_reputation",
    description:
      "Read an agent's registered skills with their reputation scores and invocation counts, plus its " +
      "aggregate agentReputation (max owned-skill reputation) — the value the Trust Gate checks against.",
    inputSchema: { agentId: z.string().optional(), address: z.string().optional() },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string().optional(), address: z.string().optional() }).parse(args);
      const { tenantId } = getRequestContext();
      const address = resolveAddress(svc, a, tenantId);
      const skillIds = await svc.getAgentSkills(address);
      const skills = await Promise.all(
        skillIds.map(async (id) => {
          const s = await svc.readSkill(id);
          return {
            skillId: id,
            name: s.name,
            reputation: Number(s.reputationScore),
            totalInvocations: s.totalInvocations,
            active: s.active,
          };
        }),
      );
      const agentReputation = await svc.getAgentReputation(address); // v2: on-chain (the gate's source of truth)
      return reply(
        `[KARMA] agent ${address} owns ${skills.length} skill(s), reputation ${agentReputation}`,
        { address, agentReputation, skills },
      );
    },
  };

  const querySocialGraph: ToolDefinition = {
    name: "query_social_graph",
    description:
      "Return the job edges for an agent: jobs it provided and jobs it requested. " +
      'format="ids" (default) returns raw job-id arrays — fast, backward-compatible. ' +
      'format="full" hydrates each job into a detail object (amounts, status, timestamps) plus ' +
      "a summary block — use for visualization and reporting.",
    inputSchema: {
      agentId: z.string().optional(),
      address: z.string().optional(),
      format: z.enum(["ids", "full"]).default("ids")
        .describe('"ids" → raw job-id arrays (default). "full" → hydrated job details + summary.'),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string().optional(),
        address: z.string().optional(),
        format: z.enum(["ids", "full"]).default("ids"),
      }).parse(args);
      const { tenantId } = getRequestContext();
      const address = resolveAddress(svc, a, tenantId);

      if (a.format === "full") {
        const result = await handleFullFormat(address, svc);
        return reply(
          `[KARMA] social graph (full) for ${address}: provided ${result.summary.total_jobs_provided}, ` +
            `requested ${result.summary.total_jobs_requested}, reputation ${result.summary.reputation_score}`,
          result as unknown as Record<string, unknown>,
        );
      }

      const [asProvider, asRequester] = await Promise.all([
        svc.getProviderJobs(address),
        svc.getRequesterJobs(address),
      ]);
      return reply(
        `[KARMA] social graph for ${address}: provided ${asProvider.length}, requested ${asRequester.length}`,
        { address, asProvider, asRequester },
      );
    },
  };

  const getPendingBalance: ToolDefinition = {
    name: "get_pending_balance",
    description:
      "Read an agent's withdrawable balance — escrow released by complete_job that is awaiting " +
      "pull-payment. Read-only; accepts an agentId or a raw address.",
    inputSchema: { agentId: z.string().optional(), address: z.string().optional() },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string().optional(), address: z.string().optional() }).parse(args);
      const { tenantId } = getRequestContext();
      const address = resolveAddress(svc, a, tenantId);
      const wei = await svc.getPendingWithdrawal(address);
      return reply(`[KARMA] pending balance for ${address}: ${weiToPhrs6(wei)} PHRS`, {
        address,
        withdrawableWei: wei,
        formattedPHRS: weiToPhrs6(wei),
      });
    },
  };

  const withdrawBalance: ToolDefinition = {
    name: "withdraw_balance",
    description:
      "Withdraw an agent's full released-escrow balance to its wallet (pull-payment). Closes the " +
      "economic loop after complete_job. Reverts on-chain if there is nothing to withdraw.",
    inputSchema: {
      agentId: z.string().describe("Keystore agent id that owns the balance and signs the withdrawal."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string() }).parse(args);
      const { tenantId } = getRequestContext();
      const { amount, outcome } = await svc.withdraw(svc.account(a.agentId, tenantId));
      if (outcome.status === "pending" || amount == null) {
        return reply(`[KARMA] withdraw_balance broadcast; receipt pending tx=${outcome.hash}`, {
          status: "pending",
          txHash: outcome.hash,
        });
      }
      return reply(`[KARMA] withdraw_balance confirmed tx=${outcome.hash}`, {
        status: "confirmed",
        txHash: outcome.hash,
        amountWei: amount,
      });
    },
  };

  return [
    registerSkill,
    discoverSkills,
    createJob,
    deliverResult,
    completeJob,
    disputeResult,
    claimAfterReview,
    getAgentReputation,
    querySocialGraph,
    getPendingBalance,
    withdrawBalance,
  ];
}

const tools: ToolDefinition[] = [karmaHealth, ...createKarmaTools(realKarmaService)];
export default tools;
