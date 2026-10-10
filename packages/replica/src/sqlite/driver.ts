import { ReplicaError, ReplicaErrorCode } from "../errors.js";

export type SqlValue = string | number | null | Uint8Array;

/** The synchronous SQLite surface shared by `node:sqlite` and `bun:sqlite`. */
export interface SqliteDatabase {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): void;
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  close(): void;
}

type Statement = {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
};
type NativeDatabase = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };

export type SqliteOpenOptions = { readonly?: boolean };
export type SqliteOpener = (path: string, options?: SqliteOpenOptions) => SqliteDatabase;

function wrap(native: NativeDatabase): SqliteDatabase {
  const statements = new Map<string, Statement>();
  const prepared = (sql: string): Statement => {
    let statement = statements.get(sql);
    if (statement === undefined) {
      statement = native.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  return {
    exec: (sql) => native.exec(sql),
    run: (sql, ...params) => void prepared(sql).run(...params),
    // bun:sqlite answers a missing row with null, node:sqlite with undefined.
    get: <T>(sql: string, ...params: SqlValue[]) => (prepared(sql).get(...params) ?? undefined) as T | undefined,
    all: <T>(sql: string, ...params: SqlValue[]) => prepared(sql).all(...params) as T[],
    close: () => {
      statements.clear();
      native.close();
    },
  };
}

/** Node ≥ 22.13 ships `node:sqlite` without a flag. */
export function nodeSqliteSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

/**
 * Load the runtime's built-in SQLite: `bun:sqlite` under Bun, `node:sqlite`
 * on Node ≥ 22.13. No native addon. Specifiers are computed so bundlers keep
 * both modules external, and only SQLite's ExperimentalWarning is silenced.
 */
export async function loadSqlite(): Promise<SqliteOpener> {
  const runtime = globalThis as { Bun?: unknown; process?: NodeJS.Process };
  const load = (specifier: string): Promise<Record<string, unknown>> => import(specifier);
  if (runtime.Bun !== undefined) {
    const module = await load(["bun", "sqlite"].join(":"));
    const Database = module.Database as new (path: string, options: { create: boolean; readonly?: boolean }) => NativeDatabase;
    return (path, options) => wrap(new Database(path, { create: !options?.readonly, ...(options?.readonly ? { readonly: true } : {}) }));
  }
  const version = runtime.process?.versions?.node ?? "0.0.0";
  if (!nodeSqliteSupported(version)) {
    throw new ReplicaError(
      ReplicaErrorCode.RUNTIME_UNSUPPORTED,
      `tc replica needs Node.js 22.13 or newer (built-in SQLite); this is Node.js ${version}.`,
      { node: version },
    );
  }
  const process = runtime.process!;
  const emitWarning = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === "string" ? warning : warning.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning as Error).name;
    if (type === "ExperimentalWarning" && /SQLite/i.test(message)) return;
    return (emitWarning as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as NodeJS.Process["emitWarning"];
  let module: Record<string, unknown>;
  try {
    module = await load(["node", "sqlite"].join(":"));
  } finally {
    process.emitWarning = emitWarning;
  }
  const DatabaseSync = module.DatabaseSync as new (path: string, options?: { readOnly?: boolean }) => NativeDatabase;
  return (path, options) => wrap(options?.readonly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path));
}
