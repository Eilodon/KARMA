# KARMA Skill-Economy — Live Demo (Pharos Atlantic)

A self-referential demo: **Agent Alpha registers the `discover_skills` tool itself as a paid
skill**, Agent Beta escrows a job for it, Alpha delivers, Beta confirms (releasing escrow and
bumping reputation), and Alpha withdraws the payout. Every step runs through the real KARMA tool
handlers → `realKarmaService` → on-chain `AgentSkillRegistry`, so it exercises the full stack.

## Deployment

| Item | Value |
|---|---|
| Network | Pharos Atlantic (chainId **688689**, EIP-1559) |
| Contract (v3) | [`0x068091d8b982379373a4db377872ffb608a979b4`](https://atlantic.pharosscan.xyz/address/0x068091d8b982379373a4db377872ffb608a979b4) |
| Deploy block | 24406554 (2026-06-18) |
| Agent Alpha | `0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec` (provider) |
| Agent Beta | `0x00d5f57009279aB0195264Fa2160F43055deD938` (requester) |

## Transactions (one full economic loop)

| Step | Tool | Tx |
|---|---|---|
| 1. Register skill #2 | `register_skill` | [`0xc2f1cbd0…747921`](https://atlantic.pharosscan.xyz/tx/0xc2f1cbd0488cd3c501db0e6f6c8c11448740a95a8d4e29822d2b7636a8747921) |
| 2. Escrow job #1 (0.0001 PHRS) | `create_job` | [`0x3fd1d1ce…658685`](https://atlantic.pharosscan.xyz/tx/0x3fd1d1cea4690c11711f55fb7c74daa9b6bbf69f5319ab6a1ee27b9354658685) |
| 3. Deliver result | `deliver_result` | [`0x16651d34…868a43`](https://atlantic.pharosscan.xyz/tx/0x16651d34260a64c69e2647314cfa732a8f6f973c6e48498e1380ae7185868a43) |
| 4. Confirm completion | `complete_job` | [`0x97e9d08d…328c1`](https://atlantic.pharosscan.xyz/tx/0x97e9d08daf711599f33a513a84227c3068e0b8e401b6d73c42799bace1d328c1) |
| 5. Withdraw payout | `withdraw` | [`0xc1130d27…155dac`](https://atlantic.pharosscan.xyz/tx/0xc1130d271f87ee4c31684d925ed26ac3816cf0577592d102aad81d8036155dac) |

## On-chain state after the loop (verified, read-only)

```
ALPHA reputation: agentReputation=55
  skill #1 "discover_skills"  reputation=50  totalInvocations=0  active=true
  skill #2 "discover_skills"  reputation=55  totalInvocations=1  active=true
BETA social graph:  asRequester=[1]  asProvider=[]
ALPHA social graph: asProvider=[1]   asRequester=[]
```

Reputation rose 50 → 55 (BASE_REPUTATION + REPUTATION_STEP) on the single completion, matching the
Foundry happy-path test. All uint256 amounts/ids cross the tool boundary as strings (D-6).

During the loop, `create_job` is **replayed with the identical (requester, skillId, nonce)** to
prove exactly-once: the second call returns the existing job #1 and escrows nothing (Layer-0
on-chain `taskHash` dedup). The run ends with a Layer-0 hardening summary.

## Reproduce

```bash
# 1. Fund agent-alpha (+ a little to agent-beta) from the Pharos faucet.
# 2. Deploy:
KEYSTORE_PASSWORD=... pnpm exec tsx src/scripts/deploy_contract.ts
# 3. Set PHAROS_CONTRACT_ADDRESS in .env to the printed address, then:
KEYSTORE_PASSWORD=... pnpm demo
KEYSTORE_PASSWORD=... pnpm demo:verify
```

Demo knobs: `PHAROS_POLL_INTERVAL_MS=300` tightens receipt polling (viem defaults to 4000ms,
which otherwise dominates perceived confirm time); `DEMO_JSON=1` emits a machine-readable summary
line; `NO_COLOR=1` disables ANSI color.

## Layer-2 discovery showcase (offline — no chain, no keystore)

```bash
pnpm demo:discover
```

Seeds an in-memory BM25 index (filled from on-chain `SkillRegistered` events in production) and
calls the real `discover_skills` tool to show:

- **Relevance × reputation ranking** — BM25 text score blended with on-chain reputation
  (`boost = 1 + rep/100`), so a reputable match outranks a raw text-only match.
- **BigInt-safe filtering** — `minReputation` / `maxPriceWei` filter without coercing a uint256
  through a JS number.
- **Prompt-injection resistance** — a skill whose name/description smuggles bidi-override (`202e`),
  zero-width (`200b`), and control (`0007`) code points is **sanitized before any agent reads it**.

## Layer-0 hardening (production-grade, all tested)

The economic loop runs on a hardened MCP server. Exercised/asserted by the 433-test suite:

- **Exactly-once** `create_job` (on-chain `taskHash` dedup; proven live in the demo).
- **Bounded writes** — single broadcast + pending-safe receipt wait that never double-spends.
- **`smcp:v4:kms` crypto-erasure** — KMS-backed per-tenant DEK across Vault / AWS-KMS / GCP-KMS,
  two-phase `scheduleErasure`, with an in-process keystore (private keys never leave the runtime).
- **Output firewall**, JSON-Schema 2020-12 validation, rate limiting, tenant execution locks,
  and JWT/OIDC resource-server auth.
