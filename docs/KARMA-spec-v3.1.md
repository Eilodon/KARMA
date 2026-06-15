# KARMA — Complete Optimized Spec v3.1

> Chưng cất từ: Spec v3.0 + Phân tích đối chiếu codebase thực tế (SUPER-MCP Layer 0) + Nghiên cứu công nghệ (viem / MiniSearch / Pharos Atlantic, Context7 + web, 06/2026).
> Mục tiêu: Spec khớp hạ tầng thực, exactly-once on-chain, tối ưu RPC budget, keystore implement nghiêm túc.
>
> **Trạng thái dự án:** Codebase hiện tại CHỈ là Layer 0 (SUPER-MCP framework). Toàn bộ lớp ứng dụng KARMA dưới đây là **forward design chưa implement**.

---

## Δ Delta so với v3.0 (Sửa lỗi khớp hạ tầng + nâng cấp nghiên cứu)

| # | Thay đổi | Lý do | Mức |
|---|---|---|---|
| **D-1** | Plugin KARMA chạy **trusted built-in / in-process**, KHÔNG `ISOLATION_MODE=external` | External = fork mỗi call (mất singleton Keystore/BM25) + `workerEnv()` không truyền `PHAROS_*`/`KEYSTORE_*` | 🔴 |
| **D-2** | **Bỏ `requiredScopes: pharos:*`** (hoặc chuyển JWT/identity-header) | api-key context chỉ cấp `mcp:invoke` → mọi call bị `validateScopes` reject | 🔴 |
| **D-3** | `MCP_SAFE_MODE=false` là **bắt buộc** (ghi rõ trade-off) | `network` capability bị safe-mode chặn ở cả load lẫn execute | 🔴 |
| **D-4** | **Verify `chainId` live** trước khi hard-code | Nguồn mâu thuẫn: ChainList 688689 vs docs.pharos.xyz 688688 | 🔴 |
| **D-5** | `KeystoreManager.load()` implement **Web3 Secret Storage v3 thật** | viem KHÔNG có hàm decrypt keystore | 🔴 |
| **D-6** | Tool results **stringify mọi BigInt**; tránh số wei trần trong text | `JSON.stringify(bigint)` crash ở idempotency commit; firewall redact nhầm wei (Luhn) | 🟠 |
| **D-7** | **Exactly-once on-chain**: ghim EVM tx nonce per logical op / check-before-write | Pipeline release idempotency khi transient → resubmit có thể double-escrow | 🟠 |
| **D-8** | Contract thêm `claimRefund()` + `ReentrancyGuard` + pull-payment | Escrow quá deadline đang khoá vĩnh viễn; release PHRS thiếu reentrancy guard | 🟠 |
| **D-9** | RPC: **Batch JSON-RPC ở transport** (`http(url,{batch})`); multicall optional | Giảm request dưới rate-limit 500/5min mà không phụ thuộc Multicall3 on-chain | ⚡ |
| **D-10** | BM25 **incremental theo event** (`add/replace/discard`), bỏ full rebuild | MiniSearch hỗ trợ; full enumerate đốt RPC | ⚡ |
| **D-11** | `discover_skills` **reputation-aware** (`boostDocument` + `filter`) | Xếp hạng theo danh tiếng on-chain, gần như miễn phí | ⚡ |
| **D-12** | Tách rõ **2 khái niệm nonce** (idempotency vs EVM tx) | v3.0 chỉ đặt tên một, gây nhập nhằng | 📝 |
| **D-13** | Hạ giọng "CertiK compliance" → "best-practice"; sync doc drift | Overclaim; tool thật tên `karma_*` | 📝 |

---

## Part 1 — Positioning & Narrative

**Tên pitch:** *"Skill Economy Infrastructure for Pharos — The Missing Primitive."*

**One-liner:**

> *"Bất kỳ agent nào muốn delegate subtasks trên Pharos đang phải giải ba vấn đề tách biệt: tìm agent khác, negotiate terms, và settle payment trustlessly. KARMA giải cả ba bằng một on-chain coordination protocol — và mỗi transaction đồng thời build reputation graph cho toàn bộ ecosystem."*

**Tại sao framing này win:**
- Trả lời trực tiếp bài toán thiếu "durable social graphs and payment behaviors".
- Mô hình "Skill as code asset".
- Mỗi transaction làm 3 việc: thanh toán ủy thác, ghi lịch sử, xây danh tiếng — và `discover_skills` xếp hạng theo chính reputation đó (D-11).

---

## Part 2 — Architecture (4 Layers)

```text
┌──────────────────────────────────────────────────────────────┐
│  Layer 0: KARMA Infrastructure (ĐÃ TỒN TẠI)                  │
│  stdio/HTTP transport · rc2026 protocol · auth (api_key dev) │
│  15-stage execution pipeline · output firewall · telemetry   │
│  idempotency (UNCONDITIONAL) · rate limit · tenant lock      │
│  KMS key registry (DEBT-002) · credential vault              │
└─────────────────────────┬────────────────────────────────────┘
                          │  ToolDefinition[] — TRUSTED BUILT-IN (in-process)
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 1: KARMA Plugin (CHƯA IMPLEMENT)                      │
│  src/plugins/karma.tool.ts  ← phải là trusted built-in       │
│  7 tools: register/discover/create_job/deliver/complete/     │
│           reputation/social_graph                            │
│  KeystoreManager · BM25Index (singleton) · ContractClient    │
└─────────────────────────┬────────────────────────────────────┘
                          │  viem batched JSON-RPC
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 2: On-chain Registry                                  │
│  AgentSkillRegistry.sol (ReentrancyGuard, pull-payment)      │
│  Skill struct · Job state machine · escrow · refund · rep    │
└─────────────────────────┬────────────────────────────────────┘
                          │  EVM
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 3: Pharos Atlantic Testnet                            │
│  RPC: https://atlantic.dplabs-internal.com                   │
│  PHRS token · Chain ID (verify live: 688688/688689)          │
└──────────────────────────────────────────────────────────────┘
```

**Clean boundary:** KARMA Core lo *how tools are invoked* (transport, auth, rate limit, idempotency, firewall); Plugin lo *why, at what price, by whom, with what reputation*.

---

## Part 3 — Sự tương tác với Lõi KARMA (đã đối chiếu code)

### 3.1 Plugin phải là **Trusted Built-in / In-process** (D-1) 🔴

Ba blocker khiến `MCP_PLUGIN_ISOLATION_MODE=external` **không chạy được**:

1. **`workerEnv()`** (`src/core/plugin_external_runner.ts`) chỉ truyền 7 biến cố định sang child; `fork()` thay thế hoàn toàn `process.env` → `PHAROS_RPC_URL`, `KEYSTORE_PASSWORD`… = `undefined`.
2. **Fork mỗi call**: `callWorker` tạo process mới mỗi `invoke` rồi kill ngay → singleton `keystoreManager`, `skillIndex` reset mỗi lần → BM25 rỗng + đốt RPC.
3. Chỉ `isTrustedBuiltInPlugin()` (`src/core/plugin_loader.ts`, hard-code `system.tool.ts`) mới vào nhánh in-process `import()` — nơi singleton + env + network tồn tại.

**Cách triển khai (chọn 1):**
- **(a) Khuyến nghị:** patch `isTrustedBuiltInPlugin()` thêm `karma.tool.ts`/`karma.tool.js`; đặt `MCP_PLUGIN_ISOLATION_MODE=policy`.
- (b) Ship các tool KARMA ngay trong `system.tool.ts`.

> Hệ quả: các biến `MCP_EXTERNAL_PLUGIN_*` (network/fs policy) **không còn liên quan** ở chế độ in-process.

### 3.2 Scopes — `api_key` ⊥ `pharos:*` (D-2) 🔴

`resolveHttpRequestContext` (`src/security/context.ts`) hard-code `scopes:["mcp:invoke"]`, `authType:"api-key"`. `validateScopes` chỉ bỏ qua `stdio`. → **Bỏ `requiredScopes`** khỏi các tool KARMA cho demo. Production: dùng JWT/OIDC mang scope `pharos:*`, hoặc `MCP_TRUST_IDENTITY_HEADERS=true` + header `x-mcp-scopes: pharos:read,pharos:write` (authType thành `gateway`, scopes được enforce đúng).

### 3.3 Idempotency là VÔ ĐIỀU KIỆN — cần `idempotency_nonce` (D-12) 🟠

`execution_pipeline.ts` hash `{tenantId, toolName, owner, args}` cho **mọi** call bất kể `idempotentHint`. `owner` = danh tính MCP (tenant+client+user), **không phải** `agent_id` blockchain. Vì demo self-referential thường chung một danh tính MCP → job lặp bị dedupe. **Bắt buộc** truyền `idempotency_nonce` để phá cache.

> ⚠️ Phân biệt với **EVM tx nonce** (Part 7.1): hai thứ hoàn toàn khác nhau.

### 3.4 Output firewall & BigInt (D-6) 🟠

- Firewall **chỉ quét output** (`content[].text` + `structuredContent`), **không quét input args**; telemetry **không log args**. (→ v3.0 §3.1 mô tả sai cơ chế, nhưng Keystore pattern vẫn đúng vì args vào idempotency-hash + có thể lọt saved-state.)
- `redactCardNumbers` match 13–19 chữ số + Luhn → **số wei trần (vd 1e18 = 19 số) có thể bị redact nhầm** thành `[REDACTED:PAYMENT_CARD]`. → Mọi giá trị on-chain trả về dạng **string có ngữ cảnh** (kèm đơn vị/format), không để chuỗi số trần trong `content.text`.
- `assertJsonSerializable` ném lỗi trên bigint; `commit()` `JSON.stringify` cũng crash bigint. → **Stringify toàn bộ uint256** (price, escrow, reputation, deadline, block) trước khi return. Đừng đặt tên field output trùng `token/secret/private_key/...` (bị `SENSITIVE_FIELD_RE` che value).

### 3.5 Plugin Network Policy — Critical Config

```env
MCP_SAFE_MODE=false                  # BẮT BUỘC: 'network' capability bị safe-mode chặn (D-3)
MCP_PLUGIN_ISOLATION_MODE=policy     # in-process cho trusted built-in
```
> Trade-off D-3: tắt safe-mode bỏ lớp chặn capability cho **toàn bộ** tool, không riêng KARMA. Bù lại bằng allowlist plugin chặt + hash pinning.

---

## Part 4 — Keystore Pattern (implement nghiêm túc — D-5)

viem **không có** hàm giải mã keystore (khác ethers `fromEncryptedJson`). `KeystoreManager` phải tự giải mã **Web3 Secret Storage v3** bằng `node:crypto` (tái dùng scrypt đã có ở `src/storage/encryption.ts`).

```typescript
// src/lib/keystore.ts
import { scrypt as _scrypt, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { keccak256, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const scrypt = promisify(_scrypt);

interface AgentIdentity { agentId: string; address: Address; account: ReturnType<typeof privateKeyToAccount>; }

class KeystoreManager {
  private identities = new Map<string, AgentIdentity>();

  /** Giải mã keystore JSON (Web3 Secret Storage v3, scrypt + aes-128-ctr + keccak MAC). Chạy 1 LẦN lúc startup (in-process). */
  async load(keystorePath: string, password: string): Promise<void> {
    const file = JSON.parse(await (await import('node:fs/promises')).readFile(keystorePath, 'utf8'));
    for (const entry of file.agents) {
      const { kdfparams, ciphertext, cipherparams, mac } = entry.crypto;
      const derived = await scrypt(Buffer.from(password), Buffer.from(kdfparams.salt, 'hex'),
        kdfparams.dklen, { N: kdfparams.n, r: kdfparams.r, p: kdfparams.p, maxmem: 512 * 1024 * 1024 }) as Buffer;
      const ct = Buffer.from(ciphertext, 'hex');
      // MAC = keccak256(derived[16:32] ++ ciphertext)
      const computedMac = keccak256(Buffer.concat([derived.subarray(16, 32), ct])).slice(2);
      if (computedMac !== mac) throw new Error(`Keystore MAC mismatch for agent ${entry.agentId} (wrong password?)`);
      const dec = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), Buffer.from(cipherparams.iv, 'hex'));
      const pk = `0x${Buffer.concat([dec.update(ct), dec.final()]).toString('hex')}` as `0x${string}`;
      const account = privateKeyToAccount(pk, { nonceManager }); // NonceManager: Part 7.1
      this.identities.set(entry.agentId, { agentId: entry.agentId, address: account.address, account });
    }
  }

  getAccount(agentId: string) {
    const id = this.identities.get(agentId);
    if (!id) throw new Error(`Agent not found: ${agentId}`);
    return id.account;            // private key KHÔNG BAO GIỜ rời class; chỉ trả viem Account để ký
  }
  getAddress(agentId: string): Address { return this.identities.get(agentId)!.address; }
}
export const keystoreManager = new KeystoreManager(); // singleton — chỉ an toàn vì plugin in-process (D-1)
```

**Input schema:** `{ private_key }` ➔ `{ agent_id }` (private key không bao giờ qua MCP input — vào idempotency-hash + có thể lọt saved-state).

> `nonceManager` import từ `viem/accounts`. Setup keystore qua `scripts/setup_keystore.ts` (mã hoá key → JSON), không commit (gitignore).

**Đường nâng cấp production (pivot khớp infra):**
- **Vault/KMS (DEBT-002):** lưu key qua `globalCredentialVault` + KMS registry sẵn có → có crypto-erasure per-tenant.
- **viem-kms-signer:** ký qua AWS KMS, key không rời KMS. Cộng hưởng `@aws-sdk/client-kms` đã có trong deps.

---

## Part 5 — Smart Contract (Hardened — D-8)

### AgentSkillRegistry.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract AgentSkillRegistry is ReentrancyGuard {

    struct Skill {
        address owner; string name; string description; string mcpEndpoint;
        uint256 pricePerCall; uint256 reputationScore;   // 0-100, start 50
        uint256 totalInvocations; bool active; uint256 registeredAt;
    }

    struct Job {
        address requester; address provider;              // skill owner snapshot tại lúc tạo
        uint256 skillId; bytes32 taskHash; uint256 escrowAmount;
        uint256 deadline; JobStatus status; bytes32 resultHash;
        uint256 createdAt; uint256 completedAt;
    }

    enum JobStatus { Open, Delivered, Completed, Refunded, Disputed }

    uint256 private _skillIdCounter; uint256 private _jobIdCounter;
    mapping(uint256 => Skill) public skills;
    mapping(uint256 => Job) public jobs;
    mapping(address => uint256[]) public agentProviderJobs;
    mapping(address => uint256[]) public agentRequesterJobs;
    mapping(address => uint256[]) public agentSkills;
    mapping(address => uint256) public pendingWithdrawals;   // PULL-PAYMENT (D-8)

    event SkillRegistered(uint256 indexed skillId, address indexed owner, string name, uint256 pricePerCall);
    event SkillDeactivated(uint256 indexed skillId);
    event JobCreated(uint256 indexed jobId, address indexed requester, uint256 indexed skillId, uint256 escrow, uint256 deadline);
    event ResultDelivered(uint256 indexed jobId, bytes32 resultHash);
    event JobCompleted(uint256 indexed jobId, address indexed provider, uint256 payout, uint256 newReputation);
    event JobRefunded(uint256 indexed jobId, address indexed requester, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount);

    // registerSkill, deactivateSkill, createJob(payable), deliverResult, confirmCompletion (logic v2 giữ nguyên)

    /// Quá deadline mà chưa Delivered → requester rút lại escrow (CHỐNG KHOÁ VỐN — D-8)
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.requester == msg.sender, "not requester");
        require(j.status == JobStatus.Open, "not refundable");
        require(block.timestamp > j.deadline, "before deadline");
        j.status = JobStatus.Refunded;                       // effects trước
        pendingWithdrawals[msg.sender] += j.escrowAmount;    // pull, không push
        emit JobRefunded(jobId, msg.sender, j.escrowAmount);
    }

    /// Pull-payment: provider/requester tự rút — checks-effects-interactions + nonReentrant
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;                  // effects
        (bool ok, ) = payable(msg.sender).call{value: amount}("");  // interaction cuối
        require(ok, "transfer failed");
        emit Withdrawn(msg.sender, amount);
    }
}
```

**Nguyên tắc:** `confirmCompletion` cộng `pendingWithdrawals[provider]` thay vì gửi PHRS trực tiếp → tránh reentrancy & DoS-by-revert. Mọi hàm chuyển tiền `nonReentrant` + checks-effects-interactions.

> Test bằng Foundry (`test/AgentSkillRegistry.t.sol`): happy-path, refund quá hạn, double-complete, reentrancy attacker contract.

---

## Part 6 — BM25 Search (Incremental + Reputation-aware — D-10, D-11)

MiniSearch dùng **BM25/BM25+** (chuẩn Lucene), zero-dep. Cập nhật **theo event**, không full-rebuild.

```typescript
// src/lib/bm25_index.ts
import MiniSearch from 'minisearch';

interface SkillDocument {
  id: number; skill_id: number; name: string; description: string;
  mcp_endpoint: string; price_per_call_wei: string;   // string — BigInt-safe (D-6)
  reputation_score: number; owner_address: string; active: boolean;
}

class BM25SkillIndex {
  private index = new MiniSearch<SkillDocument>({
    fields: ['name', 'description'],
    storeFields: ['skill_id','mcp_endpoint','price_per_call_wei','reputation_score','owner_address','active'],
    idField: 'skill_id',
    searchOptions: { boost: { name: 2 }, fuzzy: 0.2, prefix: true },
  });

  /** CHỈ chạy 1 lần cold-start. Sau đó cập nhật qua event (D-10). */
  async rebuildFromChain(skills: SkillDocument[]): Promise<void> {
    this.index.removeAll();
    this.index.addAll(skills.filter(s => s.active));
  }

  // Gọi từ ContractClient.watchContractEvent:
  upsert(doc: SkillDocument): void {
    if (this.index.has(doc.skill_id)) this.index.replace(doc); else this.index.add(doc);
  }
  deactivate(skillId: number): void { if (this.index.has(skillId)) this.index.discard(skillId); }

  search(query: string, opts?: { maxPriceWei?: bigint; minReputation?: number }) {
    return this.index.search(query, {
      filter: (r) => r.active
        && (opts?.minReputation === undefined || r.reputation_score >= opts.minReputation)
        && (opts?.maxPriceWei === undefined || BigInt(r.price_per_call_wei) <= opts.maxPriceWei),
      boostDocument: (_id, _term, stored) =>
        1 + (Number(stored?.reputation_score ?? 50) / 100),   // ưu tiên agent uy tín (D-11)
    });
  }
}
export const skillIndex = new BM25SkillIndex();
```

---

## Part 7 — Tool Definitions (KARMA Format)

### 7.1 `create_job` (idempotency_nonce + EVM tx nonce — D-7, D-12)

```typescript
{
  name: 'create_job',
  description: 'Create a job with payment locked in escrow.',
  inputSchema: {
    agent_id: z.string().min(1).max(64),
    skill_id: z.number().int().positive(),
    task_params_json: z.string().max(4096),
    deadline_hours: z.number().int().min(1).max(168),
    idempotency_nonce: z.number().int().positive()
      .describe('Unique nonce to bypass KARMA idempotency cache for duplicate jobs (KHÁC EVM tx nonce)'),
  },
  capabilities: ['network'],          // ⇒ MCP_SAFE_MODE=false (D-3)
  // requiredScopes: BỎ cho api_key demo (D-2)
  allowedPhases: ['intake', 'execution'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  execution: { taskSupport: 'optional' },

  handler: async (args) => {
    const { agent_id, skill_id, task_params_json, deadline_hours } = args as any;
    const account = keystoreManager.getAccount(agent_id);   // có nonceManager (EVM tx nonce auto)

    // EXACTLY-ONCE (D-7): simulate → write với nonce do nonceManager quản; nếu resubmit transient,
    // nonce tái dùng → chain reject "nonce too low" nếu đã mined (tránh double-escrow).
    const { request } = await publicClient.simulateContract({
      address, abi, functionName: 'createJob', account,
      args: [BigInt(skill_id), keccak256(toHex(task_params_json)), BigInt(deadline_hours) * 3600n],
      value: price,
    });
    const hash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    return { structuredContent: {                            // mọi BigInt → string (D-6)
      job_id: extractJobId(receipt).toString(),
      tx_hash: hash, status: receipt.status,
      escrow_wei: price.toString(),
    }};
  }
}
```

*(Các tool còn lại — `register_skill`, `discover_skills`, `deliver_result`, `complete_job`, `get_agent_reputation`, `query_social_graph` — giữ logic v2, gọi qua viem ContractClient batched; áp dụng cùng quy tắc: bỏ requiredScopes, stringify BigInt, in-process singleton.)*

---

## Part 8 — ContractClient (viem, batched — D-9)

```typescript
// src/lib/contract.ts
import { defineChain, createPublicClient, createWalletClient, http } from 'viem';

export const pharosAtlantic = defineChain({
  id: Number(process.env.PHAROS_CHAIN_ID),          // VERIFY LIVE bằng eth_chainId (D-4)
  name: 'Pharos Atlantic',
  nativeCurrency: { decimals: 18, name: 'Pharos', symbol: 'PHRS' },
  rpcUrls: { default: { http: [process.env.PHAROS_RPC_URL!], webSocket: [process.env.PHAROS_WSS_URL!] } },
  blockExplorers: { default: { name: 'PharosScan', url: 'https://atlantic.pharosscan.xyz' } },
  // contracts: { multicall3: { address: '0x...' } },   // CHỈ bật sau khi verify deploy on-chain
});

// Batch JSON-RPC ở transport: gói nhiều call vào 1 HTTP — không cần Multicall3 (D-9)
const transport = http(process.env.PHAROS_RPC_URL, { batch: { batchSize: 100 } });

export const publicClient = createPublicClient({
  chain: pharosAtlantic, transport,
  // batch: { multicall: true },   // optional, chỉ khi Multicall3 đã deploy
});
export const walletClient = createWalletClient({ chain: pharosAtlantic, transport });

// Index incremental theo event (D-10) — đăng ký 1 lần lúc startup
export function startIndexer(address, abi) {
  publicClient.watchContractEvent({ address, abi, eventName: 'SkillRegistered',
    onLogs: (logs) => logs.forEach(l => skillIndex.upsert(toDoc(l.args))) });
  publicClient.watchContractEvent({ address, abi, eventName: 'SkillDeactivated',
    onLogs: (logs) => logs.forEach(l => skillIndex.deactivate(Number(l.args.skillId))) });
}
```

**Lưu ý gas (D-4):** viem mặc định EIP-1559 (`maxFeePerGas`). Pharos chưa tài liệu hoá gas mode → test 1 tx thật ở Hour 0-2; nếu mạng chỉ nhận legacy, set `type: 'legacy'` + `gasPrice`.

---

## Part 9 — Environment Configuration

### `KARMA/.env`
```env
# ── KARMA Core ───────────────────────────────────────────────
NODE_ENV=development
TRANSPORT_DRIVER=http
HTTP_HOST=127.0.0.1
HTTP_PORT=3333
STORAGE_DRIVER=fs
MCP_PROJECT_ID=KARMA
MCP_TENANT_ID=tenant_local
TELEMETRY_DRIVER=stderr
MCP_AUTH_MODE=api_key
MCP_API_KEY=<>=32_chars>
ALLOWED_HOSTS=127.0.0.1:3333,localhost:3333
ALLOWED_ORIGINS=http://localhost:3333

# ── Plugin System (in-process trusted built-in — D-1/D-3) ────
MCP_SAFE_MODE=false
MCP_PLUGIN_ALLOWLIST=system.tool.ts,karma.tool.ts
MCP_PLUGIN_ISOLATION_MODE=policy        # KHÔNG external
# (Yêu cầu patch isTrustedBuiltInPlugin() để nhận karma.tool.ts)

# ── Abuse Controls ───────────────────────────────────────────
ENABLE_RATE_LIMIT=true
RATE_LIMIT_MAX_REQUESTS=200
RATE_LIMIT_WINDOW_MS=60000

# ── Pharos Atlantic ──────────────────────────────────────────
PHAROS_RPC_URL=https://atlantic.dplabs-internal.com
PHAROS_WSS_URL=wss://atlantic.dplabs-internal.com
PHAROS_CONTRACT_ADDRESS=0x<deploy & fill>
PHAROS_CHAIN_ID=<VERIFY_LIVE>           # 688688 vs 688689 — gọi eth_chainId (D-4)
PHAROS_EXPLORER=https://atlantic.pharosscan.xyz/

# ── Keystore (in-process; KHÔNG truyền qua child) ────────────
KEYSTORE_PATH=./keystore.json
KEYSTORE_PASSWORD=<your_password>
```

> Vì plugin in-process, biến `PHAROS_*`/`KEYSTORE_*` đọc trực tiếp từ `process.env` của tiến trình chính (không vướng `workerEnv()` allowlist).

---

## Part 10 — Security & Best Practices (đã hiệu chỉnh — D-13)

KARMA tuân theo các best-practice bảo mật *(chưa qua audit bên thứ ba — không claim "CertiK compliance")*:
1. **RPC Resiliency:** Batch JSON-RPC ở transport (D-9) giảm request dưới rate-limit 500/5min; index incremental theo event (D-10).
2. **Type Safety:** viem type-safe từ ABI `as const`; kiến trúc stateless.
3. **No Private Key In-flight:** KeystoreManager giải mã Web3 Secret Storage v3, key không rời class; đường nâng cấp Vault/KMS (DEBT-002) hoặc viem-kms-signer.
4. **Contract safety:** `ReentrancyGuard` + pull-payment + checks-effects-interactions + `claimRefund` chống khoá vốn.
5. **Exactly-once on-chain:** ghim EVM tx nonce / check-before-write (D-7).
6. **Zero-dep search:** MiniSearch BM25.

---

## Part 11 — Critical Path (44h, Revised)

- **Hour 0-2:** Connectivity check — gọi `eth_chainId` (chốt 688688/688689), test 1 tx (chốt gas mode EIP-1559/legacy), claim PHRS faucet, kiểm tra Multicall3 trên explorer.
- **Hour 2-4:** Patch `isTrustedBuiltInPlugin()` + bộ khung `karma.tool.ts` in-process; xác nhận `karma_ping` chạy với `network` capability + safe-mode off.
- **Hour 4-10:** Keystore (Web3 Secret Storage v3) + `setup_keystore.ts`; Smart Contract + Foundry tests (refund, reentrancy); deploy + verify (Blockscout/SocialScan).
- **Hour 10-16:** ContractClient batched + `defineChain`; BM25 incremental indexer; `discover_skills` reputation-aware.
- **Hour 16-26:** Job flow (`create_job` exactly-once, `deliver_result`, `complete_job`) — stringify BigInt, idempotency_nonce.
- **Hour 26-34:** Social Graph + reputation queries; integration validation.
- **Hour 34-44:** Demo script (4 tx thật), DEMO.md, DoraHacks submission.

---

## Appendix A — Dependencies

```json
{
  "dependencies": {
    "viem": "^2.x",
    "minisearch": "^7.x",
    "zod": "^4.x"
  },
  "devDependencies": {
    "@openzeppelin/contracts": "^5.x"
  },
  "tooling": { "foundry": "external (forge/cast/anvil)" }
}
```
> `zod` dùng `zod/v4` (khớp codebase: `import { z } from "zod/v4"`). Foundry là toolchain ngoài npm.

## Appendix B — File Tree (Final)

```text
KARMA/
├── .env
├── keystore.json                 ← gitignored
├── src/
│   ├── plugins/
│   │   ├── system.tool.ts        ← patch isTrustedBuiltInPlugin nhận karma.tool.ts
│   │   └── karma.tool.ts         ← NEW (trusted built-in, in-process)
│   ├── core/plugin_loader.ts     ← MOD: isTrustedBuiltInPlugin() += karma.tool.ts
│   └── lib/
│       ├── keystore.ts           ← NEW (Web3 Secret Storage v3)
│       ├── contract.ts           ← NEW (viem batched + defineChain + indexer)
│       ├── bm25_index.ts         ← NEW (MiniSearch incremental + reputation boost)
│       └── types.ts              ← NEW
├── contracts/AgentSkillRegistry.sol  ← NEW (ReentrancyGuard, pull-payment, refund)
├── scripts/{setup_keystore,run_demo}.ts  ← NEW
└── test/AgentSkillRegistry.t.sol ← NEW (Foundry: happy/refund/reentrancy)
```

---

## Appendix C — Checklist khớp hạ tầng (gate trước khi code)

- [ ] `isTrustedBuiltInPlugin()` đã nhận `karma.tool.ts` (D-1)
- [ ] `MCP_PLUGIN_ISOLATION_MODE=policy`, `MCP_SAFE_MODE=false` (D-1/D-3)
- [ ] Tool KARMA **không** khai báo `requiredScopes` (api_key) (D-2)
- [ ] `chainId` đã verify live; gas mode đã xác định (D-4)
- [ ] `KeystoreManager.load()` giải mã thật, MAC check (D-5)
- [ ] Mọi tool result stringify BigInt; không số wei trần trong text (D-6)
- [ ] `create_job` ghim/kiểm tra nonce exactly-once (D-7)
- [ ] Contract có `claimRefund` + `ReentrancyGuard` + pull-payment (D-8)
- [ ] ContractClient bật Batch JSON-RPC; BM25 incremental theo event (D-9/D-10)
- [ ] `discover_skills` dùng `boostDocument` reputation + `filter` (D-11)
```
