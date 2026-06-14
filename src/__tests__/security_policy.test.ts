import { describe, expect, test } from "vitest";
import { evaluateToolPolicy } from "../security/policy.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "risky",
    description: "risky",
    inputSchema: {},
    allowedPhases: ["intake"],
    capabilities: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: { taskSupport: "forbidden" },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  };
}

describe("lethal-trifecta tool policy", () => {
  test("rejects private data + untrusted content + external communication without waiver", () => {
    const decision = evaluateToolPolicy(tool({
      capabilities: ["secrets.read", "network"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("lethal-trifecta");
  });

  test("allows explicit waiver with concrete reason", () => {
    const decision = evaluateToolPolicy(tool({
      capabilities: ["secrets.read", "network"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      securityPolicy: {
        allowLethalTrifecta: true,
        waiverReason: "Approved internal connector with egress allowlist and audited destination.",
      },
    }));
    expect(decision.allowed).toBe(true);
  });
});
