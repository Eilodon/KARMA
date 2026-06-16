import { z } from "zod/v4";
import type { Address, Hash } from "viem";
import type { ToolDefinition, ToolResult } from "../mcp/adapter/tool_registry.js";
import { jsonSafe } from "../lib/serialize.js";
import { realKarmaService, type KarmaService } from "../lib/karma_service.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";

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
    return reply(
      `[KARMA] health: in-process=true rpcEnv=${hasRpcEnv} contractEnv=${hasContractEnv}` + (ping ? ` ping=${ping}` : ""),
      { inProcess: true, hasRpcEnv, hasContractEnv },
    );
  },
};

/** Resolve a target address from either an agentId (keystore) or a raw address. */
function resolveAddress(svc: KarmaService, a: { agentId?: string; address?: string }): Address {
  if (a.agentId) return svc.addressOf(a.agentId);
  if (a.address) return a.address as Address;
  throw new Error("[KARMA] provide either agentId or address");
}

export function createKarmaTools(svc: KarmaService): ToolDefinition[] {
  const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  const registerSkill: ToolDefinition = {
    name: "register_skill",
    description: "Register a callable skill on-chain (name, description, MCP endpoint, price per call in wei) and index it for discovery.",
    inputSchema: {
      agentId: z.string().describe("Keystore agent id that owns/signs for this skill."),
      name: z.string().min(1),
      description: z.string().default(""),
      mcpEndpoint: z.string().default(""),
      pricePerCallWei: WEI.describe("Price per call in wei, as a base-10 string."),
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
      }).parse(args);
      const account = svc.account(a.agentId);
      const { skillId, outcome } = await svc.registerSkill(account, {
        name: a.name,
        description: a.description,
        mcpEndpoint: a.mcpEndpoint,
        pricePerCall: BigInt(a.pricePerCallWei),
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
      });
      return reply(`[KARMA] registered skill #${skillId} tx=${outcome.hash}`, {
        status: "confirmed",
        skillId,
        txHash: outcome.hash,
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
      const account = svc.account(a.agentId);
      const requester = account.address;
      const skillId = BigInt(a.skillId);
      const skill = await svc.readSkill(skillId);
      if (!skill.active) throw new Error(`[KARMA] skill #${skillId} is inactive`);
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
      const outcome = await svc.deliverResult(svc.account(a.agentId), {
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
      const outcome = await svc.confirmCompletion(svc.account(a.agentId), { jobId: BigInt(a.jobId) });
      return reply(`[KARMA] complete_job job #${a.jobId} ${outcome.status} tx=${outcome.hash}`, {
        status: outcome.status,
        jobId: a.jobId,
        txHash: outcome.hash,
      });
    },
  };

  const getAgentReputation: ToolDefinition = {
    name: "get_agent_reputation",
    description: "Read an agent's registered skills with their reputation scores and invocation counts.",
    inputSchema: { agentId: z.string().optional(), address: z.string().optional() },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string().optional(), address: z.string().optional() }).parse(args);
      const address = resolveAddress(svc, a);
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
      return reply(`[KARMA] agent ${address} owns ${skills.length} skill(s)`, { address, skills });
    },
  };

  const querySocialGraph: ToolDefinition = {
    name: "query_social_graph",
    description: "Return the job edges for an agent: jobs it provided and jobs it requested.",
    inputSchema: { agentId: z.string().optional(), address: z.string().optional() },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string().optional(), address: z.string().optional() }).parse(args);
      const address = resolveAddress(svc, a);
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

  return [
    registerSkill,
    discoverSkills,
    createJob,
    deliverResult,
    completeJob,
    getAgentReputation,
    querySocialGraph,
  ];
}

const tools: ToolDefinition[] = [karmaHealth, ...createKarmaTools(realKarmaService)];
export default tools;
