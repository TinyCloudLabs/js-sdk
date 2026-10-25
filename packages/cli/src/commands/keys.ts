import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { NamedKeyError, createNamedKeyClient, type NamedKeyEnvelope } from "@tinycloud/node-sdk/encryption-keys";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { outputJson, withSpinner } from "../output/formatter.js";
import { CLIError, handleError } from "../output/errors.js";
import { ensureAuthenticated } from "../lib/sdk.js";
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

const NAMED_KEY_EXIT: Partial<Record<string, { code: string; exit: number }>> = {
  NAMED_KEYS_UNSUPPORTED: { code: "NAMED_KEYS_UNAVAILABLE", exit: ExitCode.NODE_ERROR },
  INVALID_KEY_TARGET: { code: "INVALID_KEY_PATH", exit: ExitCode.USAGE_ERROR },
  KEY_PATH_INVALID: { code: "INVALID_KEY_PATH", exit: ExitCode.USAGE_ERROR },
  INVALID_ENVELOPE: { code: "INVALID_ENVELOPE", exit: ExitCode.USAGE_ERROR },
  KEY_NOT_FOUND: { code: "NOT_FOUND", exit: ExitCode.NOT_FOUND },
  KEY_BLOCKED: { code: "KEY_BLOCKED", exit: ExitCode.PERMISSION_DENIED },
  DECRYPT_FAILED: { code: "DECRYPT_FAILED", exit: ExitCode.ERROR },
};

/** Map a named-key client failure onto the CLI's error codes and exit codes. */
function cliErrorFromNamedKey(error: unknown): unknown {
  if (!(error instanceof NamedKeyError)) return error;
  const mapped = NAMED_KEY_EXIT[error.code];
  if (mapped) return new CLIError(mapped.code, error.message, mapped.exit);
  if (error.status === 401 || error.status === 403) {
    return new CLIError("PERMISSION_DENIED", error.message, ExitCode.PERMISSION_DENIED, {
      hint: `Sign in with \`${CLI_NAME} auth login --method local --keys <prefix>\` for the key's prefix.`,
    });
  }
  return new CLIError(error.code, error.message, error.status === undefined ? ExitCode.ERROR : ExitCode.NODE_ERROR);
}

/** The prefix this profile's session was signed for, or a refusal. */
async function grantedPrefix(profileName: string): Promise<string> {
  const profile = await ProfileManager.getProfile(profileName);
  const keys = profile.namedKeys;
  if (keys === undefined) {
    throw new CLIError(
      "KEYS_NOT_GRANTED",
      `Profile "${profileName}" has no named-key access. Sign in with \`${CLI_NAME} --profile ${profileName} auth login --method local --keys <prefix>\`.`,
      ExitCode.PERMISSION_DENIED,
    );
  }
  return keys.prefix;
}

function assertInGrantedPrefix(prefix: string, path: string, profileName: string): void {
  if (!keyPathInPrefix(prefix, path)) {
    throw new CLIError(
      "KEY_OUTSIDE_GRANTED_PREFIX",
      `Key "${path}" is outside the prefix "${prefix}/" this session was signed for. Sign in with \`${CLI_NAME} --profile ${profileName} auth login --method local --keys <prefix>\` for that key.`,
      ExitCode.PERMISSION_DENIED,
    );
  }
}

function parseEnvelope(bytes: Buffer): NamedKeyEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CLIError("INVALID_ENVELOPE", "The input is not a JSON envelope.", ExitCode.USAGE_ERROR);
  }
  const envelope = parsed as Partial<NamedKeyEnvelope> | null;
  if (typeof envelope !== "object" || envelope === null || envelope.v !== 2 || typeof envelope.keyPath !== "string") {
    throw new CLIError("INVALID_ENVELOPE", "The input is not a v2 named-key envelope.", ExitCode.USAGE_ERROR);
  }
  return envelope as NamedKeyEnvelope;
}

export function registerKeysCommand(program: Command): void {
  const keys = program.command("keys").description("Named encryption keys (sign in with `auth login --keys <prefix>`)");

  keys
    .command("ensure <path>")
    .description("Create the named key if it does not exist and report it")
    .action(async (path: string, _options, cmd) => {
      try {
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        assertInGrantedPrefix(await grantedPrefix(ctx.profile), path, ctx.profile);
        const node = await ensureAuthenticated(ctx);
        const client = createNamedKeyClient(node);
        const descriptor = await withSpinner(`Ensuring ${path}...`, () => client.ensureKey(path)).catch((error) => {
          throw cliErrorFromNamedKey(error);
        });
        outputJson({ ...descriptor });
      } catch (error) {
        return handleError(error);
      }
    });

  keys
    .command("encrypt <path>")
    .description("Encrypt input to a named key and write the envelope as JSON")
    .option("--in <file>", "Read plaintext from a file (default: stdin)")
    .option("--out <file>", "Write the envelope to a file (default: stdout)")
    .action(async (path: string, options, cmd) => {
      try {
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        assertInGrantedPrefix(await grantedPrefix(ctx.profile), path, ctx.profile);
        if (options.out) await validatePrivateOutput(options.out, "--out");
        const plaintext = await readInput(options.in);
        const node = await ensureAuthenticated(ctx);
        const client = createNamedKeyClient(node);
        const envelope = await withSpinner(`Encrypting to ${path}...`, () => client.encrypt(path, plaintext)).catch((error) => {
          throw cliErrorFromNamedKey(error);
        });
        const json = JSON.stringify(envelope);
        if (options.out) {
          await writePrivateOutput(options.out, new TextEncoder().encode(json));
          outputJson({ keyPath: envelope.keyPath, networkId: envelope.networkId, written: options.out });
          return;
        }
        process.stdout.write(json + "\n");
      } catch (error) {
        return handleError(error);
      }
    });

  keys
    .command("decrypt")
    .description("Decrypt a named-key envelope and write the raw bytes")
    .option("--in <file>", "Read the envelope JSON from a file (default: stdin)")
    .option("--out <file>", "Write the plaintext to a file (default: stdout)")
    .action(async (options, cmd) => {
      try {
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const prefix = await grantedPrefix(ctx.profile);
        if (options.out) await validatePrivateOutput(options.out, "--out");
        const envelope = parseEnvelope(await readInput(options.in));
        assertInGrantedPrefix(prefix, envelope.keyPath, ctx.profile);
        const profile = await ProfileManager.getProfile(ctx.profile);
        if (profile.ownerDid !== undefined && envelope.networkId !== namedKeysNetworkId(profile.ownerDid)) {
          throw new CLIError(
            "KEY_OUTSIDE_GRANTED_PREFIX",
            `The envelope belongs to a different network than this profile's ${namedKeysNetworkId(profile.ownerDid)}.`,
            ExitCode.PERMISSION_DENIED,
          );
        }
        const node = await ensureAuthenticated(ctx);
        const client = createNamedKeyClient(node);
        const plaintext = await withSpinner("Decrypting...", () => client.decrypt(envelope)).catch((error) => {
          throw cliErrorFromNamedKey(error);
        });
        if (options.out) {
          await writePrivateOutput(options.out, plaintext);
          outputJson({ keyPath: envelope.keyPath, written: options.out });
          return;
        }
        process.stdout.write(plaintext);
      } catch (error) {
        return handleError(error);
      }
    });
}
