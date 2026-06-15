# KARMA — Complete Optimized Spec v3.0

> Chưng cất từ: Spec v2 gốc + Kết quả nghiên cứu Thực tế về Mạng lưới Pharos Atlantic Testnet (Tháng 06/2026)
> Mục tiêu: Tối ưu hoá hạ tầng Skill Economy, tích hợp MiniSearch và Viem.

---

## Δ Delta so với v2.0 (Cập nhật Kiến trúc Thực tế)

| Thay đổi | Lý do | Impact |
|---|---|---|
| **Mạng lưới Pharos Testnet** → **Pharos Atlantic Testnet** | Spec cũ sử dụng RPC chung không khả dụng. Mạng Atlantic `https://atlantic.dplabs-internal.com` (Chain ID 688689) là chuẩn mới nhất được cung cấp. | Cấu hình hạ tầng trọng yếu. |
| **Bổ sung Định tuyến và Rate Limit Handling** | Mạng Pharos hiện tại giới hạn RPC 500 requests / 5 phút. | Thiết kế caching (bm25_index) và hạn chế request dư thừa từ ContractClient (`viem`). |
| Khẳng định sử dụng **Viem** thay cho Ethers.js | Viem đem lại type-safety nguyên bản từ ABI, architecture Stateless tránh rò rỉ bộ nhớ. | Thay thế toàn bộ mã tương tác blockchain. |
| **Thêm `nonce` vào `create_job`** | Lõi KARMA luôn hash toàn bộ `args` cho Idempotency bất chấp `idempotentHint: false`. | Bắt buộc phải có `nonce` để phá vỡ Hash cho các Job trùng lặp. |

---

## Part 1 — Positioning & Narrative

**Tên pitch:** *"Skill Economy Infrastructure for Pharos — The Missing Primitive."*

**One-liner:**

> *"Bất kỳ agent nào muốn delegate subtasks trên Pharos đang phải giải ba vấn đề tách biệt: tìm agent khác, negotiate terms, và settle payment trustlessly. KARMA giải cả ba bằng một on-chain coordination protocol — và mỗi transaction đồng thời build reputation graph cho toàn bộ ecosystem."*

**Tại sao framing này win:**
- Trả lời trực tiếp bài toán thiếu "durable social graphs and payment behaviors".
- Cung cấp mô hình "Skill as code asset".
- Mỗi transaction đồng thời làm 3 việc: thanh toán ủy thác, ghi nhận lịch sử, và xây dựng danh tiếng uy tín.

---

## Part 2 — Architecture (4 Layers)

```text
┌──────────────────────────────────────────────────────────────┐
│  Layer 0: KARMA Infrastructure                               │
│  stdio/HTTP transport · rc2026 protocol · auth (api_key dev) │
│  15-stage execution pipeline · output firewall · telemetry   │
│  idempotency · rate limit · tenant lock · schema validation  │
└─────────────────────────┬────────────────────────────────────┘
                          │  ToolDefinition[] plugin interface
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 1: KARMA Plugin                                       │
│  src/plugins/karma.tool.ts                                   │
│  7 tools: register/discover/create_job/deliver/complete/     │
│           reputation/social_graph                            │
│  KeystoreManager · BM25Index · ContractClient (Viem)         │
└─────────────────────────┬────────────────────────────────────┘
                          │  viem RPC calls (JSON-RPC/ETH)
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 2: On-chain Registry                                  │
│  AgentSkillRegistry.sol (Pharos Atlantic EVM)                │
│  Skill struct · Job struct (state machine) · escrow · rep    │
└─────────────────────────┬────────────────────────────────────┘
                          │  EVM
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 3: Pharos Atlantic Testnet                            │
│  RPC: https://atlantic.dplabs-internal.com                   │
│  PHRS token · Chain ID 688689                                │
└──────────────────────────────────────────────────────────────┘
```

**Clean boundary principle:**
- KARMA lo *how tools are invoked* (transport, auth, rate limit, idempotency, output firewall)
- Lớp Plugin lo *why, at what price, by whom, with what reputation*

---

## Part 3 — Sự tương tác với Lõi KARMA

### 3.1 Output Firewall — Vấn đề `private_key`

Output firewall tại `src/middlewares/output_firewall.ts` scan **cả tool input args lẫn output** cho các trường nhạy cảm: `private_key`, `secret`, `token`.
Nếu tool nhận `private_key` làm tham số đầu vào:
- Telemetry stage (stage 15) ghi toàn bộ args vào JSONL log → Lộ key.
- Idempotency (stage 7) lấy mã băm HMAC-SHA256 từ tham số.

**→ Bắt buộc triển khai Keystore pattern. Tuyệt đối không truyền Private Key thông qua MCP Input.**

### 3.2 Tool Execution Pipeline — Lợi ích tích hợp

- **Stage 4 (Scopes):** Tự động chặn truy cập nếu thiếu JWT/OIDC scopes (`pharos:read` / `pharos:write`).
- **Stage 7 (Idempotency):** Áp dụng bắt buộc cho tất cả các call. Cùng tham số trong TTL sẽ được trả về cache. Do KARMA hash toàn bộ `args` để tạo `idempotencyKey` bất kể `idempotentHint` là true hay false, hàm `create_job` **bắt buộc phải truyền thêm trường `nonce`** để ép hệ thống nhận diện tác vụ mới.

### 3.3 Plugin Network Policy — Critical Config

Phải cấp quyền gọi mạng ra ngoài tới RPC Pharos bằng các biến môi trường:

```env
MCP_EXTERNAL_PLUGIN_NETWORK_POLICY=allow
MCP_SAFE_MODE=false
```

---

## Part 4 — Keystore Pattern (thay thế `private_key` input)

### Design

```typescript
// src/lib/keystore.ts
import { type Address } from 'viem';

interface AgentIdentity {
  agentId: string;
  address: Address;
  privateKey: `0x${string}`;
}

class KeystoreManager {
  private identities: Map<string, AgentIdentity> = new Map();
  
  async load(keystorePath: string, password: string): Promise<void> {
    // Read encrypted JSON keystore
    // Decrypt each agent entry
    // Private keys NEVER leave this class
  }
  
  getPrivateKey(agentId: string): `0x${string}` {
    const identity = this.identities.get(agentId);
    if (!identity) throw new Error(`Agent not found: ${agentId}`);
    return identity.privateKey; // Used strictly internally with Viem
  }
  
  getAddress(agentId: string): Address {
    return this.identities.get(agentId)!.address;
  }
}

export const keystoreManager = new KeystoreManager();
```

**Input schema:**
`{ private_key: string, name: string }` ➔ `{ agent_id: string, name: string }`

---

## Part 5 — Smart Contract (Refined)

### AgentSkillRegistry.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract AgentSkillRegistry {
    
    // ─── Structs ───────────────────────────────────────────────
    
    struct Skill {
        address owner;
        string name;
        string description;
        string mcpEndpoint;
        uint256 pricePerCall;    // in wei
        uint256 reputationScore; // 0-100, starts 50
        uint256 totalInvocations;
        bool active;
        uint256 registeredAt;
    }

    struct Job {
        address requester;
        address provider;        // skill owner at time of job creation
        uint256 skillId;
        bytes32 taskHash;        // keccak256(abi.encode(taskParams))
        uint256 escrowAmount;
        uint256 deadline;        // unix timestamp
        JobStatus status;
        bytes32 resultHash;      // keccak256(abi.encode(resultData))
        uint256 createdAt;
        uint256 completedAt;
    }

    enum JobStatus { 
        Open,       // created, escrow locked
        Delivered,  // provider submitted result hash
        Completed,  // requester confirmed, escrow released
        Disputed    // future extension
    }

    // ─── State ─────────────────────────────────────────────────

    uint256 private _skillIdCounter;
    uint256 private _jobIdCounter;

    mapping(uint256 => Skill) public skills;
    mapping(uint256 => Job) public jobs;
    
    mapping(address => uint256[]) public agentProviderJobs;
    mapping(address => uint256[]) public agentRequesterJobs;
    mapping(address => uint256[]) public agentSkills;

    // ─── Events ────────────────────────────────────────────────
    // (SkillRegistered, JobCreated, ResultDelivered, JobCompleted...)
    
    // ─── Functions ─────────────────────────────────────────────
    // registerSkill, createJob (payable), deliverResult, confirmCompletion
    // (Full logic retained from v2.0)
}
```

---

## Part 6 — BM25 Search Architecture

```typescript
// src/lib/bm25_index.ts
import MiniSearch from 'minisearch'; // pure JS, zero native deps

interface SkillDocument {
  id: number;
  skill_id: number;
  name: string;
  description: string;
  mcp_endpoint: string;
  price_per_call_wei: string;
  reputation_score: number;
  owner_address: string;
}

class BM25SkillIndex {
  private index: MiniSearch<SkillDocument>;
  
  constructor() {
    this.index = new MiniSearch({
      fields: ['name', 'description'],       // indexed fields
      storeFields: ['skill_id', 'mcp_endpoint', 'price_per_call_wei', 'reputation_score', 'owner_address'],
      searchOptions: {
        boost: { name: 2 }, fuzzy: 0.2, prefix: true
      }
    });
  }

  async rebuildFromChain(contractClient: any): Promise<void> {
    // Fetch active skills from chain using Viem and re-index
  }

  search(query: string, options?: any): SkillDocument[] {
    return this.index.search(query, options);
  }
}

export const skillIndex = new BM25SkillIndex();
```

---

## Part 7 — Tool Definitions (KARMA Format)

### `create_job` (Sửa đổi cốt lõi: Thêm `nonce`)

```typescript
{
  name: 'create_job',
  description: 'Create a job with payment locked in escrow.',
  inputSchema: {
    agent_id: z.string().min(1).max(64),
    skill_id: z.number().int().positive(),
    task_params_json: z.string().max(4096),
    deadline_hours: z.number().int().min(1).max(168),
    nonce: z.number().int().positive()
      .describe('A unique timestamp or nonce to bypass idempotency cache for duplicate jobs'),
  },
  capabilities: ['network'],
  requiredScopes: ['pharos:write'],
  allowedPhases: ['intake', 'execution'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  execution: { taskSupport: 'optional' },

  handler: async (args) => {
    const { agent_id, skill_id, task_params_json, deadline_hours, nonce } = args as any;
    // ... logic tạo job bằng viem
  }
}
```
*(Các Tool còn lại `register_skill`, `discover_skills`, `deliver_result`, `complete_job`, `get_agent_reputation`, `query_social_graph` giữ nguyên logic từ Spec v2, gọi qua Viem ContractClient)*

---

## Part 8 — Self-Referential Demo Design

**Kịch bản Demo Tự tham chiếu Thực chiến:**
Mô phỏng trường hợp Agent Alpha sử dụng chính hệ thống KARMA để đăng ký cái Tool MCP tìm kiếm (`discover_skills`) biến nó thành một dịch vụ trả phí trên Pharos Atlantic. Một Agent Beta khác trên mạng lưới sẽ khóa PHRS, tạo Job On-chain và thực hiện trả tiền để truy vấn kết quả tìm kiếm từ Agent Alpha.
**Đặc tính:** Không dùng Mock Data, 100% sử dụng 4 chuỗi Transaction Hashes thật, thể hiện đầy đủ chu trình tương tác Web3.

---

## Part 9 — Environment Configuration

### `KARMA/.env`
```env
# ── KARMA Core ────────────────────────────────────────────────
NODE_ENV=development
TRANSPORT_DRIVER=http
HTTP_HOST=127.0.0.1
HTTP_PORT=3333
STORAGE_DRIVER=fs
MCP_PROJECT_ID=KARMA
MCP_TENANT_ID=tenant_local
TELEMETRY_DRIVER=stderr
MCP_AUTH_MODE=api_key
MCP_API_KEY=<your_api_key>
ALLOWED_HOSTS=127.0.0.1:3333,localhost:3333

# ── Plugin System ───────────────────────────────────────────────
MCP_SAFE_MODE=false
MCP_PLUGIN_ALLOWLIST=system.tool.ts,karma.tool.ts
MCP_PLUGIN_ISOLATION_MODE=external
MCP_EXTERNAL_PLUGIN_NETWORK_POLICY=allow
MCP_EXTERNAL_PLUGIN_FS_POLICY=read-only
MCP_EXTERNAL_PLUGIN_TIMEOUT_MS=30000

# ── Abuse Controls & Rate Limiting ──────────────────────────────
ENABLE_RATE_LIMIT=true
RATE_LIMIT_MAX_REQUESTS=200
RATE_LIMIT_WINDOW_MS=60000

# ── Application Specific ─────────────────────────────────
# Mạng Pharos Atlantic Testnet
PHAROS_RPC_URL=https://atlantic.dplabs-internal.com
PHAROS_WSS_URL=wss://atlantic.dplabs-internal.com/
PHAROS_CONTRACT_ADDRESS=0x<deploy and fill in>
PHAROS_CHAIN_ID=688689
PHAROS_EXPLORER=https://atlantic.pharosscan.xyz/

KEYSTORE_PATH=./keystore.json
KEYSTORE_PASSWORD=<your_password>
PHAROS_INDEX_REBUILD_INTERVAL_BLOCKS=10
```

---

## Part 10 — CertiK Compliance & Best Practices

KARMA đáp ứng các tiêu chuẩn bảo mật khắt khe:
1. **RPC Resiliency:** Sử dụng `viem` để tạo ra các tương tác tin cậy, nhẹ nhàng, tối giản hóa số lượng request lên mạng lưới đang rate limit 500 req/5 phút.
2. **Type Safety & No Memory Leaks:** Kiến trúc thuần túy Stateless của `Viem`.
3. **No Private Key In-flight:** Cơ chế KeystoreManager.
4. **No External Dependecies cho Search:** MiniSearch zero-deps.

---

## Part 11 — Critical Path (44h, Revised)

- **Hour 0-2:** Setup & Pharos Atlantic Connectivity Check.
- **Hour 2-8:** Keystore module & Smart Contract Deployment.
- **Hour 8-14:** Viem Bindings & BM25 Search implementation (`discover_skills`).
- **Hour 14-24:** Job flow implementation (`create_job` with nonce, `deliver_result`, `complete_job`).
- **Hour 24-32:** Social Graph queries & Integration validation.
- **Hour 32-44:** Documentation, Demo Script & DoraHacks Submission.

---

## Appendix A — Dependencies

```json
{
  "dependencies": {
    "viem": "^2.x",
    "minisearch": "^7.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "foundry": "latest"
  }
}
```

## Appendix B — File Tree (Final)

```text
KARMA/
├── .env
├── keystore.json                 ← gitignored
├── README.md
├── SKILL.md
├── DEMO.md
├── src/
│   ├── index.ts
│   ├── config/env.ts
│   ├── lib/
│   │   ├── keystore.ts           ← NEW
│   │   ├── contract.ts           ← NEW (viem wrapper)
│   │   ├── bm25_index.ts         ← NEW (MiniSearch)
│   │   └── types.ts              ← NEW
│   └── plugins/
│       ├── system.tool.ts
│       └── karma.tool.ts         ← NEW
├── contracts/
│   └── AgentSkillRegistry.sol    ← NEW
├── scripts/
│   ├── setup_keystore.ts         ← NEW
│   └── run_demo.ts               ← NEW
└── test/
    └── AgentSkillRegistry.t.sol  ← NEW
```
