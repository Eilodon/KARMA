import { describe, it, expect, vi } from "vitest";
import { SkillEventIndexer, type IndexedEvent, type IndexerDeps } from "../lib/contract.js";

const OWNER = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" as const;
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
