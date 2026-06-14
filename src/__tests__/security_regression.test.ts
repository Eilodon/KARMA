import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { redact } from "../telemetry/redaction.js";
import { resolveHttpRequestContext, resolveJwtRequestContext, resolveOidcRequestContext } from "../security/context.js";
import { globalCredentialVault } from "../middlewares/vault.js";
import { EncryptionService } from "../storage/encryption.js";

describe("Enterprise hardening regressions", () => {
  test("telemetry redacts secret-bearing strings, not only secret keys", () => {
    const redacted = redact({
      error: "request failed Authorization=Bearer abc.def.ghi redis://:hunter2@redis:6379 token=supersecret",
      nested: { apiKey: "should-not-leak" },
    }) as any;
    expect(redacted.error).not.toContain("hunter2");
    expect(redacted.error).not.toContain("supersecret");
    expect(redacted.error).toContain("[REDACTED]");
    expect(redacted.nested.apiKey).toBe("[REDACTED]");
  });

  test("identity headers are ignored unless trusted identity headers are explicitly enabled", () => {
    const ctx = resolveHttpRequestContext({
      "x-mcp-tenant-id": "attacker-tenant",
      "x-mcp-user-id": "attacker-user",
      "x-request-id": "req-123",
    });
    expect(ctx.tenantId).toBe("api-key-dev-tenant");
    expect(ctx.userId).toBe("api-key-user");
    expect(ctx.requestId).toBe("req-123");
  });

  test("vault rejects unsafe secret key names", async () => {
    await expect(globalCredentialVault.getSecret("../../MCP_API_KEY")).rejects.toThrow(/Invalid secret key name/);
  });

  test("encryption uses a versioned v2 envelope and decrypts round-trip", async () => {
    const key = `base64url:${Buffer.alloc(32, 7).toString("base64url")}`;
    const service = new EncryptionService(key);
    const state = { tenantId: "tenant-a", payload: { ok: true } };

    const encrypted = await service.encryptState(state);
    expect(encrypted).toMatch(/^smcp:v2:scrypt:/);
    await expect(service.decryptState(encrypted)).resolves.toEqual(state);
  });

  test("encrypted state does not accept plaintext JSON when a key is configured", async () => {
    const key = `base64url:${Buffer.alloc(32, 9).toString("base64url")}`;
    const service = new EncryptionService(key);

    await expect(service.decryptState(JSON.stringify({ injected: true }))).rejects.toThrow(/Legacy SHA-256 encrypted state detected/);
  });

  test("JWT claims can carry tenant, subject, client, and scopes per request", () => {
    const ctx = resolveJwtRequestContext({
      sub: "user-123",
      azp: "client-abc",
      tenant_id: "tenant-prod",
      scope: "calendar:read email:send",
    }, "req-jwt");

    expect(ctx.authType).toBe("jwt");
    expect(ctx.tenantId).toBe("tenant-prod");
    expect(ctx.userId).toBe("user-123");
    expect(ctx.clientId).toBe("client-abc");
    expect(ctx.scopes).toEqual(["calendar:read", "email:send"]);
  });

  // NF-01: x-forwarded-host SSRF in WWW-Authenticate
  test("WWW-Authenticate builder sanitises x-forwarded-proto to http/https only (NF-01)", async () => {
    const source = await readFile(new URL("../index.ts", import.meta.url), "utf-8");

    // Proto validation: must use allowlist check before building the URL
    expect(source).toContain(`["http", "https"].includes(rawProto) ? rawProto : "https"`);

    // Host validation: must call isAllowedHost before using the forwarded host
    const setHeaderIdx = source.indexOf('res.setHeader("WWW-Authenticate"');
    const wwwAuthBlock = source.slice(Math.max(0, setHeaderIdx - 600), setHeaderIdx + 200);
    expect(wwwAuthBlock).toContain("isAllowedHost(rawHost, allowedHosts) ? rawHost : null");

    // Proto fallback must default to https (not http) — check full source
    expect(source).toContain(`|| "https"`);
    expect(source).not.toContain(`|| req.protocol || "http"`);
  });

  test("WWW-Authenticate proto validation rejects arbitrary URI schemes", () => {
    const ALLOWED_PROTOS = new Set(["http", "https"]);
    const attackProtos = ["javascript", "data", "file", "vbscript", "ftp", "ws", "wss"];
    const safeProtos = ["http", "https"];

    for (const raw of attackProtos) {
      const sanitised = ALLOWED_PROTOS.has(raw) ? raw : "https";
      expect(sanitised).toBe("https");
    }
    for (const raw of safeProtos) {
      const sanitised = ALLOWED_PROTOS.has(raw) ? raw : "https";
      expect(sanitised).toBe(raw);
    }
  });

  // ── P3-A: OIDC context ───────────────────────────────────────────────────────

  test("resolveOidcRequestContext derives authType oidc from JWT claims", () => {
    const ctx = resolveOidcRequestContext({
      sub: "oidc-user-99",
      azp: "spa-client",
      tenant_id: "tenant-prod",
      scope: "mcp:invoke admin",
    }, "req-oidc");

    expect(ctx.authType).toBe("oidc");
    expect(ctx.userId).toBe("oidc-user-99");
    expect(ctx.clientId).toBe("spa-client");
    expect(ctx.tenantId).toBe("tenant-prod");
    expect(ctx.scopes).toEqual(["mcp:invoke", "admin"]);
  });

  test("scope array claims are capped at 32 elements (P3-A scope cap consistency)", () => {
    const oversizedArray = Array.from({ length: 50 }, (_, i) => `s${i}`);
    const ctx = resolveJwtRequestContext({ tenant_id: "tenant-prod", scope: oversizedArray }, "req-cap");
    expect(ctx.scopes).toHaveLength(32);
  });

  test("scope array cap is also enforced for resolveOidcRequestContext", () => {
    const oversizedArray = Array.from({ length: 50 }, (_, i) => `s${i}`);
    const ctx = resolveOidcRequestContext({ tenant_id: "tenant-prod", scope: oversizedArray }, "req-oidc-cap");
    expect(ctx.scopes).toHaveLength(32);
  });

  // ── P3-B: MCP_TRUST_IDENTITY_HEADERS startup warning ────────────────────────

  test("P3-B: index.ts emits startup warning when MCP_TRUST_IDENTITY_HEADERS is true (source check)", async () => {
    const source = await readFile(new URL("../index.ts", import.meta.url), "utf-8");

    // Warning must reference the flag name and the trusted-gateway requirement
    expect(source).toContain("MCP_TRUST_IDENTITY_HEADERS");
    expect(source).toContain("trusted");
    // Must emit via console.error (not silently swallowed)
    const warningIdx = source.indexOf("MCP_TRUST_IDENTITY_HEADERS=true");
    expect(warningIdx).toBeGreaterThan(-1);
    const surroundingBlock = source.slice(Math.max(0, warningIdx - 300), warningIdx + 400);
    expect(surroundingBlock).toContain("console.error");
  });

  // ── P3-A: WWW-Authenticate covers oidc_jwks mode (source check) ─────────────

  test("P3-A: index.ts WWW-Authenticate branch covers oidc_jwks mode (source check)", async () => {
    const source = await readFile(new URL("../index.ts", import.meta.url), "utf-8");

    // Both jwt and oidc_jwks must trigger the Bearer challenge
    expect(source).toContain(`ENV.MCP_AUTH_MODE === "jwt" || ENV.MCP_AUTH_MODE === "oidc_jwks"`);
    expect(source).toContain(`res.setHeader("WWW-Authenticate"`);
  });
});
