import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner, shouldOutputJson, formatTable, formatBytes } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { theme } from "../output/theme.js";

export function registerSqlCommand(program: Command): void {
  const sql = program
    .command("sql")
    .description("SQLite database operations for your TinyCloud space")
    .addHelpText("after", `

TinyCloud SQL gives each space isolated SQLite databases. Use the default
database for simple apps, or pass --db to target a named database.

Common workflows:
  $ tc sql execute "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)"
  $ tc sql execute "INSERT INTO notes (body) VALUES (?)" --params '["ship docs"]'
  $ tc sql query "SELECT id, body FROM notes ORDER BY id"
  $ tc sql query "SELECT * FROM events WHERE type = ?" --db analytics --params '["signup"]'
  $ tc sql export --db analytics --output analytics.db

Commands:
  query     Read rows with SELECT statements
  execute   Run writes and schema changes such as INSERT, UPDATE, DELETE, CREATE, DROP
  export    Download the raw SQLite database file

Tips:
  - SQL strings should usually be quoted so your shell passes them as one argument.
  - --params accepts a JSON array and binds values to ? placeholders.
  - Add --json for scripting-friendly output.
`);

  // tc sql query <sql>
  sql
    .command("query <sql>")
    .description("Run a read-only SELECT query")
    .option("--db <name>", "SQLite database name within the current space", "default")
    .option("--params <json>", "Bind parameters as a JSON array for ? placeholders")
    .addHelpText("after", `

Examples:
  $ tc sql query "SELECT * FROM notes ORDER BY id"
  $ tc sql query "SELECT * FROM notes WHERE id = ?" --params '[42]'
  $ tc sql query "SELECT count(*) AS total FROM events" --db analytics --json

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

        const result = await withSpinner("Running query...", () =>
          node.sql.db(options.db).query(sqlStr, params)
        ) as any;

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
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
    .option("--params <json>", "Bind parameters as a JSON array for ? placeholders")
    .addHelpText("after", `

Examples:
  $ tc sql execute "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)"
  $ tc sql execute "INSERT INTO notes (body) VALUES (?)" --params '["first note"]'
  $ tc sql execute "UPDATE notes SET body = ? WHERE id = ?" --params '["edited", 1]'
  $ tc sql execute "DROP TABLE old_notes" --db archive

Output:
  Returns JSON with the changed row count and last inserted row id when available.
`)
    .action(async (sqlStr: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const params = options.params ? JSON.parse(options.params) : undefined;

        const result = await withSpinner("Executing statement...", () =>
          node.sql.db(options.db).execute(sqlStr, params)
        ) as any;

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
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
    .option("-o, --output <file>", "Output file path", "export.db")
    .addHelpText("after", `

Examples:
  $ tc sql export
  $ tc sql export --db analytics --output analytics.db

Output:
  Writes the database file locally and returns JSON with the path and size.
`)
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const result = await withSpinner("Exporting database...", () =>
          node.sql.db(options.db).export()
        ) as any;

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
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
}
