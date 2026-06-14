import { describe, expect, test } from "vitest";
import {
  MCP_TASKS_EXTENSION,
  clientSupportsNativeTasks,
  ensureTaskOwner,
  extractMcpTraceContext,
  globalNativeTaskRuntime,
  taskOwner,
  TaskCancelledError,
  toCreateTaskResult,
} from "../mcp/adapter/task_runtime.js";
import type { RequestContext } from "../security/context.js";
import type { TaskHandleRecord } from "../core/task_store.js";

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "tenant-a",
    userId: "user-a",
    clientId: "client-a",
    scopes: ["mcp:invoke"],
    requestId: "req-a",
    authType: "oidc",
    ...overrides,
  };
}

function task(overrides: Partial<TaskHandleRecord> = {}): TaskHandleRecord {
  const baseCtx = ctx();
  return {
    taskId: "task_0000000000000000",
    idempotencyKey: "idem",
    tenantId: baseCtx.tenantId,
    owner: taskOwner(baseCtx),
    toolName: "tool",
    status: "working",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("native task runtime", () => {
  test("detects declared Tasks extension support", () => {
    expect(clientSupportsNativeTasks({ _meta: { supportedExtensions: [MCP_TASKS_EXTENSION] } })).toBe(true);
    expect(clientSupportsNativeTasks({ _meta: { extensions: { [MCP_TASKS_EXTENSION]: true } } })).toBe(true);
    expect(clientSupportsNativeTasks({})).toBe(false);
  });

  test("task owner key uses tenant/client/user", () => {
    expect(taskOwner(ctx())).toBe("tenant-a:client-a:user-a");
  });

  test("ensureTaskOwner rejects cross-tenant existence without leaking details", () => {
    expect(() => ensureTaskOwner(task({ tenantId: "tenant-b" }), ctx())).toThrow("Task not found or expired");
    expect(() => ensureTaskOwner(task({ owner: "tenant-a:client-b:user-a" }), ctx())).toThrow("Task not found or expired");
  });

  test("CreateTaskResult exposes task metadata without legacy polling text", () => {
    const result = toCreateTaskResult(task());
    expect(result.resultType).toBe("task");
    expect(result.taskId).toBe("task_0000000000000000");
    expect(result.pollIntervalMs).toBeGreaterThan(0);
    expect(result.ttlMs).toBeGreaterThan(0);
  });

  test("active task runtime cancels a registered worker signal", () => {
    const controller = new AbortController();
    const cleanup = globalNativeTaskRuntime.register("task_0000000000000000", controller);
    expect(globalNativeTaskRuntime.isActive("task_0000000000000000")).toBe(true);
    expect(globalNativeTaskRuntime.cancel("task_0000000000000000", "user requested")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(TaskCancelledError);
    cleanup();
    expect(globalNativeTaskRuntime.isActive("task_0000000000000000")).toBe(false);
  });

  test("tasks/update input resumes only when inputRequestId matches", async () => {
    const pending = globalNativeTaskRuntime.requestInput("task_0000000000000000", undefined, "default", "input_nonce_1");
    expect(globalNativeTaskRuntime.provideInputResponses("task_0000000000000000", "stale_nonce", { default: { ok: false } })).toBe(false);
    expect(globalNativeTaskRuntime.provideInputResponses("task_0000000000000000", "input_nonce_1", { default: { ok: true } })).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  test("extracts OTel trace context from MCP params _meta", () => {
    const trace = extractMcpTraceContext({
      _meta: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
        baggage: "tenant=redacted",
      },
    });
    expect(trace.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(trace.span_id).toBe("00f067aa0ba902b7");
    expect(trace.tracestate).toBe("vendor=value");
    expect(trace.baggage).toBe("tenant=redacted");
  });
});
