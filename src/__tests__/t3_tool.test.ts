import { describe, it, expect, vi, beforeEach } from "vitest";
import { markTrustedRuntime, resetTrustedRuntimeForTest } from "../core/runtime_identity.js";

// Mock T3N SDK before importing the plugin so module-level init is skipped.
vi.mock("@terminal3/t3n-sdk", () => ({
  loadWasmComponent: vi.fn(async () => ({ type: "mock-wasm" })),
  T3nClient: vi.fn().mockImplementation(() => ({
    authenticate: vi.fn(async () => "did:t3n:deadbeef01234567"),
  })),
  createEthAuthInput: vi.fn((addr: string) => ({ method: 0, address: addr })),
  getNodeUrl: vi.fn(() => "https://testnet.terminal3.io"),
}));

// Mock keystoreManager singleton.
vi.mock("../lib/keystore.js", () => ({
  keystoreManager: {
    has: vi.fn((id: string) => id === "agent-alpha"),
    getAccount: vi.fn(() => ({
      address: "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec",
      signMessage: vi.fn(async () => "0xsignature"),
    })),
    getAddress: vi.fn(() => "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec"),
    getTenant: vi.fn(() => "tenant_local"),
  },
}));

// Mock realKarmaService.
vi.mock("../lib/karma_service.js", () => ({
  realKarmaService: {
    getReputation: vi.fn(() => 60),
    getSkillThreshold: vi.fn(() => 55),
    deriveTaskHash: vi.fn(() => `0x${"ab".repeat(32)}`),
    findExistingJob: vi.fn(async () => null),
    createJob: vi.fn(async () => ({
      jobId: 42n,
      outcome: { status: "confirmed", hash: "0xtx", receipt: {} },
    })),
    account: vi.fn(() => ({ address: "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" })),
  },
}));

// Dynamic import AFTER mocks are registered.
const { createT3Tools, getVerifiedDid, clearVerifiedDidsForTest } =
  await import("../plugins/t3.tool.js");

describe("t3.tool.ts — t3_health", () => {
  beforeEach(() => {
    resetTrustedRuntimeForTest();
    markTrustedRuntime();
    clearVerifiedDidsForTest();
  });

  it("returns wasmLoaded:true when WASM mock resolves", async () => {
    const tools = createT3Tools();
    const health = tools.find(t => t.name === "t3_health")!;
    const res = await health.handler({}, {} as never, undefined, undefined);
    expect(res.structuredContent).toMatchObject({ wasmLoaded: true });
  });
});

describe("t3.tool.ts — t3_verify_identity", () => {
  beforeEach(() => {
    resetTrustedRuntimeForTest();
    markTrustedRuntime();
    clearVerifiedDidsForTest();
  });

  it("stores DID in module cache on successful authenticate", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    const res = await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    expect(res.structuredContent).toMatchObject({ did: "did:t3n:deadbeef01234567", verified: true });
    expect(getVerifiedDid("agent-alpha")).toBe("did:t3n:deadbeef01234567");
  });

  it("rejects when agent_id not found in keystore", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await expect(
      verify.handler({ agent_id: "unknown-agent" }, {} as never, undefined, undefined),
    ).rejects.toThrow(/not found in keystore/i);
  });
});

describe("t3.tool.ts — t3_create_verified_job", () => {
  beforeEach(() => {
    resetTrustedRuntimeForTest();
    markTrustedRuntime();
    clearVerifiedDidsForTest();
  });

  it("rejects when T3N identity not verified (T3N gate)", async () => {
    const tools = createT3Tools();
    const createJob = tools.find(t => t.name === "t3_create_verified_job")!;
    await expect(
      createJob.handler(
        { agent_id: "agent-alpha", skill_id: "7", deadline_secs: 3600, value_wei: "1000" },
        {} as never, undefined, undefined,
      ),
    ).rejects.toThrow(/t3_verify_identity/i);
  });

  it("rejects with insufficient reputation even after T3N verify (reputation gate)", async () => {
    const { realKarmaService } = await import("../lib/karma_service.js");
    vi.mocked(realKarmaService.getReputation).mockReturnValueOnce(40);
    vi.mocked(realKarmaService.getSkillThreshold).mockReturnValueOnce(55);

    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const createJob = tools.find(t => t.name === "t3_create_verified_job")!;
    await expect(
      createJob.handler(
        { agent_id: "agent-alpha", skill_id: "7", deadline_secs: 3600, value_wei: "1000" },
        {} as never, undefined, undefined,
      ),
    ).rejects.toThrow(/reputation.*40.*55|trust gate/i);
  });

  it("creates job when both T3N identity AND reputation gates pass (dual-layer trust)", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const createJob = tools.find(t => t.name === "t3_create_verified_job")!;
    const res = await createJob.handler(
      { agent_id: "agent-alpha", skill_id: "7", deadline_secs: 3600, value_wei: "1000" },
      {} as never, undefined, undefined,
    );
    expect(res.structuredContent).toMatchObject({
      jobId: "42",
      t3n_did: "did:t3n:deadbeef01234567",
    });
  });
});
