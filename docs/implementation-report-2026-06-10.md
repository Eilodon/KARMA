# Implementation report — remaining roadmap hardening

Date: 2026-06-10

## Completed

- Added HTTP Tasks conformance coverage for:
  - `tools/list` JSON Schema 2020-12 surface and task execution metadata;
  - `tools/call -> CreateTaskResult`;
  - `tasks/get` terminal polling across ephemeral HTTP reconnects;
  - `tasks/update` input-required resume;
  - `tasks/cancel` reason preservation;
  - expired task and cross-tenant non-leak behavior.
- Kept Tasks implementation as a custom `src/mcp/adapter` boundary, documented in ADR and `docs/mcp-tasks-conformance.md`, because the selected SDK v2 alpha Tasks surface is still experimental and can lag RC methods.
- Exposed actual JSON Schema 2020-12 `inputSchema` / `outputSchema` through the `tools/list` protocol surface instead of only `_meta`.
- Wrapped JSON Schema 2020-12 schemas as Standard Schema-compatible validators for SDK registration where possible.
- Preserved `structuredContent` through the output firewall so terminal task results remain retrievable.
- Hardened protocol headers: duplicate or comma-valued `Mcp-Method` / `Mcp-Name` are rejected with JSON-RPC `-32602` instead of selecting the first value.
- Updated OTel integration:
  - tool span name is `tools/call <tool>`;
  - `jsonrpc.request.id` comes from the actual JSON-RPC request id when available;
  - `traceparent`, `tracestate`, and `baggage` are extracted through OpenTelemetry propagation;
  - SDK span creation is safe when the async SDK startup completes after `startSpan`;
  - JSONL loggers prefer request-context tenant metadata over the env tenant fallback.
- Tightened plugin isolation:
  - default `MCP_PLUGIN_ISOLATION_MODE=external`;
  - `policy` mode is trusted-only and rejects non-built-ins;
  - external workers run with scrubbed env, timeout, memory cap, process-spawn denial, default network denial, and read-only filesystem mutation guards.
- Removed native task legacy compatibility residues from runtime/store types (`inputRequired`, legacy `input`, `provideInput`).

## Validation

- `npm run typecheck` — pass
- `npm test` — pass, 25 files / 136 tests
- `npm run build` — pass
- `npm run audit` — pass, 0 high vulnerabilities
- `npm run deps:check` — expected non-blocking signal: outdated `@opentelemetry/resources`, `@types/node`, `jose`, and `typescript`

## Remaining intentional boundary

The external plugin runner is now a real process boundary and no longer silently runs third-party plugins in-process, but it is not claimed as a full untrusted-code sandbox until an OS/runtime-level container, microVM, WASM, or equivalent isolation layer enforces filesystem, network, process, environment, CPU, memory, timeout, and artifact-egress boundaries.
