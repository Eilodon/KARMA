import { afterEach, describe, expect, test, vi } from "vitest";

describe("output firewall strict PII mode", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  test("redacts email in strict pii mode", async () => {
    vi.resetModules();
    vi.stubEnv("MCP_OUTPUT_FIREWALL_PII_MODE", "strict");
    const { scanToolOutput } = await import("../middlewares/output_firewall.js");

    const scanned = scanToolOutput({
      content: [{ type: "text", text: "email alice@example.com" }],
    });

    expect(scanned.violations).toContain("EMAIL");
    expect(scanned.result.content[0].text).not.toContain("alice@example.com");
  });
});
