import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BaseState } from "../types/schemas.js";
import type { ToolExecutionContext, ToolResult } from "../mcp/adapter/tool_registry.js";
import { ENV } from "../config/env.js";
import type { IPluginRunner, PluginIsolationLevel } from "./plugin_runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_STOP_GRACE_MS = 500;
const require = createRequire(import.meta.url);

export interface ExternalPluginToolMetadata {
  name: string;
  description: string;
  allowedPhases: string[];
  capabilities?: string[];
  annotations: Record<string, unknown>;
  execution: Record<string, unknown>;
  securityPolicy?: Record<string, unknown>;
  requiredScopes?: string[];
  inputJsonSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

interface WorkerRequest {
  action: "describe" | "invoke";
  pluginPath: string;
  toolName?: string;
  args?: unknown;
  state?: unknown;
  context?: {
    taskId?: string;
  };
}

interface WorkerResponse<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
}

export function workerPath(): string {
  // In tsx/dev this file lives in src/core; after tsc it lives in dist/core.
  const candidate = path.resolve(__dirname, "plugin_worker.js");
  if (__filename.endsWith(".ts")) return path.resolve(__dirname, "plugin_worker.ts");
  return candidate;
}

export function nodePermissionModeSupport(nodeVersion = process.versions.node): "stable" | "experimental" | "unsupported" {
  const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);

  if (major > 22 || (major === 22 && minor >= 13)) return "stable";
  if (major === 20 || major === 21 || major === 22) return "experimental";
  return "unsupported";
}

function pluginDirectory(pluginPath: string): string {
  return path.dirname(pluginPath.startsWith("file:") ? fileURLToPath(pluginPath) : pluginPath);
}

export function execArgvForWorker(pluginPath?: string): string[] {
  const argv = [`--max-old-space-size=${ENV.MCP_EXTERNAL_PLUGIN_MAX_OLD_SPACE_MB}`];
  const currentWorkerPath = workerPath();

  if (ENV.MCP_EXTERNAL_PLUGIN_NODE_PERMISSION) {
    const support = nodePermissionModeSupport();
    if (support === "unsupported") {
      throw new Error("MCP_EXTERNAL_PLUGIN_NODE_PERMISSION is enabled, but current Node version does not support required permission flags.");
    }
    if (currentWorkerPath.endsWith(".ts")) {
      throw new Error("MCP_EXTERNAL_PLUGIN_NODE_PERMISSION is enabled, but tsx/dev TypeScript plugin workers are not supported. Build the project and run the compiled JavaScript worker.");
    }

    argv.push(
      "--permission",
      `--allow-fs-read=${__dirname}`,
      "--no-addons",
    );
    if (pluginPath) argv.push(`--allow-fs-read=${pluginDirectory(pluginPath)}`);
  }

  if (currentWorkerPath.endsWith(".ts")) argv.push("--import", require.resolve("tsx"));
  return argv;
}

export function workerEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV || "production",
    SUPER_MCP_PLUGIN_WORKER: "1",
    MCP_EXTERNAL_PLUGIN_NETWORK_POLICY: ENV.MCP_EXTERNAL_PLUGIN_NETWORK_POLICY,
    MCP_EXTERNAL_PLUGIN_FS_POLICY: ENV.MCP_EXTERNAL_PLUGIN_FS_POLICY,
    MCP_EXTERNAL_PLUGIN_TIMEOUT_MS: String(ENV.MCP_EXTERNAL_PLUGIN_TIMEOUT_MS),
    ESBUILD_WORKER_THREADS: "0",
    TSX_DISABLE_CACHE: "1",
  };
}

function appendCappedStderr(current: string, chunk: unknown, truncated: boolean): { stderr: string; truncated: boolean } {
  const maxBytes = ENV.MCP_EXTERNAL_PLUGIN_MAX_STDERR_BYTES;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const currentBytes = Buffer.byteLength(current, "utf8");
  const remaining = Math.max(0, maxBytes - currentBytes);

  if (remaining <= 0) {
    if (truncated) return { stderr: current, truncated };
    return { stderr: `${current}\n[stderr truncated after ${maxBytes} bytes]`, truncated: true };
  }

  if (buffer.byteLength <= remaining) {
    return { stderr: current + buffer.toString("utf8"), truncated };
  }

  const sliced = buffer.subarray(0, remaining).toString("utf8");
  return {
    stderr: `${current}${sliced}\n[stderr truncated after ${maxBytes} bytes]`,
    truncated: true,
  };
}

function makeAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("[SUPER-MCP] External plugin worker aborted");
  error.name = "AbortError";
  return error;
}

type ChildShutdownTimers = {
  termTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
};

function clearChildShutdownTimers(timers: ChildShutdownTimers): void {
  if (timers.termTimer) clearTimeout(timers.termTimer);
  if (timers.killTimer) clearTimeout(timers.killTimer);
  timers.termTimer = undefined;
  timers.killTimer = undefined;
}

function requestChildStop(child: ChildProcess, timers: ChildShutdownTimers): void {
  try {
    if (child.connected) child.disconnect();
  } catch {
    // ignore disconnect races
  }

  if (child.exitCode !== null || child.signalCode !== null) return;

  child.once("exit", () => clearChildShutdownTimers(timers));

  const sendTerm = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore kill races
    }
  };

  sendTerm();

  timers.killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore kill races
      }
    }
  }, WORKER_STOP_GRACE_MS);
  timers.killTimer.unref?.();
}

function callWorker<T>(request: WorkerRequest, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = fork(workerPath(), [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        execArgv: execArgvForWorker(request.pluginPath),
        env: workerEnv(),
        cwd: pluginDirectory(request.pluginPath),
        serialization: "json",
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
      return;
    }

    let stderr = "";
    let stderrTruncated = false;
    let settled = false;
    const childShutdownTimers: ChildShutdownTimers = {};

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr?.off("data", onStderr);
    };

    const settleOnce = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const stopAndReject = (error: Error): void => {
      requestChildStop(child, childShutdownTimers);
      settleOnce(() => reject(error));
    };

    const timer = setTimeout(() => {
      stopAndReject(new Error(`[SUPER-MCP] External plugin worker timed out after ${ENV.MCP_EXTERNAL_PLUGIN_TIMEOUT_MS}ms`));
    }, ENV.MCP_EXTERNAL_PLUGIN_TIMEOUT_MS);
    timer.unref?.();

    const onAbort = (): void => {
      stopAndReject(makeAbortError(signal));
    };

    const onStderr = (chunk: unknown): void => {
      const next = appendCappedStderr(stderr, chunk, stderrTruncated);
      stderr = next.stderr;
      stderrTruncated = next.truncated;
    };

    const onMessage = (response: WorkerResponse<T>): void => {
      if (response.ok) {
        requestChildStop(child, childShutdownTimers);
        settleOnce(() => resolve(response.value as T));
      } else {
        stopAndReject(new Error(response.error || stderr || "[SUPER-MCP] External plugin worker failed"));
      }
    };

    const onError = (error: Error): void => {
      stopAndReject(error);
    };

    const onExit = (code: number | null, childSignal: NodeJS.Signals | null): void => {
      if (settled) return;
      if (code === 0) {
        clearChildShutdownTimers(childShutdownTimers);
        settleOnce(() => reject(new Error("[SUPER-MCP] External plugin worker exited before sending a response")));
        return;
      }
      const reason = code === null ? `signal ${childSignal}` : `code ${code}`;
      clearChildShutdownTimers(childShutdownTimers);
      settleOnce(() => reject(new Error(`[SUPER-MCP] External plugin worker exited with ${reason}: ${stderr}`)));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", onStderr);
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);

    if (signal?.aborted) {
      onAbort();
      return;
    }

    child.send(request, error => {
      if (error) stopAndReject(error);
    });
  });
}

export async function describeExternalPlugin(pluginPath: string): Promise<ExternalPluginToolMetadata[]> {
  return callWorker<ExternalPluginToolMetadata[]>({
    action: "describe",
    pluginPath: pathToFileURL(pluginPath).href,
  });
}

export async function invokeExternalPlugin<T = Record<string, unknown>>(
  pluginPath: string,
  toolName: string,
  args: unknown,
  state: BaseState<T>,
  signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<{ result: ToolResult; state: BaseState<T> }> {
  return callWorker<{ result: ToolResult; state: BaseState<T> }>({
    action: "invoke",
    pluginPath: pathToFileURL(pluginPath).href,
    toolName,
    args,
    state,
    context: {
      taskId: context?.taskId,
    },
  }, signal);
}

export class ChildProcessPluginRunner implements IPluginRunner {
  readonly isolationLevel: PluginIsolationLevel = ENV.MCP_EXTERNAL_PLUGIN_NODE_PERMISSION
    ? "node-permission-best-effort"
    : "process-best-effort";

  async describe(pluginPath: string): Promise<ExternalPluginToolMetadata[]> {
    return describeExternalPlugin(pluginPath);
  }

  async invoke<T>(
    pluginPath: string,
    toolName: string,
    args: unknown,
    state: BaseState<T>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<{ result: ToolResult; state: BaseState<T> }> {
    return invokeExternalPlugin(pluginPath, toolName, args, state, signal, context);
  }
}
