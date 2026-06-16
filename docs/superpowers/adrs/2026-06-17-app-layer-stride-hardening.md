# ADR: App-layer STRIDE hardening (tenant isolation, firewall error path, social-graph fan-out cap)

## 1. Title
Close the three app-layer findings of the 2026-06-17 STRIDE audit (Spoofing/tenant leakage,
Information-Disclosure on the error path, DoS via unbounded fan-out) with no contract change.

## 2. Context
A STRIDE audit raised 4 findings. Code review confirmed all 4 but reclassified severity/mechanism:
- **S (tenant leakage) — TRUE.** Tools resolved `svc.account(agentId)` straight from client input;
  the keystore is one flat global file and `ctx.tenantId` was never consulted in `src/plugins/`.
  In multi-tenant HTTP mode any tenant could drive any agent (griefing: create_job spends a victim's
  wallet, complete_job releases a victim's escrow; `withdraw` pays the agent's own address so it is
  not direct theft). User chose to fix for the worst case (treat as multi-tenant).
- **Info-Disclosure — TRUE.** `scanToolOutput` ran only on success; thrown errors re-threw raw and
  the SDK forwarded `error.message` to the client. `makeToolErrorResult` redacted only paths and was
  applied to the idempotency cache, not the thrown message. Critically, the firewall did **not**
  redact a bare private-key-shaped hex (`0x`+64) — surfaced by audit-design abductive-2 (HIGH).
- **DoS — PARTIAL.** The audit's "thousands of concurrent calls → instant DoS" is wrong (viem HTTP
  batch `batchSize:100` already coalesces, contract.ts:46), but `handleFullFormat` had **no cap** on
  the hydrated edge set — a real defense-in-depth gap.
- **Escrow deadlock (Claim 3) — TRUE but contract-layer** → deferred to Workstream B (immutable
  contract; bundles with PD-003 + PD-005 into one v2 redeploy). Design locked in
  `specs/2026-06-17-agentskillregistry-v2-design.md`.

Constraints: in-process trust (D-1), uint256-as-string (D-6), output firewall mangles Luhn 13–19
digit runs, contract is deployed + immutable.

## 3. Decision
Three app-layer units, all reversible, no `.sol`/ABI/deploy change:
- **A1 Tenant→agent binding.** `KeystoreFileV3.agents[]` and `AgentIdentity` gain `tenant`; resolved
  at load to `entry.tenant ?? (KARMA_DEFAULT_AGENT_TENANT ?? MCP_TENANT_ID)` — **fail-closed** (an
  unmarked agent binds to the default tenant, not "any"). `KeystoreManager.assertOwnedBy(agentId,
  tenantId)` (generic message, agent-not-found checked first). `KarmaService.account/addressOf` gain
  a required `tenantId`; `realKarmaService` asserts ownership before resolving. `karma.tool.ts` reads
  `getRequestContext().tenantId` and threads it through all 8 account/address call sites + the
  `resolveAddress` helper; the raw-`address` read path stays unauthenticated (public on-chain data).
- **A2 Firewall on the error path.** New exported `redactErrorText` (credentials/PII/SSN/cards/
  prompt-injection via `redactSensitiveText` + redis/pg/path stripping + private-key-shaped
  `0x`+64hex, error-path-only, 256-cap). `makeToolErrorResult` delegates to it. New exported
  `toClientError` (redacts message, preserves `.name`/`.code`, drops stack/cause) wraps the **entire**
  `registerMcpTool` handler in one try/catch chokepoint; the final sync return uses `return await` so
  a locked-execution rejection is caught and sanitized. `scanToolOutput` is deliberately unchanged so
  legitimate `result_hash` output is not mangled.
- **A3 Fan-out cap.** `KARMA_SOCIAL_GRAPH_MAX_JOBS` (default 500) caps hydration to the most-recent
  edges (numeric BigInt sort); `readJobsChunked` hydrates in sequential 100-id chunks; detail arrays
  filter to the hydrated subset (no hydration-miss throw); `summary.{truncated,total_unique_jobs}`
  make partial results explicit. `format:"ids"` default path untouched.

## 4. Status
ACCEPTED

## 5. Consequences
**Improved:** a foreign tenant can no longer act as another tenant's keystore agent; no thrown tool
error can leak credentials/PII/paths/connection-strings/**private keys** to the client (one
chokepoint, can't be forgotten); `query_social_graph format:"full"` is bounded in RPC + memory.
**Worsened / debt:** (a) flat keystores in api-key/gateway deployments need either per-agent `tenant`
fields or `KARMA_DEFAULT_AGENT_TENANT` set to the live tenant id — a manual, non-migrated ops step;
(b) tenant-mismatch is only observable as a generic `tool_execution_failed` log — no dedicated
security-alarm signal (PD-006); (c) truncated social-graph financial sums are partial (flagged, not
silent); (d) `redactErrorText` may over-redact a wei run in an error string (acceptable).

## 6. Alternatives Considered
- **Convention `agentId == tenantId`** (rejected): simplest but rigid — one agent per tenant; the
  keystore already keys per-agent, so a `tenant` field is more faithful and backward-compatible.
- **Config allowlist tenant→[agentIds]** (rejected): a second config source to keep in sync with the
  keystore; the keystore is the authoritative home for agent identity.
- **Per-throw-site sanitization** (rejected for A2): N sites = a future site can regress; one outer
  chokepoint is fail-safe.
- **Reject (error) instead of truncate for A3** (rejected): truncation with a `truncated` flag is
  friendlier for a read/visualization tool while still bounding cost.
- **Multicall for A3 (audit ADR-4)** (rejected): contradicts the documented decision — Multicall3 is
  not verified on Pharos Atlantic; viem HTTP batch is the chosen reducer and is already on.

## 7. Evidence
- `pnpm typecheck` → clean. `pnpm eslint "src/**/*.ts"` → clean. [verified 2026-06-17]
- `pnpm test` (vitest run src): **367 passed | 1 skipped | 0 failed, 53 files** (baseline 350).
  [verified 2026-06-17]
- A1: keystore default-tenant + cross-tenant reject + explicit per-agent tenant + not-found-first
  (`keystore.test.ts`); plugin threads tenantId into account/addressOf, foreign tenant → reject with
  `svc.createJob` NOT called (`karma_tools.test.ts`). [verified 2026-06-17]
- A2: `redactErrorText` redacts private-key hex / sk- / paths / redis / pg + 256-cap; `scanToolOutput`
  leaves a 0x+64 result hash intact; `toClientError` redacts message but keeps name + numeric code
  (`output_firewall.test.ts`, `execution_pipeline_error_redaction.test.ts`); no regression in
  `idempotency.test.ts` + `execution_lock.test.ts`. [verified 2026-06-17]
- A3: N=600 > cap → exactly 500 `readJob` calls, `truncated:true`, `total_unique_jobs:600`; N=3 →
  `truncated:false` (`karma_tools.test.ts`). [verified 2026-06-17]
- No `.sol` / `abi.ts` / deployed-address change (grep confirms). [verified 2026-06-17]

## 8. Owner
**KARMA team — gokuderafight@gmail.com**

## 8b. Known Debts (PATTERN-DEBT)
  - PD-006: OPEN (new) — tenant-mismatch has no dedicated telemetry/alarm signal; the plugin imports
    no telemetry seam. Surfaced as generic `tool_execution_failed`.
  - PD-005 / PD-003: OPEN (unchanged) — on-chain trust gate + O(1) dedup; now bundled with Claim 3
    escrow resolution into Workstream B (`specs/2026-06-17-agentskillregistry-v2-design.md`).
  - PD-002 / PD-004: OPEN (unchanged) — network read/write integration coverage; indexer checkpoint.

## 9. Next Cycle Trigger
Build **Workstream B** (AgentSkillRegistry v2: escrow dispute/auto-claim + on-chain trust gate +
jobByTaskHash) on the next contract redeploy — whichever fires first: `jobCount() > 1000` OR a
requester owns > 100 jobs (PD-003) OR a delivered job's escrow is reported permanently locked in
production OR a concrete multi-tenant customer onboards needing consensus-level enforcement.
For **PD-006**: add a dedicated `tenant_agent_mismatch` telemetry event when authn rejections in
`tool_execution_failed` logs attributable to tenant binding exceed 10 in any 1-hour window.

## 10. Cycle Retrospective
- The audit's DoS "mechanism" was wrong (it missed the viem HTTP batch transport) — always verify a
  claimed mechanism against the transport/client config before accepting severity; the real gap was
  the missing cap, not concurrency.
- audit-design's abductive pass earned its keep: the firewall's blind spot for **bare private-key
  hex** (vs PEM/`sk-`) would have shipped — for a keystore-holding app, add `0x`+64hex redaction on
  error paths but NEVER to `scanToolOutput` (result_hash/taskHash are the same shape).
- `return` vs `return await` inside a wrapping try/catch is load-bearing: a bare `return promise`
  escapes the catch. Any future error-wrapping chokepoint must `return await` the locked execution.
- Source-introspection tests (`registrar_governance.test.ts`) are brittle to intentional refactors —
  they assert literal code markers; budget for updating them when changing pipeline structure.
- Knowingly deferred: per-agent keystore `tenant` migration is manual (not auto-migrated) and
  tenant-mismatch has no alarm signal (PD-006) — acceptable for an app-layer preview; the worst case
  is fail-closed (unmarked agents bind to the default tenant, denying foreign tenants).
</content>
