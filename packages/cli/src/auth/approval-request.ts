import { createECDH, createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { tryOpenBrowser } from "../lib/browser.js";
import { normalizePkhIdentifier } from "../lib/space.js";
import { profilePath } from "@tinycloud/operations/state";
import { createApprovalRequest, DEFAULT_LINKS_API_ORIGIN, signerFromJwk, type Ed25519PrivateJwk, type LinkRecord, type OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { EXPIRY } from "@tinycloud/sdk-core";
import { ProfileManager } from "../config/profiles.js";
import { readJson, writeJsonDurable, syncAuthCredentialFiles } from "../config/storage.js";
import { DEFAULT_OPENKEY_HOST, DEFAULT_OPENKEY_DEVICE_API_HOST, ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { additionalDelegationsPath, loadAdditionalDelegations } from "../lib/permissions.js";
import type { AuthFlowOptions, DelegationData } from "./browser-auth.js";
import { decryptRelayResult, relayPublicJwkOf } from "./device-auth.js";
import { canonicalJson, parseRequestedExpiry, sameLoginSpace, verifyScopedLogin } from "./scoped-login.js";

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
  signingKey: Ed25519PrivateJwk;
  relayPrivateKey: string;
  expectedOwner?: string;
  resultRef?: string;
  resultExpiresAt?: string;
  resultEnvelope?: unknown;
  ackId: string;
  committed?: boolean;
}
/** Carry transport completion alongside a verified portable grant, never inside its signed claims. */
export function trackApprovalResult(source: object, verified: object): void {
  const entry = acquisitions.get(source);
  if (entry) acquisitions.set(verified, entry);
}

const acquisitions = new WeakMap<object, PendingApproval>();

/** Remote results require the durable login commit before their delivery can be acknowledged. */
export function approvalResultNeedsAck(delegation: object): boolean {
  return acquisitions.has(delegation);
}
const STATE_FILE = "approval-pending.json";

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
  const durationMs = expiry === undefined
    ? EXPIRY.SESSION_MS
    : typeof expiry === "string" && /^\d+s$/.test(expiry)
      ? Number(expiry.slice(0, -1)) * 1000
      : parseRequestedExpiry(expiry).durationMs;
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

export async function pendingApprovalKey(profile: string): Promise<Ed25519PrivateJwk | undefined> {
  const entries = await readJson<PendingApproval[]>(join(profilePath(profile), STATE_FILE)) ?? [];
  return entries.find((entry) => !entry.committed)?.signingKey;
}

/** Existing OpenKey session proof, purpose- and exact-resource-bound by its credential hash. */
export function approvalSessionProof(entry: Pick<PendingApproval, "requestId" | "bodyCid" | "signingKey" | "apiOrigin">,
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

async function post(entry: PendingApproval, action: "discover" | "fetch" | "ack"): Promise<Response> {
  const ref = action === "discover" ? "" : entry.resultRef ?? "";
  const path = action === "discover" ? `/api/approval-requests/${entry.requestId}/result` : `/api/approval-results/${ref}/${action}`;
  const body = action === "discover" ? { bodyCid: entry.bodyCid, header: entry.record.header, signature: entry.record.signature }
    : { requestId: entry.requestId, bodyCid: entry.bodyCid, ...(action === "ack" ? { ackId: entry.ackId } : {}) };
  return fetch(entry.apiOrigin + path, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json", "OpenKey-Session-Proof": approvalSessionProof(entry, action, ref, action === "ack" ? entry.ackId : "") },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
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
  if (code === "request_binding" || code === "invalid_proof") throw invalid("OpenKey rejected the request or requester binding.");
  throw new CLIError(action === "discover" ? "APPROVAL_REQUEST_UNAVAILABLE" : "APPROVAL_RESULT_UNAVAILABLE",
    `OpenKey could not ${action === "discover" ? "discover this request" : "fetch this result"} (HTTP ${response.status}). Retry the command to resume.`, ExitCode.PENDING);
}

function verifyPendingResult(entry: PendingApproval, key: Ed25519PrivateJwk = entry.signingKey): {
  delegation: Record<string, unknown>;
  session: ReturnType<typeof verifyScopedLogin>["session"];
} {
  if (!entry.resultRef || !entry.resultEnvelope) throw invalid("No encrypted approval result is available.");
  const signer = signerFromJwk(key);
  const relay = createECDH("prime256v1");
  relay.setPrivateKey(Buffer.from(entry.relayPrivateKey, "base64url"));
  const opened = decryptRelayResult(entry.resultEnvelope, entry.requestId, relay);
  if (opened.resultVersion !== 1 || opened.requestId !== entry.requestId || opened.requestDigest !== entry.bodyCid ||
    opened.requesterDid !== entry.request.issuer || opened.targetDid !== entry.request.targetDid ||
    signer.did !== entry.request.issuer || typeof opened.ownerDid !== "string" ||
    typeof opened.delegationExpiresAt !== "string" || !Number.isFinite(Date.parse(opened.delegationExpiresAt)) ||
    new Date(opened.delegationExpiresAt).toISOString() !== opened.delegationExpiresAt ||
    !opened.delegation || typeof opened.delegation !== "object") throw invalid("Encrypted result binding does not match this request.");
  const delegation = opened.delegation as Record<string, unknown>;
  const verified = verifyScopedLogin(delegation, key, entry.request.targetDid,
    entry.request.permissions as PermissionEntry[], {
      expectedOwner: entry.expectedOwner ?? opened.ownerDid,
      expiry: { durationMs: entry.request.grantLifetimeSeconds * 1000 },
      exactApproval: true,
    });
  if (verified.session.ownerDid.toLowerCase() !== opened.ownerDid.toLowerCase() ||
    verified.session.expiresAt !== opened.delegationExpiresAt) throw invalid("Result owner or expiry differs from its signed delegation.");
  return { delegation, session: verified.session };
}

/** Retryable reads never acknowledge or consume. The private result key is synced before the URL is exposed. */
export async function acquireApprovalRequest(_did: string, options: AuthFlowOptions): Promise<DelegationData> {
  const profile = options.profileName;
  if (!profile || !options.jwk || !options.host || !options.permissions?.length) {
    throw new CLIError("APPROVAL_REQUEST_CONTEXT_REQUIRED", "Approval requires a profile, session key, host and permissions.", ExitCode.USAGE_ERROR);
  }
  const signingKey = options.jwk as Ed25519PrivateJwk;
  const signer = signerFromJwk(signingKey);
  const openkeyOrigin = configuredOrigin(options.openkeyHost ?? DEFAULT_OPENKEY_HOST, "OpenKey");
  const apiOrigin = configuredOrigin(options.openkeyApiHost ?? process.env.TC_OPENKEY_API_HOST ??
    (openkeyOrigin === DEFAULT_OPENKEY_HOST ? DEFAULT_OPENKEY_DEVICE_API_HOST : openkeyOrigin), "OpenKey API");
  const linkApiOrigin = configuredOrigin(process.env.TC_LINKS_API_ORIGIN ?? DEFAULT_LINKS_API_ORIGIN, "Links API");
  const lifetime = grantLifetimeSeconds(options.expiry);
  const targetPublicJwk: OpenKeyApprovalRequestV1["targetPublicJwk"] = {
    kty: signingKey.kty, crv: signingKey.crv, x: signingKey.x,
  };
  const spec = { issuer: signer.did, requestVersion: 1 as const, targetDid: signer.did,
    targetPublicJwk, nodeOrigin: options.host, permissions: options.permissions as OpenKeyApprovalRequestV1["permissions"],
    ...(options.reason ? { reason: options.reason } : {}), grantLifetimeSeconds: lifetime };
  let entry = (await readJson<PendingApproval[]>(join(profilePath(profile), STATE_FILE)) ?? []).find((item) => {
    const { resultEncryptionPublicJwk: _, permissions: priorPermissions, ...prior } = item.request;
    const { permissions: nextPermissions, ...next } = spec;
    if (canonicalJson(prior) !== canonicalJson(next) || item.apiOrigin !== apiOrigin ||
      item.linkApiOrigin !== linkApiOrigin || item.openkeyOrigin !== openkeyOrigin ||
      priorPermissions.length !== nextPermissions.length) return false;
    // Saving the first signed result resolves logical space names to its owner.
    // Compare that spelling only after re-verifying the original encrypted result.
    const owner = item.resultEnvelope ? verifyPendingResult(item).session.ownerDid : item.expectedOwner;
    if ((item.expectedOwner !== undefined || options.expectedOwner !== undefined) &&
      (!owner || !options.expectedOwner || normalizePkhIdentifier(owner) !== normalizePkhIdentifier(options.expectedOwner))) return false;
    return priorPermissions.every(({ space, ...permission }, index) => {
      const { space: nextSpace, ...nextPermission } = nextPermissions[index]!;
      return canonicalJson(permission) === canonicalJson(nextPermission) &&
        (owner ? sameLoginSpace(space, nextSpace, owner) : space === nextSpace);
    });
  });
  if (!entry) {
    const relay = createECDH("prime256v1");
    relay.generateKeys();
    const request = { ...spec, resultEncryptionPublicJwk: relayPublicJwkOf(relay) };
    const created = await createApprovalRequest({ request, issuerKey: signer, apiOrigin: linkApiOrigin, openkeyOrigin });
    entry = { version: 1, request, requestId: created.id, bodyCid: created.bodyCid, approvalUrl: created.link,
      requestExpiresAt: created.expiresAt, record: created.record, apiOrigin, linkApiOrigin, openkeyOrigin, signingKey,
      relayPrivateKey: relay.getPrivateKey().toString("base64url"), expectedOwner: options.expectedOwner, ackId: randomUUID() };
    await updatePending(profile, (items) => [...items, entry!]);
  }
  if (!entry.resultRef && !entry.resultEnvelope) {
    options.onApprovalRequest?.({ approvalUrl: entry.approvalUrl, requestId: entry.requestId, expiresAt: entry.requestExpiresAt });
    if (!options.onApprovalRequest) console.error(`Approve this request in OpenKey: ${entry.approvalUrl}`);
    if (!options.noPopup && !options.onApprovalRequest && process.env.TC_AUTH_NO_POPUP !== "1" && process.env.TC_NO_POPUP !== "1") {
      await tryOpenBrowser(entry.approvalUrl);
    }
  }
  if (!entry.resultEnvelope) {
    for (;;) {
      let response: Response;
      try { response = await post(entry, "discover"); }
      catch {
        await wait(2000);
        continue;
      }
      if (response.status === 202) {
        await wait(2000);
        continue;
      }
      if (!response.ok) await throwRemoteError(profile, entry, response, "discover");
      const discovered = await response.json() as { resultRef?: unknown; expiresAt?: unknown };
      if (typeof discovered.resultRef !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(discovered.resultRef) ||
        typeof discovered.expiresAt !== "string" || !Number.isFinite(Date.parse(discovered.expiresAt))) {
        throw invalid("Invalid approval result reference.");
      }
      entry.resultRef = discovered.resultRef;
      entry.resultExpiresAt = discovered.expiresAt;
      await updatePending(profile, (items) => items.map((item) => item.requestId === entry!.requestId ? entry! : item));
      let fetched: Response;
      try { fetched = await post(entry, "fetch"); } catch { continue; }
      if (!fetched.ok) await throwRemoteError(profile, entry, fetched, "fetch");
      const result = await fetched.json() as Record<string, unknown>;
      if (result.requestId !== entry.requestId || result.bodyCid !== entry.bodyCid ||
        result.resultRef !== entry.resultRef || result.expiresAt !== entry.resultExpiresAt ||
        !result.relay || typeof result.relay !== "object") throw invalid("Result reference does not match this request.");
      entry.resultEnvelope = result.relay;
      break;
    }
  }
  const verified = verifyPendingResult(entry, signingKey);
  await updatePending(profile, (items) => items.map((item) => item.requestId === entry!.requestId ? entry! : item));
  acquisitions.set(verified.delegation, entry);
  return verified.delegation as DelegationData;
}

/** Call only after committing authority. Re-check stored evidence under the profile lock and sync it before ACK intent. */
export async function completeApprovalResult(profile: string, delegation?: object): Promise<void> {
  const acquired = delegation ? acquisitions.get(delegation) : undefined;
  const entries = acquired ? [acquired] : await readJson<PendingApproval[]>(join(profilePath(profile), STATE_FILE)) ?? [];
  for (const entry of entries) {
    if (!entry.resultRef || !entry.resultEnvelope) continue;
    let saved = false;
    await ProfileManager.withLock(profile, async () => {
      const key = await ProfileManager.getKey(profile) as Ed25519PrivateJwk | null;
      if (!key || signerFromJwk(key).did !== entry.request.targetDid) return;
      const { delegation: verifiedDelegation, session: verifiedSession } = verifyPendingResult(entry, key);
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
      if (saved) {
        entry.committed = true;
        await updatePending(profile, (items) => items.map((item) => item.requestId === entry.requestId ? entry : item));
      }
    }, { requireProfile: true });
    if (!saved) {
      if (acquired) throw invalid("Approval has not been durably saved; no ACK was sent.");
      continue;
    }
    let response: Response;
    try { response = await post(entry, "ack"); }
    catch { throw new CLIError("APPROVAL_ACK_PENDING", "Approval is saved; ACK outcome is unknown. Retry this command to acknowledge the same result.", ExitCode.PENDING); }
    const result = await response.json() as { ackId?: string; status?: string };
    if (!response.ok || result.ackId !== entry.ackId || result.status !== "acknowledged") {
      throw new CLIError("APPROVAL_ACK_PENDING", `Approval is saved; ACK is pending (HTTP ${response.status}). Retry this command.`, ExitCode.PENDING);
    }
    await updatePending(profile, (items) => items.filter((item) => item.requestId !== entry.requestId));
  }
}
