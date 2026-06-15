import { appendFile, rename, stat, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import * as os from "node:os";
import { ENV } from "../config/env.js";
import type { ITelemetryLogger } from "./interface.js";
import { redact } from "./redaction.js";

function tenantIdFromMeta(meta: Record<string, unknown>): string {
  return typeof meta.tenantId === "string" && meta.tenantId.trim().length > 0
    ? meta.tenantId
    : ENV.MCP_TENANT_ID;
}

export class FileLogger implements ITelemetryLogger {
  private logDir: string;
  private logFile: string;
  private maxBytes: number;
  private maxBackups: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: { logDir?: string; maxBytes?: number; maxBackups?: number } = {}) {
    this.logDir = options.logDir || join(os.homedir(), ".karma", "logs");
    this.logFile = join(this.logDir, "telemetry.jsonl");
    this.maxBytes = options.maxBytes || ENV.MCP_TELEMETRY_MAX_BYTES;
    this.maxBackups = options.maxBackups || ENV.MCP_TELEMETRY_MAX_BACKUPS;
  }

  log(event: string, meta: Record<string, unknown>): Promise<void> {
    this.queue = this.queue.then(() => this.writeLog(event, meta));
    this.queue = this.queue.catch(err => {
      console.error("[KARMA] File logger failed:", err);
    });
    return this.queue;
  }

  private async rotateIfNeeded(): Promise<void> {
    const s = await stat(this.logFile).catch(() => null);
    if (!s || s.size < this.maxBytes) return;

    for (let i = this.maxBackups - 1; i >= 1; i -= 1) {
      await rename(`${this.logFile}.${i}`, `${this.logFile}.${i + 1}`).catch(() => undefined);
    }
    await rename(this.logFile, `${this.logFile}.1`).catch(() => undefined);
  }

  private async writeLog(event: string, meta: Record<string, unknown>): Promise<void> {
    await mkdir(this.logDir, { recursive: true, mode: 0o700 });
    await chmod(this.logDir, 0o700).catch(() => undefined);
    
    await this.rotateIfNeeded();

    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      project_id: ENV.MCP_PROJECT_ID,
      tenant_id: tenantIdFromMeta(meta),
      ...(redact(meta) as Record<string, unknown>)
    }) + "\n";
    
    await appendFile(this.logFile, payload, { encoding: "utf-8", mode: 0o600 });
    await chmod(this.logFile, 0o600).catch(() => undefined);
  }
}
