# KARMA — Stellar ZK + x402 fast-lane demo

> APAC Stellar Hackathon submission — user-facing framing added 2026-07-15, on top of the
> original T8 deliverable of the internal stellar-casper-tracks build plan.

**The story, in one sentence:** a freelancer finishes a job for a client she's never met,
proves she's reliable without revealing who she worked for or what she scored, gets paid
the instant the client releases funds, and opens a real cash-out toward local currency —
no platform standing in the middle taking a cut or holding the trust.

**Short on time?** [Live walkthrough page](https://eilodon.github.io/KARMA/media/stellar-judges.html)
— the same story below, with a real captured terminal transcript and a screenshot of the
anchor's own status page, instead of a wall of markdown.

This document is what a judge or reproducer should follow to see that story working
end-to-end on Stellar Testnet, live: a ZK reputation proof + a USDC x402 payment,
delivered in **one HTTP request**, with no KARMA server in the invocation path.
**This is live, not aspirational** — see
[Reproducing the live x402 + ZK flow](#reproducing-the-live-x402--zk-flow) for the real
run: a real USDC settlement tx + a real on-chain proof verification, both from a single
client-side HTTP POST, and [Cashing out to local currency](#cashing-out-to-local-currency-sep-24)
for the real SEP-24 anchor handshake.

![Live Stellar Testnet terminal: real WASM fetch, real on-chain reads, a real replay attack rejected by two independently deployed Groth16/BN254 verifiers](docs/media/stellar-live-evidence.gif)

Every line above is a real command against Stellar Testnet, not scripted
output — regenerate it yourself with `docs/media/record-stellar-evidence.sh`.

**Narrated ~78s video** — the idea, the 2 soundness fixes, then the live
"one HTTP request" x402 + ZK flow running for real with a synced voiceover:
[`docs/media/stellar-zk-demo.mp4`](docs/media/stellar-zk-demo.mp4)
(regenerate: `docs/media/record-stellar-demo-video.sh` — narration via Edge
TTS, no API key needed).

## What this submission does (architecture)

```
Agent (client-side, off-chain)             Provider / Soroban verifier (on-chain)
───────────────────────────────            ────────────────────────────────────────
1. Generate AgentCredentialProof           1. Decode X-Reputation-Proof
   (Circom, Groth16 over BN254)               and call agent_credential_verifier
                                              (Soroban): Groth16 pairing check
                                              via native BN254 host functions
                                              (env.crypto().bn254(), CAP-0074)
2. Build x402 payment payload              2. Verify X-Payment-Receipt with the
   (USDC on Stellar Testnet, $0.01)           Coinbase x402 facilitator on Stellar
                                              → USDC moved at the same instant
3. Build HTTP request:                     3. Check X-Nullifier not yet used
     X-Reputation-Proof  (~2 KB)              (per-skill replay guard, on-chain)
     X-Payment-Receipt   (signed)
     X-Nullifier         (per-skill)
                                           4. If all pass: execute skill,
4. POST /invoke ────────────────────────►     return result. No KARMA server.
```

Closes two open architectural problems in KARMA's production trust model
(documented in [`README.md`](README.md) before we knew about this hackathon):

1. **Identity gate was server-enforced** because `did:t3n` cannot be verified
   on-chain. The ZK proof + Soroban verifier eliminate that centralization
   point — trust is now pure math.
2. **Payment was multi-step escrow only.** x402-on-Stellar adds a one-shot
   fast-lane that's still trustless (proof + payment together).

## Building blocks (everything in this repo)

| Layer | Path | Status |
|---|---|---|
| Circuit + Groth16 setup | [`circuits/`](circuits/) (T4) | `make credential` passes |
| Soroban verifier contract | [`contracts-soroban/agent_credential_verifier/`](contracts-soroban/agent_credential_verifier/) (T5) | `cargo test --features testutils` 12/12 — native BN254 host functions, no Arkworks, job-history-root pinning — **live on Testnet** |
| Portfolio credential verifier | [`contracts-soroban/reputation_aggregation_verifier/`](contracts-soroban/reputation_aggregation_verifier/) (T1.1) | `cargo test --features testutils` 19/19 — same native-BN254 path, epoch-root pinning — **live on Testnet** |
| Stellar ed25519 keypair derivation | [`src/lib/stellar/keypair.ts`](src/lib/stellar/keypair.ts) (T6) | 10/10 |
| x402Plugin/Stellar | [`src/plugins/x402_stellar.ts`](src/plugins/x402_stellar.ts) (T7) | 15/15 |
| Offline orchestration demo | [`src/scripts/demo_stellar_zk.ts`](src/scripts/demo_stellar_zk.ts) (T8) | runs end-to-end, payee is the real live-registered skill owner |
| **Live x402 + ZK demo (one HTTP request)** | [`src/scripts/demo_stellar_x402_live.ts`](src/scripts/demo_stellar_x402_live.ts) | **live** — real USDC settlement + real on-chain proof verification from one client POST |

## Quick start — offline orchestration (no Stellar credentials needed)

This shows the FULL DATA FLOW end-to-end without touching the live network.
A judge can run it in any clean clone of the repo:

```bash
# 1. Install JS deps
pnpm install --frozen-lockfile

# 2. Build the circuit + generate happy-path proof + verifying key (~2 min)
cd circuits && make credential && cd ..

# 3. Build the Soroban verifier WASM (cargo + wasm32v1-none target)
cd contracts-soroban/agent_credential_verifier
rustup target add wasm32v1-none
cargo build --target wasm32v1-none --release
cd ../..

# 4. Run the orchestration demo — prints public signals, x402 receipt, HTTP envelope
pnpm exec tsx src/scripts/demo_stellar_zk.ts
```

Expected output: public signals + an x402 PaymentReceipt + the HTTP request
envelope a provider would receive. The script's last line shows the agent's
derived Stellar G-address (deterministic from a fixture secp256k1 seed).

## Live run — Stellar Testnet ✅ confirmed live (2026-07-03, soundness-patched build)

`agent_credential_verifier` is deployed and has processed a real proof on
Stellar Testnet — not a simulation, not a local test. Verify independently:
`stellar contract fetch --id CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP --network testnet`
succeeds and returns the deployed WASM.

This is the **patched** build: the credential commitment binds the
reputation score (`Poseidon(credentialSecret, reputationScore)`) and
`create_job` pins `jobHistoryRoot` against an admin-published `set_skill_root`
call — see "Soundness fixes" below for what changed and why. An earlier,
unpatched deploy (`CBXH5QUD…MMIHUYOM`, 2026-07-02) exists on Testnet but is
superseded; don't cite it as current evidence.

| Step | Tx hash | stellar.expert |
|---|---|---|
| Upload WASM | `a38d27d9b7cbcc3ff14637f6d4bf76cf24264c0e9656312055fe3655e8aba0e7` | [tx](https://stellar.expert/explorer/testnet/tx/a38d27d9b7cbcc3ff14637f6d4bf76cf24264c0e9656312055fe3655e8aba0e7) |
| Create contract | `06c031eb6f7ba4552fdc45bd2b53191eaacefb35bf38b8d9d6860bed2964429e` | [contract](https://stellar.expert/explorer/testnet/contract/CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP) |
| `register_skill(skill_id=42, min_reputation=60)` | `3ca0c83b424eb99604e9d63a960ef89461cdf321d6536d167b7435f2004e66e0` | [tx](https://stellar.expert/explorer/testnet/tx/3ca0c83b424eb99604e9d63a960ef89461cdf321d6536d167b7435f2004e66e0) |
| `set_skill_root(skill_id=42, root=…)` — publishes the issuer's job-history root | `286d222d712e325ed9a22c2b75f97a4ae7f85517edce808e2669037037f0bad7` | [tx](https://stellar.expert/explorer/testnet/tx/286d222d712e325ed9a22c2b75f97a4ae7f85517edce808e2669037037f0bad7) |
| `create_job` — verifies a real Groth16 proof via `env.crypto().bn254().pairing_check`, checks the proof's `jobHistoryRoot` against the published root | `25dd392b7a8a9adfc804dfeb576309e2d1876103fd6645949310e7ea6db597a1` — `job_created`, `job_id=1` | [tx](https://stellar.expert/explorer/testnet/tx/25dd392b7a8a9adfc804dfeb576309e2d1876103fd6645949310e7ea6db597a1) |
| Replay same nullifier | reverts `Error(Contract, #5)` (`NullifierReused`) | *(no tx hash — the CLI simulates first and never submits a fee-bearing tx when simulation reverts; the revert is CLI-observable, not a mined transaction. Screenshot/terminal capture is the evidence here.)* |

Deployer/admin: `GDJZCSWUIR5YQAOGKV4EIYCXN2OA5FS6THMV3PTZNZHGC2N3UZUODOMK`.

### `reputation_aggregation_verifier` — also live ✅ (2026-07-03)

The sibling portfolio-credential contract is deployed too, with a real
`ReputationAggregationProof` submitted and verified:

| Step | Tx hash | stellar.expert |
|---|---|---|
| Upload WASM | `a039dabcf0990a5e66643799429e6756ef965f2a804daf36ebe8bb7d966ce686` | [tx](https://stellar.expert/explorer/testnet/tx/a039dabcf0990a5e66643799429e6756ef965f2a804daf36ebe8bb7d966ce686) |
| Create contract | `d04bc7d5a7262980474eab11ba6160d22e48b8ab1af0d714bd7e085338eaa591` | [contract](https://stellar.expert/explorer/testnet/contract/CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO) |
| `set_vkey(...)` | `bd64e9cc9bdac00d0c8d3ed224319f4516bfbebb8a78687940df84801f33abbe` | [tx](https://stellar.expert/explorer/testnet/tx/bd64e9cc9bdac00d0c8d3ed224319f4516bfbebb8a78687940df84801f33abbe) |
| `set_epoch_root(epoch_id=202606, root=…)` | `f47e2caea33c180861bc2976c8a7aab691e012c9629826f7c7de3cb2d5be7848` | [tx](https://stellar.expert/explorer/testnet/tx/f47e2caea33c180861bc2976c8a7aab691e012c9629826f7c7de3cb2d5be7848) |
| `submit_proof` — minAvgScore=80, minDistinctCategories=5, minJobs=10 | `c7b98766b9cf0d26bd0ae4180d317153974f7c8cb225344a4090ed6402613cd6` — `rep_agg_credential`, credential `#1` | [tx](https://stellar.expert/explorer/testnet/tx/c7b98766b9cf0d26bd0ae4180d317153974f7c8cb225344a4090ed6402613cd6) |
| Replay same nullifier | reverts `Error(Contract, #5)` (`NullifierReused`) | *(no tx hash — same simulate-then-reject CLI behavior as above)* |

Contract: `CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO`. Same
deployer/admin as above. Verify independently:
`stellar contract fetch --id CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO --network testnet`.
See `contracts-soroban/reputation_aggregation_verifier/README.md` for the
full deploy recipe (`set_vkey` + `set_epoch_root` + `submit_proof`, same
`pack-bn254.mjs` packing pattern as `agent_credential_verifier`).

Steps below are the reproduction recipe for `agent_credential_verifier` if
you want to redeploy or extend it.

> ⚠️ Needs funded Stellar testnet credentials + a wallet with a USDC
> trustline to reproduce from scratch.

A few gotchas hit during the real run that the recipe below has been updated
to reflect: the contract's constructor requires `--admin` (used the deployer
identity as admin); `set_skill_root` must be called before `create_job` for a
skill or it reverts `SkillRootNotSet`; `--x402_receipt` rejects an empty
string from the CLI (pass `00`, since this branch only stores the field and
doesn't validate its contents); `--public_inputs` must be decimal strings
(not the hex `pack-bn254.mjs` emits — convert via `BigInt(...)` first).

### Step 1 — Deploy the Soroban verifier

```bash
# Pre-req: stellar CLI installed (curl -fsSL https://soroban.stellar.org/install.sh | bash)
cd contracts-soroban/agent_credential_verifier
cargo build --target wasm32v1-none --release

stellar contract deploy \
  --wasm target/wasm32v1-none/release/agent_credential_verifier.wasm \
  --network testnet \
  --source-account $DEPLOYER_KEY \
  -- --admin $DEPLOYER_ADDRESS
# --admin is required by the constructor (not optional, despite older docs).

# Record the printed contract address as STELLAR_VERIFIER_CONTRACT in .env
```

### Step 2 — Register the skill with the verifying key

```bash
# Pack circuits/build/agent_credential/verification_key.json (snarkjs decimal-string
# coordinates) into the contract's native VerifyingKey shape — alpha/beta/gamma/delta as
# Bn254G1Affine/Bn254G2Affine (64/128-byte big-endian hex), ic as an array of hex strings.
# Fixed-width byte packing only, no EC-point re-serialization library needed (unlike the
# Arkworks-canonical format the verifier used before the CAP-0074 native-host-function
# migration — see contracts-soroban/agent_credential_verifier/README.md).
node circuits/scripts/pack-bn254.mjs \
  circuits/build/agent_credential/verification_key.json \
  circuits/build/agent_credential/happy.proof.json \
  circuits/build/agent_credential/happy.public.json \
  /tmp/agent_credential_packed.json
# -> { "vkey": {alpha, beta, gamma, delta, ic: [...]}, "proof": {a,b,c}, "public_inputs": [...] }

stellar contract invoke \
  --id $STELLAR_VERIFIER_CONTRACT \
  --source $DEPLOYER_KEY \
  --network testnet \
  -- register_skill \
  --skill_id 42 \
  --vkey "$(jq -c .vkey /tmp/agent_credential_packed.json)" \
  --min_reputation 60 \
  --price_per_call 100000 \
  --owner $PROVIDER_ADDRESS

# Publish the job-history root the proof's Merkle path was built against — create_job
# reverts SkillRootNotSet / JobHistoryRootMismatch without this.
stellar contract invoke \
  --id $STELLAR_VERIFIER_CONTRACT \
  --source $DEPLOYER_KEY \
  --network testnet \
  -- set_skill_root \
  --skill_id 42 \
  --root "$(jq -r '.public_inputs[4]' /tmp/agent_credential_packed.json)"
```

### Step 3 — Run the live demo (proof → x402 settle → Soroban verify)

```bash
# Fund agent-alpha's derived Stellar address (printed by step 0 of the offline demo)
# from the Stellar Lab faucet + establish a USDC trustline.

# Minimal direct call (skips the x402/provider-stub HTTP hop — proves the ZK leg alone):
# nullifier = public_inputs[2] from the same packed JSON; task_commitment is any 32-byte
# tag the caller picks to identify this job off-chain.
stellar contract invoke \
  --id $STELLAR_VERIFIER_CONTRACT \
  --source $PAYER_KEY \
  --network testnet \
  -- create_job \
  --payer $PAYER_ADDRESS \
  --skill_id 42 \
  --task_commitment 0000000000000000000000000000000000000000000000000000000000000000 \
  --proof "$(jq -c .proof /tmp/agent_credential_packed.json)" \
  --nullifier "$(jq -r '.public_inputs[2]' /tmp/agent_credential_packed.json)" \
  --public_inputs "$(jq -c '.public_inputs | map(. | if startswith("0x") then (. as $h | ($h[2:] | ascii_upcase)) else . end)' /tmp/agent_credential_packed.json)" \
  --x402_receipt "00"
# public_inputs must be decimal strings — pack-bn254.mjs emits hex, so convert
# each element with BigInt(x).toString() before passing (jq alone can't do
# arbitrary-precision hex->decimal; a one-line node/jq helper is simplest).
# --x402_receipt rejects an empty string from the CLI; "00" is accepted since
# this branch only stores the field and doesn't validate its contents.
# -> tx hash + emitted `job_created` event; re-running the same command reverts
#    with Error(Contract, #5) (NullifierReused) — the CLI simulates first and
#    will NOT submit a tx for a reverting call, so the replay guard shows up
#    as a CLI error, not a second tx hash.

# Full flow (proof + x402 payment in one HTTP request, no direct contract call from the
# client) is implemented and live — see src/scripts/demo_stellar_x402_live.ts and
# "Reproducing the live x402 + ZK flow" below instead of doing this step manually.
```

`pnpm exec tsx src/scripts/demo_stellar_zk.ts` already prints what each of these
HTTP+chain interactions looks like in raw form — the live mode just lets the
chain confirm them and produce the on-chain tx hashes (see the confirmed
table above).

## What's verified by the on-chain side

Confirmed on **Stellar Testnet** alone (no Pharos / no T3N / no KARMA server
in the path) — see the tx table above:

1. ✅ The Soroban verifier accepts a valid AgentCredentialProof — with its
   committed reputation score and its Merkle membership under an
   admin-published root both checked — and creates a job (`create_job`, tx
   `25dd392b7a8a9adfc804dfeb576309e2d1876103fd6645949310e7ea6db597a1`).
2. ✅ Replaying the same nullifier is rejected (`Error(Contract, #5)`,
   CLI-observed — no second tx, see note above).
3. ✅ The sibling `reputation_aggregation_verifier` accepts a real
   `ReputationAggregationProof` (portfolio credential: avg score ≥ 80 across
   ≥ 5 categories over ≥ 10 jobs) against a published epoch root, and its
   nullifier replay guard is confirmed the same way (`submit_proof`, tx
   `c7b98766b9cf0d26bd0ae4180d317153974f7c8cb225344a4090ed6402613cd6`).
4. ✅ **The full "one HTTP request" flow is live**: `src/scripts/demo_stellar_x402_live.ts`
   runs a real provider-stub HTTP server + a real x402 client end-to-end.
   agent-alpha (real funded Testnet account) signs a genuine x402 payment
   (a Soroban authorization entry via `@x402/stellar`'s `exact` scheme), POSTs
   it to `/invoke` in the SAME request as the ZK proof headers
   (`X-Payment`, `X-Reputation-Proof`, `X-Nullifier`), and the provider stub:
   verifies + **settles the USDC payment on-chain**
   (tx [`9880020bb5354a167572c335c808c7cb4e5af65309ff6185ced3a4fd25d6c0ae`](https://stellar.expert/explorer/testnet/tx/9880020bb5354a167572c335c808c7cb4e5af65309ff6185ced3a4fd25d6c0ae) —
   0.001 USDC, agent-alpha → agent-t3n, balances confirmed via Horizon:
   alpha 5.000→4.999, t3n 95.000→95.001), then **verifies the Groth16 proof
   on-chain via `create_job`**
   (tx [`28d4917ba2192d8bf8a5a6004d392593df7e9e4639f9e2b23c0cf3503c4e153c`](https://stellar.expert/explorer/testnet/tx/28d4917ba2192d8bf8a5a6004d392593df7e9e4639f9e2b23c0cf3503c4e153c),
   `job_created` job_id=2, skill_id=43), and returns 200 with both tx hashes
   — all from one client-side HTTP POST. No KARMA server in the trust path;
   the provider stub only routes bytes and shells out to `stellar contract
   invoke`, it doesn't decide anything the chain doesn't independently verify.

That's the closing argument of synthesis §5 + plan §1A — not just the design
goal, the thing itself, run for real on Testnet.

### Reproducing the live x402 + ZK flow

```bash
KEYSTORE_PASSWORD=<password> pnpm exec tsx src/scripts/demo_stellar_x402_live.ts
```

Uses the real `agent-alpha` / `agent-t3n` keys from `keystore.json` (needs
`KEYSTORE_PASSWORD` — see `demo-video/secrets.env.example`). Skill 43's proof
fixture (`src/scripts/fixtures/agent_credential_skill43_packed.json`) is a
**one-shot nullifier** already spent by the run above — re-running reverts
`NullifierReused` at the `create_job` step (the guard working as intended,
not a bug). To run it live again: generate a fresh proof for a new
`skill_id` (same pattern as `circuits/test/agent_credential.test.mjs`),
`register_skill` + `set_skill_root` for it, and point the script at the new
fixture + skill id.

Skills 44 and 45 (same fixture pattern, also committed under
`src/scripts/fixtures/`) were spent recording the narrated demo video above —
two takes, since the first accidentally printed its internal timing markers
to the terminal. Both are real, on-chain, in the same style as skill 43's.

## Cashing out to local currency (SEP-24)

The last leg of the freelancer story: turning a settled USDC payment into money that's
actually spendable locally. `src/scripts/demo_stellar_anchor_cashout.ts` (`pnpm
demo:stellar:anchor`) runs the real SEP-24 protocol handshake against
[`testanchor.stellar.org`](https://testanchor.stellar.org/.well-known/stellar.toml) —
the Stellar Development Foundation's own public reference anchor, not a stub we control.

What actually runs, end to end:

1. **SEP-1 discovery** — fetches the anchor's real `stellar.toml`, reads
   `WEB_AUTH_ENDPOINT` and `TRANSFER_SERVER_SEP0024`.
2. **SEP-10 auth** — requests a challenge transaction, signs it with agent-alpha's real
   Stellar keypair (`KeystoreManager.getStellarKeypair`, the same signer used for the
   x402 leg above), submits it, and receives a real session JWT.
3. **SEP-24 interactive withdrawal** — POSTs `asset_code=USDC` + the account to
   `/transactions/withdraw/interactive` and gets back a real anchor-issued transaction
   `id` and an `interactive_url`.
4. **Status poll** — `GET /transaction?id=...` returns the real transaction record
   (`status: "incomplete"`, `from`/`to` addresses) straight from the anchor.

Real run (2026-07-15), transaction `4599c222-ff80-4ec3-962f-fa9b51db9a08`:

```
$ pnpm exec tsx src/scripts/demo_stellar_anchor_cashout.ts
[anchor] fetching SEP-1 stellar.toml from testanchor.stellar.org...
[client] agent-alpha (GCW7IISXE4DPFRJVP56V22CYHRGICK6S4JTUL4262MPNWYCQTKTGVW3H) — requesting SEP-10 challenge...
[client] real SEP-10 JWT obtained (session token, not a stub)
[anchor] interactive withdrawal opened: { type: 'interactive_customer_info_needed', id: '4599c222-ff80-4ec3-962f-fa9b51db9a08' }
[anchor] real transaction record: { status: 'incomplete', from: 'GCW7II...GVW3H', to: 'GBN4NN...7BXVQF' }
[demo] SEP-24 handshake PASS
```

We also opened the anchor's own hosted status page for this transaction in a real
browser (not our UI — `testanchor.stellar.org`'s own reference SEP-24 frontend) and
confirmed it independently renders the same data — screenshot:
[`docs/media/stellar-anchor-txn-status.png`](docs/media/stellar-anchor-txn-status.png).

**Honest scope.** SEP-24's interactive step is anchor-hosted KYC, built for a human to
click through by design — a script cannot finish it server-side, and this repo doesn't
pretend otherwise. What's proven real here is the full protocol handshake (discovery,
auth, request, status poll, independently confirmed by a second real client — the
browser) against Stellar's own infrastructure. A production wallet would open
`interactive_url` for the user at this point; that UI layer is the near-term next step,
not built today.

**Engineering note found while testing:** the anchor's SEP-10 JWT is short-lived
(~10 minutes) — a production integration must request a fresh challenge immediately
before opening the interactive URL rather than caching an older token.

## Submission notes

- **Soundness fixes shipped before the final deploy.** An earlier internal
  audit of this circuit/contract pair found two gaps, both closed in the
  live build above (contract `CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP`):
  1. The credential's Merkle leaf now binds the reputation score —
     `credentialCommitment = Poseidon(credentialSecret, reputationScore)`
     (`circuits/src/agent_credential.circom`) — instead of the score being an
     unconstrained private witness a holder could self-declare.
  2. `create_job` now requires the proof's `jobHistoryRoot` public signal to
     match an admin-published root (`set_skill_root`, mirroring the sibling
     contract `reputation_aggregation_verifier`'s `set_epoch_root`), instead
     of accepting any self-consistent tree the caller supplies.
  Both fixes are covered by dedicated tests
  (`create_job_rejects_when_skill_root_not_set`,
  `create_job_rejects_wrong_job_history_root` in
  `contracts-soroban/agent_credential_verifier/src/test.rs`) — 12/12 passing.
  An earlier, unpatched contract (`CBXH5QUD…MMIHUYOM`) was briefly live on
  Testnet on 2026-07-02 before this fix; it is superseded and should not be
  cited as current evidence.

- **Public-signal order is contract-asserted.** The circuit emits
  `[skillId, minReputation, nullifier, credentialCommitment, jobHistoryRoot]`
  and the Soroban verifier's `create_job` checks `pi_skill == skill_id`,
  `pi_min_rep == skill.min_reputation`, `pi_nullifier == nullifier` before
  the Groth16 pairing call (see `contracts-soroban/.../src/lib.rs`).
- **Trusted setup ceremony** for the demo is single-contributor (locally
  generated `pot13_final.ptau`). Mainnet would require Hermez. Documented in
  `circuits/README.md` — not concealed.
- **Stellar BN254 host functions.** The pairing check is *not* a software
  Arkworks fallback — it calls `env.crypto().bn254().pairing_check(...)`
  directly, backed by the host's `bn254_multi_pairing_check`
  ([CAP-0074](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md),
  shipped in Protocol 25 "X-Ray", confirmed live well ahead of this hackathon).
  `contracts-soroban/.../src/lib.rs:crypto::verify_groth16` has no `ark-*`
  dependency at all — see `contracts-soroban/agent_credential_verifier/README.md`
  for the exact host-function call sequence and point encoding.

- **End-user onboarding is still self-custody-first.** The freelancer story above assumes a
  wallet already exists (this repo provisions Stellar keys via `KeystoreManager`, deriving an
  ed25519 seed from an existing secp256k1 key — see `src/lib/keystore.ts`). A real non-crypto-
  native user would need a custodial-lite or social-login-derived wallet in front of this;
  that onboarding layer is near-term roadmap, not built today, and disclosed here rather than
  implied.
