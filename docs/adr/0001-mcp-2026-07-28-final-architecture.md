# ADR 0001: SUPER-MCP targets MCP 2026-07-28 final architecture

## Status

Accepted

## Context

SUPER-MCP previously exposed compatibility behavior around custom async tools, legacy protocol mode, and boilerplate-level lifecycle primitives. The final target is not a cleaner SUPER-MCP legacy async API. The target is a hardened MCP runtime aligned with the MCP 2026-07-28 architecture:

- stateless MCP HTTP server behavior
- RC2026 operation headers
- native MCP Tasks extension for long-running work
- OTel-ready request and task telemetry
- explicit tenant/auth/plugin security boundaries

This codebase has no public backward-compatibility requirement for old SUPER-MCP APIs.

## Decision

SUPER-MCP targets the MCP 2026-07-28 final architecture and does not preserve backward compatibility with legacy SUPER-MCP public APIs.

The final branch treats these as non-public or removed:

- `legacy` and `compat` protocol modes are rejected in the final branch
- `check_task_status` is not a public API
- `isAsync` is not a tool property
- `super_mcp_test_long_task` is test-only and must use native Tasks negotiation
- long-running tools return native `CreateTaskResult` only when the client declares support for `io.modelcontextprotocol/tasks`

Protocol defaults and public behavior:

- `MCP_PROTOCOL_MODE` defaults to `rc2026`
- HTTP requests require `Mcp-Method`
- `tools/call` requires `Mcp-Name`
- header/body mismatches are rejected with JSON-RPC `-32602`
- `server/discover` advertises the capability surface, including Tasks support
- the SDK boundary targets the v2 alpha package split (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`)
- client/server info and capabilities are exposed through `_meta` in `server/discover`; full initialize removal remains tied to upstream protocol/SDK stabilization

Tasks behavior:

- the server advertises `io.modelcontextprotocol/tasks`
- a long-running tool returns a task only when the client declares the extension
- `tasks/get`, `tasks/update`, and `tasks/cancel` are the supported task methods
- `tasks/list` is intentionally not implemented
- task records are durable before a tool call returns a task handle
- production storage must use Redis or another durable backend; memory storage is only for dev/test
- task ownership is keyed by `tenantId + clientId + userId`, with identical not-found behavior for missing and unauthorized tasks

Security posture:

- HTTP production auth is OIDC/OAuth/JWT first
- API keys are development/local only
- HTTP tenant identity comes from verified auth claims or trusted gateway identity headers, not `ENV.MCP_TENANT_ID`
- `ENV.MCP_TENANT_ID` is local/stdio fallback only
- Node `vm` is not a security boundary and must not be used to run untrusted plugins
- untrusted plugins require an external runner, process, container, microVM, or equivalent isolation boundary

## Current implementation status

- Phase 3 SDK v2 target is active behind `src/mcp/adapter/` using the alpha package split and Zod v4 imports.
- `super_mcp_test_long_task` is gated by `MCP_ENABLE_TEST_TOOLS`; it is excluded from the default production load path and `MCP_ENABLE_TEST_TOOLS=true` is rejected under `NODE_ENV=production`.
- Task API payloads use flattened `taskId`, `inputRequests`, and `inputResponses`; `tasks/update` and `tasks/cancel` acknowledge with empty JSON-RPC results.
- JSON Schema validation uses Ajv's JSON Schema 2020-12 runtime after the local anti-abuse guard rejects remote `$ref`, excessive depth, excessive `$defs`, excessive properties, and unbounded strings.
- OTel export is routed through official OpenTelemetry SDK/OTLP packages when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured; JSONL trace/span metadata remains the fallback and span attributes are redacted/cardinality-safe.
- Plugin execution defaults to `MCP_PLUGIN_ISOLATION_MODE=external` for non-built-in plugins. `policy` mode is trusted-only: non-built-in plugins are rejected instead of silently running in-process. The external runner uses a child-process boundary with a scrubbed environment, timeout, memory cap, process-spawn denial, default network denial, and read-only filesystem mutation guards; container/microVM isolation remains the recommended production hardening layer for untrusted third-party code.

## Consequences

Clients using `check_task_status`, `isAsync`, or legacy operation headers must migrate to native MCP methods and Tasks.

SDK v2 alpha usage remains localized behind `src/mcp/adapter/` so package split or alpha API churn stays contained.

CI should keep the baseline of test, typecheck, audit, and dependency update checks.


## Tasks SDK decision

The codebase intentionally keeps a custom Tasks adapter under `src/mcp/adapter` instead of binding business logic directly to the SDK v2 alpha experimental Tasks API. The selected SDK alpha still exposes experimental task helpers and schema tables that can lag the 2026-07-28 RC method surface. SUPER-MCP therefore owns the final-target wire methods (`tools/call` task creation, `tasks/get`, `tasks/update`, `tasks/cancel`, no `tasks/list`) at the adapter boundary and locks the behavior with HTTP conformance tests.

Migration trigger: replace the custom adapter with SDK-native Tasks only when the SDK provides a stable, non-experimental surface for stateless 2026-07-28 Tasks, JSON Schema 2020-12 tool schemas, and per-request `_meta` context propagation without reintroducing legacy SUPER-MCP APIs.
