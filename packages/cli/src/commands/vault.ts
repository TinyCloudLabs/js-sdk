import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner } from "../output/formatter.js";
import { handleError, CLIError, cliErrorFromService } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { PrivateKeySigner } from "@tinycloud/node-sdk";

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

/**
 * Unlock the vault on a TinyCloudNode instance.
 */
async function unlockVault(
  node: { vault: { unlock(signer: { signMessage(message: string): Promise<string> }): Promise<any> } },
  privateKey: string,
): Promise<void> {
  const signer = new PrivateKeySigner(privateKey);
  const result = await node.vault.unlock(signer);
  if (result && !result.ok) {
    throw cliErrorFromService(result.error);
  }
}

export function registerVaultCommand(program: Command): void {
  const vault = program.command("vault").description("Encrypted vault operations");

  // tc vault unlock
  vault
    .command("unlock")
    .description("Verify vault unlock works")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const privateKey = resolvePrivateKey(options);
        const node = await ensureAuthenticated(ctx, { privateKey });

        await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));

        outputJson({ unlocked: true });
      } catch (error) {
        handleError(error);
      }
    });

  // tc vault put <key> [value]
  vault
    .command("put <key> [value]")
    .description("Encrypt and store a value")
    .option("--file <path>", "Read value from file")
    .option("--stdin", "Read value from stdin")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (key: string, value: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const privateKey = resolvePrivateKey(options);
        const node = await ensureAuthenticated(ctx, { privateKey });

        await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));

        // Determine value source
        let putValue: string | Uint8Array;
        const sources = [value !== undefined, !!options.file, !!options.stdin].filter(Boolean);

        if (sources.length === 0) {
          throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
        }
        if (sources.length > 1) {
          throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
        }

        if (options.file) {
          putValue = new Uint8Array(await readFile(options.file));
        } else if (options.stdin) {
          putValue = new Uint8Array(await readStdin());
        } else {
          putValue = value!;
        }

        const result = await withSpinner(`Writing ${key}...`, () => node.vault.put(key, putValue)) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        outputJson({ key, written: true });
      } catch (error) {
        handleError(error);
      }
    });

  // tc vault get <key>
  vault
    .command("get <key>")
    .description("Decrypt and retrieve a value")
    .option("--raw", "Output raw value (no JSON wrapping)")
    .option("-o, --output <file>", "Write value to file")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (key: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const privateKey = resolvePrivateKey(options);
        const node = await ensureAuthenticated(ctx, { privateKey });

        await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));

        const result = await withSpinner(`Getting ${key}...`, () => node.vault.get(key)) as any;

        if (!result.ok) {
          if (result.error.code === "NOT_FOUND") {
            throw new CLIError("NOT_FOUND", `Key "${key}" not found`, ExitCode.NOT_FOUND);
          }
          throw cliErrorFromService(result.error);
        }

        const data = result.data.data ?? result.data;

        if (options.output) {
          const content = data instanceof Uint8Array ? Buffer.from(data) : typeof data === "string" ? data : JSON.stringify(data);
          await writeFile(options.output, content);
          outputJson({ key, written: options.output });
          return;
        }

        if (options.raw) {
          const content = data instanceof Uint8Array ? Buffer.from(data) : typeof data === "string" ? data : JSON.stringify(data);
          process.stdout.write(content);
          return;
        }

        outputJson({
          key,
          data: data instanceof Uint8Array ? Buffer.from(data).toString("base64") : data,
        });
      } catch (error) {
        handleError(error);
      }
    });

  // tc vault delete <key>
  vault
    .command("delete <key>")
    .description("Delete an encrypted key")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (key: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const privateKey = resolvePrivateKey(options);
        const node = await ensureAuthenticated(ctx, { privateKey });

        await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));

        const result = await withSpinner(`Deleting ${key}...`, () => node.vault.delete(key)) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        outputJson({ key, deleted: true });
      } catch (error) {
        handleError(error);
      }
    });

  // tc vault list
  vault
    .command("list")
    .description("List vault keys")
    .option("--prefix <prefix>", "Filter by key prefix")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const privateKey = resolvePrivateKey(options);
        const node = await ensureAuthenticated(ctx, { privateKey });

        await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));

        const listOptions = options.prefix ? { prefix: options.prefix } : undefined;
        const result = await withSpinner("Listing vault keys...", () => node.vault.list(listOptions)) as any;

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        const keys = result.data.data ?? result.data;
        const keyList = Array.isArray(keys) ? keys : [];

        outputJson({
          keys: keyList,
          count: keyList.length,
          prefix: options.prefix ?? null,
        });
      } catch (error) {
        handleError(error);
      }
    });

  // tc vault head <key>
  vault
    .command("head <key>")
    .description("Get metadata for a vault key")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (key: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const privateKey = resolvePrivateKey(options);
        const node = await ensureAuthenticated(ctx, { privateKey });

        await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));

        const result = await withSpinner(`Checking ${key}...`, () => node.vault.head(key)) as any;

        if (!result.ok) {
          if (result.error.code === "NOT_FOUND") {
            outputJson({ key, exists: false, metadata: {} });
            return;
          }
          throw cliErrorFromService(result.error);
        }

        outputJson({
          key,
          exists: true,
          metadata: result.data.headers ?? result.data,
        });
      } catch (error) {
        handleError(error);
      }
    });
}
