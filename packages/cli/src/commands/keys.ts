import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { NamedKeyError, createNamedKeyClient, type NamedKeyEnvelope } from "@tinycloud/node-sdk/encryption-keys";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { outputJson, withSpinner } from "../output/formatter.js";
import { CLIError, handleError } from "../output/errors.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import type { CLIContext, ProfileConfig } from "../config/types.js";
import { keyPathInPrefix, namedKeysNetworkId } from "../lib/named-keys.js";
import { validatePrivateOutput, writePrivateOutput } from "../lib/private-output.js";

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function readInput(file: string | undefined): Promise<Buffer> {
  return file === undefined ? readStdin() : readFile(file);
}

type KeysCommand = "ensure" | "encrypt" | "decrypt";

/** Map a named-key client failure onto the CLI's error codes, exit codes and one-line messages. */
function cliErrorFromNamedKey(error: unknown, command: KeysCommand, path: string): unknown {
  if (!(error instanceof NamedKeyError)) return error;
  switch (error.code) {
    case "NAMED_KEYS_UNSUPPORTED":
      return new CLIError("NAMED_KEYS_UNAVAILABLE", "This node doesn't support named keys.", ExitCode.NODE_ERROR);
    case "INVALID_KEY_TARGET":
    case "KEY_PATH_INVALID":
      return new CLIError("INVALID_KEY_PATH", "That key name isn't valid.", ExitCode.USAGE_ERROR);
    case "INVALID_ENVELOPE":
      return new CLIError("INVALID_ENVELOPE", "The envelope is damaged or incomplete.", ExitCode.USAGE_ERROR);
    case "KEY_NOT_FOUND":
      return new CLIError(
        "NOT_FOUND",
        command === "decrypt"
          ? "The key this envelope needs doesn't exist on this node, so it can't be decrypted here."
          : `There's no key at ${path} yet. Create it with \`${CLI_NAME} keys ensure ${path}\`.`,
        ExitCode.NOT_FOUND,
      );
    case "KEY_BLOCKED":
      return new CLIError("KEY_BLOCKED", `Key ${path} is blocked, so it can't be used.`, ExitCode.PERMISSION_DENIED);
    case "DECRYPT_FAILED":
      return new CLIError("DECRYPT_FAILED", `Couldn't decrypt this envelope with key ${path}.`, ExitCode.ERROR);
  }
  if (error.status === 401 || error.status === 403) {
    return new CLIError("PERMISSION_DENIED", error.message, ExitCode.PERMISSION_DENIED, {
      hint: `Sign in with \`${CLI_NAME} auth login --keys <folder>\` for this key's folder.`,
    });
  }
  return new CLIError(error.code, error.message, error.status === undefined ? ExitCode.ERROR : ExitCode.NODE_ERROR);
}

/**
 * Run a key call; when the account has no encryption network yet, create it once and retry once.
 * The session carries the network-create ability from sign-in.
 */
async function withNetworkSetup<T>(node: { ensureEncryptionNetwork(): Promise<unknown> }, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof NamedKeyError) || error.code !== "NETWORK_NOT_FOUND") throw error;
    await node.ensureEncryptionNetwork();
    return call();
  }
}

/** The prefix this profile's session was signed for, or a refusal. */
async function grantedPrefix(deps: KeysCommandDeps, profileName: string): Promise<string> {
  const profile = await deps.getProfile(profileName);
  const keys = profile.namedKeys;
  if (keys === undefined) {
    throw new CLIError(
      "KEYS_NOT_GRANTED",
      `Profile "${profileName}" can't use named keys yet. Sign in with \`${CLI_NAME} --profile ${profileName} auth login --keys <folder>\`.`,
      ExitCode.PERMISSION_DENIED,
    );
  }
  return keys.prefix;
}

function assertInGrantedPrefix(prefix: string, path: string, profileName: string): void {
  if (!keyPathInPrefix(prefix, path)) {
    throw new CLIError(
      "KEY_OUTSIDE_GRANTED_PREFIX",
      `Key "${path}" is outside the folder "${prefix}/" this sign-in covers. To use it, sign in with \`${CLI_NAME} --profile ${profileName} auth login --method local --keys <folder>\`.`,
      ExitCode.PERMISSION_DENIED,
    );
  }
}

function parseEnvelope(bytes: Buffer): NamedKeyEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CLIError("INVALID_ENVELOPE", "The input isn't an envelope (expected JSON).", ExitCode.USAGE_ERROR);
  }
  const envelope = parsed as Partial<NamedKeyEnvelope> | null;
  if (typeof envelope !== "object" || envelope === null || envelope.v !== 2 || typeof envelope.keyPath !== "string") {
    throw new CLIError("INVALID_ENVELOPE", "The input isn't a named-key envelope (it needs `\"v\": 2` and a `keyPath`).", ExitCode.USAGE_ERROR);
  }
  return envelope as NamedKeyEnvelope;
}

/** What the key commands reach outside themselves; tests pass stand-ins. */
export interface KeysCommandDeps {
  resolveContext(options: Record<string, unknown>): Promise<CLIContext>;
  getProfile(name: string): Promise<ProfileConfig>;
  authenticate(ctx: CLIContext): Promise<Awaited<ReturnType<typeof ensureAuthenticated>>>;
  createClient: typeof createNamedKeyClient;
  outputJson(payload: unknown): void;
  handleError(error: unknown): void | Promise<void>;
}

const defaultDeps: KeysCommandDeps = {
  resolveContext: (options) => ProfileManager.resolveContext(options),
  getProfile: (name) => ProfileManager.getProfile(name),
  authenticate: (ctx) => ensureAuthenticated(ctx),
  createClient: createNamedKeyClient,
  outputJson,
  handleError,
};

export function registerKeysCommand(program: Command, deps: KeysCommandDeps = defaultDeps): void {
  const { outputJson, handleError } = deps;
  const keys = program.command("keys").description(`Named encryption keys (sign in with \`${CLI_NAME} auth login --keys <folder>\` first)`);

  keys
    .command("ensure <path>")
    .description("Create the named key if it doesn't exist yet, then show it")
    .action(async (path: string, _options, cmd) => {
      try {
        const ctx = await deps.resolveContext(cmd.optsWithGlobals());
        assertInGrantedPrefix(await grantedPrefix(deps, ctx.profile), path, ctx.profile);
        const node = await deps.authenticate(ctx);
        const client = deps.createClient(node);
        const descriptor = await withSpinner(`Getting or creating key ${path}…`, () => withNetworkSetup(node, () => client.ensureKey(path))).catch((error) => {
          throw cliErrorFromNamedKey(error, "ensure", path);
        });
        outputJson({ ...descriptor });
      } catch (error) {
        await handleError(error);
      }
    });

  keys
    .command("encrypt <path>")
    .description("Encrypt data with a named key and output the encrypted envelope as JSON")
    .option("--in <file>", "Read the data to encrypt from a file (default: standard input)")
    .option("--out <file>", "Write the envelope to a file (default: standard output)")
    .action(async (path: string, options, cmd) => {
      try {
        const ctx = await deps.resolveContext(cmd.optsWithGlobals());
        assertInGrantedPrefix(await grantedPrefix(deps, ctx.profile), path, ctx.profile);
        if (options.out) await validatePrivateOutput(options.out, "--out");
        const plaintext = await readInput(options.in);
        const node = await deps.authenticate(ctx);
        const client = deps.createClient(node);
        const envelope = await withSpinner(`Encrypting with ${path}…`, () => withNetworkSetup(node, () => client.encrypt(path, plaintext))).catch((error) => {
          throw cliErrorFromNamedKey(error, "encrypt", path);
        });
        const json = JSON.stringify(envelope);
        if (options.out) {
          await writePrivateOutput(options.out, new TextEncoder().encode(json));
          outputJson({ keyPath: envelope.keyPath, networkId: envelope.networkId, written: options.out });
          return;
        }
        process.stdout.write(json + "\n");
      } catch (error) {
        await handleError(error);
      }
    });

  keys
    .command("decrypt")
    .description("Decrypt an envelope made with a named key and output the original data")
    .option("--in <file>", "Read the envelope from a file (default: standard input)")
    .option("--out <file>", "Write the decrypted data to a file (default: standard output)")
    .action(async (options, cmd) => {
      try {
        const ctx = await deps.resolveContext(cmd.optsWithGlobals());
        const prefix = await grantedPrefix(deps, ctx.profile);
        if (options.out) await validatePrivateOutput(options.out, "--out");
        const envelope = parseEnvelope(await readInput(options.in));
        assertInGrantedPrefix(prefix, envelope.keyPath, ctx.profile);
        const profile = await deps.getProfile(ctx.profile);
        if (profile.ownerDid !== undefined && envelope.networkId !== namedKeysNetworkId(profile.ownerDid)) {
          throw new CLIError(
            "KEY_OUTSIDE_GRANTED_PREFIX",
            "This envelope was made with a different encryption network than this profile's, so this profile can't decrypt it.",
            ExitCode.PERMISSION_DENIED,
          );
        }
        const node = await deps.authenticate(ctx);
        const client = deps.createClient(node);
        const plaintext = await withSpinner("Decrypting…", () => client.decrypt(envelope)).catch((error) => {
          throw cliErrorFromNamedKey(error, "decrypt", envelope.keyPath);
        });
        if (options.out) {
          await writePrivateOutput(options.out, plaintext);
          outputJson({ keyPath: envelope.keyPath, written: options.out });
          return;
        }
        process.stdout.write(plaintext);
      } catch (error) {
        await handleError(error);
      }
    });
}
