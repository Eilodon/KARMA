# ADR: DEBT-002 — KMS-backed per-tenant DEK envelope encryption with 2-phase crypto-erasure

## 1. Title
Replace hard-blocked `MCP_REQUIRE_CRYPTO_ERASURE` with a pluggable KMS registry, `smcp:v4:kms`
envelope format, and 2-phase per-tenant key destruction satisfying GDPR Art. 17.

## 2. Context
The `smcp:v3:hkdf-tenant` encryption path derives per-tenant keys from a shared master secret
(`MCP_ENCRYPTION_KEY`) using HKDF. This provides cross-tenant isolation but **cannot** support
crypto-erasure: there is no per-tenant KMS entry to delete — deleting the master secret would
invalidate all tenants simultaneously.

`env.ts` contained a production guard that hard-FATAL'd if `MCP_REQUIRE_CRYPTO_ERASURE=true`
was set, with the note "keep this as a release-blocking epic."

Constraints:
- Must remain backward-compatible with V3/V2/legacy blobs (existing tenants cannot be force-migrated)
- Must work across AWS, GCP, self-hosted, and local dev without code changes per deployment
- GDPR Art. 17 requires erasure "without undue delay" — AWS KMS 7-day pending window is a known gap
- `kid` in JWE must be opaque (ADR 0002 constraint — no raw tenantId in stored blobs)

## 3. Decision
Introduced a pluggable `ITenantKeyRegistry` interface with three implementations and wired it
into `EncryptionService` as a priority path over V3 HKDF:

**Interface extensions (`key_registry.ts`):**
- `SealedBlob` — opaque container; callers store this, never touch key material directly
- `CryptoErasureReceipt.disabledAt` + `scheduledDeletionAt` — 2-phase proof fields
- `sealForTenant` / `unsealForTenant` — high-level API with internal DEK zero-out
- `scheduleErasure` — replaces separate `disableKey`+`destroyKey` calls with atomic 2-phase flow

**Providers (`src/storage/providers/`):**
- `LocalKeyRegistry` — dev/test; AES-256-GCM software key-wrap; blocked from production by env guard
- `VaultKeyRegistry` — Vault Transit REST API; immediate erasure (no pending window); recommended first
- `AwsKmsKeyRegistry` — AWS KMS `GenerateDataKey`/`Decrypt`/`DisableKey`/`ScheduleKeyDeletion`;
  7-day minimum pending window mitigated by Phase 1 `DisableKey` (decrypt fails immediately)

**2-phase erasure protocol:**
- Phase 1 (immediate): key disabled → `CryptoErasureReceipt.disabledAt` = GDPR-effective erasure
- Phase 2 (scheduled): key material destroyed → `scheduledDeletionAt` varies by provider

**`EncryptionService` v4 path:**
- `smcp:v4:kms:<base64url(JSON SealedBlob)>` when `keyRegistry` is set and `tenantId` provided
- Falls through to V3 HKDF if no registry; V3/V2/legacy still decrypt unchanged (backward compat)
- `setKeyRegistry(registry)` method for post-construction injection

**Startup wiring:**
- `createStorage()` made async; `createKeyRegistry()` called first → `globalEncryption.setKeyRegistry()`
- `SuperMcpRuntime.storage` moved from field initializer to `initialize()` (first await)

**Env vars added:** `KMS_PROVIDER`, `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_TRANSIT_MOUNT`,
`AWS_KMS_REGION`, `AWS_KMS_PENDING_WINDOW_DAYS`

**Production guard updated:** `MCP_REQUIRE_CRYPTO_ERASURE=true` now requires
`KMS_PROVIDER=vault|aws-kms`; `local` and unset are rejected with FATAL.

## 4. Status
ACCEPTED — COMPLETE (2026-06-14, cycle 2)

## 5. Consequences

**Improved:**
- GDPR right-to-erasure now implementable: `scheduleErasure()` destroys the KEK, making all
  tenant ciphertext mathematically unreadable
- Pluggable interface supports AWS, GCP (future), Vault, BYOK extension point
- V4 is fully backward-compatible with V3/V2 blobs — no forced migration
- Vault provider gives immediate erasure with no pending window

**Worsened:**
- `createStorage()` is now `async` — all callers must `await`
- Each V4 encrypt/decrypt incurs a KMS API round-trip (~30–50ms P99 for AWS KMS)
  DEK caching is deferred (DEBT-002 sub-item)
- AWS KMS costs $1/month per tenant KEK

**Debt created (Cycle 1, now resolved in Cycle 2):**
- ~~V3 HKDF blobs remain non-erasable~~ — `migrate_encryption.ts` extended; supports all formats.
- ~~`GcpKmsKeyRegistry` not yet implemented~~ — implemented with fetch-based REST API.
- ~~No DEK caching~~ — `CachingKeyRegistry` decorator with bounded TTL+use-count cache.
- ~~`CryptoErasureReceipt` lost on restart~~ — `FileAuditStore` (JSONL append) persists receipts.

**Remaining:**
- One migration run of `migrate_encryption.ts` required per tenant before erasure SLA can be offered.
- `AwsKmsKeyRegistry` unit tests require live AWS KMS or LocalStack mock.

## 6. Alternatives Considered

**A. Rotate `MCP_ENCRYPTION_KEY` on erasure request:**
Rejected — rotating the master key invalidates ALL tenants simultaneously. Impossible in
multi-tenant deployments.

**B. Google Tink library (TypeScript):**
Rejected — the TypeScript port is not production-ready as of June 2026. Manual implementation
using `node:crypto` + `@aws-sdk/client-kms` is more stable and auditable.

**C. Single CMK per deployment (not per tenant):**
Rejected — erasing one tenant's key destroys all tenants' data. Does not satisfy Art. 17.

**D. Field-level encryption only in Redis (no KMS):**
Rejected — without per-tenant key destruction, field-level encryption provides confidentiality
but not erasure. KMS is required for the erasure guarantee.

## 7. Evidence

Test results [verified 2026-06-14]:
```
Test Files  31 passed (36 total — 5 pre-existing failures unrelated to this work)
Tests       231 passed (241 total — 10 pre-existing failures)
```

New test coverage:
- `local_key_registry.test.ts` — 8 tests: DEK generation, wrap/unwrap round-trip, seal/unseal,
  cross-tenant isolation (tampered keyId throws), 2-phase erasure → decrypt denied, rotation
  (old blobs still readable), rotation version increment, two-tenant opaque ID separation
- `vault_key_registry.test.ts` — 6 tests: DEK generation, seal/unseal, unwrap calls `/decrypt/`,
  scheduleErasure calls `/config` + `DELETE`, post-erasure denial, rotation calls `/rotate`
- `encryption_kms.test.ts` — 6 tests: v4 prefix, round-trip, blob structure validation,
  no v3/v2 prefix, v3 fallback without registry, backward-compat decrypt of v3 blobs

All V3/V2/legacy encryption tests (`encryption_negative.test.ts`) continue passing. [verified 2026-06-14]

## 8. Owner
@ybao / SUPER-MCP team

## 8b. Known Debts (PATTERN-DEBT)
PATTERN-DEBT entries introduced or affected by this change:

- DEBT-002: IMPLEMENTED — all 4 cycle-2 items shipped (2026-06-14):
  (1) `migrate_encryption.ts` V3→V4+V2→V4 migration support.
  (2) `CachingKeyRegistry` bounded DEK cache (TTL + use-count, zero-on-evict).
  (3) `GcpKmsKeyRegistry` with fetch-based REST API, AAD binding, 24h erasure window.
  (4) `FileAuditStore` (JSONL) + `CachingKeyRegistry` integration for durable receipts.
  Erasure SLA requires one `migrate_encryption.ts` run per tenant before offering.

## 9. Next Cycle Trigger
When the first production deployment sets `KMS_PROVIDER=vault` or `KMS_PROVIDER=aws-kms`,
OR when any tenant submits a GDPR Art. 17 erasure request and `migrate_encryption.ts`
has not yet re-encrypted their V3 blobs.

Measurable condition: `grep -r "smcp:v3:hkdf-tenant" <redis-dump>` returns results for
a tenant with a pending erasure request.

## 10. Cycle Retrospective

- **AWS KMS 7-day pending window was not in the original DEBT-002 proposal** — discovered
  during June 2026 research. The 2-phase disable+schedule model was added specifically because
  of this; without it, GDPR "undue delay" would be violated for AWS deployments.
- **Vault Transit `datakey/plaintext` returns standard base64, not base64url** — `Buffer.from(x, "base64")`
  is required, not `"base64url"`. Easy to miss; caught during test writing.
- **VaultKeyRegistry test initially used hardcoded key names** (e.g. `tenant-test-alpha`) that
  would never match HMAC-derived opaque IDs. Fixed to URL-pattern-based fetch mock before
  implementation began. The plan's test code had this bug; execution review caught it.
- **`createStorage()` sync field initializer** in `runtime.ts` would have silently dropped
  the KMS registry if `createStorage()` had been made async without updating the call site.
  Detected during review — moved to `initialize()`.
- **V3 blobs and V4 blobs are separate erasure domains** — the original proposal implied they
  were additive, but V3 blobs remain non-erasable regardless of KMS setup. Addressed in Cycle 2.

## 11. Cycle 2 Retrospective (2026-06-14)

- **`decryptState(V3)` requires `tenantId`** — the existing migration script called
  `decryptState(raw)` without `tenantId`, which silently fails for V3 blobs. Fixed by threading
  `tenantId` through both `decryptState` and `encryptState` calls in the migration script.
  Future migration scripts must always pass `tenantId` when handling V3 or V4 blobs.
- **`CachingKeyRegistry` as decorator, not per-provider** — putting the DEK cache in each of the
  3 providers would have triplicated ~80 lines. Decorator pattern keeps providers clean; factory
  composes them. For any future provider, apply the decorator at the factory layer.
- **GCP KMS has no native `GenerateDataKey`** — AWS KMS returns plaintext+ciphertext in one call;
  GCP requires generating `randomBytes(32)` locally then wrapping with `cryptoKeys:encrypt`. Local
  generation is safe (CSPRNG), but callers must zero DEK in `finally` — enforced by contract.
- **GCP `DESTROY_SCHEDULED` covers both erasure phases** — unlike AWS where `DisableKey` (Phase 1)
  and `ScheduleKeyDeletion` (Phase 2) are separate calls, GCP's single `destroy` moves the key to
  `DESTROY_SCHEDULED` which is immediately unusable AND scheduled for permanent deletion.
  `disabledAt` = time of `destroy` call; `scheduledDeletionAt` = `disabledAt + destroyScheduledHours`.
- **`FileAuditStore` uses JSONL append-only** — `appendFile` (not `writeFile`) is critical;
  partial writes and process kills cannot corrupt prior receipts. Future audit stores
  (Redis sorted-set, relational DB) must preserve this append-only semantic.
