import { describe, expect, test, vi } from "vitest";
import {
  canReleaseIdempotency,
  isIdempotentTool,
  isTransientError,
} from "../mcp/adapter/execution_pipeline.js";
import { TaskTracker } from "../core/task_tracker.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

function tool(annotations: Record<string, unknown>): ToolDefinition {
  return { annotations } as unknown as ToolDefinition;
}

describe("Fix 1: idempotency release gate (split-brain / double-execution)", () => {
  const writeTool = tool({ readOnlyHint: false, idempotentHint: false });
  const readTool = tool({ readOnlyHint: true, idempotentHint: true });
  const idempotentWriteTool = tool({ readOnlyHint: false, idempotentHint: true });
  const noAnnotations = tool({});

  test("a never-started tool can always release (nothing happened yet)", () => {
    expect(canReleaseIdempotency(writeTool, false)).toBe(true);
    expect(canReleaseIdempotency(noAnnotations, false)).toBe(true);
  });

  test("a started non-idempotent tool must NOT release (a blind retry would double-execute)", () => {
    expect(canReleaseIdempotency(writeTool, true)).toBe(false);
    // default-deny: a tool with no hints is treated as non-idempotent once started
    expect(canReleaseIdempotency(noAnnotations, true)).toBe(false);
  });

  test("a started read-only or idempotent tool may still release (retry is harmless)", () => {
    expect(canReleaseIdempotency(readTool, true)).toBe(true);
    expect(canReleaseIdempotency(idempotentWriteTool, true)).toBe(true);
  });

  test("isIdempotentTool reflects readOnly/idempotent annotations", () => {
    expect(isIdempotentTool(readTool)).toBe(true);
    expect(isIdempotentTool(idempotentWriteTool)).toBe(true);
    expect(isIdempotentTool(writeTool)).toBe(false);
    expect(isIdempotentTool(noAnnotations)).toBe(false);
  });
});

describe("Fix 3: transient error classification", () => {
  test("a lock-acquisition failure is transient (nothing executed → clean retry)", () => {
    expect(isTransientError(new Error("[KARMA] Could not acquire tenant execution lock for t1"))).toBe(true);
  });

  test("a tool timeout is transient", () => {
    expect(isTransientError(new Error("[KARMA] Tool timed out after 300000ms"))).toBe(true);
  });

  test("a nested ECONNRESET cause is transient", () => {
    const err = new Error("save failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    expect(isTransientError(err)).toBe(true);
  });

  test("a plain logic error is NOT transient", () => {
    expect(isTransientError(new Error("validation failed: missing field"))).toBe(false);
  });
});

describe("Fix 4 / ADR-006: TaskTracker gates start behind the draining flag", () => {
  test("does not start the thunk when draining", () => {
    const tracker = new TaskTracker();
    tracker.beginDraining();
    const thunk = vi.fn(() => Promise.resolve());
    expect(tracker.track(thunk)).toBe(false);
    expect(thunk).not.toHaveBeenCalled();
  });

  test("starts the thunk exactly once when not draining", async () => {
    const tracker = new TaskTracker();
    const thunk = vi.fn(() => Promise.resolve());
    expect(tracker.track(thunk)).toBe(true);
    expect(thunk).toHaveBeenCalledTimes(1);
    await tracker.awaitAll(1000);
  });

  test("clears the hard-timeout timer once a task settles (no timer leak)", async () => {
    const tracker = new TaskTracker();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    expect(tracker.track(() => Promise.resolve("ok"))).toBe(true);
    await tracker.awaitAll(1000);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
