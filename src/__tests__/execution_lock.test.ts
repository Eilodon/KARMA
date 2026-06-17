import { describe, expect, test, vi } from "vitest";
import { RedisExecutionLockManager } from "../middlewares/execution_lock.js";

describe("RedisExecutionLockManager", () => {
  test("acquires lock and executes operation", async () => {
    const fakeRedis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(1),
    } as any;
    const manager = new RedisExecutionLockManager(fakeRedis);
    const result = await manager.withTenantLock("tenant-1", async (signal) => {
      return "done";
    });
    expect(result).toBe("done");
    expect(fakeRedis.set).toHaveBeenCalled();
  });

  test("rejects immediately when heartbeat loses the lock", async () => {
    vi.useFakeTimers();

    const fakeRedis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValue(0),
    } as any;

    const manager = new RedisExecutionLockManager(fakeRedis);

    const promise = manager.withTenantLock("tenant-1", async (signal) => {
      await new Promise(resolve => signal?.addEventListener("abort", resolve, { once: true }));
      await new Promise(() => undefined);
    });

    const expectPromise = expect(promise).rejects.toThrow(/lock was lost/);

    // Heartbeat is now capped at Math.min(5000, Math.floor(ttlMs/3)) = 5000ms
    await vi.advanceTimersByTimeAsync(5000);

    await expectPromise;
    vi.useRealTimers();
  });

  test("rejects after two consecutive heartbeat errors", async () => {
    vi.useFakeTimers();

    const fakeRedis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn()
        .mockRejectedValueOnce(new Error("redis down"))
        .mockRejectedValueOnce(new Error("redis still down"))
        .mockResolvedValue(1),
    } as any;

    const manager = new RedisExecutionLockManager(fakeRedis);

    const promise = manager.withTenantLock("tenant-1", async () => {
      await new Promise(() => undefined);
    });

    const expectPromise = expect(promise).rejects.toThrow(/heartbeat failed repeatedly/);

    // Two consecutive heartbeat failures at 5000ms intervals = 10000ms
    await vi.advanceTimersByTimeAsync(10000);

    await expectPromise;
    vi.useRealTimers();
  });

  // Fix 2: a lost lock must NOT be deleted, because the operation may still be running
  // as an orphan we cannot kill. Deleting the key would let a concurrent op acquire it
  // and run alongside the orphan, breaking tenant mutual-exclusion. Let TTL expire it.
  test("Fix 2: does not run the release DEL when the heartbeat loses the lock", async () => {
    vi.useFakeTimers();

    const evalScripts: string[] = [];
    const fakeRedis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockImplementation((script: string) => {
        evalScripts.push(script);
        return Promise.resolve(0); // heartbeat: GET != token → lock lost
      }),
    } as any;

    const manager = new RedisExecutionLockManager(fakeRedis);

    const promise = manager.withTenantLock("tenant-2", async (signal) => {
      await new Promise(resolve => signal?.addEventListener("abort", resolve, { once: true }));
      await new Promise(() => undefined); // orphan that never resolves
    });

    const expectPromise = expect(promise).rejects.toThrow(/lock was lost/);
    await vi.advanceTimersByTimeAsync(5000);
    await expectPromise;
    vi.useRealTimers();

    // Only heartbeat (PEXPIRE) scripts should have run; the release (DEL) must be skipped.
    expect(evalScripts.length).toBeGreaterThan(0);
    expect(evalScripts.some(s => s.includes("DEL"))).toBe(false);
  });

  // Fix 3: a transient Redis blip during acquisition is retried within the deadline.
  test("Fix 3: retries acquisition after a transient redis error, then succeeds", async () => {
    const fakeRedis = {
      set: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
        .mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(1),
    } as any;

    const manager = new RedisExecutionLockManager(fakeRedis, 10000);
    const result = await manager.withTenantLock("tenant-3", async () => "done");

    expect(result).toBe("done");
    expect(fakeRedis.set).toHaveBeenCalledTimes(2);
  });

  // Fix 3: a permanent error (auth/syntax) must NOT spin until the deadline — rethrow now.
  test("Fix 3: rethrows a permanent redis error immediately without retrying", async () => {
    const fakeRedis = {
      set: vi.fn().mockRejectedValue(new Error("NOAUTH Authentication required")),
      eval: vi.fn(),
    } as any;

    const manager = new RedisExecutionLockManager(fakeRedis, 10000);
    await expect(manager.withTenantLock("tenant-4", async () => "x")).rejects.toThrow(/NOAUTH/);
    expect(fakeRedis.set).toHaveBeenCalledTimes(1);
  });
});
