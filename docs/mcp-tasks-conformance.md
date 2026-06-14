# MCP Tasks conformance target

SUPER-MCP targets MCP 2026-07-28 stateless HTTP behavior with native Tasks as the canonical long-running-work path.

## Wire surface

Supported final-target methods:

- `tools/call` returns a normal tool result for synchronous tools.
- `tools/call` returns `CreateTaskResult` with `resultType: "task"` for long-running tools only when the client declares `io.modelcontextprotocol/tasks` support in `params._meta`.
- `tasks/get` returns task status, input requests, terminal result, error, TTL, and polling metadata.
- `tasks/update` provides `inputResponses` for `input_required` tasks and acknowledges with an empty JSON-RPC result.
- `tasks/cancel` cancels a running task and acknowledges with an empty JSON-RPC result.
- `tasks/list` is intentionally not implemented in the final target.

Task ownership is `tenantId + clientId + userId`. Missing, expired, and unauthorized tasks return the same not-found shape so cross-tenant callers cannot infer existence.

## SDK decision

The current implementation keeps a custom adapter in `src/mcp/adapter` instead of using SDK v2 alpha experimental Tasks directly. This is deliberate:

- the SDK Tasks API is still experimental in the selected alpha;
- the SDK alpha schema table can lag RC methods such as `tasks/update`;
- SUPER-MCP must expose the final target without reintroducing legacy APIs such as `check_task_status` or `isAsync`.

The non-SDK coupling is localized to `mcp_protocol_adapter.ts`, which installs raw final-target handlers and a custom `tools/list` surface. Business logic stays behind `tool_registry.ts`, `execution_pipeline.ts`, and `task_runtime.ts`.

## Conformance tests

`src/__tests__/http_tasks_conformance.test.ts` exercises the HTTP boundary end-to-end:

- `tools/list` advertises actual JSON Schema 2020-12 `inputSchema` and `outputSchema` plus task execution metadata.
- `tools/call` creates a durable task before responding with `CreateTaskResult`.
- polling via `tasks/get` survives a new ephemeral HTTP server connection and returns the terminal structured result.
- `tasks/update` resumes an `input_required` task.
- `tasks/cancel` preserves the client cancel reason.
- expired and cross-tenant reads return the same not-found message.

## Migration trigger

Replace the custom adapter with SDK-native Tasks only when the SDK provides stable, non-experimental support for:

1. stateless 2026-07-28 request metadata in `params._meta`;
2. `tools/call -> CreateTaskResult` creation;
3. `tasks/get`, `tasks/update`, and `tasks/cancel` without `tasks/list` as a required public API;
4. JSON Schema 2020-12 tool schema exposure; and
5. trace context propagation without leaking SDK imports into business logic.

## SDK monitoring addendum

The graduation criteria are mirrored in `docs/tasks-sdk-monitoring.md`. Until those criteria are satisfied, the custom adapter remains the intentional compatibility boundary and must not be replaced by `check_task_status`, `isAsync`, or a bespoke polling endpoint.
