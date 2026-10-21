import { createHash } from "node:crypto";
import { pinnedApp, SHARE_ORIGIN, type PinnedApp, type PinnedFile } from "./apps-install-pin.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Largest file the installer accepts from Share. The Share bundle limit is 1 MB per file. */
export const MAX_FILE_BYTES = 1_000_000;

/** I/O seam. The command wires the SDK; tests wire fakes. */
export interface InstallIo {
  /** Bytes of one Share URL. Must refuse redirects and non-2xx responses. */
  fetchBytes(url: string): Promise<Uint8Array>;
  /** Current bytes of a KV key, or `undefined` when the key does not exist. */
  kvGet(key: string): Promise<Uint8Array | undefined>;
  /** Create-only write. `"exists"` when the key was already present. */
  kvCreate(key: string, bytes: Uint8Array): Promise<"created" | "exists">;
  /** Run one SQL statement against the app database. */
  sqlExecute(sql: string): Promise<void>;
  /** Names of all tables in the app database. */
  sqlTableNames(): Promise<string[]>;
}

export type InstallErrorCode =
  | "UNKNOWN_APP"
  | "FETCH_FAILED"
  | "INTEGRITY_FAILED"
  | "DDL_REFUSED"
  | "SQL_FAILED"
  | "KV_FAILED";

export class AppsInstallError extends Error {
  constructor(
    readonly code: InstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppsInstallError";
  }
}

export interface InstallResult {
  readonly appId: string;
  /** `installed`: at least one knowledge file was written. `already`: nothing was written. Conflicts never change the status. */
  readonly status: "installed" | "already";
  readonly database: string;
  readonly filesWritten: readonly string[];
  readonly filesUnchanged: readonly string[];
  /** Notes that differ from the pinned bytes. They were left as the user edited them. */
  readonly conflicts: readonly string[];
  readonly tablesCreated: readonly string[];
  readonly viewsRecreated: readonly string[];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

/** Fetch every pinned file and refuse the whole install unless every byte matches. */
export async function fetchVerified(app: PinnedApp, io: InstallIo): Promise<Map<string, Uint8Array>> {
  const verified = new Map<string, Uint8Array>();
  for (const file of app.files) {
    const url = `${SHARE_ORIGIN}/apps/b/${app.bundleDigest}/${file.path}`;
    let bytes: Uint8Array;
    try {
      bytes = await io.fetchBytes(url);
    } catch (error) {
      throw new AppsInstallError("FETCH_FAILED", `Could not fetch ${file.path}: ${errorMessage(error)}`);
    }
    verifyBytes(file, bytes);
    verified.set(file.path, bytes);
  }
  return verified;
}

function verifyBytes(file: PinnedFile, bytes: Uint8Array): void {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new AppsInstallError("INTEGRITY_FAILED", `${file.path} is ${bytes.length} bytes, above the ${MAX_FILE_BYTES} byte limit`);
  }
  if (bytes.length !== file.size || sha256Hex(bytes) !== file.sha256) {
    throw new AppsInstallError("INTEGRITY_FAILED", `${file.path} does not match the pinned sha256 and size`);
  }
}

/** Strip `--` line comments outside single-quoted strings, then split on `;`. */
export function splitStatements(sql: string): string[] {
  let stripped = "";
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote && ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      stripped += "\n";
      continue;
    }
    stripped += ch;
  }
  return stripped
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0);
}

const TABLE_FORM = /^CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*) \(.*\)$/i;
const INDEX_FORM = /^CREATE INDEX IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*) ON [A-Za-z_][A-Za-z0-9_]*\([A-Za-z_][A-Za-z0-9_, ]*\)$/i;
const VIEW_FORM = /^CREATE VIEW IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*) AS SELECT .+$/i;

export interface DdlPlan {
  readonly tables: readonly string[];
  readonly views: readonly string[];
  /** Statements in file order. View creates are preceded by their `DROP VIEW IF EXISTS`. */
  readonly statements: readonly string[];
}

/**
 * Accept only the three pinned forms (create-if-not-exists table, index, view).
 * The one extra form is `DROP VIEW IF EXISTS <view>`, generated here for pinned
 * view names only. Anything else, including DROP TABLE or DROP INDEX, is refused
 * before any statement runs.
 */
export function planDdl(schemaSql: string): DdlPlan {
  const tables: string[] = [];
  const views: string[] = [];
  const statements: string[] = [];
  for (const statement of splitStatements(schemaSql)) {
    const table = TABLE_FORM.exec(statement);
    const index = INDEX_FORM.exec(statement);
    const view = VIEW_FORM.exec(statement);
    if (table) {
      tables.push(table[1]!);
      statements.push(statement);
    } else if (index) {
      statements.push(statement);
    } else if (view) {
      views.push(view[1]!);
      statements.push(`DROP VIEW IF EXISTS ${view[1]}`, statement);
    } else {
      throw new AppsInstallError("DDL_REFUSED", `Pinned schema statement is not an allowed form: ${statement.slice(0, 80)}`);
    }
  }
  return { tables, views, statements };
}

/** Run the pinned DDL from a plan that already passed `planDdl`. Every statement is idempotent. */
export async function applySchema(plan: DdlPlan, io: InstallIo): Promise<{ tablesCreated: string[]; viewsRecreated: string[] }> {
  let existing: Set<string>;
  try {
    existing = new Set(await io.sqlTableNames());
  } catch (error) {
    throw new AppsInstallError("SQL_FAILED", `Could not list tables: ${errorMessage(error)}`);
  }
  for (const statement of plan.statements) {
    try {
      await io.sqlExecute(statement);
    } catch (error) {
      throw new AppsInstallError("SQL_FAILED", `Schema statement failed: ${errorMessage(error)}`);
    }
  }
  return {
    tablesCreated: plan.tables.filter((name) => !existing.has(name)),
    viewsRecreated: [...plan.views],
  };
}

/** Pinned knowledge paths in write order: every note before `knowledge/index.md`. */
function knowledgePaths(app: PinnedApp): string[] {
  const paths = app.files.map((file) => file.path).filter((path) => path.startsWith("knowledge/"));
  return [...paths.filter((path) => path !== "knowledge/index.md"), ...paths.filter((path) => path === "knowledge/index.md")];
}

/** Read every pinned note before any write. Only absent notes are candidates for creation. */
async function inspectKnowledge(
  appId: string,
  app: PinnedApp,
  verified: Map<string, Uint8Array>,
  io: InstallIo,
): Promise<{ missing: string[]; unchanged: string[]; conflicts: string[] }> {
  const missing: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  for (const path of knowledgePaths(app)) {
    const current = await readKv(`${appId}/${path}`, io);
    if (current === undefined) missing.push(path);
    else if (bytesEqual(current, verified.get(path)!)) unchanged.push(path);
    else conflicts.push(path);
  }
  return { missing, unchanged, conflicts };
}

/** Create-only writes for absent notes, in pinned order. A note that appeared since inspection is classified as if it had been inspected. */
async function createMissing(
  appId: string,
  missing: readonly string[],
  verified: Map<string, Uint8Array>,
  io: InstallIo,
): Promise<{ written: string[]; unchanged: string[]; conflicts: string[] }> {
  const written: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  for (const path of missing) {
    const key = `${appId}/${path}`;
    const bytes = verified.get(path)!;
    const outcome = await createKv(key, bytes, io);
    if (outcome === "created") {
      written.push(path);
      continue;
    }
    const raced = await readKv(key, io);
    if (raced !== undefined && bytesEqual(raced, bytes)) unchanged.push(path);
    else conflicts.push(path);
  }
  return { written, unchanged, conflicts };
}

async function readKv(key: string, io: InstallIo): Promise<Uint8Array | undefined> {
  try {
    return await io.kvGet(key);
  } catch (error) {
    throw new AppsInstallError("KV_FAILED", `Could not read ${key}: ${errorMessage(error)}`);
  }
}

async function createKv(key: string, bytes: Uint8Array, io: InstallIo): Promise<"created" | "exists"> {
  try {
    return await io.kvCreate(key, bytes);
  } catch (error) {
    throw new AppsInstallError("KV_FAILED", `Could not write ${key}: ${errorMessage(error)}`);
  }
}

/**
 * Install one catalog app. Order: verify every pinned byte, validate the pinned DDL,
 * inspect the knowledge notes, create absent notes (`knowledge/index.md` last), then
 * apply the schema. Nothing is written until all bytes verify and the DDL passes.
 * A note that differs from its pinned bytes is left as the user edited it and listed
 * in `conflicts`; conflicts do not throw.
 */
export async function installApp(
  appId: string,
  io: InstallIo,
  lookup: (id: string) => PinnedApp | undefined = pinnedApp,
): Promise<InstallResult> {
  const app = lookup(appId);
  if (!app) throw new AppsInstallError("UNKNOWN_APP", `No pinned catalog entry for ${appId}`);
  const verified = await fetchVerified(app, io);
  const schemaSql = new TextDecoder("utf-8", { fatal: true }).decode(verified.get("schema.sql")!);
  const plan = planDdl(schemaSql);
  const inspected = await inspectKnowledge(appId, app, verified, io);
  const created = await createMissing(appId, inspected.missing, verified, io);
  let schema: { tablesCreated: string[]; viewsRecreated: string[] };
  try {
    schema = await applySchema(plan, io);
  } catch (error) {
    if (error instanceof AppsInstallError) {
      throw new AppsInstallError(error.code, `notes saved; tables not set up: run again. ${error.message}`);
    }
    throw error;
  }
  return {
    appId,
    status: created.written.length > 0 ? "installed" : "already",
    database: app.database,
    filesWritten: created.written,
    filesUnchanged: [...inspected.unchanged, ...created.unchanged],
    conflicts: [...inspected.conflicts, ...created.conflicts],
    tablesCreated: schema.tablesCreated,
    viewsRecreated: schema.viewsRecreated,
  };
}
