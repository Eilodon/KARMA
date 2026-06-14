/**
 * Tests for final rc2026 protocol-header validation middleware.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

// ── test helpers ─────────────────────────────────────────────────────────────

async function importMiddlewareWithMode(mode = "rc2026") {
  vi.resetModules();
  vi.stubEnv("MCP_PROTOCOL_MODE", mode);
  const mod = await import("../middlewares/protocol_header.js");
  return mod.protocolHeaderValidation;
}

function makeReq(
  headers: Record<string, string | string[]>,
  body: unknown,
): Request {
  return { headers, body } as unknown as Request;
}

function makeRes() {
  let _status = 0;
  let _body: unknown;
  const res = {
    get _status() { return _status; },
    get _body() { return _body; },
    status(code: number) { _status = code; return res; },
    json(data: unknown) { _body = data; return res; },
  };
  return res as unknown as Response & { _status: number; _body: unknown };
}

// ── rc2026 mode ───────────────────────────────────────────────────────────────

describe("protocolHeaderValidation – rc2026 final mode", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  test("missing Mcp-Method header → -32602 (required in rc2026)", async () => {
    const mw = await importMiddlewareWithMode();
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq({}, { method: "tools/call" });
    const res = makeRes();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    const body = res._body as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  test("Mcp-Method present and matching for non-named method → passes", async () => {
    const mw = await importMiddlewareWithMode();
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq(
      { "mcp-method": "tools/list" },
      { method: "tools/list" },
    );
    const res = makeRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test("tools/call missing Mcp-Name header → -32602 (required in rc2026)", async () => {
    const mw = await importMiddlewareWithMode();
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq(
      { "mcp-method": "tools/call" },
      { method: "tools/call", params: { name: "my_tool" } },
    );
    const res = makeRes();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    const body = res._body as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  test("Mcp-Method present but mismatched → -32602", async () => {
    const mw = await importMiddlewareWithMode();
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq(
      { "mcp-method": "tools/call" },
      { method: "tools/list" },
    );
    const res = makeRes();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    const body = res._body as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  test("Mcp-Method present, Mcp-Name mismatched → -32602", async () => {
    const mw = await importMiddlewareWithMode();
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq(
      { "mcp-method": "tools/call", "mcp-name": "tool_x" },
      { method: "tools/call", params: { name: "tool_y" } },
    );
    const res = makeRes();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    const body = res._body as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  test("all headers present and all matching → passes", async () => {
    const mw = await importMiddlewareWithMode();
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq(
      { "mcp-method": "tools/call", "mcp-name": "my_tool" },
      { method: "tools/call", params: { name: "my_tool" } },
    );
    const res = makeRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test("array header is rejected instead of taking the first value", async () => {
    const mw = await importMiddlewareWithMode();
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq(
      { "mcp-method": ["tools/list", "ignored"] },
      { method: "tools/list" },
    );
    const res = makeRes();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect((res._body as { error: { code: number; message: string } }).error.code).toBe(-32602);
    expect((res._body as { error: { code: number; message: string } }).error.message).toContain("single-valued");
  });

  test("comma-joined operation header is rejected", async () => {
    const mw = await importMiddlewareWithMode();
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq(
      { "mcp-method": "tools/list,tools/call" },
      { method: "tools/list" },
    );
    const res = makeRes();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect((res._body as { error: { message: string } }).error.message).toContain("comma-joined");
  });

  test("jsonrpc error shape is well-formed", async () => {
    const mw = await importMiddlewareWithMode();
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq({}, { method: "tools/call" });
    const res = makeRes();
    mw(req, res, next);
    const body = res._body as { jsonrpc: string; error: { code: number; message: string }; id: null };
    expect(body.jsonrpc).toBe("2.0");
    expect(typeof body.error.message).toBe("string");
    expect(body.id).toBeNull();
  });

  test("legacy/compat protocol modes are hard-disabled in this branch", async () => {
    await expect(importMiddlewareWithMode("compat")).rejects.toThrow(/process.exit/);
    await expect(importMiddlewareWithMode("legacy")).rejects.toThrow(/process.exit/);
  });
});
