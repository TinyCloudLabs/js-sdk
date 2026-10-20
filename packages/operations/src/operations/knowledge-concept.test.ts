import { describe, expect, test } from "bun:test";

import { indexLinks, parseConcept } from "./knowledge-concept.js";

describe("parseConcept", () => {
  test("parses an OKF concept's frontmatter: scalars, lists, nested maps, flow forms and comments", () => {
    const parsed = parseConcept([
      "---",
      "type: SQLite Table",
      "resource: tinycloud.sql:applications:xyz.tinycloud.health/health_log",
      "table: meal",
      'title: "Meals: logged"',
      "version: 2",
      "verified: false",
      "status: ~",
      "sources: [schema.sql, 'it''s here']",
      "generated: {by: okf/0.2, at: 2026-10-20}",
      "columns:",
      "  - name: kcal",
      "    type: INTEGER",
      "  - name: basis",
      "    check: [estimated, measured]",
      "tags:",
      "- food",
      "- daily # trailing comment",
      "# a comment line",
      "---",
      "# Meal",
      "",
      "Body text.",
    ].join("\n"));

    expect(parsed.frontmatterError).toBeUndefined();
    expect(parsed.frontmatter).toEqual({
      type: "SQLite Table",
      resource: "tinycloud.sql:applications:xyz.tinycloud.health/health_log",
      table: "meal",
      title: "Meals: logged",
      version: 2,
      verified: false,
      status: null,
      sources: ["schema.sql", "it's here"],
      generated: { by: "okf/0.2", at: "2026-10-20" },
      columns: [
        { name: "kcal", type: "INTEGER" },
        { name: "basis", check: ["estimated", "measured"] },
      ],
      tags: ["food", "daily"],
    });
    expect(parsed.body).toBe("# Meal\n\nBody text.");
  });

  test("a file without frontmatter is all body; a --- later in the text is not frontmatter", () => {
    expect(parseConcept("# Index\n\n---\ntype: x\n---\n")).toEqual({
      frontmatter: null,
      body: "# Index\n\n---\ntype: x\n---\n",
    });
  });

  test("reports unsupported YAML instead of guessing, and keeps the body", () => {
    const parsed = parseConcept("---\ntype: App\nnotes: |\n  block scalar\n---\nBody");
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.frontmatterError).toContain("Unsupported YAML construct");
    expect(parsed.frontmatterRaw).toContain("block scalar");
    expect(parsed.body).toBe("Body");

    expect(parseConcept("---\na: 1\na: 2\n---\n").frontmatterError).toContain("Duplicate key");
    expect(parseConcept("---\n__proto__: x\n---\n").frontmatterError).toContain("__proto__");
    expect(parseConcept("---\n- just\n- a list\n---\n").frontmatterError).toContain("single mapping");
  });
});

describe("indexLinks", () => {
  test("returns local links in order and skips external links and anchors", () => {
    expect(indexLinks([
      "- [App](app.md)",
      "- [meal](tables/meal.md) the meal table",
      "- [OKF](https://example.com/okf)",
      "- [top](#top)",
    ].join("\n"))).toEqual([
      { title: "App", target: "app.md" },
      { title: "meal", target: "tables/meal.md" },
    ]);
  });
});
