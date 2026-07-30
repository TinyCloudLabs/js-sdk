import { Command } from "commander";
import {
  inspectShare,
  receiveShare,
  SharePublishError,
  ShareReceiveError,
  publishTargetShare,
  isLegacyShareLink,
  receiveLegacyShare,
  migrateShare,
  listShares,
  showShare,
  notifyShare,
  revokeShare,
  redactPublishedShare,
  historyRecordForPublishedShare,
  type ShareTarget,
  type TargetPublishAdapter,
  type LegacyShareReader,
  type PublishedShare,
  type SharePublishOptions,
  type ShareFetchOptions,
  type ShareUpload,
  type ShareDeliveryAdapter,
  type ShareRevocationAdapter,
  type SenderShareRecord,
  type SenderShareRecordStorage,
  type ShareErrorCode,
} from "@tinycloud/share-sdk";
import { parseDuration } from "../lib/duration.js";
import { CLIError, handleError } from "../output/errors.js";
import { inspectHuman, publishHuman, receiveHuman, receiveJson, writeJson } from "../share/output.js";
import { MAX_SHARE_STDIN_BYTES, readBoundedUrlStdin, readShareInput, writeShareOutput } from "../share/io.js";

const SHARE_ORIGIN = "https://share.tinycloud.xyz";
const DEFAULT_REGISTRY = `${SHARE_ORIGIN}/api/share/link-only/registry`;
const DEFAULT_READ_REGISTRY = "https://registry.tinycloud.xyz";

export interface ShareCommandServices {
  readonly targetAdapter?: TargetPublishAdapter;
  readonly legacyReader?: LegacyShareReader<Uint8Array>;
  /** Production callers inject the existing authenticated Share upload path. */
  readonly uploadBlob?: ShareUpload;
  readonly authorizeUpload?: NonNullable<SharePublishOptions["authorizeUpload"]>;
  readonly authorization?: NonNullable<ShareFetchOptions["authorization"]>;
  readonly credentials?: "omit" | "same-origin" | "include";
  readonly fetchFn?: typeof globalThis.fetch;
  readonly records?: SenderShareRecordStorage;
  readonly delivery?: ShareDeliveryAdapter;
  readonly revocation?: ShareRevocationAdapter;
  readonly getRecord?: (shareId: string) => Promise<SenderShareRecord | undefined>;
  readonly linkFor?: (shareId: string) => Promise<string | undefined>;
}

let shareServices: ShareCommandServices = {};

export function configureShareCommandServices(services: ShareCommandServices): void {
  shareServices = services;
}

export function parseShareTarget(value: string): ShareTarget {
  if (value === "anyone" || value === "bearer") return { kind: "bearer" };
  if (value.startsWith("did:")) return { kind: "recipientDid", did: value };
  if (value.startsWith("domain:")) return { kind: "emailDomain", domain: value.slice("domain:".length) };
  if (value.startsWith("email:")) return { kind: "email", address: value.slice("email:".length) };
  if (value.includes("@")) return { kind: "email", address: value };
  throw new CLIError("INVALID_ARGUMENT", "--to must be anyone, a did:, an email address, or domain:example.com", 2);
}

function publishServices(): Pick<SharePublishOptions, "uploadBlob" | "authorizeUpload" | "authorizationOrigin" | "credentials" | "fetchFn"> {
  return {
    ...(shareServices.uploadBlob === undefined ? {} : { uploadBlob: shareServices.uploadBlob }),
    ...(shareServices.authorizeUpload === undefined ? {} : { authorizeUpload: shareServices.authorizeUpload }),
    ...(shareServices.authorizeUpload === undefined ? {} : { authorizationOrigin: SHARE_ORIGIN }),
    ...(shareServices.credentials === undefined ? {} : { credentials: shareServices.credentials }),
    ...(shareServices.fetchFn === undefined ? {} : { fetchFn: shareServices.fetchFn }),
  };
}

function fetchServices(): Pick<ShareFetchOptions, "fetchFn"> {
  return shareServices.fetchFn === undefined ? {} : { fetchFn: shareServices.fetchFn };
}

function shareCliError(error: unknown): CLIError {
  if (error instanceof CLIError) return error;
  if (error instanceof SharePublishError) {
    const exit = error.code === "upload-auth-required" ? 3 : error.code === "upload-failed" ? 4 : error.code === "max-bytes-exceeded" || error.code === "inline-too-large" ? 7 : error.code === "unsupported-target" || error.code === "invalid-argument" ? 2 : 1;
    const code = error.code === "upload-auth-required" ? "UPLOAD_AUTH_REQUIRED" : error.code === "upload-failed" ? "UNAVAILABLE" : error.code === "max-bytes-exceeded" ? "MAX_BYTES_EXCEEDED" : error.code === "inline-too-large" ? "INLINE_TOO_LARGE" : error.code === "unsupported-target" ? "UNSUPPORTED_LINK" : error.code === "invalid-argument" ? "INVALID_ARGUMENT" : "ERROR";
    return new CLIError(code, error.message, exit);
  }
  if (error instanceof ShareReceiveError) {
    const verification = new Set<ShareErrorCode>(["cid-mismatch", "decrypt-failed", "envelope-invalid", "origin-mismatch", "signature-invalid", "capability-invalid", "content-integrity-failed"]);
    const exit = error.code === "max-bytes-exceeded" ? 7 : verification.has(error.code) ? 5 : error.code === "expired" || error.code === "fetch-failed" ? 4 : error.code === "invalid-link" || error.code === "unsupported-target" ? 2 : 2;
    const code = error.code === "fetch-failed" ? "NOT_FOUND" : error.code.replaceAll("-", "_").toUpperCase();
    return new CLIError(code, error.message, exit);
  }
  const message = error instanceof Error ? error.message : String(error);
  const nodeCode = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  const known: Record<string, { code: string; exit: number }> = {
    MAX_BYTES_EXCEEDED: { code: "MAX_BYTES_EXCEEDED", exit: 7 },
    UNSAFE_FILENAME: { code: "UNSAFE_FILENAME", exit: 8 },
    OUTPUT_EXISTS: { code: "OUTPUT_EXISTS", exit: 8 },
    INVALID_ARGUMENT: { code: "INVALID_ARGUMENT", exit: 2 },
    "share not found": { code: "NOT_FOUND", exit: 4 },
  };
  if (nodeCode === "ENOENT") return new CLIError("INVALID_ARGUMENT", "share input was not found", 2);
  if (nodeCode === "EISDIR") return new CLIError("INVALID_ARGUMENT", "share input must be a Markdown file", 2);
  if (error instanceof TypeError) return new CLIError("INVALID_ARGUMENT", "share input is invalid", 2);
  const mapped = known[message];
  // Share adapters are external authority seams. Never echo an adapter's
  // arbitrary exception text to contract stdout/stderr; it may contain a
  // bearer URL, claim, session identifier, or provider response.
  return new CLIError(mapped?.code ?? "INVALID_ARGUMENT", mapped ? mapped.code : "share operation failed", mapped?.exit ?? 2);
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

async function rememberPublishedShare(result: PublishedShare): Promise<void> {
  if (shareServices.records === undefined) return;
  await shareServices.records.put(historyRecordForPublishedShare(result));
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
    .option("--notify", "Request idempotent email delivery for addressed targets")
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
        const maxBytes = byteLimit(options.maxBytes);
        const input = await readShareInput(file, options.name, maxBytes);
        const result = await publishTargetShare({
          source: input.bytes,
          filename: input.filename,
          mediaType: "text/markdown",
          target: parseShareTarget(options.to),
          expiresAt: expires(options.expires),
          origin: options.viewerOrigin,
          inline: options.inline === true,
          ...(maxBytes === undefined ? {} : { maxBytes }),
          registryBaseUrl: options.registry,
          allowInsecureRegistry: options.insecureRegistry === true,
          notify: options.notify === true,
          targetAdapter: shareServices.targetAdapter,
          ...publishServices(),
        });
        if ("state" in result) {
          if (options.json) {
            writeJson({ protocol: "tinycloud-share", version: 1, authorization: result });
            process.exitCode = 6;
            return;
          }
          throw new CLIError(result.method === "openkey-device" ? "DEVICE_AUTH_REQUIRED" : "CLAIM_REQUIRED", "recipient authorization is required; continue through the configured authority adapter", 6);
        }
        await rememberPublishedShare(result);
        if (options.json) writeJson(redactPublishedShare(result));
        else publishHuman(result);
      } catch (error) { handleError(shareCliError(error)); }
    });

  share.command("inspect [url]")
    .description("Verify a share link and print safe metadata")
    .option("--stdin", "Read the complete URL from stdin")
    .option("--json", "Print versioned redacted JSON")
    .option("--registry <url>", "Registry read endpoint", DEFAULT_READ_REGISTRY)
    .option("--viewer-origin <origin>", "Require this canonical Share origin", SHARE_ORIGIN)
    .action(async (url: string | undefined, options) => {
      try {
        const link = await inputUrl(url, options.stdin === true);
        const result = await inspectShare(link, { registryBaseUrl: options.registry, expectedOrigin: options.viewerOrigin, ...fetchServices() });
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
    .option("--resume-token <token>", "Resume a previously returned recipient authorization step")
    .option("--json", "Print versioned redacted JSON")
    .option("--registry <url>", "Registry read endpoint", DEFAULT_READ_REGISTRY)
    .option("--viewer-origin <origin>", "Require this canonical Share origin", SHARE_ORIGIN)
    .option("--legacy", "Read a legacy tc1: link (read-only)")
    .action(async (url: string | undefined, options) => {
      try {
        if (options.stdout && options.json) throw new CLIError("INVALID_ARGUMENT", "--stdout and --json are mutually exclusive", 2);
        const maxBytes = byteLimit(options.maxBytes);
        const link = await inputUrl(url, options.stdin === true);
        if (options.legacy) {
          if (!isLegacyShareLink(link) || shareServices.legacyReader === undefined) throw new CLIError("UNSUPPORTED_LINK", "legacy receive requires an installed read-only tc1 adapter", 2);
          const bytes = await receiveLegacyShare(link, shareServices.legacyReader);
          if (options.stdout) { process.stdout.write(Buffer.from(bytes)); return; }
          const output = await writeShareOutput(options.output ?? ".", "share.md", bytes, options.force === true);
          if (options.json) writeJson({ protocol: "tinycloud-share", version: 1, legacy: true, path: output }); else receiveHuman(output);
          return;
        }
        const result = await receiveShare(link, {
          registryBaseUrl: options.registry,
          expectedOrigin: options.viewerOrigin,
          ...fetchServices(),
          ...(maxBytes === undefined ? {} : { maxContentBlobBytes: maxBytes }),
          ...(shareServices.authorization === undefined ? {} : { authorization: shareServices.authorization }),
          ...(options.resumeToken === undefined ? {} : { authorizationResumeToken: options.resumeToken }),
        });
        if ("state" in result) {
          if (options.json) {
            writeJson({ protocol: "tinycloud-share", version: 1, authorization: result });
            process.exitCode = 6;
            return;
          }
          throw new CLIError(result.method === "openkey-device" ? "DEVICE_AUTH_REQUIRED" : "CLAIM_REQUIRED", "recipient authorization is required; resume through the configured authority adapter", 6);
        }
        if (options.stdout) {
          process.stdout.write(Buffer.from(result.bytes));
          return;
        }
        const output = await writeShareOutput(options.output ?? ".", result.metadata.display.filename ?? "share.md", result.bytes, options.force === true);
        if (options.json) receiveJson(result, output);
        else receiveHuman(output);
      } catch (error) { handleError(shareCliError(error)); }
    });

  share.command("migrate [url]")
    .description("Read a legacy tc1 link and re-mint a modern Share link")
    .option("--stdin", "Read the complete legacy link from stdin")
    .option("--name <filename>", "Filename for the migrated content", "migrated.md")
    .option("--to <target>", "Modern Share target", "anyone")
    .option("--notify", "Request idempotent email delivery for addressed targets")
    .option("--expires <duration>", "Modern share lifetime", "7d")
    .option("--max-bytes <bytes>", "Bound migrated content bytes")
    .option("--inline", "Embed the sealed envelope in the URL fragment")
    .option("--registry <url>", "Authenticated registry upload endpoint", DEFAULT_REGISTRY)
    .option("--viewer-origin <origin>", "Canonical HTTPS viewer origin", SHARE_ORIGIN)
    .option("--insecure-registry", "Allow an explicit localhost HTTP registry for hermetic tests")
    .option("--json", "Print versioned redacted JSON")
    .action(async (url: string | undefined, options) => {
      try {
        if (shareServices.legacyReader === undefined) throw new CLIError("UNSUPPORTED_LINK", "legacy migration requires an installed read-only tc1 adapter", 2);
        const link = await inputUrl(url, options.stdin === true);
        if (!isLegacyShareLink(link)) throw new CLIError("UNSUPPORTED_LINK", "only tc1: links can be migrated", 2);
        const maxBytes = byteLimit(options.maxBytes) ?? MAX_SHARE_STDIN_BYTES;
        const migrated = await migrateShare({
          link,
          reader: shareServices.legacyReader!,
          publish: async (bytes): Promise<PublishedShare> => {
            if (bytes.byteLength > maxBytes) throw new SharePublishError("max-bytes-exceeded", "legacy content exceeds the configured byte limit");
            const result = await publishTargetShare({
              source: bytes,
              filename: options.name,
              mediaType: "text/markdown",
              target: parseShareTarget(options.to),
              expiresAt: expires(options.expires),
              origin: options.viewerOrigin,
              inline: options.inline === true,
              registryBaseUrl: options.registry,
              allowInsecureRegistry: options.insecureRegistry === true,
              notify: options.notify === true,
              targetAdapter: shareServices.targetAdapter,
              ...publishServices(),
            });
            if ("state" in result) throw new CLIError(result.method === "openkey-device" ? "DEVICE_AUTH_REQUIRED" : "CLAIM_REQUIRED", "recipient authorization is required; continue through the configured authority adapter", 6);
            await rememberPublishedShare(result);
            return result;
          },
        });
        if (options.json) writeJson({ protocol: "tinycloud-share", version: 1, legacy: true, migrated: redactPublishedShare(migrated.migrated) });
        else publishHuman(migrated.migrated);
      } catch (error) { handleError(shareCliError(error)); }
    });

  share.command("list")
    .description("List encrypted sender history without complete bearer URLs")
    .option("--json", "Print versioned redacted JSON")
    .action(async (options) => {
      try {
        if (shareServices.records === undefined) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
        const result = await listShares(shareServices.records);
        if (options.json) writeJson({ protocol: "tinycloud-share", version: 1, shares: result });
        else process.stdout.write(result.map((item) => `${item.shareId}\t${item.target}\t${item.expiresAt}`).join("\n") + (result.length ? "\n" : ""));
      } catch (error) { handleError(shareCliError(error)); }
    });

  share.command("show <id>")
    .description("Show one redacted sender-history record")
    .option("--reveal-link", "Explicitly include the complete link")
    .option("--json", "Print versioned redacted JSON")
    .action(async (id: string, options) => {
      try {
        if (options.revealLink && options.json) throw new CLIError("INVALID_ARGUMENT", "--reveal-link cannot be combined with --json", 2);
        if (shareServices.records === undefined) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
        const result = await showShare({ storage: shareServices.records, shareId: id, revealLink: options.revealLink === true, link: options.revealLink ? await shareServices.linkFor?.(id) : undefined });
        if (options.json) writeJson({ protocol: "tinycloud-share", version: 1, share: result }); else writeJson(result);
      } catch (error) { handleError(shareCliError(error)); }
    });

  share.command("notify <id>")
    .description("Retry idempotent delivery without recreating the share")
    .requiredOption("--to <address>", "Recipient email")
    .option("--json", "Print versioned JSON")
    .action(async (id: string, options) => {
      try {
        if (shareServices.delivery === undefined) throw new CLIError("AUTH_REQUIRED", "delivery authority is not configured", 3);
        const result = await notifyShare({ shareId: id, recipient: options.to, adapter: shareServices.delivery });
        if (options.json) writeJson(result); else process.stdout.write(`${result.state}\n`);
        if (result.state === "partial-failure") process.exitCode = 9;
      } catch (error) { handleError(shareCliError(error)); }
    });

  share.command("revoke <id>")
    .description("Revoke addressed shares; report bearer retention honestly")
    .option("--ancestor", "Revoke the owner delegation ancestry")
    .option("--json", "Print versioned JSON")
    .action(async (id: string, options) => {
      try {
        if (shareServices.records === undefined) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
        const record = shareServices.getRecord ? await shareServices.getRecord(id) : await shareServices.records.get(id);
        if (record === undefined) throw new CLIError("NOT_FOUND", "share not found", 4);
        const result = await revokeShare({ record, adapter: shareServices.revocation, scope: options.ancestor ? "ancestor" : "direct" });
        if (result.state === "unsupported") {
          throw new CLIError("AUTH_REQUIRED", result.reason, 3);
        }
        if (options.json) writeJson({ protocol: "tinycloud-share", version: 1, result }); else process.stdout.write(`${result.state}\n`);
      } catch (error) { handleError(shareCliError(error)); }
    });
}
