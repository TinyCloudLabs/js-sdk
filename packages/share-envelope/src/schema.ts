import { z } from "zod";

import { fromBase64Url } from "./bytes.js";
import { isCanonicalRawCid } from "./cid.js";

/**
 * ShareEnvelope schema per sharing-ux-blueprint.md §2.1, with the signed
 * typed resource selector and optional display.mode presentation hint from
 * sharing-viewer-and-registry.md §1. All objects are strict — unknown fields
 * are rejected everywhere.
 */

/** Strictly-decodable unpadded base64url: alphabet, length, AND zero trailing bits. */
function decodeBase64UrlOrNull(value: string): Uint8Array | null {
  try {
    return fromBase64Url(value);
  } catch {
    return null;
  }
}

const base64UrlString = () =>
  z.string().refine((value) => decodeBase64UrlOrNull(value) !== null, {
    message: "expected strictly-decodable unpadded base64url",
  });

/**
 * A canonical HTTPS web origin: `https://host[:non-default-port]` and nothing
 * else. No path, query, fragment, userinfo, trailing slash, default-port
 * alias (`:443`), or non-lowercase host — the string must round-trip exactly
 * through URL origin serialization. Rejects every non-https scheme
 * (http:, ftp:, file:, javascript:, …). This must byte-match what a Rust
 * verifier would accept, so it is exact-string, not "URL-ish".
 */
export function isCanonicalHttpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.origin === value;
}

/**
 * Session JWK carried by bearer-target envelopes. Strict discriminated union
 * over the asymmetric private-key families a session key can be (OKP / EC).
 * The private component (`d`) is REQUIRED — a bearer envelope without it is
 * useless — and cross-family members (`y` on OKP, `k` anywhere) are rejected,
 * as are unknown JWK members, rather than silently signed over.
 */
const sessionJwkCommonFields = {
  alg: z.string().min(1).optional(),
  use: z.string().min(1).optional(),
  key_ops: z.array(z.string().min(1)).optional(),
  kid: z.string().min(1).optional(),
  ext: z.boolean().optional(),
};

const okpPrivateJwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.string().min(1),
    x: base64UrlString(),
    d: base64UrlString(),
    ...sessionJwkCommonFields,
  })
  .strict();

const ecPrivateJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.string().min(1),
    x: base64UrlString(),
    y: base64UrlString(),
    d: base64UrlString(),
    ...sessionJwkCommonFields,
  })
  .strict();

export const sessionJwkSchema = z.discriminatedUnion("kty", [
  okpPrivateJwkSchema,
  ecPrivateJwkSchema,
]);

export const policyTargetSchema = z
  .object({
    kind: z.literal("policy"),
    policyCid: z.string().min(1),
    /** Canonical policy bytes, base64url-encoded (bytes are not JSON). */
    policyBytes: base64UrlString(),
  })
  .strict();

export const bearerKeyTargetSchema = z
  .object({
    kind: z.literal("bearerKey"),
    sessionJwk: sessionJwkSchema,
  })
  .strict();

export const recipientDidTargetSchema = z
  .object({
    kind: z.literal("recipientDid"),
    did: z.string().regex(/^did:[a-z0-9]+:.+$/, "expected a DID"),
  })
  .strict();

/** Signed discriminated union — the target kind itself is signature-covered. */
export const authorizationTargetSchema = z.discriminatedUnion("kind", [
  policyTargetSchema,
  bearerKeyTargetSchema,
  recipientDidTargetSchema,
]);

/**
 * THE canonical resource-path grammar — the ONE grammar shared by schema
 * validation here and capability coverage in bearer-delegation.ts (which
 * previously compared raw concatenated strings, so `shares/s/../victim.md`
 * aliased into a `shares/s/*` grant). A canonical path is "/"-joined
 * segments where every segment is non-empty (no `//`, no leading/trailing
 * slash) and none is `.` or `..`, and the whole string contains no
 * backslash, no ASCII control characters, and no percent-encoded
 * separator/dot aliases (%2f, %5c, %2e in any casing). Fail closed: anything
 * outside this grammar is rejected before any comparison happens.
 */
export function isCanonicalResourcePath(value: string): boolean {
  if (value.length === 0) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (/%2f|%5c|%2e/i.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** ONE canonical path segment: canonical-path rules, and no separator at all. */
export function isCanonicalPathSegment(value: string): boolean {
  return isCanonicalResourcePath(value) && !value.includes("/");
}

export const resourceSelectorSchema = z
  .object({
    kind: z.union([z.literal("exact"), z.literal("prefix")]),
    path: z.string().min(1),
  })
  .strict()
  .superRefine((selector, ctx) => {
    // Prefix selectors may carry ONE trailing "/" (folder convention);
    // the body must be canonical either way.
    const body =
      selector.kind === "prefix" && selector.path.endsWith("/")
        ? selector.path.slice(0, -1)
        : selector.path;
    if (!isCanonicalResourcePath(body)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message:
          "expected a canonical resource path (non-empty segments, no . or .. segments, no //, no backslash, no %2f/%5c/%2e, no control chars)",
      });
    }
  });

export const targetSchema = z
  .object({
    origin: z.string().refine(isCanonicalHttpsOrigin, {
      message: "expected a canonical https origin (https://host[:port], nothing else)",
    }),
    nodeAudience: z.string().min(1),
    spaceId: z.string().refine(isCanonicalPathSegment, {
      message:
        "expected a single canonical path segment (spaceId joins the resource URI; separators/traversal would alias grants)",
    }),
    resource: resourceSelectorSchema,
  })
  .strict();

export const displaySchema = z
  .object({
    senderName: z.string().optional(),
    filename: z.string().optional(),
    recipientHint: z.string().optional(),
    /**
     * Presentation preference only (viewer spec §1): may narrow, never widen;
     * capabilities always win.
     */
    mode: z.union([z.literal("document"), z.literal("source"), z.literal("folder")]).optional(),
  })
  .strict();

/**
 * BEARER-SLICE content pointer (stage 4). The shared file's bytes are sealed
 * as their OWN AEAD blob (same `seal` machinery as the envelope) and put in
 * the registry; this field points at it:
 *
 * - `cid`  — CIDv1/raw/sha2-256 of the sealed content blob. The viewer
 *   re-verifies fetched bytes against it (trustless), so a lying registry
 *   cannot substitute content.
 * - `key`  — the content blob's own 32-byte AES-256-GCM key, base64url. It
 *   rides INSIDE the sealed envelope (confidential to link holders) and is
 *   signature-covered like every other field (a tampered pointer fails the
 *   envelope signature before any fetch). Carrying a distinct key — rather
 *   than reusing the fragment key — preserves the viewer's key-hygiene
 *   contract: the fragment key is still dead (zeroed) the moment the
 *   envelope is decrypted.
 *
 * This is a bearer-slice mechanism: possession of the link IS the read
 * authority, so the content is fetched straight from the registry. In the
 * policy / recipient-DID slices this field is absent and the viewer instead
 * performs a capability-gated read from the node named in `target` — the
 * node, not the registry, is the enforcement boundary there.
 */
export const contentPointerSchema = z
  .object({
    cid: z.string().refine(isCanonicalRawCid, {
      message: "expected a canonical CIDv1 raw sha2-256 base32 CID",
    }),
    key: z.string().refine((value) => decodeBase64UrlOrNull(value)?.length === 32, {
      message: "expected base64url decoding to exactly 32 bytes",
    }),
  })
  .strict();

export const signatureSchema = z
  .object({
    /** did:key of the sender's ed25519 signing key. */
    signerDid: z.string().regex(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/, "expected a did:key"),
    algorithm: z.literal("Ed25519"),
    /** base64url-encoded ed25519 signature over the JCS bytes of all other fields. */
    value: z.string().refine((value) => decodeBase64UrlOrNull(value)?.length === 64, {
      message: "expected base64url decoding to exactly 64 bytes",
    }),
  })
  .strict();

/** Envelope body — every signature-covered field. */
export const unsignedShareEnvelopeSchema = z
  .object({
    version: z.literal(1),
    shareId: z.string().min(1),
    /** Full signed delegation chain, opaque serialized form. */
    delegation: z.string().min(1),
    authorizationTarget: authorizationTargetSchema,
    target: targetSchema,
    display: displaySchema,
    /** ISO 8601 UTC datetime. Advisory here; enforcement is the delegation's. */
    expiry: z.string().datetime(),
    /** Bearer-slice sealed-content pointer (see contentPointerSchema). */
    content: contentPointerSchema.optional(),
  })
  .strict();

export const shareEnvelopeSchema = unsignedShareEnvelopeSchema
  .extend({ signature: signatureSchema })
  .strict();

export type SessionJwk = z.infer<typeof sessionJwkSchema>;
export type ContentPointer = z.infer<typeof contentPointerSchema>;
export type PolicyTarget = z.infer<typeof policyTargetSchema>;
export type BearerKeyTarget = z.infer<typeof bearerKeyTargetSchema>;
export type RecipientDidTarget = z.infer<typeof recipientDidTargetSchema>;
export type AuthorizationTarget = z.infer<typeof authorizationTargetSchema>;
export type ResourceSelector = z.infer<typeof resourceSelectorSchema>;
export type ShareTarget = z.infer<typeof targetSchema>;
export type ShareDisplay = z.infer<typeof displaySchema>;
export type EnvelopeSignature = z.infer<typeof signatureSchema>;
export type UnsignedShareEnvelope = z.infer<typeof unsignedShareEnvelopeSchema>;
export type ShareEnvelope = z.infer<typeof shareEnvelopeSchema>;

/** Version 2 additions shared by the browser composer and recipient SDK. */
export const recipientMatcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exactEmail"), value: z.string().min(3).regex(/^[^@\s]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/) }).strict(),
  z.object({ kind: z.literal("emailDomain"), value: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/) }).strict(),
  z.object({ kind: z.literal("policyDigest"), value: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  z.object({ kind: z.literal("bearer") }).strict(),
]);

export const shareActionSchema = z.union([z.literal("read"), z.literal("list"), z.literal("edit")]);

/** The source selector is shared byte-for-byte by the envelope, policy, and
 * native Node request.  It deliberately describes a named operation, never
 * executable SQL or a browser-controlled URL. */
const kvContentSourceSchema = z.object({
  kind: z.literal("kv"),
  space: z.string().min(1),
  path: z.string().min(1),
  action: z.literal("tinycloud.kv/get"),
}).strict();
const sqlContentSourceSchema = z.object({
  kind: z.literal("sql"),
  space: z.string().min(1),
  database: z.string().min(1),
  path: z.string().min(1),
  statement: z.string().min(1),
  arguments: z.record(z.string(), z.number().int()),
  argumentsDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  action: z.literal("tinycloud.sql/read"),
}).strict();
export const contentSourceSchema = z.discriminatedUnion("kind", [kvContentSourceSchema, sqlContentSourceSchema]);

export const v2TargetSchema = z.object({
  origin: z.string().refine(isCanonicalHttpsOrigin, { message: "expected a canonical https origin" }),
  nodeAudience: z.string().min(1),
  spaceId: z.string().refine(isCanonicalPathSegment, { message: "expected a canonical space id" }),
}).strict();

const ownerAuthoritySchema = z.object({
  registrationCid: z.string().min(1),
  shareCid: z.string().min(1),
  envelopeCid: z.string().min(1),
  enforcementDelegation: z.record(z.string(), z.unknown()),
  outerEnvelope: z.record(z.string(), z.unknown()),
}).strict();

export const contentMetadataSchema = z.object({
  mediaType: z.string().min(1).max(128).optional(),
  byteLength: z.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
  filename: z.string().min(1).max(255).optional(),
  encoding: z.literal("utf-8").optional(),
}).strict();

const unsignedShareEnvelopeV2BaseSchema = z.object({
  version: z.literal(2),
  shareId: z.string().min(1),
  recipientMatcher: recipientMatcherSchema,
  deliveryEmail: z.string().email().optional(),
  actions: z.array(shareActionSchema).min(1).max(3),
  resource: resourceSelectorSchema,
  target: v2TargetSchema,
  delegationCid: z.string().min(1),
  authorityMaterialHandle: z.string().min(1),
  authorityMaterialDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  contentSource: contentSourceSchema,
  contentSourceDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  authorizationTarget: authorizationTargetSchema,
  display: displaySchema,
  expiry: z.string().datetime(),
  encrypted: z.boolean(),
  content: contentPointerSchema.optional(),
  metadata: contentMetadataSchema,
  ownerAuthority: ownerAuthoritySchema.optional(),
}).strict();

function validateV2Invariants(value: z.infer<typeof unsignedShareEnvelopeV2BaseSchema>, ctx: z.RefinementCtx): void {
  const actions = [...value.actions];
  if (new Set(actions).size !== actions.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "actions must be unique" });
  if (actions.some((action, index) => action !== (["read", "list", "edit"] as const).filter((candidate) => actions.includes(candidate))[index])) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "actions must be canonically ordered" });
  if (!value.encrypted && value.recipientMatcher.kind !== "policyDigest") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipientMatcher"], message: "safe plaintext must carry only a matcher digest" });
  if (!value.encrypted && value.authorizationTarget.kind !== "policy") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["encrypted"], message: "unencrypted content requires a policy target" });
  if (!value.encrypted && value.content !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "policy-only plaintext cannot carry content" });
  if (value.encrypted && (value.metadata.mediaType === undefined || value.metadata.filename === undefined || value.metadata.byteLength === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["metadata"], message: "encrypted shares must describe their content" });
  if (!value.encrypted && Object.keys(value.metadata).length !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["metadata"], message: "policy-only plaintext cannot describe content" });
  if (!value.encrypted && value.metadata.encoding !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["metadata", "encoding"], message: "policy-only plaintext cannot carry content encoding" });
  if (!value.encrypted && (value.display.senderName !== undefined || value.display.filename !== undefined || value.display.recipientHint !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["display"], message: "policy-only plaintext cannot carry display metadata" });
  if (!value.encrypted && value.deliveryEmail !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deliveryEmail"], message: "policy-only plaintext cannot carry delivery metadata" });
  if (value.recipientMatcher.kind === "exactEmail" && value.deliveryEmail !== undefined && value.deliveryEmail !== value.recipientMatcher.value) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deliveryEmail"], message: "delivery email must match the exact matcher" });
  if (value.recipientMatcher.kind === "emailDomain" && value.deliveryEmail !== undefined && value.deliveryEmail.toLowerCase().endsWith(`@${value.recipientMatcher.value}`) === false) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deliveryEmail"], message: "delivery email must belong to the matcher domain" });
  if (value.contentSource.kind === "kv" && value.contentSource.action !== "tinycloud.kv/get") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contentSource"], message: "source action mismatch" });
  if (value.contentSource.kind === "sql" && value.contentSource.action !== "tinycloud.sql/read") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contentSource"], message: "source action mismatch" });
}

export const unsignedShareEnvelopeV2Schema = unsignedShareEnvelopeV2BaseSchema.superRefine(validateV2Invariants);

// Extend the unsigned object instead of intersecting two strict objects. A
// strict intersection rejects every valid signed envelope because each side
// treats the other side's fields as unknown.
export const shareEnvelopeV2Schema = unsignedShareEnvelopeV2BaseSchema.extend({ signature: signatureSchema }).strict().superRefine(validateV2Invariants);
export type RecipientMatcher = z.infer<typeof recipientMatcherSchema>;
export type ShareAction = z.infer<typeof shareActionSchema>;
export type ContentSource = z.infer<typeof contentSourceSchema>;
export type ContentMetadata = z.infer<typeof contentMetadataSchema>;
export type UnsignedShareEnvelopeV2 = z.infer<typeof unsignedShareEnvelopeV2Schema>;
export type ShareEnvelopeV2 = z.infer<typeof shareEnvelopeV2Schema>;
