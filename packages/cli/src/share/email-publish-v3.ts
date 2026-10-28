import { createHash } from "node:crypto";
import {
  canonicalDigest,
  contentSourceDigestHex,
  createEmailCredentialRequirement,
  credentialRequirementDigest,
  policyCidFromCanonicalBytes,
  policyIdForDigestHex,
  policyV2DigestHex,
  POLICY_CAPABILITY_V1_DOMAIN,
  unifiedNativeProjectionHashHex,
  validateCredentialFlowDescriptor,
  type UnifiedPolicyCapability,
  type UnsignedUnifiedPolicyV2,
} from "@tinycloud/sdk-core";
import {
  canonicalize,
  encodeInlineShareUrl,
  encodeShareUrl,
  generateKey,
  seal,
  shareEnvelopeV3Schema,
  toBase64Url,
  unsignedShareEnvelopeV3Schema,
} from "@tinycloud/share-envelope";
import { SHARE_PUBLISH_RESULT_VERSION, uploadShareBlob, type PublishedShare, type SharePublishOptions } from "@tinycloud/share-sdk";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const text = (value: unknown) => new TextEncoder().encode(canonicalize(value));
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = (value: Uint8Array) => hex(sha256(value));
const timestamp = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
const capabilityDigest = (capabilities: readonly UnifiedPolicyCapability[]) => digest(new TextEncoder().encode(
  `${POLICY_CAPABILITY_V1_DOMAIN}${canonicalize([...capabilities].sort((a, b) => canonicalize(a).localeCompare(canonicalize(b))))}`,
));

export interface EmailPublishV3Input {
  readonly shareId: string;
  readonly ownerDid: string;
  readonly shareOrigin: string;
  readonly nodeOrigin: string;
  readonly enforcerDid: string;
  readonly spaceId: string;
  readonly address: string;
  readonly resourcePath: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly actions: readonly ("read" | "list" | "edit")[];
  readonly expiresAt: Date;
  readonly inline?: boolean;
  readonly credentialDescriptor: unknown;
  readonly issuerDid: string;
  readonly issuerKid: string;
  readonly encryptionNetwork: string;
  readonly encryptionKeyPath: string;
  readonly encryptedSymmetricKeyHash: string;
  readonly keyVersion: number;
  readonly storedBytes: Uint8Array;
  readonly createOwnerRoot: (input: {
    ownerDid: string; role: "policy-authority" | "policy-enforcement"; audienceDid: string;
    policyId: string; policyDigestHex: string; policyCid: string; contentSourceDigestHex: string;
    capabilityCeilingHashHex: string; nativeProjectionHashHex: string; notBefore: Date; expiresAt: Date;
    nodeAudience: string; capabilities: readonly UnifiedPolicyCapability[];
  }) => Promise<{ cid: string; delegationHeader: { Authorization: string } }>;
  readonly issueBinding: (expiresAt: string) => Promise<unknown>;
  readonly registerPolicy: (input: Record<string, unknown>) => Promise<unknown>;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
  readonly onDeliveryMaterial?: (material: { readonly envelope: Record<string, unknown>; readonly sealedEnvelope: string; readonly envelopeKey: string; readonly shareCid: string }) => void;
  readonly upload: Pick<SharePublishOptions, "registryBaseUrl" | "fetchFn" | "authorizeUpload" | "authorizationOrigin" | "credentials" | "allowInsecureRegistry" | "uploadBlob">;
}

/** Publish an exact email share with a dedicated encrypted leaf and Policy/v2. */
export async function publishEmailShareV3(input: EmailPublishV3Input): Promise<PublishedShare> {
  if (!/^urn:tinycloud:encryption:did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}:default$/.test(input.encryptionNetwork) || input.encryptionKeyPath !== `share/${input.shareId}` || input.actions.length === 0 || input.expiresAt.getTime() <= Date.now()) throw new TypeError("email share binding is invalid");
  const descriptor = validateCredentialFlowDescriptor(input.credentialDescriptor);
  if (descriptor.issuer.did !== input.issuerDid || descriptor.issuer.kid !== input.issuerKid || !descriptor.claims.some((claim) => claim.name === "email" && claim.matching === "normalized_exact")) throw new TypeError("email credential issuer or claim is invalid");
  const profile = { id: descriptor.profile, version: 1 as const };
  const credentialType = { id: descriptor.format.vct, version: 1 as const };
  const requirement = createEmailCredentialRequirement({ email: input.address, profile, credentialType });
  const credentialRequirement = {
    type: "TinyCloudPolicyCredentialRequirement" as const, version: 1 as const,
    requirementDigest: await credentialRequirementDigest(requirement),
    descriptorDigest: await canonicalDigest(descriptor),
    issuerDid: input.issuerDid, issuerKid: input.issuerKid, profile, credentialType,
  };
  const contentSource = {
    shareId: input.shareId, kvResource: `${input.spaceId}/kv/${input.resourcePath}`, selector: "exact" as const,
    encryptionNetwork: input.encryptionNetwork, encryptionKeyPath: input.encryptionKeyPath,
    encryptedSymmetricKeyDigestHex: input.encryptedSymmetricKeyHash, keyVersion: input.keyVersion,
    mode: "immutable" as const, initialCiphertextDigestHex: digest(input.storedBytes),
  };
  const policyActions = [...new Set(input.actions.flatMap((action) => action === "read" ? ["tinycloud.kv/get", "tinycloud.kv/metadata"] : action === "list" ? ["tinycloud.kv/list"] : ["tinycloud.kv/put"]))].sort() as ("tinycloud.kv/get" | "tinycloud.kv/list" | "tinycloud.kv/metadata" | "tinycloud.kv/put")[];
  const capabilities: UnifiedPolicyCapability[] = [
    { kind: "kv", resource: contentSource.kvResource, selector: "exact", actions: policyActions },
    { kind: "encryption", resource: `${input.encryptionNetwork}/${input.encryptionKeyPath}`, action: "tinycloud.encryption/decrypt" },
  ];
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const expiresAt = timestamp(input.expiresAt);
  const unsignedPolicy: UnsignedUnifiedPolicyV2 = {
    schema: "xyz.tinycloud.policy/policy/v2", ownerDid: input.ownerDid, createdAt: timestamp(now), expiresAt,
    contentSource, capabilityCeiling: capabilities, credentialRequirement,
  };
  const policyDigest = policyV2DigestHex(unsignedPolicy);
  const policyId = policyIdForDigestHex(policyDigest);
  const policy = {
    ...unsignedPolicy, policyId,
    signature: { suite: "Ed25519" as const, signerDid: input.ownerDid, value: toBase64Url(await input.sign(Uint8Array.from(policyDigest.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))))) },
  };
  const policyCid = policyCidFromCanonicalBytes(text(policy));
  const contentSourceDigest = contentSourceDigestHex(contentSource);
  const capabilityCeilingHashHex = capabilityDigest(capabilities);
  const nativeProjectionHashHex = unifiedNativeProjectionHashHex(capabilities);
  const binding = await input.issueBinding(expiresAt);
  const bindingRecord = binding as { enforcerDid?: unknown; nodeAudience?: unknown };
  if (bindingRecord?.enforcerDid !== input.enforcerDid || typeof bindingRecord.nodeAudience !== "string" || !bindingRecord.nodeAudience.startsWith("did:key:")) throw new Error("attested enforcer binding mismatch");
  const rootInput = { ownerDid: input.ownerDid, policyId, policyDigestHex: policyDigest, policyCid, contentSourceDigestHex: contentSourceDigest, capabilityCeilingHashHex, nativeProjectionHashHex, notBefore: now, expiresAt: new Date(expiresAt), nodeAudience: bindingRecord.nodeAudience, capabilities };
  const policyRoot = await input.createOwnerRoot({ ...rootInput, role: "policy-authority", audienceDid: `did:tinycloud:policy:${policyDigest}` });
  const enforcementRoot = await input.createOwnerRoot({ ...rootInput, role: "policy-enforcement", audienceDid: input.enforcerDid });
  const registered = await input.registerPolicy({ policyCid, policy, policyRoot: policyRoot.delegationHeader.Authorization, enforcementRoot: enforcementRoot.delegationHeader.Authorization, contentSourceDigestHex: contentSourceDigest, nativeProjectionHashHex, attestedEnforcerBinding: binding });
  const receipt = registered as { policyCid?: unknown; policyRootCid?: unknown; enforcementRootCid?: unknown };
  if (receipt?.policyCid !== policyCid || receipt.policyRootCid !== policyRoot.cid || receipt.enforcementRootCid !== enforcementRoot.cid) throw new Error("policy registration receipt mismatch");
  const unsigned = unsignedShareEnvelopeV3Schema.parse({
    version: 3, shareId: input.shareId, recipientMatcher: { kind: "exactEmail", value: input.address }, deliveryEmail: input.address,
    actions: ["read", "list", "edit"].filter((action) => input.actions.includes(action as "read" | "list" | "edit")),
    resource: { kind: "exact", path: input.resourcePath },
    target: { origin: input.nodeOrigin, nodeAudience: input.enforcerDid, spaceId: input.spaceId },
    policy, policyCid,
    policyRoot: { cid: policyRoot.cid, authorization: policyRoot.delegationHeader.Authorization, role: "policy-authority" },
    enforcementRoot: { cid: enforcementRoot.cid, authorization: enforcementRoot.delegationHeader.Authorization, role: "policy-enforcement" },
    attestedEnforcerBinding: binding, contentSource, contentSourceDigestHex: contentSourceDigest,
    encryptionNetwork: input.encryptionNetwork, expiry: expiresAt, display: { filename: input.filename }, encrypted: true,
    metadata: { mediaType: input.mediaType, byteLength: input.byteLength, filename: input.filename, ...(input.mediaType.startsWith("text/") ? { encoding: "utf-8" } : {}) },
  });
  const signatureBytes = sha256(new TextEncoder().encode(`xyz.tinycloud.share/envelope/v3\0${canonicalize(unsigned)}`));
  const envelope = shareEnvelopeV3Schema.parse({ ...unsigned, signature: { signerDid: input.ownerDid, algorithm: "Ed25519", value: toBase64Url(await input.sign(signatureBytes)) } });
  const envelopeKey = generateKey();
  try {
    const sealed = await seal(text(envelope), envelopeKey);
    const uploaded = input.inline === true ? undefined : await uploadShareBlob({ source: new Uint8Array([1]), filename: input.filename, origin: input.shareOrigin, ...input.upload }, { blob: sealed.blob, cid: sealed.cid, deleteAfter: expiresAt, contentLength: sealed.blob.byteLength });
    const url = input.inline === true
      ? await encodeInlineShareUrl({ origin: input.shareOrigin, ciphertext: sealed.blob, key32: envelopeKey })
      : encodeShareUrl({ origin: input.shareOrigin, ciphertextCid: uploaded!.cid, key32: envelopeKey });
    input.onDeliveryMaterial?.({ envelope, sealedEnvelope: toBase64Url(sealed.blob), envelopeKey: toBase64Url(envelopeKey), shareCid: sealed.cid });
    const result: PublishedShare = {
      protocol: "tinycloud-share", version: SHARE_PUBLISH_RESULT_VERSION, url,
      link: { kind: input.inline === true ? "inline" : "compact", cid: sealed.cid },
      metadata: {
        protocol: "tinycloud-share", version: 1, shareId: input.shareId, origin: input.shareOrigin,
        target: { kind: "email", origin: input.nodeOrigin, nodeAudience: input.enforcerDid, spaceId: input.spaceId },
        resource: { kind: "exact", path: input.resourcePath }, actions: [...input.actions], expiresAt,
        display: { filename: input.filename }, recipientMatcher: { kind: "exactEmail", value: input.address },
        policyCid, ownerDelegationCid: policyRoot.cid, enforcementDelegationCid: enforcementRoot.cid,
        ownerDid: input.ownerDid, enforcerDid: input.enforcerDid, envelopeCid: sealed.cid, shareCid: sealed.cid, envelopeVersion: 3,
      },
      registryDeleteAfter: uploaded?.deleteAfter ?? expiresAt,
    };
    Object.defineProperty(result, "url", { enumerable: false, value: url });
    return result;
  } finally { envelopeKey.fill(0); }
}
