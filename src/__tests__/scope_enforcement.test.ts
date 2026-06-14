import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod/v4";
import type { RequestContext } from "../security/context.js";

let registeredHandler: ((args: unknown, extra?: { signal?: AbortSignal; mcpReq?: { id?: unknown; signal?: AbortSignal; _meta?: Record<string, unknown> } }) => Promise<unknown>) | undefined;

vi.mock("../mcp/adapter/mcp_protocol_adapter.js", async importOriginal => {
  const original = await importOriginal<typeof import("../mcp/adapter/mcp_protocol_adapter.js")>();
  return {
    ...original,
    registerMcpTool: vi.fn((_server, _tool, handler) => {
      registeredHandler = handler as typeof registeredHandler;
    }),
  };
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  registeredHandler = undefined;
});

describe("per-tool scope enforcement", () => {
  test("rejects missing required scopes before executing the tool handler", async () => {
    vi.stubEnv("ENABLE_RATE_LIMIT", "false");
    vi.stubEnv("ENABLE_QUOTA", "false");
    vi.stubEnv("MCP_SAFE_MODE", "true");
    vi.stubEnv("TELEMETRY_DRIVER", "stderr");
    vi.stubEnv("STORAGE_DRIVER", "memory");

    const { registerTools } = await import("../mcp/adapter/execution_pipeline.js");
    const { withRequestContext } = await import("../security/context.js");
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }] }));

    registerTools(
      {} as any,
      [{
        name: "scoped_tool",
        description: "Requires a delegated scope",
        inputSchema: { value: z.string().optional() },
        requiredScopes: ["email:send"],
        allowedPhases: ["intake"],
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        execution: { taskSupport: "forbidden" },
        securityPolicy: {
          accessesPrivateData: false,
          exposesUntrustedContent: false,
          externalCommunication: false,
          destructiveEffects: false,
        },
        handler,
      }],
      async () => ({ phase: "intake", revision: 1, payload: {} }) as any,
      async () => undefined,
    );

    expect(registeredHandler).toBeTypeOf("function");
    const ctx: RequestContext = {
      tenantId: "tenant_test",
      userId: "user_test",
      clientId: "client_test",
      scopes: [],
      requestId: "req_scope_missing",
      authType: "jwt",
    };

    await expect(withRequestContext(ctx, () => registeredHandler!({}, { mcpReq: { id: "1" } }) as Promise<unknown>))
      .rejects.toThrow("Missing required scope(s): email:send");
    expect(handler).not.toHaveBeenCalled();
  }, 15000);
});
