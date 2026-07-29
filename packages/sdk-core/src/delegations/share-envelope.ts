import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { sha256 } from "@noble/hashes/sha256";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import * as raw from "multiformats/codecs/raw";
import { sha256 as sha256Cid } from "multiformats/hashes/sha2";
import { base58btc } from "multiformats/bases/base58";

const ENVELOPE_SCHEMA = "xyz.tinycloud.share/envelope" as const;
const INLINE_PREFIX = "tc2:";
const RAW_CID_CODEC = 0x55;
const BLAKE3_256_CODE = 0x1e;
const DEFAULT_MAX_INLINE_BYTES = 256 * 1024;
export const MAX_SHARE_CONTENT_BYTES = 100 * 1024 * 1024;
/** AES-GCM plus the published version byte, IV, and authentication tag. */
export const MAX_SEALED_SHARE_CONTENT_BYTES = MAX_SHARE_CONTENT_BYTES + 29;
/** Canonical JSON is independently bounded from plaintext and sealed bytes. */
export const MAX_SHARE_ARTIFACT_BYTES =
  Math.ceil((MAX_SEALED_SHARE_CONTENT_BYTES * 4) / 3) + 2 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = MAX_SHARE_ARTIFACT_BYTES;

export type ShareRecipientTarget =
  | { readonly kind: "exactEmail"; readonly value: string }
  | { readonly kind: "emailDomain"; readonly value: string }
  | { readonly kind: "recipientDid"; readonly value: string }
  | { readonly kind: "bearer" };

export type ShareResource =
  | { readonly kind: "exact"; readonly path: string }
  | { readonly kind: "prefix"; readonly path: string };

export type ShareAction = "read" | "list" | "edit";

export interface SharePolicy {
  readonly matcher: ShareRecipientTarget;
  readonly spaceId: string;
  readonly resource: ShareResource;
  readonly actions: readonly ShareAction[];
  readonly expiresAt: string;
}

export interface ShareContentMetadata {
  readonly mimeType: string;
  readonly size: number;
  readonly digest: string;
  readonly charset?: "utf-8";
}

export interface ShareEnvelopeV2 {
  readonly schema: typeof ENVELOPE_SCHEMA;
  readonly version: 2;
  readonly origin: string;
  readonly spaceId: string;
  readonly recipient?: ShareRecipientTarget;
  /** Public routing discriminator. Matcher values are never serialized here. */
  readonly recipientKind?: ShareRecipientTarget["kind"];
  readonly resource: ShareResource;
  readonly actions: readonly ShareAction[];
  readonly content: ShareContentMetadata;
  readonly encrypted: boolean;
  readonly expiresAt: string;
  readonly signer: { readonly did: string; readonly publicKey: string };
  readonly signature: string;
  /** Internal marker for the published Share-v2 adapter; never serialized by legacy artifacts. */
  readonly authorizationTargetKind?: string;
}

export interface ShareArtifactV2 {
  readonly envelope: ShareEnvelopeV2;
  /** Canonical base64url bytes. For an encrypted artifact these are ciphertext. */
  readonly content: string;
}

export interface ShareLinkLocation {
  readonly kind: "compact" | "inline";
  readonly origin: string;
  readonly cid?: string;
  readonly key?: Uint8Array;
  readonly artifact?: ShareArtifactV2;
  readonly url: string;
  /** Canonical Share envelope links use the published SHA-256/sealed-blob wire format. */
  readonly protocol?: "legacy" | "share-envelope-v2";
}

export interface VerifyShareEnvelopeOptions {
  readonly now?: Date;
  readonly expectedOrigin?: string;
  readonly expectedCid?: string;
  readonly maxArtifactBytes?: number;
  readonly maxContentBytes?: number;
  readonly maxSealedContentBytes?: number;
  /** Trusted signer DIDs for addressed policy artifacts. */
  readonly trustedSignerDids?: readonly string[];
}

export interface ShareArtifactInput {
  readonly origin: string;
  readonly spaceId: string;
  readonly recipient?: ShareRecipientTarget;
  readonly resource: ShareResource;
  readonly actions: readonly ShareAction[];
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly expiresAt: Date;
  readonly signerDid: string;
  readonly signerPrivateKey: Uint8Array;
  readonly encryptionKey?: Uint8Array;
  readonly maxContentBytes?: number;
  /** Required acknowledgement for the intentionally content-free policy-only plaintext form. */
  readonly plaintextPolicyOnly?: boolean;
  readonly plaintextWarningAcknowledged?: boolean;
}

export interface ShareArtifactResult {
  readonly artifact: ShareArtifactV2;
  readonly bytes: Uint8Array;
  readonly cid: string;
  readonly key?: Uint8Array;
}

export class ShareEnvelopeError extends Error {
  readonly code:
    | "invalid-link"
    | "invalid-envelope"
    | "expired"
    | "signature-invalid"
    | "cid-mismatch"
    | "origin-mismatch"
    | "content-too-large"
    | "encryption-required"
    | "unsafe-plaintext";

  constructor(code: ShareEnvelopeError["code"], message: string) {
    super(message);
    this.name = "ShareEnvelopeError";
    this.code = code;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(bytes).toString("base64");
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new ShareEnvelopeError("invalid-link", "non-canonical base64url");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const decoded = typeof atob === "function"
    ? (() => {
        const binary = atob(padded);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
      })()
    : new Uint8Array(Buffer.from(padded, "base64"));
  if (bytesToBase64Url(decoded) !== value) throw new ShareEnvelopeError("invalid-link", "non-canonical base64url");
  return decoded;
}

function assertKeys(value: object, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) if (!permitted.has(key)) throw new ShareEnvelopeError("invalid-envelope", `${label} contains an unknown field`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ShareEnvelopeError("invalid-envelope", "non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new ShareEnvelopeError("invalid-envelope", "unsupported JSON value");
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (/\s/.test(text[index] ?? "")) index += 1;
  return index;
}

function scanJsonValue(text: string, start: number): number {
  let index = skipWhitespace(text, start);
  const first = text[index];
  if (first === '"') {
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"') return index;
    }
    throw new ShareEnvelopeError("invalid-envelope", "unterminated JSON string");
  }
  if (first === "{") {
    const keys = new Set<string>();
    index = skipWhitespace(text, index + 1);
    if (text[index] === "}") return index + 1;
    while (index < text.length) {
      index = skipWhitespace(text, index);
      if (text[index] !== '"') throw new ShareEnvelopeError("invalid-envelope", "object key must be a string");
      const keyStart = index;
      index = scanJsonValue(text, index);
      const key = JSON.parse(text.slice(keyStart, index)) as string;
      if (keys.has(key)) throw new ShareEnvelopeError("invalid-envelope", `duplicate JSON key ${key}`);
      keys.add(key);
      index = skipWhitespace(text, index);
      if (text[index++] !== ":") throw new ShareEnvelopeError("invalid-envelope", "missing object colon");
      index = scanJsonValue(text, index);
      index = skipWhitespace(text, index);
      if (text[index] === "}") return index + 1;
      if (text[index++] !== ",") throw new ShareEnvelopeError("invalid-envelope", "invalid object separator");
    }
    throw new ShareEnvelopeError("invalid-envelope", "unterminated JSON object");
  }
  if (first === "[") {
    index = skipWhitespace(text, index + 1);
    if (text[index] === "]") return index + 1;
    while (index < text.length) {
      index = scanJsonValue(text, index);
      index = skipWhitespace(text, index);
      if (text[index] === "]") return index + 1;
      if (text[index++] !== ",") throw new ShareEnvelopeError("invalid-envelope", "invalid array separator");
    }
    throw new ShareEnvelopeError("invalid-envelope", "unterminated JSON array");
  }
  const match = text.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  if (!match) throw new ShareEnvelopeError("invalid-envelope", "invalid JSON value");
  return index + match[0].length;
}

function parseCanonicalJson(text: string): unknown {
  try {
    const end = scanJsonValue(text, 0);
    if (skipWhitespace(text, end) !== text.length) throw new Error("trailing JSON");
    const parsed = JSON.parse(text) as unknown;
    if (canonicalJson(parsed) !== text) throw new Error("non-canonical JSON");
    return parsed;
  } catch (error) {
    if (error instanceof ShareEnvelopeError) throw error;
    throw new ShareEnvelopeError("invalid-envelope", error instanceof Error ? error.message : "invalid JSON");
  }
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("origin must be a credential-free URL");
    }
    return url.origin;
  } catch {
    throw new ShareEnvelopeError("invalid-envelope", "invalid trusted origin");
  }
}

function normalizeResource(resource: ShareResource): ShareResource {
  if (resource.kind !== "exact" && resource.kind !== "prefix") throw new ShareEnvelopeError("invalid-envelope", "invalid resource kind");
  if (!resource.path || resource.path.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(resource.path) || /%2f|%5c|%2e/i.test(resource.path) || resource.path.split("/").some((part, index, parts) => part === "." || part === ".." || (part.length === 0 && !(resource.kind === "prefix" && index === parts.length - 1)))) {
    throw new ShareEnvelopeError("invalid-envelope", "resource path is not canonical");
  }
  return { kind: resource.kind, path: resource.kind === "prefix" && !resource.path.endsWith("/") ? `${resource.path}/` : resource.path };
}

function normalizeActions(actions: readonly ShareAction[]): ShareAction[] {
  const allowed = new Set<ShareAction>(["read", "list", "edit"]);
  if (actions.length === 0 || new Set(actions).size !== actions.length || actions.some((action) => !allowed.has(action))) {
    throw new ShareEnvelopeError("invalid-envelope", "actions must be a non-empty canonical set");
  }
  return [...actions].sort((a, b) => a.localeCompare(b));
}

function normalizeRecipient(recipient: ShareRecipientTarget | undefined): ShareRecipientTarget | undefined {
  if (recipient === undefined) return undefined;
  if (recipient.kind === "bearer") return { kind: "bearer" };
  if (typeof recipient.value !== "string" || recipient.value.length === 0 || /[\r\n]/.test(recipient.value)) {
    throw new ShareEnvelopeError("invalid-envelope", "recipient value is invalid");
  }
  if (recipient.kind === "emailDomain") {
    const domain = recipient.value.toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/i.test(domain)) {
      throw new ShareEnvelopeError("invalid-envelope", "recipient domain is invalid");
    }
    return { kind: recipient.kind, value: domain };
  }
  if (recipient.kind === "recipientDid") {
    if (!/^did:[a-z0-9]+:.+$/.test(recipient.value)) throw new ShareEnvelopeError("invalid-envelope", "recipient DID is invalid");
    return { kind: recipient.kind, value: recipient.value };
  }
  // Mailbox matching is case-sensitive in the local part.  Only the DNS
  // portion is normalized, which is the same contract used by the auth and
  // node layers.  Trimming is limited to transport framing; it must never
  // alter characters inside the mailbox.
  const exact = recipient.value.trim();
  const at = exact.lastIndexOf("@");
  const normalizedExact = at > 0 ? `${exact.slice(0, at)}@${exact.slice(at + 1).toLowerCase()}` : exact;
  if (recipient.kind !== "exactEmail" || !/^[^@\s]+@[^@\s]+$/.test(normalizedExact)) {
    throw new ShareEnvelopeError("invalid-envelope", "recipient matcher is invalid");
  }
  return { kind: recipient.kind, value: normalizedExact };
}

export function normalizeShareRecipientTarget(recipient: ShareRecipientTarget): ShareRecipientTarget {
  const normalized = normalizeRecipient(recipient);
  if (normalized === undefined) throw new ShareEnvelopeError("invalid-envelope", "recipient matcher is required");
  return normalized;
}

export function normalizeShareResource(resource: ShareResource): ShareResource {
  return normalizeResource(resource);
}

export function normalizeShareActions(actions: readonly ShareAction[]): ShareAction[] {
  return normalizeActions(actions);
}

function resourceContains(outer: ShareResource, inner: ShareResource): boolean {
  if (outer.kind === "exact") return inner.kind === "exact" && outer.path === inner.path;
  const prefix = outer.path.endsWith("/") ? outer.path : `${outer.path}/`;
  const outerPath = prefix.slice(0, -1);
  if (inner.kind === "exact") return inner.path.startsWith(prefix) || inner.path === outerPath;
  const innerPrefix = inner.path.endsWith("/") ? inner.path : `${inner.path}/`;
  return inner.path === outerPath || innerPrefix.startsWith(prefix);
}

export function createSharePolicy(input: Omit<SharePolicy, "expiresAt"> & { readonly expiresAt: Date }): SharePolicy {
  return {
    matcher: normalizeShareRecipientTarget(input.matcher),
    spaceId: input.spaceId,
    resource: normalizeShareResource(input.resource),
    actions: normalizeShareActions(input.actions),
    expiresAt: input.expiresAt.toISOString(),
  };
}

function contentDigest(bytes: Uint8Array): string {
  return bytesToBase64Url(sha256(bytes));
}

export function computeShareCid(bytes: Uint8Array): string {
  const digest = createDigest(BLAKE3_256_CODE, blake3(bytes));
  return CID.createV1(RAW_CID_CODEC, digest).toString();
}

export function verifyShareCid(cid: string, bytes: Uint8Array): boolean {
  try {
    const parsed = CID.parse(cid);
    if (parsed.toString() !== cid || parsed.multihash.code !== BLAKE3_256_CODE) return false;
    return parsed.equals(CID.createV1(parsed.code, createDigest(parsed.multihash.code, blake3(bytes))));
  } catch {
    return false;
  }
}

function envelopeSigningBytes(envelope: Omit<ShareEnvelopeV2, "signature">): Uint8Array {
  return new TextEncoder().encode(canonicalJson(envelope));
}

export function signShareEnvelope(input: Omit<ShareEnvelopeV2, "signature" | "signer"> & { signerDid: string; signerPrivateKey: Uint8Array }): ShareEnvelopeV2 {
  if (input.signerPrivateKey.length !== 32) throw new ShareEnvelopeError("invalid-envelope", "Ed25519 private key must be 32 bytes");
  const publicKey = ed25519.getPublicKey(input.signerPrivateKey);
  const unsigned = {
    schema: ENVELOPE_SCHEMA,
    version: 2 as const,
    origin: normalizeOrigin(input.origin),
    spaceId: input.spaceId,
    ...(normalizeRecipient(input.recipient)?.kind === "bearer" ? { recipient: { kind: "bearer" as const } } : {}),
    ...(input.recipientKind === undefined && input.recipient === undefined ? {} : { recipientKind: input.recipientKind ?? normalizeRecipient(input.recipient)?.kind }),
    resource: normalizeResource(input.resource),
    actions: normalizeActions(input.actions),
    content: input.content,
    encrypted: input.encrypted,
    expiresAt: new Date(input.expiresAt).toISOString(),
    signer: { did: input.signerDid, publicKey: bytesToBase64Url(publicKey) },
  } satisfies Omit<ShareEnvelopeV2, "signature">;
  return { ...unsigned, signature: bytesToBase64Url(ed25519.sign(envelopeSigningBytes(unsigned), input.signerPrivateKey)) };
}

export function verifyShareEnvelope(envelope: ShareEnvelopeV2, options: VerifyShareEnvelopeOptions = {}): ShareEnvelopeV2 {
  try {
    assertKeys(envelope as object, ["schema", "version", "origin", "spaceId", "recipient", "recipientKind", "resource", "actions", "content", "encrypted", "expiresAt", "signer", "signature"], "share envelope");
    assertKeys(envelope.resource as object, ["kind", "path"], "share resource");
    assertKeys(envelope.content as object, ["mimeType", "size", "digest", "charset"], "share content");
    assertKeys(envelope.signer as object, ["did", "publicKey"], "share signer");
    if (envelope.recipient !== undefined) assertKeys(envelope.recipient as object, envelope.recipient.kind === "bearer" ? ["kind"] : ["kind", "value"], "share recipient");
    if (envelope.schema !== ENVELOPE_SCHEMA || envelope.version !== 2 || typeof envelope.signature !== "string") throw new Error("unsupported envelope");
    if (normalizeOrigin(envelope.origin) !== envelope.origin) throw new Error("origin is not canonical");
    if (options.expectedOrigin !== undefined && normalizeOrigin(options.expectedOrigin) !== envelope.origin) throw new ShareEnvelopeError("origin-mismatch", "envelope origin is not trusted");
    const expiry = Date.parse(envelope.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= (options.now ?? new Date()).getTime()) throw new ShareEnvelopeError("expired", "share envelope has expired");
    if (new Date(expiry).toISOString() !== envelope.expiresAt) throw new ShareEnvelopeError("invalid-envelope", "expiry is not canonical");
    const resource = normalizeResource(envelope.resource);
    if (resource.kind !== envelope.resource.kind || resource.path !== envelope.resource.path) throw new ShareEnvelopeError("invalid-envelope", "resource is not canonical");
    const actions = normalizeActions(envelope.actions);
    if (actions.join("\0") !== envelope.actions.join("\0")) throw new ShareEnvelopeError("invalid-envelope", "actions are not canonical");
    const recipient = normalizeRecipient(envelope.recipient);
    if (recipient !== undefined && JSON.stringify(recipient) !== JSON.stringify(envelope.recipient)) throw new ShareEnvelopeError("invalid-envelope", "recipient is not canonical");
    if (recipient?.kind === "exactEmail" || recipient?.kind === "emailDomain") throw new ShareEnvelopeError("unsafe-plaintext", "recipient matchers are not public envelope fields");
    if (envelope.recipientKind !== undefined && !["exactEmail", "emailDomain", "recipientDid", "bearer"].includes(envelope.recipientKind)) throw new ShareEnvelopeError("invalid-envelope", "recipient mode is invalid");
    if (envelope.recipientKind === "bearer" && recipient?.kind !== undefined && recipient.kind !== "bearer") throw new ShareEnvelopeError("invalid-envelope", "recipient mode does not match recipient");
    if ((envelope.recipientKind === "exactEmail" || envelope.recipientKind === "emailDomain" || envelope.recipientKind === "recipientDid") && !envelope.encrypted) throw new ShareEnvelopeError("unsafe-plaintext", "addressed shares require encryption");
    if (typeof envelope.spaceId !== "string" || envelope.spaceId.length === 0 || typeof envelope.content.mimeType !== "string" || envelope.content.mimeType.length === 0 || typeof envelope.content.digest !== "string" || !/^[A-Za-z0-9_-]+$/.test(envelope.content.digest)) throw new ShareEnvelopeError("invalid-envelope", "content metadata is invalid");
    const maxContentBytes = envelope.encrypted
      ? options.maxSealedContentBytes ?? MAX_SEALED_SHARE_CONTENT_BYTES
      : options.maxContentBytes ?? MAX_SHARE_CONTENT_BYTES;
    if (!Number.isInteger(envelope.content.size) || envelope.content.size < 0 || envelope.content.size > maxContentBytes) throw new ShareEnvelopeError("content-too-large", "share content exceeds the configured limit");
    const publicKey = base64UrlToBytes(envelope.signer.publicKey);
    const signature = base64UrlToBytes(envelope.signature);
    const unsigned = { ...envelope } as Omit<ShareEnvelopeV2, "signature">;
    delete (unsigned as { signature?: string }).signature;
    if (publicKey.length !== 32 || signature.length !== 64 || !ed25519.verify(signature, envelopeSigningBytes(unsigned), publicKey)) throw new ShareEnvelopeError("signature-invalid", "share envelope signature is invalid");
    if (options.trustedSignerDids !== undefined && envelope.recipientKind !== undefined && !options.trustedSignerDids.includes(envelope.signer.did)) throw new ShareEnvelopeError("signature-invalid", "share signer is not trusted");
    return envelope;
  } catch (error) {
    if (error instanceof ShareEnvelopeError) throw error;
    throw new ShareEnvelopeError("invalid-envelope", error instanceof Error ? error.message : "invalid envelope");
  }
}

export function encodeShareArtifact(artifact: ShareArtifactV2): Uint8Array {
  const normalized = parseShareArtifact(new TextEncoder().encode(canonicalJson(artifact)), { verify: false });
  return new TextEncoder().encode(canonicalJson(normalized));
}

export function parseShareArtifact(bytes: Uint8Array, options: VerifyShareEnvelopeOptions & { readonly verify?: boolean } = {}): ShareArtifactV2 {
  if (bytes.byteLength > (options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES)) throw new ShareEnvelopeError("content-too-large", "share artifact exceeds the configured limit");
  const parsed = parseCanonicalJson(new TextDecoder().decode(bytes));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ShareEnvelopeError("invalid-envelope", "share artifact must be an object");
  const artifact = parsed as ShareArtifactV2;
  if (!artifact.envelope || typeof artifact.content !== "string" || !/^[A-Za-z0-9_-]*$/.test(artifact.content)) throw new ShareEnvelopeError("invalid-envelope", "share artifact shape is invalid");
  assertKeys(artifact as object, ["envelope", "content"], "share artifact");
  if (options.verify !== false) verifyShareEnvelope(artifact.envelope, options);
  const bytesValue = base64UrlToBytes(artifact.content);
  if (bytesValue.byteLength !== artifact.envelope.content.size || contentDigest(bytesValue) !== artifact.envelope.content.digest) throw new ShareEnvelopeError("invalid-envelope", "share content digest does not match envelope");
  if (artifact.envelope.encrypted && bytesValue.byteLength < 16) throw new ShareEnvelopeError("invalid-envelope", "encrypted share content is too short");
  if (!artifact.envelope.encrypted && artifact.envelope.recipient !== undefined) {
    throw new ShareEnvelopeError("unsafe-plaintext", "recipient PII cannot be placed in an unencrypted envelope");
  }
  return artifact;
}

export function encodeShareUrl(input: { readonly origin: string; readonly cid: string; readonly key?: Uint8Array }): string {
  const origin = normalizeOrigin(input.origin);
  try {
    if (CID.parse(input.cid).toString() !== input.cid) throw new Error("non-canonical CID");
  } catch {
    throw new ShareEnvelopeError("invalid-link", "CID is not canonical");
  }
  if (input.key !== undefined && input.key.length !== 32) throw new ShareEnvelopeError("invalid-link", "fragment key must be 32 bytes");
  return `${origin}/s/${input.cid}${input.key === undefined ? "" : `#k=${bytesToBase64Url(input.key)}`}`;
}

export function encodeInlineShareUrl(input: { readonly origin: string; readonly artifact: ShareArtifactV2; readonly key?: Uint8Array; readonly maxInlineBytes?: number }): string {
  const bytes = encodeShareArtifact(input.artifact);
  const encoded = bytesToBase64Url(bytes);
  if (bytes.byteLength > (input.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES)) throw new ShareEnvelopeError("content-too-large", "inline share exceeds the configured limit");
  if (input.artifact.envelope.encrypted && (input.key === undefined || input.key.length !== 32)) throw new ShareEnvelopeError("encryption-required", "encrypted inline shares require a 32-byte fragment key");
  if (!input.artifact.envelope.encrypted && input.key !== undefined) throw new ShareEnvelopeError("unsafe-plaintext", "plaintext shares cannot carry a fragment key");
  return `${normalizeOrigin(input.origin)}/s/i/${encoded}${input.key === undefined ? "" : `#k=${bytesToBase64Url(input.key)}`}`;
}

/** The published Share package's v2 envelope, kept local so the SDK has no runtime dependency on the Share app. */
export interface PublishedShareEnvelopeV2 {
  /** The published envelope wire format is v1; the SDK's normalized artifact is v2. */
  readonly version: 1;
  readonly shareId: string;
  readonly delegation: string;
  readonly authorizationTarget:
    | { readonly kind: "policy"; readonly policyCid: string; readonly policyBytes: string }
    | { readonly kind: "bearerKey"; readonly sessionJwk: Record<string, unknown> }
    | { readonly kind: "recipientDid"; readonly did: string };
  readonly target: { readonly origin: string; readonly nodeAudience: string; readonly spaceId: string; readonly resource: ShareResource };
  readonly display: { readonly senderName?: string; readonly filename?: string; readonly recipientHint?: string; readonly mode?: "document" | "source" | "folder" };
  readonly expiry: string;
  readonly content?: { readonly cid: string; readonly key: string };
  readonly signature: { readonly signerDid: string; readonly algorithm: "Ed25519"; readonly value: string };
}

const PUBLISHED_AAD = new TextEncoder().encode("tinycloud-share-envelope-v1");

function publishedCid(bytes: Uint8Array): string {
  return CID.create(1, raw.code, createDigest(sha256Cid.code, sha256(bytes))).toString();
}

function isPublishedCid(value: string): boolean {
  try {
    const parsed = CID.parse(value);
    return parsed.version === 1 && parsed.code === raw.code && parsed.multihash.code === sha256Cid.code && parsed.toString() === value;
  } catch {
    return false;
  }
}

function publishedPublicKey(did: string): Uint8Array {
  const value = did.slice("did:key:".length);
  const encoded = base58btc.decode(value);
  if (encoded.length !== 34 || encoded[0] !== 0xed || encoded[1] !== 0x01) throw new ShareEnvelopeError("invalid-envelope", "published signer is not Ed25519");
  return encoded.slice(2);
}

function publishedEnvelopeSigningBytes(envelope: PublishedShareEnvelopeV2): Uint8Array {
  const { signature: _signature, ...unsigned } = envelope;
  const domain = new TextEncoder().encode("xyz.tinycloud.share/envelope/v2\0");
  const body = new TextEncoder().encode(canonicalJson(unsigned));
  const result = new Uint8Array(domain.length + body.length);
  result.set(domain);
  result.set(body, domain.length);
  return result;
}

interface PublishedPolicyMetadata {
  readonly recipientKind: "exactEmail" | "emailDomain";
  readonly actions: readonly ShareAction[];
  readonly resource: ShareResource;
}

function publishedArtifact(envelope: PublishedShareEnvelopeV2, plaintext: Uint8Array, policy?: PublishedPolicyMetadata): ShareArtifactV2 {
  const content = bytesToBase64Url(plaintext);
  const signerKey = publishedPublicKey(envelope.signature.signerDid);
  return {
    envelope: {
      schema: ENVELOPE_SCHEMA,
      version: 2,
      origin: envelope.target.origin,
      spaceId: envelope.target.spaceId,
      ...(policy === undefined ? { recipientKind: envelope.authorizationTarget.kind === "bearerKey" ? "bearer" as const : envelope.authorizationTarget.kind === "recipientDid" ? "bearer" as const : undefined } : { recipientKind: policy.recipientKind }),
      resource: policy?.resource ?? envelope.target.resource,
      actions: [...(policy?.actions ?? ["read"])],
      content: {
        mimeType: "application/octet-stream",
        size: plaintext.byteLength,
        digest: bytesToBase64Url(sha256(plaintext)),
      },
      // Addressed policy metadata is confidential even though this function
      // is called after the outer envelope has been opened. Keep the
      // normalized artifact marked encrypted so generic envelope validation
      // cannot mistake it for a public plaintext grant.
      encrypted: envelope.authorizationTarget.kind !== "bearerKey",
      expiresAt: envelope.expiry,
      signer: { did: envelope.signature.signerDid, publicKey: bytesToBase64Url(signerKey) },
      signature: envelope.signature.value,
      authorizationTargetKind: envelope.authorizationTarget.kind,
    },
    content,
  };
}

export function verifyPublishedShareCid(cid: string, bytes: Uint8Array): boolean {
  try {
    const parsed = CID.parse(cid);
    return parsed.version === 1 && parsed.code === raw.code && parsed.multihash.code === sha256Cid.code && parsed.toString() === cid && publishedCid(bytes) === cid;
  } catch {
    return false;
  }
}

export async function openPublishedShareBlob(blob: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (key.length !== 32 || blob.length < 29 || blob[0] !== 1) throw new ShareEnvelopeError("invalid-link", "published sealed blob is invalid");
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key as unknown as ArrayBuffer, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(1, 13) as unknown as ArrayBuffer, additionalData: PUBLISHED_AAD as unknown as ArrayBuffer }, cryptoKey, blob.slice(13) as unknown as ArrayBuffer));
  } catch (error) {
    throw new ShareEnvelopeError("signature-invalid", error instanceof Error ? error.message : "published envelope decryption failed");
  }
}

function parsePolicyMetadata(policyBytes: string, target: PublishedShareEnvelopeV2["target"], expectedExpiry: string): PublishedPolicyMetadata {
  const raw = base64UrlToBytes(policyBytes);
  const value = parseCanonicalJson(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShareEnvelopeError("invalid-envelope", "policy material is not an object");
  const policy = value as Record<string, unknown>;
  const version = policy.version;
  if (policy.type !== "TinyCloudSharePolicy" || (version !== 1 && version !== 2)) throw new ShareEnvelopeError("invalid-envelope", "policy material has an unsupported schema");
  if (version === 2 && policy.target !== undefined) {
    assertKeys(policy, ["type", "version", "issuerDid", "recipientMatcher", "target", "delegation", "authority", "actions", "resource", "content-source", "expiresAt"], "published canonical policy material");
    if (typeof policy.issuerDid !== "string" || typeof policy.expiresAt !== "string" || policy.expiresAt !== expectedExpiry) throw new ShareEnvelopeError("invalid-envelope", "policy expiry is not bound to the envelope");
    const matcherValue = policy.recipientMatcher;
    if (!isPlainObject(matcherValue) || (matcherValue.kind !== "exactEmail" && matcherValue.kind !== "emailDomain") || typeof matcherValue.value !== "string") throw new ShareEnvelopeError("invalid-envelope", "policy matcher is invalid");
    const matcher = normalizeRecipient(matcherValue as ShareRecipientTarget);
    if (matcher === undefined || matcher.kind === "bearer") throw new ShareEnvelopeError("invalid-envelope", "policy matcher is invalid");
    if (!isPlainObject(policy.target)) throw new ShareEnvelopeError("invalid-envelope", "policy target is invalid");
    assertKeys(policy.target, ["origin", "nodeAudience", "spaceId"], "published policy target");
    if (policy.target.origin !== target.origin || policy.target.spaceId !== target.spaceId || policy.target.nodeAudience !== target.nodeAudience) throw new ShareEnvelopeError("invalid-envelope", "policy target is not bound to the envelope");
    if (!(typeof policy.delegation === "string" || isPlainObject(policy.delegation)) || !(typeof policy.authority === "string" || isPlainObject(policy.authority))) throw new ShareEnvelopeError("invalid-envelope", "policy authority material is invalid");
    if (!Array.isArray(policy.actions)) throw new ShareEnvelopeError("invalid-envelope", "policy actions are invalid");
    const actions = normalizeActions(policy.actions as ShareAction[]);
    if (!isPlainObject(policy.resource) || (policy.resource.kind !== "exact" && policy.resource.kind !== "prefix") || typeof policy.resource.value !== "string") throw new ShareEnvelopeError("invalid-envelope", "policy resource is invalid");
    const resource = normalizeResource({ kind: policy.resource.kind, path: policy.resource.value });
    if (!resourceContains(resource, target.resource)) throw new ShareEnvelopeError("invalid-envelope", "policy resource is not bound to the envelope");
    if (!isPlainObject(policy["content-source"])) throw new ShareEnvelopeError("invalid-envelope", "policy content source is missing");
    const source = policy["content-source"] as Record<string, unknown>;
    assertKeys(source, ["kind", "space", "path", "action", "database", "statement", "arguments", "argumentsDigest", "digest"], "published canonical content source");
    if (source.kind !== "kv" && source.kind !== "sql") throw new ShareEnvelopeError("invalid-envelope", "policy content source kind is invalid");
    if (typeof source.space !== "string" || typeof source.path !== "string" || typeof source.action !== "string") throw new ShareEnvelopeError("invalid-envelope", "policy content source is invalid");
    if (source.kind === "sql" && (typeof source.database !== "string" || typeof source.statement !== "string" || !isPlainObject(source.arguments) || typeof source.argumentsDigest !== "string")) throw new ShareEnvelopeError("invalid-envelope", "policy SQL content source is invalid");
    if (matcher.kind !== "exactEmail" && matcher.kind !== "emailDomain") throw new ShareEnvelopeError("invalid-envelope", "policy matcher is invalid");
    return { recipientKind: matcher.kind, actions, resource };
  }
  const allowed = version === 1
    ? ["type", "version", "issuerDid", "recipientEmail", "expiresAt", "action", "resource", "contentSource", "contentSourceDigest"]
    : ["type", "version", "issuerDid", "recipientMatcher", "expiresAt", "actions", "resource", "content-source", "contentSourceDigest"];
  assertKeys(policy, allowed, "published policy material");
  if (typeof policy.issuerDid !== "string" || typeof policy.expiresAt !== "string" || policy.expiresAt !== expectedExpiry) throw new ShareEnvelopeError("invalid-envelope", "policy expiry is not bound to the envelope");
  const matcher = policy.recipientMatcher;
  let recipientKind: "exactEmail" | "emailDomain";
  if (version === 1) {
    if (typeof policy.recipientEmail !== "string") throw new ShareEnvelopeError("invalid-envelope", "policy recipient is missing");
    normalizeRecipient({ kind: "exactEmail", value: policy.recipientEmail });
    recipientKind = "exactEmail";
  } else {
    if (!matcher || typeof matcher !== "object" || Array.isArray(matcher)) throw new ShareEnvelopeError("invalid-envelope", "policy matcher is missing");
    const parsedMatcher = matcher as Record<string, unknown>;
    if (parsedMatcher.kind !== "exactEmail" && parsedMatcher.kind !== "emailDomain" || typeof parsedMatcher.value !== "string") throw new ShareEnvelopeError("invalid-envelope", "policy matcher is invalid");
    normalizeRecipient(parsedMatcher as ShareRecipientTarget);
    if (policy.deliveryEmail !== undefined) normalizeRecipient({ kind: "exactEmail", value: policy.deliveryEmail as string });
    recipientKind = parsedMatcher.kind;
  }
  const actionValue = policy.actions ?? policy.action;
  const actionNames = Array.isArray(actionValue) ? actionValue : [actionValue];
  const actions = normalizeActions(actionNames.map((action) => action === "tinycloud.kv/get" || action === "get" || action === "read" ? "read" : action === "tinycloud.kv/list" || action === "list" ? "list" : action === "tinycloud.kv/put" || action === "tinycloud.kv/edit" || action === "put" || action === "edit" ? "edit" : action) as ShareAction[]);
  const resourceValue = policy.resource;
  let resource: ShareResource;
  if (resourceValue && typeof resourceValue === "object" && !Array.isArray(resourceValue)) {
    const candidate = resourceValue as Record<string, unknown>;
    // v2 policy resources use {kind,value}; v1 uses {kind,path}.  Accepting
    // both here is intentional: the v1 adapter remains read-only while v2
    // links and vectors use the canonical value spelling.
    const path = typeof candidate.path === "string" ? candidate.path : candidate.value;
    if (typeof path !== "string" || (candidate.kind !== "exact" && candidate.kind !== "prefix")) throw new ShareEnvelopeError("invalid-envelope", "policy resource is invalid");
    resource = normalizeResource({ kind: candidate.kind, path });
  } else {
    resource = normalizeResource({ kind: "exact", path: typeof resourceValue === "string" ? resourceValue : target.resource.path });
  }
  // The policy/delegation is the authority ceiling.  The envelope may only
  // attenuate it; the inverse check would accept a policy for one exact file
  // wrapped in a broader prefix envelope.
  if (!resourceContains(resource, target.resource)) throw new ShareEnvelopeError("invalid-envelope", "policy resource is not bound to the envelope");
  const contentSourceValue = version === 2 ? policy["content-source"] : policy.contentSource;
  if (!contentSourceValue || typeof contentSourceValue !== "object" || Array.isArray(contentSourceValue)) throw new ShareEnvelopeError("invalid-envelope", "policy content source is missing");
  const source = contentSourceValue as Record<string, unknown>;
  if (source.kind === "kv") {
    assertKeys(source, ["kind", "space", "path", "action"], "published KV content source");
    if (typeof source.space !== "string" || typeof source.path !== "string" || !["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"].includes(source.action as string)) throw new ShareEnvelopeError("invalid-envelope", "published KV content source is invalid");
  } else if (source.kind === "sql") {
    assertKeys(source, ["kind", "space", "database", "path", "statement", "arguments", "argumentsDigest", "action"], "published SQL content source");
    if (typeof source.space !== "string" || typeof source.database !== "string" || typeof source.path !== "string" || typeof source.statement !== "string" || !source.arguments || typeof source.arguments !== "object" || Array.isArray(source.arguments) || typeof source.argumentsDigest !== "string" || source.action !== "tinycloud.sql/read") throw new ShareEnvelopeError("invalid-envelope", "published SQL content source is invalid");
    for (const argument of Object.values(source.arguments as Record<string, unknown>)) if (!Number.isSafeInteger(argument)) throw new ShareEnvelopeError("invalid-envelope", "published SQL arguments are invalid");
    if (bytesToBase64Url(sha256(new TextEncoder().encode(canonicalJson(source.arguments)))) !== source.argumentsDigest) throw new ShareEnvelopeError("invalid-envelope", "published SQL argument digest is invalid");
  }
  else throw new ShareEnvelopeError("invalid-envelope", "policy content source kind is invalid");
  if (typeof policy.contentSourceDigest !== "string" || bytesToBase64Url(sha256(new TextEncoder().encode(canonicalJson(source)))) !== policy.contentSourceDigest) throw new ShareEnvelopeError("invalid-envelope", "policy content source digest is invalid");
  return { recipientKind, actions, resource };
}

/**
 * Parse the canonical Share v2 publication.  The hyphenated content-source
 * member is intentional: it is part of the signed wire contract and is not
 * interchangeable with the v1 contentSource spelling.
 */
function parseCanonicalPublishedV2(value: Record<string, unknown>, options: { readonly expectedOrigin?: string; readonly now?: Date; readonly plaintext?: Uint8Array; readonly trustedSignerDids?: readonly string[] }): { readonly artifact: ShareArtifactV2; readonly envelope: PublishedShareEnvelopeV2 } {
  assertKeys(value, ["version", "shareId", "target", "delegation", "authority", "recipientMatcher", "actions", "resource", "content-source", "expiry", "signature"], "published v2 envelope");
  if (value.version !== 2 || typeof value.shareId !== "string" || value.shareId.length === 0 || typeof value.expiry !== "string") throw new ShareEnvelopeError("invalid-envelope", "published v2 envelope shape is invalid");
  const target = value.target;
  const delegation = value.delegation;
  const authority = value.authority;
  const resourceValue = value.resource;
  if (!isPlainObject(target) || !isPlainObject(delegation) || !isPlainObject(authority) || !isPlainObject(resourceValue)) throw new ShareEnvelopeError("invalid-envelope", "published v2 binding is invalid");
  assertKeys(target, ["origin", "nodeAudience", "spaceId"], "published v2 target");
  assertKeys(delegation, ["cid", "issuerDid", "audience", "expiresAt", "encoded"], "published v2 delegation");
  assertKeys(authority, ["kind", "did", "publicKey", "cid", "signature"], "published v2 authority");
  assertKeys(resourceValue, ["kind", "value"], "published v2 resource");
  const origin = target.origin;
  const spaceId = target.spaceId;
  const nodeAudience = target.nodeAudience;
  if (typeof origin !== "string" || normalizeOrigin(origin) !== origin || typeof spaceId !== "string" || spaceId.length === 0 || typeof nodeAudience !== "string" || nodeAudience.length === 0) throw new ShareEnvelopeError("invalid-envelope", "published v2 target is invalid");
  if (options.expectedOrigin !== undefined && normalizeOrigin(options.expectedOrigin) !== origin) throw new ShareEnvelopeError("origin-mismatch", "published envelope origin is not trusted");
  const expiry = Date.parse(value.expiry);
  if (!Number.isFinite(expiry) || expiry <= (options.now ?? new Date()).getTime() || new Date(expiry).toISOString() !== value.expiry) throw new ShareEnvelopeError("expired", "published share envelope has expired");
  if (typeof delegation.cid !== "string" || typeof delegation.issuerDid !== "string" || typeof delegation.audience !== "string" || typeof delegation.expiresAt !== "string" || Date.parse(delegation.expiresAt) > expiry) throw new ShareEnvelopeError("invalid-envelope", "published v2 delegation is invalid");
  const matcher = value.recipientMatcher;
  if (!isPlainObject(matcher) || (matcher.kind !== "exactEmail" && matcher.kind !== "emailDomain") || typeof matcher.value !== "string") throw new ShareEnvelopeError("invalid-envelope", "published v2 recipient matcher is invalid");
  const normalizedMatcher = normalizeRecipient(matcher as ShareRecipientTarget);
  if (normalizedMatcher === undefined || normalizedMatcher.kind === "bearer") throw new ShareEnvelopeError("invalid-envelope", "published v2 recipient matcher is invalid");
  if (!Array.isArray(value.actions)) throw new ShareEnvelopeError("invalid-envelope", "published v2 actions are invalid");
  const actions = normalizeActions(value.actions as ShareAction[]);
  if (!isPlainObject(value["content-source"])) throw new ShareEnvelopeError("invalid-envelope", "published v2 content source is invalid");
  const contentSource = value["content-source"] as Record<string, unknown>;
  assertKeys(contentSource, ["kind", "cid", "key", "digest", "mimeType", "size"], "published v2 content source");
  if (typeof contentSource.kind !== "string" || typeof contentSource.cid !== "string" || !isPublishedCid(contentSource.cid)) throw new ShareEnvelopeError("invalid-envelope", "published v2 content source is invalid");
  const resource = normalizeResource({ kind: resourceValue.kind as ShareResource["kind"], path: resourceValue.value as string });
  if (resourceValue.kind !== resource.kind || resourceValue.value !== resource.path) throw new ShareEnvelopeError("invalid-envelope", "published v2 resource is not canonical");
  const signature = value.signature;
  if (!isPlainObject(signature)) throw new ShareEnvelopeError("invalid-envelope", "published v2 signature is invalid");
  assertKeys(signature, ["signerDid", "algorithm", "value"], "published v2 signature");
  if (typeof signature.signerDid !== "string" || signature.algorithm !== "Ed25519" || typeof signature.value !== "string") throw new ShareEnvelopeError("invalid-envelope", "published v2 signature is invalid");
  const signerKey = publishedPublicKey(signature.signerDid);
  if (options.trustedSignerDids !== undefined && !options.trustedSignerDids.includes(signature.signerDid)) throw new ShareEnvelopeError("signature-invalid", "a trusted authority is required for addressed shares");
  const signatureBytes = base64UrlToBytes(signature.value);
  const { signature: _signature, ...unsigned } = value;
  const domain = new TextEncoder().encode("xyz.tinycloud.share/envelope/v2\0");
  const body = new TextEncoder().encode(canonicalJson(unsigned));
  const signingBytes = new Uint8Array(domain.length + body.length);
  signingBytes.set(domain); signingBytes.set(body, domain.length);
  if (signatureBytes.length !== 64 || !ed25519.verify(signatureBytes, signingBytes, signerKey)) throw new ShareEnvelopeError("signature-invalid", "published v2 envelope signature is invalid");
  const content = options.plaintext ?? new Uint8Array();
  const normalized: ShareEnvelopeV2 = {
    schema: ENVELOPE_SCHEMA,
    version: 2,
    origin,
    spaceId,
    recipientKind: normalizedMatcher.kind,
    resource,
    actions,
    content: { mimeType: typeof contentSource.mimeType === "string" ? contentSource.mimeType : "application/octet-stream", size: content.byteLength, digest: bytesToBase64Url(sha256(content)) },
    encrypted: true,
    expiresAt: value.expiry,
    signer: { did: signature.signerDid, publicKey: bytesToBase64Url(signerKey) },
    signature: signature.value,
    authorizationTargetKind: "policy",
  };
  return { envelope: value as unknown as PublishedShareEnvelopeV2, artifact: { envelope: normalized, content: bytesToBase64Url(content) } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePublishedEnvelopeObject(value: unknown): PublishedShareEnvelopeV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShareEnvelopeError("invalid-envelope", "published envelope is not an object");
  const envelope = value as Record<string, unknown>;
  assertKeys(envelope, ["version", "shareId", "delegation", "authorizationTarget", "target", "display", "expiry", "content", "signature"], "published envelope");
  if (envelope.version !== 1 || typeof envelope.shareId !== "string" || envelope.shareId.length === 0 || typeof envelope.delegation !== "string" || envelope.delegation.length === 0 || typeof envelope.expiry !== "string") throw new ShareEnvelopeError("invalid-envelope", "published envelope shape is invalid");
  const target = envelope.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new ShareEnvelopeError("invalid-envelope", "published target is invalid");
  assertKeys(target, ["origin", "nodeAudience", "spaceId", "resource"], "published target");
  const targetValue = target as Record<string, unknown>;
  if (typeof targetValue.origin !== "string" || !/^https:\/\//.test(targetValue.origin) || normalizeOrigin(targetValue.origin) !== targetValue.origin || typeof targetValue.nodeAudience !== "string" || targetValue.nodeAudience.length === 0 || typeof targetValue.spaceId !== "string" || targetValue.spaceId.length === 0 || /[\u0000-\u001f\u007f\\/]/.test(targetValue.spaceId)) throw new ShareEnvelopeError("invalid-envelope", "published target binding is invalid");
  const resource = normalizeResource(targetValue.resource as ShareResource);
  if (JSON.stringify(resource) !== JSON.stringify(targetValue.resource)) throw new ShareEnvelopeError("invalid-envelope", "published resource is not canonical");
  const display = envelope.display;
  if (!display || typeof display !== "object" || Array.isArray(display)) throw new ShareEnvelopeError("invalid-envelope", "published display is invalid");
  const displayValue = display as Record<string, unknown>;
  assertKeys(displayValue, ["senderName", "filename", "recipientHint", "mode"], "published display");
  for (const key of ["senderName", "filename", "recipientHint"] as const) if (displayValue[key] !== undefined && typeof displayValue[key] !== "string") throw new ShareEnvelopeError("invalid-envelope", "published display field is invalid");
  if (displayValue.mode !== undefined && !["document", "source", "folder"].includes(displayValue.mode as string)) throw new ShareEnvelopeError("invalid-envelope", "published display mode is invalid");
  const targetAuthorization = envelope.authorizationTarget;
  if (!targetAuthorization || typeof targetAuthorization !== "object" || Array.isArray(targetAuthorization)) throw new ShareEnvelopeError("invalid-envelope", "published authorization target is invalid");
  const authorizationTarget = targetAuthorization as Record<string, unknown>;
  if (authorizationTarget.kind === "policy") {
    assertKeys(authorizationTarget, ["kind", "policyCid", "policyBytes"], "published policy target");
    if (typeof authorizationTarget.policyCid !== "string" || typeof authorizationTarget.policyBytes !== "string" || !verifyPublishedShareCid(authorizationTarget.policyCid, base64UrlToBytes(authorizationTarget.policyBytes))) throw new ShareEnvelopeError("invalid-envelope", "published policy material is not bound");
  } else if (authorizationTarget.kind === "bearerKey") {
    assertKeys(authorizationTarget, ["kind", "sessionJwk"], "published bearer target");
    const jwk = authorizationTarget.sessionJwk;
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) throw new ShareEnvelopeError("invalid-envelope", "published bearer key is invalid");
    const jwkValue = jwk as Record<string, unknown>;
    assertKeys(jwkValue, ["kty", "crv", "x", "y", "d", "alg", "use", "key_ops", "kid", "ext"], "published session JWK");
    if (jwkValue.kty !== "OKP" && jwkValue.kty !== "EC" || typeof jwkValue.crv !== "string" || typeof jwkValue.x !== "string" || typeof jwkValue.d !== "string") throw new ShareEnvelopeError("invalid-envelope", "published session JWK is invalid");
    if (jwkValue.kty === "EC" && typeof jwkValue.y !== "string") throw new ShareEnvelopeError("invalid-envelope", "published EC session JWK is invalid");
    if (jwkValue.alg !== undefined && typeof jwkValue.alg !== "string" || jwkValue.use !== undefined && typeof jwkValue.use !== "string" || jwkValue.kid !== undefined && typeof jwkValue.kid !== "string" || jwkValue.ext !== undefined && typeof jwkValue.ext !== "boolean" || jwkValue.key_ops !== undefined && (!Array.isArray(jwkValue.key_ops) || jwkValue.key_ops.some((operation) => typeof operation !== "string"))) throw new ShareEnvelopeError("invalid-envelope", "published session JWK members are invalid");
    for (const member of [jwkValue.x, jwkValue.y, jwkValue.d]) if (member !== undefined) base64UrlToBytes(member as string);
  } else if (authorizationTarget.kind === "recipientDid") {
    assertKeys(authorizationTarget, ["kind", "did"], "published DID target");
    if (typeof authorizationTarget.did !== "string" || !/^did:[a-z0-9]+:.+$/.test(authorizationTarget.did)) throw new ShareEnvelopeError("invalid-envelope", "published recipient DID is invalid");
  } else throw new ShareEnvelopeError("invalid-envelope", "published authorization target kind is invalid");
  if (envelope.content !== undefined) {
    if (!envelope.content || typeof envelope.content !== "object" || Array.isArray(envelope.content)) throw new ShareEnvelopeError("invalid-envelope", "published content pointer is invalid");
    assertKeys(envelope.content, ["cid", "key"], "published content pointer");
    const content = envelope.content as Record<string, unknown>;
    if (typeof content.cid !== "string" || typeof content.key !== "string" || !isPublishedCid(content.cid)) throw new ShareEnvelopeError("invalid-envelope", "published content pointer is invalid");
    if (base64UrlToBytes(content.key).length !== 32) throw new ShareEnvelopeError("invalid-envelope", "published content key is invalid");
    if (authorizationTarget.kind !== "bearerKey") throw new ShareEnvelopeError("unsafe-plaintext", "policy envelopes cannot contain content pointers");
  }
  const signature = envelope.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) throw new ShareEnvelopeError("invalid-envelope", "published signature is invalid");
  assertKeys(signature, ["signerDid", "algorithm", "value"], "published signature");
  const signatureValue = signature as Record<string, unknown>;
  if (typeof signatureValue.signerDid !== "string" || signatureValue.algorithm !== "Ed25519" || typeof signatureValue.value !== "string") throw new ShareEnvelopeError("invalid-envelope", "published signature is invalid");
  const signerKey = publishedPublicKey(signatureValue.signerDid);
  if (base64UrlToBytes(signatureValue.value).length !== 64) throw new ShareEnvelopeError("invalid-envelope", "published signature length is invalid");
  return envelope as unknown as PublishedShareEnvelopeV2;
}

export function parsePublishedShareEnvelope(bytes: Uint8Array, options: { readonly expectedOrigin?: string; readonly now?: Date; readonly plaintext?: Uint8Array; readonly trustedSignerDids?: readonly string[] } = {}): { readonly envelope: PublishedShareEnvelopeV2; readonly artifact: ShareArtifactV2 } {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ShareEnvelopeError("invalid-envelope", "published envelope is not JSON"); }
  if (isPlainObject(parsed) && parsed.version === 2 && parsed["content-source"] !== undefined) {
    return parseCanonicalPublishedV2(parsed, options);
  }
  // Current Share publishes the v2 envelope fields directly (recipient,
  // actions, encrypted, metadata/content) rather than the older v1
  // authorizationTarget wrapper.  Keep this adapter strict and normalize it
  // into the SDK artifact shape before any policy/session work.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && ((parsed as Record<string, unknown>).schema === ENVELOPE_SCHEMA || ((parsed as Record<string, unknown>).version === 2 && ((parsed as Record<string, unknown>).metadata !== undefined || (parsed as Record<string, unknown>).recipient !== undefined))) ) {
    const direct = parsed as Record<string, unknown>;
    const envelopeValue = direct.envelope && typeof direct.envelope === "object" && !Array.isArray(direct.envelope) ? direct.envelope as Record<string, unknown> : direct;
    const value = { ...envelopeValue } as Record<string, unknown>;
    if (value.content === undefined && value.metadata !== undefined) value.content = value.metadata;
    delete value.metadata;
    const contentValue = value.content;
    if (!contentValue || typeof contentValue !== "object" || Array.isArray(contentValue)) throw new ShareEnvelopeError("invalid-envelope", "published v2 metadata is invalid");
    const artifactContent = typeof direct.content === "string" ? direct.content : options.plaintext === undefined ? "" : bytesToBase64Url(options.plaintext);
    const artifactValue = { envelope: value, content: artifactContent };
    const artifact = parseShareArtifact(new TextEncoder().encode(canonicalJson(artifactValue)), { expectedOrigin: options.expectedOrigin, now: options.now, maxContentBytes: DEFAULT_MAX_ARTIFACT_BYTES });
    if (options.trustedSignerDids !== undefined && artifact.envelope.recipientKind !== undefined && !options.trustedSignerDids.includes(artifact.envelope.signer.did)) throw new ShareEnvelopeError("signature-invalid", "a trusted authority is required for addressed shares");
    return { envelope: direct as unknown as PublishedShareEnvelopeV2, artifact };
  }
  const envelope = parsePublishedEnvelopeObject(parsed);
  if (options.expectedOrigin !== undefined && envelope.target.origin !== options.expectedOrigin) throw new ShareEnvelopeError("origin-mismatch", "published envelope origin is not trusted");
  if (!Number.isFinite(Date.parse(envelope.expiry)) || Date.parse(envelope.expiry) <= (options.now ?? new Date()).getTime()) throw new ShareEnvelopeError("expired", "published share envelope has expired");
  if (new Date(envelope.expiry).toISOString() !== envelope.expiry) throw new ShareEnvelopeError("invalid-envelope", "published expiry is not canonical");
  const policy = envelope.authorizationTarget.kind === "policy" ? parsePolicyMetadata(envelope.authorizationTarget.policyBytes, envelope.target, envelope.expiry) : undefined;
  if (envelope.authorizationTarget.kind !== "bearerKey" && (options.trustedSignerDids === undefined || !options.trustedSignerDids.includes(envelope.signature.signerDid))) throw new ShareEnvelopeError("signature-invalid", "a trusted authority is required for addressed shares");
  const signature = base64UrlToBytes(envelope.signature.value);
  const publicKey = publishedPublicKey(envelope.signature.signerDid);
  if (signature.length !== 64 || !ed25519.verify(signature, publishedEnvelopeSigningBytes(envelope), publicKey)) throw new ShareEnvelopeError("signature-invalid", "published envelope signature is invalid");
  return { envelope, artifact: publishedArtifact(envelope, options.plaintext ?? new Uint8Array(), policy) };
}

/**
 * Read the v1 sealed envelope emitted by the existing authenticated Share
 * policy composer. It is deliberately exposed as a read-only compatibility
 * adapter: the resulting artifact carries an authorization marker, so the
 * SDK never treats this policy envelope as a local bearer grant.
 */
export function parseLegacyPublishedShareEnvelope(bytes: Uint8Array, options: { readonly expectedOrigin?: string; readonly now?: Date; readonly plaintext?: Uint8Array; readonly trustedSignerDids?: readonly string[] } = {}): { readonly artifact: ShareArtifactV2 } {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ShareEnvelopeError("invalid-envelope", "published v1 envelope is not JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ShareEnvelopeError("invalid-envelope", "published v1 envelope is not an object");
  const envelope = parsed as Record<string, unknown>;
  const target = envelope.target as Record<string, unknown> | undefined;
  const resource = target?.resource as Record<string, unknown> | undefined;
  const authorizationTarget = envelope.authorizationTarget as Record<string, unknown> | undefined;
  const signature = envelope.signature as Record<string, unknown> | undefined;
  assertKeys(envelope, ["version", "shareId", "delegation", "authorizationTarget", "target", "display", "expiry", "content", "signature"], "published v1 envelope");
  if (target !== undefined) assertKeys(target, ["origin", "nodeAudience", "spaceId", "resource"], "published v1 target");
  if (resource !== undefined) assertKeys(resource, ["kind", "path"], "published v1 resource");
  if (authorizationTarget !== undefined) {
    if (authorizationTarget.kind === "policy") assertKeys(authorizationTarget, ["kind", "policyCid", "policyBytes"], "published v1 policy target");
    else if (authorizationTarget.kind === "bearerKey") assertKeys(authorizationTarget, ["kind", "sessionJwk"], "published v1 bearer target");
    else if (authorizationTarget.kind === "recipientDid") assertKeys(authorizationTarget, ["kind", "did"], "published v1 DID target");
    else assertKeys(authorizationTarget, ["kind"], "published v1 authorization target");
  }
  if (signature !== undefined) assertKeys(signature, ["signerDid", "algorithm", "value"], "published v1 signature");
  if (envelope.version !== 1 || typeof envelope.shareId !== "string" || typeof envelope.expiry !== "string" || typeof target?.origin !== "string" || typeof target.spaceId !== "string" || typeof target.nodeAudience !== "string" || (resource?.kind !== "exact" && resource?.kind !== "prefix") || typeof resource.path !== "string" || typeof authorizationTarget?.kind !== "string" || typeof signature?.signerDid !== "string" || signature.algorithm !== "Ed25519" || typeof signature.value !== "string") throw new ShareEnvelopeError("invalid-envelope", "published v1 envelope shape is invalid");
  if (options.expectedOrigin !== undefined && target.origin !== options.expectedOrigin) throw new ShareEnvelopeError("origin-mismatch", "published envelope origin is not trusted");
  const expiry = Date.parse(envelope.expiry);
  if (!Number.isFinite(expiry) || expiry <= (options.now ?? new Date()).getTime()) throw new ShareEnvelopeError("expired", "published share envelope has expired");
  const signerKey = publishedPublicKey(signature.signerDid);
  if (authorizationTarget.kind !== "bearer" && (options.trustedSignerDids === undefined || !options.trustedSignerDids.includes(signature.signerDid))) throw new ShareEnvelopeError("signature-invalid", "a trusted authority is required for addressed shares");
  const signatureBytes = base64UrlToBytes(signature.value);
  const { signature: _signature, ...unsigned } = envelope;
  const domain = new TextEncoder().encode("xyz.tinycloud.share/envelope/v1\0");
  const body = new TextEncoder().encode(canonicalJson(unsigned));
  const signingBytes = new Uint8Array(domain.length + body.length);
  signingBytes.set(domain); signingBytes.set(body, domain.length);
  if (signatureBytes.length !== 64 || !ed25519.verify(signatureBytes, signingBytes, signerKey)) throw new ShareEnvelopeError("signature-invalid", "published v1 envelope signature is invalid");
  const content = options.plaintext ?? new Uint8Array();
  const artifact: ShareArtifactV2 = {
    envelope: {
      schema: ENVELOPE_SCHEMA,
      version: 2,
      origin: target.origin,
      spaceId: target.spaceId,
      resource: { kind: resource.kind, path: resource.path },
      recipientKind: authorizationTarget.kind === "bearer" ? "bearer" : authorizationTarget.kind === "exact-email" ? "exactEmail" : authorizationTarget.kind === "email-domain" ? "emailDomain" : undefined,
      actions: ["read"],
      content: { mimeType: "application/octet-stream", size: content.byteLength, digest: bytesToBase64Url(sha256(content)) },
      encrypted: true,
      expiresAt: envelope.expiry,
      signer: { did: signature.signerDid, publicKey: bytesToBase64Url(signerKey) },
      signature: signature.value,
      authorizationTargetKind: authorizationTarget.kind,
    },
    content: bytesToBase64Url(content),
  };
  return { artifact };
}

export function parsePublishedShareLink(link: string, options: { readonly trustedOrigins?: readonly string[]; readonly maxInlineBytes?: number } = {}): { readonly origin: string; readonly cid: string; readonly key?: Uint8Array; readonly sealed?: Uint8Array } {
  let url: URL;
  try { url = new URL(link); } catch { throw new ShareEnvelopeError("invalid-link", "share link must be an absolute URL"); }
  const origin = normalizeOrigin(url.origin);
  if (options.trustedOrigins !== undefined && !options.trustedOrigins.map(normalizeOrigin).includes(origin)) throw new ShareEnvelopeError("origin-mismatch", "share link origin is not trusted");
  if (url.search !== "" || url.username !== "" || url.password !== "") throw new ShareEnvelopeError("invalid-link", "share link is not canonical");
  if (url.pathname === "/s/inline" && url.hash.startsWith("#v=2&p=")) {
    let payload: Record<string, unknown>;
    try {
      const bytes = base64UrlToBytes(url.hash.slice("#v=2&p=".length));
      if (bytes.length > (options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES) * 2) throw new Error("inline payload too large");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("inline payload shape");
      payload = value as Record<string, unknown>;
    } catch (error) { throw new ShareEnvelopeError("invalid-link", error instanceof Error ? error.message : "invalid inline payload"); }
    if (payload.v !== 2 || typeof payload.c !== "string" || typeof payload.cid !== "string" || (payload.k !== undefined && typeof payload.k !== "string") || Object.keys(payload).some((key) => !["v", "c", "cid", "k"].includes(key))) throw new ShareEnvelopeError("invalid-link", "inline payload fields are invalid");
    const sealed = base64UrlToBytes(payload.c);
    if (!verifyPublishedShareCid(payload.cid, sealed)) throw new ShareEnvelopeError("cid-mismatch", "inline payload CID does not match");
    const key = payload.k === undefined ? undefined : base64UrlToBytes(payload.k);
    if (key !== undefined && key.length !== 32) throw new ShareEnvelopeError("invalid-link", "inline payload key is invalid");
    return { origin, cid: payload.cid, ...(key === undefined ? {} : { key }), sealed };
  }
  const match = /^\/s\/([a-z2-7]+)$/.exec(url.pathname);
  if (match === null || !url.hash.startsWith("#k=")) throw new ShareEnvelopeError("invalid-link", "published share link is invalid");
  const key = base64UrlToBytes(url.hash.slice(3));
  if (key.length !== 32) throw new ShareEnvelopeError("invalid-link", "published link key is invalid");
  try {
    const cid = CID.parse(match[1]);
    if (cid.version !== 1 || cid.code !== raw.code || cid.multihash.code !== sha256Cid.code || cid.toString() !== match[1]) throw new Error("CID");
  } catch { throw new ShareEnvelopeError("invalid-link", "published link CID is invalid"); }
  return { origin, cid: match[1], key };
}

export function parseShareUrl(link: string, options: { readonly trustedOrigins?: readonly string[]; readonly maxInlineBytes?: number } = {}): ShareLinkLocation {
  let url: URL;
  try { url = new URL(link); } catch { throw new ShareEnvelopeError("invalid-link", "share link must be an absolute URL"); }
  if (url.search !== "") throw new ShareEnvelopeError("invalid-link", "share links must not contain query parameters");
  const origin = normalizeOrigin(url.origin);
  if (options.trustedOrigins !== undefined && !options.trustedOrigins.map(normalizeOrigin).includes(origin)) throw new ShareEnvelopeError("origin-mismatch", "share link origin is not trusted");
  if (url.pathname === "/s/inline" && url.hash.startsWith("#v=2&p=")) {
    const published = parsePublishedShareLink(link, options);
    return { kind: "inline", origin, cid: published.cid, key: published.key, url: `${url.origin}${url.pathname}`, protocol: "share-envelope-v2" };
  }
  const match = url.pathname.match(/^\/s\/(i\/)?([^/]+)$/);
  if (!match) throw new ShareEnvelopeError("invalid-link", "share link path is invalid");
  const fragmentParams = url.hash === "" ? undefined : new URLSearchParams(url.hash.slice(1));
  if (fragmentParams !== undefined && (fragmentParams.get("k") === null || [...fragmentParams.keys()].some((key) => key !== "k"))) throw new ShareEnvelopeError("invalid-link", "share link fragment is not canonical");
  const fragment = fragmentParams?.get("k");
  const key = fragment === null || fragment === undefined ? undefined : base64UrlToBytes(fragment);
  if (key !== undefined && key.length !== 32) throw new ShareEnvelopeError("invalid-link", "fragment key must be 32 bytes");
  if (match[1] === undefined) {
    try { if (CID.parse(match[2]).toString() !== match[2]) throw new Error("non-canonical CID"); }
    catch { throw new ShareEnvelopeError("invalid-link", "CID is not canonical"); }
    const protocol = CID.parse(match[2]).multihash.code === sha256Cid.code ? "share-envelope-v2" : "legacy";
    return { kind: "compact", origin, cid: match[2], key, url: `${url.origin}${url.pathname}`, protocol };
  }
  const inlineBytes = base64UrlToBytes(match[2]);
  if (inlineBytes.byteLength > (options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES)) throw new ShareEnvelopeError("content-too-large", "inline share exceeds the configured limit");
  return { kind: "inline", origin, artifact: parseShareArtifact(inlineBytes), key, url: `${url.origin}${url.pathname}` };
}

export function isV2ShareLink(link: string): boolean {
  try { return new URL(link).pathname.startsWith("/s/"); } catch { return link.startsWith(INLINE_PREFIX); }
}

export async function encryptShareBytes(bytes: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  return encryptShareBytesAsync(bytes, key);
}

export async function encryptShareBytesAsync(bytes: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (key.length !== 32) throw new ShareEnvelopeError("encryption-required", "AES-GCM key must be 32 bytes");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey("raw", key as unknown as ArrayBuffer, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as ArrayBuffer }, cryptoKey, bytes as unknown as ArrayBuffer);
  return new Uint8Array([...iv, ...new Uint8Array(ciphertext)]);
}

export async function decryptShareBytesAsync(bytes: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (key.length !== 32 || bytes.length < 28) throw new ShareEnvelopeError("invalid-envelope", "encrypted share bytes are invalid");
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key as unknown as ArrayBuffer, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) as unknown as ArrayBuffer }, cryptoKey, bytes.slice(12) as unknown as ArrayBuffer));
  } catch {
    throw new ShareEnvelopeError("signature-invalid", "share decryption failed");
  }
}

export function createShareArtifact(input: ShareArtifactInput): ShareArtifactResult {
  const key = input.encryptionKey;
  if (input.recipient !== undefined && key === undefined) throw new ShareEnvelopeError("encryption-required", "recipient shares require encryption");
  if (input.plaintextPolicyOnly && (!input.plaintextWarningAcknowledged || input.bytes.byteLength !== 0 || input.recipient !== undefined || key !== undefined)) throw new ShareEnvelopeError("unsafe-plaintext", "plaintext policy artifacts require explicit acknowledgement and contain no content");
  if (input.bytes.byteLength > (input.maxContentBytes ?? DEFAULT_MAX_ARTIFACT_BYTES)) throw new ShareEnvelopeError("content-too-large", "share content exceeds the configured limit");
  if (key !== undefined) throw new ShareEnvelopeError("invalid-envelope", "use createShareArtifactAsync for encryption");
  const envelope = signShareEnvelope({
    schema: ENVELOPE_SCHEMA,
    version: 2,
    origin: input.origin,
    spaceId: input.spaceId,
    recipient: input.recipient,
    recipientKind: input.recipient?.kind,
    resource: input.resource,
    actions: input.actions,
    content: { mimeType: input.mimeType, size: input.bytes.byteLength, digest: contentDigest(input.bytes), ...(input.mimeType.startsWith("text/") ? { charset: "utf-8" as const } : {}) },
    encrypted: false,
    expiresAt: input.expiresAt.toISOString(),
    signerDid: input.signerDid,
    signerPrivateKey: input.signerPrivateKey,
  });
  const artifact = { envelope, content: bytesToBase64Url(input.bytes) } satisfies ShareArtifactV2;
  return { artifact, bytes: encodeShareArtifact(artifact), cid: computeShareCid(encodeShareArtifact(artifact)) };
}

export async function createShareArtifactAsync(input: ShareArtifactInput): Promise<ShareArtifactResult> {
  const recipient = input.recipient === undefined ? undefined : normalizeShareRecipientTarget(input.recipient);
  if (recipient !== undefined && input.encryptionKey === undefined) throw new ShareEnvelopeError("encryption-required", "recipient shares require encryption");
  if (input.plaintextPolicyOnly && (!input.plaintextWarningAcknowledged || input.bytes.byteLength !== 0 || recipient !== undefined || input.encryptionKey !== undefined)) throw new ShareEnvelopeError("unsafe-plaintext", "plaintext policy artifacts require explicit acknowledgement and contain no content");
  if (input.bytes.byteLength > (input.maxContentBytes ?? MAX_SHARE_CONTENT_BYTES)) throw new ShareEnvelopeError("content-too-large", "share plaintext exceeds the configured limit");
  const encryptedBytes = input.encryptionKey === undefined ? input.bytes : await encryptShareBytesAsync(input.bytes, input.encryptionKey);
  if (encryptedBytes.byteLength > MAX_SEALED_SHARE_CONTENT_BYTES) throw new ShareEnvelopeError("content-too-large", "sealed share content exceeds the configured limit");
  const envelope = signShareEnvelope({
    schema: ENVELOPE_SCHEMA,
    version: 2,
    origin: input.origin,
    spaceId: input.spaceId,
    resource: input.resource,
    actions: input.actions,
    content: { mimeType: input.mimeType, size: encryptedBytes.byteLength, digest: contentDigest(encryptedBytes), ...(input.mimeType.startsWith("text/") ? { charset: "utf-8" as const } : {}) },
    encrypted: input.encryptionKey !== undefined,
    expiresAt: input.expiresAt.toISOString(),
    signerDid: input.signerDid,
    signerPrivateKey: input.signerPrivateKey,
    ...(recipient?.kind === "bearer" ? { recipient } : {}),
    ...(recipient === undefined ? {} : { recipientKind: recipient.kind }),
  });
  const artifact = { envelope, content: bytesToBase64Url(encryptedBytes) } satisfies ShareArtifactV2;
  const bytes = encodeShareArtifact(artifact);
  return { artifact, bytes, cid: computeShareCid(bytes), key: input.encryptionKey };
}

export function intersectShareCapabilities(granted: ShareCapabilityLike, requested: ShareCapabilityLike): ShareCapabilityLike | undefined {
  if (granted.spaceId !== requested.spaceId) return undefined;
  const path = intersectSharePaths(granted.resource, requested.resource);
  if (path === undefined) return undefined;
  const actions = requested.actions.filter((action) => granted.actions.includes(action));
  if (actions.length === 0) return undefined;
  return { spaceId: granted.spaceId, resource: path, actions: [...new Set(actions)].sort() as ShareAction[] };
}

export interface ShareCapabilityLike { readonly spaceId: string; readonly resource: ShareResource; readonly actions: readonly ShareAction[]; }

function intersectSharePaths(left: ShareResource, right: ShareResource): ShareResource | undefined {
  if (left.kind === "exact" && right.kind === "exact") return left.path === right.path ? left : undefined;
  if (left.kind === "exact") return resourceContains(right, left) ? left : undefined;
  if (right.kind === "exact") return resourceContains(left, right) ? right : undefined;
  if (resourceContains(left, right)) return right;
  if (resourceContains(right, left)) return left;
  return undefined;
}

export function shareCapabilityAllows(capability: ShareCapabilityLike, action: ShareAction, path: string): boolean {
  if (!capability.actions.includes(action)) return false;
  if (capability.resource.kind === "exact") return action !== "list" && capability.resource.path === path;
  const prefix = capability.resource.path.replace(/\/$/, "");
  if (action === "list") return path.replace(/\/$/, "") === prefix;
  const remainder = path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : "";
  return remainder.length > 0 && !remainder.includes("/");
}

export { ENVELOPE_SCHEMA, INLINE_PREFIX, DEFAULT_MAX_INLINE_BYTES };
