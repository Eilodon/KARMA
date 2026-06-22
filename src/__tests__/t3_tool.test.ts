import { describe, it, expect, vi, beforeEach } from "vitest";
import { markTrustedRuntime, resetTrustedRuntimeForTest } from "../core/runtime_identity.js";

// Shared mock fn referenced both inside the vi.mock factory (constructor wiring) and
// from individual test bodies (to control success/failure per test) — vi.hoisted is
// required because vi.mock factories are hoisted above normal module-scope const decls.
const { mockExecuteAndDecode, mockCreatePolicy, mockSetGrants, mockRevokeDelegation } = vi.hoisted(() => ({
  mockExecuteAndDecode: vi.fn(async () => ({ status: "validated", ok: true })),
  mockCreatePolicy: vi.fn(async () => ({ status: "created", tx_hash: "0xpolicytx" })),
  mockSetGrants: vi.fn(async () => ({ status: "created", tx_hash: "0xgranttx" })),
  mockRevokeDelegation: vi.fn(async (opts: { revokedFunctions?: string[] }) => ({
    vcId: "mock-vc-id",
    revokedFunctions: opts.revokedFunctions ?? null,
  })),
}));

// Mock T3N SDK before importing the plugin so module-level init is skipped.
vi.mock("@terminal3/t3n-sdk", () => ({
  loadWasmComponent: vi.fn(async () => ({ type: "mock-wasm" })),
  // Regular function (not arrow) so it can be used as a constructor with `new`.
  T3nClient: vi.fn(function MockT3nClient(this: Record<string, unknown>) {
    this.handshake = vi.fn(async () => ({ sessionId: { value: "mock-session" }, expiry: 0, authenticated: false }));
    this.authenticate = vi.fn(async () => "did:t3n:deadbeef01234567");
    this.getUsage = vi.fn(async () => ({
      tokens_remaining: 19500,
      tokens_consumed: 500,
      calls_made: 3,
    }));
    this.getAuditEvents = vi.fn(async () => [
      { timestamp: 1750000000, action: "authenticate", did: "did:t3n:deadbeef01234567", result: "ok" },
    ]);
    this.getDid = vi.fn(() => "did:t3n:deadbeef01234567");
    this.isAuthenticated = vi.fn(() => true);
    this.executeAndDecode = mockExecuteAndDecode;
  }),
  createEthAuthInput: vi.fn((addr: string) => ({ method: 0, address: addr })),
  getNodeUrl: vi.fn(() => "https://testnet.terminal3.io"),
  getScriptVersion: vi.fn(async () => "2.0.0"),
  eip191Digest: vi.fn(() => new Uint8Array(32).fill(0xab)),
  compactDidFromBytes: vi.fn(() => "did:t3n:857c2f11e9edddC7ddc03d035b0998de"),
  PAYROLL_FUNCTIONS_V1: ["compute-payroll", "execute-disbursement", "finalize-audit", "submit-escalations", "validate-credentials"],
  b64uEncodeBytes: vi.fn((bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")),
  buildDelegationCredential: vi.fn((opts: Record<string, unknown>) => ({ v: "ot3.delegation/1", ...opts })),
  buildPayrollDirectInvocation: vi.fn((opts: { request: unknown }) => ({ request: opts.request })),
  // Regular function (not arrow) — same constructor-mock rule as T3nClient above.
  DelegationCustodialClient: vi.fn(function MockDelegationCustodialClient(this: Record<string, unknown>) {
    this.signCustodial = vi.fn(async () => ({
      credentialJcs: new Uint8Array([1, 2, 3]),
      userSig: new Uint8Array([4, 5, 6]),
    }));
  }),
  createOrgDataClientFromSession: vi.fn(() => ({
    createPolicy: mockCreatePolicy,
    setGrants: mockSetGrants,
  })),
  revokeDelegation: mockRevokeDelegation,
}));

// Mock keystoreManager singleton.
vi.mock("../lib/keystore.js", () => ({
  keystoreManager: {
    has: vi.fn((id: string) => id === "agent-alpha"),
    getAccount: vi.fn(() => ({
      address: "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec",
      // 65-byte uncompressed secp256k1 pubkey — 04 + x(32) + y(32), even y → 02 compressed
      publicKey: `0x04${"ab".repeat(32)}${"02".repeat(32)}`,
      signMessage: vi.fn(async () => "0xmocksignature"),
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

describe("t3.tool.ts — t3_get_usage", () => {
  beforeEach(() => {
    resetTrustedRuntimeForTest();
    markTrustedRuntime();
    clearVerifiedDidsForTest();
  });

  it("rejects when agent not T3N-verified", async () => {
    const tools = createT3Tools();
    const getUsage = tools.find(t => t.name === "t3_get_usage")!;
    await expect(
      getUsage.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined),
    ).rejects.toThrow(/not t3n-verified|t3_verify_identity/i);
  });

  it("returns token usage stats after T3N verification", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const getUsage = tools.find(t => t.name === "t3_get_usage")!;
    const res = await getUsage.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    expect(res.structuredContent).toMatchObject({
      agent_id: "agent-alpha",
      did: "did:t3n:deadbeef01234567",
      tokens_remaining: 19500,
      tokens_consumed: 500,
    });
  });
});

describe("t3.tool.ts — t3_get_audit_events", () => {
  beforeEach(() => {
    resetTrustedRuntimeForTest();
    markTrustedRuntime();
    clearVerifiedDidsForTest();
  });

  it("rejects when agent not T3N-verified", async () => {
    const tools = createT3Tools();
    const getAudit = tools.find(t => t.name === "t3_get_audit_events")!;
    await expect(
      getAudit.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined),
    ).rejects.toThrow(/not t3n-verified|t3_verify_identity/i);
  });

  it("returns TEE audit events after T3N verification", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const getAudit = tools.find(t => t.name === "t3_get_audit_events")!;
    const res = await getAudit.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    expect(res.structuredContent).toMatchObject({
      agent_id: "agent-alpha",
      did: "did:t3n:deadbeef01234567",
      event_count: 1,
    });
    expect(Array.isArray((res.structuredContent as Record<string, unknown>).events)).toBe(true);
  });
});

describe("t3.tool.ts — t3_sign_job_commitment", () => {
  beforeEach(() => {
    resetTrustedRuntimeForTest();
    markTrustedRuntime();
    clearVerifiedDidsForTest();
  });

  it("rejects when agent not T3N-verified", async () => {
    const tools = createT3Tools();
    const sign = tools.find(t => t.name === "t3_sign_job_commitment")!;
    await expect(
      sign.handler(
        { agent_id: "agent-alpha", job_id: "42", skill_id: "7" },
        {} as never, undefined, undefined,
      ),
    ).rejects.toThrow(/not t3n-verified|t3_verify_identity/i);
  });

  it("produces signed commitment receipt with digest and compact DID", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const sign = tools.find(t => t.name === "t3_sign_job_commitment")!;
    const res = await sign.handler(
      { agent_id: "agent-alpha", job_id: "42", skill_id: "7" },
      {} as never, undefined, undefined,
    );
    expect(res.structuredContent).toMatchObject({
      job_id: "42",
      skill_id: "7",
      did: "did:t3n:deadbeef01234567",
      compact_did: "did:t3n:857c2f11e9edddC7ddc03d035b0998de",
      signature: "0xmocksignature",
    });
    const sc = res.structuredContent as Record<string, unknown>;
    expect(typeof sc.digest_hex).toBe("string");
    expect((sc.digest_hex as string).startsWith("0x")).toBe(true);
    expect(typeof sc.commitment_payload).toBe("string");
    expect((sc.commitment_payload as string)).toContain("job_id=42");
  });
});

describe("t3.tool.ts — t3_authorize_payroll_agent", () => {
  beforeEach(() => {
    resetTrustedRuntimeForTest();
    markTrustedRuntime();
    clearVerifiedDidsForTest();
    mockExecuteAndDecode.mockClear();
    mockExecuteAndDecode.mockImplementation(async () => ({ status: "validated", ok: true }));
    mockCreatePolicy.mockClear();
    mockCreatePolicy.mockImplementation(async () => ({ status: "created", tx_hash: "0xpolicytx" }));
    mockSetGrants.mockClear();
    mockSetGrants.mockImplementation(async () => ({ status: "created", tx_hash: "0xgranttx" }));
  });

  it("rejects when agent not T3N-verified", async () => {
    const tools = createT3Tools();
    const authorize = tools.find(t => t.name === "t3_authorize_payroll_agent")!;
    await expect(
      authorize.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined),
    ).rejects.toThrow(/not t3n-verified|t3_verify_identity/i);
  });

  it("issues a signed, bounded delegation credential defaulting to validate-credentials", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const authorize = tools.find(t => t.name === "t3_authorize_payroll_agent")!;
    const res = await authorize.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      agent_id: "agent-alpha",
      did: "did:t3n:deadbeef01234567",
      credential_issued: true,
      functions_authorised: ["validate-credentials"],
      batch_cap_cents: "100000",
    });
    expect(typeof sc.vc_id_b64u).toBe("string");
    expect((sc.credential_jcs_hex as string).startsWith("0x")).toBe(true);
    expect((sc.user_sig_hex as string).startsWith("0x")).toBe(true);
    expect(new Date(sc.not_after as string).getTime()).toBeGreaterThan(new Date(sc.not_before as string).getTime());
  });

  it("sorts and dedupes requested functions", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const authorize = tools.find(t => t.name === "t3_authorize_payroll_agent")!;
    const res = await authorize.handler(
      { agent_id: "agent-alpha", functions: ["execute-disbursement", "compute-payroll", "compute-payroll"] },
      {} as never, undefined, undefined,
    );
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.functions_authorised).toEqual(["compute-payroll", "execute-disbursement"]);
  });

  it("degrades gracefully when direct invocation is rejected at the org-grant boundary", async () => {
    mockExecuteAndDecode.mockRejectedValueOnce(new Error("org grant required: OrgContractGrants[tee:payroll]"));

    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const authorize = tools.find(t => t.name === "t3_authorize_payroll_agent")!;
    const res = await authorize.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    const sc = res.structuredContent as Record<string, unknown>;

    // Credential issuance must still have succeeded — it is independent of the invocation attempt.
    expect(sc.credential_issued).toBe(true);
    expect(sc.invocation_attempted).toBe(true);
    expect(sc.invocation_succeeded).toBe(false);
    expect(sc.invocation_error as string).toContain("org grant required");
    expect(typeof sc.invocation_note).toBe("string");
  });

  it("reports a successful direct invocation when the org grant allows it", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const authorize = tools.find(t => t.name === "t3_authorize_payroll_agent")!;
    const res = await authorize.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.invocation_attempted).toBe(true);
    expect(sc.invocation_succeeded).toBe(true);
    expect(sc.invocation_result).toMatchObject({ status: "validated" });
  });

  it("self-provisions an org grant via SessionOrgDataClient before attempting invocation", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const authorize = tools.find(t => t.name === "t3_authorize_payroll_agent")!;
    const res = await authorize.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.grant_provisioning_attempted).toBe(true);
    expect(sc.grant_provisioned).toBe(true);
    expect(mockCreatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ orgDid: "did:t3n:deadbeef01234567", initialAdminDid: "did:t3n:deadbeef01234567" }),
    );
    expect(mockSetGrants).toHaveBeenCalledWith(
      expect.objectContaining({ orgDid: "did:t3n:deadbeef01234567", contractId: "tee:payroll" }),
    );
  });

  it("degrades gracefully when self-grant provisioning fails, independent of credential issuance", async () => {
    mockSetGrants.mockRejectedValueOnce(new Error("admin grant denied: not an org admin"));

    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const authorize = tools.find(t => t.name === "t3_authorize_payroll_agent")!;
    const res = await authorize.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    const sc = res.structuredContent as Record<string, unknown>;

    expect(sc.credential_issued).toBe(true);
    expect(sc.grant_provisioning_attempted).toBe(true);
    expect(sc.grant_provisioned).toBe(false);
    expect(sc.grant_provisioning_error as string).toContain("admin grant denied");
  });
});

describe("t3.tool.ts — t3_revoke_payroll_authorization", () => {
  beforeEach(() => {
    resetTrustedRuntimeForTest();
    markTrustedRuntime();
    clearVerifiedDidsForTest();
    mockRevokeDelegation.mockClear();
  });

  it("rejects when no credential has been issued for this agent", async () => {
    const tools = createT3Tools();
    const revoke = tools.find(t => t.name === "t3_revoke_payroll_authorization")!;
    await expect(
      revoke.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined),
    ).rejects.toThrow(/no issued credential|t3_authorize_payroll_agent/i);
  });

  it("revokes the whole credential when no functions are specified", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    const authorize = tools.find(t => t.name === "t3_authorize_payroll_agent")!;
    await authorize.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);

    const revoke = tools.find(t => t.name === "t3_revoke_payroll_authorization")!;
    const res = await revoke.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.revoked_entirely).toBe(true);
    expect(sc.revoked_functions).toBeNull();
    expect(mockRevokeDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ revokedFunctions: undefined }),
    );
  });

  it("narrows the credential when specific functions are revoked", async () => {
    const tools = createT3Tools();
    const verify = tools.find(t => t.name === "t3_verify_identity")!;
    await verify.handler({ agent_id: "agent-alpha" }, {} as never, undefined, undefined);
    const authorize = tools.find(t => t.name === "t3_authorize_payroll_agent")!;
    await authorize.handler(
      { agent_id: "agent-alpha", functions: ["compute-payroll", "validate-credentials"] },
      {} as never, undefined, undefined,
    );

    const revoke = tools.find(t => t.name === "t3_revoke_payroll_authorization")!;
    const res = await revoke.handler(
      { agent_id: "agent-alpha", functions: ["compute-payroll"] },
      {} as never, undefined, undefined,
    );
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.revoked_entirely).toBe(false);
    expect(sc.revoked_functions).toEqual(["compute-payroll"]);
  });
});
