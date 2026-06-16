import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type {
  CryptoErasureReceipt,
  ITenantKeyRegistry,
  KeyAuditEvent,
  KeyScope,
  SealedBlob,
  TenantKeyRecord,
} from "../key_registry.js";

export interface GcpKmsConfig {
  project: string;              // GCP project ID
  location: string;             // e.g. "global" or "us-central1"
  keyRing: string;              // Cloud KMS key ring name
  projectSalt: string;          // MCP_PROJECT_ID — used for opaque IDs
  accessToken?: string;         // Static Bearer token; if unset, auto-fetched from GCP metadata server
  destroyScheduledHours?: number; // Pending deletion window in hours; GCP default is 24
}

interface GcpKeyMeta {
  keyId: string;           // tk_{opaqueId}:v{version}
  gcpKeyName: string;      // Full resource: projects/{p}/locations/{l}/keyRings/{r}/cryptoKeys/{id}
  opaqueSubjectId: string;
  version: number;
  status: "active" | "disabled" | "destroyed";
  createdAt: string;
  disabledAt?: string;
  destroyedAt?: string;
}

const GCP_KMS_BASE = "https://cloudkms.googleapis.com/v1";
const GCP_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/**
 * GCP Cloud KMS provider.
 *
 * Key differences from AWS KMS / Vault:
 *   - No native GenerateDataKey — DEK is generated locally and wrapped with `cryptoKeys:encrypt`.
 *   - Erasure: `cryptoKeyVersions:destroy` → DESTROY_SCHEDULED state (immediately unusable for
 *     crypto ops; permanently destroyed after `destroyScheduledHours`, default 24 h).
 *   - Authentication: static `accessToken` or auto-fetched from the GCP metadata server
 *     (works on Cloud Run, GKE, GCE).  Non-GCP deployments must supply GCP_KMS_ACCESS_TOKEN.
 *   - additionalAuthenticatedData binds the wrapped DEK to the tenant — cross-tenant DEK
 *     substitution fails GCP KMS decrypt.
 */
export class GcpKmsKeyRegistry implements ITenantKeyRegistry {
  private readonly cfg: GcpKmsConfig;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly meta    = new Map<string, GcpKeyMeta>();
  private readonly bySubj  = new Map<string, string[]>(); // opaqueId → keyId[]
  private readonly audit   = new Map<string, KeyAuditEvent[]>();
  private keyRingEnsured   = false;
  private cachedToken?: string;
  private tokenExpiresAt   = 0;

  constructor(cfg: GcpKmsConfig, fetchImpl?: typeof globalThis.fetch) {
    this.cfg       = cfg;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    if (this.cfg.accessToken) return this.cfg.accessToken;
    // Refresh at least 60s before expiry
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) return this.cachedToken;
    const res = await this.fetchImpl(GCP_METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
    });
    if (!res.ok) {
      throw new Error(
        `GCP metadata token fetch failed (${res.status}). ` +
        "Set GCP_KMS_ACCESS_TOKEN for non-GCP environments.",
      );
    }
    const { access_token, expires_in } =
      (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken    = access_token;
    this.tokenExpiresAt = Date.now() + expires_in * 1_000;
    return access_token;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private async gcpPost<T>(resourcePath: string, action: string, body: unknown): Promise<T> {
    const token = await this.getToken();
    const url   = `${GCP_KMS_BASE}/${resourcePath}:${action}`;
    const res   = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err: unknown = await res.json().catch(() => ({}));
      throw new Error(`GCP KMS ${resourcePath}:${action} failed (${res.status}): ${JSON.stringify(err)}`);
    }
    return res.json() as Promise<T>;
  }

  private async gcpCreateResource<T>(url: string, body: unknown): Promise<T> {
    const token = await this.getToken();
    const res   = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Ignore 409 Conflict — resource already exists
    if (!res.ok && res.status !== 409) {
      throw new Error(`GCP KMS create failed (${res.status})`);
    }
    return res.json() as Promise<T>;
  }

  private async gcpListVersions(gcpKeyName: string): Promise<Array<{ name: string; state: string }>> {
    const token = await this.getToken();
    const url   = `${GCP_KMS_BASE}/${gcpKeyName}/cryptoKeyVersions?filter=state%3DENABLED`;
    const res   = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GCP KMS list versions failed (${res.status})`);
    const body = (await res.json()) as { cryptoKeyVersions?: Array<{ name: string; state: string }> };
    return body.cryptoKeyVersions ?? [];
  }

  private async gcpCreateVersion(gcpKeyName: string): Promise<string> {
    const token = await this.getToken();
    const res   = await this.fetchImpl(`${GCP_KMS_BASE}/${gcpKeyName}/cryptoKeyVersions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`GCP KMS create version failed (${res.status})`);
    const { name } = (await res.json()) as { name: string };
    // name = "projects/.../cryptoKeyVersions/3" — extract the version number
    return name.split("/").pop()!;
  }

  // ── Key naming / opaque IDs ───────────────────────────────────────────────

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

  private oidFromKeyId(keyId: string): string {
    const m = keyId.match(/^tk_([^:]+):/);
    if (!m) throw new Error(`Invalid keyId format: ${keyId}`);
    return m[1];
  }

  private gcpKeyResourceName(oid: string): string {
    return (
      `projects/${this.cfg.project}/locations/${this.cfg.location}` +
      `/keyRings/${this.cfg.keyRing}/cryptoKeys/tenant-${oid}`
    );
  }

  // Tenant-binding AAD — cross-tenant DEK substitution fails GCP decrypt
  private aad(oid: string): string {
    return Buffer.from(`karma:tenant:${oid}`).toString("base64");
  }

  // ── Lazy resource setup ───────────────────────────────────────────────────

  private async ensureKeyRing(): Promise<void> {
    if (this.keyRingEnsured) return;
    const parent = `projects/${this.cfg.project}/locations/${this.cfg.location}`;
    const url    = `${GCP_KMS_BASE}/${parent}/keyRings?keyRingId=${this.cfg.keyRing}`;
    await this.gcpCreateResource(url, {});
    this.keyRingEnsured = true;
  }

  private async ensureCryptoKey(oid: string): Promise<string> {
    await this.ensureKeyRing();
    const parent   = `projects/${this.cfg.project}/locations/${this.cfg.location}/keyRings/${this.cfg.keyRing}`;
    const url      = `${GCP_KMS_BASE}/${parent}/cryptoKeys?cryptoKeyId=tenant-${oid}`;
    await this.gcpCreateResource(url, {
      purpose: "ENCRYPT_DECRYPT",
      versionTemplate: { algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION" },
    });
    return this.gcpKeyResourceName(oid);
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  private addAudit(oid: string, event: KeyAuditEvent): void {
    const log = this.audit.get(oid) ?? [];
    log.push(event);
    this.audit.set(oid, log);
  }

  private activeMetaForSubject(oid: string): GcpKeyMeta | undefined {
    const ids = this.bySubj.get(oid) ?? [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const m = this.meta.get(ids[i]);
      if (m?.status === "active") return m;
    }
    return undefined;
  }

  private metaToRecord(m: GcpKeyMeta, scope: KeyScope): TenantKeyRecord {
    return {
      keyId: m.keyId, scope,
      opaqueSubjectId: m.opaqueSubjectId,
      version: m.version, status: m.status,
      createdAt: m.createdAt, disabledAt: m.disabledAt, destroyedAt: m.destroyedAt,
    };
  }

  // ── ITenantKeyRegistry ─────────────────────────────────────────────────────

  async getOrCreateActiveKey(scope: KeyScope, subjectId: string): Promise<TenantKeyRecord> {
    const oid      = this.opaqueId(subjectId);
    const existing = this.activeMetaForSubject(oid);
    if (existing) return this.metaToRecord(existing, scope);

    const gcpKeyName = await this.ensureCryptoKey(oid);
    const version    = 1;
    const keyId      = this.makeKeyId(oid, version);
    const now        = new Date().toISOString();
    const m: GcpKeyMeta = {
      keyId, gcpKeyName, opaqueSubjectId: oid, version, status: "active", createdAt: now,
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
    const oid        = this.opaqueId(subjectId);
    const ids        = this.bySubj.get(oid) ?? [];
    const prev       = ids.length > 0 ? this.meta.get(ids[ids.length - 1]) : undefined;
    const version    = (prev?.version ?? 0) + 1;
    const keyId      = this.makeKeyId(oid, version);
    const now        = new Date().toISOString();
    const gcpKeyName = prev?.gcpKeyName ?? await this.ensureCryptoKey(oid);

    // Create a new CryptoKeyVersion and promote it to primary
    const gcpVersionId = await this.gcpCreateVersion(gcpKeyName);
    await this.gcpPost(gcpKeyName, "updatePrimaryVersion", { cryptoKeyVersionId: gcpVersionId });

    const m: GcpKeyMeta = {
      keyId, gcpKeyName, opaqueSubjectId: oid, version, status: "active", createdAt: now,
    };
    this.meta.set(keyId, m);
    this.bySubj.set(oid, [...ids, keyId]);
    this.addAudit(oid, { keyId, event: "rotated", timestamp: now });
    return this.metaToRecord(m, scope);
  }

  async disableKey(keyId: string): Promise<void> {
    // GCP has no "disable" that prevents decryption without destruction.
    // We mark it locally so generateTenantDek rejects it; full erasure goes via scheduleErasure.
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
    const oid = m.opaqueSubjectId;

    // GCP KMS has no GenerateDataKey equivalent — generate DEK locally and wrap it
    const dek = randomBytes(32);
    const res = await this.gcpPost<{ ciphertext: string }>(m.gcpKeyName, "encrypt", {
      plaintext: dek.toString("base64"),
      additionalAuthenticatedData: this.aad(oid),
    });
    return {
      plaintextDek: new Uint8Array(dek),
      encryptedDek: res.ciphertext, // GCP-format base64 ciphertext; opaque to callers
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
      keyId, event: "decrypt_attempt", timestamp: new Date().toISOString(),
    });

    const oid = this.oidFromKeyId(keyId);
    const res = await this.gcpPost<{ plaintext: string }>(m.gcpKeyName, "decrypt", {
      ciphertext: encryptedDek,
      additionalAuthenticatedData: this.aad(oid),
    });
    return new Uint8Array(Buffer.from(res.plaintext, "base64"));
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
    const oid         = this.opaqueId(subjectId);
    const ids         = this.bySubj.get(oid) ?? [];
    const now         = new Date().toISOString();
    const hours       = this.cfg.destroyScheduledHours ?? 24;
    const scheduledAt = new Date(Date.now() + hours * 3_600_000).toISOString();
    let lastKeyId = "";

    for (const id of ids) {
      const m = this.meta.get(id);
      if (!m || m.status === "destroyed") continue;

      // Phase 1 + Phase 2 combined: DESTROY_SCHEDULED makes key immediately unusable;
      // GCP permanently destroys it after destroyScheduledHours (default 24 h).
      const versions = await this.gcpListVersions(m.gcpKeyName);
      for (const v of versions) {
        // POST {version_name}:destroy — moves to DESTROY_SCHEDULED (decrypt denied immediately)
        await this.gcpPost(v.name, "destroy", {}).catch(() => {});
      }

      m.status     = "disabled";
      m.disabledAt = now;
      this.addAudit(oid, { keyId: id, event: "disabled",  timestamp: now });

      m.status      = "destroyed";
      m.destroyedAt = scheduledAt; // permanent destruction happens after the pending window
      this.addAudit(oid, { keyId: id, event: "destroyed", timestamp: now, reason });
      lastKeyId = id;
    }

    return {
      keyId: lastKeyId, scope, opaqueSubjectId: oid,
      disabledAt: now,           // DESTROY_SCHEDULED: immediately unusable for all crypto ops
      scheduledDeletionAt: scheduledAt, // GCP permanently destroys after destroyScheduledHours
      reason, actor,
    };
  }

  async auditLog(_scope: KeyScope, subjectId: string): Promise<KeyAuditEvent[]> {
    const oid = this.opaqueId(subjectId);
    return [...(this.audit.get(oid) ?? [])];
  }
}
