import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { writePrivateOutput } from "../lib/private-output.js";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner, shouldOutputJson, formatTable } from "../output/formatter.js";
import { handleError, CLIError, cliErrorFromService } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { resolveSpaceUri } from "../lib/space.js";
import { unhostedSpaceError } from "../lib/host.js";
import { theme } from "../output/theme.js";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { emitDiagnostic, enterDiagnosticContext, getDiagnosticContext } from "@tinycloud/operations/diagnostics";
import { cliDiagnosticScope, withCliDiagnosticPhase } from "../lib/diagnostics.js";

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
  throw cliErrorFromService(error);
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
      emitDiagnostic({ type: "operation.step", phase: "input_validation", outcome: "fail", error_class: "input_invalid", mutation: "not_dispatched" });
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
        enterDiagnosticContext(await cliDiagnosticScope("kv", key));
        emitDiagnostic({ type: "operation.step", service: "kv", action: "get", requested: 1 });
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await withCliDiagnosticPhase("preparation", { service: "local" }, () => ProfileManager.resolveContext(globalOpts));
        const node = await ensureAuthenticated(ctx);

        const { kv, spaceUri } = await kvHandle(node, options.space, ctx.profile);
        // For raw / file output, read the value as raw bytes so binary values
        // (e.g. images) round-trip byte-identically. The default (parsed/JSON)
        // path is unchanged.
        const wantBytes = !!options.output || !!options.raw;
        const result = await withSpinner(
          `Getting ${key}...`,
          () => withCliDiagnosticPhase("execution", { service: "kv", action: "get", requested: 1 }, () => kv.get(key, wantBytes ? { binary: true } : undefined)),
        );

        if (!result.ok) {
          emitDiagnostic({ type: "operation.step", service: "kv", action: "get", business: "failed", verification: getDiagnosticContext()?.role === "verification" ? "read_back" : "none", verification_result: "failed" });
          // SPACE_NOT_HOSTED (unhosted-space 404) takes precedence over the
          // generic "key not found"; only a true missing key falls through.
          const hosted = await unhostedSpaceError(result.error, spaceUri, ctx.profile);
          if (hosted) throw hosted;
          if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
            emitDiagnostic({ type: "operation.step", service: "kv", action: "get", missing: 1, verification_result: "missing" });
            throw new CLIError("NOT_FOUND", `Key "${key}" not found`, ExitCode.NOT_FOUND);
          }
          return await throwKvError(result.error, spaceUri, ctx.profile);
        }
        emitDiagnostic({ type: "operation.step", service: "kv", action: "get", business: "complete", returned: 1, verification: getDiagnosticContext()?.role === "verification" ? "read_back" : "none", verification_result: "found" });

        const data = result.data.data;
        const metadata = result.data.headers ?? {};
        if (data instanceof Uint8Array) emitDiagnostic({ type: "operation.step", service: "kv", action: "get", bytes: data.byteLength });

        if (options.output) {
          // Write raw bytes to file (data is a Uint8Array when wantBytes).
          await writePrivateOutput(options.output, data as Uint8Array);
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
        return handleError(error);
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
        enterDiagnosticContext(await cliDiagnosticScope("kv", key));
        emitDiagnostic({ type: "operation.step", service: "kv", action: "put", requested: 1, mutation: "not_dispatched" });
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await withCliDiagnosticPhase("preparation", { service: "local" }, () => ProfileManager.resolveContext(globalOpts));
        const node = await ensureAuthenticated(ctx);

        // Determine value source
        let putValue: string | Buffer;
        const sources = [value !== undefined, !!options.file, !!options.stdin].filter(Boolean);

        if (sources.length === 0) {
          emitDiagnostic({ type: "operation.step", phase: "input_validation", outcome: "fail", error_class: "input_invalid", mutation: "not_dispatched" });
          throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
        }
        if (sources.length > 1) {
          emitDiagnostic({ type: "operation.step", phase: "input_validation", outcome: "fail", error_class: "input_invalid", mutation: "not_dispatched" });
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
        emitDiagnostic({ type: "operation.step", phase: "input_validation", outcome: "pass", ...(Buffer.isBuffer(putValue) ? { bytes: putValue.byteLength } : {}) });

        const { kv, spaceUri } = await kvHandle(node, options.space, ctx.profile);
        const result = await withSpinner(`Writing ${key}...`, () => withCliDiagnosticPhase("execution", { service: "kv", action: "put", requested: 1, mutation: "unknown" }, () => kv.put(key, putValue), (value) => ({ mutation: value.ok ? "confirmed" : "unknown" })));

        if (!result.ok) {
          emitDiagnostic({ type: "operation.step", service: "kv", action: "put", business: "failed", mutation: "unknown" });
          await throwKvError(result.error, spaceUri, ctx.profile);
        }
        emitDiagnostic({ type: "operation.step", service: "kv", action: "put", business: "complete", mutation: "confirmed", verification: "write_response", mutations: 1 });

        outputJson({ key, written: true });
      } catch (error) {
        return handleError(error);
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
        enterDiagnosticContext(await cliDiagnosticScope("kv", key));
        emitDiagnostic({ type: "operation.step", service: "kv", action: "delete", requested: 1, mutation: "not_dispatched" });
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await withCliDiagnosticPhase("preparation", { service: "local" }, () => ProfileManager.resolveContext(globalOpts));
        const node = await ensureAuthenticated(ctx);

        const { kv, spaceUri } = await kvHandle(node, options.space, ctx.profile);
        const result = await withSpinner(`Deleting ${key}...`, () => withCliDiagnosticPhase("execution", { service: "kv", action: "delete", requested: 1, mutation: "unknown" }, () => kv.delete(key), (value) => ({ mutation: value.ok ? "confirmed" : "unknown" })));

        if (!result.ok) {
          emitDiagnostic({ type: "operation.step", service: "kv", action: "delete", business: "failed", mutation: "unknown" });
          await throwKvError(result.error, spaceUri, ctx.profile);
        }
        emitDiagnostic({ type: "operation.step", service: "kv", action: "delete", business: "complete", mutation: "confirmed", mutations: 1 });

        outputJson({ key, deleted: true });
      } catch (error) {
        return handleError(error);
      }
    });

  // tc kv list
  kv
    .command("list")
    .description("List keys")
    .option("--prefix <prefix>", "Filter by key prefix")
    .option("--space <name|uri>", "Target a non-primary space (short name or full URI)")
    .option("--limit <n>", "Keys per page, 1-1000 (the node's default otherwise)")
    .option("--cursor <cursor>", "Continue from a previous page's nextCursor")
    .option("--all", "Follow nextCursor until the listing is complete")
    .action(async (options, cmd) => {
      try {
        if (options.prefix) assertAddressableKey(options.prefix);
        enterDiagnosticContext(await cliDiagnosticScope("kv", options.prefix));
        const limit = options.limit === undefined ? undefined : Number(options.limit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
          emitDiagnostic({ type: "operation.step", phase: "input_validation", outcome: "fail", error_class: "input_invalid", mutation: "not_dispatched" });
          throw new CLIError("USAGE_ERROR", "--limit must be an integer from 1 through 1000", ExitCode.USAGE_ERROR);
        }
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await withCliDiagnosticPhase("preparation", { service: "local" }, () => ProfileManager.resolveContext(globalOpts));
        const node = await ensureAuthenticated(ctx);

        const { kv, spaceUri } = await kvHandle(node, options.space, ctx.profile);
        const keyList: string[] = [];
        let cursor: string | undefined = options.cursor;
        let truncated: boolean | undefined;
        const seenCursors = new Set<string>();
        let pages = 0;
        for (;;) {
          const result = await withSpinner("Listing keys...", () => withCliDiagnosticPhase("execution", { service: "kv", action: "list" }, () => kv.list({
            ...(options.prefix ? { prefix: options.prefix } : {}),
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
          })));
          if (!result.ok) {
            emitDiagnostic({ type: "operation.step", service: "kv", action: "list", business: "failed", pages, returned: keyList.length });
            // The SDK labels every non-auth HTTP failure NETWORK_ERROR; a 400 for a request that
            // carried a cursor is the node refusing that cursor, not the network.
            if (cursor !== undefined && result.error.meta?.status === 400) {
              throw new CLIError(
                "KV_LIST_CURSOR_INVALID",
                `The node rejected the list cursor (${result.error.message}).`,
                ExitCode.USAGE_ERROR,
                { hint: "Start the listing again without --cursor, or pass a nextCursor from a recent kv list." },
              );
            }
            await throwKvError(result.error, spaceUri, ctx.profile);
            break;
          }
          // One push per key: spreading a very large page overflows the call stack.
          pages += 1;
          for (const key of result.data.keys) keyList.push(key);
          truncated = result.data.truncated;
          cursor = truncated === true ? result.data.nextCursor : undefined;
          emitDiagnostic({ type: "operation.step", service: "kv", action: "list", ordinal: pages, pages, returned: keyList.length, ...(truncated === undefined ? {} : { truncated }) });
          if (options.all && truncated === true && cursor === undefined) {
            emitDiagnostic({ type: "operation.step", service: "kv", action: "list", business: "partial", warning: "pagination_incomplete", pages, returned: keyList.length });
            throw new CLIError("KV_LIST_CURSOR_MISSING", "The node reported more keys but no cursor to continue from, so the listing can't be completed.", ExitCode.ERROR);
          }
          if (!options.all || cursor === undefined) break;
          // A node that hands back a cursor it already gave would loop forever (TC-719).
          if (seenCursors.has(cursor)) {
            emitDiagnostic({ type: "operation.step", service: "kv", action: "list", business: "partial", warning: "pagination_incomplete", pages, returned: keyList.length });
            throw new CLIError("KV_LIST_CURSOR_STALLED", "The node returned a list cursor it had already returned, so the listing can't be completed.", ExitCode.ERROR);
          }
          seenCursors.add(cursor);
        }
        emitDiagnostic({ type: "operation.step", service: "kv", action: "list", business: truncated === true ? "partial" : truncated === false ? "complete" : "unknown", returned: keyList.length, pages, ...(truncated === undefined ? {} : { truncated }) });

        if (shouldOutputJson()) {
          outputJson({
            keys: keyList,
            count: keyList.length,
            prefix: options.prefix ?? null,
            // null when the node doesn't report truncation.
            truncated: truncated ?? null,
            nextCursor: cursor ?? null,
          });
        } else {
          if (keyList.length === 0) {
            process.stdout.write(theme.muted("No keys found.") + "\n");
          } else {
            const rows = keyList.map((key) => [key, "—", "—"]);
            process.stdout.write(formatTable(["Key", "Size", "Updated"], rows) + "\n");
          }
          if (cursor !== undefined) {
            process.stdout.write(theme.muted(`More keys follow. Run again with --cursor ${cursor}, or use --all.`) + "\n");
          } else if (truncated === true) {
            process.stdout.write(theme.muted("More keys follow, but the node gave no cursor to continue from.") + "\n");
          }
        }
      } catch (error) {
        return handleError(error);
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
        enterDiagnosticContext(await cliDiagnosticScope("kv", key));
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await withCliDiagnosticPhase("preparation", { service: "local" }, () => ProfileManager.resolveContext(globalOpts));
        const node = await ensureAuthenticated(ctx);

        const { kv, spaceUri } = await kvHandle(node, options.space, ctx.profile);
        const result = await withSpinner(`Checking ${key}...`, () => withCliDiagnosticPhase("execution", { service: "kv", action: "head", requested: 1 }, () => kv.head(key)));

        if (!result.ok) {
          // An unhosted space must not be reported as a benign "key absent".
          const hosted = await unhostedSpaceError(result.error, spaceUri, ctx.profile);
          if (hosted) throw hosted;
          if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
            emitDiagnostic({ type: "operation.step", service: "kv", action: "head", business: "complete", missing: 1, verification: "none", verification_result: "missing" });
            outputJson({ key, exists: false, metadata: {} });
            return;
          }
          return await throwKvError(result.error, spaceUri, ctx.profile);
        }
        emitDiagnostic({ type: "operation.step", service: "kv", action: "head", business: "complete", returned: 1, verification: "none", verification_result: "found" });

        outputJson({
          key,
          exists: true,
          metadata: result.data.headers ?? {},
        });
      } catch (error) {
        return handleError(error);
      }
    });
}
