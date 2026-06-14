import type { Redis } from "ioredis";
import { ENV } from "../config/env.js";
import { getRequestContext } from "../security/context.js";
import { globalEncryption } from "../storage/encryption.js";
import { getRedisClient } from "../storage/redis_client.js";

export interface ICredentialVault {
  getSecret(keyName: string): Promise<string | null>;
  setSecret(keyName: string, value: string): Promise<void>;
  close?(): Promise<void>;
}

const SECRET_KEY_PATTERN = /^[A-Z0-9_]{1,128}$/;

function secretAllowlist(): Set<string> {
  return new Set(ENV.MCP_SECRET_ALLOWLIST.split(",").map(s => s.trim()).filter(Boolean));
}

function assertValidSecretKey(keyName: string): void {
  if (!SECRET_KEY_PATTERN.test(keyName)) {
    throw new Error("[SUPER-MCP] Invalid secret key name. Use uppercase A-Z, 0-9, underscore only.");
  }
  const allowlist = secretAllowlist();
  if (ENV.MCP_SAFE_MODE && allowlist.size > 0 && !allowlist.has(keyName)) {
    throw new Error(`[SUPER-MCP] Secret '${keyName}' is not in MCP_SECRET_ALLOWLIST.`);
  }
}

function assertSecretWriteAllowed(): void {
  if (!ENV.MCP_ALLOW_SECRET_WRITE) {
    throw new Error("[SUPER-MCP] Secret writes are disabled. Set MCP_ALLOW_SECRET_WRITE=true only in controlled admin workflows.");
  }
}

function tenantEnvKey(keyName: string): string {
  // B-7.1 fix: namespace env-var lookups by tenant so tenant A cannot read tenant B's secrets.
  const ctx = getRequestContext();
  const safeId = ctx.tenantId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `SMCP_${safeId}_${keyName}`;
}

class LocalEnvVault implements ICredentialVault {
  async getSecret(keyName: string): Promise<string | null> {
    assertValidSecretKey(keyName);
    return process.env[tenantEnvKey(keyName)] ?? null;
  }

  async setSecret(keyName: string, value: string): Promise<void> {
    assertValidSecretKey(keyName);
    assertSecretWriteAllowed();
    process.env[tenantEnvKey(keyName)] = value;
  }
}

class RedisKmsVault implements ICredentialVault {
  private redis: Redis;

  constructor() {
    this.redis = getRedisClient();
  }

  private getKey(keyName: string): string {
    const ctx = getRequestContext();
    return `super_mcp:vault:${ENV.MCP_PROJECT_ID}:${ctx.tenantId}:${keyName}`;
  }

  async getSecret(keyName: string): Promise<string | null> {
    assertValidSecretKey(keyName);
    const encrypted = await this.redis.get(this.getKey(keyName));
    if (!encrypted) return null;
    try {
      const ctx = getRequestContext();
      const decrypted = await globalEncryption.decryptState(encrypted, ctx.tenantId);
      return typeof decrypted.secret === "string" ? decrypted.secret : null;
    } catch {
      console.error(`[SUPER-MCP] KMS decryption failed for key ${keyName}`);
      return null;
    }
  }

  async setSecret(keyName: string, value: string): Promise<void> {
    assertValidSecretKey(keyName);
    assertSecretWriteAllowed();
    const ctx = getRequestContext();
    const encrypted = await globalEncryption.encryptState({ secret: value }, ctx.tenantId);
    await this.redis.set(this.getKey(keyName), encrypted);
  }

  async close(): Promise<void> {}
}

export const globalCredentialVault: ICredentialVault = ENV.STORAGE_DRIVER === "redis"
  ? new RedisKmsVault()
  : new LocalEnvVault();
