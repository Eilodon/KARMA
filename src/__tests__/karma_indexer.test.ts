import { describe, it, expect, vi } from "vitest";
import {
  SkillEventIndexer,
  mapLog,
  toIndexedEvents,
  buildViemIndexerDeps,
  type IndexedEvent,
  type IndexerDeps,
  type IndexerEventClient,
} from "../lib/contract.js";

const OWNER = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" as const;
const CONTRACT = "0x1111111111111111111111111111111111111111" as const;
const skillReg = (blockNumber: bigint, skillId = 1n): IndexedEvent => ({
  type: "SkillRegistered",
  blockNumber,
  skillId,
  owner: OWNER,
  name: "demo",
  pricePerCall: 5n,
});

function harness(opts: { fromBlock: bigint; head: bigint; backfill?: IndexedEvent[] }) {
  let captured: { onLogs: (e: IndexedEvent[]) => void; onError: (err: unknown) => void } | undefined;
  const unwatch = vi.fn();
  const watch = vi.fn((h: NonNullable<typeof captured>) => {
    captured = h;
    return unwatch;
  });
  const getBlockNumber = vi.fn().mockResolvedValue(opts.head);
  const getLogs = vi.fn().mockResolvedValue(opts.backfill ?? []);
  const events: IndexedEvent[] = [];
  const deps: IndexerDeps = { getBlockNumber, getLogs, watch, now: () => 1000 };
  const indexer = new SkillEventIndexer(deps, (e) => events.push(e), opts.fromBlock);
  return { indexer, watch, unwatch, getBlockNumber, getLogs, events, fire: () => captured! };
}

describe("P4.3 SkillEventIndexer", () => {
  it("backfills getLogs(fromBlock, head) on start, advances lastIndexedBlock, then watches", async () => {
    const h = harness({ fromBlock: 100n, head: 200n, backfill: [skillReg(150n)] });
    await h.indexer.start();
    expect(h.getLogs).toHaveBeenCalledWith(100n, 200n);
    expect(h.events).toEqual([skillReg(150n)]);
    expect(h.watch).toHaveBeenCalledTimes(1);
    const hp = h.indexer.health();
    expect(hp.lastIndexedBlock).toBe("200"); // stringified bigint (D-6)
    expect(hp.watching).toBe(true);
    expect(hp.lastEventAt).toBe(1000); // heartbeat set when an event is processed
  });

  it("processes live events: advances lastIndexedBlock + updates heartbeat", async () => {
    const h = harness({ fromBlock: 100n, head: 200n });
    await h.indexer.start();
    h.fire().onLogs([skillReg(250n, 2n)]);
    expect(h.events.at(-1)).toEqual(skillReg(250n, 2n));
    expect(h.indexer.health().lastIndexedBlock).toBe("250");
  });

  it("on subscription error, reconnects: re-backfills from lastIndexedBlock and re-watches", async () => {
    const h = harness({ fromBlock: 100n, head: 200n });
    await h.indexer.start();
    h.getBlockNumber.mockResolvedValue(300n); // chain advanced during the outage
    h.fire().onError(new Error("ws closed"));
    await vi.waitFor(() => expect(h.watch).toHaveBeenCalledTimes(2));
    expect(h.getLogs).toHaveBeenLastCalledWith(200n, 300n); // gap catch-up from last indexed
    expect(h.indexer.health().watching).toBe(true);
  });
});

describe("mapLog (raw viem log → IndexedEvent)", () => {
  const raw = (eventName: string, args: Record<string, unknown>, blockNumber: bigint | null = 5n) =>
    ({ eventName, args, blockNumber });

  it("decodes SkillRegistered", () => {
    expect(mapLog(raw("SkillRegistered", { skillId: 1n, owner: OWNER, name: "demo", pricePerCall: 5n }))).toEqual({
      type: "SkillRegistered", blockNumber: 5n, skillId: 1n, owner: OWNER, name: "demo", pricePerCall: 5n,
    });
  });

  it("decodes SkillDeactivated", () => {
    expect(mapLog(raw("SkillDeactivated", { skillId: 9n }))).toEqual({
      type: "SkillDeactivated", blockNumber: 5n, skillId: 9n,
    });
  });

  it("decodes JobCompleted", () => {
    expect(mapLog(raw("JobCompleted", { jobId: 3n, provider: OWNER, payout: 100n, newReputation: 60n }))).toEqual({
      type: "JobCompleted", blockNumber: 5n, jobId: 3n, provider: OWNER, payout: 100n, newReputation: 60n,
    });
  });

  it("returns null for untracked events, pending logs (null block), and malformed logs", () => {
    expect(mapLog(raw("JobCreated", { jobId: 1n }))).toBeNull(); // not indexed
    expect(mapLog(raw("SkillRegistered", { skillId: 1n }, null))).toBeNull(); // pending log
    expect(mapLog({ eventName: "SkillRegistered" })).toBeNull(); // no args
    expect(mapLog({})).toBeNull();
  });

  it("toIndexedEvents maps a batch and drops the nulls", () => {
    const out = toIndexedEvents([
      raw("SkillDeactivated", { skillId: 1n }),
      raw("JobCreated", { jobId: 2n }), // dropped
      raw("SkillDeactivated", { skillId: 2n }, null), // dropped (pending)
    ]);
    expect(out).toEqual([{ type: "SkillDeactivated", blockNumber: 5n, skillId: 1n }]);
  });
});

describe("buildViemIndexerDeps (viem client → IndexerDeps)", () => {
  function fakeClient(over: Partial<IndexerEventClient> = {}): IndexerEventClient {
    return {
      getBlockNumber: vi.fn(async () => 42n),
      getContractEvents: vi.fn(async () => []),
      watchContractEvent: vi.fn(() => vi.fn()),
      ...over,
    };
  }

  it("getBlockNumber delegates to the client", async () => {
    const client = fakeClient({ getBlockNumber: vi.fn(async () => 777n) });
    const deps = buildViemIndexerDeps(client, CONTRACT);
    expect(await deps.getBlockNumber()).toBe(777n);
  });

  it("getLogs queries getContractEvents with the address/abi/range and maps+filters the result", async () => {
    const getContractEvents = vi.fn(async () => [
      { eventName: "SkillRegistered", args: { skillId: 1n, owner: OWNER, name: "x", pricePerCall: 5n }, blockNumber: 10n },
      { eventName: "JobCreated", args: { jobId: 9n }, blockNumber: 11n }, // untracked → dropped
    ]);
    const deps = buildViemIndexerDeps(fakeClient({ getContractEvents }), CONTRACT);
    const events = await deps.getLogs(100n, 200n);
    expect(getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ address: CONTRACT, fromBlock: 100n, toBlock: 200n }),
    );
    expect(events).toEqual([
      { type: "SkillRegistered", blockNumber: 10n, skillId: 1n, owner: OWNER, name: "x", pricePerCall: 5n },
    ]);
  });

  it("watch wires onLogs (raw→mapped) and onError through to watchContractEvent and returns its unwatch", () => {
    let captured: { onLogs: (logs: unknown[]) => void; onError: (e: unknown) => void } | undefined;
    const unwatch = vi.fn();
    const watchContractEvent = vi.fn((args: NonNullable<typeof captured>) => {
      captured = args;
      return unwatch;
    });
    const deps = buildViemIndexerDeps(fakeClient({ watchContractEvent }), CONTRACT);

    const delivered: IndexedEvent[] = [];
    const errors: unknown[] = [];
    const ret = deps.watch({ onLogs: (e) => delivered.push(...e), onError: (err) => errors.push(err) });
    expect(ret).toBe(unwatch);

    // a raw batch arriving from viem is decoded before reaching the indexer's onLogs
    captured!.onLogs([
      { eventName: "SkillDeactivated", args: { skillId: 7n }, blockNumber: 12n },
      { eventName: "Noise", args: {}, blockNumber: 12n }, // dropped
    ]);
    expect(delivered).toEqual([{ type: "SkillDeactivated", blockNumber: 12n, skillId: 7n }]);

    const boom = new Error("ws closed");
    captured!.onError(boom);
    expect(errors).toEqual([boom]);
  });
});
