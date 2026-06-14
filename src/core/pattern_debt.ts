export const PATTERN_DEBT_IDS = [
  "DEBT-001",
  "DEBT-002",
  "DEBT-003",
  "DEBT-004",
  "DEBT-005",
  "DEBT-006",
] as const;

export type PatternDebtId = typeof PATTERN_DEBT_IDS[number];
export type PatternDebtStatus = "open" | "monitoring" | "partially_resolved" | "implemented";
export type PatternDebtUrgency = "documented" | "monitor" | "ready_to_implement" | "release_blocking" | "resolved";

export interface PatternDebtItem {
  id: PatternDebtId;
  key: string;
  title: string;
  status: PatternDebtStatus;
  urgency: PatternDebtUrgency;
  currentControl: string;
  limitation: string;
  resolutionTrigger: string;
  implementationGate: string;
  ownerHint: string;
  runtimeGuards: string[];
  nextAction: string;
}

const ITEMS: readonly PatternDebtItem[] = [
  {
    id: "DEBT-001",
    key: "plugin-os-isolation",
    title: "Plugin OS isolation",
    status: "open",
    urgency: "release_blocking",
    currentControl: "Plugin allowlist, optional SHA-256 allowlist, capability declarations, safe mode, manifest pinning, a pluggable runner interface, currentPluginIsolationLevel=process-best-effort by default, hardened child-process lifecycle, scrubbed worker environment without PATH, expanded JS-level escape/mutation guards, optional Node permission best-effort mode, and a production fail-closed gate for non-built-in plugins unless an explicit best-effort waiver is set.",
    limitation: "Policy mode is trusted-only and rejects non-built-ins, while the external child-process runner remains a best-effort process boundary rather than a full container, Wasmtime, or microVM isolation boundary.",
    resolutionTrigger: "A production-ready container, microVM, WASM, or equivalent runner enforces OS-level filesystem, network, process, environment, CPU, memory, timeout, and artifact egress boundaries.",
    implementationGate: "Do not implement an in-process pseudo-sandbox. External isolation must enforce egress allowlist, read-only mount, process/env isolation, seccomp/AppArmor or equivalent syscall boundary, CPU/memory quotas, timeout, and artifact egress policy before it can replace policy mode or close this debt.",
    ownerHint: "runtime-security",
    runtimeGuards: [
      "MCP_PLUGIN_ISOLATION_MODE defaults to external for non-built-ins; policy mode rejects non-built-ins instead of running them in-process.",
      "External plugin workers use a scrubbed allowlisted environment without PATH, NODE_OPTIONS, npm_config_* values, or inherited CI secrets.",
      "Plugin child processes use stderr caps, single-settle promise handling, listener cleanup, timeout/abort hard-stop, and worker send-and-exit semantics.",
      "JS-level guards block worker_threads.Worker, dgram, http2, raw net.Socket, VM APIs, process.dlopen, process.kill, DNS, inspector, cluster, child_process, and expanded filesystem mutation APIs.",
      "MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true enables node-permission-best-effort only on supported built JavaScript runtimes and never claims container isolation.",
      "Plugin manifest hash is pinned after startup when MCP_PLUGIN_PIN_MANIFEST=true.",
      "NODE_ENV=production with non-built-in plugins fails unless MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true documents a trusted-plugin waiver.",
    ],
    nextAction: "Keep DEBT-001 open until a real container/Wasmtime/microVM runner is implemented and tested as an OS/runtime isolation boundary.",
  },
  {
    id: "DEBT-002",
    key: "crypto-erasure",
    title: "Crypto erasure",
    status: "open",
    urgency: "release_blocking",
    currentControl: "Versioned smcp:v2:scrypt envelope with per-blob salt and optional raw base64url A256GCM key support. A v3 tenant/user DEK erasure ADR and type-only ITenantKeyRegistry contract exist for design readiness, and production fails closed when MCP_REQUIRE_CRYPTO_ERASURE=true.",
    limitation: "No v3 runtime encryption path, KMS-backed DEK registry, Redis/local_fs migration, decrypt-denial proof, or production crypto-erasure receipt is implemented yet.",
    resolutionTrigger: "A regulatory or customer requirement asks for tenant/user crypto-erasure with KMS audit evidence.",
    implementationGate: "Introduce smcp:v3:jwe envelopes with opaque kid, tenant/user DEKs wrapped by a KEK, key version metadata, rotation/rekey tooling, migration coverage, and auditable DEK destruction before claiming crypto-erasure.",
    ownerHint: "storage-security",
    runtimeGuards: [
      "Redis storage requires MCP_ENCRYPTION_KEY.",
      "Known development encryption keys are rejected.",
      "Legacy SHA-256 KDF decrypts only when MCP_ALLOW_LEGACY_SHA256_KDF=true for migration.",
      "src/storage/key_registry.ts is type-only and has no production runtime registry side effects.",
      "NODE_ENV=production with MCP_REQUIRE_CRYPTO_ERASURE=true fails closed until smcp:v3 KMS-backed runtime exists.",
    ],
    nextAction: "Implement the ADR only when a deployment has concrete erasure/audit requirements; do not add fake KMS or fake audit receipts.",
  },
  {
    id: "DEBT-003",
    key: "native-mcp-tasks",
    title: "Native MCP Tasks",
    status: "monitoring",
    urgency: "monitor",
    currentControl: "Task lifecycle is behind ITaskStore with MemoryTaskStore and RedisTaskStore; native tasks/get, tasks/update, tasks/cancel, input_required, inputRequests, and inputResponses are exposed through the isolated src/mcp/adapter boundary.",
    limitation: "Private SDK hooks are intentionally isolated in src/mcp/adapter until the TypeScript SDK exposes a stable public Tasks API compatible with the current conformance suite.",
    resolutionTrigger: "The selected MCP TypeScript SDK exposes stable public Tasks APIs for tasks/get, tasks/update, tasks/cancel, native task return shape from tool calls, canonical client capabilities, and input_required resume semantics.",
    implementationGate: "Do not reintroduce check_task_status or isAsync; migration tests must prove native task creation, polling, cancellation, TTL, ownership, and input_required resume behavior without private _requestHandlers or _createRegisteredTool access.",
    ownerHint: "protocol",
    runtimeGuards: [
      "src/mcp/adapter owns the SDK/protocol boundary.",
      "native Tasks preserve task ownership, cancellation, TTL, and terminal result retrieval.",
      "Task IDs and ownership gates are validated before result disclosure.",
      "No bespoke polling endpoint, check_task_status, or isAsync compatibility path is exposed.",
    ],
    nextAction: "Monitor SDK graduation criteria documented in docs/tasks-sdk-monitoring.md and migrate only after conformance tests pass against public APIs.",
  },
  {
    id: "DEBT-004",
    key: "oauth-resource-indicator",
    title: "OAuth resource indicator enforcement",
    status: "implemented",
    urgency: "resolved",
    currentControl: "SUPER-MCP is treated as an OAuth Resource Server: JWT secret mode and OIDC JWKS mode validate issuer/audience as configured, enforce MCP_RESOURCE_URI against aud/resource claims when configured, publish protected resource metadata once, and enforce per-tool requiredScopes downstream.",
    limitation: "PKCE, TokenManager, authorization-code initiation, refresh-token rotation, and client login flows are intentionally absent because they belong to OAuth clients, not this resource server.",
    resolutionTrigger: "A future product explicitly adds a first-party OAuth client component separate from the resource server.",
    implementationGate: "Do not add TokenManager or server-side PKCE to the resource-server path. Any future OAuth client flow must be separate and tested independently.",
    ownerHint: "auth",
    runtimeGuards: [
      "HTTP transport requires explicit auth material.",
      "oidc_jwks over HTTP requires MCP_JWKS_URI plus issuer and audience.",
      "MCP_RESOURCE_URI rejects wrong-resource tokens before request context is returned.",
      "The protected resource metadata route remains /.well-known/oauth-protected-resource and is not duplicated.",
    ],
    nextAction: "Keep resource-server validation tests current; do not add PKCE/TokenManager to this server path.",
  },
  {
    id: "DEBT-005",
    key: "output-firewall-coverage",
    title: "Output firewall coverage",
    status: "partially_resolved",
    urgency: "monitor",
    currentControl: "Output firewall redacts common credentials, Luhn-valid payment cards, validated SSNs, prompt-injection markers, and sensitive values inside structuredContent through recursive non-mutating traversal with depth/node/string/cycle guards; structured-only violations still emit telemetry.",
    limitation: "PII detection remains deterministic and conservative by default; strict email/phone redaction is opt-in and no DLP/classifier backend is wired.",
    resolutionTrigger: "A sensitive deployment defines DLP policy, target entity types, confidence thresholds, latency budget, and audit requirements.",
    implementationGate: "Do not add a fake DLP adapter. Integrate a real backend only behind a measured policy boundary; tests must cover false positives, false negatives, latency timeout/fail-closed behavior, and structured-output redaction.",
    ownerHint: "data-safety",
    runtimeGuards: [
      "scanToolOutput runs before sanitizeResult and idempotency commit.",
      "Detected redactions emit output_firewall_redacted telemetry, including structuredContent-only violations.",
      "structuredContent recursive redaction preserves object/array shape and does not mutate input.",
      "Depth, node-count, per-string, total-string, and circular reference guards cap structured output traversal.",
      "MCP_OUTPUT_FIREWALL_PII_MODE defaults to credentials_only; strict mode redacts email/phone.",
    ],
    nextAction: "Keep deterministic regex/Luhn/structured coverage; add DLP only when a deployment is explicitly classified as sensitive.",
  },
  {
    id: "DEBT-006",
    key: "redis-trauma-registry",
    title: "Redis trauma registry",
    status: "implemented",
    urgency: "resolved",
    currentControl: "Memory and Redis rate limiters use bounded violation records with severity EMA and exponential backoff.",
    limitation: "Backoff policy is deterministic and conservative; it is not tuned from production incident data yet.",
    resolutionTrigger: "Production telemetry calibrates severity EMA/backoff thresholds by tenant risk tier.",
    implementationGate: "Tune only from production telemetry; do not replace bounded records with unbounded request timestamp sets.",
    ownerHint: "reliability",
    runtimeGuards: [
      "Redis rate limiter stores bounded trauma records.",
      "Exponential backoff is derived from violation_count and severity_ema.",
    ],
    nextAction: "Revisit after production traffic provides enough incident data for calibration.",
  },
] as const;

export interface PatternDebtQuery {
  includeImplemented?: boolean;
  id?: PatternDebtId;
}

export function getPatternDebtItems(query: PatternDebtQuery = {}): PatternDebtItem[] {
  return ITEMS
    .filter(item => query.includeImplemented || item.status !== "implemented")
    .filter(item => !query.id || item.id === query.id)
    .map(item => ({ ...item, runtimeGuards: [...item.runtimeGuards] }));
}

export function getPatternDebtSummary() {
  const visible = getPatternDebtItems({ includeImplemented: true });
  return {
    open: visible.filter(item => item.status === "open").length,
    monitoring: visible.filter(item => item.status === "monitoring").length,
    partiallyResolved: visible.filter(item => item.status === "partially_resolved").length,
    implemented: visible.filter(item => item.status === "implemented").length,
    activeIds: visible.filter(item => item.status !== "implemented").map(item => item.id),
  };
}

export function assertKnownPatternDebtId(id: string): asserts id is PatternDebtId {
  if (!(PATTERN_DEBT_IDS as readonly string[]).includes(id)) {
    throw new Error(`[SUPER-MCP] Unknown pattern debt id: ${id}`);
  }
}
