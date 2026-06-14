import { describe, expect, test } from "vitest";
import { getPatternDebtItems, getPatternDebtSummary } from "../core/pattern_debt.js";
import systemTools from "../plugins/system.tool.js";

describe("pattern debt registry reconciliation", () => {
  test("keeps implemented controls and remaining debt accurately documented", () => {
    const items = getPatternDebtItems({ includeImplemented: true });
    const byId = new Map(items.map(item => [item.id, item]));

    expect(byId.get("DEBT-001")?.status).toBe("open");
    expect(byId.get("DEBT-001")?.implementationGate).toContain("Do not implement an in-process pseudo-sandbox");
    expect(byId.get("DEBT-001")?.currentControl).not.toContain("full sandbox");
    expect(byId.get("DEBT-001")?.runtimeGuards.join("\n")).toContain("without PATH");
    expect(byId.get("DEBT-001")?.runtimeGuards.join("\n")).toContain("node-permission-best-effort");

    expect(byId.get("DEBT-002")?.status).toBe("open");
    expect(byId.get("DEBT-002")?.currentControl).toContain("type-only ITenantKeyRegistry");
    expect(byId.get("DEBT-002")?.limitation).toContain("No v3 runtime encryption path");
    expect(byId.get("DEBT-002")?.currentControl).not.toContain("crypto-erasure is implemented");

    expect(byId.get("DEBT-003")?.status).toBe("monitoring");
    expect(byId.get("DEBT-003")?.implementationGate).toContain("Do not reintroduce check_task_status or isAsync");
    expect(byId.get("DEBT-003")?.runtimeGuards.join("\n")).toContain("No bespoke polling endpoint");

    expect(byId.get("DEBT-004")?.status).toBe("implemented");
    expect(byId.get("DEBT-004")?.currentControl).toContain("enforce MCP_RESOURCE_URI");
    expect(byId.get("DEBT-004")?.limitation).not.toContain("resource indicator enforcement");
    expect(byId.get("DEBT-004")?.currentControl).not.toContain("TokenManager");

    expect(byId.get("DEBT-005")?.status).toBe("partially_resolved");
    expect(byId.get("DEBT-005")?.currentControl).toContain("structuredContent");
    expect(byId.get("DEBT-005")?.runtimeGuards).toContain("structuredContent recursive redaction preserves object/array shape and does not mutate input.");
    expect(byId.get("DEBT-005")?.implementationGate).toContain("fake DLP");
  });

  test("summary exposes active debt without hiding resolved items from counts", () => {
    const summary = getPatternDebtSummary();

    expect(summary.activeIds).toContain("DEBT-001");
    expect(summary.activeIds).toContain("DEBT-002");
    expect(summary.activeIds).toContain("DEBT-003");
    expect(summary.activeIds).toContain("DEBT-005");
    expect(summary.activeIds).not.toContain("DEBT-004");
    expect(summary.activeIds).not.toContain("DEBT-006");
    expect(summary.implemented).toBe(2);
  });

  test("registers a read-only system tool for operational debt visibility", async () => {
    const tool = systemTools.find(entry => entry.name === "super_mcp_pattern_debt");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.execution?.taskSupport).toBe("forbidden");

    const result = await tool!.handler({ debt_id: "DEBT-005" }, { phase: "intake", revision: 1, payload: {} } as any);
    const body = JSON.parse(result.content[0].text);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("DEBT-005");
    expect(body.items[0].currentControl).toContain("structuredContent");
    expect(body.guidance).toContain("Documented debt only");
  });
});
