/* eslint-disable @typescript-eslint/unbound-method -- svc.* are vi.fn() mocks; `this` binding is irrelevant */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createKarmaTools } from "../plugins/karma.tool.js";
import type { KarmaService, OnchainSkill } from "../lib/karma_service.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";

const ALPHA = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" as const;
const TXH = "0xabc123" as const;

const confirmed = { status: "confirmed" as const, hash: TXH, receipt: {} as never };

const skill = (over: Partial<OnchainSkill> = {}): OnchainSkill => ({
  owner: ALPHA,
  name: "discover_skills",
  description: "semantic skill discovery",
  mcpEndpoint: "http://localhost/mcp",
  pricePerCall: 1000n,
  reputationScore: 55n,
  totalInvocations: 3n,
  active: true,
  registeredAt: 1n,
  ...over,
});

function fakeService(over: Partial<KarmaService> = {}): KarmaService {
  return {
    account: vi.fn(() => ({ address: ALPHA }) as never),
    addressOf: vi.fn(() => ALPHA),
    registerSkill: vi.fn(async () => ({ skillId: 7n, outcome: confirmed })),
    readSkill: vi.fn(async () => skill()),
    readJob: vi.fn(async () => ({
      requester: ALPHA, provider: ALPHA, skillId: 1n, taskHash: `0x${"00".repeat(32)}`,
      escrowAmount: 0n, deadline: 0n, status: 0, resultHash: `0x${"00".repeat(32)}`,
      createdAt: 1750145678n, completedAt: 0n,
    }) as never),
    deriveTaskHash: vi.fn(() => `0x${"de".repeat(32)}` as `0x${string}`),
    findExistingJob: vi.fn(async () => null),
    createJob: vi.fn(async () => ({ jobId: 4n, outcome: confirmed })),
    deliverResult: vi.fn(async () => confirmed),
    confirmCompletion: vi.fn(async () => confirmed),
    getAgentSkills: vi.fn(async () => [7n]),
    getProviderJobs: vi.fn(async () => [4n, 9n]),
    getRequesterJobs: vi.fn(async () => [2n]),
    getPendingWithdrawal: vi.fn(async () => 100_000_000_000_000n),
    withdraw: vi.fn(async () => ({ amount: 100_000_000_000_000n, outcome: confirmed })),
    indexUpsert: vi.fn(),
    indexDiscard: vi.fn(),
    getByOwner: vi.fn(() => null),
    search: vi.fn(() => [
      {
        skill_id: 7,
        name: "discover_skills",
        description: "semantic skill discovery",
        mcp_endpoint: "http://localhost/mcp",
        price_per_call_wei: "1000",
        reputation_score: 55,
        owner_address: ALPHA,
        score: 1.23,
      },
    ]),
    ...over,
  };
}

const hasBigInt = (v: unknown): boolean =>
  typeof v === "bigint" ||
  (Array.isArray(v) && v.some(hasBigInt)) ||
  (v !== null && typeof v === "object" && Object.values(v).some(hasBigInt));

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}
const call = (t: ToolDefinition, args: unknown) => t.handler(args, {} as never);

describe("P6 KARMA tools", () => {
  let tools: ToolDefinition[];
  let svc: KarmaService;
  beforeEach(() => {
    markTrustedRuntime(); // these unit tests run in-process; declare trust for the canary
    svc = fakeService();
    tools = createKarmaTools(svc);
  });

  it("exposes the 9 economy tools, all network-capable with no required scopes (D-2)", () => {
    const names = tools.map((t) => t.name);
    for (const n of [
      "register_skill",
      "discover_skills",
      "create_job",
      "deliver_result",
      "complete_job",
      "get_agent_reputation",
      "query_social_graph",
      "get_pending_balance",
      "withdraw_balance",
    ]) {
      expect(names).toContain(n);
      const t = tool(tools, n);
      expect(t.capabilities).toContain("network");
      expect(t.requiredScopes).toBeUndefined();
    }
    expect(tool(tools, "create_job").execution.taskSupport).toBe("optional");
  });

  it("register_skill: on confirm returns stringified skillId and upserts the index", async () => {
    const res = await call(tool(tools, "register_skill"), {
      agentId: "agent-alpha",
      name: "discover_skills",
      description: "semantic discovery",
      mcpEndpoint: "http://localhost/mcp",
      pricePerCallWei: "1000",
    });
    expect((res.structuredContent as { skillId: unknown }).skillId).toBe("7");
    expect(hasBigInt(res.structuredContent)).toBe(false);
    expect(svc.indexUpsert).toHaveBeenCalledTimes(1);
    expect((svc.indexUpsert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      skill_id: 7,
      price_per_call_wei: "1000",
      active: true,
    });
  });

  it("register_skill: on pending tx does NOT upsert the index", async () => {
    svc = fakeService({ registerSkill: vi.fn(async () => ({ skillId: null, outcome: { status: "pending" as const, hash: TXH } })) });
    tools = createKarmaTools(svc);
    const res = await call(tool(tools, "register_skill"), {
      agentId: "agent-alpha",
      name: "x",
      description: "",
      mcpEndpoint: "http://x",
      pricePerCallWei: "1",
    });
    expect((res.structuredContent as { status: string }).status).toBe("pending");
    expect(svc.indexUpsert).not.toHaveBeenCalled();
  });

  it("discover_skills: returns hits with string prices and no bigint", async () => {
    const res = await call(tool(tools, "discover_skills"), { query: "discovery", maxPriceWei: "5000", minReputation: 10 });
    const sc = res.structuredContent as { skills: Array<{ price_per_call_wei: unknown }> };
    expect(typeof sc.skills[0].price_per_call_wei).toBe("string");
    expect(hasBigInt(res.structuredContent)).toBe(false);
    expect(svc.search).toHaveBeenCalledWith("discovery", expect.objectContaining({ maxPriceWei: 5000n, minReputation: 10 }));
  });

  it("create_job: idempotent hit short-circuits without a second escrow (Failure-Mode-1)", async () => {
    svc = fakeService({ findExistingJob: vi.fn(async () => 4n) });
    tools = createKarmaTools(svc);
    const res = await call(tool(tools, "create_job"), { agentId: "agent-beta", skillId: "7", idempotencyNonce: 42 });
    expect(res.structuredContent).toMatchObject({ jobId: "4", idempotent: true });
    expect(svc.createJob).not.toHaveBeenCalled();
  });

  it("create_job: new job escrows the skill price and stringifies amounts (D-6)", async () => {
    const res = await call(tool(tools, "create_job"), { agentId: "agent-beta", skillId: "7", idempotencyNonce: 1 });
    expect(svc.createJob).toHaveBeenCalledTimes(1);
    expect((svc.createJob as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ value: 1000n });
    const sc = res.structuredContent as { jobId: unknown; escrowWei: unknown };
    expect(sc.jobId).toBe("4");
    expect(sc.escrowWei).toBe("1000");
    expect(hasBigInt(res.structuredContent)).toBe(false);
    // wei must not be dumped raw into the human text
    expect(res.content[0].text).not.toMatch(/1000/);
  });

  it("deliver_result + complete_job: return tx hash and never leak bigint", async () => {
    const dr = await call(tool(tools, "deliver_result"), {
      agentId: "agent-alpha",
      jobId: "4",
      resultHash: `0x${"11".repeat(32)}`,
    });
    expect((dr.structuredContent as { txHash: string }).txHash).toBe(TXH);
    const cj = await call(tool(tools, "complete_job"), { agentId: "agent-beta", jobId: "4" });
    expect((cj.structuredContent as { txHash: string }).txHash).toBe(TXH);
    expect(svc.confirmCompletion).toHaveBeenCalled();
  });

  it("get_agent_reputation: stringifies totalInvocations + skillId (D-6)", async () => {
    const res = await call(tool(tools, "get_agent_reputation"), { agentId: "agent-alpha" });
    const sc = res.structuredContent as { skills: Array<{ skillId: unknown; totalInvocations: unknown; reputation: number }> };
    expect(sc.skills[0].skillId).toBe("7");
    expect(sc.skills[0].totalInvocations).toBe("3");
    expect(sc.skills[0].reputation).toBe(55);
    expect(hasBigInt(res.structuredContent)).toBe(false);
  });

  it("query_social_graph: returns stringified job-id edges", async () => {
    const res = await call(tool(tools, "query_social_graph"), { address: ALPHA });
    expect(res.structuredContent).toMatchObject({ asProvider: ["4", "9"], asRequester: ["2"] });
    expect(hasBigInt(res.structuredContent)).toBe(false);
  });

  it('query_social_graph format:"full": hydrates JobDetail edges + summary, no bigint', async () => {
    const BETA = "0xB2c3d4E5f6a7b8C9d0e1F2a3b4C5d6E7f8a9B0c1" as const;
    const GAMMA = "0xC3d4e5F6a7b8c9D0e1f2A3b4c5D6e7f8A9b0C1d2" as const;
    const completedHash = `0x${"ab".repeat(32)}` as `0x${string}`;
    const job = (over: Record<string, unknown>) => ({
      requester: ALPHA, provider: ALPHA, skillId: 1n, taskHash: `0x${"00".repeat(32)}`,
      escrowAmount: 0n, deadline: 0n, status: 0, resultHash: `0x${"00".repeat(32)}`,
      createdAt: 1750145678n, completedAt: 0n, ...over,
    });
    svc = fakeService({
      // ALPHA provided jobs 4 & 9 (counterpart = requester), requested job 2 (counterpart = provider)
      getProviderJobs: vi.fn(async () => [4n, 9n]),
      getRequesterJobs: vi.fn(async () => [2n]),
      readJob: vi.fn(async (id: bigint) => {
        if (id === 4n) return job({ requester: BETA, escrowAmount: 100_000_000_000_000n, status: 2, resultHash: completedHash }) as never;
        if (id === 9n) return job({ requester: BETA, escrowAmount: 50_000_000_000_000n, status: 0 }) as never;
        return job({ provider: GAMMA, escrowAmount: 30_000_000_000_000n, status: 0 }) as never; // job 2
      }),
      getByOwner: vi.fn(() => ({
        id: 1, skill_id: 1, name: "x", description: "", mcp_endpoint: "",
        price_per_call_wei: "1", reputation_score: 55, owner_address: ALPHA, active: true,
      })),
    });
    tools = createKarmaTools(svc);

    const res = await call(tool(tools, "query_social_graph"), { address: ALPHA, format: "full" });
    const sc = res.structuredContent as {
      focal_agent: string;
      as_provider: Array<{ job_id: string; counterpart: string; status: string; escrow_amount_phrs: string; result_hash: string | null }>;
      as_requester: Array<{ counterpart: string; status: string }>;
      summary: { total_jobs_provided: number; total_jobs_requested: number; total_earned_phrs: string; total_spent_phrs: string; unique_partners: number; reputation_score: number };
    };

    expect(sc.focal_agent).toBe(ALPHA);
    // provider edge job 4: completed, counterpart = requester (BETA), escrow 1e14 wei = 0.000100 PHRS
    const j4 = sc.as_provider.find((j) => j.job_id === "4");
    expect(j4?.status).toBe("Completed");
    expect(j4?.counterpart).toBe(BETA);
    expect(j4?.escrow_amount_phrs).toMatch(/^\d+\.\d{6}$/);
    expect(j4?.escrow_amount_phrs).toBe("0.000100");
    expect(j4?.result_hash).toBe(completedHash);
    // open job 9 has the all-zero result hash → null
    expect(sc.as_provider.find((j) => j.job_id === "9")?.result_hash).toBeNull();
    // requester edge job 2: counterpart = provider (GAMMA)
    expect(sc.as_requester[0].counterpart).toBe(GAMMA);
    // summary: only completed provider job 4 counts toward earnings; all requester jobs toward spend
    expect(sc.summary.total_jobs_provided).toBe(2);
    expect(sc.summary.total_jobs_requested).toBe(1);
    expect(sc.summary.total_earned_phrs).toBe("0.000100");
    expect(sc.summary.total_spent_phrs).toBe("0.000030");
    expect(sc.summary.unique_partners).toBe(2); // BETA + GAMMA
    expect(sc.summary.reputation_score).toBe(55);
    expect(hasBigInt(res.structuredContent)).toBe(false);
  });

  it('query_social_graph format:"full": reputation falls back to 50 when owner has no indexed skill', async () => {
    const res = await call(tool(tools, "query_social_graph"), { address: ALPHA, format: "full" });
    expect((res.structuredContent as { summary: { reputation_score: number } }).summary.reputation_score).toBe(50);
  });

  it("get_pending_balance: returns stringified wei + formatted PHRS, no bigint, no keystore", async () => {
    const res = await call(tool(tools, "get_pending_balance"), { address: ALPHA });
    const sc = res.structuredContent as { address: string; withdrawableWei: unknown; formattedPHRS: string };
    expect(sc.address).toBe(ALPHA);
    expect(sc.withdrawableWei).toBe("100000000000000"); // string, not bigint (D-6)
    expect(sc.formattedPHRS).toBe("0.000100");
    expect(hasBigInt(res.structuredContent)).toBe(false);
    expect(svc.account).not.toHaveBeenCalled(); // read-only: no signing account resolved
  });

  it("withdraw_balance: on confirm returns tx hash + amountWei decoded from the Withdrawn event", async () => {
    const res = await call(tool(tools, "withdraw_balance"), { agentId: "agent-alpha" });
    const sc = res.structuredContent as { status: string; txHash: string; amountWei: unknown };
    expect(sc.status).toBe("confirmed");
    expect(sc.txHash).toBe(TXH);
    expect(sc.amountWei).toBe("100000000000000");
    expect(hasBigInt(res.structuredContent)).toBe(false);
    expect(svc.withdraw).toHaveBeenCalledTimes(1);
  });

  it("withdraw_balance: pending tx (no decodable amount) surfaces status=pending without amountWei", async () => {
    svc = fakeService({ withdraw: vi.fn(async () => ({ amount: null, outcome: { status: "pending" as const, hash: TXH } })) });
    tools = createKarmaTools(svc);
    const res = await call(tool(tools, "withdraw_balance"), { agentId: "agent-alpha" });
    const sc = res.structuredContent as { status: string; txHash: string; amountWei?: unknown };
    expect(sc.status).toBe("pending");
    expect(sc.txHash).toBe(TXH);
    expect(sc.amountWei).toBeUndefined();
  });
});
