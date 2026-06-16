---
title: App-layer STRIDE hardening — tenant isolation, firewall error path, social-graph fan-out cap
date: 2026-06-17
author: KARMA team — gokuderafight@gmail.com
SPEC_APPROVED: true
SPEC_ESCALATION: false
ESCALATION_FINDING: ""
related:
  - "[[karma-app-layer]]"
  - "ADR 2026-06-16-karma-trust-gate-phase1"
  - "audit: STRIDE Security Architecture (2026-06-17)"
  - "Workstream B: 2026-06-17-agentskillregistry-v2-design.md (deferred, redeploy-gated)"
---

# App-layer STRIDE hardening (Workstream A)

## 1. Context

A STRIDE audit (2026-06-17) raised 4 findings. Cross-checked against the codebase:

| Finding | Verdict after code review | Layer |
|---|---|---|
| S — Spoofing / tenant leakage via `agentId` | TRUE (architectural); deployment-dependent | app |
| 4 — Info disclosure: exceptions bypass output firewall | TRUE (sync + transient/lock throw paths) | app |
| 5 — DoS: unbounded fan-out in `query_social_graph` | PARTIAL — mechanism overstated (viem HTTP batch `batchSize:100` already coalesces, contract.ts:46), but **no cap on N** is a real gap | app |
| 3 — Escrow deadlock in `Delivered` | TRUE — but contract-layer → **Workstream B** (deferred, redeploy-gated) | contract |

This spec covers the **three app-layer findings (S, 4, 5)** only. They ship without a contract
redeploy and are independently reversible. Claim 3 + PD-003 + PD-005 are bundled into the
`AgentSkillRegistry` v2 redeploy (Workstream B, separate spec).

Carried constraints (CONTEXT.md): in-process trust (D-1); every uint256 crosses the boundary as a
string (D-6); output firewall already redacts Luhn 13–19 digit runs (wei strings can be mangled).

Deployment decision (user, 2026-06-17): **fix for the worst case** — treat KARMA as multi-tenant
(the HTTP/JWT/gateway auth infra anticipates it) even though the live deploy is currently
single-operator stdio.

## 2. Units

### A1 — Tenant → agent binding (Claim S, Spoofing)

**Problem.** Every write tool resolves `svc.account(a.agentId)` / `svc.addressOf(a.agentId)` from
client-supplied `agentId` (karma.tool.ts:266,338,361,383,464,489) with **no check** that the agent
belongs to the caller's `ctx.tenantId`. The keystore is one flat global file (`KEYSTORE_PATH`,
keystore.ts) shared across all tenants; `getRequestContext().tenantId` is never consulted in
`src/plugins/`. In multi-tenant HTTP mode, any tenant can drive any agent in the keystore
(create_job spends the victim's wallet into escrow; complete_job releases a victim-requester's
escrow; deliver_result posts junk on a victim provider's behalf). `withdraw` sends to the agent's
own on-chain address (msg.sender), so it is griefing, not direct theft — but still adverse.

**Design (keystore-field binding, fail-closed).**
- `KeystoreFileV3.agents[]` gains optional `tenant?: string`; `AgentIdentity` gains `tenant: string`
  (resolved, never undefined).
- On `KeystoreManager.load`, each identity's `tenant` = `entry.tenant ?? DEFAULT_TENANT`, where
  `DEFAULT_TENANT = normalizeId(ENV.MCP_TENANT_ID, "tenant_local")` (the same default
  `defaultRequestContext()` uses). **Absent tenant binds to the default tenant — NOT "any tenant"**
  (fail-closed). Single-operator stdio keeps working (its context is the default tenant); a
  *different* HTTP tenant is denied.
- `KeystoreManager.assertOwnedBy(agentId, tenantId)`: throws
  `[KARMA] agent '<id>' is not accessible to this tenant` if `identity.tenant !== tenantId`. The
  message is intentionally generic (no other-tenant id) to avoid cross-tenant reconnaissance.
- `KarmaService.account(agentId, tenantId)` and `addressOf(agentId, tenantId)` gain a required
  `tenantId` param; `realKarmaService` calls `assertOwnedBy` first. The fake updates in lockstep.
- `karma.tool.ts`: each handler reads `const { tenantId } = getRequestContext()` (in-process
  AsyncLocalStorage; import from `../../security/context.js`) and threads it through
  `resolveAddress(svc, a, tenantId)` and `svc.account(a.agentId, tenantId)`. Threading via the
  signature (not a side check) makes it impossible to forget a call site.
- Read tools (`get_agent_reputation`, `query_social_graph`, `get_pending_balance`): the
  `agentId` path is tenant-checked (resolving another tenant's agentId→address leaks the keystore
  mapping); the raw `address` path is unchanged (on-chain public data).

**Why throw, not return rejected.** Unlike the Trust Gate's `status:"rejected"` (a normal business
outcome), a tenant mismatch is an authz violation — a thrown error is correct and is logged by the
pipeline as `tool_execution_failed` (sanitized by A2).

**Not-a-stub criteria.** Test asserts the keystore/account throws **before** any `svc.createJob`/
network call (no on-chain side effect on a spoof attempt).

**Acceptance.**
- Tenant `t-b` passing an agentId bound to `t-a` → throws; `svc.createJob`/`withdraw` NOT called.
- Agent with no `tenant` field is usable by the default tenant (stdio) and rejected for a different
  HTTP tenant.
- `address`-only read path works regardless of tenant.

### A2 — Output firewall on the error path (Claim 4, Information Disclosure)

**Problem.** `scanToolOutput` runs only on the success path (execution_pipeline.ts:265). On tool
failure the sync path re-throws the **raw** error (`throw error;`, line 641), which the MCP SDK
turns into a JSON-RPC error with `message: error.message` sent to the client (verified in
`@modelcontextprotocol/server` dispatch). The same raw re-throw happens for transient/lock errors
(lines 563, 631). `makeToolErrorResult` (lines 242–253) strips only paths/redis/pg and is applied
**only to the idempotency/task cache**, never to the thrown message — and even it skips the
credential/PII redaction `scanToolOutput` does. So a first-call error can leak Viem RPC URLs (with
embedded keys), `sk-`/`ghp_`/`AKIA` tokens, emails, etc.

**Design (single canonical sanitizer + one chokepoint).**
- `output_firewall.ts`: export `redactErrorText(text: string): string` — runs the existing
  `redactSensitiveText` pipeline (cards/credentials/SSN/strict-PII/prompt-injection) **plus** the
  path/redis/pg stripping currently inlined in `makeToolErrorResult`, then caps at 256 chars. This
  becomes the one place error strings are sanitized.
- `execution_pipeline.ts`:
  - `makeToolErrorResult` delegates to `redactErrorText` (so cache + task-store failed results get
    full firewall redaction, not just path stripping).
  - Add `toClientError(error): Error` — returns an `Error` whose `.message = redactErrorText(raw)`,
    preserving `.name` and a numeric `.code` (the SDK reads `error.code` for the JSON-RPC code) but
    dropping `stack`/`cause` (avoid leaking nested infra detail).
  - Wrap the **entire** `registerMcpTool` handler body in a single outer
    `try { … } catch (e) { throw toClientError(e); }`. This is the one chokepoint every thrown
    error must pass through — including the inner sync/transient/lock re-throws and the
    governance/scope/validation throws — so no future throw site can regress. `ElicitationRequired`
    and task results are **returns**, not throws, so they are unaffected.
- Idempotency/transient semantics are unchanged: release/commitError already happen inside before
  the throw; the wrapper only rewrites the outgoing message.

**Gotcha (documented).** `redactErrorText` may mangle a 13–19 digit Luhn-valid wei run inside an
error string (CONTEXT.md gotcha). For error messages this is acceptable — over-redacting an error
beats leaking a secret.

**Not-a-stub criteria.** Test feeds a handler that throws an Error whose message contains a real
`sk-…` token, an email, an `AKIA…` key, an absolute path, and a `redis://…` URL, and asserts the
**client-facing thrown** message has each replaced (`[REDACTED:*]`/`[path]`/`[redis]`), not just the
cached copy.

**Acceptance.**
- Thrown error message from a failing tool is redacted before leaving KARMA.
- Cached error result (`commitError`) is redacted identically.
- `error.code` / `error.name` preserved for protocol correctness.

### A3 — Social-graph fan-out cap (Claim 5, DoS)

**Problem.** `handleFullFormat` (karma.tool.ts:98–147) does `Promise.all(uniqueIds.map(readJob))`
with **no upper bound** on `uniqueIds` (from `getProviderJobs`+`getRequesterJobs`, unbounded
on-chain arrays, sol:183–189). The audit's "thousands of concurrent RPC calls → instant DoS" is
**inaccurate**: the viem transport batches (`http(RPC_URL,{batch:{batchSize:100}})`, contract.ts:46),
so N reads collapse to ~ceil(N/100) HTTP requests, and the path is already gated by per-tenant
rate-limit + quota + a serialized execution lock. The real, cheap defense-in-depth gap is the
**missing cap** + unbounded promise/memory fan-out for a pathological agent.

**Design.**
- `ENV.KARMA_SOCIAL_GRAPH_MAX_JOBS` (default 500). If `uniqueIds.length > cap`, hydrate only the
  **most-recent `cap`** ids (numeric desc — job ids are monotonic), and set `summary.truncated =
  true` with `summary.total_unique_jobs = uniqueIds.length`.
- Hydrate in **sequential chunks of 100** (matches `batchSize`) via a `readJobsChunked` helper, so
  at most ~100 reads are scheduled per round (bounds promise count + memory; smooths RPC).
- `toDetail` only runs over the hydrated set: build `hydrated = Set(cappedIds)`, then
  `asProvider = providerIds.filter(id => hydrated.has(String(id))).map(toDetail)` (same for
  requester) — prevents the existing `"missing from hydration batch"` throw when truncated.
- `SocialGraphSummary` gains `truncated: boolean` and `total_unique_jobs: number`. `total_jobs_*`
  stay true counts (array length, 0 RPC); `total_earned/spent` and the detail arrays are computed
  over the hydrated subset and are partial when `truncated` (documented in the field + tool
  description).
- `format:"ids"` path (the default, 2 calls) is untouched.

**Not-a-stub criteria.** Test asserts `svc.readJob` is called **exactly `min(N, cap)`** times (real
cap, not a no-op) and `truncated` reflects reality.

**Acceptance.**
- N > cap → exactly `cap` `readJob` calls, `truncated:true`, no hydration-miss throw.
- N ≤ cap → unchanged shape, `truncated:false`.

## 3. Architecture / data flow

```
MCP client ──tools/call──▶ registerMcpTool handler (execution_pipeline)
                              │  getRequestContext() → tenantId         (A1)
                              │  outer try/catch → toClientError        (A2)
                              ▼
                         executeTool → handler(args) ──▶ karma.tool.ts
                              │                              │ resolveAddress(svc,a,tenantId) (A1)
                              │                              │ handleFullFormat: cap+chunk     (A3)
                              ▼                              ▼
                         scanToolOutput (success only)   KarmaService.account(id,tenant) → keystore.assertOwnedBy (A1)
```

## 4. Error handling
- A1 mismatch → thrown authz error (generic message), redacted by A2, logged `tool_execution_failed`.
- A2 → all thrown errors sanitized at the single chokepoint; protocol code/name preserved.
- A3 over-cap → graceful truncation (not an error), `truncated` flag surfaced.

## 5. Testing strategy
- Vitest, all against fakes (no live chain): `karma_tools.test.ts` (A1 binding, A3 cap+chunk count),
  `keystore.test.ts` (assertOwnedBy + default-tenant), `output_firewall.test.ts` (redactErrorText),
  new `execution_pipeline` error-redaction test (A2 chokepoint).
- Gates: `pnpm typecheck` clean, `pnpm lint` clean, full `pnpm test` green (currently 350/1-skip/0).

## 6. Environment preconditions (deployment risks — flagged)
- **A1 (multi-tenant deploy only):** real per-tenant isolation requires adding `tenant` to each
  `keystore.json` agent entry — a **manual keystore edit, not auto-migrated**. Absent → safe
  default-tenant binding (single-operator unaffected). Document in the run/keystore setup notes.
- **A3:** new `KARMA_SOCIAL_GRAPH_MAX_JOBS` env var; add a default in `config/env.ts`.
- **A2:** none.

## 7. Out of scope (→ Workstream B, deferred)
Claim 3 escrow resolution, PD-003 O(1) dedup, PD-005 on-chain trust gate — all require the
`AgentSkillRegistry` v2 redeploy + migration. Designed in `2026-06-17-agentskillregistry-v2-design.md`.

## Risk Assessment (audit-design)
<!-- audit-design: DO NOT DUPLICATE — update this section, do not append a second one -->
<!-- last-run: 2026-06-17 | trigger: NORMAL -->

**Tier:** 3 (multi-tenant isolation + in-process crypto keystore) | **Date:** 2026-06-17

### Failure Modes
1. **Default-tenant binding silently breaks existing api-key/HTTP deploys** — an agent with no
   `tenant` field binds to `DEFAULT_TENANT = ENV.MCP_TENANT_ID ?? "tenant_local"`, but
   `resolveHttpRequestContext` hardcodes `tenantId="api-key-dev-tenant"` (context.ts:66) when
   `MCP_TRUST_IDENTITY_HEADERS=false`, and gateway/JWT modes derive it from headers/claims. So
   today's flat keystore (no tenant fields) → every agent binds to `tenant_local` → **unusable**
   under api-key/gateway tenants. Fail-closed (safe) but a behavior change. — **MED** — mitigation in plan: YES
2. **Over-broad error chokepoint degrades debuggability / drops protocol signal** — wrapping the
   whole handler in `catch → toClientError` could truncate actionable validation messages (256 cap)
   and, if `.code`/`.name` are not preserved, change the JSON-RPC error code clients branch on. —
   **MED** — mitigation in plan: YES
3. **Truncated social-graph summary read as authoritative** — when `truncated`, `total_earned_phrs`/
   `total_spent_phrs` are computed over the hydrated subset only; a reporting consumer may under-count
   funds without noticing. — **MED** — mitigation in plan: YES

### Layer Signals
- **L1 Logic (A3):** "most-recent cap ids" MUST sort numerically (BigInt), not lexicographically —
  job ids are decimal strings; `"9" > "100"` lexically. Sort bug would hydrate the wrong subset.
- **L3 Data (A1):** keystore gains an optional field with **no migration tool**; back-compat rests on
  the default-binding rule (FM1). Old files parse fine; semantics shift. See §6.
- **L5 Security (A1):** mismatch error message must be generic (no other-tenant agentId/address) to
  avoid cross-tenant reconnaissance — already specified; verify in test.
- **L6 Observability (A1):** tenant-mismatch is currently only visible as a generic
  `tool_execution_failed` log. Security monitoring needs a **distinct** signal to alarm on spoof
  attempts. Plugin does not import `telemetry` — needs a seam.
- **L7 Cross-cutting (L7.11 = YES):** multi-tenant data path. Idempotency key already includes
  `tenantId` + `owner` (execution_pipeline:434, `taskOwner(ctx)`), so A1 does not cross-contaminate
  the cache — confirm no regression.

### Assumptions to Verify
- **ASSUMED:** `getRequestContext()` inside the in-process plugin returns the *caller's* context.
  True only because karma.tool runs in-process under the same AsyncLocalStorage run (D-1). Verify the
  store is entered for every tools/call path (HTTP + stdio), else `tenantId` falls back to the default
  and A1 silently no-ops. **This is the load-bearing assumption for A1 — test both transports.**
- **ASSUMED:** the MCP SDK propagates a thrown error's `.message` verbatim and reads `.code` —
  verified in dispatch for this alpha; pin with a conformance test so an SDK bump can't regress A2.

### Abductive Hypotheses
- **Abductive 1 (component interaction):** A spoof attempt still acquires a rate-limit/quota token and
  an idempotency lock *before* the in-handler A1 check fails, and caches a (redacted) error under the
  attacker's own key. Bounded (per-attacker tenant, short error TTL) — no cross-tenant poisoning — but
  means A1 rejects are **not free**; an attacker can still burn a victim-unrelated quota. Acceptable;
  note it. Consider moving the tenant check as early as cheaply possible.
- **Abductive 2 (adversarial, HIGH):** **The output firewall does not redact a bare private-key-shaped
  hex (`0x` + 64 hex).** `CREDENTIAL_PATTERNS` covers PEM/`sk-`/`ghp_`/`AKIA` but not a raw 32-byte
  hex. KARMA decrypts private keys in-process (keystore.ts) and signs with viem; a keystore/viem error
  that stringifies key material would be `0x`+64hex and **leak through `redactErrorText` unredacted**.
  `taskHash`/`resultHash` are the same shape (false-positive risk), but over-redacting 32-byte hex in
  **error strings** is acceptable. — **HIGH**

### Gate Result
<!-- PASS | PASS WITH FLAGS | HOLD -->
**PASS WITH FLAGS** — proceed to writing-plans. The plan MUST include:
- **(HIGH, Abductive-2)** `redactErrorText` redacts bare `0x[0-9a-fA-F]{64}` blobs (private-key-shaped)
  in error strings, with a dedicated test (private key in a thrown error → redacted).
- **(FM1, MED)** an explicit, documented default-tenant override + a clear error, and a test for the
  api-key/gateway path; call out the keystore-migration step in the run notes.
- **(FM2, MED)** `toClientError` preserves `.name` + numeric `.code`; telemetry keeps the **full**
  error server-side; client gets the redacted/capped message.
- **(FM3 + L1, MED)** numeric (BigInt) sort for the cap; when `truncated`, mark financial sums partial
  (or null) rather than silently under-counting.
- **(L6, MED)** a distinct telemetry signal for tenant-mismatch (security alarm seam).
- **(ASSUMED)** A1 verified under **both** stdio and HTTP transports (context propagation is load-bearing).
</content>
</invoke>
