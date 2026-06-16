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
- **root cause (hypothesis):** environment sensitivity (Node v20.20.2 build, @modelcontextprotocol alpha deps, jose) — NOT logic regressions from this branch. Proven: identical failures with KARMA change stashed.
- **impact on KARMA work:** none. AC2 re-defined as "introduce ZERO new failures" (provable via base diff), since the inherited gate is already red.
- **action:** surface to repo owner; fix separately (Layer-0 maintenance), do not block KARMA app-layer.

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

