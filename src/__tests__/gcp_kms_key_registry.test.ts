import { describe, it, expect, vi, beforeEach } from "vitest";
import { GcpKmsKeyRegistry } from "../storage/providers/gcp_kms_key_registry.js";

// ── Fetch mock ─────────────────────────────────────────────────────────────
//
// The mock "encrypts" by echoing the plaintext as the ciphertext, and
// "decrypts" by echoing the ciphertext as the plaintext.  This is sufficient
// to verify the round-trip behaviour without live GCP credentials.

function ok(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200 });
}

function makeFetch() {
  return vi.fn(async (url: string, opts?: RequestInit): Promise<Response> => {
    const method = opts?.method ?? "GET";
    const body   = opts?.body ? JSON.parse(opts.body as string) : {};

    // GCP metadata token
    if (url.includes("metadata.google.internal")) {
      return ok({ access_token: "test-bearer-token", expires_in: 3600 });
    }
    // Create key ring (POST .../keyRings?keyRingId=...)
    if (method === "POST" && url.includes("/keyRings?keyRingId=")) {
      return ok({ name: url });
    }
    // Create CryptoKey (POST .../cryptoKeys?cryptoKeyId=...)
    if (method === "POST" && url.includes("/cryptoKeys?cryptoKeyId=")) {
      return ok({ name: url });
    }
    // Encrypt: echo plaintext back as ciphertext for testability
    if (method === "POST" && url.endsWith(":encrypt")) {
      return ok({ ciphertext: body.plaintext });
    }
    // Decrypt: echo ciphertext back as plaintext
    if (method === "POST" && url.endsWith(":decrypt")) {
      return ok({ plaintext: body.ciphertext });
    }
    // List CryptoKeyVersions (GET ...?filter=state%3DENABLED)
    if (method === "GET" && url.includes("/cryptoKeyVersions")) {
      return ok({
        cryptoKeyVersions: [{
          name:  "projects/test-proj/locations/global/keyRings/test-ring/cryptoKeys/tenant-xxx/cryptoKeyVersions/1",
          state: "ENABLED",
        }],
      });
    }
    // Destroy a key version
    if (method === "POST" && url.endsWith(":destroy")) {
      return ok({ state: "DESTROY_SCHEDULED" });
    }
    // Create a new CryptoKeyVersion (POST .../cryptoKeyVersions exactly)
    if (method === "POST" && url.endsWith("/cryptoKeyVersions")) {
      return ok({ name: `${url}/2` });
    }
    // Update primary version
    if (method === "POST" && url.endsWith(":updatePrimaryVersion")) {
      return ok({ name: url });
    }

    throw new Error(`Unhandled mock fetch: ${method} ${url}`);
  });
}

const BASE_CFG = {
  project:     "test-proj",
  location:    "global",
  keyRing:     "test-ring",
  projectSalt: "test-project",
  accessToken: "static-test-token", // skip metadata server fetch
};

describe("GcpKmsKeyRegistry", () => {
  let fetch: ReturnType<typeof makeFetch>;
  let reg: GcpKmsKeyRegistry;

  beforeEach(() => {
    fetch = makeFetch();
    reg   = new GcpKmsKeyRegistry(BASE_CFG, fetch as unknown as typeof globalThis.fetch);
  });

  it("generateTenantDek calls GCP encrypt endpoint and returns plaintext DEK + wrapped DEK", async () => {
    const { plaintextDek, encryptedDek, keyId, version } =
      await reg.generateTenantDek("tenant-1");

    expect(plaintextDek).toBeInstanceOf(Uint8Array);
    expect(plaintextDek.length).toBe(32);
    expect(encryptedDek).toBeTruthy();
    expect(keyId).toMatch(/^tk_/);
    expect(version).toBe(1);

    const encryptCalls = fetch.mock.calls.filter(([u]) => (u as string).endsWith(":encrypt"));
    expect(encryptCalls.length).toBeGreaterThan(0);
  });

  it("seal → unseal round-trip recovers original plaintext", async () => {
    const plaintext = new TextEncoder().encode(JSON.stringify({ data: "secret" }));
    const blob      = await reg.sealForTenant("tenant-2", plaintext);
    const result    = await reg.unsealForTenant(blob);

    expect(Buffer.from(result).toString()).toBe(Buffer.from(plaintext).toString());
  });

  it("unwrapDek calls GCP decrypt endpoint", async () => {
    const { encryptedDek, keyId } = await reg.generateTenantDek("tenant-3");
    fetch.mockClear();

    await reg.unwrapDek(keyId, encryptedDek);

    const decryptCalls = fetch.mock.calls.filter(([u]) => (u as string).endsWith(":decrypt"));
    expect(decryptCalls.length).toBe(1);
  });

  it("scheduleErasure calls list versions + destroy on each ENABLED version", async () => {
    await reg.getOrCreateActiveKey("tenant", "tenant-4");
    fetch.mockClear();

    const receipt = await reg.scheduleErasure("tenant", "tenant-4", "gdpr-right-to-erasure");

    const destroyCalls = fetch.mock.calls.filter(([u]) => (u as string).endsWith(":destroy"));
    expect(destroyCalls.length).toBeGreaterThan(0);
    expect(receipt.disabledAt).toBeTruthy();
    expect(receipt.scheduledDeletionAt).toBeTruthy();
    expect(receipt.reason).toBe("gdpr-right-to-erasure");
    // scheduledDeletionAt should be ~24h after disabledAt
    const diff = new Date(receipt.scheduledDeletionAt).getTime() - new Date(receipt.disabledAt).getTime();
    expect(diff).toBeGreaterThanOrEqual(23 * 3_600_000);
  });

  it("post-erasure unsealForTenant throws decrypt_denied", async () => {
    const plaintext = new TextEncoder().encode("to-be-erased");
    const blob      = await reg.sealForTenant("tenant-5", plaintext);

    await reg.scheduleErasure("tenant", "tenant-5", "erasure-test");

    await expect(reg.unsealForTenant(blob)).rejects.toThrow("decrypt_denied");
  });

  it("rotateKey creates a new version and calls updatePrimaryVersion", async () => {
    await reg.getOrCreateActiveKey("tenant", "tenant-6");
    fetch.mockClear();

    const record = await reg.rotateKey("tenant", "tenant-6");

    expect(record.version).toBe(2);
    const updateCalls = fetch.mock.calls.filter(
      ([u]) => (u as string).endsWith(":updatePrimaryVersion"),
    );
    expect(updateCalls.length).toBe(1);
  });

  it("uses static accessToken — skips metadata server fetch", async () => {
    await reg.generateTenantDek("tenant-7");

    const metaCalls = fetch.mock.calls.filter(
      ([u]) => (u as string).includes("metadata.google.internal"),
    );
    expect(metaCalls.length).toBe(0); // static token, no metadata fetch
  });

  it("auto-fetches token from GCP metadata server when no accessToken is set", async () => {
    const reg2 = new GcpKmsKeyRegistry(
      { ...BASE_CFG, accessToken: undefined },
      fetch as unknown as typeof globalThis.fetch,
    );
    await reg2.generateTenantDek("tenant-8");

    const metaCalls = fetch.mock.calls.filter(
      ([u]) => (u as string).includes("metadata.google.internal"),
    );
    expect(metaCalls.length).toBeGreaterThan(0);
  });

  it("getOrCreateActiveKey is idempotent — creates key only once", async () => {
    await reg.getOrCreateActiveKey("tenant", "tenant-9");
    fetch.mockClear();

    await reg.getOrCreateActiveKey("tenant", "tenant-9");
    // Second call: key already in local metadata, no GCP API call needed
    expect(fetch.mock.calls.length).toBe(0);
  });

  it("two tenants get separate opaque key IDs (cross-tenant isolation)", async () => {
    const r1 = await reg.getOrCreateActiveKey("tenant", "tenant-a");
    const r2 = await reg.getOrCreateActiveKey("tenant", "tenant-b");

    expect(r1.keyId).not.toBe(r2.keyId);
    expect(r1.opaqueSubjectId).not.toBe(r2.opaqueSubjectId);
  });
});
