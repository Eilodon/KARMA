import { afterEach, describe, expect, test, vi } from "vitest";
import { SignJWT } from "jose";

const SECRET = "s".repeat(32);
const ISSUER = "https://issuer.example.com";
const AUDIENCE = "super-mcp-api";
const RESOURCE = "https://api.example.com/mcp";

async function importAuthWithJwtEnv() {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("MCP_AUTH_MODE", "jwt");
  vi.stubEnv("MCP_JWT_SECRET", SECRET);
  vi.stubEnv("MCP_JWT_ISSUER", ISSUER);
  vi.stubEnv("MCP_JWT_AUDIENCE", AUDIENCE);
  vi.stubEnv("MCP_RESOURCE_URI", RESOURCE);
  vi.stubEnv("MCP_IDEMPOTENCY_RESULT_TTL_SECONDS", "3600");
  return import("../security/auth.js");
}

async function signToken(claims: Record<string, unknown>) {
  const { iss, aud, ...payload } = claims;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(typeof iss === "string" ? iss : ISSUER)
    .setAudience((aud as string | string[] | undefined) || AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
}

describe("jwt authentication runtime verification", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  test("accepts a signature-valid token only when issuer, audience, resource, tenant, and scopes line up", async () => {
    const { authenticateHttpRequest } = await importAuthWithJwtEnv();
    const token = await signToken({
      sub: "user-123",
      azp: "client-abc",
      tenant_id: "tenant-prod",
      scope: "mcp:invoke email:send",
      resource: RESOURCE,
    });

    const ctx = await authenticateHttpRequest({
      authorization: `Bearer ${token}`,
      "x-request-id": "req-jwt-runtime",
    });

    expect(ctx).toEqual({
      authType: "jwt",
      tenantId: "tenant-prod",
      userId: "user-123",
      clientId: "client-abc",
      scopes: ["mcp:invoke", "email:send"],
      requestId: "req-jwt-runtime",
    });
  });

  test("rejects wrong audience before request context is created", async () => {
    const { authenticateHttpRequest } = await importAuthWithJwtEnv();
    const token = await signToken({
      sub: "user-123",
      tenant_id: "tenant-prod",
      aud: "other-api",
      resource: RESOURCE,
    });

    await expect(authenticateHttpRequest({ authorization: `Bearer ${token}` })).rejects.toThrow();
  });

  test("rejects token minted for configured audience but missing configured resource indicator", async () => {
    const { authenticateHttpRequest } = await importAuthWithJwtEnv();
    const token = await signToken({
      sub: "user-123",
      tenant_id: "tenant-prod",
      aud: AUDIENCE,
    });

    await expect(authenticateHttpRequest({ authorization: `Bearer ${token}` })).rejects.toThrow("Unauthorized");
  });

  test("rejects valid signature tokens that do not carry a tenant claim", async () => {
    const { authenticateHttpRequest } = await importAuthWithJwtEnv();
    const token = await signToken({
      sub: "user-123",
      resource: RESOURCE,
    });

    await expect(authenticateHttpRequest({ authorization: `Bearer ${token}` })).rejects.toThrow("tenant claim is required");
  });

  test("rejects tokens signed with a different shared secret", async () => {
    const { authenticateHttpRequest } = await importAuthWithJwtEnv();
    const token = await new SignJWT({
      sub: "user-123",
      tenant_id: "tenant-prod",
      resource: RESOURCE,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(32)));

    await expect(authenticateHttpRequest({ authorization: `Bearer ${token}` })).rejects.toThrow();
  });
});
