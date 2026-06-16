import {
  scrypt as scryptCb,
  createDecipheriv,
  createCipheriv,
  randomBytes,
  type ScryptOptions,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { keccak256, type Address } from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { ENV } from "../config/env.js";
import type { AgentIdentity, CryptoV3, KeystoreFileV3 } from "./types.js";

/**
 * Tenant an agent binds to when its keystore entry omits `tenant`. Fail-closed: an unmarked agent
 * is owned by exactly this tenant, NOT "any tenant". Single-operator stdio keeps working (its
 * request context is this same default); a different multi-tenant caller is denied (STRIDE-S).
 */
const DEFAULT_AGENT_TENANT = ENV.KARMA_DEFAULT_AGENT_TENANT ?? ENV.MCP_TENANT_ID;

// Explicit wrapper (promisify drops the options overload in the type system).
function scrypt(password: Buffer, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/**
 * In-process decryption of a KARMA multi-agent keystore (Web3 Secret Storage v3, scrypt).
 *
 * viem has no keystore-decrypt (spec D-5), so this implements it with node:crypto:
 *   DK   = scrypt(password, salt, dklen, {N,r,p})
 *   MAC  = keccak256(DK[16:32] ++ ciphertext)        (must equal stored mac)
 *   PK   = aes-128-ctr-decrypt(ciphertext, DK[0:16], iv)
 *
 * Private keys NEVER leave this class — only viem Account objects (which sign internally)
 * are exposed. The class is a module singleton, which is only safe because karma.tool runs
 * in-process (D-1); the external worker would re-instantiate it empty every call.
 */
export class KeystoreManager {
  private identities = new Map<string, AgentIdentity>();

  async load(keystorePath: string, password: string): Promise<void> {
    // keystorePath comes from internal config (KEYSTORE_PATH), not user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const raw = await readFile(keystorePath, "utf8");
    const file = JSON.parse(raw) as KeystoreFileV3;
    if (!Array.isArray(file.agents)) {
      throw new Error("[KARMA] Invalid keystore: expected { agents: [...] }");
    }
    for (const entry of file.agents) {
      const pk = await this.decryptV3(entry.crypto, password, entry.agentId);
      const account = privateKeyToAccount(pk, { nonceManager });
      this.identities.set(entry.agentId, {
        agentId: entry.agentId,
        address: account.address,
        account,
        tenant: entry.tenant ?? DEFAULT_AGENT_TENANT,
      });
    }
  }

  private async decryptV3(crypto: CryptoV3, password: string, agentId: string): Promise<`0x${string}`> {
    if (crypto.kdf !== "scrypt") {
      throw new Error(`[KARMA] Unsupported keystore KDF '${crypto.kdf}' for agent ${agentId} (scrypt only)`);
    }
    if (crypto.cipher !== "aes-128-ctr") {
      throw new Error(`[KARMA] Unsupported cipher '${crypto.cipher}' for agent ${agentId}`);
    }
    const { n, r, p, dklen, salt } = crypto.kdfparams;
    const derived = (await scrypt(Buffer.from(password, "utf8"), Buffer.from(salt, "hex"), dklen, {
      N: n,
      r,
      p,
      // 128 * N * r bytes are needed; raise maxmem above Node's default for N=2^18.
      maxmem: 512 * 1024 * 1024,
    }));

    const ciphertext = Buffer.from(crypto.ciphertext, "hex");
    const macKey = derived.subarray(16, 32);
    const computedMac = keccak256(Buffer.concat([macKey, ciphertext])).slice(2).toLowerCase();
    if (computedMac !== crypto.mac.toLowerCase()) {
      throw new Error(`[KARMA] Keystore MAC mismatch for agent ${agentId} (wrong password or corrupt file)`);
    }

    const encKey = derived.subarray(0, 16);
    const iv = Buffer.from(crypto.cipherparams.iv, "hex");
    const decipher = createDecipheriv("aes-128-ctr", encKey, iv);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return `0x${plaintext.toString("hex")}`;
  }

  /** Returns the viem Account (signs internally); the raw private key never leaves this class. */
  getAccount(agentId: string) {
    return this.requireIdentity(agentId).account;
  }

  getAddress(agentId: string): Address {
    return this.requireIdentity(agentId).address;
  }

  has(agentId: string): boolean {
    return this.identities.has(agentId);
  }

  list(): string[] {
    return [...this.identities.keys()];
  }

  private requireIdentity(agentId: string): AgentIdentity {
    const id = this.identities.get(agentId);
    if (!id) throw new Error(`[KARMA] Agent not found in keystore: ${agentId}`);
    return id;
  }

  /**
   * Authz gate (STRIDE-S): the calling tenant must own this agent. The message is intentionally
   * generic — it never names the owning tenant — to avoid cross-tenant reconnaissance. Unknown
   * agents fail with "Agent not found" (checked first) so a probe can't distinguish
   * "wrong tenant" from "no such agent" by message.
   */
  assertOwnedBy(agentId: string, tenantId: string): void {
    const id = this.requireIdentity(agentId);
    if (id.tenant !== tenantId) {
      throw new Error(`[KARMA] agent '${agentId}' is not accessible to this tenant`);
    }
  }
}

const SCRYPT_MAXMEM = 512 * 1024 * 1024;

/**
 * Encrypt a private key into a Web3 Secret Storage v3 (scrypt) crypto block.
 * Inverse of decryptV3 — used by scripts/setup_keystore.ts. Default n=8192 (testnet-fast;
 * raise for production). Output is interoperable with go-ethereum / `cast wallet`.
 */
export async function encryptPrivateKeyV3(
  privateKey: `0x${string}`,
  password: string,
  opts: { n?: number } = {},
): Promise<CryptoV3> {
  const n = opts.n ?? 8192;
  const r = 8;
  const p = 1;
  const dklen = 32;
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = (await scrypt(Buffer.from(password, "utf8"), salt, dklen, {
    N: n,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  }));

  const pkBytes = Buffer.from(privateKey.replace(/^0x/, ""), "hex");
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(pkBytes), cipher.final()]);
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2);

  return {
    cipher: "aes-128-ctr",
    ciphertext: ciphertext.toString("hex"),
    cipherparams: { iv: iv.toString("hex") },
    kdf: "scrypt",
    kdfparams: { dklen, n, p, r, salt: salt.toString("hex") },
    mac,
  };
}

/** Module singleton — safe only because karma.tool runs in-process (D-1). */
export const keystoreManager = new KeystoreManager();
