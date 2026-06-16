import { describe, it, expect } from "vitest";
import { toClientError } from "../mcp/adapter/execution_pipeline.js";

describe("toClientError (A2 error chokepoint)", () => {
  it("redacts secrets in the message but preserves name + numeric code", () => {
    const raw = new Error("viem fail 0x" + "b".repeat(64) + " sk-abcdefghijklmnopqrstuvwxyz123456");
    raw.name = "ContractFunctionExecutionError";
    (raw as { code?: number }).code = -32000;

    const safe = toClientError(raw);

    expect(safe.message).not.toContain("b".repeat(64));
    expect(safe.message).not.toMatch(/sk-abcdefghijklmnopqrstuvwxyz123456/);
    expect(safe.message).toContain("[REDACTED:HEX32]");
    expect(safe.name).toBe("ContractFunctionExecutionError");
    expect((safe as { code?: number }).code).toBe(-32000);
  });

  it("redacts filesystem paths and connection strings", () => {
    const safe = toClientError(new Error("ENOENT /home/ybao/keystore.json redis://h:6379"));
    expect(safe.message).toContain("[path]");
    expect(safe.message).toContain("[redis]");
  });

  it("handles non-Error throwables", () => {
    expect(() => toClientError("plain string boom")).not.toThrow();
    expect(toClientError("plain string boom").message).toContain("boom");
  });
});
