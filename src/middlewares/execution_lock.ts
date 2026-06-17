import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { ENV } from "../config/env.js";
import { getRedisClient } from "../storage/redis_client.js";

export interface IExecutionLockManager {
  withTenantLock<T>(tenantId: string, operation: (signal?: AbortSignal) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

const localQueues = new Map<string, Promise<unknown>>();

/**
 * Fix 3: a transient Redis blip (failover, brief network drop, replica promotion)
 * during lock acquisition should be retried within the acquire deadline rather than
 * aborting the whole attempt. Permanent errors (auth, script syntax) rethrow at once.
 */
function isRetriableRedisError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "EAI_AGAIN"].includes(code)) {
    return true;
  }
  const message = String(error instanceof Error ? error.message : error);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|connection|timed? ?out|timeout|stream isn't writeable|connection is closed|max retries|READONLY/i.test(message);
}

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
    return `karma:lock:${ENV.MCP_PROJECT_ID}:${tenantId}`;
  }

  async withTenantLock<T>(tenantId: string, operation: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    return enqueueLocal(tenantId, async () => {
      const key = this.getKey(tenantId);
      const token = randomUUID();
      const deadline = Date.now() + this.acquireDeadlineMs;

      while (Date.now() < deadline) {
        let acquired: string | null;
        try {
          acquired = await this.redis.set(key, token, "PX", this.ttlMs, "NX");
        } catch (error) {
          // Fix 3: keep retrying within the acquire deadline on a transient blip;
          // rethrow a permanent error immediately rather than spinning until deadline.
          if (!isRetriableRedisError(error)) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
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
                abortLock(new Error("[KARMA] Tenant execution lock was lost."));
                return;
              }
              consecutiveHeartbeatFailures = 0;
            } catch (err) {
              consecutiveHeartbeatFailures += 1;
              console.error("[KARMA] Failed to refresh tenant execution lock:", err);
              if (consecutiveHeartbeatFailures >= 2) {
                abortLock(new Error("[KARMA] Tenant execution lock heartbeat failed repeatedly."));
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
            // Fix 2: only release the lock on a clean exit. `controller` is aborted
            // solely by abortLock (lock lost / heartbeat failed repeatedly). In that
            // case the operation may still be running as an orphan we cannot kill, so
            // deleting the key would let a concurrent op acquire it and run alongside
            // the orphan — breaking tenant mutual-exclusion. Leave the key to expire by
            // its TTL instead. The DEL is token-checked, so a clean exit never deletes a
            // lock that already rolled over to another owner.
            if (!controller.signal.aborted) {
              const releaseScript = `
                if redis.call('GET', KEYS[1]) == ARGV[1] then
                  return redis.call('DEL', KEYS[1])
                end
                return 0
              `;
              await this.redis.eval(releaseScript, 1, key, token).catch(() => undefined);
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      throw new Error(`[KARMA] Could not acquire tenant execution lock for ${tenantId}`);
    });
  }

  async close(): Promise<void> {}
}

export const globalExecutionLockManager: IExecutionLockManager = ENV.STORAGE_DRIVER === "redis"
  ? new RedisExecutionLockManager()
  : new MemoryExecutionLockManager();
