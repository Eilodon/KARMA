const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SANITIZE_DEPTH = 50;

export function sanitizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return "[MAX_DEPTH_EXCEEDED]";

  if (Array.isArray(value)) {
    return value.map(item => sanitizeJsonValue(item, depth + 1));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const sanitized = Object.create(null) as Record<string, unknown>;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_JSON_KEYS.has(key)) continue;
    sanitized[key] = sanitizeJsonValue(nested, depth + 1);
  }
  return sanitized;
}
