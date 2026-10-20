import { describe, expect, test } from "bun:test";

import { safeBlock, safeInline, safeJsonStringify } from "./safe-text.js";

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

describe("every class of invisible or terminal-driving character is neutralised", () => {
  const classes: [string, string][] = [
    ["C0 control (ESC)", "\u001b[2J"],
    ["NUL", "\u0000"],
    ["DEL", "\u007f"],
    ["C1 control (CSI 0x9b)", "\u009b"],
    ["C1 control (0x80)", "\u0080"],
    ["zero-width space U+200B", "\u200b"],
    ["zero-width non-joiner U+200C", "\u200c"],
    ["zero-width joiner U+200D", "\u200d"],
    ["left-to-right mark U+200E", "\u200e"],
    ["right-to-left mark U+200F", "\u200f"],
    ["line separator U+2028", "\u2028"],
    ["paragraph separator U+2029", "\u2029"],
    ["bidi embedding U+202A", "\u202a"],
    ["bidi override U+202E", "\u202e"],
    ["bidi isolate U+2066", "\u2066"],
    ["bidi isolate U+2069", "\u2069"],
    ["byte order mark U+FEFF", "\ufeff"],
  ];
  // eslint-disable-next-line no-control-regex
  const RAW = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

  test.each(classes)("%s is shown as an escape by both helpers", (_name, character) => {
    for (const helper of [safeInline, safeBlock]) {
      const out = helper(`a${character}b`);
      expect(out).not.toMatch(RAW);
      expect(out).toContain("\\u{");
      expect(out.startsWith("a") && out.endsWith("b")).toBe(true);
    }
  });
});

describe("safeJsonStringify", () => {
  const hostile = {
    a: "\u001b[2J\u007f\u009b\u200b\u200f\u2028\u2029\u202e\u2066\ufeff\u061c",
    "key\u202e": ["x\u2029", { n: 1, b: true, z: null }],
    quote: 'he said "hi" \\ \n\t',
  };
  // eslint-disable-next-line no-control-regex
  const RAW = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

  test.each([[undefined], [2]])("writes every terminal-acting character as a \\uXXXX escape and parses back to the same value (indent %p)", (indent) => {
    const text = safeJsonStringify(hostile, indent);
    expect(text.replace(/\n/g, "")).not.toMatch(RAW);
    expect(text).toContain("\\u009b");
    expect(text).toContain("\\u202e");
    expect(text).toContain("\\u2028");
    expect(text).toContain("\\ufeff");
    expect(text).toContain("\\u007f");
    expect(JSON.parse(text)).toEqual(hostile);
  });

  test("ordinary values are byte-identical to JSON.stringify", () => {
    const value = { a: "café 食事 🍽️", b: [1, 2.5, null, false], c: { d: "x" } };
    expect(safeJsonStringify(value, 2)).toBe(JSON.stringify(value, null, 2));
  });
});
