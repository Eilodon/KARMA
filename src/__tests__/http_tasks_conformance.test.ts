import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod/v4";

const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

type Harness = {
  baseUrl: string;
  close: () => Promise<void>;
  rpc: (body: any, tenantId?: string) => Promise<any>;
  createExpiredTask: () => Promise<string>;
};

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function createHarness(): Promise<Harness> {
  vi.resetModules();
  vi.stubEnv("STORAGE_DRIVER", "memory");
  vi.stubEnv("TELEMETRY_DRIVER", "stderr");
  vi.stubEnv("MCP_SAFE_MODE", "true");
  vi.stubEnv("ENABLE_RATE_LIMIT", "false");
  vi.stubEnv("ENABLE_QUOTA", "false");
  vi.stubEnv("MCP_TOOL_TIMEOUT_MS", "5000");
  vi.stubEnv("MCP_IDEMPOTENCY_RESULT_TTL_SECONDS", "60");
  vi.stubEnv("MCP_IDEMPOTENCY_WORKING_TTL_SECONDS", "30");
  vi.stubEnv("MCP_IDEMPOTENCY_ERROR_TTL_SECONDS", "30");
  vi.stubEnv("MCP_TASK_POLL_INTERVAL_MS", "1000");

  const express = (await import("express")).default;
  const { SuperMcpRuntime } = await import("../core/runtime.js");
  const { protocolHeaderValidation } = await import("../middlewares/protocol_header.js");
  const { withRequestContext } = await import("../security/context.js");
  const { loadHttpServerAdapters } = await import("../mcp/adapter/mcp_protocol_adapter.js");
  const { globalTaskStore } = await import("../core/task_store.js");
  const { taskOwner } = await import("../mcp/adapter/task_runtime.js");

  const tools = [
    {
      name: "native_long",
      description: "Native task conformance test tool",
      inputSchema: {
        mode: z.enum(["quick", "input", "block"]).optional(),
        value: z.string().optional(),
      },
      inputJsonSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          mode: { enum: ["quick", "input", "block"] },
          value: { type: "string", maxLength: 100 },
        },
        additionalProperties: false,
      },
      outputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          ok: { type: "boolean" },
          value: { type: "string" },
          input: { type: "object", additionalProperties: true },
        },
        required: ["ok"],
        additionalProperties: false,
      },
      allowedPhases: ["intake"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "required" },
      securityPolicy: {
        accessesPrivateData: false,
        exposesUntrustedContent: false,
        externalCommunication: false,
        destructiveEffects: false,
      },
      handler: async (args: any, _state: any, signal?: AbortSignal, context?: any) => {
        if (args.mode === "block") {
          await new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), { once: true });
          });
        }
        if (args.mode === "input") {
          const input = await context?.requestInput?.("Need confirmation");
          return {
            content: [{ type: "text", text: "input received" }],
            structuredContent: { ok: true, input },
          };
        }
        await delay(25);
        return {
          content: [{ type: "text", text: "quick complete" }],
          structuredContent: { ok: true, value: args.value || "done" },
        };
      },
    },
  ];

  const runtime = new SuperMcpRuntime("test", tools as any);
  await runtime.initialize();
  const { StreamableHTTPServerTransport } = await loadHttpServerAdapters();

  const app = express();
  app.use(express.json());
  app.use("/mcp", protocolHeaderValidation);
  app.post("/mcp", async (req, res) => {
    const tenantId = String(req.headers["x-test-tenant"] || "tenant-a");
    const ctx = {
      tenantId,
      userId: "user-a",
      clientId: "client-a",
      scopes: ["mcp:invoke"],
      requestId: String(req.headers["x-request-id"] || `req-${req.body?.id || Date.now()}`),
      authType: "jwt" as const,
    };

    await withRequestContext(ctx, async () => {
      let transport: InstanceType<typeof StreamableHTTPServerTransport> | undefined;
      let server: Awaited<ReturnType<typeof runtime.connectEphemeral>> | undefined;
      try {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        server = await runtime.connectEphemeral(transport);
        await transport.handleRequest(req, res, req.body);
      } finally {
        await transport?.close().catch(() => undefined);
        await server?.close().catch(() => undefined);
      }
    });
  });

  const httpServer = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("test HTTP server did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const rpc = async (body: any, tenantId = "tenant-a") => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "mcp-method": body.method,
      "x-test-tenant": tenantId,
      "x-request-id": `req-${body.id}`,
    };
    if (body.method === "tools/call") headers["mcp-name"] = body.params.name;
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return response.json();
  };

  return {
    baseUrl,
    rpc,
    createExpiredTask: async () => {
      const ctx = {
        tenantId: "tenant-a",
        userId: "user-a",
        clientId: "client-a",
        scopes: ["mcp:invoke"],
        requestId: "req-expired-direct",
        authType: "jwt" as const,
      };
      const task = await globalTaskStore.createTask({
        idempotencyKey: `expired-${Date.now()}`,
        tenantId: ctx.tenantId,
        owner: taskOwner(ctx),
        toolName: "native_long",
        ttlSeconds: 1,
      });
      return task.taskId;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => httpServer.close(err => err ? reject(err) : resolve()));
      await runtime.close();
      vi.unstubAllEnvs();
    },
  };
}

function clientMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: { [TASKS_EXTENSION]: true },
    },
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    tracestate: "vendor=value",
    baggage: "tenant=redacted",
  };
}

async function pollUntil(rpc: Harness["rpc"], taskId: string, status: string): Promise<any> {
  let last: any;
  for (let i = 0; i < 20; i += 1) {
    last = await rpc({ jsonrpc: "2.0", id: `get-${status}-${i}`, method: "tasks/get", params: { taskId } });
    if (last.result?.status === status) return last;
    await delay(50);
  }
  return last;
}

describe("HTTP native Tasks conformance", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    if (harness) await harness.close();
  });

  test("tools/list advertises actual JSON Schema 2020-12 and task execution metadata", async () => {
    const response = await harness.rpc({
      jsonrpc: "2.0",
      id: "list-1",
      method: "tools/list",
      params: { _meta: clientMeta() },
    });

    const tool = response.result.tools.find((entry: any) => entry.name === "native_long");
    expect(tool.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(tool.inputSchema.properties.value.maxLength).toBe(100);
    expect(tool.outputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(tool.outputSchema.properties.ok.type).toBe("boolean");
    expect(tool.execution.taskSupport).toBe("required");
    expect(response.result._meta.cacheScope).toBe("server");
  });

  test("tools/call returns CreateTaskResult and reconnect polling returns terminal result", async () => {
    const created = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-quick",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "quick", value: "alpha" },
        _meta: clientMeta(),
      },
    });

    expect(created.result.resultType).toBe("task");
    expect(created.result.taskId).toMatch(/^task_[0-9a-f]{16}$/);

    const completed = await pollUntil(harness.rpc, created.result.taskId, "completed");
    expect(completed.result.resultType).toBe("complete");
    expect(completed.result.result.structuredContent).toEqual({ ok: true, value: "alpha" });
  });

  test("tasks/update resumes input_required task", async () => {
    const created = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-input",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "input" },
        _meta: clientMeta(),
      },
    });

    const inputRequired = await pollUntil(harness.rpc, created.result.taskId, "input_required");
    expect(inputRequired.result.inputRequests.default.method).toBe("elicitation/create");
    const inputRequestId = inputRequired.result.inputRequests.default.inputRequestId;
    expect(inputRequestId).toMatch(/^input_/);

    const updated = await harness.rpc({
      jsonrpc: "2.0",
      id: "update-input",
      method: "tasks/update",
      params: {
        taskId: created.result.taskId,
        inputRequestId,
        inputResponses: { default: { confirmed: true } },
      },
    });
    expect(updated.result).toEqual({});

    const completed = await pollUntil(harness.rpc, created.result.taskId, "completed");
    expect(completed.result.result.structuredContent).toEqual({ ok: true, input: { confirmed: true } });
  });


  test("tasks/update rejects early, stale, and duplicate input", async () => {
    const quick = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-early",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "quick", value: "early" },
        _meta: clientMeta(),
      },
    });

    const early = await harness.rpc({
      jsonrpc: "2.0",
      id: "update-early",
      method: "tasks/update",
      params: {
        taskId: quick.result.taskId,
        inputRequestId: "input_early",
        inputResponses: { default: { confirmed: false } },
      },
    });
    expect(early.error.message).toContain("Task is not waiting for input");

    const inputTask = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-input-rejects",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "input" },
        _meta: clientMeta(),
      },
    });

    const inputRequired = await pollUntil(harness.rpc, inputTask.result.taskId, "input_required");
    const inputRequestId = inputRequired.result.inputRequests.default.inputRequestId;

    const stale = await harness.rpc({
      jsonrpc: "2.0",
      id: "update-stale",
      method: "tasks/update",
      params: {
        taskId: inputTask.result.taskId,
        inputRequestId: "input_stale",
        inputResponses: { default: { confirmed: false } },
      },
    });
    expect(stale.error.message).toContain("Stale or unknown inputRequestId");

    const accepted = await harness.rpc({
      jsonrpc: "2.0",
      id: "update-accepted",
      method: "tasks/update",
      params: {
        taskId: inputTask.result.taskId,
        inputRequestId,
        inputResponses: { default: { confirmed: true } },
      },
    });
    expect(accepted.result).toEqual({});

    const duplicate = await harness.rpc({
      jsonrpc: "2.0",
      id: "update-duplicate",
      method: "tasks/update",
      params: {
        taskId: inputTask.result.taskId,
        inputRequestId,
        inputResponses: { default: { confirmed: "overwritten" } },
      },
    });
    expect(duplicate.error.message).toContain("Task is not waiting for input");

    const completed = await pollUntil(harness.rpc, inputTask.result.taskId, "completed");
    expect(completed.result.result.structuredContent).toEqual({ ok: true, input: { confirmed: true } });
  });

  test("tasks/cancel cancels a running task", async () => {
    const created = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-block",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "block" },
        _meta: clientMeta(),
      },
    });

    const cancelled = await harness.rpc({
      jsonrpc: "2.0",
      id: "cancel-block",
      method: "tasks/cancel",
      params: { taskId: created.result.taskId, reason: "test cancel" },
    });
    expect(cancelled.result).toEqual({});

    const status = await pollUntil(harness.rpc, created.result.taskId, "cancelled");
    expect(status.result.status).toBe("cancelled");
    expect(status.result.cancelReason).toBe("test cancel");
  });

  test("expired task and cross-tenant reads do not leak existence", async () => {
    const expiredTaskId = await harness.createExpiredTask();
    await delay(1100);
    const expired = await harness.rpc({ jsonrpc: "2.0", id: "get-expired", method: "tasks/get", params: { taskId: expiredTaskId } });
    expect(expired.error.message).toContain("Task not found or expired");

    const created = await harness.rpc({
      jsonrpc: "2.0",
      id: "create-tenant-a",
      method: "tools/call",
      params: {
        name: "native_long",
        arguments: { mode: "quick", value: "tenant-a" },
        _meta: clientMeta(),
      },
    });
    const crossTenant = await harness.rpc(
      { jsonrpc: "2.0", id: "get-tenant-b", method: "tasks/get", params: { taskId: created.result.taskId } },
      "tenant-b",
    );
    expect(crossTenant.error.message).toContain("Task not found or expired");
  });
});
