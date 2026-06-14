import { describe, expect, test } from "vitest";
import { isBodyTooLargeError, isJsonRequest } from "../http/security.js";

describe("HTTP security helpers", () => {
  test("accepts JSON request content types for MCP POST requests", () => {
    expect(isJsonRequest("POST", "application/json")).toBe(true);
    expect(isJsonRequest("POST", "application/vnd.mcp+json; charset=utf-8")).toBe(true);
  });

  test("rejects missing or non-JSON content types for MCP POST requests", () => {
    expect(isJsonRequest("POST", undefined)).toBe(false);
    expect(isJsonRequest("POST", "text/plain")).toBe(false);
  });

  test("recognizes body parser payload limit errors", () => {
    expect(isBodyTooLargeError({ type: "entity.too.large" })).toBe(true);
    expect(isBodyTooLargeError({ type: "entity.parse.failed" })).toBe(false);
  });
});
