import { z } from "zod/v4";
import { ENV } from "../config/env.js";
import { getPatternDebtItems, PATTERN_DEBT_IDS } from "../core/pattern_debt.js";
import type { PatternDebtId } from "../core/pattern_debt.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Task aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Task aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const systemTools: ToolDefinition[] = [
  {
    name: "karma_pattern_debt",
    description: "Read-only report of documented pattern-debt items, implementation gates, and runtime guards.",
    inputSchema: {
      debt_id: z.enum(PATTERN_DEBT_IDS).optional().describe("Optional pattern-debt id to inspect."),
      include_implemented: z.boolean().optional().describe("Include implemented/closed debt items in the report."),
    },
    allowedPhases: ["intake", "execution", "review", "completed"],
    capabilities: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: {
      taskSupport: "forbidden",
    },
    handler: async (args) => {
      const input = args as { debt_id?: PatternDebtId; include_implemented?: boolean };
      const items = getPatternDebtItems({
        id: input.debt_id,
        includeImplemented: Boolean(input.include_implemented),
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            generatedBy: "karma_pattern_debt",
            guidance: "Documented debt only. Do not implement partial security boundaries without satisfying implementationGate.",
            items,
          }, null, 2),
        }],
      };
    },
  },
  {
    name: "karma_ping",
    description: "Ping server to check status and pipeline middlewares.",
    inputSchema: {
      message: z.string().optional().describe("Ping message"),
    },
    allowedPhases: ["intake", "execution", "review", "completed"],
    capabilities: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: {
      taskSupport: "forbidden",
    },
    handler: async (args, state) => {
      const msg = (args as { message?: string }).message || "Pong!";
      return {
        content: [
          { type: "text", text: `[KARMA] ${msg}` },
          { type: "text", text: `Current Phase: ${state.phase}` },
          { type: "text", text: `State Revision: ${state.revision}` },
          { type: "text", text: `Environment: ${ENV.STORAGE_DRIVER} / ${ENV.TELEMETRY_DRIVER}` }
        ],
      };
    },
  },
  {
    name: "karma_test_long_task",
    description: "Test-only long-running tool for validating native MCP Tasks negotiation.",
    inputSchema: {
      duration: z.number().min(0).max(300).optional().describe("Simulated execution time (seconds, max 300)"),
    },
    allowedPhases: ["intake", "execution", "review", "completed"],
    capabilities: [],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execution: {
      taskSupport: "required",
    },
    handler: async (args, state, signal) => {
      const seconds = Math.min(Math.max(Number((args as { duration?: unknown }).duration ?? 5), 0), 300);
      const ms = seconds * 1000;
      await abortableSleep(ms, signal);
      return {
        content: [{ type: "text", text: `[KARMA] Task successfully completed in ${ms}ms!` }]
      };
    }
  }
];

export default systemTools.filter(tool => (
  ENV.MCP_ENABLE_TEST_TOOLS || tool.name !== "karma_test_long_task"
));
