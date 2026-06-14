import { ENV } from "../config/env.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

function parseList(raw: string): string[] {
  return raw.split(",").map(value => value.trim()).filter(Boolean);
}

export function protectedResourceMetadata(tools: ToolDefinition[]) {
  const authorizationServers = parseList(ENV.MCP_AUTHORIZATION_SERVERS);
  if (ENV.MCP_JWT_ISSUER && !authorizationServers.includes(ENV.MCP_JWT_ISSUER)) {
    authorizationServers.push(ENV.MCP_JWT_ISSUER);
  }

  return {
    resource: ENV.MCP_RESOURCE_URI || ENV.MCP_JWT_AUDIENCE || "/mcp",
    authorization_servers: authorizationServers,
    scopes_supported: [...new Set(tools.flatMap(tool => tool.requiredScopes || []))].sort(),
    bearer_methods_supported: ["header"],
  };
}

export function resourceMetadataPath(): string {
  return "/.well-known/oauth-protected-resource";
}
