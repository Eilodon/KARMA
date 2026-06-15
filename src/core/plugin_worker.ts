import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

const require = createRequire(import.meta.url);
let activePluginPathForGuard: string | undefined;

function prewarmDevTranspiler(): void {
  // In tsx/dev mode, esbuild may lazily start its transform service after this
  // module has installed plugin guards. Prewarm it before child_process and
  // worker_threads are patched so the guard applies to plugin code without
  // breaking the TypeScript development loader. Built JavaScript runtimes do
  // not need this path.
  if (!import.meta.url.endsWith(".ts")) return;
  try {
    require("esbuild").transformSync("export {};", { loader: "ts" });
  } catch {
    // If prewarm fails, the normal worker error path will report the loader issue.
  }
}

prewarmDevTranspiler();

function initializeWorkerRuntimeBeforeGuards(): void {
  // Node creates process.stderr/stdout lazily with net.Socket under the hood.
  // If the external plugin guard replaces net.Socket before stdio is touched,
  // normal worker error/reporting paths in the compiled dist runtime can fail
  // before a valid plugin has a chance to run. Create the stdio streams before
  // patching net.Socket so the guard applies to plugin-created sockets without
  // breaking Node's own worker plumbing.
  try {
    void process.stderr;
    void process.stdout;
  } catch {
    // If stdio is unavailable, the parent still receives worker exit/stderr state.
  }
}

initializeWorkerRuntimeBeforeGuards();

type WorkerRequest = {
  action: "describe" | "invoke";
  pluginPath: string;
  toolName?: string;
  args?: unknown;
  state?: unknown;
  context?: {
    taskId?: string;
  };
};

type WorkerResponse = {
  ok: boolean;
  value?: unknown;
  error?: string;
};

function blockedApi(name: string): never {
  throw new Error(`[KARMA] External plugin guard blocked ${name}. Configure an external container/microVM runner if the plugin needs this capability.`);
}

function patchExport(target: unknown, key: string, replacement: unknown): void {
  if (!target || typeof target !== "object") return;
  try {
    Object.defineProperty(target, key, {
      value: replacement,
      configurable: true,
      writable: true,
    });
  } catch {
    try {
      (target as Record<string, unknown>)[key] = replacement;
    } catch {
      // Some Node module namespace bindings are immutable. The process boundary,
      // timeout and memory cap still apply; immutable bindings are documented in ADR.
    }
  }
}

function isAllowedDevLoaderStack(): boolean {
  // In vitest/tsx development mode the already-trusted TypeScript loader may
  // synchronously call esbuild via child_process while transforming modules.
  // Keep that loader path alive, but install the guard before importing plugin
  // code so top-level plugin attempts still fail closed.
  if (!import.meta.url.endsWith(".ts")) return false;
  const stack = new Error().stack || "";
  if (activePluginPathForGuard) {
    const pluginBasename = path.basename(activePluginPathForGuard);
    if (stack.includes(activePluginPathForGuard) || stack.includes(pluginBasename)) return false;
  }
  return stack.includes("node_modules/esbuild/") || stack.includes("node_modules/tsx/");
}

function isWriteFlag(flags: unknown): boolean {
  if (flags === undefined) return false;
  if (typeof flags === "number") {
    const fs = require("node:fs");
    const constants = fs.constants ?? {};
    return Boolean(
      (constants.O_WRONLY && (flags & constants.O_WRONLY)) ||
      (constants.O_RDWR && (flags & constants.O_RDWR)) ||
      (constants.O_CREAT && (flags & constants.O_CREAT)) ||
      (constants.O_TRUNC && (flags & constants.O_TRUNC)) ||
      (constants.O_APPEND && (flags & constants.O_APPEND)),
    );
  }
  if (typeof flags !== "string") return true;
  return !(flags === "r" || flags === "rs");
}

function patchFsOpen(fs: any, fsp: any): void {
  const originalOpen = typeof fs.open === "function" ? fs.open.bind(fs) : undefined;
  const originalOpenSync = typeof fs.openSync === "function" ? fs.openSync.bind(fs) : undefined;
  const originalPromisesOpen = typeof fsp.open === "function" ? fsp.open.bind(fsp) : undefined;

  if (originalOpen) {
    patchExport(fs, "open", (file: unknown, flags: unknown = "r", ...rest: unknown[]) => {
      if (isWriteFlag(flags)) blockedApi("fs.open");
      return originalOpen(file, flags, ...rest);
    });
  }

  if (originalOpenSync) {
    patchExport(fs, "openSync", (file: unknown, flags: unknown = "r", ...rest: unknown[]) => {
      if (isWriteFlag(flags)) blockedApi("fs.openSync");
      return originalOpenSync(file, flags, ...rest);
    });
  }

  if (originalPromisesOpen) {
    patchExport(fsp, "open", (file: unknown, flags: unknown = "r", ...rest: unknown[]) => {
      if (isWriteFlag(flags)) blockedApi("fs.promises.open");
      return originalPromisesOpen(file, flags, ...rest);
    });
  }
}

function blockModuleExports(moduleName: string, keys: readonly string[], label = moduleName): void {
  const mod = require(moduleName);
  for (const key of keys) {
    if (key in mod) {
      const replacement = function blockedExport() {
        blockedApi(`${label}.${key}`);
      };
      patchExport(mod, key, replacement);
    }
  }
}

let loaderSensitiveGuardsInstalled = false;

function installLoaderSensitivePluginGuards(): void {
  if (loaderSensitiveGuardsInstalled) return;
  loaderSensitiveGuardsInstalled = true;

  const childProcess = require("node:child_process");
  for (const key of ["exec", "execFile", "fork", "spawn", "spawnSync", "execFileSync", "execSync"] as const) {
    const original = typeof childProcess[key] === "function" ? childProcess[key].bind(childProcess) : undefined;
    if (original) {
      patchExport(childProcess, key, (...args: unknown[]) => {
        if (isAllowedDevLoaderStack()) return original(...args as never[]);
        return blockedApi(`child_process.${key}`);
      });
    }
  }

  blockModuleExports("node:worker_threads", ["Worker"], "worker_threads");

  try {
    syncBuiltinESMExports();
  } catch {
    // Best-effort guard sync. Immutable ESM bindings are covered by process isolation and timeout.
  }
}

function installExternalPluginGuards(): void {
  if (process.env.MCP_EXTERNAL_PLUGIN_NETWORK_POLICY !== "allow") {
    patchExport(globalThis, "fetch", () => blockedApi("fetch/network"));

    for (const moduleName of ["node:http", "node:https", "node:net", "node:tls"] as const) {
      const mod = require(moduleName);
      for (const key of ["request", "get", "connect", "createConnection"] as const) {
        if (key in mod) {
          const replacement = function blockedExport() {
            blockedApi(`${moduleName}.${key}`);
          };
          patchExport(mod, key, replacement);
        }
      }
    }

    const net = require("node:net");
    patchExport(net, "Socket", class BlockedSocket {
      constructor() {
        blockedApi("net.Socket");
      }
    });

    blockModuleExports("node:dgram", ["createSocket"], "dgram");
    blockModuleExports("node:http2", ["connect", "createServer", "createSecureServer"], "http2");

    const dnsKeys = [
      "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx",
      "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse",
    ] as const;
    blockModuleExports("node:dns", dnsKeys, "dns");
    blockModuleExports("node:dns/promises", dnsKeys, "dns.promises");
  }

  blockModuleExports("node:vm", [
    "runInNewContext", "runInThisContext", "runInContext", "compileFunction", "Script", "Module", "SourceTextModule", "SyntheticModule",
  ], "vm");
  blockModuleExports("node:inspector", ["open", "connect", "Session"], "inspector");
  blockModuleExports("node:cluster", ["fork", "setupMaster", "setupPrimary"], "cluster");

  patchExport(process, "dlopen", () => blockedApi("process.dlopen"));
  patchExport(process, "kill", () => blockedApi("process.kill"));
  if ("_debugProcess" in process) {
    patchExport(process, "_debugProcess", () => blockedApi("process._debugProcess"));
  }

  if (process.env.MCP_EXTERNAL_PLUGIN_FS_POLICY !== "allow") {
    const fs = require("node:fs");
    const fsp = require("node:fs/promises");

    for (const key of [
      "createWriteStream", "WriteStream", "FileWriteStream",
      "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "copyFile", "copyFileSync",
      "cp", "cpSync", "fchmod", "fchmodSync", "fchown", "fchownSync", "ftruncate", "ftruncateSync",
      "futimes", "futimesSync", "link", "linkSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync",
      "mkdtemp", "mkdtempSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "symlink",
      "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "write",
      "writeSync", "writeFile", "writeFileSync", "writev", "writevSync",
    ] as const) {
      if (key in fs) patchExport(fs, key, () => blockedApi(`fs.${key}`));
    }

    for (const key of [
      "appendFile", "chmod", "chown", "copyFile", "cp", "link", "lutimes", "mkdir", "mkdtemp", "rename", "rm",
      "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile",
    ] as const) {
      if (key in fsp) patchExport(fsp, key, () => blockedApi(`fs.promises.${key}`));
    }

    patchFsOpen(fs, fsp);
  }

  try {
    syncBuiltinESMExports();
  } catch {
    // Best-effort guard sync. Immutable ESM bindings are covered by process isolation and timeout.
  }
}

installExternalPluginGuards();
installLoaderSensitivePluginGuards();

function sendAndExit(message: WorkerResponse): void {
  if (process.send) {
    process.send(message, () => process.exit(0));
  } else {
    process.exit(0);
  }
}

function serializableTool(tool: ToolDefinition<any>) {
  return {
    name: tool.name,
    description: tool.description,
    allowedPhases: tool.allowedPhases,
    capabilities: tool.capabilities,
    annotations: tool.annotations,
    execution: tool.execution,
    securityPolicy: tool.securityPolicy,
    requiredScopes: tool.requiredScopes,
    inputJsonSchema: tool.inputJsonSchema,
    outputSchema: tool.outputSchema,
  };
}

async function loadTools(pluginPath: string): Promise<ToolDefinition<any>[]> {
  activePluginPathForGuard = pluginPath.startsWith("file:") ? fileURLToPath(pluginPath) : pluginPath;
  try {
    const module = await import(pluginPath);
    const pluginTools = module.default || module.tools;
    if (!Array.isArray(pluginTools)) {
      throw new Error(`[KARMA] External plugin '${pluginPath}' does not export ToolDefinition[].`);
    }
    return pluginTools;
  } finally {
    activePluginPathForGuard = undefined;
  }
}

process.on("message", async (request: WorkerRequest) => {
  try {
    const tools = await loadTools(request.pluginPath);
    if (request.action === "describe") {
      sendAndExit({ ok: true, value: tools.map(serializableTool) });
      return;
    }

    const tool = tools.find(candidate => candidate.name === request.toolName);
    if (!tool) throw new Error(`[KARMA] External plugin tool not found: ${request.toolName}`);

    const state = request.state as any;
    const result = await tool.handler(request.args, state, undefined, {
      taskId: request.context?.taskId,
      requestInput: undefined,
    });
    sendAndExit({ ok: true, value: { result, state } });
  } catch (error) {
    sendAndExit({ ok: false, error: String(error instanceof Error ? error.stack || error.message : error) });
  }
});
