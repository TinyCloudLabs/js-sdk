import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, didKeyFromEd25519PublicKey, fromBase64Url, toBase64Url } from "@tinycloud/share-envelope";
import { createLink, isLinkError, linkIssuerPublicKey, resolveLink, verifyEd25519Strict, type LinkSigner, type LinkTransportOptions } from "@tinycloud/share-envelope/links";

/**
 * Short links for TinyCloud's own shares (TC-3194): `https://<app>/s/<id>#v=4&k=…&c=…`, a links-API record of
 * type `share` whose sealed body carries a SharingService `tc1:` token (the per-share key and its root
 * delegation) and the display fields the app shows before sign-in. The node enforces access; this module only
 * moves the token. The record's issuer is a throwaway key, dropped after publishing (best effort: the runtime
 * may keep copies until garbage collection), so nobody can delete the record early: it lives until `expiresAt`
 * (at most 30 days), and stopping a share revokes the root delegation instead.
 *
 * The display fields are whatever the link's maker wrote: the owner does not sign them, and anyone holding a
 * token can publish it again under other display fields. The body's own signature is by the throwaway issuer
 * (the links reader requires a `share` body to name its issuer), so it proves nothing about the owner. Check the
 * token with sdk-core `inspectShareToken` before showing who shared it, and show display fields as untrusted text.
 */

/** Body format tag, and the domain separator the issuer's body signature covers. */
export const NATIVE_SHARE_LINK_FORMAT = "tinycloud.native-share/v1";
const SIGNATURE_DOMAIN = `${NATIVE_SHARE_LINK_FORMAT}\0`;
/** Most bytes the display object may take as canonical JSON. */
export const NATIVE_SHARE_DISPLAY_MAX_BYTES = 8 * 1024;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const TOKEN_PREFIX = "tc1:";
const BODY_KEYS = ["display", "format", "kind", "share", "signature"];
const SIGNATURE_KEYS = ["algorithm", "signerDid", "value"];

export type NativeShareLinkErrorCode =
  /** The link names no record: unknown, expired, or deleted. */
  | "gone"
  /** The record's window has ended. */
  | "expired"
  /** The link or its body is malformed, tampered with, or on an untrusted origin. */
  | "invalid"
  /** The links service could not be reached or refused for a reason of its own. */
  | "unavailable";

export class NativeShareLinkError extends Error {
  readonly code: NativeShareLinkErrorCode;
  constructor(code: NativeShareLinkErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NativeShareLinkError";
    this.code = code;
  }
}

export interface PublishNativeShareLinkInput extends LinkTransportOptions {
  /** The `tc1:` token from `SharingService.generate`. A bearer secret: it reaches only the sealed body. */
  readonly token: string;
  /** What is shared, e.g. `recording`. Lowercase letters, digits and `-`. */
  readonly kind: string;
  /** App-defined display fields (title, …), shown before sign-in. JSON only, and not signed by the owner. */
  readonly display: Readonly<Record<string, unknown>>;
  /** Origin the link points at, e.g. `https://tinycloud.one`. */
  readonly linkOrigin: string;
  /** Links API origin (https). */
  readonly apiOrigin: string;
  /** When the link stops opening. The links API allows at most 30 days. */
  readonly expiresAt: Date;
  readonly now?: Date | number;
}

export interface PublishedNativeShareLink {
  /** The short link. It carries the content key in its fragment: hand it out, never log or store it. */
  readonly link: string;
  readonly id: string;
  readonly expiresAt: string;
}

export interface OpenNativeShareLinkInput extends LinkTransportOptions {
  /** Link origins this reader accepts. */
  readonly trustedOrigins: readonly string[];
  /** Links API origin (https), from configuration: a link never names it. */
  readonly apiOrigin: string;
  readonly now?: Date | number;
}

export interface OpenedNativeShareLink {
  readonly kind: string;
  /** As the link's maker wrote it: not signed by the owner. Show it as untrusted text. */
  readonly display: Readonly<Record<string, unknown>>;
  /**
   * The `tc1:` token: a bearer secret. Keep it in memory. Check it with sdk-core `inspectShareToken` for the
   * owner and the access end, then pass it to `SharingService.delegateReceivedShare`.
   */
  readonly token: string;
  readonly linkExpiresAt: Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const names = Object.keys(value).sort();
  return names.length === keys.length && names.every((name, index) => name === keys[index]);
}

function signingBytes(unsigned: Readonly<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(SIGNATURE_DOMAIN + canonicalize(unsigned));
}

/** Whether `token` has the shape of a `tc1:` share token. Its signatures are checked by `inspectShareToken`. */
function isShareToken(token: string): boolean {
  if (!token.startsWith(TOKEN_PREFIX)) return false;
  try {
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(token.slice(TOKEN_PREFIX.length))));
    return isPlainObject(data) && typeof data.spaceId === "string";
  } catch {
    return false;
  }
}

/** A link signer over `seed` itself (no copy), so zeroing `seed` afterwards drops the key this module holds. */
function signerOverSeed(seed: Uint8Array): LinkSigner {
  return { did: didKeyFromEd25519PublicKey(ed25519.getPublicKey(seed)), sign: (digest) => ed25519.sign(digest, seed) };
}

function checkKind(kind: unknown): asserts kind is string {
  if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) throw new NativeShareLinkError("invalid", "share kind is not a lowercase name");
}

function checkDisplay(display: unknown): asserts display is Record<string, unknown> {
  if (!isPlainObject(display)) throw new NativeShareLinkError("invalid", "display must be a JSON object");
  let text: string;
  try {
    text = canonicalize(display);
  } catch (cause) {
    throw new NativeShareLinkError("invalid", "display must be plain JSON", { cause });
  }
  if (new TextEncoder().encode(text).length > NATIVE_SHARE_DISPLAY_MAX_BYTES) throw new NativeShareLinkError("invalid", "display is too large");
}

/**
 * Seal the token and display fields into a links-API `share` record and return the short link. The request
 * carries only the signed header and the sealed body; the content key appears only in the returned link.
 */
export async function publishNativeShareLink(input: PublishNativeShareLinkInput): Promise<PublishedNativeShareLink> {
  checkKind(input.kind);
  checkDisplay(input.display);
  if (!isShareToken(input.token)) throw new NativeShareLinkError("invalid", "token is not a TinyCloud share token");
  const seed = ed25519.utils.randomPrivateKey();
  try {
    const issuerKey = signerOverSeed(seed);
    const unsigned = { format: NATIVE_SHARE_LINK_FORMAT, kind: input.kind, share: input.token, display: input.display };
    const body = {
      ...unsigned,
      signature: { signerDid: issuerKey.did, algorithm: "Ed25519", value: toBase64Url(ed25519.sign(signingBytes(unsigned), seed)) },
    };
    try {
      const created = await createLink({
        type: "share",
        plaintext: new TextEncoder().encode(canonicalize(body)),
        issuerKey,
        apiOrigin: input.apiOrigin,
        linkOrigin: input.linkOrigin,
        expiresAt: input.expiresAt,
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return { link: created.link, id: created.id, expiresAt: created.expiresAt };
    } catch (cause) {
      throw toNativeShareLinkError(cause);
    }
  } finally {
    seed.fill(0);
  }
}

/** Check the opened body: exact fields, the record issuer's signature over it, a share token and display. */
function parseBody(value: Record<string, unknown>, issuer: string): Omit<OpenedNativeShareLink, "linkExpiresAt"> {
  if (!hasExactKeys(value, BODY_KEYS) || value.format !== NATIVE_SHARE_LINK_FORMAT) throw new NativeShareLinkError("invalid", "not a TinyCloud share link");
  const signature = value.signature;
  if (!isPlainObject(signature) || !hasExactKeys(signature, SIGNATURE_KEYS) || signature.algorithm !== "Ed25519" || signature.signerDid !== issuer || typeof signature.value !== "string") {
    throw new NativeShareLinkError("invalid", "share link signature is malformed");
  }
  const { signature: _signature, ...unsigned } = value;
  const publicKey = linkIssuerPublicKey(issuer);
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64Url(signature.value);
  } catch {
    throw new NativeShareLinkError("invalid", "share link signature is malformed");
  }
  if (publicKey === null || toBase64Url(signatureBytes) !== signature.value || !verifyEd25519Strict(publicKey, signingBytes(unsigned), signatureBytes)) {
    throw new NativeShareLinkError("invalid", "share link signature is invalid");
  }
  checkKind(value.kind);
  checkDisplay(value.display);
  if (typeof value.share !== "string" || !isShareToken(value.share)) throw new NativeShareLinkError("invalid", "share link carries no TinyCloud share token");
  return { kind: value.kind, display: value.display, token: value.share };
}

/**
 * Fetch, check and open a short share link with the links module's reader pipeline, then check the body. A full
 * link (the whole record in the fragment) is refused: only a short link has a record the links API expires.
 * Nothing is read from the owner's node.
 */
export async function openNativeShareLink(link: string, input: OpenNativeShareLinkInput): Promise<OpenedNativeShareLink> {
  let resolved;
  try {
    resolved = await resolveLink(link, {
      trustedOrigins: input.trustedOrigins,
      apiOrigin: input.apiOrigin,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (cause) {
    throw toNativeShareLinkError(cause);
  }
  if (resolved.type !== "share") throw new NativeShareLinkError("invalid", "not a share link");
  if (resolved.form !== "short") throw new NativeShareLinkError("invalid", "not a short share link");
  return { ...parseBody(resolved.value, resolved.header.issuer), linkExpiresAt: new Date(resolved.header.expiresAt) };
}

function toNativeShareLinkError(cause: unknown): NativeShareLinkError {
  if (cause instanceof NativeShareLinkError) return cause;
  if (isLinkError(cause)) {
    if (cause.code === "gone") return new NativeShareLinkError("gone", "the link is unknown, expired or deleted", { cause });
    if (cause.code === "expired" || cause.code === "already_expired") return new NativeShareLinkError("expired", "the link has expired", { cause });
    if (cause.code === "service_unavailable" || cause.code === "service_refused" || cause.code === "invalid_response" || cause.code === "response_too_large") {
      return new NativeShareLinkError("unavailable", "the links service could not complete the request", { cause });
    }
    if (cause.code === "invalid_argument" || cause.code === "life_too_long" || cause.code === "life_too_short") {
      return new NativeShareLinkError("invalid", cause.message, { cause });
    }
  }
  return new NativeShareLinkError("invalid", "the share link is not valid", { cause });
}
