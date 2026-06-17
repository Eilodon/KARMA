import { describe, it, expect } from "vitest";
import { planMigration, type V1Skill } from "../scripts/migrate_to_v2.js";

const ALPHA = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec";
const BETA = "0xB2c3d4E5f6a7b8C9d0e1F2a3b4C5d6E7f8a9B0c1";
const GAMMA = "0xC3d4e5F6a7b8c9D0e1f2A3b4c5D6e7f8A9b0C1d2";

const skill = (over: Partial<V1Skill>): V1Skill => ({
  skillId: 1n, owner: ALPHA as never, name: "s", description: "d", mcpEndpoint: "mcp://x",
  pricePerCall: 1000n, active: true, ...over,
});

describe("planMigration (v1 → v2)", () => {
  it("keeps only active skills owned by a keystore agent, in id order, threshold defaulted to 0", () => {
    const skills = [
      skill({ skillId: 3n, owner: ALPHA as never, name: "c" }),
      skill({ skillId: 1n, owner: BETA as never, name: "a" }),
      skill({ skillId: 2n, owner: GAMMA as never, name: "b" }), // not owned → dropped
      skill({ skillId: 4n, owner: ALPHA as never, name: "inactive", active: false }), // inactive → dropped
    ];
    const plan = planMigration(skills, [ALPHA, BETA]);
    expect(plan.map(p => p.oldSkillId)).toEqual([1n, 3n]); // sorted, only owned+active
    expect(plan.every(p => p.minReputationToInvoke === 0n)).toBe(true);
    expect(plan[0]).toMatchObject({ owner: BETA, name: "a", pricePerCall: 1000n });
  });

  it("is case-insensitive on owner address matching", () => {
    const plan = planMigration([skill({ owner: ALPHA.toUpperCase() as never })], [ALPHA.toLowerCase()]);
    expect(plan).toHaveLength(1);
  });

  it("returns empty when nothing is owned", () => {
    expect(planMigration([skill({ owner: GAMMA as never })], [ALPHA, BETA])).toEqual([]);
  });
});
