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

export interface AwsKmsConfig {
  region?: string;           // defaults to AWS_REGION env var
  projectSalt: string;       // MCP_PROJECT_ID — used to derive opaque IDs
  pendingWindowDays?: number; // 7–30; AWS KMS minimum is 7
}

interface AwsKeyMeta {
  keyId: string;              // our opaque kid
  kmsKeyId: string;           // AWS KMS KeyId (ARN)
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
  private readonly meta    = new Map<string, AwsKeyMeta>();
  private readonly bySubj  = new Map<string, string[]>();
  private readonly audit   = new Map<string, KeyAuditEvent[]>();

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

  // Binds the DEK to this tenant — cross-tenant substitution fails KMS DecryptCommand
  private encryptionContext(oid: string): Record<string, string> {
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

  private metaToRecord(m: AwsKeyMeta, scope: KeyScope): TenantKeyRecord {
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

    const createRes = await this.kms.send(new CreateKeyCommand({
      Description: `super-mcp:tenant:${oid}`,
      KeyUsage: "ENCRYPT_DECRYPT",
      KeySpec: "SYMMETRIC_DEFAULT",
      Tags: [{ TagKey: "super-mcp-project", TagValue: this.cfg.projectSalt }],
    }));
    const kmsKeyId = createRes.KeyMetadata!.KeyId!;

    await this.kms.send(new CreateAliasCommand({
      AliasName: `alias/super-mcp/${this.cfg.projectSalt.replace(/[^a-zA-Z0-9_-]/g, "_")}/${oid}`,
      TargetKeyId: kmsKeyId,
    })).catch(() => {}); // ignore if alias already exists

    const version = 1;
    const keyId   = this.makeKeyId(oid, version);
    const now     = new Date().toISOString();
    const m: AwsKeyMeta = { keyId, kmsKeyId, opaqueSubjectId: oid, version, status: "active", createdAt: now };
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
    // AWS KMS rotation = new CMK per version; old CMK stays active for decrypt of old blobs
    const oid     = this.opaqueId(subjectId);
    const ids     = this.bySubj.get(oid) ?? [];
    const prev    = ids.length > 0 ? this.meta.get(ids[ids.length - 1]) : undefined;
    const version = (prev?.version ?? 0) + 1;

    const createRes = await this.kms.send(new CreateKeyCommand({
      Description: `super-mcp:tenant:${oid}:v${version}`,
      KeyUsage: "ENCRYPT_DECRYPT",
      KeySpec: "SYMMETRIC_DEFAULT",
    }));
    const kmsKeyId = createRes.KeyMetadata!.KeyId!;
    const keyId    = this.makeKeyId(oid, version);
    const now      = new Date().toISOString();
    const m: AwsKeyMeta = { keyId, kmsKeyId, opaqueSubjectId: oid, version, status: "active", createdAt: now };
    this.meta.set(keyId, m);
    this.bySubj.set(oid, [...ids, keyId]);
    this.addAudit(oid, { keyId, event: "rotated", timestamp: now });
    return this.metaToRecord(m, scope);
  }

  async disableKey(keyId: string): Promise<void> {
    const m = this.meta.get(keyId);
    if (!m) throw new Error(`Key not found: ${keyId}`);
    await this.kms.send(new DisableKeyCommand({ KeyId: m.kmsKeyId }));
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
    this.addAudit(m.opaqueSubjectId, { keyId, event: "decrypt_attempt", timestamp: new Date().toISOString() });

    const res = await this.kms.send(new DecryptCommand({
      KeyId: m.kmsKeyId,
      CiphertextBlob: Buffer.from(encryptedDek, "base64url"),
      EncryptionContext: this.encryptionContext(m.opaqueSubjectId),
      // EncryptionContext mismatch → KMS rejects the request.
      // This prevents cross-tenant DEK substitution attacks.
    }));
    return new Uint8Array(res.Plaintext!);
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
    const oid          = this.opaqueId(subjectId);
    const ids          = this.bySubj.get(oid) ?? [];
    const now          = new Date().toISOString();
    const pendingDays  = this.cfg.pendingWindowDays ?? 7;
    const scheduledAt  = new Date(Date.now() + pendingDays * 86_400_000).toISOString();
    let lastKeyId = "";

    for (const id of ids) {
      const m = this.meta.get(id);
      if (!m || m.status === "destroyed") continue;

      // Phase 1 (immediate): DisableKey — decrypt fails right now
      await this.kms.send(new DisableKeyCommand({ KeyId: m.kmsKeyId }));
      m.status     = "disabled";
      m.disabledAt = now;
      this.addAudit(oid, { keyId: id, event: "disabled", timestamp: now });

      // Phase 2 (scheduled): ScheduleKeyDeletion — 7-day minimum pending window
      await this.kms.send(new ScheduleKeyDeletionCommand({
        KeyId: m.kmsKeyId,
        PendingWindowInDays: pendingDays,
      }));
      m.status      = "destroyed";
      m.destroyedAt = scheduledAt; // actual HSM destruction happens after pending window
      this.addAudit(oid, { keyId: id, event: "destroyed", timestamp: now, reason });
      lastKeyId = id;
    }

    return {
      keyId: lastKeyId, scope, opaqueSubjectId: oid,
      disabledAt: now,          // effective GDPR erasure — decrypt fails NOW
      scheduledDeletionAt: scheduledAt, // cryptographic proof at +7 days
      reason, actor,
    };
  }

  async auditLog(_scope: KeyScope, subjectId: string): Promise<KeyAuditEvent[]> {
    const oid = this.opaqueId(subjectId);
    return [...(this.audit.get(oid) ?? [])];
  }
}
