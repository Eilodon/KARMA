import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import { KeystoreManager, encryptPrivateKeyV3 } from "../lib/keystore.js";
import { ENV } from "../config/env.js";

// Authoritative Web3 Secret Storage v3 (scrypt) vector produced by go-ethereum via
// `cast wallet import` (password "testpassword"). Cross-impl: geth ENCRYPT ↔ KARMA DECRYPT.
// PK = anvil account #0 → address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266.
const KNOWN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const VECTOR_CRYPTO = {
  cipher: "aes-128-ctr",
  ciphertext: "597ea34df4aa1a5327523855e5adfce21f4f609b130cb79d332a2a323f4ac2b1",
  cipherparams: { iv: "bcce71e196b308e315cc0390f261b4d4" },
  kdf: "scrypt",
  kdfparams: {
    dklen: 32,
    n: 8192,
    p: 1,
    r: 8,
    salt: "b65cb2cdd95c269b909e537ec256428b5bf9dc9746146db9ffc9063385181a15",
  },
  mac: "ac7314f582cc3da1c0f482fd1d5174cd152540aaee76b5cd2a1bada95cad3cf3",
};

let dir: string;
let fixturePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "karma-keystore-"));
  fixturePath = join(dir, "keystore.json");
  writeFileSync(
    fixturePath,
    JSON.stringify({ version: 3, agents: [{ agentId: "vector", crypto: VECTOR_CRYPTO }] }),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("KeystoreManager — Web3 Secret Storage v3 (scrypt)", () => {
  it("decrypts the canonical known vector to the correct address", async () => {
    const km = new KeystoreManager();
    await km.load(fixturePath, "testpassword");
    const expected = privateKeyToAccount(KNOWN_PK).address;
    expect(km.getAddress("vector")).toBe(expected);
  });

  it("rejects a wrong password via MAC mismatch (no silent garbage key)", async () => {
    const km = new KeystoreManager();
    await expect(km.load(fixturePath, "wrong-password")).rejects.toThrow(/MAC mismatch/i);
  });

  it("throws on unknown agent id", async () => {
    const km = new KeystoreManager();
    await km.load(fixturePath, "testpassword");
    expect(() => km.getAddress("nope")).toThrow(/Agent not found/i);
  });

  it("round-trips: encryptPrivateKeyV3 → load → same address", async () => {
    const crypto = await encryptPrivateKeyV3(KNOWN_PK, "pw123", { n: 4096 });
    const rtPath = join(dir, "roundtrip.json");
    writeFileSync(rtPath, JSON.stringify({ version: 3, agents: [{ agentId: "rt", crypto }] }));
    const km = new KeystoreManager();
    await km.load(rtPath, "pw123");
    expect(km.getAddress("rt")).toBe(privateKeyToAccount(KNOWN_PK).address);
  });
});

describe("KeystoreManager tenant binding (A1, STRIDE-S)", () => {
  it("assertOwnedBy: an agent with no tenant field binds to the default tenant", async () => {
    const km = new KeystoreManager();
    await km.load(fixturePath, "testpassword");
    const defaultTenant = ENV.KARMA_DEFAULT_AGENT_TENANT ?? ENV.MCP_TENANT_ID;
    expect(() => km.assertOwnedBy("vector", defaultTenant)).not.toThrow();
  });

  it("assertOwnedBy: rejects a tenant that does not own the agent (generic message, no owner leak)", async () => {
    const km = new KeystoreManager();
    await km.load(fixturePath, "testpassword");
    expect(() => km.assertOwnedBy("vector", "some-other-tenant")).toThrow(/not accessible to this tenant/i);
    try {
      km.assertOwnedBy("vector", "some-other-tenant");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(ENV.MCP_TENANT_ID);
    }
  });

  it("assertOwnedBy: honors an explicit per-agent tenant", async () => {
    const crypto = await encryptPrivateKeyV3(KNOWN_PK, "pw", { n: 4096 });
    const p = join(dir, "tenant.json");
    writeFileSync(p, JSON.stringify({ version: 3, agents: [{ agentId: "t1", tenant: "tenant-a", crypto }] }));
    const km = new KeystoreManager();
    await km.load(p, "pw");
    expect(() => km.assertOwnedBy("t1", "tenant-a")).not.toThrow();
    expect(() => km.assertOwnedBy("t1", "tenant-b")).toThrow(/not accessible/i);
  });

  it("assertOwnedBy: unknown agent throws not-found (checked before tenant)", async () => {
    const km = new KeystoreManager();
    await km.load(fixturePath, "testpassword");
    expect(() => km.assertOwnedBy("nope", "any")).toThrow(/Agent not found/i);
  });
});
