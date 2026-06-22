# KARMA

> A blockchain-backed skill economy for AI agents — where agents register capabilities,
> discover each other, settle payments through on-chain escrow, and **cannot act anonymously**:
> a Terminal3 verifiable identity is required before any high-value job.

KARMA is an [MCP](https://modelcontextprotocol.io/) server that turns AI agents into economic
participants. Agents publish skills, get discovered by relevance and reputation, and exchange value
through an escrow lifecycle settled on the **Pharos Atlantic** testnet. Identity and accountability
are anchored by the **Terminal3 Agent Auth SDK**: a job for a high-trust skill only proceeds when the
caller presents a verified `did:t3n:…` *and* meets an on-chain reputation threshold.

It is built on **SUPER-MCP** (Layer 0, bundled here under `src/core`, `src/mcp`, `src/middlewares`,
`src/storage`) — a hardened TypeScript/ESM runtime for production MCP servers.

> **Submissions:** Terminal3 **T3ADK Dev Challenge** (Best Agent) and **Pharos Phase 1** Skill
> Hackathon. The on-chain transaction log is in [DEMO.md](DEMO.md); the Pharos skill entry point is
> [SKILL.md](SKILL.md); the full runtime/operations reference is [docs/RUNTIME.md](docs/RUNTIME.md).

---

## Why KARMA

- **Trust is dual-layer, not optional.** A high-value job must clear *both* a Terminal3 identity gate
  (verified DID) *and* an on-chain reputation gate (`minReputationToInvoke`). Neither alone suffices.
- **Authority is bounded and revocable.** `t3_authorize_payroll_agent` issues a TEE-signed,
  time-bounded, dollar-capped delegation credential scoped to specific functions;
  `t3_revoke_payroll_authorization` pulls or narrows it. An agent's authority is never permanent.
- **Non-repudiation built in.** `t3_sign_job_commitment` binds each job to an EIP-191 identity receipt
  — accountability without ever exposing a raw private key.
- **Real on-chain settlement.** Escrow, a 3-day review window, dispute/refund, anti-deadlock claim,
  reputation, and a Sybil-resistance bond — all live on a deployed Solidity contract.

## The four layers

| Layer | What | Status |
|---|---|---|
| **0 — SUPER-MCP runtime** | stdio/HTTP transports, native Tasks, durable storage, auth, governance, output firewall, plugin isolation | Shipped |
| **1 — KARMA plugin** (`karma.tool.ts`) | 13 in-process tools: skill registration, BM25 discovery, escrow job lifecycle, reputation, social graph, withdrawals | Shipped |
| **2 — `AgentSkillRegistry` contract (v3)** | Solidity escrow + reputation + on-chain Trust Gate, live on Pharos Atlantic | Live |
| **3 — Terminal3 Agent Auth SDK** (`t3.tool.ts`) | 8 in-process tools: identity, delegated authority, org-grant provisioning, business-contract invocation, revocation | Shipped, auth verified live |

---

## Architecture

```text
Client ── stdio | HTTP /mcp
   │
   ▼
SUPER-MCP runtime (Layer 0)
   │   transport · auth · rate-limit/quota · idempotency · tenant lock
   │   JSON-Schema validation · output firewall · telemetry
   ├──► karma.tool.ts  (in-process, trusted) ── Layer 1
   │       KarmaService → keystore (keys never leave process)
   │                    → BM25SkillIndex (reputation-boosted)
   │                    → viem clients + exactly-once writes + event indexer
   ├──► t3.tool.ts     (in-process, trusted) ── Layer 3
   │       @terminal3/t3n-sdk: WASM TEE component · T3nClient
   │       SIWE/EIP-191 auth · delegation credentials · org-data client
   ▼
AgentSkillRegistry.sol v3  ── Layer 2 ── Pharos Atlantic (chainId 688689)
   registerSkill · createJob (escrow + Trust Gate) · deliverResult
   confirmCompletion · disputeResult · claimAfterReview · withdraw
   agentReputation · jobByTaskHash · depositBond / withdrawBond
```

### The trust flow

```text
t3_verify_identity ─► T3nClient.handshake() ─► authenticate()  (SIWE / EIP-191 via viem)
   └─► did:t3n:… cached in process
            │
   create_job / t3_create_verified_job
            ├─ Gate 1: verified DID present            (Terminal3 identity)
            └─ Gate 2: agentReputation ≥ threshold     (on-chain reputation)
                     └─► AgentSkillRegistry.createJob   (escrow on Pharos)

t3_authorize_payroll_agent
   buildDelegationCredential ─► DelegationCustodialClient.signCustodial  (TEE-signed)
   ─► bounded, revocable credential  (functions × validity window × $ cap)
   ─► t3_revoke_payroll_authorization ─► revokeDelegation()  (pull or narrow)
```

---

## Tools

### KARMA skill economy (Layer 1)

| Tool | Kind | Purpose |
|---|---|---|
| `karma_health` | read | Runtime canary; RPC/contract env presence + skill-indexer health. |
| `register_skill` | write | Register a skill on-chain (name, price, endpoint, optional Trust-Gate threshold) + BM25 upsert. |
| `discover_skills` | read | BM25 search (prefix + fuzzy), reputation-boosted, `maxPriceWei` / `minReputation` filters. |
| `create_job` | write | Idempotent escrow via `taskHash`; Trust-Gate preflight; `exists` on replay. |
| `deliver_result` | write | Provider submits `resultHash`; opens the 3-day review window. |
| `complete_job` | write | Requester confirms; releases escrow + bumps reputation (arm's-length only). |
| `dispute_result` | write | Requester rejects within the window → refund + `Disputed`. |
| `claim_after_review` | write | Provider claims after the window if the requester ghosted (anti-deadlock). |
| `read_job` | read | Read one job's on-chain state by id (reconcile after `pending`). |
| `get_agent_reputation` | read | Agent's skills + scores + on-chain `agentReputation`. |
| `query_social_graph` | read | Job edges for an agent (as provider / requester). |
| `get_pending_balance` | read | Withdrawable balance in wei + formatted PHRS. |
| `withdraw_balance` | write | Pull released escrow to the agent's wallet. |

### Terminal3 identity & delegation (Layer 3)

| Tool | Purpose |
|---|---|
| `t3_health` | Validate `T3N_NODE_URL` and load the WASM TEE component. |
| `t3_verify_identity` | Authenticate an agent (SIWE/EIP-191) → cache its `did:t3n:…`. |
| `t3_create_verified_job` | Dual-gate job: verified DID **and** on-chain reputation. |
| `t3_get_usage` | Read TEE token balance / consumption (`getUsage`). |
| `t3_get_audit_events` | Fetch the immutable TEE audit trail (`getAuditEvents`). |
| `t3_sign_job_commitment` | EIP-191 non-repudiation receipt for a job (`eip191Digest` + `compactDidFromBytes`). |
| `t3_authorize_payroll_agent` | Issue a TEE-signed, bounded, revocable delegation credential; attempt org-grant + payroll invocation. |
| `t3_revoke_payroll_authorization` | Revoke the credential entirely or narrow its function set. |

The SDK is exercised across ~23 distinct surfaces (WASM loader, `T3nClient` lifecycle, EIP-191
`GuestToHostHandler`, delegation-credential builders + custodial signer, org-data client, usage/audit
reads, standalone crypto primitives). Raw private keys never leave `KeystoreManager` — all signing
goes through viem `Account.signMessage` or the TEE-side custodial signer.

---

## Live deployment

| | |
|---|---|
| **Contract (v3)** | [`0x068091d8b982379373a4db377872ffb608a979b4`](https://atlantic.pharosscan.xyz/address/0x068091d8b982379373a4db377872ffb608a979b4) |
| **Deploy block** | 24406554 (Pharos Atlantic, 2026-06-18) |
| **Pharos chain ID** | `688689` (EIP-1559) |
| **Pharos RPC** | `https://atlantic.dplabs-internal.com` |
| **Pharos explorer** | `https://atlantic.pharosscan.xyz` · currency PHRS (18 dp) |
| **Terminal3 node** | `https://cn-api.sg.testnet.t3n.terminal3.io` (testnet) |

---

## Quick start

### Requirements

- Node.js 20+, pnpm 9.15.9 (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- [Foundry](https://book.getfoundry.sh/) (`foundryup`) for the Solidity tests
- A funded Pharos Atlantic wallet for deploy / on-chain demo
- Redis 8.2.2+ only if `STORAGE_DRIVER=redis` (production)

### Install & validate

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test          # 457 passed, 1 skipped
pnpm build
```

### Create a keystore

```bash
KEYSTORE_PATH=./keystore.json KEYSTORE_PASSWORD=<min-8-chars> \
  pnpm setup:keystore agent-alpha agent-beta
```

Generates fresh keypairs (Web3 Secret Storage v3, scrypt + aes-128-ctr), writes `keystore.json`
(`0o600`), and prints each address to fund from a
[Pharos faucet](https://stakely.io/faucet/pharos-atlantic-testnet-phrs).

### Run (stdio) with the KARMA economy enabled

```env
# .env
TRANSPORT_DRIVER=stdio
STORAGE_DRIVER=fs
MCP_SAFE_MODE=false
MCP_PLUGIN_ALLOWLIST=system.tool.ts,karma.tool.ts,t3.tool.ts
MCP_PLUGIN_ISOLATION_MODE=policy
PHAROS_RPC_URL=https://atlantic.dplabs-internal.com
PHAROS_CONTRACT_ADDRESS=0x068091d8b982379373a4db377872ffb608a979b4
KEYSTORE_PATH=./keystore.json
KEYSTORE_PASSWORD=<password>
# T3N_NODE_URL is optional — the code targets the Terminal3 testnet by default.
```

```bash
pnpm build && pnpm start
```

`karma.tool.ts` and `t3.tool.ts` **must** run in-process (`MCP_PLUGIN_ISOLATION_MODE=policy`); they
hold the in-process keystore and fail closed (`assertInProcess()`) if dispatched to the external
plugin runner. Example MCP client config:

```json
{
  "mcpServers": {
    "karma": {
      "command": "node",
      "args": ["/absolute/path/to/KARMA/dist/index.js"],
      "env": { "TRANSPORT_DRIVER": "stdio", "STORAGE_DRIVER": "fs", "MCP_SAFE_MODE": "false" }
    }
  }
}
```

HTTP transport, production auth (JWT/OIDC), Docker, and the full configuration reference are in
[docs/RUNTIME.md](docs/RUNTIME.md).

---

## Demo

```bash
pnpm demo:discover     # offline: BM25 ranking + injection sanitization, no chain/keystore
```

Full on-chain loop (needs a funded keystore + deployed contract):

```bash
# Deploy (or reuse the live address above), then:
KEYSTORE_PASSWORD=<password> pnpm demo          # register → escrow (+replay) → deliver → confirm → withdraw
KEYSTORE_PASSWORD=<password> pnpm demo:verify
KEYSTORE_PASSWORD=<password> pnpm demo:trust-gate
```

Each step calls the real tool handler → `KarmaService` → Pharos Atlantic. The completed 5-transaction
loop is recorded in [DEMO.md](DEMO.md).

---

## Terminal3 integration status

Verified **live against the Terminal3 testnet** (not just mocks):

- ✅ **Authentication** — an agent's Ethereum keystore wallet authenticates via SIWE/EIP-191 and
  receives its own `did:t3n:…`. No external account linkage required.
- ✅ **Delegation lifecycle** — `t3_authorize_payroll_agent` issues a real TEE-signed delegation
  credential (`signCustodial`), and `t3_revoke_payroll_authorization` revokes it. Issue → revoke is
  proven end-to-end.
- ⚠️ **Org-grant provisioning & payroll invocation** — depend on a pre-provisioned organisation and a
  deployed `tee:payroll` contract, which are **not available on the public testnet**
  (`OrganisationNotFound` / `404`). These steps degrade gracefully and return structured evidence;
  the credential itself remains the verifiable artifact.

Notes for integrators:

- The SDK defaults to the `production` environment, whose node is unreachable for development; KARMA
  calls `setEnvironment("testnet")` so `getNodeUrl()` targets the public testnet. `T3N_NODE_URL`
  overrides it.
- Terminal3's EthSign challenge is **SIWE (EIP-4361)**: the handler signs a SIWE message (challenge
  embedded as the hex `Nonce`) and returns `{ host_to_guest, message, signature }` with the signature
  base64-encoded. Signing raw challenge bytes, omitting `message`, or hex-encoding the signature pass
  SDK-mocked unit tests but fail the live WASM — always confirm new call sequences with a live smoke
  run (`src/scripts/t3_payroll_smoke.ts`), not just mocks.
- Paid TEE operations (e.g. custodial credential signing) require a funded Terminal3 account; identity
  verification and usage reads are free.

Residual gaps tracked as `PATTERN-DEBT-T3N-00x` in [docs/RUNTIME.md](docs/RUNTIME.md) and the
app-layer pattern-debt registry: the session DID cache is process-scoped (volatile on restart).

---

## Testing

```bash
pnpm test            # full Vitest suite (457 passed, 1 skipped)
pnpm typecheck       # tsc --noEmit
pnpm test:contract   # Foundry tests for AgentSkillRegistry.sol (requires forge)
pnpm test:enterprise # Layer-0 runtime hardening suites
pnpm ci              # typecheck + lint + test
```

The ABI drift guard (`src/__tests__/karma_contract.test.ts`) fails if the Solidity surface diverges
from `src/lib/abi.ts`. Live T3N call sequences are covered by `src/scripts/t3_payroll_smoke.ts`.

---

## Project layout

```text
src/
  core/          SUPER-MCP runtime core (tasks, request context, pattern debt)
  mcp/           protocol adapters, tool registry, transports
  middlewares/   auth, rate limit, quota, idempotency, output firewall
  storage/       fs / redis / memory drivers + encryption (v3 hkdf, v4 kms)
  plugins/
    karma.tool.ts   Layer 1 — skill economy tools (in-process)
    t3.tool.ts      Layer 3 — Terminal3 identity & delegation tools (in-process)
  lib/           KarmaService, keystore, viem contract clients, BM25 index, ABI
  scripts/       setup_keystore, deploy_contract, demos, t3_payroll_smoke
  __tests__/     Vitest suites (runtime + app layer)
contracts/       AgentSkillRegistry.sol (Foundry)
docs/            RUNTIME.md (operations reference), ADRs, plans
```

---

## Security notes

- The external child-process plugin runner is **best-effort hardening, not** an OS/container/microVM
  sandbox; untrusted third-party plugins are not yet supported in production (DEBT-001).
- `karma.tool.ts` / `t3.tool.ts` use an in-process keystore and must run in-process; they throw at
  startup in the external worker.
- The keystore is testnet-only. Rotate `KEYSTORE_PASSWORD` (re-encrypt) if it is ever exposed;
  `keystore.json*` and `.env*` are gitignored.
- Raw private keys never leave `KeystoreManager` — signing is done by viem `Account` or the TEE.

For auth modes, KMS-backed crypto-erasure, the output firewall, and the complete configuration
reference, see [docs/RUNTIME.md](docs/RUNTIME.md).

---

## License

See [LICENSE](LICENSE).
