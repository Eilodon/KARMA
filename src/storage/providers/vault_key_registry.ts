import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type {
  CryptoErasureReceipt,
  ITenantKeyRegistry,
  KeyAuditEvent,
  KeyScope,
  SealedBlob,
  TenantKeyRecord,
} from "../key_registry.js";

export interface VaultConfig {
  vaultAddr: string;    // e.g. "https://vault.example.com:8200"
  vaultToken: string;   // Vault token with transit/* policy
  mountPath: string;    // default "transit"
  projectSalt: string;  // used to derive opaque IDs — set to MCP_PROJECT_ID
}

interface VaultKeyMeta {
  keyId: string;
  keyName: string;          // Vault key name: "tenant-{opaqueId}"
  opaqueSubjectId: string;
  version: number;
  status: "active" | "disabled" | "destroyed";
  createdAt: string;
  disabledAt?: string;
  destroyedAt?: string;
}

export class VaultKeyRegistry implements ITenantKeyRegistry {
  private readonly cfg: VaultConfig;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly meta    = new Map<string, VaultKeyMeta>();
  private readonly bySubj  = new Map<string, string[]>(); // opaqueId → keyId[]
  private readonly audit   = new Map<string, KeyAuditEvent[]>();

  constructor(cfg: VaultConfig, fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.cfg       = cfg;
    this.fetchImpl = fetchImpl;
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
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err: unknown = await res.json().catch(() => ({}));
      throw new Error(`Vault POST ${path} failed (${res.status}): ${JSON.stringify(err)}`);
    }
    return res.json() as Promise<T>;
  }

  private async vaultDelete(path: string): Promise<void> {
    const res = await this.fetchImpl(this.url(path), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404 && res.status !== 204) {
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

  private metaToRecord(m: VaultKeyMeta, scope: KeyScope): TenantKeyRecord {
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

    const keyName = this.vaultKeyName(oid);
    await this.vaultPost(`keys/${keyName}`, { type: "aes256-gcm96" }).catch(() => {});

    const version = 1;
    const keyId   = this.makeKeyId(oid, version);
    const now     = new Date().toISOString();
    const m: VaultKeyMeta = { keyId, keyName, opaqueSubjectId: oid, version, status: "active", createdAt: now };
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
    const now     = new Date().toISOString();
    const keyName = prev?.keyName ?? this.vaultKeyName(oid);

    await this.vaultPost(`keys/${keyName}/rotate`);

    const m: VaultKeyMeta = { keyId, keyName, opaqueSubjectId: oid, version, status: "active", createdAt: now };
    this.meta.set(keyId, m);
    this.bySubj.set(oid, [...ids, keyId]);
    this.addAudit(oid, { keyId, event: "rotated", timestamp: now });
    return this.metaToRecord(m, scope);
  }

  async disableKey(keyId: string): Promise<void> {
    const m = this.meta.get(keyId);
    if (!m) throw new Error(`Key not found: ${keyId}`);
    const now = new Date().toISOString();
    m.status = "disabled";
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
    return {
      plaintextDek: new Uint8Array(Buffer.from(res.data.plaintext, "base64")),
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
    this.addAudit(m.opaqueSubjectId, { keyId, event: "decrypt_attempt", timestamp: new Date().toISOString() });

    const res = await this.vaultPost<{ data: { plaintext: string } }>(
      `decrypt/${m.keyName}`,
      { ciphertext: encryptedDek },
    );
    return new Uint8Array(Buffer.from(res.data.plaintext, "base64"));
  }

  async sealForTenant(tenantId: string, plaintext: Uint8Array): Promise<SealedBlob> {
    const { plaintextDek, encryptedDek, keyId, version } = await this.generateTenantDek(tenantId);
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
    const ids  = this.bySubj.get(oid) ?? [];
    const now  = new Date().toISOString();
    let lastKeyId = "";

    for (const id of ids) {
      const m = this.meta.get(id);
      if (!m || m.status === "destroyed") continue;

      // Phase 1: arm deletion + disable in local metadata
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
      keyId: lastKeyId, scope, opaqueSubjectId: oid,
      disabledAt: now,
      scheduledDeletionAt: now, // Vault: immediate deletion, no pending window
      destroyedAt: now,
      reason, actor,
    };
  }

  async auditLog(_scope: KeyScope, subjectId: string): Promise<KeyAuditEvent[]> {
    const oid = this.opaqueId(subjectId);
    return [...(this.audit.get(oid) ?? [])];
  }
}
