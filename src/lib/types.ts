import type { Address } from "viem";
import type { privateKeyToAccount } from "viem/accounts";

/** A viem local account with built-in nonce management. */
export type ManagedAccount = ReturnType<typeof privateKeyToAccount>;

export interface AgentIdentity {
  agentId: string;
  address: Address;
  account: ManagedAccount;
}

/** Web3 Secret Storage v3 crypto block (scrypt KDF variant). */
export interface CryptoV3 {
  // cipher/kdf are widened to string: parsed from an untrusted file, validated at runtime.
  cipher: string; // expected "aes-128-ctr"
  ciphertext: string; // hex
  cipherparams: { iv: string }; // hex
  kdf: string; // expected "scrypt"
  kdfparams: {
    dklen: number;
    n: number;
    r: number;
    p: number;
    salt: string; // hex
  };
  mac: string; // hex
}

/** KARMA multi-agent keystore file: standard v3 crypto per agent. */
export interface KeystoreFileV3 {
  version: 3;
  agents: Array<{
    agentId: string;
    address?: string;
    crypto: CryptoV3;
  }>;
}

/** One indexed skill document for the BM25 search index. */
export interface SkillDocument {
  id: number; // = skill_id (MiniSearch idField)
  skill_id: number;
  name: string;
  description: string;
  mcp_endpoint: string;
  price_per_call_wei: string; // string — BigInt-safe (spec D-6)
  reputation_score: number;
  owner_address: string;
  active: boolean;
}
