# SUPER-MCP Test Coverage Matrix

This matrix is the enterprise regression plan for the current codebase. It maps the main threat / reliability surfaces to executable Vitest suites and calls out the remaining suites that should become mandatory once the corresponding runtime capabilities exist.

## Always-on local/CI gates

Run these on every pull request:

```bash
npm run typecheck
npm run test:enterprise
npm audit --audit-level=high
```

The child-process plugin runner suite is intentionally split into focused commands because it spawns many workers and is slower/flakier than the pure unit gates:

```bash
npm run test:plugin:lifecycle
npm run test:plugin:worker
npm run test:plugin:permission
```

## Coverage by risk area

| Area | Current executable suites | Gate intent |
| --- | --- | --- |
| Native Tasks state machine | `task_runtime.test.ts`, `task_store.test.ts`, `http_tasks_conformance.test.ts` | Reject early/stale/duplicate task input, require nonce, consume once, verify cancel/poll ownership boundaries. |
| JWT/OIDC authentication | `jwt_auth_runtime.test.ts`, `auth_resource_indicator.test.ts`, `oidc_auth.test.ts`, `env_validation.test.ts` | Verify real HS256 JWTs, issuer/audience/resource binding, tenant claim requirement, JWKS cache behavior, production config fail-fast. |
| Identity and scope context | `request_context_security.test.ts`, `scope_enforcement.test.ts`, `security_regression.test.ts` | Ignore spoofable identity headers by default, enforce trusted gateway allowlist, sanitize IDs/scopes, reject missing tool scopes before handler execution. |
| HTTP protocol/security | `http_security.test.ts`, `protocol_header.test.ts`, `oauth_metadata.test.ts`, `security_regression.test.ts` | Enforce JSON content types, MCP protocol headers, protected resource metadata, host-header-safe `WWW-Authenticate`. |
| Abuse controls | `rate_limit.test.ts`, `env_validation.test.ts` | Verify limiter behavior and production requirement for rate limit/quota or explicit waiver. |
| Idempotency and locks | `idempotency.test.ts`, `execution_lock.test.ts`, `task_store.test.ts` | Verify acquire/commit/release semantics, Redis reverse indexes, task persistence, cancellation durability. |
| Output and telemetry safety | `output_firewall.test.ts`, `output_firewall_strict_pii.test.ts`, `otel.test.ts`, `file_logger.test.ts` | Ensure secret/PII redaction, telemetry safety, bounded logs, and no stdout pollution in stdio mode. |
| Plugin policy and best-effort isolation | `plugin_external_runner.test.ts`, `security_policy.test.ts`, `env_validation.test.ts`, `pattern_debt.test.ts` | Verify JS-level blocking and fail-closed production config until a real OS/container/WASM sandbox exists. |
| Storage encryption | `security_regression.test.ts`, `encryption_negative.test.ts`, `redis_backup.test.ts` | Verify v2 envelope round-trip, wrong-key denial, malformed envelope denial, Redis backup rotation. |
| Vault / secret access | `vault.test.ts`, `security_regression.test.ts` | Enforce safe secret names, allowlist behavior, and deny unsafe access paths. |
| Governance docs and debt registry | `pattern_debt.test.ts`, `registrar_governance.test.ts`, `tool_metadata.test.ts` | Keep release-blocking debts explicit and ensure system tool metadata remains governed. |

## Future mandatory suites once release-blocking epics are implemented

### Real plugin sandbox runner

Add container/microVM/WASM contract tests that run malicious plugins outside the trusted Node process and assert:

- outbound egress is denied by default and only allowed by explicit allowlist;
- filesystem is read-only except explicit scratch/artifact mounts;
- symlink and path traversal writes fail;
- process spawning, nested workers, `vm`, DNS, raw sockets, and top-level side effects fail;
- CPU and memory quotas terminate runaway plugins;
- artifact egress policy blocks unapproved files and metadata.

### Crypto-erasure v3 runtime

Add KMS-backed per-tenant/user DEK tests that assert:

- new writes use `smcp:v3` envelopes with key ids and versions;
- tenant/user key rotation preserves decrypt for old versions until destroy;
- v2-to-v3 migration is one-shot, audited, and rollback-safe;
- destroyed keys produce persisted receipts;
- decrypt attempts after destroy are denied and audited as `decrypt_denied`;
- cross-tenant key ids cannot decrypt another tenant's blob.

### Full-system reliability soak

Add longer-running tests outside the unit suite:

- Redis lock lost while a tool is running aborts the tool;
- heartbeat failure releases idempotency locks;
- task TTL cleanup removes forward and reverse indexes;
- graceful shutdown drains active tasks;
- repeated reconnect polling across process restarts returns the same terminal task result.
