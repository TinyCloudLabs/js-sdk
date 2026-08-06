import { ed25519 } from "@noble/curves/ed25519";
import { canonicalizeSignedObjectUnsigned as canonicalize } from "../policy/signed-object.js";
import type { JsonValue } from "../policy/jcs.js";

export const SHARE_DELIVERY_AUTHORIZATION_V3_DOMAIN = "xyz.tinycloud.share/delivery-authorization/v3\0";

export interface ShareDeliveryAuthorizationV3Request {
  readonly envelope: JsonValue;
  readonly sealedEnvelope: string;
  readonly envelopeKey: string;
  readonly shareCid: string;
  readonly recipientEmail: string;
  readonly shareUrl: string;
  readonly documentName: string;
  readonly jti: string;
  readonly expiresAt: string;
  readonly requestBodyDigest: string;
}

export interface ShareDeliveryAuthorizationV3 {
  readonly type: "TinyCloudShareDeliveryAuthorization";
  readonly version: 3;
  readonly jti: string;
  readonly shareCid: string;
  readonly shareId: string;
  readonly policyCid: string;
  readonly policyRootCid: string;
  readonly enforcementRootCid: string;
  readonly nodeAudience: string;
  readonly enforcerDid: string;
  readonly targetOrigin: string;
  readonly openCredentialsAudience: string;
  readonly holder: string;
  readonly recipientMatcher: unknown;
  readonly deliveryEmail: string;
  readonly shareUrl: string;
  readonly returnOrigin: string;
  readonly documentName: string;
  readonly senderDid: string;
  readonly senderTrust: string;
  readonly contentSource: unknown;
  readonly contentSourceDigestHex: string;
  readonly shareExpiresAt: string;
  readonly issuedAt: string;
  readonly reportAbuseToken: string;
  readonly actions: readonly string[];
  readonly resource: string;
  readonly requestBodyDigest: string;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
  readonly dataAuthority: false;
}

export interface ShareDeliveryAuthorizationV3Receipt {
  readonly authorization: ShareDeliveryAuthorizationV3;
  readonly proof: { readonly alg: "EdDSA"; readonly kid: string; readonly signature: string };
}

const AUTHORIZATION_KEYS = [
  "type", "version", "jti", "shareCid", "shareId", "policyCid", "policyRootCid",
  "enforcementRootCid", "nodeAudience", "enforcerDid", "targetOrigin",
  "openCredentialsAudience", "holder", "recipientMatcher", "deliveryEmail", "shareUrl",
  "returnOrigin", "documentName", "senderDid", "senderTrust", "contentSource",
  "contentSourceDigestHex", "shareExpiresAt", "issuedAt", "reportAbuseToken", "actions",
  "resource", "requestBodyDigest", "idempotencyKey", "expiresAt", "dataAuthority",
] as const;

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) throw new Error(`${label} has unknown or missing fields`);
  return record;
}

function decodeBase64Url(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("share delivery value is not canonical base64url");
  if (typeof atob === "function") {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64url"));
  throw new Error("base64url decoding is unavailable");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

export function validateShareDeliveryAuthorizationV3Bytes(
  bytes: Uint8Array,
  expected: {
    readonly request: ShareDeliveryAuthorizationV3Request;
    readonly nodeProof: { readonly kid: string; readonly publicKey: Uint8Array };
    readonly credentialsAudience: string;
  },
): ShareDeliveryAuthorizationV3Receipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("v3 share delivery response is not valid UTF-8 JSON");
  }
  const root = exactObject(parsed, ["authorization", "proof"], "v3 share delivery response");
  const authorization = exactObject(root.authorization, AUTHORIZATION_KEYS, "v3 share delivery authorization");
  const proof = exactObject(root.proof, ["alg", "kid", "signature"], "v3 share delivery proof");
  const envelope = object(expected.request.envelope, "v3 share envelope");
  const policyRoot = object(envelope.policyRoot, "v3 policy root");
  const enforcementRoot = object(envelope.enforcementRoot, "v3 enforcement root");
  const target = object(envelope.target, "v3 target");
  const display = object(envelope.display, "v3 display");
  const resource = object(envelope.resource, "v3 resource");
  const envelopeSignature = object(envelope.signature, "v3 envelope signature");
  const shareUrl = new URL(expected.request.shareUrl);
  const targetOrigin = String(target.origin);
  const targetUrl = new URL(targetOrigin);
  const targetHost = targetUrl.hostname;
  const expectedNodeAudience = `did:web:${targetHost}`;
  if (
    authorization.type !== "TinyCloudShareDeliveryAuthorization"
    || authorization.version !== 3
    || authorization.dataAuthority !== false
    || authorization.jti !== expected.request.jti
    || authorization.shareCid !== expected.request.shareCid
    || authorization.shareId !== envelope.shareId
    || authorization.policyCid !== envelope.policyCid
    || authorization.policyRootCid !== policyRoot.cid
    || authorization.enforcementRootCid !== enforcementRoot.cid
    || authorization.enforcerDid !== target.nodeAudience
    || authorization.targetOrigin !== target.origin
    || authorization.nodeAudience !== expectedNodeAudience
    || expected.nodeProof.kid.split("#", 1)[0] !== expectedNodeAudience
    || authorization.recipientMatcher === undefined
    || canonicalize(authorization.recipientMatcher) !== canonicalize(envelope.recipientMatcher)
    || canonicalize(authorization.contentSource) !== canonicalize(envelope.contentSource)
    || authorization.contentSourceDigestHex !== envelope.contentSourceDigestHex
    || authorization.deliveryEmail !== expected.request.recipientEmail
    || authorization.shareUrl !== expected.request.shareUrl
    || authorization.documentName !== expected.request.documentName
    || authorization.documentName !== display.filename
    || authorization.senderDid !== envelopeSignature.signerDid
    || authorization.senderTrust !== "verified"
    || canonicalize(authorization.actions) !== canonicalize(envelope.actions)
    || authorization.resource !== resource.path
    || authorization.shareExpiresAt !== envelope.expiry
    || authorization.requestBodyDigest !== expected.request.requestBodyDigest
    || authorization.expiresAt !== expected.request.expiresAt
    || authorization.idempotencyKey !== expected.request.jti
    || authorization.reportAbuseToken !== expected.request.jti
    || authorization.returnOrigin !== shareUrl.origin
    || shareUrl.pathname !== `/s/${authorization.shareCid}`
    || shareUrl.hash !== `#k=${expected.request.envelopeKey}`
    || targetUrl.protocol !== "https:"
    || shareUrl.protocol !== "https:"
  ) throw new Error("v3 share delivery authorization is not bound to the submitted request");
  if (
    typeof authorization.openCredentialsAudience !== "string"
    || authorization.openCredentialsAudience !== expected.credentialsAudience
    || authorization.openCredentialsAudience === authorization.nodeAudience
    || authorization.openCredentialsAudience === authorization.returnOrigin
  ) throw new Error("v3 share delivery credentials audience is untrusted");
  if (proof.alg !== "EdDSA" || proof.kid !== expected.nodeProof.kid || typeof proof.signature !== "string") throw new Error("v3 share delivery proof is invalid");
  const issuedAt = Date.parse(String(authorization.issuedAt));
  const expiresAt = Date.parse(String(authorization.expiresAt));
  const shareExpiresAt = Date.parse(String(authorization.shareExpiresAt));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(shareExpiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 5 * 60_000 || shareExpiresAt <= issuedAt || typeof authorization.holder !== "string" || !authorization.holder.startsWith("did:")) throw new Error("v3 share delivery authorization time or holder is invalid");
  const publicKey = expected.nodeProof.publicKey.length === 34 ? expected.nodeProof.publicKey.slice(2) : expected.nodeProof.publicKey;
  const signature = decodeBase64Url(proof.signature);
  const signed = new TextEncoder().encode(`${SHARE_DELIVERY_AUTHORIZATION_V3_DOMAIN}${canonicalize(authorization)}`);
  if (publicKey.length !== 32 || signature.length !== 64 || !ed25519.verify(signature, signed, publicKey)) throw new Error("v3 share delivery proof signature is invalid");
  return { authorization: authorization as unknown as ShareDeliveryAuthorizationV3, proof: proof as unknown as ShareDeliveryAuthorizationV3Receipt["proof"] };
}
