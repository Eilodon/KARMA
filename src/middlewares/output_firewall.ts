import type { ToolResult } from "../mcp/adapter/tool_registry.js";
import { ENV } from "../config/env.js";

const STRUCTURED_REDACTION_LIMITS = {
  maxDepth: 32,
  maxNodes: 10_000,
  maxStringLength: 256 * 1024,
  maxTotalStringBytes: 2 * 1024 * 1024,
};

const STRUCTURED_DEPTH_LIMIT = "STRUCTURED_CONTENT_DEPTH_LIMIT";
const STRUCTURED_NODE_LIMIT = "STRUCTURED_CONTENT_NODE_LIMIT";
const STRUCTURED_STRING_LIMIT = "STRUCTURED_CONTENT_STRING_LIMIT";
const STRUCTURED_CYCLE = "STRUCTURED_CONTENT_CYCLE";
const STRUCTURED_SECRET_FIELD = "STRUCTURED_SECRET_FIELD";

const SENSITIVE_FIELD_RE =
  /(^|[_-]|\b)(api[_-]?key|secret|token|access[_-]?token|refresh[_-]?token|password|authorization|bearer|client[_-]?secret|private[_-]?key)([_-]|\b|$)/i;

const CREDENTIAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "PRIVATE_KEY", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "OPENAI_KEY", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "GITHUB_TOKEN", pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
  { label: "AWS_ACCESS_KEY", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

const STRICT_PII_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "EMAIL", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  // eslint-disable-next-line security/detect-unsafe-regex
  { label: "PHONE", pattern: /\b(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?)?\d{3,4}[ .-]?\d{3,4}\b/g },
];

const PROMPT_INJECTION_MARKERS: RegExp[] = [
  /ignore (all )?(previous|prior) instructions/gi,
  /reveal (the )?(system|developer) (prompt|message)/gi,
  /BEGIN SYSTEM PROMPT/gi,
  /do not tell (the )?user/gi,
];

interface StructuredRedactionState {
  nodes: number;
  totalStringBytes: number;
  seen: WeakSet<object>;
}

export interface OutputFirewallResult {
  result: ToolResult;
  violations: string[];
}

function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function validSsn(candidate: string): boolean {
  const match = /^(\d{3})-(\d{2})-(\d{4})$/.exec(candidate);
  if (!match) return false;
  const area = Number(match[1]);
  const group = match[2];
  const serial = match[3];

  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === "00") return false;
  if (serial === "0000") return false;
  return true;
}

function redactCardNumbers(text: string, violations: Set<string>): string {
  // eslint-disable-next-line security/detect-unsafe-regex
  return text.replace(/\b(?:\d[ -]?){13,19}\b/g, match => {
    if (!luhnValid(match)) return match;
    violations.add("PAYMENT_CARD");
    return "[REDACTED:PAYMENT_CARD]";
  });
}

function redactSsns(text: string, violations: Set<string>): string {
  return text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, match => {
    if (!validSsn(match)) return match;
    violations.add("SSN");
    return "[REDACTED:SSN]";
  });
}

function redactPromptInjectionMarkers(text: string, violations: Set<string>): string {
  let redacted = text;
  for (const pattern of PROMPT_INJECTION_MARKERS) {
    redacted = redacted.replace(pattern, match => {
      violations.add("PROMPT_INJECTION_MARKER");
      return `[REDACTED:PROMPT_INJECTION_MARKER:${match.length}]`;
    });
  }
  return redacted;
}

function redactStrictPii(text: string, violations: Set<string>): string {
  if (ENV.MCP_OUTPUT_FIREWALL_PII_MODE !== "strict") return text;

  let redacted = text;
  for (const { label, pattern } of STRICT_PII_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      violations.add(label);
      return `[REDACTED:${label}]`;
    });
  }
  return redacted;
}

function redactSensitiveText(text: string, violations: Set<string>): string {
  let redacted = redactCardNumbers(text, violations);
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      violations.add(label);
      return `[REDACTED:${label}]`;
    });
  }
  redacted = redactSsns(redacted, violations);
  redacted = redactStrictPii(redacted, violations);
  return redactPromptInjectionMarkers(redacted, violations);
}

function redactJsonValue(
  value: unknown,
  violations: Set<string>,
  state: StructuredRedactionState,
  path: string[] = [],
  depth = 0,
): unknown {
  if (depth > STRUCTURED_REDACTION_LIMITS.maxDepth) {
    violations.add(STRUCTURED_DEPTH_LIMIT);
    return "[REDACTED:STRUCTURED_CONTENT_DEPTH_LIMIT]";
  }

  state.nodes += 1;
  if (state.nodes > STRUCTURED_REDACTION_LIMITS.maxNodes) {
    violations.add(STRUCTURED_NODE_LIMIT);
    return "[REDACTED:STRUCTURED_CONTENT_NODE_LIMIT]";
  }

  const key = path[path.length - 1] ?? "";

  if (typeof value === "string") {
    state.totalStringBytes += Buffer.byteLength(value, "utf8");

    if (
      value.length > STRUCTURED_REDACTION_LIMITS.maxStringLength ||
      state.totalStringBytes > STRUCTURED_REDACTION_LIMITS.maxTotalStringBytes
    ) {
      violations.add(STRUCTURED_STRING_LIMIT);
      return "[REDACTED:STRUCTURED_CONTENT_STRING_LIMIT]";
    }

    if (SENSITIVE_FIELD_RE.test(key) && value.trim().length >= 6) {
      violations.add(STRUCTURED_SECRET_FIELD);
      return "[REDACTED:STRUCTURED_SECRET_FIELD]";
    }

    return redactSensitiveText(value, violations);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactJsonValue(item, violations, state, [...path, String(index)], depth + 1),
    );
  }

  if (value && typeof value === "object") {
    if (state.seen.has(value)) {
      violations.add(STRUCTURED_CYCLE);
      return "[REDACTED:STRUCTURED_CONTENT_CYCLE]";
    }

    state.seen.add(value);

    const out: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      out[nestedKey] = redactJsonValue(
        nestedValue,
        violations,
        state,
        [...path, nestedKey],
        depth + 1,
      );
    }

    state.seen.delete(value);
    return out;
  }

  return value;
}

export function scanToolOutput(result: ToolResult): OutputFirewallResult {
  const violations = new Set<string>();
  const content = result.content.map(item => {
    if (item.type !== "text") return item;
    return { ...item, text: redactSensitiveText(item.text, violations) };
  });

  const nextResult: ToolResult = { ...result, content };

  if ("structuredContent" in result) {
    const state: StructuredRedactionState = {
      nodes: 0,
      totalStringBytes: 0,
      seen: new WeakSet<object>(),
    };

    nextResult.structuredContent = redactJsonValue(
      result.structuredContent,
      violations,
      state,
    );
  }

  return {
    result: nextResult,
    violations: [...violations].sort(),
  };
}
