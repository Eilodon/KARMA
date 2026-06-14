import { describe, expect, test } from "vitest";
import { EncryptionService } from "../storage/encryption.js";

function rawKey(byte: number): string {
  return `base64url:${Buffer.alloc(32, byte).toString("base64url")}`;
}

describe("encryption negative-path coverage", () => {
  test("stores plaintext only when no encryption key is configured", async () => {
    const service = new EncryptionService();
    const state = { tenantId: "tenant-a", value: { ok: true } };

    const encoded = await service.encryptState(state);
    expect(encoded).toBe(JSON.stringify(state));
    await expect(service.decryptState(encoded)).resolves.toEqual(state);
  });

  test("wrong key cannot decrypt a v2 envelope", async () => {
    const producer = new EncryptionService(rawKey(1));
    const consumer = new EncryptionService(rawKey(2));
    const encrypted = await producer.encryptState({ tenantId: "tenant-a", secret: "hidden" });

    expect(encrypted).toMatch(/^smcp:v2:scrypt:/);
    await expect(consumer.decryptState(encrypted)).rejects.toThrow("Failed to decrypt encrypted state");
  });

  test("malformed v2 envelopes are denied before legacy migration fallback", async () => {
    const service = new EncryptionService(rawKey(3));

    await expect(service.decryptState("smcp:v2:scrypt:too:few:parts:extra"))
      .rejects.toThrow("Invalid encrypted state envelope");
    await expect(service.decryptState("smcp:v2:scrypt:not-base64:not-a-jwe"))
      .rejects.toThrow("Failed to decrypt encrypted state");
  });

  test("base64url raw keys must decode to exactly 32 bytes", () => {
    expect(() => new EncryptionService(`base64url:${Buffer.alloc(31).toString("base64url")}`))
      .toThrow("exactly 32 bytes");
    expect(() => new EncryptionService(`base64url:${Buffer.alloc(33).toString("base64url")}`))
      .toThrow("exactly 32 bytes");
  });
});
