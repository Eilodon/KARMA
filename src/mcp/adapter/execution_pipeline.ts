import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { ENV } from "../../config/env.js";
import { getRequestContext } from "../../security/context.js";
import { globalRateLimiter } from "../../middlewares/rate_limit.js";
import { globalQuotaManager } from "../../middlewares/quota.js";
import { globalIdempotencyManager } from "../../middlewares/idempotency.js";
import { globalGuardrails } from "../../middlewares/guardrails.js";
import { globalCredentialVault } from "../../middlewares/vault.js";
import { globalExecutionLockManager } from "../../middlewares/execution_lock.js";
import { scanToolOutput, redactErrorText } from "../../middlewares/output_firewall.js";
import { sanitizeJsonValue } from "../../security/sanitize.js";
import { assertToolPolicy } from "../../security/policy.js";
import { telemetry } from "../../telemetry/factory.js";
import { endSpan, startSpan } from "../../telemetry/otel.js";
import { guardJsonSchema202012, validateJsonAgainstSchema } from "./schema_guard.js";
import type { BaseState } from "../../types/schemas.js";
import { assertPluginManifestStable } from "../../core/plugin_loader.js";
import { globalTaskTracker } from "../../core/task_tracker.js";
import { globalTaskStore } from "../../core/task_store.js";
import {
  clientSupportsNativeTasks,
  extractMcpTraceContext,
  globalNativeTaskRuntime,
  toCreateTaskResult,
  taskOwner,
  TaskCancelledError,
} from "./task_runtime.js";
import { registerMcpTool, type McpServerInstance } from "./mcp_protocol_adapter.js";
import type {
  ToolCapability,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "./tool_registry.js";

export type {
  ToolAnnotations,
  ToolCapability,
  ToolDefinition,
  ToolExecution,
  ToolExecutionContext,
  ToolHandler,
  ToolResult,
  ToolTaskSupport,
} from "./tool_registry.js";

export class ElicitationRequiredException extends Error {
  constructor(public formParams: any) {
    super("Elicitation required");
    this.name = "ElicitationRequiredException";
  }
}

export interface GetStateOptions {
  reload?: boolean;
}

const SAFE_MODE_BLOCKED_CAPABILITIES = new Set<ToolCapability>([
  "fs.write",
  "network",
  "secrets.write",
  "process.spawn",
  "destructive",
]);

function ensureToolPolicy<T>(tool: ToolDefinition<T>): void {
  assertToolPolicy(tool);
  if (!ENV.MCP_SAFE_MODE) return;
  const blocked = (tool.capabilities || []).filter(capability => SAFE_MODE_BLOCKED_CAPABILITIES.has(capability));
  if (blocked.length > 0) {
    throw new Error(`[KARMA] MCP_SAFE_MODE blocked tool '${tool.name}' because it declares capabilities: ${blocked.join(",")}`);
  }
}

function validateConfidence<T>(tool: ToolDefinition<T>, args: unknown): void {
  if (!tool.requireConfidence) return;
  const confidence = (args as any).confidence_level;
  const reasoning = String((args as any).reasoning || "").trim();
  const genericReasoning = [
    /\bas an ai\b/i,
    /\btrust me\b/i,
    /\bi am safe\b/i,
    /\bthis is safe\b/i,
    /\bno risk\b/i,
    /\bi cannot\b/i,
  ].some(pattern => pattern.test(reasoning));
  const hasObservableSignal = /\b(phase|scope|capabilit|tenant|state|idempot|schema|allowlist|read[- ]?only|rollback|audit|lock)\b/i.test(reasoning);
  if (
    confidence === undefined ||
    confidence < (tool.minConfidence || 0.8) ||
    reasoning.length < 40 ||
    genericReasoning ||
    !hasObservableSignal
  ) {
    throw new ElicitationRequiredException({
      message: `AI Confidence (${confidence}) is below threshold or reasoning lacks concrete observable safety signals. Manual user confirmation required.`
    });
  }
}

function validateScopes<T>(tool: ToolDefinition<T>, scopes: string[], authType: string): void {
  // E-6.1 fix: only bypass scope check for local stdio (no external auth possible).
  // "api-key" and "gateway" must both enforce requiredScopes.
  if (authType === "stdio") return;
  const required = tool.requiredScopes || [];
  if (required.length === 0) return;
  const granted = new Set(scopes);
  const missing = required.filter(scope => !granted.has(scope));
  if (missing.length > 0) {
    throw new Error(`[KARMA] Missing required scope(s): ${missing.join(",")}`);
  }
}

function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void; timeout: Promise<never> } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason ?? new Error("Client aborted request"));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });

  let timeoutHandle: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`[KARMA] Tool timed out after ${timeoutMs}ms`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });

  return {
    signal: controller.signal,
    timeout,
    cleanup: () => {
      clearTimeout(timeoutHandle);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function runHandlerWithTimeout<T>(
  tool: ToolDefinition<T>,
  args: unknown,
  state: BaseState<T>,
  parentSignal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  if (tool.inputJsonSchema) {
    validateJsonAgainstSchema(guardJsonSchema202012(tool.inputJsonSchema, "input"), args, "input");
  }
  if (tool.payloadSchema) {
    state.payload = tool.payloadSchema.parse(state.payload);
  }
  const combined = combineSignal(parentSignal, ENV.MCP_TOOL_TIMEOUT_MS);
  try {
    const result = await Promise.race([
      tool.handler(args, state, combined.signal, context),
      combined.timeout,
    ]);
    if (tool.payloadSchema) {
      state.payload = tool.payloadSchema.parse(state.payload);
    }
    if (tool.outputSchema) {
      const guardedOutput = guardJsonSchema202012(tool.outputSchema, "output");
      validateJsonAgainstSchema(guardedOutput, result.structuredContent ?? result, "output");
    }
    return result;
  } finally {
    combined.cleanup();
  }
}

function sanitizeResult(rawResult: ToolResult): { result: ToolResult; wasTruncated: boolean } {
  const MAX_PAYLOAD_SIZE = 50000;
  let wasTruncated = false;
  const sanitizedContent = rawResult.content.map(c => {
    if (c.type === "text" && c.text.length > MAX_PAYLOAD_SIZE) {
      wasTruncated = true;
      try {
        const parsed = JSON.parse(c.text);
        if (Array.isArray(parsed)) {
          const sliced = parsed.slice(0, 100);
          return { ...c, text: JSON.stringify(sliced, null, 2) + "\n\n--- [KARMA WARNING: JSON ARRAY TRUNCATED TO 100 ITEMS TO SAVE TOKENS] ---" };
        }
      } catch {
        // Fallback to string truncation
      }
      return {
        ...c,
        text: c.text.substring(0, MAX_PAYLOAD_SIZE) + "\n\n--- [KARMA WARNING: PAYLOAD TRUNCATED - DUPLICATED/EXCESSIVE DATA REMOVED. RESULTS MAY BE INCOMPLETE] ---"
      };
    }
    return c;
  });
  return { result: { ...rawResult, content: sanitizedContent }, wasTruncated };
}

function isExecutionLockError(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error);
  return text.includes("Tenant execution lock was lost")
    || text.includes("Tenant execution lock heartbeat failed repeatedly");
}

/**
 * PD-006: a tenant tried to drive an agent it does not own (STRIDE-S, keystore assertOwnedBy).
 * Surfaced as a distinct telemetry signal so security monitoring can alarm on spoof attempts,
 * instead of it hiding inside generic tool_execution_failed events.
 */
export function isTenantMismatchError(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error);
  return text.includes("is not accessible to this tenant");
}

/**
 * Heuristic for infrastructure / network errors that are safe to retry.
 * Transient errors release the idempotency lock so callers can resubmit.
 * Permanent errors (tool logic failures) commit with a short error TTL.
 */
export function isTransientError(error: unknown): boolean {
  const TRANSIENT_CODES = new Set([
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
    "ECONNABORTED", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH",
    "EAI_AGAIN", "ESOCKETTIMEDOUT", "ECONNFAIL",
  ]);

  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const message = String(current instanceof Error ? current.message : current);
    const code = (current as NodeJS.ErrnoException)?.code;

    if (code && TRANSIENT_CODES.has(code)) return true;

    if (
      /ECONNREFUSED/i.test(message) ||
      /ECONNRESET/i.test(message) ||
      /ETIMEDOUT/i.test(message) ||
      /EAI_AGAIN/i.test(message) ||
      /socket hang up/i.test(message) ||
      /timed? ?out|timeout/i.test(message) ||
      /connect(ion)? (refused|reset|lost|closed|timed? ?out)/i.test(message) ||
      /could not acquire .*lock/i.test(message) ||
      (/redis/i.test(message) && /(connect|ECONNREFUSED|timeout|timed? ?out)/i.test(message))
    ) {
      return true;
    }

    current = (current as { cause?: unknown })?.cause;
  }

  return false;
}

/**
 * A tool is safe to *re-run after it has already started* only if it is read-only
 * or declares itself idempotent. For every other tool a failure mid/after execution
 * must be assumed to have caused a partial, possibly-irreversible external
 * side-effect (e.g. an on-chain escrow tx), so a blind retry would double-execute.
 */
export function isIdempotentTool<T>(tool: ToolDefinition<T>): boolean {
  return tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true;
}

/**
 * Fix 1 (split-brain / double-execution): the idempotency record may be RELEASED
 * (allowing a clean retry) only when we are certain no external side-effect occurred.
 * That holds when the tool handler never started (`toolStarted === false`) or when
 * the tool is idempotent by contract. Otherwise we must FENCE: keep the record
 * (commitError) so an automatic retry cannot re-run a non-idempotent operation while
 * its real-world effect is unknown. Durable exactly-once still requires tool-level
 * nonce-pinning / check-before-write (tracked separately at the contract layer).
 */
export function canReleaseIdempotency<T>(tool: ToolDefinition<T>, toolStarted: boolean): boolean {
  if (!toolStarted) return true;
  return isIdempotentTool(tool);
}

function makeToolErrorResult(prefix: string, error: unknown): ToolResult {
  // MISS-1 + A2: route through the canonical error firewall (credentials/PII/paths/connection
  // strings/private-key hex), not just path stripping. Full error detail is captured server-side
  // by the telemetry log at the call site.
  const raw = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `${prefix}: ${redactErrorText(raw)}` }] };
}

/**
 * A2 chokepoint: sanitize an error before it leaves KARMA for the MCP client. The MCP SDK forwards
 * a thrown error's `.message` verbatim, so every throw on a tool path must pass through here. The
 * full, unredacted error stays server-side in telemetry; only the client-facing message is redacted.
 * Preserves `.name` + a JSON-RPC `.code` so protocol semantics are unchanged; drops stack/cause.
 */
export function toClientError(error: unknown): Error {
  if (error instanceof ElicitationRequiredException) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const safe = new Error(redactErrorText(raw));
  if (error instanceof Error) {
    safe.name = error.name;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") (safe as { code?: unknown }).code = code;
  }
  return safe;
}

async function executeTool<T>(
  tool: ToolDefinition<T>,
  args: unknown,
  state: BaseState<T>,
  signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  ensureToolPolicy(tool);
  globalGuardrails.ensureToolPhase(tool.name, state.phase, tool.allowedPhases);
  const rawResult = await runHandlerWithTimeout(tool, args, state, signal, context);
  const firewall = scanToolOutput(rawResult);
  if (firewall.violations.length > 0) {
    await telemetry.log("output_firewall_redacted", { tool: tool.name, violations: firewall.violations });
  }
  const { result, wasTruncated } = sanitizeResult(firewall.result);
  if (wasTruncated) {
    await telemetry.log("payload_truncated", { tool: tool.name });
  }
  return result;
}

function startIdempotencyHeartbeat(idempotencyKey: string): () => void {
  if (!globalIdempotencyManager.extendWorking) return () => undefined;
  const intervalMs = Math.max(1000, Math.floor(ENV.MCP_IDEMPOTENCY_WORKING_TTL_SECONDS * 1000 / 3));
  const timer = setInterval(() => {
    globalIdempotencyManager.extendWorking?.(idempotencyKey).catch(error => {
      console.error("[KARMA] Failed to extend idempotency working TTL:", error);
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

async function waitForTaskStoreInput(
  taskId: string,
  inputRequestId: string,
  requestKey = "default",
  signal?: AbortSignal,
): Promise<unknown> {
  const pollDelayMs = Math.min(1000, ENV.MCP_TASK_POLL_INTERVAL_MS);
  let consecutiveStoreErrors = 0;
  const MAX_STORE_ERRORS = 10;
  while (!signal?.aborted) {
    let task;
    try {
      task = await globalTaskStore.getTask(taskId);
      consecutiveStoreErrors = 0;
    } catch (error) {
      // Fix 3: a transient store blip (e.g. Redis failover) must not kill a
      // long-running task that is parked waiting for client input. Skip this poll and
      // retry; give up only after repeated failures so a permanent outage still ends.
      if (!isTransientError(error)) throw error;
      consecutiveStoreErrors += 1;
      if (consecutiveStoreErrors >= MAX_STORE_ERRORS) {
        throw new Error(`[KARMA] Task ${taskId} store unavailable while waiting for input.`, { cause: error });
      }
      await new Promise(resolve => setTimeout(resolve, pollDelayMs));
      continue;
    }
    if (!task) throw new Error(`[KARMA] Task ${taskId} expired while waiting for input.`);
    if (task.status === "cancelled") throw new TaskCancelledError(taskId, task.cancelReason || "cancelled");
    if (task.lastClientInput?.inputRequestId === inputRequestId && task.lastClientInput.inputResponses) {
      return Object.prototype.hasOwnProperty.call(task.lastClientInput.inputResponses, requestKey)
        ? task.lastClientInput.inputResponses[requestKey]
        : task.lastClientInput.inputResponses;
    }
    await new Promise(resolve => setTimeout(resolve, pollDelayMs));
  }
  throw (signal?.reason || new TaskCancelledError(taskId));
}

async function applyInvocationGovernance(toolName: string, tenantId: string, requestId: string): Promise<void> {
  await assertPluginManifestStable();

  const rateLimitResult = await globalRateLimiter.check(tenantId);
  if (!rateLimitResult.allowed) {
    await telemetry.log("rate_limit_exceeded", { tool: toolName, tenantId, requestId });
    throw new Error(`[KARMA] Rate limit exceeded. Please try again in ${rateLimitResult.retryAfterMs}ms.`);
  }

  const quotaResult = await globalQuotaManager.check(tenantId);
  if (!quotaResult.allowed) {
    await telemetry.log("quota_exceeded", { tool: toolName, tenantId, used: quotaResult.used, requestId });
    throw new Error(`[KARMA] Quota exceeded. You have used all ${quotaResult.used} requests for today.`);
  }
}

export async function closeMiddlewareResources(): Promise<void> {
  await Promise.allSettled([
    globalRateLimiter.close?.(),
    globalQuotaManager.close?.(),
    globalIdempotencyManager.close?.(),
    globalCredentialVault.close?.(),
    globalExecutionLockManager.close?.(),
    globalTaskStore.close(),
  ]);
}

export function registerTools<T = Record<string, unknown>>(
  server: McpServerInstance,
  tools: ToolDefinition<T>[],
  getState: (tenantId: string, options?: GetStateOptions) => Promise<BaseState<T>>,
  saveState: (state: BaseState<T>) => Promise<void>,
): void {
  for (const tool of tools) {
    if (!tool.annotations || !tool.execution) {
      throw new Error(`[KARMA] Tool '${tool.name}' must declare annotations and execution metadata at registration time.`);
    }
    assertToolPolicy(tool);

    if (ENV.MCP_SAFE_MODE && (tool.capabilities || []).some(c => SAFE_MODE_BLOCKED_CAPABILITIES.has(c))) {
      console.error(`[KARMA] Tool '${tool.name}' not registered because MCP_SAFE_MODE blocks one or more declared capabilities.`);
      continue;
    }

    if (tool.requireConfidence) {
      tool.inputSchema.confidence_level = z.number().min(0).max(1).describe("AI confidence in the safety of the task (0.0 to 1.0)");
      tool.inputSchema.reasoning = z.string().describe("Detailed explanation of why this action is safe and non-destructive to the system");
    }

    registerMcpTool(
      server,
      tool,
      async (args: unknown, extra: { signal?: AbortSignal; mcpReq?: { id?: unknown; signal?: AbortSignal; _meta?: Record<string, unknown> } } = {}) => {
        // A2 chokepoint: any error thrown on a tool path is sanitized before it reaches the client.
        try {
        const ctx = getRequestContext();
        const tenantId = ctx.tenantId;
        const owner = taskOwner(ctx);
        const cleanArgs = sanitizeJsonValue(args);
        const taskSupport = tool.execution?.taskSupport || "forbidden";
        const requestMetaCarrier = { _meta: extra.mcpReq?._meta };
        const supportsNativeTasks = clientSupportsNativeTasks(requestMetaCarrier) || clientSupportsNativeTasks(cleanArgs);
        const traceContext = {
          ...extractMcpTraceContext(cleanArgs),
          ...extractMcpTraceContext(requestMetaCarrier),
        };
        const jsonRpcRequestId = extra.mcpReq?.id ?? ctx.requestId;
        const requestSignal = extra.mcpReq?.signal ?? extra.signal;
        const telemetryBase = {
          tool: tool.name,
          tenantId,
          userId: ctx.userId,
          clientId: ctx.clientId,
          requestId: ctx.requestId,
          "mcp.method.name": "tools/call",
          "gen_ai.tool.name": tool.name,
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          "jsonrpc.request.id": String(jsonRpcRequestId),
          ...traceContext,
        };
        const toolSpan = startSpan(`tools/call ${tool.name}`, telemetryBase);
        let spanEnded = false;
        const finishSpan = async (status: "OK" | "ERROR", extra: Record<string, unknown> = {}) => {
          if (spanEnded) {
            return {
              trace_id: toolSpan.traceId,
              span_id: toolSpan.spanId,
              parent_span_id: toolSpan.parentSpanId,
            };
          }
          spanEnded = true;
          return endSpan(toolSpan, status, extra);
        };
        const finishTaskLifecycleSpan = async (
          taskId: string,
          event: "created" | "input_required" | "working" | "completed" | "failed" | "cancelled",
          status: "OK" | "ERROR" = "OK",
          extra: Record<string, unknown> = {},
        ) => {
          const taskSpan = startSpan(`mcp.task.${event}`, {
            ...telemetryBase,
            trace_id: toolSpan.traceId,
            span_id: toolSpan.spanId,
            "mcp.task.id": taskId,
            "mcp.task.status": event,
          });
          return endSpan(taskSpan, status, extra);
        };

        try {
          await applyInvocationGovernance(tool.name, tenantId, ctx.requestId);
          validateScopes(tool, ctx.scopes, ctx.authType);
        } catch (error) {
          await finishSpan("ERROR", { error: String(error) });
          throw error;
        }

        try {
          validateConfidence(tool, cleanArgs);
        } catch (error) {
          if (error instanceof ElicitationRequiredException) {
            const spanMeta = await finishSpan("OK", { "mcp.elicitation.required": true });
            await telemetry.log("elicitation_requested", { ...telemetryBase, ...spanMeta });
            return { content: [{ type: "text", text: `[ELICITATION_REQUIRED] ${error.formParams.message}` }] };
          }
          await finishSpan("ERROR", { error: String(error) });
          throw error;
        }

        const idempotencyKey = globalIdempotencyManager.generateKey(tenantId, tool.name, cleanArgs, owner);
        const { locked, cached: cachedResult } = await globalIdempotencyManager.tryAcquireOrGetCached(idempotencyKey);
        
        if (!locked) {
          if (cachedResult && typeof cachedResult === "object" && (cachedResult as Record<string, unknown>).status === "working") {
            const existingTaskId = await globalTaskStore.findTaskId(idempotencyKey);
            if (existingTaskId) {
              const existingTask = await globalTaskStore.getTask(existingTaskId);
              if (existingTask && supportsNativeTasks) {
                const spanMeta = await finishSpan("OK", { taskId: existingTask.taskId, "mcp.task.duplicate": true });
                await telemetry.log("task_duplicate_invocation", { ...telemetryBase, ...spanMeta, taskId: existingTask.taskId });
                return toCreateTaskResult(existingTask);
              }
            }
            const spanMeta = await finishSpan("ERROR", { error: "duplicate_task_without_tasks_support" });
            await telemetry.log("task_duplicate_invocation", { ...telemetryBase, ...spanMeta });
            throw new Error(`[KARMA] Tool '${tool.name}' is already running. Use tasks/get when the client supports ${"io.modelcontextprotocol/tasks"}.`);
          }
          const spanMeta = await finishSpan("OK", { "mcp.idempotency.cache_hit": true });
          await telemetry.log("idempotency_cache_hit", { ...telemetryBase, ...spanMeta });
          return cachedResult;
        }

        await telemetry.log("tool_execution_started", { ...telemetryBase, taskSupport });

        if (taskSupport !== "forbidden" && supportsNativeTasks) {
          if (globalTaskTracker.isDraining()) {
            await globalIdempotencyManager.release(idempotencyKey);
            await finishSpan("ERROR", { error: "server_draining" });
            throw new Error("[KARMA] Server is shutting down and is not accepting new async tasks.");
          }

          const task = await globalTaskStore.createTask({
            idempotencyKey,
            tenantId,
            owner,
            toolName: tool.name,
            ttlSeconds: ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS,
          });
          const taskId = task.taskId;
          const taskController = new AbortController();

          // Fix 4 (ADR-006): pass a thunk so TaskTracker decides whether to START the
          // work under the drain gate, instead of receiving an already-running promise.
          const startTask = () => globalExecutionLockManager.withTenantLock(tenantId, async (lockSignal) => {
            const unregisterTask = globalNativeTaskRuntime.register(taskId, taskController);
            const stopHeartbeat = startIdempotencyHeartbeat(idempotencyKey);
            const signals = [lockSignal, taskController.signal].filter(Boolean) as AbortSignal[];
            const combinedSignal = signals.length > 0 ? (signals.length === 1 ? signals[0] : AbortSignal.any(signals)) : undefined;
            // Fix 1: once the handler starts, a non-idempotent side-effect may exist.
            let toolStarted = false;
            try {
              const state = await getState(tenantId, { reload: true });
              const taskExecutionContext: ToolExecutionContext = {
                taskId,
                requestInput: async (message?: string) => {
                  const requestKey = "default";
                  const inputRequestId = `input_${randomUUID()}`;
                  const inputRequests = {
                    [requestKey]: {
                      method: "elicitation/create",
                      inputRequestId,
                      params: {
                        mode: "form",
                        message: message || "Additional input is required to continue this task.",
                        inputRequestId,
                        requestedSchema: {
                          $schema: "https://json-schema.org/draft/2020-12/schema",
                          type: "object",
                          additionalProperties: true,
                        },
                        _meta: {
                          inputRequestId,
                        },
                      },
                    },
                  };
                  await globalTaskStore.updateTask(taskId, {
                    status: "input_required",
                    inputRequests,
                    lastClientInput: undefined,
                  });
                  const taskSpanMeta = await finishTaskLifecycleSpan(taskId, "input_required", "OK", {
                    "mcp.task.input_request_keys": requestKey,
                    "mcp.task.input_request_id": inputRequestId,
                  });
                  await telemetry.log("task_input_required", { ...telemetryBase, ...taskSpanMeta, taskId, message });
                  const input = await Promise.race([
                    globalNativeTaskRuntime.requestInput(taskId, combinedSignal, requestKey, inputRequestId),
                    waitForTaskStoreInput(taskId, inputRequestId, requestKey, combinedSignal),
                  ]);
                  // I-4.1 fix: handler already holds the input value; wipe inputResponses
                  // from Redis immediately so secrets (OTP, passwords) are not stored at rest.
                  await globalTaskStore.updateTask(taskId, {
                    status: "working",
                    inputRequests: undefined,
                    lastClientInput: { inputRequestId, inputResponses: {}, updatedAt: new Date().toISOString() },
                  });
                  await finishTaskLifecycleSpan(taskId, "working", "OK");
                  return input;
                },
              };
              toolStarted = true;
              const result = await executeTool(tool, cleanArgs, state, combinedSignal, taskExecutionContext);
              const latestTask = await globalTaskStore.getTask(taskId);
              if (latestTask?.status === "cancelled") {
                await globalIdempotencyManager.release(idempotencyKey);
                await finishTaskLifecycleSpan(taskId, "cancelled", "OK");
                const spanMeta = await finishSpan("OK", { taskId, "mcp.task.status": "cancelled" });
                await telemetry.log("task_cancelled", { ...telemetryBase, ...spanMeta, taskId });
                return;
              }
              await saveState(state);
              await globalIdempotencyManager.commit(idempotencyKey, result);
              await globalTaskStore.updateTask(taskId, { status: "completed", result });
              await finishTaskLifecycleSpan(taskId, "completed", "OK");
              const spanMeta = await finishSpan("OK", { taskId, "mcp.task.status": "completed" });
              await telemetry.log("task_completed", { ...telemetryBase, ...spanMeta, taskId });
            } catch (error) {
              if (error instanceof TaskCancelledError || taskController.signal.aborted) {
                await globalIdempotencyManager.release(idempotencyKey);
                const latestTask = await globalTaskStore.getTask(taskId);
                const cancelReason = latestTask?.cancelReason || (error instanceof TaskCancelledError ? error.reason : "cancelled");
                await globalTaskStore.cancelTask(taskId, cancelReason);
                await finishTaskLifecycleSpan(taskId, "cancelled", "OK", { "mcp.task.cancel_reason": cancelReason });
                const spanMeta = await finishSpan("OK", { taskId, "mcp.task.status": "cancelled" });
                await telemetry.log("task_cancelled", { ...telemetryBase, ...spanMeta, taskId, cancelReason });
                return;
              }

              // Fix 1: a started, non-idempotent tool may have left an irreversible
              // external side-effect (e.g. an on-chain escrow tx). Releasing the
              // idempotency record would let an automatic retry double-execute it, so
              // we only release when we are certain nothing happened.
              const mayRelease = canReleaseIdempotency(tool, toolStarted);
              const fenceTask = async (logEvent: string): Promise<void> => {
                const errorResult = makeToolErrorResult(
                  "[KARMA] Task interrupted after a side-effect may have occurred; manual reconciliation required before retry",
                  error,
                );
                await globalIdempotencyManager.commitError(idempotencyKey, errorResult, ENV.MCP_IDEMPOTENCY_ERROR_TTL_SECONDS);
                await globalTaskStore.updateTask(taskId, {
                  status: "failed",
                  result: errorResult,
                  error: String(error),
                  ttlSeconds: ENV.MCP_IDEMPOTENCY_ERROR_TTL_SECONDS,
                });
                await telemetry.log(logEvent, { ...telemetryBase, taskId, error: String(error) });
              };

              if (isExecutionLockError(error)) {
                if (mayRelease) {
                  await globalIdempotencyManager.release(idempotencyKey);
                  await globalTaskStore.deleteTask(taskId);
                } else {
                  await fenceTask("task_fenced_lock_lost");
                }
                await finishSpan("ERROR", { taskId, error: String(error), "mcp.task.status": "lock_lost" });
                throw error;
              }

              await finishTaskLifecycleSpan(taskId, "failed", "ERROR", { error: String(error) });
              const spanMeta = await finishSpan("ERROR", { taskId, error: String(error), "mcp.task.status": "failed" });
              await telemetry.log("task_failed", { ...telemetryBase, ...spanMeta, taskId, error: String(error) });

              if (isTransientError(error)) {
                if (mayRelease) {
                  // Release so the caller can resubmit - transient infra failure with no side-effect.
                  await globalIdempotencyManager.release(idempotencyKey);
                  await globalTaskStore.deleteTask(taskId);
                  await telemetry.log("task_transient_release", { ...telemetryBase, taskId, error: String(error) });
                } else {
                  // Transient failure AFTER a non-idempotent side-effect started: fence, never release.
                  await fenceTask("task_fenced_transient");
                }
              } else {
                // Permanent failure: commit with a short error TTL (not the full result TTL).
                const errorResult = makeToolErrorResult("[KARMA] Task Failed", error);
                await globalIdempotencyManager.commitError(
                  idempotencyKey,
                  errorResult,
                  ENV.MCP_IDEMPOTENCY_ERROR_TTL_SECONDS,
                );
                await globalTaskStore.updateTask(taskId, {
                  status: "failed",
                  result: errorResult,
                  error: String(error),
                  ttlSeconds: ENV.MCP_IDEMPOTENCY_ERROR_TTL_SECONDS,
                });
              }
            } finally {
              stopHeartbeat();
              unregisterTask();
            }
          });
          if (!globalTaskTracker.track(startTask, ENV.MCP_TOOL_TIMEOUT_MS + 60000)) {
            await globalIdempotencyManager.release(idempotencyKey);
            await globalTaskStore.deleteByIdempotencyKey(idempotencyKey);
            taskController.abort(new TaskCancelledError(taskId, "server draining"));
            await finishSpan("ERROR", { taskId, error: "server_draining" });
            throw new Error("[KARMA] Server is shutting down and is not accepting new async tasks.");
          }
          const createdSpanMeta = await finishTaskLifecycleSpan(taskId, "created", "OK");
          await telemetry.log("task_created", { ...telemetryBase, ...createdSpanMeta, taskId });
          return toCreateTaskResult(task);
        }

        if (taskSupport === "required") {
          await globalIdempotencyManager.release(idempotencyKey);
          await finishSpan("ERROR", { error: "client_missing_tasks_extension" });
          throw new Error(`[KARMA] Tool '${tool.name}' requires client support for io.modelcontextprotocol/tasks.`);
        }

        // `return await` (not bare `return`) so a rejection from the locked execution is caught by
        // the A2 chokepoint below rather than escaping the try unsanitized.
        return await globalExecutionLockManager.withTenantLock(tenantId, async (lockSignal) => {
          const signals = [requestSignal, lockSignal].filter(Boolean) as AbortSignal[];
          const combinedSignal = signals.length > 0 ? (signals.length === 1 ? signals[0] : AbortSignal.any(signals)) : undefined;
          // Fix 1: once the handler starts, a non-idempotent side-effect may exist.
          let toolStarted = false;
          try {
            const state = await getState(tenantId, { reload: true });
            toolStarted = true;
            const result = await executeTool(tool, cleanArgs, state, combinedSignal);
            await saveState(state);
            await globalIdempotencyManager.commit(idempotencyKey, result);
            const spanMeta = await finishSpan("OK");
            await telemetry.log("tool_execution_completed", { ...telemetryBase, ...spanMeta });
            return result;
          } catch (error) {
            const spanMeta = await finishSpan("ERROR", { error: String(error) });
            await telemetry.log("tool_execution_failed", { ...telemetryBase, ...spanMeta, error: String(error) });

            if (isExecutionLockError(error) || isTransientError(error)) {
              if (canReleaseIdempotency(tool, toolStarted)) {
                await globalIdempotencyManager.release(idempotencyKey);
                await telemetry.log("tool_execution_transient_release", { ...telemetryBase, error: String(error) });
                throw error;
              }
              // Fix 1: a non-idempotent side-effect may have started; do NOT release.
              // Fall through to commitError so a blind retry cannot double-execute it.
              await telemetry.log("tool_execution_fenced", { ...telemetryBase, error: String(error) });
            }

            // Permanent sync failure (or fenced transient): cache a short-lived error
            // result so exact duplicate retries do not re-run non-idempotent app logic.
            await globalIdempotencyManager.commitError(
              idempotencyKey,
              makeToolErrorResult("[KARMA] Tool Failed", error),
              ENV.MCP_IDEMPOTENCY_ERROR_TTL_SECONDS,
            );
            throw error;
          }
        });
        } catch (error) {
          // PD-006: distinct security signal for tenant→agent spoof attempts (STRIDE-S). telemetryBase
          // is declared inside the try, so rebuild a minimal context here from the request store.
          if (isTenantMismatchError(error)) {
            const errCtx = getRequestContext();
            await telemetry.log("tenant_agent_mismatch", {
              tool: tool.name,
              tenantId: errCtx.tenantId,
              userId: errCtx.userId,
              clientId: errCtx.clientId,
              requestId: errCtx.requestId,
              error: String(error),
            });
          }
          throw toClientError(error);
        }
      }
    );
  }
}
