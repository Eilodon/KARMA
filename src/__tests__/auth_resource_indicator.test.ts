import { beforeEach, describe, expect, test, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  MCP_AUTH_MODE: "jwt",
  MCP_JWT_SECRET: "x".repeat(32),
  MCP_JWT_ISSUER: "https://issuer.example.com",
  MCP_JWT_AUDIENCE: "karma-api",
  MCP_RESOURCE_URI: "https://api.example.com/mcp",
  MCP_TENANT_ID: "tenant_test",
  MCP_TRUST_IDENTITY_HEADERS: false,
  MCP_API_KEY: undefined,
  MCP_JWKS_URI: undefined,
}));

vi.mock("jose", () => ({
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  ENV: mockEnv,
}));

import * as jose from "jose";
import { authenticateHttpRequest } from "../security/auth.js";

const BASE_PAYLOAD = {
  sub: "user-123",
  iss: "https://issuer.example.com",
  scope: "mcp:invoke",
  tenant_id: "tenant_test",
};

async function authenticatePayload(payload: Record<string, unknown>) {
  vi.mocked(jose.jwtVerify).mockResolvedValue({
    payload: { ...BASE_PAYLOAD, ...payload },
    protectedHeader: { alg: "HS256" },
  } as any);

  return authenticateHttpRequest({ authorization: "Bearer token" });
}

describe("OAuth resource indicator enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.MCP_AUTH_MODE = "jwt";
    mockEnv.MCP_RESOURCE_URI = "https://api.example.com/mcp";
    mockEnv.MCP_JWT_AUDIENCE = "karma-api";
  });

  test("accepts token when aud equals MCP_RESOURCE_URI", async () => {
    const ctx = await authenticatePayload({ aud: "https://api.example.com/mcp" });
    expect(ctx.userId).toBe("user-123");
  });

  test("accepts token when aud array contains MCP_RESOURCE_URI", async () => {
    const ctx = await authenticatePayload({ aud: ["karma-api", "https://api.example.com/mcp"] });
    expect(ctx.userId).toBe("user-123");
  });

  test("accepts token when resource equals MCP_RESOURCE_URI", async () => {
    const ctx = await authenticatePayload({ aud: "karma-api", resource: "https://api.example.com/mcp" });
    expect(ctx.userId).toBe("user-123");
  });

  test("rejects token when aud mismatch and resource missing", async () => {
    await expect(authenticatePayload({ aud: "other-api" })).rejects.toThrow("Unauthorized");
  });

  test("rejects token when resource mismatch and aud missing", async () => {
    await expect(authenticatePayload({ resource: "https://api.example.com/other" })).rejects.toThrow("Unauthorized");
  });

  test("rejects token when aud matches MCP_JWT_AUDIENCE but not MCP_RESOURCE_URI", async () => {
    await expect(authenticatePayload({ aud: "karma-api" })).rejects.toThrow("Unauthorized");
  });

  test("no-op when MCP_RESOURCE_URI unset", async () => {
    mockEnv.MCP_RESOURCE_URI = undefined as any;
    const ctx = await authenticatePayload({ aud: "karma-api" });
    expect(ctx.userId).toBe("user-123");
  });

  test("expired token still rejected before execution", async () => {
    vi.mocked(jose.jwtVerify).mockRejectedValue(new Error("JWTExpired"));
    await expect(authenticateHttpRequest({ authorization: "Bearer expired" })).rejects.toThrow("JWTExpired");
  });

  test("missing scope still reaches auth context empty before downstream execution policy", async () => {
    const ctx = await authenticatePayload({ aud: "https://api.example.com/mcp", scope: undefined });
    expect(ctx.scopes).toEqual([]);
  });
});
