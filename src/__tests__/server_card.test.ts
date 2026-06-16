import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createServerCard } from "../http/server_card.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

describe("MCP server card", () => {
  test("publishes tool annotations and execution metadata", () => {
    const tools: ToolDefinition[] = [
      {
        name: "read_calendar",
        description: "Read calendar events",
        inputSchema: {},
        allowedPhases: ["intake"],
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        execution: { taskSupport: "forbidden" },
        requiredScopes: ["calendar:read"],
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ];

    const card = createServerCard(tools, "1.0.0") as any;
    const tool = card.tools.find((entry: any) => entry.name === "read_calendar");

    expect(card.name).toBe("karma-server");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.execution.taskSupport).toBe("forbidden");
    expect(card.auth.scopes).toEqual(["calendar:read"]);
    // P2-C: protocol mode must be advertised in the server card
    expect(card.protocol.protocolMode).toBe("rc2026");
    expect(card.protocol.discoverMethod).toBe("server/discover");
    expect(card.extensions["io.modelcontextprotocol/tasks"].methods).toEqual(["tasks/get", "tasks/update", "tasks/cancel"]);
    expect(card.tools.some((entry: any) => entry.name === "check_task_status")).toBe(false);
    // MISS-4/I-4.3: the server card must NOT leak reconnaissance signals. pluginTrustBoundary,
    // pluginIsolationMode, patternDebt, safeMode, etc. were deliberately removed (server_card.ts);
    // only a non-sensitive toolCount remains.
    expect(card._meta.security.pluginTrustBoundary).toBeUndefined();
    expect(card._meta.security.patternDebt).toBeUndefined();
    expect(typeof card._meta.security.toolCount).toBe("number");
    expect(card._meta.security.toolCount).toBeGreaterThan(0);
  });

  test("marks both jwt and oidc_jwks HTTP modes as resource servers", async () => {
    const source = await readFile(new URL("../http/server_card.ts", import.meta.url), "utf-8");
    expect(source).toContain('ENV.MCP_AUTH_MODE === "jwt" || ENV.MCP_AUTH_MODE === "oidc_jwks"');
    expect(source).toContain('ENV.TRANSPORT_DRIVER === "http"');
  });
});
