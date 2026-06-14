import { describe, it, expect, vi, beforeEach } from "vitest";
import { VaultKeyRegistry } from "../storage/providers/vault_key_registry.js";

const BASE_URL       = "http://vault.test:8200";
const TOKEN          = "test-token";
const PROJECT        = "test-project";
const PLAINTEXT_B64  = Buffer.alloc(32, 0x42).toString("base64");
const VAULT_CIPHERTEXT = "vault:v1:ZW5jcnlwdGVkREVL";

// URL-pattern based mock — avoids hardcoding the HMAC-derived key name
function makeFetch() {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const method = (opts?.method ?? "GET").toUpperCase();
    const ok = (data: unknown, status = 200) =>
      ({ ok: true, status, json: async () => data }) as Response;

    if (method === "POST" && url.includes("/datakey/plaintext/"))
      return ok({ data: { plaintext: PLAINTEXT_B64, ciphertext: VAULT_CIPHERTEXT } });

    if (method === "POST" && url.includes("/decrypt/"))
      return ok({ data: { plaintext: PLAINTEXT_B64 } });

    if (method === "POST" && url.includes("/keys/"))
      return ok({}); // create key, rotate, config

    if (method === "DELETE" && url.includes("/keys/"))
      return ok({}, 204);

    return { ok: false, status: 404, json: async () => ({ errors: ["not found"] }) } as Response;
  });
}

describe("VaultKeyRegistry", () => {
  let registry: VaultKeyRegistry;
  let fetchMock: ReturnType<typeof makeFetch>;

  beforeEach(() => {
    fetchMock = makeFetch();
    registry  = new VaultKeyRegistry(
      { vaultAddr: BASE_URL, vaultToken: TOKEN, mountPath: "transit", projectSalt: PROJECT },
      fetchMock as unknown as typeof fetch,
    );
  });

  it("generateTenantDek returns 32-byte DEK from Vault response", async () => {
    const { plaintextDek, encryptedDek, keyId, version } =
      await registry.generateTenantDek("tenant-alpha");
    expect(plaintextDek).toHaveLength(32);
    expect(encryptedDek).toBe(VAULT_CIPHERTEXT);
    expect(keyId).toMatch(/^tk_/);
    expect(version).toBe(1);
    plaintextDek.fill(0);
  });

  it("sealForTenant / unsealForTenant round-trips plaintext", async () => {
    const plain     = new TextEncoder().encode("vault secret");
    const blob      = await registry.sealForTenant("tenant-alpha", plain);
    const recovered = await registry.unsealForTenant(blob);
    expect(new TextDecoder().decode(recovered)).toBe("vault secret");
  });

  it("unwrapDek calls Vault /decrypt/ endpoint", async () => {
    const { keyId } = await registry.generateTenantDek("tenant-beta");
    await registry.unwrapDek(keyId, VAULT_CIPHERTEXT);
    const calls = fetchMock.mock.calls.map(c => `${(c[1] as RequestInit).method?.toUpperCase()} ${c[0] as string}`);
    expect(calls.some(c => c.includes("POST") && c.includes("/decrypt/"))).toBe(true);
  });

  it("scheduleErasure calls /config (arm) then DELETE (destroy)", async () => {
    await registry.sealForTenant("tenant-erase", new TextEncoder().encode("x"));
    const receipt = await registry.scheduleErasure("tenant", "tenant-erase", "gdpr", "actor");

    expect(receipt.disabledAt).toBeTruthy();
    expect(receipt.scheduledDeletionAt).toBeTruthy();
    expect(receipt.actor).toBe("actor");

    const calls = fetchMock.mock.calls.map(
      c => `${(c[1] as RequestInit).method?.toUpperCase()} ${c[0] as string}`,
    );
    expect(calls.some(c => c.startsWith("POST") && c.includes("/config"))).toBe(true);
    expect(calls.some(c => c.startsWith("DELETE") && c.includes("/keys/"))).toBe(true);
  });

  it("unseal after scheduleErasure throws decrypt_denied", async () => {
    const blob = await registry.sealForTenant("tenant-gone", new TextEncoder().encode("data"));
    await registry.scheduleErasure("tenant", "tenant-gone", "test");
    await expect(registry.unsealForTenant(blob)).rejects.toThrow(/decrypt_denied|destroyed/i);
  });

  it("rotateKey calls Vault /rotate endpoint", async () => {
    await registry.sealForTenant("tenant-rot", new TextEncoder().encode("v1"));
    await registry.rotateKey("tenant", "tenant-rot");
    const calls = fetchMock.mock.calls.map(
      c => `${(c[1] as RequestInit).method?.toUpperCase()} ${c[0] as string}`,
    );
    expect(calls.some(c => c.startsWith("POST") && c.includes("/rotate"))).toBe(true);
  });
});
