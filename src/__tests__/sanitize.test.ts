import { describe, expect, test } from "vitest";
import { sanitizeJsonValue } from "../security/sanitize.js";

describe("JSON sanitizer", () => {
  test("recursively strips prototype pollution keys before policy evaluation", () => {
    const result = sanitizeJsonValue({
      ok: true,
      __proto__: { polluted: true },
      nested: {
        constructor: { prototype: { poisoned: true } },
        safe: [{ prototype: "drop" }, { keep: "yes" }],
      },
    }) as any;

    expect(result.ok).toBe(true);
    expect(result.__proto__).toBeUndefined();
    expect(result.nested.constructor).toBeUndefined();
    expect(result.nested.safe[0].prototype).toBeUndefined();
    expect(result.nested.safe[1].keep).toBe("yes");
  });
});
