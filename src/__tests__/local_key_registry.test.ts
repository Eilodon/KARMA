import { describe, it, expect, beforeEach } from "vitest";
import { LocalKeyRegistry } from "../storage/providers/local_key_registry.js";

const WRAP_KEY = "test-wrap-key-32-bytes-long-xxxx";
const PROJECT  = "test-project";

describe("LocalKeyRegistry", () => {
  let registry: LocalKeyRegistry;

  beforeEach(() => {
    registry = new LocalKeyRegistry(WRAP_KEY, PROJECT);
  });

  it("generateTenantDek returns 32-byte DEK and opaque kid", async () => {
    const { plaintextDek, encryptedDek, keyId, version } =
      await registry.generateTenantDek("tenant-alpha");
    expect(plaintextDek).toHaveLength(32);
    expect(encryptedDek).toBeTruthy();
    expect(keyId).toMatch(/^tk_/);
    expect(version).toBe(1);
    plaintextDek.fill(0);
  });

  it("unwrapDek round-trips the DEK exactly", async () => {
    const { plaintextDek, encryptedDek, keyId } =
      await registry.generateTenantDek("tenant-beta");
    const original = Uint8Array.from(plaintextDek);
    plaintextDek.fill(0);

    const unwrapped = await registry.unwrapDek(keyId, encryptedDek);
    expect(unwrapped).toEqual(original);
    unwrapped.fill(0);
  });

  it("sealForTenant / unsealForTenant round-trips without exposing DEK", async () => {
    const plain     = new TextEncoder().encode("secret payload");
    const blob      = await registry.sealForTenant("tenant-gamma", plain);
    const recovered = await registry.unsealForTenant(blob);
    expect(new TextDecoder().decode(recovered)).toBe("secret payload");
  });

  it("cross-tenant unseal fails — tampered keyId is unknown", async () => {
    const plain = new TextEncoder().encode("tenant-a secret");
    const blob  = await registry.sealForTenant("tenant-a", plain);
    const tampered = { ...blob, keyId: "tk_nonexistent:v1" };
    await expect(registry.unsealForTenant(tampered)).rejects.toThrow();
  });

  it("scheduleErasure phase 1: unseal denied immediately after erasure", async () => {
    const plain = new TextEncoder().encode("will be erased");
    const blob  = await registry.sealForTenant("tenant-erase", plain);

    const receipt = await registry.scheduleErasure("tenant", "tenant-erase", "gdpr", "test-actor");
    expect(receipt.disabledAt).toBeTruthy();
    expect(receipt.scheduledDeletionAt).toBeTruthy();
    expect(receipt.actor).toBe("test-actor");

    await expect(registry.unsealForTenant(blob)).rejects.toThrow(/decrypt_denied|destroyed/i);
  });

  it("rotateKey: new version, old sealed blob still readable via old key", async () => {
    const plain = new TextEncoder().encode("pre-rotation");
    const blob  = await registry.sealForTenant("tenant-rotate", plain);

    await registry.rotateKey("tenant", "tenant-rotate");

    const recovered = await registry.unsealForTenant(blob);
    expect(new TextDecoder().decode(recovered)).toBe("pre-rotation");
  });

  it("rotateKey: new seals use the latest key version", async () => {
    await registry.sealForTenant("tenant-rotate2", new TextEncoder().encode("old"));
    await registry.rotateKey("tenant", "tenant-rotate2");

    const blob2 = await registry.sealForTenant("tenant-rotate2", new TextEncoder().encode("new"));
    expect(blob2.version).toBe(2);
  });

  it("auditLog records created, rotated, disabled, destroyed events", async () => {
    await registry.sealForTenant("tenant-audit", new TextEncoder().encode("x"));
    await registry.rotateKey("tenant", "tenant-audit");
    await registry.scheduleErasure("tenant", "tenant-audit", "test");

    const log    = await registry.auditLog("tenant", "tenant-audit");
    const events = log.map(e => e.event);
    expect(events).toContain("created");
    expect(events).toContain("rotated");
    expect(events).toContain("disabled");
    expect(events).toContain("destroyed");
  });

  it("two different tenants produce different opaque keyIds", async () => {
    const b1 = await registry.sealForTenant("tenant-x", new TextEncoder().encode("a"));
    const b2 = await registry.sealForTenant("tenant-y", new TextEncoder().encode("b"));
    expect(b1.keyId).not.toBe(b2.keyId);
  });
});
