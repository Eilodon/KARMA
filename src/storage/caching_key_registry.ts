import { createCipheriv, randomBytes } from "node:crypto";
import type {
  CryptoErasureReceipt,
  ITenantKeyRegistry,
  KeyScope,
  SealedBlob,
} from "./key_registry.js";
import type { IAuditStore } from "./audit_store.js";

export interface CachingRegistryOptions {
  /** DEK cache TTL in ms. 0 = caching disabled. Default: 300_000 (5 min). */
  ttlMs?: number;
  /** Max reuses of a cached DEK before eviction. 0 = no limit. Default: 1_000. */
  maxUsesPerDek?: number;
  /** If set, erasure receipts are persisted here after every scheduleErasure call. */
  auditStore?: IAuditStore;
}

interface SealCacheEntry {
  plaintextDek: Uint8Array; // zeroed on eviction
  encryptedDek: string;
  keyId: string;
  version: number;
  expiresAt: number;
  useCount: number;
}

/**
 * Decorator that adds two cross-cutting capabilities to any ITenantKeyRegistry:
 *
 * 1. Bounded in-memory DEK cache — reuses the active tenant DEK for sealing within a
 *    TTL/use-count window, reducing KMS round-trips on the write hot path.
 *    The plaintext DEK is zeroed on eviction (TTL expiry, max-use, key disable, or erasure).
 *
 * 2. Durable erasure receipt persistence — calls auditStore.persistErasureReceipt after
 *    every scheduleErasure so receipts survive process restarts.
 *
 * When ttlMs=0 and maxUsesPerDek=0 (caching disabled), sealForTenant delegates straight
 * through to the inner registry.  The audit store is active regardless of caching state.
 */
export class CachingKeyRegistry implements ITenantKeyRegistry {
  private readonly inner: ITenantKeyRegistry;
  private readonly ttlMs: number;
  private readonly maxUses: number;
  private readonly auditStore?: IAuditStore;
  private readonly sealCache = new Map<string, SealCacheEntry>();
  private readonly cachingEnabled: boolean;

  constructor(inner: ITenantKeyRegistry, opts?: CachingRegistryOptions) {
    this.inner          = inner;
    this.ttlMs          = opts?.ttlMs         ?? 300_000;
    this.maxUses        = opts?.maxUsesPerDek ?? 1_000;
    this.auditStore     = opts?.auditStore;
    this.cachingEnabled = this.ttlMs > 0 || this.maxUses > 0;
  }

  // ── Cache helpers ──────────────────────────────────────────────────────────

  private liveEntry(tenantId: string): SealCacheEntry | undefined {
    const entry = this.sealCache.get(tenantId);
    if (!entry) return undefined;
    const expired = this.ttlMs   > 0 && Date.now() > entry.expiresAt;
    const maxed   = this.maxUses > 0 && entry.useCount >= this.maxUses;
    if (expired || maxed) {
      entry.plaintextDek.fill(0);
      this.sealCache.delete(tenantId);
      return undefined;
    }
    return entry;
  }

  private evictByKeyId(keyId: string): void {
    for (const [tenantId, entry] of this.sealCache) {
      if (entry.keyId === keyId) {
        entry.plaintextDek.fill(0);
        this.sealCache.delete(tenantId);
      }
    }
  }

  private evictByTenantId(tenantId: string): void {
    const entry = this.sealCache.get(tenantId);
    if (entry) {
      entry.plaintextDek.fill(0);
      this.sealCache.delete(tenantId);
    }
  }

  // ── sealForTenant: cache-aware ─────────────────────────────────────────────

  async sealForTenant(tenantId: string, plaintext: Uint8Array): Promise<SealedBlob> {
    if (!this.cachingEnabled) {
      return this.inner.sealForTenant(tenantId, plaintext);
    }

    const entry = this.liveEntry(tenantId);
    if (entry) {
      // Cache hit: reuse DEK bytes; skip KMS round-trip
      entry.useCount++;
      const { plaintextDek, encryptedDek, keyId, version } = entry;
      const iv         = randomBytes(12);
      const cipher     = createCipheriv("aes-256-gcm", plaintextDek, iv);
      const encrypted  = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag        = cipher.getAuthTag();
      const ciphertext = Buffer.concat([iv, encrypted, tag]).toString("base64url");
      return { ciphertext, encryptedDek, keyId, version };
    }

    // Cache miss: generate a fresh DEK via the inner registry, store our own copy
    const { plaintextDek, encryptedDek, keyId, version } = await this.inner.generateTenantDek(tenantId);
    const cached: SealCacheEntry = {
      plaintextDek: new Uint8Array(plaintextDek), // our copy — lives until eviction
      encryptedDek, keyId, version,
      expiresAt: Date.now() + this.ttlMs,
      useCount: 1,
    };
    this.sealCache.set(tenantId, cached);
    try {
      const iv         = randomBytes(12);
      const cipher     = createCipheriv("aes-256-gcm", plaintextDek, iv);
      const encrypted  = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag        = cipher.getAuthTag();
      const ciphertext = Buffer.concat([iv, encrypted, tag]).toString("base64url");
      return { ciphertext, encryptedDek, keyId, version };
    } finally {
      plaintextDek.fill(0); // zero the original returned by generateTenantDek; cache has its copy
    }
  }

  // ── disableKey: evict cached DEK so it is not reused after disable ────────

  async disableKey(keyId: string): Promise<void> {
    await this.inner.disableKey(keyId);
    this.evictByKeyId(keyId);
  }

  // ── scheduleErasure: evict DEK, then persist receipt ──────────────────────

  async scheduleErasure(
    scope: KeyScope,
    subjectId: string,
    reason: string,
    actor?: string,
  ): Promise<CryptoErasureReceipt> {
    // Evict before delegating so no in-flight seal can use the DEK being erased
    this.evictByTenantId(subjectId);
    const receipt = await this.inner.scheduleErasure(scope, subjectId, reason, actor);
    if (this.auditStore) {
      await this.auditStore.persistErasureReceipt(receipt);
    }
    return receipt;
  }

  // ── Delegated methods ──────────────────────────────────────────────────────

  generateTenantDek(tenantId: string)                      { return this.inner.generateTenantDek(tenantId); }
  unwrapDek(keyId: string, encryptedDek: string)           { return this.inner.unwrapDek(keyId, encryptedDek); }
  unsealForTenant(blob: SealedBlob)                        { return this.inner.unsealForTenant(blob); }
  getOrCreateActiveKey(scope: KeyScope, subjectId: string) { return this.inner.getOrCreateActiveKey(scope, subjectId); }
  resolveKey(keyId: string)                                { return this.inner.resolveKey(keyId); }
  rotateKey(scope: KeyScope, subjectId: string)            { return this.inner.rotateKey(scope, subjectId); }
  auditLog(scope: KeyScope, subjectId: string)             { return this.inner.auditLog(scope, subjectId); }
}
