import { createRequire } from "node:module";

export interface JsonSchemaGuardOptions {
  maxDepth: number;
  maxDefs: number;
  maxProperties: number;
  defaultStringMaxLength: number;
}

export const DEFAULT_JSON_SCHEMA_GUARD: JsonSchemaGuardOptions = {
  maxDepth: 32,
  maxDefs: 128,
  maxProperties: 1024,
  defaultStringMaxLength: 8192,
};

const REMOTE_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const require = createRequire(import.meta.url);
let cachedAjv: any;
const compiledValidators = new Map<string, any>();

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNoRemoteRef(ref: unknown, path: string): void {
  if (typeof ref !== "string") return;
  if (REMOTE_REF_PATTERN.test(ref)) {
    throw new Error(`[SUPER-MCP] JSON Schema remote $ref is not allowed at ${path}: ${ref}`);
  }
}

function walkSchema(value: unknown, path: string, depth: number, options: JsonSchemaGuardOptions, counters: { defs: number; properties: number }): unknown {
  if (depth > options.maxDepth) {
    throw new Error(`[SUPER-MCP] JSON Schema exceeds max depth ${options.maxDepth} at ${path}`);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => walkSchema(item, `${path}/${index}`, depth + 1, options, counters));
  }

  if (!isObject(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if (key === "$ref") assertNoRemoteRef(nested, childPath);
    if (key === "$defs" && isObject(nested)) {
      counters.defs += Object.keys(nested).length;
      if (counters.defs > options.maxDefs) {
        throw new Error(`[SUPER-MCP] JSON Schema exceeds max $defs count ${options.maxDefs}`);
      }
    }
    if (key === "properties" && isObject(nested)) {
      counters.properties += Object.keys(nested).length;
      if (counters.properties > options.maxProperties) {
        throw new Error(`[SUPER-MCP] JSON Schema exceeds max object property count ${options.maxProperties}`);
      }
    }
    next[key] = walkSchema(nested, childPath, depth + 1, options, counters);
  }

  if (next.type === "string" && next.maxLength === undefined) {
    next.maxLength = options.defaultStringMaxLength;
  }

  return next;
}

export function guardJsonSchema202012(schema: unknown, role: "input" | "output", options: JsonSchemaGuardOptions = DEFAULT_JSON_SCHEMA_GUARD): Record<string, unknown> {
  if (!isObject(schema)) {
    throw new Error(`[SUPER-MCP] ${role} schema must be a JSON object`);
  }
  const guarded = walkSchema(schema, "#", 0, options, { defs: 0, properties: 0 });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(guarded as Record<string, unknown>),
  };
}

export interface JsonValidationOptions {
  timeoutMs: number;
  maxErrors: number;
}

export const DEFAULT_JSON_VALIDATION_OPTIONS: JsonValidationOptions = {
  timeoutMs: 50,
  maxErrors: 25,
};

function getAjv(): any {
  if (cachedAjv) return cachedAjv;
  const mod = require("ajv/dist/2020.js");
  const Ajv2020 = mod.default || mod;
  cachedAjv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
    loadSchema: async (uri: string) => {
      throw new Error(`[SUPER-MCP] JSON Schema external load is disabled: ${uri}`);
    },
  });
  return cachedAjv;
}

function validatorFor(schema: Record<string, unknown>, options: JsonValidationOptions): any {
  const key = JSON.stringify({ schema, maxErrors: options.maxErrors });
  const cached = compiledValidators.get(key);
  if (cached) return cached;
  const validate = getAjv().compile(schema);
  compiledValidators.set(key, validate);
  if (compiledValidators.size > 256) {
    const oldest = compiledValidators.keys().next().value;
    if (oldest) compiledValidators.delete(oldest);
  }
  return validate;
}

export function validateJsonAgainstSchema(schema: Record<string, unknown>, value: unknown, role: "input" | "output", options: JsonValidationOptions = DEFAULT_JSON_VALIDATION_OPTIONS): void {
  const guarded = guardJsonSchema202012(schema, role);
  const validate = validatorFor(guarded, options);

  // Measure validation only. AJV cold compile is cached and can legitimately
  // exceed small runtime guard budgets during first use.
  const started = Date.now();
  const valid = validate(value);
  const elapsed = Date.now() - started;
  if (elapsed > options.timeoutMs) {
    throw new Error(`[SUPER-MCP] ${role} JSON Schema validation exceeded ${options.timeoutMs}ms`);
  }
  if (!valid) {
    const errors = (validate.errors || [])
      .slice(0, options.maxErrors)
      .map((error: any) => `${error.instancePath || "#"}: ${error.message || error.keyword}`);
    throw new Error(`[SUPER-MCP] ${role} JSON Schema validation failed: ${errors.join("; ")}`);
  }
}
