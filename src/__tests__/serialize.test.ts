import { describe, it, expect } from "vitest";
import { jsonSafe } from "../lib/serialize.js";

// D-6: a bare BigInt in structuredContent crashes JSON serialization in the MCP layer.
// jsonSafe recursively stringifies every BigInt so tool output is always JSON-safe.
describe("jsonSafe", () => {
  it("stringifies a top-level bigint", () => {
    expect(jsonSafe(5n)).toBe("5");
    expect(jsonSafe(12345678901234567890n)).toBe("12345678901234567890");
  });

  it("recursively stringifies bigints in nested objects and arrays", () => {
    expect(jsonSafe({ a: 1n, b: [2n, "x"], c: { d: 3n, e: true } })).toEqual({
      a: "1",
      b: ["2", "x"],
      c: { d: "3", e: true },
    });
  });

  it("preserves non-bigint primitives", () => {
    expect(jsonSafe([1, "s", true, null])).toEqual([1, "s", true, null]);
  });

  it("produces output that JSON.stringify never throws on", () => {
    const out = jsonSafe({ price: 10n, nested: { jobs: [1n, 2n] } });
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(JSON.stringify(out)).toBe('{"price":"10","nested":{"jobs":["1","2"]}}');
  });
});
