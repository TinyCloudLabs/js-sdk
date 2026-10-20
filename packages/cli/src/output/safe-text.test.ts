import { describe, expect, test } from "bun:test";

import { safeBlock, safeInline } from "./safe-text.js";

describe("terminal-safe text", () => {
  test("an ANSI escape sequence is shown, not obeyed", () => {
    expect(safeBlock("\u001b[31mred\u001b[0m")).toBe("\\u{1b}[31mred\\u{1b}[0m");
    expect(safeInline("\u001b]0;title\u0007")).toBe("\\u{1b}]0;title\\u{7}");
  });

  test("bidi overrides, C1 controls, DEL and separators are escaped", () => {
    expect(safeBlock("a\u202eb\u2066c\u200fd\u0085e\u007ff\u2028g")).toBe(
      "a\\u{202e}b\\u{2066}c\\u{200f}d\\u{85}e\\u{7f}f\\u{2028}g",
    );
  });

  test("content keeps newlines and tabs; a single-line value does not", () => {
    expect(safeBlock("# Title\n\tbody\r\nend")).toBe("# Title\n\tbody\\u{d}\nend");
    expect(safeInline("line1\nline2\tcol")).toBe("line1\\u{a}line2\\u{9}col");
  });

  test("ordinary text, including non-Latin scripts and emoji, is unchanged", () => {
    const text = "xyz.example.app: 食事ログ — 🍽️ café";
    expect(safeBlock(text)).toBe(text);
    expect(safeInline(text)).toBe(text);
  });
});
