import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner, shouldOutputJson, formatTable, formatBytes, formatTimeAgo } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { resolveSpaceUri } from "../lib/space.js";
import { theme } from "../output/theme.js";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

/**
 * Read all data from stdin.
 */
async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Pick a KV service for the requested space.
 *
 * `--space` is optional; when omitted, ops route through the node's primary
 * space (preserves prior behavior). When present, we use
 * TinyCloudNode.kvForSpace, which clones the active service context with a
 * session whose spaceId points at the target space — e.g. to read a manifest
 * app's data kept under the owner's `applications` space.
 */
async function kvHandle(
  node: TinyCloudNode,
  spaceInput: string | undefined,
  profileName: string,
) {
  const spaceUri = await resolveSpaceUri(spaceInput, profileName);
  return spaceUri ? node.kvForSpace(spaceUri) : node.kv;
}

export function registerKvCommand(program: Command): void {
  const kv = program.command("kv").description("Key-value store operations");

  // tc kv get <key>
  kv
    .command("get <key>")
    .description("Get a value by key")
    .option("--raw", "Output raw value (no JSON wrapping)")
    .option("-o, --output <file>", "Write value to file")
    .option("--space <name|uri>", "Target a non-primary space (short name or full URI)")
    .action(async (key: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const kv = await kvHandle(node, options.space, ctx.profile);
        const result = await withSpinner(`Getting ${key}...`, () => kv.get(key)) as any;

        if (!result.ok) {
          if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
            throw new CLIError("NOT_FOUND", `Key "${key}" not found`, ExitCode.NOT_FOUND);
          }
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        const data = result.data.data;
        const metadata = result.data.headers ?? {};

        if (options.output) {
          // Write to file
          const content = typeof data === "string" ? data : JSON.stringify(data);
          await writeFile(options.output, content);
          outputJson({ key, written: options.output });
          return;
        }

        if (options.raw) {
          // Raw output - write directly to stdout
          const content = typeof data === "string" ? data : JSON.stringify(data);
          process.stdout.write(content);
          return;
        }

        // Output value
        if (shouldOutputJson()) {
          outputJson({
            key,
            data,
            metadata,
          });
        } else {
          // Just output the raw value for get - useful for piping
          const content = typeof data === "string" ? data : JSON.stringify(data);
          process.stdout.write(content + "\n");
        }
      } catch (error) {
        handleError(error);
      }
    });

  // tc kv put <key> [value]
  kv
    .command("put <key> [value]")
    .description("Set a value")
    .option("--file <path>", "Read value from file")
    .option("--stdin", "Read value from stdin")
    .action(async (key: string, value: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        // Determine value source
        let putValue: string | Buffer;
        const sources = [value !== undefined, !!options.file, !!options.stdin].filter(Boolean);

        if (sources.length === 0) {
          throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
        }
        if (sources.length > 1) {
          throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
        }

        if (options.file) {
          putValue = await readFile(options.file);
        } else if (options.stdin) {
          putValue = await readStdin();
        } else {
          // Try to parse as JSON, fall back to string
          try {
            putValue = JSON.parse(value!);
          } catch {
            putValue = value!;
          }
        }

        const result = await withSpinner(`Writing ${key}...`, () => node.kv.put(key, putValue)) as any;

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        outputJson({ key, written: true });
      } catch (error) {
        handleError(error);
      }
    });

  // tc kv delete <key>
  kv
    .command("delete <key>")
    .description("Delete a key")
    .action(async (key: string, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const result = await withSpinner(`Deleting ${key}...`, () => node.kv.delete(key)) as any;

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        outputJson({ key, deleted: true });
      } catch (error) {
        handleError(error);
      }
    });

  // tc kv list
  kv
    .command("list")
    .description("List keys")
    .option("--prefix <prefix>", "Filter by key prefix")
    .option("--space <name|uri>", "Target a non-primary space (short name or full URI)")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const kv = await kvHandle(node, options.space, ctx.profile);
        const listOptions = options.prefix ? { prefix: options.prefix } : undefined;
        const result = await withSpinner("Listing keys...", () => kv.list(listOptions)) as any;

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        const rawData = result.data.data ?? result.data;
        const keyList = Array.isArray(rawData) ? rawData : (rawData?.keys ?? []);

        if (shouldOutputJson()) {
          outputJson({
            keys: keyList,
            count: keyList.length,
            prefix: options.prefix ?? null,
          });
        } else {
          if (keyList.length === 0) {
            process.stdout.write(theme.muted("No keys found.") + "\n");
          } else {
            const rows = keyList.map((e: any) => [
              e.key || e,
              e.contentLength ? formatBytes(e.contentLength) : "—",
              e.updatedAt ? formatTimeAgo(e.updatedAt) : "—",
            ]);
            process.stdout.write(formatTable(["Key", "Size", "Updated"], rows) + "\n");
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  // tc kv head <key>
  kv
    .command("head <key>")
    .description("Get metadata for a key (no body)")
    .option("--space <name|uri>", "Target a non-primary space (short name or full URI)")
    .action(async (key: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const kv = await kvHandle(node, options.space, ctx.profile);
        const result = await withSpinner(`Checking ${key}...`, () => kv.head(key)) as any;

        if (!result.ok) {
          if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
            outputJson({ key, exists: false, metadata: {} });
            return;
          }
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        outputJson({
          key,
          exists: true,
          metadata: result.data.headers ?? {},
        });
      } catch (error) {
        handleError(error);
      }
    });
}
