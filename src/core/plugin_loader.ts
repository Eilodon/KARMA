import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV } from "../config/env.js";
import { z } from "zod/v4";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { ChildProcessPluginRunner } from "./plugin_external_runner.js";
import type { IPluginRunner } from "./plugin_runner.js";
import { markTrustedRuntime } from "./runtime_identity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAFE_BASENAME = /^[a-zA-Z0-9_.-]+\.tool\.(js|ts)$/;
let loadedPluginManifestHash: string | null = null;

function parseList(raw: string): string[] {
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

// karma.tool is a FIRST-PARTY plugin that must run in-process (trusted built-in), not the
// external child-process runner: it relies on module singletons (keystoreManager, skillIndex)
// and reads PHAROS_*/KEYSTORE_* from process.env, neither of which survive the external worker
// (per-call fork + workerEnv() env allowlist). See docs/superpowers/specs/karma-app-layer.md D-1.
export function isTrustedBuiltInPlugin(fileName: string): boolean {
  return fileName === "system.tool.ts" || fileName === "system.tool.js"
      || fileName === "karma.tool.ts" || fileName === "karma.tool.js";
}


function parseHashAllowlist(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of parseList(raw)) {
    const [file, hash] = entry.split(":");
    if (file && hash) map.set(file, hash.toLowerCase());
  }
  return map;
}

function blockedBySafeMode(tool: ToolDefinition<any>): boolean {
  if (!ENV.MCP_SAFE_MODE) return false;
  const blocked = new Set(["fs.write", "network", "secrets.write", "process.spawn", "destructive"]);
  return (tool.capabilities || []).some(capability => blocked.has(capability));
}

function pluginsDir(): string {
  return path.resolve(__dirname, "..", "plugins");
}

async function discoverCandidatePluginFiles(): Promise<string[]> {
  const dir = pluginsDir();
  const allowlist = new Set(parseList(ENV.MCP_PLUGIN_ALLOWLIST));
  try {
    await fs.access(dir);
  } catch {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(file => file.isFile())
    .map(file => file.name)
    .filter(fileName => SAFE_BASENAME.test(fileName))
    .filter(fileName => ENV.MCP_PLUGIN_AUTO_DISCOVERY || allowlist.has(fileName))
    .sort();
}

async function computePluginManifestHash(fileNames: string[]): Promise<string> {
  const dir = pluginsDir();
  const hash = createHash("sha256");
  for (const fileName of fileNames) {
    const fullPath = path.resolve(dir, fileName);
    if (!fullPath.startsWith(`${dir}${path.sep}`)) continue;
    const fileHash = createHash("sha256").update(await fs.readFile(fullPath)).digest("hex");
    hash.update(`${fileName}:${fileHash}\n`);
  }
  return hash.digest("hex");
}

export function getLoadedPluginManifestHash(): string | null {
  return loadedPluginManifestHash;
}

export async function assertPluginManifestStable(): Promise<void> {
  if (!ENV.MCP_PLUGIN_PIN_MANIFEST || !loadedPluginManifestHash) return;
  const current = await computePluginManifestHash(await discoverCandidatePluginFiles());
  if (current !== loadedPluginManifestHash) {
    throw new Error("[KARMA] Plugin manifest changed after startup. Restart deliberately to accept plugin changes.");
  }
}

export interface PluginLoaderOptions {
  pluginRunner?: IPluginRunner;
}

export class PluginLoader {
  static async loadAll<T = Record<string, unknown>>(options: PluginLoaderOptions = {}): Promise<ToolDefinition<T>[]> {
    // This loader only ever runs in the trusted parent — the external worker loads plugins
    // through plugin_worker.loadTools(), never here. Marking the runtime trusted is what makes
    // the karma.tool canary (assertInProcess) fail-closed against unknown/future runners (D-1).
    markTrustedRuntime();
    const pluginDir = pluginsDir();
    const runner = options.pluginRunner ?? new ChildProcessPluginRunner();
    const allowlist = new Set(parseList(ENV.MCP_PLUGIN_ALLOWLIST));
    const hashAllowlist = parseHashAllowlist(ENV.MCP_PLUGIN_SHA256_ALLOWLIST);

    try {
      await fs.access(pluginDir);
    } catch {
      await fs.mkdir(pluginDir, { recursive: true, mode: 0o700 });
      loadedPluginManifestHash = await computePluginManifestHash([]);
      return [];
    }

    const tools: ToolDefinition<T>[] = [];
    const files = await fs.readdir(pluginDir, { withFileTypes: true });

    for (const file of files) {
      if (!file.isFile()) continue;
      if (!SAFE_BASENAME.test(file.name)) continue;
      if (!ENV.MCP_PLUGIN_AUTO_DISCOVERY && !allowlist.has(file.name)) continue;

      const fullPath = path.resolve(pluginDir, file.name);
      if (!fullPath.startsWith(`${pluginDir}${path.sep}`)) {
        console.error(`[KARMA] Plugin path rejected: ${file.name}`);
        continue;
      }

      if (hashAllowlist.size > 0) {
        const expected = hashAllowlist.get(file.name);
        const actual = createHash("sha256").update(await fs.readFile(fullPath)).digest("hex");
        if (!expected || expected !== actual) {
          console.error(`[KARMA] Plugin hash rejected: ${file.name}`);
          continue;
        }
      }

      if (ENV.MCP_PLUGIN_AUTO_DISCOVERY && !allowlist.has(file.name)) {
        console.error(`[KARMA] Unsafe plugin auto-discovery loaded non-allowlisted plugin '${file.name}'.`);
      }

      try {
        const trustedBuiltIn = isTrustedBuiltInPlugin(file.name);
        if (!trustedBuiltIn && ENV.MCP_PLUGIN_ISOLATION_MODE !== "external") {
          console.error(`[KARMA] Non-built-in plugin '${file.name}' rejected: MCP_PLUGIN_ISOLATION_MODE=policy is trusted-only. Use MCP_PLUGIN_ISOLATION_MODE=external for third-party plugins.`);
          continue;
        }

        if (ENV.MCP_PLUGIN_ISOLATION_MODE === "external" && !trustedBuiltIn) {
          // MISS-3/D-5.2 fix: warn when OS sandboxing or hash pinning is absent.
          if (!ENV.MCP_EXTERNAL_PLUGIN_NODE_PERMISSION) {
            console.error(`[KARMA] WARNING: External plugin '${file.name}' loaded without Node.js permission model (MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=false). Enable --experimental-permission for OS-level sandboxing.`);
          }
          if (hashAllowlist.size === 0) {
            console.error(`[KARMA] WARNING: External plugin '${file.name}' loaded without MCP_PLUGIN_SHA256_ALLOWLIST. Pin expected hashes to prevent supply-chain tampering.`);
          }
          const metadata = await runner.describe(fullPath);
          const accepted = metadata
            .filter(tool => {
              if (!tool?.name || !tool?.description || !tool?.allowedPhases || !tool.annotations || !tool.execution) {
                console.error(`[KARMA] Invalid external tool metadata rejected from plugin '${file.name}'.`);
                return false;
              }
              return true;
            })
            .map((tool): ToolDefinition<T> => ({
              name: tool.name,
              description: tool.description,
              inputSchema: {
                payload: z.unknown().optional(),
                _meta: z.unknown().optional(),
              },
              inputJsonSchema: tool.inputJsonSchema,
              outputSchema: tool.outputSchema,
              allowedPhases: tool.allowedPhases as ToolDefinition<T>["allowedPhases"],
              capabilities: tool.capabilities as ToolDefinition<T>["capabilities"],
              annotations: tool.annotations,
              execution: tool.execution,
              securityPolicy: tool.securityPolicy,
              requiredScopes: tool.requiredScopes,
              handler: async (args, state, signal, context) => {
                const response = await runner.invoke(fullPath, tool.name, args, state, signal, context);
                Object.assign(state as any, response.state);
                return response.result;
              },
            }))
            .filter(tool => {
              if (blockedBySafeMode(tool)) {
                console.error(`[KARMA] Safe mode blocked external tool '${tool.name}' from plugin '${file.name}' due to capabilities: ${(tool.capabilities || []).join(",")}`);
                return false;
              }
              return true;
            });

          tools.push(...accepted);
          console.error(`[KARMA] External plugin loaded '${file.name}' through ${runner.isolationLevel} boundary (${accepted.length}/${metadata.length} tools accepted)`);
          continue;
        }

        const module = await import(`file://${fullPath}`);
        const pluginTools = module.default || module.tools;
        if (!Array.isArray(pluginTools)) {
          console.error(`[KARMA] Plugin '${file.name}' does not export ToolDefinition[].`);
          continue;
        }

        const accepted = pluginTools.filter((tool: ToolDefinition<T>) => {
          if (!tool?.name || !tool?.handler || !tool?.inputSchema || !tool?.allowedPhases || !tool.annotations || !tool.execution) {
            console.error(`[KARMA] Invalid tool rejected from plugin '${file.name}'.`);
            return false;
          }
          if (blockedBySafeMode(tool)) {
            console.error(`[KARMA] Safe mode blocked tool '${tool.name}' from plugin '${file.name}' due to capabilities: ${(tool.capabilities || []).join(",")}`);
            return false;
          }
          return true;
        });

        tools.push(...accepted);
        console.error(`[KARMA] Plugin loaded '${file.name}' (${accepted.length}/${pluginTools.length} tools accepted)`);
      } catch (error) {
        console.error(`[KARMA] Plugin load error at '${file.name}':`, error);
      }
    }

    loadedPluginManifestHash = await computePluginManifestHash(await discoverCandidatePluginFiles());
    return tools;
  }
}
