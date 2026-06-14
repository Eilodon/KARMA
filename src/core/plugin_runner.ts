import type { BaseState } from "../types/schemas.js";
import type { ToolExecutionContext, ToolResult } from "../mcp/adapter/tool_registry.js";
import type { ExternalPluginToolMetadata } from "./plugin_external_runner.js";

export type PluginIsolationLevel =
  | "process-best-effort"
  | "node-permission-best-effort"
  | "container"
  | "wasm-worker"
  | "microvm";

export interface IPluginRunner {
  readonly isolationLevel: PluginIsolationLevel;

  describe(pluginPath: string): Promise<ExternalPluginToolMetadata[]>;

  invoke<T>(
    pluginPath: string,
    toolName: string,
    args: unknown,
    state: BaseState<T>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<{ result: ToolResult; state: BaseState<T> }>;
}
