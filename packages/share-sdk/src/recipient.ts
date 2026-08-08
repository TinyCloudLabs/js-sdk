import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import {
  canonicalize,
  ed25519PublicKeyFromDidKey,
  fromBase64Url,
  signCompactUcanAuthorization,
  toBase64Url,
  verifyCompactUcanAuthorization,
  type ShareEnvelopeV2,
  type ShareEnvelopeV3,
} from "@tinycloud/share-envelope";
import type { ShareAuthorizationAdapter, ShareAuthorizedContent, ShareAuthorizationResult } from "./authorization.js";
import { SHARE_V2_PROTOCOL } from "./protocol.js";

export interface ShareNodeTrust {
  readonly invitationKid: string;
  readonly invitationPublicKey: Uint8Array;
}

export interface SharePresentationMaterial {
  readonly holderDid: string;
  readonly credential: string;
  readonly credentialDigest?: string;
  readonly holderBinding: Record<string, unknown>;
  readonly proof: Record<string, unknown>;
  readonly sign?: (bytes: Uint8Array) => Promise<Uint8Array>;
  readonly email?: string;
  /** Exact v3 credential claim returned by the verified holder ceremony. */
  readonly claim?: Record<string, unknown>;
  /** Exact v3 presentation returned by the verified holder ceremony. */
  readonly presentation?: Record<string, unknown>;
  /** Exact verified issuer envelope used by accountless v4 admission. */
  readonly credentialEnvelope?: Record<string, unknown>;
  /** Exact credential requirement committed by the signed policy. */
  readonly requirement?: Record<string, unknown>;
}

export interface SharePolicyChallenge {
  readonly challengeId: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly enforcerDid?: string;
  readonly action: string;
  readonly requestBodyDigest: string;
  readonly [key: string]: unknown;
}

export interface ShareRecipientClientOptions {
  readonly nodeOrigin: string;
  readonly trustedNode: ShareNodeTrust;
  readonly holderDid: string;
  readonly envelope: ShareEnvelopeV2 | ShareEnvelopeV3;
  readonly fetchFn?: typeof fetch;
  readonly buildPresentation?: (input: { readonly challenge: SharePolicyChallenge; readonly envelope: ShareEnvelopeV2 | ShareEnvelopeV3; readonly policy: Record<string, unknown> }) => Promise<SharePresentationMaterial>;
  readonly sign?: (bytes: Uint8Array) => Promise<Uint8Array>;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: "policy-admission" | "delegation-import" | "invocation" | "decryption") => void;
  /** Previously admitted and imported ordinary policy delegation (account v3 fast path). */
  readonly policyAuthorization?: { readonly authorization: string; readonly cid: string };
}

export interface SharePolicySession {
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly actions: readonly ("read" | "list" | "edit")[];
  readonly resource: { readonly kind: "exact" | "prefix"; readonly path: string };
}

const DOMAIN = SHARE_V2_PROTOCOL.challengeDomain;
const PRESENTATION_DOMAIN = SHARE_V2_PROTOCOL.sessionDomain;
const SESSION_DOMAIN = SHARE_V2_PROTOCOL.sessionDomain;
const INVOCATION_DOMAIN = SHARE_V2_PROTOCOL.invocationDomain;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function bytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is invalid`);
  const decoded = fromBase64Url(value);
  if (decoded.length !== 64 || toBase64Url(decoded) !== value) throw new Error(`${label} is invalid`);
  return decoded;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += BASE64_ALPHABET[(b0 >> 2) & 0x3f];
    out += BASE64_ALPHABET[((b0 << 4) | (b1 >> 4)) & 0x3f];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 << 2) | (b2 >> 6)) & 0x3f] : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

function fromBase64(value: string, label: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - padding);
  let outIdx = 0;
  for (let i = 0; i < value.length; i += 4) {
    const v0 = BASE64_ALPHABET.indexOf(value[i]!);
    const v1 = BASE64_ALPHABET.indexOf(value[i + 1]!);
    const v2 = value[i + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[i + 2]!);
    const v3 = value[i + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[i + 3]!);
    const b0 = (v0 << 2) | (v1 >> 4);
    const b1 = ((v1 & 0x0f) << 4) | (v2 >> 2);
    const b2 = ((v2 & 0x03) << 6) | v3;
    if (outIdx < out.length) out[outIdx++] = b0;
    if (outIdx < out.length) out[outIdx++] = b1;
    if (outIdx < out.length) out[outIdx++] = b2;
  }
  if (toBase64(out) !== value) throw new Error(`${label} is invalid`);
  return out;
}

async function digest(value: unknown): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalize(value)))));
}

async function digestText(value: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function digestBytes(value: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

function trustedPublicKey(value: ShareNodeTrust): Uint8Array {
  if (!(value.invitationPublicKey instanceof Uint8Array) || value.invitationPublicKey.length !== 32) {
    throw new Error("share node trust key is invalid");
  }
  return value.invitationPublicKey;
}

async function verifyWrapped(value: unknown, key: "challenge" | "session", domain: string, trust: ShareNodeTrust): Promise<Record<string, unknown>> {
  const wrapper = object(value, `${key} response`);
  if (Object.keys(wrapper).length !== 2 || !Object.hasOwn(wrapper, key) || !Object.hasOwn(wrapper, "proof")) throw new Error(`${key} response is invalid`);
  const artifact = object(wrapper[key], `${key} artifact`);
  const proof = object(wrapper.proof, `${key} proof`);
  if (proof.alg !== "EdDSA" || proof.kid !== trust.invitationKid) throw new Error(`${key} proof is invalid`);
  if (!ed25519.verify(bytes(proof.signature, `${key} signature`), new TextEncoder().encode(`${domain}${canonicalize(artifact)}`), trustedPublicKey(trust))) throw new Error(`${key} proof is invalid`);
  return artifact;
}

function nativeAction(action: string): string {
  return action === "list" ? "tinycloud.kv/list" : action === "edit" ? "tinycloud.kv/put" : "tinycloud.kv/get";
}

function uiAction(action: unknown): "read" | "list" | "edit" {
  return action === "tinycloud.kv/list" ? "list" : action === "tinycloud.kv/put" ? "edit" : "read";
}

function selectedAction(envelope: ShareEnvelopeV2): string {
  return envelope.actions.includes("list") ? "tinycloud.kv/list" : envelope.actions.includes("edit") ? "tinycloud.kv/put" : "tinycloud.kv/get";
}

function policyAttenuationForV3(envelope: ShareEnvelopeV3): Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>> {
  const policy = object(envelope.policy, "v3 policy");
  if (!Array.isArray(policy.capabilityCeiling)) throw new Error("v3 policy capability ceiling is invalid");
  const attenuation: Record<string, Record<string, readonly unknown[]>> = {};
  for (const raw of policy.capabilityCeiling) {
    const capability = object(raw, "v3 policy capability");
    if (typeof capability.resource !== "string" || attenuation[capability.resource] !== undefined) throw new Error("v3 policy capability is invalid");
    if (capability.kind === "encryption") {
      if (capability.action !== "tinycloud.encryption/decrypt") throw new Error("v3 policy capability is invalid");
      attenuation[capability.resource] = { [capability.action]: [{}] };
      continue;
    }
    if (capability.kind !== "kv"
      || (capability.selector !== "exact" && capability.selector !== "prefix")
      || !Array.isArray(capability.actions)
      || capability.actions.length === 0
      || capability.actions.some((action) => typeof action !== "string")) throw new Error("v3 policy capability is invalid");
    attenuation[capability.resource] = Object.fromEntries(capability.actions.map((action) => [action, [{
      type: "xyz.tinycloud.resource/selector",
      kind: capability.selector,
      value: capability.resource,
    }]]));
  }
  return attenuation;
}

const POLICY_SESSION_FACT_KEYS = [
  "profile", "ownerDid", "policyId", "policyDigestHex", "policyCid",
  "policyDelegationCid", "enforcementDelegationCid", "contentSourceDigestHex",
  "capabilityCeilingHashHex", "nativeProjectionHashHex", "enforcerDid",
  "nodeAudience", "recipientDid", "challengeId", "claimDigestHex", "claimJti",
  "vpDigestHex", "credentialEvidenceDigestHex", "decisionContextDigestHex",
  "issuanceAuditDigestHex", "remainingRedelegationDepth",
] as const;
const POLICY_SESSION_V4_AUDIT_FACT_KEYS = ["credentialIdAuditDigestHex", "presentationJtiAuditDigestHex"] as const;
const POLICY_SESSION_DIGEST_FACT_KEYS = [
  "policyDigestHex", "contentSourceDigestHex", "capabilityCeilingHashHex",
  "nativeProjectionHashHex", "claimDigestHex", "vpDigestHex",
  "credentialEvidenceDigestHex", "decisionContextDigestHex", "issuanceAuditDigestHex",
] as const;
const LOWER_SHA256_HEX = /^[0-9a-f]{64}$/;

function verifyV3PolicyAuthorization(input: {
  readonly authorization: string;
  readonly cid: string;
  readonly envelope: ShareEnvelopeV3;
  readonly holderDid: string;
}): ReturnType<typeof verifyCompactUcanAuthorization> {
  const compact = verifyCompactUcanAuthorization(input.authorization, input.cid);
  const fact = compact.payload.fct[0];
  const factKeys = Object.keys(fact);
  const legacyShape = factKeys.length === POLICY_SESSION_FACT_KEYS.length
    && factKeys.every((key) => POLICY_SESSION_FACT_KEYS.includes(key as never))
    && POLICY_SESSION_FACT_KEYS.every((key) => key in fact);
  const v4Shape = factKeys.length === POLICY_SESSION_FACT_KEYS.length + POLICY_SESSION_V4_AUDIT_FACT_KEYS.length
    && factKeys.every((key) => POLICY_SESSION_FACT_KEYS.includes(key as never) || POLICY_SESSION_V4_AUDIT_FACT_KEYS.includes(key as never))
    && POLICY_SESSION_FACT_KEYS.every((key) => key in fact)
    && POLICY_SESSION_V4_AUDIT_FACT_KEYS.every((key) => key in fact);
  const binding = object(input.envelope.attestedEnforcerBinding, "v3 attested enforcer binding");
  const policy = object(input.envelope.policy, "v3 policy");
  const now = Math.floor(Date.now() / 1000);
  if ((!legacyShape && !v4Shape)
    || POLICY_SESSION_DIGEST_FACT_KEYS.some((key) => !LOWER_SHA256_HEX.test(fact[key] as string))
    || v4Shape && (!LOWER_SHA256_HEX.test(fact.credentialIdAuditDigestHex as string) || !LOWER_SHA256_HEX.test(fact.presentationJtiAuditDigestHex as string))
    || compact.payload.aud !== input.holderDid
    || compact.payload.iss.split("#", 1)[0] !== fact.nodeAudience
    || fact.profile !== "policy-session-ucan/v1"
    || fact.ownerDid !== policy.ownerDid
    || fact.policyId !== policy.policyId
    || fact.policyCid !== input.envelope.policyCid
    || fact.contentSourceDigestHex !== input.envelope.contentSourceDigestHex
    || fact.enforcerDid !== binding.enforcerDid
    || fact.nodeAudience !== binding.nodeAudience
    || fact.recipientDid !== input.holderDid
    || fact.policyDelegationCid !== input.envelope.policyRoot.cid
    || fact.enforcementDelegationCid !== input.envelope.enforcementRoot.cid
    || typeof fact.remainingRedelegationDepth !== "number"
    || !Number.isInteger(fact.remainingRedelegationDepth)
    || fact.remainingRedelegationDepth < 0
    || fact.remainingRedelegationDepth > 8
    || compact.payload.prf.length !== 2
    || compact.payload.prf[0] !== input.envelope.policyRoot.cid
    || compact.payload.prf[1] !== input.envelope.enforcementRoot.cid
    || compact.payload.nbf > now
    || compact.payload.exp <= now
    || compact.payload.exp - compact.payload.nbf > 60
    || canonicalize(compact.payload.att) !== canonicalize(policyAttenuationForV3(input.envelope))) throw new Error("v3 policy delegation signed binding mismatch");
  return compact;
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalHashHex(value: string): string {
  return hex(sha256(new TextEncoder().encode(canonicalize(value))));
}

async function aesGcmDecrypt(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  if (key.length !== 32 || blob.length < 28) throw new Error("encrypted content is malformed");
  const cryptoKey = await crypto.subtle.importKey("raw", key as unknown as BufferSource, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) as unknown as BufferSource }, cryptoKey, blob.slice(12) as unknown as BufferSource));
}

async function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  if (key.length !== 32) throw new Error("encrypted content key is malformed");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey("raw", key as unknown as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as unknown as BufferSource }, cryptoKey, plaintext as unknown as BufferSource));
  const output = new Uint8Array(nonce.length + ciphertext.length);
  output.set(nonce);
  output.set(ciphertext, nonce.length);
  return output;
}

interface V3InlineEncryptedEnvelope {
  readonly v: 1;
  readonly networkId: string;
  readonly alg: "x25519-aes256gcm/v1";
  readonly keyVersion: number;
  readonly encryptedSymmetricKey: string;
  readonly encryptedSymmetricKeyHash: string;
  readonly ciphertext: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

function parseV3InlineEncryptedEnvelope(bytes: Uint8Array, expected: ShareEnvelopeV3): V3InlineEncryptedEnvelope {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("encrypted content envelope is malformed"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("encrypted content envelope is malformed");
  const record = value as Record<string, unknown>;
  const allowed = ["v", "networkId", "alg", "keyVersion", "encryptedSymmetricKey", "encryptedSymmetricKeyHash", "ciphertext", "metadata"];
  if (Object.keys(record).some((key) => !allowed.includes(key))
    || record.v !== 1 || record.networkId !== expected.encryptionNetwork
    || record.alg !== "x25519-aes256gcm/v1" || record.keyVersion !== expected.contentSource.keyVersion
    || typeof record.encryptedSymmetricKey !== "string" || typeof record.encryptedSymmetricKeyHash !== "string"
    || record.encryptedSymmetricKeyHash !== expected.contentSource.encryptedSymmetricKeyDigestHex
    || record.encryptedSymmetricKeyHash !== canonicalHashHex(record.encryptedSymmetricKey)
    || typeof record.ciphertext !== "string"
    || record.metadata !== undefined && (record.metadata === null || typeof record.metadata !== "object" || Array.isArray(record.metadata) || Object.values(record.metadata).some((entry) => typeof entry !== "string"))) {
    throw new Error("encrypted content envelope binding is invalid");
  }
  return record as unknown as V3InlineEncryptedEnvelope;
}

async function verifyDetachedResponse(response: Response, trust: ShareNodeTrust): Promise<void> {
  let value: unknown;
  try { value = await response.clone().json(); } catch { throw new Error("share read response is invalid"); }
  const record = object(value, "share read response");
  const proof = object(record.proof, "share read detached proof");
  if (proof.alg !== "EdDSA" || proof.kid !== trust.invitationKid) throw new Error("share read detached proof is invalid");
  const unsigned = { ...record };
  delete unsigned.proof;
  if (!ed25519.verify(bytes(proof.signature, "share read signature"), new TextEncoder().encode(`${SHARE_V2_PROTOCOL.readResponseDomain}${canonicalize(unsigned)}`), trustedPublicKey(trust))) throw new Error("share read detached proof is invalid");
}

async function post(fetchFn: typeof fetch, origin: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetchFn(new URL(path, origin), { method: "POST", redirect: "error", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("share authority rejected the request");
  return response.json();
}

export class ShareRecipientClient {
  private readonly fetchFn: typeof fetch;
  private session: SharePolicySession | undefined;
  private signer: ((bytes: Uint8Array) => Promise<Uint8Array>) | undefined;
  private nativeSigner: ((bytes: Uint8Array) => Promise<Uint8Array>) | undefined;
  private holderProof: Record<string, unknown> | undefined;
  private v3Authorization: string | undefined;
  private v3NodeAudience: string | undefined;
  private v3ContentKey: Uint8Array | undefined;
  private v3ContentEnvelope: V3InlineEncryptedEnvelope | undefined;

  constructor(private readonly options: ShareRecipientClientOptions) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.signer = options.sign;
    if (options.policyAuthorization !== undefined) {
      if (options.envelope.version !== 3) throw new Error("policy delegation fast path requires a v3 envelope");
      const compact = verifyV3PolicyAuthorization({ ...options.policyAuthorization, envelope: options.envelope, holderDid: options.holderDid });
      const nodeAudience = compact.payload.fct[0].nodeAudience as string;
      this.v3Authorization = options.policyAuthorization.authorization;
      this.v3NodeAudience = nodeAudience;
      this.nativeSigner = options.sign;
      this.session = {
        sessionId: options.policyAuthorization.cid,
        expiresAt: new Date(compact.payload.exp * 1000).toISOString(),
        actions: options.envelope.actions,
        resource: options.envelope.resource,
      };
    }
  }

  async beginChallenge(envelope: ShareEnvelopeV2): Promise<SharePolicyChallenge> {
    const authority = envelope.ownerAuthority;
    if (authority === undefined) throw new Error("addressed owner authority is required");
    const outer = object(authority.outerEnvelope, "owner authority outer envelope");
    const enforcement = object(authority.enforcementDelegation, "owner authority enforcement delegation");
    const target = object(outer.target, "owner authority target");
    const outerResource = object(outer.resource, "owner authority resource");
    const source = object(outer.contentSource, "owner authority content source");
    if (!Array.isArray(outer.actions) || outer.actions.length === 0 || outer.actions.some((value) => typeof value !== "string")) throw new Error("owner authority outer envelope actions are invalid");
    const actions = [...outer.actions] as string[];
    const action = selectedAction(envelope);
    const challengeBody = { envelopeCid: authority.envelopeCid, shareCid: authority.shareCid, shareId: envelope.shareId, registrationCid: authority.registrationCid, delegationCid: envelope.delegationCid, policyCid: envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "", enforcementDelegationCid: String(enforcement.cid), enforcementDelegation: enforcement, outerEnvelope: outer, contentSource: source, contentSourceDigest: String(outer.contentSourceDigest), holderDid: this.options.holderDid, targetOrigin: String(target.origin), nodeAudience: String(target.nodeAudience), action, actions, resource: String(outerResource.path) };
    const requestBodyDigest = await digest(challengeBody);
    const challenge = await verifyWrapped(await post(this.fetchFn, this.options.nodeOrigin, "/share/v2/policy/challenges", { ...challengeBody, requestBodyDigest }), "challenge", DOMAIN, this.options.trustedNode) as unknown as SharePolicyChallenge;
    if (challenge.type !== "TinyCloudSharePolicyChallenge" || challenge.version !== 2 || challenge.challengeId.length < 16 || challenge.nonce.length < 16 || challenge.shareCid !== authority.shareCid || challenge.shareId !== envelope.shareId || challenge.registrationCid !== authority.registrationCid || challenge.envelopeCid !== authority.envelopeCid || challenge.policyCid !== challengeBody.policyCid || challenge.delegationCid !== envelope.delegationCid || challenge.enforcementDelegationCid !== enforcement.cid || canonicalize(challenge.contentSource) !== canonicalize(source) || challenge.contentSourceDigest !== challengeBody.contentSourceDigest || challenge.requestBodyDigest !== requestBodyDigest || challenge.holderDid !== this.options.holderDid || challenge.targetOrigin !== challengeBody.targetOrigin || challenge.nodeAudience !== challengeBody.nodeAudience || challenge.action !== action || canonicalize(challenge.actions) !== canonicalize(actions) || challenge.resource !== challengeBody.resource || !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error("share authority returned an unbound challenge");
    return challenge;
  }

  private async establish(envelope: ShareEnvelopeV2): Promise<SharePolicySession> {
    const authority = envelope.ownerAuthority;
    if (authority === undefined) throw new Error("addressed owner authority is required");
    const outer = object(authority.outerEnvelope, "owner authority outer envelope");
    const enforcement = object(authority.enforcementDelegation, "owner authority enforcement delegation");
    const target = object(outer.target, "owner authority target");
    const outerResource = object(outer.resource, "owner authority resource");
    const source = object(outer.contentSource, "owner authority content source");
    if (!Array.isArray(outer.actions) || outer.actions.length === 0 || outer.actions.some((value) => typeof value !== "string")) throw new Error("owner authority outer envelope actions are invalid");
    const actions = [...outer.actions] as string[];
    const action = selectedAction(envelope);
    const challengeBody = { envelopeCid: authority.envelopeCid, shareCid: authority.shareCid, shareId: envelope.shareId, registrationCid: authority.registrationCid, delegationCid: envelope.delegationCid, policyCid: envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "", enforcementDelegationCid: String(enforcement.cid), enforcementDelegation: enforcement, outerEnvelope: outer, contentSource: source, contentSourceDigest: String(outer.contentSourceDigest), holderDid: this.options.holderDid, targetOrigin: String(target.origin), nodeAudience: String(target.nodeAudience), action, actions, resource: String(outerResource.path) };
    const requestBodyDigest = await digest(challengeBody);
    const challenge = await verifyWrapped(await post(this.fetchFn, this.options.nodeOrigin, "/share/v2/policy/challenges", { ...challengeBody, requestBodyDigest }), "challenge", DOMAIN, this.options.trustedNode) as unknown as SharePolicyChallenge;
    if (challenge.type !== "TinyCloudSharePolicyChallenge" || challenge.version !== 2 || challenge.challengeId === undefined || challenge.nonce === undefined || challenge.shareCid !== authority.shareCid || challenge.shareId !== envelope.shareId || challenge.registrationCid !== authority.registrationCid || challenge.envelopeCid !== authority.envelopeCid || challenge.policyCid !== challengeBody.policyCid || challenge.delegationCid !== envelope.delegationCid || challenge.enforcementDelegationCid !== enforcement.cid || challenge.requestBodyDigest !== requestBodyDigest || canonicalize(challenge.contentSource) !== canonicalize(source) || challenge.contentSourceDigest !== challengeBody.contentSourceDigest || challenge.holderDid !== this.options.holderDid || challenge.targetOrigin !== challengeBody.targetOrigin || challenge.nodeAudience !== challengeBody.nodeAudience || challenge.action !== action || canonicalize(challenge.actions) !== canonicalize(actions) || challenge.resource !== challengeBody.resource || !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error("share authority returned an unbound challenge");
    if (this.options.buildPresentation === undefined) throw new Error("share presentation builder is required");
    const material = await this.options.buildPresentation({ challenge, envelope, policy: {} });
    this.holderProof = material.proof;
    this.signer = material.sign;
    this.nativeSigner = material.sign;
    if (this.signer === undefined) throw new Error("share holder signer is required");
    const presentation = {
      type: "TinyCloudSharePolicyPresentation", version: 2, challengeId: challenge.challengeId, nonce: challenge.nonce,
      shareCid: authority.shareCid, shareId: envelope.shareId, delegationCid: envelope.delegationCid,
      policyCid: challengeBody.policyCid, contentSource: source, contentSourceDigest: challengeBody.contentSourceDigest,
      holderDid: material.holderDid, targetOrigin: challengeBody.targetOrigin, nodeAudience: challengeBody.nodeAudience,
      ...(challenge.enforcerDid === undefined ? {} : { enforcerDid: challenge.enforcerDid }), credentialDigest: material.credentialDigest ?? await digestText(material.credential),
      action, actions, resource: challengeBody.resource, requestBodyDigest,
      issuedAt: new Date().toISOString(), expiresAt: challenge.expiresAt, jti: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    };
    const presentationProof = { alg: "EdDSA", kid: `${material.holderDid}#${material.holderDid.slice("did:key:".length)}`, signature: toBase64Url(await this.signer(new TextEncoder().encode(`${PRESENTATION_DOMAIN}${canonicalize(presentation)}`))) };
    const session = await verifyWrapped(await post(this.fetchFn, this.options.nodeOrigin, "/share/v2/policy/session", { challengeId: challenge.challengeId, nonce: challenge.nonce, presentation, credential: material.credential, proof: presentationProof, holderBinding: material.holderBinding, readSignerDid: material.holderDid }), "session", SESSION_DOMAIN, this.options.trustedNode);
    if (session.type !== "TinyCloudSharePolicySession" || session.version !== 2 || typeof session.sessionId !== "string" || session.shareCid !== authority.shareCid || session.shareId !== envelope.shareId || session.registrationCid !== authority.registrationCid || session.envelopeCid !== authority.envelopeCid || session.policyCid !== challengeBody.policyCid || session.delegationCid !== envelope.delegationCid || session.holderDid !== this.options.holderDid || session.targetOrigin !== challengeBody.targetOrigin || session.nodeAudience !== challengeBody.nodeAudience || session.action !== action || canonicalize(session.actions) !== canonicalize(actions) || canonicalize(session.contentSource) !== canonicalize(source) || session.contentSourceDigest !== challengeBody.contentSourceDigest || session.resource !== challengeBody.resource || typeof session.expiresAt !== "string" || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new Error("share authority returned an unbound session");
    this.session = { sessionId: session.sessionId, expiresAt: session.expiresAt, actions: actions.map(uiAction), resource: { kind: envelope.resource.kind, path: String(session.resource) } };
    return this.session;
  }

  async authorize(envelope: ShareEnvelopeV2): Promise<ShareAuthorizedContent> {
    if (this.session === undefined) await this.establish(envelope);
    const response = await this.nativeInvoke({ action: "get", resource: envelope.resource });
    if (!response.ok) throw new Error("share recipient read was rejected");
    const value = object(await response.json(), "share read response");
    const expectedAction = nativeAction("read");
    if (
      value.type !== "TinyCloudShareInvokeResponse" ||
      value.version !== 2 ||
      value.action !== expectedAction ||
      value.resource !== envelope.resource.path ||
      typeof value.content !== "string" ||
      typeof value.bodyDigest !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.bodyDigest) ||
      !Object.hasOwn(value, "proof")
    ) throw new Error("share read response is invalid");
    const content = fromBase64Url(value.content);
    if (await digestBytes(content) !== value.bodyDigest) throw new Error("share read response integrity is invalid");
    return { bytes: content, bodyDigest: value.bodyDigest, contentSourceDigest: envelope.contentSourceDigest, binding: { shareId: envelope.shareId, delegationCid: envelope.delegationCid, authorityMaterialHandle: envelope.authorityMaterialHandle, authorityMaterialDigest: envelope.authorityMaterialDigest, resource: { kind: envelope.resource.kind, path: value.resource }, action: value.action }, proof: { response: value, detached: value.proof } };
  }

  async establishPolicySession(): Promise<SharePolicySession> {
    if (this.session !== undefined) return this.session;
    const envelope = this.options.envelope;
    if (envelope.version === 3) return this.establishV3(envelope);
    return this.establish(envelope);
  }

  private async establishV3(envelope: ShareEnvelopeV3): Promise<SharePolicySession> {
    if (this.options.buildPresentation === undefined) throw new Error("share presentation builder is required");
    const attestedEnforcer = object(envelope.attestedEnforcerBinding, "v3 attested enforcer binding");
    if (attestedEnforcer.enforcerDid !== envelope.target.nodeAudience || typeof attestedEnforcer.nodeAudience !== "string") throw new Error("v3 attested enforcer binding mismatch");
    try { ed25519PublicKeyFromDidKey(attestedEnforcer.nodeAudience); } catch { throw new Error("v3 attested Node audience is invalid"); }
    const challengeResponse = await this.fetchFn(new URL("/share/v3/policy/challenges", this.options.nodeOrigin), {
      method: "POST",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ policyCid: envelope.policyCid, recipientDid: this.options.holderDid, requestedCapabilities: envelope.policy.capabilityCeiling }),
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    if (!challengeResponse.ok) throw new Error(`v3 policy challenge rejected (${challengeResponse.status})`);
    const challenge = object(await challengeResponse.json(), "v3 policy challenge");
    if (
      typeof challenge.challengeId !== "string" ||
      typeof challenge.nonce !== "string" ||
      challenge.policyCid !== envelope.policyCid ||
      challenge.recipientDid !== this.options.holderDid ||
      challenge.nodeAudience !== attestedEnforcer.nodeAudience ||
      (challenge.enforcerDid !== undefined && challenge.enforcerDid !== attestedEnforcer.enforcerDid) ||
      typeof challenge.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(challenge.expiresAt)) ||
      Date.parse(challenge.expiresAt) <= Date.now()
    ) throw new Error("v3 policy challenge binding mismatch");
    const material = await this.options.buildPresentation({
      challenge: challenge as unknown as SharePolicyChallenge,
      envelope,
      policy: envelope.policy as unknown as Record<string, unknown>,
    });
    if (material.sign === undefined || material.presentation === undefined) throw new Error("v3 ceremony requires a recipient signer and presentation");
    const accountless = material.presentation.schema === "xyz.tinycloud.policy/presentation/v4";
    if (accountless ? material.credentialEnvelope === undefined || material.requirement === undefined : material.claim === undefined) {
      throw new Error(accountless ? "v4 ceremony requires a verified credential and requirement" : "v3 ceremony requires a claim");
    }
    this.options.onStage?.("policy-admission");
    const delegationResponse = await this.fetchFn(new URL("/share/v3/policy/delegations", this.options.nodeOrigin), {
      method: "POST",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(accountless
        ? { policyCid: envelope.policyCid, challengeId: challenge.challengeId, nonce: challenge.nonce, requirement: material.requirement, credential: material.credentialEnvelope, presentation: material.presentation }
        : { policyCid: envelope.policyCid, challengeId: challenge.challengeId, nonce: challenge.nonce, claim: material.claim, presentation: material.presentation }),
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    if (!delegationResponse.ok) throw new Error(`v3 policy delegation rejected (${delegationResponse.status})`);
    const delegation = object(await delegationResponse.json(), "v3 policy delegation");
    if (delegation.admitted !== true || typeof delegation.sessionCid !== "string" || typeof delegation.authorization !== "string") throw new Error("v3 policy delegation response is not admitted");
    const compact = verifyV3PolicyAuthorization({ authorization: delegation.authorization, cid: delegation.sessionCid, envelope, holderDid: this.options.holderDid });
    const fact = compact.payload.fct[0];
    this.options.onStage?.("delegation-import");
    const imported = await this.fetchFn(new URL("/delegate", this.options.nodeOrigin), { method: "POST", redirect: "error", headers: { Authorization: delegation.authorization }, ...(this.options.signal === undefined ? {} : { signal: this.options.signal }) });
    if (!imported.ok) throw new Error(`ordinary delegation import rejected (${imported.status})`);
    this.signer = material.sign;
    this.v3Authorization = delegation.authorization;
    this.v3NodeAudience = fact.nodeAudience as string;
    this.session = { sessionId: delegation.sessionCid, expiresAt: new Date(compact.payload.exp * 1000).toISOString(), actions: envelope.actions, resource: envelope.resource };
    return this.session;
  }

  /** Decrypt a v3 KV value through a fresh recipient-signed decrypt invocation. */
  async decryptV3Content(bytes: Uint8Array): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    const envelope = this.options.envelope;
    const signer = this.nativeSigner ?? this.signer;
    if (envelope.version !== 3 || this.session === undefined || this.v3Authorization === undefined || this.v3NodeAudience === undefined || signer === undefined) throw new Error("v3 policy session signer is required");
    const encrypted = parseV3InlineEncryptedEnvelope(bytes, envelope);
    const receiverPrivateKey = crypto.getRandomValues(new Uint8Array(32));
    const receiverPublicKey = toBase64(x25519.getPublicKey(receiverPrivateKey));
    const receiverPublicKeyHash = canonicalHashHex(receiverPublicKey);
    const body = { type: "tinycloud.encryption.decrypt/v1", targetNode: this.v3NodeAudience, networkId: encrypted.networkId, alg: encrypted.alg, keyVersion: encrypted.keyVersion, encryptedSymmetricKey: encrypted.encryptedSymmetricKey, encryptedSymmetricKeyHash: encrypted.encryptedSymmetricKeyHash, receiverPublicKey, receiverPublicKeyHash };
    const bodyHash = hex(sha256(new TextEncoder().encode(canonicalize(body))));
    const session = verifyCompactUcanAuthorization(this.v3Authorization, this.session.sessionId);
    const now = Math.floor(Date.now() / 1000);
    const invocation = await signCompactUcanAuthorization({
      issuerDid: this.options.holderDid,
      audienceDid: this.v3NodeAudience,
      attenuation: { [encrypted.networkId]: { "tinycloud.encryption/decrypt": [{}] } },
      facts: [{ type: body.type, targetNode: body.targetNode, networkId: body.networkId, bodyHash, encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash, receiverPublicKeyHash, alg: body.alg, keyVersion: body.keyVersion }],
      proofs: [session.cid],
      notBefore: now,
      expiresAt: Math.min(now + 60, session.payload.exp),
      nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      sign: signer,
    });
    try {
      this.options.onStage?.("decryption");
      const response = await this.fetchFn(new URL("/invoke", this.options.nodeOrigin), { method: "POST", redirect: "error", headers: { accept: "application/json", "content-type": "application/json", Authorization: invocation.authorization }, body: JSON.stringify(body), ...(this.options.signal === undefined ? {} : { signal: this.options.signal }) });
      if (!response.ok) throw new Error(`v3 decrypt invocation rejected (${response.status})`);
      const value = object(await response.json(), "v3 decrypt response");
      const allowed = ["type", "targetNode", "networkId", "invocationCid", "encryptedSymmetricKeyHash", "receiverPublicKeyHash", "wrappedKey", "alg", "keyVersion", "requestHash", "nodeId", "nodeSignature"];
      if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))
        || value.type !== "tinycloud.encryption.decrypt-result/v1" || value.targetNode !== body.targetNode || value.nodeId !== body.targetNode
        || value.networkId !== body.networkId || value.invocationCid !== invocation.cid
        || value.encryptedSymmetricKeyHash !== body.encryptedSymmetricKeyHash || value.receiverPublicKeyHash !== receiverPublicKeyHash
        || value.alg !== body.alg || value.keyVersion !== body.keyVersion
        || value.requestHash !== hex(sha256(new TextEncoder().encode(`${invocation.cid}${bodyHash}`)))
        || typeof value.wrappedKey !== "string" || typeof value.nodeSignature !== "string") throw new Error("v3 decrypt response binding is invalid");
      const unsigned = { ...value };
      delete unsigned.nodeSignature;
      const signature = fromBase64(value.nodeSignature, "v3 decrypt response signature");
      if (signature.length !== 64 || !ed25519.verify(signature, new TextEncoder().encode(canonicalize(unsigned)), ed25519PublicKeyFromDidKey(body.targetNode), { zip215: false })) throw new Error("v3 decrypt response signature is invalid");
      const wrapped = fromBase64(value.wrappedKey, "v3 wrapped content key");
      if (wrapped.length < 60) throw new Error("v3 wrapped content key is malformed");
      const shared = x25519.getSharedSecret(receiverPrivateKey, wrapped.slice(0, 32));
      const symmetricKey = await aesGcmDecrypt(shared, wrapped.slice(32));
      shared.fill(0);
      if (symmetricKey.length !== 32) throw new Error("v3 content key is malformed");
      const plaintext = await aesGcmDecrypt(symmetricKey, fromBase64Url(encrypted.ciphertext));
      this.v3ContentKey?.fill(0);
      this.v3ContentKey = symmetricKey;
      this.v3ContentEnvelope = encrypted;
      return { bytes: plaintext, mediaType: encrypted.metadata?.contentType ?? envelope.metadata.mediaType ?? "application/octet-stream" };
    } finally {
      receiverPrivateKey.fill(0);
    }
  }

  /** Re-encrypt edited v3 content with the admitted content key. */
  async encryptV3Content(bytes: Uint8Array, mediaType: string): Promise<Uint8Array> {
    if (this.options.envelope.version !== 3 || this.v3ContentKey === undefined || this.v3ContentEnvelope === undefined) throw new Error("v3 content must be decrypted before it can be saved");
    return new TextEncoder().encode(canonicalize({ ...this.v3ContentEnvelope, ciphertext: toBase64Url(await aesGcmEncrypt(this.v3ContentKey, bytes)), metadata: { ...(this.v3ContentEnvelope.metadata ?? {}), contentType: mediaType } }));
  }

  async resumeWithProof(envelope: ShareEnvelopeV2, resumeToken: string, proof: unknown): Promise<ShareAuthorizedContent> {
    const material = object(proof, "share authorization proof");
    const presentation = object(material.presentation, "share presentation");
    const presentationProof = object(material.presentationProof, "share presentation proof");
    const nonce = material.nonce;
    const credential = material.credential;
    const holderDid = material.holderDid;
    const holderBinding = material.holderBinding;
    if (typeof nonce !== "string" || typeof credential !== "string" || typeof holderDid !== "string" || holderDid !== this.options.holderDid || typeof holderBinding !== "object" || holderBinding === null || presentationProof.alg !== "EdDSA" || typeof presentationProof.signature !== "string") throw new Error("share authorization proof is incomplete");
    const value = object(await post(this.fetchFn, this.options.nodeOrigin, "/share/v2/policy/session", { challengeId: resumeToken, nonce, presentation, credential, proof: presentationProof, holderBinding, readSignerDid: holderDid }), "share policy session");
    const session = await verifyWrapped(value, "session", SESSION_DOMAIN, this.options.trustedNode);
    const authority = envelope.ownerAuthority;
    if (authority === undefined || session.type !== "TinyCloudSharePolicySession" || session.version !== 2 || typeof session.sessionId !== "string" || session.shareCid !== authority.shareCid || session.shareId !== envelope.shareId || session.registrationCid !== authority.registrationCid || session.envelopeCid !== authority.envelopeCid || session.delegationCid !== envelope.delegationCid || typeof session.resource !== "string" || typeof session.expiresAt !== "string") throw new Error("share authority returned an unbound session");
    const policyCid = envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "";
    const actions = [...new Set(envelope.actions.map(nativeAction))].sort();
    if (
      session.policyCid !== policyCid ||
      session.holderDid !== this.options.holderDid ||
      session.targetOrigin !== envelope.target.origin ||
      session.nodeAudience !== envelope.target.nodeAudience ||
      session.action !== selectedAction(envelope) ||
      canonicalize(session.actions) !== canonicalize(actions) ||
      canonicalize(session.contentSource) !== canonicalize(envelope.contentSource) ||
      session.contentSourceDigest !== envelope.contentSourceDigest ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= Date.now()
    ) throw new Error("share authority returned an unbound session");
    this.session = { sessionId: session.sessionId, expiresAt: session.expiresAt, actions: actions.map(uiAction), resource: { kind: envelope.resource.kind, path: String(session.resource) } };
    this.holderProof = presentationProof;
    this.signer ??= this.options.sign;
    return this.authorize(envelope);
  }

  async nativeInvoke(request: { readonly action: string; readonly resource?: Record<string, unknown>; readonly body?: number[]; readonly bodyDigest?: number[]; readonly ifMatch?: string; readonly contentType?: string }): Promise<Response> {
    if (this.session === undefined) throw new Error("share policy session is required");
    const envelope = this.options.envelope;
    if (envelope.version === 3) return this.nativeInvokeV3(request, envelope);
    if (envelope.ownerAuthority === undefined || this.signer === undefined || this.holderProof === undefined) throw new Error("share holder signer is required");
    const authority = envelope.ownerAuthority;
    const action = request.action === "list" ? "tinycloud.kv/list" : request.action === "put" ? "tinycloud.kv/put" : request.action === "metadata" ? "tinycloud.kv/metadata" : "tinycloud.kv/get";
    const resource = typeof request.resource?.path === "string" ? request.resource.path : this.session.resource.path;
    const actions = [...new Set(this.session.actions.map(nativeAction).concat(action === "tinycloud.kv/metadata" ? [action] : []))].sort();
    const bodyBytes = request.body === undefined ? undefined : Uint8Array.from(request.body);
    const bodyDigest = bodyBytes === undefined ? undefined : toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes)));
    const outer = object(authority.outerEnvelope, "owner authority outer envelope");
    const enforcement = object(authority.enforcementDelegation, "owner authority enforcement delegation");
    const invocationBase = { type: "TinyCloudShareReadInvocation", version: 2, sessionId: this.session.sessionId, envelopeCid: authority.envelopeCid, shareCid: authority.shareCid, shareId: envelope.shareId, registrationCid: authority.registrationCid, delegationCid: envelope.delegationCid, policyCid: envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "", enforcementDelegationCid: String(enforcement.cid), contentSource: outer.contentSource, contentSourceDigest: String(outer.contentSourceDigest), holderDid: this.options.holderDid, targetOrigin: String(object(outer.target, "owner authority target").origin), nodeAudience: String(object(outer.target, "owner authority target").nodeAudience), action, actions, resource, ...(action === "tinycloud.kv/list" ? { limit: 100 } : {}), ...(bodyDigest === undefined ? {} : { bodyDigest, ifMatch: request.ifMatch, contentType: request.contentType }), issuedAt: new Date().toISOString(), expiresAt: new Date(Math.min(Date.now() + 60_000, Date.parse(this.session.expiresAt))).toISOString(), jti: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
    const requestBodyDigest = await digest(invocationBase);
    const invocation = { ...invocationBase, requestBodyDigest };
    const proof = { ...this.holderProof, signature: toBase64Url(await this.signer(new TextEncoder().encode(`${INVOCATION_DOMAIN}${canonicalize(invocation)}`))) };
    const signedRequest = { sessionId: this.session.sessionId, envelopeCid: authority.envelopeCid, shareCid: authority.shareCid, shareId: envelope.shareId, registrationCid: authority.registrationCid, delegationCid: envelope.delegationCid, policyCid: envelope.authorizationTarget.kind === "policy" ? envelope.authorizationTarget.policyCid : "", enforcementDelegationCid: String(enforcement.cid), contentSource: outer.contentSource, contentSourceDigest: String(outer.contentSourceDigest), holderDid: this.options.holderDid, nodeAudience: String(object(outer.target, "owner authority target").nodeAudience), action, actions, resource, requestBodyDigest, invocation, proof };
    const response = await this.fetchFn(new URL("/share/v2/invoke", this.options.nodeOrigin), { method: "POST", redirect: "error", headers: { accept: "application/vnd.tinycloud.share+json", "content-type": "application/vnd.tinycloud.share+json" }, body: JSON.stringify({ request: signedRequest, ...(action === "tinycloud.kv/list" ? { limit: 100 } : {}), ...(bodyBytes === undefined ? {} : { body: toBase64Url(bodyBytes), bodyDigest, ifMatch: request.ifMatch, contentType: request.contentType }) }) });
    if (response.ok) await verifyDetachedResponse(response, this.options.trustedNode);
    return response;
  }

  private async nativeInvokeV3(request: { readonly action: string; readonly resource?: Record<string, unknown>; readonly body?: number[]; readonly ifMatch?: string; readonly contentType?: string }, envelope: ShareEnvelopeV3): Promise<Response> {
    const signer = this.nativeSigner ?? this.signer;
    if (this.session === undefined || this.v3Authorization === undefined || this.v3NodeAudience === undefined || signer === undefined) throw new Error("v3 policy session signer is required");
    const session = verifyCompactUcanAuthorization(this.v3Authorization, this.session.sessionId);
    if (session.payload.aud !== this.options.holderDid) throw new Error("v3 session recipient mismatch");
    const action = request.action === "list" ? "tinycloud.kv/list" : request.action === "put" ? "tinycloud.kv/put" : request.action === "metadata" ? "tinycloud.kv/metadata" : "tinycloud.kv/get";
    const path = typeof request.resource?.path === "string" ? request.resource.path.replace(/^\//, "").replace(/\/$/, "") : envelope.resource.path;
    const capability = envelope.policy.capabilityCeiling.find((candidate) => candidate.kind === "kv");
    if (capability === undefined || !capability.actions.includes(action as never)) throw new Error("v3 requested capability is not in the signed policy");
    const marker = "/kv/";
    const split = capability.resource.indexOf(marker);
    if (split < 0) throw new Error("v3 KV resource is invalid");
    const root = capability.resource.slice(split + marker.length).replace(/\/$/, "");
    if (path !== root && !(capability.selector === "prefix" && path.startsWith(`${root}/`))) throw new Error("v3 KV request is outside the signed selector");
    const resource = `${capability.resource.slice(0, split + marker.length)}${path}`;
    const now = Math.floor(Date.now() / 1000);
    const invocation = await signCompactUcanAuthorization({ issuerDid: this.options.holderDid, audienceDid: this.v3NodeAudience, attenuation: { [resource]: { [action]: [{ type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: resource }] } }, facts: [{ type: "tinycloud.policy.invocation/v1", policyCid: envelope.policyCid, sessionCid: session.cid }], proofs: [session.cid], notBefore: now, expiresAt: Math.min(now + 60, session.payload.exp), nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), sign: signer });
    const headers = new Headers({ accept: "application/json", Authorization: invocation.authorization });
    let body: BodyInit | undefined;
    if (action === "tinycloud.kv/put") {
      if (request.body === undefined) throw new Error("v3 KV put requires bytes");
      body = Uint8Array.from(request.body) as BodyInit;
      headers.set("content-type", request.contentType ?? "application/octet-stream");
      if (request.ifMatch !== undefined) headers.set("if-match", request.ifMatch);
    }
    this.options.onStage?.("invocation");
    return this.fetchFn(new URL("/invoke", this.options.nodeOrigin), { method: "POST", redirect: "error", headers, ...(body === undefined ? {} : { body }), ...(this.options.signal === undefined ? {} : { signal: this.options.signal }) });
  }
}

export function createAddressedAuthorization(input: Omit<ShareRecipientClientOptions, "envelope" | "buildPresentation"> & { readonly buildPresentation?: (input: { readonly challenge: SharePolicyChallenge; readonly envelope: ShareEnvelopeV2; readonly policy: Record<string, unknown> }) => Promise<SharePresentationMaterial> }): ShareAuthorizationAdapter<ShareAuthorizedContent> {
  const { buildPresentation, ...options } = input;
  const client = (envelope: ShareEnvelopeV2): ShareRecipientClient => new ShareRecipientClient({
    ...options,
    envelope,
    ...(buildPresentation === undefined ? {} : { buildPresentation: ({ challenge, envelope: candidate, policy }) => buildPresentation({ challenge, envelope: candidate as ShareEnvelopeV2, policy }) }),
  });
  return {
    async begin({ envelope, method }): Promise<ShareAuthorizationResult<ShareAuthorizedContent>> {
      const current = client(envelope);
      if (input.buildPresentation !== undefined) return { state: "ready", value: await current.authorize(envelope) };
      const challenge = await current.beginChallenge(envelope);
      return { state: "authorization-required", method, resumeToken: challenge.challengeId };
    },
    async resume({ envelope, method, resumeToken, proof }): Promise<ShareAuthorizationResult<ShareAuthorizedContent>> {
      if (proof === undefined) return { state: "authorization-required", method, resumeToken };
      return { state: "ready", value: await client(envelope).resumeWithProof(envelope, resumeToken, proof) };
    },
    async verifyResult({ envelope, value, proof }) {
      try {
        const wrapper = object(proof, "share read proof");
        const response = object(wrapper.response, "share read response proof");
        const envelopeAction = nativeAction("read");
        if (
          response.type !== "TinyCloudShareInvokeResponse" ||
          response.version !== 2 ||
          response.action !== envelopeAction ||
          response.resource !== envelope.resource.path ||
          typeof response.bodyDigest !== "string" ||
          response.bodyDigest !== value.bodyDigest ||
          response.bodyDigest !== await digestBytes(value.bytes)
        ) return false;
        const detached = object(wrapper.detached, "share read detached proof");
        if (detached.alg !== "EdDSA" || detached.kid !== input.trustedNode.invitationKid) return false;
        const unsigned = { ...response };
        delete unsigned.proof;
        return ed25519.verify(bytes(detached.signature, "share read signature"), new TextEncoder().encode(`${SHARE_V2_PROTOCOL.readResponseDomain}${canonicalize(unsigned)}`), trustedPublicKey(input.trustedNode));
      } catch {
        return false;
      }
    },
  };
}
