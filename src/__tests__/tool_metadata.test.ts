import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import systemTools from "../plugins/system.tool.js";

describe("tool metadata", () => {
  test("system tools include MCP annotations and execution metadata", () => {
    const ping = systemTools.find(tool => tool.name === "super_mcp_ping");
    const longTask = systemTools.find(tool => tool.name === "super_mcp_test_long_task");

    expect(ping?.annotations?.readOnlyHint).toBe(true);
    expect(ping?.annotations?.idempotentHint).toBe(true);
    expect(ping?.execution?.taskSupport).toBe("forbidden");

    expect(longTask).toBeUndefined();
  });

  test("test-only long task is gated by MCP_ENABLE_TEST_TOOLS", async () => {
    const source = await readFile(new URL("../plugins/system.tool.ts", import.meta.url), "utf-8");
    expect(source).toContain("MCP_ENABLE_TEST_TOOLS");
    expect(source).toContain("super_mcp_test_long_task");
  });

  test("registrar forwards annotations and execution metadata to registerTool", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");
    expect(source).toContain("registerMcpTool(");
    expect(source).toContain("taskSupport");
    expect(source).toContain("must declare annotations and execution metadata");
  });
});
