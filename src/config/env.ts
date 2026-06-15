import { config } from "dotenv";
import { z } from "zod/v4";

// Load .env without printing to stdout. Stdio MCP transports reserve stdout for protocol frames only.
config({ quiet: true });

const EnvSchema = z.object({
  STORAGE_DRIVER: z.enum(["fs", "redis", "memory"]).default("fs"),
  TELEMETRY_DRIVER: z.enum(["file", "stdout", "stderr"]).default("file"),
  TRANSPORT_DRIVER: z.enum(["stdio", "http"]).default("stdio"),
  HTTP_HOST: z.string().default("127.0.0.1"),
  HTTP_PORT: z.number().int().min(1).max(65535).default(3333),
  MCP_AUTH_MODE: z.enum(["api_key", "jwt", "oidc_jwks"]).default("api_key"),
  MCP_API_KEY: z.string().min(32).optional(),
  MCP_JWT_SECRET: z.string().min(32).optional(),
  MCP_JWT_ISSUER: z.string().optional(),
  MCP_JWT_AUDIENCE: z.string().optional(),
  // P3-A: Remote JWKS endpoint for oidc_jwks mode.
  MCP_JWKS_URI: z.string().url().optional(),
  // S-1.1: Comma-separated hostname allowlist for JWKS fetches (e.g. "idp.example.com").
  MCP_JWKS_ALLOWLIST: z.string().default(""),
  // MISS-5: Maximum accepted token age; tokens older than this are rejected.
  MCP_JWT_MAX_AGE_SECONDS: z.number().int().min(60).max(86400).default(3600),
  MCP_RESOURCE_URI: z.string().optional(),
  MCP_AUTHORIZATION_SERVERS: z.string().default(""),
  ALLOWED_ORIGINS: z.string().default(""),
  ALLOWED_HOSTS: z.string().default(""),

  REDIS_URL: z.string().optional(),

  ENABLE_RATE_LIMIT: z.boolean().default(false),
  RATE_LIMIT_MAX_REQUESTS: z.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW_MS: z.number().int().min(100).default(60000),

  ENABLE_QUOTA: z.boolean().default(false),
  QUOTA_DAILY_LIMIT: z.number().int().min(1).default(1000),
  MCP_ALLOW_UNLIMITED_HTTP: z.boolean().default(false),

  MCP_ENCRYPTION_KEY: z.string().optional(),
  MCP_ALLOW_LEGACY_SHA256_KDF: z.boolean().default(false),
  MCP_SAFE_MODE: z.boolean().default(true),
  MCP_PROJECT_ID: z.string().default("karma_default"),
  MCP_TENANT_ID: z.string().default("tenant_local"),
  MCP_TRUST_IDENTITY_HEADERS: z.boolean().default(false),

  MCP_PLUGIN_ALLOWLIST: z.string().default("system.tool.js,system.tool.ts"),
  MCP_PLUGIN_AUTO_DISCOVERY: z.boolean().default(false),
  MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY: z.boolean().default(false),
  MCP_ENABLE_TEST_TOOLS: z.boolean().default(false),
  MCP_PLUGIN_SHA256_ALLOWLIST: z.string().default(""),
  // Non-built-in plugins default to an external child-process boundary.
  // policy mode is trusted-only: built-ins may run in-process, third-party files are rejected.
  MCP_PLUGIN_ISOLATION_MODE: z.enum(["policy", "external"]).default("external"),
  MCP_EXTERNAL_PLUGIN_TIMEOUT_MS: z.number().int().min(1000).max(600000).default(30000),
  MCP_EXTERNAL_PLUGIN_MAX_OLD_SPACE_MB: z.number().int().min(16).max(4096).default(128),
  MCP_EXTERNAL_PLUGIN_NETWORK_POLICY: z.enum(["deny", "allow"]).default("deny"),
  MCP_EXTERNAL_PLUGIN_FS_POLICY: z.enum(["read-only", "allow"]).default("read-only"),
  MCP_EXTERNAL_PLUGIN_MAX_STDERR_BYTES: z.number().int().min(1024).max(10 * 1024 * 1024).default(256 * 1024),
  MCP_EXTERNAL_PLUGIN_NODE_PERMISSION: z.boolean().default(false),
  MCP_PLUGIN_PIN_MANIFEST: z.boolean().default(true),
  MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX: z.boolean().default(false),
  MCP_REQUIRE_CRYPTO_ERASURE: z.boolean().default(false),
  // KMS provider selection — required when MCP_REQUIRE_CRYPTO_ERASURE=true in production
  KMS_PROVIDER: z.enum(["vault", "aws-kms", "gcp-kms", "local"]).optional(),
  // HashiCorp Vault Transit config (KMS_PROVIDER=vault)
  VAULT_ADDR: z.string().url().optional(),
  VAULT_TOKEN: z.string().optional(),
  VAULT_TRANSIT_MOUNT: z.string().default("transit"),
  // AWS KMS config (KMS_PROVIDER=aws-kms)
  AWS_KMS_REGION: z.string().optional(),
  AWS_KMS_PENDING_WINDOW_DAYS: z.number().int().min(7).max(30).default(7),
  // GCP Cloud KMS config (KMS_PROVIDER=gcp-kms)
  GCP_KMS_PROJECT: z.string().optional(),
  GCP_KMS_LOCATION: z.string().default("global"),
  GCP_KMS_KEYRING: z.string().optional(),
  GCP_KMS_ACCESS_TOKEN: z.string().optional(), // if unset, auto-fetched from GCP metadata server
  GCP_KMS_DESTROY_DURATION_HOURS: z.number().int().min(1).max(2880).default(24),
  // DEK cache config (shared across all KMS providers via CachingKeyRegistry)
  DEK_CACHE_TTL_MS: z.number().int().min(0).max(3_600_000).default(300_000),
  DEK_CACHE_MAX_USES: z.number().int().min(0).max(1_000_000).default(1_000),

  MCP_SECRET_ALLOWLIST: z.string().default(""),
  MCP_ALLOW_SECRET_WRITE: z.boolean().default(false),
  MCP_OUTPUT_FIREWALL_PII_MODE: z.enum(["credentials_only", "strict"]).default("credentials_only"),

  MCP_TOOL_TIMEOUT_MS: z.number().int().min(1000).max(3600000).default(300000),
  MCP_TOOL_LIST_TTL_MS: z.number().int().min(0).max(3600000).default(300000),
  MCP_LOCK_TTL_MS: z.number().int().min(5000).max(3600000).default(420000),
  MCP_LOCK_ACQUIRE_DEADLINE_MS: z.number().int().min(5000).max(3600000).default(420000),
  // S-1.2: HMAC secret for idempotency key generation; min 32 chars.
  MCP_IDEMPOTENCY_SECRET: z.string().min(32).optional(),
  MCP_IDEMPOTENCY_WORKING_TTL_SECONDS: z.number().int().min(30).max(86400).default(600),
  MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: z.number().int().min(60).max(2592000),
  MCP_IDEMPOTENCY_ERROR_TTL_SECONDS: z.number().int().min(30).max(3600).default(300),
  MCP_REDIS_MAX_BACKUPS: z.number().int().min(1).max(1000).default(25),
  MCP_HTTP_BODY_LIMIT: z.string().default("100kb"),
  MCP_TELEMETRY_MAX_BYTES: z.number().int().min(1024).default(1024 * 1024),
  MCP_TELEMETRY_MAX_BACKUPS: z.number().int().min(1).max(100).default(5),
  OTEL_SERVICE_NAME: z.string().default("karma-server"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

  MCP_TASK_POLL_INTERVAL_MS: z.number().int().min(1000).max(60000).default(5000),

  // P2-A final target: rc2026 is the only supported protocol mode in this branch.
  // Legacy/compat are deliberately rejected at configuration load time.
  MCP_PROTOCOL_MODE: z.literal("rc2026").default("rc2026"),
});

const DEV_ENCRYPTION_KEYS = new Set([
  "super_secret_key_for_dev_only",
  "changeme",
  "change_me",
  "dev",
  "development",
]);

function parseSafeBoolean(val: string | undefined): boolean | undefined {
  if (val === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(val);
}

function parseIntEnv(val: string | undefined): number | undefined {
  if (val === undefined || val.trim() === "") return undefined;
  const parsed = Number.parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseList(raw: string): string[] {
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function hasNonBuiltInPluginConfig(allowlist: string, autoDiscovery: boolean): boolean {
  if (autoDiscovery) return true;
  return parseList(allowlist).some(name => name !== "system.tool.ts" && name !== "system.tool.js");
}

function loadEnv() {
  const storageDriver = process.env.STORAGE_DRIVER || "fs";
  const rawEnv = {
    STORAGE_DRIVER: process.env.STORAGE_DRIVER,
    TELEMETRY_DRIVER: process.env.TELEMETRY_DRIVER || ((process.env.TRANSPORT_DRIVER || "stdio") === "stdio" ? "stderr" : undefined),
    TRANSPORT_DRIVER: process.env.TRANSPORT_DRIVER,
    HTTP_HOST: process.env.HTTP_HOST,
    HTTP_PORT: parseIntEnv(process.env.HTTP_PORT),
    MCP_AUTH_MODE: process.env.MCP_AUTH_MODE,
    MCP_API_KEY: process.env.MCP_API_KEY,
    MCP_JWT_SECRET: process.env.MCP_JWT_SECRET,
    MCP_JWT_ISSUER: process.env.MCP_JWT_ISSUER,
    MCP_JWT_AUDIENCE: process.env.MCP_JWT_AUDIENCE,
    MCP_JWKS_URI: process.env.MCP_JWKS_URI || undefined,
    MCP_JWKS_ALLOWLIST: process.env.MCP_JWKS_ALLOWLIST,
    MCP_JWT_MAX_AGE_SECONDS: parseIntEnv(process.env.MCP_JWT_MAX_AGE_SECONDS),
    MCP_RESOURCE_URI: process.env.MCP_RESOURCE_URI,
    MCP_AUTHORIZATION_SERVERS: process.env.MCP_AUTHORIZATION_SERVERS,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
    REDIS_URL: process.env.REDIS_URL,
    ENABLE_RATE_LIMIT: parseSafeBoolean(process.env.ENABLE_RATE_LIMIT),
    RATE_LIMIT_MAX_REQUESTS: parseIntEnv(process.env.RATE_LIMIT_MAX_REQUESTS),
    RATE_LIMIT_WINDOW_MS: parseIntEnv(process.env.RATE_LIMIT_WINDOW_MS),
    ENABLE_QUOTA: parseSafeBoolean(process.env.ENABLE_QUOTA),
    QUOTA_DAILY_LIMIT: parseIntEnv(process.env.QUOTA_DAILY_LIMIT),
    MCP_ALLOW_UNLIMITED_HTTP: parseSafeBoolean(process.env.MCP_ALLOW_UNLIMITED_HTTP),
    MCP_ENCRYPTION_KEY: process.env.MCP_ENCRYPTION_KEY,
    MCP_ALLOW_LEGACY_SHA256_KDF: parseSafeBoolean(process.env.MCP_ALLOW_LEGACY_SHA256_KDF),
    MCP_SAFE_MODE: parseSafeBoolean(process.env.MCP_SAFE_MODE),
    MCP_PROJECT_ID: process.env.MCP_PROJECT_ID,
    MCP_TENANT_ID: process.env.MCP_TENANT_ID,
    MCP_TRUST_IDENTITY_HEADERS: parseSafeBoolean(process.env.MCP_TRUST_IDENTITY_HEADERS),
    MCP_PLUGIN_ALLOWLIST: process.env.MCP_PLUGIN_ALLOWLIST,
    MCP_PLUGIN_AUTO_DISCOVERY: parseSafeBoolean(process.env.MCP_PLUGIN_AUTO_DISCOVERY),
    MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY: parseSafeBoolean(process.env.MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY),
    MCP_ENABLE_TEST_TOOLS: parseSafeBoolean(process.env.MCP_ENABLE_TEST_TOOLS),
    MCP_PLUGIN_SHA256_ALLOWLIST: process.env.MCP_PLUGIN_SHA256_ALLOWLIST,
    MCP_PLUGIN_ISOLATION_MODE: process.env.MCP_PLUGIN_ISOLATION_MODE,
    MCP_EXTERNAL_PLUGIN_TIMEOUT_MS: parseIntEnv(process.env.MCP_EXTERNAL_PLUGIN_TIMEOUT_MS),
    MCP_EXTERNAL_PLUGIN_MAX_OLD_SPACE_MB: parseIntEnv(process.env.MCP_EXTERNAL_PLUGIN_MAX_OLD_SPACE_MB),
    MCP_EXTERNAL_PLUGIN_NETWORK_POLICY: process.env.MCP_EXTERNAL_PLUGIN_NETWORK_POLICY,
    MCP_EXTERNAL_PLUGIN_FS_POLICY: process.env.MCP_EXTERNAL_PLUGIN_FS_POLICY,
    MCP_EXTERNAL_PLUGIN_MAX_STDERR_BYTES: parseIntEnv(process.env.MCP_EXTERNAL_PLUGIN_MAX_STDERR_BYTES),
    MCP_EXTERNAL_PLUGIN_NODE_PERMISSION: parseSafeBoolean(process.env.MCP_EXTERNAL_PLUGIN_NODE_PERMISSION),
    MCP_PLUGIN_PIN_MANIFEST: parseSafeBoolean(process.env.MCP_PLUGIN_PIN_MANIFEST),
    MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX: parseSafeBoolean(process.env.MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX),
    MCP_REQUIRE_CRYPTO_ERASURE: parseSafeBoolean(process.env.MCP_REQUIRE_CRYPTO_ERASURE),
    KMS_PROVIDER: process.env.KMS_PROVIDER as "vault" | "aws-kms" | "gcp-kms" | "local" | undefined,
    VAULT_ADDR: process.env.VAULT_ADDR || undefined,
    VAULT_TOKEN: process.env.VAULT_TOKEN,
    VAULT_TRANSIT_MOUNT: process.env.VAULT_TRANSIT_MOUNT,
    AWS_KMS_REGION: process.env.AWS_KMS_REGION,
    AWS_KMS_PENDING_WINDOW_DAYS: parseIntEnv(process.env.AWS_KMS_PENDING_WINDOW_DAYS),
    GCP_KMS_PROJECT: process.env.GCP_KMS_PROJECT,
    GCP_KMS_LOCATION: process.env.GCP_KMS_LOCATION,
    GCP_KMS_KEYRING: process.env.GCP_KMS_KEYRING,
    GCP_KMS_ACCESS_TOKEN: process.env.GCP_KMS_ACCESS_TOKEN,
    GCP_KMS_DESTROY_DURATION_HOURS: parseIntEnv(process.env.GCP_KMS_DESTROY_DURATION_HOURS),
    DEK_CACHE_TTL_MS: parseIntEnv(process.env.DEK_CACHE_TTL_MS),
    DEK_CACHE_MAX_USES: parseIntEnv(process.env.DEK_CACHE_MAX_USES),
    MCP_SECRET_ALLOWLIST: process.env.MCP_SECRET_ALLOWLIST,
    MCP_ALLOW_SECRET_WRITE: parseSafeBoolean(process.env.MCP_ALLOW_SECRET_WRITE),
    MCP_OUTPUT_FIREWALL_PII_MODE: process.env.MCP_OUTPUT_FIREWALL_PII_MODE,
    MCP_TOOL_TIMEOUT_MS: parseIntEnv(process.env.MCP_TOOL_TIMEOUT_MS),
    MCP_TOOL_LIST_TTL_MS: parseIntEnv(process.env.MCP_TOOL_LIST_TTL_MS),
    MCP_LOCK_TTL_MS: parseIntEnv(process.env.MCP_LOCK_TTL_MS),
    MCP_LOCK_ACQUIRE_DEADLINE_MS: parseIntEnv(process.env.MCP_LOCK_ACQUIRE_DEADLINE_MS),
    MCP_IDEMPOTENCY_SECRET: process.env.MCP_IDEMPOTENCY_SECRET,
    MCP_IDEMPOTENCY_WORKING_TTL_SECONDS: parseIntEnv(process.env.MCP_IDEMPOTENCY_WORKING_TTL_SECONDS),
    MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: parseIntEnv(process.env.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS) ?? (storageDriver === "redis" ? 604800 : 3600),
    MCP_IDEMPOTENCY_ERROR_TTL_SECONDS: parseIntEnv(process.env.MCP_IDEMPOTENCY_ERROR_TTL_SECONDS),
    MCP_REDIS_MAX_BACKUPS: parseIntEnv(process.env.MCP_REDIS_MAX_BACKUPS),
    MCP_HTTP_BODY_LIMIT: process.env.MCP_HTTP_BODY_LIMIT,
    MCP_TELEMETRY_MAX_BYTES: parseIntEnv(process.env.MCP_TELEMETRY_MAX_BYTES),
    MCP_TELEMETRY_MAX_BACKUPS: parseIntEnv(process.env.MCP_TELEMETRY_MAX_BACKUPS),
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    MCP_TASK_POLL_INTERVAL_MS: parseIntEnv(process.env.MCP_TASK_POLL_INTERVAL_MS),
    MCP_PROTOCOL_MODE: process.env.MCP_PROTOCOL_MODE,
  };

  const parsed = EnvSchema.safeParse(rawEnv);
  
  if (!parsed.success) {
    console.error("FATAL: Invalid Environment Variables Configuration:", parsed.error.format());
    process.exit(1);
  }

  const env = parsed.data;

  if (env.STORAGE_DRIVER === "redis" && !env.REDIS_URL) {
    console.error("FATAL: REDIS_URL environment variable is required when STORAGE_DRIVER=redis");
    process.exit(1);
  }

  if (env.STORAGE_DRIVER === "redis" && !env.MCP_ENCRYPTION_KEY) {
    console.error("FATAL: MCP_ENCRYPTION_KEY is required when STORAGE_DRIVER=redis");
    process.exit(1);
  }

  // S-1.2: idempotency keys are HMAC-SHA256 only when MCP_IDEMPOTENCY_SECRET is set.
  // Plain SHA256 keys are predictable and can be forged by anyone with Redis write access.
  if (env.STORAGE_DRIVER === "redis" && !env.MCP_IDEMPOTENCY_SECRET) {
    console.error("FATAL: MCP_IDEMPOTENCY_SECRET is required when STORAGE_DRIVER=redis. Set it to a random string of at least 32 characters to prevent idempotency key forgery.");
    process.exit(1);
  }

  if (env.STORAGE_DRIVER !== "redis" && env.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS > 3600) {
    console.error("FATAL: MCP_IDEMPOTENCY_RESULT_TTL_SECONDS must be <= 3600 when STORAGE_DRIVER is fs or memory. Use STORAGE_DRIVER=redis for long-lived idempotency.");
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production" && env.STORAGE_DRIVER !== "redis") {
    console.error("FATAL: Native MCP Tasks require durable Redis storage in production. Use STORAGE_DRIVER=redis.");
    process.exit(1);
  }

  if (env.TRANSPORT_DRIVER === "stdio" && env.TELEMETRY_DRIVER === "stdout") {
    console.error("FATAL: TELEMETRY_DRIVER=stdout is not allowed with TRANSPORT_DRIVER=stdio because stdout is reserved for MCP protocol frames. Use file or stderr.");
    process.exit(1);
  }

  if (env.TRANSPORT_DRIVER === "http") {
    if (env.MCP_AUTH_MODE === "api_key" && process.env.NODE_ENV === "production") {
      console.error("FATAL: MCP_AUTH_MODE=api_key is for local/dev only when TRANSPORT_DRIVER=http. Use jwt or oidc_jwks in production.");
      process.exit(1);
    }

    if (env.MCP_AUTH_MODE === "api_key" && (!env.MCP_API_KEY || env.MCP_API_KEY.trim().length < 32)) {
      console.error("FATAL: MCP_API_KEY is required when TRANSPORT_DRIVER=http");
      process.exit(1);
    }

    if (env.MCP_AUTH_MODE === "jwt" && (!env.MCP_JWT_SECRET || env.MCP_JWT_SECRET.trim().length < 32)) {
      console.error("FATAL: MCP_JWT_SECRET is required when TRANSPORT_DRIVER=http and MCP_AUTH_MODE=jwt");
      process.exit(1);
    }

    if (process.env.NODE_ENV === "production" && env.MCP_AUTH_MODE === "jwt") {
      if (!env.MCP_JWT_ISSUER || env.MCP_JWT_ISSUER.trim().length === 0) {
        console.error("FATAL: MCP_JWT_ISSUER is required in production when TRANSPORT_DRIVER=http and MCP_AUTH_MODE=jwt.");
        process.exit(1);
      }
      if (!env.MCP_JWT_AUDIENCE || env.MCP_JWT_AUDIENCE.trim().length === 0) {
        console.error("FATAL: MCP_JWT_AUDIENCE is required in production when TRANSPORT_DRIVER=http and MCP_AUTH_MODE=jwt.");
        process.exit(1);
      }
      if (!env.MCP_RESOURCE_URI || env.MCP_RESOURCE_URI.trim().length === 0) {
        console.error("FATAL: MCP_RESOURCE_URI is required in production when TRANSPORT_DRIVER=http and MCP_AUTH_MODE=jwt.");
        process.exit(1);
      }
    }

    if (env.MCP_AUTH_MODE === "oidc_jwks") {
      if (!env.MCP_JWKS_URI) {
        console.error("FATAL: MCP_JWKS_URI is required when MCP_AUTH_MODE=oidc_jwks. Provide a valid JWKS endpoint URL (e.g. https://idp.example.com/.well-known/jwks.json).");
        process.exit(1);
      }
      if (!env.MCP_JWT_ISSUER || env.MCP_JWT_ISSUER.trim().length === 0) {
        console.error("FATAL: MCP_JWT_ISSUER is required when TRANSPORT_DRIVER=http and MCP_AUTH_MODE=oidc_jwks.");
        process.exit(1);
      }
      if (!env.MCP_JWT_AUDIENCE || env.MCP_JWT_AUDIENCE.trim().length === 0) {
        console.error("FATAL: MCP_JWT_AUDIENCE is required when TRANSPORT_DRIVER=http and MCP_AUTH_MODE=oidc_jwks.");
        process.exit(1);
      }
      if (process.env.NODE_ENV === "production" && (!env.MCP_RESOURCE_URI || env.MCP_RESOURCE_URI.trim().length === 0)) {
        console.error("FATAL: MCP_RESOURCE_URI is required in production when TRANSPORT_DRIVER=http and MCP_AUTH_MODE=oidc_jwks.");
        process.exit(1);
      }
    }

    if (process.env.NODE_ENV === "production" && !env.MCP_ALLOW_UNLIMITED_HTTP) {
      if (!env.ENABLE_RATE_LIMIT) {
        console.error("FATAL: ENABLE_RATE_LIMIT=true is required for production HTTP. Set MCP_ALLOW_UNLIMITED_HTTP=true only with an explicit risk waiver.");
        process.exit(1);
      }
      if (!env.ENABLE_QUOTA) {
        console.error("FATAL: ENABLE_QUOTA=true is required for production HTTP. Set MCP_ALLOW_UNLIMITED_HTTP=true only with an explicit risk waiver.");
        process.exit(1);
      }
    }

    const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
    if (env.ALLOWED_ORIGINS === "*" || allowedOrigins.length === 0) {
      console.error("FATAL: ALLOWED_ORIGINS must be an explicit comma-separated allowlist when TRANSPORT_DRIVER=http");
      process.exit(1);
    }

    const allowedHosts = parseList(env.ALLOWED_HOSTS);
    if (env.ALLOWED_HOSTS === "*" || allowedHosts.length === 0) {
      console.error("FATAL: ALLOWED_HOSTS must be an explicit comma-separated allowlist when TRANSPORT_DRIVER=http");
      process.exit(1);
    }
  }

  if (
    env.MCP_ENCRYPTION_KEY &&
    DEV_ENCRYPTION_KEYS.has(env.MCP_ENCRYPTION_KEY.toLowerCase())
  ) {
    console.error("FATAL: MCP_ENCRYPTION_KEY uses a known development value. Generate a unique production secret.");
    process.exit(1);
  }

  if (env.MCP_PLUGIN_AUTO_DISCOVERY && !env.MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY) {
    console.error("FATAL: MCP_PLUGIN_AUTO_DISCOVERY is disabled by default for production safety. Set MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY=true only for trusted local development, or use MCP_PLUGIN_ALLOWLIST.");
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production" && env.MCP_ENABLE_TEST_TOOLS) {
    console.error("FATAL: MCP_ENABLE_TEST_TOOLS is test/dev only and must not be enabled in production.");
    process.exit(1);
  }

  if (
    process.env.NODE_ENV === "production" &&
    hasNonBuiltInPluginConfig(env.MCP_PLUGIN_ALLOWLIST, env.MCP_PLUGIN_AUTO_DISCOVERY) &&
    !env.MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX
  ) {
    console.error("FATAL: Production untrusted/non-built-in plugins require a real container, microVM, or WASM sandbox runner. Current external child-process isolation is best-effort only; set MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true only for a documented trusted-plugin waiver.");
    process.exit(1);
  }

  // MISS-3/E-6.2 fix: require SHA256 pinning for non-built-in plugins in production.
  if (
    process.env.NODE_ENV === "production" &&
    hasNonBuiltInPluginConfig(env.MCP_PLUGIN_ALLOWLIST, env.MCP_PLUGIN_AUTO_DISCOVERY) &&
    !env.MCP_PLUGIN_SHA256_ALLOWLIST
  ) {
    console.error("FATAL: MCP_PLUGIN_SHA256_ALLOWLIST is required in production when loading non-built-in plugins. Set it to comma-separated 'filename:sha256' pairs to pin expected plugin hashes.");
    process.exit(1);
  }

  // D-5.2/E-6.2 fix: require Node.js permission model for non-built-in plugins in production.
  if (
    process.env.NODE_ENV === "production" &&
    hasNonBuiltInPluginConfig(env.MCP_PLUGIN_ALLOWLIST, env.MCP_PLUGIN_AUTO_DISCOVERY) &&
    !env.MCP_EXTERNAL_PLUGIN_NODE_PERMISSION
  ) {
    console.error("FATAL: MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true is required in production when loading non-built-in plugins. Start Node.js with --experimental-permission for OS-level sandboxing.");
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production" && env.MCP_REQUIRE_CRYPTO_ERASURE) {
    if (!env.KMS_PROVIDER || env.KMS_PROVIDER === "local") {
      console.error(
        "FATAL: MCP_REQUIRE_CRYPTO_ERASURE=true requires KMS_PROVIDER=vault or KMS_PROVIDER=aws-kms. " +
        "LocalKeyRegistry is dev/test only and provides no real crypto-erasure guarantee.",
      );
      process.exit(1);
    }
    if (env.KMS_PROVIDER === "vault" && (!env.VAULT_ADDR || !env.VAULT_TOKEN)) {
      console.error("FATAL: VAULT_ADDR and VAULT_TOKEN are required when KMS_PROVIDER=vault.");
      process.exit(1);
    }
    if (env.KMS_PROVIDER === "gcp-kms" && (!env.GCP_KMS_PROJECT || !env.GCP_KMS_KEYRING)) {
      console.error("FATAL: GCP_KMS_PROJECT and GCP_KMS_KEYRING are required when KMS_PROVIDER=gcp-kms.");
      process.exit(1);
    }
  }

  return env;
}

export const ENV = loadEnv();
