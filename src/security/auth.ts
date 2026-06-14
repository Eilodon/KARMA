import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { timingSafeEqual } from "node:crypto";
import { ENV } from "../config/env.js";
import { resolveHttpRequestContext, resolveJwtRequestContext, resolveOidcRequestContext, type RequestContext } from "./context.js";

function isAuthorizedApiKey(received: unknown): boolean {
  if (typeof received !== "string") return false;
  const expected = Buffer.from(ENV.MCP_API_KEY || "", "utf-8");
  const actual = Buffer.from(received, "utf-8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function bearerToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1] || null;
}

function audienceList(aud: unknown): string[] {
  if (Array.isArray(aud)) {
    return aud.filter((item): item is string => typeof item === "string");
  }

  if (typeof aud === "string") {
    return [aud];
  }

  return [];
}

function enforceResourceIndicator(payload: Record<string, unknown>): void {
  if (!ENV.MCP_RESOURCE_URI) return;

  const audiences = audienceList(payload.aud);
  const resource = typeof payload.resource === "string" ? payload.resource : undefined;

  if (!audiences.includes(ENV.MCP_RESOURCE_URI) && resource !== ENV.MCP_RESOURCE_URI) {
    throw new Error("Unauthorized");
  }
}

let cachedJwksUri: string | undefined;
let cachedJwks: JWTVerifyGetKey | undefined;

function getOidcRemoteJwks(): JWTVerifyGetKey {
  const uri = ENV.MCP_JWKS_URI;
  if (!uri) {
    throw new Error("Unauthorized");
  }
  // S-1.1 fix: validate JWKS URI host against allowlist to prevent SSRF or key
  // substitution via an attacker-controlled JWKS endpoint.
  const allowlistRaw = ENV.MCP_JWKS_ALLOWLIST;
  if (allowlistRaw) {
    const allowlist = new Set(allowlistRaw.split(",").map(h => h.trim()).filter(Boolean));
    if (allowlist.size > 0) {
      const host = new URL(uri).hostname;
      if (!allowlist.has(host)) {
        throw new Error("Unauthorized");
      }
    }
  }
  if (!cachedJwks || cachedJwksUri !== uri) {
    cachedJwksUri = uri;
    cachedJwks = createRemoteJWKSet(new URL(uri));
  }
  return cachedJwks;
}

export function resetOidcJwksCacheForTests(): void {
  cachedJwksUri = undefined;
  cachedJwks = undefined;
}

export async function authenticateHttpRequest(headers: Record<string, string | string[] | undefined>): Promise<RequestContext> {
  if (ENV.MCP_AUTH_MODE === "api_key") {
    if (!isAuthorizedApiKey(headers["x-api-key"])) {
      throw new Error("Unauthorized");
    }
    return resolveHttpRequestContext(headers);
  }

  // P3-A: Remote JWKS verification — token signature validated against the IdP's
  // published key set. OIDC mode must always enforce issuer + audience to avoid
  // accidentally accepting signature-valid tokens minted for another resource.
  if (ENV.MCP_AUTH_MODE === "oidc_jwks") {
    const token = bearerToken(headers.authorization ?? headers.Authorization);
    if (!token || !ENV.MCP_JWT_ISSUER || !ENV.MCP_JWT_AUDIENCE) {
      throw new Error("Unauthorized");
    }
    const JWKS = getOidcRemoteJwks();
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ENV.MCP_JWT_ISSUER,
      audience: ENV.MCP_JWT_AUDIENCE,
      maxTokenAge: `${ENV.MCP_JWT_MAX_AGE_SECONDS}s`,
    });
    enforceResourceIndicator(payload);
    const requestId = Array.isArray(headers["x-request-id"]) ? headers["x-request-id"][0] : headers["x-request-id"];
    return resolveOidcRequestContext(payload, requestId);
  }

  const token = bearerToken(headers.authorization ?? headers.Authorization);
  if (!token || !ENV.MCP_JWT_SECRET) {
    throw new Error("Unauthorized");
  }

  const secret = new TextEncoder().encode(ENV.MCP_JWT_SECRET);
  const { payload } = await jwtVerify(token, secret, {
    issuer: ENV.MCP_JWT_ISSUER || undefined,
    audience: ENV.MCP_JWT_AUDIENCE || undefined,
    maxTokenAge: `${ENV.MCP_JWT_MAX_AGE_SECONDS}s`,
  });
  enforceResourceIndicator(payload);
  const requestId = Array.isArray(headers["x-request-id"]) ? headers["x-request-id"][0] : headers["x-request-id"];
  return resolveJwtRequestContext(payload, requestId);
}
