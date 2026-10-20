import { describe, expect, test } from "bun:test";

import type { RuntimeOperationContext } from "../contract.js";
import { knowledgeOperationDefinitions } from "./knowledge.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const SPACE = (name: string) => `tinycloud:pkh:eip155:1:${OWNER}:${name}`;
const encode = (text: string) => new TextEncoder().encode(text);

const [listOperation, readOperation] = knowledgeOperationDefinitions;

const HEALTH_INDEX = [
  "---",
  "okf_version: \"0.2\"",
  "---",
  "# TinyHealth",
  "",
  "- [app](app.md): what it is",
  "- [meal](tables/meal.md): meals",
  "- [OKF](https://example.com/okf)",
].join("\n");
const MEAL_CONCEPT = [
  "---",
  "type: SQLite Table",
  "resource: tinycloud.sql:applications:xyz.tinycloud.health/health_log",
  "table: meal",
  "---",
  "# meal",
].join("\n");

type Entry = readonly [key: string, text: string];

/** An in-memory KV with the list/get surface the operations use, paged by `pageSize`. */
function fakeNode(spaces: Record<string, readonly Entry[]>, pageSize = 1000) {
  const calls: Array<{ space: string; method: string; value?: unknown }> = [];
  return {
    calls,
    node: {
      kvForSpace(space: string) {
        const entries = [...(spaces[space.split(":").at(-1)!] ?? [])].sort(([a], [b]) => a.localeCompare(b));
        return {
          async list(options: { prefix?: string; limit: number; cursor?: string }) {
            calls.push({ space, method: "list", value: options });
            const matching = entries.filter(([key]) => key.startsWith(options.prefix ?? ""));
            const start = options.cursor === undefined ? 0 : Number(options.cursor);
            const end = start + Math.min(pageSize, options.limit);
            return {
              ok: true as const,
              data: {
                keys: matching.slice(start, end).map(([key]) => key),
                truncated: end < matching.length,
                ...(end < matching.length ? { nextCursor: String(end) } : {}),
              },
            };
          },
          async get(key: string) {
            calls.push({ space, method: "get", value: key });
            const found = entries.find(([candidate]) => candidate === key);
            if (found === undefined) return { ok: false as const, error: { code: "KV_NOT_FOUND" } };
            return { ok: true as const, data: { data: encode(found[1]), headers: { etag: '"etag-1"' } } };
          },
        };
      },
    },
  };
}

function context(node: unknown, granted: RuntimeOperationContext["runtime"]["granted"] = []): RuntimeOperationContext {
  return {
    summary: {
      profile: "agent",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      sessionDid: "did:key:agent",
      space: SPACE("primary"),
    },
    runtime: { node, granted },
  };
}

const registryGrant = [{
  service: "tinycloud.kv",
  space: SPACE("account"),
  path: "applications/",
  actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
}];

const bundles: Record<string, readonly Entry[]> = {
  applications: [
    ["xyz.tinycloud.health/knowledge/index.md", HEALTH_INDEX],
    ["xyz.tinycloud.health/knowledge/app.md", "---\ntype: TinyCloud App\n---\n"],
    ["xyz.tinycloud.health/knowledge/tables/meal.md", MEAL_CONCEPT],
    ["xyz.tinycloud.health/knowledge/log.md", "---\ntype: Log\n---\n"],
    ["xyz.tinycloud.health/app/app.jsx", "export default 1"],
    ["xyz.tinycloud.health/photos/a.jpg", "binary"],
    ["xyz.tinycloud.recipes/knowledge/index.md", "# TinyRecipes"],
    ["xyz.tinycloud.recipes/knowledge/app.md", "---\ntype: TinyCloud App\n---\n"],
    ["xyz.tinycloud.orphan/knowledge/app.md", "---\ntype: TinyCloud App\n---\n"],
    ["xyz.tinycloud.agent-data/notes/a.json", "{}"],
  ],
};

describe("tinycloud.knowledge.list@1", () => {
  test("plans a whole-space list, then returns each bundle with its concepts", async () => {
    const { node, calls } = fakeNode(bundles);
    expect(await listOperation.authority(context(node), {})).toEqual([{
      service: "tinycloud.kv",
      space: SPACE("applications"),
      path: "",
      actions: ["tinycloud.kv/list"],
    }]);

    const result = await listOperation.execute(context(node), {});
    expect(result).toEqual({
      status: "ok",
      output: {
        space: SPACE("applications"),
        count: 2,
        truncated: false,
        registry: "not_granted",
        apps: [
          {
            app_id: "xyz.tinycloud.health",
            root: "xyz.tinycloud.health/knowledge/",
            has_index: true,
            concepts: ["app.md", "log.md", "tables/meal.md"],
            registered: false,
          },
          {
            app_id: "xyz.tinycloud.recipes",
            root: "xyz.tinycloud.recipes/knowledge/",
            has_index: true,
            concepts: ["app.md"],
            registered: false,
          },
        ],
      },
    });
    if (result.status !== "ok") throw new Error("unreachable");
    expect(listOperation.output.safeParse(result.output).success).toBe(true);
    // Listing reads no values: names only.
    expect(calls.every((call) => call.method === "list")).toBe(true);
  });

  test("merges the account registry only when the session already holds it", async () => {
    const accountKeys: readonly Entry[] = [
      ["applications/xyz.tinycloud.health", JSON.stringify({ app_id: "xyz.tinycloud.health", manifests: [{ app_id: "xyz.tinycloud.health", name: "TinyHealth" }] })],
      ["applications/xyz.tinycloud.notes", JSON.stringify({ app_id: "xyz.tinycloud.notes", manifests: [{ app_id: "xyz.tinycloud.notes", name: "Notes" }] })],
    ];
    const { node } = fakeNode({ ...bundles, account: accountKeys });
    const result = await listOperation.execute(context(node, registryGrant), {});

    expect(result).toMatchObject({ status: "ok", output: { registry: "merged", count: 3 } });
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.output.apps.map(({ app_id, name, has_index, registered }) => ({ app_id, name, has_index, registered }))).toEqual([
      { app_id: "xyz.tinycloud.health", name: "TinyHealth", has_index: true, registered: true },
      { app_id: "xyz.tinycloud.notes", name: "Notes", has_index: false, registered: true },
      { app_id: "xyz.tinycloud.recipes", name: undefined, has_index: true, registered: false },
    ]);
  });

  test("app_id scopes the plan and the listing to that app's knowledge prefix and skips the registry", async () => {
    const { node, calls } = fakeNode(bundles);
    expect(await listOperation.authority(context(node), { app_id: "xyz.tinycloud.health" })).toEqual([{
      service: "tinycloud.kv",
      space: SPACE("applications"),
      path: "xyz.tinycloud.health/knowledge/",
      actions: ["tinycloud.kv/list"],
    }]);
    const result = await listOperation.execute(context(node, registryGrant), { app_id: "xyz.tinycloud.health" });
    expect(result).toMatchObject({
      status: "ok",
      output: { registry: "skipped", count: 1, apps: [{ app_id: "xyz.tinycloud.health", concepts: ["app.md", "log.md", "tables/meal.md"] }] },
    });
    expect(calls).toEqual([{
      space: SPACE("applications"),
      method: "list",
      value: { prefix: "xyz.tinycloud.health/knowledge/", limit: 1000 },
    }]);
  });

  test("follows the listing cursor across pages and marks a listing it cannot finish as truncated", async () => {
    const many: Entry[] = Array.from({ length: 25 }, (_, index) =>
      [`app.n${String(index).padStart(2, "0")}/knowledge/index.md`, "# x"]);
    const paged = await listOperation.execute(context(fakeNode({ applications: many }, 10).node), {});
    expect(paged).toMatchObject({ status: "ok", output: { count: 25, truncated: false } });

    const huge: Entry[] = Array.from({ length: 10 * 3 + 1 }, (_, index) =>
      [`app.n${String(index).padStart(3, "0")}/knowledge/index.md`, "# x"]);
    const capped = await listOperation.execute(context(fakeNode({ applications: huge }, 3).node), {});
    expect(capped).toMatchObject({ status: "ok", output: { count: 30, truncated: true } });
  });

  test("rejects app ids that could escape their prefix", () => {
    for (const app_id of ["", "../x", "a/b", ".hidden", "a b"]) {
      expect(listOperation.input.safeParse({ app_id }).success).toBe(false);
    }
  });
});

describe("tinycloud.knowledge.read@1", () => {
  test("reads the index with its local links, and a concept with its frontmatter parsed", async () => {
    const { node } = fakeNode(bundles);
    expect(await readOperation.authority(context(node), { app_id: "xyz.tinycloud.health" })).toEqual([{
      service: "tinycloud.kv",
      space: SPACE("applications"),
      path: "xyz.tinycloud.health/knowledge/index.md",
      actions: ["tinycloud.kv/get"],
    }]);

    const index = await readOperation.execute(context(node), { app_id: "xyz.tinycloud.health" });
    expect(index).toMatchObject({
      status: "ok",
      output: {
        path: "index.md",
        kind: "index",
        key: "xyz.tinycloud.health/knowledge/index.md",
        frontmatter: { okf_version: "0.2" },
        links: [
          { title: "app", target: "app.md" },
          { title: "meal", target: "tables/meal.md" },
        ],
        etag: '"etag-1"',
      },
    });

    // The `.md` extension is optional on a concept name.
    expect(await readOperation.authority(context(node), { app_id: "xyz.tinycloud.health", concept: "tables/meal" })).toMatchObject([
      { path: "xyz.tinycloud.health/knowledge/tables/meal.md" },
    ]);
    const concept = await readOperation.execute(context(node), { app_id: "xyz.tinycloud.health", concept: "tables/meal" });
    expect(concept).toMatchObject({
      status: "ok",
      output: {
        path: "tables/meal.md",
        kind: "concept",
        frontmatter: {
          type: "SQLite Table",
          resource: "tinycloud.sql:applications:xyz.tinycloud.health/health_log",
          table: "meal",
        },
        body: "# meal",
        links: [],
      },
    });
    if (concept.status !== "ok") throw new Error("unreachable");
    expect(readOperation.output.safeParse(concept.output).success).toBe(true);
  });

  test("a missing file is KV_NOT_FOUND", async () => {
    const { node } = fakeNode(bundles);
    expect(await readOperation.execute(context(node), { app_id: "xyz.tinycloud.health", concept: "nope.md" }))
      .toMatchObject({ status: "error", error: { code: "KV_NOT_FOUND" } });
  });

  test("rejects concept paths that leave the bundle", () => {
    for (const concept of ["../app/app.jsx", "/abs.md", "a//b.md", "a/./b.md", "a\\b.md", "*.md"]) {
      expect(readOperation.input.safeParse({ app_id: "xyz.tinycloud.health", concept }).success).toBe(false);
    }
  });
});
