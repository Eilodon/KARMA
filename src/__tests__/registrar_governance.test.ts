import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("registrar system tool governance", () => {
  test("registrar does not expose legacy check_task_status", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");
    expect(source).not.toContain("check_task_status");
    expect(source).not.toContain("registerStatusBridge");
  });

  test("async lock loss releases idempotency instead of committing failure result (NF-02)", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");

    expect(source).toContain("isExecutionLockError");
    expect(source).toContain("await globalIdempotencyManager.release(idempotencyKey)");
    // Lock error check must precede the transient-error branch
    expect(source.indexOf("if (isExecutionLockError(error))")).toBeLessThan(
      source.indexOf("if (isTransientError(error))")
    );
    // Permanent async failures commit with a short error TTL via commitError
    expect(source).toContain("globalIdempotencyManager.commitError(");
    expect(source).toContain("ENV.MCP_IDEMPOTENCY_ERROR_TTL_SECONDS");
  });

  // NF-02: async task transport signal leak
  test("native task branch does not include extra.signal in AbortSignal chain (NF-02)", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");

    const asyncBranchStart = source.indexOf('if (taskSupport !== "forbidden" && supportsNativeTasks)');
    expect(asyncBranchStart).toBeGreaterThan(0);

    const syncPathStart = source.indexOf("return globalExecutionLockManager.withTenantLock(tenantId,", asyncBranchStart);
    expect(syncPathStart).toBeGreaterThan(asyncBranchStart);

    const asyncBranch = source.slice(asyncBranchStart, syncPathStart);
    const syncBranch = source.slice(syncPathStart, syncPathStart + 300);

    const asyncSignalsMatch = asyncBranch.match(/const signals\s*=\s*\[([^\]]+)\]\.filter\(Boolean\)/);
    expect(asyncSignalsMatch).not.toBeNull();
    expect(asyncSignalsMatch![1]).not.toContain("extra.signal");
    expect(asyncSignalsMatch![1]).toContain("lockSignal");

    const syncSignalsMatch = syncBranch.match(/const signals\s*=\s*\[([^\]]+)\]\.filter\(Boolean\)/);
    expect(syncSignalsMatch).not.toBeNull();
    expect(syncSignalsMatch![1]).toContain("requestSignal");
    expect(syncSignalsMatch![1]).toContain("lockSignal");
  });

  test("async task start creates public handle before spawning taskPromise (NF-03)", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");

    const createCall = source.indexOf("globalTaskStore.createTask({");
    const taskPromise = source.indexOf("const taskPromise = globalExecutionLockManager");
    expect(createCall).toBeGreaterThan(0);
    expect(taskPromise).toBeGreaterThan(0);
    expect(createCall).toBeLessThan(taskPromise);

    // Return value carries a native CreateTaskResult, not a legacy text polling instruction.
    expect(source).toContain("return toCreateTaskResult(task)");
    expect(source).not.toContain("job_id: ${idempotencyKey}");

    // Drain rejection cleans up the store entry to avoid stale handles
    expect(source).toContain("globalTaskStore.deleteByIdempotencyKey(idempotencyKey)");
  });

  test("native task branch registers abort controller and avoids cancelled-to-completed race", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");

    expect(source).toContain("globalNativeTaskRuntime.register(taskId, taskController)");
    expect(source).toContain("taskController.signal");
    expect(source).toContain('latestTask?.status === "cancelled"');
    expect(source).toContain("TaskCancelledError");
    expect(source).toContain('telemetry.log("task_cancelled"');
  });

  test("raw MCP method registration fails closed when SDK hook is unavailable", async () => {
    const source = await readFile(new URL("../mcp/adapter/mcp_protocol_adapter.ts", import.meta.url), "utf-8");
    expect(source).toContain("cannot register MCP method");
    expect(source).not.toContain("rawServer?.setRequestHandler?.");
  });

  test("dedup polling path uses reverse-lookup findTaskId for the task_id (NF-03)", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");
    expect(source).toContain("await globalTaskStore.findTaskId(idempotencyKey)");
    expect(source).toContain("return toCreateTaskResult(existingTask)");
  });

  // NF-05: retryable error policy
  test("isTransientError covers network codes and message patterns (NF-05)", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");

    expect(source).toContain("isTransientError");
    expect(source).toContain("ECONNREFUSED");
    expect(source).toContain("ECONNRESET");
    expect(source).toContain("ETIMEDOUT");

    // Transient → release; permanent → commitError
    const transientIdx = source.indexOf("if (isTransientError(error))");
    const releaseIdx  = source.indexOf("globalIdempotencyManager.release(idempotencyKey)", transientIdx);
    const commitErrIdx = source.indexOf("globalIdempotencyManager.commitError(", transientIdx);
    expect(transientIdx).toBeGreaterThan(0);
    expect(releaseIdx).toBeGreaterThan(transientIdx);
    expect(commitErrIdx).toBeGreaterThan(transientIdx);
  });

  test("sync path applies retryable error policy before caching permanent failures (NF-05)", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");
    const syncPathStart = source.indexOf("return globalExecutionLockManager.withTenantLock(tenantId,");
    const syncBranch = source.slice(syncPathStart);

    expect(syncBranch).toContain("if (isExecutionLockError(error) || isTransientError(error))");
    expect(syncBranch).toContain("globalIdempotencyManager.release(idempotencyKey)");
    expect(syncBranch).toContain("globalIdempotencyManager.commitError(");
    expect(syncBranch).toContain("ENV.MCP_IDEMPOTENCY_ERROR_TTL_SECONDS");

    const transientIdx = syncBranch.indexOf("if (isExecutionLockError(error) || isTransientError(error))");
    const commitIdx = syncBranch.indexOf("globalIdempotencyManager.commitError(");
    expect(transientIdx).toBeGreaterThan(0);
    expect(commitIdx).toBeGreaterThan(transientIdx);
  });
});
