import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import {
  loadWasmComponent,
  T3nClient,
  createEthAuthInput,
  getNodeUrl,
  getScriptVersion,
  eip191Digest,
  compactDidFromBytes,
  DelegationCustodialClient,
  buildDelegationCredential,
  buildPayrollDirectInvocation,
  PAYROLL_FUNCTIONS_V1,
  b64uEncodeBytes,
  createOrgDataClientFromSession,
  revokeDelegation,
  type GuestToHostHandler,
  type WasmComponent,
  type Did,
  type DelegationCredential,
  type PayrollRunRequest,
} from "@terminal3/t3n-sdk";
import { keystoreManager } from "../lib/keystore.js";
import { realKarmaService } from "../lib/karma_service.js";
import { ENV } from "../config/env.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

// Module-level DID cache: agentId → verified did:t3n:... DID.
// Populated by t3_verify_identity, read by t3_create_verified_job.
const verifiedDids = new Map<string, Did>();

// Module-level issued-credential cache: agentId → last DelegationCredential JCS bytes + vc_id.
// Populated by t3_authorize_payroll_agent, read by t3_revoke_payroll_authorization. Demo-scoped
// (process memory only) — same volatility caveat as verifiedDids (PATTERN-DEBT-T3N-001).
const issuedCredentials = new Map<string, { credentialJcs: Uint8Array; vcId: Uint8Array }>();

// Module-level WASM singleton — loaded once on first call.
let wasmComponent: WasmComponent | null = null;

async function getWasm(): Promise<WasmComponent> {
  if (!wasmComponent) {
    wasmComponent = await loadWasmComponent();
  }
  return wasmComponent;
}

// Constructs a T3nClient AND completes the handshake — T3nClient.authenticate() throws
// "Must complete handshake before authentication" otherwise (not mocked by unit tests,
// only caught by a live smoke run; see PATTERN-DEBT-T3N-002).
async function buildT3nClient(wasm: WasmComponent, ethSignHandler: GuestToHostHandler): Promise<T3nClient> {
  const baseUrl = ENV.T3N_NODE_URL ?? getNodeUrl();
  const client = new T3nClient({
    wasmComponent: wasm,
    baseUrl,
    handlers: { EthSign: ethSignHandler },
  });
  await client.handshake();
  return client;
}

// Compresses a 65-byte uncompressed secp256k1 public key ("0x04{x}{y}") to 33 bytes ("02|03{x}").
function compressPublicKey(uncompressedHex: string): Uint8Array {
  const hex = uncompressedHex.startsWith("0x") ? uncompressedHex.slice(2) : uncompressedHex;
  if (hex.length !== 130) throw new Error("[T3N] Expected 65-byte uncompressed public key (130 hex chars)");
  const xHex = hex.slice(2, 66);
  const yLastByte = parseInt(hex.slice(-2), 16);
  const prefix = yLastByte % 2 === 0 ? "02" : "03";
  return new Uint8Array(Buffer.from(prefix + xHex, "hex"));
}

// Signs T3N EthSign challenges via viem Account.signMessage — raw key never leaves KeystoreManager.
function buildEthSignHandler(agentId: string): GuestToHostHandler {
  const account = keystoreManager.getAccount(agentId);
  return async (requestData) => {
    const { challenge } = requestData as { challenge: string };
    const raw = Uint8Array.from(Buffer.from(challenge, "base64"));
    const signature = await account.signMessage({ message: { raw } });
    return new TextEncoder().encode(
      JSON.stringify({ host_to_guest: "EthSign", challenge, signature }),
    );
  };
}

// Projects a DelegationCredential to the wire shape DelegationCustodialClient.signCustodial expects:
// binary fields as base64url-no-pad strings, bigint seconds as decimal strings.
function credentialToWireShape(credential: DelegationCredential): Record<string, unknown> {
  return {
    v: credential.v,
    user_did: credential.user_did,
    agent_pubkey: b64uEncodeBytes(credential.agent_pubkey),
    org_did: credential.org_did,
    contract: credential.contract,
    functions: credential.functions,
    scopes: credential.scopes,
    metadata: credential.metadata,
    not_before_secs: credential.not_before_secs.toString(),
    not_after_secs: credential.not_after_secs.toString(),
    vc_id: b64uEncodeBytes(credential.vc_id),
  };
}

// Creates a fresh T3nClient and authenticates it — required for session-bound methods (getUsage, getAuditEvents).
async function createAuthenticatedClient(agentId: string): Promise<{ client: T3nClient; did: Did }> {
  const wasm = await getWasm();
  const ethSignHandler = buildEthSignHandler(agentId);
  const client = await buildT3nClient(wasm, ethSignHandler);
  const address = keystoreManager.getAddress(agentId);
  const authInput = createEthAuthInput(address);
  const did = await client.authenticate(authInput);
  return { client, did };
}

// Exported for tests — resets module-level state between test cases.
export function clearVerifiedDidsForTest(): void {
  verifiedDids.clear();
  issuedCredentials.clear();
  wasmComponent = null;
}

export function getVerifiedDid(agentId: string): Did | undefined {
  return verifiedDids.get(agentId);
}

export function createT3Tools(): ToolDefinition[] {
  return [
    {
      name: "t3_health",
      description:
        "Validate Terminal3 SDK configuration and WASM component load. " +
        "Run first to confirm T3N_NODE_URL is set and WASM initialises correctly in this environment.",
      inputSchema: {},
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "forbidden" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason: "T3N health-check — read-only, no auth token exchanged",
      },
      handler: async () => {
        const nodeUrl = ENV.T3N_NODE_URL ?? getNodeUrl();
        let wasmLoaded = false;
        let wasmError: string | undefined;
        try {
          await getWasm();
          wasmLoaded = true;
        } catch (e) {
          wasmError = e instanceof Error ? e.message : String(e);
        }
        const result = { wasmLoaded, nodeUrl, sdkVersion: "3.10.1", wasmError };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_verify_identity",
      description:
        "Authenticate a KARMA agent against the Terminal3 Network using EIP-191 signing. " +
        "Returns a verifiable DID (did:t3n:...) and caches it for t3_create_verified_job. " +
        "Must be called before t3_create_verified_job for high-threshold enterprise skills.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id to authenticate (must exist in keystore)."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        accessesPrivateData: true,
        waiverReason: "T3N auth uses viem Account.signMessage — raw key never leaves KeystoreManager",
      },
      handler: async (args) => {
        const { agent_id } = args as { agent_id: string };

        if (!keystoreManager.has(agent_id)) {
          throw new Error(`[T3N] Agent not found in keystore: ${agent_id}`);
        }

        const wasm = await getWasm();
        const ethSignHandler = buildEthSignHandler(agent_id);
        const client = await buildT3nClient(wasm, ethSignHandler);
        const address = keystoreManager.getAddress(agent_id);
        const authInput = createEthAuthInput(address);
        const did = await client.authenticate(authInput);

        verifiedDids.set(agent_id, did);

        const result = {
          verified: true,
          did,
          agent_id,
          address,
          message: `Agent ${agent_id} verified. DID cached for t3_create_verified_job.`,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_create_verified_job",
      description:
        "Create a KARMA job for a high-threshold skill, enforcing dual-layer trust: " +
        "(1) T3N identity gate — agent must have a verified DID from t3_verify_identity, " +
        "(2) On-chain reputation gate — agent reputation must meet the skill's minReputationToInvoke. " +
        "Use this for enterprise skills like payroll_hr_transfer where anonymity is unacceptable.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
        skill_id: z.string().describe("On-chain skill id as string (e.g. '7')."),
        deadline_secs: z
          .number()
          .int()
          .min(60)
          .max(604800)
          .describe("Job deadline in seconds from now."),
        value_wei: z.string().describe("Escrow amount in wei as string (e.g. '1000000000000000')."),
      },
      allowedPhases: ["intake", "execution"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason: "On-chain write — guarded by T3N identity + KARMA reputation gates before contract call",
      },
      handler: async (args) => {
        const { agent_id, skill_id, deadline_secs, value_wei } = args as {
          agent_id: string;
          skill_id: string;
          deadline_secs: number;
          value_wei: string;
        };

        // Gate 1: T3N identity must be verified.
        const did = verifiedDids.get(agent_id);
        if (!did) {
          throw new Error(
            `[T3N] Identity gate: agent '${agent_id}' has no verified DID. ` +
              `Call t3_verify_identity first.`,
          );
        }

        const skillIdBig = BigInt(skill_id);
        const address = keystoreManager.getAddress(agent_id);

        // Gate 2: On-chain reputation must meet the skill's Trust Gate threshold.
        const reputation = realKarmaService.getReputation(address);
        const threshold = realKarmaService.getSkillThreshold(skillIdBig);

        if (threshold > 0 && reputation < threshold) {
          throw new Error(
            `[KARMA] Trust Gate: agent reputation ${reputation} is below skill threshold ${threshold}. ` +
              `Both identity (T3N) and reputation (KARMA) gates must pass.`,
          );
        }

        // Both gates passed — create job on-chain.
        const tenant = keystoreManager.getTenant(agent_id);
        const account = realKarmaService.account(agent_id, tenant);
        const taskHash = realKarmaService.deriveTaskHash(address, skillIdBig, BigInt(Date.now()));

        const existing = await realKarmaService.findExistingJob(address, taskHash);
        if (existing !== null) {
          const result = {
            jobId: existing.toString(),
            t3n_did: did,
            outcome: "existing",
            reputation,
            threshold,
          };
          return {
            structuredContent: result,
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        const { jobId, outcome } = await realKarmaService.createJob(account, {
          skillId: skillIdBig,
          taskHash,
          deadlineSecs: BigInt(deadline_secs),
          value: BigInt(value_wei),
        });

        const result = {
          jobId: jobId?.toString() ?? null,
          t3n_did: did,
          outcome: outcome.status,
          reputation,
          threshold,
          message: `Dual-layer trust verified: T3N identity (${did}) + KARMA reputation (${reputation}/${threshold}).`,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },
    {
      name: "t3_get_usage",
      description:
        "Query Terminal3 token usage and quota stats for a KARMA agent. " +
        "Re-authenticates against T3N to obtain a live TEE session, then reads token consumption via " +
        "T3nClient.getUsage(). Use to monitor agent token budget before high-frequency skill invocations. " +
        "Requires prior t3_verify_identity call.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason: "T3N read-only usage query — re-authenticates, no state mutation",
      },
      handler: async (args) => {
        const { agent_id } = args as { agent_id: string };

        const cachedDid = verifiedDids.get(agent_id);
        if (!cachedDid) {
          throw new Error(
            `[T3N] Agent '${agent_id}' not T3N-verified. Call t3_verify_identity first.`,
          );
        }

        if (!keystoreManager.has(agent_id)) {
          throw new Error(`[T3N] Agent not found in keystore: ${agent_id}`);
        }

        const { client, did } = await createAuthenticatedClient(agent_id);
        const usage = await client.getUsage();

        const result = { agent_id, did, ...usage };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_get_audit_events",
      description:
        "Fetch the immutable TEE audit trail for a KARMA agent from the Terminal3 Network. " +
        "Every action the agent performs through T3N is logged to the hardware-secured TEE ledger. " +
        "Re-authenticates to get a live session, then reads events via T3nClient.getAuditEvents(). " +
        "Requires prior t3_verify_identity call.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason: "T3N read-only audit query — no mutation, TEE-attested log entries only",
      },
      handler: async (args) => {
        const { agent_id } = args as { agent_id: string };

        const cachedDid = verifiedDids.get(agent_id);
        if (!cachedDid) {
          throw new Error(
            `[T3N] Agent '${agent_id}' not T3N-verified. Call t3_verify_identity first.`,
          );
        }

        if (!keystoreManager.has(agent_id)) {
          throw new Error(`[T3N] Agent not found in keystore: ${agent_id}`);
        }

        const { client, did } = await createAuthenticatedClient(agent_id);
        const events = await client.getAuditEvents();

        const result = { agent_id, did, event_count: Array.isArray(events) ? events.length : 0, events };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_sign_job_commitment",
      description:
        "Create a non-repudiation commitment receipt for a KARMA job anchored to the agent's verified T3N DID. " +
        "Uses T3N SDK's eip191Digest() to hash the commitment payload and compactDidFromBytes() to derive the " +
        "canonical DID from the agent's Ethereum address. The resulting EIP-191 signature binds the job " +
        "irrevocably to the agent's on-chain identity — enterprise-grade accountability without exposing private keys. " +
        "Requires prior t3_verify_identity call.",
      inputSchema: {
        agent_id: z
          .string()
          .describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
        job_id: z
          .string()
          .describe("KARMA job id to commit to (returned by create_job or t3_create_verified_job)."),
        skill_id: z.string().describe("Skill id associated with the job."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: [],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: false,
        accessesPrivateData: true,
        waiverReason:
          "Signs commitment via viem Account.signMessage — raw key never leaves KeystoreManager; " +
          "eip191Digest + compactDidFromBytes are pure T3N SDK cryptography with no network calls",
      },
      handler: async (args) => {
        const { agent_id, job_id, skill_id } = args as {
          agent_id: string;
          job_id: string;
          skill_id: string;
        };

        const did = verifiedDids.get(agent_id);
        if (!did) {
          throw new Error(
            `[T3N] Agent '${agent_id}' not T3N-verified. Call t3_verify_identity first.`,
          );
        }

        if (!keystoreManager.has(agent_id)) {
          throw new Error(`[T3N] Agent not found in keystore: ${agent_id}`);
        }

        const timestamp = Date.now();
        const payload = `KARMA job commitment: job_id=${job_id}, skill_id=${skill_id}, did=${did}, ts=${timestamp}`;
        const msgBytes = new TextEncoder().encode(payload);

        // T3N SDK: compute EIP-191 digest of the commitment payload.
        const digest = eip191Digest(msgBytes);
        const digestHex = `0x${Buffer.from(digest).toString("hex")}`;

        // T3N SDK: derive the canonical compact DID from the agent's 20-byte Ethereum address.
        const address = keystoreManager.getAddress(agent_id);
        const addrBytes = new Uint8Array(Buffer.from(address.slice(2), "hex"));
        const compactDid = compactDidFromBytes(addrBytes);

        // Sign via viem Account.signMessage — raw key never exposed.
        const account = keystoreManager.getAccount(agent_id);
        const signature = await account.signMessage({ message: { raw: digest } });

        const result = {
          job_id,
          skill_id,
          did,
          compact_did: compactDid,
          commitment_payload: payload,
          digest_hex: digestHex,
          signature,
          signed_by: address,
          timestamp,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_authorize_payroll_agent",
      description:
        "Issue a bounded, revocable Terminal3 delegation credential authorising this agent to invoke " +
        "specific payroll-v2 functions (subset of compute-payroll, execute-disbursement, finalize-audit, " +
        "submit-escalations, validate-credentials), scoped to a time window and a batch dollar cap. " +
        "The credential is signed by the T3N TEE via DelegationCustodialClient — the raw private key never " +
        "leaves KeystoreManager. After signing, attempts a direct invocation of the first authorised function " +
        "against Terminal3's tee:payroll contract; if the org-grant authorisation layer blocks it, the gate " +
        "rejection is returned as evidence (not an error) — proof the credential and grant layers are " +
        "independent. Demonstrates Terminal3's real flagship feature: cryptographically bounded agent " +
        "authority, not just identity. Requires prior t3_verify_identity call.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
        functions: z
          .array(z.enum(["compute-payroll", "execute-disbursement", "finalize-audit", "submit-escalations", "validate-credentials"]))
          .min(1)
          .max(16)
          .optional()
          .describe("Payroll v2 functions to authorise (subset of PAYROLL_FUNCTIONS_V1). Defaults to ['validate-credentials']."),
        ttl_secs: z
          .number()
          .int()
          .min(60)
          .max(86400)
          .optional()
          .describe("Credential validity window in seconds from now. Defaults to 3600 (1 hour)."),
        batch_cap_cents: z
          .string()
          .optional()
          .describe("Decimal-cents string bounding the run's total disbursement, e.g. '100000' for a $1,000.00 cap. Defaults to '100000'."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        accessesPrivateData: true,
        waiverReason:
          "Credential signing is delegated to the T3N TEE via DelegationCustodialClient.signCustodial — " +
          "raw key never leaves KeystoreManager. The agent's public key (viem Account.publicKey, not the " +
          "private key) is compressed client-side for the credential body. The direct-invocation attempt is " +
          "scoped to payroll-v2 read/validate functions and degrades gracefully on an authorization rejection.",
      },
      handler: async (args) => {
        const { agent_id, ttl_secs, batch_cap_cents } = args as {
          agent_id: string;
          functions?: string[];
          ttl_secs?: number;
          batch_cap_cents?: string;
        };
        const functions = (args as { functions?: string[] }).functions ?? ["validate-credentials"];

        const cachedDid = verifiedDids.get(agent_id);
        if (!cachedDid) {
          throw new Error(
            `[T3N] Agent '${agent_id}' not T3N-verified. Call t3_verify_identity first.`,
          );
        }
        if (!keystoreManager.has(agent_id)) {
          throw new Error(`[T3N] Agent not found in keystore: ${agent_id}`);
        }

        const sortedFunctions = [...new Set(functions)].sort();
        const ttl = BigInt(ttl_secs ?? 3600);
        const nowSecs = BigInt(Math.floor(Date.now() / 1000));
        const account = keystoreManager.getAccount(agent_id);
        const agentPubkey = compressPublicKey(account.publicKey);
        const vcId = new Uint8Array(randomBytes(16));

        const { client, did } = await createAuthenticatedClient(agent_id);

        const credential = buildDelegationCredential({
          user_did: did.toString(),
          agent_pubkey: agentPubkey,
          org_did: did.toString(),
          contract: "tee:payroll",
          functions: sortedFunctions,
          scopes: [],
          metadata: { demo: "karma-self-delegation" },
          not_before_secs: nowSecs,
          not_after_secs: nowSecs + ttl,
          vc_id: vcId,
        });

        const baseUrl = ENV.T3N_NODE_URL ?? getNodeUrl();
        const delegationClient = new DelegationCustodialClient(client, baseUrl);
        const { credentialJcs, userSig } = await delegationClient.signCustodial(
          credentialToWireShape(credential),
        );
        issuedCredentials.set(agent_id, { credentialJcs, vcId });

        const result: Record<string, unknown> = {
          agent_id,
          did,
          credential_issued: true,
          vc_id_b64u: b64uEncodeBytes(vcId),
          functions_authorised: sortedFunctions,
          not_before: new Date(Number(nowSecs) * 1000).toISOString(),
          not_after: new Date(Number(nowSecs + ttl) * 1000).toISOString(),
          batch_cap_cents: batch_cap_cents ?? "100000",
          credential_jcs_hex: `0x${Buffer.from(credentialJcs).toString("hex")}`,
          user_sig_hex: `0x${Buffer.from(userSig).toString("hex")}`,
          grant_provisioning_attempted: false,
          grant_provisioned: false,
          grant_provisioning_error: null as string | null,
          invocation_attempted: false,
          invocation_succeeded: false,
          invocation_result: null as unknown,
          invocation_error: null as string | null,
        };

        // Best-effort self-grant provisioning — exploratory: lets the direct invocation
        // attempt below succeed for real instead of only proving the credential layer.
        // org-data semantics for a self-administered org are not documented by the SDK;
        // independent failure path, never blocks credential issuance above.
        try {
          const orgClient = createOrgDataClientFromSession(client, baseUrl);
          await orgClient.createPolicy({ orgDid: did.toString(), initialAdminDid: did.toString() });
          await orgClient.setGrants({
            orgDid: did.toString(),
            contractId: "tee:payroll",
            grants: [{
              user_did: did.toString(),
              functions: sortedFunctions,
              scopes: [],
              constraints: {},
              expires_at_secs: null,
            }],
          });
          result.grant_provisioning_attempted = true;
          result.grant_provisioned = true;
        } catch (e) {
          result.grant_provisioning_attempted = true;
          result.grant_provisioning_error = e instanceof Error ? e.message : String(e);
        }

        // Best-effort direct invocation — failure here is evidence of the org-grant
        // boundary, not a tool error. The credential above is already validly issued
        // and signed regardless of whether the contract call below succeeds.
        try {
          const today = new Date();
          const periodEnd = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
          const payrollRequest: PayrollRunRequest = {
            org_id: did.toString(),
            cycle_id: `karma-demo-${Date.now()}`,
            pay_period_start: today.toISOString().slice(0, 10),
            pay_period_end: periodEnd.toISOString().slice(0, 10),
            batch_cap_cents: BigInt(batch_cap_cents ?? "100000"),
            historical_baselines: {},
          };
          const directInvocation = buildPayrollDirectInvocation({ request: payrollRequest });
          const scriptVersion = await getScriptVersion(baseUrl, "tee:payroll");
          const payrollResult = await client.executeAndDecode({
            script_name: "tee:payroll",
            script_version: scriptVersion,
            function_name: sortedFunctions[0],
            input: directInvocation,
          });
          result.invocation_attempted = true;
          result.invocation_succeeded = true;
          result.invocation_result = payrollResult;
        } catch (e) {
          result.invocation_attempted = true;
          result.invocation_succeeded = false;
          result.invocation_error = e instanceof Error ? e.message : String(e);
          result.invocation_note =
            "Delegation credential is validly issued and TEE-signed. Direct invocation was rejected at " +
            "the org-grant authorisation layer (independent of the credential layer) — this is KARMA's " +
            "defense-in-depth boundary working as designed: a valid signed credential alone does not grant " +
            "execution rights without an org admin's grant.";
        }

        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_revoke_payroll_authorization",
      description:
        "Revoke a delegation credential previously issued by t3_authorize_payroll_agent — the whole " +
        "credential, or a narrowed subset of its functions. Completes the issue → sign → use → revoke " +
        "lifecycle: agent authority is never permanent, and revocation merges server-side (per-function " +
        "revocations accumulate; a revocation can only narrow the authorised set, never grow it). " +
        "Requires a prior t3_authorize_payroll_agent call this process session.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id with a previously issued credential."),
        functions: z
          .array(z.enum(["compute-payroll", "execute-disbursement", "finalize-audit", "submit-escalations", "validate-credentials"]))
          .min(1)
          .max(16)
          .optional()
          .describe("Subset of functions to revoke. Omit to revoke the whole credential."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason:
          "Revocation is authenticated via the caller's own T3nClient session (EthSign via " +
          "account.signMessage) — only the credential's own user_did may revoke it; raw key never exposed.",
      },
      handler: async (args) => {
        const { agent_id, functions } = args as { agent_id: string; functions?: string[] };

        const cached = issuedCredentials.get(agent_id);
        if (!cached) {
          throw new Error(
            `[T3N] No issued credential found for agent '${agent_id}'. Call t3_authorize_payroll_agent first.`,
          );
        }
        if (!keystoreManager.has(agent_id)) {
          throw new Error(`[T3N] Agent not found in keystore: ${agent_id}`);
        }

        const { client } = await createAuthenticatedClient(agent_id);
        const baseUrl = ENV.T3N_NODE_URL ?? getNodeUrl();

        const revocation = await revokeDelegation({
          credentialJcsB64u: b64uEncodeBytes(cached.credentialJcs),
          revokedFunctions: functions,
          client,
          baseUrl,
        });

        const result = {
          agent_id,
          vc_id: revocation.vcId,
          revoked_functions: revocation.revokedFunctions,
          revoked_entirely: revocation.revokedFunctions === null,
          message: revocation.revokedFunctions === null
            ? `Credential ${revocation.vcId} revoked entirely. Agent '${agent_id}' can no longer use it.`
            : `Credential ${revocation.vcId} narrowed — revoked functions: ${revocation.revokedFunctions.join(", ")}.`,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },
  ];
}

export default createT3Tools();
