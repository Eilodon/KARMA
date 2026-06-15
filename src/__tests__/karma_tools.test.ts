/* eslint-disable @typescript-eslint/unbound-method -- svc.* are vi.fn() mocks; `this` binding is irrelevant */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createKarmaTools } from "../plugins/karma.tool.js";
import type { KarmaService, OnchainSkill } from "../lib/karma_service.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

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
    readJob: vi.fn(async () => ({ provider: ALPHA }) as never),
    deriveTaskHash: vi.fn(() => `0x${"de".repeat(32)}` as `0x${string}`),
    findExistingJob: vi.fn(async () => null),
    createJob: vi.fn(async () => ({ jobId: 4n, outcome: confirmed })),
    deliverResult: vi.fn(async () => confirmed),
    confirmCompletion: vi.fn(async () => confirmed),
    getAgentSkills: vi.fn(async () => [7n]),
    getProviderJobs: vi.fn(async () => [4n, 9n]),
    getRequesterJobs: vi.fn(async () => [2n]),
    indexUpsert: vi.fn(),
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
    svc = fakeService();
    tools = createKarmaTools(svc);
  });

  it("exposes the 7 economy tools, all network-capable with no required scopes (D-2)", () => {
    const names = tools.map((t) => t.name);
    for (const n of [
      "register_skill",
      "discover_skills",
      "create_job",
      "deliver_result",
      "complete_job",
      "get_agent_reputation",
      "query_social_graph",
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
});
