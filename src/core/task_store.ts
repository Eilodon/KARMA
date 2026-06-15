import { createHash, randomBytes } from "node:crypto";
import { ENV } from "../config/env.js";
import { getRedisClient } from "../storage/redis_client.js";

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface TaskHandleRecord {
  taskId: string;
  /** Internal idempotency key - never exposed to callers. */
  idempotencyKey: string;
  tenantId: string;
  /** Ownership string: "<tenantId>:<clientId>:<userId>" */
  owner: string;
  toolName: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: number; // epoch ms
  result?: unknown;
  error?: string;
  cancelReason?: string;
  cancelledAt?: string;
  inputRequests?: Record<string, {
    method: string;
    params: Record<string, unknown>;
    /** Per-prompt nonce that must be echoed by tasks/update. */
    inputRequestId?: string;
  }>;
  lastClientInput?: {
    inputRequestId: string;
    inputResponses: Record<string, unknown>;
    updatedAt: string;
  };
  metadata?: Record<string, unknown>;
}

export interface CreateTaskInput {
  idempotencyKey: string;
  tenantId: string;
  owner: string;
  toolName: string;
  ttlSeconds: number;
  result?: unknown;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  result?: unknown;
  error?: string;
  cancelReason?: string;
  cancelledAt?: string;
  inputRequests?: TaskHandleRecord["inputRequests"];
  lastClientInput?: TaskHandleRecord["lastClientInput"];
  metadata?: Record<string, unknown>;
  /** Optional TTL reset for status transitions that should expire earlier. */
  ttlSeconds?: number;
}

export interface ConsumeTaskInputInput {
  inputRequestId: string;
  inputResponses: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type ConsumeTaskInputFailureReason =
  | "not_found"
  | "not_input_required"
  | "missing_input_request"
  | "stale_input_request";

export type ConsumeTaskInputResult =
  | { ok: true; record: TaskHandleRecord; requestKey: string }
  | { ok: false; reason: ConsumeTaskInputFailureReason; record?: TaskHandleRecord };

export interface ITaskStore {
  createTask(input: CreateTaskInput): Promise<TaskHandleRecord>;
  getTask(taskId: string): Promise<TaskHandleRecord | null>;
  updateTask(taskId: string, patch: UpdateTaskInput): Promise<TaskHandleRecord | null>;
  consumeTaskInput(taskId: string, input: ConsumeTaskInputInput): Promise<ConsumeTaskInputResult>;
  cancelTask(taskId: string, reason?: string): Promise<TaskHandleRecord | null>;
}

export interface TaskStoreMaintenance {
  findTaskId(idempotencyKey: string): Promise<string | undefined>;
  deleteTask(taskId: string): Promise<void>;
  deleteByIdempotencyKey(idempotencyKey: string): Promise<void>;
  close(): Promise<void> | void;
  readonly size?: number;
}

export type TaskStore = ITaskStore & TaskStoreMaintenance;

type RedisTaskClient = {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number | string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  eval(script: string, keyCount: number, ...args: unknown[]): Promise<unknown>;
};

const TASK_ID_PATTERN = /^task_[0-9a-f]{16}$/;
const TASK_ID_COLLISION = "__KARMA_TASK_ID_COLLISION__";

/** Generates a public task handle like "task_3f9a1b2c4d5e6f7a". */
function generateTaskId(): string {
  return `task_${randomBytes(8).toString("hex")}`;
}

/** Validates the public task_id format. */
export function isValidTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function ttlSecondsToExpiresAt(ttlSeconds: number, now = Date.now()): number {
  const safeTtlSeconds = Math.max(1, Math.floor(ttlSeconds));
  return now + safeTtlSeconds * 1000;
}

function ttlSecondsFromExpiresAt(expiresAt: number): number {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
}

function cloneRecord(record: TaskHandleRecord): TaskHandleRecord {
  return JSON.parse(JSON.stringify(record)) as TaskHandleRecord;
}

function taskStorePrefix(): string {
  return `karma:tasks:${ENV.MCP_PROJECT_ID}:`;
}

function hashIdempotencyKey(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function isLive(record: TaskHandleRecord): boolean {
  return Date.now() < record.expiresAt;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function findInputRequestKeyById(
  inputRequests: TaskHandleRecord["inputRequests"] | undefined,
  inputRequestId: string,
): string | undefined {
  if (!inputRequests || inputRequestId.trim().length === 0) return undefined;
  for (const [requestKey, request] of Object.entries(inputRequests)) {
    const params = objectValue(request.params);
    const meta = objectValue(params?._meta);
    if (
      request.inputRequestId === inputRequestId ||
      params?.inputRequestId === inputRequestId ||
      meta?.inputRequestId === inputRequestId
    ) {
      return requestKey;
    }
  }
  return undefined;
}

function mergeMetadata(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!current && !patch) return undefined;
  return { ...(current || {}), ...(patch || {}) };
}

export class MemoryTaskStore implements TaskStore {
  private readonly byTaskId = new Map<string, TaskHandleRecord>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.purgeExpired(), 5 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  async createTask(input: CreateTaskInput): Promise<TaskHandleRecord> {
    const existingTaskId = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existingTaskId) {
      const existing = await this.getTask(existingTaskId);
      if (existing) return existing;
      this.byIdempotencyKey.delete(input.idempotencyKey);
    }

    let taskId = generateTaskId();
    while (this.byTaskId.has(taskId)) taskId = generateTaskId();

    const now = Date.now();
    const record: TaskHandleRecord = {
      taskId,
      idempotencyKey: input.idempotencyKey,
      tenantId: input.tenantId,
      owner: input.owner,
      toolName: input.toolName,
      status: "working",
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
      expiresAt: ttlSecondsToExpiresAt(input.ttlSeconds, now),
      result: input.result,
      metadata: input.metadata,
    };
    this.byTaskId.set(taskId, record);
    this.byIdempotencyKey.set(input.idempotencyKey, taskId);
    this.purgeExpired();
    return cloneRecord(record);
  }

  async getTask(taskId: string): Promise<TaskHandleRecord | null> {
    if (!isValidTaskId(taskId)) return null;
    const record = this.byTaskId.get(taskId);
    if (!record) return null;
    if (!isLive(record)) {
      await this.deleteTask(taskId);
      return null;
    }
    return cloneRecord(record);
  }

  async updateTask(taskId: string, patch: UpdateTaskInput): Promise<TaskHandleRecord | null> {
    const record = this.byTaskId.get(taskId);
    if (!record) return null;
    if (!isLive(record)) {
      await this.deleteTask(taskId);
      return null;
    }

    const next: TaskHandleRecord = {
      ...record,
      ...patch,
      taskId: record.taskId,
      idempotencyKey: record.idempotencyKey,
      tenantId: record.tenantId,
      owner: record.owner,
      toolName: record.toolName,
      createdAt: record.createdAt,
      updatedAt: nowIso(),
      expiresAt: patch.ttlSeconds !== undefined
        ? ttlSecondsToExpiresAt(patch.ttlSeconds)
        : record.expiresAt,
    };
    delete (next as { ttlSeconds?: number }).ttlSeconds;
    this.byTaskId.set(taskId, next);
    this.byIdempotencyKey.set(next.idempotencyKey, taskId);
    return cloneRecord(next);
  }

  async consumeTaskInput(taskId: string, input: ConsumeTaskInputInput): Promise<ConsumeTaskInputResult> {
    const record = this.byTaskId.get(taskId);
    if (!record) return { ok: false, reason: "not_found" };
    if (!isLive(record)) {
      await this.deleteTask(taskId);
      return { ok: false, reason: "not_found" };
    }
    if (record.status !== "input_required") {
      return { ok: false, reason: "not_input_required", record: cloneRecord(record) };
    }
    if (!record.inputRequests || Object.keys(record.inputRequests).length === 0) {
      return { ok: false, reason: "missing_input_request", record: cloneRecord(record) };
    }
    const requestKey = findInputRequestKeyById(record.inputRequests, input.inputRequestId);
    if (!requestKey) {
      return { ok: false, reason: "stale_input_request", record: cloneRecord(record) };
    }

    const updatedAt = nowIso();
    const next: TaskHandleRecord = {
      ...record,
      status: "working",
      updatedAt,
      inputRequests: undefined,
      lastClientInput: {
        inputRequestId: input.inputRequestId,
        inputResponses: input.inputResponses,
        updatedAt,
      },
      metadata: mergeMetadata(record.metadata, input.metadata),
    };
    this.byTaskId.set(taskId, next);
    this.byIdempotencyKey.set(next.idempotencyKey, taskId);
    return { ok: true, record: cloneRecord(next), requestKey };
  }

  async cancelTask(taskId: string, reason = "cancelled"): Promise<TaskHandleRecord | null> {
    return this.updateTask(taskId, {
      status: "cancelled",
      cancelReason: reason,
      cancelledAt: nowIso(),
    });
  }

  async findTaskId(idempotencyKey: string): Promise<string | undefined> {
    const taskId = this.byIdempotencyKey.get(idempotencyKey);
    if (!taskId) return undefined;
    const record = await this.getTask(taskId);
    if (!record) {
      this.byIdempotencyKey.delete(idempotencyKey);
      return undefined;
    }
    return taskId;
  }

  async deleteTask(taskId: string): Promise<void> {
    const record = this.byTaskId.get(taskId);
    if (record) this.byIdempotencyKey.delete(record.idempotencyKey);
    this.byTaskId.delete(taskId);
  }

  async deleteByIdempotencyKey(idempotencyKey: string): Promise<void> {
    const taskId = this.byIdempotencyKey.get(idempotencyKey);
    if (taskId) this.byTaskId.delete(taskId);
    this.byIdempotencyKey.delete(idempotencyKey);
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.byTaskId.clear();
    this.byIdempotencyKey.clear();
  }

  get size(): number {
    this.purgeExpired();
    return this.byTaskId.size;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [taskId, record] of this.byTaskId) {
      if (now >= record.expiresAt) {
        this.byTaskId.delete(taskId);
        this.byIdempotencyKey.delete(record.idempotencyKey);
      }
    }
  }
}

export class RedisTaskStore implements TaskStore {
  constructor(private readonly redis: RedisTaskClient = getRedisClient()) {}

  private get taskKeyPrefix(): string {
    return taskStorePrefix();
  }

  private taskKey(taskId: string): string {
    return `${this.taskKeyPrefix}${taskId}`;
  }

  private idempotencyIndexKey(idempotencyKey: string): string {
    return `${this.taskKeyPrefix}idem:${hashIdempotencyKey(idempotencyKey)}`;
  }

  async createTask(input: CreateTaskInput): Promise<TaskHandleRecord> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const taskId = generateTaskId();
      const now = Date.now();
      const record: TaskHandleRecord = {
        taskId,
        idempotencyKey: input.idempotencyKey,
        tenantId: input.tenantId,
        owner: input.owner,
        toolName: input.toolName,
        status: "working",
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
        expiresAt: ttlSecondsToExpiresAt(input.ttlSeconds, now),
        result: input.result,
        metadata: input.metadata,
      };
      const ttlSeconds = ttlSecondsFromExpiresAt(record.expiresAt);
      const rawRecord = JSON.stringify(record);
      const script = `
        local existingTaskId = redis.call('GET', KEYS[1])
        if existingTaskId then
          local existingRaw = redis.call('GET', ARGV[3] .. existingTaskId)
          if existingRaw then
            return existingRaw
          end
          redis.call('DEL', KEYS[1])
        end
        if redis.call('EXISTS', KEYS[2]) == 1 then
          return ARGV[5]
        end
        redis.call('SETEX', KEYS[2], ARGV[1], ARGV[2])
        redis.call('SETEX', KEYS[1], ARGV[1], ARGV[4])
        return ARGV[2]
      `;
      const raw = await this.redis.eval(
        script,
        2,
        this.idempotencyIndexKey(input.idempotencyKey),
        this.taskKey(taskId),
        ttlSeconds.toString(),
        rawRecord,
        this.taskKeyPrefix,
        taskId,
        TASK_ID_COLLISION,
      );
      if (raw === TASK_ID_COLLISION) continue;
      const parsed = this.parseRecord(raw);
      if (parsed) return parsed;
    }
    throw new Error("[KARMA] Failed to allocate a unique task_id after retries.");
  }

  async getTask(taskId: string): Promise<TaskHandleRecord | null> {
    if (!isValidTaskId(taskId)) return null;
    const raw = await this.redis.get(this.taskKey(taskId));
    const record = this.parseRecord(raw);
    if (!record) return null;
    if (!isLive(record)) {
      await this.deleteTask(taskId);
      return null;
    }
    return record;
  }

  async updateTask(taskId: string, patch: UpdateTaskInput): Promise<TaskHandleRecord | null> {
    const current = await this.getTask(taskId);
    if (!current) return null;
    const next: TaskHandleRecord = {
      ...current,
      ...patch,
      taskId: current.taskId,
      idempotencyKey: current.idempotencyKey,
      tenantId: current.tenantId,
      owner: current.owner,
      toolName: current.toolName,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
      expiresAt: patch.ttlSeconds !== undefined
        ? ttlSecondsToExpiresAt(patch.ttlSeconds)
        : current.expiresAt,
    };
    delete (next as { ttlSeconds?: number }).ttlSeconds;
    const ttlSeconds = ttlSecondsFromExpiresAt(next.expiresAt);
    await Promise.all([
      this.redis.setex(this.taskKey(taskId), ttlSeconds, JSON.stringify(next)),
      this.redis.setex(this.idempotencyIndexKey(next.idempotencyKey), ttlSeconds, taskId),
    ]);
    return cloneRecord(next);
  }

  async consumeTaskInput(taskId: string, input: ConsumeTaskInputInput): Promise<ConsumeTaskInputResult> {
    if (!isValidTaskId(taskId)) return { ok: false, reason: "not_found" };
    const now = Date.now();
    const updatedAt = nowIso(now);
    const lastClientInput = JSON.stringify({
      inputRequestId: input.inputRequestId,
      inputResponses: input.inputResponses,
      updatedAt,
    });
    const metadataPatch = JSON.stringify(input.metadata || {});
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return ARGV[5] end
      local ok, record = pcall(cjson.decode, raw)
      if not ok or type(record) ~= 'table' then return ARGV[5] end
      if tonumber(record['expiresAt'] or '0') <= tonumber(ARGV[1]) then
        redis.call('DEL', KEYS[1])
        return ARGV[5]
      end
      if record['status'] ~= 'input_required' then return ARGV[6] .. raw end
      local requests = record['inputRequests']
      if type(requests) ~= 'table' then return ARGV[7] .. raw end
      local requestKey = nil
      for key, request in pairs(requests) do
        if type(request) == 'table' then
          if request['inputRequestId'] == ARGV[2] then requestKey = key end
          local params = request['params']
          if type(params) == 'table' then
            if params['inputRequestId'] == ARGV[2] then requestKey = key end
            local meta = params['_meta']
            if type(meta) == 'table' and meta['inputRequestId'] == ARGV[2] then requestKey = key end
          end
        end
      end
      if not requestKey then return ARGV[8] .. raw end
      record['status'] = 'working'
      record['updatedAt'] = ARGV[3]
      record['inputRequests'] = nil
      record['lastClientInput'] = cjson.decode(ARGV[4])
      local metadataPatch = cjson.decode(ARGV[9])
      if type(record['metadata']) ~= 'table' then record['metadata'] = {} end
      for key, value in pairs(metadataPatch) do
        record['metadata'][key] = value
      end
      local ttl = math.max(1, math.ceil((tonumber(record['expiresAt']) - tonumber(ARGV[1])) / 1000))
      local encoded = cjson.encode(record)
      redis.call('SETEX', KEYS[1], ttl, encoded)
      return ARGV[10] .. requestKey .. ':' .. encoded
    `;
    const notFound = "__KARMA_CONSUME_NOT_FOUND__";
    const notInputRequired = "__KARMA_CONSUME_NOT_INPUT_REQUIRED__:";
    const missingInputRequest = "__KARMA_CONSUME_MISSING_INPUT_REQUEST__:";
    const staleInputRequest = "__KARMA_CONSUME_STALE_INPUT_REQUEST__:";
    const consumed = "__KARMA_CONSUME_OK__:";
    const raw = await this.redis.eval(
      script,
      1,
      this.taskKey(taskId),
      now.toString(),
      input.inputRequestId,
      updatedAt,
      lastClientInput,
      notFound,
      notInputRequired,
      missingInputRequest,
      staleInputRequest,
      metadataPatch,
      consumed,
    );
    if (raw === notFound) return { ok: false, reason: "not_found" };
    if (typeof raw !== "string") return { ok: false, reason: "not_found" };
    if (raw.startsWith(notInputRequired)) {
      return { ok: false, reason: "not_input_required", record: this.parseRecord(raw.slice(notInputRequired.length)) || undefined };
    }
    if (raw.startsWith(missingInputRequest)) {
      return { ok: false, reason: "missing_input_request", record: this.parseRecord(raw.slice(missingInputRequest.length)) || undefined };
    }
    if (raw.startsWith(staleInputRequest)) {
      return { ok: false, reason: "stale_input_request", record: this.parseRecord(raw.slice(staleInputRequest.length)) || undefined };
    }
    if (raw.startsWith(consumed)) {
      const remainder = raw.slice(consumed.length);
      const separator = remainder.indexOf(":");
      const requestKey = separator >= 0 ? remainder.slice(0, separator) : "default";
      const recordRaw = separator >= 0 ? remainder.slice(separator + 1) : remainder;
      const record = this.parseRecord(recordRaw);
      if (!record) return { ok: false, reason: "not_found" };
      return { ok: true, record, requestKey };
    }
    return { ok: false, reason: "not_found" };
  }

  async cancelTask(taskId: string, reason = "cancelled"): Promise<TaskHandleRecord | null> {
    return this.updateTask(taskId, {
      status: "cancelled",
      cancelReason: reason,
      cancelledAt: nowIso(),
    });
  }

  async findTaskId(idempotencyKey: string): Promise<string | undefined> {
    const key = this.idempotencyIndexKey(idempotencyKey);
    const taskId = await this.redis.get(key);
    if (!taskId) return undefined;
    const record = await this.getTask(taskId);
    if (!record) {
      await this.redis.del(key);
      return undefined;
    }
    return taskId;
  }

  async deleteTask(taskId: string): Promise<void> {
    const record = await this.getTask(taskId);
    if (record) {
      await this.redis.del(this.taskKey(taskId), this.idempotencyIndexKey(record.idempotencyKey));
      return;
    }
    await this.redis.del(this.taskKey(taskId));
  }

  async deleteByIdempotencyKey(idempotencyKey: string): Promise<void> {
    const indexKey = this.idempotencyIndexKey(idempotencyKey);
    const taskId = await this.redis.get(indexKey);
    if (taskId) await this.redis.del(this.taskKey(taskId));
    await this.redis.del(indexKey);
  }

  async close(): Promise<void> {
    // Shared Redis connection lifecycle is owned by storage/redis_client.ts.
  }

  private parseRecord(raw: unknown): TaskHandleRecord | null {
    if (typeof raw !== "string") return null;
    try {
      const parsed = JSON.parse(raw) as TaskHandleRecord;
      if (!isValidTaskId(parsed.taskId)) return null;
      if (typeof parsed.idempotencyKey !== "string") return null;
      if (typeof parsed.tenantId !== "string") return null;
      if (typeof parsed.owner !== "string") return null;
      if (typeof parsed.toolName !== "string") return null;
      if (!["working", "input_required", "completed", "failed", "cancelled"].includes(parsed.status)) return null;
      if (typeof parsed.expiresAt !== "number") return null;
      return cloneRecord(parsed);
    } catch {
      return null;
    }
  }
}

export function createTaskStore(): TaskStore {
  return ENV.STORAGE_DRIVER === "redis"
    ? new RedisTaskStore()
    : new MemoryTaskStore();
}

export const globalTaskStore: TaskStore = createTaskStore();
