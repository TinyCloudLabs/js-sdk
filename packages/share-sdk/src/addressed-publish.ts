import { canonicalShareFilename } from "./filename-policy.js";
import { sha256 } from "@noble/hashes/sha256";
import { assertArtifactBinding } from "./artifact-pin.js";
import {
  canonicalize, computeCid, generateKey, isEnvelopeDeliveryEmail, seal,
  shareEnvelopeV3Schema, toBase64Url, unsignedShareEnvelopeV3Schema,
  type ArtifactPin, type PolicyCredentialRequirementV1, type ShareAction, type UnifiedContentSource,
  type ShareEnvelopeV3, type UnifiedPolicy, type UnifiedPolicyCapability, type UnifiedRoot, type UnsignedShareEnvelopeV3,
} from "@tinycloud/share-envelope";

import {
  SHARE_CONTENT_LIMIT, SHARE_PUBLISH_RESULT_VERSION, SharePublishError, redactPublishedShare,
  type PublishedShare, type PublishedShareDeliveryMaterial,
} from "./publish.js";
import { ARTIFACT_ROOT } from "./artifact-core.js";
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
  /** The links API origin written into the signed header as its audience. Defaults to `https://api.tinycloud.xyz`. */
  readonly apiOrigin?: string;
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
  /** TC-1428: pins the share to one write-once artifact version; signed with the envelope. Required when the content source is under `artifacts/`. */
  readonly artifactPin?: ArtifactPin;
  readonly deliveryEmail?: string;
  readonly expiresAt: Date;
  /** Sender-history material required by Node's Policy/v3 delivery authorization. */
  readonly onDeliveryMaterial?: (input: PublishedShareDeliveryMaterial) => void;
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

const OWNER_SHARE_ACTIONS: ReadonlySet<string> = new Set<OwnerShareAction>(["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/metadata", "tinycloud.kv/put"]);

function assertSafeInput(input: AddressedSharePublishOptions): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.shareId)) throw new TypeError("addressed share id is invalid");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || input.byteLength > SHARE_CONTENT_LIMIT) throw new TypeError("addressed content length is invalid");
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

type PolicyOptions = Pick<AddressedSharePublishOptions, "expiresAt" | "contentSource" | "credentialRequirement"> & {
  readonly authority: Pick<AddressedPublishAuthority, "ownerDid" | "sign">;
};

async function createPolicy(options: PolicyOptions, capabilities: readonly UnifiedPolicyCapability[]): Promise<{ readonly policy: UnifiedPolicy; readonly policyCid: string; readonly policyDigestHex: string }> {
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

/** What an addressed share derives from its own inputs, before any write: the capability ceiling and the digests the owner roots commit to. */
function addressedPlan(options: Pick<AddressedSharePublishOptions, "resource" | "contentSource" | "policyActions" | "expiresAt">) {
  const capabilities = sortCanonical<UnifiedPolicyCapability>([
    { kind: "kv", resource: options.contentSource.kvResource, selector: options.resource.kind, actions: [...options.policyActions] },
    { kind: "encryption", resource: options.contentSource.encryptionKeyPath === undefined
      ? options.contentSource.encryptionNetwork
      : `${options.contentSource.encryptionNetwork}/${options.contentSource.encryptionKeyPath}`, action: "tinycloud.encryption/decrypt" },
  ]);
  return {
    expiry: rfc3339Seconds(options.expiresAt),
    capabilities,
    contentSourceDigestHex: digestHex(options.contentSource, CONTENT_SOURCE_V1_DOMAIN),
    capabilityCeilingHashHex: digestHex(capabilities, POLICY_CAPABILITY_V1_DOMAIN),
    nativeProjectionHashHex: digestHex(nativeProjection(capabilities), NATIVE_PROJECTION_V1_DOMAIN),
  };
}

type EnvelopeInputs = Pick<AddressedSharePublishOptions, "shareId" | "nodeOrigin" | "spaceId" | "actions" | "resource" | "contentSource" | "deliveryEmail" | "filename" | "mediaType" | "byteLength" | "artifact" | "artifactPin">;

/**
 * The unsigned v3 envelope. The publish and the size bound both build it here,
 * so the bound measures the serialization the publish seals.
 */
function unsignedAddressedEnvelope(input: {
  readonly options: EnvelopeInputs;
  readonly matcher: OwnerShareMatcher;
  readonly policy: UnifiedPolicy;
  readonly policyCid: string;
  readonly policyRoot: UnifiedRoot;
  readonly enforcementRoot: UnifiedRoot;
  readonly attestedEnforcerBinding: AddressedPolicyRegistrationReceipt["attestedEnforcerBinding"];
  readonly contentSourceDigestHex: string;
  readonly expiry: string;
}): UnsignedShareEnvelopeV3 {
  const { options } = input;
  return {
    version: 3 as const, shareId: options.shareId, recipientMatcher: input.matcher,
    ...(options.deliveryEmail === undefined ? {} : { deliveryEmail: options.deliveryEmail }),
    actions: [...options.actions], resource: { ...options.resource },
    target: { origin: options.nodeOrigin, nodeAudience: input.attestedEnforcerBinding.enforcerDid, spaceId: options.spaceId },
    policy: input.policy, policyCid: input.policyCid, policyRoot: input.policyRoot, enforcementRoot: input.enforcementRoot,
    attestedEnforcerBinding: input.attestedEnforcerBinding, contentSource: options.contentSource,
    contentSourceDigestHex: input.contentSourceDigestHex, encryptionNetwork: options.contentSource.encryptionNetwork, expiry: input.expiry,
    display: { filename: options.filename }, encrypted: true as const,
    metadata: {
      mediaType: options.mediaType, byteLength: options.byteLength, filename: options.filename,
      ...(options.mediaType.startsWith("text/") ? { encoding: "utf-8" as const } : {}),
      ...(options.artifact === undefined ? {} : { artifact: options.artifact }),
    },
    ...(options.artifactPin === undefined ? {} : { artifactPin: options.artifactPin }),
  };
}

function signedAddressedEnvelope(unsigned: UnsignedShareEnvelopeV3, signerDid: string, signature: Uint8Array): ShareEnvelopeV3 {
  return { ...unsigned, signature: { signerDid, algorithm: "Ed25519", value: toBase64Url(signature) } };
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

/**
 * Mailbox-addressed shares are opened by proving the mailbox to
 * OpenCredentials, so their policy must commit to that credential (Policy/v2).
 * The receiving SDK recomputes the requirement from the envelope's recipient
 * matcher and refuses any share whose commitment differs, so the commitment
 * is derived here from the same normalized target rather than trusted from
 * the caller. A domain share admits every mailbox at the domain; its access
 * and delivery are the owner's choice, as for exact-email shares.
 */
const EMAIL_PROFILE = { id: "tinycloud.email-proof/v1", version: 1 } as const;
const EMAIL_DOMAIN_PROFILE = { id: "tinycloud.email-domain-proof/v1", version: 1 } as const;
const EMAIL_CREDENTIAL_TYPE = { id: "opencredentials.email/v1", version: 1 } as const;
/** Digests of the OpenCredentials descriptors (pinned by issuer and SDK tests). */
const EMAIL_DESCRIPTOR_DIGEST = "1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0";
const EMAIL_DOMAIN_DESCRIPTOR_DIGEST = "33X5mAkZZgApdD3xh_T-3KS5moop0J2Nloi2nqWsdWY";
const EMAIL_CREDENTIAL_ISSUER_DID = "did:web:issuer.credentials.org";
const EMAIL_CREDENTIAL_ISSUER_KID = `${EMAIL_CREDENTIAL_ISSUER_DID}#controller`;

type MailboxTarget = Extract<ShareTarget, { readonly kind: "email" | "emailDomain" }>;

function mailboxCredentialCommitment(target: MailboxTarget): PolicyCredentialRequirementV1 {
  const profile = target.kind === "email" ? EMAIL_PROFILE : EMAIL_DOMAIN_PROFILE;
  // Field-for-field the requirement sdk-core's createEmail(Domain)CredentialRequirement builds on receive.
  const requirement = target.kind === "email"
    ? { type: "TinyCloudCredentialRequirement", version: 1, profile, credentialType: EMAIL_CREDENTIAL_TYPE, claims: { email: target.address }, maxAgeSeconds: 3600 }
    : { type: "TinyCloudCredentialRequirement", version: 1, profile, credentialType: EMAIL_CREDENTIAL_TYPE, claims: { emailDomain: target.domain }, maxAgeSeconds: 300 };
  return {
    type: "TinyCloudPolicyCredentialRequirement",
    version: 1,
    requirementDigest: toBase64Url(sha256(textEncoder.encode(canonicalize(requirement)))),
    descriptorDigest: target.kind === "email" ? EMAIL_DESCRIPTOR_DIGEST : EMAIL_DOMAIN_DESCRIPTOR_DIGEST,
    issuerDid: EMAIL_CREDENTIAL_ISSUER_DID,
    issuerKid: EMAIL_CREDENTIAL_ISSUER_KID,
    profile,
    credentialType: EMAIL_CREDENTIAL_TYPE,
  };
}

/** The Policy/v2 credential commitment a share addressed to `target` must carry. */
export function addressedCredentialRequirement(target: MailboxTarget): PolicyCredentialRequirementV1 {
  const normalized = normalizeShareTarget(target);
  if (normalized.kind !== "email" && normalized.kind !== "emailDomain") throw new TypeError("a mailbox target is required");
  return mailboxCredentialCommitment(normalized);
}

/** Facts every addressed-share check needs, available before any side effect. */
export type AddressedShareRequest = Pick<AddressedSharePublishOptions, "target" | "actions" | "policyActions" | "filename" | "deliveryEmail">;

export interface PreparedAddressedShare {
  /** The canonical target the envelope's recipient matcher will carry. */
  readonly target: Exclude<ShareTarget, { readonly kind: "bearer" }>;
  /** Present for mailbox targets: the Policy/v2 commitment to pass to `publishAddressedShare`. */
  readonly credentialRequirement?: PolicyCredentialRequirementV1;
}

/**
 * Runs every argument and target check of `publishAddressedShare` that does
 * not depend on stored content, and derives the credential commitment. It has
 * no side effects, so senders call it before uploading content or publishing
 * a location record; a refused share then leaves nothing behind.
 */
export function prepareAddressedShare(request: AddressedShareRequest): PreparedAddressedShare {
  try {
    canonicalShareFilename(request.filename);
  } catch {
    throw new TypeError("addressed filename is invalid");
  }
  if (request.actions.length === 0 || request.policyActions.length === 0) throw new TypeError("addressed share actions are empty");
  if (request.policyActions.some((action) => !OWNER_SHARE_ACTIONS.has(action))) throw new TypeError("addressed share action is not supported");
  // The envelope schema signs `deliveryEmail` only in a form deployed viewers
  // accept; refuse anything else before the caller uploads or registers.
  if (request.deliveryEmail !== undefined && !isEnvelopeDeliveryEmail(request.deliveryEmail)) throw new TypeError("delivery email is not a valid envelope address");
  const target = normalizeShareTarget(request.target);
  if (target.kind === "bearer") throw new TypeError("addressed target is required");
  if (target.kind === "recipientDid") return { target };
  // A domain link can be emailed to any number of mailboxes at the domain, so
  // it is normally not pinned to one. If the owner pins one, it must be the
  // issuer's lowercase mailbox at exactly that domain, the form the owner's
  // Node names in its delivery admission.
  if (target.kind === "emailDomain" && request.deliveryEmail !== undefined
    && (request.deliveryEmail !== request.deliveryEmail.toLowerCase() || !request.deliveryEmail.endsWith(`@${target.domain}`))) {
    throw new TypeError("email-domain delivery address must be a lowercase mailbox at the domain");
  }
  return { target, credentialRequirement: mailboxCredentialCommitment(target) };
}

function assertMailboxCommitment(commitment: PolicyCredentialRequirementV1 | undefined, target: MailboxTarget): void {
  const label = target.kind === "email" ? "email" : "email-domain";
  // Without a commitment the policy would be Policy/v1, which no receiver can open.
  if (commitment === undefined) throw new TypeError(`${label} shares require a credential requirement`);
  const expected = mailboxCredentialCommitment(target);
  // Pin the profile, descriptor and issuer rather than trusting the caller:
  // only these derive the claim under the canonical mailbox rules.
  if (canonicalize(commitment.profile) !== canonicalize(expected.profile)
    || canonicalize(commitment.credentialType) !== canonicalize(expected.credentialType)
    || commitment.descriptorDigest !== expected.descriptorDigest
    || commitment.issuerDid !== expected.issuerDid
    || commitment.issuerKid !== expected.issuerKid) throw new TypeError(`${label} shares require the ${label} credential profile`);
  if (commitment.requirementDigest !== expected.requirementDigest) throw new TypeError(`credential requirement is not bound to the email ${target.kind === "email" ? "address" : "domain"}`);
}

/** Canonical application-neutral Policy/v3 addressed publisher shared by browser and CLI. */
export async function publishAddressedShare(input: AddressedSharePublishOptions): Promise<PublishedShare> {
  assertSafeInput(input);
  const { target } = prepareAddressedShare(input);
  // Refuse a share whose pin and source disagree (or an artifact source with no pin) before anything is registered.
  assertArtifactBinding({
    ...(input.artifactPin === undefined ? {} : { artifactPin: input.artifactPin }),
    target: { spaceId: input.spaceId },
    contentSource: input.contentSource,
    resource: input.resource,
    actions: input.actions,
    policyKvActions: input.policyActions,
  });
  // Envelope, result metadata and history all carry the viewer's NFC form.
  const options = { ...input, filename: canonicalShareFilename(input.filename) };
  if (target.kind !== "recipientDid") assertMailboxCommitment(options.credentialRequirement, target);
  const matcher = targetMatcher(target);
  const { expiry, capabilities, contentSourceDigestHex, capabilityCeilingHashHex, nativeProjectionHashHex } = addressedPlan(options);
  // The policy registration below is the first write. A share whose sealed envelope cannot fit in a link is refused before it.
  await assertSealedBodyFits({ ...options, matcher, ownerDid: options.authority.ownerDid });
  const created = await createPolicy(options, capabilities);
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
  const unsigned = unsignedAddressedEnvelope({
    options, matcher, policy: created.policy, policyCid: created.policyCid, policyRoot, enforcementRoot,
    attestedEnforcerBinding: registration.attestedEnforcerBinding, contentSourceDigestHex, expiry,
  });
  unsignedShareEnvelopeV3Schema.parse(unsigned);
  const envelopeSignature = await options.authority.sign(sha256(textEncoder.encode(`${ENVELOPE_V3_DOMAIN}${canonicalize(unsigned)}`)));
  if (envelopeSignature.byteLength !== 64) throw new TypeError("v3 envelope signature must be Ed25519");
  const envelope = signedAddressedEnvelope(unsigned, options.authority.ownerDid, envelopeSignature);
  shareEnvelopeV3Schema.parse(envelope);
  const envelopeBytes = textEncoder.encode(canonicalize(envelope));
  // The recipient envelope carries email and policy metadata.  Seal it before
  // assigning its CID or constructing a URL: neither metadata nor the key
  // may occur in a query parameter or any other loggable URL component.
  const envelopeKeyBytes = generateKey();
  const sealed = await seal(envelopeBytes, envelopeKeyBytes);
  const envelopeKey = toBase64Url(envelopeKeyBytes);
  // The real check, on the sealed body itself, before any link is built or the header is signed. The caller removes what the
  // registration above wrote (see `AddressedShareOverLimitError`).
  if (sealed.blob.length > await linkBodyLimit()) {
    throw new AddressedShareOverLimitError({ policyCid: created.policyCid, policyRootCid: policyRoot.cid, enforcementRootCid: enforcementRoot.cid });
  }
  // The link this publisher returns is the full `v=4` link: the signed record rides in the fragment, so it works
  // with no service. The header is signed by the key that signs the envelope (the envelope's signer is the issuer
  // every reader binds the record to). A caller that wants a short link posts `deliveryMaterial` with `createLink`.
  const links = await import("@tinycloud/share-envelope/links");
  const { record } = await links.prepareLinkRecord({
    type: "share",
    sealed: { blob: sealed.blob, key: envelopeKeyBytes },
    issuerKey: { did: options.authority.ownerDid, sign: (digest) => options.authority.sign(digest) },
    apiOrigin: options.apiOrigin ?? links.DEFAULT_LINKS_API_ORIGIN,
    expiresAt: new Date(expiry),
    enforceServiceLife: false,
  });
  const url = links.buildFullLink({ origin: options.shareOrigin, key: envelopeKeyBytes, record });
  const deliveryMaterial = {
    envelope,
    shareCid: sealed.cid,
    sealedEnvelope: toBase64Url(sealed.blob),
    envelopeKey,
  };
  options.onDeliveryMaterial?.(deliveryMaterial);
  return publicationResult({
    options, url, envelopeCid: sealed.cid, matcher, policyCid: created.policyCid,
    policyRootCid: policyRoot.cid, enforcementRootCid: enforcementRoot.cid,
    enforcerDid: registration.attestedEnforcerBinding.enforcerDid,
    expiry, deliveryMaterial,
  });
}

/** The text a share gets when its sealed envelope cannot fit in a link. */
export const ADDRESSED_SHARE_TOO_LARGE_MESSAGE = "This share is too large to send as a link, so nothing was shared. Use a shorter path or fewer folders.";

/** What a publish has written by the time its sealed envelope is measured. */
export interface AddressedShareWrites {
  readonly policyCid: string;
  readonly policyRootCid: string;
  readonly enforcementRootCid: string;
}

/**
 * Thrown by `publishAddressedShare` when the sealed envelope, measured after
 * the policy registration, is over `MAX_LINK_BODY_BYTES`. The size bound makes
 * this unreachable for a correct caller; if it happens, `written` names what
 * the publish registered so the caller can remove it. No link was built.
 */
export class AddressedShareOverLimitError extends SharePublishError {
  constructor(readonly written: AddressedShareWrites) {
    super("max-bytes-exceeded", ADDRESSED_SHARE_TOO_LARGE_MESSAGE);
    this.name = "AddressedShareOverLimitError";
  }
}

/** The links module loads on demand, so the limit is read from it when a check runs. */
async function linkBodyLimit(): Promise<number> {
  return (await import("@tinycloud/share-envelope/links")).MAX_LINK_BODY_BYTES;
}

/** Longest string an authority returns as the CID of an owner root. A blake3 CIDv1 is 59 characters; the bound leaves room for any multibase CID. */
const ROOT_CID_BOUND_CHARS = 128;
/** Longest RFC 3339 timestamp a node may return: nine fractional digits and a numeric offset. */
const NODE_TIMESTAMP_BOUND = "2026-01-01T00:00:00.123456789+00:00";
/** An Ed25519 DID key is 56 characters. */
const ED25519_DID_KEY_CHARS = 56;

/**
 * The compact-UCAN owner root as the authority signs it (sdk-core
 * `signCompactUcanRootAuthorization`), with every value the signing writes at
 * its widest: 16-digit times, a 36-character nonce (a UUID; the node SDK uses 22), a 64-byte signature.
 */
function rootAuthorizationBound(input: {
  readonly ownerDid: string;
  readonly role: UnifiedRoot["role"];
  readonly audienceDid: string;
  readonly policyId: string;
  readonly policyDigestHex: string;
  readonly policyCid: string;
  readonly contentSourceDigestHex: string;
  readonly capabilityCeilingHashHex: string;
  readonly nativeProjectionHashHex: string;
  readonly nodeAudience: string;
  readonly capabilities: readonly UnifiedPolicyCapability[];
}): string {
  const attenuation: Record<string, unknown> = {};
  for (const capability of input.capabilities) {
    attenuation[capability.resource] = capability.kind === "encryption"
      ? { [capability.action]: [{}] }
      : Object.fromEntries(capability.actions.map((action) => [action, [{ type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: capability.resource }]]));
  }
  const facts = {
    role: input.role,
    mode: input.role === "policy-authority" ? "policy-source" : "conditional-mint",
    ownerDid: input.ownerDid,
    policyId: input.policyId,
    policyDigestHex: input.policyDigestHex,
    policyCid: input.policyCid,
    contentSourceDigestHex: input.contentSourceDigestHex,
    capabilityCeilingHashHex: input.capabilityCeilingHashHex,
    nativeProjectionHashHex: input.nativeProjectionHashHex,
    nodeAudience: input.nodeAudience,
    ...(input.role === "policy-enforcement" ? { enforcerDid: input.audienceDid } : {}),
  };
  const header = { alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: "A".repeat(43) }, typ: "JWT", ucv: "0.10.0" };
  const payload = {
    att: attenuation,
    aud: input.audienceDid,
    exp: Number.MAX_SAFE_INTEGER,
    fct: [facts],
    iss: `${input.ownerDid}#${input.ownerDid.slice("did:key:".length)}`,
    nbf: Number.MAX_SAFE_INTEGER,
    nnc: "A".repeat(36),
    prf: [] as string[],
  };
  return `${toBase64Url(textEncoder.encode(canonicalize(header)))}.${toBase64Url(textEncoder.encode(canonicalize(payload)))}.${"A".repeat(86)}`;
}

type BoundOptions = EnvelopeInputs
  & Pick<AddressedSharePublishOptions, "nodeAudience" | "enforcerDid" | "policyActions" | "credentialRequirement" | "expiresAt">
  & { readonly matcher: OwnerShareMatcher; readonly ownerDid: string };

/**
 * An upper bound on the sealed envelope of an addressed share, in bytes. It
 * builds the envelope through the same serializer as the publish, from the
 * share's own inputs, with every value a write returns at its maximum encoded
 * length: the root and registration identifiers, the root authorizations
 * (times, nonce, signature), the enforcer's attestation, and all signatures.
 * It seals that envelope with a throwaway key.
 */
async function sealedBodyUpperBound(options: BoundOptions): Promise<number> {
  const plan = addressedPlan(options);
  const signature = new Uint8Array(64);
  const created = await createPolicy({ ...options, authority: { ownerDid: options.ownerDid, sign: async () => signature } }, plan.capabilities);
  const common = {
    ownerDid: options.ownerDid, policyId: created.policy.policyId, policyDigestHex: created.policyDigestHex, policyCid: created.policyCid,
    contentSourceDigestHex: plan.contentSourceDigestHex, capabilityCeilingHashHex: plan.capabilityCeilingHashHex,
    nativeProjectionHashHex: plan.nativeProjectionHashHex, nodeAudience: options.nodeAudience, capabilities: plan.capabilities,
  };
  const policyRoot: UnifiedRoot = {
    cid: "b".repeat(ROOT_CID_BOUND_CHARS), role: "policy-authority",
    authorization: rootAuthorizationBound({ ...common, role: "policy-authority", audienceDid: `did:tinycloud:policy:${created.policyDigestHex}` }),
  };
  const enforcementRoot: UnifiedRoot = {
    cid: "b".repeat(ROOT_CID_BOUND_CHARS), role: "policy-enforcement",
    authorization: rootAuthorizationBound({ ...common, role: "policy-enforcement", audienceDid: options.enforcerDid }),
  };
  const nodeDid = options.enforcerDid.padEnd(ED25519_DID_KEY_CHARS, "z");
  const unsigned = unsignedAddressedEnvelope({
    options, matcher: options.matcher, policy: created.policy, policyCid: created.policyCid, policyRoot, enforcementRoot,
    attestedEnforcerBinding: {
      schema: "xyz.tinycloud.policy/attested-enforcer/v2", enforcerDid: nodeDid, nodeAudience: nodeDid,
      attestationBindingDigestHex: "f".repeat(64), issuedAt: NODE_TIMESTAMP_BOUND, expiresAt: NODE_TIMESTAMP_BOUND,
      signature: { suite: "Ed25519", signerDid: nodeDid, value: "A".repeat(86) },
    },
    contentSourceDigestHex: plan.contentSourceDigestHex, expiry: plan.expiry,
  });
  const envelope = signedAddressedEnvelope(unsigned, options.ownerDid, signature);
  return (await seal(textEncoder.encode(canonicalize(envelope)), generateKey())).blob.length;
}

async function assertSealedBodyFits(options: BoundOptions): Promise<void> {
  if (await sealedBodyUpperBound(options) > await linkBodyLimit()) throw new SharePublishError("max-bytes-exceeded", ADDRESSED_SHARE_TOO_LARGE_MESSAGE);
}

/** What a sender knows before any write; see {@link addressedShareBodyUpperBound}. */
export interface AddressedShareBoundInput extends AddressedShareRequest {
  readonly shareId: string;
  readonly ownerDid: string;
  readonly nodeOrigin: string;
  readonly nodeAudience: string;
  readonly enforcerDid: string;
  readonly spaceId: string;
  readonly resource: { readonly kind: "exact" | "prefix" };
  /** Where the content will be stored: a path, or the id and stored file name of an artifact (whose version number the publish assigns). */
  readonly storage: { readonly path: string } | { readonly artifactId: string; readonly storageName: string };
  /** The owner's encryption network for the space. */
  readonly encryptionNetwork: string;
  readonly encryptionKeyPath?: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly artifact?: "html";
  readonly expiresAt: Date;
}

/**
 * The largest sealed envelope a share can have, in bytes, computed before any
 * write (upload, registration, registry or KV write): the same envelope the
 * publish builds, with every value a write returns at its maximum encoded
 * length (see `sealedBodyUpperBound`). Compare it with `MAX_LINK_BODY_BYTES`.
 * For an artifact share the version, the manifest digest and the stored size
 * are taken at their largest.
 */
export async function addressedShareBodyUpperBound(input: AddressedShareBoundInput): Promise<number> {
  // The requirement and the delivery address are derived exactly as the publish derives them, so the bound carries
  // every field the sealed envelope can: a caller cannot leave one out, and a mailbox target always has its commitment.
  const { target, credentialRequirement } = prepareAddressedShare(input);
  const deliveryEmail = input.deliveryEmail ?? (target.kind === "email" && isEnvelopeDeliveryEmail(target.address) ? target.address : undefined);
  const artifactStorage = "artifactId" in input.storage ? input.storage : undefined;
  const path = "path" in input.storage
    ? input.storage.path
    : `${ARTIFACT_ROOT}/${input.storage.artifactId}/versions/${Number.MAX_SAFE_INTEGER}/${input.storage.storageName}`;
  const contentSource: UnifiedContentSource = {
    shareId: input.shareId, kvResource: `${input.spaceId}/kv/${path}`, selector: input.resource.kind, encryptionNetwork: input.encryptionNetwork,
    ...(input.encryptionKeyPath === undefined ? {} : { encryptionKeyPath: input.encryptionKeyPath }),
    encryptedSymmetricKeyDigestHex: "f".repeat(64), keyVersion: Number.MAX_SAFE_INTEGER, mode: "immutable", initialCiphertextDigestHex: "f".repeat(64),
  };
  const artifactPin: ArtifactPin | undefined = artifactStorage === undefined ? undefined : {
    v: 1, artifactId: artifactStorage.artifactId, version: Number.MAX_SAFE_INTEGER, manifestSha256: "f".repeat(64),
    files: [{ path: artifactStorage.storageName, sha256: "f".repeat(64), bytes: Number.MAX_SAFE_INTEGER }],
  };
  return sealedBodyUpperBound({
    shareId: input.shareId, nodeOrigin: input.nodeOrigin, nodeAudience: input.nodeAudience, enforcerDid: input.enforcerDid, spaceId: input.spaceId,
    actions: input.actions, policyActions: input.policyActions, resource: { kind: input.resource.kind, path },
    contentSource, ...(artifactPin === undefined ? {} : { artifactPin }),
    ...(credentialRequirement === undefined ? {} : { credentialRequirement }),
    ...(deliveryEmail === undefined ? {} : { deliveryEmail }),
    ...(input.artifact === undefined ? {} : { artifact: input.artifact }),
    filename: canonicalShareFilename(input.filename), mediaType: input.mediaType, byteLength: input.byteLength, expiresAt: input.expiresAt,
    matcher: targetMatcher(target), ownerDid: input.ownerDid,
  });
}

/** Refuses (`SharePublishError`, code `max-bytes-exceeded`, {@link ADDRESSED_SHARE_TOO_LARGE_MESSAGE}) a share whose largest sealed envelope is over `MAX_LINK_BODY_BYTES`. Call it before any write. */
export async function assertAddressedShareFits(input: AddressedShareBoundInput): Promise<void> {
  if (await addressedShareBodyUpperBound(input) > await linkBodyLimit()) throw new SharePublishError("max-bytes-exceeded", ADDRESSED_SHARE_TOO_LARGE_MESSAGE);
}
