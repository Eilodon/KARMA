import { describe, it, expect } from "vitest";
import { paint, short, reveal } from "../scripts/_demo_format.js";

describe("demo format helpers", () => {
  it("paint wraps in ANSI when enabled and passes through when disabled", () => {
    expect(paint(false, "1", "hi")).toBe("hi");
    expect(paint(true, "1", "hi")).toBe("\x1b[1mhi\x1b[0m");
  });

  it("short truncates long hashes keeping head and tail, leaves short strings intact", () => {
    const h = "0x" + "a".repeat(64);
    expect(short(h)).toBe("0xaaaa…aaaa");
    expect(short("0xabc")).toBe("0xabc");
  });

  it("reveal exposes dangerous code points as \\uXXXX and leaves printable text intact", () => {
    // zero-width (200b), bidi RLO (202e), bell (0007) become visible escapes; ASCII untouched
    const zwsp = String.fromCharCode(0x200b);
    const rlo = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(0x07);
    const out = reveal("a" + zwsp + rlo + "z" + bell);
    expect(out).toContain("\\u200b");
    expect(out).toContain("\\u202e");
    expect(out).toContain("\\u0007");
    expect(out).toContain("a");
    expect(out).toContain("z");
    expect(reveal("plain")).toBe("plain");
  });
});
