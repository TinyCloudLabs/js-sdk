import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { canonicalizeSignedObjectUnsigned as canonicalize } from "../policy/signed-object.js";

/** Matches V2_DELIVERY_DOMAIN in tinycloud-node-server/src/share_v2.rs. */
export const SHARE_DELIVERY_AUTHORIZATION_DOMAIN = "xyz.tinycloud.share/delivery-authorization/v2\0";

/** Exact camelCase mirror of the Rust `V2DeliveryRequest` wire struct. */
export interface ShareDeliveryAuthorizationRequest {
  readonly envelopeCid: string;
  readonly shareCid: string;
  readonly shareId: string;
  readonly registrationCid: string;
  readonly policyCid: string;
  readonly delegationCid: string;
  readonly enforcementDelegationCid: string;
  readonly recipientEmail: string;
  readonly shareUrl: string;
  readonly documentName: string;
  readonly jti: string;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
  readonly requestBodyDigest: string;
}

/** Exact mirror of the `authorization` object the Node route signs and returns. */
export interface ShareDeliveryAuthorization {
  readonly type: "TinyCloudShareDeliveryAuthorization";
  readonly version: 2;
  readonly jti: string;
  readonly shareCid: string;
  readonly shareId: string;
  readonly registrationCid: string;
  readonly delegationCid: string;
  readonly enforcementDelegationCid: string;
  readonly envelopeCid: string;
  readonly policyCid: string;
  readonly nodeAudience: string;
  readonly targetOrigin: string;
  /**
   * The OpenCredentials witness this delivery is scoped to, sourced from
   * Node's own trusted credentials origin. Deliberately distinct from
   * `nodeAudience` (the node's own DID) and `returnOrigin` (Share's page
   * origin) — conflating any of these three would let a party impersonate
   * another's audience.
   */
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
  readonly contentSourceDigest: string;
  readonly shareExpiresAt: string;
  readonly issuedAt: string;
  readonly reportAbuseToken: string;
  readonly actions: readonly string[];
  readonly resource: string;
  readonly authorityMaterialHandle: string;
  readonly authorityMaterialDigest: string;
  readonly requestBodyDigest: string;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
  readonly dataAuthority: false;
}

export interface ShareDeliveryAuthorizationReceipt {
  readonly authorization: ShareDeliveryAuthorization;
  readonly proof: { readonly alg: "EdDSA"; readonly kid: string; readonly signature: string };
}

export interface ValidateShareDeliveryAuthorizationExpected {
  readonly request: ShareDeliveryAuthorizationRequest;
  /** The enrolled receipt key from the node trust bundle. */
  readonly nodeProof: { readonly kid: string; readonly publicKey: Uint8Array };
  /**
   * The OpenCredentials witness origin the caller trusts, from the same
   * trust bundle as `nodeProof`. Validated independently of the
   * authorization's own `nodeAudience`/`returnOrigin` fields so a Node that
   * mislabels or omits its credentials origin fails closed here rather than
   * silently inheriting one of those unrelated identities.
   */
  readonly credentialsAudience: string;
}

/** Matches `canonical_https_origin` in tinycloud-node-server/src/config.rs. */
function isCanonicalHttpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && url.origin === value
    && url.pathname === "/"
    && url.search === ""
    && url.hash === ""
    && url.username === ""
    && url.password === "";
}

const AUTHORIZATION_KEYS = [
  "type", "version", "jti", "shareCid", "shareId", "registrationCid", "delegationCid",
  "enforcementDelegationCid", "envelopeCid", "policyCid", "nodeAudience", "targetOrigin",
  "openCredentialsAudience",
  "holder", "recipientMatcher", "deliveryEmail", "shareUrl", "returnOrigin", "documentName",
  "senderDid", "senderTrust", "contentSource", "contentSourceDigest", "shareExpiresAt",
  "issuedAt", "reportAbuseToken", "actions", "resource", "authorityMaterialHandle",
  "authorityMaterialDigest", "requestBodyDigest", "idempotencyKey", "expiresAt", "dataAuthority",
] as const;

function assertObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) throw new Error(`${label} has unknown or missing fields`);
  return record;
}

function fromB64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("share delivery value is not canonical base64url");
  if (typeof atob === "function") {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64url"));
  throw new Error("base64url decoding is unavailable");
}

/**
 * Validate the exact UTF-8 response bytes emitted by
 * `POST /share/v2/deliveries/authorize`, bind them to the submitted
 * request, and verify the Node's detached EdDSA proof.
 */
export function validateShareDeliveryAuthorizationBytes(bytesValue: Uint8Array, expected: ValidateShareDeliveryAuthorizationExpected): ShareDeliveryAuthorizationReceipt {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytesValue));
  } catch {
    throw new Error("share delivery authorization response is not valid UTF-8 JSON");
  }
  const root = assertObject(value, ["authorization", "proof"], "share delivery authorization response");
  const authorization = assertObject(root.authorization, AUTHORIZATION_KEYS, "share delivery authorization");
  const proof = assertObject(root.proof, ["alg", "kid", "signature"], "share delivery authorization proof");

  const request = expected.request;
  if (
    authorization.type !== "TinyCloudShareDeliveryAuthorization"
    || authorization.version !== 2
    || authorization.dataAuthority !== false
    || authorization.jti !== request.jti
    || authorization.shareCid !== request.shareCid
    || authorization.shareId !== request.shareId
    || authorization.registrationCid !== request.registrationCid
    || authorization.delegationCid !== request.delegationCid
    || authorization.enforcementDelegationCid !== request.enforcementDelegationCid
    || authorization.envelopeCid !== request.envelopeCid
    || authorization.policyCid !== request.policyCid
    || authorization.deliveryEmail !== request.recipientEmail
    || authorization.shareUrl !== request.shareUrl
    || authorization.documentName !== request.documentName
    || authorization.requestBodyDigest !== request.requestBodyDigest
    || authorization.expiresAt !== request.expiresAt
    || authorization.idempotencyKey !== request.idempotencyKey
    || authorization.reportAbuseToken !== request.jti
    || authorization.authorityMaterialHandle !== request.registrationCid
  ) {
    throw new Error("share delivery authorization is not bound to the submitted request");
  }
  if (typeof authorization.issuedAt !== "string" || Date.parse(authorization.issuedAt) > Date.now() + 60_000) throw new Error("share delivery authorization issuedAt is invalid");
  if (new Date(authorization.expiresAt as string).toISOString() !== authorization.expiresAt) throw new Error("share delivery authorization expiresAt is non-canonical");

  // Independent audience check: the OpenCredentials witness field must be a
  // canonical https origin, must equal the caller's own trusted value (never
  // derived from the response), and must not collapse into the node's own
  // audience or Share's return origin.
  if (
    typeof authorization.openCredentialsAudience !== "string"
    || !isCanonicalHttpsOrigin(authorization.openCredentialsAudience)
    || authorization.openCredentialsAudience !== expected.credentialsAudience
    || authorization.openCredentialsAudience === authorization.nodeAudience
    || authorization.openCredentialsAudience === authorization.returnOrigin
  ) {
    throw new Error("share delivery authorization openCredentialsAudience is missing or untrusted");
  }

  if (proof.alg !== "EdDSA" || typeof proof.kid !== "string" || typeof proof.signature !== "string") throw new Error("share delivery authorization proof is invalid");
  if (proof.kid !== expected.nodeProof.kid) throw new Error("share delivery authorization proof key is not trusted");
  const encodedKid = expected.nodeProof.publicKey;
  const publicKey = encodedKid.length === 34 && encodedKid[0] === 0xed && encodedKid[1] === 0x01 ? encodedKid.slice(2) : encodedKid;
  if (publicKey.length !== 32) throw new Error("share delivery authorization proof key is invalid");
  const signatureBytes = fromB64(proof.signature);
  const signedBytes = new TextEncoder().encode(`${SHARE_DELIVERY_AUTHORIZATION_DOMAIN}${canonicalize(authorization)}`);
  if (signatureBytes.length !== 64 || !ed25519.verify(signatureBytes, signedBytes, publicKey)) throw new Error("share delivery authorization proof signature is invalid");

  return { authorization: authorization as unknown as ShareDeliveryAuthorization, proof: proof as unknown as ShareDeliveryAuthorizationReceipt["proof"] };
}

/** Build the trusted-signer descriptor `did:key:...#z...` expects from a raw node signing key. */
export function shareDeliveryTrustedKid(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("share delivery node key must be a raw 32-byte Ed25519 public key");
  const prefixed = new Uint8Array(34);
  prefixed.set([0xed, 0x01]);
  prefixed.set(publicKey, 2);
  const did = `did:key:${base58btc.encode(prefixed)}`;
  return `${did}#${did.slice("did:key:".length)}`;
}
