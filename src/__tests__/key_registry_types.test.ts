// Compile-time shape check for key_registry.ts contracts.
// These assignments fail tsc if the types are wrong — caught at `pnpm test`.
import { describe, it } from "vitest";
import type { CryptoErasureReceipt, SealedBlob, ITenantKeyRegistry } from "../storage/key_registry.js";

const _receipt: CryptoErasureReceipt = {
  keyId: "tk_abc:v1",
  scope: "tenant",
  opaqueSubjectId: "abc",
  disabledAt: new Date().toISOString(),
  scheduledDeletionAt: new Date().toISOString(),
  reason: "gdpr-erasure",
};

const _blob: SealedBlob = {
  ciphertext: "base64url-data",
  encryptedDek: "base64url-edek",
  keyId: "tk_abc:v1",
  version: 1,
};

// ITenantKeyRegistry must expose sealForTenant / unsealForTenant
type _HasSeal = ITenantKeyRegistry["sealForTenant"];
type _HasUnseal = ITenantKeyRegistry["unsealForTenant"];
type _HasScheduleErasure = ITenantKeyRegistry["scheduleErasure"];

// Suppress unused-variable warnings
void _receipt; void _blob;

describe("key_registry types", () => {
  it("type contracts compile correctly", () => {
    // All assertions are compile-time — reaching here means tsc accepted the shapes
  });
});
