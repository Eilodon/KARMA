# ADR: Fail-closed trusted-runtime canary for karma.tool

## 1. Title
Convert `karma.tool` `assertInProcess()` from a fail-open env-var convention to a fail-closed positive proof of the trusted in-process runtime.

## 2. Context
`karma.tool` is a trusted built-in that MUST run in-process: it reads decrypted signing keys
from the `keystoreManager` singleton, queries the `skillIndex` singleton, and reads
`PHAROS_*`/`KEYSTORE_*` from `process.env` — none of which survive the external child-process
worker (per-call `fork()` + `workerEnv()` env allowlist).

The original canary checked `process.env.KARMA_PLUGIN_WORKER === "1"` and threw if set. This is
**fail-open**: it relies on every worker/runner *remembering to set* that env var. A future or
alternate runner that loads `karma.tool` without setting `KARMA_PLUGIN_WORKER` would bypass the
canary silently. For the two tools that don't hit the keystore/RPC (`karma_health`,
`discover_skills`) the bypass yields a wrong-but-plausible result instead of a loud failure.

Severity is LOW today (built-ins always direct-`import()` in the parent; the worker always sets
the env var and strips keystore/RPC env), so this is defense-in-depth + clarity, not a
security-critical fix. It is adjacent to but does NOT resolve DEBT-001 (OS isolation of the
*untrusted* runtime); it hardens the *trusted/untrusted split* on the trusted side.

## 3. Decision
Added `src/core/runtime_identity.ts` holding a module-local `trusted` flag with
`markTrustedRuntime()` / `isTrustedRuntime()` / `resetTrustedRuntimeForTest()`. `PluginLoader.loadAll()`
calls `markTrustedRuntime()` at its top — `loadAll` only ever runs in the trusted parent; the
worker loads plugins through `plugin_worker.loadTools()` and never calls it. `assertInProcess()`
now throws unless `isTrustedRuntime()` is true (keeping the `KARMA_PLUGIN_WORKER` check as a
secondary signal). Absence of proof now denies by default. In-process callers that bypass
`loadAll` (the two demo scripts; the unit tests) declare trust explicitly.

## 4. Status
ACCEPTED

## 5. Consequences
- **Improved:** the canary is fail-closed — an unknown/future runner that loads `karma.tool`
  without going through `loadAll` is denied by default, closing the env-var-convention gap.
- **Improved:** the "silent wrong answer" window for `karma_health`/`discover_skills` is closed.
- **Cost (inherent to fail-closed):** every legitimate in-process caller must declare trust. New
  in-process entrypoints that bypass `loadAll` must call `markTrustedRuntime()` — but forgetting
  fails LOUD (tools throw immediately), so this is self-announcing, not a latent hazard.
- **No new pattern debt.** Bundled lint-debt cleanup of pre-existing DEBT-002 KMS scaffolding
  (eslint `fetch`/`Response` ignores on the Node-20.3 floor, `audit_store` fs-filename override,
  removed unused imports, `err: unknown` typing) — `pnpm run ci` is now green end-to-end.

## 6. Alternatives Considered
- **Structural `process.send` check** (a forked IPC child ⇒ the worker): REJECTED — vitest's
  default `forks` pool gives every test process an IPC channel, so `process.send` is defined
  suite-wide → false positives; also false-positive if KARMA is run under a fork supervisor.
- **"Singleton initialized" check** (the originally-proposed fix): REJECTED — `keystoreManager`
  and `skillIndex` are legitimately empty in a real parent (before keystore load, zero-agent
  deploy, discover before first upsert) → false positives. Unsound as a canary.
- **Do nothing:** REJECTED — cheap hardening (~15 LOC) that removes a documented fail-open caveat.

## 7. Evidence
- TDD RED→GREEN (tdd-verified): RED-1 `Cannot find module '../core/runtime_identity.js'`; GREEN-1
  module 3/3; RED-2 fail-closed test resolved `{inProcess:true}` instead of rejecting (1 failed/3
  passed); GREEN-2 canary 7/7. [verified 2026-06-16]
- Full suite: 319 passed | 1 skipped (the env-locked plugin-permission test, PD-001).
  `pnpm run ci` (typecheck && lint && test) exit 0. [verified 2026-06-16]
- pattern-globalize: the fail-open env-convention canary was unique to `karma.tool`; `system.tool`
  has no keystore/RPC dependency and no canary. [verified 2026-06-16]
- Fix anchors re-read: `src/plugins/karma.tool.ts` `assertInProcess` requires `isTrustedRuntime()`;
  `src/core/plugin_loader.ts` `loadAll` marks trust before any handler can run. [verified 2026-06-16]

## 8. Owner
**KARMA team — gokuderafight@gmail.com**

## 8b. Known Debts (PATTERN-DEBT)
  - PD-001: RESOLVED — env-locked plugin-permission test stays skip-guarded (1 skipped is expected).
  - PD-002: OPEN, trigger NOT fired — `realKarmaService` was not modified (only a trust marker was
    added to the demo scripts).
  - PD-003: OPEN, trigger NOT fired — no contract/scale change.
  - DEBT-001 (src/core/pattern_debt.ts): unchanged — this ADR hardens the trusted side of the
    split; DEBT-001 remains OPEN for OS isolation of the untrusted runtime (conditionally
    release-blocking: blocks the third-party-plugin feature, not the built-in-only deployment).

## 9. Next Cycle Trigger
When a new in-process entrypoint that builds/invokes `karma.tool` handlers without calling
`PluginLoader.loadAll` is added (observable: a new `createKarmaTools`/`karmaTools.handler` call
site outside loadAll) — it must call `markTrustedRuntime()`, OR the canary should be re-evaluated
for a more intrinsic trust signal.

## 10. Cycle Retrospective
- The fail-open vs fail-closed distinction was the whole point: the originally-proposed
  "check singleton initialized" fix is unsound — the singletons are legitimately empty in a real
  parent, so it would throw in production.
- Surprise: vitest's default pool is `forks` (IPC child), which silently breaks any
  `process.send`-based "am I the worker" heuristic across the entire suite.
- Fail-closed has an inherent blast radius — every in-process caller (2 demo scripts + 2 test
  files) had to declare trust. That cost is real but contained, and it fails loud, not silent.
- Knowingly bundled pre-existing DEBT-002 lint debt into this branch to get `pnpm run ci` green;
  fixed at the correct level (config for systematic fetch/Response, code for local any/unused).
- Next agent: if you add an in-process karma.tool entrypoint and get a "must run in the trusted
  in-process runtime" throw, you forgot `markTrustedRuntime()` — that's the fail-closed default
  working as designed, not a bug.
