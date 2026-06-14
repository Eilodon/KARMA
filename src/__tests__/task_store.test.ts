import { afterEach, describe, expect, test, vi } from "vitest";
import { MemoryTaskStore, RedisTaskStore, isValidTaskId } from "../core/task_store.js";

function createInput(idempotencyKey: string, ttlSeconds = 3600) {
  return {
    idempotencyKey,
    tenantId: "tenant-1",
    owner: "api-key:client:user",
    toolName: "my_tool",
    ttlSeconds,
  };
}

class FakeRedis {
  values = new Map<string, string>();
  expiries = new Map<string, number>();

  private cleanup(key: string): void {
    const expiresAt = this.expiries.get(key);
    if (expiresAt !== undefined && Date.now() >= expiresAt) {
      this.values.delete(key);
      this.expiries.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.cleanup(key);
    return this.values.get(key) || null;
  }

  async setex(key: string, seconds: number | string, value: string): Promise<void> {
    this.values.set(key, value);
    this.expiries.set(key, Date.now() + Number(seconds) * 1000);
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
      this.expiries.delete(key);
    }
    return deleted;
  }

  async eval(_script: string, keyCount: number, ...args: unknown[]): Promise<unknown> {
    if (keyCount === 2) {
      const [idempotencyIndexKey, taskKey] = args.slice(0, 2) as [string, string];
      const [ttlSeconds, rawRecord, taskKeyPrefix, taskId, collisionToken] = args.slice(2) as [string, string, string, string, string];

      const existingTaskId = await this.get(idempotencyIndexKey);
      if (existingTaskId) {
        const existingRaw = await this.get(`${taskKeyPrefix}${existingTaskId}`);
        if (existingRaw) return existingRaw;
        await this.del(idempotencyIndexKey);
      }

      if (await this.get(taskKey)) return collisionToken;
      await this.setex(taskKey, ttlSeconds, rawRecord);
      await this.setex(idempotencyIndexKey, ttlSeconds, taskId);
      return rawRecord;
    }

    if (keyCount === 1) {
      const [taskKey] = args.slice(0, 1) as [string];
      const [nowRaw, inputRequestId, updatedAt, lastClientInputRaw, notFound, notInputRequired, missingInputRequest, staleInputRequest, metadataPatchRaw, consumed] = args.slice(1) as string[];
      const raw = await this.get(taskKey);
      if (!raw) return notFound;
      const record = JSON.parse(raw) as any;
      if (Number(record.expiresAt || 0) <= Number(nowRaw)) {
        await this.del(taskKey);
        return notFound;
      }
      if (record.status !== "input_required") return `${notInputRequired}${raw}`;
      if (!record.inputRequests || typeof record.inputRequests !== "object") return `${missingInputRequest}${raw}`;

      let requestKey: string | undefined;
      for (const [key, request] of Object.entries(record.inputRequests) as [string, any][]) {
        if (request?.inputRequestId === inputRequestId) requestKey = key;
        if (request?.params?.inputRequestId === inputRequestId) requestKey = key;
        if (request?.params?._meta?.inputRequestId === inputRequestId) requestKey = key;
      }
      if (!requestKey) return `${staleInputRequest}${raw}`;

      record.status = "working";
      record.updatedAt = updatedAt;
      delete record.inputRequests;
      record.lastClientInput = JSON.parse(lastClientInputRaw);
      record.metadata = { ...(record.metadata || {}), ...JSON.parse(metadataPatchRaw || "{}") };
      const ttl = Math.max(1, Math.ceil((Number(record.expiresAt) - Number(nowRaw)) / 1000));
      const encoded = JSON.stringify(record);
      await this.setex(taskKey, ttl, encoded);
      return `${consumed}${requestKey}:${encoded}`;
    }

    throw new Error("Unexpected key count");
  }
}

describe("isValidTaskId", () => {
  test("accepts well-formed task_id", () => {
    expect(isValidTaskId("task_3f9a1b2c4d5e6f7a")).toBe(true);
    expect(isValidTaskId("task_0000000000000000")).toBe(true);
    expect(isValidTaskId("task_ffffffffffffffff")).toBe(true);
  });

  test("rejects malformed task ids", () => {
    expect(isValidTaskId("job_3f9a1b2c4d5e6f7a")).toBe(false);
    expect(isValidTaskId("task_3f9a")).toBe(false);
    expect(isValidTaskId("task_3F9A1B2C4D5E6F7A")).toBe(false);
    expect(isValidTaskId("task_3f9a1b2c4d5e6xyz")).toBe(false);
  });
});

describe("MemoryTaskStore", () => {
  let store: MemoryTaskStore;

  afterEach(() => {
    vi.useRealTimers();
    store?.close();
  });

  test("createTask returns a valid task record", async () => {
    store = new MemoryTaskStore();
    const task = await store.createTask(createInput("idem:key"));
    expect(isValidTaskId(task.taskId)).toBe(true);
    expect(task.status).toBe("working");
    expect(task.toolName).toBe("my_tool");
  });

  test("createTask is idempotent for a live idempotencyKey", async () => {
    store = new MemoryTaskStore();
    const first = await store.createTask(createInput("idem:same"));
    const second = await store.createTask(createInput("idem:same"));
    expect(second.taskId).toBe(first.taskId);
    expect(store.size).toBe(1);
  });

  test("getTask returns null and evicts expired records", async () => {
    vi.useFakeTimers();
    store = new MemoryTaskStore();
    const task = await store.createTask(createInput("idem:exp", 1));
    vi.advanceTimersByTime(1500);
    expect(await store.getTask(task.taskId)).toBeNull();
    expect(store.size).toBe(0);
  });

  test("findTaskId reverse-looks up idempotencyKey to task_id", async () => {
    store = new MemoryTaskStore();
    const task = await store.createTask(createInput("idem:rev"));
    expect(await store.findTaskId("idem:rev")).toBe(task.taskId);
    expect(await store.findTaskId("missing")).toBeUndefined();
  });

  test("updateTask stores completion result through the same abstraction", async () => {
    store = new MemoryTaskStore();
    const task = await store.createTask(createInput("idem:done"));
    const result = { content: [{ type: "text", text: "ok" }] };
    const updated = await store.updateTask(task.taskId, { status: "completed", result });
    expect(updated?.status).toBe("completed");
    expect(updated?.result).toEqual(result);
    expect((await store.getTask(task.taskId))?.result).toEqual(result);
  });

  test("cancelTask marks the task cancelled without changing ownership fields", async () => {
    store = new MemoryTaskStore();
    const task = await store.createTask(createInput("idem:cancel"));
    const cancelled = await store.cancelTask(task.taskId, "user requested");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelReason).toBe("user requested");
    expect(cancelled?.tenantId).toBe(task.tenantId);
    expect(cancelled?.owner).toBe(task.owner);
  });

  test("consumeTaskInput requires input_required state and matching nonce", async () => {
    store = new MemoryTaskStore();
    const task = await store.createTask(createInput("idem:input"));

    const early = await store.consumeTaskInput(task.taskId, {
      inputRequestId: "input_early",
      inputResponses: { default: { confirmed: false } },
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe("not_input_required");

    const inputRequired = await store.updateTask(task.taskId, {
      status: "input_required",
      inputRequests: {
        default: {
          method: "elicitation/create",
          inputRequestId: "input_nonce_1",
          params: { message: "Need confirmation", inputRequestId: "input_nonce_1" },
        },
      },
    });
    expect(inputRequired?.status).toBe("input_required");
    expect(inputRequired?.inputRequests?.default.params.message).toBe("Need confirmation");

    const stale = await store.consumeTaskInput(task.taskId, {
      inputRequestId: "input_stale",
      inputResponses: { default: { confirmed: false } },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("stale_input_request");

    const resumed = await store.consumeTaskInput(task.taskId, {
      inputRequestId: "input_nonce_1",
      inputResponses: { default: { confirmed: true } },
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.record.status).toBe("working");
      expect(resumed.record.lastClientInput?.inputRequestId).toBe("input_nonce_1");
      expect(resumed.record.lastClientInput?.inputResponses.default).toEqual({ confirmed: true });
    }

    const duplicate = await store.consumeTaskInput(task.taskId, {
      inputRequestId: "input_nonce_1",
      inputResponses: { default: { confirmed: "overwritten" } },
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.reason).toBe("not_input_required");
  });

  test("delete helpers remove both forward and reverse indexes", async () => {
    store = new MemoryTaskStore();
    const a = await store.createTask(createInput("idem:del-a"));
    await store.deleteTask(a.taskId);
    expect(await store.getTask(a.taskId)).toBeNull();
    expect(await store.findTaskId("idem:del-a")).toBeUndefined();

    const b = await store.createTask(createInput("idem:del-b"));
    await store.deleteByIdempotencyKey("idem:del-b");
    expect(await store.getTask(b.taskId)).toBeNull();
    expect(await store.findTaskId("idem:del-b")).toBeUndefined();
  });
});

describe("RedisTaskStore", () => {
  test("createTask is idempotent via Redis reverse index", async () => {
    const redis = new FakeRedis();
    const store = new RedisTaskStore(redis);
    const first = await store.createTask(createInput("idem:redis"));
    const second = await store.createTask(createInput("idem:redis"));
    expect(second.taskId).toBe(first.taskId);
    expect(await store.findTaskId("idem:redis")).toBe(first.taskId);
  });

  test("updateTask and cancelTask persist through Redis", async () => {
    const redis = new FakeRedis();
    const store = new RedisTaskStore(redis);
    const task = await store.createTask(createInput("idem:redis-update"));
    await store.updateTask(task.taskId, { status: "completed", result: { ok: true } });
    expect((await store.getTask(task.taskId))?.status).toBe("completed");
    expect((await store.getTask(task.taskId))?.result).toEqual({ ok: true });

    await store.cancelTask(task.taskId, "operator stop");
    const cancelled = await store.getTask(task.taskId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelReason).toBe("operator stop");
  });


  test("consumeTaskInput is atomic and nonce-bound via Redis", async () => {
    const redis = new FakeRedis();
    const store = new RedisTaskStore(redis);
    const task = await store.createTask(createInput("idem:redis-input"));

    await store.updateTask(task.taskId, {
      status: "input_required",
      inputRequests: {
        default: {
          method: "elicitation/create",
          inputRequestId: "input_redis_nonce",
          params: { message: "Confirm", inputRequestId: "input_redis_nonce" },
        },
      },
      metadata: { requestedBy: "tool" },
    });

    const stale = await store.consumeTaskInput(task.taskId, {
      inputRequestId: "input_wrong_nonce",
      inputResponses: { default: { confirmed: false } },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("stale_input_request");

    const consumed = await store.consumeTaskInput(task.taskId, {
      inputRequestId: "input_redis_nonce",
      inputResponses: { default: { confirmed: true } },
      metadata: { deliveredToLocalWaiter: true },
    });
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(consumed.requestKey).toBe("default");
      expect(consumed.record.status).toBe("working");
      expect(consumed.record.inputRequests).toBeUndefined();
      expect(consumed.record.lastClientInput?.inputRequestId).toBe("input_redis_nonce");
      expect(consumed.record.lastClientInput?.inputResponses.default).toEqual({ confirmed: true });
      expect(consumed.record.metadata).toMatchObject({ requestedBy: "tool", deliveredToLocalWaiter: true });
    }

    const duplicate = await store.consumeTaskInput(task.taskId, {
      inputRequestId: "input_redis_nonce",
      inputResponses: { default: { confirmed: "duplicate" } },
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.reason).toBe("not_input_required");

    const persisted = await store.getTask(task.taskId);
    expect(persisted?.lastClientInput?.inputResponses.default).toEqual({ confirmed: true });
  });
});
