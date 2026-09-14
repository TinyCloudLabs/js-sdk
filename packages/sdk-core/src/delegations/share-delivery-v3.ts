import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import { canonicalizeSignedObjectUnsigned as canonicalize } from "../policy/signed-object.js";

export const CREDENTIAL_INVITATION_REQUEST_DOMAIN = "xyz.tinycloud.credentials/invitation-request/v1\0";
export const DELIVERY_ADMISSION_DOMAIN = "xyz.tinycloud.policy/delivery-admission/v0\0";

export interface ShareDeliveryAuthorizationV3Request {
  readonly envelope: Record<string, unknown>;
  readonly shareCid: string;
  readonly recipientEmail: string;
  readonly shareUrl: string;
  readonly documentName: string;
  readonly jti: string;
  readonly expiresAt: string;
  readonly requestBodyDigest: string;
}

export interface CredentialInvitationRequest {
  readonly schema: "xyz.tinycloud.credentials/invitation-request/v1";
  readonly policyId: string;
  readonly recipient: string;
  readonly resource: string;
  readonly credentialType: string;
  readonly returnLink: string;
  readonly envelopeRef: string;
  readonly label: string;
  readonly shareExpiresAt: string;
  readonly audience: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface DeliveryAdmission {
  readonly schema: "xyz.tinycloud.policy/delivery-admission/v0";
  readonly policyId: string;
  readonly ownerDid: string;
  readonly recipient: string;
  readonly resource: string;
  readonly actions: readonly ["tinycloud.kv/get"];
  readonly credentialType: string;
  readonly returnLink: string;
  readonly envelopeRef: string;
  readonly label: string;
  readonly shareExpiresAt: string;
  readonly senderKeyDid: string;
  readonly audience: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly signature: {
    readonly suite: "eddsa-ed25519-sha256-jcs-v1";
    readonly signerDid: string;
    readonly value: string;
  };
}

export interface ShareDeliveryAuthorizationV3Receipt {
  readonly request: CredentialInvitationRequest;
  readonly admission: DeliveryAdmission;
  readonly proof: { readonly alg: "EdDSA"; readonly kid: string; readonly signature: string };
}

const REQUEST_KEYS = ["schema", "policyId", "recipient", "resource", "credentialType", "returnLink", "envelopeRef", "label", "shareExpiresAt", "audience", "issuedAt", "expiresAt", "nonce"] as const;
const ADMISSION_KEYS = ["schema", "policyId", "ownerDid", "recipient", "resource", "actions", "credentialType", "returnLink", "envelopeRef", "label", "shareExpiresAt", "senderKeyDid", "audience", "issuedAt", "expiresAt", "nonce", "signature"] as const;

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

function didKeyBytes(did: string): Uint8Array {
  if (!did.startsWith("did:key:z") || /[#/?]/.test(did.slice("did:key:".length))) throw new Error("v3 delivery admission signer is invalid");
  const decoded = base58btc.decode(did.slice("did:key:".length));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) throw new Error("v3 delivery admission signer is invalid");
  return decoded.slice(2);
}

export function validateShareDeliveryAuthorizationV3Bytes(
  bytes: Uint8Array,
  expected: {
    readonly request: ShareDeliveryAuthorizationV3Request;
    readonly senderKeyDid: string;
    readonly deliveryAudience: string;
  },
): Omit<ShareDeliveryAuthorizationV3Receipt, "proof"> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("v3 share delivery response is not valid UTF-8 JSON"); }
  const root = exactObject(parsed, ["request", "admission"], "v3 share delivery response");
  const request = exactObject(root.request, REQUEST_KEYS, "credential invitation request");
  const admission = exactObject(root.admission, ADMISSION_KEYS, "delivery admission");
  const signature = exactObject(admission.signature, ["suite", "signerDid", "value"], "delivery admission signature");
  const envelope = object(expected.request.envelope, "v3 share envelope");
  const policy = object(envelope.policy, "v3 share policy");
  const requirement = object(policy.credentialRequirement, "v3 credential requirement");
  const credentialType = object(requirement.credentialType, "v3 credential type");
  const contentSource = object(envelope.contentSource, "v3 content source");
  const envelopeSignature = object(envelope.signature, "v3 envelope signature");
  const target = object(envelope.target, "v3 target");
  const binding = object(envelope.attestedEnforcerBinding, "v3 attested enforcer binding");
  const fields = ["policyId", "recipient", "resource", "credentialType", "returnLink", "envelopeRef", "label", "shareExpiresAt", "audience", "issuedAt", "expiresAt", "nonce"];
  if (
    request.schema !== "xyz.tinycloud.credentials/invitation-request/v1"
    || admission.schema !== "xyz.tinycloud.policy/delivery-admission/v0"
    || fields.some((field) => request[field] !== admission[field])
    || request.policyId !== envelope.policyCid
    || request.recipient !== expected.request.recipientEmail
    || request.resource !== contentSource.kvResource
    || request.credentialType !== credentialType.id
    || request.credentialType !== "opencredentials.email/v1"
    || request.returnLink !== expected.request.shareUrl
    || request.envelopeRef !== expected.request.shareCid
    || request.label !== expected.request.documentName
    || request.shareExpiresAt !== envelope.expiry
    || request.audience !== expected.deliveryAudience
    || request.expiresAt !== expected.request.expiresAt
    || request.nonce !== expected.request.jti
    || admission.ownerDid !== envelopeSignature.signerDid
    || admission.senderKeyDid !== expected.senderKeyDid
    || canonicalize(admission.actions) !== canonicalize(["tinycloud.kv/get"])
    || signature.suite !== "eddsa-ed25519-sha256-jcs-v1"
    || target.nodeAudience !== binding.nodeAudience
    || signature.signerDid !== binding.nodeAudience
  ) throw new Error("v3 share delivery authorization is not bound to the submitted request");
  const issuedAt = Date.parse(String(request.issuedAt));
  const expiresAt = Date.parse(String(request.expiresAt));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 15 * 60_000) throw new Error("v3 share delivery authorization time is invalid");
  const admissionSignature = decodeBase64Url(signature.value);
  const { signature: _signature, ...unsignedAdmission } = admission;
  const digest = sha256(new TextEncoder().encode(`${DELIVERY_ADMISSION_DOMAIN}${canonicalize(unsignedAdmission)}`));
  if (admissionSignature.length !== 64 || !ed25519.verify(admissionSignature, digest, didKeyBytes(String(signature.signerDid)))) throw new Error("v3 share delivery admission signature is invalid");
  return { request: request as unknown as CredentialInvitationRequest, admission: admission as unknown as DeliveryAdmission };
}
