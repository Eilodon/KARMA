import { CompactEncrypt, compactDecrypt, importJWK } from "jose";
import { createHash, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { ENV } from "../config/env.js";
import type { ITenantKeyRegistry, SealedBlob } from "./key_registry.js";

const V2_PREFIX = "smcp:v2:scrypt";
const V4_PREFIX = "smcp:v4:kms";
// T-2.1/E-6.3: V3 derives a per-tenant key via HKDF so blobs cannot be swapped
// across tenants even when the master key is shared.
const V3_PREFIX = "smcp:v3:hkdf-tenant";
const RAW_KEY_PREFIX = "base64url:";
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = {
  cost: 32768,
  blockSize: 8,
  parallelization: 1,
  maxmem: 64 * 1024 * 1024,
};

async function importA256GcmKey(key: Uint8Array) {
  return importJWK({ kty: "oct", k: Buffer.from(key).toString("base64url") }, "dir");
}

function decodeRawKey(secretKey: string): Uint8Array | null {
  if (!secretKey.startsWith(RAW_KEY_PREFIX)) return null;
  const raw = Buffer.from(secretKey.slice(RAW_KEY_PREFIX.length), "base64url");
  if (raw.length !== SCRYPT_KEY_LENGTH) {
    throw new Error("MCP_ENCRYPTION_KEY base64url raw key must decode to exactly 32 bytes.");
  }
  return raw;
}

/**
 * Dịch vụ mã hóa cấu hình (EncryptionService).
 * Tự động mã hóa/giải mã toàn bộ Blob dữ liệu nếu có MCP_ENCRYPTION_KEY.
 * Đảm bảo an toàn (Data at Rest) dù lưu ở Local FS hay Redis.
 */
export class EncryptionService {
  private readonly secretKey?: string;
  private readonly rawKey: Uint8Array | null = null;
  private keyRegistry?: ITenantKeyRegistry;

  constructor(secretKey?: string) {
    this.secretKey = secretKey;
    this.rawKey = secretKey ? decodeRawKey(secretKey) : null;
  }

  setKeyRegistry(registry: ITenantKeyRegistry): void {
    this.keyRegistry = registry;
  }

  private deriveV2Key(salt: Uint8Array): Uint8Array {
    if (!this.secretKey) {
      throw new Error("MCP_ENCRYPTION_KEY is required for encrypted state.");
    }
    return this.rawKey || scryptSync(this.secretKey, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  }

  private deriveLegacyKey(): Uint8Array {
    if (!this.secretKey) {
      throw new Error("MCP_ENCRYPTION_KEY is required for encrypted state.");
    }
    return createHash("sha256").update(this.secretKey).digest();
  }

  private deriveV3TenantKey(baseKey: Uint8Array, tenantId: string): Uint8Array {
    // HKDF expand: baseKey is already a strong PRK (from scrypt or raw key), so
    // the salt can be empty. The info string binds the output key to this tenant.
    return new Uint8Array(
      hkdfSync("sha256", baseKey, Buffer.alloc(0), Buffer.from(`super-mcp:tenant:${tenantId}:v3`), 32),
    );
  }

  async encryptState(state: Record<string, unknown>, tenantId?: string): Promise<string> {
    // V4: KMS-backed per-tenant DEK — takes priority when registry is wired in
    if (this.keyRegistry && tenantId) {
      const plaintextBytes = new TextEncoder().encode(JSON.stringify(state));
      const blob = await this.keyRegistry.sealForTenant(tenantId, plaintextBytes);
      return `${V4_PREFIX}:${Buffer.from(JSON.stringify(blob)).toString("base64url")}`;
    }

    const payload = JSON.stringify(state);
    if (!this.secretKey) {
      return payload;
    }

    const salt = randomBytes(16);
    const baseKey = this.deriveV2Key(salt);

    if (tenantId) {
      // V3: per-tenant key via HKDF — ciphertext is cryptographically bound to tenantId.
      const tenantKey = this.deriveV3TenantKey(baseKey, tenantId);
      const jwe = await new CompactEncrypt(new TextEncoder().encode(payload))
        .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
        .encrypt(await importA256GcmKey(tenantKey));
      return `${V3_PREFIX}:${Buffer.from(salt).toString("base64url")}:${jwe}`;
    }

    // V2 fallback: global key (no tenantId available, e.g. migration scripts).
    const jwe = await new CompactEncrypt(new TextEncoder().encode(payload))
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .encrypt(await importA256GcmKey(baseKey));
    return `${V2_PREFIX}:${Buffer.from(salt).toString("base64url")}:${jwe}`;
  }

  async decryptState(data: string, tenantId?: string): Promise<Record<string, unknown>> {
    // V4: KMS-backed blob
    if (data.startsWith(`${V4_PREFIX}:`)) {
      if (!this.keyRegistry) {
        throw new Error("KMS registry required to decrypt smcp:v4:kms blobs. Set KMS_PROVIDER.");
      }
      const blobJson  = Buffer.from(data.slice(V4_PREFIX.length + 1), "base64url").toString("utf8");
      const blob      = JSON.parse(blobJson) as SealedBlob;
      const plaintext = await this.keyRegistry.unsealForTenant(blob);
      return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    }

    if (!this.secretKey) {
      return JSON.parse(data);
    }

    if (data.startsWith(`${V3_PREFIX}:`)) {
      if (!tenantId) throw new Error("tenantId is required to decrypt v3 encrypted state.");
      const parts = data.split(":");
      if (parts.length !== 5) throw new Error("Invalid v3 encrypted state envelope.");
      try {
        const salt = Buffer.from(parts[3], "base64url");
        const baseKey = this.deriveV2Key(salt);
        const tenantKey = this.deriveV3TenantKey(baseKey, tenantId);
        const { plaintext } = await compactDecrypt(parts[4], await importA256GcmKey(tenantKey));
        return JSON.parse(new TextDecoder().decode(plaintext));
      } catch {
        throw new Error("Failed to decrypt v3 encrypted state.");
      }
    }

    if (data.startsWith(`${V2_PREFIX}:`)) {
      const parts = data.split(":");
      if (parts.length !== 5) {
        throw new Error("Invalid encrypted state envelope.");
      }
      try {
        const salt = Buffer.from(parts[3], "base64url");
        const jwe = parts[4];
        const secret = await importA256GcmKey(this.deriveV2Key(salt));
        const { plaintext } = await compactDecrypt(jwe, secret);
        return JSON.parse(new TextDecoder().decode(plaintext));
      } catch {
        throw new Error("Failed to decrypt encrypted state.");
      }
    }

    if (!ENV.MCP_ALLOW_LEGACY_SHA256_KDF) {
      throw new Error("Legacy SHA-256 encrypted state detected. Set MCP_ALLOW_LEGACY_SHA256_KDF=true for one migration run.");
    }

    try {
      const secret = await importA256GcmKey(this.deriveLegacyKey());
      const { plaintext } = await compactDecrypt(data, secret);
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw new Error("Failed to decrypt legacy encrypted state.");
    }
  }
}

export const globalEncryption = new EncryptionService(ENV.MCP_ENCRYPTION_KEY);
