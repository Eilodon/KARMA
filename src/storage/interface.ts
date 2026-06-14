import type { BaseState, Phase } from "../types/schemas.js";

export interface IStateStore {
  load<T = Record<string, unknown>>(tenantId: string): Promise<Partial<BaseState<T>> | null>;
  save<T = Record<string, unknown>>(state: BaseState<T>): Promise<void>;
  saveBackup?<T = Record<string, unknown>>(state: BaseState<T>, previousPhase: Phase, nextPhase: Phase): Promise<void>;
  restoreLatestBackup?<T = Record<string, unknown>>(tenantId: string): Promise<{ label: string; state: BaseState<T> } | null>;
  healthCheck?(): Promise<boolean>;
  close?(): Promise<void>;
}
