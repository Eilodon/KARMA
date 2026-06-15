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

