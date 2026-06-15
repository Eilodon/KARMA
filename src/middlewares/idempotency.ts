import { createHash, createHmac } from "node:crypto";
import { ENV } from "../config/env.js";
import type { Redis } from "ioredis";
import { getRedisClient } from "../storage/redis_client.js";

export function assertJsonSerializable(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (value === null) return;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") return;
  if (valueType === "bigint" || valueType === "function" || valueType === "symbol" || valueType === "undefined") {
    throw new Error(`[KARMA] Idempotency args must be JSON-serializable. Invalid value at ${path}.`);
  }
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new Error(`[KARMA] Idempotency args must be plain JSON, not ${value.constructor.name}, at ${path}.`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`[KARMA] Idempotency args must not contain circular references at ${path}.`);
    seen.add(value);
    value.forEach((item, index) => assertJsonSerializable(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (valueType === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`[KARMA] Idempotency args must be plain JSON objects at ${path}.`);
    }
    if (seen.has(value as object)) throw new Error(`[KARMA] Idempotency args must not contain circular references at ${path}.`);
    seen.add(value as object);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSerializable(child, `${path}.${key}`, seen);
    }
    seen.delete(value as object);
  }
}

const MAX_STRINGIFY_DEPTH = 50;

export function deterministicStringify(obj: unknown, depth = 0): string {
  // MISS-2 fix: cap recursion depth to prevent stack overflow on attacker-crafted deep JSON.
  if (depth > MAX_STRINGIFY_DEPTH) return '"[MAX_DEPTH]"';
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(item => deterministicStringify(item, depth + 1)).join(",")}]`;
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const props = keys.map(k => `"${k}":${deterministicStringify(record[k], depth + 1)}`).join(",");
  return `{${props}}`;
}

// S-1.2 fix: use HMAC when MCP_IDEMPOTENCY_SECRET is set so an attacker with Redis
// write access cannot predict or forge valid idempotency keys.
function hashPayload(payload: string): string {
  const secret = ENV.MCP_IDEMPOTENCY_SECRET;
  return secret
    ? createHmac("sha256", secret).update(payload).digest("hex")
    : createHash("sha256").update(payload).digest("hex");
}

export interface IIdempotencyManager {
  generateKey(tenantId: string, toolName: string, args: unknown, owner?: string): string;
  isValidKey(idempotencyKey: string): boolean;
  peek(idempotencyKey: string): Promise<unknown>;
  tryAcquireOrGetCached(idempotencyKey: string): Promise<{ locked: boolean; cached?: unknown }>;
  commit(idempotencyKey: string, result: unknown): Promise<void>;
  /** Commit an error result with a shorter, configurable TTL (vs. full result TTL). */
  commitError(idempotencyKey: string, result: unknown, errorTtlSeconds: number): Promise<void>;
  release(idempotencyKey: string): Promise<void>;
  extendWorking?(idempotencyKey: string): Promise<void>;
  close?(): Promise<void>;
}

function keyPrefix(): string {
  return `karma:idempotency:${ENV.MCP_PROJECT_ID}:`;
}

function makeKey(hash: string): string {
  return `${keyPrefix()}${hash}`;
}

function workingRecord() {
  return { status: "working", startedAt: new Date().toISOString() };
}

function isWorkingRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).status === "working";
}

class MemoryIdempotencyManager implements IIdempotencyManager {
  private cache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly resultTtlMs = ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS * 1000;
  private readonly workingTtlMs = ENV.MCP_IDEMPOTENCY_WORKING_TTL_SECONDS * 1000;

  private cleanup(key?: string): void {
    const now = Date.now();
    if (key) {
      const entry = this.cache.get(key);
      if (entry && entry.expiresAt <= now) this.cache.delete(key);
      return;
    }
    for (const [k, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) this.cache.delete(k);
    }
  }

  generateKey(tenantId: string, toolName: string, args: unknown, owner = "anonymous"): string {
    assertJsonSerializable(args);
    const payload = deterministicStringify({ tenantId, toolName, owner, args });
    return makeKey(hashPayload(payload));
  }

  isValidKey(idempotencyKey: string): boolean {
    return idempotencyKey.startsWith(keyPrefix()) && /^[a-f0-9]{64}$/.test(idempotencyKey.slice(keyPrefix().length));
  }

  async peek(idempotencyKey: string): Promise<unknown> {
    if (!this.isValidKey(idempotencyKey)) return null;
    this.cleanup(idempotencyKey);
    return this.cache.get(idempotencyKey)?.value ?? null;
  }

  async tryAcquireOrGetCached(idempotencyKey: string): Promise<{ locked: boolean; cached?: unknown }> {
    if (!this.isValidKey(idempotencyKey)) throw new Error("Invalid idempotency key format");
    this.cleanup(idempotencyKey);
    if (this.cache.has(idempotencyKey)) {
      return { locked: false, cached: this.cache.get(idempotencyKey)?.value };
    }
    this.cache.set(idempotencyKey, { value: workingRecord(), expiresAt: Date.now() + this.workingTtlMs });
    this.cleanup();
    return { locked: true };
  }

  async commit(idempotencyKey: string, result: unknown): Promise<void> {
    if (!this.isValidKey(idempotencyKey)) throw new Error("Invalid idempotency key format");
    this.cache.set(idempotencyKey, { value: result, expiresAt: Date.now() + this.resultTtlMs });
    this.cleanup();
  }

  async commitError(idempotencyKey: string, result: unknown, errorTtlSeconds: number): Promise<void> {
    if (!this.isValidKey(idempotencyKey)) throw new Error("Invalid idempotency key format");
    this.cache.set(idempotencyKey, { value: result, expiresAt: Date.now() + errorTtlSeconds * 1000 });
    this.cleanup();
  }

  async release(idempotencyKey: string): Promise<void> {
    const cached = await this.peek(idempotencyKey);
    if (isWorkingRecord(cached)) {
      this.cache.delete(idempotencyKey);
    }
  }

  async extendWorking(idempotencyKey: string): Promise<void> {
    const cached = await this.peek(idempotencyKey);
    if (isWorkingRecord(cached)) {
      this.cache.set(idempotencyKey, { value: cached, expiresAt: Date.now() + this.workingTtlMs });
    }
  }
}

class RedisIdempotencyManager implements IIdempotencyManager {
  private redis: Redis;
  private readonly resultTtlSeconds = ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS;
  private readonly workingTtlSeconds = ENV.MCP_IDEMPOTENCY_WORKING_TTL_SECONDS;

  constructor() {
    this.redis = getRedisClient();
  }

  generateKey(tenantId: string, toolName: string, args: unknown, owner = "anonymous"): string {
    assertJsonSerializable(args);
    const payload = deterministicStringify({ tenantId, toolName, owner, args });
    return makeKey(hashPayload(payload));
  }

  isValidKey(idempotencyKey: string): boolean {
    return idempotencyKey.startsWith(keyPrefix()) && /^[a-f0-9]{64}$/.test(idempotencyKey.slice(keyPrefix().length));
  }

  async peek(idempotencyKey: string): Promise<unknown> {
    if (!this.isValidKey(idempotencyKey)) return null;
    const raw = await this.redis.get(idempotencyKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  async tryAcquireOrGetCached(idempotencyKey: string): Promise<{ locked: boolean; cached?: unknown }> {
    if (!this.isValidKey(idempotencyKey)) throw new Error("Invalid idempotency key format");
    const script = `
      local existing = redis.call('GET', KEYS[1])
      if existing then
        return existing
      end
      redis.call('SETEX', KEYS[1], ARGV[1], ARGV[2])
      return nil
    `;
    const result = await this.redis.eval(script, 1, idempotencyKey, this.workingTtlSeconds, JSON.stringify(workingRecord()));

    if (result === null) {
      return { locked: true };
    }

    try {
      return { locked: false, cached: JSON.parse(result as string) as unknown };
    } catch {
      return { locked: false, cached: null };
    }
  }

  async commit(idempotencyKey: string, result: unknown): Promise<void> {
    if (!this.isValidKey(idempotencyKey)) throw new Error("Invalid idempotency key format");
    await this.redis.setex(idempotencyKey, this.resultTtlSeconds, JSON.stringify(result));
  }

  async commitError(idempotencyKey: string, result: unknown, errorTtlSeconds: number): Promise<void> {
    if (!this.isValidKey(idempotencyKey)) throw new Error("Invalid idempotency key format");
    await this.redis.setex(idempotencyKey, errorTtlSeconds, JSON.stringify(result));
  }

  async release(idempotencyKey: string): Promise<void> {
    if (!this.isValidKey(idempotencyKey)) return;
    const script = `
      local existing = redis.call('GET', KEYS[1])
      if not existing then return 0 end
      local decoded = cjson.decode(existing)
      if decoded['status'] == 'working' then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `;
    await this.redis.eval(script, 1, idempotencyKey);
  }

  async extendWorking(idempotencyKey: string): Promise<void> {
    if (!this.isValidKey(idempotencyKey)) return;
    const script = `
      local existing = redis.call('GET', KEYS[1])
      if not existing then return 0 end
      local decoded = cjson.decode(existing)
      if decoded['status'] == 'working' then
        return redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return 0
    `;
    await this.redis.eval(script, 1, idempotencyKey, this.workingTtlSeconds);
  }

  async close(): Promise<void> {}
}

export const globalIdempotencyManager: IIdempotencyManager = ENV.STORAGE_DRIVER === "redis"
  ? new RedisIdempotencyManager()
  : new MemoryIdempotencyManager();
