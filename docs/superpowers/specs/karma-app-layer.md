---
title: KARMA Skill-Economy Application Layer
status: SPEC_APPROVED
SPEC_APPROVED: true
SPEC_ESCALATION: false
date: 2026-06-15
source_of_truth: docs/KARMA-spec-v3.1.md
branch: feat/karma-app-layer
---

# Spec — KARMA Skill-Economy Application Layer (Layer 1–3)

> Full design detail: [docs/KARMA-spec-v3.1.md](../../KARMA-spec-v3.1.md). This file is the
> super-skills control surface (gates, scope, acceptance) distilled from v3.1.

## Problem

The repo today is ONLY SUPER-MCP Layer 0 (a hardened MCP-server framework). The KARMA
"Skill Economy" application — agents register paid MCP skills on-chain, escrow PHRS for
delegated jobs, and build a reputation graph — is unimplemented. We must build Layer 1–3
**without breaking Layer 0 invariants**, which constrain the design hard.

## Approved Design Decisions (from v3.1 Δ)

- **D-1 (🔴):** KARMA plugin is a **trusted built-in / in-process** plugin. Patch
  `isTrustedBuiltInPlugin()` to accept `karma.tool.ts`; `MCP_PLUGIN_ISOLATION_MODE=policy`.
  Rationale: external mode forks per-call (kills `keystoreManager`/`skillIndex` singletons)
  and `workerEnv()` does not pass `PHAROS_*`/`KEYSTORE_*`.
- **D-2 (🔴):** Tools declare **no `requiredScopes`** (api_key grants only `mcp:invoke`).
- **D-3 (🔴):** `MCP_SAFE_MODE=false` (every RPC tool declares `network`, blocked by safe mode).
- **D-4 (🔴):** Verify `chainId` + gas mode **live** before any deploy/write (688688 vs 688689).
- **D-5 (🔴):** `KeystoreManager.load()` implements **Web3 Secret Storage v3** (node:crypto
  scrypt + aes-128-ctr + keccak MAC). Private keys never leave the class.
- **D-6 (🟠):** Tool results **stringify all BigInt**; no bare wei in `content.text`.
- **D-7 (🟠):** `create_job` is **exactly-once on-chain** (pin/verify EVM tx nonce or check-before-write).
- **D-8 (🟠):** Contract: `ReentrancyGuard` + pull-payment + `claimRefund` after deadline.
- **D-9/10/11 (⚡):** viem Batch JSON-RPC transport; BM25 incremental via events; reputation-aware ranking.

## Scope (in)

1. Layer-0 enablement: patch `isTrustedBuiltInPlugin()`, env, `karma.tool.ts` skeleton (in-process proof).
2. `contracts/AgentSkillRegistry.sol` (hardened) + Foundry tests.
3. `src/lib/{keystore,contract,bm25_index,types}.ts`.
4. 7 tools: register_skill, discover_skills, create_job, deliver_result, complete_job,
   get_agent_reputation, query_social_graph.
5. `scripts/{setup_keystore,run_demo}.ts`; deps (viem, minisearch, @openzeppelin/contracts).

## Scope (out / deferred)

- KMS-backed signer / vault key storage (production upgrade).
- `batch:{multicall:true}` (until Multicall3 verified on Pharos Atlantic).
- JWT/OIDC scope enforcement (until non-api_key auth wired).

## Acceptance Criteria

- AC1: `karma.tool.ts` loads in-process (singletons persist across calls; reads `process.env.PHAROS_*`).
- AC2: `typecheck` + `lint` + existing Layer-0 `test:enterprise` still green (no regression).
- AC3: Contract Foundry tests pass: happy-path, refund-after-deadline, double-complete reject, reentrancy reject.
- AC4: KeystoreManager round-trips a v3 keystore (setup → load → address matches); wrong password rejected via MAC.
- AC5: A tool returning on-chain uint256 returns stringified values and survives idempotency commit.
- AC6: Live connectivity check records the real chainId + gas mode (evidence captured).

## Non-Negotiables (CONSTITUTION)

See docs/superpowers/CONSTITUTION.md — in-process plugin, stringified BigInt, in-process-only
private keys, pull-payment+ReentrancyGuard+refund, live chainId/gas verification.

## Risk Assessment (audit-design)
<!-- audit-design: DO NOT DUPLICATE — update this section, do not append a second one -->
<!-- last-run: 2026-06-15 | trigger: NORMAL -->

**Tier:** 3 (on-chain PHRS value transfer / escrow / multi-agent) | **Date:** 2026-06-15

### Failure Modes
1. **Double-escrow at MCP↔chain boundary** — pipeline RELEASES idempotency on transient
   error; a `create_job` tx that mines but whose ack is lost → retry creates a 2nd job,
   locks PHRS twice. Design enables it (in-memory idempotency vs on-chain state = two
   sources of truth). **HIGH** — mitigation in plan: YES (D-7: deterministic EVM nonce
   pin OR check-before-write by client job key).
2. **Singleton/config blindness if D-1 violated** — if `karma.tool.ts` ever loads via
   external isolation (or loader patch missing), singletons reset per call + env absent →
   silent "agent not found" / empty search. **HIGH** — mitigation in plan: YES (startup
   assertion that plugin is in-process + env present; fail-fast).
3. **Reentrancy / fund drain in escrow** — `confirmCompletion`/`withdraw` move PHRS; an
   attacker contract re-enters before state settles. **HIGH** — mitigation in plan: YES
   (D-8 pull-payment + ReentrancyGuard + CEI; Foundry reentrancy attacker test = AC3).

### Layer Signals
- **L1 Logic:** `claimRefund` boundary (`status==Open && now > deadline`) — off-by-one at
  `==deadline`; reputation math must clamp [0,100] (no under/overflow). Test both branches.
- **L2 Concurrency:** EVM tx nonce races for one agent account under parallel tool calls.
  Layer-0 per-tenant execution lock serializes calls (mitigates) BUT see Abductive-1.
- **L4 Integration:** `watchContractEvent` over WSS — **no reconnect/backfill defined**.
  If WSS drops, BM25 index silently stops updating → stale discovery. Pharos RPC 500/5min:
  define behavior on 429/timeout (retry/backoff).
- **L5 Security:** `KEYSTORE_PASSWORD` plaintext in `.env` (acceptable for hackathon, flag);
  `MCP_SAFE_MODE=false` removes capability gating for ALL tools, not just KARMA.
- **L6 Observability:** background indexer/event-watcher health is NOT covered by Layer-0
  per-call telemetry. Need a heartbeat/last-indexed-block signal to detect stalls.
- **L7 Cross-cutting (L7.11 FLAGGED):** payments tier; idempotency designed (D-7); RPC rate
  limit is a hard external budget (500/5min) — batching is load-bearing, not optional.

### Assumptions to Verify
- **ASSUMED** chainId = 688689 → v3.1 already requires live `eth_chainId` (AC6). Keep.
- **ASSUMED** EIP-1559 gas works → verify live; **DEFERRED** legacy-gas fallback branch is TBD.
- **ASSUMED** WSS stable for event watching → **NOT addressed**: add reconnect + block backfill,
  or poll `getLogs` by block range as fallback.
- **ASSUMED** keystore KDF is scrypt → `load()` handles scrypt only (not pbkdf2); `setup_keystore`
  controls format, so constrain + assert KDF id on load.
- **ASSUMED** Multicall3 on Pharos → deferred until on-chain verification.

### Abductive Hypotheses
- **Abductive 1 (component interaction):** Layer-0 tenant execution lock (`MCP_LOCK_TTL_MS=420000`)
  held across a slow `waitForTransactionReceipt` either (a) blocks ALL other tools for that
  tenant for minutes, or (b) the lock TTL expires mid-tx and a second call proceeds → the exact
  concurrency hazard the lock was meant to prevent, triggered by chain latency. Plan must bound
  receipt-wait timeout < lock TTL and/or not hold the lock across confirmation.
- **Abductive 2 (scale/adversarial):** unbounded skill registration → in-process BM25 singleton
  memory growth + cold-start `rebuildFromChain` enumerating all skills through the rate-limited
  RPC → OOM or 429 lockout. Plus: a skill `description` crafted to match output-firewall
  prompt-injection/sensitive-field patterns gets redacted, corrupting discovery results. Plan:
  cap index size / paginate cold-start over block ranges; sanitize/escape indexed text.

### Gate Result
PASS WITH FLAGS — proceed to writing-plans. The plan MUST include explicit mitigations for the
3 HIGH failure modes AND the two un-addressed flags (WSS reconnect/backfill [L4], lock×chain-latency
[Abductive-1], indexer health signal [L6]).
