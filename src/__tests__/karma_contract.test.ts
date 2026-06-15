import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  pharosAtlantic,
  getPublicClient,
  RECEIPT_TIMEOUT_MS,
  MCP_LOCK_TTL_MS,
} from "../lib/contract.js";
import { agentSkillRegistryAbi } from "../lib/abi.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = resolve(HERE, "../../out/AgentSkillRegistry.sol/AgentSkillRegistry.json");

describe("P4.1 pharos chain + clients", () => {
  it("defines Pharos Atlantic with the live-verified chainId 688689 and PHRS currency", () => {
    expect(pharosAtlantic.id).toBe(688689);
    expect(pharosAtlantic.nativeCurrency.symbol).toBe("PHRS");
    expect(pharosAtlantic.nativeCurrency.decimals).toBe(18);
    expect(pharosAtlantic.rpcUrls.default.http[0]).toMatch(/^https?:\/\//);
  });

  it("constructs a public client bound to the Pharos chain", () => {
    const client = getPublicClient();
    expect(client.chain?.id).toBe(688689);
  });

  it("keeps the receipt-wait timeout strictly below the MCP execution-lock TTL (Abductive-1)", () => {
    // A receipt wait must give up before the distributed lock can expire, or two
    // workers could both believe they own the same job. 420000 = MCP_LOCK_TTL_MS.
    expect(MCP_LOCK_TTL_MS).toBe(420_000);
    expect(RECEIPT_TIMEOUT_MS).toBeLessThan(MCP_LOCK_TTL_MS);
  });
});

// Structural drift guard: compares the hand-maintained ABI against the compiled
// forge artifact by SHAPE (entry type+name, param types, indexed, stateMutability),
// ignoring parameter names and internalType. Fails if the .sol changes without a
// matching abi.ts update. Skips cleanly when forge has not built (e.g. CI w/o foundry).
type AbiParam = { type: string; indexed?: boolean; components?: AbiParam[] };
type AbiEntry = {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
};

function shape(entry: AbiEntry) {
  const param = (p: AbiParam): unknown => ({
    type: p.type,
    indexed: p.indexed ?? false,
    components: p.components?.map(param),
  });
  return {
    type: entry.type,
    name: entry.name ?? "",
    stateMutability: entry.stateMutability ?? "",
    inputs: (entry.inputs ?? []).map(param),
    outputs: (entry.outputs ?? []).map(param),
  };
}

const canonical = (e: AbiEntry) => `${e.type}:${e.name ?? ""}:${(e.inputs ?? []).map((i) => i.type).join(",")}`;
const normalize = (abi: AbiEntry[]) =>
  abi
    .filter((e) => e.type === "function" || e.type === "event")
    .map(shape)
    .sort((a, b) => canonical(a as AbiEntry).localeCompare(canonical(b as AbiEntry)));

const hasArtifact = existsSync(ARTIFACT);

(hasArtifact ? describe : describe.skip)("P4.1 ABI drift guard", () => {
  it("agentSkillRegistryAbi structurally matches the compiled forge artifact", () => {
    const artifactAbi = JSON.parse(readFileSync(ARTIFACT, "utf8")).abi as AbiEntry[];
    expect(normalize(agentSkillRegistryAbi as unknown as AbiEntry[])).toEqual(normalize(artifactAbi));
  });
});
