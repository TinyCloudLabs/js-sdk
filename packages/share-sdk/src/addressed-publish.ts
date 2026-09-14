import { sha256 } from "@noble/hashes/sha256";
import {
  canonicalize, computeCid, encodePublicInlineShareUrl,
  shareEnvelopeV3Schema, toBase64Url, unsignedShareEnvelopeV3Schema,
  type PolicyCredentialRequirementV1, type ShareAction, type UnifiedContentSource,
  type UnifiedPolicy, type UnifiedPolicyCapability, type UnifiedRoot,
} from "@tinycloud/share-envelope";
import {
  SHARE_CONTENT_LIMIT, SHARE_PUBLISH_RESULT_VERSION, redactPublishedShare,
  type PublishedShare, type PublishedShareDeliveryMaterial,
} from "./publish.js";
import { normalizeShareTarget, type ShareTarget } from "./targets.js";
import type { OwnerShareAction, OwnerShareMatcher } from "./owner-policy.js";

const POLICY_V1_DOMAIN = "xyz.tinycloud.policy/policy/v1\0";
const POLICY_V2_DOMAIN = "xyz.tinycloud.policy/policy/v2\0";
const POLICY_CAPABILITY_V1_DOMAIN = "xyz.tinycloud.policy/PolicyCapability/v1\0";
const CONTENT_SOURCE_V1_DOMAIN = "xyz.tinycloud.policy/ContentSource/v1\0";
const NATIVE_PROJECTION_V1_DOMAIN = "xyz.tinycloud.policy/NativeProjection/v1\0";
const ENVELOPE_V3_DOMAIN = "xyz.tinycloud.share/envelope/v3\0";
const textEncoder = new TextEncoder();

export interface AddressedOwnerRootInput {
  readonly ownerDid: string;
  readonly role: "policy-authority" | "policy-enforcement";
  readonly audienceDid: string;
  readonly policyId: string;
  readonly policyDigestHex: string;
  readonly policyCid: string;
  readonly contentSourceDigestHex: string;
  readonly capabilityCeilingHashHex: string;
  readonly nativeProjectionHashHex: string;
  readonly notBefore: Date;
  readonly expiresAt: Date;
  readonly nodeAudience: string;
  readonly capabilities: readonly UnifiedPolicyCapability[];
}

export interface AddressedOwnerRootReceipt {
  readonly cid: string;
  readonly delegationHeader: { readonly Authorization: string };
}

export interface AddressedPolicyRegistrationInput {
  readonly policyCid: string;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly policyRoot: { readonly cid: string; readonly authorization: string };
  readonly enforcementRoot: { readonly cid: string; readonly authorization: string };
  readonly contentSourceDigestHex: string;
  readonly nativeProjectionHashHex: string;
  readonly rootExpiresAt: string;
  readonly enforcerDid: string;
  readonly expectedNodeAudience: string;
}

export interface AddressedPolicyRegistrationReceipt {
  readonly policyCid: string;
  readonly policyRootCid: string;
  readonly enforcementRootCid: string;
  readonly attestedEnforcerBinding: {
    readonly schema: "xyz.tinycloud.policy/attested-enforcer/v2";
    readonly enforcerDid: string;
    readonly nodeAudience: string;
    readonly attestationBindingDigestHex: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly signature: { readonly suite: "Ed25519"; readonly signerDid: string; readonly value: string };
  };
}

/** App-neutral owner authority. Node SDK owns all Policy/v3 transport. */
export interface AddressedPublishAuthority {
  readonly ownerDid: string;
  createOwnerRoot(input: AddressedOwnerRootInput): Promise<AddressedOwnerRootReceipt>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  registerPolicy(input: AddressedPolicyRegistrationInput): Promise<AddressedPolicyRegistrationReceipt>;
}

export interface AddressedSharePublishOptions {
  readonly shareId: string;
  readonly shareOrigin: string;
  readonly nodeOrigin: string;
  readonly nodeAudience: string;
  readonly enforcerDid: string;
  readonly spaceId: string;
  readonly target: Exclude<ShareTarget, { readonly kind: "bearer" }>;
  readonly resource: { readonly kind: "exact" | "prefix"; readonly path: string };
  readonly actions: readonly ShareAction[];
  readonly policyActions: readonly OwnerShareAction[];
  readonly contentSource: UnifiedContentSource;
  readonly credentialRequirement?: PolicyCredentialRequirementV1;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly artifact?: "html";
  readonly deliveryEmail?: string;
  readonly expiresAt: Date;
  /** Sender-history material required by Node's Policy/v3 delivery authorization. */
  readonly onDeliveryMaterial?: (input: {
    readonly envelope: Readonly<Record<string, unknown>>;
    readonly shareCid: string;
  }) => void;
  readonly authority: AddressedPublishAuthority;
}

function targetMatcher(target: Exclude<ShareTarget, { readonly kind: "bearer" }>): OwnerShareMatcher {
  if (target.kind === "recipientDid") return { kind: "recipientDid", value: target.did };
  if (target.kind === "email") return { kind: "exactEmail", value: target.address };
  return { kind: "emailDomain", value: target.domain };
}

function targetKind(target: Exclude<ShareTarget, { readonly kind: "bearer" }>): "recipientDid" | "email" | "emailDomain" {
  return target.kind;
}

function assertSafeInput(input: AddressedSharePublishOptions): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.shareId)) throw new TypeError("addressed share id is invalid");
  if (input.filename.length === 0 || input.filename === "." || input.filename === ".." || /[/\\\u0000-\u001f\u007f]/.test(input.filename)) throw new TypeError("addressed filename is invalid");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || input.byteLength > SHARE_CONTENT_LIMIT) throw new TypeError("addressed content length is invalid");
  if (input.actions.length === 0 || input.policyActions.length === 0) throw new TypeError("addressed share actions are empty");
  if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now()) throw new TypeError("addressed share expiry must be in the future");
  if (input.artifact === "html" && (input.resource.kind !== "prefix" || !input.actions.includes("read") || !input.actions.includes("list"))) throw new TypeError("html artifacts require a readable prefix");
  if (input.contentSource.shareId !== input.shareId || input.contentSource.selector !== input.resource.kind) throw new TypeError("addressed content source is not bound to the share");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digestHex(value: unknown, domain: string): string {
  return hex(sha256(textEncoder.encode(`${domain}${canonicalize(value)}`)));
}

function sortCanonical<T>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
}

function base32Lower(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function rfc3339Seconds(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

function nativeProjection(capabilities: readonly UnifiedPolicyCapability[]): readonly Record<string, unknown>[] {
  return sortCanonical(capabilities.map((capability) => capability.kind === "encryption"
    ? { service: "tinycloud.encryption", space: capability.resource, path: capability.resource, actions: [capability.action] }
    : {
        service: "tinycloud.kv",
        space: capability.resource.slice(0, capability.resource.indexOf("/kv/")),
        path: capability.resource.slice(capability.resource.indexOf("/kv/") + 4),
        actions: [...capability.actions],
        caveat: { type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: capability.resource },
      }));
}

async function createPolicy(options: AddressedSharePublishOptions, capabilities: readonly UnifiedPolicyCapability[]): Promise<{ readonly policy: UnifiedPolicy; readonly policyCid: string; readonly policyDigestHex: string }> {
  const fields = {
    ownerDid: options.authority.ownerDid,
    createdAt: rfc3339Seconds(new Date()),
    expiresAt: rfc3339Seconds(options.expiresAt),
    contentSource: options.contentSource,
    capabilityCeiling: [...capabilities],
  };
  const unsigned = options.credentialRequirement === undefined
    ? { schema: "xyz.tinycloud.policy/policy/v1" as const, ...fields }
    : { schema: "xyz.tinycloud.policy/policy/v2" as const, ...fields, credentialRequirement: options.credentialRequirement };
  const domain = options.credentialRequirement === undefined ? POLICY_V1_DOMAIN : POLICY_V2_DOMAIN;
  const policyDigestHex = digestHex(unsigned, domain);
  const signature = await options.authority.sign(sha256(textEncoder.encode(`${domain}${canonicalize(unsigned)}`)));
  if (signature.byteLength !== 64) throw new TypeError("policy signature must be Ed25519");
  const policy = {
    ...unsigned,
    policyId: `pol_${base32Lower(Uint8Array.from(policyDigestHex.match(/../g)!, (byte) => Number.parseInt(byte, 16)))}`,
    signature: { suite: "Ed25519" as const, signerDid: options.authority.ownerDid, value: toBase64Url(signature) },
  } satisfies UnifiedPolicy;
  return { policy, policyCid: await computeCid(textEncoder.encode(canonicalize(policy))), policyDigestHex };
}

function publicationResult(input: {
  readonly options: AddressedSharePublishOptions;
  readonly url: string;
  readonly envelopeCid: string;
  readonly matcher: OwnerShareMatcher;
  readonly policyCid: string;
  readonly policyRootCid: string;
  readonly enforcementRootCid: string;
  readonly enforcerDid: string;
  readonly expiry: string;
  readonly deliveryMaterial: PublishedShareDeliveryMaterial;
}): PublishedShare {
  const result = {
    protocol: "tinycloud-share", version: SHARE_PUBLISH_RESULT_VERSION, url: input.url,
    link: { kind: "policy" as const, cid: input.envelopeCid },
    metadata: {
      protocol: "tinycloud-share" as const, version: 1 as const, shareId: input.options.shareId,
      origin: input.options.shareOrigin,
      target: { kind: targetKind(input.options.target), origin: input.options.nodeOrigin, nodeAudience: input.enforcerDid, spaceId: input.options.spaceId },
      resource: { ...input.options.resource }, actions: [...input.options.actions], expiresAt: input.expiry,
      display: { filename: input.options.filename }, recipientMatcher: { ...input.matcher }, policyCid: input.policyCid,
      ownerDelegationCid: input.policyRootCid, enforcementDelegationCid: input.enforcementRootCid,
      ownerDid: input.options.authority.ownerDid, enforcerDid: input.enforcerDid, envelopeCid: input.envelopeCid, shareCid: input.envelopeCid,
    },
  } satisfies PublishedShare;
  Object.defineProperty(result, "toJSON", { enumerable: false, value: () => redactPublishedShare(result) });
  Object.defineProperty(result, "url", { enumerable: false, value: input.url });
  Object.defineProperty(result, "deliveryMaterial", { enumerable: false, value: input.deliveryMaterial });
  return result;
}

/** Canonical application-neutral Policy/v3 addressed publisher shared by browser and CLI. */
export async function publishAddressedShare(options: AddressedSharePublishOptions): Promise<PublishedShare> {
  assertSafeInput(options);
  const target = normalizeShareTarget(options.target);
  if (target.kind === "bearer") throw new TypeError("addressed target is required");
  const expiry = rfc3339Seconds(options.expiresAt);
  const matcher = targetMatcher(target);
  const capabilities = sortCanonical<UnifiedPolicyCapability>([
    { kind: "kv", resource: options.contentSource.kvResource, selector: options.resource.kind, actions: [...options.policyActions] },
    { kind: "encryption", resource: options.contentSource.encryptionNetwork, action: "tinycloud.encryption/decrypt" },
  ]);
  const created = await createPolicy(options, capabilities);
  const contentSourceDigestHex = digestHex(options.contentSource, CONTENT_SOURCE_V1_DOMAIN);
  const capabilityCeilingHashHex = digestHex(capabilities, POLICY_CAPABILITY_V1_DOMAIN);
  const nativeProjectionHashHex = digestHex(nativeProjection(capabilities), NATIVE_PROJECTION_V1_DOMAIN);
  const commonRoot = {
    ownerDid: options.authority.ownerDid, policyId: created.policy.policyId, policyDigestHex: created.policyDigestHex,
    policyCid: created.policyCid, contentSourceDigestHex, capabilityCeilingHashHex, nativeProjectionHashHex,
    notBefore: new Date(created.policy.createdAt), expiresAt: new Date(expiry), nodeAudience: options.nodeAudience, capabilities,
  };
  const policyRootReceipt = await options.authority.createOwnerRoot({ ...commonRoot, role: "policy-authority", audienceDid: `did:tinycloud:policy:${created.policyDigestHex}` });
  const enforcementRootReceipt = await options.authority.createOwnerRoot({ ...commonRoot, role: "policy-enforcement", audienceDid: options.enforcerDid });
  const policyRoot: UnifiedRoot = { cid: policyRootReceipt.cid, authorization: policyRootReceipt.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""), role: "policy-authority" };
  const enforcementRoot: UnifiedRoot = { cid: enforcementRootReceipt.cid, authorization: enforcementRootReceipt.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""), role: "policy-enforcement" };
  const registration = await options.authority.registerPolicy({
    policyCid: created.policyCid, policy: created.policy, policyRoot, enforcementRoot, contentSourceDigestHex,
    nativeProjectionHashHex, rootExpiresAt: expiry, enforcerDid: options.enforcerDid,
    expectedNodeAudience: options.nodeAudience,
  });
  if (registration.policyCid !== created.policyCid || registration.policyRootCid !== policyRoot.cid || registration.enforcementRootCid !== enforcementRoot.cid) throw new Error("Policy/v3 registration receipt is not bound to the published roots");
  const unsigned = {
    version: 3 as const, shareId: options.shareId, recipientMatcher: matcher,
    ...(options.deliveryEmail === undefined ? {} : { deliveryEmail: options.deliveryEmail }),
    actions: [...options.actions], resource: { ...options.resource },
    target: { origin: options.nodeOrigin, nodeAudience: registration.attestedEnforcerBinding.enforcerDid, spaceId: options.spaceId },
    policy: created.policy, policyCid: created.policyCid, policyRoot, enforcementRoot,
    attestedEnforcerBinding: registration.attestedEnforcerBinding, contentSource: options.contentSource,
    contentSourceDigestHex, encryptionNetwork: options.contentSource.encryptionNetwork, expiry,
    display: { filename: options.filename }, encrypted: true as const,
    metadata: {
      mediaType: options.mediaType, byteLength: options.byteLength, filename: options.filename,
      ...(options.mediaType.startsWith("text/") ? { encoding: "utf-8" as const } : {}),
      ...(options.artifact === undefined ? {} : { artifact: options.artifact }),
    },
  };
  unsignedShareEnvelopeV3Schema.parse(unsigned);
  const envelopeSignature = await options.authority.sign(sha256(textEncoder.encode(`${ENVELOPE_V3_DOMAIN}${canonicalize(unsigned)}`)));
  if (envelopeSignature.byteLength !== 64) throw new TypeError("v3 envelope signature must be Ed25519");
  const envelope = { ...unsigned, signature: { signerDid: options.authority.ownerDid, algorithm: "Ed25519" as const, value: toBase64Url(envelopeSignature) } };
  shareEnvelopeV3Schema.parse(envelope);
  const envelopeBytes = textEncoder.encode(canonicalize(envelope));
  const envelopeCid = await computeCid(envelopeBytes);
  const url = await encodePublicInlineShareUrl({ origin: options.shareOrigin, plaintext: envelopeBytes });
  const deliveryMaterial = { envelope, shareCid: envelopeCid };
  options.onDeliveryMaterial?.(deliveryMaterial);
  return publicationResult({
    options, url, envelopeCid, matcher, policyCid: created.policyCid,
    policyRootCid: policyRoot.cid, enforcementRootCid: enforcementRoot.cid,
    enforcerDid: registration.attestedEnforcerBinding.enforcerDid,
    expiry, deliveryMaterial,
  });
}
