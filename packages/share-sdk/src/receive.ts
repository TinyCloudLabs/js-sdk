import {
  checkBearerDelegation,
  canonicalize,
  computeCid,
  fromBase64Url,
  open,
  parseCompactOrInlineShareUrl,
  shareEnvelopeSchema,
  shareEnvelopeV2Schema,
  shareEnvelopeV3Schema,
  verifyEnvelopeV2,
  verifyEnvelopeV3,
  verifyEnvelope,
  toBase64Url,
  type ShareEnvelope,
  type ShareEnvelopeV2,
  type ShareEnvelopeV3,
} from "@tinycloud/share-envelope";
import type { ShareAuthorizedContent, ShareAuthorizationAdapter, ShareAuthorizationMethod } from "./authorization.js";

export type ShareErrorCode = "invalid-link" | "fetch-failed" | "max-bytes-exceeded" | "cid-mismatch" | "decrypt-failed" | "envelope-invalid" | "origin-mismatch" | "signature-invalid" | "capability-invalid" | "expired" | "unsupported-target" | "authorization-denied" | "content-integrity-failed";

export const SHARE_RESULT_VERSION = 1 as const;

/** Maximum stored-block size accepted by the headless verifier by default. */
export const DEFAULT_MAX_SEALED_BLOB_BYTES = 100 * 1024 * 1024 + 29;

/** Content metadata permits at most 100 MiB of plaintext plus sealed overhead. */
export const DEFAULT_MAX_CONTENT_BLOB_BYTES = DEFAULT_MAX_SEALED_BLOB_BYTES;

const CONTENT_SEALED_OVERHEAD = 1 + 12 + 16;

export class ShareReceiveError extends Error {
  readonly code: ShareErrorCode;
  readonly details: { readonly expiresAt?: string; readonly stage?: "envelope" | "content"; readonly reason?: "policy-target" | "recipient-did-target" | "prefix-resource" } | undefined;
  constructor(code: ShareErrorCode, message: string, details?: { readonly expiresAt?: string; readonly stage?: "envelope" | "content"; readonly reason?: "policy-target" | "recipient-did-target" | "prefix-resource" }) {
    super(message); this.name = "ShareReceiveError"; this.code = code; this.details = details;
  }
  /** Machine output is deliberately code-only; diagnostics belong on stderr. */
  toJSON(): ShareErrorInfo { return { protocol: "tinycloud-share", version: SHARE_RESULT_VERSION, error: { code: this.code } }; }
}

export interface ShareErrorInfo {
  readonly protocol: "tinycloud-share";
  readonly version: typeof SHARE_RESULT_VERSION;
  readonly error: { readonly code: ShareErrorCode };
}

/** Convert unknown failures to the redacted public error schema. */
export function toShareErrorInfo(error: unknown): ShareErrorInfo {
  if (error instanceof ShareReceiveError) return error.toJSON();
  return { protocol: "tinycloud-share", version: SHARE_RESULT_VERSION, error: { code: "fetch-failed" } };
}

export interface ShareFetchOptions {
  readonly registryBaseUrl?: string;
  readonly fetchBlob?: (input: { readonly origin: string; readonly cid: string }) => Promise<Uint8Array>;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly expectedOrigin?: string;
  /** Out-of-band signer trust root for addressed envelopes. */
  readonly trustedSignerDid?: string;
  /**
   * Out-of-band policy authority.  The policy bytes carried by an envelope
   * are only a CID-addressed integrity witness; they are never a trust root.
   */
  readonly trustedPolicyAuthority?: SharePolicyAuthority;
  readonly now?: () => number;
  readonly maxSealedBlobBytes?: number;
  readonly maxContentBlobBytes?: number;
  /** Observability-only hook; the SDK zeroes this authority-bearing buffer. */
  readonly onKeyParsed?: (key32: Uint8Array) => void;
  /** Optional node/OpenKey/email adapter for addressed v2 shares. */
  readonly authorization?: ShareAuthorizationAdapter<ShareAuthorizedContent>;
  readonly authorizationResumeToken?: string;
  readonly authorizationProof?: unknown;
  /** Addressed-only presentation hook. Bearer envelopes and their keys never cross this boundary. */
  readonly onResolvedAddressedEnvelope?: (envelope: ShareEnvelope | ShareEnvelopeV2 | ShareEnvelopeV3, cid: string) => void;
}

export interface SharePolicyEvidence {
  readonly policyCid: string;
  readonly signerDid: string;
  readonly registrationCid: string;
  readonly shareId: string;
  readonly recipientMatcher: unknown;
  readonly target: { readonly origin: string; readonly nodeAudience: string; readonly spaceId: string };
  readonly resource: { readonly kind: "exact" | "prefix"; readonly path: string };
  readonly actions: readonly string[];
  readonly contentSource: unknown;
  readonly contentSourceDigest: string;
  readonly delegationCid: string;
  readonly authorityMaterialHandle: string;
  readonly authorityMaterialDigest: string;
  readonly expiresAt: string;
}

export interface SharePolicyAuthority {
  resolve(input: { readonly policyCid: string; readonly envelope: ShareEnvelopeV2 }): Promise<SharePolicyEvidence | undefined>;
}

export interface VerifyBearerEnvelopeOptions {
  readonly expectedOrigin?: string;
  readonly now?: () => number;
}


/** Redacted metadata; link keys, delegations, policy bytes, and claims never appear here. */
export interface ShareMetadata {
  readonly protocol: "tinycloud-share";
  readonly version: 1;
  readonly shareId: string;
  readonly origin: string;
  readonly target: { readonly kind: "bearer" | "recipientDid" | "email" | "emailDomain"; readonly origin: string; readonly nodeAudience: string; readonly spaceId: string };
  readonly resource: { readonly kind: "exact" | "prefix"; readonly path: string };
  readonly actions: readonly string[];
  readonly expiresAt: string;
  readonly display: { readonly senderName?: string; readonly filename?: string; readonly mode?: string };
  readonly content?: { readonly cid: string };
}

export interface ShareInspection { readonly metadata: ShareMetadata; readonly link: { readonly origin: string; readonly cid: string; readonly kind: "compact" | "inline" } }
export interface ShareReceiveAuthorizationRequired {
  readonly state: "authorization-required";
  readonly method: ShareAuthorizationMethod;
  readonly continueUrl?: string;
  readonly resumeToken?: string;
}
export interface ShareReceiveResult extends ShareInspection { readonly bytes: Uint8Array; readonly text?: string }
export type ShareReceiveOutcome = ShareReceiveResult | ShareReceiveAuthorizationRequired;

interface ResolvedShareEnvelope {
  readonly envelope: ShareEnvelope | ShareEnvelopeV2 | ShareEnvelopeV3;
  readonly origin: string;
  readonly cid: string;
  readonly kind: "compact" | "inline";
}

function boundedBytes(value: Uint8Array, limit: number, code: ShareErrorCode): Uint8Array {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new ShareReceiveError("fetch-failed", "share byte limit is invalid");
  if (!(value instanceof Uint8Array)) throw new ShareReceiveError("fetch-failed", "registry returned invalid bytes");
  if (value.byteLength > limit) throw new ShareReceiveError(code, "share blob exceeds the configured byte limit");
  return value;
}

async function readResponseBytes(response: Response, limit: number, tooLargeCode: ShareErrorCode): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number.isSafeInteger(Number(contentLength)) && Number(contentLength) > limit) {
    throw new ShareReceiveError(tooLargeCode, "share blob exceeds the configured byte limit");
  }
  if (response.body === null) {
    return boundedBytes(new Uint8Array(await response.arrayBuffer()), limit, tooLargeCode);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ShareReceiveError(tooLargeCode, "share blob exceeds the configured byte limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function registryFetcher(options: ShareFetchOptions, limit: number, tooLargeCode: ShareErrorCode = "max-bytes-exceeded", stage: "envelope" | "content" = "envelope"): (input: { readonly origin: string; readonly cid: string }) => Promise<Uint8Array> {
  if (options.fetchBlob !== undefined) return async (input) => {
    try {
      return boundedBytes(await options.fetchBlob!(input), limit, tooLargeCode);
    } catch (error) {
      if (error instanceof ShareReceiveError) throw error;
      throw new ShareReceiveError("fetch-failed", "registry unavailable", { stage });
    }
  };
  if (options.registryBaseUrl === undefined) throw new ShareReceiveError("fetch-failed", "a registry fetch adapter is required");
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const base = options.registryBaseUrl.replace(/\/+$/, "");
  return async ({ cid }) => {
    try {
      const response = await fetchFn(`${base}/ipfs/${cid}?format=raw`, { headers: { accept: "application/vnd.ipld.raw" }, redirect: "error" });
      if (!response.ok) throw new ShareReceiveError("fetch-failed", `registry returned ${response.status}`, { stage });
      return await readResponseBytes(response, limit, tooLargeCode);
    } catch (error) {
      if (error instanceof ShareReceiveError) throw error;
      throw new ShareReceiveError("fetch-failed", "registry unavailable", { stage });
    }
  };
}

function metadataFor(envelope: ShareEnvelope | ShareEnvelopeV2 | ShareEnvelopeV3, origin: string): ShareMetadata {
  if (envelope.version === 2 || envelope.version === 3) {
    const targetKind = envelope.recipientMatcher.kind === "recipientDid" ? "recipientDid" : envelope.recipientMatcher.kind === "exactEmail" ? "email" : envelope.recipientMatcher.kind === "emailDomain" ? "emailDomain" : "bearer";
    return {
      protocol: "tinycloud-share", version: 1, shareId: envelope.shareId, origin,
      target: { ...envelope.target, kind: targetKind }, resource: envelope.resource, actions: envelope.actions, expiresAt: envelope.expiry,
      display: {
        ...(envelope.display.senderName === undefined ? {} : { senderName: envelope.display.senderName }),
        ...(envelope.display.filename === undefined ? {} : { filename: envelope.display.filename }),
        ...(envelope.display.mode === undefined ? {} : { mode: envelope.display.mode }),
      },
      ...(envelope.version === 2 && envelope.content !== undefined ? { content: { cid: envelope.content.cid } } : {}),
    };
  }
  return {
    protocol: "tinycloud-share", version: 1, shareId: envelope.shareId, origin,
    target: { ...envelope.target, kind: "bearer" }, resource: envelope.target.resource, actions: ["read"], expiresAt: envelope.expiry,
    display: {
      ...(envelope.display.senderName === undefined ? {} : { senderName: envelope.display.senderName }),
      ...(envelope.display.filename === undefined ? {} : { filename: envelope.display.filename }),
      ...(envelope.display.mode === undefined ? {} : { mode: envelope.display.mode }),
    },
    ...(envelope.content === undefined ? {} : { content: { cid: envelope.content.cid } }),
  };
}

function parseEnvelope(bytes: Uint8Array): ShareEnvelope | ShareEnvelopeV2 | ShareEnvelopeV3 {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    if (canonicalize(value) !== text) throw new Error("share envelope is not canonical JSON");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const version = (value as { readonly version?: unknown }).version;
      if (version === 3) return shareEnvelopeV3Schema.parse(value);
      if (version === 2) return shareEnvelopeV2Schema.parse(value);
    }
    return shareEnvelopeSchema.parse(value);
  }
  catch { throw new ShareReceiveError("envelope-invalid", "share envelope is invalid"); }
}

/**
 * Resolve a compact or inline link through the canonical ordered pipeline:
 * origin/path parsing, bounded transport, CID verification, AEAD opening,
 * canonical JSON, and strict envelope schema validation. Cryptographic target
 * verification is intentionally separate so policy and recipient-DID callers
 * can apply their own trusted-authority checks before network effects.
 */
async function resolveShareEnvelope(link: string, options: ShareFetchOptions = {}): Promise<ResolvedShareEnvelope> {
  let parsed: ReturnType<typeof parseCompactOrInlineShareUrl>;
  try { parsed = parseCompactOrInlineShareUrl(link, { ...(options.expectedOrigin === undefined ? {} : { expectedOrigin: options.expectedOrigin }) }); }
  catch { throw new ShareReceiveError("invalid-link", "share link format is invalid"); }
  try {
    if (parsed.key32 !== undefined) options.onKeyParsed?.(parsed.key32);
    const url = new URL(link);
    const sealed = parsed.kind === "inline"
      ? boundedBytes(parsed.ciphertext, options.maxSealedBlobBytes ?? DEFAULT_MAX_SEALED_BLOB_BYTES, "max-bytes-exceeded")
      : await registryFetcher(options, options.maxSealedBlobBytes ?? DEFAULT_MAX_SEALED_BLOB_BYTES)({ origin: url.origin, cid: parsed.ciphertextCid });
    if (await computeCid(sealed) !== parsed.ciphertextCid) throw new ShareReceiveError("cid-mismatch", "registry bytes do not match the link CID");
    let plaintext: Uint8Array;
    try { plaintext = parsed.key32 === undefined ? sealed : await open(sealed, parsed.key32); }
    catch { throw new ShareReceiveError("decrypt-failed", "share envelope could not be opened"); }
    return { envelope: parseEnvelope(plaintext), origin: url.origin, cid: parsed.ciphertextCid, kind: parsed.kind };
  } finally {
    // Fragment material is authority-bearing and must be cleared on every
    // path, including registry errors and CID mismatches before AEAD.
    parsed.key32?.fill(0);
  }
}

function actionName(value: string): string {
  return value === "read" ? "tinycloud.kv/get" : value === "list" ? "tinycloud.kv/list" : value === "edit" ? "tinycloud.kv/put" : value;
}

function resourceContains(outer: SharePolicyEvidence["resource"], inner: SharePolicyEvidence["resource"]): boolean {
  if (outer.kind === "exact") return inner.kind === "exact" && outer.path === inner.path;
  const prefix = outer.path.endsWith("/") ? outer.path : `${outer.path}/`;
  return inner.path === outer.path || inner.path.startsWith(prefix);
}

function policyEvidenceMatches(envelope: ShareEnvelopeV2, evidence: SharePolicyEvidence): boolean {
  const registeredActions = new Set(evidence.actions.map(actionName));
  return evidence.policyCid === (envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "")
    && evidence.signerDid === envelope.signature.signerDid
    && evidence.registrationCid.length > 0
    && evidence.shareId === envelope.shareId
    && canonicalize(evidence.recipientMatcher) === canonicalize(envelope.recipientMatcher)
    && canonicalize(evidence.target) === canonicalize(envelope.target)
    && resourceContains(evidence.resource, envelope.resource)
    && envelope.actions.every((action) => registeredActions.has(actionName(action)))
    && canonicalize(evidence.contentSource) === canonicalize(envelope.contentSource)
    && evidence.contentSourceDigest === envelope.contentSourceDigest
    && evidence.delegationCid === envelope.delegationCid
    && evidence.authorityMaterialHandle === envelope.authorityMaterialHandle
    && evidence.authorityMaterialDigest === envelope.authorityMaterialDigest
    && evidence.expiresAt === envelope.expiry
    && Number.isFinite(Date.parse(evidence.expiresAt))
    && Date.parse(evidence.expiresAt) === Date.parse(envelope.expiry);
}

async function verifyV2Envelope(envelope: ShareEnvelopeV2, linkOrigin: string, options: ShareFetchOptions): Promise<void> {
  // v2's signed target origin is the enforcing Node, not the Share viewer.
  // The link parser binds the separately trusted viewer origin; the external
  // policy authority below binds the Node origin/audience/enforcer tuple.
  if (options.expectedOrigin !== undefined && linkOrigin !== options.expectedOrigin) {
    throw new ShareReceiveError("origin-mismatch", "share link origin does not match the trusted origin");
  }
  // Verify the signed envelope before consulting any policy or registration
  // authority. This first check establishes integrity only: the signer named
  // by an untrusted envelope is not a trust root. The external authority below
  // must still bind that signer to an enrolled registration, and an explicit
  // trustedSignerDid remains an additional trust constraint when supplied.
  try {
    if (!await verifyEnvelopeV2(envelope, { expectedSignerDid: envelope.signature.signerDid })) throw new Error("signature");
  } catch {
    throw new ShareReceiveError("signature-invalid", "share signature is invalid");
  }
  const expiry = Date.parse(envelope.expiry);
  if (!Number.isFinite(expiry)) throw new ShareReceiveError("envelope-invalid", "share expiry is invalid");
  if (expiry <= (options.now?.() ?? Date.now())) throw new ShareReceiveError("expired", "share has expired", { expiresAt: envelope.expiry });

  if (envelope.authorizationTarget.kind === "policy") {
    if (options.trustedPolicyAuthority === undefined) throw new ShareReceiveError("envelope-invalid", "an external policy authority is required");
    let evidence: SharePolicyEvidence | undefined;
    try { evidence = await options.trustedPolicyAuthority.resolve({ policyCid: envelope.authorizationTarget.policyCid, envelope }); } catch { evidence = undefined; }
    if (evidence === undefined || !policyEvidenceMatches(envelope, evidence)) throw new ShareReceiveError("capability-invalid", "share policy authority evidence is not bound to the envelope");
    // The signer is a trust root only when the separately configured policy
    // authority has vouched for it. Never promote the signer or policy bytes
    // supplied by the untrusted envelope into authority.
    if (options.trustedSignerDid !== undefined && (evidence.signerDid !== options.trustedSignerDid || envelope.signature.signerDid !== options.trustedSignerDid)) {
      throw new ShareReceiveError("signature-invalid", "share signer is not trusted");
    }
  } else if (envelope.authorizationTarget.kind === "recipientDid" && envelope.recipientMatcher.kind === "recipientDid" && envelope.authorizationTarget.did !== envelope.recipientMatcher.value) {
    throw new ShareReceiveError("capability-invalid", "recipient authorization does not match the signed recipient");
  } else {
    if (options.trustedSignerDid === undefined || envelope.signature.signerDid !== options.trustedSignerDid) throw new ShareReceiveError("signature-invalid", "an addressed signer trust root is required");
  }
}

async function verifyV3Envelope(envelope: ShareEnvelopeV3, linkOrigin: string, options: ShareFetchOptions): Promise<void> {
  if (options.expectedOrigin !== undefined && linkOrigin !== options.expectedOrigin) {
    throw new ShareReceiveError("origin-mismatch", "share link origin does not match the trusted origin");
  }
  try {
    if (!await verifyEnvelopeV3(envelope, { expectedSignerDid: envelope.policy.ownerDid })) throw new Error("signature");
  } catch {
    throw new ShareReceiveError("signature-invalid", "share signature is invalid");
  }
  const expiry = Date.parse(envelope.expiry);
  if (!Number.isFinite(expiry)) throw new ShareReceiveError("envelope-invalid", "share expiry is invalid");
  if (expiry <= (options.now?.() ?? Date.now())) throw new ShareReceiveError("expired", "share has expired", { expiresAt: envelope.expiry });
}

async function verifyV1PolicyEnvelope(envelope: ShareEnvelope, linkOrigin: string, options: ShareFetchOptions): Promise<void> {
  if (envelope.authorizationTarget.kind !== "policy") throw new ShareReceiveError("unsupported-target", "share target is not an addressed policy", { reason: "policy-target" });
  if (envelope.target.origin !== linkOrigin || (options.expectedOrigin !== undefined && (linkOrigin !== options.expectedOrigin || envelope.target.origin !== options.expectedOrigin))) {
    throw new ShareReceiveError("origin-mismatch", "share origin does not match the trusted origin");
  }
  // v1 policy bytes are an integrity witness, never a trust root. This
  // compatibility verifier has no external v1 authority contract, so it must
  // not accept an addressed envelope as signature-valid.
  throw new ShareReceiveError("unsupported-target", "share policy target is not supported", { reason: "policy-target" });
}

/** Verify a decrypted bearer envelope for browser adapters that own transport. */
export async function verifyBearerEnvelope(
  envelope: ShareEnvelope,
  linkOrigin: string,
  options: VerifyBearerEnvelopeOptions = {},
): Promise<void> {
  // The registry origin is part of the signed target binding. A valid
  // envelope copied to another canonical Share origin must not become a
  // valid link there, even when the caller did not provide an allowlist.
  if (envelope.target.origin !== linkOrigin || (options.expectedOrigin !== undefined && (linkOrigin !== options.expectedOrigin || envelope.target.origin !== options.expectedOrigin))) {
    throw new ShareReceiveError("origin-mismatch", "share origin does not match the trusted origin");
  }
  if (envelope.authorizationTarget.kind !== "bearerKey") throw new ShareReceiveError("unsupported-target", "this receive path only handles bearer shares", { reason: envelope.authorizationTarget.kind === "policy" ? "policy-target" : "recipient-did-target" });
  if (envelope.target.resource.kind !== "exact") throw new ShareReceiveError("unsupported-target", "this receive path only handles exact resources", { reason: "prefix-resource" });
  const expiry = Date.parse(envelope.expiry);
  if (!Number.isFinite(expiry)) throw new ShareReceiveError("envelope-invalid", "share expiry is invalid");
  try { if (!await verifyEnvelope(envelope, { expectedSignerDid: envelope.signature.signerDid })) throw new Error("signature"); }
  catch { throw new ShareReceiveError("signature-invalid", "share signature is invalid"); }
  if (expiry <= (options.now?.() ?? Date.now())) throw new ShareReceiveError("expired", "share has expired", { expiresAt: envelope.expiry });
  const capability = checkBearerDelegation(envelope, options.now === undefined ? {} : { now: options.now });
  if (!capability.ok) throw new ShareReceiveError("capability-invalid", "share delegation does not authorize the target");
}

async function verifyResolved(envelope: ShareEnvelope, linkOrigin: string, options: ShareFetchOptions): Promise<void> {
  await verifyBearerEnvelope(envelope, linkOrigin, options);
}

export async function inspectShare(link: string, options: ShareFetchOptions = {}): Promise<ShareInspection> {
  const resolved = await resolveShareEnvelope(link, options);
  if (resolved.envelope.version === 1 && resolved.envelope.authorizationTarget.kind === "policy") await verifyV1PolicyEnvelope(resolved.envelope, resolved.origin, options);
  else if (resolved.envelope.version === 1) await verifyResolved(resolved.envelope, resolved.origin, options);
  else if (resolved.envelope.version === 2) await verifyV2Envelope(resolved.envelope, resolved.origin, options);
  else await verifyV3Envelope(resolved.envelope, resolved.origin, options);
  if (resolved.envelope.version === 2 || resolved.envelope.version === 3 || resolved.envelope.authorizationTarget.kind === "policy") options.onResolvedAddressedEnvelope?.(resolved.envelope, resolved.cid);
  return { metadata: metadataFor(resolved.envelope, resolved.origin), link: { origin: resolved.origin, cid: resolved.cid, kind: resolved.kind } };
}

export async function receiveShare(link: string, options: ShareFetchOptions = {}): Promise<ShareReceiveOutcome> {
  const resolved = await resolveShareEnvelope(link, options);
  if (resolved.envelope.version === 3) {
    await verifyV3Envelope(resolved.envelope, resolved.origin, options);
    options.onResolvedAddressedEnvelope?.(resolved.envelope, resolved.cid);
    return { state: "authorization-required", method: resolved.envelope.recipientMatcher.kind === "recipientDid" ? "openkey-device" : "email-claim" };
  }
  if (resolved.envelope.version === 2) {
    await verifyV2Envelope(resolved.envelope, resolved.origin, options);
    options.onResolvedAddressedEnvelope?.(resolved.envelope, resolved.cid);
    const method: ShareAuthorizationMethod = resolved.envelope.recipientMatcher.kind === "recipientDid" ? "openkey-device" : "email-claim";
    if (options.authorization === undefined) return { state: "authorization-required", method };
    const result = options.authorizationResumeToken === undefined
      ? await options.authorization.begin({ envelope: resolved.envelope, method })
      : await options.authorization.resume({ envelope: resolved.envelope, method, resumeToken: options.authorizationResumeToken, ...(options.authorizationProof === undefined ? {} : { proof: options.authorizationProof }) });
    if (result.state === "authorization-required") return result;
    if (result.state === "denied") throw new ShareReceiveError("authorization-denied", "share authorization was denied");
    if (result.value === null || typeof result.value !== "object" || !(result.value.bytes instanceof Uint8Array) || result.value.proof === undefined || options.authorization.verifyResult === undefined) {
      throw new ShareReceiveError("content-integrity-failed", "share authorization returned an unsigned content result");
    }
    const authorized = result.value;
    try {
      if (!await options.authorization.verifyResult({ envelope: resolved.envelope, value: authorized, proof: authorized.proof })) throw new Error("node proof");
    } catch {
      throw new ShareReceiveError("content-integrity-failed", "node authorization proof is invalid");
    }
    const bytes = authorized.bytes.slice();
    const maxBytes = options.maxContentBlobBytes ?? DEFAULT_MAX_CONTENT_BLOB_BYTES;
    if (bytes.byteLength > maxBytes) throw new ShareReceiveError("max-bytes-exceeded", "shared content exceeds the configured byte limit");
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const bodyDigest = toBase64Url(digestBytes);
    if (authorized.bodyDigest !== bodyDigest) throw new ShareReceiveError("content-integrity-failed", "authorized content digest does not match");
    if (authorized.contentSourceDigest !== resolved.envelope.contentSourceDigest) throw new ShareReceiveError("content-integrity-failed", "authorized content source does not match");
    const binding = authorized.binding;
    if (
      binding.shareId !== resolved.envelope.shareId ||
      binding.delegationCid !== resolved.envelope.delegationCid ||
      binding.authorityMaterialHandle !== resolved.envelope.authorityMaterialHandle ||
      binding.authorityMaterialDigest !== resolved.envelope.authorityMaterialDigest ||
      binding.resource.kind !== resolved.envelope.resource.kind ||
      binding.resource.path !== resolved.envelope.resource.path ||
      (binding.action !== undefined && !resolved.envelope.actions.some((action) => action === binding.action || `tinycloud.kv/${action}` === binding.action))
    ) throw new ShareReceiveError("content-integrity-failed", "authorized content binding does not match");
    if (resolved.envelope.metadata.byteLength !== undefined && resolved.envelope.metadata.byteLength !== bytes.byteLength) {
      throw new ShareReceiveError("content-integrity-failed", "authorized content length does not match");
    }
    let text: string | undefined;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* binary result */ }
    return { metadata: metadataFor(resolved.envelope, resolved.origin), link: { origin: resolved.origin, cid: resolved.cid, kind: resolved.kind }, bytes, ...(text === undefined ? {} : { text }) };
  }
  if (resolved.envelope.authorizationTarget.kind === "policy") {
    await verifyV1PolicyEnvelope(resolved.envelope, resolved.origin, options);
    options.onResolvedAddressedEnvelope?.(resolved.envelope, resolved.cid);
    return { state: "authorization-required", method: "email-claim" };
  }
  await verifyResolved(resolved.envelope, resolved.origin, options);
  // Bearer envelopes are intentionally never exposed to an adapter callback.
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  if (resolved.envelope.content !== undefined) {
    bytes = await registryFetcher(
      options,
      (options.maxContentBlobBytes ?? DEFAULT_MAX_CONTENT_BLOB_BYTES) + CONTENT_SEALED_OVERHEAD,
      "max-bytes-exceeded",
      "content",
    )({ origin: resolved.origin, cid: resolved.envelope.content.cid });
    if (await computeCid(bytes) !== resolved.envelope.content.cid) throw new ShareReceiveError("content-integrity-failed", "shared content CID does not match");
    const key = fromBase64Url(resolved.envelope.content.key);
    try { bytes = await open(bytes, key); } catch { throw new ShareReceiveError("content-integrity-failed", "shared content could not be opened"); } finally { key.fill(0); }
    if (bytes.byteLength > (options.maxContentBlobBytes ?? DEFAULT_MAX_CONTENT_BLOB_BYTES)) {
      throw new ShareReceiveError("max-bytes-exceeded", "shared content exceeds the configured byte limit");
    }
  }
  let text: string | undefined;
  if (bytes.byteLength !== 0) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* binary result */ }
  }
  return { metadata: metadataFor(resolved.envelope, resolved.origin), link: { origin: resolved.origin, cid: resolved.cid, kind: resolved.kind }, bytes, ...(text === undefined ? {} : { text }) };
}
