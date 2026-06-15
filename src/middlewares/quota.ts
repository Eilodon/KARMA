import { ENV } from "../config/env.js";
import type { Redis } from "ioredis";
import { getRedisClient } from "../storage/redis_client.js";

export interface QuotaResult {
  allowed: boolean;
  used: number;
  resetAt: Date;
}

export interface IQuotaManager {
  check(tenantId: string): Promise<QuotaResult>;
  close?(): Promise<void>;
}

function getResetTime(): Date {
  const resetTime = new Date();
  resetTime.setUTCHours(24, 0, 0, 0);
  return resetTime;
}

class MemoryQuotaManager implements IQuotaManager {
  private usage = new Map<string, { count: number; resetAt: number }>();

  async check(tenantId: string): Promise<QuotaResult> {
    const now = Date.now();
    const resetTime = getResetTime();
    if (!ENV.ENABLE_QUOTA) return { allowed: true, used: 0, resetAt: resetTime };

    for (const [key, value] of this.usage.entries()) {
      if (value.resetAt < now) this.usage.delete(key);
    }

    let record = this.usage.get(tenantId);
    if (!record || record.resetAt < now) {
      record = { count: 0, resetAt: resetTime.getTime() };
    }

    if (record.count >= ENV.QUOTA_DAILY_LIMIT) {
      this.usage.set(tenantId, record);
      return { allowed: false, used: record.count, resetAt: new Date(record.resetAt) };
    }

    record.count++;
    this.usage.set(tenantId, record);
    return { allowed: true, used: record.count, resetAt: new Date(record.resetAt) };
  }
}

class RedisQuotaManager implements IQuotaManager {
  private redis: Redis;

  constructor() {
    this.redis = getRedisClient();
  }

  async check(tenantId: string): Promise<QuotaResult> {
    const resetTime = getResetTime();
    if (!ENV.ENABLE_QUOTA) return { allowed: true, used: 0, resetAt: resetTime };

    const key = `karma:quota:${ENV.MCP_PROJECT_ID}:${tenantId}`;
    const ttlSeconds = Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));

    const script = `
      local count = tonumber(redis.call('GET', KEYS[1]) or '0')
      local limit = tonumber(ARGV[2])
      if count >= limit then
        return {0, count}
      end
      count = redis.call('INCR', KEYS[1])
      if count == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return {1, count}
    `;
    const result = await this.redis.eval(script, 1, key, ttlSeconds, ENV.QUOTA_DAILY_LIMIT) as [number, number];
    const allowed = Number(result[0]) === 1;
    return { allowed, used: Number(result[1]), resetAt: resetTime };
  }

  async close(): Promise<void> {}
}

export const globalQuotaManager: IQuotaManager = ENV.STORAGE_DRIVER === "redis"
  ? new RedisQuotaManager()
  : new MemoryQuotaManager();
