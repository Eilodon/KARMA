# Pattern Debt Registry

Schema: see shared/pattern-debt-schema.md
Auto-populated by: pattern-globalize skill
Queried by: kb-query skill

<!-- ENTRIES BELOW — do not delete, update status field instead -->

## PD-001 — Pre-existing Layer-0 test:enterprise failures (inherited from main)
- **status:** OPEN (pre-existing, out of KARMA-app-layer scope)
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
- **action:** stale-test fixes are safe Layer-0 maintenance (code is the intended hardened behavior). Awaiting owner go-ahead to apply.

## PD-002 — KARMA network glue has live-only coverage
- **status:** OPEN
- **discovered:** 2026-06-16 during P4–P6 (ADR 2026-06-16-karma-app-layer)
- **evidence:** `writeContractBounded`, `realKarmaService` reads, and `startSkillIndexer` have no
  automated test. The decoupled policy cores are unit-tested (`runBoundedWrite`, `findJobByTaskHash`,
  `SkillEventIndexer` state machine, `BM25SkillIndex`); the viem/keystore wiring is verified only by
  the live P7 demo. The ABI drift-guard catches `.sol`↔`abi.ts` shape drift but not return-decoding bugs.
- **root cause:** viem's heavy generics make the glue costly to type/mock; DI seam pushed the testable
  logic out, leaving thin-but-untested wiring.
- **resolution_trigger:** When `realKarmaService` is next modified, OR a return-shape bug reaches the
  demo — add a forked-anvil/testnet integration test for register→create→deliver→complete→withdraw.
- **action:** track; address on next contract/service change.

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

