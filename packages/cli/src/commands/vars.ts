import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner } from "../output/formatter.js";
import { handleError, CLIError, cliErrorFromService } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";

const VARIABLES_PREFIX = "variables/";

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
 * Resolve private key from CLI options or environment variable.
 */
function resolvePrivateKey(options: { privateKey?: string }): string {
  const key = options.privateKey || process.env.TC_PRIVATE_KEY;
  if (!key) {
    throw new CLIError(
      "AUTH_REQUIRED",
      "Private key required. Use --private-key <hex> or set TC_PRIVATE_KEY env var.",
      ExitCode.AUTH_REQUIRED,
    );
  }
  return key;
}

export function registerVarsCommand(program: Command): void {
  const vars = program.command("vars").description("Plaintext variable management");

  // tc vars list
  vars
    .command("list")
    .description("List variables")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const privateKey = resolvePrivateKey(options);
        const node = await ensureAuthenticated(ctx, { privateKey });

        const prefixedKv = node.kv.withPrefix(VARIABLES_PREFIX);
        const result = await withSpinner("Listing variables...", () => prefixedKv.list()) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        const rawData = result.data.data ?? result.data;
        const keyList = Array.isArray(rawData) ? rawData : (rawData?.keys ?? []);

        outputJson({
          variables: keyList,
          count: keyList.length,
        });
      } catch (error) {
        handleError(error);
      }
    });

  // tc vars get <name>
  vars
    .command("get <name>")
    .description("Get a variable value")
    .option("--raw", "Output raw value (no JSON wrapping)")
    .option("-o, --output <file>", "Write value to file")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (name: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const privateKey = resolvePrivateKey(options);
        const node = await ensureAuthenticated(ctx, { privateKey });

        const prefixedKv = node.kv.withPrefix(VARIABLES_PREFIX);
        const result = await withSpinner(`Getting variable ${name}...`, () => prefixedKv.get(name)) as any;

        if (!result.ok) {
          if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
            throw new CLIError("NOT_FOUND", `Variable "${name}" not found`, ExitCode.NOT_FOUND);
          }
          throw cliErrorFromService(result.error);
        }

        const data = result.data.data;

        // Extract value from the stored payload
        let value: string;
        if (typeof data === "string") {
          try {
            const parsed = JSON.parse(data);
            value = parsed.value;
          } catch {
            value = data;
          }
        } else if (data && typeof data === "object" && "value" in data) {
          value = data.value;
        } else {
          value = typeof data === "string" ? data : JSON.stringify(data);
        }

        if (options.output) {
          await writeFile(options.output, value);
          outputJson({ name, written: options.output });
          return;
        }

        if (options.raw) {
          process.stdout.write(value);
          return;
        }

        outputJson({ name, value });
      } catch (error) {
        handleError(error);
      }
    });

  // tc vars put <name> [value]
  vars
    .command("put <name> [value]")
    .description("Set a variable")
    .option("--file <path>", "Read value from file")
    .option("--stdin", "Read value from stdin")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (name: string, value: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const privateKey = resolvePrivateKey(options);
        const node = await ensureAuthenticated(ctx, { privateKey });

        // Determine value source
        let varValue: string;
        const sources = [value !== undefined, !!options.file, !!options.stdin].filter(Boolean);

        if (sources.length === 0) {
          throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
        }
        if (sources.length > 1) {
          throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
        }

        if (options.file) {
          varValue = (await readFile(options.file, "utf-8")) as string;
        } else if (options.stdin) {
          varValue = (await readStdin()).toString("utf-8");
        } else {
          varValue = value!;
        }

        const payload = {
          value: varValue,
          createdAt: new Date().toISOString(),
        };

        const prefixedKv = node.kv.withPrefix(VARIABLES_PREFIX);
        const result = await withSpinner(`Setting variable ${name}...`, () => prefixedKv.put(name, payload)) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        outputJson({ name, written: true });
      } catch (error) {
        handleError(error);
      }
    });

  // tc vars delete <name>
  vars
    .command("delete <name>")
    .description("Delete a variable")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (name: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const privateKey = resolvePrivateKey(options);
        const node = await ensureAuthenticated(ctx, { privateKey });

        const prefixedKv = node.kv.withPrefix(VARIABLES_PREFIX);
        const result = await withSpinner(`Deleting variable ${name}...`, () => prefixedKv.delete(name)) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        outputJson({ name, deleted: true });
      } catch (error) {
        handleError(error);
      }
    });
}
