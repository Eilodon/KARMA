import { describe, it, expect } from "vitest";
import { isTrustedBuiltInPlugin } from "../core/plugin_loader.js";

describe("isTrustedBuiltInPlugin — KARMA first-party plugin", () => {
  it("treats karma.tool.ts/js as a trusted in-process built-in", () => {
    expect(isTrustedBuiltInPlugin("karma.tool.ts")).toBe(true);
    expect(isTrustedBuiltInPlugin("karma.tool.js")).toBe(true);
  });

  it("keeps system.tool.ts/js trusted", () => {
    expect(isTrustedBuiltInPlugin("system.tool.ts")).toBe(true);
    expect(isTrustedBuiltInPlugin("system.tool.js")).toBe(true);
  });

  it("does NOT trust arbitrary third-party plugins", () => {
    expect(isTrustedBuiltInPlugin("random.tool.ts")).toBe(false);
    expect(isTrustedBuiltInPlugin("evil.tool.js")).toBe(false);
  });
});
