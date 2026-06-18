# KARMA

**KARMA** is a blockchain-backed AI agent skill economy built on top of **SUPER-MCP** — a hardened TypeScript / ESM framework for production-oriented [Model Context Protocol](https://modelcontextprotocol.io/) servers.

The system has three layers:

- **Layer 0 — SUPER-MCP runtime:** stdio/HTTP transports, native Tasks, durable storage, authentication, request governance, output redaction, plugin isolation, pattern debt reporting.
- **Layer 1 — KARMA plugin (`karma.tool.ts`):** Thirteen MCP tools for skill registration, BM25 discovery, on-chain job lifecycle (escrow → deliver → confirm, plus dispute / claim-after-review and single-job reads for reconciliation), reputation reading, social-graph queries, and balance withdrawals. Runs in-process as a trusted built-in; private keys never leave the process and every tool is bound to the caller's tenant (STRIDE-S).
- **Layer 2 — `AgentSkillRegistry` contract (v3):** Deployed Solidity escrow contract on Pharos Atlantic (`chainId=688689`). Manages skills, jobs, escrow, reputation, on-chain Trust Gate, and withdrawals. Verified live at [`0xc6d5c146…b905ae`](https://atlantic.pharosscan.xyz/address/0xc6d5c146209e0833634bd33fafb9e65081b905ae).

> Package: `karma`
> Runtime entrypoint: `dist/index.js`
> Default transport: `stdio`
> Default protocol mode: `rc2026` only
> Default storage: local filesystem (`fs`)
> Default plugin isolation mode: external child-process best-effort runner for non-built-in plugins
> Production storage requirement: Redis
> Production HTTP auth requirement: JWT or OIDC JWKS, not API key

KARMA intentionally does **not** claim to provide a true security sandbox for untrusted plugins — that remains a release-blocking epic (DEBT-001) until implemented with a real container/microVM/WASM runner. KMS-backed crypto-erasure (`smcp:v4:kms`) **shipped 2026-06-14** across Vault / AWS-KMS / GCP-KMS providers (DEBT-002 resolved); the only residual is AWS KMS's mandatory 7-day pending-deletion window.

---

## Table of contents

1. [Current status](#current-status)
2. [What KARMA provides](#what-karma-provides)
3. [Architecture](#architecture)
4. [Repository layout](#repository-layout)
5. [Requirements](#requirements)
6. [Install and validation](#install-and-validation)
7. [KARMA skill economy (Layer 1 + 2)](#karma-skill-economy-layer-1--2)
8. [Pharos Atlantic configuration](#pharos-atlantic-configuration)
9. [Keystore management](#keystore-management)
10. [Deploying the contract](#deploying-the-contract)
11. [Running the demo](#running-the-demo)
12. [Quick start: stdio](#quick-start-stdio)
13. [Quick start: local HTTP](#quick-start-local-http)
14. [Production HTTP configuration](#production-http-configuration)
15. [MCP protocol behavior](#mcp-protocol-behavior)
16. [Authentication and request context](#authentication-and-request-context)
17. [Native Tasks](#native-tasks)
18. [Tool execution pipeline](#tool-execution-pipeline)
19. [Storage and encryption](#storage-and-encryption)
20. [Rate limit, quota, idempotency, and locks](#rate-limit-quota-idempotency-and-locks)
21. [Output firewall](#output-firewall)
22. [Plugin system](#plugin-system)
23. [Writing plugins](#writing-plugins)
24. [HTTP endpoints and headers](#http-endpoints-and-headers)
25. [Docker / Compose](#docker--compose)
26. [Configuration reference](#configuration-reference)
27. [Testing and quality gates](#testing-and-quality-gates)
28. [Pattern debt and limitations](#pattern-debt-and-limitations)
29. [Troubleshooting](#troubleshooting)
30. [License](#license)

---

## Current status

### Layer 0 — SUPER-MCP runtime (fully shipped)

- `tasks/update` is state-gated and nonce-bound.
- Task input can be consumed only once and only while the task is `input_required`.
- Stale, duplicate, early, and wrong-owner task input updates are rejected.
- Production HTTP + JWT requires issuer, audience, and resource indicator.
- Production HTTP + OIDC JWKS requires JWKS URI, issuer, audience, and resource indicator.
- Production HTTP requires rate limit and quota unless `MCP_ALLOW_UNLIMITED_HTTP=true` is explicitly set.
- Production non-built-in plugins fail closed unless `MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true` is explicitly waived, and require SHA-256 pinning + Node Permission model.
- `MCP_IDEMPOTENCY_SECRET` is required when `STORAGE_DRIVER=redis`.
- Identity gateway headers properly map to `gateway` auth type, enforcing scopes.
- `LocalEnvVault` forces per-tenant namespace isolation.
- Data at rest is encrypted with the `smcp:v3:hkdf-tenant` envelope.
- `smcp:v4:kms` KMS-backed per-tenant DEK crypto-erasure is implemented (2026-06-14). Four providers: `LocalKeyRegistry` (dev/test), `VaultKeyRegistry`, `AwsKmsKeyRegistry`, and `GcpKmsKeyRegistry`.
- Fully migrated to the v2.0 Modular SDK architecture (`@modelcontextprotocol/server`, `node`, `express`).
- Enterprise regression tests available through `pnpm test:enterprise`.
- Non-idempotent tools that have started execution keep their idempotency record on transient failure (`canReleaseIdempotency`) — blind auto-retries cannot double-execute an irreversible side-effect such as an on-chain escrow tx (Fix 1 / ADR-006, 2026-06-17).
- Execution-lock heartbeat that loses the Redis lock skips the release `DEL` — the orphaned operation may still be running; the TTL expiry is the safe path (Fix 2, 2026-06-17).
- Transient Redis errors during lock acquisition are retried within the deadline; permanent errors (auth/syntax) are rethrown immediately; a store blip while a task waits for input is retried, not fatal (Fix 3, 2026-06-17).
- `TaskTracker.track` accepts a thunk so the drain-gate check and the start decision are atomic — closes the track-after-start TOCTOU; hard-timeout timer cleared on settle (Fix 4 / ADR-006, 2026-06-17).

### Layer 1 — KARMA plugin (fully shipped, 2026-06-16)

- Thirteen in-process tools over the `KarmaService` DI seam: `karma_health`, `register_skill`, `discover_skills`, `create_job`, `deliver_result`, `complete_job`, `dispute_result`, `claim_after_review`, `read_job`, `get_agent_reputation`, `query_social_graph`, `get_pending_balance`, `withdraw_balance`. Lifecycle writes (`deliver_result`/`complete_job`/`dispute_result`/`claim_after_review`) read the job first and return a graceful `already_done` / `unexpected_state` instead of an opaque revert when a timed-out tx actually mined (R2/ADR-2 idempotency); `read_job` lets an agent reconcile a job by id. Every tool that resolves a signing account threads the caller's `tenantId` (`getRequestContext()`) into `KarmaService.account/addressOf`, which fails closed via `KeystoreManager.assertOwnedBy` (STRIDE-S tenant→agent isolation).
- Web3 Secret Storage v3 keystore (`KeystoreManager`): scrypt + aes-128-ctr in-process decrypt. Private keys never exposed — only viem `Account` objects.
- In-process BM25 skill index (`BM25SkillIndex` via MiniSearch): reputation-boosted ranking, BigInt-safe price/reputation filters, prompt-injection-resistant text sanitization.
- `SkillEventIndexer`: paginated backfill (max `KARMA_INDEXER_BLOCK_RANGE` blocks per `eth_getLogs` call, default 2000) + live-watch + reconnect with capped exponential backoff; unhandled rejections caught by a last-resort `process.on("unhandledRejection")` net in `src/index.ts`. Started at server boot by `startKarmaIndexer` (`src/lib/skill_indexer_runtime.ts`), which reconciles chain events into the BM25 index (SkillRegistered → hydrate+upsert, SkillDeactivated → discard, JobCompleted → refresh that skill's reputation, BondUpdated → mirror seed-eligible bond). Health state (`lastIndexedBlock`, `lastEventAt`, `watching`, `lastError`, `reconnectAttempts`) is surfaced through `karma_health` (`indexer` field).
- Bounded write helper: exactly-once broadcast with `RECEIPT_TIMEOUT_MS=300_000 < MCP_LOCK_TTL_MS=420_000`. Timeout → `pending` outcome; never resend.
- Exactly-once job guard: `deriveTaskHash(requester, skillId, nonce)` → check-before-write via the on-chain `jobByTaskHash` mapping (O(1), v3; PD-003). No double-escrow on lost-ACK retry.
- All `uint256` amounts and IDs cross the MCP boundary as decimal strings (`jsonSafe`, D-6).

### Layer 2 — AgentSkillRegistry contract (live on Pharos Atlantic)

- Deployed (v3): [`0xc6d5c146209e0833634bd33fafb9e65081b905ae`](https://atlantic.pharosscan.xyz/address/0xc6d5c146209e0833634bd33fafb9e65081b905ae)
- Deploy tx: [`0x6946560a…b73cf5`](https://atlantic.pharosscan.xyz/tx/0x6946560ac9ae8dfeb535ad9ca45e6988eb76513876eff83afcfd9ff029b73cf5) (block 24360873, gas 1,773,609). The v2 contract is superseded.
- v3 escrow resolution (no permanent fund lock): `deliverResult` opens a `REVIEW_WINDOW` (3 days); the requester may `confirmCompletion` any time, `disputeResult` within the window (refund), or — if the requester ghosts — the provider may `claimAfterReview` after the window.
- On-chain Trust Gate: `Skill.minReputationToInvoke` + lazy-base-50 `agentReputation` (earned only on arm's-length completions); `createJob` reverts below the threshold.
- Reputation: BASE=50, MAX=100, STEP=5, REVIEW_WINDOW=3 days (matches the 34 Foundry tests).
- Tier-2 Sybil-resistance bond: Optional, per-agent capital-at-risk seed for off-chain flow reputation. Locked while active, withdrawable after a 7-day cooldown (PD-007). Not a paywall, but deters Sybil identities by requiring capital lockup.
- ABI drift-guarded: `src/__tests__/karma_contract.test.ts` re-reads the Foundry artifact and fails if the Solidity surface diverges from `src/lib/abi.ts`.

Known residual gaps are tracked in `src/core/pattern_debt.ts` (Layer 0, queried live by `karma_pattern_debt`) and `docs/superpowers/pattern-debt.md` (KARMA app layer).

---

## What KARMA provides

### Layer 0 — MCP runtime

- MCP `stdio` transport for local clients.
- Stateless HTTP MCP transport at `/mcp`.
- Final local protocol target `rc2026`; legacy/compat modes are rejected.
- `server/discover`, `tools/list`, `tools/call`, `tasks/get`, `tasks/update`, and `tasks/cancel` handlers.
- Native Tasks-style long-running execution with durable task records.
- Local filesystem, Redis, and memory storage drivers.
- State/vault encryption-at-rest: `smcp:v4:kms` (primary with `KMS_PROVIDER`), `smcp:v3:hkdf-tenant` (default), `smcp:v2:scrypt` (fallback).
- API key, JWT, and OIDC JWKS auth.
- OAuth Resource Server metadata and resource-indicator enforcement.
- Rate limiting, quota, idempotency, tenant execution locks, JSON Schema 2020-12 validation, timeout handling, output firewall, and telemetry.
- Plugin governance with allowlists, SHA-256 hash pinning, manifest pinning, safe mode, capability declarations, and external plugin runner.
- Runtime pattern-debt reporting through `karma_pattern_debt`.
- File/stdout/stderr JSONL telemetry and optional OpenTelemetry OTLP export.

### Layer 1 — KARMA skill economy tools

- **`karma_health`** — In-process runtime canary; confirms RPC and contract env presence and reports skill-indexer state (`indexer`: `watching`, `lastIndexedBlock`, `lastEventAt`, `lastError`, `reconnectAttempts`, or `{ started: false }`).
- **`register_skill`** — Broadcast `registerSkill(name, description, endpoint, price, minReputationToInvoke)` on-chain and upsert into the BM25 index. Optional `minReputationToInvoke` (0..100) sets a **Trust Gate** — now **on-chain enforced** by `createJob` (v3); the app layer preflights it to avoid a wasted tx.
- **`discover_skills`** — BM25 free-text search (prefix + fuzzy) with reputation-boost ranking (or flow reputation via `KARMA_DISCOVERY_RANK=flow`), `maxPriceWei` and `minReputation` filters. Hits expose each skill's `min_reputation_to_invoke`.
- **`create_job`** — Idempotent escrow: derives `taskHash(requester, skillId, nonce)`, checks existing (O(1) `jobByTaskHash`) before broadcast. Returns `exists` on replay, `confirmed`/`pending` on new. **Trust Gate:** if the requester's on-chain `agentReputation` is below the skill's `minReputationToInvoke`, replies `rejected` (`reason: "insufficient_reputation"`) before escrow (and the contract would also revert).
- **`deliver_result`** — Provider submits `resultHash` (bytes32) for an open job; opens the 3-day review window.
- **`complete_job`** — Requester confirms; releases escrow to provider's withdrawable balance and bumps reputation (skill + both agents, arm's-length only).
- **`dispute_result`** — Requester rejects a delivered result within the review window; escrow is refunded and the job moves to `Disputed`.
- **`claim_after_review`** — Provider claims payment after the review window if the requester neither confirmed nor disputed (anti-deadlock).
- **`get_agent_reputation`** — Read an agent's skills with reputation scores and invocation counts, plus on-chain `agentReputation` (lazy base-50, earned on arm's-length completions) — the value the Trust Gate checks against.
- **`query_social_graph`** — Job edges for an agent (as provider and as requester); `format: "full"` hydrates each edge into job details plus a summary.
- **`get_pending_balance`** — Read an agent's withdrawable balance (`pendingWithdrawals`) in wei and formatted PHRS; accepts an `agentId` or raw `address`.
- **`withdraw_balance`** — Pull the agent's full released-escrow balance to its wallet, closing the economic loop entirely inside MCP. Returns `amountWei` decoded from the `Withdrawn` event.

### Explicit non-claims

- The external Node child-process plugin runner is best-effort hardening, not a true OS/container/microVM sandbox.
- `karma.tool.ts` uses an in-process keystore singleton and is **not** safe in the external worker — `assertInProcess()` throws at startup in that path.
- KMS-backed crypto-erasure is implemented but AWS KMS has a mandatory 7-day pending-deletion window.
- KARMA is an OAuth Resource Server; it does not implement client-side PKCE or TokenManager flows.
- The BM25 index is in-process and lost on restart; `SkillEventIndexer` rebuilds it from chain events on startup.

---

## Architecture

```text
Client
  | stdio or HTTP /mcp
  v
Transport layer
  |-- stdio: MCP StdioServerTransport
  |-- HTTP: Express + stateless StreamableHTTPServerTransport
  v
HTTP safety layer (HTTP mode only)
  |-- Host allowlist, CORS, body size
  |-- API key / JWT / OIDC JWKS auth + resource indicator
  |-- RequestContext resolution
  |-- rc2026 Mcp-Method / Mcp-Name header checks
  v
Protocol adapter
  |-- server/discover, tools/list, tools/call
  |-- tasks/get, tasks/update, tasks/cancel
  v
Execution pipeline
  |-- Plugin manifest stability
  |-- Rate limit and quota
  |-- Required scope check
  |-- Confidence / elicitation guard
  |-- Idempotency acquire / cache
  |-- Tenant execution lock
  |-- JSON Schema 2020-12 input/output validation
  |-- Timeout / abort handling
  |-- Output firewall
  |-- State persistence
  |-- Telemetry and optional OTEL spans
  v
Built-in plugin: karma.tool.ts (in-process, trusted)
  |-- KarmaService (DI seam)
  |   |-- keystoreManager (Web3 v3 keystore, private keys in-process only)
  |   |-- BM25SkillIndex (MiniSearch, reputation-boosted, sanitized)
  |   |-- contract.ts (viem public + wallet clients)
  |       |-- writeContractBounded (exactly-once, pending on timeout)
  |       |-- SkillEventIndexer (backfill + live-watch + reconnect)
  v
AgentSkillRegistry.sol v3 (Pharos Atlantic, chainId=688689)
  |-- registerSkill (+minReputationToInvoke) / deactivateSkill / setMinReputation
  |-- createJob (payable, escrow, Trust-Gate require) / deliverResult (opens review window)
  |-- confirmCompletion / claimAfterReview / disputeResult / claimRefund
  |-- agentReputation / pendingWithdrawals / withdraw / jobByTaskHash
  |-- getAgentSkills / getProviderJobs / getRequesterJobs
  |-- depositBond / requestBondUnlock / cancelBondUnlock / withdrawBond / seedEligibleBond
  v
Storage / telemetry
  |-- memory / local filesystem / Redis
  |-- smcp:v4:kms / smcp:v3:hkdf-tenant / smcp:v2:scrypt
  |-- file / stdout / stderr / OTLP
```

---

## Repository layout

```text
.
├── Containerfile
├── compose.yaml
├── DEMO.md                          ← live demo results (Pharos Atlantic)
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── foundry.toml                     ← Foundry for contract tests
├── src/
│   ├── index.ts
│   ├── config/env.ts
│   ├── core/
│   │   ├── pattern_debt.ts
│   │   ├── plugin_external_runner.ts
│   │   ├── plugin_loader.ts
│   │   ├── plugin_runner.ts
│   │   ├── plugin_worker.ts
│   │   ├── registrar.ts
│   │   ├── runtime.ts
│   │   ├── runtime_identity.ts      ← fail-closed trusted-runtime marker (karma.tool canary)
│   │   ├── task_store.ts
│   │   └── task_tracker.ts
│   ├── http/
│   │   ├── oauth_metadata.ts
│   │   ├── security.ts
│   │   └── server_card.ts
│   ├── lib/                         ← KARMA app layer (Layer 1)
│   │   ├── abi.ts                   ← typed ABI for AgentSkillRegistry.sol
│   │   ├── bm25_index.ts            ← BM25SkillIndex (MiniSearch, incremental, sanitized)
│   │   ├── contract.ts              ← Pharos viem clients, bounded write, exactly-once guard, SkillEventIndexer
│   │   ├── flow_reputation.ts       ← Tier-1 Flow Reputation (EigenTrust-lite) graph ranking
│   │   ├── karma_service.ts         ← KarmaService interface + realKarmaService
│   │   ├── keystore.ts              ← KeystoreManager (Web3 v3 scrypt decrypt/encrypt)
│   │   ├── serialize.ts             ← jsonSafe() — BigInt → string (D-6)
│   │   ├── skill_indexer_runtime.ts ← startKarmaIndexer server-boot helper; getKarmaIndexerHealth()
│   │   └── types.ts                 ← AgentIdentity, CryptoV3, KeystoreFileV3, SkillDocument
│   ├── mcp/adapter/
│   │   ├── execution_pipeline.ts
│   │   ├── mcp_protocol_adapter.ts
│   │   ├── schema_guard.ts
│   │   ├── task_runtime.ts
│   │   └── tool_registry.ts
│   ├── middlewares/
│   │   ├── execution_lock.ts
│   │   ├── guardrails.ts
│   │   ├── idempotency.ts
│   │   ├── output_firewall.ts
│   │   ├── protocol_header.ts
│   │   ├── quota.ts
│   │   ├── rate_limit.ts
│   │   └── vault.ts
│   ├── plugins/
│   │   ├── karma.tool.ts            ← KARMA skill economy (13 tools, trusted built-in)
│   │   └── system.tool.ts           ← ping + pattern_debt + test_long_task
│   ├── scripts/
│   │   ├── _demo_format.ts          ← zero-dep ANSI presentation helpers for the demos
│   │   ├── check_connectivity.ts    ← verify Pharos Atlantic chainId/gasMode
│   │   ├── deploy_contract.ts       ← deploy AgentSkillRegistry (keystore-signed)
│   │   ├── deposit_bond.ts          ← lock Sybil-resistance bond for an agent (Tier-2)
│   │   ├── discover_demo.ts         ← offline BM25 discovery showcase (ranking + injection-strip)
│   │   ├── migrate_encryption.ts    ← re-encrypt pre-V4 blobs
│   │   ├── migrate_to_v2.ts         ← v1→v2 skill re-registration (pure planMigration + IO)
│   │   ├── run_demo.ts              ← 5-tx self-referential KARMA loop
│   │   ├── setup_keystore.ts        ← generate multi-agent Web3 v3 keystore
│   │   └── verify_demo.ts           ← read-only post-demo on-chain verification
│   ├── security/
│   │   ├── auth.ts
│   │   ├── context.ts
│   │   ├── policy.ts
│   │   └── sanitize.ts
│   ├── storage/
│   │   ├── audit_store.ts
│   │   ├── caching_key_registry.ts
│   │   ├── encryption.ts
│   │   ├── factory.ts
│   │   ├── interface.ts
│   │   ├── key_registry.ts
│   │   ├── key_registry_factory.ts
│   │   ├── local_fs.ts
│   │   ├── memory.ts
│   │   ├── providers/
│   │   │   ├── aws_kms_key_registry.ts
│   │   │   ├── gcp_kms_key_registry.ts
│   │   │   ├── local_key_registry.ts
│   │   │   └── vault_key_registry.ts
│   │   ├── redis.ts
│   │   └── redis_client.ts
│   ├── telemetry/
│   │   ├── factory.ts
│   │   ├── file_logger.ts
│   │   ├── interface.ts
│   │   ├── otel.ts
│   │   ├── redaction.ts
│   │   ├── stderr_logger.ts
│   │   └── stdout_logger.ts
│   ├── types/schemas.ts
│   └── __tests__/
│       ├── bm25_index.test.ts
│       ├── karma_builtin_plugin.test.ts
│       ├── karma_contract.test.ts   ← ABI drift guard vs Foundry artifact
│       ├── karma_exactly_once.test.ts
│       ├── karma_indexer.test.ts
│       ├── karma_plugin_health.test.ts
│       ├── karma_tools.test.ts
│       ├── karma_write_helper.test.ts
│       ├── keystore.test.ts
│       ├── serialize.test.ts
│       └── ... (Layer 0 enterprise suites)
```

Important implementation files:

| File | Purpose |
| --- | --- |
| `src/index.ts` | Server startup, HTTP/stdio transport, auth, graceful shutdown. |
| `src/config/env.ts` | Environment schema, defaults, fail-fast production gates. |
| `src/lib/abi.ts` | Typed ABI for `AgentSkillRegistry.sol`; drift-guard test in `karma_contract.test.ts`. |
| `src/lib/bm25_index.ts` | `BM25SkillIndex` — MiniSearch, reputation-boosted ranking, BigInt-safe filters, prompt-injection sanitization. |
| `src/lib/contract.ts` | Pharos viem clients; `runBoundedWrite` (exactly-once); `deriveTaskHash` (dedup key, resolved O(1) via the on-chain `jobByTaskHash` mapping); `SkillEventIndexer` (backfill + reconnect). |
| `src/lib/karma_service.ts` | `KarmaService` interface (DI seam) + `realKarmaService` (live clients, keystore, index). |
| `src/lib/keystore.ts` | `KeystoreManager` — Web3 v3 scrypt/aes-128-ctr decrypt; `encryptPrivateKeyV3` for keystore setup. |
| `src/lib/serialize.ts` | `jsonSafe()` — recursive BigInt → decimal string (D-6). |
| `src/lib/skill_indexer_runtime.ts` | `startKarmaIndexer` server-boot helper (singleton); `getKarmaIndexerHealth()` surfaces `IndexerHealth` to `karma_health`. |
| `src/lib/types.ts` | `AgentIdentity`, `CryptoV3`, `KeystoreFileV3`, `SkillDocument`. |
| `src/plugins/karma.tool.ts` | 13 KARMA tools; trusted in-process built-in; tenant-bound; `assertInProcess()` fail-fast. |
| `src/plugins/system.tool.ts` | Built-in: `karma_ping`, `karma_pattern_debt`, `karma_test_long_task`. |
| `src/mcp/adapter/execution_pipeline.ts` | Tool call governance, native task execution, state save, telemetry. |
| `src/core/task_store.ts` | Durable task store with local/memory/Redis and atomic input consume. |
| `src/storage/encryption.ts` | Encryption-at-rest: `smcp:v4:kms`, `smcp:v3:hkdf-tenant`, `smcp:v2:scrypt`. |

---

## Requirements

Recommended local runtime:

- Node.js 20+.
- pnpm 9.15.9.
- Redis **8.2.2+** when `STORAGE_DRIVER=redis`. CVE-2025-49844 (Lua GC Use-After-Free, CVSS 10.0) affects Redis ≤ 8.2.1.
- **Foundry** (`forge`) for running contract tests (`pnpm test:contract`). Install via `foundryup`.
- A JWKS endpoint if using `MCP_AUTH_MODE=oidc_jwks`.
- A funded Pharos Atlantic wallet for contract deployment and the demo.

The `Containerfile` uses Node 20 Alpine and pnpm 9.15.9 in the builder stage.

---

## Install and validation

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test:enterprise
pnpm audit --audit-level=high
```

To also run KARMA contract tests (requires Foundry):

```bash
pnpm test:contract
```

Development server:

```bash
pnpm dev
```

Production build and start:

```bash
pnpm build
pnpm start
```

---

## KARMA skill economy (Layer 1 + 2)

KARMA's app layer adds an on-chain skill marketplace on top of the MCP runtime. Agents register skills (with price and endpoint), discover each other via BM25, and exchange value through an escrow job lifecycle:

```text
Agent A (provider)                        Agent B (requester)
  register_skill ──────────────────────►  discover_skills
         │                                      │
         │               create_job ◄───────────┘  (escrows B's PHRS)
         │                   │
  deliver_result ◄───────────┘
         │
         └──────────────────────────────► complete_job  (releases escrow, bumps A's reputation)
                                               │
  withdraw ◄─────────────────────────────────┘
```

### KARMA tools

| Tool | Type | Description |
| --- | --- | --- |
| `karma_health` | read-only | Canary: confirms in-process mode and presence of `PHAROS_RPC_URL` / `PHAROS_CONTRACT_ADDRESS`; reports skill-indexer health (`indexer.watching` / `lastIndexedBlock` / `lastEventAt` / `lastError` / `reconnectAttempts`, or `{ started: false }`). |
| `register_skill` | write | Broadcast `registerSkill` on-chain and upsert into BM25 index. Returns `pending` if receipt times out. Optional `minReputationToInvoke` (0..100) sets the on-chain Trust Gate threshold. |
| `discover_skills` | read-only | BM25 free-text search (prefix + fuzzy 0.2, name boost ×2), reputation-boosted ranking, optional `maxPriceWei` and `minReputation` filters. Hits include `min_reputation_to_invoke`. |
| `create_job` | write (idempotent) | Derive `taskHash(requester, skillId, idempotencyNonce)`, check existing (O(1) `jobByTaskHash`) before broadcast. Reply `exists` on replay. **Trust Gate:** replies `rejected` if on-chain `agentReputation` < the skill's `minReputationToInvoke`, before any escrow (contract also reverts). |
| `deliver_result` | write | Provider submits `resultHash` (0x + 64 hex) for an open job; opens the 3-day review window. |
| `complete_job` | write | Requester confirms; escrow credited to provider's withdrawable balance; skill reputation +5; arm's-length agent reputation +5. |
| `dispute_result` | write | Requester rejects a delivered result within the review window → refund + `Disputed`. Reverts on-chain after the window. |
| `claim_after_review` | write | Provider claims payment after the review window if the requester ghosted (anti-deadlock). Reverts while the window is open. |
| `get_agent_reputation` | read-only | Agent's skills with `reputation`, `totalInvocations`, `active`, plus on-chain `agentReputation` (lazy base-50; Trust Gate input). |
| `query_social_graph` | read-only | Job edges for an agent: `asProvider` and `asRequester` job-ID arrays (`format: "full"` → hydrated details + summary). |
| `get_pending_balance` | read-only | Agent's withdrawable balance (`pendingWithdrawals`) as `withdrawableWei` + `formattedPHRS`; accepts `agentId` or `address`. |
| `withdraw_balance` | write | Pull full released escrow to the agent's wallet; `amountWei` decoded from the `Withdrawn` event. Reverts on-chain if nothing to withdraw. |
| `read_job` | read-only | Read a single job's on-chain state by `jobId` (parties, skill, escrow, deadline, lifecycle status, result hash). Use to reconcile after a write returns `status:"pending"` or to verify a lifecycle transition already happened on-chain. |

### Required plugin configuration for the app layer

`karma.tool.ts` **must** run in-process. The external child-process runner strips `process.env` and reinitializes module-level singletons (`keystoreManager`, `skillIndex`) empty on every call.

```env
MCP_PLUGIN_ALLOWLIST=system.tool.js,system.tool.ts,karma.tool.ts
MCP_PLUGIN_ISOLATION_MODE=policy
MCP_SAFE_MODE=false
```

`MCP_PLUGIN_ISOLATION_MODE=policy` ensures `karma.tool.ts` is treated as a trusted built-in and never dispatched to the external runner. `MCP_SAFE_MODE=false` is required because `karma.tool.ts` declares the `network` capability, which safe mode blocks.

`assertInProcess()` inside every tool handler will throw immediately if the plugin is not loaded into the trusted runtime (`isTrustedRuntime()`), or if it detects the legacy worker environment (`KARMA_PLUGIN_WORKER=1`).

### BigInt safety (D-6)

All `uint256` amounts, skill IDs, and job IDs cross the MCP boundary as **decimal strings**. The `jsonSafe()` helper in `src/lib/serialize.ts` recursively converts every `BigInt` in `structuredContent` before the tool returns. Tool inputs accept wei amounts as base-10 strings validated by the `WEI` Zod schema.

### BM25 index

The in-process `BM25SkillIndex` (powered by MiniSearch) is rebuilt from chain events on startup via `SkillEventIndexer`:

- `SkillRegistered` → `upsert(doc)` (sanitized name/description).
- `SkillDeactivated` → `discard(skillId)`.
- `BondUpdated` → mirror seed-eligible bond into flow reputation (Tier-2).
- Ranking blends BM25 text score with on-chain `reputationScore` (0–100 → boost factor 1.0–2.0).
- Price and reputation filters compare using `BigInt`/`Number` — no coercion of `uint256` through a JS number.
- Skill name/description is sanitized before indexing: control characters, zero-width characters, BiDi overrides, and BOM are stripped; whitespace is collapsed; length is capped at 2000 characters. This prevents attacker-controlled skill metadata from smuggling hidden instructions to a discovering agent.

---

## Pharos Atlantic configuration

Pharos Atlantic is the testnet used for the KARMA skill economy. Live-verified chain parameters:

| Parameter | Value |
| --- | --- |
| Chain ID | `688689` |
| Gas mode | EIP-1559 |
| RPC | `https://atlantic.dplabs-internal.com` |
| Explorer | `https://atlantic.pharosscan.xyz` |
| Native currency | PHRS (18 decimals) |
| Faucets | [Stakely](https://stakely.io/faucet/pharos-atlantic-testnet-phrs) · [gas.zip](https://www.gas.zip/faucet/pharos) · [Chainlink](https://faucets.chain.link/pharos-atlantic-testnet) |

Verify live connectivity before deploying:

```bash
PHAROS_RPC_URL=https://atlantic.dplabs-internal.com pnpm check:connectivity
```

The script prints `chainId`, `gasMode`, `baseFeePerGas`, and optionally a deployer balance.

Multicall3 is not verified deployed on Pharos Atlantic — the viem clients use batched JSON-RPC (`batchSize: 100`) instead of multicall as a safe reducer.

Relevant env vars:

| Variable | Default | Notes |
| --- | ---: | --- |
| `PHAROS_RPC_URL` | `https://atlantic.dplabs-internal.com` | Pharos Atlantic HTTP-RPC endpoint. |
| `PHAROS_CHAIN_ID` | `688689` | Chain ID; `688688` appears in some docs but live chain returns `688689`. |
| `PHAROS_CONTRACT_ADDRESS` | unset | Required for all contract interactions. Set after deploy. |
| `PHAROS_EXPLORER` | `https://atlantic.pharosscan.xyz` | Used by `run_demo.ts` for explorer links. |

---

## Keystore management

KARMA uses **Web3 Secret Storage v3** (scrypt + aes-128-ctr) for agent private keys. The `KeystoreManager` decrypts keys in-process at startup; raw private keys are never exposed — only viem `Account` objects (which sign internally). `KeystoreManager.unload(agentId)` / `clear()` drop decrypted accounts from the in-process map for agent offboarding or graceful shutdown so GC can reclaim them. See DEBT-007 for the limits of in-process key zeroization.

The keystore file format:

```json
{
  "version": 3,
  "agents": [
    {
      "agentId": "agent-alpha",
      "address": "0x857c2F11...",
      "tenant": "tenant-a",
      "crypto": { "cipher": "aes-128-ctr", "ciphertext": "...", ... }
    }
  ]
}
```

Each agent may carry an optional `tenant` (STRIDE-S tenant→agent isolation). A tool call may only
resolve an agent owned by the caller's `tenantId`; an agent with no `tenant` field binds **fail-closed**
to `KARMA_DEFAULT_AGENT_TENANT ?? MCP_TENANT_ID` (so single-operator stdio keeps working, and a
different multi-tenant caller is denied). In api-key/gateway deployments where the request tenant is
not `MCP_TENANT_ID`, set `KARMA_DEFAULT_AGENT_TENANT` or give each agent an explicit `tenant`.

### Generate a keystore

```bash
KEYSTORE_PATH=./keystore.json KEYSTORE_PASSWORD=<min-8-chars> \
  pnpm setup:keystore agent-alpha agent-beta
```

If no agent IDs are given, defaults to `agent-alpha` and `agent-beta`. The script:
- Generates fresh keypairs.
- Encrypts each with scrypt (n=8192 for testnet speed; raise for production).
- Writes to `KEYSTORE_PATH` with mode `0o600`.
- Prints each address so you can fund from a faucet.

Relevant env vars:

| Variable | Default | Notes |
| --- | ---: | --- |
| `KEYSTORE_PATH` | `./keystore.json` | Path to the Web3 v3 keystore JSON. |
| `KEYSTORE_PASSWORD` | unset | Password to unlock the keystore. Required for any write operation or the demo. |

---

## Deploying the contract

The `AgentSkillRegistry` contract must be compiled with Foundry and deployed using `deploy_contract.ts`.

### Prerequisites

1. Install Foundry: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
2. Generate a keystore: `pnpm setup:keystore`
3. Fund `agent-alpha` from a Pharos faucet.
4. Compile: `forge build`
5. Build TypeScript: `pnpm build`

### Deploy

```bash
KEYSTORE_PASSWORD=<password> pnpm exec tsx src/scripts/deploy_contract.ts
```

The script:
- Loads the keystore and `DEPLOYER_AGENT` (default: `agent-alpha`).
- Reads bytecode from `out/AgentSkillRegistry.sol/AgentSkillRegistry.json` (Foundry artifact).
- Simulates, broadcasts, and waits for the receipt.
- Prints the deployed address.

After deployment, record the address:

```env
PHAROS_CONTRACT_ADDRESS=0x<deployed-address>
```

The review window (time after `deliverResult` during which the requester may confirm or dispute) defaults to **3 days** (259 200 s). To deploy with a custom window (bounded 1 h–30 days), set `KARMA_REVIEW_WINDOW_SECS` before running the deploy script:

```bash
KARMA_REVIEW_WINDOW_SECS=86400 KEYSTORE_PASSWORD=<password> pnpm exec tsx src/scripts/deploy_contract.ts
```

This is a **deploy-time constructor argument** — it cannot be changed without redeploying the contract.

### ABI drift guard

`src/__tests__/karma_contract.test.ts` re-reads the Foundry artifact and fails if the Solidity function surface diverges from `src/lib/abi.ts`. Run it after any contract change:

```bash
pnpm test:contract           # Foundry tests for the Solidity logic
vitest run src/__tests__/karma_contract.test.ts  # ABI structural drift check
```

---

## Running the demo

`DEMO.md` documents a completed 5-transaction self-referential loop on Pharos Atlantic.

### Layer-2 discovery showcase (offline — no chain, no keystore)

```bash
pnpm demo:discover
```

Runs instantly against an in-memory BM25 index: relevance × on-chain-reputation ranking,
BigInt-safe price/reputation filters, and prompt-injection sanitization (hidden bidi / zero-width /
control code points stripped before any agent reads the skill). Lead with this — it needs no setup.

### Full economic loop (on-chain)

```bash
# 1. Fund agent-alpha (+ a little agent-beta) from a Pharos faucet (see addresses from setup:keystore).
# 2. Deploy the contract (if not already done):
KEYSTORE_PASSWORD=<password> pnpm exec tsx src/scripts/deploy_contract.ts

# 3. Set PHAROS_CONTRACT_ADDRESS in .env, then run the demo and verify:
PHAROS_CONTRACT_ADDRESS=0x<address> KEYSTORE_PASSWORD=<password> pnpm demo
PHAROS_CONTRACT_ADDRESS=0x<address> KEYSTORE_PASSWORD=<password> pnpm demo:verify
```

Demo knobs: `PHAROS_POLL_INTERVAL_MS=300` tightens viem's 4000ms receipt poll (the real driver of
perceived confirm latency); `DEMO_JSON=1` emits a machine-readable summary line; `NO_COLOR=1`
disables ANSI color.

The demo loop:
1. Alpha registers `discover_skills` as a paid skill (0.0001 PHRS).
2. Beta escrows a job (`create_job` with idempotency nonce), then **replays the identical request
   to prove exactly-once** — the second call returns the existing job and escrows nothing.
3. Alpha delivers a result hash.
4. Beta confirms completion (escrow credited to Alpha, reputation 50→55).
5. Alpha withdraws the payout. A Layer-0 hardening summary closes the run.

Each step calls the real tool handler (`karma.tool.ts`) → `realKarmaService` → Pharos Atlantic on-chain.

---

## Quick start: stdio

`stdio` is the default transport for local MCP clients that launch the server as a subprocess.

Minimal local `.env` (MCP runtime only, no app layer):

```env
TRANSPORT_DRIVER=stdio
STORAGE_DRIVER=fs
MCP_SAFE_MODE=true
MCP_PLUGIN_ALLOWLIST=system.tool.ts
MCP_PLUGIN_ISOLATION_MODE=external
```

To also enable the KARMA skill economy plugin:

```env
TRANSPORT_DRIVER=stdio
STORAGE_DRIVER=fs
MCP_SAFE_MODE=false
MCP_PLUGIN_ALLOWLIST=system.tool.ts,karma.tool.ts
MCP_PLUGIN_ISOLATION_MODE=policy
PHAROS_RPC_URL=https://atlantic.dplabs-internal.com
PHAROS_CONTRACT_ADDRESS=0x<deployed-address>
KEYSTORE_PATH=./keystore.json
KEYSTORE_PASSWORD=<password>
```

Build and run:

```bash
pnpm build
pnpm start
```

Example client config:

```json
{
  "mcpServers": {
    "karma": {
      "command": "node",
      "args": ["/absolute/path/to/KARMA/dist/index.js"],
      "env": {
        "TRANSPORT_DRIVER": "stdio",
        "STORAGE_DRIVER": "fs",
        "MCP_SAFE_MODE": "true"
      }
    }
  }
}
```

In stdio mode, telemetry defaults to `stderr` so stdout stays reserved for MCP protocol frames. `TELEMETRY_DRIVER=stdout` is rejected with `TRANSPORT_DRIVER=stdio`.

---

## Quick start: local HTTP

HTTP mode exposes stateless MCP at `/mcp`, plus health and metadata endpoints.

Local/dev HTTP with API key auth:

```env
NODE_ENV=development
TRANSPORT_DRIVER=http
HTTP_HOST=127.0.0.1
HTTP_PORT=3333
STORAGE_DRIVER=memory
TELEMETRY_DRIVER=stderr

MCP_AUTH_MODE=api_key
MCP_API_KEY=change-this-to-a-random-string-with-at-least-32-chars

ALLOWED_HOSTS=127.0.0.1:3333,localhost:3333
ALLOWED_ORIGINS=http://localhost:3333
MCP_SAFE_MODE=true
```

Start:

```bash
pnpm build
pnpm start
```

Health checks:

```bash
curl http://127.0.0.1:3333/health/liveness
curl http://127.0.0.1:3333/health/readiness
```

Discover metadata:

```bash
curl http://127.0.0.1:3333/.well-known/mcp.json
curl http://127.0.0.1:3333/.well-known/mcp-server-card
curl http://127.0.0.1:3333/.well-known/oauth-protected-resource
```

Example `tools/call` request:

```bash
curl -sS http://127.0.0.1:3333/mcp \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: change-this-to-a-random-string-with-at-least-32-chars' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: karma_ping' \
  --data '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "tools/call",
    "params": {
      "name": "karma_ping",
      "arguments": {"message": "hello"}
    }
  }'
```

API key mode is rejected for production HTTP. Use JWT or OIDC JWKS for production.

---

## Production HTTP configuration

Production means `NODE_ENV=production`.

Minimum production requirements enforced by `src/config/env.ts`:

- `STORAGE_DRIVER=redis` on Redis **8.2.2+** (CVE-2025-49844 patch required).
- `REDIS_URL` set.
- `MCP_ENCRYPTION_KEY` set.
- `MCP_IDEMPOTENCY_SECRET` set (min 32 chars).
- `TRANSPORT_DRIVER=http` must use `MCP_AUTH_MODE=jwt` or `MCP_AUTH_MODE=oidc_jwks`; `api_key` is rejected.
- `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` must be explicit and non-empty.
- `ENABLE_RATE_LIMIT=true` and `ENABLE_QUOTA=true`, unless `MCP_ALLOW_UNLIMITED_HTTP=true` is set.
- `MCP_ENABLE_TEST_TOOLS=false`.
- Non-built-in plugins require `MCP_PLUGIN_SHA256_ALLOWLIST`, `MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true`, and `MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true`.

Production HTTP + JWT shared secret:

```env
NODE_ENV=production
TRANSPORT_DRIVER=http
HTTP_HOST=0.0.0.0
HTTP_PORT=3333

STORAGE_DRIVER=redis
REDIS_URL=redis://:password@redis:6379
MCP_ENCRYPTION_KEY=base64url:<32-byte-base64url-key>

MCP_AUTH_MODE=jwt
MCP_JWT_SECRET=<at-least-32-chars>
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=karma-api
MCP_RESOURCE_URI=https://api.example.com/mcp
MCP_AUTHORIZATION_SERVERS=https://idp.example.com

ALLOWED_HOSTS=api.example.com
ALLOWED_ORIGINS=https://app.example.com
ENABLE_RATE_LIMIT=true
ENABLE_QUOTA=true

MCP_IDEMPOTENCY_SECRET=<random-string-at-least-32-chars>

MCP_SAFE_MODE=false
MCP_PLUGIN_ALLOWLIST=system.tool.js,karma.tool.js
MCP_PLUGIN_ISOLATION_MODE=policy

PHAROS_RPC_URL=https://atlantic.dplabs-internal.com
PHAROS_CONTRACT_ADDRESS=0x<deployed-address>
KEYSTORE_PATH=/run/secrets/keystore.json
KEYSTORE_PASSWORD=<password>
```

---

## MCP protocol behavior

Protocol decisions:

- `MCP_PROTOCOL_MODE` is a literal `rc2026`; other values fail config validation.
- HTTP is stateless: each POST `/mcp` creates an ephemeral MCP server/transport connection.
- HTTP clients must send `Mcp-Method` matching the JSON-RPC `method`.
- `tools/call` requests must also send `Mcp-Name` matching `params.name`.
- `server/discover` advertises protocol metadata, operation headers, tool metadata, and Tasks extension support.
- Native Tasks methods are supported: `tasks/get`, `tasks/update`, `tasks/cancel`.
- `tasks/list`, `check_task_status`, `isAsync`, and bespoke polling endpoints are intentionally not implemented.

---

## Authentication and request context

HTTP requests are authenticated before protocol execution.

Supported auth modes:

| Mode | Env | Current use |
| --- | --- | --- |
| API key | `MCP_AUTH_MODE=api_key` | Local/dev HTTP only; rejected for production HTTP. |
| JWT shared secret | `MCP_AUTH_MODE=jwt` | Symmetric deployments. Production requires issuer, audience, and resource URI. |
| OIDC JWKS | `MCP_AUTH_MODE=oidc_jwks` | Remote IdP / OAuth Resource Server deployments. |

### API key mode

```env
MCP_AUTH_MODE=api_key
MCP_API_KEY=<at-least-32-chars>
```

Client header:

```http
x-api-key: <key>
```

### JWT mode

```env
MCP_AUTH_MODE=jwt
MCP_JWT_SECRET=<at-least-32-chars>
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=karma-api
MCP_RESOURCE_URI=https://api.example.com/mcp
```

JWT context is derived from claims:

| Context field | Claims |
| --- | --- |
| `tenantId` | `mcp_tenant_id` or `tenant_id`; required. |
| `userId` | `sub` or `user_id`; fallback `jwt-user`. |
| `clientId` | `azp` or `client_id`; fallback `jwt-client`. |
| `scopes` | `scope` space-separated string or `scopes` array; capped at 32. |

### OIDC JWKS mode

```env
MCP_AUTH_MODE=oidc_jwks
MCP_JWKS_URI=https://idp.example.com/.well-known/jwks.json
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=karma-api
MCP_RESOURCE_URI=https://api.example.com/mcp
```

### Resource indicator enforcement

When `MCP_RESOURCE_URI` is configured, JWT/OIDC tokens must carry `aud` equal to or containing `MCP_RESOURCE_URI`, or a `resource` claim equal to it.

### Scopes

Tools may declare `requiredScopes`. Missing scopes reject tool calls before the handler executes for all non-stdio auth types.

---

## Native Tasks

KARMA supports native Tasks-style long-running execution.

Supported methods:

| Method | Purpose |
| --- | --- |
| `tasks/get` | Return task status, pending input requests, terminal result, error, or cancel reason. |
| `tasks/update` | Provide `inputResponses` for a task that is `input_required`. |
| `tasks/cancel` | Cancel a running or input-waiting task. |

Task ownership is scoped by `tenantId + clientId + userId`. `tasks/update` is state-gated and nonce-bound — only valid while the task is `input_required`, using the current `inputRequestId`.

---

## Tool execution pipeline

A tool call passes through these stages in `src/mcp/adapter/execution_pipeline.ts`:

1. Resolve request context.
2. Verify plugin manifest stability.
3. Apply rate limit and quota.
4. Enforce required scopes for all non-stdio auth types.
5. Apply safe-mode/security policy checks.
6. Validate JSON-serializable args for idempotency.
7. Generate and acquire an idempotency key.
8. Acquire a tenant execution lock (transient Redis errors retried within deadline; permanent errors rethrown immediately).
9. Validate input schema.
10. Execute tool handler with timeout/abort signal.
11. Validate output schema when present.
12. Run output firewall over text and structured content.
13. Save state.
14. Commit idempotency result; for non-idempotent tools that have started, keep the record on transient failure (`commitError`) so an auto-retry cannot double-execute an irreversible side-effect.
15. Log telemetry and OTEL spans.

---

## Storage and encryption

Storage drivers:

| Driver | Env | Use |
| --- | --- | --- |
| Local filesystem | `STORAGE_DRIVER=fs` | Local/dev durable state. |
| Redis | `STORAGE_DRIVER=redis` | Production durable state, tasks, idempotency, quota/rate data. |
| Memory | `STORAGE_DRIVER=memory` | Tests and ephemeral local HTTP. |

`MCP_ENCRYPTION_KEY` enables encryption-at-rest for state/vault blobs. Supported formats:

- Passphrase-style secret: per-blob scrypt derivation to an A256GCM JWE key.
- Raw key: `base64url:<32-byte-base64url-key>`.

Envelope formats (priority order):

```text
smcp:v4:kms:<base64url-json-SealedBlob>             ← primary when KMS_PROVIDER is set
smcp:v3:hkdf-tenant:<salt-base64url>:<compact-jwe>  ← primary without KMS_PROVIDER
smcp:v2:scrypt:<salt-base64url>:<compact-jwe>       ← fallback (no tenantId)
```

KMS providers:

| Provider | `KMS_PROVIDER` | Erasure model |
| --- | --- | --- |
| Local (dev/test only) | `local` | In-process; no real erasure. Rejected in production. |
| HashiCorp Vault Transit | `vault` | Immediate (key deletion in Transit). |
| AWS KMS | `aws-kms` | `DisableKey` (immediate) + `ScheduleKeyDeletion` (7-day mandatory). |
| GCP Cloud KMS | `gcp-kms` | `DESTROY_SCHEDULED` (immediately unusable, 24 h permanent). |

**Note on task record encryption:** Task records (including `lastClientInput.inputResponses`) are stored as plain JSON in Redis via `RedisTaskStore`. They are not covered by `MCP_ENCRYPTION_KEY` — that applies only to state and vault blobs. Ensure Redis is encrypted at rest and access-controlled at the infrastructure level.

To migrate pre-V4 blobs:

```bash
KMS_PROVIDER=vault pnpm migrate:encryption
```

---

## Rate limit, quota, idempotency, and locks

Rate limit:

```env
ENABLE_RATE_LIMIT=true
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_WINDOW_MS=60000
```

Quota:

```env
ENABLE_QUOTA=true
QUOTA_DAILY_LIMIT=1000
```

| Variable | Default | Meaning |
| --- | ---: | --- |
| `MCP_IDEMPOTENCY_WORKING_TTL_SECONDS` | `600` | TTL for in-progress idempotency records. |
| `MCP_IDEMPOTENCY_RESULT_TTL_SECONDS` | `604800` (Redis), `3600` (non-Redis) | TTL for successful cached results. |
| `MCP_IDEMPOTENCY_ERROR_TTL_SECONDS` | `300` | TTL for permanent error cache records. |
| `MCP_LOCK_TTL_MS` | `420000` | Tenant execution lock TTL. |
| `MCP_LOCK_ACQUIRE_DEADLINE_MS` | `420000` | Max wait to acquire tenant lock. |

The KARMA bounded-write receipt timeout (`RECEIPT_TIMEOUT_MS=300_000`) is deliberately set below `MCP_LOCK_TTL_MS` so a slow transaction never outlives its execution lock.

---

## Output firewall

The output firewall scans tool results before returning them and before committing idempotency results.

Covered surfaces:

- `content[].text`.
- `structuredContent` recursively.

Detected patterns include: private-key blocks, OpenAI-like keys, GitHub-like tokens, AWS access key IDs, Luhn-valid payment cards, SSN-like values, prompt-injection markers, and sensitive field names (`apiKey`, `secret`, `token`, `password`, `authorization`, `private_key`, and related variants).

**Error path (A2):** thrown tool errors are also sanitized — every error funnels through a single
`toClientError` chokepoint in `execution_pipeline.ts` and is passed through `redactErrorText`
(credentials/PII + filesystem paths + redis/postgres connection strings + bare private-key-shaped
`0x`+64hex, error-path-only) before the message reaches the client. The full error is retained
server-side in telemetry. `scanToolOutput` is deliberately left unchanged so legitimate
`result_hash`/`taskHash` values in normal output are never mangled.

Strict PII mode (opt-in):

```env
MCP_OUTPUT_FIREWALL_PII_MODE=strict
```

Strict mode additionally redacts email and phone-like values.

---

## Plugin system

Plugin files live in `src/plugins/`. Accepted filenames: `*.tool.ts` and `*.tool.js`.

### Built-in plugins

| Plugin | Notes |
| --- | --- |
| `system.tool.ts` | Always loaded. Provides `karma_ping`, `karma_pattern_debt`, and `karma_test_long_task` (dev only). |
| `karma.tool.ts` | KARMA skill economy. **Must** be trusted built-in (`MCP_PLUGIN_ISOLATION_MODE=policy`). Requires `MCP_SAFE_MODE=false`. |

### `karma.tool.ts` isolation requirement

`karma.tool.ts` must **not** be loaded through the external child-process runner:

- `keystoreManager` is a module singleton loaded once at startup; the external runner reinitializes it empty every call.
- `skillIndex` is a module singleton; the external runner loses all indexed documents.
- `process.env.PHAROS_*` and `process.env.KEYSTORE_*` are stripped by `workerEnv()` in the external runner.
- `assertInProcess()` in every handler throws if the runtime is not explicitly trusted (`!isTrustedRuntime()`) or if it detects the legacy worker environment (`KARMA_PLUGIN_WORKER=1`).

Required configuration:

```env
MCP_PLUGIN_ALLOWLIST=system.tool.js,system.tool.ts,karma.tool.ts
MCP_PLUGIN_ISOLATION_MODE=policy
MCP_SAFE_MODE=false
```

### SHA-256 allowlist (production non-built-in plugins)

```env
MCP_PLUGIN_SHA256_ALLOWLIST=my_plugin.tool.js:<sha256>
```

Required in production for any plugin that is not `system.tool` or `karma.tool`.

### Isolation modes

| Mode | Behavior |
| --- | --- |
| `external` | Non-built-in plugins run through `ChildProcessPluginRunner`. |
| `policy` | Trusted-only mode. Non-built-in plugins are rejected. Required for `karma.tool.ts`. |

---

## Writing plugins

A plugin exports a `ToolDefinition[]` as `default` or `tools`.

Minimal plugin example:

```ts
import { z } from "zod/v4";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

const tools: ToolDefinition[] = [
  {
    name: "example_echo",
    description: "Echo an input message.",
    inputSchema: { message: z.string().min(1) },
    allowedPhases: ["intake", "execution", "review", "completed"],
    capabilities: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      const input = args as { message: string };
      return {
        content: [{ type: "text", text: input.message }],
        structuredContent: { echoed: input.message },
      };
    },
  },
];

export default tools;
```

---

## HTTP endpoints and headers

| Route | Method | Purpose |
| --- | --- | --- |
| `/mcp` | POST | Stateless MCP JSON-RPC endpoint. |
| `/mcp` | GET/DELETE | Rejected with 405 in stateless HTTP mode. |
| `/health/liveness` | GET | Basic liveness. |
| `/health/readiness` | GET | Runtime/storage readiness. |
| `/.well-known/mcp.json` | GET | Server card. |
| `/.well-known/mcp-server-card` | GET | Server card alias. |
| `/.well-known/oauth-protected-resource` | GET | OAuth protected resource metadata. |

Required HTTP `/mcp` headers:

```http
Content-Type: application/json
Mcp-Method: <json-rpc-method>
Mcp-Name: <params.name>   (tools/call only)
```

---

## Docker / Compose

Build the image:

```bash
docker build -f Containerfile -t karma:local .
```

`compose.yaml` includes Redis and a hardened server container with read-only filesystem, `/tmp` tmpfs, dropped Linux capabilities, `no-new-privileges`, pid and memory limits.

A production-compatible JWT `.env` for Compose:

```env
REDIS_PASSWORD=change-this-redis-password
MCP_ENCRYPTION_KEY=base64url:<32-byte-base64url-key>
MCP_IDEMPOTENCY_SECRET=change-this-idempotency-secret-at-least-32-chars

MCP_AUTH_MODE=jwt
MCP_JWT_SECRET=change-this-jwt-secret-with-at-least-32-chars
MCP_JWT_ISSUER=https://idp.example.com
MCP_JWT_AUDIENCE=karma-api
MCP_RESOURCE_URI=https://api.example.com/mcp
MCP_AUTHORIZATION_SERVERS=https://idp.example.com

ALLOWED_HOSTS=api.example.com
ALLOWED_ORIGINS=https://app.example.com

PHAROS_CONTRACT_ADDRESS=0x<deployed-address>
```

Run:

```bash
docker compose up --build
```

---

## Configuration reference

All Layer 0 configuration is read in `src/config/env.ts`. KARMA app-layer env vars are read directly in `src/lib/contract.ts` and `src/plugins/karma.tool.ts`.

### Core runtime

| Variable | Default | Notes |
| --- | ---: | --- |
| `TRANSPORT_DRIVER` | `stdio` | `stdio` or `http`. |
| `HTTP_HOST` | `127.0.0.1` | HTTP bind host. |
| `HTTP_PORT` | `3333` | HTTP bind port. |
| `MCP_PROTOCOL_MODE` | `rc2026` | Only supported value. |
| `MCP_PROJECT_ID` | `karma_default` | Namespace for Redis/vault keys. |
| `MCP_TENANT_ID` | `tenant_local` | Local/stdio fallback tenant. |
| `MCP_SAFE_MODE` | `true` | Blocks `network` capability tools (including all KARMA tools). Set `false` to enable app layer. |
| `MCP_TOOL_TIMEOUT_MS` | `300000` | Per-tool timeout. |

### Pharos / KARMA app layer

| Variable | Default | Notes |
| --- | ---: | --- |
| `PHAROS_RPC_URL` | `https://atlantic.dplabs-internal.com` | Pharos Atlantic HTTP-RPC. |
| `PHAROS_CHAIN_ID` | `688689` | Live-verified chain ID. |
| `PHAROS_CONTRACT_ADDRESS` | unset | Required for all contract calls. Deploy first. |
| `PHAROS_EXPLORER` | `https://atlantic.pharosscan.xyz` | Explorer base URL for demo links. |
| `KEYSTORE_PATH` | `./keystore.json` | Web3 v3 keystore file (multi-agent). |
| `KEYSTORE_PASSWORD` | unset | Keystore decryption password. Required for write ops. |
| `KARMA_DEFAULT_AGENT_TENANT` | unset (→ `MCP_TENANT_ID`) | Tenant a keystore agent binds to when its entry omits `tenant` (STRIDE-S, fail-closed). Set to the live tenant id in api-key/gateway deployments. |
| `KARMA_SOCIAL_GRAPH_MAX_JOBS` | `500` | Cap on job edges `query_social_graph` `format:"full"` hydrates (chunked by 100); over the cap, the most-recent edges are kept and `summary.truncated=true`. |
| `KARMA_INDEXER_FROM_BLOCK` | `0` | Block the `SkillEventIndexer` backfills from on boot. Set to the contract deploy block after a (re)deploy to skip stale history. |
| `KARMA_INDEXER_BLOCK_RANGE` | `2000` | Maximum block window per `eth_getLogs` call during indexer backfill. Prevents oversized requests on a genesis or long catch-up backfill. |
| `KARMA_DISCOVERY_RANK` | `bm25` | Set to `flow` to enable Tier-1 Flow Reputation ranking for discovery (requires bond seed). |
| `DEMO_PRICE_WEI` | `100000000000000` | Default skill price for `run_demo.ts`. |

### HTTP security

| Variable | Default | Notes |
| --- | ---: | --- |
| `ALLOWED_HOSTS` | empty | Required in HTTP mode. |
| `ALLOWED_ORIGINS` | empty | Required in HTTP mode. |
| `MCP_HTTP_BODY_LIMIT` | `100kb` | Express JSON body limit. |
| `MCP_TRUST_IDENTITY_HEADERS` | `false` | Trust upstream `x-mcp-*` identity headers only behind a trusted gateway. |

### Authentication

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_AUTH_MODE` | `api_key` | `api_key`, `jwt`, `oidc_jwks`. Production HTTP rejects `api_key`. |
| `MCP_API_KEY` | unset | Required for API-key HTTP, minimum 32 chars. |
| `MCP_JWT_SECRET` | unset | Required for JWT HTTP, minimum 32 chars. |
| `MCP_JWT_ISSUER` | unset | Optional for dev JWT; required for production JWT and all OIDC. |
| `MCP_JWT_AUDIENCE` | unset | Optional for dev JWT; required for production JWT and all OIDC. |
| `MCP_JWKS_URI` | unset | Required for HTTP OIDC JWKS. Must be URL. |
| `MCP_JWKS_ALLOWLIST` | empty | Comma-separated hostname allowlist for JWKS fetches. |
| `MCP_JWT_MAX_AGE_SECONDS` | `3600` | Maximum accepted token age. |
| `MCP_RESOURCE_URI` | unset | Required for production JWT/OIDC HTTP. |
| `MCP_AUTHORIZATION_SERVERS` | empty | Comma-separated authorization servers. |

### Storage and encryption

| Variable | Default | Notes |
| --- | ---: | --- |
| `STORAGE_DRIVER` | `fs` | `fs`, `redis`, or `memory`. Production requires `redis`. |
| `REDIS_URL` | unset | Required when `STORAGE_DRIVER=redis`. |
| `MCP_ENCRYPTION_KEY` | unset | Enables encryption. Required with Redis. |
| `MCP_ALLOW_LEGACY_SHA256_KDF` | `false` | One-time migration waiver. |
| `MCP_REQUIRE_CRYPTO_ERASURE` | `false` | Production fail-closed flag; requires real KMS provider. |

### KMS and crypto-erasure

| Variable | Default | Notes |
| --- | ---: | --- |
| `KMS_PROVIDER` | unset | `vault`, `aws-kms`, `gcp-kms`, or `local`. `local` rejected in production. |
| `VAULT_ADDR` | unset | Required when `KMS_PROVIDER=vault`. |
| `VAULT_TOKEN` | unset | Required when `KMS_PROVIDER=vault`. |
| `AWS_KMS_REGION` | unset | Required when `KMS_PROVIDER=aws-kms`. |
| `GCP_KMS_PROJECT` | unset | Required when `KMS_PROVIDER=gcp-kms`. |
| `GCP_KMS_KEYRING` | unset | Required when `KMS_PROVIDER=gcp-kms`. |

### Telemetry

| Variable | Default | Notes |
| --- | ---: | --- |
| `TELEMETRY_DRIVER` | `stderr` (stdio), `file` (HTTP) | `file`, `stdout`, `stderr`. `stdout` forbidden with stdio. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Enables OTLP export when configured. |

### Abuse controls

| Variable | Default | Notes |
| --- | ---: | --- |
| `ENABLE_RATE_LIMIT` | `false` | Production HTTP requires `true` unless waived. |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Requests per window. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window duration in ms. |
| `ENABLE_QUOTA` | `false` | Production HTTP requires `true` unless waived. |
| `QUOTA_DAILY_LIMIT` | `1000` | Daily tenant quota. |
| `MCP_ALLOW_UNLIMITED_HTTP` | `false` | Explicit production waiver for disabling rate/quota startup requirement. |

### Idempotency and locks

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_LOCK_TTL_MS` | `420000` | Tenant lock TTL. |
| `MCP_LOCK_ACQUIRE_DEADLINE_MS` | `420000` | Max wait to acquire tenant lock. |
| `MCP_IDEMPOTENCY_SECRET` | unset | Min-32-char HMAC secret. **Required when `STORAGE_DRIVER=redis`.** |

### Plugin loading and runner

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_PLUGIN_ALLOWLIST` | `system.tool.js,system.tool.ts` | Comma-separated plugin filenames. Add `karma.tool.ts` for the app layer. |
| `MCP_PLUGIN_ISOLATION_MODE` | `external` | `external` or `policy`. Use `policy` when `karma.tool.ts` is enabled. |
| `MCP_PLUGIN_SHA256_ALLOWLIST` | empty | `filename:sha256` hash pins. Required in production for non-built-in plugins. |
| `MCP_PLUGIN_AUTO_DISCOVERY` | `false` | Auto-load matching plugin files (requires unsafe waiver). |
| `MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX` | `false` | Production waiver for non-built-in plugins before real sandbox exists. |
| `MCP_EXTERNAL_PLUGIN_TIMEOUT_MS` | `30000` | Child runner timeout. |
| `MCP_EXTERNAL_PLUGIN_NETWORK_POLICY` | `deny` | `deny` or `allow`. |
| `MCP_EXTERNAL_PLUGIN_FS_POLICY` | `read-only` | `read-only` or `allow`. |
| `MCP_EXTERNAL_PLUGIN_NODE_PERMISSION` | `false` | Optional Node Permission Model hardening. |

### Secrets and output firewall

| Variable | Default | Notes |
| --- | ---: | --- |
| `MCP_SECRET_ALLOWLIST` | empty | Secret names available through the credential vault. |
| `MCP_OUTPUT_FIREWALL_PII_MODE` | `credentials_only` | `credentials_only` or `strict`. |

---

## Testing and quality gates

Current package scripts:

```json
{
  "dev": "tsx watch src/index.ts",
  "build": "tsc -p tsconfig.json",
  "start": "node dist/index.js",
  "test": "vitest run src",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "lint": "eslint src",
  "lint:fix": "eslint src --fix",
  "lint:strict": "eslint src --max-warnings 0",
  "ci": "pnpm typecheck && pnpm lint && pnpm test",
  "audit": "pnpm audit --audit-level=high",
  "deps:check": "pnpm outdated",
  "migrate:encryption": "tsx src/scripts/migrate_encryption.ts",
  "check:connectivity": "tsx src/scripts/check_connectivity.ts",
  "setup:keystore": "tsx src/scripts/setup_keystore.ts",
  "demo": "tsx src/scripts/run_demo.ts",
  "demo:discover": "tsx src/scripts/discover_demo.ts",
  "demo:verify": "tsx src/scripts/verify_demo.ts",
  "test:contract": "forge test",
  "test:enterprise": "vitest run src/__tests__/task_runtime.test.ts ... (see package.json)"
}
```

Recommended pre-merge validation:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build
pnpm test:enterprise
pnpm test:plugin:lifecycle
pnpm test:plugin:permission
pnpm test:contract
pnpm audit --audit-level=high
```

### Enterprise coverage areas (Layer 0)

- Native Tasks state machine and nonce-bound input.
- JWT/OIDC authentication with real JWTs.
- Request context sanitization and trusted identity header behavior.
- HTTP host/CORS/content-type/protocol-header checks.
- OAuth protected resource metadata.
- Rate limit/quota production gates.
- Idempotency and execution locks.
- Output firewall and strict PII mode.
- Storage encryption negative cases.
- Vault/secret access policy.
- Plugin policy and best-effort isolation behavior.
- Pattern debt registry consistency.

### KARMA app-layer test suites

| Test file | Coverage |
| --- | --- |
| `karma_builtin_plugin.test.ts` | Plugin loads as trusted built-in; `assertInProcess` canary. |
| `karma_contract.test.ts` | ABI structural drift guard vs Foundry artifact. |
| `karma_exactly_once.test.ts` | `deriveTaskHash` exactly-once dedup logic (now O(1) `jobByTaskHash` on-chain). |
| `karma_service_integration.test.ts` | realKarmaService ↔ anvil end-to-end: register→read→create→dedup→deliver→confirm→withdraw + dispute + bond, covering v3 decode paths (skips without anvil). Closes PD-002. |
| `migrate_to_v2.test.ts` | Pure `planMigration` v1→v2 filter/sort/threshold-default. |
| `execution_pipeline_error_redaction.test.ts` | `toClientError` redaction (incl. private-key hex) + `isTenantMismatchError` (PD-006). |
| `karma_indexer.test.ts` | `SkillEventIndexer` backfill, reconnect, heartbeat state machine. |
| `skill_indexer_runtime.test.ts` | Chain-event → BM25 reconciliation (`applyIndexedEvent`) and indexer-health surfacing. |
| `karma_plugin_health.test.ts` | `karma_health` tool: env detection, in-process flag. |
| `karma_tools.test.ts` | All 13 economy tools over a fake `KarmaService`; tenant threading + on-chain Trust Gate + fan-out cap. |
| `karma_write_helper.test.ts` | `runBoundedWrite` confirmed/pending/revert paths. |
| `bm25_index.test.ts` | `BM25SkillIndex`: upsert, discard, search, reputation boost, price filter, sanitize. |
| `keystore.test.ts` | Web3 v3 decrypt/encrypt round-trip; MAC mismatch; wrong KDF/cipher. |
| `serialize.test.ts` | `jsonSafe` BigInt, nested, array paths. |
| `schema_guard.test.ts` | JSON Schema 2020-12 input/output validation. |

Additional suites (run via `pnpm test` or individually):

- `encryption_kms.test.ts` — V4 KMS envelope paths.
- `caching_key_registry.test.ts` — DEK cache TTL, use-count, zeroed-on-eviction.
- `audit_store.test.ts` — `FileAuditStore` JSONL append.
- `local_key_registry.test.ts`, `vault_key_registry.test.ts`, `gcp_kms_key_registry.test.ts` — KMS providers.
- `holyseed_patterns.test.ts` — Sensitive-pattern detection.
- `registrar_governance.test.ts` — Plugin/tool registration governance.
- `runtime_identity.test.ts` — fail-closed trusted-runtime marker for the `karma.tool` canary.
- `double_execution_guard.test.ts` — `canReleaseIdempotency` / `isIdempotentTool` / `isTransientError` invariants; `TaskTracker` thunk-accept and drain-gate TOCTOU (Fix 1-4 / ADR-006).
- `demo_format.test.ts` — zero-dep demo presentation helpers (`paint` / `short` / `reveal`).
- `sanitize.test.ts`, `otel.test.ts`, `file_logger.test.ts`, `tool_metadata.test.ts` — Supporting subsystems.

---

## Pattern debt and limitations

KARMA keeps residual security/design debt visible instead of hiding it.

Runtime report tool: `karma_pattern_debt` (reads from `src/core/pattern_debt.ts` at runtime).

Debt registries:
- `src/core/pattern_debt.ts` — Layer 0 runtime items DEBT-001 to DEBT-007, queried live by `karma_pattern_debt`.
- `docs/superpowers/pattern-debt.md` — KARMA app-layer items PD-001 to PD-008, tracked separately.

### Layer 0 debt (DEBT-001 to DEBT-007)

Authoritative source: `src/core/pattern_debt.ts`. The table below reflects the **codebase state** as of 2026-06-17.

| Debt | Status | Current truth |
| --- | --- | --- |
| `DEBT-001-plugin-os-isolation` | **Open, release-blocking** | Current runner is child-process best-effort only. No container, Wasmtime, or microVM boundary. Production non-built-in plugin config fails closed unless explicitly waived. |
| `DEBT-002-crypto-erasure` | **Implemented / resolved** | `smcp:v4:kms` envelope and four KMS providers (`Local`, `Vault`, `AWS KMS`, `GCP KMS`) shipped 2026-06-14; `src/core/pattern_debt.ts` reconciled to `implemented`. `MCP_REQUIRE_CRYPTO_ERASURE=true` requires a real KMS provider. Residual: AWS KMS 7-day pending-deletion window. |
| `DEBT-003-native-mcp-tasks` | **Monitoring** | Custom Tasks adapter remains isolated until the TypeScript SDK exposes stable public Tasks APIs. |
| `DEBT-004-oauth-resource-indicator` | **Implemented** | JWT/OIDC resource indicator enforced when configured; production requires resource URI. |
| `DEBT-005-output-firewall-coverage` | **Partially resolved** | Structured redaction implemented with deterministic patterns and limits. No DLP/classifier backend. |
| `DEBT-006-redis-trauma-registry` | **Implemented** | Redis/memory rate limiters use bounded violation records with severity EMA/backoff. |
| `DEBT-007-agent-key-erasure-boundary` | **Monitoring** | KARMA agent signing keys (Web3 v3 keystore) are operator-provisioned infrastructure credentials — deliberately outside the `smcp:v4:kms` per-tenant crypto-erasure boundary. `KeystoreManager.unload(agentId)/clear()` drop decrypted viem accounts for agent offboarding / graceful shutdown; `assertOwnedBy` enforces tenant→agent authz before any signing account is handed out. True key-zeroization / tenant self-service offboarding requires an out-of-process signer or HSM (out of scope). |

### KARMA app-layer debt (PD-001 to PD-008)

Documented in `docs/superpowers/pattern-debt.md`.

| Debt | Status | Current truth |
| --- | --- | --- |
| `PD-001` — pre-existing Layer-0 test failures | **Resolved** (2026-06-16, commit `db7ea72`) | 8 stale tests aligned to post-hardening code; 1 env-locked test skip-guarded. |
| `PD-002` — network glue has live-only coverage | **Resolved** (2026-06-17) | `karma_service_integration.test.ts` exercises realKarmaService against a real EVM (anvil) end-to-end — register→read→create→O(1) dedup→deliver→confirm→withdraw + dispute + bond — covering the readContract/writeContractBounded decode paths. Skips cleanly without anvil/artifact. |
| `PD-003` — exactly-once guard is O(n) scan | **Resolved** (2026-06-17, v3 live) | Replaced by the on-chain `jobByTaskHash` mapping; `findExistingJob` is now an O(1) read. Live on v3 `0xc6d5c146…b905ae`. |
| `PD-004` — skill indexer has no persisted checkpoint | **Open** | `SkillEventIndexer` backfills from `KARMA_INDEXER_FROM_BLOCK` (or 0) on every boot — no persisted `lastIndexedBlock`. Low-payoff on a fresh testnet; revisit at scale / multi-instance. |
| `PD-005` — Trust Gate was app-layer advisory | **Resolved** (2026-06-17, v3 live) | On-chain `agentReputation` + `Skill.minReputationToInvoke` + `createJob` require — consensus-enforced. Residual: wash-trade resistance needs stake/identity (out of scope). |
| `PD-006` — no tenant-mismatch alarm signal | **Resolved** (2026-06-17) | The pipeline classifies `isTenantMismatchError` and emits a distinct `tenant_agent_mismatch` telemetry event for security monitoring. |
| `PD-007` — Reputation farmable by wallet ring | **Open** | Tier-0 (1-wallet) fixed on-chain. Tier-1 (flow rep) and Tier-2 (bond) shipped in source but deferred to next redeploy + flag activation. |
| `PD-008` — No quality-slashing of Sybil bonds | **Open** | Sybil bonds are capital lock-ups but not quality-slashed on dispute (deferred by design). |

Non-goals intentionally preserved:

- No fake DLP backend.
- No TokenManager or server-side PKCE.
- No `karma.tool.ts` in the external child-process runner (in-process only by design).
- No claim that child process or Node Permission Model equals OS/container sandboxing.
- `RECEIPT_TIMEOUT_MS` is a bounded wait for a broadcast tx; timed-out transactions are on the wire and must not be resent.

---

## Troubleshooting

### `pnpm lint` fails

Check ESLint output for style or formatting errors in `src`.

### Production HTTP exits with `MCP_AUTH_MODE=api_key is for local/dev only`

Production HTTP rejects API key mode. Use `MCP_AUTH_MODE=jwt` or `MCP_AUTH_MODE=oidc_jwks`.

### `[KARMA] PHAROS_CONTRACT_ADDRESS not set`

Deploy `AgentSkillRegistry` first and record the address in `.env`:

```env
PHAROS_CONTRACT_ADDRESS=0x<deployed-address>
```

### `[KARMA] karma.tool.ts must run in-process`

`assertInProcess()` threw because the tool was invoked in the external child-process runner. Set:

```env
MCP_PLUGIN_ISOLATION_MODE=policy
```

### `[KARMA] Agent not found in keystore: agent-alpha`

The keystore was not loaded, or the agent ID does not exist in the keystore file. Ensure:

- `KEYSTORE_PATH` points to a valid keystore file.
- `KEYSTORE_PASSWORD` is correct.
- The agent ID was generated with `pnpm setup:keystore`.

### `[KARMA] Keystore MAC mismatch`

Wrong `KEYSTORE_PASSWORD` or corrupt keystore file.

### `[KARMA] agent '<id>' is not accessible to this tenant`

STRIDE-S tenant→agent isolation: the calling `tenantId` does not own that keystore agent. Either the
agent's `tenant` field (or the `KARMA_DEFAULT_AGENT_TENANT` fallback) doesn't match the request tenant.
In api-key/gateway HTTP the request tenant is **not** `MCP_TENANT_ID` — set `KARMA_DEFAULT_AGENT_TENANT`
to the live tenant id, or give each keystore agent an explicit `tenant`. A `tenant_agent_mismatch`
telemetry event is emitted for monitoring.

### `karma_health` returns `rpcEnv=false` or `contractEnv=false`

Set `PHAROS_RPC_URL` and `PHAROS_CONTRACT_ADDRESS` in the environment.

### `create_job` returns `status: "exists"`

This is correct idempotent behavior. The same `(requester, skillId, idempotencyNonce)` triple was already used. Use a new nonce for a new job.

### `create_job` or `register_skill` returns `status: "pending"`

The transaction was broadcast but the receipt did not arrive before `RECEIPT_TIMEOUT_MS=300_000`. The transaction is on the wire — **do not resend**. Poll the explorer for the tx hash from the response, or retry with the same `idempotencyNonce` (which will detect the existing job via the on-chain `jobByTaskHash` mapping once confirmed).

### `discover_skills` returns 0 results after restart

The in-process BM25 index is rebuilt from `SkillEventIndexer` on startup. Wait for the indexer to finish backfilling — call `karma_health` and watch the `indexer` field (`watching: true` with a non-zero `lastIndexedBlock` means it has caught up). If `indexer` reports `{ started: false }`, the indexer never started — ensure `PHAROS_CONTRACT_ADDRESS` is set, `MCP_SAFE_MODE` is off, and the contract is accessible.

### `MCP_SAFE_MODE=true` blocks `karma_health` and all economy tools

All KARMA tools declare the `network` capability, which safe mode blocks. Set:

```env
MCP_SAFE_MODE=false
```

### Deployer has 0 balance

Fund `agent-alpha` from a Pharos Atlantic faucet before deploying:

- [Stakely](https://stakely.io/faucet/pharos-atlantic-testnet-phrs)
- [gas.zip](https://www.gas.zip/faucet/pharos)
- [Chainlink](https://faucets.chain.link/pharos-atlantic-testnet)

### `forge test` fails with missing dependencies

Run `forge install` to install OpenZeppelin contracts, then rebuild:

```bash
forge install
forge build
```

### Production HTTP exits because rate limit or quota is missing

Set `ENABLE_RATE_LIMIT=true` and `ENABLE_QUOTA=true`, or explicitly set `MCP_ALLOW_UNLIMITED_HTTP=true` as a documented waiver.

### HTTP returns `403 Invalid Host`

Set `ALLOWED_HOSTS` to include the exact Host header, including port:

```env
ALLOWED_HOSTS=127.0.0.1:3333,localhost:3333
```

### JWT/OIDC request returns `401 Unauthorized`

Check issuer, audience, resource URI, tenant claim, scopes, and token age (`MCP_JWT_MAX_AGE_SECONDS`, default 3600).

### `tasks/update` returns `Task is not waiting for input`

The task is not currently `input_required`. Poll `tasks/get` first.

### Redis Lua operations fail or behave incorrectly

Upgrade Redis to **8.2.2 or later**. CVE-2025-49844 (Lua GC Use-After-Free, CVSS 10.0) affects Redis ≤ 8.2.1.

### `MCP_REQUIRE_CRYPTO_ERASURE=true` causes fatal startup

In production, this requires `KMS_PROVIDER=vault`, `aws-kms`, or `gcp-kms`. `local` is rejected.

---

## License

See `LICENSE` in the repository.

---

## Maintainer notes

Recommended next work:

- Implement a true container/Wasmtime/microVM plugin runner before supporting untrusted third-party plugins in production (`DEBT-001`, release-blocking).
- Add `AwsKmsKeyRegistry` unit tests — requires a live AWS KMS endpoint or a LocalStack mock.
- Run `pnpm migrate:encryption` once per tenant after enabling `KMS_PROVIDER` to re-encrypt all pre-V4 blobs before offering a formal erasure SLA.
- Keep monitoring MCP TypeScript SDK public Tasks support before replacing the local adapter (`DEBT-003`, monitoring).
- The `SkillEventIndexer` defaults to `fromBlock=0` on restart (full backfill); set `KARMA_INDEXER_FROM_BLOCK` to skip ahead. Add a *persisted* `lastIndexedBlock` checkpoint to reduce startup time automatically as the chain grows.
- ✅ Done — `SkillEventIndexer.health()` is now wired into `karma_health` via `startKarmaIndexer` (`src/lib/skill_indexer_runtime.ts`); operators observe `lastIndexedBlock` / `lastEventAt` / `watching` without inspecting logs. The event-reconciliation logic (`applyIndexedEvent`) and the viem glue (`mapLog`/`buildViemIndexerDeps`) are unit-tested (`skill_indexer_runtime.test.ts`, `karma_indexer.test.ts`); only the trivial `startSkillIndexer` singleton resolution remains demo-only (`PD-002`, reduced).
