import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  encodePacked,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentSkillRegistryAbi } from "../lib/abi.js";

/**
 * PD-002 closer: exercise realKarmaService against a real EVM (anvil) end-to-end, so the
 * readContract/writeContractBounded DECODE paths (esp. the v2 `skills` tuple + new functions) are
 * covered, not just shape-drift-guarded. Skips cleanly when anvil or the forge artifact is absent.
 */

const ANVIL = [join(homedir(), ".foundry/bin/anvil"), "anvil"].find(p => p === "anvil" || existsSync(p));
const ARTIFACT = "./out/AgentSkillRegistry.sol/AgentSkillRegistry.json";
const PORT = 8637;
const RPC = `http://127.0.0.1:${PORT}`;

// anvil deterministic dev accounts (well-known keys, prefunded 10000 ETH).
const PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // alpha/provider
const PK1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const; // beta/requester

const anvilChain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: [RPC] } },
});

const runnable = Boolean(ANVIL) && existsSync(ARTIFACT);

async function waitForRpc(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("anvil did not become ready in time");
}

(runnable ? describe : describe.skip)("realKarmaService ↔ anvil integration (PD-002)", () => {
  let proc: ChildProcess;
  let dir: string;
  let svc: typeof import("../lib/karma_service.js").realKarmaService;
  let keystore: typeof import("../lib/keystore.js").keystoreManager;
  let alpha: Address;
  let beta: Address;

  beforeAll(async () => {
    proc = spawn(ANVIL as string, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    await waitForRpc();

    // Deploy v2 from the forge artifact bytecode, signed by anvil account #0.
    const deployer = privateKeyToAccount(PK0);
    const wallet = createWalletClient({ account: deployer, chain: anvilChain, transport: http(RPC) });
    const pub = createPublicClient({ chain: anvilChain, transport: http(RPC) });
    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { bytecode: { object: `0x${string}` } };
    const hash = await wallet.deployContract({ abi: agentSkillRegistryAbi, bytecode: artifact.bytecode.object, account: deployer, chain: anvilChain });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const contractAddress = receipt.contractAddress as Address;

    // Point the (lazily-constructed) service clients at anvil BEFORE importing them.
    process.env.PHAROS_RPC_URL = RPC;
    process.env.PHAROS_CHAIN_ID = "31337";
    process.env.PHAROS_CONTRACT_ADDRESS = contractAddress;

    const { encryptPrivateKeyV3, keystoreManager } = await import("../lib/keystore.js");
    dir = mkdtempSync(join(tmpdir(), "karma-int-"));
    const ksPath = join(dir, "keystore.json");
    writeFileSync(ksPath, JSON.stringify({
      version: 3,
      agents: [
        { agentId: "alpha", tenant: "tenant_local", crypto: await encryptPrivateKeyV3(PK0, "pw", { n: 4096 }) },
        { agentId: "beta", tenant: "tenant_local", crypto: await encryptPrivateKeyV3(PK1, "pw", { n: 4096 }) },
      ],
    }));
    await keystoreManager.load(ksPath, "pw");
    keystore = keystoreManager;
    alpha = keystore.getAddress("alpha");
    beta = keystore.getAddress("beta");

    ({ realKarmaService: svc } = await import("../lib/karma_service.js"));
  }, 30_000);

  afterAll(() => {
    proc?.kill("SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips register→read with the v2 minReputationToInvoke field decoded", async () => {
    const acct = keystore.getAccount("alpha");
    const { skillId } = await svc.registerSkill(acct, {
      name: "search", description: "d", mcpEndpoint: "mcp://a", pricePerCall: 1000n, minReputationToInvoke: 0n,
    });
    expect(skillId).toBe(1n);
    const s = await svc.readSkill(1n);
    expect(s.owner.toLowerCase()).toBe(alpha.toLowerCase());
    expect(s.pricePerCall).toBe(1000n);
    expect(s.reputationScore).toBe(50n);
    expect(s.minReputationToInvoke).toBe(0n); // the v2 tuple field decodes at the right index
  });

  it("full escrow loop: create → O(1) dedup → deliver → confirm → withdraw, decoding each tuple", async () => {
    const alphaAcct = keystore.getAccount("alpha");
    const betaAcct = keystore.getAccount("beta");
    const skillId = 1n;
    const taskHash = keccak256(encodePacked(["address", "uint256", "uint256"], [beta, skillId, 1n]));

    expect(await svc.findExistingJob(beta, taskHash)).toBeNull(); // O(1) lookup, none yet
    const { jobId } = await svc.createJob(betaAcct, { skillId, taskHash, deadlineSecs: 86_400n, value: 1000n });
    if (jobId == null) throw new Error("createJob did not confirm on anvil");
    expect(jobId).toBe(1n);
    expect(await svc.findExistingJob(beta, taskHash)).toBe(1n); // jobByTaskHash now resolves O(1)

    const job = await svc.readJob(1n);
    expect(job.requester.toLowerCase()).toBe(beta.toLowerCase());
    expect(job.escrowAmount).toBe(1000n);
    expect(job.status).toBe(0); // Open

    await svc.deliverResult(alphaAcct, { jobId, resultHash: `0x${"ab".repeat(32)}` });
    expect((await svc.readJob(1n)).status).toBe(1); // Delivered

    await svc.confirmCompletion(betaAcct, { jobId });
    expect((await svc.readJob(1n)).status).toBe(2); // Completed

    // arm's-length completion lifts on-chain agent reputation (50 → 55) for both parties
    expect(await svc.getAgentReputation(alpha)).toBe(55);
    expect(await svc.getAgentReputation(beta)).toBe(55);

    expect(await svc.getPendingWithdrawal(alpha)).toBe(1000n);
    const { amount } = await svc.withdraw(alphaAcct);
    expect(amount).toBe(1000n); // decoded from the Withdrawn event
    expect(await svc.getPendingWithdrawal(alpha)).toBe(0n);
  });

  it("v2 dispute path: deliver → disputeResult refunds the requester", async () => {
    const alphaAcct = keystore.getAccount("alpha");
    const betaAcct = keystore.getAccount("beta");
    const skillId = 1n;
    const taskHash = keccak256(encodePacked(["address", "uint256", "uint256"], [beta, skillId, 2n]));
    const { jobId } = await svc.createJob(betaAcct, { skillId, taskHash, deadlineSecs: 86_400n, value: 1000n });
    if (jobId == null) throw new Error("createJob did not confirm on anvil");

    await svc.deliverResult(alphaAcct, { jobId, resultHash: `0x${"cd".repeat(32)}` });
    await svc.disputeResult(betaAcct, { jobId });

    expect((await svc.readJob(jobId)).status).toBe(4); // Disputed
    expect(await svc.getPendingWithdrawal(beta)).toBe(1000n); // requester refunded
  });
});
