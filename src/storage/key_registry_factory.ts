import type { ITenantKeyRegistry } from "./key_registry.js";
import { ENV } from "../config/env.js";

export async function createKeyRegistry(): Promise<ITenantKeyRegistry | null> {
  if (!ENV.KMS_PROVIDER) return null;

  // ── Provider selection ────────────────────────────────────────────────────

  let inner: ITenantKeyRegistry;

  switch (ENV.KMS_PROVIDER) {
    case "local": {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "LocalKeyRegistry is dev/test only. Set KMS_PROVIDER=vault, aws-kms, or gcp-kms for production.",
        );
      }
      const { LocalKeyRegistry } = await import("./providers/local_key_registry.js");
      inner = new LocalKeyRegistry(
        ENV.MCP_ENCRYPTION_KEY ?? "dev-only-not-for-production-change-me",
        ENV.MCP_PROJECT_ID,
      );
      break;
    }

    case "vault": {
      if (!ENV.VAULT_ADDR || !ENV.VAULT_TOKEN) {
        throw new Error("VAULT_ADDR and VAULT_TOKEN are required when KMS_PROVIDER=vault.");
      }
      const { VaultKeyRegistry } = await import("./providers/vault_key_registry.js");
      inner = new VaultKeyRegistry({
        vaultAddr:   ENV.VAULT_ADDR,
        vaultToken:  ENV.VAULT_TOKEN,
        mountPath:   ENV.VAULT_TRANSIT_MOUNT,
        projectSalt: ENV.MCP_PROJECT_ID,
      });
      break;
    }

    case "aws-kms": {
      const { AwsKmsKeyRegistry } = await import("./providers/aws_kms_key_registry.js");
      inner = new AwsKmsKeyRegistry({
        region:            ENV.AWS_KMS_REGION,
        projectSalt:       ENV.MCP_PROJECT_ID,
        pendingWindowDays: ENV.AWS_KMS_PENDING_WINDOW_DAYS,
      });
      break;
    }

    case "gcp-kms": {
      if (!ENV.GCP_KMS_PROJECT || !ENV.GCP_KMS_KEYRING) {
        throw new Error("GCP_KMS_PROJECT and GCP_KMS_KEYRING are required when KMS_PROVIDER=gcp-kms.");
      }
      const { GcpKmsKeyRegistry } = await import("./providers/gcp_kms_key_registry.js");
      inner = new GcpKmsKeyRegistry({
        project:               ENV.GCP_KMS_PROJECT,
        location:              ENV.GCP_KMS_LOCATION,
        keyRing:               ENV.GCP_KMS_KEYRING,
        projectSalt:           ENV.MCP_PROJECT_ID,
        accessToken:           ENV.GCP_KMS_ACCESS_TOKEN,
        destroyScheduledHours: ENV.GCP_KMS_DESTROY_DURATION_HOURS,
      });
      break;
    }
  }

  // ── Wrap with CachingKeyRegistry (DEK cache + durable audit persistence) ──

  const { CachingKeyRegistry } = await import("./caching_key_registry.js");
  const { FileAuditStore }     = await import("./audit_store.js");

  return new CachingKeyRegistry(inner, {
    ttlMs:         ENV.DEK_CACHE_TTL_MS,
    maxUsesPerDek: ENV.DEK_CACHE_MAX_USES,
    auditStore:    new FileAuditStore(ENV.MCP_PROJECT_ID),
  });
}
