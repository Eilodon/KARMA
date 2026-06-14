import { ENV } from "../config/env.js";
import type { ITelemetryLogger } from "./interface.js";
import { redact } from "./redaction.js";

function tenantIdFromMeta(meta: Record<string, unknown>): string {
  return typeof meta.tenantId === "string" && meta.tenantId.trim().length > 0
    ? meta.tenantId
    : ENV.MCP_TENANT_ID;
}

/** Stderr JSONL telemetry. Safe for stdio MCP because protocol frames use stdout. */
export class StderrLogger implements ITelemetryLogger {
  async log(event: string, meta: Record<string, unknown>): Promise<void> {
    const payload = {
      timestamp: new Date().toISOString(),
      event,
      project_id: ENV.MCP_PROJECT_ID,
      tenant_id: tenantIdFromMeta(meta),
      ...(redact(meta) as Record<string, unknown>)
    };
    console.error(JSON.stringify(payload));
  }
}
