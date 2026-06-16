# ADR: KARMA Skill-Economy Application Layer (Layers 1–3)

## 1. Title
Build the KARMA in-process plugin, escrow client, BM25 discovery, and 7 economy tools on top of
SUPER-MCP Layer 0, deployed and demoed live on Pharos Atlantic.

## 2. Context
SUPER-MCP shipped only Layer-0 infrastructure. KARMA needs an on-chain skill marketplace where
agents register skills, escrow jobs, deliver results, and settle payment — without breaking
Layer-0 invariants (output firewall, BigInt-safety, plugin trust boundary). Hard constraints:
the plugin must run **in-process** (D-1: singletons + env die in the external worker); every
uint256 must cross the tool boundary as a string (D-6: a bare BigInt crashes MCP JSON); private
keys must never leave `KeystoreManager`; the escrow contract must be reentrancy/refund-safe; and
`createJob` has **no on-chain idempotency key**, so a lost-ack retry could double-escrow
(Failure-Mode-1). Multicall3 is unverified on Pharos.

## 3. Decision
Implemented P4–P7 of `plans/2026-06-15-karma-app-layer.md`:
- **`contract.ts`** — `defineChain(pharosAtlantic, 688689)` + Batch-JSON-RPC viem clients
  (multicall OFF); `runBoundedWrite` (simulate→write-once→bounded receipt wait, returns typed
  `pending` on `WaitForTransactionReceiptTimeoutError`, RECEIPT_TIMEOUT 300s < MCP_LOCK_TTL 420s,
  never resends); exactly-once guard (`deriveTaskHash = keccak256(encodePacked(requester,skillId,
  nonce))` + `findJobByTaskHash` check-before-write, **no contract change**); `SkillEventIndexer`
  (backfill → watch → reconnect-on-error → heartbeat).
- **`bm25_index.ts`** — MiniSearch incremental upsert/discard; `boostDocument` blends reputation
  (0..100 → 1.0x..2.0x); BigInt-safe price filter; `sanitizeText` strips control/zero-width/bidi
  code points (Abductive-2); `price_per_call_wei` is a string throughout.
- **`serialize.ts`** `jsonSafe` recursively stringifies every BigInt (D-6).
- **`karma_service.ts`** — `KarmaService` DI seam (network/keystore/index boundary) + real wiring.
- **`karma.tool.ts`** — `createKarmaTools(svc)` factory builds 7 tools (register_skill,
  discover_skills, create_job, deliver_result, complete_job, get_agent_reputation,
  query_social_graph); all `capabilities:["network"]`, no `requiredScopes` (D-2); create_job is
  idempotent (taskSupport optional). Default export wires `realKarmaService`.
- **Deploy/demo** via viem signing with the in-process keystore account (key never leaves
  `KeystoreManager`).

## 4. Status
ACCEPTED

## 5. Consequences
**Improved:** KARMA is end-to-end functional and live; tools are unit-testable via the
`KarmaService` fake; ABI drift is guarded against the compiled artifact; D-6/D-7/D-2/Abductive-1/2
mitigations are encoded and tested.
**Worsened / debt:** the network glue (`writeContractBounded`, `realKarmaService` reads,
`startSkillIndexer`) is not unit-tested (only the policy cores are) — see PATTERN-DEBT. The
exactly-once guard is an O(n) scan of `getRequesterJobs` (no on-chain key mapping). The BM25 index
is in-process and only populated by tool upserts or a running indexer/rebuild — a fresh process
sees an empty index until reconciled.

## 6. Alternatives Considered
- **Foundry `Deploy.s.sol` with `PRIVATE_KEY` env** — rejected: would export a raw key, violating
  the keystore constraint. Used viem keystore-signed deploy instead (one signing path with the
  runtime/demo).
- **On-chain `mapping(bytes32=>uint256) jobByKey` for idempotency** — rejected for this cycle: a
  contract change + redeploy; the off-chain taskHash scan reuses existing surface and needs no
  redeploy. Revisit at scale (see Next Cycle Trigger).
- **vi.mock of contract/keystore modules** — rejected in favor of constructor DI (`createKarmaTools`)
  which is cleaner and avoids ESM-mock fragility.

## 7. Evidence
- 36 new KARMA unit tests pass; full vitest 306 pass / 10 fail (all pre-existing PD-001
  env-sensitive Layer-0 reds — env_validation/oidc_auth/plugin_external_runner/protocol_header/
  server_card — none in changed files; failure count unchanged from session start). [verified 2026-06-16]
- `forge test` 7/7 pass incl. reentrancy + refund boundaries + happy-path reputation. [verified 2026-06-16]
- Live on Pharos Atlantic: contract `0x75ff9822f9da947881247cecba74dccdea753f57`; 5-tx demo
  (register→createJob(escrow)→deliver→complete→withdraw) all `success`; read-back: skill #1
  reputation 50→55, totalInvocations 1, social-graph edges correct, all uint256 stringified.
  See DEMO.md. [verified 2026-06-16]

## 8. Owner
**KARMA team — gokuderafight@gmail.com**

## 8b. Known Debts (PATTERN-DEBT)
  - PD-002: OPEN — KARMA network glue (writeContractBounded/realKarmaService/startSkillIndexer) has live-only coverage
  - PD-003: OPEN — exactly-once guard is an O(n) getRequesterJobs scan per create_job
  - PD-001: OPEN (pre-existing, out of scope) — inherited Layer-0 env-sensitive test reds

## 9. Next Cycle Trigger
When the deployed contract's `jobCount()` exceeds **1000** (exactly-once scan + cold-start
rebuild become O(n) hot paths) OR a second server instance is deployed (in-process BM25 index is
no longer authoritative) OR any instance's indexer `lastEventAt` heartbeat goes stale > **10
minutes** while blocks advance.

## 10. Cycle Retrospective
- **Assumption wrong:** `createJob` has no on-chain idempotency key and `taskHash` is not indexed
  by a mapping — exactly-once is a client-side O(n) scan of `getRequesterJobs`, fine for demo
  scale, slow at thousands of jobs. A contract v2 `jobByKey` mapping is the real fix.
- **Surprise (tooling):** eslint `no-unnecessary-type-assertion` and `tsc` disagree on viem's
  generic `readContract` — `as never` is required by the compiler but flagged by the linter;
  needs a scoped disable. Same friction on `simulateContract`/`writeContract`.
- **Surprise (tests):** literal invisible Unicode in test source silently corrupts regex
  char-classes (a `[space-]` range matched all ASCII). Build dangerous chars from
  `String.fromCharCode` / code-point predicates, never literal glyphs.
- **Design differently:** the BM25 index is in-process only; a fresh process sees it empty until
  `startSkillIndexer`/`rebuildFromChain` runs. Wire the indexer into server bootstrap so discovery
  works on a cold start, not just after a same-process register.
- **Debt knowingly created:** network glue is verified live (P7) but has no CI integration test —
  watch for ABI/return-shape drift that unit tests + the drift-guard won't catch.
