# CONTEXT.md — Domain Knowledge
<!-- Version: 1 — populate via domain-alignment skill, then keep updated via knowledge-compound -->

## Ubiquitous Language
<!-- Add domain terms where the word means something more specific than common usage -->
- **KARMA**: First-party application (Skill Economy) built ON TOP of the SUPER-MCP Layer 0 framework. The repo currently contains ONLY Layer 0.
- **Skill (KARMA)**: An on-chain registered, paid MCP capability owned by an agent (AgentSkillRegistry.sol).
- **Job**: An escrowed on-chain delegation request: Open → Delivered → Completed → (Refunded | Disputed).
- **idempotency_nonce**: App-level arg that busts KARMA's unconditional args-hash idempotency cache. DISTINCT from EVM tx nonce.
- **EVM tx nonce**: Per-account sequential on-chain counter managed by viem `nonceManager`.
- **Trusted built-in plugin**: A plugin reaching the in-process `import()` path (singletons + full env + network). Only `isTrustedBuiltInPlugin()` files qualify.

## Architectural Decisions
<!-- Decisions with applicability beyond a single feature -->
- KARMA plugin MUST run in-process (trusted built-in), NOT external isolation. See [[karma-builtin-plugin-decision]].
- Hold private keys in-process via Web3 Secret Storage v3 decryption (node:crypto), never via MCP input or child env.
- viem batched JSON-RPC transport is the default RPC reducer; on-chain Multicall3 optional.

## Domain Gotchas
<!-- Format: - [YYYY-MM] What surprised us | Why it matters -->
- [2026-06] Idempotency is UNCONDITIONAL in the pipeline (ignores idempotentHint) | repeated on-chain ops need idempotency_nonce.
- [2026-06] viem has NO keystore-decrypt | KeystoreManager must implement Web3 Secret Storage v3 itself.
- [2026-06] Output firewall redacts 13-19 digit Luhn-valid runs | bare wei strings can be mangled as PAYMENT_CARD.
- [2026-06-15] LIVE-VERIFIED Pharos Atlantic: chainId=688689, gasMode=eip1559 (baseFeePerGas=1gwei), RPC https://atlantic.dplabs-internal.com reachable (block ~24.26M) | Resolves the 688688/688689 source conflict (docs.pharos.xyz stale). viem default EIP-1559 path is correct; no legacy-gas fallback needed. Evidence: src/scripts/check_connectivity.ts.
