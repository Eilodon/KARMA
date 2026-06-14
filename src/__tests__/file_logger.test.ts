import { describe, expect, test } from "vitest";
import { FileLogger } from "../telemetry/file_logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";

describe("FileLogger", () => {
  test("queues concurrent logs and keeps numbered backups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "super_mcp_"));
    try {
      const logger = new FileLogger({ logDir: dir, maxBytes: 80, maxBackups: 2 });

      await Promise.all([
        logger.log("event-1", { n: 1 }),
        logger.log("event-2", { n: 2 }),
        logger.log("event-3", { n: 3 }),
        logger.log("event-4", { n: 4 }),
        logger.log("event-5", { n: 5 }),
      ]);

      const files = await readdir(dir);
      expect(files).toContain("telemetry.jsonl");
      expect(files.some(f => f === "telemetry.jsonl.1")).toBe(true);
      expect(files.filter(f => f.startsWith("telemetry.jsonl.")).length).toBeLessThanOrEqual(2);

      const allText = await Promise.all(
        files.map(async f => readFile(join(dir, f), "utf-8").catch(() => ""))
      );
      const joined = allText.join("");
      expect(joined).toContain("event-5");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

