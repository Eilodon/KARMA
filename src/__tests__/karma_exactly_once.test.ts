import { describe, it, expect } from "vitest";
import { deriveTaskHash } from "../lib/contract.js";

const REQ = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" as const;

// Failure-Mode-1: createJob has no on-chain idempotency key, so a lost-ack retry would
// double-escrow. We derive a deterministic taskHash from the idempotency nonce and use it
// as the dedup key, then check-before-write by checking the on-chain jobByTaskHash mapping.

describe("P4.2b exactly-once guard", () => {
  it("derives a deterministic 32-byte task hash from (requester, skillId, nonce)", () => {
    const a = deriveTaskHash(REQ, 1n, 7n);
    const b = deriveTaskHash(REQ, 1n, 7n);
    const c = deriveTaskHash(REQ, 1n, 8n);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).toBe(b); // same inputs → same key (retry-safe)
    expect(a).not.toBe(c); // different nonce → different key
  });
});
