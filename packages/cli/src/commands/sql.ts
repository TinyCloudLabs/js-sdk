import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TinyCloudNode, IDatabaseHandle } from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner, shouldOutputJson, formatTable, formatBytes } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { resolveSpaceUri } from "../lib/space.js";
import { theme } from "../output/theme.js";

/**
 * Pick a database handle for the requested space + db name.
 *
 * `--space` is optional; when omitted, ops route through the node's
 * primary-space SQL service (preserves prior behavior). When present,
 * we use TinyCloudNode.sqlForSpace, which clones the active service
 * context with a session whose spaceId points at the target space.
 */
async function dbHandle(
  node: TinyCloudNode,
  dbName: string,
  spaceInput: string | undefined,
  profileName: string,
): Promise<IDatabaseHandle> {
  const spaceUri = await resolveSpaceUri(spaceInput, profileName);
  const sql = spaceUri ? node.sqlForSpace(spaceUri) : node.sql;
  return sql.db(dbName);
}

export function registerSqlCommand(program: Command): void {
  const sql = program
    .command("sql")
    .description("SQLite database operations for your TinyCloud space")
    .addHelpText("after", `

TinyCloud SQL gives each space isolated SQLite databases. Use the default
database for simple apps, or pass --db to target a named database. Pass
--space to target a non-primary space (e.g. the manifest "applications" space).

Common workflows:
  $ tc sql execute "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)"
  $ tc sql execute "INSERT INTO notes (body) VALUES (?)" --params '["ship docs"]'
  $ tc sql query "SELECT id, body FROM notes ORDER BY id"
  $ tc sql query "SELECT * FROM events WHERE type = ?" --db analytics --params '["signup"]'
  $ tc sql query "SELECT count(*) FROM conversation" --space applications --db xyz.tinycloud.listen/conversations
  $ tc sql export --db analytics --output analytics.db

Commands:
  query     Read rows with SELECT statements
  execute   Run writes and schema changes such as INSERT, UPDATE, DELETE, CREATE, DROP
  export    Download the raw SQLite database file
  copy      Copy rows between databases (optionally across spaces)

Tips:
  - SQL strings should usually be quoted so your shell passes them as one argument.
  - --params accepts a JSON array and binds values to ? placeholders.
  - --space accepts a short name ("applications") or full URI ("tinycloud:pkh:eip155:1:0x...:applications").
  - Add --json for scripting-friendly output.
`);

  // tc sql query <sql>
  sql
    .command("query <sql>")
    .description("Run a read-only SELECT query")
    .option("--db <name>", "SQLite database name within the current space", "default")
    .option("--space <name|uri>", "Target a non-primary space (short name or full URI)")
    .option("--params <json>", "Bind parameters as a JSON array for ? placeholders")
    .addHelpText("after", `

Examples:
  $ tc sql query "SELECT * FROM notes ORDER BY id"
  $ tc sql query "SELECT * FROM notes WHERE id = ?" --params '[42]'
  $ tc sql query "SELECT count(*) AS total FROM events" --db analytics --json
  $ tc sql query "SELECT count(*) FROM conversation" --space applications --db xyz.tinycloud.listen/conversations

Output:
  Human output is formatted as a table. Piped output or --json returns
  { "columns": string[], "rows": unknown[][], "rowCount": number }.
`)
    .action(async (sqlStr: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const params = options.params ? JSON.parse(options.params) : undefined;
        const handle = await dbHandle(node, options.db, options.space, ctx.profile);

        const result = await withSpinner("Running query...", () =>
          handle.query(sqlStr, params)
        ) as any;

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR, result.error.meta);
        }

        const { columns, rows, rowCount } = result.data;

        if (shouldOutputJson()) {
          outputJson({ columns, rows, rowCount });
        } else {
          if (rows.length === 0) {
            process.stdout.write(theme.muted("No rows returned.") + "\n");
          } else {
            const stringRows = rows.map((row: unknown[]) =>
              row.map((v: unknown) => v === null ? "NULL" : String(v))
            );
            process.stdout.write(formatTable(columns, stringRows) + "\n");
            process.stdout.write(theme.muted(`\n${rowCount} row${rowCount === 1 ? "" : "s"} returned`) + "\n");
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  // tc sql execute <sql>
  sql
    .command("execute <sql>")
    .description("Run a write or schema statement")
    .option("--db <name>", "SQLite database name within the current space", "default")
    .option("--space <name|uri>", "Target a non-primary space (short name or full URI)")
    .option("--params <json>", "Bind parameters as a JSON array for ? placeholders")
    .addHelpText("after", `

Examples:
  $ tc sql execute "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)"
  $ tc sql execute "INSERT INTO notes (body) VALUES (?)" --params '["first note"]'
  $ tc sql execute "UPDATE notes SET body = ? WHERE id = ?" --params '["edited", 1]'
  $ tc sql execute "DROP TABLE old_notes" --db archive
  $ tc sql execute "DELETE FROM conversation WHERE id = ?" --space applications --db xyz.tinycloud.listen/conversations --params '["abc"]'

Output:
  Returns JSON with the changed row count and last inserted row id when available.
`)
    .action(async (sqlStr: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const params = options.params ? JSON.parse(options.params) : undefined;
        const handle = await dbHandle(node, options.db, options.space, ctx.profile);

        const result = await withSpinner("Executing statement...", () =>
          handle.execute(sqlStr, params)
        ) as any;

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR, result.error.meta);
        }

        outputJson({
          changes: result.data.changes,
          lastInsertRowId: result.data.lastInsertRowId,
        });
      } catch (error) {
        handleError(error);
      }
    });

  // tc sql export
  sql
    .command("export")
    .description("Export a SQLite database as a binary .db file")
    .option("--db <name>", "SQLite database name within the current space", "default")
    .option("--space <name|uri>", "Target a non-primary space (short name or full URI)")
    .option("-o, --output <file>", "Output file path", "export.db")
    .addHelpText("after", `

Examples:
  $ tc sql export
  $ tc sql export --db analytics --output analytics.db
  $ tc sql export --space applications --db xyz.tinycloud.listen/conversations --output listen.db

Output:
  Writes the database file locally and returns JSON with the path and size.
`)
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const handle = await dbHandle(node, options.db, options.space, ctx.profile);

        const result = await withSpinner("Exporting database...", () =>
          handle.export()
        ) as any;

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR, result.error.meta);
        }

        const blob: Blob = result.data;
        const buffer = Buffer.from(await blob.arrayBuffer());
        const outputPath = resolve(options.output);
        await writeFile(outputPath, buffer);

        outputJson({
          file: outputPath,
          size: blob.size,
          sizeHuman: formatBytes(blob.size),
        });
      } catch (error) {
        handleError(error);
      }
    });

  // tc sql copy
  sql
    .command("copy")
    .description("Copy rows between SQL databases (optionally across spaces)")
    .requiredOption("--from-db <name>", "Source database name")
    .requiredOption("--to-db <name>", "Destination database name")
    .option("--from-space <name|uri>", "Source space (defaults to primary)")
    .option("--to-space <name|uri>", "Destination space (defaults to primary)")
    .option("--table <name...>", "Restrict copy to specific tables (repeat or comma-separated)")
    .option("--dry-run", "Print the plan without writing", false)
    .addHelpText("after", `

Examples:
  $ tc sql copy --from-db com.tinycloud.conversation-sync/conversations \\
                --to-db xyz.tinycloud.listen/conversations \\
                --space applications --dry-run
  $ tc sql copy --from-space applications --from-db com.foo/data \\
                --to-space applications --to-db com.bar/data \\
                --table conversation --table participant

Notes:
  - Refuses to run when (resolved space, db) is identical for source and destination.
  - Does NOT create destination tables. Run the target app once (or use \`tc sql execute\`)
    to materialize the schema before copying.
  - One row at a time; suitable for small/medium datasets. Large copies should
    use \`tc sql export\` + bulk import.
  - Authorization: the active session/delegation must cover sql/read on source
    AND sql/write on destination. Otherwise the relevant operation will fail.
`)
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        // commander's `--space` shorthand supports both --from-space and a default.
        const fromSpaceInput: string | undefined = options.fromSpace ?? options.space;
        const toSpaceInput: string | undefined = options.toSpace ?? options.space;

        const fromSpaceUri = (await resolveSpaceUri(fromSpaceInput, ctx.profile)) ?? "<primary>";
        const toSpaceUri = (await resolveSpaceUri(toSpaceInput, ctx.profile)) ?? "<primary>";

        if (fromSpaceUri === toSpaceUri && options.fromDb === options.toDb) {
          throw new CLIError(
            "SELF_COPY",
            `Refusing to copy: source and destination resolve to the same (space, db) — ${fromSpaceUri} / ${options.fromDb}.`,
            ExitCode.USAGE_ERROR,
          );
        }

        const fromHandle = await dbHandle(node, options.fromDb, fromSpaceInput, ctx.profile);
        const toHandle = await dbHandle(node, options.toDb, toSpaceInput, ctx.profile);

        // Resolve target tables: explicit list, or all user tables in source.
        let tables: string[];
        if (options.table && options.table.length > 0) {
          tables = options.table.flatMap((t: string) => t.split(",").map((s) => s.trim()).filter(Boolean));
        } else {
          const listing = await fromHandle.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          ) as any;
          if (!listing.ok) {
            throw new CLIError(listing.error.code, `Cannot list source tables: ${listing.error.message}`, ExitCode.ERROR, listing.error.meta);
          }
          tables = (listing.data.rows as unknown[][]).map((r) => String(r[0]));
        }

        if (tables.length === 0) {
          throw new CLIError(
            "EMPTY_PLAN",
            `No tables to copy. Use --table to specify tables, or check that the source database has user tables.`,
            ExitCode.USAGE_ERROR,
          );
        }

        const plan: Array<{ table: string; rows: number; copied: number; skipped: number }> = [];

        for (const table of tables) {
          const safe = quoteIdent(table);
          const countResult = await fromHandle.query(`SELECT count(*) AS n FROM ${safe}`) as any;
          if (!countResult.ok) {
            throw new CLIError(
              countResult.error.code,
              `Cannot count rows in source table "${table}": ${countResult.error.message}`,
              ExitCode.ERROR,
              countResult.error.meta,
            );
          }
          const rows = Number(countResult.data.rows[0]?.[0] ?? 0);
          plan.push({ table, rows, copied: 0, skipped: 0 });
        }

        if (options.dryRun) {
          outputJson({
            dryRun: true,
            from: { space: fromSpaceUri, db: options.fromDb },
            to: { space: toSpaceUri, db: options.toDb },
            tables: plan.map((p) => ({ table: p.table, rows: p.rows })),
          });
          return;
        }

        for (const entry of plan) {
          const safe = quoteIdent(entry.table);
          const fetched = await fromHandle.query(`SELECT * FROM ${safe}`) as any;
          if (!fetched.ok) {
            throw new CLIError(fetched.error.code, `Failed to read "${entry.table}": ${fetched.error.message}`, ExitCode.ERROR, fetched.error.meta);
          }
          const columns: string[] = fetched.data.columns;
          const rows: unknown[][] = fetched.data.rows;

          if (rows.length === 0) continue;

          const colList = columns.map(quoteIdent).join(", ");
          const placeholders = columns.map(() => "?").join(", ");
          const insertSql = `INSERT INTO ${safe} (${colList}) VALUES (${placeholders})`;

          for (const row of rows) {
            const writeResult = await toHandle.execute(insertSql, row as any) as any;
            if (!writeResult.ok) {
              throw new CLIError(
                writeResult.error.code,
                `Insert into "${entry.table}" failed after ${entry.copied} row(s): ${writeResult.error.message}`,
                ExitCode.ERROR,
                writeResult.error.meta,
              );
            }
            entry.copied += writeResult.data.changes ?? 1;
          }
        }

        outputJson({
          from: { space: fromSpaceUri, db: options.fromDb },
          to: { space: toSpaceUri, db: options.toDb },
          tables: plan.map((p) => ({ table: p.table, rowsRead: p.rows, rowsWritten: p.copied })),
        });
      } catch (error) {
        handleError(error);
      }
    });
}

/** Quote a SQLite identifier defensively (table/column names). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
