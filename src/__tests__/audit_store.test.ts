import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import { FileAuditStore, NoopAuditStore } from "../storage/audit_store.js";
import type { CryptoErasureReceipt } from "../storage/key_registry.js";

function makeReceipt(opaqueSubjectId: string, reason = "test"): CryptoErasureReceipt {
  return {
    keyId: `tk_${opaqueSubjectId}:v1`,
    scope: "tenant",
    opaqueSubjectId,
    disabledAt: new Date().toISOString(),
    scheduledDeletionAt: new Date(Date.now() + 86_400_000).toISOString(),
    reason,
    actor: "test-suite",
  };
}

describe("FileAuditStore", () => {
  let tmpDir: string;
  let store: FileAuditStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(os.tmpdir(), "karma-audit-test-"));
    store  = new FileAuditStore("test-project", tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists a receipt to disk and reads it back", async () => {
    const receipt = makeReceipt("abc123", "gdpr-erasure");
    await store.persistErasureReceipt(receipt);

    const all = await store.listErasureReceipts();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ opaqueSubjectId: "abc123", reason: "gdpr-erasure" });
  });

  it("appends multiple receipts and returns all of them", async () => {
    await store.persistErasureReceipt(makeReceipt("tenant-a"));
    await store.persistErasureReceipt(makeReceipt("tenant-b"));
    await store.persistErasureReceipt(makeReceipt("tenant-a", "second-erasure"));

    const all = await store.listErasureReceipts();
    expect(all).toHaveLength(3);
  });

  it("filters by opaqueSubjectId", async () => {
    await store.persistErasureReceipt(makeReceipt("tenant-a"));
    await store.persistErasureReceipt(makeReceipt("tenant-b"));

    const forA = await store.listErasureReceipts("tenant-a");
    expect(forA).toHaveLength(1);
    expect(forA[0].opaqueSubjectId).toBe("tenant-a");
  });

  it("returns [] when the audit file does not exist yet", async () => {
    const all = await store.listErasureReceipts();
    expect(all).toEqual([]);
  });

  it("creates the audit directory on first write", async () => {
    const deepDir = join(tmpDir, "deep", "nested");
    const s       = new FileAuditStore("proj", deepDir);
    await s.persistErasureReceipt(makeReceipt("x"));
    const all = await s.listErasureReceipts();
    expect(all).toHaveLength(1);
  });

  it("survives a malformed line in the JSONL file", async () => {
    const { appendFile } = await import("node:fs/promises");
    const filePath = join(tmpDir, "erasure-receipts.jsonl");
    await appendFile(filePath, "not-valid-json\n");
    await store.persistErasureReceipt(makeReceipt("valid"));
    const all = await store.listErasureReceipts();
    // The bad line is skipped; only the valid one is returned
    expect(all).toHaveLength(1);
  });
});

describe("NoopAuditStore", () => {
  it("persistErasureReceipt is a no-op", async () => {
    const store = new NoopAuditStore();
    await expect(store.persistErasureReceipt(makeReceipt("x"))).resolves.toBeUndefined();
  });

  it("listErasureReceipts returns empty array", async () => {
    const store = new NoopAuditStore();
    expect(await store.listErasureReceipts()).toEqual([]);
    expect(await store.listErasureReceipts("x")).toEqual([]);
  });
});
