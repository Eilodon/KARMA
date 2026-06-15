import { describe, it, expect, vi } from "vitest";
import { WaitForTransactionReceiptTimeoutError } from "viem";
import { runBoundedWrite } from "../lib/contract.js";

// The bounded-write policy: simulate → write (broadcast ONCE) → wait for receipt with a
// timeout. If the wait times out, return a typed `pending` (the tx is already on the wire)
// — the caller must NOT resend, or it double-spends (lock-vs-latency, Abductive-1).

describe("P4.2a runBoundedWrite", () => {
  it("returns confirmed with the receipt when the wait resolves", async () => {
    const write = vi.fn().mockResolvedValue("0xabc");
    const out = await runBoundedWrite(
      {
        simulate: async () => ({ request: { fn: "x" } }),
        write,
        waitReceipt: async () => ({ status: "success", transactionHash: "0xabc" }) as never,
      },
      1000,
    );
    expect(out.status).toBe("confirmed");
    expect(out.hash).toBe("0xabc");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("returns pending (and never resends) when the receipt wait times out", async () => {
    const write = vi.fn().mockResolvedValue("0xabc");
    const out = await runBoundedWrite(
      {
        simulate: async () => ({ request: {} }),
        write,
        waitReceipt: async () => {
          throw new WaitForTransactionReceiptTimeoutError({ hash: "0xabc" });
        },
      },
      50,
    );
    expect(out.status).toBe("pending");
    expect(out.hash).toBe("0xabc");
    expect(write).toHaveBeenCalledTimes(1); // critical invariant: broadcast exactly once
  });

  it("rethrows non-timeout errors (e.g. revert) instead of masking them as pending", async () => {
    await expect(
      runBoundedWrite(
        {
          simulate: async () => ({ request: {} }),
          write: async () => "0xabc",
          waitReceipt: async () => {
            throw new Error("execution reverted: escrow must equal price");
          },
        },
        50,
      ),
    ).rejects.toThrow(/reverted/);
  });
});
