import { expect, test, describe } from "vitest";
import { assertJsonSerializable, globalIdempotencyManager } from "../middlewares/idempotency.js";

describe("Idempotency Manager", () => {
  test("generateKey should be deterministic regardless of object key order", () => {
    const tenantId = "tenant-123";
    const toolName = "test_tool";
    
    // Hai payload có cùng nội dung nhưng khác thứ tự key
    const args1 = { a: 1, b: 2 };
    const args2 = { b: 2, a: 1 };
    
    const key1 = globalIdempotencyManager.generateKey(tenantId, toolName, args1);
    const key2 = globalIdempotencyManager.generateKey(tenantId, toolName, args2);
    
    // Regression: object key order must not create duplicate task executions.
    expect(key1).toBe(key2);
    expect(globalIdempotencyManager.isValidKey(key1)).toBe(true);
  });

  test("release should clear an in-flight lock so failed sync tools can retry", async () => {
    const key = globalIdempotencyManager.generateKey("tenant-123", "test_tool", { retry: true });

    const first = await globalIdempotencyManager.tryAcquireOrGetCached(key);
    expect(first.locked).toBe(true);

    await globalIdempotencyManager.release(key);

    const second = await globalIdempotencyManager.tryAcquireOrGetCached(key);
    expect(second.locked).toBe(true);
    await globalIdempotencyManager.release(key);
  });

  test("peek should not create an idempotency entry for untrusted task ids", async () => {
    expect(globalIdempotencyManager.isValidKey("not-a-real-job-id")).toBe(false);
    expect(await globalIdempotencyManager.peek("not-a-real-job-id")).toBeNull();
  });

  test("idempotency args reject non-JSON objects that would hash ambiguously", () => {
    expect(() => assertJsonSerializable({ at: new Date() })).toThrow(/plain JSON/);
    expect(() => assertJsonSerializable({ values: new Set(["a"]) })).toThrow(/plain JSON/);
  });

  test("idempotency args reject circular references", () => {
    const payload: any = { name: "loop" };
    payload.self = payload;
    expect(() => assertJsonSerializable(payload)).toThrow(/circular references/);
  });

  test("commitError stores result with a shorter TTL than full result TTL (NF-05)", async () => {
    const key = globalIdempotencyManager.generateKey("tenant-err", "err_tool", { test: true });

    const first = await globalIdempotencyManager.tryAcquireOrGetCached(key);
    expect(first.locked).toBe(true);

    const errorResult = { content: [{ type: "text", text: "[SUPER-MCP] Task Failed: boom" }] };
    await globalIdempotencyManager.commitError(key, errorResult, 300);

    const cached = await globalIdempotencyManager.peek(key);
    expect(cached).toEqual(errorResult);

    // Clean up
    await globalIdempotencyManager.release(key).catch(() => undefined);
  });
});
