# ADR: KARMA Sybil-Resistant Reputation — Tier-0 fix + Tier-1 flow-rep + Tier-2 bond shipped (dormant; live deploy + slashing deferred)

## 1. Title
Close the self-deal **discovery-rank** hole (Tier-0, shipped: gate skill `reputationScore` +
`totalInvocations` behind the same arm's-length guard agent reputation already used), **ship the
Tier-1 off-chain seed-anchored flow-reputation engine** (flag-gated, default off, bond-ready seed
seam) as the non-bootstrappable replacement for the self-inflatable discovery boost, and adopt
**Tier-2** (on-chain native-currency bond as the flow-rep seed) as the next-redeploy step — together
retiring PD-005's disclosed residual ("wash-trade resistance needs stake/identity, out of scope").

## 2. Context
PD-005 shipped consensus-level Trust-Gate enforcement on contract v2 but self-disclosed that
reputation stays wash-tradeable without stake/identity. Research into *where* that residual actually
bites surfaced a sharper, previously-unrecorded finding: the residual lands on **two** reputation
quantities with **asymmetric** protection, and the cheaper of the two was completely unguarded.

1. **Two reputations, one guard.** `_settleCompletion` bumps both (a) the per-skill
   `reputationScore` — which the off-chain indexer copies into the BM25 doc
   ([skill_indexer_runtime.ts:36](../../../src/lib/skill_indexer_runtime.ts#L36)) and turns into a
   discovery boost of `1 + rep/100` → **1.0×..2.0×** ([bm25_index.ts:163-165](../../../src/lib/bm25_index.ts#L163-L165)) —
   and (b) per-agent `agentReputation`, the Trust-Gate source of truth
   ([createJob:167](../../../contracts/AgentSkillRegistry.sol#L167)). The Abductive-2 self-deal guard
   (`if (requester != provider)`) protected **only (b)**; the skill `reputationScore` and
   `totalInvocations` bumped **unconditionally**.
2. **The unguarded path was the cheapest attack in the system.** Because `createJob` has no
   `msg.sender != owner` check and `pricePerCall` may be **0**, a **single wallet** could run the
   whole lifecycle on its own skill (create→deliver→confirm), with `requester == provider`, earning
   no agent rep (correctly) but pumping its skill `reputationScore` → 100 (boost 2.0×) at **zero
   capital, gas-only**, to drown real skills in `discover_skills`. This is *strictly cheaper* than
   the 2-wallet Trust-Gate farm, and a passing test (`test_SelfDeal_NoRepFarm`) literally exercised
   it twice while asserting only agent rep — proving the asymmetry was an oversight, not intent.
3. **Velocity-cap / diminishing-returns alone are insufficient.** Both proposals fail against a
   large Sybil ring (N wallets, each pair transacting once, rate-limited): per-agent velocity never
   trips, per-pair diminishing-returns never trips. The property that closes it is
   **non-bootstrappability** — reputation must *flow from* already-trusted (externally seeded)
   parties, never be *minted within* a closed set. EigenTrust/TrustRank/TraceRank all encode this:
   a closed Sybil set has zero seed, so its mutual endorsements propagate zero weight.

Carried constraints: in-process trust (D-1); every uint256 crosses the boundary as a string (D-6);
the deployed contract is immutable (struct changes ⇒ redeploy + migration); and the on-chain
`agentReputation` invariant is **monotonic** ("rep only ever rises, 0 = unset sentinel — do NOT add
a decay feature", [AgentSkillRegistry.sol:143-148](../../../contracts/AgentSkillRegistry.sol#L143-L148)).

## 3. Decision
**Tier-0 — SHIPPED this cycle (contract edit, in `_settleCompletion`).** Move `s.totalInvocations`
and the `s.reputationScore` bump *inside* the existing `if (j.requester != j.provider)` guard, so a
self-dealt job settles escrow but earns **zero** trust signals (skill rep, invocation count, AND
agent rep). Escrow settlement (`status`, `completedAt`, `pendingWithdrawals`) stays unconditional —
money must always move. No ABI/struct/storage-layout change; existing live v2 semantics for
arm's-length jobs are byte-for-byte unchanged.

**Tier-1 — SHIPPED this cycle (off-chain, flag-gated, default OFF).** A TraceRank/EigenTrust-lite
flow reputation computed **in the indexer** (free, decay-friendly, auditable — `readJob` already
exposes `requester`+`provider`, so the payment graph needs no contract change):
  - **Pure scorer** ([flow_reputation.ts](../../../src/lib/flow_reputation.ts)): `computeFlowReputation`
    runs EigenTrust power-iteration `t = (1-α)·s + α·Cᵀt` over a graph whose edge weight =
    `log1p(value/unit) × exp(-ln2·age/halfLife) × 1/(1+pairDiminish·k)`. Value-weighting means a
    **price-0 endorsement carries zero weight** — the cheapest pump is neutralized even seedless.
    Self-edges dropped (mirrors Tier-0). Deterministic ⇒ recomputable by anyone ⇒ not a hidden authority.
  - **Seed-pluggable** (`params.seeds`): unseeded ⇒ uniform teleport (honest "raises-bar" PageRank);
    a trusted seed set ⇒ non-bootstrappable (a closed ring has zero seed → ~zero score). The seam is
    where **Tier-2's bond plugs in unchanged** (seed mass = bonded capital).
  - **Per-OWNER boost**: a skill inherits its owner's propagated trust, so registering 100 skills
    cannot manufacture rank. `FlowBoostSource` caches with a dirty-flag so a backfill burst triggers
    one recompute, not O(N²). Bounded edge retention (DoS cap).
  - **Pluggable seam** ([bm25_index.ts](../../../src/lib/bm25_index.ts) `setBoost`): swaps the
    self-inflatable `1 + rep/100` for the flow boost; `null` restores legacy. Wired only when
    `KARMA_DISCOVERY_RANK=flow` ([skill_indexer_runtime.ts](../../../src/lib/skill_indexer_runtime.ts)),
    so **default behavior is byte-for-byte unchanged** until validated + seeded.
  - Decay lives **only off-chain** — the monotonic on-chain `agentReputation` invariant is untouched
    (clean split: on-chain monotonic agent-rep gates create_job; off-chain decaying flow-rep ranks
    discovery).

**Tier-2 — SHIPPED in source this cycle (contract code + seed wiring; NOT live-deployed).** An
**optional, open, per-agent native-currency bond** as the flow-rep *seed* (the chosen model — not a
paywall, not a Gate change):
  - **Contract** ([AgentSkillRegistry.sol](../../../contracts/AgentSkillRegistry.sol)):
    `depositBond` (payable), `requestBondUnlock` (starts a 7-day cooldown, seed → 0 immediately),
    `cancelBondUnlock`, `withdrawBond` (after cooldown → credits the audited pull-payment ledger),
    `seedEligibleBond(agent)` view, `BondUpdated` event. Bond is locked, per-agent, withdrawable only
    by the same agent — never flows to a counterparty (unlike escrow), so N Sybil identities cost N
    bonds locked at once. Zero-bond agents still register/rank (open). **No slashing** — Sybil cost is
    the lockup, not punishment (quality-slashing is Tier-2b, needs arbitration; deliberately deferred).
  - **Seed bridge** (off-chain): `BondUpdated.seedEligible` → `FlowBoostSource.setBondSeed` →
    `seedWeightFromBond` (log-compressed so a whale bond can't linearly dominate) → the flow-rep seed
    vector. The cooldown + immediate seed-zeroing on unlock defeats a lock-seed-flash-unlock attack.
  - **NOT deployed**: this rides the same un-redeployed contract version as the Tier-0 fix, so one
    future migration carries both. The live `0xc6d5…` is untouched; the seed bridge is inert until the
    bonded contract is deployed (no BondUpdated events exist on the live contract).

## 4. Status
**ACCEPTED + SHIPPED IN SOURCE** for Tier-0 (contract fix), Tier-1 (off-chain flow-rep, flag-gated
`KARMA_DISCOVERY_RANK=flow`, default OFF), and Tier-2 (optional per-agent bond + seed bridge, **not
live-deployed**). **PROPOSED** only: the **live redeploy + migration** that activates the on-chain
bond, *flipping Tier-1 on with a seed set*, and **Tier-2b slashing** — all gated on §9.

## 5. Consequences
**Improved (Tier-0, live in source):** the cheapest Sybil vector — single-wallet, zero-capital
discovery-rank pump — is closed; self-deal earns no signal of any kind ("settles money, manufactures
no trust"); `totalInvocations` social-proof is no longer self-inflatable. No ABI/deploy impact.
**Improved (Tier-1, shipped, dormant):** discovery can rank by propagated trust instead of a raw
counter; value-weighting alone neutralizes price-0 pumps; seeded mode is non-bootstrappable (a ring
scores ~0). Fully reversible (`setBoost(null)`), zero behavior change while the flag is off.
**Improved (Tier-2, shipped in source, not deployed):** an optional per-agent bond + the bond→seed
bridge now exist and are tested, so the *seed* Tier-1 needs is no longer hypothetical — it is real
capital-at-risk that plugs straight in. Bond never recycles (unlike escrow), cooldown defeats
flash-seeding, log-cap defeats whale-seeding, and it is a non-paywall (zero-bond agents still rank).
**Still open (PD-007 residual):** the bond is **not live** — it activates only at the next redeploy,
and Tier-1 stays default-off until flipped **with that bond as its seed**. Until then discovery uses
the legacy boost and a **2-wallet+ ring** still farms agent rep (the Trust Gate) at gas-only cost.
Seedless Tier-1 only *raises the bar*; a test (`SEEDLESS … honest limit`) asserts this so no one
mistakes it for full resistance.
**Trade-offs accepted:** seed quality is the whole ballgame (EigenTrust is collusion-vulnerable under
weak seeds — the TraceRank paper concedes this), which is exactly why Tier-1 ships dormant rather
than seeded-with-guesses; off-chain scoring is deterministic/recomputable from chain (not a hidden
authority); Tier-2 slashing will need an *objective* trigger or it is a griefing vector.

## 6. Alternatives Considered
- **On-chain EigenTrust / graph propagation** — rejected: iterative matrix convergence is
  prohibitively gas-heavy and the monotonic-rep invariant forbids the decay it needs. Off-chain over
  on-chain events (Tier-1) is the same math where it is free and auditable.
- **Proof-of-Personhood (Gitcoin/Human Passport, BrightID, World ID)** — rejected as primary: KARMA
  is an **agent** economy (machines, not humans); PoP is the wrong primitive and heavy. ERC-8004
  agent-identity attestations are noted as a *future seed source* for Tier-1, not a gate.
- **Token-Curated Registry (stake-to-list + challenge)** — rejected: requires a native governance
  token KARMA does not have; a native-currency bond (Tier-2) captures the skin-in-the-game benefit
  without minting a token or building a voting/arbitration system.
- **Velocity cap + per-counterparty diminishing returns only (the originally-proposed pair)** —
  rejected as a complete fix: necessary-but-insufficient (defeated by a slow N-wallet ring). Folded
  into Tier-1 as the decay/saturation terms, *anchored* by seeds which they alone lack.
- **Rip the skill `reputationScore` out entirely now** — rejected for Tier-0: too broad for a
  surgical security fix; ranking redesign is Tier-1's deliberate scope. Tier-0 only removes the
  self-deal inflation.

## 7. Evidence
- **Tier-0 RED→GREEN proven** by temporarily reverting the guard: pre-fix
  `test_SelfDeal_NoDiscoveryRankPump` FAILs `reputation 75 != 50` (5 self-deals × +5, capped) and
  `test_SelfDeal_NoRepFarm` FAILs `60 != 50`; post-fix both PASS. [verified 2026-06-17]
- **Full Foundry suite: 25 passed | 0 failed** (`forge test`), incl. the 2 new/extended self-deal
  tests; arm's-length happy-path rep (55) + invocations (1) unchanged. [verified 2026-06-17]
- **TS suite unaffected: 39 passed** across `karma_tools.test.ts` + `skill_indexer_runtime.test.ts`
  (no ABI/struct change ⇒ no decode coupling). [verified 2026-06-17]
- Attack economics confirmed in source: `createJob` has no `msg.sender != owner` guard and accepts
  `pricePerCall == 0` ([createJob:157-191](../../../contracts/AgentSkillRegistry.sol#L157-L191)).
- **Tier-1 flow-rep: 11 unit tests pass** ([flow_reputation.test.ts](../../../src/__tests__/flow_reputation.test.ts)),
  incl. the security headline `SEEDED: ring crushed` (ringMax < legit × 0.01) and its honest counter
  `SEEDLESS: ring competitive` (ringMax > legit × 0.5), plus price-0→zero-weight, distinct-counterparty
  > repetition, temporal decay, whale dampening, self-edge ignored, determinism. [verified 2026-06-17]
- **Tier-1 wiring tested**: `setBoost` swap flips ranking + `null` restores legacy
  ([bm25_index.test.ts](../../../src/__tests__/bm25_index.test.ts)); JobCompleted records an
  arm's-length edge and skips self-deals ([skill_indexer_runtime.test.ts](../../../src/__tests__/skill_indexer_runtime.test.ts)).
- **Tier-2 bond: 9 Foundry tests pass** — deposit seeds + is per-agent + emits `BondUpdated`; unlock
  request zeroes the seed but keeps capital locked (flash-seed defense); withdraw reverts before
  cooldown, returns capital via pull-payment after; cancel/redeposit re-activate; zero-bond reverts.
  Plus **3 engine tests**: a bonded seed crushes an unbonded ring (ringMax < 1.01), clearing the seed
  restores ring competitiveness, `seedWeightFromBond` is log-compressed (1e6× bond → <5× weight).
  Plus **2 indexer tests**: `BondUpdated` → `setBondSeed`, seedEligible=0 clears. [verified 2026-06-18]
- **Whole repo green with flags OFF / bond un-deployed**: `npm run typecheck` + `npm run lint` clean;
  `npm test` **421 passed | 1 skipped** (pre-existing env-lock); `forge test` **34 passed**; ABI
  drift-guard green (abi.ts ↔ artifact in sync). Default discovery behavior byte-for-byte unchanged,
  live `0xc6d5…` contract untouched. [verified 2026-06-18]

## 8. Owner
**KARMA team — gokuderafight@gmail.com**

## 8b. Known Debts (PATTERN-DEBT)
- **PD-007: OPEN (new)** — reputation is Sybil/wash-trade farmable by a ≥2-wallet ring at gas-only
  cost (escrow recycles or price 0). Tier-0 closed the 1-wallet self-deal sub-case; Tier-1 flow-rep +
  Tier-2 bond + the bond→seed bridge are **all shipped in source but dormant** (flag off, bond not
  live-deployed) so discovery still uses the legacy boost by default. Residual closure = (1) deploy
  the bonded contract version (carries Tier-0 fix + bond in one migration) and (2) flip
  `KARMA_DISCOVERY_RANK=flow` with the bond as seed. Supersedes PD-005's "out of scope" residual.
- **PD-008: OPEN (new, deferred Tier-2b)** — no quality-slashing of bonds: a bonded agent that
  delivers junk is not punished (only Sybil *origination* costs capital). Needs an objective trigger
  or arbitration (Kleros-style); dispute-driven slashing is a griefing vector while requesters can be
  Sybil. Out of scope this cycle by design.
- **PD-005: RESOLVED (unchanged)** — on-chain Trust Gate is live; wash-trade residual now under PD-007.
- **PD-003 / PD-002 / PD-004:** unchanged — the un-redeployed contract version now carries Tier-0 +
  Tier-2 bond; bundle PD-003's `jobByTaskHash` change into the same migration to keep it to one.

## 9. Next Cycle Trigger
- **Deploy + activate** when: `discover_skills` ranking is shown gamed, OR before any mainnet/value-
  bearing deploy, OR the next `AgentSkillRegistry` redeploy fires (PD-003 scale trigger / institutional
  customer) — redeploy the bonded contract version (Tier-0 fix + bond, bundle PD-003's `jobByTaskHash`),
  migrate skill state, wire `BondUpdated` → seeds (already coded), set `KARMA_DISCOVERY_RANK=flow`,
  validate on the PD-002 anvil harness first. This is a deploy + config step — the code is built+tested.
- **Tier-2b slashing** (PD-008) — only if junk-delivery-despite-bond is observed AND an objective
  slash trigger / arbitration is designed in its own audit-design cycle.

## 10. Cycle Retrospective
- **Asymmetry as a security smell:** one guard protecting one of two twinned writes (`agentRep`
  guarded, `reputationScore` not) was the whole bug. When a guard wraps *some* of a set of
  same-purpose effects, audit why the rest are outside it.
- **Tests encode the author's threat model:** the pre-existing self-deal test asserted only agent
  rep — it *ran* the skill-score pump without seeing it. A guard's test must assert every signal the
  guard is meant to cover, or it certifies the gap.
- **"Necessary" ≠ "sufficient":** the user's velocity/diminishing-returns instinct was right but
  incomplete; the literature's non-bootstrappability property is the missing anchor. Cheap local
  caps + a global seed anchor, not one or the other.
- **Right computation, right layer:** graph reputation belongs off-chain (free, decaying, auditable)
  while the Gate's monotonic counter stays on-chain — splitting them respects an invariant that an
  on-chain EigenTrust would have violated.

## 11. Sources
- TraceRank — Sybil-Resistant Service Discovery for Agent Economies: https://arxiv.org/html/2510.27554
- EigenTrust (Stanford): https://nlp.stanford.edu/pubs/eigentrust.pdf
- Resisting Sybils in P2P Markets (Traupman): https://dl.ifip.org/db/conf/ifiptm/ifiptm2007/Traupman07.pdf
- Multicoin — TCR features & tradeoffs: https://multicoin.capital/2018/09/05/tcrs-features-and-tradeoffs/
- The Graph — staking for discoverability: https://thegraph.com/blog/the-graph-network-in-depth-part-2/
- Human Passport — Proof of Personhood / Sybil resistance: https://human.tech/blog/human-passport-proof-of-personhood-and-sybil-resistance-for-web3
