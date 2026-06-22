# KARMA — Runtime & Operations Reference

> Detailed operator reference for the **SUPER-MCP runtime (Layer 0)** that KARMA is built on:
> HTTP deployment, authentication, native Tasks, storage/encryption, rate-limit/quota/idempotency,
> output firewall, the plugin system, the full configuration reference, and troubleshooting.
>
> For the project overview, architecture, tool catalogue, and quick start, see the main
> [README.md](../README.md). For the on-chain demo transaction log see [DEMO.md](../DEMO.md).

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

Example `tools/call` request:

```bash
curl -sS http://127.0.0.1:3333/mcp \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: change-this-to-a-random-string-with-at-least-32-chars' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: karma_ping' \
  --data '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "tools/call",
    "params": {
      "name": "karma_ping",
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
- `MCP_IDEMPOTENCY_SECRET` set (min 32 chars).
- `TRANSPORT_DRIVER=http` must use `MCP_AUTH_MODE=jwt` or `MCP_AUTH_MODE=oidc_jwks`; `api_key` is rejected.
- `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` must be explicit and non-empty.
- `ENABLE_RATE_LIMIT=true` and `ENABLE_QUOTA=true`, unless `MCP_ALLOW_UNLIMITED_HTTP=true` is set.
- `MCP_ENABLE_TEST_TOOLS=false`.
- Non-built-in plugins require `MCP_PLUGIN_SHA256_ALLOWLIST`, `MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true`, and `MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true`.

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
MCP_JWT_AUDIENCE=karma-api
MCP_RESOURCE_URI=https://api.example.com/mcp
MCP_AUTHORIZATION_SERVERS=https://idp.example.com

ALLOWED_HOSTS=api.example.com
ALLOWED_ORIGINS=https://app.example.com
ENABLE_RATE_LIMIT=true
ENABLE_QUOTA=true

MCP_IDEMPOTENCY_SECRET=<random-string-at-least-32-chars>

MCP_SAFE_MODE=false
MCP_PLUGIN_ALLOWLIST=system.tool.js,karma.tool.js
MCP_PLUGIN_ISOLATION_MODE=policy

PHAROS_RPC_URL=https://atlantic.dplabs-internal.com
PHAROS_CONTRACT_ADDRESS=0x<deployed-address>
KEYSTORE_PATH=/run/secrets/keystore.json
KEYSTORE_PASSWORD=<password>
```

---

## MCP protocol behavior

Protocol decisions:

- `MCP_PROTOCOL_MODE` is a literal `rc2026`; other values fail config validation.
- HTTP is stateless: each POST `/mcp` creates an ephemeral MCP server/transport connection.
- HTTP clients must send `Mcp-Method` matching the JSON-RPC `method`.
- `tools/call` requests must also send `Mcp-Name` matching `params.name`.
- `server/discover` advertises protocol metadata, operation headers, tool metadata, and Tasks extension support.
- Native Tasks methods are supported: `tasks/get`, `tasks/update`, `tasks/cancel`.
- `tasks/list`, `check_task_status`, `isAsync`, and bespoke polling endpoints are intentionally not implemented.

---

## Authentication and request context

HTTP requests are authenticated before protocol execution.

Supported auth modes:

| Mode | Env | Current use |
| --- | --- | --- |
| API key | `MCP_AUTH_MODE=api_key` | Local/dev HTTP only; rejected for production HTTP. |
| JWT shared secret | `MCP_AUTH_MODE=jwt` | Symmetric deployments. Production requires issuer, audience, and resource URI. |
| OIDC JWKS | `MCP_AUTH_MODE=oidc_jwks` | Remote IdP / OAuth Resource Server deployments. |

### API key mode

```env
MCP_AUTH_MODE=api_key
MCP_API_KEY=<at-least-32-chars>
```

Client header:

```http
x-api-key: <key>
```

### JWT mode

```env
MCP_AUTH_MODE=jwt
MCP_JWT_SECRET=<at-least-32-chars>
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=karma-api
MCP_RESOURCE_URI=https://api.example.com/mcp
```

JWT context is derived from claims:

| Context field | Claims |
| --- | --- |
| `tenantId` | `mcp_tenant_id` or `tenant_id`; required. |
| `userId` | `sub` or `user_id`; fallback `jwt-user`. |
| `clientId` | `azp` or `client_id`; fallback `jwt-client`. |
| `scopes` | `scope` space-separated string or `scopes` array; capped at 32. |

### OIDC JWKS mode

```env
MCP_AUTH_MODE=oidc_jwks
MCP_JWKS_URI=https://idp.example.com/.well-known/jwks.json
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=karma-api
MCP_RESOURCE_URI=https://api.example.com/mcp
```

### Resource indicator enforcement

When `MCP_RESOURCE_URI` is configured, JWT/OIDC tokens must carry `aud` equal to or containing `MCP_RESOURCE_URI`, or a `resource` claim equal to it.

### Scopes

Tools may declare `requiredScopes`. Missing scopes reject tool calls before the handler executes for all non-stdio auth types.

---

## Native Tasks

KARMA supports native Tasks-style long-running execution.

Supported methods:

| Method | Purpose |
| --- | --- |
| `tasks/get` | Return task status, pending input requests, terminal result, error, or cancel reason. |
| `tasks/update` | Provide `inputResponses` for a task that is `input_required`. |
| `tasks/cancel` | Cancel a running or input-waiting task. |

Task ownership is scoped by `tenantId + clientId + userId`. `tasks/update` is state-gated and nonce-bound — only valid while the task is `input_required`, using the current `inputRequestId`.

---

## Tool execution pipeline

A tool call passes through these stages in `src/mcp/adapter/execution_pipeline.ts`:

1. Resolve request context.
2. Verify plugin manifest stability.
3. Apply rate limit and quota.
4. Enforce required scopes for all non-stdio auth types.
5. Apply safe-mode/security policy checks.
6. Validate JSON-serializable args for idempotency.
7. Generate and acquire an idempotency key.
8. Acquire a tenant execution lock (transient Redis errors retried within deadline; permanent errors rethrown immediately).
9. Validate input schema.
10. Execute tool handler with timeout/abort signal.
11. Validate output schema when present.
12. Run output firewall over text and structured content.
13. Save state.
14. Commit idempotency result; for non-idempotent tools that have started, keep the record on transient failure (`commitError`) so an auto-retry cannot double-execute an irreversible side-effect.
15. Log telemetry and OTEL spans.

---

## Storage and encryption

Storage drivers:

| Driver | Env | Use |
| --- | --- | --- |
| Local filesystem | `STORAGE_DRIVER=fs` | Local/dev durable state. |
| Redis | `STORAGE_DRIVER=redis` | Production durable state, tasks, idempotency, quota/rate data. |
| Memory | `STORAGE_DRIVER=memory` | Tests and ephemeral local HTTP. |

`MCP_ENCRYPTION_KEY` enables encryption-at-rest for state/vault blobs. Supported formats:

- Passphrase-style secret: per-blob scrypt derivation to an A256GCM JWE key.
- Raw key: `base64url:<32-byte-base64url-key>`.

Envelope formats (priority order):

```text
smcp:v4:kms:<base64url-json-SealedBlob>             ← primary when KMS_PROVIDER is set
smcp:v3:hkdf-tenant:<salt-base64url>:<compact-jwe>  ← primary without KMS_PROVIDER
smcp:v2:scrypt:<salt-base64url>:<compact-jwe>       ← fallback (no tenantId)
```

KMS providers:

| Provider | `KMS_PROVIDER` | Erasure model |
| --- | --- | --- |
| Local (dev/test only) | `local` | In-process; no real erasure. Rejected in production. |
| HashiCorp Vault Transit | `vault` | Immediate (key deletion in Transit). |
| AWS KMS | `aws-kms` | `DisableKey` (immediate) + `ScheduleKeyDeletion` (7-day mandatory). |
| GCP Cloud KMS | `gcp-kms` | `DESTROY_SCHEDULED` (immediately unusable, 24 h permanent). |

**Note on task record encryption:** Task records (including `lastClientInput.inputResponses`) are stored as plain JSON in Redis via `RedisTaskStore`. They are not covered by `MCP_ENCRYPTION_KEY` — that applies only to state and vault blobs. Ensure Redis is encrypted at rest and access-controlled at the infrastructure level.

To migrate pre-V4 blobs:

```bash
KMS_PROVIDER=vault pnpm migrate:encryption
```

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

| Variable | Default | Meaning |
| --- | ---: | --- |
| `MCP_IDEMPOTENCY_WORKING_TTL_SECONDS` | `600` | TTL for in-progress idempotency records. |
| `MCP_IDEMPOTENCY_RESULT_TTL_SECONDS` | `604800` (Redis), `3600` (non-Redis) | TTL for successful cached results. |
| `MCP_IDEMPOTENCY_ERROR_TTL_SECONDS` | `300` | TTL for permanent error cache records. |
| `MCP_LOCK_TTL_MS` | `420000` | Tenant execution lock TTL. |
| `MCP_LOCK_ACQUIRE_DEADLINE_MS` | `420000` | Max wait to acquire tenant lock. |

The KARMA bounded-write receipt timeout (`RECEIPT_TIMEOUT_MS=300_000`) is deliberately set below `MCP_LOCK_TTL_MS` so a slow transaction never outlives its execution lock.

---

## Output firewall

The output firewall scans tool results before returning them and before committing idempotency results.

Covered surfaces:

- `content[].text`.
- `structuredContent` recursively.

Detected patterns include: private-key blocks, OpenAI-like keys, GitHub-like tokens, AWS access key IDs, Luhn-valid payment cards, SSN-like values, prompt-injection markers, and sensitive field names (`apiKey`, `secret`, `token`, `password`, `authorization`, `private_key`, and related variants).

**Error path (A2):** thrown tool errors are also sanitized — every error funnels through a single
`toClientError` chokepoint in `execution_pipeline.ts` and is passed through `redactErrorText`
(credentials/PII + filesystem paths + redis/postgres connection strings + bare private-key-shaped
`0x`+64hex, error-path-only) before the message reaches the client. The full error is retained
server-side in telemetry. `scanToolOutput` is deliberately left unchanged so legitimate
`result_hash`/`taskHash` values in normal output are never mangled.

Strict PII mode (opt-in):

```env
MCP_OUTPUT_FIREWALL_PII_MODE=strict
```

Strict mode additionally redacts email and phone-like values.

---

## Plugin system

Plugin files live in `src/plugins/`. Accepted filenames: `*.tool.ts` and `*.tool.js`.

### Built-in plugins

| Plugin | Notes |
| --- | --- |
| `system.tool.ts` | Always loaded. Provides `karma_ping`, `karma_pattern_debt`, and `karma_test_long_task` (dev only). |
| `karma.tool.ts` | KARMA skill economy. **Must** be trusted built-in (`MCP_PLUGIN_ISOLATION_MODE=policy`). Requires `MCP_SAFE_MODE=false`. |

### `karma.tool.ts` isolation requirement

`karma.tool.ts` must **not** be loaded through the external child-process runner:

- `keystoreManager` is a module singleton loaded once at startup; the external runner reinitializes it empty every call.
- `skillIndex` is a module singleton; the external runner loses all indexed documents.
- `process.env.PHAROS_*` and `process.env.KEYSTORE_*` are stripped by `workerEnv()` in the external runner.
- `assertInProcess()` in every handler throws if the runtime is not explicitly trusted (`!isTrustedRuntime()`) or if it detects the legacy worker environment (`KARMA_PLUGIN_WORKER=1`).

Required configuration:

```env
MCP_PLUGIN_ALLOWLIST=system.tool.js,system.tool.ts,karma.tool.ts
MCP_PLUGIN_ISOLATION_MODE=policy
MCP_SAFE_MODE=false
```

### SHA-256 allowlist (production non-built-in plugins)

```env
MCP_PLUGIN_SHA256_ALLOWLIST=my_plugin.tool.js:<sha256>
```

Required in production for any plugin that is not `system.tool` or `karma.tool`.

### Isolation modes

| Mode | Behavior |
| --- | --- |
| `external` | Non-built-in plugins run through `ChildProcessPluginRunner`. |
| `policy` | Trusted-only mode. Non-built-in plugins are rejected. Required for `karma.tool.ts`. |

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
    inputSchema: { message: z.string().min(1) },
    allowedPhases: ["intake", "execution", "review", "completed"],
    capabilities: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: { taskSupport: "forbidden" },
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

---

## HTTP endpoints and headers

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
Mcp-Name: <params.name>   (tools/call only)
```

---

## Docker / Compose

Build the image:

```bash
docker build -f Containerfile -t karma:local .
```

`compose.yaml` includes Redis and a hardened server container with read-only filesystem, `/tmp` tmpfs, dropped Linux capabilities, `no-new-privileges`, pid and memory limits.

A production-compatible JWT `.env` for Compose:

```env
REDIS_PASSWORD=change-this-redis-password
MCP_ENCRYPTION_KEY=base64url:<32-byte-base64url-key>
MCP_IDEMPOTENCY_SECRET=change-this-idempotency-secret-at-least-32-chars

MCP_AUTH_MODE=jwt
MCP_JWT_SECRET=change-this-jwt-secret-with-at-least-32-chars
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=karma-api
MCP_RESOURCE_URI=https://api.example.com/mcp
MCP_AUTHORIZATION_SERVERS=https://idp.example.com

ALLOWED_HOSTS=api.example.com
ALLOWED_ORIGINS=https://app.example.com

PHAROS_CONTRACT_ADDRESS=0x<deployed-address>
```

Run:

```bash
docker compose up --build
```

---

## Configuration reference

All Layer 0 configuration is read in `src/config/env.ts`. KARMA app-layer env vars are read directly in `src/lib/contract.ts` and `src/plugins/karma.tool.ts`.

### Core runtime

| Variable | Default | Notes |
| --- | ---: | --- |
| `TRANSPORT_DRIVER` | `stdio` | `stdio` or `http`. |
| `HTTP_HOST` | `127.0.0.1` | HTTP bind host. |
| `HTTP_PORT` | `3333` | HTTP bind port. |
| `MCP_PROTOCOL_MODE` | `rc2026` | Only supported value. |
| `MCP_PROJECT_ID` | `karma_default` | Namespace for Redis/vault keys. |
| `MCP_TENANT_ID` | `tenant_local` | Local/stdio fallback tenant. |
| `MCP_SAFE_MODE` | `true` | Blocks `network` capability tools (including all KARMA tools). Set `false` to enable app layer. |
| `MCP_TOOL_TIMEOUT_MS` | `300000` | Per-tool timeout. |

### Pharos / KARMA app layer

| Variable | Default | Notes |
| --- | ---: | --- |
| `PHAROS_RPC_URL` | `https://atlantic.dplabs-internal.com` | Pharos Atlantic HTTP-RPC. |
| `PHAROS_CHAIN_ID` | `688689` | Live-verified chain ID. |
| `PHAROS_CONTRACT_ADDRESS` | unset | Required for all contract calls. Deploy first. |
| `PHAROS_EXPLORER` | `https://atlantic.pharosscan.xyz` | Explorer base URL for demo links. |
| `KEYSTORE_PATH` | `./keystore.json` | Web3 v3 keystore file (multi-agent). |
| `KEYSTORE_PASSWORD` | unset | Keystore decryption password. Required for write ops. |
| `KARMA_DEFAULT_AGENT_TENANT` | unset (→ `MCP_TENANT_ID`) | Tenant a keystore agent binds to when its entry omits `tenant` (STRIDE-S, fail-closed). Set to the live tenant id in api-key/gateway deployments. |
| `KARMA_SOCIAL_GRAPH_MAX_JOBS` | `500` | Cap on job edges `query_social_graph` `format:"full"` hydrates (chunked by 100); over the cap, the most-recent edges are kept and `summary.truncated=true`. |
| `KARMA_INDEXER_FROM_BLOCK` | `0` | Block the `SkillEventIndexer` backfills from on boot. Set to the contract deploy block after a (re)deploy to skip stale history. |
| `KARMA_INDEXER_BLOCK_RANGE` | `2000` | Maximum block window per `eth_getLogs` call during indexer backfill. Prevents oversized requests on a genesis or long catch-up backfill. |
| `KARMA_DISCOVERY_RANK` | `bm25` | Set to `flow` to enable Tier-1 Flow Reputation ranking for discovery (requires bond seed). |
| `KARMA_FLOW_MAX_EDGES` | `500000` | Maximum edges retained by `FlowReputationGraph` (DoS cap). Raised from 50k; increase for denser long-window graphs. |
| `DEMO_PRICE_WEI` | `100000000000000` | Default skill price for `run_demo.ts`. |

### HTTP security

| Variable | Default | Notes |
| --- | ---: | --- |
| `ALLOWED_HOSTS` | empty | Required in HTTP mode. |
| `ALLOWED_ORIGINS` | empty | Required in HTTP mode. |
| `MCP_HTTP_BODY_LIMIT` | `100kb` | Express JSON body limit. |
| `MCP_TRUST_IDENTITY_HEADERS` | `false` | Trust upstream `x-mcp-*` identity headers only behind a trusted gateway. |

### Authentication

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_AUTH_MODE` | `api_key` | `api_key`, `jwt`, `oidc_jwks`. Production HTTP rejects `api_key`. |
| `MCP_API_KEY` | unset | Required for API-key HTTP, minimum 32 chars. |
| `MCP_JWT_SECRET` | unset | Required for JWT HTTP, minimum 32 chars. |
| `MCP_JWT_ISSUER` | unset | Optional for dev JWT; required for production JWT and all OIDC. |
| `MCP_JWT_AUDIENCE` | unset | Optional for dev JWT; required for production JWT and all OIDC. |
| `MCP_JWKS_URI` | unset | Required for HTTP OIDC JWKS. Must be URL. |
| `MCP_JWKS_ALLOWLIST` | empty | Comma-separated hostname allowlist for JWKS fetches. |
| `MCP_JWT_MAX_AGE_SECONDS` | `3600` | Maximum accepted token age. |
| `MCP_RESOURCE_URI` | unset | Required for production JWT/OIDC HTTP. |
| `MCP_AUTHORIZATION_SERVERS` | empty | Comma-separated authorization servers. |

### Storage and encryption

| Variable | Default | Notes |
| --- | ---: | --- |
| `STORAGE_DRIVER` | `fs` | `fs`, `redis`, or `memory`. Production requires `redis`. |
| `REDIS_URL` | unset | Required when `STORAGE_DRIVER=redis`. |
| `MCP_ENCRYPTION_KEY` | unset | Enables encryption. Required with Redis. |
| `MCP_ALLOW_LEGACY_SHA256_KDF` | `false` | One-time migration waiver. |
| `MCP_REQUIRE_CRYPTO_ERASURE` | `false` | Production fail-closed flag; requires real KMS provider. |

### KMS and crypto-erasure

| Variable | Default | Notes |
| --- | ---: | --- |
| `KMS_PROVIDER` | unset | `vault`, `aws-kms`, `gcp-kms`, or `local`. `local` rejected in production. |
| `VAULT_ADDR` | unset | Required when `KMS_PROVIDER=vault`. |
| `VAULT_TOKEN` | unset | Required when `KMS_PROVIDER=vault`. |
| `AWS_KMS_REGION` | unset | Required when `KMS_PROVIDER=aws-kms`. |
| `GCP_KMS_PROJECT` | unset | Required when `KMS_PROVIDER=gcp-kms`. |
| `GCP_KMS_KEYRING` | unset | Required when `KMS_PROVIDER=gcp-kms`. |

### Telemetry

| Variable | Default | Notes |
| --- | ---: | --- |
| `TELEMETRY_DRIVER` | `stderr` (stdio), `file` (HTTP) | `file`, `stdout`, `stderr`. `stdout` forbidden with stdio. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Enables OTLP export when configured. |

### Abuse controls

| Variable | Default | Notes |
| --- | ---: | --- |
| `ENABLE_RATE_LIMIT` | `false` | Production HTTP requires `true` unless waived. |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Requests per window. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window duration in ms. |
| `ENABLE_QUOTA` | `false` | Production HTTP requires `true` unless waived. |
| `QUOTA_DAILY_LIMIT` | `1000` | Daily tenant quota. |
| `MCP_ALLOW_UNLIMITED_HTTP` | `false` | Explicit production waiver for disabling rate/quota startup requirement. |

### Idempotency and locks

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_LOCK_TTL_MS` | `420000` | Tenant lock TTL. |
| `MCP_LOCK_ACQUIRE_DEADLINE_MS` | `420000` | Max wait to acquire tenant lock. |
| `MCP_IDEMPOTENCY_SECRET` | unset | Min-32-char HMAC secret. **Required when `STORAGE_DRIVER=redis`.** |

### Plugin loading and runner

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_PLUGIN_ALLOWLIST` | `system.tool.js,system.tool.ts` | Comma-separated plugin filenames. Add `karma.tool.ts` for the app layer. |
| `MCP_PLUGIN_ISOLATION_MODE` | `external` | `external` or `policy`. Use `policy` when `karma.tool.ts` is enabled. |
| `MCP_PLUGIN_SHA256_ALLOWLIST` | empty | `filename:sha256` hash pins. Required in production for non-built-in plugins. |
| `MCP_PLUGIN_AUTO_DISCOVERY` | `false` | Auto-load matching plugin files (requires unsafe waiver). |
| `MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX` | `false` | Production waiver for non-built-in plugins before real sandbox exists. |
| `MCP_EXTERNAL_PLUGIN_TIMEOUT_MS` | `30000` | Child runner timeout. |
| `MCP_EXTERNAL_PLUGIN_NETWORK_POLICY` | `deny` | `deny` or `allow`. |
| `MCP_EXTERNAL_PLUGIN_FS_POLICY` | `read-only` | `read-only` or `allow`. |
| `MCP_EXTERNAL_PLUGIN_NODE_PERMISSION` | `false` | Optional Node Permission Model hardening. |

### Secrets and output firewall

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_SECRET_ALLOWLIST` | empty | Secret names available through the credential vault. |
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
  "audit": "pnpm audit --audit-level=high",
  "deps:check": "pnpm outdated",
  "migrate:encryption": "tsx src/scripts/migrate_encryption.ts",
  "check:connectivity": "tsx src/scripts/check_connectivity.ts",
  "setup:keystore": "tsx src/scripts/setup_keystore.ts",
  "demo": "tsx src/scripts/run_demo.ts",
  "demo:discover": "tsx src/scripts/discover_demo.ts",
  "demo:verify": "tsx src/scripts/verify_demo.ts",
  "test:contract": "forge test",
  "test:enterprise": "vitest run src/__tests__/task_runtime.test.ts ... (see package.json)"
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
pnpm test:contract
pnpm audit --audit-level=high
```

### Enterprise coverage areas (Layer 0)

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

### KARMA app-layer test suites

| Test file | Coverage |
| --- | --- |
| `karma_builtin_plugin.test.ts` | Plugin loads as trusted built-in; `assertInProcess` canary. |
| `karma_contract.test.ts` | ABI structural drift guard vs Foundry artifact. |
| `karma_exactly_once.test.ts` | `deriveTaskHash` exactly-once dedup logic (now O(1) `jobByTaskHash` on-chain). |
| `karma_service_integration.test.ts` | realKarmaService ↔ anvil end-to-end: register→read→create→dedup→deliver→confirm→withdraw + dispute + bond, covering v3 decode paths (skips without anvil). Closes PD-002. |
| `migrate_to_v2.test.ts` | Pure `planMigration` v1→v2 filter/sort/threshold-default. |
| `execution_pipeline_error_redaction.test.ts` | `toClientError` redaction (incl. private-key hex) + `isTenantMismatchError` (PD-006). |
| `karma_indexer.test.ts` | `SkillEventIndexer` backfill, reconnect, heartbeat state machine. |
| `skill_indexer_runtime.test.ts` | Chain-event → BM25 reconciliation (`applyIndexedEvent`), indexer-health surfacing, and hybrid boost (`makeFlowHybridBoost`). |
| `flow_reputation.test.ts` | `FlowReputationGraph` / `FlowBoostSource` / `computeFlowReputation`: determinism, value-weighting, decay, saturation, Sybil-ring crush, bond seed, DoS cap (`DEFAULT_MAX_FLOW_EDGES`). |
| `karma_plugin_health.test.ts` | `karma_health` tool: env detection, in-process flag. |
| `karma_tools.test.ts` | All 13 economy tools over a fake `KarmaService`; tenant threading + on-chain Trust Gate + fan-out cap. |
| `karma_write_helper.test.ts` | `runBoundedWrite` confirmed/pending/revert paths. |
| `bm25_index.test.ts` | `BM25SkillIndex`: upsert, discard, search, reputation boost, price filter, sanitize. |
| `keystore.test.ts` | Web3 v3 decrypt/encrypt round-trip; MAC mismatch; wrong KDF/cipher. |
| `serialize.test.ts` | `jsonSafe` BigInt, nested, array paths. |
| `schema_guard.test.ts` | JSON Schema 2020-12 input/output validation. |

Additional suites (run via `pnpm test` or individually):

- `encryption_kms.test.ts` — V4 KMS envelope paths.
- `caching_key_registry.test.ts` — DEK cache TTL, use-count, zeroed-on-eviction.
- `audit_store.test.ts` — `FileAuditStore` JSONL append.
- `local_key_registry.test.ts`, `vault_key_registry.test.ts`, `gcp_kms_key_registry.test.ts` — KMS providers.
- `holyseed_patterns.test.ts` — Sensitive-pattern detection.
- `registrar_governance.test.ts` — Plugin/tool registration governance.
- `runtime_identity.test.ts` — fail-closed trusted-runtime marker for the `karma.tool` canary.
- `double_execution_guard.test.ts` — `canReleaseIdempotency` / `isIdempotentTool` / `isTransientError` invariants; `TaskTracker` thunk-accept and drain-gate TOCTOU (Fix 1-4 / ADR-006).
- `demo_format.test.ts` — zero-dep demo presentation helpers (`paint` / `short` / `reveal`).
- `sanitize.test.ts`, `otel.test.ts`, `file_logger.test.ts`, `tool_metadata.test.ts` — Supporting subsystems.

---

## Pattern debt and limitations

KARMA keeps residual security/design debt visible instead of hiding it.

Runtime report tool: `karma_pattern_debt` (reads from `src/core/pattern_debt.ts` at runtime).

Debt registries:
- `src/core/pattern_debt.ts` — Layer 0 runtime items DEBT-001 to DEBT-007, queried live by `karma_pattern_debt`.
- `docs/superpowers/pattern-debt.md` — KARMA app-layer items PD-001 to PD-008, tracked separately.

### Layer 0 debt (DEBT-001 to DEBT-007)

Authoritative source: `src/core/pattern_debt.ts`. The table below reflects the **codebase state** as of 2026-06-17.

| Debt | Status | Current truth |
| --- | --- | --- |
| `DEBT-001-plugin-os-isolation` | **Open, release-blocking** | Current runner is child-process best-effort only. No container, Wasmtime, or microVM boundary. Production non-built-in plugin config fails closed unless explicitly waived. |
| `DEBT-002-crypto-erasure` | **Implemented / resolved** | `smcp:v4:kms` envelope and four KMS providers (`Local`, `Vault`, `AWS KMS`, `GCP KMS`) shipped 2026-06-14; `src/core/pattern_debt.ts` reconciled to `implemented`. `MCP_REQUIRE_CRYPTO_ERASURE=true` requires a real KMS provider. Residual: AWS KMS 7-day pending-deletion window. |
| `DEBT-003-native-mcp-tasks` | **Monitoring** | Custom Tasks adapter remains isolated until the TypeScript SDK exposes stable public Tasks APIs. |
| `DEBT-004-oauth-resource-indicator` | **Implemented** | JWT/OIDC resource indicator enforced when configured; production requires resource URI. |
| `DEBT-005-output-firewall-coverage` | **Partially resolved** | Structured redaction implemented with deterministic patterns and limits. No DLP/classifier backend. |
| `DEBT-006-redis-trauma-registry` | **Implemented** | Redis/memory rate limiters use bounded violation records with severity EMA/backoff. |
| `DEBT-007-agent-key-erasure-boundary` | **Monitoring** | KARMA agent signing keys (Web3 v3 keystore) are operator-provisioned infrastructure credentials — deliberately outside the `smcp:v4:kms` per-tenant crypto-erasure boundary. `KeystoreManager.unload(agentId)/clear()` drop decrypted viem accounts for agent offboarding / graceful shutdown; `assertOwnedBy` enforces tenant→agent authz before any signing account is handed out. True key-zeroization / tenant self-service offboarding requires an out-of-process signer or HSM (out of scope). |

### KARMA app-layer debt (PD-001 to PD-008)

Documented in `docs/superpowers/pattern-debt.md`.

| Debt | Status | Current truth |
| --- | --- | --- |
| `PD-001` — pre-existing Layer-0 test failures | **Resolved** (2026-06-16, commit `db7ea72`) | 8 stale tests aligned to post-hardening code; 1 env-locked test skip-guarded. |
| `PD-002` — network glue has live-only coverage | **Resolved** (2026-06-17) | `karma_service_integration.test.ts` exercises realKarmaService against a real EVM (anvil) end-to-end — register→read→create→O(1) dedup→deliver→confirm→withdraw + dispute + bond — covering the readContract/writeContractBounded decode paths. Skips cleanly without anvil/artifact. |
| `PD-003` — exactly-once guard is O(n) scan | **Resolved** (2026-06-17, v3 live) | Replaced by the on-chain `jobByTaskHash` mapping; `findExistingJob` is now an O(1) read. Live on v3 `0x0680…79b4`. |
| `PD-004` — skill indexer has no persisted checkpoint | **Open** | `SkillEventIndexer` backfills from `KARMA_INDEXER_FROM_BLOCK` (or 0) on every boot — no persisted `lastIndexedBlock`. Low-payoff on a fresh testnet; revisit at scale / multi-instance. |
| `PD-005` — Trust Gate was app-layer advisory | **Resolved** (2026-06-17, v3 live) | On-chain `agentReputation` + `Skill.minReputationToInvoke` + `createJob` require — consensus-enforced. Residual: wash-trade resistance needs stake/identity (out of scope). |
| `PD-006` — no tenant-mismatch alarm signal | **Resolved** (2026-06-17) | The pipeline classifies `isTenantMismatchError` and emits a distinct `tenant_agent_mismatch` telemetry event for security monitoring. |
| `PD-007` — Reputation farmable by wallet ring | **Resolved (2026-06-18)** | Tier-0 (self-deal guard widened to `reputationScore` + `totalInvocations`), Tier-1 (`KARMA_DISCOVERY_RANK=flow` EigenTrust-lite ranking via `flow_reputation.ts`), and Tier-2 (per-agent bond, 7-day cooldown, agent-alpha seeded 0.005 PHRS) all live on v3. |
| `PD-008` — No quality-slashing of Sybil bonds | **Open** | Sybil bonds are capital lock-ups but not quality-slashed on dispute (deferred by design). |

Non-goals intentionally preserved:

- No fake DLP backend.
- No TokenManager or server-side PKCE.
- No `karma.tool.ts` in the external child-process runner (in-process only by design).
- No claim that child process or Node Permission Model equals OS/container sandboxing.
- `RECEIPT_TIMEOUT_MS` is a bounded wait for a broadcast tx; timed-out transactions are on the wire and must not be resent.

---

## Troubleshooting

### `pnpm lint` fails

Check ESLint output for style or formatting errors in `src`.

### Production HTTP exits with `MCP_AUTH_MODE=api_key is for local/dev only`

Production HTTP rejects API key mode. Use `MCP_AUTH_MODE=jwt` or `MCP_AUTH_MODE=oidc_jwks`.

### `[KARMA] PHAROS_CONTRACT_ADDRESS not set`

Deploy `AgentSkillRegistry` first and record the address in `.env`:

```env
PHAROS_CONTRACT_ADDRESS=0x<deployed-address>
```

### `[KARMA] karma.tool.ts must run in-process`

`assertInProcess()` threw because the tool was invoked in the external child-process runner. Set:

```env
MCP_PLUGIN_ISOLATION_MODE=policy
```

### `[KARMA] Agent not found in keystore: agent-alpha`

The keystore was not loaded, or the agent ID does not exist in the keystore file. Ensure:

- `KEYSTORE_PATH` points to a valid keystore file.
- `KEYSTORE_PASSWORD` is correct.
- The agent ID was generated with `pnpm setup:keystore`.

### `[KARMA] Keystore MAC mismatch`

Wrong `KEYSTORE_PASSWORD` or corrupt keystore file.

### `[KARMA] agent '<id>' is not accessible to this tenant`

STRIDE-S tenant→agent isolation: the calling `tenantId` does not own that keystore agent. Either the
agent's `tenant` field (or the `KARMA_DEFAULT_AGENT_TENANT` fallback) doesn't match the request tenant.
In api-key/gateway HTTP the request tenant is **not** `MCP_TENANT_ID` — set `KARMA_DEFAULT_AGENT_TENANT`
to the live tenant id, or give each keystore agent an explicit `tenant`. A `tenant_agent_mismatch`
telemetry event is emitted for monitoring.

### `karma_health` returns `rpcEnv=false` or `contractEnv=false`

Set `PHAROS_RPC_URL` and `PHAROS_CONTRACT_ADDRESS` in the environment.

### `create_job` returns `status: "exists"`

This is correct idempotent behavior. The same `(requester, skillId, idempotencyNonce)` triple was already used. Use a new nonce for a new job.

### `create_job` or `register_skill` returns `status: "pending"`

The transaction was broadcast but the receipt did not arrive before `RECEIPT_TIMEOUT_MS=300_000`. The transaction is on the wire — **do not resend**. Poll the explorer for the tx hash from the response, or retry with the same `idempotencyNonce` (which will detect the existing job via the on-chain `jobByTaskHash` mapping once confirmed).

### `discover_skills` returns 0 results after restart

The in-process BM25 index is rebuilt from `SkillEventIndexer` on startup. Wait for the indexer to finish backfilling — call `karma_health` and watch the `indexer` field (`watching: true` with a non-zero `lastIndexedBlock` means it has caught up). If `indexer` reports `{ started: false }`, the indexer never started — ensure `PHAROS_CONTRACT_ADDRESS` is set, `MCP_SAFE_MODE` is off, and the contract is accessible.

### `MCP_SAFE_MODE=true` blocks `karma_health` and all economy tools

All KARMA tools declare the `network` capability, which safe mode blocks. Set:

```env
MCP_SAFE_MODE=false
```

### Deployer has 0 balance

Fund `agent-alpha` from a Pharos Atlantic faucet before deploying:

- [Stakely](https://stakely.io/faucet/pharos-atlantic-testnet-phrs)
- [gas.zip](https://www.gas.zip/faucet/pharos)
- [Chainlink](https://faucets.chain.link/pharos-atlantic-testnet)

### `forge test` fails with missing dependencies

Run `forge install` to install OpenZeppelin contracts, then rebuild:

```bash
forge install
forge build
```

### Production HTTP exits because rate limit or quota is missing

Set `ENABLE_RATE_LIMIT=true` and `ENABLE_QUOTA=true`, or explicitly set `MCP_ALLOW_UNLIMITED_HTTP=true` as a documented waiver.

### HTTP returns `403 Invalid Host`

Set `ALLOWED_HOSTS` to include the exact Host header, including port:

```env
ALLOWED_HOSTS=127.0.0.1:3333,localhost:3333
```

### JWT/OIDC request returns `401 Unauthorized`

Check issuer, audience, resource URI, tenant claim, scopes, and token age (`MCP_JWT_MAX_AGE_SECONDS`, default 3600).

### `tasks/update` returns `Task is not waiting for input`

The task is not currently `input_required`. Poll `tasks/get` first.

### Redis Lua operations fail or behave incorrectly

Upgrade Redis to **8.2.2 or later**. CVE-2025-49844 (Lua GC Use-After-Free, CVSS 10.0) affects Redis ≤ 8.2.1.

### `MCP_REQUIRE_CRYPTO_ERASURE=true` causes fatal startup

In production, this requires `KMS_PROVIDER=vault`, `aws-kms`, or `gcp-kms`. `local` is rejected.

---
