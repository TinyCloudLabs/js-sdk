import { createECDH, createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { tryOpenBrowser } from "../lib/browser.js";
import { normalizePkhIdentifier } from "../lib/space.js";
import { additionalDelegationsPath, profilePath } from "@tinycloud/operations/state";
import {
  approvalEntrySchema, callApproval, createApprovalRequest, DEFAULT_LINKS_API_ORIGIN, driveApproval, localExpiry, reduce, requesterState, signerFromJwk,
  type ApprovalEntry, type ApprovalTransport, type ApprovalVerdict, type CallOptions, type CallResult, type Ed25519PrivateJwk,
  type OpenKeyApprovalRequestV1, type Outcome,
} from "@tinycloud/share-envelope/links";
import { principalDidEquals, type AuthDelegationArtifact, type AuthRequestArtifact, type PermissionEntry } from "@tinycloud/node-sdk";
import { canonicalizeRecapCaveats, parseSignedCompactUcanAttenuation } from "@tinycloud/sdk-core";
import { ProfileManager } from "../config/profiles.js";
import { syncAuthCredentialFiles } from "../config/storage.js";
import { DEFAULT_OPENKEY_HOST, DEFAULT_OPENKEY_DEVICE_API_HOST, ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { loadAdditionalDelegations } from "../lib/permissions.js";
import * as commandGrants from "../lib/permissions.js";
import { entriesForSigning, finalizeSigningEntries } from "../lib/apps-agent-preset.js";
import type { AuthFlowOptions, DelegationData } from "./browser-auth.js";
import { dropCommittedDelegation } from "./pending-code.js";
import { carryRefusedDelegation, isClockDependent, isPermanentRefusal } from "./refusal.js";
import { decryptRelayResult, relayPublicJwkOf } from "./device-auth.js";
import { canonicalJson, parseRequestedExpiry, sameLoginSpace, verifyScopedLogin } from "./scoped-login.js";
import type { ApprovalWait } from "./approval-wait.js";
import { fileApprovalStore, loadApprovals, updateApprovals } from "./approval-store.js";
import { approvalOutcomeError, approvalOutcomeWarning } from "./approval-outcome.js";
import { approvalNextLine } from "./approval-next-line.js";

/**
 * CLI-only fields of an approval entry, kept under `ext.cli` (the machine round-trips `ext` untouched). The relay result of a
 * command entry is opened once, so its owner-signed parent is kept beside the saved child: once the request is acknowledged the
 * entry holds no key, and the repeated command still needs the parent to prove the child is bound to it.
 */
interface CliExt {
  expectedOwner?: string;
  commandIntent?: string;
  command?: { request: AuthRequestArtifact; result: AuthDelegationArtifact; parent?: Record<string, unknown> };
}

function cliOf(entry: ApprovalEntry): CliExt {
  const ext = entry.ext.cli;
  if (typeof ext !== "object" || ext === null) return {};
  const owner = "expectedOwner" in ext && typeof ext.expectedOwner === "string" ? ext.expectedOwner : undefined;
  const intent = "commandIntent" in ext && typeof ext.commandIntent === "string" ? ext.commandIntent : undefined;
  // Written by this module and checked again by `verifyApprovalCommand` (canonical JSON of request and result) before any use.
  const command: CliExt["command"] = "command" in ext && typeof ext.command === "object" && ext.command !== null ? ext.command as CliExt["command"] : undefined;
  return { ...(owner === undefined ? {} : { expectedOwner: owner }), ...(intent === undefined ? {} : { commandIntent: intent }), ...(command === undefined ? {} : { command }) };
}

const withCli = (entry: ApprovalEntry, change: Partial<CliExt>): ApprovalEntry => ({ ...entry, ext: { ...entry.ext, cli: { ...cliOf(entry), ...change } } });

/** The grant (and the clock and `--timeout` its approval ran under) behind a delegation this module returned. */
interface Acquired { readonly requestId: string; readonly clock: Clock }
interface Clock { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> }

/** Carry transport completion alongside a verified portable grant, never inside its signed claims. */
export function trackApprovalResult(source: object, verified: object): void {
  const entry = acquisitions.get(source);
  if (entry) acquisitions.set(verified, entry);
}

const acquisitions = new WeakMap<object, Acquired>();

/** Remote results require the durable login commit before their delivery can be acknowledged. */
export function approvalResultNeedsAck(delegation: object): boolean {
  return acquisitions.has(delegation);
}

/** Local identity of the complete prepared request, independent of file spelling. */
export function approvalCommandIntent(request: AuthRequestArtifact): string {
  return "auth-grant:" + createHash("sha256").update(canonicalJson(request)).digest("hex");
}

async function commandParent(profile: string, entry: ApprovalEntry) {
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

async function verifyApprovalCommand(profile: string, entry: ApprovalEntry, request: AuthRequestArtifact,
  result: AuthDelegationArtifact, checkedParent?: ReturnType<typeof verifyPendingResult>): Promise<void> {
  const parent = checkedParent ?? await commandParent(profile, entry);
  if (cliOf(entry).commandIntent !== approvalCommandIntent(request) || result.kind !== "tinycloud.auth.delegation" ||
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

/** The one saved request of this command, or an error when none or several match: no result is ever picked for it. */
async function commandEntry(profile: string, request: AuthRequestArtifact, acquired: Acquired): Promise<ApprovalEntry> {
  const { entries } = await loadApprovals(profile);
  const matching = entries.filter((item) => cliOf(item).commandIntent === approvalCommandIntent(request));
  if (matching.length !== 1 || matching[0]!.requestId !== acquired.requestId) throw invalid("Ambiguous command approval.");
  return matching[0]!;
}

/** A retry returns the saved child, not a newly minted delegation. */
export async function recoverApprovalCommand(profile: string, approval: object,
  request: AuthRequestArtifact): Promise<AuthDelegationArtifact | undefined> {
  const acquired = acquisitions.get(approval);
  if (!acquired) return undefined;
  return ProfileManager.withLock(profile, async () => {
    const entry = await commandEntry(profile, request, acquired);
    const saved = cliOf(entry).command;
    if (!saved) return undefined;
    if (canonicalJson(saved.request) !== canonicalJson(request)) throw invalid("Prepared command changed.");
    await verifyApprovalCommand(profile, entry, request, saved.result);
    await persistCommandFiles(profile, saved.result);
    acquisitions.set(approval, acquired);
    return saved.result;
  }, { requireProfile: true });
}

/** Save result, history, signed parent binding and stable ACK intent before any ACK. */
export async function commitApprovalCommand(profile: string, approval: object,
  request: AuthRequestArtifact, result: AuthDelegationArtifact): Promise<void> {
  const acquired = acquisitions.get(approval);
  if (!acquired) throw invalid("Command approval is not tracked.");
  await ProfileManager.withLock(profile, async () => {
    const entry = await commandEntry(profile, request, acquired);
    const parent = await commandParent(profile, entry);
    await verifyApprovalCommand(profile, entry, request, result, parent);
    const prior = cliOf(entry).command;
    if (prior && canonicalJson(prior.result) !== canonicalJson(JSON.parse(JSON.stringify(result)))) {
      throw invalid("A different result is already saved for this command.");
    }
    const parentResult = savableParent(entry);
    await updateApprovals(profile, (entries) => entries.map((item) => item.requestId === entry.requestId
      ? withCli(item, { command: { request, result, parent: parentResult } }) : item));
    await persistCommandFiles(profile, result);
    acquisitions.set(approval, acquired);
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

/**
 * The session key a first sign-in or a rotation staged in a pending request (the key exists nowhere else) while no command and no
 * committed grant owns it: what `auth login` needs to resume.
 */
export async function pendingApprovalKey(profile: string): Promise<Ed25519PrivateJwk | undefined> {
  const { entries } = await loadApprovals(profile);
  return entries.find((entry) => cliOf(entry).commandIntent === undefined && entry.phase !== "committed" && entry.phase !== "acked")?.keys?.stagedSigningKey;
}

interface Abandoned { readonly entry: ApprovalEntry; readonly outcome: Outcome }

/** Remove the entries the machine's `abandon` event drops: each leaves the file with its keys, and its outcome says whether a grant may be live. */
async function abandonEntries(profile: string, matches: (entry: ApprovalEntry) => boolean, reason: "key-sweep" | "superseded"): Promise<Abandoned[]> {
  const dropped: Abandoned[] = [];
  const now = Date.now();
  await updateApprovals(profile, (entries) => entries.filter((entry) => {
    if (!matches(entry)) return true;
    const step = reduce(requesterState(entry), { type: "abandon", now, reason });
    if (step.state.entry !== undefined || step.state.settled === undefined) return true;
    dropped.push({ entry, outcome: step.state.settled });
    return false;
  }), { now });
  return dropped;
}

/** Drop the pending request a refused result came from, with the result key and reference it holds. No-op for a result not acquired here. */
export async function dropRefusedApproval(profile: string, delegation: object): Promise<void> {
  const acquired = acquisitions.get(delegation);
  if (acquired) await abandonEntries(profile, (entry) => entry.requestId === acquired.requestId, "superseded");
}

/**
 * Forget every pending request of this profile whose saved session key is `x` (an `auth rotate` that failed: its staged key
 * exists only there). `approved`: one of them already had an approval result (the owner approved, so a grant is live), and
 * `latestEnd` is the latest that grant can end: the request's own expiry (an approval cannot come later) plus the lifetime asked.
 */
export async function dropApprovalsHoldingKey(profile: string, x: unknown): Promise<{ dropped: boolean; approved: boolean; latestEnd?: string }> {
  if (typeof x !== "string") return { dropped: false, approved: false };
  const held = await abandonEntries(profile, (entry) => entry.keys?.stagedSigningKey?.x === x, "key-sweep");
  if (held.length === 0) return { dropped: false, approved: false };
  const approvedEntries = held.filter(({ outcome }) => outcome.kind === "abandoned" && outcome.grantMayBeLive === "yes");
  const ends = approvedEntries.map(({ entry }) => localExpiry(entry) + entry.request.grantLifetimeSeconds * 1000).filter(Number.isFinite);
  return { dropped: true, approved: approvedEntries.length > 0,
    ...(ends.length > 0 ? { latestEnd: new Date(Math.max(...ends)).toISOString() } : {}) };
}

/** Whether a pending request of this profile still holds the session key `x` (a first sign-in's key lives only there). */
export async function approvalHoldsKey(profile: string, x: unknown): Promise<boolean> {
  return (await loadApprovals(profile)).entries.some((entry) => entry.keys?.stagedSigningKey?.x === x);
}

/** The owner-signed result of an entry, opened: from its envelope and relay key, or from the parent a command entry kept. */
function openedResult(entry: ApprovalEntry): Record<string, unknown> {
  if (entry.resultEnvelope !== undefined && entry.keys !== undefined) {
    const relay = createECDH("prime256v1");
    relay.setPrivateKey(Buffer.from(entry.keys.relayPrivateKey, "base64url"));
    return decryptRelayResult(entry.resultEnvelope, entry.requestId, relay);
  }
  const parent = cliOf(entry).command?.parent;
  if (parent !== undefined) return parent;
  throw invalid("No encrypted approval result is available.");
}

/** Whether any object in `value` has a property named `d` (a private JWK scalar). */
function holdsPrivateScalar(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(holdsPrivateScalar);
  return Object.entries(value).some(([name, inner]) => name === "d" || holdsPrivateScalar(inner));
}

/**
 * The parent a command entry keeps beside its saved child (`ext.cli.command.parent`): the opened, owner-signed result. It is checked to
 * hold NO private or content key before it is saved: no `d`, no relay key, no staged signing key, nothing of the approval URL's fragment
 * (which carries the content key). Refuses (and the command stops) rather than save a key under `ext`.
 */
export function savableParent(entry: ApprovalEntry): Record<string, unknown> {
  const parent = openedResult(entry);
  const text = JSON.stringify(parent);
  const secrets = [entry.keys?.relayPrivateKey, entry.keys?.stagedSigningKey?.d, entry.approvalUrl?.split("#")[1]]
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
  if (holdsPrivateScalar(parent) || secrets.some((secret) => text.includes(secret))) throw invalid("The approved result holds key material; it was not saved with the command.");
  return parent;
}

function verifyPendingResult(entry: ApprovalEntry, key: Ed25519PrivateJwk): {
  delegation: Record<string, unknown>;
  session: ReturnType<typeof verifyScopedLogin>["session"];
} {
  // The result the owner approved, once opened: a refusal carries it so the caller can name the refused delegation.
  let seen: unknown;
  try {
    const signer = signerFromJwk(key);
    const opened = openedResult(entry);
    seen = opened.delegation;
    if (opened.resultVersion !== 1 || opened.requestId !== entry.requestId || opened.requestDigest !== entry.bodyCid ||
      opened.requesterDid !== entry.request.issuer || opened.targetDid !== entry.request.targetDid ||
      signer.did !== entry.request.issuer || typeof opened.ownerDid !== "string" ||
      typeof opened.delegationExpiresAt !== "string" || !Number.isFinite(Date.parse(opened.delegationExpiresAt)) ||
      new Date(opened.delegationExpiresAt).toISOString() !== opened.delegationExpiresAt ||
      !opened.delegation || typeof opened.delegation !== "object") throw invalid("Encrypted result binding does not match this request.");
    const delegation = opened.delegation as Record<string, unknown>;
    const verified = verifyScopedLogin(delegation, key, entry.request.targetDid,
      entry.request.permissions as PermissionEntry[], {
        expectedOwner: cliOf(entry).expectedOwner ?? opened.ownerDid,
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
/**
 * The machine's verdict on the CLI's own verification of an opened result. A permanent refusal drops the request; a clock-dependent
 * ceiling keeps it. AUTH_EXPIRED is `expiredMeans`: while the result is being acquired a clock running AHEAD looks the same, so it is kept
 * ("clock", as before); once the grant is saved the approval is over, so it is dropped ("ended", as before).
 */
function verdictOf(error: unknown, expiredMeans: "clock" | "ended"): ApprovalVerdict | undefined {
  if (!(error instanceof CLIError)) return undefined;
  const { code } = error;
  if (isPermanentRefusal(error)) return "refused";
  if (isClockDependent(error)) return "clock";
  return code === "AUTH_EXPIRED" ? expiredMeans : undefined;
}

const droppedWithError = new WeakMap<object, { approved: boolean; latestEnd?: string }>();
/** For a rotation's cleanup: what the request the machine removed with this error would have reported (`dropApprovalsHoldingKey`'s answer). */
export function droppedApprovalOf(error: unknown): { approved: boolean; latestEnd?: string } | undefined {
  return typeof error === "object" && error !== null ? droppedWithError.get(error) : undefined;
}

/** The two ends of one run that are not outcomes: the result is verified and the caller commits it. */
class HandBack extends Error {}

/** One transport call of the machine, signed with `signingKey`; the clock measures the skew against the reply's `Date`. */
function transportFor(signingKey: Ed25519PrivateJwk, clock: Clock): ApprovalTransport {
  const state = (entry: ApprovalEntry) => ({ requestId: entry.requestId, bodyCid: entry.bodyCid, record: entry.record, apiOrigin: entry.apiOrigin, signingKey });
  return {
    discover: (entry: ApprovalEntry, call: CallOptions): Promise<CallResult> => callApproval(state(entry), "discover", {}, { timeoutMs: call.timeoutMs, now: clock.now }),
    fetch: (entry: ApprovalEntry, call: CallOptions): Promise<CallResult> => callApproval(state(entry), "fetch",
      { resultRef: entry.resultRef!, resultExpiresAt: entry.resultExpiresAt! }, { timeoutMs: call.timeoutMs, now: clock.now }),
    ack: (entry: ApprovalEntry, call: CallOptions): Promise<CallResult> => callApproval(state(entry), "ack",
      { resultRef: entry.resultRef!, ackId: entry.ackId }, { timeoutMs: call.timeoutMs, now: clock.now }),
  };
}

function clockOf(options: Pick<AuthFlowOptions, "approvalWait" | "approvalClock">): Clock {
  const wait_ = options.approvalWait;
  return {
    now: wait_?.now ?? options.approvalClock?.now ?? Date.now,
    sleep: wait_?.sleep ?? options.approvalClock?.sleep ?? ((ms: number) => wait(ms)),
  };
}

/** Retryable reads never acknowledge or consume. The private result key is synced before the URL is exposed. */
export async function acquireApprovalRequest(_did: string, options: AuthFlowOptions): Promise<DelegationData> {
  const profile = options.profileName;
  if (!profile || !options.jwk || !options.host || !options.permissions?.length) {
    throw new CLIError("APPROVAL_REQUEST_CONTEXT_REQUIRED", "Approval requires a profile, session key, host and permissions.", ExitCode.USAGE_ERROR);
  }
  const signingKey = options.jwk as Ed25519PrivateJwk;
  const approvalWait: ApprovalWait | undefined = options.approvalWait;
  const clock = clockOf(options);
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
  if (options.commandIntent !== undefined && !/^auth-grant:[0-9a-f]{64}$/.test(options.commandIntent)) {
    throw invalid("Invalid approval command intent.");
  }
  const store = fileApprovalStore(profile, clock);
  const matching = (await loadApprovals(profile, { now: clock.now() })).entries.filter((item) => {
    const cli = cliOf(item);
    if (cli.commandIntent !== options.commandIntent) return false;
    // An acknowledged entry migrated from 1.6.x holds no key and no parent: its approval cannot be opened again, so the repeated command asks once more.
    if (item.phase === "acked" && cli.command?.parent === undefined) return false;
    const { resultEncryptionPublicJwk: _, permissions: priorPermissions, ...prior } = item.request;
    const { permissions: nextPermissions, ...next } = spec;
    if (canonicalJson(prior) !== canonicalJson(next) || item.apiOrigin !== apiOrigin ||
      item.linkApiOrigin !== linkApiOrigin || item.openkeyOrigin !== openkeyOrigin ||
      priorPermissions.length !== nextPermissions.length) return false;
    // Saving the first signed result resolves logical space names to its owner.
    // Compare that spelling only after re-verifying the original encrypted result.
    let owner: string | undefined;
    try { owner = item.resultEnvelope !== undefined || cli.command?.parent !== undefined ? verifyPendingResult(item, signingKey).session.ownerDid : cli.expectedOwner; }
    catch (error) {
      if (error instanceof CLIError && error.code === "AUTH_EXPIRED") return false;
      throw error;
    }
    if ((cli.expectedOwner !== undefined || options.expectedOwner !== undefined) &&
      (!owner || !options.expectedOwner || normalizePkhIdentifier(owner) !== normalizePkhIdentifier(options.expectedOwner))) return false;
    return priorPermissions.every(({ space, ...permission }, index) => {
      const { space: nextSpace, ...nextPermission } = nextPermissions[index]!;
      return canonicalJson(permission) === canonicalJson(nextPermission) &&
        (owner ? sameLoginSpace(space, nextSpace, owner) : space === nextSpace);
    });
  });
  if (matching.length > 1) throw invalid("Multiple approvals match this command; no result was selected.");
  let entry = matching[0];
  const createdThisRun = entry === undefined;
  if (!entry) {
    const relay = createECDH("prime256v1");
    relay.generateKeys();
    const relayKey = relay.getPrivateKey();
    const request = { ...spec, resultEncryptionPublicJwk: relayPublicJwkOf(relay) };
    const created = await createApprovalRequest({ request, issuerKey: signer, apiOrigin: linkApiOrigin, openkeyOrigin, now: clock.now() });
    const profileKey = await ProfileManager.getKey(profile) as Ed25519PrivateJwk | null;
    const cli: CliExt = { ...(options.expectedOwner === undefined ? {} : { expectedOwner: options.expectedOwner }),
      ...(options.commandIntent === undefined ? {} : { commandIntent: options.commandIntent }) };
    // A machine-written entry always passes the schema; parsing here makes that a fact, not a hope.
    entry = approvalEntrySchema.parse({
      requestId: created.id, bodyCid: created.bodyCid, approvalUrl: created.link, request, record: created.record,
      apiOrigin, linkApiOrigin, openkeyOrigin,
      keys: { relayPrivateKey: Buffer.concat([Buffer.alloc(32 - relayKey.length), relayKey]).toString("base64url"),
        ...(profileKey && signerFromJwk(profileKey).did === signer.did ? {} : { stagedSigningKey: signingKey }) },
      phase: "open", ackId: randomUUID(), createdAt: created.record.header.issuedAt,
      ext: Object.keys(cli).length === 0 ? {} : { cli },
    });
    // Write-before-act: the request and its keys are on disk before its link is shown to anyone.
    await store.write(entry);
  }
  const step = approvalWait?.step ?? 1;
  const of = approvalWait?.of ?? 1;
  if (entry.phase === "open") {
    const approvalUrl = entry.approvalUrl!;
    const expiresAt = entry.record.header.expiresAt;
    options.onApprovalRequest?.({ approvalUrl, requestId: entry.requestId, expiresAt });
    if (!options.onApprovalRequest) {
      console.error(`Approve this request in OpenKey (open the complete link):\n${approvalUrl}\n`);
      if (!options.noPopup && process.env.TC_AUTH_NO_POPUP !== "1" && process.env.TC_NO_POPUP !== "1") await tryOpenBrowser(approvalUrl);
      const next = approvalNextLine({ step, of, approvalUrl, expiresAt });
      if (next !== undefined) console.error(next);
    }
    // A new link cannot be approved yet. With a deadline, hand it to the caller at once so it can be sent.
    if (createdThisRun && approvalWait) {
      throw approvalOutcomeError({ kind: "pending", expiresAt: localExpiry(entry), confirmedLiveAt: clock.now() }, { entry, step, of })!;
    }
  }

  let verified: ReturnType<typeof verifyPendingResult> | undefined;
  let verification: unknown;
  const verify = async (current: ApprovalEntry): Promise<ApprovalVerdict> => {
    try { verified = verifyPendingResult(current, signingKey); return "ok"; } catch (error) {
      verification = error;
      const verdict = verdictOf(error, "clock");
      if (verdict === undefined) throw error;
      return verdict;
    }
  };
  if (entry.phase === "committed" || entry.phase === "acked") {
    // The grant is already saved: only its verified result is wanted back (for the command's own recovery); the ack is the completion's job.
    try { verified = verifyPendingResult(entry, signingKey); } catch (error) {
      if (isPermanentRefusal(error)) await store.remove(entry.requestId);
      throw error;
    }
  } else {
    try {
      const result = await driveApproval({
        store, transport: transportFor(signingKey, clock), verify, now: clock.now, sleep: clock.sleep,
        commit: async () => { throw new HandBack(); },
      }, entry.requestId, { ...(approvalWait === undefined ? {} : { deadline: approvalWait.deadlineMs }), ...(createdThisRun ? { createdThisRun: true } : {}) });
      const error = approvalOutcomeError(result.outcome, { entry: result.entry ?? entry, step, of, cause: verification }) ?? invalid("The approval ended without a result.");
      // The machine removed a request OpenKey refused (or may have approved): a rotation's sweep will not find it, so the error carries what the sweep would have said.
      if (result.outcome.kind === "refused" && result.outcome.reason !== "verification" && result.entry === undefined) {
        const approved = result.outcome.grantMayBeLive === "yes";
        droppedWithError.set(error, { approved, ...(approved ? { latestEnd: new Date(localExpiry(entry) + entry.request.grantLifetimeSeconds * 1000).toISOString() } : {}) });
      }
      throw error;
    } catch (error) {
      if (!(error instanceof HandBack)) throw error;
    }
  }
  acquisitions.set(verified!.delegation, { requestId: entry.requestId, clock });
  return verified!.delegation as DelegationData;
}

/** Call only after committing authority. Re-check stored evidence under the profile lock and sync it before ACK intent. */
export async function completeApprovalResult(profile: string, delegation?: object): Promise<void> {
  // A pasted short code's local copy is dropped only now: every caller reaches here after its durable commit.
  if (delegation) await dropCommittedDelegation(profile, delegation);
  const acquired = delegation ? acquisitions.get(delegation) : undefined;
  const clock = acquired?.clock ?? clockOf({});
  const { entries } = await loadApprovals(profile, { now: clock.now() });
  const candidates = acquired ? entries.filter((entry) => entry.requestId === acquired.requestId) : entries;
  for (const entry of candidates) {
    if (!acquired && cliOf(entry).commandIntent !== undefined) continue;
    if (entry.phase !== "fetched" && entry.phase !== "committed") continue;
    const key = await ProfileManager.getKey(profile) as Ed25519PrivateJwk | null;
    if (!key || signerFromJwk(key).did !== entry.request.targetDid) {
      if (acquired) throw invalid("Approval has not been durably saved; no ACK was sent.");
      continue;
    }
    let notSaved = false;
    let verification: unknown;
    const result = await driveApproval({
      store: fileApprovalStore(profile, clock), transport: transportFor(key, clock), now: clock.now, sleep: clock.sleep,
      verify: async (current) => {
        try { verifyPendingResult(current, key); return "ok"; } catch (error) {
          verification = error;
          const verdict = verdictOf(error, "ended");
          if (verdict === undefined) throw error;
          return verdict;
        }
      },
      commit: async (current) => {
        const retainUntil = await ProfileManager.withLock(profile, () => commitEvidence(profile, current, key), { requireProfile: true });
        if (retainUntil === "not-saved") { notSaved = true; throw new HandBack(); }
        return retainUntil === undefined ? undefined : { retainUntil };
      },
    }, entry.requestId).catch((error: unknown) => {
      if (error instanceof HandBack) return undefined;
      throw error;
    });
    if (notSaved) {
      if (acquired) throw invalid("Approval has not been durably saved; no ACK was sent.");
      continue;
    }
    if (result === undefined) continue;
    const warning = approvalOutcomeWarning(result.outcome);
    if (warning) process.stderr.write(`${warning}\n`);
    // A delegation that ended before the ack ran is dropped quietly: the grant was committed (and is as good as it ever was).
    if (result.outcome.kind === "gone" && result.outcome.reason === "ended") continue;
    const error = approvalOutcomeError(result.outcome, { entry: result.entry ?? entry, cause: verification });
    if (error) throw error;
  }
}

/**
 * Under the profile lock: is what the approval granted durably saved (the profile's session, or a stored grant, or the command's
 * result)? Returns when the key-free entry should be kept after the ack (a command entry, until its child expires), `undefined` when
 * it is not kept, or `"not-saved"`. Syncs every file it relied on before any ACK intent is sent.
 */
async function commitEvidence(profile: string, entry: ApprovalEntry, key: Ed25519PrivateJwk): Promise<number | undefined | "not-saved"> {
  const verified = verifyPendingResult(entry, key);
  const { delegation: verifiedDelegation, session: verifiedSession } = verified;
  const current = await ProfileManager.getProfile(profile);
  if (current.ownerDid?.toLowerCase() !== verifiedSession.ownerDid.toLowerCase()) return "not-saved";
  let saved = false;
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
  const cli = cliOf(entry);
  if (cli.commandIntent !== undefined) {
    if (!cli.command) throw invalid("The command result has not been durably saved; no ACK was sent.");
    await verifyApprovalCommand(profile, entry, cli.command.request, cli.command.result, verified);
    await syncCommandFiles(profile, cli.command.result);
    saved = true;
  }
  if (!saved) return "not-saved";
  return cli.command === undefined ? undefined : Date.parse(cli.command.result.expiry);
}
