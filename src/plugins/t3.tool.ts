import { z } from "zod/v4";
import {
  loadWasmComponent,
  T3nClient,
  createEthAuthInput,
  getNodeUrl,
  eip191Digest,
  compactDidFromBytes,
  type GuestToHostHandler,
  type WasmComponent,
  type Did,
} from "@terminal3/t3n-sdk";
import { keystoreManager } from "../lib/keystore.js";
import { realKarmaService } from "../lib/karma_service.js";
import { ENV } from "../config/env.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

// Module-level DID cache: agentId → verified did:t3n:... DID.
// Populated by t3_verify_identity, read by t3_create_verified_job.
const verifiedDids = new Map<string, Did>();

// Module-level WASM singleton — loaded once on first call.
let wasmComponent: WasmComponent | null = null;

async function getWasm(): Promise<WasmComponent> {
  if (!wasmComponent) {
    wasmComponent = await loadWasmComponent();
  }
  return wasmComponent;
}

function buildT3nClient(wasm: WasmComponent, ethSignHandler: GuestToHostHandler): T3nClient {
  const baseUrl = ENV.T3N_NODE_URL ?? getNodeUrl();
  return new T3nClient({
    wasmComponent: wasm,
    baseUrl,
    handlers: { EthSign: ethSignHandler },
  });
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

// Creates a fresh T3nClient and authenticates it — required for session-bound methods (getUsage, getAuditEvents).
async function createAuthenticatedClient(agentId: string): Promise<{ client: T3nClient; did: Did }> {
  const wasm = await getWasm();
  const ethSignHandler = buildEthSignHandler(agentId);
  const client = buildT3nClient(wasm, ethSignHandler);
  const address = keystoreManager.getAddress(agentId);
  const authInput = createEthAuthInput(address);
  const did = await client.authenticate(authInput);
  return { client, did };
}

// Exported for tests — resets module-level state between test cases.
export function clearVerifiedDidsForTest(): void {
  verifiedDids.clear();
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
        const client = buildT3nClient(wasm, ethSignHandler);
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
  ];
}

export default createT3Tools();
