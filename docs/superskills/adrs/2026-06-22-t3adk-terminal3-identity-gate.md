# ADR: Terminal3 Identity Gate Plugin for KARMA (T3ADK Dev Challenge)

## 1. Title
Add `t3.tool.ts` trusted built-in plugin integrating Terminal3 Agent Auth SDK as dual-layer identity + reputation gate for enterprise skills.

## 2. Context
KARMA's Trust Gate (v2, on-chain) blocks job creation by *reputation score* — but reputation is anonymous. A high-score agent could be a Sybil or an untrusted third party; the protocol has no way to know. The T3ADK Dev Challenge (Launch Ed, deadline 2026-06-22) required integrating Terminal3's Agent Auth SDK in a way that demonstrates real integration depth (40% of judging weight) and creative problem-solving (30%). The combination exposed a real architectural gap: reputation alone is insufficient for enterprise/gov use-cases (payroll, procurement) where identity verification is a compliance requirement.

Three technical risks were pre-verified before any code was written:
- **Risk #1 (signer model):** `KeystoreManager.getAccount()` exposes a viem `Account` but NOT the raw private key (by design, line 96 of `keystore.ts`). Verified that T3N's `GuestToHostHandler` interface accepts any `(requestData) => Promise<Uint8Array>` implementation, enabling a custom EIP-191 signer via `account.signMessage` without key exposure.
- **Risk #2 (WASM Node 20 ESM):** `@bytecodealliance/jco` + `preview2-shim` is Node.js-native; confirmed with standalone probe script producing `PASS` output.
- **Risk #3 (karma.tool.ts invariants):** Zero edits to `karma.tool.ts` (idempotency, exactly-once escrow, tenant isolation all intact).

## 3. Decision
Added `src/plugins/t3.tool.ts` as a new trusted built-in plugin (registered in `isTrustedBuiltInPlugin` in `plugin_loader.ts`) with three MCP tools:

- **`t3_health`** — validates WASM component load and node URL config. Lazy-loads a module-level `WasmComponent` singleton.
- **`t3_verify_identity`** — authenticates a KARMA agent against T3N testnet using a custom `GuestToHostHandler` that delegates EIP-191 signing to the viem Account already held by `KeystoreManager`, without exposing the raw private key. Stores the returned `Did` in a module-level cache keyed by `agentId`.
- **`t3_create_verified_job`** — enforces two sequential gates before any on-chain write: (1) T3N identity gate (DID must be in cache), (2) KARMA reputation gate (index-derived `getReputation` vs `getSkillThreshold`). Only if both pass does it call `realKarmaService.createJob`.

Added `register_payroll_skill.ts` script to register the flagship `payroll_hr_transfer` skill on-chain with `minReputationToInvoke: 55n`.

`T3N_NODE_URL` optional env var added to `EnvSchema` (defaults to SDK's built-in `getNodeUrl()`).

## 4. Status
ACCEPTED

## 5. Consequences
**Improved:**
- KARMA can now gate enterprise-sensitive skills behind verifiable identity — closes the real architectural gap in the Trust Gate design.
- T3N SDK integrated across 6 distinct surfaces (WASM, T3nClient, EthAuthInput, authenticate, custom GuestToHostHandler, getNodeUrl) — satisfies "integration in its entirety" rubric requirement.
- Custom EthSign handler via `account.signMessage` keeps the raw private key unexposed, consistent with `KeystoreManager`'s existing security invariant.

**Unchanged (by design):**
- All 13 existing `karma.tool.ts` tools unmodified.
- All 58 test files, 439 passing tests — no regressions.

**New debt:**
- Module-level `verifiedDids` Map is process-scoped only — a process restart clears all DID verifications. Agents must re-verify after restart. Acceptable for demo; production would need persistent session storage (PATTERN-DEBT below).
- `t3_create_verified_job` uses `realKarmaService.getReputation` (index-derived, 0 RPC) for the reputation check — same as KARMA's Trust Gate. Index may be stale during indexer catchup window (existing KARMA limitation, not new).

## 6. Alternatives Considered

**A. Use `metamask_sign(address, undefined, privateKey)` with raw key extraction:**
Rejected. `KeystoreManager.getAccount()` intentionally never exposes the raw private key (comment at line 96: "raw private key never leaves this class"). Extracting it would require patching `keystore.ts` to add a `getRawKey()` method — violating an explicit security invariant. Custom `GuestToHostHandler` via `account.signMessage` achieves the same auth result without the invariant violation.

**B. Implement `t3_protected_action` (executeBusinessContract) for Giai đoạn 2:**
Rejected. `executeBusinessContract` requires a compiled WASM binary for the business contract — a Rust/AssemblyScript → WASM compilation workflow that is 1–2 days of work minimum. With a same-day deadline, the risk of a broken demo (showing a failed WASM publish on video) outweighs the scoring benefit. Identity gate alone satisfies the "integration depth" criterion.

**C. Modify `karma.tool.ts` `create_job` handler to check T3N DID:**
Rejected. `karma.tool.ts` has 4 bug fixes as recently as 2026-06-17 (ADR-006) and houses idempotency, exactly-once escrow, and tenant isolation invariants. Surgical changes under time pressure are the highest-probability path to breaking a working demo. `t3_create_verified_job` as a separate tool achieves the same narrative without touching the stable file.

## 7. Evidence

**WASM probe** `[verified 2026-06-22]`:
```
[T3N Probe] Loading WASM component...
[T3N Probe] WASM OK: object
[T3N Probe] PASS — Risk #2 closed.
```

**Plugin loader** `[verified 2026-06-22]`:
```
[KARMA] Plugin loaded 'karma.tool.ts' (13/13 tools accepted)
[KARMA] Plugin loaded 'system.tool.ts' (2/2 tools accepted)
[KARMA] Plugin loaded 't3.tool.ts' (3/3 tools accepted)
T3 tools loaded: [ 't3_health', 't3_verify_identity', 't3_create_verified_job' ]
Total tools: 18
```

**Identity gate** `[verified 2026-06-22]`:
```
Gate fires correctly: [T3N] Identity gate: agent 'agent-alpha' has no verified DID. Call t3_verify_identity first.
Message mentions t3_verify_identity: YES ✓
```

**Test suite** `[verified 2026-06-22]`:
```
Test Files  58 passed (58)
Tests  439 passed | 1 skipped (440)
```

**Live T3N authenticate → DID** `[assumed — verify during demo recording]`:
Full live auth flow (requires KEYSTORE_PASSWORD + T3N testnet reachability) not run in this session. WASM loads, gate fires, mock tests pass. Live auth assumed correct given WASM + SDK auth flow verified in probe + typings research.

## 8. Owner
bao.nt.1992@gmail.com (KARMA / T3ADK submission)

## 8b. Known Debts (PATTERN-DEBT)

**PATTERN-DEBT-T3N-001: t3 DID cache is process-scoped (volatile)**
- Status: OPEN
- Description: `verifiedDids` Map lives in module memory. Process restart clears all verifications; agents must re-call `t3_verify_identity` after any restart.
- Impact: Demo-safe (single process session). Production deployments with restarts/load-balancing require persistent DID session store.
- Resolution trigger: When KARMA moves to multi-process/multi-replica deployment OR when `t3_verify_identity` call latency becomes a user complaint.
- Review interval: 3 months or at first multi-replica deployment, whichever comes first.

## 9. Next Cycle Trigger
When `t3_verify_identity` is called more than 5 times per hour by the same `agent_id` (indicating repeated re-authentication due to process restarts) OR when KARMA is deployed with more than 1 replica.

## 10. Cycle Retrospective

- **`Did` is a branded string type, not `string`.** Storing in `Map<string, string>` causes a TypeScript error. Had to import `Did` and type the map as `Map<string, Did>`. Any future code storing T3N authenticate() results should use the `Did` type from the SDK.
- **`vi.fn().mockImplementation(arrowFn)` cannot be used as a constructor.** Vitest mocks for classes must use regular functions (`vi.fn(function() {...})`) not arrow functions — arrow functions cannot be `new`'d. Bit us immediately in the T3nClient mock.
- **`KeystoreManager` raw key is truly unexposed.** The comment at line 96 is not aspirational — there is literally no method to get the raw private key. Design custom signers around `account.signMessage` from day one, not as a fallback.
- **`executeBusinessContract` requires a compiled WASM binary**, not just API calls. Marketing descriptions of "protected compute" undersell the prerequisite. Any future Phase 2 work building on T3N tenant contracts needs a WIT→WASM compilation pipeline set up before promising demo timelines.
- **The `plugin_loader.ts` trusted-built-in check is the right integration point.** Adding a new in-process plugin requires exactly one change: add `fileName === "t3.tool.ts"` to `isTrustedBuiltInPlugin`. No other infrastructure changes needed.
