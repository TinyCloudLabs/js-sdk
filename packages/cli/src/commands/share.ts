import { Command } from "commander";
import {
  inspectShare,
  publishShare,
  receiveShare,
  SharePublishError,
  ShareReceiveError,
  type ShareErrorCode,
} from "@tinycloud/share-sdk";
import { parseDuration } from "../lib/duration.js";
import { CLIError, handleError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { inspectHuman, publishHuman, receiveHuman, receiveJson, writeJson } from "../share/output.js";
import { MAX_SHARE_STDIN_BYTES, readBoundedUrlStdin, readShareInput, writeShareOutput } from "../share/io.js";

const SHARE_ORIGIN = "https://share.tinycloud.xyz";
const DEFAULT_REGISTRY = `${SHARE_ORIGIN}/api/share/link-only/registry`;
const DEFAULT_READ_REGISTRY = "https://registry.tinycloud.xyz";

function shareCliError(error: unknown): CLIError {
  if (error instanceof CLIError) return error;
  if (error instanceof SharePublishError) {
    const exit = error.code === "upload-auth-required" ? 3 : error.code === "upload-failed" ? 6 : error.code === "max-bytes-exceeded" || error.code === "inline-too-large" ? 7 : error.code === "unsupported-target" || error.code === "invalid-argument" ? 2 : 1;
    const code = error.code === "upload-auth-required" ? "UPLOAD_AUTH_REQUIRED" : error.code === "max-bytes-exceeded" ? "MAX_BYTES_EXCEEDED" : error.code === "inline-too-large" ? "INLINE_TOO_LARGE" : error.code === "unsupported-target" ? "UNSUPPORTED_LINK" : error.code === "invalid-argument" ? "INVALID_ARGUMENT" : "NETWORK_ERROR";
    return new CLIError(code, error.message, exit);
  }
  if (error instanceof ShareReceiveError) {
    const verification = new Set<ShareErrorCode>(["cid-mismatch", "decrypt-failed", "envelope-invalid", "origin-mismatch", "signature-invalid", "capability-invalid", "content-integrity-failed"]);
    const exit = verification.has(error.code) ? 5 : error.code === "expired" || error.code === "fetch-failed" ? 4 : error.code === "invalid-link" || error.code === "unsupported-target" ? 2 : 1;
    const code = error.code === "fetch-failed" ? "NOT_FOUND" : error.code.replaceAll("-", "_").toUpperCase();
    return new CLIError(code, error.message, exit);
  }
  const message = error instanceof Error ? error.message : String(error);
  const known: Record<string, { code: string; exit: number }> = {
    MAX_BYTES_EXCEEDED: { code: "MAX_BYTES_EXCEEDED", exit: 7 },
    UNSAFE_FILENAME: { code: "UNSAFE_FILENAME", exit: 8 },
    OUTPUT_EXISTS: { code: "OUTPUT_EXISTS", exit: 8 },
    INVALID_ARGUMENT: { code: "INVALID_ARGUMENT", exit: 2 },
  };
  const mapped = known[message];
  return new CLIError(mapped?.code ?? "ERROR", mapped ? mapped.code : message, mapped?.exit ?? ExitCode.ERROR);
}

function inputUrl(value: string | undefined, stdin: boolean): Promise<string> {
  if (stdin || value === "-") return readBoundedUrlStdin();
  if (value === undefined || value.length === 0) throw new CLIError("INVALID_ARGUMENT", "a share URL or - is required", 2);
  return Promise.resolve(value);
}

function expires(value: string): Date {
  try { return new Date(Date.now() + parseDuration(value)); }
  catch { throw new CLIError("INVALID_ARGUMENT", "invalid expiry duration", 2); }
}

function byteLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_SHARE_STDIN_BYTES) throw new CLIError("MAX_BYTES_EXCEEDED", "max-bytes must be between 1 and 100 MiB", 7);
  return parsed;
}

export function registerShareCommand(program: Command): void {
  const share = program.command("share").description("Publish and consume TinyCloud Share links");

  share.command("publish <file>")
    .description("Publish a Markdown file or bounded stdin as a bearer share")
    .option("--name <filename>", "Filename for stdin input")
    .option("--to <target>", "Share target", "anyone")
    .option("--expires <duration>", "Share lifetime", "7d")
    .option("--max-bytes <bytes>", "Bound input bytes")
    .option("--inline", "Embed the sealed envelope in the URL fragment")
    .option("--compact", "Use a CID-addressed compact link (default)")
    .option("--json", "Print versioned redacted JSON")
    .option("--registry <url>", "Authenticated registry upload endpoint", DEFAULT_REGISTRY)
    .option("--viewer-origin <origin>", "Canonical HTTPS viewer origin", SHARE_ORIGIN)
    .option("--insecure-registry", "Allow an explicit localhost HTTP registry for hermetic tests")
    .action(async (file: string, options) => {
      try {
        if (options.inline && options.compact) throw new CLIError("INVALID_ARGUMENT", "--inline and --compact are mutually exclusive", 2);
        if (options.to !== "anyone") throw new CLIError("UNSUPPORTED_LINK", "this release publishes bearer shares only", 2);
        const maxBytes = byteLimit(options.maxBytes);
        const input = await readShareInput(file, options.name, maxBytes);
        const result = await publishShare({
          source: input.bytes,
          filename: input.filename,
          mediaType: "text/markdown",
          target: { kind: "bearer" },
          expiresAt: expires(options.expires),
          origin: options.viewerOrigin,
          inline: options.inline === true,
          ...(maxBytes === undefined ? {} : { maxBytes }),
          registryBaseUrl: options.registry,
          allowInsecureRegistry: options.insecureRegistry === true,
        });
        if (options.json) writeJson(result);
        else publishHuman(result);
      } catch (error) { handleError(shareCliError(error)); }
    });

  share.command("inspect [url]")
    .description("Verify a share link and print safe metadata")
    .option("--stdin", "Read the complete URL from stdin")
    .option("--json", "Print versioned redacted JSON")
    .option("--registry <url>", "Registry read endpoint", DEFAULT_READ_REGISTRY)
    .action(async (url: string | undefined, options) => {
      try {
        const link = await inputUrl(url, options.stdin === true);
        const result = await inspectShare(link, { registryBaseUrl: options.registry });
        if (options.json) writeJson(result);
        else inspectHuman(result);
      } catch (error) { handleError(shareCliError(error)); }
    });

  share.command("receive [url]")
    .description("Verify and receive a share link")
    .option("--stdin", "Read the complete URL from stdin")
    .option("--output <directory>", "Create the file in this directory")
    .option("--stdout", "Write verified plaintext bytes to stdout")
    .option("--force", "Allow replacing an existing non-symlink output")
    .option("--max-bytes <bytes>", "Bound received content bytes")
    .option("--json", "Print versioned redacted JSON")
    .option("--registry <url>", "Registry read endpoint", DEFAULT_READ_REGISTRY)
    .action(async (url: string | undefined, options) => {
      try {
        if (options.stdout && options.json) throw new CLIError("INVALID_ARGUMENT", "--stdout and --json are mutually exclusive", 2);
        const maxBytes = byteLimit(options.maxBytes);
        const link = await inputUrl(url, options.stdin === true);
        const result = await receiveShare(link, { registryBaseUrl: options.registry, ...(maxBytes === undefined ? {} : { maxContentBlobBytes: maxBytes, maxSealedBlobBytes: maxBytes }) });
        if (options.stdout) {
          process.stdout.write(Buffer.from(result.bytes));
          return;
        }
        const output = await writeShareOutput(options.output ?? ".", result.metadata.display.filename ?? "share.md", result.bytes, options.force === true);
        if (options.json) receiveJson(result, output);
        else receiveHuman(output);
      } catch (error) { handleError(shareCliError(error)); }
    });
}
