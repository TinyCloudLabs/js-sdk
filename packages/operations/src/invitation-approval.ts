/**
 * The one approval an addressed (email) Share needs from the account owner: one OpenKey-approved `share/<id>` key,
 * requested, collected, verified and installed here for every surface (CLI and MCP).
 *
 * `requestInvitationApproval` never waits. The first call for one recipient and file creates the request and returns its
 * link; a later call for the same recipient, file and expiry resumes that same request, asks OpenKey once, and, if the owner
 * has approved, verifies the owner-signed grant for THIS request, installs it on the node as a runtime delegation and takes
 * it (single use). Pending requests live in an owner-only file of the profile, keyed by request id.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Namespace-shaped so modules that bundle this one stay compatible with lightweight node-sdk test doubles.
import * as nodeSdk from "@tinycloud/node-sdk";
import type { PortableDelegation, TinyCloudNode } from "@tinycloud/node-sdk";
import {
  ackApprovalResult,
  buildShareInvitationApprovalSpec,
  createApprovalRequest,
  DEFAULT_LINKS_API_ORIGIN,
  discoverApprovalResult,
  fetchApprovalResult,
  generateRelayKey,
  isApprovalClientError,
  isLinkError,
  openRelayResult,
  signerFromJwk,
  type CreatedLink,
  type Ed25519PrivateJwk,
  type LinkRecord,
  type LinkSigner,
  type OpenKeyApprovalRequestV1,
  type ShareInvitationApprovalContext,
} from "@tinycloud/share-envelope/links";

import { OperationInvocationError, operationError, type OperationErrorCode } from "./errors.js";
import { invitationKeyFromGrant, normalizePkhIdentifier, verifyInvitationGrant, type VerifiedInvitationGrant } from "./invitation-key-grant.js";
import { ProfileDeletedError, profilePath, readJson, refuseWriteToDeletedProfile, withProfileLock, withTinyCloudStateRoot } from "./state.js";

const DAY_MS = 86_400_000;
const DEFAULT_OPENKEY_HOST = "https://openkey.so";
const DEFAULT_OPENKEY_DEVICE_API_HOST = "https://api.openkey.so";
const OWNER_DID = /^did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}$/;
const STATE_FILE = "invitation-approval-pending.json";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TRANSIENT_ACTIVATION_CODES = new Set(["NODE_NOT_RESPONDING", "registry_unavailable", "ACTIVATION_TRANSPORT_FAILED"]);
/**
 * How long OpenKey serves an approved result after the approval: production APPROVAL_RESULT_RETENTION_SECONDS=600
 * (OpenKey repo, docker-compose.prod.yml:28). A request approved just before its expiry can still be collected until
 * then, so a stored request is not dropped locally before its expiry plus this. If OpenKey changes that setting,
 * change this with it.
 */
const RESULT_RETENTION_MS = 600_000;
/** Clock skew allowed on top: a local clock that runs ahead must never drop a request OpenKey would still serve. */
const EXPIRY_SKEW_MS = 60_000;

export interface InvitationApprovalRequest {
  /** Absolute state root of the profile store; defaults to the process's TinyCloud home, like the other state helpers. */
  stateRoot?: string;
  profile: string;
  /** The profile's node: its session key signs the request, and the approved grant is installed on it. */
  node: TinyCloudNode;
  /** The profile's own account (did:pkh): the approval is checked against it, never against the session key's did:key. */
  ownerDid: string;
  recipientEmail: string;
  /** The shared file name (or session name), shown to the approver with the recipient and dates. */
  subjectName: string;
  subjectKind: "file" | "session";
  /** When the shared content stops being readable by the recipient. */
  accessExpiresAt: Date;
  /** sha256 of the shared bytes: a rerun of the same file (same recipient and name) resumes its own open approval. */
  contentSha256?: string;
  /** The relative expiry the user chose, in milliseconds (absent for a date): the same choice on a rerun resumes this approval. */
  requestedDurationMs?: number;
  openkeyHost?: string;
}

export type InvitationApprovalOutcome =
  | {
    status: "approved";
    shareId: string;
    /** The access expiry the owner was shown and signed: the share is issued with exactly this date. */
    accessExpiresAt: string;
    /**
     * The approval continued an open request signed for an EARLIER absolute date than the one asked for now (the same relative
     * expiry chosen on a rerun), so the share must be issued with `accessExpiresAt`, not a recomputed date.
     */
    resumed: boolean;
  }
  | { status: "pending"; approvalUrl: string; requestId: string; expiresAt: string };

export interface InvitationApprovalDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/** What one open invitation request holds. The link's own copy is the only place its approval URL is kept. */
interface PendingInvitation {
  version: 1;
  request: OpenKeyApprovalRequestV1;
  requestId: string;
  bodyCid: string;
  approvalUrl: string;
  requestExpiresAt: string;
  record: LinkRecord;
  apiOrigin: string;
  linkApiOrigin: string;
  openkeyOrigin: string;
  relayPrivateKey: string;
  expectedOwner: string;
  /** The file identity, kept so a rerun of the same file resumes this request. */
  invitationMeta?: { contentSha256: string; requestedDurationMs?: number };
  resultRef?: string;
  resultExpiresAt?: string;
  resultEnvelope?: unknown;
  ackId: string;
}

function fail(code: OperationErrorCode, message: string, retryable = false): OperationInvocationError {
  return new OperationInvocationError(operationError(code, message, { retryable }));
}

/** A ULID: 48 bits of time, 80 random bits, Crockford base32. */
function newInvitationId(now: number): string {
  let id = "";
  let time = now;
  for (let index = 0; index < 10; index += 1) {
    id = CROCKFORD[time % 32]! + id;
    time = Math.floor(time / 32);
  }
  for (const byte of randomBytes(16)) id += CROCKFORD[byte % 32]!;
  return id.slice(0, 26);
}

/** The `reason` / `code` an activation failure names, read without trusting its shape. */
function failureFacts(error: unknown): { reason?: string; code?: string } {
  if (typeof error !== "object" || error === null) return {};
  const reason = "reason" in error && typeof error.reason === "string" ? error.reason : undefined;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { ...(reason === undefined ? {} : { reason }), ...(code === undefined ? {} : { code }) };
}

function activationUnavailable(error: unknown): boolean {
  const { reason, code } = failureFacts(error);
  return reason === "activation_unavailable" || (code !== undefined && TRANSIENT_ACTIVATION_CODES.has(code));
}

function configuredOrigin(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw fail("INPUT_INVALID", `${label} must be an origin.`); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw fail("INPUT_INVALID", `${label} must be an HTTPS origin or a loopback HTTP origin.`);
  }
  return url.origin;
}

// ---- the pending file -----------------------------------------------------------------------------------------------

/** Whether a stored request can no longer yield a result: its result's retention ended, or the request itself lapsed past retention. */
function lapsed(entry: PendingInvitation, now: number): boolean {
  if (entry.resultExpiresAt !== undefined) return Date.parse(entry.resultExpiresAt) <= now;
  return now >= Date.parse(entry.requestExpiresAt) + RESULT_RETENTION_MS + EXPIRY_SKEW_MS;
}

/** Durable, owner-only publication: the file and its directory entry are on disk before the caller goes on. */
async function writeDurably(path: string, entries: readonly PendingInvitation[]): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    const file = await open(temporary, "wx", PRIVATE_FILE_MODE);
    try {
      await file.writeFile(`${JSON.stringify(entries, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * One read-modify-write of the profile's pending invitations under the profile lock. Lapsed entries are dropped on every
 * pass. `update` returns the entries to keep and the caller's result.
 */
async function updatePending<T>(
  profile: string,
  now: number,
  update: (entries: readonly PendingInvitation[]) => { entries: readonly PendingInvitation[]; result: T },
): Promise<T> {
  try {
    return await withProfileLock(profile, async () => {
      await refuseWriteToDeletedProfile(profile);
      const path = join(profilePath(profile), STATE_FILE);
      const stored = await readJson<PendingInvitation[]>(path);
      const current = Array.isArray(stored) ? stored : [];
      const active = current.filter((entry) => !lapsed(entry, now));
      const next = update(active);
      if (stored === null ? next.entries.length > 0 : JSON.stringify(next.entries) !== JSON.stringify(current)) {
        await writeDurably(path, next.entries);
      }
      return next.result;
    }, { requireProfile: true });
  } catch (error) {
    if (error instanceof ProfileDeletedError) throw fail("PROFILE_NOT_FOUND", error.message);
    throw error;
  }
}

const replaceEntry = (entry: PendingInvitation) => (entries: readonly PendingInvitation[]) =>
  ({ entries: entries.map((item) => (item.requestId === entry.requestId ? entry : item)), result: undefined });
const withoutEntry = (requestId: string) => (entries: readonly PendingInvitation[]) =>
  ({ entries: entries.filter((item) => item.requestId !== requestId), result: undefined });

// ---- matching -------------------------------------------------------------------------------------------------------

interface Match {
  recipientEmail: string;
  subjectKind: "file" | "session";
  subjectName: string;
  accessExpiresAt: string;
  contentSha256?: string;
  requestedDurationMs?: number;
  targetDid: string;
  nodeOrigin: string;
  ownerDid: string;
  apiOrigin: string;
  linkApiOrigin: string;
  openkeyOrigin: string;
  now: number;
}

/**
 * Whether an open request is the one this call continues. Everything the owner was shown must match: recipient, subject kind
 * and name, and the content's access expiry (or the SAME relative choice the user made then: the exact duration, never inferred
 * from timing). Any other duration, even by a second, is a new choice and a new request.
 */
function continues(entry: PendingInvitation, match: Match): boolean {
  const context = entry.request.context;
  if (context === undefined) return false;
  return context.recipientEmail === match.recipientEmail && context.subjectKind === match.subjectKind && context.subjectName === match.subjectName
    && Date.parse(context.acceptanceExpiresAt) > match.now && entry.invitationMeta?.contentSha256 === match.contentSha256
    && (context.accessExpiresAt === match.accessExpiresAt
      // A resumed date is only ever one earlier than the new request's and still usable (more than a minute left): both are decided here,
      // before anything is installed or taken.
      || (match.requestedDurationMs !== undefined && entry.invitationMeta?.requestedDurationMs === match.requestedDurationMs
        && Date.parse(context.accessExpiresAt) < Date.parse(match.accessExpiresAt) && Date.parse(context.accessExpiresAt) > match.now + 60_000))
    && entry.request.targetDid === match.targetDid && entry.request.nodeOrigin === match.nodeOrigin
    && entry.apiOrigin === match.apiOrigin && entry.linkApiOrigin === match.linkApiOrigin && entry.openkeyOrigin === match.openkeyOrigin
    && normalizePkhIdentifier(entry.expectedOwner) === normalizePkhIdentifier(match.ownerDid);
}

// ---- OpenKey --------------------------------------------------------------------------------------------------------

/** What an OpenKey answer means for a stored request: it ends it (the entry goes), is refused, or says nothing about it (retry). */
async function remoteFailure(profile: string, entry: PendingInvitation, error: unknown, action: "discover" | "fetch", now: number): Promise<never> {
  if (!isApprovalClientError(error)) throw error;
  const { code, status } = error;
  const drop = () => updatePending(profile, now, withoutEntry(entry.requestId));
  // OpenKey's 400 `invalid_request` for a request it still holds open is a clock skew or an unexpected reply, not an expiry.
  if (code === "request_expired" && action === "discover" && status === 400 && now < Date.parse(entry.requestExpiresAt)) {
    throw fail("APPROVAL_UNAVAILABLE", "OpenKey could not check this approval request. Run the same command again to resume it.", true);
  }
  if (code === "request_expired") {
    await drop();
    throw fail("APPROVAL_REQUEST_EXPIRED", "This approval request expired before it was approved. Run the command again: the next run makes a new request with a new link.");
  }
  if (code === "result_expired") {
    await drop();
    throw fail("APPROVAL_RESULT_EXPIRED", "The approved result expired before it was saved. Start a new request.");
  }
  if (code === "acknowledged") {
    await drop();
    throw fail("APPROVAL_RESULT_INVALID", "OpenKey has already acknowledged this result, so it cannot be used again; request a new approval.");
  }
  if (code === "not_found") {
    await drop();
    throw action === "discover"
      ? fail("APPROVAL_REQUEST_EXPIRED", "OpenKey cannot find this approval request. Run the command again to make a new one.")
      : fail("APPROVAL_RESULT_EXPIRED", "OpenKey cannot find this approval result. Start a new request.");
  }
  if (code === "request_binding" || code === "ack_conflict" || code === "result_invalid") throw fail("APPROVAL_RESULT_INVALID", error.message);
  throw fail("APPROVAL_UNAVAILABLE",
    `OpenKey could not ${action === "discover" ? "discover this request" : "fetch this result"}. Run the same command again to resume.`, true);
}

// ---- verification and installation ----------------------------------------------------------------------------------

/**
 * Open the stored result with the request's own relay key and verify it for THIS request, from the owner-signed grant alone. A refusal
 * of the opened result is permanent: the caller drops the request. A result that cannot be opened at all keeps it (it is fetched again).
 */
async function verifyStoredResult(entry: PendingInvitation, key: Ed25519PrivateJwk, now: number): Promise<VerifiedInvitationGrant> {
  const context = entry.request.context;
  if (!entry.resultRef || !entry.resultEnvelope) throw fail("APPROVAL_RESULT_INVALID", "No encrypted approval result is available.");
  // Everything about the key comes from the owner-signed grant for THIS request; the owner must be the profile's own account.
  if (context === undefined) throw fail("APPROVAL_RESULT_INVALID", "This is not an invitation approval for this profile.");
  let opened: Record<string, unknown>;
  try {
    opened = await openRelayResult(entry.resultEnvelope, entry.requestId, entry.relayPrivateKey);
  } catch (error) {
    throw fail("APPROVAL_RESULT_INVALID", `${error instanceof Error ? error.message : "The approval result could not be opened."} No invitation was sent.`);
  }
  const signer = signerFromJwk(key);
  if (opened.resultVersion !== 1 || opened.requestId !== entry.requestId || opened.requestDigest !== entry.bodyCid ||
    opened.requesterDid !== entry.request.issuer || opened.targetDid !== entry.request.targetDid ||
    signer.did !== entry.request.issuer || typeof opened.ownerDid !== "string" ||
    typeof opened.delegationExpiresAt !== "string" || !Number.isFinite(Date.parse(opened.delegationExpiresAt)) ||
    new Date(opened.delegationExpiresAt).toISOString() !== opened.delegationExpiresAt ||
    !opened.delegation || typeof opened.delegation !== "object") {
    throw new DroppedRefusal("Encrypted result binding does not match this request.");
  }
  const delegation = opened.delegation as Record<string, unknown>;
  try {
    const grant = verifyInvitationGrant(delegation, key, {
      targetDid: entry.request.targetDid, ownerDid: entry.expectedOwner, request: { requestId: entry.requestId, bodyCid: entry.bodyCid },
      acceptanceExpiresAt: context.acceptanceExpiresAt, now,
    });
    if (grant.ownerDid.toLowerCase() !== opened.ownerDid.toLowerCase() || grant.expiresAt !== opened.delegationExpiresAt) {
      throw new DroppedRefusal("Result owner or expiry differs from its signed delegation.");
    }
    return grant;
  } catch (error) {
    if (error instanceof OperationInvocationError && error.operationError.code === "APPROVAL_RESULT_INVALID") {
      throw new DroppedRefusal(error.operationError.message);
    }
    throw error;
  }
}

/** A refusal of an opened, owner-approved result: the request it came from is never served again. */
class DroppedRefusal extends OperationInvocationError {
  constructor(message: string) {
    super(operationError("APPROVAL_RESULT_INVALID", message));
  }
}

/** Install the verified key on the node as one runtime delegation (the same path the CLI's escalation grants use). */
async function installGrant(node: TinyCloudNode, host: string, entry: PendingInvitation, grant: VerifiedInvitationGrant): Promise<void> {
  const context = entry.request.context!;
  const entryKey = grant.permissions[0]!;
  const { signed } = grant;
  const portable: PortableDelegation = {
    cid: signed.delegationCid, delegationHeader: { Authorization: signed.authorization }, spaceId: signed.spaceId,
    path: entryKey.path, actions: [...entryKey.actions], resources: [{ service: "encryption", space: "encryption", path: entryKey.path, actions: [...entryKey.actions] }],
    expiry: new Date(grant.expiresAt), delegateDID: signed.verificationMethod, ownerAddress: signed.address,
    chainId: signed.chainId, host, siweProof: { siwe: signed.siwe, signature: signed.signature },
  };
  try {
    await nodeSdk.activateValidatedRuntimeDelegation(node, portable, {
      host,
      // What the node ends up holding must be exactly the one pair, again from the signed bytes it parsed itself.
      authorize: (effective) => {
        try {
          return invitationKeyFromGrant(effective, { ownerDid: grant.ownerDid, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt, acceptanceExpiresAt: context.acceptanceExpiresAt }) === grant.shareId;
        } catch { return false; }
      },
    });
  } catch (error) {
    // A host or registry that could not be reached says nothing about the approval: it stays pending (not taken) and the next run installs it.
    if (activationUnavailable(error)) {
      throw fail("NODE_UNREACHABLE", "The TinyCloud host could not be reached to install the invitation approval; nothing was sent. Run the same command again to continue with the same approval.", true);
    }
    const { reason, code } = failureFacts(error);
    throw fail("APPROVAL_RESULT_INVALID", `The invitation approval could not be installed for this profile (${reason ?? code ?? "refused"}); no invitation was sent.`);
  }
}

// ---- the operation --------------------------------------------------------------------------------------------------

/**
 * Create or resume this invitation's approval request and ask OpenKey once. Returns `pending` with the link until the owner has approved;
 * then verifies the owner-signed grant, installs it on `request.node`, takes it (single use: the pending entry is removed first, OpenKey
 * is told best effort) and returns `approved`. Nothing is created or installed before the approval.
 */
export function requestInvitationApproval(request: InvitationApprovalRequest, deps: InvitationApprovalDeps = {}): Promise<InvitationApprovalOutcome> {
  return withTinyCloudStateRoot(request.stateRoot, () => run(request, deps));
}

async function run(request: InvitationApprovalRequest, deps: InvitationApprovalDeps): Promise<InvitationApprovalOutcome> {
  const clock = deps.now ?? Date.now;
  const { node, profile } = request;
  const session = node.restorableSession;
  if (session === undefined || session.jwk === undefined) throw fail("AUTH_REQUIRED", "The profile session has no signing key.");
  if (typeof request.ownerDid !== "string" || !OWNER_DID.test(request.ownerDid)) {
    throw fail("INPUT_INVALID", "This profile has no recorded owner account to check an invitation approval against.");
  }
  const key = session.jwk as unknown as Ed25519PrivateJwk;
  const signer = signerFromJwk(key);
  const host = (await node.activeNodeIdentity()).origin;
  const openkeyOrigin = configuredOrigin(process.env.TC_OPENKEY_HOST ?? request.openkeyHost ?? DEFAULT_OPENKEY_HOST, "OpenKey");
  const apiOrigin = configuredOrigin(process.env.TC_OPENKEY_API_HOST ??
    (openkeyOrigin === DEFAULT_OPENKEY_HOST ? DEFAULT_OPENKEY_DEVICE_API_HOST : openkeyOrigin), "OpenKey API");
  const linkApiOrigin = configuredOrigin(process.env.TC_LINKS_API_ORIGIN ?? DEFAULT_LINKS_API_ORIGIN, "Links API");
  const accessExpiresAt = new Date(Math.floor(request.accessExpiresAt.getTime() / 1000) * 1000).toISOString();
  const match: Match = {
    recipientEmail: request.recipientEmail, subjectKind: request.subjectKind, subjectName: request.subjectName, accessExpiresAt,
    contentSha256: request.contentSha256, requestedDurationMs: request.requestedDurationMs,
    targetDid: signer.did, nodeOrigin: host, ownerDid: request.ownerDid, apiOrigin, linkApiOrigin, openkeyOrigin, now: clock(),
  };

  let entry = await updatePending(profile, match.now, (entries) => ({ entries, result: entries.find((item) => continues(item, match)) }));
  if (entry === undefined) {
    const created = await createRequest(request, deps, { signer, key, host, accessExpiresAt, apiOrigin, linkApiOrigin, openkeyOrigin });
    // A concurrent call may have stored a matching request while this one was created: that one is kept, this link simply lapses.
    entry = await updatePending(profile, clock(), (entries) => {
      const existing = entries.find((item) => continues(item, { ...match, now: clock() }));
      return existing ? { entries, result: existing } : { entries: [...entries, created], result: created };
    });
    if (entry === created) return pending(entry);
  }

  const state = { requestId: entry.requestId, bodyCid: entry.bodyCid, record: entry.record, apiOrigin: entry.apiOrigin, signingKey: key };
  if (entry.resultEnvelope === undefined) {
    try {
      if (entry.resultRef === undefined) {
        const found = await discoverApprovalResult(state, { fetch: deps.fetch });
        if (found.status === "pending") return pending(entry);
        entry = { ...entry, resultRef: found.resultRef, resultExpiresAt: found.expiresAt };
        await updatePending(profile, clock(), replaceEntry(entry));
      }
      entry = { ...entry, resultEnvelope: await fetchApprovalResult(state, { resultRef: entry.resultRef!, expiresAt: entry.resultExpiresAt! }, { fetch: deps.fetch }) };
    } catch (error) {
      return remoteFailure(profile, entry, error, entry.resultRef === undefined ? "discover" : "fetch", clock());
    }
  }

  let grant: VerifiedInvitationGrant;
  try {
    grant = await verifyStoredResult(entry, key, clock());
  } catch (error) {
    // A refused result is never served from this entry again: its result key and reference are dropped now.
    if (error instanceof DroppedRefusal) await updatePending(profile, clock(), withoutEntry(entry.requestId));
    throw error;
  }
  await updatePending(profile, clock(), replaceEntry(entry));
  await installGrant(node, host, entry, grant);

  // Taking the approval makes it single-use: a send that fails from here on needs a new approval.
  const taken = await updatePending(profile, clock(), (entries) => ({ entries: entries.filter((item) => item.requestId !== entry!.requestId), result: entries.some((item) => item.requestId === entry!.requestId) }));
  if (!taken) throw fail("APPROVAL_RESULT_INVALID", "This invitation approval was already used; request a new one.");
  try { await ackApprovalResult(state, entry.resultRef!, entry.ackId, { fetch: deps.fetch }); } catch { /* the result expires on its own */ }
  const context = entry.request.context!;
  return { status: "approved", shareId: grant.shareId, accessExpiresAt: context.accessExpiresAt, resumed: context.accessExpiresAt !== accessExpiresAt };
}

function pending(entry: PendingInvitation): InvitationApprovalOutcome {
  return { status: "pending", approvalUrl: entry.approvalUrl, requestId: entry.requestId, expiresAt: entry.requestExpiresAt };
}

async function createRequest(
  request: InvitationApprovalRequest,
  deps: InvitationApprovalDeps,
  facts: { signer: LinkSigner; key: Ed25519PrivateJwk; host: string; accessExpiresAt: string; apiOrigin: string; linkApiOrigin: string; openkeyOrigin: string },
): Promise<PendingInvitation> {
  const now = (deps.now ?? Date.now)();
  const { signer, key, host, accessExpiresAt } = facts;
  const context: ShareInvitationApprovalContext = {
    kind: "share-invitation", version: 1, invitationId: newInvitationId(now), recipientEmail: request.recipientEmail,
    subjectKind: request.subjectKind, subjectName: request.subjectName,
    acceptanceExpiresAt: new Date(Math.floor(Math.min(now + DAY_MS, Date.parse(accessExpiresAt)) / 1000) * 1000).toISOString(), accessExpiresAt,
  };
  // An invitation request names no permissions and no key: the approver chooses the key and the result is checked against its own signature.
  const relay = generateRelayKey();
  let created: CreatedLink & { readonly record: LinkRecord };
  let body: OpenKeyApprovalRequestV1;
  try {
    const spec = buildShareInvitationApprovalSpec({
      targetDid: signer.did, targetPublicJwk: { kty: key.kty, crv: key.crv, x: key.x }, nodeOrigin: host, context, now,
    });
    body = { ...spec, resultEncryptionPublicJwk: relay.publicJwk };
    created = await createApprovalRequest({
      request: body, issuerKey: signer, apiOrigin: facts.linkApiOrigin, openkeyOrigin: facts.openkeyOrigin,
      expiresAt: new Date(context.acceptanceExpiresAt), now, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
  } catch (error) {
    if (!isLinkError(error)) throw error;
    // The request itself is unacceptable (an access date already past, an invalid recipient or name), or the links service could not be used.
    if (error.code === "body_validation_failed") throw fail("INPUT_INVALID", "The invitation approval request is not valid (check the recipient, the file name and that the access date is in the future).");
    throw fail("APPROVAL_UNAVAILABLE", "The approval request could not be created. Run the same command again.", true);
  }
  return {
    version: 1, request: body, requestId: created.id, bodyCid: created.bodyCid, approvalUrl: created.link,
    requestExpiresAt: created.expiresAt, record: created.record, apiOrigin: facts.apiOrigin, linkApiOrigin: facts.linkApiOrigin, openkeyOrigin: facts.openkeyOrigin,
    relayPrivateKey: relay.privateKey, expectedOwner: request.ownerDid, ackId: randomUUID(),
    ...(request.contentSha256 === undefined ? {} : {
      invitationMeta: { contentSha256: request.contentSha256, ...(request.requestedDurationMs === undefined ? {} : { requestedDurationMs: request.requestedDurationMs }) },
    }),
  };
}
