import { describe, expect, test } from "vitest";
import { endSpan, startSpan } from "../telemetry/otel.js";

describe("OTel telemetry", () => {
  test("startSpan honors parent trace context and creates a new span id", async () => {
    const span = startSpan("tools/call lookup", {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "mcp.method.name": "tools/call",
    });

    expect(span.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span.parentSpanId).toBe("00f067aa0ba902b7");
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);

    const meta = await endSpan(span);
    expect(meta.trace_id).toBe(span.traceId);
    expect(meta.span_id).toBe(span.spanId);
  });
});
