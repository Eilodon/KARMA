import { describe, it, expect, beforeEach, afterEach } from "vitest";
import tools from "../plugins/karma.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { markTrustedRuntime, resetTrustedRuntimeForTest } from "../core/runtime_identity.js";

function getHealth(): ToolDefinition {
  const t = (tools as ToolDefinition[]).find((x) => x.name === "karma_health");
  if (!t) throw new Error("karma_health not found");
  return t;
}

describe("karma.tool.ts skeleton (in-process built-in)", () => {
  beforeEach(() => resetTrustedRuntimeForTest());
  afterEach(() => {
    delete process.env.KARMA_PLUGIN_WORKER;
    resetTrustedRuntimeForTest();
  });

  it("exposes karma_health declaring the network capability", () => {
    const t = getHealth();
    expect(t.capabilities).toContain("network");
    expect(t.execution?.taskSupport).toBe("forbidden");
  });

  it("reports in-process mode and PHAROS env presence (when trusted)", async () => {
    markTrustedRuntime();
    process.env.PHAROS_RPC_URL = "https://atlantic.dplabs-internal.com";
    const t = getHealth();
    const res = await t.handler({}, {} as never, undefined, undefined);
    expect(res.structuredContent).toMatchObject({ inProcess: true, hasRpcEnv: true });
  });

  it("fail-closed: throws when the trusted-runtime marker is absent, even with no worker env var", async () => {
    delete process.env.KARMA_PLUGIN_WORKER;
    const t = getHealth();
    await expect(t.handler({}, {} as never, undefined, undefined)).rejects.toThrow(/in-process|trusted/i);
  });

  it("fail-fast: throws if executed inside the external plugin worker (env signal), even if marked trusted", async () => {
    markTrustedRuntime();
    process.env.KARMA_PLUGIN_WORKER = "1";
    const t = getHealth();
    await expect(t.handler({}, {} as never, undefined, undefined)).rejects.toThrow(/in-process|trusted/i);
  });
});
