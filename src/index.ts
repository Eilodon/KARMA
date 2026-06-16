import { ENV } from "./config/env.js";
import { SuperMcpRuntime } from "./core/runtime.js";
import { PluginLoader } from "./core/plugin_loader.js";
import { withRequestContext } from "./security/context.js";
import { authenticateHttpRequest } from "./security/auth.js";
import { isBodyTooLargeError, isJsonRequest } from "./http/security.js";
import { createServerCard } from "./http/server_card.js";
import { protectedResourceMetadata, resourceMetadataPath } from "./http/oauth_metadata.js";
import { protocolHeaderValidation } from "./middlewares/protocol_header.js";
import { createStdioTransport, loadHttpServerAdapters } from "./mcp/adapter/mcp_protocol_adapter.js";
import { startKarmaIndexer, stopKarmaIndexer } from "./lib/skill_indexer_runtime.js";

let runtime: SuperMcpRuntime;

function parseList(raw: string): string[] {
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function isAllowedHost(hostHeader: string | undefined, allowedHosts: Set<string>): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  const hostWithoutPort = host.split(":")[0];
  return allowedHosts.has(host) || allowedHosts.has(hostWithoutPort);
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

async function main() {
  const tools = await PluginLoader.loadAll();
  runtime = new SuperMcpRuntime("1.0.0", tools);
  await runtime.initialize();
  const state = await runtime.getDefaultState();

  console.error(`[KARMA] Server Started v1.0.0`);
  console.error(`[KARMA] Tenant: ${ENV.MCP_TENANT_ID} | Project: ${ENV.MCP_PROJECT_ID}`);
  console.error(`[KARMA] Config: Transport=${ENV.TRANSPORT_DRIVER}, Storage=${ENV.STORAGE_DRIVER}, Telemetry=${ENV.TELEMETRY_DRIVER}`);
  console.error(`[KARMA] Security: Encrypted=${!!ENV.MCP_ENCRYPTION_KEY}, SafeMode=${ENV.MCP_SAFE_MODE}`);
  console.error(`[KARMA] Current Phase: ${state.phase}`);

  // P3-B: MCP_TRUST_IDENTITY_HEADERS is an advanced forwarding mode that relies
  // entirely on a trusted upstream auth gateway to inject identity headers.
  // Enabling it without a proper gateway is a critical security misconfiguration.
  if (ENV.MCP_TRUST_IDENTITY_HEADERS) {
    console.error(
      "[KARMA] WARNING: MCP_TRUST_IDENTITY_HEADERS=true — " +
      "identity headers (x-mcp-tenant-id, x-mcp-user-id, x-mcp-client-id, x-mcp-scopes) are " +
      "accepted from upstream. Only enable behind a trusted auth gateway (e.g. OAuth2 proxy, " +
      "mTLS-verified sidecar). Direct exposure will allow clients to impersonate any tenant/user."
    );
  }

  // D-5.3 fix: warn on startup so operators know they are running without DoS controls.
  if (ENV.TRANSPORT_DRIVER === "http" && (!ENV.ENABLE_RATE_LIMIT || !ENV.ENABLE_QUOTA)) {
    console.error(
      "[KARMA] WARNING: ENABLE_RATE_LIMIT and/or ENABLE_QUOTA are disabled. " +
      "Set both to true to prevent request flooding and resource exhaustion."
    );
  }

  // Start the on-chain skill indexer (backfill + live watch) so discover_skills reflects chain
  // state and karma_health can report indexer progress. Skipped in safe mode (network blocked) or
  // when no contract is configured. Failure here is non-fatal — the server still serves tools.
  if (!ENV.MCP_SAFE_MODE && process.env.PHAROS_CONTRACT_ADDRESS) {
    try {
      startKarmaIndexer();
      console.error("[KARMA] Skill event indexer started (backfill + live watch).");
    } catch (err) {
      console.error("[KARMA] Skill indexer failed to start (continuing without it):", err);
    }
  } else {
    console.error("[KARMA] Skill indexer not started (safe mode or PHAROS_CONTRACT_ADDRESS unset).");
  }

  if (ENV.TRANSPORT_DRIVER === "http") {
    const { StreamableHTTPServerTransport, createMcpExpressApp } = await loadHttpServerAdapters();
    const cors = (await import("cors")).default;
    const express = (await import("express")).default;

    const app = createMcpExpressApp();
    const allowedOrigins = new Set(parseList(ENV.ALLOWED_ORIGINS));
    const allowedHosts = new Set(parseList(ENV.ALLOWED_HOSTS).map(h => h.toLowerCase()));

    app.disable("x-powered-by");

    app.use((req, res, next) => {
      if (!isAllowedHost(req.headers.host, allowedHosts)) {
        res.status(403).json({ error: "Invalid Host" });
        return;
      }
      next();
    });

    app.use(cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Origin not allowed"));
      }
    }));

    app.get("/.well-known/mcp.json", (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(createServerCard(tools, "1.0.0"));
    });

    app.get("/.well-known/mcp-server-card", (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(createServerCard(tools, "1.0.0"));
    });

    app.get(resourceMetadataPath(), (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(protectedResourceMetadata(tools));
    });

    app.use("/mcp", (req, res, next) => {
      const contentType = req.headers["content-type"];
      if (!isJsonRequest(req.method, Array.isArray(contentType) ? contentType[0] : contentType)) {
        res.status(415).json(jsonRpcError(-32000, "Unsupported media type. Use application/json."));
        return;
      }
      next();
    });

    app.use("/mcp", express.json({ limit: ENV.MCP_HTTP_BODY_LIMIT, type: ["application/json", "application/*+json"] }));

    app.use("/mcp", (error: any, req: any, res: any, next: any) => {
      if (isBodyTooLargeError(error)) {
        res.status(413).json(jsonRpcError(-32000, "Payload too large."));
        return;
      }
      next(error);
    });

    app.get("/health/liveness", (req, res) => { res.json({ status: "alive", version: "1.0.0" }); });
    app.get("/health/readiness", async (req, res) => {
      try {
        const healthy = await runtime.healthCheck();
        res.status(healthy ? 200 : 503).json({ status: healthy ? "ready" : "not_ready", storage: ENV.STORAGE_DRIVER });
      } catch {
        res.status(503).json({ status: "not_ready", storage: ENV.STORAGE_DRIVER });
      }
    });

    app.use("/mcp", async (req, res, next) => {
      try {
        (req as any).superMcpContext = await authenticateHttpRequest(req.headers);
        next();
      } catch {
        if (ENV.MCP_AUTH_MODE === "jwt" || ENV.MCP_AUTH_MODE === "oidc_jwks") {
          const forwardedProto = req.headers["x-forwarded-proto"];
          const rawProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || req.protocol || "https";
          const proto = ["http", "https"].includes(rawProto) ? rawProto : "https";
          const forwardedHost = req.headers["x-forwarded-host"];
          const rawHost = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || req.headers.host;
          const host = isAllowedHost(rawHost, allowedHosts) ? rawHost : null;
          const metadataUrl = host ? `${proto}://${host}${resourceMetadataPath()}` : resourceMetadataPath();
          res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
        }
        res.status(401).json({ error: "Unauthorized" });
      }
    });

    // P2-B: Validate final rc2026 Mcp-Method / Mcp-Name operation headers.
    // Must run after body parse and auth so both req.body and context are available.
    app.use("/mcp", protocolHeaderValidation);

    app.post("/mcp", async (req, res) => {
      const ctx = (req as any).superMcpContext;
      await withRequestContext(ctx, async () => {
        let server: Awaited<ReturnType<typeof runtime.connectEphemeral>> | undefined;
        let transport: InstanceType<typeof StreamableHTTPServerTransport> | undefined;
        try {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            // Stateless JSON responses do not keep an active stream for progress
            // notifications. Long-running work must use native MCP Tasks instead.
            enableJsonResponse: true,
          });
          server = await runtime.connectEphemeral(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error("[KARMA] Error handling MCP HTTP request:", error);
          if (!res.headersSent) {
            res.status(500).json(jsonRpcError(-32603, "Internal server error"));
          }
        } finally {
          await transport?.close().catch(() => undefined);
          await server?.close().catch(() => undefined);
        }
      });
    });

    app.get("/mcp", (req, res) => {
      res.status(405).json(jsonRpcError(-32000, "Method not allowed in stateless HTTP mode."));
    });

    app.delete("/mcp", (req, res) => {
      res.status(405).json(jsonRpcError(-32000, "Method not allowed in stateless HTTP mode."));
    });

    const server = app.listen(ENV.HTTP_PORT, ENV.HTTP_HOST, () => {
      console.error(`[KARMA] Server listening on HTTP ${ENV.HTTP_HOST}:${ENV.HTTP_PORT} at /mcp`);
    });
    (runtime as any)._httpServer = server;
  } else {
    const transport = await createStdioTransport();
    await runtime.connect(transport);
  }

  const shutdown = async (signal: string) => {
    console.error(`\n[KARMA] Received signal ${signal}. Initiating Graceful Shutdown...`);
    try {
      if ((runtime as any)._httpServer) {
        console.error(`[KARMA] Closing HTTP Server...`);
        await new Promise<void>((resolve, reject) => {
          (runtime as any)._httpServer.close((err: unknown) => err ? reject(err instanceof Error ? err : new Error("Server close failed", { cause: err })) : resolve());
        });
      }

      stopKarmaIndexer();

      const { globalTaskTracker } = await import("./core/task_tracker.js");
      globalTaskTracker.beginDraining();
      await globalTaskTracker.awaitAll(30000);
      await runtime.close();
      console.error("[KARMA] Graceful shutdown completed.");
      process.exit(0);
    } catch (err) {
      console.error("[KARMA] Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
}

main().catch((error) => {
  console.error("[KARMA] Fatal Crash:", error);
  process.exit(1);
});
