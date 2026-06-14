import { McpServer, StdioServerTransport, type Transport } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { z } from "zod/v4";
import { ENV } from "../../config/env.js";
import { getRequestContext } from "../../security/context.js";
import { findInputRequestKeyById, globalTaskStore } from "../../core/task_store.js";
import { ensureTaskOwner, globalNativeTaskRuntime, MCP_TASKS_EXTENSION, toNativeTaskResult } from "./task_runtime.js";
import type { ToolDefinition } from "./tool_registry.js";
import { guardJsonSchema202012, validateJsonAgainstSchema } from "./schema_guard.js";

export type McpServerInstance = McpServer;
export type McpTransport = Transport;

type RequestHandler = (request: { params?: unknown }) => Promise<unknown>;

type StandardJsonSchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: unknown } | { issues: Array<{ message: string }> };
    readonly jsonSchema: {
      readonly input: () => Record<string, unknown>;
      readonly output: () => Record<string, unknown>;
    };
  };
};

function standardJsonSchema(schema: Record<string, unknown>, kind: "input" | "output"): StandardJsonSchema {
  const guarded = guardJsonSchema202012(schema, kind);
  return {
    "~standard": {
      version: 1,
      vendor: "super-mcp-json-schema-2020-12",
      validate: (value: unknown) => {
        try {
          validateJsonAgainstSchema(guarded, value, kind);
          return { value };
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
        }
      },
      jsonSchema: {
        input: () => guarded,
        output: () => guarded,
      },
    },
  };
}

function registerToolWithExecution(
  server: McpServer,
  name: string,
  config: Record<string, unknown>,
  execution: unknown,
  handler: unknown,
): void {
  const privateCreate = (server as unknown as {
    _createRegisteredTool?: (...args: unknown[]) => unknown;
  })._createRegisteredTool;

  if (typeof privateCreate === "function") {
    privateCreate.call(
      server,
      name,
      config.title,
      config.description,
      config.inputSchema,
      config.outputSchema,
      config.annotations,
      { taskSupport: "forbidden" },
      { ...(config._meta as Record<string, unknown>), execution },
      handler,
    );
    return;
  }

  // SDK v2 alpha registerTool hard-codes execution.taskSupport to forbidden.
  // SUPER-MCP owns native Tasks in the custom adapter until SDK Tasks are stable,
  // so actual execution metadata is exposed through tools/list override and _meta.
  server.registerTool(name, { ...config, _meta: { ...(config._meta as Record<string, unknown>), execution } }, handler as any);
}

function schemaForToolList(tool: ToolDefinition<unknown>, kind: "input" | "output"): Record<string, unknown> | undefined {
  if (kind === "input" && tool.inputJsonSchema) return guardJsonSchema202012(tool.inputJsonSchema, "input");
  if (kind === "output" && tool.outputSchema) return guardJsonSchema202012(tool.outputSchema, "output");
  if (kind === "input") {
    const schema = z.object(tool.inputSchema as any) as any;
    const jsonSchema = schema?.["~standard"]?.jsonSchema?.input?.({ target: "draft-2020-12" });
    return { type: "object", ...(jsonSchema || { properties: {} }) };
  }
  return undefined;
}

export function registerToolListSurface<T>(server: McpServer, tools: ToolDefinition<T>[]): void {
  setRawRequestHandler(server, "tools/list", async () => ({
    tools: tools.map(tool => {
      const inputSchema = schemaForToolList(tool as unknown as ToolDefinition<unknown>, "input") || { type: "object", properties: {} };
      const outputSchema = schemaForToolList(tool as unknown as ToolDefinition<unknown>, "output");
      return {
        name: tool.name,
        description: tool.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        annotations: tool.annotations,
        execution: tool.execution,
        _meta: {
          schemaDialect: "https://json-schema.org/draft/2020-12/schema",
          "io.modelcontextprotocol/cache": {
            ttlMs: ENV.MCP_TOOL_LIST_TTL_MS,
            cacheScope: "server",
          },
        },
      };
    }),
    _meta: {
      ttlMs: ENV.MCP_TOOL_LIST_TTL_MS,
      cacheScope: "server",
    },
  }));
}

function setRawRequestHandler(server: McpServer, method: string, handler: RequestHandler): void {
  const rawServer = (server as unknown as {
    server?: {
      _requestHandlers?: Map<string, (request: unknown, ctx?: unknown) => Promise<unknown>>;
      setRequestHandler?: (...args: unknown[]) => unknown;
    };
  }).server;
  if (!rawServer) {
    throw new Error(`[SUPER-MCP] SDK server is unavailable; cannot register MCP method '${method}'.`);
  }

  // SDK v2 alpha's public setRequestHandler asks getRequestSchema(method) to
  // parse every request. Draft RC methods such as tasks/update may not exist in
  // that alpha schema table yet, so SUPER-MCP installs final-target handlers
  // directly at the protocol boundary. This keeps all non-SDK coupling inside
  // src/mcp/adapter and is covered by HTTP conformance tests.
  if (rawServer._requestHandlers instanceof Map) {
    rawServer._requestHandlers.set(method, async (request: unknown, _ctx?: unknown) => handler({ params: (request as { params?: unknown } | undefined)?.params }));
    return;
  }

  if (!rawServer.setRequestHandler) {
    throw new Error(`[SUPER-MCP] SDK server does not expose a request handler registry; cannot register MCP method '${method}'.`);
  }
  rawServer.setRequestHandler(method, async (request: { params?: unknown }) => handler({ params: request?.params }) as any);
}

export function createMcpServer(version: string): McpServer {
  return new McpServer({
    name: "super-mcp-server",
    version,
  });
}

export async function createStdioTransport(): Promise<Transport> {
  return new StdioServerTransport();
}

export async function loadHttpServerAdapters() {
  return {
    StreamableHTTPServerTransport: NodeStreamableHTTPServerTransport,
    createMcpExpressApp,
  };
}

export function registerMcpTool<T>(
  server: McpServer,
  tool: ToolDefinition<T>,
  handler: (args: unknown, extra?: { signal?: AbortSignal }) => Promise<unknown>,
): void {
  const inputJsonSchema = tool.inputJsonSchema
    ? guardJsonSchema202012(tool.inputJsonSchema, "input")
    : undefined;
  const outputJsonSchema = tool.outputSchema
    ? guardJsonSchema202012(tool.outputSchema, "output")
    : undefined;
  const inputSchema = inputJsonSchema
    ? standardJsonSchema(inputJsonSchema, "input")
    : z.object(tool.inputSchema as any);
  const outputSchema = outputJsonSchema
    ? standardJsonSchema(outputJsonSchema, "output")
    : undefined;

  registerToolWithExecution(
    server,
    tool.name,
    {
      description: tool.description,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      annotations: tool.annotations,
      _meta: {
        schemaDialect: "https://json-schema.org/draft/2020-12/schema",
        "io.modelcontextprotocol/cache": {
          ttlMs: ENV.MCP_TOOL_LIST_TTL_MS,
          cacheScope: "server",
        },
      },
    },
    tool.execution,
    handler,
  );
}

export function registerDiscover<T>(server: McpServer, tools: ToolDefinition<T>[]): void {
  setRawRequestHandler(server, "server/discover", async () => ({
    protocol: {
      target: "mcp-2026-07-28",
      mode: ENV.MCP_PROTOCOL_MODE,
      statelessHttp: true,
      initializeCompatibility: "sdk-v2-alpha-boundary",
    },
    capabilities: {
      extensions: {
        [MCP_TASKS_EXTENSION]: {
          methods: ["tasks/get", "tasks/update", "tasks/cancel"],
          list: false,
          pollIntervalMs: ENV.MCP_TASK_POLL_INTERVAL_MS,
          ttlMs: ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS * 1000,
        },
      },
      tools: {
        ttlMs: ENV.MCP_TOOL_LIST_TTL_MS,
        cacheScope: "server",
        names: tools.map(tool => tool.name),
      },
    },
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/serverInfo": {
        name: "super-mcp-server",
      },
      "io.modelcontextprotocol/serverCapabilities": {
        extensions: {
          [MCP_TASKS_EXTENSION]: true,
        },
      },
    },
  }));
}

export function registerNativeTaskMethods(server: McpServer): void {
  setRawRequestHandler(server, "tasks/get", async (request) => {
    const ctx = getRequestContext();
    const params = request.params as { taskId?: string } | undefined;
    const taskId = params?.taskId;
    if (!taskId) throw new Error("taskId is required");
    const record = ensureTaskOwner(await globalTaskStore.getTask(taskId), ctx);
    return toNativeTaskResult(record);
  });

  setRawRequestHandler(server, "tasks/update", async (request) => {
    const ctx = getRequestContext();
    const params = request.params as { taskId?: string; inputRequestId?: string; inputResponses?: Record<string, unknown> } | undefined;
    const taskId = params?.taskId;
    if (!taskId) throw new Error("taskId is required");
    if (!params?.inputResponses || typeof params.inputResponses !== "object" || Array.isArray(params.inputResponses)) {
      throw new Error("inputResponses is required");
    }
    if (!params?.inputRequestId || typeof params.inputRequestId !== "string" || params.inputRequestId.trim().length === 0) {
      throw new Error("inputRequestId is required");
    }

    const current = ensureTaskOwner(await globalTaskStore.getTask(taskId), ctx);
    if (current.status !== "input_required" || !current.inputRequests || Object.keys(current.inputRequests).length === 0) {
      throw new Error("Task is not waiting for input");
    }

    const requestKey = findInputRequestKeyById(current.inputRequests, params.inputRequestId);
    if (!requestKey) {
      throw new Error("Stale or unknown inputRequestId");
    }

    const updatedAt = new Date().toISOString();
    const consumed = await globalTaskStore.consumeTaskInput(current.taskId, {
      inputRequestId: params.inputRequestId,
      inputResponses: params.inputResponses,
      metadata: {
        lastClientUpdate: {
          inputRequestId: params.inputRequestId,
          inputRequestKey: requestKey,
          inputResponseKeys: Object.keys(params.inputResponses),
          updatedAt,
        },
      },
    });

    if (!consumed.ok) {
      if (consumed.reason === "not_found") throw new Error("Task not found or expired");
      if (consumed.reason === "stale_input_request") throw new Error("Stale or unknown inputRequestId");
      throw new Error("Task is not waiting for input");
    }
    ensureTaskOwner(consumed.record, ctx);

    const deliveredToLocalWaiter = globalNativeTaskRuntime.provideInputResponses(
      current.taskId,
      params.inputRequestId,
      params.inputResponses,
    );
    if (!deliveredToLocalWaiter) {
      const latest = await globalTaskStore.getTask(current.taskId);
      if (latest) {
        await globalTaskStore.updateTask(current.taskId, {
          metadata: {
            ...(latest.metadata || {}),
            lastClientUpdate: {
              ...((latest.metadata?.lastClientUpdate || {}) as Record<string, unknown>),
              deliveredToLocalWaiter,
              storeResumeRequired: true,
            },
          },
        });
      }
    }

    return {};
  });

  setRawRequestHandler(server, "tasks/cancel", async (request) => {
    const ctx = getRequestContext();
    const params = request.params as { taskId?: string; reason?: string } | undefined;
    const taskId = params?.taskId;
    if (!taskId) throw new Error("taskId is required");
    const current = ensureTaskOwner(await globalTaskStore.getTask(taskId), ctx);
    globalNativeTaskRuntime.cancel(current.taskId, params?.reason);
    ensureTaskOwner(await globalTaskStore.cancelTask(current.taskId, params?.reason), ctx);
    return {};
  });
}
