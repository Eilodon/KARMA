import { beforeEach, describe, expect, test, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  MCP_TENANT_ID: "tenant_default",
  MCP_TRUST_IDENTITY_HEADERS: false,
}));

vi.mock("../config/env.js", () => ({ ENV: mockEnv }));

import {
  resolveHttpRequestContext,
  resolveJwtRequestContext,
  resolveOidcRequestContext,
} from "../security/context.js";

describe("request context security boundaries", () => {
  beforeEach(() => {
    mockEnv.MCP_TENANT_ID = "tenant_default";
    mockEnv.MCP_TRUST_IDENTITY_HEADERS = false;
  });

  test("ignores caller-supplied identity headers unless a trusted gateway mode is enabled", () => {
    const ctx = resolveHttpRequestContext({
      "x-mcp-tenant-id": "attacker-tenant",
      "x-mcp-user-id": "attacker-user",
      "x-mcp-client-id": "attacker-client",
      "x-mcp-scopes": "admin",
      "x-request-id": "req-safe",
    });

    expect(ctx).toMatchObject({
      tenantId: "api-key-dev-tenant",
      userId: "api-key-user",
      clientId: "api-key-client",
      scopes: ["mcp:invoke"],
      requestId: "req-safe",
      authType: "api-key",
    });
  });

  test("trusted identity-header mode requires tenant and rejects unknown x-mcp-* headers", () => {
    mockEnv.MCP_TRUST_IDENTITY_HEADERS = true;

    expect(() => resolveHttpRequestContext({
      "x-mcp-user-id": "user-a",
    })).toThrow("x-mcp-tenant-id is required");

    expect(() => resolveHttpRequestContext({
      "x-mcp-tenant-id": "tenant-a",
      "x-mcp-admin": "true",
    })).toThrow("Unrecognized identity header: x-mcp-admin");
  });

  test("trusted identity-header mode sanitizes optional IDs and filters scope values", () => {
    mockEnv.MCP_TRUST_IDENTITY_HEADERS = true;
    const oversizedScopes = Array.from({ length: 40 }, (_, i) => `scope${i}`).join(",");

    const ctx = resolveHttpRequestContext({
      "x-mcp-tenant-id": "tenant-a",
      "x-mcp-user-id": "../../etc/passwd",
      "x-mcp-client-id": "client-a",
      "x-mcp-scopes": `read, bad space,${oversizedScopes}`,
      "x-request-id": "req-trusted",
    });

    expect(ctx.tenantId).toBe("tenant-a");
    expect(ctx.userId).toBe("api-key-user");
    expect(ctx.clientId).toBe("client-a");
    expect(ctx.scopes).toHaveLength(32);
    expect(ctx.scopes).toContain("read");
    expect(ctx.scopes).not.toContain("bad space");
  });

  test("JWT and OIDC contexts require tenant claims and cap sanitized scopes", () => {
    expect(() => resolveJwtRequestContext({ sub: "user-a" }, "req-missing-tenant"))
      .toThrow("tenant claim is required");

    const oversizedScopes = Array.from({ length: 40 }, (_, i) => `scope${i}`);
    const jwtCtx = resolveJwtRequestContext({
      tenant_id: "tenant-prod",
      sub: "user-prod",
      azp: "client-prod",
      scope: [...oversizedScopes, "bad scope"],
    }, "req-jwt");
    expect(jwtCtx.authType).toBe("jwt");
    expect(jwtCtx.scopes).toHaveLength(32);
    expect(jwtCtx.scopes[0]).toBe("scope0");
    expect(jwtCtx.scopes).not.toContain("bad scope");

    const oidcCtx = resolveOidcRequestContext({
      mcp_tenant_id: "tenant-oidc",
      user_id: "oidc-user",
      client_id: "oidc-client",
      scopes: "openid profile email:read",
    }, "req-oidc");
    expect(oidcCtx.authType).toBe("oidc");
    expect(oidcCtx.tenantId).toBe("tenant-oidc");
    expect(oidcCtx.scopes).toEqual(["openid", "profile", "email:read"]);
  });
});
