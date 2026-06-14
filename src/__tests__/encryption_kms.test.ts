import { describe, it, expect, beforeEach } from "vitest";
import { EncryptionService } from "../storage/encryption.js";
import { LocalKeyRegistry } from "../storage/providers/local_key_registry.js";

const RAW_KEY = "base64url:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("EncryptionService v4 KMS path", () => {
  let service: EncryptionService;

  beforeEach(() => {
    const registry = new LocalKeyRegistry("wrap-key-32bytes-for-test-xxxxx", "test-proj");
    service = new EncryptionService(RAW_KEY);
    service.setKeyRegistry(registry);
  });

  it("encryptState with tenantId uses smcp:v4:kms prefix", async () => {
    const cipher = await service.encryptState({ hello: "world" }, "tenant-kms-1");
    expect(cipher).toMatch(/^smcp:v4:kms:/);
  });

  it("decryptState round-trips v4 blob", async () => {
    const cipher    = await service.encryptState({ secret: 42 }, "tenant-kms-1");
    const recovered = await service.decryptState(cipher, "tenant-kms-1");
    expect(recovered).toEqual({ secret: 42 });
  });

  it("v4 blob uses base64url-encoded JSON SealedBlob", async () => {
    const cipher  = await service.encryptState({ x: 1 }, "tenant-kms-2");
    const payload = cipher.slice("smcp:v4:kms:".length);
    const blob    = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(blob).toHaveProperty("ciphertext");
    expect(blob).toHaveProperty("encryptedDek");
    expect(blob).toHaveProperty("keyId");
    expect(blob).toHaveProperty("version");
  });

  it("v4 blob is not prefixed as v3 or v2", async () => {
    const cipher = await service.encryptState({ x: 1 }, "tenant-kms-3");
    expect(cipher.startsWith("smcp:v3:")).toBe(false);
    expect(cipher.startsWith("smcp:v2:")).toBe(false);
  });

  it("without registry, falls back to v3 HKDF when tenantId provided", async () => {
    const plain = new EncryptionService(RAW_KEY);
    // no setKeyRegistry
    const cipher = await plain.encryptState({ x: 1 }, "tenant-v3-fallback");
    expect(cipher).toMatch(/^smcp:v3:/);
  });

  it("decryptState handles v3 blob even when registry is set (backward compat)", async () => {
    const plain = new EncryptionService(RAW_KEY);
    const v3cipher = await plain.encryptState({ legacy: true }, "tenant-compat");

    // service has registry but should still decrypt v3
    const recovered = await service.decryptState(v3cipher, "tenant-compat");
    expect(recovered).toEqual({ legacy: true });
  });
});
