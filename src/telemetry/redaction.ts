const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|credential|private[_-]?key|reasoning)/i;
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]"],
  [/(redis:\/\/:)[^@\s]+(@)/gi, "$1[REDACTED]$2"],
  [/((?:api[_-]?key|token|secret|password|authorization)=)[^&\s]+/gi, "$1[REDACTED]"],
  [/([A-Za-z0-9._%+-]+):([^@\s]{6,})@/g, "$1:[REDACTED]@"],
];

function scrubString(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...[TRUNCATED]` : redacted;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, val]) => {
      if (SECRET_KEY_PATTERN.test(key)) {
        return [key, "[REDACTED]"];
      }
      return [key, redact(val)];
    }));
  }
  if (typeof value === "string") return scrubString(value);
  return value;
}
