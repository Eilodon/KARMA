import { describe, it, expect, vi } from "vitest";
import { deriveTaskHash, findJobByTaskHash } from "../lib/contract.js";

const REQ = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" as const;
const ZERO32 = `0x${"00".repeat(32)}` as const;

// Failure-Mode-1: createJob has no on-chain idempotency key, so a lost-ack retry would
// double-escrow. We derive a deterministic taskHash from the idempotency nonce and use it
// as the dedup key, then check-before-write by scanning the requester's existing jobs.

describe("P4.2b exactly-once guard", () => {
  it("derives a deterministic 32-byte task hash from (requester, skillId, nonce)", () => {
    const a = deriveTaskHash(REQ, 1n, 7n);
    const b = deriveTaskHash(REQ, 1n, 7n);
    const c = deriveTaskHash(REQ, 1n, 8n);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).toBe(b); // same inputs → same key (retry-safe)
    expect(a).not.toBe(c); // different nonce → different key
  });

  it("returns the existing jobId when a job already carries that task hash (no double-escrow)", async () => {
    const taskHash = deriveTaskHash(REQ, 1n, 7n);
    const reader = {
      getRequesterJobs: vi.fn().mockResolvedValue([3n, 5n] as const),
      getJobTaskHash: vi.fn(async (id: bigint) => (id === 5n ? taskHash : ZERO32)),
    };
    const found = await findJobByTaskHash(REQ, taskHash, reader);
    expect(found).toBe(5n);
    expect(reader.getRequesterJobs).toHaveBeenCalledWith(REQ);
  });

  it("returns null when no existing job matches (a fresh createJob may proceed)", async () => {
    const taskHash = deriveTaskHash(REQ, 2n, 9n);
    const reader = {
      getRequesterJobs: vi.fn().mockResolvedValue([3n] as const),
      getJobTaskHash: vi.fn().mockResolvedValue(`0x${"11".repeat(32)}` as const),
    };
    expect(await findJobByTaskHash(REQ, taskHash, reader)).toBeNull();
  });
});
