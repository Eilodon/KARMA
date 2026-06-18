/* eslint-disable @typescript-eslint/unbound-method -- svc.* are vi.fn() mocks; `this` binding is irrelevant */
import { describe, it, expect, vi } from "vitest";
import {
  applyIndexedEvent,
  applyWithRetry,
  skillDocFromChain,
  getKarmaIndexerHealth,
  makeFlowHybridBoost,
} from "../lib/skill_indexer_runtime.js";
import type { KarmaService, OnchainSkill, OnchainJob } from "../lib/karma_service.js";
import type { IndexedEvent } from "../lib/contract.js";

const ALPHA = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" as const;
const BETA = "0x1111111111111111111111111111111111111111" as const;
const ZERO32 = `0x${"00".repeat(32)}` as `0x${string}`;

const skill = (over: Partial<OnchainSkill> = {}): OnchainSkill => ({
  owner: ALPHA,
  name: "discover_skills",
  description: "semantic discovery",
  mcpEndpoint: "inproc://x",
  pricePerCall: 1000n,
  reputationScore: 55n,
  totalInvocations: 3n,
  active: true,
  registeredAt: 1n,
  minReputationToInvoke: 0n,
  ...over,
});

const job = (over: Partial<OnchainJob> = {}): OnchainJob => ({
  requester: ALPHA,
  provider: ALPHA,
  skillId: 7n,
  taskHash: ZERO32,
  escrowAmount: 1000n,
  deadline: 0n,
  status: 2,
  resultHash: ZERO32,
  createdAt: 1n,
  completedAt: 2n,
  ...over,
});

/** Minimal fake exposing only the seam applyIndexedEvent touches. */
function fakeService(over: Partial<KarmaService> = {}): KarmaService {
  return {
    readSkill: vi.fn(async () => skill()),
    readJob: vi.fn(async () => job()),
    indexUpsert: vi.fn(),
    indexDiscard: vi.fn(),
    ...over,
  } as unknown as KarmaService;
}

describe("skill_indexer_runtime", () => {
  it("skillDocFromChain maps on-chain skill to a D-6-safe BM25 document", () => {
    const doc = skillDocFromChain(7n, skill({ pricePerCall: 100_000_000_000_000n, reputationScore: 60n }));
    expect(doc).toMatchObject({
      id: 7,
      skill_id: 7,
      name: "discover_skills",
      mcp_endpoint: "inproc://x",
      price_per_call_wei: "100000000000000", // string, not bigint
      reputation_score: 60,
      owner_address: ALPHA,
      active: true,
    });
    expect(typeof doc.price_per_call_wei).toBe("string");
  });

  it("SkillRegistered → hydrates via readSkill and upserts the full document", async () => {
    const svc = fakeService({ readSkill: vi.fn(async () => skill({ name: "hydrated" })) });
    const e: IndexedEvent = { type: "SkillRegistered", blockNumber: 10n, skillId: 7n, owner: ALPHA, name: "evt-name", pricePerCall: 1000n };
    await applyIndexedEvent(svc, e);
    expect(svc.readSkill).toHaveBeenCalledWith(7n);
    expect(svc.indexUpsert).toHaveBeenCalledTimes(1);
    // upserted doc comes from on-chain readSkill (full), not the event's thin payload
    expect((svc.indexUpsert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ skill_id: 7, name: "hydrated" });
    expect(svc.indexDiscard).not.toHaveBeenCalled();
  });

  it("SkillDeactivated → discards the skill from the index, no chain reads", async () => {
    const svc = fakeService();
    await applyIndexedEvent(svc, { type: "SkillDeactivated", blockNumber: 11n, skillId: 7n });
    expect(svc.indexDiscard).toHaveBeenCalledWith(7);
    expect(svc.readSkill).not.toHaveBeenCalled();
    expect(svc.indexUpsert).not.toHaveBeenCalled();
  });

  it("JobCompleted → resolves jobId→skillId (event lacks it) and re-hydrates that skill's reputation", async () => {
    const svc = fakeService({
      readJob: vi.fn(async () => job({ skillId: 42n, requester: BETA, provider: ALPHA })),
      readSkill: vi.fn(async () => skill({ reputationScore: 65n })),
    });
    await applyIndexedEvent(svc, { type: "JobCompleted", blockNumber: 12n, jobId: 3n, provider: ALPHA, payout: 1000n, newReputation: 65n });
    expect(svc.readJob).toHaveBeenCalledWith(3n);
    expect(svc.readSkill).toHaveBeenCalledWith(42n); // skillId came from the job, not the event
    expect((svc.indexUpsert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ skill_id: 42, reputation_score: 65 });
  });

  it("JobCompleted → records the arm's-length endorsement edge into the flow graph (Tier-1)", async () => {
    const svc = fakeService({
      readJob: vi.fn(async () => job({ requester: BETA, provider: ALPHA, escrowAmount: 5n, completedAt: 99n, skillId: 42n })),
    });
    const flow = { record: vi.fn(), setBondSeed: vi.fn() };
    await applyIndexedEvent(
      svc,
      { type: "JobCompleted", blockNumber: 12n, jobId: 3n, provider: ALPHA, payout: 5n, newReputation: 60n },
      flow,
    );
    // requester paid provider → an endorsement edge from→to, value + completedAt carried through
    expect(flow.record).toHaveBeenCalledWith({ from: BETA, to: ALPHA, valueWei: 5n, timestamp: 99 });
  });

  it("JobCompleted → does NOT record a self-deal edge (requester === provider)", async () => {
    const svc = fakeService({ readJob: vi.fn(async () => job({ requester: ALPHA, provider: ALPHA })) });
    const flow = { record: vi.fn(), setBondSeed: vi.fn() };
    await applyIndexedEvent(
      svc,
      { type: "JobCompleted", blockNumber: 12n, jobId: 3n, provider: ALPHA, payout: 1000n, newReputation: 55n },
      flow,
    );
    expect(flow.record).not.toHaveBeenCalled(); // self-deal carries no external trust
  });

  it("BondUpdated → mirrors seed-eligible bond into the flow seed (Tier-2), no chain reads", async () => {
    const svc = fakeService();
    const flow = { record: vi.fn(), setBondSeed: vi.fn() };
    await applyIndexedEvent(
      svc,
      { type: "BondUpdated", blockNumber: 20n, agent: BETA, bondedAmount: 5n, seedEligible: 5n },
      flow,
    );
    expect(flow.setBondSeed).toHaveBeenCalledWith(BETA, 5n);
    expect(svc.readSkill).not.toHaveBeenCalled(); // bonds don't touch the BM25 doc
    expect(svc.indexUpsert).not.toHaveBeenCalled();
  });

  it("BondUpdated with seedEligible=0 (cooling down / withdrawn) clears the seed", async () => {
    const flow = { record: vi.fn(), setBondSeed: vi.fn() };
    await applyIndexedEvent(
      fakeService(),
      { type: "BondUpdated", blockNumber: 21n, agent: BETA, bondedAmount: 5n, seedEligible: 0n },
      flow,
    );
    expect(flow.setBondSeed).toHaveBeenCalledWith(BETA, 0n);
  });

  // H1: event carries authoritative newReputation — RPC stale read must not win
  it("JobCompleted → uses newReputation from event, not stale RPC reputationScore", async () => {
    const svc = fakeService({
      readJob: vi.fn(async () => job({ skillId: 42n, requester: BETA, provider: ALPHA })),
      readSkill: vi.fn(async () => skill({ reputationScore: 50n })), // stale: RPC one block behind
    });
    await applyIndexedEvent(svc, {
      type: "JobCompleted", blockNumber: 12n, jobId: 3n, provider: ALPHA,
      payout: 1000n, newReputation: 75n, // event = authoritative post-completion value
    });
    expect((svc.indexUpsert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      skill_id: 42, reputation_score: 75, // must use 75, not 50
    });
  });

  // H1: self-deal → no readSkill RPC, no indexUpsert (on-chain didn't change reputation)
  it("JobCompleted self-deal → skips readSkill RPC and indexUpsert (no state changed)", async () => {
    const svc = fakeService({
      readJob: vi.fn(async () => job({ requester: ALPHA, provider: ALPHA, skillId: 42n })),
    });
    await applyIndexedEvent(svc, {
      type: "JobCompleted", blockNumber: 12n, jobId: 3n, provider: ALPHA,
      payout: 0n, newReputation: 55n,
    });
    expect(svc.readSkill).not.toHaveBeenCalled();
    expect(svc.indexUpsert).not.toHaveBeenCalled();
  });

  // H2: MinReputationSet event updates the BM25 in-memory threshold without RPC
  it("MinReputationSet → calls indexSetMinReputation with skillId + threshold, no chain reads", async () => {
    const svc = fakeService({ indexSetMinReputation: vi.fn() } as Partial<KarmaService>);
    await applyIndexedEvent(svc, {
      type: "MinReputationSet", blockNumber: 30n, skillId: 7n, minReputation: 60n,
    });
    expect((svc as any).indexSetMinReputation).toHaveBeenCalledWith(7, 60);
    expect(svc.readSkill).not.toHaveBeenCalled();
    expect(svc.indexUpsert).not.toHaveBeenCalled();
  });

  // M3: hybrid boost gives new agents the legacy floor so they aren't penalised for no flow history
  describe("makeFlowHybridBoost", () => {
    const docRep50 = skillDocFromChain(7n, skill({ reputationScore: 50n }));

    it("returns legacy floor (1.5) when flow score is below it (new agent, no edges)", () => {
      const flowSrc = { boostFor: () => 1.0 }; // no flow edges → neutral
      expect(makeFlowHybridBoost(flowSrc)(docRep50)).toBeCloseTo(1.5);
    });

    it("returns flow score when it exceeds legacy (established agent)", () => {
      const flowSrc = { boostFor: () => 1.9 }; // high propagated trust
      expect(makeFlowHybridBoost(flowSrc)(docRep50)).toBeCloseTo(1.9);
    });

    it("uses the doc's owner_address when querying the flow source", () => {
      const flowSrc = { boostFor: vi.fn(() => 1.0) };
      makeFlowHybridBoost(flowSrc)(docRep50);
      expect(flowSrc.boostFor).toHaveBeenCalledWith(ALPHA);
    });
  });

  it("getKarmaIndexerHealth reports started=false when the indexer was never wired", () => {
    expect(getKarmaIndexerHealth()).toEqual({ started: false });
  });
});

// applyWithRetry: transient-RPC retry + exhaustion behaviour
describe("applyWithRetry", () => {
  const regEvent: IndexedEvent = {
    type: "SkillRegistered", blockNumber: 1n, skillId: 1n, owner: ALPHA, name: "x", pricePerCall: 1000n,
  };

  it("succeeds on first attempt with no retries needed", async () => {
    const svc = fakeService({ readSkill: vi.fn(async () => skill()) });
    await expect(applyWithRetry(svc, regEvent, undefined, 2, 0)).resolves.toBeUndefined();
    expect(svc.readSkill).toHaveBeenCalledTimes(1);
  });

  it("retries on transient RPC failure and succeeds on 2nd attempt", async () => {
    const svc = fakeService({
      readSkill: vi.fn()
        .mockRejectedValueOnce(new Error("RPC timeout"))
        .mockResolvedValue(skill()),
    });
    await expect(applyWithRetry(svc, regEvent, undefined, 2, 0)).resolves.toBeUndefined();
    expect(svc.readSkill).toHaveBeenCalledTimes(2); // 1 fail + 1 success
  });

  it("throws after maxRetries exhausted (3 total attempts for maxRetries=2)", async () => {
    const rpcErr = new Error("persistent RPC down");
    const svc = fakeService({ readSkill: vi.fn().mockRejectedValue(rpcErr) });
    await expect(applyWithRetry(svc, regEvent, undefined, 2, 0)).rejects.toThrow("persistent RPC down");
    expect(svc.readSkill).toHaveBeenCalledTimes(3); // attempt 0 + 2 retries
  });
});
