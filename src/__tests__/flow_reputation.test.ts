import { describe, it, expect } from "vitest";
import {
  computeFlowReputation,
  FlowReputationGraph,
  FlowBoostSource,
  seedWeightFromBond,
  DEFAULT_FLOW_PARAMS,
  DEFAULT_MAX_FLOW_EDGES,
  type FlowEdge,
  type FlowReputationParams,
} from "../lib/flow_reputation.js";

const NOW = 1_000_000_000;
const RECENT = NOW - 3600; // 1h ago
const ETH = 10n ** 18n;

const params = (over: Partial<FlowReputationParams> = {}): FlowReputationParams => ({
  ...DEFAULT_FLOW_PARAMS,
  ...over,
});

const edge = (from: string, to: string, valueWei = ETH, timestamp = RECENT): FlowEdge => ({
  from,
  to,
  valueWei,
  timestamp,
});

describe("computeFlowReputation", () => {
  it("is deterministic — identical input yields identical scores (recomputable / auditable)", () => {
    const edges = [edge("0xa", "0xb"), edge("0xc", "0xb"), edge("0xb", "0xc")];
    const a = computeFlowReputation(edges, NOW, params());
    const b = computeFlowReputation(edges, NOW, params());
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("propagates trust from a seed: a seeded payer's provider scores, an unendorsed one does not", () => {
    const seeds = new Map([["0xseed", 1]]);
    // seed endorses L; X exists only as an unpaid/unconnected provider
    const scores = computeFlowReputation([edge("0xseed", "0xL"), edge("0xL", "0xX", 0n)], NOW, params({ seeds }));
    expect((scores.get("0xl") ?? 0)).toBeGreaterThan(0);
    expect((scores.get("0xx") ?? 0)).toBeLessThan(scores.get("0xl")!); // unendorsed provider far below
  });

  it("value-weighting neutralizes price-0 endorsements (the cheapest pump) — zero weight", () => {
    const seeds = new Map([["0xseed", 1]]);
    // seed 'pays' provider P with price 0 a thousand times
    const edges = Array.from({ length: 1000 }, (_, i) => edge("0xseed", "0xP", 0n, RECENT - i));
    const scores = computeFlowReputation(edges, NOW, params({ seeds }));
    // P accrues no score — a 0-value edge carries no endorsement weight, so the graph has no weighted edges
    expect(scores.get("0xp") ?? 0).toBe(0);
  });

  it("dampens whales: log-scaling keeps a small honest payment visible beside a colossal one", () => {
    // EigenTrust normalizes each payer's outflow to 1, so value acts on the SPLIT — one payer paying
    // both shows the effect. Linear weighting would give Small a ~1e-6 share; log keeps it ~1/3.
    const seeds = new Map([["0xp", 1]]);
    const scores = computeFlowReputation(
      [edge("0xp", "0xBig", 1_000_000n * ETH), edge("0xp", "0xSmall", ETH)],
      NOW,
      params({ seeds }),
    );
    const big = scores.get("0xbig") ?? 0;
    const small = scores.get("0xsmall") ?? 0;
    expect(big).toBeGreaterThan(small); // more value → more of the payer's trust
    expect(small / big).toBeGreaterThan(0.01); // …but not dwarfed to ~zero (log compression)
  });

  it("decays over time: a payer's trust flows to its recent endorsement over an ancient one", () => {
    // Same structure note: decay shifts ONE payer's split between two targets of equal value.
    const seeds = new Map([["0xs", 1]]);
    const ancient = NOW - DEFAULT_FLOW_PARAMS.halfLifeSecs * 6; // ~6 half-lives → ~1.5% weight
    const scores = computeFlowReputation(
      [edge("0xs", "0xRecent", ETH, RECENT), edge("0xs", "0xOld", ETH, ancient)],
      NOW,
      params({ seeds }),
    );
    expect((scores.get("0xrecent") ?? 0)).toBeGreaterThan(scores.get("0xold") ?? 0);
  });

  it("rewards distinct counterparties over repetition: 10 distinct payers beat 1 payer repeating", () => {
    // All payers seeded equally so the difference is purely structural (distinct vs repeat).
    const distinctPayers = Array.from({ length: 10 }, (_, i) => `0xd${i}`);
    const seeds = new Map<string, number>([...distinctPayers.map((p) => [p, 1] as [string, number]), ["0xrep", 1]]);

    const repeatEdges = Array.from({ length: 10 }, (_, i) => edge("0xrep", "0xB", ETH, RECENT - i)); // 1 payer ×10
    const distinctEdges = distinctPayers.map((p) => edge(p, "0xC", ETH)); // 10 distinct payers ×1

    const scores = computeFlowReputation([...repeatEdges, ...distinctEdges], NOW, params({ seeds }));
    expect((scores.get("0xc") ?? 0)).toBeGreaterThan(scores.get("0xb") ?? 0);
  });

  it("ignores self-edges: a provider paying itself earns nothing (mirrors on-chain Tier-0 guard)", () => {
    const seeds = new Map([["0xself", 1]]);
    const edges = Array.from({ length: 50 }, (_, i) => edge("0xself", "0xself", ETH, RECENT - i));
    const scores = computeFlowReputation(edges, NOW, params({ seeds }));
    expect(scores.size).toBe(0); // no non-self edges ⇒ empty graph
  });

  // ── The security headline + its honest limit ──────────────────────────────
  it("SEEDED: a Sybil ring cannot bootstrap reputation — seeded provider crushes the whole ring", () => {
    const seeds = new Map([["0xseed", 1]]);
    const legit = [edge("0xseed", "0xLegit", ETH)]; // one trusted seed endorses a real provider

    // 5-wallet ring, fully connected, each pays the others a healthy priced amount, recent — none seeded.
    const ring: FlowEdge[] = [];
    const r = ["0xr0", "0xr1", "0xr2", "0xr3", "0xr4"];
    for (const a of r) for (const b of r) if (a !== b) ring.push(edge(a, b, ETH));

    const scores = computeFlowReputation([...legit, ...ring], NOW, params({ seeds }));
    const legitScore = scores.get("0xlegit") ?? 0;
    const ringMax = Math.max(...r.map((x) => scores.get(x) ?? 0));

    expect(legitScore).toBeGreaterThan(0);
    // The ring has no seed inflow → its mutual endorsements propagate ~zero. Non-bootstrappable.
    expect(ringMax).toBeLessThan(legitScore * 0.01);
  });

  it("SEEDLESS (honest limit): without seeds the same ring becomes competitive — only 'raises the bar'", () => {
    const payer = [edge("0xpayer", "0xLegit", ETH)];
    const ring: FlowEdge[] = [];
    const r = ["0xr0", "0xr1", "0xr2", "0xr3", "0xr4"];
    for (const a of r) for (const b of r) if (a !== b) ring.push(edge(a, b, ETH));

    const scores = computeFlowReputation([...payer, ...ring], NOW, params({ seeds: undefined }));
    const legitScore = scores.get("0xlegit") ?? 0;
    const ringMax = Math.max(...r.map((x) => scores.get(x) ?? 0));

    // Documented limitation: seedless mode is value/decay/saturation-weighted PageRank — a dense ring
    // is NOT crushed (it is competitive with a singly-endorsed provider). Full closure needs seeds
    // (Tier-2 bond). This test fails loudly if someone ever claims seedless mode is Sybil-proof.
    expect(ringMax).toBeGreaterThan(legitScore * 0.5);
  });
});

describe("FlowReputationGraph", () => {
  it("drops self-edges and bounds retained edges (DoS cap)", () => {
    const g = new FlowReputationGraph(DEFAULT_FLOW_PARAMS, 3);
    g.addEdge(edge("0xa", "0xa")); // self → dropped
    expect(g.edgeCount()).toBe(0);
    for (let i = 0; i < 10; i++) g.addEdge(edge(`0xfrom${i}`, "0xto"));
    expect(g.edgeCount()).toBe(3); // capped to the 3 most recent
  });

  it("a bonded seed (Tier-2) crushes an unbonded Sybil ring's discovery boost", () => {
    const src = new FlowBoostSource();
    src.record(edge("0xpayer", "0xlegit", ETH)); // payer endorses a real provider
    const r = ["0xr0", "0xr1", "0xr2", "0xr3", "0xr4"];
    for (const a of r) for (const b of r) if (a !== b) src.record(edge(a, b, ETH)); // dense ring
    src.setBondSeed("0xpayer", 5n * ETH); // ONLY the payer bonds → only it originates trust

    const legit = src.boostFor("0xlegit", NOW);
    const ringMax = Math.max(...r.map((x) => src.boostFor(x, NOW)));
    expect(legit).toBeGreaterThan(1);
    expect(ringMax).toBeLessThan(1.01); // no bonded seed reaches the ring → ~no boost
  });

  it("clearing the bond seed (after unlock) lets the ring become competitive again", () => {
    const src = new FlowBoostSource();
    src.record(edge("0xpayer", "0xlegit", ETH));
    const r = ["0xr0", "0xr1", "0xr2", "0xr3", "0xr4"];
    for (const a of r) for (const b of r) if (a !== b) src.record(edge(a, b, ETH));

    src.setBondSeed("0xpayer", 5n * ETH);
    const ringSeeded = Math.max(...r.map((x) => src.boostFor(x, NOW)));
    src.setBondSeed("0xpayer", 0n); // bond unlocked → seed removed → seedless mode
    const ringUnseeded = Math.max(...r.map((x) => src.boostFor(x, NOW)));
    expect(ringUnseeded).toBeGreaterThan(ringSeeded); // bar drops without the bonded seed
  });

  it("seedWeightFromBond is log-compressed (whale bond cannot linearly dominate) and 0 for no bond", () => {
    expect(seedWeightFromBond(0n)).toBe(0);
    const small = seedWeightFromBond(ETH);
    const huge = seedWeightFromBond(1_000_000n * ETH);
    expect(huge).toBeGreaterThan(small);
    expect(huge / small).toBeLessThan(5); // 1e6× the bond → < 5× the seed weight (log compression)
  });

  it("computeBoosts yields factors in [1,2], monotonic in endorsement, global max at 2.0", () => {
    const g = new FlowReputationGraph(params({ seeds: new Map([["0xseed", 1]]) }));
    g.addEdge(edge("0xseed", "0xtop", 1000n * ETH)); // strongly endorsed provider
    g.addEdge(edge("0xseed", "0xlow", ETH)); // weakly endorsed provider
    const boosts = g.computeBoosts(NOW);
    for (const v of boosts.values()) {
      expect(v).toBeGreaterThan(1);
      expect(v).toBeLessThanOrEqual(2);
    }
    expect(Math.max(...boosts.values())).toBeCloseTo(2.0, 5); // max-normalized: the top scorer hits 2.0
    expect(boosts.get("0xtop")!).toBeGreaterThan(boosts.get("0xlow")!); // more endorsement → higher boost
    // an owner with no inbound endorsement is absent (caller defaults to 1)
    expect(boosts.get("0xunknown")).toBeUndefined();
  });

  // L3: edge cap — default raised to 500k for dense-graph correctness; env-overridable
  it("DEFAULT_MAX_FLOW_EDGES is 500_000 (raised from 50k to cover 30-day window for dense graphs)", () => {
    expect(DEFAULT_MAX_FLOW_EDGES).toBe(500_000);
  });

  it("FlowReputationGraph evicts oldest edges beyond maxEdges cap", () => {
    const graph = new FlowReputationGraph(DEFAULT_FLOW_PARAMS, 3);
    const edge = (n: number): FlowEdge => ({ from: "0xa", to: "0xb", valueWei: 1n, timestamp: n });
    graph.addEdge(edge(1));
    graph.addEdge(edge(2));
    graph.addEdge(edge(3));
    graph.addEdge(edge(4)); // triggers eviction of edge(1)
    expect(graph.edgeCount()).toBe(3);
  });
});
