import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as os from "node:os";
import type { IStateStore } from "./interface.js";
import type { BaseState, Phase } from "../types/schemas.js";
import { globalEncryption } from "./encryption.js";

/**
 * Extracted from VECTOR: Secure File System management.
 * Integrates automatic backup rotation, corrupt file detection and
 * Mutex Lock against Race Conditions during parallel requests (Parallel Tool Calls).
 */
export class LocalFSStore implements IStateStore {
  private readonly maxBackups = 25;
  private readonly baseDir: string;
  private locks = new Map<string, Promise<void>>();

  constructor() {
    this.baseDir = join(os.homedir(), ".karma", "data");
  }

  private getTenantDir(tenantId: string): string {
    const readable = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "tenant";
    const digest = createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
    return join(this.baseDir, `${readable}_${digest}`);
  }

  private getStateFile(tenantId: string): string {
    return join(this.getTenantDir(tenantId), "state.json");
  }

  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mutex queue (Lock) to ensure no concurrent file writes
   */
  private async acquireLock<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    const prevLock = this.locks.get(tenantId) || Promise.resolve();
    let releaseLock: () => void;
    const newLock = new Promise<void>(resolve => { releaseLock = resolve; });
    this.locks.set(tenantId, prevLock.then(() => newLock));

    await prevLock;
    try {
      return await operation();
    } finally {
      releaseLock!();
    }
  }

  async load<T = Record<string, unknown>>(tenantId: string): Promise<Partial<BaseState<T>> | null> {
    const file = this.getStateFile(tenantId);
    if (!(await this.pathExists(file))) return null;
    
    const raw = await readFile(file, "utf-8");
    try {
      return (await globalEncryption.decryptState(raw, tenantId));
    } catch (err) {
      const corruptPath = `${file}.corrupt_${Date.now()}`;
      await rename(file, corruptPath).catch(() => {});
      throw new Error(`[KARMA] State file corrupt. This error has been isolated to file ${corruptPath}. Please restore from a backup file (.bkp_).`, { cause: err });
    }
  }

  async save<T = Record<string, unknown>>(state: BaseState<T>): Promise<void> {
    return this.acquireLock(state.tenantId, async () => {
      const dir = this.getTenantDir(state.tenantId);
      const file = this.getStateFile(state.tenantId);
      await this.ensureDir(dir);
      
      const encrypted = await globalEncryption.encryptState(state, state.tenantId);
      const tmp = `${file}.tmp`; // Save to tmp first to prevent data loss on sudden termination
      await writeFile(tmp, encrypted + "\n", { encoding: "utf-8", mode: 0o600 });
      await rename(tmp, file); // Atomic overwrite (atomic rename)
    });
  }

  async saveBackup<T = Record<string, unknown>>(state: BaseState<T>, previousPhase: Phase, nextPhase: Phase): Promise<void> {
    return this.acquireLock(state.tenantId, async () => {
      const dir = this.getTenantDir(state.tenantId);
      const file = this.getStateFile(state.tenantId);
      await this.ensureDir(dir);
      
      const encrypted = await globalEncryption.encryptState(state, state.tenantId);
      const backupPath = `${file}.bkp_${previousPhase}_to_${nextPhase}_${Date.now()}`;
      await writeFile(backupPath, encrypted, { encoding: "utf-8", mode: 0o600 });
      
      // Rotate backup files
      const files = await readdir(dir);
      const backups = files.filter(f => f.startsWith("state.json.bkp_")).sort();
      const toDelete = backups.slice(0, Math.max(0, backups.length - this.maxBackups));
      for (const old of toDelete) {
        await rm(join(dir, old), { force: true });
      }
    });
  }

  async restoreLatestBackup<T = Record<string, unknown>>(tenantId: string): Promise<{ label: string; state: BaseState<T> } | null> {
    const dir = this.getTenantDir(tenantId);
    if (!(await this.pathExists(dir))) return null;
    
    const files = await readdir(dir);
    const backups = files.filter(f => f.startsWith("state.json.bkp_")).sort();
    const latest = backups[backups.length - 1];
    if (!latest) return null;
    
    const raw = await readFile(join(dir, latest), "utf-8");
    try {
      const state = (await globalEncryption.decryptState(raw, tenantId)) as BaseState<T>;
      return { label: latest, state };
    } catch (err) {
      const corruptPath = `${join(dir, latest)}.corrupt_${Date.now()}`;
      await rename(join(dir, latest), corruptPath).catch(() => {});
      throw new Error(`[KARMA] Backup file corrupt. Moved to ${corruptPath}. Try restoring from an older version.`, { cause: err });
    }
  }

  async healthCheck(): Promise<boolean> {
    await this.ensureDir(this.baseDir);
    return true;
  }
}
