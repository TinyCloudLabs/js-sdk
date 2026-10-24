import { sha256 } from "@noble/hashes/sha256";
import { z } from "zod";

import { fromBase64Url, toBase64Url, utf8Bytes } from "../bytes.js";
import { isCanonicalRawCid } from "../cid.js";
import { didKeyFromEd25519PublicKey, ed25519PublicKeyFromDidKey } from "../didkey.js";
import { canonicalize } from "../jcs.js";
import {
  LINK_DELETE_DOMAIN,
  LINK_HEADER_DOMAIN,
  LINK_ID_PATTERN,
  MAX_LINK_BODY_BYTES,
  LINK_MIN_BODY_BYTES,
  LINK_MIN_LIFE_SECONDS,
  LINK_TYPES,
  LINK_TYPE_SPECS,
  LINK_WINDOW_SECONDS,
  type LinkType,
} from "./constants.js";
import { ed25519KeyProblem, verifyEd25519Strict } from "./ed25519-strict.js";
import { LinkError } from "./errors.js";
import type { LinkSigner } from "./signer.js";

const DID_KEY_PATTERN = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;
const SERVICE_ISSUER_PATTERN = /^service:[a-z0-9][a-z0-9-]{0,31}$/;
const AUDIENCE_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CID_PATTERN = /^bafkrei[a-z2-7]{52}$/;
const HEADER_KEYS = ["audience", "bodyCid", "expiresAt", "issuedAt", "issuer", "nonce", "size", "type", "version"] as const;
const DELETE_KEYS = ["audience", "id", "issuedAt", "issuer", "nonce", "op", "version"] as const;

/** Strict base64url that decodes to exactly `length` bytes, or `null`. */
function strictBytes(text: unknown, length?: number): Uint8Array | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bytes = fromBase64Url(text);
    return length === undefined || bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

/** Milliseconds for a `YYYY-MM-DDTHH:mm:ss.SSSZ` timestamp that round-trips, else `null`. */
export function parseLinkTimestamp(text: unknown): number | null {
  if (typeof text !== "string" || !TIMESTAMP_PATTERN.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && new Date(ms).toISOString() === text ? ms : null;
}

/** The 32-byte Ed25519 key of a canonical `did:key`, or `null` for anything else. */
export function linkIssuerPublicKey(did: string): Uint8Array | null {
  if (!DID_KEY_PATTERN.test(did)) return null;
  try {
    const key = ed25519PublicKeyFromDidKey(did);
    return didKeyFromEd25519PublicKey(key) === did ? key : null;
  } catch {
    return null;
  }
}

const ed25519DidKey = z.string().refine((did) => {
  const key = linkIssuerPublicKey(did);
  return key !== null && ed25519KeyProblem(key) === null;
});

export const linkTypeSchema = z.enum(LINK_TYPES);

export const linkHeaderV1Schema = z
  .object({
    version: z.literal(1),
    type: linkTypeSchema,
    issuer: z.union([ed25519DidKey, z.string().regex(SERVICE_ISSUER_PATTERN)]),
    audience: z.string().regex(AUDIENCE_PATTERN),
    issuedAt: z.string().refine((text) => parseLinkTimestamp(text) !== null),
    expiresAt: z.string().refine((text) => parseLinkTimestamp(text) !== null),
    size: z.number().int().min(1),
    bodyCid: z.string().regex(CID_PATTERN).refine(isCanonicalRawCid),
    nonce: z.string().regex(NONCE_PATTERN).refine((text) => strictBytes(text, 16) !== null),
  })
  .strict();

export const linkSignatureV1Schema = z
  .object({
    algorithm: z.literal("Ed25519"),
    value: z.string().refine((text) => strictBytes(text, 64) !== null),
  })
  .strict();

export type LinkHeaderV1 = z.infer<typeof linkHeaderV1Schema>;
export type LinkSignatureV1 = z.infer<typeof linkSignatureV1Schema>;

/** A stored or full-link record: the signed header, its signature (absent for API-key records) and the sealed body. */
export interface LinkRecord {
  readonly header: LinkHeaderV1;
  readonly signature?: LinkSignatureV1;
  /** The sealed body, unpadded base64url. */
  readonly body: string;
}

export const linkDeleteRequestV1Schema = z
  .object({
    version: z.literal(1),
    op: z.literal("delete"),
    id: z.string(),
    issuer: z.string(),
    audience: z.string(),
    issuedAt: z.string(),
    nonce: z.string(),
  })
  .strict();

export type LinkDeleteRequestV1 = z.infer<typeof linkDeleteRequestV1Schema>;

export type LinkIssuerMode = "signed" | "service";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

function checkIssuer(issuer: unknown, mode: LinkIssuerMode): void {
  if (typeof issuer !== "string") throw new LinkError("issuer_format");
  if (mode === "service") {
    if (!SERVICE_ISSUER_PATTERN.test(issuer)) throw new LinkError("issuer_service_format");
    return;
  }
  if (!issuer.startsWith("did:key:")) throw new LinkError("issuer_method_not_allowed");
  if (!DID_KEY_PATTERN.test(issuer)) throw new LinkError("issuer_format");
  const key = linkIssuerPublicKey(issuer);
  if (key === null) throw new LinkError("issuer_key_type");
  const problem = ed25519KeyProblem(key);
  if (problem === "noncanonical") throw new LinkError("issuer_key_noncanonical");
  if (problem === "invalid") throw new LinkError("issuer_key_invalid");
  if (problem === "weak") throw new LinkError("issuer_weak_key");
}

/**
 * Validate a header's structure and values. `mode` is `signed` (the issuer is
 * an Ed25519 `did:key`) or `service` (the issuer is `service:<name>`). When
 * `audience` is given the header must name it. Throws a `LinkError` carrying
 * the contract's reason; nothing about timestamps' window or life is checked
 * here (see `checkLinkHeaderLife`).
 */
export function validateLinkHeader(value: unknown, options: { readonly mode: LinkIssuerMode; readonly audience?: string }): LinkHeaderV1 {
  if (!isPlainObject(value)) throw new LinkError("header_shape");
  if (!hasExactKeys(value, HEADER_KEYS)) throw new LinkError("header_fields");
  if (value.version !== 1) throw new LinkError("header_version");
  if (typeof value.type !== "string" || !(LINK_TYPES as readonly string[]).includes(value.type)) throw new LinkError("unknown_type");
  checkIssuer(value.issuer, options.mode);
  if (typeof value.audience !== "string" || !AUDIENCE_PATTERN.test(value.audience)) throw new LinkError("audience_format");
  if (options.audience !== undefined && value.audience !== options.audience) throw new LinkError("audience_mismatch");
  if (parseLinkTimestamp(value.issuedAt) === null || parseLinkTimestamp(value.expiresAt) === null) throw new LinkError("timestamp_format");
  if (typeof value.nonce !== "string" || !NONCE_PATTERN.test(value.nonce) || strictBytes(value.nonce, 16) === null) throw new LinkError("nonce_format");
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 1) throw new LinkError("size_format");
  if (typeof value.bodyCid !== "string" || !CID_PATTERN.test(value.bodyCid) || !isCanonicalRawCid(value.bodyCid)) throw new LinkError("body_cid_format");
  const parsed = linkHeaderV1Schema.safeParse(value);
  if (!parsed.success) throw new LinkError("header_fields");
  return parsed.data;
}

/**
 * The create-time life rules: `issuedAt` within the clock window, life
 * between the minimum and the type maximum, and not already expired. The
 * service enforces the same rules; a reader does not (a full link may carry a
 * longer share lifetime).
 */
export function checkLinkHeaderLife(header: LinkHeaderV1, nowMs: number): void {
  const issued = parseLinkTimestamp(header.issuedAt);
  const expires = parseLinkTimestamp(header.expiresAt);
  if (issued === null || expires === null) throw new LinkError("timestamp_format");
  if (Math.abs(issued - nowMs) > LINK_WINDOW_SECONDS * 1000) throw new LinkError("issued_at_window");
  if (expires <= issued) throw new LinkError("expires_before_issued");
  const lifeSeconds = (expires - issued) / 1000;
  if (lifeSeconds < LINK_MIN_LIFE_SECONDS) throw new LinkError("life_too_short");
  if (lifeSeconds > LINK_TYPE_SPECS[header.type].maxLifeSeconds) throw new LinkError("life_too_long");
  if (expires <= nowMs) throw new LinkError("already_expired");
}

/** The body checks every holder of a header makes, in the contract's order: size, type cap, minimum, CID. */
export function checkLinkBody(header: LinkHeaderV1, body: Uint8Array, bodyCid: string): void {
  if (body.length !== header.size) throw new LinkError("size_mismatch");
  if (body.length > MAX_LINK_BODY_BYTES) throw new LinkError("body_over_cap");
  if (body.length < LINK_MIN_BODY_BYTES) throw new LinkError("body_too_small");
  if (bodyCid !== header.bodyCid) throw new LinkError("body_hash_mismatch");
}

/** `utf8(domain) ‖ utf8(JCS(object))`: the bytes that are hashed and signed. */
export function linkSigningBytes(domain: string, object: unknown): Uint8Array {
  const prefix = utf8Bytes(domain);
  const body = utf8Bytes(canonicalize(object));
  const bytes = new Uint8Array(prefix.length + body.length);
  bytes.set(prefix);
  bytes.set(body, prefix.length);
  return bytes;
}

/** `SHA-256(linkSigningBytes(domain, object))`: the message Ed25519 signs. */
export function linkSigningDigest(domain: string, object: unknown): Uint8Array {
  return sha256(linkSigningBytes(domain, object));
}

async function signDigest(signer: LinkSigner, domain: string, object: unknown, issuer: string): Promise<LinkSignatureV1> {
  if (signer.did !== issuer) throw new LinkError("invalid_argument", "the signer does not match the issuer");
  const digest = linkSigningDigest(domain, object);
  let raw: Uint8Array;
  try {
    raw = await signer.sign(digest);
  } catch (cause) {
    throw new LinkError("signer_failed", "the signer failed", { cause });
  }
  const signature: LinkSignatureV1 = { algorithm: "Ed25519", value: toBase64Url(raw) };
  if (!verifySignature(issuer, domain, object, signature)) throw new LinkError("signer_failed", "the signer returned a signature that does not verify for its did");
  return signature;
}

function verifySignature(issuer: string, domain: string, object: unknown, signature: unknown): boolean {
  if (!isPlainObject(signature) || !hasExactKeys(signature, ["algorithm", "value"]) || signature.algorithm !== "Ed25519") return false;
  const sig = strictBytes(signature.value, 64);
  const key = linkIssuerPublicKey(issuer);
  if (sig === null || key === null) return false;
  return verifyEd25519Strict(key, linkSigningDigest(domain, object), sig);
}

/**
 * Sign a create header (`signed` mode). The header is validated first; the
 * signer's `did` must equal `header.issuer`; the returned signature is
 * verified under the strict rule before it is handed back.
 */
export async function signHeader(header: LinkHeaderV1, signer: LinkSigner): Promise<LinkSignatureV1> {
  const valid = validateLinkHeader(header, { mode: "signed" });
  return signDigest(signer, LINK_HEADER_DOMAIN, valid, valid.issuer);
}

/** Verify a header signature under the strict Ed25519 rule. `false` for any malformed input. */
export function verifyHeader(header: LinkHeaderV1, signature: unknown): boolean {
  return verifySignature(header.issuer, LINK_HEADER_DOMAIN, header, signature);
}

/** Validate a delete request's structure and values (`signed` mode: the issuer is an Ed25519 `did:key`). */
export function validateLinkDeleteRequest(value: unknown, options: { readonly audience?: string } = {}): LinkDeleteRequestV1 {
  if (!isPlainObject(value)) throw new LinkError("request_shape");
  if (!hasExactKeys(value, DELETE_KEYS)) throw new LinkError("request_fields");
  if (value.version !== 1 || value.op !== "delete") throw new LinkError("request_version");
  if (typeof value.id !== "string" || !LINK_ID_PATTERN.test(value.id)) throw new LinkError("id_grammar");
  checkIssuer(value.issuer, "signed");
  if (typeof value.audience !== "string" || !AUDIENCE_PATTERN.test(value.audience)) throw new LinkError("audience_format");
  if (options.audience !== undefined && value.audience !== options.audience) throw new LinkError("audience_mismatch");
  if (parseLinkTimestamp(value.issuedAt) === null) throw new LinkError("timestamp_format");
  if (typeof value.nonce !== "string" || !NONCE_PATTERN.test(value.nonce) || strictBytes(value.nonce, 16) === null) throw new LinkError("nonce_format");
  return linkDeleteRequestV1Schema.parse(value);
}

/** Sign a delete request under the delete domain. The signer's `did` must equal `request.issuer`. */
export async function signDelete(request: LinkDeleteRequestV1, signer: LinkSigner): Promise<LinkSignatureV1> {
  const valid = validateLinkDeleteRequest(request);
  return signDigest(signer, LINK_DELETE_DOMAIN, valid, valid.issuer);
}

/** Verify a delete signature under the strict Ed25519 rule. `false` for any malformed input. */
export function verifyDelete(request: LinkDeleteRequestV1, signature: unknown): boolean {
  return verifySignature(request.issuer, LINK_DELETE_DOMAIN, request, signature);
}

/** 16 random bytes as 22 base64url characters. */
export function randomLinkNonce(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** Decode a strict base64url string; `null` when it is not canonical. */
export function decodeStrictBase64Url(text: unknown): Uint8Array | null {
  return strictBytes(text);
}

export function linkTypeForPathLetter(letter: string): LinkType | undefined {
  return LINK_TYPES.find((type) => LINK_TYPE_SPECS[type].pathLetter === letter);
}
