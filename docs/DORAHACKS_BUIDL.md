# DoraHacks BUIDL — APAC Stellar Hackathon

Copy-paste source for the submission page. Edit freely up to the deadline — this file
just keeps a versioned draft in the repo. (Restored + rewritten 2026-07-15 for the APAC
Stellar Hackathon's "real people, real problems, local anchors" rubric — an earlier
draft of this file existed for the original "Stellar Hacks: Real-World ZK" submission
and was lost in an unrelated cleanup commit; this version keeps everything that was
still true and adds the user-facing + local-anchor work done today.)

## Vision (≤256 chars, for DoraHacks' Vision field)

> A freelancer proves she's reliable, gets paid per job, and cashes out toward local
> currency — no platform in the middle. Reputation stays private (ZK), payment is
> instant (x402), cash-out is real (SEP-24) — on Stellar, live on Testnet today.

(248 characters.)

## Tagline (one line)

> Private reputation, instant pay, real local cash-out: a freelancer proves she's
> reliable without revealing her score, gets paid in USDC the moment work is confirmed,
> and opens a real SEP-24 withdrawal — all live on Stellar Testnet, no trusted server.

## Details field (paste directly into DoraHacks' Markdown editor)

```markdown
### A freelancer's trust, payment, and cash-out — proven live on Stellar

**She's never met the client.** She finishes a job, proves her track record clears the
bar for the next one — without revealing her score, her job history, or who she worked
for — gets paid in USDC the instant the work is confirmed, and starts a real cash-out
toward local currency. No platform sits between them taking a cut or holding the trust.
Every step below is live on Stellar Testnet today, not a mockup.

---

#### Step 1 — earn: a private credit history

A Groth16 proof (Circom, BN254) lets an agent prove "my reputation clears this skill's
threshold" without revealing the score, job history, or identity. Verified on-chain by
a Soroban contract using **Stellar's native BN254 host functions** (`env.crypto().bn254()`,
CAP-0074) — no software elliptic-curve fallback. An internal audit found two real
soundness gaps in the circuit/contract pair; both are fixed and disclosed, not hidden.

#### Step 2 — get paid: x402, one HTTP request

The agent signs a real USDC payment and attaches its ZK proof in the **same** HTTP
POST. The provider verifies and settles the payment on-chain, then verifies the proof
on-chain, before running the skill — no trusted server decides anything the chain
doesn't independently check. Two real transactions from one request:

| | |
|---|---|
| 💵 USDC payment settled on-chain | [`9880020b…`](https://stellar.expert/explorer/testnet/tx/9880020bb5354a167572c335c808c7cb4e5af65309ff6185ced3a4fd25d6c0ae) |
| 🔐 ZK proof verified on-chain | [`28d4917b…`](https://stellar.expert/explorer/testnet/tx/28d4917ba2192d8bf8a5a6004d392593df7e9e4639f9e2b23c0cf3503c4e153c) |

#### Step 3 — cash out: a real local anchor (SEP-24)

This is new since the original submission. `pnpm demo:stellar:anchor` runs the real
SEP-24 protocol against **`testanchor.stellar.org`** — Stellar's own public reference
anchor, not a stub we control: SEP-1 discovery → SEP-10 auth (real JWT, signed with the
agent's real Stellar keypair) → SEP-24 interactive withdrawal request → status poll.
We also opened the anchor's own hosted status page in a real browser and confirmed it
independently renders the same transaction — screenshot in the repo. Honest scope: the
interactive KYC step is anchor-hosted by SEP-24's own design, meant for a human to
click through — a script can't finish it server-side, and we say so rather than fake it.

#### Live contracts (Stellar Testnet)

| Contract | Address |
|---|---|
| `agent_credential_verifier` | [`CDBIDMG2…SATCJT4GTP`](https://stellar.expert/explorer/testnet/contract/CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP) |
| `reputation_aggregation_verifier` | [`CDR55NDI…54UA7SRMO`](https://stellar.expert/explorer/testnet/contract/CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO) |
| Local anchor cash-out | real SEP-24 handshake against `testanchor.stellar.org` (transaction `4599c222-ff80-4ec3-962f-fa9b51db9a08`) |

#### Not a hackathon-only claim — the same spec runs elsewhere, tested

KARMA is a protocol (`docs/standards/`) — `IPaymentPlugin v1` + a PR-governed
`IdentityPolicy` registry — with independent, tested reference implementations.
**Stellar and Casper are both v1.0 ✓ conformant**; Pharos is the chain the spec was
extracted from. Stellar's is the implementation with the deepest privacy story (native
ZK) and, as of today, the only one with a real local on/off-ramp integration.

| Chain | Role | Proof |
|---|---|---|
| **Stellar** | ZK privacy + native settlement + real local anchor | 2 verifiers live, 12+19 tests, one-HTTP-request x402+ZK flow live, real SEP-24 handshake |
| **Casper** | `IPaymentPlugin` v1.0 ✓ conformant, deepest economic kernel | 120 Rust tests, escrow + dispute + governance |
| **Pharos** | Original chain the spec was extracted from | Live contract, 96 Foundry tests |
| **Terminal3** | Reference `IdentityPolicy` implementation | Verified live against testnet |

#### Known limitations (we'd rather tell you than have you find them)

- **SEP-24 cash-out proves the protocol handshake, not a completed fiat withdrawal** —
  the interactive KYC step is anchor-hosted by design; a production wallet UI around it
  is the next step, not built today.
- **Onboarding is still self-custody-first.** Today's wallet is an encrypted keystore
  file. A real non-crypto-native user needs a custodial-lite or social-login wallet in
  front of it — near-term roadmap, disclosed rather than implied.
- The live ZK+x402 demo's nullifier is one-shot by design (that's the replay guard
  working) — reproducing it needs a fresh proof for a new skill id, documented in the repo.
- Trusted setup for both circuits is single-contributor (hackathon scope); mainnet
  would need a multi-party ceremony.
- The anchor's SEP-10 JWT is short-lived (~10 min) — found while testing, documented so
  the next integrator doesn't rediscover it the hard way.
```

*(Embed the video, the live-evidence GIF, and the new anchor status-page screenshot
using the editor's 🖼️/🎬 toolbar buttons — the "one HTTP request" and "real anchor
handshake" moments are the visual payoff.)*

## Links

- Repo: https://github.com/Eilodon/KARMA
- Judge walkthrough (live page): https://eilodon.github.io/KARMA/media/stellar-judges.html
- Judge walkthrough (repo doc): [`DEMO_STELLAR.md`](../DEMO_STELLAR.md)
- Protocol spec: [`docs/standards/IPaymentPlugin-v1.md`](../docs/standards/IPaymentPlugin-v1.md) ·
  [`docs/standards/reference-implementations.md`](../docs/standards/reference-implementations.md)
- Video: `docs/media/stellar-zk-demo.mp4` (~78s, narrated — the idea, the 2 soundness
  fixes, then the live one-HTTP-request x402+ZK flow running for real. Upload to
  YouTube unlisted or DoraHacks' native uploader, then paste the link here)
- Live-evidence GIF (same content, silent/looping): `docs/media/stellar-live-evidence.gif`
- Anchor status-page screenshot: `docs/media/stellar-anchor-txn-status.png`

## Tags / categories to select on the form

`Financial Inclusion`, `On/Off-Ramps`, `Payments & Disbursements`, `Zero-Knowledge`,
`Agentic Payments / x402`, `Wallets & Identity`, `Infrastructure`
