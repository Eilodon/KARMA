import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalKeyRegistry } from "../storage/providers/local_key_registry.js";
import { CachingKeyRegistry } from "../storage/caching_key_registry.js";
import type { CryptoErasureReceipt } from "../storage/key_registry.js";
import type { IAuditStore } from "../storage/audit_store.js";

const TENANT   = "tenant-alpha";
const PLAINTEXT = new TextEncoder().encode(JSON.stringify({ hello: "world" }));

function makeInner() {
  return new LocalKeyRegistry("test-wrap-key-32-bytes-abcdefghij", "test-project");
}

describe("CachingKeyRegistry — DEK cache", () => {
  let inner: LocalKeyRegistry;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    inner = makeInner();
    spy   = vi.spyOn(inner, "generateTenantDek");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("calls generateTenantDek only once for multiple seals within TTL", async () => {
    const cache = new CachingKeyRegistry(inner, { ttlMs: 60_000, maxUsesPerDek: 100 });

    await cache.sealForTenant(TENANT, PLAINTEXT);
    await cache.sealForTenant(TENANT, PLAINTEXT);
    await cache.sealForTenant(TENANT, PLAINTEXT);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("produces unique ciphertexts per seal despite shared DEK (random IV)", async () => {
    const cache = new CachingKeyRegistry(inner, { ttlMs: 60_000, maxUsesPerDek: 100 });

    const blob1 = await cache.sealForTenant(TENANT, PLAINTEXT);
    const blob2 = await cache.sealForTenant(TENANT, PLAINTEXT);

    expect(blob1.ciphertext).not.toBe(blob2.ciphertext);
    expect(blob1.encryptedDek).toBe(blob2.encryptedDek); // same cached DEK
  });

  it("seal → unseal round-trip produces identical plaintext", async () => {
    const cache = new CachingKeyRegistry(inner, { ttlMs: 60_000, maxUsesPerDek: 100 });

    const blob   = await cache.sealForTenant(TENANT, PLAINTEXT);
    const result = await cache.unsealForTenant(blob);

    expect(Buffer.from(result).toString()).toBe(Buffer.from(PLAINTEXT).toString());
  });

  it("different tenants get independent cache entries", async () => {
    const cache = new CachingKeyRegistry(inner, { ttlMs: 60_000, maxUsesPerDek: 100 });

    await cache.sealForTenant("tenant-a", PLAINTEXT);
    await cache.sealForTenant("tenant-b", PLAINTEXT);
    await cache.sealForTenant("tenant-a", PLAINTEXT);
    await cache.sealForTenant("tenant-b", PLAINTEXT);

    // One generateTenantDek call per tenant (2 total)
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("evicts and regenerates DEK after TTL expiry", async () => {
    vi.useFakeTimers();
    const cache = new CachingKeyRegistry(inner, { ttlMs: 5_000, maxUsesPerDek: 1_000 });

    await cache.sealForTenant(TENANT, PLAINTEXT);
    expect(spy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_001);

    await cache.sealForTenant(TENANT, PLAINTEXT);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("evicts and regenerates DEK after maxUsesPerDek is reached", async () => {
    const cache = new CachingKeyRegistry(inner, { ttlMs: 3_600_000, maxUsesPerDek: 3 });

    await cache.sealForTenant(TENANT, PLAINTEXT); // use 1
    await cache.sealForTenant(TENANT, PLAINTEXT); // use 2
    await cache.sealForTenant(TENANT, PLAINTEXT); // use 3 — evicts on next check
    expect(spy).toHaveBeenCalledTimes(1);

    await cache.sealForTenant(TENANT, PLAINTEXT); // evicted: new DEK generated
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("bypasses cache entirely when ttlMs=0 and maxUsesPerDek=0", async () => {
    const cache = new CachingKeyRegistry(inner, { ttlMs: 0, maxUsesPerDek: 0 });

    await cache.sealForTenant(TENANT, PLAINTEXT);
    await cache.sealForTenant(TENANT, PLAINTEXT);

    // delegated to inner.sealForTenant → inner.generateTenantDek each time
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("evicts cached DEK when disableKey is called, then regenerates on next seal", async () => {
    const cache = new CachingKeyRegistry(inner, { ttlMs: 60_000, maxUsesPerDek: 100 });

    const blob1 = await cache.sealForTenant(TENANT, PLAINTEXT);
    expect(spy).toHaveBeenCalledTimes(1);

    await cache.disableKey(blob1.keyId);

    // Cache evicted; inner creates a new active key and generateTenantDek is called again
    const blob2 = await cache.sealForTenant(TENANT, PLAINTEXT);
    expect(spy).toHaveBeenCalledTimes(2);
    // Verify the new blob is valid (unseals correctly)
    const result = await cache.unsealForTenant(blob2);
    expect(Buffer.from(result).toString()).toBe(Buffer.from(PLAINTEXT).toString());
  });
});

describe("CachingKeyRegistry — audit store persistence", () => {
  it("calls auditStore.persistErasureReceipt after scheduleErasure", async () => {
    const receipts: CryptoErasureReceipt[] = [];
    const auditStore: IAuditStore = {
      persistErasureReceipt: async (r) => { receipts.push(r); },
      listErasureReceipts:   async ()  => [],
    };
    const cache = new CachingKeyRegistry(makeInner(), {
      ttlMs: 60_000, maxUsesPerDek: 100, auditStore,
    });

    await cache.sealForTenant(TENANT, PLAINTEXT);
    const receipt = await cache.scheduleErasure("tenant", TENANT, "gdpr-erasure");

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ reason: "gdpr-erasure", scope: "tenant" });
    expect(receipt.disabledAt).toBeTruthy();
    expect(receipt.scheduledDeletionAt).toBeTruthy();
  });

  it("does not error when no auditStore is configured", async () => {
    const cache = new CachingKeyRegistry(makeInner(), { ttlMs: 60_000, maxUsesPerDek: 100 });
    await expect(cache.scheduleErasure("tenant", TENANT, "test")).resolves.toBeTruthy();
  });
});

describe("CachingKeyRegistry — delegation", () => {
  it("delegates getOrCreateActiveKey, resolveKey, rotateKey, auditLog to inner", async () => {
    const inner2 = makeInner();
    const getSpy  = vi.spyOn(inner2, "getOrCreateActiveKey");
    const resSpy  = vi.spyOn(inner2, "resolveKey");
    const rotSpy  = vi.spyOn(inner2, "rotateKey");
    const audSpy  = vi.spyOn(inner2, "auditLog");

    const cache = new CachingKeyRegistry(inner2, { ttlMs: 60_000, maxUsesPerDek: 100 });

    const record = await cache.getOrCreateActiveKey("tenant", TENANT);
    await cache.resolveKey(record.keyId);
    await cache.rotateKey("tenant", TENANT);
    await cache.auditLog("tenant", TENANT);

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(resSpy).toHaveBeenCalledTimes(1);
    expect(rotSpy).toHaveBeenCalledTimes(1);
    expect(audSpy).toHaveBeenCalledTimes(1);
  });
});
