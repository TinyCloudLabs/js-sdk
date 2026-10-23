import { describe, expect, test } from "bun:test";

import { knowledgeListRows, knowledgeReadParts } from "./knowledge-render.js";

// Terminal control sequences a hostile bundle could carry: clear screen, carriage-return overwrite,
// a right-to-left override that reorders what follows, and an OSC title with BEL.
const ESC_CLEAR = "\u001b[2J";
const CR = "aaaa\rb";
const RLO = "\u202egpj.exe";
const OSC = "\u001b]0;owned\u0007";

// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

describe("human output of knowledge list|read cannot drive the terminal", () => {
  test("knowledge list: app id, name and root are escaped", () => {
    const rows = knowledgeListRows([
      { app_id: `evil${ESC_CLEAR}`, name: `${CR}${RLO}`, root: `x${OSC}/knowledge/`, has_index: false, concepts: ["app.md"] },
    ]);
    expect(rows).toHaveLength(1);
    for (const cell of rows[0]!) expect(cell).not.toMatch(RAW_CONTROL);
    expect(rows[0]![0]).toBe("evil\\u{1b}[2J");
    expect(rows[0]![1]).toContain("\\u{d}");
    expect(rows[0]![1]).toContain("\\u{202e}");
    expect(rows[0]![2]).toContain("\\u{7}");
    expect(rows[0]![3]).toBe("1");
  });

  test("knowledge read: the key (concept name), the frontmatter line and the content are escaped; newlines in content stay", () => {
    const parts = knowledgeReadParts({
      key: `app.x/knowledge/${ESC_CLEAR}tables/${RLO}.md`,
      frontmatter: { title: `${CR}${OSC}`, resource: RLO },
      body: `# Title\n${ESC_CLEAR}hidden\r${RLO}\n- item\n`,
    });
    for (const text of [parts.heading, parts.meta!]) expect(text).not.toMatch(RAW_CONTROL);
    expect(parts.body.replace(/\n/g, "")).not.toMatch(RAW_CONTROL);
    expect(parts.heading).toContain("\\u{1b}[2J");
    expect(parts.heading).toContain("\\u{202e}");
    expect(parts.meta).toContain("\\u{202e}");
    expect(parts.body).toBe("# Title\n\\u{1b}[2Jhidden\\u{d}\\u{202e}gpj.exe\n- item\n");
  });

  test("ordinary text is unchanged and a body always ends with one newline", () => {
    expect(knowledgeReadParts({ key: "a/knowledge/app.md", frontmatter: null, body: "# TinyHealth\nLog meals." })).toEqual({
      heading: "a/knowledge/app.md",
      body: "# TinyHealth\nLog meals.\n",
    });
  });
});
