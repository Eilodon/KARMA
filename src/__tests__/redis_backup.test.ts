import { describe, expect, test } from "vitest";
import { ENV } from "../config/env.js";
import { RedisStore } from "../storage/redis.js";
import type { BaseState } from "../types/schemas.js";

class FakeRedis {
  values = new Map<string, string>();
  sortedSets = new Map<string, Array<{ key: string; score: number }>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) || null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async eval(_script: string, keyCount: number, ...args: unknown[]): Promise<unknown> {
    if (keyCount === 2 && args.length === 5) {
      const [backupKey, indexKey, encrypted, revision, maxBackups] = args as [string, string, string, string, string];
      this.values.set(backupKey, encrypted);
      const entries = this.sortedSets.get(indexKey) || [];
      const nextEntries = entries.filter(entry => entry.key !== backupKey);
      nextEntries.push({ key: backupKey, score: Number(revision) });
      nextEntries.sort((a, b) => a.score - b.score);
      const removeCount = Math.max(0, nextEntries.length - Number(maxBackups));
      const stale = nextEntries.splice(0, removeCount);
      for (const entry of stale) this.values.delete(entry.key);
      this.sortedSets.set(indexKey, nextEntries);
      return 1;
    }
    throw new Error("Unexpected fake Redis eval call");
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const entries = this.sortedSets.get(key) || [];
    const normalizedStart = start < 0 ? entries.length + start : start;
    const normalizedStop = stop < 0 ? entries.length + stop : stop;
    return entries.slice(normalizedStart, normalizedStop + 1).map(entry => entry.key);
  }

  async ping(): Promise<string> {
    return "PONG";
  }
}

const passthroughEncryption = {
  async encryptState(state: Record<string, unknown>): Promise<string> {
    return JSON.stringify(state);
  },
  async decryptState(data: string): Promise<Record<string, unknown>> {
    return JSON.parse(data);
  },
};

function state(revision: number): BaseState<Record<string, unknown>> {
  return {
    version: "1.0.0",
    tenantId: "tenant-a",
    revision,
    phase: "intake",
    logs: { decisions: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    payload: { revision },
  };
}

describe("Redis backup rotation", () => {
  test("keeps the configured number of revisioned backups and restores the latest", async () => {
    const originalMax = ENV.MCP_REDIS_MAX_BACKUPS;
    ENV.MCP_REDIS_MAX_BACKUPS = 2;
    try {
      const redis = new FakeRedis();
      const store = new RedisStore(redis, passthroughEncryption);

      await store.saveBackup(state(1), "intake", "execution");
      await store.saveBackup(state(2), "execution", "review");
      await store.saveBackup(state(3), "review", "completed");

      const keys = [...redis.values.keys()].filter(key => key.includes(":backup:"));
      expect(keys).toHaveLength(2);
      expect(keys.some(key => key.endsWith(":backup:1"))).toBe(false);

      const restored = await store.restoreLatestBackup("tenant-a");
      expect(restored?.state.revision).toBe(3);
      expect(restored?.label).toContain("revision_3");
    } finally {
      ENV.MCP_REDIS_MAX_BACKUPS = originalMax;
    }
  });
});
