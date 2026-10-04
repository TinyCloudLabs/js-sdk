import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner, shouldOutputJson, formatTable, formatBytes } from "../output/formatter.js";
import { handleError, CLIError, cliErrorFromService } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { theme } from "../output/theme.js";

export function registerDuckdbCommand(program: Command): void {
  const duckdb = program.command("duckdb").description("DuckDB database operations");

  // tc duckdb query <sql>
  duckdb
    .command("query <sql>")
    .description("Run a SELECT query")
    .option("--db <name>", "Database name", "default")
    .option("--params <json>", "Bind parameters as JSON array")
    .action(async (sqlStr: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const params = options.params ? JSON.parse(options.params) : undefined;

        const result = await withSpinner("Running query...", () =>
          node.duckdb.db(options.db).query(sqlStr, params)
        ) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
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

  // tc duckdb execute <sql>
  duckdb
    .command("execute <sql>")
    .description("Run INSERT/UPDATE/DELETE/DDL statement")
    .option("--db <name>", "Database name", "default")
    .option("--params <json>", "Bind parameters as JSON array")
    .action(async (sqlStr: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const params = options.params ? JSON.parse(options.params) : undefined;

        const result = await withSpinner("Executing statement...", () =>
          node.duckdb.db(options.db).execute(sqlStr, params)
        ) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        outputJson({ changes: result.data.changes });
      } catch (error) {
        handleError(error);
      }
    });

  // tc duckdb describe
  duckdb
    .command("describe")
    .description("Show database schema (tables, columns, views)")
    .option("--db <name>", "Database name", "default")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const result = await withSpinner("Describing schema...", () =>
          node.duckdb.db(options.db).describe()
        ) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        const schema = result.data;

        if (shouldOutputJson()) {
          outputJson(schema);
        } else {
          const { tables, views } = schema;

          if (tables.length === 0 && views.length === 0) {
            process.stdout.write(theme.muted("No tables or views found.") + "\n");
            return;
          }

          if (tables.length > 0) {
            process.stdout.write(theme.label("Tables:") + "\n\n");
            for (const table of tables) {
              process.stdout.write(`  ${theme.value(table.name)}\n`);
              const colRows = table.columns.map((col: any) => [
                col.name,
                col.type,
                col.nullable ? "YES" : "NO",
              ]);
              const colTable = formatTable(["Column", "Type", "Nullable"], colRows);
              process.stdout.write(colTable.split("\n").map((l: string) => "    " + l).join("\n") + "\n\n");
            }
          }

          if (views.length > 0) {
            process.stdout.write(theme.label("Views:") + "\n\n");
            const viewRows = views.map((v: any) => [v.name, v.sql]);
            process.stdout.write(formatTable(["View", "SQL"], viewRows) + "\n");
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  // tc duckdb export
  duckdb
    .command("export")
    .description("Export database as binary file")
    .option("--db <name>", "Database name", "default")
    .option("-o, --output <file>", "Output file path", "export.duckdb")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const result = await withSpinner("Exporting database...", () =>
          node.duckdb.db(options.db).export()
        ) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
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

  // tc duckdb import <file>
  duckdb
    .command("import <file>")
    .description("Import a DuckDB database file")
    .option("--db <name>", "Database name", "default")
    .action(async (file: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const filePath = resolve(file);
        const bytes = new Uint8Array(await readFile(filePath));

        const result = await withSpinner("Importing database...", () =>
          node.duckdb.db(options.db).import(bytes)
        ) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        outputJson({
          file: filePath,
          size: bytes.byteLength,
          sizeHuman: formatBytes(bytes.byteLength),
          imported: true,
        });
      } catch (error) {
        handleError(error);
      }
    });
}
