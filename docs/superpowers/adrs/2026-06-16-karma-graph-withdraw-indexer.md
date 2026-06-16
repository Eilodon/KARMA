# ADR: KARMA social-graph hydration, withdraw tools, and live skill indexer

## 1. Title
Add `query_social_graph format:"full"`, the `get_pending_balance`/`withdraw_balance` economic-loop
tools, and wire `SkillEventIndexer` into the server lifecycle with observable health.

## 2. Context
Three gaps remained after the app-layer cycle (ADR 2026-06-16-karma-app-layer):
1. `query_social_graph` returned only raw job-id arrays — enough to prove on-chain correctness but
   too thin for visualization/reporting (D-14).
2. The 8-tool surface had no withdraw path, so an agent could not complete the economic loop from
   inside MCP — the demo called the contract's `withdraw()` directly, bypassing the tool layer.
3. `SkillEventIndexer` existed but was never started: nothing reconciled chain events into the BM25
   index, so discovery only saw skills registered in the same process; and the prior cycle's
   retrospective explicitly asked to wire it into bootstrap for cold-start discovery.

Hard constraints carried over: in-process trust (D-1), every uint256 crosses the boundary as a
string (D-6), private keys never leave `KeystoreManager`, no contract change.

## 3. Decision
- **`query_social_graph` `format` param** (`karma.tool.ts`): `"ids"` (default) keeps the exact prior
  output shape `{ address, asProvider, asRequester }`; `"full"` hydrates each edge via `svc.readJob`
  (one tuple-decode site) into `JobDetail` + a `summary` block. wei→PHRS uses integer math (no float
  loss). `JobStatus` includes `Disputed` (on-chain enum index 4). Reputation comes from
  `BM25SkillIndex.getByOwner` (owner→doc map, 0 extra RPC), BASE-50 fallback.
- **`get_pending_balance` + `withdraw_balance`** (`karma.tool.ts` + `karma_service.ts`):
  `get_pending_balance` reads `pendingWithdrawals` (accepts agentId or address, no signing);
  `withdraw_balance` calls `withdraw()` and decodes `amountWei` from the `Withdrawn` event
  (`extractId`), pending-safe. `run_demo` step 5 now routes through these tools.
- **Skill indexer lifecycle** (`skill_indexer_runtime.ts`, `index.ts`): `startKarmaIndexer` starts the
  indexer at boot (guarded by `!MCP_SAFE_MODE` + `PHAROS_CONTRACT_ADDRESS`), applies events in strict
  arrival order via a serial promise chain (SkillRegistered→hydrate+upsert, SkillDeactivated→discard,
  JobCompleted→resolve jobId→skillId via readJob then refresh that skill), and stops on graceful
  shutdown. `karma_health` reports indexer health (`watching`/`lastIndexedBlock`/`lastEventAt`, or
  `{ started: false }`).
- **Testability refactor** (`contract.ts`): `mapLog` and `toIndexedEvents` are exported and
  `buildViemIndexerDeps(client, address)` extracted, so the previously live-only indexer wiring is
  unit-tested against a fake client (`IndexerEventClient` structural seam).

## 4. Status
ACCEPTED

## 5. Consequences
**Improved:** the economic loop is now completable entirely inside MCP; the social graph is
visualization-ready; discovery survives a cold start (indexer backfills from chain on boot);
indexer state is observable without log-diving; the indexer wiring (mapLog/deps construction) and
event reconciliation are now unit-tested.
**Worsened / debt:** the indexer backfills from block 0 by default (`KARMA_INDEXER_FROM_BLOCK`
overrides; no *persisted* checkpoint — startup cost grows with chain length). `withdraw_balance`'s
`amountWei` is null on a `pending` receipt (no event decoded yet). PD-002 is reduced but not closed:
`writeContractBounded` and `realKarmaService` reads still have no integration test.

## 6. Alternatives Considered
- **`getByOwner` via MiniSearch `search('')`** (as a draft spec proposed) — rejected: empty-query
  search returns nothing, so reputation would always fall back to 50. Used a parallel owner→doc map.
- **Reading job fields by name (`raw.escrowAmount`)** — rejected: viem decodes the `jobs()` struct
  getter as an index tuple, so named access is `undefined`; reused `svc.readJob` which already
  decodes by index in one place.
- **Persisted `lastIndexedBlock` checkpoint this cycle** — rejected: `IStateStore` is keyed by
  `tenantId` over `BaseState<phase>` (wrong abstraction); a correct checkpoint needs its own
  persistence with fs/redis/memory parity. Low payoff on a fresh testnet — deferred (PD-004).
- **Forked-anvil integration test for read/write paths** — deferred this cycle: no contract or
  decode-path change to the write/read surface; added unit coverage for the indexer glue instead.

## 7. Evidence
- `pnpm run ci` (typecheck + lint + test): **341 pass / 1 skipped, 52 files**. [verified 2026-06-16]
- New tests: `query_social_graph format:"full"` + reputation fallback, `get_pending_balance`,
  `withdraw_balance` confirmed + pending, `applyIndexedEvent` (3 event types) + `skillDocFromChain`,
  `mapLog`/`toIndexedEvents`/`buildViemIndexerDeps`, `karma_health` indexer surfacing. [verified 2026-06-16]
- Tool count: `createKarmaTools` returns 9 economy tools (+ `karma_health` = 10 total). [verified 2026-06-16]
- Live read/write paths (register→…→withdraw) still verified only by the P7 demo, not CI. [ASSUMED — see PD-002]
- [G.CDOC verified 2026-06-16] Section 3 spot-checked against code: `withdraw` decodes the
  `Withdrawn` event (`karma_service.ts:174`); serial event chain (`skill_indexer_runtime.ts:80`);
  `karma_health` indexer field (`karma.tool.ts:60`); `mapLog`/`toIndexedEvents`/`buildViemIndexerDeps`
  exported (`contract.ts:300/326/352`); demo step 5 routes through the tools (`run_demo.ts:94-95`).

## 8. Owner
**KARMA team — gokuderafight@gmail.com**

## 8b. Known Debts (PATTERN-DEBT)
  - PD-002: OPEN (reduced) — indexer wiring (`mapLog`/`buildViemIndexerDeps`) is now unit-tested;
    `writeContractBounded` + `realKarmaService` reads remain live-only. **resolution_trigger fired
    this cycle** (`realKarmaService` was modified); partially actioned (indexer glue tested), full
    forked-anvil integration test for read/write still deferred. Trigger re-scoped to the read/write
    decode paths so it stops firing on unrelated service edits.
  - PD-004: OPEN (new) — skill indexer has no persisted `lastIndexedBlock`; restarts backfill from
    block 0 (env override only).
  - PD-003: OPEN (unchanged) — exactly-once guard is an O(n) `getRequesterJobs` scan per create_job.

## 9. Next Cycle Trigger
When the deployed contract's `jobCount()` exceeds **1000** (full backfill from block 0 dominates
boot) OR any instance's indexer `lastEventAt` heartbeat goes stale > **10 minutes** while
`lastIndexedBlock` should be advancing OR a **second server instance** is deployed (in-process BM25
index + indexer singleton are no longer authoritative).

## 10. Cycle Retrospective
- **Assumption wrong:** a draft spec's `format:"full"` handler read job fields by name and built
  `getByOwner` on `search('')` — both silently fail (viem tuple is index-keyed; empty-query search
  returns nothing). Verify decode/search assumptions against existing readers before copying a spec.
- **Surprise (typing):** viem's `PublicClient` satisfies a narrow structural `IndexerEventClient`
  directly — the `as unknown as` cast was flagged unnecessary by the linter. Prefer a structural
  seam over casts for testability.
- **Surprise (ordering):** firing `applyIndexedEvent` concurrently (`void ...`) lets a sync
  `discard` race ahead of a pending async `upsert` for the same skill; serialized via a promise
  chain. Mixed sync/async event handlers need explicit ordering.
- **Debt knowingly created:** indexer backfills from block 0 (no persisted checkpoint, PD-004) —
  acceptable on a fresh testnet, costly as the chain grows.
- **Signal for next cycle:** watch indexer `lastEventAt` staleness and `jobCount()` growth; both
  feed the Next Cycle Trigger above.
