# Phase 5 — Pattern Debt Review

Phase 5 is a documentation-and-governance pass, not an implementation sprint. The shared lesson from the prior phase is that invariants belong to the concept, not to one code path. For these debt items, the invariant is: **do not ship a placeholder integration that looks like a security boundary but is not one**.

## Decision

Keep DEBT-001, DEBT-002, and DEBT-005 documented and monitored. Add runtime-visible reporting and sharper acceptance criteria, but do not add partial external isolation, partial crypto-erasure, or partial DLP plumbing yet.

## DEBT-001 — Plugin OS isolation

Current state: plugin loading is constrained by allowlists, optional SHA-256 pinning, capability declarations, safe mode, and startup manifest pinning. `MCP_PLUGIN_ISOLATION_MODE=external` is now the default for non-built-in plugins; `policy` mode is trusted-only and rejects non-built-ins instead of running them in-process.

Implementation gate: the current external runner is a child-process boundary with a scrubbed environment, timeout, memory cap, process-spawn denial, default network denial, and read-only filesystem mutation guards. Full untrusted third-party isolation is not ready until a container, microVM, WASM, or equivalent runner enforces filesystem, network, process, environment, CPU, memory, timeout, and artifact egress limits at the OS/runtime boundary.

Monitor:

- Node.js WASI stability and capability model.
- Standalone runtimes such as Wasmtime/WasmEdge when used through a worker/container boundary.
- MCP-specific sandbox projects that provide auditable source-to-sink/runtime reports.

Acceptance criteria before implementation:

1. `MCP_PLUGIN_ISOLATION_MODE=policy` rejects non-built-ins instead of silently downgrading to in-process execution.
2. Runner tests prove blocked filesystem mutation, network, process spawn, environment secret, timeout, and memory paths.
3. Plugin result egress passes through the same output firewall and telemetry pipeline.
4. Failure mode is fail-closed: unsupported isolation means plugin execution is rejected, not silently downgraded to policy mode.

## DEBT-002 — Crypto erasure

Current state: encrypted state uses a versioned scrypt envelope with per-blob salt, and raw base64url A256GCM keys are supported. Redis storage already requires `MCP_ENCRYPTION_KEY`.

Implementation gate: crypto-erasure cannot be claimed until state uses tenant/user DEKs wrapped by a KEK, every encrypted blob records key version metadata, and a tenant deletion can be represented as auditable DEK destruction.

Acceptance criteria before implementation:

1. Key registry API: create, resolve, rotate, disable, destroy, and audit tenant/user DEKs.
2. Encrypted blob envelope includes tenant/user key id and version.
3. Migration path re-encrypts existing blobs without data loss.
4. Destroyed DEKs make corresponding ciphertext undecryptable by design.
5. Tests cover stale key versions, rotation races, and missing registry entries.

## DEBT-005 — Output firewall coverage

Current state: `scanToolOutput` redacts common credentials, Luhn-valid cards, SSN-like identifiers, and prompt-injection markers before truncation and idempotency commit. Redactions emit telemetry.

Implementation gate: do not add a fake DLP adapter. A real deployment must define entity types, thresholds, latency budget, failure mode, audit shape, and structured-output policy.

Acceptance criteria before implementation:

1. DLP backend adapter has timeout and fail-closed/fail-open policy configured explicitly.
2. Tests cover false positives, false negatives, nested JSON text fields, and large payloads.
3. DLP results and local regex results merge into one violation vocabulary.
4. Sensitive deployment can prove backend availability and latency under load.
5. Non-sensitive local deployments stay deterministic and do not require network DLP calls.

## Operational visibility

`super_mcp_pattern_debt` exposes the registry as a read-only system tool. Server card metadata also includes a compact pattern-debt summary so clients/operators can see which debt items are still active without opening repository docs.

# Phase 9 reconciliation addendum

After remediation, the runtime and docs are synchronized as follows:

- **DEBT-005** is partially resolved for the concrete structured-output leak: `structuredContent` is recursively redacted with depth, node, string, total string, and cycle guards. Deterministic credentials-only mode remains the default; strict PII mode is opt-in. No fake DLP backend was added.
- **DEBT-004** is implemented/reframed for SUPER-MCP's actual role as an OAuth Resource Server. `MCP_RESOURCE_URI` is enforced against JWT `aud`/`resource` claims when configured. PKCE and TokenManager remain intentionally absent because they belong to clients.
- **DEBT-001** remains open. The child-process runner is materially hardened and pluggable, but neither child processes nor Node permission mode are claimed as an OS sandbox.
- **DEBT-002** remains open/design-ready. ADR 0002 and the type-only key registry contract define the target but no v3 runtime, KMS adapter, migration, or audit receipt was shipped.
- **DEBT-003** is monitored. The custom adapter remains until SDK public Tasks APIs can pass the current conformance suite without private hooks.
