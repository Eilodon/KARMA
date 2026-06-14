import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("HolySeed-inspired hardening patterns", () => {
  test("registrar sanitizes args before confidence, idempotency, and execution", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");
    expect(source).toContain("sanitizeJsonValue(args)");
    expect(source).toContain("validateConfidence(tool, cleanArgs)");
    expect(source).toContain("generateKey(tenantId, tool.name, cleanArgs, owner)");
    expect(source).toContain("executeTool(tool, cleanArgs");
  });

  test("registrar scans handler output before truncation and commit", async () => {
    const source = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");
    expect(source.indexOf("scanToolOutput(rawResult)")).toBeLessThan(source.indexOf("sanitizeResult(firewall.result)"));
    expect(source).toContain("output_firewall_redacted");
  });

  test("plugin loader pins a startup manifest hash and registrar enforces stability", async () => {
    const loader = await readFile(new URL("../core/plugin_loader.ts", import.meta.url), "utf-8");
    const registrar = await readFile(new URL("../mcp/adapter/execution_pipeline.ts", import.meta.url), "utf-8");

    expect(loader).toContain("loadedPluginManifestHash");
    expect(loader).toContain("assertPluginManifestStable");
    expect(loader).toContain("Plugin manifest changed after startup");
    expect(registrar).toContain("await assertPluginManifestStable()");
  });

  test("Redis rate limiter persists bounded trauma-style records instead of timestamp ZSETs", async () => {
    const source = await readFile(new URL("../middlewares/rate_limit.ts", import.meta.url), "utf-8");

    expect(source).toContain("ratelimit:trauma");
    expect(source).toContain("severity_ema");
    expect(source).toContain("backoff_ends_at");
    expect(source).toContain("violation_count");
    expect(source).not.toContain("ZADD");
    expect(source).not.toContain("ZCARD");
  });
});
