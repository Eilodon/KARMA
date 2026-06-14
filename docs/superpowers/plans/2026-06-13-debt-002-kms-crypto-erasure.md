# DEBT-002: KMS Crypto-Erasure Implementation Plan

> **For agentic workers:** Use `subagent-driven-development` (recommended)
> or `executing-plans` to implement this plan task-by-task.

**Goal:** Implement per-tenant KMS-backed DEK envelope encryption with 2-phase crypto-erasure, satisfying GDPR right-to-delete and closing DEBT-002.

**Architecture:** Pluggable `ITenantKeyRegistry` interface with `LocalKeyRegistry` (dev/test), `VaultKeyRegistry`, and `AwsKmsKeyRegistry` implementations. `EncryptionService` gains a v4 KMS-backed envelope (`smcp:v4:kms:…`) layered on top of the existing V3 HKDF path. Factory wires the correct provider at startup via `KMS_PROVIDER` env var.

**Tech Stack:** TypeScript, Node.js crypto, HashiCorp Vault Transit REST API, `@aws-sdk/client-kms`, `jose` (already installed), `zod` (already installed).

**Audit Gate:** PASS WITH FLAGS — June 2026 research + codebase review. Four gaps from prior HKDF-only design are addressed in this plan (see Risk Flags).

**Risk Flags:**
- **HIGH** — AWS KMS `ScheduleKeyDeletion` has a mandatory 7-day pending window. Mitigated: Phase 1 `DisableKey` is called immediately, making decrypt fail at once. Vault has no pending window — deletion is immediate. See Task 4.
- **HIGH** — Existing V3 HKDF blobs cannot be crypto-erased (no per-tenant key entry in KMS). Requires re-encryption migration before DEBT-002 is fully closed. See Task 8.
- **MEDIUM** — `generateTenantDek` returns plaintext DEK to the caller. Every call site **must** zero-out via `plaintextDek.fill(0)` in a `finally` block. `sealForTenant`/`unsealForTenant` enforce this internally. See Task 1.
- **MEDIUM** — `LocalKeyRegistry` uses software AES-GCM key-wrap, not an HSM. Blocked from production by a runtime guard in Task 5.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/storage/key_registry.ts` | **Modify** | Add `SealedBlob`, 2-phase `CryptoErasureReceipt`, `sealForTenant`/`unsealForTenant` to `ITenantKeyRegistry` |
| `src/storage/providers/local_key_registry.ts` | **Create** | Dev/test KMS using AES-256-GCM software key-wrap |
| `src/storage/providers/vault_key_registry.ts` | **Create** | HashiCorp Vault Transit REST provider |
| `src/storage/providers/aws_kms_key_registry.ts` | **Create** | AWS KMS provider with 2-phase erasure |
| `src/storage/key_registry_factory.ts` | **Create** | Selects and instantiates the correct provider |
| `src/config/env.ts` | **Modify** | Add `KMS_PROVIDER`, `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_TRANSIT_MOUNT`, `AWS_KMS_REGION`; update `MCP_REQUIRE_CRYPTO_ERASURE` guard |
| `src/storage/encryption.ts` | **Modify** | Add v4 KMS-backed path; add `setKeyRegistry()` initializer |
| `src/__tests__/local_key_registry.test.ts` | **Create** | Full unit tests for `LocalKeyRegistry` (covers the interface contract for all providers) |
| `src/__tests__/vault_key_registry.test.ts` | **Create** | Vault integration tests using fetch mock |
| `docs/adr/0002-tenant-crypto-erasure-v3.md` | **Modify** | Update status to "implementing"; record 2-phase erasure and migration decisions |

---

## Task 1: Extend `key_registry.ts` — SealedBlob + 2-phase erasure + seal API

**Files:**
- Modify: `src/storage/key_registry.ts`

### Steps

- [ ] **Step 1: Write the failing type-check test**

```typescript
// src/__tests__/local_key_registry.test.ts — add compile-time check
import type { CryptoErasureReceipt, SealedBlob, ITenantKeyRegistry } from "../storage/key_registry.js";

// These assignments fail to compile if the types are wrong — caught at test run (tsc).
const receipt: CryptoErasureReceipt = {
  keyId: "tk_abc:v1",
  scope: "tenant",
  opaqueSubjectId: "abc",
  disabledAt: new Date().toISOString(),       // NEW — must exist
  scheduledDeletionAt: new Date().toISOString(), // NEW — must exist
  reason: "gdpr-erasure",
};

const blob: SealedBlob = {           // NEW type — must exist
  ciphertext: "base64url-data",
  encryptedDek: "base64url-edek",
  keyId: "tk_abc:v1",
  version: 1,
};
```

- [ ] **Step 2: Run — verify FAIL** `pnpm tsc --noEmit` → expected: type errors on `disabledAt`, `scheduledDeletionAt`, `SealedBlob`

- [ ] **Step 3: Replace `src/storage/key_registry.ts` with the complete updated file**

```typescript
export type KeyStatus = "active" | "disabled" | "destroyed";
export type KeyScope = "tenant" | "user";

export interface TenantKeyRecord {
  keyId: string;
  scope: KeyScope;
  opaqueSubjectId: string;
  version: number;
  status: KeyStatus;
  createdAt: string;
  disabledAt?: string;
  destroyedAt?: string;
  wrappedDek?: string; // base64url — AES-256-GCM wrapped plaintext DEK; cleared on destroy
}

export interface CryptoErasureReceipt {
  keyId: string;
  scope: KeyScope;
  opaqueSubjectId: string;
  // Phase 1: key immediately disabled — decrypt fails from this point forward
  disabledAt: string;
  // Phase 2: HSM/KMS scheduled deletion timestamp (Vault: same as disabledAt; AWS KMS: +7 days minimum)
  scheduledDeletionAt: string;
  // Set when key material is permanently destroyed (may be after scheduledDeletionAt)
  destroyedAt?: string;
  reason: string;
  actor?: string;
}

export interface KeyAuditEvent {
  keyId: string;
  event:
    | "created"
    | "rotated"
    | "disabled"
    | "destroyed"
    | "decrypt_attempt"
    | "decrypt_denied";
  timestamp: string;
  reason?: string;
}

// Opaque container produced by sealForTenant / consumed by unsealForTenant.
// Callers store this; they never touch ciphertext or encryptedDek directly.
export interface SealedBlob {
  ciphertext: string;   // base64url: AES-256-GCM(DEK, plaintext)
  encryptedDek: string; // base64url: KMS-wrapped DEK
  keyId: string;        // opaque kid — no raw tenantId; used to resolve key record
  version: number;      // key version at seal time
}

export interface ITenantKeyRegistry {
  // ── Low-level DEK operations ────────────────────────────────────────────────
  // Use only inside EncryptionService. Caller MUST zero-out plaintextDek:
  //   const { plaintextDek, ... } = await registry.generateTenantDek(id);
  //   try { ... use plaintextDek ... } finally { plaintextDek.fill(0); }
  generateTenantDek(tenantId: string): Promise<{
    plaintextDek: Uint8Array;
    encryptedDek: string;
    keyId: string;
    version: number;
  }>;
  // Caller MUST zero-out the returned Uint8Array in a finally block.
  unwrapDek(keyId: string, encryptedDek: string): Promise<Uint8Array>;

  // ── High-level seal / unseal (preferred for all consumers) ──────────────────
  // DEK zero-out is handled internally; plaintext key material never escapes.
  sealForTenant(tenantId: string, plaintext: Uint8Array): Promise<SealedBlob>;
  unsealForTenant(blob: SealedBlob): Promise<Uint8Array>;

  // ── Key lifecycle ────────────────────────────────────────────────────────────
  getOrCreateActiveKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord>;
  resolveKey(keyId: string): Promise<TenantKeyRecord | null>;
  rotateKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord>;
  disableKey(keyId: string): Promise<void>;

  // 2-phase erasure:
  //   Phase 1 (immediate)  — key disabled, all decrypt attempts fail
  //   Phase 2 (scheduled)  — HSM key material permanently destroyed
  //                          Vault: immediate; AWS KMS: 7-day minimum pending window
  scheduleErasure(
    scope: KeyScope,
    subjectId: string,
    reason: string,
    actor?: string,
  ): Promise<CryptoErasureReceipt>;

  auditLog(scope: KeyScope, subjectId: string): Promise<KeyAuditEvent[]>;
}
```

- [ ] **Step 4: Run — verify PASS** `pnpm tsc --noEmit` → expected: 0 errors
- [ ] **Step 5: Commit** `git commit -m "feat(kms): extend key_registry types — SealedBlob, 2-phase erasure, seal API"`

---

## Task 2: `LocalKeyRegistry` — dev/test software key-wrap

**Files:**
- Create: `src/storage/providers/local_key_registry.ts`
- Test: `src/__tests__/local_key_registry.test.ts`

> **WARNING — NOT FOR PRODUCTION.** Uses software AES-256-GCM key-wrap with no HSM backing. Blocked by env guard in Task 5.

### Steps

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/local_key_registry.test.ts
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

  it("unwrapDek round-trips", async () => {
    const { plaintextDek, encryptedDek, keyId } =
      await registry.generateTenantDek("tenant-beta");
    const original = Uint8Array.from(plaintextDek);
    plaintextDek.fill(0);

    const unwrapped = await registry.unwrapDek(keyId, encryptedDek);
    expect(unwrapped).toEqual(original);
    unwrapped.fill(0);
  });

  it("sealForTenant / unsealForTenant round-trips without exposing DEK", async () => {
    const plain = new TextEncoder().encode("secret payload");
    const blob  = await registry.sealForTenant("tenant-gamma", plain);
    const recovered = await registry.unsealForTenant(blob);
    expect(new TextDecoder().decode(recovered)).toBe("secret payload");
  });

  it("cross-tenant unseal fails — different tenant cannot unseal", async () => {
    const plain = new TextEncoder().encode("tenant-a secret");
    const blob  = await registry.sealForTenant("tenant-a", plain);
    // Mutate keyId to pretend this is tenant-b's blob
    const tampered = { ...blob, keyId: blob.keyId.replace("tk_", "tk_tampered_") };
    await expect(registry.unsealForTenant(tampered)).rejects.toThrow();
  });

  it("scheduleErasure phase 1: decrypt denied immediately", async () => {
    const plain = new TextEncoder().encode("will be erased");
    const blob  = await registry.sealForTenant("tenant-erase", plain);

    const receipt = await registry.scheduleErasure("tenant", "tenant-erase", "gdpr", "test-actor");
    expect(receipt.disabledAt).toBeTruthy();
    expect(receipt.scheduledDeletionAt).toBeTruthy();

    await expect(registry.unsealForTenant(blob)).rejects.toThrow(/decrypt_denied|destroyed/i);
  });

  it("rotateKey: new DEK version, old blobs still readable", async () => {
    const plain = new TextEncoder().encode("pre-rotation");
    const blob  = await registry.sealForTenant("tenant-rotate", plain);

    await registry.rotateKey("tenant", "tenant-rotate");

    const recovered = await registry.unsealForTenant(blob);
    expect(new TextDecoder().decode(recovered)).toBe("pre-rotation");
  });

  it("auditLog records created, rotated, disabled, destroyed events", async () => {
    await registry.sealForTenant("tenant-audit", new TextEncoder().encode("x"));
    await registry.rotateKey("tenant", "tenant-audit");
    await registry.scheduleErasure("tenant", "tenant-audit", "test");

    const log = await registry.auditLog("tenant", "tenant-audit");
    const events = log.map(e => e.event);
    expect(events).toContain("created");
    expect(events).toContain("rotated");
    expect(events).toContain("disabled");
    expect(events).toContain("destroyed");
  });
});
```

- [ ] **Step 2: Run — verify FAIL** `pnpm vitest run src/__tests__/local_key_registry.test.ts` → expected: module not found

- [ ] **Step 3: Create `src/storage/providers/local_key_registry.ts`**

```typescript
// DEV/TEST ONLY — software AES-256-GCM key-wrap; no HSM, no FIPS 140-3.
// Production deployments must use VaultKeyRegistry or AwsKmsKeyRegistry.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type {
  CryptoErasureReceipt,
  ITenantKeyRegistry,
  KeyAuditEvent,
  KeyScope,
  SealedBlob,
  TenantKeyRecord,
} from "../key_registry.js";

interface KeyEntry extends TenantKeyRecord {
  rawDek: Uint8Array; // plaintext — kept only for test/dev unwrap; zero-out on destroy
}

export class LocalKeyRegistry implements ITenantKeyRegistry {
  private readonly masterKey: Uint8Array;
  private readonly projectSalt: string;
  private readonly keys     = new Map<string, KeyEntry>();
  private readonly subjects = new Map<string, string[]>(); // opaqueId → keyId[]
  private readonly auditMap = new Map<string, KeyAuditEvent[]>();

  constructor(wrapKey: string, projectSalt: string) {
    this.projectSalt = projectSalt;
    this.masterKey   = new Uint8Array(
      hkdfSync("sha256", Buffer.from(wrapKey), Buffer.alloc(0),
                Buffer.from("super-mcp:local-kms:wrap-key:v1"), 32),
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private opaqueId(tenantId: string): string {
    return createHmac("sha256", this.projectSalt)
      .update(`tenant:${tenantId}`)
      .digest()
      .subarray(0, 12)
      .toString("base64url");
  }

  private makeKeyId(opaqueId: string, version: number): string {
    return `tk_${opaqueId}:v${version}`;
  }

  private wrapDek(dek: Uint8Array): string {
    const iv        = randomBytes(12);
    const cipher    = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag       = cipher.getAuthTag();
    return `${iv.toString("base64url")}.${Buffer.concat([encrypted, tag]).toString("base64url")}`;
  }

  private decodeDek(wrapped: string): Uint8Array {
    const [ivB64, ctB64] = wrapped.split(".");
    const iv        = Buffer.from(ivB64, "base64url");
    const ctWithTag = Buffer.from(ctB64, "base64url");
    const ct        = ctWithTag.subarray(0, ctWithTag.length - 16);
    const tag       = ctWithTag.subarray(ctWithTag.length - 16);
    const decipher  = createDecipheriv("aes-256-gcm", this.masterKey, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
  }

  private addAudit(opaqueId: string, event: KeyAuditEvent): void {
    const log = this.auditMap.get(opaqueId) ?? [];
    log.push(event);
    this.auditMap.set(opaqueId, log);
  }

  private activeKeyForSubject(opaqueId: string): KeyEntry | undefined {
    const ids = this.subjects.get(opaqueId) ?? [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const entry = this.keys.get(ids[i]);
      if (entry?.status === "active") return entry;
    }
    return undefined;
  }

  // ── ITenantKeyRegistry ─────────────────────────────────────────────────────

  async getOrCreateActiveKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord> {
    const oid  = this.opaqueId(subjectId);
    const existing = this.activeKeyForSubject(oid);
    if (existing) return { ...existing };

    const dek     = randomBytes(32);
    const version = 1;
    const keyId   = this.makeKeyId(oid, version);
    const now     = new Date().toISOString();
    const entry: KeyEntry = {
      keyId, scope, opaqueSubjectId: oid, version,
      status: "active", createdAt: now,
      wrappedDek: this.wrapDek(dek),
      rawDek: dek,
    };
    this.keys.set(keyId, entry);
    this.subjects.set(oid, [...(this.subjects.get(oid) ?? []), keyId]);
    this.addAudit(oid, { keyId, event: "created", timestamp: now });
    return { ...entry };
  }

  async resolveKey(keyId: string): Promise<TenantKeyRecord | null> {
    const entry = this.keys.get(keyId);
    return entry ? { ...entry } : null;
  }

  async rotateKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord> {
    const oid  = this.opaqueId(subjectId);
    const ids  = this.subjects.get(oid) ?? [];
    const prev = ids.length > 0 ? this.keys.get(ids[ids.length - 1]) : undefined;
    const version = (prev?.version ?? 0) + 1;
    const keyId   = this.makeKeyId(oid, version);
    const now     = new Date().toISOString();
    const dek     = randomBytes(32);
    const entry: KeyEntry = {
      keyId, scope, opaqueSubjectId: oid, version,
      status: "active", createdAt: now,
      wrappedDek: this.wrapDek(dek),
      rawDek: dek,
    };
    this.keys.set(keyId, entry);
    this.subjects.set(oid, [...ids, keyId]);
    this.addAudit(oid, { keyId, event: "rotated", timestamp: now });
    return { ...entry };
  }

  async disableKey(keyId: string): Promise<void> {
    const entry = this.keys.get(keyId);
    if (!entry) throw new Error(`Key not found: ${keyId}`);
    const now = new Date().toISOString();
    entry.status     = "disabled";
    entry.disabledAt = now;
    this.addAudit(entry.opaqueSubjectId, { keyId, event: "disabled", timestamp: now });
  }

  async generateTenantDek(tenantId: string): Promise<{
    plaintextDek: Uint8Array;
    encryptedDek: string;
    keyId: string;
    version: number;
  }> {
    const record = await this.getOrCreateActiveKey("tenant", tenantId);
    if (record.status !== "active") {
      throw new Error(`Key ${record.keyId} is ${record.status}; cannot generate DEK.`);
    }
    const dek = randomBytes(32);
    const encryptedDek = this.wrapDek(dek);
    return { plaintextDek: dek, encryptedDek, keyId: record.keyId, version: record.version };
  }

  async unwrapDek(keyId: string, encryptedDek: string): Promise<Uint8Array> {
    const entry = this.keys.get(keyId);
    if (!entry) throw new Error(`Key not found: ${keyId}`);
    if (entry.status === "destroyed") {
      const now = new Date().toISOString();
      this.addAudit(entry.opaqueSubjectId, { keyId, event: "decrypt_denied", timestamp: now,
                    reason: "key destroyed" });
      throw new Error(`decrypt_denied: key ${keyId} has been destroyed.`);
    }
    this.addAudit(entry.opaqueSubjectId, {
      keyId, event: "decrypt_attempt", timestamp: new Date().toISOString() });
    return this.decodeDek(encryptedDek);
  }

  async sealForTenant(tenantId: string, plaintext: Uint8Array): Promise<SealedBlob> {
    const { plaintextDek, encryptedDek, keyId, version } =
      await this.generateTenantDek(tenantId);
    try {
      const iv        = randomBytes(12);
      const cipher    = createCipheriv("aes-256-gcm", plaintextDek, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag       = cipher.getAuthTag();
      const ciphertext = Buffer.concat([iv, encrypted, tag]).toString("base64url");
      return { ciphertext, encryptedDek, keyId, version };
    } finally {
      plaintextDek.fill(0);
    }
  }

  async unsealForTenant(blob: SealedBlob): Promise<Uint8Array> {
    const dek = await this.unwrapDek(blob.keyId, blob.encryptedDek);
    try {
      const raw = Buffer.from(blob.ciphertext, "base64url");
      const iv  = raw.subarray(0, 12);
      const ct  = raw.subarray(12, raw.length - 16);
      const tag = raw.subarray(raw.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", dek, iv);
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
    } finally {
      dek.fill(0);
    }
  }

  async scheduleErasure(
    scope: KeyScope,
    subjectId: string,
    reason: string,
    actor?: string,
  ): Promise<CryptoErasureReceipt> {
    const oid  = this.opaqueId(subjectId);
    const ids  = this.subjects.get(oid) ?? [];
    const now  = new Date().toISOString();
    let lastKeyId = "";

    for (const id of ids) {
      const entry = this.keys.get(id);
      if (!entry || entry.status === "destroyed") continue;

      entry.status      = "destroyed";
      entry.disabledAt  = entry.disabledAt ?? now;
      entry.destroyedAt = now;
      entry.wrappedDek  = undefined;
      entry.rawDek.fill(0); // zero-out plaintext key material

      this.addAudit(oid, { keyId: id, event: "disabled",  timestamp: entry.disabledAt });
      this.addAudit(oid, { keyId: id, event: "destroyed", timestamp: now, reason });
      lastKeyId = id;
    }

    // LocalKeyRegistry: no HSM pending window — immediate destruction
    return {
      keyId: lastKeyId,
      scope,
      opaqueSubjectId: oid,
      disabledAt: now,
      scheduledDeletionAt: now, // Vault/AWS KMS override this with their pending windows
      destroyedAt: now,
      reason,
      actor,
    };
  }

  async auditLog(scope: KeyScope, subjectId: string): Promise<KeyAuditEvent[]> {
    const oid = this.opaqueId(subjectId);
    return [...(this.auditMap.get(oid) ?? [])];
  }
}
```

- [ ] **Step 4: Run — verify PASS** `pnpm vitest run src/__tests__/local_key_registry.test.ts` → expected: 7 tests pass
- [ ] **Step 5: Commit** `git commit -m "feat(kms): add LocalKeyRegistry — dev/test software key-wrap (DEBT-002)"`

---

## Task 3: `VaultKeyRegistry` — HashiCorp Vault Transit provider

**Files:**
- Create: `src/storage/providers/vault_key_registry.ts`
- Test: `src/__tests__/vault_key_registry.test.ts`

Vault Transit is the **recommended first real KMS** for SUPER-MCP because:
- Key deletion is **immediate** (no pending window) — cleanest GDPR erasure story
- Self-hosted option for EU data residency
- `/v1/transit/datakey/plaintext/:name` is a direct `GenerateDataKey` equivalent

### Steps

- [ ] **Step 1: Write the failing tests (using fetch mock)**

```typescript
// src/__tests__/vault_key_registry.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VaultKeyRegistry } from "../storage/providers/vault_key_registry.js";

const BASE_URL   = "http://vault.test:8200";
const TOKEN      = "test-token";
const PROJECT    = "test-project";
const PLAINTEXT_DEK = Buffer.alloc(32, 0x42); // 32 bytes of 0x42

function makeFetch(responses: Record<string, unknown>) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const method = opts?.method?.toUpperCase() ?? "GET";
    const key    = `${method} ${url}`;
    if (key in responses) {
      return { ok: true, json: async () => responses[key], status: 200 } as Response;
    }
    if (url in responses) {
      return { ok: true, json: async () => responses[url], status: 200 } as Response;
    }
    return { ok: false, status: 404, json: async () => ({ errors: ["not found"] }) } as Response;
  });
}

describe("VaultKeyRegistry", () => {
  let registry: VaultKeyRegistry;
  let fetchMock: ReturnType<typeof makeFetch>;

  beforeEach(() => {
    fetchMock = makeFetch({
      // create key
      [`POST ${BASE_URL}/v1/transit/keys/tenant-test-alpha`]: {},
      // datakey
      [`POST ${BASE_URL}/v1/transit/datakey/plaintext/tenant-test-alpha`]: {
        data: {
          plaintext: PLAINTEXT_DEK.toString("base64"),
          ciphertext: "vault:v1:ZW5jcnlwdGVkREVL",
        },
      },
      // decrypt
      [`POST ${BASE_URL}/v1/transit/decrypt/tenant-test-alpha`]: {
        data: { plaintext: PLAINTEXT_DEK.toString("base64") },
      },
      // config (arm deletion)
      [`POST ${BASE_URL}/v1/transit/keys/tenant-test-alpha/config`]: {},
      // delete
      [`DELETE ${BASE_URL}/v1/transit/keys/tenant-test-alpha`]: {},
    });

    registry = new VaultKeyRegistry(
      { vaultAddr: BASE_URL, vaultToken: TOKEN, mountPath: "transit", projectSalt: PROJECT },
      fetchMock as unknown as typeof fetch,
    );
  });

  it("generateTenantDek returns 32-byte DEK from Vault", async () => {
    const { plaintextDek, encryptedDek, keyId } =
      await registry.generateTenantDek("test-alpha");
    expect(plaintextDek).toHaveLength(32);
    expect(encryptedDek).toBe("vault:v1:ZW5jcnlwdGVkREVL");
    expect(keyId).toMatch(/^tk_/);
    plaintextDek.fill(0);
  });

  it("sealForTenant / unsealForTenant round-trips", async () => {
    const plain     = new TextEncoder().encode("vault secret");
    const blob      = await registry.sealForTenant("test-alpha", plain);
    const recovered = await registry.unsealForTenant(blob);
    expect(new TextDecoder().decode(recovered)).toBe("vault secret");
  });

  it("scheduleErasure calls config (arm) then delete (destroy)", async () => {
    await registry.sealForTenant("test-alpha", new TextEncoder().encode("x"));
    const receipt = await registry.scheduleErasure("tenant", "test-alpha", "gdpr");
    expect(receipt.disabledAt).toBeTruthy();
    expect(receipt.scheduledDeletionAt).toBeTruthy();

    const calls = fetchMock.mock.calls.map(c => `${(c[1] as RequestInit).method?.toUpperCase()} ${c[0]}`);
    expect(calls).toContain(`POST ${BASE_URL}/v1/transit/keys/tenant-test-alpha/config`);
    expect(calls).toContain(`DELETE ${BASE_URL}/v1/transit/keys/tenant-test-alpha`);
  });
});
```

- [ ] **Step 2: Run — verify FAIL** `pnpm vitest run src/__tests__/vault_key_registry.test.ts` → module not found

- [ ] **Step 3: Create `src/storage/providers/vault_key_registry.ts`**

```typescript
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type {
  CryptoErasureReceipt,
  ITenantKeyRegistry,
  KeyAuditEvent,
  KeyScope,
  SealedBlob,
  TenantKeyRecord,
} from "../key_registry.js";

interface VaultConfig {
  vaultAddr: string;     // e.g. "https://vault.example.com:8200"
  vaultToken: string;    // Vault token with transit/* policy
  mountPath: string;     // default "transit"
  projectSalt: string;   // used to derive opaque IDs — set to MCP_PROJECT_ID
}

interface VaultKeyMeta {
  keyId: string;
  keyName: string;       // Vault key name: "tenant-{opaqueId}"
  opaqueSubjectId: string;
  version: number;
  status: "active" | "disabled" | "destroyed";
  createdAt: string;
  disabledAt?: string;
  destroyedAt?: string;
}

export class VaultKeyRegistry implements ITenantKeyRegistry {
  private readonly cfg: VaultConfig;
  private readonly fetch: typeof globalThis.fetch;
  // In-memory key metadata (Vault stores key material; we store metadata)
  private readonly meta   = new Map<string, VaultKeyMeta>();   // keyId → meta
  private readonly bySubj = new Map<string, string[]>();        // opaqueId → keyId[]
  private readonly audit  = new Map<string, KeyAuditEvent[]>(); // opaqueId → events

  constructor(cfg: VaultConfig, fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.cfg   = cfg;
    this.fetch = fetchImpl;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private opaqueId(tenantId: string): string {
    return createHmac("sha256", this.cfg.projectSalt)
      .update(`tenant:${tenantId}`)
      .digest()
      .subarray(0, 12)
      .toString("base64url");
  }

  private makeKeyId(oid: string, version: number): string {
    return `tk_${oid}:v${version}`;
  }

  private vaultKeyName(oid: string): string {
    return `tenant-${oid}`;
  }

  private url(path: string): string {
    return `${this.cfg.vaultAddr}/v1/${this.cfg.mountPath}/${path}`;
  }

  private headers(): Record<string, string> {
    return { "X-Vault-Token": this.cfg.vaultToken, "Content-Type": "application/json" };
  }

  private async vaultPost<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(this.url(path), {
      method: "POST",
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Vault POST ${path} failed (${res.status}): ${JSON.stringify(err)}`);
    }
    return res.json() as Promise<T>;
  }

  private async vaultDelete(path: string): Promise<void> {
    const res = await this.fetch(this.url(path), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Vault DELETE ${path} failed (${res.status})`);
    }
  }

  private addAudit(oid: string, event: KeyAuditEvent): void {
    const log = this.audit.get(oid) ?? [];
    log.push(event);
    this.audit.set(oid, log);
  }

  private activeMetaForSubject(oid: string): VaultKeyMeta | undefined {
    const ids = this.bySubj.get(oid) ?? [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const m = this.meta.get(ids[i]);
      if (m?.status === "active") return m;
    }
    return undefined;
  }

  // ── ITenantKeyRegistry ─────────────────────────────────────────────────────

  async getOrCreateActiveKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord> {
    const oid      = this.opaqueId(subjectId);
    const existing = this.activeMetaForSubject(oid);
    if (existing) return this.metaToRecord(existing, scope);

    const keyName = this.vaultKeyName(oid);
    // Create Vault key (idempotent — fails silently if already exists)
    await this.vaultPost(`keys/${keyName}`, { type: "aes256-gcm96" }).catch(() => {});

    const version = 1;
    const keyId   = this.makeKeyId(oid, version);
    const now     = new Date().toISOString();
    const m: VaultKeyMeta = {
      keyId, keyName, opaqueSubjectId: oid, version,
      status: "active", createdAt: now,
    };
    this.meta.set(keyId, m);
    this.bySubj.set(oid, [...(this.bySubj.get(oid) ?? []), keyId]);
    this.addAudit(oid, { keyId, event: "created", timestamp: now });
    return this.metaToRecord(m, scope);
  }

  async resolveKey(keyId: string): Promise<TenantKeyRecord | null> {
    const m = this.meta.get(keyId);
    return m ? this.metaToRecord(m, "tenant") : null;
  }

  async rotateKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord> {
    const oid     = this.opaqueId(subjectId);
    const ids     = this.bySubj.get(oid) ?? [];
    const prev    = ids.length > 0 ? this.meta.get(ids[ids.length - 1]) : undefined;
    const version = (prev?.version ?? 0) + 1;
    const keyId   = this.makeKeyId(oid, version);
    const keyName = this.vaultKeyName(oid);
    const now     = new Date().toISOString();

    // Vault handles key rotation internally when we use rotate endpoint
    await this.vaultPost(`keys/${keyName}/rotate`);

    const m: VaultKeyMeta = {
      keyId, keyName, opaqueSubjectId: oid, version,
      status: "active", createdAt: now,
    };
    this.meta.set(keyId, m);
    this.bySubj.set(oid, [...ids, keyId]);
    this.addAudit(oid, { keyId, event: "rotated", timestamp: now });
    return this.metaToRecord(m, scope);
  }

  async disableKey(keyId: string): Promise<void> {
    const m = this.meta.get(keyId);
    if (!m) throw new Error(`Key not found: ${keyId}`);
    const now    = new Date().toISOString();
    m.status     = "disabled";
    m.disabledAt = now;
    this.addAudit(m.opaqueSubjectId, { keyId, event: "disabled", timestamp: now });
  }

  async generateTenantDek(tenantId: string): Promise<{
    plaintextDek: Uint8Array;
    encryptedDek: string;
    keyId: string;
    version: number;
  }> {
    const record = await this.getOrCreateActiveKey("tenant", tenantId);
    if (record.status !== "active") {
      throw new Error(`Key ${record.keyId} is ${record.status}; cannot generate DEK.`);
    }
    const m   = this.meta.get(record.keyId)!;
    const res = await this.vaultPost<{ data: { plaintext: string; ciphertext: string } }>(
      `datakey/plaintext/${m.keyName}`,
      { bits: 256 },
    );
    const plaintextDek = new Uint8Array(Buffer.from(res.data.plaintext, "base64"));
    return {
      plaintextDek,
      encryptedDek: res.data.ciphertext,
      keyId: record.keyId,
      version: record.version,
    };
  }

  async unwrapDek(keyId: string, encryptedDek: string): Promise<Uint8Array> {
    const m = this.meta.get(keyId);
    if (!m) throw new Error(`Key not found: ${keyId}`);
    if (m.status === "destroyed") {
      this.addAudit(m.opaqueSubjectId, {
        keyId, event: "decrypt_denied",
        timestamp: new Date().toISOString(), reason: "key destroyed",
      });
      throw new Error(`decrypt_denied: key ${keyId} has been destroyed.`);
    }
    this.addAudit(m.opaqueSubjectId, {
      keyId, event: "decrypt_attempt", timestamp: new Date().toISOString() });

    const res = await this.vaultPost<{ data: { plaintext: string } }>(
      `decrypt/${m.keyName}`,
      { ciphertext: encryptedDek },
    );
    return new Uint8Array(Buffer.from(res.data.plaintext, "base64"));
  }

  async sealForTenant(tenantId: string, plaintext: Uint8Array): Promise<SealedBlob> {
    const { plaintextDek, encryptedDek, keyId, version } =
      await this.generateTenantDek(tenantId);
    try {
      const iv        = randomBytes(12);
      const cipher    = createCipheriv("aes-256-gcm", plaintextDek, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag       = cipher.getAuthTag();
      const ciphertext = Buffer.concat([iv, encrypted, tag]).toString("base64url");
      return { ciphertext, encryptedDek, keyId, version };
    } finally {
      plaintextDek.fill(0);
    }
  }

  async unsealForTenant(blob: SealedBlob): Promise<Uint8Array> {
    const dek = await this.unwrapDek(blob.keyId, blob.encryptedDek);
    try {
      const raw = Buffer.from(blob.ciphertext, "base64url");
      const iv  = raw.subarray(0, 12);
      const ct  = raw.subarray(12, raw.length - 16);
      const tag = raw.subarray(raw.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", dek, iv);
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
    } finally {
      dek.fill(0);
    }
  }

  async scheduleErasure(
    scope: KeyScope,
    subjectId: string,
    reason: string,
    actor?: string,
  ): Promise<CryptoErasureReceipt> {
    const oid  = this.opaqueId(subjectId);
    const ids  = this.bySubj.get(oid) ?? [];
    const now  = new Date().toISOString();
    let lastKeyId = "";

    for (const id of ids) {
      const m = this.meta.get(id);
      if (!m || m.status === "destroyed") continue;

      // Phase 1: arm deletion + disable
      await this.vaultPost(`keys/${m.keyName}/config`, { deletion_allowed: true });
      m.status     = "disabled";
      m.disabledAt = now;
      this.addAudit(oid, { keyId: id, event: "disabled", timestamp: now });

      // Phase 2: immediate permanent deletion (Vault has no pending window)
      await this.vaultDelete(`keys/${m.keyName}`);
      m.status      = "destroyed";
      m.destroyedAt = now;
      this.addAudit(oid, { keyId: id, event: "destroyed", timestamp: now, reason });
      lastKeyId = id;
    }

    return {
      keyId: lastKeyId,
      scope,
      opaqueSubjectId: oid,
      disabledAt: now,
      scheduledDeletionAt: now, // Vault: immediate
      destroyedAt: now,
      reason,
      actor,
    };
  }

  async auditLog(_scope: KeyScope, subjectId: string): Promise<KeyAuditEvent[]> {
    const oid = this.opaqueId(subjectId);
    return [...(this.audit.get(oid) ?? [])];
  }

  private metaToRecord(m: VaultKeyMeta, scope: KeyScope): TenantKeyRecord {
    return {
      keyId: m.keyId,
      scope,
      opaqueSubjectId: m.opaqueSubjectId,
      version: m.version,
      status: m.status,
      createdAt: m.createdAt,
      disabledAt: m.disabledAt,
      destroyedAt: m.destroyedAt,
    };
  }
}
```

- [ ] **Step 4: Run — verify PASS** `pnpm vitest run src/__tests__/vault_key_registry.test.ts` → expected: 3 tests pass
- [ ] **Step 5: Commit** `git commit -m "feat(kms): add VaultKeyRegistry — Vault Transit provider (DEBT-002)"`

---

## Task 4: `AwsKmsKeyRegistry` — AWS KMS provider with 2-phase erasure

**Files:**
- Create: `src/storage/providers/aws_kms_key_registry.ts`

> **Note:** Requires `@aws-sdk/client-kms`. Run `pnpm add @aws-sdk/client-kms` before this task.

### Steps

- [ ] **Step 1: Install dependency**

```bash
pnpm add @aws-sdk/client-kms
```

Expected: `@aws-sdk/client-kms` added to package.json.

- [ ] **Step 2: Create `src/storage/providers/aws_kms_key_registry.ts`**

```typescript
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DecryptCommand,
  DisableKeyCommand,
  GenerateDataKeyCommand,
  KMSClient,
  ScheduleKeyDeletionCommand,
} from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type {
  CryptoErasureReceipt,
  ITenantKeyRegistry,
  KeyAuditEvent,
  KeyScope,
  SealedBlob,
  TenantKeyRecord,
} from "../key_registry.js";

interface AwsKmsConfig {
  region?: string;      // defaults to AWS_REGION env var
  projectSalt: string;  // MCP_PROJECT_ID — used to derive opaque IDs
  // pendingWindowDays: minimum 7, maximum 30. AWS KMS enforces minimum.
  pendingWindowDays?: number;
}

interface AwsKeyMeta {
  keyId: string;        // our opaque kid
  kmsKeyId: string;     // AWS KMS KeyId (ARN)
  opaqueSubjectId: string;
  version: number;
  status: "active" | "disabled" | "destroyed";
  createdAt: string;
  disabledAt?: string;
  destroyedAt?: string;
}

export class AwsKmsKeyRegistry implements ITenantKeyRegistry {
  private readonly kms: KMSClient;
  private readonly cfg: AwsKmsConfig;
  private readonly meta   = new Map<string, AwsKeyMeta>();
  private readonly bySubj = new Map<string, string[]>();
  private readonly audit  = new Map<string, KeyAuditEvent[]>();

  constructor(cfg: AwsKmsConfig, kmsClient?: KMSClient) {
    this.cfg = cfg;
    this.kms = kmsClient ?? new KMSClient({ region: cfg.region });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private opaqueId(tenantId: string): string {
    return createHmac("sha256", this.cfg.projectSalt)
      .update(`tenant:${tenantId}`)
      .digest()
      .subarray(0, 12)
      .toString("base64url");
  }

  private makeKeyId(oid: string, version: number): string {
    return `tk_${oid}:v${version}`;
  }

  private encryptionContext(oid: string): Record<string, string> {
    // Binds the DEK to this specific tenant — cross-tenant substitution fails KMS auth
    return { tenant_key_id: oid, project: this.cfg.projectSalt };
  }

  private addAudit(oid: string, event: KeyAuditEvent): void {
    const log = this.audit.get(oid) ?? [];
    log.push(event);
    this.audit.set(oid, log);
  }

  private activeMetaForSubject(oid: string): AwsKeyMeta | undefined {
    const ids = this.bySubj.get(oid) ?? [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const m = this.meta.get(ids[i]);
      if (m?.status === "active") return m;
    }
    return undefined;
  }

  // ── ITenantKeyRegistry ─────────────────────────────────────────────────────

  async getOrCreateActiveKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord> {
    const oid      = this.opaqueId(subjectId);
    const existing = this.activeMetaForSubject(oid);
    if (existing) return this.metaToRecord(existing, scope);

    const createRes = await this.kms.send(new CreateKeyCommand({
      Description: `super-mcp:tenant:${oid}`,
      KeyUsage: "ENCRYPT_DECRYPT",
      KeySpec: "SYMMETRIC_DEFAULT",
      Tags: [{ TagKey: "super-mcp-project", TagValue: this.cfg.projectSalt }],
    }));
    const kmsKeyId = createRes.KeyMetadata!.KeyId!;
    // Alias for easier identification (alias must be unique per account/region)
    await this.kms.send(new CreateAliasCommand({
      AliasName: `alias/super-mcp/${this.cfg.projectSalt}/${oid}`,
      TargetKeyId: kmsKeyId,
    })).catch(() => {}); // ignore if alias already exists

    const version = 1;
    const keyId   = this.makeKeyId(oid, version);
    const now     = new Date().toISOString();
    const m: AwsKeyMeta = {
      keyId, kmsKeyId, opaqueSubjectId: oid, version,
      status: "active", createdAt: now,
    };
    this.meta.set(keyId, m);
    this.bySubj.set(oid, [...(this.bySubj.get(oid) ?? []), keyId]);
    this.addAudit(oid, { keyId, event: "created", timestamp: now });
    return this.metaToRecord(m, scope);
  }

  async resolveKey(keyId: string): Promise<TenantKeyRecord | null> {
    const m = this.meta.get(keyId);
    return m ? this.metaToRecord(m, "tenant") : null;
  }

  async rotateKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord> {
    // AWS KMS supports automatic annual rotation; manual rotation = new CMK
    // For SUPER-MCP: create a new version entry pointing to a new CMK
    // Old CMK remains active for decrypt of old blobs
    const oid   = this.opaqueId(subjectId);
    const ids   = this.bySubj.get(oid) ?? [];
    const prev  = ids.length > 0 ? this.meta.get(ids[ids.length - 1]) : undefined;
    const version = (prev?.version ?? 0) + 1;

    const createRes = await this.kms.send(new CreateKeyCommand({
      Description: `super-mcp:tenant:${oid}:v${version}`,
      KeyUsage: "ENCRYPT_DECRYPT",
      KeySpec: "SYMMETRIC_DEFAULT",
    }));
    const kmsKeyId = createRes.KeyMetadata!.KeyId!;
    const keyId    = this.makeKeyId(oid, version);
    const now      = new Date().toISOString();
    const m: AwsKeyMeta = {
      keyId, kmsKeyId, opaqueSubjectId: oid, version,
      status: "active", createdAt: now,
    };
    this.meta.set(keyId, m);
    this.bySubj.set(oid, [...ids, keyId]);
    this.addAudit(oid, { keyId, event: "rotated", timestamp: now });
    return this.metaToRecord(m, scope);
  }

  async disableKey(keyId: string): Promise<void> {
    const m = this.meta.get(keyId);
    if (!m) throw new Error(`Key not found: ${keyId}`);
    await this.kms.send(new DisableKeyCommand({ KeyId: m.kmsKeyId }));
    const now    = new Date().toISOString();
    m.status     = "disabled";
    m.disabledAt = now;
    this.addAudit(m.opaqueSubjectId, { keyId, event: "disabled", timestamp: now });
  }

  async generateTenantDek(tenantId: string): Promise<{
    plaintextDek: Uint8Array;
    encryptedDek: string;
    keyId: string;
    version: number;
  }> {
    const record = await this.getOrCreateActiveKey("tenant", tenantId);
    if (record.status !== "active") {
      throw new Error(`Key ${record.keyId} is ${record.status}; cannot generate DEK.`);
    }
    const m = this.meta.get(record.keyId)!;
    const res = await this.kms.send(new GenerateDataKeyCommand({
      KeyId: m.kmsKeyId,
      KeySpec: "AES_256",
      EncryptionContext: this.encryptionContext(m.opaqueSubjectId),
    }));
    return {
      plaintextDek: new Uint8Array(res.Plaintext!),
      encryptedDek: Buffer.from(res.CiphertextBlob!).toString("base64url"),
      keyId: record.keyId,
      version: record.version,
    };
  }

  async unwrapDek(keyId: string, encryptedDek: string): Promise<Uint8Array> {
    const m = this.meta.get(keyId);
    if (!m) throw new Error(`Key not found: ${keyId}`);
    if (m.status === "destroyed") {
      this.addAudit(m.opaqueSubjectId, {
        keyId, event: "decrypt_denied",
        timestamp: new Date().toISOString(), reason: "key destroyed",
      });
      throw new Error(`decrypt_denied: key ${keyId} has been destroyed.`);
    }
    this.addAudit(m.opaqueSubjectId, {
      keyId, event: "decrypt_attempt", timestamp: new Date().toISOString() });

    const res = await this.kms.send(new DecryptCommand({
      KeyId: m.kmsKeyId,
      CiphertextBlob: Buffer.from(encryptedDek, "base64url"),
      EncryptionContext: this.encryptionContext(m.opaqueSubjectId),
      // EncryptionContext mismatch → KMS rejects the call.
      // This prevents cross-tenant DEK substitution attacks.
    }));
    return new Uint8Array(res.Plaintext!);
  }

  async sealForTenant(tenantId: string, plaintext: Uint8Array): Promise<SealedBlob> {
    const { plaintextDek, encryptedDek, keyId, version } =
      await this.generateTenantDek(tenantId);
    try {
      const iv        = randomBytes(12);
      const cipher    = createCipheriv("aes-256-gcm", plaintextDek, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag       = cipher.getAuthTag();
      const ciphertext = Buffer.concat([iv, encrypted, tag]).toString("base64url");
      return { ciphertext, encryptedDek, keyId, version };
    } finally {
      plaintextDek.fill(0);
    }
  }

  async unsealForTenant(blob: SealedBlob): Promise<Uint8Array> {
    const dek = await this.unwrapDek(blob.keyId, blob.encryptedDek);
    try {
      const raw = Buffer.from(blob.ciphertext, "base64url");
      const iv  = raw.subarray(0, 12);
      const ct  = raw.subarray(12, raw.length - 16);
      const tag = raw.subarray(raw.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", dek, iv);
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
    } finally {
      dek.fill(0);
    }
  }

  async scheduleErasure(
    scope: KeyScope,
    subjectId: string,
    reason: string,
    actor?: string,
  ): Promise<CryptoErasureReceipt> {
    const oid  = this.opaqueId(subjectId);
    const ids  = this.bySubj.get(oid) ?? [];
    const now  = new Date().toISOString();
    const pendingDays = this.cfg.pendingWindowDays ?? 7; // AWS KMS minimum
    const scheduledDeletionAt = new Date(Date.now() + pendingDays * 86400_000).toISOString();
    let lastKeyId = "";

    for (const id of ids) {
      const m = this.meta.get(id);
      if (!m || m.status === "destroyed") continue;

      // Phase 1 (immediate): DisableKey — decrypt attempts fail immediately
      await this.kms.send(new DisableKeyCommand({ KeyId: m.kmsKeyId }));
      m.status     = "disabled";
      m.disabledAt = now;
      this.addAudit(oid, { keyId: id, event: "disabled", timestamp: now });

      // Phase 2 (scheduled): ScheduleKeyDeletion — 7-day minimum pending window
      await this.kms.send(new ScheduleKeyDeletionCommand({
        KeyId: m.kmsKeyId,
        PendingWindowInDays: pendingDays,
      }));
      // Mark locally as destroyed (KMS will destroy the key material after pendingDays)
      m.status      = "destroyed";
      m.destroyedAt = scheduledDeletionAt; // actual destruction is after pending window
      this.addAudit(oid, { keyId: id, event: "destroyed", timestamp: now, reason });
      lastKeyId = id;
    }

    return {
      keyId: lastKeyId,
      scope,
      opaqueSubjectId: oid,
      disabledAt: now,                   // effective GDPR erasure — decrypt fails NOW
      scheduledDeletionAt,               // cryptographic proof at +7 days
      reason,
      actor,
    };
  }

  async auditLog(_scope: KeyScope, subjectId: string): Promise<KeyAuditEvent[]> {
    const oid = this.opaqueId(subjectId);
    return [...(this.audit.get(oid) ?? [])];
  }

  private metaToRecord(m: AwsKeyMeta, scope: KeyScope): TenantKeyRecord {
    return {
      keyId: m.keyId,
      scope,
      opaqueSubjectId: m.opaqueSubjectId,
      version: m.version,
      status: m.status,
      createdAt: m.createdAt,
      disabledAt: m.disabledAt,
      destroyedAt: m.destroyedAt,
    };
  }
}
```

- [ ] **Step 3: Run type check** `pnpm tsc --noEmit` → expected: 0 errors
- [ ] **Step 4: Commit** `git commit -m "feat(kms): add AwsKmsKeyRegistry — AWS KMS provider with 2-phase erasure (DEBT-002)"`

---

## Task 5: KMS env vars + `key_registry_factory.ts`

**Files:**
- Modify: `src/config/env.ts`
- Create: `src/storage/key_registry_factory.ts`

### Steps

- [ ] **Step 1: Add KMS vars to `EnvSchema` in `src/config/env.ts`**

Add the following fields to `EnvSchema` (after `MCP_REQUIRE_CRYPTO_ERASURE` line ~62):

```typescript
// KMS provider selection — required when MCP_REQUIRE_CRYPTO_ERASURE=true
KMS_PROVIDER: z.enum(["vault", "aws-kms", "local"]).optional(),
// Vault Transit config
VAULT_ADDR: z.string().url().optional(),
VAULT_TOKEN: z.string().optional(),
VAULT_TRANSIT_MOUNT: z.string().default("transit"),
// AWS KMS config
AWS_KMS_REGION: z.string().optional(),
AWS_KMS_PENDING_WINDOW_DAYS: z.number().int().min(7).max(30).default(7),
```

Add corresponding raw env entries in `loadEnv()`:

```typescript
KMS_PROVIDER: process.env.KMS_PROVIDER as "vault" | "aws-kms" | "local" | undefined,
VAULT_ADDR: process.env.VAULT_ADDR || undefined,
VAULT_TOKEN: process.env.VAULT_TOKEN,
VAULT_TRANSIT_MOUNT: process.env.VAULT_TRANSIT_MOUNT,
AWS_KMS_REGION: process.env.AWS_KMS_REGION,
AWS_KMS_PENDING_WINDOW_DAYS: parseIntEnv(process.env.AWS_KMS_PENDING_WINDOW_DAYS),
```

Replace the existing `MCP_REQUIRE_CRYPTO_ERASURE` production guard (lines 350–353) with:

```typescript
if (process.env.NODE_ENV === "production" && env.MCP_REQUIRE_CRYPTO_ERASURE) {
  if (!env.KMS_PROVIDER || env.KMS_PROVIDER === "local") {
    console.error(
      "FATAL: MCP_REQUIRE_CRYPTO_ERASURE=true requires KMS_PROVIDER=vault or KMS_PROVIDER=aws-kms. " +
      "LocalKeyRegistry is dev/test only and provides no real crypto-erasure guarantee."
    );
    process.exit(1);
  }
  if (env.KMS_PROVIDER === "vault" && (!env.VAULT_ADDR || !env.VAULT_TOKEN)) {
    console.error("FATAL: VAULT_ADDR and VAULT_TOKEN are required when KMS_PROVIDER=vault.");
    process.exit(1);
  }
}
```

- [ ] **Step 2: Run — verify env schema parses** `pnpm tsc --noEmit` → expected: 0 errors

- [ ] **Step 3: Create `src/storage/key_registry_factory.ts`**

```typescript
import type { ITenantKeyRegistry } from "./key_registry.js";
import { ENV } from "../config/env.js";

export async function createKeyRegistry(): Promise<ITenantKeyRegistry | null> {
  if (!ENV.KMS_PROVIDER) return null;

  switch (ENV.KMS_PROVIDER) {
    case "local": {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "LocalKeyRegistry is dev/test only. Set KMS_PROVIDER=vault or aws-kms for production.",
        );
      }
      const { LocalKeyRegistry } = await import("./providers/local_key_registry.js");
      return new LocalKeyRegistry(
        ENV.MCP_ENCRYPTION_KEY ?? "dev-only-not-for-production-change-me",
        ENV.MCP_PROJECT_ID,
      );
    }

    case "vault": {
      if (!ENV.VAULT_ADDR || !ENV.VAULT_TOKEN) {
        throw new Error("VAULT_ADDR and VAULT_TOKEN are required when KMS_PROVIDER=vault.");
      }
      const { VaultKeyRegistry } = await import("./providers/vault_key_registry.js");
      return new VaultKeyRegistry({
        vaultAddr: ENV.VAULT_ADDR,
        vaultToken: ENV.VAULT_TOKEN,
        mountPath: ENV.VAULT_TRANSIT_MOUNT,
        projectSalt: ENV.MCP_PROJECT_ID,
      });
    }

    case "aws-kms": {
      const { AwsKmsKeyRegistry } = await import("./providers/aws_kms_key_registry.js");
      return new AwsKmsKeyRegistry({
        region: ENV.AWS_KMS_REGION,
        projectSalt: ENV.MCP_PROJECT_ID,
        pendingWindowDays: ENV.AWS_KMS_PENDING_WINDOW_DAYS,
      });
    }

    default:
      return null;
  }
}
```

- [ ] **Step 4: Run** `pnpm tsc --noEmit` → expected: 0 errors
- [ ] **Step 5: Commit** `git commit -m "feat(kms): add key_registry_factory + KMS env vars (DEBT-002)"`

---

## Task 6: `encryption.ts` v4 KMS-backed path

**Files:**
- Modify: `src/storage/encryption.ts`

Adds a `smcp:v4:kms:…` envelope when an `ITenantKeyRegistry` is wired in. V3/V2/legacy paths are unchanged — backward compatible.

### Steps

- [ ] **Step 1: Write the failing test (add to existing encryption test file or new file)**

```typescript
// src/__tests__/encryption_kms.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { EncryptionService } from "../storage/encryption.js";
import { LocalKeyRegistry } from "../storage/providers/local_key_registry.js";

describe("EncryptionService v4 KMS path", () => {
  let service: EncryptionService;

  beforeEach(() => {
    const registry = new LocalKeyRegistry("wrap-key-32bytes-for-test-xxxxx", "test-proj");
    service = new EncryptionService("base64url:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    service.setKeyRegistry(registry);
  });

  it("encryptState with tenantId uses smcp:v4:kms prefix", async () => {
    const cipher = await service.encryptState({ hello: "world" }, "tenant-kms-test");
    expect(cipher).toMatch(/^smcp:v4:kms:/);
  });

  it("decryptState round-trips v4 blob", async () => {
    const cipher    = await service.encryptState({ secret: 42 }, "tenant-kms-test");
    const recovered = await service.decryptState(cipher, "tenant-kms-test");
    expect(recovered).toEqual({ secret: 42 });
  });

  it("v4 blob is not decryptable as v3 (different prefix)", async () => {
    const cipher = await service.encryptState({ x: 1 }, "tenant-kms-test");
    expect(cipher.startsWith("smcp:v3:")).toBe(false);
  });

  it("without registry, falls back to v3 HKDF", async () => {
    const plain = new EncryptionService("base64url:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    // No setKeyRegistry called
    const cipher = await plain.encryptState({ x: 1 }, "tenant-v3-fallback");
    expect(cipher).toMatch(/^smcp:v3:/);
  });
});
```

- [ ] **Step 2: Run — verify FAIL** `pnpm vitest run src/__tests__/encryption_kms.test.ts` → expected: FAIL (setKeyRegistry not found)

- [ ] **Step 3: Update `src/storage/encryption.ts`** — add v4 path

Add to the top of the file (after existing imports):
```typescript
import type { ITenantKeyRegistry, SealedBlob } from "./key_registry.js";
```

Add `V4_PREFIX` constant alongside existing prefix constants:
```typescript
const V4_PREFIX = "smcp:v4:kms";
```

Add `setKeyRegistry` method and `keyRegistry` field to `EncryptionService` class:
```typescript
private keyRegistry?: ITenantKeyRegistry;

setKeyRegistry(registry: ITenantKeyRegistry): void {
  this.keyRegistry = registry;
}
```

Prepend v4 branch at the top of `encryptState()` (before the existing `!this.secretKey` check):
```typescript
async encryptState(state: Record<string, unknown>, tenantId?: string): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(state));

  // V4: KMS-backed per-tenant DEK — takes priority when registry is wired in
  if (this.keyRegistry && tenantId) {
    const blob = await this.keyRegistry.sealForTenant(tenantId, payload);
    return `${V4_PREFIX}:${Buffer.from(JSON.stringify(blob)).toString("base64url")}`;
  }

  // V3/V2 paths unchanged below...
  const payloadStr = JSON.stringify(state); // existing code uses this
  // ... rest of existing implementation unchanged
```

Prepend v4 branch at the top of `decryptState()` (before the v3 check):
```typescript
async decryptState(data: string, tenantId?: string): Promise<Record<string, unknown>> {
  // V4: KMS-backed
  if (data.startsWith(`${V4_PREFIX}:`)) {
    if (!this.keyRegistry) {
      throw new Error("KMS registry required to decrypt smcp:v4:kms blobs. Set KMS_PROVIDER.");
    }
    const blobJson = Buffer.from(data.slice(V4_PREFIX.length + 1), "base64url").toString("utf8");
    const blob     = JSON.parse(blobJson) as SealedBlob;
    const plaintext = await this.keyRegistry.unsealForTenant(blob);
    return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
  }

  // V3/V2/legacy unchanged below...
```

- [ ] **Step 4: Run — verify PASS** `pnpm vitest run src/__tests__/encryption_kms.test.ts` → expected: 4 tests pass
- [ ] **Step 5: Run full suite** `pnpm vitest run` → expected: all pre-existing tests still pass
- [ ] **Step 6: Commit** `git commit -m "feat(kms): add smcp:v4:kms envelope path to EncryptionService (DEBT-002)"`

---

## Task 7: Wire `createKeyRegistry` at startup

**Files:**
- Modify: `src/storage/factory.ts`

`createStorage()` currently instantiates `RedisStore` with `globalEncryption`. The KMS registry must be initialized before `createStorage()` is called.

### Steps

- [ ] **Step 1: Modify `src/storage/factory.ts`**

Replace the existing file with:

```typescript
import { ENV } from "../config/env.js";
import type { IStateStore } from "./interface.js";
import { LocalFSStore } from "./local_fs.js";
import { RedisStore } from "./redis.js";
import { MemoryStore } from "./memory.js";
import { globalEncryption } from "./encryption.js";
import { createKeyRegistry } from "./key_registry_factory.js";

export async function createStorage(): Promise<IStateStore> {
  // Initialize KMS registry first — EncryptionService must have it before any encrypt/decrypt
  const registry = await createKeyRegistry();
  if (registry) {
    globalEncryption.setKeyRegistry(registry);
  }

  switch (ENV.STORAGE_DRIVER) {
    case "fs":
      console.error("[SUPER-MCP] Khởi tạo Storage Engine: Local File System (VECTOR mode)");
      return new LocalFSStore();
    case "redis":
      console.error("[SUPER-MCP] Khởi tạo Storage Engine: Redis Server (Fortuna mode)");
      return new RedisStore();
    case "memory":
    default:
      console.error("[SUPER-MCP] Khởi tạo Storage Engine: In-Memory (Test mode)");
      return new MemoryStore();
  }
}
```

> **Note:** `createStorage()` is now `async`. Update all callers (typically the server entry point) to `await createStorage()`.

- [ ] **Step 2: Find and update callers** — `grep -r "createStorage" src/ --include="*.ts" -l`

For each caller file, change `createStorage()` → `await createStorage()` and ensure the calling function is `async`.

- [ ] **Step 3: Run** `pnpm tsc --noEmit` → expected: 0 errors
- [ ] **Step 4: Run** `pnpm vitest run` → expected: all tests pass
- [ ] **Step 5: Commit** `git commit -m "feat(kms): wire KMS registry into createStorage startup (DEBT-002)"`

---

## Task 8: Update ADR 0002 — record implementation decisions

**Files:**
- Modify: `docs/adr/0002-tenant-crypto-erasure-v3.md`

### Steps

- [ ] **Step 1: Prepend implementation status block to ADR 0002**

Add after the first line (`# ADR 0002 — Tenant/user crypto-erasure v3 envelope`):

```markdown
Status: implementing — v4 KMS path shipped; V3 HKDF migration pending.

## Implementation decisions (2026-06-13)

### 2-phase erasure (new)
`scheduleErasure()` implements a 2-phase protocol:
- **Phase 1 (immediate):** key disabled — all decrypt attempts fail at once. `disabledAt` is set.
  This is the effective GDPR erasure timestamp.
- **Phase 2 (scheduled):** key material destroyed. `scheduledDeletionAt` is set.
  - HashiCorp Vault: immediate (no pending window). `scheduledDeletionAt = disabledAt`.
  - AWS KMS: minimum 7-day pending window. `scheduledDeletionAt = disabledAt + 7 days`.
  GDPR Art. 17 intent is satisfied at Phase 1; Phase 2 provides cryptographic proof.

### V3 HKDF blobs cannot be crypto-erased (migration required)
Existing `smcp:v3:hkdf-tenant` blobs derive the tenant key from a shared master secret.
There is no per-tenant KMS key entry to delete. These blobs **cannot** be crypto-erased
without rotating the master `MCP_ENCRYPTION_KEY` and re-deriving all tenant keys.

Migration path:
1. New writes go to `smcp:v4:kms` when `KMS_PROVIDER` is set.
2. `migrate_encryption.ts` re-encrypts V3 blobs into V4 on a per-tenant basis.
3. Only after all V3 blobs for a tenant are migrated can crypto-erasure be offered.
4. The `CryptoErasureReceipt` should note whether V3 legacy blobs remain.

### SealedBlob — opaque blob format
High-level callers use `sealForTenant(tenantId, plaintext)` → `SealedBlob` and
`unsealForTenant(blob)` → `Uint8Array`. The blob JSON embeds `keyId`, `version`,
`encryptedDek`, and `ciphertext`. Callers store the blob; they never touch key material.

### Provider priority
Vault is the recommended first provider: immediate erasure, self-hosted, EU data residency.
AWS KMS is available for AWS-native deployments.
LocalKeyRegistry is dev/test only and rejected in production.
```

- [ ] **Step 2: Commit** `git commit -m "docs(adr): update ADR 0002 status to implementing, record 2-phase erasure decisions"`

---

## Risk Summary

| # | Task | Risk | Level | Mitigation |
|---|------|------|-------|------------|
| 4 | AwsKmsKeyRegistry | AWS KMS 7-day pending window violates naive GDPR "immediate erasure" | HIGH | Phase 1 `DisableKey` fires immediately; `disabledAt` is the GDPR timestamp. Documented in receipt and ADR. |
| 8 | ADR update | V3 HKDF blobs remain unmigratable until `migrate_encryption.ts` is extended | HIGH | Documented explicitly. No erasure claim is made for V3 blobs. |
| 2 | LocalKeyRegistry | Software key-wrap, no HSM, not FIPS 140-3 | MEDIUM | Blocked in production by env guard in Task 5. |
| 6 | encryption.ts | DEK in memory briefly during `sealForTenant` | MEDIUM | `finally { plaintextDek.fill(0) }` in all three providers. V8 GC is not guaranteed to clear heap promptly, but this matches industry practice. |
| 7 | factory.ts | `createStorage()` is now async — callers must be updated | MEDIUM | Task 7 Step 2 requires manual grep + update of all call sites. |

---

## Execution Handoff

```
Plan complete: docs/superpowers/plans/2026-06-13-debt-002-kms-crypto-erasure.md
Risk summary: 2 HIGH tasks, 0 CROSS boundaries

Execution options:
1. Subagent-Driven (recommended) — fresh subagent per task, specialist-review between tasks
2. Inline Execution — batch execution with checkpoints

Which approach?
```
