# ADR 0002 — Tenant/user crypto-erasure v3 envelope

Status: implementing — v4 KMS path shipped (2026-06-14); V3 HKDF migration pending.

## Implementation decisions (2026-06-14)

### 2-phase erasure
`scheduleErasure()` implements a mandatory 2-phase protocol to satisfy GDPR Art. 17
("erasure without undue delay") across all KMS providers:

- **Phase 1 (immediate):** key disabled — all decrypt attempts fail at once.
  `CryptoErasureReceipt.disabledAt` is the GDPR-effective erasure timestamp.
- **Phase 2 (scheduled):** key material permanently destroyed.
  `CryptoErasureReceipt.scheduledDeletionAt` is set per provider:
  - HashiCorp Vault: `scheduledDeletionAt = disabledAt` (immediate permanent deletion, no pending window).
  - AWS KMS: `scheduledDeletionAt = disabledAt + 7 days` (mandatory KMS pending window).

### V3 HKDF blobs cannot be crypto-erased (migration required)
Existing `smcp:v3:hkdf-tenant` blobs derive the tenant key from the shared `MCP_ENCRYPTION_KEY`.
There is no per-tenant KMS entry to delete. These blobs **cannot be crypto-erased** without
rotating the master secret and re-deriving all tenant keys.

Migration path (tracked separately):
1. New writes use `smcp:v4:kms` when `KMS_PROVIDER` is set.
2. `migrate_encryption.ts` re-encrypts V3 blobs → V4 per tenant.
3. Crypto-erasure can only be offered after all V3 blobs for a tenant are migrated.
4. `CryptoErasureReceipt` must note whether V3 legacy blobs remain unmitigated.

### smcp:v4:kms envelope format
```
smcp:v4:kms:<base64url(JSON SealedBlob)>
```
`SealedBlob = { ciphertext, encryptedDek, keyId, version }` — see `key_registry.ts`.
High-level callers use `sealForTenant` / `unsealForTenant`; plaintext DEK never escapes the registry.

### Provider priority
Vault is the recommended first provider: immediate erasure, self-hosted, EU data residency.
AWS KMS is available for AWS-native deployments.
`LocalKeyRegistry` is dev/test only; blocked from production by env guard.

### New env vars
`KMS_PROVIDER`, `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_TRANSIT_MOUNT`,
`AWS_KMS_REGION`, `AWS_KMS_PENDING_WINDOW_DAYS` — see `src/config/env.ts`.

---

## Context and current limitation

The current storage encryption format is `smcp:v2:scrypt`. It derives encryption material from a global `MCP_ENCRYPTION_KEY`, stores per-blob salt, and optionally accepts a raw base64url A256GCM key. This is adequate for at-rest confidentiality but it cannot support audited tenant/user crypto-erasure because there is no `kid`, no tenant/user scoped DEK, and no key destroy semantics.

This ADR deliberately does not add a production runtime path. It defines the contract that a future implementation must satisfy before DEBT-002 can be closed.

## Decision

Introduce a future v3 envelope shape:

```txt
smcp:v3:jwe:<compact-jwe>
```

The compact JWE protected header must include opaque key metadata:

```json
{
  "alg": "A256KW",
  "enc": "A256GCM",
  "kid": "tk_01HYEXAMPLE:v7",
  "smcp_scope": "tenant",
  "smcp_key_version": 7
}
```

Rules:

- `kid` must be opaque and must not contain raw `tenantId`, `userId`, email, or other direct subject identifiers.
- The mapping from tenant/user subject to key record lives only in the key registry.
- Tenant/user scoped DEKs are wrapped by a KEK; KEK location and provider are deployment-specific.
- Rotation creates a new active version and must not make old blobs undecryptable while old keys remain active or disabled.
- Disabled keys deny new encryption but may still decrypt old blobs unless policy says otherwise.
- Destroyed keys deny decrypt and make old ciphertext undecryptable by design.
- Destroy operations must emit an audit receipt; a receipt must not imply all backups have been physically deleted unless backup erasure has also completed.

## Type-only contract

The repository exposes only a type-only contract in `src/storage/key_registry.ts`:

- `KeyStatus = active | disabled | destroyed`
- `KeyScope = tenant | user`
- `TenantKeyRecord`
- `CryptoErasureReceipt`
- `KeyAuditEvent`
- `ITenantKeyRegistry`

No `MemoryKeyRegistry`, fake KMS adapter, or production registry is exported by this ADR.

## Migration surfaces

A future v3 implementation must inventory and migrate or explicitly exclude these surfaces:

- Redis current task state.
- Redis backups.
- `local_fs` task state if used by a deployment.
- `local_fs` backups.
- Credential vault encrypted blobs.
- Idempotency cache/result cache if it contains encrypted state.
- Task result payloads if future versions encrypt them.
- Operator backup/export files.

## Migration plan

1. Add a concrete registry backed by a real KMS or deployment-approved key store.
2. Add v3 encryption behind an opt-in feature flag.
3. Write dual-read support for v2 and v3 envelopes.
4. Re-encrypt eligible v2 blobs into v3 with opaque `kid` and key version metadata.
5. Validate backup/export handling before enabling destroy semantics.
6. Move new writes to v3 only after migration observability is in place.
7. Keep v2 decrypt available until the rollback window closes.

## Rollback plan

- Keep dual-read support during rollout.
- Do not destroy old DEKs or disable v2 decrypt during the rollout window.
- If v3 registry resolution fails, stop new v3 writes and continue reading existing v2 blobs.
- Roll back application binaries without deleting key records.
- Resume migration only after registry consistency and backup policy are verified.

## Disable and destroy semantics

Disable:

- key status becomes `disabled`;
- new encryption is denied for that key;
- decryption of existing ciphertext may continue for retention/migration, subject to policy;
- audit event: `disabled`.

Destroy:

- key status becomes `destroyed`;
- wrapped DEK is removed or cryptographically destroyed;
- all decrypt attempts must fail with `decrypt_denied`;
- a `CryptoErasureReceipt` is emitted with key id, scope, opaque subject id, timestamp, reason, and optional actor.

## Trigger condition

Implement this ADR only when a deployment has a concrete tenant/user erasure requirement and a real KEK/KMS provider. Do not ship placeholder erasure, fake audit receipts, or a fake KMS.

## Non-goals for this phase

- No v3 runtime encryption path.
- No Redis or local_fs migration.
- No fake audit receipt.
- No KMS mock exported as production code.
- No claim that DEBT-002 is closed.
