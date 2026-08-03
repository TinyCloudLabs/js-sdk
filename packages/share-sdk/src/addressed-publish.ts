import {
  canonicalize,
  computeCid,
  encodeInlineShareUrl,
  encodeShareUrl,
  fromBase64Url,
  generateKey,
  seal,
  shareEnvelopeV2Schema,
  toBase64Url,
  unsignedShareEnvelopeV2Schema,
  type ContentSource,
  type ShareAction,
} from "@tinycloud/share-envelope";
import {
  canonicalOwnerSharePolicy,
  createDelegatedShareKey,
  createPolicyEnforcementDelegation,
  type CreateOwnerDelegationParams,
  type OwnerDelegationReceipt,
  type OwnerShareAction,
  type OwnerShareDecryption,
  type OwnerShareMatcher,
  type OwnerSharePolicyRegistrationReceipt,
  type RegisterOwnerSharePolicyParams,
} from "./owner-policy.js";
import {
  SHARE_CONTENT_LIMIT,
  SHARE_PUBLISH_RESULT_VERSION,
  redactPublishedShare,
  uploadShareBlob,
  type PublishedShare,
  type SharePublishOptions,
} from "./publish.js";
import { normalizeShareTarget, type ShareTarget } from "./targets.js";

const ENVELOPE_DOMAIN = "xyz.tinycloud.share/envelope/v2\0";

export interface AddressedPublishAuthority {
  readonly ownerDid: string;
  createOwnerDelegation(input: CreateOwnerDelegationParams): Promise<OwnerDelegationReceipt>;
  registerOwnerSharePolicy(input: RegisterOwnerSharePolicyParams): Promise<OwnerSharePolicyRegistrationReceipt>;
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
  readonly contentSource: ContentSource;
  readonly contentSourceDigest?: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly artifact?: "html";
  readonly deliveryEmail?: string;
  readonly expiresAt: Date;
  readonly decryption?: OwnerShareDecryption;
  readonly inline?: boolean;
  readonly authority: AddressedPublishAuthority;
  readonly upload: Pick<SharePublishOptions, "registryBaseUrl" | "fetchFn" | "authorizeUpload" | "authorizationOrigin" | "credentials" | "allowInsecureRegistry" | "uploadBlob">;
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
  const expiry = input.expiresAt.getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new TypeError("addressed share expiry must be in the future");
  if (input.artifact === "html" && (input.resource.kind !== "prefix" || !input.actions.includes("read") || !input.actions.includes("list"))) throw new TypeError("html artifacts require a readable prefix");
  if (input.contentSource.kind !== "kv") throw new TypeError("addressed policy publication requires a KV content source");
}

async function sha256(value: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

function publicationResult(input: {
  readonly options: AddressedSharePublishOptions;
  readonly url: string;
  readonly envelopeCid: string;
  readonly shareCid: string;
  readonly matcher: OwnerShareMatcher;
  readonly registration: OwnerSharePolicyRegistrationReceipt["registration"];
  readonly policyCid: string;
  readonly enforcementDelegationCid: string;
  readonly shareKeyDid: string;
  readonly retention: string;
}): PublishedShare {
  const result = {
    protocol: "tinycloud-share",
    version: SHARE_PUBLISH_RESULT_VERSION,
    url: input.url,
    link: { kind: input.options.inline === true ? "inline" as const : "compact" as const, cid: input.envelopeCid },
    metadata: {
      protocol: "tinycloud-share" as const,
      version: 1 as const,
      shareId: input.options.shareId,
      origin: input.options.shareOrigin,
      target: {
        kind: targetKind(input.options.target),
        origin: input.options.nodeOrigin,
        nodeAudience: input.options.nodeAudience,
        spaceId: input.options.spaceId,
      },
      resource: { ...input.options.resource },
      actions: [...input.options.actions],
      expiresAt: input.options.expiresAt.toISOString(),
      display: { filename: input.options.filename },
      recipientMatcher: { ...input.matcher },
      registrationCid: input.registration.registrationCid,
      policyCid: input.policyCid,
      ownerDelegationCid: input.registration.ownerDelegationCid,
      enforcementDelegationCid: input.enforcementDelegationCid,
      ownerDid: input.registration.ownerDid,
      shareKeyDid: input.shareKeyDid,
      enforcerDid: input.registration.enforcerDid,
      envelopeCid: input.envelopeCid,
      shareCid: input.shareCid,
    },
    registryDeleteAfter: input.retention,
  } satisfies PublishedShare;
  Object.defineProperty(result, "toJSON", { enumerable: false, value: () => redactPublishedShare(result) });
  Object.defineProperty(result, "url", { enumerable: false, value: input.url });
  return result;
}

/**
 * Canonical addressed publisher shared by browser and CLI.
 *
 * Callers own authenticated KV writes and transport. This function alone owns
 * the policy, delegation, outer-authority, signed-envelope, encryption, and
 * link bytes.
 */
export async function publishAddressedShare(options: AddressedSharePublishOptions): Promise<PublishedShare> {
  assertSafeInput(options);
  const target = normalizeShareTarget(options.target);
  if (target.kind === "bearer") throw new TypeError("addressed target is required");
  if (options.contentSource.kind !== "kv") throw new TypeError("addressed policy publication requires a KV content source");
  const contentSource = options.contentSource;
  const matcher = targetMatcher(target);
  const expiresAt = options.expiresAt.toISOString();
  const contentSourceDigest = options.contentSourceDigest ?? await sha256(new TextEncoder().encode(canonicalize(contentSource)));
  const shareKey = await createDelegatedShareKey({ extractable: false });
  let envelopeKey: Uint8Array | undefined;
  try {
    const permissions = [
      {
        service: "tinycloud.kv",
        path: options.resource.kind === "prefix" ? `${options.resource.path.replace(/\/+$/, "")}/` : options.resource.path,
        actions: [...options.policyActions],
      },
      ...(options.decryption === undefined ? [] : [{
        service: "tinycloud.encryption",
        path: options.decryption.networkId,
        actions: [options.decryption.action],
      }]),
    ];
    const ownerDelegation = await options.authority.createOwnerDelegation({
      delegateDid: shareKey.did,
      spaceId: options.spaceId,
      permissions,
      expiresAt: options.expiresAt,
    });
    const policy = {
      type: "TinyCloudSharePolicy" as const,
      version: 2 as const,
      shareId: options.shareId,
      ownerDid: options.authority.ownerDid,
      shareKeyDid: shareKey.did,
      recipientMatcher: matcher,
      target: {
        origin: options.nodeOrigin,
        nodeAudience: options.nodeAudience,
        enforcerDid: options.enforcerDid,
        spaceId: options.spaceId,
      },
      resource: { ...options.resource },
      actions: [...options.policyActions],
      ...(options.decryption === undefined ? {} : { decryption: options.decryption }),
      contentSource,
      contentSourceDigest,
      ownerDelegationCid: ownerDelegation.delegationCid,
      expiresAt,
    };
    const canonicalPolicy = await canonicalOwnerSharePolicy(policy);
    const policyProof = toBase64Url(await shareKey.sign(canonicalPolicy.bytes));
    const enforcementDelegation = await createPolicyEnforcementDelegation({
      ownerDelegation,
      shareKey,
      enforcerDid: options.enforcerDid,
      policyCid: canonicalPolicy.cid,
      shareId: options.shareId,
      spaceId: options.spaceId,
      nodeAudience: options.nodeAudience,
      path: options.resource.path,
      actions: options.policyActions,
      contentSourceDigest,
      expiresAt,
    });
    const registration = await options.authority.registerOwnerSharePolicy({
      policy: { bytes: canonicalPolicy.bytes, cid: canonicalPolicy.cid, proof: policyProof },
      ownerDelegation,
      enforcementDelegation,
      contentSourceDigest,
    });
    const authorityMaterialDigest = await sha256(fromBase64Url(enforcementDelegation.dagCbor));
    const authorityTarget = {
      origin: options.nodeOrigin,
      nodeAudience: options.nodeAudience,
      enforcerDid: options.enforcerDid,
      spaceId: options.spaceId,
    };
    const envelopeIdentity = {
      schema: "xyz.tinycloud.share/envelope/v2",
      version: 2,
      shareId: options.shareId,
      delegationCid: ownerDelegation.delegationCid,
      policyCid: canonicalPolicy.cid,
      target: authorityTarget,
      resource: options.resource,
      actions: options.policyActions,
      ...(options.decryption === undefined ? {} : { decryption: options.decryption }),
      contentSource,
      contentSourceDigest,
      expiresAt,
    };
    const envelopeCid = await computeCid(new TextEncoder().encode(canonicalize(envelopeIdentity)));
    const shareCid = await computeCid(new TextEncoder().encode(canonicalize({ version: 2, shareId: options.shareId, policyCid: canonicalPolicy.cid, envelopeCid })));
    const outerUnsigned = { ...envelopeIdentity, envelopeCid, shareCid };
    const outerSignature = toBase64Url(await shareKey.sign(new TextEncoder().encode(`${ENVELOPE_DOMAIN}${canonicalize(outerUnsigned)}`)));
    const unsigned = {
      version: 2 as const,
      shareId: options.shareId,
      recipientMatcher: matcher,
      ...(options.deliveryEmail === undefined ? {} : { deliveryEmail: options.deliveryEmail }),
      actions: [...options.actions],
      resource: { ...options.resource },
      target: { origin: options.nodeOrigin, nodeAudience: options.nodeAudience, spaceId: options.spaceId },
      delegationCid: ownerDelegation.delegationCid,
      authorityMaterialHandle: registration.registration.registrationCid,
      authorityMaterialDigest,
      contentSource,
      contentSourceDigest,
      authorizationTarget: { kind: "policy" as const, policyCid: canonicalPolicy.cid, policyBytes: toBase64Url(canonicalPolicy.bytes) },
      display: { filename: options.filename },
      expiry: expiresAt,
      encrypted: true,
      metadata: {
        mediaType: options.mediaType,
        byteLength: options.byteLength,
        filename: options.filename,
        ...(options.mediaType.startsWith("text/") ? { encoding: "utf-8" as const } : {}),
        ...(options.artifact === undefined ? {} : { artifact: options.artifact }),
      },
      ownerAuthority: {
        registrationCid: registration.registration.registrationCid,
        shareCid,
        envelopeCid,
        enforcementDelegation,
        registrationReceipt: registration,
        outerEnvelope: {
          ...outerUnsigned,
          signature: { signerDid: shareKey.did, algorithm: "Ed25519" as const, value: outerSignature },
        },
      },
    };
    unsignedShareEnvelopeV2Schema.parse(unsigned);
    const envelopeSignature = toBase64Url(await shareKey.sign(new TextEncoder().encode(`${ENVELOPE_DOMAIN}${canonicalize(unsigned)}`)));
    const envelope = { ...unsigned, signature: { signerDid: shareKey.did, algorithm: "Ed25519" as const, value: envelopeSignature } };
    shareEnvelopeV2Schema.parse(envelope);
    envelopeKey = generateKey();
    const sealed = await seal(new TextEncoder().encode(canonicalize(envelope)), envelopeKey);
    let url: string;
    let retention = expiresAt;
    if (options.inline === true) {
      url = await encodeInlineShareUrl({ origin: options.shareOrigin, ciphertext: sealed.blob, key32: envelopeKey });
    } else {
      const uploaded = await uploadShareBlob({
        source: new Uint8Array([1]),
        filename: options.filename,
        origin: options.shareOrigin,
        ...options.upload,
      }, { blob: sealed.blob, cid: sealed.cid, deleteAfter: expiresAt, contentLength: sealed.blob.byteLength });
      retention = uploaded.deleteAfter;
      url = encodeShareUrl({ origin: options.shareOrigin, ciphertextCid: uploaded.cid, key32: envelopeKey });
    }
    return publicationResult({
      options,
      url,
      envelopeCid: sealed.cid,
      shareCid,
      matcher,
      registration: registration.registration,
      policyCid: canonicalPolicy.cid,
      enforcementDelegationCid: enforcementDelegation.cid,
      shareKeyDid: shareKey.did,
      retention,
    });
  } finally {
    shareKey.clear();
    envelopeKey?.fill(0);
  }
}
