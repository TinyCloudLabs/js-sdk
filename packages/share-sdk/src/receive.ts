import {
  canonicalize,
  shareEnvelopeV3Schema,
  verifyEnvelopeV3,
  type ShareEnvelopeV3,
} from "@tinycloud/share-envelope";
import type { LinkError, ResolvedLink } from "@tinycloud/share-envelope/links";
import { ArtifactPinError, verifyArtifactShare } from "./artifact-pin.js";
import type { ShareAuthorizationMethod } from "./authorization.js";

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
  readonly onResolvedAddressedEnvelope?: (envelope: ShareEnvelopeV3, cid: string) => void;
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
  readonly link: { readonly origin: string; readonly cid: string; readonly kind: "policy" };
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

function metadataFor(envelope: ShareEnvelopeV3, origin: string): ShareMetadata {
  const kind = envelope.recipientMatcher.kind === "recipientDid"
    ? "recipientDid"
    : envelope.recipientMatcher.kind === "exactEmail"
      ? "email"
      : "emailDomain";
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
    ...(envelope.artifactPin === undefined ? {} : { artifact: { id: envelope.artifactPin.artifactId, version: envelope.artifactPin.version } }),
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

export async function inspectShare(link: string, options: ShareFetchOptions = {}): Promise<ShareInspection> {
  const resolved = await resolvePolicyShare(link, options);
  return { metadata: metadataFor(resolved.envelope, resolved.origin), link: { origin: resolved.origin, cid: resolved.cid, kind: "policy" } };
}

/**
 * Resolve and verify invitation metadata only. Actual content access is an
 * invocation against the owner node and is performed by the receiver SDK.
 */
export async function receiveShare(link: string, options: ShareFetchOptions = {}): Promise<ShareReceiveOutcome> {
  const resolved = await resolvePolicyShare(link, options);
  return { state: "authorization-required", method: resolved.envelope.recipientMatcher.kind === "recipientDid" ? "openkey-device" : "email-claim" };
}
