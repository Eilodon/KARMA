# Pattern Debt Registry

Schema: see shared/pattern-debt-schema.md
Auto-populated by: pattern-globalize skill
Queried by: kb-query skill

<!-- ENTRIES BELOW — do not delete, update status field instead -->

## PD-001 — Pre-existing Layer-0 test:enterprise failures (inherited from main)
- **status:** RESOLVED 2026-06-16 (commit db7ea72) — 8 stale tests fixed, 1 env-locked test skip-guarded; full suite 315 passed | 1 skipped | 0 failed
- **discovered:** 2026-06-15 during P1.1 verification
- **evidence:** On clean base (commit b23dadc/7829254, before any KARMA change) `pnpm test:enterprise`
  fails 7 tests across 3 files, reproducible in isolation:
  - `env_validation.test.ts` — 4 failed (prod HTTP jwt gate; Redis idempotency TTL default/long; rate/quota waiver)
  - `oidc_auth.test.ts` — 2 failed (jwtVerify issuer/audience; RemoteJWKSet reuse)
  - `protocol_header.test.ts` — 1 failed (legacy/compat modes hard-disabled)
  - `plugin_external_runner.test.ts` — 1 failed (`node: bad option: --permission` — env Node v20.20.2 lacks stable flag)
- **root cause (hypothesis, SUPERSEDED):** environment sensitivity. ❌ Re-investigation 2026-06-16 disproved this — only 1 of 9 is env-sensitive.
- **root cause (verified 2026-06-16, per-test):** 8 of 9 are **stale tests** that were not updated when commit `216384c` ("sync to post-DEBT-002 state") hardened the Layer-0 code; the code is the intended behavior, the tests assert the pre-hardening shape. Only 1 is genuinely env-locked.
  - `env_validation.test.ts` ×4 — set `STORAGE_DRIVER=redis` but omit `MCP_IDEMPOTENCY_SECRET`; the S-1.2 gate (env.ts:240) now `process.exit(1)`s. Fix: add `MCP_IDEMPOTENCY_SECRET` to the 4 success-path setups. DETERMINISTIC.
  - `oidc_auth.test.ts` ×2 — `auth.ts` passes `maxTokenAge:\`${ENV.MCP_JWT_MAX_AGE_SECONDS}s\`` (env default 3600); the test's partial ENV mock omits it → `"undefineds"`, and the assertion predates `maxTokenAge`. Fix: add the field to the mock + expect `maxTokenAge`. DETERMINISTIC.
  - `server_card.test.ts` ×1 — asserts `_meta.security.pluginTrustBoundary` + `patternDebt.activeIds`, both **deliberately removed** for anti-reconnaissance (server_card.ts:55, MISS-4/I-4.3). Test asserts insecure pre-hardening output. Fix: drop those assertions (assert absence). DETERMINISTIC + security-aligned.
  - `protocol_header.test.ts` ×1 — `importMiddlewareWithMode("compat")` expects the middleware import to trip `loadEnv`'s `process.exit`, but the import resolves: the middleware no longer runs env-validation at import. Test-mechanism drift. DETERMINISTIC.
  - `plugin_external_runner.test.ts` ×1 — **GENUINELY ENV-LOCKED**: this Node v20.20.2 build rejects `--permission` (`bad option`) despite the version guard (plugin_external_runner.ts:71). Fix: probe actual flag support and `it.skip` when unsupported (best-effort feature).
- **impact on KARMA work:** none — none are in KARMA files; KARMA introduced ZERO new failures (verified by toggling `.env`, see below).
- **regression caught + fixed 2026-06-16:** the KARMA `.env` set `MCP_PLUGIN_ISOLATION_MODE=policy`, which dotenv auto-loads into `env_validation`'s "defaults to external" test → +1 failure. Fixed by trimming `.env` to Pharos-only config (MCP_* runtime flags moved to the run command).
- **action:** DONE — 8 stale tests aligned to the intended hardened code, env-locked test skip-guarded (commit db7ea72). Code behavior unchanged; only tests touched.

## PD-002 — KARMA network glue has live-only coverage
- **status:** OPEN (reduced 2026-06-16, ADR 2026-06-16-karma-graph-withdraw-indexer)
- **discovered:** 2026-06-16 during P4–P6 (ADR 2026-06-16-karma-app-layer)
- **evidence:** `writeContractBounded` and `realKarmaService` reads still have no automated test
  (verified only by the live P7 demo); the ABI drift-guard catches `.sol`↔`abi.ts` shape drift but
  not return-decoding bugs.
- **update (2026-06-16):** the indexer half is now unit-tested — `mapLog`/`toIndexedEvents`/
  `buildViemIndexerDeps` decode + deps-construction are covered against a fake `IndexerEventClient`
  (`karma_indexer.test.ts`), and `applyIndexedEvent` reconciliation in `skill_indexer_runtime.test.ts`.
  Only the trivial `startSkillIndexer` singleton resolution (`getPublicClient`/`getContractAddress` +
  `new` + `start`) remains demo-only. The original trigger ("when `realKarmaService` is modified")
  FIRED this cycle (added `getByOwner`/`indexDiscard`/`getPendingWithdrawal`/`withdraw`) and was
  partially actioned; re-scoped below so it no longer fires on unrelated service edits.
- **root cause:** viem's heavy generics make the glue costly to type/mock; DI seam pushed the testable
  logic out, leaving thin-but-untested wiring.
- **resolution_trigger:** When the `readContract`/`writeContractBounded` return-DECODE paths change
  (new contract function consumed, `jobs()`/`skills()` tuple reshaped) OR a return-shape bug reaches
  the demo — add a forked-anvil/testnet integration test for register→create→deliver→complete→withdraw.
- **action:** track; address on next contract/decode-path change.

## PD-003 — Exactly-once guard is an O(n) on-chain scan
- **status:** OPEN
- **discovered:** 2026-06-16 during P4.2b/P6.3
- **evidence:** `findJobByTaskHash` scans `getRequesterJobs(requester)` and reads each job's taskHash
  (O(n) per create_job). Correct and fine at demo scale; degrades as a requester accumulates jobs.
- **root cause:** `createJob` stores `taskHash` but the contract has no `mapping(bytes32=>uint256)`
  index, so dedup cannot be O(1) without a contract change.
- **resolution_trigger:** When deployed `jobCount()` > 1000 OR any requester owns > 100 jobs — add an
  on-chain `jobByTaskHash` mapping in contract v2 and switch the guard to an O(1) lookup.
- **action:** track; revisit at scale (ADR Next Cycle Trigger).

## PD-004 — Skill indexer has no persisted checkpoint
- **status:** OPEN
- **discovered:** 2026-06-16 (ADR 2026-06-16-karma-graph-withdraw-indexer)
- **evidence:** `startKarmaIndexer` backfills from block 0 on every boot (`KARMA_INDEXER_FROM_BLOCK`
  env override only); there is no persisted `lastIndexedBlock`, so cold-start cost grows linearly
  with chain length.
- **root cause:** `IStateStore` is keyed by `tenantId` over `BaseState<phase>` (MCP state-machine
  shape) — wrong abstraction for a single block-number checkpoint; a correct fix needs its own
  persistence with fs/redis/memory parity. Deferred as low-payoff on a fresh testnet.
- **resolution_trigger:** When deployed `jobCount()` > 1000 OR observed cold-start backfill > 10s —
  add a persisted `lastIndexedBlock` checkpoint (own store, driver parity) read as `fromBlock` on boot.
- **action:** track; address alongside PD-002's integration-test work or first multi-instance deploy.

## PD-005 — Trust Gate is app-layer advisory, not on-chain enforced (Phase 2 deferred)
- **status:** OPEN (Phase 1 shipped 2026-06-16; plan 2026-06-16-trust-gate-min-reputation)
- **discovered:** 2026-06-16 while implementing `min_reputation_to_invoke`
- **evidence:** `create_job` enforces the per-skill reputation threshold in the tool handler
  (`karma.tool.ts`), reading both the threshold and the requester's reputation from the in-process
  BM25 index. This is NOT consensus: a caller hitting `createJob` directly on the deployed
  `AgentSkillRegistry` bypasses the gate entirely. The threshold also lives only in the index
  (no on-chain field), so it does not survive a process restart (cold-start rebuilds from chain,
  which carries no threshold) and is invisible to other processes/agents.
- **root cause:** the deployed contract is immutable (no proxy); a real on-chain gate needs a
  `Skill.minReputationToInvoke` field + a per-agent `agentReputation` mapping, both of which are
  storage-layout changes requiring a **redeploy + skill migration**. Also: on a free testnet,
  reputation is wash-tradeable between colluding addresses, so on-chain enforcement would imply a
  Sybil-resistance guarantee it can't make without staking/identity. Phase 1's advisory level is
  the honest assurance until then.
- **also (Phase-1 metric):** requester reputation = max owned-skill reputation (index-derived).
  Phase 2 replaces it with a purpose-built on-chain `agentReputation` (base 50, earned on completed
  jobs where `requester != provider`); thresholds set in Phase 1 may need re-tuning at cutover.
- **resolution_trigger:** Bundle Phase 2 into the next `AgentSkillRegistry` redeploy — whichever
  fires first: PD-003 (`jobCount() > 1000` / requester owns > 100 jobs) OR a concrete
  institutional-skill customer needs consensus-level enforcement OR a staking/identity primitive
  lands that makes reputation Sybil-costly. Build it alongside PD-003's `jobByTaskHash` change to
  avoid a second migration; demote the index threshold to a cache of the on-chain value.
- **action:** track; Phase 2 design is locked in the plan, not built. Now bundled with Claim 3
  escrow resolution into Workstream B (`specs/2026-06-17-agentskillregistry-v2-design.md`).

## PD-006 — Tenant-mismatch has no dedicated telemetry / alarm signal
- **status:** OPEN (new 2026-06-17, ADR 2026-06-17-app-layer-stride-hardening)
- **discovered:** 2026-06-17 during A1 (tenant→agent isolation), flagged by audit-design L6
- **evidence:** `KeystoreManager.assertOwnedBy` throws on a tenant/agent mismatch; the execution
  pipeline catches it as a generic `tool_execution_failed` telemetry event (with the tool name but
  no mismatch-specific marker). `src/plugins/karma.tool.ts` imports no telemetry seam, so a spoof
  attempt cannot be distinguished from an ordinary tool failure for security monitoring/alerting.
- **root cause:** the plugin is pure orchestration over `KarmaService` with no telemetry dependency
  (by design, for unit-testability); adding a distinct security signal needs either a telemetry seam
  in the service boundary or a typed-error classifier in the pipeline.
- **resolution_trigger:** When `tool_execution_failed` events attributable to tenant binding exceed
  10 in any 1-hour window, OR the first multi-tenant HTTP customer onboards — add a dedicated
  `tenant_agent_mismatch` telemetry event + alarm.
- **action:** track; defense is fail-closed already (access denied), this is observability only.

