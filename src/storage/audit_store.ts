import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as os from "node:os";
import type { CryptoErasureReceipt } from "./key_registry.js";

export interface IAuditStore {
  persistErasureReceipt(receipt: CryptoErasureReceipt): Promise<void>;
  listErasureReceipts(opaqueSubjectId?: string): Promise<CryptoErasureReceipt[]>;
}

export class NoopAuditStore implements IAuditStore {
  async persistErasureReceipt(_receipt: CryptoErasureReceipt): Promise<void> {}
  async listErasureReceipts(_opaqueSubjectId?: string): Promise<CryptoErasureReceipt[]> {
    return [];
  }
}

/**
 * Appends erasure receipts as JSONL to ~/.karma/audit/{projectId}/erasure-receipts.jsonl.
 * Survives process restarts; the file is append-only and mode 0600.
 */
export class FileAuditStore implements IAuditStore {
  private readonly filePath: string;
  private dirEnsured = false;

  constructor(projectId: string, baseDir?: string) {
    const dir      = baseDir ?? join(os.homedir(), ".karma", "audit", projectId);
    this.filePath  = join(dir, "erasure-receipts.jsonl");
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    this.dirEnsured = true;
  }

  async persistErasureReceipt(receipt: CryptoErasureReceipt): Promise<void> {
    await this.ensureDir();
    await appendFile(this.filePath, JSON.stringify(receipt) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  async listErasureReceipts(opaqueSubjectId?: string): Promise<CryptoErasureReceipt[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const all = content
      .split("\n")
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as CryptoErasureReceipt];
        } catch {
          return [];
        }
      });
    return opaqueSubjectId ? all.filter(r => r.opaqueSubjectId === opaqueSubjectId) : all;
  }
}
