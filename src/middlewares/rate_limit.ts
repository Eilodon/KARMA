import { ENV } from "../config/env.js";
import type { Redis } from "ioredis";
import { getRedisClient } from "../storage/redis_client.js";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export interface IRateLimiter {
  check(tenantId: string): Promise<RateLimitResult>;
  close?(): Promise<void>;
}

export class MemoryRateLimiter implements IRateLimiter {
  private cleanupTimer?: NodeJS.Timeout;
  private records = new Map<string, {
    windowStart: number;
    count: number;
    severityEma: number;
    backoffEndsAt: number;
    violationCount: number;
    updatedAt: number;
  }>();

  constructor() {
    if (ENV.ENABLE_RATE_LIMIT) {
      this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
      this.cleanupTimer.unref?.();
    }
  }

  private cleanupExpired(now = Date.now()): void {
    const ttlMs = Math.max(ENV.RATE_LIMIT_WINDOW_MS * 2, 24 * 60 * 60 * 1000);
    for (const [key, record] of this.records.entries()) {
      if (record.backoffEndsAt <= now && now - record.updatedAt > ttlMs) {
        this.records.delete(key);
      }
    }
  }

  async check(tenantId: string): Promise<RateLimitResult> {
    if (!ENV.ENABLE_RATE_LIMIT) return { allowed: true };

    const now = Date.now();

    let record = this.records.get(tenantId);
    if (!record) {
      record = { windowStart: now, count: 0, severityEma: 0, backoffEndsAt: 0, violationCount: 0, updatedAt: now };
      this.records.set(tenantId, record);
    }

    record.updatedAt = now;
    if (record.backoffEndsAt > now) {
      return { allowed: false, retryAfterMs: record.backoffEndsAt - now };
    }

    if (now - record.windowStart >= ENV.RATE_LIMIT_WINDOW_MS) {
      record.windowStart = now;
      record.count = 0;
    }

    record.count += 1;
    if (record.count > ENV.RATE_LIMIT_MAX_REQUESTS) {
      record.violationCount += 1;
      record.severityEma = (record.severityEma * 0.8) + 0.2;
      const backoffBaseMs = 60 * 60 * 1000;
      const backoffCapMs = 24 * 60 * 60 * 1000;
      const backoffMs = Math.min(backoffCapMs, backoffBaseMs * (2 ** Math.min(record.violationCount - 1, 5)));
      record.backoffEndsAt = now + backoffMs;
      return { allowed: false, retryAfterMs: backoffMs };
    }

    return { allowed: true };
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

class RedisRateLimiter implements IRateLimiter {
  private redis: Redis;

  constructor() {
    this.redis = getRedisClient();
  }

  async check(tenantId: string): Promise<RateLimitResult> {
    if (!ENV.ENABLE_RATE_LIMIT) return { allowed: true };

    const now = Date.now();
    const key = `super_mcp:ratelimit:trauma:${ENV.MCP_PROJECT_ID}:${tenantId}`;
    const ttlMs = Math.max(ENV.RATE_LIMIT_WINDOW_MS * 2, 25 * 60 * 60 * 1000);
    const backoffBaseMs = 60 * 60 * 1000;
    const backoffCapMs = 24 * 60 * 60 * 1000;

    const script = `
      local now = tonumber(ARGV[1])
      local windowMs = tonumber(ARGV[2])
      local maxReqs = tonumber(ARGV[3])
      local ttlMs = tonumber(ARGV[4])
      local backoffBaseMs = tonumber(ARGV[5])
      local backoffCapMs = tonumber(ARGV[6])

      local windowStart = tonumber(redis.call('HGET', KEYS[1], 'window_start') or now)
      local count = tonumber(redis.call('HGET', KEYS[1], 'count') or 0)
      local severityEma = tonumber(redis.call('HGET', KEYS[1], 'severity_ema') or 0)
      local backoffEndsAt = tonumber(redis.call('HGET', KEYS[1], 'backoff_ends_at') or 0)
      local violationCount = tonumber(redis.call('HGET', KEYS[1], 'violation_count') or 0)

      if backoffEndsAt > now then
        redis.call('PEXPIRE', KEYS[1], ttlMs)
        return {0, backoffEndsAt - now}
      end

      if now - windowStart >= windowMs then
        windowStart = now
        count = 0
      end

      count = count + 1
      if count > maxReqs then
        violationCount = violationCount + 1
        severityEma = (severityEma * 0.8) + 0.2
        local exponent = math.min(violationCount - 1, 5)
        local backoffMs = math.min(backoffCapMs, backoffBaseMs * (2 ^ exponent))
        backoffEndsAt = now + backoffMs
        redis.call(
          'HMSET',
          KEYS[1],
          'window_start', windowStart,
          'count', count,
          'severity_ema', severityEma,
          'backoff_ends_at', backoffEndsAt,
          'violation_count', violationCount,
          'updated_at', now
        )
        redis.call('PEXPIRE', KEYS[1], ttlMs)
        return {0, backoffMs}
      end

      redis.call(
        'HMSET',
        KEYS[1],
        'window_start', windowStart,
        'count', count,
        'severity_ema', severityEma,
        'backoff_ends_at', backoffEndsAt,
        'violation_count', violationCount,
        'updated_at', now
      )
      redis.call('PEXPIRE', KEYS[1], ttlMs)
      return {1, 0}
    `;

    const result = await this.redis.eval(
      script,
      1,
      key,
      now.toString(),
      ENV.RATE_LIMIT_WINDOW_MS.toString(),
      ENV.RATE_LIMIT_MAX_REQUESTS.toString(),
      ttlMs.toString(),
      backoffBaseMs.toString(),
      backoffCapMs.toString()
    ) as [number, number];

    if (result[0] !== 1) {
      return { allowed: false, retryAfterMs: Math.max(0, result[1]) };
    }
    return { allowed: true };
  }

  async close(): Promise<void> {}
}

export const globalRateLimiter: IRateLimiter = ENV.STORAGE_DRIVER === "redis" 
  ? new RedisRateLimiter() 
  : new MemoryRateLimiter();
