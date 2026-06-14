import type { ZodType } from "zod/v4";
import type { Phase, BaseState } from "../../types/schemas.js";

type ZodTypeAny = ZodType;

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
};
export type ToolCapability = "fs.read" | "fs.write" | "network" | "secrets.read" | "secrets.write" | "process.spawn" | "destructive";
export interface ToolExecutionContext {
  taskId?: string;
  requestInput?: (message?: string) => Promise<unknown>;
}

export type ToolHandler<T = Record<string, unknown>> = (
  args: unknown,
  state: BaseState<T>,
  signal?: AbortSignal,
  context?: ToolExecutionContext,
) => Promise<ToolResult>;
export type ToolTaskSupport = "forbidden" | "optional" | "required";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolExecution {
  taskSupport?: ToolTaskSupport;
}

export interface ToolSecurityPolicy {
  accessesPrivateData?: boolean;
  exposesUntrustedContent?: boolean;
  externalCommunication?: boolean;
  destructiveEffects?: boolean;
  allowLethalTrifecta?: boolean;
  waiverReason?: string;
}

export interface ToolDefinition<T = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, ZodTypeAny>;
  inputJsonSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  allowedPhases: Phase[];
  capabilities?: ToolCapability[];
  requireConfidence?: boolean;
  minConfidence?: number;
  payloadSchema?: ZodType<T>;
  annotations: ToolAnnotations;
  execution: ToolExecution;
  securityPolicy?: ToolSecurityPolicy;
  requiredScopes?: string[];
  handler: ToolHandler<T>;
}
