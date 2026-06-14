import { access, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as os from "node:os";

// Allow legacy SHA-256 blobs to be read during migration runs
process.env.MCP_ALLOW_LEGACY_SHA256_KDF = "true";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = process.argv.find(arg => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getTenantDir(tenantId: string): string {
  const readable = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "tenant";
  const digest = createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
  return join(os.homedir(), ".super_mcp", "data", `${readable}_${digest}`);
}

function blobFormat(raw: string): string {
  if (raw.startsWith("smcp:v4:kms:"))        return "v4:kms";
  if (raw.startsWith("smcp:v3:hkdf-tenant:")) return "v3:hkdf-tenant";
  if (raw.startsWith("smcp:v2:scrypt:"))      return "v2:scrypt";
  return "legacy:sha256";
}

async function migrateFs(tenantId: string, kmsActive: boolean): Promise<void> {
  const { globalEncryption } = await import("../storage/encryption.js");
  const file = join(getTenantDir(tenantId), "state.json");
  if (!(await pathExists(file))) {
    throw new Error(`No local state file found for tenant '${tenantId}' at ${file}`);
  }

  const raw     = await readFile(file, "utf-8");
  const trimmed = raw.trim();
  const from    = blobFormat(trimmed);

  if (from === "v4:kms") {
    console.error(`[SUPER-MCP] FS state for tenant '${tenantId}' is already smcp:v4:kms — no migration needed.`);
    return;
  }
  if (from === "v2:scrypt" && !kmsActive) {
    console.error(
      `[SUPER-MCP] FS state for tenant '${tenantId}' is smcp:v2:scrypt. ` +
      "Set KMS_PROVIDER to migrate to smcp:v4:kms.",
    );
    return;
  }

  // V3 requires tenantId for decrypt; passing it for all formats is harmless
  const state   = await globalEncryption.decryptState(trimmed, tenantId);
  const migrated = await globalEncryption.encryptState(state, tenantId);

  const safeName = from.replace(/[:/]/g, "_");
  const backup   = `${file}.legacy_${safeName}_${Date.now()}`;
  const tmp      = `${file}.migration_tmp`;
  await writeFile(tmp, `${migrated}\n`, { encoding: "utf-8", mode: 0o600 });
  await rename(file, backup);
  await rename(tmp, file);
  console.error(
    `[SUPER-MCP] Migrated FS state for tenant '${tenantId}' from ${from} ` +
    `to ${blobFormat(migrated)}. Legacy backup: ${backup}`,
  );
}

async function migrateRedis(tenantId: string, kmsActive: boolean): Promise<void> {
  const [{ ENV }, { globalEncryption }, { getRedisClient, closeRedisClient }] = await Promise.all([
    import("../config/env.js"),
    import("../storage/encryption.js"),
    import("../storage/redis_client.js"),
  ]);

  const redis = getRedisClient();
  const key   = `super_mcp:state:${ENV.MCP_PROJECT_ID}:${tenantId}`;
  const raw   = await redis.get(key);
  if (!raw) {
    throw new Error(`No Redis state found for tenant '${tenantId}' at key ${key}`);
  }

  const from = blobFormat(raw);
  if (from === "v4:kms") {
    console.error(`[SUPER-MCP] Redis state for tenant '${tenantId}' is already smcp:v4:kms — no migration needed.`);
    await closeRedisClient();
    return;
  }
  if (from === "v2:scrypt" && !kmsActive) {
    console.error(
      `[SUPER-MCP] Redis state for tenant '${tenantId}' is smcp:v2:scrypt. ` +
      "Set KMS_PROVIDER to migrate to smcp:v4:kms.",
    );
    await closeRedisClient();
    return;
  }

  const state    = await globalEncryption.decryptState(raw, tenantId);
  const migrated = await globalEncryption.encryptState(state, tenantId);

  const safeName  = from.replace(/[:/]/g, "_");
  const legacyKey = `${key}:legacy_${safeName}_${Date.now()}`;
  const script    = `
    local current = redis.call('GET', KEYS[1])
    if current ~= ARGV[1] then
      return 0
    end
    redis.call('SET', KEYS[2], current)
    redis.call('SET', KEYS[1], ARGV[2])
    return 1
  `;
  const result = await redis.eval(script, 2, key, legacyKey, raw, migrated);
  await closeRedisClient();
  if (Number(result) !== 1) {
    throw new Error(
      `Redis state changed during migration for tenant '${tenantId}'. Retry the migration.`,
    );
  }
  console.error(
    `[SUPER-MCP] Migrated Redis state for tenant '${tenantId}' from ${from} ` +
    `to ${blobFormat(migrated)}. Legacy backup key: ${legacyKey}`,
  );
}

async function main(): Promise<void> {
  const { ENV } = await import("../config/env.js");
  const tenantId = argValue("tenant") || ENV.MCP_TENANT_ID;
  const driver   = argValue("driver") || ENV.STORAGE_DRIVER;

  if (!ENV.MCP_ENCRYPTION_KEY) {
    throw new Error("MCP_ENCRYPTION_KEY is required for encryption migration.");
  }

  // Initialize KMS registry for V3→V4 (and V2→V4) migration
  let kmsActive = false;
  if (ENV.KMS_PROVIDER) {
    const [{ createKeyRegistry }, { globalEncryption }] = await Promise.all([
      import("../storage/key_registry_factory.js"),
      import("../storage/encryption.js"),
    ]);
    const registry = await createKeyRegistry();
    if (registry) {
      globalEncryption.setKeyRegistry(registry);
      kmsActive = true;
      console.error(`[SUPER-MCP] KMS registry initialised (${ENV.KMS_PROVIDER}). Target format: smcp:v4:kms.`);
    }
  }

  if (driver === "fs") {
    await migrateFs(tenantId, kmsActive);
    return;
  }
  if (driver === "redis") {
    await migrateRedis(tenantId, kmsActive);
    return;
  }

  throw new Error(`Unsupported migration driver '${driver}'. Use --driver fs or --driver redis.`);
}

main().catch(error => {
  console.error("[SUPER-MCP] Encryption migration failed:", error);
  process.exit(1);
});
