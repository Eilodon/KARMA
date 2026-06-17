# KARMA Skill-Economy — Live Demo (Pharos Atlantic)

A self-referential demo: **Agent Alpha registers the `discover_skills` tool itself as a paid
skill**, Agent Beta escrows a job for it, Alpha delivers, Beta confirms (releasing escrow and
bumping reputation), and Alpha withdraws the payout. Every step runs through the real KARMA tool
handlers → `realKarmaService` → on-chain `AgentSkillRegistry`, so it exercises the full stack.

## Deployment

| Item | Value |
|---|---|
| Network | Pharos Atlantic (chainId **688689**, EIP-1559) |
| Contract | [`0xc6d5c146209e0833634bd33fafb9e65081b905ae`](https://atlantic.pharosscan.xyz/address/0xc6d5c146209e0833634bd33fafb9e65081b905ae) |
| Deploy tx | [`0x8615c1ce…0cea8c`](https://atlantic.pharosscan.xyz/tx/0x8615c1ce7664913370c341af4342e4f27ffa9dbc3a02d65b8a89d044e10cea8c) (block 24283311, gas 1,462,073) |
| Agent Alpha | `0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec` (provider) |
| Agent Beta | `0x00d5f57009279aB0195264Fa2160F43055deD938` (requester) |

## Transactions (one full economic loop)

| Step | Tool | Tx |
|---|---|---|
| 1. Register skill #1 | `register_skill` | [`0xeac061de…6c8d03`](https://atlantic.pharosscan.xyz/tx/0xeac061de15466218c6694bf778aaaee1088736110a1bdd11da978238166c8d03) |
| 2. Escrow job #1 (0.0001 PHRS) | `create_job` | [`0xc7707743…2ccb321`](https://atlantic.pharosscan.xyz/tx/0xc770774305492d06bacd8a8a2ec82ccbab7ee14ac37dd76c73621328b2ccb321) |
| 3. Deliver result | `deliver_result` | [`0xf6f04c93…0fc43d4`](https://atlantic.pharosscan.xyz/tx/0xf6f04c93001bd8570f4018b70d6c1264338e2461f8fcdb68b17f5db110fc43d4) |
| 4. Confirm completion | `complete_job` | [`0xb074f5fe…fc134b8`](https://atlantic.pharosscan.xyz/tx/0xb074f5fe5f52c55154a5516bc4a2f06df20df2d08606df71a849ef7a8fc134b8) |
| 5. Withdraw payout | `withdraw` | [`0x424aaa72…e24237`](https://atlantic.pharosscan.xyz/tx/0x424aaa722eb505d31cab47b394cda29f767fd4faf98597fab985b443b7e24237) |

## On-chain state after the loop (verified, read-only)

```
ALPHA reputation: skill #1 "discover_skills" reputation=55 totalInvocations=1 active=true
BETA social graph: asRequester=[1] asProvider=[]
ALPHA social graph: asProvider=[1] asRequester=[]
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
PHAROS_CONTRACT_ADDRESS=0x... KEYSTORE_PASSWORD=... pnpm demo
PHAROS_CONTRACT_ADDRESS=0x... KEYSTORE_PASSWORD=... pnpm demo:verify
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

The economic loop runs on a hardened MCP server. Exercised/asserted by the 323-test suite:

- **Exactly-once** `create_job` (on-chain `taskHash` dedup; proven live in the demo).
- **Bounded writes** — single broadcast + pending-safe receipt wait that never double-spends.
- **`smcp:v4:kms` crypto-erasure** — KMS-backed per-tenant DEK across Vault / AWS-KMS / GCP-KMS,
  two-phase `scheduleErasure`, with an in-process keystore (private keys never leave the runtime).
- **Output firewall**, JSON-Schema 2020-12 validation, rate limiting, tenant execution locks,
  and JWT/OIDC resource-server auth.
