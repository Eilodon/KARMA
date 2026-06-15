import { z } from "zod/v4";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

/**
 * KARMA Skill-Economy plugin (Layer 1).
 *
 * MUST run in-process as a trusted built-in (see isTrustedBuiltInPlugin / spec D-1).
 * Module-level singletons (keystoreManager, skillIndex) and process.env access (PHAROS_*,
 * KEYSTORE_*) only survive in-process — the external child-process worker forks per call
 * and strips env via workerEnv(). `assertInProcess()` is the fail-fast canary for that.
 */
function assertInProcess(): void {
  if (process.env.KARMA_PLUGIN_WORKER === "1") {
    throw new Error(
      "[KARMA] karma.tool.ts must run in-process (trusted built-in), not the external worker. " +
        "Set MCP_PLUGIN_ISOLATION_MODE=policy and keep karma.tool in isTrustedBuiltInPlugin().",
    );
  }
}

const tools: ToolDefinition[] = [
  {
    name: "karma_health",
    description:
      "Report KARMA plugin runtime: in-process mode and presence of Pharos RPC configuration. " +
      "Canary that a network-capability tool loads under MCP_SAFE_MODE=false + in-process isolation.",
    inputSchema: {
      ping: z.string().optional().describe("Optional echo string."),
    },
    capabilities: ["network"],
    allowedPhases: ["intake", "execution", "review", "completed"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const ping = (args as { ping?: string }).ping;
      const hasRpcEnv = Boolean(process.env.PHAROS_RPC_URL);
      const hasContractEnv = Boolean(process.env.PHAROS_CONTRACT_ADDRESS);
      return {
        content: [
          {
            type: "text",
            text:
              `[KARMA] health: in-process=true rpcEnv=${hasRpcEnv} contractEnv=${hasContractEnv}` +
              (ping ? ` ping=${ping}` : ""),
          },
        ],
        structuredContent: { inProcess: true, hasRpcEnv, hasContractEnv },
      };
    },
  },
];

export default tools;
