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
  // Phase 2: HSM/KMS scheduled deletion (Vault: same as disabledAt; AWS KMS: +7 days minimum)
  scheduledDeletionAt: string;
  // Set when key material is permanently destroyed (may lag scheduledDeletionAt on AWS KMS)
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

// Opaque sealed container — produced by sealForTenant, consumed by unsealForTenant.
// Callers store this as-is; they never inspect ciphertext or encryptedDek directly.
export interface SealedBlob {
  ciphertext: string;   // base64url: AES-256-GCM(DEK, plaintext)
  encryptedDek: string; // base64url: KMS-wrapped DEK
  keyId: string;        // opaque kid — no raw tenantId; resolves to key record
  version: number;      // key version at seal time
}

export interface ITenantKeyRegistry {
  // ── Low-level DEK operations ─────────────────────────────────────────────────
  // Use only inside EncryptionService.
  // CALLER MUST zero-out plaintextDek: try { ... } finally { plaintextDek.fill(0) }
  generateTenantDek(tenantId: string): Promise<{
    plaintextDek: Uint8Array;
    encryptedDek: string;
    keyId: string;
    version: number;
  }>;
  // CALLER MUST zero-out the returned Uint8Array in a finally block.
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
  //   Phase 1 (immediate)  — key disabled, all decrypt attempts fail at once
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
