import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";

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

function authOptions(options: { privateKey?: string }): { privateKey?: string } | undefined {
  const privateKey = options.privateKey || process.env.TC_PRIVATE_KEY;
  return privateKey ? { privateKey } : undefined;
}

function resolveSecretScope(options: { scope?: string; space?: string }): { scope?: string } | undefined {
  const scope = options.scope ?? options.space;
  return scope ? { scope } : undefined;
}

export function registerSecretsCommand(program: Command): void {
  const secrets = program.command("secrets").description("Encrypted secrets management");

  const network = secrets
    .command("network")
    .description("Manage the default secrets encryption network");

  network
    .command("show [nameOrNetworkId]")
    .description("Show a secrets encryption network")
    .option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)")
    .action(async (nameOrNetworkId: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx, authOptions(options));
        const requested = nameOrNetworkId ?? "default";
        const networkId = requested.startsWith("urn:tinycloud:encryption:")
          ? requested
          : node.getDefaultEncryptionNetworkId(requested);
        const descriptor = await withSpinner(
          "Fetching encryption network...",
          () => node.getEncryptionNetwork(requested),
        );
        outputJson({
          networkId,
          exists: descriptor !== null,
          ...(descriptor ? { descriptor } : {}),
        });
      } catch (error) {
        handleError(error);
      }
    });

  network
    .command("init [name]")
    .description("Create a secrets encryption network if needed")
    .option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)")
    .action(async (name: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx, authOptions(options));
        const descriptor = await withSpinner(
          "Ensuring encryption network...",
          () => node.ensureEncryptionNetwork(name ?? "default"),
        );
        outputJson({
          networkId: descriptor.networkId,
          state: descriptor.state,
          descriptor,
        });
      } catch (error) {
        handleError(error);
      }
    });

  // tc secrets list
  secrets
    .command("list")
    .description("List secrets")
    .option("--scope <scope>", "Logical secret scope")
    .option("--space <scope>", "Deprecated alias for --scope")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx, authOptions(options));
        const scopeOptions = resolveSecretScope(options);
        const result = await withSpinner(
          "Listing secrets...",
          () => node.secrets.list(scopeOptions),
        );

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        const secretNames = Array.isArray(result.data) ? result.data : [];
        const scope = options.scope ?? options.space;

        outputJson({
          secrets: secretNames,
          count: secretNames.length,
          ...(scope ? { scope } : {}),
        });
      } catch (error) {
        handleError(error);
      }
    });

  // tc secrets get <name>
  secrets
    .command("get <name>")
    .description("Get a secret value")
    .option("--scope <scope>", "Logical secret scope")
    .option("--space <scope>", "Deprecated alias for --scope")
    .option("--raw", "Output raw value (no JSON wrapping)")
    .option("-o, --output <file>", "Write value to file")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (name: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx, authOptions(options));
        const scopeOptions = resolveSecretScope(options);
        const result = await withSpinner(
          `Getting secret ${name}...`,
          () => node.secrets.get(name, scopeOptions),
        );

        if (!result.ok) {
          if (
            result.error.code === "NOT_FOUND" ||
            result.error.code === "KEY_NOT_FOUND"
          ) {
            throw new CLIError("NOT_FOUND", `Secret "${name}" not found`, ExitCode.NOT_FOUND);
          }
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        const value = String(result.data);

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

  // tc secrets put <name> [value]
  secrets
    .command("put <name> [value]")
    .description("Store a secret")
    .option("--scope <scope>", "Logical secret scope")
    .option("--space <scope>", "Deprecated alias for --scope")
    .option("--file <path>", "Read value from file")
    .option("--stdin", "Read value from stdin")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (name: string, value: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx, authOptions(options));

        // Determine value source
        let secretValue: string;
        const sources = [value !== undefined, !!options.file, !!options.stdin].filter(Boolean);

        if (sources.length === 0) {
          throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
        }
        if (sources.length > 1) {
          throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
        }

        if (options.file) {
          secretValue = (await readFile(options.file, "utf-8")) as string;
        } else if (options.stdin) {
          secretValue = (await readStdin()).toString("utf-8");
        } else {
          secretValue = value!;
        }

        const scopeOptions = resolveSecretScope(options);
        const result = await withSpinner(
          `Storing secret ${name}...`,
          () => node.secrets.put(name, secretValue, scopeOptions),
        );

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        outputJson({ name, written: true });
      } catch (error) {
        handleError(error);
      }
    });

  // tc secrets delete <name>
  secrets
    .command("delete <name>")
    .description("Delete a secret")
    .option("--scope <scope>", "Logical secret scope")
    .option("--space <scope>", "Deprecated alias for --scope")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (name: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx, authOptions(options));
        const scopeOptions = resolveSecretScope(options);
        const result = await withSpinner(
          `Deleting secret ${name}...`,
          () => node.secrets.delete(name, scopeOptions),
        );

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        outputJson({ name, deleted: true });
      } catch (error) {
        handleError(error);
      }
    });

  network
    .command("grant <recipientDid> [name]")
    .description("Grant decrypt permission for a secrets encryption network")
    .option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)")
    .action(async (recipientDid: string, name: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx, authOptions(options));
        const networkName = name ?? "default";
        const descriptor = await withSpinner(
          "Ensuring encryption network...",
          () => node.ensureEncryptionNetwork(networkName),
        );
        const permission = {
          service: "tinycloud.encryption",
          path: descriptor.networkId,
          actions: ["decrypt"],
        };
        const result = await withSpinner(
          `Granting decrypt permission to ${recipientDid}...`,
          () => node.delegateTo(recipientDid, [permission]),
        );

        outputJson({
          networkId: descriptor.networkId,
          recipientDid,
          cid: result.delegation.cid,
          prompted: result.prompted,
          path: result.delegation.path,
          actions: result.delegation.actions,
        });
      } catch (error) {
        handleError(error);
      }
    });

  // tc secrets manage
  secrets
    .command("manage")
    .description("Open the TinyCloud Secrets Manager in your browser")
    .action(async () => {
      try {
        const open = (await import("open")).default;
        await open("https://secrets.tinycloud.xyz");
        outputJson({ opened: "https://secrets.tinycloud.xyz" });
      } catch (error) {
        handleError(error);
      }
    });
}
