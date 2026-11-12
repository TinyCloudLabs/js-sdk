import { createECDH, createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { tryOpenBrowser } from "../lib/browser.js";
import { normalizePkhIdentifier } from "../lib/space.js";
import { additionalDelegationsPath, profilePath } from "@tinycloud/operations/state";
import { buildShareInvitationApprovalSpec, createApprovalRequest, DEFAULT_LINKS_API_ORIGIN, signerFromJwk, type Ed25519PrivateJwk, type LinkRecord, type OpenKeyApprovalRequestV1, type ShareInvitationApprovalContext } from "@tinycloud/share-envelope/links";
import { principalDidEquals, type AuthDelegationArtifact, type AuthRequestArtifact, type PermissionEntry } from "@tinycloud/node-sdk";
import { canonicalizeRecapCaveats, parseSignedCompactUcanAttenuation } from "@tinycloud/sdk-core";
import { ProfileManager } from "../config/profiles.js";
import { readJson, writeJsonDurable, syncAuthCredentialFiles } from "../config/storage.js";
import { DEFAULT_OPENKEY_HOST, DEFAULT_OPENKEY_DEVICE_API_HOST, ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { loadAdditionalDelegations } from "../lib/permissions.js";
import * as commandGrants from "../lib/permissions.js";
import { entriesForSigning, finalizeSigningEntries } from "../lib/apps-agent-preset.js";
import type { AuthFlowOptions, DelegationData } from "./browser-auth.js";
import { dropCommittedDelegation } from "./pending-code.js";
import { carryRefusedDelegation, isPermanentRefusal, markMaybeGranted } from "./refusal.js";
import { decryptRelayResult, relayPublicJwkOf } from "./device-auth.js";
import { canonicalJson, parseRequestedExpiry, sameLoginSpace, verifyScopedLogin } from "./scoped-login.js";
import { APPROVAL_POLL_INTERVAL_MS, approvalLimitMs, approvalPendingError, approvalRequestTimeoutMs, firstCheckTimeoutMs, type ApprovalWait } from "./approval-wait.js";
import { verifyInvitationGrant, type VerifiedInvitationGrant } from "./invitation-key-grant.js";

interface PendingApproval {
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
  signingKey?: Ed25519PrivateJwk;
  relayPrivateKey: string;
  expectedOwner?: string;
  /** An invitation's file identity (sha256 of the shared bytes), kept so a rerun of the same file resumes it. */
  invitationMeta?: { contentSha256: string; requestedDurationMs?: number };
  resultRef?: string;
  resultExpiresAt?: string;
  resultEnvelope?: unknown;
  ackId: string;
  committed?: boolean;
  commandIntent?: string;
  command?: { request: AuthRequestArtifact; result: AuthDelegationArtifact };
  acknowledged?: boolean;
}
/** Carry transport completion alongside a verified portable grant, never inside its signed claims. */
export function trackApprovalResult(source: object, verified: object): void {
  const entry = acquisitions.get(source);
  if (entry) acquisitions.set(verified, entry);
}

const acquisitions = new WeakMap<object, PendingApproval>();
/** The `--timeout` a request was acquired under; its acknowledgement is bounded by the same limit. */
const approvalWaits = new WeakMap<PendingApproval, ApprovalWait>();

/** Remote results require the durable login commit before their delivery can be acknowledged. */
export function approvalResultNeedsAck(delegation: object): boolean {
  return acquisitions.has(delegation);
}
const STATE_FILE = "approval-pending.json";

/** Local identity of the complete prepared request, independent of file spelling. */
export function approvalCommandIntent(request: AuthRequestArtifact): string {
  return "auth-grant:" + createHash("sha256").update(canonicalJson(request)).digest("hex");
}

async function commandParent(profile: string, entry: PendingApproval) {
  const key = await ProfileManager.getKey(profile) as Ed25519PrivateJwk | null;
  const current = await ProfileManager.getProfile(profile);
  if (!key || current.authSignedOut === true || signerFromJwk(key).did !== entry.request.targetDid ||
    !principalDidEquals(current.sessionDid ?? current.did, entry.request.targetDid)) {
    throw invalid("The command's profile or signing key changed.");
  }
  const verified = verifyPendingResult(entry, key);
  if (current.ownerDid?.toLowerCase() !== verified.session.ownerDid.toLowerCase()) throw invalid("The command's owner changed.");
  return verified;
}

async function verifyApprovalCommand(profile: string, entry: PendingApproval, request: AuthRequestArtifact,
  result: AuthDelegationArtifact, checkedParent?: ReturnType<typeof verifyPendingResult>): Promise<void> {
  const parent = checkedParent ?? await commandParent(profile, entry);
  if (entry.commandIntent !== approvalCommandIntent(request) || result.kind !== "tinycloud.auth.delegation" ||
    result.version !== 1 || result.requestId !== request.requestId || result.delegationCid !== result.delegation.cid ||
    result.prompted !== true) throw invalid("Saved grant does not match this prepared command.");
  const requested = finalizeSigningEntries(await commandGrants.resolvePermissionSpaces(entriesForSigning(request.requested), profile));
  if (canonicalJson(result.permissions) !== canonicalJson(requested)) throw invalid("Saved grant permissions changed.");
  const authorization = result.delegation.delegationHeader.Authorization.replace(/^Bearer /i, "");
  const signed = parseSignedCompactUcanAttenuation(authorization, result.delegationCid);
  const payload = JSON.parse(Buffer.from(authorization.split(".")[1]!, "base64url").toString("utf8")) as { prf?: unknown; exp?: unknown };
  if (!principalDidEquals(signed.payload.iss, entry.request.targetDid) ||
    !principalDidEquals(signed.payload.aud, request.sessionDid) ||
    !principalDidEquals(result.delegation.delegateDID, request.sessionDid) ||
    !Array.isArray(payload.prf) || payload.prf.length !== 1 || payload.prf[0] !== parent.delegation.delegationCid ||
    typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now() ||
    payload.exp * 1000 > Date.parse(parent.session.expiresAt) ||
    new Date(payload.exp * 1000).toISOString() !== result.expiry ||
    new Date(String(result.delegation.expiry)).toISOString() !== result.expiry ||
    result.delegation.host !== entry.request.nodeOrigin) throw invalid("Saved child grant does not bind the signed parent and requester.");
  // Read tuples only after the existing compact verifier checks signature and CID.
  const tuples = Object.entries(signed.payload.att).flatMap(([resource, abilities]) => {
    const match = /^(?:tinycloud:\/\/([^/]+)|(tinycloud:[^/]+))\/([^/]+)(?:\/|$)(.*)$/.exec(resource);
    if (!match) throw invalid("Saved child has an unsupported signed resource.");
    return Object.entries(abilities).map(([action, caveats]) => ({
      space: match[1] ?? match[2], service: "tinycloud." + match[3], path: match[4], action,
      caveats: canonicalizeRecapCaveats(caveats as Record<string, unknown>[]),
    }));
  });
  for (const permission of requested) for (const action of permission.actions) {
    const index = tuples.findIndex((tuple) => tuple.service === permission.service && tuple.path === permission.path &&
      tuple.action === action && sameLoginSpace(tuple.space, permission.space, parent.session.ownerDid) &&
      tuple.caveats === canonicalizeRecapCaveats(permission.caveats));
    if (index < 0) throw invalid("Saved child does not contain the exact requested authority.");
    tuples.splice(index, 1);
  }
  if (tuples.length) throw invalid("Saved child contains authority outside the prepared request.");
}

async function syncCommandFiles(profile: string, result: AuthDelegationArtifact): Promise<void> {
  const stored = (await commandGrants.loadLocalGrantArtifacts(profile)).find((item) => item.delegationCid === result.delegationCid);
  const history = (await commandGrants.readGrantHistory(profile)).find((item) => item.delegationCid === result.delegationCid &&
    item.source === "cli" && item.expiry === result.expiry && canonicalJson(item.addedCaps) === canonicalJson(result.permissions));
  if (!stored || canonicalJson(JSON.parse(JSON.stringify(stored.delegation))) !==
    canonicalJson(JSON.parse(JSON.stringify(result.delegation))) || !history) {
    throw invalid("The verified command result and history have not both been saved.");
  }
  for (const path of [commandGrants.localGrantArtifactsPath(profile), commandGrants.grantHistoryPath(profile), profilePath(profile)]) {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

async function persistCommandFiles(profile: string, result: AuthDelegationArtifact): Promise<void> {
  await commandGrants.appendLocalGrantArtifact(profile, result.delegation);
  if (!(await commandGrants.readGrantHistory(profile)).some((item) => item.delegationCid === result.delegationCid)) {
    await commandGrants.appendGrantHistory(profile, { addedCaps: result.permissions, source: "cli",
      delegationCid: result.delegationCid, expiry: result.expiry });
  }
  await syncCommandFiles(profile, result);
}

/** A retry returns the saved child, not a newly minted delegation. */
export async function recoverApprovalCommand(profile: string, approval: object,
  request: AuthRequestArtifact): Promise<AuthDelegationArtifact | undefined> {
  const acquired = acquisitions.get(approval);
  if (!acquired) return undefined;
  return ProfileManager.withLock(profile, async () => {
    const entries = await readJson<PendingApproval[]>(join(profilePath(profile), STATE_FILE)) ?? [];
    const matching = entries.filter((item) => item.commandIntent === approvalCommandIntent(request));
    if (matching.length !== 1 || matching[0]!.requestId !== acquired.requestId) throw invalid("Ambiguous command approval.");
    const entry = matching[0]!;
    if (!entry.command) return undefined;
    if (canonicalJson(entry.command.request) !== canonicalJson(request)) throw invalid("Prepared command changed.");
    await verifyApprovalCommand(profile, entry, request, entry.command.result);
    await persistCommandFiles(profile, entry.command.result);
    acquisitions.set(approval, entry);
    return entry.command.result;
  }, { requireProfile: true });
}

/** Save result, history, signed parent binding and stable ACK intent before any ACK. */
export async function commitApprovalCommand(profile: string, approval: object,
  request: AuthRequestArtifact, result: AuthDelegationArtifact): Promise<void> {
  const acquired = acquisitions.get(approval);
  if (!acquired) throw invalid("Command approval is not tracked.");
  await ProfileManager.withLock(profile, async () => {
    const entries = await readJson<PendingApproval[]>(join(profilePath(profile), STATE_FILE)) ?? [];
    const matching = entries.filter((item) => item.commandIntent === approvalCommandIntent(request));
    if (matching.length !== 1 || matching[0]!.requestId !== acquired.requestId) throw invalid("Ambiguous command approval.");
    const entry = matching[0]!;
    await verifyApprovalCommand(profile, entry, request, result);
    if (entry.command && canonicalJson(entry.command.result) !== canonicalJson(JSON.parse(JSON.stringify(result)))) {
      throw invalid("A different result is already saved for this command.");
    }
    entry.command = { request, result };
    await writeJsonDurable(join(profilePath(profile), STATE_FILE), entries);
    await persistCommandFiles(profile, result);
    acquisitions.set(approval, entry);
  }, { requireProfile: true });
}

function invalid(message: string): CLIError {
  return new CLIError("APPROVAL_RESULT_INVALID", message, ExitCode.PERMISSION_DENIED);
}
function configuredOrigin(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(`${label} must be an origin.`); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw invalid(`${label} must be an HTTPS origin or a loopback HTTP origin.`);
  }
  return url.origin;
}
function grantLifetimeSeconds(expiry: AuthFlowOptions["expiry"]): number {
  const durationMs = typeof expiry === "string" && /^\d+s$/.test(expiry)
    ? Number(expiry.slice(0, -1)) * 1000
    : parseRequestedExpiry(expiry ?? "7d").durationMs;
  const seconds = Math.floor(durationMs / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 60) throw invalid("Invalid requested grant lifetime.");
  return seconds;
}

async function updatePending(profile: string, update: (pending: PendingApproval[]) => PendingApproval[]): Promise<void> {
  await ProfileManager.withLock(profile, async () => {
    const directory = await ProfileManager.ensureProfileDir(profile);
    const path = join(directory, STATE_FILE);
    await writeJsonDurable(path, update(await readJson<PendingApproval[]>(path) ?? []));
  }, { requireProfile: true });
}

async function activePending(profile: string): Promise<PendingApproval[]> {
  const path = join(profilePath(profile), STATE_FILE);
  if (!(await readJson<PendingApproval[]>(path))?.length) return [];
  return ProfileManager.withLock(profile, async () => {
    const entries = await readJson<PendingApproval[]>(path) ?? [];
    const now = Date.now();
    const active = entries.filter((entry) => {
      // A saved command remains recoverable until its child expires, independently of transport retention.
      const expiry = entry.command ? entry.command.result.expiry : entry.resultExpiresAt;
      return expiry === undefined || !(Date.parse(expiry) <= now);
    });
    if (active.length !== entries.length) await writeJsonDurable(path, active);
    return active;
  }, { requireProfile: true });
}

export async function pendingApprovalKey(profile: string): Promise<Ed25519PrivateJwk | undefined> {
  const entries = await activePending(profile);
  return entries.find((entry) => entry.commandIntent === undefined && !entry.committed)?.signingKey;
}

async function forgetApproval(profile: string, entry: PendingApproval): Promise<void> {
  await updatePending(profile, (items) => items.filter((item) => item.requestId !== entry.requestId));
}

/** Drop the pending request a refused result came from, with the result key and reference it holds. No-op for a result not acquired here. */
export async function dropRefusedApproval(profile: string, delegation: object): Promise<void> {
  const entry = acquisitions.get(delegation);
  if (entry) await forgetApproval(profile, entry);
}

/**
 * Forget every pending request of this profile whose saved session key is `x` (an `auth rotate` that failed: its staged key
 * exists only there). `approved`: one of them already had an approval result (the owner approved, so a grant is live), and
 * `latestEnd` is the latest that grant can end: the request's own expiry (an approval cannot come later) plus the lifetime asked.
 */
export async function dropApprovalsHoldingKey(profile: string, x: unknown): Promise<{ dropped: boolean; approved: boolean; latestEnd?: string }> {
  if (typeof x !== "string") return { dropped: false, approved: false };
  const held = (await activePending(profile)).filter((entry) => entry.signingKey?.x === x);
  if (held.length === 0) return { dropped: false, approved: false };
  await updatePending(profile, (items) => items.filter((item) => item.signingKey?.x !== x));
  const ends = held.filter((entry) => entry.resultRef !== undefined)
    .map((entry) => Date.parse(entry.requestExpiresAt) + entry.request.grantLifetimeSeconds * 1000).filter(Number.isFinite);
  return { dropped: true, approved: ends.length > 0 || held.some((entry) => entry.resultRef !== undefined),
    ...(ends.length > 0 ? { latestEnd: new Date(Math.max(...ends)).toISOString() } : {}) };
}

/** Whether a pending request of this profile still holds the session key `x` (a first sign-in's key lives only there). */
export async function approvalHoldsKey(profile: string, x: unknown): Promise<boolean> {
  return (await activePending(profile)).some((entry) => entry.signingKey?.x === x);
}

/** Existing OpenKey session proof, purpose- and exact-resource-bound by its credential hash. */
export function approvalSessionProof(entry: Pick<PendingApproval, "requestId" | "bodyCid" | "apiOrigin"> & { signingKey: Ed25519PrivateJwk },
  action: "discover" | "fetch" | "ack", resultRef = "", ackId = ""): string {
  const jwk = entry.signingKey;
  const jkt = createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: jwk.x })).digest("base64url");
  const path = action === "discover" ? `/api/approval-requests/${entry.requestId}/result` : `/api/approval-results/${resultRef}/${action}`;
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: jkt, typ: "openkey-session-proof+jwt" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    client_id: "openkey-approval-result-v1",
    cred_hash: createHash("sha256").update(JSON.stringify([action, entry.requestId, entry.bodyCid, resultRef, ackId])).digest("base64url"),
    htm: "POST", htu: entry.apiOrigin + path, iat: Math.floor(Date.now() / 1000), jti: randomBytes(24).toString("base64url"),
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), createPrivateKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }, format: "jwk",
  })).toString("base64url")}`;
}

async function post(entry: PendingApproval, action: "discover" | "fetch" | "ack", signingKey: Ed25519PrivateJwk, timeoutMs = 10_000): Promise<Response> {
  const ref = action === "discover" ? "" : entry.resultRef ?? "";
  const path = action === "discover" ? `/api/approval-requests/${entry.requestId}/result` : `/api/approval-results/${ref}/${action}`;
  const body = action === "discover" ? { bodyCid: entry.bodyCid, header: entry.record.header, signature: entry.record.signature }
    : { requestId: entry.requestId, bodyCid: entry.bodyCid, ...(action === "ack" ? { ackId: entry.ackId } : {}) };
  return fetch(entry.apiOrigin + path, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json", "OpenKey-Session-Proof": approvalSessionProof({ requestId: entry.requestId, bodyCid: entry.bodyCid, apiOrigin: entry.apiOrigin, signingKey }, action, ref, action === "ack" ? entry.ackId : "") },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
}
async function throwRemoteError(profile: string, entry: PendingApproval, response: Response, action: "discover" | "fetch"): Promise<never> {
  const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  if (code === "expired_request") {
    await updatePending(profile, (items) => items.filter((item) => item.requestId !== entry.requestId));
    throw new CLIError("APPROVAL_REQUEST_EXPIRED", "This approval request expired before it was approved. Start a new request.", ExitCode.AUTH_REQUIRED);
  }
  if (code === "expired_result") {
    await updatePending(profile, (items) => items.filter((item) => item.requestId !== entry.requestId));
    throw new CLIError("APPROVAL_RESULT_EXPIRED", "The approved result expired before it was saved. Start a new request.", ExitCode.AUTH_REQUIRED);
  }
  if (code === "acknowledged") {
    throw new CLIError("APPROVAL_RESULT_ACKNOWLEDGED", "OpenKey has acknowledged this result; its local commit may already be complete.", ExitCode.PENDING);
  }
  if (code === "not_found") {
    await updatePending(profile, (items) => items.filter((item) => item.requestId !== entry.requestId));
    throw new CLIError(action === "discover" ? "APPROVAL_REQUEST_NOT_FOUND" : "APPROVAL_RESULT_NOT_FOUND",
      action === "discover" ? "OpenKey cannot find this approval request." : "OpenKey cannot find this approval result.", ExitCode.AUTH_REQUIRED);
  }
  if (code === "ack_conflict") throw invalid("OpenKey rejected a conflicting approval ACK intent.");
  if (code === "request_binding" || code === "invalid_proof") {
    // From the poll (no result reference yet) the CLI cannot tell whether the owner already approved.
    const rejected = invalid("OpenKey rejected the request or requester binding.");
    throw action === "discover" ? markMaybeGranted(rejected) : rejected;
  }
  throw new CLIError(action === "discover" ? "APPROVAL_REQUEST_UNAVAILABLE" : "APPROVAL_RESULT_UNAVAILABLE",
    `OpenKey could not ${action === "discover" ? "discover this request" : "fetch this result"} (HTTP ${response.status}). Retry the command to resume.`, ExitCode.PENDING);
}

function verifyPendingResult(entry: PendingApproval, key: Ed25519PrivateJwk): {
  delegation: Record<string, unknown>;
  session: ReturnType<typeof verifyScopedLogin>["session"];
} {
  if (!entry.resultRef || !entry.resultEnvelope) throw invalid("No encrypted approval result is available.");
  // The result the owner approved, once opened: a refusal carries it so the caller can name the refused delegation.
  let seen: unknown;
  try {
    const signer = signerFromJwk(key);
    const relay = createECDH("prime256v1");
    relay.setPrivateKey(Buffer.from(entry.relayPrivateKey, "base64url"));
    const opened = decryptRelayResult(entry.resultEnvelope, entry.requestId, relay);
    seen = opened.delegation;
    if (opened.resultVersion !== 1 || opened.requestId !== entry.requestId || opened.requestDigest !== entry.bodyCid ||
      opened.requesterDid !== entry.request.issuer || opened.targetDid !== entry.request.targetDid ||
      signer.did !== entry.request.issuer || typeof opened.ownerDid !== "string" ||
      typeof opened.delegationExpiresAt !== "string" || !Number.isFinite(Date.parse(opened.delegationExpiresAt)) ||
      new Date(opened.delegationExpiresAt).toISOString() !== opened.delegationExpiresAt ||
      !opened.delegation || typeof opened.delegation !== "object") throw invalid("Encrypted result binding does not match this request.");
    const delegation = opened.delegation as Record<string, unknown>;
    if (entry.request.context) {
      // Everything about the key comes from the owner-signed grant for THIS request; the owner must be the profile's own account.
      if (entry.expectedOwner === undefined) throw invalid("An invitation approval needs the profile's own account to check it against.");
      const grant = verifyInvitationGrant(delegation, key, {
        targetDid: entry.request.targetDid, ownerDid: entry.expectedOwner, request: { requestId: entry.requestId, bodyCid: entry.bodyCid },
        acceptanceExpiresAt: entry.request.context.acceptanceExpiresAt,
      });
      if (grant.ownerDid.toLowerCase() !== opened.ownerDid.toLowerCase() || grant.expiresAt !== opened.delegationExpiresAt) {
        throw invalid("Result owner or expiry differs from its signed delegation.");
      }
      return { delegation, session: { ownerDid: grant.ownerDid, permissions: grant.permissions, expiresAt: grant.expiresAt } };
    }
    const verified = verifyScopedLogin(delegation, key, entry.request.targetDid,
      entry.request.permissions as PermissionEntry[], {
        expectedOwner: entry.expectedOwner ?? opened.ownerDid,
        expiry: { durationMs: entry.request.grantLifetimeSeconds * 1000 },
        exactApproval: true,
      });
    if (verified.session.ownerDid.toLowerCase() !== opened.ownerDid.toLowerCase() ||
      verified.session.expiresAt !== opened.delegationExpiresAt) throw invalid("Result owner or expiry differs from its signed delegation.");
    return { delegation, session: verified.session };
  } catch (error) {
    // The binding checks raise APPROVAL_RESULT_INVALID, which is also raised before any result exists: only here is it a refusal of one.
    if (isPermanentRefusal(error) || (error instanceof CLIError && error.code === "APPROVAL_RESULT_INVALID")) carryRefusedDelegation(error, seen);
    throw error;
  }
}

/** The wait ended with the owner's approval still outstanding: nothing is lost, the same link stays pending. */
function pendingApproval(entry: PendingApproval, approvalWait: ApprovalWait, created = false): CLIError {
  return approvalPendingError({ step: approvalWait.step, of: approvalWait.of, approvalUrl: entry.approvalUrl, expiresAt: entry.requestExpiresAt }, created);
}

/**
 * A response body read that the request's own timeout, an abort or the connection ended, never a malformed body.
 * Node reports a reset connection as a TypeError; Bun raises a plain Error with code ECONNRESET.
 */
function bodyCutOff(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || (error as { code?: unknown }).code === "ECONNRESET"));
}

/**
 * How long OpenKey serves an approved result after the approval: production APPROVAL_RESULT_RETENTION_SECONDS=600
 * (OpenKey repo, docker-compose.prod.yml:28). A request approved just before its expiry can still be collected until
 * then, so a stored request is not dropped locally before its expiry plus this. If OpenKey changes that setting,
 * change this with it.
 */
const RESULT_RETENTION_MS = 600_000;
/** Clock skew allowed on top: a local clock that runs ahead must never drop a request OpenKey would still serve. */
const EXPIRY_SKEW_MS = 60_000;

/** Whether a stored request has been expired for so long that no result can still be served for it. */
function lapsedPastRetention(entry: PendingApproval, now: number): boolean {
  return now >= Date.parse(entry.requestExpiresAt) + RESULT_RETENTION_MS + EXPIRY_SKEW_MS;
}

/**
 * An approval request that expired before anyone approved it. Production OpenKey answers a discover after the
 * request's expiry with 400 invalid_request unless the request was approved, in which case it serves the result until
 * its retention ends; so an entry that holds no result may be dropped once OpenKey says so, or once the retention has
 * passed, and the next run makes a new request. `drop: false` leaves it in place for a run that may still ask OpenKey.
 */
async function expiredRequest(profile: string, entry: PendingApproval, drop: boolean): Promise<CLIError> {
  if (drop) await updatePending(profile, (items) => items.filter((item) => item.requestId !== entry.requestId));
  return new CLIError("APPROVAL_REQUEST_EXPIRED",
    "This approval request expired before it was approved. Run the command again: the next run makes a new request with a new link.", ExitCode.AUTH_REQUIRED);
}

/** OpenKey's answer to a discover for a request past its expiry: HTTP 400 invalid_request ("invalid or expired"), not expired_request. */
async function discoverRefusedAsExpired(entry: PendingApproval, response: Response, now: number): Promise<boolean> {
  if (response.status !== 400 || entry.resultRef !== undefined || now < Date.parse(entry.requestExpiresAt)) return false;
  const body = await response.clone().json().catch(() => null) as { code?: unknown; error?: unknown } | null;
  return body?.code === "invalid_request" || (typeof body?.error === "string" && /expired/i.test(body.error));
}

/**
 * The pause between two attempts to learn the outcome. Without a deadline it is the fixed 2 s. With one, the pause
 * ends at the deadline, after which one last attempt is made. Once the owner has approved (a result reference
 * exists) the deadline no longer applies: collecting the result gets a bounded grace and ends as "result
 * unavailable", which a re-run resumes from the saved reference, never as a pending approval.
 * `reached` says OpenKey answered the last attempt (the request is still open); otherwise it could not be asked.
 */
async function pauseBetweenAttempts(profile: string, entry: PendingApproval, approvalWait: ApprovalWait | undefined, reached = false): Promise<void> {
  if (!approvalWait) {
    await wait(2000);
    return;
  }
  const now = approvalWait.now ?? Date.now;
  const approved = entry.resultRef !== undefined;
  const remaining = approvalLimitMs(approvalWait, approved) - now();
  if (remaining <= 0) {
    if (approved) {
      throw new CLIError("APPROVAL_RESULT_UNAVAILABLE",
        "OpenKey could not fetch this approved result in time. It is saved by reference; retry the command to resume.", ExitCode.PENDING);
    }
    // OpenKey could not be asked (a network failure) and the link has run out: never hand out a dead link as pending.
    // The entry stays until no result can be served for it any more, since one approved just before the expiry may be.
    if (!reached && now() >= Date.parse(entry.requestExpiresAt)) throw await expiredRequest(profile, entry, lapsedPastRetention(entry, now()));
    throw pendingApproval(entry, approvalWait);
  }
  await (approvalWait.sleep ?? ((ms: number) => wait(ms)))(Math.min(APPROVAL_POLL_INTERVAL_MS, remaining));
}

/** Retryable reads never acknowledge or consume. The private result key is synced before the URL is exposed. */
export async function acquireApprovalRequest(_did: string, options: AuthFlowOptions): Promise<DelegationData> {
  const profile = options.profileName;
  if (!profile || !options.jwk || !options.host || (!options.permissions?.length && !options.invitationContext) ||
    (options.invitationContext && !options.expectedOwner)) {
    throw new CLIError("APPROVAL_REQUEST_CONTEXT_REQUIRED", "Approval requires a profile, session key, host and permissions.", ExitCode.USAGE_ERROR);
  }
  const signingKey = options.jwk as Ed25519PrivateJwk;
  const approvalWait = options.approvalWait;
  const signer = signerFromJwk(signingKey);
  const openkeyOrigin = configuredOrigin(options.openkeyHost ?? DEFAULT_OPENKEY_HOST, "OpenKey");
  const apiOrigin = configuredOrigin(options.openkeyApiHost ?? process.env.TC_OPENKEY_API_HOST ??
    (openkeyOrigin === DEFAULT_OPENKEY_HOST ? DEFAULT_OPENKEY_DEVICE_API_HOST : openkeyOrigin), "OpenKey API");
  const linkApiOrigin = configuredOrigin(process.env.TC_LINKS_API_ORIGIN ?? DEFAULT_LINKS_API_ORIGIN, "Links API");
  const context = options.invitationContext;
  const targetPublicJwk: OpenKeyApprovalRequestV1["targetPublicJwk"] = {
    kty: signingKey.kty, crv: signingKey.crv, x: signingKey.x,
  };
  // An invitation request names no permissions and no key: the approver chooses the key and the result is checked against its own signature.
  const spec = context
    ? buildShareInvitationApprovalSpec({ targetDid: signer.did, targetPublicJwk, nodeOrigin: options.host, context, now: Date.now() })
    : { issuer: signer.did, requestVersion: 1 as const, targetDid: signer.did,
      targetPublicJwk, nodeOrigin: options.host, permissions: options.permissions as OpenKeyApprovalRequestV1["permissions"],
      ...(options.reason ? { reason: options.reason } : {}), grantLifetimeSeconds: grantLifetimeSeconds(options.expiry) };
  if (options.commandIntent !== undefined && !/^auth-grant:[0-9a-f]{64}$/.test(options.commandIntent)) {
    throw invalid("Invalid approval command intent.");
  }
  const matching = (await activePending(profile)).filter((item) => {
    if (item.commandIntent !== options.commandIntent) return false;
    const { resultEncryptionPublicJwk: _, permissions: priorPermissions, ...prior } = item.request;
    const { permissions: nextPermissions, ...nextRaw } = spec;
    // A resumed invitation keeps its first lifetime; the window is fixed by the context, not by when this run started.
    const next = context ? { ...nextRaw, grantLifetimeSeconds: prior.grantLifetimeSeconds, suggestedLifetimeSeconds: prior.suggestedLifetimeSeconds } : nextRaw;
    if (canonicalJson(prior) !== canonicalJson(next) || item.apiOrigin !== apiOrigin ||
      item.linkApiOrigin !== linkApiOrigin || item.openkeyOrigin !== openkeyOrigin ||
      priorPermissions.length !== nextPermissions.length) return false;
    // Saving the first signed result resolves logical space names to its owner.
    // Compare that spelling only after re-verifying the original encrypted result.
    let owner: string | undefined;
    try { owner = item.resultEnvelope ? verifyPendingResult(item, signingKey).session.ownerDid : item.expectedOwner; }
    catch (error) {
      if (error instanceof CLIError && error.code === "AUTH_EXPIRED") return false;
      throw error;
    }
    if ((item.expectedOwner !== undefined || options.expectedOwner !== undefined) &&
      (!owner || !options.expectedOwner || normalizePkhIdentifier(owner) !== normalizePkhIdentifier(options.expectedOwner))) return false;
    return priorPermissions.every(({ space, ...permission }, index) => {
      const { space: nextSpace, ...nextPermission } = nextPermissions[index]!;
      return canonicalJson(permission) === canonicalJson(nextPermission) &&
        (owner ? sameLoginSpace(space, nextSpace, owner) : space === nextSpace);
    });
  });
  if (matching.length > 1) throw invalid("Multiple approvals match this command; no result was selected.");
  let entry = matching[0];
  const isNewRequest = entry === undefined;
  // Under --timeout a stored request that holds no result and expired so long ago that OpenKey cannot serve one any
  // more is decided here, before OpenKey is asked and before its dead link is shown again. A younger expired request
  // is left to OpenKey: it may be an approval given just before the expiry.
  if (entry && approvalWait && !entry.resultRef && !entry.resultEnvelope && lapsedPastRetention(entry, (approvalWait.now ?? Date.now)())) {
    throw await expiredRequest(profile, entry, true);
  }
  if (!entry) {
    const relay = createECDH("prime256v1");
    relay.generateKeys();
    const request = { ...spec, resultEncryptionPublicJwk: relayPublicJwkOf(relay) };
    const created = await createApprovalRequest({ request, issuerKey: signer, apiOrigin: linkApiOrigin, openkeyOrigin,
      ...(context ? { expiresAt: new Date(context.acceptanceExpiresAt) } : {}) });
    const profileKey = await ProfileManager.getKey(profile) as Ed25519PrivateJwk | null;
    entry = { version: 1, request, requestId: created.id, bodyCid: created.bodyCid, approvalUrl: created.link,
      requestExpiresAt: created.expiresAt, record: created.record, apiOrigin, linkApiOrigin, openkeyOrigin,
      ...(profileKey && signerFromJwk(profileKey).did === signer.did ? {} : { signingKey }),
      relayPrivateKey: relay.getPrivateKey().toString("base64url"), expectedOwner: options.expectedOwner, ackId: randomUUID(),
      ...(options.invitationMeta === undefined ? {} : { invitationMeta: options.invitationMeta }),
      ...(options.commandIntent === undefined ? {} : { commandIntent: options.commandIntent }) };
    await updatePending(profile, (items) => [...items, entry!]);
  }
  if (!entry.resultRef && !entry.resultEnvelope) {
    options.onApprovalRequest?.({ approvalUrl: entry.approvalUrl, requestId: entry.requestId, expiresAt: entry.requestExpiresAt });
    if (!options.onApprovalRequest) console.error(`Approve this request in OpenKey (open the complete link):\n${entry.approvalUrl}\n`);
    if (!options.noPopup && !options.onApprovalRequest && process.env.TC_AUTH_NO_POPUP !== "1" && process.env.TC_NO_POPUP !== "1") {
      await tryOpenBrowser(entry.approvalUrl);
    }
    // A new link cannot be approved yet. With a deadline, hand it to the caller at once so it can be sent.
    if (isNewRequest && approvalWait) throw pendingApproval(entry, approvalWait, true);
  }
  if (!entry.resultEnvelope) {
    // An approval not yet discovered gets its first check with the full request limit whatever the deadline (see firstCheckTimeoutMs):
    // the deadline decides only after an answer. An entry that already holds a result reference keeps the old limits and outcomes.
    let answered = false;
    for (;;) {
      const firstWait = !answered && entry.resultRef === undefined ? approvalWait : undefined;
      let response: Response;
      try { response = await post(entry, "discover", signingKey, firstWait ? firstCheckTimeoutMs(firstWait) : approvalRequestTimeoutMs(approvalWait, entry.resultRef !== undefined)); }
      catch (error) {
        // No answer at all within the first check's full limit: OpenKey is not reachable. That is not "still pending".
        if (firstWait && error instanceof Error && error.name === "TimeoutError") {
          // The hint is set here so the generic network hint (about the TinyCloud node profile) is not attached.
          throw new CLIError("NETWORK_ERROR", `OpenKey did not answer the approval status check within ${Math.round(firstCheckTimeoutMs(firstWait) / 1000)} seconds. The approval request is saved: run the same command again.`, ExitCode.NETWORK_ERROR,
            { hint: "The saved approval request resumes on the next run; no new link is needed." });
        }
        await pauseBetweenAttempts(profile, entry, approvalWait);
        continue;
      }
      answered = true;
      if (response.status === 202) {
        await pauseBetweenAttempts(profile, entry, approvalWait, true);
        continue;
      }
      if (!response.ok && await discoverRefusedAsExpired(entry, response, (approvalWait?.now ?? Date.now)())) {
        throw await expiredRequest(profile, entry, true);
      }
      if (!response.ok) await throwRemoteError(profile, entry, response, "discover");
      let discovered: { resultRef?: unknown; expiresAt?: unknown };
      try { discovered = await response.json() as { resultRef?: unknown; expiresAt?: unknown }; } catch (error) {
        // Under --timeout a body the request cap or the connection cut off is a network failure like a lost request,
        // but OpenKey did answer (200): it is reached, so the expiry check does not apply.
        if (!approvalWait || !bodyCutOff(error)) throw error;
        await pauseBetweenAttempts(profile, entry, approvalWait, true);
        continue;
      }
      if (typeof discovered.resultRef !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(discovered.resultRef) ||
        typeof discovered.expiresAt !== "string" || !Number.isFinite(Date.parse(discovered.expiresAt))) {
        throw invalid("Invalid approval result reference.");
      }
      entry.resultRef = discovered.resultRef;
      entry.resultExpiresAt = discovered.expiresAt;
      await updatePending(profile, (items) => items.map((item) => item.requestId === entry!.requestId ? entry! : item));
      let fetched: Response;
      try { fetched = await post(entry, "fetch", signingKey, approvalRequestTimeoutMs(approvalWait, true)); } catch {
        // The owner approved: collect past the deadline, paced, for a bounded grace.
        if (approvalWait) await pauseBetweenAttempts(profile, entry, approvalWait);
        continue;
      }
      if (!fetched.ok) await throwRemoteError(profile, entry, fetched, "fetch");
      let result: Record<string, unknown>;
      try { result = await fetched.json() as Record<string, unknown>; } catch (error) {
        if (!approvalWait || !bodyCutOff(error)) throw error;
        await pauseBetweenAttempts(profile, entry, approvalWait, true);
        continue;
      }
      if (result.requestId !== entry.requestId || result.bodyCid !== entry.bodyCid ||
        result.resultRef !== entry.resultRef || result.expiresAt !== entry.resultExpiresAt ||
        !result.relay || typeof result.relay !== "object") throw invalid("Result reference does not match this request.");
      entry.resultEnvelope = result.relay;
      break;
    }
  }
  let verified: ReturnType<typeof verifyPendingResult>;
  try { verified = verifyPendingResult(entry, signingKey); } catch (error) {
    // A refused result is never served from this entry again: its result key and reference are dropped now, as for an
    // expired or unknown result. AUTH_EXPIRED and every other error keep the entry so the same command can resume.
    if (isPermanentRefusal(error)) await forgetApproval(profile, entry);
    throw error;
  }
  await updatePending(profile, (items) => items.map((item) => item.requestId === entry!.requestId ? entry! : item));
  acquisitions.set(verified.delegation, entry);
  if (approvalWait) approvalWaits.set(entry, approvalWait);
  return verified.delegation as DelegationData;
}

/** Call only after committing authority. Re-check stored evidence under the profile lock and sync it before ACK intent. */
export async function completeApprovalResult(profile: string, delegation?: object): Promise<void> {
  // A pasted short code's local copy is dropped only now: every caller reaches here after its durable commit.
  if (delegation) await dropCommittedDelegation(profile, delegation);
  const acquired = delegation ? acquisitions.get(delegation) : undefined;
  const entries = acquired ? [acquired] : await activePending(profile);
  for (const entry of entries) {
    if (!acquired && entry.commandIntent !== undefined) continue;
    if (!entry.resultRef || !entry.resultEnvelope) continue;
    let saved = false;
    let expired = false;
    let ackKey: Ed25519PrivateJwk | undefined;
    await ProfileManager.withLock(profile, async () => {
      const key = await ProfileManager.getKey(profile) as Ed25519PrivateJwk | null;
      if (!key || signerFromJwk(key).did !== entry.request.targetDid) return;
      let verified: ReturnType<typeof verifyPendingResult>;
      try { verified = verifyPendingResult(entry, key); }
      catch (error) {
        if (!(error instanceof CLIError) || error.code !== "AUTH_EXPIRED") throw error;
        await updatePending(profile, (items) => items.filter((item) => item.requestId !== entry.requestId));
        expired = true;
        return;
      }
      const { delegation: verifiedDelegation, session: verifiedSession } = verified;
      const current = await ProfileManager.getProfile(profile);
      if (current.ownerDid?.toLowerCase() !== verifiedSession.ownerDid.toLowerCase()) return;
      const session = await ProfileManager.getSession(profile) as Record<string, unknown> | null;
      if (session && session.delegationCid === verifiedDelegation.delegationCid &&
        session.signature === verifiedDelegation.signature && session.siwe === verifiedDelegation.siwe) {
        await syncAuthCredentialFiles(profilePath(profile));
        await ProfileManager.setProfileDurable(profile, current);
        saved = true;
      } else {
        const grants = await loadAdditionalDelegations(profile);
        const stored = grants.find((item) => item.delegation.cid === verifiedDelegation.delegationCid &&
          item.delegation.siweProof?.siwe === verifiedDelegation.siwe &&
          item.delegation.siweProof?.signature === verifiedDelegation.signature);
        if (stored) {
          const file = await open(additionalDelegationsPath(profile), "r");
          try { await file.sync(); } finally { await file.close(); }
          const directory = await open(profilePath(profile), "r");
          try { await directory.sync(); } finally { await directory.close(); }
          saved = true;
        }
      }
      if (entry.commandIntent !== undefined) {
        if (!entry.command) throw invalid("The command result has not been durably saved; no ACK was sent.");
        await verifyApprovalCommand(profile, entry, entry.command.request, entry.command.result,
          { delegation: verifiedDelegation, session: verifiedSession });
        await syncCommandFiles(profile, entry.command.result);
        saved = true;
      }
      if (saved) {
        entry.committed = true;
        ackKey = key;
        delete entry.signingKey;
        await updatePending(profile, (items) => items.map((item) => item.requestId === entry.requestId ? entry : item));
      }
    }, { requireProfile: true });
    if (expired) continue;
    if (!saved || !ackKey) {
      if (acquired) throw invalid("Approval has not been durably saved; no ACK was sent.");
      continue;
    }
    if (entry.acknowledged) continue;
    let response: Response;
    try { response = await post(entry, "ack", ackKey, approvalRequestTimeoutMs(approvalWaits.get(entry), true)); }
    catch { throw new CLIError("APPROVAL_ACK_PENDING", "Approval is saved; ACK outcome is unknown. Retry this command to acknowledge the same result.", ExitCode.PENDING); }
    const result = await response.json().catch(() => null) as { ackId?: string; status?: string; code?: string } | null;
    const terminal = !response.ok && ["expired_result", "not_found", "acknowledged"].includes(result?.code ?? "");
    if (!terminal && (!response.ok || result?.ackId !== entry.ackId || result?.status !== "acknowledged")) {
      throw new CLIError("APPROVAL_ACK_PENDING", `Approval is saved; ACK is pending (HTTP ${response.status}). Retry this command.`, ExitCode.PENDING);
    }
    await updatePending(profile, (items) => entry.command
      ? items.map((item) => item.requestId === entry.requestId ? { ...entry, acknowledged: true } : item)
      : items.filter((item) => item.requestId !== entry.requestId));
  }
}

/**
 * The context of a still-open invitation approval for this recipient and file, so a rerun resumes it instead of asking again.
 * Everything the owner was shown must match: recipient, subject kind and name, and the content's access expiry.
 */
export async function pendingInvitationContext(profile: string, match: {
  recipientEmail: string; subjectKind: "file" | "session"; subjectName: string; accessExpiresAt: string; contentSha256?: string; requestedDurationMs?: number; now?: number;
}): Promise<ShareInvitationApprovalContext | undefined> {
  const now = match.now ?? Date.now();
  return (await activePending(profile)).flatMap((entry) => entry.request.context ? [{ context: entry.request.context, entry }] : [])
    .find(({ context, entry }) => context.recipientEmail === match.recipientEmail && context.subjectKind === match.subjectKind && context.subjectName === match.subjectName
      && Date.parse(context.acceptanceExpiresAt) > now && entry.invitationMeta?.contentSha256 === match.contentSha256
      // The same absolute date, or the SAME relative choice the user made then (the exact duration, never inferred from timing): such a rerun
      // resumes the open request and its own absolute date. Any other duration, even by a second, is a new choice and a new request.
      && (context.accessExpiresAt === match.accessExpiresAt
        // A resumed date is only ever one earlier than the new request's and still usable (more than a minute left): both are decided here,
        // before anything is installed or taken.
        || (match.requestedDurationMs !== undefined && entry.invitationMeta?.requestedDurationMs === match.requestedDurationMs
          && Date.parse(context.accessExpiresAt) < Date.parse(match.accessExpiresAt) && Date.parse(context.accessExpiresAt) > now + 60_000)))?.context;
}

/**
 * Take an approved invitation grant exactly once: the pending record is removed first, so a rerun or a second process
 * cannot use the same approval for a second send, and then OpenKey is told the result was received (best effort; its
 * copy expires on its own). A send that fails after this needs a new approval.
 */
export async function takeInvitationApproval(profile: string, delegation: object): Promise<void> {
  const entry = acquisitions.get(delegation);
  if (!entry?.request.context || !entry.resultRef) throw invalid("This is not an invitation approval that has a result.");
  const profileKey = await ProfileManager.getKey(profile) as Ed25519PrivateJwk | null;
  const key = entry.signingKey ?? profileKey;
  if (!key || signerFromJwk(key).did !== entry.request.targetDid) throw invalid("The approval was not requested by this profile's key.");
  let present = false;
  await updatePending(profile, (items) => {
    present = items.some((item) => item.requestId === entry.requestId);
    return items.filter((item) => item.requestId !== entry.requestId);
  });
  if (!present) throw invalid("This invitation approval was already used; request a new one.");
  try { await post(entry, "ack", key); } catch { /* the result expires on its own */ }
}

/** The facts of an approved invitation grant, read again from its owner-signed bytes for THIS acquired request (never from the result's own fields). */
export function invitationGrantOf(delegation: object, key: object): VerifiedInvitationGrant {
  const entry = acquisitions.get(delegation);
  if (!entry?.request.context || entry.expectedOwner === undefined) throw invalid("This is not an invitation approval for this profile.");
  return verifyInvitationGrant(delegation as Record<string, unknown>, key, {
    targetDid: entry.request.targetDid, ownerDid: entry.expectedOwner, request: { requestId: entry.requestId, bodyCid: entry.bodyCid },
    acceptanceExpiresAt: entry.request.context.acceptanceExpiresAt,
  });
}
