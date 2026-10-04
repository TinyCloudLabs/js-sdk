import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner, shouldOutputJson, formatTable, formatBytes, formatTimeAgo } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { resolveSpaceUri } from "../lib/space.js";
import { unhostedSpaceError } from "../lib/host.js";
import { theme } from "../output/theme.js";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { authorizationVerdictOf } from "@tinycloud/sdk-core";

/**
 * Throw the kv/sql service error, normalized to SPACE_NOT_HOSTED with an
 * identity-aware hint when (and only when) the failure is the exact
 * unhosted-space condition. Keeps the single error path consistent across kv.
 */
async function throwKvError(
  error: { code: string; message: string; meta?: Record<string, unknown> },
  spaceUri: string | undefined,
  profileName: string,
): Promise<never> {
  const hosted = await unhostedSpaceError(error, spaceUri, profileName);
  if (hosted) throw hosted;
  const verdict = authorizationVerdictOf(error);
  throw new CLIError(
    verdict === "unauthenticated" ? "AUTH_REQUIRED" : verdict === "forbidden" ? "PERMISSION_DENIED" : error.code,
    error.message,
    verdict === "unauthenticated" ? ExitCode.AUTH_REQUIRED : verdict === "forbidden" ? ExitCode.PERMISSION_DENIED : ExitCode.ERROR,
    error.meta,
  );
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A quota refusal stays one even when the Node's text carried no sizes; its text never reaches output. */
function storageQuotaError(error: { code: string; meta?: unknown }): CLIError | undefined {
  if (error.code !== "STORAGE_QUOTA_EXCEEDED") return undefined;
  const { usedBytes, limitBytes } = (typeof error.meta === "object" && error.meta !== null ? error.meta : {}) as { usedBytes?: unknown; limitBytes?: unknown };
  const sizes = isByteCount(usedBytes) && isByteCount(limitBytes) ? ` (${formatBytes(usedBytes)} used of ${formatBytes(limitBytes)} limit)` : "";
  return new CLIError("STORAGE_QUOTA_EXCEEDED", `storage quota exceeded${sizes}; nothing was written`, ExitCode.ERROR);
}

/**
 * The SDK puts KV keys unescaped into the Node resource URI, and the Node
 * refuses a space or control character there with a 401. Fail before
 * authenticating instead of reporting that as a permission problem.
 */
function assertAddressableKey(key: string): void {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      throw new CLIError("USAGE_ERROR", "KV keys cannot contain spaces or control characters; use a URL-safe key", ExitCode.USAGE_ERROR);
    }
  }
}

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
  const kv = spaceUri ? node.kvForSpace(spaceUri) : node.kv;
  return { kv, spaceUri };
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
        assertAddressableKey(key);
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const { kv, spaceUri } = await kvHandle(node, options.space, ctx.profile);
        // For raw / file output, read the value as raw bytes so binary values
        // (e.g. images) round-trip byte-identically. The default (parsed/JSON)
        // path is unchanged.
        const wantBytes = !!options.output || !!options.raw;
        const result = await withSpinner(
          `Getting ${key}...`,
          () => kv.get(key, wantBytes ? { binary: true } : undefined),
        ) as any;

        if (!result.ok) {
          // SPACE_NOT_HOSTED (unhosted-space 404) takes precedence over the
          // generic "key not found"; only a true missing key falls through.
          const hosted = await unhostedSpaceError(result.error, spaceUri, ctx.profile);
          if (hosted) throw hosted;
          if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
            throw new CLIError("NOT_FOUND", `Key "${key}" not found`, ExitCode.NOT_FOUND);
          }
          await throwKvError(result.error, spaceUri, ctx.profile);
        }

        const data = result.data.data;
        const metadata = result.data.headers ?? {};

        if (options.output) {
          // Write raw bytes to file (data is a Uint8Array when wantBytes).
          await writeFile(options.output, data as Uint8Array);
          outputJson({ key, written: options.output });
          return;
        }

        if (options.raw) {
          // Raw output - write bytes directly to stdout.
          process.stdout.write(data as Uint8Array);
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
    .option("--space <name|uri>", "Target a non-primary space (short name or full URI)")
    .action(async (key: string, value: string | undefined, options, cmd) => {
      try {
        assertAddressableKey(key);
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

        const { kv, spaceUri } = await kvHandle(node, options.space, ctx.profile);
        const result = await withSpinner(`Writing ${key}...`, () => kv.put(key, putValue)) as any;

        if (!result.ok) {
          const quota = storageQuotaError(result.error);
          if (quota) throw quota;
          await throwKvError(result.error, spaceUri, ctx.profile);
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
    .option("--space <name|uri>", "Target a non-primary space (short name or full URI)")
    .action(async (key: string, options, cmd) => {
      try {
        assertAddressableKey(key);
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const { kv, spaceUri } = await kvHandle(node, options.space, ctx.profile);
        const result = await withSpinner(`Deleting ${key}...`, () => kv.delete(key)) as any;

        if (!result.ok) {
          await throwKvError(result.error, spaceUri, ctx.profile);
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
        if (options.prefix) assertAddressableKey(options.prefix);
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const { kv, spaceUri } = await kvHandle(node, options.space, ctx.profile);
        const listOptions = options.prefix ? { prefix: options.prefix } : undefined;
        const result = await withSpinner("Listing keys...", () => kv.list(listOptions)) as any;

        if (!result.ok) {
          await throwKvError(result.error, spaceUri, ctx.profile);
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
        assertAddressableKey(key);
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const { kv, spaceUri } = await kvHandle(node, options.space, ctx.profile);
        const result = await withSpinner(`Checking ${key}...`, () => kv.head(key)) as any;

        if (!result.ok) {
          // An unhosted space must not be reported as a benign "key absent".
          const hosted = await unhostedSpaceError(result.error, spaceUri, ctx.profile);
          if (hosted) throw hosted;
          if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
            outputJson({ key, exists: false, metadata: {} });
            return;
          }
          await throwKvError(result.error, spaceUri, ctx.profile);
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
