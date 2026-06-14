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
  rawDek: Uint8Array; // plaintext — zeroed on destroy
}

export class LocalKeyRegistry implements ITenantKeyRegistry {
  private readonly masterKey: Uint8Array;
  private readonly projectSalt: string;
  private readonly keys      = new Map<string, KeyEntry>();
  private readonly bySubject = new Map<string, string[]>(); // opaqueId → keyId[]
  private readonly auditMap  = new Map<string, KeyAuditEvent[]>();

  constructor(wrapKey: string, projectSalt: string) {
    this.projectSalt = projectSalt;
    this.masterKey   = new Uint8Array(
      hkdfSync(
        "sha256",
        Buffer.from(wrapKey),
        Buffer.alloc(0),
        Buffer.from("super-mcp:local-kms:wrap-key:v1"),
        32,
      ),
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private opaqueId(tenantId: string): string {
    return createHmac("sha256", this.projectSalt)
      .update(`tenant:${tenantId}`)
      .digest()
      .subarray(0, 12)
      .toString("base64url");
  }

  private makeKeyId(oid: string, version: number): string {
    return `tk_${oid}:v${version}`;
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

  private addAudit(oid: string, event: KeyAuditEvent): void {
    const log = this.auditMap.get(oid) ?? [];
    log.push(event);
    this.auditMap.set(oid, log);
  }

  private activeKeyForSubject(oid: string): KeyEntry | undefined {
    const ids = this.bySubject.get(oid) ?? [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const entry = this.keys.get(ids[i]);
      if (entry?.status === "active") return entry;
    }
    return undefined;
  }

  // ── ITenantKeyRegistry ─────────────────────────────────────────────────────

  async getOrCreateActiveKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord> {
    const oid      = this.opaqueId(subjectId);
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
    this.bySubject.set(oid, [...(this.bySubject.get(oid) ?? []), keyId]);
    this.addAudit(oid, { keyId, event: "created", timestamp: now });
    return { ...entry };
  }

  async resolveKey(keyId: string): Promise<TenantKeyRecord | null> {
    const entry = this.keys.get(keyId);
    return entry ? { ...entry } : null;
  }

  async rotateKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord> {
    const oid     = this.opaqueId(subjectId);
    const ids     = this.bySubject.get(oid) ?? [];
    const prev    = ids.length > 0 ? this.keys.get(ids[ids.length - 1]) : undefined;
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
    this.bySubject.set(oid, [...ids, keyId]);
    this.addAudit(oid, { keyId, event: "rotated", timestamp: now });
    return { ...entry };
  }

  async disableKey(keyId: string): Promise<void> {
    const entry = this.keys.get(keyId);
    if (!entry) throw new Error(`Key not found: ${keyId}`);
    const now       = new Date().toISOString();
    entry.status    = "disabled";
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
    return { plaintextDek: dek, encryptedDek: this.wrapDek(dek), keyId: record.keyId, version: record.version };
  }

  async unwrapDek(keyId: string, encryptedDek: string): Promise<Uint8Array> {
    const entry = this.keys.get(keyId);
    if (!entry) throw new Error(`Key not found: ${keyId}`);
    if (entry.status === "destroyed") {
      this.addAudit(entry.opaqueSubjectId, {
        keyId, event: "decrypt_denied",
        timestamp: new Date().toISOString(), reason: "key destroyed",
      });
      throw new Error(`decrypt_denied: key ${keyId} has been destroyed.`);
    }
    this.addAudit(entry.opaqueSubjectId, {
      keyId, event: "decrypt_attempt", timestamp: new Date().toISOString(),
    });
    return this.decodeDek(encryptedDek);
  }

  async sealForTenant(tenantId: string, plaintext: Uint8Array): Promise<SealedBlob> {
    const { plaintextDek, encryptedDek, keyId, version } =
      await this.generateTenantDek(tenantId);
    try {
      const iv         = randomBytes(12);
      const cipher     = createCipheriv("aes-256-gcm", plaintextDek, iv);
      const encrypted  = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag        = cipher.getAuthTag();
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
    const ids  = this.bySubject.get(oid) ?? [];
    const now  = new Date().toISOString();
    let lastKeyId = "";

    for (const id of ids) {
      const entry = this.keys.get(id);
      if (!entry || entry.status === "destroyed") continue;

      entry.status       = "destroyed";
      entry.disabledAt   = entry.disabledAt ?? now;
      entry.destroyedAt  = now;
      entry.wrappedDek   = undefined;
      entry.rawDek.fill(0);

      this.addAudit(oid, { keyId: id, event: "disabled",  timestamp: entry.disabledAt });
      this.addAudit(oid, { keyId: id, event: "destroyed", timestamp: now, reason });
      lastKeyId = id;
    }

    return {
      keyId: lastKeyId,
      scope,
      opaqueSubjectId: oid,
      disabledAt: now,
      scheduledDeletionAt: now, // LocalKeyRegistry: immediate — no HSM pending window
      destroyedAt: now,
      reason,
      actor,
    };
  }

  async auditLog(_scope: KeyScope, subjectId: string): Promise<KeyAuditEvent[]> {
    const oid = this.opaqueId(subjectId);
    return [...(this.auditMap.get(oid) ?? [])];
  }
}
