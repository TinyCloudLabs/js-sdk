/**
 * The requester side of an OpenKey approval request: what a process that created a request (see
 * `createApprovalRequest`) does after the owner approves it in OpenKey.
 *
 *   1. poll the requester-signed result endpoint until a result reference appears (`discoverApprovalResult`),
 *   2. fetch the encrypted relay envelope (`fetchApprovalResult`),
 *   3. open it with the request's private relay key and check that it answers THIS request (`openRelayResult`,
 *      `checkApprovalResultBinding`),
 *   4. only after the caller has saved the result durably, acknowledge it (`ackApprovalResult`).
 *
 * Everything here is pure transport and cryptography: no storage, no printing, no process exit. State (which
 * reference was found, whether the result was saved) belongs to the caller, so a crash between any two steps
 * resumes from the caller's own record. Uses only `fetch`, WebCrypto and the package's primitives, so it runs
 * unchanged in browsers and in Node. `fetch` is injectable for tests.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/p256";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

import { fromBase64Url, toBase64Url, utf8Bytes } from "../bytes.js";
import type { LinkRecord } from "./header.js";
import type { Ed25519PrivateJwk } from "./signer.js";

/** The `client_id` OpenKey expects in the session proof of every approval-result call. */
export const APPROVAL_RESULT_CLIENT_ID = "openkey-approval-result-v1";
/** What the CLI and Courier wait between result polls. */
export const APPROVAL_POLL_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_REQUEST_TIMEOUT_MS = 1000;
const RESULT_REF_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const RELAY_INFO = "openkey-device-relay-v1";

export type ApprovalAction = "discover" | "fetch" | "ack";

export type ApprovalClientErrorCode =
  /** OpenKey says the request expired before anyone approved it. Make a new request. */
  | "request_expired"
  /** The approved result passed OpenKey's retention window before it was collected. Make a new request. */
  | "result_expired"
  /** OpenKey already holds an acknowledgement for this result. */
  | "acknowledged"
  /** OpenKey has no such request or result. */
  | "not_found"
  /** A different acknowledgement is already stored for this result. */
  | "ack_conflict"
  /** OpenKey rejected the request binding or the requester's proof. */
  | "request_binding"
  /** OpenKey answered with an error this client does not map (see `status`). Retrying the same call is safe. */
  | "unavailable"
  /** The request did not reach OpenKey (DNS, connection, timeout). Retrying the same call is safe. */
  | "network"
  /** OpenKey's reply, or the decrypted result, does not have the expected shape or binding. */
  | "result_invalid";

export class ApprovalClientError extends Error {
  readonly code: ApprovalClientErrorCode;
  /** HTTP status of the OpenKey reply, when there was one. */
  readonly status: number | undefined;

  constructor(code: ApprovalClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ApprovalClientError";
    this.code = code;
    this.status = status;
  }
}

export function isApprovalClientError(value: unknown): value is ApprovalClientError {
  return value instanceof ApprovalClientError;
}

/** What a requester must keep to talk to OpenKey about one request. */
export interface ApprovalRequesterState {
  readonly requestId: string;
  /** The request body CID the links API returned; binds every proof and result to this exact request. */
  readonly bodyCid: string;
  /** The signed record that created the request; only `discover` sends it. */
  readonly record: Pick<LinkRecord, "header" | "signature">;
  /** OpenKey API origin, e.g. `https://api.openkey.so`. */
  readonly apiOrigin: string;
  /** The Ed25519 key that issued the request. */
  readonly signingKey: Ed25519PrivateJwk;
}

export interface ApprovalTransportOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function pathFor(action: ApprovalAction, requestId: string, resultRef: string): string {
  return action === "discover" ? `/api/approval-requests/${requestId}/result` : `/api/approval-results/${resultRef}/${action}`;
}

/**
 * The `OpenKey-Session-Proof` header value: an EdDSA JWT signed by the requester key, bound to the action, the
 * request, its body CID, the result reference and the ACK id, and to the exact URL it is sent to.
 */
export function approvalSessionProof(
  state: Pick<ApprovalRequesterState, "requestId" | "bodyCid" | "apiOrigin" | "signingKey">,
  action: ApprovalAction,
  resultRef = "",
  ackId = "",
): string {
  const jwk = state.signingKey;
  const thumbprint = toBase64Url(sha256(utf8Bytes(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: jwk.x }))));
  const header = toBase64Url(utf8Bytes(JSON.stringify({ alg: "EdDSA", kid: thumbprint, typ: "openkey-session-proof+jwt" })));
  const payload = toBase64Url(utf8Bytes(JSON.stringify({
    client_id: APPROVAL_RESULT_CLIENT_ID,
    cred_hash: toBase64Url(sha256(utf8Bytes(JSON.stringify([action, state.requestId, state.bodyCid, resultRef, ackId])))),
    htm: "POST",
    htu: state.apiOrigin + pathFor(action, state.requestId, resultRef),
    iat: Math.floor(Date.now() / 1000),
    jti: toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(24))),
  })));
  const input = `${header}.${payload}`;
  return `${input}.${toBase64Url(ed25519.sign(utf8Bytes(input), fromBase64Url(jwk.d)))}`;
}

async function post(
  state: ApprovalRequesterState,
  action: ApprovalAction,
  resultRef: string,
  ackId: string,
  options: ApprovalTransportOptions,
): Promise<Response> {
  const body = action === "discover"
    ? { bodyCid: state.bodyCid, header: state.record.header, signature: state.record.signature }
    : { requestId: state.requestId, bodyCid: state.bodyCid, ...(action === "ack" ? { ackId } : {}) };
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    return await (options.fetch ?? globalThis.fetch)(state.apiOrigin + pathFor(action, state.requestId, resultRef), {
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
      headers: {
        "content-type": "application/json",
        "OpenKey-Session-Proof": approvalSessionProof(state, action, resultRef, ackId),
      },
      body: JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApprovalClientError("network", `OpenKey could not be reached to ${action} the approval result.`);
  }
}

/** Map an OpenKey error reply to a typed error. Never returns. */
async function refuse(response: Response, action: ApprovalAction): Promise<never> {
  const body = await response.json().catch(() => null) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const status = response.status;
  // OpenKey answers HTTP 400 `invalid_request` ("Signed approval request header is invalid or expired") for a request past its expiry. Only `discover` reads it that way: on fetch or ack it is an unexpected reply (retryable), never a reason to drop a held approval.
  if (code === "expired_request" || (code === "invalid_request" && action === "discover")) throw new ApprovalClientError("request_expired", "This approval request expired before it was approved.", status);
  if (code === "expired_result") throw new ApprovalClientError("result_expired", "The approved result expired before it was collected.", status);
  if (code === "acknowledged") throw new ApprovalClientError("acknowledged", "OpenKey has already acknowledged this result.", status);
  if (code === "not_found") throw new ApprovalClientError("not_found", "OpenKey cannot find this approval request or result.", status);
  if (code === "ack_conflict") throw new ApprovalClientError("ack_conflict", "OpenKey rejected a conflicting acknowledgement for this result.", status);
  if (code === "request_binding" || code === "invalid_proof") {
    throw new ApprovalClientError("request_binding", "OpenKey rejected the request or requester binding.", status);
  }
  throw new ApprovalClientError("unavailable", `OpenKey could not ${action} this approval result (HTTP ${status}).`, status);
}

export type DiscoverResult =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly resultRef: string; readonly expiresAt: string };

/** One poll: has the owner approved yet? HTTP 202 is `pending`; a 200 carries the result reference. */
export async function discoverApprovalResult(state: ApprovalRequesterState, options: ApprovalTransportOptions = {}): Promise<DiscoverResult> {
  const response = await post(state, "discover", "", "", options);
  if (response.status === 202) return { status: "pending" };
  if (!response.ok) return refuse(response, "discover");
  const found = await response.json().catch(() => null) as { resultRef?: unknown; expiresAt?: unknown } | null;
  if (typeof found?.resultRef !== "string" || !RESULT_REF_PATTERN.test(found.resultRef) ||
      typeof found.expiresAt !== "string" || !Number.isFinite(Date.parse(found.expiresAt))) {
    throw new ApprovalClientError("result_invalid", "OpenKey returned an invalid approval result reference.");
  }
  return { status: "ready", resultRef: found.resultRef, expiresAt: found.expiresAt };
}

/**
 * Fetch the encrypted relay envelope. It checks that the reply names this request, body CID, reference and
 * retention expiry, so a reply for another request is refused. Reading never consumes or acknowledges.
 */
export async function fetchApprovalResult(
  state: ApprovalRequesterState,
  found: { readonly resultRef: string; readonly expiresAt: string },
  options: ApprovalTransportOptions = {},
): Promise<unknown> {
  const response = await post(state, "fetch", found.resultRef, "", options);
  if (!response.ok) return refuse(response, "fetch");
  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!result || result.requestId !== state.requestId || result.bodyCid !== state.bodyCid ||
      result.resultRef !== found.resultRef || result.expiresAt !== found.expiresAt ||
      !result.relay || typeof result.relay !== "object") {
    throw new ApprovalClientError("result_invalid", "The approval result does not match this request.");
  }
  return result.relay;
}

/**
 * Acknowledge a result. Call it ONLY after the caller has durably saved what the result granted: OpenKey may
 * discard the result after the acknowledgement. Resolves `acknowledged` when OpenKey stored this `ackId`, and
 * `settled` when OpenKey says the result is already acknowledged, expired or gone (nothing more to do).
 * Anything else throws; the same `ackId` can be retried.
 */
export async function ackApprovalResult(
  state: ApprovalRequesterState,
  resultRef: string,
  ackId: string,
  options: ApprovalTransportOptions = {},
): Promise<"acknowledged" | "settled"> {
  const response = await post(state, "ack", resultRef, ackId, options);
  const body = await response.clone().json().catch(() => null) as { ackId?: unknown; status?: unknown; code?: unknown } | null;
  if (!response.ok && (body?.code === "expired_result" || body?.code === "not_found" || body?.code === "acknowledged")) return "settled";
  if (!response.ok) return refuse(response, "ack");
  if (body?.ackId !== ackId || body.status !== "acknowledged") {
    throw new ApprovalClientError("unavailable", `OpenKey did not confirm the acknowledgement (HTTP ${response.status}).`, response.status);
  }
  return "acknowledged";
}

export interface CollectedApprovalResult {
  readonly status: "result";
  readonly resultRef: string;
  /** OpenKey's retention deadline for the result. */
  readonly expiresAt: string;
  readonly relay: unknown;
}

export interface CollectApprovalOptions extends ApprovalTransportOptions {
  readonly intervalMs?: number;
  /** Epoch milliseconds. At or after it, a poll that finds nothing returns `deadline` instead of waiting again. */
  readonly deadline?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** A result reference found on an earlier run; skips polling and fetches it. */
  readonly known?: { readonly resultRef: string; readonly expiresAt: string };
  /** Awaited after a reference is found and before the result is fetched, so the caller can save it. */
  readonly onDiscovered?: (found: { readonly resultRef: string; readonly expiresAt: string }) => Promise<void> | void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The transport options for the next request: its timeout never reaches far past the wait's deadline. */
function bounded(options: CollectApprovalOptions, now: () => number): ApprovalTransportOptions {
  if (options.deadline === undefined) return options;
  return { ...options, timeoutMs: Math.min(options.timeoutMs ?? REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, options.deadline - now() + 1000)) };
}

/**
 * Poll until the owner approves, then fetch the encrypted result. Network failures are retried at the poll
 * interval; every other failure throws an `ApprovalClientError`. With a `deadline`, returns `{ status: "deadline" }`
 * once it passes without a result. The deadline is checked between polls, and a request that starts near it is given
 * only the time left plus one second (never more than `timeoutMs`), so a wait ends about a second after its deadline
 * instead of a full request timeout after it.
 */
export async function collectApprovalResult(
  state: ApprovalRequesterState,
  options: CollectApprovalOptions = {},
): Promise<CollectedApprovalResult | { readonly status: "deadline" }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const interval = options.intervalMs ?? APPROVAL_POLL_INTERVAL_MS;
  let found = options.known;
  for (;;) {
    if (!found) {
      let discovered: DiscoverResult | undefined;
      try { discovered = await discoverApprovalResult(state, bounded(options, now)); }
      catch (error) { if (!isApprovalClientError(error) || error.code !== "network") throw error; }
      if (discovered?.status === "ready") {
        found = { resultRef: discovered.resultRef, expiresAt: discovered.expiresAt };
        await options.onDiscovered?.(found);
      }
    }
    if (found) {
      try {
        return { status: "result", ...found, relay: await fetchApprovalResult(state, found, bounded(options, now)) };
      } catch (error) { if (!isApprovalClientError(error) || error.code !== "network") throw error; }
    }
    if (options.deadline !== undefined && now() >= options.deadline) return { status: "deadline" };
    const wait = options.deadline === undefined ? interval : Math.min(interval, Math.max(0, options.deadline - now()));
    await sleep(wait);
    if (options.signal?.aborted) throw options.signal.reason;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Relay key and encrypted result

export interface RelayKeyPair {
  /** The 32-byte P-256 private scalar, unpadded base64url. The requester keeps it; it is never sent. */
  readonly privateKey: string;
  /** The public key for `resultEncryptionPublicJwk` of the request. */
  readonly publicJwk: { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string };
}

/** A fresh relay key for one request. OpenKey encrypts the approval result to its public half. */
export function generateRelayKey(): RelayKeyPair {
  const privateKey = p256.utils.randomPrivateKey();
  const point = p256.getPublicKey(privateKey, false);
  return {
    privateKey: toBase64Url(privateKey),
    publicJwk: { kty: "EC", crv: "P-256", x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33)) },
  };
}

function invalidResult(message: string): ApprovalClientError {
  return new ApprovalClientError("result_invalid", message);
}

function strictBytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidResult(`OpenKey returned an invalid ${label}.`);
  try { return fromBase64Url(value); } catch { throw invalidResult(`OpenKey returned an invalid ${label}.`); }
}

/**
 * Open a relay envelope (`ECDH-P256-A256GCM`: ECDH on P-256, HMAC-based key derivation salted with the request
 * id, AES-256-GCM with the request id as associated data) with the request's relay private key. Returns the
 * decrypted JSON object. It proves only that the sender knew the relay public key and the request id: pass the
 * result to `checkApprovalResultBinding` before trusting any field.
 */
export async function openRelayResult(envelope: unknown, requestId: string, relayPrivateKey: string): Promise<Record<string, unknown>> {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw invalidResult("OpenKey returned an invalid encrypted relay result.");
  const relay = envelope as Record<string, unknown>;
  if (relay.version !== 1 || relay.algorithm !== "ECDH-P256-A256GCM") throw invalidResult("OpenKey returned an unsupported encrypted relay result.");
  const peer = relay.ephemeralPublicJwk as Record<string, unknown> | null | undefined;
  if (!peer || typeof peer !== "object" || peer.kty !== "EC" || peer.crv !== "P-256" || "d" in peer) throw invalidResult("OpenKey returned an invalid relay key.");
  const x = strictBytes(peer.x, "relay key");
  const y = strictBytes(peer.y, "relay key");
  const nonce = strictBytes(relay.nonce, "relay nonce");
  const ciphertext = strictBytes(relay.ciphertext, "relay ciphertext");
  if (x.length !== 32 || y.length !== 32) throw invalidResult("OpenKey returned an invalid relay key.");
  if (nonce.length !== 12 || ciphertext.length <= 16) throw invalidResult("OpenKey returned an invalid encrypted relay result.");
  let secret: Uint8Array;
  try {
    const point = new Uint8Array(65);
    point[0] = 4;
    point.set(x, 1);
    point.set(y, 33);
    p256.ProjectivePoint.fromHex(point).assertValidity();
    secret = p256.getSharedSecret(fromBase64Url(relayPrivateKey), point, true).subarray(1);
  } catch {
    throw invalidResult("OpenKey returned an invalid relay key.");
  }
  const salt = utf8Bytes(requestId);
  const key = hmac(sha256, hmac(sha256, salt, secret), Uint8Array.from([...utf8Bytes(RELAY_INFO), 1]));
  let value: unknown;
  try {
    const aes = await globalThis.crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["decrypt"]);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: salt as BufferSource, tagLength: 128 }, aes, ciphertext as BufferSource,
    );
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  } catch {
    throw invalidResult("OpenKey returned an unreadable encrypted relay result.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResult("OpenKey returned an invalid encrypted relay result.");
  return value as Record<string, unknown>;
}

export interface ApprovalResultExpectation {
  readonly requestId: string;
  readonly bodyCid: string;
  /** The request the result must answer: its issuer is the requester and its target the key being delegated to. */
  readonly request: { readonly issuer: string; readonly targetDid: string };
  /** Epoch milliseconds; default now. A result whose delegation has already expired is refused. */
  readonly now?: number;
}

export interface CheckedApprovalResult {
  readonly ownerDid: string;
  /** The delegation's expiry, canonical ISO-8601. */
  readonly delegationExpiresAt: string;
  /** OpenKey's delegation payload. Its own signature and permissions are the caller's to verify. */
  readonly delegation: Record<string, unknown>;
}

/**
 * Check that a decrypted result answers exactly this request: result version, request id, request digest,
 * requester, target, an owner, a canonical not-yet-passed expiry and a delegation object. The error names the fields
 * that differ and never their values. The delegation's content (signature, permissions, owner agreement) is NOT
 * checked here; it depends on what the caller asked for.
 */
export function checkApprovalResultBinding(opened: Record<string, unknown>, expected: ApprovalResultExpectation): CheckedApprovalResult {
  const { ownerDid, delegationExpiresAt, delegation } = opened;
  const expiryValid = typeof delegationExpiresAt === "string" && Number.isFinite(Date.parse(delegationExpiresAt)) &&
    new Date(delegationExpiresAt).toISOString() === delegationExpiresAt;
  const differing = [
    ["resultVersion", opened.resultVersion === 1],
    ["requestId", opened.requestId === expected.requestId],
    ["requestDigest", opened.requestDigest === expected.bodyCid],
    ["requesterDid", opened.requesterDid === expected.request.issuer],
    ["targetDid", opened.targetDid === expected.request.targetDid],
    ["ownerDid", typeof ownerDid === "string" && ownerDid.length > 0],
    ["delegationExpiresAt", expiryValid],
    ["delegation", !!delegation && typeof delegation === "object" && !Array.isArray(delegation)],
  ].filter(([, matches]) => !matches).map(([field]) => field);
  if (differing.length > 0) throw invalidResult(`The encrypted result does not match this request (${differing.join(", ")}).`);
  if (Date.parse(delegationExpiresAt as string) <= (expected.now ?? Date.now())) throw invalidResult("The approved delegation has already expired.");
  return { ownerDid: ownerDid as string, delegationExpiresAt: delegationExpiresAt as string, delegation: delegation as Record<string, unknown> };
}
