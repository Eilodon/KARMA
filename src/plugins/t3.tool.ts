import { z } from "zod/v4";
import {
  loadWasmComponent,
  T3nClient,
  createEthAuthInput,
  getNodeUrl,
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
  ];
}

export default createT3Tools();
