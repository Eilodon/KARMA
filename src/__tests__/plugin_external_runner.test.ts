import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

type RunnerModule = typeof import("../core/plugin_external_runner.js");

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(new URL("../..", import.meta.url).pathname);
let distBuilt = false;

async function ensureDistBuild(): Promise<void> {
  if (distBuilt) return;
  await execFileAsync(process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], {
    cwd: projectRoot,
    timeout: 30_000,
  });
  distBuilt = true;
}

async function tempPluginDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "karma-plugin-"));
  tempDirs.push(dir);
  return dir;
}

async function writePlugin(fileName: string, source: string): Promise<string> {
  const dir = await tempPluginDir();
  const file = path.join(dir, fileName);
  await writeFile(file, source, "utf8");
  return file;
}

async function loadRunner(env: Record<string, string | undefined> = {}): Promise<RunnerModule> {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }
  return import("../core/plugin_external_runner.js");
}

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const VALID_PLUGIN = String.raw`
export const tools = [{
  name: "valid",
  description: "Valid plugin",
  inputSchema: {},
  allowedPhases: ["execution"],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execution: { taskSupport: "forbidden" },
  handler: async (args, state) => {
    state.seen = true;
    return { content: [{ type: "text", text: "ok" }], structuredContent: { path: process.env.PATH ?? null } };
  },
}];
`;

const GUARD_PLUGIN = String.raw`
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

async function attempt(mode) {
  switch (mode) {
    case "worker_threads.Worker": {
      const { Worker } = require("node:worker_threads");
      return new Worker("", { eval: true });
    }
    case "dgram.createSocket": return require("node:dgram").createSocket("udp4");
    case "http2.connect": return require("node:http2").connect("https://example.com");
    case "http2.createServer": return require("node:http2").createServer();
    case "net.Socket": {
      const net = require("node:net");
      return new net.Socket();
    }
    case "vm.runInNewContext": return require("node:vm").runInNewContext("1 + 1");
    case "vm.Script": {
      const vm = require("node:vm");
      return new vm.Script("1 + 1");
    }
    case "process.dlopen": return process.dlopen({}, "native.node");
    case "process.kill": return process.kill(process.pid, 0);
    case "dns.resolveTxt": return require("node:dns").resolveTxt("example.com", () => undefined);
    case "dns.promises.resolveTxt": return require("node:dns/promises").resolveTxt("example.com");
    case "inspector.open": return require("node:inspector").open(0);
    case "cluster.fork": return require("node:cluster").fork();
    case "fs.createWriteStream": return require("node:fs").createWriteStream("blocked.txt");
    case "fs.symlink": return require("node:fs").symlink("a", "b", () => undefined);
    case "fs.link": return require("node:fs").link("a", "b", () => undefined);
    case "fs.utimes": return require("node:fs").utimes("a", new Date(), new Date(), () => undefined);
    case "fs.promises.symlink": return require("node:fs/promises").symlink("a", "b");
    case "fs.promises.open.write": return require("node:fs/promises").open("blocked.txt", "w");
    case "fs.readFile": return require("node:fs/promises").readFile(new URL(import.meta.url), "utf8");
    case "env.PATH": return process.env.PATH;
    default: throw new Error("unknown mode " + mode);
  }
}

export const tools = [{
  name: "guard",
  description: "Guard plugin",
  inputSchema: {},
  allowedPhases: ["execution"],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execution: { taskSupport: "forbidden" },
  handler: async (args) => {
    try {
      const value = await attempt(args.mode);
      return { content: [{ type: "text", text: "allowed" }], structuredContent: { allowed: true, value: String(value ?? "") } };
    } catch (error) {
      return { content: [{ type: "text", text: String(error?.message || error) }], structuredContent: { blocked: true, message: String(error?.message || error) } };
    }
  },
}];
`;

describe("external plugin runner lifecycle", () => {
  test("valid plugin still works and worker exits after successful response", async () => {
    const plugin = await writePlugin("valid.tool.js", VALID_PLUGIN);
    const { describeExternalPlugin, invokeExternalPlugin } = await loadRunner();

    const metadata = await describeExternalPlugin(plugin);
    expect(metadata[0].name).toBe("valid");

    const state = { phase: "intake", revision: 1, payload: {} } as any;
    const response = await invokeExternalPlugin(plugin, "valid", {}, state);
    expect(response.result.content[0].text).toBe("ok");
    expect((response.state as any).seen).toBe(true);
  });

  test("runner.describe and runner.invoke delegate to existing external functions", async () => {
    const plugin = await writePlugin("valid.tool.js", VALID_PLUGIN);
    const { ChildProcessPluginRunner } = await loadRunner();
    const runner = new ChildProcessPluginRunner();

    await expect(runner.describe(plugin)).resolves.toHaveLength(1);
    await expect(runner.invoke(plugin, "valid", {}, { phase: "intake", revision: 1, payload: {} } as any)).resolves.toMatchObject({
      result: { content: [{ type: "text", text: "ok" }] },
    });
    expect(runner.isolationLevel).toBe("process-best-effort");
  });

  test("plugin error still propagates", async () => {
    const plugin = await writePlugin("error.tool.js", String.raw`
export const tools = [{
  name: "boom", description: "boom", inputSchema: {}, allowedPhases: ["execution"],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execution: { taskSupport: "forbidden" },
  handler: async () => { throw new Error("plugin failed deliberately"); },
}];
`);
    const { invokeExternalPlugin } = await loadRunner();
    await expect(invokeExternalPlugin(plugin, "boom", {}, { phase: "intake", revision: 1, payload: {} } as any)).rejects.toThrow("plugin failed deliberately");
  });

  test("stderr buffer is capped and truncation marker appears", async () => {
    const plugin = await writePlugin("stderr.tool.js", 'process.stderr.write("x".repeat(4096)); process.exit(2); export const tools = [];\n');
    const { describeExternalPlugin } = await loadRunner({ MCP_EXTERNAL_PLUGIN_MAX_STDERR_BYTES: "1024" });

    await expect(describeExternalPlugin(plugin)).rejects.toThrow("[stderr truncated after 1024 bytes]");
  });

  test("abort hard-stops child process and settles once", async () => {
    const plugin = await writePlugin("hang.tool.js", String.raw`
export const tools = [{
  name: "hang", description: "hang", inputSchema: {}, allowedPhases: ["execution"],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execution: { taskSupport: "forbidden" },
  handler: async () => new Promise(() => undefined),
}];
`);
    const { invokeExternalPlugin } = await loadRunner();
    const ac = new AbortController();
    const promise = invokeExternalPlugin(plugin, "hang", {}, { phase: "intake", revision: 1, payload: {} } as any, ac.signal);
    ac.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
  });

  test("timeout hard-stops child process", async () => {
    const plugin = await writePlugin("timeout.tool.js", String.raw`
export const tools = [{
  name: "timeout", description: "timeout", inputSchema: {}, allowedPhases: ["execution"],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execution: { taskSupport: "forbidden" },
  handler: async () => new Promise(() => undefined),
}];
`);
    const { invokeExternalPlugin } = await loadRunner({ MCP_EXTERNAL_PLUGIN_TIMEOUT_MS: "1000" });
    await expect(invokeExternalPlugin(plugin, "timeout", {}, { phase: "intake", revision: 1, payload: {} } as any)).rejects.toThrow(/timed out after 1000ms/);
  }, 5000);

  test("parent kills a child that ignores normal exit after sending a response", async () => {
    const dir = await tempPluginDir();
    const pidFile = path.join(dir, "child.pid");
    const plugin = path.join(dir, "linger.tool.js");
    await writeFile(plugin, String.raw`
import { writeFileSync } from "node:fs";
process.exit = () => undefined;
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1000);
export const tools = [{
  name: "linger", description: "linger", inputSchema: {}, allowedPhases: ["execution"],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execution: { taskSupport: "forbidden" },
  handler: async () => {
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    return { content: [{ type: "text", text: "ok" }] };
  },
}];
`, "utf8");

    const { invokeExternalPlugin } = await loadRunner({ MCP_EXTERNAL_PLUGIN_FS_POLICY: "allow" });
    await expect(invokeExternalPlugin(plugin, "linger", {}, { phase: "intake", revision: 1, payload: {} } as any)).resolves.toMatchObject({
      result: { content: [{ type: "text", text: "ok" }] },
    });

    const pid = Number(await readFile(pidFile, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 5000);

  test("source contains single-settle and listener cleanup guards", async () => {
    const source = await readFile(new URL("../core/plugin_external_runner.ts", import.meta.url), "utf8");
    expect(source).toContain("let settled = false");
    expect(source).toContain("settleOnce");
    expect(source).toContain("clearChildShutdownTimers");
    expect(source).toContain("child.off(\"message\", onMessage)");
    expect(source).toContain("child.stderr?.off(\"data\", onStderr)");
    expect(source).toContain("SIGTERM");
    expect(source).toContain("SIGKILL");
  });
});

describe("external plugin worker JS-level hardening", () => {
  test.each([
    "worker_threads.Worker",
    "dgram.createSocket",
    "http2.connect",
    "http2.createServer",
    "net.Socket",
    "vm.runInNewContext",
    "vm.Script",
    "process.dlopen",
    "process.kill",
    "dns.resolveTxt",
    "dns.promises.resolveTxt",
    "inspector.open",
    "cluster.fork",
    "fs.createWriteStream",
    "fs.symlink",
    "fs.link",
    "fs.utimes",
    "fs.promises.symlink",
    "fs.promises.open.write",
  ])("blocks %s", async mode => {
    const plugin = await writePlugin("guard.tool.js", GUARD_PLUGIN);
    const { invokeExternalPlugin } = await loadRunner();

    const response = await invokeExternalPlugin(plugin, "guard", { mode }, { phase: "intake", revision: 1, payload: {} } as any);
    expect((response.result as any).structuredContent.blocked).toBe(true);
    expect((response.result as any).structuredContent.message).toContain("External plugin guard blocked");
  });

  test("does not expose PATH by default", async () => {
    const plugin = await writePlugin("guard.tool.js", GUARD_PLUGIN);
    const { invokeExternalPlugin } = await loadRunner();

    const response = await invokeExternalPlugin(plugin, "guard", { mode: "env.PATH" }, { phase: "intake", revision: 1, payload: {} } as any);
    expect((response.result as any).structuredContent.value).toBe("");
  });

  test("allows fs.readFile under read-only policy", async () => {
    const plugin = await writePlugin("guard.tool.js", GUARD_PLUGIN);
    const { invokeExternalPlugin } = await loadRunner();

    const response = await invokeExternalPlugin(plugin, "guard", { mode: "fs.readFile" }, { phase: "intake", revision: 1, payload: {} } as any);
    expect((response.result as any).structuredContent.allowed).toBe(true);
    expect((response.result as any).structuredContent.value).toContain("export const tools");
  });

  test("blocks loader-sensitive APIs at plugin top level in tsx/dev mode", async () => {
    const plugin = await writePlugin("top-level-worker.tool.js", String.raw`
import { Worker } from "node:worker_threads";
new Worker("setInterval(() => undefined, 1000)", { eval: true });
export const tools = [{
  name: "top", description: "top", inputSchema: {}, allowedPhases: ["execution"],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execution: { taskSupport: "forbidden" },
  handler: async () => ({ content: [{ type: "text", text: "should not run" }] }),
}];
`);
    const { describeExternalPlugin } = await loadRunner();

    await expect(describeExternalPlugin(plugin)).rejects.toThrow("External plugin guard blocked worker_threads.Worker");
  });

  test("blocks top-level child_process calls while still allowing the tsx loader", async () => {
    const plugin = await writePlugin("top-level-child-process.tool.js", String.raw`
import { execFileSync } from "node:child_process";
execFileSync(process.execPath, ["-e", "console.log('bypass')"]);
export const tools = [{
  name: "top_child", description: "top child", inputSchema: {}, allowedPhases: ["execution"],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execution: { taskSupport: "forbidden" },
  handler: async () => ({ content: [{ type: "text", text: "should not run" }] }),
}];
`);
    const { describeExternalPlugin } = await loadRunner();

    await expect(describeExternalPlugin(plugin)).rejects.toThrow("External plugin guard blocked child_process.execFileSync");
  });
});

describe("optional Node permission hardening", () => {
  test("permission mode disabled by default", async () => {
    const { execArgvForWorker, ChildProcessPluginRunner } = await loadRunner();
    expect(execArgvForWorker()).not.toContain("--permission");
    expect(new ChildProcessPluginRunner().isolationLevel).toBe("process-best-effort");
  });

  test("permission mode adds permission flags on supported Node or fails clearly in tsx dev mode", async () => {
    const { execArgvForWorker, nodePermissionModeSupport, workerPath } = await loadRunner({ MCP_EXTERNAL_PLUGIN_NODE_PERMISSION: "true" });
    if (workerPath().endsWith(".ts")) {
      expect(() => execArgvForWorker("/tmp/plugin.tool.js")).toThrow(/tsx\/dev TypeScript plugin workers are not supported/);
    } else if (nodePermissionModeSupport() === "unsupported") {
      expect(() => execArgvForWorker("/tmp/plugin.tool.js")).toThrow(/does not support required permission flags/);
    } else {
      expect(execArgvForWorker("/tmp/plugin.tool.js")).toEqual(expect.arrayContaining(["--permission", "--no-addons"]));
    }
  });

  test("unsupported Node fails clearly when enabled", async () => {
    const { nodePermissionModeSupport } = await loadRunner({ MCP_EXTERNAL_PLUGIN_NODE_PERMISSION: "true" });
    expect(nodePermissionModeSupport("18.20.0")).toBe("unsupported");
  });

  test("isolationLevel becomes node-permission-best-effort when enabled", async () => {
    const { ChildProcessPluginRunner } = await loadRunner({ MCP_EXTERNAL_PLUGIN_NODE_PERMISSION: "true" });
    expect(new ChildProcessPluginRunner().isolationLevel).toBe("node-permission-best-effort");
  });

  test("compiled dist runner works for a valid plugin after guards are installed", async () => {
    await ensureDistBuild();
    const plugin = await writePlugin("dist-valid.tool.js", VALID_PLUGIN);
    const script = await writePlugin("run-dist-valid.mjs", String.raw`
import { describeExternalPlugin, invokeExternalPlugin } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, "dist/core/plugin_external_runner.js")).href)};
const plugin = ${JSON.stringify(plugin)};
const metadata = await describeExternalPlugin(plugin);
if (metadata[0]?.name !== "valid") throw new Error("metadata failed");
const response = await invokeExternalPlugin(plugin, "valid", {}, { phase: "intake", revision: 1, payload: {} });
if (response.result.content[0].text !== "ok") throw new Error("invoke failed");
console.log("dist-valid-ok");
`);

    const { stdout } = await execFileAsync(process.execPath, [script], { cwd: projectRoot, timeout: 10_000 });
    expect(stdout).toContain("dist-valid-ok");
  }, 20_000);

  test("compiled permission mode allows plugin reads and blocks fs writes", async () => {
    await ensureDistBuild();
    const plugin = await writePlugin("permission.tool.js", String.raw`
import { readFile, writeFile } from "node:fs/promises";
export const tools = [{
  name: "permission", description: "permission", inputSchema: {}, allowedPhases: ["execution"],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execution: { taskSupport: "forbidden" },
  handler: async (args) => {
    if (args.mode === "read") {
      const text = await readFile(new URL(import.meta.url), "utf8");
      return { content: [{ type: "text", text: text.includes("permission") ? "read-ok" : "read-miss" }] };
    }
    await writeFile("blocked-by-node-permission.txt", "nope");
    return { content: [{ type: "text", text: "write-ok" }] };
  },
}];
`);
    const script = await writePlugin("run-dist-permission.mjs", String.raw`
import { invokeExternalPlugin } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, "dist/core/plugin_external_runner.js")).href)};
const plugin = ${JSON.stringify(plugin)};
const readResponse = await invokeExternalPlugin(plugin, "permission", { mode: "read" }, { phase: "intake", revision: 1, payload: {} });
if (readResponse.result.content[0].text !== "read-ok") throw new Error("read failed");
try {
  await invokeExternalPlugin(plugin, "permission", { mode: "write" }, { phase: "intake", revision: 1, payload: {} });
  throw new Error("write unexpectedly succeeded");
} catch (error) {
  const text = String(error?.message || error);
  if (!/permission|access|fs\.writeFile/i.test(text)) throw error;
}
console.log("permission-behavior-ok");
`);

    const { stdout } = await execFileAsync(process.execPath, [script], {
      cwd: projectRoot,
      timeout: 15_000,
      env: {
        ...process.env,
        MCP_EXTERNAL_PLUGIN_NODE_PERMISSION: "true",
        MCP_EXTERNAL_PLUGIN_FS_POLICY: "allow",
      },
    });
    expect(stdout).toContain("permission-behavior-ok");
  }, 25_000);
});
