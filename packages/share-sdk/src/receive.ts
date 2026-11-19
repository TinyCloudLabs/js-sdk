import {
  canonicalize,
  computeCid,
  open,
  parseShareUrl,
  shareEnvelopeV2Schema,
  shareEnvelopeV3Schema,
  toBase64Url,
  verifyEnvelopeV2,
  verifyEnvelopeV3,
  type ShareEnvelopeV2,
  type ShareEnvelopeV3,
} from "@tinycloud/share-envelope";
import type { LinkError, ResolvedLink } from "@tinycloud/share-envelope/links";
import { ArtifactPinError, verifyArtifactShare } from "./artifact-pin.js";
import type { ShareAuthorizationAdapter, ShareAuthorizationMethod, ShareAuthorizedContent } from "./authorization.js";

export type ShareErrorCode = "invalid-link" | "fetch-failed" | "max-bytes-exceeded" | "cid-mismatch" | "decrypt-failed" | "envelope-invalid" | "origin-mismatch" | "signature-invalid" | "capability-invalid" | "expired" | "unsupported-target" | "authorization-denied" | "content-integrity-failed";

export const SHARE_RESULT_VERSION = 1 as const;
export const DEFAULT_MAX_SEALED_BLOB_BYTES = 100 * 1024 * 1024 + 29;
export const DEFAULT_MAX_CONTENT_BLOB_BYTES = DEFAULT_MAX_SEALED_BLOB_BYTES;

export class ShareReceiveError extends Error {
  readonly code: ShareErrorCode;
  readonly details: { readonly expiresAt?: string; readonly stage?: "envelope" | "content"; readonly reason?: "policy-target" | "recipient-did-target" | "prefix-resource" } | undefined;
  constructor(code: ShareErrorCode, message: string, details?: { readonly expiresAt?: string; readonly stage?: "envelope" | "content"; readonly reason?: "policy-target" | "recipient-did-target" | "prefix-resource" }) {
    super(message);
    this.name = "ShareReceiveError";
    this.code = code;
    this.details = details;
  }
  toJSON(): ShareErrorInfo { return { protocol: "tinycloud-share", version: SHARE_RESULT_VERSION, error: { code: this.code } }; }
}

export interface ShareErrorInfo {
  readonly protocol: "tinycloud-share";
  readonly version: typeof SHARE_RESULT_VERSION;
  readonly error: { readonly code: ShareErrorCode };
}

export function toShareErrorInfo(error: unknown): ShareErrorInfo {
  if (error instanceof ShareReceiveError) return error.toJSON();
  return { protocol: "tinycloud-share", version: SHARE_RESULT_VERSION, error: { code: "fetch-failed" } };
}

/**
 * A Policy/v3 link is a `v=4` link: a short link whose sealed envelope the links
 * API serves, or a full link that carries it. The key and body CID stay in the
 * fragment and are never sent.
 */
export interface ShareFetchOptions {
  /** The trusted viewer origin. Defaults to the link's own origin. */
  readonly expectedOrigin?: string;
  /** The links API origin a short link is read from. A link never names it. Defaults to `https://api.tinycloud.xyz`. */
  readonly apiOrigin?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly maxSealedBlobBytes?: number;
  readonly maxContentBlobBytes?: number;
  readonly onResolvedAddressedEnvelope?: (envelope: ShareEnvelopeV2 | ShareEnvelopeV3, cid: string) => void;
  /** Legacy V2 registry transport; used only for existing compact V2 links. */
  readonly registryBaseUrl?: string;
  readonly fetchBlob?: (input: { readonly origin: string; readonly cid: string; readonly signal?: AbortSignal }) => Promise<Uint8Array>;
  readonly trustedSignerDid?: string;
  readonly trustedPolicyAuthority?: SharePolicyAuthority;
  readonly authorization?: ShareAuthorizationAdapter<ShareAuthorizedContent>;
  readonly authorizationResumeToken?: string;
  readonly authorizationProof?: unknown;
}

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
  /** Set when the share is pinned to one artifact version; the owner's signature covers it (TC-1428). */
  readonly artifact?: { readonly id: string; readonly version: number };
}

export interface ShareInspection {
  readonly metadata: ShareMetadata;
  readonly link: { readonly origin: string; readonly cid: string; readonly kind: "policy" | "compact" };
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

export interface ShareReceiveAuthorizationRequired {
  readonly state: "authorization-required";
  readonly method: ShareAuthorizationMethod;
  readonly continueUrl?: string;
  readonly resumeToken?: string;
}

/** Retained as the result consumed after the node authorization ceremony. */
export interface ShareReceiveResult extends ShareInspection {
  readonly bytes: Uint8Array;
  readonly text?: string;
}

export type ShareReceiveOutcome = ShareReceiveResult | ShareReceiveAuthorizationRequired;

function metadataFor(envelope: ShareEnvelopeV2 | ShareEnvelopeV3, origin: string): ShareMetadata {
  const kind = envelope.recipientMatcher.kind === "recipientDid"
    ? "recipientDid"
    : envelope.recipientMatcher.kind === "exactEmail"
      ? "email"
      : envelope.recipientMatcher.kind === "emailDomain" ? "emailDomain" : "bearer";
  return {
    protocol: "tinycloud-share",
    version: 1,
    shareId: envelope.shareId,
    origin,
    target: { ...envelope.target, kind },
    resource: { ...envelope.resource },
    actions: [...envelope.actions],
    expiresAt: envelope.expiry,
    display: {
      ...(envelope.display.senderName === undefined ? {} : { senderName: envelope.display.senderName }),
      ...(envelope.display.filename === undefined ? {} : { filename: envelope.display.filename }),
      ...(envelope.display.mode === undefined ? {} : { mode: envelope.display.mode }),
    },
    ...(envelope.version === 3 && envelope.artifactPin !== undefined ? { artifact: { id: envelope.artifactPin.artifactId, version: envelope.artifactPin.version } } : {}),
  };
}

function receiveErrorFor(error: LinkError): ShareReceiveError {
  switch (error.code) {
    case "origin_not_trusted":
      return new ShareReceiveError("origin-mismatch", "share link origin is not trusted");
    case "body_over_cap":
    case "response_too_large":
      return new ShareReceiveError("max-bytes-exceeded", "sealed policy envelope exceeds the size limit");
    case "body_hash_mismatch":
    case "link_cid_mismatch":
      return new ShareReceiveError("cid-mismatch", "sealed envelope bytes do not match the link CID");
    case "body_open_failed":
      return new ShareReceiveError("decrypt-failed", "share envelope could not be opened");
    case "gone":
    case "expired":
      return new ShareReceiveError("expired", "share link has expired, was deleted, or never existed");
    case "bad_signature":
    case "issuer_binding_mismatch":
      return new ShareReceiveError("signature-invalid", "share link signature is invalid");
    case "service_refused":
    case "service_unavailable":
    case "invalid_response":
      return new ShareReceiveError("fetch-failed", "share link could not be fetched");
    case "not_a_url":
    case "not_https":
    case "userinfo":
    case "not_canonical":
    case "query_present":
    case "removed_version":
    case "path_grammar":
    case "fragment_grammar":
    case "key_noncanonical":
    case "cid_grammar":
    case "record_encoding":
    case "record_json":
    case "record_not_canonical":
    case "type_path_mismatch":
    case "full_non_share":
      return new ShareReceiveError("invalid-link", "share link format is invalid");
    default:
      return new ShareReceiveError("envelope-invalid", "share envelope is invalid");
  }
}

async function resolvePolicyShare(link: string, options: ShareFetchOptions): Promise<{ readonly envelope: ShareEnvelopeV3; readonly origin: string; readonly cid: string }> {
  options.signal?.throwIfAborted();
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ShareReceiveError("invalid-link", "share link format is invalid");
  }
  // The links module is a separate file of `@tinycloud/share-envelope`, loaded when a link is first resolved.
  const links = await import("@tinycloud/share-envelope/links");
  let resolved: ResolvedLink;
  try {
    resolved = await links.resolveLink(link, {
      trustedOrigins: [options.expectedOrigin ?? url.origin],
      apiOrigin: options.apiOrigin ?? links.DEFAULT_LINKS_API_ORIGIN,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      now: options.now?.() ?? Date.now(),
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error instanceof links.LinkError ? receiveErrorFor(error) : error;
  }
  if (resolved.type !== "share") throw new ShareReceiveError("invalid-link", "share link is not a share");
  const limit = options.maxSealedBlobBytes ?? DEFAULT_MAX_SEALED_BLOB_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || resolved.body.byteLength > limit) throw new ShareReceiveError("max-bytes-exceeded", "sealed policy envelope exceeds the configured byte limit");
  const cid = resolved.header.bodyCid;
  options.signal?.throwIfAborted();
  let envelope: ShareEnvelopeV3;
  try {
    const encoded = new TextDecoder("utf-8", { fatal: true }).decode(resolved.plaintext);
    if (canonicalize(resolved.value) !== encoded) throw new Error("non-canonical envelope");
    envelope = shareEnvelopeV3Schema.parse(resolved.value);
  } catch {
    throw new ShareReceiveError("envelope-invalid", "share envelope is invalid");
  }
  try {
    if (!await verifyEnvelopeV3(envelope, { expectedSignerDid: envelope.policy.ownerDid })) throw new Error("signature");
  } catch {
    throw new ShareReceiveError("signature-invalid", "share signature is invalid");
  }
  // The owner's signature (checked above) covers the artifact pin; the pin must also match what the share reads, and a
  // share that reads an artifact without a pin is refused.
  try {
    verifyArtifactShare(envelope, { expectedOwnerDid: envelope.policy.ownerDid });
  } catch (error) {
    if (!(error instanceof ArtifactPinError)) throw error;
    throw new ShareReceiveError("envelope-invalid", `share artifact pin is invalid (${error.code})`);
  }
  options.signal?.throwIfAborted();
  const expiry = Date.parse(envelope.expiry);
  if (!Number.isFinite(expiry)) throw new ShareReceiveError("envelope-invalid", "share expiry is invalid");
  if (expiry <= (options.now?.() ?? Date.now())) throw new ShareReceiveError("expired", "share has expired", { expiresAt: envelope.expiry });
  options.onResolvedAddressedEnvelope?.(envelope, cid);
  return { envelope, origin: url.origin, cid };
}

/** Existing V2 links keep their registry-backed read path. V3 publication never uses it. */
async function resolveLegacyV2(link: string, options: ShareFetchOptions): Promise<{ readonly envelope: ShareEnvelopeV2; readonly origin: string; readonly cid: string }> {
  let parsed: ReturnType<typeof parseShareUrl>;
  try { parsed = parseShareUrl(link, { ...(options.expectedOrigin === undefined ? {} : { expectedOrigin: options.expectedOrigin }) }); }
  catch { throw new ShareReceiveError("invalid-link", "legacy share link format is invalid"); }
  try {
    options.signal?.throwIfAborted();
    const origin = new URL(link).origin;
    const limit = options.maxSealedBlobBytes ?? DEFAULT_MAX_SEALED_BLOB_BYTES;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new ShareReceiveError("max-bytes-exceeded", "sealed envelope limit is invalid");
    let sealed: Uint8Array;
    if (options.fetchBlob !== undefined) {
      try { sealed = await options.fetchBlob({ origin, cid: parsed.ciphertextCid, ...(options.signal === undefined ? {} : { signal: options.signal }) }); }
      catch { throw new ShareReceiveError("fetch-failed", "legacy registry unavailable"); }
    } else {
      if (options.registryBaseUrl === undefined) throw new ShareReceiveError("fetch-failed", "legacy registry is required");
      const response = await (options.fetch ?? globalThis.fetch)(`${options.registryBaseUrl.replace(/\/+$/, "")}/ipfs/${parsed.ciphertextCid}?format=raw`, {
        headers: { accept: "application/vnd.ipld.raw" }, redirect: "error", ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!response.ok) throw new ShareReceiveError("fetch-failed", "legacy registry unavailable");
      if (Number(response.headers.get("content-length")) > limit) throw new ShareReceiveError("max-bytes-exceeded", "sealed envelope exceeds the size limit");
      const reader = response.body?.getReader();
      if (reader === undefined) throw new ShareReceiveError("fetch-failed", "legacy registry returned no body");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > limit) { await reader.cancel(); throw new ShareReceiveError("max-bytes-exceeded", "sealed envelope exceeds the size limit"); }
        chunks.push(part.value);
      }
      sealed = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { sealed.set(chunk, offset); offset += chunk.length; }
    }
    options.signal?.throwIfAborted();
    if (!(sealed instanceof Uint8Array) || sealed.length > limit) throw new ShareReceiveError("max-bytes-exceeded", "sealed envelope exceeds the size limit");
    if (await computeCid(sealed) !== parsed.ciphertextCid) throw new ShareReceiveError("cid-mismatch", "legacy envelope CID does not match");
    let plaintext: Uint8Array;
    try { plaintext = await open(sealed, parsed.key32); }
    catch { throw new ShareReceiveError("decrypt-failed", "legacy envelope could not be opened"); }
    let envelope: ShareEnvelopeV2;
    try {
      const encoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      const value = JSON.parse(encoded) as unknown;
      if (canonicalize(value) !== encoded) throw new Error("non-canonical envelope");
      envelope = shareEnvelopeV2Schema.parse(value);
    } catch { throw new ShareReceiveError("envelope-invalid", "legacy envelope is invalid"); }
    return { envelope, origin, cid: parsed.ciphertextCid };
  } finally { parsed.key32.fill(0); }
}

function evidenceMatchesV2(envelope: ShareEnvelopeV2, evidence: SharePolicyEvidence): boolean {
  const actions = new Set(evidence.actions.map((action) => action === "read" ? "tinycloud.kv/get" : action === "list" ? "tinycloud.kv/list" : action === "edit" ? "tinycloud.kv/put" : action));
  const resourceCovers = evidence.resource.kind === "exact"
    ? envelope.resource.kind === "exact" && evidence.resource.path === envelope.resource.path
    : envelope.resource.path === evidence.resource.path || envelope.resource.path.startsWith(evidence.resource.path.endsWith("/") ? evidence.resource.path : `${evidence.resource.path}/`);
  return envelope.authorizationTarget.kind === "policy" &&
    evidence.policyCid === envelope.authorizationTarget.policyCid &&
    evidence.signerDid === envelope.signature.signerDid && evidence.registrationCid.length > 0 &&
    evidence.shareId === envelope.shareId &&
    canonicalize(evidence.recipientMatcher) === canonicalize(envelope.recipientMatcher) &&
    canonicalize(evidence.target) === canonicalize(envelope.target) && resourceCovers &&
    envelope.actions.every((action) => actions.has(action === "read" ? "tinycloud.kv/get" : action === "list" ? "tinycloud.kv/list" : "tinycloud.kv/put")) &&
    canonicalize(evidence.contentSource) === canonicalize(envelope.contentSource) &&
    evidence.contentSourceDigest === envelope.contentSourceDigest &&
    evidence.delegationCid === envelope.delegationCid &&
    evidence.authorityMaterialHandle === envelope.authorityMaterialHandle &&
    evidence.authorityMaterialDigest === envelope.authorityMaterialDigest &&
    evidence.expiresAt === envelope.expiry && Number.isFinite(Date.parse(evidence.expiresAt)) &&
    Date.parse(evidence.expiresAt) === Date.parse(envelope.expiry);
}

async function verifyLegacyV2(envelope: ShareEnvelopeV2, options: ShareFetchOptions): Promise<void> {
  try { if (!await verifyEnvelopeV2(envelope, { expectedSignerDid: envelope.signature.signerDid })) throw new Error("signature"); }
  catch { throw new ShareReceiveError("signature-invalid", "legacy envelope signature is invalid"); }
  const expiry = Date.parse(envelope.expiry);
  if (!Number.isFinite(expiry)) throw new ShareReceiveError("envelope-invalid", "legacy share expiry is invalid");
  if (expiry <= (options.now?.() ?? Date.now())) throw new ShareReceiveError("expired", "legacy share has expired", { expiresAt: envelope.expiry });
  if (envelope.authorizationTarget.kind === "policy") {
    if (options.trustedPolicyAuthority === undefined) throw new ShareReceiveError("envelope-invalid", "a legacy policy authority is required");
    let evidence: SharePolicyEvidence | undefined;
    try { evidence = await options.trustedPolicyAuthority.resolve({ policyCid: envelope.authorizationTarget.policyCid, envelope }); }
    catch { /* Treat authority transport failure as missing evidence. */ }
    if (evidence === undefined || !evidenceMatchesV2(envelope, evidence)) throw new ShareReceiveError("capability-invalid", "legacy policy evidence does not match");
    if (options.trustedSignerDid !== undefined && options.trustedSignerDid !== evidence.signerDid) throw new ShareReceiveError("signature-invalid", "legacy signer is not trusted");
  } else if (options.trustedSignerDid === undefined || options.trustedSignerDid !== envelope.signature.signerDid ||
      (envelope.authorizationTarget.kind === "recipientDid" && envelope.recipientMatcher.kind === "recipientDid" && envelope.authorizationTarget.did !== envelope.recipientMatcher.value)) {
    throw new ShareReceiveError("capability-invalid", "legacy recipient authority does not match");
  }
}

export async function inspectShare(link: string, options: ShareFetchOptions = {}): Promise<ShareInspection> {
  if (isLegacyV2Link(link)) {
    const legacy = await resolveLegacyV2(link, options);
    await verifyLegacyV2(legacy.envelope, options);
    options.onResolvedAddressedEnvelope?.(legacy.envelope, legacy.cid);
    return { metadata: metadataFor(legacy.envelope, legacy.origin), link: { origin: legacy.origin, cid: legacy.cid, kind: "compact" } };
  }
  const resolved = await resolvePolicyShare(link, options);
  return { metadata: metadataFor(resolved.envelope, resolved.origin), link: { origin: resolved.origin, cid: resolved.cid, kind: "policy" } };
}

/**
 * Resolve and verify invitation metadata only. Actual content access is an
 * invocation against the owner node and is performed by the receiver SDK.
 */
export async function receiveShare(link: string, options: ShareFetchOptions = {}): Promise<ShareReceiveOutcome> {
  if (isLegacyV2Link(link)) return receiveLegacyV2(link, options);
  const resolved = await resolvePolicyShare(link, options);
  return { state: "authorization-required", method: resolved.envelope.recipientMatcher.kind === "recipientDid" ? "openkey-device" : "email-claim" };
}

function isLegacyV2Link(link: string): boolean {
  try { const url = new URL(link); return /^\/s\/bafkrei[a-z2-7]{52}$/.test(url.pathname) && url.hash.startsWith("#k="); }
  catch { return false; }
}

async function receiveLegacyV2(link: string, options: ShareFetchOptions): Promise<ShareReceiveOutcome> {
  const resolved = await resolveLegacyV2(link, options);
  const { envelope } = resolved;
  await verifyLegacyV2(envelope, options);
  options.onResolvedAddressedEnvelope?.(envelope, resolved.cid);
  const method: ShareAuthorizationMethod = envelope.recipientMatcher.kind === "recipientDid" ? "openkey-device" : "email-claim";
  if (options.authorization === undefined) return { state: "authorization-required", method };
  const result = options.authorizationResumeToken === undefined
    ? await options.authorization.begin({ envelope, method })
    : await options.authorization.resume({ envelope, method, resumeToken: options.authorizationResumeToken,
        ...(options.authorizationProof === undefined ? {} : { proof: options.authorizationProof }) });
  if (result.state === "authorization-required") return result;
  if (result.state === "denied") throw new ShareReceiveError("authorization-denied", "legacy share authorization was denied");
  if (result.value === null || typeof result.value !== "object" || !(result.value.bytes instanceof Uint8Array) ||
      result.value.proof === undefined || options.authorization.verifyResult === undefined) {
    throw new ShareReceiveError("content-integrity-failed", "legacy content lacks a verifiable proof");
  }
  const authorized = result.value;
  try { if (!await options.authorization.verifyResult({ envelope, value: authorized, proof: authorized.proof })) throw new Error("proof"); }
  catch { throw new ShareReceiveError("content-integrity-failed", "legacy content proof is invalid"); }
  const bytes = authorized.bytes.slice();
  if (bytes.length > (options.maxContentBlobBytes ?? DEFAULT_MAX_CONTENT_BLOB_BYTES)) throw new ShareReceiveError("max-bytes-exceeded", "legacy content exceeds the size limit");
  const bodyDigest = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  if (authorized.bodyDigest !== bodyDigest || authorized.contentSourceDigest !== envelope.contentSourceDigest ||
      authorized.binding.shareId !== envelope.shareId || authorized.binding.delegationCid !== envelope.delegationCid ||
      authorized.binding.authorityMaterialHandle !== envelope.authorityMaterialHandle ||
      authorized.binding.authorityMaterialDigest !== envelope.authorityMaterialDigest ||
      authorized.binding.resource.kind !== envelope.resource.kind || authorized.binding.resource.path !== envelope.resource.path ||
      (authorized.binding.action !== undefined && !envelope.actions.some((action) => action === authorized.binding.action || `tinycloud.kv/${action}` === authorized.binding.action)) ||
      (envelope.metadata.byteLength !== undefined && envelope.metadata.byteLength !== bytes.length)) {
    throw new ShareReceiveError("content-integrity-failed", "legacy content binding does not match");
  }
  let text: string | undefined;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* binary content */ }
  return { metadata: metadataFor(envelope, resolved.origin), link: { origin: resolved.origin, cid: resolved.cid, kind: "compact" }, bytes, ...(text === undefined ? {} : { text }) };
}
