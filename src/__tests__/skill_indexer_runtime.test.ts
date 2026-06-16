/* eslint-disable @typescript-eslint/unbound-method -- svc.* are vi.fn() mocks; `this` binding is irrelevant */
import { describe, it, expect, vi } from "vitest";
import {
  applyIndexedEvent,
  skillDocFromChain,
  getKarmaIndexerHealth,
} from "../lib/skill_indexer_runtime.js";
import type { KarmaService, OnchainSkill, OnchainJob } from "../lib/karma_service.js";
import type { IndexedEvent } from "../lib/contract.js";

const ALPHA = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" as const;
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
      readJob: vi.fn(async () => job({ skillId: 42n })),
      readSkill: vi.fn(async () => skill({ reputationScore: 65n })),
    });
    await applyIndexedEvent(svc, { type: "JobCompleted", blockNumber: 12n, jobId: 3n, provider: ALPHA, payout: 1000n, newReputation: 65n });
    expect(svc.readJob).toHaveBeenCalledWith(3n);
    expect(svc.readSkill).toHaveBeenCalledWith(42n); // skillId came from the job, not the event
    expect((svc.indexUpsert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ skill_id: 42, reputation_score: 65 });
  });

  it("getKarmaIndexerHealth reports started=false when the indexer was never wired", () => {
    expect(getKarmaIndexerHealth()).toEqual({ started: false });
  });
});
