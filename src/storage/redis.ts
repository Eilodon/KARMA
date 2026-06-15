import type { IStateStore } from "./interface.js";
import type { BaseState, Phase } from "../types/schemas.js";
import { globalEncryption } from "./encryption.js";
import { ENV } from "../config/env.js";
import { closeRedisClient, getRedisClient } from "./redis_client.js";

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  eval(script: string, keyCount: number, ...args: unknown[]): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  ping(): Promise<string>;
};

type EncryptionLike = {
  encryptState(state: Record<string, unknown>, tenantId?: string): Promise<string>;
  decryptState(data: string, tenantId?: string): Promise<Record<string, unknown>>;
};

export class RedisStore implements IStateStore {
  constructor(
    private redis: RedisLike = getRedisClient(),
    private encryption: EncryptionLike = globalEncryption,
  ) {}

  private getKey(tenantId: string): string {
    return `karma:state:${ENV.MCP_PROJECT_ID}:${tenantId}`;
  }

  private getBackupIndexKey(tenantId: string): string {
    return `${this.getKey(tenantId)}:backups`;
  }

  private getRevisionKey(tenantId: string): string {
    return `${this.getKey(tenantId)}:revision`;
  }

  private getBackupKey(tenantId: string, revision: number): string {
    return `${this.getKey(tenantId)}:backup:${revision}`;
  }

  async load<T = Record<string, unknown>>(tenantId: string): Promise<Partial<BaseState<T>> | null> {
    const raw = await this.redis.get(this.getKey(tenantId));
    if (!raw) return null;
    try {
      const state = (await this.encryption.decryptState(raw, tenantId)) as Partial<BaseState<T>>;
      const revision = await this.redis.get(this.getRevisionKey(tenantId));
      if (revision !== null) {
        state.revision = Number.parseInt(revision, 10);
      }
      return state;
    } catch (err) {
      console.error(`[KARMA] Failed to decrypt Redis state for tenant: ${tenantId}`);
      throw err;
    }
  }

  async save<T = Record<string, unknown>>(state: BaseState<T>): Promise<void> {
    const encrypted = await this.encryption.encryptState(state, state.tenantId);
    const expectedRevision = Math.max(0, (state.revision ?? 0) - 1);
    const script = `
      local current = redis.call('GET', KEYS[2])
      if not current then
        current = ARGV[1]
      end
      if tostring(current) ~= tostring(ARGV[1]) then
        return {0, current}
      end
      redis.call('SET', KEYS[1], ARGV[3])
      redis.call('SET', KEYS[2], ARGV[2])
      return {1, ARGV[2]}
    `;
    const result = await this.redis.eval(
      script,
      2,
      this.getKey(state.tenantId),
      this.getRevisionKey(state.tenantId),
      expectedRevision.toString(),
      state.revision.toString(),
      encrypted
    ) as [number, string];

    if (Number(result[0]) !== 1) {
      throw new Error(`[KARMA] Redis state revision conflict for tenant ${state.tenantId}. Expected ${expectedRevision}, got ${result[1]}.`);
    }
  }

  async saveBackup<T = Record<string, unknown>>(state: BaseState<T>, previousPhase: Phase, nextPhase: Phase): Promise<void> {
    const revision = state.revision ?? Date.now();
    const label = `revision_${revision}_${previousPhase}_to_${nextPhase}`;
    const backupKey = this.getBackupKey(state.tenantId, revision);
    const backup = {
      label,
      createdAt: new Date().toISOString(),
      previousPhase,
      nextPhase,
      revision,
      state,
    };
    const encrypted = await this.encryption.encryptState(backup, state.tenantId);
    const indexKey = this.getBackupIndexKey(state.tenantId);
    const script = `
      redis.call('SET', KEYS[1], ARGV[1])
      redis.call('ZADD', KEYS[2], ARGV[2], KEYS[1])
      local count = redis.call('ZCARD', KEYS[2])
      local maxBackups = tonumber(ARGV[3])
      if count > maxBackups then
        local stale = redis.call('ZRANGE', KEYS[2], 0, count - maxBackups - 1)
        for _, key in ipairs(stale) do
          redis.call('DEL', key)
          redis.call('ZREM', KEYS[2], key)
        end
      end
      return 1
    `;
    await this.redis.eval(script, 2, backupKey, indexKey, encrypted, revision.toString(), ENV.MCP_REDIS_MAX_BACKUPS.toString());
  }

  async restoreLatestBackup<T = Record<string, unknown>>(tenantId: string): Promise<{ label: string; state: BaseState<T> } | null> {
    const indexKey = this.getBackupIndexKey(tenantId);
    const latest = await this.redis.zrange(indexKey, -1, -1);
    const backupKey = latest[0];
    if (!backupKey) return null;
    const raw = await this.redis.get(backupKey);
    if (!raw) return null;
    try {
      const backup = (await this.encryption.decryptState(raw, tenantId)) as {
        label?: string;
        state?: BaseState<T>;
      };
      if (!backup.state) return null;
      return { label: backup.label || backupKey.split(":").at(-1) || "redis_backup", state: backup.state };
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    return (await this.redis.ping()) === "PONG";
  }

  async close(): Promise<void> {
    await closeRedisClient();
  }
}
