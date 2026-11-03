import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OperationDefinition, RuntimeOperationContext } from "../contract.js";
import { withTinyCloudStateRoot } from "../state.js";
import { TC_APPS_LEGACY_ROOT as R } from "../tc-apps.js";
import { appsTimezone } from "../tc-apps/state.js";
import type { AppsKv, KvResult, KvValue } from "../tc-apps/kv.js";
import { COPY_DELETE, COPY_INSERT, type AppsDatabase, type CopyRow } from "../tc-apps/copy.js";
import { appsOperationDefinitions, type ContextOutput, type MoveOutput, type ReadOutput, type WriteOutput, type QueryOutput } from "./apps.js";

export const SPACE = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
export const NEW_SPACE = SPACE.replace(/:default$/, ":applications");
export const app = { app: "fitness", title: "Fitness", about: "Health", created: "2026-10-14" };
export const kind = { app: "fitness", kind: "weight", about: "Body weight", shape: "log", per: "day", v: 1, fields: { kg: "number" }, created: "2026-10-14" };
export const itemKind = { ...kind, kind: "goal", shape: "item", per: undefined, states: ["open", "done"] };
export const key = `${R}fitness/weight/2026-10/2026-10-14`;
type Outputs = { context: ContextOutput; read: ReadOutput; write: WriteOutput; query: QueryOutput; move: MoveOutput };
export function definition<N extends keyof Outputs>(name: N) {
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
export function etag(number: number): string { return `"blake3-${number.toString(16).padStart(64, "0")}"`; }
export function failure(code: string): KvResult<KvValue> { return { ok: false, error: { code } }; }
export class FakeKv implements AppsKv {
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
/** `kv` is the older layout's default space; `applications` is the new layout's space. */
export async function fixture(run: (kv: FakeKv, context: RuntimeOperationContext, applications: FakeKv) => Promise<void>, timezone: string | null = "Europe/Berlin") {
  const root = await mkdtemp(join(tmpdir(), "tc-apps-test-"));
  try {
    await withTinyCloudStateRoot(root, async () => {
      const kv = new FakeKv();
      const applications = new FakeKv();
      kv.seed(`${R}catalog/fitness`, app);
      kv.seed(`${R}catalog/fitness/weight`, kind);
      const context: RuntimeOperationContext = {
        summary: { profile: "apps", host: "https://node.example", posture: "delegate-session", space: SPACE },
        runtime: { granted: [], node: { kvForSpace: (space: string) => {
          if (space === SPACE) return kv;
          if (space === NEW_SPACE) return applications;
          throw new Error(`Unexpected space ${space}`);
        } } },
      };
      if (timezone) await appsTimezone("apps", timezone);
      await run(kv, context, applications);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
export async function write(context: RuntimeOperationContext, ops: unknown[]) {
  const result = await definition("write").execute(context, { ops });
  if (result.status === "ok") expect(definition("write").output.safeParse(result.output).success).toBe(true);
  return result;
}

export class FakeSql {
  readonly rows = new Map<string, unknown>();
  readonly calls: { sql: string; params: unknown[] }[] = [];
  table = true;
  view = true;
  failures: { code: string; message?: string; meta?: { status: number } }[] = [];
  afterInsert?: () => void;
  // The fake implements only the query/execute surface exercised by the copy.
  readonly databases: string[] = [];
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
/** Grant the copy's SQL permission(s) (or none) and record which database the operation opens. */
export function withSql(context: RuntimeOperationContext, sql: FakeSql, granted: boolean | { space: string; path: string } | { space: string; path: string }[] = true): RuntimeOperationContext {
  const grants = granted === true ? [{ space: SPACE, path: "xyz.tinycloud.agent-data.index" }] : granted === false ? [] : Array.isArray(granted) ? granted : [granted];
  return { ...context, runtime: { ...context.runtime,
    granted: grants.map((grant) => ({ service: "tinycloud.sql", space: grant.space, path: grant.path, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] })),
    node: { ...context.runtime.node as object, sqlForSpace: () => ({ db: (name: string) => { sql.databases.push(name); return sql.handle(); } }) },
  } };
}
export function withGrants(context: RuntimeOperationContext, granted: unknown[]): RuntimeOperationContext {
  return { ...context, runtime: { ...context.runtime, granted } as RuntimeOperationContext["runtime"] };
}
/** The grant an owner who approved the older layout still holds. */
export const LEGACY_ROOT_GRANT = { service: "tinycloud.kv", space: SPACE, path: R, actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"] };
