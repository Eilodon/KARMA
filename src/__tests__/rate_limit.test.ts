import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

async function importRateLimiterWithRateLimit() {
  vi.resetModules();
  vi.stubEnv("ENABLE_RATE_LIMIT", "true");
  vi.stubEnv("RATE_LIMIT_WINDOW_MS", "100");
  const mod = await import("../middlewares/rate_limit.js");
  return mod.MemoryRateLimiter;
}

describe("MemoryRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  test("does not sweep records on check and cleans them in background", async () => {
    vi.useFakeTimers();
    const MemoryRateLimiter = await importRateLimiterWithRateLimit();
    const limiter = new MemoryRateLimiter();

    await limiter.check("tenant-1");

    const records = (limiter as any).records as Map<string, unknown>;
    expect(records.size).toBe(1);

    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(records.size).toBe(0);

    await limiter.close();
    vi.useRealTimers();
  });
});

