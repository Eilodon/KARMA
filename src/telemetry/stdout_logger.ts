import { ENV } from "../config/env.js";
import type { ITelemetryLogger } from "./interface.js";
import { redact } from "./redaction.js";

function tenantIdFromMeta(meta: Record<string, unknown>): string {
  return typeof meta.tenantId === "string" && meta.tenantId.trim().length > 0
    ? meta.tenantId
    : ENV.MCP_TENANT_ID;
}

/** Cloud/container JSONL telemetry. Do not use with stdio transport. */
export class StdoutLogger implements ITelemetryLogger {
  async log(event: string, meta: Record<string, unknown>): Promise<void> {
    const payload = {
      timestamp: new Date().toISOString(),
      event,
      project_id: ENV.MCP_PROJECT_ID,
      tenant_id: tenantIdFromMeta(meta),
      ...(redact(meta) as Record<string, unknown>)
    };
    console.log(JSON.stringify(payload));
  }
}
