import {
  canonicalize,
  computeCid,
  parseInlineShareUrl,
  shareEnvelopeV3Schema,
  verifyEnvelopeV3,
  type ShareEnvelopeV3,
} from "@tinycloud/share-envelope";
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

/** Policy/v3 links are self-contained authorization metadata; no blob fetch adapter exists. */
export interface ShareFetchOptions {
  readonly expectedOrigin?: string;
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
  };
}

async function resolvePolicyShare(link: string, options: ShareFetchOptions): Promise<{ readonly envelope: ShareEnvelopeV3; readonly origin: string; readonly cid: string }> {
  options.signal?.throwIfAborted();
  let url: URL;
  let parsed: ReturnType<typeof parseInlineShareUrl>;
  try {
    url = new URL(link);
    if (url.pathname !== "/viewer" || url.hash !== "" || url.searchParams.size !== 1 || !url.searchParams.has("tc2")) throw new Error("not public Policy/v3");
    parsed = parseInlineShareUrl(link, { ...(options.expectedOrigin === undefined ? {} : { expectedOrigin: options.expectedOrigin }) });
    if (parsed.key32 !== undefined) throw new Error("secret inline transport is retired");
  } catch {
    throw new ShareReceiveError("invalid-link", "share link format is invalid");
  }
  const limit = options.maxSealedBlobBytes ?? DEFAULT_MAX_SEALED_BLOB_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || parsed.ciphertext.byteLength > limit) throw new ShareReceiveError("max-bytes-exceeded", "public policy envelope exceeds the configured byte limit");
  if (await computeCid(parsed.ciphertext) !== parsed.ciphertextCid) throw new ShareReceiveError("cid-mismatch", "public envelope bytes do not match the link CID");
  options.signal?.throwIfAborted();
  let envelope: ShareEnvelopeV3;
  try {
    const encoded = new TextDecoder("utf-8", { fatal: true }).decode(parsed.ciphertext);
    const value = JSON.parse(encoded) as unknown;
    if (canonicalize(value) !== encoded) throw new Error("non-canonical envelope");
    envelope = shareEnvelopeV3Schema.parse(value);
  } catch {
    throw new ShareReceiveError("envelope-invalid", "share envelope is invalid");
  }
  try {
    if (!await verifyEnvelopeV3(envelope, { expectedSignerDid: envelope.policy.ownerDid })) throw new Error("signature");
  } catch {
    throw new ShareReceiveError("signature-invalid", "share signature is invalid");
  }
  options.signal?.throwIfAborted();
  const expiry = Date.parse(envelope.expiry);
  if (!Number.isFinite(expiry)) throw new ShareReceiveError("envelope-invalid", "share expiry is invalid");
  if (expiry <= (options.now?.() ?? Date.now())) throw new ShareReceiveError("expired", "share has expired", { expiresAt: envelope.expiry });
  options.onResolvedAddressedEnvelope?.(envelope, parsed.ciphertextCid);
  return { envelope, origin: url.origin, cid: parsed.ciphertextCid };
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
