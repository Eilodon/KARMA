/**
 * Zero-dependency terminal presentation helpers for the KARMA demo scripts.
 *
 * Color is auto-disabled when stdout is not a TTY (piped/recorded to file) or NO_COLOR is set,
 * so machine-parseable output and CI logs stay clean. No external color dependency — the demo
 * must run identically on any reviewer's machine.
 */

/** True when ANSI color should be emitted (interactive TTY and NO_COLOR unset). */
export const colorEnabled: boolean = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/** Wrap `s` in an ANSI SGR code when enabled; otherwise return it untouched (pure, testable). */
export function paint(enabled: boolean, open: string, s: string): string {
  return enabled ? `\x1b[${open}m${s}\x1b[0m` : s;
}

/** Shorten a long hash/address to head…tail (e.g. 0xabcdef…1234); leaves short strings intact. */
export function short(s: string, head = 6, tail = 4): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Render a string with dangerous/invisible code points shown as red \uXXXX escapes (pure). */
export function reveal(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const dangerous =
      cp < 0x20 || cp === 0x7f ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      cp === 0x2060 || cp === 0xfeff;
    out += dangerous ? C.red(`\\u${cp.toString(16).padStart(4, "0")}`) : ch;
  }
  return out;
}

const sgr = (open: string) => (s: string): string => paint(colorEnabled, open, s);

/** Semantic color palette for the demo. */
export const C = {
  bold: sgr("1"),
  dim: sgr("2"),
  red: sgr("31"),
  green: sgr("32"),
  yellow: sgr("33"),
  blue: sgr("34"),
  magenta: sgr("35"),
  cyan: sgr("36"),
  gray: sgr("90"),
};

/** A "[n/total] title" step header, dim counter + bold title. */
export function step(n: number, total: number, title: string): string {
  return `\n${C.dim(`[${n}/${total}]`)} ${C.bold(title)}`;
}

/** Right-pad a label and dim it for aligned key/value rows. */
export function kv(label: string, value: string, pad = 14): string {
  return `  ${C.gray(label.padEnd(pad))} ${value}`;
}

/** A success line: green check + message. */
export function ok(msg: string): string {
  return `  ${C.green("✓")} ${msg}`;
}

/** A boxed banner for section breaks. */
export function banner(title: string): string {
  const line = "─".repeat(title.length + 2);
  return C.cyan(`\n┌${line}┐\n│ ${C.bold(title)}${C.cyan(" │")}\n└${line}┘`);
}
