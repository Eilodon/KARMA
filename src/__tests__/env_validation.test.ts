import { afterEach, describe, expect, test, vi } from "vitest";

async function importEnvWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }
  return import("../config/env.js");
}

describe("env validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("fails fast when non-Redis idempotency result TTL exceeds 1 hour", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(importEnvWith({
      STORAGE_DRIVER: "fs",
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "604800",
    })).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("allows long idempotency result TTL with Redis", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const mod = await importEnvWith({
      STORAGE_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
      MCP_ENCRYPTION_KEY: "x".repeat(32),
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "604800",
    });

    expect(mod.ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS).toBe(604800);
  });

  test("defaults telemetry to stderr for stdio when unset", async () => {
    const mod = await importEnvWith({
      TRANSPORT_DRIVER: "stdio",
      TELEMETRY_DRIVER: undefined,
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.TELEMETRY_DRIVER).toBe("stderr");
  });

  test("defaults lock TTL to 420000ms", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_LOCK_TTL_MS).toBe(420000);
  });

  test("defaults acquire deadline to 420000ms (matches lock TTL default)", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_LOCK_ACQUIRE_DEADLINE_MS).toBe(420000);
  });

  test("MCP_LOCK_ACQUIRE_DEADLINE_MS can be configured independently of MCP_LOCK_TTL_MS", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      MCP_LOCK_TTL_MS: "30000",
      MCP_LOCK_ACQUIRE_DEADLINE_MS: "60000",
    });

    expect(mod.ENV.MCP_LOCK_TTL_MS).toBe(30000);
    expect(mod.ENV.MCP_LOCK_ACQUIRE_DEADLINE_MS).toBe(60000);
  });

  test("defaults error idempotency TTL to 300s (NF-05)", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_IDEMPOTENCY_ERROR_TTL_SECONDS).toBe(300);
  });

  test("defaults Redis idempotency result TTL to 7 days", async () => {
    const mod = await importEnvWith({
      STORAGE_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
      MCP_ENCRYPTION_KEY: "x".repeat(32),
    });

    expect(mod.ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS).toBe(604800);
  });

  test("defaults non-Redis idempotency result TTL to 1 hour", async () => {
    const mod = await importEnvWith({
      STORAGE_DRIVER: "fs",
    });

    expect(mod.ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS).toBe(3600);
  });

  // -- Native Tasks -----------------------------------------------------------

  test("MCP_TASK_POLL_INTERVAL_MS defaults to 5000", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_TASK_POLL_INTERVAL_MS).toBe(5000);
  });

  test("MCP_TASK_POLL_INTERVAL_MS is configurable", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      MCP_TASK_POLL_INTERVAL_MS: "10000",
    });

    expect(mod.ENV.MCP_TASK_POLL_INTERVAL_MS).toBe(10000);
  });

  test("MCP_TOOL_LIST_TTL_MS defaults to 300000", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_TOOL_LIST_TTL_MS).toBe(300000);
  });

  test("MCP_ENABLE_TEST_TOOLS defaults to false", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_ENABLE_TEST_TOOLS).toBe(false);
  });

  test("MCP_ENABLE_TEST_TOOLS is rejected in production", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(importEnvWith({
      NODE_ENV: "production",
      MCP_ENABLE_TEST_TOOLS: "true",
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    })).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("non-built-in plugin isolation defaults to external with deny/read-only worker guards", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_PLUGIN_ISOLATION_MODE).toBe("external");
    expect(mod.ENV.MCP_EXTERNAL_PLUGIN_MAX_OLD_SPACE_MB).toBe(128);
    expect(mod.ENV.MCP_EXTERNAL_PLUGIN_MAX_STDERR_BYTES).toBe(256 * 1024);
    expect(mod.ENV.MCP_EXTERNAL_PLUGIN_NODE_PERMISSION).toBe(false);
    expect(mod.ENV.MCP_EXTERNAL_PLUGIN_NETWORK_POLICY).toBe("deny");
    expect(mod.ENV.MCP_EXTERNAL_PLUGIN_FS_POLICY).toBe("read-only");
    expect(mod.ENV.MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX).toBe(false);
    expect(mod.ENV.MCP_REQUIRE_CRYPTO_ERASURE).toBe(false);
    expect(mod.ENV.MCP_OUTPUT_FIREWALL_PII_MODE).toBe("credentials_only");
  });

  test("external plugin guard knobs are configurable within safe bounds", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      MCP_EXTERNAL_PLUGIN_MAX_OLD_SPACE_MB: "256",
      MCP_EXTERNAL_PLUGIN_MAX_STDERR_BYTES: "131072",
      MCP_EXTERNAL_PLUGIN_NODE_PERMISSION: "true",
      MCP_EXTERNAL_PLUGIN_NETWORK_POLICY: "allow",
      MCP_EXTERNAL_PLUGIN_FS_POLICY: "allow",
      MCP_OUTPUT_FIREWALL_PII_MODE: "strict",
    });

    expect(mod.ENV.MCP_EXTERNAL_PLUGIN_MAX_OLD_SPACE_MB).toBe(256);
    expect(mod.ENV.MCP_EXTERNAL_PLUGIN_MAX_STDERR_BYTES).toBe(131072);
    expect(mod.ENV.MCP_EXTERNAL_PLUGIN_NODE_PERMISSION).toBe(true);
    expect(mod.ENV.MCP_EXTERNAL_PLUGIN_NETWORK_POLICY).toBe("allow");
    expect(mod.ENV.MCP_EXTERNAL_PLUGIN_FS_POLICY).toBe("allow");
    expect(mod.ENV.MCP_OUTPUT_FIREWALL_PII_MODE).toBe("strict");
  });

  // ── P2-A: MCP_PROTOCOL_MODE ──────────────────────────────────────────────

  test("MCP_PROTOCOL_MODE defaults to 'rc2026'", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_PROTOCOL_MODE).toBe("rc2026");
  });

  test("MCP_PROTOCOL_MODE rejects 'compat' in final branch", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      MCP_PROTOCOL_MODE: "compat",
    })).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("MCP_PROTOCOL_MODE rejects 'legacy' in final branch", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      MCP_PROTOCOL_MODE: "legacy",
    })).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("MCP_PROTOCOL_MODE accepts 'rc2026'", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      MCP_PROTOCOL_MODE: "rc2026",
    });

    expect(mod.ENV.MCP_PROTOCOL_MODE).toBe("rc2026");
  });

  test("MCP_PROTOCOL_MODE rejects unknown value and exits", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      importEnvWith({
        MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
        MCP_PROTOCOL_MODE: "unsupported_value",
      }),
    ).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  // ── P3-A: MCP_AUTH_MODE=oidc_jwks ───────────────────────────────────────────

  test("MCP_AUTH_MODE accepts 'oidc_jwks' as a valid enum value", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      MCP_AUTH_MODE: "oidc_jwks",
    });

    expect(mod.ENV.MCP_AUTH_MODE).toBe("oidc_jwks");
  });

  test("MCP_AUTH_MODE rejects unknown value 'oauth2' and exits", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      importEnvWith({
        MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
        MCP_AUTH_MODE: "oauth2",
      }),
    ).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("requires MCP_JWKS_URI when MCP_AUTH_MODE=oidc_jwks and TRANSPORT_DRIVER=http", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      importEnvWith({
        TRANSPORT_DRIVER: "http",
        MCP_AUTH_MODE: "oidc_jwks",
        ALLOWED_ORIGINS: "https://app.example.com",
        ALLOWED_HOSTS: "app.example.com",
        MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      }),
    ).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("requires MCP_JWT_ISSUER when MCP_AUTH_MODE=oidc_jwks and TRANSPORT_DRIVER=http", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      importEnvWith({
        TRANSPORT_DRIVER: "http",
        MCP_AUTH_MODE: "oidc_jwks",
        MCP_JWKS_URI: "https://idp.example.com/.well-known/jwks.json",
        MCP_JWT_AUDIENCE: "karma-api",
        ALLOWED_ORIGINS: "https://app.example.com",
        ALLOWED_HOSTS: "app.example.com",
        MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      }),
    ).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("requires MCP_JWT_AUDIENCE when MCP_AUTH_MODE=oidc_jwks and TRANSPORT_DRIVER=http", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      importEnvWith({
        TRANSPORT_DRIVER: "http",
        MCP_AUTH_MODE: "oidc_jwks",
        MCP_JWKS_URI: "https://idp.example.com/.well-known/jwks.json",
        MCP_JWT_ISSUER: "https://idp.example.com",
        ALLOWED_ORIGINS: "https://app.example.com",
        ALLOWED_HOSTS: "app.example.com",
        MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      }),
    ).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("accepts MCP_AUTH_MODE=oidc_jwks with JWKS URI, issuer, and audience over HTTP", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const mod = await importEnvWith({
      TRANSPORT_DRIVER: "http",
      MCP_AUTH_MODE: "oidc_jwks",
      MCP_JWKS_URI: "https://idp.example.com/.well-known/jwks.json",
      MCP_JWT_ISSUER: "https://idp.example.com",
      MCP_JWT_AUDIENCE: "karma-api",
      ALLOWED_ORIGINS: "https://app.example.com",
      ALLOWED_HOSTS: "app.example.com",
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_AUTH_MODE).toBe("oidc_jwks");
    expect(mod.ENV.MCP_JWKS_URI).toBe("https://idp.example.com/.well-known/jwks.json");
    expect(mod.ENV.MCP_JWT_ISSUER).toBe("https://idp.example.com");
    expect(mod.ENV.MCP_JWT_AUDIENCE).toBe("karma-api");
  });

  test("rejects MCP_JWKS_URI that is not a valid URL and exits", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      importEnvWith({
        MCP_AUTH_MODE: "oidc_jwks",
        MCP_JWKS_URI: "not-a-url",
        MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
      }),
    ).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });


  test("production HTTP jwt requires issuer, audience, resource, and governance unless waived", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(importEnvWith({
      NODE_ENV: "production",
      STORAGE_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
      MCP_ENCRYPTION_KEY: "x".repeat(32),
      TRANSPORT_DRIVER: "http",
      MCP_AUTH_MODE: "jwt",
      MCP_JWT_SECRET: "s".repeat(32),
      ALLOWED_ORIGINS: "https://app.example.com",
      ALLOWED_HOSTS: "app.example.com",
    })).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("accepts production HTTP jwt only with issuer, audience, resource, rate limit, and quota", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const mod = await importEnvWith({
      NODE_ENV: "production",
      STORAGE_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
      MCP_ENCRYPTION_KEY: "x".repeat(32),
      TRANSPORT_DRIVER: "http",
      MCP_AUTH_MODE: "jwt",
      MCP_JWT_SECRET: "s".repeat(32),
      MCP_JWT_ISSUER: "https://idp.example.com",
      MCP_JWT_AUDIENCE: "karma-api",
      MCP_RESOURCE_URI: "https://api.example.com/mcp",
      ENABLE_RATE_LIMIT: "true",
      ENABLE_QUOTA: "true",
      ALLOWED_ORIGINS: "https://app.example.com",
      ALLOWED_HOSTS: "app.example.com",
    });

    expect(mod.ENV.MCP_AUTH_MODE).toBe("jwt");
    expect(mod.ENV.ENABLE_RATE_LIMIT).toBe(true);
    expect(mod.ENV.ENABLE_QUOTA).toBe(true);
  });

  test("production HTTP rate/quota can only be disabled with explicit waiver", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const mod = await importEnvWith({
      NODE_ENV: "production",
      STORAGE_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
      MCP_ENCRYPTION_KEY: "x".repeat(32),
      TRANSPORT_DRIVER: "http",
      MCP_AUTH_MODE: "jwt",
      MCP_JWT_SECRET: "s".repeat(32),
      MCP_JWT_ISSUER: "https://idp.example.com",
      MCP_JWT_AUDIENCE: "karma-api",
      MCP_RESOURCE_URI: "https://api.example.com/mcp",
      MCP_ALLOW_UNLIMITED_HTTP: "true",
      ALLOWED_ORIGINS: "https://app.example.com",
      ALLOWED_HOSTS: "app.example.com",
    });

    expect(mod.ENV.MCP_ALLOW_UNLIMITED_HTTP).toBe(true);
    expect(mod.ENV.ENABLE_RATE_LIMIT).toBe(false);
    expect(mod.ENV.ENABLE_QUOTA).toBe(false);
  });

  test("production HTTP oidc_jwks requires MCP_RESOURCE_URI", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(importEnvWith({
      NODE_ENV: "production",
      STORAGE_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
      MCP_ENCRYPTION_KEY: "x".repeat(32),
      TRANSPORT_DRIVER: "http",
      MCP_AUTH_MODE: "oidc_jwks",
      MCP_JWKS_URI: "https://idp.example.com/.well-known/jwks.json",
      MCP_JWT_ISSUER: "https://idp.example.com",
      MCP_JWT_AUDIENCE: "karma-api",
      ENABLE_RATE_LIMIT: "true",
      ENABLE_QUOTA: "true",
      ALLOWED_ORIGINS: "https://app.example.com",
      ALLOWED_HOSTS: "app.example.com",
    })).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("production non-built-in plugin config requires best-effort waiver until real sandbox exists", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(importEnvWith({
      NODE_ENV: "production",
      STORAGE_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
      MCP_ENCRYPTION_KEY: "x".repeat(32),
      MCP_PLUGIN_ALLOWLIST: "system.tool.js,partner.tool.js",
    })).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("production crypto-erasure requirement fails closed until smcp:v3 KMS runtime exists", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(importEnvWith({
      NODE_ENV: "production",
      STORAGE_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
      MCP_ENCRYPTION_KEY: "x".repeat(32),
      MCP_REQUIRE_CRYPTO_ERASURE: "true",
    })).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  // ── P3-B: MCP_TRUST_IDENTITY_HEADERS default remains false ──────────────────

  test("MCP_TRUST_IDENTITY_HEADERS defaults to false", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_TRUST_IDENTITY_HEADERS).toBe(false);
  });
});
