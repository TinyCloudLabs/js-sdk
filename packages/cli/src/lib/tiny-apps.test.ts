import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertTinyAppName,
  initTinyApp,
  localDate,
  planTinyAppInit,
  recordBytes,
  slugify,
  TinyAppInputError,
  tinyAppManifest,
  tinyAppProfile,
  tinyAppTitle,
  utcStamp,
  type TinyAppKvPort,
} from "./tiny-apps.js";
import { tinyAppKvPort } from "../commands/apps.js";

const SKILL = readFileSync(join(import.meta.dir, "../../skills/tc-apps/SKILL.md"), "utf8");
const NOW = new Date("2026-10-27T09:05:07.123Z");

/** The request SKILL.md §4a writes with printf, for one app. */
function skillManifest(app: string, title: string): unknown {
  const line = /printf '%s\\n' '(\{"manifest_version":1.*?\})' > "\$STATE\/tinyapp-<APP>\.json"/.exec(SKILL);
  expect(line).not.toBeNull();
  return JSON.parse(line![1]!.replaceAll("<APP>", app).replaceAll("<Title>", title));
}

describe("tc-apps layout", () => {
  test("the sign-in request is the one SKILL.md §4a writes", () => {
    expect(tinyAppManifest("todos", "Todos")).toEqual(skillManifest("todos", "Todos") as Record<string, unknown>);
    expect(tinyAppManifest("fitness", "Fitness")).toEqual(skillManifest("fitness", "Fitness") as Record<string, unknown>);
    expect(SKILL).toContain('--profile tinyapp-<APP> auth login --method openkey --paste --manifest "$STATE/tinyapp-<APP>.json" --expiry 30d');
    expect(tinyAppProfile("todos")).toBe("tinyapp-todos");
  });

  test("app names follow the skill: lowercase, a letter first, reserved names refused", () => {
    expect(assertTinyAppName("book-club2")).toBe("book-club2");
    for (const bad of ["Todos", "2do", "to do", "todos/", "", "catalog", "index-stale", "healthlog", "recipes"]) {
      expect(() => assertTinyAppName(bad)).toThrow(TinyAppInputError);
    }
    expect(tinyAppTitle("todos")).toBe("Todos");
    expect(tinyAppTitle("books", "Book Club")).toBe("Book Club");
    expect(() => tinyAppTitle("books")).toThrow("--title is required");
    expect(() => tinyAppTitle("books", "Books!")).toThrow("letters, digits and spaces");
  });

  test("slugs and clock stamps", () => {
    expect(slugify("Try my personal apps")).toBe("try-my-personal-apps");
    expect(slugify("  Renew passport — by Friday!  ")).toBe("renew-passport-by-friday");
    expect(() => slugify("!!!")).toThrow(TinyAppInputError);
    expect(slugify("a".repeat(80))).toHaveLength(60);
    expect(utcStamp(NOW)).toBe("2026-10-27T09:05:07Z");
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  // The records the /apps guide (prompts setup/tc-apps.md, "For the agent") documents for a setup-only request.
  test("apps init todos writes the guide's keys and record shapes, catalog first", () => {
    const plan = planTinyAppInit({ app: "todos", by: "claude-code", starter: "Try my personal apps", now: NOW });
    const today = localDate(NOW);
    expect(plan.records.map((record) => [record.role, record.key, JSON.stringify(record.value)])).toEqual([
      ["app", "xyz.tinycloud.tinyapps.todos/catalog", `{"app":"todos","title":"Todos","about":"Things to do.","created":"${today}","by":"claude-code"}`],
      ["kind", "xyz.tinycloud.tinyapps.todos/catalog/todo", '{"app":"todos","kind":"todo","about":"One record per thing to do.","shape":"item","states":["open","done"],"v":1,"fields":{"title":"text: what to do"}}'],
      ["entry", "xyz.tinycloud.tinyapps.catalog/todos/entry", '{"v":1,"app":"todos","id":"xyz.tinycloud.tinyapps.todos","title":"Todos"}'],
      ["starter", "xyz.tinycloud.tinyapps.todos/todo/open/try-my-personal-apps", '{"v":1,"at":"2026-10-27T09:05:07Z","data":{"title":"Try my personal apps"},"by":"claude-code"}'],
    ]);
    expect(plan.starterTwins).toEqual(["xyz.tinycloud.tinyapps.todos/todo/done/try-my-personal-apps"]);
    // Every key stays in the app's folder or its own discovery entry: exactly what its approval covers.
    const manifest = tinyAppManifest("todos", "Todos") as { permissions: Array<{ path: string; actions: string[] }> };
    const writable = manifest.permissions.filter((entry) => entry.actions.includes("put")).map((entry) => entry.path);
    for (const record of plan.records) expect(writable.some((prefix) => record.key.startsWith(prefix))).toBe(true);
    expect(SKILL).toContain("`xyz.tinycloud.tinyapps.catalog/<APP>/entry`");
  });

  test("apps init validates its input", () => {
    expect(() => planTinyAppInit({ app: "fitness", by: "codex", now: NOW })).toThrow("No template");
    expect(() => planTinyAppInit({ app: "todos", by: "Claude Code", now: NOW })).toThrow(TinyAppInputError);
    expect(() => planTinyAppInit({ app: "todos", by: "codex", starter: "line\nbreak", now: NOW })).toThrow(TinyAppInputError);
    expect(planTinyAppInit({ app: "todos", by: "codex", now: NOW }).records.map((record) => record.role)).toEqual(["app", "kind", "entry"]);
  });

  test("a record is stored as the skill's heredoc stores it: one JSON line", () => {
    expect(new TextDecoder().decode(recordBytes({ v: 1, data: { title: "x" } }))).toBe('{"v":1,"data":{"title":"x"}}\n');
  });
});

/** An in-memory applications space. */
function fakeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const calls: string[] = [];
  const kv: TinyAppKvPort = {
    async get(key) {
      calls.push(`get ${key}`);
      return store.get(key);
    },
    async create(key, bytes) {
      calls.push(`create ${key}`);
      if (store.has(key)) return "exists";
      store.set(key, JSON.parse(new TextDecoder().decode(bytes)));
      return "created";
    },
  };
  return { kv, store, calls };
}

describe("initTinyApp", () => {
  const plan = () => planTinyAppInit({ app: "todos", by: "codex", starter: "Try my personal apps", now: NOW });

  test("a new app: every record created, in order, and read back", async () => {
    const { kv, store, calls } = fakeKv();
    const result = await initTinyApp(plan(), kv);
    expect(calls.filter((call) => call.startsWith("create"))).toEqual([
      "create xyz.tinycloud.tinyapps.todos/catalog",
      "create xyz.tinycloud.tinyapps.todos/catalog/todo",
      "create xyz.tinycloud.tinyapps.catalog/todos/entry",
      "create xyz.tinycloud.tinyapps.todos/todo/open/try-my-personal-apps",
    ]);
    expect(result.keys.map((key) => key.status)).toEqual(["created", "created", "created", "created"]);
    expect(result.keys[3]!.record).toEqual({ v: 1, at: "2026-10-27T09:05:07Z", data: { title: "Try my personal apps" }, by: "codex" });
    expect(store.size).toBe(4);
  });

  test("a rerun changes nothing", async () => {
    const { kv, store } = fakeKv();
    await initTinyApp(plan(), kv);
    const before = JSON.stringify([...store]);
    const again = await initTinyApp(planTinyAppInit({ app: "todos", by: "opencode", starter: "Try my personal apps", now: new Date() }), kv);
    expect(again.keys.map((key) => key.status)).toEqual(["exists", "exists", "exists", "exists"]);
    expect(JSON.stringify([...store])).toBe(before);
  });

  test("a starter the owner already ticked off is not saved again", async () => {
    const done = { v: 1, at: "2026-10-20T10:00:00Z", data: { title: "Try my personal apps" }, by: "codex", done: "2026-10-21" };
    const { kv, store, calls } = fakeKv({ "xyz.tinycloud.tinyapps.todos/todo/done/try-my-personal-apps": done });
    const result = await initTinyApp(plan(), kv);
    expect(result.keys[3]).toEqual({
      role: "starter",
      key: "xyz.tinycloud.tinyapps.todos/todo/open/try-my-personal-apps",
      status: "skipped",
      existingTwin: "xyz.tinycloud.tinyapps.todos/todo/done/try-my-personal-apps",
    });
    expect(calls).not.toContain("create xyz.tinycloud.tinyapps.todos/todo/open/try-my-personal-apps");
    expect(store.has("xyz.tinycloud.tinyapps.todos/todo/open/try-my-personal-apps")).toBe(false);
  });

  test("an existing catalog record written by another agent is left as it is", async () => {
    const theirs = { app: "todos", title: "My Todos", about: "Mine.", created: "2026-01-01", by: "claude-code" };
    const { kv, store } = fakeKv({ "xyz.tinycloud.tinyapps.todos/catalog": theirs });
    const result = await initTinyApp(plan(), kv);
    expect(result.keys[0]).toMatchObject({ status: "exists", record: theirs });
    expect(store.get("xyz.tinycloud.tinyapps.todos/catalog")).toEqual(theirs);
  });
});

describe("apps init KV port", () => {
  test("create-only puts, missing keys and refusals map like `kv put --if-none-match`", async () => {
    const puts: Array<{ key: string; value: Uint8Array; options: unknown }> = [];
    const port = tinyAppKvPort({
      async get(key) {
        if (key === "missing") return { ok: false, error: { code: "KV_NOT_FOUND" } };
        if (key === "denied") return { ok: false, error: { code: "PERMISSION_DENIED", message: "nope" } };
        return { ok: true, data: { data: { v: 1 } } };
      },
      async put(key, value, options) {
        puts.push({ key, value, options });
        if (key === "taken") return { ok: false, error: { code: "KV_PRECONDITION_FAILED" } };
        if (key === "full") return { ok: false, error: { code: "KV_WRITE_FAILED", message: "boom" } };
        return { ok: true, data: undefined };
      },
    }, "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications", "tinyapp-todos");
    expect(await port.get("missing")).toBeUndefined();
    expect(await port.get("present")).toEqual({ v: 1 });
    await expect(port.get("denied")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await port.create("new", recordBytes({ v: 1 }))).toBe("created");
    expect(await port.create("taken", recordBytes({ v: 1 }))).toBe("exists");
    await expect(port.create("full", recordBytes({ v: 1 }))).rejects.toMatchObject({ code: "KV_WRITE_FAILED" });
    expect(puts.every((put) => (put.options as { ifNoneMatch?: string }).ifNoneMatch === "*" && put.value instanceof Uint8Array)).toBe(true);
  });
});
