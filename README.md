# SUPER-MCP

**SUPER-MCP** is a hardened TypeScript / ESM boilerplate for building production-oriented [Model Context Protocol](https://modelcontextprotocol.io/) servers. It provides stdio and stateless HTTP transports, native Tasks-style long-running execution, durable storage, authentication, request governance, output redaction, plugin loading controls, and explicit runtime debt reporting.

This README reflects the current patched codebase in this package.

> Package: `super-mcp-boilerplate`  
> Runtime entrypoint: `dist/index.js`  
> Default transport: `stdio`  
> Default protocol mode: `rc2026` only  
> Default storage: local filesystem (`fs`)  
> Default plugin isolation mode: external child-process best-effort runner for non-built-in plugins  
> Production storage requirement: Redis  
> Production HTTP auth requirement: JWT or OIDC JWKS, not API key

SUPER-MCP intentionally does **not** claim to provide a true security sandbox for untrusted plugins or a completed crypto-erasure runtime. Those are tracked as release-blocking epics until implemented with real container/microVM/WASM and KMS-backed primitives.

---

## Table of contents

1. [Current status](#current-status)
2. [What SUPER-MCP provides](#what-super-mcp-provides)
3. [Architecture](#architecture)
4. [Repository layout](#repository-layout)
5. [Requirements](#requirements)
6. [Install and validation](#install-and-validation)
7. [Quick start: stdio](#quick-start-stdio)
8. [Quick start: local HTTP](#quick-start-local-http)
9. [Production HTTP configuration](#production-http-configuration)
10. [MCP protocol behavior](#mcp-protocol-behavior)
11. [Authentication and request context](#authentication-and-request-context)
12. [Native Tasks](#native-tasks)
13. [Tool execution pipeline](#tool-execution-pipeline)
14. [Storage and encryption](#storage-and-encryption)
15. [Rate limit, quota, idempotency, and locks](#rate-limit-quota-idempotency-and-locks)
16. [Output firewall](#output-firewall)
17. [Plugin system](#plugin-system)
18. [Writing plugins](#writing-plugins)
19. [HTTP endpoints and headers](#http-endpoints-and-headers)
20. [Docker / Compose](#docker--compose)
21. [Configuration reference](#configuration-reference)
22. [Testing and quality gates](#testing-and-quality-gates)
23. [Pattern debt and limitations](#pattern-debt-and-limitations)
24. [Troubleshooting](#troubleshooting)
25. [License](#license)

---

## Current status

The current package includes the enterprise-gate patches and expanded test coverage added during remediation:

- `tasks/update` is state-gated and nonce-bound.
- Task input can be consumed only once and only while the task is `input_required` to prevent PII/secret persistence at rest.
- Stale, duplicate, early, and wrong-owner task input updates are rejected.
- Production HTTP + JWT requires issuer, audience, and resource indicator.
- Production HTTP + OIDC JWKS requires JWKS URI, issuer, audience, and resource indicator.
- Production HTTP requires rate limit and quota unless `MCP_ALLOW_UNLIMITED_HTTP=true` is explicitly set.
- Production non-built-in plugins fail closed unless `MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true` is explicitly waived, and require SHA-256 pinning + Node Permission model.
- `MCP_IDEMPOTENCY_SECRET` is required when `STORAGE_DRIVER=redis` to enforce HMAC-SHA256 idempotency keys instead of plain SHA256.
- Identity gateway headers properly map to `gateway` auth type, enforcing scopes instead of bypassing them.
- `LocalEnvVault` forces per-tenant namespace isolation for environmental variables.
- Data at rest is encrypted with the `smcp:v3:hkdf-tenant` envelope to prevent cross-tenant data substitution.
- `smcp:v4:kms` KMS-backed per-tenant DEK crypto-erasure is now implemented (2026-06-14). Four providers: `LocalKeyRegistry` (dev/test only), `VaultKeyRegistry`, `AwsKmsKeyRegistry`, and `GcpKmsKeyRegistry`. `MCP_REQUIRE_CRYPTO_ERASURE=true` requires `KMS_PROVIDER=vault|aws-kms|gcp-kms`; it fails closed only when a real provider is not configured.
- Fully migrated to the v2.0 Modular SDK architecture (`@modelcontextprotocol/server`, `node`, `express`), intrinsically eliminating legacy 1.x vulnerabilities like CVE-2026-0621 (UriTemplate ReDoS).
- Enterprise regression tests are available through `pnpm test:enterprise`.
- Plugin child-process tests are split into focused scripts to reduce flakiness and make failures easier to isolate.

Known residual gaps are documented in `docs/pattern-debt-registry.yaml` and exposed by the `super_mcp_pattern_debt` tool.

---

## What SUPER-MCP provides

Core runtime capabilities:

- MCP `stdio` transport for local clients.
- Stateless HTTP MCP transport at `/mcp`.
- Final local protocol target `rc2026`; legacy/compat modes are rejected by env validation.
- `server/discover`, `tools/list`, `tools/call`, `tasks/get`, `tasks/update`, and `tasks/cancel` handlers through a local SDK adapter boundary.
- Native Tasks-style long-running execution with durable task records.
- Local filesystem, Redis, and memory storage drivers.
- State/vault encryption-at-rest: `smcp:v4:kms` KMS-backed per-tenant DEK (primary, when `KMS_PROVIDER` is set); `smcp:v3:hkdf-tenant` per-tenant HKDF envelope (primary when no KMS); `smcp:v2:scrypt` fallback for global configs without `tenantId`.
- API key auth for local/dev HTTP.
- JWT shared-secret auth for symmetric deployments.
- OIDC JWKS auth for remote IdP deployments.
- OAuth Resource Server metadata and resource-indicator enforcement.
- Request context with tenant, user, client, scopes, request ID, and auth type.
- Tool scope enforcement for JWT/OIDC contexts.
- Rate limiting, quota checks, idempotency, tenant execution locks, JSON schema validation, timeout handling, output firewall, and telemetry around tool calls.
- Plugin governance with allowlists, SHA-256 hash pinning (required in production for non-built-in plugins), manifest pinning, safe mode, capability declarations, and external plugin runner.
- Runtime pattern-debt reporting through the built-in `super_mcp_pattern_debt` tool and server-card metadata.
- File/stdout/stderr JSONL telemetry and optional OpenTelemetry OTLP export with native W3C TraceContext propagation via `_meta` (`traceparent`, `tracestate`, `baggage`).

Explicit non-claims:

- The external Node child-process plugin runner is **best-effort hardening**, not a true OS/container/microVM sandbox.
- Node Permission Model support is optional and also best-effort.
- KMS-backed crypto-erasure is implemented via the `smcp:v4:kms` envelope and four providers (Local/Vault/AWS KMS/GCP KMS). AWS KMS has a mandatory 7-day pending-deletion window; immediate erasure is via `DisableKey` only. Run `migrate_encryption.ts` once per tenant to re-encrypt pre-V4 blobs before offering erasure SLA.
- SUPER-MCP is an OAuth Resource Server; it does not implement client-side PKCE or TokenManager flows.

---

## Architecture

```text
Client
  | stdio or HTTP /mcp
  v
Transport layer
  |-- stdio: MCP StdioServerTransport
  |-- HTTP: Express + stateless StreamableHTTPServerTransport
  v
HTTP safety layer, only in HTTP mode
  |-- Host allowlist
  |-- CORS allowlist
  |-- JSON content type and body-size checks
  |-- API key / JWT / OIDC JWKS auth
  |-- Resource indicator enforcement when MCP_RESOURCE_URI is configured
  |-- RequestContext resolution
  |-- rc2026 Mcp-Method / Mcp-Name header checks
  v
Protocol adapter
  |-- server/discover
  |-- tools/list
  |-- tools/call
  |-- tasks/get
  |-- tasks/update
  |-- tasks/cancel
  v
Execution pipeline
  |-- Plugin manifest stability check
  |-- Rate limit and quota
  |-- Required scope check
  |-- Confidence / elicitation guard
  |-- Idempotency acquire / cache
  |-- Tenant execution lock
  |-- JSON Schema 2020-12 input and output validation
  |-- Timeout / abort handling
  |-- Output firewall
  |-- State persistence
  |-- Telemetry and optional OTEL spans
  v
Storage / telemetry
  |-- memory / local filesystem / Redis
  |-- plain JSON, smcp:v3:hkdf-tenant (per-tenant, default), or smcp:v2:scrypt (fallback)
  |-- file / stdout / stderr / OTLP
```

---

## Repository layout

```text
.
├── Containerfile
├── compose.yaml
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── docs/
│   ├── adr/
│   │   ├── 0001-mcp-2026-07-28-final-architecture.md
│   │   └── 0002-tenant-crypto-erasure-v3.md
│   ├── superpowers/
│   │   ├── adrs/2026-06-14-debt-002-kms-crypto-erasure.md
│   │   └── plans/2026-06-13-debt-002-kms-crypto-erasure.md
│   ├── mcp-tasks-conformance.md
│   ├── pattern-debt-registry.yaml
│   ├── phase5-pattern-debt.md
│   ├── tasks-sdk-monitoring.md
│   └── test-coverage-matrix.md
└── src/
    ├── index.ts
    ├── config/env.ts
    ├── core/
    │   ├── pattern_debt.ts
    │   ├── plugin_external_runner.ts
    │   ├── plugin_loader.ts
    │   ├── plugin_runner.ts
    │   ├── plugin_worker.ts
    │   ├── registrar.ts
    │   ├── runtime.ts
    │   ├── task_store.ts
    │   └── task_tracker.ts
    ├── http/
    │   ├── oauth_metadata.ts
    │   ├── security.ts
    │   └── server_card.ts
    ├── mcp/adapter/
    │   ├── execution_pipeline.ts
    │   ├── mcp_protocol_adapter.ts
    │   ├── schema_guard.ts
    │   ├── task_runtime.ts
    │   └── tool_registry.ts
    ├── middlewares/
    │   ├── execution_lock.ts
    │   ├── guardrails.ts
    │   ├── idempotency.ts
    │   ├── output_firewall.ts
    │   ├── protocol_header.ts
    │   ├── quota.ts
    │   ├── rate_limit.ts
    │   └── vault.ts
    ├── plugins/system.tool.ts
    ├── scripts/
    │   └── migrate_encryption.ts
    ├── security/
    │   ├── auth.ts
    │   ├── context.ts
    │   ├── policy.ts
    │   └── sanitize.ts
    ├── storage/
    │   ├── audit_store.ts
    │   ├── caching_key_registry.ts
    │   ├── encryption.ts
    │   ├── factory.ts
    │   ├── interface.ts
    │   ├── key_registry.ts
    │   ├── key_registry_factory.ts
    │   ├── local_fs.ts
    │   ├── memory.ts
    │   ├── providers/
    │   │   ├── aws_kms_key_registry.ts
    │   │   ├── gcp_kms_key_registry.ts
    │   │   ├── local_key_registry.ts
    │   │   └── vault_key_registry.ts
    │   ├── redis.ts
    │   └── redis_client.ts
    ├── telemetry/
    │   ├── factory.ts
    │   ├── file_logger.ts
    │   ├── interface.ts
    │   ├── otel.ts
    │   ├── redaction.ts
    │   ├── stderr_logger.ts
    │   └── stdout_logger.ts
    ├── types/
    │   └── schemas.ts
    └── __tests__/
```

Important implementation files:

| File | Purpose |
| --- | --- |
| `src/index.ts` | Server startup, HTTP/stdio transport selection, HTTP routes, auth integration, graceful shutdown. |
| `src/config/env.ts` | Environment schema, defaults, fail-fast production gates. |
| `src/security/auth.ts` | API key, JWT, OIDC JWKS verification, resource indicator checks. |
| `src/security/context.ts` | Tenant/user/client/scope/request context resolution and sanitization. |
| `src/security/policy.ts` | Safe-mode capability policy and security metadata enforcement. |
| `src/security/sanitize.ts` | Input sanitization utilities for context fields. |
| `src/mcp/adapter/mcp_protocol_adapter.ts` | Raw/custom MCP handlers and rc2026 protocol adapter. |
| `src/mcp/adapter/execution_pipeline.ts` | Tool call governance, native task execution, state save, telemetry. |
| `src/core/task_store.ts` | Durable task store with local/memory/Redis implementations and atomic input consume. |
| `src/core/registrar.ts` | Plugin and tool registration bookkeeping. |
| `src/core/plugin_loader.ts` | Plugin discovery, allowlist, safe mode, manifest/hash governance. |
| `src/core/plugin_external_runner.ts` | Parent-side external plugin child-process runner. |
| `src/core/plugin_worker.ts` | Child-side JS-level worker guards. |
| `src/middlewares/output_firewall.ts` | Text and structured-content redaction. |
| `src/storage/encryption.ts` | Encryption-at-rest service: `smcp:v4:kms` KMS DEK (primary with KMS_PROVIDER), `smcp:v3:hkdf-tenant` per-tenant HKDF, and `smcp:v2:scrypt` fallback. |
| `src/storage/key_registry.ts` | `ITenantKeyRegistry` interface and `SealedBlob`/`CryptoErasureReceipt` types. |
| `src/storage/key_registry_factory.ts` | Runtime KMS provider selection and `CachingKeyRegistry` wiring. |
| `src/storage/caching_key_registry.ts` | Bounded in-memory DEK cache (TTL + use-count) with zeroed-on-eviction and durable receipt persistence. |
| `src/storage/audit_store.ts` | `FileAuditStore` — JSONL-append erasure receipts at `~/.super_mcp/audit/<projectId>/`. |
| `src/storage/providers/local_key_registry.ts` | Dev/test-only in-process key registry. |
| `src/storage/providers/vault_key_registry.ts` | HashiCorp Vault Transit key registry (immediate erasure). |
| `src/storage/providers/aws_kms_key_registry.ts` | AWS KMS key registry (DisableKey immediate + ScheduleKeyDeletion 7-day proof). |
| `src/storage/providers/gcp_kms_key_registry.ts` | GCP Cloud KMS key registry (DESTROY_SCHEDULED immediate, 24 h permanent deletion). |
| `src/scripts/migrate_encryption.ts` | Re-encrypts all pre-V4 blobs (legacy/V2/V3 → V4 KMS) when `KMS_PROVIDER` is set. |
| `src/core/pattern_debt.ts` | Runtime-readable pattern debt registry. |

---

## Requirements

Recommended local runtime:

- Node.js 20+.
- npm with `package-lock.json`, or pnpm 9.15.9 with `pnpm-lock.yaml`.
- Redis **8.2.2+** when `STORAGE_DRIVER=redis`. CVE-2025-49844 (Lua GC Use-After-Free, CVSS 10.0) affects Redis ≤ 8.2.1. This codebase uses Redis Lua scripts for critical task, idempotency, and state paths — running an unpatched Redis version exposes those paths to memory corruption.
- A JWKS endpoint if using `MCP_AUTH_MODE=oidc_jwks`.

The `Containerfile` uses Node 20 Alpine and pnpm 9.15.9 in the builder stage.

---

## Install and validation

Using pnpm:

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test:enterprise
npm audit --audit-level=high
```

Development server:

```bash
pnpm dev
```

Production build and start:

```bash
pnpm build
pnpm start
```

The codebase enforces code quality via ESLint and Vitest.

---

## Quick start: stdio

`stdio` is the default transport and is suitable for local MCP clients that launch the server as a subprocess.

Minimal local `.env`:

```env
TRANSPORT_DRIVER=stdio
STORAGE_DRIVER=fs
MCP_SAFE_MODE=true
MCP_PLUGIN_ALLOWLIST=system.tool.ts
MCP_PLUGIN_ISOLATION_MODE=external
```

Build and run:

```bash
pnpm build
pnpm start
```

Example client config:

```json
{
  "mcpServers": {
    "super-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/SUPER-MCP/dist/index.js"],
      "env": {
        "TRANSPORT_DRIVER": "stdio",
        "STORAGE_DRIVER": "fs",
        "MCP_SAFE_MODE": "true"
      }
    }
  }
}
```

In stdio mode, telemetry defaults to `stderr` so stdout stays reserved for MCP protocol frames. `TELEMETRY_DRIVER=stdout` is rejected with `TRANSPORT_DRIVER=stdio`.

---

## Quick start: local HTTP

HTTP mode exposes stateless MCP at `/mcp`, plus health and metadata endpoints.

Local/dev HTTP with API key auth:

```env
NODE_ENV=development
TRANSPORT_DRIVER=http
HTTP_HOST=127.0.0.1
HTTP_PORT=3333
STORAGE_DRIVER=memory
TELEMETRY_DRIVER=stderr

MCP_AUTH_MODE=api_key
MCP_API_KEY=change-this-to-a-random-string-with-at-least-32-chars

ALLOWED_HOSTS=127.0.0.1:3333,localhost:3333
ALLOWED_ORIGINS=http://localhost:3333
MCP_SAFE_MODE=true
```

Start:

```bash
pnpm build
pnpm start
```

Health checks:

```bash
curl http://127.0.0.1:3333/health/liveness
curl http://127.0.0.1:3333/health/readiness
```

Discover metadata:

```bash
curl http://127.0.0.1:3333/.well-known/mcp.json
curl http://127.0.0.1:3333/.well-known/mcp-server-card
curl http://127.0.0.1:3333/.well-known/oauth-protected-resource
```

Example `server/discover` request:

```bash
curl -sS http://127.0.0.1:3333/mcp \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: change-this-to-a-random-string-with-at-least-32-chars' \
  -H 'Mcp-Method: server/discover' \
  --data '{"jsonrpc":"2.0","id":"1","method":"server/discover","params":{}}'
```

Example `tools/call` request:

```bash
curl -sS http://127.0.0.1:3333/mcp \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: change-this-to-a-random-string-with-at-least-32-chars' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: super_mcp_ping' \
  --data '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "tools/call",
    "params": {
      "name": "super_mcp_ping",
      "arguments": {"message": "hello"}
    }
  }'
```

API key mode is rejected for production HTTP. Use JWT or OIDC JWKS for production.

---

## Production HTTP configuration

Production means `NODE_ENV=production`.

Minimum production requirements enforced by `src/config/env.ts`:

- `STORAGE_DRIVER=redis` on Redis **8.2.2+** (CVE-2025-49844 patch required).
- `REDIS_URL` set.
- `MCP_ENCRYPTION_KEY` set.
- `MCP_IDEMPOTENCY_SECRET` set (min 32 chars). Required with Redis to prevent idempotency key forgery.
- `TRANSPORT_DRIVER=http` must use `MCP_AUTH_MODE=jwt` or `MCP_AUTH_MODE=oidc_jwks`; `api_key` is rejected.
- `ALLOWED_HOSTS` must be explicit and non-empty.
- `ALLOWED_ORIGINS` must be explicit and non-empty.
- `ENABLE_RATE_LIMIT=true` and `ENABLE_QUOTA=true`, unless `MCP_ALLOW_UNLIMITED_HTTP=true` is deliberately set.
- `MCP_ENABLE_TEST_TOOLS=false`.
- Non-built-in plugins require `MCP_PLUGIN_SHA256_ALLOWLIST` (hash pinning), `MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true` (OS-level sandboxing), and `MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true` (explicit best-effort waiver).
- `MCP_REQUIRE_CRYPTO_ERASURE=true` is rejected until real KMS-backed per-tenant DEK crypto-erasure exists.

Production HTTP + JWT shared secret:

```env
NODE_ENV=production
TRANSPORT_DRIVER=http
HTTP_HOST=0.0.0.0
HTTP_PORT=3333

STORAGE_DRIVER=redis
REDIS_URL=redis://:password@redis:6379
MCP_ENCRYPTION_KEY=base64url:<32-byte-base64url-key>

MCP_AUTH_MODE=jwt
MCP_JWT_SECRET=<at-least-32-chars>
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=super-mcp-api
MCP_RESOURCE_URI=https://api.example.com/mcp
MCP_AUTHORIZATION_SERVERS=https://idp.example.com

ALLOWED_HOSTS=api.example.com
ALLOWED_ORIGINS=https://app.example.com
ENABLE_RATE_LIMIT=true
ENABLE_QUOTA=true

MCP_IDEMPOTENCY_SECRET=<random-string-at-least-32-chars>

MCP_SAFE_MODE=true
MCP_PLUGIN_ALLOWLIST=system.tool.js
MCP_PLUGIN_ISOLATION_MODE=policy
```

Production HTTP + OIDC JWKS:

```env
NODE_ENV=production
TRANSPORT_DRIVER=http
HTTP_HOST=0.0.0.0
HTTP_PORT=3333

STORAGE_DRIVER=redis
REDIS_URL=redis://:password@redis:6379
MCP_ENCRYPTION_KEY=base64url:<32-byte-base64url-key>

MCP_AUTH_MODE=oidc_jwks
MCP_JWKS_URI=https://idp.example.com/.well-known/jwks.json
MCP_JWKS_ALLOWLIST=idp.example.com
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=super-mcp-api
MCP_RESOURCE_URI=https://api.example.com/mcp
MCP_AUTHORIZATION_SERVERS=https://idp.example.com

ALLOWED_HOSTS=api.example.com
ALLOWED_ORIGINS=https://app.example.com
ENABLE_RATE_LIMIT=true
ENABLE_QUOTA=true

MCP_IDEMPOTENCY_SECRET=<random-string-at-least-32-chars>

MCP_SAFE_MODE=true
MCP_PLUGIN_ALLOWLIST=system.tool.js
MCP_PLUGIN_ISOLATION_MODE=policy
```

Use `MCP_ALLOW_UNLIMITED_HTTP=true` only as a documented production risk waiver. It disables the production startup requirement for rate limit and quota, but does not change middleware behavior by itself.

---

## MCP protocol behavior

SUPER-MCP targets the local final architecture documented in `docs/adr/0001-mcp-2026-07-28-final-architecture.md`.

Protocol decisions implemented in this codebase:

- `MCP_PROTOCOL_MODE` is a literal `rc2026`; other values fail config validation.
- HTTP is stateless: each POST `/mcp` request creates an ephemeral MCP server/transport connection.
- HTTP clients must send `Mcp-Method` matching the JSON-RPC `method`.
- `tools/call` requests must also send `Mcp-Name` matching `params.name`.
- `server/discover` advertises protocol metadata, operation headers, tool metadata, and Tasks extension support.
- Native Tasks methods are supported through the adapter boundary: `tasks/get`, `tasks/update`, and `tasks/cancel`.
- `tasks/list`, `check_task_status`, `isAsync`, and bespoke polling endpoints are intentionally not implemented.

---

## Authentication and request context

HTTP requests are authenticated before protocol execution.

Supported auth modes:

| Mode | Env | Current use |
| --- | --- | --- |
| API key | `MCP_AUTH_MODE=api_key` | Local/dev HTTP only; rejected for production HTTP. |
| JWT shared secret | `MCP_AUTH_MODE=jwt` | Symmetric deployments. Production requires issuer, audience, and resource URI. |
| OIDC JWKS | `MCP_AUTH_MODE=oidc_jwks` | Remote IdP / OAuth Resource Server deployments. Production requires JWKS URI, issuer, audience, and resource URI. |

### API key mode

Required for HTTP API key mode:

```env
MCP_AUTH_MODE=api_key
MCP_API_KEY=<at-least-32-chars>
```

Client header:

```http
x-api-key: <key>
```

Default API-key context when `MCP_TRUST_IDENTITY_HEADERS=false`:

```text
tenantId = api-key-dev-tenant
userId   = api-key-user
clientId = api-key-client
scopes   = mcp:invoke
authType = api-key
```

If `MCP_TRUST_IDENTITY_HEADERS=true`, the server reads identity from trusted upstream headers and rejects unrecognized `x-mcp-*` headers:

```http
x-mcp-tenant-id: tenant_123
x-mcp-user-id: user_456
x-mcp-client-id: client_789
x-mcp-scopes: scope:a,scope:b
x-request-id: req_abc
```

Only enable trusted identity headers behind a verified auth gateway or sidecar. Direct exposure lets clients spoof tenant/user identity.

### JWT mode

Local/dev JWT can omit issuer, audience, and resource URI, but production HTTP requires them.

```env
MCP_AUTH_MODE=jwt
MCP_JWT_SECRET=<at-least-32-chars>
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=super-mcp-api
MCP_RESOURCE_URI=https://api.example.com/mcp
```

Client header:

```http
Authorization: Bearer <jwt>
```

JWT context is derived from claims:

| Context field | Claims |
| --- | --- |
| `tenantId` | `mcp_tenant_id` or `tenant_id`; required. |
| `userId` | `sub` or `user_id`; fallback `jwt-user`. |
| `clientId` | `azp` or `client_id`; fallback `jwt-client`. |
| `scopes` | `scope` space-separated string or `scopes` array; capped at 32 valid IDs. |

### OIDC JWKS mode

Required in HTTP mode:

```env
MCP_AUTH_MODE=oidc_jwks
MCP_JWKS_URI=https://idp.example.com/.well-known/jwks.json
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=super-mcp-api
MCP_RESOURCE_URI=https://api.example.com/mcp
```

OIDC mode verifies token signatures against the remote JWKS and enforces issuer and audience. In production, `MCP_RESOURCE_URI` is also required.

### Resource indicator enforcement

When `MCP_RESOURCE_URI` is configured, JWT/OIDC tokens must be intended for that resource. The server accepts:

- `aud` equal to `MCP_RESOURCE_URI`;
- `aud` array containing `MCP_RESOURCE_URI`; or
- `resource` equal to `MCP_RESOURCE_URI`.

Wrong-resource tokens are rejected before request context is used.

### Scopes

Tools may declare `requiredScopes`. Missing scopes reject JWT/OIDC/API-Key/Gateway tool calls before the handler executes.

The `stdio` context skips per-tool scope enforcement by design as it is intended strictly for local trusted clients. All remote/HTTP methods (`jwt`, `oidc`, `api-key`, `gateway`) strictly enforce scope validation.

---

## Native Tasks

SUPER-MCP supports native Tasks-style long-running execution through the current local adapter.

Supported methods:

| Method | Purpose |
| --- | --- |
| `tasks/get` | Return task status, pending input requests, terminal result, error, or cancel reason. |
| `tasks/update` | Provide `inputResponses` for a task that is currently `input_required`. |
| `tasks/cancel` | Cancel a running or input-waiting task. |

A client declares Tasks support through `_meta`, for example:

```json
{
  "_meta": {
    "supportedExtensions": ["io.modelcontextprotocol/tasks"]
  }
}
```

A tool declares task behavior through `execution.taskSupport`:

| Value | Meaning |
| --- | --- |
| `forbidden` | Tool always runs synchronously. |
| `optional` | Tool can run synchronously or as a task when the client supports Tasks. |
| `required` | Tool requires Tasks support. |

Task ownership is scoped by:

```text
tenantId + clientId + userId
```

Unauthorized, missing, and expired tasks return a not-found shape to reduce cross-tenant inference.

### Task input state machine

The current patched code enforces:

- `tasks/update` requires `taskId`, `inputRequestId`, and object-shaped `inputResponses`.
- The current task must be owned by the caller.
- The current task status must be `input_required`.
- `inputRequests` must exist and contain the supplied `inputRequestId`.
- Input is consumed atomically through `globalTaskStore.consumeTaskInput(...)`.
- After consume, `inputRequests` is cleared and duplicate/stale updates are rejected.
- If the in-process waiter cannot be resumed, the input remains in task storage and the executing task can resume through store polling.

Example shape returned by `tasks/get` when input is required:

```json
{
  "resultType": "complete",
  "taskId": "task_...",
  "status": "input_required",
  "inputRequests": {
    "default": {
      "method": "elicitation/create",
      "inputRequestId": "input_...",
      "params": {
        "mode": "form",
        "message": "Additional input is required to continue this task.",
        "inputRequestId": "input_...",
        "requestedSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "type": "object",
          "additionalProperties": true
        },
        "_meta": {
          "inputRequestId": "input_..."
        }
      }
    }
  }
}
```

Example `tasks/update`:

```json
{
  "jsonrpc": "2.0",
  "id": "input-1",
  "method": "tasks/update",
  "params": {
    "taskId": "task_...",
    "inputRequestId": "input_...",
    "inputResponses": {
      "default": {
        "approved": true
      }
    }
  }
}
```

---

## Tool execution pipeline

A tool call passes through these stages in `src/mcp/adapter/execution_pipeline.ts`:

1. Resolve request context.
2. Verify plugin manifest stability.
3. Apply rate limit and quota.
4. Enforce required scopes for all non-stdio auth types (`jwt`, `oidc`, `api-key`, `gateway`).
5. Apply safe-mode/security policy checks.
6. Validate JSON-serializable args for idempotency.
7. Generate and acquire an idempotency key.
8. Acquire a tenant execution lock.
9. Validate input schema.
10. Execute tool handler with timeout/abort signal.
11. Validate output schema when present.
12. Run output firewall over text and structured content.
13. Save state.
14. Commit idempotency result or short-TTL permanent error.
15. Log telemetry and OTEL spans.

Long-running tools with native Tasks support are created as durable task records, then continue asynchronously while the initial tool call returns a task descriptor.

---

## Storage and encryption

Storage drivers:

| Driver | Env | Use |
| --- | --- | --- |
| Local filesystem | `STORAGE_DRIVER=fs` | Local/dev durable state. |
| Redis | `STORAGE_DRIVER=redis` | Production durable state, tasks, idempotency, quota/rate data. |
| Memory | `STORAGE_DRIVER=memory` | Tests and ephemeral local HTTP. |

Production requires Redis:

```env
NODE_ENV=production
STORAGE_DRIVER=redis
REDIS_URL=redis://:password@redis:6379
MCP_ENCRYPTION_KEY=<secret>
```

`MCP_ENCRYPTION_KEY` enables encryption-at-rest for state/vault blobs. Supported formats:

- Passphrase-style secret: per-blob scrypt derivation to an A256GCM JWE key.
- Raw key: `base64url:<32-byte-base64url-key>`.

Envelope formats (priority order):

```text
smcp:v4:kms:<base64url-json-SealedBlob>         ← primary when KMS_PROVIDER is set
smcp:v3:hkdf-tenant:<salt-base64url>:<compact-jwe>  ← primary without KMS_PROVIDER
smcp:v2:scrypt:<salt-base64url>:<compact-jwe>   ← fallback (no tenantId)
```

V4 uses KMS-backed per-tenant DEK sealed by the configured provider. V3 is now legacy; V2 is the oldest fallback for global configurations without a `tenantId`. Enable V4 by setting `KMS_PROVIDER` — the `EncryptionService` automatically uses the KMS path first.

KMS providers:

| Provider | `KMS_PROVIDER` | Required env | Erasure model |
| --- | --- | --- | --- |
| Local (dev/test only) | `local` | — | In-process; no real erasure. Rejected in production. |
| HashiCorp Vault Transit | `vault` | `VAULT_ADDR`, `VAULT_TOKEN` | Immediate (key deletion in Transit). |
| AWS KMS | `aws-kms` | `AWS_KMS_REGION` | Phase 1: `DisableKey` (immediate GDPR erasure). Phase 2: `ScheduleKeyDeletion` (7-day mandatory window, cryptographic proof). |
| GCP Cloud KMS | `gcp-kms` | `GCP_KMS_PROJECT`, `GCP_KMS_KEYRING` | `DESTROY_SCHEDULED` (immediately unusable, 24 h permanent). |

All providers are wrapped by `CachingKeyRegistry` which adds a bounded in-memory DEK cache (configurable TTL and use-count) and durable `CryptoErasureReceipt` persistence via `FileAuditStore`.

To migrate pre-V4 blobs when introducing KMS:

```bash
KMS_PROVIDER=vault pnpm migrate:encryption
```

Legacy SHA-256 KDF encrypted state is denied by default. Use `MCP_ALLOW_LEGACY_SHA256_KDF=true` only for one migration run through the same command.

Known development encryption values such as `changeme`, `change_me`, `dev`, `development`, and `super_secret_key_for_dev_only` are rejected.

Task record encryption gap:

Task records (including `lastClientInput.inputResponses`) are stored as plain JSON in Redis via `RedisTaskStore`. They are **not** covered by `MCP_ENCRYPTION_KEY` encryption — that only applies to state and vault blobs. If task inputs may contain PII or secrets, ensure Redis itself is encrypted at rest and access-controlled at the infrastructure level. This is tracked as a known gap pending a KMS-backed task-record encryption path.

Crypto-erasure status:

- `docs/adr/0002-tenant-crypto-erasure-v3.md` defined the original V3 target design.
- `docs/superpowers/adrs/2026-06-14-debt-002-kms-crypto-erasure.md` records the V4 implementation decision.
- `src/storage/key_registry.ts` defines `ITenantKeyRegistry`, `SealedBlob`, and `CryptoErasureReceipt`.
- `src/storage/key_registry_factory.ts` selects the runtime provider from `KMS_PROVIDER`.
- Four providers are implemented: `LocalKeyRegistry`, `VaultKeyRegistry`, `AwsKmsKeyRegistry`, `GcpKmsKeyRegistry`.
- `MCP_REQUIRE_CRYPTO_ERASURE=true` in production requires `KMS_PROVIDER=vault|aws-kms|gcp-kms`; `local` is rejected.

---

## Rate limit, quota, idempotency, and locks

Rate limit:

```env
ENABLE_RATE_LIMIT=true
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_WINDOW_MS=60000
```

Quota:

```env
ENABLE_QUOTA=true
QUOTA_DAILY_LIMIT=1000
```

Production HTTP requires both unless `MCP_ALLOW_UNLIMITED_HTTP=true` is set as a documented waiver.

Idempotency and locks:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `MCP_IDEMPOTENCY_WORKING_TTL_SECONDS` | `600` | TTL for in-progress idempotency records. |
| `MCP_IDEMPOTENCY_RESULT_TTL_SECONDS` | `604800` with Redis, `3600` otherwise | TTL for successful cached results. Non-Redis values above 3600 are rejected. |
| `MCP_IDEMPOTENCY_ERROR_TTL_SECONDS` | `300` | TTL for permanent error cache records. |
| `MCP_LOCK_TTL_MS` | `420000` | Tenant execution lock TTL. |
| `MCP_LOCK_ACQUIRE_DEADLINE_MS` | `420000` | Max wait to acquire tenant lock. |

Redis implementations use Lua scripts for critical acquire/consume/update paths where needed.

---

## Output firewall

The output firewall scans tool results before returning them and before committing idempotency results.

Covered surfaces:

- `content[].text`.
- `structuredContent` recursively.

Credential and safety detections include:

- private-key blocks;
- OpenAI-like keys;
- GitHub-like tokens;
- AWS access key IDs;
- Luhn-valid payment-card-like values;
- valid SSN-like values;
- prompt-injection markers;
- sensitive structured field names such as `apiKey`, `secret`, `token`, `password`, `authorization`, `private_key`, and related variants.

Strict PII mode is opt-in:

```env
MCP_OUTPUT_FIREWALL_PII_MODE=strict
```

Strict mode additionally redacts email and phone-like values. Default mode is `credentials_only`.

Structured-content redaction preserves object shape where possible and has depth, node-count, string-length, total-string-byte, and cycle guards.

---

## Plugin system

Plugin files live in:

```text
src/plugins/
```

Accepted plugin filenames:

```text
*.tool.ts
*.tool.js
```

Built-in plugin:

```text
src/plugins/system.tool.ts
```

Built-in tools:

| Tool | Availability | Description |
| --- | --- | --- |
| `super_mcp_ping` | Always | Health/pipeline ping returning phase, revision, and environment. |
| `super_mcp_pattern_debt` | Always | Read-only pattern debt report. |
| `super_mcp_test_long_task` | Only when `MCP_ENABLE_TEST_TOOLS=true` | Test-only long task; rejected in production. |

### Discovery and allowlist

Default allowlist:

```env
MCP_PLUGIN_ALLOWLIST=system.tool.js,system.tool.ts
MCP_PLUGIN_AUTO_DISCOVERY=false
```

Auto-discovery is blocked unless explicitly waived:

```env
MCP_PLUGIN_AUTO_DISCOVERY=true
MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY=true
```

### SHA-256 allowlist

```env
MCP_PLUGIN_SHA256_ALLOWLIST=my_plugin.tool.js:<sha256>,other.tool.js:<sha256>
```

If configured, mismatched plugin file hashes are rejected.

### Manifest pinning

`MCP_PLUGIN_PIN_MANIFEST=true` records the loaded plugin manifest hash at startup and rejects invocation if the manifest changes while the server is running. Restart deliberately to accept plugin changes.

### Isolation modes

| Mode | Behavior |
| --- | --- |
| `external` | Non-built-in plugins run through `ChildProcessPluginRunner`. This is the default. |
| `policy` | Trusted-only mode. Non-built-in plugins are rejected rather than run. |

External runner knobs:

```env
MCP_EXTERNAL_PLUGIN_TIMEOUT_MS=30000
MCP_EXTERNAL_PLUGIN_MAX_OLD_SPACE_MB=128
MCP_EXTERNAL_PLUGIN_NETWORK_POLICY=deny
MCP_EXTERNAL_PLUGIN_FS_POLICY=read-only
MCP_EXTERNAL_PLUGIN_MAX_STDERR_BYTES=262144
MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=false
```

Current external runner reports one of these best-effort levels:

- `process-best-effort`;
- `node-permission-best-effort` when `MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true`.

The type contract includes future runner targets `container`, `wasm-worker`, and `microvm`, but they are not implemented.

Production non-built-in plugins:

- Fail closed by default because no true OS/container/WASM sandbox exists.
- Additionally require `MCP_PLUGIN_SHA256_ALLOWLIST` set (hash pinning) and `MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true` (Node.js OS-level permission model).
- Can be waived with `MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true`, but the waiver does not make the runner a complete security sandbox.
- At runtime, warnings are emitted for each external plugin loaded without hash pinning or node permission.

---

## Writing plugins

A plugin exports a `ToolDefinition[]` as `default` or `tools`.

Minimal plugin example:

```ts
import { z } from "zod/v4";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

const tools: ToolDefinition[] = [
  {
    name: "example_echo",
    description: "Echo an input message.",
    inputSchema: {
      message: z.string().min(1),
    },
    allowedPhases: ["intake", "execution", "review", "completed"],
    capabilities: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: {
      taskSupport: "forbidden",
    },
    handler: async (args) => {
      const input = args as { message: string };
      return {
        content: [{ type: "text", text: input.message }],
        structuredContent: { echoed: input.message },
      };
    },
  },
];

export default tools;
```

Relevant `ToolDefinition` fields:

| Field | Meaning |
| --- | --- |
| `name` | Tool name exposed to MCP clients. |
| `description` | Human-readable tool description. |
| `inputSchema` | Zod object fields used by the adapter. |
| `inputJsonSchema` | Optional JSON Schema 2020-12 input schema. |
| `outputSchema` | Optional JSON Schema 2020-12 output schema. |
| `allowedPhases` | Runtime state phases where the tool may run. |
| `capabilities` | Capability declarations such as `fs.read`, `fs.write`, `network`, `secrets.read`, `secrets.write`, `process.spawn`, `destructive`. |
| `requireConfidence` / `minConfidence` | Confidence/elicitation guard. |
| `annotations` | MCP-style hints: read-only, destructive, idempotent, open-world. |
| `execution.taskSupport` | `forbidden`, `optional`, or `required`. |
| `securityPolicy` | Private-data, untrusted-content, external-communication, destructive-effect policy metadata. |
| `requiredScopes` | JWT/OIDC scopes needed before handler execution. |
| `handler` | Async implementation returning `ToolResult`. |

Handler signature:

```ts
(args, state, signal, context) => Promise<ToolResult>
```

For long-running tools that need user input, call:

```ts
await context?.requestInput?.("Please confirm before continuing.")
```

This only works for native-task execution paths. The runtime will generate an `inputRequestId` nonce and expose it through `tasks/get`.

---

## HTTP endpoints and headers

HTTP routes:

| Route | Method | Purpose |
| --- | --- | --- |
| `/mcp` | POST | Stateless MCP JSON-RPC endpoint. |
| `/mcp` | GET/DELETE | Rejected with 405 in stateless HTTP mode. |
| `/health/liveness` | GET | Basic liveness. |
| `/health/readiness` | GET | Runtime/storage readiness. |
| `/.well-known/mcp.json` | GET | Server card. |
| `/.well-known/mcp-server-card` | GET | Server card alias. |
| `/.well-known/oauth-protected-resource` | GET | OAuth protected resource metadata. |

Required HTTP `/mcp` headers:

```http
Content-Type: application/json
Mcp-Method: <json-rpc-method>
```

For `tools/call`, also include:

```http
Mcp-Name: <params.name>
```

Authentication headers:

```http
x-api-key: <key>
```

or:

```http
Authorization: Bearer <jwt>
```

Host and CORS:

- `ALLOWED_HOSTS` must include the exact Host value, including port when present.
- `ALLOWED_ORIGINS` must include browser origins.
- Requests without an `Origin` header are allowed for non-browser/server clients.
- `ALLOWED_HOSTS=*` and `ALLOWED_ORIGINS=*` are rejected by startup validation.

---

## Docker / Compose

Build the image:

```bash
docker build -f Containerfile -t super-mcp:local .
```

The image sets `NODE_ENV=production`, so production gates apply.

`compose.yaml` includes Redis and a hardened server container with:

- read-only server filesystem;
- `/tmp` tmpfs;
- dropped Linux capabilities;
- `no-new-privileges`;
- pid and memory limits;
- no public port mapping by default.

A production-compatible JWT `.env` for Compose:

```env
REDIS_PASSWORD=change-this-redis-password
MCP_ENCRYPTION_KEY=base64url:<32-byte-base64url-key>
MCP_IDEMPOTENCY_SECRET=change-this-idempotency-secret-at-least-32-chars

MCP_AUTH_MODE=jwt
MCP_JWT_SECRET=change-this-jwt-secret-with-at-least-32-chars
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=super-mcp-api
MCP_RESOURCE_URI=https://api.example.com/mcp
MCP_AUTHORIZATION_SERVERS=https://idp.example.com

ALLOWED_HOSTS=api.example.com
ALLOWED_ORIGINS=https://app.example.com
```

Run:

```bash
docker compose up --build
```

For OIDC JWKS in Compose, set `MCP_AUTH_MODE=oidc_jwks` and provide `MCP_JWKS_URI`; keep issuer, audience, resource URI, hosts, origins, Redis, and encryption configured.

Expose the server only behind a trusted ingress/reverse proxy that sets a Host value included in `ALLOWED_HOSTS`.

---

## Configuration reference

All configuration is read in `src/config/env.ts`.

### Core runtime

| Variable | Default | Allowed | Notes |
| --- | ---: | --- | --- |
| `TRANSPORT_DRIVER` | `stdio` | `stdio`, `http` | Select transport. |
| `HTTP_HOST` | `127.0.0.1` | string | HTTP bind host. |
| `HTTP_PORT` | `3333` | 1-65535 | HTTP bind port. |
| `MCP_PROTOCOL_MODE` | `rc2026` | `rc2026` | Only supported mode. |
| `MCP_PROJECT_ID` | `super_mcp_default` | string | Namespace for Redis/vault keys. |
| `MCP_TENANT_ID` | `tenant_local` | string | Local/stdio fallback tenant. |
| `MCP_SAFE_MODE` | `true` | boolean | Blocks high-risk capability tools. |
| `MCP_TOOL_TIMEOUT_MS` | `300000` | 1000-3600000 | Per-tool timeout. |
| `MCP_TOOL_LIST_TTL_MS` | `300000` | 0-3600000 | Tool-list cache TTL metadata. |

### HTTP security

| Variable | Default | Notes |
| --- | ---: | --- |
| `ALLOWED_HOSTS` | empty | Required in HTTP mode. Explicit comma-separated allowlist. |
| `ALLOWED_ORIGINS` | empty | Required in HTTP mode. Explicit comma-separated CORS allowlist. |
| `MCP_HTTP_BODY_LIMIT` | `100kb` | Express JSON body limit. |
| `MCP_TRUST_IDENTITY_HEADERS` | `false` | Trust upstream `x-mcp-*` identity headers only behind a trusted gateway. |

### Authentication

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_AUTH_MODE` | `api_key` | `api_key`, `jwt`, `oidc_jwks`. Production HTTP rejects `api_key`. |
| `MCP_API_KEY` | unset | Required for API-key HTTP, minimum 32 chars. |
| `MCP_JWT_SECRET` | unset | Required for JWT HTTP, minimum 32 chars. |
| `MCP_JWT_ISSUER` | unset | Optional for dev JWT, required for production JWT and all HTTP OIDC. |
| `MCP_JWT_AUDIENCE` | unset | Optional for dev JWT, required for production JWT and all HTTP OIDC. |
| `MCP_JWKS_URI` | unset | Required for HTTP OIDC JWKS. Must be URL. |
| `MCP_JWKS_ALLOWLIST` | empty | Comma-separated hostname allowlist for JWKS fetches (e.g. `idp.example.com`). Prevents SSRF/key-substitution via attacker-controlled JWKS endpoint. |
| `MCP_JWT_MAX_AGE_SECONDS` | `3600` | Maximum accepted token age in seconds. Tokens older than this are rejected. |
| `MCP_RESOURCE_URI` | unset | Required for production JWT/OIDC HTTP. Enforced against `aud` or `resource`. |
| `MCP_AUTHORIZATION_SERVERS` | empty | Comma-separated authorization servers advertised in protected-resource metadata. |

### Storage and encryption

| Variable | Default | Notes |
| --- | ---: | --- |
| `STORAGE_DRIVER` | `fs` | `fs`, `redis`, or `memory`. Production requires `redis`. |
| `REDIS_URL` | unset | Required when `STORAGE_DRIVER=redis`. |
| `MCP_REDIS_MAX_BACKUPS` | `25` | Redis backup retention. |
| `MCP_ENCRYPTION_KEY` | unset | Enables encryption. Required with Redis. |
| `MCP_ALLOW_LEGACY_SHA256_KDF` | `false` | One-time migration waiver for legacy encrypted state. |
| `MCP_REQUIRE_CRYPTO_ERASURE` | `false` | Production fail-closed flag until real v3 KMS runtime exists. |

### KMS and crypto-erasure

| Variable | Default | Notes |
| --- | ---: | --- |
| `KMS_PROVIDER` | unset | `vault`, `aws-kms`, `gcp-kms`, or `local`. Required when `MCP_REQUIRE_CRYPTO_ERASURE=true` in production; `local` rejected in production. |
| `VAULT_ADDR` | unset | Required when `KMS_PROVIDER=vault`. Must be a URL (e.g. `https://vault.example.com`). |
| `VAULT_TOKEN` | unset | Required when `KMS_PROVIDER=vault`. |
| `VAULT_TRANSIT_MOUNT` | `transit` | HashiCorp Vault Transit secrets engine mount path. |
| `AWS_KMS_REGION` | unset | AWS region for KMS operations (e.g. `us-east-1`). Required when `KMS_PROVIDER=aws-kms`. |
| `AWS_KMS_PENDING_WINDOW_DAYS` | `7` | Mandatory pending-deletion window in days (7–30). AWS minimum is 7 days. |
| `GCP_KMS_PROJECT` | unset | GCP project ID. Required when `KMS_PROVIDER=gcp-kms`. |
| `GCP_KMS_LOCATION` | `global` | GCP KMS key ring location. |
| `GCP_KMS_KEYRING` | unset | GCP KMS key ring name. Required when `KMS_PROVIDER=gcp-kms`. |
| `GCP_KMS_ACCESS_TOKEN` | unset | Static GCP access token. If unset, auto-fetched from the GCP metadata server. |
| `GCP_KMS_DESTROY_DURATION_HOURS` | `24` | Hours until permanent key destruction after DESTROY_SCHEDULED (1–2880). |
| `DEK_CACHE_TTL_MS` | `300000` | In-memory DEK cache TTL in milliseconds (0 disables TTL). |
| `DEK_CACHE_MAX_USES` | `1000` | Maximum DEK uses before eviction (0 disables use-count limit). |

### Telemetry

| Variable | Default | Allowed / notes |
| --- | ---: | --- |
| `TELEMETRY_DRIVER` | `stderr` in stdio, otherwise `file` | `file`, `stdout`, `stderr`. `stdout` forbidden with stdio. |
| `MCP_TELEMETRY_MAX_BYTES` | `1048576` | File logger rotation size. |
| `MCP_TELEMETRY_MAX_BACKUPS` | `5` | File logger backup count. |
| `OTEL_SERVICE_NAME` | `super-mcp-server` | OTEL service name. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Enables OTLP export when configured. |

### Abuse controls

| Variable | Default | Notes |
| --- | ---: | --- |
| `ENABLE_RATE_LIMIT` | `false` | Production HTTP requires true unless waived. |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Requests per window. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window duration. |
| `ENABLE_QUOTA` | `false` | Production HTTP requires true unless waived. |
| `QUOTA_DAILY_LIMIT` | `1000` | Daily tenant quota. |
| `MCP_ALLOW_UNLIMITED_HTTP` | `false` | Explicit production waiver for disabling rate/quota startup requirement. |

### Idempotency and locks

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_LOCK_TTL_MS` | `420000` | Tenant lock TTL. |
| `MCP_LOCK_ACQUIRE_DEADLINE_MS` | `420000` | Max wait to acquire tenant lock. |
| `MCP_IDEMPOTENCY_SECRET` | unset | Min-32-char HMAC secret for idempotency key generation. **Required when `STORAGE_DRIVER=redis`.** Uses HMAC-SHA256 to prevent idempotency key forgery by anyone with Redis write access. |
| `MCP_IDEMPOTENCY_WORKING_TTL_SECONDS` | `600` | In-progress record TTL. |
| `MCP_IDEMPOTENCY_RESULT_TTL_SECONDS` | Redis: `604800`; non-Redis: `3600` | Non-Redis values above 3600 rejected. |
| `MCP_IDEMPOTENCY_ERROR_TTL_SECONDS` | `300` | Permanent error cache TTL. |

### Tasks

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_TASK_POLL_INTERVAL_MS` | `5000` | Polling hint for native task clients and store resume loop. |
| `MCP_ENABLE_TEST_TOOLS` | `false` | Enables `super_mcp_test_long_task`; rejected in production. |

### Plugin loading and runner

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_PLUGIN_ALLOWLIST` | `system.tool.js,system.tool.ts` | Comma-separated plugin filenames. |
| `MCP_PLUGIN_AUTO_DISCOVERY` | `false` | Auto-load matching plugin files only when unsafe waiver is also true. |
| `MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY` | `false` | Required to enable auto-discovery. |
| `MCP_PLUGIN_SHA256_ALLOWLIST` | empty | `filename:sha256` hash pins. Required in production for non-built-in plugins; optional in dev. |
| `MCP_PLUGIN_PIN_MANIFEST` | `true` | Runtime manifest stability guard. |
| `MCP_PLUGIN_ISOLATION_MODE` | `external` | `external` or `policy`. |
| `MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX` | `false` | Production waiver for non-built-in plugins before real sandbox exists. |
| `MCP_EXTERNAL_PLUGIN_TIMEOUT_MS` | `30000` | Child runner timeout. |
| `MCP_EXTERNAL_PLUGIN_MAX_OLD_SPACE_MB` | `128` | Child process old-space cap. |
| `MCP_EXTERNAL_PLUGIN_NETWORK_POLICY` | `deny` | `deny` or `allow`. |
| `MCP_EXTERNAL_PLUGIN_FS_POLICY` | `read-only` | `read-only` or `allow`. |
| `MCP_EXTERNAL_PLUGIN_MAX_STDERR_BYTES` | `262144` | Stderr capture cap. |
| `MCP_EXTERNAL_PLUGIN_NODE_PERMISSION` | `false` | Optional Node Permission Model hardening for compiled workers. |

### Secrets and output firewall

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_SECRET_ALLOWLIST` | empty | Secret names available through the credential vault. |
| `MCP_ALLOW_SECRET_WRITE` | `false` | Enables secret write paths where implemented. |
| `MCP_OUTPUT_FIREWALL_PII_MODE` | `credentials_only` | `credentials_only` or `strict`. |

---

## Testing and quality gates

Current package scripts:

```json
{
  "dev": "tsx watch src/index.ts",
  "build": "tsc -p tsconfig.json",
  "start": "node dist/index.js",
  "test": "vitest run src",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "lint": "eslint src",
  "lint:fix": "eslint src --fix",
  "lint:strict": "eslint src --max-warnings 0",
  "ci": "pnpm typecheck && pnpm lint && pnpm test",
  "audit": "npm audit --audit-level=high",
  "deps:check": "npm outdated",
  "migrate:encryption": "tsx src/scripts/migrate_encryption.ts",
  "test:enterprise": "vitest run src/__tests__/task_runtime.test.ts src/__tests__/task_store.test.ts src/__tests__/http_tasks_conformance.test.ts src/__tests__/jwt_auth_runtime.test.ts src/__tests__/request_context_security.test.ts src/__tests__/env_validation.test.ts src/__tests__/auth_resource_indicator.test.ts src/__tests__/oidc_auth.test.ts src/__tests__/scope_enforcement.test.ts src/__tests__/http_security.test.ts src/__tests__/protocol_header.test.ts src/__tests__/oauth_metadata.test.ts src/__tests__/rate_limit.test.ts src/__tests__/idempotency.test.ts src/__tests__/execution_lock.test.ts src/__tests__/security_policy.test.ts src/__tests__/security_regression.test.ts src/__tests__/output_firewall.test.ts src/__tests__/output_firewall_strict_pii.test.ts src/__tests__/encryption_negative.test.ts src/__tests__/vault.test.ts src/__tests__/pattern_debt.test.ts",
  "test:plugin:lifecycle": "vitest run src/__tests__/plugin_external_runner.test.ts -t \"external plugin runner lifecycle\"",
  "test:plugin:worker": "vitest run src/__tests__/plugin_external_runner.test.ts -t \"external plugin worker JS-level hardening\"",
  "test:plugin:permission": "vitest run src/__tests__/plugin_external_runner.test.ts -t \"optional Node permission hardening\""
}
```

Recommended pre-merge validation:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build
pnpm test:enterprise
pnpm test:plugin:lifecycle
pnpm test:plugin:permission
npm audit --audit-level=high
```

Additional deep plugin hardening suite:

```bash
pnpm test:plugin:worker
```

`pnpm test` runs every Vitest file under `src`. The plugin external runner suite spawns many child processes, so the focused plugin scripts are preferred for diagnosing plugin-runner failures and reducing aggregate-suite flakiness. In this workspace, `test:plugin:worker` is treated as a heavier deep suite and may need to be run separately with enough timeout.

The test coverage matrix is maintained in:

```text
docs/test-coverage-matrix.md
```

Enterprise coverage areas include:

- Native Tasks state machine and nonce-bound input.
- JWT/OIDC authentication with real JWTs.
- Request context sanitization and trusted identity header behavior.
- HTTP host/CORS/content-type/protocol-header checks.
- OAuth protected resource metadata.
- Rate limit/quota production gates.
- Idempotency and execution locks.
- Output firewall and strict PII mode.
- Storage encryption negative cases.
- Vault/secret access policy.
- Plugin policy and best-effort isolation behavior.
- Pattern debt registry consistency.

Additional suites (run via `pnpm test` or individually):

- `encryption_kms.test.ts` — V4 KMS envelope encrypt/decrypt paths.
- `caching_key_registry.test.ts` — DEK cache TTL, use-count eviction, zeroed DEK, audit persistence.
- `audit_store.test.ts` — `FileAuditStore` JSONL append and `NoopAuditStore`.
- `local_key_registry.test.ts` — Dev/test KMS provider.
- `gcp_kms_key_registry.test.ts` — GCP KMS provider (fetch mock).
- `vault_key_registry.test.ts` — HashiCorp Vault provider.
- `key_registry_types.test.ts` — Interface contract type checks.
- `registrar_governance.test.ts` — Plugin/tool registration governance.
- `holyseed_patterns.test.ts` — Sensitive-pattern detection.
- `redis_backup.test.ts` — Redis backup retention.
- `server_card.test.ts` — Server card metadata.
- `sanitize.test.ts`, `otel.test.ts`, `file_logger.test.ts`, `tool_metadata.test.ts` — Supporting subsystem tests.

`.github/workflows/ci.yml` currently uses pnpm and runs install, typecheck, full `pnpm test`, audit, and dependency update signal.

---

## Pattern debt and limitations

SUPER-MCP keeps residual security/design debt visible instead of hiding it.

Runtime report tool:

```text
super_mcp_pattern_debt
```

Docs:

```text
docs/pattern-debt-registry.yaml
docs/phase5-pattern-debt.md
docs/test-coverage-matrix.md
```

Current debt summary:

| Debt | Status | Current truth |
| --- | --- | --- |
| `DEBT-001-plugin-os-isolation` | Open, release-blocking | Current runner is child-process best-effort only. No container, Wasmtime, or microVM boundary. Production non-built-in plugin config fails closed unless explicitly waived. |
| `DEBT-002-crypto-erasure` | Implemented | `smcp:v4:kms` envelope shipped 2026-06-14. Four KMS providers: Local (dev/test), Vault (immediate), AWS KMS (DisableKey + 7-day ScheduleKeyDeletion), GCP KMS (DESTROY_SCHEDULED + 24 h). `CachingKeyRegistry` + `FileAuditStore` for DEK cache and erasure receipt durability. `MCP_REQUIRE_CRYPTO_ERASURE=true` in production requires `KMS_PROVIDER=vault\|aws-kms\|gcp-kms`. |
| `DEBT-003-native-mcp-tasks` | Monitoring | Custom Tasks adapter remains isolated until the TypeScript SDK exposes stable public Tasks APIs. |
| `DEBT-004-oauth-resource-indicator` | Implemented | JWT/OIDC resource indicator enforced when configured; production requires resource URI. |
| `DEBT-005-output-firewall-coverage` | Partially resolved | Structured redaction implemented with deterministic patterns and limits. No DLP/classifier backend. |
| `DEBT-006-redis-trauma-registry` | Implemented | Redis/memory rate limiters use bounded violation records with severity EMA/backoff. |

Non-goals intentionally preserved:

- No fake DLP backend.
- No TokenManager or server-side PKCE.
- No duplicate OAuth metadata endpoint.
- No claim that child process or Node Permission Model equals OS/container sandboxing.

---

## Troubleshooting

### `pnpm lint` fails

Check the ESLint output for style or formatting errors in `src`.

### Production HTTP exits with `MCP_AUTH_MODE=api_key is for local/dev only`

Production HTTP rejects API key mode. Use `MCP_AUTH_MODE=jwt` or `MCP_AUTH_MODE=oidc_jwks` with issuer, audience, and resource URI.

### Production HTTP exits because rate limit or quota is missing

Set:

```env
ENABLE_RATE_LIMIT=true
ENABLE_QUOTA=true
```

Only use this as a documented risk waiver:

```env
MCP_ALLOW_UNLIMITED_HTTP=true
```

### HTTP returns `403 Invalid Host`

Set `ALLOWED_HOSTS` to include the exact Host header, including port when present.

```env
ALLOWED_HOSTS=127.0.0.1:3333,localhost:3333
```

### HTTP returns `415 Unsupported media type`

Use `Content-Type: application/json` or `application/*+json` for POST `/mcp`.

### HTTP returns JSON-RPC `-32602` about `Mcp-Method`

Every HTTP `/mcp` request must include `Mcp-Method`, and it must match the JSON-RPC body `method`.

### `tools/call` returns JSON-RPC `-32602` about `Mcp-Name`

For `tools/call`, include `Mcp-Name` and ensure it matches `params.name`.

### JWT/OIDC request returns `401 Unauthorized`

Check:

- `Authorization: Bearer <token>` is present.
- The token signature is valid.
- Issuer matches `MCP_JWT_ISSUER` when configured.
- Audience matches `MCP_JWT_AUDIENCE` when configured.
- `MCP_RESOURCE_URI` matches token `aud` or `resource` when configured.
- Token contains `mcp_tenant_id` or `tenant_id`.
- Required scopes are present for scoped tools.
- Token is not older than `MCP_JWT_MAX_AGE_SECONDS` (default 3600). Issue a fresh token or raise the limit.

### OIDC JWKS request returns `401 Unauthorized` with no other indication

If `MCP_JWKS_ALLOWLIST` is configured, the JWKS URI hostname must be in the allowlist:

```env
MCP_JWKS_ALLOWLIST=idp.example.com
```

An unlisted hostname is silently rejected to avoid leaking allowlist contents.

### `tasks/update` returns `Task is not waiting for input`

The task is not currently in `input_required`, or the prompt was already consumed/cancelled/finished. Poll `tasks/get` and only update while it returns `status: "input_required"` with an `inputRequestId`.

### `tasks/update` returns `Stale or unknown inputRequestId`

The client used an old, wrong, missing, or already-consumed nonce. Use the exact `inputRequestId` returned in the latest `tasks/get` result.

### Plugin is not loaded

Check:

- file name matches `*.tool.ts` or `*.tool.js`;
- file name is in `MCP_PLUGIN_ALLOWLIST`, unless auto-discovery is explicitly enabled and waived;
- SHA-256 pin matches if `MCP_PLUGIN_SHA256_ALLOWLIST` is set;
- non-built-in plugin is not rejected by `MCP_PLUGIN_ISOLATION_MODE=policy`;
- safe mode is not blocking declared capabilities;
- `MCP_PLUGIN_SHA256_ALLOWLIST` contains a `filename:sha256` entry for this plugin (required in production);
- `MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true` is set (required in production);
- production non-built-in plugin waiver `MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true` is set;
- plugin exports an array as `default` or `tools`.

### Plugin fails because network or filesystem writes are blocked

Default external runner policy:

```env
MCP_EXTERNAL_PLUGIN_NETWORK_POLICY=deny
MCP_EXTERNAL_PLUGIN_FS_POLICY=read-only
```

Loosen only for trusted deployments:

```env
MCP_EXTERNAL_PLUGIN_NETWORK_POLICY=allow
MCP_EXTERNAL_PLUGIN_FS_POLICY=allow
```

For untrusted plugins, implement a real container/microVM/WASM runner instead of disabling best-effort guards.

### `MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true` fails in development

Node Permission Model hardening is intended for compiled JavaScript workers. Build first:

```bash
pnpm build
MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true pnpm start
```

### `MCP_PLUGIN_AUTO_DISCOVERY=true` causes fatal startup

Also set:

```env
MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY=true
```

This is intentional to prevent accidental plugin loading.

### `MCP_REQUIRE_CRYPTO_ERASURE=true` causes fatal startup

In production, this flag requires a real KMS provider (`KMS_PROVIDER=vault`, `aws-kms`, or `gcp-kms`). `LocalKeyRegistry` (`KMS_PROVIDER=local`) is rejected in production because it provides no real crypto-erasure guarantee.

Set the appropriate provider and required credentials:

```env
KMS_PROVIDER=vault
VAULT_ADDR=https://vault.example.com
VAULT_TOKEN=<token>
```

or:

```env
KMS_PROVIDER=aws-kms
AWS_KMS_REGION=us-east-1
```

or:

```env
KMS_PROVIDER=gcp-kms
GCP_KMS_PROJECT=my-project
GCP_KMS_KEYRING=my-keyring
```

After wiring up a KMS provider, run the migration once per tenant to re-encrypt pre-V4 blobs:

```bash
pnpm migrate:encryption
```

### Production startup exits with `MCP_IDEMPOTENCY_SECRET is required when STORAGE_DRIVER=redis`

Set a random string of at least 32 characters:

```env
MCP_IDEMPOTENCY_SECRET=<random-string-at-least-32-chars>
```

Without this, idempotency keys are plain SHA256, which can be predicted and forged by anyone with Redis write access.

### Redis Lua operations fail or behave incorrectly

Upgrade Redis to **8.2.2 or later**. CVE-2025-49844 (Lua GC Use-After-Free, CVSS 10.0) affects Redis ≤ 8.2.1. This codebase uses Lua scripts for task consume, idempotency acquire, and state save paths — an unpatched Redis instance can corrupt memory or produce incorrect results in those paths.

### State decrypt fails after changing `MCP_ENCRYPTION_KEY`

State encrypted with one key cannot be decrypted with a different key. Restore the old key, run a deliberate migration, or restore from a compatible backup.

---

## License

See `LICENSE` in the repository.

---

## Maintainer notes

Recommended next work:

- Implement a true container/Wasmtime/microVM plugin runner before supporting untrusted third-party plugins in production (`DEBT-001`, release-blocking).
- Add `AwsKmsKeyRegistry` unit tests — requires a live AWS KMS endpoint or LocalStack mock. GCP, Vault, and Local providers already have passing tests.
- Run `pnpm migrate:encryption` once per tenant after enabling `KMS_PROVIDER` to re-encrypt all pre-V4 blobs before offering a formal erasure SLA.
- Keep monitoring MCP TypeScript SDK public Tasks support before replacing the local adapter (`DEBT-003`, monitoring).
