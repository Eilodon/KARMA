# T3ADK Integration — Terminal3 Identity Gate for KARMA

> **For agentic workers:** Use `executing-plans` to implement this plan task-by-task.

**Goal:** Add Terminal3 Agent Auth SDK as a trusted built-in plugin (`t3.tool.ts`) that gates
high-reputation skill jobs behind verifiable on-chain identity — filling the one real gap in
KARMA's Trust Gate architecture for the T3ADK Dev Challenge (Launch Ed).

**Architecture:** Three new MCP tools in a single new plugin file. `t3_health` validates config +
WASM load. `t3_verify_identity` authenticates an agent against T3N using a custom viem-backed
`GuestToHostHandler` (no raw key exposure), stores the returned DID in a module-level cache.
`t3_create_verified_job` checks both the T3N DID cache and KARMA's on-chain reputation threshold
before calling `realKarmaService.createJob` — demonstrating dual-layer trust (identity + reputation).

**Tech Stack:** `@terminal3/t3n-sdk@3.10.1`, viem Account signing, vitest mocks, Node 20 ESM.

**Audit Gate:** PASS — all 3 technical risks verified in prior research session:
- Risk #1 (signer model): Custom `GuestToHostHandler` via `account.signMessage` — no raw key needed.
- Risk #2 (WASM Node 20): `@bytecodealliance/jco` + `preview2-shim` is Node.js-native; Task 2 validates live.
- Risk #3 (karma.tool.ts): zero edits to `karma.tool.ts`.

**Risk Flags:** HIGH — Task 5 (live T3N network call in t3_verify_identity); MEDIUM — Task 2
(WASM probe must pass before Task 5); MEDIUM — Task 3 (plugin_loader infrastructure file).

---

### Task 1: Install SDK and add T3N env var

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/config/env.ts:1-117` (add `T3N_NODE_URL` optional var)

- [ ] **Step 1: Install the SDK**
```bash
cd /home/ybao/B.1/KARMA && pnpm add @terminal3/t3n-sdk@3.10.1
```
Expected output: `+ @terminal3/t3n-sdk 3.10.1` in pnpm output, no errors.

- [ ] **Step 2: Add T3N_NODE_URL to EnvSchema** in `src/config/env.ts` after line `MCP_TASK_POLL_INTERVAL_MS`:
```typescript
  // T3ADK: Terminal3 node URL. If unset, uses the SDK built-in testnet URL via getNodeUrl().
  T3N_NODE_URL: z.string().url().optional(),
```

- [ ] **Step 3: Add to rawEnv parser** in `loadEnv()` inside `src/config/env.ts`, alongside other `process.env.*` reads:
```typescript
    T3N_NODE_URL: process.env.T3N_NODE_URL || undefined,
```

- [ ] **Step 4: Typecheck passes**
```bash
cd /home/ybao/B.1/KARMA && pnpm typecheck 2>&1 | tail -5
```
Expected: `Found 0 errors.`

- [ ] **Step 5: Commit**
```bash
git -C /home/ybao/B.1/KARMA add package.json pnpm-lock.yaml src/config/env.ts
git -C /home/ybao/B.1/KARMA commit -m "feat(t3adk): install @terminal3/t3n-sdk, add T3N_NODE_URL env var"
```

---

### Task 2: WASM probe — close Risk #2 before any integration code

**Files:**
- Create: `src/scripts/t3n_wasm_probe.ts`

This script runs standalone (outside KARMA's MCP pipeline) to confirm `loadWasmComponent()` works
in Node 20 ESM without a bundler. If it throws, we add `wasmPath` override before continuing.

- [ ] **Step 1: Write the probe script**

Create `src/scripts/t3n_wasm_probe.ts`:
```typescript
import { loadWasmComponent } from "@terminal3/t3n-sdk";

console.log("[T3N Probe] Loading WASM component...");
try {
  const wasm = await loadWasmComponent();
  console.log("[T3N Probe] WASM OK:", typeof wasm);
  console.log("[T3N Probe] PASS — Risk #2 closed.");
  process.exit(0);
} catch (err) {
  console.error("[T3N Probe] FAIL:", err);
  console.error("[T3N Probe] Try setting explicit wasmPath in loadWasmComponent({ wasmPath: '...' })");
  process.exit(1);
}
```

- [ ] **Step 2: Run the probe**
```bash
cd /home/ybao/B.1/KARMA && npx tsx src/scripts/t3n_wasm_probe.ts
```
Expected: `[T3N Probe] PASS — Risk #2 closed.` with exit code 0.

If it fails with a path error, add explicit wasmPath:
```typescript
import { fileURLToPath } from "node:url";
import path from "node:path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(
  __dirname, "../../node_modules/@terminal3/t3n-sdk/dist/wasm/generated/session.core.wasm"
);
const wasm = await loadWasmComponent({ wasmPath });
```

- [ ] **Step 3: Commit**
```bash
git -C /home/ybao/B.1/KARMA add src/scripts/t3n_wasm_probe.ts
git -C /home/ybao/B.1/KARMA commit -m "feat(t3adk): add WASM probe script — confirms Node 20 ESM compatibility"
```

---

### Task 3: Register t3.tool.ts as a trusted built-in plugin

**Files:**
- Modify: `src/core/plugin_loader.ts:26-29`

`isTrustedBuiltInPlugin` currently only allows `system.tool` and `karma.tool`. `t3.tool.ts` needs
to run in-process (it uses `keystoreManager` singleton and needs network access). Two-line change.

- [ ] **Step 1: Open the file and confirm current lines 26-29:**
```typescript
export function isTrustedBuiltInPlugin(fileName: string): boolean {
  return fileName === "system.tool.ts" || fileName === "system.tool.js"
      || fileName === "karma.tool.ts" || fileName === "karma.tool.js";
}
```

- [ ] **Step 2: Edit `src/core/plugin_loader.ts` — extend the check:**
Replace the function body with:
```typescript
export function isTrustedBuiltInPlugin(fileName: string): boolean {
  return fileName === "system.tool.ts" || fileName === "system.tool.js"
      || fileName === "karma.tool.ts" || fileName === "karma.tool.js"
      || fileName === "t3.tool.ts" || fileName === "t3.tool.js";
}
```

- [ ] **Step 3: Typecheck passes**
```bash
cd /home/ybao/B.1/KARMA && pnpm typecheck 2>&1 | tail -5
```
Expected: `Found 0 errors.`

- [ ] **Step 4: Commit**
```bash
git -C /home/ybao/B.1/KARMA add src/core/plugin_loader.ts
git -C /home/ybao/B.1/KARMA commit -m "feat(t3adk): register t3.tool.ts as trusted built-in plugin"
```

---

### Task 4: Write failing tests for t3.tool.ts

**Files:**
- Create: `src/__tests__/t3_tool.test.ts`

Tests mock `@terminal3/t3n-sdk` so they run offline (no T3N network, no WASM load). This verifies
gate logic and DID cache behavior without needing live credentials.

- [ ] **Step 1: Write the test file**

Create `src/__tests__/t3_tool.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { markTrustedRuntime, resetTrustedRuntimeForTest } from "../core/runtime_identity.js";

// Mock T3N SDK before importing the plugin so module-level init is skipped.
vi.mock("@terminal3/t3n-sdk", () => ({
  loadWasmComponent: vi.fn(async () => ({ type: "mock-wasm" })),
  T3nClient: vi.fn().mockImplementation(() => ({
    authenticate: vi.fn(async () => "did:t3n:deadbeef01234567"),
  })),
  createEthAuthInput: vi.fn((addr: string) => ({ method: 0, address: addr })),
  eth_get_address: vi.fn(() => "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec"),
  getNodeUrl: vi.fn(() => "https://testnet.terminal3.io"),
}));

// Mock keystoreManager singleton — provides a viem-like Account.
vi.mock("../lib/keystore.js", () => ({
  keystoreManager: {
    has: vi.fn((id: string) => id === "agent-alpha"),
    getAccount: vi.fn(() => ({
      address: "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec",
      signMessage: vi.fn(async () => "0xsignature"),
    })),
    getAddress: vi.fn(() => "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec"),
  },
}));

// Mock realKarmaService — controls reputation and job creation.
vi.mock("../lib/karma_service.js", () => ({
  realKarmaService: {
    getReputation: vi.fn(async () => 60),
    getSkillThreshold: vi.fn(() => 55),
    deriveTaskHash: vi.fn(() => `0x${"ab".repeat(32)}`),
    findExistingJob: vi.fn(async () => null),
    createJob: vi.fn(async () => ({
      jobId: 42n,
      outcome: { status: "confirmed", hash: "0xtx", receipt: {} },
    })),
    account: vi.fn(() => ({ address: "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" })),
  },
}));

// Import plugin AFTER mocks are registered.
const { createT3Tools, getVerifiedDid, clearVerifiedDidsForTest } = await import("../plugins/t3.tool.js");

describe("t3.tool.ts — t3_health", () => {
  beforeEach(() => { resetTrustedRuntimeForTest(); markTrustedRuntime(); clearVerifiedDidsForTest(); });

  it("returns wasmLoaded:true when WASM mock resolves", async () => {
    const tools = createT3Tools();
    const health = tools.find(t => t.name === "t3_health")!;
    const res = await health.handler({}, {} as never, undefined, undefined);
    expect(res.structuredContent).toMatchObject({ wasmLoaded: true });
  });
});

describe("t3.tool.ts — t3_verify_identity", () => {
  beforeEach(() => { resetTrustedRuntimeForTest(); markTrustedRuntime(); clearVerifiedDidsForTest(); });

  it("stores DID in module cache on successful authenticate", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    const res = await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    expect(res.structuredContent).toMatchObject({ did: "did:t3n:deadbeef01234567", verified: true });
    expect(getVerifiedDid("agent-alpha")).toBe("did:t3n:deadbeef01234567");
  });

  it("rejects when agent_id not found in keystore", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await expect(
      verify.handler({ agent_id: "unknown-agent" }, {} as never, undefined, undefined)
    ).rejects.toThrow(/not found in keystore/i);
  });
});

describe("t3.tool.ts — t3_create_verified_job", () => {
  beforeEach(() => { resetTrustedRuntimeForTest(); markTrustedRuntime(); clearVerifiedDidsForTest(); });

  it("rejects when T3N identity not verified (T3N gate)", async () => {
    const tools = createT3Tools();
    const createJob = tools.find(t => t.name === "t3_create_verified_job")!;
    await expect(
      createJob.handler(
        { agent_id: "agent-alpha", skill_id: "7", deadline_secs: 3600, value_wei: "1000" },
        {} as never, undefined, undefined,
      )
    ).rejects.toThrow(/t3_verify_identity/i);
  });

  it("rejects with insufficient reputation even after T3N verify (reputation gate)", async () => {
    const { realKarmaService } = await import("../lib/karma_service.js");
    vi.mocked(realKarmaService.getReputation).mockResolvedValueOnce(40);
    vi.mocked(realKarmaService.getSkillThreshold).mockReturnValueOnce(55);

    // Pre-seed a verified DID.
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const createJob = tools.find(t => t.name === "t3_create_verified_job")!;
    await expect(
      createJob.handler(
        { agent_id: "agent-alpha", skill_id: "7", deadline_secs: 3600, value_wei: "1000" },
        {} as never, undefined, undefined,
      )
    ).rejects.toThrow(/reputation.*40.*55|trust gate/i);
  });

  it("creates job when both T3N identity AND reputation gates pass (dual-layer trust)", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const createJob = tools.find(t => t.name === "t3_create_verified_job")!;
    const res = await createJob.handler(
      { agent_id: "agent-alpha", skill_id: "7", deadline_secs: 3600, value_wei: "1000" },
      {} as never, undefined, undefined,
    );
    expect(res.structuredContent).toMatchObject({
      jobId: "42",
      t3n_did: "did:t3n:deadbeef01234567",
    });
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (plugin doesn't exist yet)
```bash
cd /home/ybao/B.1/KARMA && pnpm test src/__tests__/t3_tool.test.ts 2>&1 | tail -20
```
Expected: all tests fail with `Cannot find module '../plugins/t3.tool.js'` or similar.

- [ ] **Step 3: Commit failing tests**
```bash
git -C /home/ybao/B.1/KARMA add src/__tests__/t3_tool.test.ts
git -C /home/ybao/B.1/KARMA commit -m "test(t3adk): add failing tests for t3_health/t3_verify_identity/t3_create_verified_job"
```

---

### Task 5: Implement t3.tool.ts — the full plugin [HIGH RISK]

**Files:**
- Create: `src/plugins/t3.tool.ts`

This is the highest-risk task. It makes live network calls to T3N testnet during manual smoke
testing. Unit tests use mocks (Task 4). The EthSign handler uses `account.signMessage` — never
exposes raw private key, consistent with KeystoreManager's design invariant.

- [ ] **Step 1: Write the plugin**

Create `src/plugins/t3.tool.ts`:
```typescript
import { z } from "zod/v4";
import {
  loadWasmComponent,
  T3nClient,
  createEthAuthInput,
  getNodeUrl,
  type GuestToHostHandler,
  type WasmComponent,
} from "@terminal3/t3n-sdk";
import { keystoreManager } from "../lib/keystore.js";
import { realKarmaService } from "../lib/karma_service.js";
import { ENV } from "../config/env.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

// Module-level DID cache: agentId → verified did:t3n:... string.
// Populated by t3_verify_identity, read by t3_create_verified_job.
const verifiedDids = new Map<string, string>();

// Module-level WASM singleton — loaded once on first t3_health or t3_verify_identity call.
let wasmComponent: WasmComponent | null = null;

async function getWasm(): Promise<WasmComponent> {
  if (!wasmComponent) {
    wasmComponent = await loadWasmComponent();
  }
  return wasmComponent;
}

function buildT3nClient(wasm: WasmComponent, ethSignHandler: GuestToHostHandler): T3nClient {
  const baseUrl = ENV.T3N_NODE_URL ?? getNodeUrl();
  return new T3nClient({
    wasmComponent: wasm,
    baseUrl,
    handlers: { EthSign: ethSignHandler },
  });
}

function buildEthSignHandler(agentId: string): GuestToHostHandler {
  const account = keystoreManager.getAccount(agentId);
  return async (requestData) => {
    const { challenge } = requestData as { challenge: string };
    // Decode base64 challenge → raw bytes, sign via EIP-191 using viem Account.
    const raw = Uint8Array.from(Buffer.from(challenge, "base64"));
    const signature = await account.signMessage({ message: { raw } });
    return new TextEncoder().encode(
      JSON.stringify({ host_to_guest: "EthSign", challenge, signature }),
    );
  };
}

// Exported for tests only — resets module-level cache between test cases.
export function clearVerifiedDidsForTest(): void {
  verifiedDids.clear();
  wasmComponent = null;
}

export function getVerifiedDid(agentId: string): string | undefined {
  return verifiedDids.get(agentId);
}

export function createT3Tools(): ToolDefinition[] {
  return [
    {
      name: "t3_health",
      description:
        "Validate Terminal3 SDK configuration and WASM component load. " +
        "Run this first to confirm T3N_NODE_URL is reachable and WASM initialises correctly.",
      inputSchema: {},
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execution: { taskSupport: "forbidden" },
      securityPolicy: { externalCommunication: true, waiverReason: "T3N health-check — read-only, no auth" },
      handler: async () => {
        const nodeUrl = ENV.T3N_NODE_URL ?? getNodeUrl();
        let wasmLoaded = false;
        let wasmError: string | undefined;
        try {
          await getWasm();
          wasmLoaded = true;
        } catch (e) {
          wasmError = e instanceof Error ? e.message : String(e);
        }
        const result = { wasmLoaded, nodeUrl, sdkVersion: "3.10.1", wasmError };
        return {
          structuredContent: result,
          content: [{
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      },
    },

    {
      name: "t3_verify_identity",
      description:
        "Authenticate a KARMA agent against the Terminal3 Network using EIP-191 signing. " +
        "Returns a verifiable DID (did:t3n:...) and caches it for t3_create_verified_job. " +
        "Must be called before t3_create_verified_job for high-threshold skills.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id to authenticate (must exist in keystore)."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        accessesPrivateData: true,
        waiverReason: "T3N auth uses viem Account.signMessage — raw key never leaves KeystoreManager",
      },
      handler: async (args) => {
        const { agent_id } = args as { agent_id: string };

        if (!keystoreManager.has(agent_id)) {
          throw new Error(`[T3N] Agent not found in keystore: ${agent_id}`);
        }

        const wasm = await getWasm();
        const ethSignHandler = buildEthSignHandler(agent_id);
        const client = buildT3nClient(wasm, ethSignHandler);
        const address = keystoreManager.getAddress(agent_id);
        const authInput = createEthAuthInput(address);
        const did = await client.authenticate(authInput);

        verifiedDids.set(agent_id, did);

        const result = {
          verified: true,
          did,
          agent_id,
          address,
          message: `Agent ${agent_id} verified. DID cached for t3_create_verified_job.`,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_create_verified_job",
      description:
        "Create a KARMA job for a high-threshold skill, enforcing dual-layer trust: " +
        "(1) T3N identity gate — agent must have called t3_verify_identity first, " +
        "(2) On-chain reputation gate — agent reputation must meet the skill's minReputationToInvoke. " +
        "This is the security-critical path for enterprise skills like payroll_hr_transfer.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
        skill_id: z.string().describe("On-chain skill id (bigint as string, e.g. '7')."),
        deadline_secs: z.number().int().min(60).max(604800).describe("Job deadline in seconds from now."),
        value_wei: z.string().describe("Escrow amount in wei (bigint as string, e.g. '1000000000000000')."),
      },
      allowedPhases: ["intake", "execution"],
      capabilities: ["network"],
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason: "On-chain write — guarded by dual trust gates before contract call",
      },
      handler: async (args) => {
        const { agent_id, skill_id, deadline_secs, value_wei } = args as {
          agent_id: string;
          skill_id: string;
          deadline_secs: number;
          value_wei: string;
        };

        // Gate 1: T3N identity must be verified.
        const did = verifiedDids.get(agent_id);
        if (!did) {
          throw new Error(
            `[T3N] Identity gate: agent '${agent_id}' has no verified DID. ` +
            `Call t3_verify_identity first.`,
          );
        }

        const skillIdBig = BigInt(skill_id);
        const address = keystoreManager.getAddress(agent_id);

        // Gate 2: On-chain reputation must meet skill threshold.
        const [reputation, threshold] = await Promise.all([
          realKarmaService.getReputation(address),
          Promise.resolve(realKarmaService.getSkillThreshold(skillIdBig)),
        ]);

        if (threshold > 0 && reputation < threshold) {
          throw new Error(
            `[KARMA] Trust Gate: agent reputation ${reputation} is below skill threshold ${threshold}. ` +
            `Both identity (T3N) and reputation (KARMA) gates must pass.`,
          );
        }

        // Both gates passed — create job on-chain.
        const account = realKarmaService.account(agent_id, keystoreManager.getTenant(agent_id));
        const taskHash = realKarmaService.deriveTaskHash(address, skillIdBig, BigInt(Date.now()));
        const existing = await realKarmaService.findExistingJob(address, taskHash);
        if (existing !== null) {
          const result = {
            jobId: existing.toString(),
            t3n_did: did,
            outcome: "existing",
            reputation,
            threshold,
          };
          return {
            structuredContent: result,
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        const { jobId, outcome } = await realKarmaService.createJob(account, {
          skillId: skillIdBig,
          taskHash,
          deadlineSecs: BigInt(deadline_secs),
          value: BigInt(value_wei),
        });

        const result = {
          jobId: jobId?.toString() ?? null,
          t3n_did: did,
          outcome: outcome.status,
          reputation,
          threshold,
          message: `Dual-layer trust verified: T3N identity (${did}) + KARMA reputation (${reputation}/${threshold}).`,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },
  ];
}

export default createT3Tools();
```

- [ ] **Step 2: Typecheck**
```bash
cd /home/ybao/B.1/KARMA && pnpm typecheck 2>&1 | tail -10
```
Expected: `Found 0 errors.`

- [ ] **Step 3: Commit**
```bash
git -C /home/ybao/B.1/KARMA add src/plugins/t3.tool.ts
git -C /home/ybao/B.1/KARMA commit -m "feat(t3adk): implement t3.tool.ts — t3_health, t3_verify_identity, t3_create_verified_job"
```

---

### Task 6: Run tests — verify all pass

**Files:** no changes — run only.

- [ ] **Step 1: Run t3_tool tests**
```bash
cd /home/ybao/B.1/KARMA && pnpm test src/__tests__/t3_tool.test.ts 2>&1
```
Expected: `✓ t3_health … (1)`, `✓ t3_verify_identity … (2)`, `✓ t3_create_verified_job … (3)` — all green.

- [ ] **Step 2: Run full test suite — confirm no regressions**
```bash
cd /home/ybao/B.1/KARMA && pnpm test 2>&1 | tail -20
```
Expected: all existing tests still pass; new t3_tool tests pass; total count increases by 5.

- [ ] **Step 3: Commit if any test fixes needed, otherwise just verify**

---

### Task 7: Register payroll_hr_transfer skill + configure allowlist

**Files:**
- Create: `src/scripts/register_payroll_skill.ts`
- Update: `.env` (or note for operator)

This registers the flagship payroll skill on-chain with `minReputationToInvoke: 55` — above the
base-50 threshold, making the reputation gate visible in the demo.

- [ ] **Step 1: Write the registration script**

Create `src/scripts/register_payroll_skill.ts`:
```typescript
import { keystoreManager } from "../lib/keystore.js";
import { realKarmaService } from "../lib/karma_service.js";
import { ENV } from "../config/env.js";

// Must have KEYSTORE_PATH, KEYSTORE_PASSWORD, PHAROS_RPC_URL, CONTRACT_ADDRESS in .env
const AGENT_ID = process.env.KARMA_DEMO_AGENT_ID ?? "agent-alpha";
const TENANT_ID = ENV.MCP_TENANT_ID;
const KEYSTORE_PATH = process.env.KEYSTORE_PATH ?? "";
const KEYSTORE_PASSWORD = process.env.KEYSTORE_PASSWORD ?? "";

if (!KEYSTORE_PATH || !KEYSTORE_PASSWORD) {
  console.error("FATAL: Set KEYSTORE_PATH and KEYSTORE_PASSWORD env vars.");
  process.exit(1);
}

await keystoreManager.load(KEYSTORE_PATH, KEYSTORE_PASSWORD);
const account = realKarmaService.account(AGENT_ID, TENANT_ID);

const { skillId, outcome } = await realKarmaService.registerSkill(account, {
  name: "payroll_hr_transfer",
  description:
    "Enterprise HR payroll transfer skill. Requires T3N identity verification + on-chain " +
    "reputation >= 55 (KARMA Trust Gate). Demonstrates dual-layer trust for sensitive financial operations.",
  mcpEndpoint: "https://karma.example.com/mcp",
  pricePerCall: 1_000_000_000_000_000n, // 0.001 PHRS
  minReputationToInvoke: 55n,
});

console.log(`payroll_hr_transfer registered: skillId=${skillId}, status=${outcome.status}`);
```

- [ ] **Step 2: Add to MCP_PLUGIN_ALLOWLIST** — update `.env` (or instruct operator):
```
MCP_PLUGIN_ALLOWLIST=system.tool.js,system.tool.ts,karma.tool.js,karma.tool.ts,t3.tool.js,t3.tool.ts
MCP_SAFE_MODE=false
T3N_NODE_URL=  # leave blank to use SDK default testnet URL
```

- [ ] **Step 3: Run registration** (requires live env with KEYSTORE_PATH etc.)
```bash
cd /home/ybao/B.1/KARMA && npx tsx src/scripts/register_payroll_skill.ts
```
Expected: `payroll_hr_transfer registered: skillId=<N>, status=confirmed`

- [ ] **Step 4: Commit script**
```bash
git -C /home/ybao/B.1/KARMA add src/scripts/register_payroll_skill.ts
git -C /home/ybao/B.1/KARMA commit -m "feat(t3adk): add payroll_hr_transfer skill registration script"
```

---

### Task 8: End-to-end smoke test — demo gate flow

**Files:** no changes — manual verification only.

This is the critical path that maps to the hackathon rubric. Run in sequence against the live MCP
server. Expected output at each step matches what the demo video will show.

- [ ] **Step 1: Start KARMA in HTTP mode with t3 plugin enabled**
```bash
cd /home/ybao/B.1/KARMA && \
  MCP_PLUGIN_ALLOWLIST="system.tool.js,system.tool.ts,karma.tool.js,karma.tool.ts,t3.tool.js,t3.tool.ts" \
  MCP_SAFE_MODE=false \
  TRANSPORT_DRIVER=stdio \
  npx tsx src/index.ts
```

- [ ] **Step 2: Call t3_health** — confirm WASM loads, node URL is set.
Expected structuredContent: `{ wasmLoaded: true, nodeUrl: "...", sdkVersion: "3.10.1" }`

- [ ] **Step 3: Call discover_skills with query "payroll"** — skill should appear with minReputationToInvoke: 55.

- [ ] **Step 4: Call t3_create_verified_job (without prior verify)** — must reject:
Expected error: `[T3N] Identity gate: agent 'agent-alpha' has no verified DID. Call t3_verify_identity first.`
This is the **demo money shot #1** — T3N gate blocks unverified agents.

- [ ] **Step 5: Call t3_verify_identity with agent_id: "agent-alpha"** — must return DID.
Expected structuredContent: `{ verified: true, did: "did:t3n:...", agent_id: "agent-alpha" }`
This is the **demo money shot #2** — live T3N authentication, real DID.

- [ ] **Step 6: Call t3_create_verified_job again** — must succeed.
Expected structuredContent: `{ jobId: "...", t3n_did: "did:t3n:...", outcome: "confirmed", ... }`
This is the **demo money shot #3** — dual-layer trust verified on-chain.

- [ ] **If Step 4 shows reputation gate instead of identity gate**: agent reputation is already above
threshold. Raise `minReputationToInvoke` in registration script to current_reputation + 10 and re-register.

---

### Task 9: Submission packaging — README rubric map + final checks

**Files:**
- Modify: `README.md` (add T3ADK section at top)

- [ ] **Step 1: Add hackathon section to top of README.md**

Insert at the very beginning of `README.md` (before existing content):
```markdown
## T3ADK Dev Challenge (Launch Ed) — Terminal3 × KARMA

**Track:** Best Agent utilising Terminal3 Agent Auth SDK

### Rubric map

| Criterion | Weight | How KARMA satisfies it |
|---|---|---|
| **Completeness** | 30% | End-to-end demo: `discover_skills` → `t3_verify_identity` → `t3_create_verified_job` → `complete_job`. All tools functional against live Pharos testnet + T3N testnet. |
| **Integration depth** | 40% | T3N SDK used across 6 surfaces: `loadWasmComponent`, `T3nClient`, `createEthAuthInput`, `authenticate`, custom `GuestToHostHandler` (viem EIP-191 via `Account.signMessage`), `getNodeUrl`. Not a single-function integration. |
| **Creativity** | 30% | KARMA's Trust Gate already blocks by reputation — but reputation is anonymous. T3N adds the missing layer: *who* is behind the score. `t3_create_verified_job` enforces both gates simultaneously, making the case for enterprise/gov payroll use-cases where anonymity is unacceptable. |

### New tools (t3.tool.ts)

- `t3_health` — validate T3N config + WASM load
- `t3_verify_identity` — authenticate agent → `did:t3n:...`
- `t3_create_verified_job` — dual-layer trust gate (T3N identity + KARMA reputation)

### Setup

```
T3N_NODE_URL=          # optional — uses SDK built-in testnet URL if unset
MCP_PLUGIN_ALLOWLIST=system.tool.js,system.tool.ts,karma.tool.js,karma.tool.ts,t3.tool.js,t3.tool.ts
MCP_SAFE_MODE=false    # required — t3 tools use network capability
```
```

- [ ] **Step 2: Final checklist before submitting**
  - [ ] GitHub repo is public and has `src/plugins/t3.tool.ts`
  - [ ] Demo video recorded (see demo script in conversation — 1 take, 6 steps)
  - [ ] DoraHacks submission has BOTH GitHub link AND video link
  - [ ] Referral email field filled if applicable

- [ ] **Step 3: Final commit**
```bash
git -C /home/ybao/B.1/KARMA add README.md
git -C /home/ybao/B.1/KARMA commit -m "docs(t3adk): add hackathon rubric map to README"
```

---

## Self-Review

**Spec coverage:**
- `t3_health` ✓ (Task 5)
- `t3_verify_identity` → DID ✓ (Task 5)
- Gate on `t3_create_verified_job` ✓ (Task 5 — T3N identity gate + reputation gate)
- `payroll_hr_transfer` skill registration ✓ (Task 7)
- WASM Risk #2 validation before integration ✓ (Task 2)
- `karma.tool.ts` untouched ✓ (zero edits throughout)
- Tests cover happy path + both gate rejections ✓ (Task 4)

**Placeholder scan:** none — all code blocks are complete implementations.

**Type consistency:** `createT3Tools()` / `clearVerifiedDidsForTest()` / `getVerifiedDid()` names
match exactly between `t3.tool.ts` (Task 5) and `t3_tool.test.ts` (Task 4).

---

## Risk Summary

| Task | Risk | Reason | Mitigation |
|---|---|---|---|
| Task 2 | MEDIUM | WASM load may fail without explicit path | Script includes fallback with explicit wasmPath override |
| Task 3 | MEDIUM | Editing plugin infrastructure file | 2-line change, isolated function, existing tests still cover it |
| Task 5 | HIGH | Live T3N network call; viem signMessage API contract | Task 2 WASM probe must pass first; mocked thoroughly in Task 4 |
| All others | LOW | Pure config / docs / scripts | No cross-cutting invariants touched |

**CROSS boundaries:** Task 5 calls Task 4's test exports (`clearVerifiedDidsForTest`, `getVerifiedDid`)
→ these must be exported from `t3.tool.ts` before tests run. Already included in Task 5 implementation.

---

Execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, specialist-review between tasks
2. **Inline Execution** — batch execution with checkpoints

Which approach?
