# KARMA Skill-Economy Application Layer — Implementation Plan

> **For agentic workers:** Use `subagent-driven-development` or `executing-plans` to implement task-by-task.

**Goal:** Build KARMA Layer 1–3 (in-process plugin + escrow contract + keystore + viem client + BM25 + 7 tools) on top of SUPER-MCP Layer 0 without breaking Layer-0 invariants.
**Architecture:** First-party trusted built-in plugin (`karma.tool.ts`, in-process) → viem batched JSON-RPC → `AgentSkillRegistry.sol` (ReentrancyGuard, pull-payment) on Pharos Atlantic. Singletons (`keystoreManager`, `skillIndex`) live in-process; BM25 updated incrementally from contract events.
**Tech Stack:** TypeScript/ESM, zod/v4, viem ^2, minisearch ^7, Foundry + @openzeppelin/contracts ^5, Pharos Atlantic testnet.
**Audit Gate:** PASS WITH FLAGS (Tier 3).
**Risk Flags:** see task-risk-score Risk Summary (appended).

Execution order = priority: **P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7**. Each phase produces testable software.

---

## File Map

| File | Responsibility |
|---|---|
| `package.json` | +deps viem, minisearch; +@openzeppelin/contracts (dev) |
| `scripts/check_connectivity.ts` | Live verify chainId + gas mode + faucet balance (AC6) |
| `src/core/plugin_loader.ts:21` | MODIFY `isTrustedBuiltInPlugin()` += karma.tool.ts |
| `src/plugins/karma.tool.ts` | KARMA tools (in-process); startup env assertion |
| `contracts/AgentSkillRegistry.sol` | Escrow registry (hardened) |
| `test/AgentSkillRegistry.t.sol` | Foundry tests |
| `foundry.toml` | Foundry config (remappings, rpc) |
| `src/lib/types.ts` | Shared TS types (SkillDocument, AgentIdentity, …) |
| `src/lib/keystore.ts` | `KeystoreManager` (Web3 Secret Storage v3) |
| `src/lib/contract.ts` | `defineChain` + batched clients + event indexer |
| `src/lib/bm25_index.ts` | `BM25SkillIndex` (incremental + reputation boost) |
| `scripts/setup_keystore.ts` | Encrypt PK → keystore.json |
| `scripts/run_demo.ts` | 4-tx self-referential demo |

---

## PHASE 0 — Connectivity & Dependencies (🔴 D-4, prerequisite)

### Task 0.1: Add dependencies
**Files:** Modify `package.json`
- [ ] **Step 1:** `pnpm add viem minisearch` then `pnpm add -D @openzeppelin/contracts`
- [ ] **Step 2:** Verify `pnpm typecheck` still passes (no usage yet) → expected PASS
- [ ] **Step 3:** Commit `git commit -m "build: add viem, minisearch, openzeppelin deps"`

### Task 0.2: Live connectivity check (mitigates D-4, AC6)
**Files:** Create `scripts/check_connectivity.ts`
- [ ] **Step 1:** Implement (complete code):
```typescript
import { createPublicClient, http, formatEther } from "viem";
const RPC = process.env.PHAROS_RPC_URL ?? "https://atlantic.dplabs-internal.com";
const client = createPublicClient({ transport: http(RPC, { batch: { batchSize: 100 } }) });
const main = async () => {
  const chainId = await client.getChainId();
  const block = await client.getBlock();
  const gasMode = block.baseFeePerGas != null ? "eip1559" : "legacy"; // baseFee present ⇒ 1559
  const addr = process.env.DEPLOYER_ADDRESS as `0x${string}` | undefined;
  const bal = addr ? await client.getBalance({ address: addr }) : 0n;
  console.log(JSON.stringify({
    rpc: RPC, chainId, gasMode,
    baseFeePerGas: block.baseFeePerGas?.toString() ?? null,
    deployer: addr ?? "(set DEPLOYER_ADDRESS)", balancePHRS: addr ? formatEther(bal) : "n/a",
  }, null, 2));
  if (addr && bal === 0n) console.error("⚠️  Deployer balance 0 — claim from a faucet before deploying.");
};
main().catch((e) => { console.error("CONNECTIVITY FAIL:", e); process.exit(1); });
```
- [ ] **Step 2: Run — capture evidence** `PHAROS_RPC_URL=https://atlantic.dplabs-internal.com tsx scripts/check_connectivity.ts` → expected: prints real `chainId` (RESOLVE 688688 vs 688689) and `gasMode`.
- [ ] **Step 3:** Record the returned chainId + gasMode into `.env` (`PHAROS_CHAIN_ID`) and into `docs/superpowers/CONTEXT.md` Domain Gotchas (evidence anchor).
- [ ] **Step 4:** Commit `git commit -m "chore: add Pharos connectivity check + record live chainId/gas"`

> **Gate:** Do NOT proceed to any deploy/write task until chainId + gasMode are recorded. If `gasMode==legacy`, contract client (P4) must set `type:'legacy'`.

---

## PHASE 1 — In-process plugin enablement (🔴 D-1/D-2/D-3, Failure-Mode-2)

### Task 1.1: Make karma.tool.ts a trusted built-in
**Files:** Modify `src/core/plugin_loader.ts:21`; Test `src/__tests__/karma_builtin_plugin.test.ts`
- [ ] **Step 1: Write failing test**
```typescript
import { describe, it, expect } from "vitest";
import { isTrustedBuiltInPlugin } from "../core/plugin_loader.js"; // export it
describe("trusted built-in", () => {
  it("treats karma.tool.ts as in-process trusted built-in", () => {
    expect(isTrustedBuiltInPlugin("karma.tool.ts")).toBe(true);
    expect(isTrustedBuiltInPlugin("karma.tool.js")).toBe(true);
    expect(isTrustedBuiltInPlugin("random.tool.ts")).toBe(false);
  });
});
```
- [ ] **Step 2: Run — verify FAIL** `pnpm test -- karma_builtin_plugin` → FAIL (not exported / returns false)
- [ ] **Step 3: Implement** — export + extend (`src/core/plugin_loader.ts`):
```typescript
export function isTrustedBuiltInPlugin(fileName: string): boolean {
  return fileName === "system.tool.ts" || fileName === "system.tool.js"
      || fileName === "karma.tool.ts" || fileName === "karma.tool.js";
}
```
- [ ] **Step 4: Run — verify PASS** `pnpm test -- karma_builtin_plugin` → PASS
- [ ] **Step 5: Commit** `git commit -m "feat(plugin): treat karma.tool.ts as trusted in-process built-in [D-1]"`

### Task 1.2: karma.tool.ts skeleton + in-process/env assertion
**Files:** Create `src/plugins/karma.tool.ts`; Test `src/__tests__/karma_plugin_health.test.ts`
- [ ] **Step 1: Write failing test** — load plugin, assert `karma_health` exists, declares `network`, and returns env presence:
```typescript
import { describe, it, expect } from "vitest";
import tools from "../plugins/karma.tool.js";
it("exposes karma_health with network capability", () => {
  const t = tools.find((x) => x.name === "karma_health");
  expect(t).toBeTruthy();
  expect(t!.capabilities).toContain("network");
});
```
- [ ] **Step 2: Run — verify FAIL** → FAIL (file absent)
- [ ] **Step 3: Implement** skeleton (singletons declared here so they persist in-process):
```typescript
import { z } from "zod/v4";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

// Fail-fast if mis-deployed as external (env stripped) — mitigates Failure-Mode-2.
function assertInProcessEnv(): void {
  if (process.env.KARMA_PLUGIN_WORKER === "1")
    throw new Error("[KARMA] karma.tool.ts must run in-process (trusted built-in), not the external worker.");
}

const tools: ToolDefinition[] = [{
  name: "karma_health",
  description: "Report KARMA plugin runtime: in-process mode, env presence, RPC reachability.",
  inputSchema: { ping: z.string().optional() },
  capabilities: ["network"],
  allowedPhases: ["intake", "execution", "review", "completed"],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execution: { taskSupport: "forbidden" },
  handler: async () => {
    assertInProcessEnv();
    const envOk = Boolean(process.env.PHAROS_RPC_URL);
    return { content: [{ type: "text", text: `[KARMA] in-process=ok env.PHAROS_RPC_URL=${envOk}` }],
             structuredContent: { inProcess: true, hasРpcEnv: envOk } };
  },
}];
export default tools;
```
- [ ] **Step 4: Run — verify PASS** `pnpm test -- karma_plugin_health` + `pnpm typecheck` → PASS
- [ ] **Step 5: Manual in-process proof (AC1):** with `.env` (`MCP_SAFE_MODE=false`, `MCP_PLUGIN_ISOLATION_MODE=policy`, `MCP_PLUGIN_ALLOWLIST=system.tool.ts,karma.tool.ts`, `PHAROS_RPC_URL=...`) run server, call `karma_health` → `structuredContent.inProcess=true`, `hasRpcEnv=true`. Capture output as evidence.
- [ ] **Step 6: Commit** `git commit -m "feat(karma): in-process plugin skeleton + env assertion [D-1/D-3]"`

> **Mitigation note (Failure-Mode-2):** `assertInProcessEnv()` + AC1 manual proof are the fail-fast guards. Also document in `.env` that `ISOLATION_MODE=external` is unsupported for KARMA.

---

## PHASE 2 — Smart Contract (🟠 D-8, Failure-Mode-3)

### Task 2.1: Foundry scaffold + contract
**Files:** Create `foundry.toml`, `contracts/AgentSkillRegistry.sol`
- [ ] **Step 1:** `foundry.toml` (remap OZ to pnpm path or `forge install`):
```toml
[profile.default]
src = "contracts"; out = "out"; libs = ["node_modules", "lib"]
remappings = ["@openzeppelin/=node_modules/@openzeppelin/"]
```
- [ ] **Step 2:** Implement `AgentSkillRegistry.sol` per spec v3.1 Part 5 (Skill/Job structs, `JobStatus{Open,Delivered,Completed,Refunded,Disputed}`, `pendingWithdrawals`, events, `registerSkill/deactivateSkill/createJob(payable)/deliverResult/confirmCompletion/claimRefund/withdraw`, `ReentrancyGuard`, CEI). Reputation clamps [0,100].
- [ ] **Step 3:** `forge build` → expected PASS
- [ ] **Step 4: Commit** `git commit -m "feat(contract): AgentSkillRegistry hardened escrow [D-8]"`

### Task 2.2–2.5: Foundry tests (TDD, AC3)
**Files:** `test/AgentSkillRegistry.t.sol`
- [ ] **2.2 Happy path:** register → createJob(escrow) → deliverResult → confirmCompletion → provider `withdraw()` receives payout; reputation increased. Write test FIRST → run FAIL → implement until PASS.
- [ ] **2.3 Refund after deadline (L1 boundary):** createJob, `vm.warp(deadline+1)`, `claimRefund` → requester withdrawable; assert revert at `deadline` exactly (`vm.warp(deadline)` → expect revert "before deadline").
- [ ] **2.4 Double-complete reject:** confirmCompletion twice → 2nd reverts (status guard).
- [ ] **2.5 Reentrancy reject (Failure-Mode-3):** attacker contract whose `receive()` re-enters `withdraw()` → assert single payout, no drain (`nonReentrant`).
- [ ] Each: write test → `forge test --match-test <name>` FAIL → implement → PASS → commit.

### Task 2.6: Deploy + verify
**Files:** `contracts/script/Deploy.s.sol`
- [ ] **Step 1:** `forge script ... --rpc-url $PHAROS_RPC_URL --broadcast` (uses `vm.envUint("PRIVATE_KEY")`). Gate: chainId/gas from P0.
- [ ] **Step 2:** Verify via Blockscout/SocialScan; record deployed address → `.env PHAROS_CONTRACT_ADDRESS` + kb-index.
- [ ] **Step 3: Commit** `git commit -m "chore(contract): deploy + verify AgentSkillRegistry on Pharos Atlantic"`

---

## PHASE 3 — Keystore (🔴 D-5)

### Task 3.1: types.ts
**Files:** Create `src/lib/types.ts` — `SkillDocument`, `AgentIdentity`, `KeystoreFileV3` (agents[].crypto: {kdf, kdfparams{n,r,p,dklen,salt}, ciphertext, cipherparams{iv}, mac}).
- [ ] Build → commit.

### Task 3.2: KeystoreManager (TDD, AC4)
**Files:** `src/lib/keystore.ts`; Test `src/__tests__/keystore.test.ts`
- [ ] **Step 1: Write failing test** — generate a v3 keystore fixture (via setup helper or hardcoded known vector), `load()`, assert `getAddress(agentId)` matches expected; wrong password → throws MAC mismatch:
```typescript
it("round-trips a v3 keystore and rejects wrong password", async () => {
  await km.load(FIXTURE_PATH, "correct-pw");
  expect(km.getAddress("agent-alpha")).toBe(EXPECTED_ADDR);
  await expect(km2.load(FIXTURE_PATH, "wrong-pw")).rejects.toThrow(/MAC mismatch/);
});
```
- [ ] **Step 2: Run — verify FAIL**
- [ ] **Step 3: Implement** per spec v3.1 Part 4 (scrypt n=262144,r=8,p=1 + aes-128-ctr + keccak256 MAC over `derived[16:32]++ct`; assert `kdf==="scrypt"` else throw — mitigates KDF assumption). `privateKeyToAccount(pk, { nonceManager })`.
- [ ] **Step 4: Run — verify PASS** + `pnpm typecheck`
- [ ] **Step 5: Commit** `git commit -m "feat(keystore): Web3 Secret Storage v3 decrypt, in-process only [D-5]"`

### Task 3.3: setup_keystore.ts
**Files:** `scripts/setup_keystore.ts` — encrypt a raw PK (or generate) → keystore.json (scrypt v3); confirm `.gitignore` covers `keystore.json`. Round-trip with 3.2. Commit.

---

## PHASE 4 — ContractClient (🟠 D-9/D-7, L4/L6/Abductive-1)

### Task 4.1: defineChain + batched clients
**Files:** `src/lib/contract.ts` — `pharosAtlantic = defineChain({id: Number(PHAROS_CHAIN_ID), ...})`; `transport = http(RPC, { batch:{ batchSize:100 } })`; `publicClient`, `walletClient`. Test: `publicClient.getChainId()` equals env. Commit.

### Task 4.2: write helper — exactly-once + bounded wait (D-7, Abductive-1)
**Files:** `src/lib/contract.ts`
- [ ] **Mechanism:** `simulateContract → writeContract → waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })` where `RECEIPT_TIMEOUT_MS < MCP_LOCK_TTL_MS (420000)` (set 300000). Use account `nonceManager`; for `create_job`, derive a deterministic client job-key and **check-before-write** (query mapping) so a lost-ack retry does not double-escrow.
- [ ] Test (mock transport): simulate a "receipt timeout" path returns a typed pending result, not a duplicate send. Commit `feat(contract): exactly-once write helper, bounded receipt wait [D-7]`.

### Task 4.3: Event indexer with reconnect + backfill + heartbeat (L4/L6)
**Files:** `src/lib/contract.ts`
- [ ] `startIndexer()`: `watchContractEvent(SkillRegistered/SkillDeactivated/JobCompleted)` with `onError` → reconnect; on (re)start, `getLogs({fromBlock: lastIndexedBlock})` **backfill**; track `lastIndexedBlock` + `lastEventAt` (heartbeat) exposed via `karma_health`. Test: backfill calls getLogs from stored block. Commit.

---

## PHASE 5 — BM25 index (⚡ D-10/D-11, Abductive-2)

### Task 5.1: BM25SkillIndex
**Files:** `src/lib/bm25_index.ts`; Test `src/__tests__/bm25_index.test.ts`
- [ ] TDD: add 3 skills → search ranks by text; higher `reputation_score` boosts ranking (`boostDocument`); `filter` by maxPriceWei/minReputation; `discard` removes; indexed text is sanitized (strip control/injection markers — Abductive-2); cold-start `rebuildFromChain` paginates. `price_per_call_wei` stored as **string** (D-6). Commit.

---

## PHASE 6 — Tools (🟠 D-6/D-12)

One task per tool; each: write handler test (mock contract/keystore) → implement → stringify ALL BigInt in `structuredContent` (D-6) → no bare wei in `content.text` → PASS → commit. All declare `capabilities:["network"]`, **no** `requiredScopes` (D-2).

- [ ] **6.1 register_skill** — writeContract registerSkill; on receipt, `skillIndex.upsert`. 
- [ ] **6.2 discover_skills** — `skillIndex.search(query,{maxPriceWei,minReputation})`; returns stringified prices.
- [ ] **6.3 create_job** — `idempotency_nonce` arg (z.number().int().positive) [D-12]; exactly-once helper [D-7]; `taskSupport:"optional"`.
- [ ] **6.4 deliver_result** — provider submits resultHash.
- [ ] **6.5 complete_job** — requester confirms → escrow to provider pendingWithdrawals.
- [ ] **6.6 get_agent_reputation** — read skills/jobs, stringify scores.
- [ ] **6.7 query_social_graph** — read agentProviderJobs/agentRequesterJobs edges.

---

## PHASE 7 — Demo

### Task 7.1: run_demo.ts (AC: 4 real tx)
**Files:** `scripts/run_demo.ts` — Agent Alpha registers `discover_skills` as a paid skill; Agent Beta create_job (escrow) → Alpha deliver_result → Beta complete_job. Print 4 explorer tx links. Update `DEMO.md`. Commit.

---

## Self-Review

**1. Spec coverage:** AC1→P1.2; AC2→every phase runs `test:enterprise`+typecheck; AC3→P2.2–2.5; AC4→P3.2; AC5→P6 (D-6); AC6→P0.2. All 13 Δ items mapped (D-1→P1, D-2→P6, D-3→P1/.env, D-4→P0, D-5→P3, D-6→P5/P6, D-7→P4.2, D-8→P2, D-9→P4.1, D-10/11→P4.3/P5, D-12→P6.3, D-13→docs). HIGH flags: double-escrow→P4.2; singleton-blindness→P1.2; reentrancy→P2.5; WSS/backfill→P4.3; lock×latency→P4.2; indexer health→P4.3. **No gaps.**
**2. Placeholder scan:** none (Phase 6/7 tool bodies reference spec v3.1 Part 5/7 for exact contract calls; interfaces fixed).
**3. Type consistency:** `SkillDocument` (types.ts) used by bm25 + tools; `price_per_call_wei:string` consistent; `skillIndex`/`keystoreManager` singletons referenced uniformly.
**4. Risk scoring:** see Task Risk Summary below.

---

## Task Risk Summary (task-risk-score)
<!-- task-risk-score: DO NOT DUPLICATE — update this section -->
<!-- last-run: 2026-06-15 | sprint: karma-s1 | formula: (S×B)/D, super-skills-v2 -->

Context types: Pharos RPC tasks = EXTERNAL_SERVICE (D capped at 1 — failures prod-only);
plugin_loader = INFRASTRUCTURE (B≥2); contract = BUSINESS_LOGIC (funds). All tasks SINGLE
boundary (one team owns end-to-end) → no CROSS escalation.

| Task | Context | S×B/D | QBR | Risk | Action |
|------|---------|-------|-----|------|--------|
| P0.1 add deps | INFRA | 1×2/3 | 0.7 | LOW | proceed |
| **P0.2 connectivity check** | EXTERNAL | 3×3/1 | **9** | **HIGH ⚠️** | GATE: live verify chainId+gas; block all deploy/write until recorded |
| P1.1 patch isTrustedBuiltInPlugin | INFRA | 3×3/3 | 3 | MEDIUM | privilege grant — unit-tested; review trust scope |
| P1.2 karma.tool skeleton + assert | INFRA | 2×2/2 | 2 | MEDIUM | manual AC1 in-process proof required (D=2) |
| P2.1 contract impl | BUSINESS | 3×3/3 | 3 | MEDIUM | funds; correctness gated by P2.2–2.5 tests |
| P2.2–2.4 happy/refund/double tests | BUSINESS | 3×3/3 | 3 | MEDIUM | release gates |
| **P2.5 reentrancy test** | BUSINESS | 3×3/3→1 | **9*** | **HIGH ⚠️** | D=3 ONLY because this test exists; if skipped D=1→9. MANDATORY |
| **P2.6 deploy + verify** | EXTERNAL | 3×3/1 | **9** | **HIGH ⚠️** | manual live op; gate on P0.2; verify on explorer |
| P3.2 KeystoreManager | SECURITY | 3×3/3 | 3 | MEDIUM | test against KNOWN vector (not self-generated only) |
| P3.3 setup_keystore | SECURITY | 2×2/3 | 1.3 | LOW | ensure keystore.json gitignored |
| P4.1 defineChain+clients | EXTERNAL | 2×2/2 | 2 | MEDIUM | assert getChainId==env |
| **P4.2a bounded write helper** | EXTERNAL | 3×2/1 | **6** | **HIGH ⚠️** | receipt timeout < MCP_LOCK_TTL (Abductive-1) |
| **P4.2b exactly-once guard** | EXTERNAL | 3×3/1 | **9** | **HIGH ⚠️** | Failure-Mode-1: check-before-write/nonce pin; no double-escrow |
| P4.3 indexer reconnect/backfill/heartbeat | EXTERNAL | 2×2/1 | 4 | MEDIUM | L4/L6 mitigation; watch in review |
| P5.1 BM25 index | BUSINESS | 2×2/3 | 1.3 | LOW | sanitize indexed text (Abductive-2) |
| P6.1 register_skill | EXTERNAL | 2×2/2 | 2 | MEDIUM | upsert index on receipt |
| P6.2 discover_skills | BUSINESS | 2×2/3 | 1.3 | LOW | stringify prices |
| **P6.3 create_job** | EXTERNAL | 3×3/1 | **9** | **HIGH ⚠️** | depends P4.2b; idempotency_nonce; funds |
| P6.4 deliver_result | EXTERNAL | 2×2/2 | 2 | MEDIUM | — |
| **P6.5 complete_job** | EXTERNAL | 3×3/1 | **9** | **HIGH ⚠️** | releases escrow to provider; depends P2/P4 |
| P6.6 get_agent_reputation | BUSINESS | 1×2/3 | 0.7 | LOW | stringify scores |
| P6.7 query_social_graph | BUSINESS | 1×2/3 | 0.7 | LOW | — |
| P7.1 run_demo | EXTERNAL | 1×2/1 | 2 | MEDIUM | live; visible immediately |

**Summary:**
- **High-risk tasks (7):** P0.2, P2.5, P2.6, P4.2a, P4.2b, P6.3, P6.5 — each requires live/integration verification, not just unit tests. Funds + external-chain blast radius.
- **Cross-boundary tasks:** none (single team).
- **Integration-test surface:** P2.* (Foundry), P4.* (live RPC / mock-transport), P6.3/6.5 (end-to-end on testnet). ~7 tasks need beyond-unit verification.
- **Decomposition applied:** P4.2 → P4.2a (bounded write) + P4.2b (exactly-once guard).
- **Calibration note:** P2.5 & all EXTERNAL D=1 per tikai-H25 ("has tests" ≠ "has test for THIS failure"). Log actual outcomes to qbr-calibration.md after sprint.

