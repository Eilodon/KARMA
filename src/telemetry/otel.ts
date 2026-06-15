import { createHash, randomBytes } from "node:crypto";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ENV } from "../config/env.js";
import { redact } from "./redaction.js";

export interface OtelSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, unknown>;
  parentContext: Context;
  sdkSpan?: Span;
}

let sdkStart: Promise<void> | undefined;
let sdkAvailable = false;

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function hashAttribute(value: unknown): string {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function normalizeAttribute(key: string, value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;

  // Avoid high-cardinality/raw identity in OTel backends while keeping values
  // joinable across logs/traces.
  if (/^(tenantId|userId|clientId|tenant\.id|user\.id|client\.id)$/i.test(key)) {
    return hashAttribute(value);
  }

  const redacted = redact(value);
  if (typeof redacted === "string" || typeof redacted === "number" || typeof redacted === "boolean") {
    return redacted;
  }
  return String(redacted);
}

function cleanAttributes(attributes: Record<string, unknown>): Record<string, string | number | boolean> {
  const cleaned: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const normalized = normalizeAttribute(key, value);
    if (normalized !== undefined) cleaned[key] = normalized;
  }
  return cleaned;
}

function endpointUrl(): string | undefined {
  const endpoint = ENV.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;
  return endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint.replace(/\/$/, "")}/v1/traces`;
}

async function ensureOtelSdk(): Promise<void> {
  const url = endpointUrl();
  if (!url) return;
  if (sdkStart) return sdkStart;

  sdkStart = (async () => {
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url }),
    });
    process.env.OTEL_SERVICE_NAME ||= ENV.OTEL_SERVICE_NAME;
    await Promise.resolve(sdk.start());
    sdkAvailable = true;
  })().catch(error => {
    sdkAvailable = false;
    console.error("[KARMA] Official OpenTelemetry SDK unavailable; trace metadata will remain JSONL-only:", error);
  });

  return sdkStart;
}

function parseTraceparent(traceparent: unknown): { traceId?: string; parentSpanId?: string } {
  if (typeof traceparent !== "string") return {};
  const match = traceparent.match(/^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i);
  return { traceId: match?.[1], parentSpanId: match?.[2] };
}

function parentContextFromAttributes(attributes: Record<string, unknown>): { parentContext: Context; traceId?: string; parentSpanId?: string } {
  const carrier: Record<string, string> = {};
  for (const key of ["traceparent", "tracestate", "baggage"] as const) {
    const value = attributes[key];
    if (typeof value === "string") carrier[key] = value;
  }

  const extracted = propagation.extract(ROOT_CONTEXT, carrier);
  const extractedSpanContext = trace.getSpanContext(extracted);
  if (extractedSpanContext) {
    return {
      parentContext: extracted,
      traceId: extractedSpanContext.traceId,
      parentSpanId: extractedSpanContext.spanId,
    };
  }

  const parsed = parseTraceparent(attributes.traceparent);
  if (parsed.traceId && parsed.parentSpanId) {
    return {
      parentContext: trace.setSpanContext(ROOT_CONTEXT, {
        traceId: parsed.traceId,
        spanId: parsed.parentSpanId,
        traceFlags: 1,
        isRemote: true,
      }),
      traceId: parsed.traceId,
      parentSpanId: parsed.parentSpanId,
    };
  }

  return { parentContext: context.active() };
}

function maybeCreateSdkSpan(span: OtelSpan): void {
  if (!sdkAvailable || span.sdkSpan) return;
  const tracer = trace.getTracer("karma-runtime");
  span.sdkSpan = tracer.startSpan(
    span.name,
    {
      kind: SpanKind.SERVER,
      attributes: cleanAttributes(span.attributes),
    },
    span.parentContext,
  );
  const spanContext = span.sdkSpan.spanContext();
  span.traceId = spanContext.traceId;
  span.spanId = spanContext.spanId;
}

export function startSpan(name: string, attributes: Record<string, unknown> = {}): OtelSpan {
  const parent = parentContextFromAttributes(attributes);
  const traceId = typeof attributes.trace_id === "string" && /^[0-9a-f]{32}$/i.test(attributes.trace_id)
    ? attributes.trace_id
    : parent.traceId || hex(16);
  const parentSpanId = typeof attributes.span_id === "string" && /^[0-9a-f]{16}$/i.test(attributes.span_id)
    ? attributes.span_id
    : parent.parentSpanId;
  const spanId = hex(8);
  const span: OtelSpan = { name, traceId, parentSpanId, spanId, attributes, parentContext: parent.parentContext };

  if (endpointUrl()) {
    void ensureOtelSdk().then(() => maybeCreateSdkSpan(span)).catch(() => undefined);
  }

  return span;
}

export function addSpanEvent(span: OtelSpan, name: string, attributes: Record<string, unknown> = {}): void {
  maybeCreateSdkSpan(span);
  span.sdkSpan?.addEvent(name, cleanAttributes(attributes));
}

export async function endSpan(span: OtelSpan, status: "OK" | "ERROR" = "OK", extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  await ensureOtelSdk();
  maybeCreateSdkSpan(span);
  if (span.sdkSpan) {
    span.sdkSpan.setAttributes(cleanAttributes(extra));
    span.sdkSpan.setStatus({ code: status === "OK" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.sdkSpan.end();
  }
  return {
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
  };
}
