# ADR: Hackathon demo hardening + DEBT-002 reconciliation

## 1. Title
Make the KARMA demos presentation-grade (color, exactly-once proof, offline BM25 discovery, tunable confirm latency) and correct the stale DEBT-002 crypto-erasure registry entry to reflect shipped `smcp:v4:kms`.

## 2. Context
Demo review of `run_demo.ts` found four gaps for a hackathon recording: (Q1) output was
monochrome `console.log` with a machine `DEMO_JSON` blob polluting the recording; (Q2) viem's
default 4000ms receipt poll dominates perceived confirm time on a fast chain; (Q3) Layer-0
strengths (exactly-once, output firewall, KMS erasure) were invisible — the loop only showed the
happy path; (Q4) BM25 discovery was never actually invoked (the demo registers a skill *named*
`discover_skills` but never searches), hiding relevance×reputation ranking and injection
sanitization. Separately, `pattern_debt.ts` DEBT-002 and its reconciliation test still claimed
crypto-erasure was unimplemented ("type-only ITenantKeyRegistry", "No v3 runtime encryption
path"), contradicting shipped code (`smcp:v4:kms` in `encryption.ts`, 4 providers, README 2026-06-14).

## 3. Decision
- **DEBT-002 → implemented/resolved.** Rewrote the registry entry + reconciliation test to the
  accurate state: `smcp:v4:kms` KMS-backed per-tenant DEK erasure across Local/Vault/AWS/GCP
  providers, two-phase `scheduleErasure`, wired in `EncryptionService`, production-gated (rejects
  `KMS_PROVIDER=local`). Honest residual: AWS KMS 7-day Phase-2 pending-deletion window.
- **Q1** `src/scripts/_demo_format.ts` — zero-dependency ANSI formatter (TTY/`NO_COLOR`-aware);
  `run_demo` uses it; `DEMO_JSON` blob gated behind `DEMO_JSON=1`.
- **Q2** `PHAROS_POLL_INTERVAL_MS` threads into the viem clients in `contract.ts`; unset → viem
  default (production unaffected).
- **Q3** `run_demo` replays `create_job` with the same `(requester, skillId, nonce)` to prove
  exactly-once live (no second escrow), plus a Layer-0 hardening footer.
- **Q4** `src/scripts/discover_demo.ts` — runs offline (no chain/keystore), shows BM25
  relevance×reputation ranking, BigInt-safe filtering, and prompt-injection sanitization.
- Added `pnpm demo` / `demo:discover` / `demo:verify`; documented in `DEMO.md`.

## 4. Status
ACCEPTED

## 5. Consequences
- **Improved:** demos are recordable and legible; Layer-0 + Layer-2 strengths are now visible;
  the internal pattern-debt registry no longer contradicts shipped KMS code (closes a Q&A trap).
- **Cost:** the hostile-payload skill in `discover_demo` must be built from char codes (not literal
  bidi) so the source file stays clean of trojan-source characters.
- **No new pattern debt.** `contract.ts` change is client config only — `writeContractBounded` /
  `realKarmaService` logic and return shapes are unchanged.

## 6. Alternatives Considered
- **picocolors for color:** REJECTED — it resolves transitively but is not a declared dependency;
  a zero-dep ANSI helper removes the "works on my machine" risk for a demo.
- **Lower the global receipt-poll default:** REJECTED — kept viem's default for production and made
  the fast cadence opt-in via env, scoping the change to demos/tests.
- **Drive discovery through on-chain registration:** REJECTED for the showcase — extra txs make it
  slow; seeding the in-memory index (as production does from events) is faster and still real.

## 7. Evidence
- DEBT-002: RED `expected 'open' to be 'implemented'` → GREEN after registry rewrite; providers
  verified to implement `rotateKey`/`scheduleErasure` (AWS `ScheduleKeyDeletionCommand`, 7-day
  window). [verified 2026-06-16]
- `_demo_format`: RED (module missing) → GREEN 3/3 (`paint`/`short`/`reveal`). [verified 2026-06-16]
- `discover_demo` executed live: ranking, filters, and `‮/​/` stripped in clean
  output. [verified 2026-06-16]
- Full gate `pnpm run ci` exit 0: 51 files, 322 passed | 1 skipped; strict lint on scripts 0
  warnings. [verified 2026-06-16]

## 8. Owner
**KARMA team — gokuderafight@gmail.com**

## 8b. Known Debts (PATTERN-DEBT)
  - DEBT-002 (src/core/pattern_debt.ts): OPEN → IMPLEMENTED this cycle; residual = AWS 7-day window.
  - PD-002: OPEN, trigger NOT fired — `realKarmaService` unchanged; only `contract.ts` client
    config (pollingInterval) touched, no logic/return-shape change.
  - PD-003: OPEN, trigger NOT fired — no contract/scale change.

## 9. Next Cycle Trigger
When the live `run_demo` is recorded against Pharos Atlantic, measure real per-tx confirm latency;
if median confirm with `PHAROS_POLL_INTERVAL_MS=300` exceeds 5s, add explorer-parallel framing or
edit-time speed-ramp before publishing. Also: if a 4th demo skill or a new tool is added, extend
`discover_demo`/`run_demo` coverage.

## 10. Cycle Retrospective
- The biggest demo gap was Q4: discovery was never invoked despite being a headline feature —
  always check the demo actually calls the feature it advertises.
- `discover_demo` needs neither chain nor keystore (pure in-memory index), so it's the safest,
  fastest, most reproducible artifact — lead the recording with it.
- DEBT-002 was stale because the reconciliation *test* encoded the old belief; correcting docs
  here means correcting the test that guards them, not just prose.
- viem's 4000ms default poll — not block time — is the real demo latency driver; it's tunable.
- Next agent: the demo hostile-payload string is built from `String.fromCharCode` on purpose;
  do not "simplify" it to literal characters or the source becomes a trojan-source file.
