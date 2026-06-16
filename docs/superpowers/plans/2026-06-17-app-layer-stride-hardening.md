# App-layer STRIDE hardening — Implementation Plan (Workstream A)

> **For agentic workers:** execute with `executing-plans` (inline) — task-by-task, RED→GREEN→commit.

**Goal:** Close 3 app-layer STRIDE findings — tenant→agent isolation (S), output-firewall on the
error path incl. private-key redaction (Info-Disclosure), and a fan-out cap on `query_social_graph`
(DoS) — with zero contract change.
**Architecture:** Tenant binding lives in the keystore (`assertOwnedBy`) and is threaded from
`getRequestContext().tenantId` through `KarmaService.account/addressOf`. Error redaction is one
exported `redactErrorText` + one `toClientError` chokepoint wrapping the MCP handler. The cap +
chunked hydration live in `handleFullFormat`.
**Tech Stack:** TypeScript (ESM, NodeNext), zod/v4, vitest, viem.
**Audit Gate:** PASS WITH FLAGS (2026-06-17).
**Risk Flags:** see Risk Summary (task-risk-score, appended after self-review).

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/lib/types.ts` | modify | `AgentIdentity.tenant`, `KeystoreFileV3.agents[].tenant?`, `SocialGraphSummary.{truncated,total_unique_jobs}` |
| `src/config/env.ts` | modify | `KARMA_SOCIAL_GRAPH_MAX_JOBS`, `KARMA_DEFAULT_AGENT_TENANT` |
| `src/lib/keystore.ts` | modify | store per-agent tenant; `assertOwnedBy(agentId, tenantId)` |
| `src/lib/karma_service.ts` | modify | `account/addressOf` gain `tenantId`; enforce via keystore |
| `src/plugins/karma.tool.ts` | modify | thread `tenantId`; cap+chunk in `handleFullFormat` |
| `src/middlewares/output_firewall.ts` | modify | export `redactErrorText` (error-path-only, incl. HEX32) |
| `src/mcp/adapter/execution_pipeline.ts` | modify | `makeToolErrorResult`→`redactErrorText`; `toClientError`; chokepoint wrap |
| `src/__tests__/keystore.test.ts` | modify | A1 binding tests |
| `src/__tests__/karma_tools.test.ts` | modify | A1 threading/reject + A3 cap tests |
| `src/__tests__/output_firewall.test.ts` | modify | `redactErrorText` tests (incl. private key) |
| `src/__tests__/execution_pipeline_error_redaction.test.ts` | create | `toClientError` redaction unit test |

Invariant for all code steps: `pnpm typecheck` and `pnpm lint` stay clean; full `pnpm test` green
(baseline 350 pass / 1 skip / 0 fail).

---

## Unit A1 — Tenant → agent binding

### Task A1.1 — Data model: tenant on identity + keystore file

**Files:** Modify `src/lib/types.ts`

- [ ] **Step 1 — implement**
```ts
// AgentIdentity: add resolved tenant (never undefined after load)
export interface AgentIdentity {
  agentId: string;
  address: Address;
  account: ManagedAccount;
  tenant: string; // resolved at load: entry.tenant ?? default agent tenant (fail-closed binding)
}

// KeystoreFileV3.agents[]: add optional per-agent tenant
export interface KeystoreFileV3 {
  version: 3;
  agents: Array<{
    agentId: string;
    address?: string;
    tenant?: string; // owning tenant; absent ⇒ bound to KARMA_DEFAULT_AGENT_TENANT ?? MCP_TENANT_ID
    crypto: CryptoV3;
  }>;
}
```
- [ ] **Step 2 — verify** `pnpm typecheck` → expected: FAIL in keystore.ts (AgentIdentity now requires `tenant`). That failure is fixed in A1.2.

### Task A1.2 — Keystore: store tenant + `assertOwnedBy`

**Files:** Modify `src/lib/keystore.ts`; Test `src/__tests__/keystore.test.ts`

- [ ] **Step 1 — write failing tests** (append to keystore.test.ts; reuse its fixture pattern)
```ts
import { ENV } from "../config/env.js";

describe("KeystoreManager tenant binding (A1)", () => {
  it("assertOwnedBy: an agent with no tenant field binds to the default tenant", async () => {
    const km = new KeystoreManager();
    await km.load(fixturePath, "testpassword"); // existing fixture has no tenant fields
    const agentId = km.list()[0];
    expect(() => km.assertOwnedBy(agentId, ENV.KARMA_DEFAULT_AGENT_TENANT ?? ENV.MCP_TENANT_ID)).not.toThrow();
  });

  it("assertOwnedBy: rejects a tenant that does not own the agent (generic message)", async () => {
    const km = new KeystoreManager();
    await km.load(fixturePath, "testpassword");
    const agentId = km.list()[0];
    expect(() => km.assertOwnedBy(agentId, "some-other-tenant")).toThrow(/not accessible to this tenant/i);
    // must NOT leak the owning tenant id
    try { km.assertOwnedBy(agentId, "some-other-tenant"); } catch (e) {
      expect(String((e as Error).message)).not.toContain(ENV.MCP_TENANT_ID);
    }
  });

  it("assertOwnedBy: unknown agent throws not-found (no tenant info leak)", async () => {
    const km = new KeystoreManager();
    await km.load(fixturePath, "testpassword");
    expect(() => km.assertOwnedBy("nope", "any")).toThrow(/Agent not found/i);
  });
});
```
- [ ] **Step 2 — run, verify FAIL** `pnpm vitest run src/__tests__/keystore.test.ts` → expected: FAIL (no `assertOwnedBy`).
- [ ] **Step 3 — implement** in `src/lib/keystore.ts`
```ts
import { ENV } from "../config/env.js"; // top of file with other imports

// near top, after imports:
const DEFAULT_AGENT_TENANT = ENV.KARMA_DEFAULT_AGENT_TENANT ?? ENV.MCP_TENANT_ID;
```
In `load`, set the resolved tenant when building each identity:
```ts
this.identities.set(entry.agentId, {
  agentId: entry.agentId,
  address: account.address,
  account,
  tenant: entry.tenant ?? DEFAULT_AGENT_TENANT, // fail-closed: absent binds to the default tenant
});
```
Add the enforcement method (after `requireIdentity`):
```ts
/**
 * Authz gate (STRIDE-S): the calling tenant must own this agent. Message is intentionally
 * generic — it never names the owning tenant — to avoid cross-tenant reconnaissance.
 */
assertOwnedBy(agentId: string, tenantId: string): void {
  const id = this.requireIdentity(agentId); // throws "Agent not found" first
  if (id.tenant !== tenantId) {
    throw new Error(`[KARMA] agent '${agentId}' is not accessible to this tenant`);
  }
}
```
- [ ] **Step 4 — run, verify PASS** `pnpm vitest run src/__tests__/keystore.test.ts` → expected: PASS. Also `pnpm typecheck` → clean.
- [ ] **Step 5 — commit** `git commit -am "feat(karma): keystore per-agent tenant binding + assertOwnedBy [A1]"`

### Task A1.3 — Service seam: thread tenantId, enforce on resolve

**Files:** Modify `src/lib/karma_service.ts`

- [ ] **Step 1 — implement** interface signatures:
```ts
account(agentId: string, tenantId: string): Account;
addressOf(agentId: string, tenantId: string): Address;
```
realKarmaService:
```ts
account: (agentId, tenantId) => {
  keystoreManager.assertOwnedBy(agentId, tenantId);
  return keystoreManager.getAccount(agentId);
},
addressOf: (agentId, tenantId) => {
  keystoreManager.assertOwnedBy(agentId, tenantId);
  return keystoreManager.getAddress(agentId);
},
```
- [ ] **Step 2 — verify** `pnpm typecheck` → expected: FAIL in karma.tool.ts (call sites pass 1 arg). Fixed in A1.4.

### Task A1.4 — Plugin: read tenant from context, thread everywhere

**Files:** Modify `src/plugins/karma.tool.ts`; Test `src/__tests__/karma_tools.test.ts`

- [ ] **Step 1 — write failing tests** (append to karma_tools.test.ts; add import)
```ts
import { withRequestContext } from "../security/context.js";

describe("A1 tenant isolation", () => {
  it("threads the caller's tenantId into svc.account", async () => {
    await call(tool(tools, "withdraw_balance"), { agentId: "agent-alpha" });
    expect(svc.account).toHaveBeenCalledWith("agent-alpha", "tenant_local"); // default ctx tenant
  });

  it("a foreign tenant cannot drive another tenant's agent (no on-chain write)", async () => {
    svc = fakeService({
      account: vi.fn((_agentId: string, tenantId: string) => {
        if (tenantId !== "tenant_local") throw new Error("[KARMA] agent 'x' is not accessible to this tenant");
        return { address: ALPHA } as never;
      }),
    });
    tools = createKarmaTools(svc);
    await expect(
      withRequestContext(
        { tenantId: "evil", userId: "u", clientId: "c", scopes: [], requestId: "r", authType: "gateway" },
        () => call(tool(tools, "create_job"), { agentId: "agent-alpha", skillId: "7", idempotencyNonce: 1 }),
      ),
    ).rejects.toThrow(/not accessible to this tenant/i);
    expect(svc.createJob).not.toHaveBeenCalled();
  });
});
```
- [ ] **Step 2 — run, verify FAIL** `pnpm vitest run src/__tests__/karma_tools.test.ts -t "A1 tenant"` → expected: FAIL.
- [ ] **Step 3 — implement** in `src/plugins/karma.tool.ts`:

Add import:
```ts
import { getRequestContext } from "../security/context.js";
```
Change `resolveAddress` to take tenantId:
```ts
function resolveAddress(svc: KarmaService, a: { agentId?: string; address?: string }, tenantId: string): Address {
  if (a.agentId) return svc.addressOf(a.agentId, tenantId);
  if (a.address) return a.address as Address;
  throw new Error("[KARMA] provide either agentId or address");
}
```
In every handler that resolves an account/address, read tenant once and thread it. Concretely:
- `register_skill`: `const { tenantId } = getRequestContext();` then `svc.account(a.agentId, tenantId)`.
- `create_job`: `const { tenantId } = getRequestContext();` then `svc.account(a.agentId, tenantId)`.
- `deliver_result`: `const { tenantId } = getRequestContext();` then `svc.deliverResult(svc.account(a.agentId, tenantId), …)`.
- `complete_job`: same pattern → `svc.account(a.agentId, tenantId)`.
- `get_agent_reputation`: `const { tenantId } = getRequestContext();` then `resolveAddress(svc, a, tenantId)`.
- `query_social_graph`: `const { tenantId } = getRequestContext();` then `resolveAddress(svc, a, tenantId)`.
- `get_pending_balance`: `const { tenantId } = getRequestContext();` then `resolveAddress(svc, a, tenantId)`.
- `withdraw_balance`: `const { tenantId } = getRequestContext();` then `svc.withdraw(svc.account(a.agentId, tenantId))`.

`karma_health` is unchanged (no account/address).
- [ ] **Step 4 — run, verify PASS** `pnpm vitest run src/__tests__/karma_tools.test.ts` → expected: PASS (new A1 tests + all existing — the fakes ignore the extra arg). `pnpm typecheck` → clean.
- [ ] **Step 5 — commit** `git commit -am "feat(karma): enforce tenant→agent ownership in tools [A1]"`

---

## Unit A2 — Output firewall on the error path

### Task A2.1 — `redactErrorText` (error-path-only, incl. private-key hex)

**Files:** Modify `src/middlewares/output_firewall.ts`; Test `src/__tests__/output_firewall.test.ts`

- [ ] **Step 1 — write failing tests**
```ts
import { redactErrorText } from "../middlewares/output_firewall.js";

describe("redactErrorText (error-path firewall, A2)", () => {
  it("redacts a bare private-key-shaped hex blob (HIGH, abductive-2)", () => {
    const pk = "0x" + "a".repeat(64);
    expect(redactErrorText(`viem signer failed for key ${pk}`)).not.toContain(pk);
  });
  it("redacts credentials, email, paths, redis/pg URLs", () => {
    const out = redactErrorText(
      "boom sk-ABCDEFGHIJKLMNOPQRSTUV at /home/u/secret.json redis://h:6379 user a@b.com",
    );
    expect(out).not.toMatch(/sk-ABCDEFGHIJKLMNOPQRSTUV/);
    expect(out).toContain("[path]");
    expect(out).toContain("[redis]");
    expect(out).not.toContain("a@b.com"); // strict-PII default off → email passes; see note
  });
  it("caps length at 256", () => {
    expect(redactErrorText("x".repeat(1000)).length).toBeLessThanOrEqual(256);
  });
});
```
> Note: email redaction only fires when `MCP_OUTPUT_FIREWALL_PII_MODE=strict`. The `a@b.com`
> assertion above must match that env reality — if default mode, assert `toContain("a@b.com")`
> instead. Set the assertion to the configured mode at write time (default = credentials_only ⇒
> email NOT redacted). Keep the credential/path/redis/HEX32 assertions unconditional.

- [ ] **Step 2 — run, verify FAIL** `pnpm vitest run src/__tests__/output_firewall.test.ts -t redactErrorText` → expected: FAIL.
- [ ] **Step 3 — implement** in `src/middlewares/output_firewall.ts` (export after `redactSensitiveText`)
```ts
// Error-path only: a bare 0x+64hex is private-key / 32-byte-secret shaped. NEVER add this to
// scanToolOutput — legitimate tool output (e.g. result_hash, taskHash) is the same shape.
const HEX32_RE = /0x[0-9a-fA-F]{64}/g;

export function redactErrorText(text: string): string {
  const violations = new Set<string>();
  let safe = redactSensitiveText(text, violations); // cards/creds/SSN/strict-PII/prompt-injection
  safe = safe
    .replace(/rediss?:\/\/[^\s]+/gi, "[redis]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[db]")
    .replace(/\/[\w/.-]+/g, "[path]")
    .replace(/[A-Z]:\\[\w\\.-]+/gi, "[path]")
    .replace(HEX32_RE, "[REDACTED:HEX32]");
  return safe.substring(0, 256);
}
```
- [ ] **Step 4 — run, verify PASS** `pnpm vitest run src/__tests__/output_firewall.test.ts` → expected: PASS.
- [ ] **Step 5 — commit** `git commit -am "feat(firewall): redactErrorText for error path, incl. private-key hex [A2]"`

### Task A2.2 — Pipeline: route every thrown error through the chokepoint

**Files:** Modify `src/mcp/adapter/execution_pipeline.ts`; Test `src/__tests__/execution_pipeline_error_redaction.test.ts` (create)

- [ ] **Step 1 — write failing test** (create file)
```ts
import { describe, it, expect } from "vitest";
import { toClientError } from "../mcp/adapter/execution_pipeline.js";

describe("toClientError (A2 chokepoint)", () => {
  it("redacts secrets in the message but preserves name + numeric code", () => {
    const raw = new Error("viem fail 0x" + "b".repeat(64) + " sk-ABCDEFGHIJKLMNOPQRSTUV");
    raw.name = "ContractFunctionExecutionError";
    (raw as { code?: number }).code = -32000;
    const safe = toClientError(raw);
    expect(safe.message).not.toContain("b".repeat(64));
    expect(safe.message).not.toMatch(/sk-ABCDEFGHIJKLMNOPQRSTUV/);
    expect(safe.name).toBe("ContractFunctionExecutionError");
    expect((safe as { code?: number }).code).toBe(-32000);
  });
});
```
- [ ] **Step 2 — run, verify FAIL** `pnpm vitest run src/__tests__/execution_pipeline_error_redaction.test.ts` → expected: FAIL (no export).
- [ ] **Step 3 — implement** in `src/mcp/adapter/execution_pipeline.ts`

Add import:
```ts
import { scanToolOutput, redactErrorText } from "../../middlewares/output_firewall.js";
```
Replace `makeToolErrorResult` body to delegate (keeps path/credential parity in one place):
```ts
function makeToolErrorResult(prefix: string, error: unknown): ToolResult {
  const raw = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `${prefix}: ${redactErrorText(raw)}` }] };
}
```
Add the exported chokepoint helper near it:
```ts
/** Sanitize an error before it leaves KARMA for the MCP client. Full error stays in telemetry. */
export function toClientError(error: unknown): Error {
  if (error instanceof ElicitationRequiredException) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const safe = new Error(redactErrorText(raw));
  if (error instanceof Error) {
    safe.name = error.name;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") (safe as { code?: unknown }).code = code;
  }
  return safe;
}
```
Wrap the entire `registerMcpTool` handler body (the `async (args, extra) => { … }` at lines ~359–644)
in one outer try/catch — the single chokepoint:
```ts
registerMcpTool(
  server,
  tool,
  async (args: unknown, extra: { /* unchanged */ } = {}) => {
    try {
      // ... ENTIRE existing handler body unchanged ...
    } catch (error) {
      throw toClientError(error);
    }
  },
);
```
> The inner sync/transient/lock catches already log `error: String(error)` to telemetry (full,
> server-side) and re-throw; the outer chokepoint only rewrites the outgoing message. Returns
> (ElicitationRequired, task results, cache hits) are unaffected — they are not throws.
- [ ] **Step 4 — run, verify PASS** `pnpm vitest run src/__tests__/execution_pipeline_error_redaction.test.ts` → PASS. Full `pnpm test` → green. `pnpm typecheck` + `pnpm lint` → clean.
- [ ] **Step 5 — commit** `git commit -am "feat(pipeline): sanitize all thrown errors at one chokepoint [A2]"`

---

## Unit A3 — Social-graph fan-out cap

### Task A3.1 — Env + summary type

**Files:** Modify `src/config/env.ts`, `src/lib/types.ts`

- [ ] **Step 1 — implement** env (add to `EnvSchema`):
```ts
KARMA_SOCIAL_GRAPH_MAX_JOBS: z.number().int().min(1).max(100000).default(500),
KARMA_DEFAULT_AGENT_TENANT: z.string().optional(),
```
and to the `rawEnv` object in `loadEnv`:
```ts
KARMA_SOCIAL_GRAPH_MAX_JOBS: parseIntEnv(process.env.KARMA_SOCIAL_GRAPH_MAX_JOBS),
KARMA_DEFAULT_AGENT_TENANT: process.env.KARMA_DEFAULT_AGENT_TENANT,
```
`src/lib/types.ts` `SocialGraphSummary`:
```ts
/** True when job edges exceeded KARMA_SOCIAL_GRAPH_MAX_JOBS; detail arrays + earned/spent are then PARTIAL. */
truncated: boolean;
/** Distinct job edges seen before the cap (full count even when truncated). */
total_unique_jobs: number;
```
- [ ] **Step 2 — verify** `pnpm typecheck` → expected: FAIL in karma.tool.ts (`handleFullFormat` does not set the two new required summary fields). Fixed in A3.2.

### Task A3.2 — Cap + chunked hydration in `handleFullFormat`

**Files:** Modify `src/plugins/karma.tool.ts`; Test `src/__tests__/karma_tools.test.ts`

- [ ] **Step 1 — write failing test** (append)
```ts
describe("A3 social-graph fan-out cap", () => {
  it("caps hydration at KARMA_SOCIAL_GRAPH_MAX_JOBS and flags truncated", async () => {
    const ids = Array.from({ length: 600 }, (_, i) => BigInt(i + 1));
    svc = fakeService({
      getProviderJobs: vi.fn(async () => ids),
      getRequesterJobs: vi.fn(async () => []),
      readJob: vi.fn(async (id: bigint) => ({
        requester: ALPHA, provider: ALPHA, skillId: 1n, taskHash: `0x${"00".repeat(32)}`,
        escrowAmount: 0n, deadline: 0n, status: 0, resultHash: `0x${"00".repeat(32)}`,
        createdAt: 1n, completedAt: 0n,
      }) as never),
    });
    tools = createKarmaTools(svc);
    const res = await call(tool(tools, "query_social_graph"), { address: ALPHA, format: "full" });
    const sc = res.structuredContent as { summary: { truncated: boolean; total_unique_jobs: number } };
    expect(svc.readJob).toHaveBeenCalledTimes(500);
    expect(sc.summary.truncated).toBe(true);
    expect(sc.summary.total_unique_jobs).toBe(600);
  });
});
```
- [ ] **Step 2 — run, verify FAIL** `pnpm vitest run src/__tests__/karma_tools.test.ts -t "A3 social-graph"` → expected: FAIL.
- [ ] **Step 3 — implement** in `src/plugins/karma.tool.ts`. Add import `import { ENV } from "../config/env.js";`. Add helper above `handleFullFormat`:
```ts
/** Hydrate job ids in sequential chunks (matches viem batchSize) to bound in-flight reads + memory. */
async function readJobsChunked(ids: string[], svc: KarmaService, chunk = 100): Promise<JobDetail[] | never> {
  const out: Awaited<ReturnType<KarmaService["readJob"]>>[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    out.push(...(await Promise.all(slice.map((id) => svc.readJob(BigInt(id))))));
  }
  return out as never;
}
```
Rewrite the head of `handleFullFormat` (replace the `uniqueIds`/`jobs`/`jobById` block and the
`asProvider`/`asRequester` derivations):
```ts
const allUnique = [...new Set([...providerIds, ...requesterIds].map(String))];
const cap = ENV.KARMA_SOCIAL_GRAPH_MAX_JOBS;
const truncated = allUnique.length > cap;
// job ids are monotonic — keep the most recent `cap` (numeric desc), never lexicographic.
const uniqueIds = truncated
  ? [...allUnique].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : BigInt(a) > BigInt(b) ? -1 : 0)).slice(0, cap)
  : allUnique;
const hydratedSet = new Set(uniqueIds);
const jobs = await readJobsChunked(uniqueIds, svc, 100);
const jobById = new Map(uniqueIds.map((id, i) => [id, jobs[i]] as const));
// ... toDetail unchanged ...
const asProvider = providerIds
  .filter((id) => hydratedSet.has(String(id)))
  .map((id) => toDetail(id, "requester"));
const asRequester = requesterIds
  .filter((id) => hydratedSet.has(String(id)))
  .map((id) => toDetail(id, "provider"));
```
And add the two fields to the returned `summary`:
```ts
truncated,
total_unique_jobs: allUnique.length,
```
- [ ] **Step 4 — run, verify PASS** `pnpm vitest run src/__tests__/karma_tools.test.ts` → PASS (A3 + the existing `format:"full"` test: N=3 < cap ⇒ truncated:false, shape unchanged). `pnpm typecheck` → clean.
- [ ] **Step 5 — commit** `git commit -am "feat(karma): cap + chunk query_social_graph hydration [A3]"`

---

## Final verification (verification-before-completion)

- [ ] `pnpm typecheck` → clean
- [ ] `pnpm lint` → clean
- [ ] `pnpm test` → 350 + new tests pass, 0 fail
- [ ] Manual reasoning re-check: `scanToolOutput` UNCHANGED (result_hash not redacted in normal output);
      HEX32 redaction only in `redactErrorText`.

---

## Spec coverage check (self-review)
- A1 (Claim S): A1.1–A1.4 ✓ — incl. generic message (L5), default-tenant override env (FM1),
  both-transport note (ASSUMED — covered by default-ctx test + withRequestContext gateway test).
- A2 (Claim 4): A2.1–A2.2 ✓ — incl. HEX32 private-key (HIGH), name/code preserved (FM2), telemetry full.
- A3 (Claim 5): A3.1–A3.2 ✓ — numeric sort (L1), truncated flag marks partial sums (FM3).
- L6 (distinct tenant-mismatch telemetry signal): NOT a separate task — the thrown authz error is
  logged by the pipeline as `tool_execution_failed` with `tool` name; a dedicated event would require
  a telemetry seam in the plugin (it has none). **Deferred → PATTERN-DEBT note in adr-commit** rather
  than widening plugin responsibilities this cycle.

## Environment preconditions (deployment risks)
- Multi-tenant: add `tenant` to each `keystore.json` agent **or** set `KARMA_DEFAULT_AGENT_TENANT`
  to the live tenant id (api-key mode uses `api-key-dev-tenant`, not `MCP_TENANT_ID`). Manual,
  not auto-migrated — document in run notes.
- `KARMA_SOCIAL_GRAPH_MAX_JOBS` default 500; tune per deployment.

## Task Risk Summary (task-risk-score)
<!-- task-risk-score: DO NOT DUPLICATE — update this section -->
<!-- last-run: 2026-06-17 | formula: (S×B)/D, HIGH ≥ 6 (pre-empirical) -->

| Task | Context | S×B/D | QBR | Risk | Boundary | Action |
|------|---------|-------|-----|------|----------|--------|
| A1.1 types | BUSINESS_LOGIC | 2×1/3 | 0.7 | LOW | SINGLE | proceed |
| A1.2 keystore assertOwnedBy | SECURITY | 3×2/3 | 2 | LOW | SINGLE | proceed (unit-tested authz) |
| A1.3 service seam | SECURITY | 3×2/3 | 2 | LOW | SINGLE | proceed |
| A1.4 plugin threading | SECURITY | 3×2/2 | 3 | MEDIUM ℹ️ | SINGLE | review: verify **all 8** call sites threaded — a missed site = an un-gated path |
| A2.1 redactErrorText | SECURITY | 3×2/2 | 3 | MEDIUM ℹ️ | SINGLE | review: redaction gaps (unknown secret shapes) only visible in prod; HIGH private-key case is now tested |
| A2.2 chokepoint wrap | INFRASTRUCTURE | 3×2/2 | 3 | MEDIUM ℹ️ | SINGLE | verify transient/lock idempotency-release still fires (run idempotency + execution_lock tests) |
| A3.1 env + type | BUSINESS_LOGIC | 2×2/3 | 1.3 | LOW | SINGLE | proceed |
| A3.2 cap + chunk | BUSINESS_LOGIC | 2×2/3 | 1.3 | LOW | SINGLE | proceed (numeric-sort + count covered by test) |

**Summary:**
- High-risk tasks: none (QBR < 6 across the board — these are well-testable app-layer changes; the
  design-level HIGH from audit-design (private-key hex) is mitigated by A2.1's explicit test).
- Cross-boundary tasks: none — KARMA team owns keystore, service, plugin, pipeline, firewall end-to-end.
- Integration-test surface: A2.2 (confirm pipeline error-path semantics via existing
  `idempotency.test.ts` + `execution_lock.test.ts` in the full run).
- Watch in review (3 MEDIUM): A1.4 (no missed call site), A2.1 (redaction completeness), A2.2 (no
  control-flow regression in the outer try/catch).
</content>
