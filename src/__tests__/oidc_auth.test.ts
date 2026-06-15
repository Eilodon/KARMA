/**
 * P3-A: OIDC / oidc_jwks auth mode tests.
 *
 * Vitest hoists vi.mock() calls above all import statements, so both `jose`
 * and `../config/env.js` are replaced with controlled fakes before any module
 * in the dependency graph is loaded.  This eliminates the vi.resetModules()
 * + dynamic-import pattern, which causes brittle inter-test caching issues when
 * the mock factories reference variables not yet in scope.
 *
 * Rule: one vi.mock() per module, no vi.resetModules(), no dynamic re-imports.
 * Per-test behaviour is configured via vi.mocked() in each test body.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Module-level mocks (hoisted by Vitest before static imports) ─────────────

vi.mock("jose", () => ({
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  ENV: {
    MCP_AUTH_MODE: "oidc_jwks",
    MCP_JWKS_URI: "https://idp.example.com/.well-known/jwks.json",
    MCP_JWT_ISSUER: "https://idp.example.com",
    MCP_JWT_AUDIENCE: "karma-api",
    MCP_TENANT_ID: "tenant_test",
    MCP_TRUST_IDENTITY_HEADERS: false,
    MCP_API_KEY: undefined,
    MCP_JWT_SECRET: undefined,
  },
}));

// ── Static imports resolved after mocks are in place ─────────────────────────

import * as jose from "jose";
import { authenticateHttpRequest, resetOidcJwksCacheForTests } from "../security/auth.js";

// ─────────────────────────────────────────────────────────────────────────────

const JWKS_HANDLE = Symbol("fake-jwks-handle");

const VALID_PAYLOAD = {
  sub: "user-oidc-123",
  azp: "client-spa",
  iss: "https://idp.example.com",
  aud: "karma-api",
  tenant_id: "tenant_test",
  scope: "mcp:invoke profile",
};

beforeEach(() => {
  resetOidcJwksCacheForTests();
  vi.clearAllMocks();
});

describe("oidc_jwks authentication", () => {
  test("authenticates successfully and returns oidc context", async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(JWKS_HANDLE as any);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: VALID_PAYLOAD,
      protectedHeader: { alg: "RS256" },
    } as any);

    const ctx = await authenticateHttpRequest({
      authorization: "Bearer valid.oidc.token",
      "x-request-id": "req-oidc-001",
    });

    expect(ctx.authType).toBe("oidc");
    expect(ctx.userId).toBe("user-oidc-123");
    expect(ctx.clientId).toBe("client-spa");
    expect(ctx.tenantId).toBe("tenant_test");
    expect(ctx.scopes).toContain("mcp:invoke");
    expect(ctx.requestId).toBe("req-oidc-001");
  });

  test("createRemoteJWKSet is called with the configured JWKS URI", async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(JWKS_HANDLE as any);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: VALID_PAYLOAD,
      protectedHeader: { alg: "RS256" },
    } as any);

    await authenticateHttpRequest({ authorization: "Bearer token" });

    expect(jose.createRemoteJWKSet).toHaveBeenCalledOnce();
    expect(jose.createRemoteJWKSet).toHaveBeenCalledWith(
      new URL("https://idp.example.com/.well-known/jwks.json"),
    );
  });

  test("reuses the RemoteJWKSet resolver across requests for JWKS cache/cooldown", async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(JWKS_HANDLE as any);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: VALID_PAYLOAD,
      protectedHeader: { alg: "RS256" },
    } as any);

    await authenticateHttpRequest({ authorization: "Bearer token-1" });
    await authenticateHttpRequest({ authorization: "Bearer token-2" });

    expect(jose.createRemoteJWKSet).toHaveBeenCalledOnce();
    expect(jose.jwtVerify).toHaveBeenCalledTimes(2);
    expect(jose.jwtVerify).toHaveBeenNthCalledWith(
      2,
      "token-2",
      JWKS_HANDLE,
      { issuer: "https://idp.example.com", audience: "karma-api" },
    );
  });

  test("jwtVerify is called with issuer and audience from ENV", async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(JWKS_HANDLE as any);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: VALID_PAYLOAD,
      protectedHeader: { alg: "RS256" },
    } as any);

    await authenticateHttpRequest({ authorization: "Bearer token" });

    expect(jose.jwtVerify).toHaveBeenCalledWith(
      "token",
      JWKS_HANDLE,
      {
        issuer: "https://idp.example.com",
        audience: "karma-api",
      },
    );
  });

  test("throws Unauthorized when Authorization header is missing", async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(JWKS_HANDLE as any);

    await expect(authenticateHttpRequest({})).rejects.toThrow("Unauthorized");

    // JWKS set must not be created if there is no token to verify
    expect(jose.jwtVerify).not.toHaveBeenCalled();
  });

  test("throws Unauthorized when Authorization header has no Bearer prefix", async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(JWKS_HANDLE as any);

    await expect(
      authenticateHttpRequest({ authorization: "Basic dXNlcjpwYXNz" }),
    ).rejects.toThrow("Unauthorized");

    expect(jose.jwtVerify).not.toHaveBeenCalled();
  });

  test("throws when jwtVerify rejects (bad signature / expired)", async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(JWKS_HANDLE as any);
    vi.mocked(jose.jwtVerify).mockRejectedValue(new Error("JWTExpired"));

    await expect(
      authenticateHttpRequest({ authorization: "Bearer expired.token" }),
    ).rejects.toThrow("JWTExpired");
  });

  test("extracts scopes from space-separated scope string", async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(JWKS_HANDLE as any);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: { ...VALID_PAYLOAD, scope: "read write admin" },
      protectedHeader: { alg: "RS256" },
    } as any);

    const ctx = await authenticateHttpRequest({ authorization: "Bearer t" });

    expect(ctx.scopes).toEqual(["read", "write", "admin"]);
  });

  test("extracts scopes from array claim and caps at 32", async () => {
    const manyScopes = Array.from({ length: 40 }, (_, i) => `scope${i}`);
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(JWKS_HANDLE as any);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: { ...VALID_PAYLOAD, scope: manyScopes },
      protectedHeader: { alg: "RS256" },
    } as any);

    const ctx = await authenticateHttpRequest({ authorization: "Bearer t" });

    expect(ctx.scopes).toHaveLength(32);
    expect(ctx.scopes[0]).toBe("scope0");
    expect(ctx.scopes[31]).toBe("scope31");
  });

  test("accepts x-request-id as an array and uses first element", async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(JWKS_HANDLE as any);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: VALID_PAYLOAD,
      protectedHeader: { alg: "RS256" },
    } as any);

    const ctx = await authenticateHttpRequest({
      authorization: "Bearer t",
      "x-request-id": ["req-first", "req-second"],
    });

    expect(ctx.requestId).toBe("req-first");
  });
});
