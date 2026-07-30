import { ed25519 } from "@noble/curves/ed25519";
import {
  bearerResourceUri,
  canonicalize,
  computeCid,
  didKeyFromEd25519PublicKey,
  encodeInlineShareUrl,
  encodeShareUrl,
  generateKey,
  isCanonicalHttpsOrigin,
  mintBearerDelegation,
  seal,
  signEnvelope,
  toBase64Url,
  type ShareEnvelope,
  type UnsignedShareEnvelope,
} from "@tinycloud/share-envelope";

export const SHARE_CONTENT_LIMIT = 100 * 1024 * 1024;
export const SHARE_SEALED_OVERHEAD = 1 + 12 + 16;
export const SHARE_PUBLISH_RESULT_VERSION = 1 as const;
export const DEFAULT_SHARE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type SharePublishTarget =
  | { readonly kind: "bearer" }
  | { readonly kind: "recipientDid"; readonly did: string }
  | { readonly kind: "email"; readonly address: string }
  | { readonly kind: "emailDomain"; readonly domain: string };

export interface ShareUploadInput {
  readonly blob: Uint8Array;
  readonly cid: string;
  readonly deleteAfter: string;
  readonly contentLength: number;
}

export interface ShareUploadResult {
  readonly cid: string;
  readonly deleteAfter: string;
}

export type ShareUpload = (input: ShareUploadInput) => Promise<ShareUploadResult>;

export type ShareUploadAuthorization =
  | string
  | HeadersInit;

export interface SharePublishOptions {
  readonly source: Uint8Array | AsyncIterable<Uint8Array>;
  readonly filename: string;
  readonly mediaType?: string;
  /** Browser Share also publishes binary files; the CLI leaves this false. */
  readonly allowBinary?: boolean;
  readonly target?: SharePublishTarget;
  readonly expiresAt?: Date;
  readonly origin: string;
  readonly nodeAudience?: string;
  readonly spaceId?: string;
  readonly inline?: boolean;
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly registryBaseUrl?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  /**
   * Signs the complete upload request, including its digest, size, expiry,
   * and session binding. Production callers must provide this or explicitly
   * opt into browser cookie credentials; an unsigned public upload is never
   * attempted.
   */
  readonly authorizeUpload?: (input: ShareUploadInput) => Promise<ShareUploadAuthorization>;
  /** Origin to which any cookie-bearing upload authorization is scoped. */
  readonly authorizationOrigin?: string;
  readonly credentials?: RequestCredentials;
  /** Test/dev-only escape hatch for a local HTTP registry. */
  readonly allowInsecureRegistry?: boolean;
  /** A hermetic or service-specific uploader can own transport completely. */
  readonly uploadBlob?: ShareUpload;
}

export interface PublishedShareMetadata {
  readonly protocol: "tinycloud-share";
  readonly version: 1;
  readonly shareId: string;
  readonly origin: string;
  readonly target: { readonly origin: string; readonly nodeAudience: string; readonly spaceId: string };
  readonly resource: { readonly kind: "exact"; readonly path: string };
  readonly actions: readonly ["read"];
  readonly expiresAt: string;
  readonly display: { readonly filename: string; readonly senderName?: string };
  readonly content: { readonly cid: string };
}

export interface PublishedShare {
  readonly protocol: "tinycloud-share";
  readonly version: typeof SHARE_PUBLISH_RESULT_VERSION;
  /** The only authority-bearing value returned by publish. */
  readonly url: string;
  readonly link: { readonly kind: "compact" | "inline"; readonly cid: string };
  readonly metadata: PublishedShareMetadata;
  readonly registryDeleteAfter: string;
}

/** Machine-readable output omits the complete bearer capability. */
export function redactPublishedShare(result: PublishedShare): Omit<PublishedShare, "url"> {
  const { url: _url, ...redacted } = result;
  return redacted;
}

export type SharePublishErrorCode =
  | "invalid-argument"
  | "unsupported-target"
  | "upload-auth-required"
  | "upload-failed"
  | "max-bytes-exceeded"
  | "inline-too-large";

export class SharePublishError extends Error {
  readonly code: SharePublishErrorCode;
  constructor(code: SharePublishErrorCode, message: string) {
    super(message);
    this.name = "SharePublishError";
    this.code = code;
  }
}

function assertSafeFilename(filename: string): void {
  if (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    /[/\\\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw new SharePublishError("invalid-argument", "filename must be one safe path segment");
  }
}

function assertOrigin(origin: string, label: string): void {
  if (!isCanonicalHttpsOrigin(origin)) {
    throw new SharePublishError("invalid-argument", `${label} must be a canonical HTTPS origin`);
  }
}

async function snapshotSource(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new SharePublishError("invalid-argument", "maxBytes must be a positive safe integer");
  }
  if (source instanceof Uint8Array) {
    if (source.byteLength > limit) throw new SharePublishError("max-bytes-exceeded", "share content exceeds the configured byte limit");
    return source.slice();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) throw new SharePublishError("invalid-argument", "share source yielded invalid bytes");
      total += chunk.byteLength;
      if (total > limit) throw new SharePublishError("max-bytes-exceeded", "share content exceeds the configured byte limit");
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof SharePublishError) throw error;
    throw new SharePublishError("upload-failed", "share source could not be read");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertTarget(target: SharePublishTarget): asserts target is { readonly kind: "bearer" } {
  if (target.kind !== "bearer") {
    throw new SharePublishError("unsupported-target", "this release publishes bearer shares only");
  }
}

function assertRegistryUrl(value: string, allowInsecure: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SharePublishError("invalid-argument", "registry URL is invalid"); }
  if (url.username || url.password || url.search || url.hash) throw new SharePublishError("invalid-argument", "registry URL must not contain credentials, query, or fragment");
  if (!allowInsecure && url.protocol !== "https:") throw new SharePublishError("invalid-argument", "production registry uploads require HTTPS");
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new SharePublishError("invalid-argument", "insecure registry uploads are limited to localhost");
  return url;
}

async function defaultUpload(options: SharePublishOptions, input: ShareUploadInput): Promise<ShareUploadResult> {
  if (options.registryBaseUrl === undefined) throw new SharePublishError("upload-auth-required", "an authenticated share registry is required");
  const base = assertRegistryUrl(options.registryBaseUrl, options.allowInsecureRegistry === true).toString().replace(/\/$/, "");
  const localInsecure = options.allowInsecureRegistry === true && (new URL(base).hostname === "127.0.0.1" || new URL(base).hostname === "localhost");
  // A Node fetch implementation does not carry the browser's Share session
  // cookie. `credentials: include` is therefore never upload authority by
  // itself; callers must inject the nonce/signature-bound authorizer or an
  // explicit hermetic uploader.
  if (options.authorizeUpload === undefined && !localInsecure) {
    throw new SharePublishError("upload-auth-required", "share upload authorization is required");
  }
  let authorization: ShareUploadAuthorization | undefined;
  if (options.authorizeUpload !== undefined) {
    try { authorization = await options.authorizeUpload(input); }
    catch { throw new SharePublishError("upload-auth-required", "share upload authorization was rejected"); }
  }
  if (authorization !== undefined && options.authorizationOrigin !== undefined) {
    let authorizationUrl: URL;
    try { authorizationUrl = new URL(options.authorizationOrigin); } catch { throw new SharePublishError("invalid-argument", "upload authorization origin is invalid"); }
    if (authorizationUrl.origin !== new URL(base).origin) throw new SharePublishError("upload-auth-required", "upload authorization is scoped to another origin");
  }
  const headers = new Headers({
    "content-type": "application/vnd.ipld.raw",
    "if-none-match": "*",
    "x-delete-after": input.deleteAfter,
  });
  if (typeof authorization === "string") headers.set("x-tinycloud-authorization", authorization);
  else if (authorization !== undefined) new Headers(authorization).forEach((value, key) => headers.set(key, value));
  let response: Response;
  try {
    response = await (options.fetchFn ?? globalThis.fetch)(`${base}/blobs`, {
      method: "POST",
      headers,
      body: input.blob as BodyInit,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch { throw new SharePublishError("upload-failed", "share registry is unavailable"); }
  if (response.status === 401 || response.status === 403) throw new SharePublishError("upload-auth-required", "share upload authorization was rejected");
  if (!response.ok) throw new SharePublishError("upload-failed", "share registry rejected the encrypted blob");
  let body: unknown;
  try { body = await response.json(); } catch { throw new SharePublishError("upload-failed", "share registry returned an invalid response"); }
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (record.cid !== input.cid || typeof record.deleteAfter !== "string") throw new SharePublishError("upload-failed", "share registry returned an unexpected CID or retention value");
  return { cid: input.cid, deleteAfter: record.deleteAfter };
}

async function upload(options: SharePublishOptions, input: ShareUploadInput): Promise<ShareUploadResult> {
  const result = await (options.uploadBlob ?? ((value: ShareUploadInput) => defaultUpload(options, value)))(input);
  if (result.cid !== input.cid || typeof result.deleteAfter !== "string") throw new SharePublishError("upload-failed", "share uploader returned an invalid result");
  return result;
}

/** Publish a bounded bearer Markdown artifact using the canonical envelope. */
export async function publishShare(options: SharePublishOptions): Promise<PublishedShare> {
  const target = options.target ?? { kind: "bearer" as const };
  assertTarget(target);
  assertSafeFilename(options.filename);
  assertOrigin(options.origin, "share origin");
  if (options.mediaType !== undefined && options.mediaType.length === 0) throw new SharePublishError("invalid-argument", "mediaType must not be empty");
  const maxBytes = options.maxBytes ?? SHARE_CONTENT_LIMIT;
  if (maxBytes > SHARE_CONTENT_LIMIT) throw new SharePublishError("max-bytes-exceeded", "share content exceeds the maximum 100 MiB limit");
  const content = await snapshotSource(options.source, maxBytes);
  if (content.byteLength === 0) throw new SharePublishError("invalid-argument", "share content is empty");
  if (options.allowBinary !== true) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { throw new SharePublishError("invalid-argument", "Markdown input must be valid UTF-8"); }
  }
  const nowMs = options.now?.() ?? Date.now();
  const expiresAt = options.expiresAt ?? new Date(nowMs + DEFAULT_SHARE_LIFETIME_MS);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) throw new SharePublishError("invalid-argument", "expiresAt must be a valid future time");
  const expiry = expiresAt.toISOString();
  const nodeAudience = options.nodeAudience ?? "did:web:node.tinycloud.xyz";
  const spaceId = options.spaceId ?? "bearer";
  const shareId = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const path = `shares/${shareId}/${options.filename}`;
  const sessionPrivateKey = ed25519.utils.randomPrivateKey();
  const senderPrivateKey = ed25519.utils.randomPrivateKey();
  let contentKey: Uint8Array | undefined;
  let envelopeKey: Uint8Array | undefined;
  try {
    const sessionPublicKey = ed25519.getPublicKey(sessionPrivateKey);
    const sessionDid = didKeyFromEd25519PublicKey(sessionPublicKey);
    const delegation = mintBearerDelegation({
      issuerPrivateKey: senderPrivateKey,
      audienceDid: sessionDid,
      resourceUri: bearerResourceUri(options.origin, spaceId, path),
      expiresAtSeconds: Math.ceil(expiresAt.getTime() / 1000),
    });
    contentKey = generateKey();
    const sealedContent = await seal(content, contentKey);
    const unsigned: UnsignedShareEnvelope = {
      version: 1,
      shareId,
      delegation,
      authorizationTarget: {
        kind: "bearerKey",
        sessionJwk: { kty: "OKP", crv: "Ed25519", x: toBase64Url(sessionPublicKey), d: toBase64Url(sessionPrivateKey) },
      },
      target: { origin: options.origin, nodeAudience, spaceId, resource: { kind: "exact", path } },
      display: { filename: options.filename },
      expiry,
      content: { cid: sealedContent.cid, key: toBase64Url(contentKey) },
    };
    const envelope = signEnvelope(unsigned, senderPrivateKey);
    envelopeKey = generateKey();
    const sealedEnvelope = await seal(new TextEncoder().encode(canonicalize(envelope)), envelopeKey);
    let inlineUrl: string | undefined;
    if (options.inline === true) {
      try { inlineUrl = await encodeInlineShareUrl({ origin: options.origin, ciphertext: sealedEnvelope.blob, key32: envelopeKey }); }
      catch (error) { throw new SharePublishError("inline-too-large", error instanceof Error ? error.message : "inline share is too large"); }
    }
    const contentUpload = await upload(options, { blob: sealedContent.blob, cid: sealedContent.cid, deleteAfter: expiry, contentLength: sealedContent.blob.byteLength });
    let url: string;
    let kind: "compact" | "inline";
    let retention = contentUpload.deleteAfter;
    if (options.inline === true) {
      if (inlineUrl === undefined) throw new SharePublishError("inline-too-large", "inline share is too large");
      url = inlineUrl;
      kind = "inline";
    } else {
      const envelopeUpload = await upload(options, { blob: sealedEnvelope.blob, cid: sealedEnvelope.cid, deleteAfter: expiry, contentLength: sealedEnvelope.blob.byteLength });
      url = encodeShareUrl({ origin: options.origin, ciphertextCid: envelopeUpload.cid, key32: envelopeKey });
      kind = "compact";
      retention = envelopeUpload.deleteAfter;
    }
    const metadata: PublishedShareMetadata = {
      protocol: "tinycloud-share", version: 1, shareId, origin: options.origin,
      target: { origin: options.origin, nodeAudience, spaceId },
      resource: { kind: "exact", path }, actions: ["read"], expiresAt: expiry,
      display: { filename: options.filename }, content: { cid: sealedContent.cid },
    };
    const result = { protocol: "tinycloud-share", version: SHARE_PUBLISH_RESULT_VERSION, link: { kind, cid: sealedEnvelope.cid }, metadata, registryDeleteAfter: retention } as PublishedShare;
    Object.defineProperty(result, "toJSON", {
      enumerable: false,
      value: () => redactPublishedShare(result),
    });
    Object.defineProperty(result, "url", { enumerable: false, value: url });
    return result;
  } finally {
    sessionPrivateKey.fill(0);
    senderPrivateKey.fill(0);
    contentKey?.fill(0);
    envelopeKey?.fill(0);
  }
}
