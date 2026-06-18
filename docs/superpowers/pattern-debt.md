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
- **status:** RESOLVED 2026-06-17 — `karma_service_integration.test.ts` spins anvil, deploys v2, and
  exercises realKarmaService register→read→create→(O(1) dedup)→deliver→confirm→withdraw + dispute
  end-to-end, covering the readContract/writeContractBounded DECODE paths (incl. the v2 skills tuple).
  Skips cleanly without anvil/artifact. (was OPEN/reduced 2026-06-16)
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
- **status:** RESOLVED 2026-06-17 (ADR 2026-06-17-agentskillregistry-v2) — `jobByTaskHash` mapping +
  O(1) `findExistingJob`; **v2 deployed live** at `0xc6d5c146209e0833634bd33fafb9e65081b905ae`
  (Pharos Atlantic, block 24360873) and skill #1 migrated.
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
- **status:** RESOLVED 2026-06-17 (ADR 2026-06-17-agentskillregistry-v2) — on-chain `agentReputation`
  + `Skill.minReputationToInvoke` + `createJob` require; enforcement is consensus-level and **live**
  on v2 `0xc6d5c146209e0833634bd33fafb9e65081b905ae` (block 24360873). Residual: wash-trade resistance
  needs stake/identity (out of scope); index threshold is now display-only. Phase 1 superseded.
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
- **status:** RESOLVED 2026-06-17 — the execution pipeline's chokepoint catch now classifies
  `isTenantMismatchError` and emits a distinct `tenant_agent_mismatch` telemetry event (tool, tenantId,
  userId, clientId, requestId) before re-throwing, so security monitoring can alarm on spoof attempts.
  (was OPEN/new 2026-06-17)
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

## PD-007 — Reputation is Sybil/wash-trade farmable by a wallet ring (1-wallet sub-case fixed)
- **status:** OPEN (Tier-0 sub-case RESOLVED 2026-06-17, ADR 2026-06-17-karma-sybil-resistant-reputation)
- **discovered:** 2026-06-17 during research into PD-005's disclosed "wash-trade resistance needs
  stake/identity" residual.
- **evidence:** `_settleCompletion` bumped the per-skill `reputationScore` (→ off-chain BM25 boost
  `1 + rep/100`, 1.0..2.0×, [bm25_index.ts:163-165](../../src/lib/bm25_index.ts#L163-L165)) and
  `totalInvocations` **unconditionally**, while only `agentReputation` was behind the Abductive-2
  self-deal guard. `createJob` has no `msg.sender != owner` check and accepts `pricePerCall == 0`, so
  a **single wallet** could self-deal price-0 jobs on its own skill (create→deliver→confirm,
  `requester == provider`) to drive its skill rank to the 2.0× ceiling at **gas-only, zero capital** —
  cheaper than the 2-wallet Trust-Gate farm. The pre-existing `test_SelfDeal_NoRepFarm` ran this pump
  twice while asserting only agent rep, so it certified the gap.
- **root cause:** a guard wrapping only one of two twinned trust-signal writes; ranking trusts an
  on-chain counter that is mintable inside a closed set (no non-bootstrappability / seed anchor).
- **Tier-0 fix (SHIPPED, source-only — next redeploy carries it on-chain):** moved
  `reputationScore` + `totalInvocations` inside the `requester != provider` guard in
  `_settleCompletion`; self-deal now earns ZERO signal. RED→GREEN verified (pre-fix 75/60 != 50);
  `forge test` 25/25. Closes the **1-wallet** sub-case only.
- **Tier-1 flow reputation (SHIPPED, off-chain, flag-gated `KARMA_DISCOVERY_RANK=flow`, default OFF):**
  `src/lib/flow_reputation.ts` (EigenTrust-lite: value×decay×pair-saturation, seed-pluggable,
  per-owner boost, DoS-capped, deterministic) + `bm25_index.ts` `setBoost` seam + indexer edge capture.
  Value-weighting alone zeroes price-0 pumps; SEEDED mode is non-bootstrappable (ring scores ~0).
  flow-rep tests + seam/edge tests. **Dormant** until flipped on with a real seed set.
- **Tier-2 bond (SHIPPED in source, NOT live-deployed):** optional per-agent native-currency bond as
  the flow-rep SEED — `depositBond`/`requestBondUnlock`(7-day cooldown, seed→0)/`cancelBondUnlock`/
  `withdrawBond`(→pull-payment)/`seedEligibleBond` + `BondUpdated` event in
  `contracts/AgentSkillRegistry.sol`; `abi.ts` synced (drift-guard green); `BondUpdated`→
  `FlowBoostSource.setBondSeed`→`seedWeightFromBond` (log-capped) bridge in the indexer. Bond never
  recycles (unlike escrow) → N identities cost N locked bonds; cooldown defeats flash-seed; non-paywall
  (zero-bond agents still rank). **No slashing** (see PD-008). 9 forge + 3 engine + 2 indexer tests.
  Rides the SAME un-redeployed contract version as the Tier-0 fix → one future migration carries both.
- **residual (the still-open debt):** the bond is **not live** and Tier-1 is default-off; until the
  redeploy + flag-flip, discovery uses the legacy boost and a **≥2-wallet ring** still farms agent rep
  (Trust Gate) at gas-only cost. Seedless Tier-1 only *raises the bar* (a test asserts this).
- **resolution_trigger:** **Deploy + activate** when discovery is shown gamed OR before any
  value-bearing deploy OR the next redeploy fires (PD-003) — redeploy the bonded version (Tier-0 + bond,
  bundle PD-003's `jobByTaskHash`), migrate skill state, set `KARMA_DISCOVERY_RANK=flow` with bond as
  seed, validate on the PD-002 anvil harness. Code is built+tested; this is a deploy + config step.
- **action:** track; Tier-0 + Tier-1 + Tier-2 shipped in source (ADR 2026-06-17-karma-sybil-resistant-
  reputation); live deploy + flag-flip + slashing (PD-008) deferred. whole repo green:
  `npm test` 421 pass | 1 skip, `forge test` 34, typecheck/lint/drift-guard clean.

## PD-008 — No quality-slashing of Sybil bonds (Tier-2b deferred)
- **status:** OPEN (deferred by design, ADR 2026-06-17-karma-sybil-resistant-reputation)
- **discovered:** 2026-06-18 while shipping the Tier-2 bond.
- **evidence:** the bond (PD-007) makes Sybil *origination* of trust cost locked capital, but a bonded
  agent that delivers junk is not punished — `withdrawBond` returns the full bond after cooldown
  regardless of delivery quality. Bond = Sybil-cost lever, NOT a quality bond.
- **root cause:** slashing needs an OBJECTIVE trigger or trusted arbitration (Kleros-style). The only
  on-chain signal is `disputeResult`, but a requester can be Sybil too, so dispute-driven slashing is
  itself a griefing vector. Designing it safely is its own audit-design cycle.
- **resolution_trigger:** only if junk-delivery-despite-bond is observed in practice AND an objective
  slash trigger / arbitration design lands — then add slashing in a dedicated audit-design + ADR cycle.
- **action:** track; intentionally out of scope — Sybil resistance does not require slashing.

