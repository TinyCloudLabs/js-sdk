import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OperationDefinition, RuntimeOperationContext } from "../contract.js";
import { additionalDelegationsPath, withTinyCloudStateRoot, writeJsonAtomic } from "../state.js";
import { TC_APPS_DATABASE, TC_APPS_ROOT as R, tcAppsApprovalMessage, tcAppsApprovalReason } from "../tc-apps.js";
import { appsNow, appsTimezone, withLocalOffset } from "../tc-apps/state.js";
import type { AppsKv, KvResult, KvValue } from "../tc-apps/kv.js";
import { appsOperationDefinitions, type ContextOutput, type ReadOutput, type WriteOutput, type QueryOutput } from "./apps.js";
import { checkCopyKinds, copyRowChunks, COPY_INSERT, COPY_DELETE, COPY_REQUEST_LIMIT, syncCopyRows, type AppsDatabase, type CopyRow } from "../tc-apps/copy.js";

const SPACE = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
const app = { app: "fitness", title: "Fitness", about: "Health", created: "2026-10-14" };
const kind = { app: "fitness", kind: "weight", about: "Body weight", shape: "log", per: "day", v: 1, fields: { kg: "number" }, created: "2026-10-14" };
const itemKind = { ...kind, kind: "goal", shape: "item", per: undefined, states: ["open", "done"] };
const key = `${R}fitness/weight/2026-10/2026-10-14`;
type Outputs = { context: ContextOutput; read: ReadOutput; write: WriteOutput; query: QueryOutput };
function definition<N extends keyof Outputs>(name: N) {
  const found = appsOperationDefinitions.find((entry) => entry.id === `tinycloud.apps.${name}`);
  if (!found) throw new Error(`Missing ${name}`);
  // The literal operation ID selects the corresponding input/output pair.
  const operation = found as unknown as OperationDefinition<unknown, Outputs[N]>;
  return {
    ...operation,
    async execute(context: RuntimeOperationContext, input: unknown) {
      const result = await operation.execute(context, input);
      return {
        status: result.status,
        get output() {
          if (result.status !== "ok") throw new Error(`Expected ok, got ${result.status}`);
          return result.output;
        },
        get error() {
          if (result.status !== "error") throw new Error(`Expected error, got ${result.status}`);
          return result.error;
        },
      };
    },
  };
}
function etag(number: number): string { return `"blake3-${number.toString(16).padStart(64, "0")}"`; }
function failure(code: string): KvResult<KvValue> { return { ok: false, error: { code } }; }
class FakeKv implements AppsKv {
  readonly values = new Map<string, { text: string; etag: string }>();
  readonly writes: { key: string; bytes: Uint8Array; options: { ifMatch?: string; ifNoneMatch?: "*" } }[] = [];
  readonly reads: string[][] = [];
  readonly lists: { prefix: string; limit: number; cursor?: string }[] = [];
  readonly deletes: { key: string; options: { ifMatch?: string } }[] = [];
  putFailure?: (key: string) => string | undefined;
  deleteFailure?: string;
  beforePut?: (key: string) => void;
  listPages?: string[][];
  pageSize = 1000;
  omitReadEtag = false;
  serial = 0;
  seed(key: string, value: unknown) {
    const entry = { text: JSON.stringify(value), etag: etag(++this.serial) };
    this.values.set(key, entry);
    return entry.etag;
  }
  async list(options: { prefix: string; limit: number; cursor?: string }) {
    this.lists.push(options);
    const page = Number(options.cursor ?? 0);
    const all = [...this.values.keys()].filter((key) => key.startsWith(options.prefix));
    const keys = this.listPages?.[page] ?? all.slice(page * this.pageSize, (page + 1) * this.pageSize);
    const more = this.listPages ? page + 1 < this.listPages.length : (page + 1) * this.pageSize < all.length;
    const nextCursor = more ? String(page + 1) : undefined;
    return { ok: true as const, data: { keys, nextCursor, truncated: nextCursor !== undefined } };
  }
  async batchGet(keys: string[]) {
    this.reads.push(keys);
    return { ok: true as const, data: { results: keys.map((key) => {
      const entry = this.values.get(key);
      return { key, result: entry ? { ok: true as const, data: { data: entry.text, headers: this.omitReadEtag ? {} : { etag: entry.etag } } } : failure("KV_NOT_FOUND") };
    }) } };
  }
  async put(key: string, bytes: Uint8Array, options: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<KvResult<KvValue>> {
    this.writes.push({ key, bytes, options });
    this.beforePut?.(key);
    const refused = this.putFailure?.(key);
    if (refused) return failure(refused);
    const current = this.values.get(key);
    if ((options.ifNoneMatch && current) || (options.ifMatch && current?.etag !== options.ifMatch)) return failure("KV_PRECONDITION_FAILED");
    const stored = { text: new TextDecoder().decode(bytes), etag: etag(++this.serial) };
    this.values.set(key, stored);
    return { ok: true, data: { data: undefined, headers: { etag: stored.etag } } };
  }
  async delete(key: string, options: { ifMatch?: string }): Promise<KvResult<KvValue>> {
    this.deletes.push({ key, options });
    if (this.deleteFailure) return failure(this.deleteFailure);
    const current = this.values.get(key);
    if (!current) return failure("KV_NOT_FOUND");
    if (options.ifMatch && options.ifMatch !== current.etag) return failure("KV_PRECONDITION_FAILED");
    this.values.delete(key);
    return { ok: true, data: { data: undefined, headers: {} } };
  }
}
async function fixture(run: (kv: FakeKv, context: RuntimeOperationContext) => Promise<void>, timezone: string | null = "Europe/Berlin") {
  const root = await mkdtemp(join(tmpdir(), "tc-apps-test-"));
  try {
    await withTinyCloudStateRoot(root, async () => {
      const kv = new FakeKv();
      kv.seed(`${R}catalog/fitness`, app);
      kv.seed(`${R}catalog/fitness/weight`, kind);
      const context: RuntimeOperationContext = {
        summary: { profile: "apps", host: "https://node.example", posture: "delegate-session", space: SPACE },
        runtime: { granted: [], node: { kvForSpace: (space: string) => { expect(space).toBe(SPACE); return kv; } } },
      };
      if (timezone) await appsTimezone("apps", timezone);
      await run(kv, context);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function write(context: RuntimeOperationContext, ops: unknown[]) {
  const result = await definition("write").execute(context, { ops });
  if (result.status === "ok") expect(definition("write").output.safeParse(result.output).success).toBe(true);
  return result;
}

describe("personal apps records", () => {
  test("every operation requests one full records-prefix grant, and approval text matches only its exact scopes", async () => {
    await fixture(async (_kv, context) => {
      for (const name of ["context", "read", "write"] as const) {
        const permissions = await definition(name).authority(context, {});
        expect(permissions).toEqual([{ service: "tinycloud.kv", space: SPACE, path: R, actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"] }]);
        expect(tcAppsApprovalReason(permissions)).toContain("30 days");
        expect(tcAppsApprovalMessage(permissions)).toContain("OpenKey");
        expect(tcAppsApprovalReason([{ ...permissions[0], path: `${R}fitness/` }])).toBeUndefined();
        expect(tcAppsApprovalReason([{ ...permissions[0], actions: ["tinycloud.kv/metadata"] }])).toBeUndefined();
        expect(tcAppsApprovalReason([{ ...permissions[0], space: "other" }])).toBeUndefined();
      }
    });
  });
  test("context returns records rules, persists a tenant-local timezone, and reads catalog only through forty keys", async () => {
    await fixture(async (kv, context) => {
      const first = await definition("context").execute(context, {});
      expect(first.output.timezone).toBeNull();
      expect(first.output.now).toMatch(/\+00:00$/);
      expect(first.output.catalog.records).toHaveLength(2);
      expect(first.output.copy).toBe("none");
      const zoned = await definition("context").execute(context, { timezone: "America/New_York" });
      expect(zoned.output.timezone).toBe("America/New_York");
      expect(await appsTimezone("apps")).toBe("America/New_York");
      expect(await appsTimezone("another")).toBeNull();
      expect((await definition("context").execute(context, { timezone: "not/a-zone" })).error.code).toBe("INPUT_INVALID");
      const permissions = [{ service: "tinycloud.sql", space: SPACE, path: TC_APPS_DATABASE, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] }];
      await writeJsonAtomic(additionalDelegationsPath("apps"), [{ permissions, delegation: { expiry: "2000-01-01T00:00:00Z" } }]);
      expect((await definition("context").execute(context, {})).output.copy).toBe("expired");
      await writeJsonAtomic(additionalDelegationsPath("apps"), [{ permissions, delegation: { expiry: "2999-01-01T00:00:00Z" } }]);
      expect((await definition("context").execute(context, {})).output.copy).toBe("present");
      kv.listPages = [Array.from({ length: 41 }, (_, i) => `${R}catalog/app-${i}`)];
      const reads = kv.reads.length;
      expect((await definition("context").execute(context, {})).output.catalog.records).toBeUndefined();
      expect(kv.reads.length).toBe(reads);
    }, null);
  });
  test("local dates get the offset on that date, not the current season", () => {
    expect(withLocalOffset("2026-01-14T12:00", "Europe/Berlin")).toBe("2026-01-14T12:00+01:00");
    expect(withLocalOffset("2026-07-14T12:00", "Europe/Berlin")).toBe("2026-07-14T12:00+02:00");
    expect(withLocalOffset("2026-01-14", "Europe/Berlin")).toBe("2026-01-14");
    expect(appsNow("Asia/Kolkata", new Date("2026-01-14T12:00:00Z"))).toBe("2026-01-14T17:30+05:30");
  });
  test("reads CLI-format strings as objects, reports malformed/missing records, and follows list cursors", async () => {
    await fixture(async (kv, context) => {
      kv.seed(key, { v: 1, data: { kg: 70 }, at: "2026-10-14", by: "codex" });
      const malformed = `${R}fitness/weight/2026-10/2026-10-13`;
      kv.seed(malformed, [1]);
      kv.listPages = [[key], [malformed]];
      const result = await definition("read").execute(context, { prefixes: [`${R}fitness/weight/`], keys: [key, malformed, `${R}fitness/weight/2026-10/2026-10-12`] });
      expect(result.output.lists[0].keys).toEqual([key, malformed]);
      expect(kv.lists).toEqual([{ prefix: `${R}fitness/weight/`, limit: 1000 }, { prefix: `${R}fitness/weight/`, limit: 1000, cursor: "1" }]);
      expect(result.output.records).toMatchObject([{ key, value: { data: { kg: 70 } } }, { key: malformed, outcome: "MALFORMED" }, { outcome: "NOT_FOUND" }]);
      expect(kv.reads).toHaveLength(1);
      expect((await definition("read").execute(context, { keys: Array(101).fill(key) })).error.code).toBe("INPUT_INVALID");
    });
  });
  test("validates every op before any effects", async () => {
    await fixture(async (kv, context) => {
      for (const bad of [
        { op: "put", key: `${R}fitness/weight/2026-10/a?b`, value: { data: {} } },
        { op: "put", key: `${R}fitness/weight/../bad`, value: { data: {} } },
        { op: "put", key, value: { data: [] } },
        { op: "put", key, value: { data: {}, by: "client" } },
        { op: "put", key: `${R}catalog/fitness/weight`, value: { ...kind, app: "other" } },
        { op: "delete", key: `${R}catalog/fitness` },
        { op: "put", key: `${R}index-stale/fitness/weight`, value: {} },
      ]) {
        const result = await write(context, [{ op: "put", key, value: { data: { kg: 70 } } }, bad]);
        expect(result.error.code).toBe("INPUT_INVALID");
      }
      expect(kv.writes).toEqual([]);
      expect(kv.reads).toEqual([]);
    });
  });
  test("writes app, kind and first record sequentially as CLI-identical bytes, defaults metadata and marks the kind stale", async () => {
    await fixture(async (kv, context) => {
      kv.values.clear();
      const result = await write(context, [
        { op: "put", key: `${R}catalog/fitness`, value: app },
        { op: "put", key: `${R}catalog/fitness/weight`, value: kind },
        { op: "put", key, value: { at: "2026-10-14T12:30", data: { kg: 70 } } },
      ]);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "ok", "ok"]);
      const stored = result.output.ops[2].value;
      expect(stored).toEqual({ by: "tinycloud-mcp", v: 1, at: "2026-10-14T12:30+02:00", data: { kg: 70 } });
      expect(kv.writes[2]!.bytes).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(kv.writes[2]!.bytes)).toBe(JSON.stringify(stored));
      expect(kv.values.has(`${R}index-stale/fitness/weight`)).toBe(true);
      const marker = JSON.parse(kv.values.get(`${R}index-stale/fitness/weight`)!.text);
      expect(marker).toEqual({ since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), by: "tinycloud-mcp" });
      expect(kv.reads.flat()).not.toContain(key);
    });
  });
  test("timezone is required for record ops but not catalog ops", async () => {
    await fixture(async (_kv, context) => {
      const result = await write(context, [{ op: "put", key: `${R}catalog/books`, value: { ...app, app: "books" } }, { op: "put", key, value: { data: {} } }, { op: "delete", key }]);
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "TIMEZONE_REQUIRED", "TIMEZONE_REQUIRED"]);
    }, null);
  });
  test("warns about unknown fields and date slips rather than refusing them", async () => {
    await fixture(async (_kv, context) => {
      const result = await write(context, [{ op: "put", key, value: { at: "2026-10-13", data: { "Odd-field": 1, due: "October", done: "2026-10-14" } } }]);
      expect(result.output.ops[0].outcome).toBe("ok");
      expect(result.output.ops[0].warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("Odd-field"), expect.stringContaining("due"), expect.stringContaining("at"),
      ]));
    });
  });
  test("only timed creates suffix after 412; other creates expose EXISTS and replacements expose CHANGED", async () => {
    await fixture(async (kv, context) => {
      const original = kv.seed(key, { v: 1, data: { kg: 69 } });
      const result = await write(context, [{ op: "put", key, value: { data: { kg: 70 } } }]);
      expect(result.output.ops[0]).toMatchObject({ outcome: "EXISTS", etag: original, value: { data: { kg: 69 } } });
      kv.seed(`${R}catalog/fitness/session`, { ...kind, kind: "session", per: "time" });
      const timed = `${R}fitness/session/2026-10/2026-10-14T1200-run`;
      kv.seed(timed, {});
      const suffixed = await write(context, [{ op: "put", key: timed, value: { data: {} } }]);
      expect(suffixed.output.ops[0]).toMatchObject({ outcome: "ok", key: `${timed}-2` });
      kv.beforePut = (writing) => { if (writing === key) { kv.beforePut = undefined; kv.seed(key, { data: { kg: 68 } }); } };
      const race = await write(context, [{ op: "put", key, etag: original, value: { data: { kg: 71 } } }]);
      expect(race.output.ops[0]).toMatchObject({ outcome: "CHANGED", value: { data: { kg: 68 } } });
      expect(kv.writes.find((entry) => entry.options.ifMatch === original)?.options).toEqual({ ifMatch: original });
    });
  });
  test("catalog guard preserves field meanings and states ordering unless version rises with history", async () => {
    await fixture(async (kv, context) => {
      const catalogKey = `${R}catalog/fitness/goal`;
      const original = kv.seed(catalogKey, itemKind);
      const clean = JSON.parse(JSON.stringify(itemKind));
      for (const value of [{ ...clean, fields: {} }, { ...clean, fields: { kg: "pounds" } }, { ...clean, states: ["done", "open"] }, { ...clean, shape: "log", per: "day" }]) {
        const result = await write(context, [{ op: "put", key: catalogKey, etag: original, value }]);
        expect(result.output.ops[0]).toMatchObject({ outcome: "CATALOG_CHANGE", etag: original });
      }
      const extended = await write(context, [{ op: "put", key: catalogKey, etag: original, value: { ...clean, states: ["open", "waiting", "done"], fields: { kg: "number", note: "text" } } }]);
      expect(extended.output.ops[0].outcome).toBe("ok");
      const changed = await write(context, [{ op: "put", key: catalogKey, etag: extended.output.ops[0].etag, value: { ...clean, v: 2, shape: "log", per: "time", history: "v1 was an item", fields: {} } }]);
      expect(changed.output.ops[0].outcome).toBe("ok");
    });
  });
  test("existing records may be edited, moved and deleted regardless of current kind shape", async () => {
    await fixture(async (kv, context) => {
      const legacy = `${R}fitness/weight/old-state/legacy`;
      const etag = kv.seed(legacy, { v: 1, data: {} });
      const edited = await write(context, [{ op: "put", key: legacy, etag, value: { data: { kg: 70 } } }]);
      expect(edited.output.ops[0].outcome).toBe("ok");
      const to = `${R}fitness/weight/another-state/legacy`;
      const moved = await write(context, [{ op: "move", from: legacy, to, etag: edited.output.ops[0].etag, value: { data: { kg: 70 } } }]);
      expect(moved.output.ops[0]).toMatchObject({ outcome: "ok", steps: ["written", "deleted"] });
      expect(kv.values.has(legacy)).toBe(false);
      expect((await write(context, [{ op: "delete", key: to, etag: moved.output.ops[0].etag }])).output.ops[0].outcome).toBe("ok");
    });
  });
  test("moves stop before deletion when destination exists, and expose committed destination when source changed or deletion fails", async () => {
    await fixture(async (kv, context) => {
      const from = `${R}fitness/weight/open/legacy`;
      const to = `${R}fitness/weight/done/legacy`;
      const sourceEtag = kv.seed(from, { data: {} });
      kv.seed(to, { data: { kg: 2 } });
      const op = { op: "move", from, to, etag: sourceEtag, value: { data: { kg: 1 } } };
      expect((await write(context, [op])).output.ops[0]).toMatchObject({ outcome: "EXISTS", steps: [] });
      expect(kv.deletes).toEqual([]);
      kv.values.delete(to);
      kv.seed(from, { data: { kg: 3 } });
      const raced = await write(context, [op]);
      expect(raced.output.ops[0]).toMatchObject({ outcome: "CHANGED", steps: ["written"], value: { data: { kg: 1 } } });
      expect(kv.values.has(from)).toBe(true);
      expect(kv.values.has(to)).toBe(true);
      kv.values.delete(to);
      kv.deleteFailure = "AUTH_REQUIRED";
      const refused = await write(context, [op]);
      expect(refused.status).toBe("ok");
      expect(refused.output.ops[0]).toMatchObject({ outcome: "AUTH_REQUIRED", steps: ["written"] });
      expect(kv.values.has(`${R}index-stale/fitness/weight`)).toBe(true);
    });
  });
  test("node refusals and stale-mark failure never hide previous effects", async () => {
    await fixture(async (kv, context) => {
      const second = `${R}fitness/weight/2026-10/2026-10-15`;
      kv.putFailure = (key) => key === second ? "PERMISSION_DENIED" : key.includes("index-stale/") ? "AUTH_REQUIRED" : undefined;
      const result = await write(context, [{ op: "put", key, value: { data: {} } }, { op: "put", key: second, value: { data: {} } }]);
      expect(result.status).toBe("ok");
      expect(result.output.ops.map((op) => op.outcome)).toEqual(["ok", "PERMISSION_DENIED"]);
      expect(result.output.ops[0].warnings).toEqual(expect.arrayContaining([expect.stringContaining("AUTH_REQUIRED")]));
      expect(kv.values.has(key)).toBe(true);
    });
  });
  test("new records require catalogs and fit log frequency, month and item states", async () => {
    await fixture(async (kv, context) => {
      const invalid = await write(context, [
        { op: "put", key: `${R}unknown/weight/2026-10/2026-10-14`, value: { data: {} } },
        { op: "put", key: `${R}fitness/weight/2026-11/2026-10-14`, value: { data: {} } },
        { op: "put", key: `${R}fitness/weight/2026-10/2026-10-14T1200-weight`, value: { data: {} } },
      ]);
      expect(invalid.output.ops.map((op) => op.outcome)).toEqual(["INVALID", "INVALID", "INVALID"]);
      expect(kv.writes).toEqual([]);
      kv.seed(`${R}catalog/fitness/goal`, itemKind);
      const state = await write(context, [{ op: "put", key: `${R}fitness/goal/unknown/2026-10-14-weight`, value: { data: {} } }]);
      expect(state.output.ops[0].outcome).toBe("INVALID");
      const allowed = await write(context, [{ op: "put", key: `${R}fitness/goal/open/2026-10-14-weight`, value: { data: {} } }]);
      expect(allowed.output.ops[0].outcome).toBe("ok");
    });
  });
  test("destination refusal preserves a move source, and a thrown delete preserves completed steps", async () => {
    await fixture(async (kv, context) => {
      const from = `${R}fitness/weight/open/legacy`;
      const to = `${R}fitness/weight/done/legacy`;
      const original = kv.seed(from, { data: {} });
      const op = { op: "move", from, to, etag: original, value: { data: {} } };
      kv.putFailure = (key) => key === to ? "AUTH_REQUIRED" : undefined;
      const refused = await write(context, [op]);
      expect(refused.output.ops[0]).toMatchObject({ outcome: "AUTH_REQUIRED", steps: [] });
      expect(kv.deletes).toEqual([]);
      expect(kv.values.has(from)).toBe(true);
      kv.putFailure = undefined;
      kv.delete = async () => { throw new Error("connection lost"); };
      const interrupted = await write(context, [op]);
      expect(interrupted.output.ops[0]).toMatchObject({ outcome: "NODE_ERROR", steps: ["written"] });
      expect(kv.values.has(from)).toBe(true);
      expect(kv.values.has(to)).toBe(true);
    });
  });
  test("read and context refuse successful objects without an ETag", async () => {
    await fixture(async (kv, context) => {
      kv.seed(key, { v: 1, at: "2026-10-14", data: { kg: 70 } });
      kv.omitReadEtag = true;
      expect((await definition("read").execute(context, { keys: [key] })).error.code).toBe("NODE_ERROR");
      expect((await definition("context").execute(context, {})).error.code).toBe("NODE_ERROR");
    });
  });
});

class FakeSql {
  readonly rows = new Map<string, unknown>();
  readonly calls: { sql: string; params: unknown[] }[] = [];
  table = true;
  view = true;
  failures: { code: string; message?: string; meta?: { status: number } }[] = [];
  afterInsert?: () => void;
  // The fake implements only the query/execute surface exercised by the copy.
  handle(): AppsDatabase { return this as unknown as AppsDatabase; }
  async execute(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    const failure = this.failures.shift();
    if (failure) return { ok: false as const, error: failure };
    if (sql.startsWith("CREATE TABLE")) this.table = true;
    else if (sql.startsWith("CREATE VIEW")) this.view = true;
    else if (!this.table) return { ok: false as const, error: { code: "SQL_ERROR", message: "no such table: records", meta: { status: 400 } } };
    else if (sql === COPY_INSERT || sql === COPY_DELETE) {
      const rows = JSON.parse(String(params[0])) as CopyRow[];
      for (const row of rows) {
        if (sql === COPY_INSERT && row.r !== undefined) this.rows.set(row.k, row.r);
        if (sql === COPY_DELETE && row.r === undefined) this.rows.delete(row.k);
      }
      if (sql === COPY_INSERT) this.afterInsert?.();
    } else if (sql.startsWith("DELETE FROM records WHERE instr")) {
      for (const key of this.rows.keys()) if (key.startsWith(String(params[0]))) this.rows.delete(key);
    } else throw new Error(`Unexpected fake SQL: ${sql}`);
    return { ok: true as const, data: { changes: 1, lastInsertRowId: null } };
  }
  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    const failure = this.failures.shift();
    if (failure) return { ok: false as const, error: failure };
    if (!this.table || (!this.view && sql.includes("entries"))) return { ok: false as const, error: { code: "SQL_ERROR", message: "no such table: entries", meta: { status: 400 } } };
    if (sql.startsWith("SELECT count(*)")) {
      const count = [...this.rows.keys()].filter((key) => key.startsWith(String(params[0]))).length;
      return { ok: true as const, data: { columns: ["n"], rows: [[count]], rowCount: 1 } };
    }
    return { ok: true as const, data: { columns: ["answer"], rows: [[params[0] ?? 42]], rowCount: 1 } };
  }
}
function withSql(context: RuntimeOperationContext, sql: FakeSql, granted = true): RuntimeOperationContext {
  return { ...context, runtime: { ...context.runtime,
    granted: granted ? [{ service: "tinycloud.sql", space: SPACE, path: TC_APPS_DATABASE, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] }] : [],
    node: { ...context.runtime.node as object, sqlForSpace: () => ({ db: () => sql.handle() }) },
  } };
}
const weightKind = { app: "fitness", kind: "weight" };
const staleKey = `${R}index-stale/fitness/weight`;

describe("personal apps fast copy", () => {
  test("row encoding preserves objects, unicode and escaping; deletion removes only absent rows", async () => {
    const sql = new FakeSql();
    sql.rows.set("gone", { old: true });
    sql.rows.set("untouched", { retain: true });
    const value = { v: 1, data: { text: "雪\\\"\n", n: 3 } };
    await syncCopyRows(sql.handle(), [{ k: key, r: value }, { k: "gone" }]);
    expect(sql.rows.get(key)).toEqual(value);
    expect(sql.rows.has("gone")).toBe(false);
    expect(sql.rows.get("untouched")).toEqual({ retain: true });
  });
  test("chunks stay strictly below the escaped UTF-8 request boundary", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ k: `${key}-${i}`, r: { text: '雪"\\\n'.repeat(22000) } }));
    const chunks = copyRowChunks(rows);
    expect(chunks.flatMap((chunk) => JSON.parse(chunk))).toEqual(rows);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) for (const sql of [COPY_INSERT, COPY_DELETE]) {
      expect(Buffer.byteLength(JSON.stringify({ action: "execute", sql, params: [chunk] }))).toBeLessThan(COPY_REQUEST_LIMIT);
    }
    const small = [{ k: "a", r: { text: '雪"\\' } }];
    const exact = Buffer.byteLength(JSON.stringify({ action: "execute", sql: COPY_INSERT, params: [JSON.stringify(small)] }));
    expect(() => copyRowChunks(small, exact)).toThrow();
    expect(copyRowChunks(small, exact + 1)).toEqual([JSON.stringify(small)]);
  });
  test("a failed delete phase repeats both statements once, preserving the final rows", async () => {
    const sql = new FakeSql();
    sql.rows.set("gone", {});
    sql.afterInsert = () => {
      sql.afterInsert = undefined;
      sql.failures.push({ code: "NETWORK_ERROR" });
    };
    await syncCopyRows(sql.handle(), [{ k: key, r: { data: {} } }, { k: "gone" }]);
    expect(sql.calls.map((call) => call.sql)).toEqual([COPY_INSERT, COPY_DELETE, COPY_INSERT, COPY_DELETE]);
    expect([...sql.rows.keys()]).toEqual([key]);
  });
  test("writes sync the actual timed suffix and deleted keys only with active runtime authority", async () => {
    await fixture(async (kv, context) => {
      kv.seed(`${R}catalog/fitness/lift`, { ...kind, kind: "lift", per: "time" });
      const timed = `${R}fitness/lift/2026-10/2026-10-14T1200-bench`;
      kv.seed(timed, { v: 1, at: "2026-10-14", data: {} });
      const sql = new FakeSql();
      const active = withSql(context, sql);
      const result = await write(active, [{ op: "put", key: timed, value: { data: { kg: 60 } } }]);
      expect(result.output.ops[0]?.key).toBe(`${timed}-2`);
      expect(sql.rows.get(`${timed}-2`)).toEqual(result.output.ops[0]?.value);
      await write(active, [{ op: "delete", key: `${timed}-2` }]);
      expect(sql.rows.has(`${timed}-2`)).toBe(false);
      const calls = sql.calls.length;
      await write(withSql(context, sql, false), [{ op: "put", key, value: { data: { kg: 70 } } }]);
      expect(sql.calls.length).toBe(calls);
      expect(kv.values.has(staleKey)).toBe(true);
    });
  });
  test("partial moves retain both copies; completed moves remove only the source", async () => {
    await fixture(async (kv, context) => {
      kv.seed(`${R}catalog/fitness/goal`, itemKind);
      const from = `${R}fitness/goal/open/2026-10-14-goal`;
      const to = `${R}fitness/goal/done/2026-10-14-goal`;
      const source = { v: 1, at: "2026-10-14", data: { title: "goal" } };
      const etag = kv.seed(from, source);
      const sql = new FakeSql();
      kv.deleteFailure = "AUTH_UNAUTHORIZED";
      const partial = await write(withSql(context, sql), [{ op: "move", from, to, etag, value: source }]);
      expect(partial.output.ops[0]?.steps).toEqual(["written"]);
      expect(sql.rows.get(from)).toEqual(source);
      expect(sql.rows.get(to)).toEqual(partial.output.ops[0]?.value);
      kv.deleteFailure = undefined;
      const next = `${R}fitness/goal/done/2026-10-14-next`;
      const complete = await write(withSql(context, sql), [{ op: "move", from, to: next, etag, value: source }]);
      expect(complete.output.ops[0]?.steps).toEqual(["written", "deleted"]);
      expect(sql.rows.has(from)).toBe(false);
      expect(sql.rows.get(next)).toEqual(complete.output.ops[0]?.value);
    });
  });
  test("repeated sync refusal and missing schema preserve committed outcomes and mark kinds stale", async () => {
    for (const missing of [false, true]) await fixture(async (kv, context) => {
      const sql = new FakeSql();
      if (missing) sql.table = false;
      else sql.failures.push({ code: "AUTH_UNAUTHORIZED" }, { code: "AUTH_UNAUTHORIZED" });
      const result = await write(withSql(context, sql), [{ op: "put", key, value: { data: {} } }]);
      expect(result.output.ops[0]?.outcome).toBe("ok");
      expect(kv.values.has(key)).toBe(true);
      expect(kv.values.has(staleKey)).toBe(true);
      expect(sql.calls.length).toBe(missing ? 1 : 2);
    });
  });
  test("queries create missing schema, rebuild every listed key in batches of at most 100, and bind parameters", async () => {
    await fixture(async (kv, context) => {
      kv.pageSize = 73;
      const keys = Array.from({ length: 205 }, (_, i) => `${key}-${i}`);
      for (const key of keys) kv.seed(key, { v: 1, data: { kg: 72 } });
      const sql = new FakeSql();
      sql.table = false;
      sql.view = false;
      const result = await definition("query").execute(withSql(context, sql), { kinds: [weightKind], sql: "SELECT ? AS answer FROM entries", params: ["bound value"] });
      expect(result.output).toEqual({ kinds: [{ ...weightKind, records: 205 }], columns: ["answer"], rows: [["bound value"]], rowCount: 1 });
      expect([...sql.rows.keys()]).toEqual(keys);
      expect(kv.reads.every((batch) => batch.length <= 100)).toBe(true);
      expect(kv.values.has(staleKey)).toBe(false);
    });
  });
  test("equal counts skip rebuild only without a stale mark; mismatch deletes obsolete rows", async () => {
    await fixture(async (kv) => {
      const value = { data: { kg: 72 } };
      kv.seed(key, value);
      const sql = new FakeSql();
      sql.rows.set(key, { data: { kg: 60 } });
      expect(await checkCopyKinds(kv, sql.handle(), [weightKind])).toEqual({ kinds: [{ ...weightKind, records: 1 }] });
      expect(sql.rows.get(key)).toEqual({ data: { kg: 60 } });
      kv.seed(staleKey, { since: "2026-10-14" });
      await checkCopyKinds(kv, sql.handle(), [weightKind]);
      expect(sql.rows.get(key)).toEqual(value);
      sql.rows.set(`${key}-obsolete`, {});
      await checkCopyKinds(kv, sql.handle(), [weightKind]);
      expect([...sql.rows.keys()]).toEqual([key]);
      expect(kv.values.has(staleKey)).toBe(false);
    });
  });
  test("rebuild failures and concurrent stale marks never remove the stale marker", async () => {
    await fixture(async (kv) => {
      kv.seed(key, { data: {} });
      const sql = new FakeSql();
      sql.afterInsert = () => { kv.seed(staleKey, { since: "2026-10-15" }); };
      await expect(checkCopyKinds(kv, sql.handle(), [weightKind])).rejects.toThrow();
      expect(JSON.parse(kv.values.get(staleKey)!.text)).toEqual({ since: "2026-10-15" });
    });
  });
  test("an omitted or malformed listed value cannot produce a complete rebuild", async () => {
    await fixture(async (kv) => {
      kv.seed(key, "not a record object");
      const sql = new FakeSql();
      await expect(checkCopyKinds(kv, sql.handle(), [weightKind])).rejects.toThrow();
      expect(kv.values.has(staleKey)).toBe(true);
      expect(sql.rows.has(key)).toBe(false);
    });
  });
  test("a changing key set fails verification and leaves the kind stale", async () => {
    await fixture(async (kv) => {
      kv.seed(key, { data: {} });
      const sql = new FakeSql();
      sql.afterInsert = () => { kv.seed(`${key}-new`, { data: {} }); };
      await expect(checkCopyKinds(kv, sql.handle(), [weightKind])).rejects.toThrow();
      expect(kv.values.has(staleKey)).toBe(true);
    });
  });
  test("a missing view is recreated without discarding an already checked copy", async () => {
    await fixture(async (kv, context) => {
      const value = { data: { kg: 72 } };
      kv.seed(key, value);
      const sql = new FakeSql();
      sql.rows.set(key, value);
      sql.view = false;
      const result = await definition("query").execute(withSql(context, sql), { kinds: [weightKind], sql: "SELECT ? FROM entries", params: [72] });
      expect(result.output).toEqual({ kinds: [{ ...weightKind, records: 1 }], columns: ["answer"], rows: [[72]], rowCount: 1 });
      expect(sql.rows.get(key)).toEqual(value);
      expect(kv.writes).toEqual([]);
    });
  });
  test("finishes a started kind after sixty seconds but marks all unstarted kinds stale", async () => {
    await fixture(async (kv) => {
      kv.seed(key, { data: {} });
      const sql = new FakeSql();
      let now = 0;
      sql.afterInsert = () => { now = 60_000; };
      const remaining = [{ app: "fitness", kind: "lift" }, { app: "todos", kind: "todo" }];
      expect(await checkCopyKinds(kv, sql.handle(), [weightKind, ...remaining], () => now)).toEqual({ outcome: "COPY_PARTIAL", remaining });
      expect(sql.rows.has(key)).toBe(true);
      expect(kv.values.has(staleKey)).toBe(false);
      for (const kind of remaining) expect(kv.values.has(`${R}index-stale/${kind.app}/${kind.kind}`)).toBe(true);
      expect(sql.calls.filter((call) => call.sql.startsWith("SELECT count(*)")).map((call) => call.params[0])).toEqual([`${R}fitness/weight/`, `${R}fitness/weight/`]);
    });
  });
  test("rejects writes and multiple statements before touching storage; WITH reads are accepted", async () => {
    await fixture(async (_kv, context) => {
      const sql = new FakeSql();
      for (const statement of ["DELETE FROM records", "SELECT 1; SELECT 2", "PRAGMA table_info(records)", "WITH x AS (SELECT 1) DELETE FROM records"]) {
        const result = await definition("query").execute(withSql(context, sql), { kinds: [weightKind], sql: statement });
        expect(result.error.code).toBe("INPUT_INVALID");
      }
      expect(sql.calls).toEqual([]);
      expect((await definition("query").execute(withSql(context, sql), { kinds: [weightKind], sql: "WITH x AS (SELECT 1) SELECT * FROM x" })).status).toBe("ok");
    });
  });
  test("409 is nonretryable copy_unavailable, without an approval or retry loop", async () => {
    await fixture(async (kv, context) => {
      const sql = new FakeSql();
      sql.failures.push({ code: "NETWORK_ERROR", meta: { status: 409 } });
      const result = await definition("query").execute(withSql(context, sql), { kinds: [weightKind], sql: "SELECT 1" });
      expect(result.error.code).toBe("NODE_ERROR");
      expect(result.error.retryable).toBe(false);
      expect(result.error.details).toEqual({ reason: "copy_unavailable" });
      expect(sql.calls.length).toBe(1);
      sql.failures.push({ code: "NETWORK_ERROR", meta: { status: 409 } });
      const written = await write(withSql(context, sql), [{ op: "put", key, value: { data: {} } }]);
      expect(written.output.ops[0]?.outcome).toBe("ok");
      expect(sql.calls.length).toBe(2);
      expect(kv.values.has(staleKey)).toBe(true);
    });
  });
});
