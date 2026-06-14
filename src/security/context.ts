import { AsyncLocalStorage } from "node:async_hooks";
import { ENV } from "../config/env.js";

export interface RequestContext {
  tenantId: string;
  userId: string;
  clientId: string;
  scopes: string[];
  requestId: string;
  authType: "stdio" | "api-key" | "jwt" | "oidc" | "gateway";
}

const ID_PATTERN = /^[a-zA-Z0-9_.:@-]{1,128}$/;
const HEADER_ALLOWLIST = new Set([
  "x-mcp-tenant-id",
  "x-mcp-user-id",
  "x-mcp-client-id",
  "x-mcp-scopes",
  "x-request-id",
]);

const storage = new AsyncLocalStorage<RequestContext>();

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeId(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!ID_PATTERN.test(trimmed)) return fallback;
  return trimmed;
}

function normalizeRequiredId(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  const trimmed = value.trim();
  if (!ID_PATTERN.test(trimmed)) throw new Error(`${label} is invalid`);
  return trimmed;
}

function normalizeScopes(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map(s => s.trim()).filter(s => ID_PATTERN.test(s)).slice(0, 32);
}

export function defaultRequestContext(): RequestContext {
  return {
    tenantId: normalizeId(ENV.MCP_TENANT_ID, "tenant_local"),
    userId: "local-user",
    clientId: "stdio-client",
    scopes: ["local"],
    requestId: `local-${Date.now()}`,
    authType: "stdio",
  };
}

export function resolveHttpRequestContext(headers: Record<string, string | string[] | undefined>): RequestContext {
  const defaultCtx = defaultRequestContext();
  if (!ENV.MCP_TRUST_IDENTITY_HEADERS) {
    return {
      ...defaultCtx,
      tenantId: "api-key-dev-tenant",
      userId: "api-key-user",
      clientId: "api-key-client",
      scopes: ["mcp:invoke"],
      requestId: normalizeId(headerValue(headers, "x-request-id"), `req-${Date.now()}`),
      authType: "api-key",
    };
  }

  // Identity headers must be injected by a trusted auth gateway. They are ignored unless explicitly enabled.
  for (const key of Object.keys(headers)) {
    const lowered = key.toLowerCase();
    if (lowered.startsWith("x-mcp-") && !HEADER_ALLOWLIST.has(lowered)) {
      throw new Error(`Unrecognized identity header: ${lowered}`);
    }
  }

  return {
    tenantId: normalizeRequiredId(headerValue(headers, "x-mcp-tenant-id"), "x-mcp-tenant-id"),
    userId: normalizeId(headerValue(headers, "x-mcp-user-id"), "api-key-user"),
    clientId: normalizeId(headerValue(headers, "x-mcp-client-id"), "api-key-client"),
    scopes: normalizeScopes(headerValue(headers, "x-mcp-scopes")),
    requestId: normalizeId(headerValue(headers, "x-request-id"), `req-${Date.now()}`),
    // B-7.2 fix: "gateway" authType lets validateScopes enforce the scopes the gateway
    // injected via x-mcp-scopes, instead of bypassing them like "api-key" would.
    authType: "gateway",
  };
}

export function resolveJwtRequestContext(claims: Record<string, unknown>, requestId?: string): RequestContext {
  const scopesClaim = claims.scope ?? claims.scopes;

  return {
    tenantId: normalizeRequiredId(
      (claims["mcp_tenant_id"] as string | undefined) || (claims["tenant_id"] as string | undefined),
      "tenant claim"
    ),
    userId: normalizeId((claims.sub as string | undefined) || (claims["user_id"] as string | undefined), "jwt-user"),
    clientId: normalizeId((claims.azp as string | undefined) || (claims["client_id"] as string | undefined), "jwt-client"),
    scopes: (
      Array.isArray(scopesClaim)
        ? scopesClaim.filter((scope): scope is string => typeof scope === "string" && ID_PATTERN.test(scope))
        : normalizeScopes(typeof scopesClaim === "string" ? scopesClaim.replace(/\s+/g, ",") : undefined)
    ).slice(0, 32),
    requestId: normalizeId(requestId, `req-${Date.now()}`),
    authType: "jwt",
  };
}

// P3-A: OIDC context derived from a remotely-verified JWT. Shares claim extraction
// logic with resolveJwtRequestContext but surfaces authType "oidc" so downstream
// policy can distinguish gateway-federated identities from static shared secrets.
export function resolveOidcRequestContext(claims: Record<string, unknown>, requestId?: string): RequestContext {
  return {
    ...resolveJwtRequestContext(claims, requestId),
    authType: "oidc",
  };
}

export function getRequestContext(): RequestContext {
  return storage.getStore() ?? defaultRequestContext();
}

export async function withRequestContext<T>(context: RequestContext, operation: () => Promise<T>): Promise<T> {
  return await storage.run(context, operation);
}
