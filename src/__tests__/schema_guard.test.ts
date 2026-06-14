import { describe, expect, test } from "vitest";
import { guardJsonSchema202012, validateJsonAgainstSchema } from "../mcp/adapter/schema_guard.js";

describe("JSON Schema 2020-12 guard", () => {
  test("adds 2020-12 dialect and default string maxLength", () => {
    const guarded = guardJsonSchema202012({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    }, "input");

    expect(guarded.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect((guarded.properties as any).name.maxLength).toBe(8192);
  });

  test("rejects remote refs", () => {
    expect(() => guardJsonSchema202012({
      $ref: "https://example.com/schema.json",
    }, "input")).toThrow(/remote \$ref/);
  });

  test("bounds depth, defs, and property count", () => {
    expect(() => guardJsonSchema202012({ a: { b: { c: true } } }, "input", {
      maxDepth: 1,
      maxDefs: 10,
      maxProperties: 10,
      defaultStringMaxLength: 100,
    })).toThrow(/max depth/);

    expect(() => guardJsonSchema202012({ $defs: { a: {}, b: {} } }, "input", {
      maxDepth: 10,
      maxDefs: 1,
      maxProperties: 10,
      defaultStringMaxLength: 100,
    })).toThrow(/max \$defs/);

    expect(() => guardJsonSchema202012({ properties: { a: {}, b: {} } }, "input", {
      maxDepth: 10,
      maxDefs: 10,
      maxProperties: 1,
      defaultStringMaxLength: 100,
    })).toThrow(/property count/);
  });

  test("validates JSON values with Ajv 2020-12 behind the local guard", () => {
    const schema = guardJsonSchema202012({
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", maxLength: 5 },
      },
    }, "input");

    expect(() => validateJsonAgainstSchema(schema, { name: "Ada" }, "input")).not.toThrow();
    expect(() => validateJsonAgainstSchema(schema, { name: "toolong" }, "input")).toThrow(/more than 5 characters|maxLength/);
    expect(() => validateJsonAgainstSchema(schema, { extra: true }, "input")).toThrow(/required property|must have required property/);
    expect(() => validateJsonAgainstSchema(schema, { name: "Ada", extra: true }, "input")).toThrow(/additional propert/);
  });

  test("supports 2020-12 conditionals through Ajv", () => {
    const schema = guardJsonSchema202012({
      type: "object",
      properties: {
        kind: { enum: ["email", "sms"] },
        address: { type: "string" },
        phone: { type: "string" },
      },
      if: { properties: { kind: { const: "email" } } },
      then: { required: ["address"] },
      else: { required: ["phone"] },
    }, "input");

    expect(() => validateJsonAgainstSchema(schema, { kind: "email", address: "a@example.com" }, "input")).not.toThrow();
    expect(() => validateJsonAgainstSchema(schema, { kind: "email", phone: "123" }, "input")).toThrow(/required property|must have required property/);
  });
});
