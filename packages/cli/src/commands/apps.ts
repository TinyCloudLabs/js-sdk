import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { operationSpaceResolver } from "@tinycloud/operations/delegation-binding";
import { assertKnowledgeAppId } from "../lib/knowledge-input.js";
import { pinnedApp } from "../lib/apps-install-pin.js";
import { AppsInstallError, installApp, type InstallIo, type InstallResult } from "../lib/apps-install.js";
import { resolveSpaceUri } from "../lib/space.js";
import { unhostedSpaceError } from "../lib/host.js";
import {
  initTinyApp,
  planTinyAppInit,
  TINY_APPS_SPACE,
  TinyAppInputError,
  tinyAppProfile,
  type TinyAppKvPort,
} from "../lib/tiny-apps.js";
import { CLIError, cliErrorFromService, handleError } from "../output/errors.js";
import { formatTable, outputJson, shouldOutputJson, withSpinner } from "../output/formatter.js";
import { theme } from "../output/theme.js";

/** Installed apps keep their KV and SQL in the applications space. */
const APPLICATIONS_SPACE = "applications";

export function registerAppsCommand(program: Command): void {
  const apps = program.command("apps").description("Install catalog apps into your applications space");

  apps
    .command("install <app_id>")
    .description("Install a pinned catalog app: verify Share bytes, apply its schema, write its knowledge bundle")
    .addHelpText(
      "after",
      `
Examples:
  $ ${CLI_NAME} apps install xyz.tinycloud.sample.healthlog
`,
    )
    .action(async (appIdInput: string, _options: unknown, cmd: Command) => {
      try {
        const appId = assertKnowledgeAppId(appIdInput);
        const entry = pinnedApp(appId);
        if (!entry) throw new CLIError("UNKNOWN_APP", `No pinned catalog entry for ${appId}`, ExitCode.USAGE_ERROR);

        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const node = await ensureAuthenticated(ctx);
        const profile = await ProfileManager.getProfile(ctx.profile);
        // Same owner-aware resolution as `knowledge list`: a delegate session's applications space is the owner's, not the delegate's address.
        const spaceUri = operationSpaceResolver(node, profile.spaceId)(APPLICATIONS_SPACE);
        const io = appsInstallIo(node.kvForSpace(spaceUri), node.sqlForSpace(spaceUri).db(entry.database));

        const result = await withSpinner(`Installing ${appId}...`, () => installApp(appId, io)).catch((error: unknown) => {
          throw installFailure(error);
        });

        if (shouldOutputJson()) outputJson(result);
        else printResult(result);
      } catch (error) {
        return handleError(error);
      }
    });

  apps
    .command("init <app>")
    .description("Start a tiny app (tc-apps layout): its catalog records, its discovery entry and an optional starter record, all create-only")
    .requiredOption("--by <client>", "The client the records name in `by`: claude-code, codex or opencode")
    .option("--starter <text>", "Also save one starter item with this text, unless it (or its done twin) already exists")
    .addHelpText(
      "after",
      `
Writes in the owner's \`${TINY_APPS_SPACE}\` space, under the app's own folder and its discovery entry only, with the
profile \`tinyapp-<app>\` unless --profile names another. Every write is create-only: a record that exists is
left as it is. Prints the keys and the records as read back.

Examples:
  $ ${CLI_NAME} apps init todos --starter "Try my personal apps" --by claude-code
`,
    )
    .action(async (app: string, options: { by: string; starter?: string }, cmd: Command) => {
      try {
        let plan;
        try {
          plan = planTinyAppInit({ app, by: options.by, starter: options.starter, now: new Date() });
        } catch (error) {
          if (error instanceof TinyAppInputError) throw new CLIError(error.code, error.message, ExitCode.USAGE_ERROR);
          throw error;
        }
        const globalOpts = cmd.optsWithGlobals();
        // Each tiny app has its own profile; the default profile is never the right one here.
        const ctx = await ProfileManager.resolveContext({ ...globalOpts, profile: globalOpts.profile ?? tinyAppProfile(app) });
        const node = await ensureAuthenticated(ctx);
        const spaceUri = await resolveSpaceUri(TINY_APPS_SPACE, ctx.profile);
        const kv = tinyAppKvPort(node.kvForSpace(spaceUri!), spaceUri, ctx.profile);
        const result = await withSpinner(`Starting ${plan.id}...`, () => initTinyApp(plan, kv));
        outputJson({ ...result, profile: ctx.profile, space: TINY_APPS_SPACE });
      } catch (error) {
        return handleError(error);
      }
    });
}

/** The KV calls `apps init` makes; structural, so the SDK client and a test fake both satisfy it. */
export interface InitKvClient {
  get(key: string): Promise<PortResult<{ data: unknown }>>;
  put(key: string, value: Uint8Array, options: { ifNoneMatch: "*" }): Promise<PortResult<unknown>>;
}

/** Bind `apps init` to one KV client, with the `kv` command's error mapping. */
export function tinyAppKvPort(kv: InitKvClient, spaceUri: string | undefined, profileName: string): TinyAppKvPort {
  const fail = async (error: ServiceError): Promise<never> => {
    const hosted = await unhostedSpaceError({ code: error.code ?? "KV_FAILED", message: error.message ?? "", meta: error.meta }, spaceUri, profileName);
    throw hosted ?? cliErrorFromService({ code: error.code ?? "KV_FAILED", message: error.message ?? "KV request failed", meta: error.meta });
  };
  return {
    async get(key) {
      const result = await kv.get(key);
      if (result.ok) return result.data.data;
      if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") return undefined;
      return fail(result.error);
    },
    async create(key, bytes) {
      const result = await kv.put(key, bytes, { ifNoneMatch: "*" });
      if (result.ok) return "created";
      if (result.error.code === "KV_PRECONDITION_FAILED") return "exists";
      return fail(result.error);
    },
  };
}

/** The KV calls the installer makes; structural, so the SDK client and a test fake both satisfy it. */
export interface InstallKvPort {
  get(key: string, options: { binary: true }): Promise<PortResult<{ data: unknown }>>;
  put(key: string, value: Uint8Array, options: { ifNoneMatch: "*" }): Promise<PortResult<unknown>>;
}
/** The SQL calls the installer makes on one app database. */
export interface InstallDbPort {
  execute(statement: string): Promise<PortResult<unknown>>;
  query(statement: string): Promise<PortResult<{ rows: unknown[] }>>;
}
type ServiceError = { code?: string; message?: string; meta?: Record<string, unknown> };
type PortResult<T> = { ok: true; data: T } | { ok: false; error: ServiceError };

/** Bind installer I/O to one applications-space KV and one app database. */
export function appsInstallIo(kv: InstallKvPort, db: InstallDbPort): InstallIo {
  return {
    async fetchBytes(url) {
      const response = await fetch(url, { redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async kvGet(key) {
      const result = await kv.get(key, { binary: true });
      if (result.ok) {
        const bytes = result.data.data;
        if (bytes instanceof Uint8Array) return bytes;
        throw new Error("KV_GET_NOT_BYTES");
      }
      if (result.error.code === "KV_NOT_FOUND") return undefined;
      throw new Error(result.error.code ?? "KV_GET_FAILED");
    },
    async kvCreate(key, bytes) {
      const result = await kv.put(key, bytes, { ifNoneMatch: "*" });
      if (result.ok) return "created";
      if (result.error.code === "KV_PRECONDITION_FAILED") return "exists";
      throw new Error(result.error.code ?? "KV_PUT_FAILED");
    },
    async sqlExecute(statement) {
      const result = await db.execute(statement);
      if (!result.ok) throw new Error(result.error.code ?? "SQL_EXECUTE_FAILED");
    },
    async sqlTableNames() {
      const result = await db.query("SELECT name FROM sqlite_master WHERE type = 'table'");
      if (!result.ok) throw new Error(result.error.code ?? "SQL_QUERY_FAILED");
      return result.data.rows.map(tableName);
    },
  };
}

/** First column of one `sqlite_master` row, whether the SDK returns arrays or objects. */
function tableName(row: unknown): string {
  if (Array.isArray(row)) return String(row[0]);
  if (row !== null && typeof row === "object" && "name" in row) return String(row.name);
  throw new Error("SQL_ROW_UNEXPECTED");
}

function installFailure(error: unknown): unknown {
  if (!(error instanceof AppsInstallError)) return error;
  return new CLIError(error.code, error.message, ExitCode.ERROR);
}

function printResult(result: InstallResult): void {
  const rows = [
    ["App", result.appId],
    ["Status", result.status],
    ["Database", result.database],
    ["Tables created", result.tablesCreated.join(", ") || "none"],
    ["Views recreated", result.viewsRecreated.join(", ") || "none"],
    ["Knowledge written", String(result.filesWritten.length)],
    ["Knowledge unchanged", String(result.filesUnchanged.length)],
    ["Knowledge left as edited", String(result.conflicts.length)],
  ];
  process.stdout.write(formatTable(["Field", "Value"], rows) + "\n");
  if (result.conflicts.length > 0) {
    const count = result.conflicts.length;
    const sentence = count === 1 ? "1 note was left as you edited it" : `${count} notes were left as you edited them`;
    process.stdout.write(theme.muted(`${sentence}: ${result.conflicts.join(", ")}`) + "\n");
  }
  if (result.status === "already") {
    process.stdout.write(theme.muted("Already installed; views refreshed.") + "\n");
  }
}
