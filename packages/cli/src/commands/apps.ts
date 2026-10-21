import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { operationSpaceResolver } from "@tinycloud/operations/delegation-binding";
import { assertKnowledgeAppId } from "../lib/knowledge-input.js";
import { pinnedApp } from "../lib/apps-install-pin.js";
import { AppsInstallError, installApp, type InstallIo, type InstallResult } from "../lib/apps-install.js";
import { CLIError, handleError } from "../output/errors.js";
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
        const io = appsInstallIo(node, spaceUri, entry.database);

        const result = await withSpinner(`Installing ${appId}...`, () => installApp(appId, io)).catch((error: unknown) => {
          throw installFailure(error);
        });

        if (shouldOutputJson()) outputJson(result);
        else printResult(result);
      } catch (error) {
        return handleError(error);
      }
    });
}

/** Bind installer I/O to the applications space and the app's database. */
function appsInstallIo(node: TinyCloudNode, spaceUri: string, database: string): InstallIo {
  const kv = node.kvForSpace(spaceUri);
  const db = node.sqlForSpace(spaceUri).db(database);
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
