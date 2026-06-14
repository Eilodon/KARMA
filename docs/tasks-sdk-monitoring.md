# MCP Tasks SDK monitoring note

SUPER-MCP intentionally keeps the custom adapter in `src/mcp/adapter` until the TypeScript SDK exposes a stable public Tasks API that matches the current conformance behavior.

## Current state

- Custom adapter isolates private SDK hooks in `src/mcp/adapter`.
- `tasks/get` is supported.
- `tasks/update` is supported.
- `tasks/cancel` is supported.
- `input_required`, `inputRequests`, and `inputResponses` are supported.
- There is no `check_task_status` endpoint.
- There is no `isAsync` compatibility flag.
- There is no bespoke polling endpoint.

## Do not migrate until the SDK has public stable API support for

- `tasks/get`.
- `tasks/update`.
- `tasks/cancel`.
- Native task return shape from a tool call.
- Canonical client capabilities field.
- Conformance behavior compatible with the current HTTP tests.

## Removal trigger

The custom adapter can be removed only when all of these are true:

- MCP TypeScript SDK exposes a stable public Tasks API.
- Current conformance suite passes against the public API.
- No private `_requestHandlers` access is needed.
- No private `_createRegisteredTool` access is needed.
- Client capability semantics are stable.
- No regression in the `input_required` resume flow.
