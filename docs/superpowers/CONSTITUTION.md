# Project Constitution
# NON-NEGOTIABLE — agent không được override những rules này.
# audit-design FAST scan đọc file này trước khi bắt đầu.

## Architecture Laws
- KARMA plugin runs in-process as a trusted built-in (NOT MCP_PLUGIN_ISOLATION_MODE=external): external forks per-call (kills singletons) and workerEnv() does not pass PHAROS_*/KEYSTORE_* — proven blockers.
- All on-chain numeric values (uint256) MUST be stringified before returning from a tool: JSON.stringify(bigint) crashes idempotency commit.
- Reuse existing Layer 0 primitives (node:crypto scrypt in storage/encryption.ts, vault, KMS registry) before adding new crypto/deps.

## Security Mandates
- Private keys NEVER traverse MCP tool input or child-process env — only decrypted in-process inside KeystoreManager; only viem Account objects leave the class.
- Smart contracts that move PHRS MUST use pull-payment + ReentrancyGuard + checks-effects-interactions.
- Escrow MUST have a refund path (claimRefund after deadline) — no permanent fund lock.

## Quality Gates
- No tool ships without stringified BigInt output and idempotency_nonce where the op is non-idempotent on-chain.
- Contract changes require Foundry tests covering happy-path, refund-after-deadline, double-complete, and a reentrancy attacker.
- chainId and gas mode (EIP-1559 vs legacy) must be verified live against the RPC before any deploy/write is trusted.

## Defer Until Explicitly Enabled
- KMS-backed signer (viem-kms-signer) / vault-stored keys — production upgrade, not hackathon default.
- viem batch:{multicall:true} — only after Multicall3 deployment on Pharos Atlantic is verified on-chain.
- requiredScopes (pharos:*) on tools — deferred until JWT/OIDC or identity-header auth is wired (api_key only grants mcp:invoke).
