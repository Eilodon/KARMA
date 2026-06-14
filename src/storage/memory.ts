import type { IStateStore } from "./interface.js";
import type { BaseState } from "../types/schemas.js";

export class MemoryStore implements IStateStore {
  private states = new Map<string, BaseState<Record<string, unknown>>>();
  private backups = new Map<string, BaseState<Record<string, unknown>>>();

  async load<T = Record<string, unknown>>(tenantId: string): Promise<Partial<BaseState<T>> | null> {
    const state = this.states.get(tenantId);
    return state ? JSON.parse(JSON.stringify(state)) as Partial<BaseState<T>> : null;
  }

  async save<T = Record<string, unknown>>(state: BaseState<T>): Promise<void> {
    this.states.set(state.tenantId, JSON.parse(JSON.stringify(state)) as BaseState<Record<string, unknown>>);
  }

  async saveBackup<T = Record<string, unknown>>(state: BaseState<T>): Promise<void> {
    this.backups.set(state.tenantId, JSON.parse(JSON.stringify(state)) as BaseState<Record<string, unknown>>);
  }

  async restoreLatestBackup<T = Record<string, unknown>>(tenantId: string): Promise<{ label: string; state: BaseState<T> } | null> {
    const state = this.backups.get(tenantId);
    return state ? { label: "memory_backup", state: JSON.parse(JSON.stringify(state)) as BaseState<T> } : null;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
