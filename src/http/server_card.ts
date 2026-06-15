import { ENV } from "../config/env.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

function toolCard(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations || {},
    execution: tool.execution || { taskSupport: "forbidden" },
    requiredScopes: tool.requiredScopes || [],
    allowedPhases: tool.allowedPhases,
  };
}

export function createServerCard(tools: ToolDefinition[], version: string) {
  return {
    schemaVersion: "draft",
    name: "karma-server",
    title: "KARMA",
    description: "First use case of SUPER-MCP - Hardened production MCP server.",
    version,
    protocol: {
      transport: ENV.TRANSPORT_DRIVER,
      statelessHttp: ENV.TRANSPORT_DRIVER === "http",
      mcpEndpoint: ENV.TRANSPORT_DRIVER === "http" ? "/mcp" : undefined,
      // P2-C: Advertise final rc2026 protocol mode; clients must send
      // Mcp-Method / Mcp-Name operation headers as required.
      protocolMode: ENV.MCP_PROTOCOL_MODE,
      discoverMethod: "server/discover",
      operationHeaders: {
        method: "Mcp-Method",
        name: "Mcp-Name",
      },
    },
    extensions: {
      "io.modelcontextprotocol/tasks": {
        methods: ["tasks/get", "tasks/update", "tasks/cancel"],
        list: false,
        pollIntervalMs: ENV.MCP_TASK_POLL_INTERVAL_MS,
        ttlMs: ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS * 1000,
      },
    },
    auth: {
      mode: ENV.TRANSPORT_DRIVER === "http" ? ENV.MCP_AUTH_MODE : "stdio",
      resourceServer: ENV.TRANSPORT_DRIVER === "http" && (ENV.MCP_AUTH_MODE === "jwt" || ENV.MCP_AUTH_MODE === "oidc_jwks"),
      scopes: [...new Set(tools.flatMap(tool => tool.requiredScopes || []))].sort(),
    },
    tools: tools.map(toolCard).sort((a, b) => a.name.localeCompare(b.name)),
    _meta: {
      privacy: {
        storesState: ENV.STORAGE_DRIVER !== "memory",
        encryptedAtRest: Boolean(ENV.MCP_ENCRYPTION_KEY),
      },
      security: {
        // MISS-4/I-4.3: only expose non-sensitive capability signals.
        // safeMode, pluginIsolationMode, pluginAutoDiscovery, patternDebt, stateStore
        // and telemetry driver are removed — they provide attacker reconnaissance.
        toolCount: tools.length,
      },
    },
  };
}
