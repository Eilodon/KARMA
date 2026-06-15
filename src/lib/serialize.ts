/**
 * Recursively convert every BigInt in a value to its decimal string (D-6).
 *
 * A bare BigInt anywhere in a tool's structuredContent throws in the MCP JSON layer
 * ("Do not know how to serialize a BigInt"). Wrapping output in jsonSafe() guarantees
 * uint256 amounts/ids cross the boundary as strings, with no precision loss.
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}
