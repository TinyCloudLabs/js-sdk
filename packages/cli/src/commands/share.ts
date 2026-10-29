import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import {
  ArtifactError,
  assertArtifactId,
  listArtifactVersions,
  newArtifactId,
  parseArtifactVersionPath,
  type ArtifactStore,
} from "@tinycloud/share-sdk/artifact";
import {
  ADDRESSED_SHARE_TOO_LARGE_MESSAGE,
  inspectShare,
  receiveShare,
  SharePublishError,
  ShareReceiveError,
  publishTargetShare,
  parseNativeShareUrl,
  listShares,
  showShare,
  notifyShare,
  normalizeShareTarget,
  recipientMatchesShareRecord,
  shareDeliveryWindowExpiresAt,
  ShareNotifyError,
  revokeShare,
  redactPublishedShare,
  historyRecordForPublishedShare,
  type ShareTarget,
  type TargetPublishAdapter,
  type PublishedShare,
  type ShareDeliveryAdapter,
  type ShareRevocationAdapter,
  type SenderShareRecord,
  type SenderShareRecordStorage,
  type ShareErrorCode,
  type ShareNotifyResult,
} from "@tinycloud/share-sdk";
import { canonicalMailbox } from "@tinycloud/share-envelope";
import { ProfileLockTimeoutError } from "@tinycloud/operations/state";
import { parseDuration } from "../lib/duration.js";
import { CLIError, handleError, storageFullError, wrapError } from "../output/errors.js";
import { classifyShareFailure, unknownShareDiagnostic } from "../share/failure-class.js";
import productionEmailDescriptor from "../share/email-descriptor.json";
import { authorizationRequiredJson, inspectHuman, publishHuman, receiveHuman, receiveJson, writeJson } from "../share/output.js";
import { MAX_SHARE_STDIN_BYTES, readBoundedUrlStdin, readShareInput, shareInputFilename, writeShareOutput } from "../share/io.js";
import { quarantineUnreadableProfileHistory } from "../share/adapters.js";
import { ProfileManager } from "../config/profiles.js";
import { FOLDER_NOT_AVAILABLE, bundleHtmlFolder, htmlFolderNotice, isDirectoryInput } from "../share/html-folder.js";

import { ShareHistoryReadError, ShareHistoryRetryError, ShareHistoryUnreadableError, SharePublishAuthorityError, shareHistoryReason, type ShareHistoryStatus } from "../share/errors.js";
import { linkFailureReason, shortLinkId, type ShareLinks, type ShownLink } from "../share/short-links.js";
const SHARE_ORIGIN = "https://share.tinycloud.xyz";
const NOTIFY_WINDOW_MESSAGE = "Share notification authorization expired (at share expiry or 5 minutes after publication); publish a new share and invite the recipient then.\n";
const INVITATIONS_UNAVAILABLE_MESSAGE = "Invitation emails are not available yet.";
const NOTIFY_NEEDS_SHORT_LINK_MESSAGE = "This share has no short link, and an invitation email carries only a short link, so no invitation was sent. Publish it again to get one.";

export interface ShareCommandServices {
  readonly targetAdapter?: TargetPublishAdapter;
  readonly nativeReader?: (link: string) => Promise<{ readonly bytes: Uint8Array; readonly filename: string }>;
  readonly records?: SenderShareRecordStorage;
  readonly delivery?: ShareDeliveryAdapter;
  readonly revocation?: ShareRevocationAdapter;
  /** Probe the authenticated node before a standalone domain invitation. */
  readonly assertDomainDelivery?: () => Promise<void>;
  readonly getRecord?: (shareId: string) => Promise<SenderShareRecord | undefined>;
  /** Links for addressed shares (TC-1737). */
  readonly links?: ShareLinks;
  /**
   * Whether the node and the witness that send invitation emails accept short links (contract deploy steps 2 and 3).
   * Until they do, `share notify` and `share publish --notify` refuse before sending or publishing anything.
   */
  readonly shortLinkInvitations?: boolean;
  /** The authenticated owner's artifact storage, for `tc share versions`. */
  readonly artifactStore?: () => Promise<ArtifactStore>;
}

/** `--ongoing` has no working implementation in v1: every artifact share pins one version. */
const ONGOING_UNAVAILABLE = "Ongoing shares are not available yet; v1 shares pin a version";

/** Validate the artifact flags once and name the pinned version request, if any. `--ongoing` is refused earlier. */
function artifactRequest(
  options: { readonly artifact?: string; readonly note?: string; readonly prefix?: boolean },
  actions: readonly ("read" | "list" | "edit")[],
  inputCount: number,
): { readonly id: string; readonly note?: string } | undefined {
  if (options.artifact === undefined) {
    if (options.note !== undefined) throw new CLIError("INVALID_ARGUMENT", "--note requires --artifact", 2);
    return undefined;
  }
  // A pinned path is immutable and never carries put.
  if (actions.includes("edit")) {
    throw new CLIError("INVALID_ARGUMENT", "--action edit is not available for artifact shares: a pinned version is read-only", 2);
  }
  // `--prefix` publishes a folder; an artifact share reads exactly one pinned file.
  if (options.prefix === true) throw new CLIError("INVALID_ARGUMENT", "--artifact does not combine with --prefix: an artifact share pins one file", 2);
  if (inputCount !== 1) throw new CLIError("INVALID_ARGUMENT", "an artifact share takes exactly one file", 2);
  const note = options.note;
  if (note !== undefined && (note.length === 0 || note.length > 1024)) throw new CLIError("INVALID_ARGUMENT", "--note must be 1 to 1024 characters", 2);
  return { id: options.artifact === "new" ? newArtifactId() : assertArtifactId(options.artifact), ...(note === undefined ? {} : { note }) };
}

let shareServices: ShareCommandServices = {};

export function configureShareCommandServices(services: ShareCommandServices): void {
  shareServices = services;
}

export function parseShareTarget(value: string): ShareTarget {
  if (value === "anyone" || value === "bearer") return { kind: "bearer" };
  if (value.startsWith("did:")) return { kind: "recipientDid", did: value };
  if (value.startsWith("domain:")) return canonicalMailboxTarget({ kind: "emailDomain", domain: value.slice("domain:".length) });
  if (value.startsWith("email:")) return canonicalMailboxTarget({ kind: "email", address: value.slice("email:".length) });
  if (value.includes("@")) return canonicalMailboxTarget({ kind: "email", address: value });
  throw new CLIError("INVALID_ARGUMENT", "--to must be anyone, a did:, an email address, or domain:example.com", 2);
}

/** The issuer-canonical recipient, refused up front with the SDK's specific reason. */
function canonicalMailboxTarget(target: Extract<ShareTarget, { readonly kind: "email" | "emailDomain" }>): ShareTarget {
  try {
    return normalizeShareTarget(target);
  } catch (error) {
    throw new CLIError("INVALID_ARGUMENT", error instanceof TypeError ? error.message : "share recipient is invalid", 2);
  }
}

const SHARE_HISTORY_RECOVER_FS_ERRNO: Record<string, true> = { EACCES: true, EEXIST: true, EIO: true, ENOSPC: true, ENOTSUP: true, EPERM: true, EROFS: true, EXDEV: true };

/** @internal Map fs failures from `share history recover`. The original history file is never deleted on these paths. */
export function shareHistoryRecoverError(error: unknown): CLIError {
  if (error instanceof ShareHistoryReadError) {
    return new CLIError("SHARE_HISTORY_RECOVER_FAILED", "could not read the unreadable sender history to move it aside", 1, { hint: "The original history file was not deleted. Check read permission on the history file, then retry." });
  }
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code !== undefined && SHARE_HISTORY_RECOVER_FS_ERRNO[code] === true) {
    return new CLIError("SHARE_HISTORY_RECOVER_FAILED", `could not move the unreadable sender history aside (${code})`, 1, { hint: "The original history file was not deleted. Check write permission on the profile directory, then retry." });
  }
  return shareCliError(error);
}

/** @internal Map known failures to fixed diagnostics; redact unknown error names and messages. */
export function shareCliError(error: unknown, operation: "publish" | "notify" = "publish"): CLIError {
  if (error instanceof CLIError) return error;
  if (error instanceof ArtifactError) {
    if (error.code === "invalid-argument") return new CLIError("INVALID_ARGUMENT", error.message, 2);
    if (error.code === "conflict") return new CLIError("ARTIFACT_CONFLICT", error.message, 1, { hint: "Another publisher is writing this artifact; retry." });
    return new CLIError("UNAVAILABLE", error.message, 4);
  }
  if (error instanceof ProfileLockTimeoutError) return wrapError(error);
  if (error instanceof ShareHistoryRetryError) {
    return new CLIError(
      "SHARE_HISTORY_RETRY",
      `sender history for profile ${JSON.stringify(error.profile)} changed or disappeared during this command`,
      1,
      { hint: `Retry this command with --profile ${JSON.stringify(error.profile)}. If this was a revoke, check its node state first: revocation may already have succeeded.` },
    );
  }
  if (error instanceof ShareHistoryUnreadableError) {
    return new CLIError(
      "SHARE_HISTORY_UNREADABLE",
      "sender history cannot be read with the current session key",
      1,
      { hint: `Run \`${CLI_NAME} share history recover\` to move the unreadable file aside. The old file is kept, not deleted.` },
    );
  }
  if (error instanceof SharePublishAuthorityError) {
    const failure = error.failure;
    const profileName = "profileName" in failure ? failure.profileName : undefined;
    const localKey = "localKey" in failure && failure.localKey === true;
    const profileHint = profileName === undefined ? "" : `--profile ${profileName} `;
    // A local-key profile signs in again with its key. Any other profile gets
    // the publishing scope through OpenKey device login.
    const loginHint = localKey
      ? `\`${CLI_NAME} ${profileHint}auth login --method local\``
      : `\`${CLI_NAME} ${profileHint}auth login --device --manifest builtin:share-publishing\` (or \`${CLI_NAME} ${profileHint}enable share\`)`;
    if (failure.kind === "caveated-session") {
      const holder = profileName === undefined ? "this session" : `profile ${profileName}'s session`;
      return new CLIError(
        "PERMISSION_DENIED",
        `${holder} carries signed restrictions (caveats) on the authority an anyone-with-link share needs, so it cannot create the share link; nothing was shared. Approve Share publishing without restrictions on a new, dedicated profile (any unused name): \`${CLI_NAME} init --name publisher --key-only && ${CLI_NAME} --profile publisher enable share\``,
        5,
      );
    }
    if (failure.kind === "owner-space-unresolved") {
      return new CLIError("AUTH_REQUIRED", `a valid signed TinyCloud session is required; run ${loginHint}`, 3);
    }
    if (failure.kind === "scope-denied") {
      const requiredAction = failure.requiredAction === undefined ? "" : ` (${failure.requiredAction})`;
      const renew = localKey
        ? `renew it with ${loginHint} using the required capability`
        : `verify the session includes the builtin:share-publishing scope; if it does not, request it with ${loginHint}`;
      return new CLIError("PERMISSION_DENIED", `the session lacks ${failure.capability} authority${requiredAction}; ${renew}`, 5);
    }
    if (failure.kind === "lifetime-exceeds-session") {
      const expiresAt = failure.sessionExpiresAt.toISOString();
      if (failure.reason === "session-too-close") {
        return new CLIError("AUTH_REQUIRED", `the signed session expires too soon (${expiresAt}); log in again with ${loginHint}`, 3);
      }
      if (failure.reason === "below-minimum") {
        return new CLIError("SESSION_LIFETIME_EXCEEDED", "share expiry must be at least 60 seconds from now; use a longer --expires value", 2);
      }
      return new CLIError("SESSION_LIFETIME_EXCEEDED", `requested share lifetime exceeds session expiry ${expiresAt}; use a shorter --expires value or renew the session with ${loginHint}`, 2);
    }
    if (failure.kind === "origin-mismatch") {
      return new CLIError("ORIGIN_MISMATCH", "share origin does not match the configured service", 2);
    }
    if (failure.kind === "invalid-request") {
      return new CLIError("INVALID_ARGUMENT", failure.reason, 2);
    }
    if (failure.kind === "registry-unavailable") {
      return new CLIError("UNAVAILABLE", "the TinyCloud location registry could not be reached, so nothing was shared; try again shortly", 4);
    }
    if (failure.kind === "share-service-unavailable") {
      const outcome = operation === "publish" ? "nothing was shared" : "no invitation was sent";
      return new CLIError("SHARE_SERVICE_UNAVAILABLE", `the Share service at ${failure.origin} could not be reached, so ${outcome}; try again shortly`, 4);
    }
    if (failure.kind === "node-info-unavailable") {
      const outcome = operation === "publish" ? "nothing was shared and no invitation was sent" : "no invitation was sent";
      return new CLIError("UNAVAILABLE", `could not verify TinyCloud node 1.17.3 domain delivery support; ${outcome}. Check the node and retry`, 4);
    }
    if (failure.kind === "registry-rejected") {
      return new CLIError("REGISTRY_REJECTED", "the TinyCloud location registry rejected this session's location record, so nothing was shared; retrying will not help. Log in again, and report the problem if it persists", 6);
    }
    if (failure.kind === "storage-full") {
      return storageFullError(failure)!;
    }
    if (failure.kind === "space-not-ready") {
      // The Node's own error stays on `cause`; its text never reaches output.
      return Object.assign(
        new CLIError(
          "SPACE_NOT_READY",
          "Your TinyCloud space isn't ready for this yet (SPACE_NOT_READY). This is a known node problem being fixed: retry after the node update; contact support with this code if it persists.",
          4,
          { hint: "Nothing was shared, and repeating the command is safe. Retries keep failing until the node is updated." },
        ),
        { cause: error.cause },
      );
    }
    if (failure.kind === "upload-failed") {
      return new CLIError("UPLOAD_FAILED", "share source upload failed; nothing was shared", 4);
    }
    if (failure.kind === "decrypt-not-held") {
      const profile = failure.profileName === undefined ? "" : `--profile '${failure.profileName.replaceAll("'", "'\\''")}' `;
      return new CLIError("PERMISSION_DENIED", `This session lacks decrypt authority for email shares. Nothing was shared. Run \`${CLI_NAME} ${profile}auth request --grant --cap tinycloud.encryption:default:share/:decrypt\`, approve the single OpenKey request for the owner's default-network share/ keys, then retry this publish. No new login is needed.`, 5);
    }
    if (failure.kind === "over-limit") {
      return new CLIError("MAX_BYTES_EXCEEDED", ADDRESSED_SHARE_TOO_LARGE_MESSAGE, 7, { hint: `What stays behind: ${failure.remaining.join("; ")}.` });
    }
  }
  // Fixed SDK refusals (invalid or mismatched recipient); never remote text.
  if (error instanceof ShareNotifyError) {
    return new CLIError("INVALID_ARGUMENT", error.message, 2);
  }
  if (error instanceof SharePublishError) {
    const exit = error.code === "authority-required" ? 3 : error.code === "max-bytes-exceeded" ? 7 : 2;
    const code = error.code === "authority-required" ? "AUTH_REQUIRED" : error.code === "max-bytes-exceeded" ? "MAX_BYTES_EXCEEDED" : "INVALID_ARGUMENT";
    return new CLIError(code, error.message, exit);
  }
  if (error instanceof ShareReceiveError) {
    const verification = new Set<ShareErrorCode>(["cid-mismatch", "decrypt-failed", "envelope-invalid", "origin-mismatch", "signature-invalid", "capability-invalid", "content-integrity-failed"]);
    const exit = error.code === "max-bytes-exceeded" ? 7 : verification.has(error.code) ? 5 : error.code === "expired" || error.code === "fetch-failed" ? 4 : error.code === "invalid-link" || error.code === "unsupported-target" ? 2 : 2;
    const code = error.code === "fetch-failed" ? "NOT_FOUND" : error.code.replaceAll("-", "_").toUpperCase();
    return new CLIError(code, error.message, exit);
  }
  // Any other write the share flow makes (history, delegations) can hit full storage too.
  const storageFull = storageFullError(error);
  if (storageFull) return storageFull;
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
    AUTH_REQUIRED: { code: "AUTH_REQUIRED", exit: 3 },
    UNAVAILABLE: { code: "UNAVAILABLE", exit: 4 },
  };
  if (nodeCode === "ENOENT") return new CLIError("INVALID_ARGUMENT", "share input was not found", 2);
  if (nodeCode === "EISDIR") return new CLIError("INVALID_ARGUMENT", "share input must be a Markdown file", 2);
  const mapped = typeof nodeCode === "string" && known[nodeCode] !== undefined ? known[nodeCode] : known[message];
  // A node or network failure no mapping above claimed (an HTTP status from a
  // policy, delegation, revoke or delivery call; an unreachable node) is named
  // by class and status instead of collapsing into an invalid-argument error.
  const classified = mapped === undefined ? classifyShareFailure(error, `\`${CLI_NAME} auth login\``) : undefined;
  if (classified !== undefined) return Object.assign(new CLIError(classified.code, classified.reason, classified.exitCode), { cause: error });
  return new CLIError(mapped?.code ?? "INVALID_ARGUMENT", mapped ? mapped.code : unknownShareDiagnostic(error), mapped?.exit ?? 2);
}

function inputUrl(value: string | undefined, stdin: boolean): Promise<string> {
  if (stdin || value === "-") return readBoundedUrlStdin();
  if (value === undefined || value.length === 0) throw new CLIError("INVALID_ARGUMENT", "a share URL or - is required", 2);
  return Promise.resolve(value);
}

/**
 * A link that parses as a URL but is not at the trusted Share origin is an origin mismatch (exit 5),
 * refused before any request. Checked here rather than in share-sdk, so the browser SDK bundle does
 * not grow; anything that does not parse is left to share-sdk (invalid-link).
 */
function assertTrustedShareOrigin(link: string, expectedOrigin: string): void {
  if (URL.canParse(link) && new URL(link).origin !== expectedOrigin) {
    throw new ShareReceiveError("origin-mismatch", "share link origin is not the trusted Share origin");
  }
}

/** @internal Command seam that guarantees stdin is consumed exactly once. */
export async function inspectShareInputOnce(
  value: string | undefined,
  stdin: boolean,
  expectedOrigin: string,
  dependencies: {
    readonly read?: () => Promise<string>;
    readonly inspect?: typeof inspectShare;
  } = {},
): ReturnType<typeof inspectShare> {
  const link = stdin || value === "-"
    ? await (dependencies.read ?? readBoundedUrlStdin)()
    : await inputUrl(value, false);
  try {
    parseNativeShareUrl(link);
  } catch {
    assertTrustedShareOrigin(link, expectedOrigin);
    return (dependencies.inspect ?? inspectShare)(link, { expectedOrigin });
  }
  // Native bearer links are minted at the Share origin too; one from elsewhere is refused first.
  assertTrustedShareOrigin(link, expectedOrigin);
  throw new CLIError("UNSUPPORTED_LINK", "native bearer links are opaque; receive the link to verify access", 2);
}

function jsonOutput(options: { readonly json?: boolean }, command: Command): boolean {
  return options.json === true || command.optsWithGlobals().json === true;
}

function expires(value: string): Date {
  try { return new Date(Date.now() + parseDuration(value)); }
  catch { throw new CLIError("INVALID_ARGUMENT", "invalid expiry duration", 2); }
}

async function rememberPublishedShare(result: PublishedShare, link: string): Promise<{ record: SenderShareRecord; history: ShareHistoryStatus }> {
  // History keeps the link text the share printed: the short link when there is one, so `unlink` can find its id.
  const record: SenderShareRecord = { ...historyRecordForPublishedShare(result), link };
  try {
    if (shareServices.records === undefined) throw new Error("sender history is not configured");
    await shareServices.records.put(record);
    return { record, history: { recorded: true } };
  } catch (error) {
    const reason = shareHistoryReason(error);
    process.stderr.write(`Warning: share was published but not recorded in sender history (${reason}); future share list, share notify, and share revoke by ID will not find it. Keep share ID ${result.metadata.shareId} and CID ${result.link.cid}.\n`);
    return { record, history: { recorded: false, reason } };
  }
}

function assertInvitationsAvailable(outcome: string): void {
  if (shareServices.shortLinkInvitations !== true) throw new CLIError("UNAVAILABLE", `${INVITATIONS_UNAVAILABLE_MESSAGE} ${outcome}`, 4);
}

async function notifyRecordedShare(record: SenderShareRecord, recipient: string, adapter: ShareDeliveryAdapter, storage?: SenderShareRecordStorage, published?: { readonly shareId: string; readonly cid: string }): Promise<ShareNotifyResult> {
  const result = await notifyShare({ shareId: record.shareId, recipient, record, adapter, checkDeliveryWindow: true });
  if (result.state !== "partial-failure" && storage !== undefined) {
    const mailbox = canonicalMailbox(recipient)!.email;
    if (!record.deliveredRecipients?.includes(mailbox)) {
      try {
        if (storage.update === undefined) throw new Error("atomic sender history update is unavailable");
        const updated = await storage.update(record.shareId, (current) => ({
          ...current,
          deliveredRecipients: current.deliveredRecipients?.includes(mailbox)
            ? current.deliveredRecipients
            : [...(current.deliveredRecipients ?? []), mailbox],
        }));
        if (updated === undefined) throw new Error("sender history record was removed");
      } catch (error) {
        const reason = shareHistoryReason(error);
        const identifiers = published === undefined ? "" : ` Keep share ID ${published.shareId} and CID ${published.cid}.`;
        process.stderr.write(`Warning: delivery succeeded, but could not record its confirmation in sender history (${reason}).${identifiers}\n`);
      }
    }
  }
  return result;
}

function byteLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_SHARE_STDIN_BYTES) throw new CLIError("MAX_BYTES_EXCEEDED", "max-bytes must be between 1 and 100 MiB", 7);
  return parsed;
}

function mediaTypeFor(filename: string): string {
  const extension = filename.toLowerCase().split(".").at(-1);
  return extension === "md" || extension === "markdown" ? "text/markdown"
    : extension === "txt" ? "text/plain"
      : extension === "html" || extension === "htm" ? "text/html"
        : extension === "json" ? "application/json"
          : extension === "css" ? "text/css"
            : extension === "js" ? "text/javascript"
              : extension === "jsx" ? "text/jsx"
                : extension === "tsx" ? "text/tsx"
                  : "application/octet-stream";
}

function requestedActions(values: readonly string[] | undefined): readonly ("read" | "list" | "edit")[] {
  const actions = values === undefined || values.length === 0 ? ["read"] : values;
  if (actions.some((value) => value !== "read" && value !== "list" && value !== "edit")) throw new CLIError("INVALID_ARGUMENT", "--action must be read, list, or edit", 2);
  return [...new Set(actions)] as ("read" | "list" | "edit")[];
}

function assertAggregateInputLimit(inputs: readonly { readonly bytes: Uint8Array }[], maxBytes: number | undefined): void {
  const limit = maxBytes ?? MAX_SHARE_STDIN_BYTES;
  let total = 0;
  for (const input of inputs) {
    total += input.bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > limit) throw new CLIError("MAX_BYTES_EXCEEDED", "combined share input exceeds the configured byte limit", 7);
  }
}

export function registerShareCommand(program: Command): void {
  const share = program.command("share").description("Publish and consume TinyCloud Share links");

  share.command("publish <files...>")
    .description("Publish one or more bounded files as a Share, or a folder with an index.html as one self-contained page (anyone links only)")
    .option("--name <filename>", "Filename for stdin input, or the published .html name of a folder")
    .option("--to <target>", "Share target", "anyone")
    .option("--credential-descriptor <path>", "Override the production tinycloud.email-proof/v1 descriptor with a JSON file")
    .option("--issuer-did <did>", "Override the trusted production email issuer (did:web:issuer.credentials.org)")
    .option("--issuer-kid <kid>", "Override the trusted production email key (did:web:issuer.credentials.org#controller)")
    .option("--notify", "Email an exact-email recipient, or a domain mailbox on node 1.17.3+")
    .option("--notify-to <address>", "Mailbox to invite for --to domain:<name> --notify (node 1.17.3+)")
    .option("--expires <duration>", "Share lifetime")
    .option("--max-bytes <bytes>", "Bound input bytes")
    .option("--media-type <type>", "Media type for a single input")
    .option("--action <actions...>", "Addressed permission: read, list, or edit")
    .option("--prefix", "Publish multiple inputs beneath one addressed prefix")
    .option("--binary", "Allow non-UTF-8 bearer content")
    .option("--artifact <id>", "Publish as the next write-once version of an artifact (\"new\" starts one); the share is pinned to that version")
    // Hidden: accepted only so it fails with a clear message instead of "unknown option" (see ONGOING_UNAVAILABLE).
    .addOption(new Option("--ongoing").hideHelp())
    .option("--note <text>", "Note stored with the artifact version")
    .option("--json", "Print versioned redacted JSON")
    .option("--full-link", "Print the full self-contained link instead of a short link (addressed shares)")
    .option("--viewer-origin <origin>", "Canonical HTTPS viewer origin", SHARE_ORIGIN)
    .action(async (files: string[], options, command: Command) => {
      try {
        const json = jsonOutput(options, command);
        // Refused before anything is read or validated, so every combination gets this one message. A share that
        // follows a mutable copy cannot be minted today: the recipient SDK rejects ciphertext whose wrapped-key hash
        // differs from the one signed into the share, so it would break on the first update. Ongoing shares come
        // with link-as-delegation (TC-1428 ruling).
        if (options.ongoing === true) throw new CLIError("UNSUPPORTED_TARGET", ONGOING_UNAVAILABLE, 2);
        const maxBytes = byteLimit(options.maxBytes);
        if (files.length === 0 || (files.includes("-") && files.length > 1)) throw new CLIError("INVALID_ARGUMENT", "stdin must be the only publish input", 2);
        const name = files.length === 1 ? options.name : undefined;
        const target = parseShareTarget(options.to);
        const actions = requestedActions(options.action);
        if (options.notify === true && !actions.includes("read")) throw new CLIError("INVALID_ARGUMENT", "--notify requires the read action; nothing was shared", 2);
        if (target.kind !== "email" && (options.credentialDescriptor || options.issuerDid || options.issuerKid)) {
          throw new CLIError("INVALID_ARGUMENT", "credential options require an exact email target", 2);
        }
        // Pinned from the live issuer DID and catalog; explicit flags remain independent overrides.
        const credentialDescriptor = target.kind === "email"
          ? options.credentialDescriptor === undefined ? productionEmailDescriptor : JSON.parse(await readFile(options.credentialDescriptor, "utf8")) as unknown
          : undefined;
        // A folder with an index.html becomes one self-contained page for an anyone-with-the-link share. Addressed and
        // --prefix publication of a folder is not offered: a directory falls through to the file reader and is refused.
        const folder = files.length === 1 && target.kind === "bearer" && options.prefix !== true && await isDirectoryInput(files[0]!);
        let inputs: { bytes: Uint8Array; filename: string }[];
        if (folder) {
          if (options.mediaType !== undefined && options.mediaType.split(";")[0]!.trim().toLowerCase() !== "text/html") {
            throw new CLIError("INVALID_ARGUMENT", "a folder is published as text/html; drop --media-type", 2);
          }
          const bundle = await bundleHtmlFolder(files[0]!, { ...(name === undefined ? {} : { name }), ...(maxBytes === undefined ? {} : { maxBytes }) });
          const notice = htmlFolderNotice(bundle);
          if (notice !== undefined) process.stderr.write(notice);
          inputs = [{ bytes: bundle.bytes, filename: bundle.filename }];
        } else {
          // A directory that is not a folder publish (addressed, --prefix, next to other inputs) gets one clear refusal.
          for (const file of files) if (await isDirectoryInput(file)) throw new CLIError("MAX_BYTES_EXCEEDED", FOLDER_NOT_AVAILABLE, 7);
          // Refuse unsafe names before touching any source, so stdin is never awaited for one.
          for (const file of files) shareInputFilename(file, name);
          inputs = await Promise.all(files.map((file) => readShareInput(file, name, maxBytes)));
        }
        assertAggregateInputLimit(inputs, maxBytes);
        if (options.prefix && target.kind === "bearer") throw new CLIError("INVALID_ARGUMENT", "--prefix requires an addressed target", 2);
        // A link is read-only: the bearer delegation never carries put, so an edit request would be dropped silently.
        if (target.kind === "bearer" && actions.includes("edit")) throw new CLIError("INVALID_ARGUMENT", `--action edit is not available with --to ${options.to}: a link can only be read; address a recipient to allow edits`, 2);
        if (inputs.length > 1 && target.kind === "bearer") throw new CLIError("UNSUPPORTED_LINK", "multiple files require an addressed target", 2);
        const artifact = artifactRequest(options, actions, inputs.length);
        if (inputs.length > 1 && !options.prefix) throw new CLIError("INVALID_ARGUMENT", "multiple files require --prefix", 2);
        if (options.notifyTo !== undefined && (options.notify !== true || target.kind !== "emailDomain")) {
          throw new CLIError("INVALID_ARGUMENT", "--notify-to requires --to domain:<name> --notify", 2);
        }
        let notifyRecipient: string | undefined;
        if (options.notify === true && target.kind === "email") notifyRecipient = target.address;
        else if (options.notify === true && target.kind === "emailDomain") {
          const mailbox = options.notifyTo === undefined ? undefined : canonicalMailbox(options.notifyTo);
          if (mailbox === undefined || mailbox.domain !== target.domain) {
            throw new CLIError("INVALID_ARGUMENT", "--to domain:<name> --notify requires --notify-to <email> at that exact domain (node 1.17.3+)", 2);
          }
          notifyRecipient = mailbox.email;
        } else if (options.notify === true) {
          throw new CLIError("INVALID_ARGUMENT", "--notify requires an email target, or a domain target with --notify-to on node 1.17.3+", 2);
        }
        // Invitation emails carry a short link. Refuse before anything is published when the services that send them cannot take one.
        if (notifyRecipient !== undefined) assertInvitationsAvailable("Nothing was shared and no invitation was sent.");
        const result = await publishTargetShare({
          source: inputs[0]!.bytes,
          filename: inputs[0]!.filename,
          files: inputs.map((input) => ({ bytes: input.bytes, filename: input.filename, mediaType: mediaTypeFor(input.filename) })),
          mediaType: options.mediaType ?? mediaTypeFor(inputs[0]!.filename),
          allowBinary: options.binary === true,
          target,
          resourceKind: options.prefix || inputs.length > 1 ? "prefix" : "exact",
          actions,
          expiresAt: expires(options.expires ?? "7d"),
          expiryWasExplicit: options.expires !== undefined,
          origin: options.viewerOrigin,
          ...(maxBytes === undefined ? {} : { maxBytes }),
          notify: options.notify === true,
          ...(credentialDescriptor === undefined ? {} : {
            credentialDescriptor,
            issuerDid: options.issuerDid ?? productionEmailDescriptor.issuer.did,
            issuerKid: options.issuerKid ?? productionEmailDescriptor.issuer.kid,
          }),
          // The artifact request rides on the adapter call rather than through `publishTargetShare`, whose code is part of
          // the browser bundles (the web-sdk size ceiling counts every byte it carries).
          targetAdapter: artifact === undefined || shareServices.targetAdapter === undefined
            ? shareServices.targetAdapter
            : { publish: (request) => shareServices.targetAdapter!.publish({ ...request, artifact }) },
        });
        if ("state" in result) {
          if (json) {
            writeJson({ protocol: "tinycloud-share", version: 1, authorization: authorizationRequiredJson(result) });
            process.exitCode = 6;
            return;
          }
          throw new CLIError(result.method === "openkey-device" ? "DEVICE_AUTH_REQUIRED" : "CLAIM_REQUIRED", "recipient authorization is required; continue through the configured authority adapter", 6);
        }
        const shown: ShownLink = shareServices.links === undefined || result.link.kind !== "policy"
          ? { url: result.url, short: false }
          : await shareServices.links.show(result, { fullLink: options.fullLink === true });
        if (shown.notice !== undefined) process.stderr.write(`${shown.notice}\n`);
        // History keeps the link text printed below, short or full.
        const { record, history } = await rememberPublishedShare(result, shown.url);
        let notification: ShareNotifyResult | undefined;
        if (notifyRecipient !== undefined) {
          if (shareServices.delivery === undefined) throw new CLIError("AUTH_REQUIRED", "delivery authority is not configured", 3);
          if (!shown.short) {
            process.stderr.write(`${NOTIFY_NEEDS_SHORT_LINK_MESSAGE}\n`);
            process.exitCode = 9;
          } else {
            notification = await notifyRecordedShare(record, notifyRecipient, shareServices.delivery, history.recorded ? shareServices.records : undefined, { shareId: result.metadata.shareId, cid: result.link.cid });
            if (notification.state === "partial-failure") process.exitCode = 9;
            if (notification.reason === "delivery-window-expired") process.stderr.write(NOTIFY_WINDOW_MESSAGE);
          }
        }
        if (result.metadata.expiryClamped === true) process.stderr.write(`Share expiry clamped to session expiry (${result.metadata.expiresAt}).\n`);
        if (json) writeJson({ ...redactPublishedShare(result), history, expiryClamped: result.metadata.expiryClamped === true, ...(artifact === undefined || result.metadata.artifact === undefined ? {} : { artifactId: result.metadata.artifact.id, version: result.metadata.artifact.version, mode: result.metadata.artifact.mode }), ...(notification === undefined ? {} : { notification }), ...(shown.notice === undefined ? {} : { linkNotice: shown.notice }) });
        else {
          if (result.metadata.artifact !== undefined) process.stderr.write(`Artifact ${result.metadata.artifact.id} v${result.metadata.artifact.version} (${result.metadata.artifact.mode})\n`);
          publishHuman(shown.url);
        }
      } catch (error) { return handleError(shareCliError(error)); }
    });

  share.command("inspect [url]")
    .description("Verify a share link and print safe metadata")
    .option("--stdin", "Read the complete URL from stdin")
    .option("--json", "Print versioned redacted JSON")
    .option("--viewer-origin <origin>", "Require this canonical Share origin", SHARE_ORIGIN)
    .action(async (url: string | undefined, options, command: Command) => {
      try {
        const json = jsonOutput(options, command);
        const result = await inspectShareInputOnce(url, options.stdin === true, options.viewerOrigin);
        if (json) writeJson(result);
        else inspectHuman(result);
      } catch (error) {
        return handleError(shareCliError(error));
      }
    });

  share.command("versions <artifact-id>")
    .description("List the write-once versions of an artifact, and the shares pinned to each")
    .option("--json", "Print versioned JSON")
    .action(async (artifactId: string, options, command: Command) => {
      try {
        const json = jsonOutput(options, command);
        const id = assertArtifactId(artifactId);
        if (shareServices.artifactStore === undefined) throw new CLIError("AUTH_REQUIRED", "artifact storage is not configured", 3);
        const versions = await listArtifactVersions(await shareServices.artifactStore(), id);
        // Pinned shares come from local sender history: the node keeps no per-share index.
        const pinned = new Map<number, { shareId: string; target: string; expiresAt: string; revokedAt?: string }[]>();
        for (const record of await shareServices.records?.list() ?? []) {
          const path = parseArtifactVersionPath(record.resource.path);
          if (path === undefined || path.artifactId !== id) continue;
          const shares = pinned.get(path.version) ?? [];
          shares.push({ shareId: record.shareId, target: record.targetKind ?? record.recipientMatcher.kind, expiresAt: record.expiresAt, ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }) });
          pinned.set(path.version, shares);
        }
        const view = versions.map((version) => ({
          version: version.version,
          complete: version.complete,
          ...(version.corrupt === true ? { corrupt: true as const } : {}),
          ...(version.manifest === undefined ? {} : {
            createdAt: version.manifest.createdAt,
            parent: version.manifest.parent,
            ...(version.manifest.note === undefined ? {} : { note: version.manifest.note }),
            files: version.manifest.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
            manifestSha256: version.manifestSha256,
          }),
          pinnedShares: pinned.get(version.version) ?? [],
        }));
        if (json) writeJson({ protocol: "tinycloud-share", version: 1, artifactId: id, versions: view });
        else {
          process.stdout.write(view.map((entry) => `v${entry.version}\t${entry.complete ? (entry.createdAt ?? "") : entry.corrupt === true ? "corrupt" : "incomplete"}\t${entry.pinnedShares.length} pinned share${entry.pinnedShares.length === 1 ? "" : "s"}${entry.note === undefined ? "" : `\t${entry.note}`}`).join("\n") + (view.length ? "\n" : ""));
        }
      } catch (error) { return handleError(shareCliError(error)); }
    });

  share.command("receive [url]")
    .description("Verify and receive a share link")
    .option("--stdin", "Read the complete URL from stdin")
    .option("--output <directory>", "Create the file in this directory")
    .option("--stdout", "Write verified plaintext bytes to stdout")
    .option("--force", "Allow replacing an existing non-symlink output")
    .option("--max-bytes <bytes>", "Bound received content bytes")
    .option("--json", "Print versioned redacted JSON")
    .option("--viewer-origin <origin>", "Require this canonical Share origin", SHARE_ORIGIN)
    .action(async (url: string | undefined, options, command: Command) => {
      try {
        const json = jsonOutput(options, command);
        if (options.stdout && json) throw new CLIError("INVALID_ARGUMENT", "--stdout and --json are mutually exclusive", 2);
        const maxBytes = byteLimit(options.maxBytes);
        const link = await inputUrl(url, options.stdin === true);
        let nativeLink = false;
        try { parseNativeShareUrl(link); nativeLink = true; } catch { /* addressed Policy/v3 link */ }
        if (nativeLink) {
          // Native bearer links are minted at the Share origin too; one from elsewhere is never read.
          assertTrustedShareOrigin(link, options.viewerOrigin);
          if (shareServices.nativeReader === undefined) throw new CLIError("AUTH_REQUIRED", "native TinyCloud receive is not configured", 3);
          const native = await shareServices.nativeReader(link);
          if (maxBytes !== undefined && native.bytes.byteLength > maxBytes) throw new CLIError("MAX_BYTES_EXCEEDED", "shared content exceeds max-bytes", 7);
          if (options.stdout) { process.stdout.write(Buffer.from(native.bytes)); return; }
          const output = await writeShareOutput(options.output ?? ".", native.filename, native.bytes, options.force === true);
          if (json) writeJson({ protocol: "tinycloud-share", version: 1, path: output, transport: "native" }); else receiveHuman(output);
          return;
        }
        assertTrustedShareOrigin(link, options.viewerOrigin);
        const result = await receiveShare(link, {
          expectedOrigin: options.viewerOrigin,
          ...(maxBytes === undefined ? {} : { maxContentBlobBytes: maxBytes }),
        });
        if ("state" in result) {
          if (json) {
            writeJson({ protocol: "tinycloud-share", version: 1, authorization: authorizationRequiredJson(result) });
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
        if (json) receiveJson(result, output);
        else receiveHuman(output);
      } catch (error) { return handleError(shareCliError(error)); }
    });

  share.command("list")
    .description("List encrypted sender history without complete bearer URLs")
    .option("--json", "Print versioned redacted JSON")
    .action(async (options, command: Command) => {
      try {
        const json = jsonOutput(options, command);
        if (shareServices.records === undefined) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
        const result = await listShares(shareServices.records);
        if (json) writeJson({ protocol: "tinycloud-share", version: 1, shares: result });
        else process.stdout.write(result.map((item) => `${item.shareId}\t${item.target}\t${item.expiresAt}\t${item.revoked ? "revoked" : Date.parse(item.expiresAt) < Date.now() ? "expired" : "active"}`).join("\n") + (result.length ? "\n" : ""));
      } catch (error) { return handleError(shareCliError(error)); }
    });

  share.command("show <id>")
    .description("Show one redacted sender-history record")
    .option("--reveal-link", "Explicitly include the complete link")
    .option("--json", "Print versioned redacted JSON")
    .action(async (id: string, options, command: Command) => {
      try {
        const json = jsonOutput(options, command);
        if (options.revealLink && json) throw new CLIError("INVALID_ARGUMENT", "--reveal-link cannot be combined with --json", 2);
        if (shareServices.records === undefined) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
        const result = await showShare({ storage: shareServices.records, shareId: id, revealLink: options.revealLink === true });
        if (json) writeJson({ protocol: "tinycloud-share", version: 1, share: result }); else writeJson(result);
      } catch (error) { return handleError(shareCliError(error)); }
    });

  share.command("notify <id>")
    .description("Retry idempotent delivery within 5 minutes of publication; after that publish a new share")
    .requiredOption("--to <address>", "Recipient email")
    .option("--json", "Print versioned JSON")
    .action(async (id: string, options, command: Command) => {
      try {
        const json = jsonOutput(options, command);
        assertInvitationsAvailable("No invitation was sent.");
        if (shareServices.delivery === undefined) throw new CLIError("AUTH_REQUIRED", "delivery authority is not configured", 3);
        if (shareServices.records === undefined) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
        const record = await shareServices.records.get(id);
        if (record === undefined) throw new CLIError("NOT_FOUND", "share not found", 4);
        if (!record.actions.includes("tinycloud.kv/get")) {
          throw new CLIError("INVALID_ARGUMENT", "share notify requires a stored share with the read action; no invitation was sent", 2);
        }
        if (shortLinkId(record.link) === undefined) throw new CLIError("NO_SHORT_LINK", NOTIFY_NEEDS_SHORT_LINK_MESSAGE, 2);
        const mailbox = canonicalMailbox(options.to);
        if (mailbox === undefined) throw new ShareNotifyError("recipient is invalid");
        if (!recipientMatchesShareRecord(record, mailbox.email)) throw new ShareNotifyError("recipient does not match the stored share target");
        if (record.recipientMatcher.kind === "emailDomain" && shareDeliveryWindowExpiresAt(record) > Date.now()) {
          if (shareServices.assertDomainDelivery === undefined) throw new CLIError("UNAVAILABLE", "could not verify TinyCloud node 1.17.3 domain delivery support; no invitation was sent", 4);
          await shareServices.assertDomainDelivery();
        }
        const result = await notifyRecordedShare(record, options.to, shareServices.delivery, shareServices.records);
        if (json) writeJson(result); else process.stdout.write(`${result.state}\n`);
        if (result.reason === "delivery-window-expired") process.stderr.write(NOTIFY_WINDOW_MESSAGE);
        if (result.state === "partial-failure") process.exitCode = 9;
      } catch (error) { return handleError(shareCliError(error, "notify")); }
    });

  share.command("revoke <id>")
    .description("Revoke a bearer or addressed share this profile created")
    .option("--ancestor", "Revoke the owner delegation ancestry")
    .option("--json", "Print versioned JSON")
    .action(async (id: string, options, command: Command) => {
      try {
        const json = jsonOutput(options, command);
        if (shareServices.records === undefined) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
        const record = shareServices.getRecord ? await shareServices.getRecord(id) : await shareServices.records.get(id);
        if (record === undefined) throw new CLIError("NOT_FOUND", "share not found", 4);
        const result = await revokeShare({ record, records: shareServices.records, adapter: shareServices.revocation, scope: options.ancestor ? "ancestor" : "direct" });
        if (result.state === "unsupported") {
          throw new CLIError("UNSUPPORTED_TARGET", result.reason, 2);
        }
        if (json) writeJson({ protocol: "tinycloud-share", version: 1, result }); else process.stdout.write(`${result.state}\n`);
      } catch (error) { return handleError(shareCliError(error)); }
    });

  share.command("unlink <id>")
    .description("Delete a share's short link now; the share itself is not revoked")
    .option("--json", "Print versioned JSON")
    .action(async (id: string, options, command: Command) => {
      try {
        const json = jsonOutput(options, command);
        if (shareServices.records === undefined) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
        if (shareServices.links === undefined) throw new CLIError("AUTH_REQUIRED", "link authority is not configured", 3);
        const record = shareServices.getRecord ? await shareServices.getRecord(id) : await shareServices.records.get(id);
        if (record === undefined) throw new CLIError("NOT_FOUND", "share not found", 4);
        // The id comes from the link text the share printed, which sender history keeps.
        const linkId = shortLinkId(record.link);
        if (linkId === undefined) throw new CLIError("NO_SHORT_LINK", "this share has no short link to delete: it was shared as a full link, or its link was not recorded", 2);
        let state: "deleted" | "absent";
        try {
          state = await shareServices.links.unlink(linkId);
        } catch (error) {
          throw new CLIError("UNAVAILABLE", `the short link was not deleted: ${linkFailureReason(error, "delete")}; try again shortly`, 4);
        }
        if (json) writeJson({ protocol: "tinycloud-share", version: 1, result: { state, shareId: record.shareId } }); else process.stdout.write(`${state}\n`);
      } catch (error) { return handleError(shareCliError(error)); }
    });

  const history = share.command("history").description("Inspect and repair the local sender-share history");
  history.command("recover")
    .description("Move an unreadable sender-share history file aside under a timestamped name. Nothing is deleted or overwritten, so a new history can start.")
    .option("--json", "Print versioned JSON")
    .action(async (options, command: Command) => {
      try {
        const json = jsonOutput(options, command);
        const ctx = await ProfileManager.resolveContext(command.optsWithGlobals(), { storedSession: "unused" });
        const quarantined = await quarantineUnreadableProfileHistory(ctx.profile);
        if (json) writeJson({ protocol: "tinycloud-share", version: 1, result: { profile: ctx.profile, quarantined } });
        else process.stdout.write(quarantined === null ? "no unreadable sender history to recover\n" : `moved unreadable sender history to ${quarantined}\n`);
      } catch (error) { return handleError(shareHistoryRecoverError(error)); }
    });
}
