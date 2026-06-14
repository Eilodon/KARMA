import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { ENV } from "../config/env.js";
import { getRedisClient } from "../storage/redis_client.js";

export interface IExecutionLockManager {
  withTenantLock<T>(tenantId: string, operation: (signal?: AbortSignal) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

const localQueues = new Map<string, Promise<unknown>>();

async function enqueueLocal<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
  const previous = localQueues.get(tenantId) || Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  localQueues.set(tenantId, next);
  try {
    return await next;
  } finally {
    if (localQueues.get(tenantId) === next) {
      localQueues.delete(tenantId);
    }
  }
}

class MemoryExecutionLockManager implements IExecutionLockManager {
  async withTenantLock<T>(tenantId: string, operation: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    return enqueueLocal(tenantId, () => operation());
  }
}

export class RedisExecutionLockManager implements IExecutionLockManager {
  private redis: Redis;
  private readonly ttlMs = ENV.MCP_LOCK_TTL_MS;
  private readonly acquireDeadlineMs: number;

  constructor(redisClient?: Redis, acquireDeadlineMs?: number) {
    this.redis = redisClient || getRedisClient();
    this.acquireDeadlineMs = acquireDeadlineMs ?? ENV.MCP_LOCK_ACQUIRE_DEADLINE_MS;
  }

  private getKey(tenantId: string): string {
    return `super_mcp:lock:${ENV.MCP_PROJECT_ID}:${tenantId}`;
  }

  async withTenantLock<T>(tenantId: string, operation: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    return enqueueLocal(tenantId, async () => {
      const key = this.getKey(tenantId);
      const token = randomUUID();
      const deadline = Date.now() + this.acquireDeadlineMs;

      while (Date.now() < deadline) {
        const acquired = await this.redis.set(key, token, "PX", this.ttlMs, "NX");
        if (acquired === "OK") {
          let stopped = false;
          let consecutiveHeartbeatFailures = 0;
          let refreshInFlight = false;
          const controller = new AbortController();

          let rejectLockLost!: (error: Error) => void;
          const lockLost = new Promise<never>((_, reject) => {
            rejectLockLost = reject;
          });
          lockLost.catch(() => {}); // prevent unhandled rejection warning

          function abortLock(error: Error): void {
            if (!controller.signal.aborted) {
              controller.abort(error);
              rejectLockLost(error);
            }
          }


          const heartbeat = setInterval(async () => {
            if (stopped || refreshInFlight) return;
            refreshInFlight = true;
            try {
              const script = `
                if redis.call('GET', KEYS[1]) == ARGV[1] then
                  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
                end
                return 0
              `;
              const result = await this.redis.eval(script, 1, key, token, this.ttlMs);
              if (Number(result) !== 1) {
                abortLock(new Error("[SUPER-MCP] Tenant execution lock was lost."));
                return;
              }
              consecutiveHeartbeatFailures = 0;
            } catch (err) {
              consecutiveHeartbeatFailures += 1;
              console.error("[SUPER-MCP] Failed to refresh tenant execution lock:", err);
              if (consecutiveHeartbeatFailures >= 2) {
                abortLock(new Error("[SUPER-MCP] Tenant execution lock heartbeat failed repeatedly."));
              }
            } finally {
              refreshInFlight = false;
            }
          }, Math.min(5000, Math.max(1000, Math.floor(this.ttlMs / 3))));

          try {
            return await Promise.race([
              operation(controller.signal),
              lockLost,
            ]);
          } finally {
            stopped = true;
            clearInterval(heartbeat);
            const releaseScript = `
              if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
              end
              return 0
            `;
            await this.redis.eval(releaseScript, 1, key, token).catch(() => undefined);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      throw new Error(`[SUPER-MCP] Could not acquire tenant execution lock for ${tenantId}`);
    });
  }

  async close(): Promise<void> {}
}

export const globalExecutionLockManager: IExecutionLockManager = ENV.STORAGE_DRIVER === "redis"
  ? new RedisExecutionLockManager()
  : new MemoryExecutionLockManager();
